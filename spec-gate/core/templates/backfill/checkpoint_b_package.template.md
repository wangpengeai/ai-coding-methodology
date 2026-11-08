---
templateId: backfill.checkpoint_b_package
documentType: checkpoint-package
validationMode: draft
allowedPlaceholders: {{HLD_REF}}, {{GOVERNANCE_REF}}, {{DOMAIN_REF}}, {{AUTHORIZATION}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.adr, schema.ddd-assets
---
# 校对点 B 交付包（系统边界与治理）

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 交付内容

- 概要设计：{{HLD_REF}}
- 治理总纲：{{GOVERNANCE_REF}}
- 领域设计包（如适用）：{{DOMAIN_REF}}

## 用户确认

- 确认状态：待确认/已确认/已驳回
- 授权记录：{{AUTHORIZATION}}
