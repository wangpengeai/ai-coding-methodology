// 文件：receipts.test.mjs
// 描述：receipts.py 实现（唯一实现；迁移史见 内部决策-051）单测（内部决策-051 运行时归一·阶段2 凭据链 2.2；永久件）——逐方法移植
//       spec-gate/assurance/tests/test_receipts.py 的 72 方法（74 减 `ChainHeadEquivalenceTest`
//       中调用 finalize_delivery 的两例——它们随 2.3 的 delivery_reports.mjs 迁移，避免本批
//       依赖尚不存在的模块）：ReceiptIssueTest/ReceiptChainTest/StageReceiptTest/
//       CurrentRevisionBindingTest/PlanBoundChainTest/OperationReceiptTest/ReceiptExemptTest/
//       ChainHeadEquivalenceTest（5 例）/ReceiptDeliverableTest；类名/断言/夹具逐字对应。
//       另加 JS 专属五例：`opts.now` 注入（固定时间戳落盘）、归档分支（archive.mjs
//       `manifestIds` 命中 ⇒ 归档态诊断，fail-open 不改变「无凭据」语义）、非目录任务目录
//       （ENOTDIR 按无凭据 fail-open）、undefined 授权引文拒绝、`..` recordRef 越界拒绝；
//       另加冻结凭据夹具永久跨读（内部任务-36/78/86——阶段3 拆窗口件后仍消费夹具）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChainProfileError, countReviewReceipts, integrity, issueCodeReviewReceipt, issueGateReceipt,
  issueInspectionReceipt, issueOperationReceipt, issueVerificationReceipt, latestReceipt,
  normalizeReviewRound, reviewProvenanceStatusOf, verifyReceiptChain, verifyReceiptFile,
} from '../receipts.mjs';
import { sha256Hex } from '../common.mjs';
import { acquireLock, releaseLock } from '../lock.mjs';
import { commitAll, git, gitRaw, makeGitProject } from './git-fixtures.mjs';
import { prov } from './provenance-fixtures.mjs';

/** POSIX 专属用例（win32 文件系统/索引对非 UTF-8 原始字节形态不可靠）。 */
const posixOnly = process.platform === 'win32' ? test.skip : test;

/** 冻结凭据夹具根（内部任务-36/78/86；README 逐文件 sha256）。 */
const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'receipts');

/** 读 gate 收据自述的 chainProfile（夹具形态锁定用）。 */
function gateChainProfile(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith('gate-') || !name.endsWith('.json')) continue;
    const payload = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    return payload.chainProfile ?? null;
  }
  return null;
}

/** tmp 夹具根（每个用例自建自清，零真机触达）。 */
function tmpRoot(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

/** 递归清理（Windows 锁文件重试；force 容忍已删除）。 */
function cleanup(root) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }

/** 最小无 git 项目：src 一文件（对齐 test_receipts.py `_project`）。 */
function project(base) {
  const proj = join(base, 'p');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
  return proj;
}

/** 构造一条命令证据引用（路径 + 哈希 + 退出码；对齐 `_evidence`）。 */
function evidence(proj) {
  const ev = join(proj, 'src', 'ev.txt');
  writeFileSync(ev, 'ok\n', 'utf8');
  return [{ path: 'src/ev.txt', sha256: `sha256:${sha256Hex(Buffer.from('ok\n', 'utf8'))}`, exitCode: 0 }];
}

/** 读一份凭据 JSON（测试断言用）。 */
function readReceipt(proj, taskId, receiptId) {
  return JSON.parse(readFileSync(join(proj, '.sdd', 'receipts', taskId, `${receiptId}.json`), 'utf8'));
}

/** 按凭据口径重写一份 JSON（legacy/篡改用例；不改变 key 插入顺序）。 */
function writeReceipt(proj, taskId, receiptId, payload) {
  writeFileSync(
    join(proj, '.sdd', 'receipts', taskId, `${receiptId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

describe('ReceiptIssueTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-rcpt-issue-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_issue_verification_receipt_full：full 档签发、落盘且完整性自校验通过', () => {
    const r = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    assert.equal(r.kind, 'verification');
    assert.equal(r.evidenceProfile, 'full');
    assert.equal(r.status, 'passed');
    const dir = join(proj, '.sdd', 'receipts', '内部任务-1');
    const files = readdirSync(dir).filter((n) => n.startsWith('verification-') && n.endsWith('.json'));
    assert.equal(files.length, 1);
    const [ok, reason] = verifyReceiptFile(join(dir, files[0]));
    assert.ok(ok, reason);
  });

  test('test_issue_verification_empty_evidence_refused：内部任务-41 #4 零证据以 ValueError 拒签', () => {
    assert.throws(
      () => issueVerificationReceipt(proj, '内部任务-1', [], { profile: 'full' }),
      /零证据/,
    );
  });

  test('test_tampered_receipt_fails_integrity：篡改 status 后完整性哈希失配', () => {
    const r = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const f = join(proj, '.sdd', 'receipts', '内部任务-1', `${r.receiptId}.json`);
    const data = JSON.parse(readFileSync(f, 'utf8'));
    data.status = 'tampered';
    writeFileSync(f, JSON.stringify(data), 'utf8');
    const [ok, reason] = verifyReceiptFile(f);
    assert.equal(ok, false);
    assert.match(reason, /完整性/);
  });

  test('test_scout_repro_profile_preserved：scout-repro 档位与 mode/disposition 保留', () => {
    const r = issueVerificationReceipt(proj, '内部任务-2', evidence(proj), {
      profile: 'scout-repro',
      scout: { mode: 'explore', disposition: '归档不并入主干' },
    });
    assert.equal(r.evidenceProfile, 'scout-repro');
    assert.equal(r.scout.mode, 'explore');
  });

  test('test_invalid_profile_rejected：非法证据档位拒签', () => {
    assert.throws(() => issueVerificationReceipt(proj, '内部任务-3', evidence(proj), { profile: 'super' }));
  });
});

describe('ReceiptChainTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-rcpt-chain-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  /** 连签 verification + code-review（对齐 `_full_chain`）。 */
  function fullChain() {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '三维通过', { reviewInstances: 3 });
    return [v, c];
  }

  test('test_code_review_with_matching_verification：code-review 引用同任务 verification', () => {
    const [v, c] = fullChain();
    assert.equal(c.kind, 'code-review');
    assert.equal(c.verificationReceipt, v.receiptId);
  });

  test('test_code_review_with_unknown_verification_rejected：未知 verification ID 拒签', () => {
    assert.throws(() => issueCodeReviewReceipt(
      proj, '内部任务-1', 'verification-内部任务-1-999', 'x', { reviewInstances: 3 },
    ));
  });

  test('test_source_change_invalidates_chain：源码变化使链失效', () => {
    fullChain();
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false);
    assert.match(reason.toLowerCase(), /revision/);
  });

  test('test_chain_valid_when_unchanged：未变化链闭合', () => {
    fullChain();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.ok(ok, reason);
  });

  test('test_inspection_only_never_satisfies_review：inspection-only 不入完成链', () => {
    const insp = issueInspectionReceipt(proj, '内部任务-9', '用户点名审计');
    assert.equal(insp.kind, 'inspection-only');
    assert.throws(() => issueCodeReviewReceipt(
      proj, '内部任务-9', insp.receiptId, 'x', { reviewInstances: 3 },
    ));
    const [ok] = verifyReceiptChain(proj, '内部任务-9');
    assert.equal(ok, false);
  });

  test('test_wrong_task_chain_rejected：他任务号无凭据即红', () => {
    fullChain();
    const [ok] = verifyReceiptChain(proj, '内部任务-2');
    assert.equal(ok, false);
  });

  test('test_non_directory_task_dir_treated_as_no_receipts：任务目录为普通文件→无凭据不抛异常', () => {
    mkdirSync(join(proj, '.sdd', 'receipts'), { recursive: true });
    writeFileSync(join(proj, '.sdd', 'receipts', '内部任务-9'), 'x', 'utf8');
    assert.equal(latestReceipt(proj, '内部任务-9', 'verification'), null);
    assert.equal(countReviewReceipts(proj, '内部任务-9'), 0);
    const [ok] = verifyReceiptChain(proj, '内部任务-9');
    assert.equal(ok, false, '非目录形态按无凭据（不抛 ENOTDIR）');
  });

  test('test_gate_receipt_issuance_and_binding：gate 绑定 verification/code-review/draft 哈希', () => {
    const [v, c] = fullChain();
    const draft = join(proj, '.sdd', 'reports', '内部任务-1', 'delivery-draft.json');
    mkdirSync(join(draft, '..'), { recursive: true });
    writeFileSync(draft, '{"finalStatus": "partial"}', 'utf8');
    const g = issueGateReceipt(proj, '内部任务-1', v.receiptId, draft, {
      blockingCount: 0, warningCount: 0, codeReviewReceiptId: c.receiptId,
    });
    assert.equal(g.kind, 'gate');
    assert.equal(g.status, 'passed');
    assert.ok(Object.prototype.hasOwnProperty.call(g, 'draftSha256'));
  });
});

describe('StageReceiptTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-rcpt-stage-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_stage_receipt_issued_without_verification：阶段评审可在 verification 之前签发', () => {
    const stage = issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 2 复审', {
      reviewInstances: 2, stage: '2',
    });
    assert.equal(stage.receiptId, 'code-review-内部任务-1-s2');
    assert.equal(stage.kind, 'code-review');
    assert.equal(stage.stageReceipt, true, '阶段凭据须带机械标记');
    assert.equal(stage.stage, '2');
    assert.ok(existsSync(join(proj, '.sdd', 'receipts', '内部任务-1', 'code-review-内部任务-1-s2.json')));
  });

  test('test_stage_receipt_not_selected_as_latest：完成链第二环不被阶段凭据顶替', () => {
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 2 复审', { reviewInstances: 2, stage: '2' });
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const finalReceipt = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '收尾三维评审', { reviewInstances: 3 });
    const latest = latestReceipt(proj, '内部任务-1', 'code-review');
    assert.notEqual(latest, null);
    assert.equal(latest.receiptId, finalReceipt.receiptId, '收尾评审须是链上的第二环');
  });

  test('test_stage_receipt_counted_in_review_count：评审覆盖分子包含阶段凭据', () => {
    assert.equal(countReviewReceipts(proj, '内部任务-1'), 0);
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 1 复审', { reviewInstances: 2, stage: '1' });
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 2 复审', { reviewInstances: 2, stage: '2' });
    assert.equal(countReviewReceipts(proj, '内部任务-1'), 2);
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false, '阶段凭据不构成完成链');
    assert.match(reason, /不完整/);
  });

  test('test_stage_id_sanitized：stage 进文件名的路径逃逸标识必须被拒', () => {
    for (const bad of ['../../evil', 'a/b', '..', '', 'x'.repeat(17), 's 2']) {
      assert.throws(
        () => issueCodeReviewReceipt(proj, '内部任务-1', null, 'x', { reviewInstances: 1, stage: bad }),
        Error,
        `非法 stage 须被拒：${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('CurrentRevisionBindingTest', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-rcpt-binding-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('test_stale_verification_blocks_code_review：源码变化后 code-review 受理拒绝', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8');
    assert.throws(
      () => issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 'x', { reviewInstances: 3 }),
      (e) => /revision/i.test(e.message),
    );
  });

  test('test_stale_verification_message_has_reissue_guidance：FB-3 重签指引可照抄', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 3\n', 'utf8');
    assert.throws(
      () => issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 'x', { reviewInstances: 3 }),
      (e) => {
        assert.match(e.message, /issue-verification/, '报错给出重签命令形态');
        assert.match(e.message, /cli\.mjs/, 'JS 入口重签指引指向 cli.mjs（阶段3a 起命令面为 node；原 Python 实现（迁移史见 内部决策-051） cli.py 保留至 3b）');
        assert.match(e.message, /内部任务-1/, '指引含同任务号，可直接照抄');
        return true;
      },
    );
  });
});

