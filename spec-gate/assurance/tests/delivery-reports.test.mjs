// 文件：delivery-reports.test.mjs
// 描述：delivery_reports.py 实现（唯一实现；迁移史见 内部决策-051）单测（内部决策-051 运行时归一·阶段2 凭据链 2.3；永久件）——逐方法
//       移植 spec-gate/assurance/tests/test_delivery_reports.py 的 22 方法（DeliveryPrepareTest/
//       ApplicabilityValidationTest/RequiredSectionsTest/DeliveryFinalizeTest/
//       FinalizeLedgerConvergenceTest/OperationChainFinalizeTest），另从 2.2 移入
//       `ChainHeadEquivalenceTest` 的 finalize 两例（test_finalize_accepts_head_shift /
//       test_finalize_rejects_gate_head_unverifiable），共 24；另补三条 JS 专项永久回归
//       （gate 未通过、deliverable 三环链、非字符串 chainProfile——原仅 parity 覆盖），共 27；类名/断言/夹具逐字对应。
//       operation 链用例的 gate 签发面：gate.mjs 已在阶段3a 移植（内部任务-92/内部决策-051），但本文件只验
//       finalize 行为——故仍以 receipts.issueGateReceipt 按 run_gate 同一入参等价签发（blocking 0、
//       revision=当前、riskLevel 取链上 operation 凭据、L1 免 draft），不冒充 gate 测试。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEC_IMPACT_PLACEHOLDER, _testHooks, finalizeDelivery, missingRequiredSections, prepareDelivery,
} from '../delivery_reports.mjs';
import {
  ChainProfileError, integrity, issueCodeReviewReceipt, issueGateReceipt, issueOperationReceipt,
  issueVerificationReceipt, latestReceipt,
} from '../receipts.mjs';
import { computeRevisionSet } from '../revision.mjs';
import { sha256Hex } from '../common.mjs';
import { runGate } from '../gate.mjs';
import { commitAll, makeGitProject } from './git-fixtures.mjs';
import { fakeCore } from './gate-fixtures.mjs';
import { prov } from './provenance-fixtures.mjs';

/** tmp 夹具根（每个用例自建自清，零真机触达）。 */
import { acquireLock, releaseLock } from '../lock.mjs';

function tmpRoot(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

/** 递归清理（Windows 锁文件重试；force 容忍已删除）。 */
function cleanup(root) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }

/** 结构化判定（内部未决-8：三项独立结论+理由；对齐 `_app`）。 */
function app() {
  return {
    sdd: { conclusion: 'required', reason: '批次含规格条款与哈希重登' },
    ddd: { conclusion: 'tactical', reason: '模块内变更，无领域建模' },
    tdd: { conclusion: 'strict', reason: '测试先行，错误路径覆盖' },
  };
}

/** 最小无 git 项目：src 一文件（对齐 `_project`）。 */
function project(base) {
  const proj = join(base, 'p');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
  return proj;
}

/** 构造一条命令证据引用并落盘（对齐 `_evidence`）。 */
function evidence(proj) {
  const ev = join(proj, 'src', 'ev.txt');
  writeFileSync(ev, 'ok\n', 'utf8');
  return [{ path: 'src/ev.txt', sha256: `sha256:${sha256Hex(Buffer.from('ok\n', 'utf8'))}`, exitCode: 0 }];
}

/** 读 reports 目录下指定文件文本。 */
function reportPath(proj, task, name) {
  return join(proj, '.sdd', 'reports', task, name);
}

/**
 * 构造完整链到 gate 凭据，返回 draft 路径（对齐 `_chain_to_gate`）。
 * @param {string} proj @param {string} [task] @returns {string}
 */
