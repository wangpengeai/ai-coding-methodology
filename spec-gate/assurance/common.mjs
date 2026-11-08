// 文件：common.mjs
// 描述：哈希/规范 JSON/原子写公共基座（唯一实现；迁移史见 内部决策-051）
//       路径防护，行为与 spec-gate/assurance/common.py 对齐（等价判据＝spec-gate/assurance/tests/golden/
//       黄金向量；Python 双跑对拍测试已随 内部决策-051 阶段3b 删除，容差辅助见 tests/tolerance.mjs 保留面）。
//       已登记边界（内部决策-051 D4；golden 边界组钉现状）：①float token 经 JSON.parse 后与整数
//       不可区分（1.0→"1"、-0.0→"0"）；②超 2^53 整数经 parse 失精（BigInt 直入则精确）；
//       ③孤立代理项 Python encode 抛 UnicodeEncodeError、本模块同款抛错对齐（夹具避开）；
//       ④symlink 段后接 `..` 的路径——本模块 resolve 先词法折叠 `..`（判「在根内」），Python
//       realpath 逐段解析（判「越界」）——receipt/计划路径的调用面已由 TASK_ID_RE 与 _under_root
//       拒 `..` 段，形态不达；G6 钉 JS 现状、非等值对拍（终审正确性发现 1 登记）。
//       ⑤断链 symlink（指向不存在目标）的尾段——本模块保留链接自身路径（判「在根内」），
//       Python realpath 解析出根外目标（判「越界」→probes 侧 CONFIG 拒绝）——防护强度等价
//       （目标在根内时两形态均在根内）、诊断档分叉；内部任务-85 门①发现 14 登记（probes.mjs
//       边界⑧互见）。
//       行为对齐注记（阶段复审门①处置）：loadJson 严格 UTF-8（无效字节抛「文件不是有效
//       UTF-8」对齐 UnicodeDecodeError→value-error 族）；atomicWrite 临时件 0600＋短写拒断
//       ＋重试重摇名（对齐 tempfile.mkstemp/os.fdopen 全量或抛）；looseRealpath 吞解析错继续
//       上溯（对齐 realpath 非 strict）；isWithinRoot 根前缀分隔符归一。
//       EEXIST 重试分支不可测（临时文件随机后缀不可预占）、以清理断言代偿（内部任务-60 计划 C-4）。
//       内部任务-242 单源登记：`toPosix`/`pyRepr`/`pyEquals` 收敛本模块为 assurance 侧单一实现——
//       ⑥`pyRepr` 与 core `pycompat.pyRepr` 非逐字同：本模块转义 \n/\r/\t 且「含单引号且无双引号
//       时改双引号」，core 仅转义反斜杠/单引号、恒单引号（诊断文本兼容面，各自消费方不跨用）；
//       ⑦`toPosix` 与 core 同义仅在 Windows 路径分隔符（本模块 POSIX 下保留反斜杠＝`Path.as_posix()`
//       语义，core 无条件替换反斜杠——不宣称逐字同构）；⑧`pyEquals` 的 `strictTypes` 递归严格
//       仅用于通用库面，jsonl 探针「顶层严格、容器内宽松」由 `probes.strictJsonEq` 显式组合。
// 作者：wangp  创建：2026-10-17  版权：MIT（见 spec-gate/LICENSE）
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

// Q08（内部任务-241 步骤19）：与 core 逐字节同构的 nowIso/codePointCompare 改单向 import（core 只读，
// 不改字节；assurance→core 依赖方向先例见 gate.mjs 对 plan_check/boundaries/structured 的 import）。
import { codePointCompare as pyCodePointCompare, nowIso } from '../core/validator/core/pycompat.mjs';

export { nowIso };

/** 码点序比较：实现单源＝core pycompat；入口保留旧实现的严格性——非字符串输入抛 TypeError
 * （pycompat 内部 `String()` coercion 会吞掉旧 `[...a]` 对 null 等值的 TypeError，wp3 复审阻断项修复）。 */
export function codePointCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('codePointCompare 仅接受字符串（对齐旧 [...a] 行为）');
  }
  return pyCodePointCompare(a, b);
}

/** 流式读取分块（与 common.py CHUNK_SIZE 同值；模块内常量——无跨模块消费面，终审简洁性发现 4）。 */
const CHUNK_SIZE = 1 << 20;

