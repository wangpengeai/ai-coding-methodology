// 文件：incident-fact.mjs
// 描述：内部模块-15 v2 ObservationFact 归一与字段白名单（内部规则-2/内部规则-13、内部决策-063 D2、内部接口-26）——
//       两条写入路径共用的**事实面**单一实现：适配层 `incident-cli emit`（外部上报）与
//       捕获钩 `post-tool.mjs`（宿主事件）。为什么单点：脱敏白名单、必填项、派发事实三态若
//       两处各写一份，必然漂移出「一条路径能夹带原文、另一条不能」的破口（B-M15-1）。
//       脱敏纪律：入参只接受**结构化事实**（类别名/数字/短标识），命令/路径/stdio/错误原文
//       一律**整单拒绝**（不是过滤——过滤会静默丢字段，拒收让调用方立即发现）。
//       本模块零 IO、零副作用（纯归一/校验）；派发事实三态与失败判据的 `unknown` 缺省同源。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 用法：被 incident-cli.mjs（emit）与 hooks/post-tool.mjs 消费。
import { digestOf } from './incident-store.mjs';

/**
 * emit 入参白名单（内部接口-26 §2）：仅这些键被接受，其余一律整单拒绝。
 * 必填＝schemaVersion/kind/observationSource/ts（id 缺省派生，见 {@link deriveEmitId}）。
 */
export const EMIT_FIELD_WHITELIST = Object.freeze([
  'schemaVersion',
  'kind',
  'tool',
  'event',
  'errorClass',
  'errorCode',
  'exitCode',
  'session',
  'taskId',
  'skill',
  'plugin',
  'host',
  'dispatchFact',
  'delegationDepth',
  'parentSession',
  'observationSource',
  'id',
  'ts',
  'digest',
  'count',
  'note',
]);

/** 必填键（id 可缺省派生；ts 必须由调用方给出——核心不替调用方编造观测时刻）。 */
export const EMIT_REQUIRED_FIELDS = Object.freeze(['schemaVersion', 'kind', 'observationSource', 'ts']);

/** emit 可接受的 kind（内部接口-26 §2：适配层只上报核心无法自行观测的两类事实）。 */
export const EMIT_KINDS = Object.freeze(['hook-failure', 'observation-degraded']);

/** 派发事实三态（内部规则-1：DSH 仅在已派发时透传失败位；缺省 unknown）。 */
export const DISPATCH_FACTS = Object.freeze(['dispatched', 'not-dispatched', 'unknown']);

/** 短串字段的长度上限（观测事实是标识与类别，不是正文）。 */
const SHORT_STRING_MAX = 120;
/** observationSource 形态（如 `adapter:dsh` / `hook:post-tool`）。 */
const SOURCE_RE = /^[A-Za-z][A-Za-z0-9:._-]{0,59}$/;
/**
 * token 白名单（评审修复 N3）：`note/tool/event/plugin/errorClass/errorCode/skill/host/digest`
 * 是**类别/标识**，不是自由文本——含空格/中文/引号等即视为夹带原文而整单拒绝。
 * 与短串上限互补：长度挡不住「短原文」（如 `rm -rf /` 只有 9 字符）。
 */
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9+_.:/-]{0,79}$/;
/**
 * 记录 id 形态白名单（评审修复 B1）：账本 id 是**文件名成分**（promote 草案
 * `<ts>-<id>.md`）与幂等键——必须禁 `/`、`\`、`..` 与空白，长度 1..64。
 * 派生 id（`emit-<16hex>`）与既有写入方 id（`tf-…`/`uc-…`/`ld-…`/`ll-…`/`rl-…`）均在该形态内。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * 记录 id 合法性（单源）：emit 入参校验与 promote 产物文件名净化共用同一口径，
 * 防「校验写了、净化漏了」的双实现漂移（路径越界防线只有一处才可靠）。
 * @param {unknown} v 候选 id
 * @returns {boolean}
 */
