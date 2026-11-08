// 文件：kimi-code-adapter/tests/engine-failure.test.mjs
// 描述：引擎不可得的失败可见面——静态宿主对进程失败 fail-open 且 stderr 非用户可见面，
//       故「引擎不可得」必须自己送到宿主母语可见面：
//       ①PreToolUse → deny JSON + **exit 2** + stderr=恢复指引（差异面：本宿主无 ask 升格位，
//         mcode 的 ask 面改 deny）；②UserPromptSubmit → stdout 诊断纯文本直给（宿主明示直追
//         上下文）；③Stop → 待投递中继，**下一次 UserPromptSubmit 真的送达**；④SessionStart/
//         PostToolUse → 诊断入队 + hook-diagnostics.log（目录先建后写；**不写 stderr**）；
//       ⑤规则库字段漂移（main().catch 兜底）同样走可见面；⑥正例（引擎在场）无降级帧。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { readState } from '../kimi/hook-lib.mjs';
import { checkDenyShape, ensureEngineFixture, materializeAll, removeRoot, runShim, tempRoot } from './helpers.mjs';

const GUIDANCE_FRAGMENTS = ['verify --data-dir', 'install', '请把本提示转述给用户'];

describe('引擎不可得的失败可见面', () => {
  let homeDir;
  let pkgRoot;

  before(() => {
    homeDir = tempRoot('engine-failure');
    pkgRoot = materializeAll(homeDir);
  });

  after(() => {
    removeRoot(homeDir);
  });

  /** 移除夹具包内的引擎副本（模拟副本缺失），用例后恢复。 */
  function withoutEngine(fn) {
    const coreDir = join(pkgRoot, 'plugin-core');
    const backup = `${coreDir}.hold`;
    renameSync(coreDir, backup);
    try {
      return fn(coreDir, backup);
    } finally {
      rmSync(backup, { recursive: true, force: true });
      ensureEngineFixture(pkgRoot);
    }
  }

  test('PreToolUse：deny + exit 2 + 恢复指引（用户可见决策位；本宿主无 ask 升格位）', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir: homeDir, withoutEngine: true, event: 'PreToolUse', script: 'hooks/check-freeze.mjs', payload: { tool_name: 'Bash', tool_input: { command: 'x' } } });
      assert.equal(r.status, 2, '引擎不可得时 PreToolUse 必须 fail-closed 阻断（deny）');
      assert.deepEqual(checkDenyShape(r.frame), []);
      const reason = String(r.frame.hookSpecificOutput?.permissionDecisionReason ?? '');
      for (const fragment of GUIDANCE_FRAGMENTS) assert.ok(reason.includes(fragment), `reason 应含 ${fragment}`);
      assert.match(r.stderr, /引擎不可用/, 'stderr 同文案（belt-and-braces 兜底通道）');
    });
  });

  it('UserPromptSubmit：stdout 诊断纯文本直给（宿主明示直追上下文）', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir: homeDir, withoutEngine: true, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { prompt: '继续' } });
      assert.equal(r.status, 0);
      assert.match(r.text, /钩子降级/, '诊断必须以纯文本直给');
      for (const fragment of GUIDANCE_FRAGMENTS) assert.ok(r.text.includes(fragment), `诊断应含 ${fragment}`);
    });
  });

  it('SessionStart：诊断入队 + hook-diagnostics.log；不写 stderr', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir: homeDir, withoutEngine: true, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: { source: 'startup' } });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '', '宿主 stderr 非用户可见面，不得依赖');
      assert.equal(r.stdout.trim(), '', 'SessionStart 无注入位：诊断帧入队而非 stdout');
      const state = readState(join(homeDir, 'plugin-data', 'workflow'));
      assert.ok(state.frames.some((frame) => /引擎不可用/.test(frame.text)), '诊断必须入待投递队列');
      const logPath = join(homeDir, 'plugin-data', 'workflow', 'hook-diagnostics.log');
      assert.ok(existsSync(logPath), '诊断日志必须落盘');
      const text = readFileSync(logPath, 'utf8');
      assert.ok(text.includes('SessionStart'), '日志应含事件名');
      assert.ok(text.includes('verify --data-dir'), '日志应含恢复指引');
    });
  });

  it('PostToolUse：诊断同样入队 + 落日志（观察面无注入位）', () => {
    withoutEngine(() => {
      const r = runShim({ pkgRoot, dataDir: homeDir, withoutEngine: true, event: 'PostToolUse', script: 'hooks/post-tool.mjs', payload: { tool_name: 'Bash', tool_input: { command: 'x' } } });
      assert.equal(r.status, 0);
      const state = readState(join(homeDir, 'plugin-data', 'workflow'));
      assert.ok(state.frames.some((frame) => /引擎不可用/.test(frame.text)), '观察面诊断必须入队');
    });
  });

  it('Stop：诊断入队 → 引擎恢复后下一轮 UserPromptSubmit 真的送达（兜底链闭合）', () => {
    withoutEngine(() => {
      const stop = runShim({ pkgRoot, dataDir: homeDir, withoutEngine: true, event: 'Stop', script: 'hooks/verify-gate.mjs', payload: { session_id: 's1' } });
      assert.equal(stop.status, 0);
      assert.equal(stop.frame, null, 'Stop 无注入位 ⇒ 不得产出帧');
    });
    const next = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { session_id: 's1', prompt: 'hi', cwd: homeDir } });
    assert.match(next.text, /引擎不可用/, `待投递诊断必须在本轮送达（实得：${next.text.slice(0, 80)}）`);
  });

  it('诊断落点：目录**事前不存在**时仍先建后写日志（mkdirSync 判别力）', () => {
    const missingHome = tempRoot('engine-failure-fresh');
    try {
      withoutEngine(() => {
        const r = runShim({ pkgRoot, dataDir: missingHome, withoutEngine: true, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: {} });
        assert.equal(r.status, 0);
        const logPath = join(missingHome, 'plugin-data', 'workflow', 'hook-diagnostics.log');
        assert.ok(existsSync(logPath), `目录不存在时也必须先建目录再落日志：${logPath}`);
        assert.ok(readFileSync(logPath, 'utf8').includes('SessionStart'), '日志须含本次事件');
      });
    } finally {
      removeRoot(missingHome);
    }
  });

  it('规则库字段漂移：具名抛错改走可见面（main().catch 兜底判别力）', () => {
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'source-widen-normalize') delete rule.params.kimi;
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      const r = runShim({ pkgRoot, dataDir: homeDir, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: { source: 'startup' } });
      const state = readState(join(homeDir, 'plugin-data', 'workflow'));
      const text = state.frames.map((frame) => frame.text).join('\n');
      assert.match(text, /钩子降级/, `漂移必须给可见面（实得队列：${text.slice(0, 120)}）`);
      assert.match(text, /规则库字段契约漂移/, '文案须指名漂移类别');
      const logText = readFileSync(join(homeDir, 'plugin-data', 'workflow', 'hook-diagnostics.log'), 'utf8');
      assert.ok(logText.includes('规则库字段契约漂移'), '诊断日志须同记');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  });

  it('正例：引擎在场时不产出任何降级帧（独立状态面，防前序用例队列残留误判）', () => {
    const freshHome = tempRoot('engine-failure-pos');
    try {
      const r = runShim({ pkgRoot, dataDir: freshHome, event: 'SessionStart', script: 'hooks/session-start.mjs', payload: { source: 'startup' } });
      assert.equal(r.frame, null);
      const state = readState(join(freshHome, 'plugin-data', 'workflow'));
      assert.ok(!state.frames.some((frame) => /钩子降级|引擎不可用/.test(frame.text)), '正常路径不得出现降级文案');
    } finally {
      removeRoot(freshHome);
    }
  });
});
