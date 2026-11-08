---
name: scout
description: 探路模式元技能：探索/一次性项目的模式生命周期（开启/续期/毕业/放弃/恢复/迁移/补登）与到期检查点三选一——生命周期由 scout 本地 mode-lifecycle 事务自治，中央台账登记与毕业为可选增强桥（桥缺席时本地模式照常运行） —— 触发条件：需要开关探路模式、到达到期检查点、执行毕业/放弃/恢复/迁移，或任务呈探索性/一次性交付特征经提示确认开启时（workflow 路由表第 16 行命中后进入）。
license: MIT
---

# scout：探路模式元技能

管理项目级探路模式（explore/disposable）的完整生命周期。模式是 opt-in 的低纪律档位：未声明或声明无效时，项目一律回到全量门禁（fail-safe）。v3 起（内部决策-031）模式状态单权威归 scout 本地——`.scout/mode.json` v3 五字段声明 + `.scout/ledger.jsonl` 本地留痕承载审计；spec-gate 为可选增强桥（中央台账镜像登记与毕业，桥缺席时本地模式照常运行）。

## 适用场景

- 用户明确表达探索意图：「这个项目还在找方向」「先跑两周试试」「写个一次性脚本」（任务呈探索性/一次性交付特征：agent 提示、用户确认 mode 与 expiry 后开启——workflow 路由表第 16 行命中，scout 不替用户决定到期日）。
- SessionStart 注入显示模式已过期（到期检查点三选一）、事务待恢复或 v2 声明待迁移。
- 探索产物稳定，需要毕业移交；或决定放弃归档。

## Safety Floor（不可降级底线，内部决策-008）

任何模式下默认禁止：生产凭据与生产数据（默认使用合成或脱敏数据）、部署与共享分支写入、不可逆外部副作用；网络与外部写操作须用户显式授权；临时凭据与数据必须有清理或撤销证据。测试面可降级（scout-repro 档），安全、隐私与数据完整性不随模式降级。

## 生命周期操作（scout 本地事务，内部决策-031 / 内部接口-9 v3）

模式生命周期由 scout 本地完成（锁 + journal + 单文件原子写），不再经 spec-gate CLI 写模式状态：

```bash
# 命令占位：<scout 安装根> 为本插件安装目录（原生布局＝插件根；装机布局＝<mkt>/scout/<ver>）；
# node 按平台直呼；--project-root 可置于任意位置（T13；支持 --flag value 与 --flag=value 两形态）
# 开启（与用户确认 mode 与 expiry 后）
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> open --mode explore|disposable --expiry <到期日> --task-id <任务号> [--owner <负责人>]
# 状态 / 续期 / 放弃归档（处置声明必填，B-M9-3）/ 事务恢复 / v2 一键迁移 / 中央登记补登
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> status
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> renew --task-id <任务号> --new-expiry <新到期日>
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> abandon --task-id <任务号> --disposition "<归档/删除，不并入主干>"
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> recover
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> migrate-v2
node '<scout 安装根>/scripts/mode-lifecycle.mjs' --project-root <项目根> sync
```

操作结果以退出码与 stdout JSON 为准（0=成功；1=内容阻断，按错误语义处置；2=参数错误或工具错误——内部决策-065 T14 的 fs 工具错误以 stdout JSON `{ok:false,code:"tool-error"}` 退 2，无栈）。桥在场时（存在性检测不限版本）open/renew/abandon 自动同步中央台账镜像：登记失败留 pendingSync 且仍退 0（本地权威不反转）；**补登承诺**：桥可用后运行 `sync` 补登（SessionStart 不再提示 pendingSync；check-consistency 仅在桥在场时报中央镜像违例）。事务中断残留（journal）经 `recover` 确定性回滚，恢复前按无模式（全量门禁）。

## 毕业移交（spec-gate 专属增强桥，内部接口-10/12 v2）

毕业是 spec-gate 专属增强——桥缺席时向用户明示不可用（引导 abandon 或安装 spec-gate），不静默降级为本地关闭：

```bash
# <spec-gate 安装根> 定位：同仓开发=仓库根 spec-gate/；装机=与 scout 同级的 spec-gate 目录（不限版本）
# node 入口（内部决策-051 阶段1b 消费面切换；Python 桥入口已退役）。--project-root 任意位置均可（scout-tx 按 argv 扫描）
# 前置：先触发 /spec-gate:backfill 倒推规格、登记 OPEN-n，取得证据引用
node <spec-gate 安装根>/assurance/scout-tx.mjs --project-root <项目根> scout-graduate --task-id <任务号> --evidence-refs '["<backfill/OPEN-n 证据引用>"]'
```

scout-graduate 单事务闭合：中央收敛（converged/complete + gateReportRef）+ 删除本地 mode.json + 追加本地留痕 graduate 事件；前置证据缺失即拒绝，模式保持开启（内部接口-10 错误语义）。

## 到期检查点（三选一，内部规则-6）

expiry 到达时（SessionStart 注入会提醒）必须作出裁决，不得无限续期：

- **继续探索**：`renew`（与用户确认新到期日），桥在场时自动同步镜像。
- **毕业**：走「毕业移交」节流程（spec-gate 桥；桥缺席明示不可用）。
- **放弃归档**：`abandon`（产物标注处置说明，默认不自动删除；确认 disposable 产物未并入主干，B-M9-3）。

## 证据档位（内部规则-8/内部需求-7）

模式内完成声称仍走 verification → code-review，但以 scout-repro 档进入统一凭据链（内部接口-11）：可复现运行（命令+退出码 0+输出摘要）并绑定 taskId/sourceRevision/mode/产物处置；gate 不得将其报告为 full。

## 边界与禁止项

- 禁止 scout 自建任何场景判定表——任务路由永远回 workflow 路由表（B-M9-1）。
- 禁止模式豁免静默发生：开启/关闭/重置/毕业/放弃必须经本地留痕（`.scout/ledger.jsonl`），spec-gate 在场时同步中央台账镜像登记（B-M9-2）。
- 禁止替用户决定到期日：expiry 必须由用户给出或明确确认。
- 禁止绕过本地事务直接编辑 `.scout/mode.json` 或 `.scout/ledger.jsonl`；禁止调用已退役的 assurance 生命周期子命令（scout-open/scout-status/scout-renew/scout-abandon/scout-recover——内部决策-031 退役，调用退 2 并给迁移指引）。
