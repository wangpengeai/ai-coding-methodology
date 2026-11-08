// 文件：revision.mjs
// 描述：revision.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段2 凭据链 2.1；永久件）——一次扫描产出
//       三桶内容凭据：源码（source）/ 规格（spec）/ 显式计划（plan）。git 仓库算法
//       git-head-worktree-v1（HEAD + git 视角 tracked/untracked 内容摘要）；无 git 项目回退
//       tree-content-v1（文件系统遍历，同一排除口径）。公开面与 原 Python 实现（迁移史见 内部决策-051）逐函数对齐：
//       isExcluded/contentBucketsEqual/gitChangedPaths/headEquivalent/revisionDivergence/
//       computeRevisionSet/revisionSetToDict/revisionSetMatches。内部任务-91 2.0 B：head 等价判据为
//       「提交侧 blob 与工作树逐路径一致 ⇒ 等价」（fail-closed 面不变）。
//       已登记边界（内部决策-051 / 内部未决-131）：Python 用 surrogateescape 解码 git 输出，本模块用
//       TextDecoder('utf-8',{fatal:true}) 严格解码——无效 UTF-8 路径抛 RevisionDecodeError：
//       headEquivalent 捕获转具名 fail-closed，computeRevisionSet 不捕获/不回退；
//       git 不可用/超时/超限（spawnSync.error、status===null）在 computeRevisionSet 仍按
//       原 Python 实现（迁移史见 内部决策-051）回退 tree-content-v1——该回退**不是** fail-closed。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import {
  codePointCompare, isWithinRoot, loadJson, looseRealpath, pyEquals as pyEqualsCommon, pyRepr, sha256File, sha256Hex, toPosix, underRoot,
} from './common.mjs';

export const ALGORITHM_VERSION = '1';
export const GIT_ALGORITHM = 'git-head-worktree-v1';
export const TREE_ALGORITHM = 'tree-content-v1';

// 源码桶排除前缀（POSIX 相对路径）：规格与计划各归己桶，内部治理状态 全部为规格/运行态。
// 条目为混合语义：以 `/` 结尾者按目录前缀匹配，否则按文件名整名相等（对齐 revision.py `_is_excluded`）。
export const SOURCE_EXCLUDE_PREFIXES = [
  '.git/',
  '.sdd/',
  '.scout/',
  'specs/',
  'docs/plans/',
  'docs/superpowers/plans/',
  '.workflow/incidents.jsonl',
  '.workflow/routing.json',
  '.workflow/routing-state/',
];

export const DEFAULT_SUITE_PATH = '.sdd/suite.json';

// 提交 sha 形态白名单（内部任务-40）：既挡 unborn/分支名/缩写歧义，也防注入（值会拼进 git argv）。
// 尾随 `\n?` 对齐 Python `re.match` 的 `$`（允许单个尾随换行）。
const HEAD_SHA_RE = /^[0-9a-fA-F]{7,64}\n?$/;
const BLOB_OID_RE = /^[0-9a-fA-F]{40,64}$/;

/** git 输出严格解码失败（无效 UTF-8，内部未决-131 迁移窗口边界）。 */
export class RevisionDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RevisionDecodeError';
  }
}

/**
 * 相对路径命中任一排除条目即不入源码桶（边界感知：目录前缀 vs 文件名整名相等）。
 * @param {string} relPosix
 * @returns {boolean}
 */
export function isExcluded(relPosix) {
  for (const entry of SOURCE_EXCLUDE_PREFIXES) {
    if (entry.endsWith('/')) {
      if (relPosix.startsWith(entry)) return true;
    } else if (relPosix === entry) {
      return true;
    }
  }
  return false;
}

/** undefined 归一为 null（Python dict.get 缺省 None 的语义）——用于 revision 的关键字段比较。 */
function norm(v) { return v === undefined ? null : v; }

/** revision 侧判等＝common.pyEquals 的 `.get() 缺省 null` 模式（单一实现见 common.mjs）。 */
const eq = (a, b) => pyEqualsCommon(a, b, { undefinedAsNull: true });

/** 剥除源码桶的 head（提交身份是溯源元数据，不参与内容判等）。 */
function stripHead(bucket) {
  const b = norm(bucket);
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = {};
  for (const [k, v] of Object.entries(b)) if (k !== 'head') out[k] = v;
  return out;
}

/**
 * **全部内容桶**等价判定（内部任务-40）：源码桶去 `head` 后相等 且 规格桶相等 且 计划桶相等。
 * `algorithmVersion` 是凭据格式版本而非内容，刻意不参与判等（对齐 原 Python 实现（迁移史见 内部决策-051））。
 * @param {Record<string, unknown>} oldRev
 * @param {Record<string, unknown>} newRev
 * @returns {boolean}
 */
