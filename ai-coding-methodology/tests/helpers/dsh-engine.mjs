// 文件：dsh-engine.mjs
// 描述：把"解析宿主真实引擎（cordis / dsh-app-boot）"从各测试文件里收拢成**单一事实源**。
//
//       为什么需要（2026-09-28 第 103 批）：四条用例（第 96/100/101/102 批）都要 `import`
//       宿主的真实包，而它们的解析逻辑各自抄了一份，且**只认 `DSH_*_PATH` 环境变量**——
//       于是"默认跑法"（`node --test "ai-coding-methodology/tests/*.test.mjs"`）下**四条全部静默跳过**
//       （`t.diagnostic` + `return`，仍报 `ok`）。最强的验证因此实际上没在跑，这正是第 102 批
//       那条教训的又一次体现：**"测试通过"与"测试执行过"必须分开确认**。
//
//       本模块提供 `loadEngine(preferred)`：按四步解析，**无需任何预置环境变量**即可在本机跑起来：
//         ① 包名（`@deepseek-ai/...`）——操作者若把它装成 devDependency 就走这条；
//         ② `DSH_CORDIS_PATH` / `DSH_APP_BOOT_PATH` 环境变量（路径或 `file://` 均可）；
//         ③ 从 **DSH 安装目录的 `resources/app.asar` 就地提取**到临时缓存（见 `ensureEngineCache()`）；
//         ④ 都拿不到 ⇒ 返回 `undefined`，调用方按既有惯例显式跳过并打印原因。
//       第 ③ 步让用例在**本机默认跑法**下也能真正执行；在没装 DSH 的机器上则退回 ④，
//       保持可移植（不把"必须装 DSH"变成测试的硬前提）。
//
//       提取口径（2026-09-29 更正）：asar 内每个文件的内容自 `16 + headerSize + offset` 起、长 `size`
//       ——**没有任何填充**。`+2` 是设计文档 §8.33 时代的历史误判（当时把"读取器整体前移 2 字节"
//       误诊为"asar 有条目前缀"），照它读会让**每一个**抽取文件丢掉前 2 字节；更正依据见
//       「逐字节对照」条目（同日批次）：同一文件在 `base + offset` 处正是 `{`/`import {` 开头的
//       合法内容，在 `base + offset + 2` 处则是 `  "name"…`/`port {` 的残缺内容。
//
//       缓存身份（2026-09-29 内部任务-OPEN3942-1 / 内部规格 内部未决-42）：复用判据＝
//       `<appRoot>|<size>:<mtimeMs>|<sha256 前 16 位>` 三段全等。路径分量让"DSH 被移动/改名/
//       `DSH_APP_ROOT` 改指别的根"必然失配（否则失效根的 undefined 指纹会与"未装 DSH"不可分辨）；
//       内容哈希分量覆盖"字节数不变且时间戳未变"的宿主升级。决策与调用点收在导出
//       `ensureEngineCache()`（四态：extracted / reused / reused-unverified（asar 读不到但路径分量
//       一致 ⇒ 保守复用并打一次诊断）/ unavailable）；缓存目录可用 `DSH_ENGINE_CACHE_DIR` 覆盖，
//       集成用例据此用临时根 + 桩 asar 断言四态（tests/acceptance.test.mjs）。
//
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 各平台默认安装根候选（`DSH_APP_ROOT` 未设时按序取第一个**存在**的；都不存在则取首个候选，
 * 让"未装 DSH"与"装到别处"两种情形的诊断消息都指向一个具体路径）。
 *
 * 2026-10-01 增补（macOS 批次机）：原实现只有一条硬编码的 Windows 用户路径字面量，于是
 * 非 Windows 机器上默认跑法必然落 `unavailable`，内部未决-40 宿主契约钉子（不允许静默跳过）
 * 结构性报红——那是**环境形态**而非回归。Windows 侧改为从 `LOCALAPPDATA` 派生（原字面量
 * 仅作环境变量缺席时的兜底）；darwin 侧取标准两处安装位置。未知平台保留历史兜底值（如实报
 * "app.asar 不存在"，不臆造路径），操作方仍可用 `DSH_APP_ROOT` 显式指定。
 */
