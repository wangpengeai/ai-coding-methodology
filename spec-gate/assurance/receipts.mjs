// 文件：receipts.mjs
// 描述：receipts.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段2 凭据链 2.2；永久件）——任务凭据
//       （task receipt）签发与链校验（内部决策-007 / 内部接口-11）：verification / code-review /
//       gate / inspection-only / operation 五类凭据，全部绑定 taskId + RevisionSet + 引用工件
//       哈希 + 内容完整性哈希。公开面与 原 Python 实现（迁移史见 内部决策-051）逐函数对齐：常量/ChainProfileError/
//       receiptsDir/integrity/verifyReceiptFile/五签发函数/latestReceipt/countReviewReceipts/
//       verifyReceiptChain。失效语义：源码/规格/计划变化使旧凭据失效；三处 revision 消费点
//       （code-review 受理、operation 受理、链校验）统一调用 revision.mjs 的
//       revisionDivergence（内部任务-40 判据单点承载）；inspection-only 永不满足完成评审；
//       档位（full/scout-repro）不得向上提升。完整性哈希只防偶然篡改，不提供身份真实性
//       ——不描述为签名。
//       落盘口径：键序按 Python 插入顺序、`JSON.stringify(payload, null, 2) + "\n"`
//       （固定 now 下与 Python 逐字节相等，LF 归一）；`opts.now` 缺省 `nowIso()`。
//       归档分支复用 archive.mjs 的 `manifestIds`（fail-open：归档判定失败不改变「无凭据」语义）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import {
  atomicWriteText, canonicalJsonBytes, isWithinRoot, looseRealpath, nowIso, readUtf8Strict, sha256Hex,
  toPosix, underRoot,
} from './common.mjs';
import { ACL_RIGHTS, HOST_ENV_OVERRIDE, PATH_BASES, PATH_OPTIONAL_TYPES, PROBE_TYPES, guidOk } from './probes.mjs';
import { RevisionDecodeError, computeRevisionSet, revisionDivergence, revisionSetToDict } from './revision.mjs';
import { loadManifest, manifestIds } from './archive.mjs';
import { acquireLock, releaseLock } from './lock.mjs';

export const RECEIPT_SCHEMA_VERSION = '2.1.0';
/** 测试缝（内部任务-241 步骤 5）：持锁后钩子，用于确定性并发用例；生产缺省 null 不改路径。 */
export const _testHooks = { afterReceiptLockAcquired: null, latestReceiptRead: null };
export const VALID_PROFILES = ['full', 'scout-repro'];
export const VALID_KINDS = ['verification', 'code-review', 'gate', 'inspection-only', 'operation'];
// 完成链形态（内部决策-023 修正案 2 / 内部未决-128 方案 B，内部任务-116）：dev=verification+code-review；
// operation=verification+operation（状态型 ad-hoc）；deliverable=verification+code-review
// (deliverable)+operation（制品型 ad-hoc 三环，四因子：旗标/评审环形态/双环同引/序）
export const VALID_CHAIN_PROFILES = ['dev', 'operation', 'deliverable'];
// 阶段级 code-review 凭据的 stage 标识（2026-09-16 使用反馈批次 P3）：进文件名，
// 白名单防路径逃逸（斜杠与 .. 会把文件写到 receipts 目录之外）。
// 模式串与 Python 的 `re.STAGE_ID_RE.pattern` 逐字一致；`$` 的尾随换行语义由 pyReMatch 承载。
export const STAGE_ID_RE = /^[A-Za-z0-9-]{1,16}$/;
// 任务号形态（2026-09-19 评审修复 H4，安全面）：task_id 直拼进落盘目录段与 receiptId，
// 无校验时 `--task-id ../evil` 可把凭据写到 内部治理状态 之外——起点字母数字禁斜杠/
// 反斜杠，首字符即排除 `..` 段（与 STAGE_ID_RE 同款防线动机；宽容既有 TASK-XXX-n 形态）
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// 凭据 ID 形态（读侧防穿越；与 Python `_load_receipt` 内联正则同值）
const RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVIEW_MODES = ['three-dim', 'single-instance', 'user-audit', 'exempt', 'deliverable'];
// 修复后复审档位（内部任务-156 / 内部决策-4）：none=零代码修复、self=机械无语义修复、
// delta=1 个 fresh-context 实例、full=3+ 实例三维。字段为声明面，真实性由评审记录承载。
export const FIX_REVIEW_MODES = ['none', 'self', 'delta', 'full'];
const FIX_REVIEW_BASE_RE = /^[0-9a-f]{7,64}$/i;
const FIX_REVIEW_DIFF_RE = /^[0-9a-f]{16,64}$/i;

/** 链形态声明与链上自述不一致（工具/配置错误）——CLI 映射退出码 2（内部接口-11 §4）。 */
export class ChainProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainProfileError';
  }
}

/** Python `re.match` 的 `$` 语义：允许单个尾随换行（模式串本身与 Python `.pattern` 逐字一致）。 */
function pyReMatch(re, value) {
  const s = String(value);
  return re.test(s) || (s.endsWith('\n') && re.test(s.slice(0, -1)));
}

