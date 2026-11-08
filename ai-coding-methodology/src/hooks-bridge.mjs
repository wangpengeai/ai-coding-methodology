// 文件：hooks-bridge.mjs
// 描述：DSH 宿主适配核心——把六插件的**中立清单**（`plugin.manifest.json`，内部决策-036）声明
//       翻译到 DeepSeek Harness 的拦截扩展点。设计约束（内部决策-032）：ZCode 侧资产
//       （plugin.json / hooks.json / 钩子脚本）**零改动**，兼容逻辑只存在于本适配层。
//       **声明源换源（2026-10-01，内部决策-036 决策 6 / 内部接口-1 §1 期二）**：中立清单是唯一
//       手工编辑面，`.zcode-plugin/plugin.json` 与 `hooks/hooks.json` 是它的物化生成物；
//       本层读中立源，仅当插件树没有可用中立清单（0.6.0 前的装机副本 / 仅 ZCode 形态的树）
//       才回落读生成物——回落面是兼容桥，不是第二事实源。
//       职责分四段，全部为可独立测试的纯函数 + 一个注册函数：
//         ① discover：从中立清单读出事件 → 处理器，解析 matcher 与超时（回落形态为 `hooks.json`）；
//         ② payload：构造既有钩子脚本消费的负载（camelCase 信封，与 ZCode 同形）；
//         ③ codec：翻译钩子进程结果（退出码 + stdout JSON 信封）为 DSH 决策；
//         ④ apply：注册 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop。
//       为什么自建而不用 @deepseek-ai/dsh-hooks-claude-code 桥：两处形态不可弥合——
//       ZCode 处理器用 `command` + `args` 数组（桥只认单个 `command` 字符串），且
//       ZCode 的 deny 语义是「stdout 信封 + 退出码 2」，桥在退出码 2 分支只读 stderr、
//       丢弃 stdout（deny 文案会退化为默认串）；另外 DSH 工具名（pwsh/edit/write）
//       与 ZCode matcher 词表（Bash/Edit/Write）不同，需按工具名归一。以上三点都在本
//       层处置，不动上游桥、不改 ZCode 声明。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { logWarn, logInfo } from './log.mjs';
import { getEngine } from './engine-binding.mjs';

/**
 * 适配层派发钩子时请求的沙箱策略（R-hooks-2，2026-09-29 T1 实证的必要条件）。
 *
 * 为什么必须显式覆盖：宿主 `shell` 的默认策略是**部署策略**（`@deepseek-ai/dsh-pwsh-sandbox`
 * 里 `sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`），其
 * `workspaceRoot` 是**应用 cwd**（装机态实测 `~/.dsh/profiles/<profile>`）——本层派生的钩子
 * 子进程因此**能读不能写**该根之外，而 ZCode 侧钩子都要写 `~/.zcode/cli/routing-state`（挑战、
 * 租约指针、环状态、收尾去重）；写失败被各钩子自身的 fail-open 陷阱吞掉，表现为**静默无输出**
 * （实测：`user-prompt.mjs`/`post-tool.mjs` exit 0、stdout/stderr 皆空、状态目录零写入，而唯一
 * 零写入的 `session-start.mjs` 正常）。
 *
 * 取值理由与边界（2026-09-29 阶段评审 S-1/S-2 精确化）：①**提升的是整个子进程树**（钩子本体及其
 * 派生的 `git`/`node` 等）——这些子进程可写一切"当前用户可写"的路径，不只是 `routing-state`；
 * ②"受信"的依据不是"脚本在仓内"，而是**派发面被钉死**：本层只从 `PLUGINS` 四个固定插件名解析出的
 * 根（`resolvePluginRoots` 三来源：显式 `pluginRoots` / 同级发现 / ZCode 安装记录）读声明——其中
 * 显式 `pluginRoots` 由操作方配置（写 profile 补丁即可指向任意目录），故受信边界＝**四个固定插件名
 * ＋操作方显式配置的根**（override 属操作方受信面），本层不主动接纳市场/第三方任意 hooks 目录；
 * ③**被否决的更窄路线**——`{mode:'workspace-write', workspaceRoot:<家目录>}` 会排除
 * 项目盘写入并重新引入受限令牌；"跟随会话策略"在宿主上不可行（`resolve()` 要 session 对象，本层只
 * `inject: ['shell']`、派发侧只有 sessionId 字符串，且 root shell 的**部署策略**与会话策略不是同一
 * 来源——本装机部署 `mode` 实测 `workspace-write`、会话档实测 `danger-full-access`——照搬部署策略会原样
 * 复现本 bug）。④该覆盖只作用于本层派发的钩子子进程（全仓唯一 `shell.execute` 调用点），策略按
 * per-call spec 盖章，不改变其他调用方。回滚 = 去掉本字段（恢复宿主部署策略）。
 */
export const HOOK_SANDBOX_POLICY = Object.freeze({ mode: 'danger-full-access' });

/** 适配层支持的事件子集（与 内部接口-1 事件表一一对应）。 */
export const SUPPORTED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

/** 钩子默认超时（毫秒）——与 ZCode 声明缺省同量级，远小于桥的 10 分钟默认值。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 单次执行输出上限（字符）——防跑飞的钩子把宿主内存吃掉。 */
export const OUTPUT_MAX_CHARS = 1_000_000;

/**
 * ZCode matcher 词表 → DSH 工具名词表（**引擎驱动**，内部决策-037 批 2 步骤 4）。
 * 词表与展开规则的单源在 `plugin-core/degradation-rules.json` 的 `tool-vocab-map` 规则
 * （`params.dsh`）；本层只转发，不再持有 `TOOL_ALIASES`（旧实现已随接线删除）。
 * 注册期调用：`applied:false`（宿主无 params 条目＝数据漂移）即具名抛错（响亮失败，不静默放宽护栏）。
 * @param {unknown} matcher 原始 matcher（可缺省／空串／'*'）
 * @returns {string|undefined} 展开后的 matcher；缺省或不可用时返回 undefined
 */
export function normalizeMatcher(matcher) {
  const outcome = getEngine().applyRule('tool-vocab-map', 'dsh', { matcher });
  if (outcome.applied !== true) {
    throw new Error('hooks-bridge: 规则库字段契约漂移（tool-vocab-map 缺 params.dsh）——拒载而非静默放宽护栏');
  }
  return outcome.result;
}

