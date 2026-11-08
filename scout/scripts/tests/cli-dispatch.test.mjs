// 文件：scout/scripts/tests/cli-dispatch.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201，scout lines→90）——以 in-process argv 方式覆盖
//       mode-lifecycle CLI 分发（open 分支与 emit）与 check-consistency 的 --project-root 缺值守卫。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/cli-dispatch.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsMain } from './helpers/run-in-process.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');

test('mode-lifecycle CLI：open 子命令分发成功并输出 JSON 回执（emit/runCli 分支）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dev209-scout-cli-'));
  try {
    const r = await runAsMain(join(SCRIPTS, 'mode-lifecycle.mjs'), ['open', '--project-root', root, '--mode', 'explore', '--expiry', '2999-01-01', '--task-id', '内部任务-1']);
    const out = r.logs.join('');
    assert.equal(r.code, 0, out);
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `须输出 JSON 回执：${out}`);
    const body = JSON.parse(line);
    assert.equal(body.ok, true, JSON.stringify(body));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('check-consistency CLI：--project-root 缺值守卫退 2（用法错误先于 resolve）', async () => {
  // 共享 helper 的 exit 桩不抛出：usage 先写 stderr；main 后续代码抛 TypeError 由入口 catch 转
  // JSON 工具错误（T14），因此断言 code=2 且 logs 含用法行。
  const { code, logs } = await runAsMain(join(SCRIPTS, 'check-consistency.mjs'), ['--project-root']);
  const out = logs.join('');
  assert.equal(code, 2, out);
  assert.match(out, /用法：node scout\/scripts\/check-consistency\.mjs/, out);
});
