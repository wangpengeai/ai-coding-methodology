// AC-CORE-001 邻域：pycompat 语义基座（Python 3.9 对齐；承接 core-mirror 的 repr/strip/split/date 语义钉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError, cmpPyDateTime, codePointCompare, decodeUtf8Strict, isWithinRoot, nowIso,
  parseNowOrThrow, parsePyIsoDateTime, pyRepr, pySplitLines, pyStrip, pyTruthy, pyTypeName,
  readUtf8Text, realpathLoose, sha256Bytes,
} from '../core/pycompat.mjs';
import { TODO_TOKEN_PATTERN } from '../core/markdown.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-pycompat-')));

test('decodeUtf8Strict：严格 UTF-8、剥离 BOM、通用换行', () => {
  assert.equal(decodeUtf8Strict(Buffer.from('中文\n', 'utf8')), '中文\n');
  assert.equal(decodeUtf8Strict(Buffer.from('\ufeff# x\n', 'utf8')), '# x\n');
  assert.equal(decodeUtf8Strict(Buffer.from('a\r\nb\rc\n', 'utf8')), 'a\nb\nc\n');
  assert.throws(() => decodeUtf8Strict(Buffer.from([0xff, 0xfe])), (e) => e.code === 'UNICODE_DECODE');
});

test('readUtf8Text：读文件并归一', () => {
  const dir = tmp();
  const p = join(dir, 'a.md');
  writeFileSync(p, Buffer.from('\ufeffx\r\ny', 'utf8'));
  assert.equal(readUtf8Text(p), 'x\ny');
});

test('pyStrip：Python 空白集（BOM 不算空白）', () => {
  assert.equal(pyStrip('\u00a0 x \u3000'), 'x');
  assert.equal(pyStrip('\x1cx\x1f'), 'x');
  assert.equal(pyStrip('\ufeffx'), '\ufeffx');
  assert.equal(pyStrip('\u2028x\u2029'), 'x');
});

test('pySplitLines：覆盖 Python splitlines 全部分隔符', () => {
  assert.deepEqual(pySplitLines('a\r\nb\rc\nd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l'), [
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
  ]);
});

test('pyTypeName/pyRepr/pyTruthy：Python 形态', () => {
  assert.equal(pyTypeName(null), 'NoneType');
  assert.equal(pyTypeName([]), 'list');
  assert.equal(pyTypeName({}), 'dict');
  assert.equal(pyTypeName(1), 'int');
  assert.equal(pyTypeName(1.5), 'float');
  assert.equal(pyRepr("a'b"), "'a\\'b'");
  assert.equal(pyRepr([1, 'x']), "[1, 'x']");
  assert.equal(pyRepr(null), 'None');
  assert.equal(pyTruthy([]), false);
  assert.equal(pyTruthy({}), false);
  assert.equal(pyTruthy(0), false);
  assert.equal(pyTruthy('0'), true);
});

test('codePointCompare：非 BMP 按码点而非 UTF-16 码元', () => {
  // UTF-16：U+1F600(高代理 D83D) < U+FFFF；码点：U+FFFF < U+1F600
  assert.ok(codePointCompare('\uFFFF', '\u{1F600}') < 0);
  assert.ok(codePointCompare('a', 'b') < 0);
  assert.equal(codePointCompare('a', 'a'), 0);
  assert.ok(codePointCompare('ab', 'a') > 0);
});

test('F-10：语法 token 用 ASCII 边界（CJK 邻接算边界，ASCII 词内不算）', () => {
  assert.equal(TODO_TOKEN_PATTERN.test('中TODO文'), true);
  assert.equal(TODO_TOKEN_PATTERN.test('a_TODO_b'), false);
  assert.equal(TODO_TOKEN_PATTERN.test('TODOS'), false);
});

