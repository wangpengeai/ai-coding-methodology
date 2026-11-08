// 文件：engine-binding.mjs
// 描述：引擎绑定槽（内部决策-037 期二批 2）——绑定模型的三语义：`ensureBound(resolver)` 已绑定即复用
//       （否则解析→绑定→返回；`apply()` 走此入口，同进程重复调用天然幂等）、`bindEngine(engine)`
//       同实例幂等 / **异实例即抛**（防跨引擎混用）、`getEngine()` 未绑定即具名抛错（**禁回落旧实现**）。
//       模块级单槽位是有意设计：纯函数签名零改动（28 处同进程 apply + 60 处直调点）的前提。
// 作者：wangp  创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：import { ensureBound, bindEngine, getEngine } from './engine-binding.mjs'
// 自检：node --test "tests/engine-loader.test.mjs"

/** 当前绑定的引擎实例（模块级单槽位；null ＝ 未绑定）。 */
let boundEngine = null;

/**
 * 绑定引擎实例（同实例幂等；异实例即抛）。
 * @param {object} engine 引擎实例（`loadEngine` 的返回值，须含 `applyRule`）
 * @returns {object} 绑定后的引擎实例
 */
export function bindEngine(engine) {
  if (engine === null || typeof engine !== 'object' || typeof engine.applyRule !== 'function') {
    throw new Error('engine-binding: 绑定的引擎须为含 applyRule 的对象');
  }
  if (boundEngine === null) {
    boundEngine = engine;
    return boundEngine;
  }
  if (boundEngine === engine) return boundEngine; // 同实例幂等
  throw new Error('engine-binding: 引擎已绑定为另一实例（异实例冲突；如需换引擎请在新进程内绑定）');
}

/**
 * 已绑定即复用；否则以 resolver() 解析并绑定后返回（`apply()` 的固定入口，重复调用幂等）。
 * @param {() => object} resolver 引擎解析器（如 `() => resolveEngine(...)`）
 * @returns {object} 引擎实例
 */
export function ensureBound(resolver) {
  if (boundEngine !== null) return boundEngine;
  if (typeof resolver !== 'function') throw new Error('engine-binding: ensureBound 需要 resolver 函数');
  return bindEngine(resolver());
}

/**
 * 取当前引擎实例；未绑定即具名抛错（不回落旧实现）。
 * @returns {object} 引擎实例
 */
export function getEngine() {
  if (boundEngine === null) {
    throw new Error('engine-binding: 引擎未绑定（getEngine 前须经 apply() 的 ensureBound 或测试的 bindEngine）');
  }
  return boundEngine;
}
