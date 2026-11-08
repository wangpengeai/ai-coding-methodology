---
templateId: backfill.high_level_design
documentType: high-level-design
validationMode: draft
allowedPlaceholders: {{SYSTEM_BOUNDARY}}, {{CONTEXT_RELATIONS}}, {{TECH_CONSTRAINTS_TABLE}}, {{ADR_REF}}, {{OPEN_ITEMS_REF}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.adr
---
# 概要设计

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 1. 系统边界与上下文

{{SYSTEM_BOUNDARY}} / {{CONTEXT_RELATIONS}}

## 2. 技术约束基线

| 编号 | 约束 | 证据来源 | 影响范围 |
|---|---|---|---|
| {{TECH_CONSTRAINTS_TABLE}} | 逐行填写 | 台账编号 | 逐行填写 |

## 3. 关键决策引用

{{ADR_REF}}（完整 ADR 见 template.atomic.adr）

## 4. 未决项

{{OPEN_ITEMS_REF}}

## 5. 与其他文档的关系

- 需求章节先于其余设计章节确认（校对点 A）。
- 治理总纲约束本文件；本文件派生模块分册。
