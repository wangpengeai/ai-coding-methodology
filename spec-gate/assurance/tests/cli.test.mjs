// 文件：cli.test.mjs
// 描述：cli.mjs 永久单测（内部任务-92 阶段3a W2；对齐 spec-gate/assurance/tests/test_cli.py 的
//       CliChainTest（16）/CliPathBasisTest（5）/CliOperationChainTest（10）逐方法移植，
//       并入 test_archive.py 的 ArchiveCliTests（3）与 test_scout_transactions.py 的
//       CliDispatchTest（3））——退出码 0/1/2 语义、全链命令贯通、路径基准（--project-root
//       而非调用方 cwd，含 `..`/symlink 计划）、证据/判据字段级校验、互斥组/条件必填、
//       stdout 纯 JSON、错误分类六类与已知怪癖回归钉（finalize --plan 忽略、
//       archive-receipts --dry-run 忽略、gate production config-error 退 2 其余阻断退 1）。
//       core runner 经 SG_CORE_VALIDATOR 指向桩脚本（生产路径为冻结 core）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  CliToolError, CliValueError, classifyCliError, loadChangeContext, reportCliError,
} from '../cli.mjs';
import { ChainProfileError } from '../receipts.mjs';
import {
  EVIDENCE_ONE, capture, cleanup, future, makeCliProject, mkArchiveTask, readJson,
  runCli, runCliRaw, tmpRoot, writeCriteria, writeEvidence,
} from './cli-fixtures.mjs';
import { prov } from './provenance-fixtures.mjs';

/** 内部任务-191：provenance CLI 参数（chain=task:<taskId>）；round>1 可显式给 state（复用轮为 reused）。 */
function provArg(task, count, round = 1, state = 'fresh') {
  return JSON.stringify(prov(task, count, { round, state }));
}

/** stdout 必须为纯 JSON：解析或失败即断言红。 */
function jsonOf(r) {
  return JSON.parse(r.stdout);
}

/** 一句断言组合：退出码 + stdout JSON。 */
function expectJson(r, code) {
  assert.equal(r.code, code, `退出码（stderr: ${r.stderr}）`);
  return jsonOf(r);
}

// 顶层环境钩子：SG_CORE_VALIDATOR 由各 describe 覆盖，结束后恢复（in-process main 读 process.env）。
let envBefore;
beforeEach(() => {
  envBefore = process.env.SG_CORE_VALIDATOR;
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.SG_CORE_VALIDATOR;
  else process.env.SG_CORE_VALIDATOR = envBefore;
});

/** 一条 dev 链（verification → code-review → prepare）；返回 verification 凭据。 */
function issueDevChain(proj, ev, task = '内部任务-1') {
  const v = expectJson(runCli(proj, [
    'issue-verification', '--task-id', task, '--evidence-file', ev, '--profile', 'full',
  ]), 0);
  expectJson(runCli(proj, [
    'issue-code-review', '--task-id', task, '--verification', v.receiptId,
    '--summary', '三维通过', '--review-instances', '3', '--fix-review-mode', 'none',
    '--review-provenance', provArg(task, 3),
  ]), 0);
  expectJson(runCli(proj, [
    'prepare', '--task-id', task,
    '--applicability-sdd', 'required', '--applicability-ddd', 'tactical',
    '--applicability-tdd', 'strict',
    '--applicability-reasons', JSON.stringify({ sdd: '批次含规格条款', ddd: '模块内变更', tdd: '测试先行' }),
    '--spec-impact', '规格条款演进',
    '--change-scope', '["src/**"]',
    '--receipt-refs', JSON.stringify([v.receiptId]),
  ]), 0);
  return v;
}

