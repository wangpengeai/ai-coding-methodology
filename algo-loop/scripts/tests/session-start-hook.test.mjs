// 文件：session-start-hook.test.mjs
// 描述：algo-loop SessionStart 钩子测试（内部模块-18 内部规则-8/9：三态注入 + fail-open + 信封 + 字段级报修）——
//       absent 零输出、合法摘要四要素、corrupt 字段级报修、坏行计数可见、不读宿主负载、四级根优先级。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：③ corrupt 用例改为字段级损坏样本（corruptDetails）并断言字段细节；
//           seeded 夹具 toolchain.version 补齐（v1）。
// 自检：node --test "algo-loop/scripts/tests/session-start-hook.test.mjs"
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'hooks', 'session-start.mjs');
const { applyWrite } = await import('../algo-write.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-hook-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function runHook(root, input = '', env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ZCODE_PROJECT_DIR: root, ...env },
  });
}

const CONTRACT = {
  schemaVersion: 1,
  version: 1,
  metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'x', version: 'v1' } }],
  baselineRef: 'b0',
  targets: {},
  guardrails: [],
};
const ITER = { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' };

function seeded() {
  const root = makeRoot();
  applyWrite(root, 'init', { projectId: 'demo', contract: CONTRACT });
  applyWrite(root, 'ledger-append', ITER);
  applyWrite(root, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [] });
  return root;
}

function parseEnvelope(stdout) {
  const line = stdout.trim().split('\n').at(-1);
  return JSON.parse(line);
}

test('① 无 .algo/ → 零输出退 0（absent 无提醒）', () => {
  const root = makeRoot();
  const r = runHook(root, '{}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('② 合法五件 → 单行 JSON 信封且摘要含四要素', () => {
  const root = seeded();
  const r = runHook(root, '{}');
  assert.equal(r.status, 0);
  const env = parseEnvelope(r.stdout);
  assert.equal(env.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = env.hookSpecificOutput.additionalContext;
  assert.match(text, /algo-loop/);
  assert.match(text, /契约版本/);
  assert.match(text, /基线/);
  assert.match(text, /未闭环/);
  assert.match(text, /迭代/);
  assert.equal(typeof env.permissionDecision, 'undefined');
});

test('③ corrupt 报修含字段级细节（含「不自动修」），不产 deny/ask', () => {
  const root = seeded();
  // 合法 JSON + 字段级损坏（metrics 含 null）→ 报修行须含件名与字段级错误（内部任务-269 R09）
  writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify({ schemaVersion: 1, version: 1, metrics: [null] }));
  const r = runHook(root, '{}');
  assert.equal(r.status, 0);
  const env = parseEnvelope(r.stdout);
  const text = env.hookSpecificOutput.additionalContext;
  assert.match(text, /contract\.json/);
  assert.match(text, /不自动修/);
  assert.match(text, /metrics/, '报修行须含字段级细节（corruptDetails）');
  assert.equal(typeof env.permissionDecision, 'undefined');
});

test('④ 坏行计数 > 0 → 摘要含坏行行（评审视角二 F1）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), '{torn');
  const r = runHook(root, '{}');
  assert.equal(r.status, 0);
  const env = parseEnvelope(r.stdout);
  assert.match(env.hookSpecificOutput.additionalContext, /坏行/);
});

test('⑤ 空 stdin → 与常态一致（不读宿主负载）', () => {
  const root = seeded();
  const r = runHook(root, '');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('SessionStart'));
});

test('⑥ 垃圾 stdin（非 JSON）→ fail-open 退 0', () => {
  const root = seeded();
  const r = runHook(root, 'not-json-at-all');
  assert.equal(r.status, 0);
});

test('⑦ env 四级根优先级：ZCODE_PROJECT_DIR 胜出', () => {
  const rootA = seeded();
  const rootB = makeRoot();
  const r = runHook(rootB, '{}', { ZCODE_PROJECT_DIR: rootA, QODER_CWD: rootB });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('SessionStart'), '应读 rootA（已立项）而非 rootB');
});
