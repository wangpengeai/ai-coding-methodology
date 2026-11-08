---
templateId: ddd.aggregate_invariants
documentType: aggregate-invariants
validationMode: baseline
allowedPlaceholders: {{AGGREGATE_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 聚合与不变式表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 战术级涉及聚合变化时必需；每个聚合至少一条不变式与一致性边界。

| 聚合 | 聚合根 | 不变式 | 一致性边界 |
|---|---|---|---|
| {{AGGREGATE_ROWS}} | 逐行填写 | 逐行填写 | 单实例/最终一致及理由 |