describe('CliChainTest', () => {
  let tmp; let proj; let stub; let ev;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-chain-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
    ev = writeEvidence(tmp);
  });
  afterEach(() => cleanup(tmp));

  test('test_full_chain_happy_path', () => {
    const rev = runCli(proj, ['revision']);
    assert.equal(rev.code, 0);
    assert.ok('sourceRevision' in jsonOf(rev));

    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const vid = v.receiptId;
    const c = expectJson(runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', vid,
      '--summary', '三维通过', '--review-instances', '3', '--fix-review-mode', 'none',
      '--review-provenance', provArg('内部任务-1', 3),
    ]), 0);
    const reasons = JSON.stringify({ sdd: '批次含规格条款', ddd: '模块内变更', tdd: '测试先行' });
    const draft = expectJson(runCli(proj, [
      'prepare', '--task-id', '内部任务-1',
      '--applicability-sdd', 'required', '--applicability-ddd', 'tactical',
      '--applicability-tdd', 'strict', '--applicability-reasons', reasons,
      '--spec-impact', '规格条款演进', '--change-scope', '["src/**"]',
      '--receipt-refs', JSON.stringify([vid]),
    ]), 0);
    assert.equal(draft.applicability.sdd.conclusion, 'required', '对象化存盘（内部未决-8）');
    assert.equal(expectJson(runCli(proj, ['chain-verify', '--task-id', '内部任务-1']), 0).ok, true);
    const report = expectJson(runCli(proj, ['gate', '--task-id', '内部任务-1']), 0);
    assert.notEqual(report.gateReceipt, null);
    const fin = runCli(proj, ['finalize', '--task-id', '内部任务-1']);
    assert.equal(fin.code, 0, fin.stderr);
    assert.equal(jsonOf(fin).finalStatus, 'complete');
    assert.ok(fin.stderr.includes('learnings'), '链尾指引（workflow:learnings）');
    assert.ok(fin.stderr.includes('无收获'), '指引须含「无收获」跳过出口语义');
    assert.equal(c.status, 'passed');
  });

  test('test_gate_without_chain_exit_1', () => {
    const r = runCli(proj, ['gate', '--task-id', '内部任务-404']);
    assert.equal(r.code, 1, '缺凭据/草案是内容阻断（1），不是工具错误（2）');
  });

  test('test_exempt_mode_full_chain_happy_path', () => {
    const plans = join(proj, 'docs', 'plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'pure-doc.md'), '# 纯文档计划\n', 'utf8');
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-9', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const receipt = expectJson(runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-9', '--verification', v.receiptId,
      '--summary', '纯文档批豁免', '--review-instances', '0', '--review-mode', 'exempt',
      '--fix-review-mode', 'none',
      '--exemption-reason', '纯文档计划，收尾节显式豁免三维重流程（内部规则-11）',
      '--plan', '内部计划',
    ]), 0);
    assert.ok(receipt.exemptReceipt);
    const r2 = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-9', '--verification', v.receiptId, '--summary', 's',
      '--review-instances', '0', '--review-mode', 'exempt', '--fix-review-mode', 'none',
      '--plan', '内部计划',
    ]);
    assert.equal(r2.code, 2, r2.stderr);
    const reasons = JSON.stringify({ sdd: '纯文档批', ddd: '不适用', tdd: '不适用' });
    expectJson(runCli(proj, [
      'prepare', '--task-id', '内部任务-9',
      '--applicability-sdd', 'exempt', '--applicability-ddd', 'not-applicable', '--applicability-tdd', 'exempt',
      '--applicability-reasons', reasons, '--spec-impact', '纯文档',
      '--change-scope', '["docs/**"]', '--receipt-refs', JSON.stringify([v.receiptId]),
    ]), 0);
    const report = expectJson(runCli(proj, ['gate', '--task-id', '内部任务-9']), 0);
    assert.notEqual(report.gateReceipt, null, '豁免链 gate 签发（0 阻断）');
    const fin = expectJson(runCli(proj, ['finalize', '--task-id', '内部任务-9']), 0);
    assert.equal(fin.finalStatus, 'complete');
    const gatePayload = readJson(join(proj, '.sdd', 'receipts', '内部任务-9', `${report.gateReceipt}.json`));
    assert.ok('codeReviewReceipt' in gatePayload, 'gate 凭据以 code-review 第二环闭合（豁免形态可见留痕）');
    assert.ok(gatePayload.codeReviewReceipt.startsWith('code-review-内部任务-9-'));
  });

  test('test_task_id_traversal_form_exit_2', () => {
    for (const bad of ['../evil', 'a/b', '..', 'x\\y']) {
      const r = runCli(proj, ['issue-verification', '--task-id', bad, '--evidence-file', ev]);
      assert.equal(r.code, 2, `非法 task_id 须退 2：${bad}`);
      assert.ok(r.stderr.includes('taskId 非法'));
    }
    const ok = runCli(proj, ['issue-verification', '--task-id', '内部任务-REVIEWFIX-1', '--evidence-file', ev]);
    assert.notEqual(ok.code, 2, '合法 task_id 不得因校验退 2');
  });

  test('test_gate_change_bad_form_exit_2', () => {
    const r = runCli(proj, ['gate', '--task-id', '内部任务-1', '--change', 'foo']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('changeId 非法'));
  });

  test('test_prepare_missing_required_args_exit_2', () => {
    const r = runCli(proj, ['prepare', '--task-id', '内部任务-1', '--applicability-sdd', 'required']);
    assert.equal(r.code, 2);
  });

  test('test_prepare_bad_reasons_json_exit_2', () => {
    const r = runCli(proj, [
      'prepare', '--task-id', '内部任务-1', '--applicability-sdd', 'required',
      '--applicability-ddd', 'tactical', '--applicability-tdd', 'strict',
      '--applicability-reasons', '{not-json',
    ]);
    assert.equal(r.code, 2);
  });

  test('test_finalize_without_gate_exit_1_with_message', () => {
    const r = runCli(proj, ['finalize', '--task-id', '内部任务-404']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('gate'));
  });

  test('test_evidence_file_missing_named_distinctly', () => {
    const r = runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', join(proj, 'no-such.json'),
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('不存在或不可读'));
    assert.ok(r.stderr.includes('JSON 数组'), '附最小合法示例');
  });

  test('test_prepare_bad_reasons_json_names_parameter', () => {
    const r = runCli(proj, [
      'prepare', '--task-id', '内部任务-1', '--applicability-sdd', 'required',
      '--applicability-ddd', 'tactical', '--applicability-tdd', 'strict',
      '--applicability-reasons', '不是JSON',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('--applicability-reasons'));
  });

  test('test_prepare_bad_change_scope_json_names_parameter', () => {
    const r = runCli(proj, [
      'prepare', '--task-id', '内部任务-1', '--applicability-sdd', 'required',
      '--applicability-ddd', 'tactical', '--applicability-tdd', 'strict',
      '--applicability-reasons', '{}', '--change-scope', '{bad',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('--change-scope'));
  });

  test('test_issue_verification_empty_evidence_refused', () => {
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('证据清单为空'));
    assert.ok(r.stderr.includes('--evidence-file'));
  });

  test('test_evidence_file_non_utf8_exit_2', () => {
    const binEv = join(tmp, 'bin-ev.json');
    writeFileSync(binEv, Buffer.from([0xff, 0xfe, 0x00, ...Buffer.from('{"path": "x"}')]));
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', binEv]);
    assert.equal(r.code, 2, '编码不可读是工具错误（2），不是内容阻断（1）');
    assert.ok(r.stderr.includes('不存在或不可读'));
  });

  test('test_evidence_file_bad_json_named_distinctly', () => {
    const bad = join(tmp, 'bad-ev.json');
    writeFileSync(bad, 'not json at all\n', 'utf8');
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', bad]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('不是合法 JSON'));
    assert.ok(!r.stderr.includes('不存在或不可读'), '两类报错不得混同');
  });

  test('test_code_review_unknown_verification_names_expected_form', () => {
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1',
      '--verification', 'receipts/verification-内部任务-1-1.json',
      '--summary', 'x', '--review-instances', '1', '--fix-review-mode', 'none',
      '--review-provenance', provArg('内部任务-1', 1),
    ]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('verification 凭据不存在'));
    assert.ok(r.stderr.includes('非文件路径'));
  });

  test('test_code_review_fix_review_fields_and_required_mode', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const base = 'a'.repeat(40);
    const diff = 'b'.repeat(64);
    const common = ['issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3)];

    const missing = runCli(proj, common);
    assert.equal(missing.code, 2, '--fix-review-mode 必填');
    assert.ok(missing.stderr.includes('--fix-review-mode'));

    const self = expectJson(runCli(proj, [
      ...common, '--fix-review-mode', 'self', '--fix-review-reason', '注释同步',
      '--fix-review-base', base, '--fix-review-diff-sha', diff,
    ]), 0);
    assert.equal(self.fixReviewMode, 'self');
    assert.equal(self.fixReviewInstances, 0);
    assert.equal(self.fixReviewReason, '注释同步');
    assert.equal(self.fixReviewBase, base);
    assert.equal(self.fixReviewDiffSha, diff);

    const delta = expectJson(runCli(proj, [
      ...common, '--fix-review-mode', 'delta', '--fix-review-instances', '1',
      '--fix-review-base', base, '--fix-review-diff-sha', `sha256:${diff}`,
      '--fix-review-provenance', provArg('内部任务-1', 1, 2),
    ]), 0);
    assert.equal(delta.fixReviewMode, 'delta');
    assert.equal(delta.fixReviewDiffSha, diff, 'sha256: 前缀归一');

    const badFull = runCli(proj, [
      ...common, '--fix-review-mode', 'full', '--fix-review-instances', '2',
      '--fix-review-base', base, '--fix-review-diff-sha', diff,
      '--fix-review-provenance', provArg('内部任务-1', 2, 2),
    ]);
    assert.equal(badFull.code, 1, 'full 需 ≥3 实例');

    const noneBase = runCli(proj, [...common, '--fix-review-mode', 'none', '--fix-review-base', base]);
    assert.equal(noneBase.code, 1, 'none 不允许 base');
  });

  test('test_scout_repro_requires_disposition', () => {
    const r = runCli(proj, [
      'issue-verification', '--task-id', '内部任务-2', '--evidence-file', ev, '--profile', 'scout-repro',
    ]);
    assert.equal(r.code, 2, 'scout-repro 缺 mode/disposition 是参数错误');
  });

  test('内部任务-191：非豁免形态缺 --review-provenance → 退 2', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--summary', 's', '--review-instances', '3', '--fix-review-mode', 'none',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('--review-provenance'));
  });

  test('内部任务-191：provenance 非法 JSON / exempt 携带 / fix 缺 provenance → 退 2', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const base = ['issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId, '--fix-review-mode', 'none'];
    const badJson = runCli(proj, [
      ...base, '--review-instances', '3', '--review-provenance', 'not-json',
    ]);
    assert.equal(badJson.code, 2);
    assert.ok(badJson.stderr.includes('合法 JSON'));

    const plans = join(proj, 'docs', 'plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'pure-doc.md'), '# 纯文档计划\n', 'utf8');
    const exemptCarry = runCli(proj, [
      ...base, '--summary', 's', '--review-instances', '0', '--review-mode', 'exempt',
      '--exemption-reason', '纯文档计划豁免', '--plan', '内部计划',
      '--review-provenance', provArg('内部任务-1', 1),
    ]);
    assert.equal(exemptCarry.code, 2, 'exempt 不得携带 provenance');
    assert.ok(exemptCarry.stderr.includes('--review-provenance'));

    const fixMissing = runCli(proj, [
      ...base, '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3),
      '--fix-review-mode', 'delta', '--fix-review-instances', '1',
      '--fix-review-base', 'a'.repeat(40), '--fix-review-diff-sha', 'b'.repeat(64),
    ]);
    assert.equal(fixMissing.code, 2);
    assert.ok(fixMissing.stderr.includes('--fix-review-provenance'));
  });

  test('内部任务-191：--review-round 受理与非法值分层；user-audit 免 provenance', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const base = ['issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId, '--fix-review-mode', 'none'];
    const round2 = expectJson(runCli(proj, [
      ...base, '--review-instances', '3', '--review-round', '2',
      '--review-provenance', provArg('内部任务-1', 3, 2),
    ]), 0);
    assert.equal(round2.reviewRound, 2);
    const badRound = runCli(proj, [
      ...base, '--review-instances', '3', '--review-round', '0',
      '--review-provenance', provArg('内部任务-1', 3),
    ]);
    assert.equal(badRound.code, 1, '--review-round 0 须拒（语义错误退 1）');
    assert.match(badRound.stderr, /reviewRound/, '拒因须指认 reviewRound 字段（T06/内部任务-241）');
    const audit = expectJson(runCli(proj, [
      ...base, '--review-instances', '1', '--review-mode', 'user-audit',
    ]), 0);
    assert.equal(audit.reviewMode, 'user-audit');
    assert.equal(Object.prototype.hasOwnProperty.call(audit, 'reviewProvenance'), false, 'user-audit 不带 provenance');
  });

  test('A11 fix 环形态校验先于 provenance 必填：none+1 退 1 且不误导为缺 provenance', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--summary', 's', '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3),
      '--fix-review-mode', 'none', '--fix-review-instances', '1',
    ]);
    assert.equal(r.code, 1, '模式×实例数形态错误是内容阻断（1），不是缺参工具错误（2）');
    assert.ok(!r.stderr.includes('--fix-review-provenance'), '形态错误不得误报为缺 fix provenance');
    assert.ok(/fixReviewInstances|实例/.test(r.stderr), `stderr 须点名实例数：${r.stderr}`);
  });

  test('A11 full+2（带 base/diff）形态错退 1（先于 fix provenance 必填）', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--summary', 's', '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3),
      '--fix-review-mode', 'full', '--fix-review-instances', '2',
      '--fix-review-base', 'a'.repeat(40), '--fix-review-diff-sha', 'b'.repeat(64),
    ]);
    assert.equal(r.code, 1, 'full 须 ≥3 实例（形态错误退 1）');
    assert.ok(!r.stderr.includes('--fix-review-provenance'), '不得先报缺 fix provenance');
  });

  test('A11 delta/1 缺 --fix-review-provenance 仍退 2（必填检查保留在形态校验之后）', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--summary', 's', '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3),
      '--fix-review-mode', 'delta', '--fix-review-instances', '1',
      '--fix-review-base', 'a'.repeat(40), '--fix-review-diff-sha', 'b'.repeat(64),
    ]);
    assert.equal(r.code, 2, '形态合法而缺必填 provenance 仍为工具错误（2）');
    assert.ok(r.stderr.includes('--fix-review-provenance'));
  });

  test('fix 环 CLI 合法用例：full/3 + fix provenance（round 2 reused）签发通过', () => {
    const v = expectJson(runCli(proj, [
      'issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev, '--profile', 'full',
    ]), 0);
    const c = expectJson(runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--verification', v.receiptId,
      '--summary', 's', '--review-instances', '3', '--review-provenance', provArg('内部任务-1', 3),
      '--fix-review-mode', 'full', '--fix-review-instances', '3',
      '--fix-review-base', 'a'.repeat(40), '--fix-review-diff-sha', `sha256:${'b'.repeat(64)}`,
      '--fix-review-provenance', provArg('内部任务-1', 3, 2, 'reused'),
    ]), 0);
    assert.equal(c.fixReviewMode, 'full');
    assert.equal(c.fixReviewInstances, 3);
    assert.equal(c.fixReviewDiffSha, 'b'.repeat(64), 'sha256: 前缀归一为裸 hex');
    assert.equal(c.fixReviewProvenance.length, 3);
    assert.ok(c.fixReviewProvenance.every((e) => e.state === 'reused'), 'round 2 修复环实例应为 reused（用例名与夹具一致）');
  });
});

