// 文件：relay 旧态迁移与四条路径分支测试（批 3 步骤 10 / 门 B F4）
// 描述：补上计划点名但此前缺失的迁移回归面——①旧盘态 `{pending:[…],streakKey:''}`（`sessionKey`
//       必须合成**非空**哨兵，否则帧被判 malformed 丢弃）→ 新版本**两跳真实送达**；
//       ②合并投递路径（队列 + 子钩子自身上下文）清空与两段文本并存；
//       ③Stop 阻断 E2E（未超上限直译 `decision:block`；超上限降级零帧 + 规则 `capNote` 入队）；
//       ④`burstCap` **注入变形**（改小即更早降级）——证明"数据驱动"而非当前值巧合。
// 作者：wangp  创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "tests/relay-migration.test.mjs"
// 自检：本文件即自检
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { materializeAll, removeRoot, runShim, tempRoot, writeFile } from './helpers.mjs';

const STATE_FILE = 'relay-state.json';

describe('relay 旧态迁移与路径分支（批 3 步骤 10）', () => {
  let dataDir;
  let pkgRoot;

  before(() => {
    dataDir = materializeAll(tempRoot('relay-migration'));
    pkgRoot = join(dataDir, 'plugins', 'workflow');
    // Stop 阻断夹具（**exit 2** + `hookSpecificOutput.additionalContext`——本层 `blocked` 判据是
    // 退出码，阻断理由取自 `additionalContext`；仓内 verify-gate 即此形态），供连击/上限用例使用
    writeFile(join(pkgRoot, 'hooks', 'block-stop.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '门禁未过' } }) + '\\n');\nprocess.exit(2);\n");
    // UserPromptSubmit 自带上下文的夹具（走合并投递路径）
    writeFile(join(pkgRoot, 'hooks', 'own-context.mjs'), "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '子钩子自身上下文' } }) + '\\n');\n");
    // 静默夹具（零输出 ⇒ 投递腿独立成帧）
    writeFile(join(pkgRoot, 'hooks', 'quiet.mjs'), 'process.exit(0);\n');
  });

  after(() => {
    removeRoot(dataDir);
  });

  /** 写旧形状盘态（`pending` + 可指定 `streakKey`），复刻升级前版本落下的文件。 */
  function writeLegacyState(streakKey) {
    writeFileSync(join(dataDir, STATE_FILE), JSON.stringify({
      pending: [{ id: 'abcdef0123456789', text: '旧版待投递提醒', ts: 1 }],
      streakKey,
      streakCount: 0,
    }), 'utf8');
  }

  const readStateFile = () => JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));

  test('旧盘态（streakKey 为空）⇒ 两跳真实送达，帧键为非空哨兵，状态改写为新形状', () => {
    writeLegacyState('');
    // hop1：Stop（静默夹具）——迁移面被读，写回新形状
    runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/quiet.mjs', payload: { session_id: 'S1' } });
    const afterHop1 = readStateFile();
    assert.ok(Array.isArray(afterHop1.frames), '状态必须已是新形状');
    assert.equal(afterHop1.frames[0].sessionKey, '__mcode_relay_migrated__', '空 streakKey 的旧帧必须合成固定哨兵键（非空）');
    // hop2：UserPromptSubmit —— 旧内容真的送达
    const delivered = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S1' } });
    assert.match(String(delivered.frame?.hookSpecificOutput?.additionalContext ?? ''), /旧版待投递提醒/);
    assert.equal(readStateFile().frames.length, 0, '投递后队列清空');
  });

  it('合并投递路径：队列 + 子钩子自身上下文两段并存，且队列清空', () => {
    writeLegacyState('S9');
    runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/quiet.mjs', payload: { session_id: 'S9' } });
    const merged = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/own-context.mjs', payload: { session_id: 'S9' } });
    const text = String(merged.frame?.hookSpecificOutput?.additionalContext ?? '');
    assert.match(text, /旧版待投递提醒/, '待投递文本必须在合并结果内');
    assert.match(text, /子钩子自身上下文/, '子钩子自身上下文必须保留');
    assert.equal(readStateFile().frames.length, 0, '合并后同样必须清空队列（否则每轮重复注入）');
  });

  it('Stop 阻断 E2E：未超上限直译阻断；第 4 次（burstCap=3）降级为零帧 + capNote 入队', () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S2' } });
      assert.equal(r.frame?.decision, 'block', `第 ${i} 次应直译阻断`);
      assert.match(String(r.frame?.reason ?? ''), /门禁未过/);
    }
    const fourth = runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S2' } });
    assert.equal(fourth.frame, null, '超上限必须零 Stop 帧');
    const queued = readStateFile().frames.map((f) => f.text).join('\n');
    assert.match(queued, /门禁未过/);
    assert.match(queued, /连击上限/, '上限文案来自规则 capNote');
  });

  it('投递腿不得吞掉子钩子的阻断帧（双空场景；门 B F1 守卫用例）', () => {
    // 判别力：把 `hook-shim.mjs` 的 `frame = merged === '' ? frame : …` 回退成
    // `merged === '' ? null : …` 时**本用例必须红**（门 B 复评用变异 M-D/M-E 证明可构造且能判别）。
    writeFile(join(pkgRoot, 'hooks', 'block-prompt.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block', reason: '先澄清目标' }) + '\\n');\n");
    // 先把队列清空（前面的用例可能留下帧），确保是"双空"场景：无待投递 + 子钩子无 additionalContext
    runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S4' } });
    const r = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/block-prompt.mjs', payload: { session_id: 'S4' } });
    assert.equal(r.frame?.decision, 'block', '队列与自身上下文皆空时必须原样保留子钩子的阻断帧（否则 deny 被静默解除）');
    assert.match(String(r.frame?.reason ?? ''), /先澄清目标/);
  });

  it('队列非空时也不得吞掉阻断帧，且队列原样留待下一次提示（D2 真机复现的回归守卫）', () => {
    // 判别力：把 hook-shim 的阻断优先分支去掉（恢复"一律合并成上下文帧"）时**本用例必红**。
    // 真机复现记录：修复前本场景输出 `{"hookSpecificOutput":{…,"additionalContext":"REMINDER…"}}`，
    // 子钩子的 `{decision:'block', reason}` 连同理由一起消失 ⇒ deny 静默变放行。
    writeFile(join(pkgRoot, 'hooks', 'block-prompt.mjs'), "process.stdout.write(JSON.stringify({ decision: 'block', reason: '先澄清目标' }) + '\\n');\n");
    writeFileSync(join(dataDir, STATE_FILE), JSON.stringify({
      frames: [{ sessionKey: 'S5', id: 'deadbeefdeadbeef', text: '待投递提醒-队列非空', ts: 1 }],
      streakKey: 'S5',
      streakCount: 0,
    }), 'utf8');
    const r = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/block-prompt.mjs', payload: { session_id: 'S5' } });
    assert.equal(r.frame?.decision, 'block', '队列非空同样必须保住阻断帧（宿主 UserPromptSubmit 的阻断位与上下文位互斥）');
    assert.match(String(r.frame?.reason ?? ''), /先澄清目标/, '阻断理由不得被中继文本挤掉');
    assert.ok(!String(r.stdout).includes('待投递提醒-队列非空'), '阻断帧形态下不得夹带中继文本');
    assert.equal(readStateFile().frames.length, 1, '阻断时不清队列（提醒留待下一次提示再投，不丢）');
    // 下一轮无阻断 ⇒ 提醒照常送达（证明"留着"不是"卡死"）
    const next = runShim({ pkgRoot, dataDir, event: 'UserPromptSubmit', script: 'hooks/quiet.mjs', payload: { session_id: 'S5' } });
    assert.match(String(next.frame?.hookSpecificOutput?.additionalContext ?? ''), /待投递提醒-队列非空/);
    assert.equal(readStateFile().frames.length, 0, '无阻断那一轮正常清空');
  });

  it('burstCap 注入变形：改为 1 时第 2 次阻断即降级（数据驱动，非当前值巧合）', () => {    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'stop-pending-relay') rule.params.mcode.burstCap = 1;
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      const first = runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S3' } });
      assert.equal(first.frame?.decision, 'block', '第 1 次仍直译');
      const second = runShim({ pkgRoot, dataDir, event: 'Stop', script: 'hooks/block-stop.mjs', payload: { session_id: 'S3' } });
      assert.equal(second.frame, null, 'cap=1 时第 2 次必须降级（若仍阻断 ⇒ 上限未随规则变化）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  });
});
