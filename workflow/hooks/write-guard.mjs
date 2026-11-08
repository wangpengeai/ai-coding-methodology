// 文件：write-guard.mjs
// 描述：写仓闸 PreToolUse 第 4 处理器（内部决策-066 D8，内部任务-261）。P2 曾为 shadow-only；P3 起：
//       shell 族按 write-policy 分类与租约声明裁决，C1-C4 命中且无声明/非受信 → deny(2)（信封含
//       完整可复制声明命令）；C5 恒 shadow record；声明（租约 scriptWrites[] 非空）或受信命令放行；
//       edit 族记录目标路径（apply_patch 按 `*** (Add|Update|Delete) File:` 抽多路径）；
//       会话首个 PreToolUse 落 baseline 快照（失败记 degraded 行，不阻断）。输出协议/payload
//       分流对齐 check-careful.mjs；钩内异常一律 fail-open（exit 0 + hook-errors 留痕）。
//       内部任务-332：execDir/目标归一锚＝canonical（repoRelOf）——符号链接形态 cwd 不再使受检判定静默失效。
//       路径状态目录走 stateRootFor(payload cwd 键)（WF_ROUTING_STATE_DIR 注入缝）。
//       内部任务-342（2026-11-06）：归因 taskId 仅本会话具名租约；shell 行带 execDir；edit 行一次归一——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；无 shell 依赖；不承诺 shell 沙箱。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { emitPreToolUseDecision, installHookErrorTrap, pickString, readStdin, runHookMain } from './hook-lib.mjs';
import { canonicalRoot, projectKey, activationRoot, stateRootFor } from './routing-lib.mjs';
import { readActiveLease, currentChallengeToken, ownNamedLease } from './task-lease-lib.mjs';
import { familyOf } from '../scripts/lib/tool-families.mjs';
import { classifyShellWrite, decideWriteIntent, resolveMode } from '../scripts/lib/write-policy.mjs';
import { appendJournal, baselinePath, projectDigestOf, repoRelOf, resolveBaselineBudget, sidDigestOf, snapshotBaseline } from '../scripts/lib/write-audit.mjs';
import { missingAcks, requiredProjectSkills } from '../scripts/lib/project-skills.mjs';

/** 声明命令绝对路径（deny 文案给可复制命令；统一正斜杠，跨平台一致）。 */
const DECLARE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'routing-declare.mjs').replaceAll('\\', '/');

/**
 * 声明命令公共组装（内部任务-339/内部未决-254⑤）：challenge 取令牌（无租约时用 currentChallengeToken
 * 取本轮令牌——计划步骤 17 要求，仍不可得才退回占位）、租约三元组与
 * --plan/--plan-root/--via/--exempt 拼接单源（plan-execution/桥接/exempt 声明缺这些会 exit 1）；
 * 差异点＝声明旗标名与理由文案；--exempt 块仅 generic 通道（denyMessage）拼（旧行为等价）。
 */
function buildDeclareCommand(lease, key, sessionId, { editCode = false } = {}) {
  let challenge = null;
  if (lease?.leaseId === undefined) {
    try {
      challenge = currentChallengeToken(key, sessionId === 'default' ? null : sessionId);
    } catch {
      challenge = null;
    }
  }
  const token = lease?.leaseId ?? challenge?.leaseId ?? '<本轮令牌>';
  const skill = lease?.skill ?? '<命中skill名>';
  const taskId = lease?.taskId ?? '<任务号>';
  const parts = [`node '${DECLARE_SCRIPT}'`, skill, '--lease', token, '--task-id', taskId];
  if (typeof lease?.planPath === 'string' && lease.planPath) parts.push('--plan', `'${lease.planPath.replaceAll('\\', '/')}'`);
  if (typeof lease?.planRoot === 'string' && lease.planRoot) parts.push('--plan-root', `'${lease.planRoot.replaceAll('\\', '/')}'`);
  if (typeof lease?.via === 'string' && lease.via) parts.push('--via', lease.via);
  const hasExempt = typeof lease?.exempt === 'string' && lease.exempt;
  const hasExemptScope = typeof lease?.exemptScope === 'string' && lease.exemptScope;
  // stage 复审 #6：--exempt 块仅 generic 通道（denyMessage）拼——窄声明文案旧行为无此块，保持等价。
  if (!editCode && hasExempt && hasExemptScope) {
    parts.push('--exempt', `'${lease.exempt}'`, '--exempt-scope', String(lease.exemptScope), '--exempt-src', String(lease.exemptSrc ?? 'user'));
  }
  parts.push(
    editCode ? '--script-edit-code' : '--script-write',
    editCode ? "'<理由≥8 字：本轮脚本编辑受检路径的目的/范围>'" : "'<理由≥8 字：本轮脚本写仓的目的/范围>'",
  );
  const legacyNote = hasExempt && !hasExemptScope
    ? '\n  注意：旧租约缺 exemptScope，无法重建可执行豁免命令；请用当前用户消息中的豁免原话重新声明并加 --exempt-scope plan|review。'
    : '';
  return { parts, legacyNote };
}

