// 文件：mode-lifecycle.test.mjs
// 描述：scout 生命周期自治实现（内部决策-031 / 内部接口-12 v2 本地侧）的故障注入矩阵
//       与行为锁定测试——内部验收-7 单权威裁剪版 + 迁移（内部验收-9）+ pendingSync/sync
//       补登（内部验收-9）+ v2 journal 兼容恢复。TDD 先行：本文件即 mode-lifecycle.mjs
//       导出 API 的契约（open/renew/abandon/status/recover/migrateV2/sync/_testHooks）。
// 作者：wangp  创建：2026-09-28  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块；env 注入一律 try/finally 还原；fixture 一律临时目录自建。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
  openSync, closeSync, utimesSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'mode-lifecycle.mjs');
const m = await import('../mode-lifecycle.mjs');

// 临时目录统一登记、after 钩子统一清理（与同批 mode-state.test.mjs 同口径）
const tmpRoots = [];
const track = (r) => { tmpRoots.push(r); return r; };
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

/** 造一个空项目根（.scout 目录按需由被测代码自建）。 */
function makeRoot() {
  return track(mkdtempSync(join(tmpdir(), 'scout-v3-')));
}

/** 读 ledger.jsonl 全部事件。 */
function ledgerEvents(root) {
  const p = join(root, '.scout', 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 造桥 stub（node 入口形态，内部任务-86 阶段1b 起 provider 为 .mjs）：ok=true 输出成功 JSON；
 *  ok=false 输出错误 JSON 退 1。 */
function makeBridgeStub(ok) {
  const dir = track(mkdtempSync(join(tmpdir(), 'scout-bridge-')));
  const js = join(dir, 'bridge.mjs');
  writeFileSync(
    js,
    ok
      ? 'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");\n'
      : 'process.stdout.write(JSON.stringify({ ok: false, error: "stub 登记失败" }) + "\\n");\nprocess.exit(1);\n',
  );
  return js;
}

/** 设 SCOUT_TX_PROVIDER 并返回还原函数。 */
function withProvider(path) {
  const prev = process.env.SCOUT_TX_PROVIDER;
  process.env.SCOUT_TX_PROVIDER = path;
  return () => {
    if (prev === undefined) delete process.env.SCOUT_TX_PROVIDER;
    else process.env.SCOUT_TX_PROVIDER = prev;
  };
}

// ── happy path ──

test('open：v3 五字段落盘 + open 事件留痕 + status valid', async () => {
  const root = makeRoot();
  const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' });
  assert.equal(r.ok, true);
  const mode = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  assert.equal(mode.schemaVersion, 3);
  assert.equal(mode.mode, 'explore');
  assert.equal(mode.taskId, 'TASK-T-1');
  assert.ok(mode.transactionId);
  const ev = ledgerEvents(root);
  assert.equal(ev[0].event, 'open');
  assert.equal(ev[0].taskId, 'TASK-T-1');
  assert.equal(ev[0].expiry, '2999-01-01');
  const s = m.status(root);
  assert.equal(s.valid, true);
  assert.equal(s.mode, 'explore');
  assert.equal(s.taskId, 'TASK-T-1');
});

test('open：参数校验（非法 mode / taskId / expiry 形态）拒绝且不写状态', async () => {
  const root = makeRoot();
  assert.equal(m.open(root, { mode: 'bogus', expiry: '2999-01-01', taskId: 'TASK-T-1' }).ok, false);
  assert.equal(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'bad id!' }).ok, false);
  assert.equal(m.open(root, { mode: 'explore', expiry: '01/01/2999', taskId: 'TASK-T-1' }).ok, false);
  assert.equal(existsSync(join(root, '.scout', 'mode.json')), false);
  assert.deepEqual(ledgerEvents(root), []);
});

test('open：任务号并集形态（OPEN-76）——域前缀新形态通过，坏形态仍拒', async () => {
  const root = makeRoot();
  const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'DEV-1' });
  assert.equal(r.ok, true, '域前缀任务号（workflow 新形态）可通过');
  const mode = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  assert.equal(mode.taskId, 'DEV-1');
  const root2 = makeRoot();
  assert.equal(m.open(root2, { mode: 'explore', expiry: '2999-01-01', taskId: 'dev-1' }).ok, false, '小写域码仍拒（并集只认大写域码）');
});

test('open：重复开启拒绝且既有状态保持', async () => {
  const root = makeRoot();
  assert.equal(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' }).ok, true);
  const again = m.open(root, { mode: 'disposable', expiry: '2999-02-02', taskId: 'TASK-T-2' });
  assert.equal(again.ok, false);
  const s = m.status(root);
  assert.equal(s.valid, true);
  assert.equal(s.mode, 'explore');
  assert.equal(s.taskId, 'TASK-T-1');
});

test('renew：更新 expiry + transactionId 轮换 + renew 事件', async () => {
  const root = makeRoot();
  const first = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  const r = m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-06-01' });
  assert.equal(r.ok, true);
  const mode = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  assert.equal(mode.expiry, '2999-06-01');
  assert.notEqual(mode.transactionId, first.transactionId);
  const s = m.status(root);
  assert.equal(s.valid, true);
  assert.equal(s.expiry, '2999-06-01');
  assert.equal(s.transactionId, mode.transactionId);
  assert.ok(ledgerEvents(root).some((e) => e.event === 'renew'));
});

test('renew：非本任务或非活跃模式拒绝', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  assert.equal(m.renew(root, { taskId: 'TASK-OTHER', newExpiry: '2999-06-01' }).ok, false);
});

test('abandon：删除 mode + abandon 事件含 disposition', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'disposable', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  const r = m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档，不并入主干' });
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(root, '.scout', 'mode.json')), false);
  const ev = ledgerEvents(root).find((e) => e.event === 'abandon');
  assert.equal(ev.disposition, '归档，不并入主干');
  assert.equal(m.status(root).valid, false);
});

test('abandon：空 disposition 拒绝（B-M9-3 处置声明义务）', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'disposable', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  assert.equal(m.abandon(root, { taskId: 'TASK-T-1', disposition: '  ' }).ok, false);
  assert.equal(m.status(root).valid, true);
});

