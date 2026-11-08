// 文件：scout/scripts/tests/cli-status.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201，scout lines→90）——in-process argv 覆盖 mode-lifecycle；本夹具覆盖 status 分支（in-process argv）。
//       CLI 分发分支（子进程对父进程覆盖率零贡献，内部决策-064 决策 4）。本文件为 argv 分支最小夹具。
// 自检：node --test "scout/scripts/tests/cli-status.test.mjs"
// 作者：wangp 创建：2026-10-25 版权：MIT（见 scout/LICENSE）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsMain } from './helpers/run-in-process.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');

test('mode-lifecycle CLI 分发分支（in-process argv）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dev209-scout-cli-'));
  let code; let logs;
  try {
    ({ code, logs } = await runAsMain(join(SCRIPTS, 'mode-lifecycle.mjs'), ['--project-root', root, 'status']));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  // 强断言（内部任务-209 S6 简洁性维 SIM-01 处置）：不能只断言「执行完成」，须钉住退出码与输出语义。
  assert.ok(code === 0 && JSON.parse(logs.join('').trim()).valid === false, 'status 空项目须退 0 且 valid=false（code=' + JSON.stringify(code) + ' logs=' + JSON.stringify(logs) + '）');
});
