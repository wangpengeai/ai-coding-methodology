// 文件：post-tool.mjs
// 描述：运行自察捕获钩（内部模块-15/内部决策-019，内部规则-1）——PostToolUseFailure（主通道）与
//       PostToolUse（防御解析兜底）双注册。宿主对两事件独立分发（同一失败可能双触发，
//       claude-security 官方插件同款双注册先例），幂等由 incident-store 的记录 id 承担：
//       id 取 tool_use_id（缺省按 digest+分钟桶），读侧同 id 以文件末条为准（前向状态机）。
//       负载形态无宿主文档（2026-09-13 探针未实测，配置文件钩子不热加载）——全部
//       字段防御解析：不可判定即静默跳过（fail-open，内部规则-7）。
//       **判据面（2026-09-29 内部任务-OPEN46-1）**：只吃**结构化事实**——对象面
//       `error`/`is_error`/`exit_code|code`/`stderr`；**字符串形态不单独构成失败判据**
//       （旧实现按"输出行首 error/fatal/exception/traceback"判定，在第二宿主上双向失真：
//       退 0 且正文含错误样式行或他次回显被记假阳性；带文本退出标记的真失败零记录）。
//       宿主渲染文本里的退出标记属**宿主 seam 契约**，核心件零宿主术语、不解析；
//       第二宿主侧的结构化面由适配层装配（字段来源见 内部接口-1 §事件面缺口登记）。
//       digest 按 `errorClass + 退出变体 + 工具动作身份` 细分（旧「tool+固定类名」粗 digest
//       把异质失败并成一条，无归因区分力；动作身份＝命令/路径指纹 ＋ 存在的动作定义字段哈希，
//       见 actionFingerprint——内部任务-DIGESTDISC-1 实测同文件异质 edit 失败曾同 digest `a09c00f3…`）；
//       记录另带 `errorClass`/`exitCode` 供 operator 读。
//       重试环：同 tool+同输入 digest 在 5 分钟窗口内第 3 次命中记一条 retry-loop。
//       同参数自愈（内部未决-110，内部任务-52）：成功调用对窗内本会话同 (tool, inputDigest) 的
//       open 态 tool-failure 自动转 resolved（resolveOpenToolFailuresByRetry，库原语全路径
//       不抛）——只动 open、retry-loop 升级通道不入面、triaged 不被机器改判。
//       本钩是纯记录钩（唯一模型可见例外，内部任务-352/内部模块-8 内部规则-8/内部验收-47）：AskUserQuestion 答复是
//       tool result 通道、不触发 UserPromptSubmit，故当 ask 成功答复 ∧ 本项目租约键「挑战令牌存在
//       ∧ active 租约无效」时，以 内部规则-6 合规 PostToolUse 非决策信封重述当前令牌与声明命令
//       （只读：零签发、零激活；委派会话零输出；其余任何路径无 stdout、exit 0）。
//       内部任务-8（2026-10-07，内部规则-17）：**分流零改动**——处理链本就工具无关；manifest 侧
//       matcher 键省略（全命中）后非目标族负载照常到达，成功结果不落账、失败按结构化事实
//       记录即为「静默放行」语义；双通道去重（同 callId 一条）由 post-tool-hook.test.mjs
//       的 内部任务-8 用例锁定，防 matcher 放宽后双记。
//       内部任务-342（2026-11-06）：归因 taskId/skill 改 own-only（leaseContextOfOwn）——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 注入缝：WF_POSTTOOL_STATE_DIR（重试环状态目录，测试隔离）、
//       WF_INCIDENT_ROOT（incident-store 根覆盖，测试隔离）。
// 用法：宿主经 hooks.json 以 process 方式调用（stdin=宿主 JSON 负载）；
//       自检：node post-tool.mjs --selftest（B-M8-4）。
import { openSync, closeSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectKey, activationRoot, runtimeStateDir } from './routing-lib.mjs';
import { answerChannelLeaseHint, leaseContextOfOwn, hostOf, reviveOrHeartbeat, soleTaskIdSuggestion } from './task-lease-lib.mjs';
import { declareCmdPrefix, readStdin, sessionStateFile, installHookErrorTrap, noteHookIssue, runHookMain } from './hook-lib.mjs';
import { isAskUserQuestionTool } from '../scripts/lib/tool-families.mjs';
import { applyDispositions, appendIncident, digestOf, healRetryOpenByIndex, readIncidents, rememberRetryOpenIndex, resolveOpenToolFailuresByRetry } from '../scripts/lib/incident-store.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';
import { factFromToolPayload, normalizeDispatchFact } from '../scripts/lib/incident-fact.mjs';
// 内部决策-063 修正案 3 决策 20（内部任务-195）：classifyResult 与分类指纹链的生产实现已下沉
// `scripts/lib/tool-result-classify.mjs`（判据被本钩与 session-start 就绪面 canary 共用）；
// 本钩只**同名再导出**——既有调用面（postTool.classifyResult / commandFingerprint /
// actionFingerprint 及 selftest）零改动，lib 不得反向 import 钩子入口。
import { actionFingerprint, classifyResult, commandFingerprint } from '../scripts/lib/tool-result-classify.mjs';