test('status：过期声明 valid=false 且 overdue=true（保留 mode/expiry 供提醒）', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2000-01-01', taskId: 'TASK-T-1' });
  const s = m.status(root);
  assert.equal(s.valid, false);
  assert.equal(s.overdue, true);
  assert.equal(s.mode, 'explore');
  assert.equal(s.expiry, '2000-01-01');
});

// ── 锁语义 ──

test('并发单胜：新鲜他人锁存在时 open 认负退 1，状态不变', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  const lockFd = openSync(join(root, '.scout', 'transactions', 'lock'), 'wx');
  closeSync(lockFd);
  const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  assert.equal(r.ok, false);
  assert.equal(m.status(root).valid, false);
});

test('陈旧锁回收：mtime 超过 300s 的锁经 rename 占先后回收，open 成功', async () => {
  const root = makeRoot();
  const txDir = join(root, '.scout', 'transactions');
  mkdirSync(txDir, { recursive: true });
  const lockPath = join(txDir, 'lock');
  const fd = openSync(lockPath, 'w');
  closeSync(fd);
  const stale = new Date(Date.now() - 400_000);
  utimesSync(lockPath, stale, stale);
  const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  assert.equal(r.ok, true);
  assert.equal(m.status(root).valid, true);
  assert.equal(existsSync(lockPath), false);
});

// ── 故障注入矩阵（内部验收-7 单权威裁剪版，经 _testHooks 崩溃点）──

test('故障注入：journal 写后崩溃 → 无模式 + pendingRecovery → recover 回滚', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  const beforeMode = readFileSync(join(root, '.scout', 'mode.json'), 'utf8');
  const beforeLen = statSync(join(root, '.scout', 'ledger.jsonl')).size;
  m._testHooks.afterJournal = () => { throw new Error('注入故障：journal 后'); };
  try {
    const r = m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-07-01' });
    assert.equal(r.ok, false);
  } finally {
    m._testHooks.afterJournal = null;
  }
  const s = m.status(root);
  assert.equal(s.valid, false);
  assert.equal(s.pendingRecovery, true);
  const rec = m.recover(root);
  assert.equal(rec.ok, true);
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), beforeMode);
  assert.equal(statSync(join(root, '.scout', 'ledger.jsonl')).size, beforeLen);
  assert.equal(m.status(root).valid, true);
});

test('故障注入：ledger append 后崩溃 → recover truncate 回滚、mode 未写新值', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  const beforeMode = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  const beforeLen = statSync(join(root, '.scout', 'ledger.jsonl')).size;
  m._testHooks.afterLedgerAppend = () => { throw new Error('注入故障：ledger 后'); };
  try {
    m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-08-01' });
  } finally {
    m._testHooks.afterLedgerAppend = null;
  }
  assert.equal(m.status(root).valid, false);
  m.recover(root);
  assert.equal(statSync(join(root, '.scout', 'ledger.jsonl')).size, beforeLen);
  const restored = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  assert.equal(restored.expiry, beforeMode.expiry);
  assert.equal(restored.transactionId, beforeMode.transactionId);
});

test('故障注入：abandon 中断 → recover 恢复 mode 文件', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  m._testHooks.afterLedgerAppend = () => { throw new Error('注入故障：mode 提交前'); };
  try {
    m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' });
  } finally {
    m._testHooks.afterLedgerAppend = null;
  }
  assert.equal(m.status(root).valid, false);
  m.recover(root);
  assert.equal(m.status(root).valid, true);
});

test('recover：无 journal 残留只清锁（action=clean，幂等）', async () => {
  const root = makeRoot();
  m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  const r1 = m.recover(root);
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'clean');
  const r2 = m.recover(root);
  assert.equal(r2.action, 'clean');
  assert.equal(m.status(root).valid, true);
});

// ── v2 迁移（内部验收-9）──

test('migrateV2：合法未过期 v2 → 保留 mode/expiry/taskId、轮换 txId、归档旧件、migrate 事件', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(
    join(root, '.scout', 'mode.json'),
    JSON.stringify({ schemaVersion: 2, mode: 'disposable', expiry: '2999-03-03', taskId: 'TASK-V2-1', transactionId: 'oldtx' }),
  );
  const r = m.migrateV2(root);
  assert.equal(r.ok, true);
  const mode = JSON.parse(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'));
  assert.equal(mode.schemaVersion, 3);
  assert.equal(mode.mode, 'disposable');
  assert.equal(mode.expiry, '2999-03-03');
  assert.equal(mode.taskId, 'TASK-V2-1');
  assert.notEqual(mode.transactionId, 'oldtx');
  assert.ok(existsSync(join(root, '.scout', 'mode.json.v2-retired')));
  assert.ok(ledgerEvents(root).some((e) => e.event === 'migrate' && e.from === 'v2'));
  assert.equal(m.status(root).valid, true);
});

test('migrateV2：v1 / 损坏 / 已过期 v2 拒绝迁移（按无模式处理）', async () => {
  const root1 = makeRoot();
  mkdirSync(join(root1, '.scout'), { recursive: true });
  writeFileSync(join(root1, '.scout', 'mode.json'), JSON.stringify({ mode: 'explore', expiry: '2999-01-01' }));
  assert.equal(m.migrateV2(root1).ok, false);
  const root2 = makeRoot();
  mkdirSync(join(root2, '.scout'), { recursive: true });
  writeFileSync(join(root2, '.scout', 'mode.json'), 'not-json');
  assert.equal(m.migrateV2(root2).ok, false);
  const root3 = makeRoot();
  mkdirSync(join(root3, '.scout'), { recursive: true });
  writeFileSync(
    join(root3, '.scout', 'mode.json'),
    JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2000-01-01', taskId: 'TASK-OLD', transactionId: 't' }),
  );
  assert.equal(m.migrateV2(root3).ok, false);
});

test('故障注入：migrate-v2 中断 → pendingRecovery → recover 回滚到 v2 原件（A-M9-7 迁移中断项）', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout'), { recursive: true });
  const v2Text = `${JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-05-05', taskId: 'TASK-V2-9', transactionId: 'oldtx' })}\n`;
  writeFileSync(join(root, '.scout', 'mode.json'), v2Text);
  m._testHooks.afterLedgerAppend = () => { throw new Error('注入故障：迁移留痕后'); };
  try {
    assert.equal(m.migrateV2(root).ok, false);
  } finally {
    m._testHooks.afterLedgerAppend = null;
  }
  const s = m.status(root);
  assert.equal(s.valid, false);
  assert.equal(s.pendingRecovery, true);
  m.recover(root);
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), v2Text);
  assert.equal(m.status(root).reason, 'migratable-v2');
});

