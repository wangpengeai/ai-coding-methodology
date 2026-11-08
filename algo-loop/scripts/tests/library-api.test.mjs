// 文件：library-api.test.mjs
// 描述：algo-loop 库层 API 与钩子纯函数覆盖（内部任务-269 覆盖率补测）——validate*/explain*/readJsonFile、
//       algo-state 用法面，以及 session-start 导出的 projectRoot/summaryLines/repairLines/envelope/main
//       （进程内直调，不 spawn，保证覆盖率计入父进程；内部决策-064 决策 4）。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/library-api.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BADCASE_STATUSES,
  LEDGER_DECISIONS,
  explainBadcase,
  explainBaselines,
  explainContract,
  explainLedgerRow,
  explainProject,
  readJsonFile,
  usage,
  validateBadcase,
  validateBaselines,
  validateContract,
  validateLedgerRow,
  validateProject,
} from '../algo-state.mjs';
import { envelope, main, projectRoot, repairLines, summaryLines } from '../../hooks/session-start.mjs';

const VALID_METRIC = { name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'x', version: 'v1' } };
const VALID_PROJECT = { schemaVersion: 1, projectId: 'p', contractVersion: 1 };
const VALID_CONTRACT = { schemaVersion: 1, version: 1, metrics: [VALID_METRIC], baselineRef: 'b0', targets: {}, guardrails: [] };
const VALID_BASELINES = { schemaVersion: 1, entries: [{ id: 'b0', at: '2026-10-01T00:00:00Z', metrics: { m: 1 }, fromIteration: '', reason: 'init' }] };
const VALID_BADCASE = { id: 'c1', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }], status: '待归因' };
const VALID_ROW = { id: 'i1', at: '2026-10-01T00:00:00Z', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' };

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-libapi-'));
  roots.push(root);
  return root;
}

function captureStdout(fn) {
  const prev = process.stdout.write;
  let out = '';
  // 非 string 块＝测试运行器协议帧，必须原样转发回原 stream（R11 同型；吞帧会丢测试事件）
  process.stdout.write = (chunk, encoding, callback) => {
    if (typeof chunk === 'string') {
      out += chunk;
      return true;
    }
    return prev.call(process.stdout, chunk, encoding, callback);
  };
  try {
    fn();
  } finally {
    process.stdout.write = prev;
  }
  return out;
}

test('validate* 布尔适配器：合法为真、非法为假（五件 + 台账行）', () => {
  assert.equal(validateProject(VALID_PROJECT), true);
  assert.equal(validateProject({ schemaVersion: 2 }), false);
  assert.equal(validateContract(VALID_CONTRACT), true);
  assert.equal(validateContract({ schemaVersion: 1, version: 1, metrics: [] }), false);
  assert.equal(validateBaselines(VALID_BASELINES), true);
  assert.equal(validateBaselines({ schemaVersion: 1, entries: [null] }), false);
  assert.equal(validateBadcase(VALID_BADCASE), true);
  assert.equal(validateBadcase({ id: 'c1' }), false);
  assert.equal(validateLedgerRow(VALID_ROW), true);
  assert.equal(validateLedgerRow({ id: 'i1' }), false);
});

test('explain* 字段级诊断：非对象/缺字段/枚举值域给出可读错误', () => {
  assert.ok(explainProject(null).length > 0);
  assert.ok(explainContract('x').length > 0);
  assert.ok(explainContract({ ...VALID_CONTRACT, metrics: [{ ...VALID_METRIC, direction: 'up' }] }).some((e) => e.includes('direction')));
  assert.ok(explainBaselines({ schemaVersion: 1, entries: [{}] }).some((e) => e.includes('entries[0]')));
  assert.ok(explainBadcase({ ...VALID_BADCASE, status: 'nope' }).some((e) => e.includes('status')));
  assert.ok(explainLedgerRow({ ...VALID_ROW, decision: 'nope' }).some((e) => e.includes('decision')));
  assert.equal(BADCASE_STATUSES.length, 4);
  assert.deepEqual(LEDGER_DECISIONS, ['continue', 'rollback', 'raise-baseline', 'to-release']);
});

test('readJsonFile 三态：缺失 / 不可解析 / 不可读（目录）', () => {
  const root = makeRoot();
  const missing = readJsonFile(join(root, 'none.json'));
  assert.equal(missing.present, false);
  assert.equal(missing.error, 'missing');
  const broken = join(root, 'broken.json');
  writeFileSync(broken, '{oops');
  const unparsable = readJsonFile(broken);
  assert.equal(unparsable.present, true);
  assert.equal(unparsable.ok, false);
  assert.match(unparsable.error, /不可解析/);
  const dir = join(root, 'as-dir');
  mkdirSync(dir);
  const unreadable = readJsonFile(dir);
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.error, /不可读/);
  const okFile = join(root, 'ok.json');
  writeFileSync(okFile, '{"a":1}');
  assert.deepEqual(readJsonFile(okFile).value, { a: 1 });
});

