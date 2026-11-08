// 文件：mcode-adapter/mcode/hook-lib.mjs
// 描述：MCode 适配层的 shim 共享小工具（随包物化到 <包根>/mcode/）。三块职责：
//       ① 状态面——待投递提醒队列与 Stop 连击计数，落在宿主注入的 PLUGIN_DATA
//       （只读包根不可写；PLUGIN_DATA 缺席时退到进程临时目录的按包哈希目录）；
//       ② 负载面——MCode 原生负载归一成 ZCode 形态（工具名词表、写类入参名、
//       失败事件合并后的 tool_result 结构面）；③ 响应面——ZCode 信封译成
//       MCode 白名单内的输出（systemMessage → permissionDecisionReason 等）；
//       ④ 能力域面——运行观测能力域声明（`WF_OBSERVATION_CAPABILITIES`）注入钩子子进程 env，
//       供核心 内部模块-15 就绪面判定「能力域已声明/降级」（2026-10-24 内部任务-192，内部接口-1 MCode 列）。
//       全部 fail-open：任何异常都退化为「无输出」，绝不阻断宿主轮次
//       （project-conventions 硬规则 4）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2（宿主契约双源取证）
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 待投递提醒队列上限（防止长时间会话把状态文件撑大；超限丢最旧）。 */
export const PENDING_LIMIT = 20;

/**
 * MCode 运行观测能力域声明（2026-10-24 内部任务-192/内部决策-063 修正案 1 决策 13；事实源＝内部接口-1
 * 「运行观测能力登记」MCode 列；2026-11-08 内部任务-356 按 内部任务-354 真机实测复评钩失败观测面）：
 * 失败事实供给＝不可用（真机实证 wire 无结构化失败字段）；钩失败观测面＝降级可用（无派发日志，
 * 但适配层 `hook-diagnostics` 记超时/状态落盘失败、宿主 `runtime.warning` 报 `HOOK_TIMEOUT`——
 * **仅超时类**可观测，非原生派发日志）；提醒注入时效＝无注入位→待投递中继（下一 UPS 送达，
 * 生成期为无 UPS 的包补合成投递腿）；自检可达性＝钩 `--selftest`。
 * 值是**声明形态短串**（与核心镜像 `observation-capability-contract.json` 的 `declarationGrammar`
 * 同域，非五态登记词表本身）；核心据它判定「能力域已声明/降级」（内部模块-15 就绪面）。
 * `none` 只是 `failureFacts` 的声明别名（「不可用」，五态口径见能力登记表 MCode 列）；
 * `degraded` 表部分可观测（有判定信号但无原生观测面），不等于原生派发日志。
 */
export const OBSERVATION_CAPABILITIES = Object.freeze({
  failureFacts: 'none',
  hookFailure: 'degraded',
  injection: 'relay',
  selfCheck: 'selftest',
});

/**
 * 把运行观测能力域声明注入钩子子进程环境（`hook-shim.mjs` 以 `{...process.env}` 构造子进程
 * env，故本模块装载时调用一次即对全部处理器生效；已存在的声明值**不覆盖**——外层调用方
 * （测试/嵌套 shim）可显式覆盖）。
 * 为什么落在 hook-lib 而非 shim：一宿主一写面（内部决策-054）＋本次改动面收敛（shim 是冻结转发层）。
 * @param {Record<string, string>} [env] 目标环境对象（缺省 `process.env`）
 * @returns {Record<string, string>} 同一对象（便于链式断言）
 */
export function applyObservationCapabilitiesEnv(env = process.env) {
  const target = env && typeof env === 'object' ? env : process.env;
  const current = target.WF_OBSERVATION_CAPABILITIES;
  if (typeof current !== 'string' || current.trim() === '') {
    target.WF_OBSERVATION_CAPABILITIES = JSON.stringify(OBSERVATION_CAPABILITIES);
  }
  return target;
}

