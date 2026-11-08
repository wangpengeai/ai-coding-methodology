---
templateId: backfill.traceability_matrix
documentType: traceability-matrix
validationMode: draft
allowedPlaceholders: {{MATRIX_TABLE}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification
---
# 追溯矩阵

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

| FR | R | 验收 | 测试锁定 | 领域资产 |
|---|---|---|---|---|
| {{MATRIX_TABLE}} | 逐行填写 | 逐行填写 | 单元测试｜tests/system/layer-contract.test.mjs#layer-contract 自检；命令冒烟｜scripts/verify-core-baseline.mjs | 上下文/聚合/事件 |

> 测试锁定按 内部决策-060 结构化闭集书写（可执行类别/命令冒烟/非可执行三类；多锚以 `；` 分隔）。

> 每个 FR 至少一条 R，每条 R 至少一条验收（RULE-SPEC-001）；断链即阻塞定稿。
