// 文件：common.test.mjs
// 描述：common.mjs 单元面（公共基座；迁移史见 内部决策-051）——黄金向量等值/边界钉现状/
//       sha256 三形态/时间戳格式/原子写/路径防护。永久件：只 import common.mjs 与
//       tolerance.mjs，零依赖窗口件（阶段3 拆 Python 面时本文件零改动）。
// 作者：wangp  创建：2026-10-17  版权：MIT（见 spec-gate/LICENSE）
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { trySymlink } from './symlink-helpers.mjs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISO_OFFSET_SECONDS_RE,
  isoOffsetMinutes,
  unwrapSpecial,
} from './tolerance.mjs';
import {
  atomicWriteBytes,
  atomicWriteText,
  canonicalJsonBytes,
  isWithinRoot,
  loadJson,
  nowIso,
  pyEquals,
  pyRepr,
  readUtf8Strict,
  sha256File,
  sha256Hex,
  sha256Prefix,
  toPosix,
} from '../common.mjs';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const GOLDEN = join(TESTS, 'golden');
const canonicalVector = JSON.parse(readFileSync(join(GOLDEN, 'canonical-json.json'), 'utf8'));
const shaVector = JSON.parse(readFileSync(join(GOLDEN, 'sha256.json'), 'utf8'));
const nowIsoVector = JSON.parse(readFileSync(join(GOLDEN, 'now-iso.json'), 'utf8'));

test('G0 黄金向量计数下限（F3：空置两链同盲防线，下限＝生成器当期实数现算）', () => {
  assert.ok(canonicalVector.equalityCases.length >= 14, `equalityCases=${canonicalVector.equalityCases.length}`);
  assert.ok(canonicalVector.boundaryCases.length >= 4, `boundaryCases=${canonicalVector.boundaryCases.length}`);
  assert.ok(shaVector.cases.length >= 6, `sha256 cases=${shaVector.cases.length}`);
  assert.ok(nowIsoVector.cases.length >= 4, `now-iso cases=${nowIsoVector.cases.length}`);
});

test('G1 canonicalJsonBytes 等值组逐 case 字节相等', () => {
  for (const c of canonicalVector.equalityCases) {
    const got = canonicalJsonBytes(unwrapSpecial(c.input));
    const expected = Buffer.from(c.expectedB64, 'base64');
    assert.ok(got.equals(expected), `${c.name}: got ${got.toString('hex')} expected ${expected.toString('hex')}`);
  }
});

test('G1b 边界组钉 JS 现状（ADR-051 D4 已知边界登记——防静默漂移，非跨侧等值）', () => {
  for (const c of canonicalVector.boundaryCases) {
    const got = canonicalJsonBytes(c.input).toString('utf8');
    assert.equal(got, c.jsExpected, `${c.name}（${c.note}）`);
  }
});

test('G2 sha256 三形态：字面量组＋repeat 现造组', () => {
  for (const c of shaVector.cases) {
    let bytes;
    if (c.kind === 'text') bytes = Buffer.from(c.text, 'utf8');
    else bytes = Buffer.from(c.unit.repeat(c.count), 'utf8');
    assert.equal(sha256Hex(bytes), c.expectedHex, `${c.name} hex`);
    assert.equal(sha256Prefix(bytes), c.expectedPrefix, `${c.name} prefix`);
  }
});

test('G3 nowIso 格式（tolerance 单源正则与偏移解析）＋偏移与本机时区一致', () => {
  const got = nowIso();
  assert.match(got, ISO_OFFSET_SECONDS_RE);
  assert.equal(isoOffsetMinutes(got), -new Date().getTimezoneOffset(), '偏移分钟数应等于 -getTimezoneOffset()');
  assert.equal(isoOffsetMinutes('2026-01-01T00:00:00-05:30'), -330, '负半时区偏移解析');
  for (const c of nowIsoVector.cases) assert.match(c.value, ISO_OFFSET_SECONDS_RE, `${c.name} 样本`);
});

