# AI Coding 方法论 · 工作流（workflow）—— 对话式开发流程引擎

套件核心件（ZCode 插件）：把"想法评估 → 需求澄清 → 计划 → 评审 → 执行 → 调试 → 评审验证 → 收尾沉淀"的开发全流程固化为 **20 个 skill 的唯一路由体系**：任何开发任务先查元技能路由表，按用户状态唯一命中入口 skill，双重触发在结构上不可能。

- **做什么**：给 AI 结对开发装上「流程 + 护栏 + 完成闸」——场景路由防跳步（先计划后执行、先证据后评审）、危险命令拦截、任务租约（写操作须持本会话有效租约）、目录编辑冻结、声明式完成闸（声明的验证命令真实跑绿才许声称完成）、过程留痕与经验沉淀。
- **何时用**：常规开发任务（新功能、修 bug、重构、发布推进）都应处于本插件路由表的某个场景档位内；探索性项目与一次性交付物可改走 `scout` 插件的低纪律档位（见其 README）。
- **限制**：护栏工作在提示词与工具调用拦截层，**不是沙箱**——Bash 命令经护栏判定后仍会被真实执行；纪律面依赖宿主正确触发事件钩子，事件缺失时对应钩静默不生效（fail-open，不阻断会话）。

## 规划阶段写面（行为说明）

处于计划场景（已声明 `plan-writing` / `plan-review`）时，租约闸对写操作施加**固定写面**：Edit/Write 只允许落在 `docs/plans/`（含既有历史计划目录）下的 Markdown 计划文件（含子目录）；目录、非 Markdown、经链接逃逸出计划目录的目标一律拒绝，`--change-scope` 声明只能与该上界求交收窄、不能扩权。**Bash 不受该上界限制**——写面只约束文件写工具，规划阶段仍可用只读勘察与验证命令（明示：这不是 shell 沙箱）。写者权限不等于执行批准：拿到规划写面只授权写计划文档，计划仍须经 `plan-review` 评审通过才可进入执行；发现规则与任务目标冲突时记入计划呈报裁决，不得先改规则自授权。

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 宿主 | 受支持宿主之一：原生形态＝ZCode 约定（hooks.json 与 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse(Failure) / Stop 事件）；DSH / MCode / Kimi Code 经对应适配层接入，事件映射与降级见各适配层 README | 事件缺失时对应钩静默不生效（fail-open）；事件全集以 hooks.json 为准 |
| Node.js | ≥ 21（推荐 22+） | 全部钩子的运行时（2026-09-15 内部未决-14 批次起三护栏/完成闸均为 Node 实现；内部任务-261 后增 write-guard 共四护栏） |
| bash | 可选 | verify.gate 声明命令在探得 bash 的机器按 `bash -c` 语义执行（四级探测：`VERIFY_GATE_SHELL` 注入 > PATH > Git 惯例位置 > 系统 shell 兜底）；无 bash 时按系统 shell 语义执行 |
| 第三方包 | 无 | 仅 Node 内置 |

## 安装

ZCode 中将本目录注册为插件（`.zcode-plugin/plugin.json` 约定式加载）。AI Coding 方法论六件套核心件：与 `spec-gate`、`scout`、`team-governance`、`algo-loop`、`research-loop` 配套使用效果最佳（协作契约 内部规格接口注册表（不随源码公开）），也可独立使用；套件统一版本发布（内部决策-017）。

启用后验证：新开一个会话，观察元技能路由表是否注入（SessionStart）；完整装机首验清单见 内部冒烟检查单（不随源码公开）。

## Skill 清单（20）

