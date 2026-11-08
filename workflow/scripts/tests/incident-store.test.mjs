// 文件：incident-store.test.mjs
// 描述：incident-store.mjs（内部模块-15 运行自察存储库）+ incident-cli.mjs 的行为测试——
//       追加/读侧幂等去重/坏行容忍/状态机/聚合热度/CLI 子进程契约。
//       覆盖：回环、同 id 二写读侧去重、坏行容忍、缺文件、setStatus 合法链与
//       非法拒绝、openCount 与 heat 聚合降序、CLI list/triage/resolve/--selftest。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 用临时目录（WF_INCIDENT_ROOT 注入缝）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 相对说明符按本模块 URL 解析，跨平台一致（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const LIB = await import('../lib/incident-store.mjs');
const CLI = resolve(HERE, '..', 'incident-cli.mjs');

/** 临时项目根（每个用例独立，finally 清理）。 */
function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-incident-'));
}

/** 构造一条最小合法记录（可覆盖字段）。 */
const rec = (over = {}) => ({
  schemaVersion: 1,
  id: 'ri-test-1',
  ts: Date.now(),
  session: 'sess-x',
  taskId: null,
  skill: null,
  plugin: null,
  kind: 'tool-failure',
  tool: 'Bash',
  event: null,
  digest: 'd1a2b3c4d5e60708',
  count: 1,
  status: 'open',
  note: null,
  ...over,
});

