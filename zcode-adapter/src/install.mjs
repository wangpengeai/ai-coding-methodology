// 文件：zcode-adapter/src/install.mjs
// 描述：装机写面（S4 步骤 12，内部决策-035 决策 4/6）——写序：F2 前置闸（市场源须新鲜，不新鲜提示
//       先 publish；bootstrap 新建市场源=fresh 形态，闸按构造豁免）→ dry-run 早退（**先于备份与
//       任何写副作用**）→ 客户端状态写前解析（坏 JSON/形态损坏零写拒绝，内部任务-276 D13）＋重放旁路闸
//       （`.replay-aside` 存在即写前拒绝，零写）→ 备份三客户端文件（.bak-<时间戳>）→ cache 目标
//       版本目录落位（**仅删本次目标版本目录，旧版本目录永不删**；同版本重放：内容与市场源一致
//       即零写跳过，不一致经 staging 拷贝＋双 rename 交换，见 ② 段注释）→ 派生镜像对齐（幂等，
//       无需回滚——其正确态=与市场源一致）→ 登记表 version+installPath 原子更新（**原位替换保序**、
//       未触碰条目逐字保留、installPath 尾分隔符形态沿旧条目、同版本重放原对象复用=字节一致）→
//       config 启用补齐 → **写后即验（runVerify 七面；F7 注册面豁免计入，由完成尾印核对承载——
//       内部任务-275）**。失败回滚＝三客户端文件内存快照回写（原子写）+ 本次新建 cache 版本目录删除；
//       同版本重放目录交换成功后内容＝市场源，回滚无需恢复（内部任务-276 D12）。--bootstrap 追加新机
//       冷启动（市场源缺省 <zcode-home>/local-marketplace 创建 + known_marketplaces 注册 +
//       config 从零启用）。version 口径：缺省=市场清单条目版本；--version 仅一致性校验，不符退 2。
//       收尾区另打印钩子解释器探测行（内部未决-243 缓解面）与注册态核对提示（内部未决-163），均不阻断。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { PLUGINS, MARKET_ID, clientPath, loadManifests, VERSION_RE } from './manifests.mjs';
import { readMarketDoc, refreshMarketManifest, syncPlugins, atomicWriteText, copyFiltered, cleanupPublishBackups, renameWithRetry } from './market.mjs';
import { tryBuildExpectTree, diffTrees } from './expect-tree.mjs';
import { detectHostApp, hostPresenceLine, detectHookInterpreter, hookInterpreterLine } from './host-presence.mjs';
import { runVerify } from './verify.mjs';
import { readMarketplaceRegistration } from './client-state.mjs';

/** zcode-home 下三客户端文件路径（备份/快照/回滚面；内部未决-247③ 切 clientPath 单源）。 */
function clientFiles(zcodeHome) {
  return {
    known: clientPath(zcodeHome, 'knownMarketplaces'),
    registry: clientPath(zcodeHome, 'registry'),
    config: clientPath(zcodeHome, 'config'),
  };
}

/** 时间戳后缀（本地日期+时分秒，备份文件名用）。 */
function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 旧 installPath 的尾分隔符形态（写侧保留：实机四插件尾双分隔符、他条目无尾——按条目沿旧）。
 * @param {string} oldPath
 * @returns {string}
 */
function tailOf(oldPath) {
  const m = String(oldPath ?? '').match(/[\\/]+$/);
  return m ? m[0] : '';
}

/**
 * 装机主流程。
 * @param {{repoRoot: string, marketRoot: string, zcodeHome: string, version?: string, bootstrap?: boolean,
 *          dryRun?: boolean, verifyImpl?: (i: object) => object, out?: (s: string) => void,
 *          copyFn?: (src: string, dest: string) => void, renameFn?: (from: string, to: string) => void,
 *          warn?: (s: string) => void}} input
 * @returns {{code: number, version?: string}}
 */
