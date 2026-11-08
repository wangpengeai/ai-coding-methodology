// 文件：strategies/degrade.mjs
// 描述：degrade 族策略执行器（内部决策-037 决策 2，一族一文件）——超时封顶降级 fail-open，两级派生：
//       ①声明值 → 秒（缺失/非法取 defaultSeconds，夹 [minSeconds, maxSeconds]，cap='host-max'
//       时再以矩阵上限夹取）；②秒 → 子进程预算（秒*1000 − marginMs，下限 minBudgetMs）——
//       余量与下限正是为了让子钩子来得及回帧（既有实现同款两级算法）。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/** 取宿主上限（秒）：cap=host-max 时读矩阵 hook.timeout.maxSeconds[host]；不可得即 fail-closed
 *（门禁位声称 host-max 却拿不到上限 = 数据契约破裂，不得静默放弃封顶）。 */
const hostMaxSeconds = (env, hp) => {
  if (hp.cap !== 'host-max') throw new Error(`timeout-cap-fail-open: 不支持的 cap ${String(hp.cap)}（合法：host-max）`);
  const row = env.matrix && Object.hasOwn(env.matrix, 'hook.timeout.maxSeconds') ? env.matrix['hook.timeout.maxSeconds'] : null;
  const value = row && typeof row === 'object' ? row[env.host] : null;
  if (!Number.isFinite(value)) {
    throw new Error(`timeout-cap-fail-open: 矩阵缺 hook.timeout.maxSeconds[${env.host}]（cap=host-max 门禁位不可得，fail-closed）`);
  }
  return value;
};

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'timeout-cap-fail-open': (env, hp) => {
    const declaredMs = Number.isFinite(env.context.declaredTimeoutMs) && env.context.declaredTimeoutMs > 0 ? env.context.declaredTimeoutMs : null;
    let timeoutSeconds = declaredMs === null ? hp.defaultSeconds : Math.floor(declaredMs / 1000);
    timeoutSeconds = Math.min(Math.max(timeoutSeconds, hp.minSeconds), hp.maxSeconds); // 夹取
    const cap = hostMaxSeconds(env, hp); // 门禁位不可得即 fail-closed 抛错（不静默不封顶）
    timeoutSeconds = Math.min(timeoutSeconds, cap); // 宿主上限封顶
    const childBudgetMs = Math.max(hp.minBudgetMs, timeoutSeconds * 1000 - hp.marginMs); // 余量 + 下限
    return { timeoutSeconds, childBudgetMs, onTimeout: hp.onTimeout };
  },
};
