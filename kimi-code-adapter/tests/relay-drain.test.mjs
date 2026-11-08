// 文件：relay-drain.test.mjs
// 描述：内部任务-302 四包观察面投递腿（`kimi/relay-drain.mjs`）的用例：投递即出队、会话隔离、
//       空队列/坏负载、超长截断、引擎不可用、孤儿帧收养、与 shim 的 UPS 分支对拍。
//       驱动一律 spawnSync input（禁 shell 管道，GBK 教训）；夹具为 tmp 包 + tmp 宿主根。
// 作者：wangp  创建：2026-11-03  版权：MIT（见 workflow/LICENSE）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTER_ROOT, ensureEngineFixture, removeRoot, tempRoot, writeFile } from './helpers.mjs';
import { adoptOrphanFrames, readState } from '../kimi/hook-lib.mjs';

/** 造夹具包（spec-gate 形态）：relay-drain + hook-lib + hook-shim + 引擎闭包 + 空子钩子。 */
function fixture(tag) {
  const root = tempRoot(tag);
  const pkg = join(root, 'spec-gate');
  mkdirSync(join(pkg, 'kimi'), { recursive: true });
  for (const name of ['relay-drain.mjs', 'hook-lib.mjs', 'hook-shim.mjs']) {
    cpSync(join(ADAPTER_ROOT, 'kimi', name), join(pkg, 'kimi', name));
  }
  ensureEngineFixture(pkg);
  writeFile(join(pkg, 'hooks', 'noop.mjs'), 'process.exit(0);\n');
  const dataDir = join(root, 'home');
  const stateDir = join(dataDir, 'plugin-data', 'spec-gate');
  mkdirSync(stateDir, { recursive: true });
  return { root, pkg, dataDir, stateDir };
}

/** 写状态文件（frames 原样给出）。 */
function seed(stateDir, frames, extra = {}) {
  writeFile(join(stateDir, 'relay-state.json'), JSON.stringify({ frames, streaks: {}, droppedBySession: {}, ...extra }));
}

