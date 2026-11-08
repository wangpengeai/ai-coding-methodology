# kimi-code-adapter —— Kimi Code 宿主适配层

> 把本仓六个 ZCode 插件（workflow / spec-gate / scout / team-governance / algo-loop / research-loop）适配到
> **Kimi Code**（TUI + CLI，v2 引擎；曾为本仓运行宿主 2026-10-05..10-13，本仓不绑定单一运行宿主，见仓库内部维护说明）。**ZCode 侧资产零改动**：本目录
> 只读六插件的中立清单 `plugin.manifest.json`、钩子脚本与 skills/命令/agent 正文，不写其中
> 任何一个字节（`hooks/hooks.json` 生成物同样零触碰——声明面只留 `kimi.plugin.json`
> 一份事实源）；ZCode 上的可用性因此不受影响。

决策记录见 `内部规格 内部决策-038`；契约实例化登记见 `内部规格 内部接口-1`
「第四宿主实例化登记」节；取证与逐字摘录见 `内部设计记录`。

## 为什么不是"再写一份声明"

Kimi Code 与 MCode 同为**静态声明式宿主**（无运行时注册面），但能力面更全（逐条依据见
设计文档 §2）：

1. **命令面原生**：`commands` 目录递归收 `.md`，命名空间 `<plugin>:<command>` 逐字复现
   ZCode 斜杠名——没有 MCode"转 skill"的处置，4 条薄指针也不产第二副本。
2. **钩子信封同族**：`hookSpecificOutput` 内联数组 + exit 2 阻断 + stderr 原因位——
   spec-gate 硬阻断档（stderr + exit 2 无信封）**原生直通**。
3. **agents 面可选**：包内 `agents/` 自动发现，但 plugin agent 在优先级塔只赢内置。

所以接入形态仍是**物化**：安装器把每个插件的资产 + shim + 引擎闭包 + 生成的
`kimi.plugin.json` 落成宿主可扫的包，直写 `plugins/managed/<id>/` + `installed.json`。
仓内**不留镜像**（32 份 `SKILL.md` 副本即纪律漂移面，mcode 家法同款），仓内只有生成器 +
shim 模板 + 自含测试；物化目标在宿主托管面。

## 四个面

| 面 | ZCode 资产 | Kimi 落点 | 状态 |
|---|---|---|---|
| 钩子面 | 中立清单 hooks 节（17 中立处理器 + 1 条 workflow PostCompact + 4 条四包投递腿＝22） | `kimi.plugin.json` 的 hooks[] 近恒等直译 + 包内 `kimi/hook-shim.mjs` 转发；workflow 另有 `kimi/compact-workflow.mjs` 压缩轻量回放；四包另有 `kimi/relay-drain.mjs` 投递腿 | ✅ 默认开启，22 个处理器 |
| skill 面 | `skills/<名>/SKILL.md`（32 份） | 逐字物化 + 清单 `skills:["./skills/"]` 目录形声明 | ✅ 默认开启 |
| 命令面 | `commands/*.md`（9 条） | **原生直落** `commands/` 目录，`<plugin>:<command>` 逐字复现 | ✅ 默认开启 |
| agent 面 | `agents/*.md`（3 份） | 包内 `agents/`（自动发现；词表映射后物化） | ⚠️ 默认关闭，`--with-agents` 开启 |

## 能力摘要（可用 / 降级 / 未验证）

一面一句、三态如实的当前能力盘面（2026-10-06 盘点）。注意：**机械包映射测试 ≠ 宿主 UI/真机会话验证**——下表「可用/降级」以机器证据（包映射、真实钩子经 shim 往返）为准，「未验证」诚实保留待真机探针，不以文案假关闭。

