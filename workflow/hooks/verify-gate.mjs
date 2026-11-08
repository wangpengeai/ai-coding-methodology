// 文件：verify-gate.mjs
// 描述：Stop 事件声明式完成闸（内部规则-3 / 内部决策-2 / T-M8-2 / T-M8-3）——项目根声明文件
//       verify.gate 列出的验证命令全部通过，本轮（turn）才允许结束；任一命令失败、
//       或声明内容与信任存储记录的 sha256 不符（篡改）时阻断并说明原因。
//       内部未决-14 批次（2026-09-15）：自 verify-gate.sh 等价移植为 Node——宿主 spawn
//       环境解析不到 bash 使 bash 版装机态 100% 空转；语义（归一化命令流哈希/信任
//       首录/文案）逐字保留，等价性由 verify-gate.test.mjs golden 哈希常量与双跑
//       对拍锁定。GNU timeout 探测段整体删除——spawnSync 内置 timeout 跨平台恒
//       可用（移植净收益）；声明命令执行 shell 改四级探测（见 resolveGateShell）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 来源致谢：概念借鉴 gstack MIT © Garry Tan，自写实现（未复制其文本）
//
// 使用说明（如何在项目启用完成闸）：
//   1. 在项目根创建 verify.gate，每行一条验证命令（探得 bash 的机器按 bash -c
//      执行，兜底按系统 shell 执行；工作目录=项目根）：
//        # 井号开头的整行是注释，空行忽略
//        npm test
//        npm run lint
//   2. 无需注册或配置：声明内容合法且**首次出现**时，本闸把其 sha256 基线记录到
//      用户级信任存储 <homedir>/.zcode/verify-gate-trust/<项目根摘要>.sha256（脱离
//      项目分发面，仓库无法预置伪造信任），**本次不执行命令**、阻断一拍提示人工核对
//      声明内容；下一次 Stop 起按基线比对防篡改（2026-09-19 评审修复 B13 语义）。
//   3. 变更声明内容会触发阻断（视为声明失效，须重新确认，T-M8-3）：确认变更无误
//      后删除上述**用户级**信任文件（不是项目根文件），下次运行按当前内容重新首录
//      （首录当次仍不执行）。项目根 .verify-gate.trust 为旧版遗留——一律不采信，可
//      安全删除。
//   4. 停用：删除 verify.gate 即可。未声明项目零影响（内部规则-4 / B-M8-2）。
//   5. 单条命令超时：默认 20 秒，环境变量 VERIFY_GATE_CMD_TIMEOUT 覆盖（内置
//      timeout 恒可用，无需 GNU coreutils）。
//
// 输出协议：阻断时 stdout 输出 JSON——严格 schema，仅
//   hookSpecificOutput{hookEventName,additionalContext}，不新增键；同时 stderr 给
//   人类可读一行供宿主日志。退出码：0=放行（放行路径一律静默）2=阻断。
//   脚本自身异常（shell 探测失败、读写失败等非声明逻辑故障）→ 静默退出 0（内部规则-4
//   fail-open，勿"修正"此姿态——环境故障不被放大成对宿主的误阻断）。
//
// 用法：stdin 喂负载（tty 手动运行跳过读取）；--selftest 内置自检（B-M8-4）；
//       --help 重印头部使用说明。
// 注入缝：VERIFY_GATE_CMD_TIMEOUT（单条命令超时秒）、VERIFY_GATE_SHELL（整体
//       覆盖执行 shell，探测失败按自身异常 fail-open）、WF_TRUST_DIR（信任存储目录，
//       测试隔离）、GUARD_HOOK_INJECT_CRASH=1（解析成功后抛错，验证崩溃陷阱
//       fail-open 改写；正式运行勿设）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readStdin, installHookErrorTrap, runHookMain, bindHookContext } from './hook-lib.mjs';
import { projectKey, stateRootFor } from './routing-lib.mjs';
import { reportPath, baselinePath } from '../scripts/lib/write-audit.mjs';

const GATE_NAME = 'verify.gate';
const TRUST_NAME = '.verify-gate.trust';

/** 单条命令超时秒数（VERIFY_GATE_CMD_TIMEOUT 覆盖；非纯数字回落 20）。 */
function cmdTimeoutSec() {
  const raw = process.env.VERIFY_GATE_CMD_TIMEOUT ?? '20';
  return /^\d+$/.test(raw) ? Number(raw) : 20;
}

