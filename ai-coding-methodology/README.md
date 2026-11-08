# ai-coding-methodology —— DeepSeek Harness 宿主适配层

> 把本仓六个 ZCode 插件（workflow / spec-gate / scout / team-governance / algo-loop / research-loop）的钩子声明
> 与 skill 目录挂到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> （下称 DSH）上。**ZCode 侧资产零改动**：本目录只读插件资产（钩子声明、`SKILL.md`、
> 命令与 agent 声明），只 spawn 既有钩子脚本，不写任何 ZCode 文件、不改任何声明。ZCode
> 上的可用性因此不受影响。
>
> **声明源（2026-10-01，内部决策-036 决策 6 / 内部接口-1 §1 期二换源）**：钩子声明的读取面是插件的
> **中立清单** `plugin.manifest.json`（六插件声明的唯一手工编辑面）；`hooks/hooks.json` 与
> `.zcode-plugin/plugin.json` 是它的物化生成物，只在插件树**没有可用中立清单**时作为兼容回落
> 面被读取（0.6.0 前的装机副本、仅 ZCode 形态的树）——换源只换来源，事件/matcher/超时/信封
> 语义逐字不变（等价性由 `hooks-bridge` 的"期二换源等价"用例对**五有钩插件**逐字段钉住——research-loop 零钩子不入循环，两侧恒空）。

## 四个面

| 面 | 声明源 / 资产 | DSH 落点 | 状态 |
|---|---|---|---|
| 钩子面 | `plugin.manifest.json`（中立源；回落 `hooks/hooks.json`）+ 钩子脚本 | `agent/created` / `agent/pre-step` / `tools/pre-execute` / `tools/post-execute` / `agent/turn-stopping` | ✅ 默认开启 |
| skill 面 | `skills/<name>/SKILL.md` | `ctx.skills.register()`（运行时注册） | ✅ 默认开启 |
| 命令面 | `commands/*.md` | `ctx.commands.register()` + `agent.followup()` | ✅ 默认开启 |
| agent 面 | `agents/*.md` | 解析已实现，但当前宿主（0.2.1-rc.5）persona/工具面由 Agent Preset 承载 ⇒ **不装配**（开启即 0 挂载＋单次告警，内部未决-244） | ⚠️ 默认关闭；当前宿主不可用 |

## 为什么需要一层适配

### 钩子面：两处契约不可在 ZCode 侧弥合

| 差异 | ZCode 形态 | DSH 形态 | 本层处置 |
|---|---|---|---|
| 处理器声明 | `command` + `args` 数组 | 单条 `command` 字符串 | `handlerCommandLine`：先替换 `${PLUGIN_ROOT}`（ZCode 生成物形态为 `${ZCODE_PLUGIN_ROOT}`，两个键都按插件根替换）再按平台引用 |
| 阻断语义 | stdout 信封 + 退出码 2 | 退出码 2 只看 stderr；stdout 仅在退出码 0 时解析 | `decodeHookOutput`：退出码 2 仍解析 stdout 信封（`permissionDecision` / `systemMessage` / `additionalContext`） |
| 危险文案位 | `hookSpecificOutput.systemMessage` | 宿主的 `HookOutput` 不读该字段 | 同上：`systemMessage` 折入 `reason`，deny 文案不退化 |
| 工具名 | `Bash` / `Edit` / `Write` | `pwsh`/`bash` / `edit` / `write` | `normalizeMatcher`：按词表展开 |
| 会话来源 | `startup\|resume\|clear\|compact` | `agent/created` 的 `source`（自有词表） | `normalizeSessionSource`：域外归一到 `startup`（SessionStart 注入是路由纪律的唯一通道，不容静默失效） |
| 事件名 | 另有 `PostToolUseFailure` | 无独立事件（成功/失败同走 `tools/post-execute`） | 两通道合并；负载同时带 `tool_response`（文本）与 `tool_result`（结构面：`{exit_code?, is_error, stdout, stderr:''}`——`exit_code` 取宿主 `result.value.exitCode`，`is_error` 取 `result.isError`；见 内部未决-46 修订） |

DSH 自带的 `@deepseek-ai/dsh-hooks-claude-code` 桥只覆盖了其中一部分（上述第二、三行它
在退出码 2 分支丢弃 stdout），且完全不做第六行的合并——所以本层自建，而非复用上游桥。

### skill 面：为什么走运行时注册