/** 内部决策-070 D5（内部任务-341）：项目 skill 必载集合未 ack 的修复文案（ack 旗标附在声明命令尾部）。 */
function projectSkillDenyMessage(lease, key, sessionId, missing) {
  const { parts } = buildDeclareCommand(lease, key, sessionId);
  for (const skill of missing) parts.push('--project-skill', skill.name);
  const loadPaths = missing.map((skill) => skill.path).join('、');
  return `[write-guard] 已阻断：项目 skill 必载集合未 ack（缺 ${missing.map((skill) => skill.name).join('、')}）。先加载 ${loadPaths}，再追加 ack 后重声明：\n  ${parts.join(' ')}`;
}

function denyMessage(lease, cls, key, sessionId) {
  const { parts, legacyNote } = buildDeclareCommand(lease, key, sessionId);
  return `[write-guard] 已阻断：${cls} 类仓库脚本写未声明。请改用 Edit/Write，或先声明后重试：\n  ${parts.join(' ')}${legacyNote}`;
}

/** 受检路径拒绝文案（重定向写：任何声明不放行；内部任务-285/内部决策-066 修正案 1 内部模块-3；内部任务-339/内部未决-254① 扩至逐目标恒拒，去「C1」限定）。 */
function trackedRejectMessage() {
  return '[write-guard] 已阻断：重定向写受检路径（git 跟踪）——本类不可经脚本声明放行。请改用 Edit/Write，或使用受信写者（mechanical-edit/evidence-gen，ADR-066 D2）；确需脚本批量改仓请改走非受检目标或先评估目标。';
}

/** 受检路径窄声明文案（C2–C4：只认 `--script-edit-code`；内部任务-285/内部决策-066 修正案 1 内部模块-2；内部任务-339/内部未决-254⑤ 组装单源化）。 */
function trackedNarrowDeclareMessage(lease, cls, key, sessionId) {
  const { parts } = buildDeclareCommand(lease, key, sessionId, { editCode: true });
  return `[write-guard] 已阻断：${cls} 类脚本编辑受检路径（git 跟踪）——通用 --script-write 不足，须改声明为本轮更窄级别后重试：\n  ${parts.join(' ')}`;
}

/** would-be-deny：该命令在默认 enforce 档是否会拦——shadow 期也可见（D6/D7 观测面；内部任务-339/内部未决-254③：
 * 语义改「enforce 档会拦」——generic 声明对受检目标不算数（declared=true 但 trackedTierViolation
 * 在场时 enforce 仍会 deny），旧公式在此漏报）。 */
function wouldBeDenyOf(decision) {
  return ['C1', 'C2', 'C3', 'C4'].includes(decision.cls) && decision.trusted !== true && (decision.declared !== true || decision.trackedTierViolation === true);
}

/** 完整命令摘要（D6「shell 族记录命令摘要」；report/回放据此回指命令，不存明文）。 */
function cmdDigest(cmd) {
  return createHash('sha256').update(String(cmd)).digest('hex');
}

/**
 * 内部任务-311 F5b：受检路径 `git ls-files` 预算——env 优先（仅测试/验证注入；可升可降以便确定性构造降级），
 * env 缺省时回落 1500ms，与旧版逐字节同行为。
 * @returns {number} 超时毫秒
 */
