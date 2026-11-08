---
description: 运行当前项目的 assurance 聚合门禁（冻结 core 套件校验 + 计划 + 台账 + 边界 + IF 漂移 + 交付草案 + 凭据链 + revision 双算），签发 gate receipt
argument-hint: --task-id TASK-n [--plan 内部计划] [--plan-check-block]
skills: gate
---
本命令挂载 **skills/gate/SKILL.md**（聚合流程的单一事实源），是 assurance 聚合器（内部决策-007 / 内部规则-13）的薄指针：

```bash
node <插件根>/assurance/cli.mjs --project-root <项目根> gate --task-id <任务号> [--plan <计划路径>] [--plan-check-block]
```

退出码：0=通过（gate receipt 已签发，后续 `finalize` 落最终报告）；1=内容阻断（逐条处置诊断，不得宣称通过）；2=工具/参数/配置错误。agent 完成声称前的自服务调用直接进入 spec-gate:gate skill，与本命令等价。

冻结 core 工具链衔接（AC-PLUG 命令-工具引用契约）：聚合器内部的「冻结 core 套件校验」节由 `validator/validate_specs.mjs` 承载，其项目级门禁封装为 `validator/tools/sdd_check.mjs`（规格文档校验 + 任务台账检查，`--project PATH`）；assurance gate 聚合其结论并追加计划/边界/IF 漂移/凭据链/revision 双算各节。

用户参数：$ARGUMENTS
