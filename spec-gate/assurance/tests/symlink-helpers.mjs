// 文件：symlink-helpers.mjs
// 描述：测试面符号链接创建统一入口（内部任务-241 T09/步骤17）：非提权 win32 等平台无法创建
//       symlink 时以 `t.skip` 如实跳过，而不是让整条测试红成环境噪音（core 测试侧 t.skip 同款）。
// 纪律：仅测试辅助；不改变生产路径。
import { symlinkSync } from 'node:fs';

/**
 * 尝试创建符号链接；失败时调用 t.skip 并返回 false（调用方应立即 return）。
 * @param {import('node:test').TestContext} t 测试上下文（须来自 test('…', (t) => …)）
 * @param {string} target 链接目标
 * @param {string} linkPath 链接位置
 * @returns {boolean}
 */
export function trySymlink(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (e) {
    t.skip(`当前平台不支持创建符号链接（${e.code ?? e.message}）——按环境能力跳过`);
    return false;
  }
}