function trackedTimeoutBudget() {
  return resolveBaselineBudget() ?? 1500;
}

/**
 * 受检路径（git 跟踪）判定（内部任务-285/内部决策-066 修正案 1 内部模块-3）：一次 `git ls-files -z` 全索引列举后
 * 本地匹配——**不用 pathspec**（code-review r2 实证：win32 `core.ignorecase=true` 下
 * `git ls-files -- docs/readme.md` 仍按大小写敏感 pathspec 返回空，`--icase-pathspecs` 才命中；
 * 全列举＋本地折叠与 FS/pathspec 语义解耦）。失败/超时 → 全部 unknown（fail-open：沿用现行
 * 裁决并记 degraded，不冒充受检判定）。裸 `git` 调用在此带失败降级语义（AGENTS 已知陷阱惯例）。
 * @returns {{isTracked: (target: string) => 'tracked'|'untracked'|'unknown', degraded: boolean, ignorecaseReadFailed: boolean}}
 */
function makeTrackedLookup({ root, execDir, targets }) {
  const candidates = [...new Set(targets.map((t) => repoRelOf(root, t, execDir)).filter((r) => r !== '' && !isAbsolute(r) && !r.startsWith('..')))];
  if (candidates.length === 0) return { isTracked: () => 'unknown', degraded: false, ignorecaseReadFailed: false };
  let result;
  try {
    result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      // 失败降级（AGENTS 裸 git 惯例）：并行验证集负载下 spawn 抖动实测 >800ms，取 1500ms 留余量；
      // 内部任务-311 F5b：env 缝可升可降（仅测试/验证注入），缺省仍 1500 同旧行为。
      timeout: trackedTimeoutBudget(),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return { isTracked: () => 'unknown', degraded: true, ignorecaseReadFailed: false };
  }
  // 失败降级：spawn 错误/非 0（含超时杀进程）→ unknown；不得把读失败当「非受检」放行。
  if (result.error || result.status !== 0) return { isTracked: () => 'unknown', degraded: true, ignorecaseReadFailed: false };
  // 内部任务-285 code-review r1/r2：win32/darwin 默认大小写不敏感 FS 上，git 索引保留原始大小写而
  // 目标可能大小写不同——不折叠会误判 untracked（受检 C1/C2 分级失效；同 内部任务-244 S02 冻结
  // 绕过教训）。折叠只作**额外命中**（大小写敏感卷上过度拦截优先于漏拦）。
  // 内部任务-339/内部未决-254④：折叠按 `core.ignorecase=false` 显式配置关闭（win32/darwin 才探测，读
  // 失败/杂值回落平台默认折叠＝现状 fail 方向；`ignorecaseReadFailed` 仅在探测未获可用判据
  // 时置 true——成功读取 true/false 均不置位）。linux 平台零新增 spawn。
  let ignoreCase = process.platform === 'win32' || process.platform === 'darwin';
  let ignorecaseReadFailed = false;
  if (ignoreCase) {
    let cfg = null;
    try {
      cfg = spawnSync('git', ['-C', root, 'config', '--get', 'core.ignorecase'], {
        encoding: 'utf8',
        // stage 复审 #3：独立小预算（读不到即回落平台默认折叠＝既有语义）——不与 ls-files 的
        // 1500ms 叠加超出钩子 timeoutMs=2000（最坏叠加会使宿主杀钩→fail-open 丢 deny）。
        timeout: Math.min(trackedTimeoutBudget(), 300),
        windowsHide: true,
      });
    } catch {
      cfg = null;
    }
    const value = cfg && !cfg.error && cfg.status === 0 ? String(cfg.stdout ?? '').trim() : null;
    if (value === 'false') ignoreCase = false;
    else if (value !== 'true') ignorecaseReadFailed = true; // 未设置（git 默认按 FS 探测写值，未设置视平台默认）/读失败/杂值——观测面如实
  }
  const tracked = new Set(String(result.stdout ?? '').split('\0').filter(Boolean));
  const trackedFolded = ignoreCase ? new Set([...tracked].map((p) => p.toLowerCase())) : null;
  return {
    isTracked: (target) => {
      const rel = repoRelOf(root, target, execDir);
      if (tracked.has(rel)) return 'tracked';
      if (trackedFolded !== null && trackedFolded.has(String(rel).toLowerCase())) return 'tracked';
      return 'untracked';
    },
    degraded: false,
    ignorecaseReadFailed,
  };
}

