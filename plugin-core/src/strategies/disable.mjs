// 文件：strategies/disable.mjs
// 描述：disable 族策略执行器（内部决策-037 决策 2，一族一文件）——agent 面默认关闭 + 工具目录不可得
//       拒挂。策略逻辑（候选与宿主目录求交集、拒挂极性、unknownTool 策略位）在引擎；宿主只经
//       端口提供运行时目录原语 {listRestrictableTools}。
//       拒挂极性（fail-closed）：目录不可得或交集为空 → reject:true——多给一个写工具是约束静默
//       失效，少给一个读工具只是能力受限（两种错法不对称）。
//       返回形态（门 B 正确性维发现 12 处置）：成功 {reject:false, defaultMount, allowedTools}；
//       拒挂 {reject:true, reason}——不使用真假值混用的 mount 字段。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'agent-default-off-fail-closed': (env, hp, ports) => {
    if (hp.unknownTool !== 'reject') throw new Error(`agent-default-off-fail-closed: 不支持的 unknownTool ${String(hp.unknownTool)}（合法：reject）`);
    const candidates = Array.isArray(env.context.candidates) ? env.context.candidates : [];
    const directory = ports.listRestrictableTools();
    if (!Array.isArray(directory)) {
      return { reject: true, reason: '工具目录不可得（fail-closed：宁可少挂 agent，也不给不过滤的子 agent）' };
    }
    const allowedTools = candidates.filter((t) => directory.includes(t));
    if (allowedTools.length === 0) {
      return { reject: true, reason: '交集为空（allow 为空 = 约束静默失效，同拒挂）' };
    }
    return { reject: false, defaultMount: hp.defaultMount, allowedTools };
  },
};
