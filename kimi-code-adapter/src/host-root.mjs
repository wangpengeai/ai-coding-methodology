// 文件：kimi-code-adapter/src/host-root.mjs
// 描述：宿主根（KIMI_CODE_HOME）三级探测（内部决策-038 决策 7；硬规则 10 探测回退家法）：
//       显式 --data-dir > KIMI_CODE_HOME 环境变量 > 本平台标准位置
//       （win32 %USERPROFILE%\.kimi-code；darwin/posix ~/.kimi-code）> 返回空串由调用方 fail-loud。
//       探测只读环境，不创建任何目录；测试一律 --data-dir 指向 tmp，绝不触真机宿主目录。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.7/§5
import { resolve } from 'node:path';

/**
 * 解析宿主根。`platform` 为注入缝（测试用），默认 process.platform。
 * @param {string} flag 显式 --data-dir（空串即按环境推导）
 * @param {Record<string, string|undefined>} [env] 环境（注入缝）
 * @param {string} [platform] 平台（注入缝；'win32' 用 USERPROFILE，其余用 HOME）
 * @returns {string} 宿主根绝对路径；无法推导返回空串（调用方 fail-loud）
 */
export function resolveHostRoot(flag, env = process.env, platform = process.platform) {
  if (flag) return resolve(flag);
  if (typeof env.KIMI_CODE_HOME === 'string' && env.KIMI_CODE_HOME.trim() !== '') return resolve(env.KIMI_CODE_HOME);
  const home = platform === 'win32' ? env.USERPROFILE || env.HOME || '' : env.HOME || '';
  return home === '' ? '' : resolve(home, '.kimi-code');
}
