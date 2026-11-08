// 文件：test-anchors-lib.mjs
// 描述：设计—测试锚定共享库（内部决策-060 / 内部任务-225）——锚定解析、用例标题索引、ID 引用展开、
//       registry 校验与覆盖计算的单源实现；被 `workflow/scripts/check-test-anchors.mjs`
//       （仓模式）、`workflow/scripts/check-plan-test-anchors.mjs`（计划模式）与
//       `scripts/check-repo-consistency.mjs` 第 28 块共同消费（不双写解析逻辑）。
//       解析域钉死：只读模块分册 §6「验收与追溯」节验收表（四列「编号|可验证行为|追溯|锁定方式」
//       与三列「验收|行为|锁定方式」双形态兼容，内部决策-060 修正案 4；§0.2 前提假设同号双载排除）；
//       用例标题解析＝行首锚 `test('…')` 字面量且声明数须等于解析数（非字面量 fail-loud）。
//       边界：纯只读（不写任何状态）；零第三方依赖；不进 spec-gate core 校验器（内部规则-9）。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 可执行锚类别闭集（内部决策-060 决策 2＋修正案 2 决策 6：第五类命令冒烟）。 */
export const EXECUTABLE_CATEGORIES = Object.freeze(['单元测试', '集成测试', '系统测试', '验收测试', '命令冒烟']);
/** 非可执行锚类别闭集。 */
export const NON_EXECUTABLE_CATEGORIES = Object.freeze(['构建期检查', '人工走查', '审查清单']);
/** 层映射（可执行类别→覆盖报告层键）。 */
export const LAYER_OF_CATEGORY = Object.freeze({
  单元测试: 'unit',
  集成测试: 'integration',
  系统测试: 'system',
  验收测试: 'acceptance',
  命令冒烟: 'command',
});

const SKIP_DIRS = new Set(['node_modules', '.git', '.sdd', '.workflow', '.mimosa', 'reference', 'docs', 'dist', 'build']);
/** 计划/规格 ID 形态（仓内契约面单源；计划门复用）。 */
export const PLAN_ID_RE = /^(?:(?:A|R|D|T|B)-[A-Za-z0-9-]+|FR-[a-z]+-\d+|IF-[A-Z]+-\d+)$/;
/** waiver 固定上限（内部决策-060 修正案 2 决策 7；不得由 registry 放宽）。 */
export const WAIVER_LIMIT = 2;

/** 违规条目构造。 */
function violation(rule, file, line, message, extra = {}) {
  return { rule, file, line, message, ...extra };
}

/**
 * 展开规格 ID 引用（支持 `内部规则-1/2`、`内部规则-1..3`、`内部需求-2/10` 形态）。
 * @param {string} text 任意含 ID 的文本
 * @returns {{R:Set<string>, FR:Set<string>}}
 */
export function expandIdRefs(text) {
  const out = { R: new Set(), FR: new Set() };
  const src = String(text ?? '');
  const familyRe = /\b([RDTBA])-((?:M\d+)|(?:[A-Za-z]{2,3}))-(\d+(?:\.\.\d+)?(?:\/(?:\d+(?:\.\.\d+)?))*)/g;
  for (const m of src.matchAll(familyRe)) {
    const prefix = `${m[1]}-${m[2]}-`;
    for (const part of m[3].split('/')) {
      if (part.includes('..')) {
        const [a, b] = part.split('..').map(Number);
        if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a <= 1000) {
          for (let i = a; i <= b; i += 1) out.R.add(`${prefix}${i}`);
        }
      } else if (Number.isInteger(Number(part))) {
        out.R.add(`${prefix}${part}`);
      }
    }
  }
  const frRe = /\bFR-([a-z]+)-(\d+(?:\.\.\d+)?(?:\/(?:\d+(?:\.\.\d+)?))*)/g;
  for (const m of src.matchAll(frRe)) {
    const prefix = `FR-${m[1]}-`;
    for (const part of m[2].split('/')) {
      if (part.includes('..')) {
        const [a, b] = part.split('..').map(Number);
        if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a <= 1000) {
          for (let i = a; i <= b; i += 1) out.FR.add(`${prefix}${i}`);
        }
      } else if (Number.isInteger(Number(part))) {
        out.FR.add(`${prefix}${part}`);
      }
    }
  }
  return out;
}

