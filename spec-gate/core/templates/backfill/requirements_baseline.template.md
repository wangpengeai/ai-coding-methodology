---
templateId: backfill.requirements_baseline
documentType: requirement-baseline
validationMode: draft
allowedPlaceholders: {{DOMAIN}}, {{REQUIREMENTS_TABLE}}, {{NONFUNCTIONAL_TABLE}}, {{WONT_TABLE}}, {{COULD_TABLE}}, {{ASSESSMENT_PROCESS}}, {{EVIDENCE_LEDGER_REF}}, {{OPEN_ITEMS_REF}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.open-item
---
# 需求基线与系统规格

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

> 本模板装配原子需求基线（template.atomic.requirements），并补充回填专用纪律。

## 1. 需求与范围

装配：template.atomic.requirements（{{REQUIREMENTS_TABLE}} / {{NONFUNCTIONAL_TABLE}} / {{WONT_TABLE}} / {{COULD_TABLE}} / {{ASSESSMENT_PROCESS}}）

## 2. 回填纪律

- 每条 FR/NFR 必须回指证据台账编号（{{EVIDENCE_LEDGER_REF}}）。
- NFR 现状值与目标值分列；差距显式登记，不得隐藏。
- 接受现状为基线必须记录显式决策与裁定人。
- 未决项统一登记（{{OPEN_ITEMS_REF}}），禁止自由 TODO。

## 3. 校对点 A 状态

- 交付包：template.backfill.checkpoint-a-package
- 确认状态：待确认/已确认/已驳回（授权自主推进时记录授权来源）
