// 文件：boundaries.mjs
// 描述：架构边界检查（RULE-BOUND-001）；F-1 scope 经根内解析，越界/缺失/非 UTF-8 显式诊断。
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { diagnostic } from './diagnostics.mjs';
import { PathSecurityError, normalizeRelative, resolveWithinRoot } from './paths.mjs';
import { codePointCompare, PY_NON_WS, PY_WS_CLASS, pyRepr, pySplitLines, pyStrip, pyTypeName, realpathLoose, toPosix } from './pycompat.mjs';

export const SOURCE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.dart', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.java', '.kt', '.rs', '.go', '.cs', '.rb', '.swift',
]);

const IMPORT_LINE_PATTERNS = [
  new RegExp(`^${PY_WS_CLASS}*import${PY_WS_CLASS}+.+`),
  new RegExp(`^${PY_WS_CLASS}*from${PY_WS_CLASS}+${PY_NON_WS}+${PY_WS_CLASS}+import${PY_WS_CLASS}+.+`),
  new RegExp(`^${PY_WS_CLASS}*#include${PY_WS_CLASS}+.+`),
  new RegExp(`^${PY_WS_CLASS}*(?:pub${PY_WS_CLASS}+)?use${PY_WS_CLASS}+${PY_NON_WS}+`),
  new RegExp(`^${PY_WS_CLASS}*require${PY_WS_CLASS}*\\(.+\\)`),
];

export const BOUNDARY_RULE_EXAMPLE = '[{"id":"BOUND-1","scope":"src","deny":["from tests import"],"allow":[],"severity":"blocking","rationale":"测试代码不得被生产代码反向依赖"}]';

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** F-1：scope 形态校验；projectRoot 在位时同时拒绝 symlink/`..` 逃逸。 */
export function validateBoundaryRules(rules, projectRoot = null) {
  if (!Array.isArray(rules)) {
    return [`boundaries 须为规则对象数组（当前 ${pyTypeName(rules)}）；合法形态：${BOUNDARY_RULE_EXAMPLE}`];
  }
  const problems = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      problems.push(`boundaries[${i}] 须为对象（当前 ${pyTypeName(rule)}）；合法形态：${BOUNDARY_RULE_EXAMPLE}`);
      continue;
    }
    const rid = hasOwn(rule, 'id') ? rule.id : undefined;
    if (typeof rid !== 'string' || !/^BOUND-[0-9]+$/.test(rid)) {
      problems.push(`boundaries[${i}].id 须匹配 ^BOUND-\\d+$（当前 ${pyRepr(rid)}）`);
    }
    const scope = rule.scope;
    if (typeof scope !== 'string' || !pyStrip(scope)) {
      problems.push(`boundaries[${i}].scope 须为非空字符串（相对项目根的目录/文件路径）`);
    } else {
      try {
        if (projectRoot) resolveWithinRoot(projectRoot, scope);
        else normalizeRelative(scope);
      } catch (e) {
        if (e instanceof PathSecurityError) problems.push(`boundaries[${i}].scope 路径安全拒绝: ${e.message}`);
        else throw e;
      }
    }
    for (const key of ['deny', 'allow']) {
      const val = hasOwn(rule, key) ? rule[key] : [];
      if (!Array.isArray(val) || !val.every((x) => typeof x === 'string')) {
        problems.push(`boundaries[${i}].${key} 须为字符串数组（子串匹配 import 行）`);
      }
    }
    const severity = hasOwn(rule, 'severity') ? rule.severity : 'blocking';
    if (severity !== 'blocking' && severity !== 'warning') {
      problems.push(`boundaries[${i}].severity 须为 blocking|warning（当前 ${pyRepr(severity)}）`);
    }
    const rationale = hasOwn(rule, 'rationale') ? rule.rationale : undefined;
    if (rationale !== undefined && rationale !== null && typeof rationale !== 'string') {
      problems.push(`boundaries[${i}].rationale 须为字符串`);
    }
  }
  return problems;
}

