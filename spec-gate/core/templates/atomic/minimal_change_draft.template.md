---
templateId: atomic.minimal-change-draft
documentType: change-draft
validationMode: draft
allowedPlaceholders: {{DRAFT_ID}}, {{TASK_ID}}, {{SCOPE}}, {{OBSERVABLE_BEHAVIOR}}, {{ACCEPTANCE_CONDITIONS}}, {{SPEC_LANDING}}, {{INTERFACE_IMPACT}}, {{OPEN_ITEMS}}, {{FINALIZATION_TRIGGER}}, {{OWNER}}, {{DATE}}
atomicSchemaAssetId: schema.specification
---
# 最小变更草案 {{DRAFT_ID}}

> 编码前最小记录（RULE-FLOW-002）。未完成定稿前不得宣布完成；未决内容必须登记为结构化 {{OPEN_ITEMS}}。

## 1. 范围

{{SCOPE}}

## 2. 规格落点

{{SPEC_LANDING}}（目标文档与条目编号；尚未存在的条目必须先创建草案条目）

## 3. 接口影响声明

{{INTERFACE_IMPACT}}（触碰对外/模块间接口时必填：受影响 IF-n 与消费方影响；未触碰写「无」，RULE-IF-001；快速通道同样必填）

## 4. 可观察行为

{{OBSERVABLE_BEHAVIOR}}

## 5. 验收条件

{{ACCEPTANCE_CONDITIONS}}

## 6. 定稿触发点

{{FINALIZATION_TRIGGER}}（合入、发布或宣布完成中最早发生者；紧急通道另按台账 deadline）

- 负责人：{{OWNER}}
- 日期：{{DATE}}
- 任务标识：{{TASK_ID}}
