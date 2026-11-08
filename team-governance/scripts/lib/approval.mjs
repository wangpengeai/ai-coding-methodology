// 文件：approval.mjs
// 描述：内容绑定 Approval（内部规则-3 / 内部接口-16 / 内部决策-014）——审批绑定 subjectDigest
//       组合（changeSet digest+repo diff hash+policy digest+approval profile+eval suite），
//       对象变即失效；高风险禁自批；strict 拒未验证身份；条件批准≠通过。
//       内部任务-254 批 2（H2/H4/H6）：expiresAt 严格 YYYY-MM-DD 且真实日期（比较用字符串，
//       非补零/不存在日期一律无效）；同身份比较对 unknown/空串不命中（无值语义）；
//       自批只在 requestedBy 有效时判定；按 approvalId 折叠（数组序后者覆盖前者，
//       revocation 记录覆盖同 ID 前项并视为已撤销）——单源折叠实现供 gate/store 共用。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { randomUUID } from 'node:crypto';

import { integrityHash } from './canonical-json.mjs';

const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * expiresAt 严格日期校验（内部接口-16，H6）：`YYYY-MM-DD` 且为真实日期
 * （2026-13-01 / 2026-02-30 一律非法）。合法形态可直接字符串比较。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidExpiresAt(value) {
  if (typeof value !== 'string' || !EXPIRES_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 身份是否可作为归属值（H2 无值语义）：非字符串/空串/空白/`unknown`（大小写不敏感）均视为无值。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsableIdentity(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v !== '' && v.toLowerCase() !== 'unknown';
}

/** 身份大小写不敏感比较（GitHub login 不区分大小写——评审 C7 处置③）；单侧无值即不命中。 */
function sameIdentity(a, b) {
  return isUsableIdentity(a) && isUsableIdentity(b) && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 经验证身份源白名单（评审 C7 处置①：verified 布尔不可自证——strict 只认白名单源；
 * 本地 CLI 声明（source=local）永远不构成已验证身份，防 --verified 旗标自批）。
 * 2026-09-19 评审修复 H1：'oidc' 原误写为 ' oidc'（前导空格）——Set 精确匹配使 oidc
 * 源永拒，与 strict 拒绝消息承诺的白名单枚举相反；四源各有 strict 通过断言守卫。
 */
const VERIFIED_SOURCES = new Set(['github-review', 'sso', 'oidc', 'ci-signed']);

function isVerifiedIdentity(identity) {
  return Boolean(identity?.verified) && VERIFIED_SOURCES.has(identity?.source);
}

/**
 * 登记审批（含自批即时校验与 expiresAt 形态校验）。
 * @param {{subjectDigest: string, role: string, identity: {source: string, verified: boolean, id: string},
 *          decidedAt: string, expiresAt: string, conditions?: string[], revocation?: null}} record
 * @param {{executor?: string, highRisk?: boolean}} ctx
 * @returns {{ok: boolean, approval?: object, error?: string}}
 */
export function recordApproval(record, ctx) {
  if (!record.subjectDigest || !record.role || !record.identity || !record.expiresAt) {
    return { ok: false, error: '审批缺必填字段（subjectDigest/role/identity/expiresAt）' };
  }
  // H6：expiresAt 严格形态（参数错语义：调用方 CLI 映射为工具错退 2）
  if (!isValidExpiresAt(record.expiresAt)) {
    return { ok: false, error: `审批 expiresAt 形态非法（须真实 YYYY-MM-DD，收到「${String(record.expiresAt)}」）` };
  }
  if (ctx.highRisk && ctx.executor && sameIdentity(record.identity.id, ctx.executor)) {
    return { ok: false, error: `高风险变更禁止执行者自批（executor=${ctx.executor}）` };
  }
  const approval = {
    approvalId: `apr-${randomUUID().slice(0, 10)}`,
    ...record,
    conditions: record.conditions ?? [],
    revocation: record.revocation ?? null,
  };
  return { ok: true, approval };
}

/**
 * 按 approvalId 折叠审批记录（内部接口-16「折叠语义」单源实现，H4/D1）：
 * **approvals 数组序后者覆盖前者**；带 `revocation` 的记录覆盖同 approvalId 前项并视为已撤销。
 * 无 approvalId 的记录按独立项保留（坏件由 validateApproval 判无效，不静默丢弃）。
 * @param {Array<object>} records
 * @returns {Array<object>} 折叠后记录（保持首次出现顺序的键序）
 */
export function foldApprovals(records) {
  const order = [];
  const byId = new Map();
  let anon = 0;
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    const id = typeof r.approvalId === 'string' && r.approvalId ? r.approvalId : `__anon-${(anon += 1)}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, r); // 后者覆盖前者
  }
  return order.map((id) => byId.get(id));
}

/**
 * 校验审批对当前对象与策略是否有效。
 * 返回 `code` 供消费方分档（gate：self-approval 单列 blocking；其余 invalid 降 warning）。
 * @param {{subjectDigest: string, role: string, identity: {verified: boolean, source: string, id: string},
 *          expiresAt: string, conditions?: string[], revocation?: null}} approval
 * @param {{changeSetDigest: string, policyDigest?: string, policy: 'strict'|'relaxed',
 *          highRisk?: boolean, requestedBy?: string|null}} current
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
export function validateApproval(approval, current) {
  if (!approval || typeof approval !== 'object') return { ok: false, code: 'malformed', reason: '审批记录非法（非对象）' };
  if (approval.revocation) return { ok: false, code: 'revoked', reason: 'revoked' };
  // H6：expiresAt 严格形态（既存非补零记录一律无效——不是「解析容错」而是判无效）
  if (!isValidExpiresAt(approval.expiresAt)) {
    return { ok: false, code: 'expires-format', reason: `expiresAt 形态非法（须真实 YYYY-MM-DD，收到「${String(approval.expiresAt ?? '')}」）` };
  }
  // 对象 digest 失效：审批绑定的是提交时的对象组合，对象变即失效
  if (approval.subjectDigest !== current?.changeSetDigest) {
    return { ok: false, code: 'digest-drift',
      reason: `对象 digest 漂移（审批 ${String(approval.subjectDigest).slice(0, 16)}… vs 当前 ${String(current?.changeSetDigest).slice(0, 16)}…）` };
  }
  // 严格形态校验后可安全字符串比较（日粒度 UTC）
  if (approval.expiresAt < new Date().toISOString().slice(0, 10)) return { ok: false, code: 'expired', reason: '已过期' };
  if (current.policy === 'strict' && !isVerifiedIdentity(approval.identity)) {
    return { ok: false, code: 'unverified-identity', reason: 'strict 策略要求已验证身份源（白名单：github-review/sso/oidc/ci-signed；本地声明只算 local-attested）' };
  }
  // 内部任务-254（H2，「独立审批」定义）：身份不可归属（unknown/空）的审批不构成有效独立审批——
  // 否则 highRisk 自批可被一条匿名 approve 降档绕过（三维评审正确性阻塞 B1）。
  if (!isUsableIdentity(approval.identity?.id)) {
    return { ok: false, code: 'unattributed-identity', reason: '审批身份不可归属（unknown/空）——不构成有效独立审批，请用 --identity <id> 重新登记' };
  }
  // H2：自批只在 requestedBy 有效（非空/非 unknown）时判定
  if (current.highRisk && sameIdentity(approval.identity?.id, current.requestedBy)) {
    return { ok: false, code: 'self-approval', reason: '高风险变更不得由执行者自批' };
  }
  if ((approval.conditions ?? []).length > 0) {
    return { ok: false, code: 'conditions', reason: `条件批准未闭环（${approval.conditions.join('；')}）——条件须转 OPEN-n 或补新审批` };
  }
  return { ok: true };
}

