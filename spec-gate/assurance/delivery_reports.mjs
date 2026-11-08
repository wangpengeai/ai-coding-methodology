// 文件：delivery_reports.mjs
// 描述：delivery_reports.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段2 凭据链 2.3；永久件）——两阶段
//       交付报告（内部决策-007 / 内部接口-11）：prepare 只产 partial 草案；finalize 须当前 revision
//       的 gate 凭据且其 draftSha256 与当前草案内容一致，成功后落 delivery-final.json 并自动收敛
//       台账（RULE-LEDGER-003 机械化）。落点：内部治理状态<taskId>/delivery-draft.json 与
//       delivery-final.json。公开面与 原 Python 实现（迁移史见 内部决策-051）逐函数对齐：APPLICABILITY_VOCAB /
//       REQUIRED_SECTION_NAMES / SPEC_IMPACT_PLACEHOLDER / reportsDir / boundPlan /
//       applicabilityValid / missingRequiredSections / prepareDelivery / finalizeDelivery /
//       台账 upsert。第四 revision 消费点调 revision.mjs 的 revisionDivergence（内部任务-40 判据单点
//       承载）——与 receipts 三处同一语义（内容桶全等且 head 位移可证无害即放行）。
//       落盘口径：键序按 Python 插入顺序、`JSON.stringify(payload, null, 2) + "\n"`（固定 now 下
//       与 Python 逐字节相等，LF 归一）；`opts.now` 注入缺省 `nowIso()`。
//       已登记边界：Python `str()` 对非 JSON 标量（dict/list）走 repr，本模块实现同形 pyStr/pyRepr
//       覆盖字符串/布尔/数字/数组/对象；浮点 1.0 与整数 1 在 JS 不可区分（与 common.mjs 同一边界）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { atomicWriteText, nowIso, pyRepr, readUtf8Strict, sha256Hex, underRoot } from './common.mjs';
import { randomUUID } from 'node:crypto';
import { acquireLock, releaseLock } from './lock.mjs';
import {
  ChainProfileError, latestReceipt, receiptsDir, verifyReceiptChain, verifyReceiptFile,
} from './receipts.mjs';
import { computeRevisionSet, revisionDivergence, revisionSetToDict } from './revision.mjs';

// 适用性判定词表（与 spec-gate/skills/sdd-ddd-tdd/SKILL.md §2 判定节逐字镜像——单一事实源在 skill，
// 此常量是机械校验面；与 原 Python 实现（迁移史见 内部决策-051）同值同序）。
export const APPLICABILITY_VOCAB = {
  sdd: ['required', 'lightweight', 'exempt'],
  ddd: ['strategic', 'tactical', 'not-applicable'],
  tdd: ['strict', 'characterization-first', 'exempt'],
};

// 必检节名清单（内部规则-12：判定矩阵结论/证据引用/规格影响判定）——单一常量。
export const REQUIRED_SECTION_NAMES = ['applicability', 'receiptRefs', 'specImpact'];

// specImpact 的 prepare 缺省占位——仍为占位时不算必检节通过（gate warning / finalize 拒绝）。
export const SPEC_IMPACT_PLACEHOLDER = '待 gate 聚合核对';

/** 普通对象判定（对齐 Python `isinstance(x, dict)`；数组/null 均否）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python `dict.get` 语义：非对象/缺键取缺省；键存在（含 null）取实值。 */
function get(obj, key, fallback = null) {
  if (!isPlainObject(obj)) return fallback;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** Python 真值语义（空数组/空对象/空串/0/None 均假）。 */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python `str()` 的 JSON 值域形态（字符串原样；布尔/None 用 Python 字面量；容器走 repr）。 */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return v;
  return pyRepr(v);
}

/** Python `str(x or "")`：先按真值语义回退空串再 str（0/False/空容器与 None 同归空串）。 */
function pyStrOrEmpty(v) { return pyStr(pyTruthy(v) ? v : ''); }

/** Python tuple repr（词表诊断：`('required', 'lightweight', 'exempt')`）。 */
function pyTupleRepr(items) { return `(${items.map(pyRepr).join(', ')})`; }

/** Python list repr（必检节诊断：`['applicability', 'receiptRefs']`）。 */
function pyListRepr(items) { return `[${items.map(pyRepr).join(', ')}]`; }

