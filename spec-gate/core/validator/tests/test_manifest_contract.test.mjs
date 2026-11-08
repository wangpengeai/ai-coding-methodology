// AC-CORE-001 / AC-SCHEMA-001：核心内核与 manifest 公开资产契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CORE_ROOT, HOST_FORBIDDEN_SUBSTRINGS, MANIFEST_PATH, PUBLIC_ASSET_FIELDS,
  REQUIRED_MANIFEST_FIELDS, SCHEMAS_DIR, loadJson,
} from './helpers.mjs';

const manifest = loadJson(MANIFEST_PATH);

function walkFiles(dir, predicate) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test('内核无 SKILL.md；manifest 顶层字段与资产字段齐全、assetId 唯一', () => {
  assert.equal(existsSync(join(CORE_ROOT, 'SKILL.md')), false, '共享内核不得包含 SKILL.md');
  const missing = REQUIRED_MANIFEST_FIELDS.filter((f) => !(f in manifest));
  assert.deepEqual(missing, [], `manifest 缺少顶层字段: ${missing}`);
  assert.ok(Array.isArray(manifest.publicAssets) && manifest.publicAssets.length > 0);
  const seen = new Set();
  for (const asset of manifest.publicAssets) {
    const miss = PUBLIC_ASSET_FIELDS.filter((f) => !(f in asset));
    assert.deepEqual(miss, [], `资产缺少字段 ${miss}: ${JSON.stringify(asset)}`);
    assert.equal(seen.has(asset.assetId), false, `assetId 重复: ${asset.assetId}`);
    seen.add(asset.assetId);
  }
});

test('公开资产路径为 POSIX 相对、文件存在、sha256/version 非空', () => {
  for (const asset of manifest.publicAssets) {
    assert.equal(asset.path.includes('\\'), false, `路径必须为 POSIX 相对路径: ${asset.path}`);
    assert.equal(asset.path.startsWith('/'), false, `路径不得为绝对路径: ${asset.path}`);
    assert.equal(asset.path.startsWith('..'), false, `路径不得逃逸核心根: ${asset.path}`);
    const full = join(CORE_ROOT, asset.path);
    assert.ok(existsSync(full), `公开资产文件不存在: ${asset.path}`);
    assert.ok(asset.sha256, `sha256 不得为空: ${asset.path}`);
    assert.ok(asset.version, `version 不得为空: ${asset.path}`);
  }
});

test('sha256 与文件内容一致（F-18：缺失即 fail，不再 continue）', () => {
  for (const asset of manifest.publicAssets) {
    if (asset.path === 'manifest.json') continue;
    const full = join(CORE_ROOT, asset.path);
    assert.ok(existsSync(full), `公开资产文件不存在: ${asset.path}`);
    const actual = `sha256:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
    assert.equal(asset.sha256, actual, `sha256 已过期: ${asset.path}`);
  }
});

test('规则注册表恰一份、schema 曝光面完整、host-examples 不入公开资产', () => {
  const reg = manifest.publicAssets.filter((a) => a.path.endsWith('rule_registry.json'));
  assert.equal(reg.length, 1, '规则注册表实例必须且只能通过 manifest 暴露一份');
  const schemaPaths = new Set(manifest.publicAssets.filter((a) => a.kind === 'schema').map((a) => a.path));
  for (const name of [
    'schemas/manifest.schema.json', 'schemas/rule_registry.schema.json', 'schemas/gate_report.schema.json',
    'schemas/command_evidence.schema.json', 'schemas/acceptance_report.schema.json', 'schemas/migration_ledger.schema.json',
  ]) assert.ok(schemaPaths.has(name), `schema 未通过 manifest 暴露: ${name}`);
  const hostAssets = manifest.publicAssets.filter((a) => a.path.startsWith('host-examples/'));
  assert.deepEqual(hostAssets, [], 'host-examples 不得进入 manifest 公开资产');
  assert.ok(Array.isArray(manifest.retiredRuleIds));
});

test('manifest 与核心规范资产无宿主专用术语', () => {
  const hitsOf = (path) => {
    const raw = readFileSync(path, 'utf8').toLowerCase();
    return HOST_FORBIDDEN_SUBSTRINGS.filter((s) => raw.includes(s));
  };
  assert.deepEqual(hitsOf(MANIFEST_PATH), [], 'manifest 出现宿主专用术语');
  const problems = [];
  for (const path of walkFiles(SCHEMAS_DIR, (p) => p.endsWith('.json'))) {
    const hits = hitsOf(path);
    if (hits.length) problems.push(`${relative(CORE_ROOT, path)}: ${hits}`);
  }
  for (const path of walkFiles(join(CORE_ROOT, 'templates'), (p) => p.endsWith('.md'))) {
    const hits = hitsOf(path);
    if (hits.length) problems.push(`${relative(CORE_ROOT, path)}: ${hits}`);
  }
  const validatorRoot = join(CORE_ROOT, 'validator');
  const scan = [
    ...readdirSync(validatorRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs') && e.name !== 'run_acceptance.mjs')
      .map((e) => join(validatorRoot, e.name)),
    ...readdirSync(join(validatorRoot, 'core'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => join(validatorRoot, 'core', e.name)),
  ];
  for (const path of scan) {
    const hits = hitsOf(path);
    if (hits.length) problems.push(`${relative(CORE_ROOT, path)}: ${hits}`);
  }
  assert.deepEqual(problems, [], '核心规范资产出现宿主专用术语');
});
