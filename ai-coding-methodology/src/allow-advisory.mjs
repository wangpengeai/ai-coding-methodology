// 文件：allow-advisory.mjs
// 描述：DSH PreToolUse allow 档提醒的模型可见承载状态机（内部未决-115 处置）——会话级去重、冷却、
//       每会话上限、文本截断；纯状态机，不触达宿主对象（注入与日志由调用方负责）。
//       设计：内部决策-032 2026-10-20 关联注记 / 内部接口-1 同批增补（语义：用户可见→模型可见）。
//       时序：本模块只产出去重后的文本；调用方在 agent.inject 成功后才 commit（失败不占冷却/配额）。
// 作者：wangp  创建：2026-10-20  版权：MIT（见仓库 LICENSE）

/** 默认每会话注入上限。 */
const DEFAULT_MAX_PER_SESSION = 20;
/** 默认同主体冷却期（毫秒）。 */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/** 默认单条文本上限（字符，含截断后缀）。 */
const DEFAULT_MAX_CHARS = 500;
/** 默认会话表容量（防宿主长进程内无限增长；超限按插入序淘汰最旧会话）。 */
const DEFAULT_MAX_SESSIONS = 200;

/**
 * 把提醒文案归一为去重主体：team-governance 文案内嵌「路径 X 落在租约 Y（…）」，
 * 取 X+Y 为 key；解析不到时退回全文（保持向后兼容且不静默丢提醒）。
 * @param {string} text 提醒全文
 * @returns {string} 去重 key
 */
function reasonKey(text) {
  const m = text.match(/路径\s+(.+?)\s+落在租约\s+(.+?)（/);
  return m ? `${m[1]}|${m[2]}` : text;
}

/**
 * 截断到 maxChars 总长（含后缀），不超预算。
 * @param {string} text 原文
 * @param {number} maxChars 上限
 * @returns {string} 截断后文本（≤ maxChars）
 */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const suffix = '…[truncated]';
  const keep = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, keep)}${suffix}`.slice(0, maxChars);
}

/**
 * 创建 allow 档提醒的状态机（每 `apply()` 实例一份；模块顶层不共享）。
 * `request()` 只在判定可注入时返回 `{text, commit}`；调用方在 `agent.inject` 成功后调用
 * `commit()`，失败则不提交（不占冷却与配额）。丢弃条件：会话不可归属、reason 空/非字符串、
 * 同 key 冷却期内、已达每会话上限。
 * @param {{maxPerSession?: number, cooldownMs?: number, maxChars?: number, maxSessions?: number}} [options] 测试/调优注入缝
 * @returns {{request: (sessionId: string, reason: string, now?: number) => ({text: string, commit: () => void}|undefined)}} 状态机
 */
export function createAllowAdvisory(options = {}) {
  const maxPerSession = Number.isSafeInteger(options.maxPerSession) && options.maxPerSession > 0 ? options.maxPerSession : DEFAULT_MAX_PER_SESSION;
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : DEFAULT_COOLDOWN_MS;
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS;
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : DEFAULT_MAX_SESSIONS;
  const bySession = new Map();

  /**
   * 判定一次 allow 提醒是否可注入并返回待提交方案。
   * @param {string} sessionId 会话标识（空串视为不可归属）
   * @param {string} reason 钩子信封 reason
   * @param {number} [now] 当前时间（测试注入缝）
   * @returns {{text: string, commit: () => void}|undefined} 可注入方案；丢弃时 undefined
   */
  function request(sessionId, reason, now = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    if (typeof reason !== 'string') return undefined;
    const text = reason.trim();
    if (text === '') return undefined;
    let state = bySession.get(sessionId);
    if (state === undefined) {
      if (bySession.size >= maxSessions) bySession.delete(bySession.keys().next().value);
      state = { count: 0, keys: new Map() };
      bySession.set(sessionId, state);
    }
    if (state.count >= maxPerSession) return undefined;
    const key = reasonKey(text);
    const lastAt = state.keys.get(key);
    if (typeof lastAt === 'number' && now - lastAt < cooldownMs) return undefined;
    return {
      text: truncate(text, maxChars),
      commit: () => {
        state.keys.set(key, now);
        state.count += 1;
      },
    };
  }

  return { request };
}
