// 文件：probes.mjs
// 描述：JS 原生实现（历史 Python 实现已于阶段3b/内部任务-100 删除）——八类只读状态探针＋路径双基/
//       穿越拒绝＋dir-tree-hash＋宿主签名库判定。语义基准＝阶段3b 前 Python 现行为（含缺陷行为；
//       迁移窗口已结束，疑似缺陷按正常批次处置）；判据结构
//       ＝[{criterion, evidenceRef, probe}]（探针在 probe 键下，生产者/验证者分离，
//       无 probe 键的纯文本项跳过＝人核证据）。
//       历史对拍面已随阶段3b 删除；黄金面 tests/golden/dir-tree-hash.json 保留。
//       host 判定＝三 adapter 各一份读取者（zcode/mcode/kimi 的 src/host-presence.mjs）＋本件
//       assurance 执行者；dsh 仅本件一读（无独立 adapter 探测面）——内部决策-048 决策 7「第四宿主入套
//       再裁」已由 内部决策-054 G-04/G-05 裁决（签名行＋词表扩面，三 adapter 只读不动）。
//       treeHash 与 zcode-adapter/src/expect-tree.mjs 同构互证（分帧逐字，内部未决-51 形态——
//       插件自含边界不 import，两端口径由黄金/行为断言锁定）。
//       注入缝：命名 opts（homeOverride/spawnImpl/platform/env/signaturesPath）——历史 Python
//       home_override 形参＋三 adapter host-presence.mjs 参数缝先例（ESM 导出不可赋值）。
//       已登记边界（门①终审处置，2026-10-18）：⑤JSON 值经 JSON.parse 后 int/float 形态
//       不可分（Python 1.0≠1 严格型——jsonl match 严格相等面）与超 2^53 丢位（common.mjs
//       边界①②同族，凭据值域无 float 命中）；⑥盘符段拒绝（C:/x）系 JS 有意加严（POSIX 上
//       Python 放行拼入根内——win32 穿越防护前置全平台，更严不假绿）；⑦rc≠0 且 stdout 仅
//       BOM 时 JS trim 视空、Python strip 非空（宿主命令输出仅 BOM 的极窄形态）；⑧断链
//       symlink 的路径解析分叉见 common.mjs 边界⑤。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { codePointCompare, isWithinRoot, looseRealpath, pyEquals, readUtf8Strict, sha256File, sha256Hex } from './common.mjs';

/** 探针类型词表（与历史 Python 实现 PROBE_TYPES 同值）。 */
export const PROBE_TYPES = [
  'file-exists', 'file-sha256', 'json-field-eq', 'jsonl-record-field-eq',
  'dir-tree-hash', 'acl-state', 'audit-policy-state', 'host-app-present',
];

/** 无 path 概念的类型（audit-policy 提权命令无目标路径；宿主应用位在路径双基之外——签名库承载，内部决策-048）。 */
export const PATH_OPTIONAL_TYPES = new Set(['audit-policy-state', 'host-app-present']);

/** 路径双基。 */
export const PATH_BASES = ['project', 'user-home'];

/** dir-tree-hash 默认忽略表（与历史 Python 实现 DEFAULT_IGNORE 同值）。 */
export const DEFAULT_IGNORE = ['__pycache__', '.mimosa', '*.pyc'];

/** icacls 权限简码白名单（与历史 Python 实现 ACL_RIGHTS 同集，20 项）。 */
export const ACL_RIGHTS = new Set(['F', 'M', 'RX', 'R', 'W', 'X', 'DE', 'RC', 'WD', 'AD', 'WEA', 'GR', 'GE', 'GW', 'GA', 'RD', 'RA', 'REA', 'WA', 'DC']);

/** 宿主 env 覆盖（与三 adapter host-presence.mjs 同表；dsh 为第四宿主，内部决策-054 G-04）。 */
export const HOST_ENV_OVERRIDE = { zcode: 'ZCODE_APP_ROOT', mcode: 'MINIMAX_APP_ROOT', kimi: 'KIMI_APP_ROOT', dsh: 'DSH_APP_ROOT' };

const GUID_RE = /^\{[0-9A-Fa-f-]{36}\}(?:\n)?$/; // 尾换行容忍：对齐 Python re `$` 在 `\n` 前匹配（门①发现 12）

/** 探针配置错误（坏探针＝CONFIG 级 blocking，不静默不骗绿——对齐 probes.ProbeConfigError）。 */
export class ProbeConfigError extends Error {}

/** JSON 字段路径不存在（对齐 Python KeyError——经 _run_one 漏斗转 ASSERT 档）。 */
class PathKeyError extends Error {}

