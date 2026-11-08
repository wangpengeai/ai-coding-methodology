// 文件：plan_check.mjs
// 描述：plan 校验模式（内部接口-1 / 内部决策-1）：specRefs 引用存在性与步骤验收行。
//       F-10：ASCII 边界、BOM 剥离；行号回指计划文件真实行号。
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { diagnostic } from './diagnostics.mjs';
import { fenceRanges, inFenced, maskInlineCodeSpans } from './markdown.mjs';
import { PY_WS_CLASS, pySplitLines, pyStrip, readUtf8Text } from './pycompat.mjs';

export const RULE_PLAN = 'RULE-PLAN-001';
export const RULE_PLAN_READ = 'RULE-PLAN-002';

const SPECREFS_INLINE_RE = /^specRefs:\s*\[(.*)\]\s*$/;
const SPECREFS_KEY_RE = /^specRefs:\s*$/;
const SPECREFS_ITEM_RE = /^\s*-\s*(\S+?)\s*$/;
export const STEP_HEADING_RE = new RegExp(`^#{1,6}${PY_WS_CLASS}*(?:步骤|step|任务|task|\\d)`, 'i');
const ACCEPTANCE_LINE_RE = /^\s*(?:[-*+]\s*)?验收\s*[:：]/;
const ID_TOKEN_RE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+(?![A-Za-z0-9_])/g;
const AUTHORITATIVE_TYPES = new Set(['requirement-baseline', 'adr', 'adr-registry', 'open-item-register', 'interface-registry']);
const ARCHITECTURE_TYPES = new Set(['architecture']);
const ARCH_ADR_HEADING_RE = /^#{2,6}[ \t]+(ADR-[0-9]+)/;

export function collectArchitectureAnchors(path, known) {
  let text;
  try { text = readUtf8Text(path); } catch { return; }
  const lines = pySplitLines(text);
  const ranges = fenceRanges(text);
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const m = ARCH_ADR_HEADING_RE.exec(lines[idx - 1]);
    if (m) known.add(m[1]);
  }
}

