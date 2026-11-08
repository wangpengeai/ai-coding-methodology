// 文件：structured.mjs
// 描述：结构化文档检查器（ADR / OPEN-n / DDD / 接口 / 任务台账 / 快速通道）。
//       F-3 时间语义、F-16 坏形态诊断（不再以 AttributeError/TypeError 冒充执行失败）。
import { diagnostic } from './diagnostics.mjs';
import { cmpPyDateTimeUtc, parseNowOrThrow, parsePyIsoDateTime, pyRepr, pyStr, pyTruthy } from './pycompat.mjs';

export const ADR_FIELDS = [
  'id', 'status', 'date', 'context', 'decision', 'alternatives', 'selectionRationale',
  'consequences', 'evidenceSources', 'confidence', 'supersession', 'traceability', 'confirmationStatus',
];
export const OPEN_FIELDS = ['id', 'status', 'owner', 'impact', 'blocking', 'resolutionTrigger', 'evidence'];
export const TASK_FIELDS = ['id', 'title', 'status', 'createdAt'];
export const TASK_STATUSES = ['active', 'converged', 'temporary-mitigation', 'expired'];
const STRATEGIC_ALWAYS_REQUIRED = [
  ['subdomains', '子域分类'], ['boundedContexts', '限界上下文清单'], ['contextMap', 'Context Map'],
  ['contextRelationships', '上下游与契约所有权'], ['ubiquitousLanguage', '统一语言'], ['traceability', '领域资产追溯'],
];
const NA_ASSET_KEYS = {
  subdomain_classification: 'subdomains',
  context_map: 'contextMap',
  event_storming: 'eventStorming',
  hotspots: 'hotspots',
};
const NA_ASSET_LABELS = {
  subdomain_classification: '子域分类',
  context_map: 'Context Map',
  event_storming: '事件风暴',
  hotspots: '热点登记',
};
const INTERFACE_LIFECYCLE = ['proposed', 'active', 'deprecated', 'retired'];
const INTERFACE_KINDS = ['external', 'inter-module'];
const INTERFACE_COMPAT_POLICIES = ['strict-backward', 'rolling', 'pinned'];
const INTERFACE_REQUIRED = ['id', 'kind', 'ownerModule', 'consumerModules', 'operations', 'errorSemantics', 'lifecycle', 'version', 'compatPolicy', 'tracesTo'];
const EMPTY = Symbol('empty');

function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function diag(rule, relPath, hint) { return diagnostic(rule, 'blocking', relPath, 1, hint); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** tasks/openItems/optOuts 的 Python `for` 迭代语义；不可迭代返回 EMPTY 由调用方产诊断。 */
function iterableField(data, key) {
  if (!isObject(data) || !hasOwn(data, key)) return [];
  const v = data[key];
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === 'object') return Object.keys(v);
  if (typeof v === 'string') return [...v];
  return EMPTY;
}
function compareTimestamp(a, b) {
  return cmpPyDateTimeUtc(a, b);
}

export function checkAdr(data, relPath) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-ADR-001', relPath, `ADR 资产须为对象（当前 ${pyRepr(data)}）`)];
  const missing = ADR_FIELDS.filter((f) => !(f in data));
  if (missing.length) diagnostics.push(diag('RULE-ADR-001', relPath, `ADR 缺少必填字段: ${missing.join(', ')}`));
  const confidence = data.confidence;
  const confirmation = data.confirmationStatus;
  if (confidence === 'low' && (confirmation === undefined || confirmation === null || confirmation === 'pending')) {
    diagnostics.push(diag('RULE-ADR-002', relPath, '置信度 low 且未经确认的 ADR 不得成为硬约束基线'));
  }
  if (data.isRetrofitReconstruction === false) {
    const signals = ['反推', '重构', '事后'];
    const context = String(data.context ?? '');
    if (signals.some((s) => context.includes(s))) {
      diagnostics.push(diag('RULE-ADR-002', relPath, '内容呈现反推特征但未标记 isRetrofitReconstruction'));
    }
  }
  return diagnostics;
}

