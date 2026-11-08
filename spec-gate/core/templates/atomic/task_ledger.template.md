---
templateId: atomic.task-ledger
documentType: task-ledger
validationMode: baseline
allowedPlaceholders: {{TASKS_TABLE}}, {{OPT_OUTS_TABLE}}, {{OPEN_ITEMS_TABLE}}, {{PROJECT_NAME}}, {{LAST_UPDATED}}
atomicSchemaAssetId: schema.task-ledger
---
# 项目任务台账（{{PROJECT_NAME}}）

> 跨会话任务状态的唯一持久位置：快速通道 deadline、任务最终状态、项目级偏好与未决项。
> 宿主无关——任何执行代理读写同一个项目文件（约定位置 `内部治理状态`，机器可读；本模板为人类可读视图）。

- 最近更新：{{LAST_UPDATED}}

## 1. 任务条目

| 编号 | 标题 | 状态 | 快速通道 | deadline | 负责人 | 待补规格 | 待补测试 | 待补追溯 | 最终状态 | 证据引用 |
|---|---|---|---|---|---|---|---|---|---|---|
| {{TASKS_TABLE}} | 逐行填写 | active/converged/temporary-mitigation/expired | 是/否 | 快速通道必填 | 快速通道必填 | 无则「无」 | 无则「无」 | 无则「无」 | complete/partial/blocked/temporary-mitigation | gate report 位置 |

> 超期未收敛的缓解任务必须标记 expired 并阻塞非紧急变更（RULE-LEDGER-002）；
> 收敛必须记录最终状态与证据引用，不得无声消失（RULE-LEDGER-003）。

## 2. 项目级偏好（opt-out）

| scope | mode | 理由 | 创建时间 | 创建者 | 任务标识 | 到期 | 来源机制 |
|---|---|---|---|---|---|---|---|
| {{OPT_OUTS_TABLE}} | persistent/current-task | 逐行填写 | 逐行填写 | 逐行填写 | current-task 必填 | 无则「无」 | 逐行填写 |

> 包含关系与优先级按 RULE-OPT-002 裁决；读回验证失败的记录不得声称持久化成功。

## 3. 未决项（OPEN-n）

| 编号 | 状态 | 负责人 | 影响 | 阻塞性 | 收敛触发 | 证据 | 风险接受依据 | 风险接受触发 |
|---|---|---|---|---|---|---|---|---|
| {{OPEN_ITEMS_TABLE}} | open/resolved/accepted-risk | 逐行填写 | 逐行填写 | 是/否 | 逐行填写 | 引用 | accepted-risk 时必填 | accepted-risk 时必填 |
