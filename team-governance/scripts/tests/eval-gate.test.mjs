// 文件：eval-gate.test.mjs
// 描述：replay eval 与治理报告 TDD（内部规则-1..4 / 内部验收-1/2/4）——oracle 七族、
//       哈希不匹配 unverified、judge 不覆盖、报告四态复核、指标红线。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCase, runReplaySuite } from '../lib/eval.mjs';
import { buildReport, verifyReport } from '../lib/governance-gate.mjs';
import { aggregate } from '../metrics.mjs';
import { integrityHash } from '../lib/canonical-json.mjs';


const HASH_OK = 'sha256:' + 'a'.repeat(64);

function ev(partial) {
  return partial;
}

test('oracle 七族：正反例逐一命中', () => {
  const events = [
    ev({ text: '结论：通过，证据齐全' }),
    ev({ type: 'tool', name: 'Read' }),
    ev({ type: 'tool', name: 'Edit' }),
    ev({ json: { id: 'R-1', status: 'a' } }),
    ev({ type: 'exit', code: 0 }),
    ev({ type: 'diff', path: 'src/a.py', contains: 'x=1' }),
  ];
  const ok = [
    { kind: 'exact', value: '结论：通过' },
    { kind: 'regex', pattern: /证据齐全/ },
    { kind: 'json-schema', schema: { type: 'object', required: ['id'] } },
    { kind: 'behavior', required: ['结论'], forbidden: ['跳过验证'] },
    { kind: 'tool-event', required: ['Read'], forbidden: ['Bash'] },
    { kind: 'exit-code', value: 0 },
    { kind: 'file-diff', path: 'src/a.py' },
  ];
  for (const oracle of ok) {
    const r = runCase({ caseId: 'c1', subjectHash: HASH_OK, events, oracles: [oracle] }, { currentSubjectHash: HASH_OK });
    assert.equal(r.status, 'passed', `${oracle.kind} 应通过`);
    assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0, 'duration 真实测量');
  }
  const bad = [
    { kind: 'exact', value: '不存在' },
    { kind: 'behavior', required: ['缺失标志'] },
    { kind: 'behavior', forbidden: ['结论'] },
    { kind: 'tool-event', forbidden: ['Edit'] },
    { kind: 'exit-code', value: 1 },
  ];
  for (const oracle of bad) {
    const r = runCase({ caseId: 'c1', subjectHash: HASH_OK, events, oracles: [oracle] }, { currentSubjectHash: HASH_OK });
    assert.equal(r.status, 'failed', `${JSON.stringify(oracle)} 应失败`);
  }
});

test('对象哈希不匹配 → unverified；judge 不覆盖确定性失败', () => {
  const r = runCase({ caseId: 'c', subjectHash: HASH_OK, events: [], oracles: [{ kind: 'exit-code', value: 0 }], judgeNote: '看起来没问题' },
    { currentSubjectHash: 'sha256:' + 'b'.repeat(64) });
  assert.equal(r.status, 'unverified');
  const failed = runCase({ caseId: 'c', subjectHash: HASH_OK, events: [], oracles: [{ kind: 'exact', value: 'x' }], judgeNote: '看起来没问题' },
    { currentSubjectHash: HASH_OK });
  assert.equal(failed.status, 'failed');
  assert.match(failed.judgeNote, /不可覆盖/);
});

test('suite 报告：passRate 与 measurement 来源', () => {
  const suite = { suiteId: 's1', caseSetVersion: 'v1', cases: [
    { caseId: 'c1', subjectHash: HASH_OK, events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: 'ok' }] },
    { caseId: 'c2', subjectHash: 'sha256:' + 'c'.repeat(64), events: [], oracles: [] },
  ] };
  const report = runReplaySuite(suite, { currentSubjectHash: HASH_OK });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.unverified, 1);
  assert.equal(report.resources.tokens.measurement, 'unavailable');
  assert.equal(report.resources.latencyMs.measurement, 'wall-clock');
  assert.ok(report.integrityHash.startsWith('sha256:'));
});

