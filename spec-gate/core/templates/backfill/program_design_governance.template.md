---
templateId: backfill.program_design_governance
documentType: program-design-governance
validationMode: draft
allowedPlaceholders: {{GOVERNANCE_CATEGORIES}}, {{NUMBERING_POLICY}}, {{CHANGE_FLOW}}, {{DOC_MAINTENANCE}}, {{PROJECT_CONVENTIONS}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification
---
# 程序设计与文档治理总纲

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 1. 治理类别

{{GOVERNANCE_CATEGORIES}}（至少覆盖：编号与命名、变更流程、状态与并发义务、错误与失败语义、测试与验收、日志与可观测、提交与发布约定；按项目实际裁剪）

## 2. 编号政策

{{NUMBERING_POLICY}}（FR/NFR/R/D/T/G-T/ADR/OPEN 编号族与唯一性；全局时序唯一主编号，模块条目只标注细化）

## 3. 规格变更流程

{{CHANGE_FLOW}}（变更先改规格层再动代码；草案与定稿条件；合入以定稿为前置）

## 4. 文档维护机制

{{DOC_MAINTENANCE}}（一致性检查、评审节奏、漂移处理）

## 5. 项目既定约定

{{PROJECT_CONVENTIONS}}（继承项目既有的版本、目录、提交格式约定；本模板不强加任何提交格式）