/** 按未转义竖线切分 Markdown 表格行。 */
function splitRow(line) {
  return line.split(/(?<!\\)\|/).map((s) => s.trim());
}

/**
 * 路径形态校验（仓根相对、非绝对、无 `..` 段；共享库导出供计划门复用，防词表漂移）。
 * @param {string} rel
 * @returns {string|null}
 */
export function pathProblem(rel) {
  if (!rel) return '路径为空';
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return `拒绝绝对路径：${rel}`;
  if (rel.split(/[\\/]/).includes('..')) return `拒绝越界路径：${rel}`;
  return null;
}

/**
 * 解析锁定方式列（类别闭集＋结构化语法）。
 * @param {string} cell 锁定方式单元格原文
 * @returns {{kind:'missing'|'legacy'|'executable'|'nonExecutable', anchors:Array, nonExecAnchors:Array, errors:Array<{code:string,message:string}>}}
 */
export function parseLockMethod(cell) {
  const raw = String(cell ?? '').trim();
  const result = { kind: 'missing', anchors: [], nonExecAnchors: [], errors: [] };
  if (raw === '') return result;
  const parts = raw.split('；').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return result;
  let legacy = false;
  let execSeen = false;
  let nonExecSeen = false;
  for (const part of parts) {
    // 内部任务-348 批 D/内部未决-180②a：类别闭集由常量派生（三维简洁性维发现 2——lib 内部第二定义点
    // 同批收敛；生成形态与旧字面量逐序等价：执行四类＋命令冒烟＋非可执行三类）
    const m = new RegExp(`^(${[...EXECUTABLE_CATEGORIES, ...NON_EXECUTABLE_CATEGORIES].join('|')})([\\s\\S]*)$`).exec(part);
    if (!m) { legacy = true; continue; }
    const category = m[1];
    const rest = m[2].trim();
    const isExec = EXECUTABLE_CATEGORIES.includes(category);
    if (isExec) execSeen = true;
    else nonExecSeen = true;
    if (!rest) {
      if (isExec) result.errors.push({ code: 'missing-separator', message: `可执行类别须带「｜<路径>」：${category}` });
      else result.nonExecAnchors.push({ category, note: '' });
      continue;
    }
    if (!rest.startsWith('｜')) {
      // 旧自由文本形态（如「审查清单 + lint」「人工走查 + 自动化测试」）整体按 legacy 处理，
      // 由基线棘轮承接；只有尝试结构化（出现全角｜）却形态非法时才报 lock-malformed。
      legacy = true;
      continue;
    }
    const body = rest.slice(1).trim();
    if (isExec) {
      if (category === '命令冒烟') {
        const p = pathProblem(body);
        if (p) result.errors.push({ code: 'invalid-path', message: `${p}（命令冒烟）` });
        else result.anchors.push({ category, path: body, fragment: null });
      } else {
        const idx = body.indexOf('#');
        if (idx <= 0) {
          result.errors.push({ code: 'missing-fragment', message: `测试锚须为「路径#用例标题片段」：${part}` });
          continue;
        }
        const path = body.slice(0, idx).trim();
        const fragment = body.slice(idx + 1).trim();
        const p = pathProblem(path);
        if (p) result.errors.push({ code: 'invalid-path', message: `${p}（${category}）` });
        else if (!fragment) result.errors.push({ code: 'missing-fragment', message: `用例标题片段为空：${part}` });
        else result.anchors.push({ category, path, fragment });
      }
    } else {
      if (!body) result.errors.push({ code: 'invalid-format', message: `非可执行类别说明为空：${part}` });
      else result.nonExecAnchors.push({ category, note: body });
    }
  }
  if (legacy) result.kind = 'legacy';
  else if (execSeen) result.kind = 'executable';
  else if (nonExecSeen) result.kind = 'nonExecutable';
  return result;
}

/**
 * 解析测试源文件中的用例标题（行首锚＋字面量计数 fail-loud）。
 * 标题别名：`test(` 与 `it(` 行首双别名（内部决策-060 修正案 5，2026-10-25 内部任务-209 内部未决-194；
 * 仍限单引号字面量；declared 同时计双别名，非字面量双别名一律整文件 fail-loud）。
 * 预处理剥离块注释与跨行模板字面量区段：模板/注释内的 `test('…')` 文本不计为用例
 * （否则含样例代码的测试文件会自指计入假标题，见 内部任务-225 收尾评审）。
 * @param {string} source 测试源文本
 * @returns {{ok:boolean, titles:string[], declared:number, parsed:number, reason?:string}}
 */
