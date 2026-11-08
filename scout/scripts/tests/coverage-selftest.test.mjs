// 文件：scout/scripts/tests/coverage-selftest.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201，scout lines 81.94→90）——以 in-process argv 方式覆盖
//       mode-state / mode-lifecycle / check-consistency / hooks/session-start 的 `--selftest` 块
//       （子进程对父进程覆盖率零贡献，内部决策-064 决策 4；exit 桩只记录不抛出以保持模块缓存可用）。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/coverage-selftest.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAsMain } from './helpers/run-in-process.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');
const HOOKS = resolve(SCRIPTS, '..', 'hooks');

test('mode-state --selftest：v3 本地判定两断言 PASS 且自然退出 0（T21 exitCode 语义）', async () => {
  const r = await runAsMain(join(SCRIPTS, 'mode-state.mjs'), ['--selftest']);
  const out = r.logs.join('');
  // 内部决策-065 T21：成功面不调用 process.exit（in-process 自然退出，code=null）
  assert.equal(r.code, null, out);
  assert.equal(out.split('\n').filter((l) => l.startsWith('PASS ')).length, 2, out);
  assert.match(out, /OK mode-state selftest/);
});

test('mode-lifecycle --selftest：四断言 PASS 且自然退出 0（T21 exitCode 语义）', async () => {
  const r = await runAsMain(join(SCRIPTS, 'mode-lifecycle.mjs'), ['--selftest']);
  const out = r.logs.join('');
  // 内部决策-065 T21：成功面不调用 process.exit（in-process 自然退出，code=null）
  assert.equal(r.code, null, out);
  assert.equal(out.split('\n').filter((l) => l.startsWith('PASS ')).length, 4, out);
  assert.match(out, /OK mode-lifecycle selftest/);
});

test('check-consistency --selftest：空根 consistent 路径退 0', async () => {
  const r = await runAsMain(join(SCRIPTS, 'check-consistency.mjs'), ['--selftest']);
  const out = r.logs.join('');
  assert.equal(r.code, 0, out);
  assert.match(out, /OK check-consistency selftest/, out);
});

test('session-start 钩子 --selftest：selftest 分支可执行（本地模块加载不抛出）', async () => {
  const prevArgv = process.argv;
  process.argv = [process.execPath, join(HOOKS, 'session-start.mjs'), '--selftest'];
  try {
    await import(pathToFileURL(join(HOOKS, 'session-start.mjs')).href);
    // selftest 内部以异步 dynamic import 收尾：给足微任务/定时器窗口
    await new Promise((resolveTick) => setTimeout(resolveTick, 120));
  } finally {
    process.argv = prevArgv;
  }
  // 强断言（S6 SIM-02）：子进程真跑同一钩子并校验输出，in-process import 只负责父进程覆盖率。
  const child = spawnSync(process.execPath, [join(HOOKS, 'session-start.mjs'), '--selftest'], { encoding: 'utf8' });
  assert.equal(child.status, 0, `钩子 selftest 子进程须退 0：${(child.stderr || child.stdout).slice(0, 500)}`);
  assert.match(child.stdout, /SELFTEST OK session-start/u, `钩子 selftest 须输出 SELFTEST OK：${child.stdout.slice(0, 500)}`);
});
