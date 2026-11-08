---
templateId: atomic.acceptance-trace
documentType: acceptance-trace
validationMode: baseline
allowedPlaceholders: {{MODULE}}, {{ACCEPTANCE_TABLE}}, {{COVERAGE_RESULT}}
atomicSchemaAssetId: schema.specification
---
# 验收与测试追溯（{{MODULE}}）

## 1. 验收条目

| 编号 | 可验证行为 | 追溯 | 锁定方式 |
|---|---|---|---|
| {{ACCEPTANCE_TABLE}} | 行为化表述 | [R-n] 或 [FR-域-n] | 单元测试｜tests/system/layer-contract.test.mjs#layer-contract 自检；命令冒烟｜scripts/verify-core-baseline.mjs |

> 锁定方式按 内部决策-060 结构化闭集书写：可执行类别＝单元测试/集成测试/系统测试/验收测试（形态 `类别｜仓根相对测试路径#用例标题唯一片段`）、命令冒烟（`命令冒烟｜脚本路径`）；非可执行类别＝构建期检查/人工走查/审查清单；多锚以 `；` 分隔。

> 每条 R/契约至少一条验收；验收与需求条目同步编写（RULE-SPEC-001）。

## 2. 覆盖核对结果

{{COVERAGE_RESULT}}：

- R 到验收双向可查：是/否
- 无需求缺验收：是/否
- 无验收悬空（无对应需求）：是/否
