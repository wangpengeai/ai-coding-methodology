// 文件：mode-state.mjs
// 描述：探路模式状态的只读客户端（内部接口-9 v3，内部决策-031）——v3 本地判定：
//       `.scout/mode.json` 单文件自含（合法 v3 ∧ 未过期 ∧ 无待恢复残留 → 有效模式），
//       读取为纯本地文件操作、零 spawn（v2 的提供方委托与 provider-unavailable 语义
//       整体退役）。写入路径归 mode-lifecycle.mjs（本地事务）；本模块另承载桥接定位
//       （env → 同仓 → 装机同级不限版本：同版本优先、最高版本兜底——内部未决-11 脆弱面
//       不残留于增强档），供 mode-lifecycle 的 register/graduate/sync 调用与
//       bridgeAvailable 在场检测。桥入口＝spec-gate/assurance/scout-tx.mjs（内部任务-86
//       阶段1b 消费面切换：node 入口；Python 桥入口随 1b 退役）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；读取永不抛错。
// 用法：node scout/scripts/mode-state.mjs --selftest（冒烟自检；读取经模块导出消费）
// 注入缝：SCOUT_TX_PROVIDER 整体覆盖桥接 CLI 路径（测试/异装布局；命中即用，
//       不做存在性回退——显式用户意志；.py 后缀由 mode-lifecycle 明示退役错误）。
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitJson, isMainModule } from './cli-main.mjs';

/** 模式枚举（内部接口-9：mode 只允许 explore/disposable；mode-lifecycle 复用同源）。 */
export const MODES = ['explore', 'disposable'];

/** 装机布局版本目录名（X.Y.Z[+预发布后缀]；导出供测试直测排序比较用——不再是激活门控）。 */
export const VERSION_DIR_RE = /^\d+(\.\d+){2}(-[0-9A-Za-z.-]+)?$/;

const MODE_SCHEMA_VERSION = 3;
const EXPIRY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 判定原语单源导出（mode-lifecycle 写路径复用同源——读写两侧校验规则不得双持）
export { MODE_SCHEMA_VERSION };

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isValidExpiry(expiry) {
  if (!EXPIRY_RE.test(String(expiry ?? ''))) return false;
  const d = new Date(`${expiry}T00:00:00Z`);
  // T15 严格日历日（UTC round-trip）：2027-02-30 不得被 Date.parse 滚成 03-02
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === expiry;
}

/** T15 判定原语：非空字符串（taskId/transactionId 类型校验单源，mode-lifecycle/gate 语义对齐）。 */
export function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 读取本地留痕（内部决策-065 T4）：返回 `{events, dropped}`——坏行不抛、计入 dropped；
 * 调用方在 dropped>0 时必须拒绝压缩重写（保留原文件，防审计留痕被静默截断）。
 * @param {string} projectRoot
 * @returns {{events: object[], dropped: number}}
 */
export function readLedger(projectRoot) {
  const p = join(projectRoot, '.scout', 'ledger.jsonl');
  if (!existsSync(p)) return { events: [], dropped: 0 };
  const events = [];
  let dropped = 0;
  for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') events.push(v);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  return { events, dropped };
}

/**
 * 桥接定位候选链（内部接口-9 §4a；仅服务桥调用与 bridgeAvailable，模式状态读取不经本链）：
 * ①env：SCOUT_TX_PROVIDER 透传值（未设为 null；命中即用不做存在性回退）；
 * ②repo：同仓布局（scout/scripts/ 上溯三级拼 spec-gate/assurance/scout-tx.mjs，存在性筛）；
 * ③installed：装机布局（自身路径版本目录门控形态识别，拼 <mkt>/spec-gate/<候选版本>/
 *   assurance/scout-tx.mjs——**不限版本**（内部决策-031 决策 3）：同版本目录优先，无同版本取
 *   最高版本目录兜底；候选穷尽为 null。桥操作幂等且登记失败留 pendingSync 兜底，
 *   版本错配不再致命（v2 的同版本严格匹配随权威源归位一并退役）。
 * @returns {{source: 'env'|'repo'|'installed', path: string|null}[]}
 */
