// 文件：check-consistency.test.mjs
// 描述：B-M9-4 一致性校验（v3，内部决策-031——判定源本地：mode v3 ∧ .scout/ledger.jsonl
//       留痕比对；桥在场附加中央镜像三方比对）的 TDD 测试：一致双形态（有效对齐/
//       无模式无事件/历史留痕）、本地三类违例（无留痕/expiry 失配/txId 失配）、
//       pendingSync 积压、中央镜像失配、待恢复、v2 待迁移、v1 legacy；
//       2026-10-31 内部任务-259 步骤4 扩：T16 判定树（多 active/陈旧条目、missing/unreadable/
//       corrupt、未留痕关闭防 synced 掩盖、absent+active、converged 中断态）与可执行手工命令。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-consistency.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..', '..');
const SCOUT_TX = join(REPO_ROOT, 'spec-gate', 'assurance', 'scout-tx.mjs');

function future(n) {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--project-root', root], { encoding: 'utf8' });
}

/**
 * 造临时项目：可选写 v3/v2 声明、本地留痕事件（对象数组→jsonl）、中央台账任务数组。
 * 仓库布局下 bridgeAvailable=true，中央比对激活——consistent 用例须给对齐中央条目。
 */
function projectWith({ mode, events = [], central = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scout-consist-'));
  mkdirSync(join(root, '.scout'), { recursive: true });
  if (mode) writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify(mode));
  if (events.length > 0) {
    writeFileSync(join(root, '.scout', 'ledger.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  if (central !== null) {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'ledger.json'), JSON.stringify({ tasks: central }));
  }
  return root;
}

const MODE = (expiry, tx = 'tx-1', taskId = 'TASK-1') => ({ schemaVersion: 3, mode: 'explore', expiry, taskId, transactionId: tx });
const OPEN_EVENT = (expiry, tx = 'tx-1', taskId = 'TASK-1') => ({ event: 'open', mode: 'explore', expiry, taskId, transactionId: tx, at: '2026-09-28T00:00:00Z' });
const CENTRAL = (expiry, tx = 'tx-1', taskId = 'TASK-1') => ({ id: taskId, status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: expiry, transactionId: tx });

test('一致：v3 有效 + 留痕对齐 + 中央镜像对齐 → 退出 0', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)], central: [CENTRAL(expiry)] });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.stdout.includes('consistent'));
    assert.ok(r.stdout.includes('中央镜像'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：mode v3 有效但无本地留痕事件 → 退出 1', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), central: [CENTRAL(expiry)] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('无本地留痕'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：留痕 expiry 与声明不一致 → 退出 1', () => {
  const root = projectWith({ mode: MODE(future(14)), events: [OPEN_EVENT(future(7))], central: null });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('不一致'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：留痕 transactionId 与声明失配 → 退出 1', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry, 'tx-cur'), events: [OPEN_EVENT(expiry, 'tx-old')], central: null });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('txId'), '失配文案点名 txId 比对维度');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：pendingSync 积压 → 退出 1 并指向 sync', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry), { event: 'pendingSync', op: 'open', taskId: 'TASK-1', transactionId: 'tx-1', at: '2026-09-28T00:00:00Z' }],
    central: null,
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('pendingSync'));
    assert.ok(r.stdout.includes('sync'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：中央镜像失配（deadline 不同）→ 退出 1（以本地为准修复指引）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)], central: [CENTRAL(future(3))] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('中央镜像'));
    assert.ok(r.stdout.includes('scout-register'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('一致：无模式文件且无留痕事件 → 退出 0', () => {
  const root = projectWith({});
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('一致：无模式 + 历史 abandon 留痕（正常历史，不判违例）→ 退出 0', () => {
  const expiry = future(14);
  const root = projectWith({
    events: [OPEN_EVENT(expiry), { event: 'abandon', mode: 'explore', taskId: 'TASK-1', transactionId: 'tx-1', disposition: '归档', at: '2026-09-28T00:00:00Z' }],
    central: null,
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.stdout.includes('历史留痕'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('一致：补登后 synced 事件不参与比对（B-M9-4 基准=最近声明变更事件）→ 退出 0', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [
      OPEN_EVENT(expiry),
      // sync 压缩清除已解决 pendingSync 后的形态：仅剩 open 与 synced（带新随机 txId、无 expiry）
      { event: 'synced', replayed: 1, transactionId: 'random-new-uuid', at: '2026-09-28T00:01:00Z' },
    ],
    central: [CENTRAL(expiry)],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：事务待恢复（journal 残留）→ 退出 1 指向 mode-lifecycle recover', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)] });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('recover') && r.stdout.includes('mode-lifecycle.mjs'), '指引须含可执行 recover 命令');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：v2 声明待迁移 → 退出 1 指向 migrate-v2', () => {
  const root = projectWith({ mode: { schemaVersion: 2, mode: 'explore', expiry: future(30), taskId: 'TASK-V2', transactionId: 't' } });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('migrate-v2'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：v1 legacy 声明 → 退出 1', () => {
  const root = projectWith({ mode: { mode: 'explore', expiry: future(30) } });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('legacy'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部决策-065 T16 判定树（内部任务-259 步骤 4）──

test('违例：多 active 中央条目 + 陈旧条目 → 手工命令含 transaction-id/disposition（⑥/⑲）', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale', owner: 'wangp' }],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('陈旧中央条目'), r.stdout);
    assert.ok(r.stdout.includes('scout-register'), r.stdout);
    assert.ok(r.stdout.includes('--transaction-id'), '手工命令必须含 transaction-id');
    assert.ok(r.stdout.includes('--disposition'), '手工命令必须含 disposition');
    assert.match(r.stdout, /--transaction-id [0-9a-f-]{36}/, 'transaction-id 应为真实 UUID 而非占位符');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：中央台账 missing → 指引 sync 补登（⑦a）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)], central: null });
  mkdirSync(join(root, '.sdd'), { recursive: true }); // 存在但无 scout 条目
  writeFileSync(join(root, '.sdd', 'ledger.json'), JSON.stringify({ tasks: [] }));
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('sync 补登'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：中央台账 corrupt → 判损坏且禁 register 重置（⑦b）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)] });
  mkdirSync(join(root, '.sdd'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger.json'), '{not-json');
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('损坏'), r.stdout);
    assert.ok(r.stdout.includes('禁止 register'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：未留痕关闭 → 手工 abandon 命令（⑧）', () => {
  const expiry = future(14);
  const root = projectWith({ events: [OPEN_EVENT(expiry)], central: null });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('未留痕关闭'), r.stdout);
    assert.ok(r.stdout.includes('--transaction-id') && r.stdout.includes('--disposition'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：ledger 坏行 dropped>0（⑩）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)], central: [CENTRAL(expiry)] });
  writeFileSync(join(root, '.scout', 'ledger.jsonl'), `{bad-line\n${JSON.stringify(OPEN_EVENT(expiry))}\n`);
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('坏数据'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：journalCorrupt=true → 判违例并提示核对备份（⑱）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)], central: [CENTRAL(expiry)] });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.corrupt-20260101.json'), '{}');
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('journal 损坏备份'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：absent + 中央 active → 不自动补偿，输出手工命令（⑳ lint 面）', () => {
  const root = projectWith({ central: [CENTRAL(future(9))] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('absent+中央 active'), r.stdout);
    assert.ok(r.stdout.includes('--transaction-id') && r.stdout.includes('--disposition'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 阶段评审 round1 修复轮（H2/F9/⑦/⑲）──

test('违例：graduate 中断态（中央 converged + 本地 active）→ 人工核对/桥维护批，不得指引 sync 死路（H2）', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [{ ...CENTRAL(expiry), status: 'converged', finalStatus: 'complete' }],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /人工核对|桥维护批/, r.stdout);
    assert.ok(!r.stdout.includes('sync 补登'), '禁止指引必然失败的 sync');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('违例：中央台账不可读（路径为目录）→ 判不可读（⑦ unreadable）', () => {
  const expiry = future(14);
  const root = projectWith({ mode: MODE(expiry), events: [OPEN_EVENT(expiry)] });
  mkdirSync(join(root, '.sdd', 'ledger.json'), { recursive: true });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('不可读'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑲ 手工命令可执行：含引号安装根 + 解析执行后中央条目 expired', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale' }],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    const m = r.stdout.match(/node "([^"]+)" scout-register --project-root "([^"]+)" --task-id (\S+) --mode (\S+) --expiry (\S+) --transaction-id (\S+) --event abandon/);
    assert.ok(m, `手工命令形态异常：${r.stdout}`);
    const [, txCli, , taskId, mode, staleExpiry, txId] = m;
    assert.match(txCli, /<spec-gate 安装根>/, '安装根占位须被引号包裹');
    assert.equal(taskId, 'TASK-STALE');
    const exec = spawnSync(process.execPath, [SCOUT_TX, '--project-root', root, 'scout-register',
      '--task-id', taskId, '--mode', mode, '--expiry', staleExpiry, '--transaction-id', txId,
      '--event', 'abandon', '--disposition', '归档'], { encoding: 'utf8' });
    assert.equal(exec.status, 0, exec.stderr || exec.stdout);
    const central = JSON.parse(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'));
    const entry = (central.tasks ?? []).find((t) => t.id === 'TASK-STALE');
    assert.equal(entry.status, 'expired', '模拟执行后陈旧条目收敛');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── round2 评审修复：PC-08 / R2-09 覆盖 ──

test('违例：open 后的 synced 事件不掩盖未留痕关闭（PC-08）', () => {
  const expiry = future(14);
  const root = projectWith({
    events: [OPEN_EVENT(expiry), { event: 'synced', replayed: 0, at: '2026-10-31T00:00:00Z' }],
    central: null,
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /未留痕关闭/, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑲ 手工命令 owner 含空格 → 引号包裹（R2-09）', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale', owner: 'wang mate' }],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("--owner 'wang mate'"), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑲ 手工命令形态校验：mode 非 MODES / owner 含 $() → 安全处理（R3-06）', () => {
  const expiry = future(14);
  const root = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'bogus', deadline: future(9), transactionId: 'tx-stale' }],
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes('scout-register --project-root'), '非法 mode 不得输出不可执行命令');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const root2 = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale', owner: '$(whoami)' }],
  });
  try {
    const r = run(root2);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("--owner '$(whoami)'"), r.stdout);
    assert.ok(!r.stdout.includes('--owner "$(whoami)"'), '双引号会触发命令替换，必须单引号');
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
  // owner 单引号转义、控制字符拒绝、id 含合法点号
  const root3 = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK.STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale', owner: "O'Brien" }],
  });
  try {
    const r = run(root3);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("--owner 'O'\\''Brien'"), `单引号须转义：${r.stdout}`);
    assert.ok(r.stdout.includes('--task-id TASK.STALE'), 'id 允许合法点号');
  } finally {
    rmSync(root3, { recursive: true, force: true });
  }
  const root4 = projectWith({
    mode: MODE(expiry),
    events: [OPEN_EVENT(expiry)],
    central: [CENTRAL(expiry), { id: 'TASK-STALE', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: future(9), transactionId: 'tx-stale', owner: 'bad\nname' }],
  });
  try {
    const r = run(root4);
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes('--owner'), '控制字符 owner 必须降级为人工核对（不输出命令）');
  } finally {
    rmSync(root4, { recursive: true, force: true });
  }
});

test('违例：本地声明不可读（mode.json 为目录）→ T17 权限/占用指引（⑤ unreadable）', () => {
  const expiry = future(14);
  const root = projectWith({ events: [OPEN_EVENT(expiry)] });
  rmSync(join(root, '.scout', 'mode.json'), { force: true });
  mkdirSync(join(root, '.scout', 'mode.json'), { recursive: true });
  try {
    const r = run(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /不可读/, r.stdout);
    assert.match(r.stdout, /EISDIR/, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T13：root 存在但为文件 → 退 2 点名「不是目录」（守卫另一臂，DEV-337）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev337-t13file-'));
  try {
    const fileRoot = join(dir, 'not-a-dir');
    writeFileSync(fileRoot, 'x');
    const r = run(fileRoot);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('不是目录'), `stderr 须点名守卫原因，收到：${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑪：absent+中央 active 字段不全 → 降级文案含「字段不完整或形态不符」（DEV-337 文案锁）', () => {
  const root = projectWith({ central: [{ id: 'TASK-STALE-1', status: 'active', taskType: 'scout-mode' }] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('字段不完整或形态不符，无法生成手工命令'), `降级文案单源锁，收到：${r.stdout}`);
    assert.ok(r.stdout.includes('TASK-STALE-1'), '条目点名保留');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
