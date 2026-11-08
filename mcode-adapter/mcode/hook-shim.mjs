// 文件：mcode-adapter/mcode/hook-shim.mjs
// 描述：MCode 钩子面的运行时 shim（随包物化到 <包根>/mcode/，由宿主声明的每个处理器
//       调用一次）。职责五件，刻意保持薄：
//       ① 读宿主负载 → 归一成 ZCode 形态（工具名、写类入参名、失败事件合并后的
//          `tool_result` 结构面）；
//       ② spawn 被物化的 **ZCode 原钩子脚本**（不复制、不改写其语义；判据/护栏/闸
//          仍是同一份代码在跑）；
//       ③ 把 ZCode 信封译成 MCode 白名单内的响应（`systemMessage` →
//          `permissionDecisionReason`；Stop 只用顶层 `decision:"block"`）；
//       ④ 时限与降级——对子进程设内部 deadline（宿主单处理器上限 10 秒减余量），
//          超时即终止并 fail-open，同时把降级事实落成待投递提醒。
//       ⑤ 引擎装载与失败可见面（批 3）——从**包内** `plugin-core` 装载规则引擎；不可得即按
//          事件响亮失败（PreToolUse→ask+reason／其余→诊断帧／Stop→待投递中继），并把诊断
//          追加到 `PLUGIN_DATA/hook-diagnostics.log`（静态宿主不给用户看 stderr，故必须自己送面）。
//       全程 fail-open：任何异常都静默退 0、零 stdout（project-conventions 硬规则 4）；唯一
//       例外是 `check-freeze` 自身的 fail-closed 极性——那由被 spawn 的原钩子发出，
//       shim 只做忠实转发，不「修正」。
// 用法：node hook-shim.mjs <MCode 事件名> <ZCode 钩子脚本相对路径> [声明时限秒]
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MIGRATION_SESSION_KEY,
  clampContext,
  describeChildFailure,
  enqueuePending,
  normalizePayload,
  readState,
  readStdin,
  resolvePluginRoot,
  resolveStateDir,
  sessionKeyOf,
  translateResponse,
  writeState,
} from './hook-lib.mjs';

/**
 * 收养孤儿帧（阶段复审① F4 + A6）：两类永不可投递帧在投递前收养为当前会话——
 * ① legacy 哨兵帧（旧盘态迁移，键=固定哨兵）；② `pid-` 起头的兜底键帧（负载不可读/缺
 * session_id 时每进程新 pid，投递过滤后成死信）。真会话键帧不受影响（一次性遗留面）。
 * @param {string} stateDir 状态目录
 * @param {string} sessionKey 当前会话键
 * @param {string} event 事件名（诊断用）
 * @param {string} pluginRoot 包根（恢复指引用）
 */
function adoptLegacyFrames(stateDir, sessionKey, event, pluginRoot) {
  const state = readState(stateDir);
  const isOrphan = (key) => key === MIGRATION_SESSION_KEY || key.startsWith('pid-');
  if (!state.frames.some((frame) => isOrphan(frame.sessionKey))) return;
  state.frames = state.frames.map((frame) => (isOrphan(frame.sessionKey) ? { ...frame, sessionKey } : frame));
  // 经 persist 落盘：养失败必须可见（CR-03 的同一纪律）——裸写会把「收养未生效」留成静默死信
  // （内部任务-295 复审 round2 N3）。
  persist(stateDir, state, event, pluginRoot);
}

/** 子进程 stdout 上限（MiB）：宿主上限 64 KiB，留足余量后截断。 */
const MAX_BUFFER_MB = 1;

/** 子进程 stderr 转发上限（字符）：仅供宿主日志诊断，超出即丢。 */
const STDERR_ECHO_LIMIT = 4096;