/**
 * 统一时间戳口径：`datetime.now().astimezone().isoformat(timespec="seconds")` 形态
 * （实现单一事实源＝core pycompat.nowIso，本模块 re-export；内部任务-241 步骤19 Q08）。
 */

/** 本地日期 YYYY-MM-DD（Python `date.today()` 语义；禁止用 toISOString 的 UTC 日期）。 */
export function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日历日合法性（Python `date.fromisoformat` 的 YYYY-MM-DD 形态；年份 1-9999）。 */
export function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  if (Number(String(s).slice(0, 4)) < 1) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 拼接项目根与相对路径（Python `root / rel` 语义：绝对 rel 丢弃根）——六处副本的单一事实源
 * （内部任务-241 步骤18 Q02/Q04）。fold=true 用 path.join 词法折叠 `.`/`..`（gate/receipts/delivery/
 * cli/install 口径）；fold=false 保字面 `${root}/${rel}`（revision「不预先折叠 ..」口径）。
 * @param {string} root @param {string} rel @param {{fold?: boolean}} [opts] @returns {string}
 */
export function underRoot(root, rel, { fold = true } = {}) {
  const text = String(rel);
  if (isAbsolute(text)) return text;
  return fold ? join(root, text) : `${root}/${text}`;
}

/** 路径分隔符归一 POSIX（Python `Path.as_posix()`；Windows 语义与 core pycompat.toPosix 同义，
 * POSIX 下保留反斜杠——不宣称逐字同构，见文件头单源登记⑦）——内部任务-242 单源。 */
export function toPosix(p) {
  return sep === '/' ? String(p) : String(p).split(sep).join('/');
}

function isPlainObjectValue(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python `repr` 的字符串形态（单引号优先；含单引号且无双引号时改双引号；转义换行/制表）。
 * 内部任务-242 单源：与 core pycompat.pyRepr 的差异（字符串转义/引号择双）属诊断文本兼容面，文件头登记。 */
function pyReprString(s) {
  const body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (s.includes("'") && !s.includes('"')) return `"${body.replace(/"/g, '\\"')}"`;
  return `'${body.replace(/'/g, "\\'")}'`;
}

/** Python repr 的 JSON 值域形态（诊断文本用；数字 int/float 二分在 JS 不可区分——同已登记 float 边界）。 */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyReprString(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (isPlainObjectValue(v)) {
    return `{${Object.entries(v).map(([k, val]) => `${pyReprString(k)}: ${pyRepr(val)}`).join(', ')}}`;
  }
  return String(v);
}

/**
 * Python `==` 语义的 JSON 值域判等（内部任务-242 §三-2 单源）：对象键序无关、递归；`NaN==NaN` 视为相等；
 * 默认允许 bool↔number 等值（True==1）；`strictTypes` 时要求同型（probes jsonl 严格档）。
 * `undefinedAsNull` 时 undefined 归一为 null（revision 的 Python `.get()` 缺省语义）。
 * @param {unknown} a @param {unknown} b @param {{undefinedAsNull?: boolean, strictTypes?: boolean}} [opts]
 * @returns {boolean}
 */
export function pyEquals(a, b, { undefinedAsNull = false, strictTypes = false } = {}) {
  const x = undefinedAsNull && a === undefined ? null : a;
  const y = undefinedAsNull && b === undefined ? null : b;
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (typeof x === 'number' && typeof y === 'number') return Number.isNaN(x) && Number.isNaN(y);
  const boolish = (v) => typeof v === 'boolean';
  if (boolish(x) || boolish(y)) {
    const bothPrimitive = (typeof x === 'number' || typeof x === 'boolean')
      && (typeof y === 'number' || typeof y === 'boolean');
    if (!bothPrimitive) return false;
    if (strictTypes) return typeof x === typeof y && x === y;
    return Number(x) === Number(y);
  }
  if (typeof x !== typeof y) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    return x.every((item, i) => pyEquals(item, y[i], { undefinedAsNull, strictTypes }));
  }
  if (typeof x === 'object') {
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    return kx.every((k) => Object.prototype.hasOwnProperty.call(y, k)
      && pyEquals(x[k], y[k], { undefinedAsNull, strictTypes }));
  }
  return false;
}

/**
 * 字节内容的 sha256 十六进制（64 位小写）。
 * @param {Uint8Array} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 带算法前缀的哈希形态：sha256:<64hex>（receipt/工件引用统一形态，对齐 common.sha256_prefix）。
 * @param {Uint8Array} data
 * @returns {string}
 */