test('治理报告：未 finalize 阻断 / manifest 哈希失配阻断 / eval 失败阻断 / 状态输出', () => {
  const evalBody = { suiteId: 's1', summary: { failed: 1, unverified: 0 } };
  const { report, blockingCount } = buildReport({
    manifests: [{ runId: 'r1', status: 'open' }],
    evals: [{ ...evalBody, integrityHash: integrityHash(evalBody) }],
  });
  assert.equal(blockingCount, 2);
  assert.equal(report.status, 'blocked');
  // finalized 但 integrityHash 失配（评审 C6：不可变性机械检出）
  const tampered = buildReport({
    manifests: [{ runId: 'r1', status: 'finalized', integrityHash: 'sha256:wrong' }],
  });
  assert.equal(tampered.report.status, 'blocked');
  assert.ok(tampered.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-TAMPERED'));
  // finalized 且哈希正确（用 integrityHash 自算）
  const manifestBody = { runId: 'r1', status: 'finalized', x: 1 };
  const clean = buildReport({
    manifests: [{ ...manifestBody, integrityHash: integrityHash(manifestBody) }],
  });
  assert.equal(clean.report.status, 'passed');
});

test('治理报告：不可解析 run 文件按名点名计 blocking（2026-09-19 评审修复 H6——不吞集假绿）', () => {
  const { report, blockingCount } = buildReport({
    manifests: [],
    unreadableRuns: ['run-bad0.json'],
  });
  assert.equal(blockingCount, 1, '坏件即 blocking');
  assert.equal(report.status, 'blocked');
  assert.ok(
    report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-UNREADABLE' && d.message.includes('run-bad0.json')),
    '按名点名坏文件',
  );
});

test('报告四态复核：passed/blocked/stale/tampered（内部任务-5 C：legacy 报告缺省 stale）', () => {
  const good = buildReport({});
  assert.equal(verifyReport(good.report, { allowLegacy: true }), 'passed');
  const bad = buildReport({ manifests: [{ runId: 'r', status: 'open' }] });
  assert.equal(verifyReport(bad.report, { allowLegacy: true }), 'blocked');
  // 最小 parts 报告无 binding（legacy 形态）：缺省判 stale，不冒充当前全部保证；
  // 显式 allow_legacy 才按旧口径消费（内部接口-18 §4）
  assert.equal(verifyReport(good.report, {}), 'stale', 'legacy 报告缺省 stale');
  const stale = { ...good.report, subjectDigest: 'sha256:' + 'd'.repeat(64), integrityHash: good.report.integrityHash };
  assert.equal(verifyReport(stale, {}), 'tampered', '改 digest 不重算哈希=tampered');
});

test('指标红线：按人分组拒绝；过程维度可用', () => {
  for (const key of ['initiator', 'reviewer', 'login', 'author']) {
    const r = aggregate([], { groupBy: key, metric: 'x' });
    assert.equal(r.ok, false, `${key} 必须拒绝`);
  }
  const r = aggregate([{ policy: 'p1', n: 1 }, { policy: 'p1', n: 2 }], { groupBy: 'policy', metric: 'n' });
  assert.ok(r.ok && r.rows.p1.sum === 3);
});

// ── 内部任务-253：live 评测（内部验收-25）──
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AGENT_EVAL = resolve(import.meta.dirname, '..', 'agent-eval.mjs');
const GOV_CLI = resolve(import.meta.dirname, '..', 'governance-cli.mjs');
const SUBJ = 'sha256:' + 'a'.repeat(64);
const OTHER = 'sha256:' + 'b'.repeat(64);

function mkProj(cases, suffix = 's-live') {
  const root = mkdtempSync(join(tmpdir(), 'live-'));
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: suffix, caseSetVersion: 'v1', cases }, null, 2));
  return root;
}
const CASES = [
  { caseId: 'c1', subjectHash: SUBJ, events: [], oracles: [] },
  { caseId: 'c2', subjectHash: SUBJ, events: [], oracles: [] },
];
function writeAdapter(root, lines) {
  const p = join(root, 'adapter-live.mjs');
  writeFileSync(p, `import { readFileSync } from 'node:fs';\nreadFileSync(0, 'utf8');\n${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\n`, 'utf8');
  return p;
}
function envelope(overrides = {}) {
  return {
    schemaVersion: '1.0.0', adapter: 'stdio', capability: 'agent-eval', request: {},
    availability: 'available', externalEffects: [], correlation: { runId: 'r1', subjectDigest: null },
    result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'passed' }, { caseId: 'c2', status: 'passed' }] },
    ...overrides,
  };
}
function runLive(root, adapterPath, env = {}) {
  return spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json', '--subject-hash', SUBJ, '--live-adapter', adapterPath], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
}
const evalsDir = (root) => join(root, '.ai-governance', 'runtime', 'evals');
function evalFiles(root) { try { return readdirSync(evalsDir(root)); } catch { return []; } }

test('agent-eval live：单源判定（adapter passed+results failed→2＋预检 mismatch+adapter passed→1）', () => {
  const rootA = mkProj(CASES);
  try {
    const a = writeAdapter(rootA, [JSON.stringify(envelope({ result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'failed' }] } }))]);
    const rA = runLive(rootA, a);
    assert.equal(rA.status, 2, 'adapter passed 与 results failed 矛盾→fail-closed 退 2');
    const manifest = evalFiles(rootA).filter((f) => f.endsWith('-manifest.json'));
    assert.equal(manifest.length, 1, '只写 error manifest');
    const m = JSON.parse(readFileSync(join(evalsDir(rootA), manifest[0]), 'utf8'));
    assert.equal(m.failureKind, 'status_mismatch');
    assert.equal(m.transcriptDigest, null);
  } finally { rmSync(rootA, { recursive: true, force: true }); }
  const rootB = mkProj([{ ...CASES[0] }, { ...CASES[1], subjectHash: OTHER }]);
  try {
    const b = writeAdapter(rootB, [JSON.stringify(envelope())]);
    const rB = runLive(rootB, b);
    assert.equal(rB.status, 1, '预检 mismatch→unverified 退 1（不判 status_mismatch）');
  } finally { rmSync(rootB, { recursive: true, force: true }); }
});