export function resolveSuiteRoot(suiteConfig, configPath, planPath) {
  if (configPath) {
    const raw = String(suiteConfig?.suiteRoot ?? '.');
    const base = dirname(resolve(configPath));
    return resolve(isAbsolute(raw) ? raw : join(base, raw));
  }
  let current = dirname(resolve(planPath));
  for (;;) {
    if (existsSync(join(current, '.sdd/suite.json')) || existsSync(join(current, 'specs/requirements.md'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function collectIdsFromText(text, known) {
  // 内部未决-152②（内部任务-347）：围栏与行内代码中的 ID 不入 knownIds——围栏内 ID 计入会使悬空引用
  // 检查漏报（围栏样本「看起来定义了」）。行切分与 fenceRanges 同源用 pySplitLines（内部任务-242 C06：
  // \v\f\x1c-\x1e\x85 等 Python splitlines 断行不得使围栏区间与行号错位，禁 text.split('\n')）；
  // 行内掩蔽按 UTF-16 码元等长替换（与 checkGt 的 内部未决-152④ 手法一致）。
  const src = String(text);
  const ranges = fenceRanges(src);
  const lines = pySplitLines(src);
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    for (const m of maskInlineCodeSpans(lines[idx - 1]).matchAll(ID_TOKEN_RE)) known.add(m[0]);
  }
}
function collectIdsFromFile(path, known) {
  let text;
  try { text = readUtf8Text(path); } catch { return; }
  collectIdsFromText(text, known);
  const stem = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  known.add(stem);
}
export function knownIds(suiteConfig, planPath, configPath = null) {
  const known = new Set();
  const root = resolveSuiteRoot(suiteConfig ?? {}, configPath, planPath);
  if (!root) return known;
  for (const doc of suiteConfig?.documents ?? []) {
    const rel = doc?.path;
    if (!rel) continue;
    const full = isAbsolute(rel) ? rel : join(root, rel);
    if (AUTHORITATIVE_TYPES.has(doc.documentType)) collectIdsFromFile(full, known);
    else if (ARCHITECTURE_TYPES.has(doc.documentType)) collectArchitectureAnchors(full, known);
  }
  for (const fallback of [join(root, 'specs/requirements.md'), join(root, 'specs/adr-registry.md')]) {
    collectIdsFromFile(fallback, known);
  }
  return known;
}

function frontmatterEnd(lines) {
  if (lines.length === 0 || pyStrip(lines[0]) !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (pyStrip(lines[i]) === '---') return i + 1;
  }
  return null;
}

function parseSpecRefs(lines) {
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd === null) return { refs: [], line: 0, fmEnd: null };
  const refs = [];
  let refLine = 0;
  let inList = false;
  for (let idx = 2; idx < fmEnd; idx += 1) {
    const line = lines[idx - 1];
    const inline = SPECREFS_INLINE_RE.exec(line);
    if (inline) {
      refLine = idx;
      refs.splice(0, refs.length, ...inline[1].split(',').map((t) => pyStrip(t)).filter(Boolean));
      inList = false;
      continue;
    }
    if (SPECREFS_KEY_RE.test(line)) { refLine = idx; inList = true; continue; }
    if (inList) {
      const item = SPECREFS_ITEM_RE.exec(line);
      if (item) refs.push(item[1]);
      else if (pyStrip(line)) inList = false;
    }
  }
  return { refs, line: refLine, fmEnd };
}

function checkSteps(lines, planPath, ranges = []) {
  const diagnostics = [];
  const fmEnd = frontmatterEnd(lines);
  const bodyStart = fmEnd !== null ? fmEnd + 1 : 1;
  let stepLine = 0;
  let stepHasAcceptance = true;
  const reportMissing = (lineNo) => diagnostics.push(diagnostic(
    RULE_PLAN, 'warning', planPath, lineNo,
    `计划步骤无验收方式：第 ${lineNo} 行步骤标题后缺「验收：」行（IF-COLLAB-1）`,
  ));
  for (let idx = bodyStart; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue; // 内部任务-237/内部未决-152①：围栏内步骤标题不计
    const line = lines[idx - 1];
    if (STEP_HEADING_RE.test(line)) {
      if (stepLine && !stepHasAcceptance) reportMissing(stepLine);
      stepLine = idx;
      stepHasAcceptance = false;
    } else if (stepLine && ACCEPTANCE_LINE_RE.test(line)) {
      stepHasAcceptance = true;
    }
  }
  if (stepLine && !stepHasAcceptance) reportMissing(stepLine);
  return diagnostics;
}

/**
 * 校验单个计划；diagnostics 含 blocking（悬空引用）与 warning（缺 specRefs/验收）。
 * @param {string} planPath
 * @param {object} suiteConfig
 * @param {{configPath?: string|null, knownIds?: Iterable<string>|null}} [opts]
 */
export function checkPlan(planPath, suiteConfig, opts = {}) {
  const text = readUtf8Text(planPath);
  const lines = pySplitLines(text);
  const diagnostics = [];
  const { refs, line: refLine } = parseSpecRefs(lines);
  if (refs.length === 0) {
    diagnostics.push(diagnostic(RULE_PLAN, 'warning', planPath, 1, '计划未追溯规格：frontmatter 缺 specRefs 或为空（IF-COLLAB-1）'));
  } else {
    const known = opts.knownIds ? new Set(opts.knownIds) : knownIds(suiteConfig ?? {}, planPath, opts.configPath ?? null);
    for (const ref of refs) {
      if (!known.has(ref)) {
        diagnostics.push(diagnostic(RULE_PLAN, 'blocking', planPath, refLine, `悬空引用：${ref} 在规格体系中不存在（IF-COLLAB-1）`));
      }
    }
  }
  diagnostics.push(...checkSteps(lines, planPath, fenceRanges(text)));
  return diagnostics;
}
