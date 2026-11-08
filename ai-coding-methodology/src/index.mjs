// 文件：index.mjs
// 描述：ai-coding-methodology 插件入口——把六插件（workflow / spec-gate / scout / team-governance / algo-loop / research-loop）
//       的钩子声明挂到 DeepSeek Harness 的拦截扩展点上。ZCode 侧零改动：本文件只读六插件
//       资产并调用既有钩子脚本，不写任何 ZCode 资产。
//       **声明源（2026-10-01 期二换源，内部决策-036 决策 6 / 内部接口-1 §1）**：钩子声明读插件的
//       中立清单 `plugin.manifest.json`（唯一手工编辑面）；仅当该插件树没有可用中立清单时
//       回落读 ZCode 生成物 `hooks/hooks.json`（0.6.0 前的装机副本兼容）。
//       挂载映射（内部决策-032）：
//         SessionStart     → `agent/created` 执行钩子 → 首轮 `agent/pre-step` 追加 additionalContext
//                            （内部任务-173：不落 durable next-step，避免桌面空闲退出误报）
//         UserPromptSubmit → `agent/pre-step`       阻断或追加消息
//         PreToolUse       → `tools/pre-execute`    deny / ask
//         PostToolUse      → `tools/post-execute`   阻断反馈或追加上下文
//         Stop             → `agent/turn-stopping`  阻断即 steer 再跑一步
//       ZCode 的 PostToolUseFailure 在 DSH 无独立事件（工具失败与成功同走 post-execute），
//       失败分类由 `post-tool.mjs` 自己的防御解析承担——负载里带上 `tool_result` 面。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

import { collectCommands, identifiedUserMessage, registerCommands } from './commands-bridge.mjs';
import { buildPayload, createDispatchFailureReporter, declarationSignature, declaredEventNames, mergeOutcomes, readHookConfigWithDiagnostics, reportDeclarationDiagnostics, runSingleHandler, turnIdOf, MANIFEST_FILE } from './hooks-bridge.mjs';
import { createPlanModeGate } from './plan-mode-gate.mjs';
import { createAllowAdvisory } from './allow-advisory.mjs';
import { createLongTaskDriver, goalOwnsContinuation, GOAL_OWNERSHIP } from './long-task-driver.mjs';
import { collectSkills, registerSkills } from './skills-bridge.mjs';
import { ALL_TOOL_CANDIDATES } from './agents-bridge.mjs';
import { enabledPluginsOf, hasNoPluginToggles, isOsObservationEnabled, unwrapVolatile } from './config-toggles.mjs';
import { attachAgentControl, bridgeChannelHintText, createBridgeHintGate, BRIDGE_HINT_LISTENER_TAG } from './agent-control-bridge.mjs';
import { buildObservationDegradedFact, createObservationEmitter, DSH_OBSERVATION_CAPABILITIES } from './observation-emit.mjs';
import { logInfo, logWarn } from './log.mjs';
import { ensureBound, getEngine } from './engine-binding.mjs';
import { missingConsumedRules, resolveEngine } from './engine-loader.mjs';

/** 插件名（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'ai-coding-methodology';

/** 依赖的宿主服务：`shell` 提供命令执行 seam。 */
export const inject = ['shell'];

/**
 * 宿主配置 schema（cordis 约定）：宿主据此做类型/默认值校验并派生可编辑面；`description` 是面向
 * 操作方的说明面（`--dump-config-schema` 逐字输出）。内部决策-057：`agentControlBridge` 声明为
 * `.volatile()`——宿主 settings 只投影 volatile 字段，插件页配置卡片经 configForms 读写该字段；
 * 其余四项为 apply 期普通配置（仍走 Cordis 配置文件）。插件根三级来源与优先级：显式 `pluginRoots`
 * > 同级发现 > ZCode 安装记录（见 README「插件根」）。
 */
export const Config = z.object({
  pluginRoots: z
    .dict(z.string())
    .default({})
    .description(
      '插件名（workflow / spec-gate / scout / team-governance / algo-loop / research-loop）→ 插件根绝对路径的手工覆盖。给了就用（不再自动兜底）；' +
        '缺省按「同级发现 → ZCode 安装记录（~/.zcode/cli/plugins/installed_plugins.json）」自动确定',
    ),
  projectDir: z
    .string()
    .default('')
    .description('会话工作目录兜底（同时作为 ZCODE_PROJECT_DIR 注入钩子环境）；缺省按会话 cwd，再回落到进程 cwd'),
  startTurn: z
    .boolean()
    .default(true)
    .description('命令处理器是否经 agent.followup 把渲染后的命令正文入队为下一轮提示词；false 时只回执正文、不驱动 agent'),
  mountAgents: z
    .boolean()
    .default(false)
    .description(
      'agent 面兼容位（DEV-308 起已删面）：**键仅兼容、恒不挂载/不告警**——宿主 0.2.1-rc.5 起 persona/toolFilter 由 Agent Preset 承载，本层已按用户裁决 a 移除挂载调用面；开启时只在 apply 期打一条退役 info，不再产生 0 挂载告警。重设计见 OPEN-244。默认关闭。',
    ),
  agentControlBridge: z
    .boolean()
    .default(false)
    .volatile()
    .description(
      '是否向当前会话 agent scope 注册三个非同名桥接工具（list_subagents / message_subagent / wait_subagent），' +
        '让本会话普通 continuable 子代理可列出/可续聊/可等待（DEV-189 / OPEN-151 方向①）。**仅对顶层（delegationDepth=0）会话生效**；默认关闭：' +
        '跨会话不承诺续聊；无 subagents/tools 服务时 fail-open 只告警不注册；开启证据见 README 桥接工具一节。' +
        '2026-10-22 DEV-201 起为 volatile 字段：可经插件详情页「桥接工具面」配置卡片修改（保存后新会话/新 agent 生效）；' +
        '也可继续在 profile 的 cordis.patch.yml 手工配置',
    ),
  pluginWorkflow: z
    .boolean()
    .default(true)
    .volatile()
    .description('是否启用 workflow 插件面（钩子/skill/命令/agent）；默认开。保存后重启宿主生效（ADR-068）'),
  pluginSpecGate: z
    .boolean()
    .default(true)
    .volatile()
    .description('是否启用 spec-gate 插件面；默认开。保存后重启宿主生效（ADR-068）'),
  pluginScout: z
    .boolean()
    .default(false)
    .volatile()
    .description('是否启用 scout 插件面；默认关。保存后重启宿主生效（ADR-068）'),
  pluginTeamGovernance: z
    .boolean()
    .default(false)
    .volatile()
    .description('是否启用 team-governance 插件面；默认关。保存后重启宿主生效（ADR-068）'),
  pluginAlgoLoop: z
    .boolean()
    .default(false)
    .volatile()
    .description('是否启用 algo-loop 插件面；默认关。保存后重启宿主生效（ADR-068）'),
  pluginResearchLoop: z
    .boolean()
    .default(false)
    .volatile()
    .description('是否启用 research-loop 插件面；默认关。保存后重启宿主生效（ADR-068）'),
  osObservation: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      '是否启用 team-governance 的 os-observe 监测（SessionStart 浮现段＋机会式补位采集）；默认开；' +
        '仅当 pluginTeamGovernance 开启时有实际效果。关闭时适配层向该钩子注入 AI_CODING_OS_OBSERVE=0，治理摘要段保留。保存后重启宿主生效（ADR-068）',
    ),
});

/**
 * 读取 agentControlBridge 当前值（内部决策-057）：真实宿主传入 volatile 引用（`createVolatile` 的冻结对象），
 * 运行期值变化经 loader `_commitVolatile` 原地提交，故每次使用时取当前值；测试注入缝允许普通布尔
 * 或带 `get()` 的伪引用。
 * M-18（内部未决-245）：volatile 解包谓词单源在 `config-toggles.unwrapVolatile`（与 7 个配置开关共用），
 * 本函数只保留桥接语义（`=== true` 判定），不再自持第二份解包实现。
 * @param {object} config 插件配置
 * @returns {boolean} 当前是否启用桥接工具面
 */
function isAgentControlBridgeEnabled(config) {
  return unwrapVolatile(config?.agentControlBridge) === true;
}

/** 六插件的目录名（发现与配置的键；algo-loop 2026-10-15 内部任务-90/内部决策-046、research-loop 2026-10-16 内部任务-109/内部决策-047 入套件）。 */
export const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 判定一个目录是否是插件根：**中立清单优先**（`plugin.manifest.json`，内部决策-036 期二换源），
 * 回落 `.zcode-plugin/plugin.json`（0.6.0 前的装机副本 / 仅 ZCode 形态的树）。两者的并集
 * 覆盖三种插件根来源（显式 pluginRoots / 同级发现 / ZCode 安装记录）下的全部树形态；
 * 两者皆无即非插件根——对 内部接口-1 §6 旧判据向后兼容。
 * @param {string} dir
 * @returns {boolean}
 */
export function isPluginRoot(dir) {
  return existsSync(join(dir, MANIFEST_FILE)) || existsSync(join(dir, '.zcode-plugin', 'plugin.json'));
}

/**
 * 从起点目录发现六插件根：先试同级布局（`<base>/<plugin>`，仓库检出与 cache 目录同形），
 * 再逐级上溯。找不到的插件不进结果——适配层静默少注册（fail-open），不猜路径。
 * @param {string} startDir 起点目录（本插件所在目录或更深的子目录）
 * @returns {Record<string, string>} 插件名 → 插件根（可能少于五个）
 */
