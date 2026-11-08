// 文件：mode-lifecycle.mjs
// 描述：scout 生命周期自治实现（内部决策-031 / 内部接口-9 v3 / 内部接口-12 v2 本地侧）——
//       open/renew/abandon/status/recover/migrate-v2/sync 七操作经「独占锁 + prepared
//       journal + 单文件原子写 + append-only 留痕」完成，`.scout/mode.json` v3 是唯一
//       权威声明（本地有效性=v3 合法 ∧ 未过期 ∧ 无待恢复残留）。事务语义 1:1 镜像
//       spec-gate/assurance/scout_transactions.py（历史，内部决策-051）与 scout_transactions.mjs（唯一实现）
//       （锁/journal 互操作对端；内部决策-051 阶段1b）。rename 占先回收陈旧锁为评审 C4
//       教训原语；原子写=同目录临时文件+fsync+rename，对齐 common.py 严格版）。
//       桥调用（register 中央镜像登记）意图在事务锁内预落 pendingSync，成功即压缩
//       清除、失败留存由 sync 补登；绝不反转本地有效性（内部接口-12 §4）；sync 重
//       放补登后压缩清除已解决事件（即时压缩与 sync 压缩是仅有的非追加操作，压缩后仍保留 synced 记录；内部决策-065 T6）。v2 journal 残留（before 含
//       ledgerText 字段、无 ledgerLength）可被 recover 直接消费（按 0 截断保守回滚）。
//       2026-09-28 规格先行：本文件为 内部接口-9 §6 登记契约工件（实现落地后哈希
//       重登于该 IF 激活登记节）。spec-gate 侧共享 .scout/transactions/lock 协议
//       （graduate 单事务闭合用），两侧文件头互相指针注释防漂移。
// 作者：wangp  创建：2026-09-28  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；写操作异常不吞不滚——残留 prepared journal
//       即崩溃现场，由 recover 按 fail-safe 方向确定性回滚（宁可全量纪律，不静默半开）。
// 用法：node scout/scripts/mode-lifecycle.mjs --project-root <dir> <open|renew|abandon|
//       status|recover|migrate-v2|sync> [参数]（--project-root 任意位置，T13）
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, fsyncSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { emitJson, isMainModule, parseFlags, parseProjectRootArg } from './cli-main.mjs';
import { MODES, MODE_SCHEMA_VERSION, isNonEmptyString, isValidExpiry, providerCli, readLedger, readStatus, todayIso } from './mode-state.mjs';

const LOCK_STALE_SECONDS = 300;
/** sync 单次总预算（内部决策-065 T7）：超过即保留 pendingSync 返回失败，避免长持锁。 */
const SYNC_BUDGET_MS = 240_000;
/** T8 sync 跳过声明时的分态提示（absent 无提示；按 readStatus.reason 精确指引）。 */
const INVALID_DECLARATION_HINT = '声明无效/损坏：先运行 recover 或重开'; // ⑫ corrupt/legacy 同文案单源（内部未决-224，内部任务-337）
const DECLARATION_HINTS = {
  'migratable-v2': '声明待迁移：运行 mode-lifecycle migrate-v2',
  expired: '模式已过期：到期检查点三选一（renew/毕业/abandon）',
  corrupt: INVALID_DECLARATION_HINT,
  legacy: INVALID_DECLARATION_HINT,
  unreadable: '声明不可读：检查权限/占用后重试或运行 recover',
};
// 任务号形态（内部未决-76 并集＋内部决策-045 可选维护者段）：旧 TASK- 系形态为存量兼容；新域前缀
// 形态 <域码>-<序号>（默认）或 <域码>-<维护者码>-<序号>（三段——域码/维护者码 2-4 位大写
// 字母、序号 1-6 位）——只认形态不认词表，与 workflow 无词表耦合。
// 导出（内部任务-57/内部未决-125）：冻结样本表哨兵（workflow/scripts/tests/taskid-form-samples.test.mjs）
// 消费——跨插件测试 import 只读常量不构成插件间依赖（测试固件面）。
export const TASK_ID_RE = /^(TASK-[A-Za-z0-9-]+|[A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{1,6})$/;

/** 测试注入缝（仅测试使用：崩溃点/锁注入函数；生产路径含 --selftest 均不得触缝）。 */
export const _testHooks = {
  afterJournal: null,
  afterLedgerAppend: null,
  afterLockAcquired: null,
  beforeLockOwnerWrite: null,
  afterStaleRename: null,
  afterRollback: null,
  beforeAbandonUnlink: null,
  syncBudgetMs: null,
  beforeSyncWrite: null,
  compactFail: null,
  afterBridgeBeforeCompact: null,
  afterModeWrite: null,
  bridgePresent: null,
};

const modePath = (root) => join(root, '.scout', 'mode.json');
const txDir = (root) => join(root, '.scout', 'transactions');
const lockPath = (root) => join(txDir(root), 'lock');
const journalPath = (root) => join(txDir(root), 'journal.json');
const ledgerPath = (root) => join(root, '.scout', 'ledger.jsonl');

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** 严格原子写：同目录唯一临时文件 + fsync + rename（对齐 common.py:58-79 严格版，含异常清理）。 */
function atomicWriteText(path, text) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  try {
    const fd = openSync(tmp, 'wx');
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 步骤 9 故障注入缝（rename 后）：mode 已落新值，保留 prepared journal，由 recover 按快照确定性回滚
    renameSync(tmp, path);
    if (_testHooks.afterModeWrite && String(path).endsWith('mode.json')) _testHooks.afterModeWrite(path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原异常 */
    }
    throw err;
  }
}

function appendLedger(root, event) {
  ensureDir(dirname(ledgerPath(root)));
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  const fd = openSync(ledgerPath(root), 'a');
  try {
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── 锁（内部决策-065 T1：owner 校验 + rename 后新鲜度/活性复核 + pidAware 回收；与 spec-gate lock.mjs 同语义）──

const LOCK_CONTENT_RE = /^[A-Za-z][A-Za-z0-9-]*:[0-9a-f]{8}:\d+$/;

function newLockOwner(kind) {
  return `${kind}:${randomUUID().slice(0, 8)}:${process.pid}`;
}

/** 锁内容 `<kind>:<uuid8>:<pid>` → pid；不可判定（如 spec-gate 写入的纯 owner 串）返回 null。 */
function parseLockPid(content) {
  const text = String(content ?? '').trim();
  if (!LOCK_CONTENT_RE.test(text)) return null;
  const pid = Number(text.split(':').pop());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** PID 存活探测：ESRCH=不存在；EPERM 等=存在但不可探测（按存活处理，保守拒回收）。 */
function pidAlive(pid) {
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'ESRCH' ? false : true;
  }
}

function readLockContent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 新建锁；owner 写失败时 close+unlink 自建锁再上抛（不留 0 字节锁阻塞 300s）。 */
function tryCreateLock(root, owner) {
  ensureDir(txDir(root));
  let fd;
  try {
    fd = openSync(lockPath(root), 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    if (_testHooks.beforeLockOwnerWrite) _testHooks.beforeLockOwnerWrite(lockPath(root));
    writeFileSync(fd, owner, 'utf8');
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* 已关闭或坏 fd */ }
    try { unlinkSync(lockPath(root)); } catch { /* ignore */ }
    throw err;
  }
  if (_testHooks.afterLockAcquired) _testHooks.afterLockAcquired(lockPath(root));
  return true;
}

/** 可回收判定（内部决策-065 T2 决策树）：pidAware 活性优先——PID 存活拒绝、PID 不存在回收、
 *  无 PID/不可判定回落 mtime>300s；非 pidAware 仅陈旧窗口；force 显式覆盖。 */
function reclaimableLock({ pid, alive, stale }, opts = {}) {
  if (opts.force) return true;
  if (opts.pidAware) return pid === null ? stale : alive === false;
  return stale;
}

/**
 * 取锁（内部决策-065 T1/T2）：返回 {ok, owner, retired?}（retired 记录本次实际回收的旧锁内容）。
 * 回收序：rename 占先（原子）→ 复核 retired 的新鲜度/PID 活性 → 盗到新鲜锁则 link 复原并认负
 * （复原失败 fail-stop，保留 retired 证据不删他人锁）→ 回收成功则重试获取。
 * pidAware（仅 recover）：新鲜锁的 owner PID 已不存在（崩溃）可回收；force 显式覆盖活性检查。
 */
function acquireLock(root, kind, opts = {}) {
  const owner = newLockOwner(kind);
  let retired = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (tryCreateLock(root, owner)) return retired ? { ok: true, owner, retired } : { ok: true, owner };
    } catch (err) {
      return { ok: false, error: `锁创建失败：${err.message}` };
    }
    let st;
    try {
      st = statSync(lockPath(root));
    } catch {
      continue; // 他人刚释放：立即重试
    }
    const content = readLockContent(lockPath(root));
    const pid = parseLockPid(content);
    const alive = pidAlive(pid);
    const stale = Date.now() - st.mtimeMs > LOCK_STALE_SECONDS * 1000;
    if (!reclaimableLock({ pid, alive, stale }, opts)) {
      return {
        ok: false,
        error: alive === true
          ? '另一 Scout 事务进行中（活跃 PID；如确认崩溃用 recover --force）'
          : '另一 Scout 事务进行中（锁内容不可判定且未陈旧；稍后重试或 recover --force）',
      };
    }
    const retiredPath = join(txDir(root), `lock.retired-${randomUUID().slice(0, 8)}`);
    try {
      renameSync(lockPath(root), retiredPath); // 原子占先：并发回收者只有一个成功
    } catch {
      continue; // 他人刚回收或刚获取：重试
    }
    if (_testHooks.afterStaleRename) _testHooks.afterStaleRename({ lockPath: lockPath(root), retired: retiredPath });
    let retiredStat;
    try {
      retiredStat = statSync(retiredPath);
    } catch {
      continue;
    }
    const retiredContent = readLockContent(retiredPath);
    const retiredPid = parseLockPid(retiredContent);
    const retiredAlive = pidAlive(retiredPid);
    const retiredStale = Date.now() - retiredStat.mtimeMs > LOCK_STALE_SECONDS * 1000;
    if (!reclaimableLock({ pid: retiredPid, alive: retiredAlive, stale: retiredStale }, opts)) {
      // 盗到新鲜锁：link 复原并认负；复原失败 fail-stop 保留证据。
      try {
        linkSync(retiredPath, lockPath(root));
        unlinkSync(retiredPath);
      } catch {
        return { ok: false, error: '锁回收竞态：新鲜锁复原失败（fail-stop，保留证据）' };
      }
      return { ok: false, error: '另一 Scout 事务进行中（新鲜锁被并发回收，已让位）' };
    }
    retired = { path: retiredPath, owner: retiredContent };
    unlinkSync(retiredPath);
  }
  return { ok: false, error: '锁获取重试耗尽（并发频繁；稍后重试）' };
}

/** 释放锁（内部决策-065 T1）：owner 内容匹配才 quarantine-rename+unlink；失配不删他人锁。 */
function releaseLock(root, owner) {
  const path = lockPath(root);
  const content = readLockContent(path);
  if (content === null) return { ok: true, missing: true };
  if (content !== owner) return { ok: false, mismatch: true };
  const retired = join(txDir(root), `lock.retired-${randomUUID().slice(0, 8)}`);
  try {
    renameSync(path, retired);
  } catch {
    return { ok: false, mismatch: true };
  }
  try {
    if (readLockContent(retired) !== owner) {
      linkSync(retired, path);
      unlinkSync(retired);
      return { ok: false, mismatch: true };
    }
  } catch {
    /* 复核失败：保守保留 retired（不误删） */
    return { ok: false, mismatch: true };
  }
  try {
    unlinkSync(retired);
  } catch {
    /* 清理失败不掩盖 */
  }
  return { ok: true };
}

// ── journal 与快照 ──

function journalWrite(root, record) {
  ensureDir(txDir(root));
  atomicWriteText(journalPath(root), JSON.stringify(record, null, 2) + '\n');
}

function journalClear(root) {
  try {
    unlinkSync(journalPath(root));
  } catch (err) {
    // 内部决策-065 T2：仅容忍 ENOENT；其余（EACCES/EROFS/EBUSY 等）上抛，由调用方映射 ok:false/recoverRequired。
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

/** T3 事务守卫：写操作在锁内检测 journal 残留即拒绝（不覆盖崩溃现场）。 */
function transactionGuard(root) {
  if (!existsSync(journalPath(root))) return null;
  return {
    error: '检测到未完成的 Scout 事务（journal 残留）：请先运行 node scout/scripts/mode-lifecycle.mjs --project-root <根> recover',
    recoverRequired: true,
  };
}

/** T12 argv 归一：调桥前对 event/taskId/mode/expiry/transactionId 做 String+非空/形态校验；
 *  非法 payload 返回 null（sync 侧计入 skippedInvalid 且随压缩清除）。 */
function normalizeBridgePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = { ...payload };
  for (const f of ['event', 'taskId', 'mode', 'expiry', 'transactionId']) {
    if (typeof out[f] !== 'string' || out[f].trim() === '') return null;
  }
  if (!TASK_ID_RE.test(out.taskId)) return null;
  if (!isValidExpiry(out.expiry)) return null;
  if (!MODES.includes(out.mode)) return null;
  if (out.event === 'abandon' && (typeof out.disposition !== 'string' || !out.disposition.trim())) return null;
  return out;
}

/** T7 锁 mtime 刷新：长持锁 sync 期间每次调桥前刷新，避免被误判为陈旧锁回收。 */
function refreshLockMtime(root) {
  try {
    const now = new Date();
    utimesSync(lockPath(root), now, now);
  } catch {
    /* 锁已被回收：写前 owner fencing 会兜底 */
  }
}

function snapshot(root) {
  const mp = modePath(root);
  const lp = ledgerPath(root);
  return {
    modeExists: existsSync(mp),
    modeText: existsSync(mp) ? readFileSync(mp, 'utf8') : null,
    ledgerLength: existsSync(lp) ? statSync(lp).size : 0,
  };
}

/** 回滚到事务前快照：mode 复原/删除 + 留痕按快照字节长度截断（append-only 的决定性回滚）。 */
function rollback(root, before) {
  const mp = modePath(root);
  if (before.modeExists && before.modeText !== null) {
    atomicWriteText(mp, before.modeText);
  } else {
    try {
      unlinkSync(mp);
    } catch (err) {
      // 内部决策-065 T2：仅容忍 ENOENT；其余上抛由调用方收口为失败（保留 journal）。
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
  const lp = ledgerPath(root);
  if (existsSync(lp)) {
    const fd = openSync(lp, 'r+');
    try {
      // journal 快照键名统一为 ledgerLength（Python 侧 graduate journal 亦用此键——键名漂移会把审计留痕截空）；
      // v2 六操作时代 journal 无此键，按 0 保守截断（只丢残留事件，不丢既有声明）
      ftruncateSync(fd, typeof before.ledgerLength === 'number' ? before.ledgerLength : 0);
    } finally {
      closeSync(fd);
    }
  }
}

// ── 状态读取（v3 本地判定，内部接口-9 v3 单文件自含语义）──

/**
 * 读取模式状态：委托 mode-state.readStatus（内部接口-9 v3 唯一判定源，单文件自含
 * 语义零 spawn）——判定单源化，本模块只承载写路径。
 */
export function status(root) {
  const base = readStatus(root);
  const { events } = readLedger(root);
  const pendingSync = events.filter((e) => e.event === 'pendingSync').length;
  // T20：centralSync 三态（本地文件读、不调桥）——present=中央有条目；missing=台账可读但无条目；
  // unknown=桥缺席/台账缺失或损坏（无法判定）。
  const centralSync = (() => {
    if (!base.bridgeAvailable) return 'unknown';
    try {
      const parsed = JSON.parse(readFileSync(join(root, '.sdd', 'ledger.json'), 'utf8'));
      // T20：可解析但 tasks 非数组＝损坏台账 → unknown（status 用 unknown、readCentral 用 corrupt——枚举面分叉已知，收敛随 内部未决-289）
      if (!Array.isArray(parsed?.tasks)) return 'unknown';
      return base.taskId && parsed.tasks.some((t) => t && t.id === base.taskId) ? 'present' : 'missing';
    } catch {
      return 'unknown';
    }
  })();
  return { ...base, pendingSync, centralSync };
}

// ── 桥调用（内部接口-12 v2 register；失败由调用方留 pendingSync）──

function bridgeRegister(root, payload) {
  const cli = providerCli();
  if (!cli) return { ok: false, error: 'provider-unavailable' };
  // env 缝契约随 内部决策-051 阶段1b 由 python CLI 变 node 入口：.py 后缀显式拒（计划修订 10）
  if (/\.py$/i.test(cli)) {
    return { ok: false, error: 'Python 桥入口已随 1b 退役，改指 scout-tx.mjs（SCOUT_TX_PROVIDER）' };
  }
  const args = [cli, '--project-root', String(root), 'scout-register',
    '--task-id', payload.taskId, '--mode', payload.mode, '--expiry', payload.expiry,
    '--transaction-id', payload.transactionId, '--event', payload.event];
  if (payload.event === 'abandon') args.push('--disposition', payload.disposition);
  if (payload.owner) args.push('--owner', payload.owner);
  const proc = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
  const stderrFirst = String(proc.stderr ?? '').trim().split('\n')[0].slice(0, 200);
  const failure = (() => {
    if (proc.error && proc.error.code) return proc.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT（超时）' : proc.error.code;
    if (proc.signal) return `signal ${proc.signal}`;
    return `退出码 ${proc.status}`;
  })();
  const withStderr = stderrFirst ? `；stderr: ${stderrFirst}` : '';
  const stdoutSnippet = String(proc.stdout ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const withStdout = stdoutSnippet ? `；stdout: ${stdoutSnippet}` : '';
  try {
    const parsed = JSON.parse(String(proc.stdout ?? '').trim());
    if (parsed && typeof parsed === 'object') return parsed;
    return { ok: false, error: `桥输出不可解析（${failure}）${withStderr}${withStdout}` };
  } catch {
    return { ok: false, error: `桥调用失败（${failure}）${withStderr}${withStdout}` };
  }
}

/** 锁内压缩（供事务收尾复用；调用方已持锁）。按 taskId 清除该任务全部 pendingSync（内部决策-065 T6）。
 *  compactFail 注入抛错＝压缩失败（pendingSync 保留）。 */
function compactResolvedLocked(root, taskId) {
  if (_testHooks.compactFail) _testHooks.compactFail();
  const { events, dropped } = readLedger(root);
  if (dropped > 0) throw new Error(`ledger 含 ${dropped} 行坏数据，压缩重写已拒绝`);
  const kept = events.filter((e) => !(e.event === 'pendingSync' && e.taskId === taskId));
  if (kept.length !== events.length) {
    atomicWriteText(ledgerPath(root), `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }
}

/** 事务收尾桥调用（T9：写事务仍持锁时调用）：失败留 pendingSync 返回 warning；
 *  成功后锁内压缩；`afterBridgeBeforeCompact` 注入缝模拟「登记成功但压缩前中断」（⑪）。
 *  均不反转本地有效性（内部接口-12 §4）。 */
function bridgeWithinTransaction(root, payload) {
  const normalized = normalizeBridgePayload(payload);
  if (!normalized) return '中央登记参数非法（payload 不可重放），已跳过桥登记（migrate/重开可修复）';
  const r = bridgeRegister(root, normalized);
  if (!r.ok) return `中央登记失败（已留 pendingSync，sync 可补登）：${r.error}`;
  if (_testHooks.afterBridgeBeforeCompact) _testHooks.afterBridgeBeforeCompact();
  try {
    compactResolvedLocked(root, normalized.taskId);
  } catch (err) {
    // 内部决策-065 T6：compact 失败不反转本地有效性；pendingSync 保留由 sync 幂等收敛
    return `中央登记成功但本地 pendingSync 压缩失败（已保留，可由 sync 收敛）：${err.message}`;
  }
  return null;
}

/** T8 桥在场检测（测试可用 _testHooks.bridgePresent 强制缺席/在场；生产走 providerCli 真实探测）。 */
function bridgeOn() {
  return typeof _testHooks.bridgePresent === 'boolean' ? _testHooks.bridgePresent : providerCli() !== null;
}

/** 最近一次生命周期的 owner（T11：renew/abandon 未显式传 owner 时的缺省来源）。 */
function recentOwner(root) {
  try {
    const { events } = readLedger(root);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.event !== 'pendingSync' && e.event !== 'synced' && typeof e.owner === 'string' && e.owner.trim()) return e.owner;
    }
  } catch {
    /* 读失败回落 unknown */
  }
  return 'unknown';
}

// ── 六操作 ──

/** v3 声明锁内复核谓词（S-03，内部未决-224①）：renew/abandon 共用；错误文案由调用方给。 */
function invalidV3Declaration(cur, taskId) {
  return !cur || cur.schemaVersion !== MODE_SCHEMA_VERSION || !MODES.includes(cur.mode) || !isValidExpiry(cur.expiry) || !isNonEmptyString(cur.transactionId) || cur.taskId !== taskId;
}

/** v2 声明形态谓词（S-03）：schemaVersion/mode/taskId/transactionId 公共核；expiry 判定由调用方按场景附加。 */
function invalidV2Shape(d) {
  return !d || d.schemaVersion !== 2 || !MODES.includes(d.mode) || !isNonEmptyString(d.taskId) || !isNonEmptyString(d.transactionId);
}

/** 事务公共尾（S-08，内部未决-224③）：清 journal＋桥在场时桥内登记（返回 warning 或 null）。 */
function finishTxTail(root, bridgePresent, payload) {
  journalClear(root);
  return bridgePresent ? bridgeWithinTransaction(root, payload) : null;
}

/** 事务收尾三元式（S-08）：warning 存在时附带回传。 */
function txOutcome(tx, warning) {
  return warning ? { ok: true, transactionId: tx, warning } : { ok: true, transactionId: tx };
}

function validateOpen({ mode, expiry, taskId }) {
  if (!MODES.includes(mode)) return `非法模式：${mode}`;
  if (!TASK_ID_RE.test(taskId)) return `非法任务号：${taskId}`;
  if (!isValidExpiry(expiry)) return `非法到期日：${expiry}`;
  return null;
}

/** 开启模式：校验 → 锁 → journal → 留痕 → 原子写 v3 → 清 journal → 桥登记。 */
export function open(root, { mode, expiry, taskId, owner = 'unknown' }) {
  const bad = validateOpen({ mode, expiry, taskId });
  if (bad) return { ok: false, error: bad, invalidArgs: true };
  if (status(root).valid) return { ok: false, error: '模式已开启（先 renew/abandon/migrate）' };
  const bridgePresent = bridgeOn(); // T8：桥缺席事务前求值（缺席不落 pendingSync 不警告）
  const lock = acquireLock(root, 'open');
  if (!lock.ok) return { ok: false, error: lock.error };
  let tx;
  let warning = null;
  try {
    const residual = transactionGuard(root);
    if (residual) return { ok: false, ...residual };
    if (readStatus(root).valid) return { ok: false, error: '模式已开启（锁内复核：并发 open 被拦截）', concurrencyRejected: true };
    const snap = snapshot(root);
    tx = randomUUID().replace(/-/g, '');
    journalWrite(root, { schemaVersion: 1, transactionId: tx, op: 'open', state: 'prepared', before: snap, after: { mode, taskId } });
    if (_testHooks.afterJournal) _testHooks.afterJournal();
    appendLedger(root, { event: 'open', mode, expiry, taskId, transactionId: tx, owner });
    if (_testHooks.afterLedgerAppend) _testHooks.afterLedgerAppend();
    atomicWriteText(modePath(root), JSON.stringify({ schemaVersion: MODE_SCHEMA_VERSION, mode, expiry, taskId, transactionId: tx }, null, 2) + '\n');
    if (bridgePresent) {
      appendLedger(root, { event: 'pendingSync', op: 'open', taskId, transactionId: tx, payload: { event: 'open', mode, expiry, taskId, transactionId: tx, owner } });
    }
    warning = finishTxTail(root, bridgePresent, { event: 'open', mode, expiry, taskId, transactionId: tx, owner });
  } catch (err) {
    // 残留 prepared journal 即崩溃现场：不吞不滚（fail-safe 由 recover 确定性回滚兜底）
    return { ok: false, error: `事务失败：${err.message}` };
  } finally {
    releaseLock(root, lock.owner);
  }
  return txOutcome(tx, warning);
}

/** 续期：声明更新 + transactionId 轮换（旧读端即刻失配回全量纪律）。 */
export function renew(root, { taskId, newExpiry, owner }) {
  if (!TASK_ID_RE.test(taskId)) return { ok: false, error: `非法任务号：${taskId}`, invalidArgs: true };
  if (!isValidExpiry(newExpiry)) return { ok: false, error: `非法到期日：${newExpiry}`, invalidArgs: true };
  const bridgePresent = bridgeOn(); // T8
  const lock = acquireLock(root, 'renew');
  if (!lock.ok) return { ok: false, error: lock.error };
  let tx;
  let curMode = null;
  let zoneOwner = typeof owner === 'string' && owner.trim() ? owner : recentOwner(root); // T11：显式 --owner 优先
  let warning = null;
  try {
    const residual = transactionGuard(root);
    if (residual) return { ok: false, ...residual };
    const cur = readJson(modePath(root));
    if (invalidV3Declaration(cur, taskId)) {
      return { ok: false, error: `任务 ${taskId} 非活跃合法 v3 Scout 声明（T15 锁内复核）` };
    }
    curMode = cur.mode;
    const snap = snapshot(root);
    tx = randomUUID().replace(/-/g, '');
    journalWrite(root, { schemaVersion: 1, transactionId: tx, op: 'renew', state: 'prepared', before: snap, after: { taskId, expiry: newExpiry } });
    if (_testHooks.afterJournal) _testHooks.afterJournal();
    appendLedger(root, { event: 'renew', mode: curMode, expiry: newExpiry, taskId, transactionId: tx });
    if (_testHooks.afterLedgerAppend) _testHooks.afterLedgerAppend();
    atomicWriteText(modePath(root), JSON.stringify({ schemaVersion: MODE_SCHEMA_VERSION, mode: curMode, expiry: newExpiry, taskId, transactionId: tx }, null, 2) + '\n');
    if (bridgePresent) {
      appendLedger(root, { event: 'pendingSync', op: 'renew', taskId, transactionId: tx, payload: { event: 'renew', mode: curMode, expiry: newExpiry, taskId, transactionId: tx, owner: zoneOwner } });
    }
    warning = finishTxTail(root, bridgePresent, { event: 'renew', mode: curMode, expiry: newExpiry, taskId, transactionId: tx, owner: zoneOwner });
  } catch (err) {
    return { ok: false, error: `事务失败：${err.message}` };
  } finally {
    releaseLock(root, lock.owner);
  }
  return txOutcome(tx, warning);
}

/** 放弃归档：删声明 + abandon 事件（含 disposition，B-M9-3 处置声明义务）。 */
export function abandon(root, { taskId, disposition, owner }) {
  if (!disposition || !String(disposition).trim()) {
    return { ok: false, error: '放弃必须声明产物处置（归档/删除，不并入主干）', invalidArgs: true };
  }
  const bridgePresent = bridgeOn(); // T8：abandon 为桥缺席终局路径（静默 pendingSync）
  const lock = acquireLock(root, 'abandon');
  if (!lock.ok) return { ok: false, error: lock.error };
  let tx;
  let lastMode = null;
  let lastExpiry = null;
  let zoneOwner = typeof owner === 'string' && owner.trim() ? owner : recentOwner(root); // T11：显式 --owner 优先
  let warning = null;
  try {
    const residual = transactionGuard(root);
    if (residual) return { ok: false, ...residual };
    const cur = readJson(modePath(root));
    if (invalidV3Declaration(cur, taskId)) {
      return { ok: false, error: `任务 ${taskId} 无活跃合法 v3 Scout 声明（T15 锁内复核）：先运行 status 核对当前声明；本地与中央均未变更，可用 open 重新开启或 recover 恢复` };
    }
    lastMode = cur.mode;
    lastExpiry = cur.expiry;
    const snap = snapshot(root);
    tx = randomUUID().replace(/-/g, '');
    journalWrite(root, { schemaVersion: 1, transactionId: tx, op: 'abandon', state: 'prepared', before: snap, after: { taskId } });
    if (_testHooks.afterJournal) _testHooks.afterJournal();
    appendLedger(root, { event: 'abandon', mode: lastMode, taskId, transactionId: tx, disposition });
    if (_testHooks.afterLedgerAppend) _testHooks.afterLedgerAppend();
    if (_testHooks.beforeAbandonUnlink) _testHooks.beforeAbandonUnlink({ modePath: modePath(root) });
    try {
      unlinkSync(modePath(root));
    } catch (err) {
      // 内部决策-065 T5：仅容忍 ENOENT；其余回滚事务（留痕截断 + 清 journal）并显式失败。
      if (!err || err.code !== 'ENOENT') {
        try {
          rollback(root, snap);
          journalClear(root);
        } catch {
          /* 回滚/清理失败保留 journal 由 recover 确定性兜底 */
        }
        return { ok: false, error: `事务失败已回滚：本地模式删除失败（${err.code ?? err.message}）` };
      }
    }
    appendLedger(root, { event: 'pendingSync', op: 'abandon', taskId, transactionId: tx, payload: { event: 'abandon', mode: lastMode, expiry: lastExpiry, taskId, transactionId: tx, disposition, owner: zoneOwner } });
    // T8：桥缺席时保留上面这条静默 pendingSync（终局意图）；桥在场则当场登记并压缩
    warning = finishTxTail(root, bridgePresent, { event: 'abandon', mode: lastMode, expiry: lastExpiry, taskId, transactionId: tx, disposition, owner: zoneOwner });
  } catch (err) {
    return { ok: false, error: `事务失败：${err.message}` };
  } finally {
    releaseLock(root, lock.owner);
  }
  return txOutcome(tx, warning);
}

/** 回滚后一致性核对（内部决策-065 T2）：mode 字节/存在性与 ledger 长度须等于 before 快照；
 *  任何读取异常都映射为核对失败（不得逃出 recover）。 */
function rollbackMatches(root, before) {
  const mp = modePath(root);
  let modeOk;
  try {
    modeOk = before.modeExists
      ? existsSync(mp) && readFileSync(mp, 'utf8') === before.modeText
      : !existsSync(mp);
  } catch {
    return 'mode 读取失败（无法核对回滚结果）';
  }
  if (!modeOk) return 'mode 字节与快照不符';
  if (typeof before.ledgerLength === 'number') {
    let len = 0;
    try {
      len = statSync(ledgerPath(root)).size;
    } catch {
      len = 0;
    }
    if (len !== before.ledgerLength) return `ledger 长度与快照不符（${len} ≠ ${before.ledgerLength}）`;
  }
  return null;
}

/**
 * 确定性恢复（内部决策-065 T2）：先 pidAware 取锁（与活跃事务互斥；`--force` 显式覆盖活性检查），
 * 锁内重读 journal → prepared 回滚到 before 快照并**核对回滚结果** → 清 journal；
 * 回滚/核对失败返回 ok:false 且保留 journal（供再次 recover 或人工处置）；
 * journal 不可解析时备份 `journal.corrupt-<ts>.json` 并失败退出（不静默 clean、不写 mode/ledger）。
 * graduate 中断的中央台账停留态属跨插件单面：回滚 note 指引人工核对（内部决策-065 T16，不属 sync/register 可修复）。
 * @param {string} root
 * @param {{force?: boolean}} [opts]
 * @returns {{ok: boolean, action?: string, note?: string, warning?: string, error?: string, recoverRequired?: boolean}}
 */
export function recover(root, { force = false } = {}) {
  const lock = acquireLock(root, 'recover', { pidAware: true, force });
  if (!lock.ok) return { ok: false, error: `恢复中止：${lock.error}`, recoverRequired: true };
  try {
    const jp = journalPath(root);
    const hasJournal = existsSync(jp);
    const journal = hasJournal ? readJson(jp) : null;
    if (hasJournal && (journal === null || Array.isArray(journal))) {
      const backup = join(txDir(root), `journal.corrupt-${Date.now()}.json`);
      try {
        renameSync(jp, backup);
      } catch (err) {
        return { ok: false, error: `journal 不可解析且备份失败：${err.message}`, recoverRequired: true };
      }
      return {
        ok: false,
        error: `journal 不可解析：已备份 ${basename(backup)}；备份留存供人工核对（不阻塞后续事务），清理后 hook/lint 停止提示`,
        recoverRequired: true,
      };
    }
    let action = 'clean';
    let note = null;
    if (journal && journal.state === 'prepared' && journal.before && typeof journal.before === 'object') {
      try {
        rollback(root, journal.before);
      } catch (err) {
        return { ok: false, action: 'rollback', error: `回滚失败：${err.message}`, recoverRequired: true };
      }
      if (_testHooks.afterRollback) _testHooks.afterRollback(root);
      const mismatch = rollbackMatches(root, journal.before);
      if (mismatch) {
        return { ok: false, action: 'rollback', error: `回滚核对失败：${mismatch}`, recoverRequired: true };
      }
      action = 'rollback';
      if (journal.op === 'graduate') {
        note = 'graduate 中断恢复：本地已回滚；中央台账可能停留 converged——该 graduate 中断态不属 sync/register 可修复，check-consistency 指引人工核对（ADR-065 T16）';
      }
    }
    if (hasJournal) {
      try {
        journalClear(root);
      } catch (err) {
        return { ok: false, action, error: `journal 清理失败：${err.message}`, recoverRequired: true };
      }
    }
    const result = note ? { ok: true, action, note } : { ok: true, action };
    if (lock.retired) {
      result.warning = force
        ? 'recover --force：已显式覆盖锁活性检查并回收'
        : `已回收陈旧锁（${String(lock.retired.owner ?? '').slice(0, 40)}）`;
    }
    return result;
  } finally {
    releaseLock(root, lock.owner);
  }
}

/** v2 自动迁移（内部决策-031 决策 4）：保留 mode/expiry/taskId、轮换 txId、归档旧件。 */
export function migrateV2(root) {
  const pre = readJson(modePath(root));
  if (invalidV2Shape(pre) || typeof pre.expiry !== 'string') {
    return { ok: false, error: '无可迁移的合法 v2 声明（v1/损坏/非法 mode/已过期按无模式处理）' };
  }
  if (!isValidExpiry(pre.expiry) || pre.expiry < todayIso()) {
    return { ok: false, error: 'v2 声明已过期，不迁移（到期检查点语义维持）' };
  }
  const bridgePresent = bridgeOn(); // T8
  const lock = acquireLock(root, 'migrate');
  if (!lock.ok) return { ok: false, error: lock.error };
  let tx;
  let warning = null;
  try {
    const residual = transactionGuard(root);
    if (residual) return { ok: false, ...residual };
    // 锁内复核（TOCTOU 防护）：迁移前状态必须仍是原 v2 声明（T15 锁内复核）
    const cur = readJson(modePath(root));
    if (invalidV2Shape(cur) || !isValidExpiry(cur.expiry) || cur.expiry < todayIso() || cur.taskId !== pre.taskId) {
      return { ok: false, error: '迁移前状态已变化或声明非法/已过期，中止' };
    }
    const migrateOwner = recentOwner(root);
    const snap = snapshot(root);
    tx = randomUUID().replace(/-/g, '');
    journalWrite(root, { schemaVersion: 1, transactionId: tx, op: 'migrate', state: 'prepared', before: snap, after: { taskId: pre.taskId, from: 'v2' } });
    if (_testHooks.afterJournal) _testHooks.afterJournal();
    appendLedger(root, { event: 'migrate', from: 'v2', mode: pre.mode, expiry: pre.expiry, taskId: pre.taskId, transactionId: tx });
    if (_testHooks.afterLedgerAppend) _testHooks.afterLedgerAppend();
    const v3Text = JSON.stringify({ schemaVersion: MODE_SCHEMA_VERSION, mode: pre.mode, expiry: pre.expiry, taskId: pre.taskId, transactionId: tx }, null, 2) + '\n';
    renameSync(modePath(root), `${modePath(root)}.v2-retired`);
    atomicWriteText(modePath(root), v3Text);
    if (bridgePresent) {
      appendLedger(root, { event: 'pendingSync', op: 'open', taskId: pre.taskId, transactionId: tx, payload: { event: 'open', mode: pre.mode, expiry: pre.expiry, taskId: pre.taskId, transactionId: tx, owner: migrateOwner } });
    }
    warning = finishTxTail(root, bridgePresent, { event: 'open', mode: pre.mode, expiry: pre.expiry, taskId: pre.taskId, transactionId: tx, owner: migrateOwner });
  } catch (err) {
    return { ok: false, error: `迁移失败：${err.message}` };
  } finally {
    releaseLock(root, lock.owner);
  }
  return txOutcome(tx, warning);
}

/** 补登：重放 pendingSync 事件到中央镜像（内部决策-065 T6/T7/T12；全程持锁 + mtime 刷新 + 预算 + 写前 fencing）。
 *  superseded：某 taskId 在其 pendingSync 之后已有任意后续生命周期事件（open/renew/migrate/abandon/graduate）
 *  即该早期意图已被取代，不重放（防把中央旧声明反映射成新事实）；
 *  skippedInvalid：payload 不可归一（缺字段/非法形态）→ 计入 skippedInvalid 并随压缩清除；
 *  ledger 含坏行（dropped>0）或 journal 残留时拒绝压缩重写；超预算/owner 失配时保留 pendingSync 返回失败。 */
export function sync(root) {
  const lock = acquireLock(root, 'sync');
  if (!lock.ok) return { ok: false, error: lock.error };
  const startedAt = Date.now();
  const budgetMs = typeof _testHooks.syncBudgetMs === 'number' ? _testHooks.syncBudgetMs : SYNC_BUDGET_MS;
  const bridgePresent = bridgeOn(); // T8：桥缺席时 sync 无事可做（本地档运行）
  try {
    const residual = transactionGuard(root);
    if (residual) return { ok: false, ...residual };
    if (!bridgePresent) return { ok: true, replayed: 0, superseded: 0, skippedInvalid: 0, bridgeAvailable: false };
    const { events, dropped } = readLedger(root);
    if (dropped > 0) {
      return { ok: false, error: `ledger 含 ${dropped} 行坏数据：压缩重写已拒绝（请先人工核对/修复留痕）` };
    }
    let replayed = 0;
    let superseded = 0;
    let skippedInvalid = 0;
    const replays = [];
    for (let i = 0; i < events.length; i += 1) {
      const p = events[i];
      if (p.event !== 'pendingSync') continue;
      const later = events.slice(i + 1).some((e) => e.event !== 'pendingSync' && e.event !== 'synced' && e.taskId === p.taskId);
      if (later) {
        superseded += 1;
        continue;
      }
      const normalized = normalizeBridgePayload({ event: p.op, taskId: p.taskId, transactionId: p.transactionId, ...p.payload });
      if (!normalized) {
        skippedInvalid += 1;
        continue;
      }
      replays.push(normalized);
    }
    for (const payload of replays) {
      if (Date.now() - startedAt > budgetMs) {
        return { ok: false, replayed, superseded, skippedInvalid, error: `sync 超出总预算 ${budgetMs}ms：已保留 pendingSync（未压缩）` };
      }
      refreshLockMtime(root);
      const r = bridgeRegister(root, payload);
      if (!r.ok) return { ok: false, replayed, superseded, skippedInvalid, error: `补登中断于第 ${replayed + 1} 项：${r.error}` };
      replayed += 1;
    }
    // T8：桥在场时补登当前有效声明（零 pending 也执行）；无效/过期/损坏声明跳过并标记 skippedDeclaration
    let declaration = 'skipped';
    let skippedDeclaration = false;
    const st = readStatus(root);
    if (st.valid) {
      const dp = normalizeBridgePayload({ event: 'open', mode: st.mode, expiry: st.expiry, taskId: st.taskId, transactionId: st.transactionId, owner: recentOwner(root) });
      if (dp) {
        if (Date.now() - startedAt > budgetMs) {
          return { ok: false, replayed, superseded, skippedInvalid, declaration: 'pending', error: `sync 超出总预算 ${budgetMs}ms（声明补登前）：已保留 pendingSync（未压缩）` };
        }
        refreshLockMtime(root);
        const rr = bridgeRegister(root, dp);
        if (!rr.ok) return { ok: false, replayed, superseded, skippedInvalid, error: `当前声明补登失败：${rr.error}` };
        declaration = 'registered';
      } else {
        declaration = 'skipped';
        skippedDeclaration = true;
      }
    } else {
      declaration = 'skipped';
      skippedDeclaration = true;
    }
    if (_testHooks.beforeSyncWrite) _testHooks.beforeSyncWrite({ lockPath: lockPath(root), owner: lock.owner });
    const currentOwner = readLockContent(lockPath(root));
    if (currentOwner !== lock.owner) {
      return { ok: false, replayed, superseded, skippedInvalid, error: 'sync 放弃写入：锁 owner 失配（写前 fencing）' };
    }
    const declarationHint = skippedDeclaration ? (DECLARATION_HINTS[st.reason] ?? null) : null;
    const kept = events.filter((e) => e.event !== 'pendingSync');
    kept.push({ at: new Date().toISOString(), event: 'synced', replayed, superseded, skippedInvalid, declaration, skippedDeclaration, declarationReason: st.reason, declarationHint, transactionId: randomUUID().replace(/-/g, '') });
    atomicWriteText(ledgerPath(root), `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
    return { ok: true, replayed, superseded, skippedInvalid, declaration, skippedDeclaration, declarationReason: st.reason, declarationHint };
  } finally {
    releaseLock(root, lock.owner);
  }
}

// ── CLI 入口（退出码镜像 spec-gate/assurance/cli.py:24-26：0 通过/1 内容阻断/2 工具参数错误）──

const USAGE = '用法：node scout/scripts/mode-lifecycle.mjs --project-root <dir> <open|renew|abandon|status|recover|migrate-v2|sync> [参数]\n' +
  '  --project-root 可置于任意位置（T13），支持 --flag value 与 --flag=value 两形态。\n' +
  '  open --mode explore|disposable --expiry YYYY-MM-DD --task-id TASK-n [--owner 名]\n' +
  '  renew --task-id TASK-n --new-expiry YYYY-MM-DD [--owner 名]；abandon --task-id TASK-n --disposition "<处置>" [--owner 名]\n';

/** T13 子命令旗标白名单（未知旗标/缺值/多余位置参数 → 用法 + 退 2）。 */
const COMMAND_FLAGS = {
  open: ['mode', 'expiry', 'task-id', 'owner'],
  renew: ['task-id', 'new-expiry', 'owner'],
  abandon: ['task-id', 'disposition', 'owner'],
  status: [],
  recover: ['force'],
  'migrate-v2': [],
  sync: [],
};

function parseCli(argv) {
  const pr = parseProjectRootArg(argv);
  if (!pr) return null; // 缺值/空值/尾随旗标按用法错误退 2，不让 resolve 抛栈
  const { positionals, flags, invalid } = parseFlags(pr.rest, { booleans: ['force'] });
  if (invalid) return null; // 缺值/未知旗标（白名单在下方统一判定）
  if (positionals.length !== 1) return null; // 未知/多余位置参数
  const command = positionals[0];
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return null; // 未知命令
  const unknown = Object.keys(flags).find((name) => !allowed.includes(name));
  if (unknown) return null; // 未知旗标（含 --dry-run 等未实现旗标）→ 退 2
  if (command === 'open' && (!flags.mode || !flags.expiry || !flags['task-id'])) return null;
  if (command === 'renew' && (!flags['task-id'] || !flags['new-expiry'])) return null;
  if (command === 'abandon' && (!flags['task-id'] || !flags.disposition)) return null;
  return { root: resolve(pr.root === null ? '.' : pr.root), command, flags };
}

function emit(result) {
  // T14：成功/内容阻断经 process.exitCode 收尾（不立即 exit）；工具错误由入口 catch 转 JSON 退 2。
  emitJson(result, { code: result.ok ? 0 : 1 });
}

/** T14 工具错误分类（fs 权限/占用/空间/IO 等 → JSON tool-error 退 2；内容阻断仍退 1）。 */
const TOOL_ERR_RE = /\b(EACCES|EPERM|EROFS|ENOSPC|EIO|EISDIR|ENOTDIR|EBUSY|EMFILE|ENFILE|ELOOP|ENOMEM)\b/;

function runCli(result) {
  if (result.invalidArgs) {
    process.stderr.write(`${USAGE}\n参数错误：${result.error}\n`);
    process.exit(2);
  }
  if (!result.ok && result.error && TOOL_ERR_RE.test(String(result.error))) {
    // C-6：工具错误重包须保留内容面字段（T2/T3 的 recoverRequired/action），仅错误格式化为 JSON
    const payload = { ...result, ok: false, code: 'tool-error' };
    emitJson(payload, { code: 2 });
    return;
  }
  if (result.warning) process.stderr.write(`【警告】${result.warning}\n`);
  emit(result);
}

function selftest() {
  // 自建临时根：selftest 不得触 _testHooks、不得依赖外部状态；失败可见（exitCode=1）
  const root = mkdtempSync(join(tmpdir(), 'scout-ml-selftest-'));
  try {
    const checks = [];
    const check = (name, cond) => checks.push([name, Boolean(cond)]);
    try {
      const r1 = open(root, { mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-SELFTEST-1' });
      check('open 落盘且状态有效', r1.ok && status(root).valid);
      const r2 = renew(root, { taskId: 'TASK-SELFTEST-1', newExpiry: '2999-02-02' });
      check('renew 轮换后状态有效', r2.ok && status(root).expiry === '2999-02-02');
      const r3 = abandon(root, { taskId: 'TASK-SELFTEST-1', disposition: 'selftest 清理' });
      check('abandon 关闭回无模式', r3.ok && !status(root).valid);
      const r4 = recover(root);
      check('recover 幂等清残留', r4.ok && r4.action === 'clean');
    } catch (err) {
      process.stdout.write(`FAIL mode-lifecycle selftest：${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
    if (failed.length) {
      process.stdout.write(`FAIL mode-lifecycle selftest（${failed.length} 项未过）\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('OK mode-lifecycle selftest（本地自治事务）\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 直接运行入口；symlink 形态归一＝内部未决-52，内部任务-44（形态同 内部任务-GUARDSYML-1 九钩——别名形态首轮
// 恒 false，realpath 归一后二轮再比）。
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    try {
      dispatch(process.argv.slice(2));
    } catch (err) {
      // T14：工具错误（fs 权限/占用/读取异常等）→ stdout JSON + 退 2，不输出栈
      emitJson({ ok: false, code: 'tool-error', error: err && err.message ? String(err.message) : String(err) }, { code: 2 });
    }
  }
}

/** 解析并分发子命令（T13 白名单/两形态/退 2；T14 成功/阻断经 exitCode 收尾）。 */
function dispatch(argv) {
  const parsed = parseCli(argv);
  if (!parsed) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const { root, command, flags } = parsed;
  if (command === 'open') {
    runCli(open(root, { mode: flags.mode, expiry: flags.expiry, taskId: flags['task-id'], owner: flags.owner ?? 'unknown' }));
  } else if (command === 'renew') {
    runCli(renew(root, { taskId: flags['task-id'], newExpiry: flags['new-expiry'], owner: flags.owner }));
  } else if (command === 'abandon') {
    runCli(abandon(root, { taskId: flags['task-id'], disposition: flags.disposition, owner: flags.owner }));
  } else if (command === 'status') {
    emit({ ok: true, ...status(root) });
  } else if (command === 'recover') {
    emit(recover(root, { force: Boolean(flags.force) }));
  } else if (command === 'migrate-v2') {
    runCli(migrateV2(root));
  } else if (command === 'sync') {
    runCli(sync(root));
  }
}
