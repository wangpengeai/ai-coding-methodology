// 文件：governance-store.mjs
// 描述：治理读写闭环的私有 store（内部任务-5 C，内部规则-9 / 内部接口-18 §3 绑定 v1）——
//       config/政策归一（内联 config.policy 为权威，旧顶层 policyId/policyVersion/
//       enforcement 保留兼容、同轴冲突拒绝）、绑定 v1 重算（contentDigest/subjectDigest/
//       sourceRefs/sourceInventory/coverage）、独立重枚举固定来源与配置引用、
//       审批/change-set/eval 报告原子持久化。缺/坏文件点名抛错，不吞为空集。
//       本模块是 team-governance 私有库：只依赖 node: 内置（内部非功能需求-1），
//       不改 OS 外发观测、不重演政策裁决（policy.mjs 仍是唯一裁决器）。
// 绑定 v1 长期约束（Node 侧双实现同口径，改这里必须同步 assurance/governance.mjs）：
//   - 路径一律项目根相对、'/' 分隔；拒绝对路径、..、链接出根；
//   - contentDigest 排除任一段名为 .git/node_modules/__pycache__/内部工作流状态
//     内部治理状态 的目录与 docs/plans 前缀（运行态/过程输出不自失效）；
//     配置显式登记的 evalReportFiles 属报告产物——不入 contentDigest、入 control sources；
//   - subject={contentDigest,changeSetDigest(重算),policyDigest,approvalProfile,
//     evalSuiteDigests} canonical；治理报告自身不入 sources（integrityHash 保护）。
// 作者：wangp  创建：2026-10-06  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync,
         readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { atomicWriteText as libAtomicWriteText } from './atomic-write.mjs';
import { readJsonlTolerant } from './jsonl.mjs';

import { canonicalJson, integrityHash } from './canonical-json.mjs';
import { changeSetDigest } from './change-set.mjs';
import { foldApprovals, isUsableIdentity } from './approval.mjs';
import { scanSecrets, redactSigned } from './redaction.mjs';

/** 配置/引用错误（工具错语义：CLI 退 2、点名文件，不吞）。 */
export class GovernanceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GovernanceConfigError';
  }
}

const CONFIG_REL = '.ai-governance/config.json';
const RUNTIME = '.ai-governance/runtime';
const FIXED = {
  config: [CONFIG_REL],
  runs: `${RUNTIME}/runs`,
  leases: [`${RUNTIME}/leases/leases.json`],
  approvals: [`${RUNTIME}/approvals/approvals.jsonl`],
  evals: `${RUNTIME}/evals`,
  learnings: `${RUNTIME}/learnings`,
  changeSet: [`${RUNTIME}/change-set.json`],
};

/** contentDigest 排除目录段（绑定 v1：任一段命中即排除——与 spec-gate/assurance/governance.mjs 同表，生产/消费两实现）。
 *  内部任务-254 批 2（H5）：**不再排除任意名为 runtime 的目录**——排除面收窄为
 *  `.ai-governance`（其下 runtime 运行态）与既有运行态/依赖目录；`src/runtime/x.js`
 *  之类业务目录计入 subject（生产/消费两实现同批同表）。 */
const EXCLUDED_SEGMENT_NAMES = new Set([
  '.git', 'node_modules', '__pycache__', '.workflow', '.scout', '.sdd', '.ai-governance',
]);
// 2026-10-25 内部任务-222：尾斜杠死分支修复（与 spec-gate/assurance/governance.mjs 同批——生产/消费两侧排除面一致，报告绑定复核不再因 docs/plans 内容失配）
const EXCLUDED_PREFIX = 'docs/plans';

// 内部任务-2：默认政策 allowedModels 的 provider 集＝capability-matrix hosts 单源对拍
//（zcode/dsh/mcode/kimi 四宿主全列；词表变更须两处同批——本常量（init 播种与归一兜底共用）、
// spec-gate/assurance/governance.mjs 镜像；对拍钉=tests/default-policy-hosts.test.mjs ＋
// spec-gate/assurance/tests/governance.test.mjs 的 DEFAULT_ALLOWED_MODELS/hosts 对拍）。
export const DEFAULT_ALLOWED_MODELS = [
  { provider: 'zcode', capabilities: ['code'] },
  { provider: 'dsh', capabilities: ['code'] },
  { provider: 'mcode', capabilities: ['code'] },
  { provider: 'kimi', capabilities: ['code'] },
];

