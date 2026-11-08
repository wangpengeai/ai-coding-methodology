// 文件：routing-lib.test.mjs
// 描述：内部任务-20 A2（F7 项目级状态根）——单点原语 `stateRootFor(key)` 的三级优先
//       （WF_ROUTING_STATE_DIR 注入缝 > 项目配置文件记号 > 用户级默认根）、项目配置
//       非法时的**回落 + 可见告警**、以及多键逐键解析（同仓两键同根 / 异仓各归各根）。
//       为什么单独立文件：原语是签发钩/闸/声明 CLI 三侧共用的唯一解析点（内部决策-040 修正案 1
//       「解析单点」句），把它钉在独立用例里，任何一处自行拼路径的回归都能被单独判红。
// 作者：wangp  创建：2026-10-08  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；fixture 全部临时生成；env 全局故逐用例设/复原。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectRoutingConfig, stateRootDiagnostic, stateRootFor } from '../../hooks/routing-lib.mjs';

/** 建临时夹具根（用例结束由各自 finally 清理）。返回前 realpath 归一：darwin 的
 * os.tmpdir() 原始形态走 /var symlink（realpath 为 /private/var/...），而
 * stateRootFor 按设计把键 realpath 归一（内部任务-MACKEY-1：不归一则 macOS 租约激活
 * 永久失败）——期望值必须与键同形态，否则 darwin 上必红（2026-10-11 Mac publish
 * 验证集实录，内部任务-6；learnings 2026-09-13「测试期望值要与键同形态」条）；
 * 无 symlink 平台 realpath 幂等零变化（先例 313075b / 内部任务-INSTALL-055 同族）。 */
function mkBase(tag) {
  return realpathSync(mkdtempSync(join(tmpdir(), `rl-${tag}-`)));
}

/** 造一个最小激活域：带 .git 的临时仓。 */
function mkRepo(base, name) {
  const d = join(base, name);
  mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

/** 写入项目级记号（`{"stateRoot":"local"}`）。 */
function writeLocalMarker(repo, raw = JSON.stringify({ stateRoot: 'local' })) {
  mkdirSync(join(repo, '.workflow'), { recursive: true });
  writeFileSync(join(repo, '.workflow', 'routing.json'), raw, 'utf8');
}

/** 在受控 env 下跑断言（HOME/USERPROFILE 决定默认根；WF_ROUTING_STATE_DIR 为注入缝）。 */
function withEnv(env, fn) {
  const keys = ['HOME', 'USERPROFILE', 'WF_ROUTING_STATE_DIR'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined || env[k] === null) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('DEV-20 A2/F7：未 opt-in ⇒ 用户级默认根', () => {
  const base = mkBase('root');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repo = mkRepo(base, 'A');
  try {
    withEnv({ HOME: home, USERPROFILE: home, WF_ROUTING_STATE_DIR: null }, () => {
      assert.equal(stateRootFor(repo), join(home, '.zcode', 'cli', 'routing-state'), '缺省＝用户级默认根（行为不变）');
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：项目记号 opt-in ⇒ 项目内根；多键逐键解析（同仓同根 / 异仓各归）', () => {
  const base = mkBase('local');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repoA = mkRepo(base, 'A');
  const repoB = mkRepo(base, 'B');
  mkdirSync(join(repoA, 'sub'), { recursive: true });
  try {
    writeLocalMarker(repoA);
    withEnv({ HOME: home, USERPROFILE: home, WF_ROUTING_STATE_DIR: null }, () => {
      assert.equal(stateRootFor(repoA), join(repoA, '.workflow', 'routing-state'), 'opt-in ⇒ 项目内根');
      assert.equal(stateRootFor(join(repoA, 'sub')), join(repoA, '.workflow', 'routing-state'), '同仓两键同根（键先归一到激活域根）');
      assert.equal(stateRootFor(repoB), join(home, '.zcode', 'cli', 'routing-state'), '异仓未 opt-in ⇒ 默认根（逐键解析不串根）');
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：注入缝优先级最高（> 项目记号）', () => {
  const base = mkBase('seam');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repo = mkRepo(base, 'A');
  const seam = join(base, 'seam');
  try {
    writeLocalMarker(repo);
    withEnv({ HOME: home, USERPROFILE: home, WF_ROUTING_STATE_DIR: seam }, () => {
      assert.equal(stateRootFor(repo), seam, '注入缝压过项目记号（测试缝与过渡面语义不变）');
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：配置非法（坏 JSON / 未知取值）⇒ 回落默认根 + 可见告警', () => {
  const base = mkBase('bad');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const bad = mkRepo(base, 'bad');
  const unknown = mkRepo(base, 'unknown');
  const defaultRoot = join(home, '.zcode', 'cli', 'routing-state');
  try {
    writeLocalMarker(bad, '{ this is not json');
    writeLocalMarker(unknown, JSON.stringify({ stateRoot: 'bogus' }));
    withEnv({ HOME: home, USERPROFILE: home, WF_ROUTING_STATE_DIR: null }, () => {
      for (const repo of [bad, unknown]) {
        assert.equal(stateRootFor(repo), defaultRoot, '非法配置 ⇒ 回落默认根（不静默换根、不抛）');
        const cfg = readProjectRoutingConfig(repo);
        assert.equal(cfg.ok, false, '读取结果如实标 ok=false');
        const diag = stateRootDiagnostic(repo, cfg);
        assert.ok(typeof diag === 'string' && diag.length > 0, '必须产出可见告警文本');
        assert.match(diag, /默认|回落/, '告警须点明"已回落默认根"');
      }
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
