---
templateId: atomic.interface
documentType: interface
validationMode: baseline
allowedPlaceholders: {{IF_ID}}, {{KIND}}, {{MODULE}}, {{OWNER_MODULE}}, {{CONSUMER_MODULES}}, {{OPERATIONS_TABLE}}, {{PRECONDITIONS}}, {{POSTCONDITIONS}}, {{ERROR_SEMANTICS}}, {{RISK_TRIGGERED_DETAILS}}, {{LIFECYCLE}}, {{DEPRECATION}}, {{VERSION}}, {{COMPAT_POLICY}}, {{CONTRACT_ARTIFACTS}}, {{FREEZE_BASELINE}}, {{TRACES_TO}}
atomicSchemaAssetId: schema.specification
---
# 接口 {{IF_ID}}（{{MODULE}}）

> kind：{{KIND}}（external=对外；inter-module=模块间）；提供方：{{OWNER_MODULE}}；编号 IF-域-n；接口必须登记为 IF 资产，禁止只在分册正文定义（RULE-IF-001）。

## 1. 消费方

{{CONSUMER_MODULES}}（inter-module 必须至少一个；external 允许「无已知消费方」，RULE-IF-002）

## 2. 公开操作

| 操作 | 输入 | 输出 | 说明 |
|---|---|---|---|
| {{OPERATIONS_TABLE}} | 逐行填写；必要时附语言签名 | | |

## 3. 前置与后置条件

- 前置：{{PRECONDITIONS}}
- 后置：{{POSTCONDITIONS}}

## 4. 错误语义（必填）

{{ERROR_SEMANTICS}}（错误码、失败传播、重试/幂等语义；消费方必须可见）

## 5. 风险触发项（按需填写）

{{RISK_TRIGGERED_DETAILS}}：状态与不变式、并发义务、平台差异、可观测性、资源生命周期。未触发则写「无」。

## 6. 生命周期与版本

- lifecycle：{{LIFECYCLE}}（proposed→active→deprecated→retired 正向迁移；RULE-IF-003）
- 弃用信息：{{DEPRECATION}}（deprecated 时必填 deadline/successor/migrationNote；其余写「不适用」）
- version：{{VERSION}}；compatPolicy：{{COMPAT_POLICY}}（strict-backward|rolling|pinned）
- 破坏性变更 = 违反 compatPolicy：必带 ADR + 消费方处置 + version 变化（RULE-IF-003）

## 7. 契约工件（指针+证据式）

| 工件类型 | 路径 | 内容哈希 | 漂移检查命令 |
|---|---|---|---|
| {{CONTRACT_ARTIFACTS}} | packages/shared/contract.ts | sha256:0123456789abcdef | node scripts/check-contract.mjs |

格式说明（上为示例行，照抄后替换各格）：工件类型 = openapi/protobuf/ts-types/json-schema/custom；路径 = 仓库相对路径（以项目根解析，勿写绝对路径）；内容哈希 = `sha256:` 前缀 + 16-64 位十六进制（建议登记完整 64 位；聚合 gate 按登记实际长度比对，RULE-IF-005）；漂移检查命令 = 可复现命令，无法登记时写「无」并附替代验证（RULE-IF-004）。

## 8. 冻结基线（active 时定稿）

{{FREEZE_BASELINE}}（operations + errorSemantics + 已登记工件哈希；无工件接口冻结前两项。冻结后并行开发按 RULE-IF-005，收口重跑漂移比对）

## 9. 追溯

{{TRACES_TO}}（指向 FR-/R-/G-Tn，形成 FR→R→IF→AC 闭环）
