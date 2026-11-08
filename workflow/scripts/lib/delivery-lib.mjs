// 文件：delivery-lib.mjs
// 描述：保密交付共享库（内部决策-062 / 内部任务-186）——contract（CDM）/policy（保密策略）schema
//       校验、白名单展开、四形态引用抽取、lint 规则闭集、manifest 计算与报告/审计包模板渲染。
//       单源：deliver-export.mjs 与 deliver-lint.mjs 都只消费本库，不得各自维护第二套规则。
//       边界：零内置保密词表/内部路径清单/固定档位——全部分类规则来自 policy（用户可编辑）；
//       结构性默认仅 visibilitySource 缺省探测 内部规格（缺省缺席=无来源，不报错）。
//       悬空引用恒 blocking、无降级开关（内部决策-062 修正案 1）。
//       内部决策-062 修正案 3：internal.textPathPatterns 为可选文本扫描分面（缺省/显式空数组均回落 pathPatterns；
//       提交信息/作者面恒用 pathPatterns）；CLI 直跑以 process.exitCode 退出保证 POSIX 管道 stdout 完整。
//       内部决策-062 修正案 4：scan.include 扩展扫描面（无扩展名/非文档扩展名文件可纳入词表）；路径 token 首字符
//       允许 `.`（dot 目录文本规则生效）；policy.rewrite 投影期内容改写（文档/测试/夹具全文本面、生产代码仅
//       注释面；静态规则、确定性、改写后零残留硬检 rewrite-residual）。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；只读逻辑（写盘只由 CLI 的事务面执行）。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 库目录 → 插件模板目录（<plugin>/scripts/lib → <plugin>/templates/delivery）。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = resolve(LIB_DIR, '..', '..', 'templates', 'delivery');

/** 规则闭集（blocking；内部决策-062 修正案 1 / 内部接口-25 §4）。 */
export const RULES = Object.freeze({
  CONTRACT_MISSING: 'contract-missing-item',
  UNLISTED: 'unlisted-file',
  INTERNAL_PATTERN: 'internal-pattern',
  INTERNAL_ARTIFACT: 'internal-artifact-present',
  DANGLING: 'dangling-reference',
  ESCAPES_ROOT: 'reference-escapes-root',
  REMOVED_DOC: 'removed-doc-reference',
  MANIFEST_MISSING: 'manifest-missing',
  MANIFEST_HASH: 'manifest-hash-mismatch',
  MANIFEST_EXTRA: 'manifest-extra-file',
  LICENSE_INCOMPLETE: 'license-incomplete',
  REWRITE_RESIDUAL: 'rewrite-residual',
});

export const GENERATED_NAMES = Object.freeze({
  'delivery-report': 'DELIVERY-REPORT.md',
  manifest: 'MANIFEST.sha256.json',
  'audit-packet': 'AUDIT-PACKET.md',
});
export const GENERATORS = Object.freeze(Object.keys(GENERATED_NAMES));
const MANIFEST_NAME = GENERATED_NAMES.manifest;
export { MANIFEST_NAME };
const DEFAULT_SCAN_EXTENSIONS = Object.freeze(['.md', '.txt', '.html', '.htm', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs']);

/** 配置/参数/工具错误（CLI 映射 exit 2）。 */
export class ConfigError extends Error {}
/** 内容违例（CLI 映射 exit 1，携带 violations）。 */
export class ViolationError extends Error {
  /** @param {string} message @param {Array<object>} violations */
  constructor(message, violations) {
    super(message);
    this.violations = violations;
  }
}

/** 读 JSON（缺失/坏 JSON → ConfigError，不静默）。 */
function readJsonStrict(file, label) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`${label} 不存在或不可读：${file}（${e?.code ?? e?.message ?? e}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${label} 不是合法 JSON：${file}（${e.message}）`);
  }
}

/** 只允许出现已知键（未知键＝配置错误；用于拒绝 dangling.mode 等被取代字段）。 */
function rejectUnknownKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ConfigError(`${label} 含未知字段「${k}」（允许：${allowed.join('/')}）`);
  }
}