export function discoverPlugins(startDir) {
  const bases = [];
  let d = resolve(startDir);
  for (let i = 0; i < 6 && d !== ''; i += 1) {
    bases.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // 内部任务-273 H-08：受信边界收窄——上溯基址排除 `node_modules` 路径段、用户家目录及其祖先、`<home>/.dsh` 子树
  // （装机布局下 profile/node_modules、~/.dsh、~ 曾作为同级发现基址，任何同名目录含清单即被采信）。
  const home = String(homedir()).replaceAll('\\', '/');
  let best = {};
  for (const base of bases) {
    const norm = String(base).replaceAll('\\', '/');
    if (/(^|\/)node_modules(\/|$)/.test(norm)) continue;
    if (norm === home || home.startsWith(`${norm}/`) || norm.startsWith(`${home}/.dsh`)) continue;
    const found = {};
    for (const plugin of PLUGINS) {
      const candidate = join(base, plugin);
      if (isPluginRoot(candidate)) found[plugin] = candidate;
    }
    if (Object.keys(found).length > Object.keys(best).length) best = found;
    if (Object.keys(found).length === PLUGINS.length) return found;
  }
  return best;
}

/**
 * 装配处理器清单（S-04/内部未决-245：**唯一装配器**——hooks-bridge 旧 `collectHandlersWithDiagnostics`
 * 复刻件已删；本函数同时是生产派发路径与测试断言对象，装配统计不再锁在复刻件上）。
 * `{byEvent: 事件 → [{pluginRoot, plugin, handler}], plugins: 逐插件声明诊断}`；声明顺序即执行顺序，
 * 遍历固定按 `PLUGINS`（与 enabledRoots 构造同序）；`sinks` 非空时统一报声明诊断。
 * @param {Record<string, string>} roots 插件名 → 插件根
 * @param {{warn?: Function, info?: Function}|null} [sinks] 声明诊断日志出口（可选；内部任务-272）
 * @returns {{byEvent: Record<string, {pluginRoot: string, plugin: string, handler: object}[]>, plugins: Array<object>}}
 */
export function collectHandlers(roots, sinks = null) {
  /** @type {Record<string, {pluginRoot: string, plugin: string, handler: object}[]>} */
  const byEvent = {};
  const plugins = [];
  for (const plugin of PLUGINS) {
    const root = roots[plugin];
    if (typeof root !== 'string' || root === '') continue;
    const d = readHookConfigWithDiagnostics(root);
    for (const [event, handlers] of Object.entries(d.config)) {
      for (const handler of handlers) {
        if (!byEvent[event]) byEvent[event] = [];
        byEvent[event].push({ pluginRoot: root, plugin, handler });
      }
    }
    plugins.push({ ...d, plugin, root });
  }
  if (sinks) reportDeclarationDiagnostics(plugins, sinks);
  return { byEvent, plugins };
}

/**
 * matcher 匹配：`|` 分隔的字面量备选，命中任一即匹配。
 * 与宿主桥语义一致——**matcher 缺省即全匹配**（不是"不匹配"）；未知词只影响本事件是否
 * 触发，不影响其他处理器（fail-open 的一环）。
 * @param {string|undefined} matcher 声明里的 matcher（如 `Bash`、`Edit|Write`）
 * @param {string} subject 被匹配的主题（工具名；无 matcher 概念的事件传 `''`）
 * @returns {boolean} 是否匹配
 */
export function matchesMatcher(matcher, subject) {
  if (matcher === undefined) return true;
  return matcher.split('|').includes(subject);
}

/**
 * SessionStart 的 matcher 主题归一。
 *
 * 本层实际遇到的 matcher 有两种形态（2026-09-28 第 64 批实测四插件 `hooks.json`）：
 * - `workflow` / `spec-gate` / `scout`：`startup|resume|clear|compact`（ZCode 会话来源词表）；
 * - `team-governance`：**未声明 `matcher`**——`matchesMatcher(undefined, ·)` 恒真，故它在
 *   任何 source 下都会跑（治理摘要本就该每会话都出）。
 *
 * 而 DSH 的 `agent/created` 只报告自己的 source 词表（本机实测其字面量为 `"startup"` 与
 * `"resume"` 两种，见 §8.52），两者**不必然相交**。SessionStart 注入是元技能全文进入模型的
 * 唯一通道（内部规则-5），漏匹配即整套路由纪律静默失效，故：宿主 source 不在 ZCode 词表内时
 * 归一到 `startup`（生命周期那一刻的语义），**不做静默丢弃**。这条兜底同时保证"宿主将来新增
 * 了别的 source 值"时，三份带词表的 SessionStart 仍会命中并注入。
 * @param {unknown} source 宿主报告的会话来源
 * @returns {string}
 */
export function normalizeSessionSource(source) {
  // 引擎驱动（内部决策-037 批 2 步骤 6）：判据域与归一目标在 `source-widen-normalize` 的 `params.dsh`
  // （accepted 集合 + to 目标），本层不再持有内联白名单；漂移即具名抛错（不静默回落）。
  const outcome = getEngine().applyRule('source-widen-normalize', 'dsh', { source });
  if (outcome.applied !== true) {
    throw new Error('index: 规则库字段契约漂移（source-widen-normalize 缺 params.dsh）——拒载而非静默回落');
  }
  return outcome.result;
}

/** 本层自注入消息的 source 标识（`contextMessage` 用它，`userPromptOf` 据此排除）。 */
export const SELF_SOURCE_KIND = 'ai-coding-methodology';

/**
 * 从 `agent/pre-step` 收到的消息里挑出**用户本轮输入**，拼成本层交给 ZCode 钩子的 `prompt`。
 *
 * **必须排除本层自己注入的消息**（2026-09-28 第 78 批；2026-10-20 内部任务-173 更正 why）：实际依赖
 * 此排除的是**仍走 `agent.inject` 的通道**（Stop/task-recap/learnings-recap、PreToolUse allow 提醒）——
 * 它们落 agent inbox，由 `preStep` 的 `claim()` 与用户那条**一起取走**，不排除会把整段注入拼在用户输入前。
 * SessionStart 自 内部任务-173 起改首轮 pre-step 追加 `decision.messages`（落 `user/message`，不回 pre-step
 * payload），不构成此处输入；保留同一排除谓词，防通道变化时回退。
 *
 * 后果是**语义错位**而非崩溃：ZCode 的 `user-prompt.mjs` 有头锚定判断
 * （`isRoutingDrift` 里 `prompt.replace(/^\s+/, '')` 后按 `^\s*` 语义匹配意图），
 * 注入文本前缀会让"用户这轮说了什么"被淹没，使场景漂移提醒**静默少触发**。
 *
 * 判据用 `source.kind`（本层消息带 `SELF_SOURCE_KIND`）；`/clear` 等宿主/别家注入的
 * 消息仍按原样保留——它们不是本层产生的，本层不替别人做主。
 * @param {unknown} messages `agent/pre-step` 负载里的 messages
 * @returns {string} 用户输入文本（无则空串）
 */
export function userPromptOf(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m?.source?.kind !== SELF_SOURCE_KIND)
    .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 构造模型可见的注入消息（本层自注入面）。形状的唯一实现在
 * `commands-bridge.mjs` 的 `identifiedUserMessage`——那里写明为什么必须同时带 `role` 与 `id`
 * （`role`：2026-09-28 第 75 批补；`id`：2026-09-29 第 107 批补，内部任务-DSHID-1——缺 `id` 的
 * `user/message` 事件会让整份会话日志在下次加载时被拒）。
 * 本函数只负责钉住本注入面的 `source.kind`（`SELF_SOURCE_KIND`，`userPromptOf` 据此排除自注入）。
 * @param {string} text
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: string}}}
 */
export function contextMessage(text) {
  return identifiedUserMessage(text, SELF_SOURCE_KIND);
}

/**
 * 向 `agent/pre-step` 的 enter 决策末尾追加一条本层自注入消息（S-05/内部未决-245：4 处注入样板单源）。
 * 四处样板原先各自展开 messages：三处（长任务协议/桥接提示/SessionStart 投递）带 `Array.isArray`
 * 守卫，UserPromptSubmit 一处没有；缺守卫时 `downstream.messages` 非数组会在 listener 内抛
 * TypeError，被 `safe()` 捕获后按 fallback 二次调用 `next()`——宿主 cordis waterfall 的 `next()`
 * 是一次性的（二次调用抛 `next() called multiple times`），于是「fail-open」实际变成 pre-step
 * 派发 reject、注入全丢。本函数统一守卫：非数组一律当空数组（与既有三处语义逐字一致）。
 * 调用前提：调用方已判 `decision?.kind === 'enter'` 且 `text` 非空。
 * @param {object} decision 下游 pre-step 决策（kind === 'enter'）
 * @param {string} text 注入正文
 * @returns {object} 新决策对象（messages 末尾追加一条 identified message；不修改入参）
 */
function appendSelfMessage(decision, text) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  return { ...decision, messages: [...messages, contextMessage(text)] };
}

/** 会话工作目录（agent 对象 → cwd 字符串或 undefined）。 */
const workdirOf = (agent) => {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
};

/** 会话 id（agent 对象 → 字符串，缺省空串）。 */
const sessionIdOf = (agent) => {
  const id = agent?.session?.header?.id;
  return typeof id === 'string' ? id : '';
};

/**
 * 委派深度（内部任务-20 A1/F4）：**镜像宿主 `delegationDepthOf(agent)` 的口径**——取
 * `agent.session.header.delegationDepth` 与 `agent.options.subagentDepth` 的 max，
 * 非安全整数一律按 0 计。刻意**不引入** `origin === 'subagent'` 地板（plan-review D8：
 * 宿主两字段同源置位，额外地板是自造语义且要为它单造夹具分支）；取不到 ⇒ 0（顶层会话语义），
 * 不得编造深度让钩子误判委派。
 * @param {object} agent 宿主 agent 对象
 * @returns {number} 非负整数（缺省 0）
 */
const delegationDepthOf = (agent) => {
  const header = agent?.session?.header;
  const runtime = agent?.options?.subagentDepth;
  return Math.max(
    Number.isSafeInteger(header?.delegationDepth) ? header.delegationDepth : 0,
    Number.isSafeInteger(runtime) ? runtime : 0,
  );
};

/**
 * 父会话标识（内部决策-061 D3/D4，内部任务-227）：取宿主会话头 `parentSession`（委派子会话在场）；
 * 非空字符串才返回，否则 null（缺键/非法 ⇒ 不产 `parent_session_id`，顶层会话语义）。
 * 注：该字段的宿主运行期形态仅由会话日志面实证，实施批加非空字符串保护；漂移时缺键即退
 * 非委派路径，不猜、不强转。
 * @param {object} agent 宿主 agent 对象
 * @returns {string|null}
 */
const parentSessionIdOf = (agent) => {
  const raw = agent?.session?.header?.parentSession;
  return typeof raw === 'string' && raw !== '' ? raw : null;
};

/**
 * 合并多个处理器的解码结果：决策语义委托给 `mergeOutcomes`（与 hook-protocol 同源的
 * `deny > ask > allow` 折叠），本层只把结果适配成装配层消费的形状
 * （`additionalContext` 由单值折成按声明顺序累积的数组）。
 * @param {ReturnType<typeof mergeOutcomes>[]} decodeResults
 * @returns {{decision: string, reason: string|undefined, additionalContext: string[], block: boolean}}
 */
function mergeResults(decodeResults) {
  const merged = mergeOutcomes(decodeResults);
  return {
    decision: merged.decision,
    reason: merged.reason,
    additionalContext: merged.additionalContext.filter((t) => typeof t === 'string' && t !== ''),
    block: merged.block,
  };
}

/**
 * 取宿主服务（本层唯一的服务读取口）。
 * **必须走 `ctx.get(name)`**：cordis 源码（`cordis/src/reflect.ts` 的 ReflectService handler）
 * 里 `ctx.<service>` 属性访问只在 `inject` 声明了该服务时才合法，否则抛
 * `cannot get property "X" without inject`；而 `ctx.get` 的原话是
 * `Read a service from the store without the inject requirement`，服务缺席返回 undefined。
 * 本插件的 `inject` 只声明 `shell`（其余三面刻意保持"缺服务也能加载"），故属性读一律非法。
 * 兜底读 `ctx[name]` 只为兼容测试替身（纯对象 ctx），在真实 cordis 上由 try/catch 落到 undefined。
 * @param {object} ctx cordis 上下文（或测试替身）
 * @param {string} name 服务名
 * @returns {any|undefined}
 */
export function resolveService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const svc = ctx.get(name);
      if (svc !== undefined) return svc;
    }
    const direct = ctx?.[name];
    if (direct !== undefined) return direct;
    return undefined;
  } catch {
    // 真实 cordis 上属性读会抛（inject 未声明）——这正是要避免的那条路，吞掉即可
    return undefined;
  }
}

