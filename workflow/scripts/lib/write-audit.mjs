// 文件：write-audit.mjs
// 描述：写归因账（内部决策-066 D6，内部任务-261）——运行态三文件与 Stop 归因算法：
//       journal（wf-write-journal-<projDigest>.jsonl，项目键控、Append-only；轮转在 Stop 侧做，
//       不进 2s PreToolUse 预算）、baseline（wf-write-baseline-<sidDigest>.json，会话首个
//       PreToolUse 的 git 快照）、report（wf-write-report-<sidDigest>.json，每次 Stop 原子覆写，
//       含 sidDigest/ts/taskId/status/external/degradedReasons/rows/attributed/vcsHint/consecutiveDegraded）。
//       写者溯源五态（内部决策-066 修正案 2）：attributed（edit/trusted/declared/delegated/internal）、preexisting、
//       external（他会话跨任务写，带 writer sidDigest/taskId；单列顶层计数、不入 attributed）、
//       unattributed（无任何写者记录）、degraded；
//       degraded 为吸收态（git 失败/超时、基线缺失或损坏、journal 坏行/unknown edit/degraded 行
//       均不得冒充 clean）。本会话归因只消费「本会话」journal 行（同 sidDigest 或 sha16(原始 sid) 相等）；
//       他会话行（sid 非空且非本会话）三来源（edit/shell/internal targets）另作 delegated/external 证据
//       （taskId 相同计 delegated、其余计 external），不参与本会话归属统计。
//       内部任务-332：目标归一锚＝canonical（repoRelOf 导出，write-guard 共用）。
//       内部任务-342（2026-11-06）：写者溯源五态（external/attributed.internal/delegated 三来源/ownTouched/execDir 一次归一）＋appendInternalJournal——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；git 调用带显式 timeout 与失败降级注释；LF/UTF-8。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalPath, canonicalRoot } from '../../hooks/routing-lib.mjs';

const JOURNAL_MAX_LINES = 5000;
const BASELINE_GIT_TIMEOUT_MS = 800; // 会话首个 PreToolUse 预算
const REPORT_GIT_TIMEOUT_MS = 1500; // Stop/task-recap 预算（5000ms 内）

