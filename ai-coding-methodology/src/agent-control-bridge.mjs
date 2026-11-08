// 文件：agent-control-bridge.mjs
// 描述：F2 适配层桥接工具（内部任务-189 / 内部未决-151 方向①）——向**当前 agent scope**注册三个非同名
//       模型面工具，让本会话普通 continuable 子代理可列出/可续聊/可等待：
//         · list_subagents   → subagents.listChildren(parentSessionId) 映射持久目录行
//         · message_subagent → subagents.sendMessage(exec.agent, id, [{type:'text',text}], {signal})；
//                              返回宿主 messageId（输出值包成 {messageId} 以过宿主 output-schema 校验）
//         · wait_subagent    → agents.get(id).status ≠ 'running' 即完成（宿主仅 running/idle 两态；
//                              回收/未知 id/取消三态如实区分，不伪装完成）；目标须属于调用方直接子代理
//       设计口径（见 内部任务-189 计划 E 节与 内部模块-24 R-da-11）：默认关（Config.agentControlBridge=false）、
//       fail-open、注册走 agent.ctx 的 tools 服务（agent scope，非插件全局层）、输出 schema 声明实际
//       返回字段（宿主对成功结果做 validateJsonSchemaValue）；与 Team 工具不同名；跨会话不承诺续聊
//       （见 F1 再水化规则 / 内部未决-165）。依据：dsh-tools register/execute 契约（output{schema,render}
//       必填；成功值按 output.schema 校验）；dsh-subagent sendMessage 需 exact live sender＋direct-child；
//       dsh-agent-loop Agent.status ∈ {running,idle}。render 呈现契约：`output.render` 必须返回宿主
//       Content 块数组（`[{type:'text',text}]`；宿主 createSuccessResult 把其返回值当工具结果 content，
//       桌面部署 spill-policy post-execute 按块数组消费）——见 renderContent JSDoc（内部任务-196 修复）。
// 作者：wangp  创建：2026-10-21  版权：MIT（见 workflow/LICENSE）

/** 三个工具名（非同名；勿复用宿主 legacy/Team 工具名）。 */
export const TOOL_NAMES = ['list_subagents', 'message_subagent', 'wait_subagent'];

/**
 * 工具结果渲染（宿主 `output.render` 契约）：必须返回**宿主 Content 块数组**。
 * 为什么不是字符串：宿主 `dsh-tools` 的 `createSuccessResult` 把本返回值直接作为工具结果 `content`
 * 字段（`lib/index.js:3636-3666`），桌面部署默认装载的 `dsh-spill-policy` 在 `tools/post-execute`
 * 对 `content` 调 `.some((block) => block.type === 'image')`（`lib/index.js:237-241`）——返回 string
 * 会在成功路径抛 `TypeError: content.some is not a function`（2026-10-21 内部任务-189 真机门实证；
 * 内部任务-196 修复）。宿主本族工具（`dsh-tool-subagent-control` 等）同形返回 `[{ type:'text', text }]`。
 * @param {unknown} value 已通过 output.schema 校验的成功返回值
 * @throws {Error} 值不可 JSON 序列化（循环引用/BigInt）时由 JSON.stringify 抛出——宿主管线在 render 前
 *   已做无损 JSON 快照与 schema 校验，三工具返回值实际不可达该路径（前置条件显式化，便于调用方诊断）
 * @returns {Array<{type: 'text', text: string}>} Content 块数组
 */
