// 文件：agents-bridge.mjs
// 描述：DSH 宿主适配第四面——把 workflow 插件既有的 `agents/*.md`（ZCode 的只读子 agent
//       角色声明）映射到 DSH 的委派面。仍然只读 ZCode 资产。
//       形态对应（内部决策-032 决策 10）：
//         ZCode agent 文件三要素            → DSH
//         正文（角色/职责/输出契约）          → `dsh-tool-subagent` 的 `persona`
//         前言 `tools:`（工具白名单）        → 同上的 `toolFilter`（经 `tools.restrict` 生效）
//         一个 agent 一个委派目标            → 每个 agent 一份委派工具实例（`toolName` 唯一）
//       子 agent 的创建、驱动、结算全部留给宿主既有的 `spawn` 提供方（其 `start(request)`
//       内部走 `startInProcessRun`，声明了 `persona`/`toolFilter` 能力）——本层只做"注入
//       persona 与 filter"这一件事，是薄包装而非重写。
//
//       **工具过滤为什么必须 fail-closed**（源码逐字核实 `dsh-tools`）：`tools.restrict()`
//       对任一未知名抛错（`names unknown global tool "X"`），而它发生在 `applyChildComposition`
//       ——子 agent 的创建窗口内。写错一个名字 = 子 agent 创建失败、委派以 failed 结算。
//       所以本层的 allow 列表只用"宿主源码里实测存在的工具名"，且必须与宿主目录求交集：
//       目录不可得时不挂载（响亮告警），绝不退化成"不过滤"——多给一个写工具是约束静默失效，
//       少给一个读工具只是能力受限（可见、可修）。两种错法不对称。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { listEntriesIn, parseFrontmatter } from './skills-bridge.mjs';
import { logWarn } from './log.mjs';
import { getEngine } from './engine-binding.mjs';

/**
 * core 候选工具名：所有组合的基线（宿主源码 `dsh-tool-fs` / `dsh-tool-fs-search` 的
 * `name:` 行逐字核对：`read` / `glob` / `grep`）。只读，永不越界。
 */
export const CORE_TOOLS = ['read', 'glob', 'grep'];

/**
 * extended 候选工具名：依赖相应插件行在场（`dsh-tool-web` 的 `web_fetch` / `web_search`、
 * `dsh-tool-todo` 的 `todo_write`）；缺省会被"与宿主目录求交集"这一步过滤掉，不会写进
 * `toolFilter`。分两层的意义即在于此——目录里没有就不给，避免 `restrict()` 抛未知名。
 */
export const EXTENDED_TOOLS = ['web_fetch', 'web_search', 'todo_write'];

/**
 * 生产探测候选名全集（内部任务-273 H-02/H-08 单源）：`core ∪ extended ∪ 平台 shell 候选`。
 * 探测（`resolveAvailableTools`）与 README 候选描述共用本常量；`TOOL_MAP`（ZCode 词→DSH 名映射表）
 * 语义不同、另行维护（不强行合并，避免把两套映射混为一谈）。
 */
export const ALL_TOOL_CANDIDATES = Object.freeze([...new Set([...CORE_TOOLS, ...EXTENDED_TOOLS, 'pwsh', 'bash'])]);

/**
 * agent 面不可用原因（内部任务-273 H-03 单源）：装配层日志与 `mountAgents` 降级分支共用，防两处文案漂移。
 */
export const AGENT_FACE_UNAVAILABLE_REASON = '宿主 0.2.1-rc.5 起 persona/toolFilter 由 Agent Preset 承载（本适配层未装配预设）——agent 面不可用（OPEN-244）';

/**
 * 只读约束的禁表：这些工具**永远不得**出现在 allow 里。`pwsh`/`bash` 不在"写工具"之列
 * （`code-reviewer` 在 ZCode 侧就有 `Bash`），它们由各自的 agent 词表决定是否进入 allow；
 * 列在这里是为了让"写工具"这件事有一个机械可查的单一清单。
 */
export const READ_ONLY_FORBIDDEN = ['write', 'edit', 'read_image'];

/** ZCode 工具词 → DSH 工具名**候选集**。**只映射确认存在的**；未知一律空数组（拒绝语义）。
 *
 * 为什么值是数组：DSH 的 shell 工具名**随平台不同**（Windows 为 `pwsh`、POSIX 为 `bash`），
 * 若在这里按平台写死一个名字，另一平台上交集必为空、只读 agent 会全体 fail-closed 不挂载
 * （且症状是"少三个 agent"而非报错）。列两个候选后由「与宿主真实目录求交集」这一步自然筛出
 * 当前平台的那一个——这也是本层既有纪律（名字必须来自宿主目录）的自然延伸。
 */