export { actionFingerprint, classifyResult, commandFingerprint };

/** 重试环窗口：5 分钟。 */
const RING_WINDOW_MS = 5 * 60 * 1000;
/** 重试环触发阈值：同 tool+digest 连续第 3 次。 */
const RING_THRESHOLD = 3;
/**
 * 重试环推进（纯函数，导出供测试）：同 tool+digest 窗口内累计，达阈值触发一次并清零；
 * 换调用或窗口过期重置。
 * @param {{ring: {tool: string, digest: string, count: number, firstTs: number}|null}} state 旧状态
 * @param {string} toolName 工具名
 * @param {string} inputDigest 输入 digest
 * @param {number} now 当前时刻
 * @returns {{state: {ring: object|null}, triggered: boolean}}
 */
export function retryRing(state, toolName, inputDigest, now) {
  const ring = state?.ring ?? null;
  if (ring && ring.tool === toolName && ring.digest === inputDigest && now - ring.firstTs <= RING_WINDOW_MS) {
    const count = ring.count + 1;
    if (count >= RING_THRESHOLD) {
      return { state: { ring: null }, triggered: true }; // 触发后清零：一环一记，不刷屏
    }
    return { state: { ring: { tool: toolName, digest: inputDigest, count, firstTs: ring.firstTs } }, triggered: false };
  }
  return { state: { ring: { tool: toolName, digest: inputDigest, count: 1, firstTs: now } }, triggered: false };
}

/** 重试环状态文件路径（hook-lib 会话键消毒 + WF_POSTTOOL_STATE_DIR 注入缝）。 */
function ringStateFile(sessionId) {
  return sessionStateFile('wf-posttool', sessionId, process.env.WF_POSTTOOL_STATE_DIR);
}

/** 重试环推进占位（内部任务-244 D07）：同一调用双事件并行触发时只允许单写者推进计数。 */
const RING_PLACEHOLDER_TTL_MS = 60 * 1000;
/** 占位陈旧回收残件（`.stale-*`）的保留窗口（内部任务-244 遗留项②：崩溃一次留一件，超龄清理防累积）。 */
const RING_PLACEHOLDER_RESIDUE_TTL_MS = 60 * 60 * 1000;

/**
 * 清理超龄占位残件（内部任务-244 遗留项②）：`acquireRingPlaceholder` 把陈旧占位改名隔离为
 * `<file>.stale-<ts>` 供诊断，但原实现从不清理——崩溃/竞争一次留一件、会话状态根永久累积。
 * 本函数按 1h TTL 尽力删除（失败忽略，不影响占位获取）。
 * @param {string} file 当前占位路径（取其目录）
 */
function cleanupPlaceholderResidue(file) {
  const dir = dirname(file);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('wf-retry-placeholder-') || !name.includes('.stale-')) continue;
    const p = join(dir, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > RING_PLACEHOLDER_RESIDUE_TTL_MS) rmSync(p, { force: true });
    } catch {
      /* 清理失败不反噬 */
    }
  }
}

/**
 * 重试环推进占位文件路径（内部任务-244 D07，导出供测试构造崩溃残留）：以「会话+调用键」命名。
 * @param {string} sessionId 会话标识 @param {string} callKey 调用键
 * @returns {string}
 */
export function retryPlaceholderFile(sessionId, callKey) {
  const file = ringStateFile(sessionId);
  return join(dirname(file), `wf-retry-placeholder-${digestOf(['ring-placeholder', sessionId, callKey])}.lock`);
}

