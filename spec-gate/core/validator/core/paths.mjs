// 文件：paths.mjs
// 描述：路径安全（RULE-PATH-001/002）与只读树摘要（对齐 core/paths.py）。
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codePointCompare, isWithinRoot, realpathLoose, sha256Bytes, toPosix } from './pycompat.mjs';

export class PathSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/** 把任意分隔符与 `..` 段规范化为 POSIX 相对路径。 */
export function normalizeRelative(rel) {
  const source = String(rel);
  if (source.includes('\0')) throw new PathSecurityError(`路径含 NUL: ${rel}`);
  const posix = source.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    throw new PathSecurityError(`绝对路径不允许: ${rel}`);
  }
  const parts = [];
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new PathSecurityError(`路径逃逸（.. 段）: ${rel}`);
    parts.push(part);
  }
  return parts;
}

export function resolveWithinRoot(root, rel) {
  const rootResolved = realpathLoose(root);
  const parts = normalizeRelative(rel);
  const candidate = parts.length ? join(rootResolved, ...parts) : rootResolved;
  const resolved = realpathLoose(candidate);
  if (!isWithinRoot(rootResolved, resolved)) {
    throw new PathSecurityError(`解析后逃逸根目录: ${rel}`);
  }
  return resolved;
}

export function resolveCrossRootAsset(coreRoot, rel, manifest) {
  const parts = normalizeRelative(rel);
  const key = parts.join('/');
  const publicPaths = new Set((manifest?.publicAssets ?? []).map((a) => normalizeRelative(a.path).join('/')));
  if (!publicPaths.has(key)) throw new PathSecurityError(`跨根引用未经 manifest 授权: ${rel}`);
  return resolveWithinRoot(coreRoot, rel);
}

function sortedEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => codePointCompare(a.name, b.name));
  } catch {
    // Python os.walk 默认忽略目录读取错误（onerror=None）
    return [];
  }
}

/** 规范化树摘要：相对路径 -> `sha256:<hex>` 或 `symlink:<target>`（对齐 core/paths.py）。 */
export function treeDigest(root, ignoreNames = null) {
  const rootResolved = realpathLoose(root);
  const digest = {};
  const ignore = ignoreNames ? new Set(ignoreNames) : null;
  const walk = (dir) => {
    for (const entry of sortedEntries(dir)) {
      if (ignore && ignore.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = toPosix(full.slice(rootResolved.length + 1));
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        // Python os.walk 不记录目录符号链接（只在 filenames 中记录文件链接）
        let targetIsDir = false;
        try { targetIsDir = statSync(full).isDirectory(); } catch { targetIsDir = false; }
        if (targetIsDir) continue;
        let target;
        try { target = readlinkSync(full); } catch { continue; }
        digest[rel] = `symlink:${toPosix(target)}`;
        continue;
      }
      if (st.isDirectory()) {
        // Python os.walk 不跟随目录符号链接；此处 symlink 已在上一分支处理
        walk(full);
        continue;
      }
      // Python read_bytes() 不吞读取错误；保持 fail-loud
      const bytes = readFileSync(full);
      digest[rel] = `sha256:${sha256Bytes(bytes)}`;
    }
  };
  walk(rootResolved);
  return digest;
}

export function treeDigestFingerprint(digest) {
  const content = Object.keys(digest)
    .sort(codePointCompare)
    .map((k) => `${k}=${digest[k]}`)
    .join('\n');
  return `sha256:${sha256Bytes(Buffer.from(content, 'utf8'))}`;
}
