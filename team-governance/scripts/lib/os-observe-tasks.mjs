// 文件：os-observe-tasks.mjs
// 描述：os-observation 安装器（内部规则-11 / 内部需求-17 / 内部验收-8）——install（部署采样器到
//       稳定路径 ~/.zcode/os-observe/bin/（调度载体平台分支：win32=collect.ps1+计划任务
//       不指向版本化插件缓存目录；linux=collect-linux.mjs+用户 crontab 标记锚，pollMinutes
//       限 60 因子集——cron 分钟字段表达力边界；cron 探测失败降级仅机会式并明示，
//       内部任务-OBSO-LINUX-1；darwin=collect-darwin.mjs+LaunchAgent plist 生成与 launchctl
//       bootstrap/bootout 覆写式幂等注册移除〔OS_OBSERVE_LAUNCHAGENTS_DIR 注入缝，
//       内部任务-66〕——不注册 crontab）、播种 config 幂等不覆写、覆写式注册幂等、参数数组禁
//       shell 拼接）/uninstall（对称移除调度条目，无条目按已移除；findings/config/raw/bin
//       保留——卸载不销账；darwin=bootout+删 plist，bin 保留同前——原「删采集器」
//       机会式形态废止，内部任务-66）/
//       taskQuery（在册判定；darwin=launchctl 在册）/statusReport（调度在册+配置+发现
//       计数+采集新鲜度+部署脚本 sha256 对拍插件内置——插件升级后可检出漂移）+
//       opportunisticCollect（SessionStart 补位：win32 ps1 清单 / linux node 清单 /
//       darwin node 单脚本清单，部署面存在即各跑一轮 6s fail-open）。
//       spawnFn/platform/now/nodePath 注入缝供测试；真实链路实测见 内部任务-OSOBS-1/
//       内部任务-OBSO-LINUX-1 实测记录。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { atomicWriteJson } from './atomic-write.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUserConfig, POLL_MINUTES } from './os-observe-classify.mjs';
import { countFindings, osObserveHome, rawFreshness, readFindings, staleOf } from './os-observe-store.mjs';
import { sysmonStatus } from '../adapters/os-observe-sysmon.mjs';
import { dnsStatus } from '../adapters/os-observe-linux-dns.mjs';
import { ensureNl, filterCronBlock, LINUX_POLL_SET, readCrontab, shQuote, writeCrontab, writeFailWhy } from './os-observe-cron.mjs';

export const TASK_NAME = 'OsObserve-NetDnsPoll';
/** linux 用户 crontab 标记锚（注册/移除/在册判定的幂等载体）。 */
export const USER_POLL_MARKER = '# os-observe:linux-net-poll';

/** XML 文本转义（plist 字符串注入面——路径含 &<> 时防坏 plist）。 */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** darwin LaunchAgent plist（内部决策-029 决策 7 增补，内部任务-66）——Label 复用 TASK_NAME（与 win32 /TN
 *  同名跨平台对称）；StartInterval 秒级（pollMinutes×60）；RunAtLoad 登录/注册即采首轮。 */
