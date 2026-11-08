---
description: 进入单次规格变更写作流程（挂载 spec-writing 技能）
argument-hint: [变更描述]
skills: spec-writing
---
按 spec-writing 技能执行单次规格变更：确认体系存在 → 变更定位 → 选模板 → 七条纪律写作（第七条：技术盘问前必须先读代码，内部规则-4）→ 校验与自检。

要求：

- 未决内容只能登记为结构化 `OPEN-n`，禁止自由文本 TODO；
- 每条需求至少一条验收（RULE-SPEC-001）；
- 接口新增/变更必须落 IF 资产条目并同步接口注册表（RULE-IF-001/002）；
- 规格与代码冲突先裁决再行动，禁止假定任一方正确；
- 定稿前运行校验器（可经 `/spec-gate:gate`）。

用户参数：$ARGUMENTS