const TOOL_MAP = new Map([
  ['glob', ['glob']],
  ['grep', ['grep']],
  ['ls', ['read']], // DSH 无独立 ls 工具；列目录/看文件都由 read 承担
  ['read', ['read']],
  ['webfetch', ['web_fetch']],
  ['websearch', ['web_search']],
  ['todowrite', ['todo_write']],
  ['bash', ['pwsh', 'bash']], // 平台二选一，由目录交集决定
]);

/** 大小写不敏感的词归一（`WebFetch` / `webfetch` / `WEBFETCH` 同义）。 */
const normWord = (w) => String(w).trim().toLowerCase().replace(/[\s_-]+/g, '');

/**
 * 一个 ZCode 工具词 → DSH 工具名**候选**（可能多个：`Bash` 对应平台二选一）。
 * @param {string} word ZCode 词表里的一个词
 * @returns {string[]} 候选 DSH 工具名；无对位返回空数组（调用方按拒绝处置）
 */
export function mapZcodeTool(word) {
  return TOOL_MAP.get(normWord(word)) ?? [];
}

/**
 * 拆 ZCode 的 `tools:` 列表串：逗号/顿号/分号/空白皆可分隔，去空去重保序。
 * @param {unknown} raw 原始字符串
 * @returns {string[]}
 */
export function splitToolList(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(/[,，、;；\s]+/)) {
    const w = part.trim();
    if (w !== '' && !out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * 由 ZCode 词表推导 `toolFilter`。
 * @param {string[]} zcodeTools ZCode 词表
 * @param {{available?: string[]|null}} [opts] `available` 为宿主真实工具名集合；
 *   `undefined` 表示不做交集过滤（仅用于纯函数测试），`null`/`[]` 表示不可得 → 返回 null
 * @returns {{allow: string[]}|null} 无任何可用映射时返回 null（调用方必须 fail-closed）
 */
export function buildToolFilter(zcodeTools, opts = {}) {
  if (!Array.isArray(zcodeTools) || zcodeTools.length === 0) return null;
  const available = opts.available === undefined ? undefined : opts.available;
  // 候选映射 + 只读禁忌仍在本层（计划豁免：候选工具词汇表＝宿主目录来源面，非降级策略）；
  // **挂载极性判定**交引擎（内部决策-037 批 2 步骤 8）：`agent-default-off-fail-closed` 负责
  // 「目录不可得」「交集为空」两种 fail-closed 与 `defaultMount` 语义。
  const candidates = [];
  for (const word of zcodeTools) {
    for (const mapped of mapZcodeTool(word)) {
      if (READ_ONLY_FORBIDDEN.includes(mapped)) continue;
      if (!candidates.includes(mapped)) candidates.push(mapped);
    }
  }
  const outcome = getEngine().applyRule(
    'agent-default-off-fail-closed',
    'dsh',
    { candidates },
    {
      listRestrictableTools: () =>
        // `undefined`＝不做交集过滤（仅纯函数测试）：以候选自身充作目录，等价于旧实现的"不过滤"
        available === undefined ? candidates : available,
    },
  );
  if (outcome.applied !== true) {
    throw new Error('agents-bridge: 规则库字段契约漂移（agent-default-off-fail-closed 缺 params.dsh）——拒挂而非静默放宽');
  }
  const decision = outcome.result;
  if (!decision || decision.reject === true) return null; // fail-closed：目录不可得 / 交集为空
  return { allow: decision.allowedTools };
}

/**
 * 读一个 agent 声明文件。
 * **不抛**：不可读时把原因放进 `error` 字段——装配层据此逐条隔离（一条坏声明
 * 不能带走另外两条），且真实错误文本要保留（EACCES/ENOENT 排查含义不同）。
 * @param {string} file 文件绝对路径
 * @returns {{text: string, error?: string}} 成功给 `text`；失败给空 `text` 与 `error`
 */
export function readAgentFile(file) {
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 读一条 agent 声明并翻译为 DSH 侧输入。
 * 丢弃条件：文件不可读、frontmatter 不可解析、缺 `name`、缺 `description`、缺 `tools`、
 * 正文为空。
 * @param {string} plugin 插件名（进 provenance，不影响工具名）
 * @param {string} pluginRoot 插件根
 * @param {string} fileName 文件名（含 `.md`）
 * @returns {{name: string, plugin: string, description: string, persona: string, zcodeTools: string[], unmappedTools: string[], toolFilter: {allow: string[]}|null, path: string}|{skip: string, path: string}}
 */
export function loadAgent(plugin, pluginRoot, fileName) {
  const file = join(pluginRoot, 'agents', fileName);
  const read = readAgentFile(file);
  if (read.error !== undefined) return { skip: `agent 文件不可读（${read.error}）`, path: file };
  const parsed = parseFrontmatter(read.text);
  if (!parsed.ok) return { skip: `frontmatter 不可解析（${parsed.reason}）`, path: file };
  const name = typeof parsed.fields.name === 'string' ? parsed.fields.name.trim() : '';
  if (name === '') return { skip: '缺少 name', path: file };
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : '';
  if (description === '') return { skip: '缺少 description', path: file };
  const toolsRaw = parsed.fields.tools;
  const zcodeTools = splitToolList(toolsRaw);
  if (zcodeTools.length === 0) return { skip: '缺少 tools（工具白名单是只读约束的唯一依据）', path: file };
  const persona = parsed.body;
  if (persona.trim() === '') return { skip: '正文为空', path: file };
  const unmappedTools = zcodeTools.filter((w) => mapZcodeTool(w).length === 0);
  return {
    name,
    plugin,
    description,
    persona,
    zcodeTools,
    unmappedTools,
    toolFilter: buildToolFilter(zcodeTools),
    path: file,
  };
}

/**
 * 扫描一个插件的 agents 目录（只取顶层 `.md` 文件，排序确定；S-09 后共用 `listEntriesIn`）。
 * @param {string} pluginRoot 插件根
 * @returns {string[]} agent 文件名（含 `.md` 扩展名，排序后）
 */
export function agentFileNames(pluginRoot) {
  return listEntriesIn(pluginRoot, 'agents', { kind: 'file', ext: '.md' });
}

/**
 * 收集各插件下的全部 agent 声明。
 * @param {Record<string, string>} roots 插件名 → 插件根
 * @returns {{agents: object[], skipped: {plugin: string, file: string, reason: string}[]}}
 */
export function collectAgents(roots) {
  const agents = [];
  const skipped = [];
  for (const [plugin, root] of Object.entries(roots)) {
    if (typeof root !== 'string' || root === '') continue;
    for (const fileName of agentFileNames(root)) {
      const loaded = loadAgent(plugin, root, fileName);
      if (loaded.skip !== undefined) {
        skipped.push({ plugin, file: fileName, reason: loaded.skip });
        continue;
      }
      agents.push(loaded);
    }
  }
  return { agents, skipped };
}

/**
 * agent 名 → DSH 工具名（kebab → snake）。
 * 非 `[a-z0-9_]` 字符一律归一为 `_`，首尾下划线去掉；归一后若仍不符合宿主工具名
 * 形态 `^[a-z][a-z0-9_]*$` 则返回空串——调用方据此**拒绝挂载**（宁可少一个 agent，
 * 也不给宿主一个非法工具名）。
 * @param {string} agentName agent 名（如 `code-explorer`）
 * @returns {string} 合法工具名（如 `code_explorer`）；不可归一则为空串
 */
export function toolNameOf(agentName) {
  const s = String(agentName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(s) ? s : '';
}

/**
 * 挂载三份（或任意份）委派工具。
 * 逐条隔离：单条挂载失败只告警，不带倒其余。
 * **fail-closed**：`available` 为 null/空（宿主工具目录不可得）时整体不挂载并响亮告警——
 * 宁可少三个 agent，也不给一个不过滤的（可能是写权限）子 agent。
 * @param {object} ctx cordis 上下文（需要 `ctx.plugin`；`get('subagents')` 用于诊断）
 * @param {object[]} agents `collectAgents` 的产出
 * @param {{toolSubagentModule?: unknown, toolSubagentSpecifier?: string, providerName?: string, available?: string[]|null, backgroundMode?: string}} [options]
 *   `toolSubagentModule` 直接给模块引用；`toolSubagentSpecifier` 给模块名，由本函数按需 `import()`
 * @returns {Promise<{mounted: number, failed: {name: string, error: string}[], skipped: {name: string, reason: string}[]}>}
 */
export async function mountAgents(ctx, agents, options = {}) {
  // 内部任务-273 H-03（正确性评审 round1 #3）：宿主 0.2.1-rc.5 起 `dsh-tool-subagent` 以 Agent Preset
  // 承载 persona/工具面（`persona`/`toolFilter` 配置面被移除、显式抛错）⇒ 生产路径**默认降级**：
  // 返回全量 skipped、零 `ctx.plugin` 调用、绝不向宿主传已移除字段。仅测试用 legacyContract:true
  // 才进入旧契约循环（模拟历史宿主；生产不可达），旧循环随 内部未决-244 重设计退役。
  // 判据：**未注入模块**＝生产调用形态（宿主 rc.5 契约不可用 ⇒ 全量 skipped）；注入模块＝单测模拟历史宿主契约。
  if (options.legacyContract !== true && options.toolSubagentModule === undefined) {
    const reason = AGENT_FACE_UNAVAILABLE_REASON;
    return { mounted: 0, failed: [], skipped: (agents ?? []).map((agent) => ({ name: agent?.name ?? '(unknown)', reason })) };
  }
  const toolSubagentSpecifier = options.toolSubagentSpecifier ?? '@deepseek-ai/dsh-tool-subagent';
  const providerName = typeof options.providerName === 'string' && options.providerName !== '' ? options.providerName : 'ai-coding-methodology-agents';
  const backgroundMode = typeof options.backgroundMode === 'string' ? options.backgroundMode : 'one-shot';
  const available = options.available === undefined ? null : options.available;
  const failed = [];
  const skipped = [];

  let module = options.toolSubagentModule;
  if (module === undefined && typeof options.toolSubagentSpecifier === 'string' && options.toolSubagentSpecifier !== '') {
    try {
      module = (await import(options.toolSubagentSpecifier)).default ?? (await import(options.toolSubagentSpecifier));
    } catch (error) {
      module = undefined;
      logWarn(ctx.logger, `ai-coding-methodology: agent 面跳过——无法解析委派工具模块（${String(error)}）`);
    }
  }
  if (module === undefined || module === null) {
    logWarn(ctx.logger, 'ai-coding-methodology: agent 面跳过——未提供委派工具模块（@deepseek-ai/dsh-tool-subagent）');
    return { mounted: 0, failed, skipped: agents.map((a) => ({ name: a.name, reason: '缺少委派工具模块' })) };
  }
  if (typeof ctx?.plugin !== 'function') {
    logWarn(ctx.logger, 'ai-coding-methodology: agent 面跳过——宿主上下文不提供 ctx.plugin（无法挂载委派工具）');
    return { mounted: 0, failed, skipped: agents.map((a) => ({ name: a.name, reason: 'ctx.plugin 不可用' })) };
  }
  if (!Array.isArray(available) || available.length === 0) {
    logWarn(
      ctx.logger,
      'ai-coding-methodology: agent 面 fail-closed——宿主工具目录不可得，不挂载任何委派工具（工具过滤无法校验；' +
        '给一个不过滤的子 agent 会静默放开权限，宁可少三个 agent）',
    );
    return { mounted: 0, failed, skipped: agents.map((a) => ({ name: a.name, reason: '工具目录不可得（fail-closed）' })) };
  }

  const seen = new Set();
  let mounted = 0;
  for (const agent of agents) {
    const toolName = toolNameOf(agent.name);
    if (toolName === '') {
      skipped.push({ name: agent.name, reason: 'agent 名无法归一为 DSH 工具名' });
      continue;
    }
    if (seen.has(toolName)) {
      skipped.push({ name: agent.name, reason: `toolName 重复（${toolName}）` });
      continue;
    }
    const filter = buildToolFilter(agent.zcodeTools, { available });
    if (filter === null) {
      skipped.push({ name: agent.name, reason: '词表在宿主目录内无任何可用工具（fail-closed）' });
      continue;
    }
    try {
      // 必须 **await**：cordis 的 `ctx.plugin()` 声明返回 `Fiber & PromiseLike<Fiber>`，
      // 文档原话「awaiting it settles once loading finished (rejecting on config or startup
      // errors)」。也就是说失败是**异步 rejection**，不是同步 throw——只 try/catch 而不 await，
      // 既抓不到失败（`mounted` 会谎报成功），又留下一个未处理的 rejection。
      // 逐个 await 还有第二个好处：`seen` 集合在下一个 agent 前已反映真实挂载结果。
      await ctx.plugin(module, {
        provider: providerName,
        toolName,
        backgroundMode,
        persona: agent.persona,
        toolFilter: filter,
      });
      seen.add(toolName);
      mounted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name: agent.name, error: message });
      logWarn(ctx.logger, `ai-coding-methodology: agent ${agent.name} 的委派工具挂载失败（${message}）`);
    }
  }
  return { mounted, failed, skipped };
}