/** 中立清单文件名——期二换源后六插件声明的**唯一手工编辑面**（内部决策-036）。 */
export const MANIFEST_FILE = 'plugin.manifest.json';

/** ZCode 形态钩子声明的相对路径（兼容回落面：0.6.0 前装机副本与仅 ZCode 形态的树）。 */
const ZCODE_HOOKS_REL = ['hooks', 'hooks.json'];

/**
 * 声明源签名（内部模块-24 R-da-18 / 内部任务-285，内部决策-066 修正案 1 配套）：`mtimeMs:size`，中立清单
 * 优先、无清单回落 `hooks/hooks.json`、双缺 `null`。**只 stat 不读取/不解析内容**——坏 JSON
 * 仍产出签名（由重读环节诊断），且热加载比对路径不做解析以免为此引入第二声明读取面。
 * @param {string} pluginRoot 插件根目录
 * @returns {string|null} 签名；两来源皆不可 stat 时 null（调用方按无变化处理）
 */
export function declarationSignature(pluginRoot) {
  for (const rel of [[MANIFEST_FILE], ZCODE_HOOKS_REL]) {
    try {
      const st = statSync(join(pluginRoot, ...rel));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      /* 该来源缺席/不可读：试下一候选 */
    }
  }
  return null;
}

/**
 * 归一一条 `type: 'process'` 声明为处理器（中立形态与 ZCode 形态共用同一套判据）。
 * @param {unknown} item 声明条目
 * @param {string|undefined} matcher 已按宿主词表归一的 matcher
 * @returns {{command: string, args: string[], timeoutMs: number, matcher: string|undefined, statusMessage: string}|null} 不可用时 null
 */
function toHandler(item, matcher, diag = null) {
  const h = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!h) { diag?.dropped?.push({ reason: 'not-object' }); return null; }
  if (typeof h.type === 'string' && h.type !== 'process') { diag?.dropped?.push({ reason: 'type-not-process', event: h.event }); return null; }
  if (typeof h.command !== 'string' || h.command === '') { diag?.dropped?.push({ reason: 'empty-command', event: h.event }); return null; }
  const args = Array.isArray(h.args) ? h.args.filter((a) => typeof a === 'string') : [];
  const timeoutMs = Number.isFinite(h.timeoutMs) && h.timeoutMs > 0 ? h.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    command: h.command,
    args,
    timeoutMs,
    matcher,
    statusMessage: typeof h.statusMessage === 'string' ? h.statusMessage : '',
  };
}

/**
 * 从插件**中立清单**（`plugin.manifest.json`）读出事件 → 处理器清单（期二换源，内部决策-036）。
 *
 * 形态差异（与 ZCode 形态的唯一区别）：中立声明是**扁平列表**，每条自带 `event` 与可选
 * `matcher`；ZCode 生成物是 `事件 → 组 → 处理器` 的信封。两者的 matcher / 超时 / 忽略规则
 * 完全同语义（不支持的宿主事件、非 process、缺 command 一律跳过）。
 *
 * 返回值两态（这是"单一事实源"的机检面）：
 * - `null`＝**无可用中立源**（文件缺失 / JSON 损坏 / 顶层非对象）⇒ 调用方回落 ZCode 生成物；
 * - 对象＝中立源权威（含 `{}`＝该插件在钩子面零声明，此时**不再看生成物**——否则清单里删掉的
 *   钩子会被旧生成物"复活"，恰好是本期换源要消灭的漂移形态）。
 * @param {string} pluginRoot 插件根目录
 * @param {{declared?: number, dropped?: Array<{reason: string, event?: unknown}>, unreadable?: string|null}} [diag] 可选诊断收集器（不改变返回值；内部任务-272）
 * @returns {Record<string, {command: string, args: string[], timeoutMs: number, matcher: string|undefined, statusMessage: string}[]>|null} 无中立源时 null
 */
export function readManifestHookConfig(pluginRoot, diag = null) {
  let raw;
  try { raw = readFileSync(join(pluginRoot, MANIFEST_FILE), 'utf8'); }
  catch (error) {
    // 中立清单缺席＝旧装机副本的合法回落路径（不告警）；文件存在但不可读才诊断。
    if (error && error.code === 'ENOENT') return null;
    if (diag) diag.unreadable = 'manifest';
    return null;
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { if (diag) diag.unreadable = 'manifest'; return null; }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) { if (diag) diag.unreadable = 'manifest'; return null; }
  // 内部未决-276（内部任务-308）：`hooks` 非数组＝声明形态非法——不得静默按零声明处理（会掩盖坏清单）。
  // 记诊断后仍按权威零声明 `{}` 返回（不回退生成物，避免复活已撤销钩子；坏清单修复后 mtime 变化触发重载）。
  if (manifest.hooks !== undefined && !Array.isArray(manifest.hooks)) {
    diag?.dropped?.push({ reason: 'hooks-not-array' });
    if (diag) diag.declared = 0;
    return {};
  }
  const declared = manifest.hooks ?? [];
  if (diag) diag.declared = declared.length;
  const grouped = {};
  for (const item of declared) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
    if (!entry) { diag?.dropped?.push({ reason: 'not-object' }); continue; }
    if (!SUPPORTED_EVENTS.includes(entry.event)) { diag?.dropped?.push({ reason: 'event-unsupported', event: entry.event }); continue; }
    const handler = toHandler(entry, normalizeMatcher(entry.matcher), diag);
    if (handler === null) continue;
    (grouped[entry.event] ??= []).push(handler);
  }
  const out = {};
  for (const event of SUPPORTED_EVENTS) if (grouped[event]) out[event] = grouped[event];
  return out;
}

/**
 * 从插件根的 ZCode 形态生成物 `hooks/hooks.json` 读出事件 → 处理器清单（**兼容回落面**）。
 * 与 ZCode 同语义地忽略：不支持的事件、非 process 类型处理器、缺 command 的条目、
 * 空组的 matcher。解析失败返回空对象（fail-open：适配层不能因声明损坏挡住会话）。
 * @param {string} pluginRoot 插件根目录
 * @param {{declared?: number, dropped?: Array<{reason: string, event?: unknown}>, unreadable?: string|null}} [diag] 可选诊断收集器（不改变返回值；内部任务-272）
 * @returns {Record<string, {command: string, args: string[], timeoutMs: number, matcher: string|undefined, statusMessage: string}[]>}
 */
