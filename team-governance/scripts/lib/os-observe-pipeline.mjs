// 文件：os-observe-pipeline.mjs
// 描述：os-observation raw→findings 增量物化（内部规则-10 / 内部验收-7，内部需求-15/16）——
//       读取面（hook/CLI/adapter）在读取前调用：游标增量读 raw → DNS 索引 join →
//       逐样本三态分类 → 节流折叠（allowed 24h / unknown 1h / suspicious 每轮至多
//       一行刷新；同批同 id 去重）→ append findings。游标损坏由 store 层全量重读，
//       幂等由 findings id 去重承担（「基线损坏则重建」）。count=观测命中轮次
//       （近似值，全量重扫可重复计数，仅热度参考）。fail-toward-alert：解析异常
//       记 unknown 不丢弃。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { buildDomainIndex, classifySample, loadUserConfig } from './os-observe-classify.mjs';
import { appendFinding, digestOf, makeFinding, readFindings, readRawSince, writeCursor } from './os-observe-store.mjs';

const THROTTLE_MS = { allowed: 24 * 3600_000, unknown: 3600_000, suspicious: 0 };

/**
 * 增量物化一轮：返回 {scanned, appended, skipped, byClass}。
 * now 注入缝供测试（行写入时刻与节流窗基准）；maxRows 透传 store（hook 侧限幅）。
 * 游标在样本循环**完成后**才落盘（at-least-once：中途异常 → 下轮重读本批，靠
 * findings id 折叠幂等兜底，count 可虚增——已声明的近似口径）。
 */
export function syncRawToFindings(home, { now = Date.now(), maxRows } = {}) {
  const empty = { scanned: 0, appended: 0, skipped: 0, byClass: { allowed: 0, suspicious: 0, unknown: 0 } };
  const { samples, cursor } = readRawSince(home, { maxRows });
  if (samples.length === 0) {
    if (cursor) writeCursor(home, cursor);
    return empty;
  }

  const cfg = loadUserConfig(home);
  const rules = { userAllow: cfg.config.allow, userSuspicious: cfg.config.suspicious };
  const domainIndex = buildDomainIndex(samples);
  const folded = readFindings(home);
  const batchTs = new Map(); // 本批已写行的行时刻（同批同 id 去重）
  const result = { scanned: samples.length, appended: 0, skipped: 0, byClass: { allowed: 0, suspicious: 0, unknown: 0 } };

  for (const s of samples) {
    const c = classifySample(s, rules, domainIndex);
    const id = `of-${digestOf([c.idInput])}`;
    const obsTs = (!s || s.__parseError) ? now : (Date.parse(s.ts) || now); // 样本观测时间，坏时间戳回退 now
    const existing = folded.get(id);
    const lastWriteTs = Math.max(existing?.ts ?? -1, batchTs.get(id) ?? -1);
    const throttle = THROTTLE_MS[c.class] ?? 0;
    // 类别翻转不受目标类节流约束（内部任务-ALLOWCLI-1 真机缺陷修复）：节流只压「同态刷新」，
    // 状态迁移行必须即时落盘——否则用户加白/加黑后自愈最长延迟 24h（fold 末条为准被节流遮蔽）。
    const classChanged = existing !== undefined && existing.class !== c.class;
    if (existing && !classChanged && (lastWriteTs === now || now - lastWriteTs < throttle)) {
      result.skipped += 1;
      continue;
    }
    const fields = {
      id, ts: now, source: c.source, process: c.process, endpoint: c.endpoint, endpointKind: c.endpointKind,
      class: c.class, basis: c.basis,
      firstSeen: existing ? existing.firstSeen : obsTs,
      lastSeen: obsTs,
      count: (existing?.count ?? 0) + 1,
    };
    if (c.viaDomain !== undefined) fields.viaDomain = c.viaDomain;
    if (c.class === 'suspicious') {
      // ack 后刷新行照常（留痕与告警解耦）；status 写前实时重读折叠态——缩窄与
      // CLI ack 并发交错时把 acknowledged 回退成 open 的窗口（评审正确性 4 处置）
      const live = readFindings(home).get(id);
      fields.status = live?.status ?? existing?.status ?? 'open';
    }
    const row = appendFinding(home, makeFinding(fields));
    folded.set(id, row);
    batchTs.set(id, now);
    result.appended += 1;
    result.byClass[c.class] += 1;
  }
  if (cursor) writeCursor(home, cursor);
  return result;
}
