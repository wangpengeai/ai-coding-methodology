// 文件：helpers.test.mjs
// 描述：tests/helpers.mjs 自检（内部任务-257 P5-9；内部任务-337 扩容）——夹具本身可被消费
//       （tmpHome/runCli/runNode/enterEnv/makeProcTree×2），防死代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enterEnv, makeProcTree, makeProcTreeMinimal, runCli, runNode, tmpHome } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../governance-cli.mjs', import.meta.url));

test('helpers：tmpHome 建临时根、runCli 跑 init 得 JSON', () => {
  const root = tmpHome('tg-helper-');
  try {
    assert.ok(existsSync(root));
    const r = runCli(CLI, root, ['init']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json?.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('helpers：runNode 返回 spawnSync 原象（string stdout/status；无 json 包装）', () => {
  const root = tmpHome('tg-helper-runnode-');
  try {
    const raw = runNode(CLI, ['--project-root', root, 'init']);
    assert.equal(typeof raw.stdout, 'string', 'encoding utf8 原象');
    assert.equal(typeof raw.status, 'number');
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal('json' in raw, false, 'runNode 无 json 字段（json 包装属 runCli）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('helpers：enterEnv 注入/还原（undefined 键删除、有值键还原）', () => {
  const k = 'TG_HELPER_PROBE';
  const restore = enterEnv({ [k]: 'x' });
  assert.equal(process.env[k], 'x');
  restore();
  assert.equal(k in process.env, false, '旧值 undefined → delete');
  process.env[k] = 'old';
  const restore2 = enterEnv({ [k]: 'new' });
  assert.equal(process.env[k], 'new');
  restore2();
  assert.equal(process.env[k], 'old', '旧值有值 → 还原');
  delete process.env[k];
});

test('helpers：两份 /proc 替身树形态锁定（全量 vs 精简，OPEN-223）', () => {
  const full = tmpHome('tg-helper-full-');
  const mini = tmpHome('tg-helper-mini-');
  try {
    makeProcTree(full);
    makeProcTreeMinimal(mini);
    const read = (root, p) => readFileSync(join(root, 'net', p), 'utf8');
    assert.equal(read(full, 'tcp').trim().split('\n').length, 4, '全量 tcp=表头+3 行');
    assert.equal(read(mini, 'tcp').trim().split('\n').length, 2, '精简 tcp=表头+1 行');
    assert.equal(read(full, 'tcp6').trim().split('\n').length, 4, '全量 tcp6=表头+3 行');
    assert.equal(read(mini, 'tcp6'), '', '精简 tcp6=空文件');
    assert.ok(existsSync(join(full, '7', 'comm')), '全量含 pid 7 归因负例');
    assert.ok(!existsSync(join(mini, '7')), '精简无 pid 7');
    // fd symlink 指向不存在的 socket:[…] 目标——existsSync 跟随恒 false，用 lstat（不跟随）锁形态
    assert.ok(lstatSync(join(full, '4242', 'fd', '1')).isSymbolicLink(), '全量双 fd');
    assert.throws(() => lstatSync(join(mini, '4242', 'fd', '1')), '精简单 fd（fd/1 不存在）');
  } finally {
    rmSync(full, { recursive: true, force: true });
    rmSync(mini, { recursive: true, force: true });
  }
});
