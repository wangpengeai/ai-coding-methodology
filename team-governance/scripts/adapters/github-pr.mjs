// 文件：github-pr.mjs
// 描述：GitHub PR 适配器 dry-run（内部决策-015 / D 计划步骤 14）——读事件 JSON（--event-file
//       本地文件形态）转 provider-neutral 审批记录；review dismissal 撤销；新 commit
//       使旧审批失效；默认零网络（真实 API 读写在 D 后段且须执行时授权）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

/**
 * PR 事件 → 审批记录数组。
 * @param {{action: string, pull_request?: object, review?: object,
 *          signatureVerified?: boolean}} event  signatureVerified 由适配器外层
 *          （D 波段真实 API 路径的 HMAC 验签）传入；本地 --event-file 无签名通道，
 *          身份一律 local-attested（评审 C7 处置②：未签名事件不构成已验证身份）。
 * @param {{subjectDigest: string}} base 当前 subject 锚（审批绑定对象组合）
 * @returns {Array<object>} 有效审批/撤销记录（stale commit 不产生记录）
 */
export function prEventToApprovals(event, base) {
  const review = event.review;
  const pr = event.pull_request;
  if (!review || !pr) return [];
  const prHead = pr.head?.sha;
  const commitId = review.commit_id ?? prHead;
  // 审批绑定评审时的 commit：评审后新 push → 旧审批对当前 head 失效（内部决策-014 对象绑定）
  if (prHead && commitId && prHead !== commitId) return [];
  const verified = Boolean(event.signatureVerified);
  const identity = { source: 'github-review', verified, id: review.user?.login ?? 'unknown' };

  if (event.action === 'review_dismissed') {
    return [{
      approvalId: `apr-gh-${review.user?.id ?? 'x'}`,
      subjectDigest: base.subjectDigest,
      role: 'accountable',
      identity,
      decidedAt: review.submitted_at ?? new Date().toISOString(),
      revocation: { reason: 'review-dismissed', at: new Date().toISOString() },
    }];
  }
  if (event.action === 'reviewed' && review.state === 'approved') {
    return [{
      approvalId: `apr-gh-${review.user?.id ?? 'x'}`,
      subjectDigest: base.subjectDigest,
      role: 'accountable',
      identity,
      decidedAt: review.submitted_at ?? new Date().toISOString(),
      expiresAt: '2099-01-01',
      conditions: [],
    }];
  }
  return [];
}
