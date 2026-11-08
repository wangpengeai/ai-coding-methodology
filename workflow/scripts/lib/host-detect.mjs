// 文件：host-detect.mjs
// 描述：内部模块-15 v2 宿主 token 探测**单源**（内部规则-13 / 内部决策-063 修正案 3 决策 19，2026-10-24
//       内部任务-195）——租约审计 host 维（task-lease-lib）与会话就绪面宿主 token（session-start）
//       共用同一张前缀表，禁止各自维护第二张探测表（内部未决-189 实证：两套探测在 Kimi/MCode
//       下会得出 zcode/unknown 的分裂结论，同一条审计记录与就绪面互相矛盾）。
//       表序即优先级：`DSH_` → `KIMI_` → `MCODE_` → `ZCODE_`。**ZCode 必须末位**——Kimi/MCode
//       的 hook shim 会向被 spawn 的钩子注入 `ZCODE_PLUGIN_ROOT`/`ZCODE_PROJECT_DIR`，ZCode
//       插件根环境在每次钩调用都在场；若排在前面，Kimi/MCode 会话会被整面误判成 zcode。
//       判据＝「前缀存在且值非空」（空串视同未设置：空串变量会屏蔽宿主锚，使 spawn 环境与
//       无变量环境跨进程分叉，内部任务-31/2026-10-09 先例）；不取具体值（避免把宿主版本/路径
//       当标识）。未知 ⇒ `unknown`（保守面：就绪面按镜像缺省降级，租约审计照记）。
//       纯函数、零 IO、零副作用：`meta` 与 `env` 都可注入（测试不污染 process.env）。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 用法：被 `hooks/task-lease-lib.mjs`（再导出给各钩）与 `hooks/session-start.mjs` 消费。

/**
 * 宿主 token → 环境前缀表（表序即优先级；冻结防消费方就地改序）。
 * 新增宿主＝在本表追加一行（且排在 ZCODE_ 之前），并同批更新 内部接口-1 能力登记与镜像。
 */
export const HOST_ENV_PREFIXES = Object.freeze([
  ['dsh', 'DSH_'],
  ['kimi', 'KIMI_'],
  ['mcode', 'MCODE_'],
  ['zcode', 'ZCODE_'],
]);

/**
 * 宿主标识三态（本仓口径：四宿主 + unknown）：显式 `meta.host` 非空字符串优先（审计字段以
 * 显式声明为准），否则按 {@link HOST_ENV_PREFIXES} 表序探测首个「存在且值非空」的前缀。
 * @param {{host?: unknown}} [meta] 签发侧元信息（宿主可观察的显式标识）
 * @param {Record<string, string|undefined>} [env] 环境视图（缺省 process.env；测试可注入）
 * @returns {string} 宿主标识（缺省 'unknown'）
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