export function contentBucketsEqual(oldRev, newRev) {
  const o = oldRev ?? {};
  const n = newRev ?? {};
  return eq(stripHead(o.sourceRevision), stripHead(n.sourceRevision))
    && eq(norm(o.specRevision), norm(n.specRevision))
    && eq(norm(o.planSha256), norm(n.planSha256));
}

/**
 * 严格 UTF-8 解码（无效字节抛 RevisionDecodeError；对齐 内部未决-131 边界）。
 * @param {Buffer} buf
 * @param {string} what 命令标识（诊断用）
 * @returns {string}
 */
function decodeStrict(buf, what) {
  try {
    // ignoreBOM=true：保留首路径的 U+FEFF（默认会剥除 BOM，Python utf-8 解码不剥——路径字节保真）
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new RevisionDecodeError(`${what}输出不是有效 UTF-8（严格解码失败，OPEN-131）`);
  }
}

/** spawnSync 输出上限：64 MiB（Python capture_output 无上限；大仓 ls-files 留足余量）。 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 执行 git（数组参数）：git 不可用/超时/超限返回 null（对齐 Python OSError/TimeoutExpired），
 * 正常退出返回 {status, stdout: Buffer, stderr: Buffer}；解码归各调用方（严格 UTF-8）。
 * @param {string} root
 * @param {string[]} args
 * @param {{timeoutMs?: number, input?: Buffer|null}} [opts]
 * @returns {{status: number, stdout: Buffer, stderr: Buffer}|null}
 */