// ── pendingSync / sync 补登（内部验收-9；内部接口-12 §4）──

test('SCOUT_TX_PROVIDER 指 .py：明示退役错误（计划修订 10），本地权威不反转', () => {
  const root = makeRoot();
  const dir = track(mkdtempSync(join(tmpdir(), 'scout-pystub-')));
  const py = join(dir, 'bridge.py');
  writeFileSync(py, '# legacy python bridge\n');
  const restore = withProvider(py);
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, true);
    assert.ok(String(r.warning).includes('已随 1b 退役，改指 scout-tx.mjs'), `实际 warning：${r.warning}`);
  } finally {
    restore();
  }
  assert.equal(m.status(root).valid, true);
  assert.ok(ledgerEvents(root).some((e) => e.event === 'pendingSync'));
});

test('桥登记失败：open 仍 ok 但留 pendingSync 事件（本地权威不反转）', async () => {
  const root = makeRoot();
  const restore = withProvider(makeBridgeStub(false));
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, true);
  } finally {
    restore();
  }
  assert.equal(m.status(root).valid, true);
  assert.ok(ledgerEvents(root).some((e) => e.event === 'pendingSync'));
});

test('sync：换成功 stub 重放 pendingSync → synced 事件、pendingSync 清除', async () => {
  const root = makeRoot();
  const restoreFail = withProvider(makeBridgeStub(false));
  try {
    m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  } finally {
    restoreFail();
  }
  const restoreOk = withProvider(makeBridgeStub(true));
  try {
    const r = m.sync(root);
    assert.equal(r.ok, true);
    assert.equal(r.replayed, 1);
    assert.equal(r.superseded, 0);
  } finally {
    restoreOk();
  }
  const ev = ledgerEvents(root);
  assert.ok(ev.some((e) => e.event === 'synced'));
  assert.equal(ev.filter((e) => e.event === 'pendingSync').length, 0);
});

test('sync：后续成功事务按 taskId 压缩清除早期 pendingSync（不重放，ADR-065 T6/F8）', async () => {
  const root = makeRoot();
  // 场景：open 桥失败留 pendingSync(txA) → 桥恢复后 abandon 直接登记成功 → 同 taskId 的早期意图被压缩清除
  const restoreFail = withProvider(makeBridgeStub(false));
  try {
    m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
  } finally {
    restoreFail();
  }
  const restoreOk = withProvider(makeBridgeStub(true));
  try {
    m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' }); // 成功事务按 taskId 压缩早期 pending
    const r = m.sync(root);
    assert.equal(r.ok, true);
    assert.equal(r.replayed, 0, '被取代的 open 意图不得重放');
    assert.equal(r.superseded, 0, '早期 pending 已被前序成功事务压缩清除');
  } finally {
    restoreOk();
  }
  const ev = ledgerEvents(root);
  assert.equal(ev.filter((e) => e.event === 'pendingSync').length, 0, '早期意图已被成功事务压缩清除');
  assert.ok(ev.some((e) => e.event === 'synced'));
});

// ── v2 journal 兼容 ──

test('v2 journal 兼容：before 含 ledgerText 的残留可被 recover 消费（忽略该字段）', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(
    join(root, '.scout', 'mode.json'),
    JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-V2', transactionId: 't' }),
  );
  writeFileSync(
    join(root, '.scout', 'transactions', 'journal.json'),
    JSON.stringify({
      schemaVersion: 1, transactionId: 't', op: 'open', state: 'prepared',
      before: { modeExists: true, modeText: '{"schemaVersion":2}', ledgerText: '{"tasks":[]}' },
      after: {},
    }),
  );
  const r = m.recover(root);
  assert.equal(r.ok, true);
  // 回滚结果断言（非弱断言）：mode 字节恢复为 before.modeText、journal 清除、锁释放
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), '{"schemaVersion":2}', 'recover 须按 before 快照恢复 mode 字节');
  assert.equal(existsSync(join(root, '.scout', 'transactions', 'journal.json')), false, 'journal 须清除');
  assert.equal(existsSync(join(root, '.scout', 'transactions', 'lock')), false, '锁须释放');
});

// ── 锁与恢复并发/注入（内部决策-065 T1/T2；步骤 2 RED 先行）──

const TX = (root) => join(root, '.scout', 'transactions');
const LOCKP = (root) => join(TX(root), 'lock');
const JOURNALP = (root) => join(TX(root), 'journal.json');

/** 死 PID（子进程已退出，可被 process.kill(pid,0) 判定为不存在）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
}

/** 异步跑 CLI（并发用例用：spawn 两个子进程同时起跑）。 */
function runCliAsync(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    let out = '';
    let code = null;
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', () => {});
    c.on('close', (c0) => { code = c0; res({ code, out }); });
  });
}

function seedValidMode(root) {
  mkdirSync(join(root, '.scout'), { recursive: true });
  const text = `${JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx0' }, null, 2)}\n`;
  writeFileSync(join(root, '.scout', 'mode.json'), text);
  return text;
}

function seedJournal(root, before) {
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(JOURNALP(root), JSON.stringify({ schemaVersion: 1, transactionId: 't', op: 'open', state: 'prepared', before }));
}

test('recover：活跃 PID 锁 → 拒绝且不删锁/journal', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `abandon:deadbeef:${process.pid}`);
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  const r = m.recover(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /进行中|PID/, JSON.stringify(r));
  assert.equal(existsSync(LOCKP(root)), true, '活跃锁不得被删除');
  assert.equal(existsSync(JOURNALP(root)), true, '活跃事务 journal 不得被清理');
});

test('recover：死 PID＋新鲜 mtime → 非 force 成功回收并回滚', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `abandon:feedface:${deadPid()}`); // 新鲜 mtime + 死 PID
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  const r = m.recover(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'rollback');
  assert.equal(existsSync(LOCKP(root)), false);
  assert.equal(existsSync(JOURNALP(root)), false);
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), modeText);
});

