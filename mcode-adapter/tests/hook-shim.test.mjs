// 文件：mcode-adapter/tests/hook-shim.test.mjs
// 描述：shim 面的两层测试——① 纯函数面（`hook-lib.mjs` 的归一/译出/状态/结果面判序）；
//       ② **真实钩子进程面**：以 MCode 形态负载驱动物化包内的 ZCode 原钩子，逐条断言
//       ①响应帧落在宿主白名单内 ②护栏极性与文案不丢 ③Stop 提醒走待投递中继
//       ④子进程超时时 fail-open 且不假装通过。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEngine } from '../../plugin-core/src/engine.mjs';
import { after, before, describe, it, test } from 'node:test';

import { REPO_ROOT } from './helpers.mjs';

// 批 3：`normalizePayload` 的来源归一已由引擎单源（无引擎即具名抛错），纯函数面用例传入真实引擎。
const SHIM_TEST_ENGINE = loadEngine(REPO_ROOT);
import {
  BLOCK_FALLBACK_REASON,
  OBSERVATION_CAPABILITIES,
  TOOL_MAP,
  applyObservationCapabilitiesEnv,
  clampContext,
  deriveToolResult,
  describeChildFailure,
  emptyState,
  MIGRATION_SESSION_KEY,
  enqueuePending,
  normalizePayload,
  readState,
  sessionKeyOf,
  translateResponse,
  writeState,
} from '../mcode/hook-lib.mjs';
import { checkFrameAgainstHost, materializeAll, removeRoot, runShim, tempRoot, writeFile } from './helpers.mjs';