describe('CliPathBasisTest', () => {
  let tmp; let proj; let stub;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-path-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
    mkdirSync(join(proj, 'ops'), { recursive: true });
    writeFileSync(join(proj, 'ops', 'record.md'), '# 记录\n', 'utf8');
    writeFileSync(join(proj, 'ev.json'), JSON.stringify(EVIDENCE_ONE), 'utf8');
    writeFileSync(join(proj, 'criteria.json'),
      JSON.stringify([{ criterion: '对拍 0 差异', evidenceRef: 'layout.log' }]), 'utf8');
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(proj, 'docs', 'plans', 'x.md'), '# 计划\n', 'utf8');
  });
  afterEach(() => cleanup(tmp));

  test('test_relative_evidence_file_resolves_under_project_root', () => {
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', 'ev.json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).kind, 'verification');
  });

  test('test_relative_criteria_and_record_resolve_under_project_root', () => {
    expectJson(runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', 'ev.json']), 0);
    const r = runCli(proj, [
      'issue-operation', '--task-id', '内部任务-1',
      '--verification', 'verification-内部任务-1-1',
      '--authorization-quote', '用户当轮指令：执行本机装机',
      '--authorization-scope', '四插件装机',
      '--criteria-file', 'criteria.json',
      '--rollback', '恢复备份', '--boundary', '新会话生效',
      '--record', 'ops/record.md',
    ]);
    assert.equal(r.code, 0, r.stderr);
  });

  test('test_relative_plan_resolves_under_project_root', () => {
    const r = runCli(proj, ['revision', '--plan', '内部计划']);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(jsonOf(r).planSha256, null, 'plan 桶须计入（路径按项目根解析命中真实文件）');
    assert.equal(jsonOf(r).planSha256.path, '内部计划');
  });

  test('test_plan_path_with_dotdot_segments_resolves_under_project_root', () => {
    // 相对路径先拼 --project-root 再 resolve：`..` 段不得按调用方 cwd 折叠。
    const r = runCli(proj, ['revision', '--plan', '内部计划']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).planSha256.path, '内部计划');
  });

  test('test_plan_symlink_resolves_to_target', (t) => {
    // Python Path.resolve() 解析 symlink：JS _underRoot 走 looseRealpath 同口径。
    writeFileSync(join(proj, 'docs', 'plans', 'real.md'), '# 真计划\n', 'utf8');
    try {
      symlinkSync('real.md', join(proj, 'docs', 'plans', 'link.md'));
    } catch (e) {
      t.skip(`symlink 不可用（${e.code}）——win32 权限面，阶段3b 首跑覆盖`);
      return;
    }
    const r = runCli(proj, ['revision', '--plan', '内部计划']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).planSha256.path, '内部计划');
  });

  test('test_evidence_item_missing_field_named_with_index', () => {
    writeFileSync(join(proj, 'ev-bad.json'), JSON.stringify([{ path: 'src/ev.txt', exitCode: 0 }]), 'utf8');
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', 'ev-bad.json']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('第 1 项'));
    assert.ok(r.stderr.includes('JSON 数组'), '附最小合法示例');
  });

  test('test_evidence_item_null_field_rejected', () => {
    writeFileSync(join(proj, 'ev-null.json'),
      JSON.stringify([{ path: null, sha256: null, exitCode: 0 }]), 'utf8');
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', 'ev-null.json']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('第 1 项'));
  });

  test('test_evidence_exit_code_boolean_rejected', () => {
    writeFileSync(join(proj, 'ev-bool.json'),
      JSON.stringify([{ path: 'x', sha256: 'y', exitCode: true }]), 'utf8');
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', 'ev-bool.json']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('exitCode（须为整数）'));
  });
});

