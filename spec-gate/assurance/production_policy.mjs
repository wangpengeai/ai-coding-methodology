// 文件：production_policy.mjs
// 描述：production_policy.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1b）——条件门禁推导
//       与四层 claim 裁决（内部决策-010/011 / 内部规则-4/5）。纯函数（零 IO 零时钟）；
//       诊断归调用方映射退出码。bug-for-bug 复刻。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { ProductionValueError, validateProfile, validateWaiver } from './production_model.mjs';

export const GATE_DOMAINS = [
  'pr-ci', 'artifact', 'security', 'privacy-secrets', 'supply-chain',
  'environment-promotion', 'deploy-authorization', 'migration',
  'observation-slo', 'user-acceptance', 'rollback-followup', 'recovery-dr',
];

const IMPACT_UPGRADES = {
  config: new Set(['environment-promotion']),
  infra: new Set(['environment-promotion', 'deploy-authorization']),
  dependency: new Set(['supply-chain']),
  security: new Set(['security', 'privacy-secrets']),
  privacy: new Set(['privacy-secrets']),
  migration: new Set(['migration']),
  schema: new Set(['migration']),
};

const CLAIM_DOMAINS = {
  'code-complete': new Set(),
  'merge-ready': new Set(['pr-ci']),
  'production-ready': new Set(['pr-ci', 'artifact', 'security', 'privacy-secrets', 'supply-chain', 'environment-promotion', 'deploy-authorization', 'rollback-followup']),
  'production-accepted': new Set(GATE_DOMAINS),
};

/**
 * 推导十二域处置：mode ∈ required/not-applicable（带 reason）。impact 只抬不降。
 * @param {Record<string, unknown>} profile @param {Iterable<string>} impacts
 * @returns {Record<string, {mode: string, reason: string}>}
 */
export function resolveRequirements(profile, impacts) {
  const [ok, reason] = validateProfile(profile);
  if (!ok) throw new ProductionValueError(`profile 非法：${reason}`);
  const upgraded = new Set();
  for (const impact of impacts) {
    // 原型链键（'toString' 等）在 Python dict.get 得空集；JS 普通对象属性会取到函数（门① N8）。
    const domains = Object.hasOwn(IMPACT_UPGRADES, impact) ? IMPACT_UPGRADES[impact] : new Set();
    for (const d of domains) upgraded.add(d);
  }

  const hosting = ['service', 'web', 'mobile', 'desktop', 'data-pipeline', 'plugin', 'package', 'infrastructure'].includes(profile.deliveryKind)
    || ['container', 'managed-runtime'].includes(profile.distribution);
  const userFacing = ['public', 'authenticated'].includes(profile.exposure)
    || ['customer', 'regulated-approver'].includes(profile.acceptanceAuthority);
  const hasState = profile.persistentState !== 'none';
  const tier = profile.availabilityTier ?? 'none';
  const recovery = profile.recoveryTier ?? 'none';
  const dataClasses = new Set(profile.dataClasses ?? []);

  const gate = (mode, why) => ({ mode, reason: why });
  const gates = {
    'pr-ci': gate(profile.scm.prRequired ? 'required' : 'not-applicable',
      profile.scm.prRequired ? 'PR/CI 必检' : '项目声明无 PR 门（单人流）'),
    artifact: gate(profile.distribution !== 'none' ? 'required' : 'not-applicable',
      profile.distribution !== 'none' ? '分发物须 digest/provenance' : '纯源码交付：tag/归档 digest 归 rollback 域核验'),
    security: gate(
      profile.exposure === 'public' || upgraded.has('security') ? 'required' : 'not-applicable',
      profile.exposure === 'public' || upgraded.has('security') ? '公网暴露或 security impact' : '内部/本地暴露且无安全影响面（升级条件：exposure=public 或 impact=security）'),
    'privacy-secrets': gate(
      (dataClasses.has('personal') || dataClasses.has('sensitive') || dataClasses.has('regulated')
        || profile.secretUse !== 'none' || upgraded.has('privacy')) ? 'required' : 'not-applicable',
      (dataClasses.has('personal') || dataClasses.has('sensitive') || dataClasses.has('regulated')
        || profile.secretUse !== 'none') ? '涉个人/敏感数据或使用凭据' : '无敏感数据且不使用凭据'),
    'supply-chain': gate(
      ['registry', 'artifact', 'container', 'app-store'].includes(profile.distribution) ? 'required' : 'not-applicable',
      ['registry', 'artifact', 'container', 'app-store'].includes(profile.distribution) ? '对外分发物须 SBOM/漏洞策略' : '不分发第三方可获取制品'),
    'environment-promotion': gate(
      (hosting || ['registry', 'artifact', 'app-store'].includes(profile.distribution)) && (profile.environments ?? []).length > 1 ? 'required' : 'not-applicable',
      (hosting || ['registry', 'artifact', 'app-store'].includes(profile.distribution)) ? '多环境/多目标晋级须逐级证据' : '非托管服务：无环境晋级语义'),
    'deploy-authorization': gate(hosting ? 'required' : 'not-applicable',
      hosting ? '生产副作用须人工授权' : '非托管服务：无部署动作'),
    migration: gate(
      hasState || upgraded.has('migration') ? 'required' : 'not-applicable',
      hasState ? '有持久化状态' : '无持久化状态（升级条件：impact=migration/schema）'),
    'observation-slo': gate(
      hosting && ['standard', 'critical'].includes(tier) ? 'required' : 'not-applicable',
      hosting ? '标准/关键可用性档须观测窗口与 SLI/SLO' : '非托管服务：安装后健康检查归 rollout 域'),
    'user-acceptance': gate(userFacing ? 'required' : 'not-applicable',
      userFacing ? '面向用户或验收权在客户/监管' : '验收权在 owner：技术验收即可'),
    'rollback-followup': gate('required', '回滚/缓解预案必检（所有 profile）'),
    'recovery-dr': gate(
      ['backup-restore', 'warm-standby', 'multi-site'].includes(recovery) ? 'required' : 'not-applicable',
      recovery !== 'none' ? `恢复档位 ${recovery} 须演练证据` : '无托管持久服务：无 DR 义务'),
  };
  for (const domain of upgraded) {
    if (domain in gates && gates[domain].mode === 'not-applicable') {
      gates[domain] = { mode: 'required', reason: `change impact 临时升级（${domain}）` };
    }
  }
  return gates;
}

