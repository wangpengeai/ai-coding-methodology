// 文件：kimi-code-adapter/kimi/hook-shim.mjs
// 描述：Kimi Code 钩子面的运行时 shim（随包物化到 <包根>/kimi/，由清单 hooks[] 声明的每个
//       处理器调用一次）。职责五件，刻意保持薄：
//       ① 读宿主负载 → 归一成 ZCode 形态（多键兼容读取、写类入参补写、来源词表交引擎归一）；
//       ② spawn 被物化的 **ZCode 原钩子脚本**（不复制、不改写其语义；判据/护栏/闸仍是同一份
//          代码在跑——钩子脚本是冻结资产）；
//       ③ 把 ZCode 信封译成 Kimi 宿主母语位（PreToolUse deny 双通道 JSON+exit 2+stderr；
//          UserPromptSubmit 阻断 exit 2+stderr / 上下文 stdout 纯文本；Stop 阻断 exit 2+stderr
//          喂回模型；观察面帧入待投递队列，下一个 UserPromptSubmit 投递）；
//       ④ 时限——子进程预算＝声明时限减 800ms 余量（宿主上限 600s 在一切声明值之上，
//          `timeout-cap-fail-open` 规则 kimi 列不触发，无 MCode 的 fail-open+提醒分支）；
//       ⑤ 引擎装载与失败可见面——从**包内** `plugin-core` 装载规则引擎；不可得即按事件响亮
//          失败（PreToolUse→deny+exit 2／UserPromptSubmit→stdout 诊断直给／Stop 与观察面→
//          待投递中继 + hook-diagnostics.log），绝不静默放行、绝不回落旧实现。
//       全程 fail-open（宿主同向）：超时/崩溃/无信封非阻断异常 → exit 0 零帧；唯一例外是
//       check-freeze 自身的 fail-closed 极性——负载不可读时**原样透传垃圾字节**给子钩子自判，
//       shim 只做忠实转发，不「修好」再送（硬规则 4 的唯一例外经透传保真）。
// 用法：node hook-shim.mjs <Kimi 事件名> <ZCode 钩子脚本相对路径> [声明时限秒]
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BLOCK_FALLBACK_REASON,
  clampContext,
  createRelayPorts,
  drainRelayForPrompt,
  enqueueOrReport,
  normalizePayload,
  readStdin,
  resolveBlockReason,
  resolvePluginRoot,
  resolveSessionProjectRootDetailed,
  resolveStateDir,
  sessionKeyOf,
  stateDirNote,
  translatePreToolUseResponse,
  writeDiagnostic,
} from './hook-lib.mjs';

/** 子进程 stdout 上限（MiB）：宿主追加进上下文，留足余量后截断。 */
const MAX_BUFFER_MB = 1;

/** 子进程 stderr 转发上限（字符）：阻断原因面，超出即丢（截断后仍是可用原因）。 */
const STDERR_ECHO_LIMIT = 4096;

/** 子进程预算余量（毫秒）：声明时限减余量，给 shim 自己的译出留收尾时间。 */
const BUDGET_MARGIN_MS = 800;

/** 声明时限缺省（秒）：命令行尾参缺失/不可解析时的兜底（六插件声明值 2..60 均远小于此面无关）。 */
const DEFAULT_DECLARED_SECONDS = 5;