describe('PlanBoundChainTest', () => {
  let tmp;
  let proj;
  let plan;
  beforeEach(() => {
    tmp = tmpRoot('dev91-rcpt-plan-');
    proj = project(tmp);
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    plan = join(proj, 'docs', 'plans', 'f.md');
    writeFileSync(plan, '---\nspecRefs: [内部需求-1]\n---\n# f\n', 'utf8');
  });
  afterEach(() => { cleanup(tmp); });

  function chain() {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full', planPath: plan });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { planPath: plan, reviewInstances: 3 });
  }

  test('test_plan_bound_chain_validates_and_invalidates_on_edit：计划改一字使链失效', () => {
    chain();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.ok(ok, reason);
    writeFileSync(plan, '---\nspecRefs: [内部需求-1]\n---\n# f 改\n', 'utf8');
    const [ok2] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok2, false, '计划改一字必须使链失效');
  });

  test('test_bound_plan_deleted_returns_named_invalidation：内部未决-109 具名失效', () => {
    chain();
    rmSync(plan);
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false, '计划被删必须判链失效');
    assert.match(reason, /链绑定计划不可读\/已删除/);
  });

  test('test_external_plan_mismatch_rejected：外部计划与绑定计划不一致必须拒绝', () => {
    chain();
    const other = join(proj, 'docs', 'plans', 'other.md');
    writeFileSync(other, '# other\n', 'utf8');
    const [ok] = verifyReceiptChain(proj, '内部任务-1', { planPath: other });
    assert.equal(ok, false, '外部计划与链绑定计划不一致必须拒绝');
  });
});

