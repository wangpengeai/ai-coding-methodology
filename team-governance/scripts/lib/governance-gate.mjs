// 文件：governance-gate.mjs
// 描述：治理报告唯一聚合出口（内部规则-4/12 / 内部接口-18 / 内部决策-015）——聚合 config/policy/
//       manifests/leases/approvals/evals/learnings 成 governance-report.json；spec-gate 只读消费
//       四态（passed/blocked/stale/tampered），不重演规则（内部决策-2）。
//       内部任务-5 C（绑定 v1）：报告新增 binding/sources/coverage 三节——subject 锚定当前项目
//       内容/政策/change-set/审批 profile/eval 套件，sources 为按路径排序的全量控制输入
//       清单+inventory 缺失标记（消费方可检出新增/删除），coverage 逐域 loaded|empty|
//       missing|invalid（可选域 empty/missing=合法 not-applicable，禁止以未检查冒充全域
//       passed）；治理报告自身不入 sources、以 integrityHash 保护；validUntil=采用的有效
//       审批最早 expiresAt（无审批域 null）。verifyReport 自行重读当前项目重算绑定，
//       不接受调用方自报 digest 作证据。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { integrityHash } from './canonical-json.mjs';
import { validateApproval } from './approval.mjs';
import { collectGovernanceInputs } from './governance-store.mjs';

/**
 * 组装治理报告。
 * @param {{policy?: object, manifests?: Array<object>, leases?: Array<object>,
 *          approvals?: Array<{approval: object, current: object}>,
 *          evals?: Array<object>, learnings?: Array<object>, unreadableRuns?: string[],
 *          invalidAssets?: Array<{domain: string, path: string, error: string}>,
 *          missingConfigured?: string[], requiredDomains?: string[],
 *          binding?: {subject: string}|null,
 *          sources?: {refs: Array<{path: string, sha256: string}>,
 *                     inventory: Array<{path: string, present: boolean}>}|null,
 *          coverage?: object|null}} parts
 * @returns {{report: object, blockingCount: number, warningCount: number}}
 */
