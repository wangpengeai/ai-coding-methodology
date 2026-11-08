// 文件：incident-cli.mjs
// 描述：运行自察（内部模块-15/内部决策-019）排查 CLI——list（含 --status 过滤与 --heat 热度榜）、
//       triage/resolve（状态机流转 + note 留痕，含 内部任务-79 批量谓词形态）、archive
//       （证据类超龄终态化，内部决策-041）、lease（任务租约排查面板：当前键/
//       会话桶指针/挑战/激活态与剩余 TTL，D4）。人是排查主体：CLI 只做读取与
//       状态标注，不自动修任何东西（B-M15-2 人在环）。
//       姿态（2026-09-15 内部未决-14 批次修订）：triage/resolve 是人用命令——id 解析
//       失败、内容失败（回退被拒/写盘失败）、未知子命令一律 stderr 报错 + 退 1
//       （失败可见；实测全仓无 hook/流水线程序化调用方，静默 fail-open 理由不成
//       立，且静默曾致「list 截断 id 无法回填」的 triage 无声失败）；list/lease
//       维持读侧姿态（参数异常静默退 0，fail-open，调用方可为流水线）；
//       archive/批量谓词属写侧同分野（内部任务-79/内部决策-041：非法或缺值参数、账本不可读
//       显式退 1——不可逆迁移不与「零目标」混同为静默退 0）；
//       --selftest 失败可见退 1（B-M8-4 同款）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 用法：node incident-cli.mjs [--project-root <dir>] list [--status open|triaged|resolved|archived] [--heat] [--json]
//       node incident-cli.mjs [--project-root <dir>] triage <id或唯一前缀≥4字符> --note "<一句话>" [--json]
//       node incident-cli.mjs [--project-root <dir>] resolve <id或唯一前缀> [--note "<一句话>"] [--json]
//         （内部任务-DEBTFIX-1：同状态 + 不同 --note ⇒ 追加更正行，状态不变；triage 同法）
//       node incident-cli.mjs [--project-root <dir>] archive [--dry-run] [--max-age-days N]
//         （内部任务-79/内部决策-041：证据类超龄终态化——排除面命中且超龄的 open 记录批量转 archived；
//          缺省 30 天、单次上限 500 条；--dry-run 只预览零写盘；非法 --max-age-days 显式退 1）
//       node incident-cli.mjs [--project-root <dir>] (triage|resolve) --matching-excluded --older-than Nd --note "<…>"
//         （内部任务-79/内部决策-041：批量谓词形态——命中集＝排除面＋超龄，须与显式 --note 同用）
//       node incident-cli.mjs [--project-root <dir>] emit   （stdin 单个 JSON 观测事实；内部接口-26）
//       node incident-cli.mjs [--project-root <dir>] emit --from-lost [--limit N] [--dry-run]
//         （2026-10-24 内部任务-195/内部决策-063 修正案 3 决策 22：兜底旁路 内部工作流状态
//          人工回放——原子认领、逐行校验、幂等 id lost-<sha256 前32位>、审计字段
//          replayedFrom/replayedAt；--limit 缺省 50；--limit/--dry-run 仅对本形态有效）
//       node incident-cli.mjs lease
//       node incident-cli.mjs --selftest
//       node incident-cli.mjs -h|--help
//         （内部任务-20 A1/F8：-h/--help 退 0；list 增 --json 机器可读投影，见下。
//          内部任务-50/内部未决-92：list --json 的 ledger 增 dropped 坏行计数；内部未决-99：triage/resolve
//          增 --json 成功面单行投影——失败面维持 stderr+退 1，见 USAGE 详细说明。
//          内部任务-79/内部决策-041：status 枚举扩第四态 archived（证据类超龄终态，不回退、记录不删）。）
import { accessSync, appendFileSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ARCHIVE_BATCH_LIMIT,
  DAY_MS,
  LOST_FACTS_MAX_LINES,
  PENDING_ERROR_CLASS_SCOPE_KIND,
  PENDING_EXCLUDED_ERROR_CLASSES,
  PENDING_EXCLUDED_KINDS,
  appendIncident,
  archiveAgedIncidents,
  countCauses,
  countLostFacts,
  countSummary,
  heat,
  incidentFile,
  isAgedExcludedEvidence,
  isPendingIncidentV2,
  lostFactsPath,
  maxAgeMsOf,
  openCount,
  readIncidents,
  readIncidentsWithStats,
  sanitizeDisplayText,
  sanitizeIncidentKind,
  setStatus,
} from './lib/incident-store.mjs';
import { classifyFact, loadRules } from './lib/incident-rules.mjs';
import { isValidIncidentId, validateEmitPayload } from './lib/incident-fact.mjs';
import { projectKey, runtimeStateDir } from '../hooks/routing-lib.mjs';

/** 用法文本（-h/--help 输出；与文件头注释同源维护）。 */
const USAGE = [
  '用法：node incident-cli.mjs [--project-root <dir>] list [--status open|triaged|resolved|archived] [--heat] [--json]',
  '      node incident-cli.mjs [--project-root <dir>] triage <id或唯一前缀≥4字符> --note "<一句话>" [--json]',
  '      node incident-cli.mjs [--project-root <dir>] resolve <id或唯一前缀> [--note "<一句话>"] [--json]',
  '      node incident-cli.mjs [--project-root <dir>] archive [--dry-run] [--max-age-days N]',
  '      node incident-cli.mjs [--project-root <dir>] (triage|resolve) --matching-excluded --older-than Nd --note "<…>"',
  '      node incident-cli.mjs [--project-root <dir>] emit   （stdin 单个 JSON 观测事实；IF-COLLAB-26）',
  '      node incident-cli.mjs [--project-root <dir>] emit --from-lost [--limit N] [--dry-run]',
  '      node incident-cli.mjs [--project-root <dir>] promote <id> --to learning|open|finding [--note "<…>"]',
  '      node incident-cli.mjs [--project-root <dir>] digest [--days N] [--json]',
  '      node incident-cli.mjs lease',
  '      node incident-cli.mjs --selftest',
  '      node incident-cli.mjs -h|--help',
  '',
  '  --json  list 的机器可读投影（DEV-20 A1/F8，IF-COLLAB-19 §2）：stdout 为单个 JSON 对象，',
  '          含 schemaVersion/projectRoot/ledger/filter/counts/countsByCause/rulesVersion/records',
  '          （--heat 时以 heat 取代 records）。',
  '          契约强度＝加法兼容（消费方忽略未知键；删键/改键义须同批改接口与用例）；',
  '          ledger.status ∈ ok|missing|unreadable（消费方须以可读为前提读 records）；',
  '          ledger.dropped ＝ 非空坏行数（OPEN-92，DEV-50——与 records 同次读盘，空行不计）；',
  '          counts.pending 与 countsByCause/rulesVersion（v2 加法键）亦与 records 同次读盘。',
  '          triage/resolve 的 --json（OPEN-99，DEV-50）：成功面单行 JSON',
  '          {schemaVersion,command,id,status,amended}；失败面维持 stderr+退 1（退出码分流）。',
  '  emit    适配层上报核心不可观测事实（IF-COLLAB-26）：stdin 单个 JSON（白名单外键整单拒绝），',
  '          成功 stdout {ok:true,id} 退 0；载荷非法/写失败 stderr + 退 1。',
  '  emit --from-lost  兜底旁路人工回放（ADR-063 修正案 3 决策 22）：原子认领',
  '          .workflow/incidents-lost.jsonl → 逐行校验六键 → kind 固定 observation-degraded →',
  '          classifyFact 分类 → 幂等 id lost-<sha256(原始行) 前 32 位>，落账带 replayedFrom/replayedAt；',
  '          invalid 行与超限尾行保留、terminal 同 id 移除；--limit 缺省 50（正整数）；',
  '          --dry-run 零写只报计划；--limit/--dry-run 仅对本形态有效（普通 emit 携带即退 1）。',
  '  promote 只生成 .workflow/promotions/<ts>-<id>.md 草案并追加记录 promotedTo（人在环转正；',
  '          禁止自动改写 learnings/OPEN/architecture-feedback 等权威面——B-M15-2）。',
  '  digest  近 N 天摘要（人读/--json 两态；含 cause/kind 拆分与 lost-facts 兜底计数）。',
  '          人读输出不构成机器契约；--json 输出的键集即是契约面。',
].join('\n') + '\n';