const APP_ROOT_CANDIDATES = {
  win32: [
    path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\wangp\\AppData\\Local', 'Programs', 'DeepSeek Harness'),
  ],
  darwin: [
    '/Applications/DeepSeek Harness.app/Contents',
    path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents'),
  ],
};

/** DSH 安装根（含 `resources/app.asar`）。`DSH_APP_ROOT` 优先，其次按平台候选探测。 */
function appRoot() {
  const override = process.env.DSH_APP_ROOT;
  if (override) return override;
  const candidates = APP_ROOT_CANDIDATES[process.platform] ?? ['C:\\Users\\wangp\\AppData\\Local\\Programs\\DeepSeek Harness'];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/** 提取缓存目录（跨进程复用，故第二次跑测试起就是热的）。可用 `DSH_ENGINE_CACHE_DIR` 覆盖。 */
const cacheDir = () => process.env.DSH_ENGINE_CACHE_DIR || path.join(os.tmpdir(), 'ai-coding-methodology-engine');

/** 缓存身份串的文件名（内容＝落戳时 `app.asar` 的身份串：路径分量 + 指纹 + 内容哈希）。 */
export const STAMP_NAME = '.asar-fingerprint';

/** marker 相对路径（`<cache>/node_modules/@deepseek-ai/cordis/lib/index.js`）——单点字面量，三处调用共用。 */
const MARKER_REL = path.join('node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');

/**
 * 计算 `app.asar` 的指纹（`size:mtimeMs`）——缓存**身份串的第一分量**（内部未决-41 起用；内部未决-42 起
 * 新鲜度还要求路径分量与内容哈希分量，见 `cacheIdentity()`）。
 *
 * 为什么需要（2026-09-29 内部任务-DSHADAPTER-3 / `内部规格` 内部未决-41）：本模块原先只按 marker
 * 文件是否存在复用缓存，宿主升级后仍读**旧副本** ⇒ 内部未决-40 的宿主契约钉子会对旧宿主判绿，恰把
 * 该钉子存在的理由（宿主改名/取消按调用覆盖 → 钩子 exit 0 + 零写入静默复发）静默绕过。
 * @param {string} asarPath `app.asar` 路径
 * @returns {string|undefined} 形如 `"1234567:1760000000000"`；路径不可读时 `undefined`（不抛）
 */
export function asarFingerprint(asarPath) {
  try {
    const st = fs.statSync(asarPath);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/**
 * 缓存身份串（内部未决-42）：`<appRoot>|<size>:<mtimeMs>|<内容哈希前 16 位>`。
 *
 * 为什么三段：路径分量让"DSH 被移动/改名/`DSH_APP_ROOT` 改指别的根"必然失配（否则失效根的
 * `undefined` 指纹会与"未装 DSH"不可分辨）；内容哈希分量覆盖"字节数不变且时间戳未变"的宿主升级
 * （安装器保留时间戳 / 回滚还原 / 粗粒度 FS）。
 * @param {string} appRoot 宿主安装根
 * @param {string|undefined} fingerprint `asarFingerprint()` 的结果
 * @param {string|undefined} contentHash `contentHash()` 的结果
 * @returns {string} 身份串；不可得分量落为空段
 */
export function cacheIdentity(appRoot, fingerprint, contentHash) {
  return `${appRoot}|${fingerprint ?? ''}|${contentHash ?? ''}`;
}

/**
 * 缓存是否仍新鲜：戳与当前身份串完全相等（三段全等，缺一段即不新鲜）。
 * @param {string|undefined} stamp 缓存目录内 `.asar-fingerprint` 的内容
 * @param {string} identity 当前身份串（`cacheIdentity()`）
 * @returns {boolean} 是否可直接复用
 */
export function isCacheFresh(stamp, identity) {
  return typeof stamp === 'string' && stamp.length > 0 && stamp === identity;
}

/**
 * `app.asar` 的内容哈希（sha256，取前 16 位十六进制）。
 *
 * 调用时机：只在身份的路径分量与指纹分量都与戳一致（否则注定重抽）或抽取后落新戳时调用——
 * 要发现"同 size 同 mtime、内容变"必须真读一遍内容（本机 113.2 MiB ≈ 145 ms，是第二判据的固有代价）。
 * `try` 只包住**读文件**：编程错误（未导入 `fs`、`createHash` 拼错）必须冒出来，不得被吞成"不可读"。
 * @param {string} asarPath `app.asar` 路径
 * @returns {string|undefined} 十六进制前 16 位；读取失败时 `undefined`（不抛）
 */
export function contentHash(asarPath) {
  let raw;
  try {
    raw = fs.readFileSync(asarPath);
  } catch {
    return undefined;
  }
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** 保守复用诊断只打一次（进程级），避免每个测试文件刷屏。 */
let unverifiedNoticeEmitted = false;

/**
 * 打一条保守复用诊断（进程内只打一次）。
 * @param {string} text 诊断正文
 * @returns {void}
 */
function warnOnce(text) {
  if (unverifiedNoticeEmitted) return;
  unverifiedNoticeEmitted = true;
  console.warn(`[dsh-engine] ${text}`);
}

/** staging 前缀与陈旧阈值（并发抽取的临时目录；崩溃残留由陈旧清理兜底）。 */
const STAGING_PREFIX = '.staging-';
const STAGING_STALE_MS = 10 * 60 * 1000;

/**
 * 毫秒级有界退避（同步；Node 主线程允许 `Atomics.wait`）。
 * @param {number} ms 毫秒
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 清掉同前缀的陈旧 staging / retired 目录，并跳过**本进程**的目录。
 *
 * 为什么（内部未决-43）：抽取改成 staging + 原子发布后，崩溃残留的 staging 目录需要兜底清理；
 * 只删早于阈值的（正在抽的目录 mtime 是新的），本机一次 113 MB 抽取是秒级。
 * 关于两个前缀：`.staging-` 是当前生产者；`.retired-` **本仓从未有生产者**（计划首版的"挪开旧目录"
 * 舞步在评审期即被删除、从未合入），保留这一支只为兜底清理"曾经按首版设计跑过的本地目录"——
 * 若确认全环境无此类残留，可整体删除该支（见设计文档 §8.97）。
 * 跳过自己 pid：本进程失败的抽取由调用方在 miss 分支顺手清（见 `ensureEngineCache`），
 * 此处的跳过避免"自己删自己正在写"这一类误伤。
 * @param {string} out 缓存目录
 * @returns {void}
 */
function gcStaleStaging(out) {
  const parent = path.dirname(out);
  const base = path.basename(out);
  const own = `${base}${STAGING_PREFIX}${process.pid}-`;
  const retiredBase = `${base}.retired-`;
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const isStaging = e.name.startsWith(`${base}${STAGING_PREFIX}`);
    const isRetired = e.name.startsWith(retiredBase);
    if (!isStaging && !isRetired) continue;
    if (isStaging && e.name.startsWith(own)) continue;
    const full = path.join(parent, e.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STAGING_STALE_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* 清理是尽力而为：失败不影响本次抽取 */
    }
  }
}

/**
 * 原子发布：把 staging 目录改名为 `out`。
 *
 * 判序（内部未决-43；首轮评审阻塞 1 + delta 复审 P1 的修法）：
 * ①**同身份成品优先**——`out` 的 marker 就位**且戳身份与本次一致**（`isCacheFresh`，三段全等）时
 * 丢弃本次 staging 复用；**只认 marker 是错的**（marker 路径与 appRoot 无关，而默认缓存目录是机器级
 * 单例 `os.tmpdir()/ai-coding-methodology-engine`——跨 `DSH_APP_ROOT` 并发时会拿别根的树冒充 `extracted`）。
 * ②`out` 存在但身份不同/无戳 ⇒ 清掉后发布自己的。
 * ③目标不存在 ⇒ `renameSync` 原子发布。
 * ④失败重试 **8 轮 + 有界退避**（Windows 句柄占用是本场景的主要失败源；最坏情形 ≈ 180 ms **同步阻塞**
 * 事件循环：本面只在测试基建的抽取路径上调用，不得挪到热路径或 worker 里复用）；穷尽仍不可用时丢弃 staging
 * 并返回 false——调用方如实返回 `unavailable`（fail-closed，绝不冒充 `extracted`）。
 * **不做"挪开旧目录再发布"的回滚舞步**（Windows 句柄占用下会造出 `out` 缺失窗口）。
 * 注：走"同身份成品优先"支时本次 staging 的抽取是**白做的**（丢弃），返回 `true` 只表示成品已就绪。
 * @param {string} staging 已完成抽取（含身份戳）的临时目录
 * @param {string} out 目标缓存目录
 * @param {string} stampText 本次身份串（`cacheIdentity(root, fingerprint, hash)`）
 * @returns {boolean} `out` 是否已是本次身份的完整成品
 */
export function publishDir(staging, out, stampText) {
  const marker = path.join(out, MARKER_REL);
  const stampPath = path.join(out, STAMP_NAME);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let existingStamp;
    try {
      existingStamp = fs.readFileSync(stampPath, 'utf8').trim();
    } catch {
      existingStamp = undefined;
    }
    if (fs.existsSync(marker) && isCacheFresh(existingStamp, stampText)) {
      try {
        fs.rmSync(staging, { recursive: true, force: true }); // 同身份成品：复用，零损失
      } catch {
        /* 清理失败不改返回语义：out 已是本次身份的完整成品 */
      }
      return true;
    }
    if (fs.existsSync(out)) {
      try {
        fs.rmSync(out, { recursive: true, force: true }); // 异身份/无戳残留：清掉
      } catch {
        sleepSync(5 * (attempt + 1));
        continue;
      }
    }
    try {
      fs.renameSync(staging, out);
      return true;
    } catch {
      sleepSync(5 * (attempt + 1));
    }
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖返回语义 */
  }
  return false;
}

/**
 * 把 `app.asar` 提取到 **staging 目录**（只做提取，不做复用判定；失败绝不抛），成功后写入身份戳。
 *
 * 提取 `dsh/node_modules` 全量 + 叠加 `app.asar.unpacked`（原生模块在那里）；口径与文件头注一致。
 * 约束（计划步骤 1）：staging 名由调用方给（唯一）、父目录链要建、戳只在成功时写（失败不发布不写戳）。
 * @param {string} staging 本次 staging 目录（`<cache>.staging-<pid>-<rand36>`）
 * @param {string} asar `app.asar` 路径
 * @param {string} appDir 宿主安装根（用于定位 `resources/app.asar.unpacked`）
 * @param {string} stampText 本次身份串（成功后写入 `<staging>/.asar-fingerprint`）
 * @returns {boolean} marker 是否就位
 */
function extractInto(staging, asar, appDir, stampText) {
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
    const fd = fs.openSync(asar, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16);
    const headerSize = head.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 16);
    const root = JSON.parse(headerBuf.toString('utf8'));
    // 数据区起点 = 16（pickle 前缀）+ 头 JSON 长度 + **4 字节对齐补齐**（V8 pickle 纪律）。
    // 2026-10-01 修正（macOS 批次机实测）：原式 `16 + headerSize` 只在头长度恰好 4 字节对齐时
    // 成立——本机 DSH 0.2.0-rc.2 的 app.asar 头长 3393606（%4=2）⇒ 每个文件都从**前一文件尾部**
    // 起读 2 字节，抽出的 10923 个文件全部残损（package.json 以 `;\n{` 开头，import 直接
    // ERR_INVALID_PACKAGE_CONFIG，内部未决-40 宿主契约钉子因此报红）。修法取权威口径：
    // `base = 16 + headerSize + ((4 - headerSize % 4) % 4)`，与 asar 头里 `offset` 的相对基准一致
    // （逐文件 sha256 与头内 integrity.hash 全等，10923/10923 实测）。
    const base = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
    const visit = (node, rel) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const child = `${rel}/${name}`;
        if (entry.files) {
          fs.mkdirSync(path.join(staging, child), { recursive: true });
          visit(entry, child);
        } else if (entry.offset !== undefined) {
          const dest = path.join(staging, child);
          if (fs.existsSync(dest)) continue;
          const buf = Buffer.alloc(entry.size);
          // 关键偏移：base + offset（**无填充**）。2026-09-29 逐字节对照 app.asar 实测更正——
          // §8.33 的「+2」是误判：它让每个文件丢掉前 2 字节，抽取物 package.json 直接 JSON 非法
          fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
          // 内容自证（2026-10-01）：asar 头对每个条目带 integrity.hash；不比对就只剩"偏移对不对"
          // 这一层假设——内部未决-45 与本次的 2 字节错位都是**静默**残损（抽取照跑、用例照绿或照红在
          // 无关处）。失配即抛错 ⇒ 外层 catch ⇒ 调用方如实 unavailable（fail-closed，绝不用残树冒充）。
          const expected = entry.integrity && entry.integrity.hash;
          if (typeof expected === 'string' && expected !== '') {
            const actual = createHash('sha256').update(buf).digest('hex');
            if (actual !== expected) throw new Error(`asar 抽取内容校验失败: ${child}`);
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        }
      }
    };
    visit(root.files.dsh.files.node_modules, 'node_modules');
    fs.closeSync(fd);
    // 叠加 unpacked（原生 .node 等）
    const unpacked = path.join(appDir, 'resources', 'app.asar.unpacked', 'dsh');
    const overlay = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) overlay(p, child);
        else {
          const dest = path.join(staging, child);
          if (fs.existsSync(dest)) continue;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(p, dest);
        }
      }
    };
    if (fs.existsSync(unpacked)) overlay(unpacked, '');
    fs.writeFileSync(path.join(staging, 'package.json'), '{"name":"ai-coding-methodology-engine","private":true}\n');
    const ok = fs.existsSync(path.join(staging, MARKER_REL));
    if (ok) fs.writeFileSync(path.join(staging, STAMP_NAME), `${stampText}\n`); // 戳随发布原子生效
    return ok;
  } catch {
    return false;
  }
}

