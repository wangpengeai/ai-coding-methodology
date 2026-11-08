// 文件：kimi-code-adapter/src/assets.mjs
// 描述：资产面——把六插件目录**只读**地枚举成"物化计划"（逐文件相对路径；sha256 由核账消费方按需计算），
//       并在安装期落盘。三条纪律：
//       ① 单向只读：只读源、只写宿主数据目录，永不写回六插件（内部决策-038 决策 1；
//          sha256/mtime 前后全等不变量进 install 测试）；
//       ② 排除面：`.zcode-plugin/`（ZCode 清单，由 kimi.plugin.json 取代）、`node_modules/`
//          （本地产物）、`hooks/hooks.json`（声明面只留 kimi.plugin.json 一份事实源——
//          说明：钩子脚本以中立清单为准，仅在清单缺失/损坏时回落读 hooks.json（正常
//          路径不触发）；接线自检在包内因无该文件而跳过——登记于 README「已知限制」），以及**构建缓存本地产物**
//          （`__pycache__`/`.mimosa` 段、`*.pyc` 末段，口径同 `zcode-adapter` 的 `IGNORED`）。
//          其余**整目录照搬**（含测试目录）：照搬规则足够简单，不会"顺手排除"掉某个运行时
//          依赖（spec-gate 的 `core/`、`assurance/` 就靠这条规则完整落进包）；构建缓存例外
//          **不**出于洁癖，而是可核账的前提——`.pyc` 两侧各编译一次、字节必然不同，装进去
//          会让 `verify` 结构性报红（内部任务-55 基线证据，与 mcode 侧同因同修）。
//       ③ 无图标需求：Kimi iconUrl 可选，本层不做 PNG 生成（MCode 特有件不搬）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §3/§5
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 源目录里不物化的顶层项（`.zcode-plugin` 由 kimi.plugin.json 取代；`node_modules` 是本地产物；
 *  `agents` 仅在 --with-agents 时以宿主形态物化（词表映射后），源形态永不直落包——B-ka-6）。 */
export const EXCLUDED_TOP_LEVEL = Object.freeze(['.zcode-plugin', 'node_modules', 'agents']);

/** 源目录里不物化的具体文件（声明面只留 kimi.plugin.json 一份事实源；运行时读取已 grep 取证为无）。 */
export const EXCLUDED_RELS = Object.freeze(['hooks/hooks.json']);

/** 本地产物目录段（构建缓存，非资产）：命中即整棵剪枝。 */
const LOCAL_ARTIFACT_DIRS = Object.freeze(['__pycache__', '.mimosa']);

/**
 * 本地产物判定——口径与 `zcode-adapter/src/expect-tree.mjs` 的 `IGNORED(rel)` 逐字同款
 * （内部任务-PYCLEAN-1，与 `spec-gate/assurance/probes.mjs` 的 `DEFAULT_IGNORE` 互见）：
 * 任一路径段为 `__pycache__`/`.mimosa`，或末段匹配 `*.pyc`；win32 下大小写归一。
 *
 * 计划侧（枚举）与 `verify` 的「多余」走查侧**必须同用本谓词**：只剪计划侧，已装包内的
 * 历史残留会被永久计为多余（内部任务-55 在 mcode 侧实测即此形态，本层同源同修）。
 *
 * 移植说明：本仓共四份同款谓词（zcode `expect-tree.mjs` 的 `IGNORED`、mcode `assets.mjs`
 * 的 `isLocalArtifact`、kimi 本件、`spec-gate/assurance/probes.mjs` 的 `DEFAULT_IGNORE` 口径）。**上收 `plugin-core` 的路线已评估
 * 但本批不采**——适配层本就依赖 plugin-core（`cli.mjs` 动态导入其引擎），技术上可行；不采的理由
 * 是收益/代价比不足。该取舍**可被后续批推翻**，记录见计划
 * `内部计划`「拆分论证」段。
 * @param {string} rel 包内相对路径（posix 分隔）
 * @returns {boolean} 是本地产物则 true
 */
export function isLocalArtifact(rel) {
  const parts = rel.split('/');
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (parts.some((p) => LOCAL_ARTIFACT_DIRS.includes(norm(p)))) return true;
  return norm(parts[parts.length - 1]).endsWith('.pyc');
}

/**
 * 逐文件枚举一个插件目录（返回包内相对路径，排序保证确定性）。
 * 字节与 sha256 由消费方按需计算：生产安装链只需一次 `readFileSync`，核账在测试侧用 `sha256OfFile`。
 * @param {string} sourceRoot 插件源根
 * @returns {string[]} 包内相对路径（posix 分隔，字典序）
 */
export function listSourceFiles(sourceRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(sourceRoot, abs).split(sep).join('/');
      // 排除面优先：被排除项（.zcode-plugin/node_modules/agents、构建缓存）无论何种形态
      // 都不物化，因而不该阻断安装；只有「会被物化的内容」才是链接拒装面。
      if (rel.split('/').length === 1 && EXCLUDED_TOP_LEVEL.includes(name)) continue;
      if (isLocalArtifact(rel)) continue; // `__pycache__`/`.mimosa` 段：整棵剪枝
      if (EXCLUDED_RELS.includes(rel)) continue;
      const stat = lstatSync(abs);
      // 符号链接不跟随：链到站外会把内容原样物化进包（mcode 同款拒面）；
      // 源侧出现链接即拒装，由 planPackage 捕获为 problem。
      if (stat.isSymbolicLink()) throw new Error(`源资产含符号链接：${rel}`);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue; // 非常规条目：源侧本仓不该有，宿主安全模型另有包根内判据兜底
      out.push(rel);
    }
  };
  walk(sourceRoot);
  return out.sort();
}

/**
 * 文件 sha256（十六进制）。测试核账与源指纹使用；生产安装链不消费。
 * @param {string} path 文件路径
 * @returns {string}
 */
export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
