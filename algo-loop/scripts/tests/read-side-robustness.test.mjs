// 文件：read-side-robustness.test.mjs
// 描述：algo-loop 读侧健壮性与字段级诊断测试（内部任务-269 R03/R04/R09/R12/R13/R25；先 RED 后 GREEN）——
//       合法 JSON 的 null 元素/字面 null 件不得抛栈；缺字段/null 元素/坏行/坏件并存按 §2a 契约呈报；
//       corruptDetails 与 badLines 为加法字段；hook 报修与 lint 呈报含字段级细节。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/read-side-robustness.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAlgoState } from '../algo-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..', '..');
const HOOK = join(PLUGIN, 'hooks', 'session-start.mjs');
const LINT = join(PLUGIN, 'scripts', 'check-consistency.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-read-'));
  roots.push(root);
  return root;
}

const VALID_METRIC = { name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'x', version: 'v1' } };
const VALID_CONTRACT = { schemaVersion: 1, version: 1, metrics: [VALID_METRIC], baselineRef: 'b0', targets: {}, guardrails: [] };
const VALID_LEDGER = (id = 'i1', at = '2026-10-01T00:00:00Z') => JSON.stringify({ id, at, hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
const VALID_CASE = (id = 'c1', status = '待归因') => ({ id, at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }], status });

