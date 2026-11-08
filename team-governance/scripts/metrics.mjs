// 文件：metrics.mjs
// 描述：团队治理指标（内部规则-7 / 内部需求-14 / 内部决策-015）——只做过程/系统维度；
//       按人分组键（initiator/reviewer/login/author/assignee）的请求拒绝执行（非绩效红线）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

/** 非绩效红线：这些键作为 groupBy 即拒绝。 */
const FORBIDDEN_GROUP_KEYS = new Set(['initiator', 'reviewer', 'login', 'author', 'assignee', 'humanInitiator', 'user']);

/** 允许的过程/系统维度。 */
const ALLOWED_GROUP_KEYS = new Set([
  'policy', 'suite', 'skill', 'agent', 'model', 'day', 'week', 'changeSet',
  'resource', 'gate', 'case', 'status', 'plugin',
]);

/**
 * 聚合指标。
 * @param {Array<Record<string, unknown>>} records
 * @param {{groupBy: string, metric: string}} query
 * @returns {{ok: boolean, rows?: object, error?: string}}
 */
export function aggregate(records, query) {
  if (FORBIDDEN_GROUP_KEYS.has(query.groupBy) || !ALLOWED_GROUP_KEYS.has(query.groupBy)) {
    return { ok: false, error: `分组键「${query.groupBy}」被拒绝：团队指标只做过程/系统维度，禁止个人绩效排行（FR-tg-14）` };
  }
  const rows = {};
  for (const r of records) {
    const key = String(r[query.groupBy] ?? 'unknown');
    const val = Number(r[query.metric] ?? 0);
    if (!rows[key]) rows[key] = { count: 0, sum: 0 };
    rows[key].count += 1;
    rows[key].sum += Number.isFinite(val) ? val : 0;
  }
  return { ok: true, rows };
}

// ── CLI 入口（--selftest B-M8-4 同款纪律）──

if (process.argv[1] && process.argv[1].endsWith('metrics.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const checks = [];
    const check = (name, cond) => checks.push([name, Boolean(cond)]);
    const good = aggregate([{ policy: 'p1', latencyMs: 10 }, { policy: 'p1', latencyMs: 30 }], { groupBy: 'policy', metric: 'latencyMs' });
    check('过程维度聚合可用', good.ok && good.rows.p1.count === 2 && good.rows.p1.sum === 40);
    const bad = aggregate([], { groupBy: 'initiator', metric: 'x' });
    check('按人分组被拒绝', !bad.ok && /拒绝/.test(bad.error ?? ''));
    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
    process.exit(failed.length ? 1 : 0);
  }
  process.stderr.write('用法：node metrics.mjs --selftest（聚合经模块导出消费）\n');
  process.exit(2);
}