/** Python 真值语义（空数组/空对象/空串/0/None 均假）；证据引用守卫用。 */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** 普通对象判定（对齐 Python `isinstance(x, dict)`；数组/null 均否）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python `dict.get` 语义：非对象/缺键取缺省；键存在（含 null）取实值。 */
function get(obj, key, fallback = null) {
  if (!isPlainObject(obj)) return fallback;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** 正则元字符转义（对齐 Python `re.escape` 在任务级文件名正则中的用法）。 */
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 单一收口：签发与读侧全部经本函数取目录（2026-09-19 评审修复 H4 防穿越）。
 * @param {string} root
 * @param {string} taskId
 * @returns {string}
 */
export function receiptsDir(root, taskId) {
  if (!pyReMatch(TASK_ID_RE, taskId)) {
    throw new Error(
      `taskId 非法：${JSON.stringify(taskId)}（须 ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$，`
      + '首字符字母数字、≤64 字符——防凭据写到 receipts 目录之外）',
    );
  }
  return join(root, '.sdd', 'receipts', String(taskId));
}

/** 「凭据不存在」受理报错（code-review/operation 两处共用）。 */
function verificationNotFoundMessage(taskId, receiptId) {
  return `verification 凭据不存在：${receiptId}`
    + `（须为凭据 ID 而非文件路径；已签发凭据见 .sdd/receipts/${taskId}/ 目录）`;
}

/** revision 失配受理报错（两处共用——仅第二环命令不同，由调用方点名）。 */
function staleVerificationMessage(taskId, followup) {
  return 'verification 凭据 revision 与当前不一致（源码/规格/计划已变化），先重跑 verification：'
    + `cli.mjs --project-root <项目根> issue-verification --task-id ${taskId} `
    + `--evidence-file <证据 JSON>，${followup}`;
}

/** 内容桶未变但提交可达性无法证明时的受理报错（内部任务-40 分因）。 */
function headUnverifiableMessage(taskId, detail) {
  return `verification 凭据内容桶未变，但提交可达性无法证明（${detail}）：`
    + '若源码/规格确实未变，先重跑 verification：cli.mjs --project-root <项目根> '
    + `issue-verification --task-id ${taskId} --evidence-file <证据 JSON>`;
}

/** 任务级凭据文件名正则：仅 `{kind}-{taskId}-{seq}`（阶段级 `-s{stage}` 不参与）。 */
function taskLevelRe(kind, taskId) {
  return new RegExp(`^${escapeRe(kind)}-${escapeRe(taskId)}-(\\d+)$`);
}

/** 同任务同种类凭据的递增序号（按既有任务级文件取 max+1，起点 1；阶段级不计入）。
 *  内部任务-241 G04：旧实现用「匹配文件计数+1」，目录存在空洞（手删/部分恢复）或并发签发时
 *  会撞既有编号并覆盖审计凭据——改为 max+1，并由 writeReceipt 在锁内重算。 */
function nextSeq(root, taskId, kind) {
  const directory = receiptsDir(root, taskId);
  if (!existsSync(directory)) return 1;
  const pattern = taskLevelRe(kind, taskId);
  let max = 0;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
    const m = pattern.exec(name.slice(0, -'.json'.length));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 内容完整性哈希：对去除 integritySha256 字段后的 canonical JSON 计算。
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function integrity(payload) {
  const body = {};
  for (const [k, v] of Object.entries(payload)) if (k !== 'integritySha256') body[k] = v;
  return `sha256:${sha256Hex(canonicalJsonBytes(body))}`;
}

/** 补全完整性哈希并原子落盘；返回完整凭据对象。
 *  内部任务-241 G04：签发全程持 `.receipt.lock`（锁内重算 max+1 序号＋存在性复核），
 *  并发签发明确报错（code=ELOCKED / EEXIST，CLI 归退 2），绝不静默覆盖既有凭据。 */
function writeReceipt(root, payload) {
  const lockPath = join(receiptsDir(root, payload.taskId), '.receipt.lock');
  // 持有者标识须唯一（stale 回收后旧持有者不得误删新锁）：kind＋8 位 uuid。
  const owner = `receipt-${payload.kind}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const lock = acquireLock(lockPath, { owner });
  if (!lock.ok) {
    const e = new Error('凭据签发被并发占用（.receipt.lock 存在）——稍后重试');
    e.code = 'ELOCKED';
    throw e;
  }
  try {
    if (_testHooks.afterReceiptLockAcquired !== null) _testHooks.afterReceiptLockAcquired(payload);
    // 阶段凭据文件名由 stage 标识决定（`code-review-<task>-s<stage>`，不进完成链），不参与任务级序号重算；
    // 其余任务级凭据在锁内重算序号：并发进程不会拿到同一号；空洞场景取 max+1。
    if (payload.stageReceipt !== true) {
      payload.receiptId = `${payload.kind}-${payload.taskId}-${nextSeq(root, payload.taskId, payload.kind)}`;
    }
    const path = join(receiptsDir(root, payload.taskId), `${payload.receiptId}.json`);
    if (existsSync(path)) {
      const e = new Error(`凭据序号冲突：${payload.receiptId} 已存在（拒绝覆盖审计证据）`);
      e.code = 'EEXIST';
      throw e;
    }
    payload.integritySha256 = integrity(payload);
    atomicWriteText(path, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  } finally {
    releaseLock(lockPath, lock.owner);
  }
}

/** 基础负载（键序对齐 Python `_base_payload`）。 */
function basePayload(root, taskId, kind, revision, now) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId: `${kind}-${taskId}-${nextSeq(root, taskId, kind)}`,
    kind,
    taskId,
    revision: revisionSetToDict(revision),
    createdAt: now ?? nowIso(),
  };
}

/**
 * 按 id 读取凭据文件；不存在/形态非法/不可解析返回 null。receipt_id 直拼文件名——
 * 与 task_id 同款防穿越校验（2026-09-19 评审修复 H4：`--verification ../x` 同型越界读）。
 * @param {string} root @param {string} taskId @param {string} receiptId
 * @returns {Record<string, unknown>|null}
 */
function loadReceipt(root, taskId, receiptId) {
  if (!pyReMatch(RECEIPT_ID_RE, receiptId)) return null;
  const path = join(receiptsDir(root, taskId), `${receiptId}.json`);
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile()) return null;
  try {
    return JSON.parse(readUtf8Strict(path));
  } catch {
    return null;
  }
}

/** 某种类任务级凭据中「文件在位但不可解析」的 stem 列表（G07/内部任务-241：损坏与不存在可分辨）。 */
function corruptKindFiles(root, taskId, kind) {
  const directory = receiptsDir(root, taskId);
  if (!existsSync(directory)) return [];
  let names;
  try { names = readdirSync(directory).sort(); } catch { return []; }
  const pattern = taskLevelRe(kind, taskId);
  const out = [];
  for (const name of names) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    if (!pattern.test(stem)) continue;
    if (loadReceipt(root, taskId, stem) === null) out.push(stem);
  }
  return out;
}

/**
 * 单凭据完整性校验（防偶然篡改）：返回 [ok, reason]。
 * @param {string} path
 * @returns {[boolean, string]}
 */
export function verifyReceiptFile(path) {
  let payload;
  try {
    payload = JSON.parse(readUtf8Strict(path));
  } catch (e) {
    return [false, `凭据不可读/不可解析：${e.message}`];
  }
  const recorded = get(payload, 'integritySha256', null);
  if (typeof recorded !== 'string') return [false, '凭据缺 integritySha256'];
  if (integrity(payload) !== recorded) return [false, '完整性哈希失配（凭据内容被改动）'];
  return [true, 'ok'];
}

/**
 * 签发 verification 凭据（档位 full/scout-repro，绑定当前 RevisionSet）。
 * @param {string} root @param {string} taskId
 * @param {Array<Record<string, unknown>>} evidenceRefs
 * @param {{profile?: string, planPath?: string|null, scout?: object|null, now?: string}} [opts]
 * @returns {Record<string, unknown>}
 */
export function issueVerificationReceipt(root, taskId, evidenceRefs, opts = {}) {
  const { profile = 'full', planPath = null, scout = null, now } = opts;
  if (!VALID_PROFILES.includes(profile)) {
    throw new Error(`非法证据档位：${profile}（合法：${VALID_PROFILES.join(', ')}，档位不得自造）`);
  }
  // 内部任务-41（FIX-3 承接 #4）：零证据拒签（库层双保险——CLI 侧已 ToolError 拦截，
  // 本守卫防 CLI 外调用方绕过；FIX-2 曾以 0 entries 签发成功）。
  if (!pyTruthy(evidenceRefs)) {
    throw new Error(
      'verification 凭据必须携带至少一条证据引用（证据先于断言，零证据不构成验证；'
      + 'CLI 侧已拦截，本守卫防 CLI 外调用方绕过）',
    );
  }
  const revision = computeRevisionSet(root, planPath);
  const payload = basePayload(root, taskId, 'verification', revision, now);
  Object.assign(payload, {
    status: 'passed',
    evidenceProfile: profile,
    evidenceRefs,
    artifactRefs: [],
  });
  if (profile === 'scout-repro') {
    // scout 档必须带 mode 与产物处置（内部接口-11：可复现运行 + 处置声明）
    if (!isPlainObject(scout) || !Object.prototype.hasOwnProperty.call(scout, 'mode')
      || !Object.prototype.hasOwnProperty.call(scout, 'disposition')) {
      throw new Error('scout-repro 档必须携带 mode 与产物处置（disposition）');
    }
    payload.scout = scout;
  }
  return writeReceipt(root, payload);
}

/**
 * 解析 verification 凭据绑定的计划（计划口径自述继承：未显式传 --plan 时自动继承）。
 * @returns {{effectivePlan: string|null}}
 */
function inheritPlan(root, v, planPath) {
  const boundPlan = get(get(v, 'revision', {}), 'planSha256', null);
  const boundRel = isPlainObject(boundPlan) ? get(boundPlan, 'path', null) : null;
  if (!pyTruthy(boundRel)) return { effectivePlan: null };
  const effectivePlan = underRoot(root, String(boundRel));
  if (planPath !== null && planPath !== undefined
    && looseRealpath(planPath) !== looseRealpath(effectivePlan)) {
    throw new Error('传入计划与 verification 凭据绑定的计划不一致');
  }
  return { effectivePlan };
}

/** 载入并校验被引 verification 凭据（同任务/完整性/kind），返回凭据对象。 */
function loadVerification(root, taskId, verificationReceiptId) {
  const v = loadReceipt(root, taskId, verificationReceiptId);
  if (v === null) {
    // G07/内部任务-241：文件在位但不可解析≠不存在——报「损坏」而非误导性的「凭据不存在」。
    const receiptPath = join(receiptsDir(root, taskId), `${verificationReceiptId}.json`);
    if (existsSync(receiptPath)) {
      throw new Error(`verification 凭据损坏/不可解析：${receiptPath}（请人工核查或重签，不可按不存在处理）`);
    }
    throw new Error(verificationNotFoundMessage(taskId, verificationReceiptId));
  }
  const [ok, reason] = verifyReceiptFile(
    join(receiptsDir(root, taskId), `${verificationReceiptId}.json`),
  );
  if (!ok) throw new Error(`verification 凭据无效：${reason}`);
  return v;
}

/**
 * 修复后复审「模式×实例数」形态校验（内部任务-193 A11 单源）：只校形态面——mode 词表、
 * exempt/deliverable 只允许 none、真值表（none/self=0、delta=1、full≥3）与安全非负整数；
 * 不校 reason/base/diff（那是 normalizeFixReview 的职责）。导出供 CLI 在 provenance
 * 必填检查之前调用：先报形态错（退 1），再报缺参数（退 2）——不许把档位/实例数错误
 * 误报成缺 --fix-review-provenance（A11 诊断误导缺陷）。
 * @param {Record<string, unknown>} opts
 * @param {string} reviewMode
 * @returns {{fixReviewMode:string, fixReviewInstances:number}}
 */
export function normalizeFixReviewShape(opts = {}, reviewMode) {
  const { fixReviewMode = 'none', fixReviewInstances = 0 } = opts;
  if (!FIX_REVIEW_MODES.includes(fixReviewMode)) {
    throw new Error(`非法 fix_review_mode：${fixReviewMode}（合法值 ${FIX_REVIEW_MODES.join('|')}）`);
  }
  const instances = Number(fixReviewInstances);
  if (!Number.isSafeInteger(instances) || instances < 0) {
    throw new Error(`fixReviewInstances 须为非负整数（收到 ${fixReviewInstances}）`);
  }
  if ((reviewMode === 'exempt' || reviewMode === 'deliverable') && fixReviewMode !== 'none') {
    throw new Error(`${reviewMode} 形态只允许 fixReviewMode=none（修复复审仅适用于代码评审环）`);
  }
  if (fixReviewMode === 'none' && instances !== 0) {
    throw new Error(`fixReviewMode=none 要求实例 0（当前 ${instances}）——有修复不得记 none`);
  }
  if (fixReviewMode === 'self' && instances !== 0) {
    throw new Error(`fixReviewMode=self 须 0 个独立实例（当前 ${instances}）`);
  }
  if (fixReviewMode === 'delta' && instances !== 1) {
    throw new Error(`fixReviewMode=delta 须恰 1 个 fresh-context 实例（当前 ${instances}）`);
  }
  if (fixReviewMode === 'full' && instances < 3) {
    throw new Error(`fixReviewMode=full 须 ≥3 个 fresh-context 实例（当前 ${instances}）`);
  }
  return { fixReviewMode, fixReviewInstances: instances };
}

/**
 * 归一/校验修复后复审五字段（内部任务-156 / 内部决策-4）。none 必须全空；self 0 实例 + 理由 +
 * base/diff；delta 恰 1 实例；full ≥3 实例；exempt/deliverable 只允许 none。
 * 形态面（mode 词表 + 实例数真值表）经 normalizeFixReviewShape 单源（A11）；
 * 本函数只在其后校理由/base/diff。
 * @returns {{fixReviewMode:string, fixReviewInstances:number, fixReviewReason:string,
 *            fixReviewBase:string, fixReviewDiffSha:string}}
 */
function normalizeFixReview(opts, reviewMode) {
  const { fixReviewMode, fixReviewInstances: instances } = normalizeFixReviewShape(opts, reviewMode);
  const { fixReviewReason = null, fixReviewBase = null, fixReviewDiffSha = null } = opts;
  const reason = fixReviewReason == null ? '' : String(fixReviewReason).trim();
  const base = fixReviewBase == null ? '' : String(fixReviewBase).trim();
  let diff = fixReviewDiffSha == null ? '' : String(fixReviewDiffSha).trim();
  if (diff.toLowerCase().startsWith('sha256:')) diff = diff.slice('sha256:'.length);
  if (fixReviewMode === 'none') {
    if (reason || base || diff) {
      throw new Error('fixReviewMode=none 要求理由/base/diff 均为空——有修复不得记 none');
    }
  } else {
    if (fixReviewMode === 'self' && !reason) {
      throw new Error('fixReviewMode=self 须记录一句「为何无语义变更」的理由（--fix-review-reason）');
    }
    if (!FIX_REVIEW_BASE_RE.test(base)) {
      throw new Error('fixReviewBase 须为 7-64 位十六进制基线提交 SHA（--fix-review-base）');
    }
    if (!FIX_REVIEW_DIFF_RE.test(diff)) {
      throw new Error('fixReviewDiffSha 须为 16-64 位十六进制 sha256（可带 sha256: 前缀；--fix-review-diff-sha）');
    }
  }
  return {
    fixReviewMode,
    fixReviewInstances: instances,
    fixReviewReason: reason,
    fixReviewBase: base,
    fixReviewDiffSha: diff,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部任务-191：评审实例 provenance（receipt 2.1.0）
// 条目契约（内部规则-10/内部规则-16）：{role, instance, chain, state, note?, crossStage?}；
// chain 必须等于 task:<taskId>（跨任务一律拒）；同名 role/instance 同凭据唯一；
// round=1 全 fresh；countable（fresh|reused）数=实例数，rehydrated 补位不计入。
// ─────────────────────────────────────────────────────────────────────────────
const PROVENANCE_STATES = ['fresh', 'reused', 'rehydrated'];

/** code-review 实例链身份（内部任务-191）：`task:<taskId>`。 */
export function reviewChainIdentity(taskId) {
  return `task:${taskId}`;
}

/**
 * 归一 reviewRound（1..999；缺省 1）。
 * 严格类型（内部任务-193 A1）：只受理 number 或纯数字字符串（`^\d{1,3}$`）；`true`/`[1]`/`" 1 "`
 * 一类可被宽松 Number() 折成 1 的值一律拒——轮次是声明面而非计算面，宽松转换会给
 * 「伪造/存量坏凭据」留旁路（读侧判死不变量被折算绕过）。
 */
export function normalizeReviewRound(raw, label = 'reviewRound') {
  if (raw === undefined) return 1;
  let n = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) n = Number(raw);
  if (n === null || !Number.isSafeInteger(n) || n < 1 || n > 999) {
    throw new Error(`${label} 须为 1..999 整数（收到 ${String(raw)}）`);
  }
  return n;
}

/**
 * 归一/校验 reviewProvenance（数组或 JSON 字符串）。
 * @param {unknown} raw @param {{taskId:string, count:number, round?:number, label?:string}} o
 * @returns {Array<object>} 归一后的条目数组（原对象顺序）
 */
export function normalizeReviewProvenance(raw, { taskId, count, round = 1, label = 'reviewProvenance' }) {
  let arr;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new Error(`${label} 非法 JSON（须数组；每项 role/instance/chain/state）`);
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) throw new Error(`${label} 须为数组`);
  const chain = reviewChainIdentity(taskId);
  const seenRole = new Set();
  const seenInstance = new Set();
  let countable = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const e = arr[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${label}[${i}] 须为对象`);
    const role = typeof e.role === 'string' ? e.role.trim() : '';
    const instance = typeof e.instance === 'string' ? e.instance.trim() : '';
    if (role === '') throw new Error(`${label}[${i}] 缺 role（视角/维度名）`);
    if (instance === '') throw new Error(`${label}[${i}] 缺 instance（实例标识）`);
    if (!PROVENANCE_STATES.includes(e.state)) {
      throw new Error(`${label}[${i}] state 非法：${String(e.state)}（合法 fresh|reused|rehydrated）`);
    }
    if (typeof e.chain !== 'string' || e.chain !== chain) {
      throw new Error(`${label}[${i}] chain（${String(e.chain)}）须为 ${chain}——跨任务/跨链实例不得计入`);
    }
    if (seenRole.has(role)) throw new Error(`${label} role 重复：${role}（同凭据内每视角/维度各一）`);
    if (seenInstance.has(instance)) {
      throw new Error(`${label} instance 重复：${instance}（同一实例不得填多个视角充独立性计数）`);
    }
    seenRole.add(role);
    seenInstance.add(instance);
    if (e.crossStage !== undefined && e.crossStage !== false) {
      // 内部任务-193 A2（D3）：规格只写「true 须带 note」未禁 false——false 视同缺省（显式
      // 声明「非跨阶段」是合法习惯），仅 true 要求非空 note；null/"true"/1 等改形值硬拒
      // （防真假值混淆）。sidecar 侧（routing-lib）仍整字段拒，不在本文件范围。
      if (e.crossStage !== true) {
        throw new Error(`${label}[${i}] crossStage 仅允许 true 或缺省/false（收到 ${String(e.crossStage)}）`);
      }
      if (typeof e.note !== 'string' || e.note.trim() === '') {
        throw new Error(`${label}[${i}] crossStage:true 须带非空 note（跨阶段复用理由）`);
      }
    }
    if (e.state === 'fresh' || e.state === 'reused') countable += 1;
  }
  if (round === 1 && arr.some((e) => e.state !== 'fresh')) {
    throw new Error(`${label} 在 round=1 须全部 state=fresh（首轮 fresh 契约）`);
  }
  if (countable !== count) {
    throw new Error(`${label} countable（fresh|reused）须等于实例数 ${count}，实际 ${countable}；rehydrated 补位不计入`);
  }
  return arr;
}

