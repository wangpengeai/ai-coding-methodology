// 文件：policy.mjs
// 描述：Model & Capability Policy preflight（内部规则-5 / 内部需求-3）——纯函数：
//       输入策略与观察到的模型事实，输出 allow / warning / deny / violation。
//       不可观察模型：strict=deny、relaxed=warning（残余风险留痕由调用方记录）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

/**
 * @param {{riskLevel?: string, allowedModels: Array<{provider: string, capabilities: string[]}>,
 *          fallbacks?: Array<{provider: string, capabilities: string[]}>,
 *          enforcement?: 'strict'|'relaxed'}} policy
 * @param {{modelObserved: {provider: string, capabilities: string[]}|null,
 *          requiredCapability?: string}} obs
 * @returns {{decision: 'allow'|'warning'|'deny'|'violation', reason: string}}
 */
export function preflight(policy, obs) {
  const required = obs.requiredCapability ?? 'code';
  if (!obs.modelObserved) {
    return policy.enforcement === 'strict'
      ? { decision: 'deny', reason: '模型身份不可观察（IF-HOST-2：unavailable）且策略为 strict——宁可拒绝不猜测' }
      : { decision: 'warning', reason: '模型身份不可观察；relaxed 策略放行但留残余风险（归因降级）' };
  }
  const primary = policy.allowedModels.find((m) => m.provider === obs.modelObserved.provider);
  const isFallback = !primary && (policy.fallbacks ?? []).some((m) => m.provider === obs.modelObserved.provider);
  const matched = primary ?? (policy.fallbacks ?? []).find((m) => m.provider === obs.modelObserved.provider);
  if (!matched) {
    return { decision: 'deny', reason: `provider ${obs.modelObserved.provider} 不在允许集` };
  }
  if (isFallback) {
    // fallback 权限不得高于主档（内部决策-012 决策）
    const maxPrimary = Math.max(...policy.allowedModels.map((m) => m.capabilities.length), 0);
    if (matched.capabilities.length > maxPrimary) {
      return { decision: 'violation', reason: `fallback 权限（${matched.capabilities.length} 项）高于主档上限（${maxPrimary}）——策略配置违例` };
    }
  }
  if (!matched.capabilities.includes(required)) {
    return { decision: 'deny', reason: `模型缺必需能力 ${required}（具备：${matched.capabilities.join(',')}）` };
  }
  return { decision: 'allow', reason: `provider=${matched.provider} 能力满足（${isFallback ? 'fallback 档' : '主档'}）` };
}
