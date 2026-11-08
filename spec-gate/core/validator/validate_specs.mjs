// 文件：validate_specs.mjs
// 描述：跨技术栈、宿主无关的只读规格校验器（Python validate_specs.py 的 JS 实现，内部决策-051 阶段4）。
// 退出码：0=通过；1=存在阻塞性文档问题；2=工具/配置/调用错误。
// plan 模式例外：blocking>0 时退出 2（门禁阻断信号），通过为 0。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostic, hasBlocking } from './core/diagnostics.mjs';
import { parseFrontmatter } from './core/frontmatter.mjs';
import { checkMarkdownStructure, fencedBlockRanges, inFenced, inlineCodeSpans, maskInlineCodeSpans, TODO_TOKEN_PATTERN } from './core/markdown.mjs';
import { PathSecurityError, resolveCrossRootAsset, resolveWithinRoot } from './core/paths.mjs';
import { checkPlan, RULE_PLAN_READ } from './core/plan_check.mjs';
import { checkTraceability } from './core/traceability.mjs';
import { ConfigError, codePointCompare, emitJson, emitText, isMainModule, pyStrip, pyTypeName, readJsonStrict, readUtf8Text } from './core/pycompat.mjs';

const MODES = ['template', 'draft', 'baseline', 'suite', 'plan'];
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_-]+)\}\}/g;
const FREE_TODO_PATTERN = TODO_TOKEN_PATTERN;
const OPEN_N_PATTERN = /(?<![A-Za-z0-9_])OPEN-[0-9]+(?![A-Za-z0-9_])/;
const GT_PATTERN = /(?<![A-Za-z0-9_])G-T([0-9]+)(?![A-Za-z0-9_])/g;
const GT_REFERENCE_MASK_PATTERN = /\[G-T\d+\]|细化\s*G-T\d+/g;
const REFINE_BAD_PATTERN = /细化\s*Gx|（G-T\d+\s*细化）|\[G-T\d+\s*细化\]/;
const GT_UNIQUE_EXEMPT_TYPES = ['global-sequence', 'traceability-matrix'];
const NOTE_LAYER_RE = /^#{1,6}\s*第二部分/;
const TRACEABILITY_TYPES = ['module-specification', 'requirement-baseline', 'module-requirement', 'module-volume'];

const EXIT_OK = 0;
const EXIT_CONTENT = 1;
const EXIT_TOOL = 2;

export class UsageError extends Error {}

export function errorReport(message) {
  return JSON.stringify({ error: message });
}
function emitError(message, format, alwaysJson = false) {
  if (format === 'json' || alwaysJson) emitText(errorReport(message));
  else emitText(message);
}

function loadConfig(path) {
  if (!existsSync(path)) return { config: null, error: `配置文件不存在: ${path}` };
  try {
    return { config: readJsonStrict(path), error: null };
  } catch (e) {
    return { config: null, error: `配置文件不是合法 JSON: ${e.message}` };
  }
}