| 面 | 状态 | 说明与建议动作 |
|---|---|---|
| 命令面 | ✅ 原生可用 | `commands/` 目录原生直落，`/<插件>:<命令>` 逐字复现 ZCode 斜杠名 |
| skill 面 | ✅ 可用 | 逐份逐字物化，「设置→插件」面板识别已实证；新会话内实际调用/优先级落位已真机复证（**内部未决-70 关闭 2026-10-13**，四插件 27 份 skill 全注册 Extra 层、Skill 实调 4 枚成功） |
| 钩子·阻断位 | ✅ 可用 | deny 双通道（stdout 信封 + exit 2 + stderr）；spec-gate 硬阻断档原生直通；完成闸阻断按会话计连击（**仅阻断调用推进**），3 连击后按上限降级为零帧+提醒；宿主原生 `stop_hook_active` 本批未消费（内部未决-114 保持未决） |
| 钩子·观察面 | ⚠️ 中继可用（延迟一轮；workflow shim + 四包 relay-drain） | 观察面事件无注入位，帧落待投递队列、下一次 UserPromptSubmit 才送达——提醒晚一轮到，不是丢失；**投递腿＝本包声明 UserPromptSubmit**：workflow 由 shim 承接，spec-gate/scout/team-governance/algo-loop 由生成期 `kimi/relay-drain.mjs` 承接（内部任务-302）。**内部未决-71/内部未决-73 已关闭**（Stop exit 0 stdout 不进上下文、relay-state 真身帧取证） |
| 钩子·项目根 | ⚠️ 已收口但有盲区（内部未决-75 关闭） | 桌面端 `cwd`＝宿主应用目录的截拦恢复（lease-deny 落库实证）与事件落账恢复（tf-`<tool_call_id>` 实记）均已实测，差异面 #13 注记同步；**已知盲区**：桌面端纯 Bash 会话（全程无带 path 的工具调用）下会话缓存永不暖化、租约闸结构性不激活——操作红线：先执行一次带路径的 Read/Edit/Write，或从项目目录重启会话 |
| agent 面 | ⚠️ 默认关（具备翻默认评审条件） | `--with-agents` 显式开启；委派全过程已探装实测（**内部未决-74 关闭 2026-10-13**，code-explorer 1/3 机制级结论成立），翻默认仍待专门评审（内部未决-153） |
| 真机取证 | ✅ 已收口（余项 OPEN） | UserPromptSubmit/PreToolUse/PostToolUse 已实测；Stop/SessionStart 与完成闸阻断已结构性收口（内部未决-73）；负载键名（内部未决-67）、Windows shell（内部未决-68）、ask 支持度（内部未决-72）均真机实测关闭 |

## 钩子面：为什么是 shim 而不是改脚本

除 workflow 的 `PostCompact → kimi/compact-workflow.mjs` 与四包投递腿 `UserPromptSubmit → kimi/relay-drain.mjs` 两类静态脚本外，其余处理器都指向包内的 `kimi/hook-shim.mjs`，它做五件事：读宿主负载 → 归一成 ZCode 形态
（多键兼容读取 `tool_name|name`、`prompt|text`、`tool_result|tool_response`，写类入参
`path→file_path` 补写保留原键，来源词表交引擎 `source-widen-normalize` 归一）→ spawn
**被物化的 ZCode 原钩子** → 把 ZCode 信封译成宿主母语位 → 引擎装载与失败可见面。判据、
护栏、租约闸、完成闸仍是同一份代码在跑（钩子脚本是冻结资产）。

差异处置表（逐条依据见 内部接口-1 第四宿主登记的 13 行差异面；设计文档 §4 收录其中 12 行）：

| # | 差异 | 处置 |
|---|---|---|
| 1 | 观察面事件（SessionStart/PostToolUse/PostToolUseFailure）无注入位（fire-and-forget） | 帧落待投递队列（`$KIMI_CODE_HOME/plugin-data/<id>`），下一次 UserPromptSubmit 以纯文本投递（relayEvents 四事件同队列）。**投递腿＝本包声明 UserPromptSubmit**：workflow 由 shim、四包由生成期 `kimi/relay-drain.mjs` 承接（内部任务-302；四包压缩回放不做——内部未决-269 已关闭 2026-11-03：技术可行但价值有限，接受缺口）。workflow 另有 `PostCompact → kimi/compact-workflow.mjs` 压缩轻量回放（只重投 `SKILL.md`，不跑原 SessionStart 副作用） |
| 2 | Stop 阻断位原生（阻断消息喂回模型继续） | verify-gate 阻断帧 → exit 2 + stderr=reason 直译；连击上限 3 次后降级零帧 + 提醒入队（连击仅由阻断调用推进；`deliverOn` 按会话归零预算） |
| 3 | ask 决策无文档位 | 保守翻 deny（reason 前缀「需用户确认：」）；**内部未决-72 已关闭**——宿主不消费 exit 0 stdout 信封的 ask 决策，保守翻 deny 维持并如实标注语义收窄 |
| 4 | 负载字段名 `tool_name`/`prompt`/`tool_result` 为推断 | shim 多键兼容读取；**内部未决-67 已关闭**——真机全链实证钉死全部键名（tool_name/tool_input/tool_output/error/prompt 块数组/stop_hook_active），多键兼容保留作形态漂移防御 |
| 5 | Windows 钩子 shell 未文档 | 安装期解释器绝对路径三级解析，单态跨平台命令（不搬 mcode 双形态）；**内部未决-68 已关闭**（进程树探针确证父进程全为 cmd.exe） |
| 6 | installed.json schema 无文档 | 本机实样七字段为写入契约，不符拒写 fail-loud；source 常量 `'local-dir'` 已实测受理（探针 P3，**内部未决-69 关闭 2026-10-05**——枚举收窄随宿主形态变化再评） |
| 7 | PostToolUse 结果字段名未文档 | `deriveToolResult` 判序复用（结构化字段 → 末行退出标记 → 不可知宁漏不误报）；探针 P1 |
| 8 | 时限上限 600s ≫ 声明时限（2..60s） | 子进程预算＝声明时限减 800ms 直通；MCode 的 fail-open+提醒分支不成立；**超时/崩溃分层可见化**：观察面与 Stop 入队降级提醒、UserPromptSubmit 以 stdout 纯文本直追、PreToolUse 仅写诊断日志（无注入位，deny 会误伤正常慢命令——接受注记） |
| 9 | 事件名/matcher 同型（PascalCase） | hooks[] 近恒等直译（`Bash`/`Edit|Write` 原样） |
| 10 | SessionStart 来源词表仅 `startup`/`resume` | matcher 收窄 + 引擎 `source-widen-normalize` 域外兜底归一 |
| 11 | spec-gate 硬阻断档（stderr + exit 2 无信封） | **原生直通**：exit 2 + stderr=子进程 stderr，无需 MCode 的降级提醒分支 |
| 12 | systemPrompt/systemPromptPath/sessionStart.skill/skillInstructions 静态注入面 | 本批不启用（路由纪律由 user-prompt 中继 + skill 面承担；压缩场景由 workflow 静态 PostCompact 回放补主链路），登记 内部未决-265 为未来增强面（四面齐备） |
| 13 | 桌面端 `payload.cwd`＝宿主应用目录而非项目目录 | shim 侧项目根解析链承接（cwd 带标记直用 → 写类 path 上溯 → 会话缓存复用 → 忠于宿主兜底 + 诊断提醒）；**已知盲区**：纯 Bash 冷会话下租约闸结构性不激活（可见化仅提示不阻断）——操作红线：先执行一次带路径的 Read/Edit/Write，或从项目目录重启会话 |

