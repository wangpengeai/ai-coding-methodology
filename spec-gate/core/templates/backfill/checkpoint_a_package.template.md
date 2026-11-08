---
templateId: backfill.checkpoint_a_package
documentType: checkpoint-package
validationMode: draft
allowedPlaceholders: {{BASELINE_REF}}, {{LEDGER_REF}}, {{PENDING_LIST}}, {{AUTHORIZATION}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.open-item
---
# 校对点 A 交付包（需求基线）

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 交付内容

- 需求基线：{{BASELINE_REF}}
- 证据台账：{{LEDGER_REF}}
- 反推条目与待确认清单：{{PENDING_LIST}}

## 用户确认

- 重点校对：从实现行为反推为需求的条目、未单列的细节功能
- 确认状态：待确认/已确认/已驳回
- 授权记录：{{AUTHORIZATION}}（授权自主推进时必填；不得省略交付包内容）
