// 文件：production_store.mjs
// 描述：production_store.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1b）——CHG-n append-only
//       事件链存储（内部决策-011 / 内部规则-3）：per-CHG 独占锁（wx＋rename 占先回收）、整行写入＋
//       fsync、哈希链前向链接、回放校验（sequence/previousEventHash/eventHash/秘密/迁移）、
//       显式 recover（.probe 后缀探测＋.corrupt 副本保留）。状态只由回放得到。
//       已登记边界（bug-for-bug）：①Python recover 重写无 encoding 参的 GBK mojibake 面
//       （win32 控制台）——原 Python 实现（迁移史见 内部决策-051）潜伏缺陷登记不修（阶段3 拆除时双方一致消失）；②win32 行尾
//       （Python 文本模式 append/recover 产 CRLF、JS 恒 LF——按行解析不受影响、字节面分歧）。
//       读面行切分＝splitlines 全集（probes.mjs SPLITLINES_RE 同款）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import { canonicalJsonBytes, sha256Hex } from './common.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { buildEvent, ProductionValueError, scanSecrets, transitionLegal, validateProfile, verifyEventHash, MAIN_CHAIN } from './production_model.mjs';

export const MAX_LINE_BYTES = 1 << 20;
export const MAX_EVIDENCE_REFS = 64;
export const LOCK_STALE_SECONDS = 300;

/** 测试缝（mode-lifecycle `_testHooks` 先例）——仅测试消费，缺省 null 不改生产路径。 */
export const _testHooks = { afterAppend: null };

/** Python splitlines 全集行切分（probes.mjs SPLITLINES_RE 同款；本文件单源，避免两处副本漂移）。 */
const SPLITLINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// Python `re.match(r"^CHG-[1-9][0-9]*$")` 的 `$` 允许单个尾随换行（门① N3）。
const CHG_ID_RE = /^CHG-[1-9][0-9]*\n?$/;
const uuid8 = () => randomUUID().replaceAll('-', '').slice(0, 8);

const changesDir = (root) => join(root, '.sdd', 'production', 'changes');

/** @param {string} changeId @returns {boolean} */
export function reValidChangeId(changeId) {
  return CHG_ID_RE.test(String(changeId));
}

function changePath(root, changeId) {
  if (!reValidChangeId(changeId)) throw new ProductionValueError(`changeId 非法：${changeId}（须 ^CHG-[1-9][0-9]*$）`);
  return join(changesDir(root), `${changeId}.jsonl`);
}

const lockPath = (root, changeId) => join(changesDir(root), `${changeId}.lock`);
const retireName = (changeId) => `${changeId}.lock.retired-${uuid8()}`;

// 独占锁实现已收敛到 ./lock.mjs（内部任务-241 步骤 15）：wx＋owner uuid＋陈旧回收（返回 retired 诊断）
// ＋release 只删本人锁；本模块只保留 per-CHG 锁路径与回收诊断接线（单一事实源）。
function acquireChangeLock(root, changeId, owner) {
  const path = lockPath(root, changeId);
  const lock = acquireLock(path, { owner });
  return { ok: lock.ok, path, owner: lock.owner, retired: lock.retired };
}

function releaseChangeLock(changeLock) {
  if (changeLock && changeLock.ok) releaseLock(changeLock.path, changeLock.owner);
}

