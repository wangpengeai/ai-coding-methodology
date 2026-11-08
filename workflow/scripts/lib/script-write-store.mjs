// 文件：script-write-store.mjs
// 描述：脚本写/脚本编辑声明审计仓（内部决策-066 D3 与修正案 1 内部模块-2，内部任务-261/内部任务-285）——运行态
//       追加式 JSONL：`--script-write` → `wf-script-writes.jsonl`；`--script-edit-code` →
//       `wf-script-edits.jsonl`（目录由调用方传 stateRootFor(键)）。每条声明一行：
//       {ts, taskId, skill, leaseId, reason}；写失败返回 {ok:false, reason} 不抛（调用方
//       stderr 警示、不阻断已激活租约）。本文件不读账本、不判断放行（放行读租约数组）。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；失败不抛。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_WRITE_AUDIT_FILE = 'wf-script-writes.jsonl';
const SCRIPT_EDIT_AUDIT_FILE = 'wf-script-edits.jsonl';

/**
 * 追加一条声明审计（内部单源；两旗标仅文件名/语义不同）。
 * @param {{dir: string, file: string, record: {taskId?: string|null, skill?: string|null, leaseId?: string|null, projectKey?: string|null, reason: string}}} input
 * @returns {{ok: boolean, reason?: string}}
 */
function appendDeclaration({ dir, file, record } = {}) {
  try {
    if (typeof dir !== 'string' || dir === '') return { ok: false, reason: 'state-dir-missing' };
    if (!record || typeof record.reason !== 'string' || record.reason.trim() === '') return { ok: false, reason: 'reason-missing' };
    mkdirSync(dir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      taskId: record.taskId ?? null,
      skill: record.skill ?? null,
      leaseId: record.leaseId ?? null,
      projectKey: record.projectKey ?? null,
      reason: record.reason.trim(),
    };
    appendFileSync(join(dir, file), `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * 追加一条 `--script-write` 声明审计。
 * @param {{dir: string, record: {taskId?: string|null, skill?: string|null, leaseId?: string|null, projectKey?: string|null, reason: string}}} input
 * @returns {{ok: boolean, reason?: string}}
 */
export function appendScriptWrite({ dir, record } = {}) {
  return appendDeclaration({ dir, file: SCRIPT_WRITE_AUDIT_FILE, record });
}

/**
 * 追加一条 `--script-edit-code` 声明审计（内部决策-066 修正案 1 内部模块-2，内部任务-285）。
 * @param {{dir: string, record: {taskId?: string|null, skill?: string|null, leaseId?: string|null, projectKey?: string|null, reason: string}}} input
 * @returns {{ok: boolean, reason?: string}}
 */
export function appendScriptEdit({ dir, record } = {}) {
  return appendDeclaration({ dir, file: SCRIPT_EDIT_AUDIT_FILE, record });
}