export function providerCandidates() {
  const here = resolve(fileURLToPath(import.meta.url));
  const repoCandidate = join(resolve(here, '..', '..', '..'), 'spec-gate', 'assurance', 'scout-tx.mjs');
  let installedCandidate = null;
  const verDir = basename(dirname(dirname(here))); // <mkt>/scout/<ver>/scripts/mode-state.mjs → 上溯两级取 <ver> 目录名
  if (VERSION_DIR_RE.test(verDir)) {
    const mkt = resolve(here, '..', '..', '..', '..'); // scripts → ver → scout → <mkt>
    installedCandidate = pickInstalledCli(mkt, verDir);
  }
  return [
    { source: 'env', path: process.env.SCOUT_TX_PROVIDER || null },
    { source: 'repo', path: existsSync(repoCandidate) ? repoCandidate : null },
    { source: 'installed', path: installedCandidate },
  ];
}

/** 装机市场内选桥接 CLI：同版本优先、无同版本取最高版本（数值段比较，预发布后缀忽略）。 */
function pickInstalledCli(mkt, selfVer) {
  const sgDir = join(mkt, 'spec-gate');
  let names;
  try {
    names = readdirSync(sgDir).filter((n) => VERSION_DIR_RE.test(n));
  } catch {
    return null; // 无 spec-gate 同级目录：增强缺失
  }
  const withCli = names.filter((n) => existsSync(join(sgDir, n, 'assurance', 'scout-tx.mjs')));
  if (withCli.length === 0) return null;
  if (withCli.includes(selfVer)) return join(sgDir, selfVer, 'assurance', 'scout-tx.mjs');
  withCli.sort((a, b) => compareVer(a, b));
  return join(sgDir, withCli[withCli.length - 1], 'assurance', 'scout-tx.mjs');
}