test('锁：双回收竞态终态一致（至少一方成功恢复，回滚有界）', async () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `abandon:cafebabe:${deadPid()}`);
  const stale = new Date(Date.now() - 400_000);
  utimesSync(LOCKP(root), stale, stale);
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  const [a, b] = await Promise.all([
    runCliAsync(['--project-root', root, 'recover']),
    runCliAsync(['--project-root', root, 'recover']),
  ]);
  const parsed = [a, b].map((r) => {
    assert.ok(r.code === 0 || r.code === 1, `退出码异常：${r.code} ${r.out}`);
    let body;
    assert.doesNotThrow(() => { body = JSON.parse(r.out.trim()); }, `stdout 必须为合法 JSON：${r.out}`);
    return { code: r.code, body };
  });
  const okCount = parsed.filter((p) => p.body.ok === true).length;
  const rollbacks = parsed.filter((p) => p.body.action === 'rollback').length;
  assert.ok(okCount >= 1, `至少一方成功完成恢复：${JSON.stringify(parsed)}`);
  assert.ok(rollbacks >= 1 && rollbacks <= 2, `回滚动作应有界（1-2 次，幂等）：${JSON.stringify(parsed)}`);
  for (const p of parsed) if (p.body.ok === true) assert.ok(['clean', 'rollback'].includes(p.body.action));
  assert.equal(existsSync(LOCKP(root)), false, '结束后不得残留锁');
  assert.equal(existsSync(JOURNALP(root)), false, '结束后不得残留 journal');
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), modeText, '回滚目标不得损坏');
});

test('releaseLock：owner 不匹配不删除他人锁', () => {
  const root = makeRoot();
  mkdirSync(TX(root), { recursive: true });
  m._testHooks.afterLockAcquired = (path) => { writeFileSync(path, `other:12345678:${process.pid}`); };
  try {
    const r = m.recover(root);
    assert.equal(r.ok, true);
  } finally {
    m._testHooks.afterLockAcquired = null;
  }
  assert.equal(existsSync(LOCKP(root)), true, 'owner 失配时释放不得删除锁');
  rmSync(LOCKP(root), { force: true });
});

test('acquireLock：owner 写失败回滚自建锁且操作失败可见', () => {
  const root = makeRoot();
  m._testHooks.beforeLockOwnerWrite = () => { throw new Error('注入故障：owner 写失败'); };
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, false);
  } finally {
    m._testHooks.beforeLockOwnerWrite = null;
  }
  assert.equal(existsSync(LOCKP(root)), false, '自建的半成品锁必须被回滚清理');
  assert.equal(m.status(root).valid, false);
});

test('recover：journal 不可解析 → ok:false、备份 journal.corrupt-*、修复后可 recover', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(JOURNALP(root), 'not-json');
  const r = m.recover(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(existsSync(JOURNALP(root)), false, '不可解析 journal 须移出现场');
  assert.equal(readFileSync(join(root, '.scout', 'mode.json'), 'utf8'), modeText, '损坏 journal 不得改动 mode');
  const backups = readdirSync(TX(root)).filter((n) => n.startsWith('journal.corrupt-'));
  assert.equal(backups.length, 1, `应有 1 份 corrupt 备份，实际 ${JSON.stringify(backups)}`);
  assert.equal(existsSync(LOCKP(root)), false, '恢复后释放自持锁，不残留锁（崩溃现场锁已被 pidAware 回收）');
  // 内部决策-065 T2：journal.corrupt-* 不阻塞后续事务——人工核对备份不属于 recover 前置门禁
  const r2 = m.recover(root);
  assert.equal(r2.ok, true);
  assert.equal(r2.action, 'clean');
  rmSync(join(TX(root), backups[0]));
});

test('recover --force：存活 PID → 回收并 warning（显式覆盖）', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `abandon:deadbeef:${process.pid}`);
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  const r = m.recover(root, { force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'rollback');
  assert.ok(String(r.warning || '').includes('force'), JSON.stringify(r));
  assert.equal(existsSync(LOCKP(root)), false);
  assert.equal(existsSync(JOURNALP(root)), false);
});

test('readStatus：journal.corrupt-* 存在 → journalCorrupt=true', async () => {
  const root = makeRoot();
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(join(TX(root), 'journal.corrupt-20260101T000000.json'), '{}');
  const { readStatus } = await import('../mode-state.mjs');
  const s = readStatus(root);
  assert.equal(s.journalCorrupt, true);
});

test('selftest：临时根清理（成功面）', () => {
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('scout-ml-selftest-')));
  const r = spawnSync(process.execPath, [CLI, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith('scout-ml-selftest-') && !before.has(n));
  assert.deepEqual(leaked, [], `selftest 临时根泄漏：${JSON.stringify(leaked)}`);
});

// ── 阶段评审修复轮（CR-1/2/3/5；内部决策-065 T2 决策树与注入缝）──

test('recover：存活 PID＋陈旧 mtime → 拒绝（PID 活性优先于 300s 陈旧窗口）', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `abandon:deadbeef:${process.pid}`);
  const stale = new Date(Date.now() - 400_000);
  utimesSync(LOCKP(root), stale, stale);
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  const r = m.recover(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /进行中|PID/);
  assert.equal(existsSync(LOCKP(root)), true, '活跃 PID 锁不得被回收');
  assert.equal(existsSync(JOURNALP(root)), true, '活跃事务 journal 不得被回滚');
});

test('recover：无 PID/不可判定新鲜锁 → 拒绝并提示 --force', () => {
  const root = makeRoot();
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), 'graduate-fixed-owner-string');
  const r = m.recover(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /--force/);
  assert.equal(existsSync(LOCKP(root)), true);
});

test('锁：盗到新鲜锁 → link 复原并认负（注入缝确定性）', () => {
  const root = makeRoot();
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `old:feedface:${deadPid()}`);
  const stale = new Date(Date.now() - 400_000);
  utimesSync(LOCKP(root), stale, stale);
  m._testHooks.afterStaleRename = ({ retired }) => {
    writeFileSync(retired, `other:deadbeef:${process.pid}`);
    utimesSync(retired, new Date(), new Date());
  };
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /让位|进行中/);
    assert.equal(existsSync(LOCKP(root)), true, '新鲜锁必须被 link 复原（不得删他人锁）');
    assert.match(readFileSync(LOCKP(root), 'utf8'), /^other:deadbeef:/);
  } finally {
    m._testHooks.afterStaleRename = null;
    rmSync(LOCKP(root), { force: true });
  }
});

