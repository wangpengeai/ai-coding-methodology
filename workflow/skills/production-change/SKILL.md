---
name: production-change
description: 生产交付推进：对已存在的 commit/PR/release/change 对象推进 CI 状态核对、生产就绪、发布、部署/安装授权、观测窗口、验收与回滚遏制（机械裁决与凭据统一经 spec-gate 聚合门禁承载） —— 触发条件：用户请求生产就绪评估或推进发布/部署/观测/验收/回滚闭环，且已有可识别对象、无正在发生的 bug/异常/回归（异常优先命中 root-cause-debugging 行）。
license: MIT
---

# production-change：生产交付推进（第 8 行唯一入口）

把"已集成/已打包的候选版本"受控地推向生产验收。本 skill 只编排与授权收集——机械裁决全部经 内部接口-13（`spec-gate/assurance/production.mjs` 与 `gate --claim --change`；gate 面为 `cli.mjs`，3b 后 Python `cli.py` 已删除）；出现任何失败信号（CI 失败、观测阈值越限、上线后异常）**立即回路由表命中 root-cause-debugging**，不在本 skill 内调试（异常与推进互斥，内部决策-009）。

## 适用场景

- 用户状态命中路由表第 8 行：请求生产就绪评估，或 PR/候选版本已存在要推进 CI、发布、部署、观测、验收或回滚闭环。
- 前提对象：branch-finishing 的交接（或等价的 commit/PR/release 对象）已存在；无正在进行的异常。
- 不适用：报障/回归（→root-cause-debugging 行）；只审代码（→code-review 行）；计划层面的上线设计检查（→plan-review，其只查计划是否覆盖上线/观测/回滚，不执行）。

## 推进流程（阶段推进 = CHG 事件；裁决 = claim）

1. **装载交接**：读取 branch-finishing handoff（taskId、base/head SHA、PR refs、required checks、receipt refs、planned version、profile 适用性）；无交接时先回 branch-finishing。
2. **建立/读取变更记录**：
   ```bash
   node <spec-gate 安装根>/assurance/production.mjs --project-root <项目根> init --task-id <任务号> --profile <项目根>/内部治理状态
   node …/production.mjs status --change CHG-n
   ```
   项目无 delivery-profile 且用户有生产意图时，先与用户共同声明（内部决策-010 字段，四 fixture 模板在 `assurance/fixtures/production/profiles/`）。
3. **刷新 PR/CI**：收集 provider-neutral evidence envelope（provider/subjectType/subjectId=head SHA/observedAt/checks[]/approvals[]/sourceRef）——B 期从用户或本地工具输出取得（D 波次 GitHub 适配器自动生成）；信封 subject ≠ 当前对象即停在 pending，不猜测远端。
4. **生产就绪**：`gate --claim merge-ready --change CHG-n --change-context <ctx.json>`（ctx 含逐域状态与对象级证据）逐域处置 required/N/A/waived；N/A 必须带可核查理由，waiver 必须五要素。
5. **release**：确认不可变制品 digest（包/镜像/归档）；套件自身（提供方仓库）的版本折叠由该仓库发布工具的 `bump` 子命令承载（命令与用法见 仓库维护说明「发布」命令节；自带前后自检与失败回滚，属发布操作、非开发变更，内部决策-024；旧入口 `scripts/release-suite.mjs bump` 已移除、调用退 2）；`advance --to release-ready/released`。
6. **部署/安装授权**：向用户呈现执行计划（环境、制品、回滚命令）并**中断等待明确授权**——未授权不执行任何外部副作用（内部决策-2）；授权人写入 change-context（deployAuthorizedBy）。
7. **环境推进与迁移**：逐环境 advance（deployed）；迁移域 required 的项目按事件携带迁移证据（备份/批次/核对）。
8. **观测窗口**：按 profile 推导的时长与 SLI/SLO 收集观测证据；**阈值越限 = 失败信号** → 回滚遏制（advance --to rolled-back，保留证据）→ 回路由表 root-cause-debugging。
9. **UAT**：按 acceptanceAuthority 收集验收证据引用。
10. **claim 顶层**：`gate --claim production-accepted --change CHG-n` 全域裁决。
11. **反馈引用留存**：用户/生产反馈只记引用与摘要（不复制正文），分诊去向回路由表（新价值→idea-review；异常→root-cause-debugging；规格演进→spec-writing）。
12. **收尾**：正常结束提示 learnings 移交。

## 机械裁决命令（唯一事实源：内部接口-13）

```bash
node …/assurance/cli.mjs --project-root <项目根> gate --task-id <任务号> \
  --change CHG-n --claim <merge-ready|production-ready|production-accepted> --change-context <ctx.json>
# 退出码：0=通过；1=内容/政策阻断（逐条处置诊断）；2=工具/配置错误（含无 profile）
```

## 边界与禁止项

- **禁止自建判定/调试**：失败信号一律回路由表（B-M10-1）；本 skill 不读远端状态猜测、不顺手修代码。
- **禁止未经授权的外部副作用**：部署、发布、回滚执行前必须用户明确授权（B-M10-2）。
- **跨机器发布的装机归属**：跨机器发布场景，目标机装机列为源批次的收尾阶段（装机记录引用源任务号 + 可复现命令作 内部接口-21 兜底）；本机装机授权按阶段 6 执行。
- **禁止复制 specialist/清单事实源**：readiness 逐域结论只消费 policy 输出与 gate 诊断（B-M10-3；checklist 见本目录 checklist.md，仅是操作核对单）。
- **不维持版本队列/看板**：单 CHG 记录，外部系统是各自状态的事实源（内部决策-2）。
- 凭据链前置：code-complete（finalize 产物）未就绪时，生产推进在 merge-ready 裁决处被 receipts 节阻断。
