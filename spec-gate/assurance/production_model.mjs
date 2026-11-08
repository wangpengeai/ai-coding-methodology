// 文件：production_model.mjs
// 描述：production_model.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1b）——状态机/旁路、
//       事件信封 21 固定键＋extra、eventHash（去除自身的 canonical JSON）、waiver 五要素、
//       明文秘密五模式（与 team-governance redaction.mjs 跨语言镜像——三侧同义锚在
//       parity-production）、profile 形态校验。bug-for-bug 复刻；纯函数。
//       注入缝：buildEvent opts {uuidHex?, now?}（对拍/golden 固定注入——缺省走真实）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { randomUUID } from 'node:crypto';

import { canonicalJsonBytes, isCalendarDate, localToday, nowIso, sha256Hex } from './common.mjs';

/** Python ValueError 的 JS 实现（唯一实现；迁移史见 内部决策-051）错误类（CLI 退出码映射：1＝内容/政策阻断，门① B4）。 */
export class ProductionValueError extends Error {}

export const MAIN_CHAIN = [
  'draft', 'pr-open', 'merge-ready', 'merged', 'release-ready', 'released',
  'deploy-authorized', 'deployed', 'observing', 'accepted', 'closed',
];
export const BYPASS_STATES = new Set(['blocked', 'abandoned', 'rolled-back', 'temporary-mitigation']);
export const TERMINAL_STATES = new Set(['closed', 'abandoned', 'rolled-back']);
export const ALL_STATES = new Set([...MAIN_CHAIN, ...BYPASS_STATES]);

// 迁移表（构造序与 Python 侧一致——注释同源）
const TRANSITIONS = new Map();
for (let i = 0; i < MAIN_CHAIN.length - 1; i += 1) {
  if (!TRANSITIONS.has(MAIN_CHAIN[i])) TRANSITIONS.set(MAIN_CHAIN[i], new Set());
  TRANSITIONS.get(MAIN_CHAIN[i]).add(MAIN_CHAIN[i + 1]);
}
for (const s of MAIN_CHAIN) {
  if (s !== 'accepted' && s !== 'closed') {
    if (!TRANSITIONS.has(s)) TRANSITIONS.set(s, new Set());
    TRANSITIONS.get(s).add('blocked');
  }
}
const PRE_DEPLOY = new Set(MAIN_CHAIN.slice(0, MAIN_CHAIN.indexOf('deploy-authorized') + 1));
for (const s of PRE_DEPLOY) {
  if (!TRANSITIONS.has(s)) TRANSITIONS.set(s, new Set());
  TRANSITIONS.get(s).add('abandoned');
}
const POST_DEPLOY = new Set(MAIN_CHAIN.slice(MAIN_CHAIN.indexOf('deployed')).filter((s) => s !== 'closed'));
for (const s of POST_DEPLOY) {
  if (!TRANSITIONS.has(s)) TRANSITIONS.set(s, new Set());
  TRANSITIONS.get(s).add('rolled-back');
  TRANSITIONS.get(s).add('temporary-mitigation');
}
for (const s of MAIN_CHAIN.slice(0, -2)) {
  if (!TRANSITIONS.has('blocked')) TRANSITIONS.set('blocked', new Set());
  TRANSITIONS.get('blocked').add(s);
}
if (!TRANSITIONS.has('temporary-mitigation')) TRANSITIONS.set('temporary-mitigation', new Set());
TRANSITIONS.get('temporary-mitigation').add('rolled-back');
TRANSITIONS.get('temporary-mitigation').add('observing');
TRANSITIONS.set('', new Set(['draft'])); // 创世（sequence=1：from_state="" → draft）

/**
 * 状态迁移合法性（不含 blocked/temporary 恢复目标合法性——那需要事件上下文）。
 * @param {string} frm @param {string} to @returns {boolean}
 */
export function transitionLegal(frm, to) {
  if (TERMINAL_STATES.has(frm)) return false;
  return (TRANSITIONS.get(frm) ?? new Set()).has(to);
}

