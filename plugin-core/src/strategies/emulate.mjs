// 文件：strategies/emulate.mjs
// 描述：emulate 族策略执行器（内部决策-037 决策 2，一族一文件）——命令面以同名 skill 承接、
//       followup 补回提示词展开（$ARGUMENTS 渲染后经 enqueue 入队；startTurn=false 时按
//       fallback=receipt-no-drive 交回正文并明写未驱动）。params 的 form/api 为**受读契约位**：
//       取值不受支持即 fail-closed（数据面不得声明代码不实现的机制）。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'command-to-skill': (env, hp) => {
    if (hp.form !== 'same-name-skill') throw new Error(`command-to-skill: 不支持的 form ${String(hp.form)}（合法：same-name-skill）`);
    const commandName = typeof env.context.commandName === 'string' ? env.context.commandName : '';
    return { skillName: commandName }; // 同名承接：skill 名 = 命令名
  },

  'followup-expansion': (env, hp, ports) => {
    if (hp.api !== 'agent.followup') throw new Error(`followup-expansion: 不支持的 api ${String(hp.api)}（合法：agent.followup）`);
    if (hp.fallback !== 'receipt-no-drive') throw new Error(`followup-expansion: 不支持的 fallback ${String(hp.fallback)}（合法：receipt-no-drive）`);
    const body = String(env.context.body ?? '');
    const rawInput = typeof env.context.rawInput === 'string' ? env.context.rawInput.trim() : '';
    // **正文不做整体 trim**（2026-10-01 批 3 终审修复）：旧 DSH 实现是
    // `String(body).split('$ARGUMENTS').join(rawInput.trim())`——只有**入参**被 trim，正文原样保留
    //（首尾空白/行尾换行是命令正文的一部分）。原实现在此处多做了一次 `.trim()`，使真件 7 条命令的
    // followup 文本全部缩短 1-2 字符（行为漂移，批 3 全局约束 1「行为零变化」不允许）。
    const rendered = body.split('$ARGUMENTS').join(rawInput);
    if (env.context.startTurn === false) {
      return { driven: false, body: rendered }; // fallback=receipt-no-drive 已在入口 fail-closed，此处只判是否驱动
    }
    ports.enqueue(rendered); // 渲染后正文入队为下一轮提示词
    return { driven: true, body: rendered };
  },
};
