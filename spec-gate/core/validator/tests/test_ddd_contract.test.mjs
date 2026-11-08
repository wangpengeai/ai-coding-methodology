// AC-DDD-001：战略/战术 DDD schema、适用性标签与模板契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT, SCHEMAS_DIR, loadJson } from './helpers.mjs';
import { checkDddAssets } from '../core/structured.mjs';

const DDD_TEMPLATES = [
  'applicability_matrix', 'subdomain_classification', 'bounded_context_catalog', 'context_map',
  'context_relationships', 'ubiquitous_language', 'event_storming', 'event_timeline',
  'example_mapping', 'decision_table', 'hotspots_and_conflicts', 'entity_value_object_catalog',
  'aggregate_invariants', 'domain_event_catalog', 'domain_service_decisions',
  'repository_port_boundaries', 'failure_semantics', 'domain_traceability', 'ddd_completion_report',
];
const LABELS = ['始终必需', '条件更新', '允许 N/A', '允许替代建模'];

test('ddd_assets schema 18 个 section / 标签枚举 / 影响结论 / 替代证据枚举 / 上下文关系字段', () => {
  const schema = loadJson(join(SCHEMAS_DIR, 'ddd_assets.schema.json'));
  for (const section of [
    'applicability', 'subdomains', 'boundedContexts', 'contextMap', 'contextRelationships',
    'ubiquitousLanguage', 'eventStorming', 'eventStormingAlternatives', 'hotspots', 'entities',
    'valueObjects', 'aggregates', 'domainEvents', 'domainServices', 'repositoryBoundaries',
    'failureSemantics', 'traceability', 'impactConclusions',
  ]) assert.ok(section in schema.properties, `缺少 section: ${section}`);
  assert.deepEqual([...schema.properties.applicability.items.properties.label.enum].sort(), ['alternative-model-allowed', 'always-required', 'conditional', 'na-allowed']);
  for (const f of ['aggregateBoundaryImpact', 'failureSemanticsImpact']) assert.ok(f in schema.properties.impactConclusions.properties);
  assert.deepEqual([...schema.properties.eventStormingAlternatives.items.properties.type.enum].sort(), ['decision-table', 'event-timeline', 'example-mapping']);
  const rel = schema.properties.contextRelationships.items;
  for (const f of ['upstream', 'downstream', 'integrationPattern', 'contractOwner']) {
    assert.ok(f in rel.properties && rel.required.includes(f), `contextRelationship: ${f}`);
  }
});

test('DDD 19 个模板存在、四类适用标签、无固定架构术语', () => {
  const dir = join(CORE_ROOT, 'templates/ddd');
  const forbidden = ['Clean Architecture', 'presentation 层', 'data 层', 'Flutter', 'Riverpod'];
  for (const name of DDD_TEMPLATES) {
    const path = join(dir, `${name}.template.md`);
    assert.ok(existsSync(path), `缺少 DDD 模板: ${path}`);
    const raw = readFileSync(path, 'utf8');
    assert.ok(raw.includes('documentType:'), `${name} 缺少 documentType`);
    assert.ok(raw.includes('适用标签:'), `${name} 缺少适用标签`);
    for (const label of LABELS) assert.ok(raw.includes(label), `${name} 缺 ${label}`);
    assert.equal(raw.replace(/\{\{/g, '').includes('<'), false, `${name} 不得使用 <...> 占位符`);
    assert.deepEqual(forbidden.filter((t) => raw.includes(t)), [], `${name} 出现固定架构/技术栈术语`);
  }
});

test('DDD fixture ≥5 且 oracle 在位；na-allowed 无理由产 RULE-DDD-004', () => {
  const root = join(CORE_ROOT, 'fixtures/ddd');
  for (const name of ['strategic-valid', 'strategic-missing-context-map', 'tactical-valid', 'event-storming-alternative', 'invalid-na']) {
    assert.ok(existsSync(join(root, name, 'case.json')), `缺少 DDD fixture: ${name}`);
    assert.ok(existsSync(join(root, name, 'oracle.json')), `${name} 缺 oracle`);
  }
  const data = loadJson(join(root, 'invalid-na/input/ddd_assets.json'));
  const ds = checkDddAssets(data, 'input/ddd_assets.json', 'strategic');
  assert.ok(ds.some((d) => d.ruleId === 'RULE-DDD-004'));
});

test('F-16：na-allowed 理由检查限四类资产，热点文案保留既有子串', () => {
  const applicability = [
    { asset: 'subdomain_classification', label: 'na-allowed' },
    { asset: 'context_map', label: 'na-allowed' },
    { asset: 'event_storming', label: 'na-allowed' },
    { asset: 'hotspots', label: 'na-allowed' },
    { asset: 'ubiquitous_language', label: 'na-allowed' },
    { asset: 'traceability', label: 'na-allowed' },
  ];
  const data = {
    applicability, subdomains: [], contextMap: {}, eventStorming: {}, hotspots: [],
    ubiquitousLanguage: [], traceability: [],
  };
  const ds = checkDddAssets(data, 'ddd.json', 'strategic').filter((d) => d.ruleId === 'RULE-DDD-004');
  assert.equal(ds.length, 4);
  assert.equal(ds.some((d) => d.fixHint.includes('ubiquitous_language')), false);
  assert.ok(ds.some((d) => d.fixHint.includes('热点登记为空但未说明理由')));
});