/** Python str.splitlines 全集行边界（\n \r \v \f \x1c-\x1e \x85 \u2028 \u2029——门①发现 9）。 */
const SPLITLINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function splitLines(text) {
  return text.split(SPLITLINES_RE);
}

const SIGNATURES_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'host-signatures.json');
const signaturesCache = new Map();

/**
 * GUID 形态校验（对齐 probes._guid_ok——判据数据进入 argv 前的唯一白名单关口）。
 * @param {string} v
 * @returns {boolean}
 */
export function guidOk(v) {
  return typeof v === 'string' && GUID_RE.test(v);
}

/**
 * 解析 icacls 输出中指定账户的 DENY ACE 权限集（对齐 probes._parse_icacls_deny：账户段
 * 前邻空白/行首防子串误匹配；段列表含 DENY 标记、取其后逐段拆权限；无 DENY/无匹配行返回 null）。
 * @param {string} text icacls 输出
 * @param {string} account
 * @returns {Set<string>|null}
 */
export function parseIcaclsDeny(text, account) {
  const marker = `${account}:`;
  for (const line of splitLines(String(text))) {
    const idx = line.indexOf(marker);
    if (idx < 0 || (idx > 0 && !/\s/.test(line[idx - 1]))) continue;
    const segs = line.slice(idx + marker.length).split('(')
      .map((s) => s.replace(/\)+$/, ''))
      .filter((s) => s !== '');
    const pos = segs.indexOf('DENY');
    if (pos >= 0) {
      const rights = new Set();
      for (const seg of segs.slice(pos + 1)) {
        for (const p of seg.split(',')) {
          if (p.trim() !== '') rights.add(p.trim());
        }
      }
      return rights;
    }
  }
  return null;
}

/**
 * 解析 auditpol /r CSV：按 GUID 值定位列（大小写不敏感），下一列空→'empty' 非空→'not-empty'；
 * 兼容有/无 Policy Target 列的两种实际布局；找不到 GUID 行抛（判据引用不存在子类别＝断言不成立）。
 * @param {string} text
 * @param {string} guid
 * @returns {'empty'|'not-empty'}
 */
export function parseAuditpolInclusion(text, guid) {
  const want = String(guid).toUpperCase();
  for (const line of splitLines(String(text))) {
    const parts = line.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const idx = parts.findIndex((p) => p.toUpperCase() === want);
    if (idx >= 0) {
      const inclusion = idx + 1 < parts.length ? parts[idx + 1] : '';
      return inclusion ? 'not-empty' : 'empty';
    }
  }
  throw new PathKeyError(guid);
}

/**
 * 点号＋[i] 方言取值（对齐 probes._json_dotted：括号不闭合/下标非数字＝CONFIG；路径不存在
 * 抛 PathKeyError〔对齐 KeyError→ASSERT 档〕；裸数字点号是普通键名）。
 * @param {unknown} data
 * @param {string} field
 * @returns {unknown}
 */
export function jsonDotted(data, field) {
  const tokens = [];
  let token = '';
  let i = 0;
  while (i < field.length) {
    const ch = field[i];
    if (ch === '.') {
      if (token !== '') { tokens.push(token); token = ''; }
      i += 1;
    } else if (ch === '[') {
      if (token !== '') { tokens.push(token); token = ''; }
      const end = field.indexOf(']', i);
      if (end < 0) throw new ProbeConfigError(`json 字段路径括号不闭合：${field}`);
      const idx = field.slice(i + 1, end);
      if (!/^\d+$/.test(idx)) throw new ProbeConfigError(`数组下标须为非负整数：${field}`);
      tokens.push(Number(idx));
      i = end + 1;
    } else {
      token += ch;
      i += 1;
    }
  }
  if (token !== '') tokens.push(token);
  let cur = data;
  for (const t of tokens) {
    if (typeof t === 'number') {
      if (!Array.isArray(cur) || t >= cur.length) throw new PathKeyError(field);
      cur = cur[t];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, t)) throw new PathKeyError(field); // own-key 判定（门①发现 8：in 会命中原型链键）
      cur = cur[t];
    }
  }
  return cur;
}

/**
 * fnmatch 通配翻译（Python fnmatch 子集：* 任意含 /、? 单字、[seq]/[!seq]；POSIX 大小写
 * 敏感、win32 normcase 双侧小写——expect-tree.mjs NORM 先例）。字符类构造对齐 CPython
 * fnmatch.translate（门①发现 10）：`]` 紧邻 `[`/`[^` 入类为字面、`[]` 整体＝字面 `[]`、
 * 末尾无 `]` 时 `[` 为字面、倒序区间构造出非法类＝抛错逃逸（对齐 re.error 逃出捕获元组）。
 */