export function checkAdrRegistry(data, relPath) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-ADR-003', relPath, `ADR 册须为对象（当前 ${pyRepr(data)}）`)];
  const entries = data.entries ?? [];
  if (!Array.isArray(entries)) return [diag('RULE-ADR-003', relPath, 'ADR 册 entries 须为数组')];
  const seen = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isObject(entry)) { diagnostics.push(diag('RULE-ADR-003', relPath, `entries[${i}] 须为对象`)); continue; }
    const adrId = entry.id;
    if (seen.has(adrId)) {
      diagnostics.push(diag('RULE-ADR-003', relPath, `ADR 编号重复: ${pyStr(adrId)}（条目 ${seen.get(adrId)} 与 ${i + 1}）`));
    } else seen.set(adrId, i + 1);
  }
  const retired = new Set(Array.isArray(data.retiredIds) ? data.retiredIds : []);
  const overlap = [...retired].filter((id) => seen.has(id));
  if (overlap.length) diagnostics.push(diag('RULE-ADR-003', relPath, `已退役编号被重用: ${overlap.sort().join(', ')}`));
  return diagnostics;
}

export function checkInterfaces(data, relPath) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-IF-001', relPath, `接口资产须为对象（当前 ${pyRepr(data)}）`)];
  const interfaces = data.interfaces ?? [];
  if (!Array.isArray(interfaces)) return [diag('RULE-IF-001', relPath, 'interfaces 须为数组')];
  const seen = new Map();
  for (let i = 0; i < interfaces.length; i += 1) {
    const it = interfaces[i];
    if (!isObject(it)) { diagnostics.push(diag('RULE-IF-001', relPath, `interfaces[${i}] 须为对象`)); continue; }
    const ifId = hasOwn(it, 'id') ? it.id : `#${i + 1}`;
    const missing = INTERFACE_REQUIRED.filter((f) => !(f in it));
    if (missing.length) diagnostics.push(diag('RULE-IF-001', relPath, `${pyStr(ifId)}: 缺少必填字段: ${missing.join(', ')}`));
    if (it.kind !== undefined && it.kind !== null && !INTERFACE_KINDS.includes(it.kind)) {
      diagnostics.push(diag('RULE-IF-001', relPath, `${pyStr(ifId)}: 非法 kind「${pyStr(it.kind)}」（external|inter-module）`));
    }
    if (seen.has(ifId)) diagnostics.push(diag('RULE-IF-001', relPath, `接口编号重复: ${pyStr(ifId)}（条目 ${seen.get(ifId)} 与 ${i + 1}）`));
    else seen.set(ifId, i + 1);
    if (it.kind === 'inter-module' && 'consumerModules' in it && !pyTruthy(it.consumerModules)) {
      diagnostics.push(diag('RULE-IF-002', relPath, `${pyStr(ifId)}: inter-module 接口必须登记至少一个消费方`));
    }
    if (it.compatPolicy !== undefined && it.compatPolicy !== null && !INTERFACE_COMPAT_POLICIES.includes(it.compatPolicy)) {
      diagnostics.push(diag('RULE-IF-003', relPath, `${pyStr(ifId)}: 非法 compatPolicy「${pyStr(it.compatPolicy)}」`));
    }
    const lifecycle = it.lifecycle;
    if (lifecycle !== undefined && lifecycle !== null && !INTERFACE_LIFECYCLE.includes(lifecycle)) {
      diagnostics.push(diag('RULE-IF-003', relPath, `${pyStr(ifId)}: 非法 lifecycle「${pyStr(lifecycle)}」`));
    } else if (lifecycle === 'deprecated') {
      const dep = isObject(it.deprecation) ? it.deprecation : {};
      if (!pyTruthy(dep.deadline) || !pyTruthy(dep.migrationNote)) {
        diagnostics.push(diag('RULE-IF-003', relPath, `${pyStr(ifId)}: deprecated 必须附 deprecation.deadline 与 migrationNote`));
      }
    }
  }
  if (isObject(data.interfaceRegistry)) {
    diagnostics.push(...checkRegistryConsistency(interfaces.filter(isObject), data.interfaceRegistry, relPath));
  }
  if (pyTruthy(data.externalContracts)) {
    diagnostics.push(diagnostic('RULE-IF-006', 'warning', relPath, 1, 'externalContracts 已弃用：迁移为 interfaces(kind=external)（1.1.x 非阻塞，2.0.0 移除）'));
  }
  return diagnostics;
}

function checkRegistryConsistency(interfaces, registry, relPath) {
  const diagnostics = [];
  const byId = new Map(interfaces.filter((it) => hasOwn(it, 'id')).map((it) => [it.id, it]));
  const regEntries = Array.isArray(registry.entries) ? registry.entries : [];
  const regById = new Map(regEntries.filter(isObject).map((e) => [e.interfaceId, e]));
  for (const [ifId, entry] of regById) {
    const it = byId.get(ifId);
    if (!it) { diagnostics.push(diag('RULE-IF-002', relPath, `${pyStr(ifId)}: 注册表条目无对应分册接口资产`)); continue; }
    for (const field of ['lifecycle', 'version', 'ownerModule']) {
      if (entry[field] !== undefined && entry[field] !== null && entry[field] !== it[field]) {
        diagnostics.push(diag('RULE-IF-002', relPath, `${pyStr(ifId)}: 注册表与分册 ${field} 不一致（${pyStr(entry[field])} vs ${pyStr(it[field])}）`));
      }
    }
  }
  for (const [ifId, it] of byId) {
    if ((it.lifecycle === 'active' || it.lifecycle === 'deprecated') && !regById.has(ifId)) {
      diagnostics.push(diag('RULE-IF-002', relPath, `${pyStr(ifId)}: active/deprecated 接口未进全局注册表`));
    }
  }
  return diagnostics;
}

