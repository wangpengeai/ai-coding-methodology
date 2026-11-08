// 文件：mcode-adapter/src/hook-template.mjs
// 描述：ZCode `hooks/hooks.json` → MCode 钩子声明的**生成期翻译**（内部决策-034 决策 1/4/5）。
//       翻译点五处：① 处理器形态（`type:"process"` + `command`+`args` → `type:"command"`
//       + 单 `command` 字符串，脚本路径经 `${PLUGIN_ROOT}` 引用）；② 时限
//       （`timeoutMs` → `timeout`，按宿主 1..10 秒封顶取小）；③ matcher 工具名原生化；
//       ④ 事件合并（`PostToolUseFailure` 并入 `PostToolUse`，同事件同脚本只留一个处理器，
//       否则每次工具调用会跑两遍）；⑤ **合成 UPS 投递腿**（2026-11-08 内部任务-356：源声明没有
//       `UserPromptSubmit` 却有 `SessionStart`/`Stop` 的包，补一个指向 `mcode/relay-drain.mjs`
//       的处理器——否则中继队列永远没有人排干，降级帧只能攒到上限被淘汰）。
//       纯函数面：不读盘、不写盘，测试可直测全部映射与边界。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { EVENT_MAP, MATCHER_TOOL_MAP, MCODE_EVENTS, MERGED_POST_TOOL_MATCHER, SESSION_START_MATCHER } from './plugin-meta.mjs';

/** 宿主单处理器 `timeout` 上限（秒，local-plugin-hooks.md）。 */
export const TIMEOUT_MAX_SECONDS = 10;

/** 宿主单处理器 `timeout` 下限（秒）。 */
export const TIMEOUT_MIN_SECONDS = 1;

/** shim 在物化包内的相对路径（清单/声明都用包内相对路径）。 */
export const SHIM_REL = 'mcode/hook-shim.mjs';

/** 合成 UPS 投递腿的包内相对脚本路径（内部任务-356：四包缺 UPS 时生成期补腿）。 */
export const RELAY_DRAIN_REL = 'mcode/relay-drain.mjs';

/**
 * ZCode handler 的 `args` → 包内相对脚本路径（`${ZCODE_PLUGIN_ROOT}/hooks/x.mjs` → `hooks/x.mjs`）。
 * 认不出的形态返回空串（调用方跳过该处理器并计数，宁缺勿猜）。
 * @param {unknown} args ZCode `args` 数组
 * @returns {string}
 */
export function scriptRelOf(args) {
  if (!Array.isArray(args)) return '';
  for (const item of args) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/^\$\{ZCODE_PLUGIN_ROOT\}/, '')
      .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}/, '')
      .replace(/^\/+/, '');
    const segments = cleaned.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) continue;
    if (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(cleaned)) return cleaned;
  }
  return '';
}

/**
 * 时限翻译：`timeoutMs` → 宿主 `timeout`（秒）。按 1..10 封顶取小；缺失/不可解析取默认 5。
 * @param {unknown} timeoutMs ZCode `timeoutMs`
 * @returns {number} 秒
 */
export function timeoutOf(timeoutMs) {
  const raw = Number(timeoutMs);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.floor(raw / 1000) : 5;
  if (seconds < TIMEOUT_MIN_SECONDS) return TIMEOUT_MIN_SECONDS;
  return Math.min(seconds, TIMEOUT_MAX_SECONDS);
}

/**
 * matcher 翻译：按 `|` 拆词表逐项映射到原生工具名；非工具词（`source` 词表）原样保留。
 * @param {string|undefined} matcher ZCode 组 matcher
 * @param {string} event MCode 事件名
 * @returns {string|undefined} 原生 matcher；无则 undefined（宿主按「每次都跑」处理）
 */
export function matcherOf(matcher, event) {
  if (event === 'SessionStart') return SESSION_START_MATCHER;
  if (event === 'PostToolUse') return MERGED_POST_TOOL_MATCHER;
  if (typeof matcher !== 'string' || matcher.trim() === '') return undefined;
  const parts = matcher
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => MATCHER_TOOL_MAP[part] ?? part);
  return parts.length === 0 ? undefined : parts.join('|');
}

/**
 * 处理器命令行（POSIX 形态）：`node` 绝对路径 + shim + 事件 + 脚本相对路径 + 声明时限（秒）。
 * 绝对路径是刻意取舍：宿主不为钩子注入独立 Node（local-plugin-hooks.md），且钩子进程的
 * PATH 与交互式终端未必一致；安装期解析一次并写入，换机重跑 `install` 即重新解析。
 *
 * **包根必须用 shell 变量引用，不能写死路径**：宿主只把 `PLUGIN_ROOT` 注入子进程环境
 * （`runner.ts` 的 `env`），**不做命令串里的字符串替换**；MINIMAX 形态又不允许 `args`/
 * `shell`（`parser.ts` 对非 CLAUDE 判 `HOOK_HANDLER_UNSUPPORTED`），故执行必然经
 * `shell: true`（`command-invocation.ts`）——包根只能由 shell 自己展开。
 * @param {string} nodePath 解释器绝对路径
 * @param {string} event MCode 事件名
 * @param {string} scriptRel 脚本相对路径
 * @param {number} timeoutSeconds 声明时限
 * @returns {string}
 */