DSH 的 `dsh-skill-filesystem` 只扫四个根：`<projectRoot>/.dsh/skills`、
`<projectRoot>/项目级技能`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`。本仓的
`skills/` 不在其中。要把 32 份 skill 落进这些根，只有三条路：

1. **复制**正文到 `.dsh/skills/` —— 32 份重复文件，改一处忘一处就是纪律漂移；
2. **符号链接** —— Windows 建链接需特权（开发者模式或提权），装机面不可靠；
3. **运行时注册**（本层选择）—— `ctx.skills.register()` 把"哪里找"留在适配层，
   正文始终是磁盘上的那一份，零副本、零镜像目录。

名空间：ZCode 靠 `/spec-gate:gate` 这类**命令面**消歧；DSH 的 skill 名是 kebab-case
（`^[a-z0-9]+(?:-[a-z0-9]+)*$`，不含冒号），且注册表在一个层内**同名先到先得**（后者只记
warning 并拿到空 disposer——静默失效）。本层把注册名统一为 `<插件名>-<目录名>`
（`spec-gate-gate`、`workflow-plan-execution`…）：前缀让来源在名字里可见，并消除跨插件
同名（两个插件都有 `gate/` 目录时不再静默吞掉一个）与拼写变体撞名两类隐式冲突。

字段映射：`name` → 带前缀名；`description` 原样（ZCode 的「一句话功能 —— 触发条件：…」
本身就是可路由描述）；`whenToUse` 有则透传；`disable-model-invocation` / `user-invocable`
→ `invocation` 策略；`license` 与 `metadata` 之外的自定义键不透传（DSH 运行时条目没有
自定义字段位）。frontmatter 由本层的 YAML-lite 解析器处理（**零第三方包**，project-conventions 硬规则
5）：只支持本仓实际使用的形态——标量、布尔、`metadata:` 下两层嵌套 map；块标量按"不支持"
整体放弃该 skill（宁缺勿错析），流式集合按保守判据识别（`[a, b]` 判集合，`[特性描述]`、
`[--task-id X] [--plan Y]` 这类占位符书写法按普通标量读）。

### agent 面：persona + toolFilter，但默认关闭

ZCode 的 agent 文件是三合一：**角色正文 + 工具白名单（前言 `tools:`）+ 输出契约**。DSH 侧
没有"扫目录出角色"的机制，但委派面有现成的两个字段：

| ZCode | DSH |
|---|---|
| 正文（角色/职责/输出契约） | `@deepseek-ai/dsh-tool-subagent` 的 `persona`（进子 agent 的 `systemPrompt` 段） |
| 前言 `tools:` | 同上的 `toolFilter: {allow}`（经 `tools.restrict()` 生效） |
| 一个 agent 一个委派目标 | 每个 agent 一份委派工具实例，`toolName` 唯一 |

子 agent 的创建/驱动/结算全部留给宿主既有的 `spawn` 提供方（其 `start()` 内部走
`startInProcessRun`，声明了 `persona`/`toolFilter` 能力）——本层只做"读正文、算 filter、
挂三份工具"。

**为什么默认关闭（`mountAgents: false`）**：这一面唯一不可出错的地方是 `toolFilter`。
`tools.restrict()` 对**未知名**抛错，且该调用发生在子 agent 的**创建窗口**内——写错一个名字
即委派失败。本层因此取三个约束：候选名只取宿主源码实测存在的工具名、再与宿主真实目录求
**交集**、目录不可得时整体不挂载。

**为什么这样求交集是安全的（源码链，2026-09-28 第 41/42 批确证）**：

1. `restrict()` 的校验源是 `this.view(scope).restrictableNames`，而 `dsh-tools` 的 `view()`
   里 `restrictableNames` **无条件**收下全部 inherited 名（`admits` 只筛 `visible`）——
   即"能否被 restrict 命名"取决于**全局注册表**，与 scope 无关；
2. `dsh-subagent` 的 `applyChildComposition` 直接 `childCtx.tools.restrict(composition.toolFilter)`；
3. 同一函数首行 `childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)` —— 子 agent
   **加入父的组合**（源码注释：不 join 的子 agent 会看到空的工具注册表）；
4. `dsh-agent-preset-registry` 的 `composeFrom(ctx, parent)` 取 `standingMountFor(parent)`
   ——**父当前挂载的那个预置版本**，再把子 `join` 到**同一个 generation**。

即：名字必然合法（1+2），且**子 agent 的工具面就是父的工具面**（3+4，同一份预置 revision）。
但**当前宿主（DSH 0.2.1-rc.5）上该面不可用**：`dsh-tool-subagent` 已改为以 Agent Preset 承载
persona 与工具面（`persona`/`toolFilter` 配置面移除、显式抛错），且 rc.5 Web profile 把全局
工具行全部禁用（工具由 preset 承载）⇒ 本层**不装配该面**（也不再向该模块传已移除字段）。
故 `mountAgents: true` 的**实际行为＝0 挂载＋单次告警**（「agent 面不可用」），不再谎称可挂载；
重设计（Agent Preset 路线或删面）登记为 `内部未决-244`。默认关不变。

（历史取证：本层从未在跑起来的宿主上观测过委派全过程，§9 的委派面验证仍未做；早期版本的
「最坏只是三个委派工具挂载失败并逐条告警」判断在 rc.5 契约下已不成立。）

工具名探测走宿主公开 API `tools.get(name)`，候选集＝`agents-bridge.mjs` 的
`ALL_TOOL_CANDIDATES`（`CORE_TOOLS`/`EXTENDED_TOOLS`＋平台 shell 名，**单源**）：宿主真实目录以
`tools.get` 探测求交集，目录不可得/交集空即 fail-closed。该探测当前**休眠**（agent 面在 rc.5 契约
下不可用，见上），保留为 内部未决-244 重设计的就绪面；`TOOL_MAP` 仍承载 ZCode 词→DSH 名的映射表。
不改任何 ZCode 资产。

**三个 agent 的真实边界**（照实记，勿美化）：

| agent | ZCode `tools:` | 说明 |
|---|---|---|
| `code-explorer` | Glob, Grep, LS, Read, WebFetch, WebSearch, TodoWrite, BashOutput | 无 shell → 真只读 |
| `code-architect` | 同上 | 无 shell → 真只读 |
| `code-reviewer` | 同上 **+ Bash** | **不是纯只读**：无写文件工具，但 shell 能执行任意命令。其边界在 ZCode 侧由 `check-careful`/`check-freeze` 护栏与审阅纪律共同承担，不是由工具白名单承担 |

`BashOutput` 在 DSH 无对位（持久 shell 的输出读取是 `pwsh` 工具自己的投影），按"拒绝"
丢弃——丢弃它不会放宽权限（该工具只读输出）。

### 命令面：DSH 的命令不产生模型消息，用 `followup` 补齐展开语义

ZCode 的 `commands/*.md` 是**提示词展开型**斜杠命令：宿主把命令正文（`$ARGUMENTS` 替换
后）作为一条用户消息送进模型。DSH 的命令面**按设计不产生模型消息**——处理器返回的
`{kind:'success'|'error', text}` 只渲染在 UI 的命令平面里。因此直接注册命令会让
`/workflow-feature-dev` 变成一个什么都不做的空壳。

本层的处置：处理器用 `invocation.agent.followup({content, source:{kind:'user'}})` 把渲染
后的正文作为一条普通下一轮提示词入队并唤醒驱动器——这正是宿主自带 `/goal <objective>`
驱动 Goal Round 所用的同一 API（`dsh-command-goal/lib/index.js` 的
`submitObjectiveAttachments` 可见其用法），因此语义与 ZCode 的展开一致：用户在下一轮看到
自己的命令被当作指令执行。UI 回执只说明"已展开哪条命令"，不重复正文。

降级路径（诚实、不假装）：句柄没有 `followup`（非循环句柄）或配置 `startTurn: false` 时，
回执里交出渲染后的正文供自行粘贴，并明说"未驱动 agent"。

命名：`/spec-gate:gate` 的冒号命名空间在 DSH 不合法（命令名形态
`^[a-z][a-z0-9_-]*$`），故命令面与 skill 面用同一套前缀（`spec-gate-gate`），
两面同名命令指向同一 skill。

身份：每条命令还带 `definitionId`（`ai-coding-methodology/ai-coding-methodology/<命令名>`）——宿主
文档把它定义为**带插件命名空间的稳定定义标识**，「独立于显示文案与每次执行的 `commandId`」，
适配器据此跨文案变化认出同一条命令；宿主自带 `/goal` 等命令同样带它。

延迟预算：本层在 `agent/created` 上**等待**全部 SessionStart 钩子返回后才放行（与宿主自带
桥的脱挂策略相反），代价是会话启动多花一点时间，换来"路由表一定进入首个请求"。实测 SessionStart
串行合计 0.5–0.8 秒（四插件时代实测值；algo-loop 为单个轻量摘要钩，属六插件之一）——声明里的
10/15/10/20/10 秒是每钩上限而非实际延迟。
**2026-10-20 内部任务-173**：钩子输出不再 `agent.inject`（durable next-step 会被桌面 `hasDesktopActiveTasks`
计为活动任务 → 空闲退出误报），改为入 apply 闭包内存槽、首轮 `agent/pre-step` 追加
`decision.messages`；等待与预算不变，路由表仍进入首个请求。
数字与测法见设计文档 §8.5。

## 事件映射

| ZCode 钩子事件 | DSH 扩展点 | 本层动作 |
|---|---|---|
| `SessionStart` | `agent/created`（执行钩子）＋ `agent/pre-step`（首轮投递） | additionalContext 入内存槽，首轮 pre-step 追加 `decision.messages`（不落 durable next-step；每 agent 生命周期一次） |
| `UserPromptSubmit` | `agent/pre-step` | deny → `{kind:'reject'}`；有上下文 → 追加消息 |
| `PreToolUse` | `tools/pre-execute` | deny / ask → `{kind:'deny'\|'ask'}`；allow+reason 经 `agent.inject` 合成模型可见上下文（会话级去重/10 分钟冷却/每会话 20 次/500 字符截断；语义降级见 内部决策-032 2026-10-20 注记） |
| `PostToolUse` | `tools/post-execute` | deny → 阻断反馈；有上下文 → 追加 |
| `Stop` | `agent/turn-stopping` | 阻断（退出码 2 或 `continue:false`）→ `agent.steer()` 再跑一步 |
| （派发事实面） | `tools/execute` | 登记「已派发」事实；`PostToolUse` 据此产 `dispatch_fact` 三态（`dispatched`／`not-dispatched`／缺键 unknown；内部任务-273 H-01） |

## 安装

> **两个前置条件**（都实测过，2026-09-29；版本钉法 2026-10-06 补）：
> 1. **本机要有能跑的 `dsh` 命令。** DSH 桌面版**不自带** PATH 上的 `dsh`
>    （安装目录里只有 `DeepSeek Harness.exe`，`dsh` 包只是它 `node_modules` 里的一员）。
>    故先装 CLI 本体，**示例钉兼容版本**：`npm i -g @deepseek-ai/dsh@0.2.1-rc.5`，之后下面的
>    命令才可用。**不要裸 `npm i -g @deepseek-ai/dsh` 装未钉版本**：registry 的 `latest` 为
>    `0.2.1-rc.5`（2026-11-01 实测，满足本层 peer 要求 `>=0.2.0-rc.1`）——但 latest 会随发布漂移，
>    装未钉版本前请先用 `npm view @deepseek-ai/dsh versions` 核对它仍满足 `>=0.2.0-rc.1`
>    （见下「版本范围」节；不满足时会被兼容性判定判为不适配）。
> 2. **先确认装到哪里。** `dsh plugin` 会写 `$DSH_HOME/profiles/<profile>/`（默认
>    `~/.dsh/profiles/<profile>/`），且**首次使用会就地初始化 profile**。若只想先在边上试一遍、
>    不动正在运行的那个宿主，先给 `DSH_HOME` 指一个临时目录再执行——本层的装机实测就是这样做的
>    （**绝不能**拿正在运行的 `desktop` profile 去试错）。

本包已按 npm 发布形态整理（2026-09-29 第 106 批）：`name` 为 `ai-coding-methodology`、
不带 `private`、带 `description`/`keywords`/`LICENSE`。**装法要求（2026-10-01 批 2 起）**：
本层的规则引擎在装载期经相对路径读取 `plugin-core`（内部决策-037 裁决 A：**引擎必需 + 不可得即拒载**），
而 `plugin-core` **不随本包分发**（`files` 白名单有意不含它）——故**只支持 plugin-core 随仓/profile 可用**的装法：

```sh
# 方式一（推荐）：仓库检出 / link 装法（plugin-core 随仓可用）
dsh plugin --profile <profile> add link:<本目录绝对路径>

# 方式一·本地目录（开发用，等价于上一条）
dsh plugin --profile compat-verify add <本目录绝对路径>

# 方式二：registry 单包装法（npm i -g @deepseek-ai/dsh@0.2.0-rc.2 后 dsh plugin add ai-coding-methodology）
#   ⚠ 该装法下 plugin-core 不可达 ⇒ 装载期**响亮拒载**（启动日志含尝试路径与修复指引；四面不注册）。
#   迁移动作：改用上面的 link 装法；或将 plugin-core 置于本包父目录（仓库根）后再装。
#
#   成本选择声明：相对路径装法是**当前仓库形态下的成本选择、非终态最优**——本层目标是 DSH 用户
#   只读这一份参考实现，而"必须连仓库一起装"与之存在张力；演进方向为三级探测
#   （repoRootOverride → 相对本模块 → createRequire().resolve('plugin-core')），待后续批评估。

# 不启动也能看组合树（确认三面被装载）：应出现 `# == ai-coding-methodology` 层头
dsh --profile compat-verify --dump-config

# 静态契约面也可先看（会导入本模块并读出 Config schema）
dsh --profile compat-verify --dump-config-schema

# 端到端跑一次（需要可用的模型凭据；无凭据会停在 MISSING_CREDENTIAL）
dsh --profile headless "run the workflow meta skill routing check"

# 方式二：手工挂载 —— 在 profiles/<profile>/cordis.patch.yml 里放一个**顶层数组**，
# 元素形如（`dsh plugin add` 之外的最小手工等价物）：
#   - insert:
#       - id: ai-coding-methodology
#         name: 'ai-coding-methodology'
# （该文件自带注释：edit cordis.patch.yml, not cordis.yml）
```

**link 装法的检出前置（2026-10-17 内部任务-68 实测）**：link 依赖的裸导入按**真实路径**解析
（Node ESM 默认 realpath），宿主 profile 的包管理器**不会**为 link 兄弟包代解 `dependencies`——
故装前须在检出内自解依赖：`cd ai-coding-methodology && npm install`（只产 gitignored 的
`node_modules`）。缺此步时装载期即 `ERR_MODULE_NOT_FOUND: Cannot find package
'@deepseek-ai/schemastery'`，宿主按 fail-closed 拒载本层（四面不注册）。

**`desktop` 保留 profile：普通 CLI 拒绝、官方桌面版自带 CLI 例外（2026-10-17 内部任务-68 实测补注）**：
普通 CLI（`npm i -g @deepseek-ai/dsh`）的 `rejectElectronProfile()` 对 `desktop` 直接报错
（`profile "desktop" is managed exclusively by the Electron application`，且该校验在
`plugin` 子命令上同样生效）——该 profile 归 Electron 应用所有（启动/配置 dump 仍拒绝）。
但**官方桌面版自带 CLI**（`<App>/Contents/Resources/runtime/cli/bin/dsh`）以
`manageDesktopProfile: true` 启动（`@deepseek-ai/dsh-desktop-host` 的 `runDesktopCli`），
**允许**对 `desktop` profile 执行插件管理：

```sh
<App>/Contents/Resources/runtime/cli/bin/dsh plugin --profile desktop add link:<repo>/ai-coding-methodology
```

装后宿主可热装载（本批实测：bundle 自动登记、skill 面 32 份热更新进会话、钩子面实跑——租约注入与 PostToolUse 落盘，无需重启）。手工挂载方式二同样
适用于任何非保留 profile。**迁位后必重装、升级后复验**：link 目标指向仓库检出，
**仓库检出游移**会使 link 失效；宿主升级或 profile 组合重整后应先复验（条目被组合校验
摘除时再重装）——本机 2026-10-13 检出迁位后出现该形态（2026-10-17 内部任务-68 修复）；
**今日两次宿主更新本身未使本层失效**（损坏证据早于更新），故升级只要求复验、不预设必重装。

包形态与 DSH 的 bundle 约定一致（对照官方 `@deepseek-ai/dsh-base` 的 `dsh.bundle.patch`
声明）：`package.json` 有 `dsh.engines.dsh` 与 `dsh.bundle.patch`，patch 文件为顶层
`insert` 列表，条目 `name` 与包名相同。

**装完不必手工改清单**：宿主的依赖协调逻辑会把任何声明了 `dsh.bundle` 的已安装依赖
**自动补进 `dsh.profile.bundles`** 并写回 `package.json`（源码依据见设计文档 §8.32，
实测见 §8.33）。故 `dsh plugin add` 一条命令即可，方式二是等价的兜底路径。

### 装完还要不要配？——插件开关即可；agent 面当前宿主不可用

四个面的启用状态现由插件页开关决定（内部决策-068：默认核心开＝workflow/spec-gate，scout/team-governance/algo-loop/research-loop 关；被关闭插件的钩子/skill/命令面均零注册）。此外 **agent 面在当前宿主（0.2.1-rc.5）不可用**：`persona`/`toolFilter` 由 Agent Preset 承载
（配置面移除），`mountAgents: true` 也只 0 挂载＋单次告警——会话里**看不到** `code_explorer` /
`code_architect` / `code_reviewer` 三份委派工具属预期，不是装坏了（重设计见 内部未决-244，
无需任何额外配置）。

**历史记录（下述 `mountAgents: true` 写法随 rc.5 契约变更已失效，仅存证；agent 面重设计见 内部未决-244）**：当时的开启方式是给本层补一段 `config`（**DSH 的插件配置写在 profile 的 `cordis.patch.yml` 里**，
行内 `config:` 块——与官方 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 同款写法，
源码依据：`dsh-base` 的条目形如
`- id: …` / `  name: …` / `  config:` / `    fallbackMaxWords: 5`）：

```yaml
# 追加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml（顶层数组）
- id: ai-coding-methodology
  config:
    mountAgents: true
```

> **配置写法与排错要点**：上面是历史存证写法（`mountAgents` 在当前宿主已失效，见上）。DSH 的补丁**按 `id` 找行**——`id` 写错时 `--dump-config` 会输出 `patch: entry "<id>" not found` 警告并跳过；键名写错无警告、只会静默不生效，可用 `--dump-config-schema` 核对 `Config` 字段。其余配置（`pluginRoots` / `projectDir` / `startTurn`）均有默认值，一般无需设置，完整字段表见下节「配置」。

**版本范围**：`package.json` 的 `dsh.engines.dsh` 与三个可选 peer 当前区间为 **`>=0.2.0-rc.1`**（更早的 `0.1.7-rc.2` 不满足）；宿主实际按 peer 区间以 `includePrerelease` 判定。

插件根按三级来源确定，优先级从高到低：

1. **`pluginRoots` 显式配置**——给了就用（且**不给自动来源兜底**：配错即明确少注册，
   不让"显式指定"名不副实）；
2. **同级发现**——从本插件所在目录起逐级上溯（最多 6 层），找同级
   `workflow/`、`spec-gate/`、`scout/`、`team-governance/`、`algo-loop/`、`research-loop/`（仓库检出与部分装机形态即此）；
3. **ZCode 安装记录**——读 `~/.zcode/cli/plugins/installed_plugins.json` 的 `installPath`
   **补缺**。生产常见形态是六插件装在
   `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`——比同级布局深一层、且同名
   存在多个版本目录，同级发现必然落空；此时**只有**这份权威记录能指出"当前装的是哪个版本"
   （扫描缓存挑版本会挑到旧版，比找不到更坏）。仓库检出下同级发现恒为 6/6，故这一级不会生效，
   开发时永远用最新的同级根。

   **记录形态已按实机核对**（2026-09-28 第 60 批）：`name` 在条目顶层（与本层四个键同名）、
   `installPath` 指向 `cache/<market>/<plugin>/<version>/` 且**带尾部分隔符**（实现原样返回，
   不归一）。本机 live 记录 13 条中本套件 5 条，其余为他方插件（被忽略）。

   **已知边界**：本层只读**这一处**记录（`~/.zcode/cli/plugins/installed_plugins.json`）。
   ZCode 的记录里带 `scope` 字段（本机实测 11 条**全为 `user`**，且全盘只有这一个记录文件、
   仓库附近无项目级 `.zcode/` 目录），故本环境无从核实"项目级 scope 是否另写一份记录"。
   若你的装机是项目级 scope 且同级发现也落空（插件不在本插件所在目录旁），请用
   `pluginRoots` 显式指定——该选项**优先级最高且给了就不兜底**，正是为这类情形准备的。

发现的判据是**中立清单 `plugin.manifest.json` 存在**，或回落形态 `.zcode-plugin/plugin.json`
存在（期二换源：两者的并集覆盖仓库检出、市场缓存与 0.6.0 前的旧副本三种树形态；皆无即非插件根）；
三级都拿不到就静默少注册（fail-open），并在启动日志里报明缺哪些插件、提示可用 `pluginRoots`
显式指定——不猜路径。

## 桥接工具面（`agentControlBridge`，默认关）

F2（内部任务-189 / 内部未决-151 方向①）：把三个**非同名**模型面工具注册进当前会话的 agent scope，让本会话
**普通 continuable 子代理**可列出、可续聊、可等待——补「Team 成员可续，而普通子代理派发即失联」的缺口。

| 工具 | 作用 | 边界 |
|---|---|---|
| `list_subagents` | 列出本会话直接子代理（持久目录行：`{id,label?,mode,continuable,createdAt}`） | 只读；不臆造 status/title |
| `message_subagent` | 向本会话 direct continuable 子代理投递一条文本（续聊） | 宿主 exact-parent/direct-child 授权；`NOT_RESUMABLE`/`UNAUTHORIZED` 映射为可读错误 |
| `wait_subagent` | 等目标离开 `running`（默认 20s/上限 60s），超时如实 `timeout` | 未知 id 报错；不把超时/回收伪装成完成 |

- **默认关**（`agentControlBridge: false`）：模型面工具会改变宿主可见能力面，翻默认须先有真机证据（内部未决-153 口径）。**2026-11-01 内部任务-272（用户裁决）**：真机证据已足（内部任务-228/内部任务-268），已安排翻默认评审（内部未决-153 收窄）。
- **fail-open**：无 `subagents`/`tools` 服务时只一次性告警、不注册；注册异常吞掉并告警；不阻断钩子/skill/命令面。
- **仅本会话**：跨会话不承诺续聊原实例（宿主花名册按会话作用域；跨会话按 workflow 元技能全局规则「代理实例复用与再水化」再水化），见 `内部未决项台账` 内部未决-165（内部未决-151 已于 2026-10-25 关闭）。
- **不遮蔽**：三工具与 Team/legacy 控制面**不同名**，不替换既有 `send_message`/`list_agents` 语义。
- **首轮通道提示（2026-10-23 内部任务-220）**：开启且注册成功时，该 **agent** 首轮 `agent/pre-step` 注入一次通道提示，
  内容＝「本会话普通子代理可续/复审与返工先列清单→续聊复用→失败才新发/持久成员通道不作计划与代码复审通道/
  跨会话一律再水化」，文案按**实际注册工具**动态渲染（无 `wait_subagent` 时不宣称可等待；缺 list/message 时相应步骤降级）。门控按 per-session
  注册事实（关闭后新会话零注入）、每 agent 生命周期至多一次（含 resume 重建重臂）；空会话 id 不投递（一次性 warn）；投递失败
  fail-open 且不消耗机会；成功记 `logInfo('桥接通道提示已投递 session=…')`（logInfo 走宿主 stdout、无磁盘落点，非验收检索面——内部任务-221 §3）。**真机面**：①首轮帧已取证（seq=14，`内部帧取证记录`）、③三工具实调可用、④关闸演练待用户操作（内部未决-175）；②原日志检索口径废止（logInfo 走宿主 stdout、无磁盘落点，内部任务-221 §3），改由装配级断言承载（`config-surface.test.mjs` ⑦ 的 logInfo 断言）。
- **结果呈现契约**：三工具 `output.render` 返回宿主 Content 块数组（`[{type:'text',text}]`）——宿主 `tools/post-execute`（桌面部署默认装载 `spill-policy`）按块数组消费；2026-10-21 真机门曾因返回字符串在成功路径统一报 `content.some is not a function`，内部任务-196 修复并加真实宿主消费回归锁（`f2-poc` A5）。
- **宿主预算行为**：结果仍受宿主 `spill-policy` 的 `maxInlineTokens` 预算控制——超限时宿主可能截断并附保留通知；缺 `spillStore`/会话句柄时该策略告警后内联（fail-open），不影响本层 render 契约。
- 开法（两路）：①**插件页配置卡片（UI，推荐）**——侧栏「插件」→ 本插件详情页 →「桥接工具面」卡片
  开关并保存（保存后新会话/新 agent 生效；见下「插件页配置」节）；②**手工兜底**——在 profile 的
  `cordis.patch.yml` 本插件 `config` 里置 `agentControlBridge: true` 并重启。真机门 2026-10-21 已执行
  （模型面可见性/授权边界取证；`message_subagent` 投递副作用成功、结果面因 render 缺陷失败；
  `list_subagents`/`wait_subagent` 结果面失败），内部任务-196 修复 render 契约后模型面可用性已由 内部任务-228（首轮提示帧 seq=14、message 投递帧 seq=208）与 内部任务-268 重启批（list_subagents 实调）复验
  （证据：内部证据目录（内部任务-196、内部任务-228、内部任务-268））。

## 插件页配置（分组列表卡片，8 个 volatile 字段）

2026-10-22 内部任务-201 起提供插件页配置卡片；**2026-10-31 内部任务-268（内部决策-068）起扩展为分组列表卡片**：

- **入口**：侧栏「插件」→ `ai-coding-methodology` → 详情页配置卡片（宿主 `plugins.bundle.config` 扩展位；
  由本包客户端半侧 `client/client.js` 注册，`package.json` 的 `dsh.client` 声明 browser 半侧）。
- **分组结构**：顶部标题/说明/状态摘要；「插件开关」六行（workflow/spec-gate/scout/team-governance/algo-loop/research-loop）、
  「工具面」一行（`agentControlBridge`）、「系统监测」一行（`osObservation`，依赖团队治理插件开启）；底部保存栏。
- **配置字段**：8 个 `.volatile()` 字段（六插件开关＋`agentControlBridge`＋`osObservation`）；其余四项
  （`pluginRoots`/`projectDir`/`startTurn`/`mountAgents`）仍是 apply 期配置，继续用 `cordis.patch.yml` 手工设置。
- **保存写入**：多字段脏草稿经**一次** `configForms.mutate(ops, revision)` 提交，经宿主 settings→config-editor 写入当前
  profile 的 `cordis.patch.yml`（与手工编辑同源，保留注释与 `!!js`）；保存后重读快照逐字段比对，不一致按“未生效”保留草稿；
  **还原**＝删除本插件整条目或把字段置回默认值。
- **生效边界**：插件开关与 OS 监测开关保存后**重启宿主**生效；`agentControlBridge` 保存后**新会话/新 agent** 生效
  （当前会话已注册工具不回收）。界面按有效态渲染（team-governance 关闭时 OS 行显示“未生效”）。
- **默认值**：核心开（workflow/spec-gate）、其余关；`osObservation` 默认开但仅当团队治理开启时生效。升级影响与自查步骤见
  下节「默认值变更与升级影响」。
- **降级与排查**：旧宿主或命名空间未被服务时卡片不显示（宿主日志有一次性诊断），退回手工 YAML。
  卡片不显示排查三步：①本包是否为含客户端半侧的版本（0.17.0 不含、0.17.1 起包含——2026-10-31 内部任务-268 折叠已落，见
  `内部规格 内部接口-1` 激活登记）；②是否重启过宿主（客户端 bundle 在宿主启动时装载）；
  ③插件条目是否启用。离开页面会丢弃未保存草稿；保存失败会保留草稿并提示重试。真机 UI 冒烟已取证（2026-10-31 重启批，内部未决-230 关闭；证据 `内部真机冒烟证据`）。

## 配置

配置经 cordis 约定的 `Config` schema（`@deepseek-ai/schemastery`，与宿主自带桥同形）交给宿主：
宿主据此校验类型、填默认值并派生可编辑面——**2026-10-31 内部任务-268（内部决策-068）起 8 个 `.volatile()` 字段**
（`agentControlBridge`＋六插件开关＋`osObservation`）可经插件详情页分组列表卡片修改（见上「插件页配置」）；
其余四项仍走 Cordis 配置文件。写错类型会被拒，不会静默生效。

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `pluginRoots` | `dict<string>` | `{}` | 插件名（`workflow` / `spec-gate` / `scout` / `team-governance` / `algo-loop` / `research-loop`）→ 插件根绝对路径的手工覆盖；缺省按「同级发现 → ZCode 安装记录」自动确定（见上「插件根」三级来源） |
| `projectDir` | `string` | `''` | 会话工作目录兜底（同时作为 `ZCODE_PROJECT_DIR` 注入钩子环境）；缺省按会话 cwd，再回落到进程 cwd |
| `startTurn` | `boolean` | `true` | 命令处理器是否经 `agent.followup` 把渲染后的命令正文入队为下一轮提示词；`false` 时只回执正文、不驱动 agent |
| `mountAgents` | `boolean` | `false` | 是否尝试装配 agent 面。**当前宿主（0.2.1-rc.5）不可用**：persona/toolFilter 由 Agent Preset 承载，开启即 0 挂载＋单次告警（内部未决-244，见上「agent 面」） |
| `agentControlBridge` | `boolean` | `false` | 是否向**顶层（delegationDepth=0）**会话的 agent scope 注册三个非同名桥接工具（`list_subagents` / `message_subagent` / `wait_subagent`）：本会话普通 continuable 子代理可列出/续聊/等待；默认关闭、fail-open（无服务只告警）、跨会话不承诺续聊；仅本会话（内部任务-189）；2026-10-22 内部任务-201 起为 `.volatile()` 字段，可经插件页配置卡片修改（保存后新会话/新 agent 生效；当前会话已注册工具不回收） |
| `pluginWorkflow` | `boolean` | `true` | 是否启用 workflow 插件面（钩子/skill/命令/agent）。volatile；**保存后重启宿主生效**（内部任务-268/内部决策-068） |
| `pluginSpecGate` | `boolean` | `true` | 是否启用 spec-gate 插件面。volatile；保存后重启宿主生效 |
| `pluginScout` | `boolean` | `false` | 是否启用 scout 插件面。volatile；保存后重启宿主生效 |
| `pluginTeamGovernance` | `boolean` | `false` | 是否启用 team-governance 插件面（含 os-observe）。volatile；保存后重启宿主生效 |
| `pluginAlgoLoop` | `boolean` | `false` | 是否启用 algo-loop 插件面。volatile；保存后重启宿主生效 |
| `pluginResearchLoop` | `boolean` | `false` | 是否启用 research-loop 插件面。volatile；保存后重启宿主生效 |
| `osObservation` | `boolean` | `true` | 是否启用 team-governance 的 os-observe 监测（SessionStart 浮现段＋机会式补位采集）；关闭时适配层向该钩子注入 `AI_CODING_OS_OBSERVE=0`，治理摘要保留；**仅当 `pluginTeamGovernance` 开启时有实际效果**。volatile；保存后重启宿主生效 |

### 默认值变更与升级影响（2026-10-31 内部任务-268/内部决策-068）

六插件开关的默认值＝**核心开、其余关**（`pluginWorkflow`/`pluginSpecGate` 开；scout/team-governance/algo-loop/research-loop 关），
`osObservation` 默认开但仅当 team-governance 开启时有实际效果。**既有用户**若依赖被默认关闭的插件：

1. 打开插件详情页「配置」卡片，开启对应插件开关并保存；或手工在 profile 的 `cordis.patch.yml` 本插件条目下置
   `pluginScout: true` 等字段；
2. **重启宿主**（六插件/OS 开关统一重启生效；桥接工具面对新会话/新 agent 生效）；
3. 自查：重启后看日志 `ai-coding-methodology: 未启用插件 …`（点名未启用项）与卡片状态摘要；关闭插件的四面不会注册；
4. 回滚：把字段置回默认值或删除本插件配置条目，重启宿主。完整升级说明由本批 README 与 内部决策-068 承载。


## 失败姿态

全程 fail-open：声明缺失或损坏、插件根找不到、钩子启动失败、异常退出码、skill 注册被
宿主拒收、命令注册被拒、命令入队抛错——一律记日志后放行，**绝不阻断宿主轮次、绝不让
适配层整体失败**。与 ZCode 侧护栏的姿态一致（project-conventions 硬规则 4）。**两个例外**：①ZCode 自己
`check-freeze` 的 fail-closed 极性（负载不可读 → deny），本层原样转发、不做"修正"；
②**装载期引擎拒载**（2026-10-01 批 2 / 内部决策-037 裁决 A）——`plugin-core` 不可得时先 `logWarn`
（含尝试路径与修复指引）再外抛，四个面整体不注册（"护栏对宿主工具名静默空转"与"元技能注入静默
失效"是它要消灭的形态，故不允许部分注册）。注册期引擎分派失败同极处置；**会话期仍为 fail-open**。

四个面彼此独立：宿主缺某个服务时只跳过对应的面（各自经 `resolveService(ctx, name)` →
`ctx.get(name)` 读取，不写进 `inject`）。这一条有源码级依据，不是风格偏好：cordis 的
`ctx.<service>` **属性访问只在 `inject` 声明该服务时合法，否则抛**
`cannot get property "X" without inject`；而 `ctx.get(name)` 的原话是
`Read a service from the store without the inject requirement`（服务缺席返回 `undefined`）。
本插件只 `inject: ['shell']`，所以其余三个服务一律只能经 `ctx.get` 读——写进 `inject`
会让本插件在缺该服务的宿主上**整体不加载**，等于用一个面换另外三个面。回归测试用 `Proxy`
复刻了 cordis 这两条规则，断言 `apply` 全程零属性读违规。

## 测试

```sh
# 首次：本地依赖解析（@deepseek-ai/schemastery 提供 Config schema）
cd ai-coding-methodology && npm install && cd ..
node --test "ai-coding-methodology/tests/*.test.mjs"
```

`node_modules/` 不进仓库（见仓库 `.gitignore`）：装机时同一份依赖由宿主 profile 的包管理器
按 `dependencies` 提供，本地安装只为在仓库内跑测试与类型校验。`package-lock.json` 入库以固定
本地解析结果。

**宿主安装根的解析（2026-10-01 补）**：需要宿主真身的用例从 `resources/app.asar` 就地抽取
引擎（缓存身份＝`<appRoot>|<size>:<mtimeMs>|<sha256 前 16 位>`）。`appRoot` 取值顺序＝
`DSH_APP_ROOT` → 本平台标准安装位置（darwin `/Applications/DeepSeek Harness.app/Contents`
与 `~/Applications/…`；win32 `%LOCALAPPDATA%\Programs\DeepSeek Harness`）→ 历史兜底字面量。
装到别处时用 `DSH_APP_ROOT` 显式指定；**装不到就不是静默跳过**——宿主契约钉子（内部未决-40）
按设计 fail-loud。抽取另带**内容自证**：asar 头对每个条目带 `integrity.hash`，逐文件比对失败即
拒绝发布残树（`unavailable`），不让"偏移写错"再次以静默残损的形式过门。

349 项（`acceptance` 31 + `hooks-bridge` 114 + `agents-bridge` 28 + `commands-bridge` 25 +
`skills-bridge` 18 + `jsdoc-contract` 14 + `engine-loader` 8 + `apply-refuse` 3 + `equivalence` 8 +
`envelope-events` 7 + `apply-shape` 1 + `apply-dispatch` 2 + `long-task-driver` 25 +
`agent-control-bridge` 19 + `f2-poc.integration` 6 + `config-surface` 12 + `client-bundle` 14 + `declaration-diagnostics` 8 + `plan-mode-gate` 6），**九类**覆盖面
（桥接工具面 25 项＝`agent-control-bridge` 19＋`f2-poc.integration` 6，并入既有「agent 面/纯函数与契约」类；
2026-11-06 内部任务-339 OPEN 消账批 +2（内部未决-246 T-05/T-06 组装级判别：`long-task-driver` 24→25 的主 Stop 入口/派发后 abort 两分支 marker 判别对＋`agent-control-bridge` 18→19 的 wait running 中 abort 迟滞与独立性；内部未决-250 DSH 面随批单源化——本 README 计数节为唯一数字面），346→348；2026-11-08 内部任务-352 +1（`hooks-bridge` 113→114：AskUserQuestion 答复通道 ask 信封经 `decodeHookOutput` 解码的真实钩子子进程回归用例），348→349；2026-11-03 内部任务-308 真机门 A 组 +2（`hooks-bridge` 111→113），344→346（历史链顺补：主行原已为 346 而链缺本条）；
2026-11-01 内部任务-273 评审修复批 +11（`long-task-driver` 22→24：H-04 `goalOwnsContinuation` 三态矩阵＋goal complete 后恢复续跑装配用例；`hooks-bridge` +5：H-08 插件根受信边界＋批次 B 回归 M-01/M-02/M-03＋T-07 真实超时＋H-02 宿主契约钉子；`client-bundle` +1：M-06/M-07 保存路径 verify-failed/重读与错误透出；`agents-bridge` +1：H-03 mountAgents 生产默认降级；`skills-bridge` +1：M-05 注册 disposer 保留；`apply-refuse` +1：T-10 同 ctx 二次 apply 幂等；H-01/H-02/H-05 为既有用例改写/期望翻转、不增项），330→341；2026-11-02 内部任务-285 钩子声明热加载 +3（`hooks-bridge` 108→111：`declarationSignature` 签名面/装配级签名变化重建与 logInfo/坏声明保留旧清单 fail-open/apply 期零声明事件边界），341→344；2026-11-01 内部任务-272 适配层缺陷修复 +27（`hooks-bridge` +6：Stop `turnId`/声明面诊断/apply 级诊断/plan 门控装配/端到端回显；`client-bundle` +5：六插件行 i18n＋渲染级锁；新增 `declaration-diagnostics` 8/`plan-mode-gate` 6；遗留项收尾批 +2：`long-task-driver` 20→22 的 Stop/LongTaskStop plan 门控装配差分），303→330；2026-10-31 内部任务-268 配置面 v2 +4：`config-surface` +2（八字段默认/过滤与根比较＋apply 四面过滤）/`hooks-bridge` +1（osObservation 环境缝）/`client-bundle` +1（分组列表卡片多字段保存），299→303；
2026-10-26 内部任务-236 O2 补强 +2：`config-surface` +1（R-da-13 切换不回收回归锁）/`client-bundle` +1（保存成功采纳 revision 2-save 链），297→299；
2026-10-23 内部任务-220 桥接首轮通道提示 +8：`agent-control-bridge` +5/`config-surface` +3；2026-10-23 内部任务-227 UPS `parent_session_id` 条件键 +1（`hooks-bridge`）；2026-10-25 内部任务-209 S2 `hooks-bridge` +2（in-process apply 事件派发/桥接面补测，295→297；该文件另经 scope `excludeTestFiles` 从覆盖率步骤拆分，见 内部决策-064 修正案 5）；
第九类＝插件页配置面，默认关）：

- **DSH 长任务编排**（`tests/long-task-driver.test.mjs`，25 项）：首轮 pre-step 协议投递（不落 durable
  next-step）、`todo_write` 快照（人类提示冻结/重新武装、malformed 清空、派发门控）、Stop 主/fallback
  受控续跑（预算/冷却/goal 让位/signal aborted/阻断让位/10 次上限/5 条截断）、steer 缺失 fail-open、
  host-gate 零注册 + logInfo、warn 去重。**内部任务-173 同批**：SessionStart additionalContext 亦走首轮
  pre-step 投递（顺序 SessionStart → UPS → 长任务协议），空 sid 不写槽并一次性 warn。**内部任务-199（内部决策-053
  2026-10-22 修正案）**：协议文本增阻塞停机语义——外部阻塞（需用户决策/权限缺位/外部依赖不可用/等待上游）
  当轮停止并报告阻塞条件、已尝试路径与可解性；存在当前 goal 且同一外部阻塞持续达宿主阈值后
  `update_goal blocked`；难度/不确定性/剩余工作不构成阻塞判据。**边界如实**：本改动是**提示层缓解、
  无机器阻塞态**；无 goal 会话在阻塞报告后仍可能被既有预算续跑 1–2 次/人类轮（driver 只读清单不读消息），
  真机帧面未验证（宿主重启窗口，内部未决-170 承接；不得把本条读成「空转已止」）。另两条边界如实：协议可能把
  短暂外部依赖超时误判为外部阻塞而提前停（需人催，观察方式见 内部未决-170）；`git revert` 只作用后续会话
  （协议在首轮 pre-step 注入 messages，已注入会话不撤回）。

- **装载链验收**（`tests/acceptance.test.mjs`，31 项）：按宿主真实装载顺序串成一条链——
  包清单判据 → `cordis.patch.yml` 用**宿主同一解析器**（`js-yaml`）解出顶层 `insert` 形状 →
  **按 patch 的 `name` 动态加载入口** → **Config schema 用宿主真实 schemastery 解析** →
  以节点等价 ctx 调 `apply` → 断言三面注册量与交叉一致 → 五个事件全部走**真实钩子进程**
  产出预期决策 → 命令处理器把渲染后的正文经 `followup` 入队。另含**期二换源的端到端用例**
  （只带 `plugin.manifest.json`、无生成物的插件根：真被认作插件根 → 真装配 → 真跑钩子，
  且 `${PLUGIN_ROOT}` 占位符被替换）。另含**抽取缓存判据**：
  身份三分量（`appRoot` 路径 / `size:mtimeMs` 指纹 / 内容哈希）与新鲜度语义的纯函数断言，
  加临时根 + 桩 asar 对调用点 `ensureEngineCache()` 的四态覆盖（`extracted` / `reused` /
  `reused-unverified` 诊断 / `unavailable` fail-closed，含"同 size 同 mtime 而内容变"场景），
  以及**内容自证失配**场景（桩内数据被篡改、头内 `integrity.hash` 不变 ⇒ 必须 fail-closed、
  残树不得落进缓存）。
  另含**抽取缓存的并发发布面**（内部未决-43）：抽取走"唯一 staging + 原子 `rename` 发布"，
  发布原语 `publishDir()` 直测四态（同身份成品优先 / 异身份成品不得被复用 / 无 marker 半成品
  清掉后重抽 / 空目标直接发布），加异身份三进程并发用例（子进程按 `mode` 定退出码、父进程用
  第 4 个身份断言"绝不复用并存成品"）与半成品目标整链用例；缓存目录的陈旧 `.staging-`（含历史 `.retired-`）
  由 `gcStaleStaging()` 兜底清理，其判据（陈旧被清 / 新鲜与自己 pid 的保留 / 非本前缀不碰）由
  `抽取缓存（陈旧清理）` 用例覆盖。**自察注入缝**（内部未决-44②）：本套件驱动的真实钩子统一注入
  `WF_INCIDENT_ROOT=<临时根>`，夹具会话（`acceptance-session`/`inv`/`inv2`）记录不再写生产账本，
  并以"临时根确有 `tf-` 记录 + 生产账本夹具会话行数不变"两头夹住。
- **ZCode 零影响不变量**（同文件，5 项）：内部接口-1 登记的十一个契约工件（条件十一行表——research-loop 零钩子无 hooks 行）哈希与登记值逐一
  核对；`apply` 及其钩子运行期间**六插件 86 份受监视资产（内容资产 80〔含 hooks.json 5〕＋6 份 plugin.json＝86；契约工件与内容资产存在 5 份 hooks.json 重叠，人工维护值；不变量测试按
  `zcodeContractArtifacts ∪ zcodeContentAssets` 实算口径；research-loop 贡献其中 3 份——plugin.json＋2 份 SKILL.md，零钩子零命令）
  的 sha256 与 mtime 前后一致**；六插件清单版本与 内部接口-1 版本行一致；**六插件全树不出现
  `ai-coding-methodology` 任何引用**（不存在反向耦合边）；套件发布面仍只认六个插件（适配层不进市场镜像）。
- **agent 面**（`tests/agents-bridge.test.mjs`，28 项）：前言解析 / 工具词表映射 /
  `toolFilter` 推导（含"写工具永不进 allow"与"目录里没有就不写"两条硬约束）/ 三份委派工具
  挂载（toolName 唯一、provider 一致）/ **目录不可得时 fail-closed** / 逐条隔离 /
  **`ctx.plugin` 以 rejection 报错时逐条隔离且不谎报成功** / **候选工具名的有效性依据
  （源码链归档：restrictableNames 无条件含全局注册名 + 子 agent 经 composeFrom 继承父的
  预置版本）**。其中 4 项直接跑真实 `workflow/agents/*.md`。
- **纯函数与契约**（`hooks-bridge` / `commands-bridge` / `skills-bridge`）：matcher 词表归一 /
  声明解析（**中立清单形态与 ZCode 形态两路**：中立源优先、清单在手即权威——删掉的声明不被旧
  生成物"复活"；无可用中立源才回落生成物，含缺失 / JSON 损坏 / 顶层非对象三态）/
  **期二换源等价断言**（六插件由中立清单与生成物派生的处理器逐字段一致——research-loop 零钩子两侧恒空，只允许占位符 token 与
  事件序这两处形态差异）/ 负载构造 / 信封解码（含四插件三种真实形态）/ 合并 / 命令引用 /
  frontmatter 解析
  （含流式集合保守判据）/ 布尔字面量 / 名归一 / `$ARGUMENTS` 替换 / 工具列表拆分 /
  `BashOutput` 无对位处置 / `discoverFromInstalledPlugins` 的坏记录矩阵 / cordis 服务读取契约
  （`Proxy` 复刻"未 inject 属性读必抛"）/ fail-open 语义五事件逐个验。
- **真实资产扫描**：32 份 `SKILL.md` + 9 条命令 + 3 份 agent 声明全部可解析、名唯一、正文
  与磁盘字节一致，并按宿主 `validateRuntimeSkill` / `normalizeDefinition` 的判据复刻的
  伪注册表**全量校验**（含同层同名 first-wins 与默认值补全）；命令的薄指针必须落在已注册
  skill 上（两面交叉一致）。**这三个数字本身也被断言钉住**（`jsdoc-contract.test.mjs`
  的资产计数用例：脚本收集到的条数必须与上面写的相符），改动资产数时会立刻报错而不是静默漂移。
- **插件页配置面**（`tests/config-surface.test.mjs`，12 项 + `tests/client-bundle.test.mjs`，14 项）：
  宿主半侧＝8 个 volatile 字段语义与默认值、`apply` 按六插件开关过滤四面（全关零注册/仅核心两插件/日志）、
  OS 环境缝注入、`agentControlBridge` 创建时读当前值（差分锁）与 fail-open；客户端半侧＝以模拟宿主
  ModuleLoader 求值 `client/client.js`（分组列表卡片、多字段一次保存、写后重读比对、命名空间未服务诊断、
  失败保草稿/打包契约）。**真机 UI 冒烟已执行**（2026-10-31 重启批，内部未决-230 关闭；证据 `内部真机冒烟证据`：卡片截图/持久化/六插件开关正负两态/桥接工具）。
- **引擎装载与拒载**（`tests/engine-loader.test.mjs` 8 项 + `tests/apply-refuse.test.mjs` 2 项）：
  `resolveEngine` 的仓库根定位（`repoRootOverride` 显式优先且不兜底）、装载期机械断言（7 条消费规则
  均含 `params.dsh`）、绑定三语义（未绑定抛错 / 同实例幂等 / 异实例抛错）；`apply()` 拒载路径
  「先 `logWarn`（含尝试路径与修复指引）再外抛、四面零注册」与同进程二次 `apply()` 幂等。
- **JSDoc 契约**（`tests/jsdoc-contract.test.mjs`，14 项）：src 下每个导出（函数/常量）的紧邻
  JSDoc、`@param` 数量、async 的 `@returns`；守卫自身带反向对照样本；**README 的测试计数
  声明与实测逐项一致**（防"改了代码没改文档"的残留数字，见设计文档 §8.39/§8.40）；另含
  **元数据契约**（可发布／有介绍／可被搜到，见 §8.93），以及 **插件页元数据读取面**
  （`exports` 必须导出 `./package.json` 与 `./locale/*`——宿主的 `readPluginMeta` 用模块解析器
  读它们；只写 npm `description` 字段在插件卡片上**不显示**，见 §8.95）。

## 已知限制与延期工作

- **`inject: ['shell']` 是硬门：宿主不提供 `shell` 时本层整体不加载**（2026-09-28 第 102 批实测）。
  本插件只声明 `inject: ['shell']`（其余服务一律经 `ctx.get(name)` 探测，缺了就只跳过那一面）。
  但 `inject` 的语义是 cordis 的**依赖前置**：把它装进一个**没有 `shell` 服务**的真实 Context 时，
  插件**不报错、fiber 停在 pending、`apply` 一次都不执行**——`ctx.get('shell')` 的宽裕探测
  在这里帮不上忙（那一行根本跑不到）。真容器四格矩阵实测：
  `inject:['shell']` + 无 shell ⇒ `apply` **0 次**；提供 shell ⇒ **1 次**并打出启动日志。
  **何时会遇到**：只装载了不含任何 shell 执行器的 profile。实测官方组合**都有**——
  沙箱执行器按平台互斥（`bash-sandbox` 禁于 win32 / `pwsh-sandbox` 反之），而它们继承自
  `ShellExecutor`（构造为 `super(ctx, 'shell')`），故 `shell` 服务由沙箱执行器提供。
  若你的 profile 恰好都没有，本层不会加载，请为它装载一个 shell 执行器；这是 `inject` 的语义，
  不是本层的缺陷。（本层**不会**把 `shell` 从 `inject` 移除以"避免不加载"：钩子面**必须**有 shell
  才能执行任何钩子，移除只会把"整体不加载"换成"加载了但一个钩子都跑不了"，后者更难排查。）
- **DSH 长任务编排（内部决策-053）**：首轮 `agent/pre-step` 投递协议（不落 durable next-step）；无 `goals`
  服务时功能不启用并 `logInfo`；状态仅内存（resume/fork 丢失）；goal 存在（含 complete）即让位；
  `source.kind` 漂移无告警；plan 模式识别已实现（首轮协议门控有模块/装配级测试；Stop/LongTaskStop 让位装配级已补（2026-11-01 遗留项收尾批），真机端到端未验证，内部未决-236 仅保留真机承接）；`dispatchFactSeen=false` 时派发门控 fail-open；无
  Config 开关；`states`/warn Map 无 cap。真机 happy path（协议/续跑帧 seq 4413/675）来自修复前 build，
  post-fix build 需下一次重启复验；`/goal` 与 Stop 派发期间取消的负向对照未真机验证（内部未决-149）。
  **内部任务-199 追加边界**：协议阻塞停机语义为**提示层缓解、无机器阻塞态**——无 goal 会话阻塞报告后仍可能被
  续跑 1–2 次/人类轮；blocked 后 goal 让位交互未取证；误判外部阻塞会「过度停机」；真机帧面未验证
  （内部未决-170）；`git revert` 只作用后续会话。
- **SessionStart 投递（内部任务-173，内部未决-150）**：`agent/created` 仍**同步等待**全部 SessionStart 钩子
  （副作用与延迟预算不变），但文本改为入 apply 闭包 `Map<sessionId,string>` 槽、首轮 `agent/pre-step`
  追加 `decision.messages`——不再 `agent.inject`，故恢复/空闲未发消息会话不再留下 durable next-step
  （桌面退出误报的 created 期最后一处来源）。语义边界：**每 agent 生命周期一次**（created 重置槽；
  resume/重建会再投一次，与旧 inject 一致）；`reject` 轮保留槽、下一可进入轮再投；委派会话不筛
  depth（保持旧行为）；空 `session_id` 会话钩子照跑但**不写槽不投递**并一次性 warn（防跨会话串投）；
  槽无 cap（元技能全文约十至数十 KB/会话，随进程内会话数有界）；投递失败一次 warn + fail-open。
  真机验证（重启 DSH 后：无 created next-step 插入、空闲退出无弹窗、首轮投递帧）已于 2026-10-20 通过，内部未决-150 已关闭。
- **agent 面默认关闭且当前宿主不可用**：`agents/*.md` 的解析/词表映射已实现，但宿主 0.2.1-rc.5
  起 `dsh-tool-subagent` 以 Agent Preset 承载 persona 与工具面（`persona`/`toolFilter` 配置面被移除、
  显式抛错），且 rc.5 Web profile 全局工具行禁用 ⇒ `mountAgents: true` 的实际行为是
  **0 挂载＋单次告警**（「agent 面不可用」，内部未决-244 承接重设计）。历史取证（源码链，仍成立）：
  ① 名字有效性——`tools.restrict()` 的校验源 `restrictableNames` 无条件包含全部**全局注册**工具名；
  ② 子 agent 工具面——`composeFrom(childCtx, parent.ctx)` 取父当前预置 revision，子工具面＝父工具面。
  这两条是**旧契约**下的结论，不再构成「可开启」的依据；开启前请以 内部未决-244 的重设计结论为准。
- **`PostToolUseFailure` 语义降级**：DSH 无独立失败事件，失败分类退化为
  `post-tool.mjs` 自己的结构化面防御解析。**2026-09-29 内部未决-46 修订**：宿主 `result` 没有顶层
  `exitCode`（旧读法是死字段），本层改从 `result.value.exitCode`（终端工具真退出码）与
  `result.isError`（edit/read 类失败）装配 `tool_result = {exit_code?, is_error, stdout, stderr:''}`；
  宿主渲染文本里的退出标记（`[exit code: N]` 等）属宿主 seam 契约，本层与核心钩**都不解析**。
- **Stop 的 `turnId` 已消费（内部任务-272）**：宿主 `agent/turn-stopping` 负载含 `{turn, signal}`；本层监听取 `turn`、经 `turnIdOf` 产条件键 `turnId`（缺省/非法不产键并会话级一次 warn），`task-recap.mjs` 按轮去重（`turnId ?? turn_id`）；模块/装配级测试覆盖（apply 级 emit turn=7/absent/0），真机注入频次观测承接后续真机批。
- **`ZCODE_PROJECT_DIR` 按会话 cwd 注入**：ZCode 下由宿主进程环境提供；本层用
  `agent.session.header.cwd` 近似，与 `routing-lib.workspaceRootAnchor` 的语义等价。
- **工具级 matcher 为词表近似**：`Bash` 展开为 `pwsh|bash|Bash`，命中面比 ZCode 宽
  （ZCode 只有 `Bash`）——刻意取宽：漏匹配会让护栏静默空转，多匹配只多跑一次判定。
- **命令面无附件面**：ZCode 命令不接受附件，本层也未声明 `input.attachments`；DSH 支持
  该字段，若将来 ZCode 命令需要附件再开。
- **期二：声明源换源 + 规则引擎全量接线**（2026-10-01）：钩子声明已改读中立清单；**装载面**经
  `apply()` 首步 `ensureBound(() => resolveEngine(...))`（`src/engine-loader.mjs` /
  `src/engine-binding.mjs`，内部决策-037 裁决 A：引擎必需 + 不可得即拒载，fail-loud 前先落日志）；
  **七处消费点已全部改由引擎驱动**（`plugin-core/degradation-rules.json` 的 `params.dsh`）：
  matcher 展开（`tool-vocab-map`）、信封合成与 reason 读取（`failure-event-merge` /
  `message-slot-migration`）、会话来源归一（`source-widen-normalize`）、命名空间
  （`namespace-transform`）、命令 followup（`followup-expansion`）、agent 挂载极性
  （`agent-default-off-fail-closed`）——**旧手写实现（含 `TOOL_ALIASES`）已随接线删除**，
  本层不再持有策略逻辑；工具词表/只读禁忌（`TOOL_MAP`/`CORE_TOOLS`/`EXTENDED_TOOLS`/
  `READ_ONLY_FORBIDDEN`）按 内部决策-037 计划**豁免保留**（候选词汇表＝宿主目录来源面，非降级策略）。
- **装机通道：装包与组合已实测，仅"启动日志"未观测（操作方收口）**。此前这里写着"asar 内的
  `package.json` 带 BOM 残留、本机无法跑 CLI、`dsh plugin add` 无实测证据"——**已更正**
  （2026-09-28 第 45 批起）：asar 里的文件本身完好，问题在读取器。**但"正确边界 = 从 `offset + 2`
  起读"这句在 2026-09-29（DSH 0.2.0-rc.2 验证批次）被逐字节对照证伪**：文件内容位于
  `16 + headerSize + offset`、长 `size`，中间**没有任何填充**；`+2` 会让每个文件丢掉前 2 字节
  （抽出的 `package.json` 直接 `ERR_INVALID_PACKAGE_CONFIG`）。该误判长期藏在
  `tests/helpers/dsh-engine.mjs`（同批已修，见 `内部未决项台账` 内部未决-45）。按正确边界提取并
  叠加 `app.asar.unpacked/`（Electron 把原生 `.node` 放在那里）之后，实测通过：
  CLI 可执行 → `dsh plugin add` 把本包写入 profile `dependencies` 并**自动登记进
  `dsh.profile.bundles`** → `--dump-config` 出现 `# == ai-coding-methodology` 层头 →
  `--dump-config-schema` **导入本模块并读出 `Config`**（退出码 0）。
  **仍缺**：真实启动时 `apply` 的三行日志——该步需要**真实 API 凭据**（本运行时只有
  `dsh-llm-deepseek` / `dsh-llm-pi-ai` 两个提供方且都要凭据，无 mock 提供方）。
  操作方在**有凭据**的宿主上装好后看启动日志即可闭环。
  **2026-10-17 内部任务-68 补证（本"仍缺"收窄）**：无凭据的真实 headless 启动（临时 `DSH_HOME`、
  `dsh-base＋dsh-headless＋ai-coding-methodology` 三 bundle 的 profile）在凭据错误退出前已
  完成新会话创建，会话记录实测 30 份插件 skill 进 `<available_skills>`（当时资产数；现为 32，见计数节）＋SessionStart 上下文（内部任务-173
  起为首轮 pre-step 投递）与租约行均在 user 消息面——**新进程启动装载下 skill/钩子面已实测生效**；运行中 desktop profile 自身重启已由 内部任务-268 重启批（2026-10-31，证据 `内部真机冒烟证据`）覆盖。
  另记一条操作面更正：**普通 CLI 不要用 `desktop` profile 装**——CLI 的 `rejectElectronProfile()`
  对 `desktop` 直接报错，且该校验在 `plugin` 子命令上同样生效；正确路径是另起专用 profile
  （见上文「安装」），并**指定临时 `DSH_HOME`** 以免污染运行中的真实 profile。
  **2026-10-17 内部任务-68 补注（例外面已实测）**：官方桌面版自带 CLI 以 `manageDesktopProfile: true`
  启动、允许对 `desktop` 执行插件管理；本批即用该通道把本层装进真实 desktop profile 并观测到
  热装载（本批实测：skill 面 30 份热更新进会话〔当时资产数；现 32〕＋钩子面实跑；命令面随 `apply` 注册、宿主侧未单独取证）。
  故"不要用 desktop 装"的否定面收窄为**普通 npm CLI**；桌面版
  自带 CLI 的装机与热装载实测见上文安装节。

## 新宿主接入模板指针

第二宿主 DSH 适配层：新宿主接入模板走 内部模块-22 `R-ha-6` **三阶段**（设计取证→规格批→实施批），接入前必做**先例对照**（过既有宿主已修缺陷与未决项清单）；本宿主的分册/矩阵行/缺口台账见 `内部规格 内部模块-22` 对应节。