/**
 * 整轮执行预算（毫秒，内部任务-244 C02）：manifest 声明 timeoutMs=60000 − 5s 余量 = 55000；
 * `WF_VERIFY_GATE_TOTAL_MS` 为测试注入缝（生产缺省固定）。循环内每条命令的超时按
 * 「剩余预算」扣减——防多条长命令合计击穿宿主 60s 上限（宿主杀进程后钩静默失效）。
 * @returns {number}
 */
function totalDeadlineMs() {
  const n = Number(process.env.WF_VERIFY_GATE_TOTAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 55000;
}

// C1 Stop 通道探针（w3-anchor-probe/stop-probe.jsonl 观测件）已随 2026-09-19 评审修复批
// 收口移除——观测结论已消费（P9 回退兜底锚不可见场景，内部决策-025 ③），历史见 learnings 2026-09-16。

/**
 * 归一化命令流（源 _gate_commands 逐字复刻，执行与哈希共用此过滤——单一事实源）：
 * 每行剥行首 BOM、去尾 \r、仅左剥空白（不右剥），跳过空行与 # 整行注释，每行补
 * \n。**字节级保真是信任哈希长期有效的硬要求**（2026-09-19 收尾评审 R2 更正论证
 * 依据）：用户级信任基线（~/.zcode/verify-gate-trust/）一旦落盘即长期比对，任何
 * 「顺手改良」（右剥/仅首行剥 BOM/跳#时机）都会使存量基线全量误判篡改（原注释引
 * 用的项目根存量 trust 兼容面已随 B13 迁移作废——项目根 legacy 一律不采信）。
 * @param {string} content 声明文件全文
 * @returns {string}
 */
export function normalizeGateCommands(content) {
  const out = [];
  for (let line of String(content).split('\n')) { // split 天然容忍末行无换行
    line = line.replace(/^\ufeff/, '');
    line = line.replace(/\r$/, '');
    line = line.replace(/^[ \t\n\v\f\r]+/, '');
    if (line === '' || line.startsWith('#')) continue;
    out.push(line);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** 归一化命令流 sha256（node:crypto 恒可用，源三级探测段随之消亡）。 */
function hashCommandStream(normalized) {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 纯 bash 上溯一级目录（源 _parent_dir 复刻）：含 `/` 取最后斜杠前（削到空给
 * `/`），不含 `/` 给 `/`。入口先做反斜杠归一（2026-09-19 评审修复 H2）——win32
 * 原生分隔符路径不归一会让 lastIndexOf('/') 落空、上溯一步即坍缩到 `/`（盘符
 * 根），子目录会话的声明文件整体静默不可见；check-freeze.mjs normPathRaw 同款。
 * @param {string} p
 * @returns {string}
 */
function parentDir(p) {
  const norm = String(p).replaceAll('\\', '/');
  const i = norm.lastIndexOf('/');
  if (i > 0) return norm.slice(0, i);
  return '/';
}

/** 阻断输出（源 _emit_block）：Stop 阻断语义（内部规则-3），exit 2。additionalContext
 * 会被宿主注入对话，失败摘要因此能到达模型；不新增键（宿主严格 schema）。 */
function emitBlock(body) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: body } })}\n`);
  process.exit(2);
}

/** 声明与信任存储不符 → 提醒重新确认并阻断（T-M8-3：不得静默继续）。2026-09-19 评审
 * 修复 B13：信任存储为用户级路径；项目根 .verify-gate.trust 为旧版遗留——一律不采信
 * （含正确哈希同拒：攻击者可与 verify.gate 同源预置正确哈希，「匹配」不构成来源证明），
 * 可安全删除。 */
function emitTamper(root, trust) {
  process.stderr.write(`verify-gate: 声明文件已变更（sha256 不符），请重新确认：${root}/${GATE_NAME}\n`);
  emitBlock(`【verify-gate 完成闸】声明文件已变更，请重新确认（T-M8-3 防篡改）：
