// 文件：long-task-driver.mjs
// 描述：DSH 长任务编排状态机（内部决策-053 / 内部任务-171）——协议文本、todo 快照、Stop 续跑条件矩阵/
//       预算/冷却/人类重置；纯状态机，不触达宿主对象（注入/steer 由调用方负责）。
// 作者：wangp  创建：2026-10-20  版权：MIT（见仓库 LICENSE）
const MAX_PER_TURN = 2;
const MAX_PER_SESSION = 10;
const COOLDOWN_MS = 15 * 1000;
const MAX_LISTED = 5;
const PROTOCOL = '【DSH 长任务协议】多步任务开始时先 todo_write 写出完整清单；每轮开头重新发送整表（宿主 turn/start 会清空投影）；预计跨多轮完成的目标用 create_goal 创建（自动 Goal Round 续行）；完成一项立即更新 todo_write。本会话对未完成清单在停止时会受控续跑（每人类轮最多 2 次）；若需用户决策请在回复中直接说明；若宿主处于 plan 模式，以宿主提示为准，不写 todo_write。执行期遇到外部阻塞（需用户决策、权限缺位、外部依赖不可用、等待上游返回）时，当轮停止推进并在回复中报告阻塞条件、已尝试路径与可解性判断，不得以未完成清单或目标（todo/goal）继续空转；存在当前 goal 且同一外部阻塞持续达宿主阈值后，调用 update_goal 标记 blocked 并在回复中报告；难度高、不确定性大、剩余工作多不构成阻塞判据。';

/** goal 让位三态（内部任务-273 H-04）：`owns`＝宿主 goal 轮接管（todo 驱动让位）；`free`＝无活动 goal（恢复 todo）；`unknown`＝形态不可判定（保守让位）。 */
export const GOAL_OWNERSHIP = Object.freeze({ OWNS: 'owns', FREE: 'free', UNKNOWN: 'unknown' });

/**
 * 判定宿主当前 goal 是否「接管续行」（内部任务-273 H-04 / A-da-9）。
 * 判据与宿主 round driver 的 drivable 同源：`phase==='active'` 且 `activation !== 'disarmed'` 才让位
 * （paused/blocked/complete 不再接管；clear 后 `get()` 返回空 ⇒ free）。**不引入 id 判据**；
 * 形态异常（非对象/phase 缺失或非字符串）一律 unknown（让位＋一次性告警，避免与 goal 轮并发）。
 * @param {unknown} goal 宿主 `goals.get(agent)` 视图
 * @returns {'owns'|'free'|'unknown'}
 */
export function goalOwnsContinuation(goal) {
  if (goal === null || goal === undefined) return GOAL_OWNERSHIP.FREE;
  if (typeof goal !== 'object') return GOAL_OWNERSHIP.UNKNOWN;
  const phase = goal.phase;
  if (typeof phase !== 'string' || phase === '') return GOAL_OWNERSHIP.UNKNOWN;
  if (phase === 'active') return goal.activation === 'disarmed' ? GOAL_OWNERSHIP.FREE : GOAL_OWNERSHIP.OWNS;
  if (phase === 'paused' || phase === 'blocked' || phase === 'complete') return GOAL_OWNERSHIP.FREE;
  return GOAL_OWNERSHIP.UNKNOWN;
}

/**
 * 校验并解析 `todo_write` 参数；非法返回 null，空数组合法（表示清空清单）。
 * @param {unknown} args 工具调用参数
 * @returns {Array<{content: string, status: string}>|null} 清单或 null
 */
function parseTodos(args) {
  const list = args && typeof args === 'object' ? args.todos : undefined;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    const status = item.status;
    if (content === '' || !['pending', 'in_progress', 'completed'].includes(status)) return null;
    out.push({ content, status });
  }
  return out;
}

/** 清单键（状态+内容），用于判断清单是否变化。 */
function listKey(todos) {
  return todos.map((x) => `${x.status}\u0000${x.content}`).join('\n');
}

/** 续跑消息正文（最多列 5 条未完成项）。 */
function reminderText(todos) {
  const active = todos.filter((x) => x.status !== 'completed');
  const shown = active.slice(0, MAX_LISTED).map((x) => `- ${x.content}`);
  const more = active.length > MAX_LISTED ? `\n…另有 ${active.length - MAX_LISTED} 项` : '';
  return `【todo 续跑】清单仍有 ${active.length} 项未完成：\n${shown.join('\n')}${more}\n继续执行下一项；完成后立即更新 todo_write；若需要用户决策请直接说明（用户决策优先）。`;
}