function writeAlgo(root, parts = {}) {
  const algo = join(root, '.algo');
  mkdirSync(join(algo, 'badcases'), { recursive: true });
  const p = {
    project: { schemaVersion: 1, projectId: 'demo', contractVersion: 1 },
    contract: VALID_CONTRACT,
    ledger: VALID_LEDGER(),
    baselines: { schemaVersion: 1, entries: [{ id: 'b0', at: '2026-10-01T00:00:00Z', metrics: { m: 0.5 }, fromIteration: '', reason: 'init' }] },
    badcases: {},
    ...parts,
  };
  writeFileSync(join(algo, 'project.json'), typeof p.project === 'string' ? p.project : JSON.stringify(p.project));
  writeFileSync(join(algo, 'contract.json'), typeof p.contract === 'string' ? p.contract : JSON.stringify(p.contract));
  writeFileSync(join(algo, 'ledger.jsonl'), p.ledger);
  writeFileSync(join(algo, 'baselines.json'), typeof p.baselines === 'string' ? p.baselines : JSON.stringify(p.baselines));
  for (const [name, body] of Object.entries(p.badcases)) {
    writeFileSync(join(algo, 'badcases', `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return algo;
}

function runHook(root) {
  return spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: { ...process.env, ZCODE_PROJECT_DIR: root } });
}

test('metrics 含 null 元素不抛栈（R03；corrupt 与 corruptDetails 均含 contract.json）', () => {
  const root = makeRoot();
  writeAlgo(root, { contract: { ...VALID_CONTRACT, metrics: [null] } });
  const s = readAlgoState(root);
  assert.equal(s.present, true);
  assert.ok(s.corrupt.includes('contract.json'));
  assert.ok(Array.isArray(s.corruptDetails));
  const detail = s.corruptDetails.find((d) => d.file === 'contract.json');
  assert.ok(detail && detail.errors.some((e) => String(e).includes('metrics')));
});

test('entries 含 null 元素不抛栈（R03；baselines corrupt 且字段级呈报）', () => {
  const root = makeRoot();
  writeAlgo(root, { baselines: { schemaVersion: 1, entries: [null] } });
  const s = readAlgoState(root);
  assert.equal(s.present, true);
  assert.ok(s.corrupt.includes('baselines.json'));
  assert.ok(s.corruptDetails.some((d) => d.file === 'baselines.json'));
});

test('字面 null project 报修可见（R04；present=false + corrupt 含 project.json；hook 注入报修行）', () => {
  const root = makeRoot();
  writeAlgo(root, { project: 'null' });
  const s = readAlgoState(root);
  assert.equal(s.present, false);
  assert.equal(s.reason, 'corrupt');
  assert.ok(s.corrupt.includes('project.json'));
  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('project.json'), `hook 应注入报修（stdout=${r.stdout}）`);
  assert.ok(r.stdout.includes('不自动修'));
});

test('contract 缺基线引用 targets guardrails → corrupt（R13；§2a 字段完整性）', () => {
  const root = makeRoot();
  writeAlgo(root, { contract: { schemaVersion: 1, version: 1, metrics: [VALID_METRIC] } });
  const s = readAlgoState(root);
  assert.equal(s.present, true);
  assert.ok(s.corrupt.includes('contract.json'));
  const detail = s.corruptDetails.find((d) => d.file === 'contract.json');
  assert.ok(detail && detail.errors.length > 0);
});

test('baselines 条目缺 fromIteration → corrupt（R13；B0 例外以外必填非空串）', () => {
  const root = makeRoot();
  writeAlgo(root, {
    baselines: { schemaVersion: 1, entries: [{ id: 'b0', at: '2026-10-01T00:00:00Z', metrics: {}, fromIteration: '', reason: 'init' }, { id: 'b1', at: '2026-10-02T00:00:00Z', metrics: { m: 1 }, reason: 'raise' }] },
  });
  const s = readAlgoState(root);
  assert.ok(s.corrupt.includes('baselines.json'));
});

test('baselines metrics 非数值 → corrupt（R13；指标名→有限数值）', () => {
  const root = makeRoot();
  writeAlgo(root, { baselines: { schemaVersion: 1, entries: [{ id: 'b0', at: '2026-10-01T00:00:00Z', metrics: { m: 'n/a' }, fromIteration: '', reason: 'init' }] } });
  const s = readAlgoState(root);
  assert.ok(s.corrupt.includes('baselines.json'));
});

test('坏件并存 openBadcases 精确计数（R12；坏件不中断扫描、件名精确、openBadcases 计 1）', () => {
  const root = makeRoot();
  writeAlgo(root, { badcases: { 'a-break': { ...VALID_CASE('a-break'), dataRefs: [null] }, 'z-open': VALID_CASE('z-open') } });
  const s = readAlgoState(root);
  assert.ok(s.corrupt.some((c) => c.includes('a-break')), `坏件名须精确（corrupt=${JSON.stringify(s.corrupt)}）`);
  assert.equal(s.openBadcases, 1, '后续合法未闭环 case 必须继续统计');
});

test('缺 at 计坏行（R25；声明记入 badLines，摘要不误报「尚无台账行」）', () => {
  const root = makeRoot();
  writeAlgo(root, { ledger: JSON.stringify({ id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' }) + '\n' });
  const s = readAlgoState(root);
  assert.equal(s.badLines, 1);
  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('尚无台账行'), '存在台账行时不得误报「尚无台账行」');
});

test('singleVariable.note 非字符串计坏行（R25/§2a 类型口径）', () => {
  const root = makeRoot();
  writeAlgo(root, { ledger: JSON.stringify({ id: 'i1', at: '2026-10-01T00:00:00Z', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: 42 }, metricsRef: 'r', decision: 'continue' }) + '\n' });
  const s = readAlgoState(root);
  assert.equal(s.badLines, 1);
});

test('lint 对损坏件不抛栈且呈报字段级细节（R03/R09；check-consistency 工具面）', () => {
  const root = makeRoot();
  writeAlgo(root, { contract: { ...VALID_CONTRACT, metrics: [null] } });
  const r = spawnSync(process.execPath, [LINT, '--project-root', root], { encoding: 'utf8' });
  assert.equal(r.status, 1, `lint 应以违例退 1 而非栈（stderr=${r.stderr.slice(0, 300)}）`);
  assert.ok(r.stdout.includes('violation'), `stdout=${r.stdout}`);
  assert.ok(r.stdout.includes('contract.json'));
  assert.ok(r.stdout.includes('metrics'), 'lint 呈报须含字段级细节');
});

test('at 非 ISO-8601 宽松格式计坏行（§2a：拒绝 Date.parse 扩展形态 2026-1-1）', () => {
  const root = makeRoot();
  writeAlgo(root, { ledger: JSON.stringify({ id: 'i1', at: '2026-1-1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' }) + '\n' });
  const s = readAlgoState(root);
  assert.equal(s.badLines, 1);
});

// tmp 目录统一清理
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