/** 版本目录数值比较（'1.10.0' > '1.9.0'；后缀不参与排序——兜底语义只取「最高目录」）。 */
function compareVer(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * 解析桥接 CLI 路径：env 段命中即返回（不筛）；否则自动段（repo/installed）首个命中；
 * 穷尽返回 null（调用方按增强缺失处理——bridgeAvailable=false）。
 * @returns {string|null}
 */
export function providerCli() {
  const candidates = providerCandidates();
  const env = candidates.find((c) => c.source === 'env');
  if (env.path) return env.path;
  const auto = candidates.find((c) => c.source !== 'env' && c.path);
  return auto ? auto.path : null;
}

/** 桥在场检测（SessionStart「本地档运行中」提示与毕业可用性分叉；本地模式不受其影响）。 */
export function bridgeAvailable() {
  return providerCli() !== null;
}

/** journal 损坏备份列表（`journal.corrupt-*`；内部决策-065 T2 共享口径，readStatus/check-consistency 同源）。 */
export function corruptBackups(projectRoot) {
  try {
    return readdirSync(join(projectRoot, '.scout', 'transactions'))
      .filter((n) => n.startsWith('journal.corrupt-'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 读取模式状态（内部接口-9 v3 唯一读取语义，纯本地零 spawn）：
 * 合法 v3 ∧ 未过期 ∧ 无待恢复残留 → 有效模式；journal 残留 → 恢复前按无模式
 * （pendingRecovery=true）；v2 合法未过期 → migratable-v2；v1 → legacy；损坏（含
 * mode 非法枚举/日历日非法/id 非字符串）→ corrupt；读失败（权限/占用/目录等）→
 * unreadable（T17，附 errno）；过期 → expired（保留 mode/expiry 供提醒分叉）。
 * @param {string} projectRoot 项目根
 * @returns {{mode: string|null, expiry: string|null, taskId: string|null,
 *            transactionId: string|null, valid: boolean, overdue: boolean,
 *            pendingRecovery: boolean, bridgeAvailable: boolean, journalCorrupt: boolean,
 *            reason: string|null, errno?: string|null}}
 */
export function readStatus(projectRoot) {
  const pending = existsSync(join(projectRoot, '.scout', 'transactions', 'journal.json'));
  const available = bridgeAvailable();
  const journalCorrupt = corruptBackups(projectRoot).length > 0;
  const base = { mode: null, expiry: null, taskId: null, transactionId: null, valid: false, overdue: false, pendingRecovery: pending, bridgeAvailable: available, journalCorrupt, reason: 'absent' };
  const mp = join(projectRoot, '.scout', 'mode.json');
  if (!existsSync(mp)) return base;
  let raw;
  try {
    raw = readFileSync(mp, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return base; // 与 existsSync 之间的竞态窗口按 absent
    // T17 读异常分类：权限/占用/目录等读失败 → unreadable（保留 errno）；不得误判 corrupt
    return { ...base, reason: 'unreadable', errno: err && err.code ? err.code : null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, reason: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object') return { ...base, reason: 'corrupt' };
  const ver = parsed.schemaVersion;
  if (ver === undefined && typeof parsed.mode === 'string' && typeof parsed.expiry === 'string') {
    return { ...base, mode: parsed.mode, expiry: parsed.expiry, reason: 'legacy' };
  }
  if (ver !== MODE_SCHEMA_VERSION && ver !== 2) return { ...base, reason: 'corrupt' };
  if (typeof parsed.mode !== 'string' || !MODES.includes(parsed.mode) || typeof parsed.expiry !== 'string'
    || !isNonEmptyString(parsed.taskId) || !isNonEmptyString(parsed.transactionId)) {
    return { ...base, reason: 'corrupt' };
  }
  const shape = { mode: parsed.mode, expiry: parsed.expiry, taskId: parsed.taskId, transactionId: parsed.transactionId };
  if (!isValidExpiry(shape.expiry)) return { ...base, reason: 'corrupt' };
  if (pending) return { ...base, ...shape, reason: 'pending-recovery' };
  if (shape.expiry < todayIso()) {
    return { ...base, ...shape, overdue: true, reason: 'expired' };
  }
  if (ver === 2) {
    return { ...base, ...shape, reason: 'migratable-v2' };
  }
  return { ...shape, valid: true, overdue: false, pendingRecovery: false, bridgeAvailable: available, journalCorrupt, reason: null };
}

// 直接运行入口（resolve 两侧对齐：相对路径调用下 argv[1] 恒真判定；symlink 形态归一＝内部未决-52，内部任务-44，
// 形态同 内部任务-GUARDSYML-1 九钩——argv[1] 为别名形态时首轮恒 false，realpath 归一后二轮再比）。
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  try {
    cliFace(process.argv.slice(2));
  } catch (err) {
    // T14：工具错误（fs 异常等）→ stdout JSON + 退 2，不输出栈
    emitJson({ ok: false, code: 'tool-error', error: err && err.message ? String(err.message) : String(err) }, { code: 2 });
  }
}

/** CLI 直跑面（提取为函数使 T21 字面 return 合法——模块顶层 return 非法，内部任务-337/内部未决-224⑭）。 */
function cliFace(args) {
  if (args.includes('--selftest')) {
    // 本地判定冒烟：临时目录 v3 → valid；v2 → migratable-v2。不再断言提供方存在性（v3 读取零 spawn）。
    // 内部决策-065 T21：失败走 process.exitCode（不 process.exit）并 return，finally 统一清理临时根。
    const root = mkdtempSync(join(tmpdir(), 'scout-ms-selftest-'));
    try {
      const checks = [];
      const check = (name, cond) => checks.push([name, Boolean(cond)]);
      mkdirSync(join(root, '.scout'), { recursive: true });
      writeFileSync(join(root, '.scout', 'mode.json'),
        JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-SELFTEST-1', transactionId: 't' }));
      check('v3 本地判定有效', readStatus(root).valid === true);
      writeFileSync(join(root, '.scout', 'mode.json'),
        JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: '2999-01-01', taskId: 'TASK-SELFTEST-1', transactionId: 't' }));
      const s2 = readStatus(root);
      check('v2 读为 migratable-v2', s2.valid === false && s2.reason === 'migratable-v2');
      const failed = checks.filter(([, ok]) => !ok);
      for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
      if (failed.length) {
        process.stdout.write(`FAIL mode-state selftest（${failed.length} 项未过）\n`);
        process.exitCode = 1;
        return; // T21 字面收束（行为等价，内部未决-224⑭——失败分支显式早退）
      } else {
        process.stdout.write('OK mode-state selftest（v3 本地判定）\n');
      }
    } catch (err) {
      process.stdout.write(`FAIL mode-state selftest：${err.message}\n`);
      process.exitCode = 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } else {
    process.stderr.write('用法：node scout/scripts/mode-state.mjs --selftest（读取经模块导出消费；写入归 mode-lifecycle）\n');
    process.exit(2);
  }
}
