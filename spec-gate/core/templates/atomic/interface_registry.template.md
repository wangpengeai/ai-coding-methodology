---
templateId: atomic.interface-registry
documentType: interface-registry
validationMode: baseline
allowedPlaceholders: {{REGISTRY_TABLE}}, {{RETIRED_IDS}}
atomicSchemaAssetId: schema.interface-registry
---
# Interface Registry

## 1. 现行条目

| 编号 | 规格落点 | 提供方 | 消费方 | 生命周期 | 版本 | 最近变更 |
|---|---|---|---|---|---|---|
| {{REGISTRY_TABLE}} | IF-域-n | 分册锚点 | 逗号分隔 | proposed/active/deprecated/retired | 逐行填写 | 任务或变更条目引用 |

## 2. 已退役编号（不可复用）

{{RETIRED_IDS}}（逗号分隔；空则写「无」）

> 注册表与分册 IF 条目双向一致（RULE-IF-002）；deprecated 条目必须带 deprecationDeadline；retired 编号不得重新分配（RULE-IF-003）。