/**
 * 报告目录（`内部治理状态<taskId>`）。
 * @param {string} root @param {string} taskId
 * @returns {string}
 */
export function reportsDir(root, taskId) { return join(root, '.sdd', 'reports', String(taskId)); }

/**
 * 链上凭据绑定的计划路径（评审 C1 处置：finalize 按链自述口径重算 revision）。
 * 以最新 verification 凭据的 `revision.planSha256.path` 为准；未绑定返回 null。
 * @param {string} root @param {string} taskId
 * @returns {string|null}
 */
export function boundPlan(root, taskId) {
  const v = latestReceipt(root, taskId, 'verification');
  const bound = get(get(v, 'revision', {}), 'planSha256', null);
  const rel = isPlainObject(bound) ? get(bound, 'path', null) : null;
  return pyTruthy(rel) ? underRoot(root, String(rel)) : null;
}

/**
 * 结构化判定布尔谓词（词表/结构/理由三轴；对齐 `applicability_valid`）。
 * @param {unknown} app
 * @returns {boolean}
 */
export function applicabilityValid(appValue) {
  if (!isPlainObject(appValue)) return false;
  return Object.entries(APPLICABILITY_VOCAB).every(([key, vocab]) => {
    const entry = get(appValue, key, null);
    if (!isPlainObject(entry)) return false;
    if (!vocab.includes(get(entry, 'conclusion', null))) return false;
    return pyStrOrEmpty(get(entry, 'reason', null)).trim().length > 0;
  });
}

/**
 * 结构化判定校验（内部未决-8）：三键齐备、conclusion 在词表、reason 非空。
 * @param {unknown} applicabilityValue
 * @returns {void}
 */
function validateApplicability(applicabilityValue) {
  for (const [key, vocab] of Object.entries(APPLICABILITY_VOCAB)) {
    const entry = isPlainObject(applicabilityValue) ? get(applicabilityValue, key, null) : null;
    if (!isPlainObject(entry)) {
      throw new Error(`applicability 缺 ${key} 项（须为 {conclusion, reason} 结构，OPEN-8）`);
    }
    const conclusion = get(entry, 'conclusion', null);
    if (!vocab.includes(conclusion)) {
      throw new Error(`applicability.${key}.conclusion=${pyRepr(conclusion)} 不在词表 ${pyTupleRepr(vocab)}`);
    }
    if (pyStrOrEmpty(get(entry, 'reason', null)).trim() === '') {
      throw new Error(`applicability.${key}.reason 不能为空（三项独立结论各带理由，OPEN-8）`);
    }
  }
}

/**
 * 内部规则-12 必检节缺失清单：判定矩阵结论（applicability）/ 证据引用（receiptRefs）/
 * 规格影响判定（specImpact 非占位）。gate 侧据此产 warning，finalize 侧据此拒绝落地。
 * @param {Record<string, unknown>} draft
 * @returns {string[]}
 */
export function missingRequiredSections(draft) {
  // 与 原 Python 实现（迁移史见 内部决策-051）同形：draft 非映射（None/数组）直接失败（`.get` 不可用），不当成「全缺」
  if (!isPlainObject(draft)) throw new TypeError('draft 须为对象（对齐 Python dict.get 的可调用面）');
  const missing = [];
  if (!applicabilityValid(get(draft, 'applicability', null))) missing.push('applicability');
  const receiptRefs = get(draft, 'receiptRefs', null);
  if (!Array.isArray(receiptRefs) || !pyTruthy(receiptRefs)) missing.push('receiptRefs');
  const specImpact = pyStrOrEmpty(get(draft, 'specImpact', null));
  if (specImpact.trim() === '' || specImpact === SPEC_IMPACT_PLACEHOLDER) missing.push('specImpact');
  return missing;
}

/**
 * 第一阶段：生成 partial 草案。prepare 不得产出 complete——完成只能由 finalize 在 gate 凭据
 * 验证后落定（消除「报告先于 gate 存在又要含 gate 结论」循环）。
 * @param {string} root @param {string} taskId
 * @param {{applicability: object, changeScope?: string[], receiptRefs?: string[],
 *          specImpact?: string, risks?: string[]|null, finalStatus?: string, now?: string}} opts
 * @returns {Record<string, unknown>}
 */