/** 逐行读事件；坏行/半行/超限行均出诊断不静默截断。 */
function readEventsRaw(path) {
  const events = [];
  const diags = [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split(SPLITLINES_RE);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      diags.push({ ruleId: 'PROD-INTEGRITY-LINE-OVERSIZE', severity: 'blocking', message: `第 ${i + 1} 行超过 ${MAX_LINE_BYTES} 字节上限` });
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      // D01（内部任务-241）：合法 JSON 但非对象（如 null/数组/数字）不是事件形态——不得 push 后
      // 在 replay/recover 内解构抛 TypeError；按坏行诊断跳过（修复通道对损坏必须可用）。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        diags.push({ ruleId: 'PROD-INTEGRITY-BADLINE', severity: 'blocking', message: `第 ${i + 1} 行不是 JSON 对象（合法 JSON 但非事件形态）` });
        continue;
      }
      events.push(parsed);
    } catch (e) {
      diags.push({ ruleId: 'PROD-INTEGRITY-BADLINE', severity: 'blocking', message: `第 ${i + 1} 行不是合法 JSON（尾部半行或损坏）` });
    }
  }
  return { events, diags };
}

/**
 * 事件链八项校验共用循环（内部任务-242 §三-3 单源）：replay 全量收集、replayFile 首错停止；
 * 两种模式产**同一 ruleId 序列前缀**（stopOnFirst 差异显式）。
 * @param {Array<object>} events
 * @param {{stopOnFirst?: boolean}} [opts]
 * @returns {{diags: Array<object>, state: string|null, lastEventHash: string|null}}
 */
function scanEvents(events, { stopOnFirst = false } = {}) {
  const diags = [];
  let prevHash = null;
  let state = null;
  let expectedSeq = 1;
  const seenIds = new Set();
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      diags.push({ ruleId: 'PROD-INTEGRITY-BADLINE', severity: 'blocking', message: '事件行不是 JSON 对象（形态非法）' });
      if (stopOnFirst) break;
      continue;
    }
    const seq = ev.sequence;
    if (seq !== expectedSeq) {
      diags.push({ ruleId: 'PROD-INTEGRITY-SEQUENCE', severity: 'blocking', message: `sequence 断裂：期望 ${expectedSeq}，实得 ${seq}` });
      if (stopOnFirst) break;
      expectedSeq = Number.isInteger(seq) ? seq : expectedSeq;
    }
    expectedSeq += 1;
    // Python `ev.get("previousEventHash")`：缺键得 None（终审发现 9——`?? null` 归一）
    if ((ev.previousEventHash ?? null) !== prevHash) {
      diags.push({ ruleId: 'PROD-INTEGRITY-CHAIN', severity: 'blocking', message: `previousEventHash 断链（sequence=${seq}）` });
      if (stopOnFirst) break;
    }
    if (!verifyEventHash(ev)) {
      diags.push({ ruleId: 'PROD-INTEGRITY-HASH', severity: 'blocking', message: `eventHash 重算不符（sequence=${seq}，篡改）` });
      if (stopOnFirst) break;
    }
    if (seenIds.has(ev.eventId)) {
      diags.push({ ruleId: 'PROD-INTEGRITY-DUP', severity: 'blocking', message: duplicateEventIdMessage(seq) /* 内部任务-257 P5-5 承接口：不回显可变 eventId 原文 */ });
      if (stopOnFirst) break;
    }
    seenIds.add(ev.eventId);
    const hits = scanSecrets(ev);
    if (hits.length > 0) {
      diags.push({ ruleId: 'PROD-SECURITY-SECRETS', severity: 'blocking', message: `事件含明文秘密（sequence=${seq}）：命中 ${hits.length} 处（规则标签：${hits.map((h) => String(h).split(':')[0].trim()).join('/')}）——不回显原文` });
      if (stopOnFirst) break;
    }
    const { fromState: frm, toState: to } = ev;
    if (state !== null && frm !== state) {
      diags.push({ ruleId: 'PROD-STATE-FROM', severity: 'blocking', message: `fromState（${frm}）≠ 回放态（${state}）（sequence=${seq}）` });
      if (stopOnFirst) break;
    }
    if (!transitionLegal(frm, to)) {
      diags.push({ ruleId: 'PROD-STATE-ILLEGAL', severity: 'blocking', message: `非法迁移 ${frm}->${to}（sequence=${seq}）` });
      if (stopOnFirst) break;
    }
    if (to === 'temporary-mitigation' && !ev.incidentRef) {
      diags.push({ ruleId: 'PROD-STATE-INCIDENT', severity: 'blocking', message: `temporary-mitigation 缺 incidentRef（sequence=${seq}）` });
      if (stopOnFirst) break;
    }
    prevHash = ev.eventHash;
    state = to;
  }
  return { diags, state, lastEventHash: prevHash };
}