/**
 * 保证宿主引擎抽取缓存可用，并返回本次决策（内部未决-42③：判据的调用点进机器验证面）。
 *
 * 四态：`extracted`（marker 缺失或身份失配 ⇒ 重抽；**或并发下他进程已发布同身份成品、本次 staging
 * 被丢弃**——此情形本次抽取是白做的，返回 `extracted` 只表示成品已就绪）/ `reused`（身份三段全等）/
 * `reused-unverified`（**只有** `asarFingerprint` 判定 asar 读不到、且戳的路径分量与当前根一致，
 * 或戳不是本代三段形态（`parts.length !== 3`，含旧形态单段戳）⇒ 保守复用，并打一次诊断）/
 * `unavailable`（asar 读不到且路径分量不一致、
 * 或 asar 可 stat 而内容不可读 ⇒ 一律不复用旧副本）。marker 缺失时**不得复用旧副本**：
 * asar 可读即重抽（`extracted`），不可读即 `unavailable`。
 * 关键姿态：**哈希面出问题不得退回"复用旧副本"** —— 那会把内容哈希降级成装饰。
 * @returns {{mode: 'extracted'|'reused'|'reused-unverified'|'unavailable', dir: string|undefined, appRoot: string, fingerprint: string|undefined, note: string|undefined}}
 * 决策对象；`dir` 仅在 `extracted`/`reused`/`reused-unverified` 三种模式下给出（`<cache>/node_modules`），`unavailable` 时为 `undefined`
 */