/** 宿主根 env 旁证：宿主注入 KIMI_PLUGIN_ROOT 与 shim 自身推导不一致时记诊断（推导仍以物化位置为准）。 */
function corroboratePluginRoot(pluginRoot, stateDir) {
  const injected = process.env.KIMI_PLUGIN_ROOT;
  if (typeof injected !== 'string' || injected.trim() === '') return;
  let self = pluginRoot;
  try {
    self = realpathSync(pluginRoot);
  } catch { /* 推导失败不阻断——旁证只诊断 */ }
  if (injected !== self) {
    writeDiagnostic(stateDir, 'bootstrap', `KIMI_PLUGIN_ROOT(${injected}) 与 shim 推导包根(${self})不一致`, '以 shim 物化位置为准；如持续出现请重跑 install');
  }
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

/** 声明时限（秒）→ 子进程 budget（毫秒）：声明值减余量直通（宿主 600s 上限在一切声明值之上，无封顶规则面）。 */
function budgetOf(rawSeconds) {
  const seconds = Number(rawSeconds);
  const declared = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DECLARED_SECONDS;
  return Math.max(declared * 1000 - BUDGET_MARGIN_MS, 200);
}

/**
 * 引擎装载（随包物化）：副本在**包内**（`<插件包根>/plugin-core/`），`loadEngine` 收包根
 * （契约 `join(repoRoot,'plugin-core',file)`）。失败不抛：返回 `{ error }` 交由失败可见面处置
 * （宿主对进程失败 fail-open 且 stderr 非用户可见面，故必须自己把事实送到可见面）。
 * 装载用运行期 `await import(pathToFileURL(…))`（动态 ESM 导入）⇒ 不受 `require(esm)` 版本门槛约束。
 * @param {string} pluginRoot 插件包根
 * @returns {Promise<{engine?: object, error?: Error}>} 引擎实例或失败原因（不抛）
 */
async function loadEngineForShim(pluginRoot) {
  try {
    const { loadEngine } = await import(pathToFileURL(resolveEngineEntry(pluginRoot)).href);
    return { engine: loadEngine(pluginRoot) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 包内引擎入口绝对路径。 */
function resolveEngineEntry(pluginRoot) {
  return `${pluginRoot}/plugin-core/src/engine.mjs`;
}

/** 恢复指引（逐通道帧文案与诊断行共用）——含**实际路径与数据目录**（完整恢复指引）。 */
function recoveryHint(pluginRoot) {
  const coreDir = `${pluginRoot}/plugin-core`;
  const dataDir = process.env.KIMI_CODE_HOME ?? '<KIMI_CODE_HOME>';
  return `引擎不可用：请检查插件包内副本 ${coreDir}，在仓库根运行 \`node kimi-code-adapter/cli.mjs verify --data-dir ${dataDir}\` 并重跑 \`node kimi-code-adapter/cli.mjs install\`；请把本提示转述给用户。`;
}

/** 降级文案单点（帧与待投递入队共用，避免两处各改各的）。 */
function engineFailureText(event, pluginRoot, detail) {
  const reason = String(detail ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' / ').slice(0, 400);
  return `【${event} 钩子降级】${reason}。${recoveryHint(pluginRoot)}`;
}

/**
 * 引擎不可用时的**按事件可见面**（宿主母语位白名单内可表达者优先）：
 * `PreToolUse` → deny JSON + exit 2 + stderr（用户可见的决策位；本宿主无 ask 升格位，
 * 差异面处置＝保守 deny）；`UserPromptSubmit` → stdout 诊断纯文本直给（宿主明示直追上下文）；
 * `Stop` 与观察面 → 待投递中继（下一个 UserPromptSubmit 送达）+ hook-diagnostics.log。
 * @param {string} event 事件名
 * @param {string} pluginRoot 插件包根
 * @param {string} stateDir 状态目录
 * @param {string} detail 失败原因
 * @returns {number} 进程退出码
 */
function engineFailureVisibility(event, pluginRoot, stateDir, detail, sessionKey) {
  const noted = typeof process.env.KIMI_CODE_HOME === 'string' && process.env.KIMI_CODE_HOME.trim() !== '' ? detail : `${detail}；${stateDirNote()}`;
  const text = engineFailureText(event, pluginRoot, noted);
  writeDiagnostic(stateDir, event, noted, recoveryHint(pluginRoot));
  if (event === 'PreToolUse') {
    const frame = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: text } };
    process.stdout.write(`${JSON.stringify(frame)}\n`);
    process.stderr.write(`${text}\n`);
    return 2;
  }
  if (event === 'UserPromptSubmit') {
    process.stdout.write(`${clampContext(text)}\n`);
    return 0;
  }
  // Stop / SessionStart / PostToolUse / PostToolUseFailure：无注入位或观察面 → 入待投递队列
  const enqueued = enqueueOrReport(stateDir, text, sessionKey, event);
  if (!enqueued) process.stderr.write(`${text}\n`); // 状态面不可写时的兜底可见面（不静默丢失降级事实）
  return 0;
}

/**
 * 当前事件会话键（模块级）：payload 解析后由 main 写入——底部 catch 兜底拿不到 main 局部
 * 变量，经它把会话键带给 enqueuePending（空串时回落 streakKey 的尽力形态，hook-lib JSDoc）。
 */
let activeSessionKey = '';

/**
 * 主流程（一次性执行；装载后异常由 main().catch 兜底送可见面）。
 * @returns {Promise<number>} 进程退出码
 */
async function main() {
  const [event, scriptRel, timeoutRaw] = process.argv.slice(2);
  if (!event || !scriptRel) return 0;
  const pluginRoot = resolvePluginRoot();
  const stateDir = resolveStateDir(pluginRoot);
  corroboratePluginRoot(pluginRoot, stateDir);
  // 先读负载再装载引擎（与引擎装载互不依赖）：会话键在一切分支前算好——引擎失败可见面、
  // 观察面入队、超时降级帧全部需要它（A3 会话键忠实化单一来源）。
  let payload = null;
  const rawStdin = await readStdin();
  try {
    const parsed = JSON.parse(rawStdin);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = null; // 不可读：透传原始字节，让原钩子自己判极性（见下方 childInput 注释）
  }
  const sessionKey = sessionKeyOf(payload);
  activeSessionKey = sessionKey;
  // 装载引擎：不可得即按事件响亮失败——绝不放行、绝不回落旧实现（退回静默即红）。
  const loaded = await loadEngineForShim(pluginRoot);
  if (!loaded.engine) {
    return engineFailureVisibility(event, pluginRoot, stateDir, loaded.error instanceof Error ? loaded.error.message : String(loaded.error), sessionKey);
  }
  const projectDetail = resolveSessionProjectRootDetailed(payload, stateDir);
  const projectDir = projectDetail.root;
  // H-5 可见化：解析链最终 fallback **且负载带 cwd**（桌面端形态＝cwd=宿主应用目录无标记；
  // cwd 缺席属 CLI/测试形态，process.cwd() 兜底合法、不触发）＝项目根未解析——租约闸/冻结
  // 护栏在本事件上落激活域之外。全部此类事件落诊断日志；UPS 额外入队一帧提醒（下一轮可见，
  // 持续到写类事件暖化会话缓存后自然停止）。Bash 无注入位，帧等下轮 UPS 投递。
  const payloadCwd = payload && typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : '';
  if (projectDetail.via === 'fallback' && payloadCwd !== '') {
    const fallbackNote = `项目根未解析（cwd=${projectDetail.root}，via=fallback）——租约闸/冻结护栏本会话可能未生效`;
    writeDiagnostic(stateDir, event, fallbackNote, '带路径的工具调用（Read/Edit/Write）后会自动恢复');
    if (event === 'UserPromptSubmit') {
      enqueueOrReport(stateDir, `【workflow 提示】${fallbackNote}；带路径的工具调用后将自动恢复`, sessionKey, event);
    }
  }
  const zcodePayload = normalizePayload(event, payload, { projectDir, engine: loaded.engine });
  // 负载不可读时**原样透传垃圾字节**给原钩子，不做"修复"：check-freeze 的
  // 「负载不可读 → deny」是 ZCode 侧唯一的 fail-closed 极性（硬规则 4 的唯一例外），
  // 若本层先替它把负载修好再送过去，那条极性在本宿主就结构性不可达（mcode 收尾评审同款教训）。
  const childInput = payload ? JSON.stringify(zcodePayload) : String(rawStdin);
  // 包根 containment 复检（生成期 scriptRelOf 已拒 `.`/`..`；此处防 argv 形态漂移/手写清单）
  const childScript = resolve(pluginRoot, scriptRel);
  const relFromRoot = relative(resolve(pluginRoot), childScript);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    writeDiagnostic(stateDir, event, `钩子脚本越出包根：${scriptRel}`, '重跑 install 生成合法声明');
    return 0;
  }
  const result = spawnSync(process.execPath, [childScript], {
    input: childInput,
    encoding: 'utf8',
    timeout: budgetOf(timeoutRaw),
    killSignal: 'SIGTERM',
    maxBuffer: MAX_BUFFER_MB * 1024 * 1024,
    env: {
      ...process.env,
      ZCODE_PLUGIN_ROOT: pluginRoot,
      ZCODE_PROJECT_DIR: projectDir,
      KIMI_HOOK_EVENT: event,
    },
    windowsHide: true,
  });
  const childStderr = String(result.stderr ?? '');
  const envelope = parseEnvelope(result.stdout);
  const spawnCode = result.error ? String(result.error.code ?? '') : '';
  const timedOut = spawnCode === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const spawnFailed = Boolean(result.error) && !timedOut;
  // 子进程超时/崩溃（600s 宿主时限下 MCode 的 fail-open+提醒分支不成立，差异面 row 8）：
  // 观察面/无注入位事件入队降级提醒（下一轮 UserPromptSubmit 送达）；UPS stdout 一行直追；
  // PreToolUse 维持仅诊断日志（无 additionalContext 注入位、deny 会误伤正常慢命令——差异面
  // 登记接受注记，内部模块-17/设计文档随批回写）。
  if (timedOut || spawnFailed || (result.status !== 0 && result.status !== 2 && !envelope)) {
    const reason = timedOut
      ? '宿主时限内未跑完'
      : (spawnFailed ? `子进程启动失败（${spawnCode || '未知'}）` : (result.signal ? `子进程被信号终止（${String(result.signal)}）` : '子进程异常退出'));
    const degradedText = `【${basename(pluginRoot)} 钩子降级】${reason}（${scriptRel}，status=${String(result.status)}），本次未作判定；需要该判定时请手动补跑对应门禁或命令。`;
    writeDiagnostic(stateDir, event, `子钩子未正常结束（status=${String(result.status)}，${scriptRel}）`, '如频繁出现请检查该钩子脚本或重跑 install');
    if (event === 'UserPromptSubmit') {
      process.stdout.write(`${clampContext(degradedText)}\n`);
      return 0;
    }
    if (event === 'Stop' || event === 'SessionStart' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
      enqueueOrReport(stateDir, degradedText, sessionKey, event);
    }
    return 0;
  }
  const blocked = result.status === 2;
  // 「退出码 2 且无信封」：spec-gate 硬阻断档（stderr + exit 2 无信封）在本宿主**原生可用**
  // （exit 2 即阻断语义）。但 Stop 事件必须仍过引擎——否则该形态的阻断不计连击、
  // 连击上限对它是死路径（内部未决-277）；故 Stop 取 stderr 作阻断正文进引擎，其余事件直通。
  const hardBlockNoEnvelope = blocked && !envelope;
  if (hardBlockNoEnvelope && event !== 'Stop') {
    if (childStderr !== '') process.stderr.write(childStderr.slice(0, STDERR_ECHO_LIMIT));
    return 2;
  }
  const ownContext = envelope && envelope.hookSpecificOutput && typeof envelope.hookSpecificOutput.additionalContext === 'string'
    ? envelope.hookSpecificOutput.additionalContext
    : (event === 'Stop' && hardBlockNoEnvelope ? childStderr.trim() : '');
  const relayPorts = createRelayPorts(stateDir, event);
  // 观察面（SessionStart/PostToolUse/PostToolUseFailure）：宿主无注入位（fire-and-forget），
  // 帧落待投递队列，下一个 UserPromptSubmit 以纯文本投递（差异面 row 1；relayEvents 四事件全走此路）。
  // 入队用 hook-lib 原语（不耗 Stop 连击预算——预算语义单源＝引擎 stop-pending-relay）。
  if (event === 'SessionStart' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (ownContext !== '') enqueueOrReport(stateDir, ownContext, sessionKey, event);
    return 0;
  }
  if (event === 'Stop') {
    // 连击门控交引擎（stop-pending-relay.params.kimi：burstCap/capNote/入队全在规则；
    // kimi 列无 triggerEvent，入队腿**省略 ctx.event** 即过执行器门控——引擎测试登记的接线形态）。
    const relayOutcome = loaded.engine.applyRule('stop-pending-relay', 'kimi', { sessionKey, blocked, text: ownContext }, relayPorts);
    if (!relayOutcome.applied || !relayOutcome.result || typeof relayOutcome.result.streak !== 'number') {
      throw new Error('hook-shim: 规则库字段契约漂移（stop-pending-relay 缺 params.kimi）——拒跑而非静默丢提醒');
    }
    // 阻断直译**仅当引擎判定"未降级"**（连击在 burstCap 内）：exit 2 + stderr=additionalContext，
    // 宿主把阻断消息喂回模型继续本轮（完成闸母语语义）。降级/非阻断一律零帧（提醒已由引擎入队）。
    const blockedWithinCap = blocked && relayOutcome.result.degraded === false;
    if (blockedWithinCap) {
      // 阻断但子钩子未给正文：仍须阻断（不得静默放行）；原因优先子钩子 stderr，其次通用文案
      const reason = resolveBlockReason(ownContext, childStderr, BLOCK_FALLBACK_REASON.stop);
      process.stderr.write(clampContext(reason).slice(0, STDERR_ECHO_LIMIT));
      return 2;
    }
    return 0;
  }
  if (event === 'UserPromptSubmit') {
    // 阻断优先（队列原样不清）：子钩子顶层 decision:block+reason 时整帧走阻断位，
    // 待投递队列留待下一次提示再投（与 mcode 两跳回归同款语义）。
    const blockedPrompt = envelope !== null && envelope.decision === 'block';
    if (blockedPrompt) {
      const reason = resolveBlockReason(envelope.reason, childStderr, BLOCK_FALLBACK_REASON.prompt);
      process.stderr.write(clampContext(reason).slice(0, STDERR_ECHO_LIMIT));
      return 2;
    }
    // 投递腿交共享原语（收养孤儿帧 → 引擎 deliverOn → 契约校验 → 出队），与子钩子自身上下文
    // 合并后经同一闸钳位，以**纯文本**直追上下文（宿主明示 UserPromptSubmit 返回文本追加进上下文）。
    const pendingText = drainRelayForPrompt({ engine: loaded.engine, sessionKey, stateDir, ports: relayPorts });
    const merged = [pendingText, ownContext].filter((part) => part !== '').join('\n');
    if (merged !== '') process.stdout.write(`${clampContext(merged)}\n`);
    return 0;
  }
  // PreToolUse：deny/ask 翻 deny 双通道直译，allow/defer/无帧零输出。
  const action = translatePreToolUseResponse(envelope, { engine: loaded.engine });
  if (action) {
    if (action.stdout !== '') process.stdout.write(action.stdout);
    if (action.stderr !== '') process.stderr.write(action.stderr.slice(0, STDERR_ECHO_LIMIT));
    return action.exit;
  }
  if (blocked) {
    // exit 2 已表达阻断，但信封形状不可识别（缺 permissionDecision）时不得静默放行
    const reason = clampContext(resolveBlockReason(
      envelope && envelope.hookSpecificOutput && typeof envelope.hookSpecificOutput.permissionDecisionReason === 'string'
        ? envelope.hookSpecificOutput.permissionDecisionReason
        : (envelope && envelope.hookSpecificOutput && typeof envelope.hookSpecificOutput.systemMessage === 'string'
          ? envelope.hookSpecificOutput.systemMessage
          : (envelope && typeof envelope.reason === 'string' ? envelope.reason : '')),
      childStderr,
      BLOCK_FALLBACK_REASON.preToolUse,
    ));
    const frame = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } };
    process.stdout.write(`${JSON.stringify(frame)}\n`);
    process.stderr.write(`${reason}\n`);
    return 2;
  }
  return 0;
}

