---
templateId: ddd.context_relationships
documentType: context-relationships
validationMode: baseline
allowedPlaceholders: {{RELATIONSHIP_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 上下文关系、上下游方向与契约所有权表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 每个上下游关系必须明确集成模式与契约所有者；契约演进策略必须写明。
> 集成模式取九种受控值之一（见 `schema.ddd-assets`）：shared-kernel / customer-supplier / conformist / anticorruption-layer / open-host-service / published-language / separate-ways / partnership / big-ball-of-mud-boundary。

| 上游 | 下游 | 集成模式 | 契约所有者 | 演进策略 |
|---|---|---|---|---|
| {{RELATIONSHIP_ROWS}} | 逐行填写 | 逐行填写 | 团队/角色 | 变更通知与兼容义务 |