describe('OperationReceiptTest', () => {
  let tmp;
  let proj;
  let recordRef;
  let criteria;
  let v;
  beforeEach(() => {
    tmp = tmpRoot('dev91-rcpt-op-');
    proj = project(tmp);
    mkdirSync(join(proj, 'ops'));
    writeFileSync(join(proj, 'ops', 'install-record.md'), '# 操作记录\n', 'utf8');
    recordRef = {
      path: 'ops/install-record.md',
      sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'install-record.md')))}`,
    };
    criteria = [{ criterion: '三处对拍 0 差异', evidenceRef: 'install-layout.log' }];
    v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj));
  });
  afterEach(() => { cleanup(tmp); });

  function issue(overrides = {}) {
    const { verificationReceiptId = v.receiptId, ...rest } = overrides;
    return issueOperationReceipt(proj, '内部任务-1', verificationReceiptId, {
      authorizationQuote: '用户当轮指令：从项目安装最新版插件',
      authorizationScope: '四插件 0.3.3 本机装机',
      verificationCriteria: criteria,
      rollback: 'cp 回滚点备份恢复 installed_plugins.json',
      effectiveBoundary: '新会话加载 0.3.3；运行中会话保留旧版',
      recordRef,
      ...rest,
    });
  }

  test('test_operation_issued_with_valid_inputs：合法输入签发且完整性通过', () => {
    const rec = issue();
    assert.equal(rec.kind, 'operation');
    assert.equal(rec.status, 'passed');
    assert.equal(rec.verificationReceipt, v.receiptId);
    assert.equal(rec.authorization.quote, '用户当轮指令：从项目安装最新版插件');
    assert.deepEqual(rec.recordRef, recordRef);
    const [ok] = verifyReceiptFile(
      join(proj, '.sdd', 'receipts', '内部任务-1', `${rec.receiptId}.json`),
    );
    assert.ok(ok);
  });

  test('test_operation_rejects_short_quote：授权引文 <8 字拒绝', () => {
    assert.throws(() => issue({ authorizationQuote: '装' }));
  });

  test('test_operation_rejects_undefined_quote：缺省/非字符串引文拒绝（防 String(undefined) 冒充 8 字）', () => {
    assert.throws(() => issue({ authorizationQuote: undefined }));
    assert.throws(() => issue({ authorizationQuote: 12345678 }));
  });

  test('test_operation_rejects_dotdot_record_ref：recordRef 含 .. 段拒绝（防 symlink+.. 越界）', () => {
    assert.throws(() => issue({ recordRef: { ...recordRef, path: 'ops/../ops/install-record.md' } }));
  });

  test('test_operation_rejects_empty_scope：空授权范围拒绝', () => {
    assert.throws(() => issue({ authorizationScope: '  ' }));
  });

  test('test_operation_rejects_empty_criteria：空验证判据拒绝', () => {
    assert.throws(() => issue({ verificationCriteria: [] }));
  });

  test('test_operation_rejects_criteria_item_missing_fields：判据项缺字段拒绝', () => {
    assert.throws(() => issue({ verificationCriteria: [{ criterion: '只有判据' }] }));
  });

  test('test_operation_rejects_empty_rollback_or_boundary：空回滚/生效边界均拒绝', () => {
    assert.throws(() => issue({ rollback: '' }));
    assert.throws(() => issue({ effectiveBoundary: '' }));
  });

  test('test_operation_requires_existing_record_file：操作记录文件须真实存在', () => {
    assert.throws(() => issue({ recordRef: { path: 'ops/none.md', sha256: recordRef.sha256 } }));
  });

  test('test_operation_rejects_out_of_root_record：绝对/越界记录路径拒绝', () => {
    assert.throws(() => issue({ recordRef: { path: '/etc/hosts', sha256: recordRef.sha256 } }));
    const outside = join(proj, '..', 'outside.md');
    writeFileSync(outside, '越界\n', 'utf8');
    assert.throws(() => issue({
      recordRef: { path: '../outside.md', sha256: `sha256:${sha256Hex(readFileSync(outside))}` },
    }));
  });

  test('test_operation_inherits_bound_plan_from_verification：计划口径自述继承', () => {
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    const plan = join(proj, 'docs', 'plans', 'op.md');
    writeFileSync(plan, '---\nspecRefs: [内部需求-15]\n---\n# op\n', 'utf8');
    const v2 = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { planPath: plan });
    const rec = issueOperationReceipt(proj, '内部任务-1', v2.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机装机',
      authorizationScope: '四插件装机',
      verificationCriteria: criteria,
      rollback: '恢复备份',
      effectiveBoundary: '新会话生效',
      recordRef,
    });
    assert.equal(rec.kind, 'operation');
  });

  test('test_operation_rejects_record_hash_mismatch：recordRef 哈希与实测不一致拒绝', () => {
    assert.throws(() => issue({
      recordRef: { path: 'ops/install-record.md', sha256: `sha256:${'0'.repeat(64)}` },
    }));
  });

  test('test_operation_rejects_unknown_verification：未知 verification 拒绝', () => {
    assert.throws(() => issue({ verificationReceiptId: 'verification-内部任务-1-99' }));
  });

  test('test_operation_never_satisfies_code_review：operation 不得冒充 code-review 输入', () => {
    const rec = issue();
    assert.throws(() => issueCodeReviewReceipt(proj, '内部任务-1', rec.receiptId, '冒充', { reviewInstances: 1 }));
  });

  test('test_operation_chain_valid_when_unchanged：operation 形态链闭合', () => {
    issue();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1', { chainProfile: 'operation' });
    assert.ok(ok, reason);
  });

  test('test_operation_present_without_flag_verifies_as_dev：旗标关按 dev 校验不静默放行', () => {
    issue();
    const [ok] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false);
  });

  test('test_operation_chain_flag_without_receipt_raises：声明操作链但无凭据即 ChainProfileError', () => {
    assert.throws(
      () => verifyReceiptChain(proj, '内部任务-1', { chainProfile: 'operation' }),
      ChainProfileError,
    );
  });

  test('test_mixed_chain_rejected：operation 与 code-review 并存混链拒绝', () => {
    issue();
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 1 });
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1', { chainProfile: 'operation' });
    assert.equal(ok, false);
    assert.match(reason, /混链/);
  });

  test('test_operation_chain_invalidated_by_source_change：源码变化使 operation 链失效', () => {
    issue();
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8');
    const [ok] = verifyReceiptChain(proj, '内部任务-1', { chainProfile: 'operation' });
    assert.equal(ok, false);
  });

  test('test_dev_chain_unchanged_without_operation：dev 链不受无 operation 影响', () => {
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 1 });
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.ok(ok, reason);
  });

  // ---- 内部决策-027：riskLevel 分级与 probe 形态受理（签发只验形态、执行归 gate）----

  test('test_operation_default_risk_level_is_l2：缺省高档 L2（fail-safe）', () => {
    const rec = issue();
    assert.equal(rec.riskLevel, 'L2');
  });

  test('test_operation_accepts_explicit_l1：显式 L1 受理', () => {
    const rec = issue({ riskLevel: 'L1' });
    assert.equal(rec.riskLevel, 'L1');
  });

  test('test_operation_rejects_illegal_risk_level：非法 riskLevel 拒绝', () => {
    assert.throws(() => issue({ riskLevel: 'L9' }));
  });

  test('test_operation_accepts_well_formed_probe_criteria：形态合法 probe 受理', () => {
    const crit = [{
      criterion: '双读一致',
      evidenceRef: 'install-record.md',
      probe: {
        type: 'json-field-eq',
        path: { base: 'project', rel: 'state.json' },
        field: 'version',
        expect: '0.3.9',
      },
    }];
    const rec = issue({ verificationCriteria: crit, riskLevel: 'L1' });
    assert.equal(rec.verificationCriteria[0].probe.type, 'json-field-eq');
    assert.equal(rec.riskLevel, 'L1');
  });

  test('test_operation_rejects_bad_probe_shape：非法/缺 type/缺 path/坏 base 四形态拒绝', () => {
    const badProbes = [
      { criterion: 'c', evidenceRef: 'r', probe: { type: 'exit-code', path: { base: 'project', rel: 'x' } } }, // 非法 type
      { criterion: 'c', evidenceRef: 'r', probe: { path: { base: 'project', rel: 'x' } } }, // 缺 type
      { criterion: 'c', evidenceRef: 'r', probe: { type: 'json-field-eq' } }, // 缺 path
      { criterion: 'c', evidenceRef: 'r', probe: { type: 'json-field-eq', path: { base: 'weird', rel: 'x' } } }, // 坏 base
    ];
    for (const crit of badProbes) {
      assert.throws(() => issue({ verificationCriteria: [crit] }));
    }
  });

  // ---- 内部决策-048（内部任务-11）：host-app-present 受理（第八类，无 path——audit-policy-state 先例）----

  test('test_operation_accepts_host_app_present_without_path：无 path 合法受理', () => {
    const crit = [{
      criterion: '宿主 kimi 在位（宿主装机生效宣称）',
      evidenceRef: 'operation-record.md',
      probe: { type: 'host-app-present', expect: { host: 'kimi', presence: 'present' } },
    }];
    const rec = issue({ verificationCriteria: crit, riskLevel: 'L1' });
    assert.equal(rec.verificationCriteria[0].probe.type, 'host-app-present');
  });

  test('test_operation_rejects_host_app_present_bad_expect：host/presence 枚举外拒绝', () => {
    for (const expect of [
      { host: 'unknown', presence: 'present' }, // host 词表外
      { host: 'kimi', presence: 'maybe' }, // presence 词表外
      { host: 'kimi' }, // 缺 presence
      'present', // expect 非对象
    ]) {
      const crit = [{ criterion: 'c', evidenceRef: 'r', probe: { type: 'host-app-present', expect } }];
      assert.throws(() => issue({ verificationCriteria: [crit] }), Error, JSON.stringify(expect));
    }
  });

  test('test_operation_accepts_host_app_present_dsh：第四宿主 dsh 受理（内部决策-054 G-04）', () => {
    const crit = [{ criterion: '宿主 dsh 在位', evidenceRef: 'r', probe: { type: 'host-app-present', expect: { host: 'dsh', presence: 'present' } } }];
    const rec = issue({ verificationCriteria: crit, riskLevel: 'L1' });
    assert.equal(rec.verificationCriteria[0].probe.expect.host, 'dsh');
  });

  test('test_legacy_text_criteria_still_accepted：旧形态纯文本判据继续签发', () => {
    const rec = issue();
    assert.equal(Object.prototype.hasOwnProperty.call(rec.verificationCriteria[0], 'probe'), false);
  });

  // ---- 内部决策-030：模板化外部状态探针受理（v2 词表 + audit-policy-state 无 path）----

  test('test_operation_accepts_audit_policy_state_without_path：无 path 整体缺失仍受理', () => {
    const crit = [{
      criterion: '策略回无审核',
      evidenceRef: 'probe-audit-record.md',
      probe: {
        type: 'audit-policy-state',
        expect: { subcategoryGuid: '{0CCE921D-69AE-11D9-BED3-505054503030}', inclusion: 'empty' },
      },
    }];
    const rec = issue({ verificationCriteria: crit, riskLevel: 'L1' });
    assert.equal(rec.verificationCriteria[0].probe.type, 'audit-policy-state');
  });

  test('test_operation_rejects_bad_audit_policy_fields：坏 GUID/缺 inclusion/非枚举拒绝', () => {
    const badCases = [
      [{ criterion: 'c', evidenceRef: 'r',
        probe: { type: 'audit-policy-state', expect: { subcategoryGuid: 'not-a-guid', inclusion: 'empty' } } }],
      [{ criterion: 'c', evidenceRef: 'r',
        probe: { type: 'audit-policy-state', expect: { subcategoryGuid: '{0CCE921D-69AE-11D9-BED3-505054503030}' } } }],
      [{ criterion: 'c', evidenceRef: 'r',
        probe: { type: 'audit-policy-state',
          expect: { subcategoryGuid: '{0CCE921D-69AE-11D9-BED3-505054503030}', inclusion: '失败' } } }],
    ];
    for (const crit of badCases) {
      assert.throws(() => issue({ verificationCriteria: crit }));
    }
  });

  test('test_operation_accepts_acl_state_and_rejects_bad_rights：ACL 白名单受理/拒绝', () => {
    const good = [{
      criterion: 'deny ACE 在位',
      evidenceRef: 'probe-acl-record.md',
      probe: {
        type: 'acl-state',
        path: { base: 'project', rel: 'state.json' },
        expect: { denyAccount: 'X\\y', denyRights: ['WD', 'DC'] },
      },
    }];
    issue({ verificationCriteria: good });
    const badRights = [{
      criterion: 'c',
      evidenceRef: 'r',
      probe: {
        type: 'acl-state',
        path: { base: 'project', rel: 'state.json' },
        expect: { denyAccount: 'X\\y', denyRights: ['ZZ'] }, // 白名单外简码
      },
    }];
    assert.throws(() => issue({ verificationCriteria: badRights }));
  });
});

describe('ReceiptExemptTest', () => {
  let tmp;
  let proj;
  let plan;
  let vid;
  beforeEach(() => {
    tmp = tmpRoot('dev91-rcpt-exempt-');
    proj = project(tmp);
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    plan = join(proj, 'docs', 'plans', 'pure-doc.md');
    writeFileSync(plan, '---\nspecRefs: [内部需求-1]\n---\n# 纯文档计划\n', 'utf8');
    vid = issueVerificationReceipt(proj, 'TASK-E', evidence(proj), { profile: 'full' }).receiptId;
  });
  afterEach(() => { cleanup(tmp); });

  function exempt(overrides = {}) {
    const { summary = '豁免', ...rest } = overrides;
    return issueCodeReviewReceipt(proj, 'TASK-E', vid, summary, {
      planPath: plan,
      reviewInstances: 0,
      reviewMode: 'exempt',
      exemptionReason: '纯文档计划，收尾节显式豁免三维重流程（内部规则-11）',
      ...rest,
    });
  }

  test('test_exempt_issue_fields_and_chain：豁免机械字段齐备且满足完成链', () => {
    const r = exempt();
    assert.equal(r.exemptReceipt, true, '豁免机械标记在案');
    assert.equal(r.reviewInstances, 0, '豁免记 0 实例（语义=未派发）');
    assert.equal(r.reviewMode, 'exempt');
    assert.ok(r.exemptionReason);
    assert.ok(r.planRef);
    const [ok, reason] = verifyReceiptChain(proj, 'TASK-E');
    assert.ok(ok, `豁免凭据满足完成链第二环：${reason}`);
  });

  test('test_exempt_blank_reason_rejected：空豁免理由拒绝', () => {
    assert.throws(() => exempt({ exemptionReason: '  ' }));
  });

  test('test_exempt_without_plan_rejected：缺计划引用拒绝', () => {
    assert.throws(() => exempt({ planPath: null }));
  });

  test('test_exempt_nonexistent_plan_rejected：计划不存在拒绝', () => {
    assert.throws(() => exempt({ planPath: join(proj, 'docs', 'plans', 'nope.md') }));
  });

  test('test_exempt_with_stage_rejected：豁免与 stage 互斥', () => {
    assert.throws(() => exempt({ stage: 's1' }));
  });

  test('test_exemption_reason_not_for_normal_mode：普通评审带豁免理由拒绝', () => {
    assert.throws(() => issueCodeReviewReceipt(proj, 'TASK-E', vid, '普通评审', {
      reviewInstances: 3, exemptionReason: '不属于豁免形态',
    }));
  });

  test('test_exempt_after_normal_review_latest_wins：后出豁免覆盖且两档均计数', () => {
    issueCodeReviewReceipt(proj, 'TASK-E', vid, '首轮实评审', { reviewInstances: 3 });
    exempt({ summary: '改判豁免' });
    const [ok, reason] = verifyReceiptChain(proj, 'TASK-E');
    assert.ok(ok, `latest 选取豁免档，链仍闭合：${reason}`);
    assert.equal(countReviewReceipts(proj, 'TASK-E'), 2, '两档并存均计数（覆盖检查分子）');
  });
});

describe('ChainHeadEquivalenceTest', () => {
  let tmp;
  let proj;
  beforeEach(() => {
    tmp = tmpRoot('dev91-rcpt-head-');
    proj = makeGitProject(tmp);
    evidence(proj); // 证据文件随初始提纳入（消费仓形态：签发时刻树是干净的）
    commitAll(proj, 'init evidence');
  });
  afterEach(() => { cleanup(tmp); });

  /** 连签 verification + code-review（内部任务-40）。 */
  function chain() {
    const v = issueVerificationReceipt(proj, '内部任务-40', evidence(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-40', v.receiptId, '三维通过', { reviewInstances: 3 });
  }

  test('test_chain_survives_committing_own_receipts：提交签发产物后链仍 ok', () => {
    chain();
    const [okBefore, reasonBefore] = verifyReceiptChain(proj, '内部任务-40');
    assert.ok(okBefore, reasonBefore);
    commitAll(proj, 'chore(receipts): 提交签发产物');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-40');
    assert.ok(ok, `提交运行态产物不得使链失效：${reason}`);
  });

  test('test_chain_invalidated_by_source_change_after_commit：提交后源码变化必须失效', () => {
    chain();
    commitAll(proj, 'chore(receipts): 提交签发产物');
    writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
    commitAll(proj, 'feat: 改源码');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-40');
    assert.equal(ok, false, '源码变化必须使链失效');
    assert.match(reason.toLowerCase(), /revision/);
  });

  test('test_chain_rejects_non_ancestor_head：非祖先 HEAD（orphan）必须拒绝', () => {
    chain();
    git(proj, 'checkout', '-q', '--orphan', 'other');
    commitAll(proj, 'orphan: 另起历史');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-40');
    assert.equal(ok, false, 'head 不可达必须拒绝');
    assert.ok(reason.includes('祖先') || reason.includes('head'), reason);
  });

  test('test_legacy_receipt_without_head_keeps_existing_semantics：legacy 无 head 按失效处理', () => {
    const v = issueVerificationReceipt(proj, '内部任务-40', evidence(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-40', v.receiptId, '三维通过', { reviewInstances: 3 });
    const payload = readReceipt(proj, '内部任务-40', 'verification-内部任务-40-1');
    const source = { ...payload.revision.sourceRevision };
    delete source.head;
    payload.revision.sourceRevision = source;
    payload.integritySha256 = integrity(payload);
    writeReceipt(proj, '内部任务-40', 'verification-内部任务-40-1', payload);
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-40');
    assert.equal(ok, false, 'legacy 无 head 形态按不等价处理');
    assert.ok(reason.toLowerCase().includes('revision') || reason.includes('提交可达性无法证明'), reason);
  });

  test('test_second_ring_accepts_head_shift：提交运行态产物后第二环受理不报 revision 不一致', () => {
    const v = issueVerificationReceipt(proj, '内部任务-40', evidence(proj), { profile: 'full' });
    commitAll(proj, 'chore(receipts): 提交 verification 凭据');
    const c = issueCodeReviewReceipt(proj, '内部任务-40', v.receiptId, '三维通过', { reviewInstances: 3 });
    assert.equal(c.kind, 'code-review');
  });
});

describe('ReceiptDeliverableTest', () => {
  let tmp;
  let proj;
  let recordRef;
  let criteria;
  let v;
  beforeEach(() => {
    tmp = tmpRoot('dev91-rcpt-deliv-');
    proj = project(tmp);
    mkdirSync(join(proj, 'ops'));
    writeFileSync(join(proj, 'ops', 'record.md'), '# 操作记录\n', 'utf8');
    recordRef = {
      path: 'ops/record.md',
      sha256: `sha256:${sha256Hex(readFileSync(join(proj, 'ops', 'record.md')))}`,
    };
    criteria = [{ criterion: '制品在案', evidenceRef: 'docs/document/out.pptx' }];
    v = issueVerificationReceipt(proj, '内部任务-900', evidence(proj));
  });
  afterEach(() => { cleanup(tmp); });

  function review(overrides = {}) {
    const { summary = '渲染验收 14/14 全过', ...rest } = overrides;
    return issueCodeReviewReceipt(proj, '内部任务-900', v.receiptId, summary, {
      reviewInstances: 1, reviewMode: 'deliverable', ...rest,
    });
  }

  function operation(overrides = {}) {
    return issueOperationReceipt(proj, '内部任务-900', v.receiptId, {
      authorizationQuote: '用户当轮指令：制作 PPT 交付制品',
      authorizationScope: '忽略面制品生成',
      verificationCriteria: criteria,
      rollback: '删除制品文件',
      effectiveBoundary: '本机忽略面',
      recordRef,
      ...overrides,
    });
  }

  test('test_deliverable_mode_issued_and_instances_zero_rejected：deliverable 词表与零实例拒绝', () => {
    const c = review();
    assert.equal(c.reviewMode, 'deliverable');
    assert.throws(() => review({ reviewInstances: 0 }));
  });

  test('test_deliverable_chain_happy_path：制品三环链闭合', () => {
    review();
    operation();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'deliverable' });
    assert.ok(ok, reason);
  });

  test('test_deliverable_order_reversed_rejected：序颠倒拒绝（createdAt 判定）', () => {
    operation({ now: '2026-10-18T00:00:01+08:00' });
    review({ now: '2026-10-18T00:00:02+08:00' });
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'deliverable' });
    assert.equal(ok, false);
    assert.match(reason, /序颠倒/);
  });

  test('test_deliverable_both_rings_must_reference_latest_verification：双环须同引最新 verification', () => {
    review();
    operation();
    issueVerificationReceipt(proj, '内部任务-900', evidence(proj)); // v2 成为最新
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'deliverable' });
    assert.equal(ok, false);
    assert.match(reason, /同引/);
  });

  test('test_deliverable_requires_deliverable_mode_review：three-dim 评审环防洗链', () => {
    review({ reviewMode: 'three-dim', reviewInstances: 3 });
    operation();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'deliverable' });
    assert.equal(ok, false);
    assert.match(reason, /reviewMode/);
  });

  test('test_mixed_chain_dev_profile_still_rejected_with_escape_hint：dev 形态混链拒绝附出路', () => {
    review();
    operation();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'dev' });
    assert.equal(ok, false);
    assert.match(reason, /混链/);
    assert.match(reason, /--deliverable-chain/);
  });

  test('test_mixed_chain_operation_profile_rejected_with_escape_hint：operation 形态混链拒绝附出路', () => {
    review();
    operation();
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'operation' });
    assert.equal(ok, false);
    assert.match(reason, /--deliverable-chain/);
  });

  test('test_deliverable_flag_with_missing_ring_raises：声明制品链但缺环即 ChainProfileError', () => {
    review();
    assert.throws(
      () => verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'deliverable' }),
      ChainProfileError,
    );
  });

  test('test_illegal_profile_raises：非法链形态 ChainProfileError', () => {
    assert.throws(() => verifyReceiptChain(proj, '内部任务-900', { chainProfile: 'bogus' }), ChainProfileError);
  });

  test('test_gate_receipt_deliverable_profile_and_issuance_selfcheck：gate 三值与签发点自洽', () => {
    const c = review();
    const o = operation();
    const gate = issueGateReceipt(proj, '内部任务-900', v.receiptId, null, {
      blockingCount: 0, warningCount: 0,
      codeReviewReceiptId: c.receiptId, operationReceiptId: o.receiptId,
    });
    assert.equal(gate.chainProfile, 'deliverable');
    // 签发点自洽（库层双保险）：three-dim 评审环配 operation 双环 → 拒绝
    const c2 = review({ reviewMode: 'three-dim', reviewInstances: 3 });
    assert.throws(() => issueGateReceipt(proj, '内部任务-900', v.receiptId, null, {
      blockingCount: 0, warningCount: 0,
      codeReviewReceiptId: c2.receiptId, operationReceiptId: o.receiptId,
    }));
  });
});

// ---- JS 专属两例（计划 2.2.1）----

describe('JS 专属：now 注入与归档分支', () => {
  let tmp;
  let proj;
  beforeEach(() => { tmp = tmpRoot('dev91-rcpt-jsext-'); proj = project(tmp); });
  afterEach(() => { cleanup(tmp); });

  test('opts.now 注入：固定 createdAt 落盘（两侧字节对拍的可复现前提）', () => {
    const fixed = '2026-10-18T00:00:00+08:00';
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full', now: fixed });
    assert.equal(v.createdAt, fixed);
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '固定时刻', {
      reviewInstances: 1, now: '2026-10-18T00:00:01+08:00',
    });
    assert.equal(c.createdAt, '2026-10-18T00:00:01+08:00');
    assert.equal(readReceipt(proj, '内部任务-1', v.receiptId).createdAt, fixed);
  });

  test('归档分支：receipts 目录缺失但 manifest 命中 ⇒ 归档态诊断（fail-open 不改变无凭据语义）', () => {
    mkdirSync(join(proj, '.sdd', 'archive'), { recursive: true });
    writeFileSync(
      join(proj, '.sdd', 'archive', 'archive-manifest.json'),
      JSON.stringify({ schemaVersion: 1, batches: [{ batch: 'b1', taskIds: ['DEV-ARC'] }] }),
      'utf8',
    );
    const [ok, reason] = verifyReceiptChain(proj, 'DEV-ARC');
    assert.equal(ok, false);
    assert.match(reason, /已归档/);
    assert.match(reason, /restore-receipts/);
    // 未命中 manifest 的任务仍报「无任何凭据」（fail-open 语义不变）
    const [ok2, reason2] = verifyReceiptChain(proj, 'DEV-NONE');
    assert.equal(ok2, false);
    assert.match(reason2, /无任何凭据/);
  });
});

posixOnly('verifyReceiptChain 非 UTF-8 契约：严格解码失败转 (false, 具名诊断) 不异常穿透', () => {
  const tmp = tmpRoot('dev91-rcpt-badutf8-');
  try {
    const proj = makeGitProject(tmp);
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 1 });
    // APFS 拒收非法 UTF-8 文件名，经 git plumbing 原始字节构造索引条目（同 revision 夹具）。
    const blob = gitRaw(proj, ['hash-object', '-w', '--stdin'], Buffer.from('x = 1\n', 'utf8'))
      .stdout.toString('utf8').trim();
    const badRecord = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\tsrc/`), Buffer.from([0xff, 0xfe]), Buffer.from('bad.py\0'),
    ]);
    gitRaw(proj, ['update-index', '-z', '--index-info'], badRecord);
    let result = null;
    try { result = verifyReceiptChain(proj, '内部任务-1'); } catch (e) {
      assert.fail(`异常穿透 (bool, reason) 契约：${e.message}`);
    }
    assert.equal(result[0], false);
    assert.match(result[1], /非 UTF-8/);
    assert.match(result[1], /内部未决-131/);
  } finally { cleanup(tmp); }
});

