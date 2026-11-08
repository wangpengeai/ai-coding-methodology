// 文件：test-budget.mjs
// 描述：内部任务-311 F3/F5 测试夹具统一预算注入（单文件直跑）——把 git 预算 env 收敛到单点，
//       避免每个测试文件各写一份硬编码；与 release-suite envForScope（全量验证注入）同一 env 名、语义一致。
// 作者：wangp  创建：2026-11-04  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；不改生产缺省（未注入时库仍回落 800ms/1500ms）。

/** 写审计 git 预算 env 名（与 workflow/scripts/lib/write-audit.mjs 的 resolveBaselineBudget 同源）。 */
export const AUDIT_BUDGET_ENV = 'WF_WRITE_AUDIT_BASELINE_BUDGET_MS';

/**
 * 确保测试进程内预算 env 已设置（未设置才写，尊重外部显式注入）。
 * @param {number} value 默认 60000ms（满量并行下足够宽松，仅测试面）
 * @returns {number} 生效的预算毫秒数
 */
export function ensureAuditBudget(value = 60000) {
  const current = process.env[AUDIT_BUDGET_ENV];
  if (current === undefined || current === '') process.env[AUDIT_BUDGET_ENV] = String(value);
  return Number(process.env[AUDIT_BUDGET_ENV]);
}