function launchdPlist(pollMinutes, nodePath, collectorPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${TASK_NAME}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEsc(nodePath)}</string>\n    <string>${xmlEsc(collectorPath)}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StartInterval</key>\n  <integer>${pollMinutes * 60}</integer>\n</dict>\n</plist>\n`;
}

/** LaunchAgents 目录（注入缝 OS_OBSERVE_LAUNCHAGENTS_DIR——测试 tmp 隔离；缺省用户域）。 */
const launchAgentsDir = () => process.env.OS_OBSERVE_LAUNCHAGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');

/** launchd 服务域（gui/<uid>）。非 POSIX 平台 getuid 不存在，回退 -1——仅测试域串对拍可达（真实 darwin 恒有 getuid）。 */
export const agentDomain = () => `gui/${typeof process.getuid === 'function' ? process.getuid() : -1}`;
/** launchd 服务目标三面单源（install 注册/uninstall 移除/taskQuery 在册互指同一目标，防散布漂移）。 */
const agentTarget = () => `${agentDomain()}/${TASK_NAME}`;
const plistPathOf = () => join(launchAgentsDir(), `${TASK_NAME}.plist`);

/** 平台→builtin 采集器单一事实源（部署文件名+内置源路径——收尾评审简洁性 1 处置：原 6 处散布三元收敛）。 */
const COLLECTOR = {
  win32: {
    file: 'collect.ps1',
    shipped: fileURLToPath(new URL('../adapters/os-observe/collect.ps1', import.meta.url)),
  },
  linux: {
    file: 'collect-linux.mjs',
    shipped: fileURLToPath(new URL('../adapters/os-observe/collect-linux.mjs', import.meta.url)),
    // 内部任务-257（P5-3）：共享尾段模块须与采集器同目录部署
    support: [{ file: 'collect-common.mjs', shipped: fileURLToPath(new URL('../adapters/os-observe/collect-common.mjs', import.meta.url)) }],
  },
  darwin: {
    file: 'collect-darwin.mjs',
    shipped: fileURLToPath(new URL('../adapters/os-observe/collect-darwin.mjs', import.meta.url)),
    support: [{ file: 'collect-common.mjs', shipped: fileURLToPath(new URL('../adapters/os-observe/collect-common.mjs', import.meta.url)) }],
  },
};

/** win32 启动包装（内部任务-OSOBWIN-1）：wscript(GUI 子系统) 包装——计划任务 /TR 不直启控制台子系统
 *  powershell.exe（交互会话每周期闪窗），wscript 不分配控制台、Run 0 使子进程控制台创建即隐藏。
 *  不塞 COLLECTOR：vbs 是调度包装非采集器（linux 无对应物，塞入会稀释单一事实源语义）。 */
const WIN32_WRAPPER = {
  file: 'collect.vbs',
  shipped: fileURLToPath(new URL('../adapters/os-observe/collect.vbs', import.meta.url)),
};

function sha256File(p) {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

/** config 播种（两平台共享）：缺文件播种缺省；在场只对账 pollMinutes（allow/suspicious 等用户字段保留——
 *  停滞阈值按 config 计，两值漂移会产生假停滞/漏停滞）。 */
function seedConfig(home, pollMinutes) {
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    atomicWriteJson(configPath, { schemaVersion: 1, allow: [], suspicious: [], pollMinutes, surfaceDetail: false });
    return;
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (cfg.pollMinutes !== pollMinutes) {
      cfg.pollMinutes = pollMinutes;
      atomicWriteJson(configPath, cfg);
    }
  } catch { /* config 坏行时保持原文件，由读取面警告从句兜底 */ }
}

/** 安装：部署采样器 + 播种配置（幂等不覆写）+ 注册调度（win32=schtasks /F 覆写式幂等；linux=crontab 标记锚；darwin=LaunchAgent plist 覆写式幂等+launchctl bootstrap〔已加载则 bootout 重登〕，内部任务-66）。 */
export function install({ pollMinutes = 5, spawnFn = spawnSync, platform = process.platform, nodePath = process.execPath } = {}) {
  if (!COLLECTOR[platform]) {
    return {
      ok: false,
      availability: 'unavailable',
      error: 'os-observe 采集后端仅 Windows/Linux/macOS 已实测，本平台不可安装（不提供未实测命令，ADR-029 决策 5）',
    };
  }
  const valid = platform === 'linux'
    ? LINUX_POLL_SET.includes(pollMinutes)
    : Number.isInteger(pollMinutes) && pollMinutes >= POLL_MINUTES.MIN && pollMinutes <= POLL_MINUTES.MAX;
  if (!valid) {
    return {
      ok: false,
      usage: true,
      error: platform === 'linux'
        ? `Linux 调度载体为 cron，--poll-minutes 限 60 的因子集（收到 ${pollMinutes}；候选：${LINUX_POLL_SET.join('/')}）`
        : `--poll-minutes 须为 ${POLL_MINUTES.MIN}..${POLL_MINUTES.MAX} 的整数（收到 ${pollMinutes}）`,
    };
  }
  const home = osObserveHome();
  const plan = COLLECTOR[platform]; // 平台门已保证 win32/linux/darwin 之一
  mkdirSync(join(home, 'raw'), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  copyFileSync(plan.shipped, join(home, 'bin', plan.file));
  for (const sup of plan.support ?? []) copyFileSync(sup.shipped, join(home, 'bin', sup.file));
  seedConfig(home, pollMinutes);
  if (platform === 'win32') {
    copyFileSync(WIN32_WRAPPER.shipped, join(home, 'bin', WIN32_WRAPPER.file));
    const tr = `wscript.exe //nologo "${join(home, 'bin', WIN32_WRAPPER.file)}"`;
    const r = spawnFn('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'MINUTE', '/MO', String(pollMinutes), '/TR', tr, '/F'], { stdio: 'pipe' });
    if (r.status !== 0) {
      const why = r.error ? `（spawn error ${r.error.code}）` : `（exit ${r.status}）`;
      return { ok: false, error: `schtasks /Create 失败${why}：${String(r.stderr ?? '').trim()}` };
    }
    return {
      ok: true,
      task: TASK_NAME,
      pollMinutes,
      note: `计划任务 ${TASK_NAME} 已注册（每 ${pollMinutes} 分钟，当前用户非提权）；部署面=${home}（稳定路径）`,
    };
  }
  if (platform === 'darwin') {
    // launchd LaunchAgent 用户域周期（内部决策-029 决策 7 增补，内部任务-66）：plist 覆写式幂等 + bootstrap
    // （首败=已加载形态〔如 pollMinutes 变更须重载 plist〕→ bootout 后重登；重登仍败显式可见不静默
    // 降级——launchd 为 darwin 必在组件，缺席属异常环境）。机会式补位保留兜底（LaunchAgent 属 gui
    // 域，用户登录会话缺席期间停滞为真实语义，内部模块-14 §5）。
    const agents = launchAgentsDir();
    mkdirSync(agents, { recursive: true });
    const plistPath = plistPathOf();
    writeFileSync(plistPath, launchdPlist(pollMinutes, nodePath, join(home, 'bin', plan.file)), 'utf8');
    let r = spawnFn('launchctl', ['bootstrap', agentDomain(), plistPath], { stdio: 'pipe' });
    if (r.status !== 0) {
      spawnFn('launchctl', ['bootout', agentTarget()], { stdio: 'pipe' });
      r = spawnFn('launchctl', ['bootstrap', agentDomain(), plistPath], { stdio: 'pipe' });
      if (r.status !== 0) {
        const why = r.error ? `（spawn error ${r.error.code}）` : `（exit ${r.status}）`;
        return { ok: false, error: `launchctl bootstrap 失败${why}：${String(r.stderr ?? '').trim()}——部署面已就绪，可重跑 install（幂等）` };
      }
    }
    return {
      ok: true,
      task: TASK_NAME,
      pollMinutes,
      note: `LaunchAgent ${TASK_NAME} 已注册（每 ${pollMinutes} 分钟，当前用户非提权，已加载则覆写式重登）；部署面=${home}（稳定路径）；SessionStart 机会式补位兜底`,
    };
  }
  // linux：用户 crontab 标记锚（读→滤旧→拼新→写→复核；路径经 shQuote——含空格 home/node 路径防分词静默空转）
  const argv0 = ['crontab'];
  const read = readCrontab({ spawnFn, argv0 });
  if (!read.ok) {
    return {
      ok: true,
      task: null,
      pollMinutes,
      note: `部署面=${home}（稳定路径）；crontab 不可读（未安装或不可执行）——未注册定时，SessionStart 机会式补位采集兜底（每会话一轮，ADR-029 决策 6 降级形态）`,
    };
  }
  const line = `${USER_POLL_MARKER}\n*/${pollMinutes} * * * * ${shQuote(nodePath)} ${shQuote(join(home, 'bin', plan.file))} >/dev/null 2>&1\n`;
  const next = `${ensureNl(filterCronBlock(read.text, USER_POLL_MARKER))}${line}`;
  const w = writeCrontab({ spawnFn, argv0, text: next });
  if (!w || w.status !== 0) {
    return { ok: false, error: `crontab 写入失败${writeFailWhy(w)}——部署面已就绪，可重跑 install（幂等）` };
  }
  const chk = readCrontab({ spawnFn, argv0 });
  if (!chk.ok || !chk.text.includes(USER_POLL_MARKER)) {
    return { ok: false, error: 'crontab 复核未过（写入后回读未见标记锚）——可重跑 install（幂等）' };
  }
  return {
    ok: true,
    task: USER_POLL_MARKER,
    pollMinutes,
    note: `用户 crontab 已注册（每 ${pollMinutes} 分钟，标记 ${USER_POLL_MARKER}）；部署面=${home}（稳定路径）`,
  };
}