export function renderContent(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/** 工具名→提示文案里的简短能力描述（bridgeChannelHintText 首行用）。 */
const HINT_TOOL_LABELS = {
  list_subagents: '列出本会话直接子代理',
  message_subagent: '向 direct continuable 子代理续聊',
  wait_subagent: '等待其离开 running',
};

/**
 * 首轮桥接通道提示文本（内部任务-220）：模型面「本会话普通子代理可续」的当下事实＋通道政策＋跨会话再水化边界。
 * 按**实际注册工具**动态渲染（`agents` 服务缺失时无 wait 相关文案，「三工具」计数随之变化）——
 * 不得静态宣称未注册的能力。
 * @param {object} options 选项
 * @param {string[]} [options.registeredTools] 本会话实际注册成功的工具名
 * @returns {string} 提示全文（无工具时返回空串——调用方不得注入空提示）
 */
export function bridgeChannelHintText({ registeredTools } = {}) {
  const tools = Array.isArray(registeredTools) ? registeredTools.filter((t) => typeof HINT_TOOL_LABELS[t] === 'string') : [];
  if (tools.length === 0) return '';
  // tools 已按 HINT_TOOL_LABELS 过滤且非空 ⇒ 长度只能是 1/2/3；尾部 `>=4` 分支不可达（内部任务-273 S-06 删除）。
  const countLabel = tools.length === 3 ? '三工具可用' : tools.length === 2 ? '两工具可用' : '一工具可用';
  const hasList = tools.includes('list_subagents');
  const hasMessage = tools.includes('message_subagent');
  const hasWait = tools.includes('wait_subagent');
  const capabilities = [hasList ? '可列出' : '', hasMessage ? '可续聊' : '', hasWait ? '可等待' : ''].filter(Boolean).join('、');
  const lines = [
    `【桥接工具面已启用】本会话${countLabel}：${tools.map((name) => `${name}（${HINT_TOOL_LABELS[name]}）`).join('/')}。`,
    `· 本会话普通子代理（mode=continuable）${capabilities}——不是一次性派发；` +
      '清单为空只表示本会话暂无子代理，不代表不可续，也不代表跨会话可续。',
  ];
  if (hasList && hasMessage) {
    lines.push(
      '· 复审/返工前：先 list_subagents 取同链同角色可续实例（对照 docs/plans/agents-<任务号>.md 台账）→ ' +
        'message_subagent 续聊复用；仅当清单无该标识或投递返回不可续/未知时才新发，并把失败原文记入台账。',
    );
  } else if (hasMessage) {
    lines.push(
      '· 复审/返工前：按 docs/plans/agents-<任务号>.md 台账取同链同角色可续实例，经 message_subagent 续聊复用；' +
        '投递返回不可续/未知时才新发，并把失败原文记入台账。',
    );
  } else if (hasList) {
    lines.push(
      '· 复审/返工前：先 list_subagents 取同链同角色可续实例（对照 docs/plans/agents-<任务号>.md 台账）；' +
        '本会话无续聊工具，清单仅作通道事实与复用决策依据。',
    );
  }
  lines.push(
    '· 通道政策：计划/代码复审与实现者返工用普通子代理通道（充足、可批量、可续聊）；' +
      '持久成员（Team）通道是稀缺资源，只用于任务协同或加速，不作计划/代码复审通道。',
  );
  lines.push('· 跨会话不承诺续聊：新会话一律按「再水化（重建）」登记，不冒充复用。');
  return lines.join('\n');
}

/**
 * 首轮桥接提示门控（内部任务-220）：**onceness 唯一归属本 gate 内部 Set**（调用方不得另设 sent 集合）。
 * 判定项＝depth=0、sid 非空、该 sid 有注册事实、未投递过；isRegistered 抛错 fail-open 且**不消耗** once。
 * @param {object} deps 依赖面
 * @param {Function} [deps.depthOf] `(agent) => number` 委派深度（缺省 0 语义由调用方给）
 * @param {Function} [deps.sidOf] `(agent) => string` 会话 id（缺省空串）
 * @param {Function} [deps.isRegistered] `(sid) => boolean` 该会话是否有桥接注册事实
 * @param {Function} [deps.warn] 一次性告警回调
 * @returns {{shouldInject:Function, markSent:Function, reset:Function}} 门控（`@internal` 非公开契约）
 */
export function createBridgeHintGate({ depthOf, sidOf, isRegistered, warn } = {}) {
  const warnOnce = makeWarnOnce(warn);
  const sent = new Set();
  const readSid = (agent) => {
    try {
      const sid = typeof sidOf === 'function' ? sidOf(agent) : '';
      return typeof sid === 'string' ? sid : '';
    } catch {
      return '';
    }
  };
  return {
    /**
     * @param {object} agent 宿主 agent 对象
     * @returns {boolean} 是否应投递；**不消耗 once**，但空 sid / `isRegistered` 异常会各触发一次性告警
     *   （闭包内 warnOnce 状态写入属预期副作用；判定本身无投递副作用）
     */
    shouldInject(agent) {
      const sid = readSid(agent);
      if (sid === '') {
        warnOnce('ai-coding-methodology: 会话 id 缺失，桥接通道提示不注入（一次性告警）');
        return false;
      }
      let depth = 0;
      try {
        depth = typeof depthOf === 'function' ? depthOf(agent) : 0;
      } catch {
        return false;
      }
      if (depth !== 0) return false;
      if (sent.has(sid)) return false;
      let registered = false;
      try {
        registered = typeof isRegistered === 'function' ? isRegistered(sid) === true : false;
      } catch (error) {
        warnOnce(`ai-coding-methodology: 桥接注册事实判定失败（fail-open，不消耗 once）：${error?.message ?? error}`);
        return false;
      }
      return registered;
    },
    /** @param {string} sid 会话 id（投递成功后显式标记） */
    markSent(sid) {
      if (typeof sid === 'string' && sid !== '') sent.add(sid);
    },
    /** @param {string} sid 会话 id（新 agent created 时重臂） */
    reset(sid) {
      if (typeof sid === 'string' && sid !== '') sent.delete(sid);
    },
  };
}

const WAIT_DEFAULT_MS = 20000;
const WAIT_MAX_MS = 60000;
const WAIT_INTERVAL_MS = 500;

/** 工具输入校验失败（与宿主错误区分；由 execute 抛出成可读工具错误）。 */
class ToolInputError extends Error {}

/** 一次性告警器：无 warn 回调时静默（fail-open 不阻断加载）。 */
function makeWarnOnce(warn) {
  let warned = false;
  return (message) => {
    if (warned) return;
    warned = true;
    if (typeof warn === 'function') warn(message);
  };
}

/** 错误码→可读工具错误（不抛穿宿主；文案写实授权边界）。 */
function mapHostError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const reason = code === '' ? String(error?.message ?? error) : code;
  const hint =
    code === 'NOT_RESUMABLE'
      ? '目标子代理不可续（已终止/非 continuable）；请按实例台账记「已终止/再水化」后新发'
      : '仅本会话 direct continuable child 可投递；跨会话不承诺续聊';
  return new Error(`message_subagent 失败（${reason}）：${hint}`);
}

