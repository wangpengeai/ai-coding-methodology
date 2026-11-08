#!/usr/bin/env node
// 文件：check-consistency.mjs
// 描述：B-M9-4 一致性 lint（内部决策-065 T16 判定树）——判定源本地：mode.json v3 声明与
//       `.scout/ledger.jsonl` 本地留痕比对（最近生命周期事件的 expiry/transactionId
//       一致）；spec-gate 桥在场时附加中央镜像分态比对（missing/unreadable/corrupt/
//       mismatch/stale），并对陈旧条目/absent+active/未留痕关闭输出**可执行手工命令**
//       （含 --transaction-id 与 --disposition）；journal 损坏备份、ledger 坏行、
//       pendingSync（仅桥在场）均判违例。v2 的「委托 assurance 提供方判定」与
//       provider-unavailable 分支整体退役；无桥场景不读 `内部治理状态`。
//       lint 非 hook：发现即修，不适用 fail-open。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；只读，不写任何状态。
// 用法：node scout/scripts/check-consistency.mjs [--project-root <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitJson, isMainModule, parseProjectRootArg } from './cli-main.mjs';
import { corruptBackups, MODES, readLedger, readStatus } from './mode-state.mjs';

const LIFECYCLE_EVENTS = new Set(['open', 'renew', 'abandon', 'graduate', 'migrate', 'synced']);
/** B-M9-4 比对基准：最近一次「声明变更」事件（open/renew/migrate）——synced 带新随机
 * transactionId 且无 expiry，abandon/graduate 后无有效声明，均不参与 expiry/txId 比对。 */
const DECLARATION_EVENTS = new Set(['open', 'renew', 'migrate']);

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 读中央台账并分态（T16）：missing/unreadable/corrupt/ok（含 scout-mode 条目与 active 集合）。 */
function readCentral(root) {
  const p = join(root, '.sdd', 'ledger.json');
  if (!existsSync(p)) return { status: 'missing' };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    return { status: 'unreadable', error: err && err.code ? err.code : String(err) };
  }
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.tasks)) {
    return { status: 'corrupt' };
  }
  const entries = ledger.tasks.filter((t) => t && typeof t === 'object' && t.taskType === 'scout-mode');
  return { status: 'ok', entries, actives: entries.filter((t) => t.status === 'active') };
}

/** 可执行手工命令（T16；transaction-id 生成真实 UUID、disposition 由用户填写）。
 *  条目字段不完整/形态不符（缺 id/mode/合法 deadline、mode 非 MODES、owner 含控制字符）时返回 null，
 *  由调用方降级为人工核对指引（不输出不可执行命令）。 */
function manualAbandonCommand(root, task) {
  const id = typeof task.id === 'string' && /^[A-Za-z0-9_.-]+$/.test(task.id) ? task.id : null;
  const mode = typeof task.mode === 'string' && MODES.includes(task.mode) ? task.mode : null;
  const expiry = typeof task.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) ? task.deadline : null;
  if (!id || !mode || !expiry) return null;
  let owner = '';
  if (typeof task.owner === 'string' && task.owner) {
    if (/[\u0000-\u001f\u007f]/.test(task.owner)) return null; // 控制字符不可安全入命令
    owner = ` --owner '${task.owner.replaceAll("'", "'\\''")}'`; // 单引号 shell 转义（$、反引号、\ 均失效）
  }
  return `node "<spec-gate 安装根>/assurance/scout-tx.mjs" scout-register --project-root "${root}" --task-id ${id} --mode ${mode} --expiry ${expiry} --transaction-id ${randomUUID()} --event abandon --disposition "<人工填写：归档/删除，不并入主干>"${owner}`;
}

function violation(messages) {
  for (const msg of messages) process.stdout.write(`violation: ${msg}\n`);
  process.exit(1);
}

function consistent(msg) {
  process.stdout.write(`consistent: ${msg}\n`);
  process.exit(0);
}

/** 中央镜像缺失指引（S-04，内部未决-224②）：ok 态无当前条目与 missing 态共用（T8：missing 唯一指引入口）。 */
function missingMirrorMsg(root, taskId) {
  return `中央台账无 ${taskId} 镜像条目——运行 node scout/scripts/mode-lifecycle.mjs --project-root "${root}" sync 补登（T8：missing 唯一指引入口）`;
}

const MANUAL_DEGRADED_NOTE = '字段不完整或形态不符，无法生成手工命令——人工核对后手工处置'; // ⑪：manualAbandonCommand 的 null 判据本就含形态不符（:59-69），文案如实覆盖两因（内部未决-224，内部任务-337）