/**
 * 取选项值（--key value 形态）。
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|undefined}
 */
function opt(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

/** 日期短格式（无 ts 记录显示 ?）。 */
function dayOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '?';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * list 输出：每记录一行（id 前 12 位/kind/digest 前 8 位/status/日期/归属（会话短标识/taskId，更正行后缀 (更正)）/note）。
 * @param {string} root
 * @param {{status?: string, showHeat?: boolean}} o
 * @returns {string}
 */
function renderList(root, o = {}) {
  if (o.showHeat) {
    const rows = heat(root);
    if (rows.length === 0) return '（30 天窗口内无自察异常记录）\n';
    return rows.map((r) => `${sanitizeDisplayText(String(r.digest ?? ''), 8)}  ${r.kind == null ? '?' : sanitizeIncidentKind(r.kind)}  count=${r.count}  last=${dayOf(r.lastTs)}`).join('\n') + '\n';
  }
  let rows = readIncidents(root);
  if (o.status) rows = rows.filter((r) => r.status === o.status);
  if (rows.length === 0) {
    // 两个数字并列印出，且**同一次读盘**取得（countSummary：并发追加落窗时不允许两数自相矛盾，
    // 评审正确性 #2）：未分层的 open 记录数（证据面——分层只在读侧计数口径，记录一条不删，
    // 本 CLI 的逐行 list 仍可见全部历史）与分层后的待排查数（提醒面）。
    // 措辞按评审实例三 #5 更正：不用「全量」；排除面按**轴**分别标注（收尾复审 #4：
    // errorClass 轴只作用于 tool-failure，拍平成一张平铺名单会丢掉该限定，而该限定正是
    // 内部规则-3「lease-loop 强制显示」所依赖的），两轴名单与作用域 kind 均由库内常量派生
    // （评审实例一 #2：消费方不得内联第二事实源）。
    const excluded =
      `${PENDING_EXCLUDED_KINDS.join('、')}（kind 轴）；仅 ${PENDING_ERROR_CLASS_SCOPE_KIND} 的 ` +
      `${PENDING_EXCLUDED_ERROR_CLASSES.join('、')}（errorClass 轴）`;
    const { open, pending } = countSummary(root);
    return `（无${o.status ? ` status=${o.status} 的` : ''}自察异常记录；open 计数 ${open}，其中待排查 ${pending}〔分层排除：${excluded}〕）\n`;
  }
  // 内部任务-DEBTFIX-1：归属列（session- 前缀剥除后前 8 位 / taskId），供读者在结案前辨识记录归属。
  // 内部任务-244 S07：账本字段按**数据**渲染——控制字符一律剥除（防终端/模型工具输出注入）。
  const who = (r) => {
    const s = sanitizeDisplayText(String(r.session ?? '-'), 64).replace(/^session-/, '');
    return `${s.slice(0, 8)}/${sanitizeDisplayText(r.taskId ?? '-', 40)}`;
  };
  return rows.map((r) => `${sanitizeDisplayText(String(r.id), 12)}  ${r.kind == null ? '?' : sanitizeIncidentKind(r.kind)}  ${sanitizeDisplayText(String(r.digest ?? '?'), 8)}  ${sanitizeDisplayText(r.status, 20)}  ${dayOf(r.ts)}  ${who(r)}${r.amended === true ? ' (更正)' : ''}${r.note ? `  # ${sanitizeDisplayText(r.note, 200)}` : ''}`).join('\n') + '\n';
}

/**
 * list 的机器可读投影（内部任务-20 A1/F8）：读原语与 renderList 完全同源，本函数只做形状投影。
 * **单次读盘**（plan-review CEO PD1-c / 内部任务-DEBTFIX-1 先例）：`records`、`counts` 与
 * `ledger.dropped` 必须出自**同一次** `readIncidentsWithStats`——两次独立读盘会在并发追加
 * 落窗时给出自相矛盾的两个数字；counts 由同一数组经已导出谓词投影（open=`status==='open'`；
 * pending=`isPendingIncidentV2`，无 cause 旧记录回退两层口径），不调 countSummary。
 * `ledger` 为**三态**：`missing`（文件不存在）/`unreadable`（存在但读失败）/`ok`——判据独立于
 * `records`，防消费方把"读不到"读成"零异常"；`dropped`（内部未决-92，内部任务-50）＝非空坏行数
 * （不可解析或无 id，与 store 跳过口径同源；空行不计）。
 * 契约强度＝**加法兼容**（消费方忽略未知键；删键/改键义才须同批改本接口与用例）；输出为
 * **全量导出**（无 `--limit`，消费方自行截断）；`records` 元素自带的**行级** `schemaVersion`
 * 是记录格式版本，与信封 `schemaVersion`（本投影契约版本）不同义。
 * @param {string} root
 * @param {{status?: string, showHeat?: boolean}} o
 * @returns {string} 单对象 JSON + 换行
 */
/** 账本三态可读性探针（单源，终评处置）：missing＝文件不存在；unreadable＝存在但非常规文件或不可读（`isFile`+`R_OK` 两项判定，**不整文件读**——大账本零额外成本；目录形态 EISDIR 归 unreadable）。 */
function probeLedgerStatus(file) {
  if (!existsSync(file)) return 'missing';
  try {
    if (!statSync(file).isFile()) throw new Error('not a regular file');
    accessSync(file, constants.R_OK);
    return 'ok';
  } catch {
    return 'unreadable';
  }
}

/** 超龄目标集求取（单源投影，终评处置——archive dry-run 与批量谓词共用；谓词本体在 incident-store 单源导出）。 */
function agedExcludedTargets(root, now, maxAgeMs) {
  return readIncidents(root).filter((r) => isAgedExcludedEvidence(r, now, maxAgeMs));
}

function renderListJson(root, o = {}) {
  const file = incidentFile(root);
  // 可读性探针（单源——终评处置：`ledger.status` 三态判据由 probeLedgerStatus 承载，
  // 信封投影与 archive/批量谓词写侧分野共用，防契约判据双实现漂移）
  const status = probeLedgerStatus(file);
  // records/counts/dropped 的唯一读盘（heat 分支单独读盘，但两形态互斥、不并列出现）
  const stats = readIncidentsWithStats(root);
  const rows = stats.records;
  const wantStatus = typeof o.status === 'string' && o.status !== '' ? o.status : null;
  // 内部模块-15 v2（内部决策-063 D4/D10）：cause 派生计数与规则表版本——**同一 rows** 派生（单次读盘同源，
  // 禁止再调 countSummary 二次读盘：并发追加落窗时 counts 与 records 会自相矛盾）。
  // 内部模块-15 v2（内部决策-063 修正案 3 决策 24.1）：cause 累加改 countCauses 单源——
  // **无零键**（CLI 现值键集＝实计 cause 键；传 CAUSES 会引入九键，与既有投影逐字不等）。
  const countsByCause = countCauses(rows);
  const out = {
    schemaVersion: 1,
    projectRoot: resolve(String(root)),
    // 两路径字段口径（plan-review B6）：projectRoot=请求根（canonical 绝对形态）；
    // ledger.path=**实际读盘路径**的 canonical 形态（含 WF_INCIDENT_ROOT 注入缝覆盖的情形）
    // ——消费方不该拿它去拼第二路径。
    ledger: { path: resolve(file), status, dropped: stats.dropped },
    filter: { status: wantStatus, heat: Boolean(o.showHeat) },
    // pending 口径切 v2 单源（内部接口-19 §2.1：无 cause 旧记录回退两层口径）
    counts: { open: rows.filter((r) => r.status === 'open').length, pending: rows.filter(isPendingIncidentV2).length },
    countsByCause,
    rulesVersion: loadRules().rulesVersion,
  };
  if (o.showHeat) {
    out.heat = heat(root);
  } else {
    out.records = wantStatus === null ? rows : rows.filter((r) => r.status === wantStatus);
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * `emit` 子命令（内部接口-26）：stdin 单个 JSON 观测事实 → 白名单校验 → 规则分类 → 追加账本。
 * 语义：提供方是账本唯一写者（消费方不得直接写 incidents.jsonl）；载荷非法/写失败一律 stderr
 * + 退 1（不得伪装成功）；幂等由调用方 id 承担（缺省按 kind+event+分钟桶派生）。
 * `--from-lost` 分支（内部决策-063 修正案 3 决策 22）：不读 stdin，走 {@link replayLostFacts}
 * 原子认领回放；`--limit/--dry-run` 仅对本分支有效（普通 emit 携带即退 1）。
 * @param {string} root 项目根
 * @param {string[]} args 子命令参数
 * @returns {void}
 */
function cmdEmit(root, args) {
  const fromLost = args.includes('--from-lost');
  if (!fromLost) {
    // 内部决策-063 修正案 3 决策 22.5（内部任务-195）旗标作用域：`--limit/--dry-run` **仅**对 `--from-lost`
    // 有效；普通 emit 携带即显式拒绝——静默忽略后真写账会让操作者以为"只预演"。
    const stray = ['--limit', '--dry-run'].filter((flag) => args.includes(flag));
    if (stray.length > 0) {
      process.stderr.write(`emit 失败：${stray.join('/')} 仅对 --from-lost 有效（普通 emit 不接受该旗标）\n`);
      process.exit(1);
    }
  } else {
    const parsed = parseEmitReplayArgs(args);
    if (!parsed.ok) {
      process.stderr.write(`emit 失败：${parsed.reason}\n`);
      process.exit(1);
    }
    const res = replayLostFacts(root, parsed);
    for (const warning of res.warnings ?? []) process.stderr.write(`emit --from-lost 告警：${warning}\n`);
    if (!res.ok) {
      process.stderr.write(`emit --from-lost 失败：${res.error}\n`);
      process.exit(1);
    }
    if (res.dryRun) {
      process.stdout.write(
        `emit --from-lost（dry-run）：wouldReplay=${res.wouldReplay} invalid=${res.invalid} terminalSkipped=${res.terminalSkipped} remaining=${res.remaining}\n`,
      );
    } else {
      process.stdout.write(
        `emit --from-lost：replayed=${res.replayed} invalid=${res.invalid} terminalSkipped=${res.terminalSkipped} remaining=${res.remaining}\n`,
      );
    }
    return;
  }
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    process.stderr.write('emit 失败：无法读取 stdin 载荷\n');
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('emit 失败：载荷非 JSON（期望 stdin 单个 JSON 对象）\n');
    process.exit(1);
  }
  const v = validateEmitPayload(payload);
  if (!v.ok) {
    process.stderr.write(`emit 失败：${v.reason}\n`);
    process.exit(1);
  }
  // 评审修复 B1（终态不回退，B-M15-5）：同 id 已有**非 open** 记录（triaged/resolved/archived）
  // 时拒绝重报——emit 恒以 open 起步，放行会把人工处置过的记录打回 open，等于篡改排查结论。
  // 同 id 且仍 open：按读侧同 id 末条折叠幂等（追加行，不覆盖历史）。
  const existing = readIncidents(root).find((r) => r.id === v.fact.id);
  if (existing && existing.status !== 'open') {
    process.stderr.write(`emit 失败：同 id 记录已是终态/已处置（status=${existing.status}）——终态不回退，请用新 id 上报\n`);
    process.exit(1);
  }
  const cls = classifyFact(v.fact, loadRules());
  const rec = {
    ...v.fact,
    schemaVersion: 1,
    status: 'open',
    cause: cls.cause,
    severity: cls.severity,
    ruleId: cls.ruleId,
    rulesVersion: cls.rulesVersion,
  };
  const w = appendIncident(root, rec);
  if (!w.ok) {
    process.stderr.write('emit 失败：账本写入失败（检查 .workflow 目录权限）\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, id: rec.id })}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// emit --from-lost 人工回放（内部决策-063 修正案 3 决策 22，内部任务-195 / 内部未决-188）：
// 原子认领协议——①合并遗留 `.replaying-*` 全部行；②rename 认领主文件（原子移除所有权，
// 文件不存在/失败⇒0 行成功退 0 且不创建空文件）；③处理认领文件；④保留行 append 回写
// （认领窗口内适配层新 append 落在原路径新文件上，不被覆盖）；⑤超限内联原子轮转；
// ⑥成功 unlink 认领文件。写失败一律不截断（认领文件保留供人工，已成功行靠同 id 幂等）。
// ─────────────────────────────────────────────────────────────────────────────

/** 旁路 digest 校验口径（内部决策-063 修正案 3 决策 22.2：hex 形态，不走 TOKEN_RE——字母开头约束不适用）。 */
const LOST_DIGEST_RE = /^[0-9a-f]{8,64}$/;

/**
 * 解析 `emit --from-lost` 参数（纯函数，selftest 直测）：`--limit N`（默认 50，正整数）与
 * `--dry-run`；显式 `--json` 或位置参数 payload 一律拒绝（回放不读 stdin）。
 * @param {string[]} args 子命令参数
 * @returns {{ok: true, limit: number, dryRun: boolean} | {ok: false, reason: string}}
 */
export function parseEmitReplayArgs(args = []) {
  if (!Array.isArray(args) || !args.includes('--from-lost')) return { ok: false, reason: '缺少 --from-lost（内部调用错误）' };
  if (args.includes('--json')) {
    return { ok: false, reason: '--from-lost 不接受 --json（回放输出为人读摘要；机器面请用 list --json）' };
  }
  const positional = args.filter((a, i) => !String(a).startsWith('--') && args[i - 1] !== '--limit');
  if (positional.length > 0) {
    return { ok: false, reason: `--from-lost 不接受位置参数 payload（收到：${positional[0]}）；回放只读 .workflow/incidents-lost.jsonl` };
  }
  const limitFlag = args.includes('--limit');
  const raw = opt(args, '--limit');
  if (limitFlag && raw === undefined) return { ok: false, reason: '--limit 须带正整数（收到：缺值）' };
  const limit = raw === undefined ? 50 : Number(raw);
  if (raw !== undefined && (!/^[1-9]\d*$/.test(String(raw).trim()) || !Number.isSafeInteger(limit) || limit <= 0)) {
    return { ok: false, reason: `--limit 须为正整数（收到：${raw}）` };
  }
  return { ok: true, limit, dryRun: args.includes('--dry-run') };
}

/**
 * 单行旁路校验（内部决策-063 修正案 3 决策 22.2）：JSON 可解析、schemaVersion=1、
 * kind=observation-degraded、observationSource 非空短串、count 整数≥0、digest hex、ts 有限数。
 * digest **不进** emit 白名单 payload（后续单独落账）。
 * @param {string} rawLine 原始行
 * @returns {{payload: object, digest: string} | null} null=invalid（跳过且保留）
 */
function parseLostLine(rawLine) {
  let line;
  try {
    line = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  if (line.schemaVersion !== 1) return null;
  if (line.kind !== 'observation-degraded') return null;
  if (typeof line.observationSource !== 'string' || line.observationSource === '' || line.observationSource.length > 120) return null;
  if (!Number.isSafeInteger(line.count) || line.count < 0) return null;
  if (!Number.isFinite(line.ts)) return null;
  if (typeof line.digest !== 'string' || !LOST_DIGEST_RE.test(line.digest)) return null;
  return {
    payload: { schemaVersion: 1, kind: 'observation-degraded', observationSource: line.observationSource, ts: line.ts, count: line.count },
    digest: line.digest,
  };
}

/**
 * 回写后超限轮转（内联 helper，内部决策-063 修正案 3 决策 22.3④）：读非空行→保留末 N 行→写同目录
 * tmp→`renameSync` 原子替换（丢最旧）。跨层不 import 适配层实现（对拍测试守两侧路径/上限同值）。
 * @param {string} file 旁路文件
 * @param {number} maxLines 保留上限
 * @returns {{ok: boolean, rotated?: boolean, dropped?: number, error?: string}}
 */
function rotateLostFile(file, maxLines) {
  if (!existsSync(file)) return { ok: true, rotated: false, dropped: 0 };
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch (error) {
    return { ok: false, error: `轮转读失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
  if (lines.length <= maxLines) return { ok: true, rotated: false, dropped: 0 };
  const kept = lines.slice(lines.length - maxLines);
  const tmp = `${file}.tmp-replay-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp 清理失败不反噬 */
    }
    return { ok: false, error: `轮转写失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
  return { ok: true, rotated: true, dropped: lines.length - maxLines };
}

/**
 * 回放候选行（只读）：主文件行序在前、遗留认领文件按文件名序在后——与真实回放
 * （先合并遗留到主文件尾再认领）的处理序一致。
 * @param {string} lostPath 旁路路径
 * @returns {string[]} 非空原始行
 */
function collectLostLines(lostPath) {
  const out = [];
  const readInto = (file) => {
    try {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') out.push(line);
    } catch {
      /* 不可读/缺失：按空态 */
    }
  };
  readInto(lostPath);
  try {
    const dir = dirname(lostPath);
    const prefix = `${basename(lostPath)}.replaying-`;
    for (const name of readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()) readInto(join(dir, name));
  } catch {
    /* 目录不可读：无遗留面 */
  }
  return out;
}

/**
 * `emit --from-lost` 回放核心（导出供 selftest 直测与并发契约注入）。
 * @param {string} root 项目根
 * @param {{limit?: number, dryRun?: boolean, afterClaim?: (paths: {lostPath: string, claimPath: string}) => void}} [opts]
 *        `afterClaim` 仅测试缝（认领后、处理前的注入点，供并发契约用例模拟适配层 append）
 * @returns {{ok: boolean, exitCode: number, replayed: number, invalid: number, terminalSkipped: number,
 *            remaining: number, wouldReplay?: number, dryRun: boolean, warnings: string[], error?: string}}
 */
/**
 * 回放决策树（内部任务-244 Q02 单源）：dry-run 与真实回放共用同一逐行决策，防「预演 X 执行 Y」漂移。
 * 决策动作：`replay`（可回放）/`invalid`（坏行或非法负载，保留原行）/`terminal-skipped`
 * （同 id 已终态，视为已处理移除）/`remaining`（超出 limit，保留待下轮）。
 * @param {string[]} rawLines 原始行（可含空行）
 * @param {Map<string, object>} existing id→折叠记录
 * @param {number} limit 单次处理上限（replay+terminalSkipped 计槽）
 * @returns {Array<{rawLine: string, action: string, id?: string, parsed?: object, fact?: object}>}
 */
export function planLostReplay(rawLines, existing, limit) {
  const decisions = [];
  let slots = 0;
  for (const rawLine of rawLines) {
    if (rawLine.trim() === '') continue;
    const parsed = parseLostLine(rawLine);
    if (parsed === null) {
      decisions.push({ rawLine, action: 'invalid' });
      continue;
    }
    if (slots >= limit) {
      decisions.push({ rawLine, action: 'remaining' });
      continue;
    }
    const id = `lost-${createHash('sha256').update(rawLine).digest('hex').slice(0, 32)}`;
    const prior = existing.get(id);
    if (prior && prior.status !== 'open') {
      slots += 1;
      decisions.push({ rawLine, action: 'terminal-skipped', id });
      continue;
    }
    const validated = validateEmitPayload(parsed.payload);
    if (!validated.ok) {
      decisions.push({ rawLine, action: 'invalid' });
      continue;
    }
    slots += 1;
    decisions.push({ rawLine, action: 'replay', id, parsed, fact: validated.fact });
  }
  return decisions;
}

export function replayLostFacts(root, opts = {}) {
  const limit = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const dryRun = opts.dryRun === true;
  const lostPath = lostFactsPath(root);
  const warnings = [];
  const existingOf = () => new Map(readIncidents(root).map((r) => [r.id, r]));
  const classify = () => classifyFact({ kind: 'observation-degraded' }, loadRules());

  // ── dry-run：零写只报计划（含遗留认领行；不 merge、不 rename、不落账） ──
  if (dryRun) {
    const decisions = planLostReplay(collectLostLines(lostPath), existingOf(), limit);
    const invalid = decisions.filter((d) => d.action === 'invalid').length;
    const terminalSkipped = decisions.filter((d) => d.action === 'terminal-skipped').length;
    const wouldReplay = decisions.filter((d) => d.action === 'replay').length;
    const remaining = decisions.length - wouldReplay - terminalSkipped;
    return { ok: true, exitCode: 0, dryRun: true, replayed: 0, invalid, terminalSkipped, remaining, wouldReplay, warnings };
  }

  // ── ① 合并遗留认领文件（按文件名序；含合法与非法行，原样 append 回主文件后删除） ──
  try {
    const dir = dirname(lostPath);
    const prefix = `${basename(lostPath)}.replaying-`;
    for (const name of readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()) {
      const file = join(dir, name);
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        warnings.push(`遗留认领文件不可读（保留不动）：${name}`);
        continue;
      }
      const lines = text.split(/\r?\n/).filter((l) => l !== '');
      try {
        if (lines.length > 0) {
          mkdirSync(dir, { recursive: true });
          appendFileSync(lostPath, `${lines.join('\n')}\n`, 'utf8');
        }
        unlinkSync(file);
      } catch {
        warnings.push(`遗留认领文件合并/删除失败（保留供人工）：${name}`);
      }
    }
  } catch {
    /* 目录不可读：无遗留面（主文件认领仍按缺失处理） */
  }

  // ── ② 原子认领：文件不存在或 rename 失败 ⇒ 0 行成功退 0，不创建空文件 ──
  const claimPath = `${lostPath}.replaying-${process.pid}-${Date.now()}`;
  try {
    renameSync(lostPath, claimPath);
  } catch {
    return { ok: true, exitCode: 0, dryRun: false, replayed: 0, invalid: 0, terminalSkipped: 0, remaining: 0, warnings };
  }
  if (typeof opts.afterClaim === 'function') {
    try {
      opts.afterClaim({ lostPath, claimPath });
    } catch {
      /* 测试缝异常不影响回放语义 */
    }
  }

  // ── ③ 处理认领文件 ──
  let text;
  try {
    text = readFileSync(claimPath, 'utf8');
  } catch {
    return { ok: false, exitCode: 1, dryRun: false, replayed: 0, invalid: 0, terminalSkipped: 0, remaining: 0, warnings, error: '认领文件不可读（已保留）' };
  }
  const existing = existingOf();
  const keep = [];
  let replayed = 0;
  let invalid = 0;
  let terminalSkipped = 0;
  let appendFailed = false;
  // 内部任务-244 Q02：与 dry-run 同一决策树（单源 `planLostReplay`）
  for (const decision of planLostReplay(text.split(/\r?\n/), existing, limit)) {
    const { rawLine, action } = decision;
    if (action === 'invalid') {
      invalid += 1;
      keep.push(rawLine);
      continue;
    }
    if (action === 'remaining') {
      keep.push(rawLine);
      continue;
    }
    if (action === 'terminal-skipped') {
      terminalSkipped += 1; // 终态记录：视为已处理并移除（保留只会永久重扫）
      continue;
    }
    const cls = classify();
    const rec = {
      ...decision.fact,
      id: decision.id,
      digest: decision.parsed.digest,
      status: 'open',
      cause: cls.cause,
      severity: cls.severity,
      ruleId: cls.ruleId,
      rulesVersion: cls.rulesVersion,
      replayedFrom: 'lost-facts',
      replayedAt: new Date().toISOString(),
    };
    const written = appendIncident(root, rec);
    if (!written.ok) {
      appendFailed = true; // 不截断：认领文件保留供人工；已成功行下次同 id 幂等
      break;
    }
    replayed += 1;
    existing.set(decision.id, rec);
  }
  if (appendFailed) {
    return {
      ok: false,
      exitCode: 1,
      dryRun: false,
      replayed,
      invalid,
      terminalSkipped,
      remaining: keep.length,
      warnings,
      error: '账本写入失败（认领文件已保留，不截断；已成功行下次同 id 幂等）',
    };
  }

  // ── ④ 保留行 append 回写（认领窗口内适配层新 append 落在原路径新文件上，不被覆盖） ──
  try {
    if (keep.length > 0) {
      mkdirSync(dirname(lostPath), { recursive: true });
      appendFileSync(lostPath, `${keep.join('\n')}\n`, 'utf8');
    }
    const rotated = rotateLostFile(lostPath, LOST_FACTS_MAX_LINES);
    if (!rotated.ok) throw new Error(rotated.error);
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      dryRun: false,
      replayed,
      invalid,
      terminalSkipped,
      remaining: keep.length,
      warnings,
      error: `保留行回写失败（认领文件保留供人工）：${String(error?.message ?? error).slice(0, 120)}`,
    };
  }

  // ── ⑤ 释放认领文件（失败仅告警：下次回放会合并，同 id 幂等） ──
  try {
    unlinkSync(claimPath);
  } catch (error) {
    warnings.push(`认领文件删除失败（下次回放自动合并）：${String(error?.message ?? error).slice(0, 120)}`);
  }
  return { ok: true, exitCode: 0, dryRun: false, replayed, invalid, terminalSkipped, remaining: keep.length, warnings };
}

/** promote 可接受的目标面（B-M15-2：只产草案，不改写权威面）。 */
const PROMOTE_TARGETS = Object.freeze(['learning', 'open', 'finding']);

/**
 * promote 草案产物路径（内部任务-244 Q09 单源）：`<workflow>/内部工作流状态<ts>-<id>.md`。
 * 抽出供 `cmdPromote` 与 selftest 共用——selftest 原先用 `join(...).endsWith('1-x.md')` 恒真
 * 空断言给路径形态假保证；现按真实构造比对。
 * @param {string} root 项目根 @param {number} ts epoch 毫秒 @param {string} id 已净化记录 id
 * @returns {string}
 */
export function promotionDraftPath(root, ts, id) {
  return join(dirname(incidentFile(root)), 'promotions', `${Number(ts)}-${String(id)}.md`);
}

/**
 * `promote` 子命令（内部规则-8/内部决策-063 D7）：生成 `内部工作流状态<ts>-<id>.md` 草案，
 * 并追加记录 `promotedTo`（审计）；**不写** learnings/内部规格 等权威面
 * （转正永远经人在环流程）。目标非法/记录不存在/写失败 → stderr + 退 1。
 * @param {string} root 项目根
 * @param {string[]} args 子命令参数
 * @returns {void}
 */
function cmdPromote(root, args) {
  const to = opt(args, '--to');
  const note = opt(args, '--note');
  const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--to' && args[i - 1] !== '--note') ?? '';
  if (!PROMOTE_TARGETS.includes(to)) {
    process.stderr.write(`promote 失败：--to 须为 ${PROMOTE_TARGETS.join('|')}（收到：${to ?? '（缺值）'}）\n`);
    process.exit(1);
  }
  if (input === '') {
    process.stderr.write('promote 失败：缺少 id 参数（用法：promote <id或唯一前缀> --to learning|open|finding [--note]）\n');
    process.exit(1);
  }
  // 评审修复 N9：单次读盘（此前 resolveIncidentId 与 rec 查询各读一次，落窗时可能取到不同快照）
  const rows = readIncidents(root);
  const resolved = resolveIncidentId(rows, input);
  if (!resolved.ok) {
    process.stderr.write(`promote 失败：${resolved.reason}\n`);
    if (resolved.candidates?.length) process.stderr.write(`候选：\n${resolved.candidates.map((c) => `  ${c}`).join('\n')}\n`);
    process.exit(1);
  }
  // 评审修复 B1：产物文件名 `<ts>-<id>.md` 的 id 段是文件名成分——账本可被外部改写（或历史
  // 坏数据），故落盘前按同一 id 白名单净化，非法即拒绝（防 `../` 越界写）。
  if (!isValidIncidentId(resolved.id)) {
    process.stderr.write(`promote 失败：记录 id 形态非法，拒绝作为产物文件名（${String(resolved.id).slice(0, 64)}）\n`);
    process.exit(1);
  }
  const rec = rows.find((r) => r.id === resolved.id);
  if (!rec) {
    process.stderr.write(`promote 失败：记录不存在（${resolved.id}）\n`);
    process.exit(1);
  }
  const dir = join(dirname(incidentFile(root)), 'promotions');
  const ts = Date.now();
  const file = promotionDraftPath(root, ts, resolved.id);
  const draft = [
    `# promote 草案：${resolved.id} → ${to}`,
    '',
    `- 生成时间：${new Date(ts).toISOString()}`,
    `- 建议目标：${to}`,
    `- 人工备注：${typeof note === 'string' && note ? note : '（无）'}`,
    '',
    '## 记录摘要（非原文事实）',
    `- kind：${rec.kind ?? '?'}`,
    `- cause：${rec.cause ?? '（旧记录未分类）'}`,
    `- severity：${rec.severity ?? '?'}`,
    `- status：${rec.status ?? '?'}`,
    `- digest：${String(rec.digest ?? '?').slice(0, 16)}`,
    `- observationSource：${rec.observationSource ?? '（未标注）'}`,
    `- 归属：session=${String(rec.session ?? '-').slice(0, 12)}/taskId=${rec.taskId ?? '-'}`,
    '',
    '## 复核判据（转正前逐项确认）',
    '- [ ] 现象可复述（不含命令/路径/错误原文——账本只存 digest 与类别）',
    '- [ ] 目标面与记录语义匹配（learning / OPEN / architecture-finding 之一）',
    '- [ ] 转正由人执行（本草案不改写任何权威面；B-M15-2）',
    '',
    '## 证据指针',
    `- 账本：.workflow/incidents.jsonl（id=${resolved.id}）`,
    `- 排查入口：incident-cli list --json`,
  ].join('\n') + '\n';
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, draft);
  } catch {
    process.stderr.write('promote 失败：草案写入失败（检查 .workflow 目录权限）\n');
    process.exit(1);
  }
  const w = appendIncident(root, { ...rec, promotedTo: to, amended: true });
  if (!w.ok) {
    process.stderr.write('promote 失败：账本写入失败（草案已生成，记录未更新）\n');
    process.exit(1);
  }
  process.stdout.write(`promote 完成：${resolved.id} → ${to}（草案 ${file}）\n`);
}

/**
 * `digest` 子命令（内部规则-4/内部规则-5）：近 N 天摘要（人读/--json 两态）。
 * 读侧姿态：空态/缺文件退 0 并如实报无数据；参数非法同样按读侧 fail-open 退 0（内部规则-4）。
 * `lostFacts` 与 retro/SessionStart 同源读 `内部工作流状态`（内部决策-063 修正案 1 决策 14）。
 * @param {string} root 项目根
 * @param {string[]} args 子命令参数
 * @returns {void}
 */
function cmdDigest(root, args) {
  const rawDays = opt(args, '--days');
  const days = rawDays === undefined ? 7 : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) return; // 读侧参数异常：静默退 0（fail-open）
  const out = digestProjection(root, { days });
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  const lines = [];
  if (out.total === 0) {
    lines.push(`（近 ${days} 天无自察异常记录；lost-facts ${out.lostFacts} 条）`);
  } else {
    lines.push(`近 ${days} 天自察摘要：共 ${out.total} 条记录（待排查 ${out.pending} / 证据面 ${out.evidence}）`);
    const causes = Object.entries(out.byCause).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${sanitizeDisplayText(String(k), 40)} ${n}`).join('、');
    const kinds = Object.entries(out.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${sanitizeDisplayText(String(k), 40)} ${n}`).join('、');
    lines.push(`  cause：${causes}`);
    lines.push(`  kind：${kinds}`);
    lines.push(`  lost-facts：${out.lostFacts} 条（.workflow/incidents-lost.jsonl）`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * digest 投影（纯读，selftest 直测）：窗口过滤＋cause/kind 拆分＋待排查/证据面＋lost-facts。
 * @param {string} root 项目根
 * @param {{days?: number, now?: number}} [opts]
 * @returns {{schemaVersion: number, days: number, since: number, total: number, pending: number,
 *            evidence: number, byCause: Record<string, number>, byKind: Record<string, number>, lostFacts: number}}
 */
function digestProjection(root, opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 7;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const since = now - days * DAY_MS;
  const rows = readIncidents(root).filter((r) => Number(r.ts) >= since);
  const byCause = {};
  const byKind = {};
  let pending = 0;
  let evidence = 0;
  for (const r of rows) {
    const cause = typeof r.cause === 'string' && r.cause ? r.cause : 'unclassified';
    byCause[cause] = (byCause[cause] ?? 0) + 1;
    const kind = typeof r.kind === 'string' ? r.kind : '?';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (r.status !== 'open') continue;
    if (isPendingIncidentV2(r)) pending += 1;
    else evidence += 1;
  }
  return {
    schemaVersion: 1,
    days,
    since,
    total: rows.length,
    pending,
    evidence,
    byCause,
    byKind,
    lostFacts: countLostFacts(root), // 评审修复 N4：与 SessionStart 就绪面/retro 同源单点
  };
}

/**
 * lease 排查面板（D4，2026-09-13 加固批次）：租约状态一目了然——当前项目键、各会话桶
 * current 指针、挑战、激活租约与剩余 TTL（存储卫生：token 只显前 8 位）。
 * 空态/不可读如实输出（fail-open 不抛）。
 * @param {string} [dir] 状态目录（缺省 runtimeStateDir）
 * @param {string} [key] 项目键（缺省按进程 cwd 推导）
 * @returns {string}
 */
function renderLease(dir = runtimeStateDir(), key = projectKey(process.cwd())) {
  const lines = [`项目键：${key}`];
  let any = false;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') names = []; // 目录尚不存在 = 无状态（首写会建）
    else return `${lines.join('\n')}\n（状态目录不可读：${dir}）\n`;
  }
  const readJson = (f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const leftMin = (ts) => (Number.isFinite(Number(ts)) ? String(Math.max(0, Math.round((Number(ts) - Date.now()) / 60000))) : '?');
  for (const name of names) {
    if (name.startsWith('wf-lease-current-')) {
      const p = readJson(join(dir, name));
      lines.push(`current 指针  桶=${name.slice('wf-lease-current-'.length)}  token=${String(p?.leaseId ?? '?').slice(0, 8)}…  epoch=${p?.promptEpoch ?? '?'}  updatedAt=${p?.updatedAt ?? '?'}`);
      any = true;
    } else if (name.startsWith('wf-lease-challenge-')) {
      const c = readJson(join(dir, name));
      lines.push(`挑战         token=${name.slice('wf-lease-challenge-'.length).replace('.json', '').slice(0, 8)}…  剩余TTL≈${leftMin(c?.expiresAt)}min  session=${c?.sessionId ?? 'null'}`);
      any = true;
    } else if (name.startsWith('wf-lease-active-')) {
      const a = readJson(join(dir, name));
      lines.push(`激活租约     token=${name.slice('wf-lease-active-'.length).replace('.json', '').slice(0, 8)}…  task=${a?.taskId ?? '?'}  skill=${a?.skill ?? '?'}  session=${a?.sessionId ?? 'null'}  剩余TTL≈${leftMin(a?.expiresAt)}min`);
      any = true;
    }
  }
  if (!any) lines.push('（无租约状态文件）');
  return `${lines.join('\n')}\n`;
}

/**
 * 自检入口（B-M8-4）：临时项目根上跑 append→read→setStatus 回环与渲染断言；
 * 失败可见退 1。
 * @returns {number}
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-icli-selftest-'));
  const prevDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const a = appendIncident(home, { id: 'ri-st-1', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'st00000000000001' });
    check('追加回环', a.ok);
    check('openCount 计数', openCount(home) === 1);
    check('triage 流转', setStatus(home, 'ri-st-1', 'triaged', '自检备注').ok);
    check('resolve 流转', setStatus(home, 'ri-st-1', 'resolved').ok);
    check('非法状态拒绝', !setStatus(home, 'ri-st-1', 'bogus').ok);
    check('list 渲染含 id', renderList(home).includes('ri-st-1'));
    check('heat 渲染含 digest', renderList(home, { showHeat: true }).includes('st00000000000001'.slice(0, 8)));
    // 内部任务-OSNOISE-1：空态摘要同时印**未分层 open** 与**分层待排查**两个数（分层不隐形）。
    // 断言口径（评审正确性 #3）：用真实记录 + 精确计数，而非"字面量出现过"——探针一条
    // （exit-nonzero，不计）+ 真失败一条（error-flag，计）⇒ open 2、其中待排查 1。
    const sub = join(home, 'summary-sub');
    appendIncident(sub, { id: 'tf-probe-sum', ts: Date.now(), session: 's', kind: 'tool-failure', errorClass: 'exit-nonzero', digest: 'sf10000000000001' });
    appendIncident(sub, { id: 'tf-real-sum', ts: Date.now(), session: 's', kind: 'tool-failure', errorClass: 'error-flag', digest: 'sf20000000000002' });
    check(
      'list 摘要：未分层 open 与分层待排查两数同源且准确',
      renderList(sub, { status: 'triaged' }).includes('open 计数 2，其中待排查 1'),
    );
    // 内部未决-14 批次：id 解析三态（全等/唯一前缀/歧义/无匹配/过短）
    const recs = [{ id: 'ri-a-111' }, { id: 'ri-a-222' }, { id: 'ri-b-333' }];
    check('id 解析全等优先', resolveIncidentId(recs, 'ri-a-111').id === 'ri-a-111');
    check('id 解析唯一前缀', resolveIncidentId(recs, 'ri-b-3').id === 'ri-b-333');
    check('id 解析歧义列候选', !resolveIncidentId(recs, 'ri-a-').ok && resolveIncidentId(recs, 'ri-a-').candidates.length === 2);
    check('id 解析无匹配', !resolveIncidentId(recs, 'zzzz').ok);
    check('id 解析过短拒绝', !resolveIncidentId(recs, 'ri').ok);
    // D4 lease 面板：空态 + 有激活租约
    const leaseDir = join(home, 'lease-state');
    process.env.WF_ROUTING_STATE_DIR = leaseDir;
    const empty = renderLease(leaseDir, '/proj-st');
    check('lease 空态含项目键与空态行', empty.includes('项目键') && empty.includes('无租约状态文件'));
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      join(leaseDir, 'wf-lease-active-0123456789abcdef0123456789abcdef.json'),
      JSON.stringify({ schemaVersion: 3, leaseId: '0123456789abcdef0123456789abcdef', projectKey: '/proj-st', sessionId: 'sess-st', taskId: 'TASK-3', skill: 'tdd', declaredAt: Date.now(), expiresAt: Date.now() + 600000 }),
    );
    const withLease = renderLease(leaseDir, '/proj-st');
    check('lease 含 taskId 与 TTL', withLease.includes('TASK-3') && withLease.includes('TTL'));
    // 内部任务-DEBTFIX-1：归属列渲染 + 同状态更正通道
    appendIncident(home, { id: 'ri-st-2', ts: Date.now(), session: 'session-abcd1234ef', taskId: 'TASK-9', kind: 'tool-failure', digest: 'st00000000000002' });
    check('list 渲染含归属列（会话短标识/taskId）', renderList(home).includes('abcd1234/TASK-9'));
    setStatus(home, 'ri-st-1', 'resolved', '更正备注');
    check('setStatus 更正通道成行（同状态 + 新 note）', renderList(home).includes('更正备注'));
    check('list 更正行标记（收尾评审 #2 处置）', renderList(home).includes('(更正)'));
    // 内部任务-20 A1/F8：机器面自检（不得只覆盖人读面；内部任务-50/内部未决-92 增第四枚 dropped 检查，共四项）
    check('list --json 投影：schemaVersion 与键集', (() => {
      const j = JSON.parse(renderListJson(home));
      // v2 加法键（内部接口-19 §2.1）：rulesVersion/countsByCause 加入键集，删键/改义须升版本
      return j.schemaVersion === 1 && Object.keys(j).sort().join(',') === 'counts,countsByCause,filter,ledger,projectRoot,records,rulesVersion,schemaVersion';
    })());
    check('list --json 计数与单次读盘同源', JSON.parse(renderListJson(home)).counts.open === openCount(home));
    // 内部未决-92（内部任务-50）：dropped 坏行计数面（非负整数；与 records 同次读盘投影）
    check('list --json 坏行计数投影', Number.isInteger(JSON.parse(renderListJson(home)).ledger.dropped) && JSON.parse(renderListJson(home)).ledger.dropped >= 0);
    check('用法文本含新增旗标', USAGE.includes('--json') && USAGE.includes('-h|--help'));
    // 内部任务-79/内部决策-041：archive 子命令与四态枚举的用法登记
    check('archive 子命令用法已登记', USAGE.includes('archive') && USAGE.includes('--max-age-days') && USAGE.includes('--dry-run'));
    check('status 取值文含 archived', USAGE.includes('open|triaged|resolved|archived'));
    // 内部模块-15 v2（内部任务-192/内部决策-063）：emit 白名单 / list 加法键单读同源 / digest 投影 / promote 目标闭集
    check(
      'v2 emit 白名单校验（原文键整单拒绝、合法载荷归一）',
      (() => {
        const ok = validateEmitPayload({ schemaVersion: 1, kind: 'hook-failure', observationSource: 'adapter:dsh', ts: Date.now(), id: 'em-st' });
        const bad = validateEmitPayload({ schemaVersion: 1, kind: 'hook-failure', observationSource: 'adapter:dsh', ts: Date.now(), command: 'rm -rf /' });
        return ok.ok === true && ok.fact.id === 'em-st' && bad.ok === false && bad.reason.includes('白名单外键');
      })(),
    );
    check(
      'v2 list --json 加法键与单读同源',
      (() => {
        const j = JSON.parse(renderListJson(home));
        const sum = Object.values(j.countsByCause).reduce((a, b) => a + b, 0);
        return j.rulesVersion === 1 && sum === j.records.length && Number.isInteger(j.counts.pending);
      })(),
    );
    check(
      'v2 digest 投影（窗口过滤 + lostFacts 同源）',
      (() => {
        const d = digestProjection(home, { days: 7 });
        return d.schemaVersion === 1 && d.days === 7 && d.total >= 1 && Number.isInteger(d.lostFacts) && d.byCause && d.byKind;
      })(),
    );
    check(
      'v2 promote 目标闭集与草案路径形态',
      (() => {
        // 内部任务-244 Q09：真实构造断言（原 endsWith('1-x.md') 恒真＝空断言）
        const built = promotionDraftPath(home, 1, 'x');
        return PROMOTE_TARGETS.join('|') === 'learning|open|finding'
          && built === join(dirname(incidentFile(home)), 'promotions', '1-x.md')
          && built.endsWith('.md')
          && !built.includes('..')
          && USAGE.includes('promote');
      })(),
    );
    // 内部模块-15 v2（内部决策-063 修正案 3 决策 22，内部任务-195）：emit --from-lost 参数面与原子认领回放。
    check(
      'v2 emit --from-lost 参数面（limit 缺省 50 / dry-run / 非法值拒）',
      (() => {
        const base = parseEmitReplayArgs(['--from-lost']);
        const withFlags = parseEmitReplayArgs(['--from-lost', '--limit', '7', '--dry-run']);
        return (
          base.ok === true && base.limit === 50 && base.dryRun === false &&
          withFlags.ok === true && withFlags.limit === 7 && withFlags.dryRun === true &&
          parseEmitReplayArgs(['--from-lost', '--limit', '0']).ok === false &&
          parseEmitReplayArgs(['--from-lost', '--limit', 'abc']).ok === false &&
          parseEmitReplayArgs(['--from-lost', '--limit']).ok === false &&
          parseEmitReplayArgs(['--from-lost', '--json']).ok === false &&
          parseEmitReplayArgs(['--from-lost', 'payload']).ok === false &&
          parseEmitReplayArgs([]).ok === false
        );
      })(),
    );
    check(
      'v2 emit --from-lost 原子认领回放（dry-run 零写 / 审计字段 / 幂等 / invalid 保留）',
      (() => {
        const sub = join(home, 'lost-replay');
        const file = lostFactsPath(sub);
        mkdirSync(dirname(file), { recursive: true });
        const good = JSON.stringify({ schemaVersion: 1, ts: Date.now(), kind: 'observation-degraded', observationSource: 'adapter:dsh', count: 2, digest: 'abcdef0123456789' });
        writeFileSync(file, `${good}\nnot-json\n`);
        const before = readFileSync(file, 'utf8');
        const dry = replayLostFacts(sub, { limit: 10, dryRun: true });
        const dryOk =
          dry.ok === true && dry.wouldReplay === 1 && dry.invalid === 1 &&
          readFileSync(file, 'utf8') === before && readIncidents(sub).length === 0;
        const real = replayLostFacts(sub, { limit: 10 });
        const rec = readIncidents(sub).find((r) => String(r.id).startsWith('lost-'));
        const realOk =
          real.ok === true && real.replayed === 1 && real.invalid === 1 &&
          Boolean(rec) && rec.cause === 'observation-degraded' && rec.severity === 'warn' &&
          rec.replayedFrom === 'lost-facts' && typeof rec.replayedAt === 'string' && String(rec.id).length === 37 &&
          readFileSync(file, 'utf8').trim() === 'not-json';
        writeFileSync(file, `${good}\n`);
        const again = replayLostFacts(sub, { limit: 10 });
        const idemOk = again.ok === true && readIncidents(sub).filter((r) => String(r.id).startsWith('lost-')).length === 1;
        return dryOk && realOk && idemOk;
      })(),
    );
  } finally {
    if (prevDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevDir;
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL incident-cli.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK incident-cli.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

/**
 * id 解析（内部未决-14 批次）：精确全等优先 → 唯一前缀匹配（最短 4 字符，list 显示的
 * 12 位截断前缀可直接回填）→ 失败带 reason（歧义附全部候选）。存储层 setStatus
 * 保持全等语义不动（单一事实源）；前缀是 CLI 呈现层的 UX 关注点。
 * @param {Array<{id: string}>} records readIncidents 全量记录
 * @param {string} input 用户输入
 * @returns {{ok: true, id: string} | {ok: false, reason: string, candidates?: string[]}}
 */
export function resolveIncidentId(records, input) {
  const want = String(input ?? '');
  const exact = records.find((r) => r.id === want);
  if (exact) return { ok: true, id: exact.id };
  if (want.length >= 4) {
    const hits = records.filter((r) => String(r.id).startsWith(want));
    if (hits.length === 1) return { ok: true, id: hits[0].id };
    if (hits.length > 1) return { ok: false, reason: '前缀歧义，请用完整 id', candidates: hits.map((r) => r.id) };
  }
  return { ok: false, reason: `未找到 id "${want}"（list 查看完整 id；前缀须 ≥4 字符且唯一）`, candidates: [] };
}

/**
 * 主入口：list/lease 读侧 fail-open（参数异常静默退 0）；triage/resolve/未知子命令
 * 失败可见（stderr + 退 1，2026-09-15 修订）。
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    process.exit(selftest());
  }
  const root = opt(argv, '--project-root') ?? '.';
  const rest = argv.filter((a, i) => a !== '--project-root' && argv[i - 1] !== '--project-root');
  // 帮助只认**首个位置参数**（plan-review 三维①2）：`argv.includes` 形态会被 `triage <id> --note -h`
  // 的 note 值骗中——变更未发生却印用法退 0，与「写侧失败可见」口径相悖。
  if (rest[0] === '--help' || rest[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  const command = rest[0];
  const args = rest.slice(1);
  try {
    if (command === 'list') {
      const status = opt(args, '--status');
      const showHeat = args.includes('--heat');
      if (args.includes('--json')) {
        process.stdout.write(renderListJson(root, { status, showHeat }));
        return;
      }
      process.stdout.write(renderList(root, { status, showHeat }));
      return;
    }
    if (command === 'lease') {
      // D4 面板：状态目录取 runtimeStateDir（与闸/声明同源），键按 --project-root 推导
      // （评审 P5：与兄弟子命令一致消费 root，缺省进程 cwd）
      process.stdout.write(renderLease(runtimeStateDir(), projectKey(resolve(String(root)))));
      return;
    }
    if (command === 'archive') {
      // 内部决策-041/内部任务-79：证据类超龄终态化（写侧命令，失败可见退 1 分野同 triage/resolve——
      // 阶段门①＋终评处置：账本不可读、旗标缺值/非法、写失败（命中未迁移）三类全部显式退 1）
      const file = incidentFile(root);
      if (probeLedgerStatus(file) === 'unreadable') {
        process.stderr.write(`archive 失败：账本不可读（${file}）\n`);
        process.exit(1);
      }
      const dryRun = args.includes('--dry-run');
      const flagPresent = args.includes('--max-age-days');
      const rawDays = opt(args, '--max-age-days');
      const days = Number(rawDays);
      if ((flagPresent && rawDays === undefined) || (rawDays !== undefined && (!Number.isFinite(days) || days <= 0))) {
        // 显式传入非法值或旗标缺值都必须拒绝（评审阻塞项＋阶段门①：静默回退缺省会执行与用户意图相悖的不可逆迁移）
        process.stderr.write(`archive 失败：--max-age-days 须为正数且带值（收到：${rawDays ?? '（缺值）'}）\n`);
        process.exit(1);
      }
      const maxAgeDays = rawDays === undefined ? 30 : days;
      const now = Date.now();
      if (dryRun) {
        const rows = agedExcludedTargets(root, now, maxAgeMsOf(maxAgeDays));
        const capped = Math.min(rows.length, ARCHIVE_BATCH_LIMIT);
        const preview = rows.slice(0, 20).map((r) => `  ${r.id}（${r.kind}${r.errorClass ? '/' + r.errorClass : ''}）`).join('\n');
        const tail = rows.length > 20 ? `\n  …及另 ${rows.length - 20} 条` : '';
        process.stdout.write(`dry-run：可迁移 ${capped} 条（超龄>${maxAgeDays} 天、单次上限 ${ARCHIVE_BATCH_LIMIT}）\n${preview}${tail}\n`);
        return;
      }
      const { archived, failed } = archiveAgedIncidents(root, { maxAgeDays, now });
      if (failed > 0) {
        process.stderr.write(`archive 失败：${failed} 条命中未迁移（写盘失败）\n`);
        process.exit(1);
      }
      process.stdout.write(`archived：迁移 ${archived} 条（max-age-days=${maxAgeDays}；清单：list --status archived）\n`);
      return;
    }
    // 内部模块-15 v2（内部决策-063 D2/D7）：emit / promote / digest（读侧 digest fail-open，写侧 emit/promote 失败可见）
    if (command === 'emit') {
      cmdEmit(root, args);
      return;
    }
    if (command === 'promote') {
      cmdPromote(root, args);
      return;
    }
    if (command === 'digest') {
      cmdDigest(root, args);
      return;
    }
    if (command === 'triage' || command === 'resolve') {
      const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--note') ?? '';
      const note = opt(args, '--note');
      const asJson = args.includes('--json'); // 内部未决-99（内部任务-50）：成功面机器投影旗标（无值旗标，不吞参数）
      // 内部决策-041/内部任务-79：批量谓词形态——命中集＝排除面＋超龄（谓词与 archiveAgedIncidents 同源），
      // 须与显式 --note 同用；分流先于单条 id 流程（--older-than 的值会被上方 input 提取误认）。
      if (args.includes('--matching-excluded')) {
        // 终评处置：批量谓词同享账本可读性探针（写侧分野——头注承诺面完整兑现）
        if (probeLedgerStatus(incidentFile(root)) === 'unreadable') {
          process.stderr.write(`${command} 失败：账本不可读（${incidentFile(root)}）\n`);
          process.exit(1);
        }
        const olderRaw = String(opt(args, '--older-than') ?? '');
        const days = Number(olderRaw.replace(/d$/, ''));
        if (note === undefined || note === '' || !Number.isFinite(days) || days <= 0) {
          process.stderr.write(`${command} 失败：批量谓词须同用显式 --note 与合法 --older-than Nd\n`);
          process.exit(1);
        }
        const now = Date.now();
        const targets = agedExcludedTargets(root, now, maxAgeMsOf(days));
        let done = 0;
        for (const t of targets) {
          if (setStatus(root, t.id, command === 'triage' ? 'triaged' : 'resolved', note).ok) done += 1;
        }
        if (done < targets.length) {
          process.stderr.write(`${command} 失败：${targets.length - done} 条命中未迁移（写盘失败）\n`);
          process.exit(1);
        }
        process.stdout.write(`${command} 批量完成：${done} 条（命中 ${targets.length} 条）\n`);
        return;
      }
      if (input === '') {
        process.stderr.write(`${command} 失败：缺少 id 参数（用法：${command} <id或唯一前缀> --note "<一句话>"）\n`);
        process.exit(1);
      }
      const resolved = resolveIncidentId(readIncidents(root), input);
      if (!resolved.ok) {
        process.stderr.write(`${command} 失败：${resolved.reason}\n`);
        if (resolved.candidates?.length) process.stderr.write(`候选：\n${resolved.candidates.map((c) => `  ${c}`).join('\n')}\n`);
        process.exit(1);
      }
      const targetStatus = command === 'triage' ? 'triaged' : 'resolved'; // 写入状态与投影单源（门①简洁性 S2）
      const r = setStatus(root, resolved.id, targetStatus, note);
      if (r.ok) {
        // 内部任务-DEBTFIX-1：同状态更正与状态迁移在输出上可区分（反馈闭环）；
        // 内部未决-99（内部任务-50）：--json 成功面单行投影 {schemaVersion,command,id,status,amended}——
        // 失败面维持 stderr+退 1（机器消费方以退出码分流，失败不造契约）。
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: 1, command, id: resolved.id, status: targetStatus, amended: Boolean(r.amended) })}\n`,
          );
        } else {
          process.stdout.write(r.amended ? `${command} 完成（更正 note，状态未变）：${resolved.id}\n` : `${command} 完成：${resolved.id}\n`);
        }
        return;
      }
      // 内容失败可见化：reason 不再丢弃（此前静默退 0 是无声失败源）
      process.stderr.write(`${command} 失败：${r.reason ?? '写盘失败'}\n`);
      process.exit(1);
    }
    process.stderr.write(`未知子命令：${command ?? '(空)'}（可用：list | triage | resolve | archive | emit | promote | digest | lease | --selftest）\n`);
    process.exit(1);
  } catch (err) {
    // 写侧命令的意外异常同样可见（读侧 list/lease 正常路径已提前 return，不受影响）
    process.stderr.write(`incident-cli 异常：${String(err?.message ?? err).slice(0, 200)}\n`);
    process.exit(1);
  }
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    // symlink 形态归一（内部未决-52，内部任务-44；形态同 内部任务-GUARDSYML-1 九钩）：argv[1] 为别名形态时
    // 字符串级比对恒 false → CLI 整体静默 no-op；realpath 归一后再比一次（失败落 catch 判 false）。
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
