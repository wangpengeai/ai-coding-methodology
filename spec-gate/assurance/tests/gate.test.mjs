// 文件：gate.test.mjs
// 描述：gate.mjs 永久单测（内部任务-92 阶段3a W1；对齐 spec-gate/assurance/tests/test_gate.py
//       12 类/60 方法逐类移植）——聚合 gate 的节顺序/计数口径/凭据签发、plan 绑定与降级、
//       revision 双算、ledger/boundary/ifDrift、receipts 三形态（dev/operation/deliverable）、
//       L1 免两阶段、操作断言分级、评审覆盖与豁免呈现。另加已知怪癖回归钉：
//       defaultPlanRunner 不识别 {"error":...}、warningCount 不含 governance/production/planBinding。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { STEP_HEADING_RE } from '../../core/validator/core/plan_check.mjs';
import { finalizeDelivery, prepareDelivery } from '../delivery_reports.mjs';
import {
  ChainProfileError, _testHooks as _receiptsHooks, integrity, issueCodeReviewReceipt, issueOperationReceipt,
  issueVerificationReceipt, latestReceipt, reviewProvenanceStatusOf,
} from '../receipts.mjs';
import { defaultPlanRunner } from '../core-runner.mjs';
import {
  _checkExemptions, _checkReceipts, _checkReviewCoverage, _stepHeadingRe, defaultCoreRunner, runGate, scoutActive,
} from '../gate.mjs';
import {
  app, cleanup, evidenceEntry, exemptionLine, fakeCore, fakePlanRunner, makeProject, makeRecord,
  opCriteria, prepareChain, readJson, receiptFiles, tmpRoot, writeExemptionStore, writeLegacyDraft,
  writePlan,
} from './gate-fixtures.mjs';
import { prov } from './provenance-fixtures.mjs';
import { register as scoutRegister } from '../scout_transactions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 该任务已签发的 gate 凭据文件（按名排序）。 */
function gateFiles(proj, task) {
  return receiptFiles(proj, task, 'gate');
}

/** 报告顶层诊断中的 ruleId 集合。 */
function ruleIds(report) {
  return new Set((report.diagnostics ?? []).map((d) => d.ruleId));
}

/** 写一个由 node 执行的假校验器脚本（CJS；用于 runner 错误/超时映射的确定性夹具）。 */
function writeFakeValidator(dir, body) {
  const path = join(dir, 'fake-validator.cjs');
  writeFileSync(path, body, 'utf8');
  return path;
}

/** 写文件前建父目录（嵌套夹具路径用）。 */
function writeNested(path, data, encoding = 'utf8') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, encoding);
}

describe('GateAggregationTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-agg-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_zero_blocking_issues_gate_receipt', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 0);
    assert.notEqual(report.gateReceipt, null);
    assert.equal(latestReceipt(proj, '内部任务-1', 'gate').status, 'passed');
  });

  test('test_empty_evidence_verification_warns_not_blocks', () => {
    // 内部任务-41 #4：存量空证据 verification 凭据 → RULE-GATE-EMPTYEVIDENCE warning（非阻断）。
    prepareChain(proj);
    const [vfile] = receiptFiles(proj, '内部任务-1', 'verification');
    const path = join(proj, '.sdd', 'receipts', '内部任务-1', vfile);
    const data = readJson(path);
    data.evidenceRefs = [];
    data.integritySha256 = integrity(data);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 0, '存量空证据只警告不阻断');
    assert.ok(report.sections.receipts.warningCount >= 1);
    assert.ok(JSON.stringify(report).includes('RULE-GATE-EMPTYEVIDENCE'));
  });

  test('test_core_blocking_blocks_gate', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore({ blocking: 1 }) });
    assert.ok(report.blockingCount > 0);
    assert.equal(report.gateReceipt, null);
    assert.deepEqual(gateFiles(proj, '内部任务-1'), []);
  });

  test('test_core_runner_timeout_blocking_diagnostic', () => {
    // 2026-09-19 评审修复 3.2 等价面：校验器超时产具名 blocking 诊断，不裸崩。
    const validator = writeFakeValidator(tmp, 'setTimeout(() => process.exit(0), 60000);\n');
    const report = defaultCoreRunner(proj, {
      python: { cmd: process.execPath, args: [] },
      validatorPath: validator,
      timeoutMs: 200,
    });
    assert.equal(report.blockingCount, 1);
    assert.equal(report.diagnostics[0].ruleId, 'RULE-GATE-CORE-TIMEOUT');
    assert.ok(report.diagnostics[0].fixHint.includes('超时'));
  });

  test('test_missing_delivery_draft_blocks', () => {
    const ev = evidenceEntry(proj);
    const v = issueVerificationReceipt(proj, '内部任务-1', ev, { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3 });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.blockingCount > 0);
    // T06（内部任务-241）：删掉 JSON.stringify(report).includes('delivery') 恒真断言——断到交付节语义。
    assert.equal(report.sections.delivery.present, false, '草案缺失时交付节 present=false');
    assert.ok(report.sections.delivery.blockingCount >= 1, '草案缺失须以交付节阻断呈现');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-DELIVERY'), '须产具名交付节诊断');
  });

  test('test_missing_required_sections_warns_not_blocks', () => {
    // 内部未决-8/内部规则-12：必检节缺失 → warning（呈现），gate receipt 仍可签发（finalize 才拒绝）。
    const ev = evidenceEntry(proj);
    const v = issueVerificationReceipt(proj, '内部任务-1', ev, { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3 });
    writeLegacyDraft(proj, '内部任务-1');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 0, '必检节缺失不阻断 gate（内部规则-12：缺失即 partial 非 blocking）');
    assert.ok(report.warningCount > 0);
    assert.equal(report.sections.delivery.warningCount, 3, '三必检节各一条 warning');
    const sectionDiags = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-DELIVERY-SECTION');
    assert.equal(sectionDiags.length, 3, '节级诊断合并进顶层（sections 剥 diagnostics 键的既有口径）');
    assert.notEqual(report.gateReceipt, null, 'gate receipt 仍签发（finalize 层才拒绝落地）');
  });

  test('test_invalid_receipt_chain_blocks', () => {
    prepareChain(proj);
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8'); // 源码变化
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.blockingCount > 0);
    assert.equal(report.gateReceipt, null);
  });

  test('test_revision_changed_during_gate_blocks', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(),
      midHook: () => writeFileSync(join(proj, 'src', 'a.py'), 'mid-gate\n', 'utf8'),
    });
    assert.ok(report.blockingCount > 0);
    assert.ok(report.diagnostics.some((d) => String(d.ruleId).includes('REVISION_CHANGED')));
  });

  test('test_plan_check_block_on_explicit_plan', () => {
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const runner = fakePlanRunner([{
      ruleId: 'RULE-PLAN-002', severity: 'blocking', file: plan, line: 2, fixHint: '悬空引用',
    }]);
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: true, planRunner: runner,
    });
    assert.ok(report.blockingCount > 0);
    assert.equal(report.gateReceipt, null);
  });

  test('test_plan_check_block_off_only_warns', () => {
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const runner = fakePlanRunner([{
      ruleId: 'RULE-PLAN-002', severity: 'blocking', file: plan, line: 2, fixHint: '悬空引用',
    }]);
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: false, planRunner: runner,
    });
    assert.equal(report.blockingCount, 0, 'planCheckBlock 关闭时仅提醒（内部规则-6 语义）');
    assert.ok(report.warningCount > 0);
  });

  test('test_plan_runner_tool_error_blocks_and_not_downgraded', () => {
    // G01（内部任务-241）：plan 校验器工具错误（{"error":...} 或缺 diagnostics 数组）必须阻断，
    // 且不可被 planCheckBlock 提醒档降级——否则 gate 会把「没检查」当成「检查干净」并签发凭据。
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const errRunner = () => ({ error: 'plan config bad' });
    const off = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: false, planRunner: errRunner,
    });
    assert.ok(off.blockingCount > 0, '工具错误必须阻断（不可因提醒档放行）');
    assert.equal(off.gateReceipt, null, '工具错误不得签 gate 凭据');
    const diag = off.diagnostics.find((d) => d.ruleId === 'RULE-GATE-PLAN');
    assert.ok(diag, '须产 RULE-GATE-PLAN 诊断');
    assert.equal(diag.severity, 'blocking');
    assert.equal(diag.toolError, true);
    const on = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: true, planRunner: errRunner,
    });
    assert.ok(on.blockingCount > 0, '开启档同样阻断（对照）');
    const malformed = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: false, planRunner: () => ({ blockingCount: 0 }),
    });
    assert.ok(malformed.blockingCount > 0, '形态异常（缺 diagnostics 数组）也必须阻断');
    assert.equal(malformed.diagnostics.find((d) => d.ruleId === 'RULE-GATE-PLAN')?.toolError, true);
  });

  test('test_governance_required_config_wires_through', () => {
    // G03（内部任务-241）：内部治理状态 的 governanceRequired 必须真实接线——旧实现
    // loadConfig 只拷 DEFAULT_CONFIG 白名单键，该键被静默丢弃→required 恒 false。
    prepareChain(proj);
    const cfgPath = join(proj, '.sdd', 'assurance.json');
    writeFileSync(cfgPath, JSON.stringify({ governanceRequired: true }), 'utf8');
    const on = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(on.sections.governance.blockingCount >= 1, 'required=true 且缺治理报告→阻断');
    assert.ok(on.blockingCount > 0);
    assert.equal(on.gateReceipt, null);
    writeFileSync(cfgPath, JSON.stringify({ governanceRequired: false }), 'utf8');
    const off = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(off.sections.governance.blockingCount, 0, 'required=false 不阻断');
    writeFileSync(cfgPath, JSON.stringify({ governanceRequired: 'yes' }), 'utf8');
    const bad = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(bad.sections.governance.blockingCount, 0, '坏类型按缺省 false 降级');
  });

  test('test_plan_downgrade_rewrites_diag_severity_too', () => {
    // S2（2026-09-16 批次）：降级时诊断 severity 同步重写——混合 severity 计数与诊断同口径。
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const runner = fakePlanRunner([
      { ruleId: 'RULE-PLAN-002', severity: 'blocking', file: plan, line: 2, fixHint: '悬空引用' },
      { ruleId: 'RULE-PLAN-001', severity: 'warning', file: plan, line: 5, fixHint: '步骤无验收' },
    ]);
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), planPath: plan, planCheckBlock: false, planRunner: runner,
    });
    const section = report.sections.plan;
    assert.equal(section.blockingCount, 0);
    assert.equal(section.warningCount, 2, '降级后计数含被降级 blocking + 原生 warning（混合场景同口径）');
    const planDiagsOut = report.diagnostics.filter((d) => d.ruleId === 'RULE-PLAN-002');
    assert.equal(planDiagsOut.length, 1);
    assert.equal(planDiagsOut[0].severity, 'warning', '降级后诊断 severity 与计数同口径');
    assert.equal(planDiagsOut[0].downgradedFrom, 'blocking', '降级来源留痕可审计');
  });

  test('test_core_plan_section_historical_scope_downgrade', () => {
    // S2 乙案：core 报告内嵌 plan 节在 /gate 呈现层归一（scope=historical/current）。
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const runner = fakeCore({
      filesChecked: 3,
      plan: {
        checked: 3,
        blockingCount: 2,
        warningCount: 0,
        diagnostics: [
          { ruleId: 'RULE-PLAN-001', severity: 'blocking', file: '内部计划', line: 2, fixHint: '悬空引用' },
          { ruleId: 'RULE-PLAN-001', severity: 'blocking', file: plan, line: 3, fixHint: '悬空引用' },
        ],
      },
    });
    const report = runGate(proj, '内部任务-1', {
      coreRunner: runner, planPath: plan, planCheckBlock: false, planRunner: fakePlanRunner(),
    });
    const corePlan = report.sections.core.plan;
    assert.equal(corePlan.blockingCount, 0, '呈现层归一：不再以 blocking 字样与顶层打架');
    const byFile = Object.fromEntries(corePlan.diagnostics.map((d) => [String(d.file), d]));
    assert.equal(byFile['内部计划'].scope, 'historical');
    assert.ok(report.planSectionPolicy, '报告须带 plan 节口径说明字段（S2）');
  });

  test('test_report_sections_fixed_order_and_diagnostics_stripped', () => {
    // 报告形状钉：12 节固定顺序；每节剥 diagnostics；顶层保留 diagnostics 与 planSectionPolicy。
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.deepEqual(Object.keys(report.sections), [
      'core', 'plan', 'ledger', 'boundary', 'ifDrift', 'delivery', 'receipts',
      'reviewCoverage', 'production', 'governance', 'exemptions', 'planBinding', 'exemptAnchor',
    ]);
    for (const [name, section] of Object.entries(report.sections)) {
      assert.equal(Object.hasOwn(section, 'diagnostics'), false, `${name} 节须剥 diagnostics`);
    }
    assert.ok(Array.isArray(report.diagnostics));
    assert.equal(report.schemaVersion, '2.0.0');
    assert.equal(typeof report.planSectionPolicy, 'string');
  });

  test('test_warning_count_excludes_governance_production_plan_binding', () => {
    // 已知怪癖回归钉：顶层 warningCount 只加 core/plan/ledger/boundary/ifDrift/
    // delivery/receipts/reviewCoverage/exemptions——governance/production/planBinding 不计。
    prepareChain(proj);
    writeNested(join(proj, '.ai-governance', 'runtime', 'reports', 'governance-report.json'), '{broken');
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), claim: 'deploy-ready', change: '内部变更-99',
    });
    assert.equal(report.sections.governance.blockingCount, 1);
    assert.equal(report.sections.governance.warningCount, 0);
    assert.equal(report.sections.production.warningCount, 0);
    assert.equal(report.sections.planBinding.warningCount, 0);
    assert.equal(report.warningCount, 0, '顶层 warningCount 不含 governance/production/planBinding');
    assert.ok(ruleIds(report).has('RULE-GATE-GOVERNANCE'));
  });
});

