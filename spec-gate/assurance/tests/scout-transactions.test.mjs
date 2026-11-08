// 文件：scout-transactions.test.mjs
// 描述：scout_transactions.mjs 实现（唯一实现；迁移史见 内部决策-051）单测（内部决策-051 阶段1b）——register 幂等镜像 5＋graduate
//       单事务 4（含故障注入回滚）＋gate.scout_active 四态 4＝13 移植＋跨语言锁互操作 2；
//       2026-10-31 内部任务-259 步骤4 扩：register 终态 fencing/owner 缺省/abandon 幂等、graduate journal/taskId 守卫共 5 例（合计 24）；
//       scout-tx.mjs 直跑契约 4 例（register 0 带 JSON／graduate 空 evidence 1／参数错 2／task-id 受理域 1）
//       随本件承接（计划修订 4）。永久件。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { _testHooks, graduate, register } from '../scout_transactions.mjs';
import { _checkLedger } from '../gate.mjs';
import { open as lifecycleOpen } from '../../../scout/scripts/mode-lifecycle.mjs';

const SCOUT_TX = fileURLToPath(new URL('../scout-tx.mjs', import.meta.url));
import { acquireLock, releaseLock } from '../lock.mjs';

function runCli(args) {
  return spawnSync(process.execPath, [SCOUT_TX, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function tmpRoot(p) { return mkdtempSync(join(tmpdir(), p)); }
function cleanup(root) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }

function future(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeModeV3(root, expiry, taskId = 'TASK-1', tx = 'tx-1') {
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry, taskId, transactionId: tx }), 'utf8');
}

function readLedger(root) {
  return JSON.parse(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'));
}

// ── register 5 ──

test('register open：建 scout 条目（active/taskType/deadline/transactionId/owner/createdAt）', () => {
  const root = tmpRoot('dev86-st-reg-');
  try {
    const r = register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open', { owner: 'wangp' });
    assert.ok(r.ok);
    const entry = readLedger(root).tasks[0];
    assert.equal(entry.status, 'active');
    assert.equal(entry.taskType, 'scout-mode');
    assert.equal(entry.deadline, future(14));
    assert.equal(entry.transactionId, 'tx-1');
    assert.equal(entry.owner, 'wangp');
    assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}$/, 'date-only（date.today 本地日期）');
  } finally { cleanup(root); }
});

test('register renew：同 taskId 幂等覆盖，owner 保留（终审 F3）', () => {
  const root = tmpRoot('dev86-st-re-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open', { owner: 'wangp' });
    const r = register(root, 'TASK-1', 'explore', future(30), 'tx-2', 'renew');
    assert.ok(r.ok);
    const tasks = readLedger(root).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].deadline, future(30));
    assert.equal(tasks[0].transactionId, 'tx-2');
    assert.equal(tasks[0].owner, 'wangp');
  } finally { cleanup(root); }
});

test('register abandon：expired/blocked/disposition', () => {
  const root = tmpRoot('dev86-st-ab-');
  try {
    register(root, 'TASK-1', 'disposable', future(14), 'tx-1', 'open');
    const r = register(root, 'TASK-1', 'disposable', future(14), 'tx-2', 'abandon', { disposition: '归档，不并入主干' });
    assert.ok(r.ok);
    const entry = readLedger(root).tasks[0];
    assert.equal(entry.status, 'expired');
    assert.equal(entry.finalStatus, 'blocked');
    assert.equal(entry.disposition, '归档，不并入主干');
  } finally { cleanup(root); }
});

test('register 非法参数：模式/事件/abandon 缺处置声明', () => {
  const root = tmpRoot('dev86-st-bad-');
  try {
    assert.equal(register(root, 'TASK-1', 'bogus', future(14), 't', 'open').ok, false);
    assert.equal(register(root, 'TASK-1', 'explore', future(14), 't', 'graduate').ok, false);
    assert.equal(register(root, 'TASK-1', 'explore', future(14), 't', 'abandon').ok, false);
  } finally { cleanup(root); }
});

