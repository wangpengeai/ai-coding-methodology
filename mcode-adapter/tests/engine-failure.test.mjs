// 文件：引擎不可得的失败可见面测试（批 3 步骤 4）
// 描述：静态宿主对进程失败 fail-open 且不给用户看 stderr，故「引擎不可得」必须自己送到可见面：
//       ①`PreToolUse` ⇒ ask + reason（用户可见决策位）；②其余事件 ⇒ 诊断帧（`additionalContext`），
//       文案含**恢复指引**与**请转述给用户**；③`Stop` ⇒ 待投递中继，**下一次 `UserPromptSubmit` 真的送达**
//       （仅断言"入队"不足）；④诊断追加到 `PLUGIN_DATA/hook-diagnostics.log`（计划指定落点，禁 stderr）；
//       ⑤正例（引擎在场）⇒ 无降级帧。
// 作者：wangp  创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "tests/engine-failure.test.mjs"
// 自检：本文件即自检
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { checkFrameAgainstHost, ensureEngineFixture, materializeAll, removeRoot, runShim, tempRoot } from './helpers.mjs';
import { emptyState, readState, sweepStaleTmp } from '../mcode/hook-lib.mjs';

const GUIDANCE_FRAGMENTS = ['node mcode-adapter/cli.mjs verify', 'install', '请把本提示转述给用户'];