export function buildReport(parts) {
  /** @type {Array<{ruleId: string, severity: 'blocking'|'warning', message: string}>} */
  const diagnostics = [];
  // 2026-09-19 评审修复 H6：不可解析的 run 文件按名点名计 blocking——原实现（CLI 侧）
  // 把目录遍历与逐文件解析共一个 try，单个坏件吞掉整个 runs 集后报告假绿 passed 退 0
  for (const f of parts.unreadableRuns ?? []) {
    diagnostics.push({
      ruleId: 'TG-MANIFEST-UNREADABLE',
      severity: 'blocking',
      message: `run 文件 ${f} 不可解析（读取/JSON 失败）——按坏件阻断，不吞整个 runs 集`,
    });
  }
  // 内部任务-257（P5-10）：同一坏 run 已在 unreadableRuns 计 UNREADABLE——同 path 不再双计 ASSET-INVALID。
  for (const a of (parts.invalidAssets ?? []).filter((x) => !(parts.unreadableRuns ?? []).includes(x.path))) {
    diagnostics.push({
      ruleId: 'TG-ASSET-INVALID',
      severity: 'blocking',
      message: `${a.domain} 资产 ${a.path} 不可解析（${a.error}）——点名阻断，不吞为空集`,
    });
  }
  for (const p of parts.missingConfigured ?? []) {
    diagnostics.push({
      ruleId: 'TG-ASSET-MISSING',
      severity: 'blocking',
      message: `配置引用缺失：${p}（配置声明为治理输入，缺失不得静默跳过）`,
    });
  }
  // manifest 复核：不可变哈希 + 内部任务-254（H7）绑定 stale/legacy 分档
  const bindingForManifests = parts.binding ?? null;
  const finalizedManifests = [];
  for (const m of parts.manifests ?? []) {
    if (m.status !== 'finalized') {
      diagnostics.push({ ruleId: 'TG-MANIFEST-OPEN', severity: 'blocking', message: `run ${m.runId} 未 finalize` });
      continue;
    }
    const { integrityHash: recordedHash, ...mBody } = m;
    if (!recordedHash || integrityHash(mBody) !== recordedHash) {
      diagnostics.push({ ruleId: 'TG-MANIFEST-TAMPERED', severity: 'blocking',
        message: `run ${m.runId} 的 integrityHash 重算失配（manifest 被改动或 finalize 链断裂）` });
      continue; // 篡改件的 digest 字段不可信，不再参与 stale 判定
    }
    finalizedManifests.push(m);
  }
  if (bindingForManifests) {
    const isLegacy = (m) => m.policyDigest === undefined || m.changeSetDigest === undefined;
    const tsOf = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY; };
    // 「最近」＝已 finalized 且 outcome=completed 的 manifest 中 completedAt 最大者
    // （cancelled/failed 不参与作用域、仅自身 warning；更旧 completed stale 降 warning）
    let latest = null;
    for (const m of finalizedManifests) {
      if ((m.outcome ?? 'completed') !== 'completed') continue;
      if (latest === null) { latest = m; continue; }
      const a = tsOf(m.completedAt);
      const b = tsOf(latest.completedAt);
      if (a > b || (a === b && String(m.runId ?? '') < String(latest.runId ?? ''))) latest = m;
    }
    for (const m of finalizedManifests) {
      const outcome = m.outcome ?? 'completed';
      // legacy（缺 policy/change-set digest）：无法比对 → 只记 warning，不冒充 stale
      if (isLegacy(m)) {
        diagnostics.push({ ruleId: 'TG-MANIFEST-LEGACY', severity: 'warning',
          message: `run ${m.runId} 缺 policy/change-set digest（legacy manifest）——开新 run 完成并 finalize 以获得失效复核能力（finalized 不可重开）` });
        continue;
      }
      const matches = m.policyDigest === bindingForManifests.policyDigest
        && m.changeSetDigest === bindingForManifests.changeSetDigest;
      if (matches) continue;
      if (outcome !== 'completed') {
        diagnostics.push({ ruleId: 'TG-MANIFEST-STALE', severity: 'warning',
          message: `run ${m.runId}（outcome=${outcome}）与当前 policy/change-set digest 不一致——诚实封存件仅 warning` });
      } else if (m === latest) {
        diagnostics.push({ ruleId: 'TG-MANIFEST-STALE', severity: 'blocking',
          message: `run ${m.runId} 是最近的 completed manifest，但其 policy/change-set digest 与当前绑定不一致（policy 或 change-set 已变）——先开新 run 完成并 finalize 以恢复` });
      } else {
        diagnostics.push({ ruleId: 'TG-MANIFEST-STALE', severity: 'warning',
          message: `历史 run ${m.runId}（completed）与当前绑定不一致——历史留痕不永久阻断，最新 completed run 一致即通过` });
      }
    }
  }
  for (const l of parts.leases ?? []) {
    if (l.state === 'held' && l.expiresAt < Date.now()) {
      diagnostics.push({ ruleId: 'TG-LEASE-STALE', severity: 'warning', message: `租约 ${l.leaseId}（${l.resource}）已过期仍处 held` });
    }
  }
  // 审批复核（内部任务-254 H2/H4）：折叠后的有效审批才计入 validUntil；历史失效降 warning；
  // 阻断触发单源＝requiredDomains 含 approvals；自批在无有效审批时 blocking，有有效独立
  // 审批时自批记录仅作历史 warning；highRisk 且无归属 → TG-APPROVAL-UNATTRIBUTED warning。
  let validUntil = null;
  let validApprovals = 0;
  const selfApprovals = [];
  // 内部任务-254（H2 数据源唯一，三维评审简洁性阻塞 1）：归属只认 parts.requestedBy（store 现算）；
  // 不再逐条从 current 覆盖（双源会让注释与行为不一致）。
  const requestedBy = parts.requestedBy ?? null;
  for (const { approval, current } of parts.approvals ?? []) {
    const v = validateApproval(approval, current ?? {});
    if (v.ok) {
      validApprovals += 1;
      const exp = String(approval.expiresAt ?? '').slice(0, 10);
      if (exp && (validUntil === null || exp < validUntil)) validUntil = exp;
    } else if (v.code === 'self-approval') {
      selfApprovals.push(approval);
    } else {
      diagnostics.push({ ruleId: 'TG-APPROVAL-INVALID', severity: 'warning',
        message: `审批 ${approval?.approvalId ?? '?'} 无效：${v.reason}` });
    }
  }
  const highRisk = parts.policy?.riskLevel === 'high';
  if (selfApprovals.length > 0) {
    for (const a of selfApprovals) {
      if (validApprovals === 0) {
        diagnostics.push({ ruleId: 'TG-APPROVAL-SELF', severity: 'blocking',
          message: `审批 ${a.approvalId ?? '?'} 由执行者自批（高风险变更）——须由独立身份重批` });
      } else {
        diagnostics.push({ ruleId: 'TG-APPROVAL-INVALID', severity: 'warning',
          message: `审批 ${a.approvalId ?? '?'} 由执行者自批（高风险变更）——已由有效独立审批覆盖，仅留痕` });
      }
    }
  }
  if (highRisk && requestedBy === null && parts.requestedBy !== undefined) {
    diagnostics.push({ ruleId: 'TG-APPROVAL-UNATTRIBUTED', severity: 'warning',
      message: '高风险 run 无 humanInitiator 归属（requestedBy 缺失/unknown）——无法判自批，仅 warning' });
  }
  if ((parts.requiredDomains ?? []).includes('approvals') && validApprovals === 0) {
    diagnostics.push({ ruleId: 'TG-APPROVAL-MISSING', severity: 'blocking',
      message: 'requiredDomains 含 approvals，但当前无任何有效审批（缺失/失效/撤销/过期均计无有效）' });
  }
  // eval 复核（内部任务-254 H1）：integrityHash 由 gate 复核；篡改/缺失/空/不可复算均 fail-closed
  for (const e of parts.evals ?? []) {
    const { integrityHash: recordedEvalHash, ...evalBody } = e ?? {};
    if (!recordedEvalHash || integrityHash(evalBody) !== recordedEvalHash) {
      diagnostics.push({ ruleId: 'TG-EVAL-TAMPERED', severity: 'blocking',
        message: `eval 报告 ${e?.suiteId ?? '?'} 的 integrityHash 缺失/为空/重算失配——fail-closed 阻断` });
    }
    if (e?.summary?.unverified > 0) {
      diagnostics.push({ ruleId: 'TG-EVAL-UNVERIFIED', severity: 'warning', message: `eval ${e.suiteId} 含 ${e.summary.unverified} 条 unverified（对象哈希不匹配）` });
    }
    if (e?.summary?.failed > 0) {
      diagnostics.push({ ruleId: 'TG-EVAL-FAILED', severity: 'blocking', message: `eval ${e.suiteId} 含 ${e.summary.failed} 条确定性失败` });
    }
  }
  // required 覆盖缺口：requiredDomains 中非 loaded 的域即阻断（可选域 empty/missing 合法 not-applicable）
  for (const domain of parts.requiredDomains ?? []) {
    const state = parts.coverage?.[domain];
    if (state !== 'loaded') {
      diagnostics.push({
        ruleId: 'TG-COVERAGE-REQUIRED',
        severity: 'blocking',
        message: `必需治理域 ${domain} 未就绪（当前 ${state ?? 'unknown'}）——required 覆盖缺口`,
      });
    }
  }
  const blockingCount = diagnostics.filter((d) => d.severity === 'blocking').length;
  const binding = parts.binding ?? null;
  const report = {
    schemaVersion: '1.0.0',
    status: blockingCount === 0 ? 'passed' : 'blocked',
    blockingCount,
    warningCount: diagnostics.length - blockingCount,
    // 兼容字段（值=绑定 v1 subject；legacy 报告无 binding 时为 null）
    subjectDigest: binding?.subject ?? null,
    // 绑定 v1 三节（内部接口-18 §3 语义唯一源）
    binding: binding ? { spec: 'binding-v1', subject: binding.subject, validUntil } : null,
    sources: parts.sources ?? null,
    coverage: parts.coverage ?? null,
    policy: parts.policy ? { id: parts.policy.id ?? 'default', version: parts.policy.version ?? 1,
                             digest: integrityHash(parts.policy) } : null,
    manifests: (parts.manifests ?? []).map((m) => ({ runId: m.runId, outcome: m.outcome ?? null, integrityHash: m.integrityHash ?? null })),
    leases: (parts.leases ?? []).map((l) => ({ leaseId: l.leaseId, resource: l.resource, state: l.state, fencingToken: l.fencingToken })),
    approvals: (parts.approvals ?? []).map(({ approval }) => ({ approvalId: approval.approvalId, subjectDigest: approval.subjectDigest })),
    evals: (parts.evals ?? []).map((e) => ({ suiteId: e.suiteId, integrityHash: e.integrityHash ?? null, passRate: e.summary?.passRate ?? null })),
    learnings: parts.learnings ?? [],
    diagnostics,
  };
  report.integrityHash = integrityHash(report);
  return { report, blockingCount, warningCount: report.warningCount };
}

