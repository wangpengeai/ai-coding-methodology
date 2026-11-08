// 文件：guard-visibility.test.mjs
// 描述：护栏失效可观测（内部规则-7 日志哨兵）的行为测试——user-prompt.mjs 增量扫描
//       宿主日志（hook.run.failed 记录），检测到本会话 workflow hook 失败时，
//       会话内首次注入一行告警；失败对其他会话/其他插件不可见；日志缺失/损坏
//       静默跳过（fail-open 不变）；告警优先于提醒节流（含首条消息：SessionStart
//       失败可在首条用户消息即被发现）。注入缝：WF_GUARD_LOG_PATH 指向 fixture、
//       WF_ROUTING_STATE_DIR 隔离租约挑战（内部决策-018 前置缺陷修复：此前未注入导致
//       全量测试向共享 tmpdir 真实签发本项目挑战，制造"莫名轮换"）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 日志全部临时生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIncidents } from '../../scripts/lib/incident-store.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'user-prompt.mjs');

/** 与既有用例一致的提醒冷却期（长冷却=提醒侧静默，隔离出告警侧行为） */
const LONG_COOLDOWN = '3600000';

/**
 * 造一条宿主 hook 失败日志行（结构对齐真实日志：core.hooks 模块的 hook.run.failed）。
 * @param {{ session: string, source?: string, event?: string, timestamp?: string }} spec
 */
function failureLine({ session, source = 'plugin.workflow@wangp-local-marketplace.PreToolUse.0.0', event = 'hook.run.failed', timestamp = '2026-09-12T08:00:00.000Z' }) {
  return JSON.stringify({
    timestamp,
    level: 'warn',
    event,
    module: 'core.hooks',
    message: 'Hook execution failed',
    sessionId: session,
    context: { hookEventName: 'PreToolUse', source },
  });
}

/**
 * 造一条宿主按停检查日志行（v4.stop.*：用户按停时宿主检查在飞前台执行）。
 * @param {{ session: string, timestamp: string }} spec
 */
function stopLine({ session, timestamp }) {
  return JSON.stringify({
    timestamp,
    level: 'info',
    event: 'v4.stop.foreground_execution_inspected',
    module: 'core.hooks',
    message: 'Foreground execution inspected on stop',
    sessionId: session,
    context: { hookEventName: 'Stop', source: 'app' },
  });
}

/**
 * 以子进程运行 hook：状态目录与日志路径全部注入缝隔离。
 * @param {string} session 会话 id
 * @param {string} prompt 用户消息
 * @param {{ stateDir: string, logPath: string, cooldownMs?: string }} o 必填注入缝
 */
function run(session, prompt, o) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: session, prompt }),
    encoding: 'utf8',
    env: {
      ...process.env,
      WF_UPROMPT_STATE_DIR: o.stateDir,
      WF_ROUTING_STATE_DIR: o.stateDir, // 租约挑战落隔离目录，不触碰共享 tmpdir（内部决策-018 前置修复）
      WF_UPROMPT_COOLDOWN_MS: o.cooldownMs ?? LONG_COOLDOWN,
      WF_GUARD_LOG_PATH: o.logPath,
      WF_INCIDENT_ROOT: o.stateDir, // 内部模块-15 自察记录落隔离目录（套件级告警会写 hook-failure 记录）
    },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** envelope 解析（无输出→null）。 */
function env(stdout) {
  const t = stdout.trim();
  return t ? JSON.parse(t) : null;
}