/** 短摘要（与 write-guard 运行态文件名口径一致）。 */
function sha16(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** journal 路径（项目键控）。 */
export function journalPath(stateDir, projDigest) {
  return join(stateDir, `wf-write-journal-${projDigest}.jsonl`);
}

/** baseline 路径（会话键控）。 */
export function baselinePath(stateDir, sidDigest) {
  return join(stateDir, `wf-write-baseline-${sidDigest}.json`);
}

/** report 路径（会话键控）。 */
export function reportPath(stateDir, sidDigest) {
  return join(stateDir, `wf-write-report-${sidDigest}.json`);
}

/** journal 行追加（Append-only；轮转由 Stop 侧 rotateJournal 负责，避免 PreToolUse 热路径读全文件）。 */
export function appendJournal(stateDir, projDigest, entry) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(journalPath(stateDir, projDigest), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

/**
 * 会话键摘要（内部任务-342 导出）：与 hook-lib.digest16 同算法（sha256 前 16 位）；分层原因暂不迁移
 * （已知在 hook-lib/verify-gate 存在同构重复，待收敛批统一）。两处算法变更须同步。
 */
export function sidDigestOf(sessionId) {
  return sha16(sessionId);
}

/** 项目键摘要（与 write-guard 的 projDigest 同口径，内部任务-342 单源导出）。 */
export function projectDigestOf(key) {
  return sha16(key);
}

/**
 * 工作流内部写 journal 行（内部任务-342/内部决策-066 修正案 2 内部模块-3）：routing-declare 的 claim/release/rollback
 * 等非模型写在写仓后必须追加本行，供 Stop 报表归 attributed/internal 或 delegated/external。
 * owner 不可识别（null 桶声明）时 sid/sidDigest 记 null（报表 writer=null，不冒充 external）。
 * 写失败抛由调用方 fail-open（声明不阻断）。
 */
export function appendInternalJournal(stateDir, projDigest, { sid = null, taskId = null, targets = [] } = {}) {
  const row = {
    tool: 'internal',
    shape: 'internal',
    sid: typeof sid === 'string' && sid !== '' ? sid : null,
    sidDigest: typeof sid === 'string' && sid !== '' ? sidDigestOf(sid) : null,
    taskId: typeof taskId === 'string' && taskId !== '' ? taskId : null,
    targets: Array.isArray(targets) ? targets.map(String) : [],
  };
  appendJournal(stateDir, projDigest, row);
}

/**
 * 读 journal：返回可解析行与坏行计数（坏行由 report 记 degraded，不得静默冒充 clean）。
 * @returns {{rows: object[], badLines: number, totalLines: number}}
 */
export function readJournal(stateDir, projDigest) {
  const file = journalPath(stateDir, projDigest);
  if (!existsSync(file)) return { rows: [], badLines: 0, totalLines: 0 };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  let badLines = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { badLines += 1; }
  }
  return { rows, badLines, totalLines: lines.length };
}

/** Stop 侧 journal 轮转（>5000 行保留尾部 2500 行）；失败不阻断。 */
export function rotateJournal(stateDir, projDigest) {
  const file = journalPath(stateDir, projDigest);
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= JOURNAL_MAX_LINES) return false;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${lines.slice(-Math.floor(JOURNAL_MAX_LINES / 2)).join('\n')}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 `git status --porcelain -z -uall`；返回 dirty 路径数组（rename/copy 对只取新路径）。
 * @param {string} text
 * @returns {string[]}
 */
export function parsePorcelainZ(text) {
  const parts = String(text ?? '').split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const path = rec.slice(3);
    if (status.includes('R') || status.includes('C')) i += 1; // 下一段是旧路径，不入 dirty 列表
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

/** 运行 git status（显式 timeout；失败/超时返回 {ok:false}，不抛）。
 *  内部任务-308/内部未决-283：env 预算缝只在**内部缺省预算**处生效（`snapshotBaseline` 缺省参数与
 *  报告构建调用点），显式传入的测试注入值（如 1ms 降级用例）保持原语义不被覆盖。 */
function gitStatus(root, timeoutMs) {
  // 失败降级注释：git 不可用/非仓/超时 → degraded，绝不当 clean
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '-z', '-uall'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (r.error || r.status !== 0) return { ok: false, reason: `git-status-failed:${r.error?.code ?? r.status}` };
  return { ok: true, paths: parsePorcelainZ(r.stdout) };
}

/** 文件 stat 快照；不存在返回 null。 */
function statFile(abs) {
  try {
    const st = statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 会话首个 PreToolUse 基线快照（原子写；git 失败 → degraded）。
 *  @param {{stateDir:string, sidDigest:string, root:string, gitTimeoutMs?:number}} input
 *   `gitTimeoutMs` 为**测试注入缝**（内部任务-293）：生产调用不传，预算仍 `BASELINE_GIT_TIMEOUT_MS`；
 *   测试传大值使 OK 路径不再受机器负载影响。 */
/**
 * 基线快照预算 env 缝（内部任务-308/内部未决-283）：钩层可经 `WF_WRITE_AUDIT_BASELINE_BUDGET_MS`
 * 注入更大预算，覆盖缺省 `BASELINE_GIT_TIMEOUT_MS`（800ms）；未设置/非法值返回 undefined
 * 时由 snapshotBaseline 缺省参数回落库常量。缝仅面向测试/应急，不改生产缺省语义。
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | undefined}
 */
export function resolveBaselineBudget(env = process.env) {
  const raw = env?.WF_WRITE_AUDIT_BASELINE_BUDGET_MS;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  // 严格十进制：Number() 会宽松接受 hex/指数/带符号，超大值还会让 spawnSync timeout 越界抛错。
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 600_000) return undefined;
  return n;
}

export function snapshotBaseline({ stateDir, sidDigest, root, gitTimeoutMs = resolveBaselineBudget() ?? BASELINE_GIT_TIMEOUT_MS }) {
  const status = gitStatus(root, gitTimeoutMs);
  if (!status.ok) return { status: 'degraded', reason: status.reason, rows: 0 };
  mkdirSync(stateDir, { recursive: true });
  const entries = status.paths.map((p) => {
    const st = statFile(join(root, p));
    return { path: p, mtimeMs: st === null ? null : st.mtimeMs, size: st === null ? null : st.size };
  });
  const file = baselinePath(stateDir, sidDigest);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), sidDigest, root, entries })}\n`, 'utf8');
  renameSync(tmp, file);
  return { status: 'ok', rows: entries.length };
}

/** 原子写 report；失败 push degraded 原因但不抛。 */
function writeReportFile(stateDir, sidDigest, report) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = reportPath(stateDir, sidDigest);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    report.degradedReasons.push('report-write-failed');
    report.status = 'degraded';
    return false;
  }
}

/**
 * journal 目标路径归一为仓相对（posix）；仓外/不可解析返回原值。
 * 内部任务-332：目标先经 canonicalPath（逐段 realpath，不存在尾段保字面——routing-lib 内部任务-244 B2）、
 * root 经 canonicalRoot（realpath 失败回退 normalize 不抛）后相对化——两侧同锚，容忍 raw 形态
 * root 传入（生产面 root＝activationRoot 恒 canonical；防御纵深，消除前置脚枪）。目标路径为
 * 未解析符号链接形态（darwin /var→/private/var、win32 junction）时纯词法 relative 会把仓内
 * 目标判成仓外（write-guard 受检判定静默失效、本账 edit/targets 归因落空——内部任务-332 根因）。
 * write 域归一单源：write-guard 与本模块共用。
 * @param {string} root 仓根（canonical 或等价 raw 形态——内部自归一）
 * @param {string} p 目标路径（可相对；相对路径按 execDir 解析，缺省＝root）
 * @param {string} [execDir] 执行目录（write-guard 的 tool_input.workdir→payload.cwd）
 * @returns {string} 仓相对 posix 路径；仓外/不可解析返回原值
 */
export function repoRelOf(root, p, execDir = root) {
  const s = String(p ?? '');
  if (s === '') return s;
  const rootC = canonicalRoot(root);
  const abs = canonicalPath(isAbsolute(s) ? resolve(s) : resolve(execDir, s));
  const rel = relative(rootC, abs).split('\\').join('/');
  if (rel === '..' || rel.startsWith('../')) return s;
  return rel;
}

/** 读上一份 report（用于连续 degraded 计数）；缺失/坏文件返回 null。 */
function readPrevReport(stateDir, sidDigest) {
  try {
    return JSON.parse(readFileSync(reportPath(stateDir, sidDigest), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 生成写归因 report（Stop 消费面）。
 * @param {{stateDir: string, sidDigest: string, projDigest: string, root: string, taskId?: string|null}} input
 * @returns {{status: string, external: number, degradedReasons: string[], rows: Array<object>, attributed: {edit:number,trusted:number,declared:number,delegated:number,internal:number,preexisting:number,unattributed:number}, sidDigest: string, ts: string, vcsHint: number, consecutiveDegraded: number}}
 */
export function buildWriteReport({ stateDir, sidDigest, projDigest, root, taskId }) {
  const degradedReasons = [];
  const prevReport = readPrevReport(stateDir, sidDigest);
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(baselinePath(stateDir, sidDigest), 'utf8'));
  } catch {
    degradedReasons.push('baseline-missing-or-corrupt');
  }
  const { rows: journalAll, badLines, totalLines } = readJournal(stateDir, projDigest);
  if (badLines > 0) degradedReasons.push(`journal-bad-lines:${badLines}`);
  if (totalLines > JOURNAL_MAX_LINES) rotateJournal(stateDir, projDigest);
  const status = gitStatus(root, Math.max(REPORT_GIT_TIMEOUT_MS, resolveBaselineBudget() ?? 0));
  if (!status.ok) degradedReasons.push(status.reason);
  const current = status.ok ? status.paths : [];

  // 会话过滤：本会话行 = sidDigest 相等（或旧行 sha16(sid) 相等）；ts 不早于 baseline.ts。
  // baseline 行例外：失败留痕可能早于成功 baseline 的 ts，必须纳入 degraded 判定（防被后续成功覆盖）。
  const baselineMs = Number.isFinite(Date.parse(baseline?.ts)) ? Date.parse(baseline.ts) : -Infinity;
  const isSessionRow = (r) => {
    if (!r || typeof r !== 'object') return false;
    if (r.sidDigest === sidDigest) return true;
    if (typeof r.sid === 'string' && r.sid !== '' && sha16(r.sid) === sidDigest) return true;
    return false;
  };
  const inWindow = (r) => r?.tool === 'baseline' || !Number.isFinite(Date.parse(r?.ts)) || Date.parse(r.ts) >= baselineMs;
  const windowRows = journalAll.filter(inWindow);
  const sessionRows = windowRows.filter(isSessionRow);
  // 他会话写者行（写者身份可识别：sid 非空且非本会话）；delegated＝同 taskId，其余→external。
  // 无 sid 的他会话行不参与归因（B5 既有判据：无 sid 行不计 delegated）。
  const foreignRows = windowRows.filter(
    (r) => r && typeof r === 'object' && !isSessionRow(r) && typeof r.sid === 'string' && r.sid !== '',
  );
  // degraded/unknown 统计面：仅本会话行（他会话行不降级本会话；baseline 行本身即 session 行）
  const relevantRows = sessionRows;

  const baselineMap = new Map((baseline?.entries ?? []).map((e) => [e.path, e]));
  const rowExecDir = (r) => (typeof r?.execDir === 'string' && r.execDir !== '' ? r.execDir : root);
  const normTarget = (r, t) => repoRelOf(root, t, rowExecDir(r));
  const editTargets = new Set(
    sessionRows.filter((e) => e.tool === 'edit' && typeof e.path === 'string').map((e) => normTarget(e, e.path)),
  );
  // baseline 快照失败行（即使后续成功建了 baseline）同样不得冒充 clean
  const unknownEditRows = relevantRows.filter((e) => e.tool === 'edit' && e.shape === 'unknown').length;
  if (unknownEditRows > 0) degradedReasons.push(`edit-shape-unknown:${unknownEditRows}`);
  const degradedRows = relevantRows.filter(
    (e) => e.degraded === true || (e.tool === 'baseline' && e.status === 'degraded'),
  ).length;
  if (degradedRows > 0) degradedReasons.push(`journal-degraded-rows:${degradedRows}`);

  // ownTouched 洗白防护（内部决策-066 修正案 2 内部模块-2）：本会话窗口内实际触及路径（edit／shell targets／
  // internal targets），target 一律经行 execDir 归一；命中 ownTouched 且无本会话归因理由 → unattributed，
  // 不得因他会话行存在而吸收为 delegated/external。
  const ownTouched = new Set(editTargets);
  for (const r of sessionRows) {
    if (Array.isArray(r.targets)) for (const t of r.targets) ownTouched.add(normTarget(r, t));
  }
  // 本会话归因理由：trusted/declared shell 目标 + internal 目标（internal 归 attributed/internal）
  const targetReason = new Map();
  const addTarget = (r, t, reason) => {
    const rel = normTarget(r, t);
    if (!targetReason.has(rel)) targetReason.set(rel, reason);
  };
  for (const r of sessionRows) {
    if (r.tool === 'shell' && Array.isArray(r.targets)) {
      // 被拒（decision=deny）的 shell 行命令未执行，不得作为 attributed 理由，否则并发他会话对同路径
      // 的写会被洗成 attributed/trusted/declared（先于 ownTouched 判定）。allow/record 均属已执行
      // （record 含 trackedTier=shadow 观测模式下的声明写）——只排除 deny。
      const reason = r.trusted === true ? 'trusted' : r.declared === true ? 'declared' : null;
      if (reason && r.decision !== 'deny') for (const t of r.targets) addTarget(r, t, reason);
    }
    if (r.tool === 'internal' && Array.isArray(r.targets)) for (const t of r.targets) addTarget(r, t, 'internal');
  }
  // 匿名 internal 行（owner 不可识别：null 桶声明）：仍归 attributed/internal，writer=null 不冒充 external
  const anonymousInternal = new Set();
  for (const r of windowRows) {
    if (!r || r.tool !== 'internal' || isSessionRow(r)) continue;
    if (typeof r.sid === 'string' && r.sid !== '') continue;
    if (Array.isArray(r.targets)) for (const t of r.targets) anonymousInternal.add(normTarget(r, t));
  }
  // delegated（同 taskId 他会话三来源）与 external（其余他会话三来源）目标映射
  const delegatedTargets = new Map();
  const externalTargets = new Map();
  for (const r of foreignRows) {
    const rels = [];
    if (r.tool === 'edit' && typeof r.path === 'string') rels.push(normTarget(r, r.path));
    if (Array.isArray(r.targets)) for (const t of r.targets) rels.push(normTarget(r, t));
    if (rels.length === 0) continue;
    const writer = { sidDigest: typeof r.sidDigest === 'string' && r.sidDigest !== '' ? r.sidDigest : sha16(r.sid), taskId: r.taskId ?? null };
    const sameTask = taskId != null && r.taskId === taskId;
    for (const rel of rels) {
      if (sameTask) {
        if (!delegatedTargets.has(rel)) delegatedTargets.set(rel, writer);
      } else if (!externalTargets.has(rel)) {
        externalTargets.set(rel, writer);
      }
    }
  }
  const c6Rows = sessionRows.filter((r) => r.tool === 'shell' && r.cls === 'C6').length;

  const rows = [];
  const attributed = { edit: 0, trusted: 0, declared: 0, delegated: 0, internal: 0, preexisting: 0, unattributed: 0 };
  let external = 0;
  for (const path of current) {
    if (editTargets.has(path)) {
      rows.push({ path, state: 'attributed', reason: 'edit' });
      attributed.edit += 1;
      continue;
    }
    const base = baselineMap.get(path);
    const st = statFile(join(root, path));
    if (base && st && base.mtimeMs === st.mtimeMs && base.size === st.size) {
      rows.push({ path, state: 'preexisting', reason: 'baseline-unchanged' });
      attributed.preexisting += 1;
      continue;
    }
    const mapped = targetReason.get(path);
    if (mapped) {
      const writer = mapped === 'internal' ? { sidDigest, taskId: taskId ?? null } : undefined;
      rows.push({ path, state: 'attributed', reason: mapped, ...(writer ? { writer } : {}) });
      attributed[mapped] += 1;
      continue;
    }
    // 洗白防护：本会话触及但无归因理由 → 即使他会话行覆盖同路径也不得吸收
    if (ownTouched.has(path)) {
      rows.push({ path, state: 'unattributed', reason: 'no-record' });
      attributed.unattributed += 1;
      continue;
    }
    const delegated = delegatedTargets.get(path);
    if (delegated) {
      rows.push({ path, state: 'attributed', reason: 'delegated', writer: delegated });
      attributed.delegated += 1;
      continue;
    }
    const ext = externalTargets.get(path);
    if (ext) {
      rows.push({ path, state: 'external', writer: ext });
      external += 1;
      continue;
    }
    if (anonymousInternal.has(path)) {
      rows.push({ path, state: 'attributed', reason: 'internal', writer: null });
      attributed.internal += 1;
      continue;
    }
    rows.push({ path, state: 'unattributed', reason: 'no-record' });
    attributed.unattributed += 1;
  }

  const degraded = degradedReasons.length > 0;
  const finalStatus = degraded ? 'degraded' : attributed.unattributed > 0 ? 'unattributed' : 'clean';
  const consecutiveDegraded = degraded && prevReport?.status === 'degraded'
    ? (Number(prevReport?.consecutiveDegraded) || 0) + 1
    : 0;
  const report = {
    v: 1,
    sidDigest,
    ts: new Date().toISOString(),
    taskId: taskId ?? null,
    status: finalStatus,
    external,
    degradedReasons,
    consecutiveDegraded,
    vcsHint: c6Rows,
    rows,
    attributed,
  };
  writeReportFile(stateDir, sidDigest, report);
  return report;
}
