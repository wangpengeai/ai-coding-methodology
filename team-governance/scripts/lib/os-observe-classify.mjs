// 文件：os-observe-classify.mjs
// 描述：os-observation 判定层纯函数（内部规则-9 / 内部需求-15 / 内部验收-6）——三态分类与优先级
//       （user-allow > user-suspicious > builtin-allow > builtin-suspicious > unknown）、
//       内置允许/可疑清单、用户配置加载（不可读退内置清单并给出警告从句）、
//       DNS 样本 → ip-域名索引（viaDomain join 用）、样本 → finding 字段集（含
//       parse-error 降级：fail-toward-alert，解析异常记 unknown 不丢弃）。
//       IP/CIDR 规则与样本 source 优先（内部任务-OBSO-LINUX-1，内部验收-16）：无 viaDomain
//       的 TCP 行按 endpoint IP 匹配 user 的 IP 模式（Linux 无 DNS join 面的缓解）；
//       样本自带 source 字段声明来源后端（缺省按 kind 旧映射，向后兼容）。
//       分类本体无 IO，规则作参数传入，平台中性。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { readFileSync } from 'node:fs';

import { atomicWriteJson } from './atomic-write.mjs';
import { join } from 'node:path';

import { digestOf } from './os-observe-store.mjs';

export const BUILTIN_ALLOW = ['zcode.z.ai', '*.z.ai'];
export const BUILTIN_SUSPICIOUS = ['*.aliyuncs.com', '*.cos.*', '*.s3.*'];

/** pollMinutes 合法域（install 校验与 config 加载共用，防字面双份漂移——评审简洁性 6 处置）。 */
export const POLL_MINUTES = { MIN: 1, MAX: 1439 };

const DEFAULT_CONFIG = Object.freeze({ allow: [], suspicious: [], pollMinutes: 5, surfaceDetail: false });

