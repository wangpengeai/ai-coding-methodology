---
templateId: atomic.delivery-report
documentType: delivery-report
validationMode: draft
allowedPlaceholders: {{TASK_ID}}, {{TRIGGER_REASON}}, {{APPLICABILITY}}, {{PREFERENCES}}, {{PREREQUISITES}}, {{ROUTED_SKILLS}}, {{ARTIFACTS_CHANGED}}, {{ENTRY_IDS}}, {{DOMAIN_CHANGES}}, {{TDD_EVIDENCE}}, {{INTERFACE_EVIDENCE}}, {{VALIDATION_RESULTS}}, {{CONFIRMATIONS}}, {{WAIVERS}}, {{UNVERIFIED_ITEMS}}, {{RESIDUAL_RISKS}}, {{FINAL_STATUS}}
atomicSchemaAssetId: schema.gate-report
---
# 交付报告（{{TASK_ID}}）

## 1. 触发与适用性

- 触发原因：{{TRIGGER_REASON}}
- 适用性结论：{{APPLICABILITY}}（SDD/DDD/TDD 三字段与理由）
- 偏好命中：{{PREFERENCES}}（opt-out/显式启用/无）

## 2. 前置条件与路由

- 前置与缺口：{{PREREQUISITES}}
- 使用的能力路由：{{ROUTED_SKILLS}}（spec-backfill/spec-writing/核心公开资产）

## 3. 变更内容

- 文档与资产：{{ARTIFACTS_CHANGED}}
- 条目编号：{{ENTRY_IDS}}
- 领域资产变化：{{DOMAIN_CHANGES}}（无变化写「已检查、无变化」）

## 4. 验证证据

- TDD 循环：{{TDD_EVIDENCE}}（RED 分类/选择集哈希/命令与退出码）
- 接口证据：{{INTERFACE_EVIDENCE}}（受影响 IF-n、消费方处置、漂移检查结果或豁免记录；RULE-IF-004/005）
- 校验结果：{{VALIDATION_RESULTS}}

## 5. 确认、豁免与未决

- 用户确认点：{{CONFIRMATIONS}}
- 豁免：{{WAIVERS}}（授权来源/替代验证/剩余风险）
- 未验证项：{{UNVERIFIED_ITEMS}}
- 剩余风险：{{RESIDUAL_RISKS}}

## 6. 最终状态

{{FINAL_STATUS}}（complete/partial/blocked/temporary-mitigation；与证据一致，不得夸大）
