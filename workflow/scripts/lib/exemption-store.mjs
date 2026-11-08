// 文件：exemption-store.mjs
// 描述：任务租约豁免/退役审计存储库（内部决策-020/内部决策-067 / 内部接口-20 schemaVersion 2）——
//       项目根 内部工作流状态 的追加单一事实源。写路径取 O_APPEND 单行
//       追加（与 incident-store 同族并发口径：不做读改写）；同 id 幂等去重与坏行容忍
//       都在读侧（同 id 以文件末条为准）。
//       契约约束：审计轨迹须活得比租约文件久——task-lease-lib 的 token 桶内轮换即删
//       （issueChallenge 直接删 active-<token>），本文件是唯一持久豁免记录，租约消失
//       后豁免仍须可复核（内部规格）。
//       记录字段：schemaVersion/id/ts/taskId/skill/src/reason/scope/planPath?/digest；
//       scope ∈ plan|review|revoked（revoked 仅 recordExemptionRevocation 写）；
//       src ∈ user|preauthorized；reason 为逐字引文/撤销原话（库自身 trim 后落盘）；
//       digest=sha256(taskId|reason) 前 12 位；id=ex-<digest>。
//       失败语义：返回 {ok:false,error} 并由调用方按 内部决策-067 D5.4 定向处理——
//       豁免声明 fail-closed（释放租约+exit 1），退役声明只 warning。
// 作者：wangp  创建：2026-09-14  版权：MIT（见 workflow/LICENSE）
// 注入缝：WF_EXEMPTIONS_ROOT（覆盖 root 推导——测试隔离与诊断用）。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXEMPT_SOURCES } from '../../hooks/task-lease-lib.mjs';
import {
  EXEMPT_SCOPES,
  checkExemptRevokeQuote,
  exemptionRecordDigest,
} from './exempt-protocol.mjs';

/**
 * 生效根：环境注入缝优先（测试隔离），否则用调用方显式 root。
 * @param {string} root
 * @returns {string}
 */
function effectiveRoot(root) {
  return process.env.WF_EXEMPTIONS_ROOT ?? String(root ?? '.');
}

/**
 * 审计文件路径（项目根/内部工作流状态，运行态、gitignore）。
 * @param {string} root
 * @returns {string}
 */
export function exemptionsFile(root) {
  return join(effectiveRoot(root), '.workflow', 'wf-exemptions.jsonl');
}

/** 失败返回对象（唯一调用方据此 fail-closed/warning；stderr 保留可诊断）。 */
function fail(msg) {
  process.stderr.write(`exemption-store：${msg}\n`);
  return { ok: false, error: msg };
}

/** 项目根相对 POSIX 路径守卫（review scope 的 planPath）。 */
function isSafePlanPath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const value = p.trim();
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

/** 追加一行 JSON 记录（O_APPEND）；写失败返回对象，不抛。 */
function appendRecord(root, line) {
  try {
    const file = exemptionsFile(root);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return { ok: true, id: line.id, digest: line.digest };
  } catch (e) {
    return fail(`写盘失败（${e.message}）`);
  }
}

/**
 * 追加一条豁免审计记录（schemaVersion 2）：scope=plan|review；reason 逐字引文。
 * @param {string} root 项目根
 * @param {{taskId:string, reason:string, src:string, scope:string, planPath?:string, skill?:string|null}} rec
 * @returns {{ok:true,id:string,digest:string} | {ok:false,error:string}}
 */
export function recordExemption(root, rec) {
  if (!rec || typeof rec !== 'object') return fail('记录缺失');
  const taskId = typeof rec.taskId === 'string' ? rec.taskId.trim() : '';
  if (!taskId) return fail('taskId 缺失');
  const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
  if (!reason) return fail('reason 缺失');
  if (!EXEMPT_SCOPES.includes(rec.scope)) {
    return fail(`scope 非法（收到「${String(rec.scope)}」，合法取值 ${EXEMPT_SCOPES.join('|')}）`);
  }
  if (!EXEMPT_SOURCES.includes(rec.src)) {
    return fail(`src 非法（收到「${String(rec.src)}」，合法取值 ${[...EXEMPT_SOURCES].join('|')}）`);
  }
  const planPath = typeof rec.planPath === 'string' ? rec.planPath.trim() : undefined;
  if (rec.scope === 'review') {
    if (!isSafePlanPath(planPath)) {
      return fail('scope=review 必须提供项目根相对 POSIX 的 planPath（存在性由声明侧校验）');
    }
  } else if (planPath !== undefined) {
    return fail('scope=plan 不得携带 planPath');
  }
  const digest = exemptionRecordDigest(taskId, reason);
  const line = {
    schemaVersion: 2,
    id: `ex-${digest}`,
    ts: Date.now(),
    taskId,
    skill: typeof rec.skill === 'string' ? rec.skill : null,
    src: rec.src,
    reason,
    scope: rec.scope,
    ...(planPath !== undefined ? { planPath } : {}),
    digest,
  };
  return appendRecord(root, line);
}

/**
 * 追加一条用户显式退役记录（schemaVersion 2，scope=revoked，src=user|preauthorized）。
 * @param {string} root
 * @param {{taskId:string, reason:string, src:string}} rec
 * @returns {{ok:true,id:string,digest:string} | {ok:false,error:string}}
 */
export function recordExemptionRevocation(root, rec) {
  if (!rec || typeof rec !== 'object') return fail('退役记录缺失');
  const taskId = typeof rec.taskId === 'string' ? rec.taskId.trim() : '';
  if (!taskId) return fail('taskId 缺失');
  const quote = checkExemptRevokeQuote(rec.reason);
  if (!quote.ok) return fail(quote.reason);
  if (!EXEMPT_SOURCES.includes(rec.src)) {
    return fail(`src 非法（收到「${String(rec.src)}」，合法取值 ${[...EXEMPT_SOURCES].join('|')}）`);
  }
  const digest = exemptionRecordDigest(taskId, quote.quote);
  const line = {
    schemaVersion: 2,
    id: `ex-${digest}`,
    ts: Date.now(),
    taskId,
    skill: 'plan-execution',
    src: rec.src,
    reason: quote.quote,
    scope: 'revoked',
    digest,
  };
  return appendRecord(root, line);
}
