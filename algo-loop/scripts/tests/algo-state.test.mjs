// 文件：algo-state.test.mjs
// 描述：algo-loop 读侧状态读取测试（内部接口-22 §2/§2a + 内部模块-18 内部规则-1/2；含甲案 toolchain 空占位语义）——
//       present/absent/corrupt 三态、坏件/坏行/同 id 去重、openBadcases 计数与 lastIterationAgeDays。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/algo-state.test.mjs"
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readAlgoState } = await import('../algo-state.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-state-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const VALID_METRIC = {
  name: 'example-metric',
  definition: '示例：由项目自建工具链计算并输出',
  direction: 'higher-better',
  unit: 'ratio',
  toolchain: { command: '', version: '' },
};

function writeAlgo(root, parts) {
  const algo = join(root, '.algo');
  mkdirSync(join(algo, 'badcases'), { recursive: true });
  const p = {
    project: { schemaVersion: 1, projectId: 'demo', contractVersion: 1 },
    contract: { schemaVersion: 1, version: 1, metrics: [VALID_METRIC], baselineRef: 'b0', targets: {}, guardrails: [] },
    ledger: '',
    baselines: { schemaVersion: 1, entries: [{ id: 'b0', at: '2026-10-01T00:00:00Z', metrics: { 'example-metric': 0.5 }, fromIteration: '', reason: 'init' }] },
    badcases: {},
    ...parts,
  };
  writeFileSync(join(algo, 'project.json'), JSON.stringify(p.project, null, 2) + '\n');
  writeFileSync(join(algo, 'contract.json'), JSON.stringify(p.contract, null, 2) + '\n');
  writeFileSync(join(algo, 'ledger.jsonl'), p.ledger);
  writeFileSync(join(algo, 'baselines.json'), JSON.stringify(p.baselines, null, 2) + '\n');
  for (const [name, body] of Object.entries(p.badcases)) {
    writeFileSync(join(algo, 'badcases', `${name}.json`), JSON.stringify(body, null, 2) + '\n');
  }
  return algo;
}

const ITERATION = (id, at) =>
  JSON.stringify({ id, at, hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'ref', decision: 'continue' }) + '\n';

test('① 无 .algo/ → present=false, reason=absent, corrupt=[]（纯参数化：任意根可读，不依赖 cwd）', () => {
  const root = makeRoot();
  const s = readAlgoState(root);
  assert.equal(s.present, false);
  assert.equal(s.reason, 'absent');
  assert.deepEqual(s.corrupt, []);
  assert.equal(s.badLines, 0);
});

test('② 五件齐备合法 → present=true 且四要素正确', () => {
  const root = makeRoot();
  const at = new Date(Date.now() - 2 * 86400000).toISOString();
  writeAlgo(root, {
    ledger: ITERATION('i1', at),
    badcases: { c1: { id: 'c1', at, symptom: 's', env: 'field', dataRefs: [{ kind: 'bag', ref: '/x' }], status: '待归因' } },
  });
  const s = readAlgoState(root);
  assert.equal(s.present, true);
  assert.equal(s.contractVersion, 1);
  assert.deepEqual(s.currentBaseline, { id: 'b0', metrics: { 'example-metric': 0.5 } });
  assert.equal(s.openBadcases, 1);
  assert.equal(s.lastIterationAgeDays, 2);
  assert.deepEqual(s.corrupt, []);
});

test('③ project.json schemaVersion=2 → present=false, reason=corrupt', () => {
  const root = makeRoot();
  writeAlgo(root, { project: { schemaVersion: 2, projectId: 'demo', contractVersion: 1 } });
  const s = readAlgoState(root);
  assert.equal(s.present, false);
  assert.equal(s.reason, 'corrupt');
  assert.ok(s.corrupt.includes('project.json'));
});

test('④ project.json 缺 projectId → corrupt 含 project.json', () => {
  const root = makeRoot();
  writeAlgo(root, { project: { schemaVersion: 1, contractVersion: 1 } });
  const s = readAlgoState(root);
  assert.ok(s.corrupt.includes('project.json'));
});

