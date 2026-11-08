// 文件：agent-control-bridge.test.mjs
// 描述：F2 适配层桥接工具（内部任务-189）单测——fake host 桩覆盖 内部证据-2 失败路径表与 内部证据-4 矩阵：
//       注册面（仅 depth=0、output 契约、disposer 幂等）、list 映射、message 成功/错误映射、
//       wait 轮询/超时/并发/定时器清理、无服务 fail-open、装配级 created 接线；
//       内部任务-220 增首轮通道提示面（文案四要素/动态工具名、gate 门控四态、registeredTools、工具描述）。
//       纪律：仅 node: 内置模块；fake host 复刻真实 host 的 register 约束（缺 output 必抛 TypeError）。
// 作者：wangp  创建：2026-10-21  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachAgentControl,
  bridgeChannelHintText,
  buildToolDefinitions,
  createBridgeHintGate,
  registerAgentControlTools,
  renderContent,
  TOOL_NAMES,
} from '../src/agent-control-bridge.mjs';

/** 复刻宿主 tools.register 的最小约束：name 非空、output{schema,render} 必填、重名拒绝。 */
function makeFakeTools() {
  const registry = new Map();
  return {
    registry,
    view() {
      return [...registry.entries()].map(([name, def]) => ({ name, description: def.description, parameters: def.parameters }));
    },
    register(def) {
      if (typeof def.name !== 'string' || def.name === '') throw new TypeError('tool name required');
      if (def.name === 'run_code') throw new Error('reserved');
      if (registry.has(def.name)) throw new Error(`duplicate tool "${def.name}"`);
      if (def.output === undefined || typeof def.output !== 'object' || typeof def.output.render !== 'function') {
        throw new TypeError(`tool "${def.name}" must declare output { schema, render, presentationMeta? }`);
      }
      registry.set(def.name, def);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        registry.delete(def.name);
      };
    },
  };
}

function makeFakeSubagents({ children = [], sendError } = {}) {
  return {
    calls: { list: [], send: [] },
    listChildren(parentSessionId) {
      this.calls.list.push(parentSessionId);
      if (parentSessionId !== 'root-1') return children;
      return children;
    },
    async sendMessage(sender, targetId, content, options) {
      this.calls.send.push({ sender, targetId, content, options });
      if (sendError !== undefined) throw sendError;
      return 'inbox-1';
    },
  };
}

function makeFakeAgents(statuses = {}) {
  return {
    get(agentId) {
      const status = statuses[agentId];
      return status === undefined ? undefined : { id: agentId, status };
    },
  };
}

function setup(overrides = {}) {
  const tools = 'tools' in overrides ? overrides.tools : makeFakeTools();
  const subagents = 'subagents' in overrides ? overrides.subagents : makeFakeSubagents();
  const agents = 'agents' in overrides ? overrides.agents : makeFakeAgents();
  const warns = [];
  const result = registerAgentControlTools({
    tools,
    subagents,
    agents,
    parentSessionId: 'root-1',
    warn: (msg) => warns.push(msg),
  });
  return { tools, subagents, agents, warns, ...result };
}

test('注册面：三工具名/参数 schema/output 契约齐备；disposer 幂等', () => {
  const { tools, disposer } = setup();
  assert.deepEqual(tools.view().map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools.view()) {
    assert.ok(t.description.length > 0, `${t.name} 需描述`);
    assert.equal(t.parameters.type, 'object', `${t.name} 参数应为 object 根`);
  }
  // 输出 schema 必须声明实际返回字段（宿主对成功结果做 validateJsonSchemaValue：
  // 只写 {type,additionalProperties:false} 而无 properties ⇒ 真实返回值全判违规）
  const list = tools.registry.get('list_subagents');
  assert.equal(list.output.schema.type, 'array');
  assert.deepEqual(Object.keys(list.output.schema.items.properties).sort(), ['continuable', 'createdAt', 'id', 'label', 'mode']);
  assert.deepEqual(list.output.schema.items.required.sort(), ['continuable', 'createdAt', 'id', 'mode']);
  const message = tools.registry.get('message_subagent');
  assert.deepEqual(message.output.schema.properties, { messageId: { type: 'string' } });
  assert.deepEqual(message.output.schema.required, ['messageId']);
  const wait = tools.registry.get('wait_subagent');
  for (const key of ['status', 'hostStatus', 'reason', 'elapsedMs']) {
    assert.ok(wait.output.schema.properties[key], `wait 输出须声明 ${key}`);
  }
  assert.deepEqual(wait.output.schema.required, ['status']);
  disposer();
  disposer(); // 幂等
  assert.equal(tools.view().length, 0);
});

