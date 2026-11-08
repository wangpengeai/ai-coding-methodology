# mcode-adapter —— MiniMax Code 宿主适配层

> 把本仓六个 ZCode 插件（workflow / spec-gate / scout / team-governance / algo-loop / research-loop）适配到
> **MiniMax Code**（下称 MCode；本仓不绑定单一运行宿主，2026-10-19 曾为本仓运行宿主）上。**ZCode 侧资产零改动**：本目录只读
> 六插件的 `.zcode-plugin/plugin.json`、`hooks/hooks.json`、钩子脚本与 skills/命令/agent
> 正文，不写其中任何一个字节；ZCode 上的可用性因此不受影响。

决策记录见 `内部规格 内部决策-034`；契约实例化登记见 `内部规格 内部接口-1`
「第三宿主实例化登记」节；取证与逐字摘录见 `内部设计记录`；
实施计划见 `内部实施计划`。

## 为什么不是"再写一份声明"

MCode 是**静态声明式**宿主，与前两个宿主的关键差别有三条（逐条依据见设计文档 §2）：

1. **没有运行时注册面**：DSH 侧可以用 `ctx.skills.register()` / `ctx.commands.register()`
   在运行期注册；MCode 没有任何注册入口，一切能力必须在安装前以文件形态落进包目录。
2. **清单只接受包内相对路径**：`skills/<名>/SKILL.md` 必须**物理存在于包内**；绝对路径、
   `..` 与符号链接一律被拒。故 skill 正文无法靠"运行时注册"绕开复制。
3. **无运行时注册面，无命令面**：本地插件能力面为 App / MCP / Skill / 子代理 / Hook 五类，但都需要在安装前以文件形态落进包内（本层只用到 Skill / Hook 两类，另以数据目录承载 agent）；**没有命令面**，命令只能以 skill 承接。

> **2026-11-02 内部任务-287 事实校正**：本节原写「能力面只有 MCP / Skill / Hook：本地 App 被忽略，没有命令面，也没有 agent 面」。
> 按宿主现行契约，`local-plugin-v1.md` 与 `local-plugin-agents.md` 已支持**包内子代理**（清单 `agents: ["agents/<name>.md"]`）
> 与 **App 面**（`apps: [".app.json"]` 声明 Connector provider），`local-plugin-hooks.md` 列 **11 个事件**。
> 本层**当前仍未适配**这两面：agent 继续走数据目录安装并默认关（见下文「agent 面为什么默认关闭」），
> `apps` 恒为空。未适配面登记 `内部未决项台账` 内部未决-255/内部未决-256/内部未决-257（内部未决-256 已于 2026-11-02 内部任务-293 关闭：判据文案校正，App 面仍未适配，重开条件见其墓碑行）。
> 「无命令面」「无运行时注册面」两项结论不变。

所以 MCode 侧的接入形态是**物化**：安装器把每个插件的资产 + 一层适配声明落成宿主可扫的包。
仓内**不留镜像**（32 份 `SKILL.md` 副本即纪律漂移面，内部决策-032 已在 DSH 侧否决过同一做法），
仓内只有生成器 + 声明模板 + 测试；物化目标在宿主唯一扫描面（数据目录 `plugins/`）。

## 四个面

| 面 | ZCode 资产 | MCode 落点 | 状态 |
|---|---|---|---|
| 钩子面 | `hooks/hooks.json` + 钩子脚本 | 包内 `mcode/hook-shim.mjs` 转发（生成期把声明翻成 MCode 形态） | ✅ 默认开启，20 个处理器（16 声明去重＋4 生成期合成 UPS） |
| skill 面 | `skills/<名>/SKILL.md`（32 份） | 逐字物化 + 清单登记 | ✅ 默认开启 |
| 命令面 | `commands/*.md`（9 条） | 4 条薄指针由**对应 skill** 承接（1 条同名 `gate`、3 条改名）；5 条操作型命令物化为同名 skill | ✅ 默认开启，合计 37 份 skill |
| agent 面 | `agents/*.md`（3 份） | 数据目录 agent（`<数据目录>/agents/<名>/agent.md`） | ⚠️ 默认关闭，`--with-agents` 开启 |

宿主以 `/<插件名>:<技能名>` 暴露 skill。**薄指针里逐字复现的只有同名项** `spec-gate:gate`；
其余命令不受影响——5 条操作型命令物化为**同名** skill，斜杠名照旧（`/spec-gate:init`、
`/spec-gate:evidence`、`/team-governance:init`、`/team-governance:gate`、`/workflow:feature-dev`）。
薄指针里 3 条改名（正文就是被指向的 skill，物化第二份副本只会制造第二个事实源）：
`/spec-gate:backfill`→`spec-backfill`、`/spec-gate:spec`→`spec-writing`、`/team-governance:eval`→`agent-eval`。

