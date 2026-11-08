// 文件：config-surface.test.mjs
// 描述：DSH 配置面宿主半侧测试（内部任务-201 / 内部决策-057）——Config.agentControlBridge 的 volatile 语义、
//       apply 恒装配 agent/created 监听、attachAgentControl 的 isEnabled 创建时门控与 fail-open、
//       以及测试注入缝（普通布尔/伪 volatile 引用）。RED 阶段预期失败 5 项（①-④、⑥），⑤ 为兼容项。
//       内部任务-220 增桥接首轮通道提示装配级面（⑦ 注入一次＋logInfo＋reject 直通、⑧ 关闭态零注入/开→关/空 sid 不投
//       且一次性 warn、⑨ agents 缺失动态文案）——三项随 内部任务-220 加入。
// 作者：wangp  创建：2026-10-22  版权：MIT（见仓库 LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testEngine } from './helpers/engine-binding.mjs';
import { Config, apply } from '../src/index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
import * as bridge from '../src/agent-control-bridge.mjs';
import { enabledPluginsOf, isOsObservationEnabled, PLUGIN_TOGGLE_FIELDS, unwrapVolatile } from '../src/config-toggles.mjs';

testEngine();

const TOOL_NAMES = ['list_subagents', 'message_subagent', 'wait_subagent'].sort();
const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

/**
 * 六个插件的显式空目录根：apply 型用例用它隔离真实 hooks（空 `{}` 不会屏蔽同级发现）。
 * @param {import('node:test').TestContext} t node:test 上下文（注册清理）
 * @returns {Record<string, string>} 插件名 → 临时空目录
 */
function sixInvalidRoots(t) {
  const roots = {};
  for (const plugin of PLUGINS) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-201-roots-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    roots[plugin] = dir;
  }
  return roots;
}

/** 复刻宿主 tools.register 的最小注册表。 */
function makeTools() {
  const registry = new Map();
  return {
    registry,
    register(def) {
      if (typeof def?.name !== 'string' || def.name === '') throw new TypeError('tool name required');
      if (def.output === undefined || typeof def.output.render !== 'function') throw new TypeError('output.render required');
      registry.set(def.name, def);
      return () => registry.delete(def.name);
    },
  };
}

/** 复刻宿主 subagents 服务的最小面。 */
function makeSubagents() {
  return {
    listChildren: () => [],
    sendMessage: async () => 'inbox-1',
  };
}

/** 复刻宿主 agents 服务的最小面。 */
function makeAgents() {
  return { get: () => undefined };
}

/**
 * 构造 apply 所需的最小 fake ctx（按事件收集监听器数组，emit 遍历全部）。
 * @param {object} [opts] 服务注入
 * @param {object} [opts.tools] agent scope tools（缺省新建）
 * @param {object} [opts.subagents] subagents 服务（缺省新建）
 * @param {object} [opts.agents] agents 服务（缺省新建）
 * @returns {object} fake ctx
 */
function makeApplyCtx(options = {}) {
  const tools = 'tools' in options ? options.tools : makeTools();
  const subagents = 'subagents' in options ? options.subagents : makeSubagents();
  const agents = 'agents' in options ? options.agents : makeAgents();
  const listeners = new Map();
  const logger = {
    infos: [],
    warns: [],
    // cordis logger 是 printf 风格（logLine 以 ('%s', 正文) 调用）：替身取正文实参，供断言 grep。
    info(format, ...args) { this.infos.push(args.length > 0 ? args.map(String).join(' ') : String(format)); },
    warn(format, ...args) { this.warns.push(args.length > 0 ? args.map(String).join(' ') : String(format)); },
    error(format, ...args) { this.warns.push(args.length > 0 ? args.map(String).join(' ') : String(format)); },
  };
  const services = new Map([['shell', {}], ['subagents', subagents], ['agents', agents], ...Object.entries(options.services ?? {})]);  return {
    tools,
    logger,
    listeners,
    get: (name) => services.get(name),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    effect(fn) {
      fn();
    },
  };
}