/** 必填字符串校验。 */
function needString(v, label) {
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${label} 必须是非空字符串`);
  return v;
}

/** 字符串数组校验（非数组/含非字符串即配置错误）。 */
function needStringArray(v, label) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ConfigError(`${label} 必须是字符串数组`);
  return v;
}

/** 正则数组编译（坏正则＝配置错误，不静默跳过）。 */
function compilePatterns(arr, label) {
  return needStringArray(arr, label).map((p) => {
    try {
      return new RegExp(p);
    } catch (e) {
      throw new ConfigError(`${label} 含非法正则「${p}」：${e.message}`);
    }
  });
}

/** 归一仓根相对路径：拒绝绝对路径与 `..`；剥 `./` 与尾 `/`（不允许空）。非法返回 null。 */
function normalizeRelPath(p) {
  const raw = String(p).replaceAll('\\', '/');
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
  const norm = normalize(raw).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === '' || norm === '.' || norm.split('/').includes('..')) return null;
  return norm;
}

/** 拒绝 `.git` 路径段（内部决策-062 D4：路径逃逸/`.git`/内部路径即拒；大小写折叠防 darwin/win32 变体绕过）。 */
function assertNoGitPath(rel, label) {
  const segs = String(rel).replaceAll('\\', '/').toLowerCase().split('/');
  if (segs.includes('.git')) throw new ConfigError(`${label} 不得含 .git 路径段：${rel}`);
}

/** 校验 contract（CDM）——未知字段/缺必填/形态错误即 ConfigError。 */
export function validateContract(contract) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) throw new ConfigError('contract.json 顶层必须是对象');
  rejectUnknownKeys(contract, ['schemaVersion', 'contract', 'items', 'generated', 'acceptance', 'thirdParty', 'audit', 'git'], 'contract.json');
  if (contract.schemaVersion !== 1) throw new ConfigError(`contract.json schemaVersion 必须为 1（收到 ${JSON.stringify(contract.schemaVersion)}）`);
  const head = contract.contract;
  if (head === null || typeof head !== 'object' || Array.isArray(head)) throw new ConfigError('contract.contract 必须是对象');
  rejectUnknownKeys(head, ['id', 'party', 'deliveryDate'], 'contract.contract');
  needString(head.id, 'contract.contract.id');
  needString(head.party, 'contract.contract.party');
  needString(head.deliveryDate, 'contract.contract.deliveryDate');

  if (!Array.isArray(contract.items) || contract.items.length === 0) throw new ConfigError('contract.items 必须是非空数组');
  const itemIds = new Set();
  for (const [i, item] of contract.items.entries()) {
    const label = `contract.items[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ConfigError(`${label} 必须是对象`);
    rejectUnknownKeys(item, ['id', 'kind', 'source', 'target', 'required', 'description', 'audience'], label);
    needString(item.id, `${label}.id`);
    if (itemIds.has(item.id)) throw new ConfigError(`contract.items id 重复：${item.id}`);
    itemIds.add(item.id);
    if (!['file', 'dir', 'glob'].includes(item.kind)) throw new ConfigError(`${label}.kind 必须是 file/dir/glob`);
    const source = needString(item.source, `${label}.source`);
    assertNoGitPath(source, `${label}.source`);
    const normalizedSource = normalizeRelPath(source);
    if (normalizedSource === null) throw new ConfigError(`${label}.source 必须是仓根相对路径且不得含 ..：${source}`);
    item.source = normalizedSource;
    if (item.kind === 'file' && source.includes('*')) throw new ConfigError(`${label}.source 为 file 时不得含通配符`);
    if (item.kind !== 'file' && item.target !== undefined) throw new ConfigError(`${label}.target 仅 file 类型支持`);
    if (item.target !== undefined) {
      const target = needString(item.target, `${label}.target`);
      assertNoGitPath(target, `${label}.target`);
      const normalizedTarget = normalizeRelPath(target);
      if (normalizedTarget === null) throw new ConfigError(`${label}.target 必须是包内相对路径且不得含 ..`);
      item.target = normalizedTarget;
    }
    if (item.required !== undefined && typeof item.required !== 'boolean') throw new ConfigError(`${label}.required 必须是布尔`);
    if (item.audience !== undefined && item.audience !== 'external') throw new ConfigError(`${label}.audience 只允许 external（内部面不进入 CDM，ADR-062 D3）`);
  }

  if (contract.generated !== undefined) {
    if (!Array.isArray(contract.generated)) throw new ConfigError('contract.generated 必须是数组');
    for (const [i, g] of contract.generated.entries()) {
      const label = `contract.generated[${i}]`;
      if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new ConfigError(`${label} 必须是对象`);
      rejectUnknownKeys(g, ['id', 'generator', 'required'], label);
      needString(g.id, `${label}.id`);
      if (!GENERATORS.includes(g.generator)) throw new ConfigError(`${label}.generator 必须属于 ${GENERATORS.join('/')}`);
      if (g.required !== undefined && typeof g.required !== 'boolean') throw new ConfigError(`${label}.required 必须是布尔`);
    }
  }
  if (contract.acceptance !== undefined) {
    if (!Array.isArray(contract.acceptance)) throw new ConfigError('contract.acceptance 必须是数组');
    for (const [i, a] of contract.acceptance.entries()) {
      const label = `contract.acceptance[${i}]`;
      if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new ConfigError(`${label} 必须是对象`);
      rejectUnknownKeys(a, ['contractRequirement', 'criterion', 'result', 'summary'], label);
      needString(a.contractRequirement, `${label}.contractRequirement`);
      needString(a.criterion, `${label}.criterion`);
      if (!['passed', 'failed', 'not-run'].includes(a.result)) throw new ConfigError(`${label}.result 必须是 passed/failed/not-run`);
      needString(a.summary, `${label}.summary`);
    }
  }
  if (contract.thirdParty !== undefined) {
    if (!Array.isArray(contract.thirdParty)) throw new ConfigError('contract.thirdParty 必须是数组');
    for (const [i, t] of contract.thirdParty.entries()) {
      const label = `contract.thirdParty[${i}]`;
      if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new ConfigError(`${label} 必须是对象`);
      rejectUnknownKeys(t, ['name', 'license', 'url', 'attribution'], label);
      needString(t.name, `${label}.name`);
      // license 字段是否必填由 policy.license.requiredFields 决定（license-incomplete 规则），
      // 不在 schema 层硬性拒绝，避免把内容违例误报为配置错误（内部决策-062 修正案 1 口径）。
      if (t.license !== undefined) needString(t.license, `${label}.license`);
    }
  }
  if (contract.audit !== undefined) {
    const a = contract.audit;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new ConfigError('contract.audit 必须是对象');
    rejectUnknownKeys(a, ['enabled', 'rights', 'scope', 'excluded', 'contact'], 'contract.audit');
    if (a.enabled !== undefined && typeof a.enabled !== 'boolean') throw new ConfigError('contract.audit.enabled 必须是布尔');
    if (a.excluded !== undefined) needStringArray(a.excluded, 'contract.audit.excluded');
  }
  if (contract.git !== undefined) {
    const g = contract.git;
    if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new ConfigError('contract.git 必须是对象');
    rejectUnknownKeys(g, ['freshHistory', 'author', 'commitMessage'], 'contract.git');
    if (g.freshHistory !== undefined && typeof g.freshHistory !== 'boolean') throw new ConfigError('contract.git.freshHistory 必须是布尔');
  }
  return contract;
}

/** 校验 policy（保密策略）——全部规则来自用户；空内部规则集须显式 ack。 */
export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new ConfigError('policy.json 顶层必须是对象');
  rejectUnknownKeys(policy, ['schemaVersion', 'internal', 'dangling', 'scan', 'license', 'visibility', 'visibilitySource', 'acknowledgeNoInternalRules', 'rewrite'], 'policy.json');
  if (policy.schemaVersion !== 1) throw new ConfigError(`policy.json schemaVersion 必须为 1（收到 ${JSON.stringify(policy.schemaVersion)}）`);
  const internal = policy.internal ?? {};
  if (typeof internal !== 'object' || Array.isArray(internal)) throw new ConfigError('policy.internal 必须是对象');
  rejectUnknownKeys(internal, ['pathPatterns', 'idPatterns', 'termPatterns', 'textPathPatterns'], 'policy.internal');
  const pathPatterns = needStringArray(internal.pathPatterns, 'policy.internal.pathPatterns');
  const idPatterns = needStringArray(internal.idPatterns, 'policy.internal.idPatterns');
  const termPatterns = needStringArray(internal.termPatterns, 'policy.internal.termPatterns');
  // 内部决策-062 修正案 3：可选文本扫描分面（仅形态校验；空数组语义在 compileInternalRules 回落 pathPatterns）。
  needStringArray(internal.textPathPatterns, 'policy.internal.textPathPatterns');
  // pathPatterns 是 glob（内部路径），在消费点经 globToRegExp 编译；id/term 是正则。
  compilePatterns(idPatterns, 'policy.internal.idPatterns');
  compilePatterns(termPatterns, 'policy.internal.termPatterns');
  if (pathPatterns.length + idPatterns.length + termPatterns.length === 0) {
    const ack = policy.acknowledgeNoInternalRules;
    if (ack === null || typeof ack !== 'object' || typeof ack.reason !== 'string' || ack.reason.trim().length < 8) {
      throw new ConfigError('policy.internal 三类规则全为空时必须显式 acknowledgeNoInternalRules.reason（≥8 字，防零规则假绿）');
    }
  } else if (policy.acknowledgeNoInternalRules !== undefined) {
    rejectUnknownKeys(policy.acknowledgeNoInternalRules, ['reason'], 'policy.acknowledgeNoInternalRules');
  }
  const dangling = policy.dangling ?? {};
  if (typeof dangling !== 'object' || Array.isArray(dangling)) throw new ConfigError('policy.dangling 必须是对象');
  rejectUnknownKeys(dangling, ['allowExternal', 'allowPatterns'], 'policy.dangling');
  if (dangling.allowExternal !== undefined && typeof dangling.allowExternal !== 'boolean') throw new ConfigError('policy.dangling.allowExternal 必须是布尔');
  const allowPatterns = needStringArray(dangling.allowPatterns, 'policy.dangling.allowPatterns');
  // 自定义豁免仅允许「scheme 前缀」形态（如 urn:）：含路径分隔/上跳/盘符的前缀会把本地逃逸路径
  // 整条豁免，构成降级开关（内部决策-062 修正案 1：恒 blocking、无降级开关）。
  for (const p of allowPatterns) {
    if (!/^[a-z][a-z0-9+.-]*:$/i.test(p)) throw new ConfigError(`policy.dangling.allowPatterns 只允许 scheme 前缀形态（如 urn:）：${p}`);
    const scheme = p.slice(0, -1).toLowerCase();
    if (scheme.length === 1) throw new ConfigError(`policy.dangling.allowPatterns 不得用单字母 scheme（盘符）前缀：${p}`);
    if (['file', 'javascript', 'vbscript', 'data'].includes(scheme)) {
      throw new ConfigError(`policy.dangling.allowPatterns 不得豁免本地/脚本协议：${p}`);
    }
  }
  const scan = policy.scan ?? {};
  if (typeof scan !== 'object' || Array.isArray(scan)) throw new ConfigError('policy.scan 必须是对象');
  rejectUnknownKeys(scan, ['extensions', 'exclude', 'include'], 'policy.scan');
  needStringArray(scan.extensions, 'policy.scan.extensions');
  needStringArray(scan.exclude, 'policy.scan.exclude');
  // 内部决策-062 修正案 4：scan.include 为 glob 补充扫描面（无扩展名/非文档扩展名文件纳入文本词表）。
  const scanInclude = needStringArray(scan.include, 'policy.scan.include');
  scanInclude.forEach((p) => globToRegExp(p));
  // 内部决策-062 修正案 4：policy.rewrite 内容改写规则（纯用户配置；工具零内置规则）。
  if (policy.rewrite !== undefined) {
    const rw = policy.rewrite;
    if (rw === null || typeof rw !== 'object' || Array.isArray(rw)) throw new ConfigError('policy.rewrite 必须是对象');
    rejectUnknownKeys(rw, ['rules'], 'policy.rewrite');
    const rules = rw.rules ?? [];
    if (!Array.isArray(rules)) throw new ConfigError('policy.rewrite.rules 必须是数组');
    const seenIds = new Set();
    for (const [i, r] of rules.entries()) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new ConfigError(`policy.rewrite.rules[${i}] 必须是对象`);
      rejectUnknownKeys(r, ['id', 'pattern', 'replacement', 'files'], `policy.rewrite.rules[${i}]`);
      const id = needString(r.id, `policy.rewrite.rules[${i}].id`);
      if (seenIds.has(id)) throw new ConfigError(`policy.rewrite.rules id 重复：${id}`);
      seenIds.add(id);
      try {
        new RegExp(needString(r.pattern, `policy.rewrite.rules[${i}].pattern`));
      } catch (e) {
        throw new ConfigError(`policy.rewrite.rules[${i}].pattern 非法正则：${e.message}`);
      }
      if (typeof r.replacement !== 'string') throw new ConfigError(`policy.rewrite.rules[${i}].replacement 必须是字符串`);
      const files = needStringArray(r.files, `policy.rewrite.rules[${i}].files`);
      files.forEach((p) => globToRegExp(p));
    }
  }
  const license = policy.license ?? {};
  if (typeof license !== 'object' || Array.isArray(license)) throw new ConfigError('policy.license 必须是对象');
  rejectUnknownKeys(license, ['requireLicenseFile', 'requiredFields'], 'policy.license');
  if (license.requireLicenseFile !== undefined && typeof license.requireLicenseFile !== 'boolean') throw new ConfigError('policy.license.requireLicenseFile 必须是布尔');
  needStringArray(license.requiredFields, 'policy.license.requiredFields');
  const visibility = policy.visibility ?? {};
  if (typeof visibility !== 'object' || Array.isArray(visibility)) throw new ConfigError('policy.visibility 必须是对象');
  rejectUnknownKeys(visibility, ['default', 'overrides'], 'policy.visibility');
  if (visibility.overrides !== undefined) {
    if (visibility.overrides === null || typeof visibility.overrides !== 'object' || Array.isArray(visibility.overrides)) throw new ConfigError('policy.visibility.overrides 必须是对象');
    for (const [k, v] of Object.entries(visibility.overrides)) {
      if (v !== 'internal' && v !== 'external') throw new ConfigError(`policy.visibility.overrides.${k} 必须是 internal/external`);
    }
  }
  if (policy.visibilitySource !== undefined) needString(policy.visibilitySource, 'policy.visibilitySource');
  return policy;
}

