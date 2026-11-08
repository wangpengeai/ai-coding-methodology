---
templateId: ddd.repository_port_boundaries
documentType: repository-port-boundaries
validationMode: baseline
allowedPlaceholders: {{BOUNDARY_ROWS}}
atomicSchemaAssetId: schema.ddd-assets

---
# 仓储/端口边界表

> 适用标签: 始终必需 / 条件更新 / 允许 N/A / 允许替代建模
> 仓储按聚合边界划分不是强制教条；一个聚合多个访问路径或 CQRS/事件溯源场景必须显式记录理由。

| 聚合 | 边界类型 | 接口位置 | 事务范围 |
|---|---|---|---|
| {{BOUNDARY_ROWS}} | repository/port/external-system-facade | 逐行填写 | 逐行填写 |