### deny 双通道与 ask 保守翻译

PreToolUse 的 deny 走**双通道**：stdout JSON 信封（宿主文档两键白名单
`permissionDecision`/`permissionDecisionReason`，ZCode 的 `systemMessage` 经引擎
`message-slot-migration` 改名）+ **exit 2** + stderr=同文案——即使宿主忽略信封，阻断语义
与原因仍经原生退出码位成立。子钩子的 `ask` 帧（check-careful）保守翻 deny（本宿主无 ask
文档位，差异面 row 3）。

### 待投递中继与连击上限

`task-recap`/`learnings-recap` 依赖 Stop 期的非阻断注入，而宿主观察面与 Stop 非阻断面都
没有注入位。shim 把这类帧落进 `$KIMI_CODE_HOME/plugin-data/<id>` 的队列（按文本摘要去重、
上限 20 条），由**下一次 UserPromptSubmit** 以纯文本投递。**投递腿＝本包声明
UserPromptSubmit**：workflow 由 shim、四包由生成期 `kimi/relay-drain.mjs` 承接（内部任务-302）；四包压缩回放不做（内部未决-269 已关闭 2026-11-03：接受缺口）。完成闸（verify-gate）的阻断按
会话键计连击，**连击上限 3 次**（引擎 `stop-pending-relay.params.kimi.burstCap`）后降级为
零帧放行 + capNote 入队（降级事实不隐藏）。UserPromptSubmit 的阻断帧优先于投递：阻断时
队列原样不清，留待下一次提示再投。

### 负载不可读时：垃圾字节原样透传

负载 JSON 解析失败时，shim **原样透传垃圾字节**给子钩子，不做"修复"——check-freeze 的
「负载不可读 → deny」是 ZCode 侧唯一的 fail-closed 极性（硬规则 4 的唯一例外），若本层先
替它把负载修好再送，那条极性在本宿主就结构性不可达。

## 失败事件面：结构化事实的边界

`post-tool.mjs`（运行自察）按**结构化事实唯一判据**消费 `tool_result`（内部未决-46 纪律：文本
不单独构成失败判据）。Kimi 的 wire 负载结果字段名未文档（探针 P1 收口），shim 的判序复用
mcode 中立件：结构化字段（`is_error`/`isError`/`exit_code`/`exitCode`/`code`）→ 渲染文本
末行 `[exit code: N]` 标记 → 皆无即「不可知」（宁漏不误报；**刻意不读 `status`**——MCP/HTTP
形态的 status 会被误当退出码）。

## 安装

