---
templateId: atomic.boundaries
documentType: boundary
validationMode: baseline
allowedPlaceholders: {{MODULE}}, {{BOUNDARY_ID}}, {{PROHIBITED_TABLE}}, {{REQUIRED_TABLE}}, {{VERIFIABLE_CONDITION}}, {{TRANSITION_BEHAVIOR}}
atomicSchemaAssetId: schema.specification
---
# 边界与禁止项（{{MODULE}}）

## 1. 禁止项（不得发生的行为）

| 编号 | 禁止行为 | 理由 |
|---|---|---|
| {{BOUNDARY_ID}} | {{PROHIBITED_TABLE}} | 逐行填写 |

## 2. 必须项（必须保证的行为）

| 编号 | 必须行为 | 理由 |
|---|---|---|
| | {{REQUIRED_TABLE}} | 逐行填写 |

## 3. 可验证条件

{{VERIFIABLE_CONDITION}}（每条边界必须有可观察、可判定的验证条件；愿望式语句不合规）

## 4. 过渡期行为

{{TRANSITION_BEHAVIOR}}（迁移/灰度/降级期间的边界行为；无则写「无」）