describe('CliOperationChainTest', () => {
  let tmp; let proj; let stub; let ev; let criteria;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-ops-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
    mkdirSync(join(proj, 'ops'), { recursive: true });
    writeFileSync(join(proj, 'ops', 'record.md'), '# 记录\n', 'utf8');
    ev = writeEvidence(tmp, [{ path: 'x', sha256: 'y', exitCode: 0 }]);
    criteria = writeCriteria(tmp);
  });
  afterEach(() => cleanup(tmp));

  function issueVerification() {
    expectJson(runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--evidence-file', ev]), 0);
  }

  function issueOperation(extra = []) {
    return runCli(proj, [
      'issue-operation', '--task-id', '内部任务-1',
      '--verification', 'verification-内部任务-1-1',
      '--authorization-quote', '用户当轮指令：执行本机装机',
      '--authorization-scope', '四插件装机',
      '--criteria-file', criteria,
      '--rollback', '恢复备份', '--boundary', '新会话生效',
      '--record', 'ops/record.md',
      ...extra,
    ]);
  }

  test('test_issue_operation_happy_path', () => {
    issueVerification();
    const r = issueOperation();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('"kind": "operation"'));
    assert.ok(r.stdout.includes('"path": "ops/record.md"'));
  });

  test('test_issue_operation_short_quote_exit_1', () => {
    issueVerification();
    const r = issueOperation(['--authorization-quote', '装']);
    assert.equal(r.code, 1);
  });

  test('test_chain_verify_operation_flag_without_receipt_exit_2', () => {
    const r = runCli(proj, ['chain-verify', '--task-id', '内部任务-1', '--operation-chain']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('operation'));
  });

  test('test_chain_flags_mutually_exclusive_exit_2', () => {
    const r = runCli(proj, [
      'chain-verify', '--task-id', '内部任务-1', '--operation-chain', '--deliverable-chain',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('not allowed with'));
  });

  test('test_gate_flags_mutually_exclusive_exit_2', () => {
    const r = runCli(proj, [
      'gate', '--task-id', '内部任务-1', '--operation-chain', '--deliverable-chain',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('not allowed with'));
  });

  test('test_chain_verify_deliverable_flag_without_rings_exit_2', () => {
    const r = runCli(proj, ['chain-verify', '--task-id', '内部任务-1', '--deliverable-chain']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('deliverable'));
  });

  test('test_deliverable_chain_cli_end_to_end', () => {
    issueVerification();
    const c = expectJson(runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1',
      '--verification', 'verification-内部任务-1-1', '--review-instances', '1',
      '--review-mode', 'deliverable', '--fix-review-mode', 'none', '--summary', '渲染验收 14/14',
      '--review-provenance', provArg('内部任务-1', 1),
    ]), 0);
    assert.equal(c.reviewMode, 'deliverable');
    const o = runCli(proj, [
      'issue-operation', '--task-id', '内部任务-1',
      '--verification', 'verification-内部任务-1-1',
      '--authorization-quote', '用户当轮指令：制作 PPT 交付制品',
      '--authorization-scope', '忽略面制品生成',
      '--criteria-file', criteria,
      '--rollback', '删除制品', '--boundary', '本机忽略面',
      '--record', 'ops/record.md', '--risk-level', 'L1',
    ]);
    assert.equal(o.code, 0, o.stderr);
    const r = runCli(proj, ['chain-verify', '--task-id', '内部任务-1', '--deliverable-chain']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).ok, true);
  });

  test('test_issue_operation_default_risk_level_l2', () => {
    issueVerification();
    const r = issueOperation();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('"riskLevel": "L2"'));
  });

  test('test_issue_operation_explicit_l1', () => {
    issueVerification();
    const r = issueOperation(['--risk-level', 'L1', '--authorization-scope', '本机缓存对齐']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('"riskLevel": "L1"'));
  });

  test('test_issue_operation_illegal_risk_level_rejected_by_argparse', () => {
    issueVerification();
    const r = issueOperation(['--risk-level', 'L9']);
    assert.equal(r.code, 2);
  });
});