```sh
# 计划（不落盘）：先看将要写什么
node kimi-code-adapter/cli.mjs install --dry-run

# 直写宿主数据目录（宿主根探测：--data-dir > KIMI_CODE_HOME > 平台标准位 ~/.kimi-code）
node kimi-code-adapter/cli.mjs install

# 六包 + marketplace.json 落暂存目录（宿主官方通道兜底；写面只有目标目录）
node kimi-code-adapter/cli.mjs install --staging <目录>

# 连三份只读定位 agent 一起装（默认不装；code-reviewer 工具面含 Bash，非纯只读）
node kimi-code-adapter/cli.mjs install --with-agents

# 升级到删除面变化的新版本时，显式清理计划外旧文件（如 Python core；默认 install 会因
# 写后即验发现多余文件而回滚，--prune 是升级收口路径）
node kimi-code-adapter/cli.mjs install --prune

# 核对已装包与源仓漂移（缺失/多余/变更逐条列出 + 装载探针 + 登记双读；非零退出即红）
node kimi-code-adapter/cli.mjs verify
```

### CLI 契约（子命令 × 旗标 × 退出码）

| 子命令 | 允许旗标 |
|---|---|
| `install` | `--dry-run` `--staging <目录>` `--with-agents` `--prune` `--data-dir <路径>` `--repo-root <路径>` `--json` |
| `verify` | `--staging <目录>` `--with-agents` `--data-dir <路径>` `--repo-root <路径>` `--json` |

- 退出码：`0` 绿 / `1` 漂移·失败 / `2` 用法错·环境缺失·**写面拒装**（符号链接）·备份阶段失败·顶层异常；无参退 2；旗标缺值或值形如旗标退 2；`verify` 不接受 `--prune/--dry-run`（旗标矩阵，不静默忽略）。
- `--json`：stdout 输出机器可读报告（`ok`/`exitCode`/`command`/`mode`/`hostRoot`/`targetRoot`/`repoRoot`/`plugins[]`/`problems[]`/`warnings[]`/`pruned[]`；`--dry-run` 另带 `plan[]`）；失败路径同样输出 JSON（顶层异常亦然）。
- `--staging` 与 `--data-dir` 同时给出时：staging 模式忽略 `--data-dir` 并在输出与报告中告警。
- `--with-agents` 安装面：`verify`/`install` 需带同旗标复核，否则 `agents/` 记为多余漂移（输出给三条出路：带旗标 / `--prune` 移除 / 手工删除）；`--prune` 不带该旗标会移除 agents 面。
- `--repo-root`：须指向含六个插件目录与 `plugin-core/` 的仓库根；缺失即报「插件源缺失」并退 1（不撞顶层异常）；带 `--with-agents` 时引擎装载先于源预检，缺失仓库退 2 并报「规则引擎装载失败」——两者文案与退出码不同，勿混判。
- 子命令必填：`install` / `verify` 缺任一即退 2（只带旗标同样退 2——缺省 install 会向真机宿主根完整落盘，含 `--prune` 删计划外文件）。

直写模式的家法（zcode/mcode 一写面同款）：备份（managed 既有副本 **copy 式**副本 `.bak-<ts>`（原目录留位，兑现「不删目录」语义）、登记
复制 `.bak`）→ 逐文件原子落盘（临时名 + rename，**不删目录**——运行中会话正持有的钩子路径
保护）→ 登记实样结构校验（不符即拒写 fail-loud 退 1 并还原备份）→ upsert 六条目（只增改
六插件 id，他条目不碰；`source` 常量 `'local-dir'` 已实测受理——**内部未决-69 关闭 2026-10-05**）→ 原子写 →
**写后即验**（完整 verify 面：sha256 对拍 + 引擎装载探针 + installed.json 双读），漂移即
回滚本次写入并退 1。幂等：重复 install 结果不变。

解释器在**安装期解析**（PATH → 常见绝对位置 → 进程自身），解析不到即**拒绝安装并报缺依赖**
（不静默降级、不写坏包）。解析结果以绝对路径写进生成的 hooks[].command（双引号包裹，路径
含空格安全）——宿主不为钩子注入独立 Node，故此处不能用裸 `node`；代价是**换机后需重跑
`install`** 重新解析。

引擎随包物化：`plugin-core/` 闭包（两数据 JSON + `src/*.mjs` + `src/strategies` 六族）落为
包内副本，运行期 shim 以 `await import()` 从包内装载（不受 `require(esm)` 版本门槛约束）。
副本是**生成物**——改引擎请改仓库源并重跑 `install`，手改副本会被 `verify` 判红；副本缺失/
被改坏/规则库字段漂移时，shim 按事件给**可见面**（PreToolUse→deny+exit 2；UserPromptSubmit→
stdout 诊断直给；Stop 与观察面→待投递中继 + `hook-diagnostics.log`——宿主 stderr 非用户可见
面，故必须自己送面）。