export function isValidIncidentId(v) {
  if (typeof v !== 'string' || v === '' || v.length > 64) return false;
  if (v.includes('..')) return false;
  return ID_RE.test(v);
}

/**
 * 派发事实归一（三态）：只认 `dispatched`/`not-dispatched`；其它（缺省、非法形态）一律
 * `unknown`——不得把未知当已派发（宁漏不误报，内部规则-1 判据纪律）。
 * @param {unknown} raw 负载字段（snake/camel 由调用方先取）
 * @returns {'dispatched'|'not-dispatched'|'unknown'}
 */
export function normalizeDispatchFact(raw) {
  return raw === 'dispatched' || raw === 'not-dispatched' ? raw : 'unknown';
}

/** 非空短串判定。 */
function isShortString(v) {
  return typeof v === 'string' && v !== '' && v.length <= SHORT_STRING_MAX;
}

/**
 * emit id 派生（内部接口-26 §2）：调用方未给稳定 id 时按 `kind+event+分钟桶` 派生，
 * 读侧同 id 末条折叠给出分钟级幂等（同一分钟重复上报不刷屏）。
 * @param {object} fact 已校验事实
 * @param {number} now 派生时刻（缺省用 fact.ts）
 * @returns {string}
 */
export function deriveEmitId(fact, now) {
  const bucket = Math.floor((Number.isFinite(now) ? now : Number(fact.ts)) / 60000);
  return `emit-${digestOf(['emit', String(fact.kind), String(fact.event ?? ''), String(bucket)])}`;
}

/**
 * emit 载荷校验与归一（内部接口-26 §4 错误语义）：返回整单判定——任一不满足即
 * `{ok:false, reason}`（调用方 exit 1），绝不落半条。
 * 脱敏边界的实现＝**白名单**：命令/路径/stdout/stderr/错误消息等原文键不在白名单内，
 * 故「夹带原文」表现为「白名单外键」而整单拒绝（含错别字键，不静默丢弃）。
 * @param {unknown} payload stdin 解析后的对象
 * @returns {{ok: true, fact: object} | {ok: false, reason: string}}
 */