// 兜底：**已装载后的规则库字段契约漂移**（消费点具名抛错）也必须走可见面——退回静默即红。
// 此路径刻意不调用任何可能再抛的辅助函数（不读状态、不落复杂帧），只做最小拼装 + 直写，
// 避免"兜底自己再炸一次"。
main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const event = typeof process.argv[2] === 'string' ? process.argv[2] : '';
  const detail = String(error instanceof Error ? error.message : error).split(/\r?\n/)[0];
  try {
    const pluginRoot = typeof process.env.KIMI_PLUGIN_ROOT === 'string' && process.env.KIMI_PLUGIN_ROOT !== '' ? process.env.KIMI_PLUGIN_ROOT : '<插件包根>';
    const text = `【${event === '' ? 'unknown' : event} 钩子降级】${detail}。规则库字段契约漂移：请检查 ${pluginRoot}/plugin-core 与仓库 plugin-core 的规则数据是否同版，重跑 \`node kimi-code-adapter/cli.mjs install\` 后复核；请把本提示转述给用户。`;
    if (event === 'PreToolUse') {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: text } })}\n`);
      process.stderr.write(`${text}\n`);
    } else if (event === 'UserPromptSubmit') {
      process.stdout.write(`${text}\n`);
    }
    const dir = resolveStateDir(resolvePluginRoot());
    mkdirSync(dir, { recursive: true });
    writeDiagnostic(dir, event === '' ? 'unknown' : event, detail, '规则库字段契约漂移');
    if (event === 'Stop' || event === 'SessionStart' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
      enqueueOrReport(dir, text, activeSessionKey, event === '' ? 'unknown' : event);
    }
  } catch { /* 失败面不得再抛 */ }
  try { process.stdin.destroy?.(); } catch { /* 释放 stdin，避免 exitCode 模式下挂住 */ }
  process.exitCode = event === 'PreToolUse' ? 2 : 0;
});