export function checkInterfaceRegistry(data, relPath) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-IF-003', relPath, `接口注册表须为对象（当前 ${pyRepr(data)}）`)];
  const entries = data.entries ?? [];
  if (!Array.isArray(entries)) return [diag('RULE-IF-003', relPath, '接口注册表 entries 须为数组')];
  const seen = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isObject(entry)) { diagnostics.push(diag('RULE-IF-003', relPath, `entries[${i}] 须为对象`)); continue; }
    const ifId = hasOwn(entry, 'interfaceId') ? entry.interfaceId : `#${i + 1}`;
    if (seen.has(ifId)) diagnostics.push(diag('RULE-IF-003', relPath, `注册表编号重复: ${pyStr(ifId)}（条目 ${seen.get(ifId)} 与 ${i + 1}）`));
    else seen.set(ifId, i + 1);
    if (!INTERFACE_LIFECYCLE.includes(entry.lifecycle)) {
      diagnostics.push(diag('RULE-IF-003', relPath, `${pyStr(ifId)}: 非法 lifecycle「${pyStr(entry.lifecycle)}」`));
    }
    if (entry.lifecycle === 'deprecated' && !pyTruthy(entry.deprecationDeadline)) {
      diagnostics.push(diag('RULE-IF-003', relPath, `${pyStr(ifId)}: 注册表 deprecated 条目必须带 deprecationDeadline`));
    }
  }
  const retired = new Set(Array.isArray(data.retiredIds) ? data.retiredIds : []);
  const overlap = [...retired].filter((id) => seen.has(id));
  if (overlap.length) diagnostics.push(diag('RULE-IF-003', relPath, `已退役接口编号被重用: ${overlap.sort().join(', ')}`));
  return diagnostics;
}

export function checkOpenItems(data, relPath, mode) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-OPEN-001', relPath, `未决项资产须为对象（当前 ${pyRepr(data)}）`)];
  const items = data.items ?? [];
  if (!Array.isArray(items)) return [diag('RULE-OPEN-001', relPath, '未决项 items 须为数组')];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isObject(item)) { diagnostics.push(diag('RULE-OPEN-001', relPath, `items[${i}] 须为对象`)); continue; }
    const missing = OPEN_FIELDS.filter((f) => !(f in item));
    if (missing.length) diagnostics.push(diag('RULE-OPEN-001', relPath, `未决项缺少字段: ${missing.join(', ')}`));
    if (item.status === 'accepted-risk' && (!pyTruthy(item.riskAcceptanceRationale) || !pyTruthy(item.riskAcceptanceTrigger))) {
      diagnostics.push(diag('RULE-OPEN-003', relPath, `${pyStr(hasOwn(item, 'id') ? item.id : '?')}: accepted-risk 必须附风险接受依据与触发条件`));
    }
    if (mode === 'baseline' && pyTruthy(item.blocking)) {
      diagnostics.push(diag('RULE-OPEN-002', relPath, `${pyStr(hasOwn(item, 'id') ? item.id : '?')}: blocking 未决项不得进入 baseline 定稿`));
    }
  }
  return diagnostics;
}