/**
 * 获取推进占位（内部任务-244 D07）：`openSync('wx')` 排他建占位并写 pid/ts；EEXIST 时若占位超
 * TTL（60s，崩溃残留）→ 改名隔离后**单次重试**并 noteHookIssue('retry-placeholder-stale')；
 * 未超期视为他者正在推进 → 本次跳过（不计双写）。失败 fail-open（返回 acquired:false 不抛）。
 * @param {string} file 占位路径
 * @returns {{acquired: boolean, reason?: string}}
 */
function acquireRingPlaceholder(file) {
  cleanupPlaceholderResidue(file); // 内部任务-244 遗留项②：超龄 .stale-* 残件按 TTL 清理
  try {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
    } catch {
      closeSync(fd);
    }
    return { acquired: true };
  } catch (e) {
    if (e?.code !== 'EEXIST') return { acquired: false, reason: 'io' };
    let stale = false;
    try {
      stale = Date.now() - statSync(file).mtimeMs > RING_PLACEHOLDER_TTL_MS;
    } catch {
      stale = false;
    }
    if (!stale) return { acquired: false, reason: 'busy' };
    try {
      renameSync(file, `${file}.stale-${Date.now()}`);
    } catch {
      return { acquired: false, reason: 'stale-quarantine-failed' };
    }
    noteHookIssue('post-tool', 'retry-placeholder-stale');
    try {
      const fd = openSync(file, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        closeSync(fd);
      } catch {
        closeSync(fd);
      }
      return { acquired: true };
    } catch {
      return { acquired: false, reason: 'stale-retry-failed' };
    }
  }
}

