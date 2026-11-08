// 文件：stop-hooks-delegation.test.mjs
// 描述：内部任务-20 A1 阶段新增——**两个 Stop 注入钩**（task-recap 与 learnings-recap）的委派语义测试：
//       ① task-recap：委派子代理会话（isDelegatedSession 为真）不注入普通汇总（F4 注入面收窄）；
//       ② task-recap：委派会话**仍**注入 lease-loop 行（内部规则-3 无条件兑现，CEO 交互边界 b）；
//       ③ task-recap：顶层会话照常注入一行待排查汇总，且 CLI 命令是插件根绝对路径（F5）；
//       ④ learnings-recap：委派会话不落 state（否则项目键控的提醒被本会话消费掉，CEO 出口风险 4）。
//       夹具纪律：三缝齐注（WF_RECAP_STATE_DIR / WF_INCIDENT_ROOT / WF_ROUTING_STATE_DIR）——
//       末者防 installHookErrorTrap 崩溃分支把 hook-errors.jsonl 写进用户级状态目录
//       （post-tool-hook.test.mjs 三缝先例，评审 C7）。
// 作者：wangp  创建：2026-10-08  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendIncident, digestOf } from '../../scripts/lib/incident-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '..', '..', 'hooks', 'task-recap.mjs');
const LEARNINGS_HOOK = resolve(HERE, '..', '..', 'hooks', 'learnings-recap.mjs');

/** 激活域夹具：带 .git 的临时仓（缺它落非仓静默分支，用例失鉴别力）。 */
const REPO_CWD = (() => {
  const d = mkdtempSync(join(tmpdir(), 'recap-repo-'));
  mkdirSync(join(d, '.git'));
  process.on('exit', () => rmSync(d, { recursive: true, force: true }));
  return d;
})();

const PAYLOAD = (session, extra = {}) => JSON.stringify({ session_id: session, cwd: REPO_CWD, ...extra });

/**
 * 跑 Stop 钩（三缝隔离）。
 * @param {string} payload stdin 负载
 * @param {{ stateDir: string, incidentRoot: string }} o 注入缝
 * @returns {{ status: number|null, stdout: string }}
 */
function run(payload, { stateDir, incidentRoot }) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, WF_RECAP_STATE_DIR: stateDir, WF_INCIDENT_ROOT: incidentRoot, WF_ROUTING_STATE_DIR: join(stateDir, 'lease') },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** 造一条真待排查记录（error-flag 不在分层排除面）；kind 可覆盖以造 lease-loop。 */
function seedPending(root, session, id, kind = 'tool-failure') {
  appendIncident(root, {
    id, ts: Date.now(), session, taskId: null, skill: null, plugin: null,
    kind, tool: 'Bash', event: null, errorClass: 'error-flag', digest: digestOf([id]),
  });
}

test('DEV-20 A1/F4：委派会话 Stop 静默（无注入、退 0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-deleg-'));
  try {
    seedPending(dir, 's-deleg', 'ri-recap-deleg-1');
    const r = run(PAYLOAD('s-deleg', { delegation_depth: 1 }), { stateDir: join(dir, 'state'), incidentRoot: dir });
    assert.equal(r.status, 0, 'fail-open 姿态：任何路径退 0');
    assert.equal(r.stdout.trim(), '', '委派会话不注入收尾汇总（F4 收窄面）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEV-20 A1/F4+F5：顶层会话照常注入，且 CLI 命令为插件根绝对路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-top-'));
  try {
    seedPending(dir, 's-top', 'ri-recap-top-1');
    const r = run(PAYLOAD('s-top'), { stateDir: join(dir, 'state'), incidentRoot: dir });
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('待排查'), '顶层会话照常注入待排查行');
    assert.ok(!ctx.includes('node workflow/scripts/incident-cli.mjs'), '不得含仓相对命令（消费仓 MODULE_NOT_FOUND）');
    const expected = join(realpathSync(resolve(HERE, '..', '..')), 'scripts', 'incident-cli.mjs').replaceAll('\\', '/');
    assert.ok(ctx.includes(expected), `注入须含插件根绝对路径（期望 ${expected}）；实际：${ctx}`);
    assert.ok(ctx.includes('--project-root'), '注入命令须带显式根（防子目录 cwd 漂移读出假绿，CEO 交互边界 a）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEV-20 A1/A2(b)：委派会话仍注入 lease-loop 行（R-M15-3 无条件兑现）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-deleg-loop-'));
  try {
    seedPending(dir, 's-deleg-loop', 'ri-recap-loop-1', 'lease-loop');
    const r = run(PAYLOAD('s-deleg-loop', { delegation_depth: 1 }), { stateDir: join(dir, 'state'), incidentRoot: dir });
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('lease-loop'), '委派会话只保留 lease-loop——不再依赖"父会话兜底"的前提（CEO 交互边界 b）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEV-20 A1/F4：委派会话不消费项目键控的 learnings 提醒（CEO 出口风险 4）', () => {
  // 夹具照抄该钩 selftest 的态2 配方（内部治理状态 一个 complete 任务 + 经验记录 无该任务号
  // ⇒ 首跑落册 reminded）：**带对照组**才有鉴别力——只测"委派不落 state"在夹具够不到 state 写入点时恒真。
  const home = mkdtempSync(join(tmpdir(), 'recap-learn-home-'));
  const learnState = join(home, 'learn-state');
  const runLearnings = (extra) =>
    spawnSync(process.execPath, [LEARNINGS_HOOK], {
      input: JSON.stringify({ session_id: 's-learn', cwd: home, ...extra }),
      encoding: 'utf8',
      env: { ...process.env, WF_LEARNINGS_RECAP_ROOT: home, WF_LEARNINGS_RECAP_STATE_DIR: learnState, WF_INCIDENT_ROOT: home },
    });
  try {
    mkdirSync(join(home, '.sdd'), { recursive: true });
    writeFileSync(
      join(home, '.sdd', 'ledger.json'),
      JSON.stringify({
        tasks: [{ id: 'T1', title: 'T1', createdAt: '2026-10-08T00:00:00+08:00', status: 'converged', finalStatus: 'complete', gateReportRef: '.sdd/reports/T1/delivery-final.json' }],
      }),
    );
    writeFileSync(join(home, 'learnings.md'), '- 2026-10-08 | 场景 | 无关条目 | 无\n');

    assert.equal(runLearnings({ delegation_depth: 1 }).status, 0);
    assert.ok(!existsSync(learnState) || readdirSync(learnState).length === 0, '委派会话不得落 state（落册＝消费掉提醒，用户会话再也收不到）');

    assert.equal(runLearnings({}).status, 0, '对照组：顶层会话照常跑');
    assert.equal(readdirSync(learnState).length, 1, '对照组证明夹具确实到达 state 写入点（否则本用例无鉴别力）');
    assert.equal(JSON.parse(readFileSync(join(learnState, readdirSync(learnState)[0]), 'utf8')).reminded.T1, true, '落册内容含 T1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