/** 载入并校验项目根 `.deliver/{contract,policy}.json`。 */
export function loadConfigs(projectRoot) {
  const root = resolve(projectRoot);
  const dir = join(root, '.deliver');
  const contract = validateContract(readJsonStrict(join(dir, 'contract.json'), 'contract.json'));
  const policy = validatePolicy(readJsonStrict(join(dir, 'policy.json'), 'policy.json'));
  return { root, dir, contract, policy };
}

/** sha256（LF 原样字节）。 */
export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
export function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

/** 递归枚举目录内常规文件（包内相对路径、字典序；跳过 .git）。
 * 内部任务-244 Q08：删除无调用方的 `{exclude}` 可选参数（全仓零消费）。 */
export function walkFiles(root) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      const abs = join(absDir, ent.name);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile() || ent.isSymbolicLink()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/** 简单 glob（支持 **、*、?；用于 policy.pathPatterns 与 contract glob 来源）。 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** 源仓快照：除源仓自身 `.git/` 外全部文件内容哈希（源仓只读断言用）。 */
export function sourceSnapshot(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const excludes = (opts.exclude ?? []).map((e) => String(e).replaceAll('\\', '/').replace(/\/+$/, ''));
  const out = {};
  for (const rel of walkFiles(root)) {
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (excludes.some((e) => e !== '' && (rel === e || rel.startsWith(`${e}/`)))) continue;
    const abs = join(root, rel);
    try {
      const st = lstatSync(abs);
      out[rel] = `${st.size}:${st.mtimeMs}:${sha256File(abs)}`;
    } catch {
      out[rel] = 'unreadable';
    }
  }
  return out;
}

/** 源仓 `.git` 关键历史指纹（HEAD/refs；源 `.git` 历史不变断言用）。 */
export function gitHistoryFingerprint(projectRoot) {
  const gitDir = join(resolve(projectRoot), '.git');
  const parts = [];
  const add = (rel) => {
    try {
      parts.push(`${rel}=${sha256File(join(gitDir, rel))}`);
    } catch {
      parts.push(`${rel}=absent`);
    }
  };
  add('HEAD');
  add('packed-refs');
  try {
    for (const f of readdirSync(join(gitDir, 'refs', 'heads')).sort()) add(`refs/heads/${f}`);
  } catch {
    /* 无 refs 目录 */
  }
  return parts;
}

/** 抽取四形态引用：Markdown inline 链接/图片、引用式定义、HTML href/src。 */
export function extractReferences(text) {
  const refs = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) refs.push({ target: m[1], kind: 'markdown-inline', line: i + 1 });
    for (const m of line.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) refs.push({ target: m[1], kind: 'reference-definition', line: i + 1 });
    for (const m of line.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.push({ target: m[1], kind: 'html-attr', line: i + 1 });
  }
  return refs;
}

/** 可见性 overrides 合并：policy.visibility.overrides > visibilitySource.overrides。 */
export function resolveVisibilityOverrides({ projectRoot, policy }) {
  const merged = {};
  const sourceRel = policy.visibilitySource ?? 'specs/test-anchors.json';
  const explicit = policy.visibilitySource !== undefined;
  const sourceAbs = join(resolve(projectRoot), sourceRel);
  if (existsSync(sourceAbs)) {
    try {
      const source = readFileSync(sourceAbs, 'utf8');
      const data = JSON.parse(source);
      const overrides = data?.visibility?.overrides;
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const [k, v] of Object.entries(overrides)) merged[k] = v;
      }
    } catch (e) {
      if (explicit) throw new ConfigError(`visibilitySource 不可解析：${sourceRel}（${e.message}）`);
    }
  } else if (explicit) {
    throw new ConfigError(`visibilitySource 显式配置但文件不存在：${sourceRel}`);
  }
  for (const [k, v] of Object.entries(policy.visibility?.overrides ?? {})) merged[k] = v;
  return merged;
}

