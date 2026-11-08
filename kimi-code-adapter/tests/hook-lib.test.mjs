// 文件：hook-lib.test.mjs
// 描述：kimi hook-lib 状态面单元测试（内部任务-2 批 A2：会话键忠实化 / 旧形状 pending 不迁移 /
//       droppedByLimit 读写往返 / writeState tmp 唯一后缀）。
// 作者：wangp 创建：2026-10-05  版权：MIT（见仓库 LICENSE）
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIB_URL = new URL('../kimi/hook-lib.mjs', import.meta.url);
const LIB_PATH = fileURLToPath(LIB_URL);

const { OBSERVATION_CAPABILITIES, applyObservationCapabilitiesEnv, emptyState, enqueuePending, readState, writeDiagnostic, writeState, sweepStaleTmp } = await import(LIB_URL);

describe('hook-lib 状态面（内部任务-2 批 A2）', () => {
it('A2 enqueuePending：显式会话键忠实入帧；空串回落字典最大计数键（兜底尽力投递，内部任务-347 字典形态）', () => {
  const state = emptyState();
  const next = enqueuePending(state, '提醒A', 'sess-now');
  assert.equal(next.frames[0].sessionKey, 'sess-now', '显式键优先——观察面帧不再错挂兜底键');
  const legacy = { frames: [], streaks: { 's:sess-old': 2, 's:other': 1 }, droppedBySession: {} };
  assert.equal(enqueuePending(legacy, '回落', '').frames[0].sessionKey, 'sess-old', '空串回落最大计数键（底部兜底尽力形态）');
  assert.equal(enqueuePending(emptyState(), '空字典', '').frames[0].sessionKey, '', '空字典兜底为空串＝帧不可投递（丢弃更诚实，内部任务-347）');
});

it('A3 enqueuePending：去重键＝会话+文本（跨会话同文案不互删）', () => {
  const a = enqueuePending(emptyState(), '同文本提醒', 'session-A');
  const b = enqueuePending(a, '同文本提醒', 'session-B');
  assert.deepEqual(b.frames.map((f) => f.sessionKey).sort(), ['session-A', 'session-B'], '两会话各保留一帧');
  const c = enqueuePending(b, '同文本提醒', 'session-A');
  assert.equal(c.frames.filter((f) => f.sessionKey === 'session-A').length, 1, '同会话同文本仍去重');
  assert.equal(c.frames.length, 2, '不误删他会话帧');
});

it('A3 enqueuePending：20 条上限全局淘汰并按会话分账累加 droppedBySession（内部任务-347/内部未决-274）', () => {
  let state = emptyState();
  for (let i = 0; i < 21; i += 1) state = enqueuePending(state, `提醒-${i}`, 'S');
  assert.equal(state.frames.length, 20, '上限 20');
  assert.equal(state.droppedBySession['s:S'], 1, '淘汰计数不静默（分账到入队会话键）');
  assert.ok(!state.frames.some((f) => f.text === '提醒-0'), '最旧被淘汰');
});

it('A3 readState：损坏 JSON 不静默清空，写诊断日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-a3-'));
  try {
    writeFileSync(join(dir, 'relay-state.json'), '{bad json');
    assert.equal(readState(dir).frames.length, 0, '损坏时返回空状态（fail-open）');
    const log = readFileSync(join(dir, 'hook-diagnostics.log'), 'utf8');
    assert.match(log, /不可解析/, '损坏必须留诊断');
    assert.match(log, /已重置待投递队列/, '诊断说明重置事实');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('A2 readState：旧形状 pending 不迁移（kimi 单提交新建、无旧盘态史）；缺 sessionKey 帧丢弃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-a2-'));
  try {
    writeFileSync(join(dir, 'relay-state.json'), JSON.stringify({ pending: [{ id: 'x', text: '旧形状', ts: 1 }] }));
    assert.equal(readState(dir).frames.length, 0, '旧 pending 形态丢弃（mcode 才有升级史）');
    writeFileSync(join(dir, 'relay-state.json'), JSON.stringify({ frames: [{ text: '无键帧', ts: 1 }, { text: '有键帧', sessionKey: 's', ts: 2 }], streaks: {}, droppedBySession: {} }));
    assert.deepEqual(readState(dir).frames.map((f) => f.text), ['有键帧'], '缺 sessionKey 帧丢弃（投递过滤语义下不可投递，丢弃比合成错键诚实）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('A2 readState/writeState：streaks/droppedBySession 字典读写往返保留（引擎多会话状态键不被宿主读侧抹掉，内部任务-347）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-a2-'));
  try {
    assert.equal(writeState(dir, { frames: [], streaks: { 's:a': 2 }, droppedBySession: { 's:a': 3 } }), true);
    const read = readState(dir);
    assert.equal(read.streaks['s:a'], 2);
    assert.equal(read.droppedBySession['s:a'], 3);
    assert.equal(read.streaks['bad'], undefined, '非正整数条目不保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('A2 writeState：tmp 唯一后缀（静态断言——固定名并发互踩形态必须清除）', () => {
  const src = readFileSync(LIB_PATH, 'utf8');
  assert.ok(!src.includes('`${target}.tmp`'), 'writeState 不得用固定 tmp 名（pid+随机后缀）');
  assert.ok(!src.includes('`${target}.wptmp'), '无其他固定 tmp 形态');
});

it('A2 writeState：双进程并发写冒烟（各 30 次——结束后状态可解析且无 tmp 残留）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-a2-conc-'));
  try {
    const script = `import { writeState } from ${JSON.stringify(LIB_URL.href)}; const dir = ${JSON.stringify(dir)}; for (let i = 0; i < 30; i += 1) writeState(dir, { frames: [{ sessionKey: 's', id: 'f' + i + '-' + process.pid, text: 'x' + i + '-' + process.pid, ts: i }], streakKey: '', streakCount: 0 });`;
    const one = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const two = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(one.status, 0, one.stderr);
    assert.equal(two.status, 0, two.stderr);
    const state = readState(dir);
    assert.equal(typeof state.frames, 'object');
    assert.ok(state.frames.length >= 1, '并发写后状态可解析且帧在场');
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '无 tmp 残留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部任务-347 批 C（内部未决-280/286）：诊断面加固＋sweep ──

it('内部未决-280 writeDiagnostic：符号链接目标拒写（不跟随）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-o280-'));
  try {
    mkdirSync(join(dir, 'outside'), { recursive: true });
    const target = join(dir, 'outside', 'stolen.log');
    writeFileSync(target, '', 'utf8');
    symlinkSync(target, join(dir, 'hook-diagnostics.log'));
    writeDiagnostic(dir, 'state', '不得写入链接目标', '');
    assert.equal(readFileSync(target, 'utf8'), '', '链接目标未被写入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('内部未决-280 readState 损坏：一次告警＋坏文件改名隔离 .corrupt（后续零重复）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-o280b-'));
  try {
    writeFileSync(join(dir, 'relay-state.json'), '{bad', 'utf8');
    readState(dir);
    readState(dir); // 第二次读：坏文件已隔离 ⇒ 走缺失分支零重复
    const log = readFileSync(join(dir, 'hook-diagnostics.log'), 'utf8');
    assert.equal((log.match(/不可解析/g) ?? []).length, 1, '损坏告警恰一次（隔离后零重复）');
    assert.ok(existsSync(join(dir, 'relay-state.json.corrupt')), '坏文件改名隔离（固定名单覆盖写）');
    assert.equal(existsSync(join(dir, 'relay-state.json')), false, '原位不再有坏文件');
    assert.deepEqual(readState(dir).frames, [], '隔离后走缺失=正常空态');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('内部未决-286 sweepStaleTmp：死 pid＋超龄清、活 pid（含 EPERM 语义）与新鲜件留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-o286-'));
  try {
    const mk = (name, pid, ageMs) => {
      const p = join(dir, name);
      writeFileSync(p, 'x', 'utf8');
      utimesSync(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
      void pid;
    };
    mk('relay-state.json.tmp-999999-abcdef', 999999, 2 * 3600_000); // 死 pid＋超龄 → 清
    mk(`relay-state.json.tmp-${process.pid}-abcdef`, process.pid, 2 * 3600_000); // 活 pid → 留
    mk('relay-state.json.tmp-999998-abcdef', 999998, 60_000); // 死 pid 但新鲜 → 留
    mk('relay-state.json.corrupt', 0, 2 * 3600_000); // 非 tmp 形态 → 不动
    const removed = sweepStaleTmp(dir);
    assert.equal(removed, 1, '恰清一件（死 pid＋超龄）');
    assert.equal(existsSync(join(dir, 'relay-state.json.tmp-999999-abcdef')), false, '死 pid 超龄件已清');
    assert.equal(existsSync(join(dir, `relay-state.json.tmp-${process.pid}-abcdef`)), true, '活 pid 件保留');
    assert.equal(existsSync(join(dir, 'relay-state.json.tmp-999998-abcdef')), true, '新鲜件保留（mtime<1h）');
    assert.equal(existsSync(join(dir, 'relay-state.json.corrupt')), true, '非 tmp 形态不动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('内部未决-286 sweepStaleTmp EPERM 语义：System pid（存在但拒权限）视为存活跳过', () => {
  if (process.platform !== 'win32') return; // EPERM 夹具只在 Windows 可稳定构造（pid4=System）
  const dir = mkdtempSync(join(tmpdir(), 'kimi-o286e-'));
  try {
    const p = join(dir, 'relay-state.json.tmp-4-abcdef'); // pid 4 = System（kill → EPERM）
    writeFileSync(p, 'x', 'utf8');
    utimesSync(p, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const removed = sweepStaleTmp(dir);
    assert.equal(removed, 0, 'EPERM＝进程存在 ⇒ 保守跳过（catch 即判死的错误实现必红）');
    assert.equal(existsSync(p), true, 'System pid 件未被清');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

});

// ── 运行观测能力域声明（2026-10-24 内部任务-192 P2 步骤 12；内部接口-1 Kimi 列） ────────────────
// 用例用 `it(` 以纳入本适配层 README 的「测试计数与实测逐文件一致」契约（只统计 `it(`）；
// 计数与规格面由 README「测试计数」节与 jsdoc-contract 机检同步（不写死历史数字）。
it('内部任务-192 能力域 env：声明注入钩子子进程环境（键存在/JSON 可解析/既有键不变）', () => {
  // hook-lib 装载即声明（shim 随后以 `{...process.env}` 构造子进程 env）⇒ 当前进程 env 可见。
  assert.ok(Object.hasOwn(process.env, 'WF_OBSERVATION_CAPABILITIES'), 'env 键存在（shim 子进程继承面）');
  const caps = JSON.parse(process.env.WF_OBSERVATION_CAPABILITIES);
  assert.deepEqual(caps, { failureFacts: 'error-object', hookFailure: 'engine-log', injection: 'relay', selfCheck: 'selftest' }, '内部接口-1 Kimi 列四能力域取值');
  assert.deepEqual(caps, { ...OBSERVATION_CAPABILITIES }, 'env 与导出常量同源');
  assert.deepEqual(Object.keys(caps).sort(), ['failureFacts', 'hookFailure', 'injection', 'selfCheck'], '键集＝四能力域');
  // 既有键不变：注入只增一键，不覆盖/删除 shim 既有环境（ZCODE_PLUGIN_ROOT/ZCODE_PROJECT_DIR/KIMI_HOOK_EVENT 等）。
  const env = applyObservationCapabilitiesEnv({
    PATH: '/usr/bin',
    KIMI_CODE_HOME: '/kimi-home',
    ZCODE_PLUGIN_ROOT: '/plugin',
    ZCODE_PROJECT_DIR: '/project',
    KIMI_HOOK_EVENT: 'PostToolUse',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.KIMI_CODE_HOME, '/kimi-home');
  assert.equal(env.ZCODE_PLUGIN_ROOT, '/plugin');
  assert.equal(env.ZCODE_PROJECT_DIR, '/project');
  assert.equal(env.KIMI_HOOK_EVENT, 'PostToolUse');
  assert.deepEqual(
    Object.keys(env).sort(),
    ['KIMI_CODE_HOME', 'KIMI_HOOK_EVENT', 'PATH', 'WF_OBSERVATION_CAPABILITIES', 'ZCODE_PLUGIN_ROOT', 'ZCODE_PROJECT_DIR'],
    '只增能力域键（既有键既不改值也不改名）',
  );
  // 已声明值不覆盖：外层（嵌套 shim/测试）可显式指定，幂等。
  const preset = applyObservationCapabilitiesEnv({ WF_OBSERVATION_CAPABILITIES: '{"failureFacts":"native"}' });
  assert.equal(preset.WF_OBSERVATION_CAPABILITIES, '{"failureFacts":"native"}', '外层声明优先（不覆盖）');
  assert.equal(applyObservationCapabilitiesEnv(env), env, '重复调用幂等且返回同一对象');
});
