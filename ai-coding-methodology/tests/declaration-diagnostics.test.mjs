// 文件：declaration-diagnostics.test.mjs
// 描述：内部任务-272 内部未决-238 声明面诊断用例（损坏/丢条目/不支持事件/零声明/真实六插件真值/装配级告警分类/生产 collectHandlers 接线/A-da-2 锚用例）
// 作者：wangp  创建：2026-11-01  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { testEngine } from './helpers/engine-binding.mjs';
import { collectHandlers } from '../src/index.mjs';
import { readHookConfigWithDiagnostics, reportDeclarationDiagnostics } from '../src/hooks-bridge.mjs';

testEngine();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ROOTS = {
  workflow: join(REPO_ROOT, 'workflow'),
  'spec-gate': join(REPO_ROOT, 'spec-gate'),
  scout: join(REPO_ROOT, 'scout'),
  'team-governance': join(REPO_ROOT, 'team-governance'),
  'algo-loop': join(REPO_ROOT, 'algo-loop'),
  'research-loop': join(REPO_ROOT, 'research-loop'),
};

function makeRoot(t, { manifest, zcode } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acm-diag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (manifest !== undefined) {
    writeFileSync(join(root, 'plugin.manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  }
  if (zcode !== undefined) {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), typeof zcode === 'string' ? zcode : JSON.stringify(zcode), 'utf8');
  }
  return root;
}

test('DEV-272 声明面诊断：中立清单与回落均损坏时 config 为零声明且 unreadable 非空', (t) => {
  const root = makeRoot(t, { manifest: '{broken', zcode: '{broken' });
  const d = readHookConfigWithDiagnostics(root);
  assert.deepEqual(d.config, {}, '两源均损坏 → 零声明（fail-open）');
  assert.ok(Object.keys(d.unreadable).length > 0, 'unreadable 非空');
});

test('DEV-272 声明面诊断：单条缺 command 进 dropped（empty-command），其余保留', (t) => {
  const root = makeRoot(t, { manifest: { hooks: [
    { event: 'PreToolUse', command: 'node', args: ['a.mjs'] },
    { event: 'PreToolUse', type: 'process', args: [] },
  ] } });
  const d = readHookConfigWithDiagnostics(root);
  assert.ok(d.config.PreToolUse && d.config.PreToolUse.length === 1, '有效条目保留');
  assert.ok(d.dropped.some((x) => x.reason === 'empty-command'), '缺 command 有诊断');
});

test('DEV-272 声明面诊断：不支持事件进 dropped（event-unsupported），不影响其它事件', (t) => {
  const root = makeRoot(t, { manifest: { hooks: [
    { event: 'PostToolUseFailure', command: 'node' },
    { event: 'Stop', command: 'node' },
  ] } });
  const d = readHookConfigWithDiagnostics(root);
  assert.ok(d.config.Stop && d.config.Stop.length === 1);
  assert.ok(d.dropped.some((x) => x.reason === 'event-unsupported'));
});

test('DEV-272 声明面诊断：合法零声明只 info 不 warn', (t) => {
  const root = makeRoot(t, { manifest: { hooks: [] } });
  const d = readHookConfigWithDiagnostics(root);
  assert.equal(d.declared, 0);
  assert.equal(d.kept, 0);
  const warns = [];
  const infos = [];
  reportDeclarationDiagnostics([{ ...d, plugin: 'zero' }], { warn: (m) => warns.push(m), info: (m) => infos.push(m) });
  assert.equal(warns.length, 0, '零声明不 warn');
  assert.ok(infos.some((m) => /零/.test(m)), '零声明有 info');
});

test('DEV-272 声明面诊断：真实六插件逐插件真值（workflow 11/10，合计 16/17）', () => {
  const { byEvent, plugins } = collectHandlers(ROOTS);
  const m = Object.fromEntries(plugins.map((p) => [p.plugin, p]));
  assert.equal(m.workflow.declared, 11);
  assert.equal(m.workflow.kept, 10);
  assert.equal(m['spec-gate'].declared, 2);
  assert.equal(m.scout.declared, 1);
  assert.equal(m['team-governance'].declared, 2);
  assert.equal(m['algo-loop'].declared, 1);
  assert.equal(m['research-loop'].declared, 0);
  assert.equal(plugins.reduce((n, p) => n + p.declared, 0), 17);
  assert.equal(plugins.reduce((n, p) => n + p.kept, 0), 16);
  assert.ok(byEvent.Stop && byEvent.Stop.length > 0);
});

test('DEV-272 声明面诊断：装配级告警分类（损坏 warn 含插件名/原因计数；零声明不 warn）', (t) => {
  const corrupt = makeRoot(t, { manifest: '{broken', zcode: '{broken' });
  const zero = makeRoot(t, { manifest: { hooks: [] } });
  const dCorrupt = readHookConfigWithDiagnostics(corrupt);
  const dZero = readHookConfigWithDiagnostics(zero);
  const warns = [];
  const infos = [];
  reportDeclarationDiagnostics([
    { ...dCorrupt, plugin: 'corrupt-plugin' },
    { ...dZero, plugin: 'zero-plugin' },
  ], { warn: (m) => warns.push(m), info: (m) => infos.push(m) });
  assert.ok(warns.some((m) => m.includes('corrupt-plugin')), '损坏插件进 warn');
  assert.ok(!warns.some((m) => m.includes('zero-plugin')), '零声明插件不进 warn');
});

// ===== A-da-2 锁定用例：唯一标题（供 spec 锚） =====
test('DEV-272 声明面损坏与 0 处理器可观测告警：清单损坏回落', (t) => {
  const root = makeRoot(t, { manifest: '{broken', zcode: '{broken' });
  const d = readHookConfigWithDiagnostics(root);
  const warns = [];
  reportDeclarationDiagnostics([{ ...d, plugin: 'p' }], { warn: (m) => warns.push(m), info: () => {} });
  assert.ok(warns.length === 1 && warns[0].includes('p'), '一条 warn 含插件名');
});


// ===== 生产装配接线（B4）：index.collectHandlers + sinks → warn 含插件名 =====
test('DEV-272 声明面诊断：生产 collectHandlers 装配接线（损坏根 → warn 含插件名）', (t) => {
  const root = makeRoot(t, { manifest: '{broken', zcode: '{broken' });
  const warns = [];
  collectHandlers({ workflow: root }, { warn: (m) => warns.push(m), info: () => {} });
  assert.ok(warns.some((m) => m.includes('workflow')), '生产装配路径告警含插件名：' + warns.join(' | '));
});
