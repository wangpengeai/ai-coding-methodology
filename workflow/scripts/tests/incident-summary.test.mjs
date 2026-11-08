// 文件：incident-summary.test.mjs
// 描述：内部模块-15 v2 摘要库（incident-summary.mjs）的先红后绿单测（内部规则-3/内部规则-10/内部决策-063 D6）：
//       待排查派生（六 cause 计入／三证据 cause 排除／无 cause 旧行两层回退／lease-loop 恒计入）、
//       归属三分（本任务／本会话／其他会话）、证据面分层计数、turn 增量、reader 注入单读、
//       坏行透出、promotions 30 天过龄、pendingRecords 视图（恒 length===total）与归属恒等式，
//       以及指针文案 formatPointerLine 逐字口径。
//       （内部验收-24 锚定面在 user-prompt-hook.test.mjs——本文件是摘要库单测，不承载该锚。）
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；夹具全部临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { appendIncident, countsByCause, readIncidentsWithStats, sessionMatches } from '../lib/incident-store.mjs';
import { buildSummary, countPromotions, formatPointerLine, formatPromotionLine } from '../lib/incident-summary.mjs';

const DAY = 86400000;

/** 临时项目根（每个用例独立，finally 清理）。 */
function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-isum-'));
}

/** 最小合法记录（可覆盖字段）。 */
const rec = (over = {}) => ({
  schemaVersion: 1,
  id: 'ri-s1',
  ts: Date.now(),
  session: 'sess-x',
  taskId: null,
  skill: null,
  plugin: null,
  kind: 'tool-failure',
  tool: 'Bash',
  event: null,
  digest: 'd0000000000000aa',
  status: 'open',
  ...over,
});