/**
 * 回放事件链得到当前状态；校验 sequence 连续/前向哈希/事件哈希/秘密/迁移合法性。
 * @param {string} root @param {string} changeId @returns {Record<string, unknown>}
 */
/** eventId 重复诊断文案（内部任务-257：序号化，不回显可变 eventId 原文）。 */
export function duplicateEventIdMessage(seq) {
  return `eventId 重复（event#${seq}）`;
}

export function replay(root, changeId) {
  const path = changePath(root, changeId);
  let st = null;
  try { st = statSync(path); } catch { st = null; }
  if (!st || !st.isFile()) {
    return { ok: false, state: null, events: 0, diagnostics: [
      { ruleId: 'PROD-STATE-MISSING', severity: 'blocking', message: `变更记录不存在：${changeId}` }] };
  }
  const { events, diags } = readEventsRaw(path);
  const scanned = scanEvents(events);
  diags.push(...scanned.diags);
  const blocking = diags.filter((d) => d.severity === 'blocking');
  return { ok: blocking.length === 0, state: scanned.state, events: events.length,
    profileDigest: events.length > 0 ? events[0].profileDigest : null,
    taskId: events.length > 0 ? events[0].taskId : null,
    lastEventHash: scanned.lastEventHash, diagnostics: diags };
}

/** 读回放的公开形态（内部接口-13 read-status）。 */
export function readStatus(root, changeId) {
  return replay(root, changeId);
}

function nextChangeId(root) {
  mkdirSync(changesDir(root), { recursive: true });
  const ids = [];
  for (const name of readdirSync(changesDir(root))) {
    const m = /^CHG-(\d+)\.jsonl$/.exec(name);
    if (m) ids.push(Number(m[1]));
  }
  return `CHG-${ids.length > 0 ? Math.max(...ids) + 1 : 1}`;
}

/**
 * 建 CHG draft：校验 profile、派生 profileDigest、落首事件。
 * @param {string} root @param {string} taskId @param {Record<string, unknown>} profile
 * @returns {Record<string, unknown>}
 */
export function createChange(root, taskId, profile) {
  const [ok, reason] = validateProfile(profile);
  if (!ok) return { ok: false, error: `profile 非法：${reason}` };
  const changeId = nextChangeId(root);
  const changeLock = acquireChangeLock(root, changeId, `create-${taskId}`);
  if (changeLock.retired !== null) {
    process.stderr.write(`production：回收陈旧锁 ${changeId}（原持有者 ${changeLock.retired.retiredOwner || '未知'}）\n`);
  }
  if (!changeLock.ok) {
    return { ok: false, error: `CHG ${changeId} 锁被占用（稍后重试或 recover）` };
  }
  try {
    const profileDigest = `sha256:${sha256Hex(canonicalJsonBytes(profile))}`;
    const ev = buildEvent({
      changeId, sequence: 1, previousEventHash: null,
      fromState: '', toState: 'draft', taskId,
      profileId: String(profile.deliveryKind ?? 'unknown'),
      profileDigest, sourceRevision: {}, commitSha: '',
      artifactDigest: null, environment: 'development',
      evidenceRefs: [], actorRef: taskId });
    appendLine(changePath(root, changeId), ev);
    return { ok: true, changeId, profileDigest };
  } finally {
    releaseChangeLock(changeLock);
  }
}

