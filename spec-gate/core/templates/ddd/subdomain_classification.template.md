---
templateId: ddd.subdomain_classification
documentType: subdomain-classification
validationMode: baseline
allowedPlaceholders: {{SUBDOMAIN_ROWS}}, {{INVESTMENT_DECISIONS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 子域分类表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 战略级始终必需；分类决定投资与建模深度。

## 1. 子域清单

| 子域 | 分类 | 说明 |
|---|---|---|
| {{SUBDOMAIN_ROWS}} | core/supporting/generic | 逐行填写 |

## 2. 投资决策

{{INVESTMENT_DECISIONS}}（core 子域自建能力；generic 优先采购或复用；无决策写「无」）