export function sha256Prefix(data) {
  return `sha256:${sha256Hex(data)}`;
}

/**
 * 流式计算文件内容哈希；文件不存在抛（ENOENT，对齐 FileNotFoundError 语义）。
 * @param {string} path
 * @returns {string}
 */
export function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_SIZE);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_SIZE, null);
      if (n === 0) break;
      hash.update(n === CHUNK_SIZE ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** 孤立代理项检测（对齐 Python encode 阶段的 UnicodeEncodeError——边界③的行为保真）。 */
const LONE_SURROGATE_RE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

/** 键比较：码点序（实现单一事实源＝core pycompat.codePointCompare，本模块 re-export）。 */

/**
 * 非整数有限 Number 的 Python repr 形态（最短往返数字＋Python 格式阈值：指数态当
 * exp<-4 或 ≥16、指数位 ≥2 且正指数带 '+'、固定态整数值补 '.0'）。数字串与 JS toString
 * 同源（同为最短往返），仅格式重排——实测锚：repr(1e16)='1e+16'、repr(1e-5)='1e-05'、
 * repr(1e-4)='0.0001'、repr(1e15)='1000000000000000.0'。
 * @param {number} n
 * @returns {string}
 */
function pyFloatRepr(n) {
  if (Object.is(n, -0)) return '-0.0';
  const s = n.toExponential();
  const eIdx = s.indexOf('e');
  let mant = s.slice(0, eIdx);
  const e = Number(s.slice(eIdx + 1));
  let sign = '';
  if (mant.startsWith('-')) {
    sign = '-';
    mant = mant.slice(1);
  }
  const digits = mant.replace('.', '');
  if (digits === '0') return `${sign}0.0`;
  if (e < -4 || e >= 16) {
    const es = `${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    return `${sign}${mant}e${es}`;
  }
  if (e >= 0) {
    if (digits.length <= e + 1) return `${sign}${digits.padEnd(e + 1, '0')}.0`;
    return `${sign}${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  }
  return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
}

/** 数字序列化（对齐 json.dumps 默认）：NaN/Infinity 走非标准字面量；安全整数直出。 */
function numberToPy(n) {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return String(n);
  return pyFloatRepr(n);
}

/** 字符串序列化（对齐 ensure_ascii=False：仅转义引号/反斜杠/控制字符；孤立代理同 Python 抛错）。 */
function stringToPy(s) {
  if (LONE_SURROGATE_RE.test(s)) {
    throw new TypeError('canonicalJsonBytes：字符串含孤立代理项，无法 UTF-8 编码（对齐 Python UnicodeEncodeError，ADR-051 D4 边界③）');
  }
  return JSON.stringify(s);
}

function writeCanonical(v, out) {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      out.push(numberToPy(v));
      return;
    case 'bigint':
      out.push(v.toString());
      return;
    case 'string':
      out.push(stringToPy(v));
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJsonBytes 不支持的值类型: ${typeof v}（JSON 值域外）`);
  }
  if (Array.isArray(v)) {
    out.push('[');
    v.forEach((item, i) => {
      if (i > 0) out.push(',');
      writeCanonical(item, out);
    });
    out.push(']');
    return;
  }
  // 非普通对象一律拒（Date/RegExp/Buffer/Map/Set 等经 Object.keys 会静默成 {}——对齐 Python
  // 对未知类型的 TypeError 语义；JSON.parse 产物与对象字面量 constructor===Object 恒过）
  if (v.constructor !== Object) {
    throw new TypeError(`canonicalJsonBytes 只接受 JSON 值域（普通对象/数组/原始值/BigInt），收到 ${v.constructor?.name ?? typeof v}`);
  }
  const keys = Object.keys(v).sort(codePointCompare);
  out.push('{');
  keys.forEach((k, i) => {
    if (i > 0) out.push(',');
    out.push(stringToPy(k), ':');
    writeCanonical(v[k], out);
  });
  out.push('}');
}

/**
 * 规范性 JSON 字节（键按码点排序、无空白、UTF-8）——对齐 common.canonical_json_bytes，
 * receipt/报告完整性哈希的输入。自写序列化器（JSON.stringify 的 BigInt 抛错、NaN→null、
 * 键序不定三处分叉，均不可用）。
 * @param {unknown} value
 * @returns {Buffer}
 */
export function canonicalJsonBytes(value) {
  const out = [];
  writeCanonical(value, out);
  return Buffer.from(out.join(''), 'utf8');
}

/**
 * 读取 JSON 对象（对齐 common.load_json）；根非 plain object（含数组/null）抛
 * Error（消息含「JSON 根不是对象: <path>」），解析失败抛 SyntaxError，不存在抛 ENOENT。
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
/**
 * 严格 UTF-8 文本读取（内部任务-85 终审发现 3 提升）：readFileSync(path,'utf8') 对无效字节做
 * U+FFFD 静默替换（Python read_text(encoding='utf-8') 抛 UnicodeDecodeError）——Buffer
 * 往返比对拦下。probes/config/governance 的配置与签名库读取共用（loadJson 内嵌同款语义）。
 * @param {string} path
 * @returns {string}
 */
export function readUtf8Strict(path) {
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!buf.equals(Buffer.from(text, 'utf8'))) {
    const err = new Error(`文件不是有效 UTF-8: ${path}`);
    err.code = 'INVALID_UTF8'; // E02（内部任务-241）：工具错误须可被 CLI 分类退 2，而非内容阻断
    throw err;
  }
  return text;
}

export function loadJson(path) {
  // 严格 UTF-8：readFileSync(path,'utf8') 对无效字节做 U+FFFD 静默替换（Python 抛
  // UnicodeDecodeError→value-error 族），经 Buffer 往返比对拦下（有效内容中的 U+FFFD 往返一致不误伤）
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!buf.equals(Buffer.from(text, 'utf8'))) {
    const err = new Error(`文件不是有效 UTF-8: ${path}`);
    err.code = 'INVALID_UTF8';
    throw err;
  }
  const data = JSON.parse(text);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`JSON 根不是对象: ${path}`);
  }
  return data;
}

/**
 * 原子写（对齐 common.atomic_write_bytes）：同目录唯一临时文件（wx 独占＋随机后缀，
 * EEXIST 重试 ≤5 次）→ write → fsync → rename（os.replace 等价）；任何异常清理临时文件后上抛。
 * @param {string} path
 * @param {Uint8Array} data
 * @returns {void}
 */
export function atomicWriteBytes(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  let ownedTmp = null; // 仅记录本进程成功创建的临时件（终审正确性发现 3：撞名文件的持有者是并发写者，清理不得误删）
  try {
    for (let attempt = 0; ; attempt += 1) {
      // 每次重试重摇随机名（对齐 tempfile.mkstemp 语义——同名重试在占用者让位前必继续 EEXIST）
      const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}`);
      try {
        fd = openSync(tmp, 'wx', 0o600);
        ownedTmp = tmp;
        break;
      } catch (e) {
        if (e.code === 'EEXIST' && attempt < 5) continue;
        throw e;
      }
    }
    const written = writeSync(fd, data);
    if (written !== data.length) {
      const err = new Error(`短写：${written}/${data.length} 字节（ENOSPC 类场景——拒绝静默截断落盘）`);
      err.code = 'SHORT_WRITE';
      throw err;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(ownedTmp, path);
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已关闭——清理路径尽力 */ }
    }
    if (ownedTmp) {
      try { unlinkSync(ownedTmp); } catch { /* 清理尽力，不掩盖原始异常 */ }
    }
    throw e;
  }
}

