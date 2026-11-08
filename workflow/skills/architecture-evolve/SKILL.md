---
name: architecture-evolve
description: 架构体检与演化提案：消费架构反馈台账做周期结构审查、闭环校验与演化机会登记，只读产报告、不实施不裁决——触发条件：周期节点到达（用户要求做架构体检/架构演化评估，或 SessionStart 架构体检提醒命中）时。
license: MIT
---

# architecture-evolve：架构体检与演化提案（周期节点，只读）

对「跨批次架构演化」做固定审视：读架构反馈台账与上次报告，做结构诊断与闭环校验，把发现分成漂移/债（→优化候选）、机会（→演化提案）、可机械化判据（→当场立判据）三类去向。本 skill 只读：不改代码/配置，不写 内部规格，不替用户裁决。

## 适用场景

- 路由表「周期节点」行：用户显式要求「做一次架构体检 / 评估架构演化」。
- SessionStart 架构体检提醒命中（距上次体检 ≥14 天或新增架构事实 ≥10 条）。
- 不适用：单批 diff 评审归 code-review；代码质量计分归 health；周期复盘归 retro。

## 输入与输出

- 输入：被治理项目 `.context/architecture-feedback.jsonl`（台账，可缺省）、`.context/architecture-reviews/` 上次报告、项目结构（目录/模块/文档/近期提交）。
- 输出：对话中可读报告；追加 `review` 记录与新的 finding/optimization/evolution/watch 记录到台账；报告 JSON 落 `.context/architecture-reviews/<YYYY-MM-DD>.json`。不写其他文件。

## 流程

### 第 1 步：读台账与上次报告

读 `.context/architecture-feedback.jsonl`（逐行 JSON；坏行跳过并计入报告「坏行数」）；读 `.context/architecture-reviews/` 最新报告。首次运行（无台账/无报告）按空台账处理，报告中注明「首次体检」。

### 第 2 步：定向抽读结构面

优先查「设计面↔实现面↔门面文档」三者语义脱节（按 v1 评估 P4：优先查无机器消费的声明）；其次查职责错位、双写、层次穿透、重复抽象、文档陈旧。抽样以「近期批次改动面 + 无机器消费的声明 + 跨批次重复模式」为导航，不要求全量通读。

### 第 3 步：闭环校验（必查五节，报告固定节）

1. 未闭环发现年龄分布：台账 finding 中状态非 closed 的条数与最老天数；
2. 优化执行率：optimization 记录中 executed/verified/closed 比例；
3. 上次演化提案状态：最近 evolution 记录的状态（proposed/decided/planned/implemented/rebased/reviewed/rejected/deferred）；
4. 设计基线新鲜度：演化相关 design-docs/ADR/spec 是否已回写（按记录 links 核对；无记录则注明不可判定）；
5. 复查完成率：recent executed 的 optimization 是否都有复查记录（verified/closed）。

闭环缺口能机械化者，当场写明「应立判据」并登记为 finding（kind=finding, summary 含「可机械化」），不直接改仓。

### 第 4 步：产报告与三类去向

报告含：范围与抽样清单、发现清单（证据/严重度/类别）、闭环五节、三类去向、下次体检建议。三类去向逐条追加台账记录：

- 漂移/债 → `finding`（status=open）或 `optimization`（status=planned 仅当已有计划任务号，否则 finding）；
- 机会 → `evolution`（status=proposed；含驱动证据与候选路径）；
- 可机械化判据 → `finding`（summary 标记「可机械化」，交后续计划链立 lint）。

### 第 5 步：落报告与收尾

写 `.context/architecture-reviews/<YYYY-MM-DD>.json`：至少含 `schemaVersion`、`date`、`range`、`findings`、`closure`（五节）、`dispositions`（含 evolution 详情对象，与台账 evolution 必填字段同形）、`badLines`。追加 `review` 记录：`{id, kind:'review', ts, summary, status:'recorded', links:{reportRef}}`（`kind:'review'` 是 SessionStart 14 天基线的唯一识别依据）。收尾提示 learnings（一句话 + 证据链接；无收获显式跳过）。

