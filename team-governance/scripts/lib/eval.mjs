// 文件：eval.mjs
// 描述：replay-first 评测（内部规则-1..3 / 内部接口-17 / 内部决策-015）——离线回放 transcript
//       事件流跑确定性 oracle 七族（exact/regex/json-schema/behavior 含 required-forbidden/
//       tool-event/exit-code/file-diff；2026-09-19 评审修复：头注计数标签与 kind 枚举
//       数不符——file-diff 后增未更新计数，SKILL description/测试名同批对齐）；judge
//       不覆盖确定性失败；对象哈希不匹配即 unverified；duration 真实测量、token/cost
//       带 measurement 来源或 unavailable。
//       live stdio adapter 见 adapters/stdio.mjs（opt-in；本模块不含网络调用）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { performance } from 'node:perf_hooks';

import { validateAgainstSchema, SchemaError } from './json-schema.mjs';
import { integrityHash } from './canonical-json.mjs';

/** 确定性 oracle 七族（内部接口-17 §2；未知 kind 一律工具错误——H8）。 */
export const VALID_ORACLE_KINDS = new Set([
  'exact', 'regex', 'json-schema', 'behavior', 'tool-event', 'exit-code', 'file-diff',
]);

/** suite/case 形态错误（工具错误语义：CLI 退 2，不产报告、无栈）。 */
export class EvalSuiteShapeError extends Error {
  constructor(message, kind = null) {
    super(message);
    this.name = 'EvalSuiteShapeError';
    this.kind = kind;
  }
}

/**
 * suite/case 形态校验（内部任务-254 H8/内部验收-1）：空 cases、缺必填字段、未知 oracle kind
 * 一律抛可识别错误（EvalSuiteShapeError）→ CLI 映射工具错误退 2、不产报告。
 * live 路径（adapter 自带执行面）只要求 events/oracles 数组存在（可空）；replay 路径
 * 要求 oracles 非空（否则该 case 无判定面）。
 * @param {object} suite 已解析 suite JSON
 * @param {{requireOracles?: boolean}} [opts]
 * @returns {true}
 */
