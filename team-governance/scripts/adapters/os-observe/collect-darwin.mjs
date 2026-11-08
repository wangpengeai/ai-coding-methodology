// 文件：collect-darwin.mjs
// 描述：os-observation darwin TCP 采集器（内部决策-029 决策 7，内部规则-9/内部需求-15，内部任务-OBSO-DARWIN-1）
//       ——spawn `lsof -nP -iTCP -sTCP:ESTABLISHED` 单轮快照（Apple 预装 /usr/sbin/lsof，
//       builtin 定性同 win32 系统 cmdlet，内部决策-029 决策 5）。lsof 列对齐非空白安全：COMMAND
//       可含空格、SIZE/OFF 可空，故 NAME 以行尾 `(ESTABLISHED)` 尾锚 + `X->Y` 对提取远端
//       （IPv6 剥方括号与 %zone 后缀——zone 不剥则 IP/CIDR 规则匹配失明），COMMAND/PID 以
//       「行首非贪婪命令名 + 数值护栏 + IPv[46] 列锚」归因（pid≤4 系统进程过滤同 win32
//       口径）；回环与未指定地址过滤（同 collect-linux.mjs）。归因限当前用户可观测面。
//       样本 {ts,kind:'tcp',ip,port,processName,source:'darwin-net-tcp-poll'}；7 天保留清理；
//       自含单文件（部署面=~/.zcode/os-observe/bin/，无仓库内 import）；fail-open：任何
//       异常静默退 0（死轮次由读取面停滞提示暴露，不崩不循环）。
//       注入缝：OS_OBSERVE_HOME（根目录）、OS_OBSERVE_LSOF_OUT（lsof 输出替身文件——设置
//       即读文件不 spawn，fixture 跨平台可测）、OS_OBSERVE_LSOF_BIN（二进制路径覆盖）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 team-governance/LICENSE）
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { appendSamplesAndPrune, writeCollectorFailure } from './collect-common.mjs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.OS_OBSERVE_HOME || join(homedir(), '.zcode', 'os-observe');

/** lsof 输出替身优先（测试缝）；否则 spawn 本机 lsof（-n 不反解主机名、-P 不反解端口名）。 */
function readLsofOut() {
  const stub = process.env.OS_OBSERVE_LSOF_OUT;
  if (stub) return readFileSync(stub, 'utf8');
  const bin = process.env.OS_OBSERVE_LSOF_BIN || 'lsof';
  const r = spawnSync(bin, ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
  // lsof 无匹配连接时退出码=1（正常「无数据」，三维评审修复）；stderr 仅在 status≠0/error 时参与判定
  const statusNoData = r.status === 1 && String(r.stderr ?? '').trim() === '';
  const failed = Boolean(r.error) || (r.status !== 0 && r.status !== 1) || (r.status === 1 && String(r.stderr ?? '').trim() !== '');
  if (failed && !statusNoData) {
    // 内部任务-257（P5-3）：spawn/退出失败留痕（不冒充「无数据」）
    try { writeCollectorFailure(join(process.env.OS_OBSERVE_HOME || HOME, 'raw'), 'lsof-spawn', r.error || `status=${r.status}`); } catch { /* 留痕失败不阻断 */ }
    return '';
  }
  return String(r.stdout ?? '');
}

/** `140.207.55.20:443` / `[2001:db8::2%en0]:443` → {ip, port}（剥方括号与 %zone）。 */
function parseEndpoint(s) {
  const ci = s.lastIndexOf(':');
  if (ci < 0) return { ip: s, port: null };
  let host = s.slice(0, ci);
  const port = parseInt(s.slice(ci + 1), 10);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zi = host.indexOf('%');
  if (zi >= 0) host = host.slice(0, zi);
  return { ip: host, port: Number.isInteger(port) ? port : null };
}

/** lsof 文本 → established 样本数组（跳表头；COMMAND 数值护栏 + NAME 尾锚；坏行跳过）。 */
function parseLsof(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const m = /^(.+?)\s+(\d+)\s+\S+\s+\S+\s+IPv[46]\s+\S+\s+.*?\bTCP\s+\S+->(\S+)\s+\(ESTABLISHED\)\s*$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[2], 10);
    const remote = parseEndpoint(m[3]);
    if (remote.port === null) continue;
    if (remote.ip === '127.0.0.1' || remote.ip === '::1' || remote.ip === '0.0.0.0' || remote.ip === '::') continue;
    if (pid <= 4) continue; // 系统进程（pid 0 kernel 等，win32 同口径）
    out.push({ pid, processName: m[1].trim(), ip: remote.ip, port: remote.port });
  }
  return out;
}

function main() {
  const rawDir = join(HOME, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const conns = parseLsof(readLsofOut());
  const lines = [];
  if (conns.length > 0) {
    const now = new Date();
    for (const c of conns) {
      lines.push(JSON.stringify({
        ts: now.toISOString(), kind: 'tcp', ip: c.ip, port: c.port,
        processName: c.processName, source: 'darwin-net-tcp-poll',
      }));
    }
  }
  if (process.env.OS_OBSERVE_FORCE_FAIL === '1') throw new Error('injected collector failure（测试缝）');
  appendSamplesAndPrune(rawDir, lines); // 共享尾段：追加＋7 天保留清理
}

try {
  main();
} catch (e) {
  writeCollectorFailure(join(HOME, 'raw'), 'main', e);
}
process.exit(0);