/** 造一份 promote 草案（文件名 `<ts>-<id>.md`）。 */
function writePromotion(root, ts, id) {
  const dir = join(root, '.workflow', 'promotions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ts}-${id}.md`), `# ${id}\n`);
}

test('M15 v2 摘要库：待排查派生与归属分组', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    // 待排查面：六 cause 中四类 + 旧记录回退命中项
    appendIncident(root, rec({ id: 'v2-real', kind: 'tool-failure', session: 'sess-mine', taskId: 'DEV-192', errorClass: 'error-flag', cause: 'real-failure', ts: now }));
    appendIncident(root, rec({ id: 'v2-loop', kind: 'lease-loop', session: 'sess-other', cause: 'mechanism-escalation', ts: now }));
    appendIncident(root, rec({ id: 'v2-corr', kind: 'user-correction', session: 'sess-other', cause: 'user-correction', ts: now }));
    // 证据面：三 cause + 旧记录回退命中的两类
    appendIncident(root, rec({ id: 'v2-probe', kind: 'tool-failure', session: 'sess-other', cause: 'probe-noise', ts: now }));
    appendIncident(root, rec({ id: 'v2-replay', kind: 'tool-failure', session: 'sess-other', cause: 'replayable-rejection', ts: now }));
    appendIncident(root, rec({ id: 'v2-trace', kind: 'lease-deny', session: 'sess-other', cause: 'mechanism-trace', ts: now }));
    appendIncident(root, rec({ id: 'lg-lease', kind: 'lease-deny', session: 'sess-other', ts: now })); // 无 cause 旧行：排除
    appendIncident(root, rec({ id: 'lg-probe', kind: 'tool-failure', session: 'sess-other', errorClass: 'exit-nonzero', ts: now })); // 无 cause 旧行：排除
    appendIncident(root, rec({ id: 'lg-real', kind: 'tool-failure', session: 'sess-other', errorClass: 'error-flag', ts: now })); // 无 cause 旧行：计入
    // 非 open：不计入待排查/证据面
    appendIncident(root, rec({ id: 'v2-triaged', kind: 'tool-failure', session: 'sess-other', status: 'triaged', cause: 'real-failure', ts: now }));

    const s = buildSummary(root, { sessionId: 'sess-mine', host: null, taskId: 'DEV-192', now });
    assert.equal(s.total, 4, '待排查＝real-failure＋lease-loop＋user-correction＋旧行 error-flag（triaged 不计）');
    assert.equal(s.byTask, 1, '本任务归属按 taskId 命中');
    assert.equal(s.bySession, 0, '本会话桶不含已计入本任务者');
    assert.equal(s.byOthers, 3, '其他会话＝lease-loop＋user-correction＋旧行');
    assert.equal(s.byTask + s.bySession + s.byOthers, s.total, '三分之和恒等于待排查总数（单次读盘同源）');
    assert.equal(s.evidence, 5, '证据面＝三 cause＋旧行 lease-deny/exit-nonzero（open 且非待排查）');
    assert.equal(s.byCause['real-failure'], 2, 'byCause 覆盖全量记录（含 triaged）');
    assert.equal(s.byCause['probe-noise'], 1);
    assert.equal(s.byCause.unclassified, 3, '无 cause 旧行归 unclassified');
    assert.deepEqual(formatPointerLine(s), '4 条待排查（本任务 1 / 本会话 0 / 其他会话 3；证据面 5 条已分层排除）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pendingRecords：待排查记录视图与 total 同源且排除证据面', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'pr-real', session: 'sess-mine', cause: 'real-failure' }));
    appendIncident(root, rec({ id: 'pr-probe', session: 'sess-mine', cause: 'probe-noise' }));
    appendIncident(root, rec({ id: 'pr-other', session: 'sess-other', kind: 'user-correction', cause: 'user-correction' }));
    appendIncident(root, rec({ id: 'pr-task', session: 'sess-other', taskId: 'DEV-215', cause: 'real-failure' }));
    // 双命中夹具（taskId 命中 ∧ 本会话命中）——生产常态（post-tool 同时写 session+taskId），
    // 用于判错 bySession 被误改成独立累加（双计）类回归。
    appendIncident(root, rec({ id: 'pr-both', session: 'sess-mine', taskId: 'DEV-215', cause: 'real-failure' }));
    const s = buildSummary(root, { sessionId: 'sess-mine', taskId: 'DEV-215', now: Date.now() });
    assert.equal(s.pendingRecords.length, s.total, '待排查记录视图长度恒等于 total');
    assert.deepEqual(s.pendingRecords.map((r) => r.id).sort(), ['pr-both', 'pr-other', 'pr-real', 'pr-task'], '只含待排查面');
    assert.equal(s.byTask, 2, 'taskId 分支命中 2（含双命中 1）');
    assert.equal(s.bySession, 1, '本会话分支命中 1（双命中不再计本会话）');
    const owned = s.pendingRecords.filter((r) => r.taskId === 'DEV-215' || sessionMatches(r, 'sess-mine', null));
    assert.equal(owned.length, s.byTask + s.bySession, '归属投影恒等于本任务+本会话两桶之和（N≡byTask+bySession；双命中只计一次）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reader 注入：摘要只读一次盘（计数 reader 断言调用次数与 dropped 透出）', () => {
  const rows = [
    rec({ id: 'r1', cause: 'real-failure', session: 's1' }),
    rec({ id: 'r2', cause: 'probe-noise', session: 's1' }),
    rec({ id: 'r3', cause: 'real-failure', session: 's2' }),
  ];
  let calls = 0;
  const reader = () => {
    calls += 1;
    return { records: rows, dropped: 2 };
  };
  const s = buildSummary('/nonexistent-root', { sessionId: 's1', reader });
  assert.equal(calls, 1, '摘要库单次读盘（禁止内部二次读）');
  assert.equal(s.dropped, 2, '坏行计数透出（与 records 同次读盘）');
  assert.equal(s.total, 2, '两条 real-failure 计入待排查（probe-noise 归证据面）');
  assert.equal(s.evidence, 1);
  assert.equal(s.records, rows, '注入 reader 的 rows 原样透出（消费方零二次读）');
});