describe('GateLedgerTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-ledger-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_missing_ledger_is_not_blocking', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.ledger.present, false);
    assert.equal(report.blockingCount, 0);
  });
});

describe('PlanBindingAndBoundaryShapeTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-planbind-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_gate_boundaries_malformed_config_diagnostic', () => {
    writeFileSync(join(proj, '.sdd', 'project.json'),
      JSON.stringify({ boundaries: 'src 不许 import tests' }), 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.boundary.blockingCount, 1);
    const diag = report.diagnostics.find((d) => d.ruleId === 'RULE-BOUND-CHECK');
    assert.ok(diag.fixHint.includes('boundaries 配置非法'));
    assert.ok(diag.fixHint.includes('BOUND-1')); // 合法形态样例片段
    assert.equal(diag.fixHint.includes('object has no attribute'), false);
  });

  test('test_gate_project_json_non_object_root_blocks', () => {
    writeFileSync(join(proj, '.sdd', 'project.json'), '[]', 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.boundary.blockingCount, 1);
    const diag = report.diagnostics.find((d) => d.ruleId === 'RULE-BOUND-CHECK');
    assert.ok(diag.fixHint.includes('project.json 根须为对象'));
    assert.equal(report.gateReceipt, null, '不得静默放行签发');
  });

  test('test_gate_plan_binding_mismatch_blocks', () => {
    const planA = writePlan(proj, 'plan-a.md');
    const planB = writePlan(proj, 'plan-b.md');
    prepareChain(proj, '内部任务-1', { planPath: planA });
    const report = runGate(proj, '内部任务-1', {
      planPath: planB, coreRunner: fakeCore(), planRunner: fakePlanRunner(),
    });
    assert.ok(report.blockingCount >= 1);
    const rules = ruleIds(report);
    assert.ok(rules.has('RULE-GATE-PLANBINDING'));
    const hint = report.diagnostics.find((d) => d.ruleId === 'RULE-GATE-PLANBINDING').fixHint;
    assert.ok(hint.includes('不一致'));
    assert.ok(hint.includes('重签 verification')); // 两条出路之一在文案中
    assert.equal(report.gateReceipt, null);
  });

  test('test_gate_plan_binding_equal_explicit_passes', () => {
    const planA = writePlan(proj, 'plan-a.md');
    prepareChain(proj, '内部任务-1', { planPath: planA });
    const report = runGate(proj, '内部任务-1', {
      planPath: planA, coreRunner: fakeCore(), planRunner: fakePlanRunner(),
    });
    assert.equal(report.blockingCount, 0);
    assert.equal(report.planBinding.source, 'chain');
    assert.notEqual(report.gateReceipt, null);
  });

  test('test_gate_core_error_report_blocks_not_passes', () => {
    // core 校验器 exit 2 的可解析 {"error":...} 形态不得静默透传。
    writeFileSync(join(proj, '.sdd', 'suite.json'),
      '{"documents": [], "exemptions": "ledger 里说了"}', 'utf8');
    const validator = writeFakeValidator(tmp,
      "process.stdout.write(JSON.stringify({ error: 'unrecognized field: exemptions' }));\nprocess.exit(2);\n");
    const report = defaultCoreRunner(proj, {
      python: { cmd: process.execPath, args: [] }, validatorPath: validator, timeoutMs: 10_000,
    });
    assert.equal(report.blockingCount, 1);
    assert.equal(report.diagnostics[0].ruleId, 'RULE-GATE-CORE');
    assert.ok(report.diagnostics[0].fixHint.includes('配置错误'));
    assert.ok(report.diagnostics[0].fixHint.includes('exemptions'));
  });

  test('test_gate_effective_plan_inherited_and_finalize_converges', () => {
    const planA = writePlan(proj, 'plan-a.md');
    prepareChain(proj, '内部任务-1', { planPath: planA });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() }); // 不带 --plan
    assert.equal(report.blockingCount, 0, JSON.stringify(report.diagnostics));
    assert.equal(report.planBinding.source, 'chain');
    assert.equal(report.revision.planSha256.path, 'plan-a.md');
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
  });

  test('test_gate_unbound_chain_explicit_plan_check_only', () => {
    const planA = writePlan(proj, 'plan-a.md');
    prepareChain(proj); // 链未绑计划
    const report = runGate(proj, '内部任务-1', {
      planPath: planA, coreRunner: fakeCore(), planRunner: fakePlanRunner(),
    });
    assert.equal(report.blockingCount, 0);
    assert.equal(report.planBinding.source, 'explicit-check-only');
    assert.equal(report.revision.planSha256, null); // 凭据口径=链自述（未绑定）
    assert.equal(report.sections.plan.checked, 1); // 检查面仍跑显式计划
  });
});

describe('GateRevisionStampTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-revstamp-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_gate_receipt_revision_equals_report_revision', () => {
    // 绑定计划使 revAfter 携带 planSha256：盖章若在签发点丢 plan 重算（或误用其它 revision
    // 口径），本断言即红——钉住「盖章 revision 必须就是报告的双算结果（含 effectivePlan）」。
    const planA = writePlan(proj, 'plan-a.md');
    prepareChain(proj, '内部任务-1', { planPath: planA });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 0);
    assert.equal(report.revision.planSha256.path, 'plan-a.md');
    const gate = latestReceipt(proj, '内部任务-1', 'gate');
    assert.deepEqual(gate.revision, report.revision, '盖章 revision 必须就是报告的双算结果');
  });
});

describe('GateBoundaryIfDriftTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-drift-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_sections_present_and_drift_blocks', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok('boundary' in report.sections);
    assert.ok('ifDrift' in report.sections);
    // 伪造漂移：active IF 登记哈希与工件不符 → gate 阻断且不签 receipt
    writeNested(join(proj, 'artifact.md'), 'v1\n');
    writeNested(join(proj, 'specs', 'interfaces', '内部接口-99.md'),
      'lifecycle：active\n\n| 工件 | 路径 | sha256 | \n|---|---|---|\n'
      + '| a | `artifact.md` | sha256:0000000000000000 |\n');
    const report2 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report2.blockingCount > 0, 'active IF 工件漂移必须阻断 gate');
    assert.equal(report2.gateReceipt, null);
  });
});

describe('GateIfDriftMalformedTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-ifdrift-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  /** 写登记工件并返回其实读字节 sha256（对齐 `_write_artifact`）。 */
  function writeArtifact(text = 'v1\n') {
    const artifact = join(proj, 'artifact.md');
    writeFileSync(artifact, text, 'utf8');
    return createHash('sha256').update(readFileSync(artifact)).digest('hex');
  }

  function writeIf(lifecycleLine, table) {
    writeNested(join(proj, 'specs', 'interfaces', '内部接口-1.md'), `${lifecycleLine}\n\n${table}`);
  }

  test('test_bold_lifecycle_is_checked_and_drift_blocks', () => {
    prepareChain(proj);
    const digest = writeArtifact();
    writeIf(
      '- lifecycle：**active**（2026-10-14 激活）',
      `| 工件 | 路径 | sha256 |\n|---|---|---|\n| a | \`artifact.md\` | sha256:${digest} |\n`,
    );
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.ifDrift.blockingCount, 0, '加粗 active+登记吻合必须通过');
    writeFileSync(join(proj, 'artifact.md'), 'v2\n', 'utf8');
    const report2 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report2.sections.ifDrift.blockingCount > 0, '加粗 active 的漂移必须阻断');
  });

  test('test_triple_emphasis_active_is_checked', () => {
    prepareChain(proj);
    const digest = writeArtifact();
    writeIf(
      '- lifecycle：***active***（bold+italic）',
      `| 工件 | 路径 | sha256 |\n|---|---|---|\n| a | \`artifact.md\` | sha256:${digest} |\n`,
    );
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.ifDrift.blockingCount, 0, '三重强调 active+登记吻合必须通过');
    writeFileSync(join(proj, 'artifact.md'), 'v2\n', 'utf8');
    const report2 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report2.sections.ifDrift.blockingCount > 0, '三重强调 active 的漂移必须阻断');
  });

  test('test_full_64_hex_accepted_and_short_rejected', () => {
    prepareChain(proj);
    const digest64 = writeArtifact();
    writeIf(
      'lifecycle：active',
      `| 工件 | 路径 | sha256 |\n|---|---|---|\n| a | \`artifact.md\` | sha256:${digest64} |\n`,
    );
    const r64 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(r64.sections.ifDrift.blockingCount, 0, '64 位登记必须通过');
    writeIf(
      'lifecycle：active',
      `| 工件 | 路径 | sha256 |\n|---|---|---|\n| a | \`artifact.md\` | sha256:${digest64.slice(0, 15)} |\n`,
    );
    const r15 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(r15.sections.ifDrift.blockingCount > 0, '15 位登记必须阻断');
  });

  test('test_unparseable_lifecycle_warns_not_silent', () => {
    prepareChain(proj);
    writeIf('- lifecycle：frozen', '| 工件 | 路径 | sha256 |\n|---|---|---|\n');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.sections.ifDrift.warningCount >= 1, '不可解析状态必须告警');
  });

  test('test_known_inactive_lifecycle_stays_silent', () => {
    prepareChain(proj);
    writeIf('- lifecycle：**proposed**（评审中）', '| 工件 | 路径 | sha256 |\n|---|---|---|\n');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.ifDrift.warningCount, 0);
    assert.equal(report.sections.ifDrift.blockingCount, 0);
  });

  test('test_active_but_zero_checks_warns', () => {
    prepareChain(proj);
    writeIf('lifecycle：active', '| 工件 | 路径 | sha256 |\n|---|---|---|\n');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.sections.ifDrift.warningCount >= 1, '守护空转必须可见');
  });
});

