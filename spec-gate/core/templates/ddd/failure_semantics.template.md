---
templateId: ddd.failure_semantics
documentType: failure-semantics
validationMode: baseline
allowedPlaceholders: {{FAILURE_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 失败语义目录

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 战术级必须给出失败语义影响结论；每个场景必须有可观察影响。

| 场景 | 失败模式 | 可观察影响 | 恢复预期 |
|---|---|---|---|
| {{FAILURE_ROWS}} | 逐行填写 | 逐行填写 | 重试/补偿/人工介入 |