export function parseTestTitles(source) {
  const src = String(source ?? '');
  const lines = src.split('\n');
  const scan = [];
  let inBlockComment = false;
  let inTemplate = false;
  for (const line of lines) {
    let out = '';
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    while (i < line.length) {
      const ch = line[i];
      if (inBlockComment) {
        const close = line.indexOf('*/', i);
        if (close === -1) { i = line.length; break; }
        i = close + 2;
        inBlockComment = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') { inTemplate = false; i += 1; continue; }
        i += 1;
        continue;
      }
      if (inSingle) {
        out += ch;
        if (ch === '\\') { out += line[i + 1] ?? ''; i += 2; continue; }
        if (ch === "'") inSingle = false;
        i += 1;
        continue;
      }
      if (inDouble) {
        out += ch;
        if (ch === '\\') { out += line[i + 1] ?? ''; i += 2; continue; }
        if (ch === '"') inDouble = false;
        i += 1;
        continue;
      }
      if (ch === "'") { inSingle = true; out += ch; i += 1; continue; }
      if (ch === '"') { inDouble = true; out += ch; i += 1; continue; }
      if (line.startsWith('//', i)) break;
      if (line.startsWith('/*', i)) { inBlockComment = true; i += 2; continue; }
      if (ch === '`') { inTemplate = true; i += 1; continue; }
      out += ch;
      i += 1;
    }
    scan.push(out);
  }
  const cleaned = scan.join('\n');
  const declared = (cleaned.match(/^[ \t]*(?:test|it)(?:\.(?:skip|only|todo|each|concurrent))?\(/gm) ?? []).length;
  const titles = [];
  for (const m of cleaned.matchAll(/^[ \t]*(?:test|it)\(\s*'((?:[^'\\]|\\.)*)'/gm)) {
    titles.push(m[1].replace(/\\(.)/g, '$1'));
  }
  if (titles.length !== declared) {
    return { ok: false, titles, declared, parsed: titles.length, reason: `出现非字面量用例标题（test(/it( 声明 ${declared}，解析 ${titles.length}）` };
  }
  return { ok: true, titles, declared, parsed: titles.length };
}

/** 递归收集测试文件（排除 SKIP_DIRS）。 */
function collectTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs);
      else if (/\.test\.mjs$/.test(name)) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

/** POSIX 相对路径（path.relative，兼容缺省根 '.' 与尾分隔符）。 */
function relPosix(root, abs) {
  return relative(root, abs).split('\\').join('/');
}

/**
 * 建立测试用例标题索引（路径→标题数组；解析失败的文标记 ok=false）。
 * @param {string} projectRoot
 * @returns {Map<string,{titles:string[], ok:boolean, reason?:string}>}
 */
export function buildTestIndex(projectRoot) {
  const root = String(projectRoot ?? '.');
  const index = new Map();
  for (const abs of collectTestFiles(root)) {
    const rel = relPosix(root, abs);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const parsed = parseTestTitles(text);
    index.set(rel, { titles: parsed.titles, ok: parsed.ok, reason: parsed.reason });
  }
  return index;
}

/**
 * 解析规格面（§6 验收表 A 行、R 行追溯、FR/IF 全集）。
 * @param {string} projectRoot
 */
