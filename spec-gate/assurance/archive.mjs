// 文件：archive.mjs
// 描述：archive.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1a）——.sdd 凭据运行态 retention
//       核心（内部决策-042/内部规则-16）：阈值门控（严格大于）＋候选三条件＋tar.gz 打包/回放＋
//       manifest 先落盘再删原目录时序。tar 内核＝零第三方包自写 ustar＋pax（Node 无内置
//       tar；Python 3.9.6 tarfile（PAX 默认）对每条目产 type-'x' 扩展头〔mtime 浮点触发〕
//       且非 ASCII 名真源在 pax path 记录〔ustar 头名已 'replace' 损坏〕——读侧必须解析
//       pax，内部任务-85 计划评审实测修正）。写侧 ustar（name ≤100 UTF-8 字节超限抛错；symlink
//       目标入 linkname 头字段〔≤99 字节〕、size=0——Python tarfile 同形态）＋gzip（mtime=0）。
//       等价判据＝互操作 roundtrip（双向打包/还原逐字节）＋manifest 状态机，非 tar 字节
//       golden（gzip/tar 头含 mtime）。注入 opts：{thresholds?}（now 未注入——finalizeDaysAgo
//       双侧时钟差由 PA1 的 ≤0.5 特判承载）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteText, isWithinRoot, sha256Hex } from './common.mjs';
import { acquireLock, isLockOwner, releaseLock } from './lock.mjs';

/** 测试注入缝（内部任务-241 步骤 8）：tar 落盘后、读回校验前；生产缺省 null 不改路径。 */
export const _testHooks = { afterTarWrite: null };

/** 任务目录数阈值（内部规则-16 ①；严格大于语义）。 */
export const THRESHOLD_DIRS = 300;
/** receipts/ 体积阈值（严格大于语义）。 */
export const THRESHOLD_BYTES = 50 * 1024 * 1024;
/** finalize 后超龄门槛（严格大于）。 */
export const CANDIDATE_DAYS = 180;
const ARCHIVE_DIRNAME = 'archive';
const MANIFEST_NAME = 'archive-manifest.json';
const uuid8 = () => randomUUID().replaceAll('-', '').slice(0, 8);

const DEFAULTS = { thresholdDirs: THRESHOLD_DIRS, thresholdBytes: THRESHOLD_BYTES };

const receiptsRoot = (root) => join(root, '.sdd', 'receipts');
const archiveRoot = (root) => join(root, '.sdd', ARCHIVE_DIRNAME);

// 归档索引锁（内部任务-242 §四-1）：manifest 读-改-写全程持锁，防并发 apply/restore last-writer-wins。
// 陈旧阈值显式 3600s——长 tar 打包/读回可能超 lock.mjs 缺省 300s，避免被并发写者误判陈旧回收。
const MANIFEST_LOCK_STALE_SECONDS = 3600;
const manifestLockPath = (root) => join(archiveRoot(root), '.manifest.lock');

/** 获取归档索引锁；占用即 fail-loud（返回值供 finally 释放）。 */
function acquireManifestLock(root) {
  mkdirSync(archiveRoot(root), { recursive: true });
  const lockPath = manifestLockPath(root);
  const lock = acquireLock(lockPath, { owner: `archive-${uuid8()}`, staleSeconds: MANIFEST_LOCK_STALE_SECONDS });
  if (!lock.ok) {
    throw new Error('归档索引被并发占用（.manifest.lock 存在）——稍后重试，禁止并发写覆盖');
  }
  return { path: lockPath, owner: lock.owner };
}

function releaseManifestLock(lock) {
  if (lock === null || lock === undefined) return;
  releaseLock(lock.path, lock.owner);
}

/** S-1（内部任务-242 安全复审）：manifest 写前 fencing——锁被回收则终止写入，避免无锁双写。 */
function assertManifestLockHeld(lock) {
  if (!isLockOwner(lock.path, lock.owner)) {
    throw new Error('归档索引锁已被回收（fencing 失败，终止 manifest 写入）');
  }
}

// ── tar 内核（ustar＋pax 读；ustar 写）──

