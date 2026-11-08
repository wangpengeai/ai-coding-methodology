// 文件：kimi-code-adapter/tests/hook-shim.test.mjs
// 描述：shim 面的两层测试——① 纯函数面（`hook-lib.mjs` 的归一/译出/状态/结果面判序）；
//       ② **真实钩子进程面**：以 Kimi 形态负载驱动物化包内的 ZCode 原钩子，逐条断言
//       ①deny 双通道（stdout JSON + exit 2 + stderr）落在宿主文档两键白名单内
//       ②ask 保守翻 deny（本宿主无 ask 文档位）③check-freeze fail-closed 极性经垃圾字节
//       透传保真 ④观察面帧入待投递队列、下一次 UserPromptSubmit 投递 ⑤spec-gate 硬阻断档
//       （exit 2 无信封）原生直通 ⑥子进程超时零帧 fail-open ⑦workflow 压缩回放静态脚本
//       成功/失败/非 workflow 判别（内部任务-297）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { loadEngine } from '../../plugin-core/src/engine.mjs';

import {
  PENDING_LIMIT,
  BLOCK_FALLBACK_REASON,
  clampContext,
  deriveToolResult,
  drainPending,
  emptyState,
  enqueuePending,
  normalizePayload,
  readState,
  resolveBlockReason,
  resolveProjectRootDetailed,
  resolveSessionProjectRootDetailed,
  sessionKeyOf,
  translatePreToolUseResponse,
  writeState,
} from '../kimi/hook-lib.mjs';
import { checkDenyShape, materializeAll, removeRoot, runShim, tempRoot, writeFile, REPO_ROOT } from './helpers.mjs';

// 纯函数面的来源归一/槽位迁移已由引擎单源（无引擎即具名抛错），用例传入真实引擎。
const SHIM_TEST_ENGINE = loadEngine(REPO_ROOT);