/** @param {string} v 8-hex 段（缺省 uuid4 前 8——与 Python uuid.uuid4().hex[:8] 同源形态）。 */
function uuid8(opts) {
  if (opts?.uuidHex) return opts.uuidHex;
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

/**
 * 构造完整事件并计算 eventHash（对去除自身哈希、含 extra 合并的全部键 canonical JSON）。
 * @param {object} args 19 个具名字段（对齐 build_event 关键字参）
 * @param {{uuidHex?: string, now?: string}} [opts] 注入缝（golden/parity 固定——缺省真实）
 * @returns {Record<string, unknown>}
 */
export function buildEvent(args, opts = {}) {
  const payload = {
    schemaVersion: '1.0.0',
    changeId: args.changeId,
    sequence: args.sequence,
    eventId: `${args.changeId}-e${args.sequence}-${uuid8(opts)}`,
    previousEventHash: args.previousEventHash ?? null,
    fromState: args.fromState,
    toState: args.toState,
    occurredAt: opts.now ?? nowIso(),
    taskId: args.taskId,
    profileId: args.profileId,
    profileDigest: args.profileDigest,
    sourceRevision: args.sourceRevision,
    commitSha: args.commitSha,
    artifactDigest: args.artifactDigest ?? null,
    environment: args.environment,
    evidenceRefs: args.evidenceRefs,
    notApplicable: args.notApplicable ?? [],
    waiverRefs: args.waiverRefs ?? [],
    incidentRef: args.incidentRef ?? null,
    actorRef: args.actorRef,
  };
  if (args.extra) Object.assign(payload, args.extra);
  payload.eventHash = `sha256:${sha256Hex(canonicalJsonBytes(payload))}`;
  return payload;
}

/**
 * 重算事件哈希比对（防篡改）。
 * @param {Record<string, unknown>} event @returns {boolean}
 */
export function verifyEventHash(event) {
  const recorded = event.eventHash;
  if (typeof recorded !== 'string') return false;
  const body = Object.fromEntries(Object.entries(event).filter(([k]) => k !== 'eventHash'));
  return `sha256:${sha256Hex(canonicalJsonBytes(body))}` === recorded;
}

// 明文秘密五模式（与 redaction.mjs/production_model.py 三侧跨语言镜像——JS 用 i 旗承载 re.I）。
// Python `\s` 集合与 JS 原生 `\s` 不等价（Python 含 U+001C-U+001F/U+0085、不含 U+FEFF），
// 故显式构造 Python 同义空白类（门① N2；三侧锚在 parity-production 用常规输入钉）。
const PY_WS_CLASS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS = `[${PY_WS_CLASS}]`;
const NON_WS = `[^${PY_WS_CLASS}]`;
const SECRET_PATTERNS = [
  [new RegExp(`(?:token|secret|password|passwd|api[_-]?key)${WS}*[=:]${WS}*${NON_WS}{6,}`, 'i'), '凭据键值对'],
  // S04（内部任务-241）：URL 内嵌凭据（https://user:pass@host）——内部规则-5 不可豁免底线族补齐。
  [new RegExp(`${NON_WS}+://${NON_WS}+:${NON_WS}+@`, 'i'), 'URL 凭据'],
  [/AKIA[0-9A-Z]{16}/, 'AWS AccessKey'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥块'],
  [new RegExp(`Authorization:${WS}*(?:Bearer${WS}+)?[A-Za-z0-9._-]{8,}`, 'i'), '授权头'],
  // S04：裸 Bearer（无 Authorization 前缀也会泄露）——定长 lookbehind 排除已由「授权头」
  // 命中过的 `Authorization: Bearer` 形态，避免同一凭据重复计数。
  [new RegExp(`(?<!Authorization: )Bearer${WS}+[A-Za-z0-9._-]{8,}`, 'i'), '裸 Bearer'],
  // S04：gh[pousr]_ 全前缀（gho_/ghu_/ghs_/ghr_ 与 ghp_ 同族）。
  [/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, '裸令牌前缀'],
];

/**
 * 递归扫描事件/证据内的明文秘密模式，返回命中描述（`label: 前 24 字符…`）。
 * 截断按**码点**（Python `str[:24]` 语义；JS slice 是 UTF-16 码元——门① N2）。
 * @param {unknown} obj @returns {string[]}
 */
export function scanSecrets(obj) {
  const hits = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const [pattern, label] of SECRET_PATTERNS) {
        const m = pattern.exec(node);
        if (m) hits.push(`${label}: ${[...m[0]].slice(0, 24).join('')}…`);
      }
    } else if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const v of Object.values(node)) walk(v);
    } else if (Array.isArray(node)) {
      for (const v of node) walk(v);
    }
  };
  walk(obj);
  return hits;
}