| 场景 | 入口 skill | 触发条件 |
|---|---|---|
| 元层 | `workflow` | 会话开始/任务到来/场景切换（SessionStart 自动注入） |
| A 想法评估 | `idea-review` | 「想做/要不要做/评估一下」且无 spec |
| B 需求澄清 | `brainstorming` | 任务已明确但方案未定 |
| C 计划 | `plan-writing` | 有设计决策要落成计划 |
| C 计划评审 | `plan-review` | 计划存在且未经评审（强制出口门） |
| D 执行 | `plan-execution` | 计划已批准（三模式：顺序/子代理/并行） |
| E 调试 | `root-cause-debugging` | 报 bug/异常/回归（互斥规则 1：禁 plan-execution） |
| 生产交付 | `production-change` | 已有 commit/PR/release 对象，要推进 CI、发布、部署、观测、验收或回滚（内部决策-009；出现失败信号回调试行） |
| F 验证评审 | `verification` → `code-review` | 声称完成前（互斥规则 2：证据先于评审） |
| G 收尾 | `branch-finishing` / `retro` / `learnings` / `health` | 测试全绿后 / 周期节点 |
| 架构演化 | `architecture-evolve` | 周期节点：用户要求架构体检/架构演化评估，或 SessionStart 架构体检提醒命中（内部决策-052） |
| 外部动态 | `external-radar` | 周期节点：用户要求外部动态跟踪/情报内化，或 SessionStart 外部动态提醒命中（内部决策-052 二期） |
| 随行 | `code-discipline`（改多少 + 用什么改）、`doc-discipline`（文档与注释写什么）、`tdd`（怎么验证）、`writing-skills`（写技能） | 实现期随行 |

命令：`/feature-dev [描述]` 七步薄编排。Agents：`code-explorer`（勘察）、`code-architect`（多方案设计）、`code-reviewer`（≥80 置信度评审）——只读定位；其中 `code-reviewer` 工具面含 Bash，约束为 内部决策-028 提示词层四命令白名单（非纯只读，勿写成「全部只读」）。

## Hooks（6 类事件，9 个 process；process 按去重脚本数计）

- SessionStart：注入元技能（fail-open）；非仓无标记环境追加 scout 评估轻提醒（只提醒不执法，内部决策-044/内部规则-17）；护栏健康自检告警（内部任务-8）与证据老化归档（内部任务-79）同帧承载
- UserPromptSubmit：路由提醒 + 护栏失效哨兵（套件级五插件前缀归因落盘——research-loop 当前零钩子不入该面，未来加钩须同步哨兵前缀清单；与同会话宿主按停 v4.stop 事件时间相邻的 hook 失败视为停机噪音，不计入不告警，内部决策-020）+ **任务租约挑战签发**（每轮 prompt 注入 leaseId，内部规则-8）+ 自察（用户纠正捕获 + 待排查指针，指针口径按 cause 派生、归属三分并拆出证据面，内部决策-019/内部决策-063）
- 自察 CLI（内部决策-063）：`node scripts/incident-cli.mjs list|triage|resolve|archive|lease|emit|promote|digest|--selftest`——`emit` 供适配层上报观测事实（内部接口-26），`promote` 只产 `内部工作流状态` 草案，`digest` 汇总 lost-facts/分类热度；`list --json` 增 `rulesVersion/countsByCause`。
- PreToolUse（**省略 matcher 键＝全命中**，内部任务-8/内部规则-17）：工具族在**钩内**判定（shell 族=危险命令护栏；shell+edit 族=任务租约闸；edit 族=目录编辑冻结；shell 写意图=写仓闸 enforce（C1-C4 deny、C5 shadow，内部任务-261/内部决策-066 D8）；other 族静默放行）——旧词表写法（`Bash` / `Bash|Edit|Write` / `Edit|Write`）在 DSH 的 `pwsh`/`edit`/`write` 上恒不匹配、护栏整体空转（RC-0），不得回退；工具族单源见 `scripts/lib/tool-families.mjs`；SessionStart 增四护栏合成冒烟健康自检（告警不阻断）。**受检路径分级（2026-11-02 内部任务-285/内部决策-066 修正案 1）**：写仓闸对**git 跟踪文件**（受检路径）从严——C1 重定向写受检路径直接拒绝（任何声明不放行，文案指引 Edit/Write 或受信写者）；C2 就地编辑/C3 内联写 API/C4 heredoc 喂解释器仅认更窄声明 `routing-declare --script-edit-code '<理由≥8 字>'`（租约 `scriptEditCode[]`＋`wf-script-edits.jsonl` 审计），通用 `--script-write` 不足；目标解析不出/非跟踪维持现行行为；`trackedTier` 默认 enforce、`内部工作流状态` 可降 shadow（journal `wouldBeDeny/tier` 可见）；git 不可用记 degraded 不冒充 clean；目标解析为启发式、不承诺不可绕过。**写仓闸启发式修正（2026-11-06 内部任务-339/内部未决-254 ①-⑥）**：混合形态重定向受检目标**逐目标恒拒**（与宿主类无关——不因判为 C2/C3/C4 而开放窄声明；内部模块-8 内部规则-27 ⑧）；C2 命中与目标抽取为引号感知 token 单源（「被执行」引号载荷逐层递归、echo 类字面量提及放行）；win32/darwin 折叠按 `core.ignorecase=false` 显式关闭（读失败回落平台默认并记 `ignorecaseReadFailed`）；journal 增 `trackedTierViolation`、`wouldBeDeny`＝「enforce 档会拦」。
- PostToolUseFailure / PostToolUse（**省略 matcher 键＝全命中**，内部规则-17；旧词表形态 `PostToolUse|Bash|Edit|Write` 与 PreToolUse 同款不匹配问题不得回退）：**自察捕获与分类**（结构化事实唯一判据；v2 分类规则表按 cause/severity 分类并写归因字段；重试环；记录项目根 `内部工作流状态`，内部决策-019/内部决策-063）；**AskUserQuestion 答复通道只读租约提示**（内部任务-352：ask 成功 ∧ 本轮未声明 ⇒ PostToolUse 非决策 additionalContext 重述令牌/声明命令，零签发零激活，内部模块-8 内部规则-8/内部验收-47）
- Stop：自察收尾提醒（task-recap，本 turn 新增待排查汇总＋三分组＋promotion 待转正行；内部决策-063）＋归属清单行（待排查面 ∩ 本任务/本会话，证据面不计、恒 N＝本任务+本会话；内部决策-041 修正案 1 / 内部决策-063 修正案 4）+ learnings 沉淀提醒（learnings-recap，已 finalize 且 经验记录 无记录的任务一行轻提醒，首跑种子+逐任务一次，内部规则-9）+ verify-gate 声明式完成闸（项目根 `verify.gate` 声明验证命令 + sha256 信任存储；未声明零影响）。**learnings 写入时点（内部规则-3/内部规则-9，内部任务-193）**：learnings 在 verification 签发前写（冻结前完成）；finalize 后 Stop 提醒只作「遗漏信号」，不得回写历史任务——遗漏的在下一任务开头补记（verification 签发后写 learnings 会破完成链）。