/** 列表行→输出对象（label 缺省不放 undefined 键；字段声明与 HOST_OUTPUT_SCHEMAS 一致）。 */
function toListRow(row) {
  const out = {
    id: row.id,
    mode: row.mode,
    continuable: row.mode === 'continuable',
    createdAt: row.createdAt,
  };
  if (typeof row.label === 'string') out.label = row.label;
  return out;
}

/** 宿主 output-schema 形态（宿主对成功结果逐值校验：properties 必须声明实际返回字段）。 */
export const HOST_OUTPUT_SCHEMAS = {
  list: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        mode: { type: 'string' },
        continuable: { type: 'boolean' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'mode', 'continuable', 'createdAt'],
      additionalProperties: false,
    },
  },
  message: {
    type: 'object',
    properties: { messageId: { type: 'string' } },
    required: ['messageId'],
    additionalProperties: false,
  },
  wait: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      hostStatus: { type: 'string' },
      reason: { type: 'string' },
      elapsedMs: { type: 'number' },
    },
    required: ['status'],
    additionalProperties: false,
  },
};

/**
 * 构造三工具定义（不注册；便于单测与装配面复用）。
 * @param {object} deps 依赖面（`{ subagents, agents, parentSessionId }`）
 * @param {object} deps.subagents 宿主 subagents 服务（listChildren/sendMessage）
 * @param {object} [deps.agents] 宿主 agents 服务（提供 live status；缺席时不产 wait 工具）
 * @param {string} deps.parentSessionId 父会话 id（listChildren 的查询键与 wait 的授权基准）
 * @returns {Array<object>} 工具定义数组（含 register 所需的 parameters/output）
 */
