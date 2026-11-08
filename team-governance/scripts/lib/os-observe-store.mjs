// 文件：os-observe-store.mjs
// 描述：os-observation 记录层唯一事实源（内部规则-10 / 内部需求-16 / 内部验收-7）——findings.jsonl
//       追加折叠（同 id 末条为准、坏行跳过、O_APPEND 多写者行级安全）、makeFinding
//       白名单构造器（表外字段禁入，B-M14-5）、秘密兜底（scanSecrets 命中转 parse-error
//       行，内容只存 digest）、ack 前向状态机（open→acknowledged，同文件追加全快照行）、
//       raw 样本游标增量读取（游标损坏→全量重读，findings id 幂等兜底=「基线损坏则重建」）。
//       根目录经 OS_OBSERVE_HOME 注入缝覆盖（测试隔离）。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scanSecrets } from './redaction.mjs';

const FIELDS = [
  'schemaVersion', 'id', 'ts', 'source', 'process', 'endpoint', 'endpointKind', 'viaDomain',
  'class', 'basis', 'firstSeen', 'lastSeen', 'count', 'status', 'note',
];
const RAW_FILE_RE = /^samples-.*\.jsonl$/;

export function osObserveHome() {
  return process.env.OS_OBSERVE_HOME || join(homedir(), '.zcode', 'os-observe');
}

/** sha256(parts.join('|')) 前 16 位（incident-store 同口径）。 */
export function digestOf(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** 白名单构造器：表外字段抛错（程序员守卫），schemaVersion 恒 1。 */
export function makeFinding(fields) {
  for (const k of Object.keys(fields)) {
    if (!FIELDS.includes(k)) throw new Error(`findings 白名单外字段：${k}（B-M14-5）`);
  }
  return { schemaVersion: 1, ...fields };
}

function findingsFile(home) {
  return join(home, 'findings.jsonl');
}

function rawDirOf(home) {
  return join(home, 'raw');
}

function cursorFile(home) {
  return join(rawDirOf(home), 'cursor.json');
}

/** O_APPEND 追加一行 finding；秘密兜底：白名单字段值命中秘密模式（不应发生）转 parse-error 行。 */
export function appendFinding(home, finding) {
  let row = finding;
  if (scanSecrets(finding).length > 0) {
    const lineDigest = digestOf([JSON.stringify(finding)]);
    row = makeFinding({
      id: `of-${digestOf(['parse', '', lineDigest])}`,
      ts: finding.ts, source: 'parse', process: null, endpoint: null, endpointKind: null,
      class: 'unknown', basis: { rule: 'parse-error', lineDigest },
      firstSeen: finding.ts, lastSeen: finding.ts, count: 1,
    });
  }
  mkdirSync(home, { recursive: true });
  appendFileSync(findingsFile(home), `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

/** 读侧折叠：同 id 以末条为准（后行字段覆盖前行），坏行跳过，文件缺失返回空 Map。 */
export function readFindings(home) {
  let text;
  try {
    text = readFileSync(findingsFile(home), 'utf8');
  } catch {
    return new Map();
  }
  const m = new Map();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    if (!row || typeof row.id !== 'string') continue;
    const prev = m.get(row.id);
    m.set(row.id, prev ? { ...prev, ...row } : row);
  }
  return m;
}

/** ack 状态机：仅 open→acknowledged 前向；追加全快照行（保留全部字段 + note）。
 *  note 为 CLI 自由文本——落盘前过 scanSecrets 兜底，命中即整体脱敏（与 appendFinding 同防线）。 */
export function appendStatus(home, id, { status, note } = {}) {
  const cur = readFindings(home).get(id);
  if (!cur) throw new Error(`未知 finding id：${id}`);
  if (status !== 'acknowledged') throw new Error(`仅支持 open→acknowledged 前向（收到 ${status}）`);
  if (cur.status === 'acknowledged') throw new Error('该发现已确认（前向状态机，拒绝重复确认/回退）');
  const safeNote = typeof note === 'string' && scanSecrets({ note }).length > 0 ? '<redacted:secret>' : note;
  const row = makeFinding({ ...cur, ts: Date.now(), status, note: safeNote });
  appendFileSync(findingsFile(home), `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

/** id 解析（ack 写侧）：全等优先 → 唯一前缀（≥4 字符）→ 歧义列候选 / 未知一律抛错。 */
export function resolveFindingId(home, input) {
  const m = readFindings(home);
  if (m.has(input)) return input;
  if (typeof input === 'string' && input.length >= 4) {
    const hits = [...m.keys()].filter((id) => id.startsWith(input));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`前缀歧义（${hits.length} 个候选）：${hits.join(', ')}`);
  }
  throw new Error(`未知 finding id：${input}`);
}

export function writeCursor(home, cursor) {
  mkdirSync(rawDirOf(home), { recursive: true });
  writeFileSync(cursorFile(home), `${JSON.stringify(cursor)}\n`, 'utf8');
}

/**
 * 游标增量读取 raw 样本：按文件名序消费 samples-*.jsonl，返回 {samples, cursor}。
 * 坏行不丢弃——标记 {__parseError:true, lineDigest} 交判定层降级；BOM 首行容忍。
 * 游标损坏（文件已被保留策略删除/行号越界/形态坏）→ 全量重读，幂等由 findings id 去重承担。
 */
export function readRawSince(home, { maxRows = 5000 } = {}) {
  const dir = rawDirOf(home);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => RAW_FILE_RE.test(f)).sort();
  } catch {
    return { samples: [], cursor: null };
  }
  let cursor = null;
  try {
    const c = JSON.parse(readFileSync(cursorFile(home), 'utf8'));
    if (c && typeof c.file === 'string' && typeof c.line === 'number') cursor = c;
  } catch {
    cursor = null;
  }
  let startIdx = 0;
  let startLine = 0;
  if (cursor && files.includes(cursor.file)) {
    startIdx = files.indexOf(cursor.file);
    startLine = cursor.line;
    // 行号越界 = 游标损坏（非「已消费到尾」——尾游标 line ≤ 行数）→ 全量重读
    try {
      const lines = readFileSync(join(dir, cursor.file), 'utf8').split('\n');
      if (startLine > lines.length) {
        startIdx = 0;
        startLine = 0;
        cursor = null;
      }
    } catch {
      startIdx = 0;
      startLine = 0;
      cursor = null;
    }
  }
  const samples = [];
  let lastCursor = cursor;
  for (let i = startIdx; i < files.length; i++) {
    const name = files[i];
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue; // 竞态删除容忍
    }
    const lines = text.split('\n');
    const from = i === startIdx ? startLine : 0;
    let lastNonEmpty = -1;
    for (let k = lines.length - 1; k >= from; k--) {
      if (lines[k].replace(/^\uFEFF/, '').trim()) { lastNonEmpty = k; break; }
    }
    let idx = from;
    let heldTornLine = false;
    for (; idx < lines.length; idx++) {
      if (samples.length >= maxRows) break;
      const t = lines[idx].replace(/^\uFEFF/, '').trim();
      if (!t) continue;
      try {
        samples.push(JSON.parse(t));
      } catch {
        if (i === files.length - 1 && idx === lastNonEmpty) {
          // 末文件末行解析失败：可能是采集器正在写的瞬时破行——不消费，游标停本行待下轮重读
          //（若确为坏行，后续有新样本追加后它不再是末行，即按 parse-error 消费，自愈）
          heldTornLine = true;
          break;
        }
        samples.push({ __parseError: true, lineDigest: digestOf([t]) });
      }
    }
    // 截断在文件中 → cursor=idx（下一条未消费行）；消费到尾 → 去尾部空行
    let end = lines.length;
    while (end > from && lines[end - 1].replace(/^\uFEFF/, '').trim() === '') end--;
    lastCursor = { file: name, line: (heldTornLine || idx < lines.length) ? idx : end };
    if (heldTornLine || samples.length >= maxRows) break;
  }
  return { samples, cursor: lastCursor };
}

