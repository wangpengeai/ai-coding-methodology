// AC-IF-001：接口资产契约——schema、模板与结构化检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT, SCHEMAS_DIR, loadJson } from './helpers.mjs';
import { checkInterfaces } from '../core/structured.mjs';

const VALID = {
  id: 'IF-Order-1', kind: 'inter-module', ownerModule: 'order-core', consumerModules: ['billing'],
  operations: ['reserveStock(...)'], errorSemantics: ['RES-404 无库存'], lifecycle: 'active',
  version: '2', compatPolicy: 'strict-backward', tracesTo: ['R-12'],
};
const ids = (ds) => ds.map((d) => d.ruleId).sort();
const check = (payload) => checkInterfaces(payload, 'input/spec.json');

test('specification/interface_registry schema 必填与模板段落', () => {
  const spec = loadJson(join(SCHEMAS_DIR, 'specification.schema.json'));
  for (const f of ['id', 'kind', 'ownerModule', 'consumerModules', 'operations', 'errorSemantics', 'lifecycle', 'version', 'compatPolicy', 'tracesTo']) {
    assert.ok(spec.properties.interfaces.items.required.includes(f), `interfaces required 缺少: ${f}`);
  }
  const reg = loadJson(join(SCHEMAS_DIR, 'interface_registry.schema.json'));
  for (const f of ['interfaceId', 'specLocation', 'ownerModule', 'lifecycle', 'version']) {
    assert.ok(reg.properties.entries.items.required.includes(f), `registry entry required 缺少: ${f}`);
  }
  assert.ok('retiredIds' in reg.properties);
  for (const [name, labels] of [
    ['interface.template.md', ['消费方', '错误语义', '生命周期', '冻结基线']],
    ['interface_registry.template.md', ['现行条目', '已退役编号']],
  ]) {
    const raw = readFileSync(join(CORE_ROOT, 'templates/atomic', name), 'utf8');
    for (const label of labels) assert.ok(raw.includes(label), `${name} 缺少段落: ${label}`);
  }
});

test('valid 接口零诊断；缺字段/重复 id → IF-001', () => {
  assert.deepEqual(check({ interfaces: [VALID] }), []);
  const bad = { ...VALID };
  delete bad.tracesTo;
  assert.ok(ids(check({ interfaces: [bad] })).includes('RULE-IF-001'));
  assert.equal(ids(check({ interfaces: [bad] })).includes('RULE-IF-003'), false);
  assert.ok(ids(check({ interfaces: [VALID, { ...VALID }] })).includes('RULE-IF-001'));
});

test('IF-002/003/006 与注册表一致性', () => {
  assert.ok(ids(check({ interfaces: [{ ...VALID, consumerModules: [] }] })).includes('RULE-IF-002'));
  assert.ok(ids(check({ interfaces: [{ ...VALID, lifecycle: 'ga' }] })).includes('RULE-IF-003'));
  assert.ok(ids(check({ interfaces: [{ ...VALID, lifecycle: 'deprecated', deprecation: { migrationNote: 'x' } }] })).includes('RULE-IF-003'));
  const ext = check({ interfaces: [], externalContracts: [{ id: 'legacy' }] });
  assert.ok(ids(ext).includes('RULE-IF-006'));
  assert.ok(ext.every((d) => d.severity === 'warning'));
  assert.ok(ids(check({
    interfaces: [VALID],
    interfaceRegistry: { entries: [{ interfaceId: 'IF-Order-1', lifecycle: 'deprecated', version: '2', ownerModule: 'order-core' }], retiredIds: [] },
  })).includes('RULE-IF-002'));
  assert.ok(ids(check({ interfaces: [VALID], interfaceRegistry: { entries: [], retiredIds: [] } })).includes('RULE-IF-002'));
});

test('F-16：接口资产非对象/坏条目产 RULE-IF-001 而非抛错', () => {
  assert.equal(ids(check(null))[0], 'RULE-IF-001');
  assert.equal(ids(check({ interfaces: [null] }))[0], 'RULE-IF-001');
});
