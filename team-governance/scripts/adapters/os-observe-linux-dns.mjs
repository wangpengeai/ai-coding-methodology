// 文件：os-observe-linux-dns.mjs
// 描述：linux-dns-tcpdump 扩展位启用链（内部任务-OBSO-LINUX-1，内部决策-029 决策 6，内部需求-15/17，
//       NFR-tg-supplychain）——dnsGuide（四要素+步骤引导，纯只读；不代装系统包——
//       各发行版命令明示，用户经自己的包管理器安装，用户裁决 2026-09-20）/dnsPrepare
//       （tcpdump 在位探测+版本读取+which 定位+二进制 sha256+包完整性校验（dpkg -V/
//       rpm -V——stdout 有校验输出即未过拒启用（rpm 差异退 1、dpkg 问题退 0 均覆盖）；
//       包管理器缺席/非托管记录）→ provenance.json 记账；未核验不落账不启用）/
//       dnsEnable（记账→部署转换器到 bin/→root 属主载体部署（/var/lib/os-observe-dns：
//       keepalive.sh+dns-spool，uid=0 直写/非 root sudo mkdir/chmod/tee，目录与脚本显式
//       0755——H10 提权链修复 内部未决-215，内部任务-281：root 周期执行面迁出用户可写家目录）→
//       root crontab 保活条目（指向载体）+用户 crontab 转换器条目→双复核（含载体在位））/
//       dnsDisable（非 root 亦先 sudo -v——凭据不可用即失败可见，不假成功；两 crontab
//       条目移除+按 -w 参数特征精确 pkill（新旧两代 spool 各一遍，内部任务-281；exit 1=无实例
//       幂等）+清理家目录旧 keepalive；spool/provenance 不销账）/
//       dnsStatus（进程在跑/root cron/用户 cron/provenance 对拍/spool 新鲜度，只读
//       fail-open——非 root 的 root cron 读取经 sudo -n，凭据未缓存时如实 false，
//       spool 新鲜度为地面真值）。
//       保活条目形态（阶段门 B P1/P7 处置）：flock -n 单实例锁拉起（cron 以 sh -c 整行
//       执行，任何 pgrep -f 模式必被子串自匹配短路——弃用；flock 属 util-linux 系统
//       标配）；tcpdump 用 provenance.binaryPath 绝对路径（cron 最小 PATH 常不含
//       /usr/sbin）；crontab 的 % 是特殊字符，strftime %s 须写 %%s。进程探针/pkill 按
//       运行期 -w 参数字面值 <spool>/dns-%s.pcap 匹配（CLI 侧调用无 sh -c 父进程，
//       不会自匹配；tail 等查看进程不含该字面值）。
//       旧 pcap 裁剪（内部未决-36，2026-09-21 受控实证）：tcpdump 的 -W 计数是进程内状态、
//       与 -G 联用=创建满 N 个轮转文件即退 0、重启进程不计数旧文件——cron 每 5 分钟重拉
//       一次，旧 pcap 跨重拉无界累积；keepalive 每 tick 先保最新 24 个再拉起（目录引号
//       内不带 glob，引号内不展开）。
//       平台专有名仅存本文件与 adapters/os-observe/ 采样面（内部接口-1 §3）。
//       spawnFn/platform/uid/now/nodePath 注入缝供测试。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { osObserveHome } from '../lib/os-observe-store.mjs';
import { ensureNl, filterCronBlock, LINUX_POLL_SET, readCrontab, shQuote, writeCrontab, writeFailWhy } from '../lib/os-observe-cron.mjs';

export const DNS_ROOT_MARKER = '# os-observe:linux-dns-keepalive';
export const DNS_USER_MARKER = '# os-observe:linux-dns-convert';
const SHIPPED_CONVERTER = fileURLToPath(new URL('./os-observe/collect-linux-dns.mjs', import.meta.url));