/**
 * 创建长任务驱动状态机（每次 apply 一份；模块顶层不共享）。
 * @param {{maxPerTurn?: number, maxPerSession?: number, cooldownMs?: number, warn?: (message: string) => void}} [options] 测试与告警注入缝
 * @returns {{protocolText: () => string, observeTool: (input: {sessionId?: string, toolName?: string, args?: object, isError?: boolean}) => void, onHumanPrompt: (sessionId: string) => void, shouldSteer: (input: {sessionId?: string, delegationDepth?: number, now?: number}) => ({text: string, commit: () => void}|undefined)}} 状态机
 */
export function createLongTaskDriver(options = {}) {
  const maxPerTurn = Number.isSafeInteger(options.maxPerTurn) && options.maxPerTurn > 0 ? options.maxPerTurn : MAX_PER_TURN;
  const maxPerSession = Number.isSafeInteger(options.maxPerSession) && options.maxPerSession > 0 ? options.maxPerSession : MAX_PER_SESSION;
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : COOLDOWN_MS;
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  const states = new Map();
  const malformedWarned = new Set();

  function stateOf(sessionId) {
    let s = states.get(sessionId);
    if (s === undefined) {
      s = { todos: null, turnSteers: 0, totalSteers: 0, lastSteerAt: null, lastKey: '', stale: true, frozenKey: null };
      states.set(sessionId, s);
    }
    return s;
  }

  return {
    /** @returns {string} 协议文本 */
    protocolText: () => PROTOCOL,

    /**
     * 观测一次工具调用：成功的 `todo_write` 刷新清单（空数组清空）；非法参数一次性 warn。
     * @param {{sessionId?: string, toolName?: string, args?: object, isError?: boolean}} input 观测输入
     * @returns {void}
     */
    observeTool(input = {}) {
      const sid = input.sessionId;
      if (typeof sid !== 'string' || sid === '' || String(input.toolName ?? '') !== 'todo_write' || input.isError === true) return;
      const s = stateOf(sid);
      const todos = parseTodos(input.args);
      if (todos === null) {
        s.todos = null;
        s.stale = true;
        if (!malformedWarned.has(sid)) {
          malformedWarned.add(sid);
          warn(`ai-coding-methodology: todo_write 参数无法解析（会话 ${sid}），旧快照已作废（冻结键保留）`);
        }
        return;
      }
      const key = listKey(todos);
      if (s.stale && s.frozenKey !== null && key === s.frozenKey) return; // 旧表原样重发：不重新武装
      s.todos = todos;
      s.stale = false;
      s.frozenKey = null;
    },

    /**
     * 真实人类提示到达：重置每人类轮预算与冷却锚点。
     * @param {string} sessionId 会话 id
     * @returns {void}
     */
    onHumanPrompt(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const s = stateOf(sessionId);
      s.turnSteers = 0;
      s.lastSteerAt = null;
      if (s.todos !== null) s.frozenKey = listKey(s.todos);
      s.todos = null;
      s.stale = true;
    },

    /**
     * 判定 Stop 是否应续跑；返回待提交方案（commit 才占预算/冷却）。
     * @param {{sessionId?: string, delegationDepth?: number, now?: number}} input 判定输入
     * @returns {{text: string, commit: () => void}|undefined} 方案或 undefined
     */
    shouldSteer(input = {}) {
      const sid = input.sessionId;
      if (typeof sid !== 'string' || sid === '' || (input.delegationDepth ?? 0) > 0) return undefined;
      const s = states.get(sid);
      if (s === undefined || s.todos === null || s.stale === true) return undefined;
      const active = s.todos.filter((x) => x.status !== 'completed');
      if (active.length === 0) return undefined;
      const key = listKey(s.todos);
      const hasInProgress = s.todos.some((x) => x.status === 'in_progress');
      if (key === s.lastKey && !(hasInProgress && s.turnSteers === 0)) return undefined;
      const now = input.now ?? Date.now();
      if (s.lastSteerAt !== null && now - s.lastSteerAt < cooldownMs) return undefined;
      if (s.turnSteers >= maxPerTurn || s.totalSteers >= maxPerSession) return undefined;
      return {
        text: reminderText(s.todos),
        commit: () => {
          s.turnSteers += 1;
          s.totalSteers += 1;
          s.lastSteerAt = now;
          s.lastKey = key;
        },
      };
    },
  };
}