test('fail-open：无 subagents 服务 → 不注册、warn 一次、返回 registered 0', () => {
  const dir = setup({ subagents: undefined });
  assert.equal(dir.registered, 0);
  assert.equal(dir.warns.length, 1);
  assert.equal(dir.tools.view().length, 0);
});

test('fail-open：无 agents 服务 → wait 不注册或返回明确错误（不得伪装 finished）', async () => {
  const { tools, disposer, registered } = setup({ agents: undefined });
  assert.ok(registered < TOOL_NAMES.length, 'wait_subagent 依赖 agents，服务缺席应少注册');
  const names = tools.view().map((t) => t.name);
  assert.ok(names.includes('list_subagents') && names.includes('message_subagent'));
  assert.equal(names.includes('wait_subagent'), false);
  disposer();
});

test('装配级接线：attachAgentControl 注册 created 监听器，仅 depth=0 触发注册，disposer 幂等', () => {
  const listeners = [];
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'agent/created');
      listeners.push(handler);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const i = listeners.indexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  const tools = makeFakeTools();
  const subagents = makeFakeSubagents();
  const agents = makeFakeAgents();
  const registeredFor = [];
  // 注册 scope 契约：tools 必须来自**该 agent 的 ctx**（agent scope），不是插件全局 ctx
  const agentCtxRegistries = [];
  const dispose = attachAgentControl(ctx, {
    getServices: (agent) => {
      const registryForAgent = makeFakeTools();
      agentCtxRegistries.push(registryForAgent);
      agent.ctx = { get: (name) => (name === 'tools' ? registryForAgent : undefined) };
      return { tools: agent.ctx.get('tools'), subagents, agents };
    },
    onRegistered: (agent, result) => registeredFor.push([agent.id, [...result.registeredTools]]),
    warn: () => {},
  });
  assert.equal(listeners.length, 1);
  listeners[0]({ agent: { id: 'root-1', delegationDepth: 0 } });
  assert.deepEqual(registeredFor, [['root-1', [...TOOL_NAMES]]], 'onRegistered(agent, result) 应带实际注册工具名');
  assert.equal(agentCtxRegistries[0].view().length, 3, '注册必须落在该 agent 的 tools registry');
  assert.equal(tools.view().length, 0, '不得落在插件全局 registry');
  listeners[0]({ agent: { id: 'child-1', delegationDepth: 1 } });
  assert.deepEqual(registeredFor, [['root-1', [...TOOL_NAMES]]], '子代理 depth≠0 不注册');
  listeners[0]({}); // 无 agent 的畸形 payload 不得抛
  dispose();
  dispose(); // 幂等
  assert.equal(listeners.length, 0);
});

test('list_subagents：返回 {id,label,mode,continuable,createdAt}，不臆造 status/title', async () => {
  const subagents = makeFakeSubagents({
    children: [
      { id: 'c1', label: '探索者', mode: 'continuable', createdAt: 1 },
      { id: 'c2', mode: 'one-shot', createdAt: 2 },
    ],
  });
  const { tools, subagents: got, disposer } = setup({ subagents });
  const tool = tools.registry.get('list_subagents');
  const value = await tool.execute({}, { agent: { id: 'root-1' } });
  assert.equal(got.calls.list[0], 'root-1');
  assert.deepEqual(value[0], { id: 'c1', label: '探索者', mode: 'continuable', continuable: true, createdAt: 1 });
  assert.equal(value[1].continuable, false);
  assert.equal(value[1].label, undefined);
  disposer();
});

test('message_subagent：sender=exec.agent、块数组、signal 透传、返回 {messageId}', async () => {
  const subagents = makeFakeSubagents();
  const { tools, disposer } = setup({ subagents });
  const exec = { agent: { id: 'root-1' }, signal: AbortSignal.abort() };
  const tool = tools.registry.get('message_subagent');
  const value = await tool.execute({ agent_id: 'c1', message: '回来复查' }, exec);
  assert.deepEqual(value, { messageId: 'inbox-1' });
  const call = subagents.calls.send[0];
  assert.equal(call.sender, exec.agent, 'sender 必须是 exact live Agent');
  assert.deepEqual(call.content, [{ type: 'text', text: '回来复查' }]);
  assert.equal(call.options.signal, exec.signal);
  assert.equal(call.targetId, 'c1');
  disposer();
});