/** 逐项比较清单条目的指定字段（键序无关；数组保序）。 */
function sameEntries(a, b, fields) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    for (const f of fields) {
      if (a[i]?.[f] !== b[i]?.[f]) return false;
    }
  }
  return true;
}

/**
 * 消费方复核（内部接口-18 verify-report）：四态判定。
 * 内部任务-5 C：自行重读当前项目重算绑定（contentDigest/policyDigest/sources/inventory），
 * 不接受调用方自报 digest 作证据；内容变/新增删除输入=stale、validUntil 到界=stale
 * （now 可注入时钟）、手改=tampered；legacy 报告（无 binding）缺省 stale，
 * allowLegacy 显式授权才按旧口径（仅状态判定）消费。
 * @param {{integrityHash?: string, status?: string, binding?: {subject: string, validUntil: string|null}|null,
 *          sources?: {refs?: Array, inventory?: Array}|null}} parsedReport
 * @param {{projectRoot?: string, now?: string|number|Date, allowLegacy?: boolean,
 *          currentSubjectDigest?: string|null}} [current] 兼容保留 currentSubjectDigest 键位但不再作证据
 * @returns {'passed'|'blocked'|'stale'|'tampered'}
 */
export function verifyReport(parsedReport, current = {}) {
  if (!parsedReport || typeof parsedReport !== 'object' || !parsedReport.integrityHash) return 'tampered';
  // integrityHash 字段参与自身排除——重算时移除后应与记录一致
  const recorded = parsedReport.integrityHash;
  const body = { ...parsedReport };
  delete body.integrityHash;
  if (integrityHash(body) !== recorded) return 'tampered';
  const legacy = !parsedReport.binding || typeof parsedReport.binding !== 'object';
  if (legacy && !current.allowLegacy) return 'stale';
  if (legacy) return parsedReport.status === 'passed' ? 'passed' : 'blocked';
  if (current.projectRoot) {
    // 只读重算当前绑定与输入集（collector 独立重枚举，可检出新增/删除文件）
    const collected = collectGovernanceInputs(current.projectRoot);
    if (parsedReport.binding.subject !== collected.binding.subject) return 'stale';
    if (!parsedReport.sources || !Array.isArray(parsedReport.sources.refs)
        || !Array.isArray(parsedReport.sources.inventory)) return 'stale';
    if (!sameEntries(parsedReport.sources.refs, collected.sourceRefs, ['path', 'sha256'])) return 'stale';
    if (!sameEntries(parsedReport.sources.inventory, collected.sourceInventory, ['path', 'present'])) return 'stale';
  }
  // validUntil 时间到界=stale（日粒度，与审批到期同口径；消费方只读验证时间不重演政策）
  const validUntil = parsedReport.binding.validUntil;
  if (typeof validUntil === 'string' && validUntil) {
    const nowDate = (current.now === undefined ? new Date().toISOString() : String(current.now)).slice(0, 10);
    if (validUntil < nowDate) return 'stale';
  }
  return parsedReport.status === 'passed' ? 'passed' : 'blocked';
}