const SUBJECT_REQUIREMENTS = {
  'merge-ready': [['commitSha', 'merged commit SHA'], ['prHead', 'PR head SHA']],
  'production-ready': [['commitSha', 'merged commit SHA'], ['artifactDigest', '不可变制品 digest'], ['environment', '目标环境'], ['deployAuthorizedBy', '人工部署授权人']],
  'production-accepted': [['commitSha', 'merged commit SHA'], ['artifactDigest', '不可变制品 digest'], ['deployedAt', '部署证据时间'], ['observationWindow', '观测窗口结论'], ['uatEvidence', 'UAT 证据引用']],
};

/**
 * 四层 claim 裁决：status ∈ passed/blocked/config-error＋逐域诊断（分支序与 Python 逐条一致）。
 * @param {Record<string, unknown>|null} profile @param {string} claim
 * @param {Record<string, Record<string, unknown>>} gateStates @param {Record<string, unknown>} change
 * @returns {{status: string, claim?: string, note?: string, diagnostics: Array<object>}}
 */
export function assessClaim(profile, claim, gateStates, change) {
  if (!Object.hasOwn(CLAIM_DOMAINS, claim)) {
    return { status: 'config-error', diagnostics: [{ ruleId: 'PROD-CLAIM-UNKNOWN', severity: 'blocking', message: `未知 claim 层级：${claim}` }] };
  }
  if (claim === 'code-complete') {
    return { status: 'passed', note: 'code-complete 归 IF-COLLAB-11 凭据链裁决', diagnostics: [] };
  }
  if (profile == null) {
    return { status: 'config-error', diagnostics: [{ ruleId: 'PROD-PROFILE-MISSING', severity: 'blocking', message: '生产 claim 须有 delivery profile（无 profile 不猜，ADR-010）' }] };
  }

  const diagnostics = [];

  const commit = change.commitSha;
  const prHead = change.prHead;
  if (claim === 'merge-ready' && commit && prHead && commit !== prHead) {
    diagnostics.push({ ruleId: 'PROD-SECURITY-SUBJECT', severity: 'blocking', gate: 'pr-ci', message: `PR head 与 commit 不一致（stale head）：${String(prHead).slice(0, 12)}… vs ${String(commit).slice(0, 12)}…（不可豁免）` });
  }
  if (change.scoutActive) {
    diagnostics.push({ ruleId: 'PROD-SECURITY-SCOUT', severity: 'blocking', message: 'active Scout 模式下禁止生产 claim（Safety Floor）' });
  }

  for (const [field, label] of SUBJECT_REQUIREMENTS[claim] ?? []) {
    if (!change[field]) {
      diagnostics.push({ ruleId: 'PROD-CLAIM-SUBJECT', severity: 'blocking', message: `${claim} 缺对象级必备证据：${label}（${field}）` });
    }
  }

  for (const domain of [...CLAIM_DOMAINS[claim]].sort()) {
    const state = gateStates[domain];
    if (state == null) {
      diagnostics.push({ ruleId: 'PROD-CLAIM-DOMAIN-MISSING', severity: 'blocking', gate: domain, message: `域 ${domain} 无处置状态（policy 推导与执行状态不一致）` });
      continue;
    }
    const mode = state.mode ?? 'required';
    const status = state.status ?? 'pending';
    if (mode === 'not-applicable') continue;
    if (status === 'passed') continue;
    if (status === 'waived') {
      const waiver = state.waiver ?? {};
      const [ok, why] = validateWaiver(waiver, change.changeId ?? '', change.environment ?? '');
      if (!ok) diagnostics.push({ ruleId: 'PROD-WAIVER-INVALID', severity: 'blocking', gate: domain, message: `waiver 无效：${why}` });
      continue;
    }
    diagnostics.push({ ruleId: 'PROD-CLAIM-GATE', severity: 'blocking', gate: domain, message: `域 ${domain} 状态 ${status}（要求 passed 或合法 waiver）` });
  }

  const blocking = diagnostics.filter((d) => d.severity === 'blocking');
  return { status: blocking.length > 0 ? 'blocked' : 'passed', claim, diagnostics };
}
