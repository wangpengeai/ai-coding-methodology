// 文件：long-task-driver.test.mjs
// 描述：DSH 长任务编排（内部决策-053 / 内部任务-171）测试——纯状态机 9 条 + apply 装配级 13 条（2026-11-01 内部任务-272 遗留批 +2：plan 模式 Stop/LongTaskStop 让位差分）
//       （协议注入/Stop 续跑/目标让位与委派/人类重置与失败 fail-open/无 goals 服务不注册）。
// 作者：wangp  创建：2026-10-20  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.mjs';
import { createLongTaskDriver } from '../src/long-task-driver.mjs';
import { createLogger } from './helpers/logger-stub.cjs';
import { testEngine } from './helpers/engine-binding.mjs';

testEngine();

function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dev171-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function todo(content, status) { return { content, status }; }
const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];
function isolatedRoots(t) {
  const roots = {};
  for (const p of PLUGINS) roots[p] = makeTemp(t);
  return roots;
}
function makeFakeShell() {
  const win = process.platform === 'win32';
  return {
    resolve(request) { return request; },
    async execute(spec) {
      const common = {
        cwd: spec.workdir, env: { ...process.env, ...(spec.env ?? {}) },
        input: spec.stdin ?? '', encoding: 'utf8', timeout: spec.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      };
      // 内部任务-311：win32 与真实 DSH runner 同形（PowerShell 5.1 `-Command "<line>; exit ..."`），
      // 旧 `shell:true` 走 cmd.exe 无法承接 内部任务-308/内部未决-243 的 `&` 调用运算符（hook 命令恒退出 1）。
      const r = win
        ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${spec.command}; exit $LASTEXITCODE`], common)
        : spawnSync(spec.command, { ...common, shell: true });
      return {
        async result() {
          const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal !== null;
          return { exitCode: timedOut ? 124 : (r.status ?? undefined), stdout: { text: r.stdout ?? '' }, stderr: { text: r.stderr ?? '' }, timedOut };
        },
      };
    },
  };
}
function makeFixturePlugin(t, hooks, files = {}) {
  const root = makeTemp(t);
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }), 'utf8');
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2), 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8');
  }
  return root;
}
function fixtureRoots(t, hooks, files) {
  const roots = isolatedRoots(t);
  roots.workflow = makeFixturePlugin(t, hooks, files);
  return roots;
}
const STOP_OK = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'FIXTURE-STOP-OK' } }) + '\\n');";
const STOP_DENY = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'FIXTURE-STOP-DENY' } }) + '\\n'); process.exit(2);";
// 内部任务-339 T-05（内部未决-246）：marker 夹具——STOP_OK 行为＋把「钩子确实执行过」写到 marker 文件，
// 用于判别「派发未发生」与「派发后中止」（makeFakeShell 的 spawnSync 继承父环境，经
// process.env.LTD_STOP_MARKER 传路径；index.mjs:1346 入口 abort 在派发前返回、:1358 派发后 abort 弃结果）。
// 注：夹具文件扩展名 .mjs（ESM）——marker 写入须用 import 而非 require（require 在 ESM 未定义）。
const STOP_OK_MARKER = [
  "import { writeFileSync } from 'node:fs';",
  'const m = process.env.LTD_STOP_MARKER;',
  "if (m) { try { writeFileSync(m, 'ran\\n'); } catch {} }",
  STOP_OK,
  '',
].join('\n');
/** marker 路径＋env 设置与清理单源（r1 三维简洁性#10：设置/清理由本函数统一承载，调用方不再重复）。 */
function markerPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dev339-marker-'));
  const p = join(dir, 'stop.marker');
  const prev = process.env.LTD_STOP_MARKER;
  process.env.LTD_STOP_MARKER = p;
  t.after(() => {
    if (prev === undefined) delete process.env.LTD_STOP_MARKER;
    else process.env.LTD_STOP_MARKER = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return p;
}
function makeCtx({ goals, planMode } = {}) {
  const listeners = new Map();
  const logger = createLogger();
  const services = new Map();
  services.set('skills', { register: () => () => {} });
  if (goals !== undefined) services.set('goals', goals);
  if (planMode !== undefined) services.set('planMode', planMode);
  return {
    shell: makeFakeShell(),
    logger,
    byLevel: (level) => logger.byLevel(level),
    warnings: () => logger.byLevel('warn'),
    get: (name) => services.get(name),
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    effect() {},
    listeners,
    async emit(event, ...args) {
      let out;
      for (const fn of listeners.get(event) ?? []) out = await fn(...args);
      return out;
    },
  };
}
function makeAgent(sessionId, delegationDepth = 0) {
  const injected = [];
  const steered = [];
  return {
    injected,
    steered,
    agent: {
      session: { header: { id: sessionId, cwd: process.cwd(), delegationDepth } },
      inject: (m) => injected.push(m),
      steer: (m) => steered.push(m),
    },
  };
}
const next = async () => ({ kind: 'continue' });

// ── 纯状态机（9） ─────────────────────────────────────────────────────────

test('driver：协议文本包含 todo/goal/续跑关键词', () => {
  const text = createLongTaskDriver().protocolText();
  assert.match(text, /todo_write/);
  assert.match(text, /create_goal/);
  assert.match(text, /续跑/);
});

test('driver：协议文本含阻塞停机与 goal 阻塞时机（内部决策-053 修正案 / 内部任务-199）', () => {
  const text = createLongTaskDriver().protocolText();
  for (const anchor of [
    '同一外部阻塞', '当轮停止推进', '并在回复中报告', '不得', '空转', '已尝试路径', '可解性',
    'update_goal', 'blocked', '持续达宿主阈值后', '不构成阻塞判据',
    '难度', '不确定性', '剩余工作',
  ]) {
    assert.ok(text.includes(anchor), `协议文本须含「${anchor}」（R-da-12 / 内部决策-053 决策 9）`);
  }
  // 既有锚点不删（追加段不得覆盖旧语义；旧用例只锁三词，这里补守）
  for (const legacy of ['每人类轮最多 2 次', '若需用户决策请在回复中直接说明', 'plan 模式']) {
    assert.ok(text.includes(legacy), `既有协议锚点不得删除：「${legacy}」`);
  }
});

test('driver：观测 pending todo 后首轮返回续跑方案，commit 后同清单不重复', () => {
  const d = createLongTaskDriver();
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending')] } });
  const plan = d.shouldSteer({ sessionId: 's1', now: 1000 });
  assert.ok(plan && /清单仍有/.test(plan.text) && /a/.test(plan.text));
  plan.commit();
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 20000 }), undefined);
});

test('driver：completed/空清单不续跑；in_progress 每人类轮仅一次', () => {
  const d = createLongTaskDriver();
  assert.equal(d.shouldSteer({ sessionId: 's1' }), undefined);
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'completed')] } });
  assert.equal(d.shouldSteer({ sessionId: 's1' }), undefined);
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [] } });
  assert.equal(d.shouldSteer({ sessionId: 's1' }), undefined, '空数组应清空清单');
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'in_progress')] } });
  const p = d.shouldSteer({ sessionId: 's1', now: 1000 });
  assert.ok(p);
  p.commit();
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 30000 }), undefined, 'in_progress 每轮一次');
});

test('driver：预算（2/轮、10/会话）与冷却 15s；人类提示重置预算和冷却', () => {
  const d = createLongTaskDriver();
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending')] } });
  const p1 = d.shouldSteer({ sessionId: 's1', now: 1000 });
  assert.ok(p1);
  p1.commit();
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending'), todo('b', 'pending')] } });
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 2000 }), undefined, '冷却 15s');
  const p2 = d.shouldSteer({ sessionId: 's1', now: 16000 });
  assert.ok(p2);
  p2.commit();
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending'), todo('b', 'pending'), todo('c', 'pending')] } });
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 32000 }), undefined, '每人类轮 2 次');
  d.onHumanPrompt('s1');
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 33000 }), undefined, '人类提示作废旧快照');
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending'), todo('b', 'pending'), todo('c', 'pending'), todo('d', 'in_progress')] } });
  assert.ok(d.shouldSteer({ sessionId: 's1', now: 34000 }), '新清单键重新武装后重置预算与冷却');
});

test('driver：commit 才占预算；未 commit 可重复获得方案', () => {
  const d = createLongTaskDriver();
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'pending')] } });
  assert.ok(d.shouldSteer({ sessionId: 's1', now: 1000 }));
  assert.ok(d.shouldSteer({ sessionId: 's1', now: 30000 }), '未 commit：冷却与预算未占用');
});

test('driver：非法 todo 参数与冻结键保留，每会话 warn 一次', () => {
  const warnings = [];
  const d = createLongTaskDriver({ warn: (m) => warnings.push(m) });
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'in_progress')] } });
  d.onHumanPrompt('s1');
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: 'bad' } });
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('a', 'in_progress')] } });
  assert.equal(d.shouldSteer({ sessionId: 's1' }), undefined, '原样重发旧表不重新武装');
  assert.equal(warnings.length, 1, '每会话只 warn 一次');
});

// ── apply 装配级（13） ────────────────────────────────────────────────────

test('apply：首轮 pre-step 向顶层投递协议，委派会话不投递', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const protocolListener = (ctx.listeners.get('agent/pre-step') ?? [])[0];
  assert.equal(typeof protocolListener, 'function', '应注册 LongTaskProtocol pre-step 监听');
  const top = makeAgent('sess-proto');
  const out = await protocolListener({ agent: top.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  assert.ok(Array.isArray(out.messages) && out.messages.some((m) => /DSH 长任务协议/.test(JSON.stringify(m)) && /todo_write/.test(JSON.stringify(m))));
  assert.equal(top.injected.length, 0, '不再使用 agent.inject（避免 durable next-step 误报）');
  const sub = makeAgent('sess-sub', 1);
  const outSub = await protocolListener({ agent: sub.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(outSub.messages.length, 0, '委派会话不投递');
});

test('apply：pending 清单在 Stop 续跑一次，completed 清单不续跑', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const { agent, steered } = makeAgent('sess-stop');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1);
  assert.match(JSON.stringify(steered[0]), /todo 续跑/);
  const done = makeAgent('sess-done');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'completed')] }, agent: done.agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent: done.agent });
  assert.equal(done.steered.length, 0);
});

test('apply：goal 服务有 active goal 时让位；无 goals 服务不注册驱动', async (t) => {
  const ctx = makeCtx({ goals: { get: () => ({ objective: 'x', phase: 'active' }) } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const g = makeAgent('sess-goal');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: g.agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent: g.agent });
  assert.equal(g.steered.length, 0, 'goal 服务 active 时驱动让位');
  const plain = makeCtx();
  await apply(plain, { pluginRoots: isolatedRoots(t) });
  // 内部任务-220：apply 恒装配 BridgeChannelHint（agent/pre-step），故无 goals 时 pre-step 监听为 1 条（桥接提示，纯直通）。
  assert.equal((plain.listeners.get('agent/pre-step') ?? []).length, 1, '无 goals 服务不注册协议/重置监听（仅恒装配的桥接提示监听）');
  assert.equal((plain.listeners.get('tools/post-execute') ?? []).length, 0, '无 goals 服务不注册观测监听');
});

test('apply：人类提示重置后可再次续跑；steer 抛错 fail-open 留 warn', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const { agent, steered } = makeAgent('sess-human');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'in_progress')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1, '同清单同轮不重复续跑');
  await ctx.emit('agent/pre-step', { agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }] }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1, '人类提示后旧快照作废，无新清单不续跑');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'in_progress'), todo('b', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 2, '新清单键重新武装后再次续跑');
  const bad = makeAgent('sess-bad');
  bad.agent.steer = () => { throw new Error('boom'); };
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: bad.agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent: bad.agent });
  assert.ok(ctx.warnings().some((w) => /长任务续跑失败/.test(String(w))));
});

test('apply（主 Stop 非阻断）：fixture Stop exit0 时主监听器 steer 一次', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: fixtureRoots(t, { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.mjs'], timeoutMs: 5000 }] }] }, { 'hooks/stop.mjs': STOP_OK }) });
  const { agent, steered } = makeAgent('sess-main-ok');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1, '主路径（byEvent.Stop=true）非阻断应续跑');
  assert.match(JSON.stringify(steered[0]), /todo 续跑/);
});

test('apply（主 Stop 阻断）：fixture deny 时驱动不追加续跑', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: fixtureRoots(t, { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.mjs'], timeoutMs: 5000 }] }] }, { 'hooks/stop.mjs': STOP_DENY }) });
  const { agent, steered } = makeAgent('sess-main-deny');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1, '既有 blocked 路径仍会 steer 一次');
  assert.doesNotMatch(JSON.stringify(steered[0]), /todo 续跑/, '驱动层不得追加续跑文案');
});

test('apply（主 Stop 派发期间 abort）：marker 锚定 signal 阻止续跑（钩子实跑、结果被弃）', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: fixtureRoots(t, { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.mjs'], timeoutMs: 5000 }] }] }, { 'hooks/stop.mjs': STOP_OK_MARKER }) });
  const { agent, steered } = makeAgent('sess-main-abort');
  const marker = markerPath(t);
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  // 内部任务-339 执行期纠偏（判别意图不变）：计划原「可变 signal（读取计数翻转）」经实勘不可靠——
  // signal 读取点次序依赖监听器注册面，计数翻转可能使 :1346 入口检查即判 true（夹具从未执行）。
  // 改 marker 锚定：aborted＝marker 是否已出现——派发前恒 false（钩子未跑）、钩子写 marker 后
  // 任何后续读取（:1358/:1370）即 true。确定性钉死「派发后中止」：钩子实跑＋续跑被弃。
  const signal = { get aborted() { return existsSync(marker); } };
  await ctx.emit('agent/turn-stopping', { agent, signal });
  assert.equal(steered.length, 0, '钩子执行后 abort 必须阻止续跑');
  assert.ok(existsSync(marker), 'marker 在位＝钩子实跑（abort 丢弃派发结果不续跑——index.mjs:1358 分支）');
});

// 内部任务-339 T-05（内部未决-246，覆盖补齐——被测行为已存在，本用例钉判别力）：既有「入口 abort」用例
// （isolatedRoots 无 Stop 夹具）无法区分「未派发」与「派发后不续跑」；本用例以 marker 缺席证明
// 派发未发生（index.mjs:1346 入口检查在 buildPayload/dispatch 之前返回）。
test('内部任务-339 T-05：主 Stop 入口 abort——marker 缺席证明未派发且不续跑', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: fixtureRoots(t, { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.mjs'], timeoutMs: 5000 }] }] }, { 'hooks/stop.mjs': STOP_OK_MARKER }) });
  const { agent, steered } = makeAgent('sess-entry-abort-marker');
  const marker = markerPath(t);
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent, signal: { aborted: true } });
  assert.equal(steered.length, 0, '入口 abort 不续跑');
  assert.ok(!existsSync(marker), 'marker 缺席＝夹具从未执行（入口 abort 在派发前返回）——与上一用例构成两分支判别对');
});

test('apply（派发门控）：未派发 todo_write 不刷新快照', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: fixtureRoots(t, {
    Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.mjs'], timeoutMs: 5000 }] }],
    PostToolUse: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/post.mjs'], timeoutMs: 5000 }] }],
  }, { 'hooks/stop.mjs': STOP_OK, 'hooks/post.mjs': '' }) });
  const gateA = makeAgent('sess-gate-a');
  const gateB = makeAgent('sess-gate-b');
  const execA = { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: gateA.agent };
  const execB = { name: 'todo_write', arguments: { todos: [todo('b', 'pending')] }, agent: gateB.agent };
  await ctx.emit('tools/execute', execA, next);
  await ctx.emit('tools/post-execute', execB, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent: gateB.agent });
  assert.equal(gateB.steered.length, 0, '未派发 execB 不刷新快照、不续跑');
  const { agent, steered } = makeAgent('sess-gate-ok');
  const execC = { name: 'todo_write', arguments: { todos: [todo('c', 'pending')] }, agent };
  await ctx.emit('tools/execute', execC, next);
  await ctx.emit('tools/post-execute', execC, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 1, '同对象已派发 + 成功后应续跑');
});

test('driver：6+ 未完成项时提醒最多列 5 条并计数余量', () => {
  const d = createLongTaskDriver();
  const items = Array.from({ length: 6 }, (_, i) => todo(`t${i}`, 'pending'));
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: items } });
  const plan = d.shouldSteer({ sessionId: 's1', now: 1000 });
  assert.ok(plan);
  assert.match(plan.text, /另有 1 项/);
  const shown = plan.text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(shown.length, 5, '只列 5 条');
});

test('driver：会话累计 10 次上限后不再续跑', () => {
  const d = createLongTaskDriver({ maxPerTurn: 10, cooldownMs: 0 });
  for (let i = 0; i < 10; i += 1) {
    d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo(`t${i}`, 'pending')] } });
    const plan = d.shouldSteer({ sessionId: 's1', now: i + 1 });
    assert.ok(plan, `第 ${i + 1} 次应可续跑`);
    plan.commit();
  }
  d.observeTool({ sessionId: 's1', toolName: 'todo_write', args: { todos: [todo('t-last', 'pending')] } });
  assert.equal(d.shouldSteer({ sessionId: 's1', now: 1000 }), undefined, '会话 10 次上限');
});

test('apply：agent.steer 缺失时 warn 且不续跑', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const { agent, steered } = makeAgent('sess-no-steer');
  delete agent.steer;
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent });
  assert.equal(steered.length, 0);
  assert.ok(ctx.warnings().some((w) => /无可用的 agent\.steer/.test(String(w))));
});

test('apply：无 goals 服务时 logInfo 说明未启用', async (t) => {
  const ctx = makeCtx();
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  assert.ok(ctx.byLevel('info').some((m) => /长任务编排未启用/.test(String(m))));
});

test('apply：入口 signal.aborted 时不续跑', async (t) => {
  const ctx = makeCtx({ goals: { get: () => undefined } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const { agent, steered } = makeAgent('sess-entry-abort');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent, signal: { aborted: true } });
  assert.equal(steered.length, 0);
});

test('内部任务-272 plan 门控装配：Stop 主路径 plan-active 不续跑', async (t) => {
  const hooks = { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop-ok.mjs'], timeoutMs: 5000 }] }] };
  const suite = () => fixtureRoots(t, hooks, { 'hooks/stop-ok.mjs': STOP_OK });
  const onCtx = makeCtx({ goals: { get: () => undefined }, planMode: { get: () => ({ active: true }) } });
  await apply(onCtx, { pluginRoots: suite() });
  const on = makeAgent('sess-plan-stop-on');
  await onCtx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: on.agent }, { isError: false }, next);
  await onCtx.emit('agent/turn-stopping', { agent: on.agent });
  assert.equal(on.steered.length, 0, 'plan active：Stop 主路径不续跑');
  const offCtx = makeCtx({ goals: { get: () => undefined }, planMode: { get: () => ({ active: false }) } });
  await apply(offCtx, { pluginRoots: suite() });
  const off = makeAgent('sess-plan-stop-off');
  await offCtx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: off.agent }, { isError: false }, next);
  await offCtx.emit('agent/turn-stopping', { agent: off.agent });
  assert.equal(off.steered.length, 1, 'plan off：Stop 主路径续跑一次（差分）');
});

test('内部任务-272 plan 门控装配：LongTaskStop 回退 plan-active 不续跑', async (t) => {
  const onCtx = makeCtx({ goals: { get: () => undefined }, planMode: { get: () => ({ active: true }) } });
  await apply(onCtx, { pluginRoots: isolatedRoots(t) });
  const on = makeAgent('sess-plan-fallback-on');
  await onCtx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: on.agent }, { isError: false }, next);
  await onCtx.emit('agent/turn-stopping', { agent: on.agent });
  assert.equal(on.steered.length, 0, 'plan active：LongTaskStop 回退不续跑');
  const offCtx = makeCtx({ goals: { get: () => undefined }, planMode: { get: () => ({ active: false }) } });
  await apply(offCtx, { pluginRoots: isolatedRoots(t) });
  const off = makeAgent('sess-plan-fallback-off');
  await offCtx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: off.agent }, { isError: false }, next);
  await offCtx.emit('agent/turn-stopping', { agent: off.agent });
  assert.equal(off.steered.length, 1, 'plan off：LongTaskStop 回退续跑一次（差分）');
});

test('内部任务-273 H-04：goalOwnsContinuation 三态矩阵（active/activation/paused/blocked/complete/形状异常）', async () => {
  const { goalOwnsContinuation } = await import('../src/long-task-driver.mjs');
  assert.equal(goalOwnsContinuation(null), 'free', 'clear 后 get() 返回空 ⇒ free');
  assert.equal(goalOwnsContinuation(undefined), 'free');
  assert.equal(goalOwnsContinuation({ id: 'g', phase: 'active', activation: 'armed' }), 'owns');
  assert.equal(goalOwnsContinuation({ id: 'g', phase: 'active' }), 'owns', '缺 activation 按 fail-yield 让位（旧宿主安全方向）');
  assert.equal(goalOwnsContinuation({ id: 'g', phase: 'active', activation: 'disarmed' }), 'free', 'active+disarmed 无宿主轮接管 ⇒ 恢复 todo');
  for (const phase of ['paused', 'blocked', 'complete']) {
    assert.equal(goalOwnsContinuation({ id: 'g', phase }), 'free', `${phase} 不再让位`);
  }
  assert.equal(goalOwnsContinuation({}), 'unknown', '空对象/phase 缺失 ⇒ unknown（让位＋warn）');
  assert.equal(goalOwnsContinuation({ phase: 3 }), 'unknown', 'phase 非字符串 ⇒ unknown');
  assert.equal(goalOwnsContinuation({ phase: '' }), 'unknown', 'phase 空串 ⇒ unknown');
  assert.equal(goalOwnsContinuation('active'), 'unknown', '非对象 ⇒ unknown');
});

test('内部任务-273 H-04：goal complete 后恢复 todo 续跑（apply 级；旧 Boolean(get()) 判据下必红）', async (t) => {
  const ctx = makeCtx({ goals: { get: () => ({ id: 'g', phase: 'complete', activation: 'disarmed' }) } });
  await apply(ctx, { pluginRoots: isolatedRoots(t) });
  const g = makeAgent('sess-goal-complete');
  await ctx.emit('tools/post-execute', { name: 'todo_write', arguments: { todos: [todo('a', 'pending')] }, agent: g.agent }, { isError: false }, next);
  await ctx.emit('agent/turn-stopping', { agent: g.agent });
  assert.equal(g.steered.length, 1, 'complete goal 不再让位：todo 续跑恢复');
});
