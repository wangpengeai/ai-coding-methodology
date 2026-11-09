# AI Coding 方法论套件

把 AI 结对开发从「随手改」变成**有流程、有证据、有门禁**的工程方法。六个可独立安装的插件覆盖「想法评估 → 需求澄清 → 计划 → 评审 → 执行 → 调试 → 评审验证 → 收尾沉淀」全流程，并延伸到编码强相关域的科研方法论。

这是完整的 **AI Coding 与研究方法论（域锚定＝算法研究、计算机科学、软件工程）**。同一套资产、同一种纪律，可运行在 ZCode、DeepSeek Harness、MiniMax Code、Kimi Code 四个宿主上。本仓库同时是这套方法论的开发仓库；方法论的设计规范（`specs/`）与开发过程记录（`docs/`）不随源码公开。

## 项目状态

- **不再维护**：本仓库已停止维护，不再接受功能更新与缺陷修复。全新设计的重构项目正在开发中，重构版发布后以它为准。
- **实验性模块**：`algo-loop` 与 `research-loop` 为实验性质，未做完整的功能验证；接口、行为与文档可能随时变化，不建议用于生产环境。
- **成本提示**：本套件会显著增加 token 消耗——每次任务都要经过路由注入、计划、评审、证据与门禁环节——对成本敏感者慎用。

## 这套东西解决什么

- **流程不跳步**：任何开发任务先经唯一路由表命中场景，再进入想法评估、计划、执行、调试、评审或收尾。
- **完成有证据**：声明完成前必须真实运行验证命令；规格校验、测试、评审与门禁留下可复核证据。
- **跨宿主可迁移**：同一套六插件资产通过适配层落到不同宿主；项目级技能放在跨宿主共同发现根 `项目级技能`。

## 六个插件

| 插件 | 做什么 |
|---|---|
| **workflow** · 工作流 | 对话式开发流程引擎：workflow 的 20 个技能构成唯一路由体系，配危险命令护栏、任务租约、编辑冻结、完成闸与三只读 agent |
| **spec-gate** · 规格门禁 | 规格资产治理与机器校验：规格与计划校验器、聚合完成门禁、任务台账与证据捕获 |
| **scout** · 探路 | 探索性项目与一次性交付物的项目级低纪律档位：模式声明、到期检查点、毕业移交 |
| **team-governance** · 团队治理 | 可选：AI Run Manifest、模型策略、协作租约、内容绑定审批、replay 评测与治理报告 |
| **algo-loop** · 算法迭代（实验性） | 可选、实验性质（未做完整功能验证）：指标契约、实验台账、bad case 库与基线注册表（`.algo/` 五件状态机制） |
| **research-loop** · 研究假设与实验设计（实验性） | 可选、实验性质（未做完整功能验证）：竞争解释生成、预注册卡、CS 实验设计决策树；零钩子零状态，显式研究意图触发 |

安装粒度：`workflow` 是核心件、必装；`spec-gate` 需要项目接入 `.sdd/` 后发挥作用；其余四个按项目需要安装，不装不影响其他模块。

## 选择宿主

| 宿主 | 安装方式 | 详见 |
|---|---|---|
| ZCode | 市场安装六插件；新机可用 `node zcode-adapter/cli.mjs install --bootstrap` 冷启动 | `zcode-adapter/README.md` |
| DeepSeek Harness（DSH） | `dsh plugin --profile <profile> add link:<本仓库检出路径>`（CLI 需钉兼容版本） | `ai-coding-methodology/README.md` |
| MiniMax Code（MCode） | `node mcode-adapter/cli.mjs install` 物化本地包到宿主数据目录 | `mcode-adapter/README.md` |
| Kimi Code | `node kimi-code-adapter/cli.mjs install` 直写宿主 `plugins/managed/` | `kimi-code-adapter/README.md` |

各宿主的能力差异（哪些面原生可用、哪些降级、哪些待真机取证）见对应适配层 README 的「能力摘要」或「已知限制」节。机械包映射测试通过不等于宿主 UI/真机会话已验证。

## 最短上手链

1. **选宿主并安装**：按上表进入对应适配层 README 执行安装。
2. **装最小组合**：只装 `workflow` 即可开始；需要规格门禁时再装 `spec-gate` 并运行 `/spec-gate:init` 接入项目。
3. **跑首任务**：新开会话，直接描述任务（或 `/feature-dev <任务描述>`）——元技能路由表随会话注入，按场景唯一命中入口技能。
4. **生效核验**：新开一个会话，按对应适配层 README 的冒烟清单检查 SessionStart 注入、护栏触发、路由表命中与命令可达，并回填观察记录。
5. **失败恢复/重装**：钩子默认 fail-open（异常静默、不阻断会话）；唯一例外是 check-freeze 对不可读负载的 DENY。怀疑失效时，ZCode/MCode/Kimi 先跑对应适配层的 `verify` 核对漂移，再重跑 `install`（幂等、写后即验、失败回滚）；DSH 用 `dsh plugin --profile <profile> add link:<路径>` 重新 link。ZCode 侧旧版本 cache 目录**不要手工删**。

## 开发与维护说明

本仓库的规格体系（`specs/`）、开发过程记录（`docs/`）、项目级技能（`.agents/`）与内部验证工具链（仓级 `scripts/`、`tests/`）**不随开源发布**；公开面只含产品源码与本仓库根门面文件。贡献者可从各插件 README 的「环境要求」「验证命令」节进入；维护者发布/装机入口见下节。

## 维护者入口

- **发布**（六插件统一版本成套发布）：`node zcode-adapter/cli.mjs publish --marketplace <市场源目录>`——先跑完整验证集，再同步市场源与清单。
- **装机**：`node zcode-adapter/cli.mjs install`；版本折叠 `node zcode-adapter/cli.mjs bump --version <X.Y.Z> --note "<摘要>"`；七面只读核对 `node zcode-adapter/cli.mjs verify`。
- 各插件与适配层自带验证命令；本仓库的内部验证工具链（仓级 `scripts/`）与规格、过程记录不随开源发布。

## 文档地图

| 文档 | 读者 | 用途 |
|---|---|---|
| `README.md` / `README.en.md` | 人类使用者与贡献者 | 套件定位、宿主选择、上手与维护入口 |
| `<插件>/README.md` | 使用者与贡献者 | 各插件能力、安装、环境要求与验证命令 |
| `<适配层>/README.md` | 各宿主用户 | 安装方式、能力差异与已知限制 |

## 环境要求

受支持宿主之一（事件钩子支持面见各插件 README「环境要求」）+ Node.js ≥ 21（唯一硬性要求——验证命令 `node --test "<glob>"` 形态与测试内 `import.meta.dirname` 均需 Node 20.11+；内部未决-15 已裁决取 ≥21 口径，推荐 22+；bash 可选——仅影响 verify-gate 声明命令的执行 shell 语义，四级探测自动兜底）。

## 许可

MIT。第三方来源致谢见根 `LICENSE` 补充说明与各插件 `LICENSE`/`NOTICE`。
