---
description: /feature-dev [特性描述] —— 编码链快捷编排（薄命令）：从想法评估到代码评审共七步，每步调用对应 skill，门禁未满足即停；生产交付后半程归 production-change，不在本命令内
argument-hint: [特性描述]
---

编码链快捷编排（内部决策-007 口径）：从想法评估到代码评审共七步，本命令只串联 skill 调用，流程细节一律在对应 skill 正文（薄命令，内部规则-6）。七步终点是 code-complete（凭据链 finalize 之后的完成声明），merge/release/deploy/observe/UAT 归 production-change 链路，本命令不覆盖也不代表它们。

1. 调用 `idea-review` 评估想法（$ARGUMENTS 缺省时先澄清目标）。
2. 调用 `brainstorming` 澄清方案并敲定设计决策。
3. 调用 `plan-writing` 把批准的设计落成计划。
4. 调用 `plan-review` 评审计划。
5. 调用 `plan-execution` 执行已批准的计划。
6. 调用 `verification` 用证据裁决完成声称。
7. 调用 `code-review` 评审已通过验证的代码。

每步未完成不得推进到下一步（门禁未满足停在原地，T-M5-2）；用户中断即停，不产生实现改动。