function appendLine(path, event) {
  if ((event.evidenceRefs ?? []).length > MAX_EVIDENCE_REFS) {
    throw new ProductionValueError(`evidence 引用超上限（${MAX_EVIDENCE_REFS}）`);
  }
  // Q06/内部任务-241 步骤19：键序序列化改 canonicalJsonBytes 单源（与 eventHash 口径同源，D06）。
  const line = `${canonicalJsonBytes(event).toString('utf8')}\n`;
  const expected = Buffer.byteLength(line, 'utf8');
  mkdirSync(join(path, '..'), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    const written = writeSync(fd, line);
    if (written !== expected) {
      // D06（内部任务-241 复审）：append-only 链短写 fail-loud（不留半行静默损坏）。
      const e = new Error(`事件链短写：${written}/${expected} 字节（拒绝半行落盘）`);
      e.code = 'SHORT_WRITE';
      throw e;
    }
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* 关闭尽力；不吞原始异常 */ }
  }
}

/** 键排序深拷贝已由 common.canonicalJsonBytes 承担（Q06/内部任务-241 步骤19；与 eventHash 同源）。 */

/**
 * 追加一次状态迁移事件：锁内回放校验→合法性校验→追加→追加后回放复核（失败截断回滚）。
 * @param {string} root @param {string} changeId @param {string} toState
 * @param {Array<object>} evidence @param {object} [opts] 其余关键字参（taskId/commitSha/…）
 */
export function advance(root, changeId, toState, evidence, opts = {}) {
  const { taskId = null, commitSha = '', artifactDigest = null, environment = 'development',
    notApplicable = null, incidentRef = null, actorRef = 'agent', uuidHex, now } = opts;
  if (toState === 'temporary-mitigation' && !incidentRef) {
    return { ok: false, error: 'temporary-mitigation 必须携带 incidentRef（IF-COLLAB-3 条目）' };
  }
  const changeLock = acquireChangeLock(root, changeId, `advance-${randomUUID().replaceAll('-', '').slice(0, 8)}`);
  if (changeLock.retired !== null) {
    process.stderr.write(`production：回收陈旧锁 ${changeId}（原持有者 ${changeLock.retired.retiredOwner || '未知'}）\n`);
  }
  if (!changeLock.ok) {
    return { ok: false, error: `CHG ${changeId} 锁被占用（并发单胜；稍后重试）` };
  }
  try {
    const status = replay(root, changeId);
    if (!status.ok) return { ok: false, error: '事件链损坏，先 recover', diagnostics: status.diagnostics };
    const state = status.state ?? '';
    if (!transitionLegal(state, toState)) {
      return { ok: false, error: `非法迁移：${state || '(空)'} -> ${toState}` };
    }
    if (MAIN_CHAIN.includes(state) && MAIN_CHAIN.includes(toState)) {
      const fromIdx = MAIN_CHAIN.indexOf(state);
      const toIdx = MAIN_CHAIN.indexOf(toState);
      if (toIdx - fromIdx > 1 && !notApplicable) {
        return { ok: false, error: `跨级迁移 ${state}->${toState} 必须携带 not-applicable 处置` };
      }
    }
    const evidenceRefs = evidence.map((e, i) => e.sourceRef || e.subjectId || `ev-${i}`);
    const preScanPayload = { evidenceRefs, notApplicable: notApplicable ?? [], incidentRef, actorRef, commitSha, environment, toState };
    if (scanSecrets(preScanPayload).length > 0) {
      return { ok: false, error: '事件内容含明文秘密，拒绝写入（先脱敏再推进）' };
    }
    const ev = buildEvent({
      changeId, sequence: status.events + 1,
      previousEventHash: status.lastEventHash ?? null,
      fromState: state, toState, taskId: taskId || status.taskId || '',
      profileId: '', profileDigest: status.profileDigest ?? '',
      sourceRevision: {}, commitSha, artifactDigest,
      environment, evidenceRefs,
      notApplicable, incidentRef, actorRef }, { uuidHex, now });
    const path = changePath(root, changeId);
    let preSize = 0;
    try { preSize = statSync(path).size; } catch { preSize = 0; }
    try {
      appendLine(path, ev);
    } catch (e) {
      // D06（内部任务-241 复审①）：短写等失败要截断回滚，链保持写前状态（不靠人工 recover）。
      try {
        const fd = openSync(path, 'r+');
        ftruncateSync(fd, preSize);
        fsyncSync(fd);
        closeSync(fd);
      } catch { /* 回滚尽力；仍返回失败 */ }
      if (e !== null && typeof e === 'object' && e.code === 'SHORT_WRITE') {
        return { ok: false, error: '事件链短写，已回滚本次写入（链保持写前状态）' };
      }
      throw e;
    }
    if (_testHooks.afterAppend) _testHooks.afterAppend(root, changeId);
    const after = replay(root, changeId);
    if (!after.ok) {
      const fd = openSync(path, 'r+');
      ftruncateSync(fd, preSize);
      fsyncSync(fd);
      closeSync(fd);
      return { ok: false, error: '追加后回放复核失败，已回滚本次写入（链保持写前状态）', diagnostics: after.diagnostics };
    }
    return { ok: true, state: after.state, eventId: ev.eventId };
  } finally {
    releaseChangeLock(changeLock);
  }
}

