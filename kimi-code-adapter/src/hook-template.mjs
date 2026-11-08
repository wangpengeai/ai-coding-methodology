// 文件：kimi-code-adapter/src/hook-template.mjs
// 描述：中立清单 `plugin.manifest.json` 的 hooks 节 → Kimi `kimi.plugin.json` 的 hooks[] 声明
//       **生成期翻译**（内部决策-038 决策 3）。翻译点三处（近恒等直译，差异面 row 9）＋
//       workflow 生成期 PostCompact 一条（`compact-workflow.mjs`，内部任务-297；不写回中立清单）：
//       ① 事件名原样（PascalCase 工具名、regex matcher 与 ZCode 同型；tool-vocab-map 规则
//          kimi 列不触发，不搬 mcode 的 MATCHER_TOOL_MAP 3 条）；
//       ② `SessionStart` 的 source matcher `startup|resume|clear|compact` **收窄为
//          `startup|resume`**（宿主词表仅两词，差异面 row 10；窄化由 source-widen-normalize
//          的运行期域外归一兜底，不漏配）；
//       ③ 处理器形态：单态跨平台 command——`"<abs-node>" ./kimi/hook-shim.mjs <事件> <脚本>
//          [声明时限秒]`（cwd=插件根，宿主注入 KIMI_CODE_HOME/KIMI_PLUGIN_ROOT；abs-node 双引号
//          包裹含空格安全，脚本相对路径正斜杠 node 全 shell 容忍；**不搬** mcode 的
//          commandLineOfWindows/%PLUGIN_ROOT% 双形态——Kimi 无双形字段）。
//       时限：声明值直传秒（全部 ≤60 ≪ 宿主上限 600；超限才封顶 600 并记 warning）。
//       纯函数面：不读盘、不写盘，测试可直测全部映射与边界。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.2/§4；内部规格 第四宿主登记

/** 宿主单处理器 timeout 上限（秒，hooks.html「timeout 1–600，默认 30」）。 */
export const TIMEOUT_MAX_SECONDS = 600;

/** 宿主单处理器 timeout 下限（秒）。 */
export const TIMEOUT_MIN_SECONDS = 1;

/** shim 在物化包内的相对路径（command 以 `./` 相对插件根引用；宿主 cwd=插件根）。 */
export const SHIM_REL = 'kimi/hook-shim.mjs';

/** SessionStart 收窄后的 source matcher（宿主词表仅 startup/resume，差异面 row 10）。 */
export const SESSION_START_MATCHER = 'startup|resume';

/** 本套件用到的事件枚举（hooks.html 事件表；清单校验器的 event 判据域）。 */
export const HOOK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PostCompact']);

/**
 * ZCode handler 的 `args` → 包内相对脚本路径（`${PLUGIN_ROOT}/hooks/x.mjs` → `hooks/x.mjs`）。
 * 认不出的形态返回空串（调用方跳过该处理器并计数，宁缺勿猜）。
 * @param {unknown} args ZCode `args` 数组
 * @returns {string}
 */
export function scriptRelOf(args) {
  if (!Array.isArray(args)) return '';
  for (const item of args) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/^\$\{PLUGIN_ROOT\}/, '')
      .replace(/^\$\{ZCODE_PLUGIN_ROOT\}/, '')
      .replace(/^\/+/, '');
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(cleaned)) continue;
    const segments = cleaned.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..')) continue;
    return cleaned;
  }
  return '';
}

/**
 * 时限翻译：`timeoutMs` → 宿主 `timeout`（秒）。声明值直传（Math.floor）；越 1..600 取值域
 * 才封顶/抬底并记 `capped`（六插件声明 2..60 全在域内，封顶是防御面）。
 * @param {unknown} timeoutMs 中立清单 `timeoutMs`
 * @returns {{seconds: number, capped: boolean}}
 */
export function timeoutOf(timeoutMs) {
  const raw = Number(timeoutMs);
  let seconds = Number.isFinite(raw) && raw > 0 ? Math.floor(raw / 1000) : TIMEOUT_MIN_SECONDS;
  seconds = Math.max(seconds, TIMEOUT_MIN_SECONDS);
  const capped = seconds > TIMEOUT_MAX_SECONDS;
  return { seconds: capped ? TIMEOUT_MAX_SECONDS : seconds, capped };
}

/**
 * matcher 翻译：SessionStart 的 source 词表收窄到宿主词表；工具事件 matcher 原样直传
 * （PascalCase 同族）；空/缺省返回 undefined（宿主按「每次都跑」处理，键省略）。
 * @param {string|undefined} matcher 中立清单 matcher
 * @param {string} event Kimi 事件名
 * @returns {string|undefined}
 */
export function matcherOf(matcher, event) {
  if (event === 'SessionStart') return SESSION_START_MATCHER;
  if (typeof matcher !== 'string' || matcher.trim() === '') return undefined;
  return matcher.trim();
}