function fnMatch(name, pattern, caseFold) {
  const n = caseFold ? name.toLowerCase() : name;
  const p = caseFold ? pattern.toLowerCase() : pattern;
  let re = '^';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else if (ch === '[') {
      let j = i + 1;
      let cls = '';
      if (p[j] === '!' || p[j] === '^') { cls = '^'; j += 1; }
      if (p[j] === ']') { cls += '\\]'; j += 1; } // ] 紧邻开头＝字面（translate 同款）
      let closed = false;
      while (j < p.length) {
        if (p[j] === ']') { closed = true; break; }
        if (p[j] === '\\') cls += '\\\\';
        else if (p[j] === '-') cls += '-';
        else cls += p[j].replace(/[()\[\]{}+.^$*?|]/g, '\\$&');
        j += 1;
      }
      if (!closed || cls === '' || cls === '^') { re += '\\['; continue; } // 无 ] 或空类＝字面 [
      re += `[${cls}]`;
      i = j;
    } else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  let compiled;
  try {
    compiled = new RegExp(`${re}$`);
  } catch (e) {
    // 倒序区间等非法类：Python re.error 逃出 _run_one 捕获元组（崩溃即崩溃）
    throw new TypeError(`fnmatch 字符类非法（对齐 re.error 逃逸）: ${pattern}（${e.message}）`);
  }
  return compiled.test(n);
}

/** 忽略判定双分支（历史 Python 实现语义：末段 fnmatch、其余分量精确相等包含）。 */
function isIgnored(parts, ignoreGlobs, caseFold) {
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return ignoreGlobs.some((pat) => fnMatch(last, pat, caseFold) || rest.includes(pat));
}

/**
 * 目录树内容哈希（对齐 probes._tree_hash 分帧逐字：entries 按 rel 码点排序、每条
 * `rel\ndigest\n`、总串 UTF-8 sha256 裸 64hex；os.walk top-down 目录排序＋目录级剪枝；
 * 文件 symlink 按目标内容哈希、目录 symlink 不下潜——statSync 跟随 symlink 判型）。
 * @param {string} rootDir
 * @param {string[]} ignoreGlobs
 * @param {boolean} [caseFold=process.platform==='win32']
 * @returns {string}
 */
export function treeHash(rootDir, ignoreGlobs, caseFold = process.platform === 'win32') {
  const entries = [];
  const walk = (dir, relPrefix) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // 根缺失＝空树（Python os.walk 静默语义；探针分支已在 treeHash 前校验目标存在）。
      if (e !== null && typeof e === 'object' && e.code === 'ENOENT' && dir === rootDir) return;
      // E04（内部任务-241）：其余不可读（EACCES 等）不得静默跳过——部分树哈希会产出误导性结论。
      throw e;
    }
    const dirs = [];
    const files = [];
    for (const it of items) {
      const parts = relPrefix ? [...relPrefix.split('/'), it.name] : [it.name];
      if (isIgnored(parts, ignoreGlobs, caseFold)) continue;
      // withFileTypes 不跟随 symlink：isDirectory 对目录 symlink 为 false——目录链接不下潜
      //（os.walk followlinks=False 语义）；文件 symlink 入 files、哈希时 statSync 跟随目标
      if (it.isDirectory()) dirs.push(it.name);
      else files.push(it.name);
    }
    dirs.sort();
    files.sort();
    for (const name of files) {
      const full = join(dir, name);
      let isFile;
      try {
        isFile = statSync(full).isFile();
      } catch (e) {
        throw e; // 门①发现 4：断链/不可达文件＝对齐 Python sha256_file 外抛→ASSERT 漏斗（不静默跳帧）
      }
      if (!isFile) continue; // 结构性跳过：非文件条目（如指向目录的 symlink——Python fns 无此形态位）
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const digest = sha256File(full); // 不可读（EACCES 等）自然外抛→ASSERT（对齐 PermissionError）
      entries.push([rel, digest]);
    }
    for (const name of dirs) {
      walk(join(dir, name), relPrefix ? `${relPrefix}/${name}` : name);
    }
  };
  walk(rootDir, '');
  // 码点序排序（门①发现 11：默认 < 是 UTF-16 码元序——星形字符与高 BMP 字符排序互换）
  entries.sort((a, b) => codePointCompare(a[0], b[0]));
  const framed = entries.map(([rel, digest]) => `${rel}\n${digest}\n`).join('');
  return sha256Hex(Buffer.from(framed, 'utf8'));
}

