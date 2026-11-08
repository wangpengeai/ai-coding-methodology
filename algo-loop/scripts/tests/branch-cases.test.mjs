// 文件：algo-loop/scripts/tests/branch-cases.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201）——algo-write `applyWrite` 的负例分支矩阵（六个 op 的
//       参数/资产/状态机拒绝面）与 algo-state/check-consistency 的损坏资产分支；断言拒因点名。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.0.1 2026-11-01 wangp 内部任务-269：坏行口径（六要素 schema）与 project 门/transition schema 门断言同步；
//           清理死导入（mkdirSync/HERE/ALGO_DIR）；toolchain.version 夹具补齐。
// 自检：node --test "algo-loop/scripts/tests/branch-cases.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyWrite } from '../algo-write.mjs';
import { readAlgoState } from '../algo-state.mjs';
import { findViolations } from '../check-consistency.mjs';

/** 造一个已立项根（五件齐备；toolchain.command 用占位空串由 applyWrite 的 init 写入模板）。 */
function makeRoot({ toolchainCommand = 'x' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev209-algo-'));
  const contract = {
    schemaVersion: 1,
    version: 1,
    metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: toolchainCommand, version: 'v1' } }],
    baselineRef: '',
    targets: {},
    guardrails: [],
  };
  const r = applyWrite(root, 'init', { projectId: 'dev209', contract });
  assert.equal(r.ok, true, `init 夹具应成功：${JSON.stringify(r)}`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

test('applyWrite 未知子命令：干净拒绝并列出候选', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev209-algo-'));
  try {
    const r = applyWrite(root, 'nope', {});
    assert.equal(r.ok, false);
    assert.match(r.message, /未知子命令/);
  } finally { cleanup(root); }
});

test('init 负例：缺 projectId / 缺 metrics / 重复 init / 默认模板契约', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev209-algo-'));
  try {
    assert.match(applyWrite(root, 'init', null).message, /缺必填 projectId/);
    assert.match(applyWrite(root, 'init', {}).message, /缺必填 projectId/);
    assert.match(applyWrite(root, 'init', { projectId: 'p', contract: {} }).message, /metrics/);
    // contract 缺省 → 读模板契约（模板 metrics 非空即成功）
    const templateInit = applyWrite(root, 'init', { projectId: 'p' });
    assert.equal(templateInit.ok, true, `模板契约 init：${JSON.stringify(templateInit)}`);
    assert.match(applyWrite(root, 'init', { projectId: 'p2' }).message, /已存在 .algo\/project.json/);
  } finally { cleanup(root); }
});

