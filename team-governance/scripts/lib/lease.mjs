// 文件：lease.mjs
// 描述：CAS Lease local 后端（内部规则-2 / 内部接口-15 / 内部决策-014）——文件状态即事实源：
//       全部变更路径在独占锁（O_EXCL+rename 回收）内读-改-写，acquire 冲突判定与
//       revision 前置检查都在锁内完成（评审 C2 处置：无锁则并发后写者抹掉先写者）；
//       fencing token 按资源单调递增、过期 holder 续租拒绝（acquire 侧过期不构成冲突）、
//       父子 path 互斥、多仓 partial 补偿释放。
//       scope 诚实声明 workspace-local（跨开发者须 D 波次后端）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
         openSync, writeSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from './atomic-write.mjs';
import { join } from 'node:path';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;

function leasesDir(root) {
  return join(root, '.ai-governance', 'runtime', 'leases');
}

function statePath(root) {
  return join(leasesDir(root), 'leases.json');
}

/**
 * 租约状态损坏错误（2026-09-19 评审修复 H5）：解析失败/不可读 ≠ 空态——原实现把
 * 损坏静默当空态继续读改写，一次截断即销毁全部 held 租约并把 fencing token 归零
 * 重发（冲突检测与围栏保护同时失效）。写路径拒绝在损坏态上覆盖，抛本错误由 CLI
 * 映射工具错误（退出 2）；修复须人工核对（备份后重建）。同仓先例：production_store
 * 坏行产 blocking、gate 台账不可解析产 blocking——「读不懂」是可见失败不是空集。
 */
export class LeaseStateCorruptError extends Error {
  /**
   * @param {string} path 状态文件路径
   * @param {string} detail 失败细节
   */
  constructor(path, detail) {
    super(`leases.json 损坏（${path}，${detail}）：拒绝在损坏态上读改写——请人工核对该文件，确需重建请先备份再删除`);
    this.name = 'LeaseStateCorruptError';
  }
}

function loadState(root) {
  const path = statePath(root);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { schemaVersion: '1.0.0', revision: 0, leases: {} }; // 文件缺失=合法空态
    }
    throw new LeaseStateCorruptError(path, `读取失败 ${e.code ?? e.message}`); // 存在但不可读：完整性无法证明
  }
  try {
    const state = JSON.parse(raw);
    // 读侧归一（内部任务-252 评审修复）：存量台账可能含带首尾空白的 resource 死键（旧版本 CLI 未归一写入）。
    // 读入即归一，使 lib 侧 conflicting 重叠判定对历史记录同样生效；下次落盘固化（全量覆写，连历史记录一并归一）。
    // 边界：钩子（hooks/pre-tool-use.mjs 自带 loadHeldLeases 裸读）与 gate 报告投影（governance-store 裸读）
    // 不经 loadState，故在首次成功写固化前，legacy padded 记录仍不进入钩子前缀护栏/报告投影——
    // 该读侧单源化列为承接 OPEN-n（内部任务-252 收尾移交），不在本函数承诺范围。
    if (state && state.leases && typeof state.leases === 'object') {
      for (const lease of Object.values(state.leases)) {
        if (lease && typeof lease.resource === 'string' && lease.resource !== lease.resource.trim()) {
          lease.resource = lease.resource.trim();
        }
      }
    }
    return state;
  } catch (e) {
    throw new LeaseStateCorruptError(path, `JSON 解析失败：${e.message}`);
  }
}

function saveState(root, state) {
  // 调用方须持 _withLock 进入（写侧整体替换；状态文件即事实源）
  mkdirSync(leasesDir(root), { recursive: true });
  atomicWriteJson(statePath(root), state);
}

// ── 独占锁（评审 C2 处置：读-改-写全程持锁——O_EXCL 创建 + rename 占先回收陈旧锁，
//    与 scout_transactions 同款语义；无锁则两个并发 acquire 后写者抹掉先写者）──

function lockPath(root) {
  return join(leasesDir(root), 'leases.lock');
}

/** 状态锁获取失败（非 EEXIST 的 errno：EACCES/EISDIR/EROFS/ENOSPC…）——工具错误语义，CLI 退 2。 */
export class LeaseLockError extends Error {
  constructor(lock, cause) {
    super(`leases.json 状态锁获取失败（${cause?.code ?? cause?.errno ?? 'unknown'}）：${cause?.message ?? cause}`);
    this.name = 'LeaseLockError';
    this.code = cause?.code ?? null;
    this.errno = cause?.errno ?? null;
  }
}

/**
 * 获取状态锁（内部任务-257 P5-6）：O_EXCL 创建；EEXIST→占用（含陈旧回收）；其他 errno→LeaseLockError。
 * openFn 为测试注入缝（默认 openSync）；open 成功后写/关闭失败须清理锁文件。
 * @param {string} root
 * @param {string} owner
 * @param {typeof openSync} [openFn]
 * @returns {boolean} true=获取成功；false=被占用
 */
export function acquireStateLock(root, owner, openFn = openSync) {
  const lock = lockPath(root);
  mkdirSync(leasesDir(root), { recursive: true });
  let fd;
  try {
    fd = openFn(lock, 'wx');
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw new LeaseLockError(lock, e);
    try {
      const stat = statSync(lock);
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
      const retired = `${lock}.retired-${randomUUID().slice(0, 8)}`;
      renameSync(lock, retired); // rename 占先：两个回收者只有一个成功
      unlinkSync(retired);
    } catch { return false; }
    return acquireStateLock(root, owner, openFn);
  }
  try {
    writeSync(fd, owner);
    closeSync(fd);
    return true;
  } catch (e) {
    try { closeSync(fd); } catch { /* 已关闭/无效 fd */ }
    try { unlinkSync(lock); } catch { /* 尽力清理 */ }
    throw new LeaseLockError(lock, e);
  }
}

export function releaseStateLock(root) {
  try { unlinkSync(lockPath(root)); } catch { /* 已不在即达成目的 */ }
}

/**
 * 锁内执行读-改-写（全部变更路径的唯一写入口）。
 * @template T
 * @param {string} root
 * @param {string} owner
 * @param {() => T} fn
 * @returns {T | {ok: false, error: string}}
 */
function _withLock(root, owner, fn) {
  let acquired;
  try {
    acquired = acquireStateLock(root, owner);
  } catch (e) {
    if (e instanceof LeaseLockError) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
  if (!acquired) {
    return { ok: false, error: 'leases.json 锁被占用（并发写竞争；稍后重试）' };
  }
  try {
    return fn();
  } finally {
    releaseStateLock(root);
  }
}

/**
 * 资源重叠判定：path 前缀通配父子互斥；repo:X 包含其下 path:X:**；其余同类同名才算。
 * @param {string} a
 * @param {string} b
 */
export function pathsOverlap(a, b) {
  const [ka, ...ra] = a.split(':');
  const [kb, ...rb] = b.split(':');
  if (ka === kb) {
    if (ka === 'path') {
      const pa = ra.join(':').replace(/\/\*\*$/, '');
      const pb = rb.join(':').replace(/\/\*\*$/, '');
      return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
    }
    return a === b;
  }
  // 跨类：repo:X 拥有其 path:X:**（repo 与 path 的仓库段一致即包含）
  if (ka === 'repo' && kb === 'path') return rb[0] === ra[0];
  if (ka === 'path' && kb === 'repo') return ra[0] === rb[0];
  return false;
}

function conflicting(state, resource, now) {
  for (const lease of Object.values(state.leases)) {
    if (lease.state !== 'held') continue;
    if (lease.expiresAt < now) continue; // 过期不构成冲突
    if (pathsOverlap(lease.resource, resource)) return lease;
  }
  return null;
}

/**
 * 资源 token 合法性单源谓词（内部任务-252 评审修复）：CLI 前置校验与 lib 双保险共用，防两层判定分叉。
 * 合法＝字符串、trim 后非空、不以 `--` 开头（旗标当值形态）。
 * @param {unknown} token
 * @returns {boolean}
 */
export function isValidResourceToken(token) {
  return typeof token === 'string' && token.trim() !== '' && !token.trim().startsWith('--');
}

/**
 * 获取租约（单个或 allOrNothing 多资源）。
 * 参数非法（资源缺失/数组为空/元素非字符串或为空白/以 -- 开头）抛参数错。
 * @param {string} root 项目根
 * @param {{resource?: string, resources?: string[], holder: string, changeSetId?: string,
 *          allOrNothing?: boolean}} req
 * @returns {{ok: boolean, lease?: object, error?: string, released?: string[]}}
 * @throws {Error} 参数错（缺失/非法 resource）——CLI 层映射为工具错退 2，不落台账
 */
export function acquireLease(root, req) {
  return _withLock(root, `acquire-${req.holder}`, () => {
    const now = Date.now();
    const rawWanted = req.resources ?? [req.resource];
    // 内部任务-252 批 1a（C3）：参数错双保险——CLI 已前置校验；lib 层对空/非法 resource 抛参数错
    // （governance-cli 的 lease 分支 catch 把异常映射为工具错退 2，避免落无 resource 的坏台账）。
    // 内部任务-252 评审修复：取值先 trim 归一（前导/尾随空白与逗号空格不再是死键），再做合法性校验；
    // 归一后的值才是写入台账的 resource（否则互斥判定与钩子前缀护栏会同时失配）。
    if (!Array.isArray(rawWanted) || rawWanted.length === 0) {
      throw new Error('acquireLease: resource/resources 缺失或非法（参数错）');
    }
    const wanted = rawWanted.map((r) => (typeof r === 'string' ? r.trim() : r));
    if (wanted.some((r) => !isValidResourceToken(r))) {
      throw new Error('acquireLease: resource/resources 缺失或非法（参数错）');
    }
    const state = loadState(root);
    const acquired = [];
    const released = [];
    for (const resource of wanted) {
      const conflict = conflicting(state, resource, now);
      if (conflict) {
        if (req.allOrNothing) {
          for (const id of acquired) { // 补偿释放
            state.leases[id].state = 'released';
            released.push(state.leases[id].resource);
          }
          saveState(root, state);
          return { ok: false, error: `资源 ${resource} 被 ${conflict.holder} 持有（fencing=${conflict.fencingToken}）`, released };
        }
        return { ok: false, error: `资源 ${resource} 被 ${conflict.holder} 持有（fencing=${conflict.fencingToken}）` };
      }
      // fencing token 按资源单调递增（全局计数会把兄弟租约计入，破坏单调语义）
      const perResource = Object.values(state.leases)
        .filter((l) => l.resource === resource)
        .reduce((m, l) => Math.max(m, l.fencingToken), 0);
      const leaseId = `lease-${randomUUID().slice(0, 10)}`;
      state.leases[leaseId] = {
        leaseId, resource, holder: req.holder, changeSetId: req.changeSetId ?? null,
        backend: 'local', scope: 'workspace-local',
        state: 'held', acquiredAt: now, expiresAt: now + DEFAULT_TTL_MS,
        revision: state.revision + 1, fencingToken: perResource + 1,
      };
      state.revision += 1;
      acquired.push(leaseId);
    }
    saveState(root, state);
    return { ok: true, lease: wanted.length === 1 ? state.leases[acquired[0]] : undefined,
             leases: acquired.map((id) => state.leases[id]) };
  });
}

/**
 * 续期（须携带旧 revision——CAS；锁内执行）。
 * 过期口径：过期 = expiresAt < now（与 pre-tool-use 的 live 判定 expiresAt >= Date.now() 真互补、
 * 与 conflicting() 的 skip 口径一致）；expiresAt 不可判定（非有限数值）同样拒绝续租（fail-closed）。
 * 过期/不可判定 holder 的旧 token 写入一律拒绝（内部规则-2；拒绝面＝renew，release 见 releaseLease）。
 * @param {{leaseId: string, revision: number}} req
 */
export function renewLease(root, req) {
  return _withLock(root, `renew-${req.leaseId}`, () => {
    const state = loadState(root);
    const lease = state.leases[req.leaseId];
    if (!lease || lease.state !== 'held') return { ok: false, error: '租约不存在或已释放' };
    if (lease.revision !== req.revision) {
      return { ok: false, error: `stale revision（期望 ${lease.revision}，收到 ${req.revision}）——CAS 失败` };
    }
    // 内部任务-252 批 1a（C2）：过期 holder 旧 token 写入拒绝（内部规则-2 / 内部接口-15 §2、§4）。
    // 过期 = expiresAt < now：与 pre-tool-use 的 live 判定（expiresAt >= Date.now()）真互补、
    // 与 conflicting() 的 skip 口径（expiresAt < now 即跳过）一致；边界毫秒按 live 处理。
    // 不可判定的 expiresAt（NaN/缺失/非数值）按「拒绝写入、要求人工核对」处理（fail-closed，
    // 与 loadState「读不懂即拒」同姿态；NaN 比较恒 false 会 fail-open 复活记录）。
    // 不读其它租约（重叠兜底在 acquire 冲突判定内；本守卫只封「过期→他人重取→旧 holder 刷回」的复活向量）。
    const now = Date.now();
    if (!Number.isFinite(lease.expiresAt)) {
      return { ok: false, error: `租约过期时间不可判定（expiresAt=${String(lease.expiresAt)}）——拒绝续租，请人工核对 leases.json（R-M13-2）` };
    }
    if (lease.expiresAt < now) {
      return { ok: false, error: `租约已过期（${new Date(lease.expiresAt).toISOString()}）——过期 holder 写入拒绝，请重新 acquire（R-M13-2）` };
    }
    lease.revision = state.revision + 1;
    lease.expiresAt = Date.now() + DEFAULT_TTL_MS;
    state.revision += 1;
    saveState(root, state);
    return { ok: true, lease };
  });
}

/**
 * 释放（须携带旧 revision；锁内执行）。
 * 不设过期守卫（内部任务-252 批 1a）：过期记录经 release 进入 released 终态，是审计清理通道；
 * 内部规则-2 的「过期 token 写入拒绝」面＝renew（资源写入强制作废点在钩子/CI），不含审计清理动作。
 * @param {{leaseId: string, revision: number}} req
 */
export function releaseLease(root, req) {
  return _withLock(root, `release-${req.leaseId}`, () => {
    const state = loadState(root);
    const lease = state.leases[req.leaseId];
    if (!lease) return { ok: false, error: '租约不存在' };
    if (lease.state !== 'held') return { ok: false, error: '租约已非 held' };
    if (lease.revision !== req.revision) {
      return { ok: false, error: `stale revision（期望 ${lease.revision}，收到 ${req.revision}）` };
    }
    lease.state = 'released';
    lease.releasedAt = Date.now();
    state.revision += 1;
    saveState(root, state);
    return { ok: true };
  });
}