/** 项目覆盖配置读取（缺失/坏文件不抛，由 resolveMode 统一告警）。 */
function readModeConfig(root) {
  try {
    return readFileSync(join(root, '.workflow', 'write-guard.json'), 'utf8');
  } catch {
    return null;
  }
}

/** 读当前会话可见租约（失败视为无租约，不阻断）。 */
function readLeaseSafe(key, sessionId) {
  try {
    const r = readActiveLease(key, Date.now(), { sessionId });
    return r && r.valid ? r.lease : null;
  } catch {
    return null;
  }
}

/**
 * 归因 taskId（内部任务-342/内部决策-066 修正案 2 内部模块-1）：仅当可见租约属于**本会话具名桶**且 sessionId 非空时
 * 返回其 taskId；null 桶/他会话租约不参与归因（无本会话租约 → null）。闸判定仍用 readLeaseSafe 的
 * 可见租约（补签 null 桶可见性语义不变）；本函数只服务 journal 归因字段。
 */
function attributionTaskId(lease, sessionId) {
  const own = ownNamedLease(lease, sessionId);
  return own && typeof own.taskId === 'string' && own.taskId !== '' ? own.taskId : null;
}

/** 会话首调基线：已存在不覆盖；失败只记 journal degraded 行（不抛）。 */
function ensureBaseline({ stateDir, sidDigest, projDigest, root, sessionId }) {
  if (existsSync(baselinePath(stateDir, sidDigest))) return;
  try {
    const r = snapshotBaseline({ stateDir, sidDigest, root, gitTimeoutMs: resolveBaselineBudget() });
    if (r.status !== 'ok') appendJournal(stateDir, projDigest, { tool: 'baseline', status: 'degraded', reason: r.reason ?? 'unknown', sid: sessionId, sidDigest });
  } catch {
    try { appendJournal(stateDir, projDigest, { tool: 'baseline', status: 'degraded', reason: 'baseline-exception', sid: sessionId }); } catch { /* 忽略 */ }
  }
}

/** 抽 edit 族目标路径（多路径：apply_patch 文本块）。 */
function editTargets(payload, toolName) {
  const direct = pickString(payload, ['tool_input', 'file_path']) || pickString(payload, ['tool_input', 'path']);
  const out = [];
  if (direct) out.push(direct);
  const patch = pickString(payload, ['tool_input', 'patch']) || pickString(payload, ['tool_input', 'input']) || pickString(payload, ['tool_input', 'content']);
  if (patch) {
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(patch)) !== null) {
      const p = m[1].trim();
      if (p) out.push(p);
    }
  }
  return [...new Set(out)];
}

/**
 * 主流程（fail-open：所有异常由 runHookMain 改写为 exit 0）。
 */