## 能力摘要（可用 / 降级 / 未验证）

一面一句、三态如实的当前能力盘面（2026-10-13 盘点，随 内部任务-55 批更新）。注意：**机械包映射测试 ≠ 宿主 UI/真机会话验证**——下表「可用/降级」以机器证据（包映射、真实钩子经 shim 往返）为准，「未验证」诚实保留待真机探针，不以文案假关闭。

| 面 | 状态 | 说明与建议动作 |
|---|---|---|
| skill 面 | ✅ 可用 | 逐份逐字物化 + 清单登记，宿主按 `/<插件>:<技能>` 暴露 |
| 命令面 | ✅ 由 skill 承接 | 宿主无命令面：操作型命令物化为同名 skill；薄指针由对应 skill 承接（1 条同名、3 条改名并如实标注） |
| 钩子·护栏/租约/冻结 | ✅ 可用 | 同一份 ZCode 钩子经 shim 真跑：deny 文案翻译不丢、check-freeze 的 fail-closed 极性保持 |
| 钩子·Stop/完成闸 | ⚠️ 降级 | 宿主单处理器 10 秒上限低于完成闸 60 秒声明时限：verify-gate 常跑不完，降级为零输出放行 + 落提醒与手动补跑指引（`/spec-gate:gate`）；阻断连击超上限后降级放行（降级事实随提醒投递，不隐藏） |
| 钩子·PostToolUse | ⚠️ 硬阻断不成立 | 宿主把阻断折成上下文提醒；「退出码 2 且无信封」的硬阻断档在本宿主无对应阻断位（并入待投递提醒，不静默） |
| 失败自察 | ❌ 本宿主不可观测 | 真实会话失败调用（退 3）**零落账**（账本 1237→1237 行），正向对照已过故排除假阴性；门控诊断实测 wire 顶层键**不含任何结构化失败字段**（顶层无 `is_error`，`tool_response` 内亦无）⇒ 结构性不可得，非配置问题（内部未决-49 已关闭） |
| agent 面 | ⚠️ 默认关 | `--with-agents` 显式开启；委派全过程未在本宿主实测 |
| 真机触发 | ⚠️ 部分实证 | 已实证 5 格（workflow×SessionStart 新会话诊断帧 / UserPromptSubmit / PreToolUse 租约闸 / Stop 中继 ＋ team-gov×SessionStart 降级帧）；其余格因**宿主无钩子派发日志**不可判定，逐处理器 16 路在现观测面下不可达（内部任务-55 样本）；本批新增 4 条合成 UPS 投递腿（真机仅覆盖 team-governance，其余三包按已装产物核对），由探针作业单 P1–P8 承接（内部未决-78 部分关闭） |

## 钩子面：为什么是 shim 而不是改脚本

每个 MCode 处理器都指向包内的 `mcode/hook-shim.mjs`，它做四件事：读宿主负载 → 归一成
ZCode 形态 → spawn **被物化的 ZCode 原钩子** → 把 ZCode 信封译成 MCode 响应。判据、护栏、
租约闸、完成闸仍是同一份代码在跑（钩子脚本是冻结资产，同 `spec-gate/core` 的哈希纪律）。

差异处置表（逐条依据见 内部接口-1 第三宿主登记与设计文档 §2.3/§2.4）：

| # | 差异 | 处置 |
|---|---|---|
| 1 | 处理器形态：`args` 数组 / `timeoutMs` vs 单 `command` / `timeout` 1..10 | 生成期翻译（`hook-template.mjs`），时限按 10 秒封顶取小 |
| 2 | 工具名与入参：`Bash`/`file_path` vs `bash`/`path` | shim `normalizePayload`：工具名映射表 + `file_path` 补写 |
| 3 | deny 文案位：`hookSpecificOutput.systemMessage` 落在宿主内层键白名单外 → **整帧作废** | shim `translateResponse` 翻成 `permissionDecisionReason` |
| 4 | `PostToolUseFailure` 无对位 | 两通道合并到 `PostToolUse`（同脚本只留一个处理器），shim 合成 `tool_result` 结构面 |
| 5 | Stop 无上下文注入位 | 阻断直译 `decision:"block"`+`reason`；非阻断提醒走**待投递**中继 |
| 6 | 会话来源多 `fork` | 域外归一到 `startup`（取宽不取窄，路由纪律唯一通道不容静默失效） |

### Stop 的两处特殊处置

- **待投递中继**：`task-recap` / `learnings-recap` 依赖 Stop 期的 `additionalContext` 非阻断
  注入，而 MCode 的 Stop 文档化输出只有 `decision:"block"`。shim 把这类提醒落进 `PLUGIN_DATA`
  的队列，由**下一次 `UserPromptSubmit`** 以 `additionalContext` 投递（队列按文本摘要去重、
  上限 20 条）。不依赖未文档化的"Stop 也吃 additionalContext"行为。