describe('GateExemptionsTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-exempt-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_missing_store_yields_empty_section', () => {
    const section = _checkExemptions(proj, '内部任务-1');
    assert.equal(section.present, false);
    assert.equal(section.blockingCount, 0);
    assert.equal(section.warningCount, 0);
    assert.deepEqual(section.diagnostics, []);
  });

  test('test_fresh_record_presented_as_warning_and_receipt_still_issued', () => {
    // 豁免工件先落盘再签凭据链：凭据 revision 覆盖写入后状态（.workflow 计入 revision 双算）。
    writeExemptionStore(proj, [exemptionLine('内部任务-1', '用户明示跳过 plan-review')]);
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 0, '豁免呈现恒 warning，不得阻断');
    assert.notEqual(report.gateReceipt, null, 'blocking==0 时 receipt 照常签发');
    const exemptDiags = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-EXEMPTIONS');
    assert.equal(exemptDiags.length, 1);
    assert.equal(exemptDiags[0].severity, 'warning');
    assert.ok(exemptDiags[0].message.includes('跳过 plan-review'));
    assert.equal(report.sections.exemptions.warningCount, 1);
    assert.equal(report.warningCount, 1, 'fixture 下唯一 warning 来源即豁免节');
  });

  test('test_now_does_not_override_exemption_clock', () => {
    writeExemptionStore(proj, [exemptionLine('内部任务-1', '未来 now 仍按真实时钟')]);
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), now: '2099-01-01T00:00:00+00:00',
    });
    assert.equal(report.sections.exemptions.warningCount, 1, 'now 不得注入豁免时钟');
  });

  test('test_other_task_not_presented', () => {
    writeExemptionStore(proj, [exemptionLine('TASK-OTHER', '他任务豁免')]);
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.sections.exemptions.warningCount, 0);
    assert.deepEqual(report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-EXEMPTIONS'), []);
    assert.equal(report.warningCount, 0);
  });

  test('test_stale_record_beyond_24h_not_presented', () => {
    writeExemptionStore(proj, [exemptionLine('内部任务-1', '陈旧豁免', { tsOffsetMs: -25 * 3600 * 1000 })]);
    const section = _checkExemptions(proj, '内部任务-1');
    assert.equal(section.present, true);
    assert.equal(section.warningCount, 0);
    assert.deepEqual(section.diagnostics, []);
  });

  test('test_bad_lines_tolerated', () => {
    writeExemptionStore(proj, [
      'not-json{{{',
      JSON.stringify({ id: 'ex-x', ts: 1 }), // 缺核心字段
      exemptionLine('内部任务-1', '唯一有效行'),
    ]);
    const section = _checkExemptions(proj, '内部任务-1');
    assert.equal(section.present, true);
    assert.equal(section.warningCount, 1);
    assert.equal(section.diagnostics.length, 1);
  });

  test('test_same_id_last_write_wins', () => {
    const reason = '同理由豁免';
    writeExemptionStore(proj, [
      exemptionLine('内部任务-1', reason, { src: 'user' }),
      exemptionLine('内部任务-1', reason, { src: 'preauthorized' }),
    ]);
    const section = _checkExemptions(proj, '内部任务-1');
    assert.equal(section.warningCount, 1, '同 id 去重后只呈现末条');
    assert.ok(section.diagnostics[0].message.includes('preauthorized'));
  });

  test('test_corrupt_bytes_store_yields_empty_section_without_crash', () => {
    // R1 回归：文件损坏（非法 UTF-8）是呈现节的合法空态（内部接口-20 §3），gate 不得崩溃。
    // 内部任务-265：反堵节按 ADR D6.3 fail-closed（present=false/unreadable=true/bad-record）；
    // 两层语义拆断言，禁止把 unreadable 降级修绿。
    const store = join(proj, '.workflow', 'wf-exemptions.jsonl');
    writeNested(store, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${exemptionLine('内部任务-1', '不可解码行')}\n`, 'utf8'),
    ]));
    const section = _checkExemptions(proj, '内部任务-1');
    assert.deepEqual(section, { present: false, blockingCount: 0, warningCount: 0, diagnostics: [] });
    // 全链路：呈现节仍空、反堵节 fail-closed、不签 receipt
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(report.blockingCount, 1);
    assert.equal(report.sections.exemptions.warningCount, 0);
    assert.deepEqual(report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-EXEMPTIONS'), []);
    assert.equal(report.sections.exemptAnchor.present, false);
    assert.equal(report.sections.exemptAnchor.unreadable, true);
    assert.equal(report.sections.exemptAnchor.blockingCount, 1);
    assert.equal(report.gateReceipt, null, '反堵 blocking 时不签 gate receipt');
  });
});

describe('GateExemptAnchorTest', () => {
  let tmp; let proj;
  const PLAN = '内部计划';
  const rec = (over = {}) => exemptionLine('内部任务-1', '跳过评审直接做', {
    skill: 'plan-execution', schemaVersion: 2, scope: 'review', planPath: PLAN, ...over,
  });
  const planAbs = () => join(proj, PLAN);
  const writeAnchorPlan = (body = '---\nspecRefs: [内部需求-7]\n---\n# P\n\n豁免引文：跳过评审直接做\n') =>
    writePlan(proj, PLAN, body);
  beforeEach(() => { tmp = tmpRoot('dev265-gate-anchor-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('exemptAnchor 四态与 v1 兼容', () => {
    // v1 记录：present=false、0 阻断、receipt 照发
    writeExemptionStore(proj, [exemptionLine('内部任务-1', '旧记录', { skill: 'verification' })]);
    prepareChain(proj);
    const v1 = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(v1.sections.exemptAnchor.present, false);
    assert.equal(v1.sections.exemptAnchor.blockingCount, 0);
    assert.notEqual(v1.gateReceipt, null);
    rmSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), { force: true });
    // v2 scope=plan 无计划：no-plan blocking
    writeExemptionStore(proj, [rec({ scope: 'plan', planPath: null })]);
    prepareChain(proj);
    const noPlan = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(noPlan.sections.exemptAnchor.present, true);
    assert.equal(noPlan.sections.exemptAnchor.blockingCount, 1);
    assert.equal(noPlan.gateReceipt, null);
    rmSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), { force: true });
    // v2 scope=plan + 追溯计划 marker：0 阻断
    writeAnchorPlan();
    writeExemptionStore(proj, [rec({ scope: 'plan', planPath: null })]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const pass = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(pass.sections.exemptAnchor.blockingCount, 0);
    assert.notEqual(pass.gateReceipt, null);
    rmSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), { force: true });
    // v2 scope=review 计划路径不符：plan-mismatch
    writeAnchorPlan();
    writeExemptionStore(proj, [rec({ planPath: '内部计划' })]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const mismatch = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(mismatch.sections.exemptAnchor.blockingCount, 1);
    assert.match(mismatch.diagnostics.find((d) => d.ruleId === 'RULE-GATE-EXEMPT-ANCHOR').message, /plan-mismatch|计划路径/);
  });

  test('exemptAnchor：marker 缺失/围栏内不计/最新 ts 选路', () => {
    writePlan(proj, PLAN, '---\nspecRefs: [内部需求-7]\n---\n# P\n');
    writeExemptionStore(proj, [rec()]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const noQuote = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(noQuote.sections.exemptAnchor.blockingCount, 1);
    assert.match(noQuote.diagnostics.find((d) => d.ruleId === 'RULE-GATE-EXEMPT-ANCHOR').message, /no-quote|引文/);
    rmSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), { force: true });
    writePlan(proj, PLAN, '---\nspecRefs: [内部需求-7]\n---\n# P\n\n```\n豁免引文：跳过评审直接做\n```\n');
    writeExemptionStore(proj, [rec()]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const fenced = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(fenced.sections.exemptAnchor.blockingCount, 1, '围栏内 marker 不计');
    rmSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), { force: true });
    writeAnchorPlan();
    writeExemptionStore(proj, [
      rec({ scope: 'plan', planPath: null, ts: Date.now() - 10000 }),
      rec({ ts: Date.now() }),
    ]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const latest = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(latest.sections.exemptAnchor.blockingCount, 0, '取 ts 最大的 review 记录');
  });

  test('exemptAnchor：bad-record/unparsable/revoked', () => {
    writeExemptionStore(proj, [rec({ scope: 'bogus' })]);
    prepareChain(proj);
    const bad = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(bad.sections.exemptAnchor.blockingCount, 1);
    assert.match(bad.diagnostics.find((d) => d.ruleId === 'RULE-GATE-EXEMPT-ANCHOR').message, /bad-record/);
    // 可读但含不可解析行：unparsableCount + warning，不阻断
    writeExemptionStore(proj, ['{bad json']);
    prepareChain(proj);
    const unparsable = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(unparsable.sections.exemptAnchor.present, false);
    assert.equal(unparsable.sections.exemptAnchor.unparsableCount, 1);
    assert.ok(unparsable.sections.exemptAnchor.warningCount >= 1);
    assert.equal(unparsable.sections.exemptAnchor.blockingCount, 0);
    // revoked：present=false/0 阻断 + 可见字段；呈现节跳过
    writeExemptionStore(proj, [exemptionLine('内部任务-1', '撤销计划豁免', {
      skill: 'plan-execution', schemaVersion: 2, scope: 'revoked',
    })]);
    prepareChain(proj);
    const revoked = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(revoked.sections.exemptAnchor.present, false);
    assert.equal(revoked.sections.exemptAnchor.blockingCount, 0);
    assert.equal(revoked.sections.exemptAnchor.revoked, true);
    assert.ok(revoked.sections.exemptAnchor.revokedReason.includes('撤销'));
    assert.equal(revoked.sections.exemptions.warningCount, 0);
  });

  test('exemptAnchor：链绑定计划被删 → planBinding 阻断且 path 保留 boundRel，gate 返回报告', () => {
    writeAnchorPlan();
    writeExemptionStore(proj, [rec({ scope: 'plan', planPath: null })]);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    rmSync(planAbs(), { force: true });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.sections.planBinding.blockingCount >= 1);
    assert.equal(report.sections.planBinding.path, PLAN);
    assert.ok(report.sections.exemptAnchor.blockingCount >= 1);
  });

  test('exemptAnchor：仅本任务记录参与选路（他任务 plan/revoked 不影响）', () => {
    // 他任务 plan 记录：本任务无有效 v2 记录 → present=false/0（不得被误当成本任务锚）
    writeExemptionStore(proj, [exemptionLine('TASK-OTHER', '跳过评审直接做', {
      skill: 'plan-execution', schemaVersion: 2, scope: 'plan',
    })]);
    prepareChain(proj);
    const otherPlan = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(otherPlan.sections.exemptAnchor.present, false);
    assert.equal(otherPlan.sections.exemptAnchor.blockingCount, 0);
    // 本任务 plan 记录 + 他任务更新的 revoked：本任务仍须 no-plan blocking
    writeExemptionStore(proj, [
      rec({ scope: 'plan', planPath: null, ts: Date.now() - 10000 }),
      exemptionLine('TASK-OTHER', '撤销计划豁免', {
        skill: 'plan-execution', schemaVersion: 2, scope: 'revoked', ts: Date.now(),
      }),
    ]);
    prepareChain(proj);
    const mixedTasks = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(mixedTasks.sections.exemptAnchor.blockingCount, 1);
    assert.match(mixedTasks.diagnostics.find((d) => d.ruleId === 'RULE-GATE-EXEMPT-ANCHOR').message, /no-plan/);
  });

  test('exemptAnchor：有效 v2 + 坏行混合；explicit --plan 不替代链绑定', () => {
    writeAnchorPlan();
    writeExemptionStore(proj, [rec({ scope: 'plan', planPath: null }), '{bad json']);
    prepareChain(proj, '内部任务-1', { planPath: planAbs() });
    const mixed = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.equal(mixed.sections.exemptAnchor.blockingCount, 0);
    assert.equal(mixed.sections.exemptAnchor.unparsableCount, 1);
    assert.ok(mixed.sections.exemptAnchor.warningCount >= 1);
    assert.ok(mixed.warningCount >= 1);
    // 显式 --plan 但链未绑定：仍 no-plan（用无凭据的 内部任务-2，避免复用 内部任务-1 的 verification 绑定）
    writeExemptionStore(proj, [exemptionLine('内部任务-2', '跳过评审直接做', {
      skill: 'plan-execution', schemaVersion: 2, scope: 'plan',
    })]);
    const explicit = runGate(proj, '内部任务-2', { coreRunner: fakeCore(), planPath: planAbs() });
    assert.equal(explicit.sections.exemptAnchor.blockingCount, 1);
    assert.equal(explicit.sections.planBinding.source, 'explicit-check-only');
  });

  test('exemptAnchor：三 chain profile 均反堵（operation/deliverable）', () => {
    writeExemptionStore(proj, [rec({ scope: 'plan', planPath: null })]);
    prepareChain(proj);
    const opReport = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'operation' });
    assert.equal(opReport.sections.exemptAnchor.blockingCount, 1, 'operation');
    // deliverable 链需要三环，独立项目构造
    const dlvTmp = tmpRoot('dev265-gate-anchor-dlv-');
    const dlvProj = makeProject(dlvTmp);
    try {
      writeExemptionStore(dlvProj, [rec({ scope: 'plan', planPath: null })]);
      const ref = makeRecord(dlvProj);
      const v = issueVerificationReceipt(dlvProj, '内部任务-1', [{ path: 'x', sha256: 'y', exitCode: 0 }]);
      const c = issueCodeReviewReceipt(dlvProj, '内部任务-1', v.receiptId, '渲染验收', {
        reviewInstances: 1, reviewMode: 'deliverable',
      });
      const o = issueOperationReceipt(dlvProj, '内部任务-1', v.receiptId, {
        authorizationQuote: '用户当轮指令：制作制品',
        authorizationScope: '制品生成',
        verificationCriteria: [{ criterion: '制品在案', evidenceRef: 'out.pptx' }],
        rollback: '删除制品',
        effectiveBoundary: '本机',
        recordRef: ref,
      });
      prepareDelivery(dlvProj, '内部任务-1', {
        applicability: app(),
        changeScope: [],
        receiptRefs: [v.receiptId, c.receiptId, o.receiptId],
        specImpact: '制品链',
      });
      const dlvReport = runGate(dlvProj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'deliverable' });
      assert.equal(dlvReport.sections.exemptAnchor.blockingCount, 1, 'deliverable');
    } finally {
      cleanup(dlvTmp);
    }
  });
});

describe('OperationChainGateTest', () => {
  let tmp; let proj; let v; let o;
  beforeEach(() => {
    tmp = tmpRoot('dev92-gate-op-');
    proj = makeProject(tmp);
    const ref = makeRecord(proj);
    v = issueVerificationReceipt(proj, '内部任务-1', [{ path: 'x', sha256: 'y', exitCode: 0 }]);
    o = issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机装机',
      authorizationScope: '四插件装机',
      verificationCriteria: [{ criterion: '对拍 0 差异', evidenceRef: 'layout.log' }],
      rollback: '恢复备份',
      effectiveBoundary: '新会话生效',
      recordRef: ref,
    });
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [v.receiptId, o.receiptId],
      specImpact: '操作链批次规格投影（内部决策-023）',
    });
  });
  afterEach(() => cleanup(tmp));

  test('test_operation_chain_zero_blocking_issues_gate_receipt', () => {
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'operation' });
    assert.equal(report.blockingCount, 0);
    const receiptsSec = report.sections.receipts;
    assert.equal(receiptsSec.blockingCount, 0);
    // 内部决策-027：新签发 L2 无探针 = OPAUTH 复核 warning + 零探针提示 warning（不阻断）。
    assert.equal(receiptsSec.warningCount, 2);
    const opauth = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-OPAUTH');
    assert.equal(opauth.length, 1);
    assert.ok(opauth[0].message.includes('操作链授权待复核'));
    assert.ok(opauth[0].message.includes('用户当轮指令：执行本机装机'));
    const noassert = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-OPNOASSERTION');
    assert.equal(noassert.length, 1);
    assert.equal(noassert[0].severity, 'warning');
    assert.equal(report.warningCount, 2);
    const gate = latestReceipt(proj, '内部任务-1', 'gate');
    assert.notEqual(gate, null);
    assert.equal(gate.operationReceipt, o.receiptId);
    assert.equal(gate.codeReviewReceipt, null);
    assert.equal(gate.chainProfile, 'operation');
  });

  test('test_operation_chain_without_flag_blocks_as_dev', () => {
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.blockingCount >= 1);
    assert.equal(latestReceipt(proj, '内部任务-1', 'gate'), null);
  });

  test('test_operation_chain_flag_without_receipt_propagates', () => {
    assert.throws(
      () => runGate(proj, '内部任务-2', { coreRunner: fakeCore(), chainProfile: 'operation' }),
      ChainProfileError,
    );
  });

  test('test_mixed_chain_blocks', () => {
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 1 });
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'operation' });
    assert.ok(report.blockingCount >= 1);
  });
});

describe('DeliverableChainGateTest', () => {
  let tmp; let proj; let v; let c; let o; let oKwargs;
  beforeEach(() => {
    tmp = tmpRoot('dev92-gate-dlv-');
    proj = makeProject(tmp);
    const ref = makeRecord(proj);
    v = issueVerificationReceipt(proj, '内部任务-1', [{ path: 'x', sha256: 'y', exitCode: 0 }]);
    c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '渲染验收 14/14 全过', {
      reviewInstances: 1, reviewMode: 'deliverable',
    });
    oKwargs = {
      authorizationQuote: '用户当轮指令：制作 PPT 交付制品',
      authorizationScope: '忽略面制品生成',
      verificationCriteria: [{ criterion: '制品在案', evidenceRef: 'out.pptx' }],
      rollback: '删除制品',
      effectiveBoundary: '本机忽略面',
      recordRef: ref,
    };
    o = issueOperationReceipt(proj, '内部任务-1', v.receiptId, oKwargs);
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [v.receiptId, c.receiptId, o.receiptId],
      specImpact: '制品链批次规格投影（内部决策-023 修正案 2）',
    });
  });
  afterEach(() => cleanup(tmp));

  test('test_deliverable_dual_ring_report_and_gate_receipt', () => {
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'deliverable' });
    assert.equal(report.blockingCount, 0);
    const sec = report.sections.receipts;
    assert.ok('operationAssertions' in sec);
    assert.deepEqual(sec.reviewRing, {
      receiptId: c.receiptId, mode: 'deliverable', instances: 1,
    });
    // 双环并呈：评审环 DELIVREVIEW + 授权 OPAUTH（L2 恒现）同时在场
    const rules = ruleIds(report);
    assert.ok(rules.has('RULE-GATE-DELIVREVIEW'));
    assert.ok(rules.has('RULE-GATE-OPAUTH'));
    const deliv = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-DELIVREVIEW');
    assert.equal(deliv.length, 1);
    assert.equal(deliv[0].severity, 'warning');
    assert.ok(deliv[0].message.includes('渲染验收'));
    const gate = latestReceipt(proj, '内部任务-1', 'gate');
    assert.equal(gate.chainProfile, 'deliverable');
    assert.equal(gate.operationReceipt, o.receiptId);
    assert.equal(gate.codeReviewReceipt, c.receiptId);
  });

  test('test_deliverable_l2_finalize_completes', () => {
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'deliverable' });
    assert.equal(report.blockingCount, 0);
    const final = finalizeDelivery(proj, '内部任务-1');
    assert.equal(final.finalStatus, 'complete');
  });

  test('test_deliverable_without_flag_blocks_as_dev', () => {
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.blockingCount >= 1);
    // T06（内部任务-241）：断到具名规则（混链拒绝），不只断 blocking 数量。
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-RECEIPTS'), '须产 RULE-GATE-RECEIPTS 混链诊断');
    assert.equal(latestReceipt(proj, '内部任务-1', 'gate'), null);
  });

  test('test_deliverable_rings_with_operation_flag_still_block', () => {
    // 旗标不自动升级：operation 形态下评审环并存仍混链拒绝。
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'operation' });
    assert.ok(report.blockingCount >= 1);
    const diag = report.diagnostics.find((d) => d.ruleId === 'RULE-GATE-RECEIPTS');
    assert.ok(diag, '须产 RULE-GATE-RECEIPTS 诊断');
    assert.match(String(diag.fixHint), /混链|operation/, '诊断须指认混链语义');
  });

  test('test_deliverable_flag_without_rings_raises', () => {
    assert.throws(
      () => runGate(proj, '内部任务-2', { coreRunner: fakeCore(), chainProfile: 'deliverable' }),
      ChainProfileError,
    );
  });

  test('test_deliverable_l1_skips_delivery_and_finalize_rejects', () => {
    // 夹具按制品链正序构造：c 先于 o 签发（四因子之序）。
    const v2 = issueVerificationReceipt(proj, '内部任务-2', [{ path: 'x', sha256: 'y', exitCode: 0 }]).receiptId;
    issueCodeReviewReceipt(proj, '内部任务-2', v2, '内容审通过', {
      reviewInstances: 1, reviewMode: 'deliverable',
    });
    issueOperationReceipt(proj, '内部任务-2', v2, {
      ...oKwargs,
      riskLevel: 'L1',
      verificationCriteria: [{
        criterion: '操作记录在案',
        evidenceRef: 'ops/record.md',
        probe: {
          type: 'file-exists',
          path: { base: 'project', rel: 'ops/record.md' },
          kind: 'file',
        },
      }],
    });
    const report = runGate(proj, '内部任务-2', { coreRunner: fakeCore(), chainProfile: 'deliverable' });
    assert.equal(report.blockingCount, 0);
    assert.equal(report.sections.delivery.status, 'skipped-l1');
    const gate = latestReceipt(proj, '内部任务-2', 'gate');
    assert.equal(gate.riskLevel, 'L1');
    assert.equal(Object.hasOwn(gate, 'draftSha256'), false);
    assert.throws(() => finalizeDelivery(proj, '内部任务-2'), /L1/);
  });
});

describe('OperationAssertionsGateTest', () => {
  let tmp; let proj; let ref;
  beforeEach(() => {
    tmp = tmpRoot('dev92-gate-opassert-');
    proj = makeProject(tmp);
    ref = makeRecord(proj);
  });
  afterEach(() => cleanup(tmp));

  function issueV() {
    return issueVerificationReceipt(proj, '内部任务-1', [{ path: 'x', sha256: 'y', exitCode: 0 }]);
  }

  function issueOp(probes = [], riskLevel = 'L2') {
    const v = issueV();
    return issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机装机',
      authorizationScope: '本机缓存对齐',
      verificationCriteria: opCriteria(probes),
      rollback: '恢复备份',
      effectiveBoundary: '新会话生效',
      recordRef: ref,
      riskLevel,
    });
  }

  function gate() {
    // L1 免两阶段交付报告是 内部决策-027 的完成语义；gate 测试仍需草案满足 delivery 节。
    prepareDelivery(proj, '内部任务-1', {
      applicability: app(),
      changeScope: [],
      receiptRefs: [latestReceipt(proj, '内部任务-1', 'verification').receiptId,
        latestReceipt(proj, '内部任务-1', 'operation').receiptId],
      specImpact: '操作断言批次（内部决策-027）',
    });
    return runGate(proj, '内部任务-1', { coreRunner: fakeCore(), chainProfile: 'operation' });
  }

  test('test_l1_passing_probe_zero_blocking_zero_opauth', () => {
    issueOp([{ type: 'file-exists', path: { base: 'project', rel: 'ops/record.md' } }], 'L1');
    const report = gate();
    assert.equal(report.blockingCount, 0, JSON.stringify(report.diagnostics));
    assert.deepEqual(report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-OPAUTH'), []);
    const sec = report.sections.receipts;
    assert.equal(sec.riskLevel, 'L1');
    assert.equal(sec.operationAssertions.failed, 0);
    assert.notEqual(latestReceipt(proj, '内部任务-1', 'gate'), null);
  });

  test('test_l1_failing_probe_blocks_and_no_gate_receipt', () => {
    // 038 回归夹具：声称 installPath 末段==version，但注册表内容漂移 → 必须阻断。
    writeFileSync(join(proj, 'state.json'),
      JSON.stringify({ version: '0.3.9', installPath: 'C:\\x\\cache\\workflow\\0.3.8' }), 'utf8');
    issueOp([{
      type: 'json-field-eq',
      path: { base: 'project', rel: 'state.json' },
      field: 'version',
      ref: {
        refBase: 'project', refPath: 'state.json', refField: 'installPath', refTransform: 'last-segment',
      },
    }], 'L1');
    const report = gate();
    assert.ok(report.blockingCount >= 1);
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-OPASSERT'));
    assert.equal(latestReceipt(proj, '内部任务-1', 'gate'), null);
  });

  test('test_l1_without_any_probe_blocks', () => {
    issueOp([], 'L1'); // 只传 legacy 文本判据
    const report = gate();
    assert.ok(report.diagnostics.some(
      (d) => d.ruleId === 'RULE-GATE-OPNOASSERTION' && d.severity === 'blocking',
    ));
  });

  test('test_l2_without_probe_warns_not_blocks', () => {
    issueOp([], 'L2');
    const report = gate();
    const noassert = report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-OPNOASSERTION');
    assert.equal(noassert.length, 1);
    assert.equal(noassert[0].severity, 'warning');
    assert.equal(report.blockingCount, 0);
    assert.equal(report.diagnostics.filter((d) => d.ruleId === 'RULE-GATE-OPAUTH').length, 1);
  });

  test('test_legacy_operation_runs_as_l2_without_probe_warnings', () => {
    // 无 riskLevel 字段的旧凭据（升级前已落盘）：legacy 不执行探针、不出 OPNOASSERTION。
    const v = issueV();
    const rec = issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：执行本机装机',
      authorizationScope: '本机缓存对齐',
      verificationCriteria: [{ criterion: '文本判据', evidenceRef: 'layout.log' }],
      rollback: '恢复备份',
      effectiveBoundary: '新会话生效',
      recordRef: ref,
    });
    const opFile = join(proj, '.sdd', 'receipts', '内部任务-1', `${rec.receiptId}.json`);
    const doc = readJson(opFile);
    delete doc.riskLevel;
    doc.integritySha256 = integrity(doc);
    writeFileSync(opFile, JSON.stringify(doc), 'utf8');
    const report = gate();
    assert.equal(report.blockingCount, 0);
    assert.equal(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-OPNOASSERTION'), false);
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-OPAUTH'));
    assert.equal(report.sections.receipts.operationAssertions.legacy, true);
  });

  test('test_bad_probe_config_is_blocking_not_silent', () => {
    // 非法 type 在签发点即拒（内部决策-027 生产者形态受理）。
    assert.throws(
      () => issueOp([{ type: 'no-such-type', path: { base: 'project', rel: 'x' } }], 'L1'),
      /probe\.type 非法/,
    );
  });

  test('test_ref_field_missing_blocks_instead_of_crashing', () => {
    // ref 形态合法但 refField 在引用文件中不存在——结构化 blocking，不抛栈。
    writeFileSync(join(proj, 'state.json'), JSON.stringify({ version: '1' }), 'utf8');
    issueOp([{
      type: 'json-field-eq',
      path: { base: 'project', rel: 'state.json' },
      field: 'version',
      ref: { refBase: 'project', refPath: 'state.json', refField: 'missing.field' },
    }], 'L1');
    const report = gate();
    assert.ok(report.blockingCount >= 1);
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-OPASSERT'));
  });

  test('test_file_exists_bad_kind_is_config_error', () => {
    issueOp([{
      type: 'file-exists', path: { base: 'project', rel: 'ops/record.md' }, kind: 'flie',
    }], 'L1');
    const report = gate();
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-OPASSERT-CONFIG'));
  });
});

describe('ReviewCoverageTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-cover-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  function plan(steps) {
    const lines = ['# 计划', ''];
    for (let i = 1; i <= steps; i += 1) {
      lines.push(`### 步骤 ${i}：做第 ${i} 件事`, '', '验收：真验收命令退出码 0', '');
    }
    return writePlan(proj, 'plan.md', `${lines.join('\n')}\n`);
  }

  test('test_warn_when_large_plan_single_review', () => {
    const p = plan(10);
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 1 复审', { reviewInstances: 2, stage: '1' });
    const section = _checkReviewCoverage(proj, '内部任务-1', p);
    assert.equal(section.stepCount, 10);
    assert.equal(section.reviewCount, 1);
    assert.equal(section.warningCount, 1);
    assert.equal(section.blockingCount, 0, '覆盖检查只提示，不阻断');
    assert.equal(section.diagnostics[0].ruleId, 'RULE-GATE-REVIEWCOVERAGE');
  });

  test('test_no_warn_when_stage_reviews_present', () => {
    const p = plan(10);
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 1 复审', { reviewInstances: 2, stage: '1' });
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 2 复审', { reviewInstances: 2, stage: '2' });
    const section = _checkReviewCoverage(proj, '内部任务-1', p);
    assert.equal(section.reviewCount, 2);
    assert.equal(section.warningCount, 0);
    assert.equal(section.reviewAudit, null, '仅阶段凭据、无任务级评审时 reviewAudit 为 null');
  });

  test('test_review_audit_surfaces_fix_review_fields', () => {
    const p = plan(1);
    const v = issueVerificationReceipt(proj, '内部任务-1', evidenceEntry(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '终评', {
      reviewInstances: 3,
      fixReviewMode: 'delta',
      fixReviewInstances: 1,
      fixReviewReason: '局部修复（1 实例）',
      fixReviewBase: 'a'.repeat(40),
      fixReviewDiffSha: 'b'.repeat(64),
    });
    const section = _checkReviewCoverage(proj, '内部任务-1', p);
    assert.equal(section.reviewAudit.receiptId, latestReceipt(proj, '内部任务-1', 'code-review').receiptId);
    assert.equal(section.reviewAudit.reviewMode, 'three-dim');
    assert.equal(section.reviewAudit.reviewInstances, 3);
    assert.equal(section.reviewAudit.fixReviewMode, 'delta');
    assert.equal(section.reviewAudit.fixReviewInstances, 1);
    assert.equal(section.reviewAudit.fixReviewReason, '局部修复（1 实例）');
    assert.equal(section.reviewAudit.fixReviewBase, 'a'.repeat(40));
    assert.equal(section.reviewAudit.fixReviewDiffSha, 'b'.repeat(64));
  });

  test('test_review_audit_defaults_to_none_for_legacy_receipt', () => {
    const p = plan(1);
    const src = join(HERE, 'fixtures', 'receipts', '内部任务-36', 'code-review-内部任务-36-1.json');
    const dir = join(proj, '.sdd', 'receipts', '内部任务-36');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'code-review-内部任务-36-1.json'), readFileSync(src));
    const section = _checkReviewCoverage(proj, '内部任务-36', p);
    assert.equal(section.reviewAudit.receiptId, 'code-review-内部任务-36-1');
    assert.equal(section.reviewAudit.fixReviewMode, 'none', 'legacy 缺字段按 none');
    assert.equal(section.reviewAudit.fixReviewInstances, 0);
    assert.equal(section.reviewAudit.fixReviewReason, '');
    assert.equal(section.reviewAudit.fixReviewBase, '');
    assert.equal(section.reviewAudit.fixReviewDiffSha, '');
  });

  test('test_skip_without_plan', () => {
    const section = _checkReviewCoverage(proj, '内部任务-1', null);
    assert.equal(section.skipReason, 'no-plan');
    assert.equal(section.warningCount, 0);
    assert.equal(section.stepCount, null);
    assert.equal(section.reviewAudit, null);
  });

  test('test_threshold_configurable', () => {
    writeFileSync(join(proj, '.sdd', 'assurance.json'),
      JSON.stringify({ schemaVersion: '1.0.0', reviewCoverage: { planStepThreshold: 3 } }), 'utf8');
    const p = plan(3);
    issueCodeReviewReceipt(proj, '内部任务-1', null, '阶段 1 复审', { reviewInstances: 2, stage: '1' });
    const section = _checkReviewCoverage(proj, '内部任务-1', p);
    assert.equal(section.threshold, 3);
    assert.equal(section.warningCount, 1);
  });

  test('test_step_heading_comes_from_frozen_core', () => {
    // 口径单一来源守护：gate 直接消费 JS core 的 STEP_HEADING_RE（不再是镜像副本）。
    assert.equal(_stepHeadingRe(), STEP_HEADING_RE, '步骤口径单源：gate 直接 import JS core');
    const samples = [
      ['# 步骤 1：x', true], ['###step 2', true], ['###### 任务', true], ['####\ttask', true],
      ['####### 步骤', false], ['  步骤', false], ['步骤', false], ['#1 数字', true],
      ['## 计划', false], ['- 步骤 1', false],
    ];
    for (const [line, expected] of samples) assert.equal(STEP_HEADING_RE.test(line), expected, line);
  });
});