function gitRun(root, args, { timeoutMs = 30_000, input = null } = {}) {
  const r = spawnSync('git', args, {
    cwd: root,
    input: input ?? undefined,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  // spawnSync.error：ENOENT（git 不可用）/ETIMEDOUT/ENOBUFS；status===null：被信号终止
  if (r.error || r.status === null) return null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 读 git HEAD；无 git 或 unborn 返回 null（由调用方决定回退语义）。 */
function gitHead(root) {
  const r = gitRun(root, ['rev-parse', 'HEAD']);
  if (r === null || r.status !== 0) return null;
  return decodeStrict(r.stdout, 'git rev-parse HEAD ').trim();
}

/** git 视角的源文件清单（tracked + 未忽略 untracked）；git 不可用返回 null。 */
function gitSourceFiles(root) {
  const r = gitRun(root, ['ls-files', '-co', '--exclude-standard', '-z'], { timeoutMs: 60_000 });
  if (r === null || r.status !== 0) return null;
  const names = decodeStrict(r.stdout, 'git ls-files ')
    .split('\0')
    .filter((n) => n !== '');
  return names.map(toPosix).filter((n) => !isExcluded(n));
}

/**
 * 文件系统遍历回退：跳过排除目录与全部 symlink（lstat 不跟随，防越界读取）。
 * 遍历顺序对齐 Python os.walk：当前目录文件先收集，再按排序递归子目录。
 * @param {string} root
 * @returns {string[]}
 */
function walkSourceFiles(root) {
  const collected = [];
  const walk = (dirAbs, relDir) => {
    let names;
    try { names = readdirSync(dirAbs).sort(codePointCompare); } catch { return; }
    const keptDirs = [];
    const keptFiles = [];
    for (const name of names) {
      const full = `${dirAbs}/${name}`;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue; // 目录/文件 symlink 一律不跟随
      if (st.isDirectory()) keptDirs.push(name);
      else if (st.isFile()) keptFiles.push(name);
    }
    const relOf = (name) => (relDir === '.' ? name : `${relDir}/${name}`);
    for (const name of keptFiles) {
      const rel = relOf(name);
      if (!isExcluded(rel)) collected.push(rel);
    }
    for (const name of keptDirs) {
      const rel = relOf(name);
      if (isExcluded(`${rel}/`)) continue;
      walk(`${dirAbs}/${name}`, rel);
    }
  };
  walk(root, '.');
  return collected;
}

/**
 * 对文件清单逐个流式哈希后编帧取总摘要；已从工作树删除的条目跳过（删除敏感性由缺席保证）。
 * `statSync` 跟随 symlink（对齐 Python Path.is_file）；清单中 symlink 文件由 walk 侧排除。
 */
function worktreeHash(root, files) {
  const entries = [];
  for (const rel of files) {
    const target = underRoot(root, rel, { fold: false });
    let st;
    try { st = statSync(target); } catch { continue; }
    if (!st.isFile()) continue;
    entries.push([rel, sha256File(target)]);
  }
  return sha256Hex(Buffer.from(frame(entries), 'utf8'));
}

/** 规格桶：suite.json 本身 + 其登记的每个规格文档内容。 */
function specRevision(root) {
  const suitePath = underRoot(root, DEFAULT_SUITE_PATH, { fold: false });
  if (!existsSync(suitePath)) {
    return { algorithm: 'spec-suite-v1', suiteHash: `sha256:${'0'.repeat(64)}`, documents: '0' };
  }
  let suite;
  try {
    suite = loadJson(suitePath);
  } catch {
    return { algorithm: 'spec-suite-v1', suiteHash: 'unparsable', documents: 'unparsable' };
  }
  const entries = [[DEFAULT_SUITE_PATH, sha256File(suitePath)]];
  const docs = Array.isArray(suite.documents) ? suite.documents : [];
  for (const doc of docs) {
    const rel = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc.path : null;
    if (typeof rel !== 'string') continue; // 非法登记不进摘要；深度校验归冻结 core
    const target = underRoot(root, rel, { fold: false });
    // 规格桶哈希登记文档本身（含 specs/**）——不套用源码桶排除前缀；仅做越界/链接防护。
    if (!isWithinRoot(root, target)) continue;
    let lst;
    try { lst = lstatSync(target); } catch { continue; }
    if (lst.isSymbolicLink()) continue;
    let st;
    try { st = statSync(target); } catch { continue; }
    if (!st.isFile()) continue;
    entries.push([rel, sha256File(target)]);
  }
  return {
    algorithm: 'spec-suite-v1',
    suiteHash: `sha256:${sha256Hex(Buffer.from(frame(entries), 'utf8'))}`,
    documents: String(entries.length - 1),
  };
}

/** CRLF→LF 归一（对齐 Python `raw.replace(b"\r\n", b"\n")`，逐字节、无编码往返）。 */
function normalizeLf(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[o] = buf[i];
    o += 1;
  }
  return out.subarray(0, o);
}

/**
 * 计划桶：显式计划的 LF 规范化内容哈希；相对段按 realpath 双侧归一（对齐 Python
 * `_plan_sha256`——macOS /var→/private/var 形态分裂不等于越界）。
 * @param {string} root
 * @param {string} planPath
 * @returns {{path: string, sha256: string}}
 */
function planSha256(root, planPath) {
  if (!isWithinRoot(root, planPath)) throw new Error(`计划路径越出项目根: ${planPath}`);
  let st;
  try { st = statSync(planPath); } catch { st = null; }
  if (st === null || !st.isFile()) throw new Error(`计划文件不存在: ${planPath}`);
  const normalized = normalizeLf(readFileSync(planPath));
  const rel = toPosix(relative(looseRealpath(root), looseRealpath(planPath)));
  return { path: rel, sha256: `sha256:${sha256Hex(normalized)}` };
}

/**
 * 编帧为确定性摘要输入：按码点序排序 + NUL 分隔 + 换行（Python `_frame` 逐字对齐）。
 * @param {Array<[string, string]>} entries
 * @returns {string}
 */
function frame(entries) {
  const sorted = [...entries].sort((a, b) => codePointCompare(a[0], b[0]) || codePointCompare(a[1], b[1]));
  return sorted.map(([path, digest]) => `${path}\0${digest}\n`).join('');
}

/**
 * 列出 `baseRev..headRev` 的变更路径（相对仓库根、POSIX 形态）；rev 不可达/超时→null。
 * `-z` 保留首尾空格/换行/非 ASCII；`--no-renames` 把重命名展开为 A/D 双路径。
 * @param {string} root
 * @param {string} baseRev
 * @param {string} headRev
 * @returns {string[]|null}
 */
export function gitChangedPaths(root, baseRev, headRev) {
  if (!HEAD_SHA_RE.test(String(baseRev)) || !HEAD_SHA_RE.test(String(headRev))) return null;
  const r = gitRun(root, ['diff', '--name-only', '-z', '--no-renames', `${baseRev}..${headRev}`]);
  if (r === null || r.status !== 0) return null;
  return decodeStrict(r.stdout, 'git diff --name-only ')
    .split('\0')
    .filter((n) => n !== '')
    .map(toPosix);
}

/**
 * 提交侧路径的 blob oid（内部任务-91 2.0 B）：tree/gitlink/多行/空输出/失败一律 null。
 * `--literal-pathspecs` 防前导 `:` 被当 pathspec magic；要求恰一行且 type=blob。
 */
function committedBlobOid(root, head, rel) {
  const r = gitRun(root, ['--literal-pathspecs', 'ls-tree', '-z', head, '--', rel]);
  if (r === null || r.status !== 0) return null;
  const records = decodeStrict(r.stdout, 'git ls-tree ').split('\0').filter((x) => x !== '');
  if (records.length !== 1) return null;
  const tab = records[0].indexOf('\t');
  if (tab < 0) return null;
  const parts = records[0].slice(0, tab).split(' ');
  if (parts.length !== 3) return null;
  const [, objType, oid] = parts;
  if (objType !== 'blob' || !BLOB_OID_RE.test(oid)) return null;
  return oid;
}

/**
 * 工作树侧路径的 blob oid（内部任务-91 2.0 B）：缺失/目录/特殊文件/失败一律 null。
 * 普通文件走 `git hash-object -- <rel>`（应用 .gitattributes/EOL 过滤）；symlink 读 link
 * 目标原始字节后 `git hash-object --stdin`（stdin 隐含 --no-filters，即 symlink blob 语义）。
 */
function worktreeBlobOid(root, rel) {
  const target = underRoot(root, rel);
  let st;
  try { st = lstatSync(target); } catch { return null; }
  let r;
  if (st.isSymbolicLink()) {
    let link;
    try { link = readlinkSync(target, { encoding: 'buffer' }); } catch { return null; }
    r = gitRun(root, ['hash-object', '--stdin'], { input: link });
  } else if (st.isFile()) {
    r = gitRun(root, ['hash-object', '--', rel]);
  } else {
    return null;
  }
  if (r === null || r.status !== 0) return null;
  const oid = decodeStrict(r.stdout, 'git hash-object ').trim();
  return oid === '' ? null : oid;
}

/** 逐路径比较提交侧 blob 与工作树 blob；任一缺失/不等/不可比对 ⇒ fail-closed 并分因。 */
function pathsMatchWorktree(root, newHead, outside) {
  for (const rel of outside) {
    const committed = committedBlobOid(root, newHead, rel);
    const work = worktreeBlobOid(root, rel);
    if (committed === null || work === null) {
      return {
        ok: false,
        reason: `提交面含源码桶路径（${rel}）：不可比对（git 失败/超时/类型不匹配）——内容凭据须重签`,
      };
    }
    if (committed !== work) {
      return {
        ok: false,
        reason: `提交面含源码桶路径（${rel}）：提交内容与工作树不一致——内容凭据须重签`,
      };
    }
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 源码桶等价判定（内部任务-40；内部任务-91 2.0 B；内部接口-11 §2）：返回 {ok, reason}。
 * `head` 降级为溯源元数据。以下任一条成立即等价：①head 逐字相等；②algorithm/worktreeHash
 * 逐字相等 + 凭据 head 形态合法 + 是当前 HEAD 的祖先 + 以下任一：②a `<head>..HEAD` 变更路径
 * 均在源码桶排除面；②b 变更路径含源码桶路径但逐路径 blob（提交侧 vs 工作树，经 git 过滤）
 * 全部一致。任一缺失/不等/不可比对 ⇒ 不等价；形态非法/不可达/浅克隆/git 不可用一律 fail-closed。
 * 无效 UTF-8 输出（RevisionDecodeError）在此捕获为具名 false（异常不穿透）。
 * @param {unknown} oldSource
 * @param {unknown} newSource
 * @param {string} root
 * @returns {{ok: boolean, reason: string}}
 */
export function headEquivalent(oldSource, newSource, root) {
  if (oldSource === null || typeof oldSource !== 'object' || Array.isArray(oldSource)
    || newSource === null || typeof newSource !== 'object' || Array.isArray(newSource)) {
    return { ok: false, reason: '源码桶形态非法' };
  }
  const oldHead = norm(oldSource.head);
  const newHead = norm(newSource.head);
  if (eq(oldHead, newHead)) return { ok: true, reason: 'ok' };
  if (!eq(oldSource.algorithm, newSource.algorithm)
    || !eq(oldSource.worktreeHash, newSource.worktreeHash)) {
    return { ok: false, reason: '源码内容摘要（worktreeHash）不一致——内容已变化，内容凭据须重签' };
  }
  if (typeof oldHead !== 'string' || !HEAD_SHA_RE.test(oldHead)) {
    return { ok: false, reason: `凭据 head 形态非法（${pyRepr(oldHead)}）——无法追溯，按失效处理` };
  }
  if (typeof newHead !== 'string' || !HEAD_SHA_RE.test(newHead)) {
    return { ok: false, reason: `当前 head 形态非法（${pyRepr(newHead)}）——无 git 或未提交状态，按失效处理` };
  }
  try {
    const mb = gitRun(root, ['merge-base', '--is-ancestor', oldHead, newHead]);
    if (mb === null) {
      return { ok: false, reason: 'git 不可用或超时——无法验证提交可达性，按失效处理' };
    }
    if (mb.status !== 0) {
      return {
        ok: false,
        reason: `凭据 head 不是当前 HEAD 的祖先（${oldHead.slice(0, 12)}…）——历史不可达（浅克隆或重置），按失效处理`,
      };
    }
    const changed = gitChangedPaths(root, oldHead, newHead);
    if (changed === null) {
      return { ok: false, reason: `无法枚举 ${oldHead.slice(0, 12)}….HEAD 的变更面（浅克隆/rev 不可达）——按失效处理` };
    }
    const outside = changed.filter((p) => !isExcluded(p));
    if (outside.length === 0) return { ok: true, reason: 'ok' };
    return pathsMatchWorktree(root, newHead, outside);
  } catch (e) {
    if (e instanceof RevisionDecodeError) {
      return { ok: false, reason: `git 输出不是有效 UTF-8——路径不可比对（OPEN-131），按失效处理：${e.message}` };
    }
    throw e;
  }
}

/**
 * 链侧消费点共用的 revision 三态判定（内部任务-40；内部接口-11 §2）：一致返回 null；否则
 * `['content-changed', reason]`｜`['head-unverifiable', reason]`（headEquivalent 的具名诊断透传）。
 * @param {string} root
 * @param {unknown} recorded
 * @param {unknown} current
 * @returns {[string, string]|null}
 */
export function revisionDivergence(root, recorded, current) {
  if (eq(recorded, current)) return null;
  const rec = recorded ?? {};
  const cur = current ?? {};
  if (!contentBucketsEqual(rec, cur)) {
    return ['content-changed', '凭据 revision 与当前不一致（源码/规格/计划已变化）'];
  }
  const he = headEquivalent(rec.sourceRevision ?? {}, cur.sourceRevision ?? {}, root);
  if (!he.ok) return ['head-unverifiable', `提交可达性无法证明：${he.reason}`];
  return null;
}

/**
 * 计算项目根的三桶内容凭据（对象形态 {source, spec, plan}）。git 仓库走 git-head-worktree-v1；
 * 无 git 走 tree-content-v1 回退（HEAD 记 unborn）。RevisionDecodeError 不捕获/不回退。
 * @param {string} projectRoot
 * @param {string|null} [planPath]
 * @returns {{source: Record<string, string>, spec: Record<string, string>, plan: Record<string, string>|null}}
 */
export function computeRevisionSet(projectRoot, planPath = null) {
  const root = projectRoot;
  const head = gitHead(root);
  const gitFiles = gitSourceFiles(root);
  let source;
  if (head !== null && gitFiles !== null) {
    source = {
      algorithm: GIT_ALGORITHM,
      head,
      worktreeHash: `sha256:${worktreeHash(root, gitFiles)}`,
    };
  } else {
    source = {
      algorithm: TREE_ALGORITHM,
      head: 'unborn',
      worktreeHash: `sha256:${worktreeHash(root, walkSourceFiles(root))}`,
    };
  }
  return {
    source,
    spec: specRevision(root),
    plan: planPath === null || planPath === undefined ? null : planSha256(root, planPath),
  };
}

/**
 * 输出 内部接口-11 契约形态：sourceRevision/specRevision/planSha256/algorithmVersion。
 * @param {{source?: object, spec?: object, plan?: object|null}} rs
 * @returns {Record<string, unknown>}
 */
export function revisionSetToDict(rs) {
  return {
    sourceRevision: { ...(rs.source ?? {}) },
    specRevision: { ...(rs.spec ?? {}) },
    planSha256: rs.plan && Object.keys(rs.plan).length > 0 ? { ...rs.plan } : null,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/**
 * 三桶全等判定（**严格含 head**——与链侧 revisionDivergence 三态并存，阶段3 不得误用）。
 * @param {{source?: object, spec?: object, plan?: object|null}} a
 * @param {{source?: object, spec?: object, plan?: object|null}} b
 * @returns {boolean}
 */
export function revisionSetMatches(a, b) {
  return eq(a?.source, b?.source)
    && eq(a?.spec, b?.spec)
    && eq(a?.plan, b?.plan);
}

/** 测试缝（production_store `_testHooks` 先例）：B 判据的内部单测面，生产路径不消费。 */
export const _testHooks = { committedBlobOid, frame };
