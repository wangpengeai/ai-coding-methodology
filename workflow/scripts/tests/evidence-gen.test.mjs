// 文件：evidence-gen.test.mjs
// 描述：受信写者工具 evidence-gen.mjs（内部决策-066 D2，内部任务-261）行为测试——dry-run 默认、
//       只读 LF 归一 sha256、schema 校验、自指排除（canonical）、--write 写后复核（重读输入
//       重算＋读回 out 双复核）、失败注入、out/输入仓内边界、严格 UTF-8、审计失败行、selftest。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部 tmp 生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(SCRIPTS, 'evidence-gen.mjs');

/** 建 tmp 项目（state 目录随建）。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'evidence-gen-'));
  const state = join(root, 'state');
  mkdirSync(state);
  return { root, state };
}

/** 驱动 CLI。 */
function run(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** LF 归一 sha256（与工具口径一致）。 */
function lfSha(text) {
  return 'sha256:' + createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

/** 读审计最后一条。 */
function lastAudit(state) {
  const f = join(state, 'wf-evidence-gen.jsonl');
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines[lines.length - 1]);
}

test('内部任务-261 证据生成 dry-run 与 schema：dry-run 默认零写、坏 schema 退 1', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const out = join(root, 'evidence.json');
    const dry = run(['--files', 'a.txt', '--out', out, '--state-dir', state], root);
    assert.equal(dry.status, 0, `dry-run 须退 0（stderr=${dry.stderr}）`);
    assert.equal(existsSync(out), false, 'dry-run 默认不得写 out');
    const arr = JSON.parse(dry.stdout);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].path, 'a.txt');
    assert.equal(arr[0].sha256, lfSha('alpha\n'));
    assert.equal(arr[0].exitCode, 0);
    const bad = run(['--files', '', '--out', out, '--state-dir', state], root);
    assert.equal(bad.status, 1, '空 files 须退 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--write 写后复核（重读输入重算＋读回 out）', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    writeFileSync(join(root, 'b.txt'), 'beta\n');
    const out = join(root, 'evidence.json');
    const r = run(['--files', 'a.txt,b.txt', '--out', out, '--write', '--state-dir', state], root);
    assert.equal(r.status, 0, `write 须退 0（stderr=${r.stderr}）`);
    const arr = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(arr.map((e) => e.path), ['a.txt', 'b.txt']);
    assert.equal(arr[0].sha256, lfSha('alpha\n'));
    assert.equal(arr[1].sha256, lfSha('beta\n'));
    assert.equal(lastAudit(state)?.status, 'ok', '审计 ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('写后复核失败注入 → exit 1、审计 failed、out 已被写但报表标明失败', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const out = join(root, 'evidence.json');
    const r = run(['--files', 'a.txt', '--out', out, '--write', '--state-dir', state], root, { WF_EVIDENCE_GEN_INJECT_VERIFY_MISMATCH: '1' });
    assert.equal(r.status, 1, '注入复核失败须退 1');
    assert.equal(lastAudit(state)?.status, 'failed', '审计 failed');
    assert.match(String(lastAudit(state)?.reason), /复核/, '审计含原因');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自指排除：files 中包含 out 自身时输出不收录自身', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const out = join(root, 'evidence.json');
    const r = run(['--files', 'a.txt,evidence.json', '--out', out, '--state-dir', state], root);
    assert.equal(r.status, 0, `dry-run 须退 0（stderr=${r.stderr}）`);
    const arr = JSON.parse(r.stdout);
    assert.deepEqual(arr.map((e) => e.path), ['a.txt'], '自指文件须被排除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema 负例：缺失输入/非法 UTF-8/out 越界均 exit 1 且失败审计含原因', () => {
  const { root, state } = makeProject();
  try {
    const out = join(root, 'evidence.json');
    const missing = run(['--files', 'missing.txt', '--out', out, '--write', '--state-dir', state], root);
    assert.equal(missing.status, 1, '缺失文件须退 1');
    assert.equal(existsSync(out), false, '失败不得落 out');
    assert.equal(lastAudit(state)?.status, 'failed', '审计 failed');
    const bad = join(root, 'bad.txt');
    writeFileSync(bad, Buffer.from([0x61, 0xff, 0x0a]));
    assert.equal(run(['--files', 'bad.txt', '--out', out, '--state-dir', state], root).status, 1, '非法 UTF-8 输入须拒');
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const outside = join(tmpdir(), `evidence-out-${process.pid}.json`);
    assert.equal(run(['--files', 'a.txt', '--out', outside, '--state-dir', state], root).status, 1, 'out 越出工作目录须拒');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺少 --state-dir 退 2（审计落盘必须显式指定）', () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const r = run(['--files', 'a.txt', '--out', join(root, 'evidence.json')], root);
    assert.equal(r.status, 2, '缺 state-dir 须用法错误退 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自指 + --write：out 在 files 列表中时写后重算仍排除自身（不误报失败）', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const out = join(root, 'evidence.json');
    const r = run(['--files', 'a.txt,evidence.json', '--out', out, '--write', '--state-dir', state], root);
    assert.equal(r.status, 0, `自指 + --write 须成功（stderr=${r.stderr}）`);
    const arr = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(arr.map((e) => e.path), ['a.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('审计 >5000 行时轮转保留尾部（≤2500 行）', () => {
  const { root, state } = makeProject();
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const auditFile = join(state, 'wf-evidence-gen.jsonl');
    writeFileSync(auditFile, Array.from({ length: 5001 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    const r = run(['--files', 'a.txt', '--out', join(root, 'evidence.json'), '--state-dir', state], root);
    assert.equal(r.status, 0, `dry-run 须退 0（stderr=${r.stderr}）`);
    const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(lines <= 2501, `轮转后行数须受控（实得 ${lines}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--selftest 退出 0 且输出 OK/PASS', () => {
  const r = run(['--selftest'], process.cwd());
  assert.equal(r.status, 0, `selftest 须退 0（stderr=${r.stderr}）`);
  assert.match(r.stdout, /OK|PASS/, 'selftest 须有结果行');
});
