// RULE-OPT-001..004：opt-out 裁决与恢复（含 F-15 坏时间/未知 mode，F-7 oracle 执行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../core/pycompat.mjs';
import { effectiveSuppressedScopes, restore, ruleIdsForNotes } from '../core/optout.mjs';

const rec = (over = {}) => ({ scope: 'all', mode: 'persistent', reason: 'r', createdAt: '2026-01-01T00:00:00+00:00', createdBy: 'dev', taskId: null, expiresAt: null, sourceMechanism: 'm', ...over });

test('scope 包含关系：all 覆盖全部；ddd 覆盖 ddd-strategic', () => {
  const [a] = effectiveSuppressedScopes([rec()], '2026-09-03T12:00:00+00:00');
  assert.deepEqual([...a].sort(), ['all', 'ddd', 'ddd-strategic', 'sdd', 'tdd']);
  const [b] = effectiveSuppressedScopes([rec({ scope: 'ddd' })], '2026-09-03T12:00:00+00:00');
  assert.deepEqual([...b].sort(), ['ddd', 'ddd-strategic']);
});

test('current-task：缺 taskId / 任务不匹配 → 说明且不抑制', () => {
  const [a, na] = effectiveSuppressedScopes([rec({ scope: 'sdd', mode: 'current-task' })], '2026-09-03T12:00:00+00:00', 't1');
  assert.equal(a.size, 0);
  assert.ok(na.some((n) => n.startsWith('missing-task-id')));
  const [b, nb] = effectiveSuppressedScopes([rec({ scope: 'sdd', mode: 'current-task', taskId: 'other' })], '2026-09-03T12:00:00+00:00', 't1');
  assert.equal(b.size, 0);
  assert.ok(nb.some((n) => n.startsWith('task-mismatch')));
});

test('F-3：naive expiresAt 与 aware now 混比按 UTC，不崩溃', () => {
  const [future, notesFuture] = effectiveSuppressedScopes(
    [rec({ expiresAt: '2026-12-31T00:00:00' })], '2026-10-19T00:00:00+00:00',
  );
  assert.equal(future.has('all'), true);
  assert.equal(notesFuture.some((n) => n.startsWith('expired-cleaned')), false);
  const [past, notesPast] = effectiveSuppressedScopes(
    [rec({ expiresAt: '2026-01-01T00:00:00' })], '2026-10-19T00:00:00+00:00',
  );
  assert.equal(past.size, 0);
  assert.ok(notesPast.some((n) => n.startsWith('expired-cleaned')));
});

test('到期记录不生效；显式启用覆盖全部', () => {
  const [a, na] = effectiveSuppressedScopes([rec({ expiresAt: '2026-01-01T00:00:00+00:00' })], '2026-09-03T12:00:00+00:00');
  assert.equal(a.size, 0);
  assert.ok(na.some((n) => n.startsWith('expired-cleaned')));
  const [b, nb] = effectiveSuppressedScopes([rec()], '2026-09-03T12:00:00+00:00', null, true);
  assert.equal(b.size, 0);
  assert.ok(nb.some((n) => n.startsWith('explicit-enable')));
});

test('F-15：坏 expiresAt / 未知 mode 产说明而非崩溃；坏 now 抛 ConfigError', () => {
  const [, n1] = effectiveSuppressedScopes([rec({ expiresAt: 'bogus' })], '2026-09-03T12:00:00+00:00');
  assert.ok(n1.some((n) => n.startsWith('invalid-expires')));
  const [s2, n2] = effectiveSuppressedScopes([rec({ mode: 'weird' })], '2026-09-03T12:00:00+00:00');
  assert.equal(s2.size, 0);
  assert.ok(n2.some((n) => n.startsWith('invalid-mode')));
  assert.throws(() => effectiveSuppressedScopes([rec()], 'bogus'), ConfigError);
});

test('restore：移除、仍被更广 scope 覆盖、未知 scope 不崩溃', () => {
  const records = [rec({ scope: 'sdd' }), rec()];
  const [remaining, still, notes] = restore(records, 'sdd');
  assert.equal(remaining.length, 1);
  assert.equal(still, true);
  assert.ok(notes.some((n) => n.startsWith('still-suppressed')));
  const [rem2, still2, notes2] = restore([rec({ scope: 'sdd' }), rec({ scope: 'alien' })], 'sdd');
  assert.equal(rem2.length, 1);
  assert.equal(still2, false);
  assert.ok(notes2.some((n) => n.startsWith('unknown-scope')));
});

test('F-7：note→ruleId 映射（oracle 执行由 test_fixture_execution 单点覆盖）', () => {
  assert.deepEqual(ruleIdsForNotes(['missing-task-id: x']), ['RULE-OPT-003']);
  assert.deepEqual(ruleIdsForNotes(['expired-cleaned: x']), []);
});