/**
 * 触发 fake ctx 上的全部 agent/created 监听器（无监听器时如实失败）。
 * @param {object} ctx fake ctx
 * @param {object} agent created 负载里的 agent
 * @returns {Promise<void>}
 */
async function emitCreated(ctx, agent) {
  const fns = ctx.listeners.get('agent/created') ?? [];
  assert.ok(fns.length > 0, 'apply 后应存在 agent/created 监听器（恒装配）');
  for (const fn of fns) await fn({ agent, source: 'startup' });
}

test('① Config 默认：agentControlBridge 为 volatile 引用且 get()===false，其余四字段为普通值', () => {
  const schema = Config({});
  assert.equal(typeof schema.agentControlBridge, 'object');
  assert.equal(typeof schema.agentControlBridge.get, 'function', 'agentControlBridge 应为 volatile 引用');
  assert.equal(schema.agentControlBridge.get(), false);
  assert.deepEqual(schema.pluginRoots, {});
  assert.equal(schema.projectDir, '');
  assert.equal(schema.startTurn, true);
  assert.equal(schema.mountAgents, false);
});

test('② Config 显式 true：.get()===true；非法类型仍被拒（expected boolean）', () => {
  assert.equal(Config({ agentControlBridge: true }).agentControlBridge.get(), true);
  assert.throws(() => Config({ agentControlBridge: 'yes' }), /expected boolean/);
});

test('③ schema 序列化：agentControlBridge 带 volatile 元数据，其余四字段不带', () => {
  // schemastery 的 toJSON 是「uid + refs 池」形态：根引用由 `uid` 指向，字段引用在根 `dict` 里。
  const json = JSON.parse(JSON.stringify(Config.toJSON()));
  const root = json.refs[String(json.uid)];
  assert.ok(root !== undefined, 'schema JSON 应有根引用（refs[uid]）');
  const refOf = (field) => json.refs[String(root.dict[field])];
  assert.equal(refOf('agentControlBridge')?.meta?.volatile, true, 'agentControlBridge 应声明 volatile 元数据');
  for (const field of ['pluginRoots', 'projectDir', 'startTurn', 'mountAgents']) {
    assert.notEqual(refOf(field)?.meta?.volatile, true, `${field} 不应含 volatile 元数据`);
  }
});

test('④ attachAgentControl：isEnabled 创建时判定（false 零注册/true 注册/抛错 fail-open 不抛）；apply 关闭态也恒装配带标记监听', async (t) => {
  const ctx = makeApplyCtx();
  const tools = makeTools();
  const warns = [];
  let enabled = false;
  let throwMode = false;
  const tag = Symbol.for('ai-coding-methodology.agent-control-listener');
  const dispose = bridge.attachAgentControl(ctx, {
    isEnabled: () => {
      if (throwMode) throw new Error('boom');
      return enabled;
    },
    getServices: () => ({ tools, subagents: makeSubagents(), agents: makeAgents() }),
    warn: (m) => warns.push(String(m)),
  });
  const created = ctx.listeners.get('agent/created') ?? [];
  assert.equal(created.length, 1, '装配应注册一条 agent/created 监听');
  assert.ok(created.some((fn) => fn?.[tag] === true), '桥接监听应带 AGENT_CONTROL_LISTENER_TAG 标记');

  await emitCreated(ctx, { id: 'a1', ctx: { get: () => tools } });
  assert.equal(tools.registry.size, 0, 'isEnabled=false 时不得注册工具');

  enabled = true;
  await emitCreated(ctx, { id: 'a2', ctx: { get: () => tools } });
  assert.deepEqual([...tools.registry.keys()].sort(), TOOL_NAMES, 'isEnabled=true 时应注册三工具');

  throwMode = true;
  await emitCreated(ctx, { id: 'a3', ctx: { get: () => tools } });
  await emitCreated(ctx, { id: 'a4', ctx: { get: () => tools } });
  assert.equal(tools.registry.size, 3, 'isEnabled 抛错时不得改动既有注册');
  assert.equal(warns.filter((m) => m.includes('启用判定失败')).length, 1, 'isEnabled 抛错应只告警一次（warnOnce fail-open）');
  dispose();

  // 恒装配：默认配置（关闭）下 apply 也必须挂带标记的桥接监听（内部决策-057 决策 2；UI 保存后才可能变为 true）。
  const applyCtx = makeApplyCtx();
  await apply(applyCtx, { pluginRoots: sixInvalidRoots(t) });
  const applied = applyCtx.listeners.get('agent/created') ?? [];
  assert.ok(applied.some((fn) => fn?.[tag] === true), 'apply 在默认关闭态也必须挂带标记的桥接监听（恒装配）');
  await emitCreated(applyCtx, { id: 'root-off', ctx: { get: (name) => (name === 'tools' ? applyCtx.tools : undefined) } });
  assert.equal(applyCtx.tools.registry.size, 0, '默认关闭时 created 不得注册工具');
});

