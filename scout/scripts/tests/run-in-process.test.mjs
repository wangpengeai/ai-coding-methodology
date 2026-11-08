// 文件：run-in-process.test.mjs
// 描述：run-in-process 夹具回归（内部未决-231，内部任务-337）——stream 分流契约：string 输出捕获进 logs；
//       非 string chunk（运行器协议帧 Buffer）转发 prevOut/prevErr（不吞帧）。观察法＝先在测试内
//       包一层 recorder 作为「原流」，再 runAsMain——转发可断言且不污染真实运行器输出流。
// 作者：wangp 创建：2026-11-06 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/run-in-process.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsMain } from './helpers/run-in-process.mjs';

test('run-in-process：string 捕获、Buffer 帧转发原流（OPEN-231 不吞帧）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev337-rip-'));
  const fixture = join(dir, 'fixture-entry.mjs');
  // 夹具：先写一帧 Buffer（模拟运行器协议帧），再写 string（被测输出）；stderr 同构一帧
  writeFileSync(fixture, [
    "process.stdout.write(Buffer.from('runner-frame'));",
    "process.stdout.write('captured-string');",
    "process.stderr.write(Buffer.from('runner-frame-err'));",
    'process.exitCode = 0;',
  ].join('\n'));
  const fwdOut = [];
  const fwdErr = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...rest) => { fwdOut.push(c); return true; };
  process.stderr.write = (c, ...rest) => { fwdErr.push(c); return true; };
  try {
    const r = await runAsMain(fixture);
    assert.equal(r.code, 0);
    assert.ok(r.logs.includes('captured-string'), 'string 输出被捕获');
    assert.ok(!r.logs.some((l) => l.includes('runner-frame')), 'Buffer 帧不进 logs');
    assert.ok(fwdOut.some((c) => c instanceof Uint8Array && String.fromCharCode(...c).includes('runner-frame')), 'stdout Buffer 帧转发原流（OPEN-231）');
    assert.ok(fwdErr.some((c) => c instanceof Uint8Array && String.fromCharCode(...c).includes('runner-frame-err')), 'stderr Buffer 帧转发原流（OPEN-231）');
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    rmSync(dir, { recursive: true, force: true });
  }
});
