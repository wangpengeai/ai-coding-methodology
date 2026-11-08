// 文件：apply 拒载语义测试（批 2 阶段 1 步骤 2）
// 描述：装载期引擎不可得 → 拒载（先 logWarn 再外抛、不注册任何面）；同进程二次 apply 幂等不抛。
//       独立文件是**必需**的（计划「负例顺序约束」）：模块级绑定槽在本文件的拒载用例中保持未绑定，
//       若与调用过成功 apply 的用例同文件，ensureBound 会复用已绑定实例而使负例恒不抛（假绿）。
// 作者：wangp  创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/apply-refuse.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 清理临时根（守卫同时接受 tmpdir 与其 realpath——macOS 上 `/var` 为 `/private/var` 符号链接）。 */
function removeRoot(root) {
  if (typeof root !== 'string' || root === '') return;
  const candidates = [tmpdir(), realpathSync(tmpdir())];
  if (candidates.some((prefix) => root.startsWith(prefix))) rmSync(root, { recursive: true, force: true });
}

import { apply } from '../src/index.mjs';
import { getEngine } from '../src/engine-binding.mjs';
import { createLogger } from './helpers/logger-stub.cjs';

/** 极简 ctx：只提供 logger 与注册面记录器（拒载路径在触达服务前即外抛）。 */
function makeCtx() {
  const calls = [];
  const logger = createLogger();
  return {
    calls,
    logger,
    ctx: {
      logger,
      on: (...args) => calls.push(['on', ...args]),
      get: (name) => { calls.push(['get', name]); return undefined; },
    },
  };
}

test('apply：plugin-core 不可达 → 拒载（先 logWarn 再外抛，不注册任何面）', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-refuse-')));
  const { ctx, calls, logger } = makeCtx();
  try {
    await assert.rejects(() => apply(ctx, { repoRootOverride: root }), /plugin-core/);
    assert.equal(calls.length, 0, '拒载不得注册任何面');
    const warned = logger.byLevel('warn').join('\n');
    assert.match(warned, /引擎不可得/, '拒载须先落日志');
    assert.match(warned, /修复/, '日志须含修复指引');
    assert.match(warned, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '日志须含尝试路径');
    assert.throws(() => getEngine(), /引擎未绑定/, '拒载失败不得污染绑定槽');
  } finally {
    removeRoot(root);
  }
});

test('apply：同进程二次 apply 不抛（ensureBound 复用；既有 28 处 in-process apply 的前提）', async () => {
  const first = makeCtx();
  await assert.doesNotReject(() => apply(first.ctx, {}));
  assert.equal(typeof getEngine().applyRule, 'function');
  const second = makeCtx();
  await assert.doesNotReject(() => apply(second.ctx, {}), '第二次 apply 须复用已绑定引擎而非抛「另一实例」');
  // 首次成功装配会注册若干面；只需证明不抛且引擎仍在位（面级断言由各面测试覆盖）
  assert.equal(typeof getEngine().applyRule, 'function');
});

test('DEV-273 步骤11 T-10：同一 ctx 二次 apply 监听器不翻倍（幂等守卫）', async () => {
  const single = makeCtx();
  await apply(single.ctx, {});
  const countOn = () => single.calls.filter(([kind]) => kind === 'on').length;
  const onAfterFirst = countOn();
  assert.ok(onAfterFirst > 0, '首次 apply 应注册监听器');
  await apply(single.ctx, {});
  assert.equal(countOn(), onAfterFirst, '同 ctx 二次 apply 不得重复注册监听器（幂等）');
});