/** 模块装载即声明（shim 先 import 本模块、后 spawn 子钩子 ⇒ 子进程经 `{...process.env}` 继承）。 */
applyObservationCapabilitiesEnv(process.env);


/** 状态文件名（单个 JSON 文件，读-改-写）。 */
const STATE_FILE = 'relay-state.json';

/**
 * 读 stdin 全文（宿主钩子负载）。关闭/出错都解析为空串，交由 fail-open 路径处理。
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/** 记录对象判定（宿主负载字段值不可信，逐处判类型）。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 状态目录解析：优先宿主注入的 PLUGIN_DATA（宿主拥有的可写持久态）；缺席时退到
 * 进程临时目录下按包根哈希命名的目录——**绝不写包内**（包根是只读契约面）。
 * @param {string} pluginRoot 包根绝对路径
 * @returns {string}
 */
export function resolveStateDir(pluginRoot) {
  const injected = process.env.PLUGIN_DATA;
  if (typeof injected === 'string' && injected.trim() !== '') return injected;
  const tag = createHash('sha256').update(String(pluginRoot)).digest('hex').slice(0, 12);
  return join(tmpdir(), `ai-coding-methodology-mcode-${tag}`);
}

/**
 * 空状态（纯函数，保证字段齐备，测试可直测）——**形状＝引擎侧 relay 状态**（批 3 步骤 10；
 * 内部任务-347/内部未决-277②/274 升格多会话字典）：`frames` 每帧自带非空 `sessionKey`（引擎 `isFrame`
 * 硬要求）；连击/淘汰计数为 `streaks`/`droppedBySession` 字典（`s:` 前缀键；宿主读侧往返保留；
 * 旧单键对/单值字段由引擎首读迁移）。
 * @returns {{frames: {sessionKey: string, id: string, text: string, ts: number}[], streaks: Object<string, number>, droppedBySession: Object<string, number>}}
 */
export function emptyState() {
  return { frames: [], streaks: {}, droppedBySession: {} };
}

/**
 * 迁移用**固定哨兵会话键**（批 3 步骤 10 计划定死）：旧盘态缺会话键来源时用它合成帧键。
 * 不取当前 `ctx.sessionKey`——那会把旧会话攒下的待投递帧推给新会话（跨会话串话）。
 */
export const MIGRATION_SESSION_KEY = '__mcode_relay_migrated__';

/** 计数字典逐键拷贝（正整数条目；引擎状态键读侧往返保留，内部任务-347）。 */
function copyCountDict(dict) {
  const out = {};
  if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
    for (const key of Object.keys(dict)) {
      const count = dict[key];
      if (Number.isFinite(count) && count > 0) out[key] = Math.floor(count);
    }
  }
  return out;
}

/** 由状态推出帧会话键兜底：多会话字典无单键位——取最大计数键（前缀剥面）；空字典用固定哨兵
 * （保证帧键永不为空，否则被引擎判 malformed 丢弃；旧单键对/单值字段经引擎迁移后此处不再读）。 */
function frameSessionKeyOf(state) {
  let best = '';
  let bestCount = 0;
  const streaks = state.streaks;
  if (streaks && typeof streaks === 'object' && !Array.isArray(streaks)) {
    for (const key of Object.keys(streaks)) {
      const count = streaks[key];
      if (Number.isFinite(count) && count > bestCount) { best = key.startsWith('s:') ? key.slice(2) : key; bestCount = count; }
    }
  }
  return best !== '' ? best : MIGRATION_SESSION_KEY;
}

/**
 * 读状态（不可读/损坏 → 空状态，fail-open）。**含旧形状一次性迁移**：旧 `pending:[{id,text,ts}]`
 * → 新 `frames:[{sessionKey,id,text,ts}]`（键由 `streakKey` 或固定哨兵合成），保证升级不丢待投递。
 * **mcode 有真实升级史故保留迁移与哨兵**——kimi 侧（单提交新建）已于 内部任务-2 批 A2 删除同款
 * 迁移分支，这是两侧 hook-lib 的登记差异点（非漂移）。
 * @param {string} stateDir 状态目录
 * @param {(error: Error) => void} [onError] 读取失败回调（诊断可见面；**ENOENT 除外**——文件缺失是常态不是故障）
 * @returns {{frames: {sessionKey: string, id: string, text: string, ts: number}[], streaks: Object<string, number>, droppedBySession: Object<string, number>}}
 */
