// 文件：f2-poc.integration.test.mjs
// 描述：F2 桥接工具探针（内部任务-189 计划步骤 7）——两相位：
//       相位 A（默认）：用**真实宿主模块**（dsh-tools，经 tests/helpers/dsh-engine.mjs 抽取装载）
//         验证注册契约事实：`defineTool` 必须有 output{schema,render}、缺则 TypeError；
//         `assertSupportedJsonSchema` 接受本层使用的输出 schema 形态；无服务时 attach 不炸（A4）；
//         A5（2026-10-22 内部任务-196）以真实 dsh-spill-policy 的 tools/post-execute 消费 render 结果
//         （宿主 Content[] 契约：RED=`content.some is not a function`／GREEN=accept；含 >maxInlineTokens
//         大样本 fail-open warn 断言）；宿主模块不可得时 skip+diagnostic（宿主可得性须由 verification 登记）。
//       相位 M（`F2_POC_PHASE=M`）：动态 import 实现模块 `src/agent-control-bridge.mjs`，对 fake host
//         复验三工具注册/映射/等待/fail-open（内部模块-1-内部模块-4）——实现态就绪证据。
//       边界（如实）：真实 subagents 服务的「投递→子代理新帧」「live status running→finished」需完整宿主栈
//         （本层测试进程不引导 Session/persistence/agent 服务）→ 相位 A 的 A2/A3 以 skip+diagnostic 记录，
//         由步骤 11 真机门承担；内部未决-151 保持 OPEN（跨会话与真机模型面未验证）。
// 作者：wangp  创建：2026-10-21  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadEngine } from './helpers/dsh-engine.mjs';

const PHASE_M = process.env.F2_POC_PHASE === 'M';

test('POC-A1：真实 dsh-tools 的 defineTool 必须有 output{schema,render}（缺则 TypeError）', async (t) => {
  const tools = await loadEngine('@deepseek-ai/dsh-tools');
  if (tools === undefined) {
    t.skip('本机未找到可用 dsh-tools（DSH_APP_ROOT/缓存不可得）——按 fail-loud 记录，不静默跳过');
    return;
  }
  assert.equal(typeof tools.defineTool, 'function', '真实 dsh-tools 应导出 defineTool');
  // 缺 output → TypeError（源码 defineTool:838-843 直接读 options.output.render）
  assert.throws(
    () => tools.defineTool({ name: 'probe', description: 'x', parameters: {}, execute: async () => null }),
    TypeError,
    '缺 output 必须抛 TypeError（注册契约事实）',
  );
  // 带 output 的正向样本：产出 definition 带 output.render（schema 取宿主 supported 子集；数值校验面向的是
  // **成功返回值**——只写空 object schema 会拒一切非空值，2026-10-21 三维评审 B1 修复后由三工具 schema 声明实际字段）
  const objectSchema = { type: 'object', additionalProperties: false };
  const def = tools.defineTool({
    name: 'probe',
    description: 'x',
    parameters: {},
    output: { schema: objectSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ ok: true }),
  });
  assert.equal(typeof def.output.render, 'function');
  // 本层使用的输出 schema 形态必须被宿主校验面接受，且**真实返回值样本必须过宿主值校验**
  // （宿主 createSuccessResult 对成功结果做 validateJsonSchemaValue；只写空对象 schema 会拒一切字段）
  assert.doesNotThrow(() => tools.assertSupportedJsonSchema(objectSchema));
  assert.doesNotThrow(() => tools.assertSupportedJsonSchema({ type: 'array', items: objectSchema }));
  if (typeof tools.validateJsonSchemaValue === 'function') {
    const { HOST_OUTPUT_SCHEMAS } = await import('../src/agent-control-bridge.mjs');
    const samples = {
      list: [{ id: 'c1', mode: 'continuable', continuable: true, createdAt: 1 }],
      message: { messageId: 'm1' },
      wait: { status: 'finished', hostStatus: 'idle' },
    };
    for (const [key, schema] of Object.entries(HOST_OUTPUT_SCHEMAS)) {
      assert.deepEqual(tools.validateJsonSchemaValue(schema, samples[key]), [], `${key} 输出样本必须过宿主校验`);
    }
  } else {
    t.diagnostic('跳过：本机 dsh-tools 未导出 validateJsonSchemaValue（输出值校验面未实测）');
  }
});

test('POC-A2/A3：真实子代理投递与 running→finished 需完整宿主栈——本进程 skip，转步骤 11 真机门', (t) => {
  t.skip('需要完整宿主栈（Session/persistence/subagents/agents 服务引导）——本层测试进程不引导；由步骤 11 真机门验证，OPEN-151 保持');
});

test('POC-A4：无 tools 服务时 attachAgentControl 不炸且不注册（fail-open）', async () => {
  const { attachAgentControl } = await import('../src/agent-control-bridge.mjs'); // 相位 A 也验证装配面 fail-open（模块存在性由 RED/GREEN 保证）
  const listeners = [];
  const warnings = [];
  const dispose = attachAgentControl(
    { on: (event, handler) => { listeners.push(handler); return () => {}; } },
    { getServices: () => ({}), warn: (m) => warnings.push(m) },
  );
  listeners[0]({ agent: { id: 'root-1', delegationDepth: 0 } });
  assert.equal(warnings.length, 1, '无 tools/subagents 服务时一次性告警');
  dispose();
});