/** 卸载：对称移除调度条目（win32=schtasks，exit 1=不存在按已移除；linux=crontab 标记块；darwin=bootout+删 plist，未加载幂等）；findings/config/raw/bin 保留（卸载不销账——darwin 原「删采集器」例外形态废止，内部任务-66）。 */
export function uninstall({ spawnFn = spawnSync, platform = process.platform } = {}) {
  if (!COLLECTOR[platform]) {
    return { ok: false, availability: 'unavailable', error: '仅 Windows/Linux/macOS 已实测（不提供未实测命令，ADR-029 决策 5）' };
  }
  if (platform === 'win32') {
    const r = spawnFn('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe' });
    // 退出码 1 = 任务不存在（schtasks 语义），按已移除处理（幂等）；其余非零为失败
    if (r.status !== 0 && r.status !== 1) {
      return { ok: false, error: `schtasks /Delete 失败（exit ${r.status}）：${String(r.stderr ?? '').trim()}` };
    }
    return {
      ok: true,
      task: TASK_NAME,
      note: r.status === 1 ? '计划任务本不存在（幂等）' : '计划任务已移除；findings/config/raw/bin 保留（卸载不销账）',
    };
  }
  if (platform === 'darwin') {
    // 周期载体下停采由调度移除承载：bootout+删 plist；bin 保留回归 win/linux「卸载不销账」形态
    // （内部决策-029 决策 7 增补，内部任务-66——原「删部署面采集器」机会式形态废止）。未加载（bootout 非零
    // 且 print 不在册）按已移除幂等；bootout 失败而仍在册=显式失败可见。
    const plistPath = plistPathOf();
    const out = spawnFn('launchctl', ['bootout', agentTarget()], { stdio: 'pipe' });
    if (out.status !== 0) {
      const chk = spawnFn('launchctl', ['print', agentTarget()], { stdio: 'pipe' });
      if (chk.status === 0) {
        return { ok: false, error: `launchctl bootout 失败（exit ${out.status}）：${String(out.stderr ?? '').trim()}——可重跑 uninstall（幂等）` };
      }
    }
    const existed = existsSync(plistPath);
    if (existed) rmSync(plistPath, { force: true });
    const removed = out.status === 0 || existed; // 在册摘除或 plist 在场移除都构成真实移除（防「bootout 生效而 plist 缺席」误报无操作）
    return {
      ok: true,
      task: TASK_NAME,
      note: removed
        ? 'LaunchAgent 已移除（bootout+删 plist）；findings/config/raw/bin 保留（卸载不销账）'
        : 'LaunchAgent 本不存在（幂等）；findings/config/raw/bin 保留（卸载不销账）',
    };
  }
  const argv0 = ['crontab'];
  const read = readCrontab({ spawnFn, argv0 });
  if (!read.ok) return { ok: true, task: USER_POLL_MARKER, note: 'crontab 不可读（视为未注册，幂等）；findings/config/raw/bin 保留（卸载不销账）' };
  const next = filterCronBlock(read.text, USER_POLL_MARKER);
  const changed = String(next).trim() !== String(read.text).trim();
  if (changed) {
    const w = writeCrontab({ spawnFn, argv0, text: next });
    if (!w || w.status !== 0) {
      return { ok: false, error: `crontab 写入失败${writeFailWhy(w)}——可重跑 uninstall（幂等）` };
    }
  }
  return {
    ok: true,
    task: USER_POLL_MARKER,
    note: changed ? 'crontab 标记块已移除；findings/config/raw/bin 保留（卸载不销账）' : '标记块本不存在（幂等）；findings/config/raw/bin 保留（卸载不销账）',
  };
}