export function readState(stateDir, onError) {
  try {
    const raw = readFileSync(join(stateDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      // 可解析但顶层不是对象（写成 []/"x"/123）与解析失败同级：CR-15 要求「损坏必须可见」，
      // 不能只在 JSON.parse 抛错那一半可见（内部任务-295 复审 round2 N7）。
      if (typeof onError === 'function') { try { onError(new Error(`${STATE_FILE} 形状非法（顶层须为对象）`)); } catch { /* 诊断不得再抛 */ } }
      return emptyState();
    }
    const streaks = copyCountDict(parsed.streaks);
    const droppedBySession = copyCountDict(parsed.droppedBySession);
    // 旧单键对/单值字段（引擎迁移前形态）读侧兼容吸收：有则并入字典（幂等——引擎写回后消失）
    if (typeof parsed.streakKey === 'string' && parsed.streakKey !== '' && Number.isFinite(parsed.streakCount) && parsed.streakCount > 0) {
      const k = `s:${parsed.streakKey}`;
      streaks[k] = (streaks[k] ?? 0) + Math.floor(parsed.streakCount);
    }
    // 旧淘汰单值吸收：并入引擎可消化的哨兵键 `s:__legacy__`（deliverOn 首跳投递提醒消化——
    // 与引擎 normalizeState 迁移同键单点化，S 门评审：不可用宿主私有哨兵否则成死键）
    if (Number.isFinite(parsed.droppedByLimit) && parsed.droppedByLimit > 0) {
      const k = 's:__legacy__';
      droppedBySession[k] = (droppedBySession[k] ?? 0) + Math.floor(parsed.droppedByLimit);
    }
    const key = frameSessionKeyOf({ streaks });
    const frames = [];
    if (Array.isArray(parsed.frames)) {
      for (const frame of parsed.frames) {
        if (!isRecord(frame) || typeof frame.text !== 'string') continue;
        frames.push({
          sessionKey: typeof frame.sessionKey === 'string' && frame.sessionKey !== '' ? frame.sessionKey : key,
          id: typeof frame.id === 'string' ? frame.id : frameIdOf(frame.text),
          text: frame.text,
          ts: Number.isFinite(frame.ts) ? frame.ts : Date.now(),
        });
      }
    } else if (Array.isArray(parsed.pending)) {
      // 旧形状迁移路径（升级后首次运行）
      for (const item of parsed.pending) {
        if (!isRecord(item) || typeof item.text !== 'string') continue;
        frames.push({ sessionKey: key, id: typeof item.id === 'string' ? item.id : frameIdOf(item.text), text: item.text, ts: Number.isFinite(item.ts) ? item.ts : Date.now() });
      }
    }
    const kept = frames.slice(-PENDING_LIMIT);
    const dropped = frames.length - kept.length;
    if (dropped > 0) {
      // 读侧截断分账：被截断帧多为旧形态（无显式键，兜底键合成）——归引擎可消化哨兵（S 门评审）
      const k = 's:__legacy__';
      droppedBySession[k] = (droppedBySession[k] ?? 0) + dropped;
    }
    // 读侧截断同样计入淘汰（下次投递可见，不静默——内部任务-347 分账到被截断帧的兜底键）
    // 旧形状吸收（pending 迁移/旧字段并入）置标记：引擎据此在无其他变更时也写盘持久迁移结果
    const absorbedLegacy = Array.isArray(parsed.pending) || ('streakKey' in parsed) || ('droppedByLimit' in parsed);
    return { frames: kept, streaks, droppedBySession, __legacyAbsorbed: absorbedLegacy || undefined };
  } catch (error) {
    // 状态文件不存在是**常态**（首次运行 / 从未降级过），不是故障：不报诊断、不写恢复指引。
    // 否则每次钩子调用都会追加一行「状态读取失败…引擎不可用」，把诊断日志变成噪音
    // （内部任务-295 复审 round2 N0：健康路径误报，且与 CR-04/CR-08 的「不误导」纪律相反）。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return emptyState();
    if (typeof onError === 'function') { try { onError(error); } catch { /* 诊断不得再抛 */ } }
    return emptyState();
  }
}

/** 帧 id（内容指纹，用于去重）。 */
function frameIdOf(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 落状态（临时文件 + rename 原子替换；失败静默——状态是增强面，不值得反噬轮次）。
 * @param {string} stateDir 状态目录
 * @param {object} state 状态对象
 * @returns {boolean} 是否落盘成功
 */
export function writeState(stateDir, state) {
  let tmp = null;
  try {
    mkdirSync(stateDir, { recursive: true });
    sweepStaleTmp(stateDir); // 内部任务-347/内部未决-285：每脏写一次清扫（readdir 亚毫秒、fail-open）
    const target = join(stateDir, STATE_FILE);
    tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    // rename 失败（EPERM/杀软占用）时 tmp 会残留；反复失败会无界堆积，故尽力清掉再返回 false
    // （内部任务-295 复审 round2 N9）。
    if (tmp !== null) { try { unlinkSync(tmp); } catch { /* 尽力清理，失败不再抛 */ } }
    return false;
  }
}

/**
 * 清扫陈旧 tmp 残留（内部任务-347/内部未决-285，与 kimi 侧 sweepStaleTmp 同款）：原子写 tmp+rename
 * 的进程被杀路径会留 `<target>.tmp-<pid>-<hex>` 孤儿件。活性判据钉死错误码——仅
 * `process.kill(pid,0)` 抛 `ESRCH`（进程不存在）判死；`EPERM`（进程存在但权限拒发——
 * Windows pid4 System 实测）及其他错误码一律保守视为存活跳过。判死且 mtime 超过 1h 才
 * unlink（新鲜件保留——可能是并发写者的在途 tmp）。全程 best-effort fail-open。
 * @param {string} stateDir 状态目录
 * @returns {number} 清理件数
 */
export function sweepStaleTmp(stateDir) {
  let removed = 0;
  let names;
  try { names = readdirSync(stateDir); } catch { return 0; }
  for (const name of names) {
    const m = /^(.+)\.tmp-(\d+)-[0-9a-f]+$/.exec(name);
    if (m === null) continue;
    const pid = Number(m[2]);
    try {
      process.kill(pid, 0);
      continue; // 存活 → 跳过
    } catch (error) {
      if (!(error && error.code === 'ESRCH')) continue; // EPERM/其他＝保守存活
    }
    const full = join(stateDir, name);
    try {
      const st = statSync(full);
      if (Date.now() - st.mtimeMs < 3600_000) continue; // 新鲜件保留
      rmSync(full, { force: true });
      removed += 1;
    } catch { /* 单件失败继续 */ }
  }
  return removed;
}

/**
 * 入队一条待投递提醒（同文本按 digest 覆盖去重，保留最新时间戳）。
 * @param {object} state 当前状态
 * @param {string} text 提醒正文
 * @param {string} [sessionKey] 当前事件会话键——非空时帧键忠实取之（内部任务-2 批 A6：不再错挂
 *   旧 streakKey）；空串/缺省回落 `streakKey`/迁移哨兵（兜底尽力形态）。
 * @returns {object} 新状态
 */
export function enqueuePending(state, text, sessionKey) {
  const body = String(text ?? '').trim();
  if (body === '') return state;
  const id = frameIdOf(body);
  const key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : frameSessionKeyOf(state);
  // 去重键＝会话 + 文本（与引擎 relay 同语义）：只按文本会把他会话的同文案帧删掉
  const rest = state.frames.filter((frame) => !(frame.sessionKey === key && frame.text === body));
  const frame = { sessionKey: key, id, text: body, ts: Date.now() };
  const nextFrames = [...rest, frame];
  const evicted = nextFrames.length - PENDING_LIMIT; // 容量淘汰不静默（阶段复审① F5：shim 侧入队腿同计数——按会话分账，内部任务-347/内部未决-274）
  const nextState = { ...state, frames: nextFrames.slice(-PENDING_LIMIT) };
  if (evicted > 0) {
    const ek = `s:${key}`;
    nextState.droppedBySession = { ...(state.droppedBySession ?? {}) };
    nextState.droppedBySession[ek] = (nextState.droppedBySession[ek] ?? 0) + evicted;
  }
  return nextState;
}

/**
 * 连击计数**不在本层实现**（批 3 步骤 7 起语义单源＝`stop-pending-relay` 执行器；原 `bumpStreak`
 * 已删除）。`enqueuePending` 供**失败面**（超时降级、引擎不可得）与观察面入队；原 `drainPending`
 * 导出已删除（内部任务-2 批 A6：生产投递腿走引擎端口，无生产消费方——内部未决-47 处置口径）。
 */

/** ZCode 侧会话来源词表（内部接口-1 §2）——判据域已随批 3 迁入规则 `source-widen-normalize.params.mcode`，
 *  本内联白名单（原 `ZCODE_SOURCES`）已删除，此处仅留指针。 */

/**
 * MCode 原生工具名 → ZCode 工具名（内部接口-1 第三宿主登记差异 #2）。
 * 未命中的名字原样透传：护栏各自判「非本闸管辖工具」后静默放行，透传比丢弃安全。
 */
export const TOOL_MAP = Object.freeze({
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'LS',
  notebookedit: 'NotebookEdit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Task',
  agent: 'Agent',
});

/** 退出标记尾部行式样（宿主渲染文本的 seam 契约；只在**最后一个非空行**命中才算数）。 */
const EXIT_MARKER = /\[exit code:\s*(-?\d+)\]\s*$/i;

/** 从对象里取第一个非空字符串字段。 */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 从对象里取第一个布尔字段（只认真正的布尔，避免 'false' 字符串被当真）。 */
function firstBoolean(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === 'boolean') return source[key];
  }
  return undefined;
}