## agent 面为什么默认关闭

三份 agent 的 `tools:` 是 ZCode 词表，本宿主工具名词表有四处空缺：无 LS（走 Glob）、无
TodoWrite（是 TodoList）、无 WebFetch（是 FetchURL）、无 BashOutput（对位物 TaskOutput 语义
不同，按**拒绝**丢弃——只读输出，丢弃不放宽权限）。映射规则：`LS→Glob`、`TodoWrite→TodoList`、
`WebFetch→FetchURL`、其余同名直映；**映射后为空则不装**。挂装门控再交引擎规则
`agent-default-off-fail-closed`（defaultMount:false + unknownTool:reject）与宿主 24 词词表
求交集（目录不可得/交集为空 → 拒挂）。

默认关闭的理由与 DSH/MCode 侧同源：委派全过程**已探装实测**（内部未决-74 关闭 2026-10-13，
code-explorer 1/3 机制级结论成立）；词表映射/优先级塔/跨宿主差异仍无全量实证，故翻默认
仍待专门评审（内部未决-153）。

## 已知限制（如实登记，不美化）

1. **installed.json 的 `source` 枚举值未文档**：**P3 已实测收口（2026-10-05 真机）**——宿主重读
   后完整保留本层写入的 `'local-dir'` 四条目（登记回读逐字段核读，enabled/root/时间戳未动），
   **内部未决-69 已关闭（2026-10-05）**；2026-10-17 darwin 真机复证：Kimi Code（macOS 版）首个
   coding workspace 会话完整装载六包（钩子真机触发留痕见 `plugin-data/` 中继，证据
   `内部真机证据`）。
2. **观察面注入位缺口**是结构性处置（中继而非临时绕法）：SessionStart/PostToolUse/
   PostToolUseFailure 的帧延迟到下一次 UserPromptSubmit 才送达；Stop exit 0 的 stdout 不进入
   上下文（**内部未决-71 关闭 2026-10-13**，维持中继处置确认）。
3. **ask 保守翻 deny** 收窄了 ask 语义（本意为"询问用户"），已实测宿主不消费 exit 0 stdout
   信封的 ask 决策（**内部未决-72 关闭 2026-10-13**），维持并如实标注语义收窄。
4. **负载字段名多键兼容读取——P1 已实测钉死（2026-10-05 真机探针）**：`tool_name` /
   `tool_input`（Bash→command；Edit/Write→path+content/old_string）/ `session_id` 与文档
   推断**一致**；结果面宿主原生键＝`tool_output`（成功渲染文本）与 `error`（失败结构化对象，
   退出码在 `error.message` 文本里）——判序已接线（error.message 提取、`code` 类别串不冒认）。
   多键兼容读取保留作形态漂移防御，不再以「纯推断」口径登记。**UPS 用户文本补充实测（同日
   三层探针钉死）**：桌面端 `prompt` 为**消息块数组**（`[{"type":"text","text":"继续"}]`，
   OpenAI 风格，附 `is_steer` 字段），非裸字符串——旧读法恒空串致 user-prompt 静默退出
   （租约签发/提醒全丢，本日最大缺口根因）；shim 已接块拼接（非 text 块跳过、空数组覆写
   空串），随真机修正批 v3 上线。
5. **Windows 钩子 command 的实际执行 shell 未文档**（非 Windows 才有独立进程组待遇）：
   安装期绝对解释器路径已把 shell 不确定性从调用面剔除；单态 command 实机运行正常
   （探针日志佐证）；**内部未决-68 已关闭**（进程树探针确证父进程全为 cmd.exe）。
6. **失败分类——已实测（2026-10-05 真机）**：成功面 `tool_output` 渲染文本**无**退出标记；
   失败面 `error.message` 含 "Process exited with code 3" 但**不是**末行 `[exit code: N]`
   标记格式——按 `error` 对象判序提取后 内部模块-15 自察恢复可达（MCode 的「标记分支不可观测」
   结论在本宿主以 error 结构化面绕开）。
7. **包内命令含绝对解释器路径**：换机需重跑 `install`。
8. **`hooks/hooks.json` 不进包**（声明面只留 `kimi.plugin.json` 一份事实源）：包内钩子脚本
   以中立清单为准；`workflow/hooks/session-start.mjs` 仅在**清单缺失/损坏**时回落读取
   `hooks/hooks.json`（正常路径不触发），其钩子接线自检（`checkHookWiring`）在包内因无该
   文件而跳过——属已登记的包内降级面；安装器在清单缺失时回落读源树声明。