test('⑤ contract.json 损坏但 project.json 合法 → present=true 且 corrupt 含 contract.json；ledger.jsonl 整件缺席 → corrupt 含 ledger.jsonl；badcases/ 目录缺席同权入 corrupt 且不被并存损坏吞没（复审 F6 五件缺席对称+收尾审查修复）', () => {
  const root = makeRoot();
  const algo = writeAlgo(root, {});
  writeFileSync(join(algo, 'contract.json'), '{not-json');
  const s = readAlgoState(root);
  assert.equal(s.present, true);
  assert.ok(s.corrupt.includes('contract.json'));
  const root2 = makeRoot();
  const algo2 = writeAlgo(root2, {});
  rmSync(join(algo2, 'ledger.jsonl'));
  const s2 = readAlgoState(root2);
  assert.equal(s2.present, true);
  assert.ok(s2.corrupt.includes('ledger.jsonl'), '台账缺席须进 corrupt（删台账不得假绿）');
  const root3 = makeRoot();
  rmSync(join(writeAlgo(root3, {}), 'badcases'), { recursive: true, force: true });
  const s3 = readAlgoState(root3);
  assert.ok(s3.corrupt.includes('badcases/'), '目录缺席单现须进 corrupt（init 必建目录，缺席即资产不完整）');
  const root4 = makeRoot();
  const algo4 = writeAlgo(root4, {});
  writeFileSync(join(algo4, 'contract.json'), '{not-json');
  rmSync(join(algo4, 'badcases'), { recursive: true, force: true });
  const s4 = readAlgoState(root4);
  assert.ok(s4.corrupt.includes('contract.json') && s4.corrupt.includes('badcases/'), '并存损坏不得吞没目录缺席信号（旧 corrupt.length===0 守卫缺陷的判别力负例）');
});

test('⑥ ledger 同 id 两行 → 读侧去重取首条', () => {
  const root = makeRoot();
  const at = new Date(Date.now() - 3 * 86400000).toISOString();
  const at2 = new Date(Date.now() - 1 * 86400000).toISOString();
  writeAlgo(root, { ledger: ITERATION('i1', at) + ITERATION('i1', at2) });
  const s = readAlgoState(root);
  assert.equal(s.lastIterationAgeDays, 3);
  assert.equal(s.badLines, 0);
});

test('⑦ 开放枚举未知值（env=field, kind=bag）→ 合法不报 corrupt', () => {
  const root = makeRoot();
  writeAlgo(root, { badcases: { c1: { id: 'c1', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [{ kind: 'bag', ref: '/x' }], status: '待归因' } } });
  const s = readAlgoState(root);
  assert.deepEqual(s.corrupt, []);
  assert.equal(s.openBadcases, 1);
});

test('⑧ badcase status 非法值 → corrupt 含该件名', () => {
  const root = makeRoot();
  writeAlgo(root, { badcases: { c1: { id: 'c1', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'sim', dataRefs: [], status: '已作废' } } });
  const s = readAlgoState(root);
  assert.ok(s.corrupt.some((c) => c.includes('badcases') && c.includes('c1')));
});

test('⑨ baselines 末条=currentBaseline', () => {
  const root = makeRoot();
  writeAlgo(root, {
    baselines: {
      schemaVersion: 1,
      entries: [
        { id: 'b0', at: '2026-10-01T00:00:00Z', metrics: { 'example-metric': 0.5 }, fromIteration: '', reason: 'init' },
        { id: 'b1', at: '2026-10-05T00:00:00Z', metrics: { 'example-metric': 0.6 }, fromIteration: 'i1', reason: 'raise' },
      ],
    },
  });
  const s = readAlgoState(root);
  assert.equal(s.currentBaseline.id, 'b1');
});

test('⑫ toolchain 空占位契约（甲案立项期形态）→ 合法不报 corrupt', () => {
  const root = makeRoot();
  writeAlgo(root, {});
  const s = readAlgoState(root);
  assert.deepEqual(s.corrupt, []);
  assert.equal(s.present, true);
});
