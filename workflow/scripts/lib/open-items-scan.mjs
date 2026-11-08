// open-items-scan：OPEN 登记册只读解析面（内部任务-57 步骤 1.1，内部规则-22/内部规则-19 共用读侧）
// 解析 内部规格（或等价六列登记册）为结构化计数与未关项清单——供 user-prompt
// 预筛注入、session-start 存量提醒位、check-repo-consistency 块 21 三面只读消费。
// 纯函数、仅 node: 内置；册缺席/不可读/任何异常返 null（消费面一律 fail-open 零输出）。
// 注意：列切分按未转义竖线（终审正确性发现 2 处置——与块 21 行形态判据同口径）：含 \| 转义
// 的描述行不会整列错位（内部未决-120 守卫的 sanctioned 形态即转义，读侧必须与判据同口径）。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 哨位判据（P4'：等触发/已裁决延出的条目只提示触发条件不催办）——阻塞性列或描述面命中。 */
const SENTRY_BLOCKING_RE = /(等触发|延后|裁决|维持 OPEN)/;
const SENTRY_DESC_RE = /回头条件/;

/**
 * 扫描登记册。
 * @param {string} filePath 登记册文件绝对/相对路径
 * @returns {{unclosed: Array<{id: string, desc: string, blocking: string, sentry: boolean}>,
 *           closedFullText: number, tombstones: number, rowCount: number, maxNo: number}|null}
 *           unclosed 按文件行序；closedFullText＝状态 CLOSED 且无「→」指针的全文行；
 *           tombstones＝状态 CLOSED 且含「→」的行；坏行（列数不足）计入 rowCount/maxNo 不入清单。
 */
export function scanOpenItems(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const unclosed = [];
  let closedFullText = 0;
  let tombstones = 0;
  let rowCount = 0;
  let maxNo = 0;
  for (const line of text.split('\n')) {
    const idm = line.match(/^\| (OPEN-\d+) /);
    if (!idm) continue; // 非数据行
    rowCount += 1;
    const n = Number(idm[1].slice(5));
    if (n > maxNo) maxNo = n;
    const cells = line.split(/(?<!\\)\|/); // ['', 编号, 描述, 类型, 状态, 日期, 阻塞性, '']（未转义竖线切分）
    if (cells.length < 7) continue; // 坏行：计入行数与 maxNo（块 21 连续性判据），不入清单
    const desc = (cells[2] ?? '').trim();
    const status = (cells[4] ?? '').trim();
    const blocking = (cells[6] ?? '').trim();
    if (status === 'CLOSED') {
      if (line.includes('→')) tombstones += 1;
      else closedFullText += 1;
      continue;
    }
    // 未关（OPEN/部分关闭/自由文本状态）
    unclosed.push({
      id: idm[1],
      desc,
      blocking,
      sentry: SENTRY_BLOCKING_RE.test(blocking) || SENTRY_DESC_RE.test(desc),
    });
  }
  return { unclosed, closedFullText, tombstones, rowCount, maxNo };
}

/**
 * 缓存结果形态校验（内部任务-244 遗留项①）：缓存文件是共享状态根内的可写文件，须防跨仓误用/
 * 投毒——只接受「未关项 id 为 `OPEN-\d+`、字段类型正确」的结构化结果，否则丢弃重扫。
 * @param {unknown} result 候选缓存结果
 * @returns {boolean}
 */
function isValidCachedResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(result.unclosed)) return false;
  if (!Number.isInteger(result.rowCount) || !Number.isInteger(result.maxNo)) return false;
  if (!Number.isInteger(result.closedFullText) || !Number.isInteger(result.tombstones)) return false;
  return result.unclosed.every(
    (u) => u && typeof u === 'object'
      && typeof u.id === 'string' && /^OPEN-\d+$/.test(u.id)
      && typeof u.desc === 'string' && typeof u.blocking === 'string' && typeof u.sentry === 'boolean',
  );
}

/**
 * 带册文件 mtime/size 缓存的扫描（内部任务-244 P05＋遗留项①加固）：册未变则复用上次解析结果——
 * UPS 每轮预筛不再重复解析同一份登记册；缓存**键含册文件绝对路径**（同一状态根被多工作区
 * 共用时不得跨仓误用，路径不符即重扫覆盖），并带 schemaVersion 与结果形态校验（坏缓存/
 * 跨仓缓存/投毒形态一律丢弃重扫；fail-open 语义不变）。缓存文件由调用方给路径（状态根内，
 * 纯缓存、可随时删）。
 * @param {string} filePath 登记册路径 @param {string} cacheFile 缓存文件路径
 * @returns {ReturnType<typeof scanOpenItems>}
 */
export function scanOpenItemsCached(filePath, cacheFile) {
  let st = null;
  let keyPath = '';
  try {
    st = statSync(filePath);
    keyPath = resolve(filePath);
  } catch {
    return scanOpenItems(filePath); // 册缺失：交由 scanOpenItems 的 fail-open 空态
  }
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (
      cached && cached.schemaVersion === 1
      && cached.filePath === keyPath
      && cached.mtimeMs === st.mtimeMs && cached.size === st.size
      && isValidCachedResult(cached.result)
    ) {
      return cached.result;
    }
  } catch {
    /* 无缓存/坏缓存：重扫 */
  }
  const result = scanOpenItems(filePath);
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({
      schemaVersion: 1, filePath: keyPath, mtimeMs: st.mtimeMs, size: st.size, result,
    }));
  } catch {
    /* 缓存写失败静默：下次重扫 */
  }
  return result;
}
