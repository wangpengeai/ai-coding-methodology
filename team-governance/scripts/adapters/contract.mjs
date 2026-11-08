// 文件：contract.mjs
// 描述：provider-neutral 适配信封契约（内部接口-1 / 内部决策-015）——信封校验唯一执行点：
//       适配实现的专有字段只存在于 adapter 内部；进入核心必须已是信封形态。
//       2026-10-29 内部任务-253（D2 方向 B）：补齐 内部接口-1 §2 全部必填约束（request/adapter pattern
//       且 ≤64/capability 枚举/status 枚举/summary 字符串/digest 与 subjectDigest sha256 pattern/
//       externalEffects 数组/correlation.runId 字符串）；平台专有键默认拒绝（opts.forbidPlatformKeys=false 可关）。
//       平台专有键（pull_request/github 等映射键）泄漏进 request 被拒。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

const STATUSES = new Set(['passed', 'failed', 'unverified', 'unavailable']);
const AVAILABILITIES = new Set(['available', 'unavailable', 'degraded']);
const CAPABILITIES = new Set(['ci', 'pr', 'identity', 'lease-store', 'evidence-store', 'os-observation', 'agent-eval']);

/** 平台专有键黑名单（内部接口-1 §4：泄漏即拒）。 */
const PLATFORM_KEYS = new Set([
  'pull_request', 'pullRequest', 'head_sha', 'headSha', 'installation', 'sender',
  'repository_url', 'organization', 'check_run', 'checkRun', 'deployment',
]);

const ADAPTER_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * 校验信封；返回诊断数组（空=合法）。
 * @param {unknown} env
 * @param {{forbidPlatformKeys?: boolean}} [opts] forbidPlatformKeys 缺省 true（§4.1 唯一执行点默认拒绝）
 * @returns {Array<{message: string}>}
 */
export function validateEnvelope(env, opts = {}) {
  /** @type {Array<{message: string}>} */
  const diags = [];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [{ message: '信封不是对象' }];
  const e = env;
  if (e.schemaVersion !== '1.0.0') diags.push({ message: 'schemaVersion 须为 1.0.0' });
  if (typeof e.adapter !== 'string' || !e.adapter) {
    diags.push({ message: '缺 adapter 名' });
  } else if (e.adapter.length > 64 || !ADAPTER_NAME_RE.test(e.adapter)) {
    diags.push({ message: `adapter 名非法：${e.adapter}（须匹配 ^[a-z][a-z0-9-]*$ 且 ≤64 字符）` });
  }
  if (typeof e.capability !== 'string' || !CAPABILITIES.has(e.capability)) {
    diags.push({ message: `capability 非法：${e.capability}（枚举 ${[...CAPABILITIES].join('/')}）` });
  }
  if (!e.request || typeof e.request !== 'object' || Array.isArray(e.request)) {
    diags.push({ message: '缺 request 对象（允许 {}）' });
  } else if (opts.forbidPlatformKeys !== false) {
    for (const k of Object.keys(e.request)) {
      if (PLATFORM_KEYS.has(k)) diags.push({ message: `平台专有字段「${k}」泄漏进核心 request——须在 adapter 内转换` });
    }
  }
  if (!e.result || typeof e.result !== 'object') {
    diags.push({ message: '缺 result 对象' });
  } else {
    if (!STATUSES.has(e.result.status)) diags.push({ message: `result.status 非法：${e.result.status}（枚举 ${[...STATUSES].join('/')}）` });
    if (typeof e.result.summary !== 'string') diags.push({ message: 'result.summary 须为字符串' });
    if (e.result.digest != null && (typeof e.result.digest !== 'string' || !SHA256_RE.test(e.result.digest))) {
      diags.push({ message: `result.digest 非法：${e.result.digest}（须 sha256:<64hex>）` });
    }
  }
  if (!AVAILABILITIES.has(e.availability)) diags.push({ message: `availability 非法：${e.availability}` });
  if (!Array.isArray(e.externalEffects)) diags.push({ message: 'externalEffects 须为数组（空数组显式表达零外部副作用）' });
  if (!e.correlation || typeof e.correlation !== 'object') {
    diags.push({ message: '缺 correlation' });
  } else {
    if (typeof e.correlation.runId !== 'string') diags.push({ message: 'correlation.runId 须为字符串' });
    const sd = e.correlation.subjectDigest;
    if (sd != null && (typeof sd !== 'string' || !SHA256_RE.test(sd))) {
      diags.push({ message: `correlation.subjectDigest 非法：${sd}（须 sha256:<64hex> 或 null）` });
    }
  }
  return diags;
}