export function buildToolDefinitions({ subagents, agents, parentSessionId }) {
  const definitions = [
    {
      name: 'list_subagents',
      description: '列出本会话直接子代理（持久目录行；continuable=可续聊，不臆造状态）；`continuable:true` 表示可经 `message_subagent` 续聊复用，非一次性派发',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: HOST_OUTPUT_SCHEMAS.list, render: (_args, value) => renderContent(value) },
      async execute() {
        const rows = await subagents.listChildren(parentSessionId);
        return (rows ?? []).map(toListRow);
      },
    },
    {
      name: 'message_subagent',
      description: '向本会话 direct continuable 子代理投递一条消息（续聊；非本会话/不可续会被宿主拒绝）；用于复审/返工轮复用原实例；失败原文是台账里的不可用证据（错通道报错不算）',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '目标子代理会话 id（list_subagents 返回）' },
          message: { type: 'string', description: '要投递的文本（非空）' },
        },
        required: ['agent_id', 'message'],
        additionalProperties: false,
      },
      output: { schema: HOST_OUTPUT_SCHEMAS.message, render: (_args, value) => renderContent(value) },
      async execute(args, exec) {
        const agentId = typeof args?.agent_id === 'string' ? args.agent_id.trim() : '';
        const message = typeof args?.message === 'string' ? args.message : '';
        if (agentId === '') throw new ToolInputError('message_subagent 需要非空 agent_id');
        if (message.trim() === '') throw new ToolInputError('message_subagent 需要非空 message');
        const sender = exec?.agent;
        if (sender === undefined) throw new ToolInputError('message_subagent 缺少调用方 agent 上下文');
        try {
          const messageId = await subagents.sendMessage(sender, agentId, [{ type: 'text', text: message }], { signal: exec?.signal });
          return { messageId: String(messageId) };
        } catch (error) {
          throw mapHostError(error);
        }
      },
    },
  ];

  if (agents !== undefined && typeof agents.get === 'function') {
    definitions.push({
      name: 'wait_subagent',
      description: '等待本会话子代理离开 running（宿主仅 running/idle；超时如实 timeout、取消如实取消、不伪装完成）；续聊前可先 wait 确认已离开 running',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '目标子代理会话 id（须为本会话直接子代理）' },
          timeout_ms: { type: 'integer', description: `超时毫秒（默认 ${WAIT_DEFAULT_MS}，上限 ${WAIT_MAX_MS}）` },
          interval_ms: { type: 'integer', description: `轮询间隔毫秒（默认 ${WAIT_INTERVAL_MS}，10–5000）` },
        },
        required: ['agent_id'],
        additionalProperties: false,
      },
      output: { schema: HOST_OUTPUT_SCHEMAS.wait, render: (_args, value) => renderContent(value) },
      async execute(args, exec) {
        const agentId = typeof args?.agent_id === 'string' ? args.agent_id.trim() : '';
        if (agentId === '') throw new ToolInputError('wait_subagent 需要非空 agent_id');
        const timeoutMs = clampInt(args?.timeout_ms, WAIT_DEFAULT_MS, 1, WAIT_MAX_MS);
        const intervalMs = clampInt(args?.interval_ms, WAIT_INTERVAL_MS, 10, 5000);
        const signal = exec?.signal;
        // 授权：以父会话的直接子代理目录为界（宿主 agents.get 本身不做授权——不得借此观测他会话）
        if (typeof subagents.listChildren === 'function') {
          const children = (await subagents.listChildren(parentSessionId)) ?? [];
          if (!children.some((row) => row.id === agentId)) {
            throw new Error(`wait_subagent 失败（UNAUTHORIZED）：${agentId} 不是本会话直接子代理`);
          }
        }
        let sawRunning = false;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (signal?.aborted === true) throw new ToolInputError('wait_subagent 被调用方取消');
          const agent = agents.get(agentId);
          if (agent === undefined) {
            if (sawRunning) return { status: 'reclaimed', reason: 'live-agent-disposed' };
            return { status: 'not-found', reason: 'no-live-agent' };
          }
          if (agent.status !== 'running') return { status: 'finished', hostStatus: String(agent.status) };
          sawRunning = true;
          if (Date.now() >= deadline) return { status: 'timeout', elapsedMs: timeoutMs };
          await sleep(intervalMs);
        }
      },
    });
  }

  return definitions;
}

