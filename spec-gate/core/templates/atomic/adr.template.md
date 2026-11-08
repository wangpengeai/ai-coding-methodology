---
templateId: atomic.adr
documentType: adr
validationMode: baseline
allowedPlaceholders: {{ADR_ID}}, {{STATUS}}, {{DATE}}, {{DECIDERS}}, {{CONTEXT}}, {{DECISION}}, {{ALTERNATIVES_TABLE}}, {{SELECTION_RATIONALE}}, {{CONSEQUENCES}}, {{EVIDENCE_TABLE}}, {{CONFIDENCE}}, {{SUPERSEDES}}, {{SUPERSEDED_BY}}, {{TRACEABILITY}}, {{CONFIRMATION_STATUS}}, {{RETROFIT_NOTE}}
atomicSchemaAssetId: schema.adr
---
# {{ADR_ID}}：{{DECISION}}

| 字段 | 内容 |
|---|---|
| 状态 | {{STATUS}}（proposed/accepted/deprecated/superseded/rejected） |
| 日期 | {{DATE}} |
| 决策人 | {{DECIDERS}} |
| 确认状态 | {{CONFIRMATION_STATUS}}（pending/confirmed/rejected/not-required） |
| 置信度 | {{CONFIDENCE}}（confirmed/high/medium/low） |
| 取代关系 | 取代：{{SUPERSEDES}}；被取代：{{SUPERSEDED_BY}} |
| 追溯 | {{TRACEABILITY}}（FR/NFR/R/D/T/G-T 编号） |

## 1. 背景（需求与约束）

{{CONTEXT}}

## 2. 决策

{{DECISION}}

## 3. 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| {{ALTERNATIVES_TABLE}} | 逐行填写；无备选写「无，理由：…」 |

## 4. 选择理由

{{SELECTION_RATIONALE}}

## 5. 后果（代价与衍生约束）

{{CONSEQUENCES}}

## 6. 证据来源

| 类型 | 引用 |
|---|---|
| {{EVIDENCE_TABLE}} | code/tests/configuration/historical-documentation/change-history/runtime-observation/user-confirmation 之一 + 具体引用 |

{{RETROFIT_NOTE}}

> 反推 ADR 必须在此注明「重构性解释，非历史事实」；置信度 low 且未经确认不得成为硬约束基线（RULE-内部决策-002）。
> 编号不可复用；推翻旧决策创建新 ADR 并在 registry 记录取代关系（RULE-内部决策-003）。