test('锁：link 复原失败 → fail-stop 保留证据（注入缝）', () => {
  const root = makeRoot();
  mkdirSync(TX(root), { recursive: true });
  writeFileSync(LOCKP(root), `old:feedface:${deadPid()}`);
  const stale = new Date(Date.now() - 400_000);
  utimesSync(LOCKP(root), stale, stale);
  m._testHooks.afterStaleRename = ({ lockPath, retired }) => {
    // 同时阻断 link 复原：retired 改写为「新鲜+存活 PID」（不许盗取），并在锁位建目录使 linkSync 抛 EEXIST
    writeFileSync(retired, `other:deadbeef:${process.pid}`);
    utimesSync(retired, new Date(), new Date());
    mkdirSync(lockPath);
  };
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /fail-stop/);
    const retired = readdirSync(TX(root)).filter((n) => n.startsWith('lock.retired-'));
    assert.equal(retired.length, 1, '独占证据（retired）必须保留');
  } finally {
    m._testHooks.afterStaleRename = null;
    rmSync(LOCKP(root), { recursive: true, force: true });
    for (const n of readdirSync(TX(root)).filter((x) => x.startsWith('lock.retired-'))) rmSync(join(TX(root), n), { force: true });
  }
});

test('recover：回滚核对失败 → ok:false 且保留 journal（注入缝）', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  m._testHooks.afterRollback = (r0) => {
    writeFileSync(join(r0, '.scout', 'mode.json'), '{"schemaVersion":3,"mode":"explore","expiry":"2999-01-01","taskId":"TASK-CHG","transactionId":"tx9"}\n');
  };
  try {
    const r = m.recover(root);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /回滚核对失败/);
    assert.equal(existsSync(JOURNALP(root)), true, '核对失败必须保留 journal 现场');
  } finally {
    m._testHooks.afterRollback = null;
    rmSync(JOURNALP(root), { force: true });
  }
});

test('recover：回滚写入失败 → ok:false 且保留 journal（注入）', () => {
  const root = makeRoot();
  const modeText = seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  seedJournal(root, { modeExists: true, modeText, ledgerLength: 0 });
  // 把 mode.json 换成目录 → rollback 的原子 rename 失败，回滚异常必须映射为 ok:false 保留 journal
  rmSync(join(root, '.scout', 'mode.json'), { force: true });
  mkdirSync(join(root, '.scout', 'mode.json'));
  try {
    const r = m.recover(root);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /回滚失败/);
    assert.equal(existsSync(JOURNALP(root)), true, '回滚失败必须保留 journal 现场');
  } finally {
    rmSync(join(root, '.scout', 'mode.json'), { recursive: true, force: true });
    rmSync(JOURNALP(root), { force: true });
  }
});

test('recover --force：无锁可覆盖时不虚报覆盖 warning（T2 映射）', () => {
  const root = makeRoot();
  const r = m.recover(root, { force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warning, undefined, '未发生锁回收时不得输出「已覆盖活性检查并回收」');
});

// ── 步骤 3：事务守卫/open 复核/sync 与坏数据（内部决策-065 T3/T4/T6/T7/T12/T15）──

/** 记录桥：把每次调用的 argv 追加到 calls.jsonl 并返回成功。 */
function makeRecordingBridge() {
  const dir = track(mkdtempSync(join(tmpdir(), 'scout-rec-')));
  const callsFile = join(dir, 'calls.jsonl');
  const js = join(dir, 'bridge.mjs');
  writeFileSync(
    js,
    'import { appendFileSync } from "node:fs";\n'
    + `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`
    + 'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");\n',
  );
  return {
    js,
    calls: () => (existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []),
  };
}

/** 直接构造 ledger.jsonl（省略 at 时间戳由 assert 侧不依赖）。 */
function seedLedger(root, events) {
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

test('journal 残留：open/renew/abandon/migrate/sync 全部拒绝且 journal 不变', () => {
  const root = makeRoot();
  seedValidMode(root);
  mkdirSync(TX(root), { recursive: true });
  const journalText = JSON.stringify({ schemaVersion: 1, transactionId: 't', op: 'open', state: 'prepared', before: { modeExists: true, modeText: 'x', ledgerLength: 0 } });
  writeFileSync(JOURNALP(root), journalText);
  const checks = [
    m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-2' }),
    m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-02-02' }),
    m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' }),
    m.sync(root),
  ];
  for (const r of checks) {
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.recoverRequired, true, `失败回执须带 recoverRequired：${JSON.stringify(r)}`);
    assert.match(String(r.error), /recover/, `失败回执须指向 recover：${JSON.stringify(r)}`);
  }
  // migrate-v2 需先有合法 v2 声明才会进入锁内守卫（无 v2 时按「无可迁移」返回，不触守卫）
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 't2' }));
  const mig = m.migrateV2(root);
  assert.equal(mig.ok, false, JSON.stringify(mig));
  assert.equal(mig.recoverRequired, true, JSON.stringify(mig));
  assert.match(String(mig.error), /recover/, JSON.stringify(mig));
  assert.equal(readFileSync(JOURNALP(root), 'utf8'), journalText, 'journal 不得被覆盖');
});

test('open：锁内复核拦截并发覆盖', () => {
  const root = makeRoot();
  m._testHooks.afterLockAcquired = () => {
    mkdirSync(join(root, '.scout'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-OTHER', transactionId: 't' }));
  };
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.concurrencyRejected, true, JSON.stringify(r));
  } finally {
    m._testHooks.afterLockAcquired = null;
  }
});

test('abandon：删 mode 失败回滚退 1', () => {
  const root = makeRoot();
  seedValidMode(root);
  m._testHooks.beforeAbandonUnlink = ({ modePath: mp }) => {
    rmSync(mp, { force: true });
    mkdirSync(mp); // unlink(目录) 抛 EISDIR/EPERM，触发 T5 失败回滚路径
  };
  try {
    const r = m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /删除失败|已回滚/, JSON.stringify(r));
  } finally {
    m._testHooks.beforeAbandonUnlink = null;
    rmSync(join(root, '.scout', 'mode.json'), { recursive: true, force: true });
  }
});

