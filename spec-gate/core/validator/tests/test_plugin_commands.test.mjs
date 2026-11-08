// AC-PLUG-001：插件命令契约（薄入口：命名、frontmatter、工具引用、无动态 shell）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT } from './helpers.mjs';
import { parseFrontmatter } from '../core/frontmatter.mjs';

const PLUGIN_ROOT = join(CORE_ROOT, '..');
const COMMANDS = join(PLUGIN_ROOT, 'commands');
const NAMES = ['gate', 'init', 'spec', 'backfill', 'evidence'];
const NAME_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/;

test('五个命令存在且命名合规；description 与正文非空', () => {
  for (const name of NAMES) {
    const path = join(COMMANDS, `${name}.md`);
    assert.ok(existsSync(path), `缺少命令: ${path}`);
    assert.ok(NAME_PATTERN.test(name), `命令名不合规: ${name}`);
    const raw = readFileSync(path, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    assert.ok(meta?.description, `${name}: 缺少 description`);
    assert.ok(body.trim(), `${name}: 正文为空`);
    assert.ok([...meta.description].length <= 1024, `${name}: description 超长`);
    assert.equal(raw.includes('!`'), false, `${name}: 禁止动态 shell 片段`);
  }
});

test('命令引用的工具在位（用 stem 断言，兼容 .py 迁移窗口）', () => {
  const tools = { gate: 'sdd_check', init: 'sdd_init', evidence: 'capture_evidence' };
  for (const [name, stem] of Object.entries(tools)) {
    const raw = readFileSync(join(COMMANDS, `${name}.md`), 'utf8');
    assert.ok(raw.includes(stem), `${name}: 未引用工具 ${stem}`);
    assert.ok(existsSync(join(CORE_ROOT, 'validator/tools', `${stem}.mjs`)), `工具不存在: ${stem}.mjs`);
  }
});

test('spec/backfill 命令挂载技能且技能在位', () => {
  for (const [name, skill] of Object.entries({ spec: 'spec-writing', backfill: 'spec-backfill' })) {
    const { meta } = parseFrontmatter(readFileSync(join(COMMANDS, `${name}.md`), 'utf8'));
    assert.equal(meta?.skills, skill, `${name}: 必须挂载技能 ${skill}`);
    assert.ok(existsSync(join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md')), `技能不存在: ${skill}`);
  }
});
