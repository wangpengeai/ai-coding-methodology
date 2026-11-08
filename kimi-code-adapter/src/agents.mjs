// 文件：kimi-code-adapter/src/agents.mjs
// 描述：agent 面物化（内部决策-038 决策 5）。Kimi 插件 `agents/` **自动发现**（清单不显式声明
//       agents 键），故 --with-agents 开启时把三份只读定位 agent（code-reviewer 工具面含 Bash，非纯只读）物化进包内 `agents/` 目录，
//       frontmatter 直映（Kimi 同字段 name/description/whenToUse/tools/subagents），正文原样。
//       工具词表映射（宿主 24 词词表，差异面 row：四处空缺）：`LS→Glob`（无独立列举工具）、
//       `TodoWrite→TodoList`、`WebFetch→FetchURL`、`WebSearch→WebSearch`（同名）、其余同名直映；
//       `BashOutput→拒`（对位物 TaskOutput 语义不同；只读输出，丢弃不放宽权限）。
//       **映射后为空则不装该 agent 并打 warning**（宁可不装，不给无过滤的子 agent）。
//       挂装门控交引擎规则 `agent-default-off-fail-closed.params.kimi`（defaultMount:false +
//       unknownTool:reject；目录不可得/交集为空 → 拒挂）——规则断言与 内部接口-1 第四宿主登记对拍。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.3/§2.6/§3；内部规格 第四宿主登记

import { parseFrontmatter } from './manifest.mjs';

/** ZCode 工具名 → Kimi 原生工具名（未列出的同名直映；词表映射的单一事实源，测试与 内部接口-1 对拍面）。 */
export const AGENT_TOOL_MAP = Object.freeze({
  LS: 'Glob',
  TodoWrite: 'TodoList',
  WebFetch: 'FetchURL',
});

/** agent 工具白名单里在本宿主无对位、按「拒绝」丢弃的项（只读输出面，丢弃不放宽权限）。 */
export const AGENT_TOOL_DROPPED = Object.freeze(['BashOutput']);

/**
 * ZCode 前言 `tools:` 串 → 本宿主原生工具名数组（映射 + 去重 + 保序；无对位/未知名丢弃并记账）。
 * @param {string} raw ZCode `tools:` 值（逗号分隔）
 * @returns {{tools: string[], dropped: string[]}}
 */
export function mapAgentTools(raw) {
  const tools = [];
  const dropped = [];
  for (const item of String(raw ?? '').split(',')) {
    const name = item.trim();
    if (name === '') continue;
    if (AGENT_TOOL_DROPPED.includes(name)) {
      dropped.push(name);
      continue;
    }
    const mapped = Object.prototype.hasOwnProperty.call(AGENT_TOOL_MAP, name) ? AGENT_TOOL_MAP[name] : name;
    if (!tools.includes(mapped)) tools.push(mapped);
  }
  return { tools, dropped };
}

/**
 * 生成宿主形态的 agent 文档（frontmatter 直映同名字段；tools 以 YAML 列表落 Kimi 词表）。
 * @param {{name: string, description: string, whenToUse: string, tools: string[], subagents: string, body: string}} input 输入
 * @returns {string} 文档全文
 */
export function buildAgentDoc(input) {
  const lines = ['---', `name: ${input.name}`, `description: ${input.description}`];
  if (input.whenToUse !== '') lines.push(`whenToUse: ${input.whenToUse}`);
  lines.push('tools:', ...input.tools.map((tool) => `  - ${tool}`));
  if (input.subagents !== '') lines.push(`subagents: ${input.subagents}`);
  lines.push('---', '');
  return `${lines.join('\n')}${input.body.trim()}\n`;
}

/**
 * 从 ZCode agent 声明生成宿主形态文档（纯函数；不落盘）。
 * @param {string} text 源 agent 全文
 * @param {string} name agent 名（取自文件名）
 * @returns {{name: string, tools: string[], dropped: string[], parts: {name: string, description: string, whenToUse: string, subagents: string, body: string}}}
 */
export function convertAgentText(text, name) {
  const { data, body } = parseFrontmatter(String(text ?? ''));
  const { tools, dropped } = mapAgentTools(data.tools);
  const parts = {
    name,
    description: String(data.description ?? '').trim(),
    whenToUse: String(data.whenToUse ?? '').trim(),
    subagents: String(data.subagents ?? '').trim(),
    body,
  };
  // 只回 parts（文档生成单源＝buildAgentDoc(parts, tools)）：门控前的工具清单不得固化进产物
  return { name, tools, dropped, parts };
}

/**
 * 挂装门控：交引擎规则 `agent-default-off-fail-closed`（kimi 列）——候选工具与宿主目录求交集，
 * 目录不可得/交集为空 → reject（fail-closed 极性：多给一个写工具是约束静默失效，少给一个
 * 读工具只是能力受限）。**停用本函数退回内联放行即红**（engine-materialize 接线判别力）。
 * @param {object} engine 装载好的规则引擎（仓库 plugin-core）
 * @param {string[]} candidates 映射后的 Kimi 工具名候选
 * @param {string[]} directory 宿主工具目录（矩阵 `capabilities.hostToolInventory.kimi`，24 词）
 * @returns {{reject: boolean, reason?: string, defaultMount?: boolean, allowedTools?: string[]}}
 */
export function applyAgentGate(engine, candidates, directory) {
  const outcome = engine.applyRule('agent-default-off-fail-closed', 'kimi', { candidates }, { listRestrictableTools: () => directory });
  if (!outcome.applied || !outcome.result || typeof outcome.result !== 'object') {
    throw new Error('agents: 规则库字段契约漂移（agent-default-off-fail-closed 缺 params.kimi）——拒挂而非静默放行');
  }
  return outcome.result;
}
