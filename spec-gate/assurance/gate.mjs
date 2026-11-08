// 文件：gate.mjs
// 描述：gate.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 D1/D5 运行时归一·阶段3a W1，永久件）——assurance
//       聚合 gate 逐行移植：core 套件校验（经 core-runner.mjs 子进程承接，spawn 目标为 node）＋显式计划校验＋
//       台账/边界（直接 import JS core）＋IF 漂移＋delivery 草案＋凭据链三形态＋
//       production claim/CHG 回放＋governance 四态＋豁免审计呈现＋gate 前后 revision 双算；
//       零阻塞时签发 gate receipt（第二环三态、L1 draft 为 null、riskLevel 取 operation）。
//       报告固定 13 节顺序：core/plan/ledger/boundary/ifDrift/delivery/receipts/
//       reviewCoverage/production/governance/exemptions/planBinding/exemptAnchor；sections 去每节
//       diagnostics 但保留顶层 diagnostics；blocking 含 exemptAnchor、不含 reviewCoverage/exemptions；
//       warning 含 exemptAnchor 的 unparsable 告警、不含 governance/production/planBinding（原 Python 实现（迁移史见 内部决策-051）同口径，见 gate.py:748-760）。
//       已知怪癖逐字复刻（行为冻结）：defaultPlanRunner 不收敛 {"error":...}（core-runner.mjs）、
//       warningCount 不含 governance/production/planBinding。
//       测试缝：opts.coreRunner/planRunner/midHook/now；now 只透传 _checkLedger 与
//       issueGateReceipt（_checkExemptions 与历史 Python 实现一致使用真实时间）。
//       生产 API 只有 runGate；其余导出供永久单测直调（对应 gate.test.mjs 的导入面）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  codePointCompare, isCalendarDate, isWithinRoot, localToday, looseRealpath, nowIso, readUtf8Strict,
  toPosix, underRoot,
} from './common.mjs';
import { loadConfig, reviewCoverageThreshold } from './config.mjs';
import { STEP_HEADING_RE } from '../core/validator/core/plan_check.mjs';
import { fenceRanges, inFenced } from '../core/validator/core/markdown.mjs';
import { checkBoundaries, validateBoundaryRules } from '../core/validator/core/boundaries.mjs';
import { checkTaskLedger } from '../core/validator/core/structured.mjs';
import { REQUIRED_SECTION_NAMES, missingRequiredSections } from './delivery_reports.mjs';
import { checkGovernance } from './governance.mjs';
import { assessClaim } from './production_policy.mjs';
import { readStatus } from './production_store.mjs';
import { ProbeConfigError, runProbes } from './probes.mjs';
import { countReviewReceipts, issueGateReceipt, latestReceipt, reviewProvenanceStatusOf, verifyReceiptChain, withReceiptCache } from './receipts.mjs';
import { computeRevisionSet, revisionSetMatches, revisionSetToDict } from './revision.mjs';
import { defaultCoreRunner, defaultPlanRunner } from './core-runner.mjs';

// 历史 test_gate.py 的导入面等价：defaultCoreRunner 直调（超时/错误映射用例）。
export { defaultCoreRunner };

// plan 节口径说明（S2 批次单一事实源；core plan 节 note 与报告顶层 planSectionPolicy 共用）。
export const PLAN_SECTION_POLICY_NOTE = 'plan 节为全库计划卫生扫描：阻断判定仅计顶层 blockingCount；'
  + '非当前任务计划的悬空引用以 warning+scope=historical 呈现（S2 批次）；core 直跑仍见 blocking 真值';

// Python splitlines 全集行切分（probes/production_store 同款；本文件只用于评审覆盖与豁免呈现）。
const SPLITLINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
// IF 漂移：lifecycle 状态行（容忍 Markdown 强调）与作品哈希行（16-64 位在读取后独立校验）。
const LIFECYCLE_LINE_RE = /^[ \t>-]*\*{0,2}lifecycle\*{0,2}[：:][ \t]*(.+)$/gm;
const IF_ROW_RE = /\|\s*`?([^|\n]+?)`?\s*\|\s*`?sha256:([0-9a-fA-F]+)/g;
const KNOWN_LIFECYCLE_STATES = ['active', 'proposed', 'draft', 'deprecated', 'retired'];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Python 真值语义（空数组/空对象/空串/0/None 均假）。 */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0; // NaN !== 0 已为真；原 `|| Number.isNaN(v)` 是死条件（Q08/内部任务-241 步骤19）
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python str() 的 JSON 值域形态（None→'None'、bool→'True'/'False'）。 */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** 普通对象判定（对齐 Python `isinstance(x, dict)`；数组/null 均否）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python `dict.get` 语义：非对象/缺键取缺省；键存在（含 null）取实值。 */
function get(obj, key, fallback = null) {
  if (!isPlainObject(obj)) return fallback;
  return hasOwn(obj, key) ? obj[key] : fallback;
}

/** 按码点数截断（Python 字符串切片语义；截断时附 `…[截断]`）。 */
function truncatePy(text, limit) {
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('')}…[截断]`;
}