function chainToGate(proj, task = '内部任务-1') {
  const v = issueVerificationReceipt(proj, task, evidence(proj), { profile: 'full' });
  const c = issueCodeReviewReceipt(proj, task, v.receiptId, '三维通过', {
    reviewInstances: 3, reviewRound: 1, reviewProvenance: prov(task, 3),
  });
  prepareDelivery(proj, task, {
    applicability: app(),
    changeScope: ['src/**'],
    receiptRefs: [v.receiptId, c.receiptId],
    specImpact: '规格条款演进与工件哈希重登',
  });
  const draft = reportPath(proj, task, 'delivery-draft.json');
  issueGateReceipt(proj, task, v.receiptId, draft, {
    blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
  });
  return draft;
}

/**
 * 操作链 gate 等价签发（gate.mjs 已于阶段3a 移植；本文件为 finalize 行为测试，仍走等价签发而不是 gate 测试）：run_gate 零阻断时以当前 revision 盖章、
 * L1 免两阶段报告（draft null）、riskLevel 取链上 operation 凭据。
 * @param {string} proj @param {string} task @param {{l1?: boolean}} [opts]
 */
function runGateOperation(proj, task, { l1 = false } = {}) {
  const v = latestReceipt(proj, task, 'verification');
  const o = latestReceipt(proj, task, 'operation');
  const draft = reportPath(proj, task, 'delivery-draft.json');
  return issueGateReceipt(proj, task, v.receiptId, l1 ? null : draft, {
    blockingCount: 0,
    warningCount: 0,
    revision: computeRevisionSet(proj),
    operationReceiptId: o.receiptId,
    riskLevel: l1 ? 'L1' : (o.riskLevel ?? null),
  });
}

describe('DeliveryPrepareTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-dr-prep-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_prepare_produces_partial_only：prepare 只产 partial、schema 2.1.0、对象化落盘', () => {
    const draft = prepareDelivery(proj, '内部任务-1', {
      applicability: app(), changeScope: ['src/**'], receiptRefs: [],
    });
    assert.equal(draft.finalStatus, 'partial');
    assert.equal(draft.schemaVersion, '2.1.0', '结构化 applicability 升版（内部未决-8）');
    assert.equal(draft.applicability.sdd.conclusion, 'required', '对象化存盘');
    assert.ok(existsSync(reportPath(proj, '内部任务-1', 'delivery-draft.json')));
  });

  test('test_prepare_cannot_claim_complete：prepare 不得产出 complete', () => {
    assert.throws(() => prepareDelivery(proj, '内部任务-1', {
      applicability: app(), changeScope: ['src/**'], receiptRefs: [], finalStatus: 'complete',
    }));
  });
});

describe('ApplicabilityValidationTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-dr-app-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_vocab_out_of_range_rejected：词表外结论拒绝', () => {
    const bad = app();
    bad.sdd.conclusion = 'mandatory'; // 词表外
    assert.throws(() => prepareDelivery(proj, '内部任务-2', {
      applicability: bad, changeScope: ['src/**'], receiptRefs: [],
    }));
  });

  test('test_missing_key_rejected：缺 ddd 项拒绝', () => {
    const bad = app();
    delete bad.ddd;
    assert.throws(() => prepareDelivery(proj, '内部任务-2', {
      applicability: bad, changeScope: ['src/**'], receiptRefs: [],
    }));
  });

  test('test_empty_reason_rejected：空白理由拒绝', () => {
    const bad = app();
    bad.tdd.reason = '  ';
    assert.throws(() => prepareDelivery(proj, '内部任务-2', {
      applicability: bad, changeScope: ['src/**'], receiptRefs: [],
    }));
  });
});