describe('CliArchiveDispatchTest', () => {
  let tmp; let proj; let stub;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-archive-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
  });
  afterEach(() => cleanup(tmp));

  test('test_cli_default_is_dry_run_outputs_candidates_json', () => {
    mkArchiveTask(proj, '内部任务-60', 200, { withEvidence: true });
    const r = runCli(proj, ['archive-receipts']);
    assert.equal(r.code, 0, r.stderr);
    const out = jsonOf(r);
    assert.deepEqual(out.candidates.map((x) => x.taskId), ['内部任务-60']);
    assert.equal(existsSync(join(proj, '.sdd', 'archive')), false, '缺省 dry-run 零写盘');
  });

  test('test_cli_apply_below_threshold_exits_one', () => {
    mkArchiveTask(proj, '内部任务-61', 200, { withEvidence: true });
    const r = runCli(proj, ['archive-receipts', '--apply']);
    assert.equal(r.code, 1, '未达阈 apply 退 1（内部规则-16 内容/政策阻断分野）');
    assert.ok(r.stderr.includes('阈值未达'));
  });

  test('test_cli_restore_missing_exits_nonzero', () => {
    const r = runCli(proj, ['restore-receipts', '--task-id', '内部任务-99']);
    assert.notEqual(r.code, 0, '未命中归档非零退（内容失败退 1）');
    assert.ok(r.stderr.includes('未命中'));
  });
});