test('POC-M1/M2：实现模块注册三工具、list 映射、message sender/块/signal（实现态）', async (t) => {
  if (!PHASE_M) {
    t.skip('相位 A 不跑实现态（设 F2_POC_PHASE=M 在步骤 8 后强制重跑）');
    return;
  }
  const { TOOL_NAMES, registerAgentControlTools } = await import('../src/agent-control-bridge.mjs');
  const registry = new Map();
  const tools = { register(def) { registry.set(def.name, def); return () => registry.delete(def.name); }, view: () => [...registry.keys()] };
  const subagents = {
    calls: [],
    listChildren: () => [{ id: 'c1', label: 'x', mode: 'continuable', createdAt: 1 }],
    async sendMessage(sender, targetId, content, options) { this.calls.push({ sender, targetId, content, options }); return 'm1'; },
  };
  const agents = { get: () => ({ id: 'c1', status: 'idle' }) };
  const result = registerAgentControlTools({ tools, subagents, agents, parentSessionId: 'root-1' });
  assert.equal(result.registered, TOOL_NAMES.length);
  assert.deepEqual([...registry.keys()].sort(), [...TOOL_NAMES].sort());
  const listed = await registry.get('list_subagents').execute({}, {});
  assert.equal(listed[0].continuable, true);
  const sent = await registry.get('message_subagent').execute({ agent_id: 'c1', message: 'm' }, { agent: { id: 'root-1' }, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(sent, { messageId: 'm1' });
  assert.equal(subagents.calls[0].content[0].type, 'text');
  const waited = await registry.get('wait_subagent').execute({ agent_id: 'c1' }, { signal: AbortSignal.timeout(1000) });
  assert.deepEqual(waited, { status: 'finished', hostStatus: 'idle' });
});

test('POC-M4：实现模块无 subagents 服务 → fail-open 不注册', async (t) => {
  if (!PHASE_M) {
    t.skip('相位 A 不跑实现态（设 F2_POC_PHASE=M 在步骤 8 后强制重跑）');
    return;
  }
  const { registerAgentControlTools } = await import('../src/agent-control-bridge.mjs');
  const warnings = [];
  const r = registerAgentControlTools({ tools: { register: () => () => {} }, subagents: undefined, agents: undefined, parentSessionId: 'root-1', warn: (m) => warnings.push(m) });
  assert.equal(r.registered, 0);
  assert.equal(warnings.length, 1);
});

test('POC-A5：桥接 render 通过宿主真实 spill-policy post-execute 消费（Content[] 契约）', async (t) => {
  const spill = await loadEngine('@deepseek-ai/dsh-spill-policy');
  if (spill === undefined) {
    t.diagnostic('宿主 dsh-spill-policy 不可得（DSH_APP_ROOT/缓存不可得）——A5 跳过；宿主可得性须由 verification 证据登记（按 POC 既有钉子惯例 skip+diagnostic，不静默 PASS）');
    t.skip('宿主引擎不可得');
    return;
  }
  const warnings = [];
  const handlers = [];
  spill.apply({
    on: (event, handler) => { if (event === 'tools/post-execute') handlers.push(handler); return () => {}; },
    get: () => undefined,
    logger: { warn: (message) => warnings.push(String(message)) },
  }, { maxInlineTokens: 1000 });
  assert.ok(handlers.length > 0, 'spill-policy 应注册 tools/post-execute 处理器');
  const { buildToolDefinitions } = await import('../src/agent-control-bridge.mjs');
  const tools = buildToolDefinitions({
    subagents: { listChildren: async () => [], sendMessage: async () => 'm1' },
    agents: { get: () => ({ id: 'c1', status: 'idle' }) },
    parentSessionId: 'root-1',
  });
  const small = {
    list_subagents: [],
    message_subagent: { messageId: 'm1' },
    wait_subagent: { status: 'finished', hostStatus: 'idle' },
  };
  // 大样本：渲染 JSON 超 maxInlineTokens=1000 → 走宿主保留/截断路径；无 spillStore/会话句柄时策略 warn 后内联（fail-open）
  const big = { messageId: 'm1' + 'x'.repeat(8000) };
  for (const tool of tools) {
    const cases = [[small[tool.name], false]];
    if (tool.name === 'message_subagent') cases.push([big, true]);
    for (const [value, isBig] of cases) {
      const warnsBefore = warnings.length;
      const rendered = tool.output.render({}, value);
      let decision;
      try {
        decision = await handlers[0](
          { name: tool.name, callId: 1, parent: undefined, agent: undefined, signal: undefined },
          { isError: false, content: rendered, value },
          async () => ({ kind: 'accept' }),
        );
      } catch (error) {
        assert.fail(`${tool.name} 成功结果必须通过宿主 post-execute（当前 render=${Array.isArray(rendered) ? 'Content[]' : typeof rendered}）：${error.name}: ${error.message}`);
      }
      assert.equal(decision.kind, 'accept', `${tool.name} 成功结果必须被宿主 post-execute 接受`);
      assert.ok(Array.isArray(rendered), `${tool.name} render 必须是 Content[]（宿主 post-execute 消费前提）`);
      for (const block of rendered) assert.equal(block.type, 'text', `${tool.name} render 块须为 text`);
      if (isBig) {
        // 大样本必须实际进入宿主保留/内联 fail-open 路径：恰一条 warn 且含 keeping the inline content
        assert.equal(warnings.length, warnsBefore + 1, '大样本应由宿主保留策略触发一次告警（fail-open 内联）');
        assert.match(warnings[warnings.length - 1], /keeping the inline content/);
      } else {
        assert.equal(warnings.length, warnsBefore, '小样本不应触发保留策略告警（低于预算直接内联）');
      }
    }
  }
});
