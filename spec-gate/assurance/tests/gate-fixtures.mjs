// 文件：gate-fixtures.mjs
// 描述：gate.mjs 永久单测夹具（内部任务-92 阶段3a W1）——tmp 项目根、fake core/plan runner、
//       verification/code-review/operation 凭据链、delivery 草案、台账/边界/IF 漂移、
//       豁免审计记录、计划与操作记录构造。全部落 tmp，不读真仓；行为对齐
//       spec-gate/assurance/tests/test_gate.py 的 `_project`/`_fake_core`/`_app`/
//       `_prepare_chain`/`_exemption_line`/`_op_criteria` 等夹具口径。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../common.mjs';
import { prepareDelivery } from '../delivery_reports.mjs';
import {
  issueCodeReviewReceipt, issueOperationReceipt, issueVerificationReceipt,
} from '../receipts.mjs';
import { prov } from './provenance-fixtures.mjs';

/** tmp 根目录（调用方负责 cleanup）。 */
export function tmpRoot(prefix = 'dev92-gate-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 递归清理（win32 句柄延迟用 retries）。 */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * 最小项目根（对齐 test_gate.py `_project`）：src/a.py + 内部治理状态。
 * @param {string} base
 * @returns {string}
 */
export function makeProject(base) {
  const proj = join(base, 'p');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
  mkdirSync(join(proj, '.sdd'), { recursive: true });
  writeFileSync(join(proj, '.sdd', 'suite.json'), '{"documents": []}\n', 'utf8');
  return proj;
}

/** 结构化判定（内部未决-8：三项独立结论+理由；对齐 test_gate.py `_app`）。 */
export function app() {
  return {
    sdd: { conclusion: 'required', reason: '批次含规格条款与哈希重登' },
    ddd: { conclusion: 'tactical', reason: '模块内变更，无领域建模' },
    tdd: { conclusion: 'strict', reason: '测试先行，错误路径覆盖' },
  };
}

/** 写证据文件并返回一条 evidenceRef（内容默认 ok\n，与 Python 夹具同源）。 */
export function evidenceEntry(proj, rel = 'src/ev.txt', content = 'ok\n') {
  const target = join(proj, rel);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return [{ path: rel, sha256: `sha256:${sha256Hex(Buffer.from(content, 'utf8'))}`, exitCode: 0 }];
}

/**
 * 注入式 core runner（对齐 test_gate.py `_fake_core`）：固定计数/诊断，生产路径为真实子进程。
 * @param {{blocking?: number, warning?: number, mode?: string, filesChecked?: number,
 *          diagnostics?: Array<object>, plan?: object|null}} [opts]
 * @returns {(root: string) => Record<string, unknown>}
 */
export function fakeCore({
  blocking = 0, warning = 0, mode = 'suite', filesChecked = 1, diagnostics = [], plan = null,
} = {}) {
  return () => {
    const report = {
      schemaVersion: '1.0.0',
      mode,
      filesChecked,
      blockingCount: blocking,
      warningCount: warning,
      diagnostics: diagnostics.map((d) => ({ ...d })),
    };
    report.plan = plan === null
      ? { checked: 0, blockingCount: 0, warningCount: 0, diagnostics: [] }
      : {
        ...plan,
        diagnostics: (plan.diagnostics ?? []).map((d) => ({ ...d })),
      };
    return report;
  };
}

/**
 * 注入式 plan runner（对齐 test_gate.py `_fake_plan_runner` 及降级用例的混合 severity 形态）。
 * @param {Array<object>} [diagnostics]
 * @returns {(root: string, planPath: string) => Record<string, unknown>}
 */
export function fakePlanRunner(diagnostics = []) {
  const diags = diagnostics.map((d) => ({ ...d }));
  return () => ({
    blockingCount: diags.filter((d) => d.severity === 'blocking').length,
    warningCount: diags.filter((d) => d.severity === 'warning').length,
    diagnostics: diags.map((d) => ({ ...d })),
  });
}

/**
 * 构造完整凭据链 + 草案（对齐 test_gate.py `_prepare_chain`）；planPath 非空时
 * verification 绑定该计划（code-review 自述继承）。
 * @param {string} proj @param {string} [task] @param {{planPath?: string|null}} [opts]
 * @returns {{v: object, c: object}}
 */
export function prepareChain(proj, task = '内部任务-1', { planPath = null } = {}) {
  const ev = evidenceEntry(proj);
  const v = issueVerificationReceipt(proj, task, ev, { profile: 'full', planPath });
  const c = issueCodeReviewReceipt(proj, task, v.receiptId, 's', {
    reviewInstances: 3,
    reviewRound: 1,
    reviewProvenance: prov(task, 3),
  });
  prepareDelivery(proj, task, {
    applicability: app(),
    changeScope: ['src/**'],
    receiptRefs: [v.receiptId, c.receiptId],
    specImpact: '规格条款演进与工件哈希重登',
  });
  return { v, c };
}

/**
 * 一条豁免审计记录（内部接口-20；默认 schemaVersion 1，v2 传 scope/planPath）。
 * @param {string} taskId @param {string} reason
 * @param {{src?: string, tsOffsetMs?: number, skill?: string, schemaVersion?: number, scope?: string|null, planPath?: string|null}} [opts]
 * @returns {string}
 */
export function exemptionLine(taskId, reason, {
  src = 'user', tsOffsetMs = 0, skill = 'verification', schemaVersion = 1, scope = null, planPath = null, ts = null,
} = {}) {
  const digest = sha256Hex(Buffer.from(`${taskId}|${reason}`, 'utf8')).slice(0, 12);
  const rec = {
    schemaVersion,
    id: `ex-${digest}`,
    ts: ts === null ? Date.now() + tsOffsetMs : ts,
    taskId,
    skill,
    src,
    reason,
    digest,
  };
  if (scope !== null) rec.scope = scope;
  if (planPath !== null) rec.planPath = planPath;
  return JSON.stringify(rec);
}

/** 写 `内部工作流状态`（行数组；每行换行结尾，对齐 `_write_store`）。 */
export function writeExemptionStore(proj, lines) {
  const store = join(proj, '.workflow', 'wf-exemptions.jsonl');
  mkdirSync(join(proj, '.workflow'), { recursive: true });
  writeFileSync(store, `${lines.join('\n')}\n`, 'utf8');
  return store;
}

/** 写一个计划文件（绝对路径）。 */
export function writePlan(proj, relName, body = '# 计划\n\n## 步骤 1：做事\n\n验收：退出码 0。\n') {
  const path = join(proj, relName);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

/** 绕过 prepare 直写旧形态草案（三必检节缺失；对齐 `_missing_required_sections` 用例）。 */
export function writeLegacyDraft(proj, task = '内部任务-1') {
  const reports = join(proj, '.sdd', 'reports', task);
  mkdirSync(reports, { recursive: true });
  const draft = {
    schemaVersion: '2.0.0',
    taskId: task,
    finalStatus: 'partial',
    applicability: 'SDD=required',
    specImpact: '待 gate 聚合核对',
    changeScope: [],
    receiptRefs: [],
    risks: [],
    unverified: [],
    preparedAt: 'x',
  };
  const path = join(reports, 'delivery-draft.json');
  writeFileSync(path, JSON.stringify(draft), 'utf8');
  return path;
}

/** operation 记录引用（recordRef；sha256 实测）。 */
export function recordRef(proj, rel = 'ops/record.md') {
  return { path: rel, sha256: `sha256:${sha256Hex(readFileSync(join(proj, rel)))}` };
}

/** 建立 ops/record.md 并返回 recordRef（Operation/Deliverable/Assertions 三组共用）。 */
export function makeRecord(proj, rel = 'ops/record.md', content = '# 记录\n') {
  mkdirSync(join(proj, rel, '..'), { recursive: true });
  writeFileSync(join(proj, rel), content, 'utf8');
  return recordRef(proj, rel);
}

/** 构造带探针的 operation criteria（无探针项时 probes 为空=legacy 文本项）。 */
export function opCriteria(probes = [], criterion = 'c', evidence = 'layout.log') {
  const items = [{ criterion, evidenceRef: evidence }];
  for (const probe of probes) items.push({ criterion, evidenceRef: evidence, probe });
  return items;
}

/** 读 JSON（测试断言便利件）。 */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** task 目录下指定前缀的凭据文件（排序）。 */
export function receiptFiles(proj, task, kind) {
  const dir = join(proj, '.sdd', 'receipts', task);
  try {
    return readdirSync(dir).filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
