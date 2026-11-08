// 文件：scout_transactions.mjs
// 描述：scout_transactions.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1b）——Scout 增强桥
//       提供方（内部接口-12 v2）：register（中央台账幂等镜像登记）与 graduate（毕业
//       单事务闭合）。共享 .scout/transactions/lock 协议（rename 占先回收陈旧锁）与
//       Node 侧 scout/scripts/mode-lifecycle.mjs 同一实现形态——两侧文件头互相指针防漂移。
//       journal 键名契约：before.ledgerLength（Node rollback 只认该键——A2 复审 C3）。
//       注入缝：graduate opts {tx?, at?}（对拍固定——缺省真实；register 无注入缝）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { atomicWriteText, localToday, nowIso } from './common.mjs';
import { acquireLock, releaseLock } from './lock.mjs';

const JOURNAL_DIR = '.scout/transactions';
const MODES = ['explore', 'disposable'];
const uuid8 = () => randomUUID().replaceAll('-', '').slice(0, 8);
const modePath = (root) => join(root, '.scout', 'mode.json');
const journalPath = (root) => join(root, JOURNAL_DIR, 'journal.json');
const ledgerJsonlPath = (root) => join(root, '.scout', 'ledger.jsonl');
const lockPathOf = (root) => join(root, JOURNAL_DIR, 'lock');

/** 测试缝（mode-lifecycle.mjs `_testHooks` 先例）——故障注入不改变生产路径（缺省 null）。 */
export const _testHooks = { afterLedgerWrite: null, onLockRetired: null, beforeModeUnlink: null };

function readJsonOrNull(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    // D03（内部任务-241）：缺失与读失败必须区分——「不存在」返回 null，「不可读」上抛。
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return null;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // D03：解析失败不是「没有台账」——响亮报错，禁止把损坏台账重置为 {tasks:[]} 后落盘。
    throw new Error(`台账不是合法 JSON：${path}（${e.message}）——修复后重试，禁止重置`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`台账根不是对象：${path}——修复后重试，禁止重置`);
  }
  return data;
}

/** 中央台账写锁路径（register/graduate/finalize upsert 共用；D03/内部任务-241）。 */
const ledgerLockPathOf = (root) => join(root, '.sdd', 'ledger.lock');

function ledgerEntry(ledger, taskId) {
  if (!ledger) return null;
  for (const task of ledger.tasks ?? []) {
    if (task !== null && typeof task === 'object' && task.id === taskId) return task;
  }
  return null;
}

/**
 * 幂等中央镜像登记：无 scout 条目则建、有则覆盖式更新（本地为准方向，IF §4）。
 * owner 未显式提供时不覆写既有条目现值（终审 F3）。
 * @param {string} root @param {string} taskId @param {string} mode @param {string} expiry
 * @param {string} txId @param {string} event @param {{disposition?: string|null, owner?: string|null}} [opts]
 * @returns {{ok: boolean, taskId?: string, event?: string, error?: string}}
 */
export function register(root, taskId, mode, expiry, txId, event, opts = {}) {
  if (!MODES.includes(mode)) return { ok: false, error: `非法模式：${mode}` };
  if (!['open', 'renew', 'abandon'].includes(event)) return { ok: false, error: `非法事件类别：${event}` };
  const disposition = opts.disposition ?? null;
  if (event === 'abandon' && !String(disposition || '').trim()) {
    return { ok: false, error: 'abandon 事件必须携带处置声明（B-M9-3）' };
  }
  // D03（内部任务-241）：台账读-改-写全程持 内部治理状态（与 finalize upsert 同一把锁），
  // 交错时 fail-loud 而非静默丢更新。
  const lock = acquireLock(ledgerLockPathOf(root), { owner: `register-${taskId}-${uuid8()}` });
  if (!lock.ok) return { ok: false, error: '台账被并发占用（中央台账写）——稍后重试' };
  try {
    const ledgerPath = join(root, '.sdd', 'ledger.json');
    let ledger = readJsonOrNull(ledgerPath);
    if (ledger === null) ledger = { tasks: [] };
  // Python setdefault：仅缺键时补空表（已存在但非数组的坏台账保持原样，不静默重置）
  if (!Object.hasOwn(ledger, 'tasks')) ledger.tasks = [];
  let entry = ledgerEntry(ledger, taskId);
  if (entry === null) {
    entry = {
      id: taskId,
      title: `【scout 探路模式】${mode} 模式开启`,
      createdAt: localToday(),
      fastTrack: true,
      taskType: 'scout-mode',
      owner: opts.owner ?? 'unknown',
    };
    ledger.tasks.push(entry);
  } else if (entry.taskType !== 'scout-mode') {
    return { ok: false, error: `任务 ${taskId} 是非 scout-mode 条目，拒绝覆盖` };
  }
  const prevStatus = entry.status ?? null;
  if (event === 'abandon') {
    // 内部决策-065 T9 三态：converged 拒绝；expired→expired 幂等成功且不改审计字段；active→expired 写审计字段。
    if (prevStatus === 'converged') {
      return { ok: false, error: `任务 ${taskId} 已收敛（converged），拒绝写入 expired` };
    }
    if (prevStatus === 'expired') {
      return { ok: true, taskId, event, idempotent: true };
    }
    entry.status = 'expired';
    entry.finalStatus = 'blocked';
    entry.disposition = disposition;
    entry.deadline = expiry;
    entry.mode = mode;
    entry.transactionId = txId;
    if (opts.owner) entry.owner = opts.owner;
    else if (!entry.owner) entry.owner = 'unknown';
  } else {
    // open/renew：converged 拒绝复活（新 taskId 才可继续）；active/expired→active。
    if (prevStatus === 'converged') {
      return { ok: false, error: `任务 ${taskId} 已收敛（converged），拒绝复活；如需继续须使用新 taskId` };
    }
    entry.status = 'active';
    for (const stale of ['finalStatus', 'disposition', 'evidenceRefs', 'gateReportRef']) {
      delete entry[stale];
    }
    entry.deadline = expiry;
    entry.mode = mode;
    entry.transactionId = txId;
    if (opts.owner) entry.owner = opts.owner;
    else if (!entry.owner) entry.owner = 'unknown';
  }
  atomicWriteText(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true, taskId, event, idempotent: false };
  } finally {
    releaseLock(ledgerLockPathOf(root), lock.owner);
  }
}

