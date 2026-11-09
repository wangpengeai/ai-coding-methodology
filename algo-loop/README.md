# algo-loop 插件

算法迭代环纪律：为长期迭代的算法开发提供「指标契约 → 实验台账 → bad case 库 → 复盘抬基线」的纪律环。测量工具链由被治理项目自建——本插件只校验其存在与使用，不解析任何领域数据。

> **实验性质**：本插件未做完整功能验证，接口、行为与文档可能随时变化，不建议用于生产环境。套件整体已停止维护（全新设计的重构项目正在进行），详见根 `README.md`「项目状态」。

- 可选安装（套件第五插件；第六插件 research-loop 为研究环，内部决策-047）；安装与启用见套件 README。
- 触发：项目已立项算法迭代（项目根存在 `.algo/project.json`）或用户显式声明算法迭代/实验调优/bad case 处置意图。

## 环境要求

受支持宿主之一（原生形态＝ZCode 约定，SessionStart 事件；DSH / MCode / Kimi Code 经对应适配层接入，事件映射与降级见各适配层 README）+ Node.js ≥ 21；零第三方包（仅 Node 内置）。

## `.algo/` 五件（被治理项目根，全量入库）

| 文件 | 形态 | 说明 |
|---|---|---|
| `project.json` | JSON | 立项标记（存在即激活路由）；projectId + 契约版本指针 |
| `contract.json` | JSON（版本化） | 指标契约：每指标 name/definition/direction（higher-better 或 lower-better）/unit/toolchain；含基线引用、目标与护栏指标集 |
| `ledger.jsonl` | 追加式 | 实验台账：每轮一行（唯一 id/假设/变更/单变量声明/指标引用/决策） |
| `baselines.json` | JSON | 基线注册表：追加式抬高，旧条目永不删改（B0 为 init 空占位） |
| `badcases/` | 每 case 一文件 | 失败样本：现象/环境/数据引用（只存引用不存数据本体）/状态机（待归因→已归因→已修复验证→闭环，仅前向） |

纪律细则与立项子流程见本插件 `skills/algo-loop/SKILL.md`。

## CLI

命令均在仓库根/插件根执行（脚本位于 `algo-loop/scripts/`）。写侧载荷一律从 stdin 读 JSON（不经 shell 参数）。退出码：**0=成功 / 1=校验或状态失败 / 2=用法错误**（未知旗标、`--project-root` 缺值/空值、项目根不存在或非目录均为 2）；写侧不创建项目根；成功输出首行 `ok <操作> <id>`。

```bash
# 立项（仅用于全新项目：`.algo` 已存在/不完整（缺 project.json）→ 拒绝并列出既有件，不覆盖、不自动修；
# 契约必须过 §2a 校验，project.contractVersion = contract.version，baselineRef 空则归一为 b0；
# toolchain 允许空占位：测量工具链可后建，首轮台账登记前 command 与 version 必须补齐）
node algo-loop/scripts/algo-write.mjs init --project-root <项目根> <<< '{"projectId":"...","contract":{...}}'

# 迭代登记（六要素；同 id 二写被拒；台账缺失/含坏行时停下报修，不重建不追加）
node algo-loop/scripts/algo-write.mjs ledger-append --project-root <项目根> <<< '{"id":"i1","hypothesis":"...","change":"...","singleVariable":{"declared":true,"note":""},"metricsRef":"...","decision":"continue"}'

# 基线抬升（挂来源迭代 id 与原因；旧基线永不删改）
node algo-loop/scripts/algo-write.mjs baseline-register --project-root <项目根> <<< '{"id":"b1","metrics":{...},"fromIteration":"i1","reason":"..."}'

# bad case 登记 / 状态迁移（仅前向，可跳级；坏件迁移停下报修）
node algo-loop/scripts/algo-write.mjs badcase-add --project-root <项目根> <<< '{"id":"c1","symptom":"...","env":"field","dataRefs":[{"kind":"log","ref":"..."}]}'
node algo-loop/scripts/algo-write.mjs badcase-transition --project-root <项目根> <<< '{"id":"c1","status":"已归因"}'

# 只读状态与一致性 lint（坏行计数可见，不自动修；损坏件呈报含字段级细节）
node algo-loop/scripts/algo-state.mjs --selftest
node algo-loop/scripts/check-consistency.mjs --project-root <项目根>
```

## 存量资产处置

本版收紧 §2a 校验（`contract` 需 `baselineRef`/`targets`/`guardrails`、`baselines` 非 B0 条目需非空 `fromIteration` 且 `metrics` 为数值、台账行需六要素与合法 `at`/`singleVariable` 形态）：既有缺字段/空占位资产会被读侧判 `corrupt`、写侧拒绝。插件**不自动迁移**（资产不静默改历史）——按 `check-consistency`/SessionStart 报修行的字段级提示人工修复后继续登记。

## 测试

```bash
node --test "algo-loop/scripts/tests/*.test.mjs"   # 116 项
node algo-loop/scripts/algo-state.mjs --selftest
node algo-loop/scripts/algo-write.mjs --selftest
node algo-loop/scripts/check-consistency.mjs --selftest
node algo-loop/hooks/session-start.mjs --selftest
```

## 约束

- Node ≥21，零第三方包（Node 内置）。
- SessionStart 摘要钩 fail-open：`.algo/` 损坏时报修指引注入（含字段级细节），不阻断会话。
- 域中立红线：schema 字段名与约束语句零领域词，载体/环境为开放枚举（机检：`domain-neutrality.test.mjs`）。
- `.algo/` 五件全量入库；bag/日志/数据集本体不入 `.algo/`，只在 bad case 存引用。
- 写侧前门：project 门（`.algo/project.json` 存在且合法）→ 资产门（台账/基线/bad case 状态）→ 业务门；失败一律退 1 并给修复指引。

## 先验复审义务

本插件规范在首个真实算法迭代项目前定稿（先验设计）：**首个真实迭代任务完成后，须按实战发现修订本插件规范**（契约字段、状态机、CLI 形态均以实战反馈为准）。