/** 宿主工作区（负载 cwd 优先，其次宿主注入的 MINIMAX_PROJECT_DIR，最后进程 cwd）。 */
function resolveProjectDir(payload) {
  if (payload && typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd;
  const injected = process.env.MINIMAX_PROJECT_DIR;
  if (typeof injected === 'string' && injected !== '') return injected;
  return process.cwd();
}

/** 解析 ZCode 钩子 stdout 的信封：取**最后一个**非空行解析（诊断行在前、信封在后）。 */
function parseEnvelope(stdout) {
  const text = String(stdout ?? '');
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 非 JSON 行（人类可读诊断）→ 继续往前找 */
    }
  }
  return null;
}

/** 声明时限（秒）→ 子进程 budget（毫秒）。 */
function budgetOf(rawSeconds, engine) {
  // 引擎驱动（内部决策-037 批 3 步骤 8）：`timeout-cap-fail-open` 的 `params.mcode` 供默认值/夹取/余量/下限
  // 与宿主上限封顶；**单位口径**＝命令行尾参是**秒**、引擎公式按**毫秒** ⇒ 此处做换算。
  const seconds = Number(rawSeconds);
  const declaredTimeoutMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  const outcome = engine.applyRule('timeout-cap-fail-open', 'mcode', { declaredTimeoutMs });
  if (outcome.applied !== true || !outcome.result || typeof outcome.result.childBudgetMs !== 'number') {
    throw new Error('hook-shim: 规则库字段契约漂移（timeout-cap-fail-open 缺 params.mcode）——拒跑而非静默取默认时限');
  }
  return outcome.result.childBudgetMs;
}

