---
name: gate
description: 运行当前项目的 assurance 聚合门禁（冻结 core 套件校验 + 计划校验 + 台账 + 边界 + IF 漂移 + 交付草案 + 凭据链 + revision 双算），汇总为门禁报告并签发 gate receipt —— 触发条件：任何「完成/通过/修好了」类完成声称之前；agent 可自服务调用（用户键 /spec-gate:gate 与本 skill 共享同一流程）。
license: MIT
---

# gate：项目级聚合门禁

本 skill 是 `/spec-gate:gate` 命令与 agent 自服务调用的**单一事实源**：聚合流程全部由 assurance 聚合器（内部决策-007 / 内部规则-13）机械执行，本 skill 与命令都是其薄指针。任何"完成"的声称之前必须过本门禁；门禁未过，完成声称不成立（RULE-FLOW-004）。

## 聚合流程（assurance 聚合器执行）

1. 定位本插件 `assurance/`（插件安装目录下与本 skill 同级；命令面自 内部决策-051 阶段3a 起为 node 入口 `cli.mjs`，要求 Node.js ≥ 21）。
2. 运行聚合 gate（任务号必填，显式计划可选）：

```bash
node <插件根>/assurance/cli.mjs --project-root <项目根> gate --task-id <任务号> \
  [--plan docs/plans/<计划名>.md] [--plan-check-block]
```

3. 聚合器内部依次执行并汇总：冻结 core 套件校验（`--mode suite`，无套件项目走 baseline 聚合）→ 显式计划校验（planCheckBlock：CLI 旗标优先，缺省读 `内部治理状态` 配置，默认仅提醒 内部规则-6）→ 任务台账 → 架构边界（project.json boundaries；坏形态配置产 `RULE-BOUND-CHECK` 阻断并给合法形态样例——数组每条一对象 id/scope/deny/…，定义见 project_config.schema.json）→ active IF 工件漂移 → 交付草案存在性与必检节（判定矩阵结论/证据引用/规格影响判定——缺失产 warning 计入 warningCount，内部规则-12「缺失即 partial」的呈现层；finalize 层拒绝落地）→ 凭据链（revision 一致）→ gate 前后 revision 双算（变化即 `REVISION_CHANGED_DURING_GATE` 阻断）。零阻塞时自动签发 gate receipt（绑定 rev_after 与草案哈希）。
3a. **链内 plan 绑定口径（2026-09-20 使用反馈三批，内部接口-11 v6）**：gate 凭据的 revision 继承链上 verification 绑定的计划（effective_plan）——`--plan` 与链绑定不一致产 `RULE-GATE-PLANBINDING` 阻断（出路：按链上口径重跑，或先 `issue-verification --plan <新路径>` 重签）；链未绑定计划时 `--plan` 仅驱动 plan 节与评审覆盖检查（检查面），凭据不带 plan 桶；报告 `planBinding.source`（chain/explicit-check-only/none）自述口径。finalize 遇「仅 plan 桶不等」会分因报「计划绑定口径不一致」并给同款指引。
4. 按退出码处置：**0**=通过（gate receipt 已签发，可 `finalize`）；**1**=内容阻断，逐条列出诊断 ruleId/位置/修复提示，不得宣称通过；**2**=工具/参数/配置错误，先修复调用环境。
5. 结论必须与报告一致：不满足完成门禁时只能报告 partial/blocked（RULE-FLOW-004）。

## 完成链衔接（内部决策-007）

gate 只是凭据链的一环：完整完成声明 = verification receipt → code-review receipt → `prepare`（草案）→ **gate** → `finalize`（最终报告）。finalize 验证 gate receipt 后才落 `delivery-final.json`——那才是「任务完成」的唯一载体。finalize 成功输出另附 learnings/retro 链尾指引（链尾是经验沉淀的自然触发点；细则归 workflow:learnings，此处不转述）。零变更操作型任务走操作链形态（内部决策-023；内部决策-027 状态断言与分级）：`issue-verification` → `issue-operation`（受理校验强制授权引文/判据（可含 probe 探针，签发验形态）/回滚/边界/操作记录文件/riskLevel 缺省 L2）→ `gate --operation-chain`——**gate 执行探针回读世界状态**（失败 RULE-GATE-OPASSERT 阻断、坏探针 RULE-GATE-OPASSERT-CONFIG 阻断），L1 本地可逆强制 ≥1 探针（零探针 RULE-GATE-OPNOASSERTION 阻断）且免授权复核 warning、delivery 节 skipped-l1 免两阶段报告（完成标记=gate 凭据 riskLevel L1+探针全过）；L2 授权引文恒产 warning 供复核、照常 prepare→finalize。报告节 `operationAssertions` 呈现断言明细；operation 与 code-review 凭据互斥（混链拒绝）。

## 输出与留痕

- 门禁报告要点（模式、各节计数、gate receipt id）留存于交付记录，供 verification 的"完成声称三件套"引用。
- 本 skill 只读校验与核验（凭据由聚合器签发），不手工写 `.sdd/` 文档；修复诊断指出的项归对应流程（spec-writing/计划修订），不在门禁内顺手改。