- **连击上限**：完成闸（`verify-gate`）的阻断在连击超过 3 次后**降级为提醒**并放行，
  防止无界续跑（宿主文档要求钩子自维护一次性守卫）。降级事实随提醒一起投递，不隐藏。

### 时限降级（fail-open，不假装通过）

MCode 单处理器 `timeout` 上限 10 秒、每事件总预算 15 秒，而 ZCode 侧四个处理器的声明时限
超出该上限（`verify-gate` 60 秒 / `spec-gate` 的 `post-tool-use` 30 秒 / `spec-gate` 的
`session-start` 15 秒 / `team-governance` 的 `session-start` 20 秒）。shim 对子进程设内部 deadline
（声明时限减 800 ms 余量），超时即终止子进程、**零输出放行**、并落一条"降级"提醒。四项降级如实登记在 内部接口-1 时限面缺口节。

## 失败事件面：结构化事实的边界

`post-tool.mjs`（运行自察）按**结构化事实唯一判据**消费 `tool_result`（内部未决-46 的纪律：文本
不单独构成失败判据）。MCode 的 wire 负载给的是 `tool_response`，形态不可预知。shim 的判序是：
**结构化字段**（`is_error` / `isError` / `exit_code` / `exitCode`）→ 宿主渲染文本的**最后一行**
`[exit code: N]` 标记 → 皆无即"不可知"（交给核心件的"宁漏不误报"分支）。

**2026-09-30 实测**：本宿主渲染失败命令的结果文本里**没有任何退出标记**（`node` 退 3、
`cmd` 退 7、`py` 退 4 三例均为纯输出），故标记分支当前不可观测；失败能否被自察记下，取决于
`tool_response` 是否带结构化字段——这一点需要装入后在真实会话里做一次探针取证
（内部未决-49）。合并后的 matcher 取窄到 `bash|edit|write`（ZCode 成功通道的三个工具），
理由与代价见 内部接口-1 第三宿主登记。

## 安装

```sh
# 计划（不落盘）：先看将要写什么
node mcode-adapter/cli.mjs install --dry-run

# 物化到宿主数据目录（默认 <家目录>/.minimax；可用 --data-dir 或 MINIMAX_DATA_DIR 覆盖）
node mcode-adapter/cli.mjs install

# 连三份 agent 一起装（默认不装；只读定位 agent——code-reviewer 工具面含 Bash，非纯只读）
node mcode-adapter/cli.mjs install --with-agents

# 升级到删除面变化的新版本时，显式清理计划外旧文件（如 Python core；默认不删目录）
node mcode-adapter/cli.mjs install --prune

# 核对已装包与源仓是否漂移（缺失/多余/变更逐条列出，非零退出即红；只读、不产生宿主写副作用）
node mcode-adapter/cli.mjs verify
```

`--json` 输出同一份报告的机器可读面（`install`/`verify` 共用字段）：

| 字段 | 含义 |
|---|---|
| `ok` | 本次是否通过（`verify` 成功时也为 `true`，不再是 `null`） |
| `phase` | 失败阶段：`precheck`/`write`/`verify`/`rollback-incomplete`（成功为 `null`） |
| `exitCode` | 进程退出码（0/1/2） |
| `message` | 失败摘要（成功为 `null`） |
| `backupRoot` | 回滚不完整时保留的备份根（其余为 `null`） |
| `warnings` | 非阻断告警（如备份根残留），文本模式逐行以 `! ` 输出 |

**写后即验＋失败回滚（内部决策-054 G-01）**：`install` 写前对既有包做 **copy 式备份**到
`<数据目录>/.mcode-adapter-backups/<YYYYMMDD-HHmmss-pid>/plugins/<plugin>/`（agents 同级 `<ts>/agents/`；原目录留位），逐包原子落盘后**立即
重跑核对**（缺失/变更/装载探针；`extra` 仅在本次带 `--prune` 时纳入——默认 install 允许计划外文件在场
并退 0，这是运行中会话路径保护的同向取舍）。核对失败或写盘异常 → **回滚到调用前状态**（按调用前文件级
指纹复核）：回滚完整则清理备份根并退 1（写后即验失败）或退 2（写盘异常）；回滚不完整则**保留备份根**并
输出人工恢复指引退 2。成功路径同样清理备份根，故不产生 `.bak` 无界累积。

**默认 install 允许计划外文件在场**；`--prune` 是升级删除面的显式收口路径——带 `--prune` 时写后即验会
将计划外文件计入并清理；若旧计划外文件本不应删除，请先不带 `--prune` 安装（退 0 保留）。

