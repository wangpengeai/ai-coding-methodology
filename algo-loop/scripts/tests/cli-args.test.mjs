// 文件：cli-args.test.mjs
// 描述：algo-loop 共享 CLI 参数解析与项目根守卫测试（内部任务-269 R08/计划步骤 2；先 RED 后 GREEN）——
//       `--project-root <dir>` / `--project-root=<dir>` 两形态、缺值/空值/尾随旗标用法错误、
//       未知旗标残余、根不存在或非目录守卫；口径对齐 scout cli-main（T13）与 内部接口-22 §3。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/cli-args.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isMainModule, parseProjectRootArg, resolveExistingRoot } from '../cli-args.mjs';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-cliargs-'));
  roots.push(root);
  return root;
}

test('参数矩阵：空格形态 / = 形态 / 缺值 / 空值 / 尾随旗标 / 未知旗标残余', () => {
  const root = makeRoot();
  assert.deepEqual(parseProjectRootArg(['--project-root', root]), { root, rest: [] });
  assert.deepEqual(parseProjectRootArg([`--project-root=${root}`]), { root, rest: [] });
  assert.deepEqual(parseProjectRootArg(['--project-root', root, 'extra']), { root, rest: ['extra'] });
  assert.deepEqual(parseProjectRootArg(['--bogus', root]), { root: null, rest: ['--bogus', root] });
  // 用法错误（null）：缺值 / 空值 / 值以 -- 起笔（尾随旗标）
  assert.equal(parseProjectRootArg(['--project-root']), null);
  assert.equal(parseProjectRootArg(['--project-root=']), null);
  assert.equal(parseProjectRootArg(['--project-root', '--selftest']), null);
  assert.equal(parseProjectRootArg(['--project-root', '']), null);
});

test('根守卫：缺省 cwd / 存在目录通过 / 不存在目录拒绝 / 普通文件拒绝', () => {
  const cwd = resolveExistingRoot(null);
  assert.equal(cwd.ok, true);
  assert.equal(typeof cwd.root, 'string');
  const root = makeRoot();
  const ok = resolveExistingRoot(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.root, root);
  const missing = resolveExistingRoot(join(root, 'no-such-dir'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不存在|不是目录/);
  const file = join(root, 'plain.txt');
  writeFileSync(file, 'x');
  const fileRoot = resolveExistingRoot(file);
  assert.equal(fileRoot.ok, false);
  assert.match(fileRoot.reason, /不存在|不是目录/);
});

test('isMainModule：以本测试文件自身调用返回 true（入口守卫形态）', () => {
  assert.equal(isMainModule(import.meta.url), true);
});

// 清理（本文件只建 tmp 目录）
test.after?.(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