test('无 cause 旧记录按两层口径回退（零迁移兼容）', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'l1', kind: 'lease-deny' }));
    appendIncident(root, rec({ id: 'l2', kind: 'lease-revive' }));
    appendIncident(root, rec({ id: 'l3', kind: 'tool-failure', errorClass: 'exit-nonzero' }));
    appendIncident(root, rec({ id: 'l4', kind: 'tool-failure', errorClass: 'stderr' }));
    const s = buildSummary(root, { sessionId: 's', now: Date.now() });
    assert.equal(s.total, 1, '仅 errorClass=stderr 的旧 tool-failure 属待排查');
    assert.equal(s.evidence, 3, 'lease-deny/lease-revive/exit-nonzero 归证据面');
    assert.equal(s.byCause.unclassified, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lease-loop 恒计入待排查（cause=mechanism-escalation 承接强制显示不变量）', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'll-1', kind: 'lease-loop', session: 'sess-other' })); // 无 cause：旧行但 kind 归？
    appendIncident(root, rec({ id: 'll-2', kind: 'lease-loop', session: 'sess-other', cause: 'mechanism-escalation' }));
    const s = buildSummary(root, { sessionId: 'sess-mine', now: Date.now() });
    assert.equal(s.total, 2, 'lease-loop 两类形态均计入待排查');
    assert.equal(s.byOthers, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏行容错：真实账本混入坏行时 dropped 透出且有效记录仍派生', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'ok-1', cause: 'real-failure' }));
    writeFileSync(join(root, '.workflow', 'incidents.jsonl'), 'not-json {{{\n{"no_id":true}\n', { flag: 'a' });
    const s = buildSummary(root, { sessionId: 's', now: Date.now() });
    assert.equal(s.dropped, 2, '非空坏行计数（空行不计）');
    assert.equal(s.total, 1);
    assert.equal(s.records.length, 1, '坏行不污染 records');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatPointerLine：归零空串、文案含三分与证据面（纯函数直测）', () => {
  assert.equal(formatPointerLine({ total: 0, evidence: 3, byTask: 0, bySession: 0, byOthers: 0 }), '', '待排查归零 ⇒ 空串');
  assert.equal(formatPointerLine(null), '');
  assert.equal(
    formatPointerLine({ total: 2, evidence: 0, byTask: 1, bySession: 1, byOthers: 0 }),
    '2 条待排查（本任务 1 / 本会话 1 / 其他会话 0；证据面 0 条已分层排除）',
  );
});