/** 把含 '*' 通配的模式编译为锚定全匹配的正则（'*' 通配任意含点字符，其余转义）。 */
export function compilePattern(pattern) {
  const parts = String(pattern).split('*').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`);
}

function matchList(domain, patterns) {
  for (const p of patterns) {
    if (compilePattern(p).test(domain)) return p;
  }
  return undefined;
}

/** 三态分类：优先级 user-allow > user-suspicious > builtin-allow > builtin-suspicious > unknown。 */
export function classifyDomain(domain, { userAllow = [], userSuspicious = [] } = {}) {
  let p;
  if ((p = matchList(domain, userAllow)) !== undefined) return { class: 'allowed', basis: { rule: 'user-allow', pattern: p } };
  if ((p = matchList(domain, userSuspicious)) !== undefined) return { class: 'suspicious', basis: { rule: 'user-suspicious', pattern: p } };
  if ((p = matchList(domain, BUILTIN_ALLOW)) !== undefined) return { class: 'allowed', basis: { rule: 'builtin-allow', pattern: p } };
  if ((p = matchList(domain, BUILTIN_SUSPICIOUS)) !== undefined) return { class: 'suspicious', basis: { rule: 'builtin-suspicious', pattern: p } };
  return { class: 'unknown', basis: { rule: 'default-unknown' } };
}

/** IPv4/IPv6（含 :: 与 /CIDR 前缀；::ffff:a.b.c.d 混合文本按 v4-mapped 归一——与采集器同口径，收尾评审正确性 2 处置）→ {ip:BigInt, bits, v6}；非 IP 形态 null（域名模式天然不参与）。 */
function parseIpOrCidr(pattern) {
  const s = String(pattern).trim();
  const slash = s.indexOf('/');
  const ipPart = slash === -1 ? s : s.slice(0, slash);
  const prefixPart = slash === -1 ? null : s.slice(slash + 1);
  // v4-mapped 混合文本（::ffff:a.b.c.d）：归一为点分 v4（采集器侧 /proc hex 已同口径归一）
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ipPart);
  const dot = ipPart.includes('.');
  const colon = ipPart.includes(':');
  let bits; let v6; let ip;
  const v4Text = mapped ? mapped[1] : (dot && !colon ? ipPart : null);
  if (v4Text !== null) {
    const segs = v4Text.split('.');
    if (segs.length !== 4) return null;
    let acc = 0n;
    for (const seg of segs) {
      if (!/^\d{1,3}$/.test(seg)) return null;
      const n = Number(seg);
      if (n > 255) return null;
      acc = (acc << 8n) | BigInt(n);
    }
    ip = acc; bits = 32; v6 = false;
  } else if (colon && !dot) {
    if (ipPart.includes('%')) return null; // zone 后缀不支持
    const halves = ipPart.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] === '' ? [] : halves[0].split(':');
    const right = halves.length === 2 && halves[1] === '' ? [] : (halves.length === 2 ? halves[1].split(':') : left);
    if (halves.length === 2 && left.length + right.length > 8) return null; // :: 展开会超 8 组——非法定址
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    if (groups.length !== 8 || (halves.length === 1 && ipPart === '')) return null;
    let acc = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      acc = (acc << 16n) | BigInt(parseInt(g, 16));
    }
    ip = acc; bits = 128; v6 = true;
  } else return null;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    const n = Number(prefixPart);
    if (n > bits) return null;
    bits = n;
  }
  return { ip, bits, v6 };
}

/** IP/CIDR 模式匹配（同族才比；前缀长度外不匹配）。返回命中模式或 undefined。 */
function matchIpList(ipText, patterns) {
  const target = parseIpOrCidr(ipText);
  if (!target) return undefined;
  for (const p of patterns) {
    const c = parseIpOrCidr(p);
    if (!c || c.v6 !== target.v6) continue;
    const shift = BigInt((target.v6 ? 128 : 32) - c.bits);
    if ((c.ip >> shift) === (target.ip >> shift)) return p;
  }
  return undefined;
}

/** IP 端点三态（无 viaDomain 的 TCP 行）：user-allow-ip > user-suspicious-ip > unknown（builtin 清单域名-only 不参与）。 */
function classifyEndpoint(ipText, { userAllow = [], userSuspicious = [] } = {}) {
  let p;
  if ((p = matchIpList(ipText, userAllow)) !== undefined) return { class: 'allowed', basis: { rule: 'user-allow-ip', pattern: p } };
  if ((p = matchIpList(ipText, userSuspicious)) !== undefined) return { class: 'suspicious', basis: { rule: 'user-suspicious-ip', pattern: p } };
  return { class: 'unknown', basis: { rule: 'default-unknown' } };
}

/** 用户配置（~/.zcode/os-observe/config.json）：缺文件=未定制静默默认；坏 JSON=退内置清单+警告（不静默吞）。 */
export function loadUserConfig(home) {
  let raw;
  try {
    raw = readFileSync(join(home, 'config.json'), 'utf8');
  } catch {
    return { ok: true, config: DEFAULT_CONFIG };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, config: DEFAULT_CONFIG, warning: 'config.json 不可读或非法，按内置清单判定' };
  }
  const clean = (arr) => (Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length > 0) : []);
  const pm = cfg.pollMinutes;
  return {
    ok: true,
    config: {
      allow: clean(cfg.allow),
      suspicious: clean(cfg.suspicious),
      pollMinutes: Number.isInteger(pm) && pm >= POLL_MINUTES.MIN && pm <= POLL_MINUTES.MAX ? pm : 5,
      surfaceDetail: cfg.surfaceDetail === true,
    },
  };
}

/** 规则 pattern 合法性（内部任务-ALLOWCLI-1）：域名 glob（[A-Za-z0-9*.-]、1..253、非空）或 IP/CIDR
 *  （parseIpOrCidr——v4/v6/前缀/v4-mapped 同口径）。宽松校验：匹配语义以 compilePattern/matchIpList
 *  为准，这里只拦注入面（空白/引号/分号/控制字符）与空串/超长。 */
export function isValidRulePattern(pattern) {
  const s = String(pattern ?? '');
  if (s.length === 0 || s.length > 253) return false;
  if (s !== s.trim()) return false; // 首尾空白一律拒（parseIpOrCidr 内部 trim 不得成为漏风口，终审正确性 3）
  return /^[A-Za-z0-9*.-]+$/.test(s) || parseIpOrCidr(s) !== null;
}

/**
 * 追加用户规则（内部任务-ALLOWCLI-1，内部规则-11/内部需求-17）：kind=allow→config.allow / deny→config.suspicious。
 * 幂等（同 pattern 已在→added:false 不重复追加不落盘）；既有字段（pollMinutes/surfaceDetail 等）原样
 * 保留（seedConfig 同款纪律——整体对象读改写，不重建字段集）；坏 config 抛错（CLI 退 1 可见，绝不
 * 静默覆盖坏文件）。与 loadUserConfig 的分界：那是读侧容错（坏 JSON 退内置清单），这是写侧严格。
 * @param {{kind:'allow'|'deny', pattern:string, home:string}} opts
 * @returns {{added:boolean, pattern:string, list:string[]}}
 */
export function appendUserRule({ kind, pattern, home }) {
  if (kind !== 'allow' && kind !== 'deny') throw new Error(`未知规则类别（须 allow|deny）：${kind}`);
  // 小写归一：匹配链大小写敏感且采集样本为实测小写——大写规则是静默死规则，落盘前统一归一
  // （DNS 大小写不敏感语义；IP/CIDR 无字母大小写面不受损。终审正确性 2）。
  pattern = String(pattern ?? '').toLowerCase();
  if (!isValidRulePattern(pattern)) throw new Error(`非法 pattern（须为域名 glob（* 通配）或 IP/CIDR）：${pattern}`);
  const configPath = join(home, 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(`config.json 不可读或非合法 JSON（${e.message}）——拒绝写入，请先修复`), { code: e?.code, errno: e?.errno });
  }
  if (!Array.isArray(cfg.allow)) cfg.allow = [];
  if (!Array.isArray(cfg.suspicious)) cfg.suspicious = [];
  const list = kind === 'allow' ? cfg.allow : cfg.suspicious;
  if (list.includes(pattern)) return { added: false, pattern, list: [...list] };
  list.push(pattern);
  atomicWriteJson(configPath, cfg);
  return { added: true, pattern, list: [...list] };
}

/** DNS 样本（qtype 1=A / 28=AAAA）→ Map<ip, domain>；同 ip 多域名取字典序最小（确定性）。 */
export function buildDomainIndex(samples) {
  const m = new Map();
  for (const s of samples) {
    if (!s || s.__parseError || s.kind !== 'dns') continue;
    if (s.qtype !== 1 && s.qtype !== 28) continue;
    const ip = String(s.data ?? '');
    const domain = String(s.domain ?? '');
    if (!ip || !domain) continue;
    const cur = m.get(ip);
    if (cur === undefined || domain < cur) m.set(ip, domain);
  }
  return m;
}

/** 样本 → finding 字段集。idInput 供 pipeline 组 id（digest 输入）；parse-error 行 source='parse' 伪后端。
 *  样本自带 source 字段优先（内部任务-OBSO-LINUX-1），缺省按 kind 旧映射（向后兼容）；
 *  tcp 无 viaDomain 时按 endpoint IP 匹配 user 的 IP/CIDR 规则（内部验收-16）。 */
export function classifySample(sample, rules, domainIndex) {
  if (!sample || sample.__parseError) {
    const lineDigest = String(sample?.lineDigest ?? '');
    return {
      idInput: `parse||${lineDigest}`,
      source: 'parse', process: null, endpoint: null, endpointKind: null, viaDomain: undefined,
      class: 'unknown', basis: { rule: 'parse-error', lineDigest },
    };
  }
  const src = typeof sample.source === 'string' && sample.source ? sample.source : null;
  if (sample.kind === 'tcp') {
    const via = domainIndex.get(String(sample.ip)) ?? null;
    const judged = via
      ? classifyDomain(via, rules)
      : classifyEndpoint(String(sample.ip), rules); // 无 join 面时 IP 规则承接（内部验收-16）
    const source = src ?? 'win-net-tcp-poll';
    const process = sample.processName ? String(sample.processName) : null;
    return {
      idInput: `${source}|${process ?? ''}|${sample.ip}`,
      source, process, endpoint: String(sample.ip), endpointKind: 'ip',
      viaDomain: via, class: judged.class, basis: judged.basis,
    };
  }
  if (sample.kind === 'dns') {
    const judged = classifyDomain(String(sample.domain), rules);
    const source = src ?? 'win-dns-cache-poll';
    return {
      idInput: `${source}||${sample.domain}`,
      source, process: null, endpoint: String(sample.domain), endpointKind: 'domain',
      viaDomain: undefined, class: judged.class, basis: judged.basis,
    };
  }
  if (sample.kind === 'dnsq') {
    // win-sysmon/linux-dns-tcpdump 采集面：样本 kind='dnsq'——process 取样本值
    // （缺省 null 不伪造；可归因与否由来源后端决定，见 内部模块-14 §5 限制节）
    const judged = classifyDomain(String(sample.domain), rules);
    const process = sample.processName ? String(sample.processName) : null;
    const source = src ?? 'win-sysmon';
    return {
      idInput: `${source}|${process ?? ''}|${sample.domain}`,
      source, process, endpoint: String(sample.domain), endpointKind: 'domain',
      viaDomain: undefined, class: judged.class, basis: judged.basis,
    };
  }
  // 未知 kind：合法 JSON 但形态不合——按 parse-error 降级（digest 现算，内容只存 digest）
  const lineDigest = digestOf([JSON.stringify(sample)]);
  return {
    idInput: `parse||${lineDigest}`,
    source: 'parse', process: null, endpoint: null, endpointKind: null, viaDomain: undefined,
    class: 'unknown', basis: { rule: 'parse-error', lineDigest },
  };
}