/** 判断模式集合里是否有命中。 */
function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/** 展开 contract 来源（file/dir/glob），返回 [{itemId, sourceRel, targetRel, abs}]。 */
export function expandSources(projectRoot, contract, policy) {
  const root = resolve(projectRoot);
  const internalPathRes = needStringArray(policy.internal?.pathPatterns, 'policy.internal.pathPatterns').map(globToRegExp);
  // 内部任务-244 Q03：realpath 与 .git 目录 realpath 只解析一次（原在每文件匹配循环内重复解析）
  let sourceRealRoot;
  try {
    sourceRealRoot = realpathSync(root);
  } catch {
    sourceRealRoot = root;
  }
  const gitDirReal = join(sourceRealRoot, '.git').toLowerCase();
  const normalizeCase = (p) => p.toLowerCase();
  const out = [];
  const missing = [];
  for (const item of contract.items) {
    const sourceAbs = join(root, item.source);
    const matches = [];
    if (item.kind === 'file') {
      if (existsSync(sourceAbs) && statSync(sourceAbs).isFile()) matches.push({ rel: item.source, target: item.target ?? item.source });
    } else if (item.kind === 'dir') {
      if (existsSync(sourceAbs) && statSync(sourceAbs).isDirectory()) {
        for (const rel of walkFiles(sourceAbs)) matches.push({ rel: `${item.source}/${rel}`, target: `${item.source}/${rel}` });
      }
    } else {
      const re = globToRegExp(item.source);
      for (const rel of walkFiles(root)) {
        if (re.test(rel)) matches.push({ rel, target: rel });
      }
    }
    if (matches.length === 0) {
      if (item.required !== false) missing.push({ rule: RULES.CONTRACT_MISSING, file: 'contract.json', message: `CDM 条目 ${item.id} 无产出：source=${item.source}` });
      continue;
    }
    for (const m of matches) {
      assertNoGitPath(m.rel, `CDM 条目 ${item.id} 来源`);
      if (anyMatch(internalPathRes, m.rel)) {
        throw new ViolationError(`CDM 条目 ${item.id} 试图交付命中 policy 内部路径规则的文件：${m.rel}`, [
          { rule: RULES.INTERNAL_ARTIFACT, file: m.rel, message: '源路径命中 policy.internal.pathPatterns（内部资产不得进入交付包）' },
        ]);
      }
      const abs = join(root, m.rel);
      let real;
      try {
        real = realpathSync(abs);
      } catch {
        real = resolve(abs);
      }
      if (real !== sourceRealRoot && !real.startsWith(sourceRealRoot + sep)) {
        throw new ViolationError(`CDM 条目 ${item.id} 源路径经符号链接逃逸源仓：${m.rel}`, [
          { rule: RULES.INTERNAL_ARTIFACT, file: m.rel, message: '源文件 realpath 逃逸源仓根' },
        ]);
      }
      // 源侧符号链接一律拒绝：可绕过词法内部路径/.git 检查（realpath 可能指向源仓内部或仓外）。
      let lst = null;
      try {
        lst = lstatSync(abs);
      } catch {
        lst = null;
      }
      if (lst && lst.isSymbolicLink()) {
        throw new ViolationError(`CDM 条目 ${item.id} 源路径是符号链接：${m.rel}`, [
          { rule: RULES.INTERNAL_ARTIFACT, file: m.rel, message: '源侧符号链接不允许（可绕过内部路径/.git 检查；请交付真实文件）' },
        ]);
      }
      // 符号链接可绕过词法 `.git` 检查：realpath 落入源仓 `.git` 的目标一律拒绝（大小写折叠，跨平台保守）。
      if (normalizeCase(real) === gitDirReal || normalizeCase(real).startsWith(`${gitDirReal}${sep}`)) {
        throw new ViolationError(`CDM 条目 ${item.id} 源路径 realpath 落入源仓 .git：${m.rel}`, [
          { rule: RULES.INTERNAL_ARTIFACT, file: m.rel, message: '源文件 realpath 位于源仓 .git（内部历史不得交付）' },
        ]);
      }
      // realpath 相对源仓再跑一次内部路径规则（防 symlink 指向 内部规格 等内部面）。
      const relReal = relative(sourceRealRoot, real).replaceAll('\\', '/');
      if (relReal !== '' && anyMatch(internalPathRes, relReal)) {
        throw new ViolationError(`CDM 条目 ${item.id} 源路径 realpath 命中内部路径规则：${m.rel} → ${relReal}`, [
          { rule: RULES.INTERNAL_ARTIFACT, file: m.rel, message: `源文件 realpath 命中 policy.internal.pathPatterns：${relReal}` },
        ]);
      }
      out.push({ itemId: item.id, sourceRel: m.rel, targetRel: m.target.replaceAll('\\', '/'), abs });
    }
  }
  return { entries: out, missing };
}