async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // 负载不可解析：fail-open
  }
  const toolName = pickString(payload, ['tool_name']);
  const family = familyOf(toolName);
  if (family === 'other') return;
  const cwd = pickString(payload, ['cwd']) || process.cwd();
  const root = activationRoot(cwd);
  if (root === null) return; // 激活域外：不判定不记账
  const key = projectKey(root);
  const stateDir = stateRootFor(key); // 计划步骤10：按 payload.cwd 键取状态根（Kimi/MCode shim cwd=包根）
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'default';
  const sidDigest = sidDigestOf(sessionId);
  const projDigest = projectDigestOf(key);
  if (process.env.GUARD_HOOK_INJECT_CRASH === '1') throw new Error('inject-crash'); // fail-open 验证缝
  ensureBaseline({ stateDir, sidDigest, projDigest, root, sessionId });
  const lease = readLeaseSafe(key, sessionId);

  if (family === 'shell') {
    const cmd = pickString(payload, ['tool_input', 'command']);
    if (cmd === '') return; // 无命令字段：非写意图面
    // 内部任务-285：目标解析基准单点＝执行目录（tool_input.workdir → payload.cwd），分类/归一/git
    // pathspec 三处同源（子目录 cwd 与 `../` 目标不得错位成「非受检」）。
    // 内部任务-332：execDir 与 root 同锚 canonical（root＝activationRoot 恒 realpath 形态；未解析
    // 符号链接形态 cwd——darwin /var→/private/var、win32 junction——会使目标全判仓外，受检
    // 判定静默失效）。canonicalRoot 失败回退 normalize＝词法（今日行为），不抛。
    const execDir = canonicalRoot(pickString(payload, ['tool_input', 'workdir']) || cwd);
    const mode = resolveMode({
      envMode: process.env.WF_WRITE_GUARD_MODE,
      envTrackedTier: process.env.WF_WRITE_GUARD_TRACKED_TIER,
      configRaw: readModeConfig(root),
    });
    const pre = classifyShellWrite(cmd, { root, cwd: execDir });
    // r1 三维（正确性#1）：受检查询目标面并入 redirects——`>tracked.txt`（无空格）等形态下
    // 重定向目标不进分类 targets，逐目标恒拒须能对它查询受检态（isTracked 闭包是全索引查询）。
    const trackedProbe = [...pre.targets, ...pre.redirects];
    const lookup = ['C1', 'C2', 'C3', 'C4'].includes(pre.cls) && trackedProbe.length > 0
      ? makeTrackedLookup({ root, execDir, targets: trackedProbe })
      : { isTracked: () => 'unknown', degraded: false, ignorecaseReadFailed: false };
    const decision = decideWriteIntent({
      cmd,
      root,
      cwd: execDir,
      mode,
      scriptWrites: lease?.scriptWrites,
      scriptEditCode: lease?.scriptEditCode,
      isTracked: lookup.isTracked,
    });
    const trackedDegraded = decision.trackedDegraded === true || lookup.degraded;
    appendJournal(stateDir, projDigest, {
      tool: 'shell',
      family: 'shell',
      cls: decision.cls,
      trusted: decision.trusted,
      declared: decision.declared,
      decision: decision.decision,
      wouldBeDeny: wouldBeDenyOf(decision),
      reason: decision.reason,
      targets: decision.targets,
      tier: decision.tier,
      trackedTargets: decision.trackedTargets,
      // 内部任务-339/内部未决-254③：受检分级违例入 journal（shadow 观测面）；④：折叠探测未获可用判据观测。
      trackedTierViolation: decision.trackedTierViolation === true,
      ignorecaseReadFailed: lookup.ignorecaseReadFailed === true,
      degradedReason: trackedDegraded ? 'tracked-unknown' : null,
      cmdDigest: cmdDigest(cmd),
      // 内部任务-285/内部决策-066 D6：tracked 判定降级并入既有 degraded 口径（不冒充 clean、不改 write-audit）。
      degraded: decision.degraded === true || trackedDegraded,
      sid: sessionId,
      sidDigest,
      taskId: attributionTaskId(lease, sessionId),
      execDir,
      shape: 'command',
    });
    if (lookup.degraded) {
      process.stderr.write('[write-guard] 受检路径判定降级（git 不可用/超时）——本轮回落现行裁决并记 degraded（不冒充受检判定）\n');
    }
    // P3 步骤 17：enforce 且 C1-C4 命中且无声明/非受信 → deny(2)；声明/受信已在 decide 内放行。
    // 内部任务-285：受检路径两形态用专属文案（重定向拒绝式〔内部任务-339 起含混合形态逐目标恒拒〕＝不可声明放行；其余受检类＝更窄声明命令）。
    // 内部决策-070 D5（内部任务-341）：已声明/未受信放行的 C1–C4 真实写意图，若项目必载集合未 ack → deny。
    // 既有 deny 三态（含 C1 受检恒拒）优先；C5/未分类与 shadow 记录态不受本义务影响（内部决策-066 D8）。
    let projectSkillMissing = null;
    if (mode.modes?.[decision.cls] === 'enforce' && decision.decision === 'allow' && decision.trusted !== true && ['C1', 'C2', 'C3', 'C4'].includes(decision.cls)) {
      try {
        const info = requiredProjectSkills({ projectRoot: key, env: process.env });
        if (info.source === 'scan-error' || info.warning) {
          try { process.stderr.write(`[write-guard] 项目 skill 扫描异常（按源扫描失败，fail-open）：${info.warning ?? '未知'}\n`); } catch { /* stderr 不可写则静默 */ }
        }
        if (info.source === 'scan-error') {
          projectSkillMissing = null;
        } else if (info.required.length > 0) {
          const miss = missingAcks(info.required, lease);
          if (miss.length > 0) projectSkillMissing = miss;
        }
      } catch (e) {
        try { process.stderr.write(`[write-guard] 项目 skill 判定异常（fail-open）：${e?.message ?? e}\n`); } catch { /* stderr 不可写则静默 */ }
        projectSkillMissing = null; // fail-open：项目 skill 判定异常不阻断
      }
    }
    if (decision.decision === 'deny') {
      if (decision.reason === 'tracked-redirect-rejected') emitPreToolUseDecision('deny', trackedRejectMessage());
      else if (decision.reason === 'tracked-needs-script-edit-code') emitPreToolUseDecision('deny', trackedNarrowDeclareMessage(lease, decision.cls, key, sessionId));
      else emitPreToolUseDecision('deny', denyMessage(lease, decision.cls, key, sessionId));
    } else if (projectSkillMissing) {
      emitPreToolUseDecision('deny', projectSkillDenyMessage(lease, key, sessionId, projectSkillMissing));
    }
    return;
  }

  if (family === 'edit') {
    const targets = editTargets(payload, toolName);
    const editExecDir = canonicalRoot(cwd); // 子目录 cwd 下相对 file_path 的归一同锚（正确性维阶段 L #7）
    if (targets.length === 0) {
      appendJournal(stateDir, projDigest, { tool: 'edit', shape: 'unknown', degraded: true, sid: sessionId, sidDigest, taskId: attributionTaskId(lease, sessionId) });
      return;
    }
    for (const path of targets) {
      // 写侧一次归一到仓相对（execDir 只在此参与），行内不带 execDir——否则报表回退 root 会二次解析
      // （子目录 cwd 下 'sub/a.txt' + execDir '/repo/sub' → 'sub/sub/a.txt'，正确性维修复复审 #1）。
      appendJournal(stateDir, projDigest, {
        tool: 'edit',
        path: repoRelOf(root, path, editExecDir),
        shape: 'file',
        sid: sessionId,
        sidDigest,
        taskId: attributionTaskId(lease, sessionId),
      });
    }
  }
}