/**
 * 主流程（内部决策-065 T16 判定树）：journal 坏态 → pendingSync（仅桥在场）→ 本地声明/留痕比对
 * → 中央镜像分态处置。只读；违例收集后一次性输出。
 * @returns {void}
 */
function main() {
  const parsed = parseProjectRootArg(process.argv.slice(2));
  // 守卫先于 resolve（对齐 mode-lifecycle parseCli 先例：缺值/尾随旗标退 2，不让 resolve 抛栈）
  if (!parsed || parsed.rest.length > 0) {
    process.stderr.write('用法：node scout/scripts/check-consistency.mjs [--project-root <dir>]\n');
    process.exit(2);
  }
  const root = parsed.root === null ? process.cwd() : resolve(parsed.root);
  if (!isDirectory(root)) { // isDirectory 的 try/catch 已覆盖缺失态（S-11，内部未决-224⑤）
    process.stderr.write(`项目根不存在或不是目录：${root}\n`);
    process.exit(2);
  }
  const state = readStatus(root);
  const { events, dropped } = readLedger(root);
  const lifecycle = events.filter((e) => LIFECYCLE_EVENTS.has(e.event));
  const pending = events.filter((e) => e.event === 'pendingSync');
  const backups = corruptBackups(root);

  const hard = [];
  if (backups.length > 0) {
    hard.push(`journal 损坏备份待人工核对（${backups.join('、')}）——核对后删除备份，hook/lint 停止提示（ADR-065 T2）`);
  }
  if (state.pendingRecovery) {
    hard.push(`Scout 事务待恢复（journal 残留）——运行 node scout/scripts/mode-lifecycle.mjs --project-root "${root}" recover`);
  }
  if (dropped > 0) {
    hard.push(`本地留痕含 ${dropped} 行坏数据：压缩重写已禁止，请先人工核对/修复留痕（ADR-065 T4）`);
  }
  const central = state.bridgeAvailable ? readCentral(root) : { status: 'absent' };
  if (state.bridgeAvailable) {
    if (central.status === 'unreadable') {
      hard.push(`中央台账不可读（${central.error}）：检查权限/路径后重试；禁止 register 覆盖（T16）`);
    } else if (central.status === 'corrupt') {
      hard.push('中央台账损坏（JSON 不可解析/结构非法）：修复台账后重试；禁止 register 重置（T16）');
    }
    if (pending.length > 0) {
      hard.push(`pendingSync 积压 ${pending.length} 项——运行 node scout/scripts/mode-lifecycle.mjs --project-root "${root}" sync 补登（B-M9-2 留痕义务；仅桥在场判违例）`);
    }
  }
  if (hard.length > 0) return violation(hard);

  const centrals = [];
  if (state.valid) {
    const declarations = events.filter((e) => DECLARATION_EVENTS.has(e.event));
    const last = declarations.length > 0 ? declarations[declarations.length - 1] : null;
    if (!last) {
      return violation(['mode v3 有效但无本地留痕事件（B-M9-2/B-M9-4）——留痕与声明必须同事务落盘；运行 recover 或重开修复']);
    }
    if (String(last.expiry) !== String(state.expiry) || last.transactionId !== state.transactionId) {
      return violation([`mode 与本地留痕不一致（声明 expiry=${state.expiry}/txId=${state.transactionId}，留痕 expiry=${last.expiry}/txId=${last.transactionId}）——经 mode-lifecycle recover 或重开修复（B-M9-4 v3）`]);
    }
    if (state.bridgeAvailable) {
      if (central.status === 'ok') {
        const entries = central.entries;
        const stale = entries.filter((t) => t.status === 'active' && t.id !== state.taskId);
        for (const s of stale) {
          const cmd = manualAbandonCommand(root, s);
          centrals.push(cmd
            ? `陈旧中央条目（active 且非当前 taskId=${s.id}）——处置（手工命令，含 transaction-id/disposition）：${cmd}`
            : `陈旧中央条目（active 且非当前 taskId=${String(s.id)}）——${MANUAL_DEGRADED_NOTE}`);
        }
        const current = entries.find((t) => t.id === state.taskId) ?? null;
        if (!current) {
          centrals.push(missingMirrorMsg(root, state.taskId));
        } else if (current.status === 'converged') {
          // T16：graduate 中断态不属 sync/register 可修复（register 拒绝复活 converged），禁止指引 sync 死路
          centrals.push('graduate 中断态（本地声明有效但中央条目已 converged）：不属 sync/register 可修复——人工核对中央/本地证据后按桥维护批处置（ADR-065 T16）');
        } else if (current.status !== 'active' || String(current.deadline) !== String(state.expiry) || current.transactionId !== state.transactionId) {
          centrals.push(`中央镜像与本地声明不一致（taskId/deadline/transactionId）——以本地为准，运行 sync 补登（scout-register 覆盖修复，IF-COLLAB-12 §4）`);
        }
      } else if (central.status === 'missing') {
        centrals.push(missingMirrorMsg(root, state.taskId));
      }
    }
    if (centrals.length > 0) return violation(centrals);
    return consistent(`模式 ${state.mode}（taskId=${state.taskId}）与本地留痕${state.bridgeAvailable ? '及中央镜像' : ''}一致（expiry=${state.expiry}）`);
  }

  if (state.reason === 'unreadable') {
    return violation([`本地声明不可读（.scout/mode.json，errno=${state.errno ?? 'unknown'}）——检查文件权限/占用后重试；无法修复时运行 recover 或重开（T17）`]);
  }
  if (state.reason === 'migratable-v2') {
    return violation([`v2 声明待迁移——运行 node scout/scripts/mode-lifecycle.mjs --project-root "${root}" migrate-v2（ADR-031 决策 4）`]);
  }
  if (state.reason === 'expired') {
    return violation([`模式已过期（expiry=${state.expiry}）——到期检查点三选一：renew / 桥 graduate / abandon`]);
  }
  if (state.reason === 'absent') {
    // 未留痕关闭：最近一次「声明变更」事件晚于最近一次「关闭」事件（synced 不算关闭，防被 sync 掩盖）
    let lastDeclIdx = -1;
    let lastCloseIdx = -1;
    for (let idx = 0; idx < events.length; idx += 1) {
      const ev = events[idx];
      if (DECLARATION_EVENTS.has(ev.event)) lastDeclIdx = idx;
      if (ev.event === 'abandon' || ev.event === 'graduate') lastCloseIdx = idx;
    }
    if (lastDeclIdx >= 0 && lastDeclIdx > lastCloseIdx) {
      const lastLifecycle = events[lastDeclIdx];
      const cmd = manualAbandonCommand(root, { id: lastLifecycle.taskId, mode: lastLifecycle.mode, deadline: lastLifecycle.expiry });
      return violation([`未留痕关闭：本地无有效声明但留痕最后事件为 ${lastLifecycle.event}（taskId=${lastLifecycle.taskId}）——运行 recover；或补 abandon：${cmd ?? `（${MANUAL_DEGRADED_NOTE}）`}`]);
    }
    if (state.bridgeAvailable && central.status === 'ok') {
      for (const a of central.actives) {
        const cmd = manualAbandonCommand(root, a);
        centrals.push(cmd
          ? `absent+中央 active 遗留条目（taskId=${a.id}, mode=${a.mode}, deadline=${a.deadline}）——不自动补偿；处置（手工命令）：${cmd}`
          : `absent+中央 active 遗留条目（taskId=${String(a.id)}）——不自动补偿；${MANUAL_DEGRADED_NOTE}`);
      }
      if (centrals.length > 0) return violation(centrals);
    }
    return consistent(lifecycle.length === 0
      ? '无探路模式且无留痕事件'
      : '无探路模式（历史留痕正常保留）');
  }
  return violation([`声明无效（reason=${state.reason}）——经 node scout/scripts/mode-lifecycle.mjs --project-root "${root}" recover/迁移/重开修复（B-M9-4 v3）`]);
}

