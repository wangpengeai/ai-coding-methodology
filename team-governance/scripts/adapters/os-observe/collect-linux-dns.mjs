// 文件：collect-linux-dns.mjs
// 描述：linux-dns-tcpdump 非提权转换器（内部决策-029 决策 6，内部规则-9，内部任务-OBSO-LINUX-1）——
//       增量解析 spool pcap（/var/lib/os-observe-dns/dns-spool/*.pcap——root 属主载体目录，
//       内部未决-215/H10 迁移 2026-11-02 内部任务-281；tcpdump -G 轮转产物）：
//       pcap 全局头四魔数（usec/nsec × BE/LE）→ 链路头（SLL/SLL2/Ethernet）→ IP（v4/v6）
//       → UDP/TCP → DNS 问题节；只采 QR=0 的查询（响应的问题节回显不重复计）；域名
//       压缩指针出现在问题节=异常弃整记录（查询问题节不应有指针）；尾残包不消费
//       （游标停完整记录边界，下轮补读）；文件较游标收缩=轮回复位重读；游标条目随
//       文件消失清洗。样本 kind='dnsq' 带 source='linux-dns-tcpdump'（进程归因恒
//       null——pcap 无进程信息，内部未决-33；qtype 只存类型不存内容，B-M14-5 脱敏口径）。
//       自含单文件（部署面=bin/，无仓库内 import）；fail-open 任何异常静默退 0；
//       注入缝 OS_OBSERVE_HOME。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.OS_OBSERVE_HOME || join(homedir(), '.zcode', 'os-observe');
// H10（内部未决-215，2026-11-02 内部任务-281）：spool 迁 root 属主 /var/lib/os-observe-dns/dns-spool（root
// 周期执行面迁出用户可写家目录；本转换器非提权——root 目录 0755/pcap 0644 下只读消费）。注入缝
// OS_OBSERVE_DNS_ROOT 与启用链 dnsRootDir() 同缺省值：本文件自含单文件（部署面=bin/，无仓内
// import），缺省字面量重复属既定设计——无机械锚定（测试全经 env 缝注入），改动须双查两文件
//（缺省路径由真机验证步骤间接行使；round1 E4 口径）。
const DNS_ROOT = process.env.OS_OBSERVE_DNS_ROOT || '/var/lib/os-observe-dns';
const SPOOL = join(DNS_ROOT, 'dns-spool');
const CURSOR = join(HOME, 'dns', 'cursor.json'); // 游标迁用户侧可写位（root spool 用户不可写，内部任务-281）

/** pcap 全局头 → {rd32, frac:'u'|'n', network}；四魔数双端序（a1b2c3d4 / a1b23c4d 族）。 */
function readGlobal(buf) {
  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  let endian = null;
  let frac = 'u';
  if (be === 0xa1b2c3d4) endian = 'BE';
  else if (le === 0xa1b2c3d4) endian = 'LE';
  else if (be === 0xa1b23c4d) { endian = 'BE'; frac = 'n'; }
  else if (le === 0xa1b23c4d) { endian = 'LE'; frac = 'n'; }
  if (!endian) return null;
  return {
    rd32: (o) => (endian === 'BE' ? buf.readUInt32BE(o) : buf.readUInt32LE(o)),
    frac,
    network: endian === 'BE' ? buf.readUInt32BE(20) : buf.readUInt32LE(20),
  };
}

/** 链路层 → {ipOff, etOff}（SLL=113 / SLL2=276 / Ethernet=1；其余 null=整文件跳过）。 */
function linkLayout(network) {
  if (network === 113) return { ipOff: 16, etOff: 14 };
  if (network === 276) return { ipOff: 20, etOff: 0 };
  if (network === 1) return { ipOff: 14, etOff: 12 };
  return null;
}

/** IP 包（pkt 起点=IP 头）→ DNS 问题数组 [{domain, qtype}]；非 DNS/解析异常返回 null（整记录跳过）。
 *  DNS-over-TCP（RFC 7766）：TCP 载荷前有 2 字节报文长度前缀——跳过后再解 DNS 头。 */