export function parseSpecs(projectRoot) {
  const root = String(projectRoot ?? '.');
  const modulesDir = join(root, 'specs', 'modules');
  const aRows = [];
  const rRows = [];
  const parseErrors = [];
  const files = existsSync(modulesDir) ? readdirSync(modulesDir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const f of files) {
    const rel = `specs/modules/${f}`;
    const lines = readFileSync(join(modulesDir, f), 'utf8').split('\n');
    let inAcceptance = false;
    let tableCols = 0; // 4＝编号|可验证行为|追溯|锁定方式；3＝验收|行为|锁定方式（追溯引用嵌于行为格）
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^#{1,6}\s/.test(line)) {
        inAcceptance = /验收/.test(line) && /追溯/.test(line);
        tableCols = 0;
        continue;
      }
      if (!inAcceptance) continue;
      if (!/^\|/.test(line)) { tableCols = 0; continue; }
      const cells = splitRow(line).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
      // 表头识别（两种合法形态，内部决策-060 修正案 4；其他形态 fail-loud 不静默错位）
      if (tableCols === 0) {
        if (cells.includes('锁定方式')) {
          if (cells.length === 4 && /追溯/.test(cells[2])) tableCols = 4;
          else if (cells.length === 3) tableCols = 3;
          else parseErrors.push({ rule: 'spec-table-header', file: rel, line: i + 1, message: `§6 验收表表头形态不受支持（须四列「编号|可验证行为|追溯|锁定方式」或三列「验收|行为|锁定方式」）：${cells.join('|')}` });
        }
        continue;
      }
      if (cells.length < tableCols) {
        if (cells.length > 0 && /^A-/.test(cells[0])) {
          parseErrors.push({ rule: 'spec-row-malformed', file: rel, line: i + 1, message: `§6 验收表 A 行缺列（期望 ${tableCols} 列，实得 ${cells.length}）：${cells[0]}（不得静默丢弃，防新增行绕过锚校验）` });
        }
        continue;
      }
      const id = cells[0];
      if (!/^A-/.test(id)) continue;
      const trace = tableCols === 4 ? cells[2] : cells[1];
      const lock = tableCols === 4 ? cells[3] : cells[2];
      aRows.push({ id, module: f, file: rel, line: i + 1, trace, lock });
    }
    // R 行（全分册任意表：首格 R-）
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      if (!/^\|/.test(line)) continue;
      const cells = splitRow(line).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
      if (cells.length < 3) continue;
      if (!/^R-/.test(cells[0])) continue;
      rRows.push({ id: cells[0], file: rel, line: lineNo, trace: cells.slice(2).join(' ') });
    }
  }
  const frIds = new Set();
  const reqPath = join(root, 'specs', 'requirements.md');
  if (existsSync(reqPath)) {
    for (const line of readFileSync(reqPath, 'utf8').split('\n')) {
      const m = /^\|\s*(FR-[a-z]+-\d+)\s*\|/.exec(line);
      if (m) frIds.add(m[1]);
    }
  }
  const ifRows = [];
  const ifPath = join(root, 'specs', 'interface-registry.md');
  if (existsSync(ifPath)) {
    for (const line of readFileSync(ifPath, 'utf8').split('\n')) {
      const m = /^\|\s*(IF-[A-Z]+-\d+)\s*\|/.exec(line);
      if (!m) continue;
      ifRows.push({ id: m[1], trace: line });
    }
  }
  return { aRows, rRows, frIds, ifRows, files, errors: parseErrors };
}

/**
 * 读取 registry（JSON）；失败抛错（调用方映射为 exit 2）。
 * @param {string} registryPath
 */
export function loadRegistry(registryPath) {
  const buf = readFileSync(registryPath, 'utf8');
  return JSON.parse(buf);
}

/** registry 形态校验（返回违规数组；内部任务-348/内部未决-180⑤ 导出——CLI/块 28 消费单源）。 */
export function validateRegistryShape(registry) {
  const v = [];
  const push = (message) => v.push(violation('registry-schema', 'specs/test-anchors.json', 1, message));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    push('registry 须为 JSON 对象');
    return v;
  }
  if (registry.schemaVersion !== 1) push(`schemaVersion 须为 1（实际 ${String(registry.schemaVersion)}）`);
  const baseline = registry.baseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) push('缺 baseline 对象');
  else {
    if (!Array.isArray(baseline.a) || baseline.a.some((x) => typeof x !== 'string')) push('baseline.a 须为字符串数组');
    if (!Array.isArray(baseline.fr) || baseline.fr.some((x) => typeof x !== 'string')) push('baseline.fr 须为字符串数组');
  }
  if (!Array.isArray(registry.waivers)) push('waivers 须为数组');
  else {
    for (const w of registry.waivers) {
      if (!w || typeof w !== 'object') { push('waiver 条目须为对象'); continue; }
      for (const k of ['id', 'category', 'reason', 'ref']) {
        if (typeof w[k] !== 'string' || !w[k].trim()) push(`waiver 条目缺字段 ${k}`);
      }
    }
  }
  const vis = registry.visibility;
  if (!vis || typeof vis !== 'object') push('缺 visibility 对象');
  else {
    if (!['internal', 'external'].includes(vis.default)) push(`visibility.default 须为 internal/external（实际 ${String(vis.default)}）`);
    if (vis.overrides !== undefined) {
      if (typeof vis.overrides !== 'object' || vis.overrides === null || Array.isArray(vis.overrides)) push('visibility.overrides 须为对象');
      else for (const [k, val] of Object.entries(vis.overrides)) {
        if (!['internal', 'external'].includes(val)) push(`visibility.overrides.${k} 取值非法：${String(val)}`);
      }
    }
  }
  if (!Number.isInteger(registry.expectedARows) || registry.expectedARows <= 0) push('expectedARows 须为正整数');
  return v;
}

