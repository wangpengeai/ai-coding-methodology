// RULE-BOUND-001：边界规则形态与扫描（承接 core-mirror 语义钉；F-1 越界/缺失/编码诊断）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundaries, validateBoundaryRules } from '../core/boundaries.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-bound-')));
const rule = (over = {}) => ({ id: 'BOUND-1', scope: 'src', deny: ['from tests import'], allow: [], severity: 'blocking', rationale: 'r', ...over });

test('validateBoundaryRules：形态矩阵与合法样例', () => {
  assert.deepEqual(validateBoundaryRules([rule()]), []);
  const cases = [
    [null, /须为规则对象数组/],
    [[1], /须为对象/],
    [[rule({ id: 'B1' })], /\^BOUND-/],
    [[rule({ scope: '' })], /scope 须为非空字符串/],
    [[rule({ deny: 'x' })], /deny 须为字符串数组/],
    [[rule({ allow: [1] })], /allow 须为字符串数组/],
    [[rule({ severity: 'fatal' })], /severity 须为/],
    [[rule({ rationale: 1 })], /rationale 须为字符串/],
    [[rule({ scope: '../outside' })], /路径安全拒绝/],
    [[rule({ scope: 'C:/abs' })], /路径安全拒绝/],
  ];
  for (const [rules, re] of cases) assert.ok(validateBoundaryRules(rules).some((p) => re.test(p)), String(re));
});

test('checkBoundaries：扫描、allow 优先、warning 档、行号与 fixHint', () => {
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.py'), '# x\nfrom tests import helper\nfrom tests import allowed\n');
  const ds = checkBoundaries(root, [rule({ allow: ['allowed'] })]);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].ruleId, 'RULE-BOUND-001');
  assert.equal(ds[0].line, 2);
  assert.ok(ds[0].fixHint.includes('from tests import helper'));
  const warn = checkBoundaries(root, [rule({ severity: 'warning' })]);
  assert.ok(warn.every((d) => d.severity === 'warning'));
});

test('import 五形态（Python/from/#include/use/require）', () => {
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.py'), 'import internal.secret\n');
  writeFileSync(join(root, 'src/b.py'), 'from internal import secret\n');
  writeFileSync(join(root, 'src/c.c'), '#include "internal/secret.h"\n');
  writeFileSync(join(root, 'src/d.rs'), 'use internal::secret;\n');
  writeFileSync(join(root, 'src/e.js'), "require('./internal/secret')\n");
  const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
  assert.deepEqual(ds.map((d) => d.file).sort(), ['src/a.py', 'src/b.py', 'src/c.c', 'src/d.rs', 'src/e.js']);
});

test('F-1：scope 逃逸/不存在 → blocking；非 UTF-8 → warning', () => {
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.py'), 'import x\n');
  const escape = checkBoundaries(root, [rule({ scope: '../outside' })]);
  assert.ok(escape.some((d) => d.severity === 'blocking' && d.fixHint.includes('路径安全拒绝')));
  const missing = checkBoundaries(root, [rule({ scope: 'nope' })]);
  assert.ok(missing.some((d) => d.severity === 'blocking' && d.fixHint.includes('不存在')));
  writeFileSync(join(root, 'src/b.py'), Buffer.from([0xff, 0xfe]));
  const bad = checkBoundaries(root, [rule()]);
  assert.ok(bad.some((d) => d.severity === 'warning' && d.fixHint.includes('UTF-8')));
});

test('路径排序（a/b.py 先于 a.py）与文件 scope', () => {
  const root = tmp();
  mkdirSync(join(root, 'src/a'), { recursive: true });
  writeFileSync(join(root, 'src/a/b.py'), 'import internal\n');
  writeFileSync(join(root, 'src/a.py'), 'import internal\n');
  const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
  assert.deepEqual(ds.map((d) => d.file), ['src/a/b.py', 'src/a.py']);
  const one = checkBoundaries(root, [rule({ scope: 'src/a.py', deny: ['internal'] })]);
  assert.deepEqual(one.map((d) => d.file), ['src/a.py']);
});

test('BOM 首行不视为空白；CRLF 行号', () => {
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/bom.py'), '\ufeffimport internal\n');
  assert.deepEqual(checkBoundaries(root, [rule({ deny: ['internal'] })]), []);
  writeFileSync(join(root, 'src/crlf.py'), '# x\r\nimport internal\r\n');
  const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
  assert.equal(ds[0].line, 2);
});

test('symlink 文件按目标扫描、symlink 目录不递归', (t) => {
  if (process.platform === 'win32') { t.skip('win32 无稳定 symlink 语义'); return; }
  const root = tmp();
  const outside = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.py'), 'import internal\n');
  writeFileSync(join(outside, 'secret.py'), 'import internal\n');
  try {
    symlinkSync(join(root, 'src/a.py'), join(root, 'src/alias.py'));
    symlinkSync(outside, join(root, 'src/lib'));
  } catch (e) { t.skip(`无权限创建符号链接: ${e.code}`); return; }
  const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
  assert.ok(ds.some((d) => d.file === 'src/a.py'));
  assert.ok(ds.some((d) => d.file === 'src/alias.py'));
  assert.equal(ds.some((d) => d.file.startsWith('src/lib/')), false);
  // F-1：文件级 symlink 逃逸必须在读取前拒绝
  symlinkSync(join(outside, 'secret.py'), join(root, 'src/escape.py'));
  const escape = checkBoundaries(root, [rule({ deny: ['internal'] })]);
  assert.ok(escape.some((d) => d.severity === 'blocking' && d.fixHint.includes('路径安全拒绝')));
  assert.ok(escape.some((d) => d.file === 'src/escape.py'));
});

test('不可读文件 warning（非 root/POSIX）', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('权限位语义不适用'); return; }
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/locked.py'), 'import internal\n');
  chmodSync(join(root, 'src/locked.py'), 0o000);
  try {
    const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
    assert.ok(ds.some((d) => d.fixHint.includes('不可读')));
  } finally {
    chmodSync(join(root, 'src/locked.py'), 0o644);
  }
});

test('F-1：scope 目录不可读 → blocking（非 root/POSIX）', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('权限位语义不适用'); return; }
  const root = tmp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.py'), 'import internal\n');
  chmodSync(join(root, 'src'), 0o000);
  try {
    const ds = checkBoundaries(root, [rule({ deny: ['internal'] })]);
    assert.ok(ds.some((d) => d.severity === 'blocking' && d.fixHint.includes('scope 目录不可读')));
  } finally {
    chmodSync(join(root, 'src'), 0o755);
  }
});
