// 文件：os-observe-sysmon.mjs
// 描述：win-sysmon 扩展位启用链（内部任务-SYSMON-1/内部未决-29，内部需求-15/17，NFR-tg-supplychain）
//       ——sysmonGuide（四要素+步骤引导，纯只读）/sysmonPrepare（官方 zip 下载→解压→
//       Authenticode 签名核验→版本读取→provenance.json 四要素记账；未核验不落账、
//       不进启用面）/sysmonEnable（部署采样器+配置+提权脚本三件到 bin → UAC 提权执行
//       sysmon-install-elevated.ps1（驱动安装+仅 DnsQuery 最小配置+一次性 Event Log
//       Readers 授予；结果经 elevated-result.txt 轮询回传——Start-Process -Wait 对提权
//       子进程不可靠）→ 采集任务在本侧非提权注册（真机实证：提权上下文注册的任务被
//       终端策略自动禁用）→ 服务/任务复核）/sysmonDisable（移除采集计划任务；驱动卸载
//       为引导输出——sysmon64 -u 属用户决策面，插件不自动执行）/sysmonStatus（服务
//       RUNNING/渠道/任务在册/provenance 对拍——本地 Sysmon64.exe 实算哈希须与记账
//       一致，防本地篡改）。
//       平台专有名仅存本文件与 adapters/os-observe/ 采样面（内部接口-1 §3 adapter
//       文件区）。只读面 fail-open（坏态按 null/false 如实呈现）；写面（enable/disable）
//       失败可见。下载用 Node fetch、解压用 PowerShell Expand-Archive（真机实测 MSYS GNU tar
//       把盘符路径当远程主机——adapter 文件区平台工具，零第三方，NFR-tg-portability）。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { osObserveHome } from '../lib/os-observe-store.mjs';

export const SOURCE_URL = 'https://download.sysinternals.com/files/Sysmon.zip';
export const SYSMON_TASK_NAME = 'OsObserve-SysmonPoll';
export const SYSMON_LOG_NAME = 'Microsoft-Windows-Sysmon/Operational';

const SHIPPED_DIR = fileURLToPath(new URL('./os-observe/', import.meta.url));
const SHIPPED = {
  collector: join(SHIPPED_DIR, 'collect-sysmon.ps1'),
  config: join(SHIPPED_DIR, 'sysmon-config.xml'),
  elevated: join(SHIPPED_DIR, 'sysmon-install-elevated.ps1'),
};

/**
 * OS_OBSERVE_HOME 合法性守卫（内部任务-255 N-3）：含双引号/反引号/C0/C1 控制字符时拒绝操作——
 * 这些字符无法安全进入 PowerShell 命令面（Start-Process 引号语义只能承载常规空白）。
 * @param {string} home
 * @returns {{ok: false, error: string}|null}
 */