/** raw 新鲜度（采集停滞判定与 status 共用）：文件数/字节数/最新 mtime。 */
export function rawFreshness(home) {
  const dir = rawDirOf(home);
  let files;
  try {
    files = readdirSync(dir).filter((f) => RAW_FILE_RE.test(f));
  } catch {
    return { newestTsMs: 0, files: 0, bytes: 0 };
  }
  let newest = 0;
  let bytes = 0;
  for (const f of files) {
    try {
      const st = statSync(join(dir, f));
      bytes += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* 竞态删除容忍 */ }
  }
  return { newestTsMs: newest, files: files.length, bytes };
}

/** 停滞判定（hook/status/adapter 三读取面共用口径，防公式漂移）：阈值 max(2×pollMinutes,30) 分钟。 */
export function staleOf(fresh, pollMinutes, nowMs) {
  const thresholdMin = Math.max(2 * pollMinutes, 30);
  const staleMinutes = fresh.newestTsMs === 0 ? null : Math.round((nowMs - fresh.newestTsMs) / 60000);
  return { staleMinutes, stale: fresh.newestTsMs > 0 && nowMs - fresh.newestTsMs > thresholdMin * 60_000 };
}

/** findings 折叠态聚合（status/adapter/hook 三消费面共用口径）：按 class 计数 + 未确认 suspicious。 */
export function countFindings(findingsMap) {
  const byClass = { allowed: 0, suspicious: 0, unknown: 0 };
  const pending = [];
  for (const f of findingsMap.values()) {
    if (byClass[f.class] !== undefined) byClass[f.class] += 1;
    if (f.class === 'suspicious' && f.status !== 'acknowledged') pending.push(f);
  }
  return { byClass, openSuspicious: pending.length, pending };
}