/**
 * 取宿主**真实可用**的工具名集合，供 `toolFilter` 求交集。
 * 这是 agent 面唯一的安全来源：`tools.restrict()` 对未知名抛错，所以名字必须来自宿主目录
 * 而不是本层写死的表。宿主未暴露可读的工具目录时返回 **null**（fail-closed：不挂载任何
 * 委派工具，由 `mountAgents` 响亮告警）——宁可少一个 agent，也不给一个不过滤的子 agent。
 *
 * **内部任务-273 H-02**：探测改走宿主**公开 API** `tools.get(name)`（`dsh-tools` 公开成员；
 * 未知名返回 undefined）。旧实现读 `tools.restrictableNames`/`tools.listNames` 是**服务对象上不
 * 存在的成员**（`restrictableNames` 只在 `ToolRuntime.view(scope)` 返回值上；宿主
 * 0.2.1-rc.5 源码核证）⇒ 旧实现在真实宿主恒 null（假件冒充生产契约）。候选名集从
 * `agents-bridge` 的 `CORE_TOOLS`/`EXTENDED_TOOLS`＋平台 shell 名复用（单一来源，防两处漂移）。
 * 注意：rc.5 Web profile 把全局工具行禁用、工具改由 Agent Preset 承载 ⇒ 本探测返回 null 是
 * **如实 fail-closed**（不宣称 agent 面可用；契约重设计见 内部未决-244）。
 * **休眠（内部任务-273 起）**：agent 面在当前宿主契约下不可用（H-03 如实降级），生产装配不再调用本函数；
 * 保留导出作为宿主契约钉子与 内部未决-244 重设计的就绪探测面（测试/未来批消费）。
 * @param {object} ctx cordis 上下文
 * @returns {string[]|null} 可用工具名（非空）或 null（目录不可得）
 */
export function resolveAvailableTools(ctx) {
  try {
    const tools = resolveService(ctx, 'tools');
    if (tools === undefined || tools === null || typeof tools.get !== 'function') return null;
    const candidates = [...ALL_TOOL_CANDIDATES];
    const available = [];
    for (const name of candidates) {
      let def;
      try {
        def = tools.get(name);
      } catch {
        def = undefined; // 未知名抛错（宿主实现差异）：按不可得继续探测其余候选
      }
      if (def !== undefined && def !== null) available.push(name);
    }
    return available.length > 0 ? available : null;
  } catch {
    return null; // 探测失败 = 目录不可得（fail-closed）
  }
}

/**
 * 从 ZCode 的安装记录读取六插件根（**权威来源**，非猜测）。
 *
 * 背景（2026-09-28 第 30 批实测）：四插件的生产形态在 ZCode 缓存目录下，
 * 形如 `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`——比同级布局**深一层**，
 * 且同名插件存在**多个版本目录**（仓库维护说明 明确要求保留旧版本目录，因为运行中会话的钩子
 * 路径指向启动时加载的那个版本）。所以"扫描缓存目录再挑一个版本"是**错的做法**：挑到旧版会
 * 让适配层对着过期资产跑。
 *
 * 正确做法是读 ZCode 自己的安装记录 `~/.zcode/cli/plugins/installed_plugins.json`：
 * 每条含 `name` / `marketplace` / `version` / `installPath`——**与运行中会话所依据的是同一份
 * 权威记录**，因此天然不会挑错版本。
 *
 * fail-open：文件缺失、JSON 损坏、字段形态漂移一律返回空对象（少发现插件 = 少注册，
 * 绝不抛错、绝不猜路径）。
 *
 * @param {string} [home] 用户主目录（测试注入缝；缺省 `os.homedir()`）
 * @param {{warn?: Function}} [logger] 告警出口（缺省静默；同名多条时必须由装配层注入，否则可见性丢失）
 * @returns {Record<string, string>} 插件名 → 安装路径（仅含存在且确为插件根的项）
 */