9. **状态面无跨进程互斥**（mcode 同款登记）：relay 状态文件是 read→modify→write 原子替换，
   同事件多处理器并发时连击计数可能互相覆盖，失效方向为**计数偏低 ⇒ 降级被推迟**（更久阻断
   而非更早放行）；连击预算按用户轮次由 `deliverOn` 归零。
10. **真机触发——P7 部分关闭（2026-10-05 真机）**：UserPromptSubmit 注入（元技能全文直达
    上下文）、PreToolUse 三处理器（子钩主动放行，探针二层记录 childStatus=0；内部任务-261 后增 write-guard 为四处理器）、PostToolUse/
    PostToolUseFailure（含 error 结构化负载）全部实测触发；Stop/SessionStart 原始负载与
    完成闸阻断表现已结构性收口（**内部未决-73 关闭 2026-10-14**，relay-state 真身帧取证＋
    内部接口-1 真机触发注记在位）。机械证据 ≠ 包识别 ≠ 真机触发口径不变。
11. **Kimi 无文档化包体积/文件数上限**：本层不设限（MCode 的 1024 文件/64MiB 上限校验是
    宿主 V1 特有件，不搬）；若宿主后续出限，安装器判据面须同步扩列。
12. **桌面端 `payload.cwd`＝宿主应用安装目录而非项目目录**（2026-10-05 实机发现，**内部未决-75 已关闭 2026-10-05**：截拦恢复＋事件落账恢复＋差异面 #13 注记同步）：
    宿主未注入项目目录等价变量；处置＝`resolveSessionProjectRoot` 会话面解析链（cwd 带
    `.git`/`.sdd` 标记直用 → 写类 `tool_input.path` 上溯推断 → **Bash 类负载同会话键复用
    写类事件暖的 cache** → 忠于宿主兜底；缓存带会话键与标记失效守卫）。实测进化三层：
    ①解析链先修——写类事件项目根恢复；②**Bash 类负载无 path 提示**，仍退应用目录，且
    实测 post-tool 以应用目录为根落账**静默失败**（错误陷阱吞写错、exit 0 零帧）→ 会话
    缓存层补；③同帧实测 Kimi 键 `tool_call_id`≠ZCode 键 `tool_use_id`（post-tool 幂等/
    重试环调用键）→ normalizePayload 映射补。附注（先前置判读已推翻）：routing-gate 在错置
    根下的放行**不是**设计行为——项目根修正后闸即恢复截拦（lease-deny 账落库实证）；本仓
    无 `.workflow` 路由状态时的放行语义仅适用于「从未接入 workflow 的项目」，本项目接入过
    （状态在 `~/.zcode/cli/routing-state`），故闸执法是常态。
13. **skill 面注册缺口——已销号（2026-10-05 面板实证）**：曾登记「26 份 skill 未进会话清单」；宿主「设置→插件」面板实证四插件全部正确识别——workflow 17 技能/10 钩子/1 命令、spec-gate 4/2/5、scout 3/1/0、team-governance 2/2/3，**26 技能与清单逐计数吻合**（含 license 字段随行——frontmatter 逐字含 license 且全部被计入，license 容忍实证）。此前「不进清单」的真相＝**本会话为安装前启动的旧会话**，skill 列表是会话起始快照；新会话（`/new`）即见（宿主插件变更本会话不重载，需 `/new` 或 `/reload`）。诊断入口澄清：`I` 键属于聊天输入框 `/plugins` 的交互面板，「设置→插件」面板无此键。残余＝新会话内 skill 实际调用/优先级落位实测（内部未决-70 收口面）。**计数同步注记（2026-10-05 内部任务-HANDOFF-1）**：本条 26/17 是当日实测原值，保留不改写；内部决策-039 批新增 `doc-discipline` 后当前实收为 27 份 / workflow 18 技能（计数断言在 `tests/install.test.mjs` 与 `tests/generate.test.mjs`，随 skill 增删同批更新）；2026-10-15 内部任务-90 algo-loop 入套后为 28 份；2026-10-16 内部任务-109 research-loop 入套后为 30 份；2026-10-20 内部决策-052 architecture-evolve 入套后现行实收 31 份 / workflow 19 技能；2026-10-20 内部任务-185 external-radar 入套后现行实收 32 份 / workflow 20 技能（本条历史值按原日实测保留，不回写）。

## 测试

```sh
node --test "kimi-code-adapter/tests/*.test.mjs"
```

