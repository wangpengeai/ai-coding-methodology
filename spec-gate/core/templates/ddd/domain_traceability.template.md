---
templateId: ddd.domain_traceability
documentType: domain-traceability
validationMode: baseline
allowedPlaceholders: {{TRACE_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 领域资产—规格—代码边界追溯表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 战略级始终必需；每个领域资产必须能追到规格条目与代码边界。
> 接口资产以 IF-域-n 登记于 interfaces 资产族；本表「规格条目」列可出现 IF-域-n，与接口注册表互查（RULE-IF-002）。

| 领域资产 | 规格条目 | 代码边界 | 测试证据 |
|---|---|---|---|
| {{TRACE_ROWS}} | FR/R/D/T/G-T 编号 | 模块/包路径 | 测试文件或冒烟清单 |