/** 在册判定：win32 只看 schtasks 退出码；linux 看 crontab 含标记锚（不解析本地化输出）；darwin=launchctl print 任务标签（内部任务-66）。 */
export function taskQuery({ spawnFn = spawnSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const r = spawnFn('schtasks', ['/Query', '/TN', TASK_NAME], { stdio: 'pipe' });
    return { installed: r.status === 0 };
  }
  if (platform === 'linux') {
    const read = readCrontab({ spawnFn, argv0: ['crontab'] });
    return { installed: read.ok && read.text.includes(USER_POLL_MARKER) };
  }
  if (platform === 'darwin') {
    // 在册判定=launchctl print 任务标签（内部决策-029 决策 7 增补，内部任务-66——部署面在场不再充数）
    const r = spawnFn('launchctl', ['print', agentTarget()], { stdio: 'pipe' });
    return { installed: r.status === 0 };
  }
  return { installed: false };
}

/** 聚合状态（CLI status 只读出口）。 */
export function statusReport({ spawnFn = spawnSync, platform = process.platform, now = Date.now } = {}) {
  const home = osObserveHome();
  const cfg = loadUserConfig(home);
  const folded = readFindings(home);
  const agg = countFindings(folded);
  const fresh = rawFreshness(home);
  const nowMs = typeof now === 'function' ? now() : now;
  const { staleMinutes, stale } = staleOf(fresh, cfg.config.pollMinutes, nowMs);
  const plan = COLLECTOR[platform] ?? COLLECTOR.win32; // darwin 取自身采集器对拍；未知平台回退 win32（statusReport 只读无害）
  const deployed = join(home, 'bin', plan.file);
  const deployedSha = sha256File(deployed);
  const shippedSha = sha256File(plan.shipped);
  // 启动包装对拍（内部任务-OSOBWIN-1）：win32 计划任务 /TR 指向 collect.vbs，包装漂移=闪窗回归或任务哑败，
  // 同 collect.ps1 口径做 sha256 对拍；linux 无包装（node 直拉）恒 null（键恒定，输出契约稳定）。
  const wrapperDeployed = join(home, 'bin', WIN32_WRAPPER.file);
  const wrapperSha = platform === 'win32' ? sha256File(wrapperDeployed) : null;
  const wrapperShippedSha = platform === 'win32' ? sha256File(WIN32_WRAPPER.shipped) : null;
  return {
    ok: true,
    installed: taskQuery({ spawnFn, platform }).installed,
    config: {
      valid: cfg.ok,
      warning: cfg.warning,
      pollMinutes: cfg.config.pollMinutes,
      surfaceDetail: cfg.config.surfaceDetail,
    },
    deployedScript: { path: deployed, sha256: deployedSha, matchesShipped: deployedSha !== null && deployedSha === shippedSha },
    wrapperScript: platform === 'win32'
      ? { path: wrapperDeployed, sha256: wrapperSha, matchesShipped: wrapperSha !== null && wrapperSha === wrapperShippedSha }
      : null,
    sysmon: sysmonStatus({ spawnFn, platform }), // win-sysmon 在装态（内部任务-SYSMON-1；provenance 对拍防本地篡改）
    dns: dnsStatus({ spawnFn, platform }),       // linux-dns-tcpdump 在装态（内部任务-OBSO-LINUX-1；进程/cron/provenance 对拍/spool 新鲜度）
    findings: { total: folded.size, byClass: agg.byClass, openSuspicious: agg.openSuspicious },
    raw: { files: fresh.files, bytes: fresh.bytes, newestTsMs: fresh.newestTsMs, staleMinutes, stale },
  };
}

