---
name: spec-backfill
description: 从代码与既有证据倒推建立/重构完整规格体系（SDD 冷启动：代码为主、文档贫乏或倒推文档需转正为规定性基线） —— 触发条件：项目缺权威规格体系且用户要求建立/重建/重构规格体系时；已有体系内的单次变更用 spec-writing。
license: MIT
---

# Spec Backfill：从代码建立规格体系

**主场景**：项目只有代码（或仅 README 级简介），需要建立完整设计资料体系，使后续开发能遵循规格先行流程。已有倒推文档同样适用（重构而非新写）。

> 条目结构、编号与模板的**唯一事实源**是共享内核（本插件 `core/` 目录，原 `sdd-methodology-core`）（经其 `manifest.json` 公开资产消费，assetId 前缀：`template.backfill.` / `template.atomic.` / `template.ddd.` / `schema.`，完整清单以 manifest 为准）。本技能不复制任何 schema 定义；单次变更写作规则属于 `spec-writing`。

## 1 核心理念

补文档的根本陷阱是产出**倒推文档**（描述"代码是这样"）而非**规定性规格**（规定"必须如此，换一个实现也应成立"）。三判据识别倒推文档：无需求与目标、无决策理由、含实现噪音。

## 2 事实分类（升格前置条件，RULE-BACKFILL-002/003）

每条代码事实升格前必须先分类（见 `template.backfill.evidence-ledger`）：

| 分类 | 可否进入规定性基线 |
|---|---|
| 已确认意图 | 是（附确认来源） |
| 兼容约束 | 是（登记为规格或 ADR，附证据与适用范围） |
| 偶然实现 | 否——只进实现注记 |
| 已知缺陷 | 否——进缺陷/风险清单，不得基线化为正确行为 |
| 技术债 | 否——进债务或改进清单 |
| 未知意图 | 否——进假设或结构化未决项（OPEN-n） |
| 安全/合规风险 | 否——进风险清单，不得因现状如此而批准 |

## 3 执行流程（六阶段）

### 阶段 0：信息源勘察

分层勘察（由骨架到细节，勿逐文件平铺深读）：入口与骨架 → 目录结构与模块地图 → 依赖清单 → 测试目录（真实统计）→ 提交历史（功能演进与 Won't 线索）→ 配置/常量/错误码（NFR 素材）。产出模块地图、能力域清单、技术栈清单、**接口清单（IF-n 候选：对外/模块间、提供方、消费方）**、Won't 候选、量化常量清单与**证据台账**（每条后续基线条目都必须可回指台账条目，RULE-BACKFILL-001）。

### 阶段 1：需求基线 → 校对点 A（必须确认）

装配 `template.backfill.requirements-baseline`（内部引用 `template.atomic.requirements`）：FR 按能力域编号并标优先级；NFR 现状值与目标值**分列**，差距显式登记；Won't/Could 带理由或触发条件。反推为"需求"的条目逐条标注，提请用户重点校对。

### 阶段 2：系统规格 + 治理总纲 + 领域设计包 → 校对点 B（必须确认）

装配 `template.backfill.high-level-design`、`template.backfill.program-design-governance`；涉及领域建模时装配 `template.backfill.domain-design-package`（按 DDD 模板组逐项落资产，assetId 前缀 `template.ddd.`）。概要设计先建立，其中需求章节先于其余设计章节确认。继承项目既有的版本、目录与提交约定，不强加外部格式。系统规格契约章同步装配接口注册表（`template.atomic.interface-registry`）；存量 externalContracts 条目分批迁移为 interfaces(kind=external)（RULE-IF-006 过渡）。

### 阶段 3：试点分册 → 校对点 C（必须确认）

选中等复杂度模块试点，装配 `template.backfill.module-volume`（双层：规定性规格 + 实现注记）。请用户校对语气/粒度/编号，按反馈修订模板（预期 2–3 轮）。

### 阶段 4：分批铺开

校对点 C 确认后才允许铺开（RULE-BACKFILL-005）；按依赖顺序分批（被依赖的契约模块先行），已写分册随模板修订回补。

### 阶段 5：收尾一致性

装配 `template.backfill.backfill-completion-report`；运行共享内核校验器（template/draft/baseline/suite 四模式）；追溯矩阵核对（`template.backfill.traceability-matrix`）；接口注册表与分册 IF 条目双向一致性核对（RULE-IF-002）；最终检验：拿规格层给一个没见过代码的实现者，记录不可完整重建的部分与原因（评审启发式，不作为绝对判据）。

## 4 校对点纪律（RULE-BACKFILL-004）

- A/B/C 三个校对点必须产出对应交付包（`template.backfill.checkpoint-a-package` / `template.backfill.checkpoint-b-package` / `template.backfill.checkpoint-c-package`）并记录确认状态；
- 用户授权自主推进时仍必须生成全部交付包并记录授权来源，不得省略校对内容；
- 每个校对点的裁决结果（确认/驳回/修订）写入交付包，供后续阶段追溯。

## 5 诚实性原则

1. 不伪造存量评估：用 Won't/Could 收拢真实范围决策，不为每条 FR 编造评估记录；
2. 反推 ADR 必须标记「重构性解释，非历史事实」，记录证据来源与置信度；`confidence=low` 且未经确认不得成为硬约束基线（RULE-内部决策-002）；
3. 量化指标基于实测现状与保守下限，现状与目标分列；隐藏差距 = 从用户手里拿走知情权；
4. 验收方式如实：手测/自动化/审查清单/构建期检查分清，不为圆满硬造自动化手段。

## 6 红线（无豁免）

- 无证据来源的断言不得进入基线；
- 不把疑似缺陷、低性能现状或不安全行为升格为正确基线；
- 不把偶然实现、未知意图写成规定性规格；
- 不跳过证据台账与校对点交付包；
- 不复制共享内核的 schema 定义。

<!-- lint:allow(skill-host-term) 说明性提及：宿主入口提示节标题（非规范性），内部任务-2 批 B4 判例 -->
## 7 宿主入口提示（ZCode 插件，非规范性）

- 命令：`/spec-gate:backfill`（启动本流程）、`/spec-gate:gate`（体系校验）、`/spec-gate:init`（项目接入）；
- 项目侧约定：接入配置 `内部治理状态`、任务台账 `内部治理状态`；
- 共享内核位于本插件 `core/` 目录（原 `sdd-methodology-core`）。