export function checkDddAssets(data, relPath, level) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-DDD-001', relPath, `DDD 资产须为对象（当前 ${pyRepr(data)}）`)];
  if (level === 'strategic') {
    for (const [key, label] of STRATEGIC_ALWAYS_REQUIRED) {
      if (!pyTruthy(data[key])) diagnostics.push(diag('RULE-DDD-001', relPath, `战略级缺少始终必需资产: ${label}`));
    }
    const storming = isObject(data.eventStorming) ? data.eventStorming : {};
    if (storming.applicable === false && !pyTruthy(data.eventStormingAlternatives)) {
      diagnostics.push(diag('RULE-DDD-003', relPath, '事件风暴不适用时必须提供事件时间线/示例映射/决策表至少一种替代证据'));
    }
  }
  const applicability = Array.isArray(data.applicability) ? data.applicability : [];
  for (const entry of applicability) {
    if (!isObject(entry) || entry.label !== 'na-allowed') continue;
    const key = NA_ASSET_KEYS[entry.asset];
    if (!key) continue;
    const value = data[key];
    const empty = value === undefined || value === null
      || (Array.isArray(value) && value.length === 0)
      || (isObject(value) && Object.keys(value).length === 0);
    if (empty && !pyTruthy(entry.reason) && !pyTruthy(entry.rationale)) {
      const label = NA_ASSET_LABELS[entry.asset] ?? pyStr(entry.asset);
      diagnostics.push(diag('RULE-DDD-004', relPath, `标注 N/A 的资产必须附理由；${label}为空但未说明理由`));
    }
  }
  if (level === 'tactical' || level === 'strategic') {
    const conclusions = data.impactConclusions;
    if (!pyTruthy(conclusions)) {
      diagnostics.push(diag('RULE-DDD-002', relPath, '缺少聚合边界与失败语义影响结论'));
    } else if (isObject(conclusions)) {
      if (!pyTruthy(conclusions.aggregateBoundaryImpact)) diagnostics.push(diag('RULE-DDD-002', relPath, '缺少聚合边界影响结论'));
      if (!pyTruthy(conclusions.failureSemanticsImpact)) diagnostics.push(diag('RULE-DDD-002', relPath, '缺少失败语义影响结论'));
    }
  }
  return diagnostics;
}

export function checkTaskLedger(data, relPath, now = null) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-LEDGER-001', relPath, `台账须为对象（当前 ${pyRepr(data)}）`)];
  const nowDt = parseNowOrThrow(now, 'now');
  const tasks = iterableField(data, 'tasks');
  if (tasks === EMPTY) {
    diagnostics.push(diag('RULE-LEDGER-001', relPath, 'tasks 字段不可迭代（须为数组/对象/字符串）'));
  } else {
    const seen = new Map();
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      if (!isObject(task)) { diagnostics.push(diag('RULE-LEDGER-001', relPath, `任务条目 ${i + 1} 须为对象`)); continue; }
      const idx = i + 1;
      const missing = TASK_FIELDS.filter((f) => !pyTruthy(task[f]));
      if (missing.length) diagnostics.push(diag('RULE-LEDGER-001', relPath, `任务条目 ${idx} 缺少字段: ${missing.join(', ')}`));
      const taskId = hasOwn(task, 'id') ? task.id : `#${idx}`;
      if (seen.has(taskId)) diagnostics.push(diag('RULE-LEDGER-001', relPath, `任务编号重复: ${pyStr(taskId)}`));
      else seen.set(taskId, idx);
      const status = task.status;
      if (!TASK_STATUSES.includes(status)) diagnostics.push(diag('RULE-LEDGER-001', relPath, `${pyStr(taskId)}: 非法状态 ${pyStr(status)}`));
      if (pyTruthy(task.fastTrack)) {
        if (!pyTruthy(task.deadline) || !pyTruthy(task.owner)) {
          diagnostics.push(diag('RULE-LEDGER-001', relPath, `${pyStr(taskId)}: 快速通道任务必须带 deadline 与负责人`));
        } else if (nowDt !== null && (status === 'temporary-mitigation' || status === 'active')) {
          const deadlineDt = parsePyIsoDateTime(String(task.deadline));
          if (deadlineDt === null) diagnostics.push(diag('RULE-LEDGER-001', relPath, `${pyStr(taskId)}: deadline 不是合法 ISO-8601`));
          else if (compareTimestamp(deadlineDt, nowDt) <= 0) {
            diagnostics.push(diag('RULE-LEDGER-002', relPath, `${pyStr(taskId)}: deadline 已超期且未收敛；标记 expired 并阻塞非紧急变更`));
          }
        }
      }
      if (status === 'converged' && (!pyTruthy(task.finalStatus) || !pyTruthy(task.gateReportRef))) {
        diagnostics.push(diag('RULE-LEDGER-003', relPath, `${pyStr(taskId)}: 收敛必须记录最终状态与证据引用`));
      }
    }
  }

  const openItems = iterableField(data, 'openItems');
  if (openItems === EMPTY) {
    diagnostics.push(diag('RULE-LEDGER-001', relPath, 'openItems 字段不可迭代'));
  } else {
    for (let i = 0; i < openItems.length; i += 1) {
      const item = openItems[i];
      if (!isObject(item)) { diagnostics.push(diag('RULE-LEDGER-001', relPath, `未决项条目 ${i + 1} 须为对象`)); continue; }
      const missing = OPEN_FIELDS.filter((f) => !(f in item));
      if (missing.length) diagnostics.push(diag('RULE-LEDGER-001', relPath, `未决项缺少字段: ${missing.join(', ')}`));
      if (item.status === 'accepted-risk' && (!pyTruthy(item.riskAcceptanceRationale) || !pyTruthy(item.riskAcceptanceTrigger))) {
        diagnostics.push(diag('RULE-OPEN-003', relPath, `${pyStr(hasOwn(item, 'id') ? item.id : '?')}: accepted-risk 必须附依据与触发条件`));
      }
    }
  }

  const optOuts = iterableField(data, 'optOuts');
  if (optOuts === EMPTY) {
    diagnostics.push(diag('RULE-LEDGER-001', relPath, 'optOuts 字段不可迭代'));
  } else {
    for (let i = 0; i < optOuts.length; i += 1) {
      const record = optOuts[i];
      if (!isObject(record)) { diagnostics.push(diag('RULE-LEDGER-001', relPath, `optOuts[${i}] 须为对象`)); continue; }
      if (record.mode === 'current-task' && !pyTruthy(record.taskId)) {
        diagnostics.push(diag('RULE-LEDGER-001', relPath, 'current-task 偏好记录必须带任务标识'));
      }
    }
  }
  return diagnostics;
}