function validateSuiteConfigShape(config, suiteRoot) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError('suite 配置须为 JSON 对象');
  }
  const problems = [];
  const documents = config.documents === undefined ? [] : config.documents;
  if (!Array.isArray(documents)) problems.push('documents 须为数组');
  const docPaths = new Set();
  (Array.isArray(documents) ? documents : []).forEach((doc, i) => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`documents[${i}] 须为对象（当前 ${pyTypeName(doc)}）`);
      return;
    }
    if (typeof doc.path !== 'string' || !pyStrip(doc.path)) {
      problems.push(`documents[${i}].path 须为非空字符串（当前 ${pyTypeName(doc.path)}）`);
    }
    const note = doc.note;
    if (note !== undefined && note !== null && typeof note !== 'string') problems.push(`documents[${i}].note 须为字符串（当前 ${typeof note}）`);
    if (typeof doc.path === 'string') docPaths.add(doc.path);
  });
  const exemptions = config.exemptions;
  if (exemptions !== undefined && exemptions !== null) {
    if (!Array.isArray(exemptions)) {
      problems.push('exemptions 须为数组（{path,reason,ref} 对象列表，记录收窄/排除裁决）');
    } else {
      exemptions.forEach((ex, i) => {
        if (ex === null || typeof ex !== 'object' || Array.isArray(ex)) {
          problems.push(`exemptions[${i}] 须为对象（当前 ${pyTypeName(ex)}）`);
          return;
        }
        const path = ex.path;
        if (typeof path !== 'string' || !pyStrip(path)) {
          problems.push(`exemptions[${i}].path 须为非空字符串`);
        } else if (docPaths.has(path)) {
          problems.push(`exemptions[${i}].path=${path} 同时在 documents 受检清单中——豁免登记与受检状态矛盾`);
        } else {
          try { resolveWithinRoot(suiteRoot, path); } catch (e) {
            if (e instanceof PathSecurityError) problems.push(`exemptions[${i}].path 路径安全拒绝: ${e.message}`);
            else throw e;
          }
        }
        const reason = ex.reason;
        if (typeof reason !== 'string' || !pyStrip(reason)) problems.push(`exemptions[${i}].reason 须为非空字符串（收窄/排除裁决理由）`);
        const ref = ex.ref;
        if (ref !== undefined && ref !== null && typeof ref !== 'string') problems.push(`exemptions[${i}].ref 须为字符串（裁决依据引用，如 OPEN-n）`);
      });
    }
  }
  const noise = config.implementationNoiseTerms;
  if (noise !== undefined && (!Array.isArray(noise) || !noise.every((x) => typeof x === 'string'))) {
    problems.push('implementationNoiseTerms 须为字符串数组');
  }
  const allowed = config.allowedPublicAssets;
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every((x) => typeof x === 'string'))) {
    problems.push('allowedPublicAssets 须为字符串数组');
  }
  if (config.suiteRoot !== undefined && typeof config.suiteRoot !== 'string') {
    problems.push('suiteRoot 须为字符串');
  }
  if (problems.length) throw new ConfigError(`suite 配置形态问题：\n- ${problems.join('\n- ')}`);
}

function checkPlaceholders(relPath, text, mode, meta, lineOffset) {
  const diagnostics = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const allowedRaw = mode === 'template' ? String(meta?.allowedPlaceholders ?? '') : '';
  const allowed = new Set();
  for (const m of allowedRaw.matchAll(PLACEHOLDER_PATTERN)) allowed.add(m[0]);
  // 内部变更-19：定稿模式排除代码语境——围栏与行内反引号中的 {{...}} 是引用/示例记法，非「未解析占位符」；
  // 模板模式保持全文扫描（占位符即模板内容，selfcheck 契约）。body 已由 parseFrontmatter 归一为 LF。
  const skipCode = mode !== 'template';
  const ranges = skipCode ? fencedBlockRanges(text) : [];
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const line = lines[idx - 1];
    const spans = skipCode && line.includes('`') ? inlineCodeSpans(line) : [];
    for (const m of line.matchAll(PLACEHOLDER_PATTERN)) {
      // 占位符字符集不含反引号，token 物理上不可能跨越 span 定界——起点在内即整枚在内
      if (spans.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const token = m[0];
      if (mode === 'template') {
        if (!allowed.has(token)) diagnostics.push(diagnostic('RULE-SPEC-002', 'blocking', relPath, idx + lineOffset, `占位符 ${token} 未在模板 allowedPlaceholders 中声明`));
      } else {
        diagnostics.push(diagnostic('RULE-SPEC-002', 'blocking', relPath, idx + lineOffset, `定稿文档不得残留占位符 ${token}`));
      }
    }
  }
  return diagnostics;
}

function noteLayerStart(lines, ranges) {
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    if (NOTE_LAYER_RE.test(lines[idx - 1])) return idx;
  }
  return null;
}