const WAIVER_KEYS = ['authority', 'scope', 'expiresAt', 'alternativeVerification', 'residualRisk'];

/**
 * waiver 合法性：五要素齐备＋未过期（date-only 比较）＋scope 整词覆盖。
 * @param {Record<string, unknown>} waiver @param {string} changeId @param {string} environment
 * @returns {[boolean, string]}
 */
export function validateWaiver(waiver, changeId, environment) {
  for (const key of WAIVER_KEYS) {
    // Python `str(waiver.get(key, ""))`：键缺失→""（空）；显式 null→"None"（非空，视为已提供）。
    // JS 直接 String(undefined) 得 "undefined"，故先分流 undefined（门① N1）。
    const raw = waiver?.[key];
    const value = raw === undefined ? '' : String(raw);
    if (!value.trim()) return [false, `waiver 缺 ${key}`];
  }
  const expiresAt = String(waiver.expiresAt);
  if (!isCalendarDate(expiresAt)) return [false, 'waiver expiresAt 非法日期'];
  if (expiresAt < localToday()) return [false, 'waiver 已过期'];
  const scope = String(waiver.scope);
  const coveredChanges = new Set();
  const coveredEnvs = new Set();
  for (const tok0 of scope.replaceAll('|', ',').replaceAll(';', ',').split(',')) {
    const tok = tok0.trim();
    if (tok === '') continue;
    if (tok.includes('/')) {
      const slash = tok.indexOf('/');
      coveredEnvs.add(tok.slice(slash + 1).trim());
      coveredChanges.add(tok.slice(0, slash).trim());
    } else {
      coveredChanges.add(tok);
    }
  }
  if (!coveredChanges.has(changeId)) {
    return [false, `waiver scope 不含当前变更（${changeId}；scope 整词集=${[...coveredChanges].sort()}）`];
  }
  if (environment && !coveredEnvs.has(environment) && !coveredChanges.has(environment)) {
    return [false, `waiver scope 不含当前环境（${environment}；须以 <CHG>/<环境> 或环境整词声明）`];
  }
  return [true, 'ok'];
}

export const PROFILE_REQUIRED_FIELDS = [
  'schemaVersion', 'deliveryKind', 'distribution', 'scm', 'environments', 'exposure',
  'dataClasses', 'secretUse', 'persistentState', 'availabilityTier', 'recoveryTier',
  'acceptanceAuthority', 'evidenceMaxAgeHours', 'vulnerabilityPolicy', 'requiredApprovals',
];
export const VALID_DELIVERY_KINDS = new Set(['none', 'library', 'package', 'plugin', 'service', 'web', 'mobile', 'desktop', 'data-pipeline', 'infrastructure']);

/**
 * profile 必填字段与枚举校验；缺项即配置错误（无 profile 不猜——内部决策-010）。
 * @param {unknown} profile @returns {[boolean, string]}
 */
export function validateProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return [false, 'profile 不是对象'];
  const missing = PROFILE_REQUIRED_FIELDS.filter((f) => !(f in profile));
  if (missing.length > 0) return [false, `profile 缺必填字段：${missing.join(', ')}`];
  if (!VALID_DELIVERY_KINDS.has(profile.deliveryKind)) return [false, `deliveryKind 非法：${profile.deliveryKind}`];
  if (profile.scm === null || typeof profile.scm !== 'object' || Array.isArray(profile.scm) || !('prRequired' in profile.scm)) {
    return [false, 'scm 段缺 prRequired'];
  }
  return [true, 'ok'];
}