export function readZcodeHookConfig(pluginRoot, diag = null) {
  let text;
  try { text = readFileSync(join(pluginRoot, ...ZCODE_HOOKS_REL), 'utf8'); }
  catch (error) {
    // 回落生成物缺席＝零钩子插件的合法形态（不告警）；存在但不可读才诊断。
    if (error && error.code === 'ENOENT') return {};
    if (diag) diag.unreadable = 'zcode';
    return {};
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch { if (diag) diag.unreadable = 'zcode'; return {}; }
  const map = raw && typeof raw === 'object' ? raw.hooks : undefined;
  if (!map || typeof map !== 'object') { if (diag) diag.unreadable = 'zcode'; return {}; }
  if (diag) {
    let declared = 0;
    for (const groups of Object.values(map)) if (Array.isArray(groups)) for (const g of groups) if (g && Array.isArray(g.hooks)) declared += g.hooks.length;
    diag.declared = declared;
    for (const event of Object.keys(map)) if (!SUPPORTED_EVENTS.includes(event)) diag.dropped.push({ reason: 'event-unsupported', event });
  }
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const event of SUPPORTED_EVENTS) {
    const groups = Array.isArray(map[event]) ? map[event] : [];
    const handlers = [];
    for (const group of groups) {
      const g = group && typeof group === 'object' ? group : null;
      if (!g || !Array.isArray(g.hooks)) continue;
      const matcher = normalizeMatcher(g.matcher);
      for (const item of g.hooks) {
        const handler = toHandler(item, matcher, diag);
        if (handler !== null) handlers.push(handler);
      }
    }
    if (handlers.length > 0) out[event] = handlers;
  }
  return out;
}

/**
 * 读取一个插件的钩子声明并解析为事件 → 处理器清单（中立源优先，生成物仅作回落）。
 * S-04（内部未决-245）：本函数**不再手写第二份「manifest 优先」回落策略**——委托诊断读法取 `config`，
 * 与生产链路（`apply` → `index.collectHandlers` → `readHookConfigWithDiagnostics`）同一实现。
 * 保留公开导出（`package.json` 的 `./hooks-bridge` 子路径可达、测试免诊断读面）：生产零调用但
 * 语义零策略、不可漂移；若未来要求「导出必须被生产调用」，删名改测面即可（见 内部任务-340 计划设计面核验）。
 * @param {string} pluginRoot 插件根目录
 * @returns {Record<string, {command: string, args: string[], timeoutMs: number, matcher: string|undefined, statusMessage: string}[]>}
 */
export function readHookConfig(pluginRoot) {
  return readHookConfigWithDiagnostics(pluginRoot).config;
}

/** 统计事件→处理器清单的总处理器数。 */
function countHandlers(config) {
  let n = 0;
  for (const handlers of Object.values(config)) n += handlers.length;
  return n;
}

/**
 * 读取一个插件的钩子声明并附带诊断（内部任务-272 内部未决-238）：config 为最终解析值
 * （中立源优先，无中立源时回落 ZCode 生成物；两者均不可用为零声明 {}），
 * unreadable 记录不可读来源，dropped 记录被丢弃条目及原因（不改变 fail-open 语义）。
 * @param {string} pluginRoot 插件根目录
 * @returns {{config: Record<string, any[]>, source: 'manifest'|'zcode', declared: number, kept: number, dropped: Array<{reason: string, event?: unknown}>, unreadable: Record<string,string>}}
 */
export function readHookConfigWithDiagnostics(pluginRoot) {
  const mDiag = { declared: 0, dropped: [], unreadable: null };
  const neutral = readManifestHookConfig(pluginRoot, mDiag);
  if (neutral !== null) {
    return { config: neutral, source: 'manifest', declared: mDiag.declared, kept: countHandlers(neutral), dropped: mDiag.dropped, unreadable: mDiag.unreadable ? { manifest: mDiag.unreadable } : {} };
  }
  const zDiag = { declared: 0, dropped: [], unreadable: null };
  const config = readZcodeHookConfig(pluginRoot, zDiag);
  const unreadable = {};
  if (mDiag.unreadable) unreadable.manifest = mDiag.unreadable;
  if (zDiag.unreadable) unreadable.zcode = zDiag.unreadable;
  return { config, source: 'zcode', declared: zDiag.declared, kept: countHandlers(config), dropped: zDiag.dropped, unreadable };
}

/**
 * 声明诊断分类告警（内部任务-272 内部未决-238）：不可读/丢条目 ⇒ warn；合法零声明/仅不支持事件 ⇒ info。
 * S-04（内部未决-245）：装配器单源在 `index.collectHandlers`（本模块只负责声明读取与诊断分类）；
 * `plugins` 即该装配器返回的逐插件诊断数组。
 * @param {Array<object>} plugins collectHandlers 的 plugins 列表
 * @param {{warn?: Function, info?: Function}} [sinks] 日志出口（缺省 no-op，供单测注入）
 */
export function reportDeclarationDiagnostics(plugins, sinks = {}) {
  const warn = typeof sinks.warn === 'function' ? sinks.warn : () => {};
  const info = typeof sinks.info === 'function' ? sinks.info : () => {};
  for (const p of plugins) {
    const critical = (p.dropped ?? []).filter((d) => d.reason !== 'event-unsupported');
    if (p.unreadable && Object.keys(p.unreadable).length > 0) {
      warn(`[${p.plugin}] 钩子声明不可读（${Object.keys(p.unreadable).join('/')}），按 fail-open 处理（声明数 ${p.declared}，保留 ${p.kept}）`);
      continue;
    }
    if (critical.length > 0) {
      const byReason = {};
      for (const d of critical) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
      warn(`[${p.plugin}] 丢弃 ${critical.length} 条钩子声明（${Object.entries(byReason).map(([k, v]) => k + '×' + v).join('、')}；声明数 ${p.declared}，保留 ${p.kept}）`);
    }
    if (p.declared === 0) info(`[${p.plugin}] 钩子声明为零（合法零声明）`);
    else if ((p.dropped ?? []).some((d) => d.reason === 'event-unsupported') && critical.length === 0) {
      info(`[${p.plugin}] 跳过宿主不支持事件 ${p.dropped.length} 条（事件声明数 ${p.declared}）`);
    }
  }
}

/**
 * 宿主 turn（agent/turn-stopping 负载的整数轮号）归一为 task-recap 消费的 turnId 字符串。
 * @param {unknown} turn 宿主轮号
 * @returns {string|undefined} 正整数→字符串；其余 undefined（不产键）
 */
