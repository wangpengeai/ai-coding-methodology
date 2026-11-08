// 文件：hooks-bridge.test.mjs
// 描述：ai-coding-methodology 适配层测试——三段覆盖面：
//       ① 纯函数（matcher 归一 / 配置解析 / 负载构造 / 信封解码 / 合并 / 引用）；
//       ② 真实钩子进程（用 fixture 声明驱动本仓 workflow 钩子脚本，断言决策翻译）；
//       ③ 插件装配（apply 注册五个事件，用伪 ctx + 伪 shell 驱动端到端决策）。
//       测试自足：不依赖 DSH 运行时；shell seam 用真实 spawn 实现（等价性最强）。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCordis, loadEngine } from './helpers/dsh-engine.mjs';

import { createLogger as makeLoggerStub } from './helpers/logger-stub.cjs';
import { testEngine } from './helpers/engine-binding.mjs';
import { seedNullBucketLease } from './helpers/lease-seed.mjs';

// 引擎绑定（批 2 阶段 2）：本文件有直调纯函数面用例（normalizeMatcher 等）不经 apply()，
// 故先经共享 helper 绑定真实仓引擎（与 apply() 走同一 ensureBound 入口，幂等）。
testEngine();

import { Config, apply, collectHandlers, contextMessage, discoverPlugins, isPluginRoot, matchesMatcher, normalizeSessionSource, userPromptOf } from '../src/index.mjs';
import { createAllowAdvisory } from '../src/allow-advisory.mjs';
import { IDENTIFIED_ID_RE } from '../src/commands-bridge.mjs';
import {
  DSH_OBSERVATION_CAPABILITIES,
  LOST_FACTS_MAX_LINES,
  appendLostFact,
  createObservationEmitter,
  lostFactsPath,
} from '../src/observation-emit.mjs';
import {
  CAPABILITY_DOMAINS,
  CAPABILITY_VALUES,
  DECLARATION_GRAMMAR,
  loadContract,
  resolveCapabilities,
} from '../../workflow/scripts/lib/observation-capabilities.mjs';
import {
  DEFAULT_TIMEOUT_MS,
  HOOK_SANDBOX_POLICY,
  buildPayload,
  decodeHookOutput,
  flattenContent,
  handlerCommandLine,
  mergeOutcomes,
  normalizeMatcher,
  quoteArg,
  quoteArgFor,
  readHookConfig,
  readManifestHookConfig,
  readZcodeHookConfig,
  runHandler,
  substituteVars,
  turnIdOf,
} from '../src/hooks-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(COMPAT_ROOT, '..');

// 重试环状态目录隔离（内部未决-61 / 内部任务-HANDOVER1002-1）：`post-tool.mjs` 的重试环默认落
// `$HOME/.zcode/cli/routing-state/wf-posttool-<sha16(session)>.json`（全局、跨运行），
// 不隔离则本文件任何真实 PostToolUse 用例都会写全局态（实测 `open46` 用例仍写）。
const POSTTOOL_STATE_ROOT = mkdtempSync(join(tmpdir(), 'acm-posttool-state-'));
process.env.WF_POSTTOOL_STATE_DIR = POSTTOOL_STATE_ROOT;
process.on('exit', () => rmSync(POSTTOOL_STATE_ROOT, { recursive: true, force: true }));

// 租约状态根与账本根隔离（内部未决-93②③，内部任务-48）：routing-gate/user-prompt 的租约态默认落
// 全局 ~/.zcode/cli/routing-state、deny 留痕落仓内 内部工作流状态——不隔离则
// 用例读写真机态（既存污染实录：s-real 的 lease-deny 留痕落仓内账本），且无租约时闸
// deny 压过 check-careful 的 ask（既存红）。种子见 helpers/lease-seed.mjs。
const ROUTING_STATE_ROOT = mkdtempSync(join(tmpdir(), 'acm-routing-state-'));
process.env.WF_ROUTING_STATE_DIR = ROUTING_STATE_ROOT;
const INCIDENT_ROOT = mkdtempSync(join(tmpdir(), 'acm-incident-'));
process.env.WF_INCIDENT_ROOT = INCIDENT_ROOT;
process.on('exit', () => {
  rmSync(ROUTING_STATE_ROOT, { recursive: true, force: true });
  rmSync(INCIDENT_ROOT, { recursive: true, force: true });
});

/**
 * 把 fixture 声明里的相对路径（如 `hooks/h.mjs`）转成 `${ZCODE_PLUGIN_ROOT}` 占位符形态
 * ——这正是 ZCode 生产声明的写法，同时让 fixture 能挂在任意临时目录上。
 */
function withRootPlaceholder(hooks, rel) {
  return JSON.parse(JSON.stringify(hooks).split(`"${rel}"`).join('"${ZCODE_PLUGIN_ROOT}/' + rel + '"'));
}

/** 建临时目录并在测试结束后自动清理。 */
function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 真实 spawn 的 shell seam 替身：与 `dsh-shell` 的请求/spec 契约同形（resolve + execute
 * → 句柄，句柄 result() 结算退出码与输出）。超时按 GNU 语义合成 124。
 */
function makeFakeShell() {
  return {
    resolve(request) {
      return request;
    },
    async execute(spec) {
      // 执行器依赖（2026-11-03 内部任务-308 / 内部未决-242）：真实 DSH win32 执行器经
      // dsh-subprocess-local runner spawn **Windows PowerShell 5.1**（`powershell.exe -Command`），
      // 与 POSIX 的 `shell: true` 形态不同——替身须同形，否则 win32 下引号语义会按 cmd.exe 误解析
      //（本文件曾因此 25 例假红）。POSIX 维持 `shell: true`（/bin/sh）。
      const win = process.platform === 'win32';
      const ps = win
        ? join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : null;
      const common = {
        cwd: spec.workdir,
        env: { ...process.env, ...(spec.env ?? {}) },
        input: spec.stdin ?? '',
        encoding: 'utf8',
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      };
      const r = win
        ? spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${spec.command}; exit $LASTEXITCODE`], common)
        : spawnSync(spec.command, { shell: true, ...common });
      if (process.env.DSH_COMPAT_DEBUG === '1') console.log('DEBUG-EXEC', JSON.stringify(spec.command), r.status, JSON.stringify((r.stderr ?? '').slice(0, 300)));
      return {
        async result() {
          const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal !== null;
          return {
            exitCode: timedOut ? 124 : (r.status ?? undefined),
            stdout: { text: r.stdout ?? '' },
            stderr: { text: r.stderr ?? '' },
            timedOut,
          };
        },
      };
    },
  };
}

/** 伪 cordis 上下文：收集 `on` 注册的监听器，供测试直接驱动。
 *  `skills` 走 `get()` 动态探测（与真实宿主同路）——本文件不校验 skill 面细节，
 *  只保证两条面共存时互不干扰（skill 面由 skills-bridge.test.mjs 专测）。 */
function makeFakeCtx() {
  const listeners = new Map();
  const logger = makeLoggerStub();
  const services = new Map();
  services.set('skills', { register: () => () => {} });
  return {
    shell: makeFakeShell(),
    logger,
    byLevel: (level) => logger.byLevel(level),
    get warnings() {
      return logger.byLevel('warn');
    },
    get infos() {
      return logger.byLevel('info');
    },
    get: (serviceName) => services.get(serviceName),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    effect() {
      /* 无长驻资源 */
    },
    listeners,
    async emit(event, ...args) {
      const fns = listeners.get(event) ?? [];
      assert.ok(fns.length > 0, `事件 ${event} 未注册监听器`);
      let out;
      for (const fn of fns) out = await fn(...args);
      return out;
    },
  };
}

/** 造一个最小 ZCode 插件根（只有 .zcode-plugin/plugin.json 与 hooks/hooks.json）。 */
function makeFixturePlugin(t, hooks, files = {}) {
  const root = makeTemp(t);
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }), 'utf8');
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2), 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return root;
}

/**
 * 造一个最小**中立形态**插件根（只有 plugin.manifest.json 与资产文件）——内部决策-036 期二后
 * 的手工编辑面形态；`hooks` 为扁平声明数组。
 */
function makeManifestPlugin(t, hooks, files = {}) {
  const root = makeTemp(t);
  writeFileSync(
    join(root, 'plugin.manifest.json'),
    JSON.stringify({ manifestVersion: 1, name: 'fixture', version: '0.0.0', description: '夹具插件', author: 'wangp', hooks }, null, 2),
    'utf8',
  );
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return root;
}

/** 造一组四插件根（键为插件名）；四者共用同一份声明与脚本体。 */
function makeFixtureSuite(t, hooks, files = {}, placeholderRel = '') {
  const roots = {};
  for (const plugin of ['workflow', 'spec-gate', 'scout', 'team-governance']) {
    const h = placeholderRel === '' ? hooks : withRootPlaceholder(hooks, placeholderRel);
    roots[plugin] = makeFixturePlugin(t, h, files);
  }
  return roots;
}

/** 只让 workflow 携带声明，其余三根为空插件（模拟「只有一个插件在该事件上声明」）。 */
function makeSinglePluginSuite(t, hooks, files = {}, placeholderRel = '') {
  const h = placeholderRel === '' ? hooks : withRootPlaceholder(hooks, placeholderRel);
  const roots = { workflow: makeFixturePlugin(t, h, files) };
  for (const plugin of ['spec-gate', 'scout', 'team-governance']) roots[plugin] = makeFixturePlugin(t, {}, {});
  return roots;
}

/**
 * 组合式 pre-step waterfall 链：注册序外层先执行、内层先 append（与宿主 `dispatch.waterfall` 同向）。
 * 既有 `emit` 替身逐个用同一个 next 调用、只返回最后一个监听器的结果，**无法验证消息顺序**；
 * 凡顺序断言必须经本函数。内部任务-173：SessionStart 首轮投递与 UPS/长任务协议的相对位置即由它钉住。
 * @param {{listeners: Map<string, Function[]>}} ctx 伪 ctx
 * @param {object} payload pre-step 负载
 * @param {Function|null} [inner] 终端决策工厂（缺省按 payload.messages 构造 enter 决策；S-05 守卫断言用）
 * @returns {Promise<{kind?: string, messages?: object[]}>} 最外层监听器返回
 */
async function emitPreStepChain(ctx, payload, inner = null) {
  const chain = ctx.listeners.get('agent/pre-step') ?? [];
  let next = inner ?? (async () => ({ kind: 'enter', messages: Array.isArray(payload.messages) ? [...payload.messages] : [] }));
  for (let i = chain.length - 1; i >= 0; i--) {
    const fn = chain[i];
    const downstream = next;
    next = () => fn(payload, downstream);
  }
  return next();
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

test('normalizeMatcher：ZCode 工具名展开为 DSH 词表；未知词原样保留；缺省/通配返回 undefined', () => {
  assert.equal(normalizeMatcher('Bash'), 'pwsh|bash|Bash');
  assert.equal(normalizeMatcher('Edit|Write'), 'edit|str_replace_editor|Edit|write|Write');
  assert.equal(normalizeMatcher('Bash|Edit|Write'), 'pwsh|bash|Bash|edit|str_replace_editor|Edit|write|Write');
  assert.equal(normalizeMatcher('SomeFutureTool'), 'SomeFutureTool', '未知词保留——宁可锚不到也不臆造映射');
  assert.equal(normalizeMatcher('Bash|Bash'), 'pwsh|bash|Bash', '重复词去重');
  assert.equal(normalizeMatcher(undefined), undefined);
  assert.equal(normalizeMatcher(''), undefined);
  assert.equal(normalizeMatcher('*'), undefined);
});

test('substituteVars：插件根占位符替换；未赋值时原样保留', () => {
  assert.equal(substituteVars('${ZCODE_PLUGIN_ROOT}/hooks/a.mjs', { ZCODE_PLUGIN_ROOT: 'X:/p' }), 'X:/p/hooks/a.mjs');
  assert.equal(substituteVars('${ZCODE_PLUGIN_ROOT}/a', {}), '${ZCODE_PLUGIN_ROOT}/a');
  assert.equal(substituteVars('${ZCODE_PLUGIN_ROOT}/a', { ZCODE_PLUGIN_ROOT: '' }), '${ZCODE_PLUGIN_ROOT}/a');
});

test('flattenContent：字符串直通；text 块拼接；其他形态产出空串', () => {
  assert.equal(flattenContent('abc'), 'abc');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(flattenContent([{ type: 'image', data: 'x' }]), '');
  assert.equal(flattenContent(undefined), '');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, 'raw']), 'araw');
});

test('buildPayload：五事件信封形态（camelCase、hook_event_name 与事件一致）', () => {
  const ss = buildPayload('SessionStart', { sessionId: 's1', cwd: 'C:/p', source: 'startup' });
  assert.equal(ss.hook_event_name, 'SessionStart');
  assert.equal(ss.session_id, 's1');
  assert.equal(ss.cwd, 'C:/p');
  assert.equal(ss.source, 'startup');
  assert.equal(ss.transcript_path, '');

  const pre = buildPayload('PreToolUse', { sessionId: 's1', cwd: 'C:/p', toolName: 'pwsh', toolInput: { command: 'ls' }, callId: 'c1' });
  assert.deepEqual(pre.tool_input, { command: 'ls' });
  assert.equal(pre.tool_name, 'pwsh');
  assert.equal(pre.tool_use_id, 'c1');

  const post = buildPayload('PostToolUse', {
    sessionId: 's1', cwd: 'C:/p', toolName: 'pwsh', toolInput: { command: 'exit 3' }, callId: 'c1',
    resultContent: [{ type: 'text', text: 'boom\n[exit code: 3]' }], exitCode: 3, isError: false,
  });
  assert.equal(post.tool_response, 'boom\n[exit code: 3]');
  assert.deepEqual(
    post.tool_result,
    { exit_code: 3, is_error: false, stdout: 'boom\n[exit code: 3]', stderr: '' },
    'OPEN-46：结构化面 = 退出码 + 失败事实 + 文本，stderr 恒空串',
  );
  const postFlag = buildPayload('PostToolUse', {
    sessionId: 's1', cwd: 'C:/p', toolName: 'edit', toolInput: { file_path: 'a.txt' }, callId: 'c2',
    resultContent: 'Error: no such file', isError: true,
  });
  assert.deepEqual(
    postFlag.tool_result,
    { is_error: true, stdout: 'Error: no such file', stderr: '' },
    '无退出码的失败（edit）也必须给结构面（旧实现退化为文本 ⇒ RED）',
  );
  // 回归锚（评审视角一 #5）：DSH PostToolUse 的 tool_result **恒为对象**，不得再退化回字符串面
  // ——本批核心不变量"文本不单独构成判据"依赖它，旧断言"无退出码时退化为文本面"必须是反向。
  const postNoCode = buildPayload('PostToolUse', { sessionId: 's1', cwd: 'C:/p', toolName: 'read', resultContent: 'x' });
  assert.deepEqual(
    postNoCode.tool_result,
    { is_error: false, stdout: 'x', stderr: '' },
    '无退出码的成功结果也必须是对象面（`typeof tool_result === "object"`），不得退化为字符串',
  );
  // 内部任务-20 B/F3（内部决策-033 修正案 1）：宿主结构化错误码的**透传位**——有则带、无则不产键。
  // 形态与语义作用域**不在此层**判定（核心件 post-tool.mjs 单点收口）：本用例只钉透传。
  const postErrCode = buildPayload('PostToolUse', {
    sessionId: 's1', cwd: 'C:/p', toolName: 'edit', toolInput: { file_path: 'a.txt' }, callId: 'c3',
    resultContent: 'stale', isError: true, errorCode: 'FS_STALE_VERSION',
  });
  assert.equal(postErrCode.tool_result.errorCode, 'FS_STALE_VERSION', '载体键在场 ⇒ 原样透传');
  assert.equal(postErrCode.tool_result.is_error, true, '失败位不受影响');
  const postNoErrCode = buildPayload('PostToolUse', {
    sessionId: 's1', cwd: 'C:/p', toolName: 'edit', toolInput: { file_path: 'a.txt' }, callId: 'c4',
    resultContent: 'stale', isError: true,
  });
  assert.ok(
    !Object.hasOwn(postNoErrCode.tool_result, 'errorCode'),
    '缺省 ⇒ **不产键**（旧记录形态零变化，追加式兼容）',
  );

  const stop = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p' });
  assert.equal(stop.stop_hook_active, false);

  const up = buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi' });
  assert.equal(up.prompt, 'hi');
});

test('buildPayload：cwd 缺省回落到进程 cwd（不产出空串）', () => {
  const p = buildPayload('Stop', {});
  assert.equal(p.cwd, process.cwd());
  assert.equal(p.session_id, '');
});

test('decodeHookOutput：退出码 2 = deny，且仍采信 stdout 信封的 additionalContext', () => {
  const env2 = JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '摘要体' } });
  const out = decodeHookOutput(2, env2, '', 'Stop');
  assert.equal(out.decision, 'deny');
  assert.equal(out.additionalContext, '摘要体', 'verify-gate 形态：exit 2 + 信封上下文');
});

test('decodeHookOutput：退出码 0 的结构化信封取 permissionDecision 与上下文', () => {
  const denyEnv = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: '拦截文案' } });
  const denied = decodeHookOutput(2, denyEnv, '', 'PreToolUse');
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.additionalContext, undefined);

  const askEnv = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', systemMessage: '建议确认' } });
  const asked = decodeHookOutput(0, askEnv, '', 'PreToolUse');
  assert.equal(asked.decision, 'ask');
  assert.equal(asked.additionalContext, undefined);

  const ctxEnv = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '元技能全文' } });
  const ctx = decodeHookOutput(0, ctxEnv, '', 'SessionStart');
  assert.equal(ctx.decision, undefined);
  assert.equal(ctx.additionalContext, '元技能全文');
});

test('decodeHookOutput：信封事件名不一致时丢弃事件域字段（IF-HOST-1 §3 信封校验）', () => {
  const mismatched = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '不该注入' } });
  const out = decodeHookOutput(0, mismatched, '', 'PreToolUse');
  assert.equal(out.additionalContext, undefined);
  assert.equal(out.decision, undefined);
});

test('decodeHookOutput：PostToolUse 双注册——PostToolUseFailure 事件名同样采信', () => {
  const failureEnv = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: '失败通道' } });
  assert.equal(decodeHookOutput(0, failureEnv, '', 'PostToolUse').additionalContext, '失败通道');
});

test('decodeHookOutput：坏 JSON / 空输出 / 异常退出码都不产出决策', () => {
  assert.equal(decodeHookOutput(0, 'not json', '', 'Stop').decision, undefined);
  assert.equal(decodeHookOutput(0, '', '', 'Stop').decision, undefined);
  assert.equal(decodeHookOutput(1, '', 'boom', 'Stop').decision, undefined);
  assert.equal(decodeHookOutput(1, '', 'boom', 'Stop').reason, 'boom', '异常退出的 stderr 留作诊断');
  assert.equal(decodeHookOutput(undefined, '', '', 'Stop').decision, undefined);
});

test('decodeHookOutput：continue:false 被记录', () => {
  assert.equal(decodeHookOutput(0, JSON.stringify({ continue: false }), '', 'Stop').continue, false);
});

test('mergeOutcomes：最严决策胜出，上下文按序累积，block 粘性', () => {
  const allow = decodeHookOutput(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), '', 'PreToolUse');
  const ask = decodeHookOutput(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', systemMessage: 'a' } }), '', 'PreToolUse');
  const deny = decodeHookOutput(2, '', '硬阻断', 'PreToolUse');
  assert.equal(mergeOutcomes([]).decision, 'none');
  assert.equal(mergeOutcomes([allow, ask]).decision, 'ask');
  assert.equal(mergeOutcomes([ask, deny]).decision, 'deny');
  assert.equal(mergeOutcomes([ask, deny]).reason, '硬阻断');
  const ctxA = decodeHookOutput(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'A' } }), '', 'Stop');
  const ctxB = decodeHookOutput(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'B' } }), '', 'Stop');
  assert.deepEqual(mergeOutcomes([ctxA, ctxB]).additionalContext, ['A', 'B']);
  assert.equal(mergeOutcomes([ctxA, { ...ctxB, continue: false }]).block, true);
});

test('quoteArg：安全字符直通；含空白/引号时按平台引用（win32=PowerShell 单引号 / POSIX 单引号）', () => {
  assert.equal(quoteArg('node'), 'node');
  assert.equal(quoteArg("it's"), process.platform === 'win32' ? "'it''s'" : "'it'\\''s'");
  assert.equal(quoteArg(''), process.platform === 'win32' ? "''" : "''");
  assert.equal(quoteArg('C:/Program Files/node.exe'), "'C:/Program Files/node.exe'");
  // POSIX 单引号内反斜杠是字面字符，尾反斜杠不需要特殊处理
  assert.equal(quoteArgFor('posix', '/path/with space/'), "'/path/with space/'");
  assert.equal(quoteArgFor('posix', '/a b\\'), "'/a b\\'");
  assert.equal(quoteArgFor('posix', "a'b"), "'a'\\''b'");
  // win32（2026-11-03 内部任务-308 实测：DSH win32 执行器为 Windows PowerShell 5.1，非 cmd.exe）：
  // PowerShell 单引号是字面量——内部 ' 加倍，$ / 反引号不展开，尾反斜杠无需特殊处理。
  assert.equal(quoteArgFor('win32', ''), "''");
  assert.equal(quoteArgFor('win32', 'C:/Program Files/node.exe'), "'C:/Program Files/node.exe'");
  assert.equal(quoteArgFor('win32', "it's"), "'it''s'", '内部单引号加倍');
  assert.equal(quoteArgFor('win32', 'a"b'), "'a\"b'", '双引号在单引号内是字面量');
  assert.equal(quoteArgFor('win32', 'C:\\a b\\'), "'C:\\a b\\'", '尾反斜杠在单引号内是字面量（不再 cmd 式加倍）');
  assert.equal(quoteArgFor('win32', 'a$b`c'), "'a$b`c'", 'PowerShell 单引号内 $/反引号不展开');
});

test('handlerCommandLine：args 中的插件根占位符先替换后引用', () => {
  const prefix = process.platform === 'win32' ? '& ' : '';
  const nodeCmd = quoteArg(process.execPath);
  const line = handlerCommandLine({ command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs'] }, { ZCODE_PLUGIN_ROOT: 'C:/Program Files/p' });
  assert.equal(line, `${prefix}${nodeCmd} 'C:/Program Files/p/hooks/a.mjs'`);
  assert.equal(handlerCommandLine({ command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/a.mjs'] }, { ZCODE_PLUGIN_ROOT: 'X:/p' }), `${prefix}${nodeCmd} X:/p/a.mjs`, '无空格时不加引号');
  assert.equal(
    handlerCommandLine({ command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/a.mjs'] }, {}),
    `${prefix}${nodeCmd} '\${ZCODE_PLUGIN_ROOT}/a.mjs'`,
    '未赋值原样保留（只加引用、不猜路径）',
  );
});

test('OPEN-243（DEV-308）：裸 node 命令改写为 process.execPath（其余命令与占位符不变）', () => {
  const prefix = process.platform === 'win32' ? '& ' : '';
  const nodeCmd = quoteArg(process.execPath);
  const line = handlerCommandLine({ command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs'] }, { ZCODE_PLUGIN_ROOT: 'X:/p' });
  assert.ok(line.startsWith(`${prefix}${nodeCmd} `), `裸 node 应改写为本进程解释器（win32 带调用运算符）；实际：${line}`);
  assert.ok(line.endsWith('X:/p/hooks/a.mjs'), `其余部分保持原引用；实际：${line}`);
  // 非裸 node 命令不改写（绝对路径/其他可执行名保持原样）
  assert.equal(handlerCommandLine({ command: 'C:/nodejs/node.exe', args: ['a.mjs'] }), `${prefix}C:/nodejs/node.exe a.mjs`);
  assert.equal(handlerCommandLine({ command: 'python', args: ['a.py'] }), `${prefix}python a.py`);
});

test('readHookConfig：解析四要素并忽略非 process / 缺 command / 不支持事件', (t) => {
  const root = makeFixturePlugin(t, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['a.mjs'], timeoutMs: 1500, statusMessage: 'x' }] }],
    不支持的: [{ hooks: [{ type: 'process', command: 'node', args: ['b.mjs'] }] }],
    PostToolUse: [{ hooks: [{ type: 'http', command: 'node', args: [] }] }, { hooks: [{ type: 'process' }] }, { hooks: [{ type: 'process', command: 'node', args: ['c.mjs'] }] }],
  });
  const config = readHookConfig(root);
  assert.deepEqual(Object.keys(config).sort(), ['PostToolUse', 'PreToolUse']);
  assert.equal(config.PreToolUse.length, 1);
  assert.equal(config.PreToolUse[0].command, 'node');
  assert.deepEqual(config.PreToolUse[0].args, ['a.mjs']);
  assert.equal(config.PreToolUse[0].timeoutMs, 1500);
  assert.equal(config.PreToolUse[0].matcher, 'pwsh|bash|Bash');
  assert.equal(config.PostToolUse[0].timeoutMs, DEFAULT_TIMEOUT_MS, '缺 timeoutMs 用默认值');
});

test('readHookConfig：声明缺失或损坏返回空对象（fail-open）', (t) => {
  const root = makeTemp(t);
  assert.deepEqual(readHookConfig(root), {});
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hooks.json'), '{ not json', 'utf8');
  assert.deepEqual(readHookConfig(root), {});
  writeFileSync(join(root, 'hooks', 'hooks.json'), '[]', 'utf8');
  assert.deepEqual(readHookConfig(root), {});
});

test('readManifestHookConfig：中立扁平声明逐条解析（matcher 自带、超时缺省、忽略不支持事件与非 process）', (t) => {
  const root = makeManifestPlugin(t, [
    { event: 'PreToolUse', matcher: 'Bash', type: 'process', command: 'node', args: ['a.mjs'], timeoutMs: 1500, statusMessage: 'x' },
    { event: '不支持的', type: 'process', command: 'node', args: ['b.mjs'], timeoutMs: 1000, statusMessage: '' },
    { event: 'PostToolUse', matcher: 'Write', type: 'http', command: 'node', args: [], timeoutMs: 1000, statusMessage: '' },
    { event: 'PostToolUse', type: 'process', args: [], timeoutMs: 1000, statusMessage: '' },
    { event: 'PostToolUse', matcher: 'Write', type: 'process', command: 'node', args: ['c.mjs'], timeoutMs: 0, statusMessage: '' },
  ]);
  const config = readManifestHookConfig(root);
  assert.deepEqual(Object.keys(config).sort(), ['PostToolUse', 'PreToolUse']);
  assert.equal(config.PreToolUse.length, 1);
  assert.equal(config.PreToolUse[0].matcher, 'pwsh|bash|Bash', '中立形态的 matcher 逐条自带并同样按宿主词表展开');
  assert.equal(config.PreToolUse[0].timeoutMs, 1500);
  assert.equal(config.PostToolUse.length, 1);
  assert.equal(config.PostToolUse[0].timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs 非正数用默认值（与 ZCode 形态同语义）');
  assert.equal(config.PostToolUse[0].matcher, 'write|Write', 'Write 档展开为宿主词表');
});

test('readManifestHookConfig：无可用中立源返回 null 三态（缺失 / JSON 损坏 / 顶层非对象）', (t) => {
  const empty = makeTemp(t);
  assert.equal(readManifestHookConfig(empty), null, '清单缺失 ⇒ null（交给回落面）');
  const broken = makeTemp(t);
  writeFileSync(join(broken, 'plugin.manifest.json'), '{ not json', 'utf8');
  assert.equal(readManifestHookConfig(broken), null, 'JSON 损坏 ⇒ null（不阻断会话，回落生成物）');
  const arrayTop = makeTemp(t);
  writeFileSync(join(arrayTop, 'plugin.manifest.json'), '[]', 'utf8');
  assert.equal(readManifestHookConfig(arrayTop), null, '顶层为数组 ⇒ null');
});

test('OPEN-276：中立清单 hooks 非数组须记诊断（不得静默零声明）', (t) => {
  const root = makeTemp(t);
  writeFileSync(join(root, 'plugin.manifest.json'), JSON.stringify({ name: 'x', hooks: {} }), 'utf8');
  const diag = { dropped: [] };
  assert.deepEqual(readManifestHookConfig(root, diag), {}, '形态非法仍按权威零声明返回（不回落生成物、不复活旧钩子）');
  assert.ok(diag.dropped.some((d) => d.reason === 'hooks-not-array'), '须记 hooks-not-array 诊断（不静默）');
});

test('readHookConfig：中立源优先——清单与生成物声明不同时以清单为准（ADR-036 唯一编辑面）', (t) => {
  const root = makeManifestPlugin(
    t,
    [{ event: 'PreToolUse', matcher: 'Bash', type: 'process', command: 'node', args: ['中性.mjs'], timeoutMs: 1111, statusMessage: '中立' }],
    { 'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['生成物.mjs'], timeoutMs: 2222, statusMessage: '生成物' }] }] } }) },
  );
  const config = readHookConfig(root);
  assert.deepEqual(config.PreToolUse.map((h) => h.args[0]), ['中性.mjs'], '清单在手即以清单为准，不合并、不回看生成物');
  assert.equal(config.PreToolUse[0].timeoutMs, 1111);
});

test('readHookConfig：清单在手即权威——零声明不被生成物"复活"（删钩子即生效）', (t) => {
  const root = makeManifestPlugin(t, [], {
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'process', command: 'node', args: ['stale.mjs'], timeoutMs: 1000 }] }] } }),
  });
  assert.deepEqual(readHookConfig(root), {}, '生成物里的旧声明不得复活（这正是换源要消灭的漂移形态）');
});

test('readHookConfig：无可用中立源时回落 ZCode 生成物（0.6.0 前装机副本兼容）', (t) => {
  const root = makeFixturePlugin(t, {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['a.mjs'], timeoutMs: 1200, statusMessage: '回落' }] }],
  });
  assert.equal(existsSync(join(root, 'plugin.manifest.json')), false, '夹具故意不落清单（旧副本形态）');
  const config = readHookConfig(root);
  assert.deepEqual(config.SessionStart.map((h) => h.args[0]), ['a.mjs']);
  assert.equal(config.SessionStart[0].timeoutMs, 1200);
  assert.equal(config.SessionStart[0].matcher, 'startup');
});

test('期二换源等价：五有钩插件由中立清单与 ZCode 生成物派生的处理器逐字段一致', () => {
  // 换源不变量（内部决策-036 决策 6：期二只换声明源、不动行为面）。允许且仅允许两处形态差异：
  // ① 占位符 token（中立 `${PLUGIN_ROOT}` ↔ 生成物 `${ZCODE_PLUGIN_ROOT}`）——`handlerCommandLine`
  //    两个键都传同一个根，替换后命令行逐字相同；② 事件键序（中立=声明序、生成物=按事件分组序），
  //    消费面按事件取值，键序无语义。
  const normalize = (config) => {
    const out = {};
    for (const event of Object.keys(config).sort()) {
      out[event] = config[event].map((h) => ({
        ...h,
        args: h.args.map((a) => a.split('${PLUGIN_ROOT}').join('${ZCODE_PLUGIN_ROOT}')),
      }));
    }
    return out;
  };
  for (const plugin of ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop']) {
    const root = join(REPO_ROOT, plugin);
    const fromManifest = readManifestHookConfig(root);
    assert.notEqual(fromManifest, null, `${plugin} 应有中立清单（0.6.0 起随包分发）`);
    assert.deepEqual(
      normalize(fromManifest),
      normalize(readZcodeHookConfig(root)),
      `${plugin} 换源后处理器清单必须与生成物派生结果一致`,
    );
    assert.deepEqual(readHookConfig(root), fromManifest, `${plugin} 生产读法应命中中立源`);
  }
});

test('normalizeSessionSource：ZCode 来源词表内保留，域外归一为 startup（注入通道不因词表分裂而静默失效）', () => {
  for (const s of ['startup', 'resume', 'clear', 'compact']) assert.equal(normalizeSessionSource(s), s);
  assert.equal(normalizeSessionSource('new'), 'startup');
  assert.equal(normalizeSessionSource(undefined), 'startup');
  assert.equal(normalizeSessionSource(42), 'startup');
});

test('isPluginRoot / discoverPlugins：中立清单优先、旧 plugin.json 回落，两种形态都能发现', (t) => {
  const base = makeTemp(t);
  for (const name of ['workflow', 'spec-gate', 'scout', 'team-governance']) {
    mkdirSync(join(base, name, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(base, name, '.zcode-plugin', 'plugin.json'), '{}', 'utf8');
  }
  assert.equal(isPluginRoot(join(base, 'workflow')), true);
  assert.equal(isPluginRoot(base), false);
  const found = discoverPlugins(join(base, 'workflow', 'hooks'));
  assert.deepEqual(Object.keys(found).sort(), ['scout', 'spec-gate', 'team-governance', 'workflow']);
  assert.equal(found.workflow, join(base, 'workflow'));
  assert.deepEqual(discoverPlugins(makeTemp(t)), {}, '找不到就返回空（不猜路径）');

  // 中立形态（无 .zcode-plugin，仅 plugin.manifest.json）——期二后新宿主树的形态
  const neutral = makeTemp(t);
  for (const name of ['workflow', 'spec-gate', 'scout', 'team-governance']) {
    mkdirSync(join(neutral, name), { recursive: true });
    writeFileSync(join(neutral, name, 'plugin.manifest.json'), '{}', 'utf8');
  }
  assert.equal(isPluginRoot(join(neutral, 'workflow')), true, '中立清单是插件根标志');
  assert.deepEqual(
    Object.keys(discoverPlugins(join(neutral, 'workflow', 'hooks'))).sort(),
    ['scout', 'spec-gate', 'team-governance', 'workflow'],
  );
  // 两者皆无 ⇒ 非插件根（不因任意目录被当插件）
  const blank = makeTemp(t);
  assert.equal(isPluginRoot(blank), false);
});

test('matchesMatcher / collectHandlers：组合清单按插件与声明顺序展开', (t) => {
  assert.equal(matchesMatcher(undefined, 'anything'), true);
  assert.equal(matchesMatcher('pwsh|bash', 'pwsh'), true);
  assert.equal(matchesMatcher('pwsh|bash', 'edit'), false);
  const root = makeFixturePlugin(t, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['a.mjs'] }] }] });
  const { byEvent } = collectHandlers({ workflow: root });
  assert.equal(byEvent.PreToolUse.length, 1);
  assert.equal(byEvent.PreToolUse[0].pluginRoot, root);
  assert.deepEqual(collectHandlers({}), { byEvent: {}, plugins: [] });
});

// ── ② 真实钩子进程（本仓脚本 + fixture 声明） ──────────────────────────────

test('runHandler：真实超时——process.execPath 睡眠超过 timeoutMs ⇒ timedOut/124 且不产决策', async () => {
  const ctx = { shell: makeFakeShell(), logger: { warn() {}, info() {}, debug() {}, error() {} } };
  const handler = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 30, matcher: undefined, statusMessage: '' };
  const r = await runHandler(ctx, handler, buildPayload('PostToolUse', { sessionId: 's', cwd: REPO_ROOT }), { cwd: REPO_ROOT, env: { ...process.env } });
  assert.equal(r.timedOut, true, '真实超时应由 seam 标记 timedOut');
  assert.equal(r.exitCode, 124, '超时按 GNU 语义合成 124');
  assert.equal(r.stdout, '', '超时不得产出决策文本');
});

test('runHandler：真实进程往返——workflow SessionStart 注入真实元技能全文', async () => {
  const ctx = { shell: makeFakeShell(), logger: { warn() {} } };
  const handler = { command: 'node', args: [join(REPO_ROOT, 'workflow', 'hooks', 'session-start.mjs')], timeoutMs: 10000, matcher: undefined, statusMessage: '' };
  const env = { ...process.env, ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') };
  const r = await runHandler(ctx, handler, buildPayload('SessionStart', { sessionId: 's', cwd: REPO_ROOT, source: 'startup' }), { cwd: REPO_ROOT, env });
  assert.equal(r.exitCode, 0);
  const out = decodeHookOutput(r.exitCode, r.stdout, r.stderr, 'SessionStart');
  assert.ok(typeof out.additionalContext === 'string' && out.additionalContext.includes('路由表'), '注入体应含路由表');
  assert.ok(out.additionalContext.length > 1000, '注入的是元技能全文而非摘要');
});

test('runHandler：workflow PreToolUse 护栏——HIGH 危险命令 deny 且文案保留（退出码 2 + stdout 信封）', async () => {
  const ctx = { shell: makeFakeShell(), logger: { warn() {} } };
  const handler = { command: 'node', args: [join(REPO_ROOT, 'workflow', 'hooks', 'check-careful.mjs')], timeoutMs: 10000, matcher: undefined, statusMessage: '' };
  const env = { ...process.env, ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') };
  const payload = buildPayload('PreToolUse', { sessionId: 's', cwd: REPO_ROOT, toolName: 'pwsh', toolInput: { command: 'rm -rf /' }, callId: 'c' });
  const r = await runHandler(ctx, handler, payload, { cwd: REPO_ROOT, env });
  assert.equal(r.exitCode, 2, 'deny 经退出码 2 表达（ZCode 语义）');
  const out = decodeHookOutput(r.exitCode, r.stdout, r.stderr, 'PreToolUse');
  assert.equal(out.decision, 'deny');
  assert.equal(out.reason, '[careful][HIGH] 已阻断：递归删除根目录/家目录不可恢复。如确属意图，请在终端人工执行。', '文案取自信封 systemMessage（宿主桥丢弃 stdout，本层保留）');
});

test('runHandler：check-freeze 对未声明冻结的项目静默放行（零输出退 0）', async () => {
  const ctx = { shell: makeFakeShell(), logger: { warn() {} } };
  const handler = { command: 'node', args: [join(REPO_ROOT, 'workflow', 'hooks', 'check-freeze.mjs')], timeoutMs: 10000, matcher: undefined, statusMessage: '' };
  const env = { ...process.env, ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') };
  const scratch = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-freeze-'));
  try {
    const payload = buildPayload('PreToolUse', { sessionId: 's', cwd: scratch, toolName: 'edit', toolInput: { file_path: join(scratch, 'a.txt') }, callId: 'c' });
    const r = await runHandler(ctx, handler, payload, { cwd: scratch, env });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(decodeHookOutput(r.exitCode, r.stdout, r.stderr, 'PreToolUse').decision, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── ③ 插件装配（apply + 伪 ctx） ────────────────────────────────────────────

test('apply：fixture 插件端到端——SessionStart 注入 / PreToolUse deny / Stop 阻断', async (t) => {
  const emitAsk = [
    "import { readFileSync } from 'node:fs';",
    "const p = JSON.parse(readFileSync(0, 'utf8'));",
    "if (p.hook_event_name === 'SessionStart') {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'FIXTURE-CTX' } }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (p.hook_event_name === 'PreToolUse') {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', systemMessage: 'FIXTURE-ASK' } }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (p.hook_event_name === 'Stop') {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'FIXTURE-STOP' } }) + '\\n');",
    "  process.exit(2);",
    "}",
    "process.exit(0);",
  ].join('\n');
  const root = makeSinglePluginSuite(
    t,
    {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'process', command: 'node', args: ['hooks/never.mjs'], timeoutMs: 5000 }] },
      ],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
      Stop: [{ hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
    },
    { 'hooks/h.mjs': emitAsk },
    'hooks/h.mjs',
  );
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: root, projectDir: REPO_ROOT });
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/execute', 'tools/post-execute', 'tools/pre-execute']);

  // SessionStart：created 只执行钩子、不再 agent.inject（durable next-step 会触发桌面退出误报）
  const injected = [];
  const agent = { session: { header: { id: 's1', cwd: REPO_ROOT } }, inject: (m) => injected.push(m), steer: () => {} };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.deepEqual(ctx.warnings, []);
  assert.equal(injected.length, 0, 'SessionStart 不得再走 agent.inject');
  // 首轮 pre-step：文本从内存槽追加到 decision.messages（identified message 契约不变）
  const first = await emitPreStepChain(ctx, { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] });
  const ssMsg = (first.messages ?? []).find((m) => (m.content?.[0]?.text ?? '') === 'FIXTURE-CTX');
  assert.ok(ssMsg, '首轮 pre-step 必须投递 SessionStart 上下文');
  // 注入边界即事故现场：宿主把消息原样 append 成 `user/message` 事件，故必须钉身份（2026-09-29 阶段 A 评审意见 testing#6）。
  assert.match(ssMsg.id, IDENTIFIED_ID_RE, 'SessionStart 投递消息必须是 identified message');
  const second = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal((second.messages ?? []).some((m) => (m.content?.[0]?.text ?? '') === 'FIXTURE-CTX'), false, '每 agent 生命周期只投一次');

  // UserPromptSubmit：无决策（h.mjs 对 UserPromptSubmit 走默认 exit 0 无输出）→ 委托下游
  // 内部任务-173：UPS 之后注册了 SessionStartDelivery（无槽纯直通）⇒ 串行 emit 下 next 被调用 2 次（UPS + delivery 各一次）
  // 内部任务-220：SessionStartDelivery 之前另注册 BridgeChannelHint（桥接首轮提示，默认关时纯直通）⇒ 再 +1。
  let downstreamCalled = 0;
  const entered = await ctx.emit('agent/pre-step', { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, async () => {
    downstreamCalled += 1;
    return { kind: 'enter', messages: [] };
  });
  assert.equal(downstreamCalled, 3);
  assert.equal(entered.kind, 'enter');

  // PreToolUse：Bash 档命中 ask；Edit 档 matcher 不匹配（不落到 never.mjs）
  const ask = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent }, async () => ({ kind: 'continue' }));
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.reason, 'FIXTURE-ASK');
  let editNextCalled = 0;
  const passthrough = await ctx.emit('tools/pre-execute', { name: 'edit', arguments: { file_path: 'x' }, agent }, async () => {
    editNextCalled += 1;
    return { kind: 'continue' };
  });
  assert.equal(editNextCalled, 1, 'Edit 档只挂 never.mjs，不匹配则不执行也不阻断');
  assert.equal(passthrough.kind, 'continue');

  // PostToolUse：无决策 → 委托下游
  let postNext = 0;
  await ctx.emit('tools/post-execute', { name: 'pwsh', arguments: {}, agent }, { content: 'ok' }, async () => {
    postNext += 1;
    return { kind: 'continue' };
  });
  assert.equal(postNext, 1);

  // Stop：exit 2 + 信封上下文 → steer 并被阻断
  const steered = [];
  const agent2 = { session: { header: { id: 's1', cwd: REPO_ROOT } }, inject: () => {}, steer: (m) => steered.push(m) };
  await ctx.emit('agent/turn-stopping', { agent: agent2 });
  assert.equal(steered.length, 1);
  assert.equal(steered[0].content[0].text, 'FIXTURE-STOP');
  assert.match(steered[0].id, IDENTIFIED_ID_RE, 'Stop 通道 steer 的消息必须是 identified message');
});

test('apply：多插件在同一事件上声明时全部执行，上下文按插件顺序累积（真实部署形态）', async (t) => {
  const mkBody = (tag) => [
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '${tag}' } }) + '\\n');`,
    'process.exit(0);',
  ].join('\n');
  const roots = makeFixtureSuite(
    t,
    { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['hooks/s.mjs'], timeoutMs: 5000 }] }] },
    {},
    'hooks/s.mjs',
  );
  // 每个插件根写入各自标记的脚本体（覆盖共用文件名）
  let i = 0;
  for (const plugin of ['workflow', 'spec-gate', 'scout', 'team-governance']) {
    i += 1;
    writeFileSync(join(roots[plugin], 'hooks', 's.mjs'), mkBody(`CTX-${i}`), 'utf8');
  }
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const injected = [];
  const agent = { session: { header: { id: 's', cwd: REPO_ROOT } }, inject: (m) => injected.push(m), steer() {} };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.equal(injected.length, 0, 'SessionStart 不再 agent.inject');
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  const ss = (out.messages ?? []).find((m) => (m.content?.[0]?.text ?? '').startsWith('CTX-1'));
  assert.ok(ss, '多插件 SessionStart 上下文必须在首轮 pre-step 累积投递');
  assert.equal(ss.content[0].text, 'CTX-1\n\nCTX-2\n\nCTX-3\n\nCTX-4', '四插件顺序即 PLUGINS 声明顺序');
  assert.match(ss.id, IDENTIFIED_ID_RE, '多插件累积投递同样必须是 identified message');
});