describe('RequiredSectionsTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-dr-req-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  /** 绕过 prepare 直写旧形态草案（单值 applicability+空引用+占位影响；对齐 `_legacy_draft`）。 */
  function legacyDraft(task = '内部任务-9') {
    const reports = join(proj, '.sdd', 'reports', task);
    mkdirSync(reports, { recursive: true });
    const draft = join(reports, 'delivery-draft.json');
    writeFileSync(draft, JSON.stringify({
      schemaVersion: '2.0.0',
      taskId: task,
      finalStatus: 'partial',
      applicability: 'SDD=required',
      specImpact: SPEC_IMPACT_PLACEHOLDER,
      changeScope: [],
      receiptRefs: [],
      risks: [],
      unverified: [],
      preparedAt: 'x',
    }), 'utf8');
    return draft;
  }

  test('test_missing_sections_finalize_rejected：必检节缺失 ⇒ finalize 拒绝落地（停留 partial）', () => {
    const draft = legacyDraft();
    const v = issueVerificationReceipt(proj, '内部任务-9', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-9', v.receiptId, '三维通过', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-9', 3),
    });
    issueGateReceipt(proj, '内部任务-9', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    assert.throws(() => finalizeDelivery(proj, '内部任务-9'), /必检节/, '内部规则-12 语义：缺失即 partial');
    assert.equal(existsSync(reportPath(proj, '内部任务-9', 'delivery-final.json')), false,
      '最终报告不得落地（停留 partial）');
  });

  test('test_missing_sections_listed：三必检节全缺被点名', () => {
    const draft = JSON.parse(readFileSync(legacyDraft(), 'utf8'));
    const missing = missingRequiredSections(draft);
    assert.deepEqual([...missing].sort(), ['applicability', 'receiptRefs', 'specImpact']);
  });

  test('test_missing_receipt_refs_only_finalize_rejected：仅缺 receiptRefs 也拒绝落地（FB-5）', () => {
    const task = '内部任务-5';
    const v = issueVerificationReceipt(proj, task, evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, task, v.receiptId, '三维通过', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov(task, 3),
    });
    prepareDelivery(proj, task, {
      applicability: app(),
      changeScope: ['src/**'],
      receiptRefs: [],
      specImpact: '规格影响已判定',
    });
    const draft = reportPath(proj, task, 'delivery-draft.json');
    issueGateReceipt(proj, task, v.receiptId, draft, {
      blockingCount: 0, warningCount: 1, codeReviewReceiptId: c.receiptId,
    });
    assert.throws(() => finalizeDelivery(proj, task), /receiptRefs/, '点名缺失节');
    assert.equal(existsSync(reportPath(proj, task, 'delivery-final.json')), false,
      '最终报告不得落地（停留 partial）');
  });
});