test('追加→读取回环：字段保真，appendIncident 返回 {ok:true,id}', () => {
  const root = tmpRoot();
  try {
    const r = LIB.appendIncident(root, rec());
    assert.ok(r.ok, `追加应成功（收到 ${JSON.stringify(r)}）`);
    assert.equal(r.id, 'ri-test-1');
    const list = LIB.readIncidents(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'tool-failure');
    assert.equal(list[0].digest, 'd1a2b3c4d5e60708');
    assert.equal(list[0].status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同 id 二写：文件 2 行（O_APPEND 追加不丢），读侧幂等去重只返回 1 条（末条为准）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec());
    LIB.appendIncident(root, rec({ ts: Date.now() + 1 }));
    const file = LIB.incidentFile(root);
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    assert.equal(lines, 2, '并发追加语义：两条都在文件里');
    const list = LIB.readIncidents(root);
    assert.equal(list.length, 1, '读侧按 id 折叠为一条');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('状态变更追加式（零覆盖写）：setStatus 追加同 id 新行，读侧末条胜出；回退被拒', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-append-1' }));
    assert.ok(LIB.setStatus(root, 'ri-append-1', 'triaged', '排查中').ok);
    const afterTriage = LIB.readIncidents(root);
    assert.equal(afterTriage.length, 1, '状态行与原行同 id，读侧仍一条');
    assert.equal(afterTriage[0].status, 'triaged', '末条（状态变更行）胜出');
    assert.equal(afterTriage[0].note, '排查中');
    assert.ok(!LIB.setStatus(root, 'ri-append-1', 'open').ok, '回退 open 被拒（仅前向）');
    assert.ok(LIB.setStatus(root, 'ri-append-1', 'resolved', '闭环').ok, 'triaged→resolved 前向合法');
    assert.equal(LIB.readIncidents(root)[0].status, 'resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appendIncident 契约：缺 id 或缺 ts 返回 {ok:false}（幂等 id 由写入方负责）', () => {
  const root = tmpRoot();
  try {
    assert.ok(!LIB.appendIncident(root, { ts: Date.now() }).ok, '缺 id 拒绝');
    assert.ok(!LIB.appendIncident(root, { id: 'ri-x' }).ok, '缺 ts 拒绝');
    assert.equal(LIB.readIncidents(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏行容忍：混入非 JSON 行后读取仍返回有效记录', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-ok-1' }));
    writeFileSync(LIB.incidentFile(root), 'not-json {{{\n', { flag: 'a' });
    const list = LIB.readIncidents(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ri-ok-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readIncidentsWithStats：坏行计数与记录同次读盘（OPEN-92，DEV-50）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-ws-1' }));
    LIB.appendIncident(root, rec({ id: 'ri-ws-2' }));
    LIB.appendIncident(root, rec({ id: 'ri-ws-3' }));
    // 两类坏行（不可解析 / id 非字符串）+ 一空行（不计 dropped——空行非数据缺口信号）
    writeFileSync(LIB.incidentFile(root), 'not-json {{{\n{"id":123,"ts":1}\n\n', { flag: 'a' });
    const stats = LIB.readIncidentsWithStats(root);
    assert.equal(stats.records.length, 3, '有效记录全数可读');
    assert.equal(stats.dropped, 2, '坏行计数=非空行中不可解析或无 id 的行数（空行不计）');
    assert.deepEqual(stats.records, LIB.readIncidents(root), 'records 投影与 readIncidents 逐字一致（折叠语义同源）');
    assert.equal(LIB.readIncidentsWithStats(join(root, 'nope')).dropped, 0, '缺文件空态计数 0（状态由 ledger.status 承载，不与计数混同）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI list --json：ledger.dropped 投影（OPEN-92，IF-COLLAB-19 §2 加法）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-dr-1' }));
    writeFileSync(LIB.incidentFile(root), 'not-json {{{\n{"id":123}\n', { flag: 'a' });
    const out = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', root, 'list', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(out.ledger.status, 'ok');
    assert.equal(out.ledger.dropped, 2, '坏行计数经 ledger.dropped 暴露（与 records 同次读盘）');
    assert.equal(out.records.length, 1, '坏行不影响 records');
    const missing = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', join(root, 'nope'), 'list', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(missing.ledger.status, 'missing');
    assert.equal(missing.ledger.dropped, 0, '缺文件 dropped=0（三态与计数不混同）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI triage/resolve --json：成功面单行机器投影（OPEN-99，DEV-50）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-tj-1' }));
    LIB.appendIncident(root, rec({ id: 'ri-tj-2' }));
    const t = spawnSync(process.execPath, [CLI, '--project-root', root, 'triage', 'ri-tj-1', '--json'], { encoding: 'utf8' });
    assert.equal(t.status, 0, `triage --json 退 0（实际 ${t.status}：${t.stderr}）`);
    const tj = JSON.parse(t.stdout);
    assert.deepEqual(
      Object.keys(tj).sort(),
      ['amended', 'command', 'id', 'schemaVersion', 'status'],
      '成功面键集即契约面（机器投影）',
    );
    assert.equal(tj.schemaVersion, 1);
    assert.equal(tj.command, 'triage');
    assert.equal(tj.id, 'ri-tj-1', 'id 为全等形态（非截断前缀）');
    assert.equal(tj.status, 'triaged');
    assert.equal(tj.amended, false);
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'resolve', 'ri-tj-1', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).status, 'resolved', 'resolve --json 投影 resolved');
    const human = spawnSync(process.execPath, [CLI, '--project-root', root, 'triage', 'ri-tj-2'], { encoding: 'utf8' });
    assert.ok(human.stdout.includes('完成'), '不带 --json 时人读行保持（非契约面不变）');
    const fail = spawnSync(process.execPath, [CLI, '--project-root', root, 'triage', 'no-such-id', '--json'], { encoding: 'utf8' });
    assert.equal(fail.status, 1, '失败面维持退 1（退出码分流，失败不造契约）');
    assert.ok(fail.stderr.includes('失败'), '失败面维持 stderr 人读');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺文件：readIncidents 返回 []，openCount 为 0，heat 为 []', () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(LIB.readIncidents(root), []);
    assert.equal(LIB.openCount(root), 0);
    assert.deepEqual(LIB.heat(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setStatus：open→triaged→resolved 合法链生效；非法 id 与非法状态拒绝', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-chain-1' }));
    assert.ok(LIB.setStatus(root, 'ri-chain-1', 'triaged', '怀疑与发布缓存有关').ok);
    assert.ok(LIB.setStatus(root, 'ri-chain-1', 'resolved', '根因：目录清理').ok);
    assert.equal(LIB.readIncidents(root)[0].status, 'resolved');
    assert.equal(LIB.readIncidents(root)[0].note, '根因：目录清理');
    assert.ok(!LIB.setStatus(root, 'ri-nope', 'triaged').ok, '非法 id 应拒绝');
    assert.ok(!LIB.setStatus(root, 'ri-chain-1', 'bogus').ok, '非法状态应拒绝');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('openCount 只数 open；heat 按 digest 聚合计数降序', () => {
  const root = tmpRoot();
  try {
    const now = Date.now();
    LIB.appendIncident(root, rec({ id: 'a1', digest: 'hotdddddddddddd', ts: now }));
    LIB.appendIncident(root, rec({ id: 'a2', digest: 'hotdddddddddddd', ts: now + 10 }));
    LIB.appendIncident(root, rec({ id: 'a5', digest: 'hotdddddddddddd', ts: now + 5 }));
    LIB.appendIncident(root, rec({ id: 'a3', digest: 'coldcccccccccc', ts: now + 20 }));
    LIB.appendIncident(root, rec({ id: 'a4', digest: 'coldcccccccccc', ts: now + 30, kind: 'hook-failure' }));
    LIB.setStatus(root, 'a4', 'resolved');
    LIB.setStatus(root, 'a5', 'resolved');
    assert.equal(LIB.openCount(root), 3, 'resolved 不计入 open');
    const h = LIB.heat(root);
    assert.equal(h.length, 2, '按 digest 聚合为两组');
    assert.equal(h[0].digest, 'hotdddddddddddd', 'count=3 的 digest 排首');
    assert.equal(h[0].count, 3);
    assert.equal(h[1].count, 2, '热度含全量状态（resolved 也是历史热度）');
    // 30 天窗口外不计
    LIB.appendIncident(root, rec({ id: 'a6', digest: 'oldoooooooooooo', ts: now - 31 * 24 * 3600 * 1000 }));
    assert.equal(LIB.heat(root).length, 2, '窗口外记录不进热度');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 子进程：list/triage/resolve 流转与 --selftest', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-cli-1', digest: 'clidigest000000' }));
    const run = (args) =>
      spawnSync(process.execPath, [CLI, '--project-root', root, ...args], { encoding: 'utf8' });
    let r = run(['list']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('ri-cli-1'), `list 应含 id（收到：${r.stdout}）`);
    assert.ok(r.stdout.includes('open'));
    r = run(['triage', 'ri-cli-1', '--note', '待排查：疑似宿主缓存']);
    assert.equal(r.status, 0);
    r = run(['list', '--status', 'triaged']);
    assert.ok(r.stdout.includes('ri-cli-1'), 'triage 后按状态过滤可见');
    assert.ok(!r.stdout.includes('open'), 'open 行不应再出现');
    r = run(['list', '--heat']);
    assert.ok(r.stdout.includes('clidigest000000'.slice(0, 8)), `--heat 输出 digest 聚合（收到：${r.stdout}）`);
    r = run(['resolve', 'ri-cli-1', '--note', '已闭环']);
    assert.equal(r.status, 0);
    assert.equal(LIB.readIncidents(root)[0].status, 'resolved');
    r = run(['--selftest']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('OK'), `--selftest 应输出 OK（收到：${r.stdout}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('孤儿读原语已删（OPEN-47 收敛，DEV-44）：openCountExcludingKind/openSplitBySession 不再导出', () => {
  assert.equal(typeof LIB.openCountExcludingKind, 'undefined', 'openCountExcludingKind 应已删除');
  assert.equal(typeof LIB.openSplitBySession, 'undefined', 'openSplitBySession 应已删除');
});

test('countSummary：exit-nonzero 探针分层不计待排查（TASK-OSNOISE-1）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'tf-probe', session: 'sess-mine', errorClass: 'exit-nonzero' }));
    LIB.appendIncident(root, rec({ id: 'tf-real', session: 'sess-mine', errorClass: 'error-flag' }));
    LIB.appendIncident(root, rec({ id: 'ld-1', session: 'sess-other', kind: 'lease-deny' }));
    LIB.appendIncident(root, rec({ id: 'tf-mid', session: 'sess-other', errorClass: 'error-field' }));
    LIB.appendIncident(root, rec({ id: 'tf-other', session: 'sess-other', errorClass: 'stderr' }));
    LIB.setStatus(root, 'tf-mid', 'triaged', '自检：已处置');
    assert.equal(LIB.countSummary(root).pending, 2, '只计两条真待排查（error-flag 与 stderr）');
    // 内部决策-063 修正案 3 决策 24.1（内部任务-195）：pendingSplitBySession 无生产消费方已删除；
    // 归属拆分口径由 incident-summary.buildSummary（byTask/bySession/byOthers）承载并另有用例。
    assert.equal(LIB.openCount(root), 4, 'openCount 未分层语义不变（证据面；triaged 的一条不计）');
    // countSummary 库级直测（收尾复审正确性 #5）：两数必须同源同刻
    const summary = LIB.countSummary(root);
    assert.deepEqual({ open: summary.open, pending: summary.pending }, { open: 4, pending: 2 }, 'countSummary 直测：未分层 open 与分层待排查同源');
    // errorClass 层**只作用于 tool-failure**（评审正确性 #1）：别的 kind 带该字段不得被静默
    LIB.appendIncident(root, rec({ id: 'll-x', session: 'sess-mine', kind: 'lease-loop', errorClass: 'exit-nonzero' }));
    assert.equal(LIB.countSummary(root).pending, 3, 'lease-loop 即便带 exit-nonzero 仍计待排查（R-M15-3 强制显示不变量）');
    assert.equal(LIB.isPendingIncident(rec({ id: 'll-y', kind: 'lease-loop', errorClass: 'exit-nonzero', status: 'open' })), true);
    LIB.setStatus(root, 'll-x', 'resolved', '自检收尾');
    assert.equal(LIB.countSummary(root).pending, 2, '收尾后回到两条');
    // 缺失文件 ⇒ 计数 0 且不抛（fail-open 的"无档"路径）
    assert.equal(LIB.countSummary(join(root, 'no-such-sub')).pending, 0, '记录文件缺失 ⇒ 计数 0 且不抛');
    // 真实读失败路径（评审正确性 #4）：把 incidents.jsonl 造成**目录** ⇒ readFileSync 抛 EISDIR
    // ⇒ parseIncidentLines 的 catch 分支吃掉坏读，计数 0 且不抛。
    const broken = join(root, 'broken-sub');
    mkdirSync(join(broken, '.workflow', 'incidents.jsonl'), { recursive: true });
    assert.equal(LIB.countSummary(broken).pending, 0, '记录文件不可读（EISDIR）⇒ 计数 0 且不抛');
    assert.equal(LIB.openCount(broken), 0, '同路径 openCount 亦为 0');
    // 排除名单锁死（视角二 #2：新增 errorClass 必须显式判定是否分层，改名单即改此断言）；
    // 分开断言两个名单，不做拼接顺序耦合（评审实例一 #8）。
    assert.deepEqual([...LIB.PENDING_EXCLUDED_KINDS], ['lease-deny', 'lease-revive'], 'kind 层排除名单变化需同步判定（ADR-045/DEV-96：lease-revive 设计内恢复留痕不入待排查）');
    assert.deepEqual([...LIB.PENDING_EXCLUDED_ERROR_CLASSES], ['exit-nonzero'], 'errorClass 层排除名单变化需同步判定');
    assert.equal(LIB.PENDING_ERROR_CLASS_SCOPE_KIND, 'tool-failure', 'errorClass 轴作用域 kind 锁死（收尾复审 #4：提醒面文案与谓词同源）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveOpenByKind：按 kind 批量解决 open 记录（append-only，前向状态机不破）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ld-s1', kind: 'lease-deny', tool: 'Bash' }));
    LIB.appendIncident(root, rec({ id: 'ld-s2', kind: 'lease-deny', tool: 'Edit' }));
    LIB.appendIncident(root, rec({ id: 'tf-s1', kind: 'tool-failure' }));
    LIB.appendIncident(root, rec({ id: 'ld-s3', kind: 'lease-deny' }));
    LIB.setStatus(root, 'ld-s3', 'triaged', '人工已排查');
    const before = readFileSync(LIB.incidentFile(root), 'utf8').split('\n').filter((l) => l.trim()).length;
    const r = LIB.resolveOpenByKind(root, 'lease-deny', '自愈备注');
    assert.equal(r.resolved, 2, '只解决 open 的 lease-deny 两条');
    const after = readFileSync(LIB.incidentFile(root), 'utf8').split('\n').filter((l) => l.trim()).length;
    assert.equal(after, before + 2, 'append-only：追加状态行而非改写');
    const all = LIB.readIncidents(root);
    const byId = Object.fromEntries(all.map((x) => [x.id, x]));
    assert.equal(byId['ld-s1'].status, 'resolved');
    assert.equal(byId['ld-s1'].note, '自愈备注');
    assert.equal(byId['ld-s2'].status, 'resolved');
    assert.equal(byId['tf-s1'].status, 'open', '非 lease-deny 不动');
    assert.equal(byId['ld-s3'].status, 'triaged', 'triaged 不回退不动');
    // 幂等：再无 open lease-deny，二次调用 resolved=0
    assert.equal(LIB.resolveOpenByKind(root, 'lease-deny', '自愈备注').resolved, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-LEASEGATE-1（2026-09-22）：reopensWithin 行级读原语（lease-loop 升级判定数据源）──

test('reopensWithin：同 id 振荡行级计数（readIncidents 的 id 折叠不可用，TASK-LEASEGATE-1）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ld-osc', kind: 'lease-deny', digest: 'dgosc00000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-osc', 'resolved', '声明自愈');
    LIB.appendIncident(root, rec({ id: 'ld-osc', kind: 'lease-deny', digest: 'dgosc00000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-osc', 'resolved', '声明自愈');
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'dgosc00000000001', session: 'sess-x', windowMs: 600000 }),
      2,
      '两条 resolved 行均计入（行级，非折叠末条）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopensWithin：跨 id 同签名计数、窗外/异会话/异 digest/缺文件各态', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ld-o1', kind: 'lease-deny', digest: 'dgq0000000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-o1', 'resolved');
    LIB.appendIncident(root, rec({ id: 'ld-o2', kind: 'lease-deny', digest: 'dgq0000000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-o2', 'resolved');
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'dgq0000000000001', session: 'sess-x', windowMs: 600000 }),
      2,
      '跨 id（跨分钟桶）同签名仍计数',
    );
    LIB.appendIncident(root, rec({ id: 'ld-old', kind: 'lease-deny', digest: 'dgold000000000001', session: 'sess-x', ts: Date.now() - 999999 }));
    LIB.setStatus(root, 'ld-old', 'resolved');
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'dgold000000000001', session: 'sess-x', windowMs: 600000 }),
      0,
      '窗外不计',
    );
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'dgq0000000000001', session: 'sess-Y', windowMs: 600000 }),
      0,
      '异会话不计',
    );
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'other000000000001', session: 'sess-x', windowMs: 600000 }),
      0,
      '异 digest 不计',
    );
    const empty = tmpRoot();
    try {
      assert.equal(
        LIB.reopensWithin(empty, { kind: 'lease-deny', digest: 'any00000000000001', session: 'sess-x', windowMs: 600000 }),
        0,
        '缺文件零计数（无历史≠异常）',
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopensWithin：坏行容忍（振荡行间的坏 JSON 行不中断计数）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ld-b1', kind: 'lease-deny', digest: 'dgbad000000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-b1', 'resolved');
    LIB.appendIncident(root, rec({ id: 'ld-b2', kind: 'lease-deny', digest: 'dgbad000000000001', session: 'sess-x' }));
    LIB.setStatus(root, 'ld-b2', 'resolved');
    appendFileSync(LIB.incidentFile(root), '{{{ not-json\n'); // 坏行（目录已由 appendIncident 建好）
    assert.equal(
      LIB.reopensWithin(root, { kind: 'lease-deny', digest: 'dgbad000000000001', session: 'sess-x', windowMs: 600000 }),
      2,
      '坏行跳过不中断行级计数',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 可见化（OPEN-14 批次）：前缀回填成功；不存在/歧义/回退拒绝 stderr 可见退 1', async () => {
  const root = tmpRoot();
  const { resolveIncidentId } = await import('../../scripts/incident-cli.mjs');
  try {
    LIB.appendIncident(root, rec({ id: 'hf-abcdef1234567890-7', digest: 'vv00000000000001' }));
    LIB.appendIncident(root, rec({ id: 'hf-abcdef1234567890-8', digest: 'vv00000000000001' }));
    LIB.appendIncident(root, rec({ id: 'ld-1234567890abcdef', digest: 'vv00000000000002' }));
    const run = (args) =>
      spawnSync(process.execPath, [CLI, '--project-root', root, ...args], { encoding: 'utf8' });
    // 12 位截断前缀直接回填（list 显示口径）
    let r = run(['triage', 'ld-123456789', '--note', '前缀回填']);
    assert.equal(r.status, 0, `唯一前缀 triage 应成功（stderr：${r.stderr}）`);
    assert.ok(r.stdout.includes('triage 完成'));
    // 全等优先：完整 id 精确命中（不歧义于共享前缀的其它 id）
    r = run(['triage', 'hf-abcdef1234567890-7']);
    assert.equal(r.status, 0, '全等优先精确命中');
    // 不存在 → stderr + exit 1（不再静默）
    r = run(['triage', 'no-such-id']);
    assert.equal(r.status, 1, '不存在 id 须退 1');
    assert.ok(r.stderr.includes('未找到'), `stderr 含未找到指引（收到：${r.stderr}）`);
    // 歧义前缀（hf-abcdef1234567890 同时命中 -7 与 -8）→ stderr 列候选 + exit 1
    r = run(['triage', 'hf-abcdef1234567890']);
    assert.equal(r.status, 1, '歧义前缀须退 1');
    assert.ok(r.stderr.includes('hf-abcdef1234567890-7') && r.stderr.includes('hf-abcdef1234567890-8'), 'stderr 列出全部候选');
    // 状态回退拒绝的 reason 可见（resolved 再 triage）
    run(['resolve', 'ld-1234567890abcdef']);
    r = run(['triage', 'ld-1234567890abcdef']);
    assert.equal(r.status, 1, '回退拒绝须退 1');
    assert.ok(r.stderr.includes('回退'), `stderr 含 reason（收到：${r.stderr}）`);
    // 未知子命令可见退 1
    r = run(['bogus-command']);
    assert.equal(r.status, 1, '未知子命令须退 1');
    assert.ok(r.stderr.length > 0, '未知子命令 stderr 可见');
    // 纯函数三态
    const records = LIB.readIncidents(root);
    assert.equal(resolveIncidentId(records, 'ld-1234567890abcdef').id, 'ld-1234567890abcdef', '全等');
    assert.equal(resolveIncidentId(records, 'ld-1234').id, 'ld-1234567890abcdef', '唯一前缀（≥4 字符）');
    assert.ok(!resolveIncidentId(records, 'ld-').ok, '过短前缀拒绝');
    assert.equal(resolveIncidentId(records, 'hf-abcdef1234567890').candidates.length, 2, '歧义列候选');
    assert.ok(!resolveIncidentId(records, 'zzzz').ok, '无匹配');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-DEBTFIX-1：同状态更正通道 / 归属列 / 拆分原语 ──

test('setStatus 更正通道：同状态 + 不同 note 追加更正快照（TASK-DEBTFIX-1）', () => {
  const home = tmpRoot();
  try {
    LIB.appendIncident(home, rec({ id: 'ri-am-1' }));
    LIB.setStatus(home, 'ri-am-1', 'resolved', '第一次结论');
    const before = readFileSync(LIB.incidentFile(home), 'utf8').trim().split('\n').length;
    const r = LIB.setStatus(home, 'ri-am-1', 'resolved', '更正后的结论');
    const rows = readFileSync(LIB.incidentFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(r.ok, true);
    assert.equal(rows.length, before + 1, '新 note ⇒ 追加一行');
    assert.equal(rows[rows.length - 1].note, '更正后的结论', '折叠末条为更正 note');
    assert.equal(rows[rows.length - 1].amended, true, '更正行带 amended 标记（与升级通道隔离，R9）');
    assert.equal(rows[rows.length - 1].ts, rows[0].ts, 'ts 保持原值（热度/窗口口径不动）');
    assert.equal(rows[rows.length - 1].status, 'resolved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('setStatus 幂等：同 note / 无 note 零新增（TASK-DEBTFIX-1 防回归）', () => {
  const home = tmpRoot();
  try {
    LIB.appendIncident(home, rec({ id: 'ri-am-2' }));
    LIB.setStatus(home, 'ri-am-2', 'resolved', '结论 A');
    const n1 = readFileSync(LIB.incidentFile(home), 'utf8').trim().split('\n').length;
    LIB.setStatus(home, 'ri-am-2', 'resolved', '结论 A');
    LIB.setStatus(home, 'ri-am-2', 'resolved');
    const n2 = readFileSync(LIB.incidentFile(home), 'utf8').trim().split('\n').length;
    assert.equal(n2, n1, '同 note 与无 note 均零新增');
    assert.equal(LIB.openCount(home), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('更正行不计入 reopensWithin（lease-loop 升级通道隔离，TASK-DEBTFIX-1 R9）', () => {
  const home = tmpRoot();
  try {
    const q = { kind: 'lease-deny', digest: 'ld-am-0000000001', session: 'sess-x', windowMs: 600000, now: Date.now() };
    LIB.appendIncident(home, rec({ id: 'ri-ld-am', kind: 'lease-deny', digest: q.digest }));
    LIB.setStatus(home, 'ri-ld-am', 'resolved', '自愈结论');
    assert.equal(LIB.reopensWithin(home, q), 1, '真实迁移行计入');
    LIB.setStatus(home, 'ri-ld-am', 'resolved', '更正后的结论');
    LIB.setStatus(home, 'ri-ld-am', 'resolved', '再更正一次');
    assert.equal(LIB.reopensWithin(home, q), 1, '更正行不推高计数（防误升级）');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('状态迁移不继承 amended 标记（TASK-DEBTFIX-1 收尾评审 #4）', () => {
  const home = tmpRoot();
  try {
    const q = { kind: 'lease-deny', digest: 'ld-am-0000000002', session: 'sess-x', windowMs: 600000, now: Date.now() };
    // 账本被手改过的存量行：open + 陈旧 amended 标记
    LIB.appendIncident(home, rec({ id: 'ri-ld-am2', kind: 'lease-deny', digest: q.digest, amended: true }));
    LIB.setStatus(home, 'ri-ld-am2', 'resolved', '自愈结论');
    const last = JSON.parse(readFileSync(LIB.incidentFile(home), 'utf8').trim().split('\n').pop());
    assert.equal(last.amended, undefined, '迁移行不带 amended（不继承陈旧标记）');
    assert.equal(LIB.reopensWithin(home, q), 1, '真实迁移行照常计入振荡');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('renderList 归属列：session 短标识 + taskId（TASK-DEBTFIX-1）', () => {
  const home = tmpRoot();
  try {
    LIB.appendIncident(home, rec({
      id: 'ri-own-1',
      session: 'session-78a08d5a-9d53-4eb9-ad1f-1b8c13621d9f',
      taskId: 'TASK-1',
    }));
    const out = spawnSync(process.execPath, [CLI, 'list'], { encoding: 'utf8', env: { ...process.env, WF_INCIDENT_ROOT: home } });
    assert.equal(out.status, 0);
    assert.ok(out.stdout.includes('78a08d5a/TASK-1'), '归属列含会话短标识与 taskId（剥 session- 前缀）');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 内部任务-244 S07：list 人读渲染剥控制字符＋未知 kind 归一（防终端/模型输出注入） ──

test('DEV-244 S07：list 渲染剥控制字符且未知 kind 归一 unknown', () => {
  const home = tmpRoot();
  try {
    const file = join(home, '.workflow', 'incidents.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: 'ri-s07',
        ts: Date.now(),
        session: 'session-s07',
        kind: 'tool\u001b[31m-failure',
        digest: 'dgs0700000000001',
        status: 'open',
        note: 'note\u001b]0;pwn\u0007 tail',
      }) + '\n',
    );
    const out = spawnSync(process.execPath, [CLI, 'list'], { encoding: 'utf8', env: { ...process.env, WF_INCIDENT_ROOT: home } });
    assert.equal(out.status, 0, `list 退 0（实际 ${out.status}：${out.stderr}）`);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out.stdout), 'stdout 无 C0/C1 控制字符');
    assert.ok(out.stdout.includes('unknown'), '未知 kind 归一为 unknown');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 内部任务-244 遗留项③：list --heat 与 digest 人读渲染同样过 sanitizeDisplayText ──

test('DEV-244 遗留：list --heat 与 digest 渲染剥控制字符（heat digest/cause/kind 键）', () => {
  const home = tmpRoot();
  try {
    const file = join(home, '.workflow', 'incidents.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const ts = Date.now();
    const esc = '\u001b[31m';
    const records = [
      { schemaVersion: 1, id: 'ri-h1', ts, session: 'session-h', kind: 'tool-failure', digest: `dgs${esc}0001`, status: 'open', cause: `ca${esc}use` },
      { schemaVersion: 1, id: 'ri-h2', ts, session: 'session-h', kind: 'tool-failure', digest: `dgs${esc}0001`, status: 'resolved', cause: `ca${esc}use` },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const env = { ...process.env, WF_INCIDENT_ROOT: home };
    const heatOut = spawnSync(process.execPath, [CLI, 'list', '--heat'], { encoding: 'utf8', env });
    assert.equal(heatOut.status, 0, `list --heat 退 0（实际 ${heatOut.status}：${heatOut.stderr}）`);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(heatOut.stdout), '--heat stdout 无 C0/C1 控制字符');
    const digOut = spawnSync(process.execPath, [CLI, 'digest'], { encoding: 'utf8', env });
    assert.equal(digOut.status, 0, `digest 退 0（实际 ${digOut.status}：${digOut.stderr}）`);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(digOut.stdout), 'digest stdout 无 C0/C1 控制字符');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI --help：退 0 且用法含全部子命令（DEV-20 A1/F8）', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `--help 必须退 0（实际 ${r.status}：${r.stderr}）`);
  for (const token of ['list', 'triage', 'resolve', 'lease', '--selftest', '--json']) {
    assert.ok(r.stdout.includes(token), `用法须含 ${token}；实际：${r.stdout}`);
  }
  const h = spawnSync(process.execPath, [CLI, '-h'], { encoding: 'utf8' });
  assert.equal(h.status, 0, '-h 同 --help');
});

test('CLI list --json：机器可读投影（DEV-20 A1/F8，IF-COLLAB-19 §2）', () => {
  const root = tmpRoot();
  try {
    // heat() 有 30 天窗口且按 digest 聚合（incident-store 的 heat 语义，评审 C2）⇒ 夹具须给
    // **近期时戳**与**不同 digest**，否则 heat 行数为 0/1，断言与 store 语义冲突。
    const now = Date.now();
    LIB.appendIncident(root, rec({ id: 'ri-json-1', ts: now, digest: 'aaaa1111aaaa1111' }));
    LIB.appendIncident(root, rec({ id: 'ri-json-2', ts: now + 1, status: 'resolved', digest: 'bbbb2222bbbb2222' }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'list', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `list --json 读侧退 0（实际 ${r.status}：${r.stderr}）`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.schemaVersion, 1, '信封带 schemaVersion（机器契约可判版本）');
    assert.equal(out.ledger.status, 'ok', 'ledger 三态：可读');
    assert.equal(out.counts.open, 1, '未分层 open 计数与 records **同源**（单次读盘投影，CEO PD1-c）');
    assert.equal(out.records.length, 2);
    assert.deepEqual(
      Object.keys(out).sort(),
      ['counts', 'countsByCause', 'filter', 'ledger', 'projectRoot', 'records', 'rulesVersion', 'schemaVersion'],
      '键集即契约面：增删键必须同批改 IF-COLLAB-19 与用例（v2 加法：rulesVersion/countsByCause）',
    );
    const heat = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', root, 'list', '--heat', '--json'], { encoding: 'utf8' }).stdout);
    assert.ok(Array.isArray(heat.heat) && heat.heat.length === 2, '--heat --json 出两行 heat 聚合（两条不同 digest + 近期时戳）');
    assert.equal(heat.filter.heat, true, 'filter.heat 如实回显（契约二态：--heat ⇒ 只有 heat，无 records）');
    assert.ok(!Object.hasOwn(heat, 'records'), 'heat 形态不并列 records（与 renderList 同语义）');
    const filtered = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', root, 'list', '--status', 'resolved', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(filtered.records.length, 1, '--status 过滤在 --json 面同样生效');
    assert.equal(filtered.filter.status, 'resolved', 'filter 字段如实回显请求的过滤条件');
    assert.equal(filtered.counts.open, 1, 'counts 为项目全域口径（不受 --status 过滤影响，与 countSummary 同义）');
    const missing = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', join(root, 'nope'), 'list', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(missing.ledger.status, 'missing', '缺账本文件如实标注 status=missing 而非静默空（三态判据独立于 records）');
    assert.deepEqual(missing.records, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI list --json：ledger.status=unreadable（存在但不可读，A-M15-1 声明的该臂）', () => {
  const root = tmpRoot();
  try {
    // 账本路径造成**目录**（EISDIR 形态）：存在但不是常规文件 ⇒ unreadable，绝不伪装零记录
    mkdirSync(join(root, '.workflow', 'incidents.jsonl'), { recursive: true });
    const out = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', root, 'list', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(out.ledger.status, 'unreadable', '存在但非可读常规文件 ⇒ unreadable（不得报 missing 或伪装零记录）');
    assert.deepEqual(out.records, [], '读不到 ⇒ 空 records，消费方凭 status 判定');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI 写侧不受 -h 干扰：--note -h 不吞成用法（DEV-20 A1 评审①2）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-note-h', ts: Date.now() }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'triage', 'ri-note-h', '--note', '-h'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('用法：node incident-cli.mjs'), '-h 作为 note 值不得触发用法输出（否则"变更未发生却报成功"）');
    assert.ok(r.stdout.includes('triage 完成'), 'triage 照常完成');
    assert.ok(LIB.readIncidents(root)[0].note === '-h', 'note 值原样落账（-h 是数据不是旗标）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-20 B 批（F9）：session 形态归一 + host 维度 ──

test('DEV-20 B/F9：normalizeSession 形态归一、归属不可判与幂等', () => {
  const n = LIB.normalizeSession;
  assert.equal(typeof n, 'function', '须导出 normalizeSession（归一单点）');
  assert.equal(n('session-abc'), n('abc'), 'session- 前缀形态归一为同值');
  assert.equal(n('sess_abc'), n('abc'), 'sess_ 前缀形态归一');
  assert.equal(n('mvs_abc'), n('abc'), 'mvs_ 前缀形态归一');
  assert.equal(n('  abc  '), n('abc'), '去首尾空白');
  assert.equal(n('default'), null, 'default ⇒ 归属不可判（既有口径）');
  assert.equal(n(''), null, '空串 ⇒ 归属不可判');
  assert.equal(n(n('sess_abc')), n('sess_abc'), '幂等：n(n(x))===n(x)（防二次剥前缀漂移）');
});

test('OPEN-110：同参数随即成功自愈——仅收口本会话窗内 open 态 tool-failure（DEV-52）', () => {
  const root = tmpRoot();
  const now = Date.now();
  const win = 5 * 60 * 1000;
  try {
    // 目标：sess-a、Bash、idg-1、窗内、open——唯一应被收口
    LIB.appendIncident(root, rec({ id: 'tf-h1', ts: now - 60_000, session: 'sess-a', kind: 'tool-failure', tool: 'Bash', inputDigest: 'idg-1' }));
    // 对照五条：他会话同参 / 窗外 / 已 triaged / 无 inputDigest 旧记录 / retry-loop 同参
    LIB.appendIncident(root, rec({ id: 'tf-h2', ts: now - 60_000, session: 'sess-b', kind: 'tool-failure', tool: 'Bash', inputDigest: 'idg-1' }));
    LIB.appendIncident(root, rec({ id: 'tf-h3', ts: now - win - 60_000, session: 'sess-a', kind: 'tool-failure', tool: 'Bash', inputDigest: 'idg-1' }));
    LIB.appendIncident(root, rec({ id: 'tf-h4', ts: now - 60_000, session: 'sess-a', kind: 'tool-failure', tool: 'Bash', inputDigest: 'idg-1', status: 'triaged' }));
    LIB.appendIncident(root, rec({ id: 'tf-h5', ts: now - 60_000, session: 'sess-a', kind: 'tool-failure', tool: 'Bash' }));
    LIB.appendIncident(root, rec({ id: 'rl-h1', ts: now - 60_000, session: 'sess-a', kind: 'retry-loop', tool: 'Bash', digest: 'idg-1' }));
    const r = LIB.resolveOpenToolFailuresByRetry(root, { session: 'sess-a', host: null, tool: 'Bash', inputDigest: 'idg-1', windowMs: win, now });
    assert.equal(r.resolved, 1, '恰收口目标一条');
    const byId = new Map(LIB.readIncidents(root).map((x) => [x.id, x]));
    assert.equal(byId.get('tf-h1').status, 'resolved');
    assert.equal(byId.get('tf-h1').note, '同参数随即成功自愈（OPEN-110）');
    assert.equal(byId.get('tf-h2').status, 'open', '他会话不代结');
    assert.equal(byId.get('tf-h3').status, 'open', '窗外不收口');
    assert.equal(byId.get('tf-h4').status, 'triaged', '已 triaged 不被机器改判');
    assert.equal(byId.get('tf-h5').status, 'open', '无 inputDigest 旧记录不匹配');
    assert.equal(byId.get('rl-h1').status, 'open', 'retry-loop 升级通道不入自愈面');
    // 会话不可判（default 桶）恒不代结
    LIB.appendIncident(root, rec({ id: 'tf-h6', ts: now - 30_000, session: 'default', kind: 'tool-failure', tool: 'Bash', inputDigest: 'idg-1' }));
    const r2 = LIB.resolveOpenToolFailuresByRetry(root, { session: 'default', host: null, tool: 'Bash', inputDigest: 'idg-1', windowMs: win, now });
    assert.equal(r2.resolved, 0, 'default 桶归属不可判，自愈须零收口');
    assert.equal(new Map(LIB.readIncidents(root).map((x) => [x.id, x])).get('tf-h6').status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-79 archiveAgedIncidents（内部决策-041）：证据类记录终态老化 ──

test('archiveAgedIncidents：三条件全命中恰迁移一条', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    // 目标：open + exit-nonzero（排除面）+ 超龄 31 天
    LIB.appendIncident(root, rec({ id: 'ri-arch-1', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-arch-1' }));
    // 负例 A：非排除类（error-flag）不误伤
    LIB.appendIncident(root, rec({ id: 'ri-arch-2', kind: 'tool-failure', tool: 'Bash', errorClass: 'error-flag', ts: now - 31 * 86400000, digest: 'dg-arch-2' }));
    // 负例 B：未超龄（29 天）不动
    LIB.appendIncident(root, rec({ id: 'ri-arch-3', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 29 * 86400000, digest: 'dg-arch-3' }));
    // 负例 C：非 open（已 resolved 的超龄排除类）不被再迁移——谓词须显式三条件
    LIB.appendIncident(root, rec({ id: 'ri-arch-6', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-arch-6', status: 'resolved' }));
    const r = LIB.archiveAgedIncidents(root, { now });
    assert.equal(r.archived, 1, '恰迁移一条');
    const byDigest = new Map(LIB.readIncidents(root).map((x) => [x.digest, x]));
    assert.equal(byDigest.get('dg-arch-1').status, 'archived', '目标转 archived');
    assert.equal(byDigest.get('dg-arch-1').note.includes('ADR-041'), true, '迁移 note 带自动收口标记');
    assert.equal(byDigest.get('dg-arch-2').status, 'open', 'error-flag 不误伤');
    assert.equal(byDigest.get('dg-arch-3').status, 'open', '未超龄不动');
    assert.equal(byDigest.get('dg-arch-6').status, 'resolved', '非 open 记录不被再迁移');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveAgedIncidents：幂等（二次运行零新增）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-arch-4', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-arch-4' }));
    assert.equal(LIB.archiveAgedIncidents(root, { now }).archived, 1);
    const before = LIB.readIncidents(root).length;
    assert.equal(LIB.archiveAgedIncidents(root, { now }).archived, 0, '二次零迁移');
    assert.equal(LIB.readIncidents(root).length, before, '二次零新增行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveAgedIncidents：单次上限截断', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    for (let i = 0; i < 5; i++) {
      LIB.appendIncident(root, rec({ id: `ri-arch-l${i}`, kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: `dg-arch-l${i}` }));
    }
    assert.equal(LIB.archiveAgedIncidents(root, { now, limit: 3 }).archived, 3, '截断到 limit');
    assert.equal(LIB.readIncidents(root).filter((r) => r.status === 'archived').length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveAgedIncidents：缺文件空态零计数不抛', () => {
  const base = tmpRoot();
  try {
    const root = join(base, 'not-exist');
    assert.deepEqual(LIB.archiveAgedIncidents(root, { now: Date.now() }), { archived: 0, failed: 0 });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('archiveAgedIncidents：缺省上限 500 截断（阶段门①：钉死真实缺省值）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    for (let i = 0; i < 502; i++) {
      LIB.appendIncident(root, rec({ id: `ri-arch-cap${i}`, kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: `dg-arch-cap${i}` }));
    }
    assert.equal(LIB.archiveAgedIncidents(root, { now }).archived, 500, '缺省单次恰迁 500');
    assert.equal(LIB.readIncidents(root).filter((r) => r.status === 'archived').length, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveAgedIncidents：retry-loop 升级通道不受影响（A-M15-1 负例）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    // open 态 retry-loop 不被归档命中（升级信号不入自愈/归档面）
    LIB.appendIncident(root, rec({ id: 'ri-arch-rl', kind: 'retry-loop', tool: 'Bash', ts: now - 31 * 86400000, digest: 'dg-arch-rl' }));
    // 超龄排除类归档后，reopensWithin 对该 (kind,digest) 计数不受毒化（只数 resolved 行）
    LIB.appendIncident(root, rec({ id: 'ri-arch-rf', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-arch-rf' }));
    const r = LIB.archiveAgedIncidents(root, { now });
    assert.equal(r.archived, 1, '恰迁排除类一条');
    const byId = new Map(LIB.readIncidents(root).map((x) => [x.id, x]));
    assert.equal(byId.get('ri-arch-rl').status, 'open', 'open 态 retry-loop 不被归档');
    assert.equal(LIB.reopensWithin(root, { kind: 'tool-failure', digest: 'dg-arch-rf', session: 'sess-x', windowMs: 60000, now }), 0, 'archived 行不计入 reopensWithin（升级计数不毒化）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('STATUSES 名单扩四态（open→archived 放行、archived→open 拒绝）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-arch-5', digest: 'dg-arch-5' }));
    assert.equal(LIB.setStatus(root, 'ri-arch-5', 'archived', 't').ok, true, 'open→archived 放行');
    assert.equal(LIB.setStatus(root, 'ri-arch-5', 'open', 't').ok, false, 'archived→open 拒绝（终态不回退）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-79 CLI archive 子命令（内部决策-041）──

test('cli archive：dry-run 零写盘（阶段门①：须真实行使零写盘性质）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-cli-d1', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-cli-d1' }));
    const before = LIB.readIncidents(root).length;
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive', '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'dry-run 退 0');
    assert.ok(r.stdout.includes('可迁移 1 条'), '目标被预览');
    assert.ok(r.stdout.includes('ri-cli-d1'), '预览列 id');
    assert.equal(LIB.readIncidents(root).length, before, '零新增行');
    assert.equal(LIB.readIncidents(root)[0].status, 'open', 'dry-run 后仍 open（未写盘）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli archive：默认执行迁移并打印清单', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-cli-a1', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-cli-a1' }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('迁移 1 条'), '迁移清单');
    assert.equal(LIB.readIncidents(root)[0].status, 'archived', '实迁');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli archive：--max-age-days 覆盖', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-cli-a2', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 10 * 86400000, digest: 'dg-cli-a2' }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive', '--max-age-days', '5'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('迁移 1 条'), '5 天阈值下 10 天记录被迁');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli archive：非法 --max-age-days 退 1（评审阻塞项红测）', () => {
  const root = tmpRoot();
  try {
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive', '--max-age-days', 'abc'], { encoding: 'utf8' });
    assert.equal(r.status, 1, '非法参数退 1');
    assert.ok(r.stderr.includes('--max-age-days'), '报错指明参数名');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-79 终评处置：写侧失败可见（账本不可读／只读账本写失败）──

test('cli archive：账本不可读（目录形态）退 1', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    mkdirSync(join(root, '.workflow', 'incidents.jsonl')); // 文件位置放目录 → unreadable
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive'], { encoding: 'utf8' });
    assert.equal(r.status, 1, '不可读退 1');
    assert.ok(r.stderr.includes('账本不可读'), '报错指明不可读');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli archive：写失败可见退 1（只读账本 EPERM）', (t) => {
  // POSIX root 持 CAP_DAC_OVERRIDE，chmod 0444 不阻追加写＝环境不可能触发写失败：跳过（非行为缺失；Windows 只读属性与非 root POSIX 照常覆盖该路径）
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 环境 chmod 不产生 EPERM，写失败面无法取证');
  }
  const root = tmpRoot();
  const now = Date.now();
  let locked = false;
  try {
    LIB.appendIncident(root, rec({ id: 'ri-cli-ro', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-cli-ro' }));
    const file = LIB.incidentFile(root);
    chmodSync(file, 0o444); // Windows 上映射只读属性，追加写 EPERM（本机实测；非 root POSIX 同理）
    locked = true;
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'archive'], { encoding: 'utf8' });
    assert.equal(r.status, 1, '写失败退 1');
    assert.ok(r.stderr.includes('未迁移'), '报错指明命中未迁移');
  } finally {
    if (locked) chmodSync(LIB.incidentFile(root), 0o666);
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli 批量谓词：账本不可读退 1', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    mkdirSync(join(root, '.workflow', 'incidents.jsonl'));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'resolve', '--matching-excluded', '--older-than', '30d', '--note', 'x'], { encoding: 'utf8' });
    assert.equal(r.status, 1, '批量谓词不可读退 1');
    assert.ok(r.stderr.includes('账本不可读'), '报错指明不可读');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-79 triage/resolve 批量谓词（内部决策-041）──

test('cli 批量谓词：--matching-excluded 迁超龄排除类', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-bulk-1', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 31 * 86400000, digest: 'dg-bulk-1' }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'resolve', '--matching-excluded', '--older-than', '30d', '--note', '批量收口'], { encoding: 'utf8' });
    assert.equal(r.status, 0, '批量 resolve 退 0');
    assert.ok(r.stdout.includes('批量完成'), '批量清单文案');
    assert.equal(LIB.readIncidents(root)[0].status, 'resolved', '目标被迁');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli 批量谓词：缺 --note 退 1', () => {
  const root = tmpRoot();
  try {
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'resolve', '--matching-excluded', '--older-than', '30d'], { encoding: 'utf8' });
    assert.equal(r.status, 1, '缺 note 退 1');
    assert.ok(r.stderr.includes('--note'), '报错指明 --note');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli 批量谓词：不误伤未超龄和非排除类', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'ri-bulk-2', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', ts: now - 29 * 86400000, digest: 'dg-bulk-2' }));
    LIB.appendIncident(root, rec({ id: 'ri-bulk-3', kind: 'tool-failure', tool: 'Bash', errorClass: 'error-flag', ts: now - 31 * 86400000, digest: 'dg-bulk-3' }));
    const r = spawnSync(process.execPath, [CLI, '--project-root', root, 'triage', '--matching-excluded', '--older-than', '30d', '--note', '批量分诊'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('批量完成：0 条'), '零命中如实报');
    const byDigest = new Map(LIB.readIncidents(root).map((x) => [x.digest, x]));
    assert.equal(byDigest.get('dg-bulk-2').status, 'open');
    assert.equal(byDigest.get('dg-bulk-3').status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：cause 派生、统一处置作用域、旧账本零迁移。
// 锚：内部验收-23「统一处置原语：机器只动 open」、内部验收-28「内部模块-15 v2 旧账本零迁移兼容」。
// ─────────────────────────────────────────────────────────────────────────────

test('统一处置原语：机器只动 open', () => {
  const root = tmpRoot();
  const now = Date.now();
  const DAY = 86400000;
  const ledger = () => join(root, '.workflow', 'incidents.jsonl');
  try {
    LIB.appendIncident(root, rec({ id: 'ri-v2-retry-open', kind: 'tool-failure', tool: 'Bash', session: 'sA', host: 'dsh', inputDigest: 'in1', cause: 'real-failure', ts: now }));
    LIB.appendIncident(root, rec({ id: 'ri-v2-retry-triaged', kind: 'tool-failure', tool: 'Bash', session: 'sA', host: 'dsh', inputDigest: 'in1', status: 'triaged', cause: 'real-failure', ts: now }));
    LIB.appendIncident(root, rec({ id: 'ri-v2-retry-other', kind: 'tool-failure', tool: 'Edit', session: 'sA', host: 'dsh', inputDigest: 'in1', cause: 'real-failure', ts: now }));
    LIB.appendIncident(root, rec({ id: 'ri-v2-lease', kind: 'lease-deny', tool: 'Bash', cause: 'mechanism-trace', ts: now }));
    LIB.appendIncident(root, rec({ id: 'ri-v2-aged', kind: 'tool-failure', tool: 'Bash', cause: 'probe-noise', errorClass: 'exit-nonzero', ts: now - 40 * DAY }));
    LIB.appendIncident(root, rec({ id: 'ri-v2-loop', kind: 'lease-loop', cause: 'mechanism-escalation', ts: now }));

    const retryOpts = { sources: ['retry-heal'], retry: { session: 'sA', host: 'dsh', tool: 'Bash', inputDigest: 'in1', windowMs: 300000, cause: 'real-failure' }, now };
    const r1 = LIB.applyDispositions(root, retryOpts);
    assert.equal(r1.retryHealed, 1, 'retry-heal 恰解 1 条 open');
    assert.equal(r1.archived, 0, '热路径不得归档');
    assert.equal(r1.leaseHealed, 0, '热路径不得解 lease 族');
    const after1 = new Map(LIB.readIncidents(root).map((x) => [x.id, x]));
    assert.equal(after1.get('ri-v2-retry-open').status, 'resolved');
    assert.equal(after1.get('ri-v2-retry-open').autoDisposition, 'retry-heal');
    assert.equal(after1.get('ri-v2-retry-open').ruleId, 'machine-retry-heal');
    assert.equal(after1.get('ri-v2-retry-open').cause, 'real-failure', '记录自带 cause 优先，不被审计字段覆盖');
    assert.equal(after1.get('ri-v2-retry-triaged').status, 'triaged', 'triaged 不被机器改判');
    assert.equal(after1.get('ri-v2-retry-other').status, 'open');
    assert.equal(after1.get('ri-v2-lease').status, 'open');
    assert.equal(after1.get('ri-v2-aged').status, 'open');

    const beforeZero = readFileSync(ledger(), 'utf8');
    const r2 = LIB.applyDispositions(root, retryOpts);
    assert.equal(r2.retryHealed, 0);
    assert.equal(readFileSync(ledger(), 'utf8'), beforeZero, '无命中不追加任何行');

    const r3 = LIB.applyDispositions(root, { sources: ['lease-heal'], lease: { kind: 'lease-deny', note: '声明自愈' }, now });
    assert.equal(r3.leaseHealed, 1);
    const after3 = new Map(LIB.readIncidents(root).map((x) => [x.id, x]));
    assert.equal(after3.get('ri-v2-lease').status, 'resolved');
    assert.equal(after3.get('ri-v2-loop').status, 'open', 'lease-loop 不自愈');

    const dryCount = LIB.readIncidents(root).filter((x) => LIB.isAgedExcludedEvidence(x, now, 30 * DAY)).length;
    const r4 = LIB.applyDispositions(root, { sources: ['aged-archive'], now, maxAgeDays: 30 });
    assert.equal(r4.archived, dryCount, 'dry-run 谓词与实归档同源同数');
    assert.equal(dryCount, 1, '仅证据类超龄 1 条可归档');
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'ri-v2-aged').status, 'archived');

    assert.equal(LIB.applyDispositions(root, { sources: ['bogus'] }).failed, 1);
    assert.equal(LIB.applyDispositions(root, { sources: ['retry-heal'] }).failed, 1);
    assert.equal(LIB.applyDispositions(root, { sources: ['lease-heal'] }).failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M15 v2 旧账本零迁移兼容', () => {
  const root = tmpRoot();
  const now = Date.now();
  const file = join(root, '.workflow', 'incidents.jsonl');
  try {
    mkdirSync(dirname(file), { recursive: true });
    const legacy = [
      { schemaVersion: 1, id: 'lg-1', ts: now - 1000, session: 's1', kind: 'tool-failure', tool: 'Bash', errorClass: 'exit-nonzero', exitCode: 2, digest: 'd-lg1', status: 'open' },
      { schemaVersion: 1, id: 'lg-2', ts: now - 1000, session: 's1', kind: 'lease-deny', tool: 'Bash', digest: 'd-lg2', status: 'open' },
      { schemaVersion: 1, id: 'lg-3', ts: now - 1000, session: 's1', kind: 'tool-failure', tool: 'Bash', errorClass: 'error-flag', errorCode: 'FS_NOT_FOUND', digest: 'd-lg3', status: 'open' },
      { schemaVersion: 1, id: 'lg-4', ts: now - 1000, session: 's1', kind: 'user-correction', digest: 'd-lg4', status: 'open' },
    ];
    writeFileSync(file, legacy.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const before = readFileSync(file, 'utf8');
    LIB.appendIncident(root, rec({ id: 'nv-probe', kind: 'tool-failure', tool: 'Bash', errorClass: 'exit-nonzero', cause: 'probe-noise', ts: now - 500 }));
    LIB.appendIncident(root, rec({ id: 'nv-replay', kind: 'tool-failure', tool: 'Bash', errorClass: 'error-flag', errorCode: 'FS_NOT_FOUND', cause: 'replayable-rejection', ts: now - 500 }));
    LIB.appendIncident(root, rec({ id: 'nv-real', kind: 'tool-failure', tool: 'Bash', errorClass: 'error-flag', cause: 'real-failure', ts: now - 500 }));

    const rows = LIB.readIncidents(root);
    assert.equal(rows.length, 7, '旧新记录同读全量');
    const lg1 = rows.find((x) => x.id === 'lg-1');
    assert.equal(lg1.schemaVersion, 1);
    assert.equal(lg1.cause, undefined, '旧行不被迁移补 cause');
    assert.equal(lg1.errorClass, 'exit-nonzero');
    assert.ok(readFileSync(file, 'utf8').startsWith(before), '读侧零改写：旧行前缀逐字保留');

    const s = LIB.countSummary(root);
    assert.equal(s.pending, 3, 'pending=旧 error-flag+旧 user-correction+新 real');
    assert.equal(s.open, 7, 'open 旧键语义不变');
    assert.ok(s.countsByCause.unclassified >= 4, '缺 cause 旧行归 unclassified 计数');
    // 评审修复 N8：cause 键是闭集值 `replayable-rejection`（此前写 `.replayable` 恒 undefined，
    // 断言永远成立＝假断言）
    assert.equal(s.countsByCause['replayable-rejection'], 1, 'replayable-rejection 计数可断言（非 undefined 假绿）');
    const byId = new Map(rows.map((x) => [x.id, x]));
    assert.equal(LIB.isPendingIncidentV2(byId.get('lg-1')), false);
    assert.equal(LIB.isPendingIncidentV2(byId.get('lg-2')), false);
    assert.equal(LIB.isPendingIncidentV2(byId.get('lg-3')), true);
    assert.equal(LIB.isPendingIncidentV2(byId.get('lg-4')), true);
    assert.equal(LIB.isPendingIncidentV2(byId.get('nv-probe')), false);
    assert.equal(LIB.isPendingIncidentV2(byId.get('nv-replay')), false);
    assert.equal(LIB.isPendingIncidentV2(byId.get('nv-real')), true);
    assert.equal(LIB.isPendingIncidentV2({ ...byId.get('nv-real'), status: 'resolved' }), false);
    assert.equal(LIB.isPendingIncidentV2(null), false);
    assert.deepEqual(LIB.countsByCause(root), LIB.countSummary(root).countsByCause);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2 CLI 表面（2026-10-24 内部任务-192/内部决策-063）：emit/promote/digest 与 list --json 加法键。
// 锚：内部验收-25「内部模块-15 v2 CLI emit/promote/digest」。
// ─────────────────────────────────────────────────────────────────────────────

/** 运行 CLI 子进程（input 供 emit 的 stdin 载荷）。 */
const runCli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...(input === undefined ? {} : { input }) });

/** 一条合法 emit 载荷（内部接口-26 §2 白名单内键）。 */
const emitPayload = (over = {}) => ({
  schemaVersion: 1,
  kind: 'hook-failure',
  observationSource: 'adapter:dsh',
  ts: Date.now(),
  id: 'em-1',
  plugin: 'spec-gate',
  event: 'SessionStart',
  ...over,
});

test('M15 v2 CLI emit/promote/digest（锚：A-M15-25）', () => {
  const root = tmpRoot();
  try {
    // ── emit ──
    let r = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload()));
    assert.equal(r.status, 0, `合法载荷须退 0（stderr=${r.stderr}）`);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, id: 'em-1' });
    const emitted = LIB.readIncidents(root).find((x) => x.id === 'em-1');
    assert.ok(emitted, '记录落账');
    assert.equal(emitted.cause, 'real-failure', 'emit 记录走规则表分类（hook-failure ⇒ real-failure）');
    assert.equal(emitted.severity, 'action');
    assert.equal(emitted.status, 'open', 'emit 记录起步 open');
    assert.equal(emitted.observationSource, 'adapter:dsh', '观测来源落账（可区分适配层来源）');
    assert.equal(emitted.rulesVersion, 1, '规则表版本落账');
    // 夹带原文类键（白名单外）→ 整单拒绝、不落半条
    const file = LIB.incidentFile(root);
    const before = readFileSync(file, 'utf8');
    r = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-bad', command: 'rm -rf /tmp/x', stdout: 'secret' })));
    assert.equal(r.status, 1, '白名单外键退 1');
    assert.ok(r.stderr.includes('白名单外键'), `报错点名拒收原因（收到：${r.stderr}）`);
    assert.equal(readFileSync(file, 'utf8'), before, '拒收不落半条（整单拒绝）');
    // 坏 JSON → 退 1
    assert.equal(runCli(['--project-root', root, 'emit'], 'not-json {{{').status, 1);
    // 缺必填键 → 退 1
    for (const key of ['schemaVersion', 'kind', 'ts', 'observationSource']) {
      const p = emitPayload({ id: `em-miss-${key}` });
      delete p[key];
      const miss = runCli(['--project-root', root, 'emit'], JSON.stringify(p));
      assert.equal(miss.status, 1, `缺 ${key} 须退 1`);
      assert.ok(miss.stderr.includes(key), `报错点名缺键 ${key}（收到：${miss.stderr}）`);
    }
    // 同 id 两次 → 读侧折叠一条（O_APPEND 两行、读侧末条胜出）
    assert.equal(runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-dup', event: 'Stop' }))).status, 0);
    assert.equal(runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-dup', event: 'Stop' }))).status, 0);
    assert.equal(LIB.readIncidents(root).filter((x) => x.id === 'em-dup').length, 1, '同 id 折叠一条（幂等）');
    // 缺省 id → 按 kind+event+分钟桶派生（同分钟两次折叠一条；跨分钟才分叉）
    // 内部任务-311 F4：显式 ts 构造（不依赖墙钟；原实现两次 Date.now() 跨分钟边界会 2≠1 假红）。
    // 取「当前分钟起点+30s」确保仍在 digest 窗口内，且同分钟两次必然折叠；边界用 +60s 确定性构造。
    const fixedTs = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    const noId = (ts = fixedTs) => {
      const p = emitPayload({ kind: 'observation-degraded', event: 'all-dark', ts });
      delete p.id;
      return JSON.stringify(p);
    };
    assert.equal(runCli(['--project-root', root, 'emit'], noId()).status, 0);
    assert.equal(runCli(['--project-root', root, 'emit'], noId()).status, 0);
    let derived = LIB.readIncidents(root).filter((x) => x.kind === 'observation-degraded');
    assert.equal(derived.length, 1, '缺省 id 按分钟桶幂等（同分钟两次→一条）');
    assert.ok(String(derived[0].id).startsWith('emit-'), '派生 id 形态可识别');
    // 跨分钟才分叉（确定性边界）
    assert.equal(runCli(['--project-root', root, 'emit'], noId(fixedTs + 60_000)).status, 0);
    derived = LIB.readIncidents(root).filter((x) => x.kind === 'observation-degraded');
    assert.equal(derived.length, 2, '跨分钟桶→两条（确定性边界判定）');
    assert.equal(derived[0].cause, 'observation-degraded', 'observation-degraded 分类命中');
    // 写失败 → 退 1（账本位置放目录：append 必失败）
    const broken = tmpRoot();
    try {
      mkdirSync(join(broken, '.workflow', 'incidents.jsonl'), { recursive: true });
      const wf = runCli(['--project-root', broken, 'emit'], JSON.stringify(emitPayload({ id: 'em-wf' })));
      assert.equal(wf.status, 1, '写失败须退 1（不得伪装成功）');
      assert.ok(wf.stderr.includes('写入失败'), `报错点名写失败（收到：${wf.stderr}）`);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
    // ── promote ──
    r = runCli(['--project-root', root, 'promote', 'em-1', '--to', 'learning', '--note', '转学习条目']);
    assert.equal(r.status, 0, `promote 退 0（stderr=${r.stderr}）`);
    const promoDir = join(root, '.workflow', 'promotions');
    const files = readdirSync(promoDir);
    assert.equal(files.length, 1, '恰产出一份草案');
    assert.ok(files[0].endsWith('-em-1.md'), '草案路径 <ts>-<id>.md');
    const draft = readFileSync(join(promoDir, files[0]), 'utf8');
    assert.ok(draft.includes('learning'), '草案含建议目标');
    assert.ok(draft.includes('em-1') && draft.includes('复核'), '草案含记录摘要与复核判据');
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'em-1').promotedTo, 'learning', '记录追加 promotedTo');
    assert.ok(!existsSync(join(root, 'learnings.md')), '不写 learnings 权威面');
    assert.ok(!existsSync(join(root, 'specs', 'open-items.md')), '不写 OPEN 权威面');
    assert.ok(!existsSync(join(root, '.context', 'architecture-feedback.jsonl')), '不写架构反馈权威面');
    assert.equal(runCli(['--project-root', root, 'promote', 'em-1', '--to', 'bogus']).status, 1, '非法目标退 1');
    assert.equal(runCli(['--project-root', root, 'promote', 'no-such-id', '--to', 'learning']).status, 1, '不存在 id 退 1');
    // ── digest ──
    const human = runCli(['--project-root', root, 'digest', '--days', '7']);
    assert.equal(human.status, 0);
    assert.ok(human.stdout.includes('近 7 天'), `人读形态含窗口（收到：${human.stdout}）`);
    const dj = JSON.parse(runCli(['--project-root', root, 'digest', '--days', '7', '--json']).stdout);
    assert.equal(dj.schemaVersion, 1);
    assert.equal(dj.days, 7);
    assert.ok(dj.total >= 3, '窗口内记录总数');
    assert.ok(dj.byCause && typeof dj.byCause === 'object', '含 cause 拆分');
    assert.equal(dj.lostFacts, 0, '无兜底旁路时 lostFacts=0');
    // 窗口过滤：60 天前记录不计入 --days 7
    LIB.appendIncident(root, rec({ id: 'ri-old-digest', ts: Date.now() - 60 * 86400000, cause: 'real-failure' }));
    const dj2 = JSON.parse(runCli(['--project-root', root, 'digest', '--days', '7', '--json']).stdout);
    assert.equal(dj2.total, dj.total, '窗口外记录不计入');
    // lost-facts 同源读文件（与 retro lostFacts 同口径）
    writeFileSync(join(root, '.workflow', 'incidents-lost.jsonl'), '{"schemaVersion":1}\n{"schemaVersion":1}\n');
    assert.equal(JSON.parse(runCli(['--project-root', root, 'digest', '--days', '7', '--json']).stdout).lostFacts, 2);
    // 空态：退 0（读侧 fail-open）
    const empty = tmpRoot();
    try {
      const e = runCli(['--project-root', empty, 'digest']);
      assert.equal(e.status, 0, '空态退 0');
      assert.ok(e.stdout.includes('无'), '空态如实报无数据');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // --help 列出全部子命令；--selftest 项数随批增长（≥28）
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    for (const token of ['emit', 'promote', 'digest']) assert.ok(help.stdout.includes(token), `用法须含 ${token}`);
    const st = runCli(['--selftest']);
    assert.equal(st.status, 0, `selftest 须退 0（${st.stdout}${st.stderr}）`);
    const m = /OK incident-cli\.mjs selftest（(\d+) 项通过）/.exec(st.stdout);
    assert.ok(m && Number(m[1]) >= 28, `selftest 项数须 ≥28（实际 ${m?.[1]}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评审修复 B1：emit/promote 的 id 白名单与「终态不回退」重报拒绝', () => {
  const root = tmpRoot();
  try {
    // ①非法 id 形态（/、空白、..、超长）→ exit 1 整单拒绝、零落账
    for (const [bad, label] of [
      ['a/b', '斜杠'],
      ['a b', '空白'],
      ['a\\b', '反斜杠'],
      ['a..b', '双点'],
      ['x'.repeat(65), '超长'],
    ]) {
      const r = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: bad })));
      assert.equal(r.status, 1, `${label} id 非法须退 1`);
      assert.ok(r.stderr.includes('id'), `报错点名 id（${label}；收到：${r.stderr}）`);
    }
    assert.equal(LIB.readIncidents(root).length, 0, '非法 id 零落账（整单拒绝不落半条）');
    // ②open 同 id 重报 → 读侧折叠幂等（exit 0、只留一条）
    assert.equal(runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-open' }))).status, 0);
    assert.equal(runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-open' }))).status, 0);
    assert.equal(LIB.readIncidents(root).filter((x) => x.id === 'em-open').length, 1, 'open 同 id 折叠幂等');
    // ③resolved 后同 id 重报 → 拒绝（不得把人工处置结论打回 open）
    assert.equal(runCli(['--project-root', root, 'resolve', 'em-open']).status, 0);
    const rr = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-open' })));
    assert.equal(rr.status, 1, 'resolved 同 id 重报须退 1');
    assert.ok(rr.stderr.includes('终态不回退'), `报错明示终态不回退（收到：${rr.stderr}）`);
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'em-open').status, 'resolved', '记录未被改回 open');
    // ④archived 后同 id 重报 → 拒绝
    LIB.appendIncident(root, rec({ id: 'em-arch', kind: 'hook-failure', cause: 'real-failure', status: 'archived' }));
    const ar = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-arch' })));
    assert.equal(ar.status, 1, 'archived 同 id 重报须退 1');
    assert.ok(ar.stderr.includes('终态不回退'));
    // ⑤promote 产物文件名净化：账本被外部写入越界 id → 拒绝且不越界落盘
    LIB.appendIncident(root, rec({ id: '../evil', cause: 'real-failure' }));
    const pr = runCli(['--project-root', root, 'promote', '../evil', '--to', 'learning']);
    assert.equal(pr.status, 1, '越界 id 的 promote 须退 1');
    assert.ok(pr.stderr.includes('id 形态非法'));
    const wfDir = join(root, '.workflow');
    assert.ok(!existsSync(join(root, 'evil.md')) && !existsSync(join(wfDir, 'evil.md')), '未越界写任何文件');
    // ⑥正常 promote 产物仍在 内部工作流状态（未越界断言的正面对照）
    const okp = runCli(['--project-root', root, 'promote', 'em-open', '--to', 'learning']);
    assert.equal(okp.status, 0, `正常 promote 退 0（stderr=${okp.stderr}）`);
    const drafts = readdirSync(join(wfDir, 'promotions'));
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0].endsWith('-em-open.md'), '产物落在 promotions 目录内');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评审修复 N3：emit 的 note/tool 等短串走 token 白名单（中文/空格整单拒绝）', () => {
  const root = tmpRoot();
  try {
    for (const [idx, note] of ['含中文备注', 'has space', 'rm -rf /'].entries()) {
      const r = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: `em-note-${idx}`, note })));
      assert.equal(r.status, 1, `note=${JSON.stringify(note)} 须退 1（防夹带原文）`);
      assert.ok(r.stderr.includes('token'), `报错点名 token 形态（收到：${r.stderr}）`);
    }
    // 合法结构化类别名照常落账
    const ok = runCli(['--project-root', root, 'emit'], JSON.stringify(emitPayload({ id: 'em-note-ok', note: 'disposition-failed' })));
    assert.equal(ok.status, 0, `结构化 note 合法（stderr=${ok.stderr}）`);
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'em-note-ok').note, 'disposition-failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M15 v2 list --json 加法键：rulesVersion/countsByCause/records[].cause，pending 切 v2 单源', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'lj-real', cause: 'real-failure', digest: 'dlj10000000000001', ts: now }));
    LIB.appendIncident(root, rec({ id: 'lj-probe', cause: 'probe-noise', errorClass: 'exit-nonzero', digest: 'dlj20000000000001', ts: now }));
    // 旧行（无 cause）：两层口径回退——lease-deny 排除、error-flag 计入
    LIB.appendIncident(root, rec({ id: 'lj-legacy-lease', kind: 'lease-deny', digest: 'dlj30000000000001', ts: now }));
    LIB.appendIncident(root, rec({ id: 'lj-legacy-real', errorClass: 'error-flag', digest: 'dlj40000000000001', ts: now }));
    const out = JSON.parse(runCli(['--project-root', root, 'list', '--json']).stdout);
    // 加法键（旧键保留，删键/改义须升版本——内部接口-19 §2.1）
    assert.deepEqual(
      Object.keys(out).sort(),
      ['counts', 'countsByCause', 'filter', 'ledger', 'projectRoot', 'records', 'rulesVersion', 'schemaVersion'],
      '键集＝旧四键＋加法三键',
    );
    assert.equal(out.schemaVersion, 1, '信封版本保持 1（加法兼容）');
    assert.equal(out.rulesVersion, 1, '规则表版本透出');
    assert.equal(out.counts.pending, 2, 'pending 切 v2 派生：real＋旧 error-flag 计入，证据面/lease-deny 不计');
    assert.equal(out.counts.open, 4, '旧 open 键语义不变');
    assert.equal(out.countsByCause['real-failure'], 1);
    assert.equal(out.countsByCause['probe-noise'], 1);
    assert.equal(out.countsByCause.unclassified, 2, '无 cause 旧行归 unclassified');
    assert.equal(
      Object.values(out.countsByCause).reduce((a, b) => a + b, 0),
      out.records.length,
      'countsByCause 与 records 单次读盘同源（和＝记录数）',
    );
    assert.equal(out.records.find((x) => x.id === 'lj-real').cause, 'real-failure', 'records[] 带 cause');
    assert.equal(out.records.find((x) => x.id === 'lj-legacy-real').cause, undefined, '旧行不补 cause');
    // 与库层谓词单源同数（同一夹具三处口径一致）
    assert.equal(out.counts.pending, LIB.countSummary(root).pending);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 评审修复轮（2026-10-24）：N1 windowMs 校验 / N2 迁移行 cause 兜底 /