const TAR_BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader(name, size, mtime, typeFlag, linkName = '') {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) throw new Error(`ustar name 超 100 UTF-8 字节（${nameBytes.length}）：${name}`);
  const h = Buffer.alloc(TAR_BLOCK);
  nameBytes.copy(h, 0);
  // 目录条目 0o755（须带 x 位——消费端 chmod 按此落盘，644 目录不可进入，PA3 实测教训）；
  // 文件 0o644（Python tarfile 同惯例）
  h.write(octal(typeFlag === '5' ? 0o755 : 0o644, 8), 100);
  h.write(octal(0, 8), 108);                // uid
  h.write(octal(0, 8), 116);                // gid
  h.write(octal(size, 12), 124);            // size
  h.write(octal(Math.floor(mtime), 12), 136); // mtime
  h.write('        ', 148);                 // checksum 占位（空格）
  h.write(typeFlag, 156);                   // typeflag：'0'=文件 '5'=目录 '2'=symlink
  // linkname（157-256，symlink 目标）——**必须在 checksum 求和之前填充**（终审正确性发现 1：
  // 填充在求和后＝checksum 过时，双读器拒读；≤99 字节＋NUL 终止，超限 fail-loud）
  const linkBytes = Buffer.from(linkName, 'utf8');
  if (linkBytes.length > 99) throw new Error(`ustar linkname 超 99 UTF-8 字节（${linkBytes.length}）：${linkName}`);
  if (linkBytes.length > 0) linkBytes.copy(h, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 8), 148);
  return h;
}

/** 收集目录树为 tar 条目（arcname 相对路径；lstatSync 判型——symlink 存 '2' 条目不递归，
 * 对齐 Python tarfile.add 的 lstat 语义：根外目标不物化进自产归档〔门②发现 4〕）。 */