function checkTodo(relPath, text, mode, noiseTerms, lineOffset) {
  const diagnostics = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const ranges = fencedBlockRanges(text);
  const hasOpenN = OPEN_N_PATTERN.test(text);
  const noteStart = noteLayerStart(lines, ranges);
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const line = lines[idx - 1];
    if (FREE_TODO_PATTERN.test(line)) {
      if (mode === 'draft' && hasOpenN) {
        diagnostics.push(diagnostic('RULE-OPEN-001', 'warning', relPath, idx + lineOffset, 'draft 允许未决内容，但应把自由文本未决项收敛为结构化 OPEN-n'));
      } else {
        diagnostics.push(diagnostic('RULE-OPEN-001', 'blocking', relPath, idx + lineOffset, '禁止自由文本 TODO/TBD；改用结构化未决项模板（template.atomic.open-items）'));
      }
    }
    const inNoteLayer = noteStart !== null && idx >= noteStart;
    if (!inNoteLayer) {
      // 内部任务-347/内部未决-152⑤：噪音词对行内代码 span 透明；先在原行掩蔽、后整体小写
      //（toLowerCase 非保长——U+0130 小写为两码元，先小写会错位 span，见 maskInlineCodeSpans 注）。
      const noiseLine = maskInlineCodeSpans(line).toLowerCase();
      for (const term of noiseTerms ?? []) {
        if (term && noiseLine.includes(String(term).toLowerCase())) {
          diagnostics.push(diagnostic('RULE-SPEC-004', 'blocking', relPath, idx + lineOffset, `规定性规格层出现实现噪音词「${term}」；下沉到注记层或删除`));
        }
      }
    }
  }
  return diagnostics;
}

function checkGt(relPath, text, ranges, exemptUnique, lineOffset) {
  const diagnostics = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const seen = new Map();
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const line = lines[idx - 1];
    // 内部任务-237/内部未决-152④：行内代码 span 内文本对 G-T 扫描透明（掩蔽单源 maskInlineCodeSpans，内部任务-347）。
    const maskedLine = maskInlineCodeSpans(line);
    if (REFINE_BAD_PATTERN.test(maskedLine)) {
      diagnostics.push(diagnostic('RULE-SPEC-003', 'blocking', relPath, idx + lineOffset, '模块细化标注必须写「细化 G-Tn」，禁止 细化 Gx 或 [G-Tn 细化] 变体'));
    }
    const masked = maskedLine.replace(GT_REFERENCE_MASK_PATTERN, ' ');
    for (const m of masked.matchAll(GT_PATTERN)) {
      if (!seen.has(m[0])) seen.set(m[0], idx + lineOffset);
    }
  }
  if (!exemptUnique && seen.size > 1) {
    const ids = [...seen.keys()].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    for (const extra of ids.slice(1)) {
      diagnostics.push(diagnostic('RULE-SPEC-003', 'blocking', relPath, seen.get(extra),
        `同一文档出现多个全局时序主编号（${ids[0]} 与 ${extra}）；全局时序只允许唯一 G-T 主编号（引用他号请写「细化 G-Tn」或 [G-Tn]，不另起裸编号）`));
    }
  }
  return diagnostics;
}

export function validateDocument(suiteRoot, doc, mode, noiseTerms) {
  const diagnostics = [];
  const relPath = doc.path;
  if (!relPath) throw new ConfigError('suite 配置存在缺少 path 字段的 document 条目');
  let full;
  try { full = resolveWithinRoot(suiteRoot, relPath); } catch (e) {
    if (!(e instanceof PathSecurityError)) throw e;
    diagnostics.push(diagnostic('RULE-PATH-002', 'blocking', relPath, 1, `路径安全拒绝: ${e.message}`));
    return diagnostics;
  }
  let st;
  try {
    st = statSync(full);
  } catch (e) {
    // 内部任务-242 C02：仅 ENOENT 是「配置声明的受检文件不存在」内容诊断；EACCES/EBUSY/EIO 等
    // fs/权限类属工具错误（退 2），不得伪装成内容阻断。
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') {
      diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, 1, '配置声明的受检文件不存在'));
      return diagnostics;
    }
    throw new ConfigError(`受检文件不可访问（${e && e.code ? e.code : '未知错误'}）：${relPath}`);
  }
  // Python 对目录 read_text 抛 IsADirectoryError → 工具错误退 2；不得降级为内容诊断。
  if (!st.isFile()) throw new ConfigError(`配置声明的受检路径不是文件: ${relPath}`);
  let text;
  try {
    text = readUtf8Text(full);
  } catch (e) {
    // 内部任务-242 C02：fs/权限类错误→工具错误 2；仅内容解码失败（UnicodeDecodeError 同义）→内容诊断。
    if (e !== null && typeof e === 'object' && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) {
      throw new ConfigError(`受检文件读取失败（${e.code}）：${relPath}`);
    }
    diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, 1, '受检文件不是合法 UTF-8 文本；转换编码后重校'));
    return diagnostics;
  }
  const { meta, body, bodyStartLine, frontmatterError } = parseFrontmatter(text);
  const offset = bodyStartLine - 1;
  if (frontmatterError) {
    // 内部任务-347/内部未决-142：frontmatter 不可解析具名化（原静默按正文处理）——warning 档，元数据按缺席消费。
    diagnostics.push(diagnostic('RULE-SPEC-001', 'warning', relPath, 1, `frontmatter ${frontmatterError}——元数据不可用，按正文处理（修复重复键后元数据恢复消费）`));
  }
  diagnostics.push(...checkMarkdownStructure(relPath, body, offset));
  diagnostics.push(...checkPlaceholders(relPath, body, mode, meta, offset));
  diagnostics.push(...checkTodo(relPath, body, mode, noiseTerms, offset));
  const ranges = fencedBlockRanges(body);
  const docType = doc.documentType ?? meta?.documentType;
  diagnostics.push(...checkGt(relPath, body, ranges, GT_UNIQUE_EXEMPT_TYPES.includes(docType), offset));
  if (TRACEABILITY_TYPES.includes(docType)) diagnostics.push(...checkTraceability(relPath, body, offset, { documentType: docType }));
  return diagnostics;
}