export function ensureEngineCache() {
  const out = cacheDir();
  const root = appRoot();
  const marker = path.join(out, MARKER_REL);
  const asar = path.join(root, 'resources', 'app.asar');
  const stampPath = path.join(out, STAMP_NAME);
  const nodeModules = path.join(out, 'node_modules');
  const fingerprint = asarFingerprint(asar);
  let stamp;
  try {
    stamp = fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    stamp = undefined;
  }
  const parts = typeof stamp === 'string' ? stamp.split('|') : [];
  const rootMatches = parts.length === 3 && parts[0] === root;
  const fpMatches = rootMatches && fingerprint !== undefined && parts[1] === fingerprint;
  const miss = (note) => ({ mode: 'unavailable', dir: undefined, appRoot: root, fingerprint, note });
  if (fs.existsSync(marker)) {
    if (fpMatches) {
      // 前两段一致才值得读内容算哈希：第二判据的固有代价只在这一支花（141–145 ms）
      const hash = contentHash(asar);
      if (hash === undefined) return miss(`app.asar 可 stat 但内容不可读：${asar}`);
      if (isCacheFresh(stamp, cacheIdentity(root, fingerprint, hash))) {
        return { mode: 'reused', dir: nodeModules, appRoot: root, fingerprint, note: undefined };
      }
      // 内容哈希失配（同 size 同 mtime 而内容变）⇒ 落到下面的重抽分支
    } else if (fingerprint === undefined) {
      // asar 真的读不到：分辨"同一个根上 DSH 没了"（保守复用）与"换了根"（不可复用）
      if (parts.length !== 3 || rootMatches) {
        const note = `复用未经校验的抽取缓存（${root} 的 app.asar 当前不可读）：无法校验宿主身份，若本机 DSH 已升级/换根，测试可能对旧宿主判绿`;
        warnOnce(note);
        return { mode: 'reused-unverified', dir: nodeModules, appRoot: root, fingerprint, note };
      }
      return miss(`缓存来自另一个宿主根（${parts[0]}），当前根 ${root} 无可用 app.asar`);
    }
    // 其余情形（换根、或指纹/内容哈希失配而 asar 可读）⇒ 重抽
  }
  if (!fs.existsSync(asar)) return miss(`app.asar 不存在：${asar}`);
  gcStaleStaging(out); // 抽取分支入口：先清陈旧 staging/retired（跳过自己 pid）
  const hash = contentHash(asar);
  if (hash === undefined) return miss(`app.asar 可 stat 但内容不可读：${asar}`);
  const stampText = cacheIdentity(root, fingerprint, hash);
  const staging = `${out}${STAGING_PREFIX}${process.pid}-${randomBytes(18).toString('hex')}`;
  if (!extractInto(staging, asar, root, stampText)) {
    try {
      fs.rmSync(staging, { recursive: true, force: true }); // 本次 pid 的半成品：当场回收（GC 跳过自己 pid）
    } catch {
      /* 回收失败：交给其它进程的陈旧清理 */
    }
    return miss('抽取失败（asar 不可解析或读取异常）');
  }
  if (!publishDir(staging, out, stampText)) return miss('发布抽取缓存失败（目标不可用）');
  return { mode: 'extracted', dir: fs.existsSync(marker) ? nodeModules : undefined, appRoot: root, fingerprint, note: undefined };
}