## 台账记录格式（`.context/architecture-feedback.jsonl`，追加式）

每行一个 JSON 对象；字段至少：

- `schemaVersion`: 1
- `id`: 唯一字符串（建议 `<kind>-<YYYYMMDD>-<n>`）
- `kind`: `review` | `finding` | `optimization` | `evolution` | `watch`
- `ts`: ISO-8601 UTC 时间字符串
- `summary`: 一句话
- `status`: finding=`open|triaged|planned|executed|verified|closed`；optimization=`planned|executed|verified|closed|deferred`；evolution=`proposed|decided|planned|implemented|rebased|reviewed|rejected|deferred`；review=`recorded`；watch=`watching|triggered|expired|rejected`
- `links`: 对象，按需含 `findingIds`/`planTaskId`/`evidenceRef`/`recheckRef`/`evolutionId`/`reportRef`
- **evolution 记录额外必填**：`drivers`（五类驱动证据之一或数组）、`candidates`（≥2 条候选路径，含保留/退役对照）、`impact`（影响面与迁移成本）、`risk`（风险与回滚）、`decisionEntry`（建议裁决入口：idea-review / brainstorming / 已定方向计划链）；报告 JSON 的 `dispositions` 中 evolution 详情与上列同形
- 可选：`taskId`、`source`（driver 或审查来源）、`trigger`（watch 的触发条件）、`badLines`（仅 review）

状态只前向推进；状态迁移以**同 id 追加新行**记录、读侧按 `ts` 取最新（`id` 唯一性只约束首次创建，迁移行复用 id 不视为冲突）；watch 必须含 `trigger`（观察项触发条件），未达行动门槛的观察项登记为 watch（status=watching），`review` 记录是提醒阈值的唯一时间基线。

## 架构演化提案（evolution 记录内容）

`summary` 之外按台账必填字段写足：`drivers`（五类之一：外部动态/规模复杂度/技术代际/内部反馈累积/目标变化）、`candidates`（至少两个，含保留/退役对照）、`impact`（影响面与迁移成本）、`risk`（风险与回滚）、`decisionEntry`（方向级 idea-review / 方案级 brainstorming / 已定方向计划链）。本 skill 只登记，不实施。

## 边界与禁止项

- 禁止改代码/配置/文档（报告与台账记录除外）；禁止写 `specs/`、`.sdd/`（写者权限≠实现批准，内部接口-6）；边界句同时明示「不写 `docs/plans/`」。
- 禁止把台账当事实源引用（过程/运行时面，内部决策-039）；跨会话未决规格决策一律 OPEN-n（内部接口-8）。
- 禁止联网、禁止第三方依赖；宿主工具缺失时人工模式（人工提供结构与文档，不降级为猜测）。
- 非 git 项目：不读提交信息、按纯台账模式执行（不阻断）；提醒按激活域判据静默（内部规则-23/内部规则-11）。
- SessionStart 提醒读侧异常一律 fail-open 静默降级（不阻断会话）。
- 体检写侧（`.context/architecture-reviews/` 报告与台账追加）失败必须明确报错并给可执行指引（检查目录可写性/磁盘空间），不得静默丢弃（内部模块-20 内部验收-1/B-M20-3）。

## 与其他 skill 的接口

- 积累面：plan-execution 阶段复审/收尾与 code-review 收尾在既有记录时刻追加架构事实（义务全文唯一载体在 内部模块-20 内部规则-6；本 skill 只读消费）。
- 裁决面：演化提案 → 路由表裁决（idea-review/brainstorming/计划链）；优化候选 → 正常计划链；不自行实施。
- 与 retro/health/learnings：各自职责边界不变（retro 过程指标、health 代码质量评分、learnings 单条经验）。