test('G4 loadJson：正常对象/根非对象/文件不存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev60-loadjson-'));
  try {
    const okPath = join(dir, 'ok.json');
    writeFileSync(okPath, '{"a":1}', 'utf8');
    assert.deepEqual(loadJson(okPath), { a: 1 });
    const arrPath = join(dir, 'arr.json');
    writeFileSync(arrPath, '[1,2]', 'utf8');
    assert.throws(() => loadJson(arrPath), /JSON 根不是对象/);
    // 严格 UTF-8（复审门①发现 1）：无效字节不得 U+FFFD 静默替换后解析成功
    const badUtf8 = join(dir, 'bad-utf8.json');
    writeFileSync(badUtf8, Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    assert.throws(() => loadJson(badUtf8), /不是有效 UTF-8/);
    assert.throws(() => loadJson(join(dir, 'no-such.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G5 atomicWrite：写读回相等＋异常路径无临时残留（EEXIST 重试分支不可测——随机后缀不可预占，以清理断言代偿，common.mjs 文件头登记）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev60-atomic-'));
  try {
    const target = join(dir, 'nested', 'file.json');
    atomicWriteText(target, '{"中文":"值"}\n');
    assert.equal(readFileSync(target, 'utf8'), '{"中文":"值"}\n');
    atomicWriteBytes(target, Buffer.from('overwrite', 'utf8'));
    assert.equal(readFileSync(target, 'utf8'), 'overwrite');
    // 异常路径：目标路径自身是已存在目录 → rename 失败 → 抛出且无 .adir.* 临时残留
    const dirTarget = join(dir, 'adir');
    mkdirSync(dirTarget);
    assert.throws(() => atomicWriteText(dirTarget, 'x'), /EISDIR|EPERM|ENOTDIR|EEXIST|ENOENT/);
    const residue = readdirSync(dir).filter((f) => f.startsWith('.adir.'));
    assert.deepEqual(residue, [], '异常后不得残留临时文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E02（DEV-241）：无效 UTF-8 读错误带 INVALID_UTF8 code（工具错误可被 CLI 分类退 2）', () => {  const dir = mkdtempSync(join(tmpdir(), 'dev241-common-utf8-'));
  try {
    const bad = join(dir, 'bad.txt');
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00]));
    assert.throws(() => readUtf8Strict(bad), (e) => e.code === 'INVALID_UTF8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEV-242 §三-1/2：toPosix/pyRepr/pyEquals 单源导出等值族', () => {
  assert.equal(toPosix('a/b/c'), 'a/b/c');
  assert.equal(toPosix('a\\b'), process.platform === 'win32' ? 'a/b' : 'a\\b');
  assert.equal(pyRepr(null), 'None');
  assert.equal(pyRepr(true), 'True');
  assert.equal(pyRepr(1.5), '1.5');
  assert.equal(pyRepr("a\nb"), "'a\\nb'");
  assert.equal(pyRepr([1, 'x']), "[1, 'x']");
  assert.equal(pyRepr({ a: null }), "{'a': None}");
  // pyEquals：宽松（Python ==）与严格（jsonl）两模式 + undefinedAsNull（revision）
  assert.equal(pyEquals(true, 1), true, '宽松：True==1');
  assert.equal(pyEquals(true, 1, { strictTypes: true }), false, '严格：禁 True==1');
  assert.equal(pyEquals(Number.NaN, Number.NaN), true, 'NaN==NaN（探针值域）');
  assert.equal(pyEquals({ a: 1, b: 2 }, { b: 2, a: 1 }), true, '对象键序无关');
  assert.equal(pyEquals({ a: 1 }, { a: 1, b: 2 }), false, '键集不同即不等');
  assert.equal(pyEquals(undefined, null), false, '默认不归一 undefined');
  assert.equal(pyEquals(undefined, null, { undefinedAsNull: true }), true, 'revision 模式 undefined→null');
  assert.equal(pyEquals('1', 1), false, 'str↔number 不等（Python 语义）');
});

test('G6 isWithinRoot：内/外/相等/不存在目标/symlink 逃逸/前缀边界', (t) => {  const dir = mkdtempSync(join(tmpdir(), 'dev60-within-'));
  try {
    const inside = join(dir, 'a', 'b.txt');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(inside, 'x');
    assert.equal(isWithinRoot(dir, inside), true, '内');
    assert.equal(isWithinRoot(dir, dir), true, '相等（relative_to 语义）');
    assert.equal(isWithinRoot(dir, join(dir, 'no', 'such', 'deep.txt')), true, '不存在目标仍在根内（宽松 realpath）');
    assert.equal(isWithinRoot(dir, join(dir, '..', 'outside.txt')), false, '越界');
    const siblingPrefix = `${dir}c`;
    mkdirSync(siblingPrefix);
    assert.equal(isWithinRoot(dir, join(`${dir}c`, 'f.txt')), false, '前缀边界：/a/bc 不在 /a/b 内（分隔符判定）');
    // 文件系统根形态（复审门①发现 2）：root='/' 不得因 '//' 前缀恒 false（对齐 relative_to）
    // ——平台无关断言须在 symlink 能力门之前（内部任务-241 wp3 复审：避免首个 trySymlink 跳过连带弱化）
    assert.equal(isWithinRoot(parse(dir).root, dir), true, '根 = 文件系统根时任意绝对路径均在根内');
    const escaped = join(dir, 'escape');
    if (!trySymlink(t, dir, escaped)) return;
    assert.equal(isWithinRoot(join(dir, 'sub'), escaped), false, 'symlink 解析后越界');
    // symlink 段后接 ..（终审正确性发现 1 登记的边界④）：JS resolve 先词法折叠判「内」、
    // Python realpath 逐段解析判「外」——钉 JS 现状非等值对拍；调用面（TASK_ID_RE/_under_root）
    // 已拒 .. 段，形态不达生产
    if (!trySymlink(t, dir, join(dir, 'escape2'))) return;
    assert.equal(isWithinRoot(dir, join(dir, 'escape2', '..', 'inside.txt')), true,
      'symlink+.. 的 JS 现状＝词法折叠后判内（Python 判外——common.mjs 文件头边界④登记）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2b sha256File：文件流式哈希与 sha256Hex 一致（跨 1MiB 块）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev60-shafile-'));
  try {
    const big = join(dir, 'big.bin');
    const payload = Buffer.from('ab'.repeat(524288 + 1), 'utf8');
    writeFileSync(big, payload);
    assert.equal(sha256File(big), sha256Hex(payload));
    assert.throws(() => sha256File(join(dir, 'no-such.bin')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
