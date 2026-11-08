// 文件：cli-behavior.test.mjs
// 描述：内部任务-259 步骤 7 CLI 行为/错误封装/可观测（B-14/B-15/B-16/C-1/C-6/D-7/T13/T14/T20）子进程级验收。
//       子进程（spawnSync）锁真实退出码/stdout/stderr 契约；覆盖 T13 严格参数、T14 工具错误 JSON 退 2 无栈、
//       status 可观测字段（pendingSync/centralSync 三态）、大 stdout 完整性与 recover --force 透传。
// 作者：wangp 创建：2026-10-31 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/cli-behavior.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');
const ML = join(SCRIPTS, 'mode-lifecycle.mjs');
const CC = join(SCRIPTS, 'check-consistency.mjs');
const BRIDGE = join(resolve(SCRIPTS, '..', '..'), 'spec-gate', 'assurance', 'scout-tx.mjs');
const TS = '2999-01-01';

function tmp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts });
}

function writeMode(root, { taskId = '内部任务-7', expiry = TS } = {}) {
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry, taskId, transactionId: 'tx-1' }));
}

function writeCentral(root, tasks) {
  mkdirSync(join(root, '.sdd'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger.json'), JSON.stringify({ tasks }));
}

test('T13：未知旗标 / 缺值 / 空值 / --dry-run / 布尔 = 值 → 退 2', () => {
  const root = tmp('dev259-t13-');
  try {
    assert.equal(run(ML, ['--project-root', root, 'status', '--bogus=x']).status, 2, '未知旗标 = 形态');
    assert.equal(run(ML, ['--project-root', root, 'status', '--bogus', 'v']).status, 2, '未知旗标 空格形态');
    assert.equal(run(ML, ['--project-root', root, 'open', '--mode']).status, 2, '缺值');
    assert.equal(run(ML, ['--project-root', '', 'status']).status, 2, 'project-root 空值（空格形态）');
    assert.equal(run(ML, ['--project-root=', 'status']).status, 2, 'project-root 空值（= 形态）');
    assert.equal(run(ML, ['--project-root', root, 'recover', '--force=false']).status, 2, '布尔旗标 = 值须拒（S-01）');
    assert.equal(run(ML, ['--project-root', root, 'status', '--dry-run']).status, 2, '--dry-run 未实现须退 2');
    assert.equal(run(CC, ['--project-root', root, '--bogus']).status, 2, 'lint 未知旗标');
    assert.equal(run(ML, ['--project-root', root, 'status', 'extra-positional']).status, 2, '多余位置参数');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T13：--flag=value 受理 + --project-root 前置/后置两形态成功', () => {
  const root = tmp('dev259-t13eq-');
  try {
    const before = run(ML, ['--project-root', root, 'open', '--mode=explore', `--expiry=${TS}`, '--task-id=内部任务-7']);
    assert.equal(before.status, 0, before.stderr || before.stdout);
    assert.equal(JSON.parse(before.stdout.trim()).ok, true);
    const post = run(ML, ['status', '--project-root', root]);
    assert.equal(post.status, 0, post.stderr || post.stdout);
    assert.equal(JSON.parse(post.stdout.trim()).valid, true);
    const postEq = run(ML, [`--project-root=${root}`, 'status']);
    assert.equal(postEq.status, 0);
    assert.equal(JSON.parse(postEq.stdout.trim()).valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T14：fs 工具错误（.scout 为普通文件 → ENOTDIR）→ stdout JSON ok:false+code=tool-error 且退 2 无栈', () => {
  const root = tmp('dev259-t14-');
  try {
    writeFileSync(join(root, '.scout'), 'not-a-dir'); // 跨平台确定性：ENOTDIR，不依赖 chmod/root 语义
    const r = run(ML, ['--project-root', root, 'open', '--mode', 'explore', '--expiry', TS, '--task-id', '内部任务-7']);
    assert.equal(r.status, 2, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout.trim());
    assert.equal(body.ok, false);
    assert.equal(body.code, 'tool-error');
    assert.ok(body.error.length > 0);
    assert.ok(!/\n\s+at /.test(r.stdout + r.stderr), '不得输出栈');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T14：大 stdout 子进程完整（lint 多违例输出不截断）', () => {
  const root = tmp('dev259-largeout-');
  try {
    writeMode(root, { taskId: '内部任务-7' });
    writeFileSync(join(root, '.scout', 'ledger.jsonl'), JSON.stringify({ event: 'open', mode: 'explore', expiry: TS, taskId: '内部任务-7', transactionId: 'tx-1' }) + '\n');
    const tasks = [];
    for (let i = 0; i < 300; i += 1) {
      tasks.push({ id: `TASK-STALE-${i}`, status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: '2030-01-01', transactionId: `tx-${i}` });
    }
    writeCentral(root, tasks);
    const r = run(CC, ['--project-root', root]);
    assert.equal(r.status, 1, '多违例须退 1');
    assert.ok(r.stdout.length > 50_000, `stdout 须完整（实际 ${r.stdout.length}）`);
    assert.ok(r.stdout.endsWith('\n'), 'stdout 须以换行收尾（无截断）');
    assert.match(r.stdout, /内部任务-STALE-299/, '末尾条目须完整输出');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T20：status pendingSync 计数与 centralSync 三态（unknown/missing/present）', () => {
  const root = tmp('dev259-t20-');
  const env = { ...process.env, SCOUT_TX_PROVIDER: BRIDGE }; // pin 桥在场（与仓布局解耦，S-15）
  try {
    writeMode(root, { taskId: '内部任务-7' });
    // pendingSync 2 + 无 .sdd → unknown
    writeFileSync(join(root, '.scout', 'ledger.jsonl'), [
      JSON.stringify({ event: 'open', mode: 'explore', expiry: TS, taskId: '内部任务-7', transactionId: 'tx-1' }),
      JSON.stringify({ event: 'pendingSync', op: 'open', taskId: '内部任务-7' }),
      JSON.stringify({ event: 'pendingSync', op: 'renew', taskId: '内部任务-7' }),
    ].join('\n') + '\n');
    const unknown = JSON.parse(run(ML, ['--project-root', root, 'status'], { env }).stdout.trim());
    assert.equal(unknown.pendingSync, 2, JSON.stringify(unknown));
    assert.equal(unknown.centralSync, 'unknown', JSON.stringify(unknown));
    // 中央台账可读但无条目 → missing
    writeCentral(root, []);
    const missing = JSON.parse(run(ML, ['--project-root', root, 'status'], { env }).stdout.trim());
    assert.equal(missing.centralSync, 'missing', JSON.stringify(missing));
    // 中央有条目 → present
    writeCentral(root, [{ id: '内部任务-7', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: TS, transactionId: 'tx-1' }]);
    const present = JSON.parse(run(ML, ['--project-root', root, 'status'], { env }).stdout.trim());
    assert.equal(present.centralSync, 'present', JSON.stringify(present));
    // 损坏台账（tasks 非数组）→ unknown（C-5 分态）
    writeFileSync(join(root, '.sdd', 'ledger.json'), JSON.stringify({ tasks: 'broken' }));
    const corrupt = JSON.parse(run(ML, ['--project-root', root, 'status'], { env }).stdout.trim());
    assert.equal(corrupt.centralSync, 'unknown', JSON.stringify(corrupt));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T13：check-consistency --project-root= 与空格形态等价；root 不存在退 2', () => {
  const root = tmp('dev259-cc-');
  try {
    const eq = run(CC, [`--project-root=${root}`]);
    const sp = run(CC, ['--project-root', root]);
    assert.equal(eq.status, 0, eq.stderr);
    assert.equal(sp.status, 0, sp.stderr);
    assert.equal(eq.stdout, sp.stdout);
    const missing = run(CC, ['--project-root', join(root, 'nope')]);
    assert.equal(missing.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T15/T14：abandon 拒绝文案含 taskId 与下一步（本地/中央未变更）', () => {
  const root = tmp('dev259-abandon-rej-');
  try {
    writeMode(root, { taskId: '内部任务-7' });
    const r = run(ML, ['--project-root', root, 'abandon', '--task-id', 'DEV-OTHER', '--disposition', '归档']);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout.trim());
    assert.equal(body.ok, false);
    assert.match(body.error, /DEV-OTHER/, body.error);
    assert.match(body.error, /本地与中央均未变更/, body.error);
    assert.match(body.error, /先运行 status/, '拒绝文案须给下一步（status 核对）');
    assert.match(body.error, /recover/, '拒绝文案须给下一步（recover）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T13：recover --force（存活 PID 锁）受理并透传', () => {
  const root = tmp('dev259-recover-force-');
  try {
    mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
    writeFileSync(join(root, '.scout', 'transactions', 'lock'), `recover:abcd1234:${process.pid}`);
    const r = run(ML, ['--project-root', root, 'recover', '--force']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout.trim());
    assert.equal(body.ok, true, JSON.stringify(body));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