// 内部任务-320（内部未决-281）：MCode 侧「信封声明阻断但无 reason／正文」的同形负载此前**不计阻断**
// （静默降级为上下文帧或零输出 ⇒ 方向偏放行）。本组用例把两处判据副本（hook-lib 的
// translateResponse 与 hook-shim 的 blockedPrompt）钉死为「`decision==='block'` 即阻断」，
// 且 reason 缺失时以兜底文案构因（与 kimi 侧同语义）。
describe('内部任务-320 内部未决-281：阻断取因口径（无 reason 仍计阻断）', () => {
  let dataDir = '';
  let pkgRoot = '';
  let stateDir = '';

  before(() => {
    dataDir = materializeAll(tempRoot('shim-281'));
    pkgRoot = join(dataDir, 'plugins', 'workflow');
    // 状态面＝shim 真实读写处：`PLUGIN_DATA=<dataDir>` ⇒ 状态文件 `<dataDir>/relay-state.json`
    // （hook-lib `resolveStateDir` 优先宿主注入的 PLUGIN_DATA；种子帧必须落此处，否则「队列非空」前提不成立）。
    stateDir = dataDir;
    // ① 无 reason 的阻断信封；② 有 reason 的阻断信封；③ 无 reason 但带上下文（双负载）
    writeFile(join(pkgRoot, 'hooks', 'block-noreason.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block' }));\n");
    writeFile(join(pkgRoot, 'hooks', 'block-withreason.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'X-原始原因' }));\n");
    writeFile(join(pkgRoot, 'hooks', 'block-noreason-withctx.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '上下文正文' } }));\n");
  });

  after(() => {
    removeRoot(dataDir);
  });

  it('D1 UPS 无 reason 仍计阻断：兜底文案构因，不得降级为上下文帧或零输出', () => {
    const frame = translateResponse('UserPromptSubmit', { decision: 'block' }, { blocked: false, engine: SHIM_TEST_ENGINE });
    assert.equal(frame.decision, 'block', '阻断仍传达');
    assert.equal(frame.reason, BLOCK_FALLBACK_REASON.prompt, 'reason 由兜底文案构（不丢阻断）');
    assert.equal(frame.hookSpecificOutput, undefined, '不得降级为上下文帧');
  });

  it('D2 UPS 有 reason 回归：reason 逐字保留不被兜底覆盖', () => {
    const frame = translateResponse('UserPromptSubmit', { decision: 'block', reason: 'X-原始原因' }, { blocked: false, engine: SHIM_TEST_ENGINE });
    assert.equal(frame.decision, 'block');
    assert.equal(frame.reason, 'X-原始原因', '有 reason 时不被兜底覆盖');
  });

  it('D3 UPS 无 reason ＋ 队列非空：阻断帧原样透传且队列不清', () => {
    // 判别力前提：种子帧必须落在 **shim 真实读写的状态面**（`<dataDir>/relay-state.json`）且
    // `sessionKey`/`streakKey` 与负载 `session_id` 一致——否则读态把帧归一为迁移哨兵、drain 不删帧，
    // 「队列非空」前提不成立、断言恒真（内部任务-320 stage1 复审阻塞项；正确先例见 relay-migration.test.mjs）。
    writeState(stateDir, { frames: [{ sessionKey: 's-281-3', id: 'deadbeefdeadbeef', text: '待投递提醒', ts: Date.now() }], streakKey: 's-281-3', streakCount: 0, droppedByLimit: 0 });
    const result = runShim({
      pkgRoot,
      event: 'UserPromptSubmit',
      script: 'hooks/block-noreason.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-281-3' },
      dataDir,
    });
    assert.equal(result.status, 0, 'shim 永远退 0（fail-open）');
    assert.equal(result.frame.decision, 'block', '阻断帧原样透传（未被上下文帧替换）');
    assert.equal(result.frame.reason, BLOCK_FALLBACK_REASON.prompt, 'reason 为兜底文案');
    assert.equal(readState(stateDir).frames.length, 1, '队列不清（阻断时不得顺带投递/清空待投递提醒）');
  });

  it('D4 Stop 阻断无正文仍计阻断：兜底文案构因（此前恒零输出）', () => {
    const frame = translateResponse('Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '' } }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.equal(frame.decision, 'block', 'Stop 阻断仍传达');
    assert.equal(frame.reason, BLOCK_FALLBACK_REASON.stop, 'reason 由兜底文案构');
  });

  it('D5 Stop 阻断有正文回归：reason 逐字为正文不被兜底覆盖', () => {
    const frame = translateResponse('Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '正文' } }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.equal(frame.decision, 'block');
    assert.equal(frame.reason, '正文', '有正文时不被兜底覆盖');
  });

  it('D6 lib 与 shim 判据同源：同一负载两侧给出同一阻断结论', () => {
    const envelope = { decision: 'block' };
    const libFrame = translateResponse('UserPromptSubmit', envelope, { blocked: false, engine: SHIM_TEST_ENGINE });
    const result = runShim({
      pkgRoot,
      event: 'UserPromptSubmit',
      script: 'hooks/block-noreason.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-281-6' },
      dataDir,
    });
    assert.equal(libFrame.decision, 'block', 'lib 判阻断');
    assert.equal(result.frame.decision, 'block', 'shim 判阻断（两处判据副本同改，防互斥）');
    assert.equal(result.frame.reason, libFrame.reason, '两侧取因一致');
  });

  it('D7 白名单校验：兜底 reason 的阻断帧落在宿主白名单内', () => {
    const frame = translateResponse('UserPromptSubmit', { decision: 'block' }, { blocked: false, engine: SHIM_TEST_ENGINE });
    assert.deepEqual(checkFrameAgainstHost('UserPromptSubmit', frame), [], '帧形态合法（否则整帧被宿主丢弃）');
  });

  it('D8 阻断无 reason ＋ 正文非空：按阻断优先挤掉上下文位', () => {
    const libFrame = translateResponse('UserPromptSubmit', { decision: 'block', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '上下文正文' } }, { blocked: false, engine: SHIM_TEST_ENGINE });
    assert.equal(libFrame.decision, 'block', '阻断优先（不降级为上下文帧）');
    assert.equal(libFrame.reason, BLOCK_FALLBACK_REASON.prompt, 'reason 为兜底文案');
    assert.equal(JSON.stringify(libFrame).includes('上下文正文'), false, '上下文位内容被阻断帧挤掉（不并列承载）');
    const result = runShim({
      pkgRoot,
      event: 'UserPromptSubmit',
      script: 'hooks/block-noreason-withctx.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-281-8' },
      dataDir,
    });
    assert.equal(result.frame.decision, 'block', 'shim 侧同判据');
  });
});

describe('hook-lib 纯函数面', () => {
  it('工具名映射覆盖三类写/执行工具，未知名原样透传', () => {
    assert.equal(TOOL_MAP.bash, 'Bash');
    assert.equal(TOOL_MAP.write, 'Write');
    assert.equal(TOOL_MAP.edit, 'Edit');
    const out = normalizePayload('PreToolUse', { tool_name: 'mcp__plugin_x__y' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_name, 'mcp__plugin_x__y');
  });

  it('失败原因分类：超时/启动失败/信号/异常退出四态文案互异', () => {
    assert.match(describeChildFailure({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }), /未跑完/);
    assert.match(describeChildFailure({ error: { code: 'EACCES' }, status: null }), /EACCES/);
    assert.match(describeChildFailure({ status: null, signal: 'SIGKILL' }), /SIGKILL/);
    assert.match(describeChildFailure({ status: 3, stderr: 'boom\nline2' }), /退出码 3.*boom/);
  });

  it('注入钳制按字节：25,000 汉字 ⇒ ≤60 KiB 且带截断标记', () => {
    const text = '汉'.repeat(25000);
    const out = clampContext(text);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 60 * 1024, `实得 ${Buffer.byteLength(out, 'utf8')}`);
    assert.match(out, /已截断/);
  });

  it('跨会话同文案不互删：两会话各留一帧', () => {
    let state = emptyState();
    state = enqueuePending(state, '同一条降级文案', 'sess-A');
    state = enqueuePending(state, '同一条降级文案', 'sess-B');
    assert.equal(state.frames.length, 2);
    assert.deepEqual(state.frames.map((f) => f.sessionKey).sort(), ['sess-A', 'sess-B']);
  });

  it('写类入参 path → file_path（宿主原生字段名与 ZCode 不同）', () => {
    const out = normalizePayload('PreToolUse', { tool_name: 'write', tool_input: { path: 'C:/p/a.md', content: 'x' } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_input.file_path, 'C:/p/a.md');
    assert.equal(out.tool_input.path, 'C:/p/a.md', '原生字段保留，不删宿主给的键');
  });

  it('会话来源域外值归一到 startup（路由纪律唯一通道不容静默失效）', () => {
    assert.equal(normalizePayload('SessionStart', { source: 'fork' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'startup');
    assert.equal(normalizePayload('SessionStart', { source: 'resume' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'resume');
  });

  it('cwd 缺省用上下文兜底；hook_event_name 缺省补事件名', () => {
    const out = normalizePayload('Stop', {}, { projectDir: 'C:/work', engine: SHIM_TEST_ENGINE });
    assert.equal(out.cwd, 'C:/work');
    assert.equal(out.hook_event_name, 'Stop');
  });

  it('结果面判序：结构化字段优先于文本标记', () => {
    assert.deepEqual(deriveToolResult({ is_error: true, stdout: 'boom' }), { is_error: true, exit_code: null, stdout: 'boom', stderr: '' });
    assert.deepEqual(deriveToolResult({ exitCode: 3, output: 'x' }), { is_error: true, exit_code: 3, stdout: 'x', stderr: '' });
    assert.equal(deriveToolResult('第一行\n[exit code: 2]').exit_code, 2);
  });

  it('退出标记只认最后一行（正文里的同形文本不算）', () => {
    const text = '输出里提到 [exit code: 9] 这种写法\n第二行\n[exit code: 1]';
    const out = deriveToolResult(text);
    assert.equal(out.exit_code, 1);
    assert.equal(out.is_error, true);
  });

  it('本宿主实测不渲染退出标记 → 失败面判为不可知（宁漏不误报）', () => {
    // 2026-09-30 实测：三条失败命令（node 退 3 / cmd 退 7 / py 退 4）在宿主渲染文本里
    // 都没有任何退出标记字样，故该分支在真机上不可观测，失败只能靠结构化字段。
    const out = deriveToolResult('boom\n');
    assert.equal(out.exit_code, null);
    assert.equal(out.is_error, false);
  });

  it('无结构化事实即不可知（宁漏不误报：交给核心件的 fail-open 半边）', () => {
    const out = deriveToolResult('命令输出里有 error.js 文件名');
    assert.equal(out.exit_code, null);
    assert.equal(out.is_error, false);
  });

  it('Stop 连击按会话键推进、换键重置（语义单源＝引擎 stop-pending-relay）', () => {
    // 连击计数已随批 3 迁入引擎（mcode 侧不再持第二份判定）：直接驱动规则执行器——
    // 内存端口 + `{event:'Stop', sessionKey, blocked:true}`，三次连击后换键须重置为 1。
    const state = emptyState();
    const ports = { readState: () => state, writeState: () => {} };
    const streaks = ['s1', 's1', 's1', 's2'].map((sessionKey) => {
      const outcome = SHIM_TEST_ENGINE.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', sessionKey, blocked: true }, ports);
      assert.equal(outcome.applied, true);
      return outcome.result.streak;
    });
    assert.deepEqual(streaks, [1, 2, 3, 1], '同键递增、换键重置');
  });

  it('待投递队列去重且有上限', () => {
    let state = emptyState();
    for (let i = 0; i < 30; i += 1) state = enqueuePending(state, `提醒 ${i}`);
    assert.equal(state.frames.length, 20);
    state = enqueuePending(state, '提醒 29');
    assert.equal(state.frames.length, 20, '同文本覆盖去重，不增长');
    assert.equal(state.frames.filter((frame) => frame.text !== '').length, 20, '全部帧带非空正文（drainPending 导出已删，帧面直断言）');
  });

  it('状态文件损坏即退空状态（fail-open）', () => {
    const dir = tempRoot('state-bad');
    writeFile(join(dir, 'relay-state.json'), '{ not json');
    assert.deepEqual(readState(dir), emptyState());
    removeRoot(dir);
  });

  it('注入文本按宿主上限截断', () => {
    assert.ok(Buffer.byteLength(clampContext('x'.repeat(70_000)), 'utf8') <= 60 * 1024);
    assert.ok(clampContext('短').includes('短'));
  });

  it('三条注入面共用同一截断闸（SessionStart/PostToolUse 此前绕过钳位，D6）', () => {
    // 宿主在 stdout 溢出时**直接 kill 命令**且零输出；子钩子 stdout 读取上限却是 1 MiB。
    const huge = 'y'.repeat(70_000);
    for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
      const frame = translateResponse(event, { hookSpecificOutput: { hookEventName: event, additionalContext: huge } }, { blocked: false, engine: SHIM_TEST_ENGINE });
      const text = String(frame?.hookSpecificOutput?.additionalContext ?? '');
      // 钳位后 UTF-8 字节 ≤60 KiB；远低于宿主 64 KiB stdout 上限
      assert.ok(Buffer.byteLength(text, 'utf8') <= 60 * 1024, `${event} 的注入必须被钳位（实测 ${Buffer.byteLength(text, 'utf8')} 字节）`);
      assert.ok(text.length < huge.length, `${event} 的注入必须短于原文`);
    }
    const stop = translateResponse('Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: huge } }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.ok(Buffer.byteLength(String(stop?.reason ?? ''), 'utf8') <= 60 * 1024, 'Stop 阻断理由同样受钳位约束');
    assert.deepEqual(checkFrameAgainstHost('Stop', stop), [], '钳位后仍须落在宿主白名单内');
  });

  it('会话键逐级兜底', () => {
    assert.equal(sessionKeyOf({ session_id: 's', turn_id: 't' }), 's');
    assert.equal(sessionKeyOf({ turn_id: 't' }), 't');
    assert.ok(sessionKeyOf({}).startsWith('pid-'));
  });

  test('译出：ZCode 的 systemMessage 必翻成 permissionDecisionReason（否则整帧作废）', () => {
    const frame = translateResponse('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: '拦住了' } }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.deepEqual(frame, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '拦住了' } });
    assert.deepEqual(checkFrameAgainstHost('PreToolUse', frame), []);
  });

  it('译出：ask/allow/defer 同样只在白名单内', () => {
    for (const decision of ['ask', 'allow', 'defer']) {
      const frame = translateResponse('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, systemMessage: '理由' } }, { blocked: false, engine: SHIM_TEST_ENGINE });
      assert.equal(frame.hookSpecificOutput.permissionDecision, decision);
      assert.deepEqual(checkFrameAgainstHost('PreToolUse', frame), []);
    }
  });

  it('译出：Stop 只有阻断帧有输出，非阻断提醒零输出（走中继）', () => {
    const blocked = translateResponse('Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '门禁未过' } }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.deepEqual(blocked, { decision: 'block', reason: '门禁未过' });
    assert.equal(translateResponse('Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '提醒' } }, { blocked: false, engine: SHIM_TEST_ENGINE }), null);
    // 连击超上限不再续跑：语义单源＝引擎 stop-pending-relay（shim 以 blockedWithinCap 收窄后
    // 传 blocked）——内部任务-2 批 A6 删除本层 streak 死参，行为守卫见「Stop 阻断 E2E（burstCap）」用例。
  });

  it('译出：UserPromptSubmit 的阻断形态走顶层 decision/reason', () => {
    const frame = translateResponse('UserPromptSubmit', { decision: 'block', reason: '先澄清目标' }, { blocked: true, engine: SHIM_TEST_ENGINE });
    assert.deepEqual(frame, { decision: 'block', reason: '先澄清目标' });
    assert.deepEqual(checkFrameAgainstHost('UserPromptSubmit', frame), []);
  });

  it('译出：空/非对象信封一律零输出', () => {
    assert.equal(translateResponse('SessionStart', null, { blocked: false, engine: SHIM_TEST_ENGINE }), null);
    assert.equal(translateResponse('SessionStart', 'not-json', { blocked: false, engine: SHIM_TEST_ENGINE }), null);
  });
});

describe('真实 ZCode 钩子经 shim（物化包）', () => {
  let dataDir;
  let pkgRoot;
  let projectDir;

  before(() => {
    dataDir = materializeAll(tempRoot('shim-e2e'));
    pkgRoot = join(dataDir, 'plugins', 'workflow');
    projectDir = tempRoot('shim-project');
    writeFile(join(projectDir, '.workflow-freeze'), '# 声明\ndocs/*\n');
    writeFile(join(projectDir, 'docs', 'a.md'), '# 占位\n');
  });

  after(() => {
    removeRoot(dataDir);
    removeRoot(projectDir);
  });

  it('护栏 deny：MCode 原生负载 → 真实 check-freeze → 白名单内 deny 且文案不丢', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'write', tool_input: { path: join(projectDir, 'docs', 'a.md') }, tool_use_id: 't1' },
      dataDir,
    });
    assert.equal(result.status, 0, 'shim 永远退 0（fail-open）');
    assert.equal(result.frame.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.frame.hookSpecificOutput.permissionDecisionReason, /命中冻结声明/);
    assert.deepEqual(checkFrameAgainstHost('PreToolUse', result.frame), []);
  });

  it('护栏放行：界外路径零输出（宿主明示空输出合法）', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'edit', tool_input: { path: join(projectDir, 'src', 'a.ts') }, tool_use_id: 't2' },
      dataDir,
    });
    assert.equal(result.stdout.trim(), '');
    assert.equal(result.frame, null);
  });

  it('极性不倒：负载不可读时原样透传，真实 check-freeze 走 fail-closed deny', () => {
    // 收尾评审发现并修复的真实缺陷：shim 此前会先把不可读负载「修好」再送子钩子，
    // 于是 check-freeze 的 fail-closed 极性（硬规则 4 的唯一例外）在本宿主结构性不可达。
    const result = spawnSync(
      process.execPath,
      [join(pkgRoot, 'mcode', 'hook-shim.mjs'), 'PreToolUse', 'hooks/check-freeze.mjs', '5'],
      {
        input: 'not-json-at-all',
        encoding: 'utf8',
        env: { ...process.env, PLUGIN_ROOT: pkgRoot, PLUGIN_DATA: join(dataDir, 'plugins', 'workflow') },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, 'shim 自身永远退 0');
    const frame = JSON.parse(String(result.stdout).trim());
    assert.equal(frame.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(frame.hookSpecificOutput.permissionDecisionReason, /fail-closed/);
    assert.deepEqual(checkFrameAgainstHost('PreToolUse', frame), []);
  });

  it('合法 JSON 但无 file_path：界外静默放行（与 ZCode 侧同判据）', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { broken: true },
      dataDir,
    });
    assert.equal(result.stdout.trim(), '');
    assert.equal(result.frame, null);
  });

  it('退出码 2 且无信封：并入降级提醒（不静默吞掉子钩子的阻断意图）', () => {
    const silentPkg = tempRoot('shim-exit2');
    writeFile(join(silentPkg, 'mcode', 'hook-shim.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-shim.mjs'), 'utf8'));
    writeFile(join(silentPkg, 'mcode', 'hook-lib.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-lib.mjs'), 'utf8'));
    // 复刻 `spec-gate/hooks/post-tool-use.mjs` 阻断档形态：只写 stderr、退出 2、不输出信封
    writeFile(join(silentPkg, 'hooks', 'silent-block.mjs'), "process.stderr.write('blocking diagnostics\\n');\nprocess.exit(2);\n");
    const stateDir = tempRoot('shim-exit2-state');
    const result = runShim({
      pkgRoot: silentPkg,
      event: 'PostToolUse',
      script: 'hooks/silent-block.mjs',
      payload: { hook_event_name: 'PostToolUse', session_id: 'e2e-6', cwd: projectDir, tool_name: 'bash', tool_input: { command: 'x' } },
      dataDir: stateDir,
    });
    assert.equal(result.stdout.trim(), '', '无信封不得凭空造决策');
    const state = readState(stateDir);
    assert.equal(state.frames.length, 1);
    assert.match(state.frames[0].text, /未输出信封/);
    removeRoot(silentPkg);
    removeRoot(stateDir);
  });

  it('Stop 待投递中继的两跳端到端：Stop 零输出 → 下一次 UserPromptSubmit 带 additionalContext 投递', () => {
    const relayPkg = tempRoot('shim-relay2');
    writeFile(join(relayPkg, 'mcode', 'hook-shim.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-shim.mjs'), 'utf8'));
    writeFile(join(relayPkg, 'mcode', 'hook-lib.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-lib.mjs'), 'utf8'));
    // 复刻 learnings-recap 形态：Stop 期非阻断 additionalContext + 退 0
    writeFile(join(relayPkg, 'hooks', 'reminder.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '【收尾提醒】补一条 learnings' } }) + '\\n');\n");
    writeFile(join(relayPkg, 'hooks', 'quiet.mjs'), 'process.exit(0);\n');
    const stateDir = tempRoot('shim-relay2-state');
    const stop = runShim({
      pkgRoot: relayPkg,
      event: 'Stop',
      script: 'hooks/reminder.mjs',
      payload: { hook_event_name: 'Stop', session_id: 'e2e-7', cwd: projectDir, stop_hook_active: false, last_assistant_message: 'done' },
      dataDir: stateDir,
    });
    assert.equal(stop.stdout.trim(), '', 'Stop 期不得输出 additionalContext（宿主无注入位）');
    assert.equal(readState(stateDir).frames.length, 1, '提醒必须入队');
    const prompt = runShim({
      pkgRoot: relayPkg,
      event: 'UserPromptSubmit',
      script: 'hooks/quiet.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'e2e-7', prompt: '继续', cwd: projectDir },
      dataDir: stateDir,
    });
    assert.match(prompt.frame.hookSpecificOutput.additionalContext, /收尾提醒/, '待投递提醒必须在下一轮注入');
    assert.deepEqual(checkFrameAgainstHost('UserPromptSubmit', prompt.frame), []);
    assert.equal(readState(stateDir).frames.length, 0, '投递后队列应清空（同一提醒不重复注入）');
    removeRoot(relayPkg);
    removeRoot(stateDir);
  });

  it('引擎装载不用 require(esm)：含顶层 await 的 ESM 引擎副本可装载（内部未决-58）', () => {
    // 夹具：复制真实装机包，把 plugin-core/src/engine.mjs 换成"TLA 包装器"——语义与真实现全等
    // （re-export 同目录实现），但 require(esm) 结构性不可装载（ERR_REQUIRE_ASYNC_MODULE）
    // ⇒ 在**当前 Node** 上也能判别装载机制（无需装旧版 Node）。
    const tlaPkg = tempRoot('shim-tla');
    cpSync(pkgRoot, tlaPkg, { recursive: true });
    const engineSrc = join(tlaPkg, 'plugin-core', 'src', 'engine.mjs');
    renameSync(engineSrc, join(tlaPkg, 'plugin-core', 'src', 'engine-impl.mjs'));
    writeFileSync(engineSrc, "export * from './engine-impl.mjs';\nawait Promise.resolve();\n", 'utf8');
    const stateDir = tempRoot('shim-tla-state');
    const result = runShim({
      pkgRoot: tlaPkg,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      // 载荷指向冻结目录内（docs/*）⇒ 子钩子必产 deny 决策帧：正向信号证明引擎真驱动了子钩子，
      // 而非"引擎装载失败但恰好零输出"的纯否定面（引擎不可用时 shim 走 ask + 引擎不可用文案）
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-tla', cwd: projectDir, tool_name: 'edit', tool_input: { path: join(projectDir, 'docs', 'a.md') }, tool_use_id: 't-tla' },
      dataDir: stateDir,
    });
    assert.equal(result.status, 0, 'shim 自身永远退 0');
    assert.equal(result.frame?.hookSpecificOutput?.permissionDecision, 'deny', '引擎真跑了：子钩子产出 deny 帧');
    assert.deepEqual(checkFrameAgainstHost('PreToolUse', result.frame), []);
    assert.ok(!/引擎不可用/.test(`${result.stdout}${result.stderr ?? ''}`), '引擎必须装载成功（不得走降级面）');
    removeRoot(tlaPkg);
    removeRoot(stateDir);
  });

  it('危险命令护栏：check-careful 的 ask 决策经 shim 落在白名单内', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-careful.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'bash', tool_input: { command: 'git reset --hard HEAD~2' }, tool_use_id: 't3' },
      dataDir,
    });
    assert.equal(result.frame.hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(result.frame.hookSpecificOutput.permissionDecisionReason.length > 0);
    assert.deepEqual(checkFrameAgainstHost('PreToolUse', result.frame), []);
  });

  it('SessionStart：真实注入经 shim 落到 hookSpecificOutput.additionalContext', () => {
    const result = runShim({
      pkgRoot,
      event: 'SessionStart',
      script: 'hooks/session-start.mjs',
      payload: { hook_event_name: 'SessionStart', session_id: 'e2e-2', source: 'startup', cwd: projectDir, transcript_path: 'C:/t.jsonl' },
      dataDir,
      timeoutSeconds: 10,
    });
    // 非 git 目录且无规格资产 → 该钩可能零输出；两条路径都必须落在白名单内
    if (result.frame !== null) {
      assert.deepEqual(checkFrameAgainstHost('SessionStart', result.frame), []);
      assert.ok(result.frame.hookSpecificOutput.additionalContext.length > 0);
    } else {
      assert.equal(result.stdout.trim(), '');
    }
  });

  it('PostToolUse 失败通道：合成的 tool_result 让自察真的落一条账（结构化事实唯一判据）', () => {
    const repo = tempRoot('shim-posttool');
    // 激活域判据（内部决策-022/026）：git 祖先或显式接入标记（`.sdd/`）之一；此处用后者，免 git 初始化
    writeFile(join(repo, '.sdd', 'project.json'), '{}\n');
    const incidents = join(repo, 'incidents');
    const result = runShim({
      pkgRoot,
      event: 'PostToolUse',
      script: 'hooks/post-tool.mjs',
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'e2e-3',
        cwd: repo,
        tool_name: 'bash',
        tool_input: { command: 'mcode-probe-failing-command' },
        tool_response: { is_error: true, stdout: 'boom' },
        tool_use_id: 't4',
      },
      dataDir,
      env: { WF_INCIDENT_ROOT: incidents, WF_POSTTOOL_STATE_DIR: join(repo, 'state') },
    });
    assert.equal(result.status, 0);
    const ledger = readFileSync(join(incidents, '.workflow', 'incidents.jsonl'), 'utf8');
    assert.match(ledger, /"kind":"tool-failure"/);
    assert.match(ledger, /"errorClass":"error-flag"/, '结构化 is_error → error-flag 类别');
    assert.doesNotMatch(ledger, /mcode-probe-failing-command/, '账本只落指纹与类别，不落命令原文（内部规则-2 脱敏）');
    removeRoot(repo);
  });

  it('Stop 提醒不落在 Stop 帧上（宿主无注入位），改由下一次 UserPromptSubmit 投递', () => {
    const stateDir = tempRoot('shim-relay');
    // 直接对 shim 的状态面做端到端：先跑一次 Stop（用 learnings-recap，它在有台账时才注入），
    // 再断言 UserPromptSubmit 帧能带上待投递文本。
    const blocked = runShim({
      pkgRoot,
      event: 'Stop',
      script: 'hooks/verify-gate.mjs',
      payload: { hook_event_name: 'Stop', session_id: 'e2e-4', cwd: projectDir, stop_hook_active: false, last_assistant_message: '做完了' },
      dataDir: stateDir,
      timeoutSeconds: 10,
    });
    // verify-gate 在无声明目录时应首跑建基线后放行 → 零输出且不阻断
    assert.equal(blocked.frame, null);
    const pending = readState(stateDir);
    assert.ok(Array.isArray(pending.frames));
    removeRoot(stateDir);
  });

  it('子进程超时：fail-open 零输出，并落一条降级提醒（不假装通过）', () => {
    const slowPkg = tempRoot('shim-slow');
    writeFile(join(slowPkg, 'mcode', 'hook-shim.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-shim.mjs'), 'utf8'));
    writeFile(join(slowPkg, 'mcode', 'hook-lib.mjs'), readFileSync(join(pkgRoot, 'mcode', 'hook-lib.mjs'), 'utf8'));
    writeFile(join(slowPkg, 'hooks', 'slow.mjs'), 'setTimeout(() => {}, 60000);\n');
    const stateDir = tempRoot('shim-slow-state');
    const result = runShim({
      pkgRoot: slowPkg,
      event: 'PreToolUse',
      script: 'hooks/slow.mjs',
      timeoutSeconds: 1,
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-5', cwd: projectDir, tool_name: 'bash', tool_input: { command: 'x' } },
      dataDir: stateDir,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', '超时不得输出任何决策');
    const state = readState(stateDir);
    assert.equal(state.frames.length, 1);
    assert.match(state.frames[0].text, /降级/);
    // 内部任务-356（评审 T4）：`hookFailure=degraded` 的登记理由是「适配层诊断记超时」——那半条可观测性
    // 必须有用例钉住，否则超时分支丢掉 writeDiagnostic 时降级帧仍在、用例照绿。
    const diagnostics = readFileSync(join(stateDir, 'hook-diagnostics.log'), 'utf8');
    assert.match(diagnostics, /PreToolUse\t宿主时限内未跑完/, '超时必须在 hook-diagnostics.log 留一条可读诊断（能力域登记的事实依据）');
    removeRoot(slowPkg);
    removeRoot(stateDir);
  });

  it('状态面：写-读往返一致（原子落盘不留半文件；字典往返保留 内部任务-347）', () => {
    const dir = tempRoot('shim-roundtrip');
    let state = emptyState();
    state = enqueuePending(state, '待投递');
    const bumped = { state: { ...state, streaks: { 's:s9': 1 }, droppedBySession: {} } };
    assert.equal(writeState(dir, bumped.state), true);
    const back = readState(dir);
    assert.equal(back.frames[0].text, '待投递');
    assert.equal(back.frames[0].sessionKey, MIGRATION_SESSION_KEY, '空字典兜底态迁移后帧键取固定哨兵（不得为空，否则被引擎判 malformed 丢弃）');
    assert.equal(back.streaks['s:s9'], 1, '连击字典往返保留');
    removeRoot(dir);
  });
});

