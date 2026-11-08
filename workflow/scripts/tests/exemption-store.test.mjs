// 文件：exemption-store.test.mjs
// 描述：exemption-store.mjs（任务租约豁免审计存储库，内部决策-020/内部决策-067 / 内部接口-20 v2）
//       行为测试——schema v2 字段保真、scope/planPath 规则、revoke 记录、
//       返回对象（调用方 fail-closed）、注入缝与写失败不抛。
// 作者：wangp  创建：2026-09-14  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 用临时目录（WF_EXEMPTIONS_ROOT 注入缝）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const LIB = await import('../lib/exemption-store.mjs');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-exempt-'));
}

const rec = (over = {}) => ({
  taskId: 'TASK-9',
  skill: 'plan-execution',
  src: 'user',
  scope: 'plan',
  reason: '不用写计划，直接修',
  ...over,
});

function expectDigest(taskId, reason) {
  return createHash('sha256').update(`${taskId}|${reason}`).digest('hex').slice(0, 12);
}

function readRaw(root) {
  const text = readFileSync(LIB.exemptionsFile(root), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('审计 v2 字段保真与写失败返回：schemaVersion/scope/reason trim/id/digest/planPath', () => {
  const root = tmpRoot();
  try {
    const out = LIB.recordExemption(root, rec({ reason: '  不用写计划，直接修  ' }));
    assert.equal(out.ok, true, '追加成功返回 ok');
    assert.ok(/^ex-[0-9a-f]{12}$/.test(out.id), 'id=ex-<digest12>');
    assert.ok(LIB.exemptionsFile(root).endsWith(join('.workflow', 'wf-exemptions.jsonl')));
    const list = readRaw(root);
    assert.equal(list.length, 1);
    const r = list[0];
    const d = expectDigest('TASK-9', '不用写计划，直接修');
    assert.equal(r.schemaVersion, 2);
    assert.equal(r.id, `ex-${d}`);
    assert.equal(r.digest, d);
    assert.equal(r.taskId, 'TASK-9');
    assert.equal(r.skill, 'plan-execution');
    assert.equal(r.src, 'user');
    assert.equal(r.scope, 'plan');
    assert.equal(r.reason, '不用写计划，直接修', 'reason 由库自身 trim 后落盘');
    assert.equal('planPath' in r, false, 'scope=plan 不带 planPath');
    assert.ok(Number.isFinite(r.ts));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同 id 二写：文件 2 行（O_APPEND 追加不丢；读侧末条胜出）', () => {
  const root = tmpRoot();
  try {
    assert.equal(LIB.recordExemption(root, rec({ src: 'user' })).ok, true);
    assert.equal(LIB.recordExemption(root, rec({ src: 'preauthorized' })).ok, true);
    const lines = readFileSync(LIB.exemptionsFile(root), 'utf8').split('\n').filter((l) => l.trim()).length;
    assert.equal(lines, 2);
    assert.equal(readRaw(root)[1].src, 'preauthorized');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('src 白名单（单源 EXEMPT_SOURCES）：非法 src 拒写返回对象、不落文件', () => {
  const root = tmpRoot();
  try {
    const bad = LIB.recordExemption(root, rec({ src: 'bogus' }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /src/);
    assert.ok(!existsSync(LIB.exemptionsFile(root)));
    assert.equal(LIB.recordExemption(root, rec({ src: 'preauthorized' })).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope×planPath 规则：非法 scope/缺 planPath/plan 带 planPath/绝对与 .. 均拒', () => {
  const root = tmpRoot();
  try {
    assert.equal(LIB.recordExemption(root, rec({ scope: 'bogus' })).ok, false);
    assert.equal(LIB.recordExemption(root, rec({ scope: 'review' })).ok, false, 'review 缺 planPath');
    assert.equal(LIB.recordExemption(root, rec({ scope: 'plan', planPath: 'docs/plans/x.md' })).ok, false, 'plan 带 planPath');
    assert.equal(LIB.recordExemption(root, rec({ scope: 'review', planPath: '/abs/x.md' })).ok, false, '绝对路径');
    assert.equal(LIB.recordExemption(root, rec({ scope: 'review', planPath: '../x.md' })).ok, false, '.. 段');
    const ok = LIB.recordExemption(root, rec({ scope: 'review', planPath: 'docs/plans/x.md' }));
    assert.equal(ok.ok, true);
    assert.equal(readRaw(root)[0].planPath, 'docs/plans/x.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revoke 记录：scope=revoked/src/reason/id/digest；recordExemption 拒绝 revoked', () => {
  const root = tmpRoot();
  try {
    const out = LIB.recordExemptionRevocation(root, {
      taskId: 'DEV-1',
      reason: '撤销计划豁免，按正常评审计划走',
      src: 'user',
    });
    assert.equal(out.ok, true);
    const d = expectDigest('DEV-1', '撤销计划豁免，按正常评审计划走');
    const r = readRaw(root)[0];
    assert.equal(r.schemaVersion, 2);
    assert.equal(r.scope, 'revoked');
    assert.equal(r.src, 'user');
    assert.equal(r.reason, '撤销计划豁免，按正常评审计划走');
    assert.equal(r.id, `ex-${d}`);
    assert.equal(r.digest, d);
    assert.equal(LIB.recordExemption(root, rec({ scope: 'revoked' })).ok, false, '用户面不得直接写 revoked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revoke 负例：撤销引文未点名/空/src 非法/system 均拒且不落文件', () => {
  const root = tmpRoot();
  try {
    for (const bad of [
      { taskId: 'DEV-1', reason: '继续', src: 'user' },
      { taskId: 'DEV-1', reason: '   ', src: 'user' },
      { taskId: 'DEV-1', reason: '撤销计划豁免', src: 'bogus' },
      { taskId: 'DEV-1', reason: '撤销计划豁免', src: 'system' },
    ]) {
      const r = LIB.recordExemptionRevocation(root, bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.ok(!existsSync(LIB.exemptionsFile(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入缝：WF_EXEMPTIONS_ROOT 覆盖根目录（写读同根，原 root 不落文件）', () => {
  const root = tmpRoot();
  const injected = mkdtempSync(join(tmpdir(), 'wf-exempt-inj-'));
  const prev = process.env.WF_EXEMPTIONS_ROOT;
  process.env.WF_EXEMPTIONS_ROOT = injected;
  try {
    assert.equal(LIB.exemptionsFile(root), join(injected, '.workflow', 'wf-exemptions.jsonl'));
    assert.equal(LIB.recordExemption(root, rec()).ok, true);
    assert.equal(readRaw(root).length, 1);
    assert.ok(!existsSync(join(root, '.workflow')));
  } finally {
    if (prev === undefined) delete process.env.WF_EXEMPTIONS_ROOT;
    else process.env.WF_EXEMPTIONS_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(injected, { recursive: true, force: true });
  }
});

test('写失败返回对象（调用方 fail-closed）：普通文件占位注入根 → ok=false+error，不抛', () => {
  const root = tmpRoot();
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'x');
  const prev = process.env.WF_EXEMPTIONS_ROOT;
  process.env.WF_EXEMPTIONS_ROOT = blocker;
  try {
    const r = LIB.recordExemption(root, rec());
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  } finally {
    if (prev === undefined) delete process.env.WF_EXEMPTIONS_ROOT;
    else process.env.WF_EXEMPTIONS_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