测试项共 199 项（`tests/hook-shim.test.mjs` × 50 + `tests/generate.test.mjs` × 33 +
`tests/install.test.mjs` × 38 + `tests/engine-materialize.test.mjs` × 13 +
`tests/engine-failure.test.mjs` × 8 + `tests/relay-behavior.test.mjs` × 8 +
`tests/install-rollback.test.mjs` × 7 + `tests/hook-lib.test.mjs` × 13 +
`tests/source-switch.test.mjs` × 8 + `tests/jsdoc-contract.test.mjs` × 6 +
`tests/relay-drain.test.mjs` × 10 + `tests/host-presence.test.mjs` × 1 +
`tests/host-root.test.mjs` × 4），**十三类**覆盖面
（2026-11-03 内部任务-305：Stop 连击 R2 语义＋真实三处理器 E2E、跨会话去重、hooks 形态判据、
agent 门控交集、阻断兜底与输出冲刷、路径/符号链接硬化、CLI 契约与 JSON 报告、宿主根与 staging 失败面用例 → 161→194；
2026-11-07 内部任务-347 批 C：install 互斥锁（内部未决-273——新鲜锁拒绝退 2/stale 强占/完成即释放）＋多会话连击与淘汰分账的读侧字段面用例 → 194→195；
2026-11-07 内部任务-347 批 C 续：诊断面加固与 sweep（内部未决-280 符号链接拒写/坏文件隔离零重复告警＋内部未决-286 sweepStaleTmp 死 pid 超龄清扫/EPERM 保守跳过）→ 195→199）：

- **宿主在位平台注入面**（`host-presence.test.mjs` 1 项）：`detectHostApp` 以 platform
  注入缝在任意平台断言 darwin/win32 深路径行为（候选展开 ≡ 签名库 ~/→homedir 规则、
  present ≡ 首个存在候选）——函数覆盖不随执行机平台漂移（内部任务-233）；真机在位语义仍由
  install/verify 与 内部决策-048 链承载，本面不宣称在位性。

- **shim 纯函数面**（`hook-shim.test.mjs`）：负载多键兼容归一（tool_name|name、
  prompt|text、path→file_path 保留原键、hook_event_name argv 权威、来源域外归一引擎单源）、
  结果面判序（含「不读 status」与「自带 tool_result 直用」）、**Kimi 实测形态**（失败面
  `error.message` 提取退出码且 `code` 类别串不冒认、成功面 `tool_output`、normalizePayload
  顶层键识别、`tool_call_id→tool_use_id` 调用键映射、**UPS `prompt` 消息块数组拼接**
  （`[{type:"text",text:…}]` 块形态为桌面端真机实测值，非 text 块跳过）——2026-10-05 真机
  探针钉死）、**项目根解析链与会话缓存**（cwd 带标记直用／应用目录形态按 tool_input.path
  上溯／Bash 类负载同会话键复用写类事件暖 cache／缓存标记失效守卫——内部未决-75 已关闭），deny 双通道两键白名单、ask 保守翻
  deny、allow/defer/空信封零输出、三条注入面共用 32k 截断闸（PreToolUse 经译出；
  UPS/Stop 由 shim 分支经同一 `clampContext`）、队列去重上限、状态损坏 fail-open（写诊断日志）、旧形状 `pending` 不迁移（无迁移哨兵）、会话键兜底。
- **真实 ZCode 钩子经 shim**（同文件，余项）：真实 check-freeze deny（exit 2 + 双通道 + 文案
  不丢）、界外静默、**垃圾字节透传保 fail-closed 极性**、check-careful ask 翻 deny、真实
  SessionStart 帧入队、真实 post-tool 合成 tool_result 落账（脱敏）、**spec-gate 硬阻断档
  原生直通**（真实钩子 + SDD 夹具）、spec-gate 提醒档两跳投递、task-recap 两跳中继、真实
  verify-gate 放行、子进程超时零帧、包根推导不依赖 env、信封键 ⊆ 宿主白名单。
- **生成面**（`generate.test.mjs` 33 项）：脚本路径解析、时限直传/封顶/抬底、matcher 收窄与
  直传、单态 command 形态、六插件真实清单翻译（22 计数＋research-loop 零钩子 + 事件面 + 合规）、unresolved 统计、
  hooks 校验器拒坏形态、清单构造与 interface/keywords 搬运、校验器拒坏 name/SemVer/逃逸路径/
  白名单外键、包根路径判据、32 份真实 skill 文档面、命令面 .md 判据（9 条）、agent 词表映射
  （含真实三份转换）、引擎闭包清单与 import 图、解释器三级回退、marketplace JSON、
  **展示单源**（中立清单顶层 displayName → 包 interface.displayName，包/市场同源、缺省回落
  slug、仓内无第二份名称表）。
