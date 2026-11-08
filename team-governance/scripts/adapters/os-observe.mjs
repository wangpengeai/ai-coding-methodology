// 文件：os-observe.mjs
// 描述：os-observation adapter 只读面（内部接口-1 / 内部规则-9 / 内部验收-9，内部需求-15/17）
//       ——读 findings 产信封（github-ci 同构先例），不触发采样（externalEffects 恒空）。
//       错误语义按 内部接口-1 §4：不可用（非 win32 / 未安装无数据）→ availability
//       =unavailable + 结果 unverified（不伪装 passed）；open suspicious>0 → failed；
//       raw 停滞（超 max(2×pollMinutes,30min)）→ degraded（summary 标采集停滞）。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { capabilityAvailability } from '../lib/os-observe-registry.mjs';
import { syncRawToFindings } from '../lib/os-observe-pipeline.mjs';
import { loadUserConfig } from '../lib/os-observe-classify.mjs';
import { countFindings, osObserveHome, rawFreshness, readFindings, staleOf } from '../lib/os-observe-store.mjs';
import { integrityHash } from '../lib/canonical-json.mjs';

/**
 * 只读判定面。home/platform/now 注入缝供测试；产出 {envelope}（信封本体即全部输出面）。
 * envelope 过 contract.validateEnvelope（消费方自验，CLI report 侧非空诊断即工具错误退 2）。
 */
export function runOsObserve({ home = osObserveHome(), platform = process.platform, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const base = {
    schemaVersion: '1.0.0',
    adapter: 'os-observe',
    capability: 'os-observation',
    request: {},
    externalEffects: [],
    correlation: { runId: '', subjectDigest: null },
  };
  const cap = capabilityAvailability({ platform });
  if (cap.availability !== 'available') {
    const summary = `os-observe 不可用：${cap.detail}${cap.guidance ? `；${cap.guidance}` : ''}`;
    return {
      envelope: { ...base, availability: 'unavailable', result: { status: 'unverified', summary } },
    };
  }

  syncRawToFindings(home, { now: nowMs });
  const findings = readFindings(home);
  const fresh = rawFreshness(home);
  if (fresh.files === 0 && findings.size === 0) {
    return {
      envelope: {
        ...base,
        availability: 'unavailable',
        result: { status: 'unverified', summary: 'os-observe 未安装或尚无观测数据（raw/findings 均空）；安装：governance-cli os-observe install' },
      },
    };
  }

  const agg = countFindings(findings);
  const cfg = loadUserConfig(home);
  // staleMinutes 取 staleOf 单一口径（2026-09-19 评审修复：原内联重算同式绕过单一实现，
  // 该函数的存在目的即「hook/status/adapter 三读取面共用口径，防公式漂移」）
  const { stale, staleMinutes: staleMin } = staleOf(fresh, cfg.config.pollMinutes, nowMs);
  const status = agg.openSuspicious > 0 ? 'failed' : 'passed';
  const summary = stale
    ? `观测停滞（raw 最新样本 ${staleMin} 分钟前，采集器疑似失效）；未确认可疑外发 ${agg.openSuspicious} 条（total ${findings.size}）`
    : `未确认可疑外发 ${agg.openSuspicious} 条（total ${findings.size}；allowed=${agg.byClass.allowed} suspicious=${agg.byClass.suspicious} unknown=${agg.byClass.unknown}）`;
  const digest = integrityHash({ openSuspicious: agg.openSuspicious, total: findings.size, byClass: agg.byClass, freshTs: fresh.newestTsMs });
  return {
    envelope: {
      ...base,
      availability: stale ? 'degraded' : 'available',
      result: { status, summary, digest },
      correlation: { runId: '', subjectDigest: digest },
    },
  };
}