export function prepareDelivery(root, taskId, opts = {}) {
  const {
    applicability, changeScope = [], receiptRefs = [], specImpact = SPEC_IMPACT_PLACEHOLDER,
    risks = null, finalStatus = 'partial', now,
  } = opts;
  if (finalStatus !== 'partial') {
    throw new Error('prepare 只能产出 partial（complete 归 finalize，R/IF-COLLAB-11）');
  }
  validateApplicability(applicability);
  const draft = {
    schemaVersion: '2.1.0',
    taskId,
    finalStatus: 'partial',
    applicability,
    specImpact,
    changeScope,
    receiptRefs,
    risks: pyTruthy(risks) ? risks : [],
    unverified: [],
    preparedAt: now ?? nowIso(),
  };
  atomicWriteText(
    join(reportsDir(root, taskId), 'delivery-draft.json'),
    `${JSON.stringify(draft, null, 2)}\n`,
  );
  return draft;
}

/**
 * 台账收敛 upsert（2026-09-16 S1 批次）：finalize 成功后把本任务台账条目收敛为 converged
 * （finalStatus + gateReportRef）。既有条目原位更新（title/createdAt 等保留）；无条目则追加
 * （RULE-LEDGER-001 必填四字段齐备）；幂等——重复 upsert 不追加重复条目。
 * 响亮失败姿态：台账损坏/不可写即抛（finalize 是交互命令而非 hook，静默缺失正是本批要消灭
 * 的缺陷）；原子写 + 幂等 upsert 已够——与 task-lease 的 last-writer-wins 同纪律。
 * @param {string} root @param {Record<string, unknown>} finalReport @param {string} [now]
 * @returns {void}
 */