test('message_subagent：UNAUTHORIZED/NOT_RESUMABLE/PERSISTENCE_UNAVAILABLE 映射为可读错误', async () => {
  for (const code of ['UNAUTHORIZED', 'NOT_RESUMABLE', 'PERSISTENCE_UNAVAILABLE']) {
    const err = new Error(code);
    err.code = code;
    const { tools, disposer } = setup({ subagents: makeFakeSubagents({ sendError: err }) });
    const tool = tools.registry.get('message_subagent');
    await assert.rejects(
      () => tool.execute({ agent_id: 'x1', message: 'm' }, { agent: { id: 'root-1' }, signal: AbortSignal.abort() }),
      (e) => {
        assert.match(e.message, new RegExp(code));
        assert.match(e.message, /仅本会话|direct|continuable/i);
        return true;
      },
      `错误码 ${code} 必须映射`,
    );
    disposer();
  }
});

test('message_subagent：空 message/缺 agent_id 参数校验', async () => {
  const { tools, disposer } = setup();
  const tool = tools.registry.get('message_subagent');
  await assert.rejects(() => tool.execute({ agent_id: 'c1', message: '' }, { agent: { id: 'root-1' }, signal: AbortSignal.abort() }));
  await assert.rejects(() => tool.execute({ message: 'm' }, { agent: { id: 'root-1' }, signal: AbortSignal.abort() }));
  disposer();
});

test('wait_subagent：非直接子代理 → UNAUTHORIZED（不得借 agents.get 观测他会话）', async () => {
  const subagents = makeFakeSubagents({ children: [{ id: 'mine', mode: 'continuable', createdAt: 1 }] });
  const { tools, disposer } = setup({ subagents, agents: makeFakeAgents({ other: 'running' }) });
  const tool = tools.registry.get('wait_subagent');
  await assert.rejects(
    () => tool.execute({ agent_id: 'other', timeout_ms: 50 }, { agent: { id: 'root-1' }, signal: new AbortController().signal }),
    /UNAUTHORIZED/,
  );
  disposer();
});

test('wait_subagent：已结束/回收/未知三态如实区分（不伪装 finished）', async () => {
  const subagents = makeFakeSubagents({ children: [{ id: 'gone', mode: 'continuable', createdAt: 1 }, { id: 'c2', mode: 'continuable', createdAt: 2 }] });
  // ① 从未以 running 出现过 → not-found（不冒充完成）
  const a = setup({ subagents, agents: makeFakeAgents({}) });
  const waitA = a.tools.registry.get('wait_subagent');
  assert.deepEqual(
    await waitA.execute({ agent_id: 'gone', timeout_ms: 50 }, { agent: { id: 'root-1' }, signal: new AbortController().signal }),
    { status: 'not-found', reason: 'no-live-agent' },
  );
  a.disposer();
  // ② 等待期间被宿主回收 → reclaimed（不得写 finished）
  const statuses = { c2: 'running' };
  const b = setup({ subagents, agents: makeFakeAgents(statuses) });
  const waitB = b.tools.registry.get('wait_subagent');
  const p = waitB.execute({ agent_id: 'c2', timeout_ms: 2000, interval_ms: 10 }, { agent: { id: 'root-1' }, signal: new AbortController().signal });
  setTimeout(() => { delete statuses.c2; }, 20);
  const reclaimed = await p;
  assert.equal(reclaimed.status, 'reclaimed');
  b.disposer();
});

test('wait_subagent：running→idle 即完成（宿主 Agent.status 仅 running/idle）', async () => {
  const subagents = makeFakeSubagents({ children: [{ id: 'c1', mode: 'continuable', createdAt: 1 }] });
  const statuses = { c1: 'running' };
  const { tools, disposer } = setup({ subagents, agents: makeFakeAgents(statuses) });
  const tool = tools.registry.get('wait_subagent');
  const p = tool.execute({ agent_id: 'c1', timeout_ms: 2000, interval_ms: 10 }, { agent: { id: 'root-1' }, signal: new AbortController().signal });
  setTimeout(() => { statuses.c1 = 'idle'; }, 20);
  const done = await p;
  assert.deepEqual(done, { status: 'finished', hostStatus: 'idle' });
  disposer();
});

test('wait_subagent：超时返回 timeout 不伪装 finished；调用方取消 → 明确取消错误', async () => {
  const subagents = makeFakeSubagents({ children: [{ id: 'c2', mode: 'continuable', createdAt: 2 }, { id: 'c9', mode: 'continuable', createdAt: 9 }] });
  const { tools, disposer } = setup({ subagents, agents: makeFakeAgents({ c2: 'running', c9: 'running' }) });
  const tool = tools.registry.get('wait_subagent');
  const timeout = await tool.execute({ agent_id: 'c2', timeout_ms: 50, interval_ms: 10 }, { agent: { id: 'root-1' }, signal: new AbortController().signal });
  assert.equal(timeout.status, 'timeout');
  await assert.rejects(
    () => tool.execute({ agent_id: 'c9', timeout_ms: 2000 }, { agent: { id: 'root-1' }, signal: AbortSignal.abort() }),
    /取消/,
  );
  disposer();
});

