// RULE-LEDGER-001..003 / RULE-内部未决-003：任务台账检查（承接 core-mirror 语义钉；F-3/F-16）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../core/pycompat.mjs';
import { checkTaskLedger } from '../core/structured.mjs';

const keys = (d) => Object.keys(d);
const task = (over = {}) => ({ id: 'T-1', title: 'x', status: 'active', createdAt: '2026-01-01T00:00:00+00:00', ...over });

test('缺字段 / 重复 id / 非法状态', () => {
  const ds = checkTaskLedger({ tasks: [{ id: 'T-1' }, task({ id: 'T-1' }), task({ id: 'T-2', status: 'bogus' })] }, '内部治理状态');
  assert.ok(ds.some((d) => d.fixHint.includes('缺少字段')));
  assert.ok(ds.some((d) => d.fixHint.includes('编号重复')));
  assert.ok(ds.some((d) => d.fixHint.includes('非法状态')));
  assert.deepEqual(keys(ds[0]), ['ruleId', 'severity', 'file', 'line', 'fixHint']);
  assert.equal(ds[0].file, '内部治理状态');
  assert.equal(ds[0].line, 1);
});

test('fastTrack 缺 deadline/owner；deadline 超期四种 ISO 形态', () => {
  const base = task({ fastTrack: true, status: 'temporary-mitigation', deadline: '2026-08-15T00:00:00+00:00', owner: 'dev' });
  assert.ok(checkTaskLedger({ tasks: [task({ id: 'T-2', fastTrack: true, status: 'temporary-mitigation' })] }, 'l.json').some((d) => d.fixHint.includes('deadline 与负责人')));
  for (const deadline of ['2026-08-15T00:00:00Z', '2026-08-15T00:00:00+08:00', '2026-08-15T00:00:00.123456+00:00', '2026-08-15T00:00:00']) {
    const ds = checkTaskLedger({ tasks: [{ ...base, deadline }] }, 'l.json', '2026-09-01T00:00:00+00:00');
    assert.ok(ds.some((d) => d.ruleId === 'RULE-LEDGER-002'), deadline);
  }
});

test('非法 deadline → RULE-LEDGER-001；坏 now → ConfigError（F-3）', () => {
  const base = task({ fastTrack: true, status: 'temporary-mitigation', deadline: 'bogus', owner: 'dev' });
  assert.ok(checkTaskLedger({ tasks: [base] }, 'l.json', '2026-09-01T00:00:00+00:00').some((d) => d.fixHint.includes('不是合法 ISO-8601')));
  assert.throws(() => checkTaskLedger({ tasks: [] }, 'l.json', 'bogus'), ConfigError);
});

test('naive/aware 混比按 UTC 解释（不崩溃）', () => {
  const base = task({ fastTrack: true, status: 'temporary-mitigation', deadline: '2026-08-15T00:00:00', owner: 'dev' });
  const ds = checkTaskLedger({ tasks: [base] }, 'l.json', '2026-09-01T00:00:00+00:00');
  assert.ok(ds.some((d) => d.ruleId === 'RULE-LEDGER-002'));
});

test('converged 缺 finalStatus/gateReportRef；openItems/optOuts', () => {
  const ds = checkTaskLedger({
    tasks: [task({ status: 'converged' })],
    openItems: [{ id: 'O-1', status: 'accepted-risk' }],
    optOuts: [{ scope: 'sdd', mode: 'current-task' }],
  }, 'l.json');
  assert.ok(ds.some((d) => d.ruleId === 'RULE-LEDGER-003'));
  assert.ok(ds.some((d) => d.ruleId === 'RULE-内部未决-003'));
  assert.ok(ds.some((d) => d.fixHint.includes('current-task')));
  assert.ok(ds.findIndex((d) => d.ruleId === 'RULE-LEDGER-003') < ds.findIndex((d) => d.ruleId === 'RULE-内部未决-003'));
});

test('F-16：坏形态产诊断而非抛错（顶层/条目/不可迭代字段）', () => {
  assert.ok(checkTaskLedger(null, 'l.json').some((d) => d.ruleId === 'RULE-LEDGER-001'));
  assert.ok(checkTaskLedger({ tasks: 5 }, 'l.json').some((d) => d.fixHint.includes('不可迭代')));
  assert.ok(checkTaskLedger({ tasks: [1], openItems: [2], optOuts: [3] }, 'l.json').some((d) => d.fixHint.includes('须为对象')));
});