物化后宿主会**自动重扫**本地插件并新建内容寻址缓存树，无需手动刷新；但**插件树（钩子与技能/清单呈现）按会话创建时固化——运行中会话不换树，改包生效需新会话**（2026-11-08 内部任务-354 真机三态对照＋hot-probe 判别，更正 内部任务-288「下一轮即生效」的样本外推）。识别成功与"钩子命令真的能跑"是两件事：
后者要在真实会话里触发一次事件才能取证（见「已知限制」）。

解释器在**安装期解析**（PATH → 常见绝对位置 → 进程自身），解析不到即**拒绝安装并报缺依赖**
（不静默降级、不写坏包）。解析结果以绝对路径写进生成的处理器命令——宿主不为钩子注入独立
Node，故此处不能用裸 `node`；代价是**换机后需重跑 `install`** 重新解析。

写面只有三处：宿主数据目录的 `plugins/`、（`--with-agents` 时）`agents/`、以及安装期**瞬时**备份根
`.mcode-adapter-backups/`（成功/完整回滚后清理、回滚不完整时保留供人工恢复）。安装器**不删目录**
（逐文件原子落盘：临时名 + rename），避免运行中会话正持有的钩子路径被删掉而静默失效——
这条来自 ZCode 侧 2026-09-12 的实测教训。`verify` 为只读核对：`agents/` 存在且带本层管理标记时核对
（无标记＝未管理面静默）
（缺失/变更/多余逐条报出并退 1），不存在＝未安装面不报漂移；`verify --with-agents` 也**不写**
agents（历史写副作用已在 内部决策-054 G-02 移除）。`install --with-agents --prune` 额外清理计划外
agent `.md` 文件。

## agent 面为什么默认关闭

三份 agent 的 `tools:` 是 ZCode 的 PascalCase 词表（`Glob, Grep, LS, Read, WebFetch,
WebSearch, TodoWrite, BashOutput`），本宿主用原生名（`glob, grep, read, web_fetch,
web_search, todowrite`）。映射规则：同名直映，`LS` 归 `glob`（本宿主无独立列举工具），
`BashOutput` 无对位按**拒绝**丢弃（它只读输出，丢弃不放宽权限）。**映射后工具面为空则不装**。

默认关闭的理由与 DSH 侧同源：本层从未在**跑起来的宿主**上观测过委派全过程，工具白名单映射
的残余风险用"显式开启"兜住（最坏情况是三份 agent 装上后不被宿主认出来，不影响其余四面）。

**agents 面归属标记（2026-10-21 真机修正）**：MCode 真机数据目录自带 `.builtin/` 内建 agent，
本层不在其中；`--with-agents` 写成功后在 `<数据目录>/agents/.mcode-adapter-managed.json` 落管理
标记，`verify`/`prune` **只对带标记的 agents 面**核对/清理——未管理面不误报缺失/多余，宿主内建
（顶层 `.` 开头目录）不参与多余/清理判定。因此：未跑过 `--with-agents` 的数据目录，`verify` 对
agents 面保持静默（这是设计而非漏检）；跑过之后本层三份 agent 的缺失/变更/多余仍逐条报出。

## 升级与回滚（批 3 起：包内含引擎副本）

本层自 内部决策-037 批 3 起把**宿主中立引擎闭包**（`plugin-core`：两数据 JSON + `src/*.mjs` + `src/strategies` 六族）
随包物化到 `<数据目录>/plugins/<插件>/plugin-core/`，运行期 `mcode/hook-shim.mjs` 从**包内**装载它。

- **升级**：仓库侧改完 → `node mcode-adapter/cli.mjs install`（整体重写六包；`install` 只写计划内文件，
  **不删目录**）→ `node mcode-adapter/cli.mjs verify` 核对（逐文件**逐字节比对** + **装载探针**；sha256 仅用于树指纹，见 内部任务-320 口径统一）。
  宿主会自动重扫本地插件并新建缓存树，无需手动刷新；但**插件树按会话创建时固化**——运行中会话不换树，改包生效需新会话（2026-11-08 内部任务-354 真机三态对照〔旧会话仍旧树／新会话取新树／hot-probe 判别〕更正 内部任务-288 的「下一轮即生效」外推，内部未决-159）。**样本边界**：实测覆盖 1 事件 × 1 插件 × 1 次装包；技能/清单与钩子同在一片插件树，故同受会话边界约束，不要据此推断运行中会话会看到新技能列表。