function walkTemplates(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => codePointCompare(a.name, b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.template.md')) out.push(full);
    }
  };
  walk(join(root, 'templates'));
  return out;
}

export function selfcheck(coreRoot = null) {
  const root = coreRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const diagnostics = [];
  for (const template of walkTemplates(root)) {
    const rel = template.slice(root.length + 1).split(/[\\/]/).join('/');
    let text;
    try { text = readUtf8Text(template); } catch {
      diagnostics.push(diagnostic('RULE-CORE-002', 'blocking', rel, 1, '模板不是合法 UTF-8 文本'));
      continue;
    }
    const { meta, body, bodyStartLine } = parseFrontmatter(text);
    if (meta === null) {
      diagnostics.push(diagnostic('RULE-CORE-002', 'blocking', rel, 1, '模板缺少 frontmatter 元数据'));
      continue;
    }
    diagnostics.push(...checkMarkdownStructure(rel, body, bodyStartLine - 1));
    diagnostics.push(...checkPlaceholders(rel, body, 'template', meta, bodyStartLine - 1));
  }
  return diagnostics;
}

export function suiteModeChecks(config, suiteRoot) {
  const diagnostics = [];
  const manifestRaw = config.manifest;
  if (typeof manifestRaw !== 'string' || !pyStrip(manifestRaw)) {
    throw new ConfigError(`suite 配置 manifest 缺失或不是非空字符串（当前 ${pyTypeName(manifestRaw)}: ${JSON.stringify(manifestRaw)}）`);
  }
  const manifestPath = isAbsolute(manifestRaw) ? manifestRaw : resolve(suiteRoot, manifestRaw);
  if (!existsSync(manifestPath)) {
    throw new ConfigError(`suite 配置指向的 manifest 不存在: ${manifestRaw}（按 suiteRoot 解析为 ${manifestPath}）`);
  }
  let manifest;
  try { manifest = readJsonStrict(manifestPath); } catch {
    diagnostics.push(diagnostic('RULE-CORE-002', 'blocking', 'sdd_suite.json', 1, 'manifest 不是合法 JSON'));
    return diagnostics;
  }
  const coreRoot = dirname(manifestPath);
  const allowed = config.allowedPublicAssets === undefined ? [] : config.allowedPublicAssets;
  if (!Array.isArray(allowed)) throw new ConfigError('allowedPublicAssets 须为数组');
  for (const rel of allowed) {
    if (typeof rel !== 'string') throw new ConfigError('allowedPublicAssets 条目须为字符串');
    let resolved;
    try { resolved = resolveCrossRootAsset(coreRoot, rel, manifest); } catch (e) {
      if (!(e instanceof PathSecurityError)) throw e;
      diagnostics.push(diagnostic('RULE-PATH-002', 'blocking', rel, 1, `路径安全拒绝: ${e.message}`));
      continue;
    }
    if (!existsSync(resolved)) diagnostics.push(diagnostic('RULE-CORE-002', 'blocking', rel, 1, '授权的公开资产不存在'));
  }
  if (existsSync(join(coreRoot, 'SKILL.md'))) diagnostics.push(diagnostic('RULE-CORE-003', 'blocking', 'SKILL.md', 1, '共享内核不得包含 SKILL.md'));
  return diagnostics;
}