describe('ReceiptFixReviewTest（内部任务-156）', () => {
  let tmp;
  let proj;
  let v;
  const base = 'a'.repeat(40);
  const diff = 'b'.repeat(64);
  beforeEach(() => {
    tmp = tmpRoot('dev156-fixreview-');
    proj = project(tmp);
    v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
  });
  afterEach(() => { cleanup(tmp); });

  const issue = (opts = {}) => issueCodeReviewReceipt(
    proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3, ...opts },
  );

  test('默认 none/0，五字段齐备且空值', () => {
    const c = issue();
    assert.equal(c.fixReviewMode, 'none');
    assert.equal(c.fixReviewInstances, 0);
    assert.equal(c.fixReviewReason, '');
    assert.equal(c.fixReviewBase, '');
    assert.equal(c.fixReviewDiffSha, '');
  });

  test('self：0 实例 + 理由/base/diff 必填', () => {
    const c = issue({
      fixReviewMode: 'self', fixReviewInstances: 0, fixReviewReason: '注释同步',
      fixReviewBase: base, fixReviewDiffSha: diff,
    });
    assert.equal(c.fixReviewMode, 'self');
    assert.equal(c.fixReviewBase, base);
    assert.throws(() => issue({ fixReviewMode: 'self', fixReviewInstances: 0, fixReviewBase: base, fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'self', fixReviewInstances: 1, fixReviewReason: 'x', fixReviewBase: base, fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'self', fixReviewInstances: 0, fixReviewReason: 'x', fixReviewDiffSha: diff }));
  });

  test('delta：恰 1 实例 + base/diff', () => {
    const c = issue({
      fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: `sha256:${diff}`,
    });
    assert.equal(c.fixReviewMode, 'delta');
    assert.equal(c.fixReviewDiffSha, diff, 'sha256: 前缀归一为裸 hex');
    assert.throws(() => issue({ fixReviewMode: 'delta', fixReviewInstances: 0, fixReviewBase: base, fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'delta', fixReviewInstances: 2, fixReviewBase: base, fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base }));
  });

  test('full：≥3 实例 + base/diff', () => {
    assert.equal(issue({ fixReviewMode: 'full', fixReviewInstances: 3, fixReviewBase: base, fixReviewDiffSha: diff }).fixReviewMode, 'full');
    assert.equal(issue({ fixReviewMode: 'full', fixReviewInstances: 4, fixReviewBase: base, fixReviewDiffSha: diff }).fixReviewInstances, 4);
    assert.throws(() => issue({ fixReviewMode: 'full', fixReviewInstances: 2, fixReviewBase: base, fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'full', fixReviewInstances: 0, fixReviewBase: base, fixReviewDiffSha: diff }));
  });

  test('none 带理由/base/diff 拒；非法 mode/base/diff 拒', () => {
    assert.throws(() => issue({ fixReviewMode: 'none', fixReviewReason: 'x' }));
    assert.throws(() => issue({ fixReviewMode: 'none', fixReviewBase: base }));
    assert.throws(() => issue({ fixReviewMode: 'none', fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'bogus' }));
    assert.throws(() => issue({ fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: 'xyz', fixReviewDiffSha: diff }));
    assert.throws(() => issue({ fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: 'zz' }));
    for (const bad of ['3.5', 'abc', Infinity, NaN]) {
      assert.throws(() => issue({
        fixReviewMode: 'full', fixReviewInstances: bad, fixReviewBase: base, fixReviewDiffSha: diff,
      }), `非整数/NaN/Infinity 实例须拒：${bad}`);
    }
  });

  test('deliverable 只允许 none', () => {
    const c = issue({ reviewInstances: 1, reviewMode: 'deliverable', fixReviewMode: 'none' });
    assert.equal(c.fixReviewMode, 'none');
    assert.throws(() => issue({
      reviewInstances: 1, reviewMode: 'deliverable',
      fixReviewMode: 'self', fixReviewInstances: 0, fixReviewReason: 'x', fixReviewBase: base, fixReviewDiffSha: diff,
    }));
  });

  test('stage 级凭据写五字段并受同一真值表校验', () => {
    const c = issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段复审', {
      stage: '1', reviewInstances: 1, reviewMode: 'single-instance',
      fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: diff,
    });
    assert.equal(c.stage, '1');
    assert.equal(c.fixReviewMode, 'delta');
    assert.equal(c.fixReviewDiffSha, diff);
    assert.throws(() => issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段复审', {
      stage: '1', reviewInstances: 1, reviewMode: 'single-instance',
      fixReviewMode: 'self', fixReviewInstances: 1, fixReviewReason: 'x', fixReviewBase: base, fixReviewDiffSha: diff,
    }));
  });
});