/** 内置自检（B-M8-4）：纯函数分类/裁决断言＋journal 运行态写入（tmp 注入缝）。 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  try {
    const mode = resolveMode({});
    check('默认 C1 enforce', mode.modes.C1 === 'enforce');
    check('C5 恒 shadow', mode.modes.C5 === 'shadow');
    check('C1 识别重定向', decideWriteIntent({ cmd: 'echo x > a.txt', root: process.cwd(), mode }).cls === 'C1');
    const shadow = resolveMode({ envMode: 'shadow' });
    check('shadow 记 record', decideWriteIntent({ cmd: 'echo x > a.txt', root: process.cwd(), mode: shadow }).decision === 'record');
    check('受信放行', decideWriteIntent({ cmd: 'node workflow/scripts/mechanical-edit.mjs --selftest', root: process.cwd(), mode }).decision === 'allow');
    // 内部任务-339（内部未决-254①③，计划任务 4 验收项）：混合形态逐目标恒拒＋wouldBeDeny「enforce 档会拦」语义。
    check('混合形态重定向受检恒拒', decideWriteIntent({ cmd: "sed -i 'x' f > tracked.txt", root: process.cwd(), mode, scriptEditCode: [{ reason: '窄声明不得放行重定向受检目标' }], isTracked: () => 'tracked' }).reason === 'tracked-redirect-rejected');
    check('wouldBeDeny 含受检违例', wouldBeDenyOf(decideWriteIntent({ cmd: "sed -i 's/a/b/' tracked.txt", root: process.cwd(), mode: resolveMode({ envTrackedTier: 'shadow' }), scriptWrites: [{ reason: 'generic 声明不足以放行受检目标' }], isTracked: () => 'tracked' })) === true);
    check('窄声明足额无违例', decideWriteIntent({ cmd: "sed -i 's/a/b/' tracked.txt", root: process.cwd(), mode: resolveMode({ envTrackedTier: 'shadow' }), scriptEditCode: [{ reason: '窄声明足额放行受检就地编辑' }], isTracked: () => 'tracked' }).trackedTierViolation === false);
    check('编辑族清单', ['edit', 'write', 'applypatch', 'str_replace_editor'].every((t) => familyOf(t) === 'edit'));
    check('shell 族清单', ['bash', 'pwsh'].every((t) => familyOf(t) === 'shell'));
    // 内部任务-311 F5b：受检路径预算缝（env 优先、缺省 1500；env=1 可降用于确定性降级）
    const savedBudget = process.env.WF_WRITE_AUDIT_BASELINE_BUDGET_MS;
    delete process.env.WF_WRITE_AUDIT_BASELINE_BUDGET_MS;
    check('受检路径预算缺省 1500', trackedTimeoutBudget() === 1500);
    process.env.WF_WRITE_AUDIT_BASELINE_BUDGET_MS = '1';
    check('受检路径预算 env=1 可降（确定性降级面）', trackedTimeoutBudget() === 1);
    if (savedBudget === undefined) delete process.env.WF_WRITE_AUDIT_BASELINE_BUDGET_MS;
    else process.env.WF_WRITE_AUDIT_BASELINE_BUDGET_MS = savedBudget;
    // 内部任务-285：受检路径分级矩阵（纯函数注入 isTracked，不触 git）
    const tracked = () => 'tracked';
    const untracked = () => 'untracked';
    const sw = [{ reason: '本轮批量机械替换执行', declaredAt: new Date().toISOString() }];
    const se = [{ reason: '本轮脚本编辑受检文件', declaredAt: new Date().toISOString() }];
    check(
      '受检 C1 重定向直接拒绝（即便已声明 scriptWrites）',
      decideWriteIntent({ cmd: 'echo x > a.txt', root: process.cwd(), mode, isTracked: tracked, scriptWrites: sw }).reason === 'tracked-redirect-rejected',
    );
    check(
      '受检 C2 仅 scriptWrites 不足',
      decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: process.cwd(), mode, isTracked: tracked, scriptWrites: sw }).reason === 'tracked-needs-script-edit-code',
    );
    check(
      '受检 C2 窄声明放行',
      decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: process.cwd(), mode, isTracked: tracked, scriptEditCode: se }).reason === 'declared-edit-code',
    );
    check(
      '非受检 C2 通用声明仍放行（现行为不扩严）',
      decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: process.cwd(), mode, isTracked: untracked, scriptWrites: sw }).decision === 'allow',
    );
    const trackedShadow = resolveMode({ envTrackedTier: 'shadow' });
    check(
      'trackedTier=shadow 只记录不拦',
      decideWriteIntent({ cmd: 'echo x > a.txt', root: process.cwd(), mode: trackedShadow, isTracked: tracked }).decision === 'record',
    );
    check(
      'unknown 目标记 trackedDegraded 且不冒充受检',
      decideWriteIntent({ cmd: 'echo x > a.txt', root: process.cwd(), mode, isTracked: () => 'unknown' }).trackedDegraded === true,
    );
  } catch (err) {
    checks.push([`异常：${err?.message ?? err}`, false]);
  }
  const fail = checks.filter(([, ok]) => !ok);
  if (fail.length > 0) {
    process.stdout.write(`FAIL ${fail.length} 项：${fail.map(([n]) => n).join('；')}\n`);
    return 1;
  }
  process.stdout.write(`PASS ${checks.length} 项\nOK write-guard selftest（${checks.length} 项通过，enforce=true）\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('用法：write-guard.mjs [选项]\n  （无参数）从 stdin 读宿主 JSON 负载，shadow 记录写意图\n  --selftest 运行内置自检（B-M8-4）\n  --help    显示本说明\n');
    process.exit(0);
  }
  installHookErrorTrap('write-guard');
  runHookMain('write-guard', main);
}
