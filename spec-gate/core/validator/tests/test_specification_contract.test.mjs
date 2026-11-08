// AC-SCHEMA-001：原子规格、套件配置与路由用例的 schema/模板契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT, SCHEMAS_DIR, loadJson } from './helpers.mjs';
import { parseFrontmatter } from '../core/frontmatter.mjs';
import { validateDocument } from '../validate_specs.mjs';

const ATOMIC_TEMPLATES = [
  'change_impact', 'minimal_change_draft', 'requirements', 'module_requirement', 'external_contract',
  'interface', 'interface_registry', 'design_decision', 'module_sequence', 'global_sequence',
  'boundaries', 'acceptance_trace', 'adr', 'adr_registry', 'glossary', 'assumptions',
  'open_items', 'review_disposition',
];

test('specification schema 家族/G-T 与 IF 编号形态/externalContracts 弃用', () => {
  const s = loadJson(join(SCHEMAS_DIR, 'specification.schema.json'));
  for (const section of ['requirements', 'nonFunctionalRequirements', 'moduleRequirements', 'externalContracts', 'interfaces', 'designDecisions', 'moduleSequences', 'globalSequences', 'boundaries', 'acceptanceCriteria', 'glossary', 'assumptions']) {
    assert.ok(section in s.properties, `specification schema 缺少 section: ${section}`);
  }
  assert.equal(s.properties.globalSequences.items.properties.id.pattern, '^G-T\\d+$');
  assert.equal(s.properties.interfaces.items.properties.id.pattern, '^IF-[A-Za-z0-9]+-\\d+$');
  assert.equal(s.properties.externalContracts.deprecated, true);
});

test('suite_config schema 字段/文档 required/模式枚举（内部任务-347/内部未决-141：validationRoots 已移除）', () => {
  const s = loadJson(join(SCHEMAS_DIR, 'suite_config.schema.json'));
  for (const f of ['schemaVersion', 'suiteRoot', 'documents', 'manifest', 'allowedPublicAssets']) {
    assert.ok(f in s.properties, `suite_config 缺少字段: ${f}`);
  }
  assert.equal('validationRoots' in s.properties, false, 'validationRoots 死字段已移除（零消费，内部任务-347/内部未决-141）');
  assert.equal(s.required.includes('validationRoots'), false, 'required 同批移除');
  const doc = s.properties.documents.items;
  for (const f of ['path', 'documentType', 'validationMode']) assert.ok(doc.required.includes(f));
  assert.deepEqual([...doc.properties.validationMode.enum].sort(), ['baseline', 'draft', 'template']);
});

test('route_case schema 与三技能评测用例', () => {
  const s = loadJson(join(SCHEMAS_DIR, 'route_case.schema.json'));
  const item = s.properties.cases.items;
  for (const f of ['caseId', 'type', 'inputRequest', 'projectConditions', 'pressures', 'expectedBehaviors', 'forbiddenBehaviors']) {
    assert.ok(f in item.properties, `route case 缺少字段: ${f}`);
  }
  assert.deepEqual([...item.properties.type.enum].sort(), ['discipline-pressure', 'should-not-trigger', 'should-trigger']);
  const evalRoot = join(CORE_ROOT, 'fixtures/skill_evals');
  const files = readdirSync(evalRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(evalRoot, e.name, 'cases.json')).filter(existsSync);
  assert.ok(files.length >= 3, '三个技能必须各有评测用例集');
  for (const path of files) {
    const data = loadJson(path);
    for (const f of s.required) assert.ok(f in data, `${path} 缺少顶层字段: ${f}`);
    for (const c of data.cases) for (const f of item.required) assert.ok(f in c, `${path} 用例缺少字段: ${f}`);
  }
});

test('模板引用的资产在 manifest 中；原子模板元数据与占位符风格', () => {
  const manifest = loadJson(join(CORE_ROOT, 'manifest.json'));
  const assetIds = new Set(manifest.publicAssets.map((a) => a.assetId));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const path of walk(join(CORE_ROOT, 'templates')).filter((p) => p.endsWith('.template.md'))) {
    const { meta } = parseFrontmatter(readFileSync(path, 'utf8'));
    const refs = [];
    if (meta?.atomicSchemaAssetId) refs.push(meta.atomicSchemaAssetId);
    if (meta?.assemblyOf) refs.push(...meta.assemblyOf.split(',').map((x) => x.trim()).filter(Boolean));
    for (const ref of refs) assert.ok(assetIds.has(ref), `${path} 引用资产不在 manifest: ${ref}`);
  }
  const atomic = join(CORE_ROOT, 'templates/atomic');
  for (const name of ATOMIC_TEMPLATES) {
    const path = join(atomic, `${name}.template.md`);
    assert.ok(existsSync(path), `缺少原子模板: ${path}`);
    const raw = readFileSync(path, 'utf8');
    for (const marker of ['documentType:', 'allowedPlaceholders:', 'validationMode:']) assert.ok(raw.includes(marker), `${name} 缺少 ${marker}`);
    assert.equal(raw.replace(/\{\{/g, '').includes('<'), false, `${name} 不得使用 <...> 占位符`);
  }
  const candidate = join(CORE_ROOT, '..', 'skills');
  const skillsRoot = existsSync(join(candidate, 'sdd-ddd-tdd')) ? candidate : join(CORE_ROOT, '..');
  for (const skill of ['sdd-ddd-tdd', 'spec-backfill', 'spec-writing']) {
    const raw = readFileSync(join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    for (const m of raw.matchAll(/\b(?:template|schema|registry)\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/g)) {
      assert.ok(assetIds.has(m[0]), `${skill} 引用了不在 manifest 中的资产: ${m[0]}`);
    }
  }
});

test('内部任务-347 内部未决-142：值侧成对引号剥离；重复键返回 frontmatterError 不抛异常；validateDocument 计 warning', () => {
  const ok = parseFrontmatter('---\nkey: "value"\nkey2: \'v2\'\nkey3: plain\n---\n正文');
  assert.equal(ok.meta.key, 'value', '双引号剥离一层');
  assert.equal(ok.meta.key2, 'v2', '单引号剥离一层');
  assert.equal(ok.meta.key3, 'plain', '裸值不变');
  const asym = parseFrontmatter('---\nkey: "unclosed\n---\n正文');
  assert.equal(asym.meta.key, '"unclosed', '不对称引号保留原样');
  const dup = parseFrontmatter('---\nkey: a\nkey: b\n---\n正文');
  assert.equal(dup.meta, null, '重复键 meta null（不可解析语义，不抛异常）');
  assert.ok(String(dup.frontmatterError ?? '').includes('重复键') && String(dup.frontmatterError ?? '').includes('key'), `frontmatterError 含类别与键名，实际 ${dup.frontmatterError}`);
  // 消费面：validateDocument 对 frontmatterError 计 warning 诊断（零崩溃面）
  const root = mkdtempSync(join(tmpdir(), 'dev347-fm-'));
  try {
    writeFileSync(join(root, 'doc.md'), '---\nkey: a\nkey: b\n---\n# 文档\n\n正文。\n');
    const diags = validateDocument(root, { path: 'doc.md' }, 'draft', []);
    const fm = diags.filter((d) => String(d.fixHint ?? d.message ?? '').includes('frontmatter'));
    assert.equal(fm.length, 1, `恰一条 frontmatter 诊断，实际 ${JSON.stringify(diags)}`);
    assert.equal(fm[0].severity, 'warning', 'warning 档（不阻断）');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