test('冻结凭据夹具永久跨读：内部任务-36/86（dev）与 内部任务-78（operation）判定稳定', () => {
  // 夹具为永久件；阶段3 拆除 迁移期窗口件后由本用例继续提供消费面（不依赖真实 .sdd）。
  const expectations = { '内部任务-36': 'dev', '内部任务-78': 'operation', '内部任务-86': 'dev' };
  for (const [taskId, expectedProfile] of Object.entries(expectations)) {
    const srcDir = join(FIXTURE_ROOT, taskId);
    assert.ok(existsSync(srcDir), `冻结夹具目录缺失（fail-loud）：${srcDir}`);
    const jsonFiles = readdirSync(srcDir).filter((n) => n.endsWith('.json')).sort();
    assert.ok(jsonFiles.length > 0, `冻结夹具无 JSON 文件（fail-loud）：${srcDir}`);
    const tmp = tmpRoot(`dev91-rcpt-fixture-${taskId.toLowerCase()}-`);
    try {
      const destDir = join(tmp, '.sdd', 'receipts', taskId);
      mkdirSync(destDir, { recursive: true });
      for (const name of jsonFiles) cpSync(join(srcDir, name), join(destDir, name));
      assert.equal(gateChainProfile(destDir), expectedProfile, `${taskId} gate.chainProfile`);
      const [ok, reason] = verifyReceiptChain(tmp, taskId, { chainProfile: expectedProfile });
      assert.equal(ok, false, `${taskId} 预期链失效`);
      if (taskId === '内部任务-78') {
        assert.equal(reason, '凭据 revision 与当前不一致（源码/规格/计划已变化，链已失效）',
          '内部任务-78 tmp 根 source/spec 与凭据不等 ⇒ content-changed');
      } else {
        assert.match(reason, /链绑定计划不可读\/已删除/, `${taskId} 计划不可读 ⇒ 内部未决-109`);
      }
      const [fileOk, fileReason] = verifyReceiptFile(
        join(destDir, `verification-${taskId}-1.json`),
      );
      assert.equal(fileOk, true, `${taskId} verification 完整性：${fileReason}`);
    } finally { cleanup(tmp); }
  }
});