function unsafeHome(home) {
  if (/[\u0000-\u001f\u007f-\u009f"`]/.test(home)) {
    return { ok: false, error: 'OS_OBSERVE_HOME 含非法字符（双引号/反引号/控制字符）——拒绝提权操作' };
  }
  return null;
}

/** 同步睡眠（Atomics.wait——Node 内置零依赖；提权结果轮询与服务复核宽限用）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 四要素与启用步骤引导（纯只读，无副作用——NFR-tg-supplychain「引导即完整呈现四要素」）。 */
export function sysmonGuide() {
  return {
    ok: true,
    elements: {
      source: SOURCE_URL,
      version: '启用时实测（sysmonPrepare 读取 Sysmon64.exe 文件版本并记账入 provenance.json）',
      verification: 'Get-AuthenticodeSignature 签名链核验（Status=Valid 且签名者含 Microsoft）+ 本地 sha256 记账（os-observe sysmon status 持续对拍，防本地篡改）',
      policy: '未核验不启用：签名核验未过即终止，不写 provenance、不进任何安装步骤',
    },
    steps: [
      '1. node governance-cli.mjs os-observe install（内置 TCP/DNS 缓存采集，若尚未安装）',
      '2. node governance-cli.mjs os-observe sysmon-enable：下载官方 Sysmon.zip（来源见上）',
      '3. 自动解压并核验 Authenticode 签名 + 记账 provenance.json（版本/哈希/签名者/时刻）',
      '4. UAC 弹窗确认后提权执行：Sysmon64 -accepteula -i <仅 DnsQuery(22) 最小配置>（驱动+服务安装，不重启，已装态自动转重配）+ 一次性 Event Log Readers 组授予（日志读授权）',
      '5. 注册采集任务 OsObserve-SysmonPoll（非提权、每 5 分钟读 Sysmon 日志写 raw 样本 kind=dnsq 带进程名）',
      '6. 注销重登（或重启）——Event Log Readers 新组需新登录令牌生效；重登后验证：Resolve-DnsName 任意域名 → os-observe list 出现 source=win-sysmon 条目（Sysmon 服务持续记录，重登后首轮自动回补）',
    ],
  };
}

/**
 * 下载+核验+记账（未核验不落账）。fetchFn/spawnFn/platform/now 注入缝供测试。
 * @returns {Promise<{ok:boolean, provenance?:object, error?:string, availability?:string}>}
 */
export async function sysmonPrepare({ fetchFn = fetch, spawnFn = spawnSync, platform = process.platform, now = Date.now } = {}) {
  if (platform !== 'win32') {
    return { ok: false, availability: 'unavailable', error: '仅 Windows 已实测（不提供未实测命令，ADR-029 决策 5）' };
  }
  const home = osObserveHome();
  const unsafe = unsafeHome(home);
  if (unsafe) return unsafe;
  const dir = join(home, 'sysmon');
  mkdirSync(dir, { recursive: true });
  let res;
  try {
    res = await fetchFn(SOURCE_URL);
  } catch (e) {
    return { ok: false, error: `下载失败（网络异常）：${e?.message ?? e}` };
  }
  if (!res || !res.ok) {
    return { ok: false, error: `下载失败 HTTP ${res?.status ?? '?'}` };
  }
  const zipPath = join(dir, 'Sysmon.zip');
  try {
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    return { ok: false, error: `下载落盘失败：${e?.message ?? e}` };
  }
  // 解压用 PowerShell Expand-Archive：MSYS 环境的 GNU tar 会把盘符路径当远程主机
  // （真机首跑实测 exit 128「Cannot connect to C」——内部任务-SYSMON-1 启用实测发现）
  const unzip = spawnFn('powershell.exe', [
    '-NoProfile', '-Command',
    'Expand-Archive -LiteralPath $env:TG_ZIP_PATH -DestinationPath $env:TG_DEST -Force',
  ], { stdio: 'pipe', env: { ...process.env, TG_ZIP_PATH: zipPath, TG_DEST: dir } });
  if (!unzip || unzip.status !== 0) {
    return { ok: false, error: `解压失败（Expand-Archive exit ${unzip?.status ?? '?'}）：${String(unzip?.stderr ?? '').trim()}` };
  }
  const exe = join(dir, 'Sysmon64.exe');
  if (!existsSync(exe)) {
    return { ok: false, error: '解压后缺 Sysmon64.exe（zip 形态异常）' };
  }
  const probe = spawnFn('powershell.exe', [
    '-NoProfile', '-Command',
    '$s=Get-AuthenticodeSignature -LiteralPath $env:TG_EXE; $i=Get-Item -LiteralPath $env:TG_EXE; @{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject; version=[string]$i.VersionInfo.ProductVersion; sha256=[string](Get-FileHash -LiteralPath $env:TG_EXE -Algorithm SHA256).Hash} | ConvertTo-Json -Compress',
  ], { stdio: 'pipe', env: { ...process.env, TG_EXE: exe } });
  let sig = null;
  try {
    sig = JSON.parse(String(probe?.stdout ?? '').trim());
  } catch {
    /* 解析失败即核验未过 */
  }
  if (!sig || sig.status !== 'Valid' || !String(sig.subject ?? '').includes('Microsoft')) {
    return { ok: false, error: `签名核验未过（status=${sig?.status ?? '未知'}，签名者=${sig?.subject ?? '未知'}）——未记账未启用` };
  }
  const provenance = {
    schemaVersion: 1,
    sourceUrl: SOURCE_URL,
    version: String(sig.version ?? ''),
    sha256Sysmon64: String(sig.sha256 ?? '').toLowerCase(),
    signatureSubject: String(sig.subject ?? ''),
    verifiedAt: new Date((typeof now === 'function' ? now() : now)).toISOString(),
  };
  writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return { ok: true, provenance };
}

/**
 * 启用：先 prepare（核验+记账），再部署三件并以 UAC 提权执行安装脚本；退出码透传。
 * @returns {Promise<{ok:boolean, task?:string, note?:string, error?:string, availability?:string, needInstall?:boolean}>}
 */
export async function sysmonEnable({ fetchFn, spawnFn = spawnSync, platform = process.platform, pollIntervalMs = 1000, resultTimeoutMs = 180_000 } = {}) {
  if (platform !== 'win32') {
    return { ok: false, availability: 'unavailable', error: '仅 Windows 已实测' };
  }
  // 启动包装在场守卫（内部任务-OSOBWIN-1）：任务 /TR 经 collect.vbs 包装拉起，缺包装时注册出永远
  // 失败的任务属写面哑巴故障——失败可见：显式报错并指回 install（先于 prepare，下载/提权零浪费）。
  // needInstall 对齐 dnsEnable 先例（tcpdump 缺席同款「先装再启用」前置缺失，刻意退 1）。
  const unsafe = unsafeHome(osObserveHome());
  if (unsafe) return unsafe;
  if (!existsSync(join(osObserveHome(), 'bin', 'collect.vbs'))) {
    return { ok: false, needInstall: true, error: '缺启动包装 collect.vbs——先跑 os-observe install（部署内置采集器与包装）再 sysmon-enable' };
  }
  const prep = await sysmonPrepare({ fetchFn, spawnFn, platform });
  if (!prep.ok) return prep;
  const home = osObserveHome();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(SHIPPED.collector, join(bin, 'collect-sysmon.ps1'));
  copyFileSync(SHIPPED.config, join(bin, 'sysmon-config.xml'));
  copyFileSync(SHIPPED.elevated, join(bin, 'sysmon-install-elevated.ps1'));
  const elevatedPs1 = join(bin, 'sysmon-install-elevated.ps1');
  // UAC：用户在弹窗确认。Start-Process -Wait/-PassThru 的退出码对提权子进程不可靠
  // （真机实测 ExitCode 空 → exit $null=0 假成功，内部任务-SYSMON-1 启用实测发现）——
  // 确定性通道=提权脚本各出口先写 elevated-result.txt，本侧轮询结果文件（缺省 180s）。
  // 路径显式传参（-SysmonDir/-BinDir）：UAC 输入其他管理员凭据时提权侧 USERPROFILE 是
  // 他人的，凭参数而非环境变量定位部署件与结果文件（delta 评审发现 8）；-File 元素自带
  // 双引号：WinPS 5.1 的 Start-Process 不给含空格元素加引号（delta 评审发现 5）。
  const sysmonDir = join(home, 'sysmon');
  const resultFile = join(sysmonDir, 'elevated-result.txt');
  try { unlinkSync(resultFile); } catch { /* 无旧结果即忽略 */ }
  const up = spawnFn('powershell.exe', [
    '-NoProfile', '-Command',
    'Start-Process powershell -Verb RunAs -ArgumentList @(\'-NoProfile\',\'-ExecutionPolicy\',\'Bypass\',\'-WindowStyle\',\'Hidden\',\'-File\',(\'"\' + $env:TG_ELEV_PS1 + \'"\'),\'-SysmonDir\',(\'"\' + $env:TG_SYSMON_DIR + \'"\'),\'-BinDir\',(\'"\' + $env:TG_BIN_DIR + \'"\'))',
  ], { stdio: 'pipe', env: { ...process.env, TG_ELEV_PS1: elevatedPs1, TG_SYSMON_DIR: sysmonDir, TG_BIN_DIR: bin } });
  if (!up || up.status !== 0) {
    return { ok: false, error: `提权启动失败（exit ${up?.status ?? '?'}——UAC 被取消或 Start-Process 异常）：${String(up?.stderr ?? '').trim()}` };
  }
  const deadline = Date.now() + resultTimeoutMs;
  let code = null;
  while (Date.now() < deadline) {
    sleepSync(pollIntervalMs);
    try {
      const n = parseInt(String(readFileSync(resultFile, 'utf8')).trim(), 10);
      code = Number.isFinite(n) ? n : null; // 垃圾内容（写一半截断）归回 null → 超时口径（delta 评审发现 7）
      if (code !== null) break;
    } catch { /* 结果未落，继续轮询 */ }
  }
  if (code === null) {
    return { ok: false, error: `提权结果超时（${Math.round(resultTimeoutMs / 1000)}s 未见 elevated-result.txt——UAC 弹窗未确认或提权脚本未运行；可重跑 sysmon-enable）` };
  }
  if (code !== 0) {
    return { ok: false, error: `提权安装退出码 ${code}（10=驱动安装失败，12=部署件缺失，14=日志读授权失败）——安装面未完成，可重跑 sysmon-enable` };
  }
  // 采集任务在本侧非提权注册（与内置 OsObserve-NetDnsPoll 同形态）：本机终端策略会在
  // ~0.5s 内禁用一切由提权上下文注册的计划任务（真机实证 2026-09-20：Enable 后被翻回
  // Disabled，schtasks HIGHEST/Register HIGHEST/Register S4U 三形态同结局；非提权注册
  // 的任务存活）。读取权限经 Event Log Readers 组授予（提权步），新组须新登录令牌生效
  // ——note 提示注销重登后采集生效（Sysmon 服务持续记日志，游标机制重登后首轮回补）。
  // 内部任务-OSOBWIN-1：/TR 同 wscript 包装形态（collect.vbs + 尾部裸参），缺包装时入口守卫显式报错。
  const tr2 = `wscript.exe //nologo "${join(home, 'bin', 'collect.vbs')}" collect-sysmon.ps1`;
  const create = spawnFn('schtasks', ['/Create', '/TN', SYSMON_TASK_NAME, '/SC', 'MINUTE', '/MO', '5', '/TR', tr2, '/F'], { stdio: 'pipe' });
  if (!create || create.status !== 0) {
    return { ok: false, error: `采集任务注册失败（schtasks exit ${create?.status ?? '?'}）：${String(create?.stderr ?? '').trim()}` };
  }
  // 复核：复用同文件 sysmonStatus 探针（阶段门简洁性处置），服务注册留 3s×3 宽限
  let st = sysmonStatus({ spawnFn, platform });
  for (let i = 0; i < 3 && (!st.service || !st.task); i += 1) {
    sleepSync(3000);
    st = sysmonStatus({ spawnFn, platform });
  }
  if (!st.service || !st.task) {
    return { ok: false, error: `提权步骤完成但复核失败：Sysmon64 服务=${st.service ? '就绪' : '未就绪'}、采集任务=${st.task ? '在册' : '不在册'}（os-observe status 查看）` };
  }
  return {
    ok: true,
    task: SYSMON_TASK_NAME,
    note: `Sysmon 已装（仅 DnsQuery(22) 最小面，驱动安装经 UAC 确认）；provenance 已记账（${prep.provenance.version} / sha256 ${prep.provenance.sha256Sysmon64.slice(0, 12)}…）；日志读授权=Event Log Readers（一次性）；采集任务 ${SYSMON_TASK_NAME}（每 5 分钟，非提权）已注册——组授权需新登录令牌：注销重登（或重启）后采集生效；Sysmon 服务已持续记录，重登后首轮自动回补`,
  };
}

/** 停用：移除采集计划任务（幂等）；驱动卸载属用户决策面——输出引导不自动执行。 */
export function sysmonDisable({ spawnFn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: false, availability: 'unavailable', error: '仅 Windows 已实测' };
  }
  const r = spawnFn('schtasks', ['/Delete', '/TN', SYSMON_TASK_NAME, '/F'], { stdio: 'pipe' });
  if (!r || (r.status !== 0 && r.status !== 1)) {
    return { ok: false, error: `schtasks /Delete 失败（exit ${r?.status ?? '?'}）：${String(r?.stderr ?? '').trim()}` };
  }
  return {
    ok: true,
    task: SYSMON_TASK_NAME,
    note: r.status === 1
      ? '计划任务本不存在（幂等）；驱动卸载属用户决策面：管理员执行 Sysmon64.exe -u force（或保留驱动停止采集任务即可）'
      : `计划任务 ${SYSMON_TASK_NAME} 已移除；驱动卸载属用户决策面：管理员执行 Sysmon64.exe -u force（或保留驱动停止采集任务即可）`,
  };
}