/**
 * 校验 registry＋规格面＋测试索引。
 * @param {{projectRoot:string, registry:object, specs:object, testIndex:Map}} input
 * @returns {{ok:boolean, violations:Array, coverage:object, methodStates:object, summary:object}}
 */
export function validateRegistry({ projectRoot, registry, specs, testIndex }) {
  const root = String(projectRoot ?? '.');
  const violations = [...validateRegistryShape(registry)];
  const shapeOk = violations.length === 0;
  for (const e of specs.errors ?? []) violations.push(violation(e.rule ?? 'spec-table-header', e.file, e.line, e.message));
  const baselineA = new Set(Array.isArray(registry?.baseline?.a) ? registry.baseline.a : []);
  const baselineFr = new Set(Array.isArray(registry?.baseline?.fr) ? registry.baseline.fr : []);
  const waivers = Array.isArray(registry?.waivers) ? registry.waivers : [];
  const waiverById = new Map();
  for (const w of waivers) {
    if (!w || typeof w.id !== 'string') continue;
    if (waiverById.has(w.id)) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `waiver id 重复：${w.id}`));
    else waiverById.set(w.id, w);
  }
  const maxWaivers = WAIVER_LIMIT;
  if (waivers.length > maxWaivers) {
    violations.push(violation('waiver-limit', 'specs/test-anchors.json', 1, `waiver 总数 ${waivers.length} 超上限 ${maxWaivers}（防全量 waiver 稀释验证力）`));
  }
  const aById = new Map(specs.aRows.map((r) => [r.id, r]));
  const methodStates = {};
  const rToFr = new Map();
  for (const r of specs.rRows) rToFr.set(r.id, expandIdRefs(r.trace).FR);

  // baseline ID 存在性
  for (const id of baselineA) {
    if (!aById.has(id)) violations.push(violation('baseline-unknown-id', 'specs/test-anchors.json', 1, `baseline.a 含规格中不存在的 A 行：${id}`, { id }));
  }
  for (const fr of baselineFr) {
    if (!specs.frIds.has(fr)) violations.push(violation('fr-baseline-unknown', 'specs/test-anchors.json', 1, `baseline.fr 含规格中不存在的 FR：${fr}`, { id: fr }));
  }

  // A 行逐一校验
  const validExecutable = new Set();
  for (const row of specs.aRows) {
    const method = parseLockMethod(row.lock);
    methodStates[row.id] = { kind: method.kind, validExec: false, anchors: method.anchors, nonExecAnchors: method.nonExecAnchors };
    const inBaseline = baselineA.has(row.id);
    const waiver = waiverById.get(row.id);
    if (method.errors.length > 0) {
      for (const e of method.errors) {
        violations.push(violation('lock-malformed', row.file, row.line, `${row.id} 锁定方式语法错误：${e.message}`, { id: row.id }));
      }
      if (inBaseline) violations.push(violation('baseline-stale', 'specs/test-anchors.json', 1, `${row.id} 已结构化（含语法错误）却仍残留 baseline.a`, { id: row.id }));
      continue;
    }
    if (method.kind === 'executable') {
      if (waiver) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} 已是可执行锚行，不得登记 waiver（waiver 仅限非可执行类别）`, { id: row.id }));
      if (inBaseline) violations.push(violation('baseline-stale', 'specs/test-anchors.json', 1, `${row.id} 已有可执行锚却仍残留 baseline.a（棘轮只收缩）`, { id: row.id }));
      let ok = true;
      for (const a of method.anchors) {
        if (a.category === '命令冒烟') {
          const abs = join(root, a.path);
          if (!existsSync(abs) || !statSync(abs).isFile()) {
            violations.push(violation('anchor-script-missing', row.file, row.line, `${row.id} 命令冒烟脚本不存在：${a.path}`, { id: row.id }));
            ok = false;
            continue;
          }
          const body = readFileSync(abs, 'utf8');
          if (!body.includes('--selftest')) {
            violations.push(violation('anchor-script-no-selftest', row.file, row.line, `${row.id} 命令冒烟脚本不含 --selftest：${a.path}`, { id: row.id }));
            ok = false;
          }
          continue;
        }
        const abs = join(root, a.path);
        if (!a.path.endsWith('.test.mjs')) {
          violations.push(violation('anchor-not-test-file', row.file, row.line, `${row.id} 测试锚路径须以 .test.mjs 结尾：${a.path}`, { id: row.id }));
          ok = false;
          continue;
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          violations.push(violation('anchor-path-missing', row.file, row.line, `${row.id} 锚文件不存在：${a.path}`, { id: row.id }));
          ok = false;
          continue;
        }
        const entry = testIndex.get(a.path);
        if (!entry) {
          violations.push(violation('anchor-path-missing', row.file, row.line, `${row.id} 锚文件不在测试索引（非 .test.mjs 或不可读）：${a.path}`, { id: row.id }));
          ok = false;
          continue;
        }
        if (!entry.ok) {
          violations.push(violation('anchor-file-unparsable', row.file, row.line, `${row.id} 锚文件出现非字面量用例标题：${a.path}（${entry.reason ?? ''}）`, { id: row.id }));
          ok = false;
          continue;
        }
        const matches = entry.titles.filter((t) => t.includes(a.fragment));
        if (matches.length === 0) {
          violations.push(violation('anchor-title-missing', row.file, row.line, `${row.id} 用例标题片段 0 匹配：${a.path} # ${a.fragment}`, { id: row.id }));
          ok = false;
        } else if (matches.length > 1) {
          violations.push(violation('anchor-title-ambiguous', row.file, row.line, `${row.id} 用例标题片段匹配 ${matches.length} 条（须恰唯一）：${a.fragment}`, { id: row.id }));
          ok = false;
        }
      }
      if (ok) validExecutable.add(row.id);
      methodStates[row.id].validExec = ok;
      continue;
    }
    if (method.kind === 'nonExecutable') {
      // 存量非可执行类别行允许留在基线（grandfathered）；仅在未入基线时要求 waiver。
      if (waiver) {
        const categoryOk = method.nonExecAnchors.some((n) => n.category === waiver.category);
        if (!categoryOk) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} waiver category 与规格类别不匹配（${waiver.category}）`, { id: row.id }));
        if (String(waiver.reason ?? '').trim().length < 8) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} waiver reason 少于 8 字`, { id: row.id }));
        if (!String(waiver.ref ?? '').trim()) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} waiver ref 为空`, { id: row.id }));
        if (inBaseline) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} waiver 与 baseline 重复登记`, { id: row.id }));
      } else if (!inBaseline) {
        violations.push(violation('a-row-unanchored', row.file, row.line, `${row.id} 非可执行类别未登记 waiver 且不在基线`, { id: row.id }));
      }
      continue;
    }
    // legacy / missing（修正案 4 决策 13：legacy 只能由基线承接，登记 waiver 一律违例）
    if (waiver) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `${row.id} legacy/缺少锁定方式行不得以 waiver 替代（须结构化或留在基线）`, { id: row.id }));
    if (!inBaseline) {
      if (!waiver) violations.push(violation('a-row-unanchored', row.file, row.line, `${row.id} 未结构化且不在基线（新增/变更须挂可执行锚）`, { id: row.id }));
    }
  }

  // waiver 的 ID 存在性
  for (const [id] of waiverById) {
    if (!aById.has(id)) violations.push(violation('waiver-invalid', 'specs/test-anchors.json', 1, `waiver 指向不存在的 A 行：${id}`, { id }));
  }

  // FR 锚定（A 行可执行锚 → R 链 → FR）
  const anchoredFr = new Set();
  for (const row of specs.aRows) {
    if (!validExecutable.has(row.id)) continue;
    const refs = expandIdRefs(row.trace);
    for (const rid of refs.R) {
      for (const fr of rToFr.get(rid) ?? []) anchoredFr.add(fr);
    }
    for (const fr of refs.FR) anchoredFr.add(fr);
  }
  for (const fr of specs.frIds) {
    if (anchoredFr.has(fr)) {
      if (baselineFr.has(fr)) violations.push(violation('fr-baseline-stale', 'specs/test-anchors.json', 1, `${fr} 已锚定却仍残留 baseline.fr`, { id: fr }));
    } else if (!baselineFr.has(fr)) {
      violations.push(violation('fr-unanchored', 'specs/requirements.md', 1, `${fr} 无可执行锚且不在基线`, { id: fr }));
    }
  }

  // 存活锚
  if (specs.aRows.length === 0) violations.push(violation('scope-empty', 'specs/modules', 1, 'A 行扫描数为 0（存活锚：防解析面失效静默全绿）'));
  if (testIndex.size === 0) violations.push(violation('scope-empty', 'tests', 1, '测试用例索引为 0（存活锚）'));
  if (Number.isInteger(registry?.expectedARows) && specs.aRows.length !== registry.expectedARows) {
    violations.push(violation('a-row-count-mismatch', 'specs/modules', 1, `A 行扫描数 ${specs.aRows.length} ≠ expectedARows ${registry.expectedARows}（解析面漂移或常量过期）`));
  }

  const coverage = computeCoverage({ specs, testIndex, methodStates, anchoredFr });
  const summary = {
    aRows: specs.aRows.length,
    executable: [...validExecutable].length,
    waivers: waivers.length,
    baselineA: baselineA.size,
    baselineFr: baselineFr.size,
    frTotal: specs.frIds.size,
    frAnchored: anchoredFr.size,
    testFiles: testIndex.size,
  };
  return { ok: violations.length === 0 && shapeOk, violations, coverage, methodStates, summary };
}

