// AC fixture 解释器：runAll 41 例零失败、族计数、oracle 判别力（F-7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareWithOracle, discoverFixtureDirs, familyOf, runAll, runFixture, runMarkdownFixture } from '../core/fixtures.mjs';
import { diagnostic } from '../core/diagnostics.mjs';
import { CORE_ROOT } from './helpers.mjs';

const FIXTURES = join(CORE_ROOT, 'fixtures');

test('runAll：41 例零失败（六族 36＋opt_out 5）', () => {
  const [failures, report] = runAll(FIXTURES);
  assert.equal(failures, 0, report.filter((r) => r.startsWith('FAIL')).join('\n'));
  assert.equal(report.length, 41);
});

test('族计数：adr5/open_items4/ddd7/fast_track5/task_ledger5/interfaces10/opt_out5', () => {
  const dirs = discoverFixtureDirs(FIXTURES);
  const counts = {};
  for (const d of dirs) {
    const family = familyOf(d);
    counts[family] = (counts[family] ?? 0) + 1;
  }
  assert.deepEqual(counts, { adr: 5, open_items: 4, ddd: 7, fast_track: 5, task_ledger: 5, interfaces: 10, opt_out: 5 });
});

test('oracle 判别力：多一条/错一条诊断都必须被抓住', () => {
  const dir = join(FIXTURES, 'adr/adr-duplicate-id');
  const { diagnostics, exitCode, meta } = runFixture(dir);
  assert.deepEqual(compareWithOracle(dir, diagnostics, exitCode, meta), []);
  const extra = [...diagnostics, diagnostic('RULE-内部决策-001', 'warning', 'wrong', 9, 'x')];
  assert.ok(compareWithOracle(dir, extra, exitCode, meta).length > 0, '额外诊断必须判红');
  const wrong = [diagnostic('RULE-内部决策-999', 'blocking', diagnostics[0].file, diagnostics[0].line, diagnostics[0].fixHint)];
  assert.ok(compareWithOracle(dir, wrong, exitCode, meta).length > 0, '错误 ruleId 必须判红');
});

test('F-7：opt_out 五例由 runFixture 执行并与 oracle 逐键一致', () => {
  const dirs = discoverFixtureDirs(FIXTURES).filter((d) => familyOf(d) === 'opt_out');
  assert.equal(dirs.length, 5);
  for (const dir of dirs) {
    const { diagnostics, exitCode, meta } = runFixture(dir);
    assert.deepEqual(compareWithOracle(dir, diagnostics, exitCode, meta), [], dir);
  }
  const missing = runFixture(join(FIXTURES, 'opt_out/opt-current-task-missing-taskid'));
  assert.deepEqual(missing.diagnostics.map((d) => d.ruleId), ['RULE-OPT-003']);
  const expired = runFixture(join(FIXTURES, 'opt_out/opt-expired-ignored'));
  assert.deepEqual(expired.diagnostics, []);
});

test('围栏内禁词不计（内部未决-152③）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev237-fixture-'));
  const out = join(dir, 'document.md');
  writeFileSync(out, '# 文档\n\n```text\nTODO: 示例，不参与检查\n```\n');
  assert.deepEqual(runMarkdownFixture(out, 'x.md'), { diagnostics: [], exitCode: 0, meta: null });
  writeFileSync(out, '# 文档\n\nTODO: 裸写，应命中\n');
  const bare = runMarkdownFixture(out, 'x.md');
  assert.ok(bare.diagnostics.some((d) => d.ruleId === 'RULE-内部未决-001'));
});