// N4 lost-facts 单源计数 / N6 pendingSplitBySession 切 v2 谓词。
// ─────────────────────────────────────────────────────────────────────────────

test('评审修复 N1：retry-heal 缺/非法 windowMs 计 failed 且不误自愈（超窗收口防线）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'n1-open', kind: 'tool-failure', tool: 'Bash', session: 's1', host: 'zcode', inputDigest: 'in1', cause: 'real-failure', ts: now - 3600000 }));
    // 缺 windowMs：旧实现 `now - ts > undefined` 恒 false ⇒ 陈年 open 记录会被当窗内自愈
    const miss = LIB.applyDispositions(root, { sources: ['retry-heal'], retry: { session: 's1', host: 'zcode', tool: 'Bash', inputDigest: 'in1' }, now });
    assert.equal(miss.failed, 1, '缺 windowMs 计入 failed');
    assert.equal(miss.retryHealed, 0);
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'n1-open').status, 'open', '不得误收口');
    // 非法值（0/NaN/字符串）同样拒绝
    for (const bad of [0, -1, NaN, '300000']) {
      const r = LIB.applyDispositions(root, { sources: ['retry-heal'], retry: { session: 's1', host: 'zcode', tool: 'Bash', inputDigest: 'in1', windowMs: bad }, now });
      assert.equal(r.failed, 1, `windowMs=${String(bad)} 须拒绝`);
    }
    // 合法窗内窗口才自愈：补一条窗内同参记录（陈年那条超窗不得被收口）
    LIB.appendIncident(root, rec({ id: 'n1-fresh', kind: 'tool-failure', tool: 'Bash', session: 's1', host: 'zcode', inputDigest: 'in1', cause: 'real-failure', ts: now - 1000 }));
    const ok = LIB.applyDispositions(root, { sources: ['retry-heal'], retry: { session: 's1', host: 'zcode', tool: 'Bash', inputDigest: 'in1', windowMs: 300000 }, now });
    assert.equal(ok.retryHealed, 1, '窗内记录自愈');
    assert.equal(LIB.readIncidents(root).find((x) => x.id === 'n1-open').status, 'open', '超窗陈年记录不得被同一合法窗口收口');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评审修复 N2：处置迁移行补 cause 兜底（旧记录显式 cause；记录自带 cause 优先）', () => {
  const root = tmpRoot();
  const now = Date.now();
  try {
    LIB.appendIncident(root, rec({ id: 'n2-legacy-tf', kind: 'tool-failure', tool: 'Bash', session: 's2', host: 'zcode', inputDigest: 'in2', ts: now }));
    LIB.appendIncident(root, rec({ id: 'n2-legacy-lease', kind: 'lease-deny', digest: 'n2lease000000001', ts: now }));
    LIB.appendIncident(root, rec({ id: 'n2-legacy-probe', kind: 'tool-failure', errorClass: 'exit-nonzero', ts: now - 40 * 86400000, digest: 'n2probe000000001' }));
    LIB.appendIncident(root, rec({ id: 'n2-has-cause', kind: 'tool-failure', tool: 'Bash', session: 's2', host: 'zcode', inputDigest: 'in2', cause: 'real-failure', ts: now }));

    LIB.applyDispositions(root, { sources: ['retry-heal'], retry: { session: 's2', host: 'zcode', tool: 'Bash', inputDigest: 'in2', windowMs: 300000 }, now });
    LIB.applyDispositions(root, { sources: ['lease-heal'], lease: { kind: 'lease-deny', note: '声明自愈' }, now });
    LIB.applyDispositions(root, { sources: ['aged-archive'], now, maxAgeDays: 30 });
    const byId = new Map(LIB.readIncidents(root).map((x) => [x.id, x]));
    assert.equal(byId.get('n2-legacy-tf').status, 'resolved');
    assert.equal(byId.get('n2-legacy-tf').cause, 'unclassified', '无 cause 旧 tool-failure 迁移带 explicit cause 兜底');
    assert.equal(byId.get('n2-legacy-lease').cause, 'mechanism-trace', 'lease 族旧记录迁移带 mechanism-trace');
    assert.equal(byId.get('n2-legacy-probe').status, 'archived');
    assert.equal(byId.get('n2-legacy-probe').cause, 'probe-noise', '探针噪声旧记录归档带 probe-noise');
    assert.equal(byId.get('n2-has-cause').cause, 'real-failure', '记录自带 cause 优先，不被审计兜底覆盖');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评审修复 N4：countLostFacts 单源非空行计数（坏行/半行/空行口径）', () => {
  const root = tmpRoot();
  try {
    assert.equal(LIB.countLostFacts(root), 0, '缺失 ⇒ 0');
    const file = join(root, '.workflow', 'incidents-lost.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    // 半行（无末尾换行）+ 空行 + 坏 JSON 行，均按「非空行」计
    writeFileSync(file, '{"schemaVersion":1}\n\n{half-written\n{"schemaVersion":1}');
    assert.equal(LIB.countLostFacts(root), 3, '非空行计数：空行不计、坏行/半行照计');
    // CLI digest 与库层同源同数（同一函数）
    const dj = JSON.parse(spawnSync(process.execPath, [CLI, '--project-root', root, 'digest', '--days', '7', '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(dj.lostFacts, LIB.countLostFacts(root), 'digest 与库层单源同数');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M15 v2 countCauses 单源：zeroKeys 预置 / 缺 cause 归 unclassified / 调用点键集各自保留', () => {
  // 内部决策-063 修正案 3 决策 24.1：cause 计数抽 countCauses(rows,{zeroKeys=[]}) 单源；
  // 键集**按调用点保留**（CLI 无零键、store/summary 现状九键、retro 窗口过滤后无零键）。
  const rows = [{ cause: 'real-failure' }, { cause: 'probe-noise' }, {}, { cause: 'unclassified' }, { cause: '' }];
  assert.deepEqual(LIB.countCauses(rows), { 'real-failure': 1, 'probe-noise': 1, unclassified: 3 }, '缺/空 cause 归 unclassified');
  const withZero = LIB.countCauses(rows, { zeroKeys: ['mechanism-trace', 'user-correction'] });
  assert.equal(withZero['mechanism-trace'], 0, 'zeroKeys 预置 0');
  assert.equal(withZero['user-correction'], 0);
  assert.equal(withZero['real-failure'], 1, '零键与实计键共存');
  assert.equal(Object.keys(withZero).length, 5, '键集＝零键 ∪ 实计键');
  assert.deepEqual(LIB.countCauses([], { zeroKeys: ['probe-noise'] }), { 'probe-noise': 0 }, '空记录也带零键');
  assert.deepEqual(LIB.countCauses(null), {}, '非数组防御：返回空对象不抛');
  assert.deepEqual(LIB.countCauses(undefined, {}), {});
});



// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2 测试锚（2026-10-24 内部任务-195/内部决策-063 修正案 3 决策 22/24）：
// 内部验收-29 lost-facts 回放（幂等/审计/原子截断）与 内部验收-30 单源收敛。标题必须与
// 内部规格 §6 的锚语法**逐字一致**（check-test-anchors 把守）。
// ─────────────────────────────────────────────────────────────────────────────

/** 兜底旁路路径（与核心单源 lostFactsPath 同源）。 */
const LOST_PATH = (root) => join(root, '.workflow', 'incidents-lost.jsonl');

/** 构造一条合法旁路行（固定六键；可覆盖字段）。 */
const lostLine = (over = {}) =>
  JSON.stringify({ schemaVersion: 1, ts: Date.now(), kind: 'observation-degraded', observationSource: 'adapter:dsh', count: 1, digest: 'abcdef0123456789', ...over });

/** 写旁路文件（自动建目录；lines 为原始行文本）。 */
function writeLost(root, lines) {
  const file = LOST_PATH(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return file;
}

test('DEV-320 旁路写入→dry-run 可回放（写侧 kind 归一后行可回放）', async () => {
  const root = tmpRoot();
  try {
    const file = writeLost(root, [lostLine({ kind: 'observation-degraded', count: 2 })]);
    const before = readFileSync(file, 'utf8');
    const r = runCli(['--project-root', root, 'emit', '--from-lost', '--dry-run']);
    assert.equal(r.status, 0, `dry-run 退 0（stderr=${r.stderr}）`);
    assert.match(r.stdout, /wouldReplay=1/, '旁路行可回放（写侧 kind 归一后不再被判 invalid）');
    assert.match(r.stdout, /invalid=0/, '无非法行');
    assert.equal(readFileSync(file, 'utf8'), before, 'dry-run 零写：旁路文件逐字不变');
    assert.equal(LIB.readIncidents(root).length, 0, 'dry-run 不落账');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-320 旁路写入→真实回放落账（kind/cause=observation-degraded、severity=warn）', async () => {
  const root = tmpRoot();
  try {
    writeLost(root, [lostLine({ kind: 'observation-degraded', count: 3 })]);
    const r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0, `回放退 0（stderr=${r.stderr}）`);
    const recs = LIB.readIncidents(root).filter((x) => String(x.id).startsWith('lost-'));
    assert.equal(recs.length, 1, '账本新增一条回放记录');
    const rec = recs[0];
    assert.equal(rec.kind, 'observation-degraded', '落账 kind（回放侧固定值）');
    assert.equal(rec.cause, 'observation-degraded', '落账 cause');
    assert.equal(rec.severity, 'warn', '落账 severity（写侧归一后由 action 降为 warn——残余如实可见）');
    assert.equal(rec.status, 'open', '落账 status');
    assert.equal(rec.replayedFrom, 'lost-facts', '审计字段 replayedFrom');
    assert.equal(typeof rec.replayedAt, 'string', '审计字段 replayedAt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M15 v2 lost-facts 回放（幂等/审计/原子截断）', async () => {
  const { replayLostFacts } = await import('../incident-cli.mjs');
  const now = Date.now();
  const v1 = lostLine({ ts: now - 1000, count: 1 });
  const v2 = lostLine({ ts: now - 2000, count: 2, digest: '0123456789abcdef' });
  const badKind = lostLine({ kind: 'hook-failure' });
  const root = tmpRoot();
  try {
    // ── 参数面：普通 emit 携带 --limit/--dry-run 一律退 1（不得静默忽略后真写账） ──
    const norm1 = runCli(['--project-root', root, 'emit', '--dry-run'], JSON.stringify(emitPayload()));
    assert.equal(norm1.status, 1);
    assert.ok(norm1.stderr.includes('仅对 --from-lost 有效'), `普通 emit 旗标作用域错用须显式拒（${norm1.stderr}）`);
    const norm2 = runCli(['--project-root', root, 'emit', '--limit', '3'], JSON.stringify(emitPayload()));
    assert.equal(norm2.status, 1);
    assert.ok(norm2.stderr.includes('仅对 --from-lost 有效'));
    // from-lost 不接受 --json / 位置参数 payload / 非法 limit
    assert.equal(runCli(['--project-root', root, 'emit', '--from-lost', '--json']).status, 1);
    assert.equal(runCli(['--project-root', root, 'emit', '--from-lost', 'payload']).status, 1);
    assert.equal(runCli(['--project-root', root, 'emit', '--from-lost', '--limit', '0']).status, 1);
    assert.equal(runCli(['--project-root', root, 'emit', '--from-lost', '--limit', 'abc']).status, 1);
    assert.equal(runCli(['--project-root', root, 'emit', '--from-lost', '--limit']).status, 1);

    // ── dry-run：零写（文件逐字不变、账本零新增） ──
    const lost = writeLost(root, [v1, 'not-json {{{', badKind, v2]);
    const before = readFileSync(lost, 'utf8');
    let r = runCli(['--project-root', root, 'emit', '--from-lost', '--dry-run']);
    assert.equal(r.status, 0, `dry-run 退 0（stderr=${r.stderr}）`);
    assert.match(r.stdout, /wouldReplay=2/, 'dry-run 报可回放数');
    assert.match(r.stdout, /invalid=2/, 'dry-run 报非法行数（坏 JSON + kind 非 observation-degraded）');
    assert.equal(readFileSync(lost, 'utf8'), before, 'dry-run 零写：旁路文件逐字不变');
    assert.equal(LIB.readIncidents(root).length, 0, 'dry-run 不落账');

    // ── 正式回放（limit=1）：只回放首条有效行；invalid 与超限尾行保留 ──
    r = runCli(['--project-root', root, 'emit', '--from-lost', '--limit', '1']);
    assert.equal(r.status, 0, `回放退 0（stderr=${r.stderr}）`);
    const recs = LIB.readIncidents(root);
    assert.equal(recs.length, 1, 'limit 生效：只回放 1 条');
    const rec = recs[0];
    assert.equal(rec.kind, 'observation-degraded', 'kind 固定 observation-degraded');
    assert.equal(rec.cause, 'observation-degraded', 'cause 经 classifyFact（规则表 r-observation-degraded）');
    assert.equal(rec.severity, 'warn');
    assert.equal(rec.ruleId, 'r-observation-degraded');
    assert.equal(rec.rulesVersion, 1);
    assert.equal(rec.status, 'open');
    assert.equal(rec.replayedFrom, 'lost-facts', '审计字段 replayedFrom');
    assert.ok(Number.isFinite(Date.parse(rec.replayedAt)), '审计字段 replayedAt 为 ISO 时间');
    assert.match(rec.id, /^lost-[0-9a-f]{32}$/, '幂等 id＝lost-<sha256(原始行) 前 32 位>');
    assert.equal(rec.id.length, 37, 'id 37 字符（≤64 白名单）');
    assert.equal(rec.digest, 'abcdef0123456789', '旁路 digest 随记录保留（不进 emit 白名单校验面）');
    assert.equal(rec.ts, now - 1000, 'ts 取旁路行原值');
    assert.equal(rec.count, 1);
    const left = readFileSync(lost, 'utf8').split('\n').filter(Boolean);
    assert.equal(left.length, 3, '回写保留 invalid 2 条 + 超限尾行 1 条');
    assert.ok(left.includes('not-json {{{'), '坏 JSON 原样保留');
    assert.ok(left.includes(v2), '超限尾行原样保留');

    // ── 剩余行再次回放：v2 落账；同 id 重复回放读侧折叠不新增 ──
    r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0);
    assert.equal(LIB.readIncidents(root).length, 2, '第二次回放补上 v2');
    writeLost(root, [v1]);
    r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0);
    assert.equal(LIB.readIncidents(root).filter((x) => x.id === rec.id).length, 1, '同 id 幂等：读侧折叠不新增记录');
    // 账本行级：同 id 追加（open 态非终态，允许追加；读侧末条折叠）——记录永不删
    assert.ok(readFileSync(LIB.incidentFile(root), 'utf8').split('\n').filter((l) => l.includes(`"id":"${rec.id}"`)).length >= 2);

    // ── terminal 同 id：跳过且移除（视为已处理） ──
    assert.ok(LIB.setStatus(root, rec.id, 'resolved', '人工已处置').ok);
    writeLost(root, [v1]);
    r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /terminalSkipped=1/, 'terminal 同 id 计入 terminalSkipped');
    assert.ok(!existsSync(lost) || readFileSync(lost, 'utf8').trim() === '', 'terminal 行被移除（不保留重扫）');
    assert.equal(LIB.readIncidents(root).find((x) => x.id === rec.id).status, 'resolved', '终态不回退');

    // ── 认领失败（文件不存在）：退 0 且不创建空文件 ──
    rmSync(lost, { force: true });
    r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0, '无 lost 文件＝0 行成功退 0');
    assert.ok(!existsSync(lost), '认领失败不创建空文件');

    // ── 遗留 .replaying-* 认领文件：下次回放合并全部行（含合法行）后删除 ──
    const leftover = `${lost}.replaying-999-1`;
    mkdirSync(dirname(lost), { recursive: true });
    const v3 = lostLine({ ts: now - 3000, count: 3, digest: 'feedfacecafebeef' });
    writeFileSync(leftover, `${v3}\n`);
    r = runCli(['--project-root', root, 'emit', '--from-lost']);
    assert.equal(r.status, 0, `遗留认领合并后回放退 0（stderr=${r.stderr}）`);
    assert.ok(!existsSync(leftover), '合并成功后遗留认领文件删除');
    assert.equal(LIB.readIncidents(root).length, 3, '遗留文件中的合法行被回放（不丢）');
    const v3rec = LIB.readIncidents(root).find((x) => x.digest === 'feedfacecafebeef');
    assert.ok(v3rec && v3rec.replayedFrom === 'lost-facts');

    // ── 并发契约：认领期间适配层向原路径 append 新行 → 回写后新行仍在且不丢 ──
    const root2 = tmpRoot();
    try {
      writeLost(root2, [lostLine({ ts: now - 5000, count: 9 })]);
      const newLine = lostLine({ ts: now - 4000, count: 10, digest: 'deadbeefdeadbeef' });
      const res = replayLostFacts(root2, {
        limit: 50,
        afterClaim: ({ lostPath }) => {
          appendFileSync(lostPath, `${newLine}\n`, 'utf8');
        },
      });
      assert.equal(res.ok, true, '认领回放成功');
      assert.equal(res.replayed, 1);
      assert.equal(readFileSync(LOST_PATH(root2), 'utf8').trim(), newLine, '认领窗口内新 append 的行保留且未被覆盖（不丢）');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }

    // ── 账本写失败：退 1 且不截断/不释放认领（账本路径做成目录 ⇒ append EISDIR；
    //    目录仍可写，认领 rename 正常，只让写账失败——不用只读目录，避免 root/Windows 权限位差异） ──
    const root3 = tmpRoot();
    try {
      writeLost(root3, [v1]);
      mkdirSync(LIB.incidentFile(root3), { recursive: true });
      r = runCli(['--project-root', root3, 'emit', '--from-lost']);
      assert.equal(r.status, 1, '账本写失败退 1');
      assert.ok(r.stderr.includes('账本写入失败'), `stderr 报写入失败（${r.stderr}）`);
      const wfDir = join(root3, '.workflow');
      const names = readdirSync(wfDir);
      assert.ok(names.some((n) => n.includes('.replaying-')), '写失败保留认领文件（不截断、不释放）');
      const claimed = names.find((n) => n.includes('.replaying-'));
      assert.equal(readFileSync(join(wfDir, claimed), 'utf8').trim(), v1, '认领文件内容完整（记录不丢）');
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M15 v2 单源收敛（规则表驱动/宿主探测/计数单源）', async () => {
  // ① 宿主探测单源：前缀矩阵经公开 API（host-detect 为唯一实现；Kimi/MCode + ZCODE_ 真实组合）
  const { hostOf } = await import('../lib/host-detect.mjs');
  assert.equal(hostOf({}, { DSH_SESSION_ID: 's' }), 'dsh');
  assert.equal(hostOf({}, { KIMI_CODE_HOME: '/k' }), 'kimi');
  assert.equal(hostOf({}, { MCODE_PLUGIN_ROOT: '/m' }), 'mcode');
  assert.equal(hostOf({}, { ZCODE_PLUGIN_ROOT: '/z' }), 'zcode');
  assert.equal(hostOf({}, { KIMI_CODE_HOME: '/k', ZCODE_PLUGIN_ROOT: '/z' }), 'kimi', 'KIMI_+ZCODE_ ⇒ kimi（ZCODE_ 末位）');
  assert.equal(hostOf({}, { MCODE_PLUGIN_ROOT: '/m', ZCODE_PROJECT_DIR: '/p' }), 'mcode', 'MCODE_+ZCODE_ ⇒ mcode');
  assert.equal(hostOf({ host: 'explicit' }, { DSH_X: '1' }), 'explicit', '显式 host 优先');
  assert.equal(hostOf({}, { DSH_EMPTY: '' }), 'unknown', '空串视同未设置');
  // 钩侧不再有第二张表（单源纪律的机械面）
  const leaseLibText = readFileSync(resolve(HERE, '..', '..', 'hooks', 'task-lease-lib.mjs'), 'utf8');
  assert.ok(!/function hostOf\s*\(/.test(leaseLibText), 'task-lease-lib 无本地 hostOf 实现');

  // ② 规则表驱动：env 注入临时表改 pendingCauses ⇒ isPendingIncidentV2 随之变化
  const { CAUSES, clearRulesCache } = await import('../lib/incident-rules.mjs');
  const rulesRoot = tmpRoot();
  const prevRules = process.env.WF_INCIDENT_RULES_PATH;
  try {
    const rulesFile = join(rulesRoot, 'rules.json');
    writeFileSync(
      rulesFile,
      JSON.stringify({
        schemaVersion: 1,
        rulesVersion: 9,
        causes: ['real-failure', 'unclassified', 'probe-noise'],
        severities: ['info', 'warn', 'action'],
        pendingCauses: ['real-failure'],
        evidenceCauses: ['probe-noise', 'unclassified'],
        replayableErrorCodes: [],
        rules: [],
      }),
    );
    process.env.WF_INCIDENT_RULES_PATH = rulesFile;
    clearRulesCache();
    assert.equal(LIB.isPendingIncidentV2({ status: 'open', cause: 'unclassified' }), false, 'pendingCauses 生产读取：unclassified 移出待排查');
    assert.equal(LIB.isPendingIncidentV2({ status: 'open', cause: 'real-failure' }), true);
  } finally {
    if (prevRules === undefined) delete process.env.WF_INCIDENT_RULES_PATH;
    else process.env.WF_INCIDENT_RULES_PATH = prevRules;
    clearRulesCache();
    rmSync(rulesRoot, { recursive: true, force: true });
  }

  // ③ 计数单源：countCauses 在 store/summary/CLI 三面保留各自键集
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'c1', cause: 'real-failure' }));
    LIB.appendIncident(root, rec({ id: 'c2', cause: 'probe-noise', digest: 'c2digest00000001' }));
    LIB.appendIncident(root, rec({ id: 'c3', digest: 'c3digest00000001' })); // 缺 cause ⇒ unclassified
    const storeCounts = LIB.countsByCause(root);
    assert.deepEqual(Object.keys(storeCounts).sort(), [...CAUSES].sort(), 'store 面保留九键（zeroKeys=CAUSES）');
    assert.equal(storeCounts['real-failure'], 1);
    assert.equal(storeCounts['probe-noise'], 1);
    assert.equal(storeCounts.unclassified, 1);
    assert.deepEqual(LIB.countSummary(root).countsByCause, storeCounts, 'countSummary 与 countsByCause 同源同数');
    const { buildSummary } = await import('../lib/incident-summary.mjs');
    assert.deepEqual(buildSummary(root).byCause, storeCounts, 'summary 面九键与 store 单源一致');
    const cliJson = JSON.parse(runCli(['--project-root', root, 'list', '--json']).stdout);
    assert.deepEqual(
      Object.keys(cliJson.countsByCause).sort(),
      ['probe-noise', 'real-failure', 'unclassified'],
      'CLI 面无零键（只实计 cause，键集按调用点保留）',
    );
    assert.equal(cliJson.countsByCause['real-failure'], 1);
    // JSON 契约：行级 records 带 cause（加法键，旧行可缺省），rulesVersion 取规则表版本
    assert.equal(cliJson.rulesVersion, 1, 'list --json rulesVersion 与规则表一致');
    assert.ok(cliJson.records.every((x) => typeof x.id === 'string' && (x.cause === undefined || typeof x.cause === 'string')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-244 P01：open 面快速读（解析面读放大治理）────

test('DEV-244 P01：readOpenIncidents 末状态折叠口径（已 resolved 的 id 不入 open 面）', () => {
  const root = tmpRoot();
  try {
    LIB.appendIncident(root, rec({ id: 'fo-a', ts: 1000 }));
    LIB.appendIncident(root, { ...rec({ id: 'fo-a', ts: 1000 }), status: 'triaged' });
    LIB.appendIncident(root, rec({ id: 'fo-b', ts: 1000, digest: 'dfob000000000001' }));
    LIB.appendIncident(root, rec({ id: 'fo-c', ts: 1000, digest: 'dfoc000000000001' }));
    LIB.appendIncident(root, { ...rec({ id: 'fo-c', ts: 1000, digest: 'dfoc000000000001' }), status: 'resolved' });
    const open = LIB.readOpenIncidents(root);
    assert.deepEqual(open.records.map((r) => r.id).sort(), ['fo-b'], '末状态非 open 一律排除（与 readIncidents 折叠同义）');
    assert.equal(open.dropped, 0);
    // 等价性锚（阶段门维护性评审）：open 面 ≡ 全量折叠面按 status=open 过滤（含末条覆盖）
    const foldedOpen = LIB.readIncidents(root).filter((r) => r.status === 'open');
    assert.deepEqual(
      open.records.map((r) => r.id).sort(),
      foldedOpen.map((r) => r.id).sort(),
      'readOpenIncidents 与 readIncidents 折叠口径等价',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-244 P01：重试自愈索引（纯缓存）单元面 ──

test('DEV-244 P01：重试自愈索引——写读/过期 miss/上限 200/清理/删除', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'inc-idx-'));
  try {
    assert.equal(LIB.readRetryOpenIndex(stateDir, 'sess-idx').hit, false, '缺失即 miss');
    assert.equal(LIB.writeRetryOpenIndex(stateDir, 'sess-idx', ['a', 'b', 'a']).ok, true);
    const hit = LIB.readRetryOpenIndex(stateDir, 'sess-idx');
    assert.equal(hit.hit, true);
    assert.deepEqual(hit.ids, ['a', 'b'], '去重保序');
    assert.equal(LIB.readRetryOpenIndex(stateDir, 'sess-idx', Date.now() + 10 * 86400e3).hit, false, '过期即 miss');
    const many = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    assert.equal(LIB.writeRetryOpenIndex(stateDir, 'sess-idx', many).ok, true);
    assert.equal(LIB.readRetryOpenIndex(stateDir, 'sess-idx').ids.length, 200, '条目上限 200');
    assert.equal(LIB.clearRetryOpenIndex(stateDir, 'sess-idx').ok, true);
    assert.equal(LIB.readRetryOpenIndex(stateDir, 'sess-idx').hit, false, '删除后 miss');
    // 过期清理：过期文件删、正常留存
    assert.equal(LIB.writeRetryOpenIndex(stateDir, 'sess-a', ['x']).ok, true);
    const f = LIB.retryOpenIndexFile(stateDir, 'sess-a');
    const body = JSON.parse(readFileSync(f, 'utf8'));
    body.expiresAt = Date.now() - 1;
    writeFileSync(f, JSON.stringify(body));
    assert.equal(LIB.writeRetryOpenIndex(stateDir, 'sess-b', ['y']).ok, true);
    const cleaned = LIB.cleanupExpiredRetryIndexes(stateDir);
    assert.equal(cleaned.removed, 1, '只清过期文件');
    assert.ok(existsSync(LIB.retryOpenIndexFile(stateDir, 'sess-b')), '正常索引留存');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-244 P01：healRetryOpenByIndex 命中走索引（读为常数 ≤2；未入索引记录不被收口）', () => {
  const root = tmpRoot();
  const stateDir = mkdtempSync(join(tmpdir(), 'inc-idx-heal-'));
  try {
    const now = Date.now();
    LIB.appendIncident(root, rec({ id: 'idx-a', session: 'sess-h', tool: 'Bash', inputDigest: 'dgA', errorClass: 'error-flag', ts: now }));
    LIB.appendIncident(root, rec({ id: 'idx-b', session: 'sess-h', tool: 'Bash', inputDigest: 'dgA', errorClass: 'error-flag', ts: now }));
    assert.equal(LIB.writeRetryOpenIndex(stateDir, 'sess-h', ['idx-a']).ok, true);
    let reads = 0;
    const reader = (file) => { reads += 1; return readFileSync(file, 'utf8'); };
    const out = LIB.healRetryOpenByIndex(root, {
      stateDir, session: 'sess-h', host: null, tool: 'Bash', inputDigest: 'dgA',
      windowMs: 5 * 60 * 1000, now, script: 'test-hook', reader,
    });
    assert.equal(out.hit, true);
    assert.equal(out.resolved, 1, '只处置索引内 id');
    // 计划原文「hit→≤1 次账本读」与 CEO r7 阻塞 1（写面锁内必须写前复读、快照不复用于写面）
    // 存在张力：hit 路径常数 2 次（复核读 1＋锁内写前复读 1），仍与 N 解耦；fallback 全扫为 1+N。
    assert.ok(reads <= 2, `hit 路径账本读为常数 ≤2（实测 ${reads}）`);
    const rows = LIB.readIncidents(root);
    assert.equal(rows.find((r) => r.id === 'idx-a').status, 'resolved');
    assert.equal(rows.find((r) => r.id === 'idx-b').status, 'open', '未入索引记录证明未走全量回扫');
    assert.deepEqual(LIB.readRetryOpenIndex(stateDir, 'sess-h').ids, [], '索引内已处置候选被移除（idx-b 从未入索引）');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-244 P03：setStatusMany 批量迁移单次整读＋prevStatus 审计＋锁释放', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      LIB.appendIncident(root, rec({ id: `batch-${i}`, ts: 1000, cause: 'probe-noise', digest: `b${i}00000000000000` }));
    }
    let reads = 0;
    const reader = (file) => {
      reads += 1;
      return readFileSync(file, 'utf8');
    };
    const rows = LIB.readIncidents(root, { reader });
    assert.equal(reads, 1, '注入 reader：readIncidents 单次读盘');
    const res = LIB.setStatusMany(root, rows.map((r) => ({ id: r.id, status: 'resolved', note: '批量处置' })), { script: 'test-hook' });
    assert.equal(res.ok, true);
    assert.equal(res.applied, 5);
    const after = LIB.readIncidents(root);
    assert.ok(after.every((r) => r.status === 'resolved' && r.prevStatus === 'open'), '迁移行带 prevStatus 审计');
    assert.equal(existsSync(join(root, '.workflow', 'incidents.status.lock')), false, '锁已释放（无残留）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-244 P01：archiveAgedIncidents 迁移读盘次数与条数解耦（N 条 ≤2 次整读）', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 6; i += 1) {
      LIB.appendIncident(root, rec({ id: `aged-${i}`, ts: 1000, cause: 'probe-noise', digest: `a${i}00000000000000` }));
    }
    let reads = 0;
    const reader = (file) => {
      reads += 1;
      return readFileSync(file, 'utf8');
    };
    const out = LIB.archiveAgedIncidents(root, { now: Date.now(), reader });
    assert.equal(out.archived, 6);
    assert.ok(reads <= 2, `N 条归档读盘次数须与 N 解耦（实测 ${reads} 次；候选整读 1＋锁内写前复读 1）`);
    assert.ok(LIB.readIncidents(root).every((r) => r.status === 'archived' && r.prevStatus === 'open'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-244 P03：状态写锁——活锁占用失败可见；死 pid 陈旧锁回收后成功', () => {
  const root = tmpRoot();
  const stateDir = mkdtempSync(join(tmpdir(), 'inc-slock-'));
  const prevState = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    LIB.appendIncident(root, rec({ id: 'lock-1', ts: 1000, digest: 'dlock00000000001' }));
    const lockFile = join(root, '.workflow', 'incidents.status.lock');
    writeFileSync(lockFile, JSON.stringify({ owner: 'other', pid: process.pid, ts: Date.now() }));
    const r = LIB.setStatus(root, 'lock-1', 'resolved');
    assert.equal(r.ok, false, '活锁占用时写状态须失败');
    assert.equal(r.reason, 'status-lock-failed');
    const log = join(stateDir, 'hook-errors.jsonl');
    assert.ok(existsSync(log), '锁失败必须可见（hook-errors 留痕）');
    assert.ok(readFileSync(log, 'utf8').includes('status-lock-failed'));
    // 死 pid 陈旧锁：pid 探测判死 → 隔离后单次重试成功
    writeFileSync(lockFile, JSON.stringify({ owner: 'dead', pid: 999999, ts: Date.now() }));
    const r2 = LIB.setStatus(root, 'lock-1', 'resolved');
    assert.equal(r2.ok, true, `死 pid 陈旧锁须被回收后成功（${r2.reason ?? ''}）`);
    assert.equal(existsSync(lockFile), false, '锁已释放');
  } finally {
    if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevState;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-244 最终评审 B4：空/半写锁 2s 宽限回收（statSync 导入回归锁）', () => {
  const root = tmpRoot();
  const stateDir = mkdtempSync(join(tmpdir(), 'inc-emptylock-'));
  const prevState = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    LIB.appendIncident(root, rec({ id: 'elock-1', ts: 1000, digest: 'delock0000000001' }));
    const lockFile = join(root, '.workflow', 'incidents.status.lock');
    writeFileSync(lockFile, ''); // 模拟 openSync 后、写内容前崩溃的空锁
    // 宽限窗口内：不得回收（避免两写者同入临界区）
    const r1 = LIB.setStatus(root, 'elock-1', 'triaged', '宽限');
    assert.equal(r1.ok, false, '2s 宽限内空锁不回收');
    // 拨老 mtime 超宽限：回收后成功（statSync 缺失时此分支 ReferenceError 被吞 → 恒失败）
    const old = new Date(Date.now() - 60 * 1000);
    utimesSync(lockFile, old, old);
    const r2 = LIB.setStatus(root, 'elock-1', 'resolved', '回收');
    assert.equal(r2.ok, true, `超宽限空锁须被回收后成功（${r2.reason ?? ''}）`);
  } finally {
    if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevState;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-244 P03：prevStatus 非法链 → 拒绝并 status-regression 留痕', () => {
  const root = tmpRoot();
  const stateDir = mkdtempSync(join(tmpdir(), 'inc-chain-'));
  const prevState = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    LIB.appendIncident(root, rec({ id: 'chain-1', ts: 1000, digest: 'dchain0000000001' }));
    // 非法链：triaged 的法定前驱只能是 open，prevStatus 却写 resolved
    LIB.appendIncident(root, { ...rec({ id: 'chain-1', ts: 1000, digest: 'dchain0000000001' }), status: 'triaged', prevStatus: 'resolved' });
    const r = LIB.setStatus(root, 'chain-1', 'resolved', '闭环');
    assert.equal(r.ok, false, '非法 prevStatus 链须拒绝');
    assert.match(String(r.reason), /状态链非法/);
    const log = join(stateDir, 'hook-errors.jsonl');
    assert.ok(existsSync(log), '链异常必须可见');
    assert.ok(readFileSync(log, 'utf8').includes('status-regression'));
  } finally {
    if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevState;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-244 Q02：lost-facts 回放 dry-run 与真实执行共用一个决策树 ──

test('DEV-244 Q02：dry-run 计划与真实回放同源（planLostReplay 单决策树）', async () => {
  const root = tmpRoot();
  try {
    const { planLostReplay, replayLostFacts } = await import('../incident-cli.mjs');
    const lost = LIB.lostFactsPath(root);
    mkdirSync(dirname(lost), { recursive: true });
    const mk = (source) => JSON.stringify({ schemaVersion: 1, ts: Date.now(), kind: 'observation-degraded', observationSource: 'adapter:dsh', count: 1, digest: 'abcdef0123456789', note: source });
    const lines = [mk('one'), 'not-json {{{', mk('two')];
    writeFileSync(lost, `${lines.join('\n')}\n`);
    // 单源决策树直测：limit=1 → replay 1 / invalid 1 / remaining 1
    const planned = planLostReplay(lines, new Map(), 1);
    assert.deepEqual(planned.map((d) => d.action), ['replay', 'invalid', 'remaining']);
    // dry-run 与执行同根对比
    const dry = replayLostFacts(root, { limit: 1, dryRun: true });
    assert.equal(dry.wouldReplay, 1);
    assert.equal(dry.invalid, 1);
    assert.equal(dry.remaining, 2, '坏行与超 limit 行均计入 remaining（保留待下轮）');
    const real = replayLostFacts(root, { limit: 1 });
    assert.equal(real.replayed, dry.wouldReplay, '干跑计划数＝实际回放数（同一决策树）');
    assert.equal(real.invalid, dry.invalid, '坏行口径一致');
    assert.equal(real.terminalSkipped, dry.terminalSkipped);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 内部任务-349：异常台账写入的内部归因行 ----------

/**
 * 归因夹具：真 tmp git 仓（激活域）＋独立 tmp 状态根注入缝。
 * 说明：本仓 `.workflow/*` 被 gitignore，报表不可观测；本用例按症状仓布局（台账 tracked）构造。
 * @returns {Promise<{repo:string, state:string, restore:()=>void, skip?:boolean}>}
 */
async function journalFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'wf-dev349-repo-'));
  const state = mkdtempSync(join(tmpdir(), 'wf-dev349-state-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    return { repo, state, restore: () => {}, skip: true };
  }
  const saved = { state: process.env.WF_ROUTING_STATE_DIR, incident: process.env.WF_INCIDENT_ROOT };
  process.env.WF_ROUTING_STATE_DIR = state;
  delete process.env.WF_INCIDENT_ROOT;
  return {
    repo,
    state,
    restore: () => {
      if (saved.state === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = saved.state;
      if (saved.incident === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = saved.incident;
      rmSync(repo, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    },
  };
}

/** 计算 journal 文件路径（与 write-audit 的 stateDir+projDigest 同口径）。 */
async function journalFileFor(stateDir, effectiveRootPath) {
  const { activationRoot, projectKey } = await import('../../hooks/routing-lib.mjs');
  const { projectDigestOf } = await import('../lib/write-audit.mjs');
  const repoRoot = activationRoot(effectiveRootPath);
  assert.ok(repoRoot, '夹具根须为激活域（.git）');
  return join(stateDir, `wf-write-journal-${projectDigestOf(projectKey(repoRoot))}.jsonl`);
}

/** 读 journal 全部行（不存在返 []）。 */
function readJournalLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

test('DEV-349 归因判定：target 等值白名单（仓根/子目录/仓外一律）', async () => {
  assert.equal(typeof LIB.incidentJournalTargets, 'function', '须导出 incidentJournalTargets（纯判定）');
  const repo = mkdtempSync(join(tmpdir(), 'wf-dev349-pure-'));
  try {
    assert.deepEqual(LIB.incidentJournalTargets(repo, repo), [LIB.INCIDENT_JOURNAL_TARGET], '仓根 → 唯一等值 target');
    assert.deepEqual(LIB.incidentJournalTargets(repo, join(repo, '.workflow')), [], 'root 指向 .workflow 目录 → 双段路径不得放行');
    const saved = process.env.WF_INCIDENT_ROOT;
    process.env.WF_INCIDENT_ROOT = join(repo, 'elsewhere');
    try {
      assert.deepEqual(LIB.incidentJournalTargets(repo, repo), [], 'WF_INCIDENT_ROOT 指仓内他目录 → 等值不成立');
    } finally {
      if (saved === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = saved;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-349 归因判定：相对 root 按 cwd 归一（子目录形态不得误判仓根账本）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wf-dev349-rel-'));
  const sub = join(repo, 'sub');
  mkdirSync(sub, { recursive: true });
  const savedCwd = process.cwd();
  try {
    process.chdir(repo);
    assert.deepEqual(LIB.incidentJournalTargets(repo, '.'), [LIB.INCIDENT_JOURNAL_TARGET], 'cwd=仓根 → 命中仓根账本');
    process.chdir(sub);
    assert.deepEqual(LIB.incidentJournalTargets(repo, '.'), [], 'cwd=子目录 → 子目录账本不等于仓根账本（防无依据归因）');
  } finally {
    process.chdir(savedCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-349 归因写：appendIncident/setStatus 各追加一条 internal 行（sid/taskId 原样透传）', async (t) => {
  const fx = await journalFixture();
  if (fx.skip) { t.skip('git 不可用'); return; }
  try {
    const journal = await journalFileFor(fx.state, fx.repo);
    const a = LIB.appendIncident(fx.repo, { id: 'ri-dev349-1', ts: Date.now(), session: 'session-abc', taskId: 'DEV-349', kind: 'tool-failure', digest: 'd000000000000001' });
    assert.equal(a.ok, true, '账本追加须成功');
    let rows = readJournalLines(journal);
    assert.equal(rows.length, 1, '一次账本写须追加一条 journal 行');
    assert.equal(rows[0].tool, 'internal');
    assert.equal(rows[0].shape, 'internal');
    assert.equal(rows[0].sid, 'session-abc', 'sid 取记录归属会话原样透传');
    const { sidDigestOf } = await import('../lib/write-audit.mjs');
    assert.equal(rows[0].sidDigest, sidDigestOf('session-abc'), 'sidDigest 与报表同算法（sha256 前 16 位）');
    assert.equal(rows[0].taskId, 'DEV-349');
    assert.deepEqual(rows[0].targets, [LIB.INCIDENT_JOURNAL_TARGET], 'target 固定为账本等值路径');
    const s = LIB.setStatus(fx.repo, 'ri-dev349-1', 'resolved', 'DEV-349');
    assert.equal(s.ok, true, '状态迁移须成功');
    rows = readJournalLines(journal);
    assert.equal(rows.length, 2, '状态迁移须再追加一条（账本写与归因行一比一）');
    assert.equal(rows[1].sid, 'session-abc', '迁移行继承原归属');
  } finally {
    fx.restore();
  }
});

test('DEV-349 归因写：非激活域（无 .git/.sdd）零 journal（既有夹具零污染保护锁）', async () => {
  const root = tmpRoot();
  const state = mkdtempSync(join(tmpdir(), 'wf-dev349-state-'));
  const saved = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = state;
  try {
    const a = LIB.appendIncident(root, { id: 'ri-dev349-2', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'd000000000000002' });
    assert.equal(a.ok, true);
    assert.equal(readdirSync(state).filter((f) => f.startsWith('wf-write-journal-')).length, 0, '非激活域不得写 journal');
  } finally {
    if (saved === undefined) delete process.env.WF_ROUTING_STATE_DIR; else process.env.WF_ROUTING_STATE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-349 归因写：journal 写失败 fail-open（账本成功即 ok，且不抛）', async (t) => {
  const fx = await journalFixture();
  if (fx.skip) { t.skip('git 不可用'); return; }
  const stateFile = join(fx.repo, 'state-as-file');
  writeFileSync(stateFile, 'x');
  process.env.WF_ROUTING_STATE_DIR = stateFile; // stateRootFor 接受 seam 原值 → mkdirSync 抛 ENOTDIR
  try {
    const a = LIB.appendIncident(fx.repo, { id: 'ri-dev349-3', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'd000000000000003' });
    assert.equal(a.ok, true, '归因失败不得反噬账本写');
    assert.ok(existsSync(join(fx.repo, '.workflow', 'incidents.jsonl')), '账本行须已落盘');
  } finally {
    fx.restore();
  }
});

test('DEV-349 归因写：缓存键含生效根与状态缝（同进程切换不得串味）', async (t) => {
  const fx = await journalFixture();
  if (fx.skip) { t.skip('git 不可用'); return; }
  try {
    const journal = await journalFileFor(fx.state, fx.repo);
    LIB.appendIncident(fx.repo, { id: 'ri-dev349-4', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'd000000000000004' });
    assert.equal(readJournalLines(journal).length, 1, '首写须补行');
    const outside = mkdtempSync(join(tmpdir(), 'wf-dev349-out-'));
    process.env.WF_INCIDENT_ROOT = outside;
    try {
      const a = LIB.appendIncident(fx.repo, { id: 'ri-dev349-5', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'd000000000000005' });
      assert.equal(a.ok, true);
      assert.equal(readJournalLines(journal).length, 1, '切换 WF_INCIDENT_ROOT 后缓存不得复用旧判定');
      assert.ok(existsSync(join(outside, '.workflow', 'incidents.jsonl')), '账本须落注入根');
    } finally {
      delete process.env.WF_INCIDENT_ROOT;
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fx.restore();
  }
});