/** 跑 relay-drain（stdin 喂负载）。 */
function runDrain(f, payload) {
  const result = spawnSync(process.execPath, [join(f.pkg, 'kimi', 'relay-drain.mjs')], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, KIMI_CODE_HOME: f.dataDir },
    timeout: 90_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

describe('relay-drain 投递腿', () => {
  it('投递即出队且只投本会话', () => {
    const f = fixture('drain-basic');
    try {
      seed(f.stateDir, [
        { sessionKey: 's1', id: 'a1', text: 'A-diagnostic', ts: 1 },
        { sessionKey: 's2', id: 'b1', text: 'B-other-session', ts: 2 },
      ]);
      const r = runDrain(f, { session_id: 's1' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /A-diagnostic/);
      assert.doesNotMatch(r.stdout, /B-other-session/);
      const left = readState(f.stateDir);
      assert.equal(left.frames.length, 1, '本会话帧已出队、他会话帧保留');
      assert.equal(left.frames[0].sessionKey, 's2');
    } finally {
      removeRoot(f.root);
    }
  });

  it('他会话帧保留且空队列零输出', () => {
    const f = fixture('drain-empty');
    try {
      seed(f.stateDir, [{ sessionKey: 's2', id: 'b1', text: 'B-other-session', ts: 2 }]);
      const r = runDrain(f, { session_id: 's1' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', '无本会话帧时零输出');
      assert.equal(readState(f.stateDir).frames.length, 1, '他会话帧未被消费');
      seed(f.stateDir, []);
      const empty = runDrain(f, { session_id: 's1' });
      assert.equal(empty.status, 0);
      assert.equal(empty.stdout.trim(), '');
    } finally {
      removeRoot(f.root);
    }
  });

  it('容量淘汰计数：队列空但本会话 droppedBySession>0 → 投递附淘汰提醒并清键（内部任务-347 分账）', () => {
    const f = fixture('drain-dropped');
    try {
      seed(f.stateDir, [], { droppedBySession: { 's:S-drop': 2 } });
      const r = runDrain(f, { session_id: 'S-drop', prompt: 'x' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /容量上限/, '淘汰事实必须送达（不静默吞）');
      assert.match(r.stdout, /2 条/, '淘汰条数须带出');
      const state = JSON.parse(readFileSync(join(f.stateDir, 'relay-state.json'), 'utf8'));
      assert.equal(state.droppedBySession['s:S-drop'], undefined, '提醒后本会话键删除');
    } finally {
      removeRoot(f.root);
    }
  });

  it('连击预算归零：本会话 streaks>0 时不早退，UPS 后删键（内部任务-347 字典形态；归零腿为将来新增 Stop 钩子预留）', () => {
    const f = fixture('drain-streak');
    try {
      seed(f.stateDir, [], { streaks: { 's:S-streak': 3 } });
      const r = runDrain(f, { session_id: 'S-streak', prompt: 'x' });
      assert.equal(r.status, 0);
      const state = JSON.parse(readFileSync(join(f.stateDir, 'relay-state.json'), 'utf8'));
      assert.equal(state.streaks['s:S-streak'], undefined, 'deliverOn 须删本会话连击键');
    } finally {
      removeRoot(f.root);
    }
  });

  it('坏负载零输出且 exit 0', () => {
    const f = fixture('drain-badpayload');
    try {
      seed(f.stateDir, [{ sessionKey: 's1', id: 'a1', text: 'A-diagnostic', ts: 1 }]);
      const r = runDrain(f, '{not-json');
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', '负载不可读时零输出（fetch fail-open）');
    } finally {
      removeRoot(f.root);
    }
  });

  it('超长帧按 32000 字符截断', () => {
    const f = fixture('drain-clamp');
    try {
      seed(f.stateDir, [{ sessionKey: 's1', id: 'long', text: 'x'.repeat(40_000), ts: 1 }]);
      const r = runDrain(f, { session_id: 's1' });
      assert.equal(r.status, 0);
      assert.ok(r.stdout.length < 40_000, '输出被钳位');
      assert.match(r.stdout, /已截断/);
    } finally {
      removeRoot(f.root);
    }
  });

  it('引擎不可用：零输出 + 诊断 + exit 0；孤儿帧不被提前收养', () => {
    const f = fixture('drain-noengine');
    try {
      rmSync(join(f.pkg, 'plugin-core'), { recursive: true, force: true });
      seed(f.stateDir, [{ sessionKey: 'pid-999999', id: 'a1', text: 'A-diagnostic', ts: 1 }]);
      const r = runDrain(f, { session_id: 's1' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
      const log = join(f.stateDir, 'hook-diagnostics.log');
      assert.ok(existsSync(log), '诊断日志应存在');
      assert.match(readFileSync(log, 'utf8'), /投递腿引擎不可用/);
      const left = readState(f.stateDir);
      assert.equal(left.frames.length, 1, '孤儿帧仍在状态文件');
      assert.equal(left.frames[0].sessionKey, 'pid-999999', '引擎不可用路径不得提前收养（收养统一进 drainRelayForPrompt）');
    } finally {
      removeRoot(f.root);
    }
  });

  it('与 shim 的 UPS 分支对拍（无 cwd 形态）', () => {
    const f = fixture('drain-parity');
    try {
      const frames = [
        { sessionKey: 's1', id: 'a1', text: 'A-diagnostic', ts: 1 },
        { sessionKey: 's2', id: 'b1', text: 'B-other-session', ts: 2 },
      ];
      seed(f.stateDir, frames);
      const drain = runDrain(f, { session_id: 's1' });
      const drainState = readState(f.stateDir);
      seed(f.stateDir, frames);
      const shim = spawnSync(process.execPath, [join(f.pkg, 'kimi', 'hook-shim.mjs'), 'UserPromptSubmit', 'hooks/noop.mjs', '5'], {
        input: JSON.stringify({ session_id: 's1' }),
        encoding: 'utf8',
        env: { ...process.env, KIMI_CODE_HOME: f.dataDir },
        timeout: 90_000,
        windowsHide: true,
      });
      const shimState = readState(f.stateDir);
      assert.equal(shim.status, 0);
      assert.equal(drain.stdout.trim(), String(shim.stdout ?? '').trim(), '两腿输出一致');
      assert.deepEqual(drainState.frames, shimState.frames, '出队后状态一致');
    } finally {
      removeRoot(f.root);
    }
  });
});

describe('adoptOrphanFrames（自 hook-shim 下沉）', () => {
  it('pid- 帧收养为当前会话键，非 pid- 帧原样保留', () => {
    const f = fixture('drain-adopt');
    try {
      seed(f.stateDir, [
        { sessionKey: 'pid-1234', id: 'o1', text: 'orphan', ts: 1 },
        { sessionKey: 's9', id: 'k1', text: 'real', ts: 2 },
      ]);
      adoptOrphanFrames(f.stateDir, 's1');
      const state = readState(f.stateDir);
      assert.deepEqual(state.frames.map((frame) => frame.sessionKey), ['s1', 's9']);
    } finally {
      removeRoot(f.root);
    }
  });

  it('无 pid- 帧时不写盘', () => {
    const f = fixture('drain-adopt-noop');
    try {
      seed(f.stateDir, [{ sessionKey: 's9', id: 'k1', text: 'real', ts: 2 }]);
      const before = readFileSync(join(f.stateDir, 'relay-state.json'), 'utf8');
      adoptOrphanFrames(f.stateDir, 's1');
      const after = readFileSync(join(f.stateDir, 'relay-state.json'), 'utf8');
      assert.equal(after, before, '无孤儿帧时文件内容不变');
    } finally {
      removeRoot(f.root);
    }
  });
});
