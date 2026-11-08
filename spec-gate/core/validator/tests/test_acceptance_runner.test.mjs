// AC-SCOPE-001：24 项统一验收运行器契约（含 F-5 报告语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';

const RUNNER = join(CORE_ROOT, 'validator/run_acceptance.mjs');
// 独立 oracle：期望集合写死，不与被测实现的 ALL_ACS 同源
const ALL_ACS = [
  'AC-CORE-001', 'AC-RULE-001', 'AC-GATE-001', 'AC-SCHEMA-001', 'AC-DDD-001', 'AC-TDD-001',
  'AC-FAST-001', 'AC-OPT-001', 'AC-VAL-001', 'AC-RO-001', 'AC-PATH-001', 'AC-内部决策-001',
  'AC-内部未决-001', 'AC-IF-001', 'AC-IF-002', 'AC-PACK-001', 'AC-HOST-001', 'AC-ROUTE-001',
  'AC-MIG-001', 'AC-MD-001', 'AC-SCOPE-001', 'AC-PLUG-001', 'AC-PLUG-002', 'AC-PLUG-003',
];
function run(args, env = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: CORE_ROOT, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env },
  });
}
let cached = null;
function fullReport() {
  if (!cached) cached = run(['--suite-root', join(CORE_ROOT, '..'), '--format', 'json']);
  return cached;
}

test('全量运行报告形状、24 项 AC、退出码一致', () => {
  const r = fullReport();
  assert.ok([0, 1].includes(r.status), r.stderr);
  const report = JSON.parse(r.stdout);
  for (const f of ['schemaVersion', 'suiteRoot', 'generatedAt', 'selectedCases', 'results', 'blockingPassed', 'blockingFailed', 'unverified', 'finalStatus', 'exitCode']) {
    assert.ok(f in report, `验收报告缺少字段: ${f}`);
  }
  assert.deepEqual(new Set(report.results.map((x) => x.acceptanceId)), new Set(ALL_ACS));
  assert.equal(report.exitCode, r.status);
});

test('结果条目字段与状态枚举', () => {
  const report = JSON.parse(fullReport().stdout);
  for (const res of report.results) {
    for (const f of ['acceptanceId', 'status', 'blocking', 'evidence']) assert.ok(f in res);
    assert.ok(['passed', 'failed', 'unverified', 'error', 'not-applicable'].includes(res.status));
    assert.equal(typeof res.duration, 'number');
  }
});

test('单 case 选择、未知 case 退 2、坏 suite-root 退 2', () => {
  let r = run(['--suite-root', join(CORE_ROOT, '..'), '--format', 'json', '--case', 'AC-CORE-001']);
  let report = JSON.parse(r.stdout);
  assert.deepEqual(report.selectedCases, ['AC-CORE-001']);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, 'passed');
  assert.equal(r.status, 0);
  assert.equal(run(['--suite-root', join(CORE_ROOT, '..'), '--case', 'AC-NOPE-999']).status, 2);
  assert.equal(run(['--suite-root', join(CORE_ROOT, 'nonexistent')]).status, 2);
});

test('F-5：零测试/失败注入必须判红（SDD_ACCEPTANCE_TESTS_DIR 缝）', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dev151-actests-')));
  const env = { SDD_ACCEPTANCE_TESTS_DIR: dir };
  writeFileSync(join(dir, 'test_manifest_contract.test.mjs'), "import test from 'node:test';\n");
  let r = run(['--suite-root', join(CORE_ROOT, '..'), '--format', 'json', '--case', 'AC-CORE-001'], env);
  assert.equal(r.status, 1);
  let report = JSON.parse(r.stdout);
  assert.equal(report.finalStatus, 'blocked');
  assert.equal(report.results[0].status, 'failed');
  assert.ok(report.results[0].evidence[0].includes('Ran 0') || report.results[0].evidence[0].includes('未运行'));

  writeFileSync(join(dir, 'test_manifest_contract.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('boom', () => assert.fail('x'));\n");
  r = run(['--suite-root', join(CORE_ROOT, '..'), '--format', 'json', '--case', 'AC-CORE-001'], env);
  assert.equal(r.status, 1);
  report = JSON.parse(r.stdout);
  assert.equal(report.results[0].status, 'failed');
});

test('blocking 失败/未验证 ⇒ exit 1 + blocked；text 格式含 AC ID', () => {
  const r = fullReport();
  const report = JSON.parse(r.stdout);
  const bad = report.results.some((x) => x.blocking && ['failed', 'unverified', 'error'].includes(x.status));
  assert.equal(r.status, bad ? 1 : 0);
  assert.equal(report.finalStatus, bad ? 'blocked' : 'complete');
  const t = run(['--suite-root', join(CORE_ROOT, '..'), '--format', 'text', '--case', 'AC-CORE-001']);
  assert.ok(t.stdout.includes('AC-CORE-001') && t.stdout.includes('passed'));
});