function upsertLedgerConverged(root, finalReport, now) {
  const taskId = pyStrOrEmpty(get(finalReport, 'taskId', null));
  if (taskId === '') throw new Error('final 报告缺 taskId，无法收敛台账');
  // D03（内部任务-241）：台账读-改-写持 内部治理状态（与 scout register/graduate 同一把锁）。
  const lockPath = join(root, '.sdd', 'ledger.lock');
  // 持有者唯一（内部任务-241 完成复审）：taskId 标签不足以区分 stale 回收前后的两代持有者，补 uuid8。
  const lock = acquireLock(lockPath, { owner: `finalize-${taskId}-${randomUUID().replaceAll('-', '').slice(0, 8)}` });
  if (!lock.ok) throw new Error('台账被并发占用（ledger.lock 存在）——稍后重试 finalize，禁止并发写覆盖');
  try {
    const ledgerPath = join(root, '.sdd', 'ledger.json');
  let data;
  try {
    let isFile = false;
    try { isFile = statSync(ledgerPath).isFile(); } catch { isFile = false; }
    data = isFile ? JSON.parse(readUtf8Strict(ledgerPath)) : { tasks: [] };
  } catch (e) {
    throw new Error(`台账不可读（${ledgerPath}）：${e.message}——修复后重跑 finalize 完成台账收敛`);
  }
  const tasks = isPlainObject(data) ? get(data, 'tasks', null) : null;
  if (!Array.isArray(tasks)) throw new Error('台账 tasks 不是列表——修复后重跑 finalize 完成台账收敛');
  let entry = tasks.find((t) => isPlainObject(t) && get(t, 'id', null) === taskId) ?? null;
  if (entry === null) {
    entry = { id: taskId, title: taskId, createdAt: now ?? nowIso() };
    tasks.push(entry);
  }
  entry.status = 'converged';
  const rawFinalStatus = get(finalReport, 'finalStatus', null);
  entry.finalStatus = pyStr(pyTruthy(rawFinalStatus) ? rawFinalStatus : 'complete');
  entry.gateReportRef = `.sdd/reports/${taskId}/delivery-final.json`;
  try {
    atomicWriteText(ledgerPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch (e) {
    throw new Error(`台账写入失败：${e.message}——重跑 finalize 完成台账收敛`);
  }
  } finally {
    releaseLock(lockPath, lock.owner);
  }
}

/**
 * 第二阶段：验证 gate 凭据（同任务、revision 与当前一致、draftSha256 与当前草案一致、
 * 内嵌 v/c 引用与最新链一致、链完整）后落最终报告；evidenceProfile 原样继承（不得提升）。
 * 必检节（内部规则-12）缺失即拒绝——报告停留 partial。
 * @param {string} root @param {string} taskId @param {{now?: string}} [opts]
 * @returns {Record<string, unknown>}
 */
export function finalizeDelivery(root, taskId, opts = {}) {
  const gate = latestReceipt(root, taskId, 'gate');
  // Python `if not gate`：{}/[] 亦为假值，走「无 gate 凭据」分支（与空对象诊断逐字一致）
  if (gate === null || !pyTruthy(gate)) {
    throw new Error('无 gate 凭据：先运行聚合 gate（assurance gate），再 finalize');
  }
  const gatePath = join(receiptsDir(root, taskId), `${gate.receiptId}.json`);
  const [ok, reason] = verifyReceiptFile(gatePath);
  if (!ok) throw new Error(`gate 凭据无效：${reason}`);
  if (get(gate, 'status', null) !== 'passed') {
    throw new Error(`gate 未通过（blockingCount=${pyStr(get(gate, 'blockingCount', null))}），不得 finalize`);
  }
  // 链形态以 gate 凭据 chainProfile 自述为准（内部决策-023 修正案 2 三值；单一事实源在签发点，
  // finalize 不接受外部旗标）——legacy 兜底：极早期凭据无 chainProfile 字段时按
  // operationReceipt 在位推导（等价旧行为）。用 Python `str()` 语义而非 String()：数组
  // 应归一为 repr（如 "['deliverable']"）并落非法链形态，不得被 String() 拼成合法值。
  const chainProfile = pyStr(
    pyTruthy(get(gate, 'chainProfile', null))
      ? get(gate, 'chainProfile', null)
      : (pyTruthy(get(gate, 'operationReceipt', null)) ? 'operation' : 'dev'),
  );
  let chainOk;
  let chainReason;
  try {
    [chainOk, chainReason] = verifyReceiptChain(root, taskId, { chainProfile });
  } catch (e) {
    if (e instanceof ChainProfileError) {
      // gate 凭据自述链形态而对应凭据已缺失=链损坏（内容失败，退出 1），不是旗标误用
      // （finalize 无旗标可撤）——转译为链校验失败诊断
      throw new Error(
        `凭据链校验失败：gate 凭据自述链形态 ${chainProfile} 与任务目录不符`
        + `（环缺失或凭据被删），须重签链后重跑 gate：${e.message}`,
      );
    }
    throw e;
  }
  if (!chainOk) throw new Error(`凭据链校验失败：${chainReason}`);
  // 评审 C3 处置：gate 内嵌引用必须就是链上最新凭据——防「旧 gate 盖新链」
  // （制品链双环：code-review 与 operation 两引用各对最新校验，内部决策-023 修正案 2）
  const verification = latestReceipt(root, taskId, 'verification');
  const checks = [['verification', 'verificationReceipt', verification]];
  if (chainProfile === 'operation' || chainProfile === 'deliverable') {
    checks.push(['operation', 'operationReceipt', latestReceipt(root, taskId, 'operation')]);
  }
  if (chainProfile === 'dev' || chainProfile === 'deliverable') {
    checks.push(['code-review', 'codeReviewReceipt', latestReceipt(root, taskId, 'code-review')]);
  }
  for (const [secondKind, secondKey, second] of checks) {
    if (get(gate, secondKey, null) !== get(second ?? {}, 'receiptId', null)) {
      throw new Error(`gate 凭据内嵌的 verification/${secondKind} 引用与链上最新凭据不一致，须重跑 gate`);
    }
  }
  const current = revisionSetToDict(computeRevisionSet(root, boundPlan(root, taskId)));
  const gateRev = get(gate, 'revision', {}) ?? {};
  // 内部任务-40：第四消费点与 receipts 三处共用同一判定（revisionDivergence）——内容桶全等且
  // head 位移可证无害即放行；不可证即具名诊断；内容桶不全等时落既有分因分支。
  const divergence = revisionDivergence(root, gateRev, current);
  if (divergence !== null) {
    const [kind, detail] = divergence;
    if (kind === 'head-unverifiable') {
      throw new Error(`gate 凭据内容桶未变但${detail}，须重跑 gate`);
    }
    // 分因（2026-09-20 使用反馈三批，坑3）：源码/规格未变而仅 plan 桶口径不一致，
    // 指认「计划绑定口径」并给按链上口径重跑的出路——legacy 凭据（修复前签发）兜底层
    if (isDeepStrictEqual(get(gateRev, 'sourceRevision', null), get(current, 'sourceRevision', null))
      && isDeepStrictEqual(get(gateRev, 'specRevision', null), get(current, 'specRevision', null))) {
      const gp = get(gateRev, 'planSha256', null);
      const cp = get(current, 'planSha256', null);
      const gpPath = isPlainObject(gp) ? get(gp, 'path', null) : null;
      const cpPath = isPlainObject(cp) ? get(cp, 'path', null) : null;
      throw new Error(
        `gate 凭据与链上 verification 的计划绑定口径不一致（gate 绑定 ${pyTruthy(gpPath) ? gpPath : '无'} `
        + `/ 链绑定 ${pyTruthy(cpPath) ? cpPath : '无'}），源码/规格未变——按链上口径重跑 gate`
        + (pyTruthy(cpPath)
          ? `（链绑定计划 ${cpPath}，重跑时带 --plan ${cpPath}）`
          : '（链未绑定计划，重跑时去掉 --plan）')
        + '，或先重签 verification',
      );
    }
    throw new Error('gate 凭据 revision 与当前不一致（源码/规格/计划已变化），须重跑 gate');
  }
  // 内部决策-027：L1 操作的完成标记即 gate 凭据本身（riskLevel L1 + 探针全过），无草案可绑、
  // 无需 finalize——显式拦截并给正确指引，防止把用户引向 L1 已豁免的两阶段链
  if (get(gate, 'riskLevel', null) === 'L1') {
    throw new Error('L1（本地可逆）操作的完成标记即本 gate 凭据本身（riskLevel L1 + 操作断言全过，'
      + 'ADR-027）——无需 prepare/finalize；请以 chain-verify 复核链完整性');
  }
  const draftPath = join(reportsDir(root, taskId), 'delivery-draft.json');
  let draftIsFile = false;
  try { draftIsFile = statSync(draftPath).isFile(); } catch { draftIsFile = false; }
  if (!draftIsFile) throw new Error('delivery 草案不存在：先 prepare');
  const draftDigest = `sha256:${sha256Hex(readFileSync(draftPath))}`;
  if (get(gate, 'draftSha256', null) !== draftDigest) {
    throw new Error('gate 凭据绑定的 draft 哈希与当前草案不一致（草案在 gate 后被改动），须重跑 gate');
  }
  const draft = JSON.parse(readUtf8Strict(draftPath));
  // 内部规则-12 必检节（内部未决-8 批次补机械面）：缺失即 partial——拒绝 finalize 落地
  const missing = missingRequiredSections(draft);
  if (missing.length > 0) {
    throw new Error(
      `交付草案必检节缺失：${pyListRepr(missing)}（R-M7-12：缺失即 partial——`
      + '补齐后重新 prepare→gate→finalize）',
    );
  }
  const finalReport = {
    ...draft,
    finalStatus: 'complete',
    evidenceProfile: get(verification ?? {}, 'evidenceProfile', 'full'),
    gateReceipt: gate.receiptId,
    gateBlockingCount: get(gate, 'blockingCount', 0),
    gateWarningCount: get(gate, 'warningCount', 0),
    finalizedAt: opts.now ?? nowIso(),
  };
  atomicWriteText(
    join(reportsDir(root, taskId), 'delivery-final.json'),
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );
  // S1 批次（2026-09-16）：链的最后一环机械化——final 落地即台账收敛，不再依赖人工补登
  upsertLedgerConverged(root, finalReport, opts.now);
  return finalReport;
}

/** 测试缝（revision.mjs `_testHooks` 先例）：台账 upsert 的幂等单测面；`_testHooks` 对象本身生产路径不消费。 */
export const _testHooks = { upsertLedgerConverged };
