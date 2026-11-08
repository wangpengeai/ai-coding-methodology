// 文件：incident-store.mjs
// 描述：运行自察（内部模块-15/内部决策-019）异常记录存储库——项目根 内部工作流状态
//       的追加/读取/聚合/状态机单一事实源。写路径取 O_APPEND 追加（多会话并发安全：
//       整文件「读改写+rename」在并发追加下会互相覆盖丢记录——2026-09-13 plan-review
//       阻塞项裁决）；幂等去重与坏行容忍都在读侧（同 id 以文件末条为准——状态变更行在
//       后，前向状态机天然胜出；2026-09-19 评审修复：头注原写「只保留首条」与实现相反）。
//       脱敏纪律：调用方只应写入 digest 与类别（内部规则-2），本库不感知也不校验内容。
//       记录字段：schemaVersion/id/ts/session/taskId/skill/plugin/kind/tool/event/
//       digest/count/status/note；kind ∈ tool-failure|hook-failure|retry-loop|user-correction|lease-deny|bootstrap-reissue|lease-loop|lease-read-anomaly|lease-revive
//       （lease-deny 为 2026-09-13 加固批次新增：任务租约闸 deny 留痕；2026-09-15 激活域批次起
//       读侧分层——待排查指针口径为 open 且 kind∉排除面，声明成功经 resolveOpenByKind 自愈；
//       lease-revive 为 内部决策-045/内部任务-96 新增（宽限复活/复活守卫留痕——设计内恢复事件，同批入
//       PENDING_EXCLUDED_KINDS 排除面：留痕供 incident-cli 查询审计，不计待排查——防设计内
//       恢复被渲染成永久「待排查」噪音稀释真信号；评审视角二 #2 裁决 2026-10-15）；2026-09-30 内部任务-OSNOISE-1/内部决策-033 起
//       待排查为**双层口径**：再排除（kind=tool-failure 且
//       errorClass=exit-nonzero）——探针噪声＝工具正常执行、命令自答非零，属证据非待办；该轴
//       只作用于 tool-failure（护 lease-loop 强制显示不变量），名单与作用域 kind 见 PENDING_* 常量；
//       同批 Stop 收尾汇总加状态门、提醒面计数原语为 isPendingIncident/countSummary，
//       openCount 保留（行为不变）；openCountExcludingKind/openSplitBySession 已删（内部未决-47 收敛，
//       2026-10-12 内部任务-44——无生产消费方）；pendingSplitBySession 亦于 2026-10-24 内部任务-195
//       （内部决策-063 修正案 3 决策 24.1）删除——零生产消费方，归属拆分改由 incident-summary
//       buildSummary 的 byTask/bySession/byOthers 单点派生）；
//       bootstrap-reissue 为 2026-09-16 租约族缺陷批次新增：补签自救审计记号，见 内部接口-19；
//       lease-loop 为 2026-09-22 内部任务-LEASEGATE-1 新增：lease-deny 同签名振荡升级信号——不可
//       自愈（不入 resolveOpenByKind 面）、计入待排查指针，见 内部规则-13 ④；
//       lease-read-anomaly 为 2026-10-09 内部任务-27 新增：租约读侧三态取证记号（可选字段
//       fileKind/state/recovered/stateRootDigest/envDigest，契约见 内部接口-19 §2）——写入方
//       在 task-lease-lib recordLeaseReadAnomaly，本库不感知字段语义）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 注入缝：WF_INCIDENT_ROOT（覆盖 root 推导——测试隔离与诊断用）。
// 用法：被 hooks（post-tool/user-prompt/task-recap）与 incident-cli.mjs 共同消费；
//       直接运行无副作用（纯库）。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PENDING_CAUSES, EVIDENCE_CAUSES, CAUSES, loadRules } from './incident-rules.mjs';
import { digest16, noteHookIssue } from '../../hooks/hook-lib.mjs';
import { activationRoot, projectKey, stateRootFor, ttlMs } from '../../hooks/routing-lib.mjs';
import { appendInternalJournal, projectDigestOf, repoRelOf } from './write-audit.mjs';

/** 合法状态机取值（open→triaged→resolved→archived 单向，仅前向迁移；archived＝证据类超龄终态，内部任务-79/内部决策-041——下标比较语义使其恒为最高位，任何态→archived 放行、archived→任何态拒绝）。 */
const STATUSES = ['open', 'triaged', 'resolved', 'archived'];
/** 热度统计窗口：30 天（retro 周期口径）。 */
const HEAT_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * 生效根：环境注入缝优先（测试隔离），否则用调用方显式 root。
 * @param {string} root 项目根（负载 cwd 推导值）
 * @returns {string}
 */
function effectiveRoot(root) {
  return process.env.WF_INCIDENT_ROOT ?? String(root ?? '.');
}

/**
 * 记录文件路径（项目根/内部工作流状态，运行态、gitignore）。
 * @param {string} root
 * @returns {string}
 */
export function incidentFile(root) {
  return join(effectiveRoot(root), '.workflow', 'incidents.jsonl');
}

/** 内部写归因 target（内部任务-349）：等值白名单——只允许账本自身，防任意 tracked 路径洗白为 internal。 */
export const INCIDENT_JOURNAL_TARGET = '.workflow/incidents.jsonl';

/** 归因判定缓存（键含两枚 env：effectiveRoot 内嵌 WF_INCIDENT_ROOT，stateRootFor 受 WF_ROUTING_STATE_DIR 影响）。 */
const journalTargetCache = new Map();

/**
 * 归因 target 收紧（纯判定，内部任务-349）：仓相对化后与账本路径**等值**才放行。
 * @param {string} repoRoot 激活域根
 * @param {string} root 账本根（内部经 effectiveRoot 解析）
 * @returns {string[]} 通过白名单的仓相对 target；空数组＝不归因
 */
export function incidentJournalTargets(repoRoot, root) {
  // 相对 root 先归一到绝对（与写盘侧 writeFileSync 的 cwd 解析同口径）；否则 cwd 在子目录时
  // 会把「子目录账本」误判成「仓根账本」而给无依据的 internal 归因。
  const rel = repoRelOf(repoRoot, incidentFile(resolve(String(root ?? '.'))), repoRoot);
  return rel === INCIDENT_JOURNAL_TARGET ? [rel] : [];
}

/**
 * 账本写入后追加 internal 归因行（内部任务-349，内部决策-066 内部模块-3）：fail-open，永不抛、不影响 appendIncident 返回值。
 * 非激活域（无 .git/.sdd 标记）或 target 不成立时静默跳过——既有 tmp 夹具零污染。
 * @param {string} root
 * @param {object} rec 账本记录（sid/taskId 取记录自身归属，原样透传，不二次归一）
 */
function journalIncidentWrite(root, rec) {
  try {
    const eff = effectiveRoot(root);
    // 键＝生效根（已内嵌 WF_INCIDENT_ROOT 的最高优先值）＋状态根注入缝（影响落点目录）
    const cacheKey = `${eff}\u0000${process.env.WF_ROUTING_STATE_DIR ?? ''}`;
    if (journalTargetCache.has(cacheKey)) {
      if (journalTargetCache.get(cacheKey) === null) return;
    } else {
      const repoRoot = activationRoot(eff);
      const targets = repoRoot ? incidentJournalTargets(repoRoot, root) : [];
      if (!repoRoot || targets.length === 0) {
        journalTargetCache.set(cacheKey, null);
        return;
      }
      journalTargetCache.set(cacheKey, { repoRoot, targets });
    }
    const ctx = journalTargetCache.get(cacheKey);
    const key = projectKey(ctx.repoRoot);
    const sid = typeof rec.session === 'string' && rec.session !== '' ? rec.session : null;
    const taskId = typeof rec.taskId === 'string' && rec.taskId !== '' ? rec.taskId : null;
    appendInternalJournal(stateRootFor(key), projectDigestOf(key), { sid, taskId, targets: ctx.targets });
  } catch {
    // fail-open：Stop 报表会把未归因的账本变更如实报成 unattributed（不在此吞掉可见性）
  }
}