export function buildPlanSection(suiteRoot, config, configPath) {
  const section = { checked: 0, blockingCount: 0, warningCount: 0, diagnostics: [] };
  const planDir = join(suiteRoot, 'docs', 'plans');
  if (!existsSync(planDir) || !statSync(planDir).isDirectory()) return section;
  if (!existsSync(join(suiteRoot, '.sdd')) || !statSync(join(suiteRoot, '.sdd')).isDirectory()) return section;
  let entries;
  try { entries = readdirSync(planDir, { withFileTypes: true }); } catch { return section; }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => join(planDir, e.name)).sort((a, b) => codePointCompare(a, b));
  for (const planFile of files) {
    let diagnostics;
    try { diagnostics = checkPlan(planFile, config, { configPath }); } catch {
      section.diagnostics.push(diagnostic(RULE_PLAN_READ, 'warning', planFile, 1, '计划不可读或不是合法 UTF-8，已记录并跳过内容校验'));
      section.checked += 1;
      continue;
    }
    section.diagnostics.push(...diagnostics);
    section.checked += 1;
  }
  section.blockingCount = section.diagnostics.filter((d) => d.severity === 'blocking').length;
  section.warningCount = section.diagnostics.filter((d) => d.severity === 'warning').length;
  return section;
}

export function buildReport(mode, diagnostics, filesChecked) {
  return {
    schemaVersion: '1.0.0',
    mode,
    filesChecked,
    blockingCount: diagnostics.filter((d) => d.severity === 'blocking').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    diagnostics,
  };
}

function emit(report, format) {
  if (format === 'json') emitJson(report);
  else {
    emitText(`mode=${report.mode} files=${report.filesChecked} blocking=${report.blockingCount} warning=${report.warningCount}`);
    for (const d of report.diagnostics) emitText(`${d.ruleId} [${d.severity}] ${d.file}:${d.line} fixHint=${d.fixHint}`);
  }
}

function planMode(planArg, config, configPath, format) {
  if (!planArg) { emitError('--mode plan 需要 --plan <计划路径>', format, true); return EXIT_TOOL; }
  if (!existsSync(resolve(planArg))) { emitError(`计划文件不存在: ${planArg}`, format, true); return EXIT_TOOL; }
  // 诊断 file 字段保留调用方传入形态（Python check_plan 以 PlanPath 原样回指）
  const diagnostics = checkPlan(planArg, config ?? {}, { configPath });
  const report = buildReport('plan', diagnostics, 1);
  emit(report, format);
  return hasBlocking(diagnostics) ? EXIT_TOOL : EXIT_OK;
}