export function turnIdOf(turn) {
  return Number.isSafeInteger(turn) && turn > 0 ? String(turn) : undefined;
}

/**
 * `${VAR}` 占位符替换。
 * 两种声明源各有一种形态：中立清单只允许 `${PLUGIN_ROOT}`（plugin-core 中立性 lint 拦其他
 * 占位符），ZCode 生成物把同一位置译成 `${ZCODE_PLUGIN_ROOT}`；调用方两个键都传同一个根，
 * 故换源前后命令行逐字相同。未赋值时原样保留：宁可让钩子自己失败（fail-open 静默退 0）也不猜路径。
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function substituteVars(text, vars) {
  let out = String(text);
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value !== '') out = out.split(`\${${key}}`).join(value);
  }
  return out;
}

/**
 * 从工具调用结果里取模型可见文本。只认字符串与 `{type:'text',text}` 内容块两种形态，
 * 其余（结构化块、附件）忽略——`post-tool.mjs` 的失败分类只吃字符串或
 * `{exit_code,stderr,error}` 对象，多余形态对它是噪音。
 * @param {unknown} content
 * @returns {string}
 */
export function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * 构造钩子负载（ZCode/claude-code 同形 camelCase 信封）。
 * `cwd` 一律为有效绝对路径（`fields.cwd` → 进程 cwd 回落）：ZCode 侧护栏以负载 cwd
 * 判定激活域与冻结边界，`check-freeze` 的极性裁决是「负载不可读 → DENY」——缺 cwd
 * 会把它推到 fail-closed 分支，把无害调用误判成冻结命中。
 * @param {'SessionStart'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'|'Stop'} event
 * @param {object} fields 逐事件字段；`fields.delegationDepth`（内部任务-20 A1）为宿主中立委派深度，
 *        非负安全整数时才产 `delegation_depth` 键（缺省/非法不产键 ⇒ 顶层会话语义）；
 *        `fields.parentSessionId`（内部决策-061 D3）仅在 depth>0 且非空串时产 `parent_session_id`；
 *        `fields.dispatchFact`（内部决策-063 D5，PostToolUse 专用）取 `dispatched|not-dispatched`
 *        时产 `dispatch_fact` 键（缺省不产键 ⇒ 核心按 `unknown` 保守处理）
 * @returns {object}
 */
export function buildPayload(event, fields) {
  const cwd = typeof fields.cwd === 'string' && fields.cwd !== '' ? fields.cwd : process.cwd();
  const base = {
    session_id: typeof fields.sessionId === 'string' ? fields.sessionId : '',
    transcript_path: '',
    cwd,
    hook_event_name: event,
  };
  // 内部任务-20 A1/F4：委派深度（宿主中立名）——仅当传入**非负安全整数**时携带；缺省不产键
  // （ZCode 直跑/mcode/kimi 三宿主的钩子负载形态零变化，缺键即顶层会话语义）。
  // 消费方（user-prompt/task-recap/learnings-recap）按 >0 收窄注入面；非法值一律不产键，不猜、不强转。
  if (Number.isSafeInteger(fields.delegationDepth) && fields.delegationDepth >= 0) {
    base.delegation_depth = fields.delegationDepth;
  }
  // 内部决策-061 D3（内部任务-227）：DSH 委派子会话的父会话标识——仅在 depth>0 且父会话 id 为非空
  // 字符串时携带；顶层会话/其余三宿主不传该字段 ⇒ 键缺席，负载逐字节零变化。
  if (Number.isSafeInteger(fields.delegationDepth) && fields.delegationDepth > 0
    && typeof fields.parentSessionId === 'string' && fields.parentSessionId !== '') {
    base.parent_session_id = fields.parentSessionId;
  }
  // 内部决策-063 D5（内部任务-192 P2）派发事实三态：仅接受 `dispatched`/`not-dispatched` 两值（`unknown`
  // 的合法表达就是**不产键**——不伪造）；消费方 `post-tool.mjs` 在重试环推进**之前**读它，
  // `not-dispatched` 即短路（未派发调用不是失败、也不该推进重试环）。取值形态不符不产键。
  if (fields.dispatchFact === 'dispatched' || fields.dispatchFact === 'not-dispatched') {
    base.dispatch_fact = fields.dispatchFact;
  }
  // 内部任务-272 内部未决-235：宿主 `agent/turn-stopping` 负载含 turn（整数轮号），归一后作条件键；
  // 缺省/非法不产键 ⇒ task-recap 保持既有 60s 时间窗退化路径（三宿主负载零变化）。
  if (typeof fields.turnId === 'string' && fields.turnId.trim() !== '') base.turnId = fields.turnId.trim();
  if (event === 'SessionStart') return { ...base, source: typeof fields.source === 'string' ? fields.source : 'startup' };
  if (event === 'UserPromptSubmit') return { ...base, prompt: typeof fields.prompt === 'string' ? fields.prompt : '' };
  if (event === 'PreToolUse') {
    return { ...base, tool_name: String(fields.toolName ?? ''), tool_input: fields.toolInput ?? {}, tool_use_id: String(fields.callId ?? '') };
  }
  if (event === 'PostToolUse') {
    const text = flattenContent(fields.resultContent);
    return {
      ...base,
      tool_name: String(fields.toolName ?? ''),
      tool_input: fields.toolInput ?? {},
      tool_use_id: String(fields.callId ?? ''),
      tool_response: text,
      // 结构化面（内部未决-46 修订，内部任务-OPEN46-1）：宿主 `ToolExecutionResult` **没有顶层
      // `exitCode`**（旧读法 `result?.exitCode` 是死字段）——真退出码在 `result.value.exitCode`
      // （pwsh/bash 的 `canonical*Result`），失败事实在 `result.isError`。宿主文本里的
      // `[exit code: N]` 等标记属宿主 seam 契约，**不在本层解析**，也不进核心钩（多宿主零术语）。
      // 合成交引擎（内部决策-037 批 2 步骤 5a）：键集/常量位/条件键由 `failure-event-merge` 的
      // `params.dsh`（synthesize + constants）决定；`exit_code` 判据为 `Number.isFinite`
      //（等价面①：`NaN/Infinity` 输入与旧实现不同，生产值域不可达，按引擎语义为准）。
      tool_result: synthesizedToolResult(fields, text),
    };
  }
  // Stop：`stop_hook_active` 恒 false；`turnId` 由上方条件键提供（内部任务-272 起宿主 turn 透传，
  // 缺省不产键时 task-recap 保持 60s 时间窗）。
  return { ...base, stop_hook_active: false };
}
/**
 * 事件 → 钩子信封允许的 `hookEventName` 集合。PostToolUse 额外接受
 * `PostToolUseFailure`：ZCode 侧 `post-tool.mjs` 双注册（失败主通道 + 成功兜底），
 * DSH 无独立失败事件，两通道在适配层合并到 `tools/post-execute`。
 */
const ENVELOPE_EVENT_NAMES = new Map([
  ['SessionStart', ['SessionStart']],
  ['UserPromptSubmit', ['UserPromptSubmit']],
  ['PreToolUse', ['PreToolUse']],
  ['PostToolUse', ['PostToolUse', 'PostToolUseFailure']],
  ['Stop', ['Stop']],
]);

/**
 * 允许表公式（内部决策-037 批 2 步骤 5c）：`allowed(event) = (静态表[event] ∩ D_root) ∪ {event}`。
 * `D_root`＝该插件根**声明的原始事件名**集合（`declaredEventNames`）；`D_root=∅` 时退化为
 * `{event}`＝事件自身恒被采信（兼容回落根与既有装配级用例的行为基线）。交集保证「只有真的声明了
 * `PostToolUseFailure` 的根」才采信该信封——未声明即拒，反向证明声明来源。
 * @param {string} event 触发事件名
 * @param {Iterable<string>|undefined} declared 该根声明的事件名集合（缺省＝不过滤）
 * @returns {string[]} 允许的 `hookEventName` 集合
 */
function allowedEnvelopeEvents(event, declared) {
  const base = ENVELOPE_EVENT_NAMES.get(event) ?? [event];
  if (declared === undefined) return base;
  const set = declared instanceof Set ? declared : new Set(declared);
  return [...new Set([...base.filter((name) => set.has(name)), event])];
}

/**
 * 读出插件根**声明的原始事件名**集合：中立清单 `hooks[].event` 全集；无中立清单时回落读
 * 生成物 `hooks/hooks.json` 的事件键（与「声明源回落面」同语义）；两者皆无 ⇒ 空集合。
 * @param {string} pluginRoot 插件根目录
 * @returns {Set<string>} 声明的事件名集合
 */
export function declaredEventNames(pluginRoot) {
  const names = new Set();
  let manifestPresent = false;
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, MANIFEST_FILE), 'utf8'));
    manifestPresent = true;
    const hooks = Array.isArray(manifest?.hooks) ? manifest.hooks : [];
    for (const entry of hooks) {
      const event = entry && typeof entry === 'object' ? entry.event : undefined;
      if (typeof event === 'string' && event !== '') names.add(event);
    }
  } catch { /* 无中立清单：回落生成物 */ }
  // 清单在场即**权威**（含 `hooks: []` 的显式零声明）——否则会把清单里删掉的钩子经旧生成物复活
  // （门 B 回流：清单权威判定与 `readManifestHookConfig` 同源，不做第二套判定）。
  if (manifestPresent) return names;
  try {
    const raw = JSON.parse(readFileSync(join(pluginRoot, ...ZCODE_HOOKS_REL), 'utf8'));
    const map = raw && typeof raw === 'object' ? raw.hooks : undefined;
    if (map && typeof map === 'object') for (const key of Object.keys(map)) names.add(key);
  } catch { /* 两者皆无 ⇒ 空集合 */ }
  return names;
}

