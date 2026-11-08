---
templateId: backfill.module_volume
documentType: module-volume
validationMode: draft
allowedPlaceholders: {{MODULE}}, {{VERSION}}, {{GLOSSARY}}, {{ASSUMPTIONS}}, {{REQUIREMENTS}}, {{CONTRACTS}}, {{DECISIONS}}, {{SEQUENCES}}, {{BOUNDARIES}}, {{ACCEPTANCE}}, {{IMPL_STRUCTURE}}, {{IMPL_QUANTITIES}}, {{LESSONS}}, {{TEST_STATUS}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.open-item
---
# 模块分册（双层）

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

| 字段 | 内容 |
|---|---|
| 模块 | {{MODULE}} |
| 基线版本 | {{VERSION}}（首版由项目决定，不硬编码） |

## 0. 公共部分

### 0.1 术语（{{GLOSSARY}}）

装配 template.atomic.glossary。

### 0.2 前提假设（{{ASSUMPTIONS}}）

装配 template.atomic.assumptions。

# 第一部分：规定性规格

## 1. 需求条目（{{REQUIREMENTS}}）

装配 template.atomic.module-requirement；R 覆盖分配给本模块的 FR 语义。

## 2. 对外契约（{{CONTRACTS}}）

装配 template.atomic.external-contract。

## 3. 设计决策（{{DECISIONS}}）

装配 template.atomic.design-decision；完整理由见 ADR。

## 4. 时序（{{SEQUENCES}}）

装配 template.atomic.module-sequence / template.atomic.global-sequence。

## 5. 边界与禁止项（{{BOUNDARIES}}）

装配 template.atomic.boundaries。

## 6. 验收与追溯（{{ACCEPTANCE}}）

装配 template.atomic.acceptance-trace。

# 第二部分：实现注记

> 仅描述实现现状与经验，不产生规定性义务；规定性内容必须上升到第一部分。

### A 当前实现结构

{{IMPL_STRUCTURE}}（模块入口、可注入点）

### B 实现特定的量

{{IMPL_QUANTITIES}}（常量、阈值、缓冲，标注归属的 R/T 编号）

### C 历史教训索引

| 教训（一句话） | 规格化落点 |
|---|---|
| {{LESSONS}} | R-n/T-n/边界条目 |

### D 测试现状

{{TEST_STATUS}}（覆盖、缺口、锁定方式）
