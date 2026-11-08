// 文件：routing-declare.test.mjs
// 描述：routing-declare.mjs 的 CLI 级行为测试（2026-09-16 租约族缺陷批次，W2①）——
//       --bootstrap-reissue 补签自救子命令：前置校验（无主键租约拒）、补签回环
//       （新挑战挂 null 桶、可在目标仓键激活——内部任务-24 D1 起恒挂共享桶）、审计落
//       incident（kind=bootstrap-reissue，分钟桶读侧幂等）、缺参拒。
// 作者：wangp  创建：2026-09-16  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 项目全部临时生成（.git 用空目录占位）。
//       A组（2026-10-06 内部任务-5，F12）：声明成功输出的规划阶段许可反馈——plan-writing/
//       plan-review 附固定阶段行（过程 Markdown 上界）且不无条件承诺 Bash/Edit/Write
//       放行；--plan-root 只解计划凭据根、不构成跨仓写许可（闸侧键控验证）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const DECLARE = join(HOOKS, 'routing-declare.mjs');
const GATE = join(HOOKS, 'routing-gate.mjs');
// 相对说明符按本模块 URL 解析，跨平台一致（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { issueChallenge, activateLease, readActiveLease } = await import('../../hooks/task-lease-lib.mjs');
const { projectKey } = await import('../../hooks/routing-lib.mjs');
const { readIncidents } = await import('../../scripts/lib/incident-store.mjs');
const { loadRules } = await import('../../scripts/lib/incident-rules.mjs');

/** 造临时 git 仓（.git 占位）。 */
function makeRepo(name) {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, '.git'));
  return root;
}

/**
 * 以指定 cwd 与隔离注入缝运行 CLI。
 * @param {string} cwd 进程 cwd（主键推导基准）
 * @param {string[]} args 命令行参数
 * @param {{ stateDir: string, incidentRoot: string, exemptRoot?: string }} o 注入缝
 *        （exemptRoot：A组隔离缝——显式临时 WF_EXEMPTIONS_ROOT，审计零真实台账污染）
 */