function sha256Bytes(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function sha256File(absPath) {
  return sha256Bytes(readFileSync(absPath));
}

function toPosix(rel) {
  return rel.split(sep).join('/');
}

/**
 * 配置引用的安全相对路径（绑定 v1：拒绝对路径、..、链接出根）。
 * @returns {string} 项目根相对、'/' 分隔的路径
 */
function safeRelPath(root, configured, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GovernanceConfigError(`配置 ${configured} 含非法空路径`);
  }
  if (isAbsolute(value) || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new GovernanceConfigError(`配置 ${configured} 拒绝绝对路径：${value}`);
  }
  const abs = resolve(root, value);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new GovernanceConfigError(`配置 ${configured} 越界（不得逃出项目根）：${value}`);
  }
  // 链接出根：向上找最近存在祖先做 realpath，祖先已出根即整链越界（''=祖先即根，合法）
  let probe = abs;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  try {
    const realRoot = realpathSync(root);
    const realProbe = realpathSync(probe);
    const realRel = relative(realRoot, realProbe);
    if (realRel.startsWith('..') || realRel === '..' || isAbsolute(realRel)) {
      throw new GovernanceConfigError(`配置 ${configured} 经符号链接逃出项目根：${value}`);
    }
  } catch (e) {
    if (e instanceof GovernanceConfigError) throw e;
    throw new GovernanceConfigError(`配置 ${configured} 路径不可核验（${value}）：${e.message}`);
  }
  return toPosix(rel);
}

function readStringArray(config, key) {
  const raw = config[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new GovernanceConfigError(`配置 ${key} 必须为字符串数组`);
  }
  return [...raw];
}

/**
 * 归一化政策对象（canonical 形态——policyDigest 的输入，两语言必须逐字一致）。
 * 内联缺省字段按默认补齐；与旧顶层同轴显式冲突由 loadGovernanceConfig 拒绝。
 */
function normalizePolicy(inline) {
  return {
    id: inline.id ?? 'default',
    version: inline.version ?? 1,
    riskLevel: inline.riskLevel ?? 'medium',
    allowedModels: inline.allowedModels ?? DEFAULT_ALLOWED_MODELS,
    fallbacks: inline.fallbacks ?? [],
    enforcement: inline.enforcement ?? 'relaxed',
  };
}

/**
 * 读取并归一治理配置（内部规则-9）。
 * 内联 config.policy 为权威；旧顶层 policyId/policyVersion/enforcement 保留兼容，
 * 归一为显式 legacy 默认（enforcement 沿用旧值——strict 不可观察仍 deny，禁止固定 relaxed）；
 * 同轴双方显式且不一致 → 拒绝（工具错）。
 * @param {string} root 项目根
 * @returns {{config: object, policy: object, policySource: 'inline'|'legacy'}}
 */
