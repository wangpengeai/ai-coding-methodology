---
templateId: backfill.checkpoint_c_package
documentType: checkpoint-package
validationMode: draft
allowedPlaceholders: {{PILOT_REF}}, {{TEMPLATE_FEEDBACK}}, {{AUTHORIZATION}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification
---
# 校对点 C 交付包（试点分册）

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 交付内容

- 试点模块分册：{{PILOT_REF}}
- 模板粒度反馈与修订：{{TEMPLATE_FEEDBACK}}

## 用户确认

- 确认模板范式后才允许批量铺开（RULE-BACKFILL-005）
- 确认状态：待确认/已确认/已驳回
- 授权记录：{{AUTHORIZATION}}