- **从 0.21.x 升级到本版：包内 `agents/` 会被判「多余」**（内部任务-291）。本版起默认包**不再携带** `agents/*.md`
  （源侧那三份是 ZCode 形态、含 `skills:`/`features:`，MCode 包内子代理走另一套 frontmatter 契约，照搬只会留下
  宿主不认的死文件）。因此升级机执行 `verify` 会报 `workflow` 包 3 项多余并退非零——**这是预期行为，不是装坏**：
  先按提示确认清单，再 `install --prune` 收敛即可。三条需记住的事实：
  ① **`prune` 之前 `verify` 必红**，不要因为红就回滚；
  ② **`prune` 只删文件、不删空目录**，包内会留下一个空的 `agents/` 目录（无害，`verify` 不计目录）；
  ③ **包内 `agents/` 与数据目录 `agents/` 是两处不同的面**——前者是宿主原生子代理（本版不产出），
  后者是 `--with-agents` 装的数据目录 agent，两者互不影响。
- **回滚**：`git revert <本批提交>` → 按 `verify` 报出的「**多余**」清单**清掉新增的 `plugin-core/` 副本目录**
  （`install` 不删目录，故这一步必须手工做）→ 重跑 `install` → 再 `verify`（应「缺失 0 / 多余 0 / 变更 0」）。
- **漂移与不可装载**：`verify` 同时把守两件不同的事——**字节一致**（逐文件字节比对）与**可装载**
  （真实 `import → loadEngine(<包根>)`）。「清单漏文件/目录层级错」会让副本逐字节全等却 `import` 失败，
  这一面只有装载探针抓得到；探针失败即 `verify` 非零退出。
- **引擎不可得时**（副本缺失/被改坏）：按事件给**可见面**——`PreToolUse` 升格 `ask`+原因，
  `SessionStart`/`UserPromptSubmit`/`PostToolUse` 发诊断帧（含副本实际路径、`verify`/`install` 两条命令、
  「请把本提示转述给用户」），`Stop` 走待投递中继；同时追加 `<PLUGIN_DATA>/hook-diagnostics.log`
  （宿主 stderr 对用户不可见，故不写 stderr）。
- **规则库字段契约漂移**（已装载后消费点具名抛错）走**独立兜底**：可见面前三种同左，但 `Stop`
  既不落帧也不入队、只写一行诊断——该路径刻意零状态 I/O（不解析包根、不读写状态），避免兜底自己再抛。
- **Node 版本**：运行期以 `await import(pathToFileURL(…))` 装载包内引擎（内部未决-58 已随
  内部任务-HANDOVER1002-1 关闭，见 `内部未决项台账`），**不再受 `require(esm)` 的
  Node ≥22.12/≥20.19 门槛约束**；更早版本同样能装载含顶层 await 的 ESM 引擎。
- **禁手改**：包内 `plugin-core/` 是**生成物**（源＝仓库 `plugin-core/`）——改引擎请改仓库源并重跑 `install`，
  手改副本会被 `verify` 判红。

## 已知限制（如实登记，不美化）

1. **完成闸退化为提醒**：10 秒处理器上限下 `verify-gate` 常跑不完，改为落提醒 + 手动补跑
   指引（`/spec-gate:gate` 或 `spec-gate/assurance/cli.mjs gate`）。
2. **PostToolUse 无硬阻断位**：宿主把 `decision:"block"`+`reason` 折成上下文提醒
   （源码 `parsePostToolUseOutput` 的 `mergePluginHookContext` 分支）。另有一类更硬的形态：
   ZCode 侧只写 stderr、退出码 2、**不输出信封**（`spec-gate` 的
   `ZCODE_USER_CONFIG_SDD_HOOK_BLOCK=true` 阻断档即是），本宿主无对应阻断位——本层已把
   "退出码 2 且无信封"并入降级分支，改为**落一条待投递提醒**（不再彻底静默），但阻断
   语义在本宿主不成立。
3. **team-governance 的 SessionStart 补位采集**在 10 秒上限内可能只落部分段。
4. **失败分类在本宿主结构性不可得**（2026-10-13 内部任务-55 定案，内部未决-49 关闭）：失败调用不落账；
   真机 wire 负载**不含任何结构化失败字段**（顶层无 `is_error`，`tool_response` 内亦无 `exit_code`）
   ⇒ 判序三支在本宿主恒落「不可知」分支，由核心件走宁漏不误报。非配置问题，无改法可修。
5. **包内命令含绝对解释器路径**：换机需重跑 `install`。
6. **兼容格式导入通道无 ZCode 分支**（2026-10-13 内部任务-55 定案，内部未决-48 关闭）：宿主确有 vendor
   适配层（`sourceFormat` 分 CLAUDE/CODEX/MINIMAX），但 `app.asar` 全文 `zcode-plugin` 与 `ZCODE`
   各 **0 命中**（`.minimax-plugin` 63、`.codex-plugin` 13）⇒ 连 ZCode 格式的**识别路径都不存在**。
   命令面以 skill 承接、agent 面默认关闭是**必需处置**而非权宜。