function runCli(cwd, args, o) {
  const r = spawnSync(process.execPath, [DECLARE, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ZCODE_PROJECT_DIR: '', // W3 锚确定性：屏蔽宿主环境锚
      WF_ROUTING_STATE_DIR: o.stateDir,
      WF_INCIDENT_ROOT: o.incidentRoot,
      ...(o.exemptRoot ? { WF_EXEMPTIONS_ROOT: o.exemptRoot } : {}),
      ...(o.extraEnv ?? {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 为仓签发新挑战并返回令牌（隔离 stateDir，父进程 finally 恢复 env）。 */
function freshToken(repo, stateDir, sessionId) {
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    return issueChallenge(projectKey(repo), sessionId ? { sessionId } : {}).leaseId;
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

/** 在测试进程内以隔离注入缝种入主键有效租约（补签前置）。 */
function seedMainLease(mainRepo, stateDir, sessionId) {
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const ch = issueChallenge(projectKey(mainRepo), { sessionId });
    const act = activateLease(projectKey(mainRepo), { leaseId: ch.leaseId, taskId: 'TASK-1', skill: 'tdd' });
    assert.ok(act.ok, '种入主键租约失败：测试夹具自坏');
    return ch;
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

test('补签回环：主键持租约 → reissue 嵌套仓 → 新挑战挂 null 桶可在目标键激活 + 审计落盘幂等', () => {
  const mainRepo = makeRepo('rdec-main-');
  const nested = makeRepo('rdec-nested-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    seedMainLease(mainRepo, stateDir, 'sess-R1');
    const r = runCli(mainRepo, ['--bootstrap-reissue', nested], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `补签应成功（stderr：${r.stderr}）`);
    assert.ok(r.stdout.includes('补签成功'), '输出确认行');
    const m = r.stdout.match(/[0-9a-f]{32}/);
    assert.ok(m, 'stdout 须携带新令牌（完整 32 位 hex）');
    assert.ok(r.stdout.includes('--lease'), '输出下一步声明命令模板');
    // 内部任务-24 D1（内部任务-99）：补签挑战必须挂 null 桶——多会话并行下继承 newestActiveLease
    // 的 sessionId（他会话桶）是租约闸死循环根因；CLI 无宿主会话标识，恒挂共享桶。
    // 挑战文件名=wf-lease-challenge-<token>.json（task-lease-lib 命名契约），按令牌直读：
    const chFile = JSON.parse(readFileSync(join(stateDir, `wf-lease-challenge-${m[0]}.json`), 'utf8'));
    assert.equal(chFile.sessionId, null, 'D1：补签挑战 sessionId 必须为 null（共享桶）');
    assert.ok(r.stdout.includes('共享桶'), 'D1：补签成功文案须如实说明桶归属');
    // 回环：新令牌可在目标仓键激活（激活继承挑战的 null 会话——落 null 桶，全观察侧可见）
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      // 审计：kind=bootstrap-reissue 落 incident（读侧与写侧同 WF_INCIDENT_ROOT）；
      // 分钟桶幂等（二次调用读侧折叠为一条）。内部任务-247：幂等重放须置于目标键激活**之前**——
      // 目标键优先前置下，激活在目标键种入 null 桶租约后重放会解析到不同租约（归因会话
      // 不同＝合法新审计行，非同 id 折叠面）；读侧折叠语义须在同一租约命中态下断言。
      const prevInc = process.env.WF_INCIDENT_ROOT;
      process.env.WF_INCIDENT_ROOT = incidentRoot;
      try {
        const once = readIncidents(mainRepo).filter((x) => x.kind === 'bootstrap-reissue');
        assert.equal(once.length, 1, '审计行恰一条');
        const again = runCli(mainRepo, ['--bootstrap-reissue', nested], { stateDir, incidentRoot });
        assert.equal(again.status, 0);
        const dedup = readIncidents(mainRepo).filter((x) => x.kind === 'bootstrap-reissue');
        assert.equal(dedup.length, 1, '同分钟桶重放读侧幂等（同 id 折叠）');
        // 内部模块-15 v2（内部决策-063 修正案 3 决策 23.2，内部任务-195）：补签审计行同批携带分类字段
        const rules = loadRules();
        assert.equal(once[0].cause, 'mechanism-trace', '租约族分类（r-lease-trace）');
        assert.equal(once[0].severity, 'info');
        assert.equal(once[0].ruleId, 'r-lease-trace', 'ruleId 与规则表一致（禁内联常量）');
        assert.equal(once[0].rulesVersion, rules.rulesVersion);
        assert.equal(once[0].observationSource, 'hook:routing-declare');
        const act = activateLease(projectKey(nested), { leaseId: m[0], taskId: 'TASK-2', skill: 'tdd' });
        assert.ok(act.ok, `补签令牌须可激活（reason：${act.reason}）`);
      } finally {
        if (prevInc === undefined) delete process.env.WF_INCIDENT_ROOT;
        else process.env.WF_INCIDENT_ROOT = prevInc;
      }
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
  } finally {
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('补签热续期警示：成功输出含冷/热分诊句（DEV-122——同 task 具名 claim 存活时 null 令牌不可用于同号重声明）', () => {
  const mainRepo = makeRepo('rdec-hot-');
  const nested = makeRepo('rdec-nested2-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    seedMainLease(mainRepo, stateDir, 'sess-hot2');
    const r = runCli(mainRepo, ['--bootstrap-reissue', nested], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `补签应成功（stderr：${r.stderr}）`);
    assert.ok(r.stdout.includes('热续期'), '补签成功输出须含冷/热分诊警示（DEV-122）');
    assert.ok(r.stdout.includes('不可用于同号重声明'), '热续期警示须明示 null 令牌局限');
    assert.ok(r.stdout.includes('--release --session'), '警示须含可达出路 --release --session');
  } finally {
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('W4 --plan-root：嵌套键声明 + 主仓计划凭据 → 激活成功；无该旗标则凭据拒', () => {
  const home = mkdtempSync(join(tmpdir(), 'rdec-w4-'));
  const main = join(home, 'main');
  const nested = join(home, 'main', 'nested');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(join(nested, '.git'), { recursive: true });
    mkdirSync(join(main, 'docs', 'plans'), { recursive: true });
    // 主仓放计划 + v2 sidecar（taskId 内部任务-4）
    const planText = '# W4 计划\n';
    writeFileSync(join(main, 'docs', 'plans', 'w4.md'), planText);
    const lfHash = `sha256:${createHash('sha256').update(planText).digest('hex')}`;
    const fm = `---\nschemaVersion: 2\ntaskId: TASK-4\nplanPath: docs/plans/w4.md\nplanSha256: ${lfHash}\nreviewedAt: 2026-09-16T00:00:00+08:00\nreviewMode: self\nreviewInstances: 0\nreviewReason: "W4 夹具"\n---\n\n`;
    writeFileSync(join(main, 'docs', 'plans', 'w4-review.md'), `${fm}结论：通过\n`);
    // 嵌套仓键签发挑战（声明 cwd=nested）
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    let token;
    try {
      token = issueChallenge(projectKey(nested)).leaseId;
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    // 无 --plan-root：凭据按嵌套仓根解析 → 拒（既有行为）
    const noRoot = runCli(nested, ['plan-execution', '--lease', token, '--task-id', 'TASK-4', '--plan', 'docs/plans/w4.md'], { stateDir, incidentRoot });
    assert.equal(noRoot.status, 1, '缺省凭据根=声明键仓根，嵌套仓下必拒');
    // 显式 --plan-root=主仓根 → 放行
    const withRoot = runCli(nested, ['plan-execution', '--lease', token, '--task-id', 'TASK-4', '--plan', 'docs/plans/w4.md', '--plan-root', main], { stateDir, incidentRoot });
    assert.equal(withRoot.status, 0, `--plan-root 解锁嵌套键声明（stderr：${withRoot.stderr}）`);
    assert.ok(withRoot.stdout.includes('计划凭据已绑定'), '凭据绑定确认行');
  } finally {
    for (const d of [home, stateDir, incidentRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test('R-M3-16：超阈值计划 + 缺三字段 sidecar → 拒，stderr 含改动面/independent/--exempt-src', () => {
  const repo = makeRepo('rdec-bigplan-');
  const plans = join(repo, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const lines = ['---', 'specRefs: [FR-wf-1]', '---', '# 大计划', ''];
  for (let i = 1; i <= 9; i += 1) {
    lines.push(`### 步骤 ${i}：做第 ${i} 件事`, '', '验收：命令退出 0', '');
  }
  lines.push('## 文件清单（文件级）', '', '| # | 文件 | 动作 |', '|---|---|---|', '| 1 | `src/a.mjs` | 改 | 职责 |', '');
  const planText = lines.join('\n');
  writeFileSync(join(plans, 'big.md'), planText);
  const lfHash = `sha256:${createHash('sha256').update(planText).digest('hex')}`;
  const fm = `---\nschemaVersion: 2\ntaskId: DEV-1\nplanPath: docs/plans/big.md\nplanSha256: ${lfHash}\nreviewedAt: 2026-10-19T00:00:00+08:00\n---\n\n`;
  writeFileSync(join(plans, 'big-review.md'), `${fm}结论：通过\n`);
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    const token = freshToken(repo, stateDir);
    const r = runCli(repo, ['plan-execution', '--lease', token, '--task-id', 'DEV-1', '--plan', 'docs/plans/big.md'], { stateDir, incidentRoot });
    assert.equal(r.status, 1, `超阈值缺字段必须拒（stdout：${r.stdout}）`);
    assert.match(r.stderr, /reviewMode/);
    assert.match(r.stderr, /改动面：9 步 \/ 1 文件 \/ 0 新模块（超阈值）/);
    assert.match(r.stderr, /--exempt-src/);
    assert.match(r.stderr, /independent/);
  } finally {
    for (const d of [repo, stateDir, incidentRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test('R-M3-16：计划不存在 → surface=null 不崩溃且无改动面行', () => {
  const repo = makeRepo('rdec-noplan-');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    const token = freshToken(repo, stateDir);
    const r = runCli(repo, ['plan-execution', '--lease', token, '--task-id', 'DEV-2', '--plan', 'docs/plans/missing.md'], { stateDir, incidentRoot });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /计划文件不存在/);
    assert.ok(!r.stderr.includes('改动面：'), `早退失败不应编造改动面（stderr：${r.stderr}）`);
  } finally {
    for (const d of [repo, stateDir, incidentRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test('R-M3-16：低阈值缺字段拒绝不打印超阈值指引', () => {
  const repo = makeRepo('rdec-smallplan-');
  const plans = join(repo, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const planText = ['# 小计划', '', '### 步骤 1：做事', '', '验收：x', '', '## 文件清单', '', '| 1 | `src/a.mjs` | 改 |', ''].join('\n');
  writeFileSync(join(plans, 'small.md'), planText);
  const lfHash = `sha256:${createHash('sha256').update(planText).digest('hex')}`;
  const fm = `---\nschemaVersion: 2\ntaskId: DEV-3\nplanPath: docs/plans/small.md\nplanSha256: ${lfHash}\nreviewedAt: 2026-10-19T00:00:00+08:00\n---\n\n`;
  writeFileSync(join(plans, 'small-review.md'), `${fm}结论：通过\n`);
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    const token = freshToken(repo, stateDir);
    const r = runCli(repo, ['plan-execution', '--lease', token, '--task-id', 'DEV-3', '--plan', 'docs/plans/small.md'], { stateDir, incidentRoot });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reviewMode/);
    assert.ok(!r.stderr.includes('超阈值'), '低阈值拒绝不得打印超阈值指引');
  } finally {
    for (const d of [repo, stateDir, incidentRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test('DEV-191：v2 独立凭据拒（v3 迁移文案）；v3 独立凭据放行', () => {
  const repo = makeRepo('rdec-v3-');
  const plans = join(repo, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const planText = ['# 小计划', '', '### 步骤 1：做事', '', '验收：x', '', '## 文件清单', '', '| 1 | `src/a.mjs` | 改 |', ''].join('\n');
  writeFileSync(join(plans, 'small.md'), planText);
  const lfHash = `sha256:${createHash('sha256').update(planText.replace(/\r\n/g, '\n')).digest('hex')}`;
  const chain = 'plan:docs/plans/small.md';
  const prov = JSON.stringify([
    { role: 'engineering', instance: 'eng-1', chain, state: 'fresh' },
    { role: 'ceo', instance: 'ceo-1', chain, state: 'fresh' },
  ]);
  const head = (schemaVersion, extra = '') => `---\nschemaVersion: ${schemaVersion}\ntaskId: DEV-4\nplanPath: docs/plans/small.md\nplanSha256: ${lfHash}\nreviewedAt: 2026-10-21T00:00:00+08:00\nreviewMode: independent\nreviewInstances: 2\nreviewReason: "DEV-191 夹具"${extra}\n---\n\n结论：通过\n`;
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    const token = freshToken(repo, stateDir);
    writeFileSync(join(plans, 'small-review.md'), head(2));
    const bad = runCli(repo, ['plan-execution', '--lease', token, '--task-id', 'DEV-4', '--plan', 'docs/plans/small.md'], { stateDir, incidentRoot });
    assert.equal(bad.status, 1, 'v2 独立凭据必须拒');
    assert.match(bad.stderr, /schemaVersion: 3|reviewProvenance/);
    writeFileSync(join(plans, 'small-review.md'), head(3, `\nreviewRound: 1\nreviewProvenance: ${prov}`));
    const ok = runCli(repo, ['plan-execution', '--lease', token, '--task-id', 'DEV-4', '--plan', 'docs/plans/small.md'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, `v3 独立凭据应放行（stderr：${ok.stderr}）`);
  } finally {
    for (const d of [repo, stateDir, incidentRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test('补签前置拒绝：主键无有效租约 → exit 1 附指引；缺目标参数 → exit 1', () => {
  const mainRepo = makeRepo('rdec-main2-');
  const nested = makeRepo('rdec-nested2-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    const r = runCli(mainRepo, ['--bootstrap-reissue', nested], { stateDir, incidentRoot });
    assert.equal(r.status, 1, '无主键租约必须拒（自救口不得无凭据签发）');
    assert.ok(r.stderr.includes('无有效租约'), '拒绝文案附前置指引');
    const r2 = runCli(mainRepo, ['--bootstrap-reissue'], { stateDir, incidentRoot });
    assert.equal(r2.status, 1, '缺目标仓根参数即用法错误');
    assert.ok(r2.stderr.includes('用法'), '缺参输出 USAGE');
  } finally {
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-247 F3：补签前置目标键优先（长会话 cwd 漂移不失真） ──

test('补签前置目标键优先（DEV-247）', () => {
  const mainRepo = makeRepo('rdec-main3-');
  const nested = makeRepo('rdec-nested3-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-inc-'));
  try {
    // 内部任务-16 实录场景：目标主仓持有效租约、会话持久 cwd 滞留嵌套仓（cwd 键无租约）——
    // 原 cwd-only 前置读漂移仓键误拒；目标键优先后补签成功
    seedMainLease(mainRepo, stateDir, 'sess-F3');
    const r = runCli(nested, ['--bootstrap-reissue', mainRepo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `目标键持租约时补签须成功（stderr：${r.stderr}）`);
    assert.ok(r.stdout.includes('补签成功'), '输出确认行');
    // 内部任务-250（2026-10-28 win32 回归修复）：点名期望值改用 projectKey（canonical/realpath）
    // 与实现单源——实现输出 `${projectKey(resolve(目标))}`（bootstrapReissue）；单式断言消除
    // 「正斜杠/原生双形态」死分支（win32 反斜杠为原生、darwin realpath 为 /private/…）。
    assert.ok(r.stdout.includes(projectKey(mainRepo)), '目标仓点名');
    // 内部验收-37「审计落命中键」：补签成功须落一条 kind=bootstrap-reissue 审计行（目标键持租约=命中键）。
    // 内部任务-250 round2 复审 F1：读面须在显式 WF_INCIDENT_ROOT 语境下（同文件 :112-132 惯例）——
    // incident-store 读根 env 优先，直接 readIncidents(incidentRoot) 在测试进程带该 env 时会读错账本。
    const prevIncRoot = process.env.WF_INCIDENT_ROOT;
    process.env.WF_INCIDENT_ROOT = incidentRoot;
    let audits;
    try {
      audits = readIncidents(incidentRoot).filter((rec) => rec.kind === 'bootstrap-reissue');
    } finally {
      if (prevIncRoot === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = prevIncRoot;
    }
    assert.equal(audits.length, 1, '补签成功须落一条 bootstrap-reissue 审计行');
    assert.equal(audits[0].taskId, 'TASK-1', '审计行 taskId 取命中键租约的任务号');
    // 对照：目标与 cwd 两键均无租约 → exit 1 双键点名（新拒绝文案含「均无有效租约」）
    const other = makeRepo('rdec-other3-');
    try {
      const r2 = runCli(nested, ['--bootstrap-reissue', other], { stateDir, incidentRoot });
      assert.equal(r2.status, 1, '两键均无租约必须拒');
      assert.ok(r2.stderr.includes('均无有效租约'), '拒绝文案双键点名');
      assert.ok(r2.stderr.includes(projectKey(other)), '点名目标仓键');
      assert.ok(r2.stderr.includes(projectKey(nested)), '点名 cwd 键（A-M8-37 双键点名）');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部未决-76（2026-10-05）：域前缀任务号——CLI 形态校验 / 域成员拒 e2e / 取号查询 / 损坏警示 ──

test('OPEN-76 CLI 形态拒绝：旧主力形态 --task-id → exit 1 + stderr 含域前缀教育与取号指引', () => {
  const repo = makeRepo('rdec-o76-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-o76-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-o76-inc-'));
  try {
    const r = runCli(repo, ['tdd', '--lease', 'a'.repeat(32), '--task-id', 'TASK-RELEASE-1'], { stateDir, incidentRoot });
    assert.equal(r.status, 1, '旧主力形态必须拒（:364 纯形态校验，先于 lease 查验之后的激活）');
    assert.ok(r.stderr.includes('域前缀形态'), 'stderr 含形态教育');
    assert.ok(r.stderr.includes('--suggest-task-id'), 'stderr 含取号查询指引');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('OPEN-76 域成员拒 e2e：配置 ["DEV"] 仓声明 FE-1 → exit 1 + stderr 含「域不在本仓域集」（经 activateLease reason 流出）', () => {
  const repo = makeRepo('rdec-dom-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-dom-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-dom-inc-'));
  try {
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV"]}', 'utf8');
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    let ch;
    try {
      ch = issueChallenge(projectKey(repo), { sessionId: 'sess-dom' });
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    const r = runCli(repo, ['brainstorming', '--lease', ch.leaseId, '--task-id', 'FE-1'], { stateDir, incidentRoot });
    assert.equal(r.status, 1, '跨域引用必须拒');
    assert.ok(r.stderr.includes('域不在本仓域集'), 'reason 细分文案（域成员拒）');
    assert.ok(!r.stderr.includes('leaseId 重试'), '不附「重取 leaseId」误导句（令牌无问题，换 task-id 才是出路——评审处置）');
    assert.ok(r.stderr.includes('--suggest-task-id'), '附取号查询指引');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('OPEN-76 取号查询回环：--suggest-task-id 输出建议号退 0；坏 --project-root 拒；损坏 domains.json 输出警示', () => {
  const repo = makeRepo('rdec-sug-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-sug-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-sug-inc-'));
  try {
    const r = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r.status, 0, '查询面教育可见不失败');
    assert.ok(r.stdout.includes('domains.json'), '零域仓输出创建指引');
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV"]}', 'utf8');
    const r2 = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r2.status, 0);
    assert.ok(r2.stdout.includes('DEV-1'), '配置仓建议号（空态取 1）');
    const r3 = runCli(repo, ['--suggest-task-id', '--domain', 'OPS'], { stateDir, incidentRoot });
    assert.ok(r3.status === 0, '查询面仍退 0（教育可见）');
    assert.ok(r3.stdout.includes('不在本仓域集'), '跨域取号拒（取号口径与声明一致——评审处置：不给出必被拒的号）');
    const r3b = runCli(repo, ['--suggest-task-id', '--domain', 'DEV'], { stateDir, incidentRoot });
    assert.ok(r3b.status === 0 && r3b.stdout.includes('DEV-1'), '显式域（仓域集内）正常建议');
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-06-dev1-planning-boundary.md'), 'x', 'utf8');
    const r3c = runCli(repo, ['--suggest-task-id', '--domain', 'DEV'], { stateDir, incidentRoot });
    assert.ok(r3c.status === 0 && r3c.stdout.includes('DEV-2'), '平铺文件名入 CLI 取号（dev1 占位 ⇒ 稠密建议 2，DEV-37/DEV-117）');
    writeFileSync(join(repo, '.workflow', 'domains.json'), '{broken', 'utf8');
    const r4 = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r4.status, 0, '损坏配置不阻断查询');
    assert.ok(r4.stderr.includes('域声明损坏'), 'stderr 损坏警示（fail-open 退 form-only 但可见）');
    const r5 = runCli(repo, ['--suggest-task-id', '--project-root', join(repo, 'no-such')], { stateDir, incidentRoot });
    assert.equal(r5.status, 1, '非法 --project-root 拒（与声明同款存在性校验）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// 内部任务-75/IMP-4：零域态默认域兜底的 CLI 附注面——建议号 + 兜底说明 + domains.json 定制指路；
// 配置仓/显式域分支不附注。
test('DEV-75 零域默认域兜底 CLI 面：--suggest-task-id 输出 DEV 建议与兜底附注，配置仓不附注', () => {
  const repo = makeRepo('rdec-defdom-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-defdom-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-defdom-inc-'));
  try {
    const r = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r.status, 0, '查询面退 0');
    assert.ok(r.stdout.includes('建议任务号：DEV-1'), '零域态恰默认域单建议（空态取 1）');
    assert.ok(r.stdout.includes('内置默认域 DEV 兜底'), '兜底说明可见（ADR-050 D3 起经 DOMAINS_SETUP_HINT 两途文案）');
    assert.ok(r.stdout.includes('domains.json'), '定制指引指向配置文件（旧教育面保留）');
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV"]}', 'utf8');
    const r2 = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r2.status, 0);
    assert.ok(r2.stdout.includes('DEV-1'), '配置仓建议号');
    assert.ok(!r2.stdout.includes('兜底'), '配置仓不附默认域注（域集来自显式声明）');
    const r3 = runCli(repo, ['--suggest-task-id', '--domain', 'OPS'], { stateDir, incidentRoot });
    assert.ok(!r3.stdout.includes('兜底'), '显式跨域分支维持既有 hint 形态（无兜底注）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── A组（2026-10-06 内部任务-5，F12）：声明成功输出的规划阶段许可反馈 ──

test('A组 声明输出阶段许可：plan-writing/plan-review 附固定阶段行且不无条件承诺 Bash/Edit/Write 放行', () => {
  const repo = makeRepo('rdec-stage-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-stage-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-stage-inc-'));
  const exemptRoot = mkdtempSync(join(tmpdir(), 'rdec-stage-exem-'));
  try {
    for (const skill of ['plan-writing', 'plan-review']) {
      const token = freshToken(repo, stateDir, 'sess-stage');
      const r = runCli(repo, [skill, '--lease', token, '--task-id', 'DEV-5'], { stateDir, incidentRoot, exemptRoot });
      assert.equal(r.status, 0, `${skill} 声明应成功（stderr：${r.stderr}）`);
      assert.ok(r.stdout.includes('规划阶段'), `${skill} 输出须含固定阶段行（DEV-5 契约A：两 skill 同款）`);
      assert.ok(r.stdout.includes('docs/plans'), `${skill} 阶段行须指明过程产物上界目录`);
      assert.ok(r.stdout.includes('Markdown') || r.stdout.includes('.md'), `${skill} 阶段行须明示仅过程 Markdown`);
      assert.ok(!r.stdout.includes('Bash/Edit/Write 放行'), `${skill} 不得无条件承诺三类写操作放行（规划阶段许可受限）`);
    }
    // 对照：非规划 skill 的声明确认保持原语义（不附阶段行、放行承诺不变）。
    // 夹具注记：task-id 用 内部任务-6——对照分支换新会话 sess-stage2，若沿用 内部任务-5 会触发
    // 内部未决-76 异会话撞号阻断（既有绿用例锁死的正确行为），属夹具自纠非放宽断言。
    const tok2 = freshToken(repo, stateDir, 'sess-stage2');
    const other = runCli(repo, ['brainstorming', '--lease', tok2, '--task-id', 'DEV-6'], { stateDir, incidentRoot, exemptRoot });
    assert.equal(other.status, 0);
    assert.ok(other.stdout.includes('Bash/Edit/Write 放行'), '非规划 skill 声明确认保持原放行语义（守卫）');
    assert.ok(!other.stdout.includes('规划阶段'), '非规划 skill 不附规划阶段行');
    // 内部任务-24 D4：健康路径激活后可达性自检零告警（告警只在闸侧不可达的损坏态追加，
    // 不污染健康输出；损坏态判据由 task-lease.test 的 activationReachability 单测承载——
    // CLI 单进程内无法从外部构造激活后损坏窗口）
    assert.ok(!other.stdout.includes('闸侧不可达'), '健康路径不得出现可达性告警（D4）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
    rmSync(exemptRoot, { recursive: true, force: true });
  }
});

test('A组 --plan-root 非跨仓写许可：嵌套键 plan-execution 凭据不解锁计划所在仓的闸', () => {
  const home = mkdtempSync(join(tmpdir(), 'rdec-proot-'));
  const main = join(home, 'main');
  const nested = join(home, 'main', 'nested');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-proot-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-proot-inc-'));
  const exemptRoot = mkdtempSync(join(tmpdir(), 'rdec-proot-exem-'));
  try {
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(join(nested, '.git'), { recursive: true });
    mkdirSync(join(main, 'docs', 'plans'), { recursive: true });
    // 主仓放计划 + v2 sidecar（与 W4 用例同构，taskId 内部任务-4）
    const planText = '# proot 计划\n';
    writeFileSync(join(main, 'docs', 'plans', 'proot.md'), planText);
    const lfHash = `sha256:${createHash('sha256').update(planText).digest('hex')}`;
    const fm = `---\nschemaVersion: 2\ntaskId: TASK-4\nplanPath: docs/plans/proot.md\nplanSha256: ${lfHash}\nreviewedAt: 2026-10-06T00:00:00+08:00\nreviewMode: self\nreviewInstances: 0\nreviewReason: "plan-root 夹具"\n---\n\n`;
    writeFileSync(join(main, 'docs', 'plans', 'proot-review.md'), `${fm}结论：通过\n`);
    const token = freshToken(nested, stateDir, 'sess-proot');
    const d = runCli(
      nested,
      ['plan-execution', '--lease', token, '--task-id', 'TASK-4', '--plan', 'docs/plans/proot.md', '--plan-root', main],
      { stateDir, incidentRoot, exemptRoot },
    );
    assert.equal(d.status, 0, `--plan-root 声明应成功（stderr：${d.stderr}）`);
    // 闸侧：凭据根（main 仓）不因 --plan-root 获得写许可——Edit main 仓文件按 main 键判，
    // main 无租约须拒（--plan-root 只解计划凭据解析根，不是跨仓写授权）
    const g = spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(main, 'docs', 'plans', 'other.md') }, cwd: nested }),
      encoding: 'utf8',
      env: {
        ...process.env,
        ZCODE_PLUGIN_ROOT: resolve(HOOKS, '..'),
        WF_ROUTING_STATE_DIR: stateDir,
        WF_INCIDENT_ROOT: incidentRoot,
      },
    });
    assert.equal(g.status, 2, '--plan-root 不构成跨仓写许可：main 仓键无租约须拒');
  } finally {
    for (const dir of [home, stateDir, incidentRoot, exemptRoot]) rmSync(dir, { recursive: true, force: true });
  }
});

// ── 内部任务-20 A2/F7：--init-state-dir（项目级状态根 opt-in 的初始化面）──

const DECLARE_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');

/** 受控 env：HOME/USERPROFILE 决定默认根；清掉注入缝（本组验项目记号路径本身）。 */
function declareEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WF_ROUTING_STATE_DIR;
  return env;
}

test('DEV-20 A2/F7：--init-state-dir 生成项目记号 + 项目内状态根（含自忽略 .gitignore）', () => {
  const base = mkdtempSync(join(tmpdir(), 'declare-init-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--init-state-dir', '--project-root', repo], {
      cwd: repo,
      encoding: 'utf8',
      env: declareEnv(home),
    });
    assert.equal(r.status, 0, `初始化须退 0；实际 ${r.status} stderr=${r.stderr}`);
    const marker = readFileSync(join(repo, '.workflow', 'routing.json'), 'utf8');
    assert.deepEqual(JSON.parse(marker), { stateRoot: 'local' }, '记号内容＝{stateRoot:"local"} 逐字');
    assert.ok(existsSync(join(repo, '.workflow', 'routing-state')), '项目内状态根目录须创建');
    assert.match(readFileSync(join(repo, '.workflow', 'routing-state', '.gitignore'), 'utf8'), /\*/, '自忽略 .gitignore 须在场');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：--init-state-dir 幂等（二次执行退 0 且不覆盖既有记号）', () => {
  const base = mkdtempSync(join(tmpdir(), 'declare-init2-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    const run = () =>
      spawnSync(process.execPath, [DECLARE_CLI, '--init-state-dir', '--project-root', repo], { cwd: repo, encoding: 'utf8', env: declareEnv(home) });
    const first = run();
    const before = readFileSync(join(repo, '.workflow', 'routing.json'), 'utf8');
    const second = run();
    assert.equal(second.status, 0, '二次执行须退 0（幂等）');
    assert.equal(readFileSync(join(repo, '.workflow', 'routing.json'), 'utf8'), before, '既有记号不得被覆盖');
    assert.equal(first.status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：--init-state-dir 在非激活域退 2 并给可执行指引', () => {
  const base = mkdtempSync(join(tmpdir(), 'declare-init3-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const inert = join(base, 'inert');
  mkdirSync(inert, { recursive: true });
  try {
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--init-state-dir', '--project-root', inert], {
      cwd: inert,
      encoding: 'utf8',
      env: declareEnv(home),
    });
    assert.equal(r.status, 2, '非激活域（无 .git 祖先、无标记根）须退 2');
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(/激活域|git|标记/.test(out), `须说明激活域判据；实际：${out.slice(0, 200)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F7：状态根不可写 ⇒ 退 2 且三分支各带可执行命令与适用条件', () => {
  const base = mkdtempSync(join(tmpdir(), 'declare-branch-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    // 构造不可写：让 .workflow 是**文件**（ENOTDIR 形态）⇒ 项目内根建不出来
    writeFileSync(join(repo, '.workflow'), 'occupied\n');
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--init-state-dir', '--project-root', repo], {
      cwd: repo,
      encoding: 'utf8',
      env: declareEnv(home),
    });
    assert.equal(r.status, 2, `不可写须退 2；实际 ${r.status}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes('状态根写入失败'), '写失败须如实归因（不得渲染成"记号非法"）');
    assert.ok(out.includes('--init-state-dir'), '分支① 须给出可执行命令');
    assert.ok(out.includes('重跑上一条命令'), '分支② 须标适用条件（人的动作）');
    assert.ok(out.includes('WF_ROUTING_STATE_DIR'), '分支③ 须给出退回用户级根的命令/变量');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 内部任务-20 A2/F6：--request-domain（跨域声明两步通道的第一跳：登记请求）──

/** 造两仓 + 受控状态根；返回夹具上下文。 */
async function crossDomainFixture(name) {
  const { issueChallenge, activateLease } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const base = mkdtempSync(join(tmpdir(), name));
  const home = join(base, 'home');
  const a = join(base, 'A');
  const b = join(base, 'B');
  const stateDir = join(base, 'state');
  for (const d of [home, join(a, '.git'), join(b, '.git'), stateDir]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, WF_ROUTING_STATE_DIR: stateDir };
  return {
    base,
    home,
    a,
    b,
    stateDir,
    env,
    keyA: projectKey(a),
    keyB: projectKey(b),
    /** 在 A 键签出一把有效租约（请求方的会话来源＝capability 反查，与声明路径同款）。 */
    async leaseInA() {
      const prev = process.env.WF_ROUTING_STATE_DIR;
      process.env.WF_ROUTING_STATE_DIR = stateDir;
      try {
        const ch = issueChallenge(projectKey(a), { sessionId: 'sess-req' });
        const act = activateLease(projectKey(a), { leaseId: ch.leaseId, taskId: 'DEV-20', skill: 'tdd' });
        return { leaseId: ch.leaseId, ok: act.ok !== false };
      } finally {
        if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
        else process.env.WF_ROUTING_STATE_DIR = prev;
      }
    },
  };
}

test('DEV-20 A2/F6：--request-domain 无有效租约令牌 ⇒ 拒（不得产生空会话请求）', async () => {
  const f = await crossDomainFixture('declare-req0-');
  try {
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--request-domain', f.b, '--project-root', f.a], { cwd: f.a, encoding: 'utf8', env: f.env });
    assert.equal(r.status, 2, `无令牌请求须退 2；实际 ${r.status}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(/租约|声明/.test(out), `须指引先取得租约（sessionId 来源＝capability 反查）；实际：${out.slice(0, 200)}`);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F6：--request-domain 登记请求（不含令牌、不激活目标租约）', async () => {
  const { newestActiveLease } = await import('../../hooks/task-lease-lib.mjs');
  const f = await crossDomainFixture('declare-req1-');
  try {
    const lease = await f.leaseInA();
    assert.ok(lease.ok, '前置：请求方租约激活成功');
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--request-domain', f.b, '--lease', lease.leaseId, '--project-root', f.a], {
      cwd: f.a,
      encoding: 'utf8',
      env: f.env,
    });
    assert.equal(r.status, 0, `登记请求须退 0；实际 ${r.status} stderr=${r.stderr}`);
    const line = readFileSync(join(f.stateDir, 'wf-domain-requests.jsonl'), 'utf8').trim().split('\n').pop();
    const rec = JSON.parse(line);
    assert.equal(rec.targetKey, f.keyB, '目标键与声明路径同源（projectKey(resolve(target))）');
    assert.equal(rec.sessionId, 'sess-req', '会话绑定＝由请求方租约反查所得（请求体自身不含令牌）');
    assert.ok(typeof rec.host === 'string' && rec.host.length > 0, 'host 字段在场（签发侧双比用）');
    assert.ok(!Object.hasOwn(rec, 'leaseId') && !Object.hasOwn(rec, 'token'), '请求体不得含任何令牌字段');
    // 不激活租约：目标键仍无任何有效租约（通道第一跳不得放行写面）
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = f.stateDir;
    try {
      assert.equal(newestActiveLease(f.keyB), null, '请求不得在目标键激活任何租约');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F6：--request-domain 目标不在激活域 ⇒ 退 2 并说明判据', async () => {  const f = await crossDomainFixture('declare-req2-');
  try {
    const lease = await f.leaseInA();
    const inert = join(f.base, 'inert');
    mkdirSync(inert, { recursive: true });
    const r = spawnSync(process.execPath, [DECLARE_CLI, '--request-domain', inert, '--lease', lease.leaseId, '--project-root', f.a], {
      cwd: f.a,
      encoding: 'utf8',
      env: f.env,
    });
    assert.equal(r.status, 2, '目标不过激活域根判据须退 2');
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(/激活域|git|标记/.test(out), `须说明判据；实际：${out.slice(0, 200)}`);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('DEV-20 A2/F6：跨域请求超上限（DOMAIN_REQUEST_MAX=3）⇒ 退 2 并列在册', async () => {
  const f = await crossDomainFixture('declare-cap-');
  try {
    const lease = await f.leaseInA();
    assert.ok(lease.ok, '前置：请求方租约激活成功');
    const targets = [];
    for (let i = 0; i < 3; i += 1) {
      const t = join(f.base, `T${i}`);
      mkdirSync(join(t, '.git'), { recursive: true });
      targets.push(t);
    }
    for (const t of targets) {
      const r = spawnSync(process.execPath, [DECLARE_CLI, '--request-domain', t, '--lease', lease.leaseId, '--project-root', f.a], {
        cwd: f.a,
        encoding: 'utf8',
        env: f.env,
      });
      assert.equal(r.status, 0, `在册第 ${targets.indexOf(t) + 1} 条须成功：${r.stdout}${r.stderr}`);
    }
    const extra = join(f.base, 'T3');
    mkdirSync(join(extra, '.git'), { recursive: true });
    const r4 = spawnSync(process.execPath, [DECLARE_CLI, '--request-domain', extra, '--lease', lease.leaseId, '--project-root', f.a], {
      cwd: f.a,
      encoding: 'utf8',
      env: f.env,
    });
    assert.equal(r4.status, 2, '第 4 条须退 2（上限 3）');
    const out = `${r4.stdout}${r4.stderr}`;
    assert.ok(out.includes('上限'), `文案须说明上限；实际：${out.slice(0, 200)}`);
    assert.ok(out.includes('TTL') || out.includes('过期'), '文案须给在册请求的出路（等签发或等过期）');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// ── P4（2026-10-10 内部任务-29 / 内部任务-103 P4）：跨插件衔接 skill 声明扩集 + --via 溯源 ──
// spec-gate 衔接 skill（spec-writing 等）纳入可声明集，须凭 --via <表内入口> 标注
// 来源路由行（审计面记录 via；路由表仍是唯一判定入口，衔接 skill 不设路由行）。

test('P4 衔接 skill 凭 --via 声明放行且 lease.via 落盘；缺 via/非表内 via 值/表内入口带 via 拒', () => {
  const repo = makeRepo('wf-decl-p4-');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-decl-p4-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-decl-p4-ir-'));
  try {
    const tok = freshToken(repo, stateDir, 'sess-p4');
    const ok = runCli(repo, ['spec-writing', '--lease', tok, '--task-id', 'DEV-1', '--via', 'brainstorming'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, '衔接 skill 凭 --via 放行（R-M8-12 扩集）');
    const lease = JSON.parse(readFileSync(join(stateDir, `wf-lease-active-${tok}.json`), 'utf8'));
    assert.equal(lease.via, 'brainstorming', 'lease.via 溯源落盘');
    const tok2 = freshToken(repo, stateDir, 'sess-p4');
    const noVia = runCli(repo, ['spec-writing', '--lease', tok2, '--task-id', 'DEV-1'], { stateDir, incidentRoot });
    assert.equal(noVia.status, 1, '缺 --via 拒');
    assert.ok(noVia.stderr.includes('--via'), '教育文案点名 via 必填');
    const tok3 = freshToken(repo, stateDir, 'sess-p4');
    const badVia = runCli(repo, ['spec-writing', '--lease', tok3, '--task-id', 'DEV-1', '--via', 'nosuch-entry'], { stateDir, incidentRoot });
    assert.equal(badVia.status, 1, 'via 值非表内入口拒');
    assert.ok(badVia.stderr.includes('表内入口'), '文案点名值域');
    const tok4 = freshToken(repo, stateDir, 'sess-p4');
    const viaOnEntry = runCli(repo, ['brainstorming', '--lease', tok4, '--task-id', 'DEV-1', '--via', 'plan-writing'], { stateDir, incidentRoot });
    assert.equal(viaOnEntry.status, 1, '表内入口带 via 拒（via 仅用于衔接 skill）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('P4 表外名拒绝文案分三组（表内入口/跨插件衔接凭 --via/ad-hoc）', () => {
  const repo = makeRepo('wf-decl-p4b-');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-decl-p4b-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-decl-p4b-ir-'));
  try {
    const r = runCli(repo, ['nosuchskill', '--lease', 'a'.repeat(16), '--task-id', 'DEV-1'], { stateDir, incidentRoot });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('表内入口') && r.stderr.includes('跨插件衔接') && r.stderr.includes('ad-hoc'), '三组候选并列呈现');
    assert.ok(r.stderr.includes('spec-writing'), '衔接组点名 spec-writing');
    assert.ok(r.stderr.includes('ad-hoc-deliverable'), 'DEV-116：保留名组并列两名');
    assert.ok(r.stderr.includes('状态型') && r.stderr.includes('制品型'), 'DEV-116：两名各自语义呈现');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-116 / 内部未决-128 方案 B：ad-hoc-deliverable 制品型保留名 ──

test('DEV-116 ad-hoc-deliverable 制品型保留名声明放行且 lease.skill 落新名', () => {
  const repo = makeRepo('wf-decl-d116-');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-decl-d116-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-decl-d116-ir-'));
  try {
    const tok = freshToken(repo, stateDir, 'sess-d116');
    const ok = runCli(repo, ['ad-hoc-deliverable', '--lease', tok, '--task-id', 'DEV-1'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, '制品型保留名可声明（isDeclarableSkill 扩两保留名）');
    assert.ok(ok.stdout.includes('--deliverable-chain'), '成功输出含完成链指引（制品链形态）');
    assert.ok(ok.stdout.includes('制品型'), '成功输出标注制品型');
    const lease = JSON.parse(readFileSync(join(stateDir, `wf-lease-active-${tok}.json`), 'utf8'));
    assert.equal(lease.skill, 'ad-hoc-deliverable', 'lease.skill 落新名');
    assert.ok(!('via' in lease), '保留名不带 via');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-41（2026-10-11，FIX-3 承接）：旧轮令牌 CLI 拒因端到端（轮内自纠文案）──

test('DEV-41 旧轮令牌声明：exit 1 + stderr 含「已失效的旧轮令牌」与在位挑战短令牌', async () => {
  const repo = makeRepo('dev41-decl-');
  const stateDir = mkdtempSync(join(tmpdir(), 'dev41-decl-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'dev41-decl-ir-'));
  try {
    process.env.WF_ROUTING_TTL_MS = '80';
    const stale = freshToken(repo, stateDir, 'sess-cli');
    await new Promise((r) => setTimeout(r, 150));
    process.env.WF_ROUTING_TTL_MS = '5000';
    const cur = freshToken(repo, stateDir, 'sess-cli');
    const r = runCli(repo, ['verification', '--lease', stale, '--task-id', 'DEV-41'], { stateDir, incidentRoot });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('已失效的旧轮令牌'), `stderr 须含二分拒因：${r.stderr}`);
    assert.ok(r.stderr.includes(`当前在位挑战 ${cur.slice(0, 8)}`), `stderr 须内联在位挑战短令牌：${r.stderr}`);
    assert.ok(r.stderr.includes('最新一轮【workflow 任务租约】行'));
  } finally {
    delete process.env.WF_ROUTING_TTL_MS;
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// 内部任务-75/IMP-3（内部规则-20）：映射表内 skill 声明侧提示档——root-cause-debugging 未附
// --change-scope 时 stderr 一行强提示（退出码 0 不变）；带 --change-scope 或非映射 skill 不提示。
test('DEV-75 基线写面声明提示：root-cause 未附 --change-scope 提示、附后静默、非映射 skill 不提示', () => {
  const repo = makeRepo('rdec-floorhint-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-fh-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-fh-inc-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-fh');
    const r = runCli(repo, ['root-cause-debugging', '--lease', token, '--task-id', 'DEV-90001'], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `声明应成功（提示档不阻断）：${r.stderr}`);
    assert.ok(r.stderr.includes('基线写面'), 'stderr 提示点名基线写面');
    assert.ok(r.stderr.includes('--change-scope'), '提示含补声明指引');
    const token2 = freshToken(repo, stateDir, 'sess-fh2');
    const r2 = runCli(repo, ['root-cause-debugging', '--lease', token2, '--task-id', 'DEV-90002', '--change-scope', '["src"]'], { stateDir, incidentRoot });
    assert.equal(r2.status, 0, `带写面声明应成功：${r2.stderr}`);
    assert.ok(!r2.stderr.includes('基线写面'), '附 --change-scope 后不再提示');
    const token3 = freshToken(repo, stateDir, 'sess-fh3');
    const r3 = runCli(repo, ['brainstorming', '--lease', token3, '--task-id', 'DEV-90003'], { stateDir, incidentRoot });
    assert.equal(r3.status, 0, `非映射 skill 声明应成功：${r3.stderr}`);
    assert.ok(!r3.stderr.includes('基线写面'), '非映射 skill 不提示');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部决策-045/内部任务-96：--maintainer CLI 透传与维护者注册表损坏警示（内部验收-9 断言承载，阶段复审项目约定维发现 1）──

test('ADR-045 --suggest-task-id --maintainer：三段建议透传＋成员校验拒在 CLI 面可见', () => {
  const repo = makeRepo('rdec-adr45m-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-adr45m-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-adr45m-inc-'));
  try {
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    writeFileSync(join(repo, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    const r1 = runCli(repo, ['--suggest-task-id', '--domain', 'DEV', '--maintainer', 'WP'], { stateDir, incidentRoot });
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes('DEV-WP-1'), '三段建议号经 CLI 旗标透传');
    const r2 = runCli(repo, ['--suggest-task-id', '--domain', 'DEV', '--maintainer', 'QQ'], { stateDir, incidentRoot });
    assert.equal(r2.status, 0, '查询面恒退 0（教育可见）');
    assert.ok(r2.stdout.includes('不在本仓注册表'), '成员校验拒因在 CLI 面呈现');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('ADR-045 warnBrokenMaintainers：注册表存在而解析失败 → stderr 警示（lenient 正常态静默）', () => {
  const repo = makeRepo('rdec-adr45w-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-adr45w-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-adr45w-inc-'));
  try {
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    writeFileSync(join(repo, '.workflow', 'maintainers.json'), '{broken');
    const r = runCli(repo, ['--suggest-task-id', '--domain', 'DEV'], { stateDir, incidentRoot });
    assert.equal(r.status, 0, '查询面恒退 0');
    assert.ok(r.stderr.includes('【维护者注册表损坏】'), '损坏警示 stderr（fail-safe 教育面）');
    assert.ok(r.stdout.includes('DEV-1'), '二段建议照常给出（fail-open）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ============ 内部任务-62 / 内部决策-050：占位登记挂点端到端 ============

test('DEV-62 S1 声明成功即落占位：claims/<taskId>.json（claimed）＋输出含提交纪律句', () => {
  const repo = makeRepo('rdec-claims-s1-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-claims-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-claims-ir-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-claims1');
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-911', '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `声明应成功（stderr：${r.stderr}）`);
    const marker = JSON.parse(readFileSync(join(repo, 'docs', 'plans', 'claims', 'DEV-911.json'), 'utf8'));
    assert.equal(marker.status, 'claimed');
    assert.equal(marker.taskId, 'DEV-911');
    assert.ok(r.stdout.includes('docs/plans/claims/DEV-911.json'), '成功输出须含占位路径的提交纪律句');
    assert.ok(r.stdout.includes('commit+push'), '提交纪律句须含跨机可见前提指引');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-62 S2 --release 后占位改 released（回收语义可见于 git 同步面）', () => {
  const repo = makeRepo('rdec-claims-s2-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-claims-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-claims-ir-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-claims2');
    assert.equal(runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-912', '--project-root', repo], { stateDir, incidentRoot }).status, 0);
    const token2 = freshToken(repo, stateDir, 'sess-claims2');
    assert.equal(runCli(repo, ['--release', '--lease', token2, '--project-root', repo], { stateDir, incidentRoot }).status, 0);
    const marker = JSON.parse(readFileSync(join(repo, 'docs', 'plans', 'claims', 'DEV-912.json'), 'utf8'));
    assert.equal(marker.status, 'released', '--release 须同步占位 released（ADR-050 D2 显式释放即回收）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-62 S3 sweep 清理未跟踪弃占位：过期＋未跟踪被物理删，tracked 保持', { skip: spawnSync('git', ['--version']).status !== 0 && 'git 不可用' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rdec-claims-s3-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-claims-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-claims-ir-'));
  try {
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      mkdirSync(join(root, 'docs', 'plans', 'claims'), { recursive: true });
      writeFileSync(join(root, 'docs', 'plans', 'claims', 'DEV-913.json'), JSON.stringify({ schemaVersion: 1, taskId: 'DEV-913', status: 'claimed', expiresAt: Date.now() - 1000 }));
      const trackedFile = join(root, 'docs', 'plans', 'claims', 'DEV-914.json');
      writeFileSync(trackedFile, JSON.stringify({ schemaVersion: 1, taskId: 'DEV-914', status: 'released', ts: 1 }));
      const g = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
      g(['add', 'docs/plans/claims/DEV-914.json']); g(['commit', '-q', '-m', 'x']);
      issueChallenge(projectKey(root), {}); // 触发 sweep（挂点=签发挑战）
      assert.ok(!existsSync(join(root, 'docs', 'plans', 'claims', 'DEV-913.json')), '未跟踪＋过期占位须被 sweep 物理清理（回池）');
      assert.ok(existsSync(trackedFile), '已跟踪占位永不物理删（跨机审计面）');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR; else process.env.WF_ROUTING_STATE_DIR = prev;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-62 G4 查询面两途引导：零域仓 --suggest-task-id 附注含授权代建句；维护者拒因增强两途', () => {
  const repo = makeRepo('rdec-hint-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-hint-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-hint-ir-'));
  try {
    const r = runCli(repo, ['--suggest-task-id'], { stateDir, incidentRoot });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('授权'), '零域态查询面须含两途引导（授权代建）');
    assert.ok(r.stdout.includes('domains.json'), '引导须指向 domains.json');
    const rm = runCli(repo, ['--suggest-task-id', '--domain', 'DEV', '--maintainer', 'WP'], { stateDir, incidentRoot });
    assert.equal(rm.status, 0);
    assert.ok(rm.stdout.includes('授权'), '维护者注册表缺席拒因须增强两途句（自建/授权代建）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-261（内部决策-066 D3）：--script-write 声明通道 ──

test('DEV-261 script-write 声明与租约字段：合法≥8 字入租约+审计；短理由退 1；重复声明 last-wins', () => {
  const repo = makeRepo('wf-declare-sw-');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-declare-sw-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-declare-sw-inc-'));
  const auditFile = join(stateDir, 'wf-script-writes.jsonl');
  try {
    // 合法声明：理由入租约 scriptWrites[]，审计一行
    const t1 = freshToken(repo, stateDir);
    const ok1 = runCli(repo, ['plan-writing', '--lease', t1, '--task-id', 'DEV-261', '--script-write', '本轮机械替换 5 个测试标题'], { stateDir, incidentRoot });
    assert.equal(ok1.status, 0, `合法声明须成功：${ok1.stderr}`);
    assert.ok(ok1.stdout.includes('【脚本写声明】1 条'), '成功输出须含声明条数');
    // readActiveLease 读父进程环境的状态根：显式切到测试 stateDir
    const prevState = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    let lease1;
    let lease2;
    try {
      lease1 = readActiveLease(projectKey(repo));
      assert.equal(lease1.valid, true);
      assert.equal(Array.isArray(lease1.lease.scriptWrites), true, '租约须写 scriptWrites[]');
      assert.equal(lease1.lease.scriptWrites.length, 1);
      assert.ok(lease1.lease.scriptWrites[0].reason.includes('机械替换'));
      assert.match(String(lease1.lease.scriptWrites[0].declaredAt), /^\d{4}-/, 'declaredAt 由库打时间戳');
      assert.ok(existsSync(auditFile), '审计文件须落盘');
      assert.equal(readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length, 1);
      const audit1 = JSON.parse(readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)[0]);
      assert.equal(audit1.projectKey, projectKey(repo), '审计须含 projectKey（多仓共状态根可区分）');

      // 短理由：exit 1（内部模块-8 §2 契约），不激活、不写审计
      const t2 = freshToken(repo, stateDir);
      const bad = runCli(repo, ['plan-writing', '--lease', t2, '--task-id', 'DEV-261', '--script-write', '短'], { stateDir, incidentRoot });
      assert.equal(bad.status, 1, '短理由须 exit 1');
      assert.match(bad.stderr, /≥8/, '拒因须含长度要求');
      assert.equal(readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length, 1, '失败声明不得写审计');

      // 缺值 / 后随旗标：exit 1（内部模块-8 §2；不得静默跳过或吞下一旗标当理由）
      const t4 = freshToken(repo, stateDir);
      const noVal = runCli(repo, ['plan-writing', '--lease', t4, '--task-id', 'DEV-261', '--script-write'], { stateDir, incidentRoot });
      assert.equal(noVal.status, 1, '行尾裸 --script-write 须 exit 1');
      assert.match(noVal.stderr, /缺值/, '拒因须含缺值说明');
      const t5 = freshToken(repo, stateDir);
      const nextFlag = runCli(repo, ['plan-writing', '--lease', t5, '--task-id', 'DEV-261', '--script-write', '--exempt', 'xx'], { stateDir, incidentRoot });
      assert.equal(nextFlag.status, 1, '--script-write 后随旗标须 exit 1');

      // 重复声明：租约 last-wins（仅保留最新一条），审计逐次追加
      const t3 = freshToken(repo, stateDir);
      const ok2 = runCli(repo, ['plan-writing', '--lease', t3, '--task-id', 'DEV-261', '--script-write', '第二个声明理由用于替换检查'], { stateDir, incidentRoot });
      assert.equal(ok2.status, 0, `重复声明须成功：${ok2.stderr}`);
      lease2 = readActiveLease(projectKey(repo));
      assert.equal(lease2.lease.scriptWrites.length, 1, '租约 last-wins');
      assert.ok(lease2.lease.scriptWrites[0].reason.includes('第二个'));
      assert.equal(readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length, 2, '审计逐次追加');
    } finally {
      if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevState;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-261 script-write 审计失败 fail-open：store 返回 {ok:false} 不抛', async () => {
  const { appendScriptWrite } = await import('../lib/script-write-store.mjs');
  const home = mkdtempSync(join(tmpdir(), 'wf-sw-store-'));
  try {
    const asFile = join(home, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const r = appendScriptWrite({ dir: asFile, record: { taskId: 'DEV-261', reason: '审计失败注入用例理由' } });
    assert.equal(r.ok, false, '目录不可用须返回 {ok:false}');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '失败须带原因');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('DEV-261 script-write 多值同命令与审计失败：租约/审计逐条保留；审计失败不阻断', () => {
  const repo = makeRepo('wf-declare-sw2-');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-declare-sw2-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-declare-sw2-inc-'));
  try {
    // 同命令两条声明：租约 scriptWrites 两条 + 审计两行
    const t1 = freshToken(repo, stateDir);
    const ok = runCli(repo, ['plan-writing', '--lease', t1, '--task-id', 'DEV-261', '--script-write', '第一条声明理由足够长', '--script-write', '第二条声明理由足够长'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, `多值声明须成功：${ok.stderr}`);
    assert.ok(ok.stdout.includes('【脚本写声明】2 条'), '输出须含两条');
    const prevState = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const lease = readActiveLease(projectKey(repo));
      assert.equal(lease.valid, true);
      assert.equal(lease.lease.scriptWrites.length, 2, '租约须保留两条声明');
      assert.equal(readFileSync(join(stateDir, 'wf-script-writes.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2, '审计逐条追加');
    } finally {
      if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevState;
    }
    // 审计写失败（审计文件位置被目录占用）：已激活租约不阻断，stderr 显式警示
    const t2 = freshToken(repo, stateDir);
    rmSync(join(stateDir, 'wf-script-writes.jsonl'), { force: true });
    mkdirSync(join(stateDir, 'wf-script-writes.jsonl'));
    const bad = runCli(repo, ['plan-writing', '--lease', t2, '--task-id', 'DEV-261', '--script-write', '审计失败注入理由足够长'], { stateDir, incidentRoot });
    assert.equal(bad.status, 0, '审计失败不得阻断已激活租约');
    assert.match(bad.stderr, /审计写失败/, '审计失败须 stderr 可见');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-285 --script-edit-code：窄声明入租约 scriptEditCode[] 与 wf-script-edits.jsonl 审计；理由短/非法拒', async () => {
  const { readdirSync } = await import('node:fs');
  const repo = makeRepo('declare-285-');
  const stateDir = mkdtempSync(join(tmpdir(), 'declare-285-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'declare-285-inc-'));
  try {
    const token = freshToken(repo, stateDir);
    const ok = runCli(repo, ['plan-writing', '--lease', token, '--task-id', 'DEV-285', '--script-edit-code', '本轮脚本编辑受检文件的目的与范围'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, `窄声明应成功：${ok.stderr}`);
    assert.match(ok.stdout, /受检路径脚本编辑声明/, '声明摘要须可见');
    const prevState = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const lease = readActiveLease(projectKey(repo));
      assert.equal(lease.valid, true);
      assert.equal(Array.isArray(lease.lease.scriptEditCode), true, '租约须含 scriptEditCode[]');
      assert.equal(lease.lease.scriptEditCode.length, 1);
      assert.ok(lease.lease.scriptEditCode[0].reason.includes('受检文件'));
      assert.equal(typeof lease.lease.scriptEditCode[0].declaredAt, 'string');
      assert.equal(lease.lease.scriptWrites, undefined, '未声明 --script-write 时不得产 scriptWrites 键');
      const audit = readFileSync(join(stateDir, 'wf-script-edits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(audit.length, 1, '审计逐条追加');
      assert.equal(audit[0].taskId, 'DEV-285');
      assert.ok(audit[0].reason.includes('受检文件'));
    } finally {
      if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevState;
    }
    // 理由过短：exit 1 且 stderr 点明 scriptEditCode
    const t2 = freshToken(repo, stateDir);
    const short = runCli(repo, ['plan-writing', '--lease', t2, '--task-id', 'DEV-285', '--script-edit-code', '短'], { stateDir, incidentRoot });
    assert.equal(short.status, 1, '短理由须拒');
    assert.match(short.stderr, /scriptEditCode/, '拒因须点明旗标名');
    // 缺值：exit 1
    const t3 = freshToken(repo, stateDir);
    const missing = runCli(repo, ['plan-writing', '--lease', t3, '--task-id', 'DEV-285', '--script-edit-code'], { stateDir, incidentRoot });
    assert.equal(missing.status, 1, '缺值须拒');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ============ 内部任务-342：内部写归因 journal（claim/release/owner-null/fail-open） ============

/** 读项目 journal 行（stateDir 注入下 routing-declare 的内部写账位置）。 */
function auditJournal(stateDir, repo) {
  const proj = createHash('sha256').update(String(projectKey(repo))).digest('hex').slice(0, 16);
  const file = join(stateDir, `wf-write-journal-${proj}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('DEV-342 内部写：声明成功追加 internal journal 行（owner sid/task/targets 保真）', () => {
  const repo = makeRepo('rdec-i342-a-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-i342a');
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-941', '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `声明应成功（stderr：${r.stderr}）`);
    const row = auditJournal(stateDir, repo).find((x) => x.tool === 'internal' && x.taskId === 'DEV-941');
    assert.ok(row, '声明成功须追加 internal journal 行');
    assert.equal(row.sid, 'sess-i342a');
    assert.equal(row.sidDigest, createHash('sha256').update('sess-i342a').digest('hex').slice(0, 16));
    assert.deepEqual(row.targets, ['docs/plans/claims/DEV-941.json']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：owner null（null 桶声明）行形态为 sid=null', () => {
  const repo = makeRepo('rdec-i342-b-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const token = freshToken(repo, stateDir); // 无 sessionId → null 桶声明
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-942', '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `声明应成功（stderr：${r.stderr}）`);
    const row = auditJournal(stateDir, repo).find((x) => x.tool === 'internal' && x.taskId === 'DEV-942');
    assert.ok(row, 'null 桶声明也须落 internal 行（owner 不可识别不是不记账的理由）');
    assert.equal(row.sid, null, 'owner 不可识别时 sid=null');
    assert.equal(row.sidDigest, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：release 按释放 claim 逐条追加 internal 行（多 claim 场景）', () => {
  const repo = makeRepo('rdec-i342-c-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const t1 = freshToken(repo, stateDir, 'sess-i342c');
    assert.equal(runCli(repo, ['verification', '--lease', t1, '--task-id', 'DEV-943', '--project-root', repo], { stateDir, incidentRoot }).status, 0);
    const t2 = freshToken(repo, stateDir, 'sess-i342c');
    assert.equal(runCli(repo, ['verification', '--lease', t2, '--task-id', 'DEV-944', '--project-root', repo], { stateDir, incidentRoot }).status, 0);
    // 声明期已各写同 sid/同 targets 的 internal 行：release 断言必须只对**新增行**计数，
    // 否则删掉 release 分支的 journalInternalWrite 断言仍绿（反假测试，阶段 L 简洁性 F1）。
    const beforeRows = auditJournal(stateDir, repo).filter((x) => x.tool === 'internal' && x.sid === 'sess-i342c');
    const t3 = freshToken(repo, stateDir, 'sess-i342c');
    const rel = runCli(repo, ['--release', '--lease', t3, '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(rel.status, 0, `release 应成功（stderr：${rel.stderr}）`);
    const afterRows = auditJournal(stateDir, repo).filter((x) => x.tool === 'internal' && x.sid === 'sess-i342c');
    assert.equal(afterRows.length - beforeRows.length, 2, 'release 须恰好新增 2 条 internal 行（不得以声明期行冒充）');
    const targets = afterRows.slice(beforeRows.length).flatMap((x) => x.targets);
    assert.ok(targets.includes('docs/plans/claims/DEV-943.json'), '多 claim release 须逐条 internal 行（DEV-943）');
    assert.ok(targets.includes('docs/plans/claims/DEV-944.json'), '多 claim release 须逐条 internal 行（DEV-944）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：release marker 失败（markerOk=false）不落伪 internal 行', () => {
  const repo = makeRepo('rdec-i342-e-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const t1 = freshToken(repo, stateDir, 'sess-i342e');
    assert.equal(runCli(repo, ['verification', '--lease', t1, '--task-id', 'DEV-946', '--project-root', repo], { stateDir, incidentRoot }).status, 0);
    // 制造占位持有者不匹配（markClaimReleased 将返回 ok:false）
    const markerPath = join(repo, 'docs', 'plans', 'claims', 'DEV-946.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.sessionDigest = 'deadbeefdeadbeef';
    writeFileSync(markerPath, JSON.stringify(marker));
    const before = auditJournal(stateDir, repo).filter((x) => x.tool === 'internal' && x.sid === 'sess-i342e');
    const t2 = freshToken(repo, stateDir, 'sess-i342e');
    const rel = runCli(repo, ['--release', '--lease', t2, '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(rel.status, 0, `release 应成功（stderr：${rel.stderr}）`);
    assert.match(rel.stderr, /占位 released 标记失败/, 'marker 失败须 stderr 可见（不得静默）');
    const after = auditJournal(stateDir, repo).filter((x) => x.tool === 'internal' && x.sid === 'sess-i342e');
    assert.equal(after.length, before.length, 'markerOk=false 不得落伪 internal 行');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：active 落盘失败回滚 claim 时补 internal 行（失败路径不留空归因链）', () => {
  const repo = makeRepo('rdec-i342-f-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-i342f');
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-947', '--project-root', repo], {
      stateDir,
      incidentRoot,
      extraEnv: { WF_FORCE_ACTIVE_WRITE_FAIL: '1' },
    });
    assert.equal(r.status, 1, 'active 落盘失败须 exit 1');
    const row = auditJournal(stateDir, repo).find((x) => x.tool === 'internal' && x.taskId === 'DEV-947');
    assert.ok(row, '失败路径改写了 claim/占位也必须补 internal journal 行（不得留空归因链）');
    assert.equal(row.sid, 'sess-i342f');
    assert.deepEqual(row.targets, ['docs/plans/claims/DEV-947.json']);
    // marker 已按回滚语义翻 released（写者可得：声明失败但占位不悬空）
    const marker = JSON.parse(readFileSync(join(repo, 'docs', 'plans', 'claims', 'DEV-947.json'), 'utf8'));
    assert.equal(marker.status, 'released');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：claimMarkerWritten=false 时不落 internal 行', (t) => {
  if (process.platform === 'win32') { t.skip('chmod 语义在 win32 不适用（登记跳过）'); return; }
  // 内部任务-358（内部任务-120 同族）：POSIX root 持 CAP_DAC_OVERRIDE，chmod 0555 不阻写——失败注入不可达即跳过，
  // 不在不可达环境里断言「环境不可能的前提」（同款守卫见 post-tool-hook/incident-store/session-start）。
  if (process.getuid?.() === 0) { t.skip('root 环境 chmod 不产生 EPERM，写失败面无法取证'); return; }
  const repo = makeRepo('rdec-i342-g-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  const claimsDir = join(repo, 'docs', 'plans', 'claims');
  try {
    mkdirSync(claimsDir, { recursive: true });
    chmodSync(claimsDir, 0o555); // 占位写失败 → claimMarkerWritten=false
    const token = freshToken(repo, stateDir, 'sess-i342g');
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-948', '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `占位写失败不阻断声明（stderr：${r.stderr}）`);
    assert.match(r.stderr, /占位登记（docs\/plans\/claims\/DEV-948\.json）写盘失败/, '占位失败须 stderr 可见');
    const row = auditJournal(stateDir, repo).find((x) => x.tool === 'internal' && x.taskId === 'DEV-948');
    assert.equal(row, undefined, 'claimMarkerWritten=false 时不得落 internal 行（无写仓不记账）');
  } finally {
    try { chmodSync(claimsDir, 0o755); } catch { /* 恢复尽力 */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 内部写：继承声明（delegated）不落 internal 行、不写 claim/占位', () => {
  const repo = makeRepo('rdec-i342-h-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  const prev = process.env.WF_ROUTING_STATE_DIR;
  try {
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    let token;
    try {
      token = issueChallenge(projectKey(repo), {
        sessionId: 'child-342',
        delegationDepth: 1,
        parentSessionId: 'parent-342',
        inheritTaskId: 'DEV-949',
      }).leaseId;
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-949', '--project-root', repo], { stateDir, incidentRoot });
    assert.equal(r.status, 0, `继承声明应成功（stderr：${r.stderr}）`);
    assert.match(r.stdout, /继承声明生效/, '继承声明须走 inherited 分支');
    const row = auditJournal(stateDir, repo).find((x) => x.tool === 'internal' && x.taskId === 'DEV-949');
    assert.equal(row, undefined, '继承声明不写 claim/占位，因此不得落 internal 行');
    assert.equal(existsSync(join(repo, 'docs', 'plans', 'claims', 'DEV-949.json')), false, '继承声明不写仓占位');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 internal journal 写失败：声明仍成功且 stderr 有警示', () => {
  const repo = makeRepo('rdec-i342-d-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-i342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-i342-ir-'));
  try {
    const token = freshToken(repo, stateDir, 'sess-i342d');
    const r = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-945', '--project-root', repo], {
      stateDir,
      incidentRoot,
      extraEnv: { WF_INTERNAL_JOURNAL_FAIL: '1' },
    });
    assert.equal(r.status, 0, 'journal 写失败不得阻断声明（fail-open）');
    assert.match(r.stderr, /内部写归因 journal 追加失败/, '失败须 stderr 可见');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});


test('DEV-341 项目 skill ack：必载集合缺项拒声明/未知名候选/ack 入租约与台账', () => {
  const repo = makeRepo('rdec-dev341-');
  const bare = makeRepo('rdec-dev341-bare-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rdec-dev341-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rdec-dev341-ir-'));
  try {
    mkdirSync(join(repo, '.agents', 'skills', 'project-conventions'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'skills', 'project-conventions', 'SKILL.md'),
      '---\nname: project-conventions\ndescription: 本仓操作约束\nx-load-scenario: 写/改任何文件前\nx-required-on-write: true\n---\n',
    );
    const token = freshToken(repo, stateDir, 'sess-dev341');
    const missing = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-341'], { stateDir, incidentRoot });
    assert.equal(missing.status, 1, '缺 ack 必须拒声明');
    assert.match(missing.stderr, /必载集合未 ack/);
    assert.match(missing.stderr, /--project-skill project-conventions/);
    const unknown = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-341', '--project-skill', 'nope'], { stateDir, incidentRoot });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知名/);
    assert.match(unknown.stderr, /project-conventions@\.agents\/skills/);
    const ok = runCli(repo, ['verification', '--lease', token, '--task-id', 'DEV-341', '--project-skill', 'project-conventions'], { stateDir, incidentRoot });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /【项目 skill】已 ack：project-conventions/);
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const cur = readActiveLease(projectKey(repo), Date.now(), { sessionId: 'sess-dev341' });
      assert.equal(cur.valid, true);
      assert.deepEqual(cur.lease.projectSkills, [{ name: 'project-conventions', root: '.agents/skills' }]);
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    // 无项目 skill 仓：任意 ack 名都属未知名（零义务不得携带 ack）
    const token2 = freshToken(bare, stateDir, 'sess-dev341b');
    const bareRes = runCli(bare, ['verification', '--lease', token2, '--task-id', 'DEV-342', '--project-skill', 'ghost'], { stateDir, incidentRoot });
    assert.equal(bareRes.status, 1);
    assert.match(bareRes.stderr, /未知名/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-348 批 D（内部未决-214② 旗标互斥）──

test('OPEN-214② --bootstrap-reissue 与状态写子命令互斥：共见即退 2（不静默遮蔽）', () => {
  const repo = makeRepo('dev348-boot-mutex');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-348-bs-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-348-bi-'));
  try {
    for (const flag of ['--release', '--init-state-dir', '--request-domain', '--suggest-task-id']) {
      const r = runCli(repo, ['--bootstrap-reissue', repo, flag], { stateDir, incidentRoot });
      assert.equal(r.status, 2, `${flag} 共见须退 2`);
      assert.match(r.stderr, /互斥/);
      assert.match(r.stderr, new RegExp(flag), `${flag} 须在拒因中点名`);
    }
    // 纯补签回归由既有 bootstrap-reissue 用例族承载（本用例的空 stateDir 无主键租约——
    // 纯补签会因前置校验退 1，与本互斥面无关，不在此重复断言）。
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});
