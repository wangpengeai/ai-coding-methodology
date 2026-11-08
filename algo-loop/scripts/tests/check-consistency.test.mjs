// 文件：check-consistency.test.mjs
// 描述：algo-loop 五件一致性 lint 测试（内部接口-22 跨件一致性 + 内部模块-18 B-M18-4..7 + 坏行计数可见 + 甲案兜底）——
//       consistent/violation 文本与 0/1/2 退出码、fromIteration 悬空、toolchain version、字段级损坏呈报。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：新增 CLI 用法错误退 2/`=` 形态/根守卫、fromIteration 悬空、
//           toolchain.version 违例与 corruptDetails 字段级呈报用例。
// 自检：node --test "algo-loop/scripts/tests/check-consistency.test.mjs"
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SCRIPT = join(import.meta.dirname, '..', 'check-consistency.mjs');
const { applyWrite } = await import('../algo-write.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-cons-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--project-root', root], { encoding: 'utf8' });
}

const CONTRACT = (cmd) => ({
  schemaVersion: 1,
  version: 1,
  metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: cmd, version: 'v1' } }],
  baselineRef: 'b0',
  targets: {},
  guardrails: [],
});
const ITER = (id) => ({ id, hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });

function seeded(toolchainCmd = 'echo measure') {
  const root = makeRoot();
  applyWrite(root, 'init', { projectId: 'demo', contract: CONTRACT(toolchainCmd) });
  return root;
}

test('① 一致态 → stdout 含 consistent 退 0', () => {
  const root = seeded();
  applyWrite(root, 'ledger-append', ITER('i1'));
  const r = run(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /consistent/);
});

test('② contract.version ≠ project.contractVersion → violation 退 1', () => {
  const root = seeded();
  const p = JSON.parse(readFileSync(join(root, '.algo', 'project.json'), 'utf8'));
  p.contractVersion = 7;
  writeFileSync(join(root, '.algo', 'project.json'), JSON.stringify(p, null, 2) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /violation/);
});

test('③ contract.baselineRef 指向不存在的 baselines 条目 → violation', () => {
  const root = seeded();
  const c = JSON.parse(readFileSync(join(root, '.algo', 'contract.json'), 'utf8'));
  c.baselineRef = 'no-such';
  writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify(c, null, 2) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /violation/);
});

test('④ 台账行 metricsRef 为空串 → violation', () => {
  const root = seeded();
  const iter = ITER('i1');
  iter.metricsRef = '';
  // 绕过写侧校验直接构造台账行（写侧拒空 ref，此处验证 lint 面对既成脏态的呈报）
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), JSON.stringify({ ...iter, at: new Date().toISOString() }) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
});

test('⑤ badcase status 非法 → violation', () => {
  const root = seeded();
  applyWrite(root, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [] });
  writeFileSync(join(root, '.algo', 'badcases', 'c1.json'), JSON.stringify({ id: 'c1', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [], status: '已作废' }) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
});

test('⑥ 无 .algo/ → consistent（未立项非违例）', () => {
  const root = makeRoot();
  const r = run(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /consistent/);
});

test('⑦ 台账坏行计数 > 0 → violation 列坏行数（可见不自动修）', () => {
  const root = seeded();
  applyWrite(root, 'ledger-append', ITER('i1'));
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), '{torn line');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /violation/);
  assert.match(r.stdout, /坏行/);
});

test('⑧ 已有台账行而契约 toolchain 空 → violation（甲案既成态兜底）', () => {
  const root = seeded('');
  // 甲案：append 会被写侧拒；此处直接构造既成脏态验证 lint 面
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), JSON.stringify({ ...ITER('i1'), at: new Date().toISOString() }) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /测量工具链/);
});

test('⑨ --selftest 退 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// —— 内部任务-269：CLI 严格参数面 / 新增 lint 违例 / 字段级呈报 ——

test('⑩ --project-root 缺值/未知旗标/根不存在/根为文件 → 退 2（用法错误面）', () => {
  const missing = spawnSync(process.execPath, [SCRIPT, '--project-root'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--project-root', process.cwd(), '--bogus'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  const noSuch = spawnSync(process.execPath, [SCRIPT, '--project-root', '/no/such/algo-root'], { encoding: 'utf8' });
  assert.equal(noSuch.status, 2, '不存在的根不得报 consistent');
  const file = join(mkdtempSync(join(tmpdir(), 'algo-cons-file-')), 'plain.txt');
  writeFileSync(file, 'x');
  const fileRoot = spawnSync(process.execPath, [SCRIPT, '--project-root', file], { encoding: 'utf8' });
  assert.equal(fileRoot.status, 2);
});

test('⑪ --project-root=<dir> 形态可用（一致态退 0）', () => {
  const root = seeded();
  const r = spawnSync(process.execPath, [SCRIPT, `--project-root=${root}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /consistent/);
});

test('⑫ 基线 fromIteration 悬空 → violation（B0 例外；引用存在性只在 lint/写侧）', () => {
  const root = seeded();
  const b = JSON.parse(readFileSync(join(root, '.algo', 'baselines.json'), 'utf8'));
  b.entries.push({ id: 'b1', at: new Date().toISOString(), metrics: { m: 1 }, fromIteration: 'no-such-iter', reason: 'x' });
  writeFileSync(join(root, '.algo', 'baselines.json'), JSON.stringify(b, null, 2) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fromIteration 悬空/);
});

test('⑬ 有台账行而 toolchain.version 空 → violation（R10 lint 半）', () => {
  const root = seeded('');
  writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify({ ...CONTRACT(''), metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'echo ok', version: '' } }] }, null, 2) + '\n');
  // 既成脏态：写侧已拒绝该追加，直接构造合法六要素行验证 lint 面（同既有 ⑧ 手法）
  writeFileSync(join(root, '.algo', 'ledger.jsonl'), JSON.stringify({ ...ITER('i1'), at: new Date().toISOString() }) + '\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /测量工具链/);
  assert.match(r.stdout, /version/);
});

test('⑭ 损坏件呈报含字段级细节（corruptDetails；metrics 含 null 不抛栈）', () => {
  const root = seeded();
  writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify({ ...CONTRACT('echo ok'), metrics: [null] }), 'utf8');
  const r = run(root);
  assert.equal(r.status, 1, `不得抛栈：${r.stderr.slice(0, 300)}`);
  assert.match(r.stdout, /contract\.json/);
  assert.match(r.stdout, /metrics/);
});
