// 文件：context-trust.mjs
// 描述：上下文信任分级（内部规则-6 / 内部需求-4 / 内部决策-013）——七级 trust；登记与检查分离：
//       untrusted/external-unverified 只作 data；高风险 run 拒无 digest 远程内容。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

export const TRUST_LEVELS = [
  'authoritative', 'repository', 'user-attested', 'generated',
  'external-verified', 'external-unverified', 'untrusted',
];

/** 不可作为 instruction 的级别（只作 data）。 */
const DATA_ONLY = new Set(['external-unverified', 'untrusted']);

/**
 * 登记一条上下文（返回带 instructionEligible 判定的条目）。
 * @param {Array<object>} contexts 登记目标数组（就地追加）
 * @param {{source: string, digest?: string|null, retrievedAt?: string|null,
 *          trust: string, sensitivity?: string}} ctx
 */
export function registerContext(contexts, ctx) {
  if (!TRUST_LEVELS.includes(ctx.trust)) {
    throw new Error(`非法信任级：${ctx.trust}（合法：${TRUST_LEVELS.join('/')}）`);
  }
  const entry = {
    source: ctx.source,
    digest: ctx.digest ?? null,
    retrievedAt: ctx.retrievedAt ?? null,
    trust: ctx.trust,
    instructionEligible: !DATA_ONLY.has(ctx.trust),
    sensitivity: ctx.sensitivity ?? 'normal',
  };
  contexts.push(entry);
  return entry;
}

/**
 * 检查上下文集合对给定风险级是否合法。
 * @param {Array<object>} contexts
 * @param {{riskLevel?: string}} opts
 * @returns {Array<{message: string}>} 诊断（空=合法）
 */
export function checkContexts(contexts, opts) {
  /** @type {Array<{message: string}>} */
  const diags = [];
  const high = opts.riskLevel === 'high';
  for (const c of contexts) {
    if (!c.instructionEligible) {
      diags.push({ message: `上下文 ${c.source}（${c.trust}）不可作为 instruction——已按 data 降级；若流程将其置于指令位即违例` });
    }
    if (high && String(c.source).startsWith('web:') && !c.digest) {
      diags.push({ message: `高风险 run 的远程内容缺 digest：${c.source}（无内容锚即不可判真）` });
    }
    if (high && String(c.source).startsWith('web:') && !c.retrievedAt) {
      diags.push({ message: `高风险 run 的远程内容缺 retrievedAt：${c.source}` });
    }
  }
  return diags;
}