describe('ReviewExemptGateTest', () => {
  let tmp; let proj; let planPath;
  beforeEach(() => {
    tmp = tmpRoot('dev92-gate-crevexempt-');
    proj = makeProject(tmp);
    const lines = ['# 纯文档计划', ''];
    for (let i = 1; i <= 10; i += 1) {
      lines.push(`### 步骤 ${i}：文档第 ${i} 件`, '', '验收：grep 关键字命中退出码 0', '');
    }
    planPath = writePlan(proj, join('docs', 'plans', 'pure-doc.md'), `${lines.join('\n')}\n`);
  });
  afterEach(() => cleanup(tmp));

  function exemptChain() {
    const ev = evidenceEntry(proj);
    const vid = issueVerificationReceipt(proj, 'TASK-X', ev, { profile: 'full' }).receiptId;
    issueCodeReviewReceipt(proj, 'TASK-X', vid, '纯文档批豁免', {
      planPath,
      reviewInstances: 0,
      reviewMode: 'exempt',
      exemptionReason: '纯文档计划，收尾节显式豁免（内部规则-11）',
    });
  }

  test('test_exempt_chain_zero_blocking_with_human_loop_warning', () => {
    exemptChain();
    const section = _checkReceipts(proj, 'TASK-X');
    assert.equal(section.blockingCount, 0, '豁免凭据满足完成链第二环（P3）');
    assert.equal(section.warningCount, 1, '豁免呈现恒现 warning（人在环）');
    const diag = section.diagnostics[0];
    assert.equal(diag.ruleId, 'RULE-GATE-CREVEXEMPT');
    assert.ok(diag.message.includes('内部规则-11'));
    assert.ok('planRef' in section.reviewExemption);
    assert.ok(section.reviewExemption.reason);
  });

  test('test_exempt_skips_review_coverage_warning', () => {
    exemptChain();
    const section = _checkReviewCoverage(proj, 'TASK-X', planPath);
    assert.equal(section.stepCount, 10, '步骤规模如实呈现');
    assert.equal(section.exemption, 'code-review-exempt', '节内标注豁免口径（P7）');
    assert.equal(section.warningCount, 0, '豁免在案不再产覆盖 warning（P7）');
    assert.equal(section.reviewAudit.reviewMode, 'exempt');
    assert.equal(section.reviewAudit.fixReviewMode, 'none');
  });

  test('test_normal_single_review_still_warns', () => {
    issueCodeReviewReceipt(proj, 'TASK-Y', null, '阶段复审', { reviewInstances: 2, stage: '1' });
    const section = _checkReviewCoverage(proj, 'TASK-Y', planPath);
    assert.equal(section.warningCount, 1, '无豁免凭据时既有覆盖 warning 不变（对照）');
    assert.equal('exemption' in section, false);
  });
});

describe('GatePlanRunnerQuirkTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-planquirk-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('test_default_plan_runner_does_not_converge_error_object', () => {
    // 已知怪癖回归钉（行为冻结，不在本批修复）：defaultPlanRunner 只做 JSON.parse，
    // 不识别校验器 exit 2 的 {"error":...} 形态——原样返回，无 blockingCount/diagnostics。
    const planPath = writePlan(proj, '内部计划');
    const validator = writeFakeValidator(tmp,
      "process.stdout.write(JSON.stringify({ error: 'plan config bad' }));\nprocess.exit(2);\n");
    const report = defaultPlanRunner(proj, planPath, {
      python: { cmd: process.execPath, args: [] }, validatorPath: validator, timeoutMs: 10_000,
    });
    assert.deepEqual(report, { error: 'plan config bad' });
    assert.equal(Object.hasOwn(report, 'blockingCount'), false);
  });
});

describe('ScoutActiveTest', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev92-gate-scout-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('scoutActive：v3 合法未过期=true；过期/旧 schema/损坏=false', () => {
    const mode = join(proj, '.scout', 'mode.json');
    mkdirSync(join(proj, '.scout'), { recursive: true });
    const base = { schemaVersion: 3, mode: 'explore', taskId: '内部任务-1', transactionId: 'tx-1' };
    writeFileSync(mode, JSON.stringify({ ...base, expiry: '2099-01-01' }), 'utf8');
    assert.equal(scoutActive(proj), true);
    writeFileSync(mode, JSON.stringify({ ...base, expiry: '2000-01-01' }), 'utf8');
    assert.equal(scoutActive(proj), false);
    writeFileSync(mode, JSON.stringify({ ...base, schemaVersion: 2, expiry: '2099-01-01' }), 'utf8');
    assert.equal(scoutActive(proj), false);
    writeFileSync(mode, 'not-json', 'utf8');
    assert.equal(scoutActive(proj), false);
  });
});

