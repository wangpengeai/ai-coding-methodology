// 文件：user-prompt-hook.test.mjs
// 描述：user-prompt.mjs（UserPromptSubmit 节流提醒 + 任务租约签发 hook，内部规则-7/内部规则-8）
//       的行为测试——以子进程驱动真实脚本 + 临时状态目录（注入缝），覆盖：
//       任务租约行每轮必注（含首条、不随提醒节流）、提醒冷却期语义、已声明跳过、
//       fail-open（垃圾负载）、--selftest 自检入口（B-M8-4）、会话间状态隔离。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；不 mock 被测脚本本体。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendIncident, readIncidents } from '../../scripts/lib/incident-store.mjs';
import { projectKey } from '../../hooks/routing-lib.mjs';
import { issueChallenge, activateLease } from '../../hooks/task-lease-lib.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'user-prompt.mjs');
/** 本仓插件根的声明命令期望值（内部未决-91 后恒为自身位置真路径形态）——行长预算推导与
 *  env 双清空用例共用同一期望（门①评审 S5：两处逐字重复收敛为单常量）。 */
const EXPECTED_DECLARE_CMD = `node '${join(realpathSync(resolve(dirname(SCRIPT), '..')), 'hooks', 'routing-declare.mjs').replaceAll('\\', '/')}'`;
/** 默认冷却期大到"同测试内不可能到期"，到期场景用 0 显式表达 */
const LONG_COOLDOWN = '3600000';
/** 与 task-lease-lib 同款摘要（sha256 前 16 位）——推算 v3 状态文件名。 */
const digestOf = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
/** 键 canonical 形态 digest（内部任务-MACKEY-1）：签发键经 gitAncestor/discover 归一为
 * realpath 形态，键 digest 期望值须按 canonical 键推算（macOS tmpdir symlink
 * /var→/private/var；无 symlink 平台 realpathSync 幂等零变化）。入参须为存在的目录。 */
const keyDigestOf = (dir) => digestOf(realpathSync(dir));

/** 共享激活域夹具：带 .git 的临时仓目录（2026-09-15 激活域批次预置）——PAYLOAD 缺省
 *  cwd 必须是有 .git 的目录，否则既有用例会转入非仓静默路径而批量变红。模块级共享，
 *  进程退出时清理（不随单个用例 finally——同一目录跨用例复用）。 */
const REPO_CWD = (() => {
  const d = mkdtempSync(join(tmpdir(), 'uprompt-repo-'));
  mkdirSync(join(d, '.git'));
  process.on('exit', () => rmSync(d, { recursive: true, force: true }));
  return d;
})();

/** 夹具根（路径长度稳定化，2026-09-30 内部任务-INSTALL-055；2026-10-28 内部任务-250 更正）：W3 多仓
 * 行的 --project-root 路径段取夹具仓根 realpath——darwin 的 os.tmpdir() realpath 形态
 * /private/var/folders/…/T 达 57 字符，曾使 cwd 并集行（内部任务-LEASEATT-1 起三行）顶破行长口径。
 * 行长断言语义=模板预算（内部规则-8 ④；内部任务-247 多仓 tail 增 33 字 actionable 信息后余量收窄）：
 * darwin/Linux 用 /tmp 固定子目录（realpath 短且稳），**win32 回退 os.tmpdir()（路径随用户名
 * 变化、通常长于 linux /tmp；本机 33 字符）**——故 W3 夹具名前缀须**短且定长**（uws-/ud-），
 * 否则夹具路径长度会吃掉预算余量（内部任务-250 实测旧前缀 key 58/55、标签 24 → 行 340/352 > 337）。
 * 唯一性仍由 mkdtempSync 随机后缀保证。 */
const FIXTURE_ROOT = (() => {
  if (process.platform === 'win32') return tmpdir();
  const p = '/tmp/uprompt-fx';
  try {
    mkdirSync(p, { recursive: true });
    return p;
  } catch {
    return tmpdir();
  }
})();

/**
 * 以子进程运行 hook，每次调用一个全新临时状态目录（除非显式传入 stateDir 复用）。
 * @param {string} payload stdin 负载（宿主 JSON 或垃圾文本）
 * @param {{ stateDir?: string, cooldownMs?: string, args?: string[], anchor?: string }} [opts] 注入缝
 * @returns {{ status: number | null, stdout: string }}
 */
function run(payload, opts = {}) {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  const env = {
    ...process.env,
    // W3 锚确定性（2026-09-16 批次）：缺省屏蔽宿主环境的工作区根锚——既有用例全部
    // 走「无锚回退 cwd 单键」路径不受宿主环境干扰；锚路径用例经 opts.anchor 显式注入。
    ZCODE_PROJECT_DIR: '',
    ...(opts.anchor ? { ZCODE_PROJECT_DIR: opts.anchor } : {}),
    WF_UPROMPT_STATE_DIR: stateDir,
    WF_UPROMPT_COOLDOWN_MS: opts.cooldownMs ?? LONG_COOLDOWN,
    ...(opts.nudgeEvery ? { WF_UPROMPT_NUDGE_EVERY: opts.nudgeEvery } : {}),
    ...(opts.correctionOff ? { WF_UPROMPT_CORRECTION: 'off' } : {}),
    // 租约状态目录一并隔离（任务租约行每轮写入，避免并行测试互踩）
    WF_ROUTING_STATE_DIR: join(stateDir, 'lease'),
    // 日志哨兵注入缝：缺省指向不存在路径（本文件测提醒逻辑），套件级哨兵用例显式传 logPath
    WF_GUARD_LOG_PATH: opts.logPath ?? join(stateDir, 'no-guard-log.jsonl'),
    // 内部模块-15 自察记录根隔离（纠正捕获/待排查指针读写）
    WF_INCIDENT_ROOT: stateDir,
    // 哨兵复发小时桶注入缝（B3：跨小时复发的测试隔离）
    ...(opts.guardHour ? { WF_GUARD_HOUR: opts.guardHour } : {}),
    // 内部任务-8 阶段 5：任意透传注入缝（如 WF_UPROMPT_INJECT_DROP_CHALLENGE）
    ...(opts.extraEnv ?? {}),
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...(opts.args ?? [])], {
    input: payload,
    encoding: 'utf8',
    env,
  });
  if (!opts.stateDir) rmSync(stateDir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/**
 * 解析注入信封；无输出时返回 null。
 * @param {string} stdout 脚本 stdout
 */
function envelope(stdout) {
  const t = stdout.trim();
  if (!t) return null;
  return JSON.parse(t);
}

/** 信封正文（无输出时空串）。 */
function ctxOf(stdout) {
  return envelope(stdout)?.hookSpecificOutput?.additionalContext ?? '';
}

const PAYLOAD = (session, prompt, cwd = REPO_CWD) =>
  JSON.stringify({ session_id: session, prompt, cwd });

/** 委派负载（内部任务-20 A1/F4）：在 PAYLOAD 基础上带 delegation_depth。 */
const PAYLOAD_D = (session, prompt, depth, cwd = REPO_CWD) =>
  JSON.stringify({ session_id: session, prompt, cwd, delegation_depth: depth });

/** 造一条「真待排查」记录（errorClass=error-flag 不在分层排除面，内部决策-033）。 */
function seedPending(root, session, id) {
  appendIncident(root, {
    id, ts: Date.now(), session, taskId: null, skill: null, plugin: null,
    kind: 'tool-failure', tool: 'Bash', event: null, errorClass: 'error-flag',
    digest: digestOf(id),
  });
}

/**
 * 在 run() 的 lease 子目录预置「上一轮已声明」状态（签发+激活同源），
 * 使下一次 user-prompt 运行在「签发前读取」窗口能读到该 skill。
 * @param {string} stateDir run() 使用的状态目录
 * @param {string} session 会话键（须与 PAYLOAD 的 session 一致）
 * @param {string} skill 已声明 skill
 */
function seedDeclared(stateDir, session, skill) {
  const prevEnv = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = join(stateDir, 'lease');
  try {
    const key = projectKey(REPO_CWD);
    const ch = issueChallenge(key, { sessionId: session });
    const r = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-1', skill });
    assert.ok(r.ok, `seed 声明须成功：${r.reason}`);
  } finally {
    if (prevEnv === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevEnv;
  }
}

test('每条用户消息（含首条）都注入任务租约行，但首条不注入提醒', () => {
  const r = run(PAYLOAD('s1', '帮我修这个 bug'));
  assert.equal(r.status, 0, '任何路径退出码都必须是 0（fail-open 姿态）');
  const ctx = ctxOf(r.stdout);
  assert.ok(ctx.includes('任务租约'), '任务租约行每轮必注（内部规则-8：挑战签发不随提醒节流）');
  assert.ok(ctx.includes('--lease'), '租约行必须携带可复制的声明参数');
  // P6 瘦身（2026-09-15）：长尾说明挪 deny 文案，租约行只留令牌+短命令模板+一句话
  assert.ok(!ctx.includes('纯净单命令'), '长尾说明（纯净单命令）只留 deny 文案，租约行不再携带');
  assert.ok(!ctx.includes('嵌套 git 仓'), '长尾说明（嵌套仓 cd）只留 deny 文案，租约行不再携带');
  assert.ok(!ctx.includes('内部决策-018'), '轮换语义说明只留 deny 文案，租约行不再携带');
  const leaseLineText = ctx.split('\n').find((l) => l.includes('任务租约'));
  assert.ok(leaseLineText.length <= 230, `租约行瘦身长度上限（实测 ${leaseLineText.length} 字符）`);
  assert.ok(!ctx.includes('路由提醒'), '首条消息不注入提醒（SessionStart 已注入全文）');
});

// ── W3 丙案（2026-09-16 租约族缺陷批次）：签发键锚定工作区根 ──

test('W3 锚单仓：锚仓根签发不随 cwd 漂移 + cwd 域并集兜底（内部任务-LEASEATT-1）；探针观测已收口不落盘（2026-09-19 评审修复批）', () => {
  const anchorRepo = mkdtempSync(join(tmpdir(), 'uprompt-anchor-'));
  const driftRepo = mkdtempSync(join(tmpdir(), 'uprompt-drift-'));
  try {
    mkdirSync(join(anchorRepo, '.git'));
    mkdirSync(join(driftRepo, '.git')); // 负载 cwd 是另一仓（模拟 cd 漂移进嵌套仓）
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir = join(stateDir, 'lease');
    const r = run(PAYLOAD('s-w3a', '任务', driftRepo), { stateDir, anchor: anchorRepo });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('任务租约'), '租约行照常注入');
    assert.equal(ctx.split('\n').filter((l) => l.includes('任务租约')).length, 2, '锚仓与 cwd 仓各一行（内部任务-LEASEATT-1 并集）');
    const cur = readFileSync(join(leaseDir, `wf-lease-current-${keyDigestOf(anchorRepo)}-${digestOf('s:s-w3a')}.json`), 'utf8');
    const tok = JSON.parse(cur).leaseId;
    assert.ok(tok && ctx.includes(tok), '挑战须签发在锚仓键桶且令牌进租约行');
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(driftRepo)}-${digestOf('s:s-w3a')}.json`)),
      'cwd 仓键并集同签（锚漂移时闸执法键恒有挑战，内部任务-LEASEATT-1）');
    const fwdDriftA = realpathSync(driftRepo).replaceAll('\\', '/');
    assert.ok(ctx.includes(`--project-root '${fwdDriftA}'`), 'cwd 仓行绑定 driftRepo 根（任意目录可复制声明，阶段复审发现 3 归并）');
    // 探针观测件（w3-anchor-probe）已随 2026-09-19 评审修复批移除：不再落 stop-probe.jsonl
    assert.ok(!existsSync(join(driftRepo, '.workflow', 'stop-probe.jsonl')), '探针观测已收口，不落观测文件');
  } finally {
    rmSync(anchorRepo, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

test('W3 锚仓内嵌套仓：锚仓与嵌套仓同轮签发（评审 C1——漏签嵌套键=嵌套仓编辑死锁）', () => {
  const anchorRepo = mkdtempSync(join(tmpdir(), 'uprompt-anchor2-'));
  const driftRepo = mkdtempSync(join(tmpdir(), 'uprompt-drift3-'));
  try {
    mkdirSync(join(anchorRepo, '.git'));
    const nested = join(anchorRepo, 'vendored-nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    mkdirSync(join(driftRepo, '.git'));
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir = join(stateDir, 'lease');
    const r = run(PAYLOAD('s-w3d', '任务', driftRepo), { stateDir, anchor: anchorRepo });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const lines = ctx.split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines.length, 3, '锚仓+嵌套仓+cwd 仓各一行（内部任务-LEASEATT-1 并集）');
    for (const repo of [anchorRepo, nested]) {
      assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(repo)}-${digestOf('s:s-w3d')}.json`)),
        `${repo} 须有挑战签发（嵌套仓编辑的闸键可达）`);
    }
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(driftRepo)}-${digestOf('s:s-w3d')}.json`)),
      'cwd 仓键并集同签（内部任务-LEASEATT-1）');
  } finally {
    rmSync(anchorRepo, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

test('W3 多仓工作区：每仓一行租约行（各持令牌、行长 ≤ 基线300+命令段实测长——FB-1 放宽；内部未决-91 后命令恒真路径形态，预算随命令段动态推导），非仓目录不签发', () => {
  // 内部任务-250（2026-10-28 win32 回归修复）：夹具名前缀保持**短且定长**——多仓行长断言按
  // 内部规则-8 ④ 模板预算口径（不净出路径段），前缀过长会把「夹具路径长度」算进被测行为；
  // win32 tmpdir 路径随用户名变化且长于 linux /tmp（见 FIXTURE_ROOT 注）。
  const ws = mkdtempSync(join(FIXTURE_ROOT, 'uws-')); // 工作区根：无 .git（多仓形态）
  const driftRepo = mkdtempSync(join(FIXTURE_ROOT, 'ud-'));
  try {
    const repoA = join(ws, 'repo-a');
    const repoB = join(ws, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });
    mkdirSync(join(ws, 'plain-dir'), { recursive: true }); // 非仓目录
    mkdirSync(join(driftRepo, '.git'));
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir = join(stateDir, 'lease');
    const r = run(PAYLOAD('s-w3b', '任务', driftRepo), { stateDir, anchor: ws });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const lines = ctx.split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines.length, 3, '两仓与 cwd 仓各一行（内部任务-LEASEATT-1 并集）');
    // FB-1（2026-09-18 反馈批次）：多仓行命令附 --project-root「仓根」——任意目录可直接
    // 复制执行（解 cwd 耦合），行长口径随 actionable 信息量放宽（单行形态不变 ≤230）。
    // 内部未决-91（内部任务-48）：根推导收敛后命令恒为自身位置真路径，长度随仓库检出路径变化
    // （占位符 38 字符 → 本机 75）——固定数值断言会随检出深度/用户名跨机翻红（Windows
    // 开发布局推算余量曾仅 1 字符），故预算按「FB-1 基线 300 − 占位符 38 + 命令段实测长」
    // 动态推导：模板预算语义不变（多出的预算恰等于命令段多出的长度），数值载体=内部模块-8 内部规则-8。
    // 内部任务-250（2026-10-28 win32 回归修复）：预算公式保持 内部规则-8 ④ 原口径「300 − 占位符 38 +
    // 命令段实测长」（模板预算语义）不变；仓根路径/仓标签属夹具可变段，不纳入断言口径——
    // 通过夹具名前缀缩短（uws-/ud-）把路径长度控制在 FB-1 标定内（内部任务-247 tail +33 后余量
    // 收窄为「label 9 + 仓根 88 − 33 = 64」；旧前缀实测 key+label 67/79 越界，行 340/352）。
    const budget = 300 - 38 + EXPECTED_DECLARE_CMD.length;
    for (const l of lines) assert.ok(l.length <= budget, `多仓租约行长度上限（预算 ${budget}，实测 ${l.length}）`);
    assert.ok(lines[0].includes('仓 repo-a｜'), '多仓行须带仓短名标签');
    assert.ok(lines[0].includes('--project-root'), '多仓行命令须附 --project-root（FB-1）');
    // PHASE1 评审 C3：输出行仓根按 内部未决-13 口径归一正斜杠，断言侧同步归一（Windows 本机
    // 分隔符为反斜杠，不归一则跨平台恒假）；内部任务-MACKEY-1：签发键 canonical（realpath）
    // 形态，文本期望值须同形态
    const fwdA = realpathSync(repoA).replaceAll('\\', '/');
    const fwdB = realpathSync(repoB).replaceAll('\\', '/');
    assert.ok(lines[0].includes(fwdA), '多仓行须点名该仓根（可复制即正确）');
    assert.ok(lines.some((l) => l.includes('仓 repo-b｜')), '两行分属两仓');
    assert.ok(lines.some((l) => l.includes(`--project-root '${fwdB}'`)), 'repo-b 行绑定 repo-b 仓根');
    for (const repo of [repoA, repoB]) {
      assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(repo)}-${digestOf('s:s-w3b')}.json`)),
        `${repo} 须有挑战签发`);
    }
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(driftRepo)}-${digestOf('s:s-w3b')}.json`)),
      'cwd 仓键并集同签（内部任务-LEASEATT-1）');
    assert.ok(!existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(join(ws, 'plain-dir'))}-${digestOf('s:s-w3b')}.json`)),
      '非仓目录不得作为签发键');
    const tokA = JSON.parse(readFileSync(join(leaseDir, `wf-lease-current-${keyDigestOf(repoA)}-${digestOf('s:s-w3b')}.json`), 'utf8')).leaseId;
    assert.ok(lines.some((l) => l.includes(tokA)), 'repo-a 行携带自己的令牌');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

