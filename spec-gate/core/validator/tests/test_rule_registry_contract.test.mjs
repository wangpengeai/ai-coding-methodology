// AC-RULE-001：稳定规则注册表契约——每条硬要求都有检查、证据、失败动作、豁免策略。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_DOMAINS, BLOCKING_QUAD, CORE_ROOT, MANIFEST_PATH, OWNERS, RULE_FIELDS,
  SCHEMAS_DIR, SEVERITIES, loadJson,
} from './helpers.mjs';

const RULE_ID_PATTERN = /^RULE-([A-Z]+)-(\d{3})$/;
const REQUIRED_BLOCKING_DOMAINS = [
  'FLOW', 'SPEC', 'DDD', 'TDD', 'FAST', 'OPT', 'BACKFILL', 'ADR', 'OPEN', 'PATH',
  'CORE', 'PACK', 'MIG', 'HOST', 'ROUTE', 'IF', 'PLAN',
];

const registry = loadJson(`${SCHEMAS_DIR}/rule_registry.json`);
const manifest = loadJson(MANIFEST_PATH);
const rules = registry.rules;

test('注册表非空且每条规则字段齐全', () => {
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    const missing = RULE_FIELDS.filter((f) => !(f in rule));
    assert.deepEqual(missing, [], `${rule.ruleId ?? '?'} 缺少字段: ${missing}`);
  }
});

test('ruleId 格式、域白名单与唯一性', () => {
  const seen = new Set();
  for (const rule of rules) {
    const m = RULE_ID_PATTERN.exec(rule.ruleId);
    assert.ok(m, `ruleId 格式必须为 RULE-<DOMAIN>-NNN: ${rule.ruleId}`);
    assert.ok(ALLOWED_DOMAINS.includes(m[1]), `未知规则域: ${m[1]} (${rule.ruleId})`);
    assert.equal(seen.has(rule.ruleId), false, `ruleId 重复: ${rule.ruleId}`);
    seen.add(rule.ruleId);
  }
});

test('severity/owner 枚举与 blocking 四元组', () => {
  for (const rule of rules) {
    assert.ok(SEVERITIES.includes(rule.severity), `非法 severity: ${rule.ruleId}`);
    assert.ok(OWNERS.includes(rule.owner), `非法 owner: ${rule.ruleId}`);
    if (rule.severity !== 'blocking') continue;
    for (const field of BLOCKING_QUAD) {
      assert.equal(typeof rule[field], 'string', `${rule.ruleId}.${field} 必须为字符串`);
      assert.ok(rule[field].trim(), `blocking 规则四元组字段不得为空: ${rule.ruleId}.${field}`);
    }
  }
});

test('statement/appliesWhen 非空、退役 ID 不复用、必需域有 blocking 规则', () => {
  for (const rule of rules) {
    assert.ok(String(rule.statement).trim(), `statement 不得为空: ${rule.ruleId}`);
    assert.ok(String(rule.appliesWhen).trim(), `appliesWhen 不得为空: ${rule.ruleId}`);
  }
  const retired = new Set(manifest.retiredRuleIds);
  const active = new Set(rules.map((r) => r.ruleId));
  const overlap = [...retired].filter((id) => active.has(id));
  assert.deepEqual(overlap, [], `已退役规则 ID 被重用: ${overlap}`);
  const domainsWithBlocking = new Set(
    rules.filter((r) => r.severity === 'blocking').map((r) => RULE_ID_PATTERN.exec(r.ruleId)[1]),
  );
  const missing = REQUIRED_BLOCKING_DOMAINS.filter((d) => !domainsWithBlocking.has(d));
  assert.deepEqual(missing, [], `以下域缺少 blocking 规则: ${missing}`);
});

test('F-6：RULE-PLAN-001/002 已登记且 PLAN 域存在', () => {
  const ids = new Set(rules.map((r) => r.ruleId));
  assert.ok(ids.has('RULE-PLAN-001'));
  assert.ok(ids.has('RULE-PLAN-002'));
  assert.ok(rules.some((r) => r.ruleId === 'RULE-PLAN-001' && r.severity === 'blocking'));
});

test('F-6：代码发射集 ⊆ 注册表（源码扫描防回退）', () => {
  const validatorRoot = join(CORE_ROOT, 'validator');
  const files = [
    ...readdirSync(validatorRoot, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => join(validatorRoot, e.name)),
    ...readdirSync(join(validatorRoot, 'core'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => join(validatorRoot, 'core', e.name)),
    ...readdirSync(join(validatorRoot, 'tools'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => join(validatorRoot, 'tools', e.name)),
  ];
  const registered = new Set(rules.map((r) => r.ruleId));
  const emitted = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/RULE-[A-Z]+-[0-9]{3}/g)) emitted.add(m[0]);
  }
  const unknown = [...emitted].filter((id) => !registered.has(id)).sort();
  assert.deepEqual(unknown, [], `代码发射但未注册的 ruleId: ${unknown}`);
});