test('⑤ apply 兼容项：普通布尔注入缝 true + 六空根 → created 时注册三工具（改前即绿）', async (t) => {
  const ctx = makeApplyCtx();
  await apply(ctx, { agentControlBridge: true, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctx, { id: 'root-1', ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  assert.deepEqual([...ctx.tools.registry.keys()].sort(), TOOL_NAMES);
});

test('⑥ apply 读取 volatile 当前值：创建时读引用（保存后新会话生效的回归锁；改前为 0 → RED）＋unwrapVolatile 解包边界直测（M-18 单源）', async (t) => {
  const ctx = makeApplyCtx();
  const flag = { value: false };
  const ref = { get: () => flag.value };
  await apply(ctx, { agentControlBridge: ref, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctx, { id: 'root-1', ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  assert.equal(ctx.tools.registry.size, 0, '引用当前值 false → 零注册');

  // 差分锁：值在 apply 之后变化（模拟 settings 保存后 loader 原地提交 volatile 引用），
  // 创建时必须读到新值——若实现把 apply 时的值固化，这里会红。
  flag.value = true;
  await emitCreated(ctx, { id: 'root-2', ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  assert.deepEqual([...ctx.tools.registry.keys()].sort(), TOOL_NAMES, '引用当前值 true → 应注册三工具（创建时读取，不是 apply 时快照）');

  // M-18（内部未决-245）：volatile 解包单源直测——`config-toggles.unwrapVolatile` 是解包谓词唯一实现，
  // index 的 isAgentControlBridgeEnabled 与 isPluginEnabled/isOsObservationEnabled 共用同一解包形态。
  // 本段是 RED 面：导出不存在时本文件加载失败（RED 证据见执行台账）。
  assert.equal(unwrapVolatile(true), true, '普通布尔原样返回');
  assert.equal(unwrapVolatile(false), false, '普通 false 原样返回');
  assert.equal(unwrapVolatile(undefined), undefined, '缺省原样返回（不补 false）');
  assert.equal(unwrapVolatile(null), null, 'null 原样返回');
  assert.equal(unwrapVolatile({ get: () => true }), true, '带 get() 的 volatile 引用取当前值');
  assert.equal(unwrapVolatile({ get: () => false }), false, '带 get() 的 volatile 引用取 false');
  assert.equal(unwrapVolatile({ get: () => 'yes' }), 'yes', 'get() 非布尔值原样返回（布尔语义由调用方比较）');
  const plainObject = { notVolatile: 1 };
  assert.equal(unwrapVolatile(plainObject), plainObject, '无 get() 的对象原样返回（不猜）');
});

// ── 内部任务-220：首轮桥接通道提示（装配级差分 + 动态文案 + 关闭态恒装配） ─────────────

const HINT_MARK = '【桥接工具面已启用】';

/**
 * 触发 fake ctx 的 agent/pre-step 监听链（按 cordis waterfall 语义：后注册者为内层，next() 返回下游决策）。
 * @param {object} ctx fake apply ctx
 * @param {object} agent pre-step 负载中的 agent
 * @param {object} downstream 初始 enter 决策（含 messages）
 * @returns {Promise<object>} 链末决策
 */
async function emitPreStep(ctx, agent, downstream) {
  const fns = ctx.listeners.get('agent/pre-step') ?? [];
  let decision = downstream;
  for (let i = fns.length - 1; i >= 0; i -= 1) {
    decision = await fns[i]({ agent }, async () => decision);
  }
  return decision;
}

/** 从决策 messages 中找桥接提示（无则返回 null）。 */
function findHint(messages) {
  return (Array.isArray(messages) ? messages : []).find((m) => JSON.stringify(m ?? {}).includes(HINT_MARK)) ?? null;
}

test('内部任务-220 ⑦ apply：桥接开启 → 首轮 pre-step 注入一次桥接通道提示；同会话不重复', async (t) => {
  const ctx = makeApplyCtx();
  await apply(ctx, { agentControlBridge: true, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctx, { id: 'root-1', session: { header: { id: 'sid-1' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const agent = { id: 'root-1', delegationDepth: 0, session: { header: { id: 'sid-1' } } };
  const first = await emitPreStep(ctx, agent, { kind: 'enter', messages: [] });
  const hint = findHint(first.messages);
  assert.ok(hint !== null, '首轮 pre-step 应注入桥接通道提示');
  const text = JSON.stringify(hint);
  for (const anchor of ['可续', '续聊复用', '不作计划/代码复审通道', '再水化']) {
    assert.ok(text.includes(anchor), `提示缺要素：${anchor}`);
  }
  assert.ok(ctx.logger.infos.some((m) => m.includes('桥接通道提示已投递 session=sid-1')), '成功投递必须记 logInfo（真机批复盘锚）');
  const second = await emitPreStep(ctx, agent, { kind: 'enter', messages: [] });
  assert.equal(findHint(second.messages), null, 'once：同会话第二次 pre-step 不再重复注入');
  // 内部任务-220：reject 决策原样返回（用「已注册但尚未投递」的新 sid 构造，保证断言有判别力）
  await emitCreated(ctx, { id: 'root-2', session: { header: { id: 'sid-2' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const rejected = await emitPreStep(ctx, { id: 'root-2', delegationDepth: 0, session: { header: { id: 'sid-2' } } }, { kind: 'reject', reason: 'blocked' });
  assert.equal(rejected.kind, 'reject');
  assert.equal(rejected.reason, 'blocked');
  assert.equal(rejected.messages, undefined, 'reject 不追加提示');
});

test('内部任务-220 ⑧ apply：桥接关闭/注册失败 → pre-step 监听在位但不注入（不得空转）；开→关后新会话零注入', async (t) => {
  const ctx = makeApplyCtx();
  const flag = { value: false };
  await apply(ctx, { agentControlBridge: { get: () => flag.value }, pluginRoots: sixInvalidRoots(t) });
  assert.ok((ctx.listeners.get('agent/pre-step') ?? []).length > 0, '关闭态也必须装配 BridgeChannelHint 监听（恒装配，非空转由 gate 判定）');
  await emitCreated(ctx, { id: 'root-1', session: { header: { id: 'sid-1' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const off = await emitPreStep(ctx, { id: 'root-1', delegationDepth: 0, session: { header: { id: 'sid-1' } } }, { kind: 'enter', messages: [] });
  assert.equal(findHint(off.messages), null, '关闭态不得注入提示');
  // 开→关：root-2 在关闭值下创建 → 不注册且不注入（不得因 apply 级布尔残留误注入）
  flag.value = true;
  await emitCreated(ctx, { id: 'root-2', session: { header: { id: 'sid-2' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const on = await emitPreStep(ctx, { id: 'root-2', delegationDepth: 0, session: { header: { id: 'sid-2' } } }, { kind: 'enter', messages: [] });
  assert.ok(findHint(on.messages) !== null, '已注册会话应注入');
  flag.value = false;
  await emitCreated(ctx, { id: 'root-3', session: { header: { id: 'sid-3' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const offNew = await emitPreStep(ctx, { id: 'root-3', delegationDepth: 0, session: { header: { id: 'sid-3' } } }, { kind: 'enter', messages: [] });
  assert.equal(findHint(offNew.messages), null, '关闭值下新建会话未注册 → 不得注入（per-session 注册事实门控）');
  // 内部任务-220：开值下空 sid 会话——注册事实不登记（不写 Map）、不投递、一次性 warn（apply 生命周期至多一条）
  flag.value = true;
  await emitCreated(ctx, { id: 'root-4', ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  await emitCreated(ctx, { id: 'root-5', ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  const emptySid = await emitPreStep(ctx, { id: 'root-4', delegationDepth: 0 }, { kind: 'enter', messages: [] });
  assert.equal(findHint(emptySid.messages), null, '空 sid 不得投递（防跨会话串投）');
  const bridgeSidWarns = ctx.logger.warns.filter((w) => /桥接工具面已注册但会话 id 缺失/.test(String(w)));
  assert.equal(bridgeSidWarns.length, 1, '空 sid 注册告警在 apply 生命周期内一次性（两次空 sid created 只一条）');
});

test('内部任务-220 ⑨ apply：agents 服务缺失 → 提示文案按实际注册工具动态（不含 wait_subagent/可等待）', async (t) => {
  const ctx = makeApplyCtx({ agents: undefined });
  await apply(ctx, { agentControlBridge: true, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctx, { id: 'root-1', session: { header: { id: 'sid-1' } }, ctx: { get: (name) => (name === 'tools' ? ctx.tools : undefined) } });
  assert.equal(ctx.tools.registry.has('wait_subagent'), false, 'agents 缺失时 wait 不应注册');
  const decision = await emitPreStep(ctx, { id: 'root-1', delegationDepth: 0, session: { header: { id: 'sid-1' } } }, { kind: 'enter', messages: [] });
  const hint = findHint(decision.messages);
  assert.ok(hint !== null, '仍应注入提示');
  const text = JSON.stringify(hint);
  assert.equal(text.includes('wait_subagent'), false, '无 wait 注册时不得宣称 wait_subagent');
  assert.equal(text.includes('可等待'), false, '无 wait 注册时不得宣称「可等待」');
});

test('⑩ 切换不回收既有注册：开值建 A→关值建 B，A 仍 3、B 为 0（O2 补强；改前即绿，锁 R-da-13 既有事实）', async (t) => {
  const flag = { value: true };
  const ctxA = makeApplyCtx();
  await apply(ctxA, { agentControlBridge: { get: () => flag.value }, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctxA, { id: 'A', delegationDepth: 0, ctx: { get: (name) => (name === 'tools' ? ctxA.tools : undefined) } });
  assert.equal(ctxA.tools.registry.size, 3, '开值建 A 应注册三工具');
  flag.value = false;
  const ctxB = makeApplyCtx();
  await apply(ctxB, { agentControlBridge: { get: () => flag.value }, pluginRoots: sixInvalidRoots(t) });
  await emitCreated(ctxB, { id: 'B', delegationDepth: 0, ctx: { get: (name) => (name === 'tools' ? ctxB.tools : undefined) } });
  assert.equal(ctxB.tools.registry.size, 0, '关值建 B 零注册');
  assert.equal(ctxA.tools.registry.size, 3, 'A 的既有注册不回收（切换只影响新建 agent）');
});

test('内部任务-268 配置面 v2：字段默认与 apply 四面过滤', () => {
  const schema = Config({});
  const defaults = {
    pluginWorkflow: true,
    pluginSpecGate: true,
    pluginScout: false,
    pluginTeamGovernance: false,
    pluginAlgoLoop: false,
    pluginResearchLoop: false,
    osObservation: true,
  };
  assert.deepEqual(Object.keys(PLUGIN_TOGGLE_FIELDS).length, 6, '插件开关字段映射应有 6 项');
  for (const [field, expected] of Object.entries(defaults)) {
    assert.equal(typeof schema[field], 'object', `${field} 应存在`);
    assert.equal(typeof schema[field].get, 'function', `${field} 应为 volatile 引用`);
    assert.equal(schema[field].get(), expected, `${field} 默认值`);
  }
  const json = JSON.parse(JSON.stringify(Config.toJSON()));
  const root = json.refs[String(json.uid)];
  for (const field of Object.keys(defaults)) {
    assert.equal(json.refs[String(root.dict[field])]?.meta?.volatile, true, `${field} 应声明 volatile 元数据`);
  }
  // 生产形态（Config({}) 的 volatile refs）也必须过滤为核心两插件，防止 volatile 解包（unwrapVolatile）漂移把生产全开关掉。
  assert.deepEqual(enabledPluginsOf(Config({})), ['workflow', 'spec-gate']);
  // 过滤语义（缺字段=开 兼容裸 config；显式 false 才关闭）
  assert.deepEqual(enabledPluginsOf({}), ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);
  assert.deepEqual(
    enabledPluginsOf({ pluginWorkflow: true, pluginSpecGate: true, pluginScout: false, pluginTeamGovernance: false, pluginAlgoLoop: false, pluginResearchLoop: false }),
    ['workflow', 'spec-gate'],
  );
  assert.equal(isOsObservationEnabled({ osObservation: false }), false);
  assert.equal(isOsObservationEnabled({}), true);
});

test('内部任务-268 配置面 v2：apply 按插件开关过滤四面', async () => {
  // 真实插件根（仓库六插件目录）：可区分「开→注册」与「关→零注册」；不再用六空根（空根恒零、零判别力）。
  const realRoots = Object.fromEntries(PLUGINS.map((plugin) => [plugin, join(REPO_ROOT, plugin)]));
  const toggleConfig = (enabled) =>
    Object.fromEntries(PLUGINS.map((plugin) => [PLUGIN_TOGGLE_FIELDS[plugin], enabled.includes(plugin)]));
  const makeRegistry = () => ({ items: [], register(def) { this.items.push(def); return () => {}; } });
  // 全关：钩子/skill/命令四面零注册且 apply 不失败（agent 面 mountAgents=true 也不挂）；日志点名全部未启用。
  const skillsOff = makeRegistry();
  const commandsOff = makeRegistry();
  const allOffCtx = makeApplyCtx({ services: { skills: skillsOff, commands: commandsOff } });
  await apply(allOffCtx, { pluginRoots: realRoots, mountAgents: true, ...toggleConfig([]) });
  assert.equal((allOffCtx.listeners.get('tools/pre-execute') ?? []).length, 0, '全关：钩子面零注册');
  assert.equal((allOffCtx.listeners.get('tools/post-execute') ?? []).length, 0, '全关：PostToolUse 面零注册');
  assert.equal(skillsOff.items.length, 0, '全关：skill 面零注册');
  assert.equal(commandsOff.items.length, 0, '全关：命令面零注册');
  assert.ok(allOffCtx.logger.infos.some((line) => line.includes('全部插件未启用')), '全关时必须 logInfo 可见');
  // 仅核心两插件：钩子/skill/命令面恢复注册；关闭的插件（scout 等）不参与。
  const skillsCore = makeRegistry();
  const commandsCore = makeRegistry();
  const coreCtx = makeApplyCtx({ services: { skills: skillsCore, commands: commandsCore } });
  await apply(coreCtx, { pluginRoots: realRoots, ...toggleConfig(['workflow', 'spec-gate']) });
  assert.ok((coreCtx.listeners.get('tools/pre-execute') ?? []).length > 0, '仅核心两插件：钩子面注册（spec-gate PreToolUse 存在）');
  assert.ok(skillsCore.items.length > 0, '仅核心两插件：skill 面注册');
  assert.ok(commandsCore.items.length > 0, '仅核心两插件：命令面注册');
  assert.ok(coreCtx.logger.infos.some((line) => line.includes('未启用插件') && line.includes('scout')), '关闭插件必须列在日志中');
});
