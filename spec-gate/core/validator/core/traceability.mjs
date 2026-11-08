// 文件：traceability.mjs
// 描述：编号唯一性与追溯链检查（FR/R/AC/A/G-T/T）；F-13 支持 [R-1, R-2] 引用列表。
//       内部任务-237/内部未决-138：行正则支持 R-M\d+-\d+ 与两字域码族；module-volume 文档按 内部决策-060 §6 验收表
//       的 A 行（四列「追溯」列/三列「行为+锁定方式」列）反向判定「R 无 A」，存量档为 warning（见 内部变更-21）。
import { diagnostic } from './diagnostics.mjs';
import { fencedBlockRanges, inFenced } from './markdown.mjs';
import { pySplitLines, pyStrip } from './pycompat.mjs';

const R_ID = 'R-(?:\\d+|M\\d+-\\d+|[A-Za-z]{2,3}-\\d+)';
const A_ID = 'A-(?:\\d+|M\\d+-\\d+|[A-Za-z]{1,4}-\\d+)';
const R_ROW_PATTERN = new RegExp(`^\\|\\s*(${R_ID})\\s*\\|`);
const AC_ROW_PATTERN = /^\|\s*(AC-[A-Za-z0-9_-]+)\s*\|/;
const A_ROW_PATTERN = new RegExp(`^\\|\\s*(${A_ID})\\s*\\|`);
const R_TOKEN_PATTERN = new RegExp(R_ID, 'g');
const ID_TOKEN_PATTERN = new RegExp(
  `^(?:${R_ID}|${A_ID}|AC-[A-Za-z0-9_-]+|FR-[A-Za-z0-9]+-[0-9]+|NFR-[A-Za-z0-9]+-[0-9]+|G-T[0-9]+)$`,
);

function sectionRows(text, rowPattern) {
  const lines = pySplitLines(String(text));
  const ranges = fencedBlockRanges(text);
  const rows = [];
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const stripped = pyStrip(lines[idx - 1]);
    const match = rowPattern.exec(stripped);
    if (match) rows.push({ line: idx, id: match[1], row: lines[idx - 1] });
  }
  return rows;
}

function extractRowTraces(rowText, selfId) {
  const traces = new Set();
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(rowText)) !== null) {
    for (const raw of m[1].split(/[,、，]/)) {
      const token = pyStrip(raw);
      if (token && token !== selfId && ID_TOKEN_PATTERN.test(token)) traces.add(token);
    }
  }
  return traces;
}

/** 内部决策-060 §6 验收表行：裸 token 扫描（含括号内注解 `[R-ka-9 规格面]`），并全量展开压缩形态：
 *  `R-x-1/2/3`（多段斜杠）、`R-x-1..3`、`R-x-1~3`、`R-x-1至3`（范围）；多组各自展开。 */
function expandRefs(text, selfId) {
  const refs = new Set();
  for (const tok of text.match(R_TOKEN_PATTERN) ?? []) if (tok !== selfId) refs.add(tok);
  const base = 'R-(?:M\\d+|[A-Za-z]{2,3})';
  // 斜杠多段：R-x-a/b/c…（可重复多组）
  const slashRe = new RegExp(`(${base})-(\\d+(?:\\s*[/／]\\s*\\d+)+)`, 'g');
  for (const m of text.matchAll(slashRe)) {
    const [, stem, nums] = m;
    for (const n of nums.split(/[/／]/).map((s) => s.trim())) {
      if (/^\d+$/.test(n)) refs.add(`${stem}-${n}`);
    }
  }
  // 范围：R-x-a..b / ~ / — / － / 至（可重复多组）
  const rangeRe = new RegExp(`(${base})-(\\d+)\\s*(?:\\.\\.|~|—|－|至)\\s*(\\d+)`, 'g');
  for (const m of text.matchAll(rangeRe)) {
    const [, stem, fromRaw, toRaw] = m;
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 50) {
      for (let n = from; n <= to; n += 1) refs.add(`${stem}-${n}`);
    }
  }
  return refs;
}

/** 模块 §6「验收表」节（从 `## 6`/`### 6` 起，到下一个同级/更高级标题止）。
 * 内部任务-242 C07：围栏内行不参评（R 行经 sectionRows 跳围栏；A 行此前未跳，围栏示例可冒充追溯）。 */