test('sync：后续 renew 取代早期 pendingSync（中央=新 expiry/txId）', () => {
  const root = makeRoot();
  const stub = makeRecordingBridge();
  const restore = withProvider(stub.js);
  try {
    seedLedger(root, [
      { at: 't0', event: 'pendingSync', op: 'open', taskId: 'TASK-T-1', transactionId: 'tx-old', payload: { event: 'open', mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx-old' } },
      { at: 't1', event: 'renew', mode: 'explore', expiry: '2999-02-02', taskId: 'TASK-T-1', transactionId: 'tx-new' },
      { at: 't2', event: 'pendingSync', op: 'renew', taskId: 'TASK-T-1', transactionId: 'tx-new', payload: { event: 'renew', mode: 'explore', expiry: '2999-02-02', taskId: 'TASK-T-1', transactionId: 'tx-new' } },
    ]);
    const r = m.sync(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.replayed, 1, JSON.stringify(r));
    assert.equal(r.superseded, 1, JSON.stringify(r));
    const calls = stub.calls();
    assert.equal(calls.length, 1, '只重放新事件');
    assert.ok(calls[0].includes('2999-02-02'), calls[0].join(' '));
    assert.ok(calls[0].includes('tx-new'), calls[0].join(' '));
  } finally {
    restore();
  }
});

test('sync：skippedInvalid payload 压缩且计数', () => {
  const root = makeRoot();
  seedLedger(root, [
    { at: 't0', event: 'pendingSync', op: 'open', taskId: 'TASK-T-1', transactionId: 'tx-bad', payload: { event: 'open', mode: 'explore', taskId: 'TASK-T-1', transactionId: 'tx-bad' } },
  ]);
  const r = m.sync(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.replayed, 0);
  assert.equal(r.skippedInvalid, 1, JSON.stringify(r));
  const events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.event === 'pendingSync').length, 0, '不可重放 payload 随压缩清除');
  assert.equal(events.filter((e) => e.event === 'synced').length, 1);
  assert.equal(events.find((e) => e.event === 'synced').skippedInvalid, 1);
});

test('migrate-v2：非法 mode 拒绝', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 2, mode: 'bogus', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 't' }));
  const r = m.migrateV2(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /非法|无可迁移|合法 v2/);
});

test('ledger：坏行 dropped 计数、压缩拒绝重写', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout'), { recursive: true });
  const goodPending = JSON.stringify({ at: 't0', event: 'pendingSync', op: 'open', taskId: 'TASK-T-1', transactionId: 'tx1', payload: { event: 'open', mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx1' } });
  writeFileSync(join(root, '.scout', 'ledger.jsonl'), `{bad-json-line\n${goodPending}\n`);
  const r = m.sync(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /坏数据/);
  assert.match(readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8'), /\{bad-json-line/, '拒绝压缩重写须保留原文件');
});

test('sync：锁超预算（模拟）→ ok:false 保留 pending', () => {
  const root = makeRoot();
  const stub = makeRecordingBridge();
  const restore = withProvider(stub.js);
  m._testHooks.syncBudgetMs = -1;
  try {
    seedLedger(root, [
      { at: 't0', event: 'pendingSync', op: 'open', taskId: 'TASK-T-1', transactionId: 'tx1', payload: { event: 'open', mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx1' } },
    ]);
    const r = m.sync(root);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /预算/);
    assert.equal(stub.calls().length, 0, '预算耗尽前不得调桥');
    assert.match(readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8'), /pendingSync/, 'pending 保留');
  } finally {
    m._testHooks.syncBudgetMs = null;
    restore();
  }
});

test('sync：锁 owner 失配（写前 fencing）→ 放弃写入 ok:false', () => {
  const root = makeRoot();
  const stub = makeRecordingBridge();
  const restore = withProvider(stub.js);
  m._testHooks.beforeSyncWrite = ({ lockPath: lp }) => {
    writeFileSync(lp, `other:deadbeef:${process.pid}`);
  };
  try {
    seedLedger(root, [
      { at: 't0', event: 'pendingSync', op: 'open', taskId: 'TASK-T-1', transactionId: 'tx1', payload: { event: 'open', mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx1' } },
    ]);
    const r = m.sync(root);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /fencing|owner/);
    assert.match(readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8'), /pendingSync/, 'pending 保留');
  } finally {
    m._testHooks.beforeSyncWrite = null;
    rmSync(LOCKP(root), { force: true });
    restore();
  }
});

// ── 步骤 4：桥接语义（内部决策-065 T8/T9/T10/T11）──

/** 失败桥：stderr 首行 + 退 1（T10 诊断断言用）。 */
function makeStderrBridge() {
  const dir = track(mkdtempSync(join(tmpdir(), 'scout-stderr-')));
  const js = join(dir, 'bridge.mjs');
  writeFileSync(js, 'process.stderr.write("bridge-stderr-first\\n");\nprocess.exit(1);\n');
  return js;
}

test('桥缺席：open 零 pendingSync/零 warning；abandon 静默 pendingSync；sync 无事返回', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = false;
  try {
    const opened = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.warning, undefined, '桥缺席不得 warning');
    let events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync').length, 0, 'open 桥缺席不落 pendingSync');
    const ab = m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' });
    assert.equal(ab.ok, true, JSON.stringify(ab));
    assert.equal(ab.warning, undefined, '桥缺席 abandon 不 warning');
    events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pending = events.filter((e) => e.event === 'pendingSync');
    assert.equal(pending.length, 1, 'abandon 例外：静默 pendingSync 保留终局意图');
    assert.equal(pending[0].op, 'abandon');
    assert.equal(pending[0].payload.disposition, '归档');
    const s = m.sync(root);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.bridgeAvailable, false);
  } finally {
    m._testHooks.bridgePresent = null;
  }
});

test('桥失败：warning 含 stderr 首行（T10 诊断）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  const prev = process.env.SCOUT_TX_PROVIDER;
  process.env.SCOUT_TX_PROVIDER = makeStderrBridge();
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.warning), /bridge-stderr-first/, String(r.warning));
  } finally {
    if (prev === undefined) delete process.env.SCOUT_TX_PROVIDER; else process.env.SCOUT_TX_PROVIDER = prev;
    m._testHooks.bridgePresent = null;
  }
});

