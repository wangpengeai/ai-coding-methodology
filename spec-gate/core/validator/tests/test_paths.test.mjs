// AC-PATH-001 / RULE-PATH-002：路径逃逸、符号链接逃逸、跨根授权与只读树摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathSecurityError, normalizeRelative, resolveCrossRootAsset, resolveWithinRoot,
  treeDigest, treeDigestFingerprint,
} from '../core/paths.mjs';
import { CORE_ROOT, MANIFEST_PATH, loadJson } from './helpers.mjs';

const tmpRoot = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-paths-')));
function fixture() {
  const root = tmpRoot();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/a.md'), '# a\n');
  return root;
}

test('resolveWithinRoot：正常/反斜杠/内部符号链接', (t) => {
  const root = fixture();
  assert.equal(resolveWithinRoot(root, 'docs/a.md'), join(root, 'docs/a.md'));
  assert.equal(resolveWithinRoot(root, 'docs\\a.md'), join(root, 'docs/a.md'));
  try {
    symlinkSync(join(root, 'docs/a.md'), join(root, 'docs/alias.md'));
    assert.equal(resolveWithinRoot(root, 'docs/alias.md'), join(root, 'docs/a.md'));
  } catch (e) {
    t.skip(`无权限创建符号链接: ${e.code}`);
  }
});

test('resolveWithinRoot：.. / 绝对路径 / 盘符 / UNC / NUL 拒绝', () => {
  const root = fixture();
  for (const bad of ['../evil.md', join(root, 'docs/a.md'), '/etc/passwd', 'C:/x', 'C:x', '\\\\server\\share\\x', 'a\0b']) {
    assert.throws(() => resolveWithinRoot(root, bad), PathSecurityError, bad);
  }
  assert.throws(() => normalizeRelative('a/../b'), PathSecurityError);
});

test('resolveWithinRoot：符号链接逃逸拒绝', (t) => {
  const root = fixture();
  const outside = tmpRoot();
  writeFileSync(join(outside, 'secret.md'), 'secret');
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs/link.md'));
  } catch (e) {
    t.skip(`无权限创建符号链接: ${e.code}`);
    return;
  }
  assert.throws(() => resolveWithinRoot(root, 'docs/link.md'), PathSecurityError);
});

test('resolveCrossRootAsset：公开资产放行、未授权/逃逸拒绝', () => {
  const manifest = loadJson(MANIFEST_PATH);
  assert.ok(resolveCrossRootAsset(CORE_ROOT, 'schemas/rule_registry.json', manifest));
  assert.throws(() => resolveCrossRootAsset(CORE_ROOT, 'validator/tests/helpers.mjs', manifest), PathSecurityError);
  assert.throws(() => resolveCrossRootAsset(CORE_ROOT, '../spec-writing/SKILL.md', manifest), PathSecurityError);
});

test('treeDigest：内容变化可检测、与时间戳无关、空目录不记录', () => {
  const root = fixture();
  const d1 = treeDigest(root);
  assert.deepEqual(d1, treeDigest(root));
  mkdirSync(join(root, 'empty'));
  assert.deepEqual(treeDigest(root), d1);
  writeFileSync(join(root, 'docs/a.md'), 'changed\n');
  assert.notDeepEqual(treeDigest(root), d1);
});

test('treeDigest：文件符号链接按目标记录、目录符号链接不递归', (t) => {
  const root = fixture();
  const outside = tmpRoot();
  writeFileSync(join(outside, 'secret.md'), 's');
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs/link.md'));
    symlinkSync(outside, join(root, 'linkdir'));
  } catch (e) {
    t.skip(`无权限创建符号链接: ${e.code}`);
    return;
  }
  const d = treeDigest(root);
  assert.match(d['docs/link.md'], /^symlink:/);
  // Python os.walk 不记录目录符号链接本身
  assert.equal(Object.keys(d).some((k) => k === 'linkdir' || k.startsWith('linkdir/')), false);
});

test('treeDigest：ignoreNames 过滤目录与文件', () => {
  const root = fixture();
  mkdirSync(join(root, '__pycache__'));
  writeFileSync(join(root, '__pycache__/x.pyc'), 'x');
  const d = treeDigest(root, new Set(['__pycache__', '.DS_Store']));
  assert.equal(Object.keys(d).some((k) => k.includes('__pycache__')), false);
  assert.deepEqual(d, treeDigest(root, ['__pycache__', '.DS_Store']));
});

test('treeDigestFingerprint：稳定且内容敏感', () => {
  const a = { 'b.txt': 'sha256:1', 'a.txt': 'sha256:2' };
  const b = { 'a.txt': 'sha256:2', 'b.txt': 'sha256:1' };
  assert.equal(treeDigestFingerprint(a), treeDigestFingerprint(b));
  assert.notEqual(treeDigestFingerprint(a), treeDigestFingerprint({ ...a, 'c.txt': 'sha256:3' }));
});
