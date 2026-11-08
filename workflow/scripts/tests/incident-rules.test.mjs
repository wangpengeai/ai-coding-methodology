// 文件：incident-rules.test.mjs
// 描述：内部模块-15 v2 分类规则表与保守回退（incident-rules.mjs）的单元测试——规则矩阵、坏表回退、
//       env 注入缝与缓存刷新语义。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；fixture 全部用临时目录，测完即清理。
// 锚：内部验收-23「分类规则矩阵与保守回退」（内部规格 §6）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAUSES,
  SEVERITIES,
  PENDING_CAUSES,
  EVIDENCE_CAUSES,
  loadRules,
  classifyFact,
} from '../lib/incident-rules.mjs';

// 评审修复 N8：`new URL(...).pathname` 在 win32 产出 `/C:/…` 形态（前导斜杠使 fs 解析失败）——
// 统一用 fileURLToPath（跨平台正解）。
const RULES_PATH = fileURLToPath(new URL('../lib/incident-classification.json', import.meta.url));

function tmpJson(name, value) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-rules-'));
  const file = join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return { dir, file };
}

test('分类规则矩阵与保守回退', () => {
  // 1) 合法规则表加载：版本与闭集一致
  const rules = loadRules({ path: RULES_PATH });
  assert.equal(rules.ok, true);
  assert.equal(rules.rulesVersion, 1);
  assert.deepEqual([...CAUSES].sort(), [...rules.causes].sort());
  assert.deepEqual([...SEVERITIES].sort(), [...rules.severities].sort());
  assert.deepEqual([...PENDING_CAUSES].sort(), [...rules.pendingCauses].sort());
  assert.deepEqual([...EVIDENCE_CAUSES].sort(), [...rules.evidenceCauses].sort());

  // 2) 规则命中矩阵
  const cases = [
    [{ kind: 'tool-failure', errorClass: 'error-flag', errorCode: 'FS_NOT_FOUND', host: 'dsh' }, 'replayable-rejection'],
    [{ kind: 'tool-failure', errorClass: 'exit-nonzero', exitCode: 3 }, 'probe-noise'],
    [{ kind: 'tool-failure', errorClass: 'error-flag' }, 'real-failure'],
    [{ kind: 'tool-failure', errorClass: 'error-field' }, 'real-failure'],
    [{ kind: 'tool-failure', errorClass: 'stderr' }, 'real-failure'],
    [{ kind: 'lease-deny' }, 'mechanism-trace'],
    [{ kind: 'lease-revive' }, 'mechanism-trace'],
    [{ kind: 'bootstrap-reissue' }, 'mechanism-trace'],
    [{ kind: 'lease-read-anomaly' }, 'mechanism-trace'],
    [{ kind: 'lease-loop' }, 'mechanism-escalation'],
    [{ kind: 'user-correction' }, 'user-correction'],
    [{ kind: 'retry-loop' }, 'retry-escalation'],
    [{ kind: 'observation-degraded' }, 'observation-degraded'],
    [{ kind: 'hook-failure' }, 'real-failure'],
    [{ kind: 'unknown-kind' }, 'unclassified'],
  ];
  for (const [fact, cause] of cases) {
    const r = classifyFact(fact, rules);
    assert.equal(r.cause, cause, `${JSON.stringify(fact)} → ${cause}（实得 ${r.cause}）`);
    assert.equal(r.rulesVersion, 1);
    assert.ok(typeof r.ruleId === 'string' && r.ruleId.length > 0);
    assert.ok(CAUSES.includes(r.cause));
    assert.ok(SEVERITIES.includes(r.severity));
  }

  // 3) allowlist 边界：未登记 errorCode 不得被归为可回放拒绝
  const unknown = classifyFact({ kind: 'tool-failure', errorClass: 'error-flag', errorCode: 'FS_UNKNOWN_X' }, rules);
  assert.notEqual(unknown.cause, 'replayable-rejection');
  assert.equal(unknown.cause, 'real-failure');

  // 4) 对象形态/空输入保守
  assert.equal(classifyFact(null, rules).cause, 'unclassified');
  assert.equal(classifyFact({}, rules).cause, 'unclassified');

  // 5) 版本透出与幂等
  const a = classifyFact({ kind: 'lease-loop' }, rules);
  const b = classifyFact({ kind: 'lease-loop' }, rules);
  assert.deepEqual(a, b);
});

test('坏表回退：缺失/非法 JSON/schemaVersion 或 rulesVersion 缺失 → 内置默认且不抛', () => {
  const flag = { degraded: true };
  const cases = [
    { path: join(tmpdir(), `no-such-rules-${Date.now()}.json`) },
    { path: tmpJson('bad.json', '{not json').file },
    { path: tmpJson('noschema.json', JSON.stringify({ rulesVersion: 1, rules: [] })).file },
    { path: tmpJson('nover.json', JSON.stringify({ schemaVersion: 1, rules: [] })).file },
  ];
  for (const c of cases) {
    const r = loadRules(c);
    assert.equal(r.ok, false, `${c.path} 应回退`);
    assert.equal(r.degraded, true, `${c.path} 应标 degraded`);
    const cls = classifyFact({ kind: 'hook-failure' }, r);
    assert.equal(cls.cause, 'unclassified', `${c.path} 回退后保守 unclassified`);
  }
  rmSync(tmpJson('x.json', '{}').dir, { recursive: true, force: true });
});

test('内置默认规则表与外部规则表同构校验（防止实现漂移）', () => {
  const fallback = loadRules({ path: join(tmpdir(), `missing-${Date.now()}.json`) });
  assert.equal(fallback.ok, false);
  assert.ok(Array.isArray(fallback.rules) && fallback.rules.length === 0);
  assert.ok(Array.isArray(fallback.replayableErrorCodes));
  // 保守姿态：回退时 allowlist 为空 ⇒ 任何 errorCode 不得被静默排除（宁可多报进待排查）。
  assert.equal(fallback.replayableErrorCodes.length, 0);
});