test('崩溃：register 成功后 compact 前中断 → pendingSync 保留、再次 sync 幂等收敛（⑪）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  m._testHooks.afterBridgeBeforeCompact = () => { throw new Error('注入：登记成功后压缩前中断'); };
  const restore = withProvider(makeRecordingBridge().js);
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /事务失败/);
    assert.equal(existsSync(JOURNALP(root)), false, 'journal 已清（崩溃点在 journalClear 之后）');
    const events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync').length, 1, 'pendingSync 保留供 sync 补登');
  } finally {
    m._testHooks.afterBridgeBeforeCompact = null;
    const s = m.sync(root);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.replayed, 1);
    const events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync').length, 0, 'sync 幂等收敛后清除');
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('compact 失败：warning + pendingSync 保留（⑫）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  m._testHooks.compactFail = () => { throw new Error('注入：压缩失败'); };
  const restore = withProvider(makeRecordingBridge().js);
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.warning), /压缩失败/, String(r.warning));
    const events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync').length, 1, 'pendingSync 保留');
  } finally {
    m._testHooks.compactFail = null;
    const s = m.sync(root);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.replayed, 1);
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('owner：renew/abandon 未显式传 owner 时沿用最近声明 owner（T11）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' }).ok);
    assert.ok(m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-02-02' }).ok);
    assert.ok(m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' }).ok);
    const calls = rec.calls();
    assert.equal(calls.length, 3, JSON.stringify(calls));
    for (const argv of calls) {
      const i = argv.indexOf('--owner');
      assert.ok(i >= 0 && argv[i + 1] === 'wangp', `每次桥调用须带 owner=wangp：${argv.join(' ')}`);
    }
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('sync：桥在场时零 pending 也补登当前声明（T8）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = false;
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' }).ok);
  } finally {
    m._testHooks.bridgePresent = null;
  }
  m._testHooks.bridgePresent = true;
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  try {
    const s = m.sync(root);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.declaration, 'registered', JSON.stringify(s));
    const calls = rec.calls();
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.ok(calls[0].includes('2999-01-01'));
    assert.ok(calls[0].includes('TASK-T-1'));
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('sync：本地 expired/absent + 中央 active → 不自动补偿（只留 lint 指引，⑳）', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.sdd'), { recursive: true });
  const centralText = `${JSON.stringify({ tasks: [{ id: 'TASK-OLD', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: '2999-01-01', transactionId: 'tx-old' }] }, null, 2)}\n`;
  writeFileSync(join(root, '.sdd', 'ledger.json'), centralText);
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: '2000-01-01', taskId: 'TASK-EXPIRED', transactionId: 'tx-e' }));
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  m._testHooks.bridgePresent = true;
  try {
    const r = m.sync(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(rec.calls().length, 0, 'expired 声明不得触发自动登记/补偿');
    assert.equal(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'), centralText, 'sync 不得改中央台账（无补偿分支）');
    const { events } = { events: readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
    assert.equal(events.filter((e) => e.event === 'synced').length, 1);
    assert.equal(events.find((e) => e.event === 'synced').declaration, 'skipped');
    rmSync(join(root, '.scout', 'mode.json'), { force: true });
    const r2 = m.sync(root);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(rec.calls().length, 0, 'absent 本地声明不得触发补偿');
    assert.equal(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'), centralText, 'absent+中央 active 同样不得改中央');
  } finally {
    m._testHooks.bridgePresent = null;
    restore();
  }
});

// ── CLI 退出码契约 ──

test('CLI：非法参数退 2，正常 open 退 0，双开退 1', async () => {
  const root = makeRoot();
  const bad = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'bogus', '--expiry', '2999-01-01', '--task-id', 'TASK-T-1'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const good = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'explore', '--expiry', '2999-01-01', '--task-id', 'TASK-T-1'], { encoding: 'utf8' });
  assert.equal(good.status, 0);
  const dup = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'disposable', '--expiry', '2999-02-02', '--task-id', 'TASK-T-2'], { encoding: 'utf8' });
  assert.equal(dup.status, 1);
});

test('ADR-045 三段任务号受理（与 workflow 主源形态同步——OPEN-125 scout 侧钉死哨兵）', async () => {
  const root = makeRoot();
  try {
    const ok3 = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'explore', '--expiry', '2999-01-01', '--task-id', 'DEV-WP-1'], { encoding: 'utf8' });
    assert.equal(ok3.status, 0, '三段形态 open 受理（可选维护者段）');
    const badLower = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'disposable', '--expiry', '2999-02-02', '--task-id', 'DEV-wp-2'], { encoding: 'utf8' });
    assert.equal(badLower.status, 2, '维护者码小写拒（invalidArgs 退 2）');
    const bad4 = spawnSync(process.execPath, [CLI, '--project-root', root, 'open', '--mode', 'disposable', '--expiry', '2999-03-03', '--task-id', 'DEV-WP-X-3'], { encoding: 'utf8' });
    assert.equal(bad4.status, 2, '四段形态拒');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 步骤 4 阶段评审修复轮（T8/T11 + ⑰/⑳）──

