---
templateId: atomic.module-sequence
documentType: module-sequence
validationMode: baseline
allowedPlaceholders: {{MODULE}}, {{SEQUENCE_ID}}, {{OBLIGATIONS_TABLE}}, {{REFINES_GT}}, {{REASON}}
atomicSchemaAssetId: schema.specification
---
# 模块时序条目（{{MODULE}}）

## 1. 时序义务

| 编号 | 义务（谁在何时必须做什么） | 细化 | 理由 |
|---|---|---|---|
| {{SEQUENCE_ID}} | {{OBLIGATIONS_TABLE}} | {{REFINES_GT}} | {{REASON}} |

> 编号格式 T-n。模块条目不允许另起全局主编号；涉及多模块共同可见的时序只能标注「细化 G-Tn」（RULE-SPEC-003）。

## 2. 提升判定记录

判定问题（任一为是即候选提升为 G-T）：

- 是否多个模块共同可见？是/否
- 是否需要共同遵守的时序义务？是/否
- 单方违反是否会破坏他方契约？是/否

结论：保持模块级 / 提升为 G-Tn（提升时在主纲登记唯一主编号）。
