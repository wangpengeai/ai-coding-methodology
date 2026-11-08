---
templateId: backfill.event_catalog
documentType: event-catalog
validationMode: draft
allowedPlaceholders: {{EVENT_TABLE}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.ddd-assets
---
# 事件目录

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

| 事件 | 发布者 | 订阅者 | 投递语义 | 追溯 |
|---|---|---|---|---|
| {{EVENT_TABLE}} | 逐行填写 | 逐行填写 | at-most-once/at-least-once/exactly-once/best-effort | G-Tn/领域事件目录 |
