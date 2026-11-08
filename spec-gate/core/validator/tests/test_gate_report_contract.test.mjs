// AC-GATE-001：gate report、命令证据、验收报告与迁移台账的证据契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ACCEPTANCE_STATUSES, COMMAND_EVIDENCE_FIELDS, CONFIRMATION_STATUSES, FINAL_STATUSES,
  GATE_REPORT_FIELDS, GATE_STATUSES, MIGRATION_STATUSES, SCHEMAS_DIR, WAIVER_STATUSES, loadJson,
} from './helpers.mjs';

const schema = (n) => loadJson(join(SCHEMAS_DIR, n));

test('gate_report 字段/required/finalStatus 与 gate 条目契约', () => {
  const s = schema('gate_report.schema.json');
  for (const f of GATE_REPORT_FIELDS) {
    assert.ok(f in s.properties, `gate_report 缺少字段: ${f}`);
    assert.ok(s.required.includes(f), `gate_report required 缺少: ${f}`);
  }
  assert.deepEqual([...s.properties.finalStatus.enum].sort(), [...FINAL_STATUSES].sort());
  const gate = s.properties.gates.items;
  for (const f of ['ruleId', 'status', 'checkMethod', 'evidenceReferences', 'failureAction']) {
    assert.ok(f in gate.properties && gate.required.includes(f), `gate 条目: ${f}`);
  }
  assert.deepEqual([...gate.properties.status.enum].sort(), [...GATE_STATUSES].sort());
  assert.deepEqual([...s.properties.confirmations.items.properties.status.enum].sort(), [...CONFIRMATION_STATUSES].sort());
  assert.deepEqual([...s.properties.waivers.items.properties.status.enum].sort(), [...WAIVER_STATUSES].sort());
});

test('command_evidence 六字段与 acceptance_report 字段/枚举', () => {
  const ce = schema('command_evidence.schema.json');
  for (const f of COMMAND_EVIDENCE_FIELDS) {
    assert.ok(f in ce.properties, `command_evidence 缺少字段: ${f}`);
    assert.ok(ce.required.includes(f), `command_evidence required 缺少: ${f}`);
  }
  const ar = schema('acceptance_report.schema.json');
  for (const f of ['schemaVersion', 'suiteRoot', 'generatedAt', 'selectedCases', 'results', 'blockingPassed', 'blockingFailed', 'unverified', 'finalStatus', 'exitCode']) {
    assert.ok(f in ar.properties, `acceptance_report 缺少字段: ${f}`);
  }
  const result = ar.properties.results.items;
  assert.deepEqual([...result.properties.status.enum].sort(), [...ACCEPTANCE_STATUSES].sort());
  for (const f of ['acceptanceId', 'status', 'blocking', 'evidence']) assert.ok(result.required.includes(f));
});

test('migration_ledger 字段/枚举与 deprecated 条件分支（内部任务-347/内部未决-143：不可达分支已删）', () => {
  const s = schema('migration_ledger.schema.json');
  const entry = s.properties.entries.items;
  for (const f of ['asset', 'status', 'target', 'reason', 'referenceCleanupEvidence']) assert.ok(f in entry.properties);
  assert.deepEqual([...entry.properties.status.enum].sort(), [...MIGRATION_STATUSES].sort());
  assert.equal(entry.if, undefined, 'deprecated 条件分支已删除（枚举从未含该值，属不可达分支——内部任务-347/内部未决-143）');
  assert.equal(entry.then, undefined, '对应的 then 块同批删除');
});
