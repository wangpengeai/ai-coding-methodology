// 文件：zcode-adapter/tests/selftest.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201）——以 in-process import 覆盖 `src/selftest.mjs` 的导出行为：
//       ①`selftest()` 迁移断言组（指引 7＋bump 事务 9＋清残留 1＋生成器 4＋计划事务 3＝24）全绿；
//       ②`mkBumpFixture`/`runBumpTest` 导出夹具可独立驱动（参数闸/成功/回滚面）。
//       不 spawn `cli.mjs --selftest`（子进程对父进程覆盖率零贡献，内部决策-064 决策 4）。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 workflow/LICENSE）
// 自检：node --test "zcode-adapter/tests/selftest.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mkBumpFixture, runBumpTest, selftest } from '../src/selftest.mjs';

test('selftest 导出入口：24 项迁移断言全绿（指引/bump/生成器/计划事务组）', () => {
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  let rc;
  try {
    rc = selftest();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = chunks.join('');
  const passLines = output.split('\n').filter((line) => line.startsWith('PASS '));
  assert.equal(rc, 0, `selftest 须退 0：${output.slice(-800)}`);
  assert.equal(passLines.length, 24, `迁移断言组应为 24 条：实测 ${passLines.length}`);
  assert.ok(!output.includes('FAIL '), 'selftest 输出不得含 FAIL');
});

test('mkBumpFixture/runBumpTest 导出夹具：参数闸与成功/回滚路径可独立驱动', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-zcode-selftest-'));
  try {
    const { repo } = mkBumpFixture(home);
    const bad = runBumpTest(repo, { version: '9.9', note: 'x' });
    assert.equal(bad.exit, 1, '非法版本须拒');
    assert.match(bad.log, /版本/);
    const ok = runBumpTest(repo, { version: '0.2.0', note: '内部任务-209 达阈夹具', checks: () => ({ ok: true, log: '' }) });
    assert.equal(ok.exit, 0, `合法 bump 应成功：${ok.log.slice(0, 400)}`);
    const same = runBumpTest(repo, { version: '0.2.0', note: 'x' });
    assert.equal(same.exit, 1, '同版本须拒');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