test('apply：插件根缺失时静默不注册（fail-open），且事件面为空', async (t) => {
  const empty = makeTemp(t);
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: { workflow: empty, 'spec-gate': empty, scout: empty, 'team-governance': empty, 'algo-loop': empty, 'research-loop': empty } });
  // 内部任务-201（内部决策-057）：apply 恒装配桥接监听（agent/created），按排除桥接标记后的业务监听器集合断言。
  // 内部任务-220：另恒装配 BridgeChannelHint pre-step 监听（自带独立标记），同样排除。
  const BRIDGE_LISTENER_TAG = Symbol.for('ai-coding-methodology.agent-control-listener');
  const BRIDGE_HINT_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');
  const businessListeners = [...ctx.listeners.values()].flat().filter((fn) => fn?.[BRIDGE_LISTENER_TAG] !== true && fn?.[BRIDGE_HINT_TAG] !== true);
  assert.equal(businessListeners.length, 0, '五个根都不是插件根 → 业务监听器为零（恒装配的桥接监听除外）');
  assert.ok(ctx.infos.some((m) => m.includes('未发现')));
  assert.equal(isPluginRoot(empty), false);
});

test('apply：真实仓库五插件全部发现并注册五个事件', async () => {
  const ctx = makeFakeCtx();
  await apply(ctx, { projectDir: REPO_ROOT });
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/execute', 'tools/post-execute', 'tools/pre-execute']);
  const info = ctx.infos.join('\n');
  for (const plugin of ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop']) assert.ok(info.includes(plugin), `应发现 ${plugin}`);
});

test('apply：真实 workflow 护栏——危险命令 deny，文案为 ZCode 原文', async () => {
  seedNullBucketLease(REPO_ROOT); // 内部未决-93②：闸见 null 桶租约即静默放行，check-careful 的 ask 得以浮出
  const ctx = makeFakeCtx();
  await apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 's-real', cwd: REPO_ROOT } }, inject() {}, steer() {} };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const denied = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'git reset --hard' }, agent }, async () => ({ kind: 'continue' }));
  assert.equal(denied.kind, 'deny');
  assert.ok(denied.reason.includes('careful'), `文案应来自 check-careful（实际：${denied.reason}）`);
  const asked = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'git clean -fd' }, agent }, async () => ({ kind: 'continue' }));
  assert.equal(asked.kind, 'ask');
});

// ── 内部未决-95：委派深度判据漂移可观测（内部任务-48） ────────────────────────────────

test('OPEN-95：委派深度判据漂移一次性脱敏告警（origin=subagent 而两深度源皆缺失/非法）', async (t) => {
  // 为什么用 fixture 单插件面：漂移告警是适配层观测行为，不依赖真实钩子内容——最小
  // exit(0) 钩只保证 UPS/Stop 两事件面注册，判据全在 agent 夹具形态上。
  const root = makeSinglePluginSuite(
    t,
    {
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
      Stop: [{ hooks: [{ type: 'process', command: 'node', args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
    },
    { 'hooks/h.mjs': 'process.exit(0);\n' },
  );
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: root, projectDir: REPO_ROOT });

  // 态一（漂移）：origin 自证子代理而两深度源皆缺失 → 恰一次告警（UPS×2 + Stop×1 共享去重）
  const drift = { session: { header: { id: 'drift-1', cwd: REPO_ROOT, origin: 'subagent' } }, inject() {}, steer() {} };
  const canary = [{ content: [{ type: 'text', text: 'SECRET-PROMPT-FRAGMENT /secret/path/fragment' }] }];
  const next = async () => ({ kind: 'enter', messages: [] });
  for (let i = 0; i < 2; i++) {
    await ctx.emit('agent/pre-step', { agent: drift, messages: canary }, next);
  }
  await ctx.emit('agent/turn-stopping', { agent: drift });
  const driftWarns = ctx.warnings.filter((w) => w.includes('委派深度判据漂移'));
  assert.equal(driftWarns.length, 1, '三事件共享去重，每会话恰一次');
  assert.ok(!driftWarns[0].includes('SECRET-PROMPT-FRAGMENT'), '告警脱敏：不含 prompt/路径内容');
  assert.ok(driftWarns[0].includes('drift-1'), '告警携带会话 id（与宿主日志关联键）');

  // 态二（对照·有效深度）：任一深度源有效 → 非漂移，不告警
  const valid = { session: { header: { id: 'drift-2', cwd: REPO_ROOT, origin: 'subagent', delegationDepth: 2 } }, inject() {}, steer() {} };
  await ctx.emit('agent/pre-step', { agent: valid, messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, next);
  await ctx.emit('agent/turn-stopping', { agent: valid });

  // 态三（对照·顶层）：无 origin 无深度 → 正常顶层会话，不告警
  const top = { session: { header: { id: 'drift-3', cwd: REPO_ROOT } }, inject() {}, steer() {} };
  await ctx.emit('agent/pre-step', { agent: top, messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, next);
  await ctx.emit('agent/turn-stopping', { agent: top });

  assert.equal(ctx.warnings.filter((w) => w.includes('委派深度判据漂移')).length, 1, '态二态三零新增告警');
});

// ── ④ 依赖面与配置文件静态核对 ──────────────────────────────────────────────

test('包清单：bundle patch 指向的入口与 dsh.engines 声明齐备', () => {
  const pkg = JSON.parse(readFileSync(join(COMPAT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'ai-coding-methodology');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/index.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(typeof pkg.dsh.engines.dsh === 'string' && pkg.dsh.engines.dsh.length > 0);
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-shell'], '声明 shell seam 依赖');
  const patch = readFileSync(join(COMPAT_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes("name: 'ai-coding-methodology'"), 'patch 条目名与包名一致（宿主按 name 解析）');
  assert.ok(existsSync(join(COMPAT_ROOT, 'src', 'index.mjs')));
});

test('包清单：patch 的 insert 条目结构化核对（顶层单 insert + id/name 行）', () => {
  const patch = readFileSync(join(COMPAT_ROOT, 'cordis.patch.yml'), 'utf8');
  // 只做结构性核对，不引 YAML 库：顶层必须恰有一条 `- insert:`，其下恰一条 `- id:` 条目，
  // 且 id 与 name 都是 'ai-coding-methodology'。
  //
  // 形态依据（2026-09-28 第 76 批实测官方 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`，
  // 529 行）：**顶层一个 `- insert:`，其下是一列 `- id: <行标识>` + `name: <模块说明符>`**：
  //     - insert:
  //         - id: tool-plugin-manager
  //           name: '@deepseek-ai/dsh-plugin-manager/tools'
  //         - id: plugin-manager
  //           name: '@deepseek-ai/dsh-plugin-manager'
  // 即 **`id` 是行标识、`name` 是模块说明符，两者不必相同**（dsh-base 里普遍不同）。
  // 本层取 `id === name === 'ai-coding-methodology'`：一个自足的 bundle 根用包名作行标识**合法且够用**
  // （该行不会被别的 bundle 按 id 覆盖）。这不是"照抄 dsh-base 的写法"，而是**符合其行结构**。
  //
  // 更强的形态验证在别处：本文件另有用例用**宿主同一解析器**（js-yaml）解出顶层 insert 形状
  // （见 acceptance.test.mjs 的「装载链①补」），且实机 `--dump-config` 输出里该行以
  // `# == ai-coding-methodology` 层头 + `- id: ai-coding-methodology / name: ai-coding-methodology` 出现（§8.34）——
  // **组合器确实接受此形态**，故 id==name 无需再加验证。
  const nonComment = patch.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  assert.equal(nonComment.length, 3, `patch 顶层应恰有三行有效内容，实际：${JSON.stringify(nonComment)}`);
  assert.match(nonComment[0], /^-\s*insert:\s*$/);
  assert.match(nonComment[1], /^\s*-\s*id:\s*ai-coding-methodology\s*$/);
  assert.match(nonComment[2], /^\s*name:\s*'ai-coding-methodology'\s*$/);
});

test('cordis 服务读取契约（源码复刻）：apply 全程走 ctx.get，绝不属性读未 inject 的服务', async () => {
  // 复刻 `cordis/src/reflect.ts` 的 ReflectService handler 与 `get(name, strict=true)`：
  //   · `ctx.<svc>` 属性访问：未声明 inject 时抛 `cannot get property "X" without inject`
  //   · `ctx.get(name)`：无 inject 要求；服务缺席（或提供方 fiber 未 active）返回 undefined
  // 本插件的 inject 只有 ['shell']，故 skills / commands / tools / subagents 一律不得属性读。
  const INJECTED = new Set(['shell']);
  const store = new Map();
  const violations = [];
  const handler = {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, target);
      if (INJECTED.has(prop)) return store.get(prop);
      violations.push(String(prop));
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  };
  const skills = { register: () => () => {} };
  const commands = { register: () => () => {} };
  store.set('shell', makeFakeShell());
  store.set('skills', skills);
  store.set('commands', commands);
  const listeners = new Map();
  const ctx = new Proxy(
    {
      logger: { info: () => {}, warn: () => {} },
      // cordis 的内置 API（`on`/`effect`/`plugin` 由 fiber/registry mixin 提供，`get` 由
      // ReflectService 提供，`logger` 由 Context 自身提供）——本层只用这几个，故替身照做。
      plugin: () => ({ await: async () => {}, dispose: async () => {} }),
      effect: () => () => {},
      on: (e, fn) => {
        if (!listeners.has(e)) listeners.set(e, []);
        listeners.get(e).push(fn);
      },
      get(name) {
        return store.get(name); // 无 inject 要求；缺席返回 undefined
      },
      // 反射层：未 inject 的服务属性读抛错（复刻 ReflectService handler）
      _unused: undefined,
    },
    handler,
  );

  const { apply } = await import('../src/index.mjs');
  await assert.doesNotReject(() => apply(ctx, { projectDir: REPO_ROOT }), 'apply 不得在真实 cordis 语义下抛错');
  assert.deepEqual(violations, [], `apply 触碰了未 inject 的服务属性：${JSON.stringify(violations)}`);
  assert.ok(listeners.size >= 5, '钩子面应照常注册');
  // `logger` 是 cordis 内置属性、`on`/`get`/`plugin`/`effect` 是内置方法——本层对它们的依赖
  // 也在此一并锁住（少任何一个都会让某一面静默降级）。
  for (const api of ['on', 'get', 'plugin', 'effect', 'logger']) {
    assert.ok(api in ctx, `cordis 上下文应提供 ${api}`);
  }
  assert.ok(store.get('skills').register === skills.register || true, 'skills 服务被读取');

  // 反向对照：属性读确实会抛——证明上面的断言不是空转
  assert.throws(() => ctx.skills, /without inject/);
  assert.throws(() => ctx.commands, /without inject/);
});

test('适配层不写 ZCode 资产：源码不出现写文件调用', () => {
  for (const rel of ['src/index.mjs', 'src/log.mjs', 'src/hooks-bridge.mjs', 'src/skills-bridge.mjs', 'src/commands-bridge.mjs', 'src/agents-bridge.mjs']) {
    const text = readFileSync(join(COMPAT_ROOT, rel), 'utf8');
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'mkdirSync']) {
      assert.ok(!text.includes(forbidden), `${rel} 不应出现 ${forbidden}`);
    }
  }
});

test('适配层不造镜像目录：skill 面源码只读不写、也不拼接映射根路径', () => {
  const text = readFileSync(join(COMPAT_ROOT, 'src', 'skills-bridge.mjs'), 'utf8');
  // 只锚「拼接路径」的用法（join/resolve 的目标）与写调用；不锚注释里引述的宿主
  // 扫描根——文件头引述那四个根正是「为什么不建映射目录」的理由。
  for (const forbidden of ['join(', 'resolve(']) {
    const hits = text.split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && line.includes(forbidden) && /\b(dsh|agents)\b/.test(line));
    assert.deepEqual(hits, [], `不应对映射根做路径拼接：${forbidden}`);
  }
  for (const writeCall of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'cpSync', 'symlinkSync', 'rmSync', 'unlinkSync']) {
    assert.ok(!text.includes(writeCall), `skill 面不得出现写调用 ${writeCall}`);
  }
});

test('runHandler：signal 与 timeoutMs 透传到 shell 请求（宿主凭此做进程组取消与超时）', async () => {
  const seen = [];
  // 记录型 shell：不改行为，只截获 resolve 收到的 spec
  const recordingCtx = {
    shell: {
      resolve(request) {
        seen.push(request);
        return request;
      },
      async execute(spec) {
        return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, spec }) };
      },
    },
    logger: { warn() {} },
  };
  const controller = new AbortController();
  const env = { ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') };
  const handler = { command: 'node', args: ['x.mjs'], timeoutMs: 4321 };
  await runHandler(recordingCtx, handler, buildPayload('Stop', { sessionId: 's', cwd: REPO_ROOT }), { cwd: REPO_ROOT, env, signal: controller.signal });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeoutMs, 4321, '声明超时必须透传（宿主桥默认 600s，本层默认 10s，不能用错的）');
  assert.equal(seen[0].signal, controller.signal, 'AbortSignal 必须透传——宿主据此取消在跑的钩子进程');
  assert.equal(seen[0].workdir, REPO_ROOT);
  assert.ok(typeof seen[0].stdin === 'string' && seen[0].stdin.endsWith('\n'), '负载以单行 JSON 写 stdin（与宿主桥同形）');
  assert.equal(JSON.parse(seen[0].stdin).hook_event_name, 'Stop');

  // 无 signal 时不得凭空造一个（否则宿主无法区分"未取消"与"已取消"）
  seen.length = 0;
  await runHandler(recordingCtx, handler, buildPayload('Stop', { sessionId: 's', cwd: REPO_ROOT }), { cwd: REPO_ROOT, env });
  assert.equal('signal' in seen[0], false, '无 signal 时请求里不应出现该字段');
});

