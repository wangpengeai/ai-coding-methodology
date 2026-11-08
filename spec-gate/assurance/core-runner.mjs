// 文件：core-runner.mjs
// 描述：gate → 冻结 core 的子进程缝（内部决策-051 阶段4 D1：spawn 目标 python→node）。
//       保留 600s/120s 超时、缺 mode 补默认、plan runner 对 {"error"} 原样返回等已冻结语义。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_TIMEOUT_MS = 600000;
export const PLAN_TIMEOUT_MS = 120000;
export const CORE_VALIDATOR = resolve(dirname(fileURLToPath(import.meta.url)), '../core/validator');

function coreError(ruleId, message) {
  return {
    schemaVersion: '1.0.0',
    mode: 'error',
    filesChecked: 0,
    blockingCount: 1,
    warningCount: 0,
    // G05（内部任务-241）：工具/配置错误标记——保留 blocking（不签凭据），CLI 据此退 2。
    diagnostics: [{ ruleId, severity: 'blocking', file: 'core', line: 1, fixHint: message, toolError: true }],
  };
}

function planError(planPath, ruleId, message) {
  return {
    blockingCount: 1,
    warningCount: 0,
    diagnostics: [{ ruleId, severity: 'blocking', file: String(planPath), line: 1, fixHint: message }],
  };
}

export function coreValidatorPath(env = process.env) {
  return env.SG_CORE_VALIDATOR || join(CORE_VALIDATOR, 'validate_specs.mjs');
}

function spawnCore(validator, argv, timeoutMs, env) {
  const r = spawnSync(process.execPath, [validator, ...argv], {
    encoding: 'utf8', timeout: timeoutMs, env: { ...env },
  });
  if (r.error && (r.error.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM'))) {
    return { timedOut: true, result: r };
  }
  if (r.error) {
    const err = new Error(`core 校验器无法启动: ${r.error.message}`);
    err.code = r.error.code;
    throw err;
  }
  return { timedOut: false, result: r };
}

/** 生产 core runner：有 内部治理状态 走 suite，否则走 sdd_check(mjs)。 */
export function defaultCoreRunner(root, opts = {}) {
  const repo = resolve(root);
  const env = opts.env ?? process.env;
  const validator = opts.validatorPath ?? coreValidatorPath(env);
  const hasSuite = existsSync(join(repo, '.sdd/suite.json'));
  const argv = hasSuite
    ? ['--mode', 'suite', '--config', join(repo, '.sdd/suite.json'), '--format', 'json']
    : ['--project', repo, '--format', 'json'];
  const target = hasSuite ? validator : join(dirname(validator), 'tools', 'sdd_check.mjs');
  const timeoutMs = opts.timeoutMs ?? CORE_TIMEOUT_MS;
  const { timedOut, result } = spawnCore(target, argv, timeoutMs, env);
  if (timedOut) return coreError('RULE-GATE-CORE-TIMEOUT', `core 校验器超时（${Math.round(timeoutMs / 1000)}s）——工具挂死按阻断呈现，非内容结论`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return coreError('RULE-GATE-CORE', `core 校验器输出不可解析（退出码 ${result.status}）`);
  }
  if (report && typeof report === 'object' && typeof report.error === 'string') {
    return coreError('RULE-GATE-CORE', `core 校验器以工具/配置错误退出（退出码 ${result.status}）：${String(report.error).slice(0, 300)}`);
  }
  if (!report || typeof report !== 'object' || typeof report.blockingCount !== 'number') {
    return coreError('RULE-GATE-CORE', `core 校验器以工具/配置错误退出（退出码 ${result.status}）：报告缺 blockingCount，形态异常`);
  }
  if (!report.mode) report.mode = hasSuite ? 'suite' : 'baseline';
  return report;
}

/** plan runner：保留 3a 已冻结的「{"error"} 原样返回」怪癖。 */
export function defaultPlanRunner(root, planPath, opts = {}) {
  const repo = resolve(root);
  const env = opts.env ?? process.env;
  const validator = opts.validatorPath ?? coreValidatorPath(env);
  const hasSuite = existsSync(join(repo, '.sdd/suite.json'));
  const argv = ['--mode', 'plan'];
  if (hasSuite) argv.push('--config', join(repo, '.sdd/suite.json'));
  argv.push('--plan', String(planPath), '--format', 'json');
  const timeoutMs = opts.timeoutMs ?? PLAN_TIMEOUT_MS;
  const { timedOut, result } = spawnCore(validator, argv, timeoutMs, env);
  if (timedOut) return planError(planPath, 'RULE-GATE-PLAN-TIMEOUT', `计划校验器超时（${Math.round(timeoutMs / 1000)}s）——工具挂死按阻断呈现，非内容结论`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return planError(planPath, 'RULE-GATE-PLAN', '计划校验输出不可解析');
  }
}