/** Python `Path.resolve().relative_to(root.resolve())`（strict=False 的对应物）；越界抛错。 */
function relativeToPy(target, base) {
  const t = looseRealpath(target);
  const b = looseRealpath(base);
  const rel = relative(b, t);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径不在项目根内：${target}（根 ${base}）`);
  }
  return toPosix(rel);
}

/** 文件存在且为普通文件（对齐 Python `Path.is_file()`，跟随 symlink）。 */
function statFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 深度相等（Q08/内部任务-241 步骤19）：统一 node:util.isDeepStrictEqual（对象键序无关，JSON 值域等价）。 */
const jsonEqual = isDeepStrictEqual;

/**
 * 聚合 gate 生产节的 scout 活跃判定（Safety Floor：禁止生产 claim）。
 * 内部决策-031 v3 自含语义直读复刻（内部接口-9 §1）：合法 v3 五字段 ∧ mode 枚举合法
 * ∧ 未过期；纯文件读、不依赖 scout 插件在场（读取失败/损坏一律 false，fail-open）。
 * @param {string} root
 * @returns {boolean}
 */
export function scoutActive(root) {
  let data;
  try {
    data = JSON.parse(readUtf8Strict(join(root, '.scout', 'mode.json')));
  } catch {
    return false;
  }
  if (!isPlainObject(data) || data.schemaVersion !== 3) return false;
  if (!['explore', 'disposable'].includes(data.mode)) return false;
  // T18 同源：id 必须为非空字符串（与 scout readStatus 的 T15 判定一致；不得用 pyTruthy 放行数字/对象）
  if (typeof data.taskId !== 'string' || data.taskId.length === 0) return false;
  if (typeof data.transactionId !== 'string' || data.transactionId.length === 0) return false;
  const expiry = pyStr(get(data, 'expiry', ''));
  if (!isCalendarDate(expiry)) return false;
  return expiry >= localToday();
}

/** 阻断诊断的降级重写（S2 批次）：severity blocking→warning 并以 downgradedFrom 留痕。 */
function downgradeDiag(d) {
  const d2 = { ...d };
  if (d2.severity === 'blocking') {
    d2.severity = 'warning';
    d2.downgradedFrom = 'blocking';
  }
  return d2;
}

/**
 * core 报告内嵌 plan 节的 /gate 呈现层归一（2026-09-16 S2 批次，乙案）：非当前任务的
 * 计划诊断降级 warning 并标 scope=historical，当前显式计划标 scope=current；节内计数按
 * 降级后 severity 重算；阻断判定口径不变。
 * @param {Record<string, unknown>} coreReport
 * @param {string|null} planPath
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
export function _normalizeCorePlanSection(coreReport, planPath, root) {
  const planNode = isPlainObject(coreReport) ? get(coreReport, 'plan', null) : null;
  if (!isPlainObject(planNode) || !pyTruthy(get(planNode, 'diagnostics', null))) return coreReport;
  let explicit = null;
  if (planPath !== null && planPath !== undefined) {
    const p = String(planPath);
    explicit = isAbsolute(p) ? relativeToPy(p, root) : p;
  }
  const diags = [];
  for (const d of get(planNode, 'diagnostics', [])) {
    const d2 = downgradeDiag(d);
    const fileRel = pyStr(get(d2, 'file', '')).replaceAll('\\', '/');
    d2.scope = explicit !== null && fileRel.endsWith(explicit) ? 'current' : 'historical';
    diags.push(d2);
  }
  planNode.diagnostics = diags;
  planNode.blockingCount = diags.filter((d) => get(d, 'severity', null) === 'blocking').length;
  planNode.warningCount = diags.filter((d) => get(d, 'severity', null) === 'warning').length;
  planNode.note = `${PLAN_SECTION_POLICY_NOTE}（本节呈现层已归一）`;
  return coreReport;
}

/**
 * 台账检查：直接调用 JS core 的 checkTaskLedger；解析/执行失败按内容阻断，不让闸崩。
 * @param {string} root @param {string|null} [now] 测试/parity 时钟（缺省 nowIso）
 * @returns {Record<string, unknown>}
 */
export function _checkLedger(root, now = null) {
  const ledgerPath = join(root, '.sdd', 'ledger.json');
  let st = null;
  try { st = statSync(ledgerPath); } catch { st = null; }
  if (st === null) return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  let diags;
  try {
    const ledger = JSON.parse(readUtf8Strict(ledgerPath));
    diags = checkTaskLedger(ledger, '.sdd/ledger.json', now ?? nowIso());
  } catch (exc) {
    diags = [{
      ruleId: 'RULE-LEDGER-001', severity: 'blocking', file: '.sdd/ledger.json', line: 1,
      fixHint: `台账不可解析：${exc.message}`,
    }];
  }
  return {
    present: true,
    blockingCount: diags.filter((d) => d.severity === 'blocking').length,
    warningCount: diags.filter((d) => d.severity === 'warning').length,
    diagnostics: diags,
  };
}

/** 交付报告核验（内部规则-12）：缺草案阻断；存在时核必检节——缺失产 warning（呈现层）。 */
function _checkDelivery(root, taskId) {
  const draftPath = join(root, '.sdd', 'reports', taskId, 'delivery-draft.json');
  if (!statFile(draftPath)) {
    return {
      present: false, blockingCount: 1, warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-GATE-DELIVERY', severity: 'blocking',
        file: `.sdd/reports/${taskId}/delivery-draft.json`, line: 1,
        fixHint: '任务级交付草案缺失：先 prepare（R-M7-12，报告缺失即 partial/blocked）',
      }],
    };
  }
  let missing;
  try {
    const draft = JSON.parse(readUtf8Strict(draftPath));
    missing = missingRequiredSections(draft);
  } catch (e) {
    // G05（内部任务-241）：草案不可解析＝工具/内容坏形态——保留 blocking（不签凭据）并带 toolError
    // 标记，CLI 据此退 2（旧实现按缺节 warning 呈现，工具错误被吞成提醒）。
    return {
      present: true, blockingCount: 1, warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-GATE-DELIVERY-PARSE', severity: 'blocking', toolError: true,
        file: `.sdd/reports/${taskId}/delivery-draft.json`, line: 1,
        fixHint: `交付草案不可解析：${e.message}——修复草案后重跑 gate（不得以缺节 warning 放行）`,
      }],
    };
  }
  const diags = missing.map((m) => ({
    ruleId: 'RULE-GATE-DELIVERY-SECTION', severity: 'warning',
    file: `.sdd/reports/${taskId}/delivery-draft.json`, line: 1,
    fixHint: `必检节缺失：${m}（R-M7-12：缺失即 partial——补齐后重新 prepare→gate→finalize）`,
  }));
  return { present: true, blockingCount: 0, warningCount: diags.length, diagnostics: diags };
}

/**
 * 凭据链核验（三形态，内部决策-023 修正案 2 / 内部未决-128 方案 B）：dev=verification+code-review；
 * operation=verification+operation；deliverable=三环双环并呈（评审环 RULE-GATE-DELIVREVIEW）。
 * @param {string} root @param {string} taskId @param {string} [chainProfile]
 * @returns {Record<string, unknown>}
 */
export function _checkReceipts(root, taskId, chainProfile = 'dev') {
  const [ok, reason] = verifyReceiptChain(root, taskId, { chainProfile });
  if (!ok) {
    return {
      present: true, blockingCount: 1, warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-GATE-RECEIPTS', severity: 'blocking',
        file: `.sdd/receipts/${taskId}`, line: 1,
        fixHint: `凭据链无效：${reason}`,
      }],
    };
  }
  // 内部任务-191：2.0.0 legacy 评审凭据无实例 provenance → warning（不阻断，人在环复核来源/轮次）。
  // 内部任务-193 A5：最新任务级 code-review 在此读一次复用——下游制品链评审环/豁免呈现同吃这一份；
  // latestReceipt 每次都重扫目录+读文件，三处各读一次会让同一事实在同一次 gate 内有三个版本。
  const review = latestReceipt(root, taskId, 'code-review');
  const provStatus = reviewProvenanceStatusOf(review, { taskId });
  let legacyProvDiag = null;
  if (provStatus.state === 'legacy') {
    legacyProvDiag = {
      ruleId: 'RULE-GATE-REVIEWPROV-LEGACY', severity: 'warning',
      message: `code-review 凭据无实例 provenance（${provStatus.reason}）——legacy 可读，请人在环复核实例来源与轮次`,
    };
  }
  // 内部任务-41（FIX-3 承接 #4）：存量空证据凭据告警（非阻断，向后兼容已签发凭据）。
  const v = latestReceipt(root, taskId, 'verification');
  let emptyEvDiag = null;
  if (v !== null && !pyTruthy(get(v, 'evidenceRefs', null))) {
    emptyEvDiag = {
      ruleId: 'RULE-GATE-EMPTYEVIDENCE', severity: 'warning',
      message: `verification 凭据 ${pyStr(get(v, 'receiptId', taskId))} 证据清单为空——`
        + '零证据不构成验证（存量凭据告警，新签发已拒签）',
    };
  }
  const op = latestReceipt(root, taskId, 'operation');
  if (op !== null) {
    const auth = get(op, 'authorization', null);
    const quote = truncatePy(pyStr(get(pyTruthy(auth) ? auth : {}, 'quote', '')), 200);
    const diags = [];
    // 状态断言（内部决策-027）：gate 执行 operation 判据中的只读探针；riskLevel 缺省 L2。
    const riskLevel = get(op, 'riskLevel', 'L2');
    const isLegacy = !hasOwn(op, 'riskLevel');
    let probeReport;
    try {
      probeReport = runProbes(root, get(op, 'verificationCriteria', []));
    } catch (exc) {
      if (!(exc instanceof ProbeConfigError)) throw exc;
      probeReport = {
        present: true, total: 0, passed: 0, failed: 0, legacy: isLegacy,
        diagnostics: [{
          ruleId: 'RULE-GATE-OPASSERT-CONFIG', severity: 'blocking',
          message: `操作断言配置错误：${exc.message}`,
        }],
      };
    }
    diags.push(...(get(probeReport, 'diagnostics', []) ?? []));
    // L1 零探针阻断（声称本地可逆却无可机检状态回读）；L2 零探针仅 warning；legacy 静默。
    if (!isLegacy && get(probeReport, 'total', 0) === 0) {
      if (riskLevel === 'L1') {
        diags.push({
          ruleId: 'RULE-GATE-OPNOASSERTION', severity: 'blocking',
          message: 'L1（本地可逆）操作必须携带 ≥1 个可机检状态探针（ADR-027）——零探针的轻档申请不成立',
        });
      } else if (riskLevel === 'L2') {
        diags.push({
          ruleId: 'RULE-GATE-OPNOASSERTION', severity: 'warning',
          message: 'L2 操作未携带状态探针（跨边界状态本机不可读时允许；本机可验证状态建议补探针）',
        });
      }
    }
    // 授权引文人在环复核：仅 L2 恒现（L1 已机检且无外部副作用，降级为报告行不产 warning）。
    if (riskLevel === 'L2') {
      diags.push({
        ruleId: 'RULE-GATE-OPAUTH', severity: 'warning',
        message: `操作链授权待复核：taskId=${taskId} 引文=${quote}——请确认授权与操作执行属实`,
      });
    }
    if (emptyEvDiag !== null) diags.push(emptyEvDiag);
    if (legacyProvDiag !== null) diags.push(legacyProvDiag);
    // 制品链双环并呈（内部决策-023 修正案 2 / 内部未决-128）：评审环恒现 RULE-GATE-DELIVREVIEW warning。
    let reviewRing = null;
    if (chainProfile === 'deliverable') {
      if (review !== null) {
        const rSummary = truncatePy(pyStr(get(review, 'summary', '')), 120);
        diags.push({
          ruleId: 'RULE-GATE-DELIVREVIEW', severity: 'warning',
          message: `制品链评审环待复核：taskId=${taskId} `
            + `receipt=${pyStr(get(review, 'receiptId', null))} mode=${pyStr(get(review, 'reviewMode', null))} `
            + `instances=${pyStr(get(review, 'reviewInstances', null))} 摘要=${rSummary}`
            + '——请确认类型匹配评审（渲染验收/内容审）真实发生且结论支持交付',
        });
        reviewRing = {
          receiptId: get(review, 'receiptId', null),
          mode: get(review, 'reviewMode', null),
          instances: get(review, 'reviewInstances', null),
        };
      }
    }
    const section = {
      present: true,
      blockingCount: diags.filter((x) => x.severity === 'blocking').length,
      warningCount: diags.filter((x) => x.severity === 'warning').length,
      riskLevel,
      operationAssertions: {
        total: probeReport.total,
        passed: probeReport.passed,
        failed: probeReport.failed,
        legacy: isLegacy,
      },
      diagnostics: diags,
    };
    if (reviewRing !== null) section.reviewRing = reviewRing;
    return section;
  }
  // P3：任务级 code-review 豁免凭据在案 → 恒现豁免呈现 warning（人在环复核，不阻断）。
  if (review !== null && pyTruthy(get(review, 'exemptReceipt', null))) {
    const reason = pyStr(get(review, 'exemptionReason', ''));
    const planRef = pyStr(get(review, 'planRef', ''));
    const exemptDiags = [{
      ruleId: 'RULE-GATE-CREVEXEMPT', severity: 'warning',
      message: `code-review 豁免凭据在案（理由：${reason}；计划：${planRef}）——`
        + '人在环复核：请确认计划内 R-M3-11 豁免记录与该凭据相符'
        + '（R-M5-10 豁免形态，完成链以豁免形态闭合）',
    }];
    if (emptyEvDiag !== null) exemptDiags.push(emptyEvDiag);
    // legacyProvDiag 不并入：reviewProvenanceStatusOf 对 exempt 前置返回 state=exempt，
    // legacyProvDiag 恒为 null——原 push 是不可达分支（内部任务-193 A5 删除，注释保留根因）。
    return {
      present: true, blockingCount: 0,
      warningCount: exemptDiags.filter((x) => x.severity === 'warning').length,
      reviewExemption: { reason, planRef },
      diagnostics: exemptDiags,
    };
  }
  const baseDiags = legacyProvDiag === null ? [] : [legacyProvDiag];
  if (emptyEvDiag !== null) baseDiags.push(emptyEvDiag);
  if (baseDiags.length > 0) {
    return {
      present: true, blockingCount: 0,
      warningCount: baseDiags.filter((x) => x.severity === 'warning').length,
      diagnostics: baseDiags,
    };
  }
  return { present: true, blockingCount: 0, warningCount: 0, diagnostics: [] };
}

/** 冻结 core 的步骤标题正则（直接 import JS core 的 STEP_HEADING_RE，单一事实源）。 */
export function _stepHeadingRe() {
  return STEP_HEADING_RE;
}

/** 计划步骤标题数（评审覆盖检查的规模口径，P3）；文件不可读返回 0（不放大为阻断）。
 *  Q07/内部任务-241 步骤19：围栏感知——与 core plan_check 的 `inFenced` 口径对齐（围栏内步骤标题不计）。 */
function _planStepCount(planPath) {
  let text;
  try {
    text = readUtf8Strict(planPath);
  } catch {
    return 0;
  }
  const pattern = _stepHeadingRe();
  const ranges = fenceRanges(text);
  return text.split(SPLITLINES_RE)
    .filter((line, i) => !inFenced(i + 1, ranges) && pattern.test(line.replace(/\s+$/u, '')))
    .length;
}

/** 评审凭据的声明面投影（gate 只呈现、不复算；legacy 无 fixReview 字段按 none/0/空）。
 *  内部任务-191：另投影 reviewRound 与 provenance 状态/countable（2.1.0 present；2.0.0 legacy）。
 *  内部任务-193 A4：fix 环状态只读 reviewProvenanceStatusOf 单源投影（none/present/absent/invalid）——
 *  不在本函数重建 Array.isArray 判定，否则「非法 fix provenance」会被投影成 present（两套口径漂移）。 */
function reviewAuditOf(review) {
  if (!review) return null;
  const text = (value) => (typeof value === 'string' ? value : '');
  const countable = (arr) => (Array.isArray(arr)
    ? arr.filter((e) => e && (e.state === 'fresh' || e.state === 'reused')).length : null);
  const taskId = get(review, 'taskId', null);
  const provStatus = reviewProvenanceStatusOf(review, { taskId });
  const fixInstances = get(review, 'fixReviewInstances', 0) ?? 0;
  const fixProv = get(review, 'fixReviewProvenance', null);
  return {
    receiptId: get(review, 'receiptId', null),
    reviewMode: get(review, 'reviewMode', null),
    reviewInstances: get(review, 'reviewInstances', null),
    reviewRound: get(review, 'reviewRound', null),
    reviewProvenanceState: provStatus.state,
    reviewProvenanceCount: countable(get(review, 'reviewProvenance', null)),
    fixReviewMode: get(review, 'fixReviewMode', 'none') ?? 'none',
    fixReviewInstances: fixInstances,
    fixReviewProvenanceState: provStatus.fixProvenanceState,
    fixReviewProvenanceCount: countable(fixProv),
    fixReviewReason: truncatePy(text(get(review, 'fixReviewReason', '')), 120),
    fixReviewBase: text(get(review, 'fixReviewBase', '')),
    fixReviewDiffSha: text(get(review, 'fixReviewDiffSha', '')),
  };
}

/**
 * 评审覆盖检查（P3）：步骤规模达阈值而任务仅一条评审凭据 → warning（不阻断）；
 * 无显式计划时跳过并如实标注 skipReason；豁免凭据在案时跳过并标注 exemption；
 * 同时投影最新任务级 code-review 的声明面（reviewAudit，legacy 字段按 none/0/空）。
 * @param {string} root @param {string} taskId @param {string|null} [planPath]
 * @returns {Record<string, unknown>}
 */
export function _checkReviewCoverage(root, taskId, planPath = null) {
  const reviews = countReviewReceipts(root, taskId);
  if (planPath === null || planPath === undefined) {
    return {
      present: false, blockingCount: 0, warningCount: 0, diagnostics: [],
      stepCount: null, reviewCount: reviews, threshold: null, skipReason: 'no-plan',
      reviewAudit: null,
    };
  }
  const threshold = reviewCoverageThreshold(root);
  const steps = _planStepCount(planPath);
  // P7：任务级豁免凭据在案时跳过该 warning（纯文档批的复审形态以计划声明的收尾对照门承载）。
  const latestReview = latestReceipt(root, taskId, 'code-review');
  const reviewAudit = reviewAuditOf(latestReview);
  if (latestReview !== null && pyTruthy(get(latestReview, 'exemptReceipt', null))) {
    return {
      present: true, blockingCount: 0, warningCount: 0, diagnostics: [],
      stepCount: steps, reviewCount: reviews, threshold, skipReason: null,
      exemption: 'code-review-exempt', reviewAudit,
    };
  }
  let diags = [];
  if (steps >= threshold && reviews < 2) {
    diags = [{
      ruleId: 'RULE-GATE-REVIEWCOVERAGE', severity: 'warning',
      file: toPosix(planPath), line: 1,
      fixHint: `计划步骤数 ${steps} ≥ 阈值 ${threshold} 而任务仅 ${reviews} 条评审凭据：`
        + `长任务宜按阶段复审（阶段级凭据 code-review-${taskId}-s<stage>，`
        + '签发命令 issue-code-review 增 --stage），避免把整批 diff 推到收尾一次评审',
    }];
  }
  return {
    present: true, blockingCount: 0, warningCount: diags.length, diagnostics: diags,
    stepCount: steps, reviewCount: reviews, threshold, skipReason: null, reviewAudit,
  };
}

/**
 * 链内 plan 绑定口径（坑3）：链上 verification 绑定优先，显式 --plan 与绑定不一致产阻断；
 * 链未绑定时返回 (null, [], null)（凭据口径恒不带 plan 桶，--plan 仅供检查面）。
 * 内部任务-265：链绑定计划不可读/不存在时产 blocking 并返回 effectivePlan=null + boundRel，
 * 避免后续 computeRevisionSet 先抛、`exemptAnchor` no-plan 不可达。
 * @param {string} root @param {string} taskId @param {string|null} planPath
 * @returns {[string|null, Array<object>, string|null]}
 */
function _resolveEffectivePlan(root, taskId, planPath) {
  const v = latestReceipt(root, taskId, 'verification');
  const revision = get(v, 'revision', null);
  const bound = isPlainObject(revision) ? get(revision, 'planSha256', null) : null;
  const boundRel = isPlainObject(bound) ? get(bound, 'path', null) : null;
  if (!pyTruthy(boundRel)) return [null, [], null];
  let effective = null;
  try {
    effective = underRoot(root, pyStr(boundRel));
  } catch {
    return [null, [{
      ruleId: 'RULE-GATE-PLANBINDING', severity: 'blocking', file: pyStr(boundRel), line: 1,
      fixHint: `链上 verification 绑定的计划路径非法/越界（${pyStr(boundRel)}）——请修复 verification 计划桶或重签绑定仓库内计划`,
    }], pyStr(boundRel)];
  }
  let planText = null;
  try {
    planText = readUtf8Strict(effective);
  } catch {
    planText = null;
  }
  if (planText === null) {
    return [null, [{
      ruleId: 'RULE-GATE-PLANBINDING', severity: 'blocking', file: toPosix(pyStr(boundRel)), line: 1,
      fixHint: `链上 verification 绑定的计划不存在/不可读（${pyStr(boundRel)}）——请修复计划文件，或重签 verification 绑定可读计划后再跑 gate`,
    }], pyStr(boundRel)];
  }
  if (planPath !== null && planPath !== undefined
    && looseRealpath(String(planPath)) !== looseRealpath(effective)) {
    const diags = [{
      ruleId: 'RULE-GATE-PLANBINDING', severity: 'blocking', file: toPosix(planPath), line: 1,
      fixHint: `gate --plan 与链上 verification 绑定的计划不一致（传入 ${toPosix(planPath)} / 链绑定 ${pyStr(boundRel)}）。`
        + '一致化出路二选一：①按链上口径重跑 gate（去掉 --plan 或改用链绑定路径）；'
        + `②先重签 verification 绑定新计划（issue-verification --plan ${toPosix(planPath)}）再重跑 gate`,
    }];
    return [effective, diags, pyStr(boundRel)];
  }
  return [effective, [], pyStr(boundRel)];
}

/**
 * 架构边界聚合（内部规则-13）：直接调用 JS core 的 validateBoundaryRules/checkBoundaries；未配置 boundaries
 * 时空计数；坏形态前置拦截（指认 + 合法形态样例），执行异常按内容阻断。
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function _checkBoundaries(root) {
  let project;
  try {
    project = JSON.parse(readUtf8Strict(join(root, '.sdd', 'project.json')));
  } catch {
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  if (!isPlainObject(project)) {
    const kind = project === null ? 'NoneType' : Array.isArray(project) ? 'list' : typeof project;
    return {
      present: true,
      blockingCount: 1,
      warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-BOUND-CHECK', severity: 'blocking', file: '.sdd/project.json', line: 1,
        fixHint: `project.json 根须为对象（当前 ${kind}）——boundaries 配置不可解析，按阻断收口（不得静默放行）`,
      }],
    };
  }
  const rules = get(project, 'boundaries', null);
  if (!pyTruthy(rules)) {
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  let diags;
  try {
    const problems = validateBoundaryRules(rules, root);
    if (problems.length > 0) {
      const shown = `${problems.slice(0, 3).join('；')}${problems.length > 3 ? '…' : ''}`;
      diags = [{
        ruleId: 'RULE-BOUND-CHECK', severity: 'blocking', file: '.sdd/project.json', line: 1,
        fixHint: `boundaries 配置非法：${shown}——合法形态见 project_config.schema.json`
          + '（数组，每条一对象 id/scope/deny/…）',
      }];
      return { present: true, blockingCount: 1, warningCount: 0, diagnostics: diags };
    }
    diags = checkBoundaries(root, rules);
  } catch (exc) {
    diags = [{
      ruleId: 'RULE-BOUND-CHECK', severity: 'blocking', file: '.sdd/project.json',
      line: 1, fixHint: `边界检查执行失败：${exc.message}`,
    }];
  }
  return {
    present: true,
    blockingCount: diags.filter((d) => d.severity === 'blocking').length,
    warningCount: diags.filter((d) => d.severity === 'warning').length,
    diagnostics: diags,
  };
}

/**
 * active IF 工件漂移聚合（内部规则-13 / RULE-IF-005）：对 内部规格*.md 激活登记表内
 * 的 sha256（16-64 位，按登记实际长度比对）逐项与真实工件比对（core/ 除外）；登记文件缺失/
 * 损坏、lifecycle 状态不可解析、守护空转（active≥1 而检查项 0）均不静默。
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function _checkIfDrift(root) {
  const interfacesDir = join(root, 'specs', 'interfaces');
  let dirStat = null;
  try { dirStat = statSync(interfacesDir); } catch { dirStat = null; }
  if (!dirStat || !dirStat.isDirectory()) {
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  const diags = [];
  let activeFiles = 0;
  let checkedRows = 0;
  const names = readdirSync(interfacesDir)
    .filter((n) => n.startsWith('IF-') && n.endsWith('.md'))
    .sort(codePointCompare);
  for (const name of names) {
    const ifFile = join(interfacesDir, name);
    let body;
    try {
      body = readUtf8Strict(ifFile);
    } catch (exc) {
      if (!exc.code) throw exc; // 非 UTF-8 解码失败穿透（Python 只捕 OSError）
      diags.push({
        ruleId: 'RULE-GATE-IFDRIFT', severity: 'warning', file: toPosix(ifFile),
        line: 1, fixHint: 'IF 文档不可读，漂移核对跳过',
      });
      continue;
    }
    let lifecycleHit = false;
    for (const lm of body.matchAll(LIFECYCLE_LINE_RE)) {
      const state = lm[1].replaceAll('*', '').replaceAll('`', '').trim();
      const head = state.split(/[（(；;，,]/)[0].trim();
      if (KNOWN_LIFECYCLE_STATES.some((s) => head.startsWith(s))) {
        lifecycleHit = lifecycleHit || head.startsWith('active');
        continue;
      }
      diags.push({
        ruleId: 'RULE-GATE-IFDRIFT', severity: 'warning', file: toPosix(ifFile),
        line: body.slice(0, lm.index).split('\n').length,
        fixHint: `lifecycle 行状态不可解析（已知态：${KNOWN_LIFECYCLE_STATES.join('/')}），该行未参与 active 判定`,
      });
    }
    if (!lifecycleHit) continue; // 非 active IF 无冻结基线可比（合法非 active 态静默跳过）
    activeFiles += 1;
    for (const m of body.matchAll(IF_ROW_RE)) {
      const path = m[1].trim().replaceAll('`', '');
      if (path.startsWith('spec-gate/core')) continue;
      // S02（内部任务-241）：登记路径 containment——绝对路径/盘符/`..` 段一律拒绝且不读文件；
      // 相对路径经 looseRealpath + isWithinRoot 判定仍在项目根内（防越界探测/哈希 oracle）。
      if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
        diags.push({
          ruleId: 'RULE-GATE-IFDRIFT', severity: 'blocking', file: toPosix(ifFile),
          line: 1, fixHint: `激活登记的工件路径越界（绝对路径/盘符/.. 段非法）：${path}`,
        });
        continue;
      }
      const target = underRoot(root, path);
      if (!isWithinRoot(root, target)) {
        diags.push({
          ruleId: 'RULE-GATE-IFDRIFT', severity: 'blocking', file: toPosix(ifFile),
          line: 1, fixHint: `激活登记的工件路径越出项目根：${path}`,
        });
        continue;
      }
      if (!statFile(target)) {
        diags.push({
          ruleId: 'RULE-GATE-IFDRIFT', severity: 'blocking', file: toPosix(ifFile),
          line: 1, fixHint: `激活登记的工件不存在：${path}`,
        });
        continue;
      }
      const registered = m[2].toLowerCase();
      if (registered.length < 16 || registered.length > 64) {
        diags.push({
          ruleId: 'RULE-GATE-IFDRIFT', severity: 'blocking', file: toPosix(ifFile),
          line: 1, fixHint: `激活登记哈希长度非法（${registered.length}，合法 16-64 位十六进制）：${path}`,
        });
        continue;
      }
      checkedRows += 1;
      const actual = createHash('sha256').update(readFileSync(target)).digest('hex').slice(0, registered.length);
      if (actual !== registered) {
        diags.push({
          ruleId: 'RULE-GATE-IFDRIFT', severity: 'blocking', file: toPosix(ifFile),
          line: 1, fixHint: `工件漂移：${path} 登记 ${registered} 实际 ${actual}（RULE-IF-005）`,
        });
      }
    }
  }
  if (activeFiles >= 1 && checkedRows === 0) {
    diags.push({
      ruleId: 'RULE-GATE-IFDRIFT', severity: 'warning', file: toPosix(interfacesDir),
      line: 1, fixHint: `守护空转：${activeFiles} 份 active IF 未纳入任何哈希比对——检查 §7 工件表形态`,
    });
  }
  return {
    present: true,
    blockingCount: diags.filter((d) => d.severity === 'blocking').length,
    warningCount: diags.filter((d) => d.severity === 'warning').length,
    diagnostics: diags,
  };
}

