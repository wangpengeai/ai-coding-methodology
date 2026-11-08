// 文件：atomic-jsonl.test.mjs
// 描述：内部任务-257 批 5（P5-1/P5-2）结构单源测试——atomicWrite 原子落盘与失败清理 tmp、readJsonlTolerant 坏行计数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteJson, atomicWriteText } from '../lib/atomic-write.mjs';
import { readJsonlTolerant } from '../lib/jsonl.mjs';

test('atomicWrite：写入成功且无 tmp 残留、失败不残留 tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-atomic-'));
  try {
    const target = join(dir, 'x.json');
    atomicWriteJson(target, { a: 1 });
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { a: 1 });
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '成功路径无 tmp 残留');
    // 目标为「已存在的目录」→ tmp 先成功落盘、renameSync 失败进入清理分支（真实覆盖 cleanup，三维评审修复）
    const dirTarget = join(dir, 'as-dir');
    mkdirSync(dirTarget, { recursive: true });
    assert.throws(() => atomicWriteJson(dirTarget, { a: 1 }), /EISDIR|EPERM|ENOTEMPTY/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '失败路径不残留 tmp（rename 失败分支）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readJsonlTolerant：坏行跳过并计数、空行忽略、记录保序', () => {
  const text = ['{"id":"a"}', '', '{"id":"b"}', 'not-json', '{"id":"c"}', ''].join(String.fromCharCode(10));
  const r = readJsonlTolerant(text);
  assert.deepEqual(r.records.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(r.badLines, 1);
  assert.deepEqual(readJsonlTolerant('').records, []);
});

test('jsonl-single-source：store/learning/incident 均经 readJsonlTolerant（调用断言）', async () => {
  const fs = await import('node:fs');
  const read = (f) => fs.readFileSync(new URL('../lib/' + f, import.meta.url), 'utf8');
  for (const f of ['governance-store.mjs', 'learning-store.mjs', 'incident-source.mjs']) {
    const src = read(f);
    assert.ok(src.includes('readJsonlTolerant('), f + ' 须调用 readJsonlTolerant');
    assert.ok(!/for \(const line of text\.split/.test(src), f + ' 不得保留自解析循环');
  }
});

