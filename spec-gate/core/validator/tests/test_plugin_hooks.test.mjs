// AC-PLUG-002：hook 脚本行为契约（Node 子进程 + 模拟 stdin）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT, MANIFEST_PATH } from './helpers.mjs';

const PLUGIN_ROOT = join(CORE_ROOT, '..');
const SESSION_START = join(PLUGIN_ROOT, 'hooks/session-start.mjs');
const POST_TOOL_USE = join(PLUGIN_ROOT, 'hooks/post-tool-use.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-hook-')));

function runHook(script, payload, project, extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ZCODE_PROJECT_DIR: project, ...extraEnv },
  });
}

test('SessionStart：无台账静默；超期任务/blocking OPEN 注入；坏台账静默', () => {
  const project = tmp();
  let r = runHook(SESSION_START, { hook_event_name: 'SessionStart' }, project);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');

  mkdirSync(join(project, '.sdd'));
  writeFileSync(join(project, '内部治理状态'), JSON.stringify({
    schemaVersion: '1.0',
    tasks: [{ id: '内部任务-1', title: '旧缓解', status: 'temporary-mitigation', createdAt: '2026-08-01T00:00:00+00:00', fastTrack: true, deadline: '2026-08-15T00:00:00+00:00', owner: 'dev' }],
  }));
  r = runHook(SESSION_START, { hook_event_name: 'SessionStart' }, project);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = payload.hookSpecificOutput.additionalContext;
  assert.ok(context.includes('内部任务-1') && context.includes('RULE-LEDGER-002'));

  writeFileSync(join(project, '内部治理状态'), JSON.stringify({
    schemaVersion: '1.0',
    tasks: [],
    openItems: [{ id: '内部未决-1', status: 'open', owner: 'dev', impact: '契约语义未定', blocking: true, resolutionTrigger: '评审', evidence: '无' }],
  }));
  r = runHook(SESSION_START, { hook_event_name: 'SessionStart' }, project);
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('内部未决-1'));

  writeFileSync(join(project, '内部治理状态'), '{broken');
  r = runHook(SESSION_START, { hook_event_name: 'SessionStart' }, project);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('PostToolUse：非受检文件静默；诊断注入；block 档退 2；无配置静默', () => {
  const project = tmp();
  mkdirSync(join(project, '.sdd'));
  mkdirSync(join(project, 'docs'));
  const spec = join(project, 'docs/spec.md');
  writeFileSync(spec, '# 规格\n\nTODO: 待补。\n');
  writeFileSync(join(project, 'unrelated.txt'), 'TODO: anything\n');
  writeFileSync(join(project, '内部治理状态'), JSON.stringify({
    schemaVersion: '1.0.0', suiteRoot: '..', validationRoots: ['docs'],
    documents: [{ path: 'docs/spec.md', documentType: 'note', validationMode: 'baseline' }],
    manifest: MANIFEST_PATH, allowedPublicAssets: [],
  }));
  writeFileSync(join(project, '内部治理状态'), JSON.stringify({
    schemaVersion: '1.0.0', projectRoot: '.', specSystem: 'present', suiteConfig: '内部治理状态', ledgerPath: '内部治理状态',
  }));

  let r = runHook(POST_TOOL_USE, { tool_name: 'Write', tool_input: { file_path: join(project, 'unrelated.txt') } }, project);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');

  r = runHook(POST_TOOL_USE, { tool_name: 'Write', tool_input: { file_path: spec } }, project);
  assert.equal(r.status, 0, r.stderr);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.includes('RULE-内部未决-001'));

  r = runHook(POST_TOOL_USE, { tool_name: 'Write', tool_input: { file_path: spec } }, project, { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: 'true' });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('SDD_HOOK_BLOCK'));

  const empty = join(project, 'empty-dir');
  mkdirSync(empty);
  r = runHook(POST_TOOL_USE, { tool_name: 'Write', tool_input: { file_path: spec } }, empty);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});