/**
 * 解析一个宿主包。
 * @param {string} pkg 包名，如 `@deepseek-ai/cordis`
 * @param {string} [envVar] 对应的环境变量名（路径或 `file://`）
 * @returns {Promise<any|undefined>} 模块命名空间；拿不到则 `undefined`
 */
export async function loadEngine(pkg, envVar) {
  const errors = [];
  const fromEnv = envVar ? process.env[envVar] : undefined;
  const candidates = [pkg];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    candidates.push(fromEnv.startsWith('file:') ? fromEnv : pathToFileURL(fromEnv).href);
  }
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      errors.push(`${candidate} → ${error?.code ?? 'ERR'}`);
    }
  }
  const cache = ensureEngineCache();
  if (cache.dir === undefined) return undefined;
  const rel = pkg.replace('@deepseek-ai/', '');
  const entry = path.join(cache.dir, '@deepseek-ai', rel, 'lib', 'index.js');
  if (!fs.existsSync(entry)) return undefined;
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    errors.push(`extracted:${entry} → ${error?.code ?? 'ERR'}`);
    return undefined;
  }
}

/**
 * 取宿主日志格式化器（`@deepseek-ai/cordis` 的 `Logger.format`）。
 * @returns {Promise<{Logger: object, Context: Function}|undefined>}
 */
export const loadCordis = () => loadEngine('@deepseek-ai/cordis', 'DSH_CORDIS_PATH');

/**
 * 取宿主补丁引擎（`@deepseek-ai/dsh-app-boot` 的 `composeEntries`）。
 * @returns {Promise<object|undefined>}
 */
export const loadAppBoot = () => loadEngine('@deepseek-ai/dsh-app-boot', 'DSH_APP_BOOT_PATH');