/**
 * 装载宿主签名库（惰性＋按路径缓存；坏 JSON/缺 hosts 键 fail-loud）。
 * @param {string} [path]
 * @returns {{version: number, hosts: Record<string, {darwin: string[], win32: string[], linux: string[]}>}}
 */
export function loadHostSignatures(path = SIGNATURES_FILE) {
  const cached = signaturesCache.get(path);
  if (cached) return cached;
  let lib;
  try {
    lib = JSON.parse(readUtf8Strict(path));
  } catch (e) {
    throw new ProbeConfigError(`宿主签名库不可读: ${path}（${e.message}）`);
  }
  if (!lib || typeof lib !== 'object' || !lib.hosts) {
    throw new ProbeConfigError(`宿主签名库缺 hosts 键: ${path}`);
  }
  signaturesCache.set(path, lib);
  return lib;
}

/** 平台三态（对齐 probes._current_platform：win32/darwin/linux 外返回空串＝无候选 fail-loud——linux 2026-11-02 内部任务-281 起 zcode 有取证候选、mcode/kimi/dsh 空占位仍 fail-loud，内部未决-208）。 */
function currentPlatform(opts) {
  const p = opts.platform ?? process.platform;
  return p === 'win32' || p === 'darwin' || p === 'linux' ? p : '';
}

/**
 * 宿主候选展开（对齐 probes._host_candidates：env 覆盖单候选优先；平台无记载/列空/元素
 * 非法 ⇒ ProbeConfigError fail-loud 不骗绿；`~/` 按 home 注入缝展开）。
 */
function hostCandidates(host, opts) {
  const override = (opts.env ?? process.env)[HOST_ENV_OVERRIDE[host]] ?? '';
  if (override) return [override];
  const platform = currentPlatform(opts);
  const entries = platform ? loadHostSignatures(opts.signaturesPath).hosts?.[host]?.[platform] : null;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProbeConfigError(`宿主 ${host} 在本平台（${platform || process.platform}）无签名候选（候选列为空，不可机检 fail-loud，转人工复核；签名库候选契约见 IF-COLLAB-11 §2（ADR-048））`);
  }
  if (!entries.every((e) => typeof e === 'string' && e !== '' && e !== '~/')) {
    throw new ProbeConfigError(`宿主 ${host} 签名候选含非法元素（须非空字符串路径；~/ 须带具体相对段）`);
  }
  const home = opts.homeOverride ?? homedir();
  return entries.map((e) => (e.startsWith('~/') ? join(home, e.slice(2)) : e));
}

/**
 * spawn 单点（对齐 probes._spawn_template：argv 模板代码内置、/subcategory: 参数 GUID 前置
 * 守卫、30s 超时转译、非零退出双态——stdout 空 fail-loud〔OSError→ASSERT〕、非空交解析器
 * 〔icacls rc=3 部分成功语义〕）。注入缝：opts.spawnImpl 覆盖（返回文本）。
 * @param {string[]} argv
 * @param {{spawnImpl?: Function}} [opts]
 * @returns {string}
 */
function spawnTemplate(argv, opts = {}) {
  for (const arg of argv) {
    if (arg.startsWith('/subcategory:') && !guidOk(arg.slice('/subcategory:'.length))) {
      throw new ProbeConfigError(`subcategory 参数非 GUID 形态：${JSON.stringify(arg)}`);
    }
  }
  if (opts.spawnImpl) return opts.spawnImpl(argv);
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw new Error(`外部状态命令超时/不可用（30s）：${argv[0]}（${r.error.code ?? r.error.message}）`);
  const stdout = r.stdout ?? '';
  if (r.status !== 0 && stdout.trim() === '') {
    throw new Error(`外部状态命令失败 rc=${r.status}（无可用输出）：${argv[0]}（stderr 摘要：${String(r.stderr ?? '').trim().slice(0, 200)}）`);
  }
  return stdout;
}

/**
 * 探针路径解析（对齐 probes.resolve_probe_path：形态坏/非法 base/绝对路径/.. 段抛
 * ProbeConfigError；realpath 后越界拒绝）。
 * @param {string} root
 * @param {{base?: string, rel?: string}} spec
 * @param {{homeOverride?: string}} [opts]
 * @returns {string}
 */