describe('CliScoutDispatchTest', () => {
  let tmp; let proj; let stub;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-scout-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
  });
  afterEach(() => cleanup(tmp));

  test('test_register_returns_zero_with_json', () => {
    const r = runCli(proj, [
      'scout-register', '--task-id', '内部任务-1', '--mode', 'explore',
      '--expiry', future(14), '--transaction-id', 'tx-1', '--event', 'open',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).ok, true);
  });

  test('test_retired_command_returns_two_with_guidance', () => {
    const r = runCli(proj, ['scout-status']);
    assert.equal(r.code, 2, '退役子命令必须退 2（工具参数错误语义）');
    assert.ok(r.stderr.includes('已退役'));
    assert.ok(r.stderr.includes('mode-lifecycle'));
  });

  test('test_graduate_empty_evidence_returns_one', () => {
    const r = runCli(proj, ['scout-graduate', '--task-id', '内部任务-1', '--evidence-refs', '[]']);
    assert.equal(r.code, 1);
    assert.equal(jsonOf(r).ok, false);
  });

  test('test_graduate_non_array_evidence_uses_twin_behavior', () => {
    // '{}' 两侧同走 falsy 守卫并返回 ok:false；非空非数组的 stdout 分叉属已登记边界（计划来源意见处置）
    const r = runCli(proj, ['scout-graduate', '--task-id', '内部任务-1', '--evidence-refs', '{}']);
    assert.equal(r.code, 1);
    assert.equal(jsonOf(r).ok, false);
  });
});