test('parsePyIsoDateTime：Python 3.9 文法（任意分隔符/小时精度/3 或 6 位/偏移/Z）', () => {
  assert.ok(parsePyIsoDateTime('2026-10-19'));
  assert.ok(parsePyIsoDateTime('2026-10-19 12:00'));
  assert.ok(parsePyIsoDateTime('2026-10-19T12'));
  assert.ok(parsePyIsoDateTime('2026-10-19t12:30:00'));
  assert.ok(parsePyIsoDateTime('0026-01-01T00:00:00'));
  assert.ok(parsePyIsoDateTime('2026-10-19T12:00:01.123+08:00'));
  assert.ok(parsePyIsoDateTime('2026-10-19T12:00:01.123456Z'));
  assert.ok(parsePyIsoDateTime('2026-10-19T12:00:01+08:00:30'));
  // 偏移秒可带 6 位小数（Python 3.9）：1µs 偏移使 UTC 微秒借位
  const base = parsePyIsoDateTime('2026-10-19T12:00:01+01:02:03');
  const fracOffset = parsePyIsoDateTime('2026-10-19T12:00:01+01:02:03.000001');
  assert.equal(fracOffset.epoch, base.epoch - 1);
  assert.equal(fracOffset.micro, 999999);
  // Python 直跑：偏移小数只接受 6 位，3 位与 1 位均非法
  for (const bad of ['2026-10-19T12:00:01+01:02:03.123', '2026-10-19T12:00:01+01:02:03.1']) {
    assert.equal(parsePyIsoDateTime(bad), null, bad);
  }
  // Python 直跑：+00:99 归一为 +01:39；+08:00:30 合法
  assert.equal(parsePyIsoDateTime('2026-10-19T12:00:01+00:99').epoch,
    parsePyIsoDateTime('2026-10-19T12:00:01+01:39').epoch);
  for (const bad of [
    '2026-13-01', '2026-02-30', '0000-01-01', '2026-10-19T24:00', '2026-10-19T12:60',
    '2026-10-19T12:00:01.1', '2026-10-19T12:00:01.12', '2026-10-19T12:00:01.1234',
    '2026-10-19T12:00:01.12345', '2026-10-19T12:00:01.1234567', 'not-a-date',
    '2026-10-19T12:00:01+0800', '2026-10-19T12:00:01+24:00', '2026-10-19T12:00:01+99:00',
    '2026-10-19T12:00:01-05',
  ]) assert.equal(parsePyIsoDateTime(bad), null, bad);
  assert.equal(parsePyIsoDateTime('2026-10-19T12:00:01.123+08:00').aware, true);
  assert.equal(parsePyIsoDateTime('2026-10-19T12:00:01').aware, false);
});

test('cmpPyDateTime：naive/aware 混比抛 TypeError', () => {
  const naive = parsePyIsoDateTime('2026-01-01T00:00:00');
  const aware = parsePyIsoDateTime('2026-01-01T00:00:00+00:00');
  assert.throws(() => cmpPyDateTime(naive, aware), TypeError);
  assert.equal(cmpPyDateTime(naive, parsePyIsoDateTime('2026-01-02T00:00:00')), -86400);
});

test('parseNowOrThrow：坏 now 抛 ConfigError（F-3）', () => {
  assert.equal(parseNowOrThrow(null), null);
  assert.equal(parseNowOrThrow(''), null);
  assert.ok(parseNowOrThrow('2026-10-19T00:00:00+00:00'));
  assert.throws(() => parseNowOrThrow('bogus'), ConfigError);
});

test('realpathLoose/isWithinRoot：symlink 逃逸拒绝、不存在尾段保留', () => {
  const root = tmp();
  mkdirSync(join(root, 'inside'));
  writeFileSync(join(root, 'inside/a.txt'), 'x');
  const outside = tmp();
  writeFileSync(join(outside, 'secret.txt'), 's');
  symlinkSync(outside, join(root, 'link-out'));
  assert.equal(realpathLoose(join(root, 'inside/a.txt')), join(root, 'inside/a.txt'));
  assert.equal(realpathLoose(join(root, 'missing/../a.txt')), join(root, 'a.txt'));
  assert.equal(isWithinRoot(root, join(root, 'inside/a.txt')), true);
  assert.equal(isWithinRoot(root, realpathLoose(join(root, 'link-out/secret.txt'))), false);
  assert.equal(isWithinRoot(root, root), true);
});

test('nowIso：本地时区带偏移、秒级', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('sha256Bytes：原始字节', () => {
  assert.equal(sha256Bytes(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