test('countPromotions：≤30 天草案计数、过龄草案单列 expired（不提醒）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    writePromotion(root, now - 1 * DAY, 'fresh-1');
    writePromotion(root, now - 29 * DAY, 'fresh-2');
    writePromotion(root, now - 31 * DAY, 'old-1');
    const p = countPromotions(root, { now });
    assert.equal(p.promotions, 2, '未过龄草案计 2 份');
    assert.equal(p.expiredPromotions, 1, '过龄草案单列（不提醒）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('countPromotions：目录缺席/坏文件名 fail-open 零计数不抛', () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(countPromotions(root, { now: Date.now() }), { promotions: 0, expiredPromotions: 0 });
    writePromotion(root, Date.now(), 'x');
    mkdirSync(join(root, '.workflow', 'promotions'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'promotions', 'readme.txt'), 'x'); // 非 .md：忽略
    const p = countPromotions(root, { now: Date.now() });
    assert.equal(p.promotions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 内部任务-348 批 D（内部未决-214④）：读放大面可观测——countPromotions 的 readdir 注入缝计数目录枚举
// （直调恰 1 次；buildSummary 嵌入消费恰 1 次——无复读放大；未来实现引入目录重复枚举即红）。
test('DEV-348 OPEN-214④ countPromotions 读放大面：目录枚举恰 1 次（直调与 buildSummary 嵌入）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    writePromotion(root, now - 2 * DAY, 'dup-a');
    writePromotion(root, now - 35 * DAY, 'dup-b');
    let calls = 0;
    const countingReaddir = (dir) => { calls += 1; return readdirSync(dir); };
    const p = countPromotions(root, { now, readdir: countingReaddir });
    assert.equal(p.promotions, 1);
    assert.equal(p.expiredPromotions, 1);
    assert.equal(calls, 1, `countPromotions 直调目录枚举恰 1 次，实际 ${calls}`);
    calls = 0;
    const s = buildSummary(root, { now, promotionsReaddir: countingReaddir });
    assert.equal(s.promotions, 1, 'buildSummary 嵌入消费与直调一致');
    assert.equal(s.expiredPromotions, 1, 'expired 嵌入消费一致');
    assert.equal(calls, 1, `buildSummary 嵌入的 promotions 目录枚举恰 1 次，实际 ${calls}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildSummary 透出 promotions/expiredPromotions（单次读盘同一摘要）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    writePromotion(root, now, 'fresh');
    writePromotion(root, now - 40 * DAY, 'stale');
    const s = buildSummary(root, { sessionId: 's', now });
    assert.equal(s.promotions, 1);
    assert.equal(s.expiredPromotions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空态：缺文件全零、不抛、formatPointerLine 空串', () => {
  const root = tmpRoot();
  try {
    const s = buildSummary(root, { sessionId: 's', now: Date.now() });
    assert.equal(s.total, 0);
    assert.equal(s.evidence, 0);
    assert.equal(s.dropped, 0);
    assert.deepEqual(s.newRecords, []);
    assert.equal(formatPointerLine(s), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归属判等：显式异宿不并入本会话（host 三态沿用 sessionMatches）', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'h-mine', session: 'sess-same', host: 'zcode', cause: 'real-failure' }));
    appendIncident(root, rec({ id: 'h-other', session: 'sess-same', host: 'dsh', cause: 'real-failure' }));
    const s = buildSummary(root, { sessionId: 'sess-same', host: 'zcode', now: Date.now() });
    assert.equal(s.bySession, 1, '同归一会话同宿命中');
    assert.equal(s.byOthers, 1, '显式异宿不误归并');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('摘要零副作用：读后账本字节与行数不变', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'ro-1', cause: 'real-failure' }));
    const file = join(root, '.workflow', 'incidents.jsonl');
    const before = readFileSync(file, 'utf8');
    buildSummary(root, { sessionId: 's', now: Date.now() });
    countPromotions(root, { now: Date.now() });
    assert.equal(readFileSync(file, 'utf8'), before, '纯读：账本零改写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('turn 增量：sinceTs 之后的新增、lease-loop 无视会话匹配、非待排查不计', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    appendIncident(root, rec({ id: 't-old', session: 'sess-mine', cause: 'real-failure', ts: now - 10000 }));
    appendIncident(root, rec({ id: 't-new', session: 'sess-mine', cause: 'real-failure', ts: now - 100 }));
    appendIncident(root, rec({ id: 't-loop', kind: 'lease-loop', session: 'sess-other', cause: 'mechanism-escalation', ts: now - 100 }));
    appendIncident(root, rec({ id: 't-probe', session: 'sess-mine', cause: 'probe-noise', ts: now - 100 }));
    appendIncident(root, rec({ id: 't-other', session: 'sess-other', cause: 'real-failure', ts: now - 100 }));
    const s = buildSummary(root, { sessionId: 'sess-mine', sinceTs: now - 1000, now });
    assert.equal(s.turnDelta, 2, '增量＝本会话新增＋lease-loop（其他会话/证据面不计）');
    assert.deepEqual(s.newRecords.map((r) => r.id).sort(), ['t-loop', 't-new']);
    const noSince = buildSummary(root, { sessionId: 'sess-mine', now });
    assert.equal(noSince.turnDelta, null, '未给 sinceTs 时不产增量口径（null 而非 0）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('byCause 与 store 的 countsByCause 同源（真实账本）', () => {
  const root = tmpRoot();
  try {
    appendIncident(root, rec({ id: 'c1', cause: 'real-failure' }));
    appendIncident(root, rec({ id: 'c2', cause: 'probe-noise' }));
    appendIncident(root, rec({ id: 'c3' }));
    const s = buildSummary(root, { sessionId: 's', now: Date.now() });
    assert.deepEqual(s.byCause, countsByCause(root));
    assert.equal(readIncidentsWithStats(root).records.length, 3, '同源读取基线');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评审修复 N9：formatPromotionLine 单源文案（归零空串；份数入句）', () => {
  assert.equal(formatPromotionLine({ promotions: 0 }), '', '无未过龄草案 ⇒ 空串');
  assert.equal(formatPromotionLine(null), '');
  assert.equal(
    formatPromotionLine({ promotions: 2 }),
    '【workflow 自察】有 2 份 promote 草案待转正（.workflow/promotions/）——人工复核后按 learning/OPEN/架构反馈之一转正（禁止自动改写权威面）。',
  );
});