/**
 * 显式恢复：损坏原件保留为 .corrupt 副本后截断到最后的完好前缀（留恢复证据）。
 * @param {string} root @param {string} changeId @returns {Record<string, unknown>}
 */
export function recover(root, changeId) {
  const path = changePath(root, changeId);
  let st = null;
  try { st = statSync(path); } catch { st = null; }
  if (!st || !st.isFile()) return { ok: false, error: `变更记录不存在：${changeId}` };
  const changeLock = acquireChangeLock(root, changeId, `recover-${randomUUID().replaceAll('-', '').slice(0, 8)}`);
  if (changeLock.retired !== null) {
    process.stderr.write(`production：回收陈旧锁 ${changeId}（原持有者 ${changeLock.retired.retiredOwner || '未知'}）\n`);
  }
  if (!changeLock.ok) {
    return { ok: false, error: '锁被占用' };
  }
  try {
    const rawLines = readFileSync(path, 'utf8').split(SPLITLINES_RE);
    let good = 0;
    for (let i = 1; i <= rawLines.length; i += 1) {
      const prefix = `${rawLines.slice(0, i).join('\n')}\n`;
      const tmp = join(changesDir(root), `${changeId}.probe`);
      writeFileSync(tmp, prefix, 'utf8');
      const status = replayFile(tmp);
      try { unlinkSync(tmp); } catch { /* 尽力 */ }
      if (status.ok) good = i;
      else break;
    }
    if (good === rawLines.length) {
      return { ok: true, action: 'clean', note: '链完整，无需恢复' };
    }
    const corrupt = join(changesDir(root), `${changeId}.jsonl.corrupt-${randomUUID().replaceAll('-', '').slice(0, 8)}`);
    renameSync(path, corrupt);
    writeFileSync(path, rawLines.slice(0, good).join('\n') + (good > 0 ? '\n' : ''), 'utf8');
    return { ok: true, action: 'truncated', keptEvents: good, corruptCopy: basename(corrupt) };
  } finally {
    releaseChangeLock(changeLock);
  }
}

/**
 * 对任意事件文件回放（recover 的探测通道；与 replay 同套全量校验——recover 的
 * 「链完整」判定不得弱于 replay）。
 * @param {string} path @returns {Record<string, unknown>}
 */
export function replayFile(path) {
  const { events, diags } = readEventsRaw(path);
  const scanned = scanEvents(events, { stopOnFirst: true });
  diags.push(...scanned.diags);
  const blocking = diags.filter((d) => d.severity === 'blocking');
  return { ok: blocking.length === 0, state: scanned.state, events: events.length, diagnostics: diags };
}