/** 从对象里取第一个可解析为整数的字段（数字或非空数字字符串）。刻意**不读 `status`**：
 * MCP/HTTP 形态的 `status`（如 500）会被误当成退出码，凭空记一条不存在的 tool-failure
 * ——与 内部未决-46「宁漏不误报」纪律相反（2026-09-30 收尾评审发现后移除）。 */
function firstInteger(source, keys) {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Math.trunc(Number(raw));
  }
  return null;
}

/**
 * 结果面 → ZCode 侧 `tool_result` 结构面（内部接口-1 第三宿主登记差异 #4）。
 *
 * 判序固定：结构化字段（`is_error` / `isError`、`exit_code` / `exitCode` / `code`）
 * → 宿主渲染文本的**尾部**退出标记 → 皆无即「不可知」（`exit_code: null`，
 * 交由 `post-tool.mjs` 的结构化判据走「宁漏不误报」分支）。文本单独**不**构成失败
 * 判据（内部未决-46① 的纪律：文本启发式归适配层，不进核心件）。
 * @param {unknown} toolResponse 宿主 `tool_response`（字符串或对象，形态不可预知）
 * @returns {{is_error: boolean, exit_code: number|null, stdout: string, stderr: string}}
 */
export function deriveToolResult(toolResponse) {
  if (isRecord(toolResponse)) {
    const stdout = firstString(toolResponse, ['stdout', 'output', 'text', 'content', 'result']);
    const flag = firstBoolean(toolResponse, ['is_error', 'isError']);
    const code = firstInteger(toolResponse, ['exit_code', 'exitCode', 'code']);
    if (flag !== undefined || code !== null) {
      return {
        is_error: flag ?? (code !== null && code !== 0),
        exit_code: code,
        stdout,
        stderr: firstString(toolResponse, ['stderr']),
      };
    }
    return { is_error: false, exit_code: null, stdout, stderr: '' };
  }
  const stdout = typeof toolResponse === 'string' ? toolResponse : '';
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const matched = EXIT_MARKER.exec(line);
    if (matched) {
      const code = Number(matched[1]);
      return { is_error: code !== 0, exit_code: code, stdout, stderr: '' };
    }
    break; // 只认最后一行：正文里出现的同形文本不算退出标记
  }
  return { is_error: false, exit_code: null, stdout, stderr: '' };
}