7. **真机会话内的钩子触发取证为部分**（2026-10-13 内部任务-55，内部未决-78 部分关闭）：机械证据 ≠ 包识别
   ≠ 真机触发三层不混（内部决策-034 决策 12）；两轮取证**已实证 5 格**，其余 7 格因**宿主无钩子派发日志**
   （`observability` 386,332 行日志对 `hook-shim`/`PLUGIN_ROOT` 全零命中）不可判定，逐处理器 16 路
   在现观测面下不可达（内部任务-55 样本时点；本批新增 4 条合成 UPS 投递腿，真机仅覆盖 team-governance）；残余由探针作业单 P1–P8 承接
   （`内部探针作业单`，kimi 侧 内部未决-73 同款三层口径）。
8. **状态面无跨进程互斥**（2026-09-30 收尾评审登记）：`PLUGIN_DATA` 状态文件是
   read→modify→write 原子替换，**没有锁**。同一事件同一包内多处理器并发时（workflow 的 Stop
   有 3 个处理器共享一份状态），并发写的连击计数可能互相覆盖，实际连击数偏低。失效方向为**计数偏低 ⇒ 降级被推迟**（更久阻断而非更早放行；2026-11-03 内部任务-305 引擎连击语义改为「仅阻断推进 + `deliverOn` 归零」后与 Kimi 侧同向），故只登记不修；修复方向
   （文件锁或单写者模型）属独立变更。

## 测试

```sh
node --test "mcode-adapter/tests/*.test.mjs"
```

测试项共 196 项（`tests/hook-shim.test.mjs` × 50 + `tests/generate.test.mjs` × 49 +
`tests/install.test.mjs` × 52 + `tests/jsdoc-contract.test.mjs` × 5 +
`tests/engine-materialize.test.mjs` × 12 + `tests/engine-failure.test.mjs` × 16 +
`tests/source-switch.test.mjs` × 5 + `tests/relay-migration.test.mjs` × 6 +
`tests/host-presence.test.mjs` × 1），**十五类**覆盖面（15 条覆盖面条目；末条「驱动方式」为用法说明，不计入类数——同 DSH 侧「九类」口径：2026-11-08 内部任务-356：合成 UPS 投递腿 6 例〔hook-shim 44→50〕＋ generate 增合成 UPS 统计断言及开关缺省面〔48→49〕，189→196；2026-11-04 内部任务-320：内部未决-281 判别力用例 D1–D8〔hook-shim 36→44〕＋ 内部未决-270 缺源预检用例〔install 51→52〕，178→187；2026-11-03 内部任务-295：失败面/归属/
一致性用例 +17，149→166；同日修复复审轮补「源枚举守卫/状态面常态与形状/探针失败分类/
dry-run 结论同档/命令面别名锁」+9，166→175；round3 残留补口 +2〔可装集为空零删除、
`exit 2 无信封` 指引不误导〕，175→177；此前 2026-11-02 内部任务-291：install 增
「源枚举不含 agents/」用例 148→149；2026-11-04 内部任务-311：generate 增非数组 hooks 形态诊断用例（内部未决-276 遗留计数 MISS，47→48，177→178））：

- **宿主在位平台注入面**（`host-presence.test.mjs` 1 项）：`detectHostApp` 以 platform
  注入缝在任意平台断言 darwin/win32 深路径行为（候选展开 ≡ 签名库 ~/→homedir 规则、
  present ≡ 首个存在候选）——函数覆盖不随执行机平台漂移（内部任务-233）；真机在位语义仍由
  install/verify 与 内部决策-048 链承载，本面不宣称在位性。

- **shim 纯函数面**（`hook-shim.test.mjs` 22 项）：工具名映射、写类入参补写、来源归一、
  结果面判序（含"标记只认最后一行"与"本宿主不渲染标记 ⇒ 不可知"两态）、连击计数、
  队列去重与上限、状态原子往返、注入截断（**三条注入面共用同一闸**）、每事件译出形态
  （含 `systemMessage` 必翻）。
- **真实 ZCode 钩子经 shim**（同文件 13 项）：以 **MCode 原生负载**（`tool_name: "write"` +
  `tool_input.path`）驱动物化包内的真实 `check-freeze.mjs` / `check-careful.mjs` /
  `session-start.mjs` / `post-tool.mjs` / `verify-gate.mjs` 子进程，逐条断言响应帧落在宿主
  白名单内（`checkFrameAgainstHost` 复刻 `allowedWireOutputKeys`）、deny 文案不丢、界外静默、
  **负载不可读时原样透传**（`check-freeze` 的 fail-closed 极性因此在本宿主仍成立）、
  失败真的落一条账且只落指纹不落原文、Stop 零输出 → 下一次 `UserPromptSubmit` 两跳投递、
  子钩子"退出 2 且无信封"并入降级提醒（不静默吞掉阻断意图）、子进程超时 fail-open 并落降级提醒。