test('register 普通任务同 id 守卫：不覆盖非 scout 条目', () => {
  const root = tmpRoot('dev86-st-guard-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'ledger.json'), JSON.stringify({ tasks: [{ id: 'TASK-1', status: 'active', title: '普通任务' }] }), 'utf8');
    const r = register(root, 'TASK-1', 'explore', future(14), 't', 'open');
    assert.equal(r.ok, false);
    assert.equal(readLedger(root).tasks[0].title, '普通任务');
  } finally { cleanup(root); }
});

// ── graduate 4 ──

test('graduate 证据前置：空引用拒绝且模式保持', () => {
  const root = tmpRoot('dev86-st-ge-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    const r = graduate(root, 'TASK-1', []);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('证据'));
  } finally { cleanup(root); }
});

test('graduate 非活跃条目拒绝（空仓）', () => {
  const root = tmpRoot('dev86-st-ge2-');
  try {
    const r = graduate(root, 'TASK-1', ['.sdd/reports/x.md']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('非活跃'));
  } finally { cleanup(root); }
});

test('graduate 收敛中央＋关闭本地＋本地留痕（RULE-LEDGER-003）', () => {
  const root = tmpRoot('dev86-st-ge3-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    const r = graduate(root, 'TASK-1', ['.sdd/evidence/grad-1.md', '.sdd/reports/grad.md'],
      { tx: 'tx-fixed', at: '2026-10-18T00:00:00+08:00' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.transactionId, 'tx-fixed');
    const entry = readLedger(root).tasks[0];
    assert.equal(entry.status, 'converged');
    assert.equal(entry.finalStatus, 'complete');
    assert.equal(entry.gateReportRef, '.sdd/evidence/grad-1.md');
    assert.equal((() => { try { readFileSync(join(root, '.scout', 'mode.json')); return true; } catch { return false; } })(), false, '本地声明随毕业关闭');
    const events = readFileSync(join(root, '.scout', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const grad = events.find((e) => e.event === 'graduate');
    assert.ok(grad, '本地留痕含 graduate 事件');
    assert.equal(grad.transactionId, 'tx-fixed');
    assert.equal(grad.at, '2026-10-18T00:00:00+08:00');
  } finally { cleanup(root); }
});

test('graduate 本地留痕失败→回滚（中央 active、模式保持、journal 清除）', () => {
  const root = tmpRoot('dev86-st-ge4-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    _testHooks.afterLedgerWrite = () => {
      const e = new Error('注入故障：本地留痕 append');
      e.code = 'EIO';
      throw e;
    };
    const r = graduate(root, 'TASK-1', ['.sdd/evidence/g.md']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('已回滚'));
    assert.equal(readLedger(root).tasks[0].status, 'active', '中央条目回滚为 active');
    assert.ok(readFileSync(join(root, '.scout', 'mode.json'), 'utf8').includes('explore'), '本地声明保持开启');
    assert.equal((() => { try { readFileSync(join(root, '.scout', 'transactions', 'journal.json')); return true; } catch { return false; } })(), false, 'journal 清除');
  } finally {
    _testHooks.afterLedgerWrite = null;
    cleanup(root);
  }
});

test('graduate 本地 mode 删除失败→回滚并报错（D08/DEV-241）', () => {
  const root = tmpRoot('dev241-st-modefail-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    _testHooks.beforeModeUnlink = () => {
      const e = new Error('注入故障：mode 删除');
      e.code = 'EPERM';
      throw e;
    };
    const r = graduate(root, 'TASK-1', ['.sdd/evidence/x.md']);
    assert.equal(r.ok, false, '删除失败必须 fail-loud，不得 ok:true');
    assert.ok(r.error.includes('已回滚'));
    assert.equal(readLedger(root).tasks[0].status, 'active', '中央条目回滚为 active');
    assert.ok(readFileSync(join(root, '.scout', 'mode.json'), 'utf8').includes('explore'), '本地 mode 保持开启');
    assert.equal((() => { try { readFileSync(join(root, '.scout', 'transactions', 'journal.json')); return true; } catch { return false; } })(), false, 'journal 清除');
  } finally {
    _testHooks.beforeModeUnlink = null;
    cleanup(root);
  }
});

