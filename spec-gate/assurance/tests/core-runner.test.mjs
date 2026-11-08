// core-runner：gate → core 的 node 子进程缝（内部决策-051 阶段4；承接阶段3a 子进程缝窗口用例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCoreRunner, defaultPlanRunner } from '../core-runner.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-runner-')));
function repoWithSuite() {
  const dir = tmp();
  mkdirSync(join(dir, '.sdd'), { recursive: true });
  writeFileSync(join(dir, '.sdd/suite.json'), '{}');
  return dir;
}
function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}
const okReport = 'console.log(JSON.stringify({blockingCount:0,warningCount:0,diagnostics:[]}));';

test('suite 报告、缺 mode 补 suite、baseline 走 sdd_check 并补 mode', () => {
  const dir = tmp();
  const validator = stub(dir, 'validate_specs.mjs', okReport);
  const repo = repoWithSuite();
  assert.deepEqual(defaultCoreRunner(repo, { validatorPath: validator }), {
    blockingCount: 0, warningCount: 0, diagnostics: [], mode: 'suite',
  });
  const bare = tmp();
  mkdirSync(join(bare, 'tools'));
  stub(bare, 'validate_specs.mjs', okReport);
  stub(bare, 'tools/sdd_check.mjs', 'console.log(JSON.stringify({mode:"baseline",blockingCount:0,warningCount:0,diagnostics:[]}));');
  const r = defaultCoreRunner(tmp(), { validatorPath: join(bare, 'validate_specs.mjs') });
  assert.equal(r.mode, 'baseline');
});

test('坏 JSON / error 对象 / 缺 blockingCount 均具名 blocking', () => {
  const repo = repoWithSuite();
  const cases = [
    ['bad-json.mjs', 'console.log("not json")', 'RULE-GATE-CORE', '输出不可解析'],
    ['error-obj.mjs', 'console.log(JSON.stringify({error:"bad config"}))', 'RULE-GATE-CORE', 'bad config'],
    ['missing-count.mjs', 'console.log(JSON.stringify({diagnostics:[]}))', 'RULE-GATE-CORE', '缺 blockingCount'],
  ];
  for (const [name, body, ruleId, hint] of cases) {
    const dir = tmp();
    const r = defaultCoreRunner(repo, { validatorPath: stub(dir, name, body) });
    assert.equal(r.blockingCount, 1);
    assert.equal(r.diagnostics[0].ruleId, ruleId);
    assert.ok(r.diagnostics[0].fixHint.includes(hint), r.diagnostics[0].fixHint);
  }
});

test('超时具名 blocking；缺校验器文件归 RULE-GATE-CORE', () => {
  const repo = repoWithSuite();
  const dir = tmp();
  const slow = stub(dir, 'slow.mjs', 'setTimeout(() => {}, 1000);');
  const r = defaultCoreRunner(repo, { validatorPath: slow, timeoutMs: 50 });
  assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-CORE-TIMEOUT');
  const missing = defaultCoreRunner(repo, { validatorPath: join(dir, 'nope.mjs') });
  assert.equal(missing.diagnostics[0].ruleId, 'RULE-GATE-CORE');
});

test('SG_CORE_VALIDATOR 覆盖缝', () => {
  const repo = repoWithSuite();
  const dir = tmp();
  const validator = stub(dir, 'stub.mjs', 'console.log(JSON.stringify({mode:"suite",blockingCount:0,warningCount:0,diagnostics:[]}));');
  const r = defaultCoreRunner(repo, { env: { ...process.env, SG_CORE_VALIDATOR: validator } });
  assert.equal(r.mode, 'suite');
});

test('plan runner：正常 / 坏 JSON / 超时 / {"error"} 原样返回', () => {
  const repo = repoWithSuite();
  const plan = join(repo, 'p.md');
  writeFileSync(plan, '# p\n');
  const dir = tmp();
  const ok = stub(dir, 'plan-ok.mjs', 'console.log(JSON.stringify({blockingCount:0,warningCount:0,diagnostics:[]}));');
  assert.deepEqual(defaultPlanRunner(repo, plan, { validatorPath: ok }), { blockingCount: 0, warningCount: 0, diagnostics: [] });
  const bad = stub(dir, 'plan-bad.mjs', 'console.log("nope")');
  assert.equal(defaultPlanRunner(repo, plan, { validatorPath: bad }).diagnostics[0].ruleId, 'RULE-GATE-PLAN');
  const slow = stub(dir, 'plan-slow.mjs', 'setTimeout(() => {}, 1000);');
  assert.equal(defaultPlanRunner(repo, plan, { validatorPath: slow, timeoutMs: 50 }).diagnostics[0].ruleId, 'RULE-GATE-PLAN-TIMEOUT');
  const err = stub(dir, 'plan-err.mjs', 'console.log(JSON.stringify({error:"plan bad"}))');
  assert.deepEqual(defaultPlanRunner(repo, plan, { validatorPath: err }), { error: 'plan bad' });
});
