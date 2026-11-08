---
templateId: atomic.module-requirement
documentType: module-requirement
validationMode: baseline
allowedPlaceholders: {{MODULE}}, {{REQUIREMENT_ID}}, {{STATEMENT}}, {{TRACES_TO}}, {{ACCEPTANCE_ID}}, {{ACCEPTANCE_BEHAVIOR}}, {{LOCK_METHOD}}
atomicSchemaAssetId: schema.specification
---
# 模块需求条目（{{MODULE}}）

## 1. 需求条目

| 编号 | 需求（可验证表述） | 追溯 |
|---|---|---|
| {{REQUIREMENT_ID}} | {{STATEMENT}} | {{TRACES_TO}}（分配给本模块的 FR 编号） |

> R 对分配给本模块的 FR 形成完整细化，不得遗漏本模块承担的语义（RULE-SPEC-001）。

## 2. 验收条目（与 R 同步编写，勿留到最后补）

{{ACCEPTANCE_ID}}. {{ACCEPTANCE_BEHAVIOR}} —— [{{REQUIREMENT_ID}}]，锁定方式：{{LOCK_METHOD}}

> 锁定方式如实填写：自动化测试/人工冒烟清单/构建期检查/审查清单；不得把手测包装成自动化（RULE-SPEC-001）。