describe('DeliveryFinalizeTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-dr-fin-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_happy_path_finalize：完整链 finalize 落 complete', () => {
    chainToGate(proj);
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
    assert.ok(existsSync(reportPath(proj, '内部任务-1', 'delivery-final.json')));
  });

  test('test_finalize_without_gate_receipt_rejected：无 gate 凭据拒绝', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(), changeScope: ['src/**'], receiptRefs: [v.receiptId, c.receiptId],
    });
    assert.throws(() => finalizeDelivery(proj, '内部任务-1'));
  });

  test('test_finalize_after_source_change_rejected：gate 后源码变化拒绝（revision 诊断）', () => {
    chainToGate(proj);
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8'); // gate 后源码变化
    assert.throws(() => finalizeDelivery(proj, '内部任务-1'), /revision/i);
  });

  test('test_finalize_plan_binding_mismatch_gets_pointed_message：仅 plan 桶口径不一致给专诊', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: ['src/**'],
      receiptRefs: [v.receiptId, c.receiptId],
      specImpact: '规格条款演进',
    });
    const draft = reportPath(proj, '内部任务-1', 'delivery-draft.json');
    const forged = computeRevisionSet(proj); // 与链同口径（未绑计划）
    forged.plan = { path: '内部计划', sha256: `sha256:${'0'.repeat(64)}` }; // 仅 plan 桶不同
    issueGateReceipt(proj, '内部任务-1', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId, revision: forged,
    });
    let message = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { message = e.message; }
    assert.notEqual(message, null, '期望抛错但未抛');
    assert.match(message, /计划绑定口径不一致/);
    assert.match(message, /--plan/);
    assert.doesNotMatch(message, /源码\/规格\/计划已变化/);
  });

  test('test_finalize_full_revision_mismatch_keeps_original_message：三桶全不等维持原文案', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: ['src/**'],
      receiptRefs: [v.receiptId, c.receiptId],
      specImpact: '规格条款演进',
    });
    const draft = reportPath(proj, '内部任务-1', 'delivery-draft.json');
    // 不改工作树（否则 v/c 先与当前不一致、链层先失败）——伪造 gate 三桶均与当前不同，
    // 直达 finalize 第四消费点的 generic 分支。
    const forged = computeRevisionSet(proj);
    forged.source.worktreeHash = `sha256:${'0'.repeat(64)}`;
    forged.spec.suiteHash = `sha256:${'0'.repeat(64)}`;
    forged.plan = { path: '内部计划', sha256: `sha256:${'0'.repeat(64)}` };
    issueGateReceipt(proj, '内部任务-1', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId, revision: forged,
    });
    let message = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { message = e.message; }
    assert.notEqual(message, null, '期望抛错但未抛');
    assert.match(message, /源码\/规格\/计划已变化/);
    assert.doesNotMatch(message, /凭据链校验失败/, '须由 finalize 第四消费点判因，而非链层拦截');
  });

  test('test_finalize_with_failed_gate_rejected：gate 未通过拒绝 finalize（永久面，原仅 parity 覆盖）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(), changeScope: ['src/**'], receiptRefs: [v.receiptId, c.receiptId],
    });
    issueGateReceipt(proj, '内部任务-1', v.receiptId, reportPath(proj, '内部任务-1', 'delivery-draft.json'), {
      blockingCount: 3, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    let message = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { message = e.message; }
    assert.notEqual(message, null, '期望抛错但未抛');
    assert.match(message, /blockingCount=3/);
    assert.match(message, /不得 finalize/);
  });

  test('test_finalize_rejects_non_string_chain_profile：数组 chainProfile 不得被 String() 归一为合法值', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(), changeScope: ['src/**'], receiptRefs: [v.receiptId, c.receiptId],
    });
    const gate = issueGateReceipt(proj, '内部任务-1', v.receiptId,
      reportPath(proj, '内部任务-1', 'delivery-draft.json'), {
        blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
      });
    // 损坏凭据形态：chainProfile 为非字符串数组——Python str(['deliverable']) 为非法链形态，
    // JS 亦须拒绝（String() 会把它拼成合法值，故用 pyStr 语义并重算完整性以过完整性闸）。
    const gateFile = join(proj, '.sdd', 'receipts', '内部任务-1', `${gate.receiptId}.json`);
    const payload = JSON.parse(readFileSync(gateFile, 'utf8'));
    payload.chainProfile = ['deliverable'];
    payload.integritySha256 = integrity(payload);
    writeFileSync(gateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    let message = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { message = e.message; }
    assert.notEqual(message, null, '期望抛错但未抛');
    assert.match(message, /非法链形态/);
  });

  test('test_finalize_with_stale_draft_rejected：gate 后草案被改拒绝（draft 哈希失配）', () => {
    const draft = chainToGate(proj);
    writeFileSync(draft, '{"finalStatus": "partial", "injected": true}', 'utf8');
    assert.throws(() => finalizeDelivery(proj, '内部任务-1'), /draft/i);
  });

  test('test_scout_repro_finalize_keeps_profile：scout-repro 档位不得在报告层提升', () => {
    const v = issueVerificationReceipt(proj, '内部任务-2', evidence(proj), {
      profile: 'scout-repro',
      scout: { mode: 'explore', disposition: '归档' },
    });
    const c = issueCodeReviewReceipt(proj, '内部任务-2', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-2', 3),
    });
    const scoutApp = {
      sdd: { conclusion: 'lightweight', reason: 'scout 探路档免规格先行' },
      ddd: { conclusion: 'not-applicable', reason: '一次性交付物无领域建模' },
      tdd: { conclusion: 'characterization-first', reason: 'scout-repro 档证据标准' },
    };
    prepareDelivery(proj, '内部任务-2', {
      applicability: scoutApp,
      changeScope: ['src/**'],
      receiptRefs: [v.receiptId, c.receiptId],
      specImpact: '探路一次性交付物，规格影响归档处置',
    });
    const draft = reportPath(proj, '内部任务-2', 'delivery-draft.json');
    issueGateReceipt(proj, '内部任务-2', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    const final = finalizeDelivery(proj, '内部任务-2');
    assert.equal(final.evidenceProfile, 'scout-repro', '档位不得在报告层被提升为 full');
  });
});

describe('FinalizeLedgerConvergenceTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-dr-ledger-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  function ledger() {
    return JSON.parse(readFileSync(join(proj, '.sdd', 'ledger.json'), 'utf8'));
  }

  test('test_finalize_upserts_converged_entry：finalize 后台账恰一条 converged 条目', () => {
    chainToGate(proj, '内部任务-1');
    finalizeDelivery(proj, '内部任务-1');
    const entries = ledger().tasks.filter((t) => t.id === '内部任务-1');
    assert.equal(entries.length, 1, 'finalize 后台账须恰有一条本任务条目');
    const e = entries[0];
    assert.equal(e.status, 'converged');
    assert.equal(e.finalStatus, 'complete');
    assert.equal(e.gateReportRef, '内部治理状态');
    for (const f of ['id', 'title', 'status', 'createdAt']) { // RULE-LEDGER-001 必填四字段
      assert.ok(e[f], `缺必填字段 ${f}`);
    }
  });

  test('test_finalize_converges_existing_entry_in_place：既有 active 条目原位收敛', () => {
    const ledgerPath = join(proj, '.sdd', 'ledger.json');
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({ tasks: [
      {
        id: '内部任务-1', title: '租约族缺陷批次', status: 'active', createdAt: '2026-09-16T00:00:00',
      },
    ] }), 'utf8');
    chainToGate(proj, '内部任务-1');
    finalizeDelivery(proj, '内部任务-1');
    const entries = ledger().tasks.filter((t) => t.id === '内部任务-1');
    assert.equal(entries.length, 1, '既有条目原位收敛，不得追加重复');
    assert.equal(entries[0].title, '租约族缺陷批次', '既有 title 保留');
    assert.equal(entries[0].createdAt, '2026-09-16T00:00:00', '既有 createdAt 保留');
    assert.equal(entries[0].status, 'converged');
    assert.equal(entries[0].gateReportRef, '内部治理状态');
  });

  test('test_upsert_idempotent_no_duplicate_append：重复 upsert 幂等不重复 append', () => {
    chainToGate(proj, '内部任务-1');
    const final = finalizeDelivery(proj, '内部任务-1');
    _testHooks.upsertLedgerConverged(proj, final); // 重复 upsert：读侧幂等，不重复 append
    const entries = ledger().tasks.filter((t) => t.id === '内部任务-1');
    assert.equal(entries.length, 1, '幂等 upsert 不得产生重复条目');
  });

  test('test_corrupt_ledger_loud_failure：台账损坏响亮失败并指引重跑', () => {
    const ledgerPath = join(proj, '.sdd', 'ledger.json');
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(ledgerPath, '{ not json', 'utf8');
    chainToGate(proj, '内部任务-1');
    assert.throws(() => finalizeDelivery(proj, '内部任务-1'), /台账/,
      '台账损坏须响亮失败并指引重跑（不得静默吞掉收敛义务）');
  });

  test('D03（内部任务-241）：台账锁被占用 → finalize 响亮失败且不写', () => {
    chainToGate(proj, '内部任务-1');
    const lockPath = join(proj, '.sdd', 'ledger.lock');
    assert.equal(acquireLock(lockPath, { owner: 'holder' }).ok, true);
    try {
      assert.throws(() => finalizeDelivery(proj, '内部任务-1'), /台账被并发占用/);
    } finally {
      releaseLock(lockPath, 'holder');
    }
  });
});

describe('OperationChainFinalizeTest', () => {
  let tmp;
  let proj;
  let v;
  let o;
  beforeEach(() => {
    tmp = tmpRoot('dev91-dr-op-');
    proj = project(tmp);
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(join(proj, '.sdd', 'suite.json'), '{"documents": []}\n', 'utf8');
    mkdirSync(join(proj, 'ops'));
    writeFileSync(join(proj, 'ops', 'record.md'), '# 记录\n', 'utf8');
    v = issueVerificationReceipt(proj, '内部任务-1', [{ path: 'x', sha256: 'y', exitCode: 0 }]);
    o = issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机装机',
      authorizationScope: '四插件装机',
      verificationCriteria: [{ criterion: '对拍 0 差异', evidenceRef: 'layout.log' }],
      rollback: '恢复备份',
      effectiveBoundary: '新会话生效',
      recordRef: {
        path: 'ops/record.md',
        sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'record.md')))}`,
      },
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [v.receiptId, o.receiptId],
      specImpact: '操作链批次规格投影（内部决策-023）',
    });
  });
  afterEach(() => { cleanup(tmp); });

  test('test_finalize_operation_chain_completes：操作链 finalize 落地且台账照常收敛', () => {
    const report = runGateOperation(proj, '内部任务-1');
    assert.equal(report.blockingCount, 0);
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
    assert.equal(final.evidenceProfile, 'full');
    const ledger = JSON.parse(readFileSync(join(proj, '.sdd', 'ledger.json'), 'utf8'));
    const entries = ledger.tasks.filter((t) => t.id === '内部任务-1');
    assert.equal(entries.length, 1, '操作链 finalize 后台账须恰有一条本任务条目');
    assert.equal(entries[0].status, 'converged');
  });

  test('test_finalize_after_operation_receipt_deleted_is_value_error：gate 自述链而 operation 被删 ⇒ 链校验失败', () => {
    const report = runGateOperation(proj, '内部任务-1');
    assert.equal(report.blockingCount, 0);
    const opFiles = readdirSync(join(proj, '.sdd', 'receipts', '内部任务-1'))
      .filter((n) => n.startsWith('operation-') && n.endsWith('.json'));
    assert.equal(opFiles.length, 1);
    rmSync(join(proj, '.sdd', 'receipts', '内部任务-1', opFiles[0]));
    let error = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { error = e; }
    assert.notEqual(error, null, '期望抛错但未抛');
    assert.match(error.message, /凭据链校验失败/);
    assert.equal(error instanceof ChainProfileError, false,
      '不得以 ChainProfileError 冒充工具错误（内容失败通道）');
  });

  test('test_finalize_rejects_l1_gate_with_clear_guidance：L1 完成标记即 gate 本身，显式拒绝', () => {
    // 清掉 L2 夹具凭据，改立 L1 链（latestReceipt 取序号最大者=L1）
    for (const name of readdirSync(join(proj, '.sdd', 'receipts', '内部任务-1'))) {
      if (name.startsWith('operation-') && name.endsWith('.json')) {
        rmSync(join(proj, '.sdd', 'receipts', '内部任务-1', name));
      }
    }
    issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机缓存对齐',
      authorizationScope: '本机缓存',
      verificationCriteria: [{
        criterion: '记录存在',
        evidenceRef: 'r',
        probe: { type: 'file-exists', path: { base: 'project', rel: 'ops/record.md' } },
      }],
      rollback: '恢复备份',
      effectiveBoundary: '仅本机',
      recordRef: {
        path: 'ops/record.md',
        sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'record.md')))}`,
      },
      riskLevel: 'L1',
    });
    const report = runGateOperation(proj, '内部任务-1', { l1: true });
    assert.equal(report.blockingCount, 0);
    const gateRec = latestReceipt(proj, '内部任务-1', 'gate');
    assert.equal(gateRec.riskLevel, 'L1');
    let message = null;
    try { finalizeDelivery(proj, '内部任务-1'); } catch (e) { message = e.message; }
    assert.notEqual(message, null, '期望抛错但未抛');
    assert.match(message, /L1/);
    assert.match(message, /无需/);
  });
});

describe('DeliverableChainFinalizeTest', () => {
  // 制品链（三环：verification → code-review(deliverable) → operation）永久回归面；
  // 原仅 parity ④ 覆盖，阶段 3 拆除窗口件后由此承接。
  let tmp;
  let proj;
  beforeEach(() => {
    tmp = tmpRoot('dev91-dr-dlv-');
    proj = project(tmp);
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(join(proj, '.sdd', 'suite.json'), '{"documents": []}\n', 'utf8');
    mkdirSync(join(proj, 'ops'));
    writeFileSync(join(proj, 'ops', 'record.md'), '# 操作记录\n', 'utf8');
  });
  afterEach(() => { cleanup(tmp); });

  test('test_finalize_deliverable_chain_completes：三环制品链 finalize 落地且台账收敛', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '制品评审', {
      reviewInstances: 1, reviewMode: 'deliverable',
      reviewRound: 1, reviewProvenance: prov('内部任务-1', 1),
    });
    const o = issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：制作 PPT 交付制品',
      authorizationScope: '忽略面制品生成',
      verificationCriteria: [{ criterion: '制品在案', evidenceRef: 'out.pptx' }],
      rollback: '删除制品',
      effectiveBoundary: '本机忽略面',
      recordRef: {
        path: 'ops/record.md',
        sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'record.md')))}`,
      },
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [v.receiptId, c.receiptId, o.receiptId],
      specImpact: '制品链批次规格投影（内部决策-023 修正案 2）',
    });
    issueGateReceipt(proj, '内部任务-1', v.receiptId, reportPath(proj, '内部任务-1', 'delivery-draft.json'), {
      blockingCount: 0,
      warningCount: 0,
      codeReviewReceiptId: c.receiptId,
      operationReceiptId: o.receiptId,
    });
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
    const ledger = JSON.parse(readFileSync(join(proj, '.sdd', 'ledger.json'), 'utf8'));
    const entries = ledger.tasks.filter((t) => t.id === '内部任务-1');
    assert.equal(entries.length, 1, '制品链 finalize 后台账须恰有一条本任务条目');
    assert.equal(entries[0].status, 'converged');
  });

  test('A8 2.1.0 deliverable 三环 finalize 端到端（reviewRing 在场、无 REVIEWPROV-LEGACY）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '制品评审', {
      reviewInstances: 1, reviewMode: 'deliverable',
      reviewRound: 1, reviewProvenance: prov('内部任务-1', 1),
    });
    assert.equal(c.schemaVersion, '2.1.0', '带 provenance 的评审环凭据为 2.1.0');
    const o = issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：制作 PPT 交付制品',
      authorizationScope: '忽略面制品生成',
      verificationCriteria: [{ criterion: '制品在案', evidenceRef: 'out.pptx' }],
      rollback: '删除制品',
      effectiveBoundary: '本机忽略面',
      recordRef: {
        path: 'ops/record.md',
        sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'record.md')))}`,
      },
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [v.receiptId, c.receiptId, o.receiptId],
      specImpact: '制品链批次规格投影（内部决策-023 修正案 2）',
    });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'deliverable' });
    assert.equal(report.blockingCount, 0, JSON.stringify(report.diagnostics));
    assert.equal(report.sections.receipts.reviewRing.mode, 'deliverable', '评审环投影在场');
    assert.equal(report.sections.receipts.reviewRing.receiptId, c.receiptId);
    assert.equal(
      report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-REVIEWPROV-LEGACY').length,
      0,
      '2.1.0 评审环不得出现 legacy provenance warning',
    );
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
    assert.equal(final.schemaVersion, '2.1.0', '最终报告继承草案 schemaVersion');
    assert.equal(final.gateReceipt, latestReceipt(proj, '内部任务-1', 'gate').receiptId);
  });
});

describe('ChainHeadEquivalenceTest', () => {
  // 2.2.1 从 test_receipts.py `ChainHeadEquivalenceTest` 移入的两例（避免 2.2 依赖本模块）；
  // 类名与 Python 一致——该类其余 5 例仍在 receipts.test.mjs（2.2 拆批承载）。
  let tmp;
  let proj;
  beforeEach(() => {
    tmp = tmpRoot('dev91-dr-head-');
    proj = makeGitProject(tmp);
    evidence(proj); // 证据文件随初始提交纳入（消费仓形态：签发时刻树是干净的）
    commitAll(proj, 'init evidence');
  });
  afterEach(() => { cleanup(tmp); });

  /** 连签 verification + code-review（内部任务-40）。 */
  function chain() {
    const v = issueVerificationReceipt(proj, '内部任务-40', evidence(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-40', v.receiptId, '三维通过', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-40', 3),
    });
  }

  /** 手写 finalize 用草案（对齐 Python 用例内联字典，键序一致）。 */
  function writeDraft() {
    const draft = reportPath(proj, '内部任务-40', 'delivery-draft.json');
    mkdirSync(join(proj, '.sdd', 'reports', '内部任务-40'), { recursive: true });
    writeFileSync(draft, JSON.stringify({
      taskId: '内部任务-40',
      finalStatus: 'partial',
      applicability: {
        sdd: { conclusion: 'required', reason: '接口契约面' },
        ddd: { conclusion: 'not-applicable', reason: '无领域语义变化' },
        tdd: { conclusion: 'strict', reason: '可复现缺陷' },
      },
      receiptRefs: [{
        path: '内部治理状态',
        sha256: `sha256:${'0'.repeat(64)}`,
        kind: 'receipt-chain',
      }],
      specImpact: '是',
    }), 'utf8');
    return draft;
  }

  test('test_finalize_accepts_head_shift：gate 后提交运行态产物仍可 finalize', () => {
    chain();
    const draft = writeDraft();
    const v = latestReceipt(proj, '内部任务-40', 'verification');
    const c = latestReceipt(proj, '内部任务-40', 'code-review');
    const gate = issueGateReceipt(proj, '内部任务-40', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    assert.equal(gate.status, 'passed');
    commitAll(proj, 'chore(receipts): 提交 gate 凭据');
    const final = finalizeDelivery(proj, '内部任务-40');
    assert.equal(final.taskId, '内部任务-40');
  });

  test('test_finalize_rejects_gate_head_unverifiable：head 不可证 ⇒ 第四消费点拒绝 finalize', () => {
    chain();
    const draft = writeDraft();
    const v = latestReceipt(proj, '内部任务-40', 'verification');
    const c = latestReceipt(proj, '内部任务-40', 'code-review');
    const gate = issueGateReceipt(proj, '内部任务-40', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    // 篡改 gate 凭据的 head 为仓内不存在 sha，并按凭据口径重算完整性哈希（模拟 legacy/坏形态）
    const path = join(proj, '.sdd', 'receipts', '内部任务-40', `${gate.receiptId}.json`);
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    payload.revision.sourceRevision.head = '0'.repeat(40);
    payload.integritySha256 = integrity(payload);
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    assert.throws(() => finalizeDelivery(proj, '内部任务-40'), /提交可达性无法证明/);
  });
});