- 声明内容：${root}/${GATE_NAME}
- 信任存储（用户级）：${trust}（项目根 ${root}/${TRUST_NAME} 为旧版遗留——不采信，可安全删除）
- 两者的 sha256 不一致，本次视为声明失效，不得静默继续执行其中命令。
- 若变更出自你的本意：人工审阅声明内容后删除 ${trust}，下次 Stop 将按当前内容重新首录（首录当次不执行）。
- 若非本意：请检查声明文件被谁改动后再继续。`);
}

/** 首次发现声明文件 → 记录基线并阻断一拍（2026-09-19 评审修复 B13）：旧「首录即执行」
 * 是静默信任；新语义=当次不执行、声明内容位置与信任存储对用户可见，下一次 Stop 起按
 * 基线执行。用户级存储使「同源预置伪造信任」失效（仓库无法写用户目录）。
 * @param {string} root 声明文件所在项目根
 * @param {string} trust 用户级信任文件路径
 */
function emitFirstSeen(root, trust) {
  process.stderr.write(`verify-gate: 首次发现声明文件，已记录信任基线（本次未执行）：${root}/${GATE_NAME}\n`);
  emitBlock(`【verify-gate 完成闸】首次发现本项目声明文件，已记录信任基线，本次未执行其中命令：
- 声明内容：${root}/${GATE_NAME}（请人工核对——其中命令将在后续每次 Stop 执行）
- 信任存储（用户级，已脱离项目分发面）：${trust}
- 确认无误：下次 Stop 起按此基线执行；声明文件此后任何变更都会按防篡改阻断。
- 若非你预期：删除上述信任文件即可作废基线。`);
}

/** 普通文件判定（bash `[ -f ]` 等价：存在且非目录——声明名恰为目录时不算声明，继续上溯）。 */
function isPlainFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 信任存储目录（2026-09-19 评审修复 B13）：迁出项目根至用户级目录——切断「trust 与
 * verify.gate 同源预置」的分发攻击面（恶意仓库同时预置两文件即可让首 Stop 静默执行
 * 任意命令）。项目根 .verify-gate.trust 为旧版遗留，一律不采信。WF_TRUST_DIR 为测试
 * 隔离注入缝（缺省用户目录）；home 不可写时落 tmpdir 兜底（fail-open，runtimeStateDir
 * 同款先例）。
 * @returns {string} 信任目录绝对路径
 */
function trustDir() {
  if (process.env.WF_TRUST_DIR) return process.env.WF_TRUST_DIR;
  try {
    const dir = join(homedir(), '.zcode', 'verify-gate-trust');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    /* home 不可写：tmpdir 兜底（信任暂不跨会话稳定，但闸不静默停摆） */
  }
  return tmpdir();
}

/** 用户级信任文件路径：键=项目根路径（正斜杠归一）digest16——同仓不同声明文件不共享信任。
 * @param {string} root 声明文件所在项目根
 * @returns {string} 信任文件绝对路径
 */
function trustPathUser(root) {
  const digest = createHash('sha256').update(String(root).replaceAll('\\', '/')).digest('hex').slice(0, 16);
  return join(trustDir(), `${digest}.sha256`);
}

/** 信任落盘：目录按需创建，临时文件 + rename 原子写，尽力 0600（旧首录同款形态）。
 * @param {string} file 信任文件路径
 * @param {string} hash 信任哈希
 */
function writeTrust(file, hash) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${hash}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true }); // mv 失败清残留 tmp（评审 C4 同款）
    } catch {
      /* 清理失败不反噬 */
    }
    throw e;
  }
}

/**
 * 命令失败 → 阻断并附输出摘要（文案逐字直搬源 :142-148；摘要前 5 行，超时 124 注记，
 * 127 spawn 失败附 error.code）。摘要先按旧 _json_escape 口径剥控制字符（保 \n）——
 * 命令输出可能带 ANSI 色码等字节，不能让它们进入注入对话的 additionalContext。
 * @param {string} root
 * @param {number} idx
 * @param {string} cmd
 * @param {number} status
 * @param {string} out
 * @param {string} [statusNote] 退出码补充注记（124/127 场景）
 */
function emitFailure(root, idx, cmd, status, out, statusNote = '', userTrust = '') {
  const cleaned = out.replace(/[\x00-\x09\x0b-\x1f]/g, ''); // 删控制字符保 \n（旧 tr -d 复刻）
  // bash 等价：`$(cmd 2>&1)` 剥一个尾换行，`<<<` 再逐行喂——尾空行不进摘要
  const lines = cleaned.replace(/\n$/, '').split('\n').slice(0, 5).join('\n'); // 前 5 行摘要（here-string 物化）
  const summary = lines === '' ? '(命令无输出)' : lines;
  const note = statusNote || (status === 124 ? '（124 通常为单条命令超时命中）' : '') ;
  process.stderr.write(`verify-gate: 声明命令失败(exit ${status}): ${cmd}\n`);
  emitBlock(`【verify-gate 完成闸】声明命令未通过，本轮不得结束（R-M8-3）：