/** 读取模板并替换 %%KEY%% 占位符；项目级覆盖优先（`.deliver/templates/<name>`，缺省用插件资产）。 */
export function renderTemplate(templateName, vars, projectRoot = null) {
  const candidates = [];
  if (projectRoot) candidates.push(join(resolve(projectRoot), '.deliver', 'templates', templateName));
  candidates.push(join(TEMPLATE_DIR, templateName));
  let tpl = null;
  for (const file of candidates) {
    try {
      tpl = readFileSync(file, 'utf8');
      break;
    } catch {
      /* 尝试下一候选 */
    }
  }
  if (tpl === null) throw new ConfigError(`模板缺失：${candidates.join(' 或 ')}（可复制插件模板到 .deliver/templates/ 覆盖）`);
  // 占位符语法用 %%KEY%%（不用 {{VAR}}：仓级残留扫描把 {{VAR}} 判为 preamble 裁剪红线残留，
  // 模板属合法占位符载体，改用该语法避免把模板误判为未清理残留）。
  return tpl.replace(/%%([A-Z0-9_]+)%%/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** 渲染交付验收报告（模板驱动；仅合同侧字段；项目可用 .deliver/templates/ 覆盖）。 */
export function renderDeliveryReport(contract, projectRoot = null) {
  const rows = (contract.acceptance ?? []).map((a) => `| ${a.contractRequirement} | ${a.criterion} | ${a.result} | ${a.summary} |`).join('\n');
  return renderTemplate('DELIVERY-REPORT.template.md', {
    CONTRACT_ID: contract.contract.id,
    PARTY: contract.contract.party,
    DELIVERY_DATE: contract.contract.deliveryDate,
    ACCEPTANCE_ROWS: rows || '| — | — | not-run | 合同未提供验收映射 |',
  }, projectRoot);
}

/** 渲染审计配合包（模板驱动；不披露内部过程；项目可用 .deliver/templates/ 覆盖）。 */
export function renderAuditPacket(contract, projectRoot = null) {
  const audit = contract.audit ?? {};
  const excluded = Array.isArray(audit.excluded) && audit.excluded.length > 0 ? audit.excluded.join('、') : '内部开发流程与过程工具、内部计划与评审记录、内部任务编号与内部证据原文';
  return renderTemplate('AUDIT-PACKET.template.md', {
    CONTRACT_ID: contract.contract.id,
    PARTY: contract.contract.party,
    DELIVERY_DATE: contract.contract.deliveryDate,
    AUDIT_RIGHTS: audit.rights ?? '按合同约定',
    AUDIT_SCOPE: audit.scope ?? '交付物与其哈希清单',
    AUDIT_EXCLUDED: excluded,
    CONTACT: audit.contact ?? '合同约定联系人',
  }, projectRoot);
}

/** 计算包 manifest（manifest 自身不自列；其余全部文件排序+sha256）。 */
export function buildManifest(packageDir, contract, { gitMode }) {
  const files = walkFiles(packageDir)
    .filter((rel) => rel !== MANIFEST_NAME)
    .map((rel) => {
      const buf = readFileSync(join(packageDir, rel));
      return { path: rel, sha256: sha256Bytes(buf), bytes: buf.length };
    });
  return {
    schemaVersion: 1,
    contractId: contract.contract.id,
    deliveryDate: contract.contract.deliveryDate,
    git: { mode: gitMode },
    files,
  };
}

/** 扫描面预编译（内部任务-244 Q04）：exclude 正则与扩展名清单只在 checkPackage 开头编译一次
 * （原 isScannedText 在每文件调用内重复 compile）。 */
function compileScanRules(policy) {
  const excludeRes = policy.scan?.exclude !== undefined
    ? needStringArray(policy.scan.exclude, 'policy.scan.exclude').map(globToRegExp)
    : [globToRegExp('node_modules/**')];
  const exts = policy.scan?.extensions?.length ? policy.scan.extensions : DEFAULT_SCAN_EXTENSIONS;
  // 内部决策-062 修正案 4：scan.include（glob）并集扩展扫描面（无扩展名/非文档扩展名文件）。
  const includeRes = needStringArray(policy.scan?.include, 'policy.scan.include').map(globToRegExp);
  return { excludeRes, exts, includeRes };
}

/** 文本扫描面（policy.scan）：缺省排除 node_modules/**；显式 scan.exclude 时以显式为准（可覆盖缺省）；
 *  扫描面＝扩展名命中 ∪ scan.include glob 命中（内部决策-062 修正案 4）。 */
function isScannedText(rel, policy, scanRules = null) {
  const rules = scanRules ?? compileScanRules(policy);
  if (rules.excludeRes.some((re) => re.test(rel))) return false;
  if (rules.includeRes.some((re) => re.test(rel))) return true;
  return rules.exts.some((e) => rel.toLowerCase().endsWith(e.toLowerCase()));
}

/** 内部规则预编译（内部任务-244 Q04）：policy 正则每次 scanInternalText 调用重编 → 包内逐文件
 * 重复编译；checkPackage 编译一次并以 `compiled` 传入（对外 API 兼容：缺省仍自编译）。 */
export function compileInternalRules(policy) {
  const pathRes = needStringArray(policy.internal?.pathPatterns, 'policy.internal.pathPatterns').map(globToRegExp);
  // 内部决策-062 修正案 3：可选文本扫描分面；缺省或显式空数组均回落 pathPatterns（不静默关闭）。
  const rawText = policy.internal?.textPathPatterns;
  let textPathRes = pathRes;
  let textPathLabel = 'policy.internal.pathPatterns';
  if (rawText !== undefined) {
    const arr = needStringArray(rawText, 'policy.internal.textPathPatterns');
    if (arr.length > 0) {
      textPathRes = arr.map(globToRegExp);
      textPathLabel = 'policy.internal.textPathPatterns';
    }
  }
  return {
    idRes: compilePatterns(policy.internal?.idPatterns ?? [], 'policy.internal.idPatterns'),
    termRes: compilePatterns(policy.internal?.termPatterns ?? [], 'policy.internal.termPatterns'),
    pathRes,
    textPathRes,
    textPathLabel,
  };
}

/** 对任意文本跑 policy 的 internal id/term/path 规则（包内文本与提交信息等复用；单源）。
 *  内部决策-062 修正案 3 分面：`surface='text'`（缺省）用 internal.textPathPatterns（缺省/空数组回落 pathPatterns）；
 *  `surface='path'` 恒用 internal.pathPatterns（提交信息/作者面安全边界，不随文本分面收窄）。 */
export function scanInternalText(text, policy, { projectRoot, overrides, compiled, surface = 'text' } = {}) {
  const rules = compiled ?? compileInternalRules(policy);
  const { idRes, termRes, pathRes } = rules;
  const textPathRes = rules.textPathRes ?? pathRes;
  const usePathRes = surface === 'path' ? pathRes : textPathRes;
  const usePathLabel = surface === 'path'
    ? 'policy.internal.pathPatterns'
    : (rules.textPathLabel ?? 'policy.internal.pathPatterns');
  const effectiveOverrides = overrides ?? resolveVisibilityOverrides({ projectRoot, policy });
  const defaultVisibility = policy.visibility?.default === 'external' ? 'external' : 'internal';
  const hits = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    for (const re of [...idRes, ...termRes]) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of line.matchAll(global)) {
        if (visibilityExempt(m[0], effectiveOverrides, defaultVisibility)) continue;
        hits.push({ rule: RULES.INTERNAL_PATTERN, line: i + 1, match: m[0], pattern: String(re) });
      }
    }
    // 路径规则对自由文本取「路径样 token」逐个匹配（提交信息里出现内部路径即阻断）。
    // 内部决策-062 修正案 4：token 首字符允许 `.`——dot 目录（`.sdd/`、`.workflow/`、`.agents/`）文本规则生效。
    for (const token of line.match(/[A-Za-z0-9_@~+.][A-Za-z0-9_@~+./-]*/g) ?? []) {
      if (!anyMatch(usePathRes, token)) continue;
      if (visibilityExempt(token, effectiveOverrides, defaultVisibility)) continue;
      hits.push({ rule: RULES.INTERNAL_ARTIFACT, line: i + 1, match: token, pattern: usePathLabel });
    }
  }
  return hits;
}

// ── 内部决策-062 修正案 4：内容改写（policy.rewrite）与零残留硬检 ──────────────────────────
/** 改写目标面分类：test＝测试/夹具（全文本面）；code＝生产 JS 族（仅注释面）；other-code＝其他语言/脚本
 *  源码与配置类（.ts/.py/.sh/.ps1/.xml 等，保守不改写、按未覆盖面计数）；doc＝其余文本面（全文）。 */
export function classifyRewriteSurface(rel) {
  const p = String(rel).replaceAll('\\', '/');
  if (/(^|\/)(tests?|fixtures)\//i.test(p) || /\.test\.[cm]?js$/i.test(p)) return 'test';
  if (/\.(mjs|js|cjs)$/i.test(p)) return 'code';
  if (/\.(ts|tsx|jsx|py|sh|bash|zsh|fish|ps1|vbs|cmd|bat|xml|java|go|rs|rb|php|kt|swift|c|cc|cpp|h|hpp)$/i.test(p)) return 'other-code';
  // 语义配置/schema/数据文件同样保守不改写（避免改坏公开契约中的 ruleId/键名等结构值）；
  // 测试/夹具路径在上方已归 test 面（夹具仍全文改写）。
  if (/\.(json|jsonc|json5|jsonl|yml|yaml|toml|ini|conf|lock)$/i.test(p)) return 'other-code';
  return 'doc';
}

/** 编译 policy.rewrite.rules（validatePolicy 已做形态校验；此处只编译，不内置任何规则）。 */
export function compileRewriteRules(policy) {
  const rules = policy.rewrite?.rules ?? [];
  return rules.map((r) => ({
    id: r.id,
    re: new RegExp(r.pattern, 'g'),
    replacement: r.replacement,
    fileRes: Array.isArray(r.files) && r.files.length > 0 ? r.files.map(globToRegExp) : null,
  }));
}

function ruleAppliesToFile(rule, rel) {
  return rule.fileRes === null || rule.fileRes.some((re) => re.test(rel));
}

/** 统计并执行单段文本的全部规则替换（含 `$1` 捕获组语义；返回替换后文本，计数累加）。 */
function replaceRulesInText(text, rules, counts) {
  let out = text;
  for (const rule of rules) {
    const matched = out.match(rule.re);
    if (!matched) continue;
    counts[rule.id] = (counts[rule.id] ?? 0) + matched.length;
    out = out.replace(rule.re, rule.replacement);
  }
  return out;
}

const REGEX_START_PREV = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_START_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'switch', 'with', 'catch']);