describe('ReviewProvenanceTest（内部任务-191）', () => {
  let tmp;
  let proj;
  let v;
  beforeEach(() => {
    tmp = tmpRoot('dev191-prov-');
    proj = project(tmp);
    v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
  });
  afterEach(() => { cleanup(tmp); });

  const issue = (opts = {}) => issueCodeReviewReceipt(
    proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3, ...opts },
  );

  test('2.1.0 + reviewRound/reviewProvenance 落盘，countable=实例数且链通过', () => {
    const c = issue({ reviewRound: 1, reviewProvenance: prov('内部任务-1', 3) });
    assert.equal(c.schemaVersion, '2.1.0');
    assert.equal(c.reviewRound, 1);
    assert.equal(c.reviewProvenance.length, 3);
    assert.equal(reviewProvenanceStatusOf(c, { taskId: '内部任务-1' }).state, 'present');
    assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], true);
  });

  test('跨任务 chain / round=1 非 fresh / instance 重复 / countable 不符 → 签发拒', () => {
    assert.throws(() => issue({
      reviewProvenance: prov('内部任务-1', 3).map((e) => ({ ...e, chain: 'task:内部任务-2' })),
    }), /chain|跨任务/);
    assert.throws(() => issue({
      reviewProvenance: prov('内部任务-1', 3).map((e, i) => (i === 0 ? { ...e, state: 'reused' } : e)),
    }), /fresh/);
    assert.throws(() => issue({
      reviewProvenance: [
        { role: 'a', instance: 'same', chain: 'task:内部任务-1', state: 'fresh' },
        { role: 'b', instance: 'same', chain: 'task:内部任务-1', state: 'fresh' },
        { role: 'c', instance: 'other', chain: 'task:内部任务-1', state: 'fresh' },
      ],
    }), /instance/);
    assert.throws(() => issue({ reviewProvenance: prov('内部任务-1', 2) }), /countable|实例数/);
  });

  test('修复复审 provenance：countable 须等于 fixReviewInstances（rehydrated 不计入）', () => {
    const base = 'a'.repeat(40);
    const diff = 'b'.repeat(64);
    assert.throws(() => issue({
      fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: diff,
      fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'rehydrated' }),
    }), /countable/);
    const ok = issue({
      fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: diff,
      fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'reused' }),
    });
    assert.equal(ok.fixReviewProvenance.length, 1);
  });

  test('无 provenance 的库面凭据 = 2.0.0 legacy（读侧不硬拒，状态投影 legacy）', () => {
    const c = issue();
    assert.equal(c.schemaVersion, '2.0.0', '库面缺 provenance 须如实降级 2.0.0，不得冒充 2.1.0');
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'reviewProvenance'));
    assert.equal(reviewProvenanceStatusOf(c, { taskId: '内部任务-1' }).state, 'legacy');
    assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], true);
  });

  test('2.1.0 非豁免缺 reviewRound/reviewProvenance → 读侧判死（D6 不变量）', () => {
    const withProv = issue({ reviewRound: 1, reviewProvenance: prov('内部任务-1', 3) });
    const file = join(proj, '.sdd', 'receipts', '内部任务-1', `${withProv.receiptId}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.reviewRound;
    raw.integritySha256 = integrity(raw);
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false, '2.1.0 缺 reviewRound 须判死');
    assert.match(reason, /provenance|reviewRound/);
  });

  test('2.1.0 fixReviewInstances>0 缺 fixReviewProvenance → 读侧判死', () => {
    const base = 'a'.repeat(40);
    const diff = 'b'.repeat(64);
    const c = issue({
      reviewRound: 1, reviewProvenance: prov('内部任务-1', 3),
      fixReviewMode: 'delta', fixReviewInstances: 1, fixReviewBase: base, fixReviewDiffSha: diff,
      fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'reused' }),
    });
    const file = join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.fixReviewProvenance;
    raw.integritySha256 = integrity(raw);
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false, '2.1.0 fix 环缺 provenance 须判死');
    assert.match(reason, /fixReviewProvenance/);
  });

  test('verifyReceiptChain 对文件内非法 provenance 硬拒；2.0.0 legacy 放行', () => {
    const c = issue({ reviewProvenance: prov('内部任务-1', 3) });
    const file = join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.reviewProvenance = raw.reviewProvenance.map((e) => ({ ...e, chain: 'task:内部任务-2' }));
    raw.integritySha256 = integrity(raw); // 模拟「签发侧自述合法完整性」但 provenance 非法的存量/伪造凭据
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const [ok1, reason1] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok1, false, '2.1.0 非法 provenance 须硬拒');
    assert.match(reason1, /provenance/);
    delete raw.reviewProvenance;
    delete raw.reviewRound;
    raw.schemaVersion = '2.0.0';
    raw.integritySha256 = integrity(raw);
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const [ok2] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok2, true, '2.0.0 legacy（无 provenance）放行');
  });
});

describe('ReviewProvenanceStrictTest（内部任务-193 P1-A：A1/A2/A3/A4/A10/S1/S2/fix 环）', () => {
  let tmp;
  let proj;
  let v;
  const base = 'a'.repeat(40);
  const diff = 'b'.repeat(64);
  beforeEach(() => {
    tmp = tmpRoot('dev193-p1a-prov-');
    proj = project(tmp);
    v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
  });
  afterEach(() => { cleanup(tmp); });

  const issue = (opts = {}) => issueCodeReviewReceipt(
    proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3, reviewRound: 1, reviewProvenance: prov('内部任务-1', 3), ...opts,
    },
  );
  const receiptFile = (c) => join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`);
  const readRaw = (c) => JSON.parse(readFileSync(receiptFile(c), 'utf8'));
  /** 按凭据口径重算完整性再落盘（模拟「自述合法完整性」的伪造/存量凭据）。 */
  const tamper = (c, mutate) => {
    const raw = readRaw(c);
    mutate(raw);
    raw.integritySha256 = integrity(raw);
    writeFileSync(receiptFile(c), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  };

  test('A1 normalizeReviewRound 严格类型：undefined→1；仅 number/数字串且 1..999 受理', () => {
    assert.equal(normalizeReviewRound(undefined), 1, 'undefined 缺省为 1');
    for (const ok of [1, 2, 999, '1', '7', '999']) {
      assert.equal(normalizeReviewRound(ok), Number(ok), `合法值受理：${String(ok)}`);
    }
    for (const bad of [null, '', true, false, [], [1], 1.5, NaN, Infinity, -Infinity, 0, 1000,
      '0', '1000', '1.5', ' 1 ', '1 ']) {
      assert.throws(() => normalizeReviewRound(bad), /reviewRound/, `非法值须拒：${String(bad)}`);
    }
    assert.throws(() => normalizeReviewRound('x', 'fixReviewRound'), /fixReviewRound/, '错误文案点名字段');
  });

  test('A1 伪造 reviewRound:true 重算 integrity → 读侧判死（不得被 Number() 折成 1）', () => {
    const c = issue();
    tamper(c, (raw) => { raw.reviewRound = true; });
    const status = reviewProvenanceStatusOf(readRaw(c), { taskId: '内部任务-1' });
    assert.equal(status.state, 'invalid', 'reviewRound:true 不得折算为 1');
    assert.match(status.reason, /reviewRound/);
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false, '伪造轮次字段的凭据链须判死');
    assert.match(reason, /provenance|reviewRound/);
  });

  test('A2 crossStage：false 视同缺省；true 必带非空 note；null/"true"/1 拒', () => {
    const withCross = (extra) => prov('内部任务-1', 3).map((e, i) => (i === 0 ? { ...e, ...extra } : e));
    const okFalse = issue({ reviewProvenance: withCross({ crossStage: false }) });
    assert.equal(okFalse.reviewProvenance[0].crossStage, false, 'false 视同缺省（受理并原样保留）');
    assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], true);
    const okTrue = issue({
      reviewProvenance: withCross({ crossStage: true, note: 'round2 复用 f1 实例（跨阶段）' }),
    });
    assert.equal(okTrue.reviewProvenance[0].crossStage, true);
    assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], true);
    assert.throws(() => issue({ reviewProvenance: withCross({ crossStage: true }) }), /crossStage|note/);
    for (const bad of [null, 'true', 1]) {
      assert.throws(
        () => issue({ reviewProvenance: withCross({ crossStage: bad }) }),
        /crossStage/,
        `非法 crossStage 须拒：${String(bad)}`,
      );
    }
  });

  test('A10 role 重复库面拒（内部验收-8 宣称锁定）', () => {
    assert.throws(() => issue({
      reviewProvenance: [
        { role: 'simplicity', instance: 'i-1', chain: 'task:内部任务-1', state: 'fresh' },
        { role: 'simplicity', instance: 'i-2', chain: 'task:内部任务-1', state: 'fresh' },
        { role: 'correctness', instance: 'i-3', chain: 'task:内部任务-1', state: 'fresh' },
      ],
    }), /role 重复/);
  });

  test('A10 exempt/user-audit 库面携带 provenance 拒', () => {
    const plans = join(proj, 'docs', 'plans');
    mkdirSync(plans, { recursive: true });
    const plan = join(plans, 'pure-doc.md');
    writeFileSync(plan, '# 纯文档计划\n', 'utf8');
    assert.throws(() => issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '豁免', {
      reviewInstances: 0,
      reviewMode: 'exempt',
      reviewRound: 1,
      reviewProvenance: prov('内部任务-1', 1),
      exemptionReason: '纯文档计划收尾节显式豁免（内部规则-11）',
      planPath: plan,
    }), /不得携带/);
    assert.throws(() => issue({
      reviewMode: 'user-audit', reviewInstances: 1, reviewProvenance: prov('内部任务-1', 1),
    }), /不得携带/);
  });

  test('A3 fixReviewInstances=0 携带 fixReviewProvenance → 链判死、投影 invalid（D3 反向不变量）', () => {
    const c = issue({
      fixReviewMode: 'delta',
      fixReviewInstances: 1,
      fixReviewBase: base,
      fixReviewDiffSha: diff,
      fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'reused' }),
    });
    assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], true, '合法 fix 环先验');
    tamper(c, (raw) => { raw.fixReviewInstances = 0; });
    const status = reviewProvenanceStatusOf(readRaw(c), { taskId: '内部任务-1' });
    assert.equal(status.state, 'invalid', 'fixInstances=0 携带 fixProv 须判 invalid');
    assert.match(status.reason, /fixReviewProvenance/);
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false);
    assert.match(reason, /fixReviewProvenance/);
  });

  test('S1 reviewInstances 读侧严格计数：非 number/非安全整数/<1 → invalid', () => {
    for (const [bad, why] of [['3', '字符串'], [0, '0'], [null, 'null'], [2.5, '小数']]) {
      const c = issue();
      tamper(c, (raw) => { raw.reviewInstances = bad; });
      const status = reviewProvenanceStatusOf(readRaw(c), { taskId: '内部任务-1' });
      assert.equal(status.state, 'invalid', `reviewInstances 非严格计数须 invalid：${why}`);
      assert.match(status.reason, /reviewInstances/, '错误文案点名字段');
      assert.equal(verifyReceiptChain(proj, '内部任务-1')[0], false);
    }
  });

  test('S2 fixReviewInstances 读侧严格计数：出现即须 number 安全整数（字符串/负数/小数 → invalid）', () => {
    for (const [bad, why] of [['1', '字符串'], [-1, '负数'], [1.5, '小数']]) {
      const c = issue({
        fixReviewMode: 'delta',
        fixReviewInstances: 1,
        fixReviewBase: base,
        fixReviewDiffSha: diff,
        fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'reused' }),
      });
      tamper(c, (raw) => { raw.fixReviewInstances = bad; });
      const status = reviewProvenanceStatusOf(readRaw(c), { taskId: '内部任务-1' });
      assert.equal(status.state, 'invalid', `fixReviewInstances 非严格计数须 invalid：${why}`);
      assert.match(status.reason, /fixReviewInstances/, '错误文案点名字段');
    }
  });

  test('A4 reviewProvenanceStatusOf early return 恒给 fixProvenanceState=none', () => {
    assert.equal(reviewProvenanceStatusOf(null, { taskId: '内部任务-1' }).fixProvenanceState, 'none',
      '无凭据（absent）恒 none');
    const legacy = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3 });
    const legacyStatus = reviewProvenanceStatusOf(legacy, { taskId: '内部任务-1' });
    assert.equal(legacyStatus.state, 'legacy');
    assert.equal(legacyStatus.fixProvenanceState, 'none', 'legacy 恒 none');
    const audit = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '人审', {
      reviewInstances: 1, reviewMode: 'user-audit',
    });
    const auditStatus = reviewProvenanceStatusOf(audit, { taskId: '内部任务-1' });
    assert.equal(auditStatus.state, 'not-required');
    assert.equal(auditStatus.fixProvenanceState, 'none', 'user-audit 恒 none');
  });

  test('fix 环 fixReviewInstances>0 合法用例：full/3 带 prov/base/diff 签发并通过链校验', () => {
    const c = issue({
      fixReviewMode: 'full',
      fixReviewInstances: 3,
      fixReviewBase: base,
      fixReviewDiffSha: diff,
      fixReviewProvenance: prov('内部任务-1', 3, { round: 2, state: 'reused' }),
    });
    assert.equal(c.fixReviewMode, 'full');
    assert.equal(c.fixReviewInstances, 3);
    assert.equal(c.fixReviewProvenance.length, 3);
    const status = reviewProvenanceStatusOf(c, { taskId: '内部任务-1' });
    assert.equal(status.state, 'present');
    assert.equal(status.fixProvenanceState, 'present', 'fix 环成功投影 present');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, true, reason);
  });
});