/**
 * 凭据的 provenance 状态投影（读侧单源；gate/verifyReceiptChain 共用）。
 * state：exempt（豁免免）| not-required（user-audit 人审免）| legacy（2.0.0 放行+gate warning）
 * | absent（无凭据）| present（合法）| invalid（硬拒，含 reason）。
 * fixProvenanceState（内部任务-193 A4）：none|present|absent|invalid——early return 恒 none，
 * 读侧与 gate 投影共用同一词表，不在 gate 侧另起 Array.isArray 判定（两套口径会漂移）。
 * 读侧严格计数（内部任务-193 S1/S2）：reviewInstances 须 ≥1 安全整数；fixReviewInstances 缺省 0、
 * 出现则须非负安全整数——宽 Number() 会把 '3'/true 折成合法值，给伪造件留旁路；写侧保留
 * 既有 Number() 语义（CLI 参数是字符串面）。
 * D3 反向不变量（内部任务-193 A3）：fixReviewInstances=0 却携带 fixReviewProvenance 属自相矛盾
 * 声明，与「>0 缺 provenance」对称硬拒。
 * @param {Record<string,unknown>|null} receipt @param {{taskId:string}} o
 * @returns {{state:string, reason?:string, round?:number, fixInstances?:number,
 *            fixProvenanceState?:string}}
 */