describe('hook-lib 纯函数面', () => {
  it('工具名多键兼容（tool_name|name），未知名原样透传', () => {
    assert.equal(normalizePayload('PreToolUse', { tool_name: 'Write' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).tool_name, 'Write');
    assert.equal(normalizePayload('PreToolUse', { name: 'Edit' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).tool_name, 'Edit');
    const out = normalizePayload('PreToolUse', { tool_name: 'mcp__plugin_x__y' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_name, 'mcp__plugin_x__y');
  });

  it('写类入参 path → file_path（宿主原生字段名与 ZCode 不同），原生键保留', () => {
    const out = normalizePayload('PreToolUse', { tool_name: 'Write', tool_input: { path: 'C:/p/a.md', content: 'x' } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_input.file_path, 'C:/p/a.md');
    assert.equal(out.tool_input.path, 'C:/p/a.md', '原生字段保留，不删宿主给的键');
  });

  it('prompt 多键兼容（prompt|text）', () => {
    assert.equal(normalizePayload('UserPromptSubmit', { prompt: '继续' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).prompt, '继续');
    assert.equal(normalizePayload('UserPromptSubmit', { text: '继续' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).prompt, '继续');
  });

  it('Kimi 桌面端 UPS 真机形态（2026-10-05 探针钉死）：prompt 为消息块数组 → 拼接各块 text', () => {
    const real = normalizePayload('UserPromptSubmit', { prompt: [{ type: 'text', text: '继续' }], is_steer: false }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(real.prompt, '继续');
    const multi = normalizePayload('UserPromptSubmit', { prompt: [{ type: 'text', text: '第一段' }, { type: 'image', url: 'data:image/png;base64,x' }, { type: 'text', text: '第二段' }] }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(multi.prompt, '第一段\n第二段', '非 text 块（图片等）跳过，text 块按序换行拼接');
    const stringStill = normalizePayload('UserPromptSubmit', { prompt: '裸字符串仍兼容' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(stringStill.prompt, '裸字符串仍兼容');
    const emptyBlocks = normalizePayload('UserPromptSubmit', { prompt: [] }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(emptyBlocks.prompt, '', '空块数组覆写为空串（子钩按无 prompt 静默，忠实转发）');
  });

  it('会话来源域外值归一到 startup（accepted=[startup,resume]，引擎单源）；resume 保留', () => {
    assert.equal(normalizePayload('SessionStart', { source: 'clear' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'startup');
    assert.equal(normalizePayload('SessionStart', { source: 'compact' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'startup');
    assert.equal(normalizePayload('SessionStart', { source: 'resume' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'resume');
    assert.equal(normalizePayload('SessionStart', { source: 'startup' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE }).source, 'startup');
  });

  it('hook_event_name 以 argv 事件为权威；cwd 缺省用上下文兜底', () => {
    const out = normalizePayload('Stop', { hook_event_name: 'Hacked' }, { projectDir: 'C:/work', engine: SHIM_TEST_ENGINE });
    assert.equal(out.hook_event_name, 'Stop');
    assert.equal(out.cwd, 'C:/work');
  });

  it('来源归一无引擎即具名抛错（禁回落内联白名单＝禁第二份策略实现）', () => {
    assert.throws(() => normalizePayload('SessionStart', { source: 'fork' }, { projectDir: 'C:/p' }), /ctx\.engine/);
  });

  it('结果面判序：结构化字段优先于文本标记', () => {
    assert.deepEqual(deriveToolResult({ is_error: true, stdout: 'boom' }), { is_error: true, exit_code: null, stdout: 'boom', stderr: '' });
    assert.deepEqual(deriveToolResult({ exitCode: 3, output: 'x' }), { is_error: true, exit_code: 3, stdout: 'x', stderr: '' });
    assert.equal(deriveToolResult('第一行\n[exit code: 2]').exit_code, 2);
  });

  it('退出标记只认最后一行（正文里的同形文本不算）', () => {
    const out = deriveToolResult('输出里提到 [exit code: 9] 这种写法\n第二行\n[exit code: 1]');
    assert.equal(out.exit_code, 1);
    assert.equal(out.is_error, true);
  });

  it('宁漏不误报：无结构化事实判不可知；刻意不读 status（MCP 形态防误记）', () => {
    const unknown = deriveToolResult('命令输出里有 error.js 文件名');
    assert.equal(unknown.exit_code, null);
    assert.equal(unknown.is_error, false);
    const httpLike = deriveToolResult({ status: 500, stdout: 'x' });
    assert.equal(httpLike.exit_code, null, 'status 不得被当退出码（OPEN-46 纪律）');
    assert.equal(httpLike.is_error, false);
  });

  it('Kimi 失败面（实机 2026-10-05 探针）：error.message 提取退出码；error.code 类别串不冒认', () => {
    const real = deriveToolResult({ error: { code: 'internal', message: 'Process exited with code 3\nCommand failed with exit code: 3.', retryable: false } });
    assert.equal(real.is_error, true);
    assert.equal(real.exit_code, 3);
    assert.match(real.stderr, /exit code: 3/);
    const alt = deriveToolResult({ error: { code: 'internal', message: 'Command failed with exit code: 7.' } });
    assert.equal(alt.exit_code, 7, '第二句式（Command failed with …）同样可提取');
    const noCode = deriveToolResult({ error: { code: 'internal', message: '连接被拒绝' } });
    assert.equal(noCode.is_error, true);
    assert.equal(noCode.exit_code, null, 'message 无可提取退出码时保持不可知（宁漏不误报）');
    const classOnly = deriveToolResult({ error: { code: 'internal' } });
    assert.equal(classOnly.exit_code, null, 'code=internal 是类别串，不得冒认为退出码');
  });

  it('OPEN-116：error.code 类别串透传 errorCode（不冒认退出码取舍不变；语义收口在核心件 classifyResult 的 CODE_RE+errorClass 门控）', () => {
    const withCode = deriveToolResult({ error: { code: 'internal', message: 'Process exited with code 3\nCommand failed with exit code: 3.', retryable: false } });
    assert.equal(withCode.errorCode, 'internal', '宿主码面透传为 errorCode（类别串非退出码）');
    assert.equal(withCode.exit_code, 3, '退出码仍从 message 提取（不冒认取舍不变）');
    const noCode = deriveToolResult({ error: { message: '连接被拒绝' } });
    assert.equal(noCode.errorCode, '', '无 code 键缺省空串（classifyResult CODE_RE 拒收空串，语义单源）');
    assert.equal(noCode.is_error, true);
    const okRun = deriveToolResult({ tool_output: 'done' });
    assert.equal(okRun.errorCode, undefined, '成功面不携带 errorCode（仅真失败类）');
    const textRun = deriveToolResult('ok\n[exit code: 0]');
    assert.equal(textRun.errorCode, undefined, '文本分支不携带 errorCode');
  });

  it('OPEN-116：normalizePayload 结果事件端到端——顶层 error 对象经 deriveToolResult 合成 tool_result.errorCode', () => {
    const out = normalizePayload('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'x' }, error: { code: 'internal', message: 'Process exited with code 5.', retryable: false } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_result.errorCode, 'internal');
    assert.equal(out.tool_result.exit_code, 5);
    const noCode = normalizePayload('PostToolUse', { tool_name: 'Bash', error: { message: 'boom' } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(noCode.tool_result.errorCode, '');
  });

  it('Kimi 成功面（实机 2026-10-05 探针）：tool_output 渲染文本入 stdout，无结构化事实判成功不可知', () => {
    const okRun = deriveToolResult({ tool_output: 'Command executed successfully.' });
    assert.equal(okRun.is_error, false);
    assert.equal(okRun.exit_code, null);
    assert.equal(okRun.stdout, 'Command executed successfully.');
  });

  it('normalizePayload 在结果事件识别 Kimi 原生负载（error/tool_output 顶层键，实机形态）', () => {
    const failure = normalizePayload('PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'node -e "process.exit(3)"' },
      error: { code: 'internal', message: 'Process exited with code 3\nCommand failed with exit code: 3.', retryable: false },
    }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(failure.tool_result.is_error, true);
    assert.equal(failure.tool_result.exit_code, 3);
    const success = normalizePayload('PostToolUse', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'node --version' }, tool_output: 'Command executed successfully.',
    }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(success.tool_result.is_error, false);
    assert.equal(success.tool_result.exit_code, null);
  });

  test('项目根解析链（OPEN-75 实机缺口）：桌面端 cwd=应用目录时按 tool_input.path 上溯推断', () => {
    const rootOf = (payload) => resolveProjectRootDetailed(payload).root;
    // ① cwd 自带项目标记（.git/.sdd）→ 直用（CLI 形态预期路径）
    assert.equal(rootOf({ cwd: REPO_ROOT }), REPO_ROOT);
    // ② cwd=宿主应用安装目录（实机桌面端形态）+ 写类 path 在项目内 → 首个标记目录
    const appDir = 'C:/Users/example/AppData/Local/Programs/Kimi Code';
    assert.equal(rootOf({ cwd: appDir, tool_input: { path: `${REPO_ROOT}/specs/README.md` } }), REPO_ROOT);
    assert.equal(rootOf({ cwd: appDir, tool_input: { file_path: `${REPO_ROOT}/README.md` } }), REPO_ROOT);
    // ③ 无标记无 path → 忠于宿主 cwd 兜底（错位进可见面登记，而非静默猜根）
    assert.equal(rootOf({ cwd: appDir }), appDir);
    assert.equal(rootOf({}), process.cwd());
  });

  it('项目根会话缓存：写类事件暖 cache，Bash 类负载（无 path 提示）同会话键复用（真机缺口处置）', () => {
    const stateDir = tempRoot('projroot-cache');
    const appDir = 'C:/Users/example/AppData/Local/Programs/Kimi Code';
    const session = { session_id: 'sess-cache-1' };
    // 写类事件（path-walk）暖 cache：解析正确根并落缓存
    const editPayload = { ...session, cwd: appDir, tool_input: { path: `${REPO_ROOT}/specs/README.md` } };
    assert.equal(resolveSessionProjectRootDetailed(editPayload, stateDir).root, REPO_ROOT);
    // Bash 类负载同会话键：无 path 提示 → 复用缓存根（不再退应用目录）
    const bashPayload = { ...session, cwd: appDir, tool_input: { command: 'node --version' } };
    assert.equal(resolveSessionProjectRootDetailed(bashPayload, stateDir).root, REPO_ROOT);
    // 会话键不同 → 缓存不串话，退解析链兜底（忠于宿主）
    const otherSession = { session_id: 'sess-other', cwd: appDir, tool_input: { command: 'x' } };
    assert.equal(resolveSessionProjectRootDetailed(otherSession, stateDir).root, appDir);
    // 缓存根标记失效（所指根无 .git/.sdd）→ 守卫拒绝采用，退兜底
    const staleDir = tempRoot('projroot-stale');
    resolveSessionProjectRootDetailed({ session_id: 'sess-stale', cwd: appDir, tool_input: { path: `${REPO_ROOT}/specs/README.md` } }, staleDir);
    // 缓存按会话分槽（内部任务-305 B9）：把该会话的槽位写成无标记的失效根
    const staleDigest = createHash('sha256').update('sess-stale').digest('hex').slice(0, 12);
    writeFile(`${staleDir}/project-root-${staleDigest}.json`, `${JSON.stringify({ sessionKey: 'sess-stale', root: `${staleDir}/gone` })}\n`);
    assert.equal(resolveSessionProjectRootDetailed({ session_id: 'sess-stale', cwd: appDir, tool_input: { command: 'x' } }, staleDir).root, appDir);
  });

  it('Kimi 实测键 tool_call_id → ZCode 键 tool_use_id（post-tool 调用键，真机探针钉死）', () => {
    const out = normalizePayload('PostToolUseFailure', { tool_name: 'Bash', tool_call_id: 'tool_AbC123', tool_input: { command: 'x' } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_use_id, 'tool_AbC123');
    const keep = normalizePayload('PostToolUseFailure', { tool_use_id: 'uid-existing', tool_call_id: 'tool_AbC123' }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(keep.tool_use_id, 'uid-existing', '原生 tool_use_id 优先，不覆盖');
  });

  it('normalizePayload 在结果事件从 tool_response 合成 tool_result（PostToolUseFailure 亦同）', () => {
    const out = normalizePayload('PostToolUseFailure', { tool_response: { is_error: true, stdout: 'boom' } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.equal(out.tool_result.is_error, true);
    const own = normalizePayload('PostToolUse', { tool_result: { is_error: false, exit_code: 0 } }, { projectDir: 'C:/p', engine: SHIM_TEST_ENGINE });
    assert.deepEqual(own.tool_result, { is_error: false, exit_code: 0 }, 'payload 自带 tool_result 直用');
  });

  it('译出：deny 双通道（stdout JSON + exit 2 + stderr）且两键白名单', () => {
    const action = translatePreToolUseResponse({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: '拦住了' } }, { engine: SHIM_TEST_ENGINE });
    assert.equal(action.exit, 2);
    assert.equal(action.stderr, '拦住了');
    assert.deepEqual(checkDenyShape(JSON.parse(action.stdout)), []);
    assert.match(action.stdout, /permissionDecisionReason/);
    assert.ok(!action.stdout.includes('hookEventName'), '宿主文档两键白名单，信封内层不得带第三键');
  });

  it('译出：ask 保守翻 deny（reason 前缀「需用户确认：」——本宿主无 ask 文档位）', () => {
    const action = translatePreToolUseResponse({ hookSpecificOutput: { permissionDecision: 'ask', systemMessage: '建议确认' } }, { engine: SHIM_TEST_ENGINE });
    assert.equal(action.exit, 2);
    const frame = JSON.parse(action.stdout);
    assert.equal(frame.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(frame.hookSpecificOutput.permissionDecisionReason, /^需用户确认：/);
    assert.deepEqual(checkDenyShape(frame), []);
  });

  it('译出：allow/defer/无决策/空信封一律零输出', () => {
    for (const decision of ['allow', 'defer']) {
      assert.equal(translatePreToolUseResponse({ hookSpecificOutput: { permissionDecision: decision, systemMessage: 'x' } }, { engine: SHIM_TEST_ENGINE }), null);
    }
    assert.equal(translatePreToolUseResponse(null, { engine: SHIM_TEST_ENGINE }), null);
    assert.equal(translatePreToolUseResponse('not-json', { engine: SHIM_TEST_ENGINE }), null);
  });

  it('三条注入面共用同一 32k 截断闸（deny 经译出；UPS/Stop 经同一 clampContext）', () => {
    const huge = 'y'.repeat(60_000);
    const deny = translatePreToolUseResponse({ hookSpecificOutput: { permissionDecision: 'deny', systemMessage: huge } }, { engine: SHIM_TEST_ENGINE });
    assert.ok(deny.stderr.length <= 33_000 && deny.stderr.length < huge.length, 'deny 文案必须钳位');
    assert.ok(clampContext(huge).length <= 33_001 && clampContext(huge).length < huge.length, 'UPS 文本必须钳位');
    assert.ok(clampContext(resolveBlockReason('', huge, BLOCK_FALLBACK_REASON.stop)).length <= 33_000, 'Stop 阻断理由必须钳位（stderr 回退链）');
  });

  it('待投递队列去重且有上限（同文本覆盖，超 20 丢最旧）', () => {
    let state = emptyState();
    for (let i = 0; i < 30; i += 1) state = enqueuePending(state, `提醒 ${i}`);
    assert.equal(state.frames.length, PENDING_LIMIT);
    state = enqueuePending(state, '提醒 29');
    assert.equal(state.frames.length, PENDING_LIMIT, '同文本覆盖去重，不增长');
    assert.equal(drainPending(state).split('\n').length, PENDING_LIMIT);
  });

  it('状态文件损坏即退空状态（fail-open）；写-读往返一致（显式会话键忠实保留；字典往返保留 DEV-347）', () => {
    const dir = tempRoot('state-roundtrip');
    writeFile(join(dir, 'relay-state.json'), '{ not json');
    assert.deepEqual(readState(dir), emptyState());
    let state = enqueuePending(emptyState(), '待投递', 'sess-x');
    assert.equal(writeState(dir, { ...state, streaks: { 's:s9': 1 }, droppedBySession: { 's:s9': 2 } }), true);
    const back = readState(dir);
    assert.equal(back.frames[0].text, '待投递');
    assert.equal(back.frames[0].sessionKey, 'sess-x', '帧键=入队显式会话键（观察面忠实，不再错挂兜底键/哨兵）');
    assert.equal(back.streaks['s:s9'], 1, '连击字典往返保留');
    assert.equal(back.droppedBySession['s:s9'], 2, '淘汰字典往返保留');
    removeRoot(dir);
  });

  it('会话键逐级兜底（session_id 缺席退 pid）', () => {
    assert.equal(sessionKeyOf({ session_id: 's' }), 's');
    assert.equal(sessionKeyOf({ sessionId: 's2' }), 's2');
    assert.ok(sessionKeyOf({}).startsWith('pid-'));
  });

  it('截断闸：短文本原样通过', () => {
    assert.equal(clampContext('短'), '短');
    assert.ok(clampContext('x'.repeat(40_000)).endsWith('\n…（已截断）'));
  });
});

describe('真实 ZCode 钩子经 shim（物化包）', () => {
  let homeDir;
  let pkgRoot;
  let projectDir;

  before(() => {
    homeDir = tempRoot('shim-e2e');
    pkgRoot = materializeAll(homeDir);
    projectDir = tempRoot('shim-project');
    writeFile(join(projectDir, '.workflow-freeze'), '# 声明\ndocs/*\n');
    writeFile(join(projectDir, 'docs', 'a.md'), '# 占位\n');
    writeFile(join(pkgRoot, 'hooks', 'block-unrecognized.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { foo: 'bar' } }) + '\\n');\nprocess.exit(2);\n");
    writeFile(join(pkgRoot, 'hooks', 'block-stop-empty.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop' } }) + '\\n');\nprocess.exit(2);\n");
    writeFile(join(pkgRoot, 'hooks', 'block-prompt-empty.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block' }) + '\\n');\n");
  });

  after(() => {
    removeRoot(homeDir);
    removeRoot(projectDir);
  });

  it('护栏 deny：Kimi 原生负载 → 真实 check-freeze → exit 2 + 双通道 + 两键白名单', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'Write', tool_input: { path: join(projectDir, 'docs', 'a.md') }, tool_use_id: 't1' },
      dataDir: homeDir,
    });
    assert.equal(result.status, 2, 'deny 必须 exit 2（宿主阻断语义）');
    assert.deepEqual(checkDenyShape(result.frame), []);
    assert.match(result.frame.hookSpecificOutput.permissionDecisionReason, /命中冻结声明/);
    assert.match(result.stderr, /命中冻结声明/, 'stderr 同文案（belt-and-braces 兜底通道）');
  });

  it('护栏放行：界外路径零输出 exit 0（宿主明示空输出合法）', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'Edit', tool_input: { path: join(projectDir, 'src', 'a.ts') }, tool_use_id: 't2' },
      dataDir: homeDir,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  });

  it('A6 PreToolUse exit 2 + 不可识别信封 → 兜底 deny（不得静默放行）', () => {
    const result = runShim({ pkgRoot, dataDir: homeDir, event: 'PreToolUse', script: 'hooks/block-unrecognized.mjs', payload: { session_id: 'a6-pretool', cwd: projectDir, tool_name: 'Write', tool_input: { path: join(projectDir, 'docs', 'a.md') } } });
    assert.equal(result.status, 2, 'exit 2 不得被降为放行');
    assert.deepEqual(checkDenyShape(result.frame), []);
    assert.match(result.frame.hookSpecificOutput.permissionDecisionReason, /信封不可识别/);
    assert.match(result.stderr, /信封不可识别/);
  });

  it('A6 Stop blocked + 空文本 → 通用原因阻断；超 cap 后降级 exit 0', () => {
    const stop = () => runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/block-stop-empty.mjs', payload: { session_id: 'a6-stop' } });
    for (let i = 1; i <= 3; i += 1) {
      const r = stop();
      assert.equal(r.status, 2, `第 ${i} 次空文本阻断仍须阻断`);
      assert.match(r.stderr, /未提供可读原因/);
    }
    const fourth = stop();
    assert.equal(fourth.status, 0, '超 cap 后不得把降级改回阻断');
  });

  it('A6 UPS block + 空 reason → 通用原因阻断（不得降格为上下文）', () => {
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/block-prompt-empty.mjs', payload: { session_id: 'a6-ups', prompt: 'x' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /未提供可读原因/);
    assert.equal(r.stdout.trim(), '');
  });

  it('A7 shim containment：scriptRel 越出包根 → exit 0 + 诊断，不 spawn', () => {
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'PreToolUse', script: '../evil.mjs', payload: { session_id: 'a7', cwd: projectDir } });
    assert.equal(r.status, 0);
    const log = readFileSync(join(homeDir, 'plugin-data', 'workflow', 'hook-diagnostics.log'), 'utf8');
    assert.match(log, /越出包根/);
  });

  it('极性不倒：负载不可读时原样透传垃圾字节，真实 check-freeze 走 fail-closed deny', () => {
    const result = spawnSync(
      process.execPath,
      [join(pkgRoot, 'kimi', 'hook-shim.mjs'), 'PreToolUse', 'hooks/check-freeze.mjs', '5'],
      {
        input: 'not-json-at-all',
        encoding: 'utf8',
        env: { ...process.env, KIMI_CODE_HOME: homeDir },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 2, 'fail-closed 极性必须可达：exit 2');
    const frame = JSON.parse(String(result.stdout).trim());
    assert.equal(frame.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(frame.hookSpecificOutput.permissionDecisionReason, /fail-closed/);
    assert.deepEqual(checkDenyShape(frame), []);
  });

  it('危险命令护栏：check-careful 的 ask 经 shim 保守翻 deny（前缀「需用户确认：」）', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-careful.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-1', cwd: projectDir, tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~2' }, tool_use_id: 't3' },
      dataDir: homeDir,
    });
    assert.equal(result.status, 2, 'ask 保守翻 deny 后必须阻断');
    assert.equal(result.frame.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.frame.hookSpecificOutput.permissionDecisionReason, /^需用户确认：/);
    assert.deepEqual(checkDenyShape(result.frame), []);
  });

  it('SessionStart：真实钩子（workflow 元技能注入）经 shim 入待投递队列、零帧 exit 0', () => {
    const stateDir = tempRoot('shim-session-state');
    const result = runShim({
      pkgRoot,
      event: 'SessionStart',
      script: 'hooks/session-start.mjs',
      payload: { hook_event_name: 'SessionStart', session_id: 'e2e-2', source: 'startup', cwd: projectDir, transcript_path: 'C:/t.jsonl' },
      dataDir: stateDir,
      timeoutSeconds: 10,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', '观察面无注入位：stdout 必须零帧');
    const state = readState(join(stateDir, 'plugin-data', 'workflow'));
    assert.ok(state.frames.length > 0, 'SessionStart 帧必须入队（差异面 row 1）');
    assert.ok(state.frames.some((f) => f.sessionKey === 'e2e-2'), '帧会话键须忠实（e2e-2）');
    assert.ok(state.frames.some((f) => /路由表|元技能/.test(f.text)), '帧正文须含元技能注入内容');
    removeRoot(stateDir);
  });

  it('PostToolUse 失败通道：合成的 tool_result 让真实 post-tool.mjs 真的落一条账', () => {
    const repo = tempRoot('shim-posttool');
    // 激活域判据（内部决策-022/026）：git 祖先或显式接入标记（`.sdd/`）之一；此处用后者，免 git 初始化
    writeFile(join(repo, '.sdd', 'project.json'), '{}\n');
    const incidents = join(repo, 'incidents');
    const result = runShim({
      pkgRoot,
      event: 'PostToolUseFailure',
      script: 'hooks/post-tool.mjs',
      payload: {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'e2e-3',
        cwd: repo,
        tool_name: 'Bash',
        tool_input: { command: 'kimi-probe-failing-command' },
        tool_response: { is_error: true, stdout: 'boom' },
        tool_use_id: 't4',
      },
      dataDir: homeDir,
      env: { WF_INCIDENT_ROOT: incidents, WF_POSTTOOL_STATE_DIR: join(repo, 'state') },
    });
    assert.equal(result.status, 0);
    const ledger = readFileSync(join(incidents, '.workflow', 'incidents.jsonl'), 'utf8');
    assert.match(ledger, /"kind":"tool-failure"/);
    assert.match(ledger, /"errorClass":"error-flag"/, '结构化 is_error → error-flag 类别');
    assert.doesNotMatch(ledger, /kimi-probe-failing-command/, '账本只落指纹与类别，不落命令原文（脱敏纪律）');
    removeRoot(repo);
  });

  it('spec-gate 硬阻断档（exit 2 无信封）原生直通：exit 2 + stderr=子进程 stderr（差异面 row 11）', () => {
    const repo = tempRoot('shim-sdd-block');
    // 最小 SDD 夹具：套件声明 内部规格，文档含 blocking 诊断（TODO 字面量触发）
    writeFile(join(repo, '.sdd', 'project.json'), '{}\n');
    writeFile(join(repo, '.sdd', 'suite.json'), JSON.stringify({ suiteRoot: '..', documents: [{ path: 'specs/a.md' }] }));
    writeFile(join(repo, 'specs', 'a.md'), '# 夹具\n\nTODO: 自由文本待办标记触发诊断\n');
    const specGatePkg = join(homeDir, 'plugins', 'managed', 'spec-gate');
    const result = runShim({
      pkgRoot: specGatePkg,
      event: 'PostToolUseFailure',
      script: 'hooks/post-tool-use.mjs',
      payload: {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'e2e-5',
        cwd: repo,
        tool_name: 'Write',
        tool_input: { path: join(repo, 'specs', 'a.md') },
        tool_use_id: 't5',
      },
      dataDir: homeDir,
      env: { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: 'true' },
      timeoutSeconds: 60,
    });
    assert.equal(result.status, 2, '硬阻断档必须原样直译 exit 2');
    assert.match(result.stderr, /SDD 规格校验/, 'stderr=子进程 stderr（阻断原因母语位）');
    assert.equal(result.stdout.trim(), '', '无信封不得凭空造决策帧');
    removeRoot(repo);
  });

  it('spec-gate 提醒档（exit 0 有信封）：帧入待投递队列零帧，下一次 UserPromptSubmit 纯文本投递', () => {
    const repo = tempRoot('shim-sdd-remind');
    writeFile(join(repo, '.sdd', 'project.json'), '{}\n');
    writeFile(join(repo, '.sdd', 'suite.json'), JSON.stringify({ suiteRoot: '..', documents: [{ path: 'specs/a.md' }] }));
    writeFile(join(repo, 'specs', 'a.md'), '# 夹具\n\nTODO: 自由文本待办标记触发诊断\n');
    // 夹具包：复制真实物化包再叠加静默 UPS 钩（不动 homeDir 里的真包，保持其可重验）
    const relayPkg = tempRoot('shim-sdd-remind-pkg');
    cpSync(join(homeDir, 'plugins', 'managed', 'spec-gate'), relayPkg, { recursive: true });
    writeFile(join(relayPkg, 'hooks', 'quiet.mjs'), 'process.exit(0);\n');
    const stateDir = tempRoot('shim-sdd-remind-state');
    const stateOf = () => readState(join(stateDir, 'plugin-data', relayPkg.split(/[\\/]/).pop()));
    const post = runShim({
      pkgRoot: relayPkg,
      event: 'PostToolUse',
      script: 'hooks/post-tool-use.mjs',
      payload: { hook_event_name: 'PostToolUse', session_id: 'e2e-6', cwd: repo, tool_name: 'Write', tool_input: { path: join(repo, 'specs', 'a.md') }, tool_use_id: 't6' },
      dataDir: stateDir,
      timeoutSeconds: 60,
    });
    assert.equal(post.status, 0);
    assert.equal(post.stdout.trim(), '', '观察面帧不落 stdout');
    assert.ok(stateOf().frames.some((frame) => /SDD 规格校验/.test(frame.text)), '诊断帧必须入队');
    // 下一个 UserPromptSubmit 投递（静默夹具钉住投递腿本体）
    const prompt = runShim({
      pkgRoot: relayPkg,
      event: 'UserPromptSubmit',
      script: 'hooks/quiet.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'e2e-6', prompt: '继续', cwd: repo },
      dataDir: stateDir,
    });
    assert.equal(prompt.status, 0);
    assert.match(prompt.text, /SDD 规格校验/, '待投递诊断必须在本轮以纯文本送达');
    assert.equal(stateOf().frames.length, 0, '投递后队列清空');
    removeRoot(relayPkg);
    removeRoot(repo);
    removeRoot(stateDir);
  });

  it('Stop 待投递中继两跳：task-recap 形态提醒入队 → 下一次 UserPromptSubmit 投递', () => {
    const relayPkg = tempRoot('shim-relay2');
    cpSync(join(pkgRoot, 'kimi'), join(relayPkg, 'kimi'), { recursive: true });
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
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout.trim(), '', 'Stop 期不得输出 additionalContext（宿主无注入位）');
    assert.equal(readState(join(stateDir, 'plugin-data', basenameOf(relayPkg))).frames.length, 1, '提醒必须入队');
    const prompt = runShim({
      pkgRoot: relayPkg,
      event: 'UserPromptSubmit',
      script: 'hooks/quiet.mjs',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'e2e-7', prompt: '继续', cwd: projectDir },
      dataDir: stateDir,
    });
    assert.match(prompt.text, /收尾提醒/, '待投递提醒必须在下一轮注入');
    assert.equal(readState(join(stateDir, 'plugin-data', basenameOf(relayPkg))).frames.length, 0, '投递后队列应清空');
    removeRoot(relayPkg);
    removeRoot(stateDir);
  });

  it('真实 verify-gate：无声明项目首跑建基线放行（零帧 exit 0），有会话键状态写回', () => {
    const stateDir = tempRoot('shim-gate');
    const result = runShim({
      pkgRoot,
      event: 'Stop',
      script: 'hooks/verify-gate.mjs',
      payload: { hook_event_name: 'Stop', session_id: 'e2e-4', cwd: projectDir, stop_hook_active: false, last_assistant_message: '做完了' },
      dataDir: stateDir,
      timeoutSeconds: 60,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
    const state = readState(join(stateDir, 'plugin-data', 'workflow'));
    assert.equal(state.frames.length, 0, '未声明项目的完成闸零输出（不得入队）');
    removeRoot(stateDir);
  });

  it('子进程超时：exit 0 零帧 fail-open（600s 宿主时限下无 MCode 的提醒分支，差异面 row 8）', () => {
    const slowPkg = tempRoot('shim-slow');
    cpSync(join(pkgRoot, 'kimi'), join(slowPkg, 'kimi'), { recursive: true });
    writeFile(join(slowPkg, 'hooks', 'slow.mjs'), 'setTimeout(() => {}, 60000);\n');
    const stateDir = tempRoot('shim-slow-state');
    const result = runShim({
      pkgRoot: slowPkg,
      event: 'PreToolUse',
      script: 'hooks/slow.mjs',
      timeoutSeconds: 1,
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-8', cwd: projectDir, tool_name: 'Bash', tool_input: { command: 'x' } },
      dataDir: stateDir,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', '超时不得输出任何决策');
    removeRoot(slowPkg);
    removeRoot(stateDir);
  });

  it('包根解析不依赖 env：shim 以自身路径推导（KIMI_PLUGIN_ROOT 缺席照常工作）', () => {
    const result = spawnSync(
      process.execPath,
      [join(pkgRoot, 'kimi', 'hook-shim.mjs'), 'PreToolUse', 'hooks/check-freeze.mjs', '5'],
      {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'e2e-9', cwd: projectDir, tool_name: 'Write', tool_input: { path: join(projectDir, 'docs', 'a.md') } }),
        encoding: 'utf8',
        env: { ...process.env, KIMI_PLUGIN_ROOT: '', KIMI_CODE_HOME: homeDir },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 2, 'env 缺席不得削弱护栏（包根推导以物化位置为准）');
  });

  it('信封键 ⊆ 宿主白名单：deny 帧不得带 hookEventName/systemMessage 等 ZCode 键', () => {
    const result = runShim({
      pkgRoot,
      event: 'PreToolUse',
      script: 'hooks/check-freeze.mjs',
      payload: { hook_event_name: 'PreToolUse', session_id: 'e2e-10', cwd: projectDir, tool_name: 'Write', tool_input: { path: join(projectDir, 'docs', 'a.md') } },
      dataDir: homeDir,
    });
    assert.deepEqual(checkDenyShape(result.frame), [], 'ZCode 信封键经 shim 翻译后必须落在宿主两键白名单内');
  });
});

describe('A3/A4（DEV-2）：超时崩溃面可见化 + 冷会话根解析 fallback 可见化', () => {
  let homeDir;
  let pkgRoot;

  before(() => {
    homeDir = tempRoot('shim-visibility');
    pkgRoot = materializeAll(homeDir);
  });

  after(() => {
    removeRoot(homeDir);
  });

  it('A3 子钩子超时/崩溃（spawn error→timedOut 同分支）：观察面事件入队降级提醒 + exit 0', () => {
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'SessionStart', script: 'hooks/nonexistent-hook.mjs', payload: { source: 'startup', session_id: 'vis-timeout' } });
    assert.equal(r.status, 0, '超时/崩溃面 fail-open 不阻断');
    assert.equal(r.stdout.trim(), '', 'SessionStart 无注入位——提醒入队而非 stdout');
    const state = readState(join(homeDir, 'plugin-data', 'workflow'));
    const frame = state.frames.find((f) => f.text.includes('未作判定'));
    assert.ok(frame, `降级提醒必须入队（实得队列：${state.frames.map((f) => f.text.slice(0, 40)).join(' | ')}）`);
    assert.ok(frame.text.includes('hooks/nonexistent-hook.mjs'), '文案指名未跑完的脚本');
    assert.equal(frame.sessionKey, 'vis-timeout', '降级帧会话键忠实（A3）');
  });

  it('A4 fallback 根（无标记无 path）：UPS 当轮送达「项目根未解析」提醒（同轮入队→投递）+ 诊断日志 via=fallback', () => {
    const appLikeDir = join(homeDir, 'app-dir-no-marker');
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { session_id: 'vis-fallback', prompt: 'hi', cwd: appLikeDir } });
    assert.equal(r.status, 0);
    assert.ok(r.text.includes('项目根未解析'), `UPS 当轮投递腿应送达 fallback 提醒（实得 stdout：${r.text.slice(0, 120)}）`);
    assert.ok(r.text.includes('租约闸'), '提醒须点明护栏可能未生效');
    const logText = readFileSync(join(homeDir, 'plugin-data', 'workflow', 'hook-diagnostics.log'), 'utf8');
    assert.ok(logText.includes('via=fallback'), '诊断日志须记解析路径');
    assert.ok(logText.includes('UserPromptSubmit'), '日志须含事件名');
  });

  it('A4 正例：根解析带标记（cwd-marker）不产生 fallback 提醒帧', () => {
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { session_id: 'vis-marker', prompt: 'hi', cwd: REPO_ROOT } });
    assert.equal(r.status, 0);
    const state = readState(join(homeDir, 'plugin-data', 'workflow'));
    assert.ok(!state.frames.some((f) => f.sessionKey === 'vis-marker' && f.text.includes('项目根未解析')), '标记根不触发提醒');
  });
});

describe('compact-workflow 压缩回放（DEV-297）', () => {
  const makeRoot = (base) => {
    const root = join(base, 'workflow');
    writeFile(join(root, 'kimi', '.keep'), '');
    cpSync(join(REPO_ROOT, 'kimi-code-adapter', 'kimi', 'compact-workflow.mjs'), join(root, 'kimi', 'compact-workflow.mjs'));
    cpSync(join(REPO_ROOT, 'kimi-code-adapter', 'kimi', 'hook-lib.mjs'), join(root, 'kimi', 'hook-lib.mjs'));
    return root;
  };
  const run = (root, dataDir, input) => spawnSync(process.execPath, [join(root, 'kimi', 'compact-workflow.mjs')], {
    input,
    encoding: 'utf8',
    env: { ...process.env, KIMI_CODE_HOME: dataDir },
    windowsHide: true,
  });

  it('workflow 压缩回放：静态元技能入队', () => {
    const base = tempRoot('compact-wf');
    try {
      const root = makeRoot(base);
      writeFile(join(root, 'skills', 'workflow', 'SKILL.md'), '# 元技能全文\n路由表...');
      const dataDir = join(base, 'data');
      const r = run(root, dataDir, JSON.stringify({ session_id: 'compact-ok' }));
      assert.equal(r.status, 0);
      const state = readState(join(dataDir, 'plugin-data', 'workflow'));
      const frame = state.frames.find((item) => item.text.includes('元技能全文'));
      assert.ok(frame, 'SKILL 全文应入队');
      assert.equal(frame.sessionKey, 'compact-ok', '会话键忠实');
    } finally {
      removeRoot(base);
    }
  });

  it('SKILL 缺失：诊断一条＋压缩回放降级提醒入队', () => {
    const base = tempRoot('compact-wf-missing');
    try {
      const root = makeRoot(base);
      const dataDir = join(base, 'data');
      const r = run(root, dataDir, JSON.stringify({ session_id: 'compact-missing' }));
      assert.equal(r.status, 0);
      const diag = readFileSync(join(dataDir, 'plugin-data', 'workflow', 'hook-diagnostics.log'), 'utf8');
      assert.ok(diag.includes('SKILL.md 不可读'), '诊断须点名 SKILL 缺失');
      const state = readState(join(dataDir, 'plugin-data', 'workflow'));
      assert.ok(state.frames.some((item) => item.text.includes('压缩回放降级')), '降级提醒应入队');
      const nonWfRoot = join(base, 'spec-gate');
      cpSync(root, nonWfRoot, { recursive: true });
      const nonWfData = join(base, 'data-nonwf');
      const nonWf = run(nonWfRoot, nonWfData, JSON.stringify({ session_id: 'compact-nonwf' }));
      assert.equal(nonWf.status, 0);
      const nonWfDiag = readFileSync(join(nonWfData, 'plugin-data', 'spec-gate', 'hook-diagnostics.log'), 'utf8');
      assert.ok(nonWfDiag.includes('非 workflow 包触发压缩回放，已忽略'), '非 workflow 包仅诊断');
      assert.equal(readState(join(nonWfData, 'plugin-data', 'spec-gate')).frames.length, 0, '非 workflow 包零入队');
    } finally {
      removeRoot(base);
    }
  });

  it('负载不可读：诊断一条＋压缩回放降级提醒入队', () => {
    const base = tempRoot('compact-wf-bad-payload');
    try {
      const root = makeRoot(base);
      const dataDir = join(base, 'data');
      const r = run(root, dataDir, 'not-json');
      assert.equal(r.status, 0);
      const diag = readFileSync(join(dataDir, 'plugin-data', 'workflow', 'hook-diagnostics.log'), 'utf8');
      assert.ok(diag.includes('负载不可读'), '诊断须点名负载不可读');
      const state = readState(join(dataDir, 'plugin-data', 'workflow'));
      assert.ok(state.frames.some((item) => item.text.includes('压缩回放降级')), '降级提醒应入队');
    } finally {
      removeRoot(base);
    }
  });
});

/** 夹具包目录名（=状态目录 plugin-data 下的插件 id 槽位）。 */
function basenameOf(dir) {
  return dir.split(/[\\/]/).pop();
}
