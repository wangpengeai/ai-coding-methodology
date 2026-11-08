---
templateId: backfill.domain_design_package
documentType: domain-design-package
validationMode: draft
allowedPlaceholders: {{LEVEL}}, {{STRATEGIC_ASSETS}}, {{TACTICAL_ASSETS}}, {{COMPLETION_REPORT_REF}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.ddd-assets
---
# 领域设计包

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 1. 判定等级

{{LEVEL}}（strategic/tactical/not-applicable）

## 2. 战略级资产装配（等级为 strategic 时）

{{STRATEGIC_ASSETS}}：按 template.ddd.* 逐项装配；不适用项标注 N/A 与理由。

## 3. 战术级资产装配（等级为 tactical 或 strategic 时）

{{TACTICAL_ASSETS}}：聚合/不变式、领域事件、领域服务、仓储或端口边界、失败语义。

## 4. 完成报告

{{COMPLETION_REPORT_REF}}（template.ddd.ddd-completion-report）
