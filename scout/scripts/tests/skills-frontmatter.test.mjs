// 文件：skills-frontmatter.test.mjs
// 描述：scout 侧 skill frontmatter 规范 lint（workflow 的 check-routing 只管 workflow/skills，
//       scout 侧自建同款最低检查：name/description/license + 触发条件锚点 + 长度）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const EXPECTED = ['scout', 'spike-run', 'disposable-build'];
const MIN_DESCRIPTION_LENGTH = 30;

function parseFrontmatter(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!lines[0] || lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const kv = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  return kv;
}

test('frontmatter：恰有 3 个 skill 目录', () => {
  const dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, [...EXPECTED].sort());
});

function assertFrontmatter(name) {
  const file = join(SKILLS_ROOT, name, 'SKILL.md');
  assert.ok(existsSync(file), `${name}/SKILL.md 必须存在`);
  const fm = parseFrontmatter(readFileSync(file, 'utf8'));
  assert.ok(fm, `${name} frontmatter 必须可解析`);
  assert.equal(fm.name, name);
  assert.equal(fm.license, 'MIT');
  assert.ok((fm.description ?? '').length >= MIN_DESCRIPTION_LENGTH);
  assert.ok((fm.description ?? '').includes('触发条件'));
}

// 标题字面量（不用模板串）：使 parseTestTitles 可解析本文件（内部任务-214 批 2 内部验收-1 主锚要求）。
test('frontmatter：scout 的 SKILL.md 规范齐全', () => assertFrontmatter('scout'));
test('frontmatter：spike-run 的 SKILL.md 规范齐全', () => assertFrontmatter('spike-run'));
test('frontmatter：disposable-build 的 SKILL.md 规范齐全', () => assertFrontmatter('disposable-build'));

// ── 步骤 8（D-12/内部未决-221/补登承诺文案）──

test('T22：scout/README.md 含 research-loop、Node 版本 ≥21 与 sync 补登承诺', () => {
  const root = resolve(SKILLS_ROOT, '..');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('research-loop'), 'README 六件套清单须含 research-loop');
  assert.ok(readme.includes('Node.js ≥ 21'), 'Node 版本镜像须 ≥21（内部未决-221 清偿）');
  assert.ok(readme.includes('sync') && readme.includes('补登'), 'README 须含 sync 补登承诺（T8）');
});

test('补登承诺：SKILL 无「SessionStart 提示 pendingSync」旧文案且含 sync 补登新文案', () => {
  const skill = readFileSync(join(SKILLS_ROOT, 'scout', 'SKILL.md'), 'utf8');
  assert.ok(!/SessionStart 提示/.test(skill), '旧 pendingSync 提示文案须清除');
  assert.ok(skill.includes('桥可用后'), '新承诺须含「桥可用后」');
  assert.ok(skill.includes('check-consistency 仅在桥在场'), '新承诺须含 check-consistency 在场条件');
});

test('T19：SKILL 生命周期命令块使用 <scout 安装根> 占位（非仓库相对）', () => {
  const skill = readFileSync(join(SKILLS_ROOT, 'scout', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('<scout 安装根>/scripts/mode-lifecycle.mjs'), '命令占位须为安装根形态');
  assert.ok(!skill.includes('node scout/scripts/mode-lifecycle.mjs'), '不得仓库相对硬编码');
});

test('T19：templates/mode.json 注记使用 <scout 安装根> 入口占位', () => {
  const tpl = readFileSync(join(SKILLS_ROOT, '..', 'templates', 'mode.json'), 'utf8');
  assert.ok(tpl.includes('<scout 安装根>/scripts/mode-lifecycle.mjs'), '模板注记须为安装根形态');
  assert.ok(!tpl.includes('由 scout/scripts/mode-lifecycle.mjs'), '不得仓库相对硬编码');
});