/**
 * MCode 负载 → ZCode 负载归一（内部接口-1 第三宿主登记差异 #2 与 #4）。
 * @param {string} event 事件名（MCode 侧）
 * @param {unknown} payload 宿主负载（不可信，字段逐处判类型）
 * @param {{projectDir: string, engine?: object}} ctx 上下文（工作区兜底 + **规则引擎**：来源归一的判据域与
 *   归一目标单源在 `source-widen-normalize.params.mcode`；缺引擎即具名抛错，不回落内联白名单）
 * @returns {object} 归一后的负载
 */
export function normalizePayload(event, payload, ctx) {
  const source = isRecord(payload) ? payload : {};
  const out = { ...source };
  if (typeof out.hook_event_name !== 'string' || out.hook_event_name === '') out.hook_event_name = event;
  if (typeof out.source === 'string') {
    // 引擎驱动（内部决策-037 批 3 步骤 9）：判据域与归一目标单源在 `source-widen-normalize.params.mcode`。
    // **无引擎即具名抛错**——禁回落内联白名单（那会成为第二条策略实现；shim 已在装载期传入引擎）。
    const engine = ctx?.engine;
    if (!engine || typeof engine.applyRule !== 'function') {
      throw new Error('hook-lib: normalizePayload 需要引擎（ctx.engine）——来源归一由 source-widen-normalize 单源');
    }
    const outcome = engine.applyRule('source-widen-normalize', 'mcode', { source: out.source });
    if (outcome.applied !== true || typeof outcome.result !== 'string') {
      throw new Error('hook-lib: 规则库字段契约漂移（source-widen-normalize 缺 params.mcode）——拒跑而非静默归一');
    }
    out.source = outcome.result;
  }
  if (typeof out.tool_name === 'string') out.tool_name = TOOL_MAP[out.tool_name] ?? out.tool_name;
  if (isRecord(out.tool_input)) {
    const toolInput = { ...out.tool_input };
    if (typeof toolInput.file_path !== 'string' && typeof toolInput.path === 'string') toolInput.file_path = toolInput.path;
    out.tool_input = toolInput;
  }
  if (event === 'PostToolUse') out.tool_result = deriveToolResult(out.tool_response);
  if (typeof out.cwd !== 'string' || out.cwd === '') out.cwd = ctx.projectDir;
  return out;
}