- **安装面**（`install.test.mjs` 37 项）：六包成形与计数（32 skill/9 命令/22 处理器＋research-loop 零钩子/引擎闭包/compact-workflow 物化）、
  资产逐字节与排除面（`.zcode-plugin`/`hooks.json`/`agents` 源形态不进包，**构建缓存本地产物
  也不进包**——`__pycache__`/`.mimosa` 段与 `*.pyc` 末段，口径同 `zcode-adapter` 的 `IGNORED`；
  两侧各编译一次的 `.pyc` 字节必然不同，装进去会让 `verify` 结构性报红，内部任务-55 与 mcode 侧
  同因同修）、登记六条目与
  实样结构、upsert 语义（他条目不碰 + installedAt 保留）、**坏登记拒写回滚**、verify 三类
  漂移、幂等、--with-agents、usage 退出码、宿主根探测 fail-loud、缺解释器拒装、
  **源资产 sha256/mtime 前后全等**、写面白名单、包内路径合规、--staging 产物与
  staged verify、--dry-run 零写。
- **引擎物化与接线判别力**（`engine-materialize.test.mjs` 13 项）：闭包清单、import 图 ⊆ 清单、
  包根探针正/负、删 validate.mjs 探针红、副本污损 verify 红、探针判别力（sha256 面全绿唯探针
  红）、兜底链单源（PENDING_LIMIT ≡ 规则 pendingLimit）、kimi 规则数据断言（relayEvents 四事件/
  burstCap/capNote/accepted/rename/defaultMount + 引擎分派形态）、三个消费点接线判别力
  （来源归一/槽位迁移/agent 门控——改包内规则数据行为随动，停用内联即红）、矩阵 kimi 列对拍、
  入口守卫 symlink 判别力。
- **失败可见面**（`engine-failure.test.mjs` 8 项）：引擎污损 → PreToolUse deny+exit 2+恢复指引、
  UserPromptSubmit stdout 诊断直给、SessionStart/PostToolUse 诊断入队 + hook-diagnostics.log
  （目录先建后写、**不写 stderr**）、Stop 入队→恢复后下一轮真送达、规则库字段漂移兜底
  catch 可见面、正例无降级帧。
- **relay 行为回归**（`relay-behavior.test.mjs` 8 项，内部任务-2 批自迁移用例恢复并扩面）：合并
  投递两段并存、Stop 连击 E2E（3 内直译/第 4 次降级 + capNote 入队送达）、投递腿不吞阻断帧
  （空队列/队列非空双场景）、burstCap 注入变形、relayEvents 观察面帧同队列一并投递、
  **跨会话过滤 e2e**（他会话帧不投给当前会话也不丢——A1/A3）。
- **回滚链与值旗标**（`install-rollback.test.mjs` 7 项，内部任务-2 批）：copy 式备份原位留档、
  回滚失败保留 .bak + 人工恢复指引、回滚成功统一清备份、值旗标吞值/缺值退 2（不落真机根）、
  登记损坏 e2e 回滚。
- **hook-lib 状态面**（`hook-lib.test.mjs` 9 项，内部任务-2 批）：enqueue 显式会话键忠实、旧形状
  pending 不迁移（kimi 无升级史）、droppedByLimit 读写往返、tmp 唯一后缀（静态断言 + 双进程
  并发冒烟）。
- **读面换源**（`source-switch.test.mjs` 8 项）：中立清单权威、生成物兼容回落、两者冲突清单
  胜、显式空声明不回落、清单损坏记 problem 不静默回落。
- **文档契约**（`jsdoc-contract.test.mjs` 6 项）：每个导出紧邻 JSDoc 且 @param 数一致、生产面
  文件数固定、README 测试计数与实测逐文件一致、README 形态说明齐备。
- **测试缝集中登记**（`src/test-seams.mjs`）：生产代码唯一 `KIMI_TEST_*` 读取面（私有登记表＋单一
  `testSeam(name)` getter：`rollbackFail` → `KIMI_TEST_ROLLBACK_FAIL`、`pruneLock` → `KIMI_TEST_PRUNE_LOCK`）；
  仅测试态生效（值须为 `'1'`），未登记名字具名抛错；`jsdoc-contract.test.mjs` 静态断言生产面除本文件外零
  `KIMI_TEST_*` 字面量。`KIMI_TEST_PROBE_HANG` 仍未实现、不登记。
- **驱动方式**：一律用 `spawnSync` 的 `input` 喂负载，**不用 shell 管道**——PowerShell 管道按
  控制台代码页编码（本机 zh-CN 为 GBK），会把 JSON 负载打坏并制造"负载不可读"的假红
  （mcode 批实测教训）。

## 新宿主接入模板指针

第四宿主 Kimi 适配层：新宿主接入模板走 内部模块-22 `R-ha-6` **三阶段**（设计取证→规格批→实施批），接入前必做**先例对照**（过既有宿主已修缺陷与未决项清单）；本宿主的分册/矩阵行/缺口台账见 `内部规格 内部模块-22` 对应节。