describe('ReceiptCorruptionAndChainModeTest (内部任务-241 步骤6 G06/G07)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-receipt-chmode-'); proj = project(tmp); });
  afterEach(() => cleanup(tmp));

  test('dev 链拒绝 deliverable 评审环（G06）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '制品型评审', {
      reviewInstances: 3, reviewMode: 'deliverable', reviewProvenance: prov('内部任务-1', 3),
    });
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false);
    assert.match(reason, /dev 链不得消费制品链评审凭据/);
  });

  test('code-review 凭据损坏 → 报「损坏」而非「不存在」（G07）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '三维通过', {
      reviewInstances: 3, reviewProvenance: prov('内部任务-1', 3),
    });
    writeFileSync(join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`), '{broken', 'utf8');
    const [ok, reason] = verifyReceiptChain(proj, '内部任务-1');
    assert.equal(ok, false);
    assert.match(reason, /凭据损坏\/不可解析/);
    assert.match(reason, new RegExp(c.receiptId));
  });

  test('verification 凭据损坏 → 签发入口报损坏而非「不存在」（G07）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidence(proj), { profile: 'full' });
    writeFileSync(join(proj, '.sdd', 'receipts', '内部任务-1', `${v.receiptId}.json`), '{broken', 'utf8');
    assert.throws(
      () => issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 'x', { reviewInstances: 3, reviewProvenance: prov('内部任务-1', 3) }),
      (e) => /verification 凭据损坏\/不可解析/.test(e.message) && !/须为凭据 ID 而非文件路径/.test(e.message),
    );
  });
});

describe('ReceiptSequenceLockTest (内部任务-241 步骤5 G04)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-receipt-seq-'); proj = project(tmp); });
  afterEach(() => cleanup(tmp));

  test('空洞场景：序号取 max+1，不覆盖既有凭据', () => {
    const a = issueInspectionReceipt(proj, '内部任务-1', 'a');
    const b = issueInspectionReceipt(proj, '内部任务-1', 'b');
    const c = issueInspectionReceipt(proj, '内部任务-1', 'c');
    assert.deepEqual([a.receiptId, b.receiptId, c.receiptId].map((x) => x.split('-').pop()), ['1', '2', '3']);
    rmSync(join(proj, '.sdd', 'receipts', '内部任务-1', `${b.receiptId}.json`));
    const after = issueInspectionReceipt(proj, '内部任务-1', 'd');
    assert.equal(after.receiptId, 'inspection-only-内部任务-1-4', '空洞后取 max+1（旧实现 count+1 会撞 -3）');
    assert.ok(existsSync(join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`)), '既有 -3 不被覆盖');
  });

  test('锁被占用：签发报工具错误（code=ELOCKED）且零写入', () => {
    const dir = join(proj, '.sdd', 'receipts', '内部任务-1');
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, '.receipt.lock');
    const held = acquireLock(lockPath, { owner: 'holder' });
    assert.equal(held.ok, true);
    try {
      assert.throws(() => issueInspectionReceipt(proj, '内部任务-1', 'x'), (e) => e.code === 'ELOCKED');
      assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0, '并发占用时零写入');
    } finally {
      releaseLock(lockPath, 'holder');
    }
    const ok = issueInspectionReceipt(proj, '内部任务-1', 'y');
    assert.equal(ok.receiptId, 'inspection-only-内部任务-1-1');
  });

  test('两个子进程并发签发：holder/contender 标记文件屏障——恰一号成功、另一号 ELOCKED，只落一份凭据', { timeout: 90_000 }, async () => {
    const receiptsUrl = new URL('../receipts.mjs', import.meta.url).href;
    const barrier = join(tmp, 'barrier');
    mkdirSync(barrier, { recursive: true });
    const holderLocked = join(barrier, 'holder-locked.marker');
    const releaseMarker = join(barrier, 'release.marker');
    const script = join(tmp, 'race.mjs');
    writeFileSync(script, [
      `import { _testHooks, issueInspectionReceipt } from ${JSON.stringify(receiptsUrl)};`,
      `import { writeFileSync, existsSync } from 'node:fs';`,
      `// 内部任务-331 角色：holder——锁到手（afterReceiptLockAcquired＝acquireLock 成功后、序号重算前）写标记，`,
      `// 再零 CPU 等待 release.marker（父进程在 contender 退出后写入）；等待上限 60s，超限退 3（屏障故障 fail-loud）。`,
      `if (process.argv[3] === 'holder') {`,
      `  _testHooks.afterReceiptLockAcquired = () => {`,
      `    writeFileSync(${JSON.stringify(holderLocked)}, String(process.pid));`,
      `    const deadline = Date.now() + 60_000;`,
      `    while (!existsSync(${JSON.stringify(releaseMarker)})) {`,
      `      if (Date.now() > deadline) process.exit(3);`,
      `      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
      `    }`,
      `  };`,
      `}`,
      `// 退出码契约：0＝签发成功；2＝ELOCKED（互斥生效专属信号）；4＝其余意外错误；3＝holder 屏障等待超限。`,
      `// 意外错误类先打 stderr 再退码（ELOCKED 正常路径保持 stderr 干净）——供父进程捕获免手工复现。`,
      `try { issueInspectionReceipt(process.argv[2], 'TASK-RACE', 'audit'); process.exit(0); }`,
      `catch (e) { if (!(e && e.code === 'ELOCKED')) console.error(e); process.exit(e && e.code === 'ELOCKED' ? 2 : 4); }`,
    ].join('\n'), 'utf8');
    const waitMarker = (p, ms, what) => new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const timer = setInterval(() => {
        if (existsSync(p)) { clearInterval(timer); resolve(); return; }
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`${what} 超窗（${ms}ms）——屏障握手失败＝协议/环境故障，非产品缺陷`)); }
      }, 10);
    });
    // 门控顺序（唯一顺序，不可重排）：holder 先拿到锁（标记为证）→ contender 才进场必撞新鲜锁（秒龄远小于
    // staleSeconds=300，lock.mjs:57 立即 {ok:false}→ELOCKED）→ contender 退出后才放行 holder。
    // 重叠由构造保证——竞争前提与机器负载/子进程冷启动时长彻底解耦（替换旧版 400ms 忙等窗的时序赌注）。
    const holderChild = spawn(process.execPath, [script, proj, 'holder'], { stdio: 'ignore' });
    const holderExit = new Promise((resolve) => holderChild.on('close', (code) => resolve(code)));
    try {
      await waitMarker(holderLocked, 30_000, '等 holder 锁在手标记');
      // 内部任务-331：contender 腿无并发对象（holder 此时阻塞在 release.marker 上），spawnSync 即等价更简——
      // 原生收集 stderr 尾部（退非 2 时附入断言消息，免手工复现）并补子进程级超时上限（stage1 简洁性①）。
      const contender = spawnSync(process.execPath, [script, proj, 'contender'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(contender.status, 2, `contender 必须吃 ELOCKED 退 2（0＝互斥被打破＝真缺陷；4＝意外错误类）${contender.stderr ? `；stderr 尾部：${contender.stderr.slice(-400)}` : ''}`);
      writeFileSync(releaseMarker, 'go');
      const holderCode = await holderExit;
      assert.equal(holderCode, 0, 'holder 必须签发成功退 0（3＝屏障等待超限＝协议故障）');
      const files = readdirSync(join(proj, '.sdd', 'receipts', 'TASK-RACE')).filter((n) => n.endsWith('.json'));
      assert.equal(files.length, 1, '只落一份凭据');
      assert.ok(files[0].startsWith('inspection-only-内部任务-RACE-1'), `凭据 ID 形态：${files[0]}`);
    } finally {
      holderChild.kill(); // 已退出时为无操作；屏障故障路径防孤儿进程
    }
  });
});