test('本会话 workflow 失败 → 首条用户消息即注入告警（含次数与日志指引）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        failureLine({ session: 'sess-t1' }),
        failureLine({ session: 'sess-t1', source: 'plugin.workflow@wangp-local-marketplace.Stop.0.0' }),
        failureLine({ session: 'sess-other' }), // 其他会话：不计数
        failureLine({ session: 'sess-t1', source: 'plugin.mimosa@zcode-plugins-official.PreToolUse.3.0' }), // 其他插件：不计数
        failureLine({ session: 'sess-t1', event: 'hook.run.ok' }), // 非失败事件：不计数
        JSON.stringify({ level: 'info', event: 'other', sessionId: 'sess-t1' }),
        '{{{ not-json', // 坏行：容忍
      ].join('\n') + '\n',
    );
    const r = run('sess-t1', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const e = env(r.stdout);
    assert.ok(e, '应注入告警');
    assert.equal(e.hookSpecificOutput?.hookEventName, 'UserPromptSubmit', '信封事件名契约（内部规则-6）');
    const ctx = e.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('护栏异常'), '告警须自报家门');
    assert.ok(ctx.includes('2'), '告警须含本会话失败次数（workflow 口径 2 次）');
    assert.ok(ctx.includes('hook.run.failed') || ctx.includes('日志'), '告警须给日志指引');
    assert.ok(!ctx.includes('路由提醒'), '首条消息不叠路由提醒（SessionStart 已注入全文）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('告警会话内一次性：已告警后新失败不再重复告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(log, failureLine({ session: 'sess-t2' }) + '\n');
    run('sess-t2', '第一条', { stateDir: dir, logPath: log }); // 告警 + 置位
    appendFileSync(log, failureLine({ session: 'sess-t2' }) + '\n'); // 新失败
    const r = run('sess-t2', '第二条', { stateDir: dir, logPath: log, cooldownMs: '0' });
    const e = env(r.stdout);
    // 告警不重复；冷却期 0 使提醒到期 → 单独注入提醒（不含护栏异常）
    const ctx = e?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('护栏异常'), '会话内只告警一次');
    assert.ok(ctx.includes('路由提醒'), '提醒到期仍正常注入（告警不挤占提醒）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无本会话失败（其他会话/其他插件）→ 不告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        failureLine({ session: 'sess-a' }),
        failureLine({ session: 'sess-b', source: 'plugin.mimosa@zcode-plugins-official.Stop.1.0' }),
      ].join('\n') + '\n',
    );
    const r = run('sess-clean', '第一条', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('护栏异常'), '无本会话失败则无告警');
    assert.ok(ctx.includes('任务租约'), '任务租约行每轮必注（内部规则-8，与告警无关）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('增量扫描：只统计上次扫描后追加的行（幂等，不重复计数）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(log, failureLine({ session: 'sess-t3' }) + '\n');
    const first = run('sess-t3', '第一条', { stateDir: dir, logPath: log });
    assert.ok(env(first.stdout)?.hookSpecificOutput?.additionalContext?.includes('1'), '首扫计 1 次');
    const second = run('sess-t3', '第二条', { stateDir: dir, logPath: log, cooldownMs: '0' });
    const ctx = env(second.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('护栏异常'), '同批失败不因重扫重复告警');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志缺失 → fail-open：退出 0、无输出、不影响提醒逻辑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    run('sess-t4', '第一条', { stateDir: dir, logPath: join(dir, 'no-such.log') });
    const r = run('sess-t4', '第二条', { stateDir: dir, logPath: join(dir, 'no-such.log'), cooldownMs: '0' });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('路由提醒'), '日志缺失时提醒照常，告警缺席不报错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志截断/轮转（文件变短）→ 从头重扫不崩溃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vis-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(log, failureLine({ session: 'sess-t5' }) + '\n' + failureLine({ session: 'sess-t5' }) + '\n');
    run('sess-t5', '第一条', { stateDir: dir, logPath: log }); // 扫到 offset 尾部
    writeFileSync(log, failureLine({ session: 'sess-t5' }) + '\n'); // 文件变短（轮转重写）
    const r = run('sess-t5', '第二条', { stateDir: dir, logPath: log, cooldownMs: '0' });
    assert.equal(r.status, 0, '截断不崩溃');
    assert.ok(env(r.stdout) !== undefined, '信封要么有要么无，进程必须正常');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部模块-15 哨兵窄化：与同会话 v4.stop 时间相邻的 hook.run.failed 是宿主按停预期噪音
//    （hf-84c89b764：被按停杀掉的在飞 hook 进程，失败与 stop 事件毫秒级相邻）──

/** 按停噪音窗用例的失败 source：Stop 事件保护钩——不被纯记录钩排除面覆盖，隔离出时间窗排除行为 */
const STOP_CASE_SOURCE = 'plugin.workflow@wangp-local-marketplace.Stop.1.2';

test('按停窗内：同会话 v4.stop 后 500ms 的套件失败 → 不计数、不告警、不落 incident', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stopwin-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        stopLine({ session: 'sess-t6', timestamp: '2026-09-14T10:00:00.000Z' }),
        failureLine({ session: 'sess-t6', source: STOP_CASE_SOURCE, timestamp: '2026-09-14T10:00:00.500Z' }),
      ].join('\n') + '\n',
    );
    const r = run('sess-t6', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('护栏异常'), '按停窗内失败是预期噪音，不告警');
    assert.equal(readIncidents(dir).filter((d) => d.kind === 'hook-failure').length, 0, '不落 hook-failure incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按停窗外：v4.stop 后 5 秒的失败 → 照常计数告警并落 incident', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stopout-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        stopLine({ session: 'sess-t7', timestamp: '2026-09-14T10:00:00.000Z' }),
        failureLine({ session: 'sess-t7', source: STOP_CASE_SOURCE, timestamp: '2026-09-14T10:00:05.000Z' }),
      ].join('\n') + '\n',
    );
    const r = run('sess-t7', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('护栏异常'), '窗外失败与按停无因果，照常告警');
    assert.ok(ctx.includes('1'), '告警含本会话计数 1 次');
    assert.equal(readIncidents(dir).filter((d) => d.kind === 'hook-failure').length, 1, '照常落一条 hook-failure incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── R4 回归（2026-09-14 终审）：同段两次按停时判窗须取「全部 stop 时刻的最近距离」，
//    不得只比最后一个 stop（旧实现只存单值 max，贴近较早 stop 的失败被误计）──

test('同段双 stop：失败行贴近较早 stop（距较新 stop 超窗）→ 仍按窗内噪音排除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stop2-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        stopLine({ session: 'sess-t10', timestamp: '2026-09-14T10:00:00.000Z' }), // ts1
        failureLine({ session: 'sess-t10', source: STOP_CASE_SOURCE, timestamp: '2026-09-14T10:00:00.500Z' }), // 距 ts1 500ms
        stopLine({ session: 'sess-t10', timestamp: '2026-09-14T10:01:00.000Z' }), // ts2 = ts1 + 60s
      ].join('\n') + '\n',
    );
    const r = run('sess-t10', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('护栏异常'), '失败与段内较早 stop 毫秒级相邻：按停噪音，不告警');
    assert.equal(readIncidents(dir).filter((d) => d.kind === 'hook-failure').length, 0, '不落 hook-failure incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败行缺 timestamp 字段 → 无法判窗，照常计数（fail-visible 宁可误报不可漏报）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stopts-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    const bare = JSON.parse(failureLine({ session: 'sess-t8', source: STOP_CASE_SOURCE }));
    delete bare.timestamp; // 日志格式漂移：失败行无时间戳
    writeFileSync(log, stopLine({ session: 'sess-t8', timestamp: '2026-09-14T10:00:00.000Z' }) + '\n' + JSON.stringify(bare) + '\n');
    const r = run('sess-t8', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('护栏异常'), '无 timestamp 不排除：失败必须可见');
    assert.equal(readIncidents(dir).filter((d) => d.kind === 'hook-failure').length, 1, '照常落 incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop 行与失败行异会话 → 窗排除不生效，照常计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stopsess-'));
  try {
    const log = join(dir, 'zcode-test.jsonl');
    writeFileSync(
      log,
      [
        stopLine({ session: 'sess-other', timestamp: '2026-09-14T10:00:00.000Z' }), // 别的会话在按停
        failureLine({ session: 'sess-t9', source: STOP_CASE_SOURCE, timestamp: '2026-09-14T10:00:00.100Z' }),
      ].join('\n') + '\n',
    );
    const r = run('sess-t9', '第一条消息', { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const ctx = env(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('护栏异常'), '异会话 stop 与本会话失败无因果，照常告警');
    assert.equal(readIncidents(dir).filter((d) => d.kind === 'hook-failure').length, 1, '照常落 incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