test('owner：renew/abandon 显式 --owner 覆盖最近声明 owner（T11）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' }).ok);
    assert.ok(m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-02-02', owner: 'explicit-renew' }).ok);
    assert.ok(m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档', owner: 'explicit-abandon' }).ok);
    const owners = rec.calls().map((argv) => argv[argv.indexOf('--owner') + 1]);
    assert.deepEqual(owners, ['wangp', 'explicit-renew', 'explicit-abandon'], JSON.stringify(rec.calls()));
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('abandon + compactFail → sync 幂等收敛且审计字段保留（⑰）', () => {
  const root = makeRoot();
  m._testHooks.bridgePresent = true;
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', owner: 'wangp' }).ok);
    m._testHooks.compactFail = () => { throw new Error('注入：压缩失败'); };
    const ab = m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' });
    assert.equal(ab.ok, true, JSON.stringify(ab));
    assert.match(String(ab.warning), /压缩失败/, String(ab.warning));
    let events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync' && e.op === 'abandon').length, 1, 'pendingSync 保留供 sync 收敛');
    m._testHooks.compactFail = null;
    const s = m.sync(root);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.replayed, 1, JSON.stringify(s));
    events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'pendingSync').length, 0, 'sync 幂等收敛后清除');
    const abandonCall = rec.calls().find((argv) => argv[argv.indexOf('--event') + 1] === 'abandon');
    assert.ok(abandonCall, 'sync 重放须调 abandon 登记');
    assert.ok(abandonCall.includes('归档'), '审计字段 disposition 保留');
  } finally {
    m._testHooks.compactFail = null;
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('sync：本地 corrupt 声明 + 中央 active → 不自动补偿（⑳ corrupt 变体）', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.sdd'), { recursive: true });
  const centralText = `${JSON.stringify({ tasks: [{ id: 'TASK-OLD', status: 'active', taskType: 'scout-mode', mode: 'explore', deadline: '2999-01-01', transactionId: 'tx-old' }] }, null, 2)}\n`;
  writeFileSync(join(root, '.sdd', 'ledger.json'), centralText);
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), 'not-json');
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  m._testHooks.bridgePresent = true;
  try {
    const r = m.sync(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.skippedDeclaration, true, JSON.stringify(r));
    assert.equal(rec.calls().length, 0, 'corrupt 声明不得触发自动登记/补偿');
    assert.equal(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'), centralText, 'sync 不得改中央台账（无补偿分支）');
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

// ── round2 评审修复：覆盖修复轮行为变更（F5/T10/migrate owner）──

test('sync：零 pending + 有效声明 + 超预算 → 声明补登前失败且 pending 未压缩（F5）', () => {
  const root = makeRoot();
  seedValidMode(root);
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  m._testHooks.bridgePresent = true;
  m._testHooks.syncBudgetMs = -1;
  try {
    const r = m.sync(root);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /预算/);
    assert.equal(r.declaration, 'pending', JSON.stringify(r));
    assert.equal(rec.calls().length, 0, '预算耗尽时不得调桥');
  } finally {
    m._testHooks.syncBudgetMs = null;
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('桥失败：stdout 非 JSON → warning 含 stdout 原文摘要（T10）', () => {
  const root = makeRoot();
  const dir = track(mkdtempSync(join(tmpdir(), 'scout-garbage-')));
  const stub = join(dir, 'bridge.mjs');
  writeFileSync(stub, 'process.stdout.write("bridge-stdout-garbage\\n");\n');
  const restore = withProvider(stub);
  m._testHooks.bridgePresent = true;
  try {
    const r = m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.warning), /stdout: bridge-stdout-garbage/, String(r.warning));
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('migrate-v2：桥调用携带 owner（缺省 unknown，F6）', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1', transactionId: 'tx-v2' }));
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  m._testHooks.bridgePresent = true;
  try {
    const r = m.migrateV2(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    const calls = rec.calls();
    assert.equal(calls.length, 1, JSON.stringify(calls));
    const i = calls[0].indexOf('--owner');
    assert.ok(i >= 0 && calls[0][i + 1] === 'unknown', `migrate 桥调用须带 owner=unknown：${calls[0].join(' ')}`);
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

test('sync：declarationHint 按 reason 分态（absent→null；corrupt→recover；v2→migrate；expired→检查点）', () => {
  const root = makeRoot();
  const rec = makeRecordingBridge();
  const restore = withProvider(rec.js);
  m._testHooks.bridgePresent = true;
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' }).ok);
    assert.ok(m.abandon(root, { taskId: 'TASK-T-1', disposition: '归档' }).ok);
    const absent = m.sync(root);
    assert.equal(absent.ok, true, JSON.stringify(absent));
    assert.equal(absent.skippedDeclaration, true, JSON.stringify(absent));
    assert.equal(absent.declarationHint, null, 'absent（已关闭）不得提示声明损坏/recover');
    assert.equal(absent.declarationReason, 'absent', JSON.stringify(absent));
    mkdirSync(join(root, '.scout'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), 'not-json');
    const corrupt = m.sync(root);
    assert.equal(corrupt.ok, true, JSON.stringify(corrupt));
    assert.equal(corrupt.declarationReason, 'corrupt', JSON.stringify(corrupt));
    assert.match(String(corrupt.declarationHint), /recover/, JSON.stringify(corrupt));
    writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-2', transactionId: 't' }));
    const v2 = m.sync(root);
    assert.equal(v2.declarationReason, 'migratable-v2', JSON.stringify(v2));
    assert.match(String(v2.declarationHint), /migrate-v2/, JSON.stringify(v2));
    writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: '2000-01-01', taskId: 'TASK-T-3', transactionId: 't' }));
    const expired = m.sync(root);
    assert.equal(expired.declarationReason, 'expired', JSON.stringify(expired));
    assert.match(String(expired.declarationHint), /到期检查点/, JSON.stringify(expired));
  } finally {
    restore();
    m._testHooks.bridgePresent = null;
  }
});

// ── 步骤 9（故障注入）：mode 原子写后崩溃 → recover 回滚 ──

test('故障注入：mode 原子写后崩溃 → recover 回滚到事务前 mode 字节与 ledger 长度', () => {
  const root = makeRoot();
  const modePath = join(root, '.scout', 'mode.json');
  const ledgerPath = join(root, '.scout', 'ledger.jsonl');
  const ledgerLines = () => readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).length;
  try {
    assert.ok(m.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-T-1' }).ok);
    const beforeMode = readFileSync(modePath);
    const beforeLines = ledgerLines();
    // rename 后崩溃：磁盘 mode 已写新值（判别性），recover 必须回滚到事务前字节
    m._testHooks.afterModeWrite = () => { throw new Error('注入：mode 原子写后中断'); };
    const r = m.renew(root, { taskId: 'TASK-T-1', newExpiry: '2999-02-02' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.notDeepEqual(readFileSync(modePath), beforeMode, '崩溃后 mode 字节须已写新值（自证注入点）');
    assert.ok(ledgerLines() > beforeLines, 'ledger 已追加（待回滚）');
    m._testHooks.afterModeWrite = null;
    const rec = m.recover(root);
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.deepEqual(readFileSync(modePath), beforeMode, 'recover 须恢复事务前 mode 字节');
    assert.equal(ledgerLines(), beforeLines, 'recover 须回滚 ledger 长度');
    assert.equal(existsSync(join(root, '.scout', 'transactions', 'journal.json')), false);
  } finally {
    m._testHooks.afterModeWrite = null;
  }
});
