// 文件：client-info.mjs
// 描述：审计客户端事实单源（内部任务-256 H9 / 内部接口-14）——plugin 版本读 plugin.manifest.json（打包随插件落地，
//       四宿主物化均包含该文件）；host 由显式值优先、环境探测兜底。探测表序 **DSH_→KIMI_→MCODE_→ZCODE_**，
//       ZCODE_ 末位：DSH/Kimi/MCode 适配层也会注入 ZCODE_*，先判会把三宿主误判为 zcode（内部未决-189 同型）。
//       探测表是 workflow/scripts/lib/host-detect.mjs 的本地镜像（team-governance 独立打包，不得 import workflow；
//       tests/core.test.mjs 断言固定序 DSH_→KIMI_→MCODE_→ZCODE_ 防漂移）。判据与 workflow 同口径「前缀存在
//       且值真值（falsy/空串不算）」——不做 trim 归一，避免纯空白值在两仓判定分裂。零第三方依赖、零网络。
// 作者：wangp  创建：2026-10-30  版权：MIT（见 team-governance/LICENSE）
import { readFileSync } from 'node:fs';

/** 宿主 token → 环境前缀表（表序即优先级；与 workflow host-detect 同序，ZCODE_ 末位）。 */
export const HOST_ENV_PREFIXES = Object.freeze([
  ['dsh', 'DSH_'],
  ['kimi', 'KIMI_'],
  ['mcode', 'MCODE_'],
  ['zcode', 'ZCODE_'],
]);

/** CLI 参数面可接受的宿主值（含 unknown 显式声明；由探测表派生防两份手抄漂移）。 */
export const VALID_HOSTS = Object.freeze([...HOST_ENV_PREFIXES.map(([token]) => token), 'unknown']);

/**
 * 宿主标识：显式 host 非空优先；否则按表序探测首个「前缀存在且值非空」的环境变量；未知落 unknown。
 * @param {{host?: unknown}} [meta]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function hostOf(meta = {}, env = process.env) {
  const explicit = meta && typeof meta.host === 'string' && meta.host ? meta.host : '';
  if (explicit) return explicit;
  const view = env && typeof env === 'object' ? env : {};
  for (const [token, prefix] of HOST_ENV_PREFIXES) {
    if (Object.keys(view).some((k) => k.startsWith(prefix) && view[k])) return token;
  }
  return 'unknown';
}

/**
 * 插件版本（plugin.manifest.json 单源；读失败落 unknown，不冒充固定版本）。
 * @returns {string}
 */
export function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../plugin.manifest.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 审计 client.plugin 字段（`team-governance@<version>`）。 */
export function pluginRef() {
  return `team-governance@${pluginVersion()}`;
}

/** HTTP UA 形态（`team-governance/<version>`，沿用既有 `team-governance/0.1` 形态）。 */
export function pluginUa() {
  return `team-governance/${pluginVersion()}`;
}
