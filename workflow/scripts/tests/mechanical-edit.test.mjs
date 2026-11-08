// 文件：mechanical-edit.test.mjs
// 描述：受信写者工具 mechanical-edit.mjs（内部决策-066 D2，内部任务-261）行为测试——literal-only、
//       expectCount 必填与同文件多条顺序校验、dry-run 默认零写、计数不符整体不写、事务回滚、
//       写后读回、严格 UTF-8/BOM/CRLF 拒写、路径 canonical 仓内、审计（失败行＋轮转）、selftest。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部 tmp 生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(SCRIPTS, 'mechanical-edit.mjs');

/** symlink 可用性探测（Windows 无开发者模式时为 false）。 */
const CAN_SYMLINK = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'mech-symlink-probe-'));
    symlinkSync(d, `${d}-alias`);
    rmSync(`${d}-alias`, { force: true });
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

/** 建 tmp 项目（state 目录随建）。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mech-edit-'));
  const state = join(root, 'state');
  mkdirSync(state);
  return { root, state };
}

/** 驱动 CLI。 */
function run(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 写 spec JSON 到项目内并返回路径。 */
function writeSpec(root, spec) {
  const p = join(root, 'spec.json');
  writeFileSync(p, JSON.stringify(spec));
  return p;
}

/** 读审计行的最后一条（缺失返回 null）。 */
function lastAudit(state) {
  const f = join(state, 'wf-mechanical-edit.jsonl');
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines[lines.length - 1]);
}