/** 写出唯一响应帧（一行 JSON，末尾换行）。空响应即零输出。 */
function emit(frame) {
  if (!frame) return;
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/**
 * 引擎装载（批 3 步骤 4）：副本在**包内**（`<插件包根>/plugin-core/`），`loadEngine` 收包根
 * （契约 `join(repoRoot,'plugin-core',file)`）。失败不抛：返回 `{ error }` 交由下方失败可见面处置
 * （静态宿主对进程失败 fail-open、不给用户看 stderr，故必须自己把事实送到可见面）。
 * 装载用运行期 `await import(pathToFileURL(…))`（动态 ESM 导入）⇒ **不受 `require(esm)` 的
 * Node ≥22.12/≥20.19 门槛约束**（内部未决-58）：更早版本上含顶层 await 的 ESM 引擎同样可装载。
 * @param {string} pluginRoot 插件包根
 * @returns {Promise<{engine?: object, error?: Error}>} 引擎实例或失败原因（不抛）
 */
async function loadEngineForShim(pluginRoot) {
  try {
    const { loadEngine } = await import(pathToFileURL(join(pluginRoot, 'plugin-core', 'src', 'engine.mjs')).href);
    return { engine: loadEngine(pluginRoot) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 诊断日志落点（计划指定；宿主 stderr 对用户不可见，不得用作落点）。 */
function diagnosticLogPath() {
  const dir = process.env.PLUGIN_DATA;
  return typeof dir === 'string' && dir !== '' ? join(dir, 'hook-diagnostics.log') : null;
}

/** 把任意错误/细节压成**单行**（多行 Node 诊断如 `Require stack:` 会打断句子与 TSV 记录）。 */
function singleLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' / ').slice(0, 400);
}

/** 追加一条诊断（单行 TSV：时间 + 事件 + 原因 + 恢复指引）；落点不可用/写入失败一律静默（诊断不得再抛）。 */
function writeDiagnostic(event, detail, recovery) {
  const target = diagnosticLogPath();
  if (target === null) return;
  try {
    mkdirSync(dirname(target), { recursive: true }); // 目录尚未创建时也要留下痕迹（与 writeState 同姿态）
    appendFileSync(target, `${new Date().toISOString()}\t${event}\t${singleLine(detail)}\t${recovery}\n`, 'utf8');
  } catch { /* 诊断不得再抛 */ }
}

/**
 * 恢复指引（逐通道帧文案与诊断行共用）——含**实际路径与数据目录**（计划步骤 4 要求"完整恢复指引"）。
 * @param {string} pluginRoot 插件包根
 * @returns {string} 指引文本（单行）
 */
function recoveryHint(pluginRoot) {
  const coreDir = join(pluginRoot, 'plugin-core');
  return `引擎不可用：请检查插件包内副本 ${coreDir}，在仓库根运行 \`node mcode-adapter/cli.mjs verify\`（安装时若用了 --data-dir，请补同一路径）并重跑 \`node mcode-adapter/cli.mjs install\`；请把本提示转述给用户。`;
}

/**
 * 状态面（PLUGIN_DATA）失败的指引。**与「引擎不可用」分开**：可写性问题不该把用户引向
 * 重装插件（内部任务-295 复审 round2 N8，与 CR-08「指引必须可执行且不出错方向」同一纪律）。
 * @param {string} pluginRoot 插件包根
 * @returns {string} 指引文本（单行）
 */
function stateHint(pluginRoot) {
  const dir = process.env.PLUGIN_DATA;
  const where = typeof dir === 'string' && dir !== '' ? dir : resolveStateDir(pluginRoot);
  return `状态面不可写：请检查数据目录 ${where} 的写权限与磁盘余量，修复后重跑 \`node mcode-adapter/cli.mjs install\`；待投递提醒可能丢失，请把本提示转述给用户。`;
}

/**
 * 子钩子（物化的原钩子）未正常返回的指引。**与引擎装载、状态落盘分开**。
 * @param {string} scriptRel 子钩子包内相对路径
 * @returns {string} 指引文本（单行）
 */
function childHint(scriptRel) {
  return `子钩子未正常返回：请检查 ${scriptRel} 与其依赖，在仓库根运行 \`node mcode-adapter/cli.mjs verify\`（安装时若用了 --data-dir，请补同一路径）并重跑 \`node mcode-adapter/cli.mjs install\`；请把本提示转述给用户。`;
}

/**
 * 「退出 2 且无信封」的指引：这是宿主的**跨宿主能力差**（本宿主无阻断位），不是插件故障——
 * 不得让用户去「检查钩子脚本」（内部任务-295 复审 round3 N-b）。
 * @returns {string} 指引文本（单行）
 */
function blockedHint() {
  return '该事件在本宿主没有阻断位：阻断意图已原样保留为待投递提醒，插件本身无需修复；需要硬阻断时请在 ZCode 侧执行对应门禁。';
}

/**
 * 落状态；失败落诊断（状态面是增强面，但失败必须可见）。
 * @param {string} stateDir 状态目录
 * @param {object} state 状态
 * @param {string} event 事件名
 * @param {string} pluginRoot 包根
 * @returns {boolean} 是否成功
 */
function persist(stateDir, state, event, pluginRoot) {
  const ok = writeState(stateDir, state);
  if (!ok) writeDiagnostic(event, '状态落盘失败（PLUGIN_DATA 不可写或 rename 失败）', stateHint(pluginRoot));
  return ok;
}

/** 降级文案单点（帧与待投递入队共用，避免两处各改各的）。 */
function engineFailureText(event, pluginRoot, detail) {
  return `【${event} 钩子降级】${singleLine(detail)}。${recoveryHint(pluginRoot)}`;
}

/**
 * 引擎不可用时的**按事件可见面**（白名单内可表达者优先）：
 * `PreToolUse` → `ask` + reason（用户可见的决策位）；其余事件 → 诊断帧（注入模型上下文，
 * 文案含恢复指引与"请转述给用户"）；`Stop` 无注入位 → 交给调用方走待投递中继。
 * @param {string} event 事件名
 * @param {string} pluginRoot 插件包根
 * @param {string} detail 失败原因
 * @returns {object|null} 要 emit 的帧；`Stop` 返回 null（由调用方入队）
 */
function engineFailureFrame(event, pluginRoot, detail) {
  const text = engineFailureText(event, pluginRoot, detail);
  if (event === 'PreToolUse') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: clampContext(text) } };
  }
  if (event === 'Stop') return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/**
 * 主流程（一次性执行，异常即退 0）。
 * @returns {Promise<void>}
 */