- **运行观测能力域**（同文件 1 项）：`WF_OBSERVATION_CAPABILITIES` 能力域声明随包注入并可读回
  （四域取值见 内部接口-1 MCode 列；2026-11-08 内部任务-356 起 `hookFailure=degraded`，内部任务-192）。
- **合成 UPS 投递腿**（同文件 6 项，2026-11-08 内部任务-356）：从一个共享的已装包出发（一次物化、`before` 建、`after` 清），
  先从**已装产物** `hooks/hooks.mcode.json` 读回合成处理器的子钩子实参（生成期没补腿或指错脚本，基线用例先炸）。
  随后分三种脚手架：**表驱动两例**（有帧时排干当前会话帧并落到 `hookSpecificOutput.additionalContext`；
  旧 `ts` 当前帧照投而他会话帧保留，无 TTL、不串话）、**独立一例**空队列（换脚手架：干净形状 seed ＋状态文件
  **字节不变**断言，零输出抓「凭空注入」、字节不变抓「无输出但脏写」）、**独立一例**载体 exit 1（需临时写失败脚本
  并连跑两次 shim：先入队具名降级帧且**不清**既有队列，下一次健康 UPS 才投递）。另有独立一组「relay-drain 载体契约」
  用例：读 stdin 至 end 才退 0、零 stdout 零 stderr（提前退会让宿主写管道 EPIPE）。
- **阻断取因判别力面**（同文件 8 项，2026-11-04 内部任务-320 内部未决-281 D1–D8）：UPS 无 reason
  仍计阻断（兜底文案构因，不降级为上下文帧/零输出）、有 reason 逐字保留、队列非空时阻断帧
  原样透传且队列不清、Stop 阻断有/无正文、lib 与 shim 判据同源、宿主白名单校验、阻断优先
  挤掉上下文位（第 50 项，与上面四个子面合计 50）。
- **生成面**（`generate.test.mjs` 49 项；2026-11-08 内部任务-356 增合成 UPS 用例，48→49；2026-11-04 内部任务-311 计数同步：内部任务-308 增 1 例如「非数组 hooks 形态诊断」，47→48）：六插件真实 `hooks.json` 的翻译结果与宿主判据复刻
  校验（字段白名单 / timeout 取值域 / matcher 原生化 / 64 处理器上限 / 未知事件计数）、
  双通道合并去重、清单必填与枚举与路径形态、白名单外键拒绝、**skill 文档面**（frontmatter
  名＝目录名、描述非空——宿主对任一不符整包拒收）、包上限（路径形态 / 文件数 / 体积 /
  **逐级前缀**大小写碰撞）、**`commandWindows` 的 cmd.exe 变量语法及其校验守卫**、
  命令面处置表与真实命令文件一一对应、薄指针不产副本、agent 工具映射、
  图标 PNG 确定性与签名、解释器三级回退、**两级探测分支的 Windows 真机验证**（`program-files`
  命中即绝对路径且与 `env.ProgramFiles` 拼出值逐字相等；`local-appdata` 有 node 则命中、无 node
  则不得误命中并如实回落 `self` 源——内部未决-65 未验证面 ① 于 2026-10-13 关闭，内部任务-55）、
  **展示元数据单源**（清单 displayName/description
  自中立清单合成，无中立源回落 slug 与生成物描述）。
- **安装面**（`install.test.mjs` 52 项）：六包成形、37 份 skill / 20 个处理器计数（16 声明去重＋4 生成期合成 UPS）、资产
  逐字节物化且 `.zcode-plugin` 不进包、**构建缓存本地产物不进包**（`__pycache__`/`.mimosa`
  段与 `*.pyc` 末段，口径同 `zcode-adapter` 的 `IGNORED`——两侧各编译一次的 `.pyc` 字节必
  然不同，装进去会让 `verify` 结构性报红；内部任务-55 热修，判别力用例在案）、六包逐个过宿主
  V1 上限、**ZCode 侧零改动不变量**（源资产 sha256 与 mtime 前后全等）、`verify` 三类漂移
  （缺失 / 多余 / 变更）逐条报出、install 幂等、agent 面默认关与显式开启、用法面退出码、
  仓内不留物化产物。
- **写后即验与回滚 / verify 零写 / agents 面**（内部决策-054 G-01/02/03，`install.test.mjs` 新增 10 项）：
  正常 install 写后即验通过且备份根清理；库级注入写后即验漂移 → 回滚到调用前文件级指纹、清理备份根、
  `phase=verify/exitCode=1`；CLI 级写失败（计划内路径预建为目录）→ 回滚退 2 且调用前指纹保持；
  升级态旧多余文件在场时默认 install 保留并退 0、`--prune` 清理；`verify --with-agents` 零写
  （agents 目录不创建、数据目录指纹不变）；已安装 agents 被篡改 → verify（不带 `--with-agents`）报出并退 1；
  `install --with-agents --prune` 清理计划外 agent `.md`。