describe('CliParserTest', () => {
  let tmp; let proj; let stub; let ev;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-parser-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
    ev = writeEvidence(tmp);
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(proj, 'docs', 'plans', 'x.md'), '# 计划\n', 'utf8');
  });
  afterEach(() => cleanup(tmp));

  test('global --project-root 仅子命令前受理', () => {
    const r = runCliRaw(['revision', '--project-root', proj]);
    assert.equal(r.code, 2);
  });

  test('--flag=value 形态受理', () => {
    const r = runCli(proj, ['revision', '--plan=内部计划']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).planSha256.path, '内部计划');
  });

  test('不实现 argparse 唯一前缀缩写', () => {
    const r = runCli(proj, ['issue-verification', '--task-i', '内部任务-1', '--evidence-file', ev]);
    assert.equal(r.code, 2, '唯一前缀缩写不在受理面（内部接口-11 已知边界）');
  });

  test('--help 退 0 且非 JSON；子命令 --help 同款', () => {
    for (const argv of [['--help'], ['revision', '--help'], ['-h']]) {
      const r = runCliRaw(argv);
      assert.equal(r.code, 0, JSON.stringify(argv));
      assert.throws(() => JSON.parse(r.stdout), 'help 不做 JSON 承诺');
    }
  });

  test('未知命令退 2', () => {
    const r = runCli(proj, ['no-such-command']);
    assert.equal(r.code, 2);
  });

  test('choices 非法值退 2', () => {
    const r = runCli(proj, ['issue-verification', '--task-id', '内部任务-1', '--profile', 'bogus']);
    assert.equal(r.code, 2);
  });

  test('int 类型非法值退 2', () => {
    const r = runCli(proj, [
      'issue-code-review', '--task-id', '内部任务-1', '--review-instances', 'abc', '--fix-review-mode', 'none',
    ]);
    assert.equal(r.code, 2);
  });

  test('restore-receipts 必选互斥组', () => {
    assert.equal(runCli(proj, ['restore-receipts']).code, 2);
    assert.equal(runCli(proj, ['restore-receipts', '--task-id', 'T', '--batch', 'b']).code, 2);
  });
});

describe('CliKnownQuirksTest', () => {
  let tmp; let proj; let stub; let ev;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-quirk-');
    ({ proj, stub } = makeCliProject(tmp));
    process.env.SG_CORE_VALIDATOR = stub;
    ev = writeEvidence(tmp);
  });
  afterEach(() => cleanup(tmp));

  test('finalize --plan 解析但被忽略（行为冻结回归钉）', () => {
    issueDevChain(proj, ev);
    assert.equal(runCli(proj, ['gate', '--task-id', '内部任务-1']).code, 0);
    const r = runCli(proj, [
      'finalize', '--task-id', '内部任务-1', '--plan', '内部计划',
    ]);
    assert.equal(r.code, 0, `--plan 被忽略（不存在的计划也不阻断）：${r.stderr}`);
    assert.equal(jsonOf(r).finalStatus, 'complete');
  });

  test('archive-receipts --dry-run 在 --apply 下被忽略（行为冻结回归钉）', () => {
    mkArchiveTask(proj, '内部任务-62', 200, { withEvidence: true });
    const r = runCli(proj, ['archive-receipts', '--dry-run', '--apply']);
    assert.equal(r.code, 1, '--apply 生效并受阈值门控（若 --dry-run 优先则退 0 只打印候选）');
    assert.ok(r.stderr.includes('阈值未达'));
  });

  test('gate production config-error 退 2，其余阻断退 1（行为冻结回归钉）', () => {
    const config = runCli(proj, ['gate', '--task-id', '内部任务-404', '--claim', 'deploy-ready']);
    assert.equal(config.code, 2, 'production.status=config-error 归工具/配置错误');
    assert.equal(jsonOf(config).sections.production.status, 'config-error');
    const content = runCli(proj, ['gate', '--task-id', '内部任务-404']);
    assert.equal(content.code, 1, '缺凭据/草案是内容阻断');
  });
});

describe('CliErrorClassificationTest', () => {
  test('classifyCliError 六类映射', () => {
    assert.equal(classifyCliError(new ChainProfileError('x')), 2, 'ChainProfileError→2');
    assert.equal(classifyCliError(new CliToolError('x')), 2, 'CliToolError→2');
    assert.equal(classifyCliError(new CliValueError('x')), 1, 'CliValueError→1');
    assert.equal(classifyCliError(new SyntaxError('x')), 2, 'JSON.parse SyntaxError→2');
    const fsErr = new Error('x');
    fsErr.code = 'ENOENT';
    assert.equal(classifyCliError(fsErr), 2, 'Node fs 错误（有 code）→2');
    for (const code of ['SHORT_WRITE', 'INVALID_UTF8', 'ELOCKED']) {
      const err = new Error(code);
      err.code = code;
      assert.equal(classifyCliError(err), 2, `${code} 工具错误→2（内部任务-241 E02）`);
    }
    assert.equal(classifyCliError(new Error('x')), 1, '其他 Error→1');
  });

  test('reportCliError 前缀区分工具错误与内容阻断', () => {
    const cap = capture();
    assert.equal(reportCliError(new CliToolError('参数坏'), cap.io), 2);
    assert.ok(cap.stderr().startsWith('assurance 工具错误：'));
    const cap2 = capture();
    assert.equal(reportCliError(new CliValueError('内容坏'), cap2.io), 1);
    assert.ok(cap2.stderr().startsWith('assurance：'));
  });
});