export function commandLineOf(nodePath, event, scriptRel, timeoutSeconds) {
  return `"${nodePath}" "\${PLUGIN_ROOT}/${SHIM_REL}" ${event} "${scriptRel}" ${timeoutSeconds}`;
}

/**
 * 处理器命令行（Windows 形态）：与 POSIX 形态**只差包根变量的引用语法**。
 *
 * **为什么必须分形态**（2026-10-02 对宿主 `command-invocation.ts` / `parser.ts` /
 * `runner.ts` 取证）：Windows 上宿主走 `shell: true` ⇒ `cmd.exe`，它只认 `%VAR%`，
 * **不认 `${VAR}`**。若 `commandWindows` 与 `command` 逐字相同，cmd.exe 会把
 * `${PLUGIN_ROOT}` 当字面量传给 node ⇒ 全部处理器**起不来**（node 报 MODULE_NOT_FOUND）
 * ⇒ 钩子/护栏面静默消失（宿主对钩子失败 fail-open，用户侧零提示）。且宿主在 win32
 * **优先取 `commandWindows`**（`commandValue`），填错比不填更坏。
 * shim 的事件参数与脚本相对路径由 Node 侧 `join()` 消费，正反斜杠皆可，故只换包根语法。
 * @param {string} nodePath 解释器绝对路径
 * @param {string} event MCode 事件名
 * @param {string} scriptRel 脚本相对路径
 * @param {number} timeoutSeconds 声明时限
 * @returns {string}
 */
export function commandLineOfWindows(nodePath, event, scriptRel, timeoutSeconds) {
  return `"${nodePath}" "%PLUGIN_ROOT%/${SHIM_REL}" ${event} "${scriptRel}" ${timeoutSeconds}`;
}

/**
 * 整份 ZCode 声明 → MCode 钩子声明。
 *
 * 事件级去重：同一 MCode 事件内，`(matcher, 脚本)` 相同的处理器只保留第一个
 * （`PostToolUseFailure` 与 `PostToolUse` 两条声明指向同一脚本，合并后必然重复）。
 * @param {object} zcodeDoc ZCode `hooks/hooks.json` 解析结果
 * @param {{nodePath: string, syntheticRelayDrain?: boolean}} options 安装期解析的解释器；`syntheticRelayDrain` 为 true 时对缺 UPS 且有 SessionStart/Stop 的包补合成投递腿
 * @returns {{doc: {hooks: object}, stats: {handlers: number, deduped: number, unresolved: number, unresolvedDetails: {event: string, index: number, reason: string, scriptRel?: string}[], scripts: string[], events: string[], syntheticRelayDrain: boolean}}} 声明与统计
 */
