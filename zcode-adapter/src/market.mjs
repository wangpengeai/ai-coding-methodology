// 文件：zcode-adapter/src/market.mjs
// 描述：市场同步与清单 upsert（S2 步骤 6，自 scripts/release-suite.mjs 吸收式迁移）——
//       同步 filter 与 buildEntry/常量**逐字迁移**（:53-84/:127-140/:849-858/:861-869）；
//       2026-11-01 内部任务-275/内部未决-163：syncPlugins 重写为写面加固形态（写前备份→全量落位→
//       写后自检→失败回滚→成功清理，见函数注）。原打印副作用上提到调用方，读闸/加载返回
//       {ok, reason} 形态便于单测（发布顺序「读闸 → 同步 → 刷新」由 publish 承载，本模块不持顺序）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGINS } from './manifests.mjs';
import { IGNORED, tryBuildExpectTree, treeHashOfEntries } from './expect-tree.mjs';

/** 市场顶层套件定位（zh；en 为私有保留——源头即零引用的迁移保真，不扩导出面，S2 门 #2 处置）。文案口径（内部任务-5 B，内部规则-7）：公开选择说明自足——先功能/构成，不以内部开发编号代替解释。 */
export const SUITE_DESC_ZH =
  'wangp 的 AI Coding 方法论六插件套件（workflow 流程引擎 / spec-gate 规格门禁 / scout 探路档位 / team-governance 团队治理 / algo-loop 算法迭代 / research-loop 研究环——研究假设与实验设计），统一版本成套发布';
const SUITE_DESC_EN =
  "wangp's six-plugin AI Coding Methodology suite (workflow engine / spec-gate spec gate / scout tier / team-governance / algo-loop / research-loop), released in lockstep under one version.";

/** 市场条目英译描述（manifest 只携带中文 description，英译在此单一维护；迁自 :58-67）。与套件常量同款受众口径（内部任务-5 B）：零内部编号，套件品牌（AI Coding Methodology）+ 模块语义（Workflow/Spec Gate/Scouting/Team Governance/Algorithm Iteration）自足呈现。 */
export const EN_DESC = {
  workflow:
    'Conversational development workflow engine: a single routing table of unique scenario-entry skills (idea review → clarification → planning → execution → debugging → review → closing), with coding discipline, TDD, root-cause debugging, read-only agents and dangerous-command guardrails. Workflow module of the AI Coding Methodology suite.',
  'spec-gate':
    'Spec asset governance with machine validation: rule registry, templates, ledger, evidence capture and plan validation gates (SDD/DDD/TDD applicability). Spec Gate module of the AI Coding Methodology suite, pairing with the Workflow module.',
  scout:
    'Scouting plugin: a project-level low-discipline tier for exploratory projects and one-off deliverables (mode declaration, expiry checkpoints, renewal, abandonment and graduation handoff; lightweight process with undiminished safety and data-integrity floors). Scouting module of the AI Coding Methodology suite.',
  'team-governance':
    'Team-level AI coding governance: run manifest, model policy, context trust, change sets / CAS leases, content-bound approvals, replay-first agent eval and governance reports. Optional Team Governance module of the AI Coding Methodology suite.',
  'algo-loop':
    'Algorithm iteration discipline: metric contracts, experiment ledgers, a bad-case library and a baseline registry orchestrated as an iteration loop; the measurement toolchain stays project-built while the plugin validates its presence and usage without parsing domain data. Algorithm Iteration module of the AI Coding Methodology suite.',
  'research-loop':
    'Research methodology tier: rival-explanation hypothesis work, preregistration cards that pin decision criteria before any experiment runs, and a CS experiment-design tree with the pseudoreplication trap front and center. Research module of the AI Coding Methodology suite, anchored to coding-adjacent research domains.',
};

