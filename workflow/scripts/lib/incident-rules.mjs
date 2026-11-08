// 文件：incident-rules.mjs
// 描述：内部模块-15 v2 分类规则表 loader 与 classifyFact 纯函数（内部规则-9 / 内部决策-063 D3）。
//   为什么数据化：新增宿主/噪声类若继续硬编码 errorClass 分层，每次都要改代码与规格；
//   规则表版本化（rulesVersion）后，allowlist 与规则变更是可评审、可回滚的数据面。
//   保守原则：表缺失/坏 JSON/未命中一律 unclassified（待排查），绝不静默排除；
//   可回放拒绝 allowlist 只收宿主明确报错、可重放、非产品缺陷的 errorCode（显式可审计）。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 用法：被 post-tool/user-prompt/incident-cli/retro-metrics 共同消费；纯库，无副作用。
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** cause 闭集（与 incident-classification.json 的 causes 同源，导出供消费方派生）。 */
export const CAUSES = Object.freeze([
  'real-failure',
  'replayable-rejection',
  'probe-noise',
  'mechanism-trace',
  'mechanism-escalation',
  'user-correction',
  'retry-escalation',
  'observation-degraded',
  'unclassified',
]);
/** severity 闭集。 */
export const SEVERITIES = Object.freeze(['info', 'warn', 'action']);
/** 计入待排查面的 cause 集合（证据面为其补集；内部决策-063 D4）。 */
export const PENDING_CAUSES = Object.freeze([
  'real-failure',
  'mechanism-escalation',
  'user-correction',
  'retry-escalation',
  'observation-degraded',
  'unclassified',
]);
/** 证据面 cause 集合（不进待排查、由超龄归档终态化）。 */
export const EVIDENCE_CAUSES = Object.freeze(['probe-noise', 'replayable-rejection', 'mechanism-trace']);

const HERE = dirname(fileURLToPath(import.meta.url));
/** 规则表默认路径（同目录数据资产；测试可经 path 注入替代）。 */
export const DEFAULT_RULES_PATH = join(HERE, 'incident-classification.json');

/**
 * 规则表模块级缓存（内部决策-063 修正案 3 决策 21.3）：`path → {signature, view}`，
 * signature＝`mtimeMs:size`（文件被替换/改写即失效）。唯一刷新入口是 {@link clearRulesCache}
 * （测试缝；生产不建议手工清——文件变化由 mtime+size 自然触发重读）。
 * @type {Map<string, {signature: string, view: object}>}
 */
const RULES_CACHE = new Map();

/** 清空规则表缓存（内部决策-063 D21.3 唯一刷新缝；测试 after 必调，防跨用例串味）。 */
export function clearRulesCache() {
  RULES_CACHE.clear();
}

/**
 * 规则表路径解析（单源）：显式 `opts.path` → env 注入缝 `WF_INCIDENT_RULES_PATH`
 *（与 session-start 既有路径注入同源）→ 默认表。**不新增私设 API**。
 * @param {{path?: string}} opts
 * @returns {string}
 */
function resolveRulesPath(opts = {}) {
  if (typeof opts.path === 'string' && opts.path) return opts.path;
  const envPath = process.env.WF_INCIDENT_RULES_PATH;
  return typeof envPath === 'string' && envPath ? envPath : DEFAULT_RULES_PATH;
}

/**
 * 内置保守默认：空规则集＋固定 allowlist 副本形态。
 * 坏表时用它，classifyFact 全部落 unclassified（待排查），永不抛错。
 * @returns {{ok:false,degraded:true,rulesVersion:0,rules:[],replayableErrorCodes:string[],causes:string[],severities:string[],pendingCauses:string[],evidenceCauses:string[]}}
 */
export function builtinFallback() {
  return {
    ok: false,
    degraded: true,
    rulesVersion: 0,
    rules: [],
    replayableErrorCodes: [],
    causes: [...CAUSES],
    severities: [...SEVERITIES],
    pendingCauses: [...PENDING_CAUSES],
    evidenceCauses: [...EVIDENCE_CAUSES],
  };
}

