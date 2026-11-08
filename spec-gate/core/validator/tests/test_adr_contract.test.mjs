// AC-内部决策-001：ADR 与 ADR registry 契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADR_STATUSES, CONFIRMATION_STATUSES, CORE_ROOT, SCHEMAS_DIR, loadJson } from './helpers.mjs';
import { checkAdr } from '../core/structured.mjs';

const ADR_FIELDS = ['id', 'status', 'date', 'context', 'decision', 'alternatives', 'selectionRationale', 'consequences', 'evidenceSources', 'confidence', 'supersession', 'traceability', 'confirmationStatus'];
const EVIDENCE_SOURCE_TYPES = ['code', 'tests', 'configuration', 'historical-documentation', 'change-history', 'runtime-observation', 'user-confirmation'];
const CONFIDENCE_LEVELS = ['confirmed', 'high', 'medium', 'low'];

test('ADR schema 必填字段与枚举', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'adr.schema.json'));
  for (const f of ADR_FIELDS) {
    assert.ok(f in schema.properties, `ADR schema 缺少字段: ${f}`);
    assert.ok(schema.required.includes(f), `ADR required 缺少: ${f}`);
  }
  assert.deepEqual([...schema.properties.status.enum].sort(), [...ADR_STATUSES].sort());
  assert.deepEqual([...schema.properties.confidence.enum].sort(), [...CONFIDENCE_LEVELS].sort());
  assert.deepEqual([...schema.properties.confirmationStatus.enum].sort(), [...CONFIRMATION_STATUSES].sort());
  assert.deepEqual([...schema.properties.evidenceSources.items.properties.type.enum].sort(), [...EVIDENCE_SOURCE_TYPES].sort());
  assert.ok('isRetrofitReconstruction' in schema.properties);
});

test('ADR registry schema 与模板段落', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'adr_registry.schema.json'));
  const entry = schema.properties.entries.items;
  for (const f of ['id', 'status', 'supersedes', 'supersededBy']) assert.ok(f in entry.properties, `registry entry 缺少字段: ${f}`);
  assert.ok('retiredIds' in schema.properties);
  const raw = readFileSync(join(CORE_ROOT, 'templates/atomic/adr.template.md'), 'utf8');
  for (const label of ['选择理由', '证据来源', '置信度', '取代关系', '确认状态']) assert.ok(raw.includes(label), `ADR 模板缺少段落: ${label}`);
});

test('ADR fixture ≥5 且 oracle 含 expectedRuleIds', () => {
  const root = join(CORE_ROOT, 'fixtures/adr');
  const cases = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(cases.length >= 5, 'ADR fixture 场景不足');
  for (const c of cases) {
    assert.ok(existsSync(join(root, c.name, 'oracle.json')), `fixture 缺 oracle: ${c.name}`);
    assert.ok('expectedRuleIds' in loadJson(join(root, c.name, 'oracle.json')));
  }
});

test('F-16：ADR 非对象形态产 RULE-内部决策-001 而非抛错', () => {
  assert.equal(checkAdr(null, 'x.json')[0].ruleId, 'RULE-内部决策-001');
  assert.equal(checkAdr([], 'x.json')[0].ruleId, 'RULE-内部决策-001');
});