/** keywords 缺省（沿用市场旧条目值，缺省才用；迁自 :69-74；algo-loop 2026-10-15 新增条目）。 */
export const DEFAULT_KEYWORDS = {
  workflow: ['workflow', 'routing', 'tdd', '流程引擎', '套件'],
  'spec-gate': ['sdd', 'spec', 'validation', 'gate', '规格门禁', '套件'],
  scout: ['scout', 'exploration', 'spike', 'disposable', '探路', '套件'],
  'team-governance': ['governance', 'policy', 'lease', 'approval', 'agent-eval', '治理', '套件'],
  'algo-loop': ['algorithm', 'iteration', 'metrics', 'baseline', 'bad-case', '算法迭代', '套件'],
  'research-loop': ['research', 'hypothesis', 'preregistration', 'experiment-design', '研究环', '套件'],
};

/**
 * 读市场清单（写副作用前的输入闸；迁自 :831-839 的读侧）。
 * @param {string} marketRoot 市场源根
 * @returns {{ok: true, doc: object}|{ok: false, reason: string}}
 */
export function readMarketDoc(marketRoot) {
  const file = join(marketRoot, 'marketplace.json');
  try {
    return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: `市场清单不可读：${file}（${e.message}）` };
  }
}

/**
 * 过滤式目录拷贝（排除 __pycache__/.mimosa 段与 .pyc 后缀——与同步 filter 同口径；
 * install 的 cache/镜像落位与本模块同步步共用同一过滤器，单点维护）。
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 * @returns {void}
 */
export function copyFiltered(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    if (IGNORED(name)) continue; // 段级谓词复用 expect-tree 单点（win32 normcase 口径一致，门 #3 修复）
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyFiltered(s, d);
    else cpSync(s, d);
  }
}

/**
 * 同步六插件目录至市场源（镜像语义：仓库侧删除/改名的文件不在市场残留；可重复执行）。
 * 2026-11-01 内部任务-275/内部未决-163 写面加固：写前备份（既有目录 rename 移入 `<marketRoot>/.publish-backups/<ts>`）
 * → 全量落位 → 写后自检（逐插件市场树哈希 vs 源过滤树哈希，expect-tree 同口径）→ 任一段失败自备份
 * 回滚（rename 回＋删除无备份的新建目录，round1 E4），市场恢复同步前状态（R-za-9 失败零净写——
 * 原「先删后拷、中途失败留半同步市场」缺口收口）；成功路径的备份清理归 publish 主流程调
 * cleanupPublishBackups（清理失败告警不阻断，round1 C2）。打包卫生 filter 同前（IGNORED 单点）。
 * @param {string} repoRoot 仓库根
 * @param {string} marketRoot 市场源根
 * @param {{copyFn?: (src: string, dest: string) => void}} [opts] 注入缝（测试）
 * @returns {{backupRoot: string}} 本次备份目录（成功后由调用方清理）
 */