/**
 * 加载规则表（幂等、容错、模块级缓存）。校验 schemaVersion/rulesVersion/causes/rules 形态；
 * 任何不满足即回退内置默认（degraded），不抛。
 *
 * 缓存口径（内部决策-063 D21.3）：键＝解析后路径，命中条件＝`mtimeMs+size` 同签名；
 * 源文件删除/不可 stat 时**仍命中既有缓存**（不因瞬时不可读把已加载规则打回常量——
 * 缓存测试断言此项），未命中才现场读并回退。
 * @param {{path?: string}} [opts] 显式路径（缺省尊重 `WF_INCIDENT_RULES_PATH`，再缺省默认表）
 * @returns {object} 规则表视图（含 ok/degraded）
 */
export function loadRules(opts = {}) {
  const path = resolveRulesPath(opts);
  let signature;
  try {
    const st = statSync(path);
    signature = `${st.mtimeMs}:${st.size}`;
  } catch {
    signature = null;
  }
  const cached = RULES_CACHE.get(path);
  if (cached && (signature === null || cached.signature === signature)) return cached.view;
  if (signature === null) return builtinFallback(); // 无缓存且不可 stat：保守回退（不缓存掉退态）
  const view = readRulesView(path);
  RULES_CACHE.set(path, { signature, view });
  return view;
}

/**
 * 单次读取＋结构校验（loadRules 的读面；缓存由调用方持有）。
 * @param {string} path 规则表路径
 * @returns {object} 规则表视图
 */
function readRulesView(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return builtinFallback();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return builtinFallback();
  }
  if (!data || typeof data !== 'object') return builtinFallback();
  if (data.schemaVersion !== 1) return builtinFallback();
  if (!Number.isFinite(data.rulesVersion)) return builtinFallback();
  if (!Array.isArray(data.rules)) return builtinFallback();
  if (!Array.isArray(data.causes) || !Array.isArray(data.severities)) return builtinFallback();
  return {
    ok: true,
    degraded: false,
    rulesVersion: data.rulesVersion,
    rules: data.rules,
    replayableErrorCodes: Array.isArray(data.replayableErrorCodes) ? data.replayableErrorCodes : [],
    causes: data.causes,
    severities: data.severities,
    pendingCauses: Array.isArray(data.pendingCauses) ? data.pendingCauses : [...PENDING_CAUSES],
    evidenceCauses: Array.isArray(data.evidenceCauses) ? data.evidenceCauses : [...EVIDENCE_CAUSES],
  };
}

/** 读取 fact 的字符串字段（非字符串按空串，防类型漂移）。 */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * 单条件匹配：数组表示命中其一；字符串表示命中 rules.replayableErrorCodes（哨兵引用）。
 * @param {unknown} cond 规则 match 值
 * @param {string} value fact 值
 * @param {object} rules 规则表视图
 * @returns {boolean}
 */
function matchCond(cond, value, rules) {
  if (Array.isArray(cond)) return value !== '' && cond.includes(value);
  if (typeof cond === 'string' && cond === 'replayableErrorCodes') {
    return value !== '' && rules.replayableErrorCodes.includes(value);
  }
  return false;
}

/**
 * 分类单条观测事实。规则按表内顺序首个全条件命中生效；未命中→unclassified。
 * @param {object|null} fact 观测事实（kind/errorClass/errorCode/host/...）
 * @param {object} [rules] loadRules() 结果（缺省现场加载）
 * @returns {{cause: string, severity: string, ruleId: string, rulesVersion: number}}
 */
export function classifyFact(fact, rules = loadRules()) {
  if (!fact || typeof fact !== 'object') {
    return { cause: 'unclassified', severity: 'warn', ruleId: 'r-fallback-null', rulesVersion: rules.rulesVersion ?? 0 };
  }
  for (const rule of rules.rules ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    const match = rule.match && typeof rule.match === 'object' ? rule.match : {};
    let hit = true;
    for (const key of Object.keys(match)) {
      if (!matchCond(match[key], str(fact[key]), rules)) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const cause = CAUSES.includes(rule.cause) ? rule.cause : 'unclassified';
    const severity = SEVERITIES.includes(rule.severity) ? rule.severity : 'warn';
    return { cause, severity, ruleId: str(rule.id) || 'rule-unnamed', rulesVersion: rules.rulesVersion ?? 0 };
  }
  return { cause: 'unclassified', severity: 'warn', ruleId: 'r-fallback-unmatched', rulesVersion: rules.rulesVersion ?? 0 };
}