describe('引擎不可得的失败可见面（批 3 步骤 4）', () => {
  let dataDir;
  let pkgRoot;

  before(() => {
    dataDir = materializeAll(tempRoot('engine-failure'));
    pkgRoot = join(dataDir, 'plugins', 'workflow');
  });

  after(() => {
    removeRoot(dataDir);
  });

  /** 移除夹具包内的引擎副本（模拟副本缺失），并在用例后恢复。 */
  function withoutEngine(fn) {
    const coreDir = join(pkgRoot, 'plugin-core');
    const backup = `${coreDir}.bak`;
    rmSync(coreDir, { recursive: true, force: true });
    try {
      return fn(coreDir, backup);
    } finally {
      rmSync(backup, { recursive: true, force: true });
      ensureEngineFixture(pkgRoot);
    }
  }

  /** 断言某事件的诊断帧：存在、含全部指引片段、且落在宿主白名单内。 */  function assertDiagnosticFrame(event) {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir, withoutEngine: true, event, script: 'hooks/session-start.mjs', payload: { hook_event_name: event } });
      assert.ok(r.frame, '必须有帧');
      const text = String(r.frame.hookSpecificOutput?.additionalContext ?? '');
      for (const fragment of GUIDANCE_FRAGMENTS) assert.ok(text.includes(fragment), `诊断帧应含 ${fragment}`);
      assert.deepEqual(checkFrameAgainstHost(event, r.frame), [], '诊断帧必须落在宿主白名单内');
    });
  }

  it('PreToolUse：升格为 ask + 恢复指引（用户可见决策位）', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir, withoutEngine: true, event: 'PreToolUse', script: 'hooks/check-freeze.mjs', payload: { tool_name: 'bash', tool_input: { command: 'x' } } });
      assert.ok(r.frame, '必须有帧');
      const hso = r.frame.hookSpecificOutput;
      assert.equal(hso.permissionDecision, 'ask');
      for (const fragment of GUIDANCE_FRAGMENTS) assert.ok(String(hso.permissionDecisionReason).includes(fragment), `reason 应含 ${fragment}`);
    });
  });

  // 逐事件显式展开（不用 for 循环）：README 计数契约按字面量 `it(` 统计，循环会让"文档 5 项 /
  // 运行期 7 项"错位——门 A 三维同时指出该盲区，故此处显式写开，字面＝运行期。
  it('SessionStart：诊断帧含恢复指引与转述要求', () => {
    assertDiagnosticFrame('SessionStart');
  });

  it('UserPromptSubmit：诊断帧含恢复指引与转述要求', () => {
    assertDiagnosticFrame('UserPromptSubmit');
  });

  it('PostToolUse：诊断帧含恢复指引与转述要求', () => {
    assertDiagnosticFrame('PostToolUse');
  });

  it('诊断落点：PLUGIN_DATA/hook-diagnostics.log 存在且含本次记录（不写 stderr）', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir, withoutEngine: true, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: {} });
      assert.equal(r.stderr, '', '不得写 stderr（宿主侧用户不可见）');
      // `runShim` 把 PLUGIN_DATA 设为传入的 dataDir（真实装机时＝该插件的数据目录），
      // 故诊断落点 = `<PLUGIN_DATA>/hook-diagnostics.log`
      const logPath = join(dataDir, 'hook-diagnostics.log');
      assert.ok(existsSync(logPath), `诊断日志应存在：${logPath}`);
      const text = readFileSync(logPath, 'utf8');
      assert.ok(text.includes('SessionStart'), '日志应含事件名');
      assert.ok(text.includes('node mcode-adapter/cli.mjs verify'), '日志应含恢复指引');
      assert.ok(text.includes('install'), '日志应含重跑 install 指引');
    });
  });

  it('Stop：入队待投递 → 引擎恢复后下一轮 UserPromptSubmit 真的送达（兜底链闭合）', () => {
    withoutEngine(() => {
      const stop = runShim({ pkgRoot, dataDir, withoutEngine: true, event: 'Stop', script: 'hooks/stop.mjs', payload: { session_id: 's1' } });
      assert.equal(stop.frame, null, 'Stop 无注入位 ⇒ 不得产出帧');
    });
    // 引擎恢复后：下一轮 UserPromptSubmit 走正常路径，应投递此前入队的降级提醒
    const next = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { session_id: 's1', prompt: 'hi' } });
    const text = String(next.frame?.hookSpecificOutput?.additionalContext ?? '');
    assert.ok(text.includes('钩子降级'), `待投递提醒必须在本轮送达（实得：${text.slice(0, 80)}）`);
  });

  it('正例：引擎在场时不产出任何降级帧', () => {
    const r = runShim({ pkgRoot, dataDir, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: {} });
    const text = String(r.frame?.hookSpecificOutput?.additionalContext ?? '');
    assert.ok(!text.includes('钩子降级'), '正常路径不得出现降级文案');
  });
  it('诊断落点：PLUGIN_DATA 目录**事前不存在**时仍落日志（mkdirSync 判别力）', () => {
    const missingDir = join(dataDir, 'fresh-not-yet-created');
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir: missingDir, withoutEngine: true, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: {} });
      assert.ok(r.frame, '诊断帧仍须发出');
      const logPath = join(missingDir, 'hook-diagnostics.log');
      assert.ok(existsSync(logPath), `目录不存在时也必须先建目录再落日志：${logPath}`);
      assert.ok(readFileSync(logPath, 'utf8').includes('SessionStart'), '日志须含本次事件');
    });
  });

  it('规则库字段漂移：具名抛错改走可见面（门 B F3 兜底 catch 判别力）', () => {
    // 形态：包内 `source-widen-normalize` 去掉 `params.mcode`（保留 dsh 键 ⇒ 过装载校验、消费点抛错）
    // ⇒ 兜底 catch 必须按事件给面 + 落诊断日志；退回静默时本用例红（终审列出的零判别力缺口）。
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'source-widen-normalize') delete rule.params.mcode;
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      const r = runShim({ pkgRoot, dataDir, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: { source: 'startup' } });
      const text = String(r.frame?.hookSpecificOutput?.additionalContext ?? '');
      assert.match(text, /钩子降级/, `漂移必须给可见面（实得帧：${JSON.stringify(r.frame)}）`);
      assert.match(text, /规则库字段契约漂移/, '文案须指名漂移类别');
      const logText = readFileSync(join(dataDir, 'hook-diagnostics.log'), 'utf8');
      assert.ok(logText.includes('规则库字段契约漂移'), '诊断日志须同记');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  });

  it('状态面失败可见：relay-state.json 为目录 ⇒ 诊断日志记「状态落盘失败」', () => {
    const statePath = join(dataDir, 'relay-state.json');
    rmSync(statePath, { force: true, recursive: true });
    mkdirSync(statePath, { recursive: true });
    try {
      const r = runShim({ pkgRoot, dataDir, event: 'PreToolUse', script: 'hooks/nope.mjs', payload: { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'x' } } });
      assert.equal(r.status, 0, '状态写失败仍须 fail-open');
      const logText = readFileSync(join(dataDir, 'hook-diagnostics.log'), 'utf8');
      assert.match(logText, /状态落盘失败/, '写失败必须落诊断');
      assert.match(logText, /子钩子异常退出|启动失败/, '失败原因须分类（不得统一误报超时）');
    } finally {
      rmSync(statePath, { recursive: true, force: true });
    }
  });

  // 内部任务-295 复审 round3 N-b：`exit 2 且无信封` 是**跨宿主能力差**（本宿主无该事件阻断位），
  // 属设计内分支；指引不得把用户引向「检查钩子脚本」——那是真故障才该说的话。
  it('子钩子 exit 2 无信封 ⇒ 指引标为能力差，不误导去修插件', () => {
    const scriptRel = 'hooks/exit2-stub.mjs';
    const scriptAbs = join(pkgRoot, scriptRel);
    writeFileSync(scriptAbs, 'process.exit(2);\n');
    try {
      const r = runShim({ pkgRoot, dataDir, event: 'PreToolUse', script: scriptRel, payload: { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'x' } } });
      assert.equal(r.status, 0, '无信封阻断仍须 fail-open');
      const lastLine = readFileSync(join(dataDir, 'hook-diagnostics.log'), 'utf8').trim().split(/\r?\n/).at(-1);
      assert.match(String(lastLine), /没有阻断位/, '须标为跨宿主能力差');
      assert.ok(!/子钩子未正常返回/.test(String(lastLine)), '不得把能力差说成子钩子故障');
    } finally { rmSync(scriptAbs, { force: true }); }
  });

  it('readState 损坏 ⇒ onError 可见且返回空状态', () => {
    const dir = tempRoot('state-corrupt');
    try {
      writeFileSync(join(dir, 'relay-state.json'), '{ broken');
      const problems = [];
      const state = readState(dir, (error) => problems.push(error.message));
      assert.deepEqual(state, emptyState());
      assert.equal(problems.length, 1, '损坏必须经 onError 可见');
    } finally { removeRoot(dir); }
  });

  // 内部任务-295 复审 round2 N0/N7：状态文件缺失是常态（首次运行/从未降级），不得报成「读取失败」；
  // 而「可解析但形状非法」与解析失败同级，必须可见。
  it('readState 缺失（ENOENT）⇒ 不报 onError（缺失不是故障）', () => {
    const dir = tempRoot('state-enoent');
    try {
      const problems = [];
      const state = readState(dir, (error) => problems.push(error.message));
      assert.deepEqual(state, emptyState());
      assert.equal(problems.length, 0, 'ENOENT 属常态，不得写「状态读取失败」诊断');
    } finally { removeRoot(dir); }
  });

  it('readState 形状非法（顶层是数组）⇒ 报 onError 而不是静默退空', () => {
    const dir = tempRoot('state-shape');
    try {
      writeFileSync(join(dir, 'relay-state.json'), '[]');
      const problems = [];
      assert.deepEqual(readState(dir, (error) => problems.push(error.message)), emptyState());
      assert.equal(problems.length, 1, '形状非法必须可见');
      assert.match(String(problems[0]), /形状非法/);
    } finally { removeRoot(dir); }
  });

  // ── 内部任务-347 批 C（内部未决-285）：tmp 残留清扫 ──

  it('内部未决-285 sweepStaleTmp：死 pid＋超龄清、活 pid（含 EPERM 语义）与新鲜件留', () => {
    const dir = tempRoot('sweep-mcode');
    try {
      const mk = (name, ageMs) => {
        const p = join(dir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(p, 'x', 'utf8');
        utimesSync(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
      };
      mk('relay-state.json.tmp-999999-abcdef', 2 * 3600_000); // 死 pid＋超龄 → 清
      mk(`relay-state.json.tmp-${process.pid}-abcdef`, 2 * 3600_000); // 活 pid → 留
      mk('relay-state.json.tmp-999998-abcdef', 60_000); // 死 pid 但新鲜 → 留
      const removed = sweepStaleTmp(dir);
      assert.equal(removed, 1, '恰清一件');
      assert.equal(existsSync(join(dir, 'relay-state.json.tmp-999999-abcdef')), false);
      assert.equal(existsSync(join(dir, `relay-state.json.tmp-${process.pid}-abcdef`)), true);
      assert.equal(existsSync(join(dir, 'relay-state.json.tmp-999998-abcdef')), true);
    } finally { removeRoot(dir); }
  });

  it('内部未决-285 sweepStaleTmp EPERM 语义：System pid（存在但拒权限）视为存活跳过', () => {
    if (process.platform !== 'win32') return; // EPERM 夹具只在 Windows 稳定（pid4=System）
    const dir = tempRoot('sweep-mcode-epm');
    try {
      const p = join(dir, 'relay-state.json.tmp-4-abcdef');
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, 'x', 'utf8');
      utimesSync(p, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
      assert.equal(sweepStaleTmp(dir), 0, 'EPERM＝存活 ⇒ 跳过（catch 即判死的错误实现必红）');
      assert.equal(existsSync(p), true);
    } finally { removeRoot(dir); }
  });
});