/**
 * 阻断兜底文案（内部任务-320／内部未决-281）：与 kimi 侧 `BLOCK_FALLBACK_REASON` 同源的**两键**版本。
 * kimi 侧第三键 `preToolUse` 在 MCode **无触发面**——MCode 的 PreToolUse 只用
 * `permissionDecision`（deny/ask/allow/defer），没有 `decision:'block'` 位 ⇒ 搬入即死代码，故不搬。
 * 同名不同签名的差异登记在 `内部规格` 第三宿主登记节（防后续回抄产生双源）。
 */
export const BLOCK_FALLBACK_REASON = Object.freeze({
  prompt: '用户提示被阻断，但未提供可读原因。',
  stop: '完成闸阻断，但未提供可读原因；请复核完成闸判定。',
});

/**
 * 取因单源：primary 为非空串 → trim 后用之；否则用 fallback。
 * （kimi 侧为三参 `resolveBlockReason(primary, stderr, fallback)`——MCode 无 stderr 通道，
 *  故本侧为**两参**形态；语义一致：阻断但无 reason 时不再静默降级为放行/零输出。）
 * @param {unknown} primary 主取因
 * @param {string} fallback 兜底文案
 * @returns {string}
 */
export function resolveBlockReason(primary, fallback) {
  if (typeof primary === 'string' && primary.trim() !== '') return primary.trim();
  return fallback;
}

