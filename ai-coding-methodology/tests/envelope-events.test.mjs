// 文件：声明源事件读面与允许表测试（批 2 阶段 2 步骤 5 六件）
// 描述：允许表公式 `allowed(event) = (静态表[event] ∩ D_root) ∪ {event}` 的正/反两向与回落面，
//       以及第六参经 `runSingleHandler` 的装配级生效性。**为什么必须独立成文件**：模块级绑定槽
//       要求"未绑定/绑定态"用例分处不同文件（计划「负例顺序约束」），且本面是本批唯一行为语义
//       变更点——没有它，「把允许表接反」在 186 项里仍全绿。
// 作者：wangp 创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/envelope-events.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declaredEventNames, decodeHookOutput, runSingleHandler } from '../src/hooks-bridge.mjs';
import { resolveEngine } from '../src/engine-loader.mjs';
import { bindEngine } from '../src/engine-binding.mjs';
import { createLogger } from './helpers/logger-stub.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
bindEngine(resolveEngine({ repoRootOverride: REPO_ROOT }));

/** 临时根（mkdtemp + realpath 归一；清理守卫同时接受 tmpdir 与其 realpath）。 */
function tempRoot(tag) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dsh-${tag}-`)));
  return {
    root,
    write(rel, text) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    },
    cleanup() {
      const prefixes = [tmpdir(), realpathSync(tmpdir())];
      if (prefixes.some((p) => root.startsWith(p))) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 造一个 PostToolUse 信封（`hookEventName` 可变——信封校验面）。 */
function envelope(eventName) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'deny', permissionDecisionReason: 'r' } });
}

// ① 真件回报与 manifest 一致
test('declaredEventNames：四插件真件回报与中立清单声明一致（仅 workflow 声明 PostToolUseFailure）', () => {
  const withFailure = declaredEventNames(join(REPO_ROOT, 'workflow'));
  assert.ok(withFailure.has('PostToolUseFailure'), 'workflow 应声明 PostToolUseFailure');
  assert.ok(withFailure.has('PostToolUse'));
  for (const plugin of ['spec-gate', 'scout', 'team-governance']) {
    const names = declaredEventNames(join(REPO_ROOT, plugin));
    assert.ok(!names.has('PostToolUseFailure'), `${plugin} 不应声明 PostToolUseFailure`);
    assert.ok(names.size > 0, `${plugin} 应至少声明一个事件`);
  }
});

// ② 缺省 ≡ 现静态表
test('decodeHookOutput：第五参缺省时行为 ≡ 现静态表（PostToolUse 采信 PostToolUseFailure 信封）', () => {
  const out = decodeHookOutput(0, envelope('PostToolUseFailure'), '', 'PostToolUse');
  assert.equal(out.decision, 'deny', '缺省分支须按静态表采信');
});

// ③ 注入声明集（含该事件）→ 采信
test('decodeHookOutput：注入含 PostToolUseFailure 的声明集 → 信封被采信', () => {
  const declared = new Set(['PostToolUse', 'PostToolUseFailure']);
  const out = decodeHookOutput(0, envelope('PostToolUseFailure'), '', 'PostToolUse', { allowedEvents: declared });
  assert.equal(out.decision, 'deny');
});

// ④ 未声明该事件的根 → 拒（反向证明）
test('decodeHookOutput：未声明 PostToolUseFailure 的根 → 该信封被拒（反向证明）', () => {
  const declared = new Set(['PostToolUse']);
  const out = decodeHookOutput(0, envelope('PostToolUseFailure'), '', 'PostToolUse', { allowedEvents: declared });
  assert.equal(out.decision, undefined, '未声明的事件名不得采信事件域字段');
  assert.equal(out.additionalContext, undefined);
  // 公式恒含 {event}：同根的 PostToolUse 信封仍被采信（否则会把正常路径一起拒掉）
  assert.equal(decodeHookOutput(0, envelope('PostToolUse'), '', 'PostToolUse', { allowedEvents: declared }).decision, 'deny');
});

// ⑤ 无中立清单的根 → 回落读生成物事件键
test('declaredEventNames：仅 hooks/hooks.json 的根 → 回落读事件键；两者皆无 → 空集', () => {
  const fx = tempRoot('decl-events');
  try {
    fx.write('hooks/hooks.json', JSON.stringify({ hooks: { PostToolUse: [], Stop: [] } }));
    const names = declaredEventNames(fx.root);
    assert.deepEqual([...names].sort(), ['PostToolUse', 'Stop']);
    const empty = tempRoot('decl-empty');
    try {
      assert.equal(declaredEventNames(empty.root).size, 0);
    } finally { empty.cleanup(); }
  } finally { fx.cleanup(); }
});

// ⑤b 清单在场即权威（终审非阻塞 4 的回归锁）：显式零声明不得被旧生成物"复活"
test('declaredEventNames：清单在场但 hooks:[] ⇒ 空声明（不回落生成物，防"删掉的钩子被复活"）', () => {
  const fx = tempRoot('decl-authoritative');
  try {
    fx.write('plugin.manifest.json', JSON.stringify({ manifestVersion: 1, hooks: [] }));
    fx.write('hooks/hooks.json', JSON.stringify({ hooks: { PostToolUse: [], PostToolUseFailure: [] } }));
    assert.equal(declaredEventNames(fx.root).size, 0, '清单在场即权威：不得回落读生成物');
  } finally { fx.cleanup(); }
});

// ⑥ 装配级：第六参经 runSingleHandler 生效（信封经真实子进程结果解码）
test('runSingleHandler：第六参（声明集）经装配路径生效——声明则采信、未声明则拒', async () => {
  const logger = createLogger();
  const stdout = envelope('PostToolUseFailure');
  const ctx = {
    logger,
    shell: {
      resolve: (request) => request,
      // 宿主 shell 契约：`execute(req)` → `{ result() }` → `{exitCode, stdout:{text}, stderr:{text}}`
      execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }) }),
    },
  };
  const handler = { command: process.execPath, args: ['-e', ''], timeoutMs: 5000 };
  const opts = { cwd: REPO_ROOT, env: {} };
  const declared = [await runSingleHandler(ctx, handler, {}, opts, 'PostToolUse', { allowedEvents: new Set(['PostToolUse', 'PostToolUseFailure']) })];
  assert.equal(declared[0][0].decision, 'deny', '声明该事件时应采信');
  const undeclared = [await runSingleHandler(ctx, handler, {}, opts, 'PostToolUse', { allowedEvents: new Set(['PostToolUse']) })];
  assert.equal(undeclared[0][0].decision, undefined, '未声明时应拒');
});