function currentUid(uid) {
  if (typeof uid === 'number') return uid;
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

/** 旧代（H10 迁移前，2026-11-02 内部任务-281 之前）家目录 spool——disable 双 pkill 兼容扫用。 */
function spoolDirOf(home) {
  return join(home, 'dns-spool');
}

/** root 属主载体根（注入缝 OS_OBSERVE_DNS_ROOT——测试 tmp 隔离；缺省 /var/lib/os-observe-dns）。
 *  H10（内部未决-215，2026-11-02 内部任务-281）：root 周期执行面迁出用户可写家目录——用户对家目录父链有
 *  改名权，家目录内任何路径（含 chown root 的文件）都可经父目录改名换内容被 root 执行；root 属主
 *  链必须到根。keepalive.sh/dns-spool/capture.lock 同置本目录（root:root 0755、pcap 0644 用户
 *  只读——转换器非提权读 spool）。缺省值与 collect-linux-dns.mjs 的 DNS_ROOT 字面同改：两处
 *  字面量无机械锚定（测试全经 OS_OBSERVE_DNS_ROOT 注入），改动须双查（round1 E4 口径）。 */
function dnsRootDir() {
  return process.env.OS_OBSERVE_DNS_ROOT || '/var/lib/os-observe-dns';
}

/** 旧 keepalive 清理（H10 迁移，内部任务-281）：家目录 bin/ 旧脚本已无 cron 引用——移除防误执行；
 *  best-effort（失败不阻断：文件已无引用）。enable/disable 两处共用（三维简洁性 4）。 */
function removeLegacyKeepalive(home) {
  try { rmSync(join(home, 'bin', 'dns-keepalive.sh'), { force: true }); } catch { /* 尽力而为 */ }
}

/** 四要素与启用步骤引导（纯只读，无副作用——NFR-tg-supplychain「引导即完整呈现四要素」+不代装裁决）。 */
export function dnsGuide() {
  return {
    ok: true,
    elements: {
      source: '发行版包管理器（插件不代装系统包——用户裁决 2026-09-20）。本机开发环境已实测 tcpdump 4.99.1；未装时经你的包管理器安装：Debian/Ubuntu：sudo apt install tcpdump；RHEL 系：sudo dnf install tcpdump；Arch：sudo pacman -S tcpdump；openSUSE：sudo zypper install tcpdump',
      version: '启用时实测（dnsPrepare 读 tcpdump --version 记账入 ~/.zcode/os-observe/dns/provenance.json）',
      verification: 'tcpdump 二进制 sha256 记账 + 包完整性校验（dpkg -V tcpdump / rpm -V tcpdump——有输出即未过拒启用；包管理器缺席记 skipped-no-pm）+ 解析路径在册绑定（dpkg -L / rpm -ql 清单内才启用——防 PATH 前置植入伪品被 root 载体烘入，H10 半面 DEV-281）+ os-observe status 的 dns 段持续对拍（防本地篡改）',
      policy: '未核验不启用：tcpdump 缺席/记账失败/包校验未过即终止，不写任何 crontab；不代装系统包',
    },
    steps: [
      '1. node governance-cli.mjs os-observe install（Linux：用户 crontab TCP 采集，若尚未安装）',
      '2. 安装 tcpdump（若未装，见来源——经你自己的包管理器；插件不代装）',
      '3. node governance-cli.mjs os-observe dns-enable：sudo 密码一次（已 root 免）→ 包校验+sha256 记账 → root crontab 保活（tcpdump port 53 常驻监听，5 分钟轮转保留 24 个 pcap=2 小时窗）+ 用户 crontab 转换器（每 5 分钟解析问题节出 kind=dnsq 样本）',
      '4. ≤5 分钟内首轮 pcap 落 spool、转换器出样本 → os-observe list 出现 source=linux-dns-tcpdump 条目（DoT/DoH（853/443 加密 DNS）不可见——已登记限制）',
      '5. node governance-cli.mjs os-observe status 的 dns 段复核：进程在跑/条目在册/provenance 对拍',
    ],
  };
}

/** spawn 包装：异常（ENOENT 等）归一为 null（不抛——缺席即探测未过）。 */
function safeSpawn(spawnFn, cmd, args) {
  try {
    const r = spawnFn(cmd, args, { stdio: 'pipe' });
    return r && r.error ? null : r;
  } catch {
    return null;
  }
}

/** sudo 部署单步（内部任务-337 内部未决-252① 样板收敛）：spawn→非 0/归 null 判定→统一幂等尾注失败对象；
 *  失败返回 {ok:false,error}、成功返回 null。tee 步经 input 注入走裸 spawnFn（stdio pipe——
 *  safeSpawn 化会吞注入桩异常＝行为变更，不合并）；why 为静态串或 (r)=>动态文案前缀。 */
function sudoDeployStep(spawnFn, args, why, { input } = {}) {
  const r = input === undefined
    ? safeSpawn(spawnFn, 'sudo', ['-n', ...args])
    : spawnFn('sudo', ['-n', ...args], { stdio: 'pipe', input });
  if (!r || r.status !== 0) {
    return { ok: false, error: `${typeof why === 'function' ? why(r) : why}——可重跑 dns-enable（幂等）` };
  }
  return null;
}

/**
 * 核验+记账（未核验不落账）。spawnFn/platform/now/uid 注入缝供测试。
 * @returns {{ok:boolean, provenance?:object, needInstall?:boolean, availability?:string, error?:string}}
 */
export function dnsPrepare({ spawnFn = spawnSync, platform = process.platform, now = Date.now } = {}) {
  if (platform !== 'linux') {
    return { ok: false, availability: 'unavailable', error: '仅 Linux 已实测（不提供未实测命令，ADR-029 决策 5）' };
  }
  const ver = safeSpawn(spawnFn, 'tcpdump', ['--version']);
  if (!ver || ver.status !== 0) {
    return { ok: false, needInstall: true, error: 'tcpdump 不可用（未安装或不可执行）——请先经发行版包管理器安装（os-observe dns-guide 给命令；插件不代装系统包）' };
  }
  const vm = /tcpdump version (\S+)/.exec(String(ver.stdout ?? ''));
  const which = safeSpawn(spawnFn, 'which', ['tcpdump']);
  const binPath = String(which?.stdout ?? '').trim();
  if (!vm || !binPath || which?.status !== 0) {
    return { ok: false, error: 'tcpdump 版本或二进制路径不可解析（--version/which 输出形态异常）——未记账不启用' };
  }
  let sha256 = null;
  try { sha256 = createHash('sha256').update(readFileSync(binPath)).digest('hex'); } catch { /* 读不到即未过 */ }
  if (!sha256) return { ok: false, error: `tcpdump 二进制不可读（${binPath}）——未记账不启用` };
  // 包完整性（尽力而为）：dpkg -V / rpm -V——stdout 有校验输出=包被改动拒启用（rpm 差异
  // 退 1、dpkg 问题行退 0，两种形态均按输出判）；包管理器缺席=skipped；在装但非零退出且
  // 无输出=非托管记录（哈希记账仍是强锚）
  let packageCheck = 'skipped-no-pm';
  let hitPm = null; // 结构化命中值（省 packageCheck 字符串反解——三维简洁性 2）
  for (const pm of ['dpkg', 'rpm']) {
    const r = safeSpawn(spawnFn, pm, ['-V', 'tcpdump']);
    if (!r || (r.error ?? r.status === null)) continue; // 该包管理器缺席（ENOENT）——试下一个
    if (String(r.stdout ?? '').trim()) {
      return { ok: false, error: `包完整性校验未过（${pm} -V 有输出：${String(r.stdout ?? '').trim().split('\n')[0]}）——未记账不启用` };
    }
    hitPm = pm;
    if (r.status === 0) { packageCheck = `${pm}-clean`; break; }
    packageCheck = `${pm}-unmanaged`;
    break;
  }
  // H10 半面闭合（内部未决-215 阶段门 A 发现 1，2026-11-02 内部任务-281）：which 按启用用户 PATH 解析，
  // 用户可写目录居前时（主流发行版 .profile 常前置 ~/bin、~/.local/bin）植入的伪 tcpdump 会被
  // 烘进 root 属主载体——sha256 记账对伪品自洽、dpkg -V/rpm -V 校验对象是包库副本，原判据均不
  // 绑定解析路径。绑定判据：包管理器在场＝解析路径必须在其在册文件清单内（dpkg -L/rpm -ql）；
  // 两者均缺席＝退属主弱锚（二进制属 root 且不在启用用户家目录内，随 skipped-no-pm 语义记录）。
  if (hitPm) {
    const ls = safeSpawn(spawnFn, hitPm, hitPm === 'dpkg' ? ['-L', 'tcpdump'] : ['-ql', 'tcpdump']);
    const registered = String(ls?.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!ls || ls.status !== 0 || !registered.includes(binPath)) {
      return { ok: false, error: `tcpdump 解析路径不在包管理器在册清单内（${hitPm}：${binPath}）——疑似 PATH 前置植入（H10 半面，OPEN-215 阶段门 A），未记账不启用` };
    }
  } else {
    const st = statSync(binPath);
    if (st.uid !== 0 || binPath.startsWith(homedir())) {
      return { ok: false, error: `包管理器缺席且 tcpdump 解析路径属主弱锚不过（uid=${st.uid}、家目录内=${binPath.startsWith(homedir())}）——未记账不启用（修正 PATH 或经包管理器安装）` };
    }
  }
  const provenance = {
    schemaVersion: 1,
    tool: 'tcpdump',
    version: String(vm[1]),
    binaryPath: binPath,
    sha256Tcpdump: sha256,
    packageCheck,
    verifiedAt: new Date((typeof now === 'function' ? now() : now)).toISOString(),
  };
  const home = osObserveHome();
  mkdirSync(join(home, 'dns'), { recursive: true });
  writeFileSync(join(home, 'dns', 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return { ok: true, provenance };
}

/** root 面 argv0（已 root 直跑；否则 sudo -n）。 */
function rootArgv0(uid) {
  return uid === 0 ? ['crontab'] : ['sudo', '-n', 'crontab'];
}

/**
 * 启用：prepare（核验+记账）→部署转换器+建 spool→写 crontab（root 保活/用户转换）→双复核。
 * 保活条目=flock -n 单实例锁拉起绝对路径 tcpdump（阶段门 B P1/P7 处置，见头注）。
 * @returns {{ok:boolean, note?:string, availability?:string, needInstall?:boolean, usage?:boolean, error?:string}}
 */
export function dnsEnable({ spawnFn = spawnSync, platform = process.platform, uid = null, now = Date.now, pollMinutes = 5, nodePath = process.execPath } = {}) {
  const myUid = currentUid(uid);
  if (platform !== 'linux') {
    return { ok: false, availability: 'unavailable', error: '仅 Linux 已实测（不提供未实测命令，ADR-029 决策 5）' };
  }
  if (!LINUX_POLL_SET.includes(pollMinutes)) {
    return { ok: false, usage: true, error: `pollMinutes 限 60 的因子集（收到 ${pollMinutes}；候选：${LINUX_POLL_SET.join('/')}）——cron 分钟字段表达力边界，与 install 同口径` };
  }
  const prep = dnsPrepare({ spawnFn, platform, now });
  if (!prep.ok) return prep;
  const home = osObserveHome();
  const dnsRoot = dnsRootDir();
  const spool = join(dnsRoot, 'dns-spool'); // H10：spool 随 root 执行面迁 root 属主目录
  const bin = join(home, 'bin');            // 用户态部署面：转换器（非提权）仍在家目录
  mkdirSync(bin, { recursive: true });
  copyFileSync(SHIPPED_CONVERTER, join(bin, 'collect-linux-dns.mjs'));
  // 凭据缓存：非 root 先 sudo -v（交互一次；失败即终止——后续 sudo -n 全靠它）
  if (myUid !== 0) {
    const v = safeSpawn(spawnFn, 'sudo', ['-v']);
    if (!v || v.status !== 0) {
      return { ok: false, error: 'sudo 凭据验证失败（sudo -v）——无法写 root crontab，可重跑 dns-enable' };
    }
  }
  const rootArgv = rootArgv0(myUid);
  const userArgv = ['crontab'];
  const base = readCrontab({ spawnFn, argv0: userArgv }); // uid=0 时 root 面与用户面同表——单读单写
  if (!base.ok) {
    return { ok: false, error: `crontab 读取失败（user=${base.ok}${myUid === 0 ? '（root 同表）' : ''}）——可重跑 dns-enable` };
  }
  // 保活载体=root 属主固定路径（H10 修复，见 dnsRootDir 注）。脚本体语义不变：flock -n 单实例
  // 锁（cron 以 sh -c 整行执行，pgrep -f 必自匹配短路——弃用，阶段门 B P1；本机 crond 不支持
  // %% 转义——strftime 的 %s 只能存于脚本内，cron 行零 % 字符）+ 记账绝对路径 tcpdump（cron
  // 最小 PATH 常不含 /usr/sbin）+ -Z root 禁写盘降权（root spool 0755 下 tcpdump 降权用户不可
  // 写——防御性默认仍需禁降权）+ 内部未决-36 裁剪行（头注）；轮转保留窗宽 ROTATE_KEEP。
  const ROTATE_KEEP = 24;
  const keepaliveScript = [
    '#!/bin/sh',
    `# os-observe linux-dns-tcpdump keepalive (TASK-OBSO-LINUX-1；由 dns-enable 生成——重启用 dns-enable 勿手改)`,
    `# 载体属 root（OPEN-215/H10，2026-11-02 DEV-281）：本脚本与 spool 归 root:root、用户不可写——`,
    `# root 周期执行面不落用户可写路径树（迁移前家目录载体＝本地提权链，已废止）。`,
    `# 旧 pcap 裁剪（OPEN-36 实证 2026-09-21：tcpdump -W+-G 创建满 N 个即退 0、重启不计数`,
    `# 旧文件，每 tick 保最新 ${ROTATE_KEEP} 个再拉起——目录引号内不带 glob，引号内不展开；`,
    `# xargs -d '\\n'：spool 路径含空格时按整行切分，防分词致裁剪静默空转——阶段门 C1）：`,
    `ls -t ${shQuote(spool)}/dns-*.pcap 2>/dev/null | tail -n +${ROTATE_KEEP + 1} | xargs -r -d '\\n' rm -f --`,
    `exec flock -n ${shQuote(join(spool, 'capture.lock'))} ${shQuote(prep.provenance.binaryPath)} -Z root -i any -n -U -G 300 -W ${ROTATE_KEEP} -w ${shQuote(`${spool}/dns-%s.pcap`)} port 53`,
    '',
  ].join('\n');
  // 载体部署：uid=0 直写（root 建物恒 root 属主；目录与脚本显式 chmod 0755 防御 umask——mkdir
  // 模式位受 umask 掩码，round1 E1）；非 root 经 sudo -n（mkdir/chmod/tee/chmod——sudo 建物恒
  // root 属主；tee stdin 通道与 writeCrontab 同形态。sudo/mkdir/chmod/tee 均通用工具，不入
  // 内部接口-1 §4 词表——「sudo/pgrep 等通用工具不入表」同口径）
  const keepalivePath = join(dnsRoot, 'keepalive.sh');
  if (myUid === 0) {
    mkdirSync(spool, { recursive: true }); // 递归建链含 dnsRoot（单调用即够——三维简洁性 1）
    chmodSync(dnsRoot, 0o755);
    chmodSync(spool, 0o755);
    writeFileSync(keepalivePath, keepaliveScript, 'utf8');
    chmodSync(keepalivePath, 0o755);
  } else {
    const mk = sudoDeployStep(spawnFn, ['mkdir', '-p', dnsRoot, spool], (r) => `root 载体目录创建失败（sudo mkdir ${dnsRoot}）：${String(r?.stderr ?? '').trim()}`);
    if (mk) return mk;
    const cm = sudoDeployStep(spawnFn, ['chmod', '755', dnsRoot, spool], 'root 载体目录权限设置失败（sudo chmod 755）');
    if (cm) return cm;
    const tee = sudoDeployStep(spawnFn, ['tee', keepalivePath], (r) => `keepalive 部署失败（sudo tee）${writeFailWhy(r)}`, { input: keepaliveScript });
    if (tee) return tee;
    const ck = sudoDeployStep(spawnFn, ['chmod', '755', keepalivePath], 'keepalive 权限设置失败（sudo chmod 755）');
    if (ck) return ck;
  }
  const rootBlock = `${DNS_ROOT_MARKER}\n*/5 * * * * ${shQuote(keepalivePath)} >/dev/null 2>&1\n`;
  const userBlock = `${DNS_USER_MARKER}\n*/${pollMinutes} * * * * ${shQuote(nodePath)} ${shQuote(join(bin, 'collect-linux-dns.mjs'))} >/dev/null 2>&1\n`;
  // uid=0：两块合并单次写（同表两次 read-filter-write 会互相覆盖——阶段 3 测试实测）；
  // 非 root：root 面经 sudo -n 单独一表
  const stripped = filterCronBlock(filterCronBlock(base.text, DNS_ROOT_MARKER), DNS_USER_MARKER);
  const rootRead = myUid === 0 ? base : readCrontab({ spawnFn, argv0: rootArgv });
  if (!rootRead.ok) {
    return { ok: false, error: 'crontab 读取失败（root=0）——可重跑 dns-enable' };
  }
  const ops = myUid === 0
    ? [[userArgv, `${ensureNl(stripped)}${rootBlock}${userBlock}`]]
    : [
        [rootArgv, `${ensureNl(filterCronBlock(rootRead.text, DNS_ROOT_MARKER))}${rootBlock}`],
        [userArgv, `${ensureNl(filterCronBlock(base.text, DNS_USER_MARKER))}${userBlock}`],
      ];
  for (const [argv, text] of ops) {
    const w = writeCrontab({ spawnFn, argv0: argv, text });
    if (!w || w.status !== 0) {
      return { ok: false, error: `crontab 写入失败${writeFailWhy(w)}——条目未齐，可重跑 dns-enable（幂等）` };
    }
  }
  // 双复核：两 marker 均须在场（uid=0 单表一次读；否则两面各查）＋载体在位可执行（属主由部署
  // 机制保证——uid=0 直写/sudo 建物恒 root；测试桩以普通用户落盘，故只断言存在＋可执行位）
  const chkUser = readCrontab({ spawnFn, argv0: userArgv });
  const userOk = chkUser.ok && chkUser.text.includes(DNS_USER_MARKER) && (myUid === 0 ? chkUser.text.includes(DNS_ROOT_MARKER) : true);
  const rootOk = myUid === 0 ? true : (() => {
    const c = readCrontab({ spawnFn, argv0: rootArgv });
    return c.ok && c.text.includes(DNS_ROOT_MARKER);
  })();
  let carrierOk = false;
  try { carrierOk = (statSync(keepalivePath).mode & 0o111) !== 0; } catch { carrierOk = false; }
  if (!userOk || !rootOk || !carrierOk) {
    return { ok: false, error: `复核未过（crontab 标记锚=${userOk && rootOk}；root 载体 ${keepalivePath} 可执行=${carrierOk}）——可重跑 dns-enable（幂等）` };
  }
  // 旧载体清理（H10 迁移）：家目录 bin/ 旧 keepalive 已无 cron 引用——移除防误执行；旧 spool 数据
  // 保留（不销账语义不变；旧 pcap 不迁移，观测连续性由新载体采集承接）
  removeLegacyKeepalive(home);
  return {
    ok: true,
    note: `linux-dns-tcpdump 已启用：root crontab 保活（root 属主载体 ${keepalivePath} 拉起 ${prep.provenance.binaryPath} -i any port 53，5 分钟轮转保留 24 个 pcap=2 小时窗，spool=${spool}）+ 用户 crontab 转换器（每 ${pollMinutes} 分钟解析 DNS 问题节出 kind='dnsq' 样本）；provenance 已记账（${prep.provenance.version} / sha256 ${prep.provenance.sha256Tcpdump.slice(0, 12)}… / 包校验 ${prep.provenance.packageCheck}）；≤${pollMinutes} 分钟内首轮样本落 raw（os-observe status 的 dns 段复核）；停止=dns-disable（spool/provenance 不销账）`,
  };
}

/** 停用：移除两 crontab 标记块 + 按 -w 参数特征精确 pkill（幂等）；spool/provenance 保留。
 *  非 root 亦先 sudo -v——凭据不可用即失败可见（root 面条目留存时不得假成功，阶段门 B P2）。 */
export function dnsDisable({ spawnFn = spawnSync, platform = process.platform, uid = null } = {}) {
  const myUid = currentUid(uid);
  if (platform !== 'linux') {
    return { ok: false, availability: 'unavailable', error: '仅 Linux 已实测（不提供未实测命令，ADR-029 决策 5）' };
  }
  if (myUid !== 0) {
    const v = safeSpawn(spawnFn, 'sudo', ['-v']);
    if (!v || v.status !== 0) {
      return { ok: false, error: 'sudo 凭据验证失败（sudo -v）——无法移除 root crontab 条目/停 root 监听进程，可重跑 dns-disable（root 条目仍在，勿视作已停）' };
    }
  }
  const home = osObserveHome();
  const rootArgv = rootArgv0(myUid);
  const userArgv = ['crontab'];
  for (const [argv, marker] of [[rootArgv, DNS_ROOT_MARKER], [userArgv, DNS_USER_MARKER]]) {
    const read = readCrontab({ spawnFn, argv0: argv });
    if (!read.ok) continue; // 无表/不可读=幂等已移除（sudo -v 已过——不可读非凭据问题）
    const next = filterCronBlock(read.text, marker);
    if (String(next).trim() === String(read.text).trim()) continue; // 无标记块
    const w = writeCrontab({ spawnFn, argv0: argv, text: next });
    if (!w || w.status !== 0) {
      return { ok: false, error: `crontab 写入失败${writeFailWhy(w)}——可重跑 dns-disable（幂等）` };
    }
  }
  // 停监听进程：按运行期 -w 参数字面值匹配，新旧两代 spool 各查一遍（H10 迁移期旧进程可能仍持家
  // 目录 spool 字面值，内部任务-281；新代持 root 属主 spool）。exit 0=命中、1=无实例（幂等）；spawn
  // 失败（pkill 缺席）与 sudo 包装下 command-not-found（sudo 退 1 但 stderr 有 not found——与
  // 「无实例」同码位不同因）一律失败可见，不静默假成功（收尾评审正确性 1 处置）
  for (const sp of [join(dnsRootDir(), 'dns-spool'), spoolDirOf(home)]) {
    const pkillArgv = myUid === 0 ? ['pkill', ['-f', `${sp}/dns-%s.pcap`]] : ['sudo', ['-n', 'pkill', '-f', `${sp}/dns-%s.pcap`]];
    const pk = safeSpawn(spawnFn, pkillArgv[0], pkillArgv[1]);
    const pkMissing = /not found/i.test(String(pk?.stderr ?? ''));
    if (!pk || (pk.status !== 0 && pk.status !== 1) || (pk.status === 1 && pkMissing)) {
      return { ok: false, error: `pkill 失败（${sp}：${pk ? `exit ${pk.status}` : 'pkill 不可执行'}）：${String(pk?.stderr ?? '').trim()}——监听进程可能未停，可重跑 dns-disable（root 条目已移除）` };
    }
  }
  // 旧载体清理：家目录 bin/ 旧 keepalive（已无 cron 引用）移除；两代 spool/provenance 均保留（不销账）
  removeLegacyKeepalive(home);
  return {
    ok: true,
    note: 'DNS 采集条目已移除、监听进程已停（幂等，新旧两代 spool 均查）；spool/provenance 保留（不销账）；重启用 dns-enable',
  };
}

/** 在装态聚合（只读 fail-open：任何探针失败按 false/null 如实呈现，不抛错）。 */
export function dnsStatus({ spawnFn = spawnSync, platform = process.platform, uid = null } = {}) {
  const myUid = currentUid(uid);
  const state = {
    ok: true,
    platform: platform === 'linux',
    process: false,
    rootCron: false,
    userCron: false,
    provenance: null,
    provenanceMatch: false,
    spool: { files: 0, newestTsMs: 0 },
  };
  if (platform !== 'linux') return state;
  const home = osObserveHome();
  const spool = join(dnsRootDir(), 'dns-spool'); // 新代 spool（H10 迁移后，内部任务-281）
  const legacySpool = spoolDirOf(home);          // 旧代 spool（迁移前部署的在册进程特征）
  // 探针逐条自带失败语义（safeSpawn 全吞异常归 null、读侧内层 catch）——无外层 try 必要
  //（收尾评审简洁性 4 处置：删两层证明不可达的包裹）
  state.process = safeSpawn(spawnFn, 'pgrep', ['-f', `${spool}/dns-%s.pcap`])?.status === 0
    || safeSpawn(spawnFn, 'pgrep', ['-f', `${legacySpool}/dns-%s.pcap`])?.status === 0;
  try {
    const rc = readCrontab({ spawnFn, argv0: rootArgv0(myUid) });
    state.rootCron = rc.ok && rc.text.includes(DNS_ROOT_MARKER);
  } catch { /* fail-open */ }
  try {
    const uc = readCrontab({ spawnFn, argv0: ['crontab'] });
    state.userCron = uc.ok && uc.text.includes(DNS_USER_MARKER);
  } catch { /* fail-open */ }
  try {
    const p = join(home, 'dns', 'provenance.json');
    if (existsSync(p)) state.provenance = JSON.parse(readFileSync(p, 'utf8'));
  } catch { /* 坏账本按 null 呈现 */ }
  try {
    if (state.provenance && typeof state.provenance.binaryPath === 'string' && existsSync(state.provenance.binaryPath)) {
      const local = createHash('sha256').update(readFileSync(state.provenance.binaryPath)).digest('hex');
      state.provenanceMatch = local === String(state.provenance.sha256Tcpdump ?? '').toLowerCase();
    }
  } catch { /* 对拍失败=false */ }
  let files = [];
  try { files = readdirSync(spool).filter((f) => f.endsWith('.pcap')); } catch { /* spool 缺席=0 */ }
  state.spool.files = files.length;
  for (const f of files) {
    try {
      const st = statSync(join(spool, f));
      if (st.mtimeMs > state.spool.newestTsMs) state.spool.newestTsMs = st.mtimeMs;
    } catch { /* 竞态容忍 */ }
  }
  return state;
}
