---
templateId: atomic.assumptions
documentType: assumption
validationMode: baseline
allowedPlaceholders: {{SCOPE}}, {{ASSUMPTIONS_TABLE}}
atomicSchemaAssetId: schema.specification
---
# 前提假设（{{SCOPE}}）

| 编号 | 假设 | 依赖的条款 | 失效时的修订义务 |
|---|---|---|---|
| {{ASSUMPTIONS_TABLE}} | A1、A2… | FR/R/D/T 编号 | 假设失效时必须修订哪些条目 |

> 意图未知的事实只能进入假设或结构化未决项，不得直接升格为规格（RULE-BACKFILL-002）。