export function loadGovernanceConfig(root) {
  const abs = join(root, CONFIG_REL);
  let raw;
  if (!existsSync(abs)) {
    throw new GovernanceConfigError(`治理配置缺失：${CONFIG_REL}——先运行 governance-cli init 接入`);
  }
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new GovernanceConfigError(`治理配置不可解析（${CONFIG_REL}）：${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GovernanceConfigError(`治理配置根不是对象（${CONFIG_REL}）`);
  }
  const inline = raw.policy;
  const hasInline = inline && typeof inline === 'object' && !Array.isArray(inline);
  if (raw.policy !== undefined && !hasInline) {
    throw new GovernanceConfigError(`配置 policy 必须为对象（${CONFIG_REL}）`);
  }
  if (hasInline) {
    // 同轴冲突拒绝：内联与旧顶层都显式给出且不同
    for (const [top, inner, label] of [['enforcement', 'enforcement', 'enforcement'],
      ['policyId', 'id', 'policyId'], ['policyVersion', 'version', 'policyVersion']]) {
      if (raw[top] !== undefined && inline[inner] !== undefined && String(raw[top]) !== String(inline[inner])) {
        throw new GovernanceConfigError(
          `配置冲突（${CONFIG_REL}）：内联 policy.${inner}=${JSON.stringify(inline[inner])} 与旧顶层 ${top}=${JSON.stringify(raw[top])} 不一致——请删除旧字段或改为一致`);
      }
    }
  }
  const policy = hasInline
    ? normalizePolicy(inline)
    : normalizePolicy({ id: raw.policyId, version: raw.policyVersion, enforcement: raw.enforcement });
  const evalSuiteFiles = readStringArray(raw, 'evalSuiteFiles').map((p) => safeRelPath(root, 'evalSuiteFiles', p));
  const evalReportFiles = readStringArray(raw, 'evalReportFiles').map((p) => safeRelPath(root, 'evalReportFiles', p));
  const learningFiles = readStringArray(raw, 'learningFiles').map((p) => safeRelPath(root, 'learningFiles', p));
  const requiredDomains = readStringArray(raw, 'requiredDomains');
  const config = {
    ...raw,
    policy,
    policySource: hasInline ? 'inline' : 'legacy',
    requiredDomains,
    approvalProfile: typeof raw.approvalProfile === 'string' && raw.approvalProfile ? raw.approvalProfile : 'default',
    evalSuiteFiles,
    evalReportFiles,
    learningFiles,
  };
  return { config, policy, policySource: config.policySource };
}

// ── 绑定 v1 重算 ──

/** 枚举 contentDigest 文件集（排除运行态/过程目录、符号链接、显式登记的报告产物）。 */
function listSubjectFiles(root, extraExcluded) {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过（收集面失败由固定来源点名承载）
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (EXCLUDED_SEGMENT_NAMES.has(ent.name)) continue;
      if (rel === EXCLUDED_PREFIX || rel.startsWith(`${EXCLUDED_PREFIX}/`)) continue;
      if (extraExcluded.has(rel)) continue;
      if (ent.isSymbolicLink()) continue; // 链接不进 subject（防逃逸/环）
      if (ent.isDirectory()) walk(rel);
      else if (ent.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

/**
 * change-set 语义坏件判定（单源：绑定重算与 collect 点名共用）。
 * 返回 null=合法；否则返回原因文案。坏件在 subject 侧按「无锚」（digest=null）处理——
 * 与消费侧 `spec-gate/assurance/governance.mjs` 的 digest=null 同口径，防生产/消费分叉。
 */
function changeSetProblem(cs) {
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) return '缺 changeSet 对象';
  if (!Array.isArray(cs.repos)) return 'changeSet.repos 须为数组（缺字段）';
  if (!Array.isArray(cs.resources)) return 'changeSet.resources 须为数组（缺字段）';
  if (cs.resources.some((r) => typeof r !== 'string')) return 'changeSet.resources 含非字符串元素（语义坏件）';
  return null;
}

/**
 * 计算绑定 v1（内部接口-18 §3）。
 * @param {string} root 项目根
 * @param {{evalSuiteFiles: string[], evalReportFiles: string[], approvalProfile: string}} config 归一后配置
 * @returns {{subject: string, contentDigest: string, changeSetDigest: string|null,
 *            policyDigest: string, approvalProfile: string, evalSuiteDigests: string[]}}
 */
export function computeBinding(root, config, policy) {
  const reportProducts = new Set(config.evalReportFiles); // 登记的报告产物不入 subject
  const files = listSubjectFiles(root, reportProducts);
  // 全局按路径排序（目录遍历序≠全局字典序——两语言都必须排序后再哈希，绑定 v1 约束）
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tuples = files.map((rel) => [rel, sha256File(join(root, rel))]);
  const contentDigest = sha256Bytes(Buffer.from(canonicalJson(tuples), 'utf8'));
  let changeSetDigestValue = null;
  const csPath = join(root, FIXED.changeSet[0]);
  if (existsSync(csPath)) {
    try {
      const persisted = JSON.parse(readFileSync(csPath, 'utf8'));
      // 消费时重算，不信任落盘值；语义坏件 → null（与消费侧同口径，防 subject 分叉）
      changeSetDigestValue = changeSetProblem(persisted?.changeSet) === null
        ? changeSetDigest(persisted.changeSet)
        : null;
    } catch {
      changeSetDigestValue = null; // 坏件由 collect 点名（coverage invalid），subject 侧按无锚处理
    }
  }
  const policyDigest = integrityHash(policy);
  // 配置引用缺失时 digest 记 null（缺件由 collect 点名 TG-ASSET-MISSING 阻断；
  // subject 仍可确定性计算——两语言同口径）
  const evalSuiteDigests = config.evalSuiteFiles.map((rel) => (existsSync(join(root, rel)) ? sha256File(join(root, rel)) : null));
  const subject = sha256Bytes(Buffer.from(canonicalJson({
    contentDigest,
    changeSetDigest: changeSetDigestValue,
    policyDigest,
    approvalProfile: config.approvalProfile,
    evalSuiteDigests,
  }), 'utf8'));
  return { subject, contentDigest, changeSetDigest: changeSetDigestValue, policyDigest,
           approvalProfile: config.approvalProfile, evalSuiteDigests };
}

// ── 固定来源独立重枚举 ──

/**
 * 「最近 run」的 humanInitiator 选择（H2 唯一数据源，decisions.md 批 2 口径）：
 * 候选池＝open＋finalized 全部 manifest；排序键＝`startedAt` 最大 → 同刻取 `completedAt`
 * 较大者（open/缺字段视为最旧）→ 仍同刻按 `runId` 字典序（取小者，保证确定性）。
 * 返回 null 表示无归属（字段缺失/空串/`unknown` 一律按无值，不判自批）。
 * @param {Array<object>} manifests
 * @returns {string|null}
 */
export function selectRequestedBy(manifests) {
  const pool = (manifests ?? []).filter((m) => m && typeof m === 'object');
  if (pool.length === 0) return null;
  const tsOf = (v) => {
    const t = Date.parse(String(v ?? ''));
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  let best = null;
  for (const m of pool) {
    if (best === null) { best = m; continue; }
    const started = tsOf(m.startedAt);
    const bestStarted = tsOf(best.startedAt);
    if (started !== bestStarted) { if (started > bestStarted) best = m; continue; }
    const done = tsOf(m.completedAt);
    const bestDone = tsOf(best.completedAt);
    if (done !== bestDone) { if (done > bestDone) best = m; continue; }
    if (String(m.runId ?? '') < String(best.runId ?? '')) best = m;
  }
  const who = best === null ? '' : String(best.humanInitiator ?? '');
  // 「可用身份」判定复用 approval.mjs 单源（空串/unknown 按无值；三维评审简洁性阻塞 3）
  return isUsableIdentity(who) ? who.trim() : null;
}

function listJsonDir(root, relDir, suffix) {
  const abs = join(root, relDir);
  if (!existsSync(abs)) return null; // 目录缺失
  return readdirSync(abs).filter((f) => f.endsWith(suffix)).sort().map((f) => `${relDir}/${f}`);
}

/** 普通文件判定（内部任务-257 P5-2：目录/特殊文件视为不可读资产，不参与 sha256 源摘要）。 */
function isRegularFile(abs) {
  try { return statSync(abs).isFile(); } catch { return false; }
}

/** 运行时文件存在性：存在但非普通文件 → 记 invalid 并返回 false（不当可哈希源）。 */
function presentRuntimeFile(root, rel, domain, invalidAssets) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return false;
  if (!isRegularFile(abs)) {
    invalidAssets.push({ domain, path: rel, error: '存在但非普通文件（不可读）' });
    return false;
  }
  return true;
}

function readJsonlRecords(abs) {
  // JSONL 家族读侧坏行容忍（与 learning-store 同语义）；返回 {records, hasContent, readError}
  // 内部任务-257（P5-2）：读失败不得静默当空集——由调用点记 invalidAssets（H15 同族）。
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    return { records: [], hasContent: false, readError: e.message };
  }
  const { records } = readJsonlTolerant(text); // 内部任务-257 P5-2：JSONL 解析单源
  return { records, hasContent: text.trim().length > 0, readError: null };
}

/**
 * 独立重枚举全部治理输入（gate/verify 的唯一收集面；不只遍历报告自报 refs，
 * 可检出新增/删除文件）。
 * @param {string} root 项目根
 * @returns {{config: object, policy: object, preflightInput: object, parts: object,
 *            binding: object, sourceRefs: Array<{path:string,sha256:string}>,
 *            sourceInventory: Array<{path:string,present:boolean}>, coverage: object}}
 */
export function collectGovernanceInputs(root) {
  const { config, policy } = loadGovernanceConfig(root);
  const binding = computeBinding(root, config, policy);
  const invalidAssets = [];
  const missingConfigured = [];

  // runs：逐文件解析（坏件点名 TG-MANIFEST-UNREADABLE 语义沿用）
  const manifests = [];
  const unreadableRuns = [];
  const runsFiles = listJsonDir(root, FIXED.runs, '.json') ?? [];
  for (const rel of runsFiles) {
    try {
      manifests.push(JSON.parse(readFileSync(join(root, rel), 'utf8')));
    } catch (e) {
      unreadableRuns.push(rel);
      invalidAssets.push({ domain: 'runs', path: rel, error: `JSON 解析失败：${e.message}` });
    }
  }

  // leases
  let leases = [];
  const leasesRel = FIXED.leases[0];
  const leasesPresent = presentRuntimeFile(root, leasesRel, 'leases', invalidAssets);
  if (leasesPresent) {
    try {
      leases = Object.values(JSON.parse(readFileSync(join(root, leasesRel), 'utf8')).leases ?? {});
    } catch (e) {
      invalidAssets.push({ domain: 'leases', path: leasesRel, error: `JSON 解析失败：${e.message}` });
    }
  }

  // approvals（JSONL 坏行容忍）
  let approvals = [];
  const approvalsRel = FIXED.approvals[0];
  const approvalsPresent = presentRuntimeFile(root, approvalsRel, 'approvals', invalidAssets);
  if (approvalsPresent) {
    const ar = readJsonlRecords(join(root, approvalsRel));
    approvals = ar.records;
    if (ar.readError) invalidAssets.push({ domain: 'approvals', path: approvalsRel, error: `读取失败：${ar.readError}` });
  }

  // evals：runtime/evals 权威报告逐份解析；**live/opt-in 证据不进 gate 判定面**（内部任务-253）：
  // 只按解析后的 mode==='live' 排除（文件名不得作为排除依据）；不可解析件保留进面并记 invalid；缺 mode 的报告按 replay 处理（fail-closed，仍阻断）。
  // replayEvalFiles 为过滤后的权威判定面，**sources/inventory/coverage 与 evals 数组必须同源使用**（否则消费侧
  // spec-gate/assurance/governance.mjs 过滤 live 后会与本报告 sources 深比较，把治理报告判 stale——内部任务-253 阶段复审 #1）。
  const evals = [];
  const replayEvalFiles = [];
  const evalFiles = listJsonDir(root, FIXED.evals, '.json') ?? [];
  for (const rel of evalFiles) {
    if (!isRegularFile(join(root, rel))) {
      invalidAssets.push({ domain: 'evals', path: rel, error: '存在但非普通文件（不可读）' });
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      // 先解析、后按 mode 判定（live manifest 自带 mode:"live"；文件名不得作为排除依据——三维评审 #1）
      if (parsed && parsed.mode === 'live') continue;
      replayEvalFiles.push(rel);
      evals.push(parsed);
    } catch (e) {
      // 不可解析件仍保留进 sources/inventory（与 spec-gate 镜像同口径），同时记 invalid 供 coverage 阻断
      replayEvalFiles.push(rel);
      invalidAssets.push({ domain: 'evals', path: rel, error: `JSON 解析失败：${e.message}` });
    }
  }

  // learnings：runtime/learnings/*.jsonl + 配置 learningFiles（坏行容忍、同 id 首条）
  const learnings = [];
  const seenLearning = new Set();
  const learningsFiles = listJsonDir(root, FIXED.learnings, '.jsonl') ?? [];
  const learningSources = [...learningsFiles, ...config.learningFiles];
  for (const rel of learningSources) {
    if (!existsSync(join(root, rel))) {
      if (config.learningFiles.includes(rel)) missingConfigured.push(rel);
      continue;
    }
    if (!isRegularFile(join(root, rel))) {
      invalidAssets.push({ domain: 'learnings', path: rel, error: '存在但非普通文件（不可读）' });
      continue;
    }
    const lr = readJsonlRecords(join(root, rel));
    if (lr.readError) invalidAssets.push({ domain: 'learnings', path: rel, error: `读取失败：${lr.readError}` });
    for (const rec of lr.records) {
      if (!rec || typeof rec.learningId !== 'string' || !rec.learningId) continue;
      if (seenLearning.has(rec.learningId)) continue;
      seenLearning.add(rec.learningId);
      learnings.push(rec);
    }
  }

  // change-set：subject 侧重算 digest；内部任务-254（H15）语义坏件（不可解析/缺字段/resources
  // 非字符串等）必须点名 invalidAssets(domain=changeSet)→coverage invalid→gate TG-ASSET-INVALID，
  // **不得当「无锚」判通过**（原实现只在解析失败时点名，缺字段坏件被静默吞成 null）。
  const csRel = FIXED.changeSet[0];
  const csPresent = presentRuntimeFile(root, csRel, 'changeSet', invalidAssets);
  if (csPresent) {
    try {
      const persisted = JSON.parse(readFileSync(join(root, csRel), 'utf8'));
      const problem = changeSetProblem(persisted?.changeSet);
      if (problem) throw new Error(problem);
      // 语义合法：digest 已在 computeBinding 中现算（不重复读算）
    } catch (e) {
      invalidAssets.push({ domain: 'changeSet', path: csRel, error: `change-set 语义坏件：${e.message}` });
    }
  }

  // 配置引用（evalSuiteFiles 必须存在；evalReportFiles 缺失=报告产物未生成，点名）
  for (const rel of config.evalSuiteFiles) {
    if (!existsSync(join(root, rel))) missingConfigured.push(rel);
  }
  for (const rel of config.evalReportFiles) {
    if (!existsSync(join(root, rel))) missingConfigured.push(rel);
  }

  // sourceRefs / sourceInventory（固定来源 + 配置引用；报告自身不入）
  const inventoryMap = new Map();
  const mark = (rel, present) => inventoryMap.set(rel, present);
  mark(CONFIG_REL, true);
  for (const rel of runsFiles) mark(rel, true);
  mark(leasesRel, leasesPresent);
  mark(approvalsRel, approvalsPresent);
  for (const rel of replayEvalFiles) mark(rel, true);
  for (const rel of learningsFiles) mark(rel, true);
  mark(csRel, csPresent);
  for (const rel of [...config.evalSuiteFiles, ...config.evalReportFiles, ...config.learningFiles]) {
    mark(rel, existsSync(join(root, rel)));
  }
  const sourceInventory = [...inventoryMap.entries()]
    .map(([path, present]) => ({ path, present }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceRefs = sourceInventory
    .filter((e) => e.present && isRegularFile(join(root, e.path)))
    .map((e) => ({ path: e.path, sha256: sha256File(join(root, e.path)) }));

  // coverage（逐域 loaded|empty|missing|invalid；可选域 missing/empty=合法 not-applicable）
  const dirState = (files, dirExists) => {
    if (!dirExists) return 'missing';
    if (files.length === 0) return 'empty';
    return 'loaded';
  };
  const coverage = {
    runs: invalidAssets.some((a) => a.domain === 'runs') ? 'invalid' : dirState(runsFiles, existsSync(join(root, FIXED.runs))),
    leases: invalidAssets.some((a) => a.domain === 'leases') ? 'invalid'
      : leasesPresent ? 'loaded' : 'missing',
    approvals: invalidAssets.some((a) => a.domain === 'approvals') ? 'invalid'
      : approvalsPresent ? (approvals.length > 0 ? 'loaded' : 'empty') : 'missing',
    evals: invalidAssets.some((a) => a.domain === 'evals') ? 'invalid' : dirState(replayEvalFiles, existsSync(join(root, FIXED.evals))),
    learnings: invalidAssets.some((a) => a.domain === 'learnings') ? 'invalid'
      : learnings.length > 0 ? 'loaded'
        : dirState(learningsFiles, existsSync(join(root, FIXED.learnings))),
    changeSet: invalidAssets.some((a) => a.domain === 'changeSet') ? 'invalid'
      : csPresent ? 'loaded' : 'missing',
    evalSuites: config.evalSuiteFiles.length === 0 ? 'missing'
      : missingConfigured.some((p) => config.evalSuiteFiles.includes(p)) ? 'invalid' : 'loaded',
    evalReports: config.evalReportFiles.length === 0 ? 'missing'
      : missingConfigured.some((p) => config.evalReportFiles.includes(p)) ? 'invalid' : 'loaded',
  };

  const requestedBy = selectRequestedBy(manifests);
  const parts = {
    policy,
    requiredDomains: config.requiredDomains,
    manifests,
    unreadableRuns,
    leases,
    // 内部任务-254（H2）：归属现算结果随 parts 下传（审批数组为空时 gate 仍可判「有归属/无归属」，
    // 不因「尚未 approve」误报 TG-APPROVAL-UNATTRIBUTED——阶段复审阻塞 1）
    requestedBy,
    // 内部任务-254（H2/H4）：审批先按 approvalId 折叠（数组序后者覆盖、revocation 覆盖同 ID 前项），
    // current 由当前 subject/policy/最近 run 归属现算——不信任调用方传过期快照（内部接口-16）
    approvals: foldApprovals(approvals).map((approval) => ({
      approval,
      current: {
        changeSetDigest: binding.subject,
        policyDigest: binding.policyDigest,
        policy: policy.enforcement,
        highRisk: policy.riskLevel === 'high',
        requestedBy,
      },
    })),
    evals,
    learnings,
    invalidAssets,
    missingConfigured,
  };
  return { config, policy, preflightInput: policy, parts, binding, sourceRefs, sourceInventory, coverage };
}

// ── 原子持久化 ──

/** 原子写（委托 lib/atomic-write 单源；本面保留 mkdir，兼容既有调用方）。 */
export function atomicWriteText(absPath, text) {
  mkdirSync(dirname(absPath), { recursive: true });
  libAtomicWriteText(absPath, text);
}

/**
 * 审批落盘（runtime/approvals/approvals.jsonl；O_APPEND 追加串行化、坏行容忍在读侧）。
 * @param {string} root
 * @param {object} approval recordApproval 产出的审批记录
 * @returns {{ok: boolean, path: string}}
 */
export function persistApproval(root, approval) {
  const abs = join(root, FIXED.approvals[0]);
  mkdirSync(dirname(abs), { recursive: true });
  appendFileSync(abs, JSON.stringify(approval) + '\n', 'utf8');
  return { ok: true, path: FIXED.approvals[0] };
}

/**
 * change-set 落盘（runtime/change-set.json；digest 重算校验——落盘值仅断言不作真值）。
 * @param {string} root
 * @param {{changeSet: object, digest?: string}} data
 * @returns {{ok: boolean, path: string, digest: string}}
 */
export function persistChangeSet(root, data) {
  const recomputed = changeSetDigest(data.changeSet);
  if (data.digest !== undefined && data.digest !== recomputed) {
    throw new GovernanceConfigError(
      `change-set digest 重算失配（传入 ${data.digest.slice(0, 16)}… vs 重算 ${recomputed.slice(0, 16)}…）——拒绝落盘`);
  }
  const abs = join(root, FIXED.changeSet[0]);
  atomicWriteText(abs, JSON.stringify({ ok: true, changeSet: data.changeSet, digest: recomputed }, null, 2) + '\n');
  return { ok: true, path: FIXED.changeSet[0], digest: recomputed };
}

/**
 * eval 报告权威落盘（runtime/evals/<suiteId>-<时间戳>.json；--out 导出副本不自动权威）。
 * live 三件（report/manifest/transcript）由 agent-eval live 路径以原子写自行落盘，
 * 文件名含 `-live-` 标识；gate 收集面只按解析后的 mode 排除 live（内部任务-253；文件名不作排除依据）。
 * @param {string} root
 * @param {object} report runReplaySuite 报告
 * @returns {{ok: boolean, path: string}}
 */
export function persistEvalReport(root, report) {
  if (typeof report.suiteId !== 'string' || report.suiteId === '' || /[\\/]|\.\./.test(report.suiteId) || /^[A-Za-z]:/.test(report.suiteId)) {
    throw new Error('suiteId 非法：不得含路径分隔符/上跳/盘符前缀');
  }
  // 内部任务-255（H12/H13）：入参 integrityHash 必须与 body 一致（不得以写入侧重签掩盖篡改信号）；
  // 随后若仍检出秘密则幂等脱敏重签（agent-eval replay 已在调用前脱敏，此处为纵深防御）。
  if (report.integrityHash !== undefined) {
    const { integrityHash: recorded, ...body } = report;
    if (!recorded || integrityHash(body) !== recorded) {
      throw new Error('评测报告 integrityHash 与 body 不符——拒绝落盘（H1 fail-closed）');
    }
  }
  const safe = scanSecrets(report).length > 0 ? redactSigned(report) : report;
  const dir = join(root, FIXED.evals);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${safe.suiteId}-${stamp}.json`;
  atomicWriteText(join(dir, name), JSON.stringify(safe, null, 2) + '\n');
  return { ok: true, path: `${FIXED.evals}/${name}` };
}

