// 文件：git-ref-lease.mjs
// 描述：git-ref 共享租约后端（内部决策-014 / D 计划）——refs/governance/leases/<digest> 命名空间
//       下的 CAS：update-ref 带 expected old OID（非 fast-forward 即冲突），跨开发者共享
//       （本地测试用临时仓库；远程 live-write 须执行时授权）。fencing token 存于专用
//       fencing ref（refs/governance/fencing/<digest>）的 commit message（内部任务-255 N-4）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const NAMESPACE = 'refs/governance/leases';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function refFor(resource) {
  const digest = createHash('sha256').update(resource).digest('hex').slice(0, 16);
  return `${NAMESPACE}/${digest}`;
}

/**
 * fencing 计数器 ref：refs/governance/fencing/<digest>（commit message 存十进制 token）。
 */
function fencingRefFor(resource) {
  const digest = createHash('sha256').update(resource).digest('hex').slice(0, 16);
  return `${NAMESPACE.replace('/leases', '/fencing')}/${digest}`;
}

/**
 * 经 git ref CAS 获取租约。
 * fencing token 跨 acquire/release 周期单调递增（内部任务-255 N-4）：token 记在专用 fencing ref 的
 * commit message——acquire 时以 expected-old CAS 推进；**登记失败即回滚租约 ref 并拒绝获取**
 * （不发号、不留僵尸租约）。原实现读 ref 的 reflog 派生 token，但自定义 ref 默认无 reflog
 * 且 release 删 ref ⇒ prev 恒 0（token 恒 1）——已废弃。
 * @param {string} repo 仓库路径
 * @param {{resource: string, holder: string}} req
 * @param {{gitFn?: (repo: string, args: string[]) => string}} [opts] 注入缝（测试用；默认 execFileSync git）
 * @returns {{ok: boolean, lease?: object, error?: string}}
 */
export function gitRefAcquire(repo, req, opts = {}) {
  const run = opts.gitFn ?? git;
  const ref = refFor(req.resource);
  const fencingRef = fencingRefFor(req.resource);
  let oldOid = '';
  try {
    oldOid = run(repo, ['rev-parse', ref]).trim();
  } catch {
    oldOid = ''; // ref 不存在：首取
  }
  if (oldOid) {
    return { ok: false, error: `资源 ${req.resource} 已被持有（ref ${ref} @ ${oldOid.slice(0, 8)}…）——CAS 冲突` };
  }
  let prevToken = 0;
  let fencingOld = '';
  try {
    fencingOld = run(repo, ['rev-parse', fencingRef]).trim();
    const msg = run(repo, ['log', '-1', '--format=%s', fencingOld]).trim();
    const n = Number.parseInt(msg, 10);
    if (!Number.isInteger(n) || n < 0) throw new Error('fencing counter unparsable');
    prevToken = n;
  } catch {
    // ref 不存在＝首取（合法）；ref 存在但内容不可解析＝计数器损坏 → fail-closed，不重发低号 token
    if (fencingOld) {
      return { ok: false, error: `fencing 计数器损坏（ref ${fencingRef} 内容不可解析）——拒绝获取（fail-closed）` };
    }
    prevToken = 0;
  }
  const lease = {
    leaseId: `grl-${randomUUID().slice(0, 10)}`,
    resource: req.resource, holder: req.holder,
    backend: 'git-ref', scope: 'cross-developer',
    fencingToken: prevToken + 1, acquiredAt: new Date().toISOString(),
  };
  // 租约 JSON 存于孤儿 commit 的 message（内容非敏感；ref 指向即持有凭证）
  const tree = run(repo, ['rev-parse', 'HEAD^{tree}']).trim();
  const commitOid = run(repo, ['commit-tree', tree, '-m', JSON.stringify(lease)]).trim();
  try {
    run(repo, ['update-ref', ref, commitOid, '']); // 空 old OID = 仅允许创建（git 层原子 CAS）
  } catch {
    return { ok: false, error: `资源 ${req.resource} CAS 竞态失败（update-ref 非零退出：对方先创建）` };
  }
  // fencing 登记：CAS 推进计数器；登记/构造任一步失败→回滚租约 ref 并拒绝获取（不消耗 token）
  try {
    const fenceOid = run(repo, ['commit-tree', tree, '-m', String(lease.fencingToken)]).trim();
    run(repo, ['update-ref', fencingRef, fenceOid, fencingOld]);
  } catch {
    let rolledBack = false;
    try { run(repo, ['update-ref', '-d', ref, commitOid]); rolledBack = true; } catch { /* 回滚失败需可见 */ }
    const tail = rolledBack ? '已回滚，未获租约' : '回滚失败（租约 ref 残留，需人工清理）';
    return { ok: false, error: `fencing 登记失败（写 ref 失败）——${tail}：${req.resource}`, };
  }
  lease.ref = ref;
  return { ok: true, lease };
}

/**
 * 按条件查租约 ref（namespace 扫描 + message 解析）。
 * @param {string} repo
 * @param {{leaseId?: string, resource?: string, holder?: string}} query
 */
function findLeaseRef(repo, query) {
  let lines = '';
  try {
    lines = git(repo, ['for-each-ref', NAMESPACE, '--format=%(refname)']);
  } catch {
    return null;
  }
  for (const ref of lines.split('\n').filter(Boolean)) {
    try {
      const oid = git(repo, ['rev-parse', ref]).trim();
      const message = git(repo, ['log', '-1', '--format=%s', oid]).trim();
      const lease = JSON.parse(message);
      if (query.leaseId && lease.leaseId !== query.leaseId) continue;
      if (query.resource && lease.resource !== query.resource) continue;
      if (query.holder && lease.holder !== query.holder) continue;
      return { ref, oid, lease };
    } catch { /* 坏 ref 跳过（非本资源） */ }
  }
  return null;
}

/**
 * 释放租约（按 leaseId 或 resource 定位；须是当前 holder）。
 * 评审 S2 处置：gitRefReleaseResource 是本函数的逐行拷贝且零调用——合并为单入口。
 * @param {string} repo
 * @param {{leaseId?: string, resource?: string, holder: string}} req
 */
export function gitRefRelease(repo, req) {
  const found = findLeaseRef(repo, req);
  if (!found) return { ok: false, error: `租约不存在：${req.leaseId ?? req.resource}` };
  if (found.lease.holder !== req.holder) {
    return { ok: false, error: `非 holder（${found.lease.holder} 持有）` };
  }
  git(repo, ['update-ref', '-d', found.ref, found.oid]);
  return { ok: true };
}