// ── 内部任务-247 F4：多仓租约行 Bash 键控提示（单仓 tail 逐字节不变） ──

test('多仓租约行 Bash 键控提示（内部任务-247）', () => {
  const ws = mkdtempSync(join(FIXTURE_ROOT, 'uprompt-ws-f4-')); // 工作区根：无 .git（多仓形态）
  const driftRepo = mkdtempSync(join(FIXTURE_ROOT, 'uprompt-drift-f4-')); // 负载 cwd 仓（签发面要求 cwd 在仓内，W3 同款）
  try {
    const repoA = join(ws, 'repo-a');
    const repoB = join(ws, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });
    mkdirSync(join(driftRepo, '.git'));
    const r = run(PAYLOAD('s-f4', '任务', driftRepo), { stateDir: mkdtempSync(join(tmpdir(), 'uprompt-state-')), anchor: ws });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const lines = ctx.split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines.length, 3, '锚两仓与 cwd 仓各一行（W3 并集形态）');
    // 多仓 tail：Bash 执法键随 cwd 的提示＋纯 cd 逃生指引（内部任务-16 实录的可发现性补全）
    for (const l of lines) {
      assert.ok(l.includes('Bash 按 cwd 所在仓执法'), '多仓行须提示 Bash 键控维度');
      assert.ok(l.includes('纯 cd 回仓根'), '多仓行须给出纯 cd 逃生指引');
    }
    // 对照：单仓行 tail 逐字节不变（历史形态，存量断言/下游解析零漂移）
    const single = mkdtempSync(join(FIXTURE_ROOT, 'uprompt-single-f4-'));
    try {
      mkdirSync(join(single, '.git'), { recursive: true });
      const r1 = run(PAYLOAD('s-f4s', '任务', single), { stateDir: mkdtempSync(join(tmpdir(), 'uprompt-state-')), anchor: single });
      assert.equal(r1.status, 0);
      const line1 = ctxOf(r1.stdout).split('\n').filter((l) => l.includes('任务租约'))[0];
      assert.ok(line1.endsWith('（声明后本会话放行）'), '单仓 tail 逐字节不变');
      assert.ok(!line1.includes('cwd 所在仓'), '单仓行不带多仓提示');
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

test('标记域键签发（2026-09-19 评审修复 H3）：锚定多仓工作区内非 git 的 .sdd 项目同轮获租约行与挑战', () => {
  // 场景=评审发现 H3：ZCODE_PROJECT_DIR 锚（非 git 工作区）内含 git 仓与含 .sdd/ 的
  // 非 git 项目——闸键经 activationRoot 覆盖标记根，签发漏标记键即「声明永不满足闸」
  const ws = mkdtempSync(join(tmpdir(), 'uprompt-wsm-'));
  const driftRepo = mkdtempSync(join(tmpdir(), 'uprompt-driftm-'));
  try {
    const repoA = join(ws, 'repo-a');
    const sddProj = join(ws, 'sdd-proj');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(sddProj, '.sdd'), { recursive: true }); // 非 git 的 spec-gate 接入项目
    mkdirSync(join(ws, 'plain-dir'), { recursive: true }); // 无标记非仓目录：仍不签发
    mkdirSync(join(driftRepo, '.git'));
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir = join(stateDir, 'lease');
    const r = run(PAYLOAD('s-wsm', '任务', driftRepo), { stateDir, anchor: ws });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const lines = ctx.split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines.length, 3, '仓键、标记域键与 cwd 仓各一行（内部任务-LEASEATT-1 并集）');
    const fwdSdd = realpathSync(sddProj).replaceAll('\\', '/');
    assert.ok(lines.some((l) => l.includes(`--project-root '${fwdSdd}'`)), '标记域行绑定 .sdd 项目根');
    assert.ok(
      existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(sddProj)}-${digestOf('s:s-wsm')}.json`)),
      '标记域键须有挑战签发（闸可达键集 ⊆ 签发键集）'
    );
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(driftRepo)}-${digestOf('s:s-wsm')}.json`)),
      'cwd 仓键并集同签（内部任务-LEASEATT-1）');
    assert.ok(
      !existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(join(ws, 'plain-dir'))}-${digestOf('s:s-wsm')}.json`)),
      '无标记非仓目录不得作为签发键'
    );
    // 端到端（计划 1.3 验收）：标记域键声明后，D 内文件的 Edit 闸判定放行——
    // 修复前 D 键无挑战，声明永不满足闸（永久 deny 死循环，评审发现 H3 形态）
    const challenge = JSON.parse(
      readFileSync(join(leaseDir, `wf-lease-current-${keyDigestOf(sddProj)}-${digestOf('s:s-wsm')}.json`), 'utf8'),
    );
    const hooksDir = dirname(SCRIPT);
    const leaseEnv = { ...process.env, WF_ROUTING_STATE_DIR: leaseDir };
    const dec = spawnSync(process.execPath, [
      join(hooksDir, 'routing-declare.mjs'), 'code-review',
      '--lease', challenge.leaseId, '--task-id', '内部任务-2', '--project-root', sddProj,
    ], { encoding: 'utf8', env: leaseEnv });
    assert.equal(dec.status, 0, `标记域声明须成功：${dec.stderr}`);
    const gate = spawnSync(process.execPath, [join(hooksDir, 'routing-gate.mjs')], {
      input: JSON.stringify({
        session_id: 's-wsm', cwd: sddProj, tool_name: 'Edit',
        tool_input: { file_path: join(sddProj, 'note.md') },
      }),
      encoding: 'utf8', env: leaseEnv,
    });
    assert.equal(gate.status, 0, `声明后 D 内文件编辑须放行（stderr：${gate.stderr}）`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

test('纯标记工作区（2026-09-19 评审修复 H3 评审门补口）：锚下只有 .sdd 项目无 git 仓也走标记域签发', () => {
  // 旧行为：锚发现 git 仓为空 → 落回 cwd 回退 → 标记键永远无挑战（永久 deny 的另一形态）
  const ws = mkdtempSync(join(tmpdir(), 'uprompt-wsp-'));
  const driftRepo = mkdtempSync(join(tmpdir(), 'uprompt-driftp-'));
  try {
    const sddProj = join(ws, 'only-sdd');
    mkdirSync(join(sddProj, '.sdd'), { recursive: true });
    mkdirSync(join(driftRepo, '.git'));
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir = join(stateDir, 'lease');
    const r = run(PAYLOAD('s-wsp', '任务', driftRepo), { stateDir, anchor: ws });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const lines = ctx.split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines.length, 2, '标记域键与 cwd 仓各一行（内部任务-LEASEATT-1 并集兜底）');
    const fwdSdd = realpathSync(sddProj).replaceAll('\\', '/');
    const sddLine = lines.find((l) => l.includes(`--project-root '${fwdSdd}'`));
    assert.ok(sddLine, '标记域行须绑定 sddProj 根');
    assert.ok(sddLine.includes('仓 only-sdd｜'), '多行形态带仓标签');
    const fwdDrift = realpathSync(driftRepo).replaceAll('\\', '/');
    assert.ok(lines.some((l) => l.includes(`--project-root '${fwdDrift}'`)), 'cwd 仓行绑定 driftRepo 根（并集兜底）');
    assert.ok(
      existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(sddProj)}-${digestOf('s:s-wsp')}.json`)),
      '纯标记键须有挑战签发'
    );
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(driftRepo)}-${digestOf('s:s-wsp')}.json`)),
      'cwd 仓键并集同签（内部任务-LEASEATT-1）');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(driftRepo, { recursive: true, force: true });
  }
});

test('锚覆盖 cwd 单键历史形态 + 外层祖先仓并集（内部任务-LEASEATT-1）', () => {
  const cwdRepo = mkdtempSync(join(tmpdir(), 'uprompt-cwdL-'));
  const outer = mkdtempSync(join(tmpdir(), 'uprompt-outerL-'));
  try {
    mkdirSync(join(cwdRepo, '.git'));
    const child = join(outer, 'child');
    mkdirSync(join(outer, '.git'));
    mkdirSync(join(child, '.git'), { recursive: true });
    // 场景①：锚覆盖 cwd 且锚仓无 git 祖先仓——并集无新键，单键历史形态逐字节保持
    const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const r1 = run(PAYLOAD('s-lb', '任务', cwdRepo), { stateDir, anchor: cwdRepo });
    assert.equal(r1.status, 0);
    const lines1 = ctxOf(r1.stdout).split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines1.length, 1, '锚覆盖 cwd：单键历史形态');
    assert.ok(lines1[0].startsWith('【workflow 任务租约】本轮令牌'), '单键行无仓标签/无 --project-root');
    // 场景②：锚仓嵌套于外层仓（直接子仓拓扑）——外层祖先照签（阶段复审发现 2：祖先探测从直接父目录起）
    const stateDir2 = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir2 = join(stateDir2, 'lease');
    const r2 = run(PAYLOAD('s-lc', '任务', child), { stateDir: stateDir2, anchor: child });
    assert.equal(r2.status, 0);
    const lines2 = ctxOf(r2.stdout).split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines2.length, 2, '锚仓与外层祖先仓各一行（直接父目录命中）');
    const fwdOuter = realpathSync(outer).replaceAll('\\', '/');
    assert.ok(lines2.some((l) => l.includes(`--project-root '${fwdOuter}'`)), '外层祖先仓行绑定 outer 根');
    assert.ok(existsSync(join(leaseDir2, `wf-lease-current-${keyDigestOf(outer)}-${digestOf('s:s-lc')}.json`)),
      '外层祖先仓须有挑战签发（外层仓文件的 Edit/Write 闸键可达）');
    // 场景③：锚漂移 + cwd 落在锚域外纯标记项目（非 git）——标记根并集兜底（收尾终审发现）
    const gitAnchor = mkdtempSync(join(tmpdir(), 'uprompt-anchorM-'));
    const sddOut = mkdtempSync(join(tmpdir(), 'uprompt-sddout-'));
    mkdirSync(join(gitAnchor, '.git'));
    mkdirSync(join(sddOut, '.sdd'), { recursive: true }); // 非 git 的 spec-gate 接入项目
    const stateDir3 = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
    const leaseDir3 = join(stateDir3, 'lease');
    const r3 = run(PAYLOAD('s-ld', '任务', sddOut), { stateDir: stateDir3, anchor: gitAnchor });
    assert.equal(r3.status, 0);
    const lines3 = ctxOf(r3.stdout).split('\n').filter((l) => l.includes('任务租约'));
    assert.equal(lines3.length, 2, '锚仓与标记域键各一行（非 git cwd 标记根兜底）');
    const fwdSddOut = realpathSync(sddOut).replaceAll('\\', '/');
    assert.ok(lines3.some((l) => l.includes(`--project-root '${fwdSddOut}'`)), '标记域行绑定 sddOut 根');
    assert.ok(existsSync(join(leaseDir3, `wf-lease-current-${keyDigestOf(sddOut)}-${digestOf('s:s-ld')}.json`)),
      '标记根须有挑战签发（Bash 闸执法键可达，不变量兜底）');
    rmSync(gitAnchor, { recursive: true, force: true });
    rmSync(sddOut, { recursive: true, force: true });
    rmSync(stateDir3, { recursive: true, force: true });
  } finally {
    rmSync(cwdRepo, { recursive: true, force: true });
    rmSync(outer, { recursive: true, force: true });
  }
});

test('W3 无锚回退：签发键=负载 cwd 上溯（既有行为保持，形态与历史逐字节一致）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  const leaseDir = join(stateDir, 'lease');
  try {
    const sub = join(REPO_CWD, 'sub'); // cwd 在仓子目录：上溯到 REPO_CWD
    mkdirSync(sub, { recursive: true });
    const r = run(PAYLOAD('s-w3c', '任务', sub), { stateDir });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const line = ctx.split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line.startsWith('【workflow 任务租约】本轮令牌 '), '无锚单键不带仓标签（历史形态）');
    assert.ok(existsSync(join(leaseDir, `wf-lease-current-${keyDigestOf(REPO_CWD)}-${digestOf('s:s-w3c')}.json`)),
      '无锚时签发键=cwd 上溯仓根');
  } finally {
    rmSync(join(REPO_CWD, 'sub'), { recursive: true, force: true });
  }
});

test('冷却期外的后续消息：租约行 + 指针级提醒（信封事件名 = UserPromptSubmit）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    run(PAYLOAD('s2', '第一条'), { stateDir }); // 建立状态
    const r = run(PAYLOAD('s2', '来一个新任务'), { stateDir, cooldownMs: '0' });
    assert.equal(r.status, 0);
    const env = envelope(r.stdout);
    assert.ok(env, '冷却期外应注入提醒');
    assert.equal(env.hookSpecificOutput?.hookEventName, 'UserPromptSubmit', '信封事件名必须与触发事件一致（内部规则-6）');
    const ctx = env.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('任务租约'), '租约行持续注入');
    assert.ok(ctx.includes('路由表'), '提醒内容必须指向路由表');
    assert.ok(ctx.includes('routing-declare.mjs'), '提醒必须携带机械声明命令（内部规则-7/内部规则-8 衔接）');
    assert.ok(ctx.includes("node '"), '声明命令为单引号包裹形态（内部未决-94：bash/pwsh 双壳零展开，Git Bash 可直接复制执行）');
    assert.ok(ctx.includes("/hooks/routing-declare.mjs'"), '命令路径正斜杠形态判别（内部未决-13 防回退反斜杠）');
    assert.ok(ctx.length < 500, '注入须保持指针级（租约行 + 提醒各一到两行），不重灌全文');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部未决-91：env 双清空时声明命令走自身位置真路径（收敛前的 env-only 缺陷形态不复现）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    run(PAYLOAD('s-o91', '第一条'), { stateDir });
    const r = run(PAYLOAD('s-o91', '新任务'), {
      stateDir,
      cooldownMs: '0',
      // 双清空（空串在 pluginRootDir 的候选判定下等同缺席）——旧 env-only 实现此时退占位符，
      // 收敛后应走钩子自身位置（=本仓 workflow 插件根 realpath 形态）。
      extraEnv: { ZCODE_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
    });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    const expected = EXPECTED_DECLARE_CMD;
    assert.ok(ctx.includes(expected), `声明命令须为自身位置真路径（期望片段：${expected}；实际：${ctx.split('\n').find((l) => l.includes('routing-declare')) ?? ''}）`);
    assert.ok(!ctx.includes('<插件根>'), 'env 缺席而自身位置有效时不得退占位符');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('冷却期内的后续消息只保留租约行（提醒节流，租约不节流）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    run(PAYLOAD('s3', '第一条'), { stateDir });
    run(PAYLOAD('s3', '第二条任务'), { stateDir, cooldownMs: '0' }); // 注入并刷新节流
    const r = run(PAYLOAD('s3', '第三条任务'), { stateDir }); // 冷却期内
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('任务租约'), '租约行不受节流约束');
    assert.ok(!ctx.includes('路由提醒'), '冷却期内不得重复注入提醒');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('用户消息已含「路由表」视为已声明：提醒跳过并刷新节流（租约行照常）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    run(PAYLOAD('s4', '第一条'), { stateDir });
    const declared = run(PAYLOAD('s4', '我查过路由表了，命中 root-cause-debugging'), { stateDir, cooldownMs: '0' });
    assert.ok(ctxOf(declared.stdout).includes('任务租约'), '租约行照常注入');
    assert.ok(!ctxOf(declared.stdout).includes('路由提醒'), '已声明的消息不应再提醒');
    const after = run(PAYLOAD('s4', '下一条任务'), { stateDir }); // 声明刷新了节流 → 冷却期内
    assert.ok(!ctxOf(after.stdout).includes('路由提醒'), '用户声明须刷新节流起点');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('垃圾负载 fail-open：退出 0、无输出', () => {
  const r = run('{{{ not-json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('会话间提醒状态隔离（不同 session_id 的提醒互不影响）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    run(PAYLOAD('sess-a', 'a 第一条'), { stateDir });
    run(PAYLOAD('sess-a', 'a 第二条'), { stateDir, cooldownMs: '0' }); // a 注入并节流
    const b = run(PAYLOAD('sess-b', 'b 第一条'), { stateDir });
    assert.ok(!ctxOf(b.stdout).includes('路由提醒'), 'sess-b 的首条消息应跳过提醒，不被 sess-a 的节流误伤');
    const b2 = run(PAYLOAD('sess-b', 'b 第二条'), { stateDir, cooldownMs: '0' });
    assert.ok(ctxOf(b2.stdout).includes('路由提醒'), 'sess-b 的后续消息应正常注入提醒');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('周期提示：第 N 倍数轮注入一行指针（默认 20 轮之外的轮次静默）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    // N=2：第 2 轮出现周期提示（提醒在长冷却期内静默——周期提示不受提醒节流挤占）
    run(PAYLOAD('s-nudge', '第 1 条'), { stateDir, nudgeEvery: '2' });
    const r2 = run(PAYLOAD('s-nudge', '第 2 条'), { stateDir, nudgeEvery: '2' });
    const ctx2 = ctxOf(r2.stdout);
    assert.ok(ctx2.includes('周期提示'), '第 2 轮（N=2 倍数）应注入周期提示');
    assert.ok(ctx2.includes('learnings'), '周期提示须指向 learnings/retro 收口');
    assert.ok(!ctx2.includes('路由提醒'), '提醒节流期内不被周期提示带出');
    const r3 = run(PAYLOAD('s-nudge', '第 3 条'), { stateDir, nudgeEvery: '2' });
    assert.ok(!ctxOf(r3.stdout).includes('周期提示'), '非倍数轮无周期提示（N=2 时第 3 轮仅租约行）');
    assert.ok(ctxOf(r3.stdout).includes('任务租约'), '租约行仍在');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('周期提示 N=1 边界：每轮都提示（含首条——首条跳过的是提醒不是周期提示）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    const r1 = run(PAYLOAD('s-n1', '第一条'), { stateDir, nudgeEvery: '1' });
    const ctx1 = ctxOf(r1.stdout);
    assert.ok(ctx1.includes('周期提示'), 'N=1 时首条即提示');
    assert.ok(!ctx1.includes('路由提醒'), '首条仍不注入路由提醒（SessionStart 已注入全文）');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('周期提示默认静默：前 5 轮无周期提示与提醒（仅租约行）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    let last = null;
    for (let i = 1; i <= 5; i += 1) {
      last = run(PAYLOAD('s-def', `第 ${i} 条`), { stateDir });
    }
    const ctx = ctxOf(last.stdout);
    assert.ok(!ctx.includes('周期提示') && !ctx.includes('路由提醒'), '未到默认周期且提醒节流内：仅租约行');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--selftest 自检入口（B-M8-4）', () => {
  const r = run('', { args: ['--selftest'] });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('OK'), '自检入口应输出 OK');
});

// ── 内部决策-018：per-session 挑战签发的状态形态 ──

test('签发后 current 指针存在且含 sessionId；同会话二次签发轮换即吊销旧 token', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  const leaseDir = join(stateDir, 'lease');
  try {
    const first = run(PAYLOAD('sess-A', '第一条'), { stateDir });
    const m1 = ctxOf(first.stdout).match(/--lease ([0-9a-f]{16,})/);
    assert.ok(m1, '租约行携带 token');
    const key = projectKey(REPO_CWD);
    const sessFile = join(leaseDir, `wf-lease-current-${digestOf(key)}-${digestOf('s:sess-A')}.json`);
    assert.ok(existsSync(sessFile), '会话桶 current 指针存在');
    const ptr1 = JSON.parse(readFileSync(sessFile, 'utf8'));
    assert.equal(ptr1.sessionId, 'sess-A', '指针内嵌 sessionId');
    assert.equal(ptr1.leaseId, m1[1], '指针指向本轮 token');
    // 同会话二次签发：指针换新；旧挑战文件随轮换吊销删除（桶内轮换即吊销）
    const second = run(PAYLOAD('sess-A', '第二条'), { stateDir });
    const m2 = ctxOf(second.stdout).match(/--lease ([0-9a-f]{16,})/);
    assert.notEqual(m2[1], m1[1], 'token 随本会话轮换');
    const ptr2 = JSON.parse(readFileSync(sessFile, 'utf8'));
    assert.equal(ptr2.leaseId, m2[1], '指针更新到新 token');
    assert.ok(!existsSync(join(leaseDir, `wf-lease-challenge-${m1[1]}.json`)), '旧挑战已随轮换吊销删除');
    assert.ok(existsSync(join(leaseDir, `wf-lease-challenge-${m2[1]}.json`)), '新挑战存在');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部模块-15/内部决策-019：自察三职责（套件级哨兵归因落盘 / 纠正捕获 / 待排查指针）──

/** 直读隔离根下的自察记录文件（WF_INCIDENT_ROOT=stateDir 时落在 stateDir/.workflow/）——
 *  直接复用 incident-store 读侧（同 id 末条胜出语义，评审 S4：不手抄第二份）。 */
function incidentsOf(root) {
  return readIncidents(root);
}

test('套件级哨兵：兄弟插件失败计数告警并按插件归因落 hook-failure 记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-suite-'));
  const log = join(dir, 'zcode-suite.jsonl');
  try {
    const line = (session, source) => JSON.stringify({ event: 'hook.run.failed', sessionId: session, context: { source } });
    writeFileSync(
      log,
      [
        line('sess-m15', 'plugin.spec-gate@wangp-local-marketplace.SessionStart.1.0'),
        line('sess-m15', 'plugin.scout@wangp-local-marketplace.SessionStart.0.0'),
        line('sess-m15', 'plugin.mimosa@zcode-plugins-official.PreToolUse.3.0'), // 非套件插件：不计
      ].join('\n') + '\n',
    );
    const r = run(PAYLOAD('sess-m15', '任务开始'), { stateDir: dir, logPath: log });
    assert.equal(r.status, 0, 'fail-open 姿态：任何路径退出码 0');
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('护栏异常'), '兄弟插件失败也要告警（套件级）');
    assert.ok(ctx.includes('2'), '告警含本会话计数（spec-gate 1 + scout 1）');
    const recs = incidentsOf(dir).filter((d) => d.kind === 'hook-failure');
    assert.equal(recs.length, 2, '按插件各落一条 hook-failure');
    const plugins = recs.map((d) => d.plugin).sort();
    assert.deepEqual(plugins, ['scout', 'spec-gate'], 'plugin 归因字段正确（内部模块-15 数据格式）');
    assert.ok(recs.every((d) => d.event === 'SessionStart'), 'event 从 source 解析');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('套件级哨兵（内部决策-046 扩面）：algo-loop 前缀失败按插件归因（五前缀清单回归锚）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-algo-'));
  const log = join(dir, 'zcode-suite.jsonl');
  try {
    const line = (session, source) => JSON.stringify({ event: 'hook.run.failed', sessionId: session, context: { source } });
    writeFileSync(log, line('sess-al', 'plugin.algo-loop@wangp-local-marketplace.SessionStart.0.8') + '\n');
    const r = run(PAYLOAD('sess-al', '任务开始'), { stateDir: dir, logPath: log });
    assert.equal(r.status, 0, 'fail-open 姿态');
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('护栏异常'), '第五插件失败同样告警（套件级五前缀）');
    const recs = incidentsOf(dir).filter((d) => d.kind === 'hook-failure');
    assert.equal(recs.length, 1, '落一条 hook-failure');
    assert.equal(recs[0].plugin, 'algo-loop', 'plugin 归因为 algo-loop');
    assert.equal(recs[0].event, 'SessionStart', 'event 从 source 解析');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('哨兵失败分类窄化：纯记录钩失败不告警不落记录，保护钩失败照常计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-recorder-'));
  const log = join(dir, 'zcode-recorder.jsonl');
  try {
    const line = (session, source) => JSON.stringify({ event: 'hook.run.failed', sessionId: session, context: { source } });
    writeFileSync(
      log,
      [
        // 纯记录钩双注册的两事件（workflow 自家）：失败不构成保护失效（用户按停连带杀钩
        // 属常态，2026-09-13 评估：5 次失败全部与 v4.stop 毫秒级相邻）——不得计入
        line('sess-rec', 'plugin.workflow@wangp-local-marketplace.PostToolUseFailure.0.0'),
        line('sess-rec', 'plugin.workflow@wangp-local-marketplace.PostToolUse.0.0'),
        // 保护钩失败：照常计入（含他插件在 PostToolUse 事件上的阻断性保护钩——评审 C1：
        // spec-gate 的 post-tool-use.mjs 在该事件 exit 2 阻断写入，排除面仅限 workflow 自家）
        line('sess-rec', 'plugin.workflow@wangp-local-marketplace.PreToolUse.0.0'),
        line('sess-rec', 'plugin.spec-gate@wangp-local-marketplace.PostToolUse.0.0'),
      ].join('\n') + '\n',
    );
    const r = run(PAYLOAD('sess-rec', '任务开始'), { stateDir: dir, logPath: log });
    assert.equal(r.status, 0, 'fail-open 姿态：任何路径退出码 0');
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('护栏异常'), '保护钩失败仍要告警');
    assert.ok(ctx.includes('2 次'), '只计两条保护钩失败（workflow 记录钩两条不计入）');
    const recs = incidentsOf(dir).filter((d) => d.kind === 'hook-failure');
    assert.equal(recs.length, 2, '只落保护钩两条 hook-failure');
    const events = recs.map((d) => `${d.plugin}:${d.event}`).sort();
    assert.deepEqual(events, ['spec-gate:PostToolUse', 'workflow:PreToolUse'], '归因保留插件与事件（含 spec-gate 保护性 PostToolUse）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('哨兵复发可见（B3）：同 source 跨小时落两条记录，同小时幂等一条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-recur-'));
  const log = join(dir, 'zcode-recur.jsonl');
  try {
    const line = () => JSON.stringify({ event: 'hook.run.failed', sessionId: 'sess-r', context: { source: 'plugin.spec-gate@wangp-local-marketplace.SessionStart.1.0' } });
    writeFileSync(log, line() + '\n');
    const first = run(PAYLOAD('sess-r', '第一条'), { stateDir: dir, logPath: log, guardHour: '10' });
    assert.ok(ctxOf(first.stdout).includes('护栏异常'), '首次失败告警');
    // 复发（日志新增同 source 失败行）且跨小时桶：落第二条（id 不同，读侧不去重）
    appendFileSync(log, line() + '\n');
    run(PAYLOAD('sess-r', '第二条'), { stateDir: dir, logPath: log, guardHour: '11' });
    assert.equal(incidentsOf(dir).filter((d) => d.kind === 'hook-failure').length, 2, '跨小时复发可见（不再被 source 幂等吞掉）');
    // 同小时桶复发：id 相同，读侧幂等仍一条
    appendFileSync(log, line() + '\n');
    run(PAYLOAD('sess-r', '第三条'), { stateDir: dir, logPath: log, guardHour: '11' });
    assert.equal(incidentsOf(dir).filter((d) => d.kind === 'hook-failure').length, 2, '同小时内幂等（不刷屏）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按停窗跨增量生效：stop 行在上次扫描段，持久化 lastStopTs 排除新增段失败（旧 number 状态兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-stopwin-'));
  const log = join(dir, 'zcode-stopwin.jsonl');
  const T0 = '2026-09-14T10:00:00.000Z';
  const stateFilePath = join(dir, `wf-uprompt-${digestOf('sess-sw')}.json`);
  try {
    // 预置旧 number 形态状态（窄化前版本遗留：scan 值是纯字节 offset）——升级后须宽容读入
    writeFileSync(stateFilePath, JSON.stringify({ count: 1, last: Date.now(), failSeen: 0, alerted: false, scan: { [log]: 0 }, corrected: [] }));
    // 上次扫描段：只有同会话 stop 行（无失败 → 无告警）
    writeFileSync(log, JSON.stringify({ timestamp: T0, level: 'info', event: 'v4.stop.foreground_execution_inspected', sessionId: 'sess-sw' }) + '\n');
    const first = run(PAYLOAD('sess-sw', '第一条'), { stateDir: dir, logPath: log });
    assert.equal(first.status, 0, 'fail-open 姿态：任何路径退出码 0');
    assert.ok(!ctxOf(first.stdout).includes('护栏异常'), 'stop 行本身不是失败，不告警');
    const st = JSON.parse(readFileSync(stateFilePath, 'utf8'));
    assert.ok(st.scan[log] && typeof st.scan[log] === 'object' && Number.isFinite(st.scan[log].offset), '旧 number 形态被兼容：扫描状态升级为对象且 offset 正常推进');
    assert.equal(st.scan[log].lastStopTs, Date.parse(T0), 'lastStopTs 持久化（跨增量窗排除的依据）');
    // 新增段：stop 后 800ms 的失败行（Stop 事件保护钩，不被纯记录钩排除面覆盖）
    appendFileSync(log, JSON.stringify({ timestamp: '2026-09-14T10:00:00.800Z', level: 'warn', event: 'hook.run.failed', sessionId: 'sess-sw', context: { source: 'plugin.workflow@wangp-local-marketplace.Stop.1.2' } }) + '\n');
    const second = run(PAYLOAD('sess-sw', '第二条'), { stateDir: dir, logPath: log });
    assert.equal(second.status, 0);
    assert.ok(!ctxOf(second.stdout).includes('护栏异常'), '新增段失败落在持久化 stop 窗内：排除生效');
    assert.equal(incidentsOf(dir).filter((d) => d.kind === 'hook-failure').length, 0, '不落 hook-failure incident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('纠正捕获：命中记一条并注入提示；同模式不重复；=off 可关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-correction-'));
  try {
    const first = run(PAYLOAD('sess-c', '不对，这里错了'), { stateDir: dir });
    assert.ok(ctxOf(first.stdout).includes('纠正信号'), '命中纠正模式注入提示行');
    assert.equal(incidentsOf(dir).filter((d) => d.kind === 'user-correction').length, 1, '落一条 user-correction');
    const second = run(PAYLOAD('sess-c', '还是不对'), { stateDir: dir });
    assert.ok(!ctxOf(second.stdout).includes('纠正信号'), '同模式第二次不重复记（每会话一次）');
    assert.equal(incidentsOf(dir).filter((d) => d.kind === 'user-correction').length, 1);
    const off = mkdtempSync(join(tmpdir(), 'uprompt-correction-off-'));
    try {
      const r = run(PAYLOAD('sess-c', '不对'), { stateDir: off, correctionOff: true });
      assert.ok(!ctxOf(r.stdout).includes('纠正信号'), 'WF_UPROMPT_CORRECTION=off 关闭捕获');
      assert.equal(incidentsOf(off).length, 0);
    } finally {
      rmSync(off, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非仓目录（无 .git 祖先）五跳一保：不注入租约/提醒/指针，不落 incident，哨兵告警仍在（2026-09-15 激活域）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-norepo-'));
  const log = join(dir, 'zcode-norepo.jsonl');
  const nonRepo = join(dir, 'scratch');
  try {
    mkdirSync(nonRepo, { recursive: true }); // 无 .git
    writeFileSync(
      log,
      JSON.stringify({ event: 'hook.run.failed', sessionId: 'sess-nr', context: { source: 'plugin.workflow@wangp-local-marketplace.PreToolUse.0.0' } }) + '\n',
    );
    // 纠正模式「不对」+ 冷却期 0（提醒路径若存活会注入）+ 哨兵失败行
    const r = run(PAYLOAD('sess-nr', '不对，这里也错了', nonRepo), { stateDir: dir, logPath: log, cooldownMs: '0' });
    assert.equal(r.status, 0, 'fail-open 姿态不变');
    const ctx = ctxOf(r.stdout);
    assert.ok(!ctx.includes('任务租约'), '非仓不签租约、不注入租约行');
    assert.ok(!ctx.includes('路由提醒'), '非仓不注入路由提醒');
    assert.ok(!ctx.includes('周期提示'), '非仓不注入周期提示');
    assert.ok(!ctx.includes('待排查'), '非仓不渲染待排查指针');
    assert.ok(!ctx.includes('纠正信号'), '非仓不做纠正捕获');
    assert.ok(ctx.includes('护栏异常'), '哨兵告警保留（环境健康与项目纪律无关——五跳一保的唯一例外）');
    assert.equal(incidentsOf(dir).length, 0, '非仓不落任何 incident（纠偏与哨兵归因都不写）');
    assert.ok(!existsSync(join(nonRepo, '.workflow')), '非仓 cwd 不产生 .workflow 垃圾目录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待排查指针分层：open lease-deny 不计入计数（机制正常执法留痕，内部决策-022）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-ld-'));
  const incidentsFile = join(dir, '.workflow', 'incidents.jsonl');
  try {
    const mk = (id, kind) =>
      JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), session: 'other', kind, digest: `dg${id}`.slice(0, 16), status: 'open' });
    mkdirSync(dirname(incidentsFile), { recursive: true });
    writeFileSync(incidentsFile, [mk('ld-p1', 'lease-deny'), mk('tf-p2', 'tool-failure'), mk('ld-p3', 'lease-deny')].join('\n') + '\n');
    const r = run(PAYLOAD('sess-ld', '任务'), { stateDir: dir });
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('待排查'), '存在真异常时指针仍显示');
    assert.ok(ctx.includes('1 条'), '只计 1 条（tool-failure）；两条 open lease-deny 分层不计入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待排查指针分层：open lease-loop 计入计数（升级信号人可见，内部任务-LEASEGATE-1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-ll-'));
  const incidentsFile = join(dir, '.workflow', 'incidents.jsonl');
  try {
    const mk = (id, kind) =>
      JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), session: 'other', kind, digest: `dg${id}`.slice(0, 16), status: 'open' });
    mkdirSync(dirname(incidentsFile), { recursive: true });
    writeFileSync(incidentsFile, [mk('ll-p1', 'lease-loop'), mk('ld-p2', 'lease-deny')].join('\n') + '\n');
    const r = run(PAYLOAD('sess-ll', '任务'), { stateDir: dir });
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('待排查'), 'lease-loop 存在时指针显示');
    assert.ok(ctx.includes('1 条'), 'lease-loop 计入、lease-deny 仍分层不计入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待排查指针分层：open exit-nonzero 探针不计入计数（内部任务-OSNOISE-1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-probe-'));
  const incidentsFile = join(dir, '.workflow', 'incidents.jsonl');
  try {
    const mk = (id, errorClass, session = 'other') =>
      JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), session, kind: 'tool-failure', errorClass, digest: `dg${id}`.slice(0, 16), status: 'open' });
    mkdirSync(dirname(incidentsFile), { recursive: true });
    // 只有探针噪声 ⇒ 指针不出现
    writeFileSync(incidentsFile, [mk('tf-p1', 'exit-nonzero'), mk('tf-p2', 'exit-nonzero')].join('\n') + '\n');
    assert.ok(
      !ctxOf(run(PAYLOAD('sess-probe-1', '任务'), { stateDir: dir }).stdout).includes('待排查'),
      '纯探针噪声不渲染指针',
    );
    // 混入真失败（含**本会话**一条分层外的记录）⇒ 精确计 2 条且归属拆分正确
    // （收尾复审正确性：原夹具三条全在 sess-other，桶归错无断言可发现）
    writeFileSync(
      incidentsFile,
      [
        mk('tf-p1', 'exit-nonzero'),
        mk('tf-p2', 'exit-nonzero'),
        mk('tf-p3', 'error-flag'),
        mk('tf-mine', 'error-flag', 'sess-probe-2'),
      ].join('\n') + '\n',
    );
    const ctx = ctxOf(run(PAYLOAD('sess-probe-2', '任务'), { stateDir: dir }).stdout);
    assert.ok(ctx.includes('待排查'), '真失败存在时指针显示');
    // 精确计数断言（评审正确性 #5）：'1 条' 是子串口径，'11 条' 也会通过
    assert.ok(
      ctx.includes('项目有 2 条待排查（本任务 0 / 本会话 1 / 其他会话 1；证据面 2 条已分层排除）'),
      '两条 exit-nonzero 探针分层不计入，只计两条 error-flag（精确计数，非子串）',
    );
    assert.ok(ctx.includes('本会话 1 / 其他会话 1'), '分层记录同样按会话正确分桶（本会话/其他会话）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待排查指针归属拆分：本会话 / 其他会话（内部任务-DEBTFIX-1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-own-'));
  const incidentsFile = join(dir, '.workflow', 'incidents.jsonl');
  try {
    const mk = (id, session) =>
      JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), session, kind: 'tool-failure', digest: `dg${id}`.slice(0, 16), status: 'open' });
    mkdirSync(dirname(incidentsFile), { recursive: true });
    writeFileSync(incidentsFile, [mk('tf-mine-1', 'sess-mine'), mk('tf-mine-2', 'sess-mine'), mk('tf-other-1', 'sess-other')].join('\n') + '\n');
    const r = run(PAYLOAD('sess-mine', '任务'), { stateDir: dir });
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('项目有 3 条待排查（本任务 0 / 本会话 2 / 其他会话 1；证据面 0 条已分层排除）'), '总数口径不变（项目级待排查，kind≠lease-deny）');
    assert.ok(ctx.includes('本会话 2 / 其他会话 1'), '归属拆分锁语义（非对称夹具，桶互换即红）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待排查指针：open>0 期间每条消息持续显示计数（C2），归零后消失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-pointer-'));
  const incidentsFile = join(dir, '.workflow', 'incidents.jsonl');
  try {
    const openLine = JSON.stringify({ schemaVersion: 1, id: 'ri-p1', ts: Date.now(), session: 'other', kind: 'tool-failure', digest: 'ptr000000000001', status: 'open' });
    mkdirSync(dirname(incidentsFile), { recursive: true });
    writeFileSync(incidentsFile, openLine + '\n');
    const first = run(PAYLOAD('sess-p', '任务来了'), { stateDir: dir });
    assert.ok(ctxOf(first.stdout).includes('待排查'), 'open>0 注入待排查指针');
    assert.ok(ctxOf(first.stdout).includes('1 条'), '指针含计数');
    const second = run(PAYLOAD('sess-p', '继续'), { stateDir: dir });
    assert.ok(ctxOf(second.stdout).includes('待排查'), 'C2：open 未归零期间持续显示（不再一次性）');
    // 归零：open 计数归零后指针消失
    const resolvedLine = JSON.stringify({ schemaVersion: 1, id: 'ri-p1', ts: Date.now(), session: 'other', kind: 'tool-failure', digest: 'ptr000000000001', status: 'resolved' });
    writeFileSync(incidentsFile, openLine + '\n' + resolvedLine + '\n');
    const third = run(PAYLOAD('sess-p', '继续二'), { stateDir: dir });
    assert.ok(!ctxOf(third.stdout).includes('待排查'), '归零后不再显示');
    // 新 open 出现 → 恢复显示
    writeFileSync(incidentsFile, openLine + '\n');
    const fourth = run(PAYLOAD('sess-p', '继续三'), { stateDir: dir });
    assert.ok(ctxOf(fourth.stdout).includes('待排查'), '新 open 恢复持续显示');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部任务-DRIFTNUDGE-1：租约期场景漂移提示 ──

test('漂移提示：评审类声明 + 句首修复意图 → 注入一行错配提醒', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift-'));
  try {
    seedDeclared(stateDir, 's-drift', 'code-review');
    const r = run(PAYLOAD('s-drift', '定位并修复这个问题'), { stateDir });
    assert.equal(r.status, 0);
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('【workflow 场景漂移提醒】'), '命中须注入提醒行');
    assert.ok(ctx.includes('code-review'), '提醒点名当前声明 skill');
    assert.ok(ctx.includes('root-cause-debugging'), '提醒给出修复场景的正确路由');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移提示：plan-review 声明 + 「基于…在项目中实现」同样触发', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift2-'));
  try {
    seedDeclared(stateDir, 's-drift2', 'plan-review');
    const r = run(PAYLOAD('s-drift2', '基于设计文档在项目中实现该功能'), { stateDir });
    assert.ok(ctxOf(r.stdout).includes('场景漂移提醒'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移豁免：评审主导句（全面审查…修复在条件从句）不提醒', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift3-'));
  try {
    seedDeclared(stateDir, 's-drift3', 'code-review');
    const r = run(PAYLOAD('s-drift3', '全面审查services目录下的代码，如果审查过程发现问题，则逐项修复发现问题。'), { stateDir });
    assert.equal(r.status, 0);
    assert.ok(!ctxOf(r.stdout).includes('场景漂移提醒'), '评审主导、修复为条件从句=正常评审任务');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移豁免：消息已点名正确流程链不提醒', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift4-'));
  try {
    seedDeclared(stateDir, 's-drift4', 'code-review');
    const r = run(PAYLOAD('s-drift4', '修复批走 plan-writing → plan-review → plan-execution'), { stateDir });
    assert.ok(!ctxOf(r.stdout).includes('场景漂移提醒'), '用户已指向计划链，提醒即误报');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移不触发：非评审/勘察类声明（plan-execution）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift5-'));
  try {
    seedDeclared(stateDir, 's-drift5', 'plan-execution');
    const r = run(PAYLOAD('s-drift5', '定位并修复这个问题'), { stateDir });
    assert.ok(!ctxOf(r.stdout).includes('场景漂移提醒'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移不触发：会话首条消息（上一轮无声明）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift6-'));
  try {
    const r = run(PAYLOAD('s-drift6', '定位并修复这个问题'), { stateDir });
    assert.equal(r.status, 0);
    assert.ok(!ctxOf(r.stdout).includes('场景漂移提醒'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移节流：同 skill 连续意图只提醒一次（第二轮走 declaredSkill 兜底仍不重复）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift7-'));
  try {
    seedDeclared(stateDir, 's-drift7', 'code-review');
    const first = run(PAYLOAD('s-drift7', '定位并修复这个问题'), { stateDir });
    assert.ok(ctxOf(first.stdout).includes('场景漂移提醒'), '首次提醒');
    // 首轮 leaseLine 已强吊销 seed active 且用户未重新声明：第二轮走 declaredSkill 兜底；
    // 第二轮消息须命中词表——否则断言锁不住 driftShown 的抑制语义
    const second = run(PAYLOAD('s-drift7', '修复这个问题'), { stateDir });
    assert.ok(!ctxOf(second.stdout).includes('场景漂移提醒'), '同 skill 一次性：不重复');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移重置：同名 skill 新一轮声明（epoch 变化）同样重新打开窗口', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift9-'));
  try {
    seedDeclared(stateDir, 's-drift9', 'code-review');
    const first = run(PAYLOAD('s-drift9', '定位并修复这个问题'), { stateDir });
    assert.ok(ctxOf(first.stdout).includes('场景漂移提醒'), '首次提醒');
    // 一条未声明消息：强吊销后走兜底，driftShown 保持 true，不提醒
    const idle = run(PAYLOAD('s-drift9', '修复这个问题'), { stateDir });
    assert.ok(!ctxOf(idle.stdout).includes('场景漂移提醒'), '未声明连续轮次不重复');
    // 用户对最新令牌重新声明同名 code-review（新一轮评审，epoch 增大）
    seedDeclared(stateDir, 's-drift9', 'code-review');
    const again = run(PAYLOAD('s-drift9', '定位并修复这个问题'), { stateDir });
    assert.ok(ctxOf(again.stdout).includes('场景漂移提醒'), '同名新激活即重置，不被旧 driftShown 永久吞掉');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('漂移重置：声明切换 skill 后，再回到评审类声明可重新触发', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-drift8-'));
  try {
    seedDeclared(stateDir, 's-drift8', 'code-review');
    const first = run(PAYLOAD('s-drift8', '定位并修复这个问题'), { stateDir });
    assert.ok(ctxOf(first.stdout).includes('场景漂移提醒'));
    // 用户改声明为 root-cause-debugging，发一条普通消息：状态 declaredSkill 切换、driftShown 重置
    seedDeclared(stateDir, 's-drift8', 'root-cause-debugging');
    run(PAYLOAD('s-drift8', '继续'), { stateDir });
    // 用户再次声明 code-review（新一轮评审），意图消息应能再次提醒
    seedDeclared(stateDir, 's-drift8', 'code-review');
    const again = run(PAYLOAD('s-drift8', '定位并修复这个问题'), { stateDir });
    assert.ok(ctxOf(again.stdout).includes('场景漂移提醒'), 'skill 切换后一次性窗口重新打开');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 纠正捕获口径（内部未决-44①，内部任务-OPEN4344-1）────────────────────────────────────────────
// 真 RED 九条（旧实现会记 ⇒ 修前必红）：①②③简报长文/对等消息/子代理通知、④引文与行内代码、
// ⑤⑥两条**真实触发字面量**（本批两个评审实例的派发提示词）、⑦ASCII 双引号、⑧围栏代码块、
// ⑨ASCII 单引号；两条防回归（旧实现本就绿：`/不对/` 要求相邻「不+对」）；五条真纠正。
// 证伪面口径（以 `内部证据` 的逐规则删除变异
// 实测为准）：**有独立证伪面**＝行内代码/「」/`“”`/ASCII 双引号/ASCII 单引号/信封/near 门；
// **无**＝围栏（行内规则会把围栏标记成对吃光）与 `‘’`（防御性剥离，已如实标注）。
// 注：`“”` 的证伪面来自下面"取舍边界·整条引号包裹"那条用例——收尾期新增用例后它由"防御性剥离"
// 变回"有证伪面"，声明面随之改正（这类"证据面变化使声明过期"由上述验证器机械复核）。
test('纠正捕获（内部未决-44①）：信封/引文/长清单不记，短促直指记', async () => {
  const { matchCorrections } = await import('../../hooks/user-prompt.mjs');
  // —— RED 用例 ——
  assert.deepEqual(
    matchCorrections('⑦允许推翻重来：当评审发现根本性更好的路线时直接摆出来交用户裁决，不为已经花掉的规划成本辩护；计划含实现类步骤时收尾评审不得省略。'),
    [],
    '派发简报清单里的"重来"不算纠正（RED：旧实现命中 /重来/）',
  );
  assert.deepEqual(
    matchCorrections('Agent 8514453b-e23c-4a3f-b050-e4fa58bf2d97 sent a message: 你的方案顺序你搞错了，请重来。'),
    [],
    '对等消息不算用户纠正（RED；旧实现 [1,2,4]）',
  );
  assert.deepEqual(
    matchCorrections('Background subagent xxx finished。它的收尾消息里引用了"重来"这个词'),
    [],
    '子代理完成通知不算（RED）',
  );
  assert.deepEqual(
    matchCorrections('评审手册里写「重来」要谨慎，示例代码 `if (a || b) 不对` 只是演示，不要照抄语义。'),
    [],
    '引文与行内代码段豁免（RED）',
  );
  assert.deepEqual(
    matchCorrections("反引号形态的样本：`matchCorrections('你搞错了，重来一遍')` 只是提示词里引用的用例"),
    [],
    '反引号代码段豁免（RED；delta 实例真实触发形态，digest p1）',
  );
  assert.deepEqual(
    matchCorrections('首轮实例的样本是「这一步为什么不对？请解释」，这里只是引用。'),
    [],
    '「」引文豁免（RED；首轮实例真实触发形态，digest p0）',
  );
  assert.deepEqual(
    matchCorrections('简报里写含"重来"这个词的段落，以及"不对"两个字，都只是引用而非用户判断'),
    [],
    'ASCII 双引号引文豁免（RED）',
  );
  assert.deepEqual(
    matchCorrections('评审报告里贴了这段代码：\n```js\nif (x) { /* 重来 不对 */ }\n```\n以上只是引用'),
    [],
    '围栏代码块豁免（防御性剥离；无独立证伪面）',
  );
  assert.deepEqual(
    matchCorrections("报告里写 '重来' 与 '不对' 两个字只是引用"),
    [],
    'ASCII 单引号引文豁免（RED；删掉该剥离规则本用例即红）',
  );
  // —— 防回归（旧实现本就绿）——
  assert.deepEqual(
    matchCorrections('事实核查：指出对不上的地方，必须给出 file:line 证据；不得只写结论。'),
    [],
    '长报告正文里的措辞不算纠正（防回归：`/不对/` 本就不匹配"对不上"）',
  );
  assert.deepEqual(matchCorrections('【workflow 任务租约】本轮令牌 abc｜首个写操作前完成声明'), [], '租约横幅不算用户纠正（防回归）');
  assert.deepEqual(matchCorrections('【workflow 自察】项目有 2 条待排查（本任务 0 / 本会话 1 / 其他会话 1）：请运行 list'), [], '自察指针信封不算用户纠正（防回归）');
  // —— 真纠正 ——
  assert.deepEqual(matchCorrections('不对'), [0], '短消息命中即记');
  assert.deepEqual(matchCorrections('你搞错了'), [1, 4], '「错了」与「你搞错」两条都命中（索引升序）');
  assert.deepEqual(
    matchCorrections('你搞错了，重来一遍'),
    [1, 2, 4],
    '三模式重叠命中是有意的——调用点只取 hits[0]，本函数契约不去重',
  );
  assert.deepEqual(matchCorrections('这一步为什么不对？请解释'), [0], '命中处邻域有第二人称/祈使标记即记');
  // near 支的证伪面：归一后 84 字符 > 60（走 near 支而非 short 支），删掉 `|| near` 本条即红
  assert.deepEqual(
    matchCorrections('这个抽取缓存的并发发布方案我认为明显不对，请你按原子发布重做一遍，并把 staging 残留与 retired 残留也一并清理掉，再补一条并发用例与一条半成品目标用例。'),
    [0],
    '长消息（84 字符）但命中处邻域有「请你」⇒ 记（near 支）',
  );
  // —— 精度取舍的边界（阶段复审 C1：把"有意漏报面"写死在用例里，而不是留在散文里）——
  // 三条口径的净效果是"用漏报换精确"：引号/行内代码包裹的**用户自己的**纠正、以及 >60 字符且命中处
  // 无第二人称·祈使标记的真纠正会被丢弃。这是有意的取舍（三条实证假阳性优先），残余已登记。
  assert.deepEqual(matchCorrections('你说"这里明明不对"'), [], '引号内真纠正被剥离（有意取舍）');
  assert.deepEqual(matchCorrections('“你搞错了，重来”'), [], '整条消息被引号包裹 ⇒ 归一为空（有意取舍）');
  assert.deepEqual(
    matchCorrections('这一版实现和设计文档差得远，签名校验那一段明显不对，第三十七行的边界条件也没有覆盖到，整段应该按规格重写一遍，另外把回归用例补齐。'),
    [],
    '长消息（65 字符）且命中处 ±12 内无第二人称/祈使 ⇒ 语境门拦下（有意取舍）',
  );
});

// ── 内部任务-8 阶段 5（2026-10-07）：RC-4 签发自校验 + 签发探针 ──
// 规格锚：内部规则-19 第⑥条 + 内部决策-018 修正案 5。

test('内部任务-8 任务 5.1/5.4：租约行正常注入 + 签发探针落盘（ts/sessionId/keysIssued/verifyOk）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-dev8-probe-'));
  try {
    const r = run(JSON.stringify({ session_id: 'sess-DEV8', cwd: REPO_CWD, prompt: '执行 内部任务-8' }), { stateDir });
    assert.equal(r.status, 0, 'hook 恒 exit 0');
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('【workflow 任务租约】'), '租约行在场（正常注入回归锚）');
    assert.ok(/本轮令牌 [0-9a-f]{32}/.test(ctx), '令牌行形态：hex 32');
    const probeFile = join(stateDir, 'lease', 'wf-prompt-probe.jsonl');
    assert.ok(existsSync(probeFile), '探针文件落盘（stateDir()/wf-prompt-probe.jsonl）');
    const last = JSON.parse(readFileSync(probeFile, 'utf8').trim().split('\n').pop());
    assert.equal(last.sessionId, 'sess-DEV8', '探针含 sessionId');
    assert.equal(last.verifyOk, true, '回读验证通过（verifyOk=true）');
    assert.ok(Number.isFinite(last.ts), '探针含 ts');
    assert.ok(last.keysIssued >= 1, '探针含 keysIssued（≥1）');
    // 探针为审计日志语义：追加写（二次运行 → 两行）
    const r2 = run(JSON.stringify({ session_id: 'sess-DEV8', cwd: REPO_CWD, prompt: '继续' }), { stateDir });
    assert.equal(r2.status, 0);
    const lines = readFileSync(probeFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, '追加写语义（非覆写）');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-8 任务 5.2：签发回读失败 → 不注入令牌行、改注入降级指引（可执行出路）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-dev8-degrade-'));
  try {
    // 注入缝（先例：GUARD_HOOK_INJECT_CRASH）：签发后即删挑战文件，模拟「写后立读不可见」的
    // 罕见态（AV 锁/NFS 延迟/磁盘满——RC-4 的必败注入成因族）
    const r = run(JSON.stringify({ session_id: 'sess-DEV8D', cwd: REPO_CWD, prompt: '执行 内部任务-8' }), {
      stateDir,
      extraEnv: { WF_UPROMPT_INJECT_DROP_CHALLENGE: '1' },
    });
    assert.equal(r.status, 0, '降级不阻断（fail-open）');
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('本轮签发未落盘'), '降级指引在场（不再注入注定失败的令牌）');
    assert.ok(ctx.includes('WF_ROUTING_STATE_DIR'), '指引含可排查项（状态目录写权限）');
    assert.ok(!/本轮令牌 [0-9a-f]{32}/.test(ctx), '不注入令牌行（杜绝照指引必败）');
    // 探针如实记录 verifyOk=false（探针是 RC-4 取证件）
    const probeFile = join(stateDir, 'lease', 'wf-prompt-probe.jsonl');
    const last = JSON.parse(readFileSync(probeFile, 'utf8').trim().split('\n').pop());
    assert.equal(last.verifyOk, false, '探针 verifyOk=false（失败可见）');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-20 A1/F4：委派会话注入面收窄（含 A2 裁决 a 的哨兵告警保留）──

test('内部任务-20 A1/F4：委派会话（delegation_depth>0）只注入租约行 + 探针留痕', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-deleg-'));
  try {
    seedPending(dir, 's-deleg', 'ri-deleg-1');
    // nudgeEvery='1' 让「周期提示缺席」成为**有鉴别力**的断言（缺省 20 轮时顶层会话同样不注入
    // ⇒ 断言恒真、删实现也不转红——评审 C3）。
    const ctx = ctxOf(run(PAYLOAD_D('s-deleg', '任务', 1), { stateDir: dir, nudgeEvery: '1' }).stdout);
    assert.ok(ctx.includes('任务租约'), '委派会话仍注入租约行（内部未决-81：子代理仍需声明）');
    // 内部决策-061 D4（内部任务-227）：无父会话标识/继承不可解析时不出具体号，给停报重派指引。
    assert.ok(ctx.includes('本轮令牌') && ctx.includes('停止写操作') && ctx.includes('回报父会话'), '委派继承不可解析须给停报重派指引（禁止同轮重试）');
    assert.ok(!ctx.includes('待排查'), '委派会话不注入自察指针（F4 收窄面）');
    assert.ok(!ctx.includes('周期提示'), '委派会话不注入周期提示（对照用例证明顶层会注入）');
    // CEO「可观测性」：收窄是否在生效有**非注入**的运行时可见面
    const probe = JSON.parse(readFileSync(join(dir, 'lease', 'wf-prompt-probe.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(probe.delegated, true, '签发探针如实记录 delegated=true（收窄可观测）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部任务-20 A1/A2(a)：委派会话保留哨兵告警（子代理自身 hook 失败的唯一可见面）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-deleg-alert-'));
  const log = join(dir, 'zcode-suite.jsonl');
  try {
    writeFileSync(log, JSON.stringify({ event: 'hook.run.failed', sessionId: 's-deleg-alert', context: { source: 'plugin.spec-gate@mk.SessionStart.1.0' } }) + '\n');
    const ctx = ctxOf(run(PAYLOAD_D('s-deleg-alert', '任务', 1), { stateDir: dir, logPath: log }).stdout);
    assert.ok(ctx.includes('护栏异常'), '哨兵告警不随委派收窄（A2 裁决 a）');
    assert.ok(ctx.includes('任务租约'), '租约行与告警同帧共存');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部任务-20 A1/F4：委派会话不注入漂移提醒（已声明评审类 + 句首修复意图）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-deleg-drift-'));
  try {
    seedDeclared(dir, 's-deleg-drift', 'code-review');
    const ctx = ctxOf(run(PAYLOAD_D('s-deleg-drift', '修复这个 bug', 1), { stateDir: dir }).stdout);
    assert.ok(!ctx.includes('场景漂移提醒'), '委派会话不注入漂移提醒（收窄面）');
    assert.ok(ctx.includes('任务租约'), '租约行仍在（收窄不等于静默）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部任务-20 A1/F4：顶层会话注入面零变化（depth 缺省 / 0 / 非法形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-top-'));
  try {
    seedPending(dir, 's-top', 'ri-top-1');
    const opts = { stateDir: dir, nudgeEvery: '1' };
    const plain = ctxOf(run(PAYLOAD('s-top', '任务'), opts).stdout);
    assert.ok(plain.includes('待排查'), '缺省（无键）照常注入指针');
    assert.ok(plain.includes('周期提示'), '顶层会话照常注入周期提示——对照组，证明委派收窄真的生效');
    assert.ok(ctxOf(run(PAYLOAD_D('s-top2', '任务', 0), opts).stdout).includes('待排查'), 'depth=0 等同顶层，不得误判委派');
    assert.ok(ctxOf(run(PAYLOAD_D('s-top3', '任务', -1), opts).stdout).includes('待排查'), '负数（非法值）等同顶层');
    const bad = JSON.stringify({ session_id: 's-top4', prompt: '任务', cwd: REPO_CWD, delegation_depth: '1' });
    assert.ok(ctxOf(run(bad, opts).stdout).includes('待排查'), '字符串形态（非法值）等同顶层，不得强转');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部任务-20 A2/F6：签发侧并入跨域请求（两步通道第二跳）──

test('内部任务-20 A2/F6：签发侧并入本会话跨域请求（目标域租约行 + 授予审计行）', async () => {
  const { hostOf } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const base = mkdtempSync(join(tmpdir(), 'uprompt-domain-'));
  const state = join(base, 'state');
  const a = join(base, 'A');
  const b = join(base, 'B');
  for (const d of [state, join(a, '.git'), join(b, '.git')]) mkdirSync(d, { recursive: true });
  try {
    const keyB = projectKey(b);
    // 预置一条本会话的待签请求（登记面＝注入缝状态根内的 wf-domain-requests.jsonl；
    // 注意 run 把注入缝设为 <stateDir>/lease——登记面按 stateRootFor 落在该缝内）
    mkdirSync(join(state, 'lease'), { recursive: true });
    writeFileSync(
      join(state, 'lease', 'wf-domain-requests.jsonl'),
      `${JSON.stringify({ id: 'req-1', targetKey: keyB, targetRoot: b, sessionId: 'sess-dom', host: hostOf({}), ts: Date.now() })}\n`,
    );
    const payload = JSON.stringify({ session_id: 'sess-dom', cwd: a, prompt: '任务' });
    const ctx = ctxOf(run(payload, { stateDir: state }).stdout);
    assert.ok(ctx.includes(keyB.replaceAll('\\', '/')) || ctx.includes(keyB), '签发侧须给出目标域租约行（多仓多行形态）');
    const lines = readFileSync(join(state, 'lease', 'wf-domain-requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(
      lines.some((r) => r.id === 'req-1' && typeof r.grantedAt === 'number'),
      '授予须落审计行（markRequestGranted）',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('内部任务-20 A2/F6：超 TTL 的跨域请求不并入签发键集', async () => {
  const { hostOf } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const base = mkdtempSync(join(tmpdir(), 'uprompt-domain-ttl-'));
  const state = join(base, 'state');
  const a = join(base, 'A');
  const b = join(base, 'B');
  for (const d of [state, join(a, '.git'), join(b, '.git')]) mkdirSync(d, { recursive: true });
  try {
    const keyB = projectKey(b);
    mkdirSync(join(state, 'lease'), { recursive: true });
    writeFileSync(
      join(state, 'lease', 'wf-domain-requests.jsonl'),
      `${JSON.stringify({ id: 'req-old', targetKey: keyB, targetRoot: b, sessionId: 'sess-old', host: hostOf({}), ts: Date.now() - 31 * 60 * 1000 })}\n`,
    );
    const ctx = ctxOf(run(JSON.stringify({ session_id: 'sess-old', cwd: a, prompt: '任务' }), { stateDir: state }).stdout);
    assert.ok(!ctx.includes(keyB), '超 TTL 请求不得并入（TTL 过滤在 readDomainRequests 内）');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('内部任务-20 A2/F6：已授予的跨域请求不再并入（授予即消费——阻塞缺陷 1 的回归钉）', async () => {
  const { hostOf } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const base = mkdtempSync(join(tmpdir(), 'uprompt-domain-granted-'));
  const state = join(base, 'state');
  const a = join(base, 'A');
  const b = join(base, 'B');
  for (const d of [state, join(state, 'lease'), join(a, '.git'), join(b, '.git')]) mkdirSync(d, { recursive: true });
  try {
    const keyB = projectKey(b);
    const rec = { id: 'req-g', targetKey: keyB, targetRoot: b, sessionId: 'sess-g', host: hostOf({}), ts: Date.now() };
    // 登记面 = 原请求行 + 授予行（授予行必须带 ts，否则读侧整行丢弃 ⇒ granted 恒 false）
    writeFileSync(
      join(state, 'lease', 'wf-domain-requests.jsonl'),
      `${JSON.stringify(rec)}\n${JSON.stringify({ id: 'req-g', ts: rec.ts, grantedAt: rec.ts })}\n`,
    );
    const ctx = ctxOf(run(JSON.stringify({ session_id: 'sess-g', cwd: a, prompt: '任务' }), { stateDir: state }).stdout);
    assert.ok(!ctx.includes(keyB.replaceAll('\\', '/')), '已授予（已消费）的请求不得再次并入签发键集');
    assert.ok(ctx.includes('任务租约'), '租约行仍在（并入缺席不等于整行缺席）');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('内部任务-27 坑4：单域仓租约行内联建议号，零域仓默认域兜底内联（内部任务-75），行长 ≤230', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uprompt-d27-'));
  let bare = '';
  try {
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    const r = run(PAYLOAD('s-d27a', '任务', repo), { anchor: repo });
    assert.equal(r.status, 0, r.stderr);
    const line = ctxOf(r.stdout).split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line, '租约行在场');
    assert.ok(line.includes('--task-id 内部任务-1'), '单域仓内联建议号（可照抄声明）');
    assert.ok(!line.includes('<任务号>'), '占位符已替换');
    assert.ok(line.length <= 230, `行长口径（实测 ${line.length}）`);
    // 零域仓：默认域兜底内联 内部任务-1（内部任务-75/IMP-4——旧「占位符保持」形态废止：零配置新仓
    // 取号与内联建议开箱可用，免手工建域文件/手动取号前置；接线断言=删兜底即红）
    bare = mkdtempSync(join(tmpdir(), 'uprompt-d27b-'));
    mkdirSync(join(bare, '.git'));
    const r2 = run(PAYLOAD('s-d27b', '任务', bare), { anchor: bare });
    assert.equal(r2.status, 0, r2.stderr);
    const line2 = ctxOf(r2.stdout).split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line2.includes('--task-id 内部任务-1'), '零域仓默认域兜底内联建议号（内部任务-75）');
    assert.ok(!line2.includes('<任务号>'), '占位符已被默认域建议替换');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    if (bare) rmSync(bare, { recursive: true, force: true });
  }
});

test('内部未决-103：租约行建议号排除观察会话自身占用（内部任务-52）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uprompt-o103-'));
  const state = mkdtempSync(join(tmpdir(), 'uprompt-state-'));
  try {
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    // 种子：本会话（与 PAYLOAD 同标识）占 内部任务-7——写入 run() 将使用的同一隔离状态根
    const prevEnv = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = join(state, 'lease');
    try {
      const key = projectKey(repo);
      const ch = issueChallenge(key, { sessionId: 's-o103' });
      const r = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-7', skill: 'tdd' });
      assert.ok(r.ok, `种子声明须成功：${r.reason}`);
    } finally {
      if (prevEnv === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevEnv;
    }
    const r = run(PAYLOAD('s-o103', '任务', repo), { stateDir: state, anchor: repo });
    assert.equal(r.status, 0, r.stderr);
    const line = ctxOf(r.stdout).split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line, '租约行在场');
    assert.ok(line.includes('--task-id 内部任务-1'), '排除自身后建议回到空态取号（照抄即延续同号）');
    assert.ok(!line.includes('--task-id 内部任务-8'), '未接线排除时会被自身占用顶成 内部任务-8——删接线即红');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('内部决策-045：维护者段仓租约行内联——三段 ≤11 字符内联、超长回退占位符（soleTaskIdSuggestion 单源）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uprompt-adr45-'));
  const long = mkdtempSync(join(tmpdir(), 'uprompt-adr45b-'));
  try {
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    writeFileSync(join(repo, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    writeFileSync(join(repo, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'WP' }));
    const r = run(PAYLOAD('s-adr45a', '任务', repo), { anchor: repo });
    assert.equal(r.status, 0, r.stderr);
    const line = ctxOf(r.stdout).split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line.includes('--task-id 内部任务-WP-1'), '三段建议 7 字符 ≤11 → 内联（本地指针上下文）');
    assert.ok(!line.includes('<任务号>'), '占位符已替换');
    // 超长：4+4 段形态 × 播种 {1..11} → 建议 DEVX-WPXY-12（12 字符 >11）→ 回退占位符（内部任务-117 稠密形态）
    mkdirSync(join(long, '.git'));
    mkdirSync(join(long, '.workflow'), { recursive: true });
    writeFileSync(join(long, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEVX'] }));
    writeFileSync(join(long, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WPXY'] }));
    writeFileSync(join(long, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'WPXY' }));
    for (let i = 1; i <= 11; i += 1) mkdirSync(join(long, '.sdd', 'receipts', `DEVX-WPXY-${i}`), { recursive: true });
    const r2 = run(PAYLOAD('s-adr45b', '任务', long), { anchor: long });
    assert.equal(r2.status, 0, r2.stderr);
    const line2 = ctxOf(r2.stdout).split('\n').find((l) => l.includes('任务租约'));
    assert.ok(line2.includes('<任务号>'), '超 11 字符三段建议回退占位符（内部规则-7 行长口径不变）');
    assert.ok(!line2.includes('DEVX-WPXY-12'), '超长建议不内联');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(long, { recursive: true, force: true });
  }
});

// ============ 内部任务-62 / 内部决策-050 D3：domains.json 零域态可见性引导 ============

/** 造零域临时仓（无 domains.json、无任何可推断域的目录结构）。 */
function bareRepo(name) {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

test('内部任务-62 G1 零域仓首条消息注入两途引导行，24h 窗内第二条不重复', () => {
  const repo = bareRepo('uprompt-zero-');
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-zero-st-'));
  try {
    const r1 = run(PAYLOAD('sess-g1', '开工', repo), { stateDir });
    const ctx1 = ctxOf(r1.stdout);
    assert.ok(ctx1.includes('domains.json'), '首条须含 domains.json 引导');
    assert.ok(ctx1.includes('授权'), '两途文案须含授权代建路径');
    assert.ok(ctx1.includes('自建'), '两途文案须含自建路径');
    const r2 = run(PAYLOAD('sess-g1', '继续', repo), { stateDir });
    assert.ok(!ctxOf(r2.stdout).includes('domains.json'), '同窗内第二条不重复（setup-hints 去重）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-62 G2 建 domains.json 后触发条件恒假——永不再注入', () => {
  const repo = bareRepo('uprompt-dom-');
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-dom-st-'));
  try {
    const r1 = run(PAYLOAD('sess-g2', '开工', repo), { stateDir });
    assert.ok(ctxOf(r1.stdout).includes('domains.json'));
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    const r2 = run(PAYLOAD('sess-g2', '继续', repo), { stateDir });
    assert.ok(!ctxOf(r2.stdout).includes('domains.json'), '已声明域后不再触发（条件恒假优于状态标记）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-62 G3 已声明域的仓（有 domains.json）从首条起即无引导', () => {
  const repo = bareRepo('uprompt-dom2-');
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-dom2-st-'));
  try {
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    const r = run(PAYLOAD('sess-g3', '开工', repo), { stateDir });
    const ctx = ctxOf(r.stdout);
    assert.ok(!ctx.includes('零域态') && !ctx.includes('授权代建'), '已声明域零噪音（引导特征词不得出现）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-227 P1 租约行 degraded：不出具体号＋给「取号暂不可得」说明（内部验收-27 租约行消费面）', () => {
  const repo = bareRepo('uprompt-dev227-');
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-dev227-st-'));
  try {
    const r = run(PAYLOAD('sess-dev227', '开工', repo), {
      stateDir,
      extraEnv: { WF_GIT_BIN: join(tmpdir(), 'wf-git-missing-dev227') }, // spawn 失败＝读失败（非源缺席）
    });
    const ctx = ctxOf(r.stdout);
    assert.ok(ctx.includes('任务租约'), '委派之外常态仍注入租约行');
    assert.doesNotMatch(ctx, /--task-id DEV-\d/, 'degraded 时租约行不得内联任何具体号（内部决策-061 D5）');
    assert.match(ctx, /取号暂不可得/, 'degraded 时给出「取号暂不可得」说明行');
    assert.match(ctx, /占用源降级/, '说明行须列出降级来源');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-227 委派继承注入：父链 issued 行→租约行内联继承号（depth=1/2 两跳；超 3 层停报重派）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-inherit-'));
  try {
    const leaseDir = join(stateDir, 'lease');
    mkdirSync(leaseDir, { recursive: true });
    const keyDigest = keyDigestOf(REPO_CWD);
    const writeLedger = (rows) => writeFileSync(
      join(leaseDir, `wf-issued-${keyDigest}.jsonl`),
      `${rows.map((r) => JSON.stringify({ schemaVersion: 1, ts: Date.now(), ...r })).join('\n')}\n`,
    );
    const delegatedPayload = (child, depth, parent) => JSON.stringify({ session_id: child, prompt: '任务', cwd: REPO_CWD, delegation_depth: depth, parent_session_id: parent });
    // depth=1：直接父会话行带 taskId
    writeLedger([{ sessionId: 'parent-1', taskId: '内部任务-9' }]);
    const ctx1 = ctxOf(run(delegatedPayload('child-1', 1, 'parent-1'), { stateDir }).stdout);
    assert.ok(ctx1.includes('任务租约'), '委派会话仍注入租约行');
    assert.match(ctx1, /--task-id 内部任务-9/, '继承成功须内联父链交付号');
    assert.match(ctx1, /继承/, '内联行须标注继承（禁止自取新号）');
    // depth=2：两跳链 pA→pB(taskId)
    writeLedger([{ sessionId: 'pA', parentSessionId: 'pB' }, { sessionId: 'pB', taskId: '内部任务-9' }]);
    const ctx2 = ctxOf(run(delegatedPayload('child-2', 2, 'pA'), { stateDir }).stdout);
    assert.match(ctx2, /--task-id 内部任务-9/, 'depth=2 两跳须可解析继承号');
    // 超 3 层：链 p1→p2→p3→p4 且 taskId 在链外 → 不出具体号＋停报重派
    writeLedger([{ sessionId: 'p1', parentSessionId: 'p2' }, { sessionId: 'p2', parentSessionId: 'p3' }, { sessionId: 'p3', parentSessionId: 'p4' }]);
    const ctx3 = ctxOf(run(delegatedPayload('child-3', 1, 'p1'), { stateDir }).stdout);
    assert.doesNotMatch(ctx3, /--task-id DEV-\d/, '父链超 3 层不得内联任何具体号');
    assert.match(ctx3, /停止写操作/, '失败出路须为停报重派（禁止同轮重试）');
    // 正向 3 跳：p1→p2→p3(taskId) 应可解析（≤3 层上溯成功路径；最新行语义由链上行推进）
    writeLedger([{ sessionId: 'p3', taskId: '内部任务-9' }, { sessionId: 'p2', parentSessionId: 'p3' }, { sessionId: 'p1', parentSessionId: 'p2' }]);
    const ctx4 = ctxOf(run(delegatedPayload('child-4', 1, 'p1'), { stateDir }).stdout);
    assert.match(ctx4, /--task-id 内部任务-9/, '第 3 层才出现 taskId 的正向链须可解析');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：摘要库指针、归属三分、纠正分类、哨兵合并、promotions。
// 锚：内部验收-24「内部模块-15 v2 待排查派生与归属分组」。
// ─────────────────────────────────────────────────────────────────────────────

/** 覆盖写隔离根账本（WF_INCIDENT_ROOT=stateDir 时落在 <stateDir>/.workflow/）。 */
function seedLedger(dir, rows) {
  const file = join(dir, '.workflow', 'incidents.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** 一条 v2 记录（缺省 open/近期）。 */
const v2rec = (over = {}) => ({
  schemaVersion: 1,
  id: 'ri-v2-x',
  ts: Date.now(),
  session: 'sess-other',
  kind: 'tool-failure',
  digest: 'dv20000000000001',
  status: 'open',
  ...over,
});

test('内部模块-15 v2 待排查派生与归属分组（锚：内部验收-24）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-split-'));
  try {
    seedLedger(dir, [
      // 本任务（租约 taskId=内部任务-1，见下方 seedDeclared）
      v2rec({ id: 'v2-task', session: 'sess-v2p', taskId: '内部任务-1', cause: 'real-failure', digest: 'dv2task000000001' }),
      // 本会话（无 taskId）
      v2rec({ id: 'v2-sess', session: 'sess-v2p', cause: 'user-correction', kind: 'user-correction', digest: 'dv2sess000000001' }),
      // 其他会话（lease-loop 升级信号）
      v2rec({ id: 'v2-loop', session: 'sess-other', kind: 'lease-loop', cause: 'mechanism-escalation', digest: 'dv2loop000000001' }),
      // 证据面：三 cause + 旧行一类
      v2rec({ id: 'v2-replay', session: 'sess-other', cause: 'replayable-rejection', digest: 'dv2replay00000001' }),
      v2rec({ id: 'v2-probe', session: 'sess-other', cause: 'probe-noise', digest: 'dv2probe00000001' }),
      v2rec({ id: 'v2-legacy-lease', session: 'sess-other', kind: 'lease-deny', digest: 'dv2ll000000000001' }), // 无 cause 旧行
    ]);
    seedDeclared(dir, 'sess-v2p', 'plan-execution');
    const ctx = ctxOf(run(PAYLOAD('sess-v2p', '继续推进'), { stateDir: dir }).stdout);
    assert.ok(
      ctx.includes('项目有 3 条待排查（本任务 1 / 本会话 1 / 其他会话 1；证据面 3 条已分层排除）'),
      `指针须含总数/归属三分/证据面拆分（实际：${ctx}）`,
    );
    assert.ok(ctx.includes('incident-cli.mjs'), '指针保留可执行排查命令');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 证据面按 cause 排除：纯证据账本零指针，混入真失败即恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-evidence-'));
  try {
    seedLedger(dir, [
      v2rec({ id: 'ev-1', cause: 'probe-noise', digest: 'dev10000000000001' }),
      v2rec({ id: 'ev-2', cause: 'replayable-rejection', digest: 'dev20000000000001' }),
      v2rec({ id: 'ev-3', cause: 'mechanism-trace', kind: 'lease-deny', digest: 'dev30000000000001' }),
      v2rec({ id: 'ev-4', errorClass: 'exit-nonzero', digest: 'dev40000000000001' }), // 旧行回退：证据
    ]);
    assert.ok(!ctxOf(run(PAYLOAD('sess-ev', '任务'), { stateDir: dir }).stdout).includes('待排查'), '纯证据面不渲染指针（归零即消失）');
    appendFileSync(join(dir, '.workflow', 'incidents.jsonl'), JSON.stringify(v2rec({ id: 'ev-real', session: 'sess-ev', cause: 'real-failure', digest: 'dev50000000000001' })) + '\n');
    const ctx = ctxOf(run(PAYLOAD('sess-ev', '继续'), { stateDir: dir }).stdout);
    assert.ok(ctx.includes('1 条待排查（本任务 0 / 本会话 1 / 其他会话 0；证据面 4 条已分层排除）'), `混入真失败恢复指针且口径正确（实际：${ctx}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 纠正记录走规则分类（cause=user-correction/ruleId/observationSource）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-corr-'));
  try {
    const r = run(PAYLOAD('sess-c2', '不对，这里错了'), { stateDir: dir });
    assert.equal(r.status, 0);
    const rec = incidentsOf(dir).find((x) => x.kind === 'user-correction');
    assert.ok(rec, '纠正落账');
    assert.equal(rec.cause, 'user-correction');
    assert.equal(rec.severity, 'warn');
    assert.equal(rec.ruleId, 'r-user-correction');
    assert.equal(rec.rulesVersion, 1);
    assert.equal(rec.observationSource, 'hook:user-prompt', '观测来源标注（与适配层 emit 来源可区分）');
    // =off 关闭缝不变
    const off = mkdtempSync(join(tmpdir(), 'uprompt-v2-corr-off-'));
    try {
      run(PAYLOAD('sess-c2', '不对'), { stateDir: off, correctionOff: true });
      assert.equal(incidentsOf(off).length, 0, 'WF_UPROMPT_CORRECTION=off 仍整体关闭');
    } finally {
      rmSync(off, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 哨兵合并：账本 hook-failure（emit 来源）与本会话日志告警去重为一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-merge-'));
  const log = join(dir, 'zcode-merge.jsonl');
  try {
    // ①仅账本来源（适配层 emit，无宿主日志）：哨兵不得因「日志为零」而静默
    seedLedger(dir, [
      v2rec({
        id: 'hf-emit-0',
        ts: Date.now(),
        session: 'sess-m0',
        kind: 'hook-failure',
        plugin: 'spec-gate',
        event: 'SessionStart',
        cause: 'real-failure',
        observationSource: 'adapter:dsh',
        digest: 'dhf00000000000001',
      }),
    ]);
    const onlyLedger = ctxOf(run(PAYLOAD('sess-m0', '任务开始'), { stateDir: dir, logPath: join(dir, 'no-log.jsonl') }).stdout);
    assert.ok(onlyLedger.includes('护栏异常'), '账本来源同样触发哨兵告警（第二来源不静默）');
    assert.ok(onlyLedger.includes('累计 1 次'), `账本来源计数正确（实际：${onlyLedger}）`);
    // ②两来源同指一次失败（新会话）：日志一行 + 账本一条 → 告警只一次且计数不叠加
    writeFileSync(log, JSON.stringify({ event: 'hook.run.failed', sessionId: 'sess-m', context: { source: 'plugin.spec-gate@x.SessionStart.1.0' } }) + '\n');
    appendFileSync(
      join(dir, '.workflow', 'incidents.jsonl'),
      JSON.stringify(
        v2rec({
          id: 'hf-emit-1',
          ts: Date.now(),
          session: 'sess-m',
          kind: 'hook-failure',
          plugin: 'spec-gate',
          event: 'SessionStart',
          cause: 'real-failure',
          observationSource: 'adapter:dsh',
          digest: 'dhf10000000000001',
        }),
      ) + '\n',
    );
    const first = run(PAYLOAD('sess-m', '任务开始'), { stateDir: dir, logPath: log });
    const ctx1 = ctxOf(first.stdout);
    assert.ok(ctx1.includes('护栏异常'), '两来源均在场时告警');
    assert.ok(ctx1.includes('累计 1 次'), `两来源同一次失败须去重计数（实际：${ctx1}）`);
    // ③会话内一次性：已告警后账本再增一条，不再重复告警（记录仍新增）
    appendFileSync(
      join(dir, '.workflow', 'incidents.jsonl'),
      JSON.stringify(v2rec({ id: 'hf-emit-2', session: 'sess-m', kind: 'hook-failure', cause: 'real-failure', observationSource: 'adapter:dsh', digest: 'dhf20000000000002' })) + '\n',
    );
    const second = run(PAYLOAD('sess-m', '继续'), { stateDir: dir, logPath: log });
    assert.ok(!ctxOf(second.stdout).includes('护栏异常'), '会话内已告警后不重复（一次性语义保持）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 promotions 轻提醒：未过龄草案提示一行，过龄草案不提醒，委派会话不注入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-promo-'));
  try {
    mkdirSync(join(dir, '.workflow', 'promotions'), { recursive: true });
    writeFileSync(join(dir, '.workflow', 'promotions', `${Date.now()}-ri-x.md`), '# 草案\n');
    const ctx = ctxOf(run(PAYLOAD('sess-pr', '任务'), { stateDir: dir }).stdout);
    assert.ok(ctx.includes('promote 草案'), '存在待转正草案时增一行轻提醒');
    assert.ok(ctx.includes('1 份'), '含草案份数');
    // 过龄草案（40 天）不提醒
    const old = mkdtempSync(join(tmpdir(), 'uprompt-v2-promo-old-'));
    try {
      mkdirSync(join(old, '.workflow', 'promotions'), { recursive: true });
      writeFileSync(join(old, '.workflow', 'promotions', `${Date.now() - 40 * 86400000}-ri-old.md`), '# 草案\n');
      assert.ok(!ctxOf(run(PAYLOAD('sess-po', '任务'), { stateDir: old }).stdout).includes('promote 草案'), '过龄草案不提醒');
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
    // 委派会话注入面收窄：不注入 promotion 行（记账面不受影响）
    const delegatedCtx = ctxOf(run(PAYLOAD_D('sess-pd', '任务', 1), { stateDir: dir }).stdout);
    assert.ok(!delegatedCtx.includes('promote 草案'), '委派会话不注入轻提醒');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2：委派会话不注入待排查指针（注入面收窄不变），但账本口径不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2-deleg-'));
  try {
    seedLedger(dir, [v2rec({ id: 'dl-1', session: 'sess-dl', cause: 'real-failure', digest: 'dvl10000000000001' })]);
    const top = ctxOf(run(PAYLOAD('sess-dl', '任务'), { stateDir: dir }).stdout);
    assert.ok(top.includes('待排查'), '顶层会话注入指针');
    const delegatedCtx = ctxOf(run(PAYLOAD_D('sess-dl', '任务', 1), { stateDir: dir }).stdout);
    assert.ok(!delegatedCtx.includes('待排查'), '委派会话不注入指针（内部任务-20 A1/F4 收窄面）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内部模块-15 v2：--selftest 项数随批增长（≥40）且全过', () => {
  const r = run('', { args: ['--selftest'] });
  assert.equal(r.status, 0, `selftest 须退 0：${r.stdout}`);
  const m = /OK user-prompt\.mjs selftest（(\d+) 项通过）/.exec(r.stdout);
  assert.ok(m, '输出项数');
  assert.ok(Number(m[1]) >= 40, `项数须 ≥40（实际 ${m[1]}）`);
});

// ── 内部任务-308 / 内部未决-282：selftest 的 mcode 分支断言须隔离宿主环境 ──
// 现行 hostOf 按 DSH_ → KIMI_ → MCODE_ → ZCODE_ 优先级扫描 process.env；在 DSH/Kimi
// 宿主会话内跑 --selftest 时，mcode 分支断言会因环境前缀抢先而恒红。本用例锁定
// 「DSH_*/KIMI_* 在场时 selftest 仍退 0」的回归面。
test('内部未决-282：DSH_/KIMI_ 环境在场时 --selftest 仍退 0（mcode 分支断言环境隔离）', () => {
  const r = run('', {
    args: ['--selftest'],
    extraEnv: {
      DSH_HOME: 'C:/tmp/dsh-open282',
      DSH_SESSION_ID: 'session-open282',
      KIMI_CODE_HOME: 'C:/tmp/kimi-open282',
      KIMI_SESSION_ID: 'session-open282',
    },
  });
  assert.equal(r.status, 0, `selftest 须在 DSH_/KIMI_ 在场时仍退 0：${r.stdout}`);
  assert.ok(/OK user-prompt\.mjs selftest（\d+ 项通过）/.test(r.stdout), '须输出成功汇总行');
});

// ── 内部任务-308 / 内部未决-259：host×source 四格告警指引（DSH 不再误指 ZCode 日志） ──
test('内部未决-259：DSH/账本来源指引四格（不指 zcode 日志；账本指向项目账本）', () => {
  const r = run('', {
    args: ['--selftest'],
    extraEnv: { DSH_HOME: 'C:/tmp/dsh-open259', DSH_SESSION_ID: 'session-open259' },
  });
  assert.equal(r.status, 0, `selftest 须退 0：${r.stdout}`);
  for (const title of [
    '账本来源告警指向项目账本',
    'dsh 日志来源不指 zcode 日志',
    'dsh 下不扫 ZCode 日志候选',
    'mcode 日志来源告警改指宿主中立说明',
    'mcode 下日志候选为空',
    'mcode 账本来源指向项目账本',
  ]) {
    assert.match(r.stdout, new RegExp(`PASS ${title}`), `四格断言须通过：${title}`);
  }
});

// ── 内部模块-15 v2 写者接线（评审修复 N5）：hook-failure 记录带分类字段 ──

test('评审修复 N5：哨兵 hook-failure 记录带 cause=real-failure/ruleId/rulesVersion/observationSource', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-v2nh5-'));
  const log = join(dir, 'zcode-v2n5.jsonl');
  try {
    writeFileSync(log, JSON.stringify({ event: 'hook.run.failed', sessionId: 'sess-n5', context: { source: 'plugin.spec-gate@x.SessionStart.1.0' } }) + '\n');
    const r = run(PAYLOAD('sess-n5', '任务开始'), { stateDir: dir, logPath: log });
    assert.equal(r.status, 0);
    const rec = incidentsOf(dir).find((x) => x.kind === 'hook-failure');
    assert.ok(rec, 'hook-failure 落账');
    assert.equal(rec.cause, 'real-failure', '规则表 r-hook-failure');
    assert.equal(rec.ruleId, 'r-hook-failure');
    assert.equal(rec.rulesVersion, 1);
    assert.equal(rec.observationSource, 'hook:user-prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部任务-244 P02/P04：占用缓存复用与宿主日志截断读 ──

test('内部任务-244 P02：同 repo 第二轮 UPS 复用占用缓存（git spawn 计数不变）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uprompt-cache-'));
  const log = join(dir, 'fake-git.log');
  const script = join(dir, 'fake-git.mjs');
  writeFileSync(log, '');
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'spawn\\n');\nprocess.exit(0);\n`,
  );
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-cache-state-'));
  try {
    const env = { WF_GIT_BIN: script };
    const payload = JSON.stringify({ session_id: 'sess-cache', cwd: REPO_CWD, prompt: '继续任务' });
    assert.equal(run(payload, { stateDir, extraEnv: env }).status, 0);
    const first = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(first > 0, '首轮缓存 miss → 有 git 探测');
    assert.equal(run(payload, { stateDir, extraEnv: env }).status, 0);
    const second = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(second, first, '第二轮缓存命中 → 零新增 git spawn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-244 P04：宿主日志 >8MB 只扫尾部、truncated 可见（hook-errors 每会话一行）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-biglog-'));
  const log = join(stateDir, 'big-guard.jsonl');
  try {
    const filler = `{"event":"noise","sessionId":"x","pad":"${'a'.repeat(180)}"}\n`; // ≈220B/行
    const tail = JSON.stringify({
      event: 'hook.run.failed', sessionId: 'sess-big',
      context: { source: 'plugin.spec-gate@market.SessionStart.1.0' }, timestamp: new Date().toISOString(),
    });
    writeFileSync(log, filler.repeat(Math.ceil((20 * 1024 * 1024) / 220)) + `${tail}\n`);
    const payload = JSON.stringify({ session_id: 'sess-big', cwd: REPO_CWD, prompt: '继续任务' });
    const r1 = run(payload, { stateDir, logPath: log });
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes('超过扫描上限'), `截断告警可见（stdout=${r1.stdout.slice(0, 300)}）`);
    const hookErrors = join(stateDir, 'lease', 'hook-errors.jsonl');
    assert.ok(existsSync(hookErrors), 'truncated 必须留痕');
    const truncatedLines = readFileSync(hookErrors, 'utf8').split('\n').filter((l) => l.includes('scan-truncated')).length;
    assert.equal(truncatedLines, 1, 'scan-truncated 每会话恰一行');
    // 第二轮（同会话）：水标已推进到尾部窗口，不再重复告警
    const r2 = run(payload, { stateDir, logPath: log });
    assert.equal(r2.status, 0);
    const after = readFileSync(hookErrors, 'utf8').split('\n').filter((l) => l.includes('scan-truncated')).length;
    assert.equal(after, 1, '第二轮零新增 scan-truncated 留痕');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-244 E04：单键签发异常 → DEGRADED_LEASE_TEXT 注入且 hook-errors 留痕', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uprompt-e04-'));
  try {
    const r = run(JSON.stringify({ session_id: 'sess-e04', cwd: REPO_CWD, prompt: '继续任务' }), {
      stateDir,
      extraEnv: { WF_UPROMPT_FORCE_ISSUE_THROW: '1' },
    });
    assert.equal(r.status, 0, '钩恒 fail-open');
    assert.ok(r.stdout.includes('本轮签发未落盘'), `注入降级行（stdout=${r.stdout.slice(0, 200)}）`);
    const log = join(stateDir, 'lease', 'hook-errors.jsonl');
    assert.ok(existsSync(log), '签发异常必须落 hook-errors');
    const reasons = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).reason);
    assert.ok(reasons.includes('issue-challenge-failed'), `含 issue-challenge-failed（实得 ${JSON.stringify(reasons)}）`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-342 归因 taskId：user-prompt hook-failure 记录 own-only（null 桶→null；具名桶→任务号）', () => {
  const cases = [
    { sid: 'sess-342null', taskId: '内部任务-970', named: false, expect: null },
    { sid: 'sess-342named', taskId: '内部任务-971', named: true, expect: '内部任务-971' },
  ];
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'uprompt-d342-'));
    const log = join(dir, 'suite.jsonl');
    try {
      writeFileSync(log, JSON.stringify({
        event: 'hook.run.failed',
        sessionId: c.sid,
        context: { source: 'plugin.spec-gate@market.SessionStart.1.0' },
      }) + '\n');
      const leaseDir = join(dir, 'lease');
      const prev = process.env.WF_ROUTING_STATE_DIR;
      process.env.WF_ROUTING_STATE_DIR = leaseDir;
      try {
        const ch = issueChallenge(projectKey(REPO_CWD), c.named ? { sessionId: c.sid } : {});
        assert.ok(activateLease(projectKey(REPO_CWD), { leaseId: ch.leaseId, taskId: c.taskId, skill: 'plan-execution' }).ok, '夹具租约激活失败');
      } finally {
        if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
        else process.env.WF_ROUTING_STATE_DIR = prev;
      }
      const r = run(PAYLOAD(c.sid, '任务开始'), { stateDir: dir, logPath: log });
      assert.equal(r.status, 0, '钩恒 fail-open');
      const recs = incidentsOf(dir).filter((d) => d.kind === 'hook-failure' && d.session === c.sid);
      assert.ok(recs.length >= 1, 'hook-failure 须落账');
      assert.equal(recs.at(-1).taskId, c.expect, c.named ? '本会话具名桶记录 taskId 须取任务号' : 'null 桶租约不得归因');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
