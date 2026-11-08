// 文件：zcode-adapter/src/verify.mjs
// 描述：七面核对装配（内部决策-035 决策 3；F7＝内部任务-275/内部未决-154）——F1 仓库源期望树（事实源）→ F2 市场源
//       → F3 派生镜像 → F4 cache 登记版本目录 → F5 登记表双读（version == plugin.json@installPath.version，
//       禁存在性断言）→ F6 config 启用 → F7 市场注册面（known_marketplaces 指向与本次核对源一致）。
//       版本流四处同版（repo 清单 → 市场清单 → 登记表 → cache 目录名）为断言面；installPath 尾分隔符
//       在比较侧归一容忍。F7 仅 verify CLI 口径计入 problems/退出码——install 写后即验经
//       registrationFace:false 豁免（注册态非 install 写面产物，由 install 尾印承载）。只读，不落任何盘。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGINS, MARKET_ID, clientPath } from './manifests.mjs';
import { tryBuildExpectTree, diffTrees, treeHashOfEntries } from './expect-tree.mjs';
import { readClientState, normalizePathTail, readMarketplaceRegistration } from './client-state.mjs';

/** 面结果工厂。 */
function mkFace(id) {
  return { face: id, ok: true, missing: [], extra: [], changed: [], problems: [] };
}

/** 树三分类结果按插件前缀收进面（F2/F3/F4 三处同构收口）。 */
function applyTreeDiff(face, plugin, d) {
  for (const r of d.missing) face.missing.push(`${plugin}/${r}`);
  for (const r of d.extra) face.extra.push(`${plugin}/${r}`);
  for (const r of d.changed) face.changed.push(`${plugin}/${r}`);
}

/**
 * 七面核对主入口。
 * @param {{repoRoot: string, marketRoot: string, zcodeHome: string, registrationFace?: boolean}} input 输入
 *   （registrationFace 缺省 true＝F7 问题计入 problems/退出码；install 写后即验传 false 豁免计入）
 * @returns {{faces: object[], problems: string[], treeHashes: object}} 报告（problems 为计入面料的扁平清单）
 */