- 声明文件：${root}/${GATE_NAME}（第 ${idx} 条命令）
- 失败命令：${cmd}
- 退出码：${status}${note}
- 输出摘要（前 5 行）：
${summary}
- 处理建议：修复上述失败后重试；或确认后修订 ${root}/${GATE_NAME}（变更内容须重录信任：删除用户级信任文件 ${userTrust}）。`);
}

/**
 * 执行 shell 四级探测（内部未决-14 设计裁决）：①VERIFY_GATE_SHELL 整体覆盖（探测失
 * 败按自身异常 fail-open）；②PATH 内 bash（`--version` 成功）；③Windows Git 惯例
 * 绝对位置（专为「Git Bash 已装但宿主 spawn PATH 解析不到」的 内部未决-14 人群）；
 * ④兜底 spawnSync(cmd,{shell:true})（Windows=ComSpec/cmd.exe，POSIX=/bin/sh）——
 * 无 bash 机器上声明命令按系统 shell 语义执行（verify-gate.md 已文档化）。
 * @returns {{kind: 'bash', cmd: string} | {kind: 'shellTrue'}} | null（探测失败=自身异常）
 */
export function resolveGateShell() {
  const custom = process.env.VERIFY_GATE_SHELL;
  if (custom) {
    const probe = spawnSync(custom, ['-c', 'echo ok'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) return { kind: 'bash', cmd: custom };
    return null; // 用户注入缝坏路径：环境故障，不放大成对宿主误阻断（fail-open）
  }
  const onPath = spawnSync('bash', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (onPath.status === 0) return { kind: 'bash', cmd: 'bash' };
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return { kind: 'bash', cmd: p };
  }
  return { kind: 'shellTrue' };
}

/**
 * spawnSync 结果退出码合成：status 非 null 直用；status===null 且超时（signal 或
 * killed 或 ETIMEDOUT）→ 124（GNU timeout 语义，源 :140 文案注记依赖此码）；其余
 * null（spawn 失败）→ 127 附 error.code。
 * @param {import('node:child_process').SpawnSyncReturns} r
 * @returns {{status: number, note: string}}
 */
export function synthesizeStatus(r) {
  if (r.status !== null && r.status !== undefined) return { status: r.status, note: '' };
  const timedOut = Boolean(r.signal) || Boolean(r.error?.killed) || r.error?.code === 'ETIMEDOUT';
  if (timedOut) return { status: 124, note: '' };
  return { status: 127, note: r.error?.code ? `（spawn 失败：${r.error.code}）` : '' };
}

/**
 * 执行单条声明命令（源 :202-208 等价）：cwd=项目根，合并 stdout+stderr 捕获，
 * 超时按 cmdTimeoutSec。退出码经 synthesizeStatus 合成（124/127 附注记）。
 * @param {string} t 命令
 * @param {string} root 项目根
 * @param {ReturnType<resolveGateShell>} shell
 * @param {number} [timeoutSec] 本条超时秒（C02：由循环按总预算扣减后传入）
 * @returns {{status: number, out: string, statusNote: string}}
 */
function runGateCommand(t, root, shell, timeoutSec = cmdTimeoutSec()) {
  const opts = { cwd: root, timeout: timeoutSec * 1000, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
  const r = shell.kind === 'bash'
    ? spawnSync(shell.cmd, ['-c', t], opts)
    : spawnSync(t, { ...opts, shell: true });
  const { status, note } = synthesizeStatus(r);
  // bash 原版 2>&1 合并流：这里按 stdout 后接 stderr 拼接（摘要展示用途，非机器解析）
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status, out, statusNote: note };
}

/** 主流程：负载 cwd（解析失败静默回退 process.cwd()）→ 上溯找声明 → 信任 → 执行。 */
async function main() {
  const { cwd, sessionId } = await currentPayload(); // stdin 只读一次
  if (process.env.GUARD_HOOK_INJECT_CRASH === '1') throw new Error('inject-crash');

  // 从起点逐级上溯找声明文件，所在目录即项目根
  let dir = cwd;
  let root = '';
  for (;;) {
    if (isPlainFile(`${dir}/${GATE_NAME}`)) { root = dir; break; }
    const parent = parentDir(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (root === '') process.exit(0); // 未声明项目：零输出退 0——零影响是硬要求（内部规则-4 / B-M8-2）

  // 信任哈希取「归一化命令流」而非文件原始字节：git autocrlf 翻行尾、编辑器改注释
  // 排版不该误报篡改；语义=「改了要跑的命令才需重确认」。
  const normalized = normalizeGateCommands(readFileSync(`${root}/${GATE_NAME}`, 'utf8'));
  const hash = hashCommandStream(normalized);

  // 信任存储（2026-09-19 评审修复 B13）：用户级目录（键=项目根 digest）。项目根 legacy
  // .verify-gate.trust **不采信**——攻击者可与 verify.gate 同源预置正确哈希的信任文件，
  // 采信 legacy 即重新打开该攻击面；存量项目下次 Stop 走一次首次发现（可见一拍）即恢复。
  // 首次发现记录基线后阻断一拍（emitFirstSeen），替代旧「首录即静默执行」；信任文件
  // 存在但空/不可读（完整性无法证明）按防篡改阻断，不并入首发现静默重录（T-M8-3 旧语义）。
  const userTrust = trustPathUser(root);
  const readFirstLine = (p) => {
    try {
      return readFileSync(p, 'utf8').split('\n')[0];
    } catch {
      return '';
    }
  };
  if (!isPlainFile(userTrust)) {
    try {
      writeTrust(userTrust, hash);
    } catch {
      process.exit(0); // 写不进去视为自身异常 → fail-open，绝不降级成「无信任照跑」（T-M8-3）
    }
    emitFirstSeen(root, userTrust);
  } else {
    const stored = readFirstLine(userTrust);
    if (stored === '' || stored !== hash) emitTamper(root, userTrust);
  }

  // 逐条执行声明命令（工作目录=项目根），首条失败即阻断并附摘要
  const shell = resolveGateShell();
  if (shell === null) process.exit(0); // shell 探测失败=自身异常：fail-open（环境故障不误阻断）
  let idx = 0;
  // 内部任务-244 C02：整轮 deadline 扣减（manifest timeoutMs−余量）；预算耗尽按 124 阻断并注记。
  const deadlineMs = totalDeadlineMs();
  const startedAt = Date.now();
  for (const t of normalized.split('\n')) {
    if (t === '') continue;
    idx += 1;
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    // 预算不足以再容纳一条命令的最小粒度（1s）即按耗尽处理——避免「剩余 1ms 仍起一条命令
    // 再被默认超时文案掩盖预算根因」（内部任务-244 步骤 22 终评：预算注记必须可判定）。
    if (remainingMs < 1000) emitFailure(root, idx, t, 124, '', '（总执行预算耗尽：manifest timeoutMs−余量）', userTrust);
    const timeoutSec = Math.max(1, Math.min(cmdTimeoutSec(), Math.ceil(remainingMs / 1000)));
    const { status, out, statusNote } = runGateCommand(t, root, shell, timeoutSec);
    if (status !== 0) emitFailure(root, idx, t, status, out, statusNote, userTrust);
  }
  const warn = writeAuditWarnLine(root, sessionId); // 内部任务-261 步骤18：只读报表 warning（不 block）
  if (warn !== '') process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: warn } })}\n`);
  process.exit(0); // 全部通过：静默放行（成功不打扰；有 warning 时输出一行）
}