/**
 * 处理器命令行（**单态跨平台**，无占位符变量）：`"<abs-node>" ./kimi/hook-shim.mjs <事件> <脚本> <时限秒>`。
 * abs-node 双引号包裹（路径含空格安全）；脚本相对路径正斜杠（node 全 shell 容忍正反斜杠）；
 * 宿主 cwd=插件根 + 注入 KIMI_PLUGIN_ROOT，故 shim 以 `./` 相对路径引用（差异面 row 5 处置：
 * 安装期绝对解释器路径把 shell 不确定性从调用面剔除）。
 * @param {string} nodePath 解释器绝对路径
 * @param {string} event Kimi 事件名
 * @param {string} scriptRel 脚本相对路径
 * @param {number} timeoutSeconds 声明时限
 * @returns {string}
 */
export function commandLineOf(nodePath, event, scriptRel, timeoutSeconds) {
  return `"${nodePath}" ./${SHIM_REL} ${event} ${scriptRel} ${timeoutSeconds}`;
}

/**
 * 中立清单 hooks 扁平数组 → Kimi hooks[] 声明（保源序；近恒等直译）。
 * PostToolUseFailure 原生存在（差异面对 mcode 的合并缺口不成立），双通道各留各的处理器。
 * @param {unknown} manifestHooks 中立清单 `hooks` 数组
 * @param {{nodePath: string, plugin?: string}} options 安装期解析的解释器与插件目录名
 * @returns {{hooks: object[], stats: {handlers: number, unresolved: number, capped: number}}} 声明与统计
 */
export function translateHookDeclarations(manifestHooks, options) {
  const out = [];
  let handlers = 0;
  let unresolved = 0;
  let capped = 0;
  if (!Array.isArray(manifestHooks)) return { hooks: out, stats: { handlers, unresolved, capped } };
  for (const handler of manifestHooks) {
    const scriptRel = scriptRelOf(handler && handler.args);
    if (!scriptRel || typeof handler.event !== 'string' || handler.event === '') {
      unresolved += 1;
      continue;
    }
    const { seconds, capped: wasCapped } = timeoutOf(handler.timeoutMs);
    if (wasCapped) capped += 1;
    const entry = {
      event: handler.event,
      command: commandLineOf(options.nodePath, handler.event, scriptRel, seconds),
      timeout: seconds,
    };
    const matcher = matcherOf(handler.matcher, handler.event);
    if (matcher !== undefined) entry.matcher = matcher;
    out.push(entry);
    handlers += 1;
    // workflow 的压缩轻量回放：只重投 skills/workflow/SKILL.md，不跑原 SessionStart
    // 的护栏自检/归档/nudge。仅 Kimi 生成期追加，不写入中立清单（内部模块-17 R-ka-3）。
    if (handler.event === 'SessionStart' && options.plugin === 'workflow') {
      out.push({
        event: 'PostCompact',
        matcher: 'manual|auto',
        command: `"${options.nodePath}" ./kimi/compact-workflow.mjs`,
        timeout: Math.min(seconds, TIMEOUT_MAX_SECONDS),
      });
      handlers += 1;
    }
  }
  // 观察面投递腿（内部任务-302 / 内部未决-269）：有钩子、且没有自身 UserPromptSubmit 的非 workflow 包
  // 各追加一条静态投递脚本，把本包观察面帧在下次提示投递出去。三合取缺一不可：
  // 非 workflow（避免与 shim 投递腿重复）／handlers 非空（research-loop 零钩子不追加）／
  // 无既有 UPS（能力判据，不按包名白名单）。不写入中立清单。
  const needsRelayLeg = options.plugin !== 'workflow'
    && handlers > 0
    && !out.some((entry) => entry.event === 'UserPromptSubmit');
  if (needsRelayLeg) {
    out.push({
      event: 'UserPromptSubmit',
      command: `"${options.nodePath}" ./kimi/relay-drain.mjs`,
      timeout: Math.min(5, TIMEOUT_MAX_SECONDS),
    });
    handlers += 1;
  }
  return { hooks: out, stats: { handlers, unresolved, capped } };
}

/**
 * 按宿主判据校验生成的 hooks[]（四字段白名单、event 枚举、matcher 正则可编译、
 * command 非空、timeout 1..600 整数）。复刻 hooks.html 的条目形态，测试与安装期自检共用。
 * @param {unknown} hooks hooks[] 数组
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateHookEntries(hooks) {
  const problems = [];
  if (!Array.isArray(hooks)) return ['hooks 必须是数组'];
  for (const entry of hooks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('hooks 条目必须是对象');
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['event', 'matcher', 'command', 'timeout'].includes(key)) problems.push(`hooks 条目含不被接受的字段：${key}`);
    }
    if (!HOOK_EVENTS.includes(entry.event)) problems.push(`未知事件：${String(entry.event)}`);
    if (entry.matcher !== undefined) {
      if (typeof entry.matcher !== 'string' || entry.matcher.trim() === '') {
        problems.push(`matcher 非空字符串：${String(entry.matcher)}`);
      } else {
        try {
          new RegExp(entry.matcher);
        } catch {
          problems.push(`matcher 正则不可编译：${entry.matcher}`);
        }
      }
    }
    if (typeof entry.command !== 'string' || entry.command.trim() === '') problems.push('command 缺失');
    if (entry.timeout !== undefined && (!Number.isInteger(entry.timeout) || entry.timeout < TIMEOUT_MIN_SECONDS || entry.timeout > TIMEOUT_MAX_SECONDS)) {
      problems.push(`timeout 越界（须 1..600 整数）：${String(entry.timeout)}`);
    }
  }
  return problems;
}