export function reviewProvenanceStatusOf(receipt, { taskId }) {
  if (!receipt) return { state: 'absent', reason: '无评审凭据', fixProvenanceState: 'none' };
  const mode = get(receipt, 'reviewMode', null);
  if (mode === 'exempt') return { state: 'exempt', fixProvenanceState: 'none' };
  if (mode === 'user-audit') return { state: 'not-required', fixProvenanceState: 'none' };
  const own = (k) => Object.prototype.hasOwnProperty.call(receipt, k);
  if (get(receipt, 'schemaVersion', null) !== RECEIPT_SCHEMA_VERSION) {
    return {
      state: 'legacy',
      reason: `legacy 凭据（schemaVersion ${String(get(receipt, 'schemaVersion', null))}）无实例 provenance，gate 供人在环复核`,
      fixProvenanceState: 'none',
    };
  }
  let fixState = 'none';
  try {
    const hasRound = own('reviewRound');
    const hasProv = own('reviewProvenance');
    if (!hasRound || !hasProv) {
      throw new Error('2.1.0 非豁免形态缺 reviewRound/reviewProvenance（D6：新凭据两字段必填，缺任一即无效）');
    }
    const round = normalizeReviewRound(get(receipt, 'reviewRound', null));
    const reviewInstances = get(receipt, 'reviewInstances', 0);
    if (typeof reviewInstances !== 'number' || !Number.isSafeInteger(reviewInstances)
      || reviewInstances < 1) {
      throw new Error(`2.1.0 凭据 reviewInstances 须为 ≥1 的安全整数（收到 ${String(reviewInstances)}）`);
    }
    normalizeReviewProvenance(get(receipt, 'reviewProvenance', null), {
      taskId, count: reviewInstances, round,
    });
    const rawFixInstances = get(receipt, 'fixReviewInstances', 0);
    if (typeof rawFixInstances !== 'number' || !Number.isSafeInteger(rawFixInstances)
      || rawFixInstances < 0) {
      throw new Error(`2.1.0 凭据 fixReviewInstances 须为非负安全整数（收到 ${String(rawFixInstances)}）`);
    }
    const fixInstances = rawFixInstances;
    if (fixInstances > 0) {
      if (!own('fixReviewProvenance')) {
        fixState = 'absent';
        throw new Error('2.1.0 凭据 fixReviewInstances>0 缺 fixReviewProvenance（D3/D6 不变量）');
      }
      fixState = 'invalid'; // 先按非法投影；归一通过后才转 present（异常出口不留假 present）
      normalizeReviewProvenance(get(receipt, 'fixReviewProvenance', null), {
        taskId, count: fixInstances, round: round + 1, label: 'fixReviewProvenance',
      });
      fixState = 'present';
    } else if (own('fixReviewProvenance')) {
      fixState = 'invalid';
      throw new Error('2.1.0 凭据 fixReviewInstances=0 不得携带 fixReviewProvenance（D3 反向不变量）');
    }
    return { state: 'present', round, fixInstances, fixProvenanceState: fixState };
  } catch (e) {
    return { state: 'invalid', reason: e.message, fixProvenanceState: fixState };
  }
}

/**
 * 签发 code-review 凭据——受理校验：所引 verification 凭据同任务、inspection-only
 * 不算、revision 与当前一致（源码变了先回 verification 重跑）。
 * 计划口径自述继承（评审 C1 处置）：verification 绑定了计划则按其 planPath 重算比对；
 * 显式传入 --plan 时须与绑定一致。
 * 评审真实性机械字段（补救 R4）：reviewInstances=countable 槽位数（fresh|reused 实例数；
 * rehydrated 补位不计入），非豁免形态 <1 即拒绝签发；reviewMode ∈ three-dim（默认三维）/
 * single-instance/user-audit/exempt/deliverable。
 * 内部任务-191（receipt 2.1.0）：非 exempt/user-audit 形态另须 reviewProvenance（实例来源数组，
 * chain=task:<taskId>、role/instance 同凭据唯一、countable 计数、round=1 全 fresh）与
 * reviewRound（1..999）；fixReviewInstances>0 须 fixReviewProvenance（countable=fixReviewInstances）。
 * 库面直发缺 provenance 时如实降级 schemaVersion=2.0.0（legacy 可读 + gate warning），不得冒充 2.1.0。
 * 阶段级凭据：stage 非空时签发 `code-review-{taskId}-s{stage}`（不进完成链，不要求先有
 * verification）；豁免形态：reviewMode=exempt + 任务级（与 stage 互斥）+ 理由/计划必填。
 * @param {string} root @param {string} taskId @param {string|null} verificationReceiptId
 * @param {string} summary
 * @param {{planPath?: string|null, reviewInstances?: number, reviewMode?: string,
 *          stage?: string|null, exemptionReason?: string|null, now?: string,
 *          reviewRound?: number, reviewProvenance?: Array<object>|string|null,
 *          fixReviewProvenance?: Array<object>|string|null,
 *          fixReviewMode?: string, fixReviewInstances?: number, fixReviewReason?: string|null,
 *          fixReviewBase?: string|null, fixReviewDiffSha?: string|null}} [opts]
 * @returns {Record<string, unknown>}
 */