/** 短摘要（与 write-guard/write-audit 报表文件口径一致：sha256 前 16 hex）。 */
function digest16(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 写归因报表消费（内部决策-066 D7，内部任务-261 步骤18）：仅当 report 属于当前会话且 ts 在 6 小时内
 * 才采信；缺失/过期/损坏/degraded/unattributed 一律显式 warning 行，不改变 gate 判据。
 * clean → 空串（成功静默）。自身异常 fail-open 为空串（不阻断完成闸）。
 * @param {string} root 项目根
 * @param {string} sessionId 宿主会话标识
 * @returns {string}
 */
function writeAuditWarnLine(root, sessionId) {
  try {
    const sidDigest = digest16(sessionId || 'default');
    const stateDir = stateRootFor(projectKey(root));
    const file = reportPath(stateDir, sidDigest);
    if (!existsSync(file)) {
      // write-guard 未在本会话生效（无 baseline）→ 不误报；有 baseline 却无 report → 显式 degraded
      if (!existsSync(baselinePath(stateDir, sidDigest))) return '';
      return `【workflow 写归因】degraded：本会话无写归因报表（${file} 缺失；write-guard 未生效或 Stop 未运行），完成闸见 OPEN-225`;
    }
    let report;
    try {
      report = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return `【workflow 写归因】degraded：报表损坏不可解析（${file}），完成闸见 OPEN-225`;
    }
    if (report?.sidDigest !== sidDigest) {
      return `【workflow 写归因】degraded：报表会话不匹配（期望 ${sidDigest}），完成闸见 OPEN-225`;
    }
    // 合法 JSON 但字段类型损坏（内容损坏）→ 显式 degraded 行，不静默吞入外层 catch
    if ((report.degradedReasons !== undefined && !Array.isArray(report.degradedReasons))
      || (report.rows !== undefined && !Array.isArray(report.rows))
      || (report.attributed !== undefined && (typeof report.attributed !== 'object' || report.attributed === null))) {
      return `【workflow 写归因】degraded：报表形状损坏（字段类型非法；明细 ${file}），完成闸见 OPEN-225`;
    }
    const ts = Date.parse(report.ts);
    const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(ts) || ageMs > 6 * 60 * 60 * 1000) {
      return `【workflow 写归因】degraded：报表过期（${Number.isFinite(ts) ? `${Math.floor(ageMs / 60000)} 分钟前` : 'ts 非法'}，>6h 不采信），完成闸见 OPEN-225`;
    }
    if (report.status === 'degraded') {
      return `【workflow 写归因】degraded：${(report.degradedReasons ?? []).join('；') || '未知原因'}（明细 ${file}），完成闸见 OPEN-225`;
    }
    const unattributed = Number(report?.attributed?.unattributed) || 0;
    if (unattributed > 0) {
      const paths = (report.rows ?? []).filter((r) => r.state === 'unattributed').slice(0, 5).map((r) => r.path).join('、');
      return `【workflow 写归因】unattributed ${unattributed} 项（${paths}；明细 ${file}），完成闸见 OPEN-225`;
    }
    return '';
  } catch {
    return ''; // 自身异常 fail-open：不阻断完成闸（report 消费面 warning 级）
  }
}

