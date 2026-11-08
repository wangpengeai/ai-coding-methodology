---
templateId: atomic.change-impact
documentType: change-impact
validationMode: draft
allowedPlaceholders: {{CHANGE_ID}}, {{TASK_ID}}, {{CHANGE_SUMMARY}}, {{AFFECTED_MODULES}}, {{AFFECTED_CONTRACTS}}, {{AFFECTED_INTERFACES}}, {{DOMAIN_ASSETS}}, {{RISKS}}, {{VALIDATION_PLAN}}, {{OWNER}}, {{DATE}}
atomicSchemaAssetId: schema.specification
---
# 变更影响分析 {{CHANGE_ID}}

## 1. 变更概述

{{CHANGE_SUMMARY}}

- 任务标识：{{TASK_ID}}
- 负责人：{{OWNER}}
- 日期：{{DATE}}

## 2. 受影响模块

| 模块 | 影响类型 | 说明 |
|---|---|---|
| {{AFFECTED_MODULES}} | 行为/契约/结构 | 逐行填写 |

## 3. 受影响契约与领域资产

| 资产 | 变化 | 追溯条目 |
|---|---|---|
| {{AFFECTED_CONTRACTS}} | 新增/修改/废弃 | 填 FR/R/D/T/G-T/ADR 编号 |
| {{DOMAIN_ASSETS}} | 子域/上下文/聚合/事件 | 无变化填「已检查、无变化」 |

## 4. 受影响接口与消费方处置

| 接口 | 变化 | 消费方 | 处置 |
|---|---|---|---|
| {{AFFECTED_INTERFACES}} | IF-域-n | 逐个列出 | 已适配 / 不受影响+理由 / 待适配+deadline（RULE-IF-002） |

## 5. 风险与验证计划

| 风险 | 影响 | 缓解/验证 |
|---|---|---|
| {{RISKS}} | 逐行填写 | {{VALIDATION_PLAN}} |
