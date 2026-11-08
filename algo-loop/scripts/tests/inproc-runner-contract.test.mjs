// 文件：inproc-runner-contract.test.mjs
// 描述：in-process 夹具与测试运行器协议契约回归锁（内部任务-269 R11）——`node --test` 子进程跑
//       inproc-selftest.test.mjs，断言其 4 个用例**全部执行**（tests 4 / pass 4 / fail 0）；
//       防「捕获吞掉运行器帧致用例静默不执行」再次发生（捕获实现见 inproc-selftest.test.mjs）。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/inproc-runner-contract.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

test('夹具 tests 4 用例全执行（运行器协议帧不被捕获吞掉）', () => {
  const file = join(HERE, 'inproc-selftest.test.mjs');
  // 父进程若本身在 node --test 内（NODE_TEST_CONTEXT 存在），子测试运行器会继承协议上下文而不产常规摘要；
  // 清空该变量让子进程以独立 runner 运行，输出可断言的 TAP/spec 摘要。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
  assert.equal(r.status, 0, `inproc 夹具套件应全绿：${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /tests 4/, `运行器应报告 4 个用例（实测输出：${r.stdout.slice(-400)}）`);
  assert.match(r.stdout, /pass 4/);
  assert.match(r.stdout, /fail 0/);
});