- **文档契约**（`jsdoc-contract.test.mjs` 5 项）：每个导出带紧邻 JSDoc 且 `@param` 数量与
  形参一致、生产面文件数固定、README 测试计数与实测逐文件一致、本形态说明齐备。
- **引擎物化与装载**（`engine-materialize.test.mjs` 12 项）：物化清单＝`plugin-core` 可装载闭包
  （两 JSON + `src/*.mjs` + `strategies` 六族）、**import 图 ⊆ 清单**、**包根装载探针**（探针实参是
  包根——多一级/少一级都不可读）、「逐字节全等但不可装载」（删 `validate.mjs`）验红、副本污损验红、
  **兜底链单源**（`PENDING_LIMIT ≡` 规则 `stop-pending-relay.params.mcode.pendingLimit`）、**装载探针判别力**
  （计划与副本一致地缺 `strategies/` ⇒ sha256 面全绿、唯有探针判红；停用探针即红）、**四个消费点的接线判别力**（改包内 `accepted`／`rename`／`defaultSeconds` ⇒ 行为随动，换回内联实现即红）、**入口守卫 symlink 判别力**
  （经符号链接路径调用 CLI 仍正常执行；去掉 `realpathSync` 即红）、**mcode 列对拍**
  （`hostToolInventory.mcode ⊆ TOOL_MAP 键集`、键集 ⊇ `MATCHER_TOOL_MAP` 值集、11 个未列词原样透传）。
- **读面换源**（`source-switch.test.mjs` 5 项）：中立清单优先（分组 + 占位符翻译）、生成物仅作
  **兼容回落面**、清单在场即权威（`hooks: []` 不回落——否则撤销过的钩子会被陈旧生成物复活）、
  清单**损坏 ≠ 缺失**（记 problem，不静默回落）。
- **失败可见面**（`engine-failure.test.mjs` 11 项）：引擎不可得时按事件给面——`PreToolUse` 升格
  `ask` + 恢复指引，其余事件诊断帧（含副本实际路径 / `node mcode-adapter/cli.mjs verify`
  （`--data-dir` 只在安装时用过才需补同一路径）/ 重跑 `install` /
  「请转述给用户」），`Stop` 走待投递中继且**下一次 `UserPromptSubmit` 真的送达**；诊断落
  `PLUGIN_DATA/hook-diagnostics.log`（**不写 stderr**；目录事前不存在也先建后写——去 `mkdirSync` 即红）、
  **规则库字段漂移**：PreToolUse/非 Stop 事件生成帧；Stop 落 `hook-diagnostics.log`（兜底刻意零状态 I/O；退回静默即红）。
- **状态面常态与损坏的可见性分界**（同文件 3 项，内部任务-295 复审）：`relay-state.json` **不存在**
  （首次运行/从未降级过的常态）不报诊断；**解析失败或形状非法**（顶层非对象）经 `onError` 可见
  ——把常态报成故障会让每次钩子调用都写一行「读取失败」，噪音淹没真实故障。`exit 2 且无信封`
  属跨宿主能力差（本宿主无该阻断位），诊断指引标为「无需修复插件」，不与真故障共用文案。
- **relay 迁移与路径分支**（`relay-migration.test.mjs` 6 项）：旧盘态（`pending` + `streakKey:''`）
  → 新版本**两跳真实送达**且帧键合成**非空哨兵**（空键会被引擎判 malformed 丢弃）；合并投递路径
  （队列 + 子钩子自身上下文并存且队列清空）；**投递腿不得吞掉子钩子的阻断帧**——双空场景与
  **队列非空场景各一条**（后者是真机复现过的 deny→放行回归：阻断优先、队列原样留待下一轮，
  去掉阻断优先分支即红）；Stop 阻断 E2E（未超上限直译
  `decision:block`，第 4 次按 `burstCap` 降级为零帧 + 规则 `capNote` 入队）；`burstCap` **注入变形**
  （改 1 即第 2 次降级，证明数据驱动而非当前值巧合）。
- **驱动方式**：一律用 `spawnSync` 的 `input` 喂负载，**不用 shell 管道**——PowerShell 管道按
  控制台代码页编码（本机 zh-CN 为 GBK），会把 JSON 负载打坏并制造"负载不可读"的假红
  （`check-freeze` 的 fail-closed 极性会把这种假红变成看起来很像真拦截的 deny）。

## 新宿主接入模板指针

第三宿主 MCode 适配层：新宿主接入模板走 内部模块-22 `R-ha-6` **三阶段**（设计取证→规格批→实施批），接入前必做**先例对照**（过既有宿主已修缺陷与未决项清单）；本宿主的分册/矩阵行/缺口台账见 `内部规格 内部模块-22` 对应节。