/**
 * 自检入口（B-M8-4）：classifyResult 形态矩阵、retryRing 三次触发/清零/换调用重置/
 * 窗口过期重置、store 幂等、坏负载 fail-open、无输出契约。失败可见退 1。
 * @returns {number}
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-posttool-selftest-'));
  const prevRoot = process.env.WF_INCIDENT_ROOT;
  try {
    process.env.WF_INCIDENT_ROOT = home;
    // classifyResult 矩阵（结构化事实唯一判据，内部未决-46）
    check('对象非零退出码判失败', classifyResult('Bash', { exit_code: 2 })?.errorClass === 'exit-nonzero');
    check('对象 error 字段判失败', classifyResult('Bash', { error: 'boom' })?.errorClass === 'error-field');
    check('对象 is_error 判失败（第二宿主 edit 形态）', classifyResult('edit', { is_error: true })?.errorClass === 'error-flag');
    check('对象 isError 驼峰同样认', classifyResult('edit', { isError: true })?.errorClass === 'error-flag');
    check('对象 stderr 判失败', classifyResult('Bash', { stderr: 'oops' })?.errorClass === 'stderr');
    check('对象退出码 0 不记', classifyResult('Bash', { exit_code: 0, stdout: 'ok' }) === null);
    check('退出码 0 带 stderr 告警不记（假阳性防护）', classifyResult('Bash', { exit_code: 0, stdout: 'ok', stderr: 'Warning: deprecation' }) === null);
    check('对象无可判定字段不记', classifyResult('Bash', { stdout: 'x' }) === null);
    check('第二宿主成功形态（is_error:false 无退出码）不记', classifyResult('pwsh', { is_error: false, stdout: 'error.js\ndone' }) === null);
    check('字符串行首 error 不记（OPEN-46 假阳性族）', classifyResult('Bash', 'error: no such file') === null);
    check('字符串 Traceback 回显不记', classifyResult('Bash', 'ok\nTraceback (most recent call last)') === null);
    check('字符串宿主退出标记不记（核心件零宿主术语）', classifyResult('pwsh', '(no output)\n[exit code: 1]') === null);
    check('null 不记', classifyResult('Bash', null) === null);
    check('非对象非字符串不记', classifyResult('Bash', 42) === null);
    check('命令指纹稳定（空白归一）', commandFingerprint({ command: 'git  status' }) === commandFingerprint({ command: 'git status' }));
    check('命令指纹随命令变', commandFingerprint({ command: 'git status' }) !== commandFingerprint({ command: 'git log' }));
    check('缺命令字段回落 nocmd', commandFingerprint({}) === 'nocmd');
    const dA = classifyResult('pwsh', { exit_code: 2 }, { command: 'git status' });
    const dB = classifyResult('pwsh', { exit_code: 2 }, { command: 'ls' });
    check('digest 随命令指纹细分', Boolean(dA) && Boolean(dB) && dA.digest !== dB.digest);
    check('digest 幂等（同命令同码）', classifyResult('pwsh', { exit_code: 2 }, { command: 'git status' })?.digest === dA.digest);
    check('digest 不等于判据缺陷期粗 digest', dA.digest !== digestOf(['tool-failure', 'pwsh', 'output-pattern']));
    const eA = classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'A', new_string: 'B' });
    const eB = classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'C', new_string: 'D' });
    check('digest 随编辑动作身份细分', Boolean(eA) && Boolean(eB) && eA.digest !== eB.digest);
    check('digest 编辑幂等', classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'A', new_string: 'B' })?.digest === eA.digest);
    // 「不落原文」用**hex 字母表内**的探针（plan-review 第 2 轮 N2：大写 A/B 在十六进制里永不出现，旧写法
    // includes('A') 对小写 hex 摘要恒真）；判别面如实声明（收尾评审 C2 实测）：本针只在"最终组装被拼接
    // **且** 动作字段未哈希"双点退化时才响，单点退化由 pwsh 的 16 位 hex 形态断言与 bash 零迁移项兜住
    const eP = classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'deadbeef', new_string: 'feedface' });
    check('digest 不落替换原文（hex 探针）', Boolean(eP) && !eP.digest.includes('deadbeef') && !eP.digest.includes('feedface'));
    check('bash 类 digest 与原口径逐字一致', classifyResult('bash', { exit_code: 1 }, { command: 'x' })?.digest === digestOf(['tool-failure', 'bash', 'exit-nonzero', '1', commandFingerprint({ command: 'x' })]));
    check('digest 不落命令原文', !dA.digest.includes('git'));
    check('退出码进返回面（记录可读）', dA.exitCode === 2 && classifyResult('edit', { is_error: true })?.exitCode === null);
    // retryRing：三次触发并清零；换调用重置；窗口过期重置
    let s = { ring: null };
    s = retryRing(s, 'Bash', 'd1', 1000).state;
    s = retryRing(s, 'Bash', 'd1', 2000).state;
    const hit = retryRing(s, 'Bash', 'd1', 3000);
    check('第三次命中触发', hit.triggered && hit.state.ring === null);
    const other = retryRing({ ring: { tool: 'Bash', digest: 'd1', count: 2, firstTs: 1000 } }, 'Edit', 'd1', 2000);
    check('换工具重置', !other.triggered && other.state.ring.count === 1);
    const stale = retryRing({ ring: { tool: 'Bash', digest: 'd1', count: 2, firstTs: 1000 } }, 'Bash', 'd1', 1000 + RING_WINDOW_MS + 1);
    check('窗口过期重置', !stale.triggered && stale.state.ring.count === 1);
    // store 幂等（双事件双触发语义：同 id 二写读侧只留一条）
    const a = appendIncident(home, { id: 'tf-x1', ts: 1, session: 's', kind: 'tool-failure', digest: 'aa' });
    appendIncident(home, { id: 'tf-x1', ts: 2, session: 's', kind: 'tool-failure', digest: 'aa' });
    check('追加回环 ok', a.ok);
    check('双触发读侧去重', readIncidents(home).length === 1);
    // 内部未决-110：同参数随即成功自愈——只收口 open 态 tool-failure，retry-loop 不入面
    appendIncident(home, { id: 'tf-o110', ts: 1000, session: 's110', kind: 'tool-failure', tool: 'Bash', inputDigest: 'dg1', status: 'open' });
    appendIncident(home, { id: 'rl-o110', ts: 1000, session: 's110', kind: 'retry-loop', tool: 'Bash', digest: 'dg1', status: 'open' });
    const heal = resolveOpenToolFailuresByRetry(home, { session: 's110', host: null, tool: 'Bash', inputDigest: 'dg1', windowMs: 300000, now: 2000 });
    check('OPEN-110 自愈恰收口 tool-failure 一条', heal.resolved === 1);
    check('OPEN-110 retry-loop 不入自愈面', readIncidents(home).find((x) => x.id === 'rl-o110')?.status === 'open');
    // 坏负载 fail-open：main 路径由宿主形态测试覆盖，此处校验本文件无顶层抛错
    check('RING_WINDOW 常量合法', RING_WINDOW_MS > 0 && RING_THRESHOLD === 3);
    // 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：分类字段、派发事实三态、归因透传、热路径处置作用域
    const clsReal = classifyFact({ kind: 'tool-failure', errorClass: 'error-flag', host: 'dsh' }, loadRules());
    check(
      'v2 分类字段（cause/severity/ruleId/rulesVersion）',
      clsReal.cause === 'real-failure' && clsReal.severity === 'action' && clsReal.ruleId === 'r-real-failure' && clsReal.rulesVersion === 1,
    );
    check(
      '派发事实三态归一（缺省/非法 → unknown）',
      normalizeDispatchFact('dispatched') === 'dispatched' &&
        normalizeDispatchFact('not-dispatched') === 'not-dispatched' &&
        normalizeDispatchFact(undefined) === 'unknown' &&
        normalizeDispatchFact('yes') === 'unknown',
    );
    const factD = factFromToolPayload({
      toolName: 'Bash',
      sessionId: 's',
      host: 'dsh',
      parsed: { dispatch_fact: 'dispatched', delegation_depth: 1, parent_session_id: 'p' },
      classified: { errorClass: 'exit-nonzero', exitCode: 1 },
    });
    check(
      '归因字段透传（dispatchFact/delegationDepth/parentSession）',
      factD.dispatchFact === 'dispatched' && factD.delegationDepth === 1 && factD.parentSession === 'p' && factD.observationSource === 'hook:post-tool',
    );
    // 热路径作用域（内部决策-063 D4 决策 2）：成功路径只调 retry-heal——lease 族与证据类不被热路径处置
    appendIncident(home, { id: 'tf-v2-heat', ts: 1000, session: 's-v2h', kind: 'tool-failure', tool: 'Bash', inputDigest: 'dg-v2h', cause: 'real-failure', status: 'open' });
    appendIncident(home, { id: 'ld-v2-heat', ts: 1000, session: 's-v2h', kind: 'lease-deny', cause: 'mechanism-trace', status: 'open' });
    appendIncident(home, { id: 'ev-v2-heat', ts: 1000, session: 's-v2h', kind: 'tool-failure', cause: 'probe-noise', errorClass: 'exit-nonzero', status: 'open' });
    const disp = applyDispositions(home, {
      sources: ['retry-heal'],
      retry: { session: 's-v2h', host: null, tool: 'Bash', inputDigest: 'dg-v2h', windowMs: RING_WINDOW_MS },
      now: 2000,
    });
    const afterDisp = readIncidents(home);
    check(
      '热路径只触发 retry-heal',
      disp.retryHealed === 1 &&
        afterDisp.find((x) => x.id === 'ld-v2-heat')?.status === 'open' &&
        afterDisp.find((x) => x.id === 'ev-v2-heat')?.status === 'open',
    );
  } finally {
    if (process.env.WF_INCIDENT_ROOT === home) process.env.WF_INCIDENT_ROOT = prevRoot;
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL post-tool.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK post-tool.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

/**
 * 主入口：解析负载 → 失败分类 / 重试环推进 → 落记录 → 静默退 0。
 * @returns {Promise<void>}
 */