/** 从对象取字符串字段（缺失/非字符串 → ''）。 */
function str(obj, key) {
  return obj && typeof obj === 'object' && typeof obj[key] === 'string' ? obj[key] : '';
}

/**
 * 把一次钩子进程结果翻译为决策对象（DSH 决策词汇的独立副本，语义对齐
 * `@deepseek-ai/dsh-hook-protocol` 的 HookOutput）。
 * 规则（对 ZCode 宿主语义的复刻，2026-09-28 源码走查）：
 *   - 退出码 2 = 阻断；stdout JSON 信封里的 `additionalContext` 仍然采信
 *     （ZCode 的 verify-gate 正是「exit 2 + 信封 additionalContext」形态）；
 *   - 退出码 0 且 stdout 以 `{` 开头 = 结构化信封，取 `permissionDecision` 与
 *     `additionalContext`；
 *   - `hookEventName` 与触发事件不一致时丢弃事件域字段（信封校验，内部接口-1 §3）；
 *   - 其余退出码 = 非阻断失败，记日志不拦。
 * @param {number|undefined} exitCode 子进程退出码；undefined 表示启动即失败
 * @param {string} stdout 标准输出
 * @param {string} stderr 标准错误
 * @param {string} event 触发事件名
 * @param {{allowedEvents?: Iterable<string>}} [options] 允许表输入：该插件根声明的事件名集合
 *   （缺省＝现静态表；`declaredEventNames` 产物，见全局约束与 内部决策-037 批 2 步骤 5c）
 * @returns {{exitCode: number|undefined, decision: 'deny'|'ask'|'allow'|undefined, reason: string|undefined, additionalContext: string|undefined, continue: boolean|undefined}}
 */