// 内部任务-339 T-06（内部未决-246，覆盖补齐——被测行为已存在，本用例钉判别力）：既有用例只测「调用前已取消」
// （AbortSignal.abort()）；本用例锁「running 中变 aborted」的迟滞路径（循环顶检查抛取消，迟滞≤interval，
// agent-control-bridge.mjs:309/:318——sleep 是纯 setTimeout 不响应 abort）与 wait 独立性（结果只由
// 调用方 signal 与子代理状态决定，不误报 timeout/finished）。
test('DEV-339 T-06：wait running 中 abort 循环顶抛取消（迟滞≤interval）；wait 只随调用方 signal 取消', async () => {
  const subagents = makeFakeSubagents({ children: [{ id: 'c1', mode: 'continuable', createdAt: 1 }] });
  const statuses = { c1: 'running' };
  const { tools, disposer } = setup({ subagents, agents: makeFakeAgents(statuses) });
  const tool = tools.registry.get('wait_subagent');
  // ① running 中 abort：signal 置位后下一轮循环顶（≤interval+slack）抛取消，不误走 timeout/finished
  const controller = new AbortController();
  const startedAt = Date.now();
  const p = tool.execute({ agent_id: 'c1', timeout_ms: 5000, interval_ms: 10 }, { agent: { id: 'root-1' }, signal: controller.signal });
  setTimeout(() => controller.abort(), 40); // 越过首个 interval 后置位
  await assert.rejects(
    () => p,
    (e) => /取消/.test(String(e?.message)) && Date.now() - startedAt < 5000,
    '循环顶须在下一轮（≤interval 迟滞）抛取消，不得等满 timeout',
  );
  assert.equal(statuses.c1, 'running', 'abort 不改写子代理状态（wait 只随调用方 signal 取消）');
  // ② 对照：不 abort、子代理恒 running ⇒ 到点如实 timeout（结果由调用方 signal 与子代理状态唯一决定）
  const timeout = await tool.execute({ agent_id: 'c1', timeout_ms: 60, interval_ms: 10 }, { agent: { id: 'root-1' }, signal: new AbortController().signal });
  assert.equal(timeout.status, 'timeout');
  disposer();
});

test('render 契约：output.render 返回宿主 Content 块数组（不是 string）', () => {
  const def = buildToolDefinitions({ subagents: makeFakeSubagents(), agents: makeFakeAgents(), parentSessionId: 'root-1' });
  const samples = {
    list_subagents: [{ id: 'c1', mode: 'continuable', continuable: true, createdAt: 1 }],
    message_subagent: { messageId: 'm1' },
    wait_subagent: { status: 'finished', hostStatus: 'idle' },
  };
  for (const tool of def) {
    const rendered = tool.output.render({}, samples[tool.name]);
    assert.ok(Array.isArray(rendered), `${tool.name} render 必须返回数组（宿主结果 content 契约是 Content[]）`);
    assert.ok(rendered.length > 0, `${tool.name} render 不得返回空数组`);
    for (const block of rendered) {
      assert.equal(block.type, 'text', `${tool.name} render 块须为 text（spill-policy 只识别 text/image）`);
      assert.equal(typeof block.text, 'string', `${tool.name} render 块 text 须为字符串`);
    }
    assert.deepEqual(JSON.parse(rendered.map((b) => b.text).join('')), samples[tool.name], `${tool.name} render 文本须可无损还原返回值`);
  }
  assert.deepEqual(renderContent({ ok: true }), [{ type: 'text', text: '{"ok":true}' }]);
});

// ── 内部任务-220：首轮桥接通道提示（文案/门控/注册工具名） ─────────────────────────