test('DEV-242 §四-3：mode 已缺失时 graduate 幂等成功（ENOENT 不误报失败）', () => {
  const root = tmpRoot('dev242-st-modegone-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    rmSync(join(root, '.scout', 'mode.json'), { force: true }); // 幂等/清理路径：mode 已不存在
    const r = graduate(root, 'TASK-1', ['.sdd/evidence/x.md']);
    assert.equal(r.ok, true, 'ENOENT＝删除目标已达成，须幂等成功');
    assert.equal(readLedger(root).tasks[0].status, 'converged', '中央条目收敛');
    assert.equal((() => { try { readFileSync(join(root, '.scout', 'transactions', 'journal.json')); return true; } catch { return false; } })(), false, 'journal 清除');
  } finally {
    cleanup(root);
  }
});

test('D03（DEV-241）：损坏台账 register 响亮报错且原字节不变（不重置）', () => {
  const root = tmpRoot('dev241-st-corrupt-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    const ledgerPath = join(root, '.sdd', 'ledger.json');
    writeFileSync(ledgerPath, '{broken', 'utf8');
    assert.throws(() => register(root, 'TASK-1', 'explore', future(14), 't', 'open'), /台账不是合法 JSON/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), '{broken', '损坏台账不得被重置为 {tasks:[]}');
  } finally { cleanup(root); }
});

test('D03（DEV-241）：台账锁被占用 → register 明确报占用且零写入', () => {
  const root = tmpRoot('dev241-st-lock-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    const lockPath = join(root, '.sdd', 'ledger.lock');
    assert.equal(acquireLock(lockPath, { owner: 'holder' }).ok, true);
    try {
      const r = register(root, 'TASK-1', 'explore', future(14), 't', 'open');
      assert.equal(r.ok, false);
      assert.match(r.error, /并发占用/);
      assert.equal((() => { try { readFileSync(join(root, '.sdd', 'ledger.json')); return true; } catch { return false; } })(), false, '锁占用时零写入');
    } finally { releaseLock(lockPath, 'holder'); }
  } finally { cleanup(root); }
});

// ── 跨语言锁互操作 2（与 mode-lifecycle.mjs 真模块争用同一锁文件）──

test('锁互操作①：新鲜锁预占→JS 实现 graduate 与 mode-lifecycle.open 均拒（单胜）', () => {
  const root = tmpRoot('dev86-st-lock1-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    const lock = join(root, '.scout', 'transactions', 'lock');
    mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
    writeFileSync(lock, 'other-holder', 'utf8');
    const g = graduate(root, 'TASK-1', ['.sdd/evidence/x.md']);
    assert.equal(g.ok, false);
    assert.ok(g.error.includes('进行中'), 'JS 实现侧取锁失败');
    const o = lifecycleOpen(root, { mode: 'explore', expiry: future(14), taskId: 'DEV-1' });
    assert.equal(o.ok, false);
    assert.ok(o.error.includes('进行中'), 'mode-lifecycle 同锁单胜');
    assert.equal(readFileSync(lock, 'utf8'), 'other-holder', '锁未被误删/改写');
    assert.equal(readLedger(root).tasks[0].status, 'active', '未进入事务');
  } finally { cleanup(root); }
});