export function runVerify({ repoRoot, marketRoot, zcodeHome, registrationFace = true }) {
  const f1 = mkFace('F1');
  const f2 = mkFace('F2');
  const f3 = mkFace('F3');
  const f4 = mkFace('F4');
  const f5 = mkFace('F5');
  const f6 = mkFace('F6');
  const f7 = mkFace('F7');

  // ── F1：仓库源期望树（事实源）与 repo 清单版本 ──
  const repoTrees = {};
  const repoVersions = {};
  for (const p of PLUGINS) {
    const dir = join(repoRoot, p);
    if (!existsSync(dir)) {
      f1.problems.push(`仓库源目录缺失：${p}`);
      continue;
    }
    const t1 = tryBuildExpectTree(dir);
    if (t1.problem) {
      f1.problems.push(t1.problem); // 内部任务-276 D4：读面失败折叠为面红（不抛）
      continue;
    }
    repoTrees[p] = t1.tree;
    try {
      repoVersions[p] = JSON.parse(readFileSync(join(dir, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    } catch (e) {
      f1.problems.push(`仓库清单不可读：${p}（${e.message}）`);
    }
  }

  // ── 市场清单（F2 的版本锚与 F3 的镜像比对基准）──
  const marketManifestFile = join(marketRoot, 'marketplace.json');
  let marketManifest = null;
  try {
    marketManifest = JSON.parse(readFileSync(marketManifestFile, 'utf8'));
  } catch (e) {
    f2.problems.push(`市场清单不可读：${marketManifestFile}（${e.message}）`);
  }
  const marketEntry = (p) => (marketManifest && Array.isArray(marketManifest.plugins) ? marketManifest.plugins.find((e) => e.name === p) ?? null : null);

  // ── F2：市场源 plugins/<p> vs 期望树 + 清单条目版本 ──
  const marketTrees = {};
  for (const p of PLUGINS) {
    if (!repoTrees[p]) {
      // 评审 data-integrity：上游 F1 读面失败导致本插件未核对时，不得以 ok 呈现「已核对」
      f2.problems.push(`未核对：F1 源树不可读（${p}）`);
      continue;
    }
    const dir = join(marketRoot, 'plugins', p);
    if (!existsSync(dir)) {
      f2.problems.push(`市场源目录缺失：${p}`);
      continue;
    }
    const t2 = tryBuildExpectTree(dir);
    if (t2.problem) {
      f2.problems.push(t2.problem);
      continue;
    }
    marketTrees[p] = t2.tree;
    applyTreeDiff(f2, p, diffTrees(repoTrees[p], marketTrees[p]));
    const ent = marketEntry(p);
    if (!ent) f2.problems.push(`市场清单缺条目：${p}`);
    else if (repoVersions[p] !== undefined && ent.version !== repoVersions[p]) {
      f2.problems.push(`市场清单版本失配：${p}（清单 ${ent.version} ≠ repo ${repoVersions[p]}）`);
    }
  }

  // ── F3：派生镜像 vs 市场源（清单逐字 + 六插件树）──
  const mirrorRoot = join(clientPath(zcodeHome, 'marketplaces'), MARKET_ID);
  const mirrorTrees = {};
  const mirrorManifestFile = join(mirrorRoot, 'marketplace.json');
  if (!existsSync(mirrorManifestFile)) {
    f3.problems.push(`镜像清单缺失：marketplace.json（${mirrorRoot}）`);
  } else if (marketManifest) {
    // 内部任务-276 D5：此前裸 readFileSync——EACCES/EISDIR 穿透崩溃（同函数 F1/F2/F5 均 try 落面红）
    try {
      if (readFileSync(mirrorManifestFile, 'utf8') !== readFileSync(marketManifestFile, 'utf8')) {
        f3.problems.push('镜像清单与市场源清单非逐字一致：marketplace.json');
      }
    } catch (e) {
      f3.problems.push(`镜像清单不可读：${mirrorManifestFile}（${e.message}）`);
    }
  }
  for (const p of PLUGINS) {
    if (!marketTrees[p]) {
      if (repoTrees[p]) f3.problems.push(`未核对：上游 F2 市场树不可用（${p}）`); // 评审 data-integrity：不得以 ok 呈现未核对
      continue;
    }
    const dir = join(mirrorRoot, 'plugins', p);
    if (!existsSync(dir)) {
      f3.problems.push(`镜像插件目录缺失：${p}`);
      continue;
    }
    const t3 = tryBuildExpectTree(dir);
    if (t3.problem) {
      f3.problems.push(t3.problem);
      continue;
    }
    mirrorTrees[p] = t3.tree;
    applyTreeDiff(f3, p, diffTrees(marketTrees[p], mirrorTrees[p]));
  }

  // ── 客户端状态（解析失败落 F5/F6 面，不抛）──
  const state = readClientState(zcodeHome);
  for (const prob of state.problems) {
    if (prob.target === 'registry') f5.problems.push(prob.text);
    else f6.problems.push(prob.text);
  }
  const registryEntry = (p) =>
    state.registry && Array.isArray(state.registry.plugins)
      ? state.registry.plugins.find((e) => e.name === p && e.marketplace === MARKET_ID) ?? null
      : null;

  // ── F4：cache 登记版本目录 vs 市场源；F5：登记表双读与版本四方一致 ──
  const cacheRoot = join(clientPath(zcodeHome, 'cache'), MARKET_ID);
  const cacheTrees = {};
  for (const p of PLUGINS) {
    if (!marketTrees[p]) {
      if (repoTrees[p]) f5.problems.push(`未核对：上游 F2 市场树不可用（${p}）`); // 评审 data-integrity
      continue;
    }
    const ent = registryEntry(p);
    if (!ent) {
      f5.problems.push(`登记表缺条目：${p}`);
      continue;
    }
    // F5 先行（不依赖 cache 目录存在）：登记版本 ↔ 市场清单 + installPath 末段 + 双读
    const mEnt = marketEntry(p);
    if (mEnt && String(ent.version) !== String(mEnt.version)) {
      f5.problems.push(`登记版本与市场清单失配：${p}（${ent.version} ≠ ${mEnt.version}）`);
    }
    const ip = normalizePathTail(String(ent.installPath ?? ''));
    const lastSeg = ip.split(/[\\/]/).pop();
    if (lastSeg !== String(ent.version)) {
      f5.problems.push(`installPath 末段非登记版本：${p}（末段 ${lastSeg} ≠ ${ent.version}）`);
    }
    try {
      const m = JSON.parse(readFileSync(join(ip, '.zcode-plugin', 'plugin.json'), 'utf8'));
      if (String(m.version) !== String(ent.version)) {
        f5.problems.push(`双读失配：${p}（登记 ${ent.version} ≠ installPath 清单 ${m.version}）`);
      }
    } catch (e) {
      f5.problems.push(`installPath 清单不可读：${p}（${e.message}）`);
    }
    // F4：cache 登记版本目录 vs 市场源
    const dir = join(cacheRoot, p, String(ent.version));
    if (!existsSync(dir)) {
      f4.missing.push(`${p}@${ent.version}`);
      f4.problems.push(`cache 登记版本目录缺失：${p}@${ent.version}`);
      continue;
    }
    const t4 = tryBuildExpectTree(dir);
    if (t4.problem) {
      f4.problems.push(t4.problem);
      continue;
    }
    cacheTrees[p] = t4.tree;
    applyTreeDiff(f4, p, diffTrees(marketTrees[p], cacheTrees[p]));
  }

  // ── F6：config.enabledPlugins 六插件启用 ──
  const enabled = state.config && state.config.plugins ? state.config.plugins.enabledPlugins : null;
  if (!enabled || typeof enabled !== 'object') {
    f6.problems.push('config.enabledPlugins 不可读');
  } else {
    for (const p of PLUGINS) {
      if (enabled[`${p}@${MARKET_ID}`] !== true) f6.problems.push(`未启用：${p}（${p}@${MARKET_ID}）`);
    }
  }

  // ── F7：市场注册面（内部未决-154）——注册缺失/指向旧路径时六面可全绿＝假绿，本面补齐该缺口 ──
  const registration = readMarketplaceRegistration({ zcodeHome, marketRoot });
  if (registration.state === 'missing') {
    f7.problems.push(`市场源未注册（id=${MARKET_ID}；${registration.note ?? ''}）——不带 --marketplace 的解析将失败或指向其他源`);
  } else if (registration.state === 'stale') {
    f7.problems.push(`注册指向与本次核对源不一致：registered=${registration.registeredPath} actual=${marketRoot}`);
  }

  // ── 汇总：ok = 四类清单全空；problems = 计入面料扁平清单（F7 受 registrationFace 门控）──
  const faces = [f1, f2, f3, f4, f5, f6, f7];
  for (const f of faces) {
    f.ok = f.problems.length === 0 && f.missing.length === 0 && f.extra.length === 0 && f.changed.length === 0;
  }
  const problems = [];
  for (const f of faces) {
    if (f === f7 && !registrationFace) continue; // F7 仍进 faces 报告但不计入 problems/退出码（round1 E1 处置）
    for (const x of [...f.problems, ...f.missing.map((r) => `缺失 ${r}`), ...f.extra.map((r) => `多余 ${r}`), ...f.changed.map((r) => `变更 ${r}`)]) {
      problems.push(`${f.face}：${x}`);
    }
  }
  const treeHashes = { repo: {}, market: {}, mirror: {}, cache: {} };
  for (const p of PLUGINS) {
    if (repoTrees[p]) treeHashes.repo[p] = treeHashOfEntries(repoTrees[p]);
    if (marketTrees[p]) treeHashes.market[p] = treeHashOfEntries(marketTrees[p]);
    if (mirrorTrees[p]) treeHashes.mirror[p] = treeHashOfEntries(mirrorTrees[p]);
    if (cacheTrees[p]) treeHashes.cache[p] = treeHashOfEntries(cacheTrees[p]);
  }
  return { faces, problems, treeHashes };
}
