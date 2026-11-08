# AI Coding 方法论 · 规格门禁（spec-gate）—— 规格资产治理与机器校验

SDD（规格先行）+ DDD（领域建模）+ TDD（红绿重构）方法论的**可校验资产层**：66 条规则注册表、17 个 JSON schema、54 个模板、四+一模式校验器（template/draft/baseline/suite/**plan**）、跨会话任务台账与证据捕获。本插件是规格资产的治理者与校验者——执行流程（怎么做）由 `workflow` 插件承载。

- **做什么**：把「先写规格/计划、完成前有证据」变成机器可判——规格文档结构校验（blocking/warning 分级）、计划引用悬空拦截、完成门禁 `/spec-gate:gate`（聚合规格校验、TDD 证据、两阶段交付报告与治理报告）、超期任务台账提醒。
- **何时用**：项目接入 `.sdd/`（`/spec-gate:init`）后，任何「声称完成」都应过本插件的门禁；未接入的项目可独立使用 `workflow`，但完成声称只有自律没有判据。
- **限制**：校验器只判「结构与证据链」，不判「内容对不对」（内容质量归计划评审与代码评审）；core 校验器与工具为 Node 内置实现（内部决策-051 阶段4），无第三方依赖。

## 证据档位：full 与 scout-repro

完成证据按项目档位分两档，真实性、脱敏与安全底线两档同等不减：

- **full 档**（默认）：每条证据须关联 `ruleId`/`specId`，可被反查到规格条目——常规治理项目的完整格式约束；未关联时 warning 提醒。
- **scout-repro 档**（探路项目）：不强制逐条关联，但必须留**可复现命令、退出码 0、输出摘要**及任务号/源版本/模式/产物处置绑定——探路项目毕业移交后证据仍可复算；该档不得被报告成 full。

档位由项目模式决定（探路模式经 `scout` 插件声明），门禁按档位裁剪检查强度，不因低档位豁免「命令真实运行过」这一前置。

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 宿主 | 受支持宿主之一：原生形态＝ZCode 约定（hooks.json 与 SessionStart / PostToolUse 事件）；DSH / MCode / Kimi Code 经对应适配层接入，事件映射与降级见各适配层 README | 事件缺失时钩静默不生效（fail-open） |
| Node.js | ≥ 21（推荐 22+） | 两个 `.mjs` 钩、assurance CLI（`cli.mjs`，阶段3a 起 gate/cli 命令面）与 core 校验器/工具（`validate_specs.mjs` 等，阶段4 起）的运行时 |
| Python | 无（阶段5 内部任务-153 起零 Python 棘轮） | core 校验器/工具与 assurance 均为 Node 实现；Python 解释器探测面与编码环境变量面已退役；`cp-python-hardcode`/`cp-python-source` 机械拦截回流 |
| 第三方包 | 无 | npm / pip 均零依赖 |

## 安装

ZCode 中将本目录注册为插件（`.zcode-plugin/plugin.json`）。首次在项目中启用：`/spec-gate:init`（生成 `内部治理状态` 与 suite 骨架）；冷启动建规格体系：`/spec-gate:backfill`。AI Coding 方法论六件套之一：核心件 workflow，可选配套 scout / team-governance / algo-loop / research-loop（内部决策-017）。

`/spec-gate:init` 附带 .gitignore 推荐条目自动应用（内部决策-043）：条目唯一事实源 `assets/gitignore-template`，应用脚本 `scripts/apply-gitignore.mjs`（行级幂等合并、语义冲突列举留人裁决、`--dry-run` 预览；内部接口-21 v2）。

启用后验证：在已接入 `.sdd/` 的项目中新开会话，观察台账提醒（SessionStart）；完整装机首验清单见 内部冒烟检查单（不随源码公开）。

## Skills（4）与命令（5）

| 资产 | 用途 |
|---|---|
| `sdd-ddd-tdd` | SDD/DDD/TDD 适用性判定矩阵与门禁裁决（触发权在 workflow 路由表，内部接口-2） |
| `spec-writing` | 单次规格变更写作权威（七条纪律，含"先读代码再盘问"） |
| `spec-backfill` | 从代码建立规定性规格体系（六阶段、证据台账、三校对点） |
| `gate` | 聚合门禁单一事实源（命令 `/spec-gate:gate` 为其薄指针；assurance 聚合器见下） |
| `/spec-gate:gate` | 完成门禁唯一聚合入口（含 plan 校验节） |
| `/spec-gate:init` `/spec-gate:spec` `/spec-gate:backfill` `/spec-gate:evidence` | 接入 / 转规格写作 / 转体系建立 / 证据捕获 |

## assurance 外扩层（内部决策-007）

完成判真凭据链（RevisionSet / 任务凭据 / 两阶段交付报告 / 聚合 gate / Scout 增强桥——register 中央镜像登记与 graduate 毕业，内部决策-031）位于 `assurance/`（JS 实现；Python 参考面已于 3b 删除；冻结 core 之外；内部决策-051 阶段1b/3a）：

```bash
node assurance/cli.mjs --project-root . gate --task-id TASK-n [--plan 内部计划 --plan-check-block]
```

`spec-gate/core/**` 与 `core-baseline.sha256` 保持哈希冻结（内部规则-9）。

## plan 校验模式（内部接口-1）

```bash
node core/validator/validate_specs.mjs --mode plan --config 内部治理状态 --plan <计划路径>
```

计划 frontmatter `specRefs` 引用悬空 → blocking（退出 2）；缺 specRefs / 步骤缺「验收：」行 → warning（默认提醒不阻断）。`/gate`（suite 模式）自动聚合 `docs/plans/*.md` 的校验结果为独立 plan 节。

## Hooks（2，均 fail-open）

- SessionStart：台账提醒（超期快速通道任务、blocking 未决项）
- PostToolUse|Write|Edit：受检文档写入时跑校验器（默认仅提醒；`ZCODE_USER_CONFIG_SDD_HOOK_BLOCK=true` 后 blocking 阻断）

## 内核完整性

`core/` 与 `core-baseline.sha256` 哈希锁定（登记变更 内部变更-1..22 见基线文件头部；内部变更-9 起哈希按仓库 LF 内容计算，仓库以 `.gitattributes` 保证行尾一致；内部变更-10 起测试套件布局无关，仓库/市场源/宿主缓存三种安装位置均可全绿）；`core/validator/tests/` 173 项 JS 测试与 24 项 fixture 验收全绿是发布前置（pass/skip 拆分随平台与权限变化，以本机实跑记录为准）。基线核对（机器校验唯一口径，跨平台）：`node scripts/verify-core-baseline.mjs`（类 Unix/Git Bash 人工可选：`cd spec-gate/core && sha256sum -c ../core-baseline.sha256`）。

`spec-gate/assurance/tests/golden/` 为历史 `spec-gate/assurance/tests/gen_golden.py` 的生成物，向量只读禁手改（手补条目会被再生静默回滚；篡改经「再生＋三角归因」证伪——内部决策-051 D4，内部任务-60 计划评审 F7）；该生成器已于 3b（C2）删除，向量仍由 JS 测试消费（见 `spec-gate/assurance/tests/golden/README.md`）。

<!-- lint:allow(assurance-command-surface) 迁移说明：旧入口已删除，保留旧命令形态供识别 -->
迁移说明（3b，2026-10-19）：Python assurance 入口已删除。旧命令 `python3 spec-gate/assurance/cli.py …` / `python3 spec-gate/assurance/production.py …` 会得到 `No such file or directory`（Windows：系统找不到指定的路径）。改用 `node spec-gate/assurance/cli.mjs …` / `node spec-gate/assurance/production.mjs …`。仓外支持边界：本仓 3b 起不再提供 Python assurance 入口；core 已在阶段4 JS 化（内部决策-051），消费方迁移指引见 `内部迁移指引`。

## 许可

MIT（见 LICENSE）；历史派生自 sdd-methodology（MIT，wangp），自阶段4（内部决策-051 D2）起以本仓为唯一事实源；core 目录按 内部规则-9 保持基线一致。
