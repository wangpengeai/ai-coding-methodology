// 文件：provenance-fixtures.mjs
// 描述：内部任务-191 测试夹具——构造 code-review receipt 的实例 provenance JSON（fresh/reused/rehydrated），
//       供 receipts/gate/cli/delivery 测试统一注入，避免约 40 处调用点各自内联 JSON。
//       契约（D3/D6）：条目 {role, instance, chain, state, note?, crossStage?}——**crossStage 仅 receipt**；
//       plan-review sidecar 的 reviewProvenance 不含该字段（routing-lib 整字段拒，内部模块-3 内部规则-16）。
//       chain=task:<taskId>；countable=fresh|reused；round=1 全 fresh；同凭据 role/instance 唯一。
// 作者：wangp  创建：2026-10-21  版权：MIT（见 spec-gate/LICENSE）

/**
 * 生成 provenance 数组。
 * @param {string} taskId 任务号（链身份 task:<taskId>）
 * @param {number} count 条目数
 * @param {{round?: number, state?: string, roles?: string[], instances?: string[]}} [o]
 *   round=1 时强制 state=fresh（契约）；state 仅 round>1 可覆盖为 reused/rehydrated。
 * @returns {Array<{role:string, instance:string, chain:string, state:string}>}
 */
export function prov(taskId, count, { round = 1, state = 'fresh', roles = null, instances = null } = {}) {
  const chain = `task:${taskId}`;
  const effectiveState = round === 1 ? 'fresh' : state;
  const rolesArr = roles ?? Array.from({ length: count }, (_, i) => (i === 0 ? 'engineering' : `role-${i + 1}`));
  return rolesArr.map((role, i) => ({
    role,
    instance: instances?.[i] ?? `prov-inst-${i + 1}`,
    chain,
    state: effectiveState,
  }));
}

/** 生成 provenance 的单行 JSON 字符串（CLI 参数/测试夹具共用）。 */
export function provJson(taskId, count, o = {}) {
  return JSON.stringify(prov(taskId, count, o));
}
