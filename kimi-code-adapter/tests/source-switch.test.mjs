// 文件：kimi-code-adapter/tests/source-switch.test.mjs
// 描述：读面换源用例（内部决策-036 决策 6 在第四宿主适配层的实例化）——`planPackage` 的钩子
//       声明读取优先级：**中立清单 `plugin.manifest.json` 在场即权威**；清单**缺失**才回落
//       生成物 `hooks/hooks.json`（兼容回落面）；清单显式空声明（hooks: []）不得回落
//       （否则撤销过的钩子会被陈旧生成物复活）；清单**损坏 ≠ 缺失**（记 problem 不静默
//       回落——那会把撤销过的钩子复活）。与 DSH 侧 `readManifestHookConfig` 同款两态语义。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { planPackage } from '../cli.mjs';
import { REPO_ROOT } from './helpers.mjs';

const roots = [];

/**
 * 造一个最小插件根（只含声明面）：父目录充当"仓库根"，其中 `plugin-core` 软链到真实副本
 * （`planPackage` 会物化引擎闭包，故 repoRoot 下必须有 `plugin-core`）。
 * @param {string} tag 临时目录标签
 * @param {Record<string, string>} files 插件根内的相对路径 → 内容
 * @returns {string} 插件根绝对路径（`dirname` ＋ basename 即 repoRoot 与 plugin 名）
 */
function fixtureRoot(tag, files) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `kimi-switch-${tag}-`)));
  roots.push(base);
  symlinkSync(join(REPO_ROOT, 'plugin-core'), join(base, 'plugin-core'), 'dir');
  const root = join(base, 'workflow'); // 用真件插件名：清单生成与面判据按六插件名走
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const MANIFEST_HOOK = JSON.stringify({
  manifestVersion: 1,
  name: 'workflow',
  version: '0.0.1',
  description: '夹具',
  author: 'tester',
  hooks: [{ event: 'SessionStart', matcher: 'startup', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 5000 }],
});
const ARTIFACT_HOOK = JSON.stringify({
  hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 5000 }] }] },
});

const handlersOf = (hooks) => hooks.map((entry) => entry.event);

after(() => {
  for (const root of roots) {
    if ([tmpdir(), realpathSync(tmpdir())].some((p) => root.startsWith(p))) rmSync(root, { recursive: true, force: true });
  }
});

describe('读面换源（中立清单权威 + 兼容回落 + 损坏记 problem）', () => {
  it('仅中立清单：以清单为准（hooks[] 直译，无占位符残留）', () => {
    const root = fixtureRoot('manifest', { 'plugin.manifest.json': MANIFEST_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hooks), ['SessionStart', 'PostCompact']);
    assert.ok(!JSON.stringify(plan.hooks).includes('${PLUGIN_ROOT}') && !JSON.stringify(plan.hooks).includes('${ZCODE_PLUGIN_ROOT}'), '产物不得残留中立/ZCode 占位符');
    assert.deepEqual(plan.problems, [], `夹具计划不应有问题：${JSON.stringify(plan.problems)}`);
  });

  it('仅生成物：回落读 hooks/hooks.json（兼容回落面仍可用）', () => {
    const root = fixtureRoot('artifact', { 'hooks/hooks.json': ARTIFACT_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hooks), ['SessionStart', 'PostCompact']);
  });

  it('两者冲突：清单权威（不被生成物覆盖）', () => {
    const root = fixtureRoot('conflict', { 'plugin.manifest.json': MANIFEST_HOOK, 'hooks/hooks.json': ARTIFACT_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hooks), ['SessionStart', 'PostCompact'], '清单在场即权威');
    assert.equal(plan.hooks.length, 2, '清单单条 + workflow PostCompact 一条');
  });

  it('清单显式空声明：权威零声明（不得回落生成物复活旧钩子）', () => {
    const root = fixtureRoot('empty', { 'plugin.manifest.json': JSON.stringify({ manifestVersion: 1, name: 'workflow', version: '0.0.1', description: '夹具', author: 'tester', hooks: [] }), 'hooks/hooks.json': ARTIFACT_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hooks), [], '空声明即零声明，不得回落');
  });

  it('清单损坏：记 problem（损坏 ≠ 缺失，不得静默回落）', () => {
    const root = fixtureRoot('broken', { 'plugin.manifest.json': '{ 坏 JSON', 'hooks/hooks.json': ARTIFACT_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.ok(plan.problems.some((p) => p.includes('中立清单损坏')), `应记 problem，实得：${JSON.stringify(plan.problems)}`);
    assert.deepEqual(handlersOf(plan.hooks), [], '损坏时不得静默回落生成物（把撤销过的钩子复活）');
  });

  it('中立清单 hooks 非数组：记 problem（不得静默零声明）', () => {
    const root = fixtureRoot('hooks-shape', { 'plugin.manifest.json': JSON.stringify({ manifestVersion: 1, name: 'workflow', version: '0.0.1', description: '夹具', author: 'tester', hooks: {} }), 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.ok(plan.problems.some((p) => p.includes('hooks 形态非法')), `应记 problem，实得：${JSON.stringify(plan.problems)}`);
    assert.deepEqual(handlersOf(plan.hooks), [], '形态错误不得退化为零声明');
  });

  it('生成物 hooks 字段非对象：记 problem（不得静默零声明）', () => {
    const root = fixtureRoot('artifact-shape', { 'hooks/hooks.json': JSON.stringify({ hooks: 'oops' }), 'hooks/a.mjs': 'process.exit(0);\n' });
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.ok(plan.problems.some((p) => p.includes('生成物钩子声明形态非法')), `应记 problem，实得：${JSON.stringify(plan.problems)}`);
    assert.deepEqual(handlersOf(plan.hooks), [], '形态错误不得退化为零声明');
  });

  it('源资产符号链接：记 problem（不跟随物化）', () => {
    const root = fixtureRoot('symlink-source', { 'plugin.manifest.json': MANIFEST_HOOK, 'hooks/a.mjs': 'process.exit(0);\n' });
    symlinkSync(join(root, 'hooks'), join(root, 'hooks-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const plan = planPackage({ repoRoot: dirname(root), plugin: 'workflow', nodePath: process.execPath });
    assert.ok(plan.problems.some((p) => p.includes('符号链接')), `应记 problem，实得：${JSON.stringify(plan.problems)}`);
    assert.ok(!plan.files.some((f) => f.rel.startsWith('hooks-link')), '链接不得物化');
  });
});