豁免审计（内部接口-20 v2）：显式豁免（`--exempt` 逐字引文 + `--exempt-scope plan|review` + `--exempt-src`）与用户显式退役（`--exempt-revoke` + 撤销原话 + 已评审计划）经声明命令统一落项目根 `内部工作流状态` 持久留痕（schemaVersion 2；scope=review 计划须含 `豁免引文：` 行）；租约随 token 轮换即删，该文件是唯一持久豁免记录。gate 呈现节只 warning，`exemptAnchor` 对无计划锚的 v2 豁免不签 full 链（内部决策-067）。

## 与 spec-gate 的协作（摘要）

- 规格落盘永远走 spec-gate（spec-writing），本插件不写 `.sdd/`
- 计划进入执行前过 spec-gate 适用性判定矩阵；完成声称前跑 `/spec-gate:gate`
- hotfix 三分类（事故/热修/原型）在本插件 root-cause-debugging 判定，登记与超期阻塞在 spec-gate 台账
- 完整契约：内部规格接口注册表（不随源码公开）（workflow↔spec-gate 核心协作 内部接口-1..8；另有运行自察 内部接口-19、豁免审计 内部接口-20 等按需对接，全部 active）

## 号空间与取号规则（内部任务-227；内部决策-061）

- **谁能取号**：顶层交付会话（delegationDepth=0）；委派子会话不得自取新号，必须继承父链当前交付任务号（DSH 负载 `parent_session_id`＋挑战体 v5 `inheritTaskId`）。
- **历史号为什么拒**：仅被审计源（git 提交 subject／traceability-matrix／incidents 台账）占据且无交付面痕迹的号禁止复用——受理侧返回逐源清单与三路指引。
- **被拒三步**：①续用原任务：`--resume-task --resume-reason "<≥8 字>"`（须 issued 台账有历史 issuance）；②取新号：`--suggest-task-id`；③跨机/跨会话按让号协议。人工指定号仅限操作者裁决：`--manual-task-id <号> --manual-reason "<≥8 字；降级时以「用户授权：」开头>"`。
- **degraded 怎么办**：取号暂不可得——任何消费面都不内联具体号；排查来源清单（`--suggest-task-id` 输出逐源状态＋最近 ≤3 条降级摘要，`wf-occupancy-degraded-<keyDigest>.jsonl` 审计行）；恢复后按最小未用号继续。
- **取号与回池**：`--suggest-task-id` 给最小未用号（从 1 起、禁止历史回填）；`trackedPaths` 探测失败保守不回池并置 degraded（内部决策-050 D2 修正）；审计源占号永不回池。
- **审计面**：请求/声明/台账写 `inherited/manual/resumed` 审计字段；取号源集版本 `occupancy-sources-v5`（内部决策-061 D8.2）。

