---
templateId: ddd.entity_value_object_catalog
documentType: entity-value-object-catalog
validationMode: baseline
allowedPlaceholders: {{ENTITY_ROWS}}, {{VO_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 实体/值对象目录

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 战术级按需更新；实体必须写身份规则，值对象必须写相等规则。

## 实体

| 名称 | 身份规则 | 生命周期 |
|---|---|---|
| {{ENTITY_ROWS}} | 逐行填写 | 逐行填写 |

## 值对象

| 名称 | 不变式 | 相等规则 |
|---|---|---|
| {{VO_ROWS}} | 逐行填写 | 逐行填写 |