/**
 * digest 计算：parts 以 | 连接取 sha256 前 16 位（脱敏口径——绝不存原文）。
 * @param {string[]} parts
 * @returns {string}
 */
export function digestOf(parts) {
  return digest16(parts.join('|')); // 内部任务-244 Q10：摘要实现单源（hook-lib.digest16）
}

// 内部任务-244 S04/S07：展示净化/kind 白名单的**单源**在 hooks/hook-lib.mjs（hooks 层纯函数，
// 不依赖脚本层——裁剪树场景只复制 hooks 两文件）；本模块仅作消费方语法再导出。
export { KNOWN_INCIDENT_KINDS, sanitizeDisplayText, sanitizeIncidentKind } from '../../hooks/hook-lib.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 内部任务-244 P03（CEO r7 阻塞 1 定稿）：状态迁移单写者锁——openSync('wx') 建锁、内容
// owner/pid/ts、finally 释放；陈旧锁（pid 可判死 / TTL 20s＝2×最长钩超时 10s）经 rename
// 隔离到 quarantine 后单次重试；获取失败 noteHookIssue(script,'status-lock-failed') 可见并
// 返回失败。本批不跨插件 import spec-gate/assurance/lock.mjs（插件边界），在此实现同形态锁。
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_LOCK_NAME = 'incidents.status.lock';
/** 锁 TTL：20s＝2×最长钩超时（10s）——钩内同步段不可能合法持有更久。 */
const STATUS_LOCK_TTL_MS = 20_000;
/** 进程内降级留痕去重（每 script+reason 至多一次；钩每进程一次运行，跨进程由每次运行一次天然满足）。 */
const degradedNoted = new Set();

/**
 * 降级可见性（内部任务-244 P01/P03）：结构化原因落 hook-errors（每 script+reason 每进程至多一次，
 * 不刷屏）；写失败不反噬主流程。
 * @param {string} script 脚本标识 @param {string} reason 原因类别
 */
function noteVisibleDegraded(script, reason) {
  const key = `${script}|${reason}`;
  if (degradedNoted.has(key)) return;
  degradedNoted.add(key);
  try { noteHookIssue(script, reason); } catch { /* fail-open：留痕失败不反噬 */ }
}

/** 状态锁文件路径（与账本同目录）。 */
function statusLockPath(root) {
  return join(dirname(incidentFile(root)), STATUS_LOCK_NAME);
}

/** pid 存活探测（EPERM＝存在但无权限，仍视为存活；探测不可用回落 TTL 判定）。 */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 陈旧锁回收：pid 可判死 → 立即；无 pid/探测不可用 → TTL；空/半写锁给予 2s 写入宽限后按 mtime
 * 判龄；rename 入 quarantine 后返回 true。阶段门维护性评审：原实现对「刚建尚未写内容」的合法锁
 * 直接按 aged 回收，可致两写者同入临界区——宽限窗口消除该竞争（内容写后仍按 TTL/pid 判）。 */