### 父会话先声明后派发

**纪律**：父会话必须在派发承担写面的子会话**之前**完成本任务号声明（挑战/租约先于子代理创建）。子代理会话只继承父链号、不得自取；父链不可解析时子代理应「停止写操作→回报父会话」，由父会话先声明后重新派发——禁止同一轮内重试（挑战签发时 inheritTaskId 已固化，同轮重试不可能成功）。

TDD/评审子代理场景示例：父会话声明（`routing-declare <skill> --lease <token> --task-id <父链号>`）→ 继续对话（挑战/active 轮换不影响台账解析）→ 再派发子代理；子代理租约行由 UPS 注入继承号（缺失时按停报重派处理）。

## 验证命令

```bash
node --test "workflow/scripts/tests/*.test.mjs"   # lint 与 retro-metrics 测试
node workflow/scripts/check-routing.mjs           # 路由一致性（20 skills）
node workflow/scripts/check-residuals.mjs workflow # 残留红线扫描
node workflow/scripts/check-plan-design-input.mjs <计划路径>  # 设计输入凭据检查（内部规则-17；plan-review 受理核对执行）
node workflow/scripts/check-plan-host-impact.mjs <计划路径>   # 多宿主适配评估节检查（内部规则-18；plan-review 受理核对执行）
node workflow/scripts/check-test-anchors.mjs                  # 设计—测试锚定仓检查器（内部决策-060；退 0=全过/1=违例/2=配置错误）
node workflow/scripts/check-plan-test-anchors.mjs <计划路径>  # 计划「测试锚定」节检查（内部规则-19；plan-review 受理核对执行）
node workflow/scripts/deliver-lint.mjs --selftest              # 保密交付复核自检（内部决策-062；内嵌规则矩阵）
node workflow/hooks/check-careful.mjs --selftest && node workflow/hooks/session-start.mjs --selftest && node workflow/hooks/check-freeze.mjs --selftest && node workflow/hooks/verify-gate.mjs --selftest && node workflow/hooks/task-recap.mjs --selftest && node workflow/hooks/user-prompt.mjs --selftest && node workflow/hooks/routing-gate.mjs --selftest && node workflow/hooks/post-tool.mjs --selftest && node workflow/hooks/learnings-recap.mjs --selftest
```

## 保密交付（内部决策-062，内部任务-186）

乙方承接甲方项目、按合同只提供最小交付产物时的投影与复核工具（不替代合同/NDA/IP 条款，**不承诺「保证不泄漏」**）：

