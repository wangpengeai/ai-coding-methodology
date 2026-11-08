// 内部规则-11 / T-M7-2 / 内部验收-10：suite 报告 plan 节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';

const VALIDATOR = join(CORE_ROOT, 'validator/validate_specs.mjs');
const VALID_PLAN = '---\ndocumentType: plan\nspecRefs: [FR-TEST-1]\n---\n\n# 计划：有效计划\n\n## 步骤 1：准备\n\n读取规格。\n\n验收：规格读取完成。\n';
const DANGLING_PLAN = '---\ndocumentType: plan\nspecRefs: [FR-GHOST-9]\n---\n\n# 计划：悬空引用\n\n## 步骤 1：实施\n\n落盘变更。\n\n验收：变更测试通过。\n';

function project(withSdd) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev151-gateplan-')));
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, '内部规格'), '# 需求基线\n\n- FR-TEST-1：样例需求\n');
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(join(root, '内部计划'), VALID_PLAN);
  writeFileSync(join(root, '内部计划'), DANGLING_PLAN);
  const configDir = join(root, '.sdd');
  if (withSdd) mkdirSync(configDir, { recursive: true });
  const config = {
    schemaVersion: '1.0.0', suiteRoot: withSdd ? '..' : '.', validationRoots: ['specs'], documents: [],
    manifest: join(CORE_ROOT, 'manifest.json'), allowedPublicAssets: [],
  };
  const path = join(withSdd ? configDir : root, 'suite.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}
function runSuite(config) {
  return spawnSync(process.execPath, [VALIDATOR, '--mode', 'suite', '--config', config, '--format', 'json'], { cwd: CORE_ROOT, encoding: 'utf8' });
}

test('suite 报告含 plan 节：两计划被检查、悬空进节内、顶层不受污染', () => {
  const r = runSuite(project(true));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.ok('plan' in report);
  for (const key of ['checked', 'blockingCount', 'warningCount', 'diagnostics']) assert.ok(key in report.plan);
  assert.equal(report.plan.checked, 2);
  assert.ok(report.plan.blockingCount >= 1);
  assert.ok(report.plan.diagnostics.some((d) => d.severity === 'blocking' && d.fixHint.includes('FR-GHOST-9')));
  assert.equal(report.blockingCount, 0);
  assert.equal(report.diagnostics.some((d) => d.ruleId === 'RULE-PLAN-001'), false);
});

test('无 .sdd 体系时 plan 节为空（B-M7-3）', () => {
  const r = runSuite(project(false));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).plan, { checked: 0, blockingCount: 0, warningCount: 0, diagnostics: [] });
});

test('F-17：非 UTF-8 计划计入 checked 并产 RULE-PLAN-002 warning', () => {
  const config = project(true);
  const root = dirname(dirname(config));
  writeFileSync(join(root, '内部计划'), Buffer.from([0xff, 0xfe]));
  const r = runSuite(config);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const plan = JSON.parse(r.stdout).plan;
  assert.equal(plan.checked, 3);
  const warnings = plan.diagnostics.filter((d) => d.ruleId === 'RULE-PLAN-002' && d.severity === 'warning');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].file.endsWith('broken.md'));
});