test('agent-eval live：逐 case subjectHash 不匹配记 unverified', () => {
  const root = mkProj([{ ...CASES[0] }, { ...CASES[1], subjectHash: OTHER }]);
  try {
    const a = writeAdapter(root, [JSON.stringify(envelope())]);
    const r = runLive(root, a);
    assert.equal(r.status, 1);
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    assert.ok(reportFile, 'live report 须落盘');
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.cases.find((c) => c.caseId === 'c2').status, 'unverified');
    assert.equal(report.summary.unverified >= 1, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：空套件退 2 且不产报告', () => {
  const root = mkProj([]);
  try {
    const a = writeAdapter(root, [JSON.stringify(envelope())]);
    const r = runLive(root, a);
    assert.equal(r.status, 2);
    assert.deepEqual(evalFiles(root), [], '空套件不得产任何工件');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：report 与 manifest 权威落盘', () => {
  const root = mkProj(CASES);
  try {
    const a = writeAdapter(root, [JSON.stringify(envelope())]);
    const r = runLive(root, a);
    assert.equal(r.status, 0);
    const files = evalFiles(root);
    assert.equal(files.filter((f) => f.endsWith('-manifest.json')).length, 1);
    const reportFile = files.find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.mode, 'live');
    assert.equal(report.status, 'passed');
    assert.equal(report.summary.failed, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：transcript 工件与 digest 落盘', async () => {
  const root = mkProj(CASES);
  try {
    const a = writeAdapter(root, [
      JSON.stringify({ type: 'tool', name: 'Read', caseId: 'c1' }),
      JSON.stringify({ type: 'exit', code: 0, caseId: 'c2' }),
      JSON.stringify(envelope()),
    ]);
    const r = runLive(root, a);
    assert.equal(r.status, 0);
    const transcriptFile = evalFiles(root).find((f) => f.endsWith('-transcript.jsonl'));
    assert.ok(transcriptFile, 'transcript 工件须落盘');
    const { createHash } = await import('node:crypto');
    const digest = 'sha256:' + createHash('sha256').update(readFileSync(join(evalsDir(root), transcriptFile))).digest('hex');
    const manifestFile = evalFiles(root).find((f) => f.endsWith('-manifest.json'));
    const manifest = JSON.parse(readFileSync(join(evalsDir(root), manifestFile), 'utf8'));
    assert.equal(manifest.transcriptDigest, digest, 'manifest transcriptDigest 绑定脱敏后文件字节');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：transcript 损坏按受影响 case 记 failed', () => {
  const root = mkProj(CASES);
  try {
    const a = writeAdapter(root, ['oops-not-json', JSON.stringify(envelope())]);
    const r = runLive(root, a);
    assert.equal(r.status, 1);
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.ok(report.transcriptErrors.length > 0, 'transcriptErrors 须记录');
    assert.equal(report.cases.every((c) => c.status === 'failed'), true, '无法归属→全部已运行匹配 case failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：secret-like caseId 预检不落盘', () => {
  const root = mkProj(CASES);
  try {
    const secretCaseId = 'sk-' + 'A'.repeat(24);
    const a = writeAdapter(root, [
      JSON.stringify({ caseId: secretCaseId, text: 'x' }),
      JSON.stringify(envelope()),
    ]);
    const r = runLive(root, a);
    assert.equal(r.status, 0);
    const transcriptFile = evalFiles(root).find((f) => f.endsWith('-transcript.jsonl'));
    const content = readFileSync(join(evalsDir(root), transcriptFile), 'utf8');
    assert.equal(content.includes('sk-' + 'A'), false, 'secret-like caseId 整行不落盘');
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.transcriptErrors.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：脱敏残余命中拒绝落盘', () => {
  const root = mkProj(CASES);
  try {
    const a = writeAdapter(root, [JSON.stringify({ text: 'password=abcdefgh' }), JSON.stringify(envelope())]);
    const r = runLive(root, a, { DEV253_FORCE_REDACT_RESIDUAL: '1' });
    assert.equal(r.status, 2, '残余命中须拒写退 2');
    const files = evalFiles(root);
    assert.equal(files.some((f) => f.endsWith('-transcript.jsonl')), false, '不得落 transcript');
    assert.equal(files.some((f) => f.endsWith('.json') && !f.endsWith('-manifest.json')), false, '不得落 report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：failureKind 与 error manifest', () => {
  const root = mkProj(CASES);
  try {
    const p = join(root, 'adapter-live.mjs');
    writeFileSync(p, 'process.exit(3);\n', 'utf8');
    const r = runLive(root, p);
    assert.equal(r.status, 2, '非零退出→工具错误退 2');
    const files = evalFiles(root);
    const manifestFile = files.find((f) => f.endsWith('-manifest.json'));
    assert.ok(manifestFile, '只写 error manifest');
    const m = JSON.parse(readFileSync(join(evalsDir(root), manifestFile), 'utf8'));
    assert.equal(m.failureKind, 'adapter_nonzero_exit');
    assert.equal(m.transcriptDigest, null);
    assert.equal(m.status, 'tool-error');
    assert.equal(files.some((f) => f.endsWith('-transcript.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate：live 报告不改变 replay 判定（含缺 mode＋-live- 文件名 failed 仍阻断）', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-live-'));
  try {
    const run = (args, env = {}) => spawnSync(process.execPath, [GOV_CLI, '--project-root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(run(['init']).status, 0);
    const begin = JSON.parse(run(['run-begin', '--task-id', '内部任务-253']).stdout);
    assert.equal(run(['run-finalize', '--run-id', begin.runId, '--repo-head', 'h'.repeat(40), '--diff-digest', 'sha256:' + 'a'.repeat(64)]).status, 0);
    assert.equal(run(['approve', '--role', 'accountable', '--identity', 'dev253-reviewer', '--expires-at', '2099-01-01']).status, 0);
    assert.equal(run(['gate']).status, 0, '基线 gate 应通');
    const ed = join(root, '.ai-governance', 'runtime', 'evals');
    mkdirSync(ed, { recursive: true });
    // live failed 报告 + manifest：不改变 gate 判定
    writeFileSync(join(ed, 's-live-x.json'), JSON.stringify({ schemaVersion: '1.0.0', suiteId: 's', mode: 'live', status: 'failed', summary: { total: 1, passed: 0, failed: 1, unverified: 0, passRate: 0 } }) + '\n', 'utf8');
    writeFileSync(join(ed, 's-live-x-manifest.json'), JSON.stringify({ schemaVersion: '1.0.0', mode: 'live' }) + '\n', 'utf8');
    assert.equal(run(['gate']).status, 0, 'live failed 不得阻断 gate');
    // replay failed：仍阻断
    writeFileSync(join(ed, 's-replay-y.json'), JSON.stringify({ schemaVersion: '1.0.0', suiteId: 'r', mode: 'replay', status: 'failed', summary: { total: 1, passed: 0, failed: 1, unverified: 0, passRate: 0 } }) + '\n', 'utf8');
    const replayBlocked = run(['gate']);
    assert.equal(replayBlocked.status, 1, 'replay failed 仍阻断');
    assert.ok(replayBlocked.stdout.includes('TG-EVAL-FAILED'));
    rmSync(join(ed, 's-replay-y.json'));
    // 缺 mode＋-live- 文件名 failed：按 replay 处理，仍阻断（不得凭文件名排除）
    writeFileSync(join(ed, 'legacy-live-failed.json'), JSON.stringify({ schemaVersion: '1.0.0', suiteId: 'legacy', status: 'failed', summary: { total: 1, passed: 0, failed: 1, unverified: 0, passRate: 0 } }) + '\n', 'utf8');
    assert.equal(run(['gate']).status, 1, '缺 mode＋-live- 文件名 failed 仍须阻断');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-253 阶段复审补强（spawn/timeout/overflow/unparseable/invalid_envelope/脱敏语料/合并边界）──

function makeAdapterFile(root, body) {
  const p = join(root, 'adapter-live.mjs');
  writeFileSync(p, `import { readFileSync } from 'node:fs';\nreadFileSync(0, 'utf8');\n${body}\n`, 'utf8');
  return p;
}
function readEv(root, predicate) {
  const files = evalFiles(root).filter(predicate);
  return files.map((f) => ({ name: f, content: readFileSync(join(evalsDir(root), f), 'utf8') }));
}

test('agent-eval live：超时/输出上限/不可解析 → unverified 退 1（不伪装 passed）', () => {
  const rootT = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootT, 'setTimeout(() => {}, 5000);');
    const r = runLive(rootT, a, { DEV253_LIVE_TIMEOUT_MS: '150' });
    assert.equal(r.status, 1, '超时→unverified 退 1');
    const reportFile = evalFiles(rootT).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(rootT), reportFile), 'utf8'));
    assert.equal(report.status, 'unverified');
    assert.equal(report.failureKind, 'timeout');
  } finally { rmSync(rootT, { recursive: true, force: true }); }

  const rootO = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootO, "for (let i = 0; i < 2000; i++) console.log('x'.repeat(100));");
    const r = runLive(rootO, a, { DEV253_LIVE_MAX_OUTPUT_BYTES: '64' });
    assert.equal(r.status, 1, '输出超限→unverified 退 1');
    const reportFile = evalFiles(rootO).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    assert.equal(JSON.parse(readFileSync(join(evalsDir(rootO), reportFile), 'utf8')).failureKind, 'output_overflow');
  } finally { rmSync(rootO, { recursive: true, force: true }); }

  const rootU = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootU, "console.log('not-a-json-envelope');");
    const r = runLive(rootU, a);
    assert.equal(r.status, 1, '不可解析→unverified 退 1');
    const reportFile = evalFiles(rootU).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    assert.equal(JSON.parse(readFileSync(join(evalsDir(rootU), reportFile), 'utf8')).failureKind, 'unparseable_output');
  } finally { rmSync(rootU, { recursive: true, force: true }); }
});

test('agent-eval live：invalid_envelope 只写 error manifest 且 stdout 不回显诊断值', () => {
  const root = mkProj(CASES);
  try {
    const secretLike = 'sk-' + 'Z'.repeat(24);
    // 合法 JSON 但非信封（缺 result 等），adapter 名带 secret 样值——诊断内插值不得原样 emit
    const a = makeAdapterFile(root, `console.log(JSON.stringify({ adapter: ${JSON.stringify(secretLike)}, capability: 'bogus', status: 'passed' }));`);
    const r = runLive(root, a);
    assert.equal(r.status, 2, '信封非法→工具错误退 2');
    assert.equal(r.stdout.includes(secretLike), false, 'stdout 不得回显诊断内插值');
    const files = evalFiles(root);
    assert.equal(files.filter((f) => f.endsWith('-manifest.json')).length, 1, '只写 error manifest');
    assert.equal(files.some((f) => f.endsWith('-transcript.jsonl')), false);
    const m = JSON.parse(readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-manifest.json'))), 'utf8'));
    assert.equal(m.failureKind, 'invalid_envelope');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：五类秘密语料端到端零泄漏（report/manifest/transcript）', () => {
  const root = mkProj(CASES);
  try {
    const secrets = ['password=abcdefgh', 'AKIA' + 'Q'.repeat(16), 'Authorization: Bearer ' + 'B'.repeat(24), 'ghp_' + 'C'.repeat(36), '-----BEGIN PRIVATE KEY-----'];
    const lines = secrets.map((s, i) => JSON.stringify({ caseId: i === 0 ? 'c1' : 'c2', type: 'log', text: s }));
    const a = makeAdapterFile(root, lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n') + '\n' + `console.log(${JSON.stringify(JSON.stringify(envelope()))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 0);
    const files = evalFiles(root);
    for (const f of files) {
      const content = readFileSync(join(evalsDir(root), f), 'utf8');
      for (const s of secrets) assert.equal(content.includes(s), false, `${f} 泄漏原始秘密：${s}`);
    }
    const transcript = readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-transcript.jsonl'))), 'utf8');
    for (const line of transcript.split('\n').filter((l) => l.trim())) JSON.parse(line); // 仍可解析
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：transcript 对象级脱敏后仍可解析且 caseId 保留', () => {
  const root = mkProj(CASES);
  try {
    const evt = { caseId: 'c1', type: 'tool', nested: { token: 'ghp_' + 'D'.repeat(36), note: 'ok' } };
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(evt))});\nconsole.log(${JSON.stringify(JSON.stringify(envelope()))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 0);
    const transcriptFile = evalFiles(root).find((f) => f.endsWith('-transcript.jsonl'));
    const lines = readFileSync(join(evalsDir(root), transcriptFile), 'utf8').split('\n').filter((l) => l.trim());
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.caseId, 'c1', 'caseId 保留');
    assert.equal(JSON.stringify(parsed).includes('ghp_' + 'D'), false, '嵌套对象内秘密被脱敏');
    assert.equal(parsed.nested.note, 'ok', '非秘密字段保留');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：results 合并边界（未知 caseId/缺 result/无 results）', () => {
  // 未知 caseId：忽略并记 transcriptErrors，不影响判定
  const rootX = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootX, `console.log(${JSON.stringify(JSON.stringify(envelope({ result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'passed' }, { caseId: 'c2', status: 'passed' }, { caseId: 'zzz', status: 'failed' }] } })))});`);
    const r = runLive(rootX, a);
    assert.equal(r.status, 0, 'suite 外 caseId 忽略');
    const reportFile = evalFiles(rootX).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(rootX), reportFile), 'utf8'));
    assert.ok(report.transcriptErrors.some((e) => /suite 外/.test(e.reason)));
  } finally { rmSync(rootX, { recursive: true, force: true }); }

  // 缺 result：该 case unverified → 退 1
  const rootM = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootM, `console.log(${JSON.stringify(JSON.stringify(envelope({ result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'passed' }] } })))});`);
    const r = runLive(rootM, a);
    assert.equal(r.status, 1, '缺 result→unverified');
    const reportFile = evalFiles(rootM).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(rootM), reportFile), 'utf8'));
    assert.equal(report.cases.find((c) => c.caseId === 'c2').status, 'unverified');
  } finally { rmSync(rootM, { recursive: true, force: true }); }

  // 无 results：summary-only，全部匹配 case unverified → 退 1
  const rootN = mkProj(CASES);
  try {
    const a = makeAdapterFile(rootN, `console.log(${JSON.stringify(JSON.stringify(envelope({ result: { status: 'passed', summary: 'ok' } })))});`);
    const r = runLive(rootN, a);
    assert.equal(r.status, 1);
    const reportFile = evalFiles(rootN).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(rootN), reportFile), 'utf8'));
    assert.equal(report.caseCoverage, 'adapter-summary-only');
    assert.equal(report.cases.every((c) => c.status === 'unverified'), true);
  } finally { rmSync(rootN, { recursive: true, force: true }); }
});