test('ledger-append 负例矩阵：六要素/字段类型/decision/契约资产/工具链/重复 id', () => {
  const root = makeRoot({ toolchainCommand: 'x' });
  try {
    const base = { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' };
    assert.match(applyWrite(root, 'ledger-append', null).message, /缺六要素之一/);
    for (const key of Object.keys(base)) {
      const p = { ...base };
      delete p[key];
      assert.match(applyWrite(root, 'ledger-append', p).message, new RegExp(`缺六要素之一：${key}`), `缺 ${key} 须拒`);
    }
    assert.match(applyWrite(root, 'ledger-append', { ...base, id: '' }).message, /id 须为非空字符串/);
    assert.match(applyWrite(root, 'ledger-append', { ...base, metricsRef: ' ' }).message, /metricsRef 须为非空字符串/);
    assert.match(applyWrite(root, 'ledger-append', { ...base, hypothesis: '' }).message, /hypothesis\/change/);
    assert.match(applyWrite(root, 'ledger-append', { ...base, singleVariable: null }).message, /singleVariable 须为/);
    assert.match(applyWrite(root, 'ledger-append', { ...base, singleVariable: {} }).message, /singleVariable 须为/);
    assert.match(applyWrite(root, 'ledger-append', { ...base, decision: 'maybe' }).message, /decision 须属/);
    // contract.json 缺席 → 拒
    const noContract = mkdtempSync(join(tmpdir(), 'dev209-algo-'));
    try {
      assert.match(applyWrite(noContract, 'ledger-append', base).message, /project\.json/);
    } finally { cleanup(noContract); }
    // contract.json 坏 JSON → 拒（不自动修）
    const badContract = makeRoot();
    try {
      writeFileSync(join(badContract, '.algo', 'contract.json'), '{bad', 'utf8');
      assert.match(applyWrite(badContract, 'ledger-append', base).message, /contract.json 不可解析/);
    } finally { cleanup(badContract); }
    // toolchain 空占位 → 首轮台账前必须补齐
    const emptyTool = makeRoot({ toolchainCommand: '' });
    try {
      assert.match(applyWrite(emptyTool, 'ledger-append', base).message, /测量工具链未声明/);
    } finally { cleanup(emptyTool); }
    // 正常追加 + 重复 id 拒绝
    assert.equal(applyWrite(root, 'ledger-append', base).ok, true);
    assert.match(applyWrite(root, 'ledger-append', base).message, /台账已存在同 id/);
  } finally { cleanup(root); }
});

test('baseline-register 负例矩阵：缺字段/资产缺失/坏 JSON/追溯断链/重复 id', () => {
  const root = makeRoot();
  try {
    assert.match(applyWrite(root, 'baseline-register', null).message, /基线条目缺 id/);
    assert.match(applyWrite(root, 'baseline-register', {}).message, /基线条目缺 id/);
    assert.match(applyWrite(root, 'baseline-register', { id: 'b1' }).message, /缺 metrics 对象/);
    assert.match(applyWrite(root, 'baseline-register', { id: 'b1', metrics: {} }).message, /缺 reason/);
    assert.match(applyWrite(root, 'baseline-register', { id: 'b1', metrics: {}, reason: 'x' }).message, /缺 fromIteration/);
    assert.match(applyWrite(root, 'baseline-register', { id: 'b1', metrics: {}, reason: 'x', fromIteration: 'nope' }).message, /fromIteration 悬空/);
    // 资产缺失/坏 JSON
    const absent = mkdtempSync(join(tmpdir(), 'dev209-algo-'));
    try {
      assert.match(applyWrite(absent, 'baseline-register', { id: 'b1', metrics: {}, reason: 'x', fromIteration: 'i' }).message, /project\.json/);
    } finally { cleanup(absent); }
    const bad = makeRoot();
    try {
      applyWrite(bad, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
      writeFileSync(join(bad, '.algo', 'baselines.json'), '{bad', 'utf8');
      assert.match(applyWrite(bad, 'baseline-register', { id: 'b1', metrics: {}, reason: 'x', fromIteration: 'i1' }).message, /baselines.json 不可解析/);
    } finally { cleanup(bad); }
    // 正常登记 + 同 id 重复
    applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
    assert.equal(applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 1 }, reason: 'x', fromIteration: 'i1' }).ok, true);
    assert.match(applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 1 }, reason: 'x', fromIteration: 'i1' }).message, /基线条目同 id 已存在/);
  } finally { cleanup(root); }
});

test('badcase-add 负例矩阵：id/路径分隔符/字段类型/dataRefs/目录缺失/重复 id', () => {
  const root = makeRoot();
  try {
    const good = { id: 'c1', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }] };
    assert.match(applyWrite(root, 'badcase-add', null).message, /bad case 缺 id/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, id: '' }).message, /bad case 缺 id/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, id: 'a/b' }).message, /不得含路径分隔符/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, symptom: '' }).message, /缺 symptom/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, env: '' }).message, /缺 env/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, dataRefs: 'x' }).message, /缺 dataRefs 数组/);
    assert.match(applyWrite(root, 'badcase-add', { ...good, dataRefs: [{}] }).message, /dataRefs 条目须含非空 kind 与 ref/);
    assert.equal(applyWrite(root, 'badcase-add', good).ok, true);
    assert.match(applyWrite(root, 'badcase-add', good).message, /同 id 已存在/);
    // badcases 目录缺失
    const noDir = makeRoot();
    try {
      rmSync(join(noDir, '.algo', 'badcases'), { recursive: true, force: true });
      assert.match(applyWrite(noDir, 'badcase-add', good).message, /缺 .algo\/badcases\//);
    } finally { cleanup(noDir); }
  } finally { cleanup(root); }
});