async function main() {
  const [event, scriptRel, timeoutRaw] = process.argv.slice(2);
  if (!event || !scriptRel) {
    process.exit(0);
  }
  const pluginRoot = resolvePluginRoot();
  const stateDir = resolveStateDir(pluginRoot);
  // 先读负载再装载引擎（与引擎装载互不依赖）：会话键在一切分支前算好——失败面与超时面
  // 入队都需要它（内部任务-2 批 A6：帧键忠实化，不再错挂旧 streakKey/迁移哨兵成死信帧）。
  let payload = null;
  const rawStdin = await readStdin();
  try {
    const parsed = JSON.parse(rawStdin);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = null; // 不可读：透传原始字节，让原钩子自己判极性（见下方 childInput 注释）
  }
  const sessionKey = sessionKeyOf(payload);
  // 装载引擎（批 3 步骤 4）：不可得即按事件可见面响亮失败——绝不放行、绝不回落旧实现。
  const loaded = await loadEngineForShim(pluginRoot);
  if (!loaded.engine) {
    const detail = loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
    writeDiagnostic(event, detail, recoveryHint(pluginRoot));
    const text = engineFailureText(event, pluginRoot, detail);
    if (event === 'Stop') {
      // Stop 无注入位：走待投递中继（队列原语保留在 hook-lib，参数不在此复制第二份；
      // 帧键显式传当前会话键——内部任务-2 批 A6）
      persist(stateDir, enqueuePending(readState(stateDir), text, sessionKey), event, pluginRoot);
    } else {
      emit(engineFailureFrame(event, pluginRoot, detail));
    }
    process.exit(0);
  }
  const projectDir = resolveProjectDir(payload);
  const zcodePayload = normalizePayload(event, payload, { projectDir, engine: loaded.engine });
  const scriptPath = join(pluginRoot, scriptRel);
  // 负载不可读时**原样透传垃圾字节**给原钩子，不做"修复"：check-freeze 的
  // 「负载不可读 → deny」是 ZCode 侧唯一的 fail-closed 极性（project-conventions 硬规则 4 的
  // 唯一例外），若本层先替它把负载修好再送过去，那条极性在本宿主上就结构性不可达
  // （2026-09-30 收尾评审发现；处置见 内部接口-1 第三宿主登记）。
  const childInput = payload ? JSON.stringify(zcodePayload) : String(rawStdin);
  const result = spawnSync(process.execPath, [scriptPath], {
    input: childInput,
    encoding: 'utf8',
    timeout: budgetOf(timeoutRaw, loaded.engine),
    killSignal: 'SIGTERM',
    maxBuffer: MAX_BUFFER_MB * 1024 * 1024,
    env: {
      ...process.env,
      ZCODE_PLUGIN_ROOT: pluginRoot,
      ZCODE_PROJECT_DIR: projectDir,
      MCODE_HOOK_EVENT: event,
    },
    windowsHide: true,
  });
  if (typeof result.stderr === 'string' && result.stderr !== '' && result.stderr.length <= STDERR_ECHO_LIMIT) {
    process.stderr.write(result.stderr);
  }
  const envelope = parseEnvelope(result.stdout);
  const timedOut = Boolean(result.error) || result.status === null;
  const state = readState(stateDir, (error) => writeDiagnostic(event, `状态读取失败：${error instanceof Error ? error.message : String(error)}`, stateHint(pluginRoot)));
  const key = sessionKey; // 会话键已在 main 头部计算（A6 单一来源）
  // 超时或子进程异常退出（无信封）→ fail-open，并把降级事实落成待投递提醒：
  // 「假装通过」是本层明令禁止的姿态（内部决策-034 决策 6）。
  // 「退出码 2 且无信封」一并入此分支：ZCode 侧有一类阻断只写 stderr 不输出信封
  // （`spec-gate/hooks/post-tool-use.mjs` 的阻断档即是），本宿主无该事件的阻断位，
  // 若不在此拦一道，它会退化成**彻底静默**——连降级提醒都没有（2026-09-30 收尾评审发现）。
  if (timedOut || (result.status !== 0 && !envelope)) {
    const blockedNoEnvelope = result.status === 2;
    const reason = blockedNoEnvelope ? '子钩子要求阻断但未输出信封（本宿主无该阻断位）' : describeChildFailure(result);
    // 指引按故障类别分流：`exit 2 无信封` 是**跨宿主能力差**（设计内），不是插件故障，
    // 不得让用户去「检查钩子脚本」（内部任务-295 复审 round3 N-b）。
    writeDiagnostic(event, reason, blockedNoEnvelope ? blockedHint() : childHint(scriptRel));
    const next = enqueuePending(state, `【${event} 钩子降级】${reason}（${scriptRel}），本次未作判定；需要该判定时请手动补跑对应门禁或命令。`, key);
    persist(stateDir, next, event, pluginRoot);
    process.exit(0);
  }
  const blocked = result.status === 2;
  const ownContext = envelope && envelope.hookSpecificOutput && typeof envelope.hookSpecificOutput.additionalContext === 'string'
    ? envelope.hookSpecificOutput.additionalContext
    : '';
  // relay 双腿交引擎（内部决策-037 批 3 步骤 7）：连击计数、连击上限、上限文案与入队全在
  // `stop-pending-relay.params.mcode`；本层只注入 `{readState, writeState}` 端口与
  // `ctx.sessionKey`（缺则引擎**具名抛错**——跨会话串话比显式报错更坏）。
  const relayPorts = {
    readState: () => readState(stateDir),
    writeState: (next) => { persist(stateDir, next, event, pluginRoot); },
  };
  let relayOutcome = null;
  if (event === 'Stop') {
    relayOutcome = loaded.engine.applyRule('stop-pending-relay', 'mcode', { event, sessionKey: key, blocked, text: ownContext }, relayPorts);
    if (relayOutcome.applied !== true || !relayOutcome.result) {
      throw new Error('hook-shim: 规则库字段契约漂移（stop-pending-relay 缺 params.mcode）——拒跑而非静默丢提醒');
    }
  }
  // 阻断直译**仅当引擎判定"未降级"**（阻断在连击上限内）；降级/入队路径一律零 Stop 帧
  //（提醒已由引擎经端口写入状态，等下一次 UserPromptSubmit 投递）。
  const blockedWithinCap = blocked && relayOutcome !== null && relayOutcome.result.degraded === false;
  let frame = translateResponse(event, envelope, { blocked: blockedWithinCap, engine: loaded.engine });
  if (event === 'UserPromptSubmit') {
    // **阻断优先于投递**（2026-10-02 修 D2）：宿主的 UserPromptSubmit 输出位是"上下文 或
    // 顶层 decision:block+reason"二选一（`allowedWireOutputKeys` 两处都收，但语义互斥），
    // 装不下两者。故子钩子给出阻断帧时**整帧原样透传、且不清队列**——队列原样留给下一次
    // 提示再投。此前无论队列是否为空都把帧换成上下文帧：队列非空时阻断连同 reason 一起
    // 消失 ⇒ deny 静默变放行（真机复现：期望 `{decision:block}`，实得 `additionalContext`）。
    // 判据取信封本身（`translateResponse` 同一形态），不另立第二份解析。
    // 内部任务-320（内部未决-281）：判据与 `translateResponse` 同步放宽为「`decision==='block'` 即阻断」
    // ——两处是同一判据的两份副本，只改一处会互斥（lib 判阻断、shim 按上下文帧替换 ⇒ 阻断帧被挤掉）。
    const blockedPrompt = envelope !== null && envelope.decision === 'block';
    if (blockedPrompt) {
      emit(frame);
      process.exit(0);
    }
    // 投递腿同样交引擎（`deliverOn` 分支）：`delivered`/`dropped` 由规则决定，本层只做
    // "与子钩子自身上下文合并"（同一次注入，宿主只有 UserPromptSubmit 一个上下文位）。
    // 投递前先**收养 legacy 哨兵帧**（内部任务-2 批 A6）：旧盘态迁移帧键为固定哨兵（当时无法
    // 知归属会话），投递按会话过滤后它们成死信——收养为当前会话键即恢复旧「升级不丢待投递」
    // 语义（仅限哨兵帧=一次性遗留面；新帧一律显式键，不经此路）。
    adoptLegacyFrames(stateDir, key, event, pluginRoot);
    const drained = loaded.engine.applyRule('stop-pending-relay', 'mcode', { event, sessionKey: key }, relayPorts);
    if (drained.applied !== true || !drained.result || !Array.isArray(drained.result.delivered)) {
      throw new Error('hook-shim: 规则库字段契约漂移（stop-pending-relay 缺 params.mcode）——拒跑而非静默堵住投递');
    }
    const pendingText = drained.result.delivered
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter((text) => text !== '')
      .join('\n');
    const own = frame && frame.hookSpecificOutput && typeof frame.hookSpecificOutput.additionalContext === 'string'
      ? frame.hookSpecificOutput.additionalContext
      : '';
    const merged = [pendingText, own].filter((part) => part !== '').join('\n');
    // 仅在**确有内容要注入**时替换帧：队列与自身上下文皆空时必须**原样保留**子钩子的帧
    //（否则顶层阻断帧 `{decision:'block'}` 会被静默吞掉 ⇒ deny 变放行方向；门 B 实跑抓到的回归）。
    frame = merged === '' ? frame : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: clampContext(merged) } };
  }
  emit(frame);
  process.exit(0);
}