function collectTarEntries(fsRoot, arcBase) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        // tar linkname 用 POSIX 分隔符；win32 readlink 返回反斜杠，POSIX 反斜杠是合法字面量。
        entries.push({ type: 'symlink', arc: `${arcBase}/${relPath}`, linkTarget: process.platform === 'win32' ? target.replaceAll('\\', '/') : target, mtime: st.mtimeMs });
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ type: 'dir', arc: `${arcBase}/${relPath}`, mtime: st.mtimeMs });
        walk(full, relPath);
      } else if (st.isFile()) {
        entries.push({ type: 'file', arc: `${arcBase}/${relPath}`, full, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(fsRoot, '');
  return entries;
}

/** 打包多任务目录为 tar.gz Buffer（ustar 写侧；gzip mtime=0）。 */
function tarWrite(taskDirs) {
  // taskDirs: Array<{fsRoot, taskId}>——arcname 根＝任务目录名（与 tf.add(arcname=task_id) 同构）
  const chunks = [];
  for (const { fsRoot, taskId } of taskDirs) {
    const st = statSync(fsRoot);
    chunks.push(tarHeader(taskId, 0, Math.floor(st.mtimeMs / 1000), '5'));
    for (const e of collectTarEntries(fsRoot, taskId)) {
      if (e.type === 'dir') {
        chunks.push(tarHeader(e.arc, 0, Math.floor(e.mtime / 1000), '5'));
      } else if (e.type === 'symlink') {
        // symlink 条目：size=0、目标在 linkname 头字段（ustar 标准 SYMTYPE——与 Python
        // tarfile 同形态；终审正确性发现 1/2 修正：不再把目标写入数据区）
        chunks.push(tarHeader(e.arc, 0, Math.floor(e.mtime / 1000), '2', e.linkTarget));
      } else {
        chunks.push(tarHeader(e.arc, e.size, Math.floor(e.mtime / 1000), '0'));
        const data = readFileSync(e.full);
        // D07（内部任务-241）：stat 与 read 窗口内文件变化 → 数据长度与头 size 不一致即错位 tar，
        // 写前复核（fail-loud，不允许产出错位归档后删原件）。
        if (data.length !== e.size) {
          throw new Error(`tar 写前复核失败：${e.arc} 读得 ${data.length} 字节 ≠ stat ${e.size}（窗口内文件变化）`);
        }
        chunks.push(data);
        const pad = (TAR_BLOCK - (e.size % TAR_BLOCK)) % TAR_BLOCK;
        if (pad > 0) chunks.push(Buffer.alloc(pad));
      }
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2)); // 结尾双零块
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function parseOctal(block, offset, length) {
  const raw = block.toString('latin1', offset, offset + length).replace(/[\0 ]/g, '');
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

/**
 * 解析 tar.gz Buffer 为条目（读侧含 pax：Python 3.9 tarfile（PAX）对每条目产 type-'x' 头
 * ——path/size 合并入下一条目〔path 是非 ASCII 名唯一真源〕、mtime 经 utimesSync 恢复；
 * 未识别 pax 键与 type-'g' 全局头 fail-loud——tar 全部自产，未知形态＝格式漂移信号）。
 */
function tarRead(buffer) {
  const raw = gunzipSync(buffer);
  const entries = [];
  let pendingPax = null;
  for (let off = 0; off + TAR_BLOCK <= raw.length; off += TAR_BLOCK) {
    const header = raw.subarray(off, off + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // 结尾零块
    const checksum = parseOctal(header, 148, 8);
    let stored = 0;
    for (let i = 0; i < TAR_BLOCK; i += 1) {
      stored += i >= 148 && i < 156 ? 32 : header[i];
    }
    if (stored !== checksum) throw new Error(`tar 头 checksum 不符（头 ${checksum} 实算 ${stored} @${off}）`);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseOctal(header, 124, 12);
    const mtime = parseOctal(header, 136, 12);
    const type = String.fromCharCode(header[156] ?? 0x30);
    const dataStart = off + TAR_BLOCK;
    const data = raw.subarray(dataStart, dataStart + size);
    const next = dataStart + size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
    if (type === 'x' || type === 'X') {
      // pax 扩展头：'<len> key=value\n' 记录族，作用于下一条目（len 含自身数字位与空格）
      const pax = {};
      const text = data.toString('utf8');
      let pos = 0;
      while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        if (nl < 0) break;
        const line = text.slice(pos, nl + 1);
        const sp = line.indexOf(' ');
        const len = Number.parseInt(line.slice(0, sp), 10);
        if (!Number.isFinite(len) || len <= 0 || pos + len > text.length) break; // 记录须落在剩余文本内（终审正确性发现 5——原式 pos 两侧相消恒弱）
        const record = line.slice(0, len);
        const eq = record.indexOf('=', sp);
        if (eq > sp) pax[record.slice(sp + 1, eq)] = record.slice(eq + 1, record.length - 1); // 去尾 \n
        pos += len;
      }
      pendingPax = pax;
      off = next - TAR_BLOCK;
      continue;
    }
    if (type === 'g') throw new Error('tar 全局 pax 头（type g）不受支持——自产归档不应含全局头（格式漂移 fail-loud）');
    let finalName = name;
    let finalSize = size;
    let finalMtime = mtime;
    let finalLinkTarget = null;
    if (type === '2') finalLinkTarget = header.toString('utf8', 157, 256).replace(/\0.*$/, ''); // 头 linkname 字段＝symlink 目标真源（终审正确性发现 2）
    if (pendingPax) {
      if (pendingPax.path !== undefined) finalName = pendingPax.path;
      if (pendingPax.size !== undefined) finalSize = Number(pendingPax.size);
      if (pendingPax.mtime !== undefined) finalMtime = Math.floor(Number(pendingPax.mtime));
      if (pendingPax.linkpath !== undefined) finalLinkTarget = pendingPax.linkpath; // pax linkpath（长目标的真源）
      for (const key of Object.keys(pendingPax)) {
        if (!['path', 'size', 'mtime', 'mode', 'uid', 'gid', 'uname', 'gname', 'linkpath'].includes(key)) {
          throw new Error(`pax 未识别键 fail-loud：${key}（格式漂移信号）`);
        }
      }
      pendingPax = null;
    }
    entries.push({ name: finalName, size: finalSize, mtime: finalMtime, type, linkTarget: finalLinkTarget, data: type === '0' || type === '\0' ? raw.subarray(dataStart, dataStart + finalSize) : null });
    off = next - TAR_BLOCK;
  }
  return entries;
}

// ── retention 核心（对齐 archive.py 逐函数）──

/** 读 manifest（缺文件返回空结构；损坏默认 fail-open 返回空集，strict 时另存 .corrupt 后抛错）。
 *  D02（内部任务-241）：写路径一律 strict——损坏即拒绝覆盖历史批次（旧实现空集写回丢失索引）。
 * @param {string} root @param {{strict?: boolean}} [opts] @returns {Record<string, unknown>} */
export function loadManifest(root, opts = {}) {
  const strict = opts.strict === true;
  const p = join(archiveRoot(root), MANIFEST_NAME);
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return { schemaVersion: 1, batches: [] };
    if (strict) throw new Error(`归档 manifest 不可读：${e.message}`);
    return { schemaVersion: 1, batches: [] };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch { parsed = null; }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.batches)) {
    return parsed;
  }
  if (strict) {
    const corrupt = `${p}.corrupt-${uuid8()}`;
    try { writeFileSync(corrupt, raw); } catch { /* 保留副本尽力 */ }
    throw new Error(`归档 manifest 损坏（原件另存 ${corrupt}；拒绝以空集覆盖历史批次）`);
  }
  return { schemaVersion: 1, batches: [] };
}

function writeManifest(root, manifest) {
  const adir = archiveRoot(root);
  mkdirSync(adir, { recursive: true });
  atomicWriteText(join(adir, MANIFEST_NAME), JSON.stringify(manifest, null, 1));
}

/** manifest 内的任务号集合（receipts.mjs 归档分支复用——fail-open 单源，勿在别处重算）。 */
export function manifestIds(manifest) {
  const ids = new Set();
  for (const b of manifest.batches) for (const t of b.taskIds ?? []) ids.add(t);
  return ids;
}

/** 该任务 finalize 距今天数（reports 终稿 finalizedAt 取最新）；无终稿返回 null（未收口不归档）。 */
function finalizeDaysAgo(root, taskId) {
  const finalPath = join(root, '.sdd', 'reports', taskId, 'delivery-final.json');
  try {
    const data = JSON.parse(readFileSync(finalPath, 'utf8'));
    let tsStr = String(data.finalizedAt).replace('Z', '+00:00');
    // naive 时间串补 UTC（门②发现 3：Python tzinfo None→replace(utc)；JS new Date 无时区串
    // 按本地解析——相差时区偏移量，180 天候选门可翻转）
    if (!/[+-]\d{2}:\d{2}$/.test(tsStr)) tsStr += '+00:00';
    const ts = new Date(tsStr);
    if (Number.isNaN(ts.getTime())) return null;
    return (Date.now() - ts.getTime()) / 86400e3;
  } catch {
    return null;
  }
}

function dirBytes(d) {
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      // 目录判定不跟随 symlink（Python rglob 不入链接目录）；文件判定跟随（is_file() 语义
      // ——文件 symlink 指向的真实文件计入体积，门②发现 4 补验修正）
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        let followed;
        try { followed = statSync(full); } catch { continue; }
        if (followed.isFile()) total += followed.size;
        continue; // 目录/断链 symlink 不递归不计
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) total += st.size;
    }
  };
  walk(d);
  return total;
}

