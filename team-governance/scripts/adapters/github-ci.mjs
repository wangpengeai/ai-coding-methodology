// 文件：github-ci.mjs
// 描述：GitHub CI 适配器 warning-only 首版（内部规则-8 / 内部决策-015）——读本地治理报告出
//       provider-neutral 结论；默认零网络（dry-run 模式）；真实 API 写操作须执行时
//       对目标仓库+subject digest 单独授权（不在本模块实现）。退出码 0/1/2。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyReport } from '../lib/governance-gate.mjs';

/**
 * 运行 CI 检查（本地离线：消费治理报告）。
 * @param {string} root 项目根
 * @param {{reportPath?: string}} opts
 * @returns {{envelope: object, exitCode: number}}
 */
export function runGithubCi(root, opts = {}) {
  const reportPath = opts.reportPath ?? join(root, '.ai-governance', 'runtime', 'reports', 'governance-report.json');
  const base = {
    schemaVersion: '1.0.0', adapter: 'github-ci', capability: 'ci',
    request: {}, availability: 'available', externalEffects: [],
    correlation: { runId: 'ci-local', subjectDigest: null }, mode: 'dry-run',
  };
  if (!existsSync(reportPath)) {
    return {
      envelope: { ...base, availability: 'degraded',
        result: { status: 'unverified', summary: '治理报告缺失（项目未接入或未跑 gate）——warning-only：不阻断' } },
      exitCode: 0,
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return {
      envelope: { ...base, result: { status: 'unverified', summary: '治理报告不可解析（工具错误语义）' } },
      exitCode: 2,
    };
  }
  // 内部任务-256（N-H / 内部验收-26）：不得直接以自报 status 判 passed——必须经 verifyReport 复核。
  // 传 projectRoot 触发独立重收集：gate 后项目内容/控制输入新增删除→stale；无 integrityHash/重算不符→tampered；
  // legacy 无 binding→stale。warning-only 语义：复核失败映射 failed 退出 1（本适配器不参与 gate 判定）；
  // 复核本身不可用（config 缺失等不可信输入）按 unverified 退 0，不崩。
  let verdict;
  try {
    verdict = verifyReport(report, { projectRoot: root });
  } catch {
    return {
      envelope: { ...base, result: { status: 'unverified', summary: '治理报告复核不可用（项目控制输入不可读）——warning-only 不阻断' } },
      exitCode: 0,
    };
  }
  const passed = verdict === 'passed';
  return {
    envelope: {
      ...base,
      correlation: { ...base.correlation, subjectDigest: report.integrityHash ?? null },
      result: {
        status: passed ? 'passed' : 'failed',
        summary: passed ? '治理通过（经 verifyReport 复核）'
          : `治理复核未通过（verdict=${verdict}）：自报 ${report.status}、blocking ${report.blockingCount ?? '?'}；${((Array.isArray(report.diagnostics) ? report.diagnostics : []).slice(0, 3).map((d) => (d && typeof d.message === 'string' ? d.message : String(d))).join('；'))}`,
      },
    },
    exitCode: passed ? 0 : 1,
  };
}