export function translateHookDoc(zcodeDoc, options) {
  const groups = zcodeDoc && typeof zcodeDoc === 'object' && zcodeDoc.hooks && typeof zcodeDoc.hooks === 'object' ? zcodeDoc.hooks : {};
  const out = {};
  const seen = new Set();
  let handlers = 0;
  let deduped = 0;
  let unresolved = 0;
  const unresolvedDetails = [];
  const scripts = [];
  for (const [zcodeEvent, groupList] of Object.entries(groups)) {
    const event = EVENT_MAP[zcodeEvent];
    if (!event || !Array.isArray(groupList)) {
      const count = Array.isArray(groupList) ? groupList.length : 1;
      unresolved += count;
      for (let index = 0; index < count; index += 1) unresolvedDetails.push({ event: zcodeEvent, index, reason: 'unknown-event' });
      continue;
    }
    for (let groupIndex = 0; groupIndex < groupList.length; groupIndex += 1) {
      const group = groupList[groupIndex];
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        unresolved += 1;
        unresolvedDetails.push({ event: zcodeEvent, index: groupIndex, reason: 'bad-group' });
        continue;
      }
      for (const handler of group.hooks) {
        const scriptRel = scriptRelOf(handler && handler.args);
        if (!scriptRel) {
          unresolved += 1;
          unresolvedDetails.push({ event: zcodeEvent, index: groupIndex, reason: 'bad-script' });
          continue;
        }
        const timeoutSeconds = timeoutOf(handler.timeoutMs);
        const matcher = matcherOf(group.matcher, event);
        const key = `${event}|${matcher ?? '*'}|${scriptRel}`;
        if (seen.has(key)) {
          deduped += 1; // 合并后的重复声明（双通道同脚本）——预期行为，不是缺陷
          continue;
        }
        seen.add(key);
        scripts.push(scriptRel);
        const command = commandLineOf(options.nodePath, event, scriptRel, timeoutSeconds);
        const commandWindows = commandLineOfWindows(options.nodePath, event, scriptRel, timeoutSeconds);
        const entry = { hooks: [{ type: 'command', command, commandWindows, timeout: timeoutSeconds }] };
        if (matcher !== undefined) entry.matcher = matcher;
        if (!Array.isArray(out[event])) out[event] = [];
        out[event].push(entry);
        handlers += 1;
      }
    }
  }
  // 内部任务-356：四包（spec-gate/scout/team-governance/algo-loop）有 SessionStart/Stop 但无
  // UserPromptSubmit，中继帧无处排干。生成期补一个指向零依赖 no-op 载体的 UPS 处理器；
  // 仅当源声明没有 UPS 时补，workflow 不重复。载体的 stdin 消费与投递语义由 shim 承担。
  let syntheticRelayDrain = false;
  if (options.syntheticRelayDrain === true && out.UserPromptSubmit === undefined && (out.SessionStart !== undefined || out.Stop !== undefined)) {
    const timeoutSeconds = 5;
    out.UserPromptSubmit = [{
      hooks: [{
        type: 'command',
        command: commandLineOf(options.nodePath, 'UserPromptSubmit', RELAY_DRAIN_REL, timeoutSeconds),
        commandWindows: commandLineOfWindows(options.nodePath, 'UserPromptSubmit', RELAY_DRAIN_REL, timeoutSeconds),
        timeout: timeoutSeconds,
      }],
    }];
    scripts.push(RELAY_DRAIN_REL);
    handlers += 1;
    syntheticRelayDrain = true;
  }
  return { doc: { hooks: out }, stats: { handlers, deduped, unresolved, unresolvedDetails, scripts: [...new Set(scripts)].sort(), events: Object.keys(out).sort(), syntheticRelayDrain } };
}

/**
 * 按宿主判据校验生成的声明（字段白名单、timeout 取值域、matcher 形态与长度）。
 * 复刻 `local-plugin-hooks.md` 的规则，测试与安装期自检共用。
 * @param {object} doc MCode 钩子声明
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateHookDoc(doc) {
  const problems = [];
  const groups = doc && typeof doc === 'object' && doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : null;
  if (!groups) return ['hooks 字段缺失或不是对象'];
  let count = 0;
  for (const [event, groupList] of Object.entries(groups)) {
    if (!MCODE_EVENTS.includes(event)) {
      problems.push(`未知事件：${event}`);
      continue;
    }
    if (!Array.isArray(groupList) || groupList.length === 0) {
      problems.push(`事件 ${event} 的处理器组为空或不是数组`);
      continue;
    }
    for (const group of groupList) {
      if (group.matcher !== undefined) {
        if (typeof group.matcher !== 'string' || group.matcher.length > 256) problems.push(`事件 ${event} 的 matcher 非法或超 256 字符`);
        if (group.matcher.includes('(') || group.matcher.includes('\\')) problems.push(`事件 ${event} 的 matcher 含 look-around/反向引用`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        problems.push(`事件 ${event} 的处理器列表为空`);
        continue;
      }
      for (const handler of group.hooks) {
        count += 1;
        for (const key of Object.keys(handler)) {
          if (!['type', 'command', 'commandWindows', 'timeout'].includes(key)) problems.push(`处理器含不被接受的字段：${key}`);
        }
        if (handler.type !== 'command') problems.push('处理器 type 必须是 command');
        if (typeof handler.command !== 'string' || handler.command.trim() === '') problems.push('处理器 command 缺失');
        if (handler.commandWindows !== undefined && (typeof handler.commandWindows !== 'string' || handler.commandWindows.trim() === '')) {
          problems.push('commandWindows 非空字符串');
        } else if (typeof handler.commandWindows === 'string' && handler.commandWindows.includes('${')) {
          // Windows 上宿主优先取 commandWindows，而 cmd.exe 不展开 `${VAR}`（见
          // `commandLineOfWindows` 的取证注释）：这一条把"Windows 上全部处理器静默失效"
          // 从宿主侧静默失败，提前成本层安装期的显式失败。
          problems.push(`commandWindows 含 POSIX 变量语法（cmd.exe 不展开）：${handler.commandWindows}`);
        }
        if (handler.timeout !== undefined && (!Number.isInteger(handler.timeout) || handler.timeout < TIMEOUT_MIN_SECONDS || handler.timeout > TIMEOUT_MAX_SECONDS)) {
          problems.push(`timeout 越界：${String(handler.timeout)}`);
        }
      }
    }
  }
  if (count > 64) problems.push(`单插件可执行处理器 ${count} 个，超宿主上限 64`);
  return problems;
}
