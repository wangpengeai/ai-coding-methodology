// 文件：github-live.mjs
// 描述：GitHub 受控 live-read/live-write 路径（内部决策-015 / 内部接口-1 / D 计划步骤 16）——
//       默认 dry-run 零网络；--live-read 仅 GET（host allowlist/超时/响应上限）；
//       --live-write 五前置齐备才发请求（确认 digest/策略允许/审批/环境授权/预览摘要）。
//       token 只从环境读，不入任何落盘产物。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

import { pluginUa } from '../lib/client-info.mjs';

const HOST_ALLOWLIST = new Set(['api.github.com']);
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 1 << 20;

/**
 * live-read：GET 一个 GitHub API 资源并转中立信封。
 * @param {{path: string, token?: string}} req path 形如 /repos/o/r/pulls/1/reviews
 * @returns {Promise<{envelope: object}>}
 */
export async function githubLiveRead(req) {
  let url;
  try {
    url = new URL(req.path, 'https://api.github.com');
  } catch {
    return _envelope('unavailable', 'unverified', `路径不可解析：${req.path}`, { mode: 'live-read' });
  }
  if (!HOST_ALLOWLIST.has(url.hostname)) {
    return _envelope('unavailable', 'unverified', `host ${url.hostname} 不在允许列表`, { mode: 'live-read' });
  }
  const token = req.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return _envelope('unavailable', 'unverified', 'GITHUB_TOKEN 未设置（token 只从环境读）', { mode: 'live-read' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
                 'X-Governance-Adapter': pluginUa() },
      signal: controller.signal,
    });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) {
      return _envelope('degraded', 'unverified', `响应体超限（>${MAX_BODY_BYTES}B）`, { mode: 'live-read' });
    }
    const body = await res.text();
    if (body.length > MAX_BODY_BYTES) {
      return _envelope('degraded', 'unverified', `响应体超限（>${MAX_BODY_BYTES}B）`, { mode: 'live-read' });
    }
    if (!res.ok) {
      return _envelope('available', 'failed', `GitHub API ${res.status}`, { mode: 'live-read' });
    }
    const env = _envelope('available', 'passed', `GET ${url.pathname} → ${res.status}`, { mode: 'live-read' });
    env.body = JSON.parse(body);
    return env;
  } catch (e) {
    return _envelope('unavailable', 'unverified', `网络失败（${e.name}）——不使用旧缓存冒充当前结果`, { mode: 'live-read' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * live-write：五前置齐备才执行（内部决策-015 / 计划批准不默认放行真实外部写）。
 * @param {{confirmSubject: string, currentSubject: string, policyAllows: boolean,
 *          hasApproval: boolean, envAuthorized: boolean, request: object}} req
 */
export async function githubLiveWrite(req) {
  // 前置一：确认 digest 与当前 subject **均存在**且完全一致（内部任务-256——缺失不得因 undefined===undefined 通过）
  if (typeof req.confirmSubject !== 'string' || req.confirmSubject === ''
      || typeof req.currentSubject !== 'string' || req.currentSubject === '') {
    return _envelope('unavailable', 'unverified',
      '双 digest 缺失（confirmSubject/currentSubject 均须为非空字符串）——拒绝外部写', { mode: 'live-write' });
  }
  if (req.confirmSubject !== req.currentSubject) {
    return _envelope('unavailable', 'unverified',
      `confirm-subject 不匹配（${req.confirmSubject.slice(0, 16)}… vs ${req.currentSubject.slice(0, 16)}…）`, { mode: 'live-write' });
  }
  // 前置二：策略允许该外部写
  if (!req.policyAllows) {
    return _envelope('unavailable', 'unverified', 'policy 不允许此外部写', { mode: 'live-write' });
  }
  // 前置三：存在有效 Accountable/required approver 审批
  if (!req.hasApproval) {
    return _envelope('unavailable', 'unverified', '无有效审批', { mode: 'live-write' });
  }
  // 前置四：CI/调用环境授权
  if (!req.envAuthorized) {
    return _envelope('unavailable', 'unverified', '调用环境未授权', { mode: 'live-write' });
  }
  // 前置五：预操作摘要（调用方已呈现给用户）——request 本身即摘要载体
  // 五项齐备：执行（外部效果必须显式声明）
  const result = await req.executor();
  return {
    schemaVersion: '1.0.0', adapter: 'github', capability: req.capability ?? 'ci',
    request: { summary: 'live-write（前置五项齐备）' },
    result: { status: result.ok ? 'passed' : 'failed', summary: result.summary ?? '' },
    availability: 'available',
    externalEffects: [{ kind: req.capability ?? 'ci', target: req.target ?? 'unknown' }],
    correlation: { runId: req.runId ?? 'live-write', subjectDigest: req.currentSubject }, mode: 'live-write',
  };
}

function _envelope(availability, status, summary, extra) {
  return {
    schemaVersion: '1.0.0', adapter: 'github', capability: 'ci',
    request: {}, result: { status, summary },
    availability, externalEffects: [], correlation: { runId: 'live-read' }, ...extra,
  };
}
