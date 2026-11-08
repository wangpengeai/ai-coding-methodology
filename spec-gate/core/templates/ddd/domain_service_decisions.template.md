---
templateId: ddd.domain_service_decisions
documentType: domain-service-decisions
validationMode: baseline
allowedPlaceholders: {{SERVICE_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 领域服务决策表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 领域服务是无状态的跨聚合逻辑承载；引入理由必须记录。

| 服务 | 引入理由 | 无状态 |
|---|---|---|
| {{SERVICE_ROWS}} | 逐行填写 | 是/否 |