function extractQuestions(pkt) {
  let o = 0;
  const v = pkt[o] >> 4;
  if (v === 4) {
    const proto = pkt[9];
    o = (pkt[0] & 0xf) * 4;
    if (proto === 17) o += 8;
    else if (proto === 6) o += (pkt[o + 12] >> 4) * 4 + 2; // TCP：data offset + 2 字节长度前缀
    else return null;
  } else if (v === 6) {
    const nh = pkt[6];
    o = 40;
    if (nh === 17) o += 8;
    else if (nh === 6) o += (pkt[o + 12] >> 4) * 4 + 2;
    else return null;
  } else return null;
  if (o + 12 > pkt.length) return null;
  const flags = (pkt[o + 2] << 8) | pkt[o + 3];
  if (flags & 0x8000) return []; // QR=1 响应：合法记录但无查询可采
  const qd = (pkt[o + 4] << 8) | pkt[o + 5];
  let p = o + 12;
  const out = [];
  for (let i = 0; i < Math.min(qd, 8); i += 1) {
    const labels = [];
    let ok = true;
    for (let guard = 0; ; guard += 1) {
      if (p >= pkt.length || guard > 128) { ok = false; break; }
      const len = pkt[p];
      if (len === 0) { p += 1; break; }
      if ((len & 0xc0) !== 0 || p + 1 + len > pkt.length) { ok = false; break; } // 压缩指针/越界=异常弃整记录
      labels.push(pkt.subarray(p + 1, p + 1 + len).toString('latin1'));
      p += 1 + len;
    }
    if (!ok || p + 4 > pkt.length) break;
    const qtype = (pkt[p] << 8) | pkt[p + 1];
    p += 4; // QTYPE+QCLASS
    const domain = labels.join('.').toLowerCase();
    if (domain && domain.length <= 253 && /^[\x21-\x7e.]+$/.test(domain)) out.push({ domain, qtype });
  }
  return out;
}

/** 记录流解析（增量自 from；from 低于全局头长度时钳到 24——游标基线即 24）。返回 {questions, off}——off=最后完整记录末尾。 */
function parseRecords(buf, from, g, link) {
  const out = [];
  let off = Math.max(from, 24); // 前 24 字节是 pcap 全局头，不是记录
  while (off + 16 <= buf.length) {
    const sec = g.rd32(off);
    const frac = g.rd32(off + 4);
    const incl = g.rd32(off + 8);
    if (incl === 0 || off + 16 + incl > buf.length) break; // 尾残包不消费
    const rec = buf.subarray(off + 16, off + 16 + incl);
    if (incl >= link.etOff + 2) { // incl 短于链路头读不到 ethertype——跳过该记录但前进（阶段门 B P6：不炸整轮）
      const et = rec.readUInt16BE(link.etOff);
      if (et === 0x0800 || et === 0x86dd) {
        const qs = extractQuestions(rec.subarray(link.ipOff));
        const tsMs = sec * 1000 + Math.floor(frac / (g.frac === 'n' ? 1e6 : 1e3));
        if (qs) for (const q of qs) out.push({ tsMs, ...q });
      }
    }
    off += 16 + incl;
  }
  return { questions: out, off };
}

function localDay(now) {
  const n = new Date(now);
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
}

function main() {
  let files = [];
  try { files = readdirSync(SPOOL).filter((f) => f.endsWith('.pcap')).sort(); } catch { return; }
  let cursor = {};
  try { cursor = JSON.parse(readFileSync(CURSOR, 'utf8')).files ?? {}; } catch { /* 坏游标=空，全量重读 */ }
  const samples = [];
  const nextCursor = {};
  for (const name of files) {
    const path = join(SPOOL, name);
    let buf;
    try { buf = readFileSync(path); } catch { continue; } // 竞态容忍
    if (buf.length < 24) continue; // 全局头都没有——跳过
    const g = readGlobal(buf);
    if (!g) continue; // 非 pcap（垃圾/半写的头部）——跳过
    const link = linkLayout(g.network);
    if (!link) continue;
    let from = Number.isInteger(cursor[name]) && cursor[name] >= 24 ? cursor[name] : 24; // 24=全局头后首记录
    if (buf.length < from) from = 24; // 文件收缩=轮回复位（以已读缓冲长度为准，免二次观测竞态）
    const { questions, off } = parseRecords(buf, from, g, link);
    for (const q of questions) {
      samples.push({ ts: new Date(q.tsMs).toISOString(), kind: 'dnsq', domain: q.domain, qtype: q.qtype, source: 'linux-dns-tcpdump' });
    }
    nextCursor[name] = off;
  }
  if (samples.length > 0) {
    mkdirSync(join(HOME, 'raw'), { recursive: true });
    appendFileSync(join(HOME, 'raw', `samples-${localDay(Date.now())}.jsonl`), `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  }
  mkdirSync(join(HOME, 'dns'), { recursive: true });
  writeFileSync(CURSOR, `${JSON.stringify({ schemaVersion: 1, files: nextCursor })}\n`, 'utf8');
}

try { main(); } catch { /* fail-open：死轮次由读取面停滞提示暴露 */ }
process.exit(0);
