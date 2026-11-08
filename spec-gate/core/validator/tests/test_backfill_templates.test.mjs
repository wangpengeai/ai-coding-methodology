// AC-MD-001 / AC-SCHEMA-001：backfill 装配模板与报告模板冒烟契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT, loadJson } from './helpers.mjs';
import { parseFrontmatter } from '../core/frontmatter.mjs';

const BACKFILL_TEMPLATES = [
  'evidence_ledger', 'requirements_baseline', 'high_level_design', 'program_design_governance',
  'domain_design_package', 'module_volume', 'module_index', 'error_code_catalog', 'event_catalog',
  'traceability_matrix', 'checkpoint_a_package', 'checkpoint_b_package', 'checkpoint_c_package',
  'backfill_completion_report',
];
const FACT_CATEGORIES = ['已确认意图', '兼容约束', '偶然实现', '已知缺陷', '技术债', '未知意图', '安全/合规风险'];
const FORBIDDEN = ['copyWith', 'Riverpod', 'Flutter', '串口', 'Conventional Commits', 'Dart'];

test('14 个装配模板存在且元数据齐全', () => {
  const dir = join(CORE_ROOT, 'templates/backfill');
  for (const name of BACKFILL_TEMPLATES) {
    const path = join(dir, `${name}.template.md`);
    assert.ok(existsSync(path), `缺少装配模板: ${path}`);
    const { meta } = parseFrontmatter(readFileSync(path, 'utf8'));
    for (const key of ['documentType', 'allowedPlaceholders', 'validationMode', 'assemblyOf']) {
      assert.ok(meta?.[key] !== undefined, `${name} 缺少元数据 ${key}`);
    }
  }
});

test('assemblyOf 引用的原子 schema 均存在；表格分隔行；无技术栈术语', () => {
  const valid = new Set();
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const path of walk(join(CORE_ROOT, 'templates'))) {
    if (path.endsWith('.template.md')) {
      const { meta } = parseFrontmatter(readFileSync(path, 'utf8'));
      if (meta?.atomicSchemaAssetId) valid.add(meta.atomicSchemaAssetId);
    } else if (path.endsWith('.template.json')) {
      const c = loadJson(path).$comment ?? '';
      if (c.includes('atomicSchemaAssetId:')) valid.add(c.split('atomicSchemaAssetId:')[1].split('|')[0].trim());
    }
  }
  for (const name of BACKFILL_TEMPLATES) {
    const path = join(CORE_ROOT, 'templates/backfill', `${name}.template.md`);
    const { meta } = parseFrontmatter(readFileSync(path, 'utf8'));
    const refs = (meta?.assemblyOf ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    assert.ok(refs.length > 0, `${name} 必须声明引用的原子 schema`);
    assert.deepEqual(refs.filter((r) => !valid.has(r)), [], `${name} 引用了不存在的原子 schema`);
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const stripped = lines[i].trim();
      if (!stripped.startsWith('|')) continue;
      const prev = i > 0 ? lines[i - 1].trim() : '';
      if (prev.startsWith('|')) continue;
      assert.ok(i + 1 < lines.length, `${name}:${i + 1} 表头后无分隔行`);
      const sep = lines[i + 1].trim();
      assert.ok(sep.startsWith('|') && sep.includes('---'), `${name}:${i + 1} 表头后缺少分隔行`);
    }
    const raw = readFileSync(path, 'utf8');
    assert.deepEqual(FORBIDDEN.filter((t) => raw.includes(t)), [], `${name} 出现技术栈术语`);
  }
});

test('事实分类七类、模块分册双层、报告模板', () => {
  const dir = join(CORE_ROOT, 'templates/backfill');
  const ledger = readFileSync(join(dir, 'evidence_ledger.template.md'), 'utf8');
  for (const c of FACT_CATEGORIES) assert.ok(ledger.includes(c), `证据台账缺少事实分类: ${c}`);
  const volume = readFileSync(join(dir, 'module_volume.template.md'), 'utf8');
  assert.ok(volume.includes('规定性规格'));
  assert.ok(volume.includes('实现注记'));
  assert.equal(volume.includes('v2.0'), false);
  assert.equal(volume.includes('<总纲>'), false);
  const gate = loadJson(join(CORE_ROOT, 'templates/reports/gate_report.template.json'));
  assert.ok('$comment' in gate);
  assert.ok('finalStatus' in gate);
  const delivery = parseFrontmatter(readFileSync(join(CORE_ROOT, 'templates/reports/delivery_report.template.md'), 'utf8'));
  assert.equal(delivery.meta?.documentType, 'delivery-report');
});
