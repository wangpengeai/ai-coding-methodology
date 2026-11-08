// 文件：mcode-adapter/src/package-limits.mjs
// 描述：宿主 V1 包上限的机械校验（内部决策-034 决策 11）。六插件实测规模远在限内（最大单包
//       372 文件 / 1.87 MiB，上限 1024 文件 / 64 MiB），但**上限校验本身是交付物**：
//       它让"资产增长到越界"变成一次明确的安装失败，而不是宿主扫包时的静默丢包。
//       逐字限额见 `内部设计记录` §2.1。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 宿主 V1 限额（逐条对应 local-plugin-v1.md「Package and path limits」）。 */
export const LIMITS = Object.freeze({
  maxEntries: 2048,
  maxFiles: 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathBytes: 512,
  maxSegmentBytes: 128,
  maxSegments: 16,
});

/** 宿主路径段字符集。 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Windows 保留名（宿主明确拒绝，含带扩展名与大小写变体）。 */
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

/**
 * 大小写不敏感路径碰撞登记（**逐级前缀**，不只整路径）。
 *
 * 宿主对每条路径的**每一级前缀**都登记一次（`registerPortablePrefixes`：同一折叠键下
 * 出现不同拼写即 `CASE_COLLISION`），故 `Skills/demo/x.md` 与 `skills/demo/y.md` 这种
 * "仅父目录拼写不同"的组合**也会被整包拒收**（local-plugin-v1.md 原文点名了这个例子）。
 * 本层原先只比整路径 ⇒ 这类越界包能装进去，到宿主才被拒（装得上、跑不起来的坏包）。
 * 同拼写的重复登记是常态（`skills/a/…` 与 `skills/b/…` 都登记 `skills`），不报。
 * @param {Map<string,string>} prefixes 折叠键（小写）→ 首次见到的拼写
 * @param {string} rel 包内相对路径（`/` 分隔）
 * @returns {string[]} 违规描述
 */
function registerPortablePrefixes(prefixes, rel) {
  const problems = [];
  const segments = rel.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const key = prefix.toLowerCase();
    const prior = prefixes.get(key);
    if (prior === undefined) prefixes.set(key, prefix);
    else if (prior !== prefix) problems.push(`大小写不敏感路径碰撞：${prefix} 与 ${prior}`);
  }
  return problems;
}

/**
 * 单条相对路径的合规判据（字符集、段数、段长、保留名；大小写不敏感碰撞另由清单面查）。
 * @param {string} rel 相对路径（平台分隔符）
 * @returns {string[]} 违规描述
 */
export function checkPathShape(rel) {
  const problems = [];
  const portable = rel.split(sep).join('/');
  if (Buffer.byteLength(portable, 'utf8') > LIMITS.maxPathBytes) problems.push(`路径超 ${LIMITS.maxPathBytes} 字节：${portable}`);
  const segments = portable.split('/');
  if (segments.length > LIMITS.maxSegments) problems.push(`路径段数 ${segments.length} 超 ${LIMITS.maxSegments}：${portable}`);
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) problems.push(`路径段字符集非法：${segment}（${portable}）`);
    if (segment === '.' || segment === '..') problems.push(`路径段非法：${segment}`);
    if (segment.endsWith('.')) problems.push(`路径段以点结尾：${segment}`);
    if (Buffer.byteLength(segment, 'utf8') > LIMITS.maxSegmentBytes) problems.push(`路径段超 ${LIMITS.maxSegmentBytes} 字节：${segment}`);
    if (RESERVED.has(segment.split('.')[0].toUpperCase())) problems.push(`Windows 保留名：${segment}`);
  }
  return problems;
}

/**
 * 逐文件遍历包目录并累计限额（同时拒绝符号链接与其它特殊条目——宿主整包拒绝）。
 * @param {string} root 包根
 * @returns {{entries: number, files: number, totalBytes: number, problems: string[]}}
 */
export function inspectPackage(root) {
  const problems = [];
  let entries = 0;
  let files = 0;
  let totalBytes = 0;
  const lowerSeen = new Map();
  const walk = (dir) => {
    const names = readdirSync(dir);
    for (const name of names) {
      const abs = join(dir, name);
      entries += 1;
      const rel = relative(root, abs).split(sep).join('/');
      problems.push(...checkPathShape(rel));
      problems.push(...registerPortablePrefixes(lowerSeen, rel));
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        problems.push(`包内出现符号链接（宿主整包拒绝）：${rel} → ${String(readlinkSync(abs))}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`包内出现非常规条目（宿主整包拒绝）：${rel}`);
        continue;
      }
      files += 1;
      totalBytes += stat.size;
      if (stat.size > LIMITS.maxFileBytes) problems.push(`单文件超 ${LIMITS.maxFileBytes} 字节：${rel}`);
    }
  };
  walk(root);
  if (entries > LIMITS.maxEntries) problems.push(`包内条目 ${entries} 超 ${LIMITS.maxEntries}`);
  if (files > LIMITS.maxFiles) problems.push(`包内文件 ${files} 超 ${LIMITS.maxFiles}`);
  if (totalBytes > LIMITS.maxTotalBytes) problems.push(`包内文件合计 ${totalBytes} 字节超 ${LIMITS.maxTotalBytes}`);
  return { entries, files, totalBytes, problems };
}

/**
 * 物化**计划**（落盘前）的上限校验：把"将要写什么"换算成条目/文件/字节并核对限额与
 * 路径合规。落盘前先过这一关，越界即拒写（不产生半个坏包）。
 * @param {{rel: string, bytes: number}[]} planFiles 计划文件清单
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function checkPlanLimits(planFiles) {
  const problems = [];
  const dirs = new Set(['']);
  const lowerSeen = new Map();
  let totalBytes = 0;
  for (const file of planFiles) {
    problems.push(...checkPathShape(file.rel));
    problems.push(...registerPortablePrefixes(lowerSeen, file.rel));
    if (file.bytes > LIMITS.maxFileBytes) problems.push(`单文件超 ${LIMITS.maxFileBytes} 字节：${file.rel}`);
    totalBytes += file.bytes;
    const parts = file.rel.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const entries = planFiles.length + dirs.size;
  if (entries > LIMITS.maxEntries) problems.push(`包内条目约 ${entries} 超 ${LIMITS.maxEntries}`);
  if (planFiles.length > LIMITS.maxFiles) problems.push(`包内文件 ${planFiles.length} 超 ${LIMITS.maxFiles}`);
  if (totalBytes > LIMITS.maxTotalBytes) problems.push(`包内文件合计 ${totalBytes} 字节超 ${LIMITS.maxTotalBytes}`);
  return problems;
}