/**
 * 原子写 UTF-8 文本（LF 行尾由调用方保证，对齐 common.atomic_write_text）。
 * @param {string} path
 * @param {string} text
 * @returns {void}
 */
export function atomicWriteText(path, text) {
  atomicWriteBytes(path, Buffer.from(text, 'utf8'));
}

/**
 * 宽松 realpath：自目标上溯找最长存在前缀做 realpathSync，余段字面拼接——对齐
 * os.path.realpath 对不存在尾段的语义（不要求路径存在）。isWithinRoot 与 probes.mjs
 * 的路径防护共用（内部任务-85 起导出）。
 * @param {string} p
 * @returns {string}
 */
export function looseRealpath(p) {
  let current = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      // 对齐 os.path.realpath 非 strict 语义：解析失败（不存在/权限受限/循环链接）
      // 保留原段继续上溯，不向调用方抛
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * 判定解析后的目标路径是否仍在项目根内（对齐 common.is_within_root）：realpath 解析
 * symlink、越界即 false；分隔符边界判定（/a/bc 不在 /a/b 内）；root===target 为 true。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isWithinRoot(root, target) {
  const rootReal = looseRealpath(root);
  const targetReal = looseRealpath(target);
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return targetReal === rootReal || targetReal.startsWith(prefix);
}