/** 仅用于 F-20：无 --config 的 plan 调用须区分「无 .sdd 体系」与「有 .sdd 但漏传配置」。 */
function hasSddAncestor(planArg) {
  let current = dirname(resolve(planArg));
  for (;;) {
    try {
      if (statSync(join(current, '.sdd')).isDirectory()) return true;
    } catch { /* 不存在即继续向上 */ }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const USAGE = 'usage: validate_specs.mjs [--config PATH] [--mode template|draft|baseline|suite|plan] [--plan PATH]\n'
  + '                        [--format json|text] [--selfcheck] [--root PATH]\n'
  + '\n--root  保留参数：当前不参与判定（受检根以 --config 内声明为准）\n';

function parseArgs(argv) {
  const out = { format: 'json', selfcheck: false, config: null, mode: null, plan: null, root: null, help: false };
  const valueOpts = new Set(['--config', '--mode', '--plan', '--format', '--root']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--selfcheck') { out.selfcheck = true; continue; }
    let name = a; let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (!valueOpts.has(name)) throw new UsageError(`unrecognized arguments: ${a}`);
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) throw new UsageError(`argument ${name}: expected one argument`);
      value = argv[i];
    }
    if (name === '--config') out.config = value;
    else if (name === '--mode') out.mode = value;
    else if (name === '--plan') out.plan = value;
    else if (name === '--format') out.format = value;
    else if (name === '--root') out.root = value;
  }
  if (!['json', 'text'].includes(out.format)) throw new UsageError(`argument --format: invalid choice: '${out.format}'`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { emitText(USAGE.trimEnd()); return EXIT_OK; }
  if (args.mode !== null && !MODES.includes(args.mode)) {
    emitError(`未知模式: ${args.mode}（可选：${MODES.join('/')}）`, args.format);
    return EXIT_TOOL;
  }
  if (args.selfcheck) {
    const diagnostics = selfcheck();
    const report = buildReport('template', diagnostics, -1);
    emit(report, args.format);
    return hasBlocking(diagnostics) ? EXIT_CONTENT : EXIT_OK;
  }

  if (args.mode === 'plan' && !args.config) {
    if (!args.plan) { emitError('--mode plan 需要 --plan <计划路径>', args.format, true); return EXIT_TOOL; }
    if (hasSddAncestor(args.plan)) {
      emitError('缺少 --config（或 --selfcheck）', args.format);
      return EXIT_TOOL;
    }
    const report = { schemaVersion: '1.0.0', mode: 'plan', filesChecked: 0, blockingCount: 0, warningCount: 0, diagnostics: [], skipped: true };
    emit(report, args.format);
    return EXIT_OK;
  }

  if (!args.config) {
    emitError('缺少 --config（或 --selfcheck）', args.format);
    return EXIT_TOOL;
  }
  const configPath = resolve(args.config);
  const { config, error } = loadConfig(configPath);
  if (error) { emitError(error, args.format); return EXIT_TOOL; }
  const suiteRaw = config.suiteRoot === undefined ? '.' : config.suiteRoot;
  if (typeof suiteRaw !== 'string') throw new ConfigError('suiteRoot 须为字符串');
  const suiteRoot = resolve(isAbsolute(suiteRaw) ? suiteRaw : join(dirname(configPath), suiteRaw));
  validateSuiteConfigShape(config, suiteRoot);

  if (args.mode === 'plan') return planMode(args.plan, config, configPath, args.format);

  const documents = config.documents === undefined ? [] : config.documents;
  if (!Array.isArray(documents)) throw new ConfigError('documents 须为数组');
  if (args.mode && args.mode !== 'suite') {
    const conflicts = documents.filter((d) => d && d.validationMode && d.validationMode !== args.mode).map((d) => d.path);
    if (conflicts.length) {
      emitError(`--mode=${args.mode} 与文档声明模式冲突: ${JSON.stringify(conflicts)}`, args.format);
      return EXIT_TOOL;
    }
  }
  const diagnostics = [];
  const noiseTerms = config.implementationNoiseTerms === undefined ? [] : config.implementationNoiseTerms;
  const suiteRun = args.mode === 'suite' || (args.mode === null && documents.some((d) => d?.validationMode === 'suite'));
  if (suiteRun) diagnostics.push(...suiteModeChecks(config, suiteRoot));
  for (const doc of documents) {
    const docMode = doc.validationMode ?? args.mode;
    if (docMode === 'suite') continue;
    diagnostics.push(...validateDocument(suiteRoot, doc, docMode, noiseTerms));
  }
  const report = buildReport(args.mode ?? 'suite', diagnostics, documents.length);
  if (suiteRun) report.plan = buildPlanSection(suiteRoot, config, configPath);
  emit(report, args.format);
  return hasBlocking(diagnostics) ? EXIT_CONTENT : EXIT_OK;
}

if (isMainModule(import.meta.url)) {
  // 用 exitCode 而非 process.exit：大 JSON 经管道输出时 process.exit 会截断 stdout。
  try {
    process.exitCode = main();
  } catch (e) {
    if (e instanceof ConfigError) {
      emitText(errorReport(String(e.message)));
      process.exitCode = EXIT_TOOL;
    } else if (e instanceof UsageError) {
      process.stderr.write(`${USAGE}validate_specs.mjs: error: ${e.message}\n`);
      process.exitCode = EXIT_TOOL;
    } else {
      emitText(errorReport(`校验器内部错误: ${e.message}`));
      process.exitCode = EXIT_TOOL;
    }
  }
}