// __selftest 与直接运行共用 main：诊断入口失败可见；symlink 形态归一＝内部未决-52，内部任务-44
//（形态同 内部任务-GUARDSYML-1 九钩——别名形态首轮恒 false，realpath 归一后二轮再比）。
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    // 冒烟：空临时项目走 absent 路径退 0（v3 本地判定，无提供方依赖）；用毕清理
    const root = mkdtempSync(join(tmpdir(), 'scout-cc-selftest-'));
    const r = spawnSelf(root);
    rmSync(root, { recursive: true, force: true });
    if (r.status !== 0 || !r.stdout.includes('consistent')) {
      process.stdout.write(`FAIL check-consistency selftest：${r.stdout}${r.stderr}\n`);
      process.exit(1);
    }
    process.stdout.write('OK check-consistency selftest（v3 本地判定）\n');
    process.exit(0);
  }
  try {
    main();
  } catch (err) {
    // T14：lint 工具错误 → stdout JSON + 退 2，不输出栈
    emitJson({ ok: false, code: 'tool-error', error: err && err.message ? String(err.message) : String(err) }, { code: 2 });
  }
}

/** 以子进程运行自身（selftest 用——保持与真实 CLI 完全同路径）。 */
function spawnSelf(root) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--project-root', root], { encoding: 'utf8' });
}