test('锁互操作②：陈旧锁回收（retired-<8hex> 命名）＋原锁路径可再获取', () => {
  const root = tmpRoot('dev86-st-lock2-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    const lock = join(root, '.scout', 'transactions', 'lock');
    mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
    writeFileSync(lock, 'stale-holder', 'utf8');
    const old = new Date(Date.now() - 400 * 1000);
    utimesSync(lock, old, old);
    let retiredName = null;
    _testHooks.onLockRetired = (p) => { retiredName = basename(p); };
    const r = graduate(root, 'TASK-1', ['.sdd/evidence/x.md'], { tx: 'tx-reclaimed' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(retiredName ?? '', /^lock\.retired-[0-9a-f]{8}$/, '回收命名形态');
    assert.equal((() => { try { readFileSync(lock); return true; } catch { return false; } })(), false, '事务后锁释放');
    // 原锁路径可再获取（协议可观测面）：wx 新建成功
    const fd = openSync(lock, 'wx');
    closeSync(fd);
    assert.equal(readLedger(root).tasks[0].status, 'converged', '陈旧锁回收后事务完成');
  } finally {
    _testHooks.onLockRetired = null;
    cleanup(root);
  }
});

// ── scout-tx.mjs 直跑契约 3（计划修订 4；CliDispatch 移植）──

test('scout-tx 直跑：scout-register 退 0 带 JSON', () => {
  const root = tmpRoot('dev86-tx-reg-');
  try {
    const r = runCli(['--project-root', root, 'scout-register', '--task-id', 'TASK-1', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 'tx-1', '--event', 'open']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
    assert.equal(readLedger(root).tasks[0].status, 'active');
  } finally { cleanup(root); }
});

test('scout-tx 直跑：scout-graduate 空 evidence 退 1（与 register 对称两态）', () => {
  const root = tmpRoot('dev86-tx-grad-');
  try {
    const reg = runCli(['--project-root', root, 'scout-register', '--task-id', 'TASK-1', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 'tx-1', '--event', 'open']);
    assert.equal(reg.status, 0, reg.stderr);
    const r = runCli(['--project-root', root, 'scout-graduate', '--task-id', 'TASK-1', '--evidence-refs', '[]']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, false);
  } finally { cleanup(root); }
});

test('scout-tx 直跑：参数错退 2（缺旗标/非法枚举/task-id 形态）', () => {
  const root = tmpRoot('dev86-tx-args-');
  try {
    assert.equal(runCli(['--project-root', root, 'scout-register', '--task-id', 'TASK-1']).status, 2, '缺旗标');
    assert.equal(runCli(['--project-root', root, 'scout-register', '--task-id', 'TASK-1', '--mode', 'bogus',
      '--expiry', future(14), '--transaction-id', 't', '--event', 'open']).status, 2, '非法 mode（argparse choices 语义）');
    assert.equal(runCli(['--project-root', root, 'scout-register', '--task-id', 'bad id', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 't', '--event', 'open']).status, 2, 'task-id 形态');
    assert.equal(runCli(['--project-root', root, 'scout-bogus']).status, 2, '未知子命令');
    assert.equal(runCli(['--project-root', root, 'scout-register', '--task-id', 'TASK-1', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 't', '--event', 'open', '--bogus', 'x']).status, 2, '未知旗标');
  } finally { cleanup(root); }
});

test('scout-tx 直跑：task-id 受理域对齐 receipts.TASK_ID_RE（TASK_1 受理）＋对象证据退 1 零写盘', () => {
  const root = tmpRoot('dev86-tx-domain-');
  try {
    // receipts.TASK_ID_RE 受理 `TASK_1`（旧窄式会误拒）；`--flag=value` 形态同时覆盖
    const reg = runCli(['--project-root', root, 'scout-register', '--task-id=TASK_1', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 't', '--event', 'open']);
    assert.equal(reg.status, 0, reg.stderr);
    const before = readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8');
    const g = runCli(['--project-root', root, 'scout-graduate', '--task-id', 'TASK_1', '--evidence-refs', '{}']);
    assert.equal(g.status, 1, '对象证据按前置缺失退 1（原 Python 实现（迁移史见 ADR-051）零状态变更）');
    assert.equal(JSON.parse(g.stdout).ok, false);
    assert.equal(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'), before, '台账零变更');
  } finally { cleanup(root); }
});

// ── 内部决策-065 T9/T11（内部任务-259 步骤 4）──

test('register：converged 条目收到 open/abandon 事件 → 拒绝复活/改写', () => {
  const root = tmpRoot('dev259-st-fence-');
  try {
    assert.ok(register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open').ok);
    const ledger = readLedger(root);
    ledger.tasks[0].status = 'converged';
    writeFileSync(join(root, '.sdd', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
    const rOpen = register(root, 'TASK-1', 'explore', future(20), 'tx-2', 'open');
    assert.equal(rOpen.ok, false, JSON.stringify(rOpen));
    assert.match(String(rOpen.error), /收敛|converged/);
    const rAbandon = register(root, 'TASK-1', 'explore', future(14), 'tx-3', 'abandon', { disposition: '归档' });
    assert.equal(rAbandon.ok, false, JSON.stringify(rAbandon));
    assert.equal(readLedger(root).tasks[0].status, 'converged', 'converged 不得被改写');
  } finally { cleanup(root); }
});

test('register abandon：active→expired 写审计字段；expired→expired 幂等成功且不改审计字段', () => {
  const root = tmpRoot('dev259-st-ab-idem-');
  try {
    assert.ok(register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open').ok);
    const first = register(root, 'TASK-1', 'explore', future(14), 'tx-2', 'abandon', { disposition: '归档' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.idempotent, false);
    let entry = readLedger(root).tasks[0];
    assert.equal(entry.status, 'expired');
    assert.equal(entry.finalStatus, 'blocked');
    assert.equal(entry.disposition, '归档');
    const second = register(root, 'TASK-1', 'explore', future(14), 'tx-3', 'abandon', { disposition: '第二次' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.idempotent, true);
    entry = readLedger(root).tasks[0];
    assert.equal(entry.disposition, '归档', 'expired→expired 幂等成功不得改审计字段');
    assert.equal(entry.finalStatus, 'blocked');
    assert.equal(entry.transactionId, 'tx-2', '审计字段保留首次值');
  } finally { cleanup(root); }
});

test('register：新建条目 owner 缺省 unknown 且 gate._checkLedger 零 blocking', () => {
  const root = tmpRoot('dev259-st-owner-');
  try {
    assert.ok(register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open').ok);
    assert.equal(readLedger(root).tasks[0].owner, 'unknown');
    const section = _checkLedger(root);
    assert.equal(section.blockingCount, 0, JSON.stringify(section.diagnostics));
  } finally { cleanup(root); }
});

test('graduate：journal 残留时拒绝（不删本地/中央保持 active）', () => {
  const root = tmpRoot('dev259-st-grad-journal-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14));
    mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
    writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: 't', op: 'open', state: 'prepared' }));
    const r = graduate(root, 'TASK-1', ['.sdd/reports/x.md']);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /journal/);
    assert.match(String(r.error), /taskId=TASK-1/, 'IF-COLLAB-10 §4：错误文案须指出 taskId 上下文');
    assert.match(String(r.error), /本地\/中央均未变更/, 'IF-COLLAB-10 §4：须说明本地/中央未变更');
    assert.equal(existsSync(join(root, '.scout', 'mode.json')), true, '本地声明不得删除');
    assert.equal(readLedger(root).tasks[0].status, 'active', '中央保持 active');
  } finally { cleanup(root); }
});

test('graduate：本地 mode.taskId 错配 → 拒绝且不删本地、中央保持 active', () => {
  const root = tmpRoot('dev259-st-grad-mismatch-');
  try {
    register(root, 'TASK-1', 'explore', future(14), 'tx-1', 'open');
    writeModeV3(root, future(14), 'TASK-OTHER');
    const r = graduate(root, 'TASK-1', ['.sdd/reports/x.md']);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /不一致/);
    assert.equal(existsSync(join(root, '.scout', 'mode.json')), true, '错配时不得删除本地声明');
    assert.equal(readLedger(root).tasks[0].status, 'active');
  } finally { cleanup(root); }
});