async function main() {
  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // 负载非法：fail-open
  }
  const toolName = typeof parsed?.tool_name === 'string' ? parsed.tool_name : '';
  if (!toolName) process.exit(0);
  const sessionId = typeof parsed?.session_id === 'string' && parsed.session_id ? parsed.session_id : 'default';
  const cwd = typeof parsed?.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd();
  // 激活域外：纯记录钩也不在非仓目录落 <cwd>/.workflow 垃圾（2026-09-15 激活域批次，内部决策-022）
  if (!activationRoot(cwd)) process.exit(0);
  const root = projectKey(cwd);

  // 活跃租约快照（有则关联任务上下文；无租约也记录——失败常发生在声明前）；
  // observer 会话透传（内部任务-LEASEGATE-1）：扫描回退下不传会归因到他会话租约
  // 内部任务-342（内部决策-066 修正案 2 内部模块-1）：归因字段只认本会话具名桶（leaseContextOfOwn）——
  // null 桶（补签可见性形态）/他会话租约不参与归因，无本会话具名租约即 taskId/skill=null。
  const { taskId, skill } = leaseContextOfOwn(cwd, sessionId === 'default' ? null : sessionId);

  // 内部决策-045/内部任务-96：活动观测点——会话身份匹配则心跳顺延/宽限复活（库内全路径不抛；
  // 除 内部任务-352 答复提示例外，本钩无 stdout、恒 exit 0；返回值弃用与写闸侧 heartbeatLease 同姿态）。
  reviveOrHeartbeat(root, sessionId === 'default' ? null : sessionId);

  // 内部模块-15 v2（内部决策-063 D5）：派发事实（内部规则-1「DSH 仅在已派发时透传失败位」）——未派发调用
  // 既不是失败、也不该推进重试环（那不是「同一调用重复失败」），故在环推进前短路。
  const dispatchFact = normalizeDispatchFact(parsed?.dispatch_fact ?? parsed?.dispatchFact);
  if (dispatchFact === 'not-dispatched') process.exit(0);

  let inputDigest = '';
  try {
    inputDigest = digestOf(['input', toolName, JSON.stringify(parsed?.tool_input ?? null)]);
  } catch {
    inputDigest = digestOf(['input', toolName, 'unserializable']);
  }

  // 重试环（状态读改写；失败静默）。写面用 tmp+rename 原子替换（内部任务-2 批 N-4）——
  // PostToolUse/PostToolUseFailure 双注册下同会话两实例可能并行触发（hooks.json 各注册一次），
  // 裸覆写会让并行读者读到半截 JSON 而把环当首见重置。
  // 双事件双触发去重（评审 R-4）：同一逻辑调用的 PostToolUseFailure/PostToolUse 同形
  // 负载在 60 秒内只推进环一次——以调用键（tool_use_id 优先，缺省 digest+分钟桶）判定。
  // 重试环（内部任务-244 D07：**原子单写者**推进；失败静默）。PostToolUse/PostToolUseFailure
  // 双注册下同会话两实例可能并行触发：原实现两进程各自「读-算-写」，tmp+rename 只防半截
  // JSON、不防丢更新（双计数器各写一份，环永远到不了阈值）。现在推进前先抢以调用键命名的
  // `wx` 占位——抢到者在占位内**复读最新环**再推进并写回，抢不到者本次不写（他者会推进）；
  // 占位持有者 finally 清理，超 TTL（60s，崩溃残留）由下一位隔离回收后单次重试并留痕。
  const now = Date.now();
  const callKey =
    typeof parsed?.tool_use_id === 'string' && parsed.tool_use_id
      ? `uid:${parsed.tool_use_id}`
      : `${toolName}|${inputDigest}|${Math.floor(now / 60000)}`;
  const readRing = () => {
    try {
      return JSON.parse(readFileSync(ringStateFile(sessionId), 'utf8'));
    } catch {
      return { ring: null, lastKey: null, lastKeyTs: 0 };
    }
  };
  // 预读只做双事件去重判定；真正的推进在占位内复读后执行（单写者视角取最新环）。
  const ring = readRing();
  const doubleFire = ring.lastKey === callKey && now - Number(ring.lastKeyTs || 0) < 60000;
  let advanced = { state: { ring: ring.ring ?? null }, triggered: false };
  if (!doubleFire) {
    const placeholder = retryPlaceholderFile(sessionId, callKey);
    const lock = acquireRingPlaceholder(placeholder);
    if (lock.acquired) {
      try {
        const fresh = readRing();
        const stillDouble = fresh.lastKey === callKey && now - Number(fresh.lastKeyTs || 0) < 60000;
        if (!stillDouble) {
          advanced = retryRing({ ring: fresh.ring ?? null }, toolName, inputDigest, now);
          if (advanced.triggered) {
            const rlRecorded = appendIncident(root, {
              id: `rl-${sessionId}-${inputDigest}-${Math.floor(now / RING_WINDOW_MS)}`,
              ts: now,
              session: sessionId,
              taskId,
              skill,
              plugin: null,
              kind: 'retry-loop',
              // 内部任务-20 B/F9（内部决策-033 修正案 1）：记录带 host（三态，与租约侧同源）——归属判等按
              // 「归一 session + host 四态」消费（内部模块-15 内部规则-2）；缺 host 的记录走 legacy 路径。
              host: hostOf({}),
              tool: toolName,
              event: null,
              digest: inputDigest,
              count: RING_THRESHOLD,
              // 内部模块-15 v2 写者接线（评审修复 N5）：retry-loop 同批带分类字段（cause=retry-escalation，
              // 规则表 r-retry-escalation）——升级信号进 cause 派生待排查，不靠读侧回退猜类别。
              ...classifyFact({ kind: 'retry-loop', tool: toolName, host: hostOf({}) }, loadRules()),
              observationSource: 'hook:post-tool',
            });
            if (!rlRecorded.ok) noteHookIssue('post-tool', 'ledger-write-failed'); // 内部任务-244 E01
          }
          try {
            mkdirSync(dirname(ringStateFile(sessionId)), { recursive: true });
            const target = ringStateFile(sessionId);
            const tmp = `${target}.wftmp-${process.pid}`;
            writeFileSync(tmp, JSON.stringify({ ...advanced.state, lastKey: callKey, lastKeyTs: now }));
            renameSync(tmp, target);
          } catch {
            /* 环状态落不下：本次推进作废，下次重来（占位仍在 finally 释放） */
          }
        }
      } finally {
        try {
          rmSync(placeholder, { force: true });
        } catch {
          /* 占位清理失败：下一位按 TTL 陈旧回收 */
        }
      }
    }
    // 抢不到占位（他者推进中/IO 失败）：本次不写环，避免丢更新与双计数。
  }

  // 失败分类（PostToolUseFailure/PostToolUse 双注册下负载同形，幂等靠 id）；
  // 工具动作身份取自 tool_input（内部未决-46/内部任务-DIGESTDISC-1：digest 细分与账本可读都依赖它）
  const classified = classifyResult(toolName, parsed?.tool_result, parsed?.tool_input);
  // 内部模块-15 v2（内部决策-063 D5/决策 24.1）：归因维（delegationDepth/parentSession）与派发事实解析
  // **单源**在 incident-fact.factFromToolPayload——本钩不再局部二次解析（行为不变：
  // depth>0 与父会话非空各自成键、缺省不产键；无分类时该函数零调用）。
  const fact = classified
    ? factFromToolPayload({ toolName, sessionId, host: hostOf({}), taskId, skill, parsed, classified })
    : null;
  if (fact) {
    const useId = typeof parsed?.tool_use_id === 'string' && parsed.tool_use_id ? parsed.tool_use_id : null;
    // 内部模块-15 v2 分类（内部决策-063 D3）：规则表数据资产把结构化事实映射为 cause/severity；
    // 规则表坏/未命中一律保守 unclassified（待排查，不静默排除）。
    const cls = classifyFact(fact, loadRules());
    const tfId = useId ? `tf-${useId}` : `tf-${sessionId}-${classified.digest}-${Math.floor(now / 60000)}`;
    const tfRecorded = appendIncident(root, {
      id: tfId,
      ts: now,
      session: sessionId,
      taskId,
      skill,
      plugin: null,
      kind: 'tool-failure',
      // 内部任务-20 B/F9：同上（host 三态；可选字段，旧记录零校验）
      host: hostOf({}),
      tool: toolName,
      event: null,
      digest: classified.digest,
      // 可读性面（内部未决-46，视角二 #2）：类别名与退出码都是非原文事实，进记录让账本可读；
      // errorClass ∈ error-field|error-flag|exit-nonzero|stderr（内部规则-2 / 内部接口-19 同批回写）
      errorClass: classified.errorClass,
      exitCode: classified.exitCode,
      // 内部未决-110（内部任务-52）：同参数判据（与重试环 inputDigest 同源）——成功路径自愈的匹配键；
      // 加法式可选字段，旧记录零校验（内部接口-19 compatPolicy: strict-backward）。
      inputDigest,
      // 内部任务-20 B/F3（内部决策-033 修正案 1）：可选宿主错误码——形态化与语义作用域均在
      // `classifyResult` 内收口（本处只透传，不重复判定）；缺省**不产键** ⇒ 旧记录形态零变化。
      ...(classified.errorCode !== undefined ? { errorCode: classified.errorCode } : {}),
      // 内部模块-15 v2（内部决策-063 D3/D5）：分类与归因审计字段（全部可选、加法兼容）
      cause: cls.cause,
      severity: cls.severity,
      ruleId: cls.ruleId,
      rulesVersion: cls.rulesVersion,
      observationSource: 'hook:post-tool',
      dispatchFact: fact.dispatchFact,
      ...(fact.delegationDepth !== undefined ? { delegationDepth: fact.delegationDepth } : {}),
      ...(fact.parentSession !== undefined ? { parentSession: fact.parentSession } : {}),
    });
    if (!tfRecorded.ok) noteHookIssue('post-tool', 'ledger-write-failed'); // 内部任务-244 E01
    if (tfRecorded.ok) {
      // 内部任务-244 P01：失败记录入重试自愈索引（纯缓存；写失败可见但不阻断记录主职责）
      if (process.env.WF_POSTTOOL_FORCE_INDEX_FAIL === '1') noteHookIssue('post-tool', 'index-degraded');
      else if (!rememberRetryOpenIndex(runtimeStateDir(), sessionId, tfId).ok) noteHookIssue('post-tool', 'index-degraded');
    }
  } else {
    // 内部未决-110（内部任务-52）+ 内部模块-15 v2（内部决策-063 D4）：同参数随即成功——对窗内本会话同
    // (tool, inputDigest) 的 open 态 tool-failure 自愈收口。**热路径作用域**：只传
    // `retry-heal`（不得顺带归档证据类、不得解 lease 族——成功一次不等于机制好了）；
    // 处置失败经 noteHookIssue 留痕（内部规则-7 静默面义务），不反噬主职责。
    // 内部任务-244 P01：索引缓存优先（hit → 回读热账本复核后批量收口）；miss → 全量回扫 fail-open
    // 语义不变（索引是纯缓存，不是事实源——D06：快照不复用于写面）。
    const indexed = healRetryOpenByIndex(root, {
      stateDir: runtimeStateDir(),
      session: sessionId,
      host: hostOf({}),
      tool: toolName,
      inputDigest,
      windowMs: RING_WINDOW_MS,
      now,
      script: 'post-tool',
    });
    if (indexed.hit) {
      if (indexed.failed > 0) noteHookIssue('post-tool', 'disposition-failed');
    } else {
      const disp = applyDispositions(root, {
        sources: ['retry-heal'],
        retry: { session: sessionId, host: hostOf({}), tool: toolName, inputDigest, windowMs: RING_WINDOW_MS },
        now,
      });
      if (disp.failed > 0) noteHookIssue('post-tool', 'disposition-failed');
    }
  }
  // 内部任务-352（内部模块-8 内部规则-8 / 内部验收-47）：答复通道只读租约提示——仅 ask 族成功答复时进入；
  // 门控与文案全部在 task-lease-lib.answerChannelLeaseHint（只读：不签发/不激活/不写租约状态）。
  // 失败/非 ask/已声明/委派/域外/无挑战一律零输出；异常 fail-open 不影响纯记录主职责。
  // 只在 PostToolUse 成功面发射：失败事件（PostToolUseFailure）即便分类为 null 也不得走提示路径。
  if (classified === null && isAskUserQuestionTool(toolName) && parsed?.hook_event_name !== 'PostToolUseFailure') {
    try {
      const delegationDepth = Number(parsed?.delegation_depth ?? parsed?.delegationDepth);
      const hints = answerChannelLeaseHint({
        cwd,
        sessionId: sessionId === 'default' ? '' : sessionId,
        now,
        declarePrefix: declareCmdPrefix(),
        suggest: (key) => soleTaskIdSuggestion(key, { excludeSessionId: sessionId === 'default' ? null : sessionId }) ?? '<任务号>',
        delegated: Number.isSafeInteger(delegationDepth) && delegationDepth > 0,
      });
      if (hints.length > 0) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hints.join('\n') },
        }) + '\n');
      }
    } catch {
      /* 提示失败 fail-open：纯记录主职责不受影响 */
    }
  }
  process.exit(0); // 纯记录钩：除 内部任务-352 答复提示例外，无 stdout、恒 exit 0
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
    process.exit(selftest()); // selftest 失败须可见退 1：陷阱不装（评审 P1，B-M8-4 优先）
  }
  installHookErrorTrap('post-tool'); // B1①：漏网抛错落 hook-errors.jsonl（fail-open 不破）
  runHookMain('post-tool', main);
}