test('badcase-transition 负例矩阵：id/status/不存在/坏 JSON/文件状态非法/回退', () => {
  const root = makeRoot();
  try {
    const add = { id: 'c1', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }] };
    applyWrite(root, 'badcase-add', add);
    assert.match(applyWrite(root, 'badcase-transition', null).message, /transition 缺 id/);
    assert.match(applyWrite(root, 'badcase-transition', { id: 'c/1', status: '已归因' }).message, /不得含路径分隔符/);
    assert.match(applyWrite(root, 'badcase-transition', { id: 'c1', status: 'bogus' }).message, /status 须属/);
    assert.match(applyWrite(root, 'badcase-transition', { id: 'nope', status: '已归因' }).message, /bad case 不存在/);
    assert.equal(applyWrite(root, 'badcase-transition', { id: 'c1', status: '已归因' }).ok, true);
    assert.match(applyWrite(root, 'badcase-transition', { id: 'c1', status: '待归因' }).message, /状态机仅前向/);
    // 坏 JSON / 结构合法但 status 非法（内部任务-269：transition 先过 §2a 全量校验，坏件停止报修）
    writeFileSync(join(root, '.algo', 'badcases', 'c1.json'), '{bad', 'utf8');
    assert.match(applyWrite(root, 'badcase-transition', { id: 'c1', status: '闭环' }).message, /bad case 文件不可解析/);
    writeFileSync(
      join(root, '.algo', 'badcases', 'c1.json'),
      JSON.stringify({ id: 'c1', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [], status: 'bogus' }),
      'utf8',
    );
    const badStatus = applyWrite(root, 'badcase-transition', { id: 'c1', status: '闭环' });
    assert.equal(badStatus.ok, false);
    assert.match(badStatus.message, /停下报修/);
    assert.match(badStatus.message, /status/);
  } finally { cleanup(root); }
});

test('algo-state/check-consistency：损坏资产、坏行、契约失配、悬空 baselineRef、metricsRef 空', () => {
  const root = makeRoot();
  try {
    // 合法态：present=true、无违例
    const okState = readAlgoState(root);
    assert.equal(okState.present, true);
    assert.deepEqual(findViolations(root), []);
    // 台账坏行（不可解析）：badLines>0 且 check-consistency 显式报
    writeFileSync(join(root, '.algo', 'ledger.jsonl'), '{bad\n', 'utf8');
    const badState = readAlgoState(root);
    assert.ok(badState.badLines >= 1);
    assert.ok(findViolations(root).some((v) => v.includes('坏行')));
    writeFileSync(join(root, '.algo', 'ledger.jsonl'), '', 'utf8');
    // 契约版本失配
    writeFileSync(join(root, '.algo', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'p', contractVersion: 99 }), 'utf8');
    assert.ok(findViolations(root).some((v) => v.includes('契约版本失配')));
    // 坏 baselines → 基线引用检查跳过；baselineRef 悬空时显式报
    writeFileSync(join(root, '.algo', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'p', contractVersion: 1 }), 'utf8');
    const contract = JSON.parse(readFileSync(join(root, '.algo', 'contract.json'), 'utf8'));
    contract.baselineRef = 'nope';
    writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify(contract), 'utf8');
    assert.ok(findViolations(root).some((v) => v.includes('契约基线引用悬空')));
    // metricsRef 空串行：按 §2a 坏行口径呈报（内部任务-269：坏行 ≠ corrupt）
    writeFileSync(join(root, '.algo', 'ledger.jsonl'), JSON.stringify({ id: 'i9', at: new Date().toISOString(), hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: '', decision: 'continue' }) + '\n', 'utf8');
    assert.ok(findViolations(root).some((v) => v.includes('坏行')));
    // toolchain 空占位 + 合法台账行非空 → 报（行须六要素齐备，否则先计坏行、rows=0 不再进 toolchain 检查）
    writeFileSync(join(root, '.algo', 'ledger.jsonl'), JSON.stringify({ id: 'i9', at: new Date().toISOString(), hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' }) + '\n', 'utf8');
    contract.baselineRef = '';
    contract.metrics[0].toolchain.command = '';
    writeFileSync(join(root, '.algo', 'contract.json'), JSON.stringify(contract), 'utf8');
    assert.ok(findViolations(root).some((v) => v.includes('测量工具链未声明')));
  } finally { cleanup(root); }
});
