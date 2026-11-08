// 文件：读面换源用例（批 3 步骤 3）
// 描述：`planPackage` 的钩子声明读取优先级——**中立清单优先**（分组 + 占位符翻译），生成物
//       `hooks/hooks.json` 仅作兼容回落面；并钉住两条与 DSH 侧同款的语义：①清单**在场即权威**
//       （`hooks: []` 不得回落生成物，否则撤销过的钩子会被陈旧生成物"复活"）；②清单**损坏 ≠ 缺失**
//       （须记 problem，不得静默回落）。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "tests/source-switch.test.mjs"
// 自检：本文件即自检
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { planPackage } from '../cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const roots = [];

/**
 * 造一个最小插件根（只含声明面）：父目录充当"仓库根"，其中 `plugin-core` 软链到真实副本
 * （`planPackage` 会物化引擎闭包，故 repoRoot 下必须有 `plugin-core`）。
 * @param {string} tag 临时目录标签
 * @param {Record<string, string>} files 插件根内的相对路径 → 内容
 * @returns {string} 插件根绝对路径（`dirname` ＋ basename 即 repoRoot 与 plugin 名）
 */
function fixtureRoot(tag, files) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `mcode-switch-${tag}-`)));
  roots.push(base);
  symlinkSync(join(REPO_ROOT, 'plugin-core'), join(base, 'plugin-core'), 'dir');
  const root = join(base, 'workflow'); // 用真件插件名：`PLUGIN_META` 只登记六插件（图标/色相面）
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const MANIFEST_HOOK = JSON.stringify({
  manifestVersion: 1,
  hooks: [{ event: 'SessionStart', matcher: 'startup', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 5000 }],
});
const ARTIFACT_HOOK = JSON.stringify({
  hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 5000 }] }] },
});

const handlersOf = (doc) => Object.entries(doc.hooks).flatMap(([event, groups]) => groups.flatMap((g) => (g.hooks ?? []).map(() => event)));

after(() => {
  for (const root of roots) {
    if ([tmpdir(), realpathSync(tmpdir())].some((p) => root.startsWith(p))) rmSync(root, { recursive: true, force: true });
  }
});

describe('读面换源（批 3 步骤 3）', () => {
  it('仅中立清单：以清单为准（分组 + 占位符翻译为宿主形态）', () => {
    const root = fixtureRoot('manifest', { 'plugin.manifest.json': MANIFEST_HOOK });
    const plan = planPackage({ repoRoot: dirname(root), plugin: root.slice(dirname(root).length + 1), nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hookDoc), ['SessionStart', 'UserPromptSubmit']);
    // 产物是**宿主形态** mcode doc（其占位符是 `${PLUGIN_ROOT}`，由宿主展开）；ZCode 形态的
    // `${ZCODE_PLUGIN_ROOT}` 不得出现在产物里（那说明翻译没做）。
    assert.ok(!JSON.stringify(plan.hookDoc).includes('${ZCODE_PLUGIN_ROOT}'), '不得残留 ZCode 变量');
  });

  it('仅生成物：回落读 hooks/hooks.json（兼容回落面仍可用）', () => {
    const root = fixtureRoot('artifact', { 'hooks/hooks.json': ARTIFACT_HOOK });
    const plan = planPackage({ repoRoot: dirname(root), plugin: root.slice(dirname(root).length + 1), nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hookDoc), ['SessionStart', 'UserPromptSubmit']);
  });

  it('两者冲突：清单权威（不被生成物覆盖）', () => {
    const root = fixtureRoot('conflict', { 'plugin.manifest.json': MANIFEST_HOOK, 'hooks/hooks.json': ARTIFACT_HOOK });
    const plan = planPackage({ repoRoot: dirname(root), plugin: root.slice(dirname(root).length + 1), nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hookDoc), ['SessionStart', 'UserPromptSubmit'], '清单在场即权威');
  });

  it('清单显式空声明：权威空（不得回落生成物复活旧钩子）', () => {
    const root = fixtureRoot('empty', { 'plugin.manifest.json': JSON.stringify({ manifestVersion: 1, hooks: [] }), 'hooks/hooks.json': ARTIFACT_HOOK });
    const plan = planPackage({ repoRoot: dirname(root), plugin: root.slice(dirname(root).length + 1), nodePath: process.execPath });
    assert.deepEqual(handlersOf(plan.hookDoc), [], '空声明即零声明，不得回落');
  });

  it('清单损坏：记 problem（损坏 ≠ 缺失，不得静默回落）', () => {
    const root = fixtureRoot('broken', { 'plugin.manifest.json': '{ 坏 JSON', 'hooks/hooks.json': ARTIFACT_HOOK });
    const plan = planPackage({ repoRoot: dirname(root), plugin: root.slice(dirname(root).length + 1), nodePath: process.execPath });
    assert.ok(plan.problems.some((p) => p.includes('中立清单损坏')), `应记 problem，实得：${JSON.stringify(plan.problems)}`);
  });
});