export function syncPlugins(repoRoot, marketRoot, opts = {}) {
  const copyFn = opts.copyFn ?? copyFiltered;
  const warn = (s) => process.stderr.write(s); // 回滚告警直写 stderr（无测试注入缝——round2 S2 处置：零消费缝删除）
  // ts 秒级＋pid：跨进程同秒不碰撞（生产形态一进程一发布）；同进程同秒且有残留时 rename 目标非空
  // 仍 ENOTEMPTY——此时 backupOf/created 为空、回滚零操作并清理残留，下次自愈（round2 N2 口径）
  const ts = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`;
  const backupRoot = join(marketRoot, '.publish-backups', ts);
  const destOf = (p) => join(marketRoot, 'plugins', p);
  const backupOf = new Map(); // plugin → 备份路径（回滚＝清半成品后 rename 回）
  const created = []; // 原不存在、本次新建的插件目录（回滚＝删除，round1 E4 处置）
  let restoreFailed = false; // 任一插件恢复失败＝保留备份根（「可人工恢复」承诺成立，round1 C1 处置）
  const rollback = (cause) => {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    for (const p of PLUGINS) {
      const dest = destOf(p);
      try {
        if (backupOf.has(p)) {
          rmSync(dest, { recursive: true, force: true });
          renameSync(backupOf.get(p), dest);
        } else if (created.includes(dest)) {
          rmSync(dest, { recursive: true, force: true });
        }
      } catch (e) {
        restoreFailed = true;
        warn(`[publish] 回滚不完整：${p}（${e.message}）——备份在 ${backupRoot}，可人工恢复\n`);
      }
    }
    if (restoreFailed) err.rollbackIncomplete = true; // 上抛给 publish 层分叉拒绝文案（round2 N1 处置）
    if (!restoreFailed) {
      try {
        rmSync(backupRoot, { recursive: true, force: true });
        const parent = join(marketRoot, '.publish-backups');
        if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }); // 空壳父目录一并清
      } catch {
        /* 空壳目录留存无害 */
      }
    }
    return err;
  };
  try {
    mkdirSync(join(marketRoot, 'plugins'), { recursive: true });
    for (const p of PLUGINS) {
      const dest = destOf(p);
      if (existsSync(dest)) {
        mkdirSync(backupRoot, { recursive: true });
        renameSync(dest, join(backupRoot, p));
        backupOf.set(p, join(backupRoot, p));
      } else {
        created.push(dest);
      }
      copyFn(join(repoRoot, p), dest);
    }
    // 写后自检：逐插件市场树哈希 vs 源过滤树哈希（与 verify F1/F2 同口径，捕获「拷贝完成但内容损坏」）。
    // 内部未决-249：经 tryBuildExpectTree 折叠族（读面异常 problem 优先于哈希比对，install/verify 八消费点同族）。
    for (const p of PLUGINS) {
      const srcT = tryBuildExpectTree(join(repoRoot, p));
      const dstT = tryBuildExpectTree(destOf(p));
      if (srcT.problem || dstT.problem) throw new Error(`写后自检不可读：${p}（${srcT.problem ?? dstT.problem}）`);
      if (treeHashOfEntries(srcT.tree) !== treeHashOfEntries(dstT.tree)) throw new Error(`写后自检失配：${p}（市场树 ≠ 源过滤树）`);
    }
  } catch (e) {
    throw rollback(e); // rollback 返回标记 rollbackIncomplete 的 Error（restoreFailed 时）
  }
  return { backupRoot };
}

/** 备份保留期（与 install .bak 超龄同款 30 天）。 */
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 成功发布后的备份清理（内部任务-275/内部未决-163）：清本次 backupRoot＋超龄（30 天）旧备份目录。
 * 清理失败打警告、不抛出、不影响发布退出码（round1 C2——不沿用静默语义；残留目录无害可手工删）。
 * @param {string} marketRoot 市场源根
 * @param {string} thisBackup 本次备份目录（无条件清）
 * @param {{rmFn?: (p: string) => void, warn?: (s: string) => void}} [opts] 注入缝（测试）
 */
export function cleanupPublishBackups(marketRoot, thisBackup, opts = {}) {
  const now = Date.now();
  const rm = opts.rmFn ?? ((p) => rmSync(p, { recursive: true, force: true }));
  const warn = opts.warn ?? ((s) => process.stderr.write(s));
  const root = join(marketRoot, '.publish-backups');
  try {
    if (thisBackup && existsSync(thisBackup)) {
      try {
        rm(thisBackup);
      } catch (e) {
        warn(`[publish] 备份清理失败（${thisBackup}）：${e.message}——目录留存无害，可手工删除\n`);
      }
    }
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (dir === thisBackup) continue;
        try {
          if (now - statSync(dir).mtimeMs > BACKUP_MAX_AGE_MS) rm(dir);
        } catch (e) {
          warn(`[publish] 超龄备份清理失败（${dir}）：${e.message}——目录留存无害，可手工删除\n`);
        }
      }
      try {
        if (readdirSync(root).length === 0) rm(root);
      } catch {
        /* 根目录留存无害 */
      }
    }
  } catch (e) {
    warn(`[publish] 备份清理面不可读（${root}）：${e.message}——目录留存无害\n`);
  }
}

/**
 * 构造/更新市场条目（upsert：保留旧条目 category/keywords，缺省补默认值；迁自 :127-140）。
 * @param {string} name 插件名
 * @param {{version: string, description: string, author: string}} m 清单值
 * @param {object|null} old 旧市场条目（可缺省）
 * @returns {object}
 */
export function buildEntry(name, m, old) {
  return {
    name,
    version: m.version,
    description: m.description,
    description_i18n: { en: EN_DESC[name], 'zh-CN': m.description },
    author: { name: m.author },
    category: old?.category ?? 'developer-tools',
    keywords: Array.isArray(old?.keywords) && old.keywords.length > 0 ? old.keywords : DEFAULT_KEYWORDS[name],
    // 相对市场根：插件目录镜像在 <marketRoot>/plugins/<name>（客户端按市场根解析 source，
    // 与 marketplaces/ 快照的 plugins/ 结构与装机记录一致——写成 ./<name> 会让客户端解不到目录）
    source: `./plugins/${name}`,
  };
}

/** rename 可重试 errno（Windows 瞬时锁：目标被 AV/索引器/宿主并发读占用）。 */
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 瞬时锁重试上限（总尝试次数；含首发）。退避 20/40/60/80ms，覆盖常见扫描窗口。 */
const RENAME_ATTEMPTS = 5;

/**
 * 同步退避（零依赖：Atomics.wait 阻塞当前线程指定毫秒）。
 * @param {number} ms 毫秒
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * rename 带 Windows 瞬时锁退避重试（内部任务-RELEASE-058 口径单源）：文件/目录 rename 被 AV/
 * 索引器/宿主并发读占用时抛 EPERM/EBUSY/EACCES，单发即失败会让调用方整体回滚；仅对可重试
 * errno 退避重试，真实失败（ENOSPC 等）与重试耗尽照旧抛出。
 * 内部任务-276 D12：install 同版本重放的双 rename 交换复用本函数（与 atomicWriteText 同一循环体）。
 * @param {string} from 源路径
 * @param {string} to 目标路径
 * @param {(from: string, to: string) => void} [renameFn] rename 实现（测试注入缝，缺省 node:fs）
 * @returns {void}
 */
export function renameWithRetry(from, to, renameFn = renameSync) {
  let lastError = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameFn(from, to);
      return;
    } catch (e) {
      lastError = e;
      if (!RENAME_RETRYABLE.has(e?.code) || attempt === RENAME_ATTEMPTS) break;
      sleepSync(20 * attempt);
    }
  }
  throw lastError;
}

/**
 * 原子写单源（temp+rename，失败清残留 tmp；迁自 :486-499）。
 * 2026-10-05 补 Windows 瞬时锁重试（内部任务-RELEASE-058）：rename 覆盖既有文件时若被
 * AV/索引器/宿主并发读占用会抛 EPERM/EBUSY/EACCES，单发即失败会让 install 整体回滚
 * （实测发布验证集两轮各栽一个 bootstrap 用例）。重试循环单源于 renameWithRetry（内部任务-276 D12）。
 * @param {string} file 目标文件
 * @param {string} text 写入内容
 * @param {string} tmpSuffix 临时文件后缀
 * @param {(from: string, to: string) => void} [renameFn] rename 实现（测试注入缝，缺省 node:fs）
 * @returns {void}
 */
export function atomicWriteText(file, text, tmpSuffix, renameFn = renameSync) {
  const tmp = `${file}${tmpSuffix}`;
  try {
    writeFileSync(tmp, text);
    renameWithRetry(tmp, file, renameFn);
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不反噬 */
    }
    throw e;
  }
}

/**
 * 刷新市场清单（顶层套件定位 + 套件插件条目 upsert〔数随 PLUGINS 清单〕，其余条目与 metadata 原样保留；迁自 :861-869）。
 * @param {string} marketRoot 市场源根
 * @param {object} doc 读闸取到的市场清单对象
 * @param {Object<string, {version: string, description: string, author: string}>} manifests 五清单值
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function refreshMarketManifest(marketRoot, doc, manifests) {
  const file = join(marketRoot, 'marketplace.json');
  try {
    doc.description = SUITE_DESC_ZH;
    const byName = new Map((doc.plugins ?? []).map((p) => [p.name, p]));
    for (const p of PLUGINS) byName.set(p, buildEntry(p, manifests[p], byName.get(p) ?? null));
    doc.plugins = [...byName.values()];
    atomicWriteText(file, `${JSON.stringify(doc, null, 2)}\n`, '.suite-tmp');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `市场清单刷新失败：${file}（${e.message}）` };
  }
}