function reclaimStaleStatusLock(file) {
  let body = null;
  try { body = JSON.parse(readFileSync(file, 'utf8')); } catch { body = null; }
  const hasOwner = body && typeof body === 'object' && (Number.isSafeInteger(body.pid) || Number.isFinite(Number(body.ts)));
  let aged;
  if (!hasOwner) {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { return false; }
    aged = Date.now() - mtime > 2000; // 空/半写锁写入宽限 2s
  } else {
    const dead = Number.isSafeInteger(body.pid) && !pidAlive(body.pid);
    const ts = Number(body.ts);
    aged = !dead && (!Number.isFinite(ts) || Date.now() - ts > STATUS_LOCK_TTL_MS);
    if (dead) aged = true;
  }
  if (!aged) return false;
  try {
    const qdir = join(dirname(file), 'quarantine');
    mkdirSync(qdir, { recursive: true });
    renameSync(file, join(qdir, `${STATUS_LOCK_NAME}.${Date.now()}.${process.pid}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 持状态锁执行（单写者串行化「读→前向检查→append」；append-only 不变量不变）。
 * @param {string} root 项目根 @param {string} script 锁持有者标识 @param {() => object} fn 临界区
 * @returns {object} fn 返回值；获取失败返回 {ok:false, reason:'status-lock-failed'}
 */
function withStatusLock(root, script, fn) {
  const file = statusLockPath(root);
  let fd = null;
  let lockToken = null; // 函数作用域（finally 需读取；try 块内 const 在 finally 不可达）
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      fd = openSync(file, 'wx');
    } catch (e) {
      if (e?.code !== 'EEXIST') return { ok: false, reason: `状态锁创建失败（${e?.code ?? e?.name ?? 'unknown'}）` };
      if (!reclaimStaleStatusLock(file)) {
        noteVisibleDegraded(script, 'status-lock-failed');
        return { ok: false, reason: 'status-lock-failed' };
      }
      try {
        fd = openSync(file, 'wx');
      } catch {
        noteVisibleDegraded(script, 'status-lock-failed');
        return { ok: false, reason: 'status-lock-failed' };
      }
    }
    lockToken = JSON.stringify({ owner: script, pid: process.pid, ts: Date.now() });
    writeFileSync(fd, lockToken);
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 释放失败不反噬 */ }
      // 属主校验后释放（阶段门维护性评审：原实现按路径无条件删锁，可删并发者新建的锁）
      try {
        if (lockToken !== null && readFileSync(file, 'utf8') === lockToken) rmSync(file, { force: true });
      } catch { /* 同上 */ }
    }
  }
}

/** 状态链逆向检测（读侧校验 prevStatus 与当前状态可达性）：非法即拒绝并留痕。 */
function statusChainIllegal(r) {
  if (typeof r?.prevStatus !== 'string') return false;
  const pi = STATUSES.indexOf(r.prevStatus);
  const ci = STATUSES.indexOf(r.status ?? 'open');
  return !(pi >= 0 && pi < ci);
}

/**
 * 快照内状态迁移内核（内部任务-244 P03：调用方已持锁、已整读账本一次；不重复读盘）。
 * @param {string} root @param {object[]} all 折叠后记录 @param {string} id @param {string} status
 * @param {string} [note] @param {object|null} [extra]
 * @returns {{ok: boolean, reason?: string, amended?: boolean}}
 */
function setStatusFromSnapshot(root, all, id, status, note, extra = null) {
  const current = all.find((r) => r.id === id);
  if (!current) return { ok: false, reason: 'id 不存在' };
  if (statusChainIllegal(current)) {
    noteVisibleDegraded(process.env.WF_HOOK_SCRIPT ?? 'incident-store', 'status-regression');
    return { ok: false, reason: '状态链非法（prevStatus 与当前状态不可达）' };
  }
  if (STATUSES.indexOf(status) < STATUSES.indexOf(current.status ?? 'open')) {
    return { ok: false, reason: `状态回退被拒（${current.status} → ${status}，仅前向）` };
  }
  const extraPairs = extra && typeof extra === 'object' ? { ...extra } : null;
  if (current.status === status) {
    // 更正通道（内部任务-DEBTFIX-1）：同状态 + 传入**不同**非空 note ⇒ 追加更正快照。
    if (typeof note === 'string' && note && note !== current.note) {
      const amended = appendIncident(root, { ...(extraPairs ?? {}), ...current, note, amended: true });
      return amended.ok ? { ok: true, amended: true } : { ok: false, reason: '写盘失败' };
    }
    return { ok: true }; // 幂等：同状态重复处置无副作用
  }
  // extraPairs 先展开、current 覆盖：记录自带 cause 优先，extra 只补缺失审计字段（机器处置留痕）。
  // 内部任务-244 P03：迁移行补 `prevStatus` 审计字段（读侧据此校链；加法字段，旧记录零迁移）。
  const next = { ...(extraPairs ?? {}), ...current, status, prevStatus: current.status ?? 'open' };
  delete next.amended; // 更正标记不随状态迁移继承（防陈旧标记压制真实振荡计数，内部任务-DEBTFIX-1 收尾评审 #4）
  if (typeof note === 'string' && note) next.note = note;
  const r = appendIncident(root, next);
  return r.ok ? { ok: true } : { ok: false, reason: '写盘失败' };
}

/**
 * 追加一条异常记录：O_APPEND 单行追加，不做写前比对（并发下不可靠）；
 * id/ts 必填（缺失返回 {ok:false}——写入方各自负责稳定 id 生成，缺省生成会
 * 破坏幂等去重语义）；status 恒以 open 起步。
 * @param {string} root
 * @param {object} rec 记录（id/ts 必填）
 * @returns {{ok: boolean, id?: string}} 写失败返回 {ok:false}（fail-open 由调用方姿态决定）
 */
export function appendIncident(root, rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id || !Number.isFinite(rec.ts)) return { ok: false };
  try {
    const file = incidentFile(root);
    mkdirSync(dirname(file), { recursive: true });
    const line = { ...rec, schemaVersion: 1, ts: Number(rec.ts) };
    // status 缺省补 open（捕获记录起步态）；setStatus 的状态变更行自带目标状态，不得打回
    if (typeof line.status !== 'string' || !line.status) line.status = 'open';
    appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {
    return { ok: false };
  }
  // 内部任务-349：账本属工作流内部写——写盘成功后必须追加 internal 归因行（内部决策-066 内部模块-3）。
  // 必须落在上面的 try 之外：归因失败不得把已成功的账本写报成 {ok:false}（调用方重试会产生重复行）。
  journalIncidentWrite(root, rec);
  return { ok: true, id: rec.id };
}

/**
 * 读取全部记录：坏行跳过；同 id 以文件中**末条**为准（读侧幂等：并发重复追加
 * 自然折叠，setStatus 的状态变更也以追加同 id 新行实现——全文件零覆盖写）。
 * readIncidentsWithStats 的 records 投影（内部未决-92，内部任务-50——折叠语义单源）。
 * @param {string} root
 * @returns {Array<object>}
 */
export function readIncidents(root, opts = null) {
  return readIncidentsWithStats(root, opts).records;
}

/**
 * 带坏行计数的整读（内部未决-92，内部任务-50）：records（id 折叠末条胜出，与 readIncidents 同）
 * 与 dropped（非空行中不可解析或无 id 的行数——与 parseIncidentLines 跳过口径同源，
 * 单行判定经 parseIncidentLineOrNull 单点共享）出自**同一次读盘**（内部接口-19 §2：
 * counts/records/dropped 单读同源）。读失败按 store 容错语义返回空态（dropped 0——
 * 不可读面的状态由 ledger.status 三态承载，不与计数混同）。
 * 内部任务-244 P01 注入缝：`opts.reader(file)` 可替换读盘实现（**仅测试用**计数读次数；
 * 生产缺省 fs.readFileSync，零行为）。
 * @param {string} root 项目根
 * @param {{reader?: (file: string) => string}} [opts]
 * @returns {{records: object[], dropped: number}}
 */
export function readIncidentsWithStats(root, opts = null) {
  // 行级骨架（读守卫/循环/空行跳过）与 parseIncidentLines 单源（门①简洁性 S3）：
  // 空行口径是 dropped 契约的承载谓词，双份实现会让 dropped 分母与行级数据源静默漂移。
  const { rows, dropped } = parseIncidentLinesWithStats(incidentFile(root), opts?.reader);
  const byId = new Map();
  for (const d of rows) {
    byId.set(d.id, d); // 末条覆盖：状态变更行在后，天然胜出
  }
  return { records: [...byId.values()], dropped };
}

/**
 * 热路径 open 面读取（内部任务-244 P01）：两遍扫描——先用行级正则折叠 id→末状态，再只对
 * 「末状态=open」的行做完整 JSON.parse。值域与 readIncidents 的 records 同源（id 折叠、
 * 末条胜出、坏行跳过），但**只返回 open 记录**，且 dropped 恒 0（本面不用于坏行计数）。
 * 用途：UPS/摘要只需 open 面时避免 10 万行全量 JSON.parse（读放大治理的解析面）。
 * @param {string} root 项目根 @param {{reader?: (file: string) => string}} [opts] 仅测试注入
 * @returns {{records: object[], dropped: 0}}
 */
export function readOpenIncidents(root, opts = null) {
  const file = incidentFile(root);
  if (!existsSync(file)) return { records: [], dropped: 0 };
  let text;
  try {
    text = (typeof opts?.reader === 'function' ? opts.reader : readFileSync)(file, 'utf8');
  } catch {
    return { records: [], dropped: 0 };
  }
  const lines = text.split('\n');
  const statusById = new Map();
  const lineById = new Map();
  // 单次扫描单正则（id 先行、status 在后的账本行形态）：只记录每个 id 的末行下标与末状态；
  // 第二遍仅对「末状态=open」的末行做完整 JSON.parse（末行即折叠后的完整记录）。
  const lineRe = /"id":"((?:[^"\\]|\\.)+)"[\s\S]*?"status":"(open|triaged|resolved|archived)"/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = lineRe.exec(line);
    if (!m) continue;
    statusById.set(m[1], m[2]);
    lineById.set(m[1], i);
  }
  const byId = new Map();
  let anomaly = false;
  for (const [id, status] of statusById) {
    if (status !== 'open') continue;
    try {
      const d = JSON.parse(lines[lineById.get(id)]);
      // 正则折叠须与整读折叠同义：解析失败/解析后状态不符（值内伪 status）→ 回退整读（阶段门正确性评审阻塞 2）
      if (!d || typeof d.id !== 'string' || d.status !== 'open') {
        anomaly = true;
        break;
      }
      byId.set(d.id, d);
    } catch {
      anomaly = true;
      break;
    }
  }
  if (anomaly) {
    // 坏行容忍契约（readIncidents 取最后一条**可解析**行）：快读面无法安全近似时回退整读一次
    return { records: readIncidents(root).filter((r) => r.status === 'open'), dropped: 0 };
  }
  return { records: [...byId.values()], dropped: 0 };
}

/**
 * 行级解析原始记录行（readIncidents 与 reopensWithin 共用骨架，2026-09-22
 * 内部任务-LEASEGATE-1 抽取）：空行跳过、坏行跳过，按文件顺序返回解析成功的对象——
 * 不做 id 折叠（折叠是 readIncidents 的读侧幂等语义；振荡行级计数必须拿原始行）。
 * @param {string} file 记录文件路径
 * @returns {object[]} 解析成功的记录对象（文件顺序）；文件缺失/读失败返回空数组
 */
function parseIncidentLines(file) {
  return parseIncidentLinesWithStats(file).rows;
}

/**
 * 带坏行计数的行级解析（内部未决-92，内部任务-50）：空行跳过（空行不构成数据缺口，不计
 * dropped）＋坏行计数，骨架单源——parseIncidentLines 取 rows 投影，readIncidentsWithStats
 * 在其上做 id 折叠并透传 dropped（两导出面的读守卫/循环/空行口径恒同源）。
 * @param {string} file 记录文件路径
 * @returns {{rows: object[], dropped: number}} 行序记录（不折叠）与非空坏行数；缺失/读失败空态
 */
function parseIncidentLinesWithStats(file, reader = null) {
  if (!existsSync(file)) return { rows: [], dropped: 0 };
  let text;
  try {
    text = (typeof reader === 'function' ? reader : readFileSync)(file, 'utf8');
  } catch {
    return { rows: [], dropped: 0 };
  }
  const rows = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const d = parseIncidentLineOrNull(line);
    if (d === null) dropped += 1;
    else rows.push(d);
  }
  return { rows, dropped };
}

/**
 * 单行判定（坏行口径单源，内部未决-92，内部任务-50）：可解析且 id 为非空字符串 → 记录对象；
 * 否则 null（空行判定在调用方——空行不构成数据缺口，不计 dropped）。
 * parseIncidentLines 与 readIncidentsWithStats 共用，防两处容错语义漂移。
 * @param {string} line 单行文本
 * @returns {object|null}
 */
function parseIncidentLineOrNull(line) {
  try {
    const d = JSON.parse(line);
    if (d && typeof d.id === 'string' && d.id) return d;
  } catch {
    /* 坏行容忍：格式漂移不构成丢弃整个文件的理由 */
  }
  return null;
}

/**
 * 未分层 open 数与分层待排查数的**单次读盘**读数（提醒面消费点的唯一计数入口：`incident-cli`
 * 空态摘要直接消费，`openCount` 取其实 `open` 项）：两个数字必须同源——分别独立读盘会在并发
 * 追加落窗时让同一行输出自相矛盾（对齐 内部任务-DEBTFIX-1「单次读盘同时给出总数与拆分」先例；
 * 评审正确性 #2）。判定谓词唯一实现为 {@link isPendingIncident}。
 * @param {string} root 项目根
 * @returns {{open: number, pending: number}} open＝未分层 open 数（证据面）；pending＝分层后待排查数（提醒面）
 */
export function countSummary(root) {
  const rows = readIncidents(root);
  return {
    open: rows.filter((r) => r.status === 'open').length,
    pending: rows.filter(isPendingIncidentV2).length,
    // 内部决策-063 修正案 3 决策 24.1：countSummary 内既有 cause 累加循环同批改 countCauses 单源
    // （消除最后一份双实现残留；store 现状九键键集不变）。
    countsByCause: countCauses(rows, { zeroKeys: CAUSES }),
  };
}

/**
 * 未分层的 open 计数（证据面）：status === 'open' 的记录数（= {@link countSummary} 的 open 项）。
 * **消费方状态（2026-09-30 内部任务-OSNOISE-1 修正注释）**：`retro-metrics` 的 `selfCheckHeat`
 * （热度＝证据面趋势，故意不分层）；`incident-cli` 空态摘要改用 `countSummary` 单次读盘；
 * 待排查指针**已不再**消费本原语（改用 incident-summary.buildSummary 的 total 项）。
 * @param {string} root
 * @returns {number}
 */
export function openCount(root) {
  return countSummary(root).open;
}

/**
 * 按 kind 批量解决（2026-09-15 激活域批次：声明成功自愈）——把该项目全部 open 且
 * kind 匹配的记录逐条转 resolved（复用 setStatus 前向状态机与追加语义，零覆盖写）。
 * 按项目全域解决不区分会话：lease-deny 定义上即正常执法留痕，声明成功即全部归零。
 * 单条失败不中断（记录职责不得反噬调用方主职责），返回实际解决数。
 * 全路径不抛（readIncidents/setStatus/appendIncident 均返回错误对象——评审 S5：
 * 不设不可达 try/catch）。
 * @param {string} root
 * @param {string} kind 目标 kind（现消费方为 'lease-deny'）
 * @param {string} note 解决备注（留痕给未来读者）
 * @returns {{resolved: number}}
 */
export function resolveOpenByKind(root, kind, note, extra = null) {
  let resolved = 0;
  let failed = 0;
  for (const r of readIncidents(root)) {
    if (r.status !== 'open' || r.kind !== kind) continue;
    if (setStatus(root, r.id, 'resolved', note, extra).ok) resolved += 1;
    else failed += 1;
  }
  return { resolved, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部任务-244 P01：重试自愈索引（**纯缓存**，wf-retry-open-<sessDigest>.json，状态目录）
// 语义（计划定稿）：miss → 全量回扫（既有行为）；hit → 必须回读热账本复核 id 仍存在且
// status=open 才 setStatus；条目上限 200；TTL 与 active 租约同源（ttlMs）；写失败不得静默
// （调用方 noteHookIssue('index-degraded')，fail-open 回落全扫语义不变）。
// ─────────────────────────────────────────────────────────────────────────────
/** 索引条目上限（防无限增长；超出按最近写入截断）。 */
const RETRY_INDEX_MAX = 200;

/**
 * 索引文件路径（per-session；会话不可判归 'null' 桶——与租约弱形态同侧，不跨会话共享）。
 * @param {string} stateDir 运行态状态目录 @param {string|null} sessionId 会话标识
 * @returns {string}
 */
export function retryOpenIndexFile(stateDir, sessionId) {
  const s = normalizeSession(sessionId) ?? 'null';
  return join(String(stateDir), `wf-retry-open-${digestOf([s]).slice(0, 16)}.json`);
}

/**
 * 读索引（纯缓存）：命中返回未过期 ids；缺失/坏文件/过期一律 miss（调用方回扫）。
 * @param {string} stateDir @param {string|null} sessionId @param {number} [now]
 * @returns {{hit: boolean, ids: string[]}}
 */
export function readRetryOpenIndex(stateDir, sessionId, now = Date.now()) {
  try {
    const body = JSON.parse(readFileSync(retryOpenIndexFile(stateDir, sessionId), 'utf8'));
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
    const expiresAt = Number(body?.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { hit: false, ids: [] };
    return { hit: true, ids: ids.slice(0, RETRY_INDEX_MAX) };
  } catch {
    return { hit: false, ids: [] };
  }
}

/**
 * 写索引（tmp+rename 原子；ids 空即删文件）。TTL 取 ttlMs()（与 active 租约同源）。
 * @param {string} stateDir @param {string|null} sessionId @param {string[]} ids
 * @returns {{ok: boolean}}
 */
export function writeRetryOpenIndex(stateDir, sessionId, ids) {
  let tmp = null;
  try {
    const file = retryOpenIndexFile(stateDir, sessionId);
    const uniq = [...new Set(ids.filter((x) => typeof x === 'string' && x))].slice(-RETRY_INDEX_MAX);
    if (uniq.length === 0) {
      rmSync(file, { force: true });
      return { ok: true };
    }
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ids: uniq, ts: Date.now(), expiresAt: Date.now() + ttlMs() }));
    renameSync(tmp, file);
    return { ok: true };
  } catch {
    try { if (tmp) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错 */ } // 阶段门：失败无 tmp 残留
    return { ok: false };
  }
}

/** 追加一条候选 id（失败路径调用；失败返回 {ok:false} 由调用方留痕）。 */
export function rememberRetryOpenIndex(stateDir, sessionId, id) {
  const cur = readRetryOpenIndex(stateDir, sessionId);
  return writeRetryOpenIndex(stateDir, sessionId, [...cur.ids, id]);
}

/** 删除本会话索引（Stop 无 open / release 清理）。 */
export function clearRetryOpenIndex(stateDir, sessionId) {
  try {
    rmSync(retryOpenIndexFile(stateDir, sessionId), { force: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 清理过期索引文件（新会话 SessionStart 义务）：过期/坏文件删除，正常留存。
 * @param {string} stateDir @param {number} [now]
 * @returns {{removed: number, failed: number}}
 */
export function cleanupExpiredRetryIndexes(stateDir, now = Date.now()) {
  let removed = 0;
  let failed = 0;
  try {
    for (const name of readdirSync(stateDir)) {
      if (!/^wf-retry-open-[0-9a-f]{16}\.json$/.test(name)) continue;
      const file = join(stateDir, name);
      let expired = false;
      try {
        const b = JSON.parse(readFileSync(file, 'utf8'));
        expired = !(Number(b?.expiresAt) > now);
      } catch {
        expired = true; // 坏文件按过期清（纯缓存，无审计价值）
      }
      if (!expired) continue;
      try {
        rmSync(file, { force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    /* 目录缺失/读失败：无索引可清 */
  }
  return { removed, failed };
}

/**
 * 索引命中的自愈执行（post-tool 成功路径）：hit 必须**回读热账本复核**——按索引 ids 取
 * 仍需自愈的记录（open/kind/tool/inputDigest/会话三态/窗口全匹配）批量 setStatusMany；
 * 复核后仍 open 的本会话 tool-failure 保留在索引（陈旧项自然淘汰），本次已处置项移除。
 * @param {string} root 项目根
 * @param {{stateDir: string, session: string|null, host?: string|null, tool: string, inputDigest: string, windowMs: number, now?: number, audit?: object|null, script?: string}} q
 * @returns {{hit: boolean, resolved: number, failed: number}}
 */
export function healRetryOpenByIndex(root, q) {
  const now = Number.isFinite(q?.now) ? q.now : Date.now();
  const stateDir = String(q?.stateDir ?? '');
  const script = q?.script ?? 'incident-store';
  const sid = normalizeSession(q?.session);
  if (!stateDir || sid === null) return { hit: false, resolved: 0, failed: 0 };
  const idx = readRetryOpenIndex(stateDir, q.session, now);
  if (!idx.hit) return { hit: false, resolved: 0, failed: 0 };
  const ids = new Set(idx.ids);
  const updates = [];
  const keep = [];
  let reads = 0;
  const reader = typeof q?.reader === 'function' ? (file) => { reads += 1; return q.reader(file); } : null;
  for (const r of readIncidents(root, reader ? { reader } : null)) { // hit 必须回读热账本复核（D06：快照不复用于写面）
    if (!ids.has(r.id)) continue;
    if (r.status === 'open' && r.kind === 'tool-failure' && sessionMatches(r, sid, q.host ?? null)) keep.push(r.id);
    if (
      r.status === 'open' && r.kind === 'tool-failure' && r.tool === q.tool && r.inputDigest === q.inputDigest &&
      sessionMatches(r, sid, q.host ?? null) && now - Number(r.ts) <= q.windowMs
    ) {
      updates.push({ id: r.id, status: 'resolved', note: '同参数随即成功自愈（OPEN-110）', extra: q?.audit ?? undefined });
    }
  }
  let resolved = 0;
  let failed = 0;
  if (updates.length > 0) {
    const res = setStatusMany(root, updates, { script, ...(typeof q?.reader === 'function' ? { reader: q.reader } : {}) });
    resolved = res.applied ?? 0;
    failed = res.failed ?? 0;
  }
  const healed = new Set(updates.map((u) => u.id));
  // 写面失败时不剪枝（阶段门正确性评审 #4）：保留候选供下次成功再试，防一次写失败即永失自愈机会
  const pruned = failed === 0
    ? writeRetryOpenIndex(stateDir, q.session, keep.filter((id) => !healed.has(id)))
    : { ok: true };
  if (!pruned.ok) noteVisibleDegraded(script, 'index-degraded');
  return { hit: true, resolved, failed, reads };
}

/**
 * 同参数随即成功自愈（内部未决-110，内部任务-52）：成功调用对**窗内同 (session, host, tool,
 * inputDigest) 的 open 态 tool-failure** 逐条转 resolved——「预期失败后同参数重试成功」
 * 的常态噪音在记录面自收口，真实信号（持续失败）留在 open。
 * 三条安全边界（自愈升级通道纪律，内部任务-LEASEGATE-1 教训）：①只动 status=open（triaged
 * 是人的判断，机器不改判）；②retry-loop 升级通道**不入本面**（kind 过滤恒 tool-failure；
 * 死循环信号不可吞——且既有重试环对同调用无论成败均计数，振荡仍会触发）；③会话判等走
 * sessionMatches 三态（归一 session＋host 仅显式异宿才拒），查询会话不可判（null/'default'
 * 归一）恒零收口。无 inputDigest 的历史记录不匹配（加法式字段，旧记录零校验）。
 * 全路径不抛（readIncidents/setStatus 均返回错误对象）——记录钩姿态。
 * @param {string} root 项目根
 * @param {{session: string, host?: string|null, tool: string, inputDigest: string, windowMs: number, now?: number}} q
 * @returns {{resolved: number, failed: number}} failed＝命中但写盘失败数（内部模块-15 v2：处置失败须可上报，不得静默）
 */
export function resolveOpenToolFailuresByRetry(root, q) {
  const now = Number.isFinite(q?.now) ? q.now : Date.now();
  const evidenceAudit = q?.audit && typeof q.audit === 'object' ? q.audit : null;
  const sid = normalizeSession(q?.session);
  if (sid === null) return { resolved: 0, failed: 0 }; // 会话不可判不代结（default 桶保护）
  const host = typeof q?.host === 'string' && q.host ? q.host : null;
  let resolved = 0;
  let failed = 0;
  for (const r of readIncidents(root)) {
    if (r.status !== 'open' || r.kind !== 'tool-failure') continue;
    if (r.tool !== q.tool || r.inputDigest !== q.inputDigest) continue;
    if (!sessionMatches(r, sid, host)) continue;
    if (now - Number(r.ts) > q.windowMs) continue;
    if (setStatus(root, r.id, 'resolved', '同参数随即成功自愈（OPEN-110）', evidenceAudit).ok) resolved += 1;
    else failed += 1;
  }
  return { resolved, failed };
}

/**
 * 老化归档目标谓词（单源，内部决策-041/内部任务-79）：open＋命中待排查排除面（证据类）＋超龄——
 * 库原语 archiveAgedIncidents 与 incident-cli 的 dry-run/批量谓词三处共用，防手抄漂移
 * （阶段门①评审处置：谓词三处内联＝声称同源实为复制）。
 * 内部模块-15 v2（内部决策-063 D21.2）：排除面由规则表 `evidenceCauses` 驱动（经 isPendingIncidentV2
 * 内部取 cachedRules），公开签名保持 `(r, now, maxAgeMs)`——调用点零改动、无第二参默认值。
 * @param {object} r 记录
 * @param {number} now 判定时刻
 * @param {number} maxAgeMs 超龄阈值（毫秒）
 * @returns {boolean}
 */
export function isAgedExcludedEvidence(r, now, maxAgeMs) {
  if (r.status !== 'open' || !(now - Number(r.ts) > maxAgeMs)) return false;
  // D21.2 + 内部任务-244 Q06 收口：有 cause → 证据面单源谓词 `isEvidenceFace`（规则表 evidenceCauses）；
  // 无 cause 旧记录 → 旧两层口径（!isPendingIncidentV2）。
  if (typeof r.cause !== 'string' || r.cause === '') return !isPendingIncidentV2(r);
  return isEvidenceFace(r);
}

/** 老化归档单次迁移上限（内部决策-041 决策 2，防一次会话清千条的风暴面；CLI dry-run 同源消费）。 */
export const ARCHIVE_BATCH_LIMIT = 500;

/**
 * 证据面判定（**单源**，内部模块-15/内部决策-063 D21.2；retro-metrics 处置率分母消费）：有 cause →
 * 规则表 `evidenceCauses`（不可加载回退内置闭集）；无 cause 旧记录 → 旧两层排除面。
 * **不要求 status=open**（处置率分母须覆盖已 resolved/archived 历史行）。
 * @param {object} r 记录
 * @returns {boolean}
 */
export function isEvidenceFace(r) {
  const cause = typeof r?.cause === 'string' && r.cause ? r.cause : '';
  if (cause !== '') {
    let evidence = EVIDENCE_CAUSES;
    try {
      const rules = cachedRules();
      if (Array.isArray(rules?.evidenceCauses)) evidence = rules.evidenceCauses;
    } catch { /* 规则表坏：回退内置常量（fail-open） */ }
    return evidence.includes(cause);
  }
  if (PENDING_EXCLUDED_KINDS.includes(r?.kind)) return true;
  return r?.kind === PENDING_ERROR_CLASS_SCOPE_KIND && PENDING_EXCLUDED_ERROR_CLASSES.includes(r?.errorClass);
}

/** 一天毫秒数（老化阈值换算单源，终评处置——库与 CLI 共用防「预览 X 执行 Y」漂移）。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 天→毫秒换算（单源；非法或缺省回退 30 天）。 */
export function maxAgeMsOf(days) {
  return (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;
}

/**
 * 证据类记录终态老化（内部决策-041/内部任务-79）：「open 且命中待排查排除面且 ts 超龄」的记录批量
 * 前向迁移至 archived——终态不回退、记录永不删。幂等（archived 记录不再命中谓词）。
 * 内部模块-15 v2（评审修复 N2）：迁移行审计字段补 `cause` 兜底（无 cause 旧记录按旧两层口径取
 * 显式 cause；记录自带 cause 时由 setStatus 的「记录优先」语义保留原值）。
 * 全路径不抛（readIncidents/setStatus 均返回错误对象——评审 S5 先例：不设不可达 try/catch）。
 * @param {string} root 项目根
 * @param {{maxAgeDays?: number, limit?: number, now?: number, audit?: object}} [opts] maxAgeDays 缺省 30，limit 缺省 ARCHIVE_BATCH_LIMIT
 * @returns {{archived: number}} 本批迁移条数
 */
export function archiveAgedIncidents(root, opts = {}) {
  const maxAgeMs = maxAgeMsOf(opts.maxAgeDays);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : ARCHIVE_BATCH_LIMIT;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const baseAudit = opts.audit && typeof opts.audit === 'object' ? opts.audit : {};
  // 内部任务-244 P01：候选整读一次 + setStatusMany 批量迁移（原实现每记录一次 readIncidents）。
  const updates = [];
  const sourceRows = readIncidents(root, opts.reader ? { reader: opts.reader } : null);
  for (const r of sourceRows) {
    if (updates.length >= limit) break;
    if (!isAgedExcludedEvidence(r, now, maxAgeMs)) continue;
    const prev = typeof r.note === 'string' && r.note !== '' ? r.note : '（无）';
    updates.push({
      id: r.id,
      status: 'archived',
      note: `证据类超龄自动终态化（ADR-041；原 note：${prev}）`,
      extra: { ...baseAudit, cause: typeof baseAudit.cause === 'string' && baseAudit.cause ? baseAudit.cause : legacyCauseOf(r) },
    });
  }
  if (updates.length === 0) return { archived: 0, failed: 0 };
  const res = setStatusMany(root, updates, { script: process.env.WF_HOOK_SCRIPT ?? 'incident-store', ...(opts.reader ? { reader: opts.reader } : {}) });
  // 锁失败（applied=0 且有 reason）→ 整批失败可见（不静默半迁移）
  if (!res.ok && (res.applied ?? 0) === 0 && res.reason) return { archived: 0, failed: updates.length };
  return { archived: res.applied ?? 0, failed: res.failed ?? 0 };
}

/**
 * 无 cause 旧记录的**处置审计兜底 cause**（内部模块-15 v2 评审修复 N2）：按既有两层口径给定，
 * 不猜产品缺陷——lease 族留痕＝mechanism-trace、exit-nonzero 探针＝probe-noise、
 * 其余＝unclassified（待排查但不冒充某类）。只在记录自身缺 cause 时被消费
 * （setStatus 的 `{...extra, ...current}` 展开序保证记录自带 cause 优先）。
 * @param {object} r 记录
 * @returns {string} cause 闭集值
 */
export function legacyCauseOf(r) {
  if (PENDING_EXCLUDED_KINDS.includes(r?.kind)) return 'mechanism-trace';
  if (r?.kind === PENDING_ERROR_CLASS_SCOPE_KIND && PENDING_EXCLUDED_ERROR_CLASSES.includes(r?.errorClass)) return 'probe-noise';
  return 'unclassified';
}

/**
 * 兜底旁路保留上限（与适配层 `observation-emit.LOST_FACTS_MAX_LINES` 契约同值：
 * 内部接口-26 §3.1 / 内部决策-063 决策 14）。跨插件边界不 import 适配层实现，两侧各持常量、
 * 由对拍测试（hooks-bridge.test）断言一致——回放回写后的超限轮转以此为准。
 */
export const LOST_FACTS_MAX_LINES = 200;

/**
 * 兜底旁路工件路径（**单源**，内部决策-063 修正案 3 决策 22.6，内部任务-195）：基于 `incidentFile(root)`
 * 同目录推导、尊重 `WF_INCIDENT_ROOT`——回放 CLI（`emit --from-lost`）与计数（countLostFacts）
 * 必须同源。适配层 `observation-emit` 保留自身同源实现（跨插件边界不 import workflow 库），
 * 两侧路径规则由对拍测试断言一致（hooks-bridge.test）。
 * @param {string} root 项目根
 * @returns {string}
 */
export function lostFactsPath(root) {
  return join(dirname(incidentFile(root)), 'incidents-lost.jsonl');
}

/**
 * 兜底旁路工件行数单源（内部模块-15 v2 评审修复 N4）：`内部工作流状态` 非空行数
 * （emit 失败计数；缺失/读失败按 0）。SessionStart 就绪面 / retro `lostFacts` / `digest`
 * 三处必须同源——各自内联计数会让「坏行/半行」口径漂移（半行无换行也计一行、空行不计）。
 * @param {string} root 项目根
 * @returns {number}
 */
export function countLostFacts(root) {
  let text;
  try {
    text = readFileSync(lostFactsPath(root), 'utf8');
  } catch {
    return 0;
  }
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').length;
}

/**
 * 待排查口径的排除面（单一事实源，2026-09-30 内部任务-OSNOISE-1）。分层**不删除任何记录**——
 * `incident-cli list` 仍可见全量证据；两层的共同语义是"不是待办"：
 *  · kind 层 `lease-deny`：闸 deny 即产生，属机制正常执法留痕（内部决策-022）。
 *  · errorClass 层 `exit-nonzero`：命令执行完成、按自身语义返回非零＝工具**正常执行**，
 *    属探针噪声/证据；工具失灵走 `error-field`/`error-flag`（内部规则-1① 判据不变）。
 *    **该层只作用于 `kind === 'tool-failure'`**（当前唯一生产者 `post-tool.mjs` 也只给它写
 *    errorClass）——不得让别的 kind 因携带 errorClass 被静默，尤其 内部规则-3 要求
 *    lease-loop（租约振荡升级信号）无视会话匹配强制显示。
 * 新增 `errorClass` 时必须显式判定其是否进本名单（内部规则-2 登记义务，内部决策-033）。
 */
export const PENDING_EXCLUDED_KINDS = Object.freeze(['lease-deny', 'lease-revive']);
export const PENDING_EXCLUDED_ERROR_CLASSES = Object.freeze(['exit-nonzero']);
/** errorClass 轴的作用域 kind：该轴只作用于它（收尾复审 #4——提醒面文案与谓词同源，防"拍平成一张平铺名单"丢掉限定）。 */
export const PENDING_ERROR_CLASS_SCOPE_KIND = 'tool-failure';

/**
 * 一条记录是否属于「待排查」：open 且不在两层排除面内（errorClass 层限 tool-failure，
 * 见上块说明——防未来写入方把升级信号 kind 静默掉）。
 * @param {object} r 记录（readIncidents 折叠后的对象）
 * @returns {boolean}
 */
export function isPendingIncident(r) {
  if (r === null || typeof r !== 'object') return false;
  if (r.status !== 'open') return false;
  if (PENDING_EXCLUDED_KINDS.includes(r.kind)) return false;
  if (r.kind === PENDING_ERROR_CLASS_SCOPE_KIND && PENDING_EXCLUDED_ERROR_CLASSES.includes(r.errorClass)) return false;
  return true;
}

/**
 * 会话标识**形态归一**（内部任务-20 B/F9，内部决策-033 修正案 1）：剥宿主前缀（`session-`/`sess_`/`mvs_`）、
 * 去首尾空白；非字符串/空串/`'default'` ⇒ `null`（归属不可判，与既有口径一致）。
 * **幂等**：`n(n(x)) === n(x)`（防"剥前缀再归一"二次漂移——收尾评审要求）。
 * @param {unknown} raw 原始会话标识
 * @returns {string|null} 归一值
 */
export function normalizeSession(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '' || s === 'default') return null;
  for (const p of ['session-', 'sess_', 'mvs_']) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  return s === '' ? null : s;
}

/**
 * 归属判等（**三态规则**，内部任务-20 B/F9，内部决策-033 修正案 1）：① 查询与记录**都有** host ⇒
 * 同 host 且归一 session 相等（异宿同形字符串不误判——收尾评审阻塞 2）；② 查询有 host、记录无
 * ⇒ **不匹配**（不可证同宿，保守）；③ **查询无 host** ⇒ 回落既有口径（仅比归一 session）——
 * 否则既有调用方（不传 host）与旧记录的本会话计数会被整体清零。
 * @param {object} rec 记录
 * @param {string|null} sid 归一后的查询会话
 * @param {string|null} host 查询侧 host（已归一，null=未提供）
 * @returns {boolean}
 */
export function sessionMatches(rec, sid, host) {
  if (sid === null) return false;
  const rs = normalizeSession(rec?.session);
  if (rs === null || rs !== sid) return false;
  const rh = typeof rec?.host === 'string' && rec.host ? rec.host : null;
  const qh = typeof host === 'string' && host ? host : null;
  // **仅"显式异宿"才拒绝**（2026-10-09 内部任务-20 B 批实现期收紧后回退）：早期版本写"任一侧缺 host
  // 即不匹配"，实测会误伤——B 批之前的历史记录都没有 host，凡带 host 的查询（task-recap 的 Stop
  // 汇总）一律失配，导致本会话记录静默漏报（selftest 5 项 + A1 用例当场转红）。宿主是**消歧**字段
  // 而非隔离维度（内部决策-040 决策 3）：只有在两侧都声明且**不同**时才据此拒绝。
  if (rh !== null && qh !== null && rh !== qh) return false;
  return true;
}

/**
 * 滑动窗内同签名 resolved 行级计数（内部任务-LEASEGATE-1，内部规则-13 ④ lease-loop 升级判定
 * 数据源）：按 kind+digest+session 匹配、status==='resolved'、ts 落窗内逐行计数——
 * readIncidents 按 id Map 折叠（末条胜出）会把同 id 的 open→resolved 振荡折成一行，
 * 振荡信号必须行级读。文件缺失/读失败返回 0（无历史≠异常，不升级不报错）；坏行跳过。
 * @param {string} root 项目根
 * @param {{kind: string, digest: string, session: string, windowMs: number, now?: number}} q 查询
 * @returns {number} 窗内匹配的 resolved 行数
 */
export function reopensWithin(root, { kind, digest, session, windowMs, now = Date.now() }) {
  let count = 0;
  for (const d of parseIncidentLines(incidentFile(root))) {
    if (
      // 内部任务-20 B/F9：本原语**归一但 host 无关**——其唯一生产消费方（routing-gate 的振荡升级判定）
      // 不提供宿主维，若按四态规则要求同 host 会让振荡计数归零（静默回归，收尾评审阻塞 5 的正是此点）；
      // 故此处只做形态归一（`session-<uuid>` ↔ `<uuid>` 视为同会话），宿主消歧归 sessionMatches 面。
      d.kind === kind && d.digest === digest && normalizeSession(d.session) === normalizeSession(session) &&
      d.status === 'resolved' && d.amended !== true && now - Number(d.ts) <= windowMs
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * 自察热度：30 天窗口内按 digest 聚合（含已解决记录——历史复发也是热度），
 * 计数降序、同数按最近时间降序。retro 指标数据源。
 * @param {string} root
 * @returns {Array<{digest: string, kind: string|null, count: number, lastTs: number}>}
 */
export function heat(root) {
  const now = Date.now();
  const by = new Map();
  for (const r of readIncidents(root)) {
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || now - ts > HEAT_WINDOW_MS) continue;
    const key = typeof r.digest === 'string' && r.digest ? r.digest : '?';
    const e = by.get(key) ?? { digest: key, kind: typeof r.kind === 'string' ? r.kind : null, count: 0, lastTs: 0 };
    e.count += 1;
    e.lastTs = Math.max(e.lastTs, ts);
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

/**
 * 排查状态变更：open→triaged→resolved 仅前向（允许跳级 resolve，拒绝任何回退——
 * 误报处置是一步完成的常见路径，回退则破坏 openCount 语义）；note 可选留痕。
 * 实现为**追加同 id 新行**而非重写全文件：与并发追加零冲突（全文件零覆盖写，
 * 评审 R-1 处置——读改写+rename 会静默覆盖 triage 期间新追加的记录）。
 * 同状态 + 传入不同非空 note ⇒ 追加更正快照（amended 标记；不计入 reopensWithin，内部任务-DEBTFIX-1）。
 * @param {string} root
 * @param {string} id 记录 id
 * @param {string} status 目标状态
 * @param {string} [note] 排查备注
 * @returns {{ok: boolean, reason?: string}}
 */
export function setStatus(root, id, status, note, extra = null) {
  if (!STATUSES.includes(status)) return { ok: false, reason: '非法状态' };
  const script = process.env.WF_HOOK_SCRIPT ?? 'incident-store';
  return withStatusLock(root, script, () => setStatusFromSnapshot(root, readIncidents(root), id, status, note, extra));
}

/**
 * 批量状态迁移（内部任务-244 P01/P03，session-start 老化归档消费）：持锁一次、整读账本**一次**，
 * 逐项前向检查后追加迁移行（append-only 不变量不变）；锁内不做「读全量→覆写」。
 * 单写者锁失败 → 整批失败（不静默半迁移），降级原因由 withStatusLock 留痕。
 * @param {string} root 项目根
 * @param {Array<{id: string, status: string, note?: string, extra?: object|null}>} updates 迁移意图
 * @param {{script?: string}} [opts] 锁持有者标识（钩名）
 * @returns {{ok: boolean, applied: number, failed: number, reason?: string, results?: object[]}}
 */
export function setStatusMany(root, updates, opts = {}) {
  const list = Array.isArray(updates) ? updates : [];
  if (list.length === 0) return { ok: true, applied: 0, failed: 0, results: [] };
  for (const u of list) {
    if (!u || typeof u.id !== 'string' || !STATUSES.includes(u.status)) {
      return { ok: false, applied: 0, failed: 0, reason: '非法状态' };
    }
  }
  const script = opts.script ?? process.env.WF_HOOK_SCRIPT ?? 'incident-store';
  return withStatusLock(root, script, () => {
    const all = readIncidents(root, opts.reader ? { reader: opts.reader } : null); // 单次整读（N 项迁移只读一次）
    let applied = 0;
    let failed = 0;
    const results = [];
    for (const u of list) {
      const res = setStatusFromSnapshot(root, all, u.id, u.status, u.note, u.extra ?? null);
      results.push(res);
      if (res.ok) applied += 1;
      else failed += 1;
    }
    return { ok: failed === 0, applied, failed, results };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：cause 派生待排查口径、分级计数与统一处置入口。
// 兼容纪律：旧记录（无 cause）仍走既有 isPendingIncident 两层口径；读侧零迁移、零改写。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v2 待排查 cause 面（与 incident-rules 常量同源，禁止内联复制）。
 * 语义版在 {@link isPendingIncidentV2}：生产读取改用规则表 `pendingCauses`，本常量是
 * **规则表不可加载时的内置回退**（内部验收-30：镜像/规则表数据键必须有生产读取方）。
 */
export const PENDING_CAUSES_V2 = PENDING_CAUSES;
/** v2 证据面 cause 面（不进待排查，由超龄归档终态化）。 */

/**
 * 规则表视图读取（单源、带守卫）：`loadRules()` 自身带模块级缓存（路径+mtime+size）与
 * 坏表回退，本函数只做**形态守卫**——`rules?.pendingCauses` 不存在/非数组时由调用方回退
 * 内置常量（内部决策-063 D21.2：不得因规则表坏形态把记录静默排除）。
 * @returns {object|null} 规则表视图（异常返回 null）
 */
function cachedRules() {
  try {
    return loadRules();
  } catch {
    return null;
  }
}

/**
 * 一条记录是否属于 v2「待排查」（内部决策-063 D4/D21.2）：
 *  - status 必须 open；
 *  - 有 cause：`cause ∈ rules.pendingCauses`（规则表驱动；证据面/非法 cause 不计）；
 *  - 无 cause（历史记录）：回退既有两层口径 isPendingIncident。
 *
 * **单参公开签名（评审修复）**：规则在函数内部经 {@link cachedRules} 取——既有
 * `rows.filter(isPendingIncidentV2)` 调用会把数组 index 当第二参传入；若第二参带默认值，
 * 默认值不生效、规则表变成数字 ⇒ 直接抛错击穿 `list --json`/`countSummary`。
 * @param {object} r 记录
 * @returns {boolean}
 */
export function isPendingIncidentV2(r) {
  if (r === null || typeof r !== 'object') return false;
  if (r.status !== 'open') return false;
  const cause = typeof r.cause === 'string' && r.cause ? r.cause : '';
  if (cause === '') return isPendingIncident(r);
  const rules = cachedRules();
  const pending = rules && Array.isArray(rules.pendingCauses) && rules.pendingCauses.length > 0
    ? rules.pendingCauses
    : PENDING_CAUSES_V2;
  return pending.includes(cause);
}

/**
 * cause 计数**单源**（内部决策-063 修正案 3 决策 24.1，内部任务-195）：对 rows 的 `cause ?? 'unclassified'`
 * 累加；`zeroKeys` 仅把调用点要求的零键预置为 0（**键集按调用点保留**——CLI 无零键、
 * store/summary 现状九键、retro 先窗口过滤后无零键）。非数组输入按空集（防御，不抛）。
 * @param {object[]|null|undefined} rows 记录数组
 * @param {{zeroKeys?: string[]}} [opts]
 * @returns {Record<string, number>}
 */
export function countCauses(rows, { zeroKeys = [] } = {}) {
  const out = {};
  if (Array.isArray(zeroKeys)) for (const key of zeroKeys) out[key] = 0;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const cause = typeof r?.cause === 'string' && r.cause ? r.cause : 'unclassified';
    out[cause] = (out[cause] ?? 0) + 1;
  }
  return out;
}

/**
 * 按 cause 聚合（读盘一次；缺 cause 记 unclassified；store 现状九键键集不变）。
 * @param {string} root
 * @returns {Record<string, number>}
 */
export function countsByCause(root) {
  return countCauses(readIncidents(root), { zeroKeys: CAUSES });
}

/**
 * 统一处置入口（内部决策-063 D4）：按 sources 作用域调用既有原语，机器只动 open、
 * triaged 不被改判、archived 不回退；迁移行带 `cause/ruleId/rulesVersion/autoDisposition` 审计字段
 *（记录自带 cause 时保留原值）。热路径必须只传 `retry-heal`，不得顺带归档/解 lease 族。
 * @param {string} root 项目根
 * @param {{sources: string[], now?: number, maxAgeDays?: number,
 *          lease?: {kind: string, note?: string},
 *          retry?: {session: string, host?: string|null, tool: string, inputDigest: string, windowMs: number, cause?: string}}} opts
 * @returns {{leaseHealed: number, retryHealed: number, archived: number, failed: number}}
 */
export function applyDispositions(root, opts = {}) {
  const sources = Array.isArray(opts.sources) ? opts.sources : [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : undefined;
  const out = { leaseHealed: 0, retryHealed: 0, archived: 0, failed: 0 };
  for (const source of sources) {
    if (source === 'lease-heal') {
      const lease = opts.lease && typeof opts.lease === 'object' ? opts.lease : null;
      if (!lease || typeof lease.kind !== 'string' || lease.kind === '') {
        out.failed += 1;
        continue;
      }
      const audit = { ruleId: 'machine-lease-heal', rulesVersion: 0, autoDisposition: 'lease-heal', cause: 'mechanism-trace' };
      const res = resolveOpenByKind(root, lease.kind, typeof lease.note === 'string' ? lease.note : '声明自愈', audit);
      out.leaseHealed += res.resolved;
      out.failed += Number(res.failed) || 0;
      continue;
    }
    if (source === 'retry-heal') {
      const retry = opts.retry && typeof opts.retry === 'object' ? opts.retry : null;
      // 评审修复 N1：`windowMs` 必须显式且为正——旧实现缺省时 `now - ts > undefined` 恒 false，
      // 等于把「任意陈年 open 失败」都当成窗内同参数成功而自愈（超窗误收口）。
      if (
        !retry ||
        typeof retry.tool !== 'string' ||
        typeof retry.inputDigest !== 'string' ||
        !Number.isFinite(retry.windowMs) ||
        retry.windowMs <= 0
      ) {
        out.failed += 1;
        continue;
      }
      const audit = {
        ruleId: 'machine-retry-heal',
        rulesVersion: 0,
        autoDisposition: 'retry-heal',
        // 评审修复 N2：无 cause 旧记录迁移行也带显式 cause（记录自带 cause 时优先，见 setStatus 展开序）
        cause: typeof retry.cause === 'string' && retry.cause ? retry.cause : 'unclassified',
      };
      const res = resolveOpenToolFailuresByRetry(root, { ...retry, now, audit });
      out.retryHealed += res.resolved;
      out.failed += Number(res.failed) || 0;
      continue;
    }
    if (source === 'aged-archive') {
      // 评审修复 N2：cause 兜底在 archiveAgedIncidents 内按记录取（lease 族/探针各归其类）
      const audit = { ruleId: 'machine-aged-archive', rulesVersion: 0, autoDisposition: 'aged-archive' };
      const res = archiveAgedIncidents(root, { now, maxAgeDays, audit });
      out.archived += res.archived;
      out.failed += res.failed;
      continue;
    }
    out.failed += 1; // 未知 source：计入失败（调用方应据此 noteHookIssue，fail-open 不抛）
  }
  return out;
}
