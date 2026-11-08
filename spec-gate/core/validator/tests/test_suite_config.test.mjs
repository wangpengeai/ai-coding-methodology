// 内部变更-12：suite 配置登记面形态校验（documents[].note 与 exemptions）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';

const VALIDATOR = join(CORE_ROOT, 'validator/validate_specs.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-suitecfg-')));

function run(dir, { exemptions, note } = {}) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/spec.md'), '# 文档\n\n正文\n');
  const doc = { path: 'docs/spec.md', documentType: 'glossary', validationMode: 'baseline' };
  if (note !== undefined) doc.note = note;
  const config = {
    schemaVersion: '1.0.0', suiteRoot: dir, validationRoots: ['docs'], documents: [doc],
    manifest: join(CORE_ROOT, 'manifest.json'), allowedPublicAssets: [],
  };
  if (exemptions !== undefined) config.exemptions = exemptions;
  const path = join(dir, 'sdd_suite.json');
  writeFileSync(path, JSON.stringify(config));
  return spawnSync(process.execPath, [VALIDATOR, '--config', path, '--mode', 'baseline', '--format', 'json'], { cwd: CORE_ROOT, encoding: 'utf8' });
}

test('exemptions 非数组/坏条目/与 documents 重复 → 退 2', () => {
  let r = run(tmp(), { exemptions: 'ledger 里说了' });
  assert.equal(r.status, 2);
  assert.ok(JSON.parse(r.stdout).error.includes('exemptions 须为数组'));
  for (const item of [{ path: 'docs/old.md' }, { path: 3, reason: '收窄' }, { path: 'docs/spec.md', reason: '既在册又豁免' }]) {
    r = run(tmp(), { exemptions: [item] });
    assert.equal(r.status, 2, JSON.stringify(item));
    assert.ok(JSON.parse(r.stdout).error.includes('exemptions[0]'));
  }
});

test('note 非字符串 → 退 2；合法 note/exemptions → 退 0', () => {
  let r = run(tmp(), { note: 3 });
  assert.equal(r.status, 2);
  assert.ok(JSON.parse(r.stdout).error.includes('documents[0].note 须为字符串'));
  r = run(tmp(), { note: '示例条目：为何 draft 模式', exemptions: [{ path: 'docs/legacy.md', reason: '收窄裁决：历史文档不可改', ref: 'OPEN-1' }] });
  assert.equal(r.status, 0, r.stdout);
});

test('F-11：manifest 缺失 → ConfigError 退 2 并指名', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/spec.md'), '# 文档\n');
  const config = {
    schemaVersion: '1.0.0', suiteRoot: '.', validationRoots: ['docs'],
    documents: [{ path: 'docs/spec.md', documentType: 'glossary', validationMode: 'baseline' }],
    manifest: 'missing-manifest.json', allowedPublicAssets: [],
  };
  const path = join(dir, 'sdd_suite.json');
  writeFileSync(path, JSON.stringify(config));
  const r = spawnSync(process.execPath, [VALIDATOR, '--config', path, '--mode', 'suite', '--format', 'json'], { cwd: CORE_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(JSON.parse(r.stdout).error.includes('manifest'));
  config.manifest = '';
  writeFileSync(path, JSON.stringify(config));
  const r2 = spawnSync(process.execPath, [VALIDATOR, '--config', path, '--mode', 'suite', '--format', 'json'], { cwd: CORE_ROOT, encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.ok(JSON.parse(r2.stdout).error.includes('manifest'));
});

test('F-11：manifest 相对 suiteRoot 解析（跨 cwd 调用）', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/spec.md'), '# 文档\n');
  // manifest 复制进项目并以相对 suiteRoot 的路径声明，才能真正验证 F-11
  const sdd = join(dir, '.sdd');
  mkdirSync(sdd, { recursive: true });
  copyFileSync(join(CORE_ROOT, 'manifest.json'), join(sdd, 'manifest.json'));
  const config = {
    schemaVersion: '1.0.0', suiteRoot: '..', validationRoots: ['docs'],
    documents: [{ path: 'docs/spec.md', documentType: 'glossary', validationMode: 'baseline' }],
    manifest: '.sdd/manifest.json', allowedPublicAssets: [],
  };
  const path = join(sdd, 'suite.json');
  writeFileSync(path, JSON.stringify(config));
  // suite 模式才消费 manifest；从项目外的 cwd 调用，验证相对 suiteRoot 解析
  const r = spawnSync(process.execPath, [VALIDATOR, '--config', path, '--mode', 'suite', '--format', 'json'], { cwd: tmp(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