/** Python `json.dumps(event)` 默认分隔符形态（逗号后空格＋冒号后空格）——本文件的 ledger
 *  事件是扁平字符串记录；与生产 store 的 compact jsonl 不同源（两处各对齐原 Python 实现（迁移史见 内部决策-051）各自形态）。 */
function pyJsonLine(obj) {
  return `{${Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
}

function appendLocalEvent(root, event) {
  const path = ledgerJsonlPath(root);
  mkdirSync(join(path, '..'), { recursive: true });
  const fd = openSync(path, 'a');
  writeSync(fd, `${pyJsonLine(event)}\n`);
  fsyncSync(fd);
  closeSync(fd);
}

// 独占锁实现已收敛到 `./lock.mjs`（内部任务-241 步骤 9；`_testHooks.onLockRetired` 经 onRetired 回调保留）。

function journalWrite(root, record) {
  atomicWriteText(journalPath(root), `${JSON.stringify(record, null, 2)}\n`);
}

function journalClear(root) {
  try { unlinkSync(journalPath(root)); } catch { /* 缺失即免 */ }
}

/**
 * 事务前快照（回滚依据）。jsonl 长度键名必须是 ledgerLength——Node 侧 rollback 只认
 * 该键（键名漂移会把审计留痕截成空文件——A2 复审 C3）。
 */
function snapshot(root) {
  const modeFile = modePath(root);
  const ledgerFile = join(root, '.sdd', 'ledger.json');
  const jsonlFile = ledgerJsonlPath(root);
  const modeExists = existsSync(modeFile);
  let ledgerLength = 0;
  try { ledgerLength = statSync(jsonlFile).size; } catch { ledgerLength = 0; }
  return {
    modeExists,
    modeText: modeExists ? readFileSync(modeFile, 'utf8') : null,
    ledgerText: existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : null,
    ledgerLength,
  };
}

function rollback(root, snap) {
  const modeFile = modePath(root);
  if (snap.modeExists) atomicWriteText(modeFile, String(snap.modeText));
  else { try { unlinkSync(modeFile); } catch { /* 尽力 */ } }
  if (snap.ledgerText !== null && snap.ledgerText !== undefined) {
    atomicWriteText(join(root, '.sdd', 'ledger.json'), String(snap.ledgerText));
  }
  const jsonl = ledgerJsonlPath(root);
  if (existsSync(jsonl)) {
    const fd = openSync(jsonl, 'r+');
    ftruncateSync(fd, Number(snap.ledgerLength ?? 0));
    fsyncSync(fd);
    closeSync(fd);
  }
}

const freshTx = (opts) => opts?.tx ?? randomUUID().replaceAll('-', '');

/**
 * 毕业单事务闭合（内部决策-031 决策 5 / 内部接口-12 v2 §2）：中央收敛＋删本地 mode.json＋
 * append 本地留痕 graduate 事件于同一事务完成；前置证据缺失即拒绝，模式保持开启。
 * @param {string} root @param {string} taskId @param {string[]} evidenceRefs
 * @param {{tx?: string, at?: string}} [opts] 注入缝
 * @returns {{ok: boolean, transactionId?: string, error?: string}}
 */
export function graduate(root, taskId, evidenceRefs, opts = {}) {
  // 原 Python 实现（迁移史见 内部决策-051） `if not evidence_refs`：空数组/空对象/空串/None 均拒；非空非数组在原 Python 实现（迁移史见 内部决策-051）于
  // `evidence_refs[0]` 处失败（零状态变更）——实现（唯一实现；迁移史见 内部决策-051）显式拒绝为非数组（终审阻塞 2）。
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    return { ok: false, error: '毕业前置缺失：需 backfill/OPEN-n 证据引用（IF-COLLAB-10）' };
  }
  const txLockPath = lockPathOf(root);
  const txLock = acquireLock(txLockPath, {
    owner: `graduate-${taskId}-${uuid8()}`,
    onRetired: (info) => { if (_testHooks.onLockRetired) _testHooks.onLockRetired(info.path); },
  });
  if (!txLock.ok) {
    return { ok: false, error: '另一 Scout 事务进行中' };
  }
  let snap = {};
  let ledgerLock = null;
  try {
    // 内部决策-065 T3/T9（内部任务-259）：journal 残留拒绝（先 recover）；本地存在时 taskId 必须一致（防删错模式）；
    // 本地已缺失时保留 内部任务-242 的 ENOENT 幂等语义（删除目标已达成，交后续路径收敛中央）。
    if (existsSync(journalPath(root))) {
      return { ok: false, error: `journal 残留（taskId=${taskId}）：请先运行 scout 侧 recover 后重试；本地/中央均未变更（IF-COLLAB-10 §4）` };
    }
    const localModePath = modePath(root);
    if (existsSync(localModePath)) {
      let localMode = null;
      try {
        localMode = JSON.parse(readFileSync(localModePath, 'utf8'));
      } catch {
        localMode = null;
      }
      if (!localMode || typeof localMode !== 'object') {
        return { ok: false, error: '本地 mode 声明不可解析：拒绝毕业（不删本地）' };
      }
      if (localMode.taskId !== taskId) {
        return { ok: false, error: `本地 mode.taskId(${String(localMode.taskId)}) 与请求(${taskId}) 不一致：拒绝毕业（不删本地）` };
      }
    }
    // D03（内部任务-241）：中央台账读-改-写与 finalize upsert 共用 内部治理状态。
    ledgerLock = acquireLock(ledgerLockPathOf(root), { owner: `graduate-${taskId}-${uuid8()}` });
    if (!ledgerLock.ok) return { ok: false, error: '台账被并发占用（中央台账写）——稍后重试' };
    snap = snapshot(root);
    const ledger = readJsonOrNull(join(root, '.sdd', 'ledger.json'));
    const entry = ledgerEntry(ledger, taskId);
    if (ledger === null || entry === null || entry.status !== 'active' || entry.taskType !== 'scout-mode') {
      return { ok: false, error: `任务 ${taskId} 非活跃 Scout 条目` };
    }
    const tx = freshTx(opts);
    entry.status = 'converged';
    entry.finalStatus = 'complete';
    entry.evidenceRefs = evidenceRefs;
    entry.gateReportRef = evidenceRefs[0]; // RULE-LEDGER-003 契约字段（S1 批次）
    journalWrite(root, { schemaVersion: 1, transactionId: tx, op: 'graduate', state: 'prepared', before: snap, after: { taskId } });
    atomicWriteText(join(root, '.sdd', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
    if (_testHooks.afterLedgerWrite) _testHooks.afterLedgerWrite();
    appendLocalEvent(root, { event: 'graduate', taskId, transactionId: tx, at: opts.at ?? nowIso() });
    try {
      // 完成复审（内部任务-241）：注入缝移入 try，使「删除失败→回滚」内层分支可被测试注入覆盖。
      if (_testHooks.beforeModeUnlink) _testHooks.beforeModeUnlink();
      unlinkSync(modePath(root));
    } catch (e) {
      // D08（内部任务-241）：本地 mode 删除失败＝事务未闭合——回滚中央台账并报错，
      // 不得 ok:true 留 mode 残留（scoutActive 恒真、生产 claim 被永久拦）。
      // 完成复审：ENOENT（mode 已不存在）＝删除目标已达成，幂等成功，不回滚。
      if (e !== null && typeof e === 'object' && e.code === 'ENOENT') {
        journalClear(root);
        return { ok: true, transactionId: tx };
      }
      if (e !== null && typeof e === 'object' && typeof e.code === 'string') {
        rollback(root, snap);
        journalClear(root);
        return { ok: false, error: `事务失败已回滚：本地 mode 删除失败（${e.message}）` };
      }
      throw e;
    }
    journalClear(root);
    return { ok: true, transactionId: tx };
  } catch (e) {
    // 原 Python 实现（迁移史见 内部决策-051） `except OSError`：仅 fs 错误（Node fs 错误带 .code）回滚；其余错误如实上抛。
    if (e !== null && typeof e === 'object' && typeof e.code === 'string') {
      if (snap && Object.keys(snap).length > 0) rollback(root, snap);
      journalClear(root);
      return { ok: false, error: `事务失败已回滚：${e.message}` };
    }
    throw e;
  } finally {
    if (ledgerLock !== null) releaseLock(ledgerLockPathOf(root), ledgerLock.owner);
    releaseLock(txLockPath, txLock.owner);
  }
}
