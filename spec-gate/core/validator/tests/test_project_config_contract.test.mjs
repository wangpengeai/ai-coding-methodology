// AC-PROJ-001：项目接入配置契约（内部治理状态 的形状）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SCHEMAS_DIR, loadJson } from './helpers.mjs';

test('project_config 顶层字段/required/specSystem 枚举', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'project_config.schema.json'));
  for (const f of ['schemaVersion', 'projectRoot', 'specSystem', 'suiteConfig', 'ledgerPath', 'validationCommands', 'boundaries']) {
    assert.ok(f in schema.properties, `project_config schema 缺少字段: ${f}`);
  }
  for (const f of ['schemaVersion', 'projectRoot', 'specSystem', 'suiteConfig', 'ledgerPath']) {
    assert.ok(schema.required.includes(f), `project_config required 缺少: ${f}`);
  }
  assert.deepEqual([...schema.properties.specSystem.enum].sort(), ['absent', 'partial', 'present']);
});

test('validationCommands 与 boundaries 条目字段', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'project_config.schema.json'));
  const cmd = schema.properties.validationCommands.items;
  for (const f of ['name', 'command', 'workingDirectory', 'selectionCriteria']) assert.ok(f in cmd.properties);
  for (const f of ['name', 'command']) assert.ok(cmd.required.includes(f));
  const rule = schema.properties.boundaries.items;
  for (const f of ['id', 'scope', 'allow', 'deny', 'severity']) assert.ok(f in rule.properties);
  assert.deepEqual([...rule.properties.severity.enum].sort(), ['blocking', 'warning']);
  for (const f of ['id', 'scope']) assert.ok(rule.required.includes(f));
});
