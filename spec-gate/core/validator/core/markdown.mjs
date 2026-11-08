// 文件：markdown.mjs
// 描述：Markdown 结构检查（表格分隔行、代码围栏配对）、围栏区间与行内代码 span 解析。
//       F-12：围栏记录开启字符与长度（``` 与 ~~~；关闭需同类且长度≥开启）。
//       内部变更-19：围栏行首空白放宽为任意 [ \t]*（对齐 0.9.1 strip() 语义，识别列表项缩进围栏）。
import { diagnostic } from './diagnostics.mjs';
import { pySplitLines } from './pycompat.mjs';

export const TODO_TOKEN_PATTERN = /(?<![A-Za-z0-9_])(TODO|TBD|FIXME)(?![A-Za-z0-9_])/;

// 内部变更-19：行首空白放宽为任意 [ \t]*——对齐 0.9.1 strip() 语义（列表项内 4 空格缩进围栏同样识别）；
// F-12 的 ~~~ 支持与「关闭须同类且长度≥开启」规则保留。
const OPEN_FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

function fenceInfo(line) {
  const m = OPEN_FENCE_RE.exec(line);
  if (!m) return null;
  const marker = m[1];
  const rest = m[2];
  // 反引号围栏的 info string 不得含反引号（CommonMark）；含反引号视为非围栏行
  if (marker[0] === '`' && rest.includes('`')) return null;
  return { char: marker[0], length: marker.length, rest };
}

function isCloseFence(line, open) {
  const info = fenceInfo(line);
  if (!info) return false;
  return info.char === open.char && info.length >= open.length && info.rest.trim() === '';
}

/** 返回 [{start,end,open}]，闭区间、1 起始；未闭合围栏延伸到 EOF。
 * 内部任务-242 C06：行切分与 plan_check 的 `pySplitLines` 同源（\v\f\x1c-\x1e\x85 等 Python splitlines 断行
 * 不得使围栏区间与正文行号错位）。 */
export function fenceRanges(text) {
  const lines = pySplitLines(String(text));
  const ranges = [];
  let open = null;
  let start = 0;
  for (let idx = 1; idx <= lines.length; idx += 1) {
    const line = lines[idx - 1];
    if (open === null) {
      const info = fenceInfo(line);
      if (info) { open = info; start = idx; }
      continue;
    }
    if (isCloseFence(line, open)) {
      ranges.push({ start, end: idx, open, closed: true });
      open = null;
    }
  }
  if (open !== null) ranges.push({ start, end: lines.length, open, closed: false });
  return ranges;
}

export function fencedBlockRanges(text) {
  return fenceRanges(text).map((r) => [r.start, r.end]);
}

export function inFenced(lineNo, ranges) {
  return ranges.some((r) => {
    const [s, e] = Array.isArray(r) ? r : [r.start, r.end];
    return s <= lineNo && lineNo <= e;
  });
}

/** 行内代码 span（0 起始半开列区间 [start,end)，含定界反引号）：逐行同长配对——
 *  N 连反引号开启、由其后首个恰好 N 连反引号关闭；未配对的 run 是字面量、不阻断后续配对
 *  （先找同长 closer，找不到才把该 run 当文本继续扫描）。
 *  限制（有意收窄）：仅单行；不处理反斜杠转义的反引号；不识别跨行 inline code。 */
export function inlineCodeSpans(line) {
  const runs = [];
  const re = /`+/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    runs.push({ len: m[0].length, start: m.index, end: m.index + m[0].length });
  }
  const spans = [];
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    let j = i + 1;
    while (j < runs.length && runs[j].len !== open.len) j += 1;
    if (j < runs.length) {
      spans.push([open.start, runs[j].end]);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return spans;
}

/** 行内代码 span 掩蔽（单源，内部任务-347/内部未决-152②⑤）：把 span（含定界反引号）按 UTF-16 码元
 *  等长替换为空格——保留行号与行长度口径，掩蔽后文本可直接喂给逐行扫描器。
 *  ⚠ 勿改用 [...line] 码点数组或任何非等长变换（含 toLowerCase——U+0130 小写为两码元），
 *  非 BMP 前置或长度漂移会使 span 下标错位；需要小写比较时先掩蔽原行、后整体 toLowerCase。
 *  消费点：checkGt/checkTodo/collectIdsFromText（掩蔽三处单源，内部任务-347 S1 简洁性维）。 */
export function maskInlineCodeSpans(line) {
  const spans = inlineCodeSpans(line);
  if (spans.length === 0) return line;
  const chars = line.split('');
  for (const [start, end] of spans) for (let k = start; k < end; k += 1) chars[k] = ' ';
  return chars.join('');
}

/** 表格单元格数：剥可选首尾边管后按未转义竖线计数（内部任务-237/内部未决-120；行内代码内竖线照计=GFM）。 */
export function countTableCells(line) {
  const s = String(line).trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  return s.split(/(?<!\\)\|/).length;
}

/** 表格分隔行检查；lineOffset 把 body 相对行号换算为文件真实行号（F-8）。 */
export function checkMarkdownStructure(relPath, text, lineOffset = 0) {
  const diagnostics = [];
  const lines = pySplitLines(String(text));
  const ranges = fenceRanges(text);
  for (let idx = 1; idx <= lines.length; idx += 1) {
    if (inFenced(idx, ranges)) continue;
    const stripped = lines[idx - 1].trim();
    if (!stripped.startsWith('|')) continue;
    const prev = idx >= 2 ? lines[idx - 2].trim() : '';
    if (prev.startsWith('|')) continue;
    if (idx >= lines.length) {
      diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, idx + lineOffset, '表格位于文件末尾，缺少分隔行；补 `|---|` 分隔行'));
      continue;
    }
    const separator = lines[idx].trim();
    if (!(separator.startsWith('|') && separator.includes('---'))) {
      diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, idx + lineOffset, '表头后缺少分隔行；下一行补 `|---|---|`'));
      continue;
    }
    // 内部任务-237/内部未决-120 + 内部任务-242 C05：列数守卫（表头单元格数 ⇒ 分隔行与数据行必须一致；围栏内跳过；
    // HTML 表/跨行单元格不检测）。
    const headerCells = countTableCells(lines[idx - 1]);
    const separatorCells = countTableCells(separator);
    if (separatorCells !== headerCells) {
      diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, idx + 1 + lineOffset,
        `表格分隔行列数不一致：表头 ${headerCells} 列，分隔行 ${separatorCells} 列；补齐或删除多余单元格`));
    }
    for (let j = idx + 2; j <= lines.length; j += 1) {
      if (inFenced(j, ranges)) continue;
      const row = lines[j - 1].trim();
      if (!row.startsWith('|')) break;
      if (/^[|:\-\s]+$/.test(row)) continue;
      const cells = countTableCells(row);
      if (cells !== headerCells) {
        diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, j + lineOffset, `表格列数不一致：表头 ${headerCells} 列，第 ${j} 行 ${cells} 列；补齐或删除多余单元格`));
      }
    }
  }
  for (const r of ranges) {
    if (!r.closed) {
      diagnostics.push(diagnostic('RULE-PACK-002', 'blocking', relPath, r.start + lineOffset, '代码围栏未闭合；补配对的结束行'));
    }
  }
  return diagnostics;
}
