// 文件：incident-summary.mjs
// 描述：内部模块-15 v2 自察摘要库（内部规则-3 / 内部规则-10 / 内部决策-063 D6）——两级提醒（Stop 收尾与
//       UserPromptSubmit 待排查指针）共用的**只读**派生面：单次读盘给出待排查总数、证据面
//       （已分层排除）数、归属三分（本任务/本会话/其他会话）、cause 拆分、本 turn 增量、
//       promote 草案计数与待排查记录视图（pendingRecords，恒 length===total）。
//       为什么单点：两消费面各自读盘会在并发追加落窗时出现「总数 ≠ 拆分和、两处文案互斥」
//       （内部任务-DEBTFIX-1 先例）；本库把口径收成一束，文案构造也在此（formatPointerLine）。
//       纯读纪律：本库零副作用（不写账本、不落 incident、不建目录），任何 IO 失败按空态/零计数
//       收敛（fail-open——提醒缺席不得反噬会话）。
//       口径（内部决策-063 D4）：待排查＝`isPendingIncidentV2`（新行按 cause、无 cause 旧行两层回退）；
//       证据面＝open 且非待排查（即分层排除数——`probe-noise`/`replayable-rejection`/
//       `mechanism-trace` 与旧行 lease 族/exit-nonzero）；`lease-loop` 恒计入由 v2 谓词承接。
//       注入缝：`{reader}` 允许消费方注入读盘函数（单测计次断言「只读一次」）。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 用法：被 user-prompt.mjs / task-recap.mjs 消费；`node` 直跑无副作用（纯库）。
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CAUSES } from './incident-rules.mjs';
import { DAY_MS, countCauses, incidentFile, isPendingIncidentV2, normalizeSession, readIncidentsWithStats, readOpenIncidents, sessionMatches } from './incident-store.mjs';

/** promote 草案「待转正」窗口：30 天（与自察热度窗口同口径；过龄只计数不提醒）。 */
export const PROMOTION_MAX_AGE_DAYS = 30;
/** cause 全闭集由 incident-rules 的 CAUSES 单源提供（计数零键取它，不再本地拼接）。 */

/**
 * 草案时间戳解析：文件名约定 `<ts>-<id>.md`（ts 为 epoch 毫秒）。
 * 文件名不合约定时回退文件 mtime（草案一经产出即定型，mtime 足以判过龄）。
 * @param {string} dir 草案目录
 * @param {string} name 文件名
 * @returns {number} 毫秒时间戳（NaN=不可判，跳过）
 */
function promotionTsOf(dir, name) {
  const m = /^(\d{10,16})-/.exec(name);
  if (m) return Number(m[1]);
  try {
    return statSync(join(dir, name)).mtimeMs;
  } catch {
    return NaN;
  }
}

/**
 * promote 草案计数（内部规则-3「存在待转正草案时增一行轻提醒」）：未过龄计 `promotions`，
 * 过龄单列 `expiredPromotions`（不提醒；清理动作归后续批次，本批只做过龄不提醒）。
 * 目录缺席/不可读/坏文件名一律按空态（fail-open，不抛）。
 * 路径口径与账本同源：草案目录＝账本所在 `.workflow/` 下的 `promotions/`（`incidentFile` 已承载
 * `WF_INCIDENT_ROOT` 注入缝的根覆盖——两处各推导一次根会让测试隔离/诊断态下指到不同目录）。
 * @param {string} root 项目根
 * @param {{now?: number}} [opts] 内部任务-244 Q08：删除无调用方的 `maxAgeDays` 可选参数（窗口恒 PROMOTION_MAX_AGE_DAYS）
 * @returns {{promotions: number, expiredPromotions: number}}
 */
export function countPromotions(root, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeDays = PROMOTION_MAX_AGE_DAYS;
  const readdir = typeof opts.readdir === 'function' ? opts.readdir : readdirSync; // 内部任务-348/内部未决-214④ 读放大注入缝
  const dir = join(dirname(incidentFile(root)), 'promotions');
  let names = [];
  try {
    names = readdir(dir);
  } catch {
    return { promotions: 0, expiredPromotions: 0 };
  }
  let promotions = 0;
  let expiredPromotions = 0;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const ts = promotionTsOf(dir, name);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > maxAgeDays * DAY_MS) expiredPromotions += 1;
    else promotions += 1;
  }
  return { promotions, expiredPromotions };
}

/**
 * 摘要构造（纯读）：单次读盘派生提醒面所需全部数字与记录视图。
 * 返回键：`total`（待排查）、`pendingRecords`（待排查记录视图：恒 `length === total`，证据面/非 open
 * 不在其中——消费方据此派生归属投影，禁止二次读盘与二次谓词）、`evidence`（open 中分层排除的证据面）、`byTask/bySession/byOthers`
 * （待排查归属三分，恒和＝total）、`byCause`（**全量记录**按 cause 计数；缺 cause 归
 * `unclassified`，与 store 的 countsByCause 同义）、`turnDelta`（给了 `sinceTs` 时为本 turn
 * 新增待排查数，否则 null）、`newRecords`（对应记录数组；lease-loop 无视会话匹配强制计入——
 * 内部规则-3 不变量）、`promotions/expiredPromotions`、`dropped`（坏行数，单次读盘透出）、
 * `records`（折叠后的全量记录视图——消费方据此派生自身投影，禁止二次读盘）。
 * cause 累加（内部决策-063 修正案 3 决策 24.1）：`countCauses(rows,{zeroKeys:CAUSES})` 单源——
 * **保留现状 9 个 cause 零键**（与 incident-summary.test 的 deepEqual(countsByCause) 口径一致）。
 * @param {string} root 项目根
 * @param {{sessionId?: string|null, host?: string|null, taskId?: string|null, sinceTs?: number,
 *          now?: number, reader?: (root: string) => {records: object[], dropped?: number}}} [opts]
 * @returns {{total: number, pendingRecords: object[], evidence: number, byTask: number, bySession: number, byOthers: number,
 *            byCause: Record<string, number>, turnDelta: number|null, newRecords: object[],
 *            promotions: number, expiredPromotions: number, dropped: number, records: object[]}}
 */