// 兜底：**已装载后的规则库字段契约漂移**（消费点具名抛错）也必须走可见面——先前冒泡到此被
// 静默吞成"零输出 exit 0"（门 B F3 实跑：删 `message-slot-migration.params.mcode` 后
// PreToolUse 的 deny 直接消失）。此路径**刻意不调用任何可能再抛的辅助函数**（不 resolvePluginRoot、
// 不读写状态、不落帧构造器），只做最小拼装 + 直写 stdout，避免"兜底自己再炸一次"。
main().catch((error) => {
  const event = typeof process.argv[2] === 'string' ? process.argv[2] : '';
  const detail = String(error instanceof Error ? error.message : error).split(/\r?\n/)[0];
  const pluginRoot = typeof process.env.PLUGIN_ROOT === 'string' ? process.env.PLUGIN_ROOT : '<插件包根>';
  try {
    const text = `【${event === '' ? 'unknown' : event} 钩子降级】${detail}。规则库字段契约漂移：请检查 ${pluginRoot}/plugin-core 与仓库 plugin-core 的规则数据是否同版，重跑 \`node mcode-adapter/cli.mjs install\` 后复核；请把本提示转述给用户。`;
    if (event === 'PreToolUse') {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: text } })}\n`);
    } else if (event !== '' && event !== 'Stop') {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`);
    }
    const dir = typeof process.env.PLUGIN_DATA === 'string' && process.env.PLUGIN_DATA !== '' ? process.env.PLUGIN_DATA : null;
    if (dir !== null) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'hook-diagnostics.log'), `${new Date().toISOString()}\t${event === '' ? 'unknown' : event}\t${detail}\t规则库字段契约漂移\n`, 'utf8');
    }
  } catch { /* 失败面不得再抛 */ }
  process.exit(0);
});
