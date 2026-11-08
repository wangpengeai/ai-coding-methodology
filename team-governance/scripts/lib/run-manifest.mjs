// 文件：run-manifest.mjs
// 描述：AI Run Manifest 生命周期（内部决策-013 / 内部接口-14）——begin（policy preflight
//       由调用方先行）→ 工作期追加 context/evidence → finalize（不可变+integrity 哈希，
//       落盘前 redact）。不可观察字段由调用方按 内部接口-2 传 observation:'unavailable'。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';

import { atomicWriteJson } from './atomic-write.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { integrityHash } from './canonical-json.mjs';
import { hostOf, pluginRef } from './client-info.mjs';
import { redact, scanSecrets } from './redaction.mjs';

function runsDir(root) {
  return join(root, '.ai-governance', 'runtime', 'runs');
}

function manifestPath(root, runId) {
  return join(runsDir(root), `${runId}.json`);
}



/**
 * manifest body 内容哈希（integrityHash 口径：去掉 integrityHash 字段后 canonical 哈希）。
 * 内部任务-254（H7）：run-begin 以本函数产 openHash；finalize `--expect-hash` 以同一函数重算
 * 当前 open body 做 CAS（同一口径，防两侧各算一套）。
 * @param {object} manifest
 * @returns {string}
 */
export function manifestContentHash(manifest) {
  const body = { ...(manifest ?? {}) };
  delete body.integrityHash;
  return integrityHash(body);
}

/**
 * 开启 run：生成 runId 与可追加 manifest（status=open）。
 * @param {string} root 项目根
 * @param {{taskId: string, initiator?: string, agentRole?: string, changeSetId?: string,
 *          policyRef?: string, model?: {observation?: string, provider?: string},
 *          parentRunId?: string, clientHost?: string}} meta
 */
export function runBegin(root, meta) {
  const manifest = {
    schemaVersion: '1.0.0',
    runId: `run-${randomUUID().slice(0, 12)}`,
    taskId: meta.taskId,
    parentRunId: meta.parentRunId ?? null,
    changeSetId: meta.changeSetId ?? null,
    humanInitiator: meta.initiator ?? 'unknown',
    agentRole: meta.agentRole ?? 'main',
    // 内部任务-256（H9）：审计事实单源——plugin 版本读 plugin.manifest.json；host 显式优先/环境探测/unknown
    client: { host: hostOf({ host: meta.clientHost }), plugin: pluginRef() },
    model: meta.model ?? { observation: 'unavailable' },
    policy: meta.policyRef ?? null,
    contexts: [],
    evidenceReferences: [],
    attribution: 'AI-assisted',
    reproducibility: { grade: 'evidence-only' },
    resources: { tokens: { value: null, measurement: 'unavailable' },
                 cost: { value: null, measurement: 'unavailable' },
                 latencyMs: { value: null, measurement: 'unavailable' } },
    startedAt: new Date().toISOString(),
    status: 'open',
  };
  mkdirSync(runsDir(root), { recursive: true });
  atomicWriteJson(manifestPath(root, manifest.runId), manifest);
  return manifest;
}

/**
 * runId 合法形态（2026-09-19 评审修复，安全面 N）：与 runBegin 生成形态
 * `run-${randomUUID().slice(0, 12)}` 对齐（uuid 前 12 字符 = 8hex + '-' + 3hex）——
 * runId 直拼进 manifestPath，无校验时 `--run-id ../../x` 可越界读+覆写 runs 目录外 JSON。
 */
export const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{3}$/;

/** outcome 枚举（内部任务-5 C / 内部规则-4 扩义）：completed=正常完成；cancelled/failed=诚实封存。 */
export const RUN_OUTCOMES = new Set(['completed', 'cancelled', 'failed']);

/**
 * 终结 run：落不可变 manifest（integrity 哈希；redact 后落盘；秘密命中即拒绝）。
 * 内部任务-5 C：可选 outcome ∈ completed|cancelled|failed（缺省 completed；cancelled/failed
 * 必填 reason）；status 仍 finalized 且不可变——取消不得冒充成功/验收；必要释放 holder
 * 租约走既有 release 协议（调用方决定，不自动删除审计记录）。
 * @param {string} root
 * @param {string} runId
 * @param {{repoHead: string, diffDigest: string, evidenceRefs?: string[],
 *          contexts?: Array<object>, grade?: string,
 *          outcome?: 'completed'|'cancelled'|'failed', reason?: string}} final
 */
export function runFinalize(root, runId, final) {
  if (!RUN_ID_RE.test(String(runId))) {
    throw new Error(`runId 非法（收到「${runId}」，生成形态 run-<12hex>）——拒绝拼接进路径`);
  }
  const outcome = final.outcome ?? 'completed';
  if (!RUN_OUTCOMES.has(outcome)) {
    throw new Error(`outcome 非法（收到「${outcome}」，枚举 completed|cancelled|failed）`);
  }
  if (outcome !== 'completed' && (typeof final.reason !== 'string' || final.reason.trim() === '')) {
    throw new Error(`outcome=${outcome} 必填 reason（诚实封存：取消/失败须留可审计理由）`);
  }
  const path = manifestPath(root, runId);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.status === 'finalized') {
    throw new Error(`run ${runId} 已 finalize（不可变）——需要更正请开新 run 并以 parentRunId 关联`);
  }
  // 内部任务-254（H7）：--expect-hash CAS——重算当前 open body 哈希，不符即拒（manifest 在
  // begin 后被外部改动时旧 openHash 失效）；比较口径与 run-begin 的 openHash 单源。
  if (final.expectHash !== undefined) {
    const actual = manifestContentHash(manifest);
    if (actual !== String(final.expectHash)) {
      throw new Error(
        `run ${runId} 的 --expect-hash 与当前 open manifest 哈希不符（CAS 失败：期望 ${String(final.expectHash)} vs 实际 ${actual}）——finalize 前 manifest 被改动，请核对后重跑`);
    }
  }
  manifest.repositories = [{ repoId: 'main', head: final.repoHead, diffDigest: final.diffDigest }];
  manifest.contexts = final.contexts ?? manifest.contexts;
  manifest.evidenceReferences = final.evidenceRefs ?? [];
  if (final.grade) manifest.reproducibility.grade = final.grade;
  // 内部任务-254（H7）：finalized manifest 记 policy/change-set digest（供 gate stale 复核）
  if (final.policyDigest !== undefined) manifest.policyDigest = final.policyDigest;
  if (final.changeSetDigest !== undefined) manifest.changeSetDigest = final.changeSetDigest;
  manifest.outcome = outcome;
  manifest.reason = outcome === 'completed' ? (final.reason ?? null) : final.reason;
  manifest.completedAt = new Date().toISOString();
  manifest.status = 'finalized';
  const hits = scanSecrets(manifest);
  if (hits.length > 0) {
    manifest.status = 'open'; // 拒绝终结，保持可修正
    throw new Error(`manifest 含明文秘密，拒绝 finalize：${hits.join('; ')}`);
  }
  const redacted = redact(manifest);
  redacted.integrityHash = integrityHash(redacted);
  atomicWriteJson(path, redacted);
  return redacted;
}

/**
 * 读取 manifest（open/finalized 皆可读）。
 * @param {string} root
 * @param {string} runId
 */
export function loadManifest(root, runId) {
  return JSON.parse(readFileSync(manifestPath(root, runId), 'utf8'));
}

