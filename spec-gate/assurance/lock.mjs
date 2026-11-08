#!/usr/bin/env node
// 文件：lock.mjs
// 描述：独占锁单一实现（内部任务-241 步骤 5，G04/D03/D04 共用）——wx 原子创建＋持有者 uuid 写入
//       ＋陈旧锁 rename 占先回收（双回收者单胜）＋回收事件返回 {retired,retiredOwner} 供调用方
//       留诊断＋releaseLock 只删持有者自己的锁。供 receipts（凭据序号）与后续
//       scout_transactions/delivery_reports（台账写面）复用，替代三份逐行同构的本地方言。
//       单次持锁上限＝staleSeconds（缺省 300s，超过即视为陈旧可回收）；锁写失败即清理自建件。
// 作者：wangp  创建：2026-10-27  版权：MIT（见 spec-gate/LICENSE）
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const DEFAULT_STALE_SECONDS = 300;

/** 测试注入缝（内部任务-241/内部任务-242）：open 成功后、写 holder 前；回收 rename 后、mtime 复核前；
 * 复原 link 调用缝（内部任务-242 安全复审 S-1：注入 EPERM/不支持硬链接文件系统）。 */
export const _testHooks = { afterOpen: null, afterStaleDecision: null, linkRestore: null };

/** 8 位随机后缀（回收件唯一名）。 */
const uuid8 = () => randomUUID().replaceAll('-', '').slice(0, 8);

/**
 * 获取独占锁。
 * @param {string} lockPath 锁文件绝对路径
 * @param {{staleSeconds?: number, owner?: string}} [opts]
 * @returns {{ok: boolean, owner: string, retired: {path: string, retiredOwner: string}|null}}
 */
export function acquireLock(lockPath, opts = {}) {
  const staleSeconds = opts.staleSeconds ?? DEFAULT_STALE_SECONDS;
  const owner = String(opts.owner ?? randomUUID());
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
    if (_testHooks.afterOpen !== null) _testHooks.afterOpen(lockPath);
    writeSync(fd, Buffer.from(owner, 'utf8'));
    closeSync(fd);
    return { ok: true, owner, retired: null };
  } catch (e) {
    if (e.code !== 'EEXIST') {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 尽力 */ }
        // 锁写失败置 T（内部任务-241 复审）：清理自建锁文件，否则空锁 mtime 新鲜，
        // 后续 300s 内所有写者都会误报 ELOCKED（自伤可用性）。
        try { unlinkSync(lockPath); } catch { /* 尽力 */ }
      }
      throw e;
    }
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 尽力 */ } }
  }
  // 陈旧锁回收：rename 到唯一名后**复核被摘锁 mtime**——若为新鲜锁（回收竞态：他人刚回收并
  // 新建、或持有者刚刷新），用 `linkSync` 原子回写复原后认负；严禁裸 rename 回写覆盖新锁
  // （内部任务-242 §四-2/完成复审：stat→rename 非原子窗口的双持有者风险）。
  let retiredInfo = null;
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs <= staleSeconds * 1000) return { ok: false, owner, retired: null };
    const retired = join(dirname(lockPath), `${lockPath.split(/[\\/]/).pop()}.retired-${uuid8()}`);
    renameSync(lockPath, retired);
    if (_testHooks.afterStaleDecision !== null) _testHooks.afterStaleDecision(lockPath, retired);
    const retiredStat = statSync(retired);
    if (Date.now() - retiredStat.mtimeMs <= staleSeconds * 1000) {
      // S-1（内部任务-242 安全复审）：偷到新鲜锁＝回收竞态。必须原子复原；无法复原时 **fail-stop**
      // （抛冲突错误、保留被摘锁证据）——不得 unlink 后静默返回（否则原持有者与第三方双持有）。
      try {
        const doLink = _testHooks.linkRestore !== null ? _testHooks.linkRestore : linkSync;
        doLink(retired, lockPath);
      } catch (e) {
        const conflict = new Error(e && e.code === 'EEXIST'
          ? `锁回收冲突：第三方已重建新锁（${lockPath}；被摘新鲜锁存于 ${retired}）`
          : `锁回收复原失败（${(e && e.code) ?? '未知错误'}）：${lockPath}（被摘新鲜锁存于 ${retired}）`);
        conflict.code = 'LOCK_RECLAIM_CONFLICT';
        throw conflict;
      }
      try { unlinkSync(retired); } catch { /* 尽力：retired 零残留 */ }
      return { ok: false, owner, retired: null };
    }
    let retiredOwner = '';
    try { retiredOwner = readFileSync(retired, 'utf8'); } catch { /* 读失败不阻断回收 */ }
    unlinkSync(retired);
    retiredInfo = { path: retired, retiredOwner };
    if (typeof opts.onRetired === 'function') opts.onRetired(retiredInfo);
  } catch (e) {
    // S-1：复原冲突必须上抛（调用方 fail-loud 终止写）；其余（rename/stat 竞争）本轮认负。
    if (e && e.code === 'LOCK_RECLAIM_CONFLICT') throw e;
    return { ok: false, owner, retired: null };
  }
  const again = acquireLock(lockPath, { staleSeconds, owner });
  return { ...again, retired: retiredInfo };
}

/**
 * 释放锁（S-2，内部任务-242 安全复审）：先原子 rename 到唯一 quarantine，再核对 owner——
 * 只有 quarantine 内容等于 owner 才 unlink；非持有者原子 link 复原后返回 false。
 * 避免「read 与 unlink 之间被回收/替换→误删新持有者锁」的双持有窗口。
 * @param {string} lockPath @param {string} owner
 * @returns {boolean} 是否由本持有者实际删除
 */
export function releaseLock(lockPath, owner) {
  let current;
  try {
    current = readFileSync(lockPath, 'utf8');
  } catch {
    return false; // 锁已不存在/不可读：非本持有者删除
  }
  // S-2 复核（内部任务-242 安全复审）：先核验 owner，非本持有者**不 rename**（否则会摘掉活跃持有者锁）。
  if (String(current) !== String(owner)) return false;
  const quarantine = join(dirname(lockPath), `${lockPath.split(/[\\/]/).pop()}.released-${uuid8()}`);
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false; // 与回收/替换竞争失败：本轮不删除
  }
  // owner 核验后再复核 quarantine 内容（rename 与回收交错时，摘到可能是新持有者的锁）。
  let after = null;
  try { after = readFileSync(quarantine, 'utf8'); } catch { after = null; }
  if (after !== null && String(after) === String(owner)) {
    try { unlinkSync(quarantine); } catch { /* 尽力：quarantine 残留但锁已不在位 */ }
    return true;
  }
  // 竞态：原子 link 复原；若第三方已建新锁（EEXIST）则保留 quarantine 作为证据。
  let restored = false;
  try { linkSync(quarantine, lockPath); restored = true; } catch { /* EEXIST/不支持硬链接 */ }
  if (restored) { try { unlinkSync(quarantine); } catch { /* 尽力 */ } }
  return false;
}

/** 读锁当前持有者内容（缺失返回 null）——fencing 用（内部任务-242 S-1）。 */
export function lockOwner(lockPath) {
  try { return readFileSync(lockPath, 'utf8'); } catch { return null; }
}

/** 校验锁仍由 owner 持有（归档 manifest 写前 fencing，内部任务-242 S-1）。 */
export function isLockOwner(lockPath, owner) {
  const current = lockOwner(lockPath);
  return current !== null && String(current) === String(owner);
}