describe('ReviewProvenanceGateTest（内部任务-191）', () => {
  let tmp;
  let proj;
  beforeEach(() => {
    tmp = tmpRoot('dev191-gate-prov-');
    proj = makeProject(tmp);
  });
  afterEach(() => { cleanup(tmp); });

  test('无 provenance 的 code-review 凭据 → RULE-GATE-REVIEWPROV-LEGACY warning（不阻断）', () => {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidenceEntry(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', { reviewInstances: 3 });
    const section = _checkReceipts(proj, '内部任务-1');
    assert.equal(section.blockingCount, 0, 'legacy provenance 不得阻断');
    const diag = section.diagnostics.find((d) => d.ruleId === 'RULE-GATE-REVIEWPROV-LEGACY');
    assert.ok(diag, 'legacy provenance warning 必现');
    assert.equal(diag.severity, 'warning');
  });

  test('reviewAudit 投影 round/provenance 状态与 countable（2.1.0 present）', () => {
    const plan = writePlan(proj, '内部计划');
    prepareChain(proj, '内部任务-1', { planPath: plan });
    const section = _checkReviewCoverage(proj, '内部任务-1', plan);
    assert.equal(section.reviewAudit.reviewRound, 1);
    assert.equal(section.reviewAudit.reviewProvenanceState, 'present');
    assert.equal(section.reviewAudit.reviewProvenanceCount, 3);
  });

  /** 2.1.0 code-review（可选 fix 环声明）；tamper 按凭据口径重算完整性后落盘。 */
  function issueProvReview({ fix = false } = {}) {
    const v = issueVerificationReceipt(proj, '内部任务-1', evidenceEntry(proj), { profile: 'full' });
    return issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, 's', {
      reviewInstances: 3,
      reviewRound: 1,
      reviewProvenance: prov('内部任务-1', 3),
      ...(fix ? {
        fixReviewMode: 'delta',
        fixReviewInstances: 1,
        fixReviewBase: 'a'.repeat(40),
        fixReviewDiffSha: 'b'.repeat(64),
        fixReviewProvenance: prov('内部任务-1', 1, { round: 2, state: 'reused' }),
      } : {}),
    });
  }
  function tamperReview(c, mutate) {
    const file = join(proj, '.sdd', 'receipts', '内部任务-1', `${c.receiptId}.json`);
    const raw = readJson(file);
    mutate(raw);
    raw.integritySha256 = integrity(raw);
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }

  test('A4 非法 fix provenance → reviewAudit.fixProvenanceState=invalid（统一状态词表）', () => {
    const c = issueProvReview({ fix: true });
    tamperReview(c, (raw) => {
      raw.fixReviewProvenance = raw.fixReviewProvenance.map((e) => ({ ...e, chain: 'task:内部任务-2' }));
    });
    const planPath = writePlan(proj, '内部计划');
    const section = _checkReviewCoverage(proj, '内部任务-1', planPath);
    assert.equal(section.reviewAudit.fixReviewInstances, 1);
    assert.equal(section.reviewAudit.fixReviewProvenanceState, 'invalid', '非法 fix 不得投影为 present');
    assert.equal(section.reviewAudit.reviewProvenanceState, 'invalid', '整体状态随 fix 非法一并 invalid');
  });

  test('A4 fixReviewInstances=0 携带 fixReviewProvenance → invalid（D3 反向不变量投影）', () => {
    const c = issueProvReview({ fix: true });
    tamperReview(c, (raw) => { raw.fixReviewInstances = 0; });
    const planPath = writePlan(proj, '内部计划');
    const section = _checkReviewCoverage(proj, '内部任务-1', planPath);
    assert.equal(section.reviewAudit.fixReviewInstances, 0);
    assert.equal(section.reviewAudit.fixReviewProvenanceState, 'invalid');
  });

  test('A4 early return（exempt）投影 fixProvenanceState=none', () => {
    const planPath = writePlan(proj, '内部计划');
    const v = issueVerificationReceipt(proj, '内部任务-2', evidenceEntry(proj), { profile: 'full' });
    issueCodeReviewReceipt(proj, '内部任务-2', v.receiptId, '豁免', {
      planPath,
      reviewInstances: 0,
      reviewMode: 'exempt',
      exemptionReason: '纯文档计划收尾节显式豁免（内部规则-11）',
    });
    const section = _checkReviewCoverage(proj, '内部任务-2', planPath);
    assert.equal(section.reviewAudit.reviewMode, 'exempt');
    assert.equal(section.reviewAudit.fixReviewProvenanceState, 'none');
    assert.equal(reviewProvenanceStatusOf(null, { taskId: '内部任务-2' }).fixProvenanceState, 'none');
  });

  test('A5 2.0.0 deliverable 评审环 + operation → receipts 节 legacy warning（诊断集保留）', () => {
    const ref = makeRecord(proj); // 操作记录须先于 verification 落盘（revision 绑定）
    const v = issueVerificationReceipt(proj, '内部任务-1', evidenceEntry(proj), { profile: 'full' });
    const c = issueCodeReviewReceipt(proj, '内部任务-1', v.receiptId, '制品评审（legacy）', {
      reviewInstances: 1, reviewMode: 'deliverable',
    });
    assert.equal(c.schemaVersion, '2.0.0', '库面缺 provenance 如实降级 legacy');
    issueOperationReceipt(proj, '内部任务-1', v.receiptId, {
      authorizationQuote: '用户当轮指令：制作 PPT 交付制品',
      authorizationScope: '忽略面制品生成',
      verificationCriteria: [{ criterion: '制品在案', evidenceRef: 'out.pptx' }],
      rollback: '删除制品',
      effectiveBoundary: '本机忽略面',
      recordRef: ref,
    });
    const section = _checkReceipts(proj, '内部任务-1', 'deliverable');
    assert.equal(section.blockingCount, 0, 'legacy 评审环不阻断');
    const diag = section.diagnostics.find((d) => d.ruleId === 'RULE-GATE-REVIEWPROV-LEGACY');
    assert.ok(diag, '2.0.0 deliverable 评审环 legacy warning 必现');
    assert.equal(diag.severity, 'warning');
    assert.ok(section.reviewRing, '评审环投影不得因 A5 重构丢失');
    assert.equal(section.reviewRing.mode, 'deliverable');
    assert.equal(section.warningCount, section.diagnostics.filter((d) => d.severity === 'warning').length);
  });
});

describe('GateProductionIntegrityTest (内部任务-241 步骤7 D01)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-gate-d01-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('变更记录含非对象 JSON 行 → gate 出 blocking 报告不崩溃', () => {
    prepareChain(proj);
    const dir = join(proj, '.sdd', 'production', 'changes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '内部变更-1.jsonl'), 'null\n', 'utf8');
    const report = runGate(proj, '内部任务-1', {
      coreRunner: fakeCore(), claim: 'code-complete', change: '内部变更-1',
    });
    assert.ok(report.blockingCount > 0, '坏链必须阻断');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'PROD-INTEGRITY-BADLINE'),
      '损坏行以 BADLINE 呈现而非进程异常');
    assert.equal(report.gateReceipt, null);
  });
});

