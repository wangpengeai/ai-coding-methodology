// 文件：strategies/normalize.mjs
// 描述：normalize 族策略执行器（内部决策-037 决策 2，一族一文件）——会话来源归一取宽（判据集 =
//       params.accepted，即**下游 matcher 四词域**；宿主自身词表（可能含额外词）不作判据，
//       故额外词也归一）、失败事件合并（目标事件名 + 按 synthesize 清单合成 tool_result +
//       constants 常量位透传，如恒空串 stderr）。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'source-widen-normalize': (env, hp) => {
    const source = typeof env.context.source === 'string' ? env.context.source : '';
    // 判据集 = 下游 matcher 域（params.accepted 声明），**不是**矩阵 session.sources[host]——
    // 后者描述宿主自身词表（可能含额外词），本策略判定的却是「能否被既有 matcher 词表命中」。
    const accepted = Array.isArray(hp.accepted) ? hp.accepted : [];
    return accepted.includes(source) ? source : hp.to;
  },

  'failure-event-merge': (env, hp) => {
    const ctx = env.context ?? {};
    const synthesize = Array.isArray(hp.synthesize) ? hp.synthesize : [];
    const toolResult = {};
    if (synthesize.includes('is_error')) toolResult.is_error = ctx.isError === true;
    if (synthesize.includes('exit_code') && Number.isFinite(ctx.exitCode)) toolResult.exit_code = ctx.exitCode;
    if (synthesize.includes('stdout')) toolResult.stdout = typeof ctx.text === 'string' ? ctx.text : '';
    if (hp.constants && typeof hp.constants === 'object') Object.assign(toolResult, hp.constants); // 常量位（如 stderr:''）
    return { into: hp.into, tool_result: toolResult };
  },
};
