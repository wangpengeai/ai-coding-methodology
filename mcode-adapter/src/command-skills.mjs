// 文件：mcode-adapter/src/command-skills.mjs
// 描述：命令面 → skill 物化（内部决策-034 决策 8）。MCode 插件格式**没有命令面**，故：
//       · 薄指针命令（正文即被指向的 skill）由该 skill 直接覆盖，不物化副本
//         ——`plugin-meta.mjs` 的 `COMMAND_DISPOSITION` 逐条登记，`covered-by-skill`
//         条目由测试反查"被指向的 skill 真实存在"；
//       · 操作型命令（自带工具调用步骤或多步编排）物化为**同名** skill，于是宿主暴露的
//         `/<插件名>:<技能名>` 与 ZCode 的斜杠命令名逐字一致（`/team-governance:init`、
//         `/spec-gate:evidence`、`/workflow:feature-dev`…）。
//       物化正文＝命令正文原样 + 来源标注；`$ARGUMENTS` 占位符换成显式说明（宿主不做
//       变量替换，占位符原样留着会让模型去找一个不存在的变量）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COMMAND_DISPOSITION } from './plugin-meta.mjs';

/** 命令正文里的参数占位符（ZCode 侧由宿主替换；MCode 侧无此机制）。 */
const ARGUMENTS_TOKEN = '$ARGUMENTS';

/** 替换后的说明文本。 */
const ARGUMENTS_NOTE = '（本次调用时用户给出的参数）';

/**
 * 极简 frontmatter 解析（只需标量 `key: value`；不支持的形态整体放弃，宁缺勿错析）。
 * @param {string} text 全文
 * @returns {{data: Record<string, string>, body: string}}
 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '').replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].trim();
  }
  return { data, body: match[2] };
}

/**
 * 枚举某插件的命令文件（`commands/*.md`，按名排序）。
 * @param {string} commandsDir 命令目录
 * @returns {string[]} 命令名（不含扩展名）
 */
export function listCommandNames(commandsDir) {
  try {
    return readdirSync(commandsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 命令处置表与真实命令文件的一致性核对（安装期自检 + 测试共用）。
 * @param {string} plugin 插件名
 * @param {string} commandsDir 命令目录
 * @returns {{missing: string[], extra: string[], invalid: string[]}} 三类问题
 */
export function auditDisposition(plugin, commandsDir) {
  const declared = COMMAND_DISPOSITION[plugin] ?? {};
  const actual = listCommandNames(commandsDir);
  const missing = actual.filter((name) => !Object.prototype.hasOwnProperty.call(declared, name));
  const extra = Object.keys(declared).filter((name) => !actual.includes(name));
  const invalid = Object.entries(declared)
    .filter(([, value]) => !['skill', 'covered-by-skill'].includes(value.mode) || (value.mode === 'covered-by-skill' && typeof value.covers !== 'string'))
    .map(([name]) => name);
  return { missing, extra, invalid };
}

/**
 * 生成一份命令型 skill 的内容。
 * @param {{plugin: string, command: string, sourceRel: string, frontmatter: Record<string,string>, body: string}} input 输入
 * @returns {{name: string, rel: string, content: string, description: string}} 技能描述
 */
export function buildCommandSkill(input) {
  const description = String(input.frontmatter.description ?? '').trim();
  const hint = String(input.frontmatter['argument-hint'] ?? '').trim();
  const body = input.body.replaceAll(ARGUMENTS_TOKEN, ARGUMENTS_NOTE).trim();
  const lines = [
    '---',
    `name: ${input.command}`,
    `description: ${description}`,
    '---',
    '',
    `> 来源：ZCode 命令 \`${input.sourceRel}\`（物化自 \`${input.plugin}\` 插件的命令面；MCode 插件格式无命令面，故以同名 skill 承接，斜杠名与 ZCode 一致：\`/${input.plugin}:${input.command}\`）。`,
    hint === '' ? '> 参数：调用时随问题给出。' : `> 参数形态（来自命令的 argument-hint）：\`${hint}\`。`,
    '> 宿主不做变量替换：命令正文里的参数占位符已改写为本说明。',
    '',
  ];
  return {
    name: input.command,
    rel: `skills/${input.command}/SKILL.md`,
    content: `${lines.join('\n')}${body}\n`,
    description,
  };
}

/**
 * 读命令文件并物化（只在该命令被登记为 `mode: "skill"` 时产出）。
 * @param {string} plugin 插件名
 * @param {string} command 命令名
 * @param {string} commandsDir 命令目录
 * @returns {{name: string, rel: string, content: string, description: string}|null}
 */
export function materializeCommandSkill(plugin, command, commandsDir) {
  const disposition = COMMAND_DISPOSITION[plugin]?.[command];
  if (!disposition || disposition.mode !== 'skill') return null;
  const sourceRel = `${plugin}/commands/${command}.md`;
  const { data, body } = parseFrontmatter(readFileSync(join(commandsDir, `${command}.md`), 'utf8'));
  return buildCommandSkill({ plugin, command, sourceRel, frontmatter: data, body });
}
