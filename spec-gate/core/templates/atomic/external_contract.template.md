---
templateId: atomic.external-contract
documentType: external-contract
validationMode: baseline
allowedPlaceholders: {{CONTRACT_ID}}, {{MODULE}}, {{OPERATIONS_TABLE}}, {{PRECONDITIONS}}, {{POSTCONDITIONS}}, {{ERROR_SEMANTICS}}, {{RISK_TRIGGERED_DETAILS}}, {{COMPAT_CONSTRAINTS}}
atomicSchemaAssetId: schema.specification
---
# 对外契约（{{MODULE}} / {{CONTRACT_ID}}）

> **已弃用**：新条目改用 template.atomic.interface（interfaces 资产，kind=external）；本模板保留一个版本周期，2.0.0 移除（RULE-IF-006）。

## 1. 公开操作与类型契约

| 操作 | 输入 | 输出 | 说明 |
|---|---|---|---|
| {{OPERATIONS_TABLE}} | 逐行填写；必要时附语言签名 | | |

## 2. 前置与后置条件

- 前置：{{PRECONDITIONS}}
- 后置：{{POSTCONDITIONS}}

## 3. 错误语义（必填）

{{ERROR_SEMANTICS}}（错误码、失败传播、重试/幂等语义；跨模块消费方必须可见）

## 4. 风险触发项（按需填写）

{{RISK_TRIGGERED_DETAILS}}：状态与不变式、并发义务、平台差异、可观测性、资源生命周期。未触发则写「无」。

## 5. 兼容约束

{{COMPAT_CONSTRAINTS}}（历史数据/旧版本消费方的兼容义务；无则写「无」）