export function resolveProbePath(root, spec, opts = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || !spec.base || !spec.rel) {
    throw new ProbeConfigError(`path 形态非法（须含 base+rel）：${JSON.stringify(spec)}`);
  }
  let baseRoot;
  if (spec.base === 'project') baseRoot = realpathSync(root);
  else if (spec.base === 'user-home') baseRoot = realpathSync(opts.homeOverride ?? homedir());
  else throw new ProbeConfigError(`非法 base：${spec.base}（合法：${PATH_BASES}）`);
  const rel = String(spec.rel).replaceAll('\\', '/');
  const parts = rel.split('/').filter((p) => p !== '');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || parts.includes('..')) {
    throw new ProbeConfigError(`rel 须为基内相对路径且不含 ..：${spec.rel}`);
  }
  const target = looseRealpath(join(baseRoot, ...parts));
  if (!isWithinRoot(baseRoot, target)) {
    throw new ProbeConfigError(`路径穿越拒绝：${target} 不在 ${spec.base} 基 ${baseRoot} 内`);
  }
  return target;
}

/** json-field-eq 的宽松相等＝common.pyEquals（Python ==：bool↔number 等值〔True==1〕；str↔number 不等）。 */
const looseJsonEq = (a, b) => pyEquals(a, b);

/** jsonl 的严格类型相等：**仅顶层**禁 True==1；容器内按 Python `==` 宽松深比较
 * （对齐 Python `type(got) is not type(want) or got != want`——嵌套 `[1] == [True]` 为真；
 * 内部任务-242 正确性复审 C-1：不得把 strictTypes 递归进容器，避免既有探针误报）。 */
const strictJsonEq = (a, b) => {
  if (typeof a === 'boolean' || typeof b === 'boolean') return typeof a === typeof b && a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (typeof a === 'object') return pyEquals(a, b); // 嵌套宽松（原 deepJsonEq→looseJsonEq 语义）
  return a === b;
};

/** 测试注入面（内部任务-242 C-1）：相等语义单测用。 */
export const _jsonEqInternals = { looseJsonEq, strictJsonEq };

/** ASSERT 档诊断（对齐 probes._diag 的 `[<type>] message` 前缀形态）。 */
function diagAssert(probe, message) {
  return { ruleId: 'RULE-GATE-OPASSERT', severity: 'blocking', message: `[${probe.type ?? '?'}] ${message}` };
}

/** Python str() 形态（终审正确性发现 8：ref 字段非字符串时的字符串化——null→'None'、
 * true→'True'、大数/浮点按 repr 指数阈值〔pyFloatRepr 的整数塌缩面以值域登记：ref
 * 双读现实值域为路径字符串，非字符串可达性低〕）。 */
function strPy(v) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'object') return JSON.stringify(v); // 值域不达——防御（Python str(dict) 异形）
  return String(v);
}

/** evalRef（对齐 probes._eval_ref：形态坏/非法 transform→CONFIG；文件缺失/字段缺失→ASSERT 档异常）。 */
function evalRef(ref, root, opts) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref) || !ref.refPath || !ref.refField) {
    throw new ProbeConfigError(`ref 形态非法（须 refPath+refField）：${JSON.stringify(ref)}`);
  }
  // refBase 仅键缺失回落 'project'（终审正确性发现 4：显式 null 保留——Python .get 默认值
  // 只补键缺失，null 值流入 resolve 的形态校验＝CONFIG 阻断；?? 会把 null 归并＝假绿方向）
  const refBase = 'refBase' in ref ? ref.refBase : 'project';
  const refFile = resolveProbePath(root, { base: refBase, rel: ref.refPath }, opts);
  let st;
  try { st = statSync(refFile); } catch { st = null; }
  if (!st || !st.isFile()) throw new Error(`ref 文件不存在：${refFile}`);
  const data = JSON.parse(readUtf8Strict(refFile));
  const value = jsonDotted(data, ref.refField);
  const transform = ref.refTransform;
  if (transform === 'last-segment') {
    return strPy(value).replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop();
  }
  if (transform !== undefined && transform !== null) {
    throw new ProbeConfigError(`非法 refTransform：${transform}（v1 仅 last-segment）`);
  }
  return value;
}

/**
 * 单探针执行（对齐 probes._run_one 分派序与漏斗）：通过返回 null；断言不成立返回 ASSERT 诊断；
 * 坏探针（形态）经漏斗转 CONFIG 诊断；执行异常（IO/路径缺失/坏 JSON）转 ASSERT 诊断。
 * TypeError 逃逸（对齐 Python 捕获元组不含 TypeError——不可哈希判据崩溃即崩溃）。
 */
