// 文件：tests/helpers/engine-binding.mjs
// 描述：测试用共享绑定入口——所有需要引擎的测试文件经本 helper 与 `apply()` 走**同一** ensureBound
//       入口（避免"首条引擎面用例先于绑定"与"重复绑定抛错"互斥）；绑定真实仓引擎（幂等）。
// 作者：wangp  创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：import { testEngine } from './helpers/engine-binding.mjs'
// 自检：随引用方测试
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureBound } from '../../src/engine-binding.mjs';
import { resolveEngine } from '../../src/engine-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根（tests/helpers → tests → ai-coding-methodology → 仓库根）。 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * 取测试用引擎（首次调用解析真实仓引擎并绑定，后续复用同一实例）。
 * @returns {object} 引擎实例（含 `applyRule`）
 */
export function testEngine() {
  return ensureBound(() => resolveEngine({ repoRootOverride: REPO_ROOT }));
}