export function buildSummary(root, opts = {}) {
  const openOnly = opts.openOnly === true; // 内部任务-244 P01：UPS 提醒面只需 open 面（byCause/records 降级为 open 口径）
  const reader = typeof opts.reader === 'function' ? opts.reader : readIncidentsWithStats;
  const raw = openOnly
    ? readOpenIncidents(root, typeof opts.reader === 'function' ? { reader: opts.reader } : null)
    : reader(root);
  // 内部任务-244 Q07：reader 契约恒返回 {records, dropped} 对象（readIncidentsWithStats / readOpenIncidents
  // 同形），原 `Array.isArray(raw)` 兜底为零消费不可达分支——删除。
  const rows = Array.isArray(raw?.records) ? raw.records : [];
  const dropped = Number(raw?.dropped) || 0;
  const sid = normalizeSession(opts.sessionId);
  const host = typeof opts.host === 'string' && opts.host ? opts.host : null;
  const taskId = typeof opts.taskId === 'string' && opts.taskId ? opts.taskId : null;
  const sinceTs = Number.isFinite(opts.sinceTs) ? Number(opts.sinceTs) : null;
  const byCause = openOnly ? {} : countCauses(rows, { zeroKeys: CAUSES });
  let total = 0;
  let evidence = 0;
  let byTask = 0;
  let bySession = 0;
  let byOthers = 0;
  const newRecords = [];
  const pendingRecords = [];
  for (const r of rows) {
    if (r?.status !== 'open') continue;
    if (!isPendingIncidentV2(r)) {
      evidence += 1; // 分层排除面（证据类）——不删除记录，只在提醒计数外
      continue;
    }
    total += 1;
    pendingRecords.push(r);
    // 归属投影顺序：本任务（taskId 命中）> 本会话 > 其他会话；恒和＝total（单次读盘同源）
    if (taskId !== null && r.taskId === taskId) byTask += 1;
    else if (sessionMatches(r, sid, host)) bySession += 1;
    else byOthers += 1;
    // 本 turn 增量：只收待排查；lease-loop 升级信号无视会话匹配强制计入（内部规则-3）
    if (sinceTs !== null && Number(r.ts) > sinceTs && (r.kind === 'lease-loop' || sessionMatches(r, sid, host))) {
      newRecords.push(r);
    }
  }
  const prom = countPromotions(root, { now: opts.now, readdir: opts.promotionsReaddir });
  return {
    total,
    pendingRecords,
    evidence,
    byTask,
    bySession,
    byOthers,
    byCause,
    turnDelta: sinceTs === null ? null : newRecords.length,
    newRecords,
    promotions: prom.promotions,
    expiredPromotions: prom.expiredPromotions,
    dropped,
    records: rows,
    ...(openOnly ? { scope: 'open' } : {}),
  };
}

/**
 * promote 草案待转正轻提醒文案（评审修复 N9 单源）：Stop 收尾与 UPS 指针两处消费，逐字共用——
 * 此前两钩各自内联同一句（改文案必漏一处，正是 内部规则-3「文案口径统一」要防的漂移）。
 * 过龄草案已由 {@link countPromotions} 排除在计数外；转正永远人在环（B-M15-2）。
 * @param {{promotions?: number}} summary 摘要
 * @returns {string} 注入行；无未过龄草案时空串
 */
export function formatPromotionLine(summary) {
  const n = Number(summary?.promotions) || 0;
  if (n <= 0) return '';
  return `【workflow 自察】有 ${n} 份 promote 草案待转正（.workflow/promotions/）——人工复核后按 learning/OPEN/架构反馈之一转正（禁止自动改写权威面）。`;
}

/**
 * 待排查指针文案（内部规则-3 统一口径，纯函数；两级提醒共用同一构造，防文案漂移）：
 * `「N 条待排查（本任务 X / 本会话 Y / 其他会话 Z；证据面 M 条已分层排除）」`。
 * 待排查归零返回空串（归零即消失——消费方据此不注入）。
 * @param {{total?: number, evidence?: number, byTask?: number, bySession?: number, byOthers?: number}} summary
 * @returns {string}
 */
export function formatPointerLine(summary) {
  const total = Number(summary?.total) || 0;
  if (total <= 0) return '';
  const n = (v) => Number(v) || 0;
  return `${total} 条待排查（本任务 ${n(summary?.byTask)} / 本会话 ${n(summary?.bySession)} / 其他会话 ${n(summary?.byOthers)}；证据面 ${n(summary?.evidence)} 条已分层排除）`;
}