export function checkFastTrack(data, relPath, category, now = null) {
  const diagnostics = [];
  if (!isObject(data)) return [diag('RULE-FAST-001', relPath, `快速通道记录须为对象（当前 ${pyRepr(data)}）`)];
  if (category === 'production-incident' || category === 'security-fix') {
    if (hasOwn(data, 'entries')) {
      const entries = Array.isArray(data.entries) ? data.entries : EMPTY;
      if (entries === EMPTY) return [diag('RULE-FAST-002', relPath, '快速通道 entries 须为数组')];
      return checkFastLedger({ entries }, relPath, now);
    }
    const recordFields = ['triggerReason', 'scope', 'currentBehavior', 'behaviorAssumptions', 'acceptanceAssumptions', 'risks', 'plannedVerification', 'finalizationTrigger'];
    const missing = recordFields.filter((f) => !pyTruthy(data[f]));
    if (missing.length) diagnostics.push(diag('RULE-FAST-001', relPath, `快速通道最小记录缺少字段: ${missing.join(', ')}`));
    if (isObject(data.ledgerPersistence) && data.ledgerPersistence.writeSucceeded === false) {
      diagnostics.push(diag('RULE-FAST-002', relPath, '收敛台账写入失败：保持 temporary-mitigation，将补录列为最高优先级未验证项'));
    }
    if ('reproTest' in data && data.reproTest === null) {
      if (!pyTruthy(data.cannotReproduceReason) || !pyTruthy(data.substituteVerification)) {
        diagnostics.push(diag('RULE-FAST-004', relPath, '无法先写复现测试时必须记录原因与替代验证'));
      }
    }
  } else if (category === 'exploratory-prototype') {
    const promotionFields = ['formalSpec', 'traceability', 'fullVerification'];
    if (String(data.target ?? '').startsWith('production') && !promotionFields.every((f) => pyTruthy(data[f]))) {
      diagnostics.push(diag('RULE-FAST-003', relPath, '原型进入生产前必须完成正式规格、追溯与完整验证'));
    }
  }
  return diagnostics;
}

function checkFastLedger(data, relPath, now) {
  const diagnostics = [];
  const nowDt = parseNowOrThrow(now, 'now');
  for (let i = 0; i < data.entries.length; i += 1) {
    const entry = data.entries[i];
    const id = isObject(entry) && hasOwn(entry, 'id') ? entry.id : '?';
    if (!isObject(entry) || !pyTruthy(entry.deadline) || !pyTruthy(entry.owner)) {
      diagnostics.push(diag('RULE-FAST-002', relPath, `${pyStr(id)}: deadline 与负责人必须持久记录`));
      continue;
    }
    if (nowDt !== null) {
      const deadlineDt = parsePyIsoDateTime(String(entry.deadline));
      if (deadlineDt === null) {
        diagnostics.push(diag('RULE-FAST-002', relPath, `${pyStr(id)}: deadline 不是合法 ISO-8601 时间`));
        continue;
      }
      if (compareTimestamp(deadlineDt, nowDt) <= 0) {
        diagnostics.push(diag('RULE-FAST-002', relPath, `${pyStr(id)}: deadline 已超期且未定稿；维持 temporary-mitigation 并阻塞后续非紧急变更`));
      }
    }
  }
  return diagnostics;
}