function runOne(root, probe, opts) {
  try {
    if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) {
      // 对齐 Python probe.get → AttributeError 逃出捕获元组（崩溃即崩溃，门①发现 15）
      throw new TypeError(`probe 须为对象: ${JSON.stringify(probe)}`);
    }
    const ptype = probe.type;
    if (!PROBE_TYPES.includes(ptype)) {
      throw new ProbeConfigError(`非法探针类型：${JSON.stringify(ptype)}（v2 合法：${PROBE_TYPES}）`);
    }
    const expect = probe.expect ?? null; // Python .get 缺省 None（门①发现 5：undefined 归一 null——null 值期望与缺省通过语义一致）

    if (ptype === 'file-exists') {
      const target = resolveProbePath(root, probe.path ?? {}, opts);
      const want = expect !== false;
      const kind = probe.kind;
      if (kind !== undefined && kind !== null && !['file', 'dir'].includes(kind)) {
        throw new ProbeConfigError(`file-exists 的 kind 非法：${JSON.stringify(kind)}（合法：file/dir）`);
      }
      let st = null;
      try { st = statSync(target); } catch { st = null; }
      let exists;
      if (kind === 'file') exists = st !== null && st.isFile();
      else if (kind === 'dir') exists = st !== null && st.isDirectory();
      else exists = st !== null;
      if (exists !== want) {
        return diagAssert(probe, `file-exists 期望${want ? '存在' : '不存在'}，实际${exists ? '存在' : '不存在'}：${target}`);
      }
      return null;
    }

    if (ptype === 'file-sha256') {
      const target = resolveProbePath(root, probe.path ?? {}, opts);
      if (typeof expect !== 'string' || expect === '') throw new ProbeConfigError('file-sha256 的 expect 须为非空 sha256 字符串');
      let st = null;
      try { st = statSync(target); } catch { st = null; }
      if (!st || !st.isFile()) return diagAssert(probe, `file-sha256 目标文件不存在：${target}`);
      const actual = sha256File(target);
      const want = expect.startsWith('sha256:') ? expect.slice(7) : expect;
      if (actual !== want) return diagAssert(probe, `file-sha256 不匹配：${target} 期望 ${want} 实际 ${String(actual).slice(0, 8)}…（仅前缀，S01 脱敏）`);
      return null;
    }

    if (ptype === 'acl-state') {
      const target = resolveProbePath(root, probe.path ?? {}, opts);
      if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
        throw new ProbeConfigError('acl-state 的 expect 须为对象（denyAccount/denyRights）');
      }
      const account = expect.denyAccount;
      if (typeof account !== 'string' || account.trim() === '') {
        throw new ProbeConfigError('acl-state 的 expect.denyAccount 须为非空字符串');
      }
      const rights = expect.denyRights;
      if (rights !== undefined && rights !== null) {
        if (!Array.isArray(rights) || !rights.every((r) => typeof r === 'string' && ACL_RIGHTS.has(r))) {
          throw new ProbeConfigError(`acl-state 的 denyRights 须为 ACL_RIGHTS 白名单内简码数组：${[...ACL_RIGHTS].sort()}`);
        }
      }
      const actualRights = parseIcaclsDeny(spawnTemplate(['icacls', target], opts), account);
      if (actualRights === null) return diagAssert(probe, `未找到 ${account} 的 DENY ACE：${target}`);
      if (rights != null && ![...rights].every((r) => actualRights.has(r))) {
        return diagAssert(probe, `DENY 权限不包含期望：期望 ${[...rights].sort()} 实际 ${[...actualRights].sort()}`);
      }
      return null;
    }

    if (ptype === 'audit-policy-state') {
      // 无 path 概念（无文件目标），不解析 path（内部决策-030 决策 5）
      if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
        throw new ProbeConfigError('audit-policy-state 的 expect 须为对象（subcategoryGuid/inclusion）');
      }
      const guid = expect.subcategoryGuid;
      if (typeof guid !== 'string' || !guidOk(guid)) {
        throw new ProbeConfigError('audit-policy-state 的 subcategoryGuid 须为 GUID 形态：{...}');
      }
      const inclusion = expect.inclusion;
      if (inclusion !== 'empty' && inclusion !== 'not-empty') {
        throw new ProbeConfigError('audit-policy-state 的 inclusion 须为 empty|not-empty');
      }
      const actual = parseAuditpolInclusion(spawnTemplate(['auditpol', '/get', `/subcategory:${guid}`, '/r'], opts), guid);
      if (actual !== inclusion) return diagAssert(probe, `审计策略 Inclusion 期望 ${inclusion} 实际 ${actual}（${guid}）`);
      return null;
    }

    if (ptype === 'host-app-present') {
      // 无 path 概念（宿主应用位在路径双基之外——签名库承载，内部决策-048 决策 1/2）；判定与
      // 三 adapter Node 侧同库同语义（同候选表/同 env 覆盖/同 ~ 展开）——第五份实现互证
      if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
        throw new ProbeConfigError('host-app-present 的 expect 须为对象（host/presence）');
      }
      const host = expect.host;
      if (typeof host !== 'string' || !(host in HOST_ENV_OVERRIDE)) {
        throw new ProbeConfigError(`host-app-present 的 host 须为 zcode|mcode|kimi|dsh：${JSON.stringify(host)}（ADR-048/ADR-054）`);
      }
      const presence = expect.presence;
      if (presence !== 'present' && presence !== 'absent') {
        throw new ProbeConfigError('host-app-present 的 presence 须为 present|absent（双向——预装可断言 absent）');
      }
      const actualPresence = hostCandidates(host, opts).some((c) => existsSync(c)) ? 'present' : 'absent';
      if (actualPresence !== presence) {
        return diagAssert(probe, `宿主 ${host} 在位期望 ${presence} 实际 ${actualPresence}（可设 ${HOST_ENV_OVERRIDE[host]} 指定安装位）`);
      }
      return null;
    }

    if (ptype === 'dir-tree-hash') {
      const target = resolveProbePath(root, probe.path ?? {}, opts);
      if (typeof expect !== 'string' || expect === '') throw new ProbeConfigError('dir-tree-hash 的 expect 须为非空 sha256 字符串');
      let st = null;
      try { st = statSync(target); } catch { st = null; }
      if (!st || !st.isDirectory()) return diagAssert(probe, `dir-tree-hash 目标目录不存在：${target}`);
      const ignores = [...DEFAULT_IGNORE];
      const extra = probe.ignore;
      if (extra !== undefined && extra !== null) {
        if (!Array.isArray(extra) || !extra.every((x) => typeof x === 'string')) {
          throw new ProbeConfigError('ignore 须为字符串数组');
        }
        ignores.push(...extra);
      }
      const actual = treeHash(target, ignores);
      const want = expect.startsWith('sha256:') ? expect.slice(7) : expect;
      if (actual !== want) return diagAssert(probe, `dir-tree-hash 不匹配：${target} 期望 ${want} 实际 ${String(actual).slice(0, 8)}…（仅前缀，S01 脱敏）`);
      return null;
    }

    if (ptype === 'jsonl-record-field-eq') {
      const jtarget = resolveProbePath(root, probe.path ?? {}, opts);
      const jfield = probe.field;
      if (typeof jfield !== 'string' || jfield === '') throw new ProbeConfigError('jsonl-record-field-eq 须含非空 field');
      const jmatch = probe.match;
      if (jmatch !== undefined && jmatch !== null && (typeof jmatch !== 'object' || jmatch === null)) {
        throw new ProbeConfigError('jsonl-record-field-eq 的 match 须为对象或数组');
      }
      let st = null;
      try { st = statSync(jtarget); } catch { st = null; }
      if (!st || !st.isFile()) return diagAssert(probe, `jsonl-record-field-eq 目标文件不存在：${jtarget}`);
      const records = [];
      const lines = splitLines(readUtf8Strict(jtarget));
      for (let lineno = 1; lineno <= lines.length; lineno += 1) {
        const raw = lines[lineno - 1];
        if (raw.trim() === '') continue;
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch (e) {
          // 显式转译：坏行属形态/配置错（放任落外层会假红/假绿——收尾评审漏斗修复）
          throw new ProbeConfigError(`jsonl 第 ${lineno} 行不是合法 JSON：${e.message}`);
        }
        if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
          throw new ProbeConfigError(`jsonl 第 ${lineno} 行不是 JSON 对象`);
        }
        records.push(rec);
      }
      const pairs = [];
      if (jmatch != null && !Array.isArray(jmatch)) pairs.push(...Object.entries(jmatch));
      else if (Array.isArray(jmatch)) {
        for (const item of jmatch) {
          if (item === null || typeof item !== 'object' || !('field' in item) || !('equals' in item)) {
            throw new ProbeConfigError('match 数组项须为 {field, equals} 形态（缺键即配置错，不得静默按 null 比较）');
          }
          pairs.push([item.field, item.equals]);
        }
      }
      if (probe.ref !== undefined && probe.ref !== null) {
        throw new ProbeConfigError('jsonl-record-field-eq 不支持 ref（双读仅 json-field-eq 提供）');
      }
      for (const [key] of pairs) {
        if (typeof key !== 'string' || key === '') throw new ProbeConfigError('match 的字段名须为非空字符串');
      }
      let hit = null;
      for (const rec of records) {
        let ok = true;
        for (const [key, want] of pairs) {
          let got;
          try {
            got = jsonDotted(rec, key);
          } catch (e) {
            if (e instanceof PathKeyError) { ok = false; break; } // 路径缺失＝不匹配继续
            throw e; // 词法坏（ProbeConfigError）→外层 CONFIG（门①发现 7：裸 catch 会吞成 ASSERT）
          }
          if (!strictJsonEq(got, want)) { ok = false; break; }
        }
        if (ok) hit = rec; // 不 break：末条为准（内部接口-20 §4 读侧口径）
      }
      if (hit === null) return diagAssert(probe, `jsonl 无匹配记录：match=${JSON.stringify(jmatch)}（文件 ${jtarget}）`);
      let actual;
      try {
        actual = jsonDotted(hit, jfield);
      } catch (e) {
        if (e instanceof PathKeyError) {
          return diagAssert(probe, `json 字段路径不存在：${jfield}（命中记录已脱敏，不输出内容）`);
        }
        throw e;
      }
      if (!strictJsonEq(actual, expect)) {
        return diagAssert(probe, `jsonl-record-field-eq 不匹配：${jtarget}#${jfield}（期望值与实际值均不回显——请在本机人工核对记录内容）`);
      }
      return null;
    }

    if (ptype === 'json-field-eq') {
      const target = resolveProbePath(root, probe.path ?? {}, opts);
      const field = probe.field;
      if (typeof field !== 'string' || field === '') throw new ProbeConfigError('json-field-eq 须含非空 field（点号+[i] 路径）');
      let st = null;
      try { st = statSync(target); } catch { st = null; }
      if (!st || !st.isFile()) return diagAssert(probe, `json-field-eq 目标文件不存在：${target}`);
      const data = JSON.parse(readUtf8Strict(target));
      let actual;
      try {
        actual = jsonDotted(data, field);
      } catch (e) {
        if (e instanceof PathKeyError) {
          return diagAssert(probe, `json 字段路径不存在：${field}（文件 ${target}）`);
        }
        throw e; // 词法坏→外层 CONFIG（门①发现 7）
      }
      const wanted = probe.ref !== undefined && probe.ref !== null ? evalRef(probe.ref, root, opts) : expect;
      if (!looseJsonEq(actual, wanted)) {
        return diagAssert(probe, `json-field-eq 不匹配：${target}#${field}（期望值与实际值均不回显——请在本机人工核对文件内容）`);
      }
      return null;
    }

    // 分派闭环（内部未决-102②）：白名单与分支集脱节时显式拒绝而非静默落尾
    throw new ProbeConfigError(`未实现分派: ${ptype}`);
  } catch (e) {
    if (e instanceof ProbeConfigError) {
      return { ruleId: 'RULE-GATE-OPASSERT-CONFIG', severity: 'blocking', message: `探针配置错误：${e.message}` };
    }
    if (e instanceof TypeError) throw e; // 对齐 Python 捕获元组不含 TypeError——不可哈希判据崩溃即崩溃
    return diagAssert(probe, `探针执行异常：${e.constructor.name}: ${e.message}`);
  }
}

/**
 * 探针执行器（对齐 probes.run_probes）：判据项＝{criterion, evidenceRef, probe}——探针在
 * probe 键下；无 probe 键的纯文本项跳过（人核证据，legacy 兼容）；项非对象抛 ProbeConfigError
 * （gate 捕获转 CONFIG 报告）；返回固定六键。
 * @param {string} root
 * @param {Array<object>} criteria
 * @param {{homeOverride?: string, spawnImpl?: Function, platform?: string, env?: object, signaturesPath?: string}} [opts]
 * @returns {{present: boolean, total: number, passed: number, failed: number, legacy: boolean, diagnostics: Array<object>}}
 */
export function runProbes(root, criteria, opts = {}) {
  const diagnostics = [];
  let total = 0;
  let passed = 0;
  for (const item of criteria) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProbeConfigError(`criteria 项须为对象：${JSON.stringify(item)}`);
    }
    const probe = item.probe;
    if (probe === undefined || probe === null) continue; // 纯文本判据：不机检
    total += 1;
    const diag = runOne(root, probe, opts);
    if (diag === null) passed += 1;
    else diagnostics.push(diag);
  }
  return { present: true, total, passed, failed: total - passed, legacy: total === 0, diagnostics };
}