export function validateEmitPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: '载荷须为单个 JSON 对象' };
  const extra = Object.keys(payload).filter((k) => !EMIT_FIELD_WHITELIST.includes(k));
  if (extra.length > 0) return { ok: false, reason: `白名单外键拒收：${extra.slice(0, 5).join('、')}` };
  for (const key of EMIT_REQUIRED_FIELDS) {
    if (!Object.hasOwn(payload, key)) return { ok: false, reason: `缺必填键：${key}` };
  }
  if (payload.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion 须为 1' };
  if (!EMIT_KINDS.includes(payload.kind)) return { ok: false, reason: `kind 非法：${String(payload.kind)}（允许 ${EMIT_KINDS.join('|')}）` };
  if (typeof payload.observationSource !== 'string' || !SOURCE_RE.test(payload.observationSource)) {
    return { ok: false, reason: 'observationSource 须为短标识（如 adapter:dsh / hook:post-tool）' };
  }
  const ts = typeof payload.ts === 'number' ? payload.ts : typeof payload.ts === 'string' ? Date.parse(payload.ts) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, reason: 'ts 须为毫秒数或可解析 ISO 时间' };
  // 评审修复 B1：id 是幂等键与文件名成分——白名单外形态整单拒绝（不静默替换成派生 id：
  // 那会让调用方的幂等假设失效——它以为记的是自己的 id）。
  if (Object.hasOwn(payload, 'id') && !isValidIncidentId(payload.id)) {
    return { ok: false, reason: 'id 须为 1..64 位标识（禁 / \\ .. 与空白）' };
  }
  for (const key of ['tool', 'event', 'errorClass', 'errorCode', 'skill', 'host', 'digest', 'note', 'plugin']) {
    if (!Object.hasOwn(payload, key)) continue;
    if (typeof payload[key] !== 'string' || !TOKEN_RE.test(payload[key])) {
      return { ok: false, reason: `${key} 须为 token 形态（字母开头的标识/类别，禁空格与原文）` };
    }
  }
  // session/taskId/parentSession 是外部赋予的标识（可能以数字/下划线开头），只做短串上限
  for (const key of ['session', 'taskId', 'parentSession']) {
    if (Object.hasOwn(payload, key) && !isShortString(payload[key])) {
      return { ok: false, reason: `${key} 须为非空短串（≤${SHORT_STRING_MAX} 字符）` };
    }
  }
  if (Object.hasOwn(payload, 'dispatchFact') && !DISPATCH_FACTS.includes(payload.dispatchFact)) {
    return { ok: false, reason: `dispatchFact 非法：${String(payload.dispatchFact)}（允许 ${DISPATCH_FACTS.join('|')}）` };
  }
  if (Object.hasOwn(payload, 'exitCode') && payload.exitCode !== null && !Number.isFinite(payload.exitCode)) {
    return { ok: false, reason: 'exitCode 须为数字或 null' };
  }
  if (Object.hasOwn(payload, 'count') && !Number.isFinite(payload.count)) return { ok: false, reason: 'count 须为数字' };
  if (Object.hasOwn(payload, 'delegationDepth') && !(Number.isSafeInteger(payload.delegationDepth) && payload.delegationDepth >= 0)) {
    return { ok: false, reason: 'delegationDepth 须为非负整数' };
  }
  const fact = { ...payload, schemaVersion: 1, ts };
  if (Object.hasOwn(fact, 'dispatchFact')) fact.dispatchFact = normalizeDispatchFact(fact.dispatchFact);
  // 内部任务-244 Q08：删除无调用方 `{now}` 可选参数——派生时刻恒用 fact.ts（deriveEmitId 缺省）。
  if (!isShortString(fact.id)) fact.id = deriveEmitId(fact);
  return { ok: true, fact };
}

/**
 * 捕获钩事实归一（post-tool 与 emit 共用字段语汇）：把宿主负载里的**结构化事实**投影成
 * 分类规则表的输入面——只保留判据/分类需要的字段，不夹带 `tool_input`/`tool_result` 原文。
 * @param {{toolName?: string, sessionId?: string, host?: string, taskId?: string|null, skill?: string|null,
 *          parsed?: object, classified?: object|null}} arg
 * @returns {object} ObservationFact（扁平，供 classifyFact 消费）
 */
export function factFromToolPayload({ toolName = '', sessionId = '', host = '', taskId = null, skill = null, parsed = {}, classified = null } = {}) {
  const depth = parsed?.delegation_depth ?? parsed?.delegationDepth;
  const parent = parsed?.parent_session_id ?? parsed?.parentSessionId;
  const fact = {
    // 内部决策-063 修正案 3 决策 24.1（内部任务-195）：删除无调用默认分支（原 `classified ? 'tool-failure'
    // : 'observation'`）——唯一调用方恒在失败分类命中时调用；无分类分支从未被生产触达。
    kind: 'tool-failure',
    tool: String(toolName ?? ''),
    session: String(sessionId ?? ''),
    host: String(host ?? ''),
    taskId: taskId == null ? '' : String(taskId),
    skill: skill == null ? '' : String(skill),
    dispatchFact: normalizeDispatchFact(parsed?.dispatch_fact ?? parsed?.dispatchFact),
    observationSource: 'hook:post-tool',
  };
  if (classified) {
    fact.errorClass = String(classified.errorClass ?? '');
    fact.exitCode = classified.exitCode == null ? '' : String(classified.exitCode);
    if (typeof classified.errorCode === 'string' && classified.errorCode) fact.errorCode = classified.errorCode;
  }
  if (Number.isSafeInteger(depth) && depth > 0) fact.delegationDepth = depth;
  if (typeof parent === 'string' && parent) fact.parentSession = parent;
  return fact;
}
