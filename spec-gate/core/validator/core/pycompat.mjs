// 文件：pycompat.mjs
// 描述：Python 语义基座（内部决策-051 阶段4）。集中承接 Python 3.9 标准库在 core 内被依赖的
//       可比语义：严格 UTF-8/通用换行、str.strip/splitlines/repr/truthiness、码点排序、
//       datetime.fromisoformat 子集与 naive/aware 比较、非 strict realpath。
// 作者：wangp 创建：2026-10-19 版权：MIT（见 spec-gate/LICENSE）
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Python `re` 的 `\s`（Python 3.9 str 语义；JS `\s` 含 U+FEFF，两者不同）。 */
export const PY_WS = '\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
export const PY_WS_CLASS = `[${PY_WS}]`;
export const PY_NON_WS = `[^${PY_WS}]`;

/** 配置/调用错误（对应 Python `ConfigError`，CLI 统一退 2）。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 严格 UTF-8 解码（F-10：剥离 BOM；对齐 Python 通用换行）。 */
export function decodeUtf8Strict(buffer, label = '<input>') {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const err = new Error(`${label} 不是合法 UTF-8 文本`);
    err.code = 'UNICODE_DECODE';
    throw err;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function readUtf8Text(path) {
  return decodeUtf8Strict(readFileSync(path), String(path));
}

export function readJsonStrict(path) {
  return JSON.parse(readUtf8Text(path));
}

export function pyStrip(text) {
  return String(text).replace(new RegExp(`^${PY_WS_CLASS}+|${PY_WS_CLASS}+$`, 'gu'), '');
}

/** Python `str.splitlines()`：比 /\r?\n/ 宽（\v \f \x1c-\x1e \x85 \u2028 \u2029）。 */
export function pySplitLines(text) {
  const parts = String(text).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  // Python str.splitlines 不产生结尾换行后的空尾行
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

export function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
  }
  return String(value);
}

export function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  return String(value);
}

/** Python truthiness（`not x`）：空容器/空串/0/None/False 为假。 */
export function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0 || Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** 码点序比较（Python sorted 语义；JS 默认 UTF-16 码元序在非 BMP 处分叉）。 */
export function codePointCompare(a, b) {
  const A = [...String(a)];
  const B = [...String(b)];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const d = A[i].codePointAt(0) - B[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

/**
 * Python 3.9 `datetime.fromisoformat` 子集。
 * 文法：date [任意单字符分隔符 HH[:MM[:SS[.fff|.ffffff]]]] [±HH:MM[:SS]]；
 * 调用方沿用 Python 原实现（内部决策-051 历史口径）的 `Z` 预处理语义（末尾 Z 视为 +00:00）。
 * 偏移各段按 Python 归一（分钟/秒可 ≥60，但总偏移须严格小于 24 小时）。
 * 返回 {epoch, micro, aware} 或 null。
 */
export function parsePyIsoDateTime(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.endsWith('Z') ? `${raw.slice(0, -1)}+00:00` : raw;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:(\D)(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)?(?:([+-])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{6}))?)?)?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, , h = '0', mi = '0', sec = '0', frac = '0', sign, oh = '0', om = '0', os = '0', ofrac = '0'] = m;
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  const hh = Number(h);
  const min = Number(mi);
  const ss = Number(sec);
  if (yy < 1 || mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || min > 59 || ss > 59) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(yy, mm - 1, dd);
  dt.setUTCHours(hh, min, ss, 0);
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  let epoch = Math.floor(dt.getTime() / 1000);
  let micro = Number(frac.padEnd(6, '0').slice(0, 6));
  const aware = sign !== undefined;
  if (aware) {
    const total = Number(oh) * 3600 + Number(om) * 60 + Number(os);
    if (total >= 86400) return null;
    const dir = sign === '-' ? -1 : 1;
    epoch -= dir * total;
    // 偏移秒可带 6 位小数（Python 3.9 文法）；并入 UTC 微秒并进位/借位。
    micro -= dir * Number(ofrac.padEnd(6, '0').slice(0, 6));
    if (micro < 0) { micro += 1000000; epoch -= 1; } else if (micro >= 1000000) { micro -= 1000000; epoch += 1; }
  }
  return { epoch, micro, aware };
}

/** Python datetime 比较：naive/aware 混比抛 TypeError；相等返回 0。 */
export function cmpPyDateTime(a, b) {
  if (a.aware !== b.aware) {
    throw new TypeError("can't compare offset-naive and offset-aware datetimes");
  }
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  return a.micro - b.micro;
}

/** F-3 口径：naive 按 UTC 解释后再比较（混比不崩溃）。 */
export function cmpPyDateTimeUtc(a, b) {
  try {
    return cmpPyDateTime(a, b);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    return a.micro - b.micro;
  }
}

/** F-3：坏 now 一律抛 ConfigError（不再静默关闭 deadline 检查）。 */
export function parseNowOrThrow(now, label = 'now') {
  if (now === null || now === undefined || now === '') return null;
  const parsed = parsePyIsoDateTime(String(now));
  if (!parsed) throw new ConfigError(`${label} 不是合法 ISO-8601 时间: ${now}`);
  return parsed;
}

/**
 * CLI 主模块判定：先 realpath 再比较，避免经文件符号链接调用时 import.meta.url
 * 已 realpath 化而 argv[1] 未解析，导致入口静默不执行、退出 0 的假绿。
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

/** Python `datetime.now().astimezone().isoformat(timespec="seconds")`。 */export function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 输出契约：stdout 纯 JSON（缩进 2，UTF-8 原字符）。 */
export function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function emitText(lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  process.stdout.write(`${list.join('\n')}\n`);
}

/** 非 strict realpath（对齐 Path.resolve()/os.path.realpath：不存在的尾段保留拼接）。 */
export function realpathLoose(p) {
  let current = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      // 解析失败（不存在/权限受限/循环链接）保留原段上溯，不向调用方抛
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/** 目标是否在根内（分隔符边界判定；root===target 为 true）。 */
export function isWithinRoot(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** 文件 sha256（原始字节；tree_digest 用）。 */
export function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}
