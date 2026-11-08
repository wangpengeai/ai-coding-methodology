// 文件：mcode-adapter/src/agents.mjs
// 描述：agent 面物化（内部决策-034 决策 9）。宿主已支持**包内子代理**（清单 `agents: []`），
//       但本层**未适配**（内部未决-255），agent 继续走数据目录安装（`<数据目录>/agents/<名>/agent.md`）并默认关。
//       三份只读定位 agent（code-reviewer 工具面含 Bash，非纯只读）的 frontmatter 形态照宿主
//       内置 agent 复刻（`name`/`description`/`tools`/`skills`/`features`/`x-mavis`），
//       正文原样保留。工具白名单经 `AGENT_TOOL_MAP` 映射到本宿主原生名并去重；无对位的
//       `BashOutput` 按「拒绝」丢弃（只读输出面，丢弃不放宽权限）。
//       **默认不安装**（`--with-agents` 显式开启）：本层从未在跑起来的宿主上观测过委派
//       全过程，保守取舍与 内部决策-032 决策 7 同源。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_TOOL_DROPPED, AGENT_TOOL_MAP } from './plugin-meta.mjs';
import { parseFrontmatter } from './command-skills.mjs';

/**
 * ZCode 前言 `tools:` 串 → 本宿主原生工具名数组（映射 + 去重 + 保序；未知名丢弃并记账）。
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
    const mapped = AGENT_TOOL_MAP[name];
    if (mapped && !tools.includes(mapped)) tools.push(mapped);
    else if (!mapped) dropped.push(name);
  }
  return { tools, dropped };
}

/**
 * 生成宿主形态的 agent 文档。
 * @param {{name: string, description: string, tools: string[], body: string, displayName: string}} input 输入
 * @returns {string} 文档全文
 */
export function buildAgentDoc(input) {
  const lines = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    'tools:',
    ...input.tools.map((tool) => `  - ${tool}`),
    'skills: []',
    'features:',
    '  delegation: false',
    `  webSearch: ${input.tools.includes('web_search') ? 'true' : 'false'}`,
    'x-mavis:',
    `  displayName: ${input.displayName}`,
    '---',
    '',
  ];
  return `${lines.join('\n')}${input.body.trim()}\n`;
}

/**
 * 枚举某插件的 agent 声明（`agents/*.md`）。
 * @param {string} agentsDir agent 目录
 * @returns {string[]} agent 名
 */
export function listAgentNames(agentsDir) {
  try {
    return readdirSync(agentsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch (error) {
    // 只吞「目录不存在」（无 agents 面/首次安装）；EACCES/EBUSY/TOCTOU 等必须上抛——
    // 否则调用方的 fatal 守卫永不可达，`--with-agents --prune` 会在源不可读时把本层
    // agent 删净并静默退 0（内部任务-295 复审 round2 H-1）。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 物化一份 agent 文档到数据目录（先算内容再落盘，便于测试直测纯函数面）。
 * @param {{name: string, content: string}} doc agent 文档
 * @param {string} agentsRoot 数据目录 `agents/`
 * @returns {string} 落盘绝对路径
 */
export function installAgentDoc(doc, agentsRoot) {
  const dir = join(agentsRoot, doc.name);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'agent.md');
  writeFileSync(target, doc.content, 'utf8');
  return target;
}

/**
 * 从 ZCode agent 声明生成宿主形态文档。
 * @param {string} sourcePath ZCode agent 声明路径
 * @param {string} name agent 名（取自文件名）
 * @returns {{name: string, content: string, tools: string[], dropped: string[]}}
 */
export function convertAgentFile(sourcePath, name) {
  const { data, body } = parseFrontmatter(readFileSync(sourcePath, 'utf8'));
  const { tools, dropped } = mapAgentTools(data.tools);
  return {
    name,
    tools,
    dropped,
    content: buildAgentDoc({
      name,
      description: String(data.description ?? '').trim(),
      tools,
      body,
      displayName: name,
    }),
  };
}