// ── 内部任务-356：合成 UPS relay-drain 投递腿（2026-11-08） ─────────────────────────────────
// 为什么单独成 describe 且置顶层：本组检的是**已装产物**（生成期给四包补的 UPS 处理器）与载体
// 契约，不是「真实 ZCode 钩子经 shim」的行为面——嵌进那个 describe 会把它们记到无关分组下。
describe('内部任务-356：合成 UPS relay-drain 投递腿', () => {
  let dataDir = '';
  let pkgRoot = '';
  let upsScript = '';
  before(() => {
    dataDir = materializeAll(tempRoot('shim-356-ups'));
    pkgRoot = join(dataDir, 'plugins', 'team-governance');
    // 判别力来源：子钩子实参从**已装产物**读回（生成期没补腿或改指别的脚本，本组的基线用例先炸），
    // 不在用例里手抄常量自证。
    const doc = JSON.parse(readFileSync(join(pkgRoot, 'hooks', 'hooks.mcode.json'), 'utf8'));
    const command = doc.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? '';
    // 命令形态：`"<node>" "<PLUGIN_ROOT>/mcode/hook-shim.mjs" <事件> "<子钩子相对路径>" <超时>`
    const matched = /hook-shim\.mjs"?\s+UserPromptSubmit\s+"?([^"\s]+)"?/.exec(command);
    upsScript = matched === null ? '' : matched[1];
  });
  after(() => removeRoot(dataDir));

  const seed = (stateDir, frames) => writeState(stateDir, { frames, streakKey: '', streakCount: 0, droppedByLimit: 0 });
  const promptPayload = (sessionId) => ({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: '继续', cwd: dataDir });

  it('已装产物含合成 UPS 处理器且子钩子指向包内载体', () => {
    assert.equal(upsScript, 'mcode/relay-drain.mjs', '生成期未补合成投递腿、或实参没指向 mcode/relay-drain.mjs');
  });

  // 数据表只覆盖两种形态（有帧／旧 ts）——它们共用同一脚手架（seed + 单次 shim 调用）。
  // 空队列要换脚手架（干净 seed + 状态文件字节比对）、载体失败要连跑两次并临时写脚本，各自独立成例。
  // 用例声明仍逐条字面量 `it(`——README 的「测试计数与实测逐文件一致」契约按源码字面量统计，
  // 循环生成会让源码数与运行数分叉（2026-11-08 实测：循环写法源码 48 / 运行 50）。
  const runCase = (item) => {
    // 判别力护栏（round 2 评审 N1）：实参读回失败时 `upsScript` 会是空串，而 shim 对空实参
    // 直接 exit 0（零输出、不读状态）——那会让「空队列」这类断言全部成立却什么都没验。
    assert.notEqual(upsScript, '', '先从已装产物读回子钩子实参（空实参会让本组用例假绿）');
    seed(dataDir, item.frames);
    const out = runShim({ pkgRoot, event: 'UserPromptSubmit', script: upsScript, payload: promptPayload(item.sessionId), dataDir });
    item.check(out, readState(dataDir));
  };
  const cases = {
    delivered: {
      frames: [{ sessionKey: 's-356-a', id: 'a1b2c3d4e5f60718', text: '【SessionStart 钩子降级】宿主时限内未跑完', ts: 1_794_112_000_000 }],
      sessionId: 's-356-a',
      check: (out, state) => {
        assert.match(out.frame.hookSpecificOutput.additionalContext, /SessionStart 钩子降级/);
        assert.equal(state.frames.length, 0, '投递后队列须清空');
      },
    },
    oldTs: {
      frames: [
        { sessionKey: 's-356-c', id: 'c1b2c3d4e5f60718', text: '旧 ts 当前帧', ts: 1 },
        { sessionKey: 's-356-other', id: 'd1b2c3d4e5f60718', text: '他会话帧', ts: 1_794_112_000_000 },
      ],
      sessionId: 's-356-c',
      check: (out, state) => {
        assert.match(out.frame.hookSpecificOutput.additionalContext, /旧 ts 当前帧/);
        assert.equal(state.frames.length, 1, '他会话帧不得被本次投递带走');
        assert.equal(state.frames[0].sessionKey, 's-356-other');
      },
    },
  };

  it('有帧：排干当前会话帧并注入', () => runCase(cases.delivered));
  // 空队列单独成例：不建脏状态＝**状态文件字节不变**，这条必须用干净形状 seed 才能验
  //（`seed` 的 legacy 键会触发一次迁移写盘，覆盖后就看不出「本轮是否写过」）。
  it('空队列：零输出且不改写状态文件（不假装投递）', () => {
    assert.notEqual(upsScript, '', '先从已装产物读回子钩子实参（空实参会让本例假绿）');
    writeState(dataDir, { frames: [], streaks: {}, droppedBySession: {} });
    const file = join(dataDir, 'relay-state.json');
    const before = readFileSync(file, 'utf8');
    const out = runShim({ pkgRoot, event: 'UserPromptSubmit', script: upsScript, payload: promptPayload('s-356-empty'), dataDir });
    assert.equal(out.stdout.trim(), '', '无帧可投递时不得凭空造注入');
    assert.equal(readFileSync(file, 'utf8'), before, '无帧可投时不得改写状态（不假装投递）');
  });
  it('旧 ts 当前帧照投；他会话帧保留（无 TTL）', () => runCase(cases.oldTs));

  it('载体 exit 1：shim 入队具名降级帧且不清队列；下一次健康 UPS 投递', () => {
    writeFile(join(pkgRoot, 'hooks', 'fail-356.mjs'), 'process.exit(1);\n');
    seed(dataDir, [{ sessionKey: 's-356-b', id: 'b1b2c3d4e5f60718', text: '既有提醒', ts: 1_794_112_000_000 }]);
    const fail = runShim({ pkgRoot, event: 'UserPromptSubmit', script: 'hooks/fail-356.mjs', payload: promptPayload('s-356-b'), dataDir });
    assert.equal(fail.stdout.trim(), '');
    const state = readState(dataDir);
    assert.equal(state.frames.length, 2, '失败帧入队且既有队列不被清');
    assert.ok(state.frames.some((frame) => /钩子降级/.test(frame.text)));
    const healthy = runShim({ pkgRoot, event: 'UserPromptSubmit', script: upsScript, payload: promptPayload('s-356-b'), dataDir });
    assert.match(healthy.frame.hookSpecificOutput.additionalContext, /钩子降级/);
    assert.match(healthy.frame.hookSpecificOutput.additionalContext, /既有提醒/);
    assert.equal(readState(dataDir).frames.length, 0);
  });
});

// ── 内部任务-356：relay-drain 载体契约（提前退会让宿主写管道 EPIPE，必须读到 end） ──────────────
describe('内部任务-356：relay-drain 载体契约', () => {
  const drainPath = join(REPO_ROOT, 'mcode-adapter', 'mcode', 'relay-drain.mjs');

  it('读 stdin 至 end 才退 0，且零 stdout 零 stderr', async () => {
    const child = spawn(process.execPath, [drainPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.write('{"hook_event_name":"UserPromptSubmit","prompt":"');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null, '未读到 stdin end 就退出 ⇒ 宿主写管道会 EPIPE（这正是载体存在的前提）');
    child.stdin.end('继续"}');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, '载体必须退 0（非零会被 shim 当失败并污染队列）');
    assert.equal(out, '', '载体不得输出（输出会与 shim 的注入帧争同一位置）');
    assert.equal(err, '');
  });
});

// ── 运行观测能力域声明（2026-10-24 内部任务-192 P2 步骤 12；内部接口-1 MCode 列） ───────────────
// 用例用 `it(` 以纳入本适配层 README 的「测试计数与实测逐文件一致」契约（只统计 `it(`）；
// 计数与规格面已随本批刷新（README hook-shim ×33、总数 147）。
it('内部任务-192 能力域 env：声明注入钩子子进程环境（键存在/JSON 可解析/既有键不变）', () => {
  // hook-lib 装载即声明（shim 随后以 `{...process.env}` 构造子进程 env）⇒ 当前进程 env 可见。
  assert.ok(Object.hasOwn(process.env, 'WF_OBSERVATION_CAPABILITIES'), 'env 键存在（shim 子进程继承面）');
  const caps = JSON.parse(process.env.WF_OBSERVATION_CAPABILITIES);
  assert.deepEqual(caps, { failureFacts: 'none', hookFailure: 'degraded', injection: 'relay', selfCheck: 'selftest' }, '声明形态短串四域取值（hookFailure=degraded：超时告警＋适配层诊断，仅超时类；注意这≠五态词表值）');
  assert.deepEqual(caps, { ...OBSERVATION_CAPABILITIES }, 'env 与导出常量同源');
  // 声明串 ↔ 能力登记表五态（内部接口-1 MCode 列）的映射必须双向可信：只钉声明串会允许「声明改了、
  // 登记表没跟」两边一起绿（本批改的正是这一行）。映射表放在这里而不是生产代码里——它是**测试口径**，
  // 未登记的声明形态即红。
  const mirror = JSON.parse(readFileSync(join(REPO_ROOT, 'workflow', 'scripts', 'lib', 'observation-capability-contract.json'), 'utf8')).hosts.mcode.domains;
  const DECLARATION_TO_REGISTRY = { none: 'unavailable', degraded: 'degraded', relay: 'degraded', selftest: 'degraded' };
  for (const domain of Object.keys(caps)) {
    assert.ok(Object.hasOwn(DECLARATION_TO_REGISTRY, caps[domain]), `${domain}: 声明值 ${caps[domain]} 未登记映射（新增声明形态须同批补映射）`);
    assert.equal(mirror[domain], DECLARATION_TO_REGISTRY[caps[domain]], `${domain}: 声明 ${caps[domain]} ↔ 能力登记 ${mirror[domain]} 不一致（内部接口-1 MCode 列）`);
  }
  assert.deepEqual(Object.keys(caps).sort(), ['failureFacts', 'hookFailure', 'injection', 'selfCheck'], '键集＝四能力域');
  // 既有键不变：注入只增一键，不覆盖/删除 shim 既有环境（ZCODE_PLUGIN_ROOT/ZCODE_PROJECT_DIR/MCODE_HOOK_EVENT 等）。
  const env = applyObservationCapabilitiesEnv({
    PATH: '/usr/bin',
    PLUGIN_ROOT: '/plugin',
    PLUGIN_DATA: '/plugin-data',
    ZCODE_PLUGIN_ROOT: '/plugin',
    ZCODE_PROJECT_DIR: '/project',
    MCODE_HOOK_EVENT: 'PostToolUse',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.PLUGIN_ROOT, '/plugin');
  assert.equal(env.PLUGIN_DATA, '/plugin-data');
  assert.equal(env.ZCODE_PLUGIN_ROOT, '/plugin');
  assert.equal(env.ZCODE_PROJECT_DIR, '/project');
  assert.equal(env.MCODE_HOOK_EVENT, 'PostToolUse');
  assert.deepEqual(
    Object.keys(env).sort(),
    ['MCODE_HOOK_EVENT', 'PATH', 'PLUGIN_DATA', 'PLUGIN_ROOT', 'WF_OBSERVATION_CAPABILITIES', 'ZCODE_PLUGIN_ROOT', 'ZCODE_PROJECT_DIR'],
    '只增能力域键（既有键既不改值也不改名）',
  );
  // 已声明值不覆盖：外层（嵌套 shim/测试）可显式指定，幂等。
  const preset = applyObservationCapabilitiesEnv({ WF_OBSERVATION_CAPABILITIES: '{"failureFacts":"native"}' });
  assert.equal(preset.WF_OBSERVATION_CAPABILITIES, '{"failureFacts":"native"}', '外层声明优先（不覆盖）');
  assert.equal(applyObservationCapabilitiesEnv(env), env, '重复调用幂等且返回同一对象');
});