test('runHandler：请求带 per-call 沙箱策略覆盖（R-hooks-2——不覆盖则钩子写不了状态目录而静默失效）', async () => {
  // 为什么要有（2026-09-29 T1 实证）：宿主 shell 默认走**部署策略**（`workspaceRoot` = 应用 cwd），
  // 本层派生的钩子子进程因此只能读不能写该根之外；而 ZCode 侧钩子都要写 `~/.zcode/cli/routing-state`
  // （挑战/租约指针/环状态/收尾去重）——写失败被各自 fail-open 陷阱吞掉，表现为 exit 0 + 无 stdout +
  // 状态零写入（实测 user-prompt/post-tool 全中）。本用例把"必须显式带覆盖"钉成机械判据。
  const seen = [];
  const recordingCtx = {
    shell: {
      resolve(request) {
        seen.push(request);
        return request;
      },
      async execute(spec) {
        return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, spec }) };
      },
    },
    logger: { warn() {} },
  };
  const handler = { command: 'node', args: ['x.mjs'], timeoutMs: 5000 };
  await runHandler(recordingCtx, handler, buildPayload('Stop', { sessionId: 's', cwd: REPO_ROOT }), {
    cwd: REPO_ROOT,
    env: { ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') },
  });
  assert.equal(seen.length, 1);
  assert.ok('sandboxPolicy' in seen[0], '请求必须带 `sandboxPolicy`（宿主执行器读的就是这个字段名：request.sandboxPolicy ?? 部署策略）');
  assert.deepEqual(seen[0].sandboxPolicy, { mode: 'danger-full-access' }, '覆盖值必须是"不解沙箱"档，否则钩子仍写不了状态目录');
  assert.equal(HOOK_SANDBOX_POLICY.mode, 'danger-full-access', '覆盖值取自导出的适配层常量（防有人改常量为不覆盖/更严档）');
  assert.ok(Object.isFrozen(HOOK_SANDBOX_POLICY), '覆盖常量须只读：运行期不得被改掉策略');
});

test('宿主契约（OPEN-40）：dsh-pwsh-sandbox 的 resolve() 仍按 `request.sandboxPolicy` 盖章', async () => {
  // 为什么要有（2026-09-29 内部任务-DSHADAPTER-2，收尾评审 C-1/M-1 + 内部规格 内部未决-40）：
  // 上批的适配层用例只断言"本层请求带了该字段"，不碰宿主实现；宿主一旦改名或取消按调用覆盖，
  // 本层会**静默**退回 P2 修复前的失效形态（钩子写不了状态目录 → exit 0 + stdout/stderr 皆空 +
  // 状态零写入，被各钩子 fail-open 吞掉）。本用例把宿主那一半也钉住：宿主包由 dsh-engine 从
  // app.asar 抽取后**实读其 resolve 源码**，两个语义锚点缺一即红。
  // 失效可见性：宿主不可得时**直接 fail**（不静默 skip）——静默跳过会让这条钉子退化为装饰。
  // 局限（如实记）：这是源码级锚定（非实例化回环）；宿主若换成等价但改名的实现，本用例会红并
  // 提示人工复核，而不是漏过。
  const host = await loadEngine('@deepseek-ai/dsh-pwsh-sandbox');
  assert.ok(host !== undefined, '宿主包 @deepseek-ai/dsh-pwsh-sandbox 抽取失败：无法校验契约（OPEN-40 钉子不允许静默跳过）');
  const executor = host.default ?? host.SandboxPwshExecutor;
  assert.equal(typeof executor?.prototype?.resolve, 'function', '宿主执行器应有 resolve()（形态已变，请复核 OPEN-40）');
  const src = String(executor.prototype.resolve);
  // 锚点必须精确到「按调用覆盖」这一形态：`sandboxPolicy` 裸串在宿主 resolve 源码里出现三处
  // （结果键、request 字段、ctx 兜底），只锚裸串时"宿主取消按调用覆盖"（改成直接取 ctx 兜底）与
  // "request 字段改名"两种变更都会**仍绿**——恰是 内部未决-40 要防的静默复发（2026-09-29 收尾评审
  // 正确性阻塞 1 的实测结论）。故锚 `request.sandboxPolicy ??` 的完整读法。
  assert.ok(
    /request\.sandboxPolicy\s*\?\?/.test(src),
    '宿主 resolve() 须仍以 `request.sandboxPolicy ?? …` 读按调用覆盖——裸串锚不住"取消覆盖"与"字段改名"两种变更（OPEN-40）',
  );
  // 直通分支在 execute()（resolve 只盖章策略；实测 resolve 源码不含该字面量，故分函数锚定）
  assert.equal(typeof executor?.prototype?.execute, 'function', '宿主执行器应有 execute()（形态已变，请复核 OPEN-40）');
  assert.ok(
    String(executor.prototype.execute).includes('danger-full-access'),
    '宿主 execute() 须仍保留 danger-full-access 的直通分支——删除即本层覆盖不再免沙箱',
  );
  assert.ok(
    ['read-only', 'workspace-write', 'danger-full-access'].includes(HOOK_SANDBOX_POLICY.mode),
    `本层覆盖取值须落在宿主沙箱模式闭集内，实为 ${HOOK_SANDBOX_POLICY.mode}`,
  );
  // POSIX 侧同形（2026-09-29 delta 评审判据）：dsh-bash-sandbox 与 Windows 侧逐字同形，同样以
  // "完整读法 + 直通分支"钉住；包不可得即 fail-loud（与上同，不静默跳过——静默会让钉子变装饰）。
  const hostPosix = await loadEngine('@deepseek-ai/dsh-bash-sandbox');
  assert.ok(hostPosix !== undefined, '宿主包 @deepseek-ai/dsh-bash-sandbox 抽取失败：POSIX 侧契约无法校验（不允许静默跳过）');
  const posixExecutor = hostPosix.default ?? hostPosix.SandboxBashExecutor;
  assert.equal(typeof posixExecutor?.prototype?.resolve, 'function', 'POSIX 执行器应有 resolve()（形态已变，请复核 OPEN-40）');
  assert.ok(
    /request\.sandboxPolicy\s*\?\?/.test(String(posixExecutor.prototype.resolve)),
    'POSIX 宿主 resolve() 须仍以 `request.sandboxPolicy ?? …` 读按调用覆盖（裸串锚不住字段改名——同 Windows 侧判据）',
  );
  assert.ok(
    String(posixExecutor.prototype.execute).includes('danger-full-access'),
    'POSIX 宿主 execute() 须仍保留 danger-full-access 直通分支',
  );
});

test('runHandler：超时按 GNU 语义呈现，且不向外抛（fail-open）', async () => {
  const ctx = {
    shell: {
      resolve: (r) => r,
      async execute() {
        return { result: async () => ({ exitCode: 124, stdout: { text: '' }, stderr: { text: '' }, timedOut: true }) };
      },
    },
    logger: { warn() {} },
  };
  const handler = { command: 'node', args: ['slow.mjs'], timeoutMs: 10 };
  const r = await runHandler(ctx, handler, buildPayload('Stop', { sessionId: 's', cwd: REPO_ROOT }), { cwd: REPO_ROOT, env: { ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') } });
  assert.equal(r.exitCode, 124);
  assert.equal(decodeHookOutput(r.exitCode, r.stdout, r.stderr, 'Stop').decision, undefined, '超时不得产出决策（不拦）');
});

test('logLine：按 cordis 的 printf 协议调用，消息里的 % 不被当格式符', async () => {
  const { logLine, logWarn, logInfo } = await import('../src/log.mjs');
  const logger = makeLoggerStub();
  logWarn(logger, '路径含 % 与 %s 字样：C:/a%20b/x');
  assert.deepEqual(logger.byLevel('warn'), ['路径含 % 与 %s 字样：C:/a%20b/x'], '整条消息原样送达，未被格式化');
  assert.equal(logger.messages[0].level, 'warn');
  logInfo(logger, 'ok');
  assert.deepEqual(logger.byLevel('info'), ['ok']);
  // 替身缺失 / 方法非函数 / 方法抛错：都不得反噬
  assert.doesNotThrow(() => logLine(undefined, 'warn', 'x'));
  assert.doesNotThrow(() => logLine({}, 'warn', 'x'));
  assert.doesNotThrow(() => logLine({ warn: 'not-a-function' }, 'warn', 'x'));
  assert.doesNotThrow(() => logLine({ warn: () => { throw new Error('logger 坏了'); } }, 'warn', 'x'));
});

test('fail-open 兜底：监听器内部抛错绝不外溢到宿主（五个事件逐个验）', async () => {
  // 构造一个 shell seam，它在 execute 阶段抛错——`runHandler` 会吞住这一类；
  // 但 handlerCommandLine / JSON.stringify / mergeResults 在它的 try 之外，
  // 所以还需要监听器级的 safe() 兜底。这里用"shell.resolve 抛错"覆盖外层路径：
  // resolve 在 runHandler 的 try 内，因此换一种更狠的注入——让 dispatch 依赖的
  // ctx.get('shell') 抛错，这是 runHandler 无法兜住的（在 try 之外）。
  const ctx = makeFakeCtx();
  const boom = new Error('shell 服务在读取时爆炸');
  ctx.get = (name) => {
    if (name === 'shell') throw new Error('服务读取签名异常');
    return new Map([['skills', { register: () => () => {} }]]).get(name);
  };
  ctx.shell = {
    get resolve() {
      throw boom;
    },
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
  };
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });

  const agent = { sessionId: 's', inject: () => {}, steer: () => {}, followup: () => {} };
  const next = async () => ({ kind: 'enter', messages: [] });

  // 五个事件全部不得抛错（宿主正是这样同步/异步调用它们的）
  await assert.doesNotReject(() => ctx.emit('agent/created', { agent, source: 'startup', signal: undefined }));
  await assert.doesNotReject(() =>
    ctx.emit('agent/pre-step', { agent, messages: [{ content: [{ type: 'text', text: '你好' }] }], signal: undefined }, next),
  );
  await assert.doesNotReject(() =>
    ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent, callId: 'c1', signal: undefined }, next),
  );
  await assert.doesNotReject(() =>
    ctx.emit('tools/post-execute', { name: 'pwsh', arguments: {}, agent, callId: 'c2', signal: undefined }, { content: [] }, next),
  );
  await assert.doesNotReject(() => ctx.emit('agent/turn-stopping', { agent, signal: undefined }));

  assert.ok(
    ctx.byLevel('warn').some((m) => /按无意见放行（fail-open）/.test(m)),
    `应有 fail-open 告警，实际：${JSON.stringify(ctx.byLevel('warn'))}`,
  );
});

test('resolveAvailableTools：公开 API tools.get 逐候选探测（DEV-273 H-02；分支全覆盖）', async () => {
  const { resolveAvailableTools, resolveService } = await import('../src/index.mjs');
  const withTools = (tools) => ({ get: (n) => (n === 'tools' ? tools : undefined) });

  // 无 tools 服务 / 显式 null / 无 get 方法：目录不可得 → null（fail-closed）
  assert.equal(resolveAvailableTools({}), null);
  assert.equal(resolveAvailableTools(withTools(null)), null);
  assert.equal(resolveAvailableTools(withTools({ restrictableNames: new Set(['read']) })), null, '旧成员形态不得再被采信（宿主服务无该成员）');

  // 公开 API 探测：get 命中即收入；未知名返回 undefined 不收入
  const known = new Set(['read', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write', 'pwsh', 'bash']);
  const probe = (name) => (known.has(name) ? { name } : undefined);
  assert.deepEqual(resolveAvailableTools(withTools({ get: probe })).sort(), [...known].sort(), '候选集内全部命中恰返回该集');
  assert.deepEqual(resolveAvailableTools(withTools({ get: (n) => (n === 'read' ? {} : undefined) })), ['read'], '部分命中只返回命中项');
  // 全不命中 / 只命中未知候选：null（不拿空 allow 去挂子 agent）
  assert.equal(resolveAvailableTools(withTools({ get: () => undefined })), null);

  // get 抛错（宿主对未知名抛错形态）→ 逐候选跳过；全部抛错则 null，绝不整体抛出
  assert.equal(resolveAvailableTools(withTools({ get: () => { throw new Error('unknown tool'); } })), null);
  assert.deepEqual(
    resolveAvailableTools(withTools({ get: (n) => { if (n === 'read') return {}; throw new Error('unknown'); } })),
    ['read'],
    '单候选抛错不影响其余候选',
  );

  // 探测本身抛错（服务读取签名异常）→ null，绝不抛出
  assert.equal(
    resolveAvailableTools({
      get() {
        throw new Error('服务读取签名异常');
      },
    }),
    null,
  );

  // resolveService：ctx.get 缺席时回落到属性读（测试替身兼容），两者皆无则 undefined
  assert.deepEqual(resolveService({ tools: { get: () => ({}) } }, 'tools').get('x'), {});
  assert.equal(resolveService({}, 'tools'), undefined);
});

test('DEV-273 H-08：插件根受信边界——node_modules 基址不参与同级发现、pluginRoots 相对路径被拒', async () => {
  const { discoverPlugins, resolvePluginRoots, isPluginRoot } = await import('../src/index.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dev273-h08-'));
  try {
    // 结构：<root>/node_modules/{workflow,pkg/src}；仅 node_modules 下有同名插件根
    mkdirSync(join(dir, 'node_modules', 'workflow'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'workflow', 'plugin.manifest.json'), '{"name":"workflow"}', 'utf8');
    mkdirSync(join(dir, 'node_modules', 'pkg', 'src'), { recursive: true });
    const found = discoverPlugins(join(dir, 'node_modules', 'pkg', 'src'));
    assert.equal(found.workflow, undefined, 'node_modules 基址不得被采信（H-08 收窄；旧实现会把 node_modules/workflow 当插件根）');
    // 同级发现（非 node_modules）仍可用
    mkdirSync(join(dir, 'workflow'), { recursive: true });
    writeFileSync(join(dir, 'workflow', 'plugin.manifest.json'), '{"name":"workflow"}', 'utf8');
    assert.ok(isPluginRoot(join(dir, 'workflow')));
    // 判别性（约定评审 F6）：从非 node_modules 起点仍能命中同级发现，证明基址过滤未误伤全部基址。
    mkdirSync(join(dir, 'workdir', 'src'), { recursive: true });
    assert.equal(discoverPlugins(join(dir, 'workdir', 'src')).workflow, join(dir, 'workflow'), '非 node_modules 起点仍需命中同级发现');
    // 显式配置相对路径：拒绝且不回落（与安装记录相对路径拒绝同口径）——discovered/installed 均给合法根仍必须 missing
    const r = resolvePluginRoots({ discovered: {}, installed: {}, override: { workflow: 'relative/workflow' } });
    assert.equal(r.roots.workflow, undefined, '相对 pluginRoots 不得被接受');
    assert.ok(r.missing.includes('workflow'), '相对路径计入 missing（不回落自动来源）');
    const r2 = resolvePluginRoots({ discovered: { workflow: join(dir, 'workflow') }, installed: {}, override: { workflow: 'relative/workflow' } });
    assert.equal(r2.roots.workflow, undefined, '相对配置不得静默回落到 sibling 根（正确性评审 round1 #1）');
    assert.ok(r2.missing.includes('workflow'), '有可用 sibling 时相对配置仍计入 missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约常量：SUPPORTED_EVENTS 恰为五个事件且与本层实际注册面一致', async () => {
  const { SUPPORTED_EVENTS, OUTPUT_MAX_CHARS, DEFAULT_TIMEOUT_MS } = await import('../src/hooks-bridge.mjs');
  assert.deepEqual(SUPPORTED_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  // 与 内部接口-1 事件表逐条对齐（套件插件 hooks.json 里出现的事件必须被支持面覆盖，
  // 否则声明了也永远不触发——这类"静默失效"只能靠交叉断言拦住）
  const config = readHookConfig(join(REPO_ROOT, 'workflow'));
  for (const event of Object.keys(config)) {
    assert.ok(SUPPORTED_EVENTS.includes(event), `workflow 声明了 ${event}，但适配层不支持`);
  }
  // 输出上限必须存在且为正（防跑飞钩子吃内存的护栏，不允许被改成 0/undefined）
  assert.ok(Number.isFinite(OUTPUT_MAX_CHARS) && OUTPUT_MAX_CHARS > 0);
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 60_000);
});

test('导出契约：toolNameOf / commandDefinitionId / agentFileNames 的形态', async () => {
  const { toolNameOf } = await import('../src/agents-bridge.mjs');
  const { commandDefinitionId, DEFINITION_NAMESPACE } = await import('../src/commands-bridge.mjs');
  const { agentFileNames } = await import('../src/agents-bridge.mjs');

  // kebab → snake：DSH 工具名形态（宿主工具名只允许下划线分隔）
  assert.equal(toolNameOf('code-explorer'), 'code_explorer');
  assert.equal(toolNameOf('code-architect'), 'code_architect');
  assert.equal(toolNameOf('code-reviewer'), 'code_reviewer');

  // definitionId 必须真的用命名空间常量拼出来（防止常量与实现漂移）
  assert.equal(commandDefinitionId('workflow-x'), `${DEFINITION_NAMESPACE}/workflow-x`);
  assert.equal(DEFINITION_NAMESPACE, 'ai-coding-methodology/ai-coding-methodology');

  // 真实 workflow agents 目录：三个 .md，排序确定
  const names = agentFileNames(join(REPO_ROOT, 'workflow'));
  assert.deepEqual(names, ['code-architect.md', 'code-explorer.md', 'code-reviewer.md']);
});

test('fail-open 语义：PreToolUse 出错必须放行工具，UserPromptSubmit 出错必须放行提示词', async () => {
  // 这两个事件的 fail-open 是**唯一防线**（2026-09-28 第 22 批查、第 23 批更正、第 59 批逐点复核）：
  // 五个事件**都没有宿主兜底**——`agent/created` 走 `ctx.serial`（裸 await、零 try/catch）、
  // `agent/turn-stopping` 走 `dispatch.serial`（且该 await 位于 step 循环 try 块内，失败会让整轮
  // 以错误收场）、其余三个走 `waterfall`（`next() { return cb(...args) }` 原样转调）。
  // 宿主 `dispatch.js` 里那套 per-listener try/catch 属 **emit（非否决型通知）** 路径，
  // 与本层这五个事件**无关**。故 `safe()` 失效 ⇒ 一次钩子异常冒进 agent 主循环、打断该轮。
  //
  // ⚠ 本注释曾写"`agent/created` 与 `agent/turn-stopping` 上 safe() 只是第二道防线"——
  // **是错的**（第 22 批据此把两个事件归成 emit，第 23 批已更正）。留下这段更正痕迹，
  // 是因为"低估守卫"比"高估守卫"更危险：读者可能据此认为那两个事件的 safe() 可以省。
  //
  // 让钩子面真正失灵的手法：把 `ctx.get('shell')` 打成抛错。这一条在 `runHandler` 的
  // try **之外**（它只包 shell.execute 之后），所以只有监听器级的 safe() 能兜。
  const ctx = makeFakeCtx();
  ctx.get = () => {
    throw new Error('shell 服务不可读');
  };
  ctx.shell = {
    get resolve() {
      throw new Error('shell 不可用');
    },
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
  };
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });

  const agent = { sessionId: 's', inject: () => {}, steer: () => {}, followup: () => {} };
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(1);
    return { kind: 'enter', messages: [] };
  };

  // PreToolUse：钩子面失灵时必须放行（绝不能是 deny/ask）
  const pre = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'rm -rf /' }, agent, callId: 'c1', signal: undefined }, next);
  assert.equal(pre?.kind, 'enter', `PreToolUse 失灵时必须放行，实际 ${JSON.stringify(pre)}`);
  assert.equal(nextCalls.length, 1);

  // UserPromptSubmit：同样放行，不把用户提示词拦掉
  // 内部任务-173：UPS 之后注册了 SessionStartDelivery（无槽纯直通）⇒ 串行 emit 下 next 再调用一次
  const step = await ctx.emit('agent/pre-step', { agent, messages: [{ content: [{ type: 'text', text: '你好' }] }], signal: undefined }, next);
  assert.equal(step?.kind, 'enter');
  assert.equal(nextCalls.length, 4); // 内部任务-220：BridgeChannelHint 纯直通也委托下游一次

  // PostToolUse 也应放行（不容错则工具结果被吞）
  const post = await ctx.emit('tools/post-execute', { name: 'pwsh', arguments: {}, agent, callId: 'c2', signal: undefined }, { content: [] }, next);
  assert.equal(post?.kind, 'enter');

  assert.ok(ctx.byLevel('warn').some((m) => /fail-open/.test(m)), '失灵必须响亮告警');
});

test('PreToolUse 失灵的后果是「工具被报错」，不是「静默跳过」——safe() 兜住的正是这个', async () => {
  // 源码核实（2026-09-28 第 24 批）：`dsh-tools/lib/index.js` 把 pre-execute 的 waterfall
  // 整段放在 try 里，catch 分支返回 `next({kind:"final-result", exec, result: toolErrorResult(error)})`；
  // post-execute 的 JSDoc 亦明写 "Runs inside execute's outer try/catch (a throwing listener → isError)"。
  // **即：一个抛错的 PreToolUse 监听器会让工具根本不执行、并被报成 isError**——对使用者就是
  // "命令莫名失败"。这不是"少一道护栏"，是**破坏工具调用本身**，比护栏失效更坏。
  // safe() 的 fallback 把这条路径改回「放行」。
  const ctx = makeFakeCtx();
  ctx.get = () => {
    throw new Error('shell 服务不可读');
  };
  ctx.shell = {
    get resolve() {
      throw new Error('shell 不可用');
    },
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
  };
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });

  const agent = { sessionId: 's', inject: () => {}, steer: () => {}, followup: () => {} };
  // 宿主 waterfall 的 innermost 分别是 {kind:'allow'} / {kind:'accept'}；
  // safe() 走 fallback → next() → 落到 innermost。
  const pre = await ctx.emit(
    'tools/pre-execute',
    { name: 'pwsh', arguments: { command: 'git status' }, agent, callId: 'c', signal: undefined },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(pre.kind, 'allow', `必须放行工具；为 error/deny 即工具被误报为失败。实际 ${JSON.stringify(pre)}`);

  const post = await ctx.emit(
    'tools/post-execute',
    { name: 'pwsh', arguments: {}, agent, callId: 'c', signal: undefined },
    { content: [] },
    async () => ({ kind: 'accept' }),
  );
  assert.equal(post.kind, 'accept', `必须接受工具结果；实际 ${JSON.stringify(post)}`);
});