/** 仅当 '/' 前是 ')' 且该 ')' 匹配的 '(' 前是控制关键字时，才把 '/' 当正则入口——
 *  避免把 `(a+b) / c; // 注释` 这类除号表达式误当正则而吞掉注释（收尾评审回归）。 */
function precededByControlParen(text, slashIndex) {
  let j = slashIndex - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0 || text[j] !== ')') return false;
  let depth = 0;
  let k = j;
  for (; k >= 0; k -= 1) {
    if (text[k] === ')') depth += 1;
    else if (text[k] === '(') { depth -= 1; if (depth === 0) break; }
  }
  if (k < 0) return false;
  let m = k - 1;
  while (m >= 0 && /\s/.test(text[m])) m -= 1;
  const end = m + 1;
  while (m >= 0 && /[A-Za-z_$]/.test(text[m])) m -= 1;
  return CONTROL_WORDS.has(text.slice(m + 1, end));
}

/** 保守 JS 注释切分：返回 [{comment:boolean,text,start}]（字符串/模板/正则字面量整体归代码面）。
 *  仅用于「生产代码仅注释面」改写与残留复核；模板内 `${...}` 表达式整体跳过（保守不改写）。
 *  已知限制：注释/正则的极端歧义按保守方向处理，未覆盖区域由 rewrite-residual 硬检与残余披露兜底。 */