- 模板位置：`workflow/templates/delivery/`（contract/policy/DELIVERY-REPORT/AUDIT-PACKET 四件）：**contract/policy 复制到被治理项目的 `.deliver/` 后按合同与保密要求编辑**（`contract.json`＝合同交付清单 CDM；`policy.json`＝保密策略，属内部面、永不交付）；DELIVERY-REPORT/AUDIT-PACKET 模板默认用插件资产渲染，如需项目级定制可复制到项目 `.deliver/templates/` 覆盖（同名文件优先）。
- **保密选择不固定**：内部路径 glob / 内部 ID 正则 / 内部术语正则 / 悬空引用豁免 / 扫描面 / 许可要求全部由 `policy.json` 用户自选，工具不内置任何保密词表或固定档位；空内部规则集须显式 `acknowledgeNoInternalRules` 确认（防零规则假绿）。
- **内部路径规则分面（内部决策-062 修正案 3）**：`internal.pathPatterns` 承担源路径与包内路径保护（恒全量）；可选 `internal.textPathPatterns`（glob 数组）只作用「包内文本中的路径样 token」检测——缺省或显式空数组 `[]` 均回落 `pathPatterns`（不静默关闭），提供时文本面与源保护解耦；`contract.git.commitMessage/author` 扫描**恒用 `pathPatterns`**（安全边界不随文本分面收窄）；dot 前缀路径 token 与扩展名限定家族已在修正案 4 纳入文本面（见下条）。
- **投影必须从干净检出执行**：CDM `dir` 展开会纳入 ignored 文件与源侧 symlink（如 `node_modules/.bin`），活跃工作树并发写会触发「源仓在投影期间发生变化」只读断言失败；推荐先做检查点提交，再从该 commit `git clone` 出投影源树。
- **扫描面补充与内容级清洗（内部决策-062 修正案 4）**：`scan.include`（glob）与 `scan.extensions` 并集构成文本词表面（无扩展名/`.sha256`/许可文件可纳入）；路径 token 首字符允许 `.`（dot 目录文本规则生效）；可选 `policy.rewrite.rules[]`（用户完全自选，工具零内置）在投影 staging 内静态改写——文档/测试/夹具按全文本面、生产代码仅注释面（字符串/模板/正则不触碰）；改写后重算 MANIFEST、目标面残留由 `rewrite-residual` 恒 blocking（export 与 lint 同判据），未覆盖面残留计入导出 JSON `rewrite.untargetedResidual` 如实披露。
- **CLI 输出完整性（内部任务-333 同族）**：`deliver-export`/`deliver-lint` 直跑以 `process.exitCode` 退出（`--help` 除外），POSIX 管道捕获 >64KiB violations JSON 不再截断；退出码语义不变。
- 命令（在**被治理项目根**执行）：

  ```bash
  node <workflow 插件根>/scripts/deliver-export.mjs --project-root . --out dist/delivery [--no-git] [--json]
  node <workflow 插件根>/scripts/deliver-lint.mjs --project-root . --package dist/delivery [--json] [--format md]
  node <workflow 插件根>/scripts/deliver-lint.mjs --selftest
  ```

- 退出码：`0` 通过／`1` 内容违例（包内 lint blocking）／`2` 配置、参数或工具错误。
- **悬空引用恒 blocking、无降级开关**：交付包内文本文档的四形态相对引用（Markdown inline 链接/图片、引用式定义、HTML href·src）必须解析到包内；源仓实存但未进包的文件被引用即 `removed-doc-reference`——**移除文档后不会留下悬空引用**。
- 导出事务：`--out` 同父目录 staging → 生成交付报告/审计包/`MANIFEST.sha256.json` → 包内 lint 通过才原子落位；失败不留半成品；默认初始化全新 git 历史（单 commit、无内部提交信息），`--no-git` 显式降级。源仓只读（投影前后源树除源 `.git/` 外不变、源 `.git` 历史不变）。
- 限制（如实）：文本面机检，不覆盖正文语义/图片与二进制内嵌信息/未配置规则；不做内容自动改写（内部未决-184）、不做许可证识别；真实甲方/第三方审计演练见 内部未决-185。规格：`内部规格 内部决策-062`、`内部规格 内部模块-26`、`内部规格 内部接口-25`。

## 许可

MIT（见 LICENSE）；设计思想致谢见 NOTICE（superpowers / gstack / andrej-karpathy-skills / feature-dev，均按"借鉴思想、自写表达"原则重写）。

## 项目级 skill 清单与消费义务（内部任务-341，内部决策-070）

- 生成命令：`node workflow/scripts/generate-project-skills-manifest.mjs --check`（只读漂移检查）/ `--apply`（本仓受信写者；仅写 `项目级技能`）。
- 清单条目含 `loadScenario`（加载场景）与 `requiredOnWrite`；项目级 skill 以 `SKILL.md` frontmatter `x-required-on-write: true` 声明写前必载（机制不写死 skill 名）。
- 声明：`routing-declare ... --project-skill <name>` 为必载项 ack（缺失拒声明）；routing-gate/write-guard 对 enforce 的写面缺 ack 拒绝（C5 恒 shadow 不受限）。
- **迁移**：旧租约无 `projectSkills` → 首次写被拒，按 deny 文案重声明一次即可；清单为可选：消费仓无清单时运行时按源扫描（无需 CI `--check`），选择入库清单时才需生成一致性 CI 步。