export function issueCodeReviewReceipt(root, taskId, verificationReceiptId, summary, opts = {}) {
  const {
    planPath = null, reviewInstances = 0, reviewMode = 'three-dim',
    stage = null, exemptionReason = null, now,
    reviewRound: reviewRoundRaw = 1,
    reviewProvenance: reviewProvenanceRaw = null,
    fixReviewProvenance: fixReviewProvenanceRaw = null,
  } = opts;
  if (!REVIEW_MODES.includes(reviewMode)) throw new Error(`非法 review_mode：${reviewMode}`);
  const fixReview = normalizeFixReview(opts, reviewMode);
  const exempt = reviewMode === 'exempt';
  if (exempt) {
    if (stage !== null && stage !== undefined) {
      throw new Error('豁免凭据（--review-mode exempt）不支持 --stage：豁免是任务级完成链形态，非阶段留痕');
    }
    if (exemptionReason === null || exemptionReason === undefined
      || String(exemptionReason).trim() === '') {
      throw new Error('豁免凭据须带非空豁免理由（--exemption-reason）——豁免要留痕，空理由不构成豁免（R-M3-11 计划内豁免的凭据化）');
    }
    if (planPath === null || planPath === undefined) {
      throw new Error('豁免凭据须带计划引用（--plan）——豁免理由须锚定具体计划内的豁免记录');
    }
    let st = null;
    try { st = statSync(planPath); } catch { st = null; }
    if (!st || !st.isFile()) {
      // 三维评审正确性处置（82）：计划不存在即签发＝豁免锚定脱钩——受理面先拦
      throw new Error(`豁免凭据的计划引用不存在：${planPath}——豁免须锚定真实在案的计划`);
    }
  } else {
    if (exemptionReason !== null && exemptionReason !== undefined) {
      throw new Error('--exemption-reason 仅用于 --review-mode exempt 豁免形态');
    }
    if (reviewInstances < 1) {
      throw new Error('code-review 凭据须声明 review_instances ≥ 1（跳过并行评审实例不得签发完成链凭据——封堵语义冒充）');
    }
  }
  // 内部任务-191：receipt 2.1.0 实例 provenance / 轮次（CLI 对非豁免形态强制；库面缺省=legacy 声明，
  // 读侧产 legacy warning 不硬拒——存量调用与迁移窗口可读；exempt/user-audit 禁带）
  const reviewRound = normalizeReviewRound(reviewRoundRaw);
  const instanceMode = reviewMode !== 'exempt' && reviewMode !== 'user-audit';
  const haveProv = reviewProvenanceRaw !== null && reviewProvenanceRaw !== undefined && reviewProvenanceRaw !== '';
  let reviewProvenance = null;
  if (instanceMode) {
    if (haveProv) {
      reviewProvenance = normalizeReviewProvenance(reviewProvenanceRaw, {
        taskId, count: reviewInstances, round: reviewRound,
      });
    }
  } else if (haveProv) {
    throw new Error(`reviewMode=${reviewMode} 不得携带 --review-provenance（人审/豁免无代理实例）`);
  }
  const fixCount = Number(fixReview.fixReviewInstances ?? 0);
  const haveFixProv = fixReviewProvenanceRaw !== null && fixReviewProvenanceRaw !== undefined && fixReviewProvenanceRaw !== '';
  let fixReviewProvenance = null;
  if (fixCount > 0 && haveFixProv) {
    fixReviewProvenance = normalizeReviewProvenance(fixReviewProvenanceRaw, {
      taskId, count: fixCount, round: reviewRound + 1, label: 'fixReviewProvenance',
    });
  } else if (fixCount === 0 && haveFixProv) {
    throw new Error('fixReviewInstances=0 不得携带 --fix-review-provenance');
  }
  // D6/D7：库面直发为内部/测试通道——provenance 缺省时如实降级 schemaVersion=2.0.0（legacy），
  // 由读侧 legacy 投影 + gate warning 呈现，不冒充 2.1.0；生产签发唯一入口 CLI 对非豁免形态强制
  // provenance（不符即退 2），读侧对 2.1.0 缺字段判死。该替代缓解已回写 内部规则-10/内部未决-167。
  const legacyMode = (instanceMode && reviewProvenance === null)
    || (fixCount > 0 && fixReviewProvenance === null);
  if (stage !== null && stage !== undefined) {
    if (typeof stage !== 'string' || !pyReMatch(STAGE_ID_RE, stage)) {
      throw new Error(`非法 stage 标识：${stage}（须 ^[A-Za-z0-9-]{1,16}$——进文件名，防路径逃逸）`);
    }
    const revisionS = computeRevisionSet(root, planPath);
    const payloadS = basePayload(root, taskId, 'code-review', revisionS, now);
    payloadS.receiptId = `code-review-${taskId}-s${stage}`;
    Object.assign(payloadS, {
      status: 'passed',
      stage,
      stageReceipt: true, // 机械标记：不进完成链（latestReceipt 按文件名形态排除）
      evidenceProfile: 'full',
      summary,
      reviewInstances,
      reviewMode,
      ...(instanceMode && reviewProvenance !== null ? { reviewRound, reviewProvenance } : {}),
      ...(fixReviewProvenance === null ? {} : { fixReviewProvenance }),
      ...fixReview,
    });
    if (legacyMode) payloadS.schemaVersion = '2.0.0';
    return writeReceipt(root, payloadS);
  }
  const v = loadVerification(root, taskId, verificationReceiptId);
  if (get(v, 'kind', null) === 'inspection-only') {
    throw new Error('inspection-only 凭据永不满足完成评审（IF-COLLAB-11）');
  }
  if (get(v, 'kind', null) !== 'verification') {
    throw new Error(`所引凭据种类错误：${get(v, 'kind', null)}`);
  }
  const { effectivePlan } = inheritPlan(root, v, planPath);
  const revision = computeRevisionSet(root, effectivePlan);
  const current = revisionSetToDict(revision);
  const divergence = revisionDivergence(root, get(v, 'revision', {}), current);
  if (divergence !== null) {
    // 内部任务-40：内容桶变化 ⇒ 原重签指引；内容桶未变而 head 不可证 ⇒ 具名诊断
    const [kind, reason] = divergence;
    if (kind === 'content-changed') {
      throw new Error(staleVerificationMessage(taskId, '再重跑 issue-code-review'));
    }
    throw new Error(headUnverifiableMessage(taskId, reason));
  }
  const payload = basePayload(root, taskId, 'code-review', revision, now);
  Object.assign(payload, {
    status: 'passed',
    verificationReceipt: verificationReceiptId,
    evidenceProfile: get(v, 'evidenceProfile', 'full'), // 档位随链继承，不得提升
    summary,
    reviewInstances: exempt ? 0 : reviewInstances,
    reviewMode,
    ...(instanceMode && reviewProvenance !== null ? { reviewRound, reviewProvenance } : {}),
    ...(fixReviewProvenance === null ? {} : { fixReviewProvenance }),
    ...fixReview,
  });
  if (legacyMode) payload.schemaVersion = '2.0.0';
  if (exempt) {
    // P3 机械标记：gate 据此恒现豁免呈现 warning（人在环）并跳过评审覆盖提示（P7）
    payload.exemptReceipt = true;
    payload.exemptionReason = String(exemptionReason).trim();
    // 对齐 pathlib.Path(...).as_posix()：去掉首段 './' 与重复分隔符（相对路径口径）
    payload.planRef = toPosix(planPath).replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/');
  }
  return writeReceipt(root, payload);
}

/**
 * 签发 inspection-only 凭据（用户点名审计路径；永不进入完成链）。
 * @param {string} root @param {string} taskId @param {string} scope
 * @param {{now?: string}} [opts]
 * @returns {Record<string, unknown>}
 */
export function issueInspectionReceipt(root, taskId, scope, opts = {}) {
  const revision = computeRevisionSet(root);
  const payload = basePayload(root, taskId, 'inspection-only', revision, opts.now);
  Object.assign(payload, { status: 'passed', scope });
  return writeReceipt(root, payload);
}