/**
 * ZCode 信封 → MCode 响应（内部接口-1 第三宿主登记差异 #3 与 #5）。
 *
 * 落点严格取自宿主白名单（`allowedWireOutputKeys` 与各事件内层键集合）：
 * PreToolUse 只用 `permissionDecision` / `permissionDecisionReason`（ZCode 的
 * `systemMessage` 落在白名单外，整帧会被丢弃，故必须翻译）；Stop 只用顶层
 * `decision:"block"` + `reason`；其余事件的上下文位一律嵌在 `hookSpecificOutput` 内
 * （顶层**没有** `additionalContext` 这个键）。
 * @param {string} event 事件名（MCode 侧）
 * @param {unknown} envelope 子进程 stdout 解析出的信封（可为空）
 * @param {{blocked: boolean, engine?: object}} ctx 阻断上下文 +
 *   **规则引擎**（槽位迁移 `message-slot-migration.params.mcode.rename` 单源；缺引擎即具名抛错）
 * @returns {object|null} MCode 响应帧；null = 本次零输出
 */
export function translateResponse(event, envelope, ctx) {
  if (!isRecord(envelope)) return null;
  const specific = isRecord(envelope.hookSpecificOutput) ? envelope.hookSpecificOutput : null;
  const context = specific && typeof specific.additionalContext === 'string' ? specific.additionalContext : '';
  if (event === 'PreToolUse') {
    const decision = specific ? specific.permissionDecision : undefined;
    if (decision === 'deny' || decision === 'ask' || decision === 'allow' || decision === 'defer') {
      // 槽位迁移交引擎（内部决策-037 批 3 步骤 5）：`systemMessage → permissionDecisionReason` 的
      // 重命名与"目标键已存在不覆盖"语义单源在 `message-slot-migration.params.mcode.rename`；
      // 无引擎即具名抛错（禁回落内联读取＝禁第二份策略实现）。
      const slotEngine = ctx?.engine;
      if (!slotEngine || typeof slotEngine.applyRule !== 'function') {
        throw new Error('hook-lib: translateResponse 需要引擎（ctx.engine）——槽位迁移由 message-slot-migration 单源');
      }
      const migrated = slotEngine.applyRule('message-slot-migration', 'mcode', { envelope: specific ?? {} });
      if (migrated.applied !== true || !migrated.result || typeof migrated.result !== 'object') {
        throw new Error('hook-lib: 规则库字段契约漂移（message-slot-migration 缺 params.mcode）——拒译而非静默丢 reason');
      }
      const reason = migrated.result.permissionDecisionReason;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          ...(typeof reason === 'string' && reason !== '' ? { permissionDecisionReason: clampContext(reason) } : {}),
        },
      };
    }
    return context === '' ? null : { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  }
  if (event === 'SessionStart' || event === 'PostToolUse' || event === 'UserPromptSubmit') {
    // UserPromptSubmit 的阻断形态是顶层 decision/reason（与上下文位互斥，按阻断优先）。
    // 内部任务-320（内部未决-281）：判据放宽为「`decision==='block'` 即阻断」——reason 缺失不再静默降级
    // 为上下文帧/零输出（方向偏放行），改由兜底文案构因（kimi 侧同语义）。
    if (event === 'UserPromptSubmit' && envelope.decision === 'block') {
      return { decision: 'block', reason: clampContext(resolveBlockReason(envelope.reason, BLOCK_FALLBACK_REASON.prompt)) };
    }
    return context === '' ? null : { hookSpecificOutput: { hookEventName: event, additionalContext: clampContext(context) } };
  }
  if (event === 'Stop') {
    // 同上（内部未决-281）：`ctx.blocked` 即阻断——正文为空时不再静默零输出（连击上限内仍须传达阻断）。
    if (ctx.blocked) return { decision: 'block', reason: clampContext(resolveBlockReason(context, BLOCK_FALLBACK_REASON.stop)) };
    return null; // 非阻断提醒与超连击上限的阻断都走待投递中继（由调用方入队——连击门控单源＝引擎）
  }
  return null;
}