describe('GateChangeContextTest (内部任务-241 G02)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-ctx-'); proj = makeCliProject(tmp).proj; });
  afterEach(() => cleanup(tmp));

  test('loadChangeContext：对象受理/空对象/三类报错', () => {
    const good = join(proj, 'ctx.json');
    writeFileSync(good, JSON.stringify({ gateStates: { pr: { mode: 'auto' } }, scoutActive: false }), 'utf8');
    assert.deepEqual(loadChangeContext(good, proj), { gateStates: { pr: { mode: 'auto' } }, scoutActive: false });
    assert.deepEqual(loadChangeContext('', proj), {}, '空路径返回空对象');
    assert.throws(() => loadChangeContext(join(proj, 'nope.json'), proj),
      (e) => e instanceof CliToolError && /不存在或不可读/.test(e.message), '缺文件→工具错误');
    const arr = join(proj, 'ctx-arr.json');
    writeFileSync(arr, JSON.stringify([{ path: 'x', sha256: 'sha256:0', exitCode: 0 }]), 'utf8');
    assert.throws(() => loadChangeContext(arr, proj),
      (e) => e instanceof CliToolError && /顶层必须是对象/.test(e.message), '数组根→退 2 形态错误');
    const broken = join(proj, 'ctx-broken.json');
    writeFileSync(broken, '{not-json', 'utf8');
    assert.throws(() => loadChangeContext(broken, proj),
      (e) => e instanceof CliToolError && /不是合法 JSON/.test(e.message), '坏 JSON→工具错误');
  });

  test('gate --change-context 对象形态不经证据装载（不因装载退 2）', () => {
    const ctx = join(proj, 'ctx-gate.json');
    writeFileSync(ctx, JSON.stringify({ gateStates: {}, changeId: '内部变更-1' }), 'utf8');
    // core 校验器用干净桩：确保若退 2 只可能来自装载路径（G05 后真 core 工具错误本身就退 2）
    const stub = join(proj, 'stub-core-clean.mjs');
    writeFileSync(stub, 'process.stdout.write(JSON.stringify({ schemaVersion: "1.0.0", mode: "suite", filesChecked: 0, blockingCount: 0, warningCount: 0, diagnostics: [] }));\n', 'utf8');
    const old = process.env.SG_CORE_VALIDATOR;
    process.env.SG_CORE_VALIDATOR = stub;
    try {
      const r = runCli(proj, ['gate', '--task-id', '内部任务-1', '--change-context', ctx]);
      const report = JSON.parse(r.stdout);
      assert.ok(report.sections, '对象形态须进入 gate 并输出报告');
      assert.equal(r.stderr.includes('--change-context 顶层必须是对象'), false, '不得因装载形态报错');
    } finally {
      if (old === undefined) delete process.env.SG_CORE_VALIDATOR; else process.env.SG_CORE_VALIDATOR = old;
    }
  });

  test('gate --change-context 根为数组：退 2 且点名参数', () => {
    const ctx = join(proj, 'ctx-bad.json');
    writeFileSync(ctx, JSON.stringify([{ path: 'x', sha256: 'sha256:0', exitCode: 0 }]), 'utf8');
    const r = runCli(proj, ['gate', '--task-id', '内部任务-1', '--change-context', ctx]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--change-context/);
    assert.match(r.stderr, /顶层必须是对象/);
  });

  test('G05（内部任务-241）：gate 遇 core 工具错误 → 退出码 2（blocking 报告但工具错误分层）', () => {
    const stub = join(proj, 'stub-core-error.mjs');
    writeFileSync(stub, "process.stdout.write(JSON.stringify({ error: 'core down' }));\nprocess.exit(2);\n", 'utf8');
    const old = process.env.SG_CORE_VALIDATOR;
    process.env.SG_CORE_VALIDATOR = stub;
    try {
      const r = runCli(proj, ['gate', '--task-id', '内部任务-1']);
      assert.equal(r.code, 2, `工具错误须退 2（stderr: ${r.stderr}）`);
      const report = JSON.parse(r.stdout);
      assert.ok(report.diagnostics.some((d) => d.toolError === true), '报告须保留 toolError 标记');
    } finally {
      if (old === undefined) delete process.env.SG_CORE_VALIDATOR; else process.env.SG_CORE_VALIDATOR = old;
    }
  });

  test('T05（内部任务-241）：issue-inspection 成功路径字段', () => {
    const r = runCli(proj, ['issue-inspection', '--task-id', '内部任务-1', '--scope', '用户点名审计']);
    assert.equal(r.code, 0, r.stderr);
    const rec = jsonOf(r);
    assert.equal(rec.kind, 'inspection-only');
    assert.equal(rec.scope, '用户点名审计');
    assert.equal(rec.status, 'passed');
  });

  test('T05（内部任务-241）：scout-repro 档成功路径落 scout 字段', () => {
    const ev = writeEvidence(tmp);
    const r = runCli(proj, [
      'issue-verification', '--task-id', '内部任务-2', '--evidence-file', ev, '--profile', 'scout-repro',
      '--scout-mode', 'explore', '--scout-disposition', '一次探针产物丢弃',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const rec = jsonOf(r);
    assert.equal(rec.evidenceProfile, 'scout-repro');
    assert.deepEqual(rec.scout, { mode: 'explore', disposition: '一次探针产物丢弃' });
  });
});