/** gate 前后 revision 双算：不一致即为不存在的中间状态签了凭据，阻断。 */
function _checkRevisionStability(before, after) {
  if (revisionSetMatches(before, after)) return [];
  return [{
    ruleId: 'REVISION_CHANGED_DURING_GATE', severity: 'blocking', file: '.sdd', line: 1,
    fixHint: 'gate 执行期间源码/规格/计划发生变化——重跑 gate（TOCTOU 防护）',
  }];
}

/**
 * 生产 claim 裁决节（内部规则-2/6）：CHG 回放 + profile 推导 + assessClaim；status=config-error
 * 也按阻断计（无 profile 不猜）。
 * @param {string} root @param {string|null} claim @param {string|null} change
 * @param {Record<string, unknown>|null} changeContext
 * @returns {Record<string, unknown>}
 */
function _checkProduction(root, claim, change, changeContext) {
  if (!pyTruthy(claim) && !pyTruthy(change)) {
    return {
      present: false, status: 'skipped', blockingCount: 0, warningCount: 0, diagnostics: [],
    };
  }
  if (pyTruthy(claim) && !pyTruthy(change)) {
    return {
      present: true, status: 'config-error', blockingCount: 1, warningCount: 0,
      diagnostics: [{
        ruleId: 'PROD-GATE-ARGS', severity: 'blocking',
        message: '--claim 须与 --change 同时提供（IF-COLLAB-13）',
      }],
    };
  }
  const diags = [];
  // D01（内部任务-241）：事件链回放异常（含历史坏行）以 blocking 诊断呈现，不让聚合 gate 进程崩溃。
  let status;
  try {
    status = readStatus(root, pyStr(change));
  } catch (exc) {
    const fbDiag = {
      ruleId: 'PROD-INTEGRITY-BADLINE', severity: 'blocking',
      message: `变更记录回放异常：${exc.message}`,
    };
    // G05（完成复审）：fs/工具类异常（Node 错误码形态）标 toolError → CLI 退 2，
    // 不与「篡改式内容阻断」混档、不写进审计为篡改证据。
    if (typeof exc?.code === 'string' && /^E[A-Z]+$/.test(exc.code)) fbDiag.toolError = true;
    status = { ok: false, diagnostics: [fbDiag] };
  }
  if (!pyTruthy(get(status, 'ok', null))) {
    const statusDiags = get(status, 'diagnostics', []);
    diags.push(...(pyTruthy(statusDiags) ? statusDiags : [{
      ruleId: 'PROD-STATE-MISSING', severity: 'blocking', message: `变更记录不可读：${pyStr(change)}`,
    }]));
  }
  let profile = null;
  const profilePath = join(root, '.sdd', 'delivery-profile.json');
  if (statFile(profilePath)) {
    try {
      profile = JSON.parse(readUtf8Strict(profilePath));
    } catch {
      diags.push({
        ruleId: 'PROD-PROFILE-UNPARSABLE', severity: 'blocking',
        message: 'delivery-profile.json 不可解析',
      });
    }
  }
  const ctx = { ...(isPlainObject(changeContext) ? changeContext : {}) };
  if (!hasOwn(ctx, 'changeId')) ctx.changeId = pyStr(change);
  // active Scout 判定（Safety Floor：禁止生产 claim）——直读 .scout/mode.json v3。
  if (scoutActive(root)) ctx.scoutActive = true;
  let verdict = { status: 'skipped', diagnostics: [] };
  if (pyTruthy(claim)) {
    verdict = assessClaim(profile, claim, get(ctx, 'gateStates', {}), ctx);
  }
  const verdictDiags = get(verdict, 'diagnostics', []) ?? [];
  diags.push(...verdictDiags);
  const resultStatus = get(verdict, 'status', 'skipped');
  let blocking = ['blocked', 'config-error'].includes(resultStatus) ? 1 : 0;
  blocking += diags.filter((d) => get(d, 'severity', null) === 'blocking'
    && !verdictDiags.some((x) => jsonEqual(x, d))).length;
  if (get(verdict, 'status', null) === 'blocked') blocking = Math.max(blocking, 1);
  return {
    present: true, status: resultStatus, claim, change: pyStr(change),
    blockingCount: blocking, warningCount: 0, diagnostics: diags,
  };
}