/**
 * 输出上限（宿主 stdout 硬上限 64 KiB，注入文本上限 65,536 字节，留半数余量后截断）。
 * **按 UTF-8 字节计**：中文 1 字符≈3 字节，按字符封顶会在中文场景越过 64 KiB 并被宿主杀进程。
 * 三条注入面（SessionStart / PostToolUse / UserPromptSubmit 上下文位与 Stop reason）
 * 必须共用这一个闸。
 */
const MAX_CONTEXT_BYTES = 60 * 1024;

/** 截断后缀（预算须先扣除它的字节数）。 */
const TRUNCATION_SUFFIX = '\n…（已截断）';

/**
 * 截断注入文本到宿主上限内（按 UTF-8 字节，码点边界安全）。
 * @param {string} text 文本
 * @returns {string}
 */
export function clampContext(text) {
  const body = String(text ?? '');
  if (Buffer.byteLength(body, 'utf8') <= MAX_CONTEXT_BYTES) return body;
  const budget = MAX_CONTEXT_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
  let out = '';
  let used = 0;
  for (const ch of body) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return `${out}${TRUNCATION_SUFFIX}`;
}

/**
 * 单行化（多行诊断会打断句子与 TSV 记录）。
 * @param {unknown} value 任意值
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' / ').slice(0, 400);
}

/**
 * 子钩子失败原因分类（shim 失败面文案单源）：超时/启动失败/信号终止/异常退出四态互异。
 * @param {{error?: Error & {code?: string}, status?: number|null, signal?: string|null, stderr?: string}} result spawnSync 结果
 * @returns {string}
 */
export function describeChildFailure(result) {
  const code = result && result.error && typeof result.error.code === 'string' ? result.error.code : '';
  if (code === 'ETIMEDOUT') return '宿主时限内未跑完';
  if (code !== '') return `子钩子启动失败（${code}）`;
  if (result && result.status === null) return `子钩子被信号终止（${String(result.signal ?? 'unknown')}）`;
  const tail = oneLine(String(result && result.stderr ? result.stderr : '')).slice(0, 200);
  const status = result && typeof result.status === 'number' ? result.status : 'unknown';
  return tail === '' ? `子钩子异常退出（退出码 ${status}）` : `子钩子异常退出（退出码 ${status}）：${tail}`;
}

/**
 * 会话键（负载 session_id → 轮号 → 进程 pid，逐级兜底；键只进状态文件不外泄）。
 * @param {unknown} payload 宿主负载
 * @returns {string}
 */
export function sessionKeyOf(payload) {
  const source = isRecord(payload) ? payload : {};
  for (const key of ['session_id', 'sessionId', 'turn_id']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key];
  }
  return `pid-${process.pid}`;
}

/**
 * 解析包根：宿主注入的 PLUGIN_ROOT / MINIMAX_PLUGIN_ROOT 优先，退到本文件上溯一级
 * （物化包内 shim 位于 <包根>/mcode/，故上溯一级即包根）。
 * @returns {string}
 */
export function resolvePluginRoot() {
  for (const key of ['PLUGIN_ROOT', 'MINIMAX_PLUGIN_ROOT']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return fileURLToPath(new URL('..', import.meta.url));
}
