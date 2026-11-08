// 文件：kimi-code-adapter/src/engine-files.mjs
// 描述：引擎随包物化的闭包清单（内部决策-038 决策 7；复刻 mcode listEngineFiles 口径）：
//       `plugin-core/{degradation-rules.json, capability-matrix.json}` + `src/*.mjs`
//       （`engine.mjs` 与其静态 import 成员，**含 `materialize.mjs` 等非运行期成员**）
//       + `src/strategies/*.mjs`（六族）。**口径诚实**：这是 import 图的**超集**（目录枚举的
//       代价＝上游新增 `src/` 文件会自动随包出货），由测试的「import 图 ⊆ 清单」断言守住
//       **必需面**、`verify` 的 sha256 逐文件对拍 + 装载探针守住**一致性**与**可装载性**。
//       目录层级复刻上游，使 `loadEngine(<包根>)` 的 `join(repoRoot,'plugin-core',file)`
//       算式在包内成立（运行期 shim 从包内装载）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 引擎闭包清单（包内相对路径 → 字节）。
 * @param {string} repoRoot 仓库根（plugin-core 的父目录）
 * @returns {{rel: string, bytes: Buffer}[]}
 */
export function listEngineFiles(repoRoot) {
  const coreDir = join(repoRoot, 'plugin-core');
  const out = [];
  // 只拒文件级链接：`plugin-core` 根目录本身允许是链接（仓内夹具与 --repo-root 合法场景），
  // 但闭包内的文件不得是链接（防站外内容被物化进包）。
  const readEngineFile = (abs, rel) => {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`引擎闭包含符号链接：${rel}`);
    return readFileSync(abs);
  };
  for (const name of ['degradation-rules.json', 'capability-matrix.json']) {
    out.push({ rel: `plugin-core/${name}`, bytes: readEngineFile(join(coreDir, name), `plugin-core/${name}`) });
  }
  const srcDir = join(coreDir, 'src');
  if (lstatSync(srcDir).isSymbolicLink()) throw new Error('引擎闭包含符号链接目录：plugin-core/src');
  const strategyDir = join(srcDir, 'strategies');
  if (lstatSync(strategyDir).isSymbolicLink()) throw new Error('引擎闭包含符号链接目录：plugin-core/src/strategies');
  for (const name of readdirSync(srcDir).filter((n) => n.endsWith('.mjs')).sort()) {
    out.push({ rel: `plugin-core/src/${name}`, bytes: readEngineFile(join(srcDir, name), `plugin-core/src/${name}`) });
  }
  for (const name of readdirSync(strategyDir).filter((n) => n.endsWith('.mjs')).sort()) {
    out.push({ rel: `plugin-core/src/strategies/${name}`, bytes: readEngineFile(join(strategyDir, name), `plugin-core/src/strategies/${name}`) });
  }
  return out;
}