/**
 * 机会式补位采集（内部任务-OBSO-COLLECT-1，内部规则-11/内部需求-17；内部任务-OBSO-LINUX-1 增 Linux 分支）：
 * SessionStart 浮现段在物化前调用——部署面存在即各跑一轮（调度条目被禁/缺席环境下的会话
 * 驱动补位通道；不判任务态：幂等采集与 findings 节流层吸收冗余，部署面存在本身即用户
 * 显式启用 install/sysmon-enable/dns-enable 的痕迹）。win32 直拉 PowerShell 带 windowsHide
 * （CREATE_NO_WINDOW——宿主无控制台，子进程不建窗不闪窗，内部任务-OSOBWIN-1）。
 * fail-open：任一脚本失败/超时静默
 * 跳过，不抛不输出（hook 姿态）；ran=实际尝试执行面（不含成败，供测试与审计）。
 * @param {{spawnFn?: Function, platform?: string}} opts
 * @returns {{ran: string[]}}
 */
export function opportunisticCollect({ spawnFn = spawnSync, platform = process.platform } = {}) {
  // 平台描述符表（阶段门 A 评审 F-S2 折叠：两分支同构 13 行 → 单循环）
  const PLAN = {
    win32: {
      launch: (p) => ['powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', p]],
      scripts: ['collect.ps1', 'collect-sysmon.ps1'],
    },
    linux: {
      launch: (p) => [process.execPath, [p]],
      scripts: ['collect-linux.mjs', 'collect-linux-dns.mjs'],
    },
    darwin: {
      launch: (p) => [process.execPath, [p]],
      scripts: ['collect-darwin.mjs'],
    },
  }[platform];
  const ran = [];
  if (!PLAN) return { ran };
  const home = osObserveHome();
  for (const script of PLAN.scripts) {
    const p = join(home, 'bin', script);
    if (!existsSync(p)) continue;
    ran.push(script);
    try {
      const [cmd, args] = PLAN.launch(p);
      spawnFn(cmd, args, { stdio: 'ignore', timeout: 6000, windowsHide: true });
    } catch {
      /* fail-open：超时/异常跳过，不阻断会话启动 */
    }
  }
  return { ran };
}
