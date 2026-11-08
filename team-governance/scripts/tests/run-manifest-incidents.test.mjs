// 文件：run-manifest-incidents.test.mjs
// 描述：governance-cli 拉取联动的 TDD 测试（内部模块-15/内部决策-019，内部规则-6）——run-finalize
//       自动读取项目根 内部工作流状态 把 open 自察异常 digest 注入
//       manifest evidenceReferences（--evidence-ref 显式传入优先）；learning-note
//       子命令经 promoteLearning 首进 observed 并落 learning-store。文件缺失按
//       无异常处理（内部接口-2 诚实降级同款）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；CLI 子进程契约整进程验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli as runCliShared } from './helpers.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'governance-cli.mjs');

// 内部任务-337（内部未决-223）：cli 收口为 helpers.runCli 一行薄包装（8 调用点零改）。
/** 以子进程运行 governance-cli，返回解析后的 JSON 与原始输出。 */
function cli(root, args, env = {}) {
  return runCliShared(CLI, root, args, { env });
}

/** 开 run 并返回 runId（run-begin 走真实 preflight：先播内联 relaxed 政策，内部任务-5 C）。 */
function beginRun(root) {
  mkdirSync(join(root, '.ai-governance'), { recursive: true });
  const configPath = join(root, '.ai-governance', 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: '1.0.0',
      policy: { id: 'default', version: 1, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      requiredDomains: [], createdAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  }
  const r = cli(root, ['run-begin', '--task-id', '内部任务-内部模块-15']);
  assert.equal(r.status, 0, `run-begin 失败：${r.stderr}`);
  return r.json.runId;
}

/** 预置项目根自察记录文件。 */
function seedIncidents(root, records) {
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'incidents.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const openRec = (id, digest, status = 'open') => ({
  schemaVersion: 1, id, ts: Date.now(), session: 's', kind: 'tool-failure', digest, status,
});

test('run-finalize 自动拉取：open 记录 digest 进 evidenceReferences，resolved 不进', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-incidents-'));
  try {
    const runId = beginRun(root);
    seedIncidents(root, [openRec('ri-a', 'aaaa111111111111'), openRec('ri-b', 'bbbb222222222222'), openRec('ri-c', 'cccc333333333333', 'resolved')]);
    const r = cli(root, ['run-finalize', '--run-id', runId, '--repo-head', 'h1', '--diff-digest', 'd1']);
    assert.equal(r.status, 0, `finalize 失败：${r.stderr}`);
    const refs = r.json.evidenceReferences ?? [];
    assert.ok(refs.some((x) => String(x).includes('aaaa111111111111')), `open digest 应入 refs（收到：${JSON.stringify(refs)}）`);
    assert.ok(refs.some((x) => String(x).includes('bbbb222222222222')));
    assert.ok(!refs.some((x) => String(x).includes('cccc333333333333')), 'resolved 不入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无 incidents 文件：evidenceReferences 为空数组（诚实降级，非错误）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-incidents-'));
  try {
    const runId = beginRun(root);
    const r = cli(root, ['run-finalize', '--run-id', runId, '--repo-head', 'h1', '--diff-digest', 'd1']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.json.evidenceReferences ?? [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--evidence-ref 显式传入优先于自动拉取', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-incidents-'));
  try {
    const runId = beginRun(root);
    seedIncidents(root, [openRec('ri-a', 'aaaa111111111111')]);
    const r = cli(root, [
      'run-finalize', '--run-id', runId, '--repo-head', 'h1', '--diff-digest', 'd1',
      '--evidence-ref', 'manual-ref-1', '--evidence-ref', 'manual-ref-2',
    ]);
    assert.equal(r.status, 0, `finalize 失败：${r.stderr}`);
    assert.deepEqual(r.json.evidenceReferences, ['manual-ref-1', 'manual-ref-2'], '显式传入时不叠加自动拉取');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('learning-note：promoteLearning 首进 observed 并落 learning-store（证据指向 incident）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lnote-'));
  try {
    seedIncidents(root, [openRec('ri-note', 'note1111111111111')]);
    const r = cli(root, ['learning-note', '--statement', '发布清缓存前须保留旧版本目录', '--incident', 'ri-note', '--owner', 'wangp']);
    assert.equal(r.status, 0, `learning-note 失败：${r.stderr}`);
    assert.equal(r.json.status, 'observed');
    const file = join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl');
    assert.ok(existsSync(file), 'observed 落盘');
    const rec = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
    assert.equal(rec.statement, '发布清缓存前须保留旧版本目录');
    assert.equal(rec.sourceIncidentId, 'ri-note');
    assert.ok(rec.evidenceReferences.length > 0, 'observed 也要有证据指向');
    // 悬空证据拒绝（评审 R-8）：--incident 指向不存在的记录 → EXIT_CONTENT
    const bad = cli(root, ['learning-note', '--statement', 'x', '--incident', 'ri-not-exist']);
    assert.equal(bad.status, 1, '悬空 incident id 应退 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-255 批 3（H12：内部验收-24）──

test('learning-note：observed 落盘与 stdout 脱敏', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lnote-redact-'));
  try {
    seedIncidents(root, [openRec('ri-secret', 'secret11111111111')]);
    const r = cli(root, ['learning-note', '--statement', 'token=abcdef123456 泄漏样例', '--incident', 'ri-secret', '--owner', 'wangp']);
    assert.equal(r.status, 0, `learning-note 失败：${r.stderr}`);
    const file = join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('token=abcdef123456'), 'observed 落盘不得含明文秘密');
    assert.ok(!r.stdout.includes('token=abcdef123456'), 'stdout 不得含明文秘密');
    assert.ok(r.stdout.includes('<redacted:'), 'stdout 须显示脱敏占位');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('learning-note：脱敏后残余命中拒写（DEV255_FORCE_REDACT_RESIDUAL）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lnote-residual-'));
  try {
    seedIncidents(root, [openRec('ri-residual', 'residual111111111')]);
    const r = cli(root, ['learning-note', '--statement', 'token=abcdef123456', '--incident', 'ri-residual'], { DEV255_FORCE_REDACT_RESIDUAL: '1' });
    assert.equal(r.status, 2, `残余命中应工具错退 2（实测 ${r.status}：${r.stderr}）`);
    const file = join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl');
    assert.ok(!existsSync(file), '残余命中不得落盘（零新增行）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-257（P5-4）──
test('incident-source：文件存在但不可读 → unavailable（不冒充无异常）', async () => {
  const fs = await import('node:fs');
  const { mkdtempSync, mkdirSync, rmSync } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pullIncidentRefs } = await import('../lib/incident-source.mjs');
  const root = mkdtempSync(join(tmpdir(), 'tg-inc-'));
  try {
    // 缺失文件＝确无异常源（非不可读）
    const missing = pullIncidentRefs(root);
    assert.deepEqual(missing, { refs: [], unavailable: false });
    // 存在但不可读（目录形态）→ unavailable
    mkdirSync(join(root, '.workflow', 'incidents.jsonl'), { recursive: true });
    const broken = pullIncidentRefs(root);
    assert.equal(broken.unavailable, true, '不可读须报 unavailable');
    assert.deepEqual(broken.refs, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

