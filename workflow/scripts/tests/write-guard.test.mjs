// 文件：write-guard.test.mjs
// 描述：写仓闸 PreToolUse 钩（P3 enforce＋P2 shadow 模式，内部决策-066 D8，内部任务-261）行为测试——
//       enforce 下 C1-C4 deny(2)＋完整声明命令、shadow 模式零输出、C5 恒 shadow、声明放行、
//       旧租约（无 scriptWrites）拒、deny→declare→retry 集成、edit 目标入 journal、基线落盘、
//       激活域外不记账、载荷不可解析/崩溃注入 fail-open。fixture 全部 tmp；state 经
//       WF_ROUTING_STATE_DIR 注入缝隔离。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；子进程真跑钩子。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'write-guard.mjs');
const REPO = process.cwd();
const sha16 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const { issueChallenge, activateLease } = await import('../../hooks/task-lease-lib.mjs');
const { projectKey } = await import('../../hooks/routing-lib.mjs');
const { requiredProjectSkills } = await import('../../scripts/lib/project-skills.mjs');

// ── 内部任务-308 / 内部未决-283：基线快照预算 env 缝（钩层透传既有 gitTimeoutMs 缝） ──
test('OPEN-283：WF_WRITE_AUDIT_BASELINE_BUDGET_MS 解析与钩层接线', async () => {
  const { resolveBaselineBudget } = await import('../../scripts/lib/write-audit.mjs');
  assert.equal(resolveBaselineBudget({}), undefined, '未设置 → 保持库缺省预算');
  assert.equal(resolveBaselineBudget({ WF_WRITE_AUDIT_BASELINE_BUDGET_MS: '30000' }), 30000, '合法正整数 → 透传');
  for (const bad of ['', '0', '-1', '1.5', 'abc', 'NaN', '0x10', '1e3', '1e10', '999999']) {
    assert.equal(resolveBaselineBudget({ WF_WRITE_AUDIT_BASELINE_BUDGET_MS: bad }), undefined, `非法值 ${bad} → undefined（回落缺省）`);
  }
  // 接线锁：钩子 ensureBaseline 必须经该解析器把预算带到 snapshotBaseline（防只加库层缝未接线）
  const src = readFileSync(HOOK, 'utf8');
  assert.match(src, /resolveBaselineBudget\(/, 'write-guard 须调用 resolveBaselineBudget');
});

/** 建隔离 state 目录。 */
function makeState() {
  return mkdtempSync(join(tmpdir(), 'write-guard-state-'));
}

/** 驱动钩子（stdin 负载；env 注入缝）。 */
function run(payload, state, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, WF_ROUTING_STATE_DIR: state, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 读 journal 全部记录（无文件返回空数组）。 */
function journal(state) {
  const names = readdirSync(state).filter((n) => n.startsWith('wf-write-journal-'));
  if (names.length === 0) return [];
  return readFileSync(join(state, names[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const shell = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: REPO, session_id: 's1', ...extra });
const edit = (toolInput, toolName = 'Edit') => ({ tool_name: toolName, tool_input: toolInput, cwd: REPO, session_id: 's1' });

/**
 * 在隔离 state 下签发并激活租约（可选 scriptWrites/scriptEditCode），返回 leaseId。
 * `root` 缺省为仓根；内部任务-285 的 tmp git 夹具须传入夹具根（租约按激活域键控）。
 * @param {string} state WF_ROUTING_STATE_DIR
 * @param {{sessionId?: string, scriptWrites?: Array<object>|undefined, scriptEditCode?: Array<object>|undefined, root?: string}} [opts]
 */
function seedLease(state, opts = {}) {
  const root = opts.root ?? REPO;
  const prev = process.env.WF_ROUTING_STATE_DIR;
  const claimFile = join(root, 'docs', 'plans', 'claims', 'DEV-261.json');
  const claimBefore = existsSync(claimFile) ? readFileSync(claimFile, 'utf8') : null;
  process.env.WF_ROUTING_STATE_DIR = state;
  try {
    const ch = issueChallenge(projectKey(root), opts.sessionId ? { sessionId: opts.sessionId } : {});
    const act = activateLease(projectKey(root), {
      leaseId: ch.leaseId,
      taskId: 'DEV-261',
      skill: 'plan-execution',
      ...(opts.planPath !== undefined ? { planPath: opts.planPath } : {}),
      ...(opts.planRoot !== undefined ? { planRoot: opts.planRoot } : {}),
      ...(opts.scriptWrites !== undefined ? { scriptWrites: opts.scriptWrites } : {}),
      ...(opts.scriptEditCode !== undefined ? { scriptEditCode: opts.scriptEditCode } : {}),
      ...((opts.projectSkills !== undefined || opts.autoAck === false)
        ? { projectSkills: opts.projectSkills ?? [] }
        : (() => {
            // 内部任务-341：真实仓项目 skill 必载集合自动补 ack（tmp 夹具无项目 skill → 空集 no-op）
            const req = requiredProjectSkills({ projectRoot: root }).required;
            return req.length > 0 ? { projectSkills: req.map((sk) => ({ name: sk.name, root: sk.root })) } : {};
          })()),
    });
    assert.ok(act.ok, `夹具租约激活失败：${act.reason}`);
    // 内部验收-41 测试卫生（P4 评审 #3）：activateLease 会写 tracked claims/内部任务-261.json——
    // 立即还原快照，避免单测改动工作树（钩子判定只用 active 租约，不读 claim）
    if (claimBefore === null) rmSync(claimFile, { force: true });
    else writeFileSync(claimFile, claimBefore);
    return ch.leaseId;
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

/** 仅签发挑战不激活（用于验证 null 租约分支的 deny 文案令牌渲染）。 */
function seedChallengeOnly(state, opts = {}) {
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = state;
  try {
    const ch = issueChallenge(projectKey(REPO), opts.sessionId ? { sessionId: opts.sessionId } : {});
    return ch.leaseId;
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

test('DEV-261 写仓闸：shadow 期 C1 记 would-deny（信封零输出）', () => {
  const state = makeState();
  try {
    const r = run(shell('echo hi > probe.txt'), state, { WF_WRITE_GUARD_MODE: 'shadow' });
    assert.equal(r.status, 0, 'shadow 恒 exit 0');
    assert.equal(r.stdout.trim(), '', 'shadow 不输出决策信封');
    const rows = journal(state);
    const row = rows.find((x) => x.tool === 'shell' && x.cls === 'C1');
    assert.ok(row, `journal 须记 C1（实得 ${JSON.stringify(rows)}）`);
    assert.equal(row.decision, 'record', 'shadow 模式记 record');
    assert.equal(row.wouldBeDeny, true, 'shadow 期亦须保留 would-deny 观测（D6/D7）');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

/** enforce 模式驱动（P3 步骤 17 打开 deny 分支后应绿）。 */
const enforce = (payload, state) => run(payload, state, { WF_WRITE_GUARD_MODE: 'enforce' });

/** 断言 deny：exit 2＋信封决策 deny。 */
function assertDenyDecision(r) {
  assert.equal(r.status, 2, `deny 必须 exit 2（实得 ${r.status}；stdout=${r.stdout}）`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.hookSpecificOutput.hookEventName, 'PreToolUse', '信封 hookEventName 须为 PreToolUse');
  assert.equal(env.hookSpecificOutput.permissionDecision, 'deny', '信封决策 deny');
  return env;
}

test('DEV-261 写仓闸：C1 重定向写文件 deny（enforce，exit 2＋完整声明命令）', () => {
  const state = makeState();
  try {
    // 带 planPath 的 plan-execution 租约：deny 文案须自动补 --plan（否则照抄不可执行）
    const leaseId = seedLease(state, { sessionId: 's1', planPath: 'docs/plans/2026-10-31-DEV-261-hard-rule-9-mechanical-enforcement-plan.md', planRoot: REPO });
    const r = enforce(shell('echo hi > probe.txt'), state);
    const env = assertDenyDecision(r);
    const msg = env.hookSpecificOutput.systemMessage ?? '';
    for (const part of ['routing-declare', '--lease', '--task-id', '--script-write', '--plan', '--plan-root', leaseId]) {
      assert.ok(String(msg).includes(part), `deny 文案须含完整可复制命令片段 ${part}（实得 ${msg}）`);
    }
    assert.equal(msg.includes('[object Object]'), false, '令牌不得渲染为 [object Object]');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：C2/C3/C4 enforce 同档 deny', () => {
  const state = makeState();
  try {
    for (const cmd of [
      "sed -i 's/a/b/' a.txt",
      "node -e \"require('fs').writeFileSync('a.txt','x')\"",
      "node <<'EOF'\nrequire('fs').writeFileSync('a.txt','x')\nEOF",
    ]) {
      assertDenyDecision(enforce(shell(cmd), state));
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：C5 enforce 仍不阻断（恒 shadow）', () => {
  const state = makeState();
  try {
    const r = enforce(shell('cp a.txt b.txt'), state);
    assert.equal(r.status, 0, 'C5 不得 deny');
    assert.equal(r.stdout.trim(), '', 'C5 零输出');
    assert.equal(journal(state).some((x) => x.cls === 'C5' && x.decision === 'record'), true);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：enforce fail-open（坏负载/崩溃注入不落 deny）', () => {
  const state = makeState();
  try {
    assert.equal(enforce('{bad json', state).status, 0, '坏负载 fail-open');
    const crash = run(shell('echo hi > probe.txt'), state, { WF_WRITE_GUARD_MODE: 'enforce', GUARD_HOOK_INJECT_CRASH: '1' });
    assert.equal(crash.status, 0, '崩溃注入 fail-open');
    assert.equal(crash.stdout.trim(), '', '崩溃不输出 deny');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：C5 shadow 零阻断', () => {
  const state = makeState();
  try {
    const r = run(shell('cp a.txt b.txt'), state);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const row = journal(state).find((x) => x.tool === 'shell' && x.cls === 'C5');
    assert.ok(row, 'journal 须记 C5');
    assert.equal(row.decision, 'record', 'C5 恒 shadow record');
    assert.equal(row.wouldBeDeny, false);
    assert.match(String(row.cmdDigest), /^[0-9a-f]{64}$/, 'D6：shell 行须带命令完整摘要');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('C1 仓外目标负例：tmp 重定向不记 C1（ADR-066 D4/D10）', () => {
  const state = makeState();
  try {
    const outside = join(tmpdir(), `write-guard-outside-target-${process.pid}.log`);
    const r = run(shell(`echo hi > ${outside}`), state);
    assert.equal(r.status, 0);
    const rows = journal(state).filter((x) => x.tool === 'shell');
    assert.equal(rows.some((x) => x.cls === 'C1'), false, 'tmp 目标不得记 C1');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('edit 族目标入 journal（绝对路径归一仓相对；apply_patch 多文件抽取）', () => {
  const state = makeState();
  try {
    assert.equal(run(edit({ file_path: join(REPO, 'a.txt') }), state).status, 0);
    assert.equal(run(edit({ patch: '*** Begin Patch\n*** Add File: x.txt\n+hi\n*** Update File: y.md\n-old\n+new\n*** End Patch' }, 'applypatch'), state).status, 0);
    const rows = journal(state).filter((x) => x.tool === 'edit' && x.path);
    assert.deepEqual(rows.map((x) => x.path), ['a.txt', 'x.txt', 'y.md'], 'DSH 绝对路径须归一为仓相对');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('基线：会话首调落 baseline；激活域外不建 journal', () => {
  const state = makeState();
  const outside = mkdtempSync(join(tmpdir(), 'write-guard-outside-'));
  // 用自建小 git 夹具而非真实仓：baseline 走一次 `git status`，真实仓在满量验证集负载下会
  // 撞上生产预算 800ms 而超时降级 ⇒ 「baseline 须落盘」假红（内部任务-295 发布批第三次红；
  // 与本文件其余用例统一用 makeGitFixture，内部任务-289 同族教训）。
  const repo = makeGitFixture();
  try {
    // 内部任务-308/内部未决-283：注入测试预算（经钩层 env 缝），使「baseline 须落盘」不受满量负载下
    // git status 抖动影响；生产缺省仍 800ms（本断言只测落盘语义，不测预算值）。
    run(shellAt(repo, 'ls -la'), state, { WF_WRITE_AUDIT_BASELINE_BUDGET_MS: '30000' });
    assert.ok(readdirSync(state).some((n) => n.startsWith('wf-write-baseline-')), 'baseline 须落盘');
    const r = run({ tool_name: 'Bash', tool_input: { command: 'echo x > a.txt' }, cwd: outside, session_id: 's1' }, state);
    assert.equal(r.status, 0);
    assert.equal(journal(state).length, 1, '域外负载不增加 journal（仅前一条 ls）');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fail-open：载荷不可解析 / 崩溃注入 → exit 0 且 hook-errors 留痕', () => {
  const state = makeState();
  try {
    const bad = run('{not json', state);
    assert.equal(bad.status, 0, '坏负载 fail-open');
    assert.equal(bad.stdout.trim(), '');
    const crash = run(shell('echo x > a.txt'), state, { GUARD_HOOK_INJECT_CRASH: '1' });
    assert.equal(crash.status, 0, '崩溃 fail-open');
    assert.ok(existsSync(join(state, 'hook-errors.jsonl')), 'hook-errors 须留痕');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：声明放行（租约 scriptWrites）与旧租约拒', () => {
  const state = makeState();
  try {
    // 旧租约（无 scriptWrites）→ 仍 deny（向后兼容的安全方向）
    seedLease(state, { sessionId: 's1' });
    assertDenyDecision(enforce(shell('echo hi > probe.txt'), state));
    // 新租约带 scriptWrites → 同类命令 allow（exit 0 零输出）
    const state2 = makeState();
    try {
      seedLease(state2, { sessionId: 's1', scriptWrites: [{ reason: 'DEV-261 P3 声明式脚本写测试' }] });
      const r = enforce(shell('echo hi > probe.txt'), state2);
      assert.equal(r.status, 0, `声明后须放行（实际 ${r.status}）`);
      assert.equal(r.stdout.trim(), '', '放行零输出');
    } finally {
      rmSync(state2, { recursive: true, force: true });
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：deny→declare→retry 集成（同一命令第二次放行）', () => {
  const state = makeState();
  try {
    const cmd = 'echo hi > probe.txt';
    assertDenyDecision(enforce(shell(cmd), state)); // 未声明 → deny
    seedLease(state, { sessionId: 's1', scriptWrites: [{ reason: 'DEV-261 deny→declare→retry 集成证据' }] });
    const retry = enforce(shell(cmd), state); // 声明后重试 → 放行
    assert.equal(retry.status, 0, '声明后重试须放行');
    assert.equal(retry.stdout.trim(), '');
    // 内部验收-39：声明后放行须记账（journal 行 declared=true/decision=allow）
    const allowed = journal(state).filter((x) => x.tool === 'shell' && x.declared === true && x.decision === 'allow');
    assert.ok(allowed.length >= 1, '声明放行须在 journal 留痕 declared/allow');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-261 写仓闸：无活跃租约时 deny 文案用本轮挑战令牌（非 [object Object]）', () => {
  const state = makeState();
  try {
    const token = seedChallengeOnly(state, { sessionId: 's1' });
    const r = enforce(shell('echo hi > probe.txt'), state);
    const msg = assertDenyDecision(r).hookSpecificOutput.systemMessage ?? '';
    assert.ok(String(msg).includes(token), 'deny 文案须含 currentChallengeToken 的 leaseId');
    assert.equal(String(msg).includes('[object Object]'), false, '令牌不得渲染为 [object Object]');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('--selftest 退出 0 且输出 OK/PASS（enforce 阶段可见）', () => {
  const r = spawnSync(process.execPath, [HOOK, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `selftest 须退 0（${r.stderr}）`);
  assert.match(r.stdout, /OK|PASS/, 'selftest 须有结果行');
  assert.match(r.stdout, /enforce=true/, '阶段旗标须可见');
});

test('DEV-261 写仓闸：edit 缺目标 unknown 行；baseline 已存在不覆盖；坏状态根 deny 占位', () => {
  const state = makeState();
  const badState = join(tmpdir(), `wf-badstate-${process.pid}-${Date.now()}`);
  try {
    // edit 族缺目标路径 → unknown degraded 行（不阻断）
    const e = run(edit({}), state);
    assert.equal(e.status, 0);
    assert.ok(journal(state).some((x) => x.tool === 'edit' && x.shape === 'unknown' && x.degraded === true), 'unknown 行须留痕');
    // baseline 已存在时不覆盖（首调基线 early-return 分支）
    const sidDigest = sha16('s1');
    const baseline = join(state, `wf-write-baseline-${sidDigest}.json`);
    writeFileSync(baseline, JSON.stringify({ v: 1, sidDigest, entries: [] }));
    const deny = run(shell('echo hi > probe.txt'), state, { WF_WRITE_GUARD_MODE: 'enforce' });
    assert.equal(deny.status, 2);
    assert.equal(readFileSync(baseline, 'utf8').includes('"entries":[]'), true, '既有 baseline 不得被覆盖');
    // 状态根为文件（损坏）→ 状态目录不可解析：钩内异常 fail-open（exit 0 零输出，不误 deny）
    writeFileSync(badState, 'x');
    const broken = run(shell('echo hi > probe.txt'), badState, { WF_WRITE_GUARD_MODE: 'enforce' });
    assert.equal(broken.status, 0, '坏状态根须 fail-open exit 0');
    assert.equal(broken.stdout.trim(), '', '坏状态根不得输出 deny 信封');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(badState, { force: true });
  }
});

// ── 内部任务-285：受检路径（git 跟踪）分级集成（真跑钩子；tmp git 夹具） ─────────────────
/** 建 tmp git 仓并把受检文件名加入索引（无需 commit——`git ls-files` 读索引即可）。 */
function makeGitFixture(tracked = ['tracked-root.txt'], opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'write-guard-git-'));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  const init = git('init', '-q');
  assert.equal(init.status, 0, `git init 失败：${init.stderr}`);
  for (const file of tracked) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'x\n');
  }
  const add = git('add', '--', ...tracked);
  assert.equal(add.status, 0, `git add 失败：${add.stderr}`);
  if (opts.ignorecase !== undefined) {
    const cfg = git('config', 'core.ignorecase', String(opts.ignorecase));
    assert.equal(cfg.status, 0, `git config core.ignorecase 失败：${cfg.stderr}`);
  }
  return dir;
}

/**
 * 内部任务-332：alias 形态夹具——组合复用同文件 makeGitFixture（git 失败以断言面红——与本文件
 * 既有 内部任务-285/内部任务-311 用例同语义），realpath 化取 real，alias＝指向 real 的 symlink（win32
 * junction，check-freeze.test.mjs:306 同款）。构造「payload cwd 原始形态 vs activationRoot
 * canonical 形态」分裂，判别力与宿主 os.tmpdir() 形态无关（darwin /var 只是天然实例——正是
 * 内部任务-298 满量复跑才暴露该缺陷的原因）。不支持 symlink/junction 的环境返回 null（用例
 * t.skip 带理由登记，不以裸 return 冒充 pass——entry-guard.test.mjs 同族注记）。
 * @returns {{real: string, alias: string} | null}
 */
function makeAliasGitFixture() {
  const real = realpathSync(makeGitFixture());
  const alias = join(tmpdir(), `write-guard-alias-link-${basename(real)}`);
  try {
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    rmSync(real, { recursive: true, force: true });
    rmSync(alias, { recursive: true, force: true });
    return null;
  }
  return { real, alias };
}

/** 内部任务-332 夹具清理（real＋alias 两处）。 */
function rmAliasFixture(fx) {
  rmSync(fx.real, { recursive: true, force: true });
  rmSync(fx.alias, { recursive: true, force: true });
}

const shellAt = (cwd, command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's1', ...extra });

test('DEV-285 受检路径：C1 重定向受检直接拒绝（即便已声明 scriptWrites）；非受检保持现行为', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    const sw = [{ reason: '本轮批量机械替换执行' }];
    seedLease(state, { root: repo, scriptWrites: sw });
    // 受检目标：即便有通用声明也拒绝（不可声明放行）
    const denied = run(shellAt(repo, 'echo x > tracked-root.txt'), state);
    assert.equal(denied.status, 2, '受检 C1 须 deny(2)');
    assert.ok(denied.stdout.includes('受检路径'), 'deny 文案须点明受检路径');
    assert.ok(denied.stdout.includes('不可经脚本声明放行'), 'C1 拒绝式须说明不可声明放行');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.tier, 'tracked');
    assert.deepEqual(row.trackedTargets, ['tracked-root.txt']);
    // 非受检目标：通用声明放行（现行为不扩严）
    const allowed = run(shellAt(repo, 'echo x > untracked-new.txt'), state);
    assert.equal(allowed.status, 0, '非受检目标 + scriptWrites 应放行');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-285 受检路径：C2 受检目标只认 --script-edit-code（通用 scriptWrites 不足）', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    const sw = [{ reason: '本轮批量机械替换执行' }];
    seedLease(state, { root: repo, scriptWrites: sw });
    const denied = run(shellAt(repo, "sed -i 's/x/y/' tracked-root.txt"), state);
    assert.equal(denied.status, 2, '受检 C2 + generic 声明须 deny');
    assert.ok(denied.stdout.includes('--script-edit-code'), 'deny 文案须给窄声明命令');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
  const state2 = makeState();
  const repo2 = makeGitFixture();
  try {
    seedLease(state2, { root: repo2, scriptEditCode: [{ reason: '脚本编辑受检文件的目的与范围' }] });
    const allowed = run(shellAt(repo2, "sed -i 's/x/y/' tracked-root.txt"), state2);
    assert.equal(allowed.status, 0, '窄声明后受检 C2 须放行');
    const row = journal(state2).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.reason, 'declared-edit-code');
    assert.equal(row.tier, 'tracked');
  } finally {
    rmSync(state2, { recursive: true, force: true });
    rmSync(repo2, { recursive: true, force: true });
  }
});

test('DEV-285 受检路径：子目录 cwd 按执行目录解析（`../` 目标不得错位成非受检）', () => {
  const state = makeState();
  const repo = makeGitFixture();
  const sub = join(repo, 'services', 'deep');
  mkdirSync(sub, { recursive: true });
  try {
    const denied = run(shellAt(sub, "sed -i 's/x/y/' ../../tracked-root.txt"), state);
    assert.equal(denied.status, 2, '子目录 cwd 的 ../../ 受检目标须 deny');
    assert.ok(denied.stdout.includes('受检路径'));
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 内部任务-339（内部未决-254①）：混合形态重定向受检目标逐目标恒拒（与宿主类无关） ─────────────
test('DEV-339 受检混合形态：重定向受检目标逐目标恒拒', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    // 窄声明在场也无法放行混合形态中的重定向受检目标（就地目标通道不因此丢失，另例覆盖）
    seedLease(state, { root: repo, scriptEditCode: [{ reason: '尝试窄声明放行混合形态重定向' }] });
    const denied = run(shellAt(repo, "sed -i 'x' plain.txt > tracked-root.txt"), state);
    assert.equal(denied.status, 2, '混合形态重定向受检目标须 deny(2)');
    assert.ok(denied.stdout.includes('受检路径'), 'deny 文案须点明受检路径');
    assert.ok(denied.stdout.includes('不可经脚本声明放行'), '拒绝式须说明不可声明放行');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.cls, 'C2', '宿主类仍为 C2（就地编辑），恒拒来自逐目标重定向判定');
    assert.equal(row.reason, 'tracked-redirect-rejected');
    // r1 三维（正确性#1）回归锁：重定向目标不进分类 targets 的两形态——无空格粘连（>tracked）
    // 与复合分段（; echo > tracked）——恒拒仍须触发（redirects 并入受检态构造，generic 声明不放行）
    const nospace = run(shellAt(repo, "sed -i 'x' plain.txt >tracked-root.txt"), state);
    assert.equal(nospace.status, 2, '无空格重定向受检目标须 deny(2)');
    const nospaceRow = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(nospaceRow.reason, 'tracked-redirect-rejected');
    const compound = run(shellAt(repo, "sed -i 'x' plain.txt; echo z > tracked-root.txt"), state);
    assert.equal(compound.status, 2, '复合分段重定向受检目标须 deny(2)');
    // 同批对照：重定向目标非受检时窄声明照常放行（就地目标通道不丢）
    const state2 = makeState();
    const repo2 = makeGitFixture();
    try {
      seedLease(state2, { root: repo2, scriptEditCode: [{ reason: '窄声明放行混合形态就地目标' }] });
      const allowed = run(shellAt(repo2, "sed -i 'x' tracked-root.txt > untracked-out.txt"), state2);
      assert.equal(allowed.status, 0, '重定向目标非受检＋窄声明须放行（cls=C2 就地目标通道保持）');
    } finally {
      rmSync(state2, { recursive: true, force: true });
      rmSync(repo2, { recursive: true, force: true });
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 内部任务-339（内部未决-254③④）：shadow 观测补漏＋core.ignorecase 折叠门控 ─────────────────
test('DEV-339 shadow 观测：generic 声明＋受检 C2 的 wouldBeDeny=true 且 journal 含 trackedTierViolation', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    seedLease(state, { root: repo, scriptWrites: [{ reason: 'generic 声明不足以放行受检目标' }] });
    const allowed = run(shellAt(repo, "sed -i 's/a/b/' tracked-root.txt"), state, { WF_WRITE_GUARD_TRACKED_TIER: 'shadow' });
    assert.equal(allowed.status, 0, 'tracked tier shadow 档不阻断');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.decision, 'record');
    assert.equal(row.reason, 'tracked-shadow');
    assert.equal(row.wouldBeDeny, true, 'enforce 档会拦（generic 对受检不足）⇒ wouldBeDeny 须 true');
    assert.equal(row.trackedTierViolation, true, '受检分级违例须入 journal（OPEN-254③）');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-339 折叠门控：core.ignorecase=false 时不折叠（大写目标判 untracked 走 generic 通道）', () => {
  const state = makeState();
  const repo = makeGitFixture(['tracked-root.txt'], { ignorecase: 'false' });
  try {
    const denied = run(shellAt(repo, 'echo x > TRACKED-ROOT.TXT'), state);
    assert.equal(denied.status, 2, '显式 ignorecase=false 关折叠 ⇒ 大写变体判 untracked ⇒ generic no-declaration deny(2)');
    assert.ok(denied.stdout.includes('--script-write'), 'generic 通道文案须提 --script-write');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.tier, null, '非受检（untracked）无 tier');
    assert.notEqual(row.ignorecaseReadFailed, true, '显式 false 是成功读取，不置读失败观测');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-285 受检路径：win32/darwin 大小写变体按受检拒绝（code-review r2 证据层）', { skip: !(process.platform === 'win32' || process.platform === 'darwin') }, () => {
  const state = makeState();
  // 索引保留原大小写；目标用小写——折叠缺失时会误判 untracked 而放行
  const repo = makeGitFixture(['Tracked-Root.txt']);
  try {
    const denied = run(shellAt(repo, 'echo x > tracked-root.txt'), state);
    assert.equal(denied.status, 2, '大小写变体目标须按受检拒绝');
    assert.ok(denied.stdout.includes('受检路径'));
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-285 受检路径：tool_input.workdir 显式基准优先于 payload.cwd（code-review r1）', () => {
  const state = makeState();
  const repo = makeGitFixture();
  const sub = join(repo, 'services', 'deep');
  mkdirSync(sub, { recursive: true });
  try {
    // payload.cwd=仓根、workdir=子目录：相对目标按 workdir 解析（`../tracked-root.txt` → 仓根文件）
    const denied = run(
      { tool_name: 'Bash', tool_input: { command: "sed -i 's/x/y/' ../../tracked-root.txt", workdir: sub }, cwd: repo, session_id: 's1' },
      state,
    );
    assert.equal(denied.status, 2, 'workdir 显式子目录的 ../ 受检目标须 deny');
    assert.ok(denied.stdout.includes('受检路径'));
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-311 F5b 受检路径预算缝：env=1 确定性降级可观测；剥离 env 时同旧行为（1500）', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    seedLease(state, { root: repo, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    // ①剥离 env（置空→库回落 1500）：受检目标仍按 tracked 拒绝（旧行为回归锁）
    const oldBehavior = run(shellAt(repo, "sed -i 's/x/y/' tracked-root.txt"), state, { WF_WRITE_AUDIT_BASELINE_BUDGET_MS: '' });
    assert.equal(oldBehavior.status, 2, '剥离 env 时受检目标仍须 deny（1500 缺省旧行为）');
    assert.ok(oldBehavior.stdout.includes('受检路径'));
    // ②env=1：git ls-files 超时 → unknown/degraded（fail-open 放行、事实面可观测）
    const degraded = run(shellAt(repo, "sed -i 's/x/y/' tracked-root.txt"), state, { WF_WRITE_AUDIT_BASELINE_BUDGET_MS: '1' });
    assert.equal(degraded.status, 0, 'env=1 时受检判定降级须 fail-open');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.degraded, true, '降级须 journal degraded=true（不冒充 clean）');
    assert.equal(row.degradedReason, 'tracked-unknown');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DEV-285 受检路径：git 不可用记 degraded（不冒充 clean）；trackedTier=shadow 只记录', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    // git 不可用：PATH 指向空目录 → spawn git 失败 → 全部 unknown、degraded=true、回落现行裁决。
    // 租约声明 scriptWrites（受验面：unknown 不冒充受检 ⇒ 回落通用声明放行，但事实面 degraded）。
    seedLease(state, { root: repo, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    const degraded = run(shellAt(repo, "sed -i 's/x/y/' tracked-root.txt"), state, { PATH: join(tmpdir(), 'no-git-path-285') });
    assert.equal(degraded.status, 0, 'git 不可用须 fail-open（回落现行裁决）');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.degraded, true, 'git 不可用须 journal degraded=true（不冒充 clean）');
    assert.equal(row.degradedReason, 'tracked-unknown');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
  const state2 = makeState();
  const repo2 = makeGitFixture();
  try {
    const shadow = run(shellAt(repo2, 'echo x > tracked-root.txt'), state2, { WF_WRITE_GUARD_TRACKED_TIER: 'shadow' });
    assert.equal(shadow.status, 0, 'trackedTier=shadow 不拦');
    const row = journal(state2).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.wouldBeDeny, true, 'shadow 须可观测 would-deny');
    assert.equal(row.tier, 'tracked');
  } finally {
    rmSync(state2, { recursive: true, force: true });
    rmSync(repo2, { recursive: true, force: true });
  }
});

// ── 内部任务-332：受检判定归一锚（canonical vs 原始符号链接形态；alias 夹具判别与宿主 tmpdir 形态无关） ──
test('DEV-332 受检判定：alias 形态 cwd 下相对受检目标仍按 tracked 拒绝（不冒充非受检）', (t) => {
  const state = makeState();
  const fx = makeAliasGitFixture();
  if (fx === null) { t.skip('当前环境不支持 symlink/junction（形态分裂用例不判红，登记跳过）'); return; }
  try {
    // 租约按 canonical 键签发（projectKey(alias)＝projectKey(real)，生产面键控不变量）
    seedLease(state, { root: fx.alias, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    const r = enforce(shellAt(fx.alias, "sed -i 's/x/y/' tracked-root.txt"), state);
    assert.equal(r.status, 2, 'alias 形态 cwd 下受检目标仍须 deny（root＝activationRoot 恒 canonical）');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.tier, 'tracked', 'tracked 查表须真实执行（不得 targets 空走桩）');
    assert.deepEqual(row.trackedTargets, ['tracked-root.txt'], '受检目标须归一为仓相对');
    assert.equal(row.degraded, false, '归一命中不得记 degraded');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmAliasFixture(fx);
  }
});

test('DEV-332 受检判定：realpath 形态 cwd 对拍同果（归一锚一致性）', (t) => {
  const state = makeState();
  const fx = makeAliasGitFixture();
  if (fx === null) { t.skip('当前环境不支持 symlink/junction（登记跳过）'); return; }
  try {
    seedLease(state, { root: fx.real, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    const r = enforce(shellAt(fx.real, "sed -i 's/x/y/' tracked-root.txt"), state);
    assert.equal(r.status, 2, 'realpath 形态（两锚一致）行为不变');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.tier, 'tracked');
    assert.deepEqual(row.trackedTargets, ['tracked-root.txt']);
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmAliasFixture(fx);
  }
});

test('DEV-332 受检判定：alias cwd＋git 不可用记 degraded（不冒充 clean）', (t) => {
  const state = makeState();
  const fx = makeAliasGitFixture();
  if (fx === null) { t.skip('当前环境不支持 symlink/junction（登记跳过）'); return; }
  try {
    seedLease(state, { root: fx.alias, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    const r = run(shellAt(fx.alias, "sed -i 's/x/y/' tracked-root.txt"), state, { WF_WRITE_GUARD_MODE: 'enforce', PATH: join(tmpdir(), 'dev332-no-git-path') });
    assert.equal(r.status, 0, 'git 不可用须 fail-open（回落现行裁决）');
    const row = journal(state).filter((x) => x.tool === 'shell').at(-1);
    assert.equal(row.degraded, true, 'git 不可用须 journal degraded=true（不冒充 clean）');
    assert.equal(row.degradedReason, 'tracked-unknown');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmAliasFixture(fx);
  }
});

test('DEV-332 execDir 归一失败（workdir 不存在）fail-open 不崩', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    seedLease(state, { root: repo, scriptWrites: [{ reason: '本轮批量机械替换执行' }] });
    const payload = { tool_name: 'Bash', tool_input: { command: "sed -i 's/x/y/' tracked-root.txt", workdir: join(repo, 'no-such-dir') }, cwd: repo, session_id: 's1' };
    const r = enforce(payload, state);
    assert.equal(r.status, 0, 'canonicalRoot 归一失败回退词法（不抛）——钩 fail-open 不变');
    assert.ok(journal(state).some((x) => x.tool === 'shell'), 'journal 仍落行');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 内部任务-342：归因 taskId own-only（null 桶租约不归因）＋journal execDir ──

test('DEV-342 归因 taskId：无本会话具名租约时 journal taskId=null（null 桶租约不归因）', () => {
  const state = makeState();
  try {
    seedLease(state); // 无 sessionId → null 桶租约（闸可见但不可归因）
    const r = run(shell('echo hello'), state);
    assert.equal(r.status, 0);
    const row = journal(state).find((x) => x.tool === 'shell' && x.shape === 'command');
    assert.ok(row, `journal 须落 shell 行（实得 ${JSON.stringify(journal(state))}）`);
    assert.equal(row.taskId, null, 'null 桶租约不得作为归因 taskId');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-342 journal execDir：shell 行携带执行目录', () => {
  const state = makeState();
  try {
    seedLease(state, { sessionId: 's1' });
    const r = run(shell('echo hi'), state);
    assert.equal(r.status, 0);
    const row = journal(state).filter((x) => x.tool === 'shell' && x.shape === 'command').at(-1);
    assert.equal(row.execDir, realpathSync(REPO), 'shell journal 行须携带 canonical execDir');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-342 归因 taskId：本会话具名租约时 journal taskId=该任务号（正例）', () => {
  const state = makeState();
  try {
    seedLease(state, { sessionId: 's1' });
    const r = run(shell('echo hi'), state);
    assert.equal(r.status, 0);
    const row = journal(state).filter((x) => x.tool === 'shell' && x.shape === 'command').at(-1);
    assert.equal(row.taskId, 'DEV-261', '本会话具名桶租约的 taskId 须归因');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('DEV-342 子目录 cwd 绝对 file_path：edit 行只归一一次（不二次解析）', () => {
  const state = makeState();
  const repo = makeGitFixture();
  try {
    mkdirSync(join(repo, 'sub'), { recursive: true });
    seedLease(state, { root: repo, sessionId: 's1' });
    const payload = { tool_name: 'Edit', tool_input: { file_path: join(repo, 'sub', 'a.txt') }, cwd: join(repo, 'sub'), session_id: 's1' };
    const r = run(payload, state);
    assert.equal(r.status, 0, `edit 钩应变 exit 0（stderr：${r.stderr ?? ''}）`);
    const row = journal(state).find((x) => x.tool === 'edit' && x.shape === 'file');
    assert.ok(row, `须落 edit journal 行（实得 ${JSON.stringify(journal(state))}）`);
    assert.equal(row.path, 'sub/a.txt', '写侧以 execDir 归一为仓相对，报表不得再解析一次');
    assert.equal(row.execDir, undefined, 'edit 行不再携带 execDir（避免报表二次解析）');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});


test('DEV-341 项目 skill 缺 ack：shell 写（C1–C4）deny/C5 恒 shadow 不触发/只读与无必载零变化', () => {
  const proj = mkdtempSync(join(tmpdir(), 'write-guard-dev341-'));
  mkdirSync(join(proj, '.git'));
  mkdirSync(join(proj, '.agents', 'skills', 'project-conventions'), { recursive: true });
  writeFileSync(
    join(proj, '.agents', 'skills', 'project-conventions', 'SKILL.md'),
    '---\nname: project-conventions\ndescription: 本仓操作约束\nx-load-scenario: 写/改任何文件前\nx-required-on-write: true\n---\n',
  );
  const state = makeState();
  const stateAck = makeState();
  try {
    const scriptEditCode = [{ reason: 'DEV-341 夹具窄声明理由' }];
    const scriptWrites = [{ reason: 'DEV-341 夹具脚本写声明理由' }];
    seedLease(state, { root: proj, scriptEditCode, scriptWrites, projectSkills: [] });
    seedLease(stateAck, { root: proj, scriptEditCode, scriptWrites, projectSkills: [{ name: 'project-conventions', root: '.agents/skills' }] });
    const payload = (command) => ({ tool_name: 'Bash', tool_input: { command, workdir: proj }, cwd: proj, session_id: 's1' });
    // 已声明 C2 但缺 ack → deny(2)，文案含加载指引与 ack 旗标
    const denied = run(payload("sed -i 's/a/b/' file.txt"), state);
    assert.equal(denied.status, 2, `缺 ack 须 deny（stdout：${denied.stdout}）`);
    const msg = JSON.parse(denied.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('项目 skill'), `文案须点名项目 skill 义务：${msg}`);
    assert.ok(msg.includes('--project-skill project-conventions'), '文案须给 ack 修复命令');
    // 补 ack 后放行
    const allowed = run(payload("sed -i 's/a/b/' file.txt"), stateAck);
    assert.equal(allowed.status, 0, 'ack 后应放行');
    // C5 恒 shadow：不受本义务影响
    const c5 = run(payload('cp a b'), state);
    assert.equal(c5.status, 0, 'C5 不受项目 skill 义务影响（ADR-066 D8）');
    // shadow 档 C1：记录态不 deny
    const shadow = run(payload('echo x > out.txt'), state, { WF_WRITE_GUARD_MODE: 'shadow' });
    assert.equal(shadow.status, 0, 'shadow 记录态不 deny');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(stateAck, { recursive: true, force: true });
  }
});
