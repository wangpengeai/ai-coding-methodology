// AC-RO-001 / RULE-PATH-001：校验器只读性（受检树与内核树前后摘要一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeDigest, treeDigestFingerprint } from '../core/paths.mjs';
import { CORE_ROOT } from './helpers.mjs';

const VALIDATOR = join(CORE_ROOT, 'validator/validate_specs.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-ro-')));

function project() {
  const root = tmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/spec.md'), '# 规格\n\n| 编号 | 需求 | 追溯 |\n|---|---|---|\n| R-1 | 行为 | [内部需求-1] |\n\nTODO: 待办。\n');
  const config = {
    schemaVersion: '1.0.0', suiteRoot: root, validationRoots: ['docs'],
    documents: [{ path: 'docs/spec.md', documentType: 'note', validationMode: 'baseline' }],
    manifest: join(CORE_ROOT, 'manifest.json'), allowedPublicAssets: [],
  };
  const path = join(root, 'sdd_suite.json');
  writeFileSync(path, JSON.stringify(config));
  return { root, config: path };
}

test('受检树前后摘要一致；内容变化与时间戳无关', () => {
  const { root, config } = project();
  const before = treeDigest(root);
  const r = spawnSync(process.execPath, [VALIDATOR, '--config', config, '--mode', 'baseline', '--format', 'json'], { encoding: 'utf8' });
  assert.ok([0, 1].includes(r.status), r.stderr);
  assert.equal(treeDigestFingerprint(before), treeDigestFingerprint(treeDigest(root)));
  const d1 = treeDigest(root);
  writeFileSync(join(root, 'docs/spec.md'), '# 规格\n\n| 编号 | 需求 | 追溯 |\n|---|---|---|\n| R-1 | 行为 | [内部需求-1] |\n\nTODO: 待办。\n');
  assert.deepEqual(treeDigest(root), d1);
  writeFileSync(join(root, 'docs/spec.md'), 'changed\n');
  assert.notDeepEqual(treeDigest(root), d1);
});

test('F-18：对真实 CORE_ROOT 运行校验器前后摘要一致（工具树零写盘，布局无关）', () => {
  const { config } = project();
  const before = treeDigest(CORE_ROOT, new Set(['__pycache__', '.DS_Store']));
  const r = spawnSync(process.execPath, [VALIDATOR, '--config', config, '--mode', 'baseline', '--format', 'json'], { encoding: 'utf8', timeout: 120000 });
  assert.ok([0, 1].includes(r.status), r.stdout + r.stderr);
  const after = treeDigest(CORE_ROOT, new Set(['__pycache__', '.DS_Store']));
  assert.equal(treeDigestFingerprint(before), treeDigestFingerprint(after), '校验器修改了内核树');
});