/** 整数钳制（缺省/非法回退默认值；上限防超长等待）。 */
function clampInt(value, fallback, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 注册三工具到给定的 tools 注册表。
 * @param {object} options 注册面依赖
 * @param {object} options.tools 宿主 tools 注册表（需 `register`；应为**调用方 agent.ctx** 的 tools 服务）
 * @param {object} options.subagents 宿主 subagents 服务（缺则 fail-open 不注册）
 * @param {object} [options.agents] 宿主 agents 服务（缺则少注册 wait 工具）
 * @param {string} options.parentSessionId 父会话 id
 * @param {Function} [options.warn] 一次性告警回调（缺省静默）
 * @returns {{registered:number, registeredTools:string[], disposer:Function, skipped?:string}}
 *   `registeredTools`＝实际注册成功的工具名（供首轮提示按真实能力动态渲染；fail-open 时为空数组）
 */
export function registerAgentControlTools({ tools, subagents, agents, parentSessionId, warn } = {}) {
  const warnOnce = makeWarnOnce(warn);
  if (subagents === undefined || typeof subagents.sendMessage !== 'function' || typeof subagents.listChildren !== 'function') {
    warnOnce('ai-coding-methodology: 宿主未提供 subagents 服务，桥接工具不注册（fail-open）');
    return { registered: 0, registeredTools: [], disposer: () => {}, skipped: 'no-subagents' };
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    warnOnce('ai-coding-methodology: 宿主未提供 agent scope tools 注册面，桥接工具不注册（fail-open）');
    return { registered: 0, registeredTools: [], disposer: () => {}, skipped: 'no-tools' };
  }
  const disposers = [];
  const registeredTools = [];
  for (const def of buildToolDefinitions({ subagents, agents, parentSessionId })) {
    try {
      disposers.push(tools.register(def));
      registeredTools.push(def.name);
    } catch (error) {
      warnOnce(`ai-coding-methodology: 桥接工具 ${def.name} 注册失败（fail-open）：${error?.message ?? error}`);
    }
  }
  let disposed = false;
  return {
    registered: registeredTools.length,
    registeredTools,
    disposer() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 释放失败不阻断（disposer 幂等；宿主层各自兜底）
        }
      }
    },
  };
}

/**
 * 桥接 `agent/created` 监听器的内部标记（供既有测试从监听器集合中识别/排除桥接监听；
 * `@internal` 非公开契约，不进入 README/规格规定性面）。
 */
export const AGENT_CONTROL_LISTENER_TAG = Symbol.for('ai-coding-methodology.agent-control-listener');

/**
 * 首轮桥接提示 pre-step 监听器的内部标记（内部任务-220；供既有测试从 `agent/pre-step` 监听链中识别/排除，
 * `@internal` 非公开契约，不进入 README/规格规定性面）。
 */
