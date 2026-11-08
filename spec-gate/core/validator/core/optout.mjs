// 文件：optout.mjs
// 描述：宿主无关 opt-out 裁决（RULE-OPT-001..004）；F-15 坏时间/未知 mode 产说明而非崩溃。
import { cmpPyDateTimeUtc, codePointCompare, parseNowOrThrow, parsePyIsoDateTime, pyRepr } from './pycompat.mjs';

export const SCOPES = ['all', 'sdd', 'ddd', 'ddd-strategic', 'tdd'];
const COVERED_BY = {
  all: new Set(['all', 'sdd', 'ddd', 'ddd-strategic', 'tdd']),
  ddd: new Set(['ddd', 'ddd-strategic']),
  'ddd-strategic': new Set(['ddd-strategic']),
  sdd: new Set(['sdd']),
  tdd: new Set(['tdd']),
};

function parseTime(value) {
  if (!value) return { dt: null, invalid: false };
  const dt = parsePyIsoDateTime(String(value));
  return { dt, invalid: dt === null };
}

function coveredBy(scope) {
  return COVERED_BY[scope] ?? new Set();
}

export function effectiveSuppressedScopes(records, now, taskId = null, explicitEnable = false) {
  const notes = [];
  const suppressed = new Set();
  if (explicitEnable) {
    notes.push('explicit-enable: 当前任务显式启用高于全部持久 opt-out');
    return [suppressed, notes];
  }
  const nowDt = parseNowOrThrow(now, 'now');
  for (const record of records ?? []) {
    const scope = record?.scope;
    if (!SCOPES.includes(scope)) {
      notes.push(`invalid-scope: 忽略未知 scope ${pyRepr(scope)}`);
      continue;
    }
    const expires = parseTime(record.expiresAt);
    if (expires.invalid) {
      notes.push(`invalid-expires: scope=${scope} expiresAt 不是合法 ISO-8601，记录被忽略`);
      continue;
    }
    if (expires.dt && nowDt && cmpPyDateTimeUtc(expires.dt, nowDt) <= 0) {
      notes.push(`expired-cleaned: scope=${scope} 已到期，视为无效`);
      continue;
    }
    const mode = record.mode;
    if (mode !== 'persistent' && mode !== 'current-task') {
      notes.push(`invalid-mode: scope=${scope} mode=${pyRepr(mode)} 非法，记录被忽略`);
      continue;
    }
    if (mode === 'current-task') {
      if (!record.taskId) {
        notes.push(`missing-task-id: current-task 记录缺少 taskId，拒绝应用（scope=${scope}）`);
        continue;
      }
      if (record.taskId !== taskId) {
        notes.push(`task-mismatch: current-task 记录仅对任务 ${record.taskId} 生效`);
        continue;
      }
    }
    for (const s of coveredBy(scope)) suppressed.add(s);
    notes.push(`applied: scope=${scope} mode=${mode}`);
  }
  return [suppressed, notes];
}

export function restore(records, scope) {
  const notes = [];
  const remaining = (records ?? []).filter((r) => r?.scope !== scope);
  const removed = (records ?? []).length - remaining.length;
  if (removed) notes.push(`removed: 已移除 ${removed} 条 scope=${scope} 记录`);
  else notes.push(`noop: 无 scope=${scope} 记录，恢复幂等`);
  const covering = remaining.filter((r) => coveredBy(r?.scope).has(scope));
  for (const r of remaining) {
    if (!SCOPES.includes(r?.scope)) notes.push(`unknown-scope: 剩余记录含未知 scope ${pyRepr(r?.scope)}，已忽略其覆盖判定`);
  }
  const stillSuppressed = covering.length > 0;
  if (stillSuppressed) {
    const broader = [...new Set(covering.map((r) => r.scope))].sort(codePointCompare);
    notes.push(`still-suppressed: scope=${scope} 仍被更广 scope ${pyRepr(broader)} 覆盖`);
  }
  return [remaining, stillSuppressed, notes];
}

/** opt_out fixture 的 note→ruleId 映射（单源；F-7）。 */
export const OPT_OUT_NOTE_RULES = {
  'missing-task-id': 'RULE-OPT-003',
  'invalid-scope': 'RULE-OPT-001',
  'invalid-expires': 'RULE-OPT-001',
  'invalid-mode': 'RULE-OPT-001',
};

export function ruleIdsForNotes(notes) {
  const ids = [];
  for (const note of notes ?? []) {
    const key = String(note).split(':')[0];
    if (OPT_OUT_NOTE_RULES[key]) ids.push(OPT_OUT_NOTE_RULES[key]);
  }
  return ids;
}
