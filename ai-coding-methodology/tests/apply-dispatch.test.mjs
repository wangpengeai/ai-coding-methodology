// 文件：逐插件允许表注入的装配级用例（批 2 终审阻塞②）
// 描述：`apply()` 的派发路径把**该处理器所属插件根**的声明集注入第六参；本用例经真实 dispatch
//       端到端断言这一注入的**可观察后果**：仅声明 `PostToolUse` 的根 ⇒ `PostToolUseFailure`
//       信封被拒（无阻断）；声明了该事件的 workflow 根 ⇒ 同信封被采信（阻断）。
//       存在理由：把 `index.mjs` 第六参改成 `undefined` 后，全部其它用例仍绿——注入本身零判别力。
// 作者：wangp 创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/apply-dispatch.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { createLogger } from './helpers/logger-stub.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** 造一个只注册、可手动 emit 的最小 ctx；shell 恒回同一信封。 */
function makeCtx(envelopeText) {
  const handlers = new Map();
  return {
    handlers,
    ctx: {
      logger: createLogger(),
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
      get: () => undefined,
      shell: {
        resolve: (request) => request,
        execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: envelopeText }, stderr: { text: '' } }) }),
      },
    },
  };
}

/** 触发 PostToolUse 派发（DSH 事件 `tools/post-execute`），返回处理器产出。 */
async function emitPostToolUse(handlers) {
  const exec = { name: 'pwsh', arguments: {}, agent: undefined, cwd: REPO_ROOT };
  // 内部任务-59（内部未决-60）：本层自本批起只对**已派发**的调用派发 PostToolUse 钩子 ⇒ 须先经宿主派发点
  // （`tools/execute` 处理器）登记"已派发"事实——本桩无 `emit`，故按 handlers 顺序直调，且**同一 exec 对象**。
  const execHandler = (handlers.get('tools/execute') ?? [])[0];
  assert.ok(execHandler, 'tools/execute 处理器应已注册');
  await execHandler(exec, async () => ({ kind: 'continue' }));
  const handler = (handlers.get('tools/post-execute') ?? [])[0];
  assert.ok(handler, 'PostToolUse 处理器应已注册');
  return handler(exec, { content: 'x' }, async () => ({ kind: 'continue' }));
}

// 失败事件信封：`hookEventName` ＝ PostToolUseFailure + deny（只声明了 PostToolUse 的根必须拒它）
const FAILURE_ENVELOPE = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure', permissionDecision: 'deny', permissionDecisionReason: 'blocked-by-failure-envelope' },
});

test('逐插件允许表注入：声明了 PostToolUseFailure 的根（workflow）采信该信封 → 阻断', async () => {
  const { ctx, handlers } = makeCtx(FAILURE_ENVELOPE);
  await apply(ctx, { pluginRoots: { workflow: join(REPO_ROOT, 'workflow') } });
  const out = await emitPostToolUse(handlers);
  assert.equal(out?.kind, 'block', 'workflow 声明了 PostToolUseFailure，信封应被采信并阻断');
  assert.match(String(out?.feedback?.[0]?.text ?? ''), /blocked-by-failure-envelope/);
});

test('逐插件允许表注入：未声明该事件的根（spec-gate）拒绝该信封 → 不阻断', async () => {
  // 只让 spec-gate 一个根产出处理器：其余三个插件的显式根指向空目录（`pluginRoots` 优先于同级发现）
  const blanks = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-blank-')));
  try {
    const override = {
      workflow: join(blanks, 'workflow'),
      'spec-gate': join(REPO_ROOT, 'spec-gate'),
      scout: join(blanks, 'scout'),
      'team-governance': join(blanks, 'team-governance'),
    };
    for (const dir of Object.values(override)) mkdirSync(dir, { recursive: true });
    const { ctx, handlers } = makeCtx(FAILURE_ENVELOPE);
    await apply(ctx, { pluginRoots: override });
    const out = await emitPostToolUse(handlers);
    assert.notEqual(out?.kind, 'block', 'spec-gate 未声明 PostToolUseFailure，信封不得被采信');
  } finally {
    if (blanks.startsWith(tmpdir()) || blanks.startsWith(realpathSync(tmpdir()))) rmSync(blanks, { recursive: true, force: true });
  }
});