function isDependencyLine(line) {
  return IMPORT_LINE_PATTERNS.some((re) => re.test(line));
}
function matches(text, patterns) {
  return patterns.some((p) => p && text.includes(p));
}
function pathComponents(p) {
  return p.split(sep).filter(Boolean).map((part) => (process.platform === 'win32' ? part.toLowerCase() : part));
}
function comparePaths(a, b) {
  const A = pathComponents(a);
  const B = pathComponents(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const d = codePointCompare(A[i], B[i]);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}
function collectPaths(dir) {
  const all = [];
  const errors = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); }
    catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') { errors.push({ path: current, code: e.code }); return; }
      throw e;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      all.push(full);
      let isDir = false;
      let isSymlink = false;
      try {
        const st = lstatSync(full);
        isDir = st.isDirectory();
        isSymlink = st.isSymbolicLink();
      } catch { /* 断链/不可读：保留条目但不递归 */ }
      if (isDir && !isSymlink) walk(full);
    }
  };
  walk(dir);
  all.sort(comparePaths);
  return { paths: all, errors };
}
function statKind(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? 'file' : (st.isDirectory() ? 'dir' : 'other');
  } catch { return 'missing'; }
}

export function checkBoundaries(projectRoot, rules) {
  // 与 resolveWithinRoot 使用同一 realpath 根，避免 /var→/private/var 等根前缀分裂
  const root = realpathLoose(projectRoot);
  const diagnostics = [];
  for (const rule of rules ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    const scope = pyStrip(String(rule.scope ?? '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '');
    if (!scope) continue;
    let scopePath;
    try {
      scopePath = resolveWithinRoot(root, scope === '.' ? '.' : scope);
    } catch (e) {
      if (!(e instanceof PathSecurityError)) throw e;
      diagnostics.push(diagnostic('RULE-BOUND-001', 'blocking', toPosix(scope), 1, `边界规则 ${pyRepr(rule.id ?? '?')} 的 scope 路径安全拒绝: ${e.message}`));
      continue;
    }
    const kind = statKind(scopePath);
    if (kind === 'missing') {
      diagnostics.push(diagnostic('RULE-BOUND-001', 'blocking', toPosix(scope), 1, `边界规则 ${pyRepr(rule.id ?? '?')} 的 scope 不存在: ${scope}`));
      continue;
    }
    const deny = Array.isArray(rule.deny) ? rule.deny : [];
    const allow = Array.isArray(rule.allow) ? rule.allow : [];
    let severity = rule.severity;
    if (severity !== 'blocking' && severity !== 'warning') severity = 'blocking';
    let files = [scopePath];
    if (kind === 'dir') {
      const collected = collectPaths(scopePath);
      if (collected.errors.some((x) => x.path === scopePath)) {
        diagnostics.push(diagnostic('RULE-BOUND-001', 'blocking', toPosix(scope), 1, `边界规则 ${pyRepr(rule.id ?? '?')} 的 scope 目录不可读: ${toPosix(scope)}`));
        continue;
      }
      for (const err of collected.errors) {
        diagnostics.push(diagnostic('RULE-BOUND-001', 'warning', toPosix(scope), 1, `边界扫描跳过不可读子目录: ${toPosix(err.path)}`));
      }
      files = collected.paths;
    }
    for (const path of files) {
      if (statKind(path) !== 'file' || !SOURCE_EXTENSIONS.has(extname(path))) continue;
      // F-1：文件级 symlink 逃逸必须在读取前拒绝（scope 根校验覆盖不到文件链接）
      // 诊断 file 保留词法路径（symlink 别名与目标各记一条，对齐 Python relative_to）
      const rel = toPosix(relative(root, path));
      let resolvedPath;
      try {
        resolvedPath = resolveWithinRoot(root, rel);
      } catch (e) {
        if (!(e instanceof PathSecurityError)) throw e;
        diagnostics.push(diagnostic('RULE-BOUND-001', 'blocking', rel, 1, `边界扫描到的文件路径安全拒绝: ${e.message}`));
        continue;
      }
      let buf;
      try { buf = readFileSync(resolvedPath); } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          diagnostics.push(diagnostic('RULE-BOUND-001', 'warning', toPosix(scope), 1, `边界扫描跳过不可读文件: ${toPosix(path)}`));
          continue;
        }
        throw e;
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch {
        diagnostics.push(diagnostic('RULE-BOUND-001', 'warning', rel, 1, '源文件不是合法 UTF-8，已跳过边界扫描'));
        continue;
      }
      const lines = pySplitLines(text);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!isDependencyLine(line)) continue;
        if (matches(line, deny) && !matches(line, allow)) {
          diagnostics.push(diagnostic(
            'RULE-BOUND-001', severity, rel, i + 1,
            `违反边界规则 ${String(rule.id ?? '?')}（${String(rule.rationale ?? '未附理由')}）：${pyStrip(line)}`,
          ));
        }
      }
    }
  }
  return diagnostics;
}
