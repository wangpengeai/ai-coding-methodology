---
templateId: ddd.domain_event_catalog
documentType: domain-event-catalog
validationMode: baseline
allowedPlaceholders: {{DOMAIN_EVENT_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 领域事件目录

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 每个事件必须写投递语义；跨聚合协调义务必须可被消费方发现。

| 事件 | 发布者 | 订阅者 | 投递语义 |
|---|---|---|---|
| {{DOMAIN_EVENT_ROWS}} | 逐行填写 | 逐行填写 | at-most-once/at-least-once/exactly-once/best-effort |