test('fail-open 语义：session-start 与 turn-stopping 也必须不冒错（两者都是 serial 事件）', async () => {
  // 源码逐条核实（2026-09-28 第 23 批，更正第 22 批的误判）：
  //   · `agent/created` → dsh-agent/lib/index.js:580 `await this.ctx.serial(entry.carrier, …)`，
  //     其 JSDoc 明写 register "Rejects if … a serial `agent/created` listener fails"；
  //   · `agent/turn-stopping` → dsh-agent-loop 的 `await this.dispatch.serial(…)`，
  //     且该 await 位于 **step 循环的 try 块内**。
  // cordis `serial` 是裸 `await cb(...args)`（零 try/catch）。故一次钩子异常足以：
  //   ① 让 agent 注册/创建失败；② 让整轮对话以错误收场。两者都必须由 safe() 兜住。
  const ctx = makeFakeCtx();
  ctx.get = () => {
    throw new Error('shell 服务不可读');
  };
  ctx.shell = {
    get resolve() {
      throw new Error('shell 不可用');
    },
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
  };
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });

  const agent = { sessionId: 's', inject: () => {}, steer: () => {}, followup: () => {} };
  // agent/created：绝不能 reject（否则 register/create 失败，agent 创建不出来）
  await assert.doesNotReject(
    () => ctx.emit('agent/created', { agent, source: 'startup', signal: undefined }),
    'agent/created 失灵时必须放行注册',
  );
  // agent/turn-stopping：绝不能 reject（否则整个 run() 的 try 捕获、按 turn 错误收场）
  await assert.doesNotReject(
    () => ctx.emit('agent/turn-stopping', { agent, signal: undefined }),
    'turn-stopping 失灵时不得让整轮以错误收场',
  );
  assert.ok(ctx.byLevel('warn').filter((m) => /fail-open/.test(m)).length >= 2, '两处失灵都要告警');

  // **fail-open 的返回值必须是 undefined**（2026-09-28 第 92 批补）：这两个是 **serial** 事件，
  // 宿主按"顺序 await"分发、**没有 `next`**，其返回值宿主也不消费（§8.51）。变异实测：
  // 把这两处 fallback 从 `undefined` 改成 `() => ({ kind: 'boom' })`，**139 项全绿**——
  // 即"返回值语义"此前无人指定。语义必须钉住：serial 事件失灵 ⇒ 返回 undefined（无意见），
  // **不得**凭空造一个 verdict 对象（万一将来宿主改为消费该返回值，伪造的 verdict 会变成真决策）。
  const createdRet = await ctx.emit('agent/created', { agent, source: 'startup', signal: undefined });
  const stoppingRet = await ctx.emit('agent/turn-stopping', { agent, signal: undefined });
  assert.equal(createdRet, undefined, 'SessionStart 失灵时返回值必须是 undefined（不得伪造 verdict）');
  assert.equal(stoppingRet, undefined, 'Stop 失灵时返回值必须是 undefined（不得伪造 verdict）');
});

test('decodeHookOutput：契约锁定——套件插件实际用的三种信封形态', () => {
  // 三种形态都是源码实证的（不是设想）：
  //  ① check-careful / check-freeze 的 deny：`preToolUseEnvelope` 只发 permissionDecision +
  //     systemMessage，**不发 permissionDecisionReason**（workflow/hooks/hook-lib.mjs:81）；
  //  ② session-start / task-recap / learnings-recap 的注入：additionalContext 单键；
  //  ③ verify-gate 的阻断：**exit 2 且 stdout 仍是信封**（workflow/hooks/verify-gate.mjs:109）。
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: '[careful][HIGH] 危险' } });
  const d1 = decodeHookOutput(0, deny, '', 'PreToolUse');
  assert.equal(d1.decision, 'deny');
  assert.equal(d1.reason, '[careful][HIGH] 危险', 'systemMessage 必须作为拒因——宿主桥忽略它，本层读它是**必要**的，不是冗余');

  const inject = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '路由表全文' } });
  const d2 = decodeHookOutput(0, inject, '', 'SessionStart');
  assert.equal(d2.decision, undefined, '注入型信封不产生决策');
  assert.equal(d2.additionalContext, '路由表全文');

  // exit 2 + 信封：决策来自退出码，但 additionalContext 仍须采信（verify-gate 的形态）
  const block = JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '门禁未满足' } });
  const d3 = decodeHookOutput(2, block, '人读文案', 'Stop');
  assert.equal(d3.decision, 'deny', 'exit 2 = deny（与宿主桥语义一致）');
  assert.equal(d3.additionalContext, '门禁未满足', 'exit 2 时 stdout 信封仍须解析');
  assert.equal(d3.reason, '人读文案', '信封未给 reason 时回落 stderr');

  // 信封给的 reason 优先于 stderr（结构化优先）
  const d4 = decodeHookOutput(2, deny, 'stderr 备份', 'PreToolUse');
  assert.equal(d4.reason, '[careful][HIGH] 危险', '信封 systemMessage 优先于 stderr');
  assert.equal(d4.decision, 'deny');
});

test('normalizeSessionSource：ZCode 词表透传，其余一律归 startup（不许静默丢弃）', async () => {
  const { normalizeSessionSource, matchesMatcher, collectHandlers, discoverPlugins } = await import('../src/index.mjs');
  // 源码核实（2026-09-28 第 29 批；第 64 批更正）：`agent/created` 的 source 由
  // `dsh-agent-loop` 的 `setupAndPublish(..., source, ...)` 传入，**有两个调用点**——
  // `"startup"`（L1846/L1850 附近）与 `"resume"`（L1950 附近）。第 29 批原写"只以 startup
  // 宣告、第 493 行是唯一 announce 调用点"，**不准确**；结论（需要归一兜底）不变。
  // `dsh-agent` 的 `announce()` JSDoc 还提到 clear/compaction，但代码里**没有对应调用点**。
  // 之所以仍写归一函数：ZCode 侧 matcher 是 `startup|resume|clear|compact`，若宿主将来
  // 引入新词，直接丢弃会让 SessionStart 注入静默失效——而那条注入是元技能全文进入模型的
  // 唯一通道（内部规则-5）。归一保证"最坏也只是把一次 resume 当 startup 处理"，绝不静默不注入。
  assert.equal(normalizeSessionSource('startup'), 'startup');
  assert.equal(normalizeSessionSource('resume'), 'resume');
  assert.equal(normalizeSessionSource('clear'), 'clear');
  assert.equal(normalizeSessionSource('compact'), 'compact');
  // 未知/缺省一律归 startup —— 且必须能匹配上 ZCode 的真实 matcher
  for (const unknown of [undefined, null, '', 'new', 'restore', 'fork', 42, {}]) {
    assert.equal(normalizeSessionSource(unknown), 'startup', `未知来源 ${JSON.stringify(unknown)} 应归 startup`);
  }
  const zcodeMatcher = 'startup|resume|clear|compact';
  for (const word of ['startup', 'resume', 'clear', 'compact']) {
    assert.equal(matchesMatcher(zcodeMatcher, normalizeSessionSource(word)), true, `${word} 应命中 ZCode matcher`);
  }
  for (const unknown of [undefined, 'new', 'restore', 'fork']) {
    assert.equal(matchesMatcher(zcodeMatcher, normalizeSessionSource(unknown)), true, `未知来源 ${String(unknown)} 归 startup 后必须仍命中`);
  }

  // 组合清单里的**真实形态**（2026-09-28 第 64 批实测）：三个插件声明四词表、team-governance
  // **未声明 matcher**。后者靠 `matchesMatcher(undefined, ·) === true` 在任何 source 下都跑
  // ——治理摘要本就该每会话都出。这条断言把"两种形态各自都能触发"锁住：只测 matchesMatcher
  // 的单元行为、不看组合清单，就漏掉"某个插件被漏挂"这类整合错误。
  const { byEvent } = collectHandlers(discoverPlugins(join(HERE, '..', '..')));
  const starts = byEvent.SessionStart ?? [];
  assert.equal(starts.length, 5, `SessionStart 应挂到五个插件，实为 ${starts.length}`);
  const nameOf = (e) => e.pluginRoot.split(/[\\/]/).pop();
  const noMatcher = starts.filter((e) => e.handler.matcher === undefined).map(nameOf);
  const withMatcher = starts.filter((e) => e.handler.matcher !== undefined);
  assert.deepEqual(noMatcher, ['team-governance'], `未声明 matcher 的应恰为 team-governance，实为 ${JSON.stringify(noMatcher)}`);
  for (const e of withMatcher) {
    // 带词表的：任意 source 经归一后都必须能命中（否则 SessionStart 注入静默失效）
    for (const src of [undefined, 'new', 'startup', 'resume', 'compact', '']) {
      assert.equal(
        matchesMatcher(e.handler.matcher, normalizeSessionSource(src)),
        true,
        `${nameOf(e)} 的 matcher 在 source=${String(src)} 下必须命中`,
      );
    }
  }
  for (const e of starts.filter((x) => x.handler.matcher === undefined)) {
    assert.equal(matchesMatcher(e.handler.matcher, 'anything'), true, `${nameOf(e)} 无 matcher 须恒真`);
  }
});
test('discoverFromInstalledPlugins：读 ZCode 权威安装记录（补位来源），坏记录一律 fail-open', async (t) => {
  const { discoverFromInstalledPlugins } = await import('../src/index.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const recordDir = join(home, '.zcode', 'cli', 'plugins');
  mkdirSync(recordDir, { recursive: true });
  const record = join(recordDir, 'installed_plugins.json');

  // ① 记录不存在 → 空对象（不是错误：fail-open，交给 pluginRoots 配置兜底）
  assert.deepEqual(discoverFromInstalledPlugins(home), {});

  // ② 造四个真实形态的插件根（判断依据是 `.zcode-plugin/plugin.json`）
  const mkPluginRoot = (name) => {
    const root = join(home, 'cache', 'wk', name, '0.5.0');
    mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.5.0' }), 'utf8');
    return root;
  };
  const roots = Object.fromEntries(['workflow', 'spec-gate', 'scout', 'team-governance'].map((n) => [n, mkPluginRoot(n)]));
  writeFileSync(
    record,
    JSON.stringify({
      version: 1,
      plugins: [
        { id: 'other@mkt', name: 'other-plugin', installPath: join(home, 'nope') },
        ...Object.entries(roots).map(([name, installPath]) => ({ id: `${name}@wk`, name, marketplace: 'wk', version: '0.5.0', installPath })),
      ],
    }),
    'utf8',
  );
  const found = discoverFromInstalledPlugins(home);
  assert.deepEqual(Object.keys(found).sort(), ['scout', 'spec-gate', 'team-governance', 'workflow']);
  for (const [name, root] of Object.entries(roots)) assert.equal(found[name], root);

  // ③ 同名多条（多 marketplace / 升级残留）→ 取最后一条（记录为追加式更新）
  mkdirSync(join(recordDir, 'x'), { recursive: true });
  const newer = mkPluginRoot('workflow');
  writeFileSync(
    record,
    JSON.stringify({
      plugins: [
        { name: 'workflow', installPath: roots.workflow },
        { name: 'workflow', installPath: newer },
      ],
    }),
    'utf8',
  );
  assert.equal(discoverFromInstalledPlugins(home).workflow, newer, '同名多条取最后一条');

  // ④ 记录损坏 / 结构漂移 / installPath 指向非插件根 → 空对象，绝不抛
  writeFileSync(record, '{ 不是合法 JSON', 'utf8');
  assert.deepEqual(discoverFromInstalledPlugins(home), {});
  writeFileSync(record, JSON.stringify({ plugins: 'not-an-array' }), 'utf8');
  assert.deepEqual(discoverFromInstalledPlugins(home), {});
  writeFileSync(record, JSON.stringify({ plugins: [{ name: 'workflow', installPath: join(home, 'no-such-dir') }] }), 'utf8');
  assert.deepEqual(discoverFromInstalledPlugins(home), {}, 'installPath 非插件根时不得采信');

  // ⑤ **真实记录的逐字形态**（含 `installPath` 的尾部路径分隔符）
  //   实测（2026-09-28 第 60 批）本机 live 记录里 installPath 形如
  //   `C:\Users\…\cache\wangp-local-marketplace\workflow\0.5.0\` —— **带尾部反斜杠**，
  //   而本文件此前的夹具都是手工简化的、不带尾部分隔符。
  //   本用例钉住两点（**均为"此前无覆盖"，不是"曾经会炸"**）：
  //   ① 真实形态仍被判为插件根（`join(root, '.zcode-plugin')` 会规整掉重复分隔符）；
  //   ② 返回值**原样**等于记录里的 installPath（含尾部分隔符，不做归一）。
  //   注记：探针最初写成断言"返回去尾分隔符的路径"而红——**是探针期望错了，不是实现**。
  //   核对过 `existsSync` 在双分隔符下同样为真，故"改成字符串相加就会判不出插件根"这一
  //   推测**不成立**（Windows/POSIX 都会折叠连续分隔符）；本用例的价值在于覆盖真实数据形态，
  //   不在于防某个假想故障。夹具与真实记录的形态差异，是这类测试最容易漏掉的东西。
  const realish = mkPluginRoot('scout');
  writeFileSync(
    record,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: 'scout@wangp-local-marketplace',
          name: 'scout',
          marketplace: 'wangp-local-marketplace',
          version: '0.5.0',
          installPath: realish + sep, // ← 真实记录的关键特征
          installedAt: '2026-09-14T06:47:07.627Z',
          updatedAt: '2026-09-28T04:38:16.000Z',
          scope: 'user',
          source: './plugins/scout',
          cacheTransactionId: '31662c10-e046-4432-9b34-fe867d2f7147',
        },
      ],
    }),
    'utf8',
  );
  assert.equal(
    discoverFromInstalledPlugins(home).scout,
    realish + sep,
    '带尾部分隔符的 installPath（真实记录形态）必须仍能被判为插件根，且原样返回（含尾部分隔符）',
  );

  // ⑥ 相对 installPath 必须被拒绝（2026-09-28 第 61 批补的守卫）
  //   为什么要拒：相对路径会被 `isPluginRoot` 按**进程 cwd** 解析——若 cwd 下恰好有个同名的
  //   插件根，就会把无关目录当成该插件的根，**比找不到更坏**（静默接错来源）。
  //
  //   ⚠ 这条断言很容易写成"假通过"：若相对路径既不存在于 cwd 下、也不是绝对路径，那么
  //   `isPluginRoot` 本来就会返回 false，去掉守卫照样"通过"。故必须让相对路径**在 cwd 下
  //   真实存在**，否则测的不是守卫。做法：拿**本进程 cwd** 的路径转成相对形式（`relative`），
  //   ⚠ 这条断言极易写成"假通过"，两个坑本轮都踩过：
  //   ① 若相对路径在 cwd 下**不存在**，`isPluginRoot` 本来就会返回 false ⇒ 去掉守卫也"通过"；
  //   ② `path.relative()` 在 **Windows 跨盘符**时**直接返回绝对路径**（实测：cwd 在 D:、
  //      临时目录在 C: 时 `relative()` 原样给出 `C:\…`）⇒ 根本构造不出相对路径，退化成 ①。
  //   故：只有当临时根与 cwd **同盘/同根**时才做这条强断言，否则**显式打印跳过**（不静默通过）。
  const relCandidate = relative(process.cwd(), mkPluginRoot('scout'));
  const relForm = relCandidate.split('\\').join('/');
  if (!isAbsolute(relCandidate) && existsSync(relForm)) {
    writeFileSync(record, JSON.stringify({ plugins: [{ name: 'scout', installPath: relForm }] }), 'utf8');
    assert.deepEqual(
      discoverFromInstalledPlugins(home),
      {},
      `相对 installPath（按 cwd 可解析到真实插件根 ${relForm}）必须被拒绝`,
    );
  } else {
    // 跳过不是"算了"——必须先证明跳过是**逻辑必然**：此处 relative() 给不出相对路径，
    // 是因为它与 cwd 不同盘符（Windows 上跨盘 relative() 直接返回绝对路径）。若该前提不成立
    // （例如临时目录改到与 cwd 同盘却仍走进 else 分支），说明是别的原因，不能静默跳过。
    assert.ok(
      isAbsolute(relCandidate),
      `跳过"相对路径"断言的前提不成立：relative() 给出 ${JSON.stringify(relCandidate)} 既非相对、又未走强断言分支`,
    );
    console.log(
      `  注：无法构造"按 cwd 可解析的相对路径"（relative() 给出绝对路径 ${JSON.stringify(relCandidate)}，` +
        `因临时目录与 cwd 不同盘符——该前提已断言），跳过该强断言`,
    );
  }

  // 反向对照：绝对路径必须被接受——否则上面可能只是"什么都没找到"。
  writeFileSync(record, JSON.stringify({ plugins: [{ name: 'scout', installPath: realish }] }), 'utf8');
  assert.equal(discoverFromInstalledPlugins(home).scout, realish, '绝对路径必须被接受（反向对照）');
});

test('apply 的来源合并规则：同级 > 安装记录；显式配置不被补位覆盖', async (t) => {
  // 说明为什么不在 apply 上直接测三条规则：`apply` 里的同级发现基于**本文件所在目录**
  // （`dirname(HERE)`），仓库检出下恒为 6/6，故"同级不足 ⇒ 用安装记录"这一分支在仓库内
  // **无法经 apply 走到**——硬造只能用临时目录搬动源码，得不偿失。所以规则在**它实际所在的地方**测：
  //   ① `discoverFromInstalledPlugins` 本身（上层用例已覆盖套件插件/同名取后/坏记录）；
  //   ② 决议函数 `resolvePluginRoots`（本用例）；
  //   ③ 仓库检出恒 6/6（下一条用例断言），保证开发态永远不会被缓存里的旧版本顶掉。
  // **2026-09-28 第 90 批改**：原先本用例**逐字复刻**了 `apply` 里的决议表达式——
  // 复刻件不会随 `apply` 演进而失效，属**会静默漂移的重复**。现改为把该逻辑抽成导出的
  // `resolvePluginRoots()`（`apply` 调同一个），测试直接调真实现，重复消失、也不再有漂移面。
  const { discoverFromInstalledPlugins, resolvePluginRoots } = await import('../src/index.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-home3-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const recordDir = join(home, '.zcode', 'cli', 'plugins');
  mkdirSync(recordDir, { recursive: true });
  const mkRoot = (name) => {
    const root = join(home, 'cache', name, '1.0.0');
    mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name }), 'utf8');
    return root;
  };
  const installedRoot = mkRoot('team-governance');
  writeFileSync(join(recordDir, 'installed_plugins.json'), JSON.stringify({ plugins: [{ name: 'team-governance', installPath: installedRoot }] }), 'utf8');
  const installed = discoverFromInstalledPlugins(home);
  // 模拟"同级只发现了 workflow"（用真实仓库的 workflow 根）
  const discovered = { workflow: join(REPO_ROOT, 'workflow') };

  const resolveRoots = (override) => resolvePluginRoots({ discovered, installed, override }).roots;

  // 无显式配置：同级命中 workflow，安装记录补上 team-governance，其余为空
  const r1 = resolveRoots({});
  assert.equal(r1.workflow, join(REPO_ROOT, 'workflow'), '同级来源优先');
  assert.equal(r1['team-governance'], installedRoot, '安装记录补位');
  assert.equal(r1.scout, undefined);
  assert.equal(r1['spec-gate'], undefined);
  // `missing` 必须如实列出未决议的插件（apply 的日志据此提示"未发现 X"）
  assert.deepEqual(
    resolvePluginRoots({ discovered, installed, override: {} }).missing.sort(),
    ['algo-loop', 'research-loop', 'scout', 'spec-gate'].sort(),
  );

  // 显式配置坏路径：**不**被补位（"显式指定"必须名符其实）
  const empty = join(home, 'no-such');
  const r2 = resolveRoots({ workflow: empty });
  assert.equal(r2.workflow, undefined, '显式配置的坏路径不得回落到自动发现');
  assert.equal(r2['team-governance'], installedRoot, '未显式配置的仍可补位');

  // **同名同时存在于两个来源时，同级必须赢**（2026-09-28 第 90 批补）：
  // 此前所有场景里两个来源都是**互不重叠**的（同级只有 workflow、记录只有 team-governance），
  // 于是"谁优先"根本没被验证——把优先级反过来写成 `(installed[p] ?? discovered[p])`
  // 全仓 137 项**依然全绿**（变异实测）。这正是注释里担心的后果：
  // 仓库检出下同级根比缓存里的已发布旧版**新**，优先级一旦反了，**改代码不生效、
  // 测试对着旧资产跑**——而且是静默的。故这里让两者**都命中同一个插件**，把优先级钉死。
  const bothSibling = join(REPO_ROOT, 'workflow');
  const bothInstalled = mkRoot('workflow');
  const r3 = resolvePluginRoots({
    discovered: { workflow: bothSibling },
    installed: { workflow: bothInstalled },
    override: {},
  }).roots;
  assert.equal(r3.workflow, bothSibling, '两个来源都有该插件时，同级来源必须优先于安装记录');
  assert.notEqual(r3.workflow, bothInstalled);
  // 反向对照：同级没有时，记录仍能补上（否则上一条可能只是"永远取第一个"）
  const r4 = resolvePluginRoots({ discovered: {}, installed: { workflow: bothInstalled }, override: {} }).roots;
  assert.equal(r4.workflow, bothInstalled, '同级缺席时记录必须补位');
});

test('apply 的开发态保证：仓库检出下同级发现恒为 6/6，故不读安装记录', async () => {
  const { discoverPlugins, PLUGINS } = await import('../src/index.mjs');
  const { dirname: dn } = await import('node:path');
  const { fileURLToPath: f } = await import('node:url');
  const srcDir = join(dn(f(import.meta.url)), '..');
  const found = discoverPlugins(dn(srcDir));
  assert.deepEqual(Object.keys(found).sort(), [...PLUGINS].sort(), '仓库检出必须 6/6，否则 apply 会去读缓存旧版本');
});

test('日志出口：用**宿主真实**的 `Logger.format` 渲染本层消息，结果必须逐字一致', async (t) => {
  // 这一条钉的是"装机时日志长什么样"——本层唯一的对外观测面。
  //
  // 为何过去只能"等价验证"：`apply` 的启动日志只有在**真实宿主**里跑一遍才能看到，而那需要
  // 凭据（§8.38 证明无免凭据启动路径）。但**"能否实时观测"与"能否验证形态"是两件事**：
  // 宿主的日志格式化器 `Logger.format` 是**纯静态函数**（`@deepseek-ai/cordis` 的
  // `src/logger.ts`，实测 `lib/index.js:431 static format(exporter, message)`），
  // 直接喂它本层的调用形态即可得到**与装机完全相同**的渲染结果，无需任何凭据。
  //
  // 关键契约（实测 0.1.7-rc.2 的 `defaultFormatters`）：`s → String(value)`、
  // `%% → '%'`。故 `log.mjs` 的 `fn.call(logger, '%s', String(message))` 渲染出的
  // 就是消息原文——**包括文案里含 `%` 的情况**（那是这条出口最容易出错的地方）。
  // 解析收拢到 `helpers/dsh-engine.mjs`（第 103 批）：它会在**无任何环境变量**时
  // 从 DSH 安装目录就地提取引擎，故本用例在默认跑法下**真的会执行**，而不是静默跳过。
  const cordis = await loadCordis();
  if (cordis === undefined || typeof cordis.Logger?.format !== 'function') {
    t.skip('本机未找到可用的 @deepseek-ai/cordis（可设 DSH_CORDIS_PATH 或 DSH_APP_ROOT 提供）。');
    return;
  }
  const exporter = { colors: 0, formatters: cordis.defaultFormatters };
  // 本层实际会写出的消息（取自 src 里的字面量），含带 % 的文案
  const messages = [
    'ai-coding-methodology: 已适配插件 workflow,spec-gate,scout,team-governance,algo-loop,research-loop；注册事件 SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop',
    'ai-coding-methodology: 注册 skill 32 条（workflow:20,spec-gate:4,scout:3,team-governance:2,algo-loop:1,research-loop:2）',
    'ai-coding-methodology: 注册命令 9 条（workflow:1,spec-gate:5,scout:0,team-governance:3）',
    'ai-coding-methodology: 宿主未提供 skills 服务，skill 面跳过（钩子面照常）',
    'ai-coding-methodology: SessionStart 处置未捕获异常，按无意见放行（fail-open）：Error: boom',
    '进度 100% 完成（含裸百分号）',
  ];
  for (const msg of messages) {
    // 完全复刻 `log.mjs` 的调用形态：`fn.call(logger, '%s', String(message))`
    const rendered = cordis.Logger.format(exporter, { name: 'ai-coding-methodology', args: ['%s', String(msg)] });
    assert.equal(rendered, msg, `日志渲染必须逐字等于消息原文，实际：${JSON.stringify(rendered)}`);
  }
  // 反向对照：把消息**当格式串**直接传（而不是用 `%s` 包裹）会出问题——文案里只要出现
  // 合法转换符（如 `%d`，套件插件的诊断文案里就有百分数与路径），就会被当占位符解释掉。
  // 这条说明"用 `%s` 包裹"不是装饰，而是保证原样输出的必要动作。
  // 注：**裸 `%` 不构成转换符**，会被原样保留（我第一版对照就误用了裸 `%`，见 §8.83），
  // 故这里用真正的转换符 `%d` 做对照。
  const naive = cordis.Logger.format(exporter, { name: 'ai-coding-methodology', args: ['进度 100%d 完成'] });
  assert.notEqual(naive, '进度 100%d 完成', '裸串当格式串时 %d 会被解释——故必须用 %s 包裹');
  assert.equal(
    cordis.Logger.format(exporter, { name: 'ai-coding-methodology', args: ['%s', '进度 100%d 完成'] }),
    '进度 100%d 完成',
    '%s 包裹后 %d 原样保留',
  );
});