/**
 * 取负载 cwd：tty 手动运行跳过读取用 process.cwd() 兜底；stdin 有负载则 JSON.parse
 * 取 cwd 字段（源用 sed 提取、失败静默回退 $PWD——JSON.parse 失败同样静默回退，
 * 不抛错，fail-open 纪律）。
 * @returns {Promise<string>}
 */
async function currentPayload() {
  try {
    if (process.stdin.isTTY) return { cwd: process.cwd(), sessionId: '' };
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    // 内部任务-290：崩溃留痕归属到会话（内部未决-260）；sessionId 此处已解析，直接复用（无需再引 pickString）
    bindHookContext({ sessionKey: typeof payload?.session_id === 'string' ? payload.session_id : '' });
    return {
      cwd: typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd(),
      sessionId: typeof payload?.session_id === 'string' ? payload.session_id : '',
    };
  } catch {
    return { cwd: process.cwd(), sessionId: '' };
  }
}

/**
 * 内置自检（B-M8-4，断言集对齐 verify-gate.selftest.sh 四态 + 注入）：子进程驱动
 * 自身（信任目录隔离在 WF_TRUST_DIR）。
 * @returns {number}
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-vg-selftest-'));
  const me = fileURLToPath(import.meta.url);
  const env = { ...process.env, WF_TRUST_DIR: join(home, 'trust'), WF_ROUTING_STATE_DIR: join(home, 'state') };
  // selftest 内联调用 trustPathUser（态2a 断言）读进程环境而非子进程 env——同值注入
  const prevTrustEnv = process.env.WF_TRUST_DIR;
  process.env.WF_TRUST_DIR = env.WF_TRUST_DIR;
  try {
    const run = (cwd) => {
      const r = spawnSync(process.execPath, [me], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
      return { status: r.status, stdout: r.stdout ?? '' };
    };
    const undeclared = join(home, 'nope');
    const a = run(undeclared);
    check('态1 未声明项目静默放行', a.status === 0 && a.stdout.trim() === '');
    const d2 = join(home, 'r2');
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, GATE_NAME), 'echo ok\n');
    const b = run(d2);
    // 2026-09-19 评审修复 B13：首次发现=记录基线+阻断一拍（不执行）；信任落用户级目录
    check(
      '态2a 首次发现 rc2 且基线落盘（未执行）',
      b.status === 2 && b.stdout.includes('首次发现') && readFileSync(trustPathUser(d2), 'utf8').trim() !== '',
    );
    const c = run(d2);
    check('态2b 信任比对一致 rc0', c.status === 0);
    const d3 = join(home, 'r3');
    mkdirSync(d3, { recursive: true });
    writeFileSync(join(d3, GATE_NAME), 'echo boom-output-line; exit 1\n');
    run(d3); // 首次发现（记录基线，当次不执行）
    const d = run(d3); // 第二次起按基线执行——命令失败阻断
    const dj = d.status === 2 ? (() => { try { return JSON.parse(d.stdout); } catch { return null; } })() : null;
    check('态3 命令失败 rc2 且信封可解析', d.status === 2 && dj !== null && dj.hookSpecificOutput.hookEventName === 'Stop');
    check('态3 摘要含命令输出与原文', d.status === 2 && d.stdout.includes('boom-output-line') && d.stdout.includes('exit 1'));
    const d4 = join(home, 'r4');
    mkdirSync(d4, { recursive: true });
    writeFileSync(join(d4, GATE_NAME), 'echo ok\n');
    run(d4);
    writeFileSync(join(d4, GATE_NAME), 'echo ok\ntamper\n');
    const e = run(d4);
    check('态4 声明被篡改 rc2 且提示重新确认', e.status === 2 && e.stdout.includes('重新确认'));
    const f = run(d3);
    check('信封不新增键（严格 schema）', f.status === 2 && Object.keys(JSON.parse(f.stdout).hookSpecificOutput).length === 2);
  } finally {
    if (prevTrustEnv === undefined) delete process.env.WF_TRUST_DIR;
    else process.env.WF_TRUST_DIR = prevTrustEnv;
    // 内部任务-244 步骤 22：自检临时目录清理改**尽力 + 重试**——Windows 下子进程句柄/AV 扫描会让
    // rmSync 瞬发 EPERM，原实现把清理失败当成自检崩溃（install-chain 集成用例与 --selftest 入口
    // 用例因此间歇假红，与 内部未决-83 同类）。清理不是断言面：残留临时目录无害，断言结果照常输出。
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* 清理失败不判红（见上） */
    }
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL verify-gate.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK verify-gate.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    // symlink 形态归一（内部任务-GUARDSYML-1）：ESM 默认按 realpath 解析主模块，argv[1] 保留
    // 别名形态时字符串级比对恒 false → 钩子整体静默 no-op；realpath 归一后再比一次
    // （realpath 失败落 catch 判 false，fail-open 段不变；首轮原始比对保留，兼容
    // --preserve-symlinks-main 下 import.meta.url 为别名形态的运行方式）。
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest()); // selftest 失败须可见退 1：陷阱不装
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    for (const line of ['用法：verify-gate.mjs [选项]', '  （无参数）从 stdin 读宿主 JSON 负载（tty 手动运行用进程 cwd），执行项目根 verify.gate 声明的验证命令', '  --selftest 运行内置自检（B-M8-4）', '  --help    显示本说明；启用方式见文件头使用说明（verify.gate 声明 + 用户级信任存储，2026-09-19 B13 迁移）']) {
      process.stdout.write(`${line}\n`);
    }
    process.exit(0);
  }
  installHookErrorTrap('verify-gate'); // 自身异常改写为 exit 0（fail-open；阻断/篡改是显式决策不受影响）
  runHookMain('verify-gate', main);
}