/** probe 形态受理（只验形态、不执行——执行归 gate/probes）。 */
function validateProbe(probe, index) {
  if (!isPlainObject(probe) || !PROBE_TYPES.includes(probe.type)) {
    throw new Error(`验证判据第 ${index} 项 probe.type 非法（v2 合法：${PROBE_TYPES.join(', ')}）`);
  }
  const ptype = probe.type;
  const pathSpec = get(probe, 'path', null);
  const pathBad = !isPlainObject(pathSpec)
    || !PATH_BASES.includes(pathSpec.base)
    || typeof pathSpec.rel !== 'string' || !pathSpec.rel;
  // path 按类型需求校验（内部决策-030 决策 5）：可选类型缺 path 合法、给了 path 仍须合法
  // （防笔误静默）；必填类型缺/坏 path 均拒签（v1 行为不变，回归守卫用例锁定）
  if (PATH_OPTIONAL_TYPES.has(ptype) ? (pathSpec !== null && pathSpec !== undefined && pathBad) : pathBad) {
    throw new Error(`验证判据第 ${index} 项 probe.path 形态非法（须 base∈project|user-home + 非空 rel）`);
  }
  if (ptype === 'acl-state' || ptype === 'audit-policy-state') {
    const expect = get(probe, 'expect', null);
    if (!isPlainObject(expect)) {
      throw new Error(`验证判据第 ${index} 项 probe.expect 须为对象（${ptype} 专属字段校验，ADR-030）`);
    }
    if (ptype === 'acl-state') {
      const account = get(expect, 'denyAccount', null);
      if (typeof account !== 'string' || account.trim() === '') {
        throw new Error(`验证判据第 ${index} 项 expect.denyAccount 须为非空字符串`);
      }
      const rights = get(expect, 'denyRights', null);
      if (rights !== null && rights !== undefined
        && (!Array.isArray(rights)
          || !rights.every((r) => typeof r === 'string' && ACL_RIGHTS.has(r)))) {
        throw new Error(`验证判据第 ${index} 项 expect.denyRights 须为 ACL_RIGHTS 白名单内简码数组`);
      }
    } else {
      const guid = get(expect, 'subcategoryGuid', null);
      if (typeof guid !== 'string' || !guidOk(guid)) {
        throw new Error(`验证判据第 ${index} 项 expect.subcategoryGuid 须为 GUID 形态：{...}`);
      }
      if (!['empty', 'not-empty'].includes(get(expect, 'inclusion', null))) {
        throw new Error(`验证判据第 ${index} 项 expect.inclusion 须为 empty|not-empty`);
      }
    }
  }
  if (ptype === 'host-app-present') {
    // 内部决策-048（内部任务-11）：无 path 类型（同 audit-policy-state 先例）；只校 expect 枚举形态不执行
    const expect = get(probe, 'expect', null);
    if (!isPlainObject(expect)) {
      throw new Error(`验证判据第 ${index} 项 probe.expect 须为对象（host/presence，ADR-048）`);
    }
    const host = get(expect, 'host', null);
    if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(HOST_ENV_OVERRIDE, host)) {
      throw new Error(`验证判据第 ${index} 项 expect.host 须为 zcode|mcode|kimi|dsh`);
    }
    if (!['present', 'absent'].includes(get(expect, 'presence', null))) {
      throw new Error(`验证判据第 ${index} 项 expect.presence 须为 present|absent`);
    }
  }
}

/**
 * 签发 operation 凭据（零变更操作型任务完成档第二环，内部决策-023；内部决策-027 增机检/分级）——
 * 受理校验（反语义冒充）：授权引文非空且 ≥8 字、授权范围/验证判据/回滚/生效边界齐备、
 * recordRef 强制（文件真实存在且实测哈希一致）。riskLevel ∈ {L1,L2}，缺省 L2。
 * @param {string} root @param {string} taskId @param {string} verificationReceiptId
 * @param {{authorizationQuote: string, authorizationScope: string,
 *          verificationCriteria: Array<Record<string, unknown>>, rollback: string,
 *          effectiveBoundary: string, recordRef: Record<string, string>,
 *          planPath?: string|null, riskLevel?: string, now?: string}} opts
 * @returns {Record<string, unknown>}
 */
export function issueOperationReceipt(root, taskId, verificationReceiptId, opts = {}) {
  const {
    authorizationQuote, authorizationScope, verificationCriteria, rollback, effectiveBoundary,
    recordRef, planPath = null, riskLevel = 'L2', now,
  } = opts;
  if (typeof authorizationQuote !== 'string') {
    throw new Error('授权引文必须是字符串（缺省/非字符串不构成授权凭据——反语义冒充）');
  }
  const quote = authorizationQuote.trim();
  if ([...quote].length < 8) {
    throw new Error('授权引文至少 8 字（空引文/过短引文不构成授权凭据——反语义冒充）');
  }
  if (String(authorizationScope).trim() === '') throw new Error('授权范围不得为空');
  if (String(rollback).trim() === '') throw new Error('回滚不得为空');
  if (String(effectiveBoundary).trim() === '') throw new Error('生效边界不得为空');
  if (!['L1', 'L2'].includes(riskLevel)) {
    throw new Error(`非法 riskLevel：${riskLevel}（合法：L1 本地可逆轻档 / L2 不可逆或跨边界）`);
  }
  if (!Array.isArray(verificationCriteria) || verificationCriteria.length === 0) {
    throw new Error('验证判据须为非空数组');
  }
  for (let i = 0; i < verificationCriteria.length; i += 1) {
    const item = verificationCriteria[i];
    if (!isPlainObject(item)
      || String(get(item, 'criterion', '')).trim() === ''
      || String(get(item, 'evidenceRef', '')).trim() === '') {
      throw new Error(`验证判据第 ${i + 1} 项须含非空 criterion 与 evidenceRef`);
    }
    const probe = get(item, 'probe', null);
    if (probe !== null && probe !== undefined) validateProbe(probe, i + 1);
  }
  if (!isPlainObject(recordRef) || String(get(recordRef, 'path', '')).trim() === '') {
    throw new Error('operation 凭据强制携带 recordRef（操作记录文件路径）');
  }
  const recordRel = String(recordRef.path);
  if (recordRel.split(/[\\/]+/).includes('..')) {
    throw new Error(`recordRef 不得含 '..' 段（越界/符号链接组合拒绝）：${recordRel}`);
  }
  const recordAbs = underRoot(root, recordRel);
  if (!isWithinRoot(root, recordAbs)) {
    throw new Error(`recordRef 必须是仓库内相对路径（绝对路径/越界路径拒绝）：${recordRel}`);
  }
  let recordSt = null;
  try { recordSt = statSync(recordAbs); } catch { recordSt = null; }
  if (!recordSt || !recordSt.isFile()) {
    throw new Error(`操作记录文件不存在：${recordRef.path}`);
  }
  const actual = `sha256:${sha256Hex(readFileSync(recordAbs))}`;
  if (get(recordRef, 'sha256', null) !== actual) {
    throw new Error('recordRef 哈希与操作记录文件实测不一致');
  }
  const v = loadVerification(root, taskId, verificationReceiptId);
  if (get(v, 'kind', null) !== 'verification') {
    throw new Error(`所引凭据种类错误：${get(v, 'kind', null)}`);
  }
  // 计划口径自述继承（与 code-review 受理同型）：verification 绑定了计划则按其 planPath
  // 重算比对；显式传入 --plan 时须与绑定一致——不带 --plan 时自动继承，不给误导诊断
  const { effectivePlan } = inheritPlan(root, v, planPath);
  const revision = computeRevisionSet(root, effectivePlan);
  const current = revisionSetToDict(revision);
  const divergence = revisionDivergence(root, get(v, 'revision', {}), current);
  if (divergence !== null) {
    // 内部任务-40：与 code-review 第二环受理同款三态（内容桶不等→重签；head 不可证→指名诊断）
    const [kind, reason] = divergence;
    if (kind === 'content-changed') {
      throw new Error(staleVerificationMessage(taskId, '再按原参数重跑 issue-operation'));
    }
    throw new Error(headUnverifiableMessage(taskId, reason));
  }
  const payload = basePayload(root, taskId, 'operation', revision, now);
  Object.assign(payload, {
    status: 'passed',
    verificationReceipt: verificationReceiptId,
    authorization: {
      quote,
      scope: String(authorizationScope).trim(),
      authorizedBy: 'user',
    },
    verificationCriteria,
    riskLevel,
    rollback: String(rollback).trim(),
    effectiveBoundary: String(effectiveBoundary).trim(),
    recordRef: { path: String(recordRef.path), sha256: actual },
  });
  return writeReceipt(root, payload);
}

/**
 * 签发 gate 凭据——聚合结论（A4 的 assurance gate 调用）。
 * 绑定：verification 凭据 id + 第二环凭据 id（dev=code-review；operation=operation，二者
 * 互斥须且仅须其一）、delivery draft 内容哈希、RevisionSet。blocking>0 时 status=failed。
 * revision 由调用方传入已验证的 RevisionSet（gate 前后双算的 rev_after）——不在签发点
 * 第三次重算（2026-09-13 三维评审 C3 处置）。
 * @param {string} root @param {string} taskId @param {string} verificationReceiptId
 * @param {string|null} draftPath
 * @param {{blockingCount: number, warningCount: number, diagnostics?: Array<object>|null,
 *          revision?: object|null, codeReviewReceiptId?: string|null,
 *          operationReceiptId?: string|null, riskLevel?: string|null, now?: string}} opts
 * @returns {Record<string, unknown>}
 */
