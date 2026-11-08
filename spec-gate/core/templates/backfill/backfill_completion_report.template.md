---
templateId: backfill.backfill_completion_report
documentType: backfill-completion-report
validationMode: draft
allowedPlaceholders: {{VOLUMES_STATUS}}, {{VALIDATION_RESULTS}}, {{RECONSTRUCTION_REVIEW}}, {{OPEN_ITEMS_SUMMARY}}, {{RESIDUAL_RISKS}}, {{FINAL_STATUS}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.gate-report, schema.open-item
---
# 回填完成报告

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 1. 分册状态

{{VOLUMES_STATUS}}（试点 + 已铺开 + 待铺开清单）

## 2. 校验结果

{{VALIDATION_RESULTS}}（template/draft/baseline/suite 各模式退出码与阻塞诊断数）

## 3. 人工重建评审

{{RECONSTRUCTION_REVIEW}}（评审启发式：仅凭分册能否重建模块行为；复杂系统允许记录不可完整重建的部分与原因）

## 4. 未决项与风险

- 未决项汇总：{{OPEN_ITEMS_SUMMARY}}（blocking 项不得遗留于基线）
- 剩余风险：{{RESIDUAL_RISKS}}

## 5. 最终状态

{{FINAL_STATUS}}（complete/partial/blocked；与证据一致）