export function validateSuiteShape(suite, opts = {}) {
  const requireOracles = opts.requireOracles !== false;
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    throw new EvalSuiteShapeError('评测套件根须为对象', 'suite-root');
  }
  if (typeof suite.caseSetVersion !== 'string' || suite.caseSetVersion === '') {
    throw new EvalSuiteShapeError('suite.caseSetVersion 缺失（suite 须声明 case-set 版本）', 'case-missing-field');
  }
  if (!Array.isArray(suite.cases)) {
    throw new EvalSuiteShapeError('suite.cases 须为数组（缺字段）', 'case-missing-field');
  }
  if (suite.cases.length === 0) {
    throw new EvalSuiteShapeError('suite.cases 为空（空套件＝工具错误退 2）', 'empty-cases');
  }
  for (let i = 0; i < suite.cases.length; i += 1) {
    const c = suite.cases[i];
    const where = `cases[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new EvalSuiteShapeError(`${where} 须为对象`, 'case-missing-field');
    }
    if (typeof c.caseId !== 'string' || c.caseId === '') {
      throw new EvalSuiteShapeError(`${where} 缺 caseId（必填字段）`, 'case-missing-field');
    }
    if (typeof c.subjectHash !== 'string' || c.subjectHash === '') {
      throw new EvalSuiteShapeError(`${where}（${c.caseId}）缺 subjectHash（必填字段）`, 'case-missing-field');
    }
    if (!Array.isArray(c.events)) {
      throw new EvalSuiteShapeError(`${where}（${c.caseId}）缺 events 数组（必填字段）`, 'case-missing-field');
    }
    if (!Array.isArray(c.oracles)) {
      throw new EvalSuiteShapeError(`${where}（${c.caseId}）缺 oracles 数组（必填字段）`, 'case-missing-field');
    }
    if (requireOracles && c.oracles.length === 0) {
      throw new EvalSuiteShapeError(`${where}（${c.caseId}）oracles 为空（replay 无判定面）`, 'case-missing-field');
    }
    for (const o of c.oracles) {
      if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.kind !== 'string' || o.kind === '') {
        throw new EvalSuiteShapeError(`${where}（${c.caseId}）oracle 缺 kind`, 'oracle-missing-kind');
      }
      if (!VALID_ORACLE_KINDS.has(o.kind)) {
        throw new EvalSuiteShapeError(`${where}（${c.caseId}）未知 oracle kind：${o.kind}（合法七族：${[...VALID_ORACLE_KINDS].join('/')}）`, 'unknown-oracle-kind');
      }
    }
  }
  return true;
}

/**
 * 求值单个 oracleagainst 事件流。
 * @param {Array<object>} events transcript 事件（JSONL 已解析）
 * @param {{kind: string, [key: string]: unknown}} oracle
 * @returns {{hit: boolean, detail: string}}
 */
export function evaluateOracle(events, oracle) {
  switch (oracle.kind) {
    case 'exact': {
      const joined = events.map((e) => e.text ?? '').join('\n');
      return { hit: joined.includes(oracle.value), detail: `exact: ${String(oracle.value).slice(0, 32)}` };
    }
    case 'regex': {
      const re = oracle.pattern instanceof RegExp ? oracle.pattern : new RegExp(oracle.pattern, oracle.flags ?? '');
      const hit = events.some((e) => re.test(e.text ?? ''));
      return { hit, detail: `regex ${re.source}` };
    }
    case 'json-schema': {
      const candidates = events.filter((e) => e.json !== undefined);
      const hit = candidates.some((e) => validateAgainstSchema(e.json, oracle.schema).length === 0);
      return { hit, detail: 'json-schema 分支' };
    }
    case 'behavior': {
      // required：每条都必须在事件流出现；forbidden：任一出现即失败
      const text = events.map((e) => e.text ?? '').join('\n');
      for (const req of oracle.required ?? []) {
        if (!text.includes(req)) return { hit: false, detail: `required 未命中：${req}` };
      }
      for (const bad of oracle.forbidden ?? []) {
        if (text.includes(bad)) return { hit: false, detail: `forbidden 命中：${bad}` };
      }
      return { hit: true, detail: 'behavior 通过' };
    }
    case 'tool-event': {
      const names = events.filter((e) => e.type === 'tool').map((e) => e.name);
      for (const req of oracle.required ?? []) {
        if (!names.includes(req)) return { hit: false, detail: `required 工具事件缺失：${req}` };
      }
      for (const bad of oracle.forbidden ?? []) {
        if (names.includes(bad)) return { hit: false, detail: `forbidden 工具事件命中：${bad}` };
      }
      return { hit: true, detail: 'tool-event 通过' };
    }
    case 'exit-code': {
      const last = [...events].reverse().find((e) => e.type === 'exit');
      return { hit: last !== undefined && last.code === oracle.value, detail: `exit-code=${oracle.value}` };
    }
    case 'file-diff': {
      const diffs = events.filter((e) => e.type === 'diff');
      const hit = diffs.some((d) => {
        if (oracle.path != null && d.path !== oracle.path) return false;
        if (oracle.contains != null && !(String(d.contains ?? '')).includes(oracle.contains)) return false;
        return true;
      });
      return { hit, detail: `file-diff ${oracle.path ?? '*'}${oracle.contains ? ` ~${oracle.contains}` : ''}` };
    }
    default:
      return { hit: false, detail: `未知 oracle kind：${oracle.kind}` };
  }
}

/**
 * 跑一个 replay case。
 * @param {{caseId: string, subjectHash: string, events: Array<object>,
 *          oracles: Array<object>, judgeNote?: string}} testCase
 * @param {{currentSubjectHash: string}} env 当前被测对象哈希（不匹配→unverified）
 */
export function runCase(testCase, env) {
  if (testCase.subjectHash !== env.currentSubjectHash) {
    return { caseId: testCase.caseId, status: 'unverified',
             reason: `transcript 对象哈希 ${testCase.subjectHash.slice(0, 16)}… ≠ 当前 ${env.currentSubjectHash.slice(0, 16)}…` };
  }
  const t0 = performance.now();
  const results = testCase.oracles.map((o) => ({ kind: o.kind, ...evaluateOracle(testCase.events, o) }));
  const durationMs = Math.round((performance.now() - t0) * 10) / 10; // 真实测量
  const deterministicFail = results.some((r) => !r.hit);
  return {
    caseId: testCase.caseId,
    status: deterministicFail ? 'failed' : 'passed',
    oracles: results,
    // judge 只能补充解释；确定性失败时 judge 记录不改变结论（内部规则-2/B-M14-2）
    judgeNote: deterministicFail ? `${testCase.judgeNote ?? ''}（judge 不可覆盖确定性失败）`.trim() : testCase.judgeNote ?? null,
    durationMs,
  };
}

/**
 * 跑 replay suite，产出报告（内部规则-3 全字段）。
 * @param {{suiteId: string, caseSetVersion: string, cases: Array<object>}} suite
 * @param {{currentSubjectHash: string, currentSkillHash?: string}} env
 */
export function runReplaySuite(suite, env) {
  const cases = suite.cases.map((c) => runCase(c, env));
  const passed = cases.filter((c) => c.status === 'passed').length;
  const report = {
    schemaVersion: '1.0.0',
    suiteId: suite.suiteId,
    caseSetVersion: suite.caseSetVersion,
    subjectHash: env.currentSubjectHash,
    skillHash: env.currentSkillHash ?? null,
    mode: 'replay',
    cases,
    summary: {
      total: cases.length, passed,
      failed: cases.filter((c) => c.status === 'failed').length,
      unverified: cases.filter((c) => c.status === 'unverified').length,
      passRate: cases.length === 0 ? null : passed / cases.length,
    },
    resources: { tokens: { value: null, measurement: 'unavailable' },
                 cost: { value: null, measurement: 'unavailable' },
                 latencyMs: { value: cases.reduce((s, c) => s + (c.durationMs ?? 0), 0), measurement: 'wall-clock' } },
  };
  report.integrityHash = integrityHash(report);
  return report;
}
