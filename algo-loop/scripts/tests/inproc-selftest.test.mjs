// 文件：algo-loop/scripts/tests/inproc-selftest.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201）——以 in-process argv 方式覆盖 algo 四个入口脚本的
//       `--selftest`/用法分支（子进程 spawn 对父进程覆盖率零贡献，内部决策-064 决策 4；故同进程
//       动态 import + argv 注入 + exit 桩）。不伪造通过：断言各入口输出 PASS/SELFTEST OK 且退码 0。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.0.1 2026-11-01 wangp 内部任务-269：捕获函数把非 string 运行器协议帧原样转发回原 stream
//           （内部任务-233 同文件修复只做了输出去粘接、未识别帧被吞导致 3 用例静默不执行）。
// 自检：node --test "algo-loop/scripts/tests/inproc-selftest.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const SCRIPTS = join(ROOT, 'algo-loop', 'scripts');
const HOOKS = join(ROOT, 'algo-loop', 'hooks');

/** 以「直接运行」形态 import 模块：注入 argv + 捕获 console/exit。每模块仅首次 import 生效。 */
async function runAsMain(file, args = []) {
  const prevArgv = process.argv;
  const prevExit = process.exit;
  const prevLog = console.log;
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  const logs = [];
  // Node 22 测试运行器经 process.stdout 写自身协议帧（V8 结构化克隆 Buffer）：字符串为被测输出、
  // 非 string 块为运行器帧。**必须把非 string 帧原样转发回原 stream**——返回 true 而不转发＝丢帧，
  // 会让运行器丢失测试事件（内部任务-269 R11：4 用例中 3 个在 node --test 下静默不执行）。
  const captureOut = (chunk) => { if (typeof chunk === 'string') { logs.push(chunk); return true; } return prevOut(chunk); };
  const captureErr = (chunk) => { if (typeof chunk === 'string') { logs.push(chunk); return true; } return prevErr(chunk); };
  let code = null;
  process.argv = [process.execPath, file, ...args];
  process.exit = (value) => { throw Object.assign(new Error('EXIT'), { __exitCode: value ?? 0 }); };
  console.log = (...parts) => { logs.push(parts.join(' ')); };
  process.stdout.write = captureOut;
  process.stderr.write = captureErr;
  try {
    await import(pathToFileURL(file).href);
    // selftest 分支可能以异步 dynamic import 收尾（hook 形态）：让微任务/定时器跑完再恢复捕获
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  } catch (error) {
    if (error && error.message === 'EXIT') code = error.__exitCode;
    else throw error;
  } finally {
    process.argv = prevArgv;
    process.exit = prevExit;
    console.log = prevLog;
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
  return { code, logs };
}

test('algo-state：直接运行 --selftest 三断言 PASS 且退 0', async () => {
  const r = await runAsMain(join(SCRIPTS, 'algo-state.mjs'), ['--selftest']);
  const out = r.logs.join('\n');
  assert.equal(r.code, null, `selftest 正常返回（不 process.exit）：${out}`);
  assert.equal(out.split('\n').filter((l) => l.startsWith('PASS ')).length, 3, `三断言 PASS：${out}`);
  assert.match(out, /SELFTEST OK algo-state/);
});

test('algo-write：直接运行 --selftest 五步写面全 PASS 且退 0', async () => {
  const r = await runAsMain(join(SCRIPTS, 'algo-write.mjs'), ['--selftest']);
  const out = r.logs.join('\n');
  assert.equal(r.code, 0, `退码 0：${out}`);
  assert.equal(out.split('\n').filter((l) => l.startsWith('PASS ')).length, 5, `五步写面 PASS：${out}`);
  assert.match(out, /SELFTEST OK algo-write/);
});

test('check-consistency：直接运行 --selftest 空根 consistent 退 0', async () => {
  const r = await runAsMain(join(SCRIPTS, 'check-consistency.mjs'), ['--selftest']);
  const out = r.logs.join('\n');
  assert.equal(r.code, null, 'selftest 分支正常返回（不 process.exit）');
  assert.match(out, /PASS 空根（未立项）读取 consistent 退 0/, out);
  assert.match(out, /SELFTEST OK check-consistency/, out);
});

test('session-start 钩子：直接运行 --selftest 断言全 PASS', async () => {
  const r = await runAsMain(join(HOOKS, 'session-start.mjs'), ['--selftest']);
  const out = r.logs.join('\n');
  assert.match(out, /SELFTEST OK session-start \(algo-loop\)/, out);
  assert.ok(!/FAIL /.test(out), `selftest 不得含 FAIL：${out}`);
});