/**
 * 计算覆盖报告（modules/layers/domains/interfaces/summary 五节）。
 * @param {{specs:object, testIndex:Map, methodStates:object, anchoredFr:Set<string>}} input
 */
export function computeCoverage({ specs, testIndex, methodStates, anchoredFr = new Set() }) {
  const modules = {};
  for (const row of specs.aRows) {
    const key = row.file;
    modules[key] ??= { total: 0, executable: 0, nonExecutable: 0, baseline: 0, missing: 0 };
    const st = methodStates[row.id] ?? { kind: 'missing', validExec: false };
    modules[key].total += 1;
    if (st.validExec) modules[key].executable += 1;
    else if (st.kind === 'nonExecutable') modules[key].nonExecutable += 1;
    else if (st.kind === 'executable') modules[key].missing += 1;
    else modules[key].baseline += 1;
  }
  const layers = {
    unit: { executable: 0 },
    integration: { executable: 0 },
    system: { executable: 0 },
    acceptance: { executable: 0 },
    command: { executable: 0 },
    nonExecutable: { declared: 0 },
  };
  for (const row of specs.aRows) {
    const st = methodStates[row.id];
    if (!st) continue;
    if (st.kind === 'executable') {
      if (!st.validExec) continue; // 只有通过校验的可执行锚才计入层覆盖（与模块维度 missing 口径一致）
      for (const a of st.anchors ?? []) {
        const layer = LAYER_OF_CATEGORY[a.category];
        if (layer && layers[layer]) layers[layer].executable += 1;
      }
    } else if (st.kind === 'nonExecutable') {
      layers.nonExecutable.declared += 1;
    }
  }
  const domains = {};
  for (const fr of specs.frIds) {
    const m = /^FR-([a-z]+)-\d+$/.exec(fr);
    const dom = m ? m[1] : 'unknown';
    domains[dom] ??= { frTotal: 0, anchored: 0 };
    domains[dom].frTotal += 1;
    if (anchoredFr.has(fr)) domains[dom].anchored += 1;
  }
  let ifCovered = 0;
  for (const row of specs.ifRows) {
    const refs = expandIdRefs(row.trace);
    if ([...refs.FR].some((fr) => anchoredFr.has(fr))) ifCovered += 1;
  }
  const summary = {
    aRows: specs.aRows.length,
    executable: [...specs.aRows].filter((r) => methodStates[r.id]?.validExec).length,
    frTotal: specs.frIds.size,
    frAnchored: anchoredFr.size,
    testFiles: testIndex.size,
  };
  return { modules, layers, domains, interfaces: { total: specs.ifRows.length, covered: ifCovered }, summary };
}

