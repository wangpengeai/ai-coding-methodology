// 文件：collect-linux.mjs
// 描述：os-observation Linux TCP 采集器（内部决策-029 决策 6，内部规则-9/内部需求-15，内部任务-OBSO-LINUX-1）
//       ——纯 Node 直读 /proc/net/tcp{,6} 的 established 行（远端地址+inode），经
//       /proc/<pid>/fd 的 socket:[inode] 对拍归因进程（/proc/<pid>/comm 取名，内核
//       15 字符上限、仅自有进程可归因——已接受限制见 内部模块-14 §5）；样本自带
//       source='linux-net-tcp-poll'（判定层按样本值取归属）；7 天保留清理。
//       自含单文件（部署面=~/.zcode/os-observe/bin/，无仓库内 import）；fail-open：
//       任何异常静默退 0（死轮次由读取面停滞提示暴露，不崩不循环）。
//       注入缝：OS_OBSERVE_HOME（根目录）、OS_OBSERVE_PROC_ROOT（/proc 替身，测试用）。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appendSamplesAndPrune, writeCollectorFailure } from './collect-common.mjs';

const PROC = process.env.OS_OBSERVE_PROC_ROOT || '/proc';
const HOME = process.env.OS_OBSERVE_HOME || join(homedir(), '.zcode', 'os-observe');

/** 8 位 hex（小端 32 位字）→ IPv4 点分串。 */
function hexToIp4(hex) {
  const b = [0, 1, 2, 3].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

/** 32 位 hex（4 个小端 32 位字，字内字节反转）→ IPv6 压缩串（RFC 5952：最长零段 ≥2 才压，取首个）；
 *  v4-mapped 段（::ffff:0:0/96）归一为点分 IPv4——双栈 AF_INET6 socket 的 v4 连接与 tcp 表同远端去重（阶段门 A F-C2）。 */
function hexToIp6(hex) {
  const bytes = [];
  for (let w = 0; w < 4; w += 1) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let i = 3; i >= 0; i -= 1) bytes.push(parseInt(word.slice(i * 2, i * 2 + 2), 16));
  }
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let best = -1; let bestLen = 0; let cur = -1;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (cur < 0) cur = i;
      if (i - cur + 1 > bestLen) { best = cur; bestLen = i - cur + 1; }
    } else cur = -1;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const head = groups.slice(0, best).map((g) => g.toString(16)).join(':');
  const tail = groups.slice(best + bestLen).map((g) => g.toString(16)).join(':');
  return `${head}::${tail}`;
}

/** /proc/net/tcp{,6} 文本 → established 远端端点 [{ip, port, inode}]（过滤监听态/回环/未指定）。 */
function parseNetTcp(text, is6) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '01') continue; // st=01 ESTABLISHED（监听 0A 等其余态不采）
    const [rip, rport] = f[2].split(':');
    const ip = is6 ? hexToIp6(rip) : hexToIp4(rip);
    if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === '::') continue;
    out.push({ ip, port: parseInt(rport, 16), inode: f[9] });
  }
  return out;
}

/** inode → 进程名映射（首中即止）：扫 /proc/<pid>/fd readlink socket:[inode]；不可读目录跳过（归因退 null）。 */
function buildInodeMap() {
  const m = new Map();
  let pids = [];
  try { pids = readdirSync(PROC).filter((x) => /^\d+$/.test(x)); } catch { return m; }
  for (const pid of pids) {
    let fds = [];
    try { fds = readdirSync(join(PROC, pid, 'fd')); } catch { continue; } // 非自有进程 fd 目录不可读——跳过
    for (const fd of fds) {
      try {
        const mm = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(PROC, pid, 'fd', fd)));
        if (mm && !m.has(mm[1])) {
          try { m.set(mm[1], readFileSync(join(PROC, pid, 'comm'), 'utf8').trim() || null); } catch { m.set(mm[1], null); }
        }
      } catch { /* 链接不可读跳过 */ }
    }
  }
  return m;
}

function main() {
  const rawDir = join(HOME, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const conns = [];
  for (const [file, is6] of [['tcp', false], ['tcp6', true]]) {
    try { conns.push(...parseNetTcp(readFileSync(join(PROC, 'net', file), 'utf8'), is6)); } catch { /* 文件缺失跳过 */ }
  }
  const lines = [];
  if (conns.length > 0) {
    const inodes = buildInodeMap();
    const now = new Date();
    for (const c of conns) {
      lines.push(JSON.stringify({
        ts: now.toISOString(), kind: 'tcp', ip: c.ip, port: c.port,
        processName: inodes.get(c.inode) ?? null, source: 'linux-net-tcp-poll',
      }));
    }
  }
  if (process.env.OS_OBSERVE_FORCE_FAIL === '1') throw new Error('injected collector failure（测试缝）');
  appendSamplesAndPrune(rawDir, lines); // 共享尾段：追加＋7 天保留清理
}

try {
  main();
} catch (e) {
  // 内部任务-257（P5-3）：失败留痕（读取面可见），不冒充「无数据」
  writeCollectorFailure(join(HOME, 'raw'), 'main', e);
}
process.exit(0);