export function issueGateReceipt(root, taskId, verificationReceiptId, draftPath, opts = {}) {
  const {
    blockingCount, warningCount, diagnostics = null, revision: revisionInput = null,
    codeReviewReceiptId = null, operationReceiptId = null, riskLevel = null, now,
  } = opts;
  let revision = revisionInput;
  if (codeReviewReceiptId === null && operationReceiptId === null) {
    throw new Error('gate 凭据须绑定 code-review、operation 至少其一（dev/operation 单环；制品链双环）');
  }
  if (riskLevel !== null && !['L1', 'L2'].includes(riskLevel)) {
    throw new Error(`gate 凭据 riskLevel 非法：${riskLevel}（合法：L1/L2）`);
  }
  // 制品链双环齐时按四因子做签发点自洽（库层双保险，内部决策-023 修正案 2）；存在性/kind 先于
  // 因子判——凭据缺席走 ValueError 通道而非属性错误（CLI 外调用亦须受控拒绝）
  if (codeReviewReceiptId !== null && operationReceiptId !== null) {
    const cRec = loadReceipt(root, taskId, String(codeReviewReceiptId));
    const oRec = loadReceipt(root, taskId, String(operationReceiptId));
    for (const [rec, rid, kind] of [
      [cRec, codeReviewReceiptId, 'code-review'],
      [oRec, operationReceiptId, 'operation'],
    ]) {
      if (rec === null || get(rec, 'kind', null) !== kind) {
        throw new Error(`${kind} 凭据不存在或种类错误：${rid}`);
      }
    }
    if (get(cRec, 'reviewMode', null) !== 'deliverable') {
      throw new Error(
        '制品链（deliverable）评审环 reviewMode 非 deliverable：防 dev 任务以 '
        + 'three-dim 评审中途转链（ADR-023 修正案 2 四因子；须以 --review-mode deliverable 签发）',
      );
    }
    if (get(cRec, 'verificationReceipt', null) !== get(oRec, 'verificationReceipt', null)
      || get(oRec, 'verificationReceipt', null) !== verificationReceiptId) {
      throw new Error('制品链双环未同引同一 verification 凭据（四因子：双环同引）');
    }
    const cTs = receiptTs(cRec);
    const oTs = receiptTs(oRec);
    if (cTs === null || oTs === null || cTs > oTs) {
      throw new Error('制品链序颠倒：code-review 凭据须先于 operation 签发（createdAt，四因子：序）');
    }
  }
  const rings = [[verificationReceiptId, 'verification']];
  if (operationReceiptId !== null) rings.push([operationReceiptId, 'operation']);
  if (codeReviewReceiptId !== null) rings.push([codeReviewReceiptId, 'code-review']);
  for (const [rid, kind] of rings) {
    const rec = loadReceipt(root, taskId, String(rid));
    if (rec === null || get(rec, 'kind', null) !== kind) {
      throw new Error(`${kind} 凭据不存在或种类错误：${rid}`);
    }
  }
  // 内部决策-027：L1 操作链免两阶段交付报告，draft 可为 null（draftSha256 省略）；
  // dev/L2 形态 draft 仍强制存在。
  let draftDigest = null;
  if (draftPath !== null && draftPath !== undefined) draftDigest = sha256Hex(readFileSync(draftPath));
  if (revision === null || revision === undefined) revision = computeRevisionSet(root);
  const payload = basePayload(root, taskId, 'gate', revision, now);
  Object.assign(payload, {
    status: blockingCount > 0 ? 'failed' : 'passed',
    verificationReceipt: verificationReceiptId,
    codeReviewReceipt: codeReviewReceiptId,
    operationReceipt: operationReceiptId,
    chainProfile: (
      codeReviewReceiptId !== null && operationReceiptId !== null
        ? 'deliverable'
        : (operationReceiptId !== null ? 'operation' : 'dev')
    ),
    blockingCount,
    warningCount,
    diagnostics: diagnostics ?? [],
  });
  // 条件字段的插入位置对齐 Python 解包顺序（draftSha256 在 riskLevel 之前）
  if (draftDigest !== null) payload.draftSha256 = `sha256:${draftDigest}`;
  if (riskLevel !== null) payload.riskLevel = riskLevel;
  return writeReceipt(root, payload);
}

/** 单次 gate 内的 latestReceipt 读缓存（内部任务-242 §三-4）：同一事实一次流程内只读一次。 */
let latestReceiptCache = null;

/** 在缓存作用域内执行 fn（gate 用；嵌套时恢复外层缓存）。 */
export function withReceiptCache(fn) {
  const previous = latestReceiptCache;
  latestReceiptCache = new Map();
  try {
    return fn();
  } finally {
    latestReceiptCache = previous;
  }
}

/**
 * 读取某任务某种类的最新任务级凭据（序号最大者）；无则 null。
 * 阶段级凭据（`{kind}-{taskId}-s{stage}`）不参与选取。
 * 内部任务-242 §三-4：withReceiptCache 作用域内按 (root,taskId,kind) 缓存；一次性读取多处复用。
 * @param {string} root @param {string} taskId @param {string} kind
 * @returns {Record<string, unknown>|null}
 */
export function latestReceipt(root, taskId, kind) {
  const cacheKey = `${root}\0${taskId}\0${kind}`;
  if (latestReceiptCache !== null && latestReceiptCache.has(cacheKey)) return latestReceiptCache.get(cacheKey);
  const value = latestReceiptUncached(root, taskId, kind);
  if (_testHooks.latestReceiptRead !== null) _testHooks.latestReceiptRead({ root, taskId, kind });
  if (latestReceiptCache !== null) latestReceiptCache.set(cacheKey, value);
  return value;
}

function latestReceiptUncached(root, taskId, kind) {
  const directory = receiptsDir(root, taskId);
  if (!existsSync(directory)) return null;
  let names;
  try { names = readdirSync(directory).sort(); } catch { return null; } // 非目录形态按无凭据（Python 同向）
  const pattern = taskLevelRe(kind, taskId);
  let best = null;
  let bestSeq = -1;
  for (const name of names) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    const m = pattern.exec(stem);
    if (!m) continue;
    const rec = loadReceipt(root, taskId, stem);
    if (rec === null) continue;
    const seq = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seq)) continue;
    if (seq > bestSeq) { best = rec; bestSeq = seq; }
  }
  return best;
}

/**
 * 统计某任务 code-review 凭据总数（任务级 + 阶段级）——评审覆盖检查的分子。
 * 目录不存在返回 0（无评审即 0，不是异常）。
 * @param {string} root @param {string} taskId
 * @returns {number}
 */
export function countReviewReceipts(root, taskId) {
  const directory = receiptsDir(root, taskId);
  if (!existsSync(directory)) return 0;
  let names;
  try { names = readdirSync(directory); } catch { return 0; } // 非目录形态按无凭据
  return names.filter((n) => n.startsWith('code-review-') && n.endsWith('.json')).length;
}

/**
 * 凭据 createdAt 解析为 epoch 毫秒（对齐 Python `datetime.fromisoformat` 的 aware 比较）；
 * 缺失/不可解析返回 null——调用侧 null 即拒（fail-closed），不改写凭据。
 * @param {Record<string, unknown>} rec
 * @returns {number|null}
 */