test('algo-state usage 面：输出用法说明', () => {
  const prevErr = console.error;
  let text = '';
  console.error = (...parts) => {
    text += parts.join(' ');
  };
  try {
    usage();
  } finally {
    console.error = prevErr;
  }
  assert.match(text, /用法/);
});

test('session-start projectRoot：环境变量优先级（ZCODE > QODER > CLAUDE > cwd）', () => {
  const prev = {
    z: process.env.ZCODE_PROJECT_DIR,
    q: process.env.QODER_CWD,
    c: process.env.CLAUDE_PROJECT_DIR,
  };
  try {
    // 内部任务-331（round 4 delta）：低档位断言前须清高档位键——宿主会话自带 ZCODE_PROJECT_DIR/QODER_CWD
    // 会按优先级链（ZCODE > QODER > CLAUDE > cwd）抢先，使 CLAUDE 档断言击穿；还原骨架（finally）不变。
    delete process.env.ZCODE_PROJECT_DIR;
    delete process.env.QODER_CWD;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/claude-dir';
    assert.equal(projectRoot(), '/tmp/claude-dir');
    process.env.QODER_CWD = '/tmp/qoder-dir';
    assert.equal(projectRoot(), '/tmp/qoder-dir');
    process.env.ZCODE_PROJECT_DIR = '/tmp/zcode-dir';
    assert.equal(projectRoot(), '/tmp/zcode-dir');
  } finally {
    for (const [key, val] of [['ZCODE_PROJECT_DIR', prev.z], ['QODER_CWD', prev.q], ['CLAUDE_PROJECT_DIR', prev.c]]) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
});

test('session-start summaryLines/repairLines/envelope：四要素与字段级报修（含退化分支）', () => {
  const base = {
    contractVersion: 1,
    currentBaseline: { id: 'b0', metrics: { m: 1 } },
    openBadcases: 2,
    lastIterationAgeDays: 3,
    corrupt: [],
    corruptDetails: [],
    badLines: 0,
    present: true,
    reason: '',
  };
  const text = summaryLines(base).join('\n');
  assert.match(text, /指标契约版本：v1/);
  assert.match(text, /当前基线：b0/);
  assert.match(text, /未闭环 bad case：2/);
  assert.match(text, /距上次迭代：3 天/);

  const corruptBaselines = summaryLines({ ...base, currentBaseline: null, corrupt: ['baselines.json'] }).join('\n');
  assert.match(corruptBaselines, /baselines 损坏/);
  const emptyBaselines = summaryLines({ ...base, currentBaseline: null, corrupt: [] }).join('\n');
  assert.match(emptyBaselines, /未登记/);
  const badLinesNoRows = summaryLines({ ...base, lastIterationAgeDays: null, badLines: 2 }).join('\n');
  assert.match(badLinesNoRows, /台账无可解析行/);
  const emptyLedger = summaryLines({ ...base, lastIterationAgeDays: null, badLines: 0 }).join('\n');
  assert.match(emptyLedger, /尚无台账行/);

  const repair = repairLines({ corrupt: ['contract.json', 'ledger.jsonl'], corruptDetails: [{ file: 'contract.json', errors: ['metrics 须为非空数组'] }] }).join('\n');
  assert.match(repair, /contract\.json：metrics/);
  assert.match(repair, /- ledger\.jsonl\n/);
  assert.match(repair, /不自动修/);

  const captured = captureStdout(() => envelope('hello-context'));
  const parsed = JSON.parse(captured.trim());
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'hello-context');
});

test('session-start main（可注入 root）：absent 静默 / corrupt 报修 / 合法摘要注入', async () => {
  const absentRoot = makeRoot();
  const absentOut = captureStdout(() => {});
  assert.equal(absentOut, '');
  await main(absentRoot); // absent：无输出、不抛
  const corruptRoot = makeRoot();
  const algo = join(corruptRoot, '.algo');
  mkdirSync(join(algo, 'badcases'), { recursive: true });
  writeFileSync(join(algo, 'project.json'), '{broken');
  writeFileSync(join(algo, 'contract.json'), '{}');
  writeFileSync(join(algo, 'ledger.jsonl'), '');
  writeFileSync(join(algo, 'baselines.json'), '{}');
  let out = '';
  const prev = process.stdout.write;
  // 同上：非 string 运行器帧原样转发（否则 await main 期间帧被吞）
  process.stdout.write = (chunk, encoding, callback) => {
    if (typeof chunk === 'string') {
      out += chunk;
      return true;
    }
    return prev.call(process.stdout, chunk, encoding, callback);
  };
  try {
    await main(corruptRoot);
  } finally {
    process.stdout.write = prev;
  }
  assert.match(out, /project\.json/);
});

test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