describe('GateIfDriftContainmentTest (内部任务-241 步骤11 S02)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-gate-ifd-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('IF 登记路径越界（绝对/..）→ blocking 且不读文件', () => {
    const ifDir = join(proj, 'specs', 'interfaces');
    mkdirSync(ifDir, { recursive: true });
    const outside = join(tmp, 'outside-secret.txt');
    writeFileSync(outside, 'secret\n', 'utf8');
    writeFileSync(join(ifDir, 'IF-TEST.md'), [
      '# IF-TEST', '', '## 6. 生命周期与版本', '- lifecycle：active', '', '## 7. 契约工件',
      '| 工件 | 路径 | 漂移检查 |', '|---|---|---|',
      `| custom | \`${outside}\` | sha256:0123456789abcdef |`,
      '| custom2 | `../../../outside-secret.txt` | sha256:0123456789abcdef |',
    ].join('\n'), 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.sections.ifDrift.blockingCount >= 2, '两条越界路径均阻断');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'RULE-GATE-IFDRIFT' && /越界|越出项目根/.test(String(d.fixHint))));
    assert.equal(report.gateReceipt, null);
  });
});

describe('GateToolErrorMarkingTest (内部任务-241 步骤15 G05)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-gate-toolerr-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('交付草案不可解析 → blocking＋toolError 标记（不再 warning 放行）', () => {
    prepareChain(proj);
    writeFileSync(join(proj, '.sdd', 'reports', '内部任务-1', 'delivery-draft.json'), '{bad', 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    assert.ok(report.blockingCount > 0, '坏草案必须阻断');
    const diag = report.diagnostics.find((d) => d.ruleId === 'RULE-GATE-DELIVERY-PARSE');
    assert.ok(diag, '须产 RULE-GATE-DELIVERY-PARSE');
    assert.equal(diag.severity, 'blocking');
    assert.equal(diag.toolError, true);
    assert.equal(report.gateReceipt, null);
  });

  test('core 校验器工具错误 → blocking 诊断带 toolError 标记', () => {
    const validator = writeFakeValidator(tmp, "process.stdout.write(JSON.stringify({ error: 'core down' }));\nprocess.exit(2);\n");
    const old = process.env.SG_CORE_VALIDATOR;
    process.env.SG_CORE_VALIDATOR = validator;
    try {
      const report = defaultCoreRunner(proj);
      assert.equal(report.blockingCount, 1);
      assert.equal(report.diagnostics[0].toolError, true, 'core 工具错误须带标记供 CLI 映射退 2');
    } finally {
      if (old === undefined) delete process.env.SG_CORE_VALIDATOR; else process.env.SG_CORE_VALIDATOR = old;
    }
  });
});

describe('GateProductionSectionTest (内部任务-241 步骤16 T03)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-gate-prod-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  function writeProfile() {
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(join(proj, '.sdd', 'delivery-profile.json'), JSON.stringify({
      schemaVersion: '1.0.0', deliveryKind: 'service', distribution: 'container',
      scm: { prRequired: true }, environments: ['dev', 'prod'], exposure: 'public',
      dataClasses: [], secretUse: 'none', persistentState: 'database',
      availabilityTier: 'standard', recoveryTier: 'backup-restore',
      acceptanceAuthority: 'owner', evidenceMaxAgeHours: 24,
      vulnerabilityPolicy: 'none', requiredApprovals: [],
    }), 'utf8');
  }

  test('claim+change 但变更记录缺失 → production 节阻断且不签凭据', () => {
    prepareChain(proj);
    writeProfile();
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), claim: 'merge-ready', change: '内部变更-1' });
    assert.ok(report.blockingCount > 0);
    const prod = report.sections.production;
    assert.ok(['blocked', 'config-error'].includes(prod.status), `实际状态：${prod.status}`);
    assert.ok(prod.blockingCount >= 1);
    assert.equal(report.gateReceipt, null);
  });

  test('active Scout（v3 合法未过期）→ 生产 claim 被 Safety Floor 阻断', () => {
    prepareChain(proj);
    writeProfile();
    mkdirSync(join(proj, '.scout'), { recursive: true });
    writeFileSync(join(proj, '.scout', 'mode.json'), JSON.stringify({
      schemaVersion: 3, mode: 'explore', taskId: 'T1', transactionId: 'tx-1', expiry: '2099-01-01',
    }), 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), claim: 'merge-ready', change: '内部变更-1' });
    assert.ok(report.blockingCount > 0);
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'PROD-SECURITY-SCOUT'), 'Scout Safety Floor 诊断须出现');
    assert.equal(report.gateReceipt, null);
  });

  test('坏 delivery-profile JSON → production 节 config-error/阻断', () => {
    prepareChain(proj);
    writeProfile();
    writeFileSync(join(proj, '.sdd', 'delivery-profile.json'), '{bad', 'utf8');
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), claim: 'merge-ready', change: '内部变更-1' });
    assert.ok(report.blockingCount > 0);
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'PROD-PROFILE-UNPARSABLE'), '坏 profile 须产具名诊断');
    assert.equal(report.sections.production.status, 'config-error');
    assert.equal(report.gateReceipt, null);
  });

  test('--claim 缺 --change → production 节 config-error（参数契约）', () => {
    prepareChain(proj);
    const report = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), claim: 'merge-ready' });
    assert.ok(report.blockingCount > 0);
    assert.equal(report.sections.production.status, 'config-error');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'PROD-GATE-ARGS'));
    assert.equal(report.gateReceipt, null);
  });
});

describe('GateReceiptCacheTest (内部任务-242 步骤9)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev242-cache-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('一次 gate 内 latestReceipt 每 (taskId,kind) 仅读一次（缓存生效）', () => {
    prepareChain(proj);
    const reads = [];
    const original = _receiptsHooks.latestReceiptRead;
    _receiptsHooks.latestReceiptRead = (q) => reads.push(`${q.taskId}:${q.kind}`);
    try {
      runGate(proj, '内部任务-1', { coreRunner: fakeCore() });
    } finally {
      _receiptsHooks.latestReceiptRead = original;
    }
    assert.ok(reads.length > 0, 'gate 确实经 latestReceipt 读凭据');
    for (const kind of ['verification', 'code-review', 'operation']) {
      const n = reads.filter((x) => x.endsWith(`:${kind}`)).length;
      assert.ok(n <= 1, `${kind} 读取 ${n} 次（缓存后应≤1）`);
    }
  });
});

describe('GatePlanCheckBlockConfigTest (内部任务-241 步骤17 T04)', () => {
  let tmp; let proj;
  beforeEach(() => { tmp = tmpRoot('dev241-gate-pcb-'); proj = makeProject(tmp); });
  afterEach(() => cleanup(tmp));

  test('内部治理状态 的 planCheckBlock 配置分支生效（无 CLI 旗标）', () => {
    prepareChain(proj);
    const plan = writePlan(proj, '内部计划');
    const runner = fakePlanRunner([{
      ruleId: 'RULE-PLAN-002', severity: 'blocking', file: plan, line: 2, fixHint: '悬空引用',
    }]);
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    const cfg = join(proj, '.sdd', 'assurance.json');
    writeFileSync(cfg, JSON.stringify({ planCheckBlock: true }), 'utf8');
    const on = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), planPath: plan, planRunner: runner });
    assert.ok(on.blockingCount > 0, '配置开启时计划阻断参与聚合阻断');
    writeFileSync(cfg, JSON.stringify({ planCheckBlock: false }), 'utf8');
    const off = runGate(proj, '内部任务-1', { coreRunner: fakeCore(), planPath: plan, planRunner: runner });
    assert.equal(off.blockingCount, 0, '配置关闭时降级为提醒');
    assert.ok(off.warningCount > 0);
  });
});

// ── 内部任务-259 步骤 4 ⑮：scout-mode 新建条目（owner=unknown）ledger 节零 blocking ──

test('gate：scout register 新建条目在 ledger 节零 blocking（内部决策-065 T11/⑮）', () => {
  const tmp = tmpRoot('dev259-gate-ledger-');
  try {
    const proj = makeProject(tmp);
    const r = scoutRegister(proj, '内部任务-259', 'explore', '2999-01-01', 'tx-259', 'open');
    assert.ok(r.ok, JSON.stringify(r));
    const report = runGate(proj, '内部任务-259', { coreRunner: fakeCore() });
    const section = report.sections?.ledger ?? report.ledger;
    assert.ok(section, 'gate 报告须含 ledger 节');
    assert.equal(section.blockingCount, 0, JSON.stringify(section.diagnostics));
  } finally {
    cleanup(tmp);
  }
});

// ── 步骤 5（T18）：gate.scoutActive 与 scout readStatus 跨侧同源对拍 ──

test('T18 跨侧对拍：同一 mode.json 四态 readStatus 与 gate.scoutActive 一致', async () => {
  const { readStatus } = await import('../../../scout/scripts/mode-state.mjs');
  const future = (n) => {
    const d = new Date(Date.now() + n * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const cases = [
    { name: '合法 v3', mode: { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-1', transactionId: 'tx' }, active: true },
    { name: '过期 v3', mode: { schemaVersion: 3, mode: 'explore', expiry: future(-1), taskId: '内部任务-1', transactionId: 'tx' }, active: false },
    { name: '非法日历日 2027-02-30', mode: { schemaVersion: 3, mode: 'explore', expiry: '2027-02-30', taskId: '内部任务-1', transactionId: 'tx' }, active: false },
    { name: '非字符串 id', mode: { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: 123, transactionId: 'tx' }, active: false },
  ];
  for (const c of cases) {
    const tmp = tmpRoot('dev259-t18-');
    try {
      const proj = makeProject(tmp);
      mkdirSync(join(proj, '.scout'), { recursive: true });
      writeFileSync(join(proj, '.scout', 'mode.json'), JSON.stringify(c.mode));
      assert.equal(readStatus(proj).valid, c.active, `readStatus 不一致：${c.name}`);
      assert.equal(scoutActive(proj), c.active, `scoutActive 不一致：${c.name}`);
    } finally {
      cleanup(tmp);
    }
  }
});
