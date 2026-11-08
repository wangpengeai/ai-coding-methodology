// 文件：skills-frontmatter.test.mjs
// 描述：algo-loop skill frontmatter 三键形态机检（内部模块-18 内部规则-1）——name=目录名/license=MIT/
//       description≥30 字含「触发条件」/公开槽位禁内部编号；frontmatter 只允许三键（真集合断言）。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：把「仅三键」同义反复断言改为顶格键集合 deepEqual（多余键即红）。
// 自检：node --test "algo-loop/scripts/tests/skills-frontmatter.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const INTERNAL_ID_PATTERNS = [
  ['ADR', /\bADR-\d+/],
  ['IF', /\bIF-[A-Z]+-\d+/],
  ['R-M', /\bR-M\d+/],
  ['B-M', /\bB-M\d+/],
  ['OPEN', /\bOPEN-\d+/],
];

const dirs = readdirSync(skillsRoot).filter((d) => existsSync(join(skillsRoot, d, 'SKILL.md')));

test('skills 目录至少含 algo-loop 入口', () => {
  assert.ok(dirs.includes('algo-loop'), `实际技能目录：${dirs.join(',')}`);
});

for (const dir of dirs) {
  test(`frontmatter 形态：${dir}`, () => {
    const raw = readFileSync(join(skillsRoot, dir, 'SKILL.md'), 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, 'frontmatter 围栏存在');
    const fm = m[1];
    const name = fm.match(/^name:\s*(.+)$/m);
    const license = fm.match(/^license:\s*(.+)$/m);
    const desc = fm.match(/^description:\s*(.+)$/m);
    assert.ok(name, '含 name 键');
    assert.equal(name[1].trim(), dir, 'name 等于目录名');
    assert.ok(license, '含 license 键');
    assert.equal(license[1].trim(), 'MIT');
    assert.ok(desc, '含 description 键');
    const description = desc[1].trim();
    assert.ok(description.length >= 30, `description 长度 ${description.length} < 30`);
    assert.ok(description.includes('触发条件'), 'description 含「触发条件」锚');
    for (const [label, pattern] of INTERNAL_ID_PATTERNS) {
      assert.doesNotMatch(description, pattern, `description 禁内部编号（${label} 词形）`);
    }
    const topKeys = fm
      .split('\n')
      .filter((line) => /^[A-Za-z][\w-]*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')).trim())
      .sort();
    assert.deepEqual(topKeys, ['description', 'license', 'name'], `frontmatter 仅 name/description/license 三键（实际 ${topKeys.join(',')}）`);
  });
}