/** 治理报告消费节（内部接口-18）：只读四态复核；required 由 内部治理状态 配置。 */
function _checkGovernanceSection(root) {
  const required = pyTruthy(get(loadConfig(root), 'governanceRequired', false));
  return checkGovernance(root, { required });
}

/**
 * 豁免审计呈现节（内部接口-20）：只读消费 内部工作流状态，命中记录以
 * warning 呈现供用户复核，blockingCount 恒 0（内部决策-020 裁决）。与 原 Python 实现（迁移史见 内部决策-051）一致使用
 * 真实时钟（gate.py:633 的 time.time()），测试 now 注入不作用于本节。
 * @param {string} root @param {string} taskId
 * @returns {Record<string, unknown>}
 */
export function _checkExemptions(root, taskId) {
  const store = join(root, '.workflow', 'wf-exemptions.jsonl');
  if (!statFile(store)) {
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  let rawLines;
  try {
    rawLines = readUtf8Strict(store).split(SPLITLINES_RE);
  } catch {
    // 文件损坏/IO 失败是合法状态（内部接口-20 §3：缺失/为空/损坏均非错误）——按空节处理。
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  const byId = new Map();
  for (const raw of rawLines) {
    const line = raw.trim();
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 坏行容忍跳过，不中断读取（内部接口-20 §4）
    }
    if (!isPlainObject(rec) || ['id', 'taskId', 'ts', 'src', 'reason'].some((k) => !hasOwn(rec, k))) {
      continue; // 缺核心字段视为坏行跳过
    }
    byId.set(pyStr(rec.id), rec); // 同 id 以文件末条覆盖（读侧去重口径；Map 保留首次插入位）
  }
  const cutoff = Math.trunc(Date.now()) - 24 * 3600 * 1000;
  const diags = [];
  for (const rec of byId.values()) {
    if (get(rec, 'taskId', null) !== taskId) continue; // 只呈现当前 gate 任务号的豁免
    if (get(rec, 'scope', null) === 'revoked') continue; // 退役记录不是待复核豁免（内部决策-067 修正案 1）
    const ts = get(rec, 'ts', null);
    if (typeof ts === 'boolean' || typeof ts !== 'number' || ts < cutoff) {
      continue; // ts 非数字按坏行口径跳过；24h 时间窗外不呈现
    }
    diags.push({
      ruleId: 'RULE-GATE-EXEMPTIONS', severity: 'warning',
      message: `豁免留痕待复核：taskId=${pyStr(get(rec, 'taskId', null))} 来源=${pyStr(get(rec, 'src', null))} `
        + `理由=${pyStr(get(rec, 'reason', null))}——请确认豁免与其来源标注属实`,
    });
  }
  return { present: true, blockingCount: 0, warningCount: diags.length, diagnostics: diags };
}

/**
 * 反堵节（内部决策-067 D6）：v2 豁免记录 → 完成链计划锚校验。独立读 `内部工作流状态`，
 * 不继承 24h 呈现窗；present＝存在有效 v2 plan-execution 记录。
 * - ENOENT：present=false/0 阻断；
 * - 不可读/非法 UTF-8：present=false/unreadable=true/bad-record blocking；
 * - 可读含不可解析行：unparsableCount + warning（不静默）；
 * - v2 字段非法：bad-record blocking；revoked：present=false/0 阻断 + 可见字段；
 * - plan/review：no-plan/no-quote/plan-mismatch blocking。
 * @param {string} root @param {string} taskId @param {string|null} effectivePlan
 * @returns {Record<string, unknown>}
 */
export function _checkExemptAnchor(root, taskId, effectivePlan) {
  const store = join(root, '.workflow', 'wf-exemptions.jsonl');
  if (!statFile(store)) {
    return { present: false, blockingCount: 0, warningCount: 0, diagnostics: [], unparsableCount: 0 };
  }
  let text;
  try {
    text = readUtf8Strict(store);
  } catch {
    return {
      present: false, unreadable: true, blockingCount: 1, warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-GATE-EXEMPT-ANCHOR', severity: 'blocking', file: '.workflow/wf-exemptions.jsonl', line: 1,
        message: '豁免账本存在但不可读/非法 UTF-8（unreadable）——无法确认是否有 v2 豁免锚。',
        fixHint: '检查账本权限/编码，修复或轮换 .workflow/wf-exemptions.jsonl 后重跑 gate；这是仓级状态，不是任务失败，会阻断该仓所有任务。',
      }],
      unparsableCount: 0,
    };
  }
  const lines = text.split(SPLITLINES_RE);
  let unparsableCount = 0;
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      unparsableCount += 1;
      continue;
    }
    if (!isPlainObject(rec)) {
      unparsableCount += 1;
      continue;
    }
    records.push({ rec, lineIndex: i });
  }
  const warningDiags = unparsableCount > 0
    ? [{
      ruleId: 'RULE-GATE-EXEMPT-ANCHOR', severity: 'warning', file: '.workflow/wf-exemptions.jsonl', line: 1,
      message: `豁免账本含 ${unparsableCount} 行不可解析记录（unparsableCount=${unparsableCount}）——已跳过，请人工核对账本。`,
    }]
    : [];
  const candidates = records
    .filter(({ rec }) => rec.taskId === taskId && rec.skill === 'plan-execution' && Number(rec.schemaVersion) >= 2)
    .sort((a, b) => (Number(b.rec.ts) || 0) - (Number(a.rec.ts) || 0) || b.lineIndex - a.lineIndex);
  if (candidates.length === 0) {
    return {
      present: false, blockingCount: 0, warningCount: warningDiags.length,
      diagnostics: warningDiags, unparsableCount,
    };
  }
  const { rec, lineIndex } = candidates[0];
  const scope = get(rec, 'scope', null);
  const src = get(rec, 'src', null);
  const reason = typeof get(rec, 'reason', null) === 'string' ? String(rec.reason).trim() : '';
  const file = '.workflow/wf-exemptions.jsonl';
  const line = lineIndex + 1;
  const base = {
    present: false, blockingCount: 0, warningCount: warningDiags.length,
    diagnostics: [...warningDiags], unparsableCount, recordId: get(rec, 'id', null), ts: get(rec, 'ts', null),
    scope, src, reason: reason.slice(0, 200), quoteSha: createHash('sha256').update(reason).digest('hex').slice(0, 12),
  };
  const recordTag = `recordId=${pyStr(get(rec, 'id', null))} scope=${pyStr(scope)} src=${pyStr(src)} reason=${reason.slice(0, 200)}`;
  const badRecord = (why) => ({
    ...base,
    blockingCount: 1,
    diagnostics: [...warningDiags, {
      ruleId: 'RULE-GATE-EXEMPT-ANCHOR', severity: 'blocking', file, line,
      message: `豁免锚记录非法（bad-record）：${why}；${recordTag}`,
      fixHint: '修复或轮换 .workflow/wf-exemptions.jsonl 后重跑 gate；如为误写，用户可显式 --exempt-revoke 或补计划锚。',
    }],
  });
  if (!['plan', 'review', 'revoked'].includes(scope)) return badRecord(`scope 非法（${pyStr(scope)}）`);
  if (!['user', 'preauthorized'].includes(src)) return badRecord(`src 非法（${pyStr(src)}）`);
  if (!reason) return badRecord('reason 为空');
  if (!Number.isFinite(Number(get(rec, 'ts', null)))) return badRecord('ts 非数字');
  const planPath = get(rec, 'planPath', null);
  if (scope === 'review') {
    if (typeof planPath !== 'string' || !planPath.trim() || planPath.startsWith('/')
      || planPath.includes('\\') || planPath.split('/').includes('..')) {
      return badRecord('scope=review 的 planPath 缺失或非法');
    }
  } else if (planPath !== null && planPath !== undefined) {
    return badRecord(`scope=${scope} 不应携带 planPath`);
  }
  if (scope === 'revoked') {
    return {
      ...base, present: false, blockingCount: 0,
      revoked: true, revokedAt: get(rec, 'ts', null), revokedReason: reason,
    };
  }
  const anchorDiag = (why, fixHint) => ({
    ruleId: 'RULE-GATE-EXEMPT-ANCHOR', severity: 'blocking', file, line,
    message: `豁免锚校验失败（${why}）：${recordTag}`,
    fixHint,
  });
  const twoExits = '两条出路：①在完成链绑定的计划正文（围栏外）加 `豁免引文：<原话>` 并让 verification 绑定该计划；'
    + '②用户显式 --exempt-revoke --exempt "<撤销原话>" --exempt-src user|preauthorized --plan <已评审计划> 退役。';
  if (!effectivePlan) {
    return {
      ...base, present: true, blockingCount: 1,
      diagnostics: [...warningDiags, anchorDiag('no-plan', `完成链无 verification 绑定的有效计划。${twoExits}`)],
    };
  }
  let planText;
  try {
    planText = readUtf8Strict(effectivePlan);
  } catch {
    return {
      ...base, present: true, blockingCount: 1,
      diagnostics: [...warningDiags, anchorDiag('no-quote', `完成链绑定的计划不可读。${twoExits}`)],
    };
  }
  const ranges = fenceRanges(planText);
  const markerRe = /^\s*豁免引文[ \t]*[：:][ \t]*(.*)$/u;
  const planLines = planText.split(SPLITLINES_RE);
  let found = null;
  let conflict = false;
  for (let i = 0; i < planLines.length; i += 1) {
    if (inFenced(i + 1, ranges)) continue;
    const m = markerRe.exec(planLines[i]);
    if (!m) continue;
    const q = m[1].trim();
    if (!q) continue;
    if (found === null) found = q;
    else if (found !== q) conflict = true;
  }
  if (conflict || found === null || found !== reason) {
    return {
      ...base, present: true, blockingCount: 1,
      diagnostics: [...warningDiags, anchorDiag('no-quote', '计划正文缺少与记录一致的 `豁免引文：` 行。' + twoExits)],
    };
  }
  if (scope === 'review') {
    const rel = toPosix(relative(looseRealpath(root), looseRealpath(effectivePlan)));
    if (rel !== toPosix(planPath)) {
      return {
        ...base, present: true, blockingCount: 1,
        diagnostics: [...warningDiags, anchorDiag('plan-mismatch', `完成链计划 ${rel} 与记录 planPath ${pyStr(planPath)} 不一致。${twoExits}`)],
      };
    }
  }
  return {
    ...base, present: true, blockingCount: 0,
    planPath: typeof planPath === 'string' ? planPath : toPosix(relative(looseRealpath(root), looseRealpath(effectivePlan))),
  };
}