function receiptTs(rec) {
  const raw = get(rec, 'createdAt', null);
  if (typeof raw !== 'string') return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * 完成链校验（三形态，内部决策-023 修正案 2 / 内部未决-128 方案 B，内部任务-116）：
 * dev=verification+code-review；operation=verification+operation；deliverable=
 * verification+code-review(deliverable)+operation。四因子（缺一即拒）：①显式 chainProfile
 * 声明；②评审环 reviewMode=deliverable；③双环同引最新 verification；④code-review 先于
 * operation。其余 operation 与 code-review 并存仍混链拒绝（文案附 --deliverable-chain 出路）。
 * 计划桶口径以凭据自述为准：链上凭据绑定的 planPath 自动重算比对；显式传入须与绑定一致。
 * @param {string} root @param {string} taskId
 * @param {{planPath?: string|null, chainProfile?: string}} [opts]
 * @returns {[boolean, string]}
 */
export function verifyReceiptChain(root, taskId, opts = {}) {
  const { planPath = null, chainProfile = 'dev' } = opts;
  if (!VALID_CHAIN_PROFILES.includes(chainProfile)) {
    throw new ChainProfileError(`非法链形态：${chainProfile}（合法：${VALID_CHAIN_PROFILES.join(', ')}）`);
  }
  const o = latestReceipt(root, taskId, 'operation');
  const c = latestReceipt(root, taskId, 'code-review');
  if (chainProfile === 'dev' && o !== null && c !== null) {
    return [false, (
      '混链拒绝：operation 与 code-review 凭据并存（任务类型不可中途转换；'
      + '制品型三环链须 --deliverable-chain 显式声明且评审环 reviewMode=deliverable，转换须新任务号）'
    )];
  }
  if (chainProfile === 'operation' && c !== null) {
    return [false, (
      '混链拒绝：operation 形态下 code-review 凭据并存（若为制品型任务，'
      + '请改用 --deliverable-chain 并确认评审环以 --review-mode deliverable 签发）'
    )];
  }
  if (chainProfile === 'deliverable' && (o === null || c === null)) {
    throw new ChainProfileError(
      '已声明制品链（--deliverable-chain）但双环不齐：须 verification → '
      + 'code-review(deliverable) → operation 三环，先补签缺失环或撤去旗标',
    );
  }
  if (chainProfile === 'operation' && o === null) {
    throw new ChainProfileError(
      '已声明操作链（--operation-chain）但任务目录无 operation 凭据：'
      + '先 issue-operation 签发，或撤去 --operation-chain',
    );
  }
  const directory = receiptsDir(root, taskId);
  if (!existsSync(directory)) {
    // 内部决策-042/内部规则-16 ⑥：归档任务与「从未签发」可区分——manifest 命中即报归档态并附
    // restore 指引；归档态判定失败不改变原「无凭据」语义（fail-open）。
    try {
      if (manifestIds(loadManifest(root)).has(taskId)) {
        return [false, (
          `任务 ${taskId} 凭据已归档（restore 可回放：archive-receipts 缺省 dry-run 查批次，`
          + `restore-receipts --task-id ${taskId} 回放后重验）`
        )];
      }
    } catch { /* fail-open：归档态判定失败不改变原「无凭据」语义 */ }
    return [false, `任务 ${taskId} 无任何凭据`];
  }
  const v = latestReceipt(root, taskId, 'verification');
  // 旗标关而目录有 operation：按 dev 形态校验（v+c）——防静默形态漂移（乙案双因子）；
  // deliverable 形态取双环，dev/operation 单环（形态由调用方显式声明，库层只验证不推导）
  let seconds;
  if (chainProfile === 'deliverable') {
    if (get(c, 'reviewMode', null) !== 'deliverable') {
      return [false, (
        '制品链评审环 reviewMode 非 deliverable——防 dev 任务以 three-dim 评审'
        + '中途转链（ADR-023 修正案 2 四因子；须以 --review-mode deliverable 重签评审环）'
      )];
    }
    seconds = [c, o];
  } else if (chainProfile === 'operation') {
    seconds = [o];
  } else {
    // G06/内部任务-241：dev 链不得消费制品链评审凭据（reviewMode=deliverable 仅制品链）。
    if (c !== null && get(c, 'reviewMode', null) === 'deliverable') {
      return [false, (
        'dev 链不得消费制品链评审凭据（reviewMode=deliverable 仅用于 --deliverable-chain；'
        + '如为制品型任务请改用 --deliverable-chain，否则以 --review-mode three-dim 重签评审环）'
      )];
    }
    seconds = c !== null ? [c] : [];
  }
  if (v === null || v === undefined || seconds.length === 0) {
    // G07/内部任务-241：文件在位但不可解析的凭据报「损坏」而非「不存在」（内部规则-14④ 可操作报错）。
    const damaged = [];
    if (v === null) damaged.push(...corruptKindFiles(root, taskId, 'verification'));
    if (seconds.length === 0 && chainProfile !== 'operation') damaged.push(...corruptKindFiles(root, taskId, 'code-review'));
    if (chainProfile === 'operation' && o === null) damaged.push(...corruptKindFiles(root, taskId, 'operation'));
    if (damaged.length > 0) {
      return [false, `凭据损坏/不可解析：${damaged.join('、')}（不是「不存在」——请人工核查或重签）`];
    }
    return [false, '凭据链不完整（缺 verification 或 code-review/operation）'];
  }
  for (const rec of [v, ...seconds]) {
    const path = join(directory, `${get(rec, 'receiptId', null)}.json`);
    const [ok, reason] = verifyReceiptFile(path);
    if (!ok) return [false, `${get(rec, 'receiptId', null)}：${reason}`];
  }
  for (const rec of seconds) {
    if (get(rec, 'verificationReceipt', null) !== get(v, 'receiptId', null)) {
      if (chainProfile === 'deliverable') {
        return [false, `${get(rec, 'kind', null)} 凭据未同引最新 verification 凭据（制品链双环同引，四因子）`];
      }
      return [false, `${get(rec, 'kind', null)} 凭据未引用最新 verification 凭据`];
    }
  }
  if (chainProfile === 'deliverable') {
    const cTs = receiptTs(c);
    const oTs = receiptTs(o);
    if (cTs === null || oTs === null || cTs > oTs) {
      return [false, '制品链序颠倒：code-review 凭据须先于 operation 签发（createdAt，四因子）'];
    }
  }
  const boundPlan = get(get(v, 'revision', {}), 'planSha256', null);
  const boundPlanRel = isPlainObject(boundPlan) ? get(boundPlan, 'path', null) : null;
  let effectivePlan = null;
  if (pyTruthy(boundPlanRel)) {
    const boundAbs = looseRealpath(underRoot(root, String(boundPlanRel)));
    if (planPath !== null && planPath !== undefined && looseRealpath(planPath) !== boundAbs) {
      return [false, '校验请求的计划与凭据绑定的计划不一致'];
    }
    effectivePlan = boundAbs;
  }
  // else：链自述无计划绑定，外部 --plan 仅作参考不参与 revision 比对（链口径以自述为准）
  let current;
  try {
    current = revisionSetToDict(computeRevisionSet(root, effectivePlan));
  } catch (e) {
    // 内部未决-109（内部任务-52）：链绑定计划被删/越界时 computeRevisionSet 抛错，穿透本函数
    // (bool, reason) 契约会让无包裹调用方以进程异常收场——按具名诊断口径转链失效。
    if (e instanceof Error && /^计划(?:路径越出项目根|文件不存在)/.test(e.message)) {
      return [false, `${get(v, 'receiptId', null)} 链绑定计划不可读/已删除：${e.message}`];
    }
    // 内部未决-131：非 UTF-8 路径使 JS 严格解码失败；Python 面 surrogateescape 可继续。
    // 阶段2 契约要求本函数恒返 (bool, reason)——按具名诊断转链失效，不让异常穿透。
    if (e instanceof RevisionDecodeError) {
      return [false, `${get(v, 'receiptId', null)} revision 无法计算（非 UTF-8 路径，OPEN-131）：${e.message}`];
    }
    throw e;
  }
  // 内部任务-40：逐凭据判等价——内容桶（源码去 head/规格/计划）全等而仅 `head` 位移时按
  // 内容桶等价判无害；内容桶任一不等即失效（含计划桶）。
  for (const rec of [v, ...seconds]) {
    const divergence = revisionDivergence(root, get(rec, 'revision', {}), current);
    if (divergence === null) continue;
    const [kind, reason] = divergence;
    if (kind === 'content-changed') {
      return [false, '凭据 revision 与当前不一致（源码/规格/计划已变化，链已失效）'];
    }
    return [false, `${get(rec, 'receiptId', null)} ${reason}`];
  }
  // 内部任务-191：读侧 provenance 一致性（2.1.0 非豁免形态非法即链失效；2.0.0 legacy 放行由 gate warning 呈现）
  const provStatus = reviewProvenanceStatusOf(c, { taskId });
  if (provStatus.state === 'invalid') {
    return [false, `code-review 凭据实例 provenance 非法：${provStatus.reason}`];
  }
  return [true, 'ok'];
}
