// 文件：scout/scripts/tests/coverage-branches.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201，scout lines 81.94→90 / branches 73.66→75）——
//       直接调用 mode-lifecycle 导出函数与 mode-state 读侧函数，覆盖参数校验/损坏资产/过期/
//         迁移/桥缺失等失败分支。子进程测试对父进程覆盖率零贡献（内部决策-064 决策 4），故选 in-process。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 scout/LICENSE）
// 自检：node --test "scout/scripts/tests/coverage-branches.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'dev209-scout-'));
}
function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
function writeMode(root, body) {
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');
const REPO = resolve(SCRIPTS, '..', '..');

test('mode-state 读侧分支：损坏 JSON/v1 legacy/非法 expiry/v2 迁移/过期/pending-recovery/坏 ledger', async () => {
  const { providerCandidates, providerCli, bridgeAvailable, readLedger, readStatus } = await import('../mode-state.mjs');
  const root = makeRoot();
  try {
    assert.equal(readStatus(root).reason, 'absent');
    writeMode(root, '{bad');
    assert.equal(readStatus(root).reason, 'corrupt');
    writeMode(root, { mode: 'explore', expiry: '2999-01-01' });
    assert.equal(readStatus(root).reason, 'legacy');
    writeMode(root, { schemaVersion: 3, mode: 'nope', expiry: '2999-01-01', taskId: '内部任务-1', transactionId: 't' });
    assert.equal(readStatus(root).reason, 'corrupt');
    writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: 'bad', taskId: '内部任务-1', transactionId: 't' });
    assert.equal(readStatus(root).reason, 'corrupt');
    writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: '2000-01-01', taskId: '内部任务-1', transactionId: 't' });
    const expired = readStatus(root);
    assert.equal(expired.reason, 'expired');
    assert.equal(expired.overdue, true);
    writeMode(root, { schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: '内部任务-1', transactionId: 't' });
    assert.equal(readStatus(root).reason, 'migratable-v2');
    // 事务待恢复：存在 .scout/transaction.json（pendingRecovery）
    writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: '2999-01-01', taskId: '内部任务-1', transactionId: 't' });
    mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
    writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: 'tx1', op: 'open' }), 'utf8');
    assert.equal(readStatus(root).reason, 'pending-recovery');
    // 坏 ledger 行：readLedger 容忍坏行、不抛且只返回可解析条目（真断言：坏行被丢弃）
    mkdirSync(join(root, '.scout'), { recursive: true });
    writeFileSync(join(root, '.scout', 'ledger.jsonl'), `{bad\n${JSON.stringify({ event: 'open', taskId: '内部任务-1' })}\n`, 'utf8');
    const { events: ledger, dropped } = readLedger(root);
    assert.ok(Array.isArray(ledger), 'readLedger 须返回 events 数组');
    assert.equal(dropped, 1, `坏行须计入 dropped（实际 ${dropped}）`);
    assert.equal(ledger.length, 1, `坏行须被丢弃，仅保留 1 条可解析行（实际 ${ledger.length}）`);
    assert.equal(ledger[0].taskId, '内部任务-1', '可解析行内容须保真');
    // 提供方候选：env 注入可见 + bridgeAvailable 布尔
    const prev = process.env.SCOUT_TX_PROVIDER;
    process.env.SCOUT_TX_PROVIDER = join(REPO, 'spec-gate/assurance/scout-tx.mjs');
    try {
      const candidates = providerCandidates();
      assert.ok(Array.isArray(candidates) && candidates.some((c) => c.source === 'env'));
      assert.equal(bridgeAvailable(), true, 'env 命中且桥存在 → bridgeAvailable=true');
      assert.equal(providerCli(), join(REPO, 'spec-gate/assurance/scout-tx.mjs'), 'providerCli 须解析到 env 指定入口');
    } finally {
      if (prev === undefined) delete process.env.SCOUT_TX_PROVIDER; else process.env.SCOUT_TX_PROVIDER = prev;
    }
  } finally { cleanup(root); }
});

test('mode-lifecycle 导出函数负例矩阵：open/renew/abandon/recover/migrateV2/sync 的拒绝面', async () => {
  const lifecycle = await import('../mode-lifecycle.mjs');
  const root = makeRoot();
  try {
    assert.equal(lifecycle.open(root, { mode: 'nope', expiry: '2999-01-01', taskId: '内部任务-1' }).ok, false);
    assert.equal(lifecycle.open(root, { mode: 'explore', expiry: 'bad', taskId: '内部任务-1' }).ok, false);
    assert.equal(lifecycle.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'bad id' }).ok, false);
    assert.equal(lifecycle.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: '内部任务-1', owner: 'x' }).ok, true);
    // 重复 open：已有有效模式 → 拒绝
    assert.equal(lifecycle.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: '内部任务-1' }).ok, false);
    assert.equal(lifecycle.renew(root, { taskId: 'OTHER-1', newExpiry: '2999-02-02' }).ok, false);
    assert.equal(lifecycle.renew(root, { taskId: '内部任务-1', newExpiry: 'bad' }).ok, false);
    assert.equal(lifecycle.renew(root, { taskId: '内部任务-1', newExpiry: '2999-02-02' }).ok, true);
    assert.equal(lifecycle.abandon(root, { taskId: 'OTHER-1', disposition: 'x' }).ok, false);
    assert.equal(lifecycle.abandon(root, { taskId: '内部任务-1', disposition: '' }).ok, false);
    assert.equal(lifecycle.abandon(root, { taskId: '内部任务-1', disposition: '结束' }).ok, true);
    // recover/migrate/sync 空态幂等
    assert.equal(lifecycle.recover(root).ok, true);
    assert.equal(lifecycle.migrateV2(root).ok, false);
    assert.equal(lifecycle.sync(root).ok, true, '空态 sync 为成功（无待重放且无声明）');
    // 损坏 mode.json：status 判无效；open 以覆盖方式恢复（行为结果断言，T8 修复路径）
    writeMode(root, '{bad');
    assert.equal(lifecycle.status(root).valid, false);
    const recoveredOpen = lifecycle.open(root, { mode: 'explore', expiry: '2999-01-01', taskId: '内部任务-1' });
    assert.equal(recoveredOpen.ok, true, 'open 须可覆盖损坏声明（行为结果断言）');
    assert.equal(lifecycle.status(root).valid, true, 'open 后声明恢复有效');
    assert.equal(lifecycle.status(root).taskId, '内部任务-1');
  } finally { cleanup(root); }
});