/** 人类可读覆盖报告（Markdown）。 */
export function formatMarkdownReport(report) {
  const lines = [];
  lines.push('## 覆盖报告（ADR-060 设计—测试锚定）', '');
  lines.push('### 模块覆盖', '', '| 模块分册 | A 行 | 可执行锚 | 非可执行 | 基线 | 缺失 |', '|---|---|---|---|---|---|');
  for (const [file, c] of Object.entries(report.coverage.modules)) {
    lines.push(`| ${file} | ${c.total} | ${c.executable} | ${c.nonExecutable} | ${c.baseline} | ${c.missing} |`);
  }
  lines.push('', '### 层覆盖（命令级含命令冒烟）', '', '| 层 | 可执行锚 |', '|---|---|');
  for (const [layer, c] of Object.entries(report.coverage.layers)) {
    lines.push(`| ${layer} | ${c.executable ?? c.declared ?? 0} |`);
  }
  lines.push('', '### FR 域覆盖', '', '| 域 | FR | 已锚定 |', '|---|---|---|');
  for (const [dom, c] of Object.entries(report.coverage.domains)) lines.push(`| ${dom} | ${c.frTotal} | ${c.anchored} |`);
  lines.push('', `### IF 信息面：${report.coverage.interfaces.covered}/${report.coverage.interfaces.total}`, '');
  lines.push('### 汇总', '', '```json', JSON.stringify(report.summary, null, 2), '```', '');
  if (report.violations.length > 0) {
    lines.push('### 违规', '');
    for (const v of report.violations) lines.push(`- [${v.rule}] ${v.file}:${v.line} ${v.message}`);
  }
  return lines.join('\n');
}