test('agent-eval live：status 矛盾反方向（failed+全 passed→2）', () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope({ result: { status: 'failed', summary: 'bad', results: [{ caseId: 'c1', status: 'passed' }, { caseId: 'c2', status: 'passed' }] } })))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 2, 'adapter failed 与 results 全 passed 矛盾→fail-closed 退 2');
    const files = evalFiles(root);
    const m = JSON.parse(readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-manifest.json'))), 'utf8'));
    assert.equal(m.failureKind, 'status_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-253 三维评审补强（capability/availability/damage/重复/SchemaError）──

test('agent-eval live：capability 握手不符 → unverified 退 1（不判 passed）', () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope({ capability: 'ci' })))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 1, 'capability 不匹配不得判 passed');
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.status, 'unverified');
    assert.equal(report.failureKind, 'capability_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：availability 落盘且不等于 available 时判 unverified（审计可复算）', () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope({ availability: 'degraded' })))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 1);
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.availability, 'degraded', 'report 必含 availability');
    assert.equal(report.status, 'unverified');
    assert.equal(report.summary.failed, 0, 'results 均 passed 但 availability 降级 → unverified 优先');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：损坏行 caseId 指向预检 mismatch 项时不扩散至匹配 case', () => {
  const root = mkProj([{ ...CASES[0] }, { ...CASES[1], subjectHash: OTHER }]);
  try {
    // 第 1 行损坏且含预检 mismatch 的 caseId c2；第 2 行信封声明 passed + results 均 passed
    const a = makeAdapterFile(root, `console.log('broken line {\"caseId\":\"c2\"}');
console.log(${JSON.stringify(JSON.stringify(envelope()))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 1, 'c2 预检 unverified → 退 1；不得把 c1 也记 failed');
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    assert.equal(report.cases.find((c) => c.caseId === 'c1').status, 'passed', '匹配 case 不被误伤');
    assert.equal(report.cases.find((c) => c.caseId === 'c2').status, 'unverified');
    assert.ok(report.transcriptErrors.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：重复 caseId 且状态矛盾 → fail-closed 退 2', () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope({ result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'failed' }, { caseId: 'c1', status: 'passed' }, { caseId: 'c2', status: 'passed' }] } })))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 2, '重复 caseId 矛盾输出 fail-closed');
    const files = evalFiles(root);
    const m = JSON.parse(readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-manifest.json'))), 'utf8'));
    assert.equal(m.failureKind, 'status_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval replay：oracle schema 含 $ref → 工具错误退 2（SchemaError 语义）', () => {
  const root = mkProj([{ caseId: 'c1', subjectHash: SUBJ, events: [{ json: { id: 'R-1' } }], oracles: [{ kind: 'json-schema', schema: { $ref: '#/x' } }] }]);
  try {
    const r = spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json', '--subject-hash', SUBJ], { encoding: 'utf8' });
    assert.equal(r.status, 2, 'replay oracle schema 越界 → 工具错误退 2');
    assert.ok(/受控子集|schema/.test(r.stderr), 'stderr 应有可读原因');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-253 fix-review 补强（adapterExitCode/integrityHash/capability+矛盾/stdio 契约）──

test('agent-eval live：非零退出 error manifest 记录真实 adapterExitCode', () => {
  const root = mkProj(CASES);
  try {
    const p2 = join(root, 'adapter-live.mjs');
    writeFileSync(p2, 'process.exit(7);' + String.fromCharCode(10), 'utf8');
    const r = runLive(root, p2);
    assert.equal(r.status, 2);
    const files = evalFiles(root);
    const m = JSON.parse(readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-manifest.json'))), 'utf8'));
    assert.equal(m.adapterExitCode, 7, 'error manifest 须记录真实退出码（非 null/undefined）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：落盘 report 的 integrityHash 可按 verifyReport 口径复算', async () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope()))});`);
    assert.equal(runLive(root, a).status, 0);
    const reportFile = evalFiles(root).find((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'));
    const report = JSON.parse(readFileSync(join(evalsDir(root), reportFile), 'utf8'));
    const recorded = report.integrityHash;
    const body = { ...report };
    delete body.integrityHash;
    const { integrityHash } = await import('../lib/canonical-json.mjs');
    assert.equal(integrityHash(body), recorded, '去除 integrityHash 后 canonical 重算须一致');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval live：capability 握手不符与 results 矛盾并存 → mismatch 优先退 2', () => {
  const root = mkProj(CASES);
  try {
    const a = makeAdapterFile(root, `console.log(${JSON.stringify(JSON.stringify(envelope({ capability: 'ci', result: { status: 'passed', summary: 'ok', results: [{ caseId: 'c1', status: 'failed' }, { caseId: 'c2', status: 'passed' }] } })))});`);
    const r = runLive(root, a);
    assert.equal(r.status, 2, 'IF §4：mismatch 仲裁优先于 capability 归因');
    const files = evalFiles(root);
    const m = JSON.parse(readFileSync(join(evalsDir(root), files.find((f) => f.endsWith('-manifest.json'))), 'utf8'));
    assert.equal(m.failureKind, 'status_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-254 批 2（H1/H8：内部验收-21/内部验收-1）──

test('eval 报告 integrityHash 复核（篡改/缺失 body→TG-EVAL-TAMPERED blocking）', () => {
  const body = { schemaVersion: '1.0.0', suiteId: 's1', caseSetVersion: 'v1', subjectHash: SUBJ, mode: 'replay',
    cases: [], summary: { total: 0, passed: 0, failed: 0, unverified: 0, passRate: null } };
  const good = { ...body, integrityHash: integrityHash(body) };
  const clean = buildReport({ evals: [good] });
  assert.equal(clean.blockingCount, 0, '完整报告零阻断');
  assert.ok(!clean.report.diagnostics.some((d) => d.ruleId === 'TG-EVAL-TAMPERED'));
  // 篡改 body（保留旧 integrityHash）→ blocking
  const tampered = { ...body, summary: { ...body.summary, failed: 1 }, integrityHash: integrityHash(body) };
  const t = buildReport({ evals: [tampered] });
  assert.ok(t.report.diagnostics.some((d) => d.ruleId === 'TG-EVAL-TAMPERED' && d.severity === 'blocking'),
    '篡改须 TG-EVAL-TAMPERED blocking');
  // 缺失 / 空串 / 不可复算 → 同判 blocking（fail-closed）
  for (const bad of [{ ...body }, { ...body, integrityHash: '' }, { ...body, integrityHash: 'sha256:' + '0'.repeat(64) }]) {
    const r = buildReport({ evals: [bad] });
    assert.ok(r.report.diagnostics.some((d) => d.ruleId === 'TG-EVAL-TAMPERED' && d.severity === 'blocking'),
      '缺/空/不可复算 integrityHash 均 fail-closed');
  }
  // CLI e2e：磁盘上篡改报告 → gate 退 1 含 TG-EVAL-TAMPERED
  const root = mkProj([]);
  try {
    assert.equal(spawnSync(process.execPath, [GOV_CLI, '--project-root', root, 'init'], { encoding: 'utf8' }).status, 0);
    const dir = join(root, '.ai-governance', 'runtime', 'evals');
    mkdirSync(dir, { recursive: true });
    const diskBody = { ...body, suiteId: 's-disk' };
    writeFileSync(join(dir, 's-disk-2026.json'), JSON.stringify({ ...diskBody, summary: { ...diskBody.summary, unverified: 3 } }), 'utf8');
    const gate = spawnSync(process.execPath, [GOV_CLI, '--project-root', root, 'gate'], { encoding: 'utf8' });
    assert.equal(gate.status, 1, `篡改 eval 报告 → gate 退 1（实测 ${gate.status}：${gate.stderr}）`);
    const out = JSON.parse(gate.stdout);
    assert.ok(out.diagnostics.some((d) => d.ruleId === 'TG-EVAL-TAMPERED'), 'gate 输出点名 TG-EVAL-TAMPERED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval replay：空 cases/缺字段/未知 oracle kind 响亮失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-shape-'));
  try {
    const writeSuite = (o) => writeFileSync(join(root, 'suite.json'), JSON.stringify(o), 'utf8');
    const run = () => spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json',
      '--subject-hash', SUBJ], { encoding: 'utf8' });
    const produced = () => { try { return readdirSync(join(root, '.ai-governance', 'runtime', 'evals')); } catch { return []; } };
    // 空 cases → 退 2 不产报告
    writeSuite({ suiteId: 's-empty', caseSetVersion: 'v1', cases: [] });
    let r = run();
    assert.equal(r.status, 2, '空 cases 退 2');
    assert.equal(produced().length, 0, '空 cases 不产报告');
    // 缺字段（case 缺 subjectHash）→ 退 2（无栈）
    writeSuite({ suiteId: 's-miss', caseSetVersion: 'v1', cases: [{ caseId: 'c1', events: [], oracles: [{ kind: 'exact', value: 'x' }] }] });
    r = run();
    assert.equal(r.status, 2, '缺字段退 2');
    assert.equal(produced().length, 0, '缺字段不产报告');
    assert.ok(!String(r.stderr).includes(' at '), '无裸堆栈帧');
    // 未知 oracle kind → 退 2 且 stderr 点名 kind
    writeSuite({ suiteId: 's-kind', caseSetVersion: 'v1', cases: [{ caseId: 'c1', subjectHash: SUBJ,
      events: [{ text: 'x' }], oracles: [{ kind: 'quantum-oracle' }] }] });
    r = run();
    assert.equal(r.status, 2, '未知 oracle kind 退 2');
    assert.ok(String(r.stderr).includes('quantum-oracle'), 'stderr 点名未知 kind');
    assert.equal(produced().length, 0, '未知 kind 不产报告');
    // 正常路径零回归
    writeSuite({ suiteId: 's-ok', caseSetVersion: 'v1', cases: [{ caseId: 'c1', subjectHash: SUBJ,
      events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: 'ok' }] }] });
    r = run();
    assert.equal(r.status, 0, `正常 replay 退 0：${r.stderr}`);
    assert.ok(produced().length > 0, '正常路径权威报告落盘');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('eval 报告完整性往返：agent-eval 产报告 → gate 退 0（无 TG-EVAL-TAMPERED）', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-roundtrip-'));
  try {
    assert.equal(spawnSync(process.execPath, [GOV_CLI, '--project-root', root, 'init'], { encoding: 'utf8' }).status, 0);
    const suite = { suiteId: 's-rt', caseSetVersion: 'v1',
      cases: [{ caseId: 'c1', subjectHash: SUBJ, events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: 'ok' }] }] };
    writeFileSync(join(root, 'suite.json'), JSON.stringify(suite), 'utf8');
    const evalRun = spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json',
      '--subject-hash', SUBJ], { encoding: 'utf8' });
    assert.equal(evalRun.status, 0, `agent-eval 应通过：${evalRun.stderr}`);
    const gate = spawnSync(process.execPath, [GOV_CLI, '--project-root', root, 'gate'], { encoding: 'utf8' });
    assert.equal(gate.status, 0, `生产报告经 gate 应退 0：${gate.stderr}`);
    const out = JSON.parse(gate.stdout);
    assert.equal(out.coverage.evals, 'loaded', 'gate 实际消费 eval 报告');
    assert.ok(!out.diagnostics.some((d) => d.ruleId === 'TG-EVAL-TAMPERED'), '生产报告不得误判篡改');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-255 批 3（H12/H13：内部验收-1/内部验收-25）──

test('persistEvalReport：suiteId 路径越界拒绝且零文件（H13 回归锁）', async () => {
  const { persistEvalReport } = await import('../lib/governance-store.mjs');
  const root = mkdtempSync(join(tmpdir(), 'eval-suiteid-'));
  try {
    const dir = join(root, '.ai-governance', 'runtime', 'evals');
    const report = { schemaVersion: '1.0.0', suiteId: '../evil', caseSetVersion: 'v1', subjectHash: SUBJ, mode: 'replay', cases: [],
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, passRate: null } };
    for (const bad of ['../evil', 'a/b', 'C:x', '..\\x']) {
      assert.throws(() => persistEvalReport(root, { ...report, suiteId: bad }), /suiteId 非法/, `应拒 ${bad}`);
    }
    assert.ok(!existsSync(dir), '越界 suiteId 不得创建任何文件');
    const okReport = { ...report, suiteId: 's-ok' };
    const ok = persistEvalReport(root, { ...okReport, integrityHash: integrityHash(okReport) });
    assert.equal(ok.ok, true, '合法 suiteId 返回 ok');
    assert.ok(ok.path.includes('s-ok'), '落盘路径含 suiteId');
    assert.ok(existsSync(join(root, ok.path)), '合法 suiteId 正常落盘');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persistEvalReport：入参 integrityHash 不符拒写（H1 信号保留）', async () => {
  const { persistEvalReport } = await import('../lib/governance-store.mjs');
  const root = mkdtempSync(join(tmpdir(), 'eval-h1-'));
  try {
    const report = { schemaVersion: '1.0.0', suiteId: 's-x', caseSetVersion: 'v1', subjectHash: SUBJ, mode: 'replay', cases: [],
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, passRate: null }, integrityHash: 'sha256:' + '0'.repeat(64) };
    assert.throws(() => persistEvalReport(root, report), /integrityHash 与 body 不符/, '不符须拒写');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval replay：报告落盘脱敏且 integrityHash 于脱敏后重算（H12）', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-replay-redact-'));
  try {
    writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: 's-redact', caseSetVersion: 'v1', cases: [{
      caseId: 'c1', subjectHash: SUBJ, events: [{ text: 'x AKIAIOSFODNN7EXAMPLE' }], oracles: [{ kind: 'exact', value: 'AKIAIOSFODNN7EXAMPLE' }] }] }));
    const r = spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json', '--subject-hash', SUBJ], { encoding: 'utf8' });
    assert.equal(r.status, 0, `replay 应退 0：${r.stderr}`);
    const files = evalFiles(root).filter((f) => f.endsWith('.json'));
    const text = readFileSync(join(evalsDir(root), files[0]), 'utf8');
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), '落盘报告不得含明文秘密');
    const report = JSON.parse(text);
    const body = { ...report };
    delete body.integrityHash;
    assert.equal(integrityHash(body), report.integrityHash, 'integrityHash 于脱敏后重算');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-eval replay：脱敏后残余命中拒写（DEV255_FORCE_REDACT_RESIDUAL）', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-replay-residual-'));
  try {
    writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: 's-residual', caseSetVersion: 'v1', cases: [{
      caseId: 'c1', subjectHash: SUBJ, events: [{ text: 'x' }], oracles: [{ kind: 'exact', value: 'AKIAIOSFODNN7EXAMPLE' }] }] }));
    const r = spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json', '--subject-hash', SUBJ],
      { encoding: 'utf8', env: { ...process.env, DEV255_FORCE_REDACT_RESIDUAL: '1' } });
    assert.equal(r.status, 2, `残余命中应退 2（实测 ${r.status}：${r.stderr}）`);
    assert.equal(evalFiles(root).length, 0, '残余命中不得产报告');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persistEvalReport：脱敏残余拒写不留空目录', async () => {
  const { persistEvalReport } = await import('../lib/governance-store.mjs');
  const root = mkdtempSync(join(tmpdir(), 'eval-resid-dir-'));
  const prev = process.env.DEV255_FORCE_REDACT_RESIDUAL;
  try {
    const raw = { schemaVersion: '1.0.0', suiteId: 's-resid', caseSetVersion: 'v1', subjectHash: SUBJ,
      mode: 'replay', cases: [], summary: { total: 0, passed: 0, failed: 0, unverified: 0, passRate: null }, note: 'token=abcdef123456' };
    const report = { ...raw, integrityHash: integrityHash(raw) };
    process.env.DEV255_FORCE_REDACT_RESIDUAL = '1';
    assert.throws(() => persistEvalReport(root, report), /脱敏后仍检出秘密/);
  } finally {
    if (prev === undefined) delete process.env.DEV255_FORCE_REDACT_RESIDUAL;
    else process.env.DEV255_FORCE_REDACT_RESIDUAL = prev;
  }
  try {
    assert.ok(!existsSync(join(root, '.ai-governance', 'runtime', 'evals')), '残余拒写不得创建 evals 目录（mkdir 在脱敏后）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