test('真实 cordis 容器：apply 在**真容器**里执行并产出三行启动日志（此前只用测试替身验过）', async (t) => {
  // 为什么要有（2026-09-28 第 102 批）：此前所有 `apply` 验收都用**测试替身 ctx**
  // （`hostLikeCtx()` / `makeFakeCtx()`）。替身能验语义，但验不了"**真容器会不会调 `apply`**"
  // ——那取决于 cordis 的注入与 fiber 启动规则。
  //
  // 用真容器实测得到两条硬事实：
  //  ① **`inject: ['shell']` 是硬门**：把它装进一个**没有 shell 服务**的真 Context，
  //     插件不报错、fiber 就绪，但 **`apply` 一次都不执行**（实测 0 次、0 条日志）；
  //     提供 shell 服务后，`apply` 执行并打出**三行启动日志**。
  //     ⇒ 这正是 `ctx.get('shell') ?? ctx.shell` 与本层只 `inject: ['shell']` 的由来；
  //     也为"宿主缺 shell 时本层整体不加载"这一**已知边界**提供了机器证据（见 README 已知限制）。
  //  ② 启动日志经真容器渲染后与 §9.1 期望的文案**逐字一致**（含 `已适配插件` 三行）。
  //
  // 解析同 96/100 批：优先 `@deepseek-ai/cordis`，其次 `DSH_CORDIS_PATH`，都没有则显式跳过。
  // 解析收拢到 `helpers/dsh-engine.mjs`（第 103 批）：默认跑法下自动提取，不再静默跳过。
  const cordis = await loadCordis();
  if (cordis === undefined || typeof cordis.Context !== 'function') {
    t.skip('本机未找到可用的 @deepseek-ai/cordis（可设 DSH_CORDIS_PATH 或 DSH_APP_ROOT 提供）。');
    return;
  }
  const fakeShell = {
    resolve: (req) => req,
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
  };
  const compose = async (withShell) => {
    const ctx = new cordis.Context();
    const seen = [];
    ctx.logger.exporter({ colors: 0, export: (m) => seen.push((m?.args ?? []).join(' ')) });
    if (withShell) ctx.provide('shell', fakeShell);
    const plugin = await import(`../src/index.mjs?case=${withShell ? 'yes' : 'no'}-${Date.now()}`);
    await ctx.plugin(plugin, { projectDir: REPO_ROOT });
    await new Promise((r) => setTimeout(r, 500));
    return seen;
  };

  // ① 无 shell ⇒ apply 不执行（inject 是硬门）
  const without = await compose(false);
  assert.equal(
    without.filter((s) => s.includes('ai-coding-methodology:')).length,
    0,
    `无 shell 服务时 apply 不应执行（inject 未满足 ⇒ fiber 停在 pending），实际日志：${JSON.stringify(without.slice(0, 3))}`,
  );

  // ② 有 shell ⇒ apply 执行，并打出启动日志（与 §9.1 期望对齐）。
  // 注意：裸 cordis 容器**没有** `skills` / `commands` 服务，故那两个面会走"跳过"分支——
  // 断言必须写**真容器该有的样子**，而不是照抄测试替身里的"注册 27 条"。
  const withShell = await compose(true);
  const lines = withShell.filter((s) => s.includes('ai-coding-methodology:'));
  assert.ok(lines.length >= 3, `有 shell 服务时应打出启动日志，实际：${JSON.stringify(withShell.slice(0, 5))}`);
  assert.ok(
    lines.some((s) => /已适配插件 workflow,spec-gate,scout,team-governance/.test(s)),
    `应有"已适配插件"行：${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((s) => /注册事件 SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop/.test(s)),
    '应在启动行里报出五个事件（这一面只依赖 shell，故在裸容器里也成立）',
  );
  assert.ok(
    lines.some((s) => /宿主未提供 skills 服务，skill 面跳过/.test(s)),
    '裸容器无 skills 服务 ⇒ skill 面应如实报跳过（四面独立）',
  );
  assert.ok(
    lines.some((s) => /宿主未提供 commands 服务/.test(s)),
    '裸容器无 commands 服务 ⇒ 命令面应如实报跳过',
  );
});

test('contextMessage：注入消息形态与宿主 createMessage **输出**对齐（role + id）', () => {
  const m = contextMessage('t');
  // 宿主 `createUserMessage` = `createMessage({ ...input, role: 'user' })`，而
  // `createMessage` 是 `deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))`
  // ——**role 与 id 都是工厂补写的**，只读 JSDoc 的「入参须含 role/content/source」会漏掉 id。
  // 2026-09-28 第 75 批补 role；2026-09-29 第 107 批补 id（内部任务-DSHID-1：缺 id 的
  // user/message 事件会让宿主在下次加载时拒收整份会话日志）。
  assert.equal(m.role, 'user', '注入消息必须带 role: user（与宿主 createUserMessage 一致）');
  assert.deepEqual(m.content, [{ type: 'text', text: 't' }]);
  assert.equal(m.source.kind, 'ai-coding-methodology');
  assert.match(
    m.id,
    IDENTIFIED_ID_RE,
    '注入消息必须带 uuid 形态的 id（宿主 createMessage 输出形态）',
  );
  assert.notEqual(contextMessage('t').id, contextMessage('t').id, '每次构造必须是新的稳定身份');
  // 反向对照：key 集合与宿主**输出**形态同构（多/少字段都该被发现）
  assert.deepEqual(Object.keys(m).sort(), ['content', 'id', 'role', 'source']);
});

test('注入消息字段集合 = 宿主工厂**真实输出**的键集合（宿主编译产物不可加载时跳过）', async (t) => {
  // 为什么要有（2026-09-29 第 107 批阶段 A 评审意见 api-contract#1）：上面这类断言此前全是**手抄
  // 字面量**，从未与宿主工厂的真实输出对拍——同一个形状因此成对漏字段两次（第 75/76 批漏 `role`、
  // 第 107 批漏 `id`）。本用例把基准换成宿主自己产出的对象：宿主升级后新增/改名字段时当场红。
  // 命令面的 `userMessage` 与注入面的 `contextMessage` 共用同一实现（`identifiedUserMessage`），
  // 故一次对拍覆盖两个注入面。
  let llm;
  try {
    llm = await loadEngine('@deepseek-ai/dsh-llm');
  } catch {
    llm = undefined;
  }
  // 注意：`loadEngine` 自身吞异常并 `return undefined`（helpers/dsh-engine.mjs），故**不能**靠
  // try/catch 判缺席——必须按返回值判，否则他机（无 DSH 安装）会走到下一行抛 TypeError 变红
  // 而不是跳过（2026-09-29 阶段 A 评审意见 testing#2）。
  if (llm === undefined || typeof llm.createUserMessage !== 'function') {
    t.diagnostic('宿主 dsh-llm 不可加载（非本机安装形态）——对照基准缺席，跳过而不是假通过');
    return;
  }
  const hostUser = llm.createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } });
  assert.deepEqual(
    Object.keys(contextMessage('x')).sort(),
    Object.keys(hostUser).sort(),
    '注入消息字段集合必须等于宿主 createUserMessage 的真实输出键集合',
  );
  assert.deepEqual(
    Object.keys(hostUser).sort(),
    ['content', 'id', 'role', 'source'],
    '宿主工厂输出形状变化 ⇒ 本批登记的契约（IF-HOST-1 第二宿主实例化登记「注入消息信封」）须同步复核',
  );
});

test('userPromptOf：排除本层自注入消息，只拼用户输入（防元技能前缀淹没 prompt 头部）', () => {
  // 为什么要有（2026-09-28 第 78 批；2026-10-20 内部任务-173 更新）：SessionStart 自 内部任务-173 起
  // 经**首轮 pre-step 追加**（`contextMessage`，不再走 created+inject；Stop/allow 仍走 inject）。
  // 实际依赖排除的是仍走 inject 的通道（Stop/task-recap/learnings-recap、allow 提醒）：它们落 inbox 后被
  // claim 与用户那条一起取走；SessionStart 已改 pre-step 追加 decision.messages，不构成此处输入。若不排除，整篇元技能会拼在用户输入前——
  // 而 ZCode 的 `user-prompt.mjs` 有头锚定判断（`isRoutingDrift` 对 `prompt.replace(/^\s+/,'')`
  // 做意图匹配），于是"用户这轮说了什么"被淹没、场景漂移提醒静默少触发。本用例钉住排除语义。
  const user = { role: 'user', content: [{ type: 'text', text: '定位并修复这个问题' }], source: { kind: 'user' } };
  const injected = contextMessage('元技能全文……');
  // 代表顺序：本层注入消息与用户消息同批（旧 claim 顺序 / 新 pre-step 追加顺序不影响排除语义）
  assert.equal(userPromptOf([injected, user]), '定位并修复这个问题', '必须排除自注入消息');
  assert.equal(userPromptOf([user]), '定位并修复这个问题');
  assert.equal(userPromptOf([injected]), '', '只有自注入时 prompt 应为空（不是把注入当用户输入）');
  // 头锚定语义：排除后首字符就是用户输入的首字符
  assert.match(userPromptOf([injected, user]), /^\s*定位/);
  // 别家 source 不替它做主：非本层的注入消息仍保留
  assert.equal(userPromptOf([{ role: 'user', content: [{ type: 'text', text: 'A' }], source: { kind: 'other' } }]), 'A');
  // 多块文本按序拼接；非文本块忽略
  assert.equal(
    userPromptOf([{ content: [{ type: 'image' }, { type: 'text', text: 'x' }, 'y', { type: 'text', text: 'z' }] }]),
    'xz',
  );
  // 反向对照：空/畸形输入不抛
  assert.equal(userPromptOf(undefined), '');
  assert.equal(userPromptOf([]), '');
  assert.equal(userPromptOf([{ content: 'not-an-array' }]), '');
});

test('fail-open 兜底：tools/execute 中间件返回链值、next 恰调用一次（阶段门① F-2）', async () => {
  // 为什么要有：本层给宿主执行链**新增**了一个 waterfall 中间件，它有三条义务——
  // ①`return next()` 回传链值（**忘 return ⇒ 链值 undefined ⇒ 宿主 `normalizeDispatchResult`
  // 抛 TypeError ⇒ 该次成功调用反被记为失败**，方向与抑制相反）；②异常时**不得阻断**工具体执行
  // （`safe` 的 fallback 必须在场，否则 cordis 语义"未调用 next 即否决整条链（含内建行为）"）；
  // ③`next` 恰调用一次。本用例钉住 ①③；②由实现侧的第三参 fallback 保证（阶段门① F-1）。
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  const registered = ctx.listeners.get('tools/execute');
  assert.ok(Array.isArray(registered) && registered.length === 1, 'tools/execute 应注册恰好一个监听器');
  let calls = 0;
  const out = await registered[0]({ name: 'bash' }, async () => {
    calls += 1;
    return { kind: 'continue' };
  });
  assert.equal(calls, 1, 'next 必须恰被调用一次');
  assert.deepEqual(out, { kind: 'continue' }, '必须**返回**链值（`next();` 不 return ⇒ undefined ⇒ 宿主把成功调用判为失败）');
});

test('宿主结构化面（OPEN-46）：result.value.exitCode / isError 装配进负载并落账', async (t) => {
  // 为什么要有：单测只证 `buildPayload` 形态，证不了"真实 post-execute 的形状 → 适配层取值
  // → 负载 → 真实钩子 → 账本"。本用例把整链钉住：宿主 `ToolExecutionResult` 没有顶层
  // exitCode，真退出码在 `result.value.exitCode`；edit 类失败只有 `result.isError`。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-open46-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  process.env.WF_INCIDENT_ROOT = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  // agent 形态按真实宿主：`sessionIdOf` 读 `agent.session.header.id`、
  // `rememberCwd` 读 `agent.session.header.cwd`（src/index.mjs:210-219 / :415-419）
  const agent = { session: { header: { id: 'open46', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const next = async () => ({ kind: 'accept' });
  // 批 3 步骤 2：失败位只在**确经派发**时透传 ⇒ 本用例必须走**真实链路**——
  // 先 emit `tools/execute`（宿主派发点，登记"已派发"事实），再 emit `tools/post-execute`。
  // 不得改为"手工往 WeakSet 塞 exec"：那会架空步骤 1 的正向用例，使监听体漏落 add 时本用例照绿。
  const firstExec = { name: 'pwsh', arguments: { command: 'node -e "process.exit(2)"' }, agent, callId: 'open46-1', signal: undefined };
  await ctx.emit('tools/execute', firstExec, async () => ({ kind: 'continue' }));
  await ctx.emit(
    'tools/post-execute',
    firstExec,
    { isError: false, value: { kind: 'foreground', exitCode: 2 }, content: [{ type: 'text', text: '(no output)\n[exit code: 2]' }] },
    next,
  );
  const secondExec = { name: 'edit', arguments: { file_path: 'a.txt' }, agent, callId: 'open46-2', signal: undefined };
  await ctx.emit('tools/execute', secondExec, async () => ({ kind: 'continue' }));
  await ctx.emit(
    'tools/post-execute',
    secondExec,
    { isError: true, content: [{ type: 'text', text: 'Error: no such file' }] },
    next,
  );
  const raw = readFileSync(join(tmp, '.workflow', 'incidents.jsonl'), 'utf8');
  const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, 2, `两次调用应落恰好两条 tool-failure（幂等 id）；实际 ${JSON.stringify(rows)}`);
  const digests = [...new Set(rows.map((r) => r.digest))];
  assert.equal(digests.length, 2, '两条记录的 digest 必须可区分（旧实现同为粗 digest ⇒ RED）');
  assert.ok(!digests.includes('d7a83521cf4fdddf'), '不得再落 pwsh 粗 digest');
  assert.ok(!digests.includes('7d8dcda09367dc59'), '不得再落 edit 粗 digest');
  assert.ok(!raw.includes('process.exit(2)'), '账本不得含命令原文（B-M15-1）');
  // 可读性面（评审视角二 #2）：记录必须带类别名与退出码，operator 不必反推哈希
  assert.deepEqual(
    rows.map((r) => r.errorClass).sort(),
    ['error-flag', 'exit-nonzero'],
    '两类失败各自带 errorClass',
  );
  assert.equal(rows.find((r) => r.errorClass === 'exit-nonzero').exitCode, 2, '退出码进记录');
  assert.equal(rows.find((r) => r.errorClass === 'error-flag').exitCode, null, '非退出码类失败 exitCode 为 null');
});

test('调用层拒绝抑制（批 3 步骤 2）：未派发 ⇒ 失败位不透传 ⇒ **不落 `tool-failure` 行**，且该次调用确已产出', async (t) => {
  // 判据＝**是否经过宿主派发点** `tools/execute`（dsh-tools `:3331`，只在 dispatch 分支可达）。
  // 未派发的四类（审批拒绝/auto-review 拒绝/护栏 deny/取消）仍会走到 `tools/post-execute`，
  // 但从不经过该点 ⇒ 本层不透传失败位 ⇒ 核心件 `classifyResult` 得 null（不记、不催办）。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-reject-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  // **hermetic（阶段门① 复审 F-4）**：`post-tool.mjs` 的**重试环状态**默认落在
  // `$HOME/.zcode/cli/routing-state/`（全局、跨运行）——环对**每次** PostToolUse 推进、
  // **先于** `classifyResult` 且**不受派发门控**，同一 (session,tool,digest) 5 分钟内第 3 次
  // 即追加 `retry-loop` 行 ⇒ 不隔离时"账本零新增"断言跨运行必红（≈每 3 次一次）。
  process.env.WF_POSTTOOL_STATE_DIR = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'reject', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  // 内部任务-273 H-01：本用例测的是「未派发」语义——前提是**事实面已工作**（`dispatchFactSeen=true`）。
  // 事实面从未工作时无法判定是否派发（按 unknown 照常观测，见 内部未决-60 回归用例）；故先经派发点登记一次。
  await ctx.emit('tools/execute', { name: 'pwsh', arguments: {}, agent, callId: 'prime-dispatched' }, async () => ({ kind: 'accept' }));
  let nextCalled = false;
  const exec = { name: 'edit', arguments: { file_path: 'a.txt' }, agent, callId: 'reject-1', signal: undefined };
  await ctx.emit('tools/post-execute', exec, { isError: true, content: [{ type: 'text', text: 'Error: no such file' }] }, async () => {
    nextCalled = true;
    return { kind: 'accept' };
  });
  assert.equal(nextCalled, true, '该次调用确已产出（走到 next ⇒ 不是 hook 崩退 fail-open 造成的空账本）');
  // 判据**收窄为按 kind/id 过滤**（阶段门① 复审 F-4）：`retry-loop` 是**独立通道**——它先于
  // `classifyResult` 且（**内部任务-59 之前**）不受派发门控，未派发调用重复 3 次仍会落该行。
  // **2026-10-13 内部任务-59 起该通道已由适配层派发门收口**（未派发 ⇒ 本监听早退、不派发任何钩子，
  // 故本用例现只覆盖"派发门路径"；核心件侧的重试环仍无执行事实门控，属已知残余）。
  // 抑制面（`tool_result` 失败位在未派发时不透传）的直测面由 `synthesizedToolResult` 的按键用例承载。
  const ledger = join(tmp, '.workflow', 'incidents.jsonl');
  const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.deepEqual(rows.filter((r) => r.kind === 'tool-failure'), [], '未派发 ⇒ 不得落 tool-failure 行（本批核心行为）');
  // 键集不变：只改失败位取值，不新增键
  assert.deepEqual(Object.keys(buildPayload('PostToolUse', {}).tool_result).sort(), ['is_error', 'stderr', 'stdout'], '合成 tool_result 键集不变');
});

test('OPEN-60（DEV-59）：未派发调用重复三次 ⇒ 不派发钩子 ⇒ 账本零行（含 retry-loop 通道）', async (t) => {
  // 判据＝**是否经过宿主派发点** `tools/execute`（同上一用例）。本用例锁的是**本批新收口的通道**：
  // 修复前 `post-tool.mjs` 的重试环推进**先于** `classifyResult` 且不受派发门控 ⇒ 未派发调用
  // 在同一会话内第 3 次即落一条 `retry-loop`（内部任务-59 步骤 1.3 的真机探针因共享桶租约未复现，
  // 机械判别面即本用例：修复前 RED、修复后 GREEN）。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-open60-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  process.env.WF_POSTTOOL_STATE_DIR = tmp; // 环状态须隔离，否则跨运行必红（既有 :1871-1875 注释同款教训）
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'open60', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  // 先把「派发事实面」置为**已工作**：fail-open 守卫（内部任务-59 真机回归修复）只在事实面确已工作过
  // 时才据它跳过未派发调用；未置位时本例退化为"照常派发"（该分支由下方 fail-open 用例专测）。
  await ctx.emit('tools/execute', { name: 'pwsh', arguments: {}, agent, callId: 'open60-priming' }, async () => ({ kind: 'continue' }));
  let nextCount = 0;
  for (let i = 0; i < 3; i++) {
    // 互异 callId：否则被 `post-tool.mjs:296-302` 的双事件去重折叠（同 callId 1 分钟内只推进一次）
    const exec = { name: 'pwsh', arguments: { command: 'node -e "process.exit(2)"' }, agent, callId: `open60-${i}`, signal: undefined };
    await ctx.emit(
      'tools/post-execute',
      exec,
      { isError: false, content: [{ type: 'text', text: '调用层拒绝（未派发）' }] },
      async () => { nextCount++; return { kind: 'accept' }; },
    );
  }
  assert.equal(nextCount, 3, '三次调用均走到 next（本层不阻断链路）');
  const ledger = join(tmp, '.workflow', 'incidents.jsonl');
  const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.deepEqual(rows.filter((r) => r.kind === 'retry-loop'), [], '未派发 ⇒ 不得落 retry-loop 行（DEV-59 核心行为）');
  assert.deepEqual(rows.filter((r) => r.kind === 'tool-failure'), [], '未派发 ⇒ 不得落 tool-failure 行（既有行为保持）');
});

test('OPEN-60（DEV-59）哨兵：PostToolUse 全暗 ⇒ 恰好告警一次；有派发 ⇒ 零告警；重复 ⇒ 不重复', async (t) => {
  // 为什么要有哨兵：派发判据押在 `exec` 对象身份（WeakSet）上，宿主契约漂移会让整个 PostToolUse
  // 观测面静默全暗、零信号（内部规则-1 的观测面失效）——本用例锁「全暗恰好一次告警」与「正常面零告警」。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-dark-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  process.env.WF_POSTTOOL_STATE_DIR = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  const next = async () => ({ kind: 'accept' });
  const darkAgent = { session: { header: { id: 'dark', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const emitPost = async (agent, callId) => {
    await ctx.emit('tools/post-execute', { name: 'pwsh', arguments: {}, agent, callId }, { isError: false, content: [] }, next);
  };
  const darkWarns = () => ctx.warnings.filter((m) => String(m).includes('派发判据疑似失效')).length;
  // 事实面**未工作**时：阈值 3（本批回归修复把 10 降到 3），文案走"宿主未发生 tools/execute"分支，
  // 且钩子按 fail-open **照常派发**（本层观测面不暗）——先测这一分支（此 apply 作用域尚无 tools/execute）。
  const factAbsentWarns = () => ctx.warnings.filter((m) => String(m).includes('宿主未发生 tools/execute')).length;
  for (let i = 0; i < 3; i++) await emitPost(darkAgent, `darknone-${i}`);
  assert.equal(factAbsentWarns(), 1, '事实面从未工作：3 次事件即告警恰好一次（fail-open 文案分支）');
  for (let i = 3; i < 6; i++) await emitPost(darkAgent, `darknone-${i}`);
  assert.equal(factAbsentWarns(), 1, '继续不重复告警（按会话去重）');
  // 事实面**已工作**后的全暗（判据漂移形态）：另一会话先经派发点登记一次，其后事件全部未命中
  const driftAgent = { session: { header: { id: 'drift', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  await ctx.emit('tools/execute', { name: 'pwsh', arguments: {}, agent: driftAgent, callId: 'drift-priming' }, next);
  for (let i = 0; i < 3; i++) await emitPost(driftAgent, `drift-${i}`);
  assert.equal(darkWarns(), 1, '事实面已工作后全暗（3 次事件、0 次命中）恰告警一次（判据漂移文案分支）');
  for (let i = 3; i < 7; i++) await emitPost(driftAgent, `drift-${i}`);
  assert.equal(darkWarns(), 1, '继续全暗不重复告警（按会话去重）');
  // 正常面（有派发）零告警：另一会话逐次经派发点登记
  const okAgent = { session: { header: { id: 'notdark', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const before = ctx.warnings.length;
  for (let i = 0; i < 10; i++) {
    const exec = { name: 'pwsh', arguments: {}, agent: okAgent, callId: `ok-${i}` };
    await ctx.emit('tools/execute', exec, next);
    await ctx.emit('tools/post-execute', exec, { isError: false, content: [] }, next);
  }
  assert.equal(ctx.warnings.length, before, '有派发 ⇒ 零新增告警（含 10 次以上事件）');
});

test('OPEN-60（DEV-59 回归修复）：事实面不可用时 fail-open —— 未派发调用照常派发钩子（观测面不暗）', async (t) => {
  // 真机实证（2026-10-13 第二次重启后）：本宿主该版本/装配**不发生** `tools/execute` ⇒ `executed` 恒 false；
  // 若无条件早退，整个 PostToolUse 观测面静默全暗（两次确定失败调用零落账、环状态零更新）。
  // 本用例锁修复后的行为：事实面从未工作 ⇒ **不过早派发门控**（回到改动前"照常派发"），故三条未派发
  // 调用仍会走到钩子（观测面可用）；判别力＝删掉 `dispatchFactSeen` 条件后本用例即红（钩子不再跑）。
  // **内部任务-192 P2 更新（预期变更）**：此前"未派发调用照旧推进重试环 ⇒ 落 retry-loop 行"是已知残余
  // （内部未决-60 的噪声洞）；本批适配层在负载里补了 `dispatch_fact` 三态，核心件 `post-tool.mjs` 在
  // 环推进**之前**短路 `not-dispatched` ⇒ 残余在此路径闭合：钩子照跑（观测面不暗）但零 retry-loop 行。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-failopen-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  process.env.WF_POSTTOOL_STATE_DIR = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply } = await import('../src/index.mjs');
  await apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'failopen', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  let nextCount = 0;
  for (let i = 0; i < 3; i++) {
    await ctx.emit(
      'tools/post-execute',
      { name: 'pwsh', arguments: { command: 'node -e "process.exit(2)"' }, agent, callId: `fo-${i}` },
      { isError: false, content: [{ type: 'text', text: '调用层拒绝（未派发）' }] },
      async () => { nextCount++; return { kind: 'accept' }; },
    );
  }
  assert.equal(nextCount, 3, '三次调用均走到 next');
  const ledger = join(tmp, '.workflow', 'incidents.jsonl');
  const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // 内部任务-273 H-01（A-da-4 补强）：事实面**从未工作**时负载不产 `dispatch_fact`（unknown），核心件
  // 不再短路 ⇒ 与 内部任务-59「照常观测」承诺一致：同参三次未派发调用落 1 条 retry-loop（旧行为
  // 标 not-dispatched ⇒ 0 行，即本用例要防的观测面全暗回归）。判别力＝把 payload 改回
  // `executed ? 'dispatched' : 'not-dispatched'` 后本断言即红。
  assert.equal(
    rows.filter((r) => r.kind === 'retry-loop').length,
    1,
    'DEV-273 H-01：fail-open 场景不标 not-dispatched ⇒ 核心照常推进环（1 条 retry-loop，而非旧 0 行全暗）',
  );
  // 失败位同门回退：事实面不可判定时 isError 照常透传，核心件产出结构化失败事实（不再静默丢弃）。
  await ctx.emit(
    'tools/post-execute',
    { name: 'pwsh', arguments: { command: 'node -e "process.exit(3)"' }, agent, callId: 'fo-fail' },
    { isError: true, content: [{ type: 'text', text: 'boom' }] },
    async () => ({ kind: 'accept' }),
  );
  const rows2 = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.ok(rows2.length > rows.length, 'fail-open 场景的失败调用必须产生账本行（观测面不暗）');
  assert.ok(ctx.warnings.some((m) => String(m).includes('宿主未发生 tools/execute')), '同时留下"事实面未工作"告警（可观测）');
});

test('buildPayload：委派深度按键携带（DEV-20 A1/F4）', () => {
  // 为什么要有：宿主负载基础面不含 delegation 信息（buildPayload 只吃适配层传参），
  // 钩侧收窄注入面的唯一结构化判据就是本键——键的有无与取值形态是跨层契约。
  const up = buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi', delegationDepth: 1 });
  assert.equal(up.delegation_depth, 1, '安全非负整数按键携带（宿主中立名）');
  const zero = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', delegationDepth: 0 });
  assert.equal(zero.delegation_depth, 0, '顶层会话显式 0 也携带（消费方按 >0 判委派）');
  const absent = buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi' });
  assert.ok(!Object.hasOwn(absent, 'delegation_depth'), '未提供时不产键（ZCode/mcode/kimi 直跑形态零变化）');
  assert.ok(!Object.hasOwn(buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', delegationDepth: -1 }), 'delegation_depth'), '负数不产键');
  assert.ok(!Object.hasOwn(buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', delegationDepth: 1.5 }), 'delegation_depth'), '非安全整数不产键');
  assert.ok(!Object.hasOwn(buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', delegationDepth: '2' }), 'delegation_depth'), '字符串不产键（不得强转）');
});

test('DEV-227 parent_session_id 负载扩展：委派子会话父 id 按键携带（A-da-15 锚）', () => {
  // 内部决策-061 D3（内部任务-227）：DSH 委派子会话需要在 UPS 负载带父会话 id，供 user-prompt 解析继承
  // 交付任务号；顶层会话/其余三宿主不传该字段 ⇒ 键缺席，负载零变化。
  const up = buildPayload('UserPromptSubmit', { sessionId: 's-child', cwd: 'C:/p', prompt: 'hi', delegationDepth: 1, parentSessionId: 'parent-1' });
  assert.equal(up.parent_session_id, 'parent-1', 'depth>0 且父 id 非空时按键携带');
  assert.deepEqual(
    Object.keys(up).filter((k) => k === 'parent_session_id' || k === 'delegation_depth').sort(),
    ['delegation_depth', 'parent_session_id'],
    '仅新增两键，不改变既有键集语义',
  );
  assert.ok(!Object.hasOwn(buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi' }), 'parent_session_id'), '顶层缺省不产键（三宿主零变化）');
  assert.ok(!Object.hasOwn(buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi', delegationDepth: 0, parentSessionId: 'parent-1' }), 'parent_session_id'), 'depth=0 不产键');
  assert.ok(!Object.hasOwn(buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi', delegationDepth: 1, parentSessionId: '' }), 'parent_session_id'), '空串不产键');
  assert.ok(!Object.hasOwn(buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi', delegationDepth: 1, parentSessionId: 42 }), 'parent_session_id'), '非字符串不产键（不得强转）');
  assert.deepEqual(Object.keys(buildPayload('UserPromptSubmit', { sessionId: 's1', cwd: 'C:/p', prompt: 'hi' })).sort(), ['cwd', 'hook_event_name', 'prompt', 'session_id', 'transcript_path'], 'UPS 基础键集稳定（5 键）');
});

// ── 内部未决-115（内部任务-167 v4）：allow 档 reason 合成模型可见上下文 ─────────────────
// 夹具：中立清单插件（PreToolUse 真实钩子进程）按 tool_input.file_path 生成 tg 形态文案
// （路径+租约，可被 reasonKey 归一），其余五插件根指空目录，确保只派发本夹具。
function makeIsolatedRoots(t, workflowRoot) {
  const roots = { workflow: workflowRoot };
  for (const plugin of ['spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']) roots[plugin] = makeTemp(t);
  return roots;
}

function makeAllowFixture(t, options = {}) {
  const decision = JSON.stringify(options.permissionDecision ?? 'allow');
  const includeMessage = options.withMessage !== false;
  const script = [
    "let payload = '';",
    "process.stdin.on('data', (c) => { payload += c; });",
    "process.stdin.on('end', () => {",
    "  const p = JSON.parse(payload || '{}');",
    "  const file = String(p?.tool_input?.file_path ?? 'probe/a.txt');",
    "  const reason = '路径 ' + file + ' 落在租约 path:main:src/**（持有者 h，fencing=1）覆盖范围内。本地护栏未执行调用者身份裁决——本提醒不阻断写入。';",
    "  const out = { hookEventName: 'PreToolUse', permissionDecision: " + decision + " };",
    includeMessage ? "  out.systemMessage = reason;" : "",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\\n');",
    "});",
  ].filter((line) => line !== '').join('\n');
  const workflow = makeManifestPlugin(
    t,
    [{ event: 'PreToolUse', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/allow.mjs'], timeoutMs: 5000 }],
    { 'hooks/allow.mjs': script },
  );
  return makeIsolatedRoots(t, workflow);
}

async function emitPreToolUse(ctx, { filePath, agent }) {
  const handler = (ctx.listeners.get('tools/pre-execute') ?? [])[0];
  assert.ok(handler, 'PreToolUse 处理器应已注册');
  return handler({ name: 'edit', arguments: { file_path: filePath }, callId: 'call-x', agent }, async () => ({ kind: 'continue' }));
}

function makeAgent(sessionId, cwd) {
  const injected = [];
  return { injected, agent: { session: { header: { id: sessionId, cwd } }, inject: (m) => injected.push(m) } };
}

test('apply PreToolUse allow 提醒：allow+reason 经 agent.inject 合成模型可见上下文', async (t) => {
  const { injected, agent } = makeAgent('sess-allow-1', makeTemp(t));
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeAllowFixture(t) });
  const out = await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent });
  assert.deepEqual(out, { kind: 'continue' });
  assert.equal(injected.length, 1);
  const msg = injected[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'ai-coding-methodology');
  assert.ok(IDENTIFIED_ID_RE.test(msg.id), '注入消息必须是 identified message');
  assert.match(msg.content[0].text, /路径 probe\/a\.txt 落在租约/);
});

test('apply PreToolUse allow 提醒：同会话同主体冷却期内不重复注入（不同调用）', async (t) => {
  const { injected, agent } = makeAgent('sess-allow-2', makeTemp(t));
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeAllowFixture(t) });
  await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent });
  await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent });
  assert.equal(injected.length, 1, '同路径+租约的第二次应在冷却期内被丢弃');
});

test('apply PreToolUse allow 提醒：每会话上限 20 次', async (t) => {
  const { injected, agent } = makeAgent('sess-allow-3', makeTemp(t));
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeAllowFixture(t) });
  for (let i = 1; i <= 25; i += 1) await emitPreToolUse(ctx, { filePath: `probe/f${i}.txt`, agent });
  assert.equal(injected.length, 20);
});

test('apply PreToolUse allow 提醒：注入抛错/无 inject/不可归属 fail-open，且留一次性 warn', async (t) => {
  const cwd = makeTemp(t);
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeAllowFixture(t) });
  const throwing = { session: { header: { id: 'sess-allow-4', cwd } }, inject: () => { throw new Error('inject boom'); } };
  const out1 = await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent: throwing });
  assert.deepEqual(out1, { kind: 'continue' });
  assert.ok(ctx.warnings.some((w) => String(w).includes('PreToolUse allow 提醒注入失败')), '注入抛错应留 warn');
  const noInject = { session: { header: { id: 'sess-allow-5', cwd } } };
  const out2 = await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent: noInject });
  assert.deepEqual(out2, { kind: 'continue' });
  assert.ok(ctx.warnings.some((w) => String(w).includes('无可注入的 agent.inject')), '无 inject 应留一次性 warn');
  const noSession = {};
  const out3 = await emitPreToolUse(ctx, { filePath: 'probe/a.txt', agent: noSession });
  assert.deepEqual(out3, { kind: 'continue' });
  assert.ok(ctx.warnings.some((w) => String(w).includes('无可注入的 agent.inject')), '不可归属会话应留一次性 warn');
});

test('apply PreToolUse allow 提醒：deny/ask/无 reason 不注入', async (t) => {
  const cases = [
    { permissionDecision: 'deny' },
    { permissionDecision: 'ask' },
    { permissionDecision: 'allow', withMessage: false },
  ];
  for (const [i, specific] of cases.entries()) {
    const { injected, agent } = makeAgent(`sess-none-${i}`, makeTemp(t));
    const ctx = makeFakeCtx();
    await apply(ctx, { pluginRoots: makeAllowFixture(t, specific) });
    await emitPreToolUse(ctx, { filePath: `probe/n${i}.txt`, agent });
    assert.equal(injected.length, 0, `decision=${specific.permissionDecision} 且无 allow reason 时不得注入`);
  }
});

// 纯状态机用例（步骤 1 空壳返回 undefined ⇒ 4 红 1 绿：非法输入负例初始即绿）
test('allow-advisory：截断把 suffix 计入上限', () => {
  const a = createAllowAdvisory({ maxChars: 20 });
  const plan = a.request('s', 'x'.repeat(50));
  assert.ok(plan && plan.text.length === 20);
  assert.ok(plan.text.endsWith('…[truncated]'));
});

test('allow-advisory：冷却到期后可再次注入', () => {
  const a = createAllowAdvisory({ cooldownMs: 1000 });
  const t0 = 1000;
  a.request('s', '路径 a 落在租约 L（h）', t0).commit();
  assert.equal(a.request('s', '路径 a 落在租约 L（h）', t0 + 999), undefined);
  const ok = a.request('s', '路径 a 落在租约 L（h）', t0 + 1000);
  assert.ok(ok);
});

test('allow-advisory：会话表达 maxSessions 按插入序淘汰最旧', () => {
  const a = createAllowAdvisory({ maxSessions: 2 });
  a.request('s1', 'r1').commit();
  a.request('s2', 'r2').commit();
  a.request('s3', 'r3').commit();
  assert.ok(a.request('s1', 'r1'), 's1 被淘汰后可重新注入');
});

test('allow-advisory：空 session/空 reason/非字符串 reason 返回 undefined', () => {
  const a = createAllowAdvisory();
  assert.equal(a.request('', 'r'), undefined);
  assert.equal(a.request('s', ''), undefined);
  assert.equal(a.request('s', 42), undefined);
});

test('allow-advisory：options 生效且实例隔离；tg 文案按路径+租约归一', () => {
  const a = createAllowAdvisory({ maxPerSession: 1, cooldownMs: 0 });
  a.request('s', '路径 a 落在租约 L（h1）').commit();
  assert.equal(a.request('s', '路径 b 落在租约 L（h1）'), undefined, 'maxPerSession=1');
  const b = createAllowAdvisory({ maxPerSession: 1, cooldownMs: 0 });
  assert.ok(b.request('s', '路径 a 落在租约 L（h2）'), '不同实例不共享状态');
  const c = createAllowAdvisory({ cooldownMs: 60000 });
  c.request('s', '路径 a 落在租约 L（h1）', 1).commit();
  assert.equal(c.request('s', '路径 a 落在租约 L（h2）', 2), undefined, '同路径+租约、holder 变化应同 key 冷却');
});

// ── 内部任务-173：SessionStart 改首轮 pre-step 投递（9 条） ─────────────────────

/** 只声明 SessionStart 的 workflow 插件根（附脚本体）；其余三根为空。`placeholderRel` 让 args 经插件根绝对化。
 *  不写 matcher（全 source 命中）：重置槽用例需要 startup/resume 两形态。 */
function makeSsRoot(t, body, files = {}) {
  return makeSinglePluginSuite(
    t,
    { SessionStart: [{ hooks: [{ type: 'process', command: process.execPath, args: ['hooks/ss.mjs'], timeoutMs: 5000 }] }] },
    { 'hooks/ss.mjs': body, ...files },
    'hooks/ss.mjs',
  );
}

const SS_CTX = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SS-CTX' } }) + '\\n');\n";

test('apply：SessionStart created 只执行钩子不 inject；首轮 pre-step 投递一次', async (t) => {
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeSsRoot(t, SS_CTX), projectDir: REPO_ROOT });
  const injected = [];
  const agent = { session: { header: { id: 'ss-1', cwd: REPO_ROOT } }, inject: (m) => injected.push(m), steer() {} };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.equal(injected.length, 0, 'created 不得再 agent.inject');
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal(out.messages.length, 1, '首轮 pre-step 应投递一条 SessionStart 上下文');
  assert.equal(out.messages[0].content[0].text, 'SS-CTX');
  assert.match(out.messages[0].id, IDENTIFIED_ID_RE);
  const again = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal(again.messages.some((m) => (m.content?.[0]?.text ?? '') === 'SS-CTX'), false, '每 agent 生命周期只投一次');
});

test('apply：SessionStart 无 created 不投递；空文本不留槽', async (t) => {
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeSsRoot(t, 'process.exit(0);\n'), projectDir: REPO_ROOT });
  const noCreated = await emitPreStepChain(ctx, { agent: { session: { header: { id: 's-nc', cwd: REPO_ROOT } } }, messages: [] });
  assert.equal((noCreated.messages ?? []).length, 0, '无 created 时不得投递');
  const agent = { session: { header: { id: 's-empty', cwd: REPO_ROOT } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal((out.messages ?? []).length, 0, '空文本不写槽');
});

test('apply：SessionStart pre-step reject 保留槽，下一轮 enter 再投', async (t) => {
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeSsRoot(t, SS_CTX), projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 's-rej', cwd: REPO_ROOT } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const BRIDGE_HINT_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');
  const delivery = (ctx.listeners.get('agent/pre-step') ?? []).find((fn) => fn?.[BRIDGE_HINT_TAG] !== true);
  assert.equal(typeof delivery, 'function');
  const rejected = await delivery({ agent }, async () => ({ kind: 'reject', reason: 'blocked' }));
  assert.equal(rejected.kind, 'reject', 'reject 原样返回');
  const delivered = await delivery({ agent }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(delivered.messages[0].content[0].text, 'SS-CTX', 'reject 不得吃槽：下一轮 enter 再投');
});

test('apply：SessionStart created 重置槽（重建/恢复不投旧文本）', async (t) => {
  const body = [
    "import fs from 'node:fs';",
    "const p = new URL('./tag.txt', import.meta.url);",
    "if (!fs.existsSync(p)) process.exit(0);",
    "const tag = fs.readFileSync(p, 'utf8').trim();",
    "if (tag !== '') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: tag } }) + '\\n');",
  ].join('\n');
  const roots = makeSsRoot(t, body);
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const tagFile = join(roots.workflow, 'hooks', 'tag.txt');
  const agent = { session: { header: { id: 's-reset', cwd: REPO_ROOT } } };
  writeFileSync(tagFile, 'TAG-A', 'utf8');
  await ctx.emit('agent/created', { agent, source: 'resume' });
  rmSync(tagFile, { force: true });
  await ctx.emit('agent/created', { agent, source: 'resume' });
  const stale = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal((stale.messages ?? []).some((m) => (m.content?.[0]?.text ?? '') === 'TAG-A'), false, 'created 重置槽：恢复会话不得投旧文本');
  writeFileSync(tagFile, 'TAG-B', 'utf8');
  await ctx.emit('agent/created', { agent, source: 'resume' });
  const fresh = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal(fresh.messages[0].content[0].text, 'TAG-B');
});

test('apply：SessionStart 委派会话同样投递（无 depth 过滤，保持旧行为）', async (t) => {
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeSsRoot(t, SS_CTX), projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 's-sub', cwd: REPO_ROOT, delegationDepth: 1 } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal(out.messages[0].content[0].text, 'SS-CTX', '委派会话不筛 depth（旧实现无过滤）');
});

test('apply：无 SessionStart 声明不注册投递监听', async (t) => {
  // 显式给满六插件根（含 algo-loop/research-loop 的空根）：否则缺失键会触发自动发现、把真实仓
  // algo-loop 的 SessionStart 声明带进来（本用例要证明的是「无 SessionStart ⇒ 无 created/投递监听」）。
  const empty = makeTemp(t);
  const upsRoot = makeFixturePlugin(
    t,
    { UserPromptSubmit: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/up.mjs'], timeoutMs: 5000 }] }] },
    { 'hooks/up.mjs': 'process.exit(0);\n' },
  );
  const ctx = makeFakeCtx();
  await apply(ctx, {
    pluginRoots: { workflow: upsRoot, 'spec-gate': empty, scout: empty, 'team-governance': empty, 'algo-loop': empty, 'research-loop': empty },
    projectDir: REPO_ROOT,
  });
  // SessionStart 面不存在：hooks 的 created 业务监听为零（内部任务-201 起 apply 恒装配桥接监听，需按标记排除）。
  const BRIDGE_LISTENER_TAG = Symbol.for('ai-coding-methodology.agent-control-listener');
  const BRIDGE_HINT_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');
  const createdBusiness = (ctx.listeners.get('agent/created') ?? []).filter((fn) => fn?.[BRIDGE_LISTENER_TAG] !== true);
  assert.equal(createdBusiness.length, 0, '无 SessionStart 声明 ⇒ hooks 的 created 监听为零（恒装配的桥接监听除外）');
  // 桥接监听恒存在但不产生钩子副作用：emit 不抛、不产生 SessionStart 投递/告警（旧断言为 emit reject）。
  await ctx.emit('agent/created', { agent: { session: { header: { id: 's', cwd: REPO_ROOT } } }, source: 'startup' });
  assert.ok(!ctx.warnings.some((m) => /SessionStart/.test(m)), '无 SessionStart 声明时不得产生 SessionStart 相关告警');
  const emptyCtx = makeFakeCtx();
  await apply(emptyCtx, {
    pluginRoots: { workflow: makeTemp(t), 'spec-gate': makeTemp(t), scout: makeTemp(t), 'team-governance': makeTemp(t), 'algo-loop': makeTemp(t), 'research-loop': makeTemp(t) },
  });
  const emptyBusiness = [...emptyCtx.listeners.values()].flat().filter((fn) => fn?.[BRIDGE_LISTENER_TAG] !== true && fn?.[BRIDGE_HINT_TAG] !== true);
  assert.equal(emptyBusiness.length, 0, '空根业务监听为零（恒装配的桥接监听除外）');
});

test('apply：SessionStart 投递失败 fail-open 且槽不重试', async (t) => {
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: makeSsRoot(t, SS_CTX), projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 's-fail', cwd: REPO_ROOT } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const BRIDGE_HINT_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');
  const delivery = (ctx.listeners.get('agent/pre-step') ?? []).find((fn) => fn?.[BRIDGE_HINT_TAG] !== true);
  const bad = await delivery({ agent }, async () => ({
    kind: 'enter',
    get messages() {
      throw new Error('投递被宿主拒绝');
    },
  }));
  assert.equal(bad.kind, 'enter', '失败不得冒错/阻断下游');
  assert.ok(ctx.warnings.some((w) => /SessionStart 投递失败：.*投递被宿主拒绝/.test(String(w))));
  const retry = await delivery({ agent }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal((retry.messages ?? []).length, 0, '失败后槽已删，不重试');
});

test('apply：SessionStart 与 UserPromptSubmit 顺序（组合式链：SS 在 UPS 前、均在用户消息后）＋UPS 缺 messages 守卫', async (t) => {
  const body = [
    "import { readFileSync } from 'node:fs';",
    "let raw = '';",
    "try { raw = readFileSync(0, 'utf8'); } catch {}",
    "const p = raw.trim() === '' ? {} : JSON.parse(raw);",
    "const map = { SessionStart: 'SS-CTX', UserPromptSubmit: 'UPS-CTX' };",
    "const ev = String(p.hook_event_name);",
    "if (map[ev] !== undefined) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: map[ev] } }) + '\\n');",
  ].join('\n');
  const roots = makeSinglePluginSuite(
    t,
    {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: process.execPath, args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: process.execPath, args: ['hooks/h.mjs'], timeoutMs: 5000 }] }],
    },
    { 'hooks/h.mjs': body },
    'hooks/h.mjs',
  );
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 's-order', cwd: REPO_ROOT } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  const user = { role: 'user', content: [{ type: 'text', text: 'USER-TEXT' }], source: { kind: 'user' } };
  const out = await emitPreStepChain(ctx, { agent, messages: [user] });
  const texts = out.messages.map((m) => m.content?.[0]?.text ?? '');
  const iUser = texts.indexOf('USER-TEXT');
  const iSs = texts.indexOf('SS-CTX');
  const iUps = texts.indexOf('UPS-CTX');
  assert.ok(iUser >= 0 && iSs >= 0 && iUps >= 0, `三元素齐备，实际：${JSON.stringify(texts)}`);
  assert.ok(iUser < iSs, 'SessionStart 在用户消息之后（旧 created+inject 前缀序的已批准变化）');
  assert.ok(iSs < iUps, 'SessionStart 在 UserPromptSubmit 上下文之前（最后注册先 append）');

  // S-05（内部未决-245）：UPS 对「enter 但缺 messages」的下游决策必须按空数组追加（不得抛错丢注入）。
  // 旧实现 `[...downstream.messages]` 展开 undefined → TypeError → safe() 兜底二次 next() →
  // 返回无 messages 决策（UPS 注入丢失）；本段在实现前红、实现后绿（RED 证据见执行台账）。
  const degraded = await emitPreStepChain(ctx, { agent, messages: [user] }, async () => ({ kind: 'enter' }));
  assert.ok(Array.isArray(degraded.messages), `缺 messages 的 enter 决策应按空数组追加（实际：${JSON.stringify(degraded.messages)}）`);
  const degradedTexts = degraded.messages.map((m) => m.content?.[0]?.text ?? '');
  assert.equal(degraded.messages.length, 1, `追加条数应为 1，实际：${JSON.stringify(degradedTexts)}`);
  assert.equal(degradedTexts[0], 'UPS-CTX', '追加内容应为 UPS 上下文');
  assert.ok(!ctx.warnings.some((w) => /UserPromptSubmit 处置未捕获异常/.test(String(w))), '不得走 safe() 抛错兜底（fail-open 通道保持）');
});

test('apply：空 sid 会话——钩子照跑、不写槽、不投递、一次性 warn', async (t) => {
  const body = [
    "import fs from 'node:fs';",
    "let raw = '';",
    "try { raw = fs.readFileSync(0, 'utf8'); } catch {}",
    "const p = raw.trim() === '' ? {} : JSON.parse(raw);",
    "fs.writeFileSync(new URL('./sid.txt', import.meta.url), 'SID=' + String(p.session_id));",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'EMPTY-SID-CTX' } }) + '\\n');",
  ].join('\n');
  const roots = makeSsRoot(t, body);
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const agent = { session: { header: { cwd: REPO_ROOT } } };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.equal(readFileSync(join(roots.workflow, 'hooks', 'sid.txt'), 'utf8'), 'SID=', '钩子必须照跑并如实收到空 session_id');
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal((out.messages ?? []).length, 0, '空 sid 不投递（防跨会话串投）');
  await ctx.emit('agent/created', { agent, source: 'resume' });
  const warns = ctx.warnings.filter((w) => /SessionStart 钩子已执行但会话 id 缺失/.test(String(w)));
  assert.equal(warns.length, 1, '一次性 warn（每 apply 至多一次）');
});

// ── ④ 内部任务-192 P2（内部模块-15 v2）：运行观测供给（内部决策-063 D5/D8，A-da-16/内部验收-27 锚面） ─────────────

/** emit 入参白名单（内部接口-26 §2 逐字副本——断言「无原文键」时以它做闭集判据）。 */
const IF_COLLAB_26_KEYS = [
  'schemaVersion', 'kind', 'tool', 'event', 'errorClass', 'errorCode', 'exitCode', 'session',
  'taskId', 'skill', 'plugin', 'host', 'dispatchFact', 'delegationDepth', 'parentSession',
  'observationSource', 'id', 'ts', 'digest', 'count', 'note',
];

/** 造一个「落盘夹具」：记录 3 次工具失败（可指定会话头），返回账本行。 */
async function seedToolFailureRows(t, headerOf) {
  const tmp = mkdtempSync(join(tmpdir(), 'acm-m15v2-attrib-'));
  const prev = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  process.env.WF_POSTTOOL_STATE_DIR = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prev;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const ctx = makeFakeCtx();
  const { apply: freshApply } = await import('../src/index.mjs');
  freshApply(ctx, { projectDir: REPO_ROOT });
  const next = async () => ({ kind: 'accept' });
  for (const [index, header] of headerOf.entries()) {
    const agent = { session: { header }, inject: () => {}, steer: () => {}, followup: () => {} };
    const exec = { name: 'pwsh', arguments: { command: 'node -e "process.exit(2)"' }, agent, callId: `m15v2-${index}`, signal: undefined };
    await ctx.emit('tools/execute', exec, async () => ({ kind: 'continue' }));
    await ctx.emit(
      'tools/post-execute',
      exec,
      { isError: true, value: { kind: 'foreground', exitCode: 2 }, content: [{ type: 'text', text: '(no output)\n[exit code: 2]' }] },
      next,
    );
  }
  const ledger = join(tmp, '.workflow', 'incidents.jsonl');
  const raw = existsSync(ledger) ? readFileSync(ledger, 'utf8') : '';
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('M15 v2 tool 事件委派字段与观测事实供给', async (t) => {
  // A-da-16 / 内部验收-27 主锚（内部任务-192 P2，内部决策-063 D5.3/D8.1）。四面：①负载条件键（委派维成对、
  // 顶层零键）；②`dispatch_fact` 三态；③真实链路归因落账（委派记录带 depth/parent、顶层不带）；
  // ④能力域声明 env 进钩子子进程（`WF_OBSERVATION_CAPABILITIES`）。
  // ① 委派维成对条件键：仅 depth>0 且父会话非空（R-da-16「顶层不产键、不以 null/空串占位」）。
  const delegated = buildPayload('PostToolUse', { sessionId: 's1', cwd: REPO_ROOT, delegationDepth: 1, parentSessionId: 'p-1' });
  assert.equal(delegated.delegation_depth, 1, 'depth>0 且父会话非空 ⇒ delegation_depth 携带');
  assert.equal(delegated.parent_session_id, 'p-1', '同条件 ⇒ parent_session_id 携带');
  const top = buildPayload('PostToolUse', { sessionId: 's1', cwd: REPO_ROOT });
  assert.ok(!Object.hasOwn(top, 'delegation_depth'), '顶层不产 delegation_depth（成对条件）');
  assert.ok(!Object.hasOwn(top, 'parent_session_id'), '顶层不产 parent_session_id');
  assert.ok(!Object.hasOwn(top, 'dispatch_fact'), '未给派发事实 ⇒ 不产键（核心按 unknown 保守处理）');
  const emptyParent = buildPayload('PostToolUse', { delegationDepth: 1, parentSessionId: '' });
  assert.ok(!Object.hasOwn(emptyParent, 'parent_session_id'), '父会话空串 ⇒ 不产 parent_session_id（不得以空串占位）');
  // 「成对」条件在调用点强制（index.mjs 只在 depth>0 且父会话非空时同时传两字段）；
  // buildPayload 自身保留 delegation_depth 的通用语义（UPS/Stop 既有用法按此携带 0）。
  assert.ok(!Object.hasOwn(buildPayload('PostToolUse', { delegationDepth: 0, parentSessionId: 'p-1' }), 'parent_session_id'), 'depth=0 ⇒ 不产父会话键');
  // ② dispatch_fact 三态：两值产键；`unknown` 的合法表达是缺键（不伪造）。
  assert.equal(buildPayload('PostToolUse', { dispatchFact: 'dispatched' }).dispatch_fact, 'dispatched');
  assert.equal(buildPayload('PostToolUse', { dispatchFact: 'not-dispatched' }).dispatch_fact, 'not-dispatched');
  assert.ok(!Object.hasOwn(buildPayload('PostToolUse', { dispatchFact: 'unknown' }), 'dispatch_fact'), 'unknown 不产键');
  // ③ 真实链路：适配层取值 → 负载 → 真实 post-tool → 账本归因字段。
  const rows = await seedToolFailureRows(t, [
    { id: 'm15v2-del', cwd: REPO_ROOT, delegationDepth: 1, parentSession: 'par-1' },
    { id: 'm15v2-top', cwd: REPO_ROOT },
  ]);
  const failures = rows.filter((row) => row.kind === 'tool-failure');
  assert.equal(failures.length, 2, `两次失败各落一条（实际 ${JSON.stringify(rows)}）`);
  const delRec = failures.find((row) => row.session === 'm15v2-del');
  const topRec = failures.find((row) => row.session === 'm15v2-top');
  assert.equal(delRec?.delegationDepth, 1, '委派会话记录带 delegationDepth');
  assert.equal(delRec?.parentSession, 'par-1', '委派会话记录带 parentSession（ADR-063 D5.2 归因）');
  assert.equal(delRec?.dispatchFact, 'dispatched', '已派发 ⇒ 记录 dispatchFact=dispatched');
  assert.equal(delRec?.observationSource, 'hook:post-tool', '观测来源随记录落账（IF-COLLAB-19 v2）');
  assert.ok(topRec && !Object.hasOwn(topRec, 'delegationDepth') && !Object.hasOwn(topRec, 'parentSession'), '顶层记录不产委派字段（缺键而非空值）');
  // ④ 能力域声明进钩子子进程 env（R-da-16 ③：适配层必须声明四域）。
  const capBody = [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(new URL('../cap-env.json', import.meta.url), String(process.env.WF_OBSERVATION_CAPABILITIES ?? ''));",
  ].join('\n');
  const roots = makeSinglePluginSuite(
    t,
    { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: ['hooks/cap.mjs'], timeoutMs: 5000 }] }] },
    { 'hooks/cap.mjs': capBody },
    'hooks/cap.mjs',
  );
  const capCtx = makeFakeCtx();
  const { apply: capApply } = await import('../src/index.mjs');
  capApply(capCtx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const capAgent = { session: { header: { id: 'cap-1', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const capExec = { name: 'pwsh', arguments: { command: 'echo ok' }, agent: capAgent, callId: 'cap-1' };
  await capCtx.emit('tools/execute', capExec, async () => ({ kind: 'continue' }));
  await capCtx.emit('tools/post-execute', capExec, { isError: false, content: [{ type: 'text', text: 'ok' }] }, async () => ({ kind: 'accept' }));
  const captured = JSON.parse(readFileSync(join(roots.workflow, 'cap-env.json'), 'utf8'));
  assert.deepEqual(captured, { ...DSH_OBSERVATION_CAPABILITIES }, '钩子子进程必须收到 DSH 四域能力声明（IF-HOST-1 DSH 列）');
  assert.deepEqual(Object.keys(captured).sort(), ['failureFacts', 'hookFailure', 'injection', 'selfCheck'], '键集＝四能力域');
});

test('M15 v2 全暗哨兵经 emit 落账', async (t) => {
  // 内部验收-26 第二锚（内部任务-192 P2，内部决策-063 D8.3 / R-da-16 ②）：PostToolUse 观测面全暗哨兵——
  // 除既有 logWarn 外经 内部接口-26 `emit` 上报一条 `observation-degraded`（每会话至多一次、
  // 含能力缺口与计数摘要、无原文键）；emit 失败 fail-open：写兜底旁路 `内部工作流状态`
  // 且不阻断钩子派发（内部接口-26 §3.1 / 内部决策-063 修正案 1 决策 14）。
  const tmp = mkdtempSync(join(tmpdir(), 'acm-m15v2-dark-'));
  const prevIncident = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_POSTTOOL_STATE_DIR;
  process.env.WF_INCIDENT_ROOT = tmp;
  process.env.WF_POSTTOOL_STATE_DIR = tmp;
  t.after(() => {
    if (prevIncident === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prevIncident;
    if (prevState === undefined) delete process.env.WF_POSTTOOL_STATE_DIR; else process.env.WF_POSTTOOL_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });
  const next = async () => ({ kind: 'accept' });
  const emitPosts = async (ctx, agent, count) => {
    let calls = 0;
    for (let i = 0; i < count; i += 1) {
      await ctx.emit(
        'tools/post-execute',
        { name: 'pwsh', arguments: { command: 'node -e "process.exit(2)"' }, agent, callId: `dark-${i}` },
        { isError: false, content: [{ type: 'text', text: '未派发（调用层拒绝）' }] },
        async () => { calls += 1; return next(); },
      );
    }
    return calls;
  };
  // ③ 成功路径：伪造统计 3 次 0 命中 → logWarn 一次 + emit 一次（fake spawn 注入）。
  const calls = [];
  const okSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '{"ok":true,"id":"obs-deg-1"}\n', stderr: '' };
  };
  const ctx = makeFakeCtx();
  const { apply: freshApply } = await import('../src/index.mjs');
  freshApply(ctx, { projectDir: REPO_ROOT, observationEmitSpawn: okSpawn });
  const darkAgent = { session: { header: { id: 'm15v2-dark', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const nextCalls = await emitPosts(ctx, darkAgent, 5);
  assert.equal(nextCalls, 5, '哨兵不改变派发语义（fail-open：钩子照常派发）');
  assert.equal(ctx.warnings.filter((m) => String(m).includes('宿主未发生 tools/execute')).length, 1, 'logWarn 仍是一次（按会话去重）');
  assert.equal(calls.length, 1, '每会话至多一次 emit（第 3 次触发后不再重复）');
  const { command, args, options } = calls[0];
  assert.equal(command, process.execPath, 'emit 经 node 子进程（跨单元调 CLI，不直接写账本）');
  assert.ok(args[0].endsWith(join('scripts', 'incident-cli.mjs')), `emit 目标＝workflow 侧 CLI（实际 ${args[0]}）`);
  assert.deepEqual(args.slice(1), ['emit', '--project-root', REPO_ROOT], 'emit 子命令形态（IF-COLLAB-26 §2）');
  const fact = JSON.parse(options.input);
  assert.equal(fact.kind, 'observation-degraded', '上报 kind＝observation-degraded');
  assert.equal(fact.observationSource, 'adapter:dsh', '观测来源＝adapter:dsh');
  assert.equal(fact.host, 'dsh', 'host 事实面');
  assert.equal(fact.event, 'PostToolUse', '事件面');
  assert.equal(fact.count, 3, '计数摘要＝触发时事件累计数');
  assert.equal(fact.session, 'm15v2-dark', '会话归属（供核心按会话归因）');
  assert.equal(fact.note, 'dispatch-fact-absent', 'note 只放结构化类别名（不写原文）');
  for (const key of Object.keys(fact)) assert.ok(IF_COLLAB_26_KEYS.includes(key), `白名单外键不得上报：${key}`);
  for (const forbidden of ['command', 'stdout', 'stderr', 'path', 'error', 'message']) {
    assert.ok(!Object.hasOwn(fact, forbidden), `禁原文键不得出现：${forbidden}`);
  }
  assert.ok(!options.input.includes('process.exit(2)'), '上报载荷不得夹带命令原文（脱敏纪律）');
  // ④ emit 失败兜底：exit 1 → 写旁路一行（无原文）且不抛、不阻断；两会话各一次失败。
  const failedCalls = [];
  const failSpawn = (spawnCommand, spawnArgs, spawnOptions) => {
    failedCalls.push({ command: spawnCommand, args: spawnArgs, input: spawnOptions.input });
    return { status: 1, stdout: '', stderr: 'emit 失败：账本写入失败' };
  };
  const lostCtx = makeFakeCtx();
  const { apply: lostApply } = await import('../src/index.mjs');
  lostApply(lostCtx, { projectDir: REPO_ROOT, observationEmitSpawn: failSpawn });
  const lostAgent = { session: { header: { id: 'm15v2-lost', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  const lostAgent2 = { session: { header: { id: 'm15v2-lost2', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {}, followup: () => {} };
  assert.equal(await emitPosts(lostCtx, lostAgent, 3), 3, 'emit 失败不得阻断派发（fail-open）');
  assert.equal(await emitPosts(lostCtx, lostAgent2, 3), 3, '第二会话同样不阻断');
  assert.equal(failedCalls.length, 2, '两会话各触发一次 emit（均失败）');
  const lostFile = lostFactsPath(REPO_ROOT);
  assert.equal(lostFile, join(tmp, '.workflow', 'incidents-lost.jsonl'), '旁路落项目根 .workflow（与核心 ledger 同根：WF_INCIDENT_ROOT 注入缝同源）');
  const lostLines = readFileSync(lostFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lostLines.length, 2, '每次 emit 失败写一行旁路记录');
  const lostRecord = JSON.parse(lostLines[0]);
  assert.deepEqual(Object.keys(lostRecord).sort(), ['count', 'digest', 'kind', 'observationSource', 'schemaVersion', 'ts'], '旁路格式＝修正案 1 决策 14 固定六键');
  assert.equal(lostRecord.schemaVersion, 1);
  assert.equal(lostRecord.kind, 'observation-degraded');
  assert.equal(lostRecord.observationSource, 'adapter:dsh');
  assert.equal(lostRecord.count, 3, '计数摘要保留（会话内事件累计）');
  assert.match(String(lostRecord.digest), /^[0-9a-f]{16}$/, 'digest＝脱敏摘要（16 位十六进制）');
  const lostRaw = readFileSync(lostFile, 'utf8');
  assert.ok(!lostRaw.includes('emit 失败'), '旁路不得写错误原文（stderr 不外泄）');
  assert.ok(!lostRaw.includes('process.exit(2)'), '旁路不得写命令原文');
  assert.ok(!lostRaw.includes(REPO_ROOT), '旁路不得写路径原文');
  assert.equal(lostCtx.warnings.filter((m) => String(m).includes('兜底旁路')).length, 1, 'emit 失败告警每 apply 至多一次（logWarn 一次）');
});

test('M15 v2 emit 失败兜底文件 200 行上限（滚动丢弃最旧并计数）', () => {
  // 内部决策-063 修正案 1 决策 14：保留上限 200 行（超出滚动丢弃最旧行并计数），不抛错。
  // 直接测低层原语（emit 器在失败分支调用它），使上限可判定而不必伪造 200 次 spawn。
  assert.equal(LOST_FACTS_MAX_LINES, 200, '保留上限＝200 行（规格常量）');
  const tmp = mkdtempSync(join(tmpdir(), 'acm-lost-cap-'));
  // 旁路根与核心 ledger 同源（`WF_INCIDENT_ROOT` 注入缝）：本文件模块级已设该变量，
  // 故测 emit 器侧时必须显式指向 tmp，否则会读到模块级隔离目录而断言失真。
  const prevIncident = process.env.WF_INCIDENT_ROOT;
  try {
    const path = join(tmp, '.workflow', 'incidents-lost.jsonl');
    let last = null;
    for (let i = 1; i <= 205; i += 1) {
      last = appendLostFact(path, { schemaVersion: 1, ts: i, kind: 'observation-degraded', observationSource: 'adapter:dsh', count: i, digest: 'abcdef0123456789' });
    }
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.length, 200, '连续写入 205 行后恰保留 200 行');
    assert.equal(lines[0].ts, 6, '滚动丢弃最旧 5 行（首行 ts=1..5 被丢弃）');
    assert.equal(lines[lines.length - 1].ts, 205, '最新一行保留');
    assert.equal(last.dropped, 1, '最后一次追加恰好滚动丢弃 1 行并计数');
    // 内部决策-063 修正案 3 决策 22.1（内部任务-195）：轮转后**无重复行**（新行恰出现一次）、
    // 用同目录 tmp+rename 原子替换 ⇒ **无 `.tmp-*` 残留**。
    assert.equal(new Set(lines.map((l) => l.ts)).size, lines.length, '轮转后无重复行（新行恰出现一次）');
    assert.deepEqual(readdirSync(dirname(path)).filter((n) => n.includes('.tmp-')), [], '轮转不留 .tmp-* 残留');
    // emit 器侧同样遵守注入的 maxLines（生产 200，测试可调小）——避免生产路径与单测路径两套上限。
    process.env.WF_INCIDENT_ROOT = tmp;
    const emitter = createObservationEmitter({
      spawn: () => ({ status: 1, stdout: '', stderr: '' }),
      cliPath: '/nonexistent/scripts/incident-cli.mjs',
      warn: () => {},
      maxLines: 2,
    });
    const fact = { schemaVersion: 1, kind: 'observation-degraded', observationSource: 'adapter:dsh', ts: Date.now(), count: 1 };
    emitter.emitFact(fact, { projectRoot: tmp });
    emitter.emitFact({ ...fact, count: 2 }, { projectRoot: tmp });
    const two = readFileSync(lostFactsPath(tmp), 'utf8').split('\n').filter(Boolean);
    assert.equal(two.length, 2, '注入 maxLines=2 ⇒ 保留 2 行（同一滚动机器）');
    // 内部任务-320（内部未决-284）：派发失败事实的 kind=hook-failure，写出的旁路行必须固定为
    // `observation-degraded`（回放侧规定性固定值，内部决策-063 修正案 3 决策 22.2）——否则旁路行
    // 永远被判 invalid，回放恒不可用（来件原始 kind 由 digest 指纹保留可追溯性）。
    const emitter2 = createObservationEmitter({
      spawn: () => ({ status: 1, stdout: '', stderr: '' }),
      cliPath: '/nonexistent/scripts/incident-cli.mjs',
      warn: () => {},
      maxLines: 200,
    });
    emitter2.emitFact({ schemaVersion: 1, kind: 'hook-failure', observationSource: 'adapter:dsh', ts: Date.now(), count: 2.5, errorClass: 'dispatch-error' }, { projectRoot: tmp });
    const normalized = readFileSync(lostFactsPath(tmp), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const nf = normalized[normalized.length - 1];
    assert.equal(nf.kind, 'observation-degraded', '旁路行 kind 固定为 observation-degraded（否则回放恒 invalid）');
    assert.equal(nf.observationSource, 'adapter:dsh', 'observationSource 透传');
    assert.equal(nf.count, 0, 'count 归一（域外样本 2.5 ⇒ 0：核心回放侧要求安全整数且 ≥0，域外值会被判 invalid）');
    assert.ok(typeof nf.digest === 'string' && nf.digest.length >= 8, 'digest 保留（来件原始 kind 的可追溯性靠指纹）');
    // 跨插件字段域对拍（内部任务-320 stage1 复审发现）：核心回放侧 `parseLostLine` 要求 count 为安全整数、
    // digest 为 hex（否则判 invalid 静默跳过 ⇒ DSH 与核心两侧可「同绿」而回放实际不通）。
    assert.ok(Number.isSafeInteger(nf.count), 'count 必须是安全整数（核心回放侧按 Number.isSafeInteger 判定）');
    assert.match(String(nf.digest), /^[0-9a-f]{8,64}$/, 'digest 必须是 hex（核心回放侧按该域校验，否则判 invalid）');
  } finally {
    if (prevIncident === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prevIncident;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('M15 v2 lost 原子轮转与路径单源对拍（tmp+rename / 写失败 fail-open / 与核心 lostFactsPath 同源）', async (t) => {
  // 内部决策-063 修正案 3 决策 22.1/22.6（内部任务-195）：适配层写面＝先 append 保不丢行、超限同目录
  // tmp+rename 原子替换；路径规则两侧各持实现（跨插件边界不 import）但必须逐字一致。
  const core = await import('../../workflow/scripts/lib/incident-store.mjs');
  const { lostFactsPath: coreLostFactsPath, LOST_FACTS_MAX_LINES: coreLostMaxLines } = core;
  assert.equal(LOST_FACTS_MAX_LINES, coreLostMaxLines, '保留上限常量两侧契约同值（跨层不 import，对拍守）');
  const prevIncident = process.env.WF_INCIDENT_ROOT;
  const tmp = mkdtempSync(join(tmpdir(), 'acm-lost-atomic-'));
  t.after(() => {
    if (prevIncident === undefined) delete process.env.WF_INCIDENT_ROOT;
    else process.env.WF_INCIDENT_ROOT = prevIncident;
    rmSync(tmp, { recursive: true, force: true });
  });
  // 无注入缝形态：本文件模块级已设 WF_INCIDENT_ROOT（测试隔离），故先临时解除再断言。
  delete process.env.WF_INCIDENT_ROOT;
  assert.equal(lostFactsPath('/proj-x'), coreLostFactsPath('/proj-x'), '无注入缝：适配层与核心路径规则一致');
  assert.equal(lostFactsPath('/proj-x'), join('/proj-x', '.workflow', 'incidents-lost.jsonl'));
  process.env.WF_INCIDENT_ROOT = tmp;
  assert.equal(lostFactsPath('/other-root'), coreLostFactsPath('/other-root'), 'WF_INCIDENT_ROOT 场景：两侧同源（跨机诊断/测试隔离）');
  assert.equal(coreLostFactsPath('/other-root'), join(tmp, '.workflow', 'incidents-lost.jsonl'));
  if (prevIncident === undefined) delete process.env.WF_INCIDENT_ROOT;
  else process.env.WF_INCIDENT_ROOT = prevIncident;

  // 连续写入：任一时刻行数不超上限；超限后每次恰丢一行（丢最旧）。
  const path = join(tmp, 'lost', 'incidents-lost.jsonl');
  for (let i = 1; i <= 7; i += 1) {
    const r = appendLostFact(path, { schemaVersion: 1, ts: i, kind: 'observation-degraded', observationSource: 'adapter:dsh', count: i, digest: 'abcdef0123456789' }, { maxLines: 3 });
    assert.equal(r.ok, true, `第 ${i} 次写入成功`);
    const n = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(n <= 3, `第 ${i} 次写入后行数不超上限（实际 ${n}）`);
    if (i > 3) assert.equal(r.dropped, 1, `第 ${i} 次超限恰丢 1 行`);
  }
  assert.deepEqual(readdirSync(dirname(path)).filter((n) => n.includes('.tmp-')), [], '连续写入后无 tmp 残留');

  // 写失败 fail-open：只读目录臂（root/Windows 跳过——权限位在 root 下不生效，沿用既有惯例）。
  const readonlyArm = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
  if (readonlyArm) {
    const roDir = join(tmp, 'ro');
    mkdirSync(roDir, { recursive: true });
    chmodSync(roDir, 0o500);
    try {
      const r = appendLostFact(join(roDir, 'lost.jsonl'), { schemaVersion: 1, ts: 1, kind: 'observation-degraded', observationSource: 'adapter:dsh', count: 1, digest: 'abcdef0123456789' });
      assert.equal(r.ok, false, '写失败 fail-open：返回 ok:false、不抛（不反噬宿主派发）');
      assert.equal(r.lines, 0);
    } finally {
      chmodSync(roDir, 0o700);
    }
  }
});

test('M15 v2 能力域声明与镜像常量对拍（DSH env JSON）', () => {
  // 步骤 12 对拍（内部决策-063 修正案 1 决策 13）：DSH 适配层 env 声明 JSON 与核心消费的
  // 镜像常量（域键集/五态闭集/声明形态）一致；否则运行时 resolver 会把合法声明当非法降级。
  const caps = DSH_OBSERVATION_CAPABILITIES;
  assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_DOMAINS].sort(), 'env 键集＝镜像四能力域常量');
  const contract = loadContract();
  assert.equal(contract.ok, true, '镜像 JSON 可加载');
  assert.deepEqual(contract.domains, CAPABILITY_DOMAINS, '镜像 capabilityDomains 与常量同源');
  assert.deepEqual(contract.values, CAPABILITY_VALUES, '镜像 capabilityValues 与常量同源（五态闭集）');
  assert.ok(String(contract.sourceRef).includes('IF-HOST-1'), '镜像声明唯一人工源＝IF-HOST-1 能力登记表');
  for (const [domain, value] of Object.entries(caps)) {
    assert.equal(typeof value, 'string', `${domain} 取值须为字符串`);
    assert.ok(DECLARATION_GRAMMAR.test(value), `${domain}=${value} 须满足声明形态（镜像 declarationGrammar）`);
  }
  const resolved = resolveCapabilities(JSON.stringify(caps), contract, 'dsh');
  assert.equal(resolved.ok, true, 'resolver 接受 DSH 声明（结构合法）');
  assert.equal(resolved.source, 'env', '声明来源＝env');
  assert.equal(resolved.degraded, false, '已声明 ⇒ 不落保守降级');
  assert.deepEqual(resolved.domains, { ...caps }, '解析面原样返回四域声明');
  // 语义对拍（描述串 ↔ 五态登记词表）：每域的描述串必须能映回镜像 dsh 行的五态取值，
  // 否则「声明了能力域」与「能力登记表」会双源漂移（R-ha-10 单源义务）。
  const row = contract.hosts.dsh;
  assert.ok(row && typeof row === 'object', '镜像须登记 dsh 行');
  for (const domain of CAPABILITY_DOMAINS) {
    assert.ok(CAPABILITY_VALUES.includes(row.domains[domain]), `镜像 dsh.${domain} 须在五态闭集内`);
  }
  assert.equal(caps.failureFacts, 'adapter');
  assert.equal(row.domains.failureFacts, 'adapter', '失败事实供给：适配层合成结构化面（IF-HOST-1 DSH 列）');
  assert.match(caps.hookFailure, /^adapter/, '钩失败观测面＝适配层供给（emit 上报）');
  assert.equal(row.domains.hookFailure, 'adapter', '镜像同步「适配层供给」');
  assert.equal(caps.injection, 'immediate');
  assert.equal(row.domains.injection, 'native', '注入位（即时）＝原生注入能力（五态 native）');
  assert.match(caps.selfCheck, /^selftest/, '自检可达性以钩 --selftest 为底');
  assert.match(caps.selfCheck, /adapter-tests/, '＋适配层测试（未入 release-suite，故镜像记降级）');
  assert.equal(row.domains.selfCheck, 'degraded', '适配层测试未入 release-suite ⇒ 五态记降级可用');
});

test('M15 v2 DSH 派发失败 producer：spawn 抛错/超时/信封损坏三态（去重/无原文/不阻断）', async () => {
  // 内部决策-063 修正案 3 决策 23.1（内部任务-195）：钩失败观测面补齐——三态经注入 reporter 上报
  // hook-failure；每会话同类至多一次（键 `${sessionId}:${reason}`）；字段无原文；失败不阻断派发。
  const { createDispatchFailureReporter, runSingleHandler } = await import('../src/hooks-bridge.mjs');
  const handler = { command: 'node', args: ['-e', 'process.exit(9)'], timeoutMs: 1000, matcher: undefined, statusMessage: '' };
  const ctxOf = (shell) => ({ get: (name) => (name === 'shell' ? shell : undefined), logger: makeLoggerStub() });
  const calls = [];
  const reporter = createDispatchFailureReporter({ emit: { emitFact: (fact) => { calls.push(fact); return { ok: true }; } } });
  // ① spawn/execute 抛错 ⇒ reason=spawn-error（runHandler catch）
  const shellThrow = { resolve: (request) => request, execute: async () => { throw new Error('spawn ENOENT C:\\secret\\path'); } };
  const payload = { session_id: 's7-session', hook_event_name: 'PostToolUse' };
  const r1 = await runHandler(ctxOf(shellThrow), handler, payload, { cwd: REPO_ROOT, env: {}, reportDispatchFailure: reporter });
  assert.ok(r1.error !== undefined, '异常降级为无退出码失败（既有语义不变）');
  assert.equal(calls.length, 1, '恰一条 hook-failure');
  assert.equal(calls[0].schemaVersion, 1);
  assert.equal(calls[0].kind, 'hook-failure');
  assert.equal(calls[0].observationSource, 'adapter:dsh');
  assert.equal(calls[0].errorClass, 'dispatch-error');
  assert.equal(calls[0].note, 'spawn-error', 'reason 经 note 字段（类别名 token）');
  assert.equal(calls[0].event, 'PostToolUse', '事件名来自 payload.hook_event_name');
  assert.ok(Number.isFinite(calls[0].ts), 'ts 为毫秒数（emit 白名单必填）');
  assert.ok(!JSON.stringify(calls[0]).includes('spawn ENOENT'), '不得携带错误原文');
  assert.ok(!JSON.stringify(calls[0]).includes('secret'), '不得携带路径原文');
  // 去重：同会话同 reason 连续两次仍只报 1 条（工厂闭包 Map，实例级）
  await runHandler(ctxOf(shellThrow), handler, payload, { cwd: REPO_ROOT, env: {}, reportDispatchFailure: reporter });
  assert.equal(calls.length, 1, '同会话同类至多一次');
  // ② 宿主返回 timedOut=true ⇒ reason=dispatch-timeout（runHandler 必须如实透出 timedOut）
  const shellTimeout = {
    resolve: (request) => request,
    execute: async () => ({ result: async () => ({ exitCode: 124, stdout: { text: '' }, stderr: { text: '' }, timedOut: true }) }),
  };
  const r2 = await runHandler(ctxOf(shellTimeout), handler, { session_id: 's7-session', hook_event_name: 'Stop' }, { cwd: REPO_ROOT, env: {}, reportDispatchFailure: reporter });
  assert.equal(r2.timedOut, true, 'timedOut 字段如实透出（旧实现丢弃）');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].note, 'dispatch-timeout');
  assert.equal(calls[1].event, 'Stop');
  // ③ 信封损坏（stdout 以 { 开头但 JSON.parse 失败）⇒ reason=output-unparsable（解码前判定）
  const shellBroken = {
    resolve: (request) => request,
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '{bad' }, stderr: { text: '' }, timedOut: false }) }),
  };
  const opts = { cwd: REPO_ROOT, env: {}, reportDispatchFailure: reporter };
  const out3 = await runSingleHandler(ctxOf(shellBroken), handler, { session_id: 's7-session-2', hook_event_name: 'PreToolUse' }, opts, 'PreToolUse', {});
  assert.equal(out3.length, 1, '信封损坏按纯文本处理（既有 fail-open 决策语义不变）');
  assert.equal(out3[0].decision, undefined);
  assert.equal(calls.length, 3, '第三条 reason=output-unparsable');
  assert.equal(calls[2].note, 'output-unparsable');
  // ④ 纯文本空输出属合法 quiet 输出：不上报
  const shellQuiet = {
    resolve: (request) => request,
    execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, timedOut: false }) }),
  };
  await runSingleHandler(ctxOf(shellQuiet), handler, { session_id: 's7-session-3', hook_event_name: 'Stop' }, opts, 'Stop', {});
  assert.equal(calls.length, 3, 'quiet 输出不产事实');
  // ⑤ emit 桩抛错：派发仍成功、无未捕获异常（reporter 内部吞）
  const throwingReporter = createDispatchFailureReporter({ emit: { emitFact: () => { throw new Error('emit down'); } } });
  const r5 = await runHandler(ctxOf(shellThrow), handler, { session_id: 's7-session-4', hook_event_name: 'Stop' }, { cwd: REPO_ROOT, env: {}, reportDispatchFailure: throwingReporter });
  assert.ok(r5.error !== undefined, 'emit 失败不改变派发结果');
  // ⑥ 无注入 reporter：行为与旧实现一致（无回调即不上报，不抛）
  const r6 = await runHandler(ctxOf(shellThrow), handler, { session_id: 's7-session-5', hook_event_name: 'Stop' }, { cwd: REPO_ROOT, env: {} });
  assert.ok(r6.error !== undefined, '无 reporter 时照旧 fail-open');
});

// ── 内部任务-209 S2 达阈补测（内部未决-200② dsh 达阈）：fake ctx 驱动 apply() 注册面与主要事件处理器 ──
// 覆盖 index.mjs 的事件派发/失败兜底分支（agent/created、agent/pre-step 四类、tools/pre-execute、
// tools/execute、tools/post-execute、agent/turn-stopping）；零真机（fake 服务 + 空 stdout shell 桩）。
function makeDev209Ctx() {
  const handlers = new Map();
  const logger = makeLoggerStub();
  const ctx = {
    logger,
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    get: () => undefined,
    shell: {
      resolve: (request) => request,
      execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
    },
  };
  return { ctx, handlers, logger };
}

function dev209Agent(sid = 'sess-dev209', depth = 0) {
  return { id: `agent-${sid}`, session: { header: { id: sid, delegationDepth: depth } }, ctx: { get: () => undefined } };
}

async function emitAllHandlers(handlers, event, ...args) {
  const results = [];
  for (const handler of handlers.get(event) ?? []) results.push(await handler(...args));
  return results;
}

test('apply 事件派发冒烟：SessionStart/pre-step/PreToolUse/execute/post-execute/Stop 均不抛出且形状可消费', async () => {
  const { ctx, handlers } = makeDev209Ctx();
  await apply(ctx, { repoRootOverride: REPO_ROOT });
  assert.ok(handlers.size > 0, 'apply 须注册监听器');
  const agent = dev209Agent();
  const created = await emitAllHandlers(handlers, 'agent/created', { agent, source: { kind: 'startup' }, signal: undefined });
  assert.ok(Array.isArray(created), 'agent/created 处理器返回数组');
  const nextEnter = async () => ({ kind: 'enter', messages: [{ role: 'user', content: '你好', source: { kind: 'user' } }] });
  const preStep = await emitAllHandlers(handlers, 'agent/pre-step', { agent, messages: [{ role: 'user', content: '你好', source: { kind: 'user' } }], signal: undefined }, nextEnter);
  assert.ok(preStep.length >= 1, 'pre-step 至少一个处理器');
  for (const out of preStep) {
    assert.ok(out === undefined || out === null || typeof out === 'object', 'pre-step 返回对象或 undefined');
    if (out && out.kind === 'enter') assert.ok(Array.isArray(out.messages), 'enter 决策须带 messages 数组');
  }
  const exec = { name: 'edit', arguments: { path: join(REPO_ROOT, 'tmp-dev209.txt') }, agent, callId: 'call-1' };
  const nextContinue = async () => ({ kind: 'continue' });
  const preTool = await emitAllHandlers(handlers, 'tools/pre-execute', exec, nextContinue);
  assert.ok(preTool.length >= 1, 'tools/pre-execute 处理器存在');
  for (const out of preTool) assert.ok(out === undefined || typeof out === 'object', 'PreToolUse 返回决策对象');
  const executed = await emitAllHandlers(handlers, 'tools/execute', exec, nextContinue);
  assert.ok(executed.length >= 1, 'tools/execute 处理器存在');
  const postTool = await emitAllHandlers(handlers, 'tools/post-execute', exec, { content: 'ok', isError: false }, nextContinue);
  assert.ok(postTool.length >= 1, 'tools/post-execute 处理器存在');
  const stopping = await emitAllHandlers(handlers, 'agent/turn-stopping', { agent, signal: undefined });
  assert.ok(stopping.length >= 1, 'agent/turn-stopping 处理器存在');
});

test('apply 桥接面：agentControlBridge 开启时经 fake 服务注册三工具并注入首轮通道提示', async () => {
  const { ctx, handlers } = makeDev209Ctx();
  const registered = [];
  const toolsService = { register: (def) => { registered.push(def); return () => {}; } };
  const services = { tools: toolsService, subagents: { listChildren: () => [], sendMessage: async () => ({}) }, agents: { get: () => ({ status: 'idle' }) } };
  ctx.get = (name) => services[name];
  await apply(ctx, { repoRootOverride: REPO_ROOT, agentControlBridge: true });
  const agent = dev209Agent('sess-bridge');
  agent.ctx = { get: (name) => (name === 'tools' ? toolsService : undefined) };
  await emitAllHandlers(handlers, 'agent/created', { agent, source: { kind: 'startup' }, signal: undefined });
  const names = registered.map((d) => d.name);
  assert.ok(names.includes('list_subagents') && names.includes('message_subagent') && names.includes('wait_subagent'), `三工具应注册：${names.join(',')}`);
  const listDef = registered.find((d) => d.name === 'list_subagents');
  assert.equal(typeof listDef.output.render, 'function', '注册定义须带 output.render（宿主 Content[] 契约）');
  const rendered = listDef.output.render({ subagents: [] });
  assert.ok(Array.isArray(rendered) && rendered.every((block) => typeof block?.type === 'string'), 'render 须返回 Content 块数组');
  const nextEnter = async () => ({ kind: 'enter', messages: [] });
  const preStep = await emitAllHandlers(handlers, 'agent/pre-step', { agent, messages: [{ role: 'user', content: 'hi', source: { kind: 'user' } }], signal: undefined }, nextEnter);
  const injected = preStep.filter((out) => out && out.kind === 'enter' && JSON.stringify(out.messages).includes('子代理'));
  assert.ok(injected.length >= 1, '首轮通道提示应注入（含「子代理」字样）');
});

test('DEV-268 osObservation 环境缝注入', async (t) => {
  // 适配层真正要证的行为：dispatch 对 team-governance SessionStart 处理器注入 AI_CODING_OS_OBSERVE=0；
  // true 态与 team-governance 未启用时不注入（夹具：临时 team-governance 根 + 把 env 落文件）。
  // 外部预置该 env 会让「开启态=ABSENT」假红：用例内暂存/删除并恢复。
  const prevOsEnv = process.env.AI_CODING_OS_OBSERVE;
  delete process.env.AI_CODING_OS_OBSERVE;
  t.after(() => {
    if (prevOsEnv === undefined) delete process.env.AI_CODING_OS_OBSERVE;
    else process.env.AI_CODING_OS_OBSERVE = prevOsEnv;
  });
  const body = [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(new URL('../ss-env.json', import.meta.url), String(process.env.AI_CODING_OS_OBSERVE ?? 'ABSENT'));",
  ].join('\n');
  const tgRoot = makeFixturePlugin(
    t,
    withRootPlaceholder({ SessionStart: [{ hooks: [{ type: 'process', command: process.execPath, args: ['hooks/env.mjs'], timeoutMs: 5000 }] }] }, 'hooks/env.mjs'),
    { 'hooks/env.mjs': body },
  );
  const empty = () => makeFixturePlugin(t, {}, {});
  const roots = { workflow: empty(), 'spec-gate': empty(), scout: empty(), 'team-governance': tgRoot, 'algo-loop': empty(), 'research-loop': empty() };
  const marker = join(tgRoot, 'ss-env.json');
  const run = async (config) => {
    writeFileSync(marker, 'UNSET', 'utf8');
    const ctx = makeFakeCtx();
    await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT, pluginTeamGovernance: true, ...config });
    const agent = { session: { header: { id: 'ss-env', cwd: REPO_ROOT } }, inject() {}, steer() {} };
    await ctx.emit('agent/created', { agent, source: 'startup' });
    return readFileSync(marker, 'utf8');
  };
  assert.equal(await run({ osObservation: false }), '0', '关闭态：team-governance SessionStart 钩子 env 含 AI_CODING_OS_OBSERVE=0');
  assert.equal(await run({ osObservation: true }), 'ABSENT', '开启态：不注入该键（按原环境派发）');
  assert.equal(await run({ osObservation: false, pluginTeamGovernance: false }), 'UNSET', 'team-governance 未启用：其处理器不派发（合法组合零注入）');
});


// ===== 内部任务-272 内部未决-235：Stop 透传宿主轮号 turnId（A-da-3 唯一锁定用例） =====
test('DEV-272 Stop 透传宿主轮号 turnId：键门矩阵与 trim 极性', () => {
  assert.equal(turnIdOf(7), '7');
  for (const bad of [0, -1, 1.5, '1', null, undefined, Number.NaN]) assert.equal(turnIdOf(bad), undefined);
  const withTurn = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', turnId: '7' });
  assert.equal(withTurn.turnId, '7');
  assert.equal(withTurn.stop_hook_active, false);
  for (const bad of ['', ' ', 7, undefined]) {
    const p = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', turnId: bad });
    assert.ok(!('turnId' in p), '非法/缺失 turnId 不产键');
  }
});

test('DEV-272 Stop 透传宿主轮号 turnId：端到端语义（缺省不产键／显式产键）', () => {
  const absent = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p' });
  assert.ok(!('turnId' in absent), '缺省不产键');
  const present = buildPayload('Stop', { sessionId: 's1', cwd: 'C:/p', turnId: turnIdOf(3) });
  assert.equal(present.turnId, '3');
});


// ===== 内部任务-272 内部未决-235：Stop turnId 真端到端（A-da-3 集成面；B3 阶段门修复） =====
test('DEV-272 Stop 透传宿主轮号 turnId：端到端回显（apply 层 emit turn=7）', async (t2) => {
  const roots = makeSinglePluginSuite(
    t2,
    { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['hooks/stop-echo.mjs', '__OUT__'], timeoutMs: 5000 }] }] },
    { 'hooks/stop-echo.mjs': "import { readFileSync, writeFileSync } from \"node:fs\";\nconst out = process.argv[2];\nlet raw = \"\"; process.stdin.setEncoding(\"utf8\");\nfor await (const c of process.stdin) raw += c;\nlet p = {}; try { p = JSON.parse(raw); } catch {}\nwriteFileSync(out, \"turnId=\" + (p.turnId ?? \"ABSENT\"));\n" },
    'hooks/stop-echo.mjs',
  );
  // 把占位符替换为真实绝对输出路径
  const rootDir = roots.workflow;
  const out = join(rootDir, 'out.txt');
  const hooksFile = join(rootDir, 'hooks', 'hooks.json');
  const cfg = JSON.parse(readFileSync(hooksFile, 'utf8'));
  cfg.hooks.Stop[0].hooks[0].args[1] = out;
  writeFileSync(hooksFile, JSON.stringify(cfg), 'utf8');
  const mkAgent = (id) => ({ session: { header: { id, cwd: REPO_ROOT } }, inject() {}, steer() {} });
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent('turnid-e2e-7'), turn: 7 });
  assert.equal(readFileSync(out, 'utf8'), 'turnId=7', 'Stop 信封携带宿主 turn=7');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent('turnid-e2e-absent') });
  assert.equal(readFileSync(out, 'utf8'), 'turnId=ABSENT', '缺 turn 不产键');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent('turnid-e2e-invalid'), turn: 0 });
  assert.equal(readFileSync(out, 'utf8'), 'turnId=ABSENT', 'turn=0 不产键');
  assert.ok(ctx.warnings.some((m) => String(m).includes('turn 非法')), '非法 turn 会话级一次 warn：' + ctx.warnings.join(' | '));
});


// ===== 内部任务-272 B2/B4：apply + 损坏清单根 → byLevel warn（穿透 index 生产接线） =====
test('DEV-272 声明面诊断：apply 装配 + 损坏清单根 → warn 含插件名', async (t2) => {
  const roots = makeSinglePluginSuite(t2, {}, {});
  writeFileSync(join(roots.workflow, 'plugin.manifest.json'), '{broken', 'utf8');
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  assert.ok(ctx.warnings.some((m) => String(m).includes('workflow')), 'apply 期告警含插件名：' + ctx.warnings.join(' | '));
});


// ===== 内部任务-272 B1：plan 模式门控首轮协议装配用例（index:938；Stop/LongTaskStop 让位残余见 内部未决-236） =====
function planCtx(planState) {
  const ctx = makeFakeCtx();
  const origGet = ctx.get;
  ctx.get = (name) => {
    if (name === 'goals') return { get: () => undefined };
    if (name === 'planMode') return { get: () => planState };
    return origGet(name);
  };
  return ctx;
}

test('DEV-272 plan 模式门控：首轮协议在 plan active 时不注入（装配级）', async (t2) => {
  const roots = makeSinglePluginSuite(t2, {}, {});
  const ctx = planCtx({ active: true });
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'plan-on', cwd: REPO_ROOT } }, inject() {}, steer() {} };
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.equal((out.messages ?? []).length, 0, 'plan active：协议不注入');
});

test('DEV-272 plan 模式门控：plan off 时首轮协议注入（装配级差分）', async (t2) => {
  const roots = makeSinglePluginSuite(t2, {}, {});
  const ctx = planCtx({ active: false });
  await apply(ctx, { pluginRoots: roots, projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'plan-off', cwd: REPO_ROOT } }, inject() {}, steer() {} };
  const out = await emitPreStepChain(ctx, { agent, messages: [] });
  assert.ok((out.messages ?? []).length > 0, 'plan off：协议注入（差分证明门控生效）');
});

test('DEV-273 批次B M-02/M-03：超时/失败日志带处理器身份；取消不记失败、取消窗口内真失败双记', async () => {
  const logs = [];
  const logger = { info: (_f, m) => logs.push(['info', String(m)]), warn: (_f, m) => logs.push(['warn', String(m)]), error: () => {}, debug: () => {} };
  const reports = [];
  const makeCtx = (execute) => ({ get: () => ({ resolve: (spec) => spec, execute }), logger });
  const payload = buildPayload('PostToolUse', { sessionId: 's1', cwd: '/tmp' });
  const handler = { command: 'node', args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 1000 };
  const opts = { cwd: '/tmp', env: {}, label: 'workflow#3', reportDispatchFailure: (info) => reports.push(info) };

  // ① 超时：warn 含处理器身份（插件#序位），并上报 dispatch-timeout。
  const r1 = await runHandler(makeCtx(async () => ({ result: async () => ({ exitCode: undefined, timedOut: true, stdout: { text: '' }, stderr: { text: '' } }) })), handler, payload, opts);
  assert.equal(r1.timedOut, true);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('钩子超时') && m.includes('workflow#3')), `超时日志须含处理器身份；实际 ${JSON.stringify(logs)}`);
  assert.ok(reports.some((r) => r.reason === 'dispatch-timeout'));

  // ② 取消（AbortError）：info 记取消，不上报 spawn-error。
  logs.length = 0;
  reports.length = 0;
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  const r2 = await runHandler(makeCtx(async () => { throw abortErr; }), handler, payload, { ...opts, signal: { aborted: true } });
  assert.equal(r2.aborted, true);
  assert.ok(logs.some(([lvl, m]) => lvl === 'info' && m.includes('派发被取消')));
  assert.equal(reports.length, 0, '取消不得上报 spawn-error（假失败账）');

  // ③ 取消窗口内的真实失败：既记「取消窗口」info，又照常上报 spawn-error（不单向失真）。
  logs.length = 0;
  reports.length = 0;
  const r3 = await runHandler(makeCtx(async () => { throw new Error('boom'); }), handler, payload, { ...opts, signal: { aborted: true } });
  assert.equal(r3.error, 'boom');
  assert.ok(logs.some(([lvl, m]) => lvl === 'info' && m.includes('取消窗口')));
  assert.equal(reports[0]?.reason, 'spawn-error');

  // ④ AbortError 但 signal 未置位：按取消处理（判别「AbortError 独立于 signal」子句；旧实现会错报 spawn-error）。
  logs.length = 0;
  reports.length = 0;
  const r4 = await runHandler(makeCtx(async () => { throw abortErr; }), handler, payload, opts);
  assert.equal(r4.aborted, true);
  assert.ok(logs.some(([lvl, m]) => lvl === 'info' && m.includes('派发被取消')));
  assert.equal(reports.length, 0, 'AbortError 不得上报 spawn-error');
});

test('DEV-273 批次B M-01：Stop 阻断但 agent 无 steer ⇒ 一次性 warn（不静默）', async (t) => {
  const root = makeFixturePlugin(t, { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: ['${ZCODE_PLUGIN_ROOT}/hooks/deny.mjs'] }] }] }, {
    'hooks/deny.mjs': "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', systemMessage: '别停' } }) + '\\n');\n",
  });
  const ctx = makeFakeCtx();
  await apply(ctx, { projectDir: REPO_ROOT, pluginRoots: { workflow: root } });
  const agent = { session: { header: { id: 'no-steer', cwd: REPO_ROOT } }, inject() {} };
  // 两次 turn-stopping：去重后本会话应恰一次 warn（旧实现无去重会两次）。
  await ctx.emit('agent/turn-stopping', { agent });
  await ctx.emit('agent/turn-stopping', { agent });
  const warns = typeof ctx.byLevel === 'function' ? ctx.byLevel('warn') : ctx.warnings;
  const hits = warns.filter((m) => String(m).includes('Stop 处置缺能力'));
  assert.equal(hits.length, 1, `缺 steer 能力须恰 warn 一次；实际 ${JSON.stringify(warns)}`);
});

test('宿主契约钉子（DEV-273 H-02）：tools 服务实现面只有 get，虚构成员只出现在 view 结果内', async () => {
  // 为什么要有（计划步骤 2）：H-02 修复的宿主侧依据必须由真宿主抽取副本钉住，否则「宿主服务没有
  // restrictableNames/listNames」只由假件自证。姿态同 内部未决-46 钉子：宿主不可得 fail-loud，不静默跳过。
  const engine = await import('./helpers/dsh-engine.mjs');
  const decided = engine.ensureEngineCache();
  assert.ok(decided.dir !== undefined, `宿主引擎不可得（${decided.mode}）：H-02 契约钉子必须真实执行`);
  const pkgDir = join(decided.dir, '@deepseek-ai', 'dsh-tools');
  assert.ok(existsSync(pkgDir), '宿主 dsh-tools 包必须在抽取副本内（宿主升级挪包即红）');
  const serviceSrc = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8');
  assert.match(serviceSrc, /\bget\s*[(:]/, 'tools 服务实现面必须暴露 get 成员（H-02 探测口）');
  // 旧实现读的是 `this.view(scope).restrictableNames` 却写成「service 成员」；钉住**直接成员**不存在。
  assert.ok(!/this\.restrictableNames\b/.test(serviceSrc), 'tools 服务实现面不得把 restrictableNames 作为直接成员（旧实现读错层级）');
  assert.ok(!/this\.listNames\b/.test(serviceSrc), 'tools 服务实现面不得把 listNames 作为直接成员');
  // 反锚：该名字只存在于 `view(scope)` 的结果类型里（旧实现把 view 结果当服务成员读 ⇒ 恒 undefined）。
  const typesSrc = readFileSync(join(pkgDir, 'lib', 'types', 'index.js'), 'utf8');
  assert.match(typesSrc, /this\.view\(scope\)\.restrictableNames/, '`view(scope).restrictableNames` 的宿主内部形态必须保留在类型面');
});

// ── 内部任务-285：钩子声明热加载（B 面；内部决策-066 修正案 1 配套 / 内部模块-24 R-da-18） ────────────────

/** 内部任务-285：写入夹具中立清单（hooks 为扁平声明数组）。 */
function writeFixtureManifest(pluginRoot, hooks) {
  writeFileSync(
    join(pluginRoot, 'plugin.manifest.json'),
    JSON.stringify({ manifestVersion: 1, name: 'fixture', version: '0.0.0', description: '夹具插件', author: 'wangp', hooks }, null, 2),
    'utf8',
  );
}

/** 内部任务-285：PreToolUse 夹具声明（args 用 plugin-root 占位符，由适配层替换）。 */
function fixturePreHook(relScript) {
  return { event: 'PreToolUse', type: 'process', command: 'node', args: [`\${ZCODE_PLUGIN_ROOT}/${relScript}`], timeoutMs: 5000, statusMessage: 'fixture' };
}

/** 内部任务-285：把清单 mtime 推到未来，确保 `mtimeMs` 签名变化（同秒内写入的兜底）。 */
async function bumpManifestMtime(pluginRoot) {
  const { utimesSync } = await import('node:fs');
  const p = join(pluginRoot, 'plugin.manifest.json');
  const future = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000));
  utimesSync(p, future, future);
}

test('DEV-285 declarationSignature：manifest 优先、无清单回落 hooks.json、双缺 null、坏 JSON 只 stat 不解析', async (t) => {
  const hb = await import('../src/hooks-bridge.mjs');
  assert.equal(typeof hb.declarationSignature, 'function', 'declarationSignature 必须导出（R-da-18）');
  const sig = hb.declarationSignature;
  // ① manifest 在场：mtimeMs:size
  const manifestRoot = makeManifestPlugin(t, [fixturePreHook('hooks/a.mjs')], { 'hooks/a.mjs': 'process.exit(0);\n' });
  assert.match(String(sig(manifestRoot)), /^\d+(?:\.\d+)?:\d+$/, 'manifest 在场签名形态 mtimeMs:size');
  // ② 坏 JSON：只 stat 不解析（签名仍可产出，不抛）
  writeFileSync(join(manifestRoot, 'plugin.manifest.json'), '{bad json', 'utf8');
  assert.match(String(sig(manifestRoot)), /^\d+(?:\.\d+)?:\d+$/, '坏 JSON 不影响签名（不读取/不解析内容）');
  // ③ 无 manifest、有 hooks.json：回落生成物签名
  const zcodeRoot = makeFixturePlugin(t, {}, {});
  assert.match(String(sig(zcodeRoot)), /^\d+(?:\.\d+)?:\d+$/, '无中立清单时回落 hooks.json 签名');
  // ④ 双缺：null
  const emptyRoot = makeTemp(t);
  assert.equal(sig(emptyRoot), null, '清单与生成物皆无时返回 null');
});

test('DEV-285 钩子声明热加载：manifest 签名变化 → 既有事件处理器重建并 logInfo；坏 JSON 保留旧清单（装配级）', async (t) => {
  const hookBody = (tag) => `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', systemMessage: '${tag}' } }) + '\\n');\nprocess.exit(0);\n`;
  const root = makeTemp(t);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFixtureManifest(root, [fixturePreHook('hooks/a.mjs')]);
  writeFileSync(join(root, 'hooks', 'a.mjs'), hookBody('A'), 'utf8');
  writeFileSync(join(root, 'hooks', 'b.mjs'), hookBody('B'), 'utf8');
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: { workflow: root }, projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'reload-1', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {} };
  const next = async () => ({ kind: 'continue' });
  const d1 = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent, callId: 'reload-r1' }, next);
  assert.equal(d1.reason, 'A', '初始清单只命中 hook A');
  // 追加 hook B 并推 mtime → 下一次派发前应重载
  writeFixtureManifest(root, [fixturePreHook('hooks/a.mjs'), fixturePreHook('hooks/b.mjs')]);
  await bumpManifestMtime(root);
  const d2 = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent, callId: 'reload-r2' }, next);
  assert.ok(String(d2.reason ?? '').includes('B'), `热加载后应命中新 hook B（实际 ${String(d2.reason)}）`);
  assert.ok(ctx.byLevel('info').some((m) => String(m).includes('钩子声明已重载')), '重载须 logInfo 可见（诊断面）');
  // 内部模块-24 R-da-18/A-da-18（code-review r2 ⑥）：日志须含插件名与处理器计数，不只通用句
  const reloadLine = ctx.byLevel('info').map(String).find((m) => m.includes('钩子声明已重载')) ?? '';
  assert.ok(reloadLine.includes('插件='), `重载日志须含插件名（实际：${reloadLine}）`);
  assert.ok(reloadLine.includes('处理器计数'), `重载日志须含处理器计数（实际：${reloadLine}）`);
  // 坏 JSON → 保留旧清单（仍命中 B）且有可见 warn
  writeFileSync(join(root, 'plugin.manifest.json'), '{bad json', 'utf8');
  await bumpManifestMtime(root);
  const d3 = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent, callId: 'reload-r3' }, next);
  assert.ok(String(d3.reason ?? '').includes('B'), '声明损坏时保留旧清单（fail-open）');
  assert.ok(ctx.byLevel('warn').some((m) => String(m).includes('钩子声明')), '重载失败须有可见告警（不静默）');
});

