// 文件：commands-bridge.mjs
// 描述：DSH 宿主适配第三面——把六插件既有的 `commands/*.md`（ZCode 的提示词展开型斜杠
//       命令）注册进 DSH 的命令注册表（`ctx.commands.register`）。仍然只读 ZCode 资产。
//       语义差异与处置（内部决策-032 决策 9）：ZCode 的 `/feature-dev` 之类是**提示词展开**——
//       宿主把命令正文（`$ARGUMENTS` 替换后）作为用户消息送进模型；DSH 的命令面**
//       按设计不产生模型消息**（README 与 `dsh-command-goal` 一致）。本层用
//       `invocation.agent.followup(...)` 把渲染后的正文作为一条普通下一轮提示词入队——
//       即宿主自己的 `/goal <objective>` 驱动 Goal Round 所用的同一 API，因此语义与
//       ZCode 一致（用户在下一轮看到自己的命令被当作指令）。
//       命令名：ZCode 靠 `/spec-gate:gate` 的冒号命名空间消歧，DSH 的命令名形态
//       （`/^[a-z][a-z0-9_-]*$/`）不允许冒号，故沿用 skill 面的前缀方案
//       （`spec-gate-gate`），两面的同名命令指向同一 skill。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { logWarn } from './log.mjs';
import { getEngine } from './engine-binding.mjs';
import { listEntriesIn, parseFrontmatter, skillNameOf } from './skills-bridge.mjs';

/** DSH 命令名形态（`@deepseek-ai/dsh-commands` 的 COMMAND_NAME 同款，不允许冒号）。 */
export const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** ZCode 命令参数占位符（命令正文里出现，展开时替换为用户输入）。 */
export const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

/** 命令定义身份的命名空间前缀（`definitionId` 用；cordis 侧只是被标记的普通字符串）。 */
export const DEFINITION_NAMESPACE = 'ai-coding-methodology/ai-coding-methodology';

/**
 * 构造命令的稳定定义身份。
 * 宿主文档（`dsh-commands` README「注册命令」节）：`definitionId` 是**可选但推荐**的
 * 「带插件命名空间的稳定定义标识」，「独立于显示文案和每次执行的 `commandId`」——适配器
 * 用它跨显示文案变化认出同一条命令（作用域覆盖不继承被遮蔽项的标识）。宿主自带的
 * `/goal` 等命令都带它（`CommandDefinitionId("@deepseek-ai/dsh-command-goal")`）。
 * @param {string} name 命令名（不带斜杠）
 * @returns {string}
 */
export function commandDefinitionId(name) {
  return `${DEFINITION_NAMESPACE}/${name}`;
}

/**
 * 从插件名 + 命令文件名构造 DSH 命令名（与 skill 面同规则：kebab 前缀）。
 * @param {string} plugin 插件名
 * @param {string} fileBase 命令文件名（不含扩展名）
 * @returns {string} DSH 命令名；形态非法时返回空串
 */
export function commandNameOf(plugin, fileBase) {
  const name = skillNameOf(plugin, fileBase);
  return COMMAND_NAME_RE.test(name) ? name : '';
}

/**
 * 扫描一个插件的命令目录（只取顶层 `.md` 文件，排序确定；S-09 后共用 `listEntriesIn`）。
 * @param {string} pluginRoot 插件根
 * @returns {string[]} 命令文件名（含扩展名，排序后）
 */
export function commandFileNames(pluginRoot) {
  return listEntriesIn(pluginRoot, 'commands', { kind: 'file', ext: '.md' });
}

/**
 * 渲染命令正文：把 `$ARGUMENTS` 替换为用户输入。
 * 无输入时替换为空串（与 ZCode 展开语义一致——正文自己会说明该带什么参数）。
 * @param {string} body 命令正文（frontmatter 之后）
 * @param {string} rawInput 用户输入（可为空）
 * @returns {string}
 */
export function renderCommandBody(body, rawInput) {
  // 薄封装（内部决策-037 批 2 步骤 7b）：渲染语义（`$ARGUMENTS` 替换 + trim）单源在引擎
  // `followup-expansion`；本处以 `startTurn:false` 走"仅回执"分支取渲染结果，端口为拒绝桩
  //（该分支不得入队）。漂移即具名抛错，不静默渲染出第二份策略实现。
  const outcome = getEngine().applyRule(
    'followup-expansion',
    'dsh',
    { body, rawInput, startTurn: false },
    { enqueue: () => { throw new Error('renderCommandBody: 仅回执分支不得入队'); } },
  );
  if (outcome.applied !== true || !outcome.result || typeof outcome.result.body !== 'string') {
    throw new Error('commands-bridge: 规则库字段契约漂移（followup-expansion 缺 params.dsh）——拒载而非静默渲染');
  }
  return outcome.result.body;
}

/**
 * 读一条命令并翻译为 DSH 命令注册输入。
 * 丢弃条件（任一命中即返回 `{skip}`）：frontmatter 不可解析、缺 `description`、
 * 命令名形态非法、正文为空。
 * @param {string} plugin 插件名
 * @param {string} pluginRoot 插件根
 * @param {string} fileName 命令文件名（含 `.md`）
 * @returns {{invocation: object, targetSkill: string|undefined, hint: string|undefined, body: string, path: string}|{skip: string, path: string}}
 */
export function loadCommand(plugin, pluginRoot, fileName) {
  const file = join(pluginRoot, 'commands', fileName);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // 保留真实原因（EACCES/ENOENT/编码错各不相同），否则排查时只剩一句「不可读」——
    // 这正是 skill 反模式清单里的「错误信息黑洞」。skip 走已有的逐条隔离通道。
    return { skip: `命令文件不可读（${error instanceof Error ? error.message : String(error)}）`, path: file };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { skip: `frontmatter 不可解析（${parsed.reason}）`, path: file };
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : '';
  if (description === '') return { skip: '缺少 description', path: file };
  const name = commandNameOf(plugin, basename(fileName, '.md'));
  if (name === '') return { skip: `命令名形态非法（${plugin}/${fileName}）`, path: file };
  const body = parsed.body;
  if (body.trim() === '') return { skip: '正文为空', path: file };
  // `skills:` 是 ZCode 命令的「薄指针」目标（命令正文本身只说"加载某 skill"）
  const rawSkills = parsed.fields.skills;
  const targetSkill = typeof rawSkills === 'string' && rawSkills.trim() !== '' ? skillNameOf(plugin, rawSkills.trim()) : undefined;
  const hint = typeof parsed.fields['argument-hint'] === 'string' ? parsed.fields['argument-hint'].trim() : undefined;
  return {
    path: file,
    body,
    targetSkill,
    hint: hint !== undefined && hint !== '' ? hint : undefined,
    invocation: { name, description, file },
  };
}

/**
 * 收集四个插件下全部可注册命令。
 * @param {Record<string, string>} roots 插件名 → 插件根
 * @returns {{commands: object[], skipped: {plugin: string, file: string, reason: string}[], counts: Record<string, number>}}
 */
export function collectCommands(roots) {
  const commands = [];
  const skipped = [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [plugin, root] of Object.entries(roots)) {
    if (typeof root !== 'string' || root === '') continue;
    let n = 0;
    for (const fileName of commandFileNames(root)) {
      const loaded = loadCommand(plugin, root, fileName);
      if (loaded.skip !== undefined) {
        skipped.push({ plugin, file: fileName, reason: loaded.skip });
        continue;
      }
      commands.push({ plugin, ...loaded });
      n += 1;
    }
    counts[plugin] = n;
  }
  return { commands, skipped, counts };
}

/**
 * 构造命令行（供回显与 `followup` 用）。
 * @param {string} name 命令名（不带斜杠）
 * @param {string} rawInput 用户输入
 * @returns {string}
 */
export function commandLine(name, rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  return input === '' ? `/${name}` : `/${name} ${input}`;
}

/**
 * 本层生成的 id 形态（uuid v4 小写，与宿主工厂自铸的 `brandString(randomUUID())` 同形），供测试复用。
 * 注意区分：**宿主判据**只要求 `user/message` 的 `data.id` 是**非空字符串**
 * （`dsh-session` 的 `assertMessageEventShape`）；本常量钉的是**本层取值形态**——同形取值便于
 * 与会话里宿主自铸的 id 混排时无形态差异，不构成本层对宿主的额外要求。
 */
export const IDENTIFIED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 构造一条 identified user 消息——**本层两个注入面（hook 的 additionalContext 与命令的
 * followup）共用这一份形状实现**。
 *
 * 为什么必须共享：该形状是宿主校验契约的一部分，而同一个形状**已经成对漏过两次字段**——
 * 2026-09-28 第 75/76 批漏 `role`；2026-09-29 第 107 批漏 `id`（内部任务-DSHID-1：缺 `id` 的
 * `user/message` 事件会让整份会话日志在下次加载时被拒，用户看到「历史加载失败」）。
 * 两处各写一份字面量，等于每次契约变更都要成对施工，且漏一处只在运行时才暴露。
 *
 * 字段为什么是这些：宿主 `createUserMessage(input)` = `createMessage({ ...input, role: 'user' })`，
 * 而 `createMessage` 自身是 `deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))`
 * ——`role` 与 `id` 都由宿主工厂补写。本层**不调用**该工厂（它在宿主 asar 内，不是本层依赖），
 * 只能自行合成其输出的字段；缺任一字段宿主在写入时都不会抛（inbox 是 `z.custom()` 透传），
 * 只会在读侧静默缺角色、或让整份日志被拒收。
 * @param {string} text 消息正文
 * @param {string} sourceKind `source.kind`（本层自注入用 `SELF_SOURCE_KIND`，命令展开用 `'user'`）
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: string}}}
 */
export function identifiedUserMessage(text, sourceKind) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } };
}

/**
 * 构造一条面向模型的消息：命令展开语义（`source.kind: 'user'`，与 DSH 自带
 * `/goal <objective>` 的附件消息同 source，正文以用户身份进入对话）。
 *
 * 字段集合（含 `role` 与 `id`）的唯一实现见 `identifiedUserMessage`。
 * @param {string} text
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}}
 */
export function userMessage(text) {
  return identifiedUserMessage(text, 'user');
}

/**
 * 注册一条命令。
 * 处理器把渲染后的命令正文经 `agent.followup` 入队为下一轮提示词（ZCode 的展开语义），
 * 同时把回执文本交给 UI（不产生模型消息的那一半——UI 侧只显示"已展开哪条命令"）。
 * `agent.followup` 缺席（非循环句柄）时退化为「只回执、不驱动」并如实说明。
 * **注册表经参数传入**，不从 ctx 属性读——理由同 `registerSkills`（cordis 的
 * `ctx.<service>` 属性读在 `inject` 未声明时抛 `cannot get property "X" without inject`）。
 * @param {{register: Function}|undefined} commandsService 宿主的命令注册表
 * @param {{plugin: string, invocation: object, body: string, targetSkill?: string, hint?: string}} entry
 * @param {{startTurn?: boolean, logger?: object}} [options]
 * @returns {{name: string, ok: boolean, error?: string, disposer?: Function}}
 */
export function registerCommand(commandsService, entry, options = {}) {
  const startTurn = options.startTurn !== false;
  const logger = options.logger;
  const { name, description } = entry.invocation;
  try {
    // 内部任务-273 M-05：保留宿主注册 disposer（装配层统一回收；旧实现丢弃）。
    const disposer = commandsService.register({
      definitionId: commandDefinitionId(name),
      name,
      description,
      ...(entry.hint !== undefined ? { input: { hint: entry.hint } } : {}),
      handler: (invocation) => {
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
        const line = commandLine(name, rawInput);
        const agent = invocation?.agent;
        const hasHandle = startTurn && typeof agent?.followup === 'function';
        // 引擎驱动（内部决策-037 批 2 步骤 7b）：渲染（`$ARGUMENTS` 替换 + trim）、三态判定与回执极性
        // 全部由 `followup-expansion` 承担；本层只注入端口 `enqueue`（有句柄才真实入队，否则拒绝桩）。
        let outcome;
        try {
          outcome = getEngine().applyRule(
            'followup-expansion',
            'dsh',
            { body: entry.body, rawInput, startTurn: hasHandle },
            { enqueue: (rendered) => { if (!hasHandle) throw new Error('followup-expansion: 无句柄却要求入队'); agent.followup(userMessage(rendered)); } },
          );
        } catch (error) {
          logWarn(logger, `ai-coding-methodology: 命令 ${name} 入队失败（${String(error)}）`);
          return { kind: 'error', text: `命令 ${name} 已解析，但入队失败：${String(error)}` };
        }
        if (outcome.applied !== true) {
          logWarn(logger, `ai-coding-methodology: 命令 ${name} 规则库字段契约漂移（followup-expansion 缺 params.dsh）——按未驱动处理`);
        }
        const rendered = outcome.applied === true && outcome.result && typeof outcome.result.body === 'string'
          ? outcome.result.body
          : '';
        if (outcome.applied === true && outcome.result && outcome.result.driven === true) {
          return { kind: 'success', text: `已展开 ${line}（命令正文作为下一轮提示词入队）` };
        }
        // 无 followup 能力（非循环句柄/显式关闭）：不静默——把渲染后的正文交回 UI，
        // 让用户在下一轮自行粘贴（诚实降级，不假装驱动了 agent）
        return { kind: 'success', text: `命令 ${name} 未驱动 agent（宿主句柄无 followup）。可粘贴以下内容作为下一轮指令：\n\n${rendered}` };
      },
    });
    return { name, ok: true, disposer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(logger, `ai-coding-methodology: 命令 ${name} 注册被拒（${message}）`);
    return { name, ok: false, error: message };
  }
}

/**
 * 批量注册命令（逐条隔离失败，与 skill 面同姿态）。
 * @param {{register: Function}|undefined} commandsService 宿主的命令注册表
 * @param {object[]} commands `collectCommands` 的产出
 * @param {{startTurn?: boolean, logger?: object}} [options]
 * @returns {{registered: number, failed: {name: string, error: string}[], disposers: Function[]}}
 */
export function registerCommands(commandsService, commands, options = {}) {
  const failed = [];
  const disposers = [];
  let registered = 0;
  for (const entry of commands) {
    const r = registerCommand(commandsService, entry, options);
    if (r.ok) {
      registered += 1;
      if (typeof r.disposer === 'function') disposers.push(r.disposer);
    } else failed.push({ name: r.name, error: r.error ?? '未知错误' });
  }
  return { registered, failed, disposers };
}