test('DEV-220 hint：文案含四要素（可续/续聊复用/不作计划与代码复审通道/再水化）且按 registeredTools 动态', () => {
  const full = bridgeChannelHintText({ registeredTools: ['list_subagents', 'message_subagent', 'wait_subagent'] });
  for (const anchor of ['可续', '续聊复用', '不作计划/代码复审通道', '再水化', 'docs/plans/agents-<任务号>.md']) {
    assert.ok(full.includes(anchor), `提示文案缺要素：${anchor}`);
  }
  assert.ok(full.includes('三工具可用'), '三工具齐全时首行应写「三工具可用」');
  assert.ok(full.includes('可等待'), 'wait 注册时第二 bullet 应含「可等待」');
  const partial = bridgeChannelHintText({ registeredTools: ['list_subagents', 'message_subagent'] });
  assert.equal(partial.includes('wait_subagent'), false, '无 wait 时首行不得宣称 wait_subagent');
  assert.equal(partial.includes('可等待'), false, '无 wait 时不得宣称「可等待」');
  assert.ok(partial.includes('两工具可用'), '两工具时应写「两工具可用」');
  const one = bridgeChannelHintText({ registeredTools: ['list_subagents'] });
  assert.ok(one.includes('一工具可用'), '单工具时计数动态');
  assert.equal(one.includes('续聊复用'), false, '无 message 工具时不得宣称可续聊复用');
  assert.equal(bridgeChannelHintText({ registeredTools: [] }), '', '零工具返回空串（调用方不得注入空提示）');
});

test('DEV-220 gate：门控四态——depth/未注册/空 sid（一次性 warn）/once 单源＋reset 重臂', () => {
  const warns = [];
  const registered = new Set(['s1']);
  const gate = createBridgeHintGate({
    depthOf: (agent) => agent?.delegationDepth ?? 0,
    sidOf: (agent) => agent?.session?.header?.id ?? '',
    isRegistered: (sid) => registered.has(sid),
    warn: (m) => warns.push(String(m)),
  });
  const agent = (sid, depth = 0) => ({ delegationDepth: depth, session: { header: { id: sid } } });
  assert.equal(gate.shouldInject(agent('s1', 0)), true, '已注册顶层会话可注入');
  gate.markSent('s1');
  assert.equal(gate.shouldInject(agent('s1')), false, 'once：已投递不重复');
  gate.reset('s1');
  assert.equal(gate.shouldInject(agent('s1')), true, 'reset 后重臂（新 agent created）');
  assert.equal(gate.shouldInject(agent('s2')), false, '未注册会话不投');
  assert.equal(gate.shouldInject(agent('s1', 1)), false, 'depth>0 不投');
  const before = warns.length;
  assert.equal(gate.shouldInject(agent('')), false, '空 sid 不投');
  assert.equal(warns.length, before + 1, '空 sid 一次性 warn');
  gate.shouldInject(agent(''));
  assert.equal(warns.length, before + 1, '空 sid warn 仅一次');
});

test('DEV-220 gate：isRegistered 抛错 fail-open 不消耗（下一轮可重试）', () => {
  const warns = [];
  let boom = true;
  const gate = createBridgeHintGate({
    depthOf: () => 0,
    sidOf: () => 's1',
    isRegistered: () => {
      if (boom) throw new Error('probe-failed');
      return true;
    },
    warn: (m) => warns.push(String(m)),
  });
  const agent = { delegationDepth: 0, session: { header: { id: 's1' } } };
  assert.equal(gate.shouldInject(agent), false, '判定异常不得注入');
  assert.ok(warns.some((m) => m.includes('probe-failed')), '异常应告警');
  boom = false;
  assert.equal(gate.shouldInject(agent), true, '异常未消耗 once——下一轮可注入');
});

test('DEV-220 注册面：registerAgentControlTools 返回 registeredTools（实际注册工具名）', () => {
  const withAll = setup();
  assert.deepEqual([...withAll.registeredTools].sort(), [...TOOL_NAMES].sort());
  withAll.disposer();
  const noWait = setup({ agents: undefined });
  assert.deepEqual([...noWait.registeredTools].sort(), ['list_subagents', 'message_subagent'], 'agents 缺失时 registeredTools 不含 wait');
  noWait.disposer();
  const none = setup({ subagents: undefined });
  assert.deepEqual(none.registeredTools, [], 'fail-open 时注册工具名为空');
});

test('DEV-220 描述：三工具 description 追加 DEV-220 句子（可续/正确入口/等待语义）', () => {
  const defs = buildToolDefinitions({ subagents: makeFakeSubagents(), agents: makeFakeAgents(), parentSessionId: 'root-1' });
  const byName = new Map(defs.map((d) => [d.name, d.description]));
  assert.ok(byName.get('list_subagents').includes('非一次性派发'), 'list 描述应写明非一次性派发');
  assert.ok(byName.get('message_subagent').includes('错通道报错不算'), 'message 描述应写错误原文口径');
  assert.ok(byName.get('wait_subagent').includes('续聊前'), 'wait 描述应写续聊前可 wait');
});