export function runInstall({ repoRoot, marketRoot, zcodeHome, version, bootstrap = false, dryRun = false, verifyImpl = null, out = (s) => process.stdout.write(s), copyFn = copyFiltered, renameFn = renameSync, warn = (s) => process.stderr.write(s) }) {
  const files = clientFiles(zcodeHome);
  const ts = stamp();
  // ── 市场源解析：bootstrap 允许「缺市场源/缺清单」=fresh 形态（创建动作推迟到写序；dry-run 零写）──
  let market = marketRoot;
  let freshMarket = false;
  if (bootstrap && (!market || !existsSync(join(market, 'marketplace.json')))) {
    if (!market) market = join(zcodeHome, 'local-marketplace');
    freshMarket = true;
  }
  if (!market) {
    warn('[install] 拒绝：市场源不可解——请用 --marketplace 指定，或 --bootstrap 走冷启动。\n'); // 内部任务-276 D18：退 2 用法错通道固定（warn 缺省即 stderr，注入时可收集）
    return { code: 2 };
  }
  // ── 仓库清单（fresh 形态下 V 的来源；也供 fresh 同步）──
  const loaded = loadManifests(repoRoot);
  if (!loaded.ok) {
    out(`[install] 拒绝：${loaded.reason}\n[install] 提示：仓库态与已发布态存在差异——先 node zcode-adapter/cli.mjs publish。\n`);
    return { code: 1 };
  }
  // ── 目标版本 V ──
  let V;
  if (freshMarket) {
    V = loaded.manifests[PLUGINS[0]].version;
  } else {
    const doc = readMarketDoc(market);
    if (!doc.ok) {
      out(`[install] 拒绝：${doc.reason}\n`);
      return { code: 1 };
    }
    if (doc.doc === null || typeof doc.doc !== 'object' || Array.isArray(doc.doc)) {
      out('[install] 拒绝：市场清单顶层非对象（形态损坏）——先 node zcode-adapter/cli.mjs publish。\n');
      return { code: 1 };
    }
    if (!Array.isArray(doc.doc.plugins)) {
      // 内部任务-276 D9：readMarketDoc 只做 JSON.parse 无形态校验；plugins 非数组此前 .find 抛 TypeError
      // 穿透（本段在主 try 之前）
      out('[install] 拒绝：市场清单 plugins 非数组（形态损坏）——先 node zcode-adapter/cli.mjs publish。\n');
      return { code: 1 };
    }
    const target = PLUGINS.map((p) => doc.doc.plugins.find((e) => e.name === p)?.version);
    if (target.some((v) => v === undefined)) {
      out(`[install] 拒绝：市场清单缺六插件条目（收到版本 ${JSON.stringify(target)}）——先 publish。\n`);
      return { code: 1 };
    }
    if (new Set(target).size !== 1) {
      out(`[install] 拒绝：市场清单版本不统一（${target.join('/')}，ADR-017 要求同版）。\n`);
      return { code: 1 };
    }
    V = target[0];
  }
  // 版本形态纵深防御（内部任务-238 S9）：V 会被拼入 cache 目录路径并参与 rmSync，非三段式即拒（含市场清单来源）
  if (!VERSION_RE.test(String(V))) {
    out(`[install] 拒绝：版本须为三段式 X.Y.Z（实测 ${V}）——清单已被篡改或损坏。\n`);
    return { code: 1 };
  }
  if (version !== undefined && String(version) !== String(V)) {
    warn(`[install] 拒绝：--version ${version} 与市场清单 ${V} 不符（--version 仅作一致性校验）。\n`); // 内部任务-276 D18：退 2 用法错通道固定（warn 缺省即 stderr）
    return { code: 2 };
  }
  // ── F2 前置闸（fresh 形态豁免——市场源即将由 repo 同步构造）──
  if (!freshMarket) {
    for (const p of PLUGINS) {
      if (String(loaded.manifests[p].version) !== String(V)) {
        out(`[install] 拒绝：仓库清单 ${p}@${loaded.manifests[p].version} 与市场清单 ${V} 不一致——先 node zcode-adapter/cli.mjs publish。\n`);
        return { code: 1 };
      }
      // 内部任务-276 D10：市场目录缺失/不可读此前 ENOENT 穿透（本闸在主 try 之前）退 2；对齐 verify F2
      // 的存在性守护与读面折叠（D4），统一拒绝退 1。
      const mdir = join(market, 'plugins', p);
      if (!existsSync(mdir)) {
        out(`[install] 拒绝：市场源目录缺失：${p}——先 node zcode-adapter/cli.mjs publish。\n`);
        return { code: 1 };
      }
      const tr = tryBuildExpectTree(join(repoRoot, p));
      if (tr.problem) { out(`[install] 拒绝：${tr.problem}\n`); return { code: 1 }; }
      const tm = tryBuildExpectTree(mdir);
      if (tm.problem) { out(`[install] 拒绝：${tm.problem}\n`); return { code: 1 }; }
      const d = diffTrees(tr.tree, tm.tree);
      if (d.missing.length || d.extra.length || d.changed.length) {
        out(`[install] 拒绝：市场源对仓库不新鲜（${p}：缺失 ${d.missing.length} / 多余 ${d.extra.length} / 变更 ${d.changed.length}）——先 node zcode-adapter/cli.mjs publish。\n`);
        return { code: 1 };
      }
    }
  }
  // ── dry-run 早退（先于备份与任何写副作用；bump dry-run 同款零写口径）──
  if (dryRun) {
    out(`[install] dry-run 计划：${freshMarket ? `bootstrap 市场源创建/同步：${market}；` : ''}cache 六插件 @ ${V} 落位（旧版本目录不动）；镜像对齐；登记表 version→${V}（原位保序）；config 六键启用。\n`);
    out('[install] dry-run：未写入、未验证\n');
    return { code: 0, version: V };
  }
  // ── 内存快照（回滚面；文件不存在记 null=回滚时删除新建文件）＋写前解析（内部任务-276 D13/D9）──
  //    客户端状态先解析后写（对齐 bump「先读后算零写」）：坏 JSON/形态损坏此前在写序④⑤才抛，
  //    已产生 cache/镜像写副作用后才落误导文案且不指认文件；现于任何写副作用前拒绝并指认。
  const snapshot = {};
  for (const [k, file] of Object.entries(files)) {
    if (!existsSync(file)) { snapshot[k] = null; continue; }
    try {
      snapshot[k] = readFileSync(file, 'utf8');
    } catch (e) {
      // 评审 correctness-4 N1：存在但不可读（EISDIR/EACCES）此前穿透 runInstall 契约，落 CLI 兜底
      out(`[install] 拒绝：客户端状态不可读：${file}（${e.message}）——修复或移除该文件后重跑（未做任何写入）。\n`);
      return { code: 1 };
    }
  }
  const parsed = { known: null, registry: null, config: null };
  for (const k of bootstrap ? ['known', 'registry', 'config'] : ['registry', 'config']) {
    if (snapshot[k] === null) continue;
    let v;
    try {
      v = JSON.parse(snapshot[k]);
    } catch (e) {
      out(`[install] 拒绝：客户端状态不可解析：${files[k]}（${e.message}）——修复或移除该文件后重跑（未做任何写入）。\n`);
      return { code: 1 };
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      out(`[install] 拒绝：客户端状态顶层非对象：${files[k]}（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
      return { code: 1 };
    }
    parsed[k] = v;
  }
  // 形态闸（评审 data-integrity：config.plugins 同款收口，否则写序⑤ 会在已产生 cache/镜像写副作用后 TypeError）
  if (parsed.known && parsed.known.marketplaces != null && !Array.isArray(parsed.known.marketplaces)) {
    out(`[install] 拒绝：${files.known} 的 marketplaces 非数组（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
    return { code: 1 };
  }
  // config 形态闸（评审 data-integrity/correctness-3：下探到 enabledPlugins；标量会在写序⑤ 已产生
  // cache/镜像写副作用后 TypeError，落回 D13 要消灭的「写入失败」误定性）
  const cfgPlugins = parsed.config ? parsed.config.plugins : null;
  if (cfgPlugins != null && (typeof cfgPlugins !== 'object' || Array.isArray(cfgPlugins))) {
    out(`[install] 拒绝：${files.config} 的 plugins 非对象（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
    return { code: 1 };
  }
  const cfgEnabled = cfgPlugins ? cfgPlugins.enabledPlugins : null;
  if (cfgEnabled != null && (typeof cfgEnabled !== 'object' || Array.isArray(cfgEnabled))) {
    out(`[install] 拒绝：${files.config} 的 plugins.enabledPlugins 非对象（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
    return { code: 1 };
  }
  // registry.plugins 元素级（评审 correctness-3：[null] 元素会在写序④ map 抛 TypeError）
  if (parsed.registry && Array.isArray(parsed.registry.plugins)
    && parsed.registry.plugins.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) {
    out(`[install] 拒绝：${files.registry} 的 plugins 含非对象条目（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
    return { code: 1 };
  }
  // known.marketplaces 元素级（评审 correctness-3：[null] 元素会在写序① filter 抛 TypeError）
  if (parsed.known && Array.isArray(parsed.known.marketplaces)
    && parsed.known.marketplaces.some((m) => m === null || typeof m !== 'object' || Array.isArray(m))) {
    out(`[install] 拒绝：${files.known} 的 marketplaces 含非对象条目（形态损坏）——修复或移除该文件后重跑（未做任何写入）。\n`);
    return { code: 1 };
  }
  const cacheRoot = join(clientPath(zcodeHome, 'cache'), MARKET_ID);
  const mirrorRoot = join(clientPath(zcodeHome, 'marketplaces'), MARKET_ID);
  // 重放旁路前置拒绝（内部任务-276 D12/评审 N2）：`.replay-aside` 内是上次交换窗口中断时保留的原内容，
  // 必须在任何写副作用（含备份）之前拒绝并指认路径——绝不静默删除，也不得定性为「写入失败」。
  for (const p of PLUGINS) {
    const aside = join(cacheRoot, p, '.replay-aside');
    if (existsSync(aside)) {
      out(`[install] 拒绝：存在未处置的重放旁路目录 ${aside}（上次运行可能中断）——确认内容后手工 rename 或删除，再重跑 install（未做任何写入）。\n`);
      return { code: 1 };
    }
  }
  const thisBackups = [];
  /** 回滚：三客户端文件快照原子回写；新建 cache 目录删除（同版本重放目录见写序②注释，无需恢复）。
   *  逐项 try——一处失败不中止其余恢复（内部任务-276 D14：此前单一大 try 首败即中止）。
   *  @returns {string[]} 逐项失败清单（调用方据此决定文案是否可宣称「已回滚」） */
  const rollback = (createdDirs) => {
    const failures = [];
    for (const [k, file] of Object.entries(files)) {
      try {
        if (snapshot[k] === null) {
          if (existsSync(file)) rmSync(file, { force: true });
        } else {
          atomicWriteText(file, snapshot[k], '.zinstall-tmp'); // 评审 data-integrity：回滚回写也走原子写（防回滚中途崩溃留残缺 JSON）
        }
      } catch (e) { failures.push(`${file}（${e.message}）`); }
    }
    for (const dir of createdDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { failures.push(`${dir}（${e.message}）`); }
    }
    if (failures.length > 0) {
      out(`[install] 回滚部分失败（逐项告警，不影响其余恢复）：\n${failures.map((x) => `  ! ${x}`).join('\n')}\n`);
    }
    out(`[install] 人工兜底：各文件旁 .bak-${ts} 备份可直接改名回用；cache 版本目录可重跑 node zcode-adapter/cli.mjs install 幂等重建（若为交换恢复失败，须先按旁路告警处置 .replay-aside，否则写前闸会拒绝）。\n`);
    return failures;
  };
  const createdDirs = [];
  let freshSync = null; // bootstrap fresh 路径的 syncPlugins 返回值（成功收尾清其备份，round1 C4 处置）
  try {
    // 备份三客户端文件（存在者）；记录本次备份供成功路径清理（内部未决-122/内部任务-82）。
    // 评审 correctness-2：备份写属写侧，入主 try——中途 ENOSPC/EACCES 收为「写入失败，已回滚」退 1，
    // 不再穿透 runInstall 契约（回滚对「快照已在、文件未写」天然安全）。
    for (const file of [files.known, files.registry, files.config]) {
      if (existsSync(file)) {
        const bak = `${file}.bak-${ts}`;
        copyFileSync(file, bak);
        thisBackups.push(bak);
      }
    }
    // ① bootstrap：fresh 市场源创建/同步 + known_marketplaces 注册（父目录缺失即建）
    if (freshMarket) {
      freshSync = syncPlugins(repoRoot, market);
      const refreshed = refreshMarketManifest(market, { name: MARKET_ID, description: 'wangp 本地市场（zcode-adapter bootstrap 创建）', plugins: [] }, loaded.manifests);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      out(`[install] bootstrap 市场源创建/同步：${market}\n`);
    }
    if (bootstrap) {
      // known_marketplaces 注册：内容取自写前已解析快照，缺失即以空注册表起步（内部任务-276 D13）。
      // 原子写（内部任务-2 批 N-8：裸 writeFileSync 中途崩溃留残缺 JSON 会打瞎宿主全部市场解析；
      // temp+rename 对不存在目标同样成立——单次原子写同时覆盖「新建」与「更新」）
      const km = parsed.known ?? { version: 1, marketplaces: [] };
      const rest = (km.marketplaces ?? []).filter((m) => m.id !== MARKET_ID && m.name !== MARKET_ID);
      rest.push({ id: MARKET_ID, name: MARKET_ID, description: 'wangp 本地市场（zcode-adapter 注册）', source: { source: 'directory', path: market }, pluginCount: PLUGINS.length });
      km.marketplaces = rest;
      mkdirSync(dirname(files.known), { recursive: true });
      atomicWriteText(files.known, `${JSON.stringify(km, null, 2)}\n`, '.zinstall-tmp');
    }
    // ② cache 目标版本目录落位（仅动本次目标版本目录；旧版本目录永不删）
    //    内部任务-276 D12：同版本重放先比对（IGNORED 过滤口径，与 F4 同一过滤器——仅由忽略物构成的
    //    差异判一致并跳过，属更保守的少写）——内容与市场源一致即零写跳过（该目录正是登记表
    //    installPath 指向的活跃目录，运行中会话 hook 路径依赖之；AGENTS 已知陷阱 2026-09-12
    //    实测 43 次 hook 失败同源）；不一致时 staging 拷贝＋双 rename 交换：
    //    · 拷贝先落 staging，失败时原目录字节未变（fail-safe，强于 rm-then-copy）；
    //    · 两次交换 rename 走 renameWithRetry（Windows 瞬时锁退避，内部任务-RELEASE-058 口径）；
    //    · 第一发 rename 失败 → 清 staging（守卫）后重抛（不留整份副本残留）；
    //    · 恢复 rename 失败 → 告警指认旁路路径（原内容完整保全）并重抛原异常（标 replayIncomplete，
    //      由主 catch 分叉「回滚不完整」文案——不宣称「已回滚」）；
    //    · 旁路清理失败 → 告警不抛（cleanupPublishBackups round1 C2 口径），点前缀残留可手工删；
    //    · 交换成功后目录内容＝市场源＝回滚恢复目标，故不登记回滚恢复。
    //    瞬态名固定（单操作者工具 B-za-7 无并发碰撞）。staging 是未就位的半拷贝，进入本分支即
    //    安全预清；aside 的「存在即拒绝」属写前前置条件（见上方写前解析段），不在此处判定。
    for (const p of PLUGINS) {
      const dir = join(cacheRoot, p, String(V));
      const staging = join(cacheRoot, p, '.replay-staging');
      const aside = join(cacheRoot, p, '.replay-aside');
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(dir)) {
        createdDirs.push(dir);
        copyFn(join(market, 'plugins', p), dir);
        continue;
      }
      const tm = tryBuildExpectTree(join(market, 'plugins', p));
      const tc = tryBuildExpectTree(dir);
      const d0 = tm.problem || tc.problem ? null : diffTrees(tm.tree, tc.tree);
      if (d0 && d0.missing.length === 0 && d0.extra.length === 0 && d0.changed.length === 0) continue;
      copyFn(join(market, 'plugins', p), staging);
      try {
        renameWithRetry(dir, aside, renameFn);
      } catch (e) {
        try { rmSync(staging, { recursive: true, force: true }); } catch (e2) { warn(`[install] 重放暂存清理失败（${staging}）：${e2.message}——可手工删除\n`); }
        throw e;
      }
      try {
        renameWithRetry(staging, dir, renameFn);
      } catch (e) {
        try {
          renameWithRetry(aside, dir, renameFn);
        } catch (e2) {
          e.replayIncomplete = true; // 与 syncPlugins 的 rollbackIncomplete 分离（评审 correctness-2：文案不得张冠李戴）
          warn(`[install] 重放恢复失败：${dir} 未就位，原内容完整保留于 ${aside}（${e2.message}）——人工 rename 恢复\n`);
        }
        try { rmSync(staging, { recursive: true, force: true }); } catch (e2) { warn(`[install] 重放暂存清理失败（${staging}）：${e2.message}——可手工删除\n`); }
        throw e;
      }
      try {
        rmSync(aside, { recursive: true, force: true });
      } catch (e) {
        warn(`[install] 重放旁路清理失败（${aside}）：${e.message}——本次安装已完成；该目录须在下次同版本重放前手工删除（否则下次会因「未处置旁路」拒绝）\n`);
      }
    }
    // ③ 派生镜像对齐（幂等重导出；回滚不覆盖——正确态=与市场源一致）
    cpSync(join(market, 'marketplace.json'), join(mirrorRoot, 'marketplace.json'));
    for (const p of PLUGINS) {
      const mDir = join(mirrorRoot, 'plugins', p);
      rmSync(mDir, { recursive: true, force: true });
      copyFn(join(market, 'plugins', p), mDir);
    }
    // ④ 登记表：六条目**原位替换**（保序；未触碰条目逐字保留；同版本重放原对象复用=字节一致；
    //    installPath 尾形态沿旧条目）
    const registry = parsed.registry ?? { version: 1, plugins: [] };
    if (!Array.isArray(registry.plugins)) registry.plugins = [];
    const oldById = new Map(registry.plugins.map((e) => [e.id ?? `${e.name}@${e.marketplace}`, e]));
    const tailCache = {};
    for (const e of registry.plugins) if (PLUGINS.includes(e.name)) tailCache[e.name] = tailOf(e.installPath);
    const now = new Date().toISOString();
    /** 登记表条目工厂（内部未决-247①：九键字面量两份收敛单源；键序=JSON 字节契约，勿改）。 */
    const makeEntry = (id, p, installPath, installedAt = now) => ({
      id,
      name: p,
      marketplace: MARKET_ID,
      version: String(V),
      installPath,
      installedAt,
      updatedAt: now,
      scope: 'user',
      source: `./plugins/${p}`,
    });
    const pathOf = (p) => join(cacheRoot, p, String(V)) + (tailCache[p] ?? '');
    const wanted = new Set(PLUGINS.map((p) => `${p}@${MARKET_ID}`));
    const outPlugins = [];
    for (const e of registry.plugins) {
      const id = e.id ?? `${e.name}@${e.marketplace}`;
      if (!wanted.has(id)) {
        outPlugins.push(e); // 他条目原对象原位保留
        continue;
      }
      const p = e.name;
      const targetPath = pathOf(p);
      if (String(e.version) === String(V) && String(e.installPath) === targetPath) {
        outPlugins.push(e); // 同版本重放：原对象复用（字节一致）
        continue;
      }
      outPlugins.push(makeEntry(id, p, targetPath, e.installedAt ?? now)); // null/undefined 均折叠为 now（旧 `?? now` 语义逐字等价）
    }
    for (const p of PLUGINS) {
      const id = `${p}@${MARKET_ID}`;
      if (!oldById.has(id)) {
        outPlugins.push(makeEntry(id, p, pathOf(p)));
      }
    }
    registry.plugins = outPlugins;
    atomicWriteText(files.registry, `${JSON.stringify(registry, null, 2)}\n`, '.zinstall-tmp');
    // ⑤ config：补六插件键（不动他键）
    const config = parsed.config ?? { plugins: { enabledPlugins: {} } };
    config.plugins = config.plugins ?? {};
    config.plugins.enabledPlugins = config.plugins.enabledPlugins ?? {};
    for (const p of PLUGINS) config.plugins.enabledPlugins[`${p}@${MARKET_ID}`] = true;
    atomicWriteText(files.config, `${JSON.stringify(config, null, 2)}\n`, '.zinstall-tmp');
  } catch (exc) {
    const failures = rollback(createdDirs);
    // 失败文案按实情分叉（评审 correctness-2/data-integrity）：① 缓存交换恢复失败（replayIncomplete，
    // 本函数专有标记）② 市场同步回滚不完整（syncPlugins 的 rollbackIncomplete，bootstrap 路径）③
    // 回滚逐项失败（客户端文件未全部恢复）——三者都不得宣称「已回滚」，也不得张冠李戴。
    const replay = Boolean(exc && exc.replayIncomplete);
    const syncRollback = Boolean(exc && exc.rollbackIncomplete && !replay);
    const tail = failures.length > 0 ? `；另有 ${failures.length} 项回滚失败（见上方逐项告警）` : '';
    const head = replay
      ? `回滚不完整（cache 版本目录未就位，原内容见 stderr 旁路告警${failures.length > 0 ? '' : '；三客户端文件已按快照回写'}）`
      : syncRollback
        ? `回滚不完整（市场同步回滚未完成，备份在市场源 .publish-backups/ 下，可人工恢复${failures.length > 0 ? '' : '；三客户端文件已按快照回写'}）`
        : failures.length > 0
          ? '回滚不完整（部分客户端文件未能恢复，见上方逐项告警与 .bak 备份）'
          : `写入失败，已回滚（备份 .bak-${ts} 可人工兜底）`;
    out(`[install] ${head}${tail}：${exc.message}\n`);
    return { code: 1 };
  }
  // ⑥ 写后即验（verifyImpl 注入缝，缺省 runVerify）——F7 注册面豁免计入（round1 E1 处置）：
  //    注册态不是 install 写面产物（install 只在 bootstrap 写注册），核对由完成尾印承载（步骤 9）。
  const verify = verifyImpl ? verifyImpl({ repoRoot, marketRoot: market, zcodeHome }) : runVerify({ repoRoot, marketRoot: market, zcodeHome, registrationFace: false });
  if ((verify.problems ?? []).length > 0) {
    const failures = rollback(createdDirs);
    const tail = failures.length > 0 ? `；另有 ${failures.length} 项回滚失败（见上方逐项告警）` : '';
    out(`[install] 写后即验失败，${failures.length > 0 ? '回滚不完整' : '已回滚'}（三客户端文件 + 本次新建 cache 目录；同版本重放目录已为市场源内容无需恢复；镜像重对齐自愈；备份 .bak-${ts}${tail}）七面状态：\n${(verify.problems ?? []).map((x) => `  ! ${x}`).join('\n')}\n`);
    return { code: 1 };
  }
  // F7 注册面尾印核对（内部任务-275/内部未决-163）：注册态不是 install 写面产物（install 只在 bootstrap 写注册），
  // 故 missing/stale 只提示、不阻断、不写 config；漂移判定由 verify CLI 的 F7 面承载。
  const registration = readMarketplaceRegistration({ zcodeHome, marketRoot: market });
  if (registration.state === 'missing') {
    out(`[install] 注意：本次安装源未注册到 known_marketplaces（id=${MARKET_ID}）——后续不带 --marketplace 的 install/verify 将解析失败或指向其他源；注册方式：install --bootstrap，或手工登记 directory 源。\n`);
  } else if (registration.state === 'stale') {
    out(`[install] 注意：注册指向与本次安装源不一致：registered=${registration.registeredPath} actual=${market}——后续不带 --marketplace 的解析将指向注册源；核对后以 install --bootstrap 重登或手工修正。\n`);
  }
  // 内部决策-048/内部任务-11：收尾行按宿主在位分叉——未检出时如实改口「数据面物化就绪」，
  // 防预装形态被误读为宿主装机生效（内部任务-121 教训：数据目录残留≠宿主在位）；不阻断安装。
  const hostApp = detectHostApp();
  out(`${hostPresenceLine(hostApp, '[install] ')}\n`);
  out(`${hookInterpreterLine(detectHookInterpreter(), '[install] ')}\n`); // 内部未决-243 缓解面（内部任务-275）：只报告、不阻断、不改写
  out(hostApp.present
    ? `[install] 完成：六插件 @ ${V} 装机、写后即验全绿（F7 注册面不计入、由尾印承载）。\n`
    : `[install] 完成（数据面物化就绪——宿主未检出，非宿主装机生效，宿主装机后自拾）：六插件 @ ${V} 客户端数据面装机、写后即验全绿（F7 注册面不计入、由尾印承载）。\n`);
  out('[install] 警示：新版本需新会话生效；旧版本 cache 目录已保留（运行中会话 hook 路径依赖，勿删）。\n');
  out('收口提示：装机收口判据经 assurance install-criteria 机械生成（禁手写探针，ADR-027）——宣称宿主装机生效前先证宿主在位（install-criteria --host zcode，ADR-048）——见 AGENTS.md 装机收口行。\n');
  cleanupBackups(files, thisBackups, Date.now(), { warn }); // 内部未决-122/内部任务-82：成功路径清本次 .bak＋超龄旧 .bak（warn 缝贯通，内部任务-276 评审）
  if (freshSync) cleanupPublishBackups(market, freshSync.backupRoot); // 内部任务-275 C4：bootstrap 同步备份同款收尾
  return { code: 0, version: V };
}

/**
 * 内部未决-122/内部任务-82：成功路径清理本次 .bak＋超龄（默认 30 天）旧 .bak；回滚/失败路径由
 * rollback 兜底保留（人工恢复指引见 rollback 与主 catch 分支）。清理失败打警告、不抛出、不影响退出码
 * （对齐 market.cleanupPublishBackups round1 C2 口径——内部任务-276 D17 统一；.bak 留存无害）。
 * @param {Record<string, string>} files 客户端三文件路径集
 * @param {string[]} thisBackups 本次 install 创建的 .bak 路径列表（无条件清）
 * @param {number} [now] 判定时刻（注入缝，缺省 Date.now()）
 * @param {{warn?: (s: string) => void}} [opts] 注入缝（测试）
 */
export function cleanupBackups(files, thisBackups, now = Date.now(), opts = {}) {
  const warn = opts.warn ?? ((s) => process.stderr.write(s));
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const seen = new Set(thisBackups);
  try {
    for (const file of [files.known, files.registry, files.config]) {
      const dir = dirname(file);
      const prefix = basename(file) + '.bak-';
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue; // 精确锚定文件前缀（评审处置：防误清无关 .bak）
        const bakPath = join(dir, name);
        if (seen.has(bakPath)) {
          try { rmSync(bakPath, { force: true }); } catch (e) { warn(`[install] 备份清理失败（${bakPath}）：${e.message}——.bak 留存无害，可手工删除\n`); }
          continue;
        }
        try { if (now - statSync(bakPath).mtimeMs > MAX_AGE_MS) rmSync(bakPath, { force: true }); } catch (e) { warn(`[install] 超龄备份清理失败（${bakPath}）：${e.message}——.bak 留存无害，可手工删除\n`); }
      }
    }
  } catch (e) { warn(`[install] 备份清理面不可读：${e.message}——.bak 留存无害\n`); }
}