export function discoverFromInstalledPlugins(home = homedir(), logger) {
  const record = join(home, '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(record, 'utf8'));
  } catch (error) {
    // 记录不存在/不可读/损坏：不是错误，是"这条路走不通"（fail-open，交给 pluginRoots 配置兜底）
    logInfo(logger, `ai-coding-methodology: 未能读取 ZCode 安装记录（${record}）：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
  const found = {};
  for (const plugin of PLUGINS) {
    // 同名可能有多条（多 marketplace / 多作用域）：取**最后一条**——记录由客户端追加式更新，
    // 后写的代表当前安装状态。
    // 两条接受条件（缺一不可）：
    //  · `installPath` 必须是**非空字符串**；
    //  · `installPath` 必须是**绝对路径**——相对路径会被 `isPluginRoot` 按**进程 cwd** 解析，
    //    若恰好撞上一个同名的插件根目录，就会把一个无关目录当成该插件的根（**比找不到更坏**：
    //    静默接错来源）。本机 live 记录实测全为绝对路径（`cache\<market>\<plugin>\<ver>\`），
    //    故拒绝相对路径不会影响现有形态；真遇到相对记录，正确做法是用 `pluginRoots` 显式指定。
    const hits = list.filter(
      (entry) =>
        entry?.name === plugin &&
        typeof entry.installPath === 'string' &&
          entry.installPath !== '' &&
        isAbsolute(entry.installPath),
    );
    // 倒序取第一条**有效**记录（末条 installPath 不存在/非插件根时回落早条）；同名多条必须可复盘。
    const validHit = [...hits].reverse().find((entry) => isPluginRoot(entry.installPath));
    if (hits.length > 1) {
      const ignored = hits.filter((entry) => entry !== validHit).map((entry) => `${entry.marketplace ?? 'n/a'}:${entry.installPath}`);
      logWarn(
        logger,
        `ai-coding-methodology: 安装记录同名条目 ${hits.length} 条（${plugin}）——按记录追加序取${validHit === undefined ? '无有效记录' : '最后一条有效'}，已忽略 ${ignored.length} 条：${ignored.join('；')}`,
      );
    }
    if (validHit !== undefined) found[plugin] = validHit.installPath;
  }
  return found;
}

/**
 * 决议每个插件的根目录（纯函数，从三个来源按**固定优先级**取第一个可用者）：
 *
 *   1. **显式配置** `config.pluginRoots[plugin]`——非空字符串才认。
 *      若给了但**不是**合法插件根，**不回落到自动来源**（"显式指定"必须名符其实：
 *      静默改用别的来源会让操作者以为自己在用 A、实际在用 B）。
 *   2. **同级发现** `discovered[plugin]`——开发态（仓库检出）的常规来源，恒 6/6。
 *   3. **安装记录补位** `installed[plugin]`——装机态来源（`discoverFromInstalledPlugins`）。
 *
 * **为什么抽成导出函数**（2026-09-28 第 90 批）：这段优先级逻辑原先写在 `apply` 体内，
 * 而 `apply` 的同级发现基于**源码所在目录**、仓库检出下恒 6/6，故"同级不足 ⇒ 用安装记录"
 * 这条在仓库内**无法经 `apply` 走到**。原测试因此**逐字复刻**了这段表达式——
 * 复刻件不会随 `apply` 演进而失效，**是一处会静默漂移的重复**。抽成函数后测试直接调真的实现，
 * 重复消失；`apply` 仍按同一函数决议（行为不变）。
 * @param {object} input
 * @param {Record<string, string>} input.discovered 同级发现结果
 * @param {Record<string, string>} input.installed 安装记录补位结果
 * @param {Record<string, unknown>} input.override 显式 `pluginRoots` 配置
 * @param {(message: string) => void} [input.warn] 配置拒绝告警出口（缺省静默，便于纯函数测试）
 * @returns {{roots: Record<string, string>, missing: string[], sources: Record<string, 'config'|'sibling'|'installed'>}}
 *   可用根、仍缺失的插件名与实际来源（来源由本函数单点产出——装配层不得二次推断）
 */
export function resolvePluginRoots({ discovered, installed, override, warn }) {
  /** @type {Record<string, string>} */
  const roots = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {Record<string, 'config'|'sibling'|'installed'>} */
  const sources = {};
  for (const plugin of PLUGINS) {
    const configured = typeof override[plugin] === 'string' && override[plugin] !== '' ? override[plugin] : undefined;
    // 内部任务-273 H-08（正确性评审 round1 #1）：显式配置只接受**绝对路径**；相对路径是配置错误——
    // 必须 warn＋计入 missing 且**不回落**自动来源（旧实现在此静默换源，与 JSDoc「显式指定必须名符其实」相反）。
    if (configured !== undefined && !isAbsolute(configured)) {
      if (typeof warn === 'function') warn(`ai-coding-methodology: pluginRoots.${plugin} 不是绝对路径（${configured}）——拒绝该配置且不回落自动来源`);
      missing.push(plugin);
      continue;
    }
    const fromConfig = configured;
    const fromSibling = discovered[plugin];
    const fromInstalled = installed[plugin];
    const root = fromConfig ?? fromSibling ?? fromInstalled;
    if (root === undefined || !isPluginRoot(root)) {
      missing.push(plugin);
      continue;
    }
    roots[plugin] = root;
    sources[plugin] = fromConfig !== undefined ? 'config' : fromSibling !== undefined ? 'sibling' : 'installed';
  }
  return { roots, missing, sources };
}

/** 内部任务-273 步骤11 T-10：同一 ctx 二次 apply 幂等——监听器与注册面不翻倍（只记录成功走到装配末尾的 ctx）。 */
const APPLIED_CONTEXTS = new WeakSet();

/**
 * 插件装配入口（cordis 约定：导出 `name` / `inject` / `apply` / `Config`）。
 * 四个面各自独立探测与注册，任一面的服务缺失只跳过该面；**两类例外先落 `logWarn` 再外抛**：
 * ①装载期引擎不可得（拒载，内部决策-037 裁决 A）；②注册期引擎分派失败（同步路径上的数据/引擎完整性故障）。
 * 其余（含会话期，均已由 `safe()` 覆盖）维持 fail-open（project-conventions 硬规则 4）。
 * @param {object} ctx cordis 上下文（只 `inject: ['shell']`；其余服务经 `ctx.get` 探测）
 * @param {object} [config] 配置
 * @param {Record<string, string>} [config.pluginRoots] 插件根覆盖（键为插件名）
 * @param {string} [config.projectDir] 工作目录兜底（缺省按会话 cwd）
 * @param {boolean} [config.startTurn] 命令面是否经 `agent.followup` 驱动下一轮
 * @param {boolean} [config.mountAgents] 是否挂载 agent 面（默认 false）
 * @param {string} [config.home] **测试注入缝**（非 schema 项）：覆盖「读 ZCode 安装记录」所用的
 *   用户主目录。生产不传（缺省 `os.homedir()`）；测试传临时目录，避免用例读取操作者真实
 *   `~/.zcode` 而使结果随机器漂移。
 * @param {string} [config.repoRootOverride] **测试注入缝**（非 schema 项）：显式指定仓库根
 *   （plugin-core 的父目录）；给了就用、不再自动兜底（缺失即拒载）。
 * @param {Function} [config.observationEmitSpawn] **测试注入缝**（非 schema 项，内部任务-192 P2）：
 *   替换 `observation-emit` 的子进程执行器（签名同 `child_process.spawnSync`，返回
 *   `{status, stdout, stderr, error?}`）。生产不传（缺省 `spawnSync`）；测试用它伪造
 *   emit 成功/失败两态，不真跑 CLI（也不真写账本）。
 * @returns {Promise<void>} 装配完成即 resolve；装载期拒载与注册期引擎分派失败两类会先落
 *   `logWarn` 再外抛，其余失败已记日志并降级
 */
export async function apply(ctx, config = {}) {
  // 内部任务-273 步骤11 T-10：幂等守卫（宿主热重载/测试复用同一 ctx 时不得重复注册）。
  if (APPLIED_CONTEXTS.has(ctx)) {
    logInfo(ctx.logger, 'ai-coding-methodology: 同一 ctx 二次 apply——跳过重复装配（幂等，监听器不翻倍）');
    return;
  }
  // ① 装载期：引擎解析 + 绑定（拒载语义；先落日志再外抛——爆炸半径「可见可修」的凭据）
  try {
    ensureBound(() => resolveEngine({ repoRootOverride: config.repoRootOverride }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logWarn(ctx.logger, `ai-coding-methodology: 引擎不可得，拒载（不注册任何面）——${detail}`);
    throw error; // 抛出点全是 `new Error`（engine-loader/engine-binding），无需再抛归一
  }
  // ①b 装载期机械断言：7 条消费规则均登记且均含 `params.dsh`（数据漂移挡在装载期，不留到运行期静默放宽护栏）
  try {
    const missing = missingConsumedRules(getEngine());
    if (missing.length > 0) {
      throw new Error(`字段契约漂移：以下消费规则缺 params.dsh 或未登记——${missing.join('、')}（ADR-037 批 2 消费点表）`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logWarn(ctx.logger, `ai-coding-methodology: 规则库字段契约不满足，拒载（不注册任何面）——${detail}`);
    throw error; // 同上：抛出点均为 `new Error`
  }
  // ①c F2 桥接工具（内部任务-189 / 内部未决-151 方向①；内部决策-057 配置面）：**恒装配** agent/created 监听，
  // 由 isEnabled 在每次创建时读取当前值——volatile 配置变更不重挂插件，门控必须在使用点判定；
  // 默认关（false）时监听什么都不做；无服务/判定异常仅一次性告警（fail-open）。
  // 注册 scope：tools 必须取**该 agent 的 ctx.get('tools')**（agent scope；全局层注册会跨会话串扰
  // 且不随会话释放——dsh-tools register 的 scope 由取服务的 ctx 决定）。
  // 内部任务-220：per-session 注册事实（sid→实际注册工具名；内部决策-057 关闭后新会话不注册 ⇒ Map 无该 sid，
  // 首轮提示据此不注入——不得用 apply 级布尔判"曾注册过"）；提示 onceness 唯一归属 gate。
  // 生命周期：只在 created 写/重臂、disposer 时清空（无会话结束钩子；条目为静态工具名、量级小，不清理
  // 不构成跨会话信息泄漏——但必须在 dispose 时回收，避免长寿命宿主跨会话累积）。
  const bridgeRegisteredSessions = new Map();
  let bridgeSidMissingWarned = false;
  const bridgeHintGate = createBridgeHintGate({
    depthOf: (agent) => delegationDepthOf(agent),
    sidOf: (agent) => sessionIdOf(agent),
    isRegistered: (sid) => bridgeRegisteredSessions.has(sid),
    warn: (message) => logWarn(ctx.logger, message),
  });
  const disposeBridge = attachAgentControl(ctx, {
    isEnabled: () => isAgentControlBridgeEnabled(config),
    getServices: (agent) => ({
      // 只取该 agent scope 的 tools；不可得即不注册（**不得回落插件全局层**——那会跨会话串扰且不随会话释放）
      tools: typeof agent?.ctx?.get === 'function' ? agent.ctx.get('tools') : undefined,
      subagents: resolveService(ctx, 'subagents'),
      agents: resolveService(ctx, 'agents'),
    }),
    depthOf: (agent) => delegationDepthOf(agent),
    onRegistered: (agent, result) => {
      const sid = sessionIdOf(agent);
      if (sid === '') {
        // 一次性：apply 生命周期内至多一条（与 SessionStartDelivery 的空 sid warn 同款；gate 侧另有去重 warn）
        if (!bridgeSidMissingWarned) {
          bridgeSidMissingWarned = true;
          logWarn(ctx.logger, 'ai-coding-methodology: 桥接工具面已注册但会话 id 缺失——首轮提示门控不登记（一次性）');
        }
        return;
      }
      bridgeRegisteredSessions.set(sid, result.registeredTools);
      bridgeHintGate.reset(sid); // 新 agent（含 resume）重臂：每 agent 生命周期至多一次
      logInfo(ctx.logger, `ai-coding-methodology: 桥接工具面已注册（agent=${agent.id} tools=${result.registeredTools.join(',')}）`);
    },
    warn: (message) => logWarn(ctx.logger, message),
  });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      bridgeRegisteredSessions.clear();
      disposeBridge();
    });
  }
  const override = config.pluginRoots && typeof config.pluginRoots === 'object' ? config.pluginRoots : {};
  const discovered = discoverPlugins(dirname(HERE));
  // 安装记录作**补位**来源：只在同级发现缺失时启用，且不覆盖用户显式配置——
  // 仓库检出场景下同级发现本就命中（6/6），不会走到这条；且开发时同级根总是比缓存里的
  // 已发布版本新，优先级必须低于同级发现（否则改代码不生效、测试对着旧资产跑）。
  const home = typeof config.home === 'string' && config.home !== '' ? config.home : undefined;
  const installed = Object.keys(discovered).length < PLUGINS.length ? discoverFromInstalledPlugins(home, ctx.logger) : {};
  const { roots, missing, sources: rootSourcesMap } = resolvePluginRoots({
    discovered,
    installed,
    override,
    warn: (message) => logWarn(ctx.logger, message),
  });
  // 内部任务-268/内部决策-068：六插件开关在装配期过滤四面；原 roots 保留给观测发射器与「未发现」日志，
  // 仅派生 enabledRoots 进入四面 collector（关闭插件零注册，且不误报为「未发现」）。
  const enabledPluginSet = new Set(enabledPluginsOf(config));
  const enabledRoots = {};
  for (const plugin of PLUGINS) {
    if (enabledPluginSet.has(plugin) && typeof roots[plugin] === 'string' && roots[plugin] !== '') {
      enabledRoots[plugin] = roots[plugin];
    }
  }
  const disabledPlugins = PLUGINS.filter((plugin) => !enabledPluginSet.has(plugin));
  if (hasNoPluginToggles(config)) {
    logInfo(ctx.logger, 'ai-coding-methodology: 配置未经 Config schema 归一（六开关字段缺失），按兼容语义视为全开');
  }
  if (disabledPlugins.length > 0) {
    logInfo(ctx.logger, `ai-coding-methodology: 未启用插件 ${disabledPlugins.join(',')}（可在插件页配置卡片开启，保存后重启宿主生效）`);
  }
  if (enabledPluginSet.size === 0) {
    logInfo(ctx.logger, 'ai-coding-methodology: 全部插件未启用（四面零注册；可在插件页开启后重启宿主）');
  }
  const osObservationEnabled = isOsObservationEnabled(config);
  // 注册期引擎分派失败的统一处置（内部决策-037 决策 6 两窗口口径）：**先 `logWarn` 再外抛**——
  // 注册期不在会话期 `safe()` 覆盖内，静默抛错会丢掉"哪一步、哪条规则"的现场。
  const registrationStep = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logWarn(ctx.logger, `ai-coding-methodology: 注册期引擎分派失败（${label}）——${detail}`);
      throw error;
    }
  };
  const hookSinks = { warn: (m) => logWarn(ctx.logger, m), info: (m) => logInfo(ctx.logger, m) };
  let byEvent = registrationStep('collectHandlers', () => collectHandlers(enabledRoots, hookSinks).byEvent);
  // 内部任务-285 / 内部模块-24 R-da-18：钩子声明源签名热加载——长驻宿主跨插件升级不再静默沿用 apply 期
  // 旧清单（本机实证：宿主 2026-11-01 启动于 0.20.7，write-guard 第 4 钩从未被派发；
  // `内部证据`）。语义边界：只重建**既有事件**的处理器列表
  // （apply 期零声明事件不增挂＝已登记边界 内部未决-253，不宣称任意声明热生效）；每次派发前
  // 逐插件根比对签名（无变更零重读），变更时经 `collectHandlers` 重建（逐条目保留 `plugin`
  // 字段并重跑声明诊断）；读取/重建失败保留旧清单 fail-open 且告警一次。
  const hookDeclSignatures = new Map(Object.entries(enabledRoots).map(([plugin, root]) => [plugin, declarationSignature(root)]));
  let hookReloadWarned = false;
  const refreshHookDeclarationsIfChanged = () => {
    // 评审修复（内部任务-285 code-review r1）：签名先算到 `pending`，**整体重建成功后才提交**——
    // 否则「签名已推进 + 重建失败保留旧清单」会让同批其它插件的更新永久不再重试（静默陈旧）。
    const pending = new Map(hookDeclSignatures);
    const changedPlugins = [];
    for (const [plugin, root] of Object.entries(enabledRoots)) {
      const signature = declarationSignature(root);
      if (signature !== hookDeclSignatures.get(plugin)) {
        pending.set(plugin, signature);
        changedPlugins.push(plugin);
      }
    }
    if (changedPlugins.length === 0) return false;
    // 不可读/坏声明＝**重载失败**（保留旧清单），不得按 ZCode 回落面静默变空（fail-open 语义：
    // 失败时沿用旧清单；声明修好后 mtime 再变化会触发下一次重载）。只对**本次变化**的插件做
    // 不可读否决（坏插件本身不提交签名、每轮都会重试）；但同批其它已变化插件要等坏声明修复后
    // 才整体重建——这是「保留旧清单」的可用性取舍，如实记录于
    // 内部评审记录，不宣称互不冻结。
    for (const plugin of changedPlugins) {
      const diag = readHookConfigWithDiagnostics(enabledRoots[plugin]);
      const unreadable = diag.unreadable && Object.keys(diag.unreadable).length > 0;
      if (unreadable) {
        if (!hookReloadWarned) {
          hookReloadWarned = true;
          logWarn(ctx.logger, `ai-coding-methodology: 钩子声明已重载失败——声明源不可读（plugin=${plugin}），保留旧清单（fail-open）`);
        }
        return false;
      }
    }
    try {
      const nextAssembly = collectHandlers(enabledRoots, hookSinks);
      for (const [plugin, signature] of pending) hookDeclSignatures.set(plugin, signature);
      const nextByEvent = nextAssembly.byEvent;
      byEvent = nextByEvent;
      hookReloadWarned = false;
      // 内部模块-24 R-da-18：重载日志须含插件名与事件/处理器计数（评审修复 r1：R/A 口径对齐）。
      const counts = Object.entries(nextByEvent)
        .map(([event, handlers]) => `${event}=${Array.isArray(handlers) ? handlers.length : '?'}`)
        .join(',');
      logInfo(ctx.logger, `ai-coding-methodology: 钩子声明已重载（插件=${changedPlugins.join(',')}；声明源签名变化；处理器计数 ${counts}）`);
      return true;
    } catch (error) {
      if (!hookReloadWarned) {
        hookReloadWarned = true;
        logWarn(
          ctx.logger,
          `ai-coding-methodology: 钩子声明已重载失败——保留旧清单（fail-open）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  };
  // 内部决策-063 D2/D8（内部任务-192 P2）：观测事实上报器（每次 apply 一份，闭包持有「失败只告警一次」
  // 状态）。`cliPath` 缺失（workflow 插件根不可得）时按 内部接口-26 §3.1 的「跨单元路径
  // 不可得」形态直接走兜底旁路；`observationEmitSpawn` 是**测试注入缝**（非 schema 项，
  // 与 config.home/repoRootOverride 同款）——生产不传，缺省 node:child_process.spawnSync。
  const observationEmit = createObservationEmitter({
    spawn: typeof config.observationEmitSpawn === 'function' ? config.observationEmitSpawn : undefined,
    cliPath: typeof roots.workflow === 'string' && roots.workflow !== '' ? join(roots.workflow, 'scripts', 'incident-cli.mjs') : '',
    warn: (message) => logWarn(ctx.logger, message),
  });
  // 内部决策-063 修正案 3 决策 23.1（内部任务-195）：DSH 派发失败 producer——三态（spawn 错/超时/信封损坏）
  // 经 内部接口-26 emit 上报 `hook-failure`。reporter 为 apply 级实例（闭包持有每会话同类去重
  // Set），只持 emitter；sessionId 每次由 payload 取（不固化，跨会话不串键）。emit 失败仅 logWarn。
  const reportDispatchFailure = createDispatchFailureReporter({
    emit: observationEmit,
    warn: (message) => logWarn(ctx.logger, message),
  });
  // 批 3 步骤 2：`apply` 作用域内的"已派发"事实面（`tools/execute` 监听写入，`tools/post-execute`
  // 读取）。用 WeakSet 而非 Map：调用完成后无需保留，且不阻碍 exec 对象回收。
  const dispatched = new WeakSet();
  // 内部未决-115（内部任务-167）：allow 档提醒的模型可见承载（每次 apply 一份；模块顶层不共享）。
  // `request` 判定可注入后由调用方在 inject 成功时 commit；失败不占冷却/配额。
  const allowAdvisory = createAllowAdvisory();
  const allowAdvisoryWarned = new Set(); // 无 inject/不可归属会话的一次性告警去重
  // 内部决策-053（内部任务-171）：长任务编排。host-gate：goals 服务存在且 get 可调用才启用。
  // readGoalsService 只走 ctx.get + try/catch（不属性回落，避免 Proxy 服务读取契约用例 violations）。
  const readGoalsService = (c) => {
    try { return typeof c?.get === 'function' ? c.get('goals') : undefined; } catch { return undefined; }
  };
  const goalsService = readGoalsService(ctx);
  const longTaskWarned = new Map();
  const longTaskWarn = (sessionId, key, message) => {
    const sid = sessionId === '' ? '<unknown>' : sessionId;
    let keys = longTaskWarned.get(sid);
    if (keys === undefined) { keys = new Set(); longTaskWarned.set(sid, keys); }
    if (keys.has(key)) return;
    keys.add(key);
    logWarn(ctx.logger, message);
  };
  const longTaskDriver = goalsService !== undefined && goalsService !== null && typeof goalsService.get === 'function'
    ? createLongTaskDriver({ warn: (message) => logWarn(ctx.logger, message) })
    : undefined;
  const longTaskProtocolSent = new Set();
  // 内部任务-272（内部未决-236）：plan 模式识别门控（宿主 rc.5 dsh-plan-mode 服务；缺失/异常 fail-open）。
  const planModeGate = createPlanModeGate({
    readService: () => resolveService(ctx, 'planMode'),
    info: (message) => logInfo(ctx.logger, message),
    sidOf: (agent) => sessionIdOf(agent),
  });
  if (longTaskDriver === undefined) logInfo(ctx.logger, 'ai-coding-methodology: 长任务编排未启用（宿主 goals 服务不可用）');
  // 内部任务-59（内部未决-60）：PostToolUse 派发面的「全暗」哨兵计数（`apply` 闭包内，跨会话按 id 去重）。
  // 判据：同会话 post-execute 事件 ≥3 次而经派发点命中 0 次 ⇒ 一次性告警（阈值 3：真机实测
  // "事实面不发生 ⇒ 观测面全暗"当天即可触发，10 次过迟；见 post-execute 监听处）。
  const postExecuteStats = new Map();
  const allDarkWarned = new Set();
  // 内部任务-59 真机回归修复（2026-10-13，用户裁决）：**派发事实面是否确已工作过**。
  // 真机实证：本宿主（DSH 该版本/该装配）在会话内**不发生** `tools/execute` ⇒ `executed` 恒 false
  // ⇒ 若无条件早退，整个 PostToolUse 观测面（自察账本主通道 + 规格校验）静默全暗、零信号
  // （重启后两次确定失败调用零落账、环状态零更新）。故早退改为 **fail-open 条件**：只有事实面
  // 确已工作过（本进程内至少一次 `tools/execute`）才据其跳过未派发调用；事实面不可用时回落
  // 改动前行为（照常派发）——两害相权：宁可留 内部未决-60 的噪声洞，不可让观测面全暗。
  let dispatchFactSeen = false;
  // 内部未决-95（内部任务-48）：委派判据漂移可观测——origin 自证子代理而两深度源皆非法/缺失时，
  // 深度仍按 0（顶层）处理（语义零变化，plan-review D8：不引 origin 地板），但记一次性
  // 脱敏告警：此时「收窄静默退回批前行为」与「真顶层会话」同形，无告警则宿主契约漂移
  // （字段改名/变字符串/挪层级）不可判（活实例 2026-10-08 评审子代理）。去重键=会话 id、
  // 每会话一次；Set 放 apply 闭包而非模块顶层：本模块可被多次 apply（测试/重挂载），
  // 模块级 Set 会跨装载抑制后续会话的合法告警。判据收紧为「两源皆非安全整数」：显式
  // 合法 0 不算漂移（宿主明确置 0 是合法表达）。文案脱敏：只含会话 id（宿主自身标识，
  // 可与宿主日志关联），不含 prompt/路径/深度原始值。
  const delegationDriftWarned = new Set();
  const invalidTurnWarned = new Set();
  const stopCapabilityWarned = new Set();
  const warnDelegationDrift = (agent) => {
    // 防御姿态：不设整 body try/catch——函数体按构造不可抛（?. 链/isSafeInteger/Set 查加），
    // logWarn 内层自吞（log.mjs）、两调用点在 safe() 包裹内，三层取二已足（门②简洁性 S2-1）。
    if (agent?.session?.header?.origin !== 'subagent') return; // 顶层/未知 origin：不打扰
    const h = agent?.session?.header?.delegationDepth;
    const r = agent?.options?.subagentDepth;
    if (Number.isSafeInteger(h) || Number.isSafeInteger(r)) return; // 任一源有效：非漂移
    const sid = sessionIdOf(agent);
    if (sid !== '' && delegationDriftWarned.has(sid)) return;
    if (sid !== '') delegationDriftWarned.add(sid);
    logWarn(ctx.logger, `ai-coding-methodology: 委派深度判据漂移（OPEN-95）：会话 origin=subagent 但 delegationDepth 与 subagentDepth 均缺失或非法，按顶层（深度 0）处理、注入面未收窄；请核对宿主 SessionHeader 的委派字段是否漂移（session=${sid || '未知'}）`);
  };
  // 内部任务-273 H-08：受信根来源由 resolvePluginRoots 单点产出（装配层不得二次推断；正确性评审 round1 #2）。
  const rootSources = PLUGINS.filter((plugin) => rootSourcesMap[plugin] !== undefined).map((plugin) => `${plugin}:${rootSourcesMap[plugin]}`);
  logInfo(
    ctx.logger,
    `ai-coding-methodology: 已适配插件 ${Object.keys(roots).join(',') || '(无)'}；插件根来源 ${rootSources.join(',') || '(无)'}；注册事件 ${Object.keys(byEvent).join(',') || '(无)'}` +
      (missing.length > 0 ? `；未发现 ${missing.join(',')}（可用配置 pluginRoots 显式指定插件根）` : ''),
  );

  // 会话工作目录缓存：`agent/created` 与 `agent/pre-step` 都带 agent，先记下来，
  // 工具钩子（pre/post-execute）缺 agent 时复用（避免依赖宿主投影服务）。
  let lastCwd = typeof config.projectDir === 'string' && config.projectDir !== '' ? config.projectDir : process.cwd();
  const rememberCwd = (agent) => {
    const cwd = workdirOf(agent);
    if (cwd !== undefined) lastCwd = cwd;
    return lastCwd;
  };

  // 内部任务-273 M-05：注册 disposer 统一挂到插件生命周期（ctx.effect；测试替身无 effect 时 fail-open 跳过）。
  const keepDisposers = (disposers) => {
    if (disposers.length === 0) return;
    if (typeof ctx.effect !== 'function') return;
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 回收失败不阻断释放（fail-open） */
        }
      }
    });
  };

  // skill 面：动态探测 `skills` 服务，而不是写进 `inject`——写进 inject 会让本插件在
  // 没有 skill 注册表的宿主上整体不加载，等于用钩子面（纪律的实际承载）去换 skill 面。
  // 探测不到就少注册一面，两个面各自独立可用。
  const skillsService = resolveService(ctx, 'skills');
  if (skillsService !== undefined && typeof skillsService.register === 'function') {
    const collected = registrationStep('collectSkills', () => collectSkills(enabledRoots));
    const outcome = registerSkills(skillsService, collected.skills, ctx.logger);
    keepDisposers(outcome.disposers);
    logInfo(
      ctx.logger,
      `ai-coding-methodology: 注册 skill ${outcome.registered} 条（${Object.entries(collected.counts).map(([p, n]) => `${p}:${n}`).join(' ')}）` +
        (collected.skipped.length > 0 ? `；跳过 ${collected.skipped.length} 条（${collected.skipped.map((s) => `${s.plugin}/${s.dir}:${s.reason}`).join('；')}）` : ''),
    );
  } else {
    logInfo(ctx.logger, 'ai-coding-methodology: 宿主未提供 skills 服务，skill 面跳过（钩子面照常）');
  }

  // 命令面：同 skill 面一样动态探测（写进 inject 会让本插件在没有命令注册表的宿主上
  // 整体不加载）。ZCode 的命令是提示词展开，DSH 的命令面按设计不产生模型消息，故
  // 处理器用 `agent.followup` 把渲染后的正文作为下一轮提示词入队——与宿主自带
  // `/goal <objective>` 驱动 Goal Round 的同一 API（详见 commands-bridge.mjs 文件头）。
  const commandsService = resolveService(ctx, 'commands');
  if (commandsService !== undefined && typeof commandsService.register === 'function') {
    const collected = registrationStep('collectCommands', () => collectCommands(enabledRoots));
    const outcome = registerCommands(commandsService, collected.commands, { startTurn: config.startTurn !== false, logger: ctx.logger });
    keepDisposers(outcome.disposers);
    logInfo(
      ctx.logger,
      `ai-coding-methodology: 注册命令 ${outcome.registered} 条（${Object.entries(collected.counts).map(([p, n]) => `${p}:${n}`).join(' ')}）` +
        (collected.skipped.length > 0 ? `；跳过 ${collected.skipped.length} 条（${collected.skipped.map((s) => `${s.plugin}/${s.file}:${s.reason}`).join('；')}）` : ''),
    );
  } else {
    logInfo(ctx.logger, 'ai-coding-methodology: 宿主未提供 commands 服务，命令面跳过（钩子面与 skill 面照常）');
  }

  // agent 面（内部任务-308 / 内部未决-244 裁决 a）：保留 `Config.mountAgents` 键与默认 false 语义（schema
  // 结构不动），移除「尝试挂载 agent」调用面；开启时只在 apply 期打一条退役 info（不静默失效、
  // 不再有 0 挂载告警）。`agents-bridge` 的 `mountAgents` 导出与 `AGENT_FACE_UNAVAILABLE_REASON`
  // 常量保留只读（其他消费方/测试仍可引用），本层不再调用。
  if (config.mountAgents === true) {
    logInfo(
      ctx.logger,
      'ai-coding-methodology: agent 面已于 DEV-308 退役（宿主 0.2.1-rc.5 起由 Agent Preset 承载；本键仅兼容、恒不挂载），不再产生挂载日志/告警；重设计见 OPEN-244',
    );
  }

  /**
   * 跑一个事件上的全部匹配处理器。
   * @param {string} event 事件名
   * @param {string} subject matcher 主题（工具名；无 matcher 的事件传 ''）
   * @param {object} payload 钩子负载
   * @param {{cwd: string, signal?: AbortSignal}} opts
   * @returns {Promise<{decision: string, reason: string|undefined, additionalContext: string[], block: boolean}>}
   */
  async function dispatch(event, subject, payload, opts) {
    try {
      refreshHookDeclarationsIfChanged(); // 内部任务-285/内部模块-24 R-da-18：派发前声明源热加载（fail-open）
    } catch {
      /* 重读路径异常绝不阻断派发（runHookMain 同级 fail-open 姿态） */
    }
    const list = (byEvent[event] ?? []).filter((entry) => matchesMatcher(entry.handler.matcher, subject));
    if (list.length === 0) return { decision: 'none', reason: undefined, additionalContext: [], block: false };
    // 声明集按插件根记忆一次（门 B 回流：原实现每次派发每个处理器都重读重解析 manifest，落在热路径）
    const declaredCache = new Map();
    const declaredOf = (pluginRoot) => {
      if (!declaredCache.has(pluginRoot)) declaredCache.set(pluginRoot, declaredEventNames(pluginRoot));
      return declaredCache.get(pluginRoot);
    };
    const results = [];
    for (const [idx, entry] of list.entries()) {
      const env = {
        ...process.env,
        ZCODE_PLUGIN_ROOT: entry.pluginRoot,
        CLAUDE_PLUGIN_ROOT: entry.pluginRoot,
        ZCODE_PROJECT_DIR: opts.cwd,
        CLAUDE_PROJECT_DIR: opts.cwd,
        // 内部决策-063 修正案 1 决策 13（内部任务-192 P2）：运行观测能力域声明——钩子（session-start
        // 就绪面）读它判定「本宿主能力域是否已声明/是否降级」。取值是**声明形态短串**
        // （与镜像 `declarationGrammar` 同域），五态登记词表见 内部接口-1 能力登记表；
        // DSH 列事实以 内部接口-1/observation-capability-contract.json 为准（对拍测试把守）。
        WF_OBSERVATION_CAPABILITIES: JSON.stringify(DSH_OBSERVATION_CAPABILITIES),
      };
      // 内部任务-268/内部决策-068 决策 3：OS 监测关闭时仅对 team-governance SessionStart 处理器注入环境缝；
      // tgRoot 缺失（该插件未发现）或非该处理器一律不注入（合法组合零注入零告警）。
      // env 为普通对象字面量，属性赋值不存在构造异常面（不设 try/catch 死分支）。
      if (!osObservationEnabled && event === 'SessionStart' && entry.plugin === 'team-governance') {
        env.AI_CODING_OS_OBSERVE = '0';
      }
      const one = await runSingleHandler(
        ctx,
        entry.handler,
        payload,
        {
          cwd: opts.cwd,
          env,
          signal: opts.signal,
          // 内部决策-063 修正案 3 决策 23.1（内部任务-195）：派发失败上报缝——默认用 apply 级 reporter
          // （每会话同类至多一次）；调用方显式传入时优先（测试/上层装配可替换）。
          reportDispatchFailure: typeof opts.reportDispatchFailure === 'function' ? opts.reportDispatchFailure : reportDispatchFailure,
          // 内部任务-273 批次 B 评审：处理器身份（插件名＋**派发序位**：matcher 过滤后的派发列表下标，跨插件累计）——
          // 失败/超时日志据此可定位；不得用未替换的 `${PLUGIN_ROOT}` 原始命令行当唯一标识（跨插件会逐字相同）。
          label: `${entry.plugin}#${idx + 1}`,
        },
        event,
        // 允许表按 `entry.pluginRoot` **逐插件**计算（内部决策-037 批 2 步骤 5c；不做跨插件并集）
        { allowedEvents: declaredOf(entry.pluginRoot) },
      );
      results.push(...one);
    }
    const merged = mergeResults(results);
    return merged;
  }

  /**
   * 该调用是否**经过派发点**（宿主 `tools/execute` waterfall）——批 3 步骤 2 的事实面判据。
   * 非对象/未记录 ⇒ `false`（`WeakSet.has` 对非对象返回 false，不抛错）。
   * @param {WeakSet<object>} dispatched 已派发集合（`apply` 作用域内）
   * @param {unknown} exec 宿主执行对象
   * @returns {boolean} 是否已派发
   */
  function executedOf(dispatched, exec) {
    return exec !== null && typeof exec === 'object' && dispatched.has(exec);
  }

  /**
   * 给一个事件监听器套上「任何异常都不外溢」的兜底（fail-open，project-conventions 硬规则 4）。
   *
   * 为什么必须有这层：`runHandler` 只把 **shell.execute 之后** 的异常吞在里面；
   * `handlerCommandLine()`（读 handler.command/args）、`JSON.stringify(payload)`、
   * `ctx.get('shell')`、`mergeResults()` 都在它的 try 之外。而监听器是宿主在自己的
   * agent 生命周期里同步/异步调用的——任何漏网异常都会冒到宿主的 **agent 创建/步进**
   * 路径上，正好是"绝不阻断宿主轮次"承诺的反面。
   * `fallback` 是该事件的 fail-open 默认返回值（缺省「无意见」= undefined）。
   *
   * **五个事件全部没有宿主兜底（本机 0.1.7-rc.2 打包产物里逐点复核，2026-09-28 第 59 批）**
   * ——故本层 `safe()` 对五个事件都是**唯一防线**，不是"第二道"：
   * - `agent/created` → `dsh-agent/lib/index.js:579` `await this.ctx.serial(entry.carrier, …)`；
   * - `agent/turn-stopping` → `dsh-agent-loop/lib/index.js:984` `await this.dispatch.serial(…)`，
   *   且该 await 位于 **step 循环的 try 块内**，listener 失败会让整轮以错误收场；
   * - `agent/pre-step` → `dsh-agent-loop/lib/index.js:911` `await this.dispatch.waterfall(…)`；
   * - `tools/pre-execute` → `dsh-tools/lib/index.js:3225` `await this.ctx.waterfall(carrier, …)`；
   * - `tools/post-execute` → `dsh-tools/lib/index.js:3504` `await this.ctx.waterfall(scopeTarget(…), …)`。
   * cordis 的 `serial` 实现是 `for (…) { const result = await cb(...args) }`——**裸 await，
   * 零 try/catch**；`waterfall` 的 `next()` 也是 `return cb(...args)`。三条路径都没有
   * per-listener 兜底。宿主 `dispatch.js` 里 `emit` 分支那套 try/catch 属于**非否决型通知**
   * （源码自称 "Agent notifications are non-vetoing"，如 `agent/disposed`），**与本层这五个
   * 事件无关**——第 22 批曾误以为 `agent/created` 走 emit，第 23 批已更正；第 59 批进一步
   * **绕过转调层、直接查执行路径的调用点**，使结论不再依赖"`dispatch.js` 原样转调"这一环。
   * 注意 `emit` / `serial` / `waterfall` 是三种不同契约，归属必须去**实际分发那一行**核实
   * （行号随宿主版本变动，核对方法见设计文档 §8.47）。
   *
   * 另记一条源码核实（2026-09-28 第 18 批）：宿主 `AgentHandle` 的三个写入方法
   * `followup(input)` / `steer(input)` / `inject(input)` 都是**同步**的（源码
   * `dsh-agent-loop/lib/index.js`：三者都只是 `this.send(input, target, wakeup)`，
   * 而 `send` 内是 `inbox.splice(...)` + 可选 `wakeDriver(...)`，无 promise）。
   * 所以本层对它们用同步 try/catch 就是完备的、不存在 floating promise——但这也意味着
   * **同步抛错**是唯一的失败形态，必须兜住（下面三处调用点都已兜）。
   *
   * @param {string} event 事件名（仅用于告警文案）
   * @param {Function} listener 原始监听器
   * @param {Function|undefined} fallback 出错时的返回值（如 `() => next()` 的代理）
   * @returns {Function} 永不抛错的监听器
   */
  function safe(event, listener, fallback) {
    return async (...args) => {
      try {
        return await listener(...args);
      } catch (error) {
        logWarn(
          ctx.logger,
          `ai-coding-methodology: ${event} 处置未捕获异常，按无意见放行（fail-open）：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
        return typeof fallback === 'function' ? fallback(...args) : undefined;
      }
    };
  }

  // 内部任务-173：SessionStart additionalContext 的内存槽（sessionId → 文本）。created 只执行钩子、
  // 不再 agent.inject（durable next-step 会被桌面 hasDesktopActiveTasks 计为活动任务 → 空闲退出误报）。
  // 文本在首轮 pre-step 追加到 decision.messages；每 agent 生命周期一次。空 sid 会话钩子照跑但不写槽。
  const sessionStartPending = new Map();
  let sessionStartEmptySidWarned = false;

  if (byEvent.SessionStart) {
    ctx.on('agent/created', safe('SessionStart', async ({ agent, source, signal }) => {
      const cwd = rememberCwd(agent);
      const sid = sessionIdOf(agent);
      sessionStartPending.delete(sid); // created 是权威重置点（空串键也清；钩子失败也不留旧文本）
      const payload = buildPayload('SessionStart', { sessionId: sid, cwd, source });
      const merged = await dispatch('SessionStart', normalizeSessionSource(source), payload, { cwd, signal });
      const text = merged.additionalContext.join('\n\n');
      if (text === '') return;
      if (sid === '') {
        // 不可归属会话：钩子照跑（时机/预算不变），仅不写槽，防跨会话串投；一次性 warn（零静默失败）。
        if (!sessionStartEmptySidWarned) {
          sessionStartEmptySidWarned = true;
          logWarn(ctx.logger, 'ai-coding-methodology: SessionStart 钩子已执行但会话 id 缺失——文本不投递（不写槽，防跨会话串投）');
        }
        return;
      }
      sessionStartPending.set(sid, text);
    }, undefined));
  }

  if (longTaskDriver !== undefined) {
    // 内部决策-053 第一层：顶层会话**首轮 pre-step** 投递协议（追加到 messages，避免 agent/created 的
    // durable next-step 在空闲会话触发桌面 hasDesktopActiveTasks 误报）。委派跳过；每会话一次。
    // 注（内部任务-173）：SessionStart additionalContext 同批改走首轮 pre-step（见下方 SessionStartDelivery）。
    ctx.on('agent/pre-step', safe('LongTaskProtocol', async ({ agent }, next) => {
      const sid = sessionIdOf(agent);
      const downstream = await next();
      if (delegationDepthOf(agent) > 0 || longTaskProtocolSent.has(sid)) return downstream;
      if (planModeGate.isEngaged(agent)) return downstream;
      if (downstream?.kind !== 'enter') return downstream;
      longTaskProtocolSent.add(sid);
      try {
        return appendSelfMessage(downstream, longTaskDriver.protocolText());
      } catch (error) {
        longTaskWarn(sid, 'protocol', `ai-coding-methodology: 长任务协议投递失败：${String(error)}`);
        return downstream;
      }
    }, (_payload, next) => next()));
    // 人类提示：重置每人类轮预算/冷却并作废旧快照（驱动状态机内处理冻结键）；委派会话跳过。
    ctx.on('agent/pre-step', safe('LongTaskHumanReset', async ({ agent, messages }, next) => {
      if (delegationDepthOf(agent) > 0) return next();
      try {
        if (Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user')) longTaskDriver.onHumanPrompt(sessionIdOf(agent));
      } catch (error) {
        longTaskWarn(sessionIdOf(agent), 'reset', `ai-coding-methodology: 长任务人类重置失败：${String(error)}`);
      }
      return next();
    }, (_payload, next) => next()));
    // 观测成功 todo_write；仅在已派发调用上生效（与既有 PostToolUse 门控同口径）；委派会话跳过。
    ctx.on('tools/post-execute', safe('LongTaskObserve', async (exec, result, next) => {
      if (delegationDepthOf(exec?.agent) > 0) return next();
      try {
        if (!(dispatchFactSeen && !executedOf(dispatched, exec))) {
          longTaskDriver.observeTool({ sessionId: sessionIdOf(exec?.agent), toolName: String(exec?.name ?? ''), args: exec?.arguments, isError: result?.isError === true });
        }
      } catch (error) {
        longTaskWarn(sessionIdOf(exec?.agent), 'observe', `ai-coding-methodology: 长任务 todo 观测失败：${String(error)}`);
      }
      return next();
    }, (_exec, _result, next) => next()));
  }

  if (byEvent.UserPromptSubmit) {
    ctx.on('agent/pre-step', safe('UserPromptSubmit', async ({ agent, messages, signal }, next) => {
      if (!Array.isArray(messages) || messages.length === 0) return next();
      const cwd = rememberCwd(agent);
      const prompt = userPromptOf(messages);
      const payload = buildPayload('UserPromptSubmit', { sessionId: sessionIdOf(agent), cwd, prompt, delegationDepth: delegationDepthOf(agent), parentSessionId: parentSessionIdOf(agent) });
      warnDelegationDrift(agent);
      const merged = await dispatch('UserPromptSubmit', '', payload, { cwd, signal });
      // UserPromptSubmit 的阻断：宿主 `preStep` 对 `{kind:'reject'}` 原样返回，随后 step 循环
      // 置 `turnEnds = { kind: "blocked" }` 写进会话的 `turn/end` 事件——宿主在 kind 判定后**丢弃**
      // reject 上的其它字段（`dsh-agent-loop`：`if (decision.kind === "reject") { turnEnds = { kind: "blocked" }; … }`
      // → `session.append("turn/end", { reason: turnEnds })`），故 `reason` **不会**随 `turn/end` 落盘。
      // 本层仍带 `reason`：仅供适配层/调试消费（宿主忽略多余键），诊断走 `logWarn`；不得据此宣称会话记录可检索原因。
      // 注：ZCode 套件插件的 UserPromptSubmit **不产出 deny**（`user-prompt.mjs` 只注入
      // additionalContext，实测无 permissionDecision），故这是为将来/其他来源留的通路。
      if (merged.decision === 'deny') {
        return merged.reason !== undefined ? { kind: 'reject', reason: merged.reason } : { kind: 'reject' };
      }
      const downstream = await next();
      const text = merged.additionalContext.join('\n\n');
      if (text === '' || downstream?.kind !== 'enter') return downstream;
      return appendSelfMessage(downstream, text);
    }, (_payload, next) => next()));
  }

  // 内部任务-220：首轮桥接通道提示（模型面「本会话普通子代理可续」的当下事实＋通道政策）。
  // 注册位置：UserPromptSubmit 之后、SessionStartDelivery 之前 ⇒ 首轮序
  // [claimed, runtime-context, SessionStart, 桥接提示, UPS, 长任务协议]（waterfall 后注册者先 append）。
  // 门控全在 gate（depth=0/per-session 注册事实/未投递；isRegistered 抛错 fail-open 不消耗）；
  // 空 sid 不投且一次性 warn；构造/追加异常 fail-open 不消耗（下一轮可重试）；成功投递记 logInfo 供真机批复盘。
  ctx.on('agent/pre-step', (() => {
    const handler = safe('BridgeChannelHint', async ({ agent }, next) => {
      const downstream = await next();
      if (downstream?.kind !== 'enter') return downstream;
      const sid = sessionIdOf(agent);
      try {
        if (!bridgeHintGate.shouldInject(agent)) return downstream;
        const text = bridgeChannelHintText({ registeredTools: bridgeRegisteredSessions.get(sid) });
        if (text === '') return downstream;
        const nextDecision = appendSelfMessage(downstream, text);
        bridgeHintGate.markSent(sid);
        logInfo(ctx.logger, `ai-coding-methodology: 桥接通道提示已投递 session=${sid}`);
        return nextDecision;
      } catch (error) {
        logWarn(ctx.logger, `ai-coding-methodology: 桥接通道提示投递失败（fail-open，不消耗 once）：${error?.message ?? error}`);
        return downstream;
      }
    }, (_payload, next) => next());
    Object.defineProperty(handler, BRIDGE_HINT_LISTENER_TAG, { value: true });
    return handler;
  })());

  // 内部任务-173：SessionStart 文本投递监听器——**注册位置是语义的一部分**：waterfall 后注册者先 append，
  // 放在 UserPromptSubmit 之后 ⇒ 首轮序 [claimed（含用户消息）, runtime-context, SessionStart, 桥接通道提示, UPS, 长任务协议]
  // （内部任务-220 的 BridgeChannelHint 在本监听器之前注册 ⇒ 其提示位于 SessionStart 之后、UPS 之前）。
  // 不要上移到 LongTaskProtocol 之前（会把 SessionStart 推到协议之后）。
  if (byEvent.SessionStart) {
    ctx.on('agent/pre-step', safe('SessionStartDelivery', async ({ agent }, next) => {
      const sid = sessionIdOf(agent);
      const pending = sessionStartPending.get(sid);
      if (pending === undefined) return next(); // 无槽：纯直通（常见路径）
      const downstream = await next();
      if (downstream?.kind !== 'enter') return downstream; // reject：保留槽，下轮再投
      try {
        sessionStartPending.delete(sid); // 先删：失败不重试；宿主按 agent 串行（并发双投仅理论，见计划风险表）
        return appendSelfMessage(downstream, pending);
      } catch (error) {
        sessionStartPending.delete(sid); // fail-open：不无限重试
        logWarn(ctx.logger, `ai-coding-methodology: SessionStart 投递失败：${String(error)}`);
        return downstream;
      }
    }, (_payload, next) => next()));
  }

  if (byEvent.PreToolUse) {
    ctx.on('tools/pre-execute', safe('PreToolUse', async (exec, next) => {
      const cwd = rememberCwd(exec?.agent);
      const payload = buildPayload('PreToolUse', { sessionId: sessionIdOf(exec?.agent), cwd, toolName: exec?.name, toolInput: exec?.arguments, callId: exec?.callId });
      const merged = await dispatch('PreToolUse', String(exec?.name ?? ''), payload, { cwd, signal: exec?.signal });
      if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' };
      if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) };
      // 内部未决-115（内部任务-167，内部决策-032 2026-10-20 关联注记）：allow 档 reason 合成模型可见上下文。
      // 只消费既有 reason（team-governance 的 systemMessage 折入）；不改 decode/merge 语义。
      if (merged.decision === 'allow' && merged.reason !== undefined) {
        const sid = sessionIdOf(exec?.agent);
        const inject = exec?.agent?.inject;
        if (sid === '' || typeof inject !== 'function') {
          const warnKey = sid === '' ? '<unknown>' : sid;
          if (!allowAdvisoryWarned.has(warnKey)) {
            allowAdvisoryWarned.add(warnKey);
            logWarn(ctx.logger, 'ai-coding-methodology: PreToolUse allow 提醒无可注入的 agent.inject（会话不可归属或宿主未提供 inject），该会话内仅提示一次');
          }
        } else {
          const plan = allowAdvisory.request(sid, merged.reason);
          if (plan !== undefined) {
            try {
              inject.call(exec.agent, contextMessage(plan.text));
              plan.commit();
            } catch (error) {
              logWarn(ctx.logger, `ai-coding-methodology: PreToolUse allow 提醒注入失败：${String(error)}`);
            }
          }
        }
      }
      return next();
    }, (_exec, next) => next()));
  }

  if (byEvent.PostToolUse) {
    // 批 3 步骤 2（内部创意-INCIDENT-DESIGN-1，裁决 A′）：**派发事实**面。
    // 宿主 `tools/execute` waterfall（dsh-tools :3331）**只在 dispatch 分支可达**；未派发的四类
    // （审批拒绝/auto-review 拒绝/护栏 deny/取消）虽仍走 `tools/post-execute`，却从不经过该点 ⇒
    // 以"是否经过本监听"作为"调用是否真的被派发"的事实面（判据零文本、不依赖错误码）。
    // 门控在 byEvent.PostToolUse 内：PostToolUse 未声明时既不注册（保持 listeners.size 断言语义），
    // 也不需要该标记。
    // **fallback 必须有（阶段门① F-1）**：cordis `waterfall` 里"没调用 `next()` 的 listener 会否决
    // 整条链（含内建行为）"——`safe()` 未传 fallback 时 catch 返回 `undefined` ⇒ 工具体根本不执行
    // （等于本层阻断了宿主工具）。同文件另两处 waterfall 注册（`:669`/`:680`/`:724`）都带 fallback。
    ctx.on('tools/execute', safe('tools/execute', async (exec, next) => {
      if (exec !== null && typeof exec === 'object') {
        dispatched.add(exec);
        dispatchFactSeen = true; // 事实面确已工作过的唯一证据（fail-open 守卫的判据，见下方 post-execute）
      }
      return next();
    }, (_exec, next) => next()));
    ctx.on('tools/post-execute', safe('PostToolUse', async (exec, result, next) => {
      const executed = executedOf(dispatched, exec);
      // 内部任务-59（内部未决-60）：未派发的调用层拒绝（审批拒绝 / auto-review 拒绝 / 护栏 deny / 取消）
      // 在 ZCode 侧**不产生** PostToolUse/PostToolUseFailure 事件（被拦下的调用不落 PostToolUse），
      // 而 DSH 宿主仍会把它们走到本扩展点 ⇒ 本层按 ZCode 语义对齐：**不派发任何钩子**。
      // 为什么必须如此（而非只抑制失败位）：核心件 `post-tool.mjs` 的重试环推进**先于**失败分类
      // 且不受失败位门控，未派发调用重复 ≥3 次/5 分钟即落 `retry-loop` 行（催办噪声）；同参数自愈
      // 通道也会被未派发调用误收口真失败记录。故门控面只能落在派发前（内部未决-60 的登记方向）。
      // 「全暗」哨兵：派发判据押在 `exec` 对象身份（WeakSet）上，宿主契约漂移会让整个 PostToolUse
      // 观测面静默全暗、零信号——按会话计数，事件 ≥3 而命中 0 时记一次性告警（镜像
      // `delegationDriftWarned` 先例；`sid` 为空串时按同一桶计数，仍至多告警一次）。
      // 文案按「事实面是否工作过」二分：从未工作 ⇒ 宿主根本不发生 `tools/execute`（本层已按
      // fail-open 照常派发，但 ORDER-60 的门控失效）；工作过 ⇒ 判据本身漂移（例如对象身份不一致）。
      const postSid = sessionIdOf(exec?.agent);
      const stat = postExecuteStats.get(postSid) ?? { total: 0, executed: 0 };
      stat.total += 1;
      if (executed) stat.executed += 1;
      postExecuteStats.set(postSid, stat);
      if (stat.total >= 3 && stat.executed === 0 && !allDarkWarned.has(postSid)) {
        allDarkWarned.add(postSid);
        logWarn(
          ctx.logger,
          dispatchFactSeen
            ? `ai-coding-methodology: PostToolUse 派发判据疑似失效——会话 ${postSid || '未知'} 的 post-execute 事件已 ${stat.total} 次、经派发点（tools/execute）命中 0 次，本层可能整体未派发钩子（自察观测面全暗）；请核对宿主 tools/execute 契约`
            : `ai-coding-methodology: 宿主未发生 tools/execute——会话 ${postSid || '未知'} 的 post-execute 事件已 ${stat.total} 次而派发事实面零命中；本层已按 fail-open 照常派发钩子（观测面不暗），但 OPEN-60 的未派发门控在此宿主不生效；请核对宿主 tools/execute 契约`,
        );
        // 内部决策-063 D8.3（内部任务-192 P2）：除宿主日志的 logWarn 外，经 内部接口-26 `emit` 上报一条
        // `observation-degraded`（每会话至多一次＝本分支的 allDarkWarned 已去重；含能力缺口与
        // 计数摘要、不含原文）；emit 失败 fail-open（写兜底旁路，不阻断下方钩子派发）。
        // 不设 try/catch：`emitFact` 契约是永不抛错（内部全捕获），此处加壳只增噪声。
        observationEmit.emitFact(
          buildObservationDegradedFact({ sessionId: postSid, count: stat.total, dispatchFactSeen }),
          { projectRoot: rememberCwd(exec?.agent) },
        );
      }
      // 内部任务-59 真机回归修复：仅在事实面确已工作过时才据它早退（fail-open 方向见闭包顶部注释）。
      if (!executed && dispatchFactSeen) return next();
      const cwd = rememberCwd(exec?.agent);
      // 内部任务-273 H-01：事实面三态。事实面**从未工作**（宿主不发 tools/execute 的 fail-open 场景）时
      // 不能标 `not-dispatched`——那会让核心件在环推进/失败分类/落账前短路（内部任务-59 的观测面全暗回归）。
      // 该场景按 unknown 处理：省略 `dispatch_fact` 键，且失败位按「事实面不可判定 ⇒ 照常透传」回退。
      const trusted = dispatchFactSeen;
      // 失败位可透传门（内部任务-273 H-01；三键同门）：事实面已工作 ⇒ 仅已派发透传；事实面从未工作 ⇒ 照常透传。
      const failureGate = !trusted || executed;
      // R-da-16 ①（内部决策-063 D5.3）：委派维只对**委派会话**产键——`delegationDepth` 与
      // `parentSessionId` 成对出现，条件＝depth>0 且父会话 id 为非空字符串（顶层会话零键；
      // 不以 null/空串占位）。供 内部模块-15 记录归因（post-tool 读 `delegation_depth`/`parent_session_id`）。
      const execDepth = delegationDepthOf(exec?.agent);
      const execParent = parentSessionIdOf(exec?.agent);
      const delegated = execDepth > 0 && execParent !== null;
      const payload = buildPayload('PostToolUse', {
        sessionId: sessionIdOf(exec?.agent),
        cwd,
        toolName: exec?.name,
        toolInput: exec?.arguments,
        callId: exec?.callId,
        resultContent: result?.content,
        delegationDepth: delegated ? execDepth : undefined,
        parentSessionId: delegated ? execParent : undefined,
        // 内部决策-063 D5（内部任务-192 P2）+ 内部任务-273 H-01：派发事实**两态**——`dispatched`＝确经宿主派发点
        // （`tools/execute`）；事实面从未工作＝**不产键**（unknown，核心件按 fail-open 照常观测落账）。
        // `not-dispatched` 原为计划三态之一，但 内部任务-59 的早退（`!executed && trusted`）在构造负载前
        // 直接返回，该值不可达（收尾正确性评审指出）；按两态如实收口，早退路径由核心件自行短路。
        dispatchFact: executed ? 'dispatched' : undefined,
        // 内部未决-46：宿主 `ToolExecutionResult` 无顶层 exitCode；真退出码在 `result.value.exitCode`
        // （终端工具的 canonical*Result），失败事实在 `result.isError`（edit/read 等非终端工具
        // 的失败只走这条）。二者进负载后由 `post-tool.mjs` 的结构化判据消费。
        // **批 3 步骤 2 + 内部任务-273 H-01**：确经派发 ⇒ 仅已派发调用透传失败位（未派发者不产生
        // 结构化失败事实）；事实面**从未工作**（fail-open）⇒ 按 unknown 回退为照常透传。
        exitCode: failureGate && Number.isFinite(result?.value?.exitCode) ? result.value.exitCode : undefined,
        isError: failureGate && result?.isError === true,
        // 内部任务-20 B/F3（内部决策-033 修正案 1）：宿主结构化错误码**载体键**＝`result.error.info.code`
        // （宿主 `ToolExecutionFailure.error: ToolFailure{message, info?: ToolErrorInfo{name, code, reason?}}`；
        // 取证见 内部证据 §1）。失败分支 fail-closed：`error` 非对象 /
        // `info` 缺失 / `code` 非字符串或空串 ⇒ **不产键**（绝不伪造、绝不从 content 文案抠取）；
        // 透传门与 exitCode/isError 同门（含 内部任务-273 H-01 的 fail-open 回退）；形态判定不在此层（核心件单点收口）。
        errorCode:
          failureGate && typeof result?.error?.info?.code === 'string' && result.error.info.code !== ''
            ? result.error.info.code
            : undefined,
      });
      const merged = await dispatch('PostToolUse', String(exec?.name ?? ''), payload, { cwd, signal: exec?.signal });
      const text = merged.additionalContext.join('\n\n');
      if (merged.decision === 'deny') {
        return {
          kind: 'block',
          feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
          ...(text !== '' ? { additionalContexts: [contextMessage(text)] } : {}),
        };
      }
      const downstream = await next();
      if (text === '') return downstream;
      return { ...downstream, additionalContexts: [contextMessage(text), ...(downstream?.additionalContexts ?? [])] };
    }, (_exec, _result, next) => next()));
  }

  // 内部任务-273 步骤12（S-01）：goal 让位三态探针单源——Stop 主路径与 LongTaskStop 回退共用同一实现。
  const resolveGoalGate = (agent) => {
    if (longTaskDriver === undefined) return { active: false, unknown: false };
    if (typeof goalsService.get !== 'function') return { active: false, unknown: true };
    try {
      const ownership = goalOwnsContinuation(goalsService.get(agent));
      if (ownership === GOAL_OWNERSHIP.UNKNOWN) {
        longTaskWarn(sessionIdOf(agent), 'goal', 'ai-coding-methodology: 长任务 goal 视图形态不可判定（phase 缺失/非字符串）——按让位处理');
        return { active: false, unknown: true };
      }
      return { active: ownership === GOAL_OWNERSHIP.OWNS, unknown: false };
    } catch (error) {
      longTaskWarn(sessionIdOf(agent), 'goal', `ai-coding-methodology: 长任务 goal 判定失败：${String(error)}`);
      return { active: false, unknown: true };
    }
  };

  if (byEvent.Stop) {
    ctx.on('agent/turn-stopping', safe('Stop', async ({ agent, turn, signal }) => {
      if (signal?.aborted) return;
      if (turn !== undefined && turnIdOf(turn) === undefined) {
        const sid = sessionIdOf(agent);
        if (sid !== '' && !invalidTurnWarned.has(sid)) {
          invalidTurnWarned.add(sid);
          logWarn(ctx.logger, 'ai-coding-methodology: agent/turn-stopping 的 turn 非法（非正整数）——turnId 不产键、task-recap 退回 60s 时间窗（疑似宿主契约漂移）');
        }
      }
      const cwd = rememberCwd(agent);
      const payload = buildPayload('Stop', { sessionId: sessionIdOf(agent), cwd, delegationDepth: delegationDepthOf(agent), turnId: turnIdOf(turn) });
      warnDelegationDrift(agent);
      const merged = await dispatch('Stop', '', payload, { cwd, signal });
      if (signal?.aborted) return;
      const text = merged.additionalContext.join('\n\n');
      const blocked = merged.decision === 'deny' || merged.block;
      const depth = delegationDepthOf(agent);
      let goalActive = false;
      let goalUnknown = false;
      if (depth === 0) {
        // 内部任务-273 H-04/S-01：三态判据与 LongTaskStop 同源。
        const gate = resolveGoalGate(agent);
        goalActive = gate.active;
        goalUnknown = gate.unknown;
      }
      if (!blocked && !goalActive && !goalUnknown && !signal?.aborted && longTaskDriver !== undefined && !planModeGate.isEngaged(agent)) {
        const plan = longTaskDriver.shouldSteer({ sessionId: sessionIdOf(agent), delegationDepth: depth });
        if (plan !== undefined) {
          if (typeof agent?.steer !== 'function') {
            longTaskWarn(sessionIdOf(agent), 'steer-missing', 'ai-coding-methodology: 长任务无可用的 agent.steer，跳过且不 commit');
          } else {
            try {
              agent.steer(contextMessage(plan.text));
              plan.commit();
            } catch (error) {
              longTaskWarn(sessionIdOf(agent), 'steer', `ai-coding-methodology: 长任务续跑失败：${String(error)}`);
            }
          }
        }
      }
      const stopCapabilityWarn = (method) => {
        const sid = sessionIdOf(agent);
        const key = `${sid}:${method}`;
        if (stopCapabilityWarned.has(key)) return;
        stopCapabilityWarned.add(key);
        logWarn(ctx.logger, `ai-coding-methodology: Stop 处置缺能力——agent.${method} 不可用（会话 ${sid || '未知'}，该通道本会话仅提示一次）`);
      };
      try {
        if (blocked) {
          const parts = [merged.reason, text].filter((p) => typeof p === 'string' && p !== '');
          if (typeof agent?.steer !== 'function') stopCapabilityWarn('steer');
          else agent.steer(contextMessage(parts.length > 0 ? parts.join('\n\n') : 'continue: blocked by Stop hook'));
        } else if (text !== '') {
          if (typeof agent?.inject !== 'function') stopCapabilityWarn('inject');
          else agent.inject(contextMessage(text));
        }
      } catch (error) {
        logWarn(ctx.logger, `ai-coding-methodology: Stop 处置失败：${String(error)}`);
      }
    }, undefined));
  }

  if (!byEvent.Stop && longTaskDriver !== undefined) {
    // 无 Stop 钩子的部署：驱动层只做 goal 让位 + 清单续跑（无钩子阻断面）。
    ctx.on('agent/turn-stopping', safe('LongTaskStop', async ({ agent, signal }) => {
      if (signal?.aborted) return;
      const depth = delegationDepthOf(agent);
      // 仅顶层会话受 goal 让位影响（子 agent 的 goal 视图不参与续跑判定；driver 亦只对 depth 0 生效）。
      const gate = depth === 0 ? resolveGoalGate(agent) : { active: false, unknown: false };
      const goalActive = gate.active;
      const goalUnknown = gate.unknown;
      if (goalActive || goalUnknown || signal?.aborted || planModeGate.isEngaged(agent)) return;
      const plan = longTaskDriver.shouldSteer({ sessionId: sessionIdOf(agent), delegationDepth: depth });
      if (plan !== undefined) {
        if (typeof agent?.steer !== 'function') {
          longTaskWarn(sessionIdOf(agent), 'steer-missing', 'ai-coding-methodology: 长任务无可用的 agent.steer，跳过且不 commit');
        } else {
          try {
            agent.steer(contextMessage(plan.text));
            plan.commit();
          } catch (error) {
            longTaskWarn(sessionIdOf(agent), 'steer', `ai-coding-methodology: 长任务续跑失败：${String(error)}`);
          }
        }
      }
    }));
  }
  APPLIED_CONTEXTS.add(ctx);
}