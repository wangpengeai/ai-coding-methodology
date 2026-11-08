// 文件：lease-seed.mjs
// 描述：测试固件——在隔离状态根预种 null 桶有效租约，使装载链/护栏用例的 routing-gate 静默放行
// 作者：wangp  创建：2026-10-23  版权：MIT（见仓库 LICENSE）
// 为什么要有（内部未决-93②③，内部任务-48）：装载链/护栏用例驱动真实 routing-gate，无有效租约时
// 闸的 deny 会压过 check-careful 的 ask——用例须在隔离状态根里预种 null 桶租约，让闸
// 静默放行、只剩护栏决策。种入走 workflow 自家的 task-lease-lib（与
// routing-declare.test.mjs 的 seedMainLease 同款）而非手写 JSON：租约文件形态（schema v4）
// 是演进中的实现细节，手写副本会在字段演进时静默变红。测试固件跨树 import（生产面 src/
// 仍零 workflow 内部依赖，内部决策-032 单向只读边界不破；tests 本就在 spawn workflow 脚本、
// 读 REPO_ROOT 资产，固件面同理）。
// 经 ambient env 种入（门②简洁性 S2-2）：租约要被 apply() spawn 的 routing-gate 子进程
// 看见，子进程继承的是环境现值而非本函数的瞬态覆盖——调用方必须先在模块级设
// WF_ROUTING_STATE_DIR 指隔离根，此处守卫断言（缺席即种子会写真实用户状态根，禁止）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { issueChallenge, activateLease } from '../../../workflow/hooks/task-lease-lib.mjs';
import { requiredProjectSkills } from '../../../workflow/scripts/lib/project-skills.mjs';
import { projectKey } from '../../../workflow/hooks/routing-lib.mjs';

/**
 * 种入 null 桶有效租约（全观察侧可见：具名观察侧救回带 viaNullBucket 标注、闸照常放行）。
 * 前置＝调用方模块级已设 WF_ROUTING_STATE_DIR 指隔离根（未设即断言失败）。
 * skill 用 tdd：非规划 skill 不触发固定写面判定（authoringViolation 只对 plan-writing/
 * plan-review 触发）、不带 changeScope 不触发写面判定（scopeViolation 只在有声明时触发），
 * 闸对 Bash/Edit/Write 全放行。taskId 用 内部任务-999999（域码须在本仓域集内、值域合法
 * 〔内部未决-111/内部任务-52 收紧后 0 不受理〕；域内最高位号＝真实取号空间恒不可达，种子只活在
 * 隔离状态根里——即便在该根内抬 max 也只影响取号建议，两消费测试均不断言建议号）。
 * TTL 走默认 45min 且闸命中即心跳续期，不设覆盖缝。
 * @param {string} repoRoot 仓库根（租约键 = projectKey 单源，与闸侧 deriveGateKey 同源）
 */
export function seedNullBucketLease(repoRoot) {
  assert.ok(process.env.WF_ROUTING_STATE_DIR, '种子前置失败：调用方须先模块级隔离 WF_ROUTING_STATE_DIR（否则种子会写真实用户状态根）');
  const key = projectKey(repoRoot);
  const ch = issueChallenge(key, {}); // 空 meta ⇒ 挑战挂 null 桶（激活继承）
  // activateLease 会写 git 同步面的 claims/<taskId>.json；测试种子不得把占位文件留在
  // 真实仓库（内部任务-60 已有一例副产物）。激活后按前后状态复原，只清本夹具新增的文件。
  const marker = join(repoRoot, 'docs', 'plans', 'claims', 'DEV-999999.json');
  const before = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  // 内部决策-061 D6（内部任务-227）：内部任务-999999 在 traceability 示例编号中被引用（审计源独占）——隔离
  // 状态根预写一行 issued 台账历史 issuance，种子以「续任务通道」显式续用该哨兵号（与真实
  // 「历史号续用」语义同构；只活在隔离根，不影响真实取号）。
  const keyDigest = createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  const ledger = join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${keyDigest}.jsonl`);
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify({ schemaVersion: 1, ts: Date.now(), taskId: 'DEV-999999', sessionId: null })}\n`);
  const act = activateLease(key, {
    leaseId: ch.leaseId,
    taskId: 'DEV-999999',
    skill: 'tdd',
    resume: true,
    resumeReason: '用户授权：测试夹具续用域内不可达哨兵号 DEV-999999（隔离状态根预置 issuance）',
    // 内部任务-341/内部决策-070：真实仓项目 skill 必载集合自动补 ack（无项目 skill 时为空集）
    ...(() => {
      const req = requiredProjectSkills({ projectRoot: repoRoot }).required;
      return req.length > 0 ? { projectSkills: req.map((sk) => ({ name: sk.name, root: sk.root })) } : {};
    })(),
  });
  if (before === null) {
    try { unlinkSync(marker); } catch { /* 文件未创建或已清理 */ }
  } else {
    writeFileSync(marker, before);
  }
  assert.ok(act.ok, `种子租约激活失败（夹具自坏）：${act.reason ?? ''}`);
}
