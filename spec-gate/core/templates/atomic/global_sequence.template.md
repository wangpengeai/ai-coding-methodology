---
templateId: atomic.global-sequence
documentType: global-sequence
validationMode: baseline
allowedPlaceholders: {{GT_ID}}, {{STATEMENT}}, {{PARTICIPATING_MODULES}}, {{OBLIGATIONS_PER_MODULE}}, {{VIOLATION_CONSEQUENCE}}
atomicSchemaAssetId: schema.specification
---
# 全局时序条目（{{GT_ID}}）

## 1. 时序陈述

{{STATEMENT}}

> 编号格式 G-Tn；全局时序只允许唯一主编号，模块分册只能引用「细化 G-Tn」（RULE-SPEC-003）。

## 2. 参与模块与义务

| 模块 | 义务 |
|---|---|
| {{PARTICIPATING_MODULES}} | {{OBLIGATIONS_PER_MODULE}} |

## 3. 违反后果

{{VIOLATION_CONSEQUENCE}}（单方违反时对其他模块契约的影响）
