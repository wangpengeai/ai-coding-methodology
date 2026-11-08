---
templateId: atomic.adr-registry
documentType: adr-registry
validationMode: baseline
allowedPlaceholders: {{REGISTRY_TABLE}}, {{RETIRED_IDS}}
atomicSchemaAssetId: schema.adr-registry
---
# ADR Registry

## 1. 现行条目

| 编号 | 状态 | 取代 | 被取代 |
|---|---|---|---|
| {{REGISTRY_TABLE}} | proposed/accepted/deprecated/superseded/rejected | ADR-n 或 无 | ADR-n 或 无 |

## 2. 已退役编号（不可复用）

{{RETIRED_IDS}}（逗号分隔；空则写「无」）

> 状态变更（含标记 superseded）允许原地更新；语义决策变更必须新建 ADR 并在本表记录取代关系（RULE-内部决策-003）。
