---
name: algo-loop
description: 算法迭代环纪律：立项立指标契约与基线、实验台账逐轮留痕、单变量归因、bad case 库状态机、复盘抬基线；测量工具链由项目自建，插件只校验其存在与使用 —— 触发条件：项目已立项算法迭代（.algo/project.json 存在）或用户显式声明算法迭代/实验调优/bad case 处置意图，且无进行中获批准计划时（workflow 路由表算法迭代行命中后进入；插件未安装时本行不生效，安装指引见套件 README）。
license: MIT
---

# algo-loop：算法迭代环纪律（迭代内环入口）

把「改一轮看一眼」的算法迭代变成可归因、可复盘、可抬基线的纪律环。本 skill 编排六环节；机械读写经本插件 CLI（`algo-write.mjs`/`algo-state.mjs`/`check-consistency.mjs`），测量工具链由被治理项目自建——插件不解析任何领域数据。

## 适用场景

- 项目根存在 `.algo/project.json`（已立项），本轮任务是算法迭代/实验调优/bad case 处置。
- 用户显式表达算法迭代意图但项目**未立项**：先走立项子流程（下节），再进入迭代环。
- 与计划链的关系：存在进行中获批准计划时计划优先（先按计划执行）；迭代环纪律在计划执行期间照常约束台账登记。

## 立项子流程（未立项时）

1. 与用户确认：要优化的对象、候选指标（名字、定义、方向 higher-better/lower-better、单位）。
2. 确认测量工具链：若尚未建成，允许先立项（契约 toolchain 留空占位），但**首轮台账登记前必须补齐**——没有可复现的指标产出，迭代就是拍脑袋。
3. 执行立项（机械落盘，禁手写五件；**仅用于全新项目**）：
   `node <插件根>/scripts/algo-write.mjs init --project-root <项目根>`，stdin 喂 JSON：`{"projectId":"<标识>","contract":{"schemaVersion":1,"version":1,"metrics":[{"name":"...","definition":"...","direction":"higher-better","unit":"...","toolchain":{"command":"...","version":"..."}}],"baselineRef":"b0","targets":{},"guardrails":[]}}`
   - 失败语义：`.algo/project.json` 已存在 → 幂等拒绝；`.algo` 存在但不完整（缺 project.json）→ 拒绝并列出既有件（**不覆盖、不自动修**，人工处置后重试）；契约不合 §2a → 拒绝且零残留；`project.contractVersion` 跟随 `contract.version`；`baselineRef` 空则归一为 `b0`（非空且非 b0 拒绝）。
   - 台账追加与状态迁移走同一写侧前门：project 门 → 资产门 → 业务门；台账缺失/含坏行、契约或基线损坏、bad case 坏件一律停下报修（不重建、不自动修）。
4. 首轮实测后的首个基线：跑项目自建工具链测一轮 → 先 `ledger-append` 登记首轮（id 如 i0）→ `baseline-register` 把实测值登记为 b1（fromIteration 挂该轮 id、reason 写「首轮实测基线」；**fromIteration 必填**——init 注册的 B0 是空占位基线，不经本操作）。
5. 提示：`.algo/` 五件全量入库（纪律资产跨机可见；bag/日志/数据集本体不入 `.algo/`，只在 bad case 里存引用）。

## 迭代环（每轮）

1. **假设**：明确本轮要验证什么（一句话，写入台账 hypothesis）。
2. **变更**：改什么——**每次只改一处**（singleVariable.declared 如实声明；改了两处就声明 false 并说明——归因纪律的根基，复盘时核验）。
3. **实验**：跑项目自建工具链产出指标（可复现命令记录在案）。
4. **登记**：`ledger-append`，stdin 喂六要素：`{"id":"<轮次唯一id>","hypothesis":"...","change":"...","singleVariable":{"declared":true,"note":""},"metricsRef":"<工具链输出指针>","decision":"continue|rollback|raise-baseline|to-release"}`。
5. **bad case**：现场/仿真数据发现失败样本 → `badcase-add`（symptom/env/dataRefs——载体只存引用）；归因后 `badcase-transition`（状态机仅前向：待归因→已归因→已修复验证→闭环，可跳级不可回退）。
6. **抬基线**：指标稳定优于当前基线 → `baseline-register`（挂来源迭代 id 与原因；旧基线永不删——抬高留痕）。

## 复盘（周期性或阶段目标达成时）

- 跑 `check-consistency`（五件一致性：契约版本/基线引用/metricsRef/坏行/toolchain 补齐）。
- 核验台账 singleVariable 声明：false 的轮次逐条看是否是归因债。
- 抬基线建议与契约修订建议（修契约=version 递增+台账记因）。

## 错误语义指引

- 坏契约/坏台账：CLI 停下报具体字段错并给修复指引，**不自动修**（资产不静默改历史）——先修复再继续登记；SessionStart 报修与 lint 呈报含字段级细节（`corruptDetails`）。
- 坏行（不可解析/缺六要素/字段空串或类型不符/`at` 非 ISO）≠ 损坏件：以坏行计数可见呈报；追加前遇坏行拒绝（不重建、不追加）。
- 同 id 重复登记：写侧拒绝（幂等键冲突）；崩溃撕裂行读侧计数呈报（摘要与 lint 可见）。
- toolchain 补齐：首轮台账追加前 `command` 与 `version` 均须非空（两者同权）；lint 对既有台账行 + 未补齐契约报 violation。
- 退出码：0=成功 / 1=校验或状态失败 / 2=用法错误（未知旗标/缺值/项目根不存在或非目录）；成功输出首行 `ok <操作> <id>`。

## 与其他 skill 的接口

- 完成声称：仍走 verification → code-review（证据含台账轮次与 check-consistency 输出）。
- 调试：迭代中发现缺陷回路由表命中 root-cause-debugging（不在本 skill 内调试）。
- learnings：收尾时按惯例提示记一条（允许显式跳过）。

## 边界与禁止项

- 禁止自建场景判定表（判定唯一性在 workflow 路由表）。
- 禁止解析领域数据（bag/日志/数据集/模型权重）或内嵌领域指标计算——工具链归项目。
- 禁止自动修复损坏资产（契约/台账/bad case/基线一律停下报修）。
- 禁止 schema 字段名、枚举缺省值与约束语句出现领域词（域中立红线，机检承载：domain-neutrality 测试）。