/**
 * 在装态聚合（只读 fail-open：任何探针失败按 false/null 如实呈现，不抛错）。
 * provenanceMatch=本地 Sysmon64.exe 实算 sha256 与记账一致（任一侧缺失=false）。
 */
export function sysmonStatus({ spawnFn = spawnSync, platform = process.platform } = {}) {
  const state = {
    ok: true,
    platform: platform === 'win32',
    service: false,
    channel: false,
    task: false,
    provenance: null,
    provenanceMatch: false,
  };
  if (platform !== 'win32') return state;
  try {
    // sc query 退出 0 只证在册：RUNNING 判定锚输出中的非本地化状态词（delta 评审发现 3）
    const q = spawnFn('sc', ['query', 'Sysmon64'], { stdio: 'pipe' });
    state.service = q?.status === 0 && /RUNNING/.test(String(q.stdout ?? ''));
  } catch { /* fail-open */ }
  try {
    state.channel = spawnFn('wevtutil', ['gl', SYSMON_LOG_NAME], { stdio: 'pipe' })?.status === 0;
  } catch { /* fail-open */ }
  try {
    state.task = spawnFn('schtasks', ['/Query', '/TN', SYSMON_TASK_NAME], { stdio: 'pipe' })?.status === 0;
  } catch { /* fail-open */ }
  try {
    const p = join(osObserveHome(), 'sysmon', 'provenance.json');
    if (existsSync(p)) state.provenance = JSON.parse(readFileSync(p, 'utf8'));
  } catch { /* 坏账本按 null 呈现 */ }
  try {
    const exe = join(osObserveHome(), 'sysmon', 'Sysmon64.exe');
    if (state.provenance && existsSync(exe)) {
      const local = createHash('sha256').update(readFileSync(exe)).digest('hex');
      state.provenanceMatch = local === String(state.provenance.sha256Sysmon64 ?? '').toLowerCase();
    }
  } catch { /* 对拍失败=false */ }
  return state;
}
