// 文件：cli-main.test.mjs
// 描述：cli-main 原语直测（内部未决-224⑬ 补测面，内部任务-337）——parseFlags `--__proto__` 无原型语义
//       （自有键、不污染 Object.prototype）与 isMainModule 三形态（resolve 直命中/symlink realpath
//       二轮/非入口 false）。锁现状：行为自 内部任务-259 步骤6 建立即存在，此前无直接单测。
// 作者：wangp 创建：2026-11-06 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/cli-main.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, parseFlags } from '../cli-main.mjs';

test('parseFlags：--__proto__ 落为自有键、不污染 Object.prototype（无原型 flags）', () => {
  const { flags, invalid } = parseFlags(['--__proto__', 'polluted-value']);
  assert.equal(invalid, null);
  assert.ok(Object.prototype.hasOwnProperty.call(flags, '__proto__'), 'flags 持 __proto__ 自有键');
  assert.equal(flags['__proto__'], 'polluted-value');
  assert.equal(({}).polluted, undefined, '任意新对象未受污染');
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype 未被污染');
});

test('isMainModule：直跑 resolve 命中；非入口 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev337-climain-'));
  try {
    const target = join(dir, 'entry.mjs');
    writeFileSync(target, 'export const x = 1;\n');
    const prev = process.argv[1];
    try {
      process.argv[1] = target;
      assert.equal(isMainModule(pathToFileURL(target).href), true, 'resolve 直命中');
      process.argv[1] = join(dir, 'other.mjs');
      assert.equal(isMainModule(pathToFileURL(target).href), false, '非入口 false');
    } finally {
      process.argv[1] = prev;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isMainModule：symlink 经 realpath 二轮命中', { skip: process.platform === 'win32' ? 'win32 文件符号链接需特权（realpath 腿在 posix 直测；win32 行为由真实调用面覆盖）' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev337-climain2-'));
  try {
    const target = join(dir, 'entry.mjs');
    writeFileSync(target, 'export const x = 1;\n');
    const link = join(dir, 'link-to-entry.mjs');
    symlinkSync(target, link);
    // metaUrl 取 real 形态（真实调用面 import.meta.url 恒为 real 路径——darwin tmpdir 经
    // /var→/private/var symlink，raw 形态与 realpathSync 产出恒不等＝平台形态分裂，非生产行为）
    const targetReal = realpathSync(target);
    const prev = process.argv[1];
    try {
      process.argv[1] = link;
      assert.equal(isMainModule(pathToFileURL(targetReal).href), true, 'symlink realpath 二轮命中');
    } finally {
      process.argv[1] = prev;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