/**
 * 候选清单＋量级读数（dry-run 与 apply 共用；只读不写）。
 * @param {string} root
 * @param {{thresholds?: {thresholdDirs?: number, thresholdBytes?: number}}} [opts]
 */
export function archiveCandidates(root, opts = {}) {
  const { thresholdDirs, thresholdBytes } = { ...DEFAULTS, ...opts.thresholds };
  const rdir = receiptsRoot(root);
  let dirs = [];
  let st = null;
  try { st = statSync(rdir); } catch { st = null; }
  if (st && st.isDirectory()) {
    dirs = readdirSync(rdir).filter((n) => {
      try { return statSync(join(rdir, n)).isDirectory(); } catch { return false; }
    }).sort();
  }
  let totalBytes = 0;
  for (const d of dirs) totalBytes += dirBytes(join(rdir, d));
  const mIds = manifestIds(loadManifest(root));
  const evidenceDir = join(root, 'docs', 'plans', 'evidence');
  const candidates = [];
  for (const d of dirs) {
    const days = finalizeDaysAgo(root, d);
    if (days === null || days <= CANDIDATE_DAYS) continue;
    const inManifest = mIds.has(d);
    let carried = inManifest;
    if (!carried) {
      try { carried = statSync(join(evidenceDir, d)).isDirectory(); } catch { carried = false; }
    }
    if (!carried) continue;
    candidates.push({
      taskId: d,
      finalizeDaysAgo: Math.round(days * 10) / 10,
      bytes: dirBytes(join(rdir, d)),
      carriedBy: inManifest ? 'manifest' : 'evidence',
    });
  }
  return {
    schemaVersion: 1,
    dirs: dirs.length,
    totalBytes,
    thresholdDirs,
    thresholdBytes,
    thresholdMet: dirs.length > thresholdDirs || totalBytes > thresholdBytes,
    candidates,
  };
}

