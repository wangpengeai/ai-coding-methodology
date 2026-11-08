// 文件：relay-behavior.test.mjs
// 描述：待投递中继的行为回归（内部任务-2 批自 relay-migration.test.mjs 恢复——kimi 无旧盘态史，
//       迁移专属用例随 A2 删除迁移分支一并退役；行为守卫全部保留并补跨会话过滤 e2e）：
//       ①合并投递（队列 + 子钩子自身上下文两段并存且清空）；②Stop 连击 E2E（burstCap=3
//       内直译 exit 2，第 4 次降级零帧 + capNote 入队并送达）；③投递腿不吞子钩子阻断帧
//       （队列空/非空双场景——deny 静默变放行的回归守卫）；④burstCap 注入变形（数据驱动）；
//       ⑤relayEvents 观察面帧同队列一并投递；⑥跨会话过滤 e2e（他会话帧不投不丢）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { REPO_ROOT, materializeAll, removeRoot, runShim, tempRoot, writeFile } from './helpers.mjs';
import { readState } from '../kimi/hook-lib.mjs';
import { projectKey } from '../../workflow/hooks/routing-lib.mjs';

const STATE_REL = join('plugin-data', 'workflow', 'relay-state.json');

describe('relay 行为回归（两跳中继/连击/阻断保真/跨会话过滤）', () => {
  let homeDir;
  let pkgRoot;

  before(() => {
    homeDir = tempRoot('relay-behavior');
    pkgRoot = materializeAll(homeDir);
    writeFile(join(pkgRoot, 'hooks', 'block-stop.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '门禁未过' } }) + '\\n');\nprocess.exit(2);\n");
    writeFile(join(pkgRoot, 'hooks', 'block-prompt.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block', reason: '先澄清目标' }) + '\\n');\n");
    writeFile(join(pkgRoot, 'hooks', 'own-context.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '子钩子自身上下文' } }) + '\\n');\n");
    writeFile(join(pkgRoot, 'hooks', 'quiet.mjs'), 'process.exit(0);\n');
    writeFile(join(pkgRoot, 'hooks', 'obs.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '会话注入帧' } }) + '\\n');\n");
    writeFile(join(pkgRoot, 'hooks', 'obs-fail.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: '失败观察帧' } }) + '\\n');\n");
  });

  after(() => {
    removeRoot(homeDir);
  });

  const stateFile = () => join(homeDir, STATE_REL);
  const readStateFile = () => JSON.parse(readFileSync(stateFile(), 'utf8'));

  /** 写新形状盘态（frames 帧自带显式会话键）。 */
  function writeStateFrames(sessionKey, text) {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({
      frames: [{ sessionKey, id: 'a'.repeat(16), text, ts: 1 }],
      streaks: {},
      droppedBySession: {},
    }), 'utf8');
  }

  it('合并投递路径：队列 + 子钩子自身上下文两段并存，且队列清空', () => {
    writeStateFrames('S9', '待投递提醒');
    runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/quiet.mjs', payload: { session_id: 'S9' } });
    const merged = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/own-context.mjs', payload: { session_id: 'S9', prompt: '继续' } });
    assert.match(merged.text, /待投递提醒/, '待投递文本必须在合并结果内');
    assert.match(merged.text, /子钩子自身上下文/, '子钩子自身上下文必须保留');
    assert.equal(readStateFile().frames.length, 0, '合并后同样必须清空队列（否则每轮重复注入）');
  });

  it('Stop 阻断 E2E：burstCap=3 内直译 exit 2 + stderr；第 4 次降级零帧 + capNote 入队并送达', () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S2' } });
      assert.equal(r.status, 2, `第 ${i} 次应直译阻断（exit 2）`);
      assert.match(r.stderr, /门禁未过/, '阻断理由走 stderr 母语位');
      assert.equal(r.stdout.trim(), '', '阻断帧不得走 stdout');
    }
    const fourth = runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S2' } });
    assert.equal(fourth.status, 0, '超上限必须降级零帧（exit 0 放行）');
    assert.equal(fourth.stdout.trim(), '');
    const queued = readStateFile().frames.map((f) => f.text).join('\n');
    assert.match(queued, /门禁未过/);
    assert.match(queued, /连击上限/, '上限文案来自规则 capNote（数据驱动）');
    const delivered = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S2', prompt: '继续' } });
    assert.match(delivered.text, /连击上限/, '降级事实必须送达（不隐藏）');
    assert.equal(readStateFile().frames.length, 0, '送达后队列清空');
  });

  it('真实 workflow 三处理器声明序：非阻断不清零，第 4 轮 verify-gate 降级（DEV-305 A2）', () => {
    const proj = tempRoot('relay-real-proj');
    const session = 'SR-real';
    const trustDir = join(homeDir, 'trust-real');
    const routingDir = join(homeDir, 'routing-real');
    const recapDir = join(homeDir, 'recap-real');
    const learnRoot = join(homeDir, 'learn-root');
    const learnDir = join(homeDir, 'learn-state');
    const incidentDir = join(homeDir, 'incident-real');
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      KIMI_CODE_HOME: homeDir,
      WF_ROUTING_STATE_DIR: routingDir,
      WF_RECAP_STATE_DIR: recapDir,
      WF_LEARNINGS_RECAP_ROOT: learnRoot,
      WF_LEARNINGS_RECAP_STATE_DIR: learnDir,
      WF_INCIDENT_ROOT: incidentDir,
      WF_TRUST_DIR: trustDir,
    };
    const projDigest = createHash('sha256').update(String(projectKey(proj))).digest('hex').slice(0, 16);
    const realRouting = join(homedir(), '.zcode', 'cli', 'routing-state');
    const repoRouting = join(REPO_ROOT, '.workflow', 'routing-state');
    const hasProjState = (dir) => existsSync(dir) && readdirSync(dir).some((name) => name.includes(projDigest));
    try {
      mkdirSync(join(proj, '.git'), { recursive: true });
      mkdirSync(join(proj, '.workflow'), { recursive: true });
      writeFile(join(proj, '.workflow', 'routing.json'), '{"stateRoot":"local"}\n');
      writeFile(join(proj, 'verify.gate'), 'exit 1\n');
      // 本用例从空中继态起测，避免前序用例帧干扰 capNote 断言
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify({ frames: [], streaks: {}, droppedBySession: {} }), 'utf8');
      // 子进程时限取自中立清单声明（verify-gate 60s；task-recap/learnings-recap 5s）——
      // 不得低于被测 hook 的声明上限（否则慢机上判超时走降级路径，用例自身变 flaky）
      const stop = (script, timeoutSeconds = 5) => runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script, timeoutSeconds, payload: { session_id: session, cwd: proj }, env });
      const streak = () => (readState(join(homeDir, 'plugin-data', 'workflow')).streaks[`s:${session}`] ?? 0);
      // 真实轮次起点：用户提示（UPS）归零上一轮连击预算（deliverOn 语义）
      const ups = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/user-prompt.mjs', payload: { session_id: session, cwd: proj, prompt: '继续' }, env });
      assert.equal(ups.status, 0, '用户提示不阻断');
      assert.equal(streak(), 0, '用户提示后连击预算归零');
      for (let turn = 1; turn <= 4; turn += 1) {
        const a = stop('hooks/task-recap.mjs');
        assert.equal(a.status, 0, `turn ${turn}: task-recap 不得阻断`);
        assert.equal(streak(), turn - 1, `turn ${turn}: task-recap 不推进连击`);
        const b = stop('hooks/learnings-recap.mjs');
        assert.equal(b.status, 0, `turn ${turn}: learnings-recap 不得阻断`);
        assert.equal(streak(), turn - 1, `turn ${turn}: learnings-recap 不推进连击`);
        // 每轮删信任基线 → verify-gate 走真实「首次发现」阻断路径（确定性，不依赖 shell 执行）
        rmSync(trustDir, { recursive: true, force: true });
        const c = stop('hooks/verify-gate.mjs', 60);
        if (turn < 4) assert.equal(c.status, 2, `turn ${turn}: verify-gate 应阻断`);
        else assert.equal(c.status, 0, '第 4 轮 verify-gate 应降级');
        assert.equal(streak(), turn, `turn ${turn}: 阻断推进连击`);
      }
      const frames = readState(join(homeDir, 'plugin-data', 'workflow')).frames.map((f) => f.text).join('\n');
      assert.match(frames, /连击上限/, '降级帧须带 capNote');
      assert.match(frames, /verify-gate|首次发现本项目声明文件/, '降级帧须保留原正文');
      assert.ok(!hasProjState(repoRouting), '仓库 .workflow/routing-state 无本测试项目键文件');
      assert.ok(!hasProjState(realRouting), '真实 ~/.zcode/cli/routing-state 无本测试项目键文件');
    } finally {
      removeRoot(proj);
    }
  });

  it('投递腿不得吞掉子钩子的阻断帧（队列空场景）', () => {
    runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S4', prompt: 'x' } });
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/block-prompt.mjs', payload: { session_id: 'S4', prompt: 'x' } });
    assert.equal(r.status, 2, '阻断帧必须经 exit 2 直译（deny 静默变放行的回归守卫）');
    assert.match(r.stderr, /先澄清目标/);
    assert.equal(r.stdout.trim(), '', '阻断形态下 stdout 不得夹带上下文帧');
  });

  it('队列非空时阻断优先且队列原样留待下一次提示（不清、不丢、不串）', () => {
    writeStateFrames('S5', '待投递提醒-队列非空');
    const r = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/block-prompt.mjs', payload: { session_id: 'S5', prompt: 'x' } });
    assert.equal(r.status, 2, '队列非空同样必须保住阻断帧');
    assert.match(r.stderr, /先澄清目标/, '阻断理由不得被中继文本挤掉');
    assert.ok(!r.text.includes('待投递提醒-队列非空'), '阻断帧形态下不得夹带中继文本');
    assert.equal(readStateFile().frames.length, 1, '阻断时不清队列（提醒留待下一次提示再投）');
    const next = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S5', prompt: 'x' } });
    assert.match(next.text, /待投递提醒-队列非空/, '下一轮无阻断时提醒照常送达');
    assert.equal(readStateFile().frames.length, 0, '正常那一轮清空');
  });

  it('burstCap 注入变形：改为 1 时第 2 次阻断即降级（数据驱动，非当前值巧合）', () => {
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'stop-pending-relay') rule.params.kimi.burstCap = 1;
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      const first = runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S3' } });
      assert.equal(first.status, 2, '第 1 次仍直译');
      const second = runShim({ pkgRoot, dataDir: homeDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S3' } });
      assert.equal(second.status, 0, 'cap=1 时第 2 次必须降级（若仍阻断 ⇒ 上限未随规则变化）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  });

  it('relayEvents：SessionStart 与 PostToolUseFailure 帧同队列，UPS 纯文本投递', () => {
    // 状态隔离（内部任务-2 批 A1 起）：投递按会话过滤，前序用例（burstCap 的 S3 降级帧）不再被
    // 本用例的投递顺带清掉——本用例从空状态起测。
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ frames: [], streaks: {}, droppedBySession: {} }), 'utf8');
    runShim({ pkgRoot, dataDir: homeDir, event: 'SessionStart', script: 'hooks/obs.mjs', payload: { session_id: 'S6', source: 'startup' } });
    runShim({ pkgRoot, dataDir: homeDir, event: 'PostToolUseFailure', script: 'hooks/obs-fail.mjs', payload: { session_id: 'S6', tool_name: 'Bash', tool_input: { command: 'x' } } });
    const state = readState(join(homeDir, 'plugin-data', 'workflow'));
    assert.ok(state.frames.some((frame) => /会话注入帧/.test(frame.text)), 'SessionStart 帧必须入队（宿主无注入位）');
    assert.ok(state.frames.some((frame) => /失败观察帧/.test(frame.text)), 'PostToolUseFailure 帧必须入队（原生失败事件，差异面对 mcode 合并缺口不成立）');
    const delivered = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S6', prompt: '继续' } });
    assert.match(delivered.text, /会话注入帧/);
    assert.match(delivered.text, /失败观察帧/);
    assert.equal(readStateFile().frames.length, 0, '两帧一并投递后队列清空');
  });

  it('跨会话过滤 e2e（DEV-2 批 A1/A3）：他会话帧不投给当前会话、也不丢（保留待原会话）', () => {
    writeFileSync(stateFile(), JSON.stringify({
      frames: [
        { sessionKey: 'S-me', id: 'b'.repeat(16), text: '本会话的提醒', ts: 2 },
        { sessionKey: 'S-other', id: 'c'.repeat(16), text: '他会话的提醒', ts: 1 },
      ],
      streaks: {},
      droppedBySession: {},
    }), 'utf8');
    const delivered = runShim({ pkgRoot, dataDir: homeDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S-me', prompt: '继续' } });
    assert.match(delivered.text, /本会话的提醒/, '本会话帧照常送达');
    assert.ok(!delivered.text.includes('他会话的提醒'), '他会话帧不得串话投递');
    const after = readStateFile();
    assert.equal(after.frames.length, 1, '他会话帧保留（不丢弃）');
    assert.equal(after.frames[0].sessionKey, 'S-other');
  });
});