export function splitJsCommentSegments(text) {
  const segments = [];
  const n = text.length;
  let i = 0;
  let codeStart = 0;
  let state = 'code';
  let prev = '';
  let lastWord = '';
  const pushCode = (end) => { if (end > codeStart) segments.push({ comment: false, text: text.slice(codeStart, end), start: codeStart }); };
  const pushComment = (start, end) => segments.push({ comment: true, text: text.slice(start, end), start });
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        pushCode(i);
        const start = i;
        i += 2;
        while (i < n && text[i] !== '\n') i += 1;
        pushComment(start, i);
        codeStart = i;
        prev = '';
        lastWord = '';
        continue;
      }
      if (ch === '/' && next === '*') {
        pushCode(i);
        const start = i;
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i = Math.min(i + 2, n);
        pushComment(start, i);
        codeStart = i;
        prev = '';
        lastWord = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch;
        i += 1;
        continue;
      }
      if (ch === '/') {
        const regexStart = REGEX_START_PREV.has(prev) || REGEX_START_WORDS.has(lastWord)
          || (prev === ')' && precededByControlParen(text, i));
        if (regexStart) {
          const startAt = i;
          i += 1;
          let inClass = false;
          let closed = false;
          while (i < n) {
            const c = text[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '\n') break; // 未闭合则回退（按除法处理，避免吞掉行尾注释）
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { i += 1; closed = true; break; }
            i += 1;
          }
          if (!closed) {
            i = startAt + 1;
            prev = '/';
            lastWord = '';
            continue;
          }
          while (i < n && /[a-z]/i.test(text[i])) i += 1;
          prev = 'x';
          lastWord = '';
          continue;
        }
        prev = '/';
        lastWord = '';
        i += 1;
        continue;
      }
      if (/[A-Za-z0-9_$]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
        lastWord = text.slice(i, j);
        prev = 'id';
        i = j;
        continue;
      }
      if (!/\s/.test(ch)) { prev = ch; lastWord = ''; }
      i += 1;
      continue;
    }
    if (state === "'" || state === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === state) { state = 'code'; i += 1; prev = 'x'; lastWord = ''; continue; }
      i += 1;
      continue;
    }
    if (state === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { state = 'code'; i += 1; prev = 'x'; lastWord = ''; continue; }
      if (ch === '$' && next === '{') {
        // 模板表达式整体跳过（保守：其中注释不改写；未覆盖区域由残余披露兜底）
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = text[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  pushCode(n);
  return segments;
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 投影期内容改写：按 policy.rewrite.rules 改写包内文件（doc/test 全文本面、code 仅注释面）。
 *  源仓不动（只写 packageDir）；返回计数报告；存在目标面残留即抛 ViolationError（rewrite-residual）。 */
export function rewritePackage(packageDir, policy) {
  const rules = compileRewriteRules(policy);
  const counts = Object.fromEntries(rules.map((r) => [r.id, 0]));
  const report = { enabled: rules.length > 0, rules: [], filesChanged: 0, untargetedResidual: 0 };
  if (rules.length === 0) return report;
  const pkg = resolve(packageDir);
  const files = walkFiles(pkg);
  for (const rel of files) {
    if (rel === MANIFEST_NAME) continue;
    const applicable = rules.filter((r) => ruleAppliesToFile(r, rel));
    if (applicable.length === 0) continue;
    const abs = join(pkg, rel);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const surface = classifyRewriteSurface(rel);
    let next = text;
    if (surface === 'code') {
      const parts = [];
      for (const seg of splitJsCommentSegments(text)) parts.push(seg.comment ? replaceRulesInText(seg.text, applicable, counts) : seg.text);
      next = parts.join('');
    } else if (surface === 'doc' || surface === 'test') {
      next = replaceRulesInText(text, applicable, counts);
    } // other-code：保守不改写（未覆盖面计数披露）
    if (next !== text) {
      writeFileSync(abs, next, 'utf8');
      report.filesChanged += 1;
    }
  }
  // 目标面零残留硬检（code 注释面 / doc·test 全文本面）
  const residual = scanRewriteResidual(pkg, policy);
  if (residual.length > 0) {
    throw new ViolationError('内容改写残留（rewrite-residual，导出中止）', residual);
  }
  // 未覆盖面（生产代码字符串/模板/正则等 + 其他语言/脚本源码）残留计数：如实报告、不阻断（内部决策-062 修正案 4）
  for (const rel of files) {
    const surface = classifyRewriteSurface(rel);
    if (surface !== 'code' && surface !== 'other-code') continue;
    const applicable = rules.filter((r) => ruleAppliesToFile(r, rel));
    if (applicable.length === 0) continue;
    let text;
    try { text = readFileSync(join(pkg, rel), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const zones = surface === 'code'
      ? splitJsCommentSegments(text).filter((s) => !s.comment)
      : [{ comment: false, text, start: 0 }];
    for (const seg of zones) {
      for (const rule of applicable) {
        const m = seg.text.match(rule.re);
        if (m) report.untargetedResidual += m.length;
      }
    }
  }
  report.rules = rules.map((r) => ({ id: r.id, count: counts[r.id] ?? 0 }));
  return report;
}

/** 内容改写残留复核（deliver-lint 与 export 共用）：返回目标面命中 rewrite 规则的违例列表。 */
export function scanRewriteResidual(packageDir, policy) {
  const rules = compileRewriteRules(policy);
  if (rules.length === 0) return [];
  const pkg = resolve(packageDir);
  const violations = [];
  for (const rel of walkFiles(pkg)) {
    if (rel === MANIFEST_NAME) continue;
    const applicable = rules.filter((r) => ruleAppliesToFile(r, rel));
    if (applicable.length === 0) continue;
    let text;
    try { text = readFileSync(join(pkg, rel), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const surface = classifyRewriteSurface(rel);
    if (surface === 'other-code') continue; // 其他语言/脚本源码保守不改写（未覆盖面披露）
    const zones = surface === 'code'
      ? splitJsCommentSegments(text).filter((s) => s.comment)
      : [{ comment: true, text, start: 0 }];
    for (const zone of zones) {
      for (const rule of applicable) {
        for (const m of zone.text.matchAll(new RegExp(rule.re.source, 'g'))) {
          violations.push({
            rule: RULES.REWRITE_RESIDUAL,
            file: rel,
            line: lineOfIndex(text, zone.start + m.index),
            message: `内容改写残留（rule ${rule.id}）：${m[0]}`,
          });
        }
      }
    }
  }
  return violations;
}

/** 判定某 ID 是否被可见性规则标为 external（豁免 internal.idPatterns）：overrides > default。 */
function visibilityExempt(id, overrides, defaultVisibility = 'internal') {
  const v = overrides[id];
  if (v === 'external') return true;
  if (v === 'internal') return false;
  return defaultVisibility === 'external';
}

/**
 * 交付包复核算入口（deliver-lint 与 deliver-export 包内自检共用）。
 * @param {{projectRoot?:string, packageDir:string, contract:object, policy:object}} opts
 * @returns {{violations:Array<{rule:string,file:string,line?:number,message:string}>, summary:object}}
 */
export function checkPackage({ projectRoot, packageDir, contract, policy }) {
  const pkg = resolve(packageDir);
  const violations = [];
  const add = (rule, file, message, line) => violations.push({ rule, file, message, ...(line ? { line } : {}) });
  if (!existsSync(pkg) || !statSync(pkg).isDirectory()) throw new ConfigError(`交付包目录不存在或不是目录：${pkg}`);
  const files = walkFiles(pkg);
  const fileSet = new Set(files);
  const generated = (contract.generated ?? []).map((g) => GENERATED_NAMES[g.generator]);
  const generatedSet = new Set(generated);
  // audit.enabled 即生成审计包（内部接口-25 §2：enabled 时生成）；未显式声明 generated 也不判 unlisted。
  if (contract.audit?.enabled) generatedSet.add(GENERATED_NAMES['audit-packet']);

  // 1) manifest 双向对账
  const manifestPath = join(pkg, MANIFEST_NAME);
  /** @type {null | {schemaVersion:number, files:Array<{path:string,sha256:string}>}} */
  let manifest = null;
  if (!fileSet.has(MANIFEST_NAME)) {
    add(RULES.MANIFEST_MISSING, MANIFEST_NAME, '交付包缺 MANIFEST.sha256.json');
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.files)) throw new Error('files 非数组');
    } catch (e) {
      add(RULES.MANIFEST_MISSING, MANIFEST_NAME, `MANIFEST 不可解析：${e.message}`);
      manifest = null;
    }
  }
  if (manifest) {
    // 内部任务-348/内部未决-214③：MANIFEST.contractId/deliveryDate 与传入 contract 绑定校验——
    // 两字段直抄自合同（buildManifest），篡改/错包对账此前不可见；缺键/非 string 形态
    // 本身即拒（buildManifest 恒写两键，缺键 manifest 非合法产物——S1 门 #6 收紧）。
    if (manifest.contractId !== contract.contract.id) {
      add(RULES.MANIFEST_HASH, MANIFEST_NAME, `MANIFEST contractId 与合同不符（manifest=${JSON.stringify(manifest.contractId)}，contract=${contract.contract.id}）——错包、篡改或缺键`);
    }
    if (manifest.deliveryDate !== contract.contract.deliveryDate) {
      add(RULES.MANIFEST_HASH, MANIFEST_NAME, `MANIFEST deliveryDate 与合同不符（manifest=${JSON.stringify(manifest.deliveryDate)}，contract=${String(contract.contract.deliveryDate)}）`);
    }
    const listed = new Map();
    for (const f of manifest.files) {
      if (f === null || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.sha256 !== 'string') {
        add(RULES.MANIFEST_HASH, MANIFEST_NAME, `MANIFEST 条目形态非法：${JSON.stringify(f)}`);
        continue;
      }
      // 内部任务-244 遗留项④：重复 path 必须拒绝——Map last-wins 会让后一条覆盖前一条，
      // 哈希矛盾被静默掩盖（前条哈希错误不可见），且对账语义不可判定。
      if (listed.has(f.path)) {
        add(RULES.MANIFEST_HASH, MANIFEST_NAME, `MANIFEST 重复 path 条目（last-wins 会掩盖哈希矛盾）：${f.path}`);
        continue;
      }
      listed.set(f.path, f.sha256);
    }
    for (const rel of files) {
      if (rel === MANIFEST_NAME) continue;
      if (!listed.has(rel)) add(RULES.MANIFEST_HASH, rel, '包内文件未被 MANIFEST 收录（哈希对账缺失）');
      else if (listed.get(rel) !== sha256File(join(pkg, rel))) add(RULES.MANIFEST_HASH, rel, 'MANIFEST 哈希与文件不符');
    }
    for (const [rel] of listed) {
      if (!fileSet.has(rel)) add(RULES.MANIFEST_EXTRA, rel, 'MANIFEST 声明了包内不存在的文件');
    }
    if (listed.has(MANIFEST_NAME)) add(RULES.MANIFEST_HASH, MANIFEST_NAME, 'MANIFEST 不得自列（自身无法自哈希）');
  }

  // 1b) 包内符号链接：逐项 realpath 裁决（未被文本引用到的 symlink 也必须拦，防指向源仓/包外）
  let realPkg = null;
  try {
    realPkg = realpathSync(pkg);
  } catch {
    realPkg = resolve(pkg);
  }
  for (const rel of files) {
    const abs = join(pkg, rel);
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    let real = null;
    try {
      real = realpathSync(abs);
    } catch {
      add(RULES.ESCAPES_ROOT, rel, '包内符号链接不可解析（悬空链接）');
      continue;
    }
    if (real !== realPkg && !real.startsWith(`${realPkg}${sep}`)) {
      add(RULES.ESCAPES_ROOT, rel, '包内符号链接指向包外（realpath 越界）');
    }
  }

  // 2) 最小交付：CDM required 条目全覆盖 + 无未声明文件
  const covered = new Set(generatedSet);
  for (const item of contract.items) {
    const required = item.required !== false;
    let matched = 0;
    for (const rel of files) {
      let hit = false;
      if (item.kind === 'file') hit = rel === (item.target ?? item.source).replaceAll('\\', '/');
      else if (item.kind === 'dir') hit = rel === item.source || rel.startsWith(`${item.source}/`);
      else hit = globToRegExp(item.source).test(rel);
      if (hit) {
        matched += 1;
        covered.add(rel);
      }
    }
    if (required && matched === 0) add(RULES.CONTRACT_MISSING, 'contract.json', `CDM required 条目 ${item.id} 在包内无产出`);
  }
  for (const g of contract.generated ?? []) {
    if (g.required !== false && !fileSet.has(GENERATED_NAMES[g.generator])) add(RULES.CONTRACT_MISSING, GENERATED_NAMES[g.generator], `声明式生成物缺失：${g.generator}`);
  }
  for (const rel of files) {
    if (rel === MANIFEST_NAME) continue;
    if (!covered.has(rel)) add(RULES.UNLISTED, rel, '包内文件未被任何 CDM 条目或生成器认领（最小交付越界）');
  }

  // 3) 内部规则（全来自 policy；unknown -> 由 validatePolicy 拒绝；无行级抑制旁路；扫描实现单源）
  // 内部任务-244 Q04：内部规则/扫描面正则**只编译一次**；文本整读一次缓存供第 3/4 段共用
  // （原实现每文件重编 policy 正则、同一文件第 3、4 段各整读一次）。
  const internalRules = compileInternalRules(policy);
  const internalPathRes = internalRules.pathRes;
  const scanRules = compileScanRules(policy);
  const pkgTexts = new Map();
  const readPkgText = (rel) => {
    if (pkgTexts.has(rel)) return pkgTexts.get(rel);
    let text = null;
    try {
      text = readFileSync(join(pkg, rel), 'utf8');
    } catch {
      text = null;
    }
    pkgTexts.set(rel, text);
    return text;
  };
  const overrides = resolveVisibilityOverrides({ projectRoot: projectRoot ?? pkg, policy });
  for (const rel of files) {
    if (anyMatch(internalPathRes, rel)) add(RULES.INTERNAL_ARTIFACT, rel, '包内路径命中 policy.internal.pathPatterns');
    // 包内嵌套 `.git` 路径段（大小写折叠）同样阻断（防篡改包夹带内部历史）。
    if (rel.replaceAll('\\', '/').toLowerCase().split('/').includes('.git')) add(RULES.INTERNAL_ARTIFACT, rel, '包内路径含 .git 段（内部历史不得进入交付包）');
    if (!isScannedText(rel, policy, scanRules)) continue;
    const text = readPkgText(rel);
    if (text === null) continue;
    for (const hit of scanInternalText(text, policy, { overrides, compiled: internalRules })) {
      add(hit.rule, rel, `命中内部规则 ${hit.pattern}：${hit.match}`, hit.line);
    }
  }

  // 3b) 内部决策-062 修正案 4：内容改写零残留硬检（改写后目标面不得再命中任何 rewrite 规则）
  for (const v of scanRewriteResidual(pkg, policy)) add(v.rule, v.file, v.message, v.line);

  // 4) 悬空引用（四形态，恒 blocking、无降级开关）＋移除文档直查
  const allowExternal = policy.dangling?.allowExternal !== false;
  const allowPatterns = needStringArray(policy.dangling?.allowPatterns, 'policy.dangling.allowPatterns');
  const sourceFiles = projectRoot ? new Set(walkFiles(resolve(projectRoot)).filter((r) => !r.startsWith('.git/'))) : null;
  const realTargetCache = new Map(); // 内部任务-244 Q03：同引用目标 realpath 只解析一次
  for (const rel of files) {
    if (!isScannedText(rel, policy, scanRules) || rel === MANIFEST_NAME) continue;
    const text = readPkgText(rel);
    if (text === null) continue;
    if (text.includes('\u0000')) {
      // 文本扩展名文件含 NUL 字节：疑似二进制伪装，不得静默跳过（否则可绕过引用扫描）。
      add(RULES.INTERNAL_ARTIFACT, rel, '文本扩展名文件含 NUL 字节（疑似二进制伪装，不予交付）');
      continue;
    }
    for (const ref of extractReferences(text)) {
      let target = ref.target.trim();
      if (target === '' || target.startsWith('#')) continue;
      // 盘符判定须先于 scheme 解析（`C:` 会被 scheme 正则吞掉）。
      if (/^[A-Za-z]:[\\/]/.test(target)) {
        add(RULES.ESCAPES_ROOT, rel, `不允许的盘符引用：${target}`, ref.line);
        continue;
      }
      const scheme = target.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      if (scheme) {
        // 内部任务-244 E03：`data:` 恒 blocking——内联 URI 可承载任意 HTML/脚本，作为外部链接豁免
        // 会让「恒 blocking、无降级开关」被整类绕过；allowPatterns 侧也已在 validatePolicy
        // 显式拒绝 data: 前缀，两处口径一致。
        if (scheme === 'data') {
          add(RULES.ESCAPES_ROOT, rel, `不允许的 data: 引用（恒 blocking，可承载内联脚本/页面）：${target.slice(0, 80)}`, ref.line);
          continue;
        }
        // 只有白名单协议视为外部链接；file:/其它 scheme 一律按逃逸拒绝（内部决策-062 修正案 1）。
        // 自定义 scheme 前缀豁免仅对 scheme 形态生效（validatePolicy 已限制），不构成路径降级开关。
        if (allowExternal && ['http', 'https', 'mailto'].includes(scheme)) continue;
        if (allowPatterns.some((p) => target.toLowerCase().startsWith(p.toLowerCase()))) continue;
        add(RULES.ESCAPES_ROOT, rel, `不允许的外部/本地协议引用：${target}`, ref.line);
        continue;
      }
      target = target.split('#')[0].split('?')[0];
      if (target === '') continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* 保留原文 */
      }
      // 绝对路径判定放在 decode 之后（`%2Fetc/passwd` 解码后仍须判逃逸）。
      if (target.startsWith('/')) {
        add(RULES.ESCAPES_ROOT, rel, `引用为绝对路径（逃逸包根）：${target}`, ref.line);
        continue;
      }
      const base = dirname(rel);
      const resolvedRel = normalize(join(base === '.' ? '' : base, target)).replaceAll('\\', '/');
      if (resolvedRel.startsWith('..') || isAbsolute(resolvedRel)) {
        add(RULES.ESCAPES_ROOT, rel, `引用逃逸交付包根：${ref.target}`, ref.line);
        continue;
      }
      if (fileSet.has(resolvedRel)) {
        // 包内文件仍须 realpath 裁决：符号链接指向包外即逃逸（内部决策-062 修正案 1 第 2 条）。
        // 内部任务-244 Q03：包根 realPkg 已在 1b 段解析一次；同目标 realpath 结果缓存复用。
        try {
          let realTarget = realTargetCache.get(resolvedRel);
          if (realTarget === undefined) {
            realTarget = realpathSync(join(pkg, resolvedRel));
            realTargetCache.set(resolvedRel, realTarget);
          }
          if (realTarget !== realPkg && !realTarget.startsWith(realPkg + sep)) {
            add(RULES.ESCAPES_ROOT, rel, `引用目标经符号链接 realpath 越界：${resolvedRel}`, ref.line);
          }
        } catch {
          /* 读取失败按悬空处理 */
          add(RULES.DANGLING, rel, `引用目标不可读：${resolvedRel}`, ref.line);
        }
        continue;
      }
      if (sourceFiles && sourceFiles.has(resolvedRel)) {
        add(RULES.REMOVED_DOC, rel, `引用的文档已从交付包移除：${resolvedRel}`, ref.line);
      } else {
        add(RULES.DANGLING, rel, `悬空引用（目标不在交付包内）：${ref.target} → ${resolvedRel}`, ref.line);
      }
    }
  }

  // 5) 许可完整性
  const requiredFields = policy.license?.requiredFields?.length ? policy.license.requiredFields : ['name', 'license'];
  for (const [i, t] of (contract.thirdParty ?? []).entries()) {
    for (const field of requiredFields) {
      if (typeof t[field] !== 'string' || t[field].trim() === '') add(RULES.LICENSE_INCOMPLETE, 'contract.json', `thirdParty[${i}] 缺必填字段 ${field}`);
    }
  }
  if (policy.license?.requireLicenseFile) {
    const hasLicense = files.some((rel) => /(^|\/)(LICENSE|LICENCE|COPYING)(\.[A-Za-z0-9]+)?$/i.test(rel));
    if (!hasLicense) add(RULES.LICENSE_INCOMPLETE, 'LICENSE', 'policy.license.requireLicenseFile 要求包内含 LICENSE/COPYING 文件');
  }

  return {
    violations,
    summary: {
      packageDir: pkg,
      fileCount: files.length,
      ruleSet: Object.values(RULES),
      blockingCount: violations.length,
    },
  };
}

/** 供 CLI 与测试共享的文本报告格式。 */
export function formatViolationsMd(report) {
  if (report.violations.length === 0) return 'OK：交付包复核通过（0 违例）\n';
  const lines = [`FAIL：${report.violations.length} 条违例`, '| 规则 | 文件 | 行 | 说明 |', '|---|---|---|---|'];
  for (const v of report.violations) lines.push(`| ${v.rule} | ${v.file} | ${v.line ?? ''} | ${v.message.replace(/\|/g, '\\|')} |`);
  return `${lines.join('\n')}\n`;
}