export function decodeHookOutput(exitCode, stdout, stderr, event, options = {}) {
  const out = { exitCode, decision: undefined, reason: undefined, additionalContext: undefined, continue: undefined };
  const trimmedOut = typeof stdout === 'string' ? stdout.trim() : '';
  const trimmedErr = typeof stderr === 'string' ? stderr.trim() : '';
  /** @type {any} */
  let parsed;
  if (trimmedOut.startsWith('{')) {
    try {
      const candidate = JSON.parse(trimmedOut);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate;
    } catch {
      parsed = undefined; // JSON 损坏按纯文本处理（不拦）
    }
  }
  if (parsed) {
    if (typeof parsed.continue === 'boolean') out.continue = parsed.continue;
    const hso = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === 'object' && !Array.isArray(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;
    if (hso) {
      const allowed = allowedEnvelopeEvents(event, options.allowedEvents);
      const eventName = str(hso, 'hookEventName');
      if (eventName === '' || allowed.includes(eventName)) {
        const permission = str(hso, 'permissionDecision');
        if (permission === 'deny' || permission === 'ask' || permission === 'allow') out.decision = permission;
        const ctx = str(hso, 'additionalContext');
        if (ctx !== '') out.additionalContext = ctx;
        // ZCode 护栏把用户可见文案放在 `systemMessage`（check-careful/check-freeze 两钩
        // 的唯一文案位），宿主桥不读该字段——本层读，否则 deny 会退化为默认串、文案丢失。
        // reason 读取序交引擎（内部决策-037 批 2 步骤 5b）：读取优先级由 `message-slot-migration`
        // 的 `params.dsh.readPriority` 决定（`permissionDecisionReason` → `systemMessage`），
        // 与旧内联读取等价；空串/缺字段同返回空串。
        const reason = messageSlotReason(hso);
        if (reason !== '') out.reason = reason;
      }
    }
  }
  if (exitCode === 2) {
    out.decision = 'deny';
    if (out.reason === undefined) out.reason = trimmedErr !== '' ? trimmedErr : undefined;
  } else if (exitCode !== 0 && trimmedErr !== '') {
    out.reason = trimmedErr;
  }
  return out;
}

/**
 * 从钩子输出对象读取 reason（引擎驱动，内部决策-037 批 2 步骤 5b）。
 * 读取优先级由 `message-slot-migration` 的 `params.dsh.readPriority` 承担
 * （`permissionDecisionReason` → `systemMessage`）；无可用槽位返回空串。
 * @param {Record<string, unknown>} envelope 钩子输出对象（`hookSpecificOutput` 或顶层）
 * @returns {string} reason 文本（无则空串）
 */
function messageSlotReason(envelope) {
  const outcome = getEngine().applyRule('message-slot-migration', 'dsh', { envelope });
  if (outcome.applied !== true || typeof outcome.result !== 'string') {
    throw new Error('hooks-bridge: 规则库字段契约漂移（message-slot-migration 缺 params.dsh）——拒载而非静默丢 reason');
  }
  return outcome.result;
}

/**
 * 合成 `tool_result` 结构化面（引擎驱动，内部决策-037 批 2 步骤 5a）。
 * 键集/条件键/常量位由 `failure-event-merge` 的 `params.dsh` 承担（synthesize + constants；
 * `stderr` 恒空串的理由见规则注释：文本已含 `[stderr]` 段，原样传入会制造假阳性）。
 * @param {{exitCode?: number, isError?: boolean}} fields 宿主 `ToolExecutionResult` 抽取字段
 * @param {string} text 文本面（`stdout` 位）
 * @returns {Record<string, unknown>} `tool_result` 对象
 */
function synthesizedToolResult(fields, text) {
  const outcome = getEngine().applyRule('failure-event-merge', 'dsh', {
    isError: fields.isError === true,
    exitCode: fields.exitCode,
    text,
  });
  if (outcome.applied !== true || !outcome.result || typeof outcome.result.tool_result !== 'object') {
    throw new Error('hooks-bridge: 规则库字段契约漂移（failure-event-merge 缺 params.dsh）——拒载而非静默合成信封');
  }
  const toolResult = outcome.result.tool_result;
  // 内部任务-20 B/F3（内部决策-033 修正案 1）：宿主结构化错误码的**透传位**。放在规则产物之外，是为了
  // **不动规则库数据与校验面**（`failure-event-merge` 的 params 键集不变）；形态与语义作用域
  // 判定一律在核心件 `post-tool.mjs` 单点收口（本层只做"有则带、无则不产键"）。
  if (typeof fields.errorCode === 'string' && fields.errorCode !== '') toolResult.errorCode = fields.errorCode;
  return toolResult;
}

/**
 * 合并同一事件上多个钩子的决策（`deny > ask > allow`，最严者胜；上下文按钩子顺序累积）。
 * @param {ReturnType<typeof decodeHookOutput>[]} outputs
 * @returns {{decision: 'deny'|'ask'|'allow'|'none', reason: string|undefined, additionalContext: string[], block: boolean}}
 */
export function mergeOutcomes(outputs) {
  const rank = { deny: 3, ask: 2, allow: 1 };
  let best = 0;
  let reason;
  const additionalContext = [];
  let block = false;
  for (const out of outputs) {
    if (out.continue === false) block = true;
    const r = out.decision ? (rank[out.decision] ?? 0) : 0;
    if (r > best) {
      best = r;
      reason = out.reason;
    } else if (r === best && r >= 2 && out.reason !== undefined) {
      reason = reason === undefined ? out.reason : `${reason}\n\n${out.reason}`;
    }
    if (typeof out.additionalContext === 'string' && out.additionalContext !== '') additionalContext.push(out.additionalContext);
  }
  const decision = best === 3 ? 'deny' : best === 2 ? 'ask' : best === 1 ? 'allow' : 'none';
  return { decision, reason, additionalContext, block };
}

/**
 * 处理器命令行构造：`command` + `args`，其中 args 里出现 `${PLUGIN_ROOT}`（中立清单形态）
 * 或 `${ZCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`（ZCode 生成物及历史形态）时按插件根
 * 替换——声明里路径占位符可能出现在 args 而非 command，替换必须先于引用。
 * @param {{command: string, args: string[]}} handler
 * @param {Record<string, string>} vars 替换变量
 * @returns {string} 可直接交给 shell seam 的命令行
 */
export function handlerCommandLine(handler, vars = {}) {
  const root = typeof vars.ZCODE_PLUGIN_ROOT === 'string' ? vars.ZCODE_PLUGIN_ROOT : '';
  const rawCommand = substituteVars(handler.command, { ZCODE_PLUGIN_ROOT: root, PLUGIN_ROOT: root });
  // 内部未决-243（内部任务-308）：DSH 侧钩子声明用裸 `node` 走 PATH——改写为本进程解释器绝对路径，
  // 消除「PATH 解析不到 ⇒ 钩子 fail-open 静默空转」与「PATH 劫持」两面。仅认裸 `node`/`node.exe`；
  // 显式绝对路径与其他可执行名保持原样（不覆盖声明方显式意图）。
  const command = rawCommand === 'node' || rawCommand === 'node.exe' ? process.execPath : rawCommand;
  const args = (handler.args ?? []).map((a) => substituteVars(a, { ZCODE_PLUGIN_ROOT: root, PLUGIN_ROOT: root }));
  const line = [command, ...args].map(quoteArg).join(' ');
  // 2026-11-03 内部任务-308 code-review（正确性维 CRITICAL）：win32 真实执行器为
  // `powershell.exe -NoLogo -NoProfile -NonInteractive -Command <line>`；命令位一旦是带引号
  // 绝对路径（execPath 常含空格），PowerShell 把引号串当**表达式**而非命令 ⇒ 需调用运算符 `&`
  // 才能执行。POSIX 不加（`&` 会后台化）。测试替身据此不再自行加 `&`（与真实 runner 同形）。
  return process.platform === 'win32' ? `& ${line}` : line;
}

/**
 * 派发失败 reporter 工厂（内部决策-063 修正案 3 决策 23.1，内部任务-195）：返回 `reportDispatchFailure`
 * 回调，由装配层（`index.mjs`）构造并注入 `runHandler`/`runSingleHandler` 的 opts——
 * **本模块不 import 观测 emitter**（单向依赖；测试注入 fake reporter）。
 *
 * 语义：
 *  - 只持 `emit`（有 `emitFact` 即可）与可选 `warn`（logWarn 注入）；**不固化 sessionId**——
 *    会话标识每次从 payload 取，跨会话派发不会串键；
 *  - 去重键 `${sessionId}:${reason}`：**每会话同类至多一次**（闭包 Set 为 apply 级实例；
 *    测试按用例新建即隔离；跨进程不承诺）；
 *  - 上报载荷只含结构化类别字段（无原文）：`{schemaVersion:1, kind:'hook-failure',
 *    observationSource:'adapter:dsh', errorClass:'dispatch-error', note:<reason>, ts, event?}`；
 *  - `emit` 抛错只告警不抛（派发路径绝不被观测失败反噬）。
 * @param {{emit?: {emitFact?: Function}, warn?: (message: string) => void}} [deps]
 * @returns {(info: {event?: string, handler?: object, reason?: string, sessionId?: string}) => boolean} 是否实际上报
 */
export function createDispatchFailureReporter(deps = {}) {
  const emit = deps.emit && typeof deps.emit.emitFact === 'function' ? deps.emit : null;
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {};
  const reported = new Set();
  return function reportDispatchFailure(info = {}) {
    const reason = typeof info.reason === 'string' && info.reason !== '' ? info.reason : 'unknown';
    const sessionId = typeof info.sessionId === 'string' && info.sessionId !== '' ? info.sessionId : 'unknown';
    const key = `${sessionId}:${reason}`;
    if (reported.has(key)) return false;
    reported.add(key);
    if (emit === null) return false;
    const fact = {
      schemaVersion: 1,
      kind: 'hook-failure',
      // 适配层身份字面量（本层即 DSH 适配层；与 内部接口-26 §2 的 observationSource 形态一致）
      observationSource: 'adapter:dsh',
      errorClass: 'dispatch-error',
      note: reason,
      ts: Date.now(),
    };
    if (typeof info.event === 'string' && info.event !== '') fact.event = info.event;
    try {
      emit.emitFact(fact, { projectRoot: typeof info.projectRoot === 'string' && info.projectRoot !== '' ? info.projectRoot : undefined });
    } catch (error) {
      try {
        warn(`ai-coding-methodology: hook-failure 上报失败（${reason}）——${error instanceof Error ? error.message : String(error)}`);
      } catch {
        /* 告警通道自身失败：不抛（派发路径优先级最高） */
      }
    }
    return true;
  };
}

/** 从钩子负载取会话标识（缺失 ⇒ 'unknown'；reporter 去重键与派发失败事实都不固化会话）。 */
function payloadSessionId(payload) {
  return payload && typeof payload === 'object' && typeof payload.session_id === 'string' && payload.session_id !== ''
    ? payload.session_id
    : 'unknown';
}

/** 从钩子负载取事件名（`hook_event_name`；缺失 ⇒ ''，事实面省略 event 键）。 */
function payloadEventName(payload) {
  return payload && typeof payload === 'object' && typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
}

/**
 * 处理器标签（日志用）：调用方可传身份 label（插件名#序位）；缺省退化为未替换命令行。
 * @param {object} handler 处理器声明
 * @returns {string}
 */
function handlerLabel(handler) {
  return `${handler?.command ?? ''} ${(handler?.args ?? []).join(' ')}`.trim();
}

/**
 * 运行单个处理器：以 `cwd` 为工作目录、注入 `ZCODE_*` 环境、按声明超时受控执行。
 * 任何启动/执行异常都降级为「无退出码的失败结果」——适配层绝不向调用轮次抛错。
 * 内部决策-063 修正案 3 决策 23.1（内部任务-195）：spawn/execute 抛错与宿主 `timedOut` 两态经注入
 * `opts.reportDispatchFailure` 上报（reason=spawn-error / dispatch-timeout），
 * **不改变派发返回/阻断语义**；`timedOut` 字段如实透出（供上层与 reporter 判定）。
 * @param {{shell: {resolve: Function, execute: Function}}} ctx
 * @param {{command: string, args: string[], timeoutMs: number}} handler
 * @param {object} payload 钩子负载（作为 stdin）
 * @param {{cwd: string, env: Record<string,string>, signal?: AbortSignal, reportDispatchFailure?: Function}} opts
 * @returns {Promise<{exitCode: number|undefined, stdout: string, stderr: string, durationMs: number, timedOut: boolean, error?: string}>}
 */
export async function runHandler(ctx, handler, payload, opts) {
  const started = Date.now();
  const report = opts && typeof opts.reportDispatchFailure === 'function' ? opts.reportDispatchFailure : null;
  const command = handlerCommandLine(handler, { ZCODE_PLUGIN_ROOT: opts.env?.ZCODE_PLUGIN_ROOT ?? '' });
  // `shell` 是本插件唯一写进 inject 的服务，故 `ctx.shell` 属性读在真实 cordis 上合法；
  // 仍优先走 ctx.get（测试替身与真实上下文同时可用），拿不到就落到属性读。
  const shell = typeof ctx.get === 'function' ? (ctx.get('shell') ?? ctx.shell) : ctx.shell;
  try {
    const request = shell.resolve({
      command,
      timeoutMs: handler.timeoutMs,
      stdin: `${JSON.stringify(payload)}\n`,
      workdir: opts.cwd,
      env: opts.env,
      // R-hooks-2：覆盖部署沙箱策略，使钩子子进程可写状态目录（见 HOOK_SANDBOX_POLICY 注释）
      sandboxPolicy: HOOK_SANDBOX_POLICY,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const result = await (await shell.execute(request)).result();
    const stdout = result && result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : '';
    const stderr = result && result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : '';
    const timedOut = result?.timedOut === true;
    if (timedOut) {
      // 内部任务-273 M-02：超时必须有宿主可见日志（旧实现只进 reporter，exitCode 缺失时主日志零行/误标退出码）。
      const label = opts?.label ?? handlerLabel(handler);
      logWarn(ctx.logger, `ai-coding-methodology: ${payloadEventName(payload)} 钩子超时（${label}；timeout=${handler.timeoutMs}ms，duration≈${Date.now() - started}ms）`);
      if (report) {
        report({ event: payloadEventName(payload), handler, reason: 'dispatch-timeout', sessionId: payloadSessionId(payload), projectRoot: payload?.cwd });
      }
    }
    return {
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : undefined,
      stdout: cap(stdout),
      stderr: cap(stderr),
      durationMs: Date.now() - started,
      timedOut,
    };
  } catch (error) {
    // 内部任务-273 M-03：取消（abort）不是失败——取消类错误不上报 spawn-error；取消窗口内的**真失败**仍双记上报，
    // 不得用 aborted 一律吞掉真实失败（观测账本不得单向失真）。
    const aborted = opts?.signal?.aborted === true;
    // 计划判据（批次 B 步骤 8③）：AbortError 独立于 signal 置位即按取消；其余错误仅在「取消窗口内」按取消。
    const cancelLike = error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || (aborted && /abort/i.test(String(error?.message ?? '')));
    if (cancelLike) {
      logInfo(ctx.logger, `ai-coding-methodology: ${payloadEventName(payload)} 钩子派发被取消（aborted，非失败；${opts?.label ?? handlerLabel(handler)}）`);
      return {
        exitCode: undefined,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        timedOut: false,
        aborted: true,
      };
    }
    if (aborted) logInfo(ctx.logger, `ai-coding-methodology: ${payloadEventName(payload)} 钩子取消窗口内失败（按真实失败上报；${opts?.label ?? handlerLabel(handler)}）`);
    if (report) {
      report({ event: payloadEventName(payload), handler, reason: 'spawn-error', sessionId: payloadSessionId(payload), projectRoot: payload?.cwd });
    }
    return {
      exitCode: undefined,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 输出截断（超预算丢弃尾部并附注记——不静默）。 */
function cap(text) {
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n[truncated]` : text;
}

/**
 * 命令行参数引用（平台参数化：测试可直测两侧语义，不依赖 process.platform）。
 *
 * **win32（2026-11-03 内部任务-308 实测更正）**：DSH win32 执行器不是 cmd.exe，而是
 * `dsh-subprocess-local` runner spawn 的 **Windows PowerShell 5.1**
 * （`powershell.exe -NoLogo -NoProfile -NonInteractive -Command <line>`，进程树直读）。
 * 因此 win32 分支按 PowerShell 语义：单引号字面量（内部 `'` 加倍），`$`/反引号不展开、
 * 尾反斜杠无需加倍。旧实现按 cmd.exe 写（双引号加倍、尾反斜杠加倍），与实况不符（内部未决-242）。
 *
 * **POSIX**：单引号（内部 `'` 以 `'\''` 拼接），单引号内一切字面。
 *
 * 已知边界（如实记）：参数来自**仓库内声明文件**（受信）与宿主给的 cwd，不是任意用户输入；
 * 真要做不可信输入的命令行引用，应改用数组式 spawn 而非拼串。本函数按"引用 + 防手误"定位。
 * @param {'win32'|'posix'|string} platform
 * @param {unknown} value
 * @returns {string}
 */
export function quoteArgFor(platform, value) {
  const s = String(value);
  if (s !== '' && !/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s;
  if (platform === 'win32') return `'${s.split("'").join("''")}'`;
  return `'${s.split("'").join("'\\''")}'`;
}

/**
 * 当前平台分派（调用方签名不变）。
 * @param {unknown} value
 * @returns {string}
 */
export function quoteArg(value) {
  return quoteArgFor(process.platform, value);
}

/**
 * 运行单个处理器并翻译其决策：返回「解码结果数组」——单处理器时长度为 1，
 * 与多处理器路径共用同一份合并语义（`mergeOutcomes`）。
 * 执行失败与异常退出只记日志，不改变决策（fail-open：适配层自身故障绝不阻断宿主轮次）。
 *
 * 内部决策-063 修正案 3 决策 23.1（内部任务-195）第三态：**解码前**判定信封损坏——`stdout` 非空且以
 * `{` 开头但 `JSON.parse` 失败 ⇒ 上报 `output-unparsable`（`decodeHookOutput` 签名不变；
 * 纯文本/空输出属合法 quiet 输出，不上报）。上报只走注入 reporter，不改变返回语义。
 * @param {{shell: object, logger?: object}} ctx
 * @param {{command: string, args: string[], timeoutMs: number}} handler
 * @param {object} payload 钩子负载（作为 stdin）
 * @param {{cwd: string, env: Record<string,string>, signal?: AbortSignal, reportDispatchFailure?: Function}} opts
 * @param {string} event 触发事件名（信封校验用）
 * @param {{allowedEvents?: Iterable<string>}} [options] 允许表输入（逐插件声明集；缺省＝现静态表）
 * @returns {Promise<ReturnType<typeof decodeHookOutput>[]>}
 */
export async function runSingleHandler(ctx, handler, payload, opts, event, options = {}) {
  const r = await runHandler(ctx, handler, payload, opts);
  const label = opts?.label ?? handlerLabel(handler);
  if (r.error !== undefined) logWarn(ctx.logger, `ai-coding-methodology: ${event} 钩子启动失败（${label}）：${r.error}`);
  else if (!r.timedOut && r.exitCode !== undefined && r.exitCode !== 0 && r.exitCode !== 2) logWarn(ctx.logger, `ai-coding-methodology: ${event} 钩子退出码 ${r.exitCode}（${label}）`);
  // 信封损坏（hook 契约形态漂移）：`{` 开头但不可解析——不是 quiet 输出，必须可观测。
  const report = opts && typeof opts.reportDispatchFailure === 'function' ? opts.reportDispatchFailure : null;
  if (report && typeof r.stdout === 'string' && r.stdout.trim().startsWith('{')) {
    let broken = false;
    try {
      JSON.parse(r.stdout.trim());
    } catch {
      broken = true;
    }
    if (broken) {
      report({ event, handler, reason: 'output-unparsable', sessionId: payloadSessionId(payload), projectRoot: payload?.cwd });
    }
  }
  return [decodeHookOutput(r.exitCode, r.stdout, r.stderr, event, options)];
}