export const BRIDGE_HINT_LISTENER_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');

/**
 * 装配面：在 agent/created 上挂监听（独立于 SessionStart 等任何既有分支），仅 depth=0 注册，
 * 且注册走**该 agent 的 ctx**（agent scope；注册随 agent 生命周期释放，不落插件全局层）。
 * @param {object} ctx cordis 上下文（需 `on`）
 * @param {object} options 装配选项
 * @param {Function} [options.getServices] `(agent) => ({ tools, subagents, agents })`——tools 应为该 agent 的 ctx.get('tools')
 * @param {Function} [options.onRegistered] 注册成功回调 `(agent, result)`（装配级观测点；index 不传时无副作用）
 * @param {Function} [options.warn] 一次性告警回调（缺省静默）
 * @param {Function} [options.depthOf] 深度判定（缺省读 `agent.delegationDepth`）
 * @param {Function} [options.isEnabled] 创建时判定是否启用（缺省＝启用；判定抛错按 fail-open 不注册并告警）
 * @returns {Function} disposer（移除监听并释放已注册工具；幂等）
 */
export function attachAgentControl(ctx, { getServices, onRegistered, warn, depthOf, isEnabled } = {}) {
  const warnOnce = makeWarnOnce(warn);
  const disposers = [];
  let disposed = false;
  const innerHandler = (payload) => {
    if (disposed) return;
    const agent = payload?.agent;
    // 内部任务-273 M-04：`agent` 为 null 时旧写法（`=== undefined` 后才读 agent.id）会抛 TypeError；
    // 用 == null 覆盖 null/undefined，且 handler 外层统一兜底（agent/created 走宿主 serial、无 per-listener 兜底）。
    if (agent == null || agent.id === undefined) return;
    const depth = typeof depthOf === 'function' ? depthOf(agent) : (agent.delegationDepth ?? 0);
    if (depth !== 0) return;
    // 内部决策-057：volatile 配置变更不重挂插件，故启用判定必须发生在每次创建时；判定异常 fail-open。
    let enabled = true;
    try {
      enabled = typeof isEnabled === 'function' ? isEnabled() === true : true;
    } catch (error) {
      warnOnce(`ai-coding-methodology: 桥接启用判定失败（fail-open）：${error?.message ?? error}`);
      enabled = false;
    }
    if (!enabled) return;
    let services;
    try {
      services = getServices?.(agent);
    } catch (error) {
      warnOnce(`ai-coding-methodology: 桥接服务解析失败（fail-open）：${error?.message ?? error}`);
      return;
    }
    if (services === undefined) return;
    try {
      const result = registerAgentControlTools({ ...services, parentSessionId: agent.id, warn });
      disposers.push(result.disposer);
      if (result.registered > 0 && typeof onRegistered === 'function') onRegistered(agent, result);
    } catch (error) {
      warnOnce(`ai-coding-methodology: 桥接注册未捕获异常（fail-open）：${error?.message ?? error}`);
    }
  };
  // 内部任务-273 M-04：监听器整体兜底——`agent/created` 走宿主 serial 派发（零 per-listener try/catch），
  // 任何漏网异常都会打断宿主 agent 创建路径；fail-open 记一次性告警并放行。
  const handler = (payload) => {
    try {
      innerHandler(payload);
    } catch (error) {
      warnOnce(`ai-coding-methodology: 桥接监听未捕获异常（fail-open）：${error?.message ?? error}`);
    }
  };
  Object.defineProperty(handler, AGENT_CONTROL_LISTENER_TAG, { value: true });
  const off = typeof ctx?.on === 'function' ? ctx.on('agent/created', handler) : () => {};
  return function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      off();
    } catch {
      // 监听移除失败不阻断释放
    }
    for (const disposeRegistered of disposers) {
      try {
        disposeRegistered();
      } catch {
        // 同上：fail-open
      }
    }
  };
}