/** 归档读回校验：tar 内容与源目录逐条目对拍（name/type/size/data/linkTarget）。
 *  D02（内部任务-241）：写后必读回；不通过即不删原目录（归档不可逆面）。 */
function verifyTarReadback(tarBuf, taskDirs) {
  const actual = tarRead(tarBuf);
  const expected = [];
  for (const { fsRoot, taskId } of taskDirs) {
    expected.push({ name: taskId, type: '5' });
    for (const e of collectTarEntries(fsRoot, taskId)) {
      if (e.type === 'dir') expected.push({ name: e.arc, type: '5' });
      else if (e.type === 'symlink') expected.push({ name: e.arc, type: '2', linkTarget: e.linkTarget });
      else expected.push({ name: e.arc, type: '0', size: e.size, data: readFileSync(e.full) });
    }
  }
  if (actual.length !== expected.length) {
    throw new Error(`归档读回校验失败：条目数 ${actual.length} ≠ 期望 ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a.name !== e.name) throw new Error(`归档读回校验失败：第 ${i + 1} 条目名 ${a.name} ≠ ${e.name}`);
    if (a.type !== e.type) throw new Error(`归档读回校验失败：${e.name} 类型 ${a.type} ≠ ${e.type}`);
    if (e.type === '2' && a.linkTarget !== e.linkTarget) {
      throw new Error(`归档读回校验失败：${e.name} 链接目标 ${a.linkTarget} ≠ ${e.linkTarget}`);
    }
    if (e.type === '0') {
      if (a.size !== e.size) throw new Error(`归档读回校验失败：${e.name} size ${a.size} ≠ ${e.size}`);
      if (!Buffer.isBuffer(a.data) || !a.data.equals(e.data)) {
        throw new Error(`归档读回校验失败：${e.name} 内容字节不一致`);
      }
    }
  }
}

/**
 * --apply：阈值未达即拒；打包→写后读回校验→manifest 追加（含 tar sha256）→移除原目录。
 * D02/D07（内部任务-241）：读回校验不通过不删原件；manifest 损坏 strict 拒写；批次名唯一后缀防同秒覆盖；
 * 删除失败 fail-loud（避免「归档已落盘但目录残留」被下一次 apply 重复收录）。
 * @param {string} root @param {{thresholds?: object}} [opts] @returns {{schemaVersion: number, batch: string|null, archived: number, note?: string}} */
export function archiveReceipts(root, opts = {}) {
  const info = archiveCandidates(root, opts);
  if (!info.thresholdMet) {
    throw new Error(`阈值未达（目录 ${info.dirs}/${info.thresholdDirs}、体积 ${info.totalBytes}/${info.thresholdBytes}）——不执行归档；缺省 dry-run 可查候选`);
  }
  if (info.candidates.length === 0) {
    return { schemaVersion: 1, batch: null, archived: 0, note: '达阈但零候选（全部未超龄/未收口/号无承载）' };
  }
  // 内部任务-242 §四-1：manifest 读-改-写全程持归档索引锁（并发 apply/restore 单胜，last-writer-wins 消除）。
  const manifestLock = acquireManifestLock(root);
  try {
    // D02（内部任务-241）：manifest 损坏检查放在 tar 写之前（避免产物残留）；真正读-改-写在
    // 读回校验之后紧邻执行（缩小并发窗口，复审②）。
    loadManifest(root, { strict: true });
    const now = new Date().toISOString();
    const batch = `${now.slice(0, 10).replace(/-/g, '')}-${now.slice(11, 19).replace(/:/g, '')}-${uuid8()}`;
    const tarPath = join(archiveRoot(root), `receipts-${batch}.tar.gz`);
    const ids = info.candidates.map((c) => c.taskId);
    const taskDirs = ids.map((taskId) => ({ fsRoot: join(receiptsRoot(root), taskId), taskId }));
    let buf;
    try {
      buf = tarWrite(taskDirs);
      writeFileSync(tarPath, buf);
      if (_testHooks.afterTarWrite !== null) _testHooks.afterTarWrite(tarPath, buf);
      try {
        verifyTarReadback(readFileSync(tarPath), taskDirs);
      } catch (e) {
        throw new Error(`归档读回校验失败：${e.message}`);
      }
    } catch (e) {
      try { rmSync(tarPath, { force: true }); } catch { /* 清理尽力 */ }
      throw e;
    }
    let manifest;
    try {
      manifest = loadManifest(root, { strict: true });
    } catch (e) {
      try { rmSync(tarPath, { force: true }); } catch { /* 清理尽力 */ }
      throw e;
    }
    manifest.batches.push({
      batch,
      archivedAt: new Date().toISOString(),
      taskIds: ids,
      files: [`receipts-${batch}.tar.gz`],
      tarSha256: `sha256:${sha256Hex(buf)}`,
    });
    try {
      assertManifestLockHeld(manifestLock);
      writeManifest(root, manifest);
    } catch (e) {
      // 登记失败即清理未登记 tar（否则留下不可见的全量凭据副本）
      try { rmSync(tarPath, { force: true }); } catch { /* 清理尽力 */ }
      throw e;
    }
    assertManifestLockHeld(manifestLock);
    const rmErrors = [];
    for (const taskId of ids) {
      try {
        rmSync(join(receiptsRoot(root), taskId), { recursive: true, force: true });
      } catch (e) {
        rmErrors.push(`${taskId}: ${e.message}`);
      }
    }
    if (rmErrors.length > 0) {
      throw new Error(`归档已落盘但原目录删除失败（先人工清理再重跑，避免重复归档）：${rmErrors.join('；')}`);
    }
    return { schemaVersion: 1, batch, archived: ids.length };
  } finally {
    releaseManifestLock(manifestLock);
  }
}

/** tar 条目名 → 安全落点（S03/内部任务-241）：拒绝绝对路径/盘符/`..` 段，并做根内 containment。
 * @param {string} destRoot @param {string} name @returns {string} */
function safeExtractTarget(destRoot, name) {
  const raw = String(name ?? '');
  if (raw === '' || isAbsolutePathLike(raw) || raw.split(/[\\/]/).includes('..')) {
    throw new Error(`tar 条目名非法（越界拒绝）：${raw}`);
  }
  const target = join(destRoot, raw);
  if (!isWithinRoot(destRoot, target)) throw new Error(`tar 条目越出目标根：${raw}`);
  return target;
}

/** 绝对路径/盘符形态判定（跨平台：Windows 风格盘符与 UNC 都按越界处理）。 */
function isAbsolutePathLike(p) {
  return /^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

/** 把 tar 条目还原到目标根（含 pax mtime 恢复；symlink 按 linkname 恢复〔Python extractall 同款〕）。 */
function extractEntries(entries, destRoot) {
  for (const e of entries) {
    const target = safeExtractTarget(destRoot, e.name);
    if (e.type === '5' || e.type === 'D') {
      mkdirSync(target, { recursive: true });
      utimesSync(target, new Date(e.mtime * 1000), new Date(e.mtime * 1000));
    } else if (e.type === '2') {
      // S03：symlink 目标同样须 containment（拒绝绝对/.. 与越出目标根）
      const link = String(e.linkTarget ?? '');
      if (link === '' || isAbsolutePathLike(link) || link.split(/[\\/]/).includes('..')) {
        throw new Error(`tar symlink 目标非法（越界拒绝）：${e.name} -> ${link}`);
      }
      const linkPlacement = join(join(target, '..'), link);
      if (!isWithinRoot(destRoot, linkPlacement)) {
        throw new Error(`tar symlink 目标越出目标根：${e.name} -> ${link}`);
      }
      mkdirSync(join(target, '..'), { recursive: true });
      try { rmSync(target, { force: true }); } catch { /* 不存在即免 */ }
      symlinkSync(e.linkTarget, target);
    } else if (e.type === '0' || e.type === '\0') {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, e.data);
      utimesSync(target, new Date(e.mtime * 1000), new Date(e.mtime * 1000));
    } else {
      throw new Error(`tar 条目类型不受支持：${e.type}（${e.name}）`);
    }
  }
}

/** --task-id 或 --batch 二选一：解包回 receipts/ 原位、manifest 回写（整批移除或批内剔除）。
 * @param {string} root @param {{taskId?: string|null, batch?: string|null}} [opts] @returns {{schemaVersion: number, restored: number}} */
export function restoreReceipts(root, { taskId = null, batch = null } = {}) {
  if ((taskId === null) === (batch === null)) {
    throw new Error('restore 须且仅须 --task-id 或 --batch 之一');
  }
  // 内部任务-242 §四-1：与 apply 同一归档索引锁（restore 亦读-改-写 manifest）。
  const manifestLock = acquireManifestLock(root);
  try {
    const manifest = loadManifest(root, { strict: true });
    const targets = manifest.batches.filter((b) => (batch !== null && b.batch === batch)
      || (taskId !== null && (b.taskIds ?? []).includes(taskId)));
    if (targets.length === 0) {
      throw new Error(`归档中未命中：task_id=${JSON.stringify(taskId)} batch=${JSON.stringify(batch)}`);
    }
    let restored = 0;
    for (const b of targets) {
      for (const f of b.files ?? []) {
        const tarPath = join(archiveRoot(root), f);
        let st = null;
        try { st = statSync(tarPath); } catch { st = null; }
        if (!st || !st.isFile()) throw new Error(`归档 tar 缺失：${tarPath}`);
        const tarBuf = readFileSync(tarPath);
        // S03（内部任务-241）：manifest 登记了 tarSha256 时先校验（防替换）；历史批次无该字段按原行为放行。
        if (typeof b.tarSha256 === 'string' && b.tarSha256 !== '') {
          const actual = `sha256:${sha256Hex(tarBuf)}`;
          if (actual !== b.tarSha256) throw new Error(`归档 tar 哈希失配（可能被替换）：${tarPath}`);
        }
        const allEntries = tarRead(tarBuf);
        // D05（内部任务-241）：--task-id 只解包该任务子树，兄弟任务不得复活（manifest 仍记其归档）。
        const entries = taskId !== null
          ? allEntries.filter((e) => String(e.name).split('/')[0] === taskId)
          : allEntries;
        // D05（内部任务-241 复审）：过滤为空＝tar 形态异常——零解包时不得继续剔除 manifest（否则静默丢承载）。
        if (taskId !== null && entries.length === 0) {
          throw new Error(`归档中任务 ${taskId} 无任何 tar 条目（tar 形态异常，拒绝空解包后剔除 manifest）`);
        }
        extractEntries(entries, receiptsRoot(root));
      }
      if (taskId !== null) {
        restored += 1;
        b.taskIds = (b.taskIds ?? []).filter((t) => t !== taskId);
      } else {
        restored += (b.taskIds ?? []).length;
      }
    }
    manifest.batches = taskId !== null
      ? manifest.batches.filter((b) => (b.taskIds ?? []).length > 0)
      : manifest.batches.filter((b) => b.batch !== batch);
    assertManifestLockHeld(manifestLock);
    writeManifest(root, manifest);
    return { schemaVersion: 1, restored };
  } finally {
    releaseManifestLock(manifestLock);
  }
}

/** 测试注入缝（阶段1a 对拍/单测经此访问 tar 内核；不进 Python 对齐面）。 */
export const _tarInternals = { tarWrite, tarRead, extractEntries, tarHeader };