/** 规格 ID 是否在预建索引中存在（计划门用；内部任务-348/内部未决-180④——索引必填：入口 specIdIndex
 *  一次建全仓贯穿；三维简洁性维终评：无索引回退分支零消费方，签名收敛删回退与死变量）。 */
export function idExistsInSpecs(prebuiltIndex, id) {
  if (!PLAN_ID_RE.test(id)) return false;
  return prebuiltIndex.has(id);
}

/**
 * 规格 ID 一次性索引（内部任务-348/内部未决-180④）：requirements/interface-registry/modules 全量读一次
 * 构建全 ID 集——计划门入口建一次，逐行判定 O(1)（替代逐 ID 全量重读规格树）。
 * @param {string} projectRoot 项目根
 * @returns {Set<string>} 全部规格 ID 集
 */
export function specIdIndex(projectRoot) {
  const root = String(projectRoot ?? '.');
  const ids = new Set();
  const collectFile = (abs) => {
    try {
      const lines = readFileSync(abs, 'utf8').split('\n');
      for (const l of lines) {
        // 行首表格列 token 经 PLAN_ID_RE 单源判定（S2 门评审发现 1：平行段长正则 {1,6}
        // 漏收 内部接口-1 等长段 ID → dangling-id 假红；单源后覆盖面与计划门形态判定恒一致）
        const m = /^\|\s*([^\s|]+)\s*\|/.exec(l);
        if (m && PLAN_ID_RE.test(m[1])) ids.add(m[1]);
      }
    } catch { /* 单文件缺席跳过 */ }
  };
  // 三维简洁性维终评：collectFile 内已逐文件吞错、join 不抛——前两调用不再包冗余外层 try
  collectFile(join(root, 'specs', 'requirements.md'));
  collectFile(join(root, 'specs', 'interface-registry.md'));
  try {
    const modulesDir = join(root, 'specs', 'modules');
    if (existsSync(modulesDir)) for (const f of readdirSync(modulesDir).filter((x) => x.endsWith('.md'))) collectFile(join(modulesDir, f));
  } catch { /* 兜 readdirSync（目录列举面） */ }
  return ids;
}
