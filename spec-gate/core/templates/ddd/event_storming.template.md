---
templateId: ddd.event_storming
documentType: event-storming
validationMode: baseline
allowedPlaceholders: {{EVENTS}}, {{COMMANDS}}, {{ACTORS}}, {{POLICIES}}, {{READ_MODELS}}, {{EXTERNAL_SYSTEMS}}, {{AGGREGATE_CANDIDATES}}, {{HOTSPOTS}}, {{UNRESOLVED}}
atomicSchemaAssetId: schema.ddd-assets

---
# 事件风暴记录

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 允许替代建模：不适用时必须记录理由，并提供事件时间线、示例映射或决策表至少一种。

## 适用性

- 是否执行事件风暴：是/否
- 不适用理由：{{HOTSPOTS}}（适用时写「无」）

## 领域事件

{{EVENTS}}

## 命令与参与者

{{COMMANDS}} / {{ACTORS}}

## 策略与读模型

{{POLICIES}} / {{READ_MODELS}}

## 外部系统

{{EXTERNAL_SYSTEMS}}

## 聚合候选

{{AGGREGATE_CANDIDATES}}

## 热点与未决问题

{{UNRESOLVED}}