test('DEV-261 计数不符整体不写：任一条 expectCount 不符 → exit 1、全部零写、审计 failed', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    writeFileSync(a, 'foo foo\n');
    writeFileSync(b, 'foo\n');
    const spec = writeSpec(root, { edits: [
      { file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 },
      { file: 'b.txt', find: 'foo', replace: 'bar', expectCount: 2 },
    ] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 1, `计数不符须退 1（stderr=${r.stderr}）`);
    assert.equal(readFileSync(a, 'utf8'), 'foo foo\n', '合法条也不得半写');
    assert.equal(readFileSync(b, 'utf8'), 'foo\n', '不符条零写');
    const audit = lastAudit(state);
    assert.equal(audit?.status, 'failed', '审计须记 failed');
    assert.match(String(audit?.reason), /计数不符/, '审计含原因');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同文件多条编辑：按序对当前文本校验并合成一次写（无半写/丢改动）', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo foo baz\n');
    const spec = writeSpec(root, { edits: [
      { file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 },
      { file: 'a.txt', find: 'bar baz', replace: 'qux', expectCount: 1 },
    ] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 0, `同文件多条须成功（stderr=${r.stderr}）`);
    assert.equal(readFileSync(a, 'utf8'), 'bar qux\n', '两条按序合成，最终内容精确');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run 默认零写并输出 JSON 摘要（含 diff）', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo foo\n');
    const spec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 }] });
    const r = run(['--spec', spec, '--state-dir', state], root);
    assert.equal(r.status, 0, `dry-run 须退 0（stderr=${r.stderr}）`);
    assert.equal(readFileSync(a, 'utf8'), 'foo foo\n', '默认 dry-run 不得写盘');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.applied, false);
    assert.equal(out.changes[0].file, 'a.txt');
    assert.ok(Array.isArray(out.diff) && out.diff.length >= 1, 'diff 摘要必须非空');
    assert.equal(out.diff[0].file, 'a.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--apply 落盘、写后读回并写审计', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo foo\n');
    const spec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 }] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 0, `apply 须退 0（stderr=${r.stderr}）`);
    assert.equal(readFileSync(a, 'utf8'), 'bar bar\n', '写后内容须精确');
    assert.equal(lastAudit(state)?.status, 'ok', '审计 status ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('事务回滚：写中途失败 → 两文件均恢复原文（注入缝）', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    writeFileSync(a, 'foo\n');
    writeFileSync(b, 'foo\n');
    const spec = writeSpec(root, { edits: [
      { file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 1 },
      { file: 'b.txt', find: 'foo', replace: 'bar', expectCount: 1 },
    ] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root, { WF_MECH_EDIT_INJECT_WRITE_FAIL: '1' });
    assert.equal(r.status, 1, '注入失败须退 1');
    assert.equal(readFileSync(a, 'utf8'), 'foo\n', 'a 须回滚原文');
    assert.equal(readFileSync(b, 'utf8'), 'foo\n', 'b 须回滚原文');
    assert.equal(lastAudit(state)?.status, 'failed', '审计 failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('事务回滚：读回失败 → 两文件均恢复原文（注入缝）', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    writeFileSync(a, 'foo\n');
    writeFileSync(b, 'foo\n');
    const spec = writeSpec(root, { edits: [
      { file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 1 },
      { file: 'b.txt', find: 'foo', replace: 'bar', expectCount: 1 },
    ] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root, { WF_MECH_EDIT_INJECT_READBACK_FAIL: '1' });
    assert.equal(r.status, 1, '注入读回失败须退 1');
    assert.equal(readFileSync(a, 'utf8'), 'foo\n', 'a 须回滚原文');
    assert.equal(readFileSync(b, 'utf8'), 'foo\n', 'b 须回滚原文');
    assert.equal(lastAudit(state)?.status, 'failed', '审计 failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('literal-only：拒绝 regex/pattern 语义参数；expectCount 缺失退 1', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo\n');
    const regexSpec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'f.o', replace: 'bar', expectCount: 1, regex: true }] });
    assert.equal(run(['--spec', regexSpec, '--apply', '--state-dir', state], root).status, 1, '含 regex 语义参数须退 1');
    const missingCountSpec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'foo', replace: 'bar' }] });
    assert.equal(run(['--spec', missingCountSpec, '--apply', '--state-dir', state], root).status, 1, '缺 expectCount 须退 1');
    assert.equal(readFileSync(a, 'utf8'), 'foo\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('严格 UTF-8/BOM/CRLF：三类源文件均拒写（exit 1、文件不变）', () => {
  const { root, state } = makeProject();
  try {
    const crlf = join(root, 'crlf.txt');
    writeFileSync(crlf, 'foo\r\nfoo\r\n');
    const bom = join(root, 'bom.txt');
    writeFileSync(bom, '\uFEFFfoo\n');
    const bad = join(root, 'bad.txt');
    writeFileSync(bad, Buffer.from([0x66, 0x6f, 0xff, 0x0a]));
    for (const name of ['crlf.txt', 'bom.txt', 'bad.txt']) {
      const spec = writeSpec(root, { edits: [{ file: name, find: 'foo', replace: 'bar', expectCount: 1 }] });
      const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
      assert.equal(r.status, 1, `${name} 须拒写（stderr=${r.stderr}）`);
    }
    assert.equal(readFileSync(crlf, 'utf8'), 'foo\r\nfoo\r\n');
    assert.equal(readFileSync(bom, 'utf8'), '\uFEFFfoo\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路径 canonical 仓内：spec 指向 cwd 之外 → exit 1 且不写', () => {
  const { root, state } = makeProject();
  const outside = join(tmpdir(), `mech-edit-outside-${process.pid}.txt`);
  try {
    writeFileSync(outside, 'foo\n');
    const spec = writeSpec(root, { edits: [{ file: join('..', basename(outside)), find: 'foo', replace: 'bar', expectCount: 1 }] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 1, '仓外路径须拒');
    assert.equal(readFileSync(outside, 'utf8'), 'foo\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('缺少 --state-dir 退 2（审计落盘必须显式指定）', () => {
  const { root } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo\n');
    const spec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 1 }] });
    assert.equal(run(['--spec', spec], root).status, 2, '缺 state-dir 须用法错误退 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路径边界：`..foo` 为首段的仓内合法文件可正常编辑（不误判越界）', () => {
  const { root, state } = makeProject();
  try {
    const target = join(root, '..foo');
    writeFileSync(target, 'foo\n');
    const spec = writeSpec(root, { edits: [{ file: '..foo', find: 'foo', replace: 'bar', expectCount: 1 }] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 0, `..foo 为合法仓内文件（stderr=${r.stderr}）`);
    assert.equal(readFileSync(target, 'utf8'), 'bar\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('symlink 逃逸：仓内 symlink 指向仓外目录 → 拒写', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）' }, () => {
  const { root, state } = makeProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'mech-outside-'));
  try {
    writeFileSync(join(outsideDir, 'x.txt'), 'foo\n');
    symlinkSync(outsideDir, join(root, 'link'));
    const spec = writeSpec(root, { edits: [{ file: 'link/x.txt', find: 'foo', replace: 'bar', expectCount: 1 }] });
    const r = run(['--spec', spec, '--apply', '--state-dir', state], root);
    assert.equal(r.status, 1, 'symlink 指向仓外须拒');
    assert.equal(readFileSync(join(outsideDir, 'x.txt'), 'utf8'), 'foo\n', '仓外文件不得改写');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('审计 >5000 行时轮转保留尾部（≤2500 行）', () => {
  const { root, state } = makeProject();
  try {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'foo\n');
    const auditFile = join(state, 'wf-mechanical-edit.jsonl');
    writeFileSync(auditFile, Array.from({ length: 5001 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    const spec = writeSpec(root, { edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 1 }] });
    const r = run(['--spec', spec, '--state-dir', state], root);
    assert.equal(r.status, 0, `dry-run 须退 0（stderr=${r.stderr}）`);
    const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(lines <= 2501, `轮转后行数须受控（实得 ${lines}）`);
    assert.ok(lines < 2502, '保留尾部');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--selftest 退出 0 且输出 OK/PASS', () => {
  const r = run(['--selftest'], process.cwd());
  assert.equal(r.status, 0, `selftest 须退 0（stderr=${r.stderr}）`);
  assert.match(r.stdout, /OK|PASS/, 'selftest 须有结果行');
});