function acceptTableLines(text) {
  const lines = pySplitLines(String(text));
  const ranges = fencedBlockRanges(text);
  let start = -1;
  for (let i = 1; i <= lines.length; i += 1) {
    if (inFenced(i, ranges)) continue;
    if (/^#{2,3}\s*6[.\s、]/.test(lines[i - 1])) { start = i - 1; break; }
  }
  if (start < 0) return [];
  const level = (lines[start].match(/^#+/) ?? ['##'])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (inFenced(i + 1, ranges)) continue;
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

function splitRow(line) {
  return pyStrip(line).replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((s) => pyStrip(s));
}

/** module-volume 档：A 行（四列取「追溯」列；三列取行为/锁定方式列）反向判定 R 无 A。 */
function checkModuleTraceability(relPath, text, lineOffset, rRows, seenR) {
  const diagnostics = [];
  const lines = acceptTableLines(text);
  const aRows = [];
  let headerMode = 'four';
  let traceIdx = -1;
  for (const ln of lines) {
    const stripped = pyStrip(ln.text);
    if (/^\|\s*(验收|编号)/.test(stripped) && /锁定方式|追溯/.test(stripped)) {
      const cells = splitRow(stripped);
      traceIdx = cells.findIndex((c) => c.includes('追溯'));
      headerMode = traceIdx >= 0 ? 'four' : 'three';
      continue;
    }
    const m = A_ROW_PATTERN.exec(stripped);
    if (!m) continue;
    const cells = splitRow(stripped);
    const cols = headerMode === 'four' ? [cells[traceIdx] ?? ''] : [cells[1] ?? '', cells[2] ?? ''];
    aRows.push({ line: ln.line, id: m[1], refs: expandRefs(cols.join(' '), m[1]) });
  }
  const accepted = new Set();
  for (const a of aRows) {
    for (const rid of a.refs) if (seenR.has(rid)) accepted.add(rid);
  }
  for (const row of rRows) {
    if (accepted.has(row.id)) continue;
    diagnostics.push(diagnostic('RULE-SPEC-001', 'warning', relPath, row.line + lineOffset,
      `存量档[module-volume]：需求 ${row.id} 尚无 A 行追溯；先见 specs/traceability-backlog.json 与 OPEN-210（只收缩棘轮；新增欠账由块 30 与清单棘轮阻止，blocking 切换待 138② 收敛后另批）`));
  }
  return diagnostics;
}

export function checkTraceability(relPath, text, lineOffset = 0, options = {}) {
  const diagnostics = [];
  const documentType = options.documentType;
  const rRows = sectionRows(text, R_ROW_PATTERN);
  const acRows = sectionRows(text, AC_ROW_PATTERN);

  const seenR = new Map();
  for (const row of rRows) {
    if (seenR.has(row.id)) {
      diagnostics.push(diagnostic('RULE-SPEC-005', 'blocking', relPath, row.line + lineOffset, `重复编号 ${row.id}；首次出现于第 ${seenR.get(row.id) + lineOffset} 行`));
    } else {
      seenR.set(row.id, row.line);
    }
  }
  const seenAc = new Map();
  for (const row of acRows) {
    if (seenAc.has(row.id)) {
      diagnostics.push(diagnostic('RULE-SPEC-005', 'blocking', relPath, row.line + lineOffset, `重复编号 ${row.id}；首次出现于第 ${seenAc.get(row.id) + lineOffset} 行`));
    } else {
      seenAc.set(row.id, row.line);
    }
  }

  if (documentType === 'module-volume') {
    diagnostics.push(...checkModuleTraceability(relPath, text, lineOffset, rRows, seenR));
    return diagnostics;
  }

  const rWithAcceptance = new Set();
  for (const row of acRows) {
    const traces = extractRowTraces(row.row, row.id);
    const rTraces = [...traces].filter((t) => R_ROW_PATTERN.test(`| ${t} |`));
    if (rTraces.length === 0) {
      diagnostics.push(diagnostic('RULE-SPEC-001', 'blocking', relPath, row.line + lineOffset, `验收 ${row.id} 必须追溯至少一条 R 条目`));
      continue;
    }
    for (const rid of rTraces) {
      if (seenR.has(rid)) rWithAcceptance.add(rid);
      else diagnostics.push(diagnostic('RULE-SPEC-001', 'blocking', relPath, row.line + lineOffset, `验收 ${row.id} 追溯的 ${rid} 不存在`));
    }
  }
  for (const row of rRows) {
    if (!rWithAcceptance.has(row.id)) {
      diagnostics.push(diagnostic('RULE-SPEC-001', 'blocking', relPath, row.line + lineOffset, `需求 ${row.id} 缺少验收条目`));
    }
  }
  return diagnostics;
}