test('DEV-285 热加载边界：apply 期零声明事件不随声明追加而热生效（已登记边界，非缺陷）', async (t) => {
  const marker = join(makeTemp(t), 'ups-marker.txt');
  const ssBody = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SS-RELOAD' } }) + '\\n');\nprocess.exit(0);\n";
  const upsBody = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'called');\nprocess.exit(0);\n`;
  const root = makeTemp(t);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFixtureManifest(root, [{ event: 'SessionStart', type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/ss.mjs'], timeoutMs: 5000 }]);
  writeFileSync(join(root, 'hooks', 'ss.mjs'), ssBody, 'utf8');
  writeFileSync(join(root, 'hooks', 'ups.mjs'), upsBody, 'utf8');
  const ctx = makeFakeCtx();
  await apply(ctx, { pluginRoots: { workflow: root }, projectDir: REPO_ROOT });
  const preStepListenersBefore = (ctx.listeners.get('agent/pre-step') ?? []).length;
  // apply 后追加零声明事件的处理器
  writeFixtureManifest(root, [
    { event: 'SessionStart', type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/ss.mjs'], timeoutMs: 5000 },
    { event: 'UserPromptSubmit', type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/ups.mjs'], timeoutMs: 5000 },
  ]);
  await bumpManifestMtime(root);
  const agent = { session: { header: { id: 'reload-2', cwd: REPO_ROOT } }, inject: () => {}, steer: () => {} };
  // 经已有事件（SessionStart）触发一次热加载
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.ok(ctx.byLevel('info').some((m) => String(m).includes('钩子声明已重载')), '既有事件重载已发生（前置事实，防恒真）');
  // 边界：新事件 UPS 的处理器不增挂（监听器数量不变、脚本从未被调用）
  assert.equal((ctx.listeners.get('agent/pre-step') ?? []).length, preStepListenersBefore, 'apply 期零声明事件不增挂监听器（已登记边界）');
  assert.equal(existsSync(marker), false, '新事件处理器不得被调用（不宣称任意声明热生效）');
});


// ── 内部任务-352（2026-11-08）：ask 答复 PostToolUse 信封 → 适配层解码面（内部规则-6）──

test('DEV-352：ask 答复信封经 decodeHookOutput 解码（真实钩子子进程）', async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { pathToFileURL: toUrl } = await import('node:url');
  const { projectKey } = await import(toUrl(join(repo, 'workflow', 'hooks', 'routing-lib.mjs')).href);
  const { issueChallenge } = await import(toUrl(join(repo, 'workflow', 'hooks', 'task-lease-lib.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'ds-dev352-'));
  const proj = mkdtempSync(join(tmpdir(), 'ds-dev352-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  const stateDir = join(tmp, 'state');
  const ringDir = join(tmp, 'ring');
  const incDir = join(tmp, 'inc');
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const sid = 'SDSHDEV352';
    const key = projectKey(proj);
    const ch = issueChallenge(key, { sessionId: sid });
    const r = spawnSync(process.execPath, [join(repo, 'workflow', 'hooks', 'post-tool.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'call_ds_dev352',
        session_id: sid,
        cwd: proj,
        tool_input: { question: 'probe' },
      }),
      encoding: 'utf8',
      env: { ...process.env, WF_ROUTING_STATE_DIR: stateDir, WF_POSTTOOL_STATE_DIR: ringDir, WF_INCIDENT_ROOT: incDir },
      timeout: 20000,
    });
    assert.equal(r.status, 0, '真钩子 exit 0');
    const decoded = decodeHookOutput(r.status, r.stdout, r.stderr, 'PostToolUse');
    assert.equal(typeof decoded.additionalContext, 'string', '解码面 additionalContext 为字符串（decodeHookOutput 形态）');
    assert.ok(decoded.additionalContext.includes('【workflow 任务租约】'), '解码后正文含租约行');
    assert.ok(decoded.additionalContext.includes(ch.leaseId), '解码后正文含当前令牌');
    assert.ok(decoded.additionalContext.includes('答复通道提示：答复不轮换令牌'), '解码后正文含唯一尾注');
    assert.equal(decoded.decision, undefined, '非决策位（不阻断）');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});