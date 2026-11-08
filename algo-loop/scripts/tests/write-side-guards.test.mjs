// 文件：write-side-guards.test.mjs
// 描述：algo-loop 写侧健康门与错误契约测试（内部任务-269 R05/R06/R10/R13；先 RED 后 GREEN）——
//       project 门/资产门/业务门门序、台账健康门（缺失/坏行拒绝且不重建）、baselines schema 门、
//       transition 坏件停报、toolchain.command+version 同权、payload null 干净拒因、I/O 异常干净拒因、
//       singleVariable.note 类型、baselines metrics 数值；全部失败面返回 {ok:false,message} 不抛栈。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/write-side-guards.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyWrite } from '../algo-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..', '..');
const CLI = join(PLUGIN, 'scripts', 'algo-write.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-wguard-'));
  roots.push(root);
  return root;
}

const CONTRACT = (toolchain = { command: 'x', version: 'v1' }) => ({
  schemaVersion: 1,
  version: 1,
  metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain }],
  baselineRef: '',
  targets: {},
  guardrails: [],
});
const ITER = (id = 'i1', over = {}) => ({ id, hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue', ...over });

function seeded(toolchain) {
  const root = makeRoot();
  const r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT(toolchain) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return root;
}

test('project 门缺失或损坏拒绝（R06；缺 project.json/损坏 → 退 1 停下报修）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'ledger-append', ITER());
  assert.equal(r.ok, false);
  assert.match(r.message, /project\.json/);
  const root2 = seeded();
  writeFileSync(join(root2, '.algo', 'project.json'), '{broken');
  const r2 = applyWrite(root2, 'ledger-append', ITER());
  assert.equal(r2.ok, false);
  assert.match(r2.message, /停下报修|不可解析/);
});

test('台账缺失或含坏行时写侧拒绝（R06；不重建、不追加）', () => {
  const root = seeded();
  rmSync(join(root, '.algo', 'ledger.jsonl'));
  const r = applyWrite(root, 'ledger-append', ITER());
  assert.equal(r.ok, false);
  assert.match(r.message, /ledger\.jsonl/);
  assert.equal(existsSync(join(root, '.algo', 'ledger.jsonl')), false, '台账不得被静默重建');
  const root2 = seeded();
  writeFileSync(join(root2, '.algo', 'ledger.jsonl'), '{torn\n');
  const before = readFileSync(join(root2, '.algo', 'ledger.jsonl'), 'utf8');
  const r2 = applyWrite(root2, 'ledger-append', ITER());
  assert.equal(r2.ok, false);
  assert.match(r2.message, /坏行/);
  assert.equal(readFileSync(join(root2, '.algo', 'ledger.jsonl'), 'utf8'), before, '坏台账不得被追加');
});

test('baselines schema 门拒绝（R06/R13；schemaVersion 非 1/缺 entries → 退 1）', () => {
  const root = seeded();
  applyWrite(root, 'ledger-append', ITER());
  writeFileSync(join(root, '.algo', 'baselines.json'), JSON.stringify({ schemaVersion: 2, entries: [] }));
  const r = applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 1 }, fromIteration: 'i1', reason: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /baselines\.json/);
  writeFileSync(join(root, '.algo', 'baselines.json'), JSON.stringify({ schemaVersion: 1 }));
  const r2 = applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 1 }, fromIteration: 'i1', reason: 'x' });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /entries/);
});

test('坏件迁移先过 schema 校验拒绝（R06；case 文件 status 非法/结构不全 → 停下报修）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'badcases', 'c1.json'), JSON.stringify({ id: 'c1', status: 'bogus' }));
  const r = applyWrite(root, 'badcase-transition', { id: 'c1', status: '闭环' });
  assert.equal(r.ok, false);
  assert.match(r.message, /停下报修/);
  writeFileSync(join(root, '.algo', 'badcases', 'c2.json'), 'null');
  const r2 = applyWrite(root, 'badcase-transition', { id: 'c2', status: '闭环' });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /停下报修/);
});

test('toolchain version 空首轮拒绝（R10；command 与 version 同权）', () => {
  const root = seeded({ command: 'x', version: '' });
  const r = applyWrite(root, 'ledger-append', ITER());
  assert.equal(r.ok, false);
  assert.match(r.message, /测量工具链未声明/);
  assert.match(r.message, /version/);
  assert.equal(existsSync(join(root, '.algo', 'ledger.jsonl')) && readFileSync(join(root, '.algo', 'ledger.jsonl'), 'utf8') === '', true, '拒绝时不得半写');
});

test('singleVariable.note 非字符串拒写（R13/§2a 类型口径）', () => {
  const root = seeded();
  const r = applyWrite(root, 'ledger-append', ITER('i1', { singleVariable: { declared: true, note: 42 } }));
  assert.equal(r.ok, false);
  assert.match(r.message, /singleVariable/);
});

test('contract 载荷为 null 干净拒因（R05；不抛栈）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'init', { projectId: 'p', contract: null });
  assert.equal(r.ok, false);
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
  assert.ok(!String(r.message).includes('TypeError'));
});

test('dataRefs 含 null 干净拒因（R05；不抛栈）', () => {
  const root = seeded();
  const r = applyWrite(root, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [null] });
  assert.equal(r.ok, false);
  assert.match(r.message, /dataRefs/);
});

test('case 文件为 null 干净拒因（R05；transition 不抛栈）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'badcases', 'c1.json'), 'null');
  const r = applyWrite(root, 'badcase-transition', { id: 'c1', status: '已归因' });
  assert.equal(r.ok, false);
  assert.ok(!String(r.message).includes('TypeError'));
});

test('契约缺 metrics 时 ledger-append 拒绝（R06；写读对称）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify({ schemaVersion: 1, version: 1 }));
  const r = applyWrite(root, 'ledger-append', ITER());
  assert.equal(r.ok, false);
  assert.match(r.message, /contract\.json/);
});

test('I/O 异常干净拒因（R05；contract.json 被目录占用 → {ok:false} 无栈）', () => {
  const root = seeded();
  rmSync(join(root, '.algo', 'contract.json'));
  mkdirSync(join(root, '.algo', 'contract.json'));
  const r = applyWrite(root, 'ledger-append', ITER());
  assert.equal(r.ok, false);
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
  assert.ok(!String(r.message).includes('TypeError'));
});

test('CLI 失败面无 JS 栈帧（R05；spawn 子进程 stdin contract:null）', () => {
  const root = makeRoot();
  const run = spawnSync(process.execPath, [CLI, 'init', '--project-root', root], {
    encoding: 'utf8',
    input: JSON.stringify({ projectId: 'p', contract: null }),
  });
  assert.equal(run.status, 1);
  assert.ok(!/\n\s+at /.test(run.stderr), `stderr 不应含栈帧：${run.stderr}`);
});

// —— 内部任务-269 评审修复轮（A2 门序锁定 / E1 扩展字段保留）——

test('门序锁定：project 门先于业务门（缺 project + 非法载荷 → project 报修）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'ledger-append', { id: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /project\.json/);
  assert.ok(!r.message.includes('六要素'), '业务载荷校验不得先于 project 门');
});

test('门序锁定：资产门先于业务门（坏台账 + 非法载荷 → 台账报修）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), '{torn\n');
  const r = applyWrite(root, 'ledger-append', { id: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /坏行/);
  assert.ok(!r.message.includes('六要素'), '业务载荷校验不得先于台账资产门');
});

test('台账扩展字段原样入账（strict-backward：未知字段不静默丢弃）', () => {
  const root = seeded();
  const extra = { ...ITER('i1'), notes: '实验附注', tags: ['ab', 'cd'] };
  const r = applyWrite(root, 'ledger-append', extra);
  assert.equal(r.ok, true, JSON.stringify(r));
  const line = readFileSync(join(root, '.algo', 'ledger.jsonl'), 'utf8').trim().split('\n').pop();
  const row = JSON.parse(line);
  assert.equal(row.notes, '实验附注');
  assert.deepEqual(row.tags, ['ab', 'cd']);
  assert.equal(row.singleVariable.declared, true);
});

test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
