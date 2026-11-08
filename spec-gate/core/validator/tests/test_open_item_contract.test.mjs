// AC-内部未决-001：结构化未决项契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT, SCHEMAS_DIR, loadJson } from './helpers.mjs';
import { checkOpenItems } from '../core/structured.mjs';

test('open_item schema 字段、编号形态与状态枚举', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'open_item.schema.json'));
  for (const f of ['id', 'status', 'owner', 'impact', 'blocking', 'resolutionTrigger', 'evidence']) {
    assert.ok(f in schema.properties, `open_item 缺少字段: ${f}`);
    assert.ok(schema.required.includes(f), `open_item required 缺少: ${f}`);
  }
  assert.equal(schema.properties.id.pattern, '^OPEN-\\d+$');
  assert.deepEqual([...schema.properties.status.enum].sort(), ['accepted-risk', 'open', 'resolved']);
});

test('accepted-risk 条件必填与模板列', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'open_item.schema.json'));
  const thenRequired = schema.then?.required ?? [];
  assert.ok(thenRequired.includes('riskAcceptanceRationale'));
  assert.ok(thenRequired.includes('riskAcceptanceTrigger'));
  const raw = readFileSync(join(CORE_ROOT, 'templates/atomic/open_items.template.md'), 'utf8');
  for (const label of ['状态', '负责人', '影响', '阻塞性', '收敛触发', '证据']) assert.ok(raw.includes(label), `未决项模板缺少列: ${label}`);
});

test('open_items fixture ≥4 且 oracle 在位', () => {
  const root = join(CORE_ROOT, 'fixtures/open_items');
  const cases = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(cases.length >= 4);
  for (const c of cases) assert.ok(existsSync(join(root, c.name, 'oracle.json')), `缺 oracle: ${c.name}`);
});

test('F-16：OPEN 非对象/坏条目产 RULE-OPEN-001 而非抛错', () => {
  assert.equal(checkOpenItems(null, 'x.json', 'baseline')[0].ruleId, 'RULE-OPEN-001');
  const ds = checkOpenItems({ items: [null] }, 'x.json', 'baseline');
  assert.equal(ds[0].ruleId, 'RULE-OPEN-001');
});
