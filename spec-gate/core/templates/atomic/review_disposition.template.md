---
templateId: atomic.review-disposition
documentType: review-disposition
validationMode: draft
allowedPlaceholders: {{REVIEW_ID}}, {{DISPOSITION_TABLE}}, {{COMMON_ISSUES_ESCALATION}}
atomicSchemaAssetId: schema.specification
---
# 评审意见处置表（{{REVIEW_ID}}）

| 序号 | 意见 | 处置 | 修订落点 | 理由 |
|---|---|---|---|---|
| {{DISPOSITION_TABLE}} | 逐条填写 | 接受/修改/拒绝 | 条目编号或文档位置 | 拒绝必须附理由 |

## 共性问题升格

{{COMMON_ISSUES_ESCALATION}}（多条目重复出现的问题升格为模板级或规则级修订；无则写「无」）

> 处置完成后必须同步受影响的追溯条目；「已处理」不构成未修订条目的合规证据。