/**
 * 运行聚合 gate，返回报告；零阻塞时签发 gate receipt（引用最新 v/c 凭据与草案哈希）。
 * planCheckBlock 口径（内部规则-13）：CLI 旗标优先；未给旗标时读 内部治理状态 配置，
 * 两者都缺省 false（内部规则-6 默认提醒）。
 * @param {string} root @param {string} taskId
 * @param {{planPath?: string|null, planCheckBlock?: boolean,
 *          coreRunner?: ((root: string) => Record<string, unknown>)|null,
 *          planRunner?: ((root: string, planPath: string) => Record<string, unknown>)|null,
 *          midHook?: (() => void)|null, claim?: string|null, change?: string|null,
 *          changeContext?: Record<string, unknown>|null, chainProfile?: string,
 *          now?: string|null}} [opts] now 仅测试/parity 注入（生产路径不传）
 * @returns {Record<string, unknown>}
 */
function runGateInner(root, taskId, opts = {}) {
  const {
    planPath = null, planCheckBlock: planCheckBlockOpt = false, coreRunner = null,
    planRunner = null, midHook = null, claim = null, change = null, changeContext = null,
    chainProfile = 'dev', now = null,
  } = opts;
  let planCheckBlock = planCheckBlockOpt;
  if (!planCheckBlock) {
    planCheckBlock = pyTruthy(get(loadConfig(root), 'planCheckBlock', false));
  }
  // 链内 plan 绑定（坑3）：凭据口径=链上 verification 绑定（effectivePlan）；显式 --plan
  // 不一致即阻断。plan 节/评审覆盖维持显式计划（检查面，双轨）。
  const [effectivePlan, bindingDiags, boundRel] = _resolveEffectivePlan(root, taskId, planPath);
  const revBefore = computeRevisionSet(root, effectivePlan);
  const coreReport = _normalizeCorePlanSection((coreRunner ?? defaultCoreRunner)(root), planPath, root);
  let planSection = { checked: 0, blockingCount: 0, warningCount: 0, diagnostics: [] };
  if (planPath !== null && planPath !== undefined) {
    const planReport = (planRunner ?? defaultPlanRunner)(root, planPath);
    // G01（内部任务-241）：plan 校验器工具错误不得被当成「检查干净」——{"error"} 或 diagnostics
    // 非数组都是工具/配置错误，必须产 blocking 且不参与 planCheckBlock 提醒档降级
    // （降级语义只适用于「内容诊断」，工具错误降级会让 gate 假通过并签发凭据）。
    const planToolError = get(planReport, 'error', null);
    let planDiags;
    let planToolErrorFlag = false;
    if (typeof planToolError === 'string' && planToolError !== '') {
      planToolErrorFlag = true;
      planDiags = [{
        ruleId: 'RULE-GATE-PLAN', severity: 'blocking', file: String(planPath), line: 1,
        fixHint: `计划校验器工具/配置错误：${planToolError}（工具错误不参与提醒档降级，gate 不签凭据）`,
        toolError: true,
      }];
    } else if (!Array.isArray(get(planReport, 'diagnostics', null))) {
      planToolErrorFlag = true;
      planDiags = [{
        ruleId: 'RULE-GATE-PLAN', severity: 'blocking', file: String(planPath), line: 1,
        fixHint: '计划校验器输出形态异常（缺 diagnostics 数组；工具错误不参与提醒档降级）',
        toolError: true,
      }];
    } else {
      planDiags = get(planReport, 'diagnostics', []);
    }
    const planBlock = planDiags.filter((d) => get(d, 'severity', null) === 'blocking').length;
    if (planBlock && !planCheckBlock && !planToolErrorFlag) {
      // 内部规则-6 语义：默认提醒——阻断诊断降级为警告计入，不拦 gate；S2：severity 同步重写。
      const downgraded = planDiags.map((d) => downgradeDiag(d));
      planSection = {
        checked: 1,
        blockingCount: 0,
        warningCount: downgraded.filter((d) => get(d, 'severity', null) === 'warning').length,
        diagnostics: downgraded,
        note: 'planCheckBlock 关闭：阻断级降级为 warning 呈现（severity 与计数同口径，S2 批次）',
      };
    } else {
      planSection = {
        checked: 1,
        blockingCount: planBlock,
        warningCount: planDiags.filter((d) => get(d, 'severity', null) === 'warning').length,
        diagnostics: planDiags,
      };
    }
  }
  const ledgerSection = _checkLedger(root, now);
  const boundarySection = _checkBoundaries(root);
  const ifDriftSection = _checkIfDrift(root);
  const receiptsSection = _checkReceipts(root, taskId, chainProfile);
  // 内部决策-027：L1 操作免两阶段交付报告——操作记录工件即交付物，gate 凭据 L1 + 探针全过
  // 即完成标记；delivery draft 节跳过不阻断。
  const l1Operation = ['operation', 'deliverable'].includes(chainProfile)
    && get(receiptsSection, 'riskLevel', null) === 'L1'
    && get(receiptsSection, 'blockingCount', 1) === 0;
  let deliverySection;
  if (l1Operation) {
    deliverySection = {
      present: false, status: 'skipped-l1', blockingCount: 0, warningCount: 0, diagnostics: [],
      note: 'L1 操作免两阶段交付报告（ADR-027）——完成标记=gate 凭据 riskLevel L1 + 操作断言全过',
    };
  } else {
    deliverySection = _checkDelivery(root, taskId);
  }
  const reviewCoverageSection = _checkReviewCoverage(root, taskId, planPath);
  const productionSection = _checkProduction(root, claim, change, changeContext);
  const governanceSection = _checkGovernanceSection(root);
  const exemptionsSection = _checkExemptions(root, taskId);
  const exemptAnchorSection = _checkExemptAnchor(root, taskId, effectivePlan);
  if (midHook !== null && midHook !== undefined) midHook();
  const revAfter = computeRevisionSet(root, effectivePlan);
  const revisionDiags = _checkRevisionStability(revBefore, revAfter);

  // planBinding 节（坑3）：链绑定口径自述 + 不一致阻断（planSectionPolicy 同款防误读手法）。
  // 内部任务-265：boundRel 在有链绑定但计划不可读时仍保留，避免把「不可读」呈现成「从未绑定」。
  const planBindingSection = {
    blockingCount: bindingDiags.length,
    warningCount: 0,
    diagnostics: bindingDiags,
    source: (effectivePlan !== null || boundRel !== null)
      ? 'chain'
      : (planPath !== null && planPath !== undefined ? 'explicit-check-only' : 'none'),
    path: effectivePlan !== null
      ? toPosix(effectivePlan)
      : (boundRel !== null
        ? toPosix(boundRel)
        : (planPath !== null && planPath !== undefined ? toPosix(planPath) : null)),
    note: '凭据绑定口径=链上 verification 绑定（继承）；显式 --plan 仅驱动 plan 节/评审覆盖检查（检查面）'
      + (boundRel !== null && effectivePlan === null ? '；链绑定计划不可读，已产 blocking' : ''),
  };

  const sections = {
    core: coreReport,
    plan: planSection,
    ledger: ledgerSection,
    boundary: boundarySection,
    ifDrift: ifDriftSection,
    delivery: deliverySection,
    receipts: receiptsSection,
    reviewCoverage: reviewCoverageSection,
    production: productionSection,
    governance: governanceSection,
    exemptions: exemptionsSection,
    planBinding: planBindingSection,
    exemptAnchor: exemptAnchorSection,
  };
  let blocking = Number(get(coreReport, 'blockingCount', 0));
  for (const section of [
    planSection, ledgerSection, boundarySection, ifDriftSection,
    deliverySection, receiptsSection, productionSection, governanceSection,
    planBindingSection, exemptAnchorSection,
  ]) {
    blocking += Number(get(section, 'blockingCount', 0));
  }
  blocking += revisionDiags.length;
  // 原 Python 实现（迁移史见 内部决策-051）同口径（gate.py:754-760）：governance/production/planBinding 不计 warning。
  let warning = Number(get(coreReport, 'warningCount', 0)) + Number(get(planSection, 'warningCount', 0));
  warning += Number(get(ledgerSection, 'warningCount', 0));
  warning += Number(get(boundarySection, 'warningCount', 0)) + Number(get(ifDriftSection, 'warningCount', 0));
  warning += Number(get(deliverySection, 'warningCount', 0));
  warning += Number(get(receiptsSection, 'warningCount', 0));
  warning += Number(get(reviewCoverageSection, 'warningCount', 0));
  warning += Number(get(exemptionsSection, 'warningCount', 0));
  warning += Number(get(exemptAnchorSection, 'warningCount', 0));

  const diagnostics = [];
  for (const section of Object.values(sections)) {
    diagnostics.push(...(get(section, 'diagnostics', []) ?? []));
  }
  diagnostics.push(...revisionDiags);

  let gateReceiptId = null;
  if (blocking === 0) {
    const verification = latestReceipt(root, taskId, 'verification');
    const draft = join(root, '.sdd', 'reports', taskId, 'delivery-draft.json');
    // 用双算后的 revAfter 盖章（评审 C3）：不在签发点重算 revision；第二环按链形态三态。
    const operation = latestReceipt(root, taskId, 'operation');
    const review = latestReceipt(root, taskId, 'code-review');
    let secondRef;
    if (operation !== null && review !== null) {
      secondRef = {
        operationReceiptId: operation.receiptId,
        codeReviewReceiptId: review.receiptId,
      };
    } else if (operation !== null) {
      secondRef = { operationReceiptId: operation.receiptId };
    } else {
      secondRef = { codeReviewReceiptId: review.receiptId };
    }
    const gate = issueGateReceipt(
      root,
      taskId,
      verification.receiptId,
      l1Operation ? null : draft, // L1 免两阶段报告：draft 不绑定（内部决策-027）
      {
        blockingCount: 0,
        warningCount: warning,
        revision: revAfter,
        riskLevel: operation !== null ? get(operation, 'riskLevel', null) : null,
        ...secondRef,
        now: now ?? undefined,
      },
    );
    gateReceiptId = gate.receiptId;
  }

  const strippedSections = {};
  for (const [name, section] of Object.entries(sections)) {
    const copy = {};
    for (const [key, value] of Object.entries(section)) {
      if (key !== 'diagnostics') copy[key] = value;
    }
    strippedSections[name] = copy;
  }

  return {
    schemaVersion: '2.0.0',
    taskId,
    mode: get(coreReport, 'mode', 'unknown'),
    revision: revisionSetToDict(revAfter),
    planBinding: { source: planBindingSection.source, path: planBindingSection.path },
    sections: strippedSections,
    blockingCount: blocking,
    warningCount: warning,
    // S2 批次（2026-09-16）：口径说明行——plan 节计数不参与顶层阻断判定，防误读。
    planSectionPolicy: `${PLAN_SECTION_POLICY_NOTE}；显式 --plan 计划的阻断仅在 planCheckBlock 开启时参与阻断（R-M7-6）`,
    diagnostics,
    gateReceipt: gateReceiptId,
  };
}

/**
 * 聚合 gate（公开入口）：内部任务-242 §三-4——一次 gate 内 latestReceipt 按 (root,taskId,kind)
 * 缓存（withReceiptCache 作用域），同一次聚合不再重复扫同一凭据。
 * @param {string} root @param {string} taskId @param {object} [opts]
 * @returns {Record<string, unknown>}
 */
export function runGate(root, taskId, opts = {}) {
  return withReceiptCache(() => runGateInner(root, taskId, opts));
}
