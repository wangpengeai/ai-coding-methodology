// 文件：routing-gate.test.mjs
// 描述：任务租约闸与声明命令的行为测试（内部规则-8，2026-09-13 内部决策-018 升级为 per-session）——
//       「已加载 ≠ 已执行」的机械落点：无当前 prompt 租约的 Bash/Edit/Write 被 deny
//       并给出含本轮 leaseId 的声明命令；Bash 仅放行一条严格解析的声明命令
//       （bootstrap）；声明激活后本 prompt 内放行；下一 prompt 自动轮换失效；
//       项目间隔离；plan-execution 声明必须显式 --plan 且 v2 sidecar 绑定
//       （taskId/planPath/planSha256 一致）；垃圾负载 fail-open。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 项目全部临时生成（.git 用空目录占位）。
//       A组（2026-10-06 内部任务-5，F12 规划阶段写面边界）：plan-writing/plan-review 健康租约的
//       Edit/Write 固定上界（PLAN_DIRS 过程 Markdown，含 legacy 目录与子目录）端到端面——
//       越界目标拒（AGENTS/内部规格非 md/目录/链接逃逸）、固定上界 AND 可选 changeScope
//       （[]/["."]/宽面不扩权、空交集不放行）、旧租约形态（legacy v2/null 扫描回退）同检、
//       嵌套仓与 --plan-root 不构成跨仓许可、Bash 不受上界（非 shell 沙箱）、deny 复用
//       信封/exit 2/留痕且专属文案不携带 --change-scope 扩面尾句。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const GATE = join(HOOKS, 'routing-gate.mjs');
const DECLARE = join(HOOKS, 'routing-declare.mjs');
// 相对说明符按本模块 URL 解析，跨平台一致（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { issueChallenge, activateLease, readActiveLease, LEASE_REASONS } = await import('../../hooks/task-lease-lib.mjs');
const { projectKey, planSha256 } = await import('../../hooks/routing-lib.mjs');
const { readIncidents, digestOf } = await import('../../scripts/lib/incident-store.mjs');

/**
 * 造一个临时"项目"：含 .git 占位目录与子目录。
 * @param {string} [name] 临时目录前缀
 */
function makeProject(name = 'rgate-proj-') {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  return realpathSync(root); // 内部任务-337（内部未决-224⑭）：夹具根 realpath 化——下游断言收敛单形态（macOS /var→/private/var）
}

/** 在指定状态目录语境下为本项目签发新挑战并返回 leaseId（meta 透传 issueChallenge）。 */
function freshLease(proj, stateDir, meta) {
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    return issueChallenge(projectKey(proj), meta).leaseId;
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

/**
 * 运行任务租约闸（stdin 喂宿主负载）。
 * @param {string} cwd 负载里的 cwd（Bash 键控与 Edit/Write 回退键）
 * @param {{ stateDir: string, ttlMs?: string, tool?: string, command?: string, sessionId?: string, filePath?: string, incidentRoot?: string, exemptRoot?: string, envPatch?: object }} o 注入缝
 *         （incidentRoot/exemptRoot：A组隔离缝——显式临时 WF_INCIDENT_ROOT/WF_EXEMPTIONS_ROOT，
 *          子进程留痕/审计不落夹具项目根，父进程读同根须自行设 env 并 finally 恢复；
 *          envPatch：末位覆盖缝（内部未决-91）——如双清空 ZCODE_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT）
 */
// 内部任务-331：文件级 env 基线——剥宿主锚 ZCODE_PROJECT_DIR（routing-lib.mjs:334 工作区锚 →
// task-lease-lib.mjs issuanceKeys）。本文件断言 issuanceKeys 的单键形状（「内部任务-24 D3」用例的
// 「单仓 deny 不附清单段」与「内部任务-247 多键 deny 头部窗口」用例的「不附 --project-root／多仓提示」
// 两处负断言），宿主会话注入的真实仓根锚会把键集撑到 ≥2 使负断言翻红。
// 全文件零处有意使用该键；有意键（ZCODE_PLUGIN_ROOT 等）在各 spawn 点照常叠加。
const BASE_ENV = { ...process.env };
delete BASE_ENV.ZCODE_PROJECT_DIR;

function runGate(cwd, o) {
  const tool = o.tool ?? 'Edit';
  const toolInput =
    o.toolInput ??
    (tool === 'Bash' ? { command: o.command ?? 'echo hi' } : { file_path: o.filePath ?? join(cwd, 'a.ts') });
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd, ...(o.sessionId ? { session_id: o.sessionId } : {}), ...(o.payloadPatch ?? {}) }),
    encoding: 'utf8',
    env: {
      ...BASE_ENV,
      ZCODE_PLUGIN_ROOT: resolve(HOOKS, '..'),
      WF_ROUTING_STATE_DIR: o.stateDir,
      ...(o.ttlMs ? { WF_ROUTING_TTL_MS: o.ttlMs } : {}),
      ...(o.incidentRoot ? { WF_INCIDENT_ROOT: o.incidentRoot } : {}),
      ...(o.exemptRoot ? { WF_EXEMPTIONS_ROOT: o.exemptRoot } : {}),
      ...(o.envPatch ?? {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/**
 * 运行声明命令（在项目根 cwd 下）。
 * @param {string} cwd 项目根
 * @param {string} skill 声明的命中 skill 名
 * @param {{ stateDir: string, leaseId?: string, taskId?: string, plan?: string, planRoot?: string, exempt?: string, exemptSrc?: string, exemptScope?: string, exemptRevoke?: boolean, changeScope?: string, ttlMs?: string, incidentRoot?: string, exemptRoot?: string }} o 注入缝
 */
function runDeclare(cwd, skill, o) {
  const leaseId = o.leaseId ?? freshLease(cwd, o.stateDir);
  const args = [skill, '--lease', leaseId, '--task-id', o.taskId ?? 'TASK-1'];
  if (o.plan) args.push('--plan', o.plan);
  if (o.planRoot) args.push('--plan-root', o.planRoot);
  if (o.exempt !== undefined) args.push('--exempt', o.exempt);
  if (o.exemptSrc !== undefined) args.push('--exempt-src', o.exemptSrc);
  if (o.exemptScope !== undefined) args.push('--exempt-scope', o.exemptScope);
  if (o.exemptRevoke === true) args.push('--exempt-revoke');
  if (o.changeScope !== undefined) args.push('--change-scope', o.changeScope);
  if (Array.isArray(o.projectSkills)) for (const ps of o.projectSkills) args.push('--project-skill', ps);
  if (o.projectRoot !== undefined) args.push('--project-root', o.projectRoot); // 内部任务-41：双仓 E2E 键解耦缝（FB-1 透传）
  const r = spawnSync(process.execPath, [DECLARE, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...BASE_ENV,
      WF_ROUTING_STATE_DIR: o.stateDir,
      ...(o.ttlMs ? { WF_ROUTING_TTL_MS: o.ttlMs } : {}),
      ...(o.incidentRoot ? { WF_INCIDENT_ROOT: o.incidentRoot } : {}),
      ...(o.exemptRoot ? { WF_EXEMPTIONS_ROOT: o.exemptRoot } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('无租约 → Edit/Write deny(2)：信封含声明命令与指引', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    for (const tool of ['Edit', 'Write']) {
      const r = runGate(proj, { stateDir, tool });
      assert.equal(r.status, 2, `${tool} 无租约必须阻断`);
      const env = JSON.parse(r.stdout.trim());
      assert.equal(env.hookSpecificOutput?.hookEventName, 'PreToolUse', '信封事件名契约（R-M8-6）');
      assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny');
      const msg = env.hookSpecificOutput?.systemMessage ?? '';
      assert.ok(msg.includes('routing-declare.mjs'), 'deny 文案必须给出可复制的声明命令');
      assert.ok(msg.includes("node '"), '声明命令为单引号包裹形态（OPEN-94：bash/pwsh 双壳零展开）');
      assert.ok(msg.includes("/hooks/routing-declare.mjs'"), '命令路径为正斜杠绝对路径形态（OPEN-13 判别半边——防回退反斜杠）');
      assert.ok(msg.includes('路由表'), '必须指引先查路由表');
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('OPEN-91：env 双清空时闸照常执法（自身位置兜底）——无租约 Edit 仍 deny 且文案为真路径', () => {
  // 行为变更钉子（收敛前 env-only 取根在 env 缺席时 :719 静默放行整闸；收敛后自身位置
  // 优先——运行中插件目录本身就是执法语义的一部分）。空串在 pluginRootDir 候选判定下
  // 等同缺席。
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runGate(proj, { stateDir, tool: 'Edit', envPatch: { ZCODE_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });
    assert.equal(r.status, 2, 'env 缺席而自身位置有效：无租约写面照常 deny（不静默放行）');
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny');
    const msg = env.hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes(`node '${join(realpathSync(resolve(HOOKS, '..')), 'hooks', 'routing-declare.mjs').replaceAll('\\', '/')}'`), `deny 文案命令须为自身位置真路径（单引号闭合形态——OPEN-94；实际：${msg.split('\n')[0] ?? ''}）`);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('OPEN-89 拦截链——ApplyPatch 无租约写面必须被闸拦（ZCode 别名写面工具，deny 同 Edit/Write 形态）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runGate(proj, { stateDir, tool: 'ApplyPatch' });
    assert.equal(r.status, 2, 'ApplyPatch 无租约必须阻断（词表登记前曾归 other 静默放行——OPEN-89 缺陷面）');
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny', 'deny 信封同 Edit/Write 形态');
    assert.ok((env.hookSpecificOutput?.systemMessage ?? '').includes('routing-declare.mjs'), 'deny 文案给出可复制的声明命令');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('无租约 Bash：普通命令 deny；单条声明命令 bootstrap 放行；复合命令 deny', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'printf x > file' }).status, 2);
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"' }).status, 2);
    const boot = runGate(proj, { stateDir, tool: 'Bash', command: `node ${DECLARE} tdd --lease abc --task-id TASK-1` });
    assert.equal(boot.status, 0, '严格单条声明命令必须放行（bootstrap 闭环第一环）');
    assert.equal(boot.stdout.trim(), '', '放行路径无输出');
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: `node ${DECLARE} tdd; touch x` }).status, 2);
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: `node ${DECLARE} tdd | cat` }).status, 2);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('P5 无租约 Bash 链式声明（2026-10-10 DEV-29）：双键两条纯声明拼接放行；拼接混入非声明拒', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const A = `node ${DECLARE} brainstorming --lease t1 --task-id DEV-1`;
    const B = `node ${DECLARE} code-review --lease t2 --task-id TASK-2`;
    const chain = runGate(proj, { stateDir, tool: 'Bash', command: `${A}; ${B}` });
    assert.equal(chain.status, 0, '双键两条纯声明 ; 拼接必须放行（R-M8-9 扩，双仓工作区单条 Bash 合并声明）');
    assert.equal(chain.stdout.trim(), '', '放行路径无输出');
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: `${A} && ${B}` }).status, 0, '&& 拼接同放行');
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: `${A}; ls` }).status, 2, '段内混入非声明命令 → deny');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('只读白名单 -c 收紧与 --output 写面（2026-09-19 评审修复 C1）：git -c 任意配置与写文件参数面均 deny', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 拒绝面：-c 可注入任意配置（diff.external/core.fsmonitor=任意执行面），fail-closed 整拒
    for (const command of [
      'git -c diff.external=node diff',
      'git -c core.fsmonitor=cmd status',
      'git -c core.quotepath=false status',
      'git diff --output=/tmp/x',
      'git show --output=x HEAD',
    ]) {
      assert.equal(
        runGate(proj, { stateDir, tool: 'Bash', command }).status,
        2,
        `git 配置注入/写参数面须 deny：${command}`
      );
    }
    // 回归：-C 目录旗标与常规只读子命令不受收紧影响
    for (const command of ['git -C sub status', 'git log', 'git rev-parse HEAD']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 0, `常规只读形态须放行：${command}`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('无租约 Bash 只读白名单（2026-09-16 使用反馈批次 P8）：只读命令放行、写面与任意代码面仍 deny', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 放行面：纯读命令与 git 只读子命令——研究自由不设硬门（内部决策-3）在 Bash 侧的落地
    for (const command of [
      'ls .',
      'ls -la sub',
      'grep -rn "租约" workflow/hooks',
      'wc -l workflow/hooks/routing-gate.mjs',
      'git status',
      'git log --oneline -5',
      'git diff',
      'date',
      'stat workflow',
      'git describe --tags',
    ]) {
      const r = runGate(proj, { stateDir, tool: 'Bash', command });
      assert.equal(r.status, 0, `只读命令须放行：${command}`);
      assert.equal(r.stdout.trim(), '', '放行路径无输出');
    }
    // 放行不落 lease-deny 留痕（只读用法不是租约异常，不该制造待排查计数）——取证须在
    // 拒面命令之前完成：拒面命令按设计会落留痕，混合计数会让本断言失去鉴别力
    const incidents = readIncidents(proj).filter((r) => r.kind === 'lease-deny');
    assert.equal(incidents.length, 0, '只读放行不得落 lease-deny incident');
    // 拒绝面：写命令、解释器任意代码面、重定向/管道、find 写动作
    for (const command of [
      'echo hi > out.txt',
      'node -e "process.exit(0)"',
      'python -c "print(1)"',
      'git push',
      'ls | wc -l',
      'find . -delete',
      'find . -name x -exec rm {} ;',
      'date -s 12:00',
      'git hash-object -w a.txt',
    ]) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 2, `非白名单命令须 deny：${command}`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('只读白名单安全收口（DEV-244 S01/S03/S06）：引号内命令替换、路径形态命令名、写/执行参数面均 deny', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // S01：双引号内命令替换/反引号在 bash 与 pwsh 中仍执行——必须 deny
    for (const command of ['ls "$(id)"', 'cat "$(echo /etc/passwd)"', 'ls `id`', 'grep -rn "$(pwd)" .']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 2, `双引号内命令替换须 deny：${command}`);
    }
    // 单引号内为字面量 + 双引号内普通元字符（| 等）仍按引号语义放行
    for (const command of ["ls '$(id)'", "grep -rn '$(x)' .", 'grep -E "a|b" .']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 0, `引号内字面量须放行：${command}`);
    }
    // S03：命令名路径形态（仓内/远端可执行文件冒充系统命令）—— deny
    for (const command of ['./ls', 'sub/ls', 'C:/repo/ls.exe', '//host/share/ls', '/usr/bin/ls', './grep x .']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 2, `路径形态命令名须 deny：${command}`);
    }
    // S06：白名单命令的写/执行参数面 + 长选项缩写 + xxd 写面（阶段门安全评审）—— deny
    for (const command of ['xxd -r in out', 'xxd --revert in out', 'xxd a.bin', 'sort --compress-program=/bin/sh a', 'sort -T /tmp a', 'sort --temporary-directory=/tmp a', 'sort --out=/p a', 'sort --compress-prog=/bin/sh a', 'sort --temp=/tmp a']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 2, `写/执行参数面须 deny：${command}`);
    }
    // 阶段门安全评审阻塞 1：嵌套引号内的命令替换 / 转义单引号外露的 $() —— deny
    for (const command of ["ls \"'$(id)'\"", "ls \\'$(id)\\'"]) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 2, `引号嵌套命令替换须 deny：${command}`);
    }
    // 回归：正常只读形态放行
    for (const command of ['ls -la', 'sort a.txt', 'grep -rn "租约" workflow']) {
      assert.equal(runGate(proj, { stateDir, tool: 'Bash', command }).status, 0, `正常只读形态须放行：${command}`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('声明激活后 → 本 prompt 内静默放行；输出含 skill 与 learnings 指引', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 内部任务-75：本用例承载「激活即放行」的通用租约语义，改用非基线写面 skill——
    // root-cause-debugging 现带 SKILL_WRITE_FLOOR 语义（Edit 默认目标 a.ts 会被拦），
    // 该 skill 的专属行为由 内部任务-75 基线写面三用例承载。
    const d = runDeclare(proj, 'brainstorming', { stateDir });
    assert.equal(d.status, 0);
    assert.ok(d.stdout.includes('brainstorming'), '声明确认须回显 skill 名');
    assert.ok(d.stdout.includes('learnings'), '激活输出须含 learnings 检索指引（R-M6-7）');
    // OPEN 检索提醒行（内部规则-21 / 内部接口-8 §7.1 消费面义务）——learnings 行同层端到端
    assert.ok(d.stdout.includes('【OPEN 检索】'), '激活输出须含【OPEN 检索】提醒行（R-M8-21）');
    assert.ok(d.stdout.includes('specs/open-items.md'), 'OPEN 提醒行须含登记册路径 specs/open-items.md');
    assert.ok(d.stdout.includes('IF-COLLAB-8'), 'OPEN 提醒行须指向义务载体 IF-COLLAB-8');
    assert.ok(d.stdout.includes('按任务域检索'), 'OPEN 提醒行须含「按任务域检索」——相关性匹配防哨位骚扰的核心限定（A-M8-23 锚点集，检查点①补）');
    // P1 端到端（评审发现：只断言 helper 函数时，删掉 main 里的接线仍全绿——这里是
    // 「删接线即红」的那一层）
    assert.ok(
      d.stdout.includes('skills/brainstorming/SKILL.md'),
      '声明成功输出须含「读正文」指针行（P1）',
    );
    for (const tool of ['Edit', 'Write', 'Bash']) {
      const r = runGate(proj, { stateDir, tool, command: 'touch x' });
      assert.equal(r.status, 0, `${tool} 持当前租约放行`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('下一 prompt 轮换（会话桶强形态）：新挑战签发后旧租约对闸失效', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const leaseId = freshLease(proj, stateDir, { sessionId: 'sess-r1' });
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, leaseId }).status, 0);
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-r1' }).status, 0, '当前 prompt 放行');
    freshLease(proj, stateDir, { sessionId: 'sess-r1' }); // 本会话新挑战轮换
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-r1' }).status, 2, '会话桶旧租约随本会话轮换失效');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('子目录写操作上溯共享项目根租约；项目间隔离', () => {
  const a = makeProject('rgate-a-');
  const b = makeProject('rgate-b-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(a, 'brainstorming', { stateDir });
    assert.equal(runGate(join(a, 'sub'), { stateDir }).status, 0, '子目录须命中同一项目键');
    assert.equal(runGate(b, { stateDir }).status, 2, '项目 B 无租约必须独立拦截');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('会话隔离：双边 sessionId 可见且不同 → 不得复用租约', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      issueChallenge(projectKey(proj), { sessionId: 'sess-1' });
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    // 经完整声明命令激活（租约继承挑战的 sessionId）
    const leaseId = (() => {
      const p2 = process.env.WF_ROUTING_STATE_DIR;
      process.env.WF_ROUTING_STATE_DIR = stateDir;
      try {
        return issueChallenge(projectKey(proj), { sessionId: 'sess-1' }).leaseId;
      } finally {
        if (p2 === undefined) delete process.env.WF_ROUTING_STATE_DIR;
        else process.env.WF_ROUTING_STATE_DIR = p2;
      }
    })();
    runDeclare(proj, 'brainstorming', { stateDir, leaseId });
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-1' }).status, 0, '同会话放行');
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-2' }).status, 2, '他会话不得复用');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('TTL 到点 → 重新 deny；垃圾负载 fail-open', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(proj, 'brainstorming', { stateDir, ttlMs: '1' });
    assert.equal(runGate(proj, { stateDir }).status, 2, '租约过期不得放行');
    const r = spawnSync(process.execPath, [GATE], {
      input: '{{{ not-json',
      encoding: 'utf8',
      env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir },
    });
    assert.equal(r.status, 0);
    assert.equal((r.stdout ?? '').trim(), '', 'fail-open 无输出');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('挑战过期 deny 文案：不回收过期令牌（W1）且附补签指引（W2①）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 健康声明后过期挑战（长会话真实形态：交互期间跨过挑战 TTL）
    runDeclare(proj, 'brainstorming', { stateDir });
    const kd = createHash('sha256').update(projectKey(proj)).digest('hex').slice(0, 16);
    const ptr = JSON.parse(readFileSync(join(stateDir, `wf-lease-current-${kd}-null.json`), 'utf8'));
    const chFile = join(stateDir, `wf-lease-challenge-${ptr.leaseId}.json`);
    const actFile = join(stateDir, `wf-lease-active-${ptr.leaseId}.json`);
    const ch = JSON.parse(readFileSync(chFile, 'utf8'));
    ch.expiresAt = Date.now() - 5000;
    writeFileSync(chFile, JSON.stringify(ch));
    // 内部任务-LEASEGATE-1 F2 对照：仅挑战过期而租约自身未过期——扫描回退救回（lease 是
    // 自洽 capability，挑战过期只门控激活不回收已声明租约；两 TTL 现实仅差声明延迟秒级）。
    // 探针用写命令 touch（内部任务-ROCMD-1 后 echo 入只读白名单，租约语义对白名单命令失去鉴别力）
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' }).status, 0, '租约未过期仍放行');
    // 双过期（长会话完整形态）：deny + 补签指引
    const act = JSON.parse(readFileSync(actFile, 'utf8'));
    act.expiresAt = Date.now() - 5000;
    writeFileSync(actFile, JSON.stringify(act));
    const r = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2, '挑战与租约双过期须 deny');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('挑战已过期'), '失效原因必须标注');
    assert.ok(msg.includes('--bootstrap-reissue'), '过期场景附补签指引（W2①：可执行出路）');
    assert.ok(msg.includes('行内取'), '过期令牌不得回收进「本轮 leaseId」（W1）——落占位分支等新挑战');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('非仓目录（无 .git 祖先）：Bash/Edit/Write 静默放行、不落 lease-deny incident（2026-09-15 激活域）', () => {
  const nonRepo = mkdtempSync(join(tmpdir(), 'rgate-norepo-')); // 不放 .git
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    for (const tool of ['Bash', 'Edit', 'Write']) {
      const r = runGate(nonRepo, { stateDir, tool, command: 'echo hi' });
      assert.equal(r.status, 0, `${tool} 非仓目录静默放行`);
      assert.equal(r.stdout.trim(), '', '静默=零输出');
    }
    // bootstrap 面随短路关闭：非仓目录连"声明命令形态"的 Bash 也放行（整套静默的推论）
    const boot = runGate(nonRepo, { stateDir, tool: 'Bash', command: `node ${DECLARE} tdd --lease ab --task-id T-1` });
    assert.equal(boot.status, 0, '非仓目录不保留 bootstrap 拦截面');
    assert.equal(projIncidentsOf(nonRepo).length, 0, 'deny 短路在留痕之前：零 lease-deny incident');
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 加固批次（2026-09-13）：B2 闸 deny 留痕 / A2 指针悬空细分 / D3 撞号警告 / D1-cd 形态 ──

/** 直读项目根自察记录（闸 deny 留痕落 <项目根>/内部工作流状态）——
 *  直接复用 incident-store 读侧（同 id 末条胜出语义，评审 S4：不手抄第二份）。 */
function projIncidentsOf(proj) {
  return readIncidents(proj);
}

test('闸 deny 落 lease-deny incident：含 reason 与键摘要，同 reason 同键同分钟幂等', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r1 = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r1.status, 2);
    const recs1 = projIncidentsOf(proj).filter((d) => d.kind === 'lease-deny');
    assert.equal(recs1.length, 1, 'deny 必须留痕一条 lease-deny');
    assert.ok(String(recs1[0].digest ?? '').length >= 8, '记录含键/原因摘要（R-M15-2 只存 digest）');
    assert.ok(!JSON.stringify(recs1[0]).includes('状态缺失或损坏') || String(recs1[0].reason ?? '').length > 0, '记录带失效原因');
    runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    const recs2 = projIncidentsOf(proj).filter((d) => d.kind === 'lease-deny');
    assert.ok(recs2.length >= 1 && recs2.length <= 2, '二次 deny 至多多落一个分钟桶');
    // 幂等判据绑定「同分钟桶」——id 内嵌 Math.floor(Date.now()/60000)（routing-gate.mjs:386，
    // 防 deny 风暴刷记录的设计语义）：两次调用被墙钟分钟边界劈开时桶不同、2 条记录属预期行为。
    // 故断言 1 条必须在「同桶内完成的一对调用」上取证：整对在独立项目上重放，跨桶即换新项目重试
    // （单次调用约百毫秒，60s 桶内一次命中概率极高；上限 5 次防死循环，连续跨桶即失败可见）。
    let sameBucketVerified = false;
    for (let attempt = 0; attempt < 5 && !sameBucketVerified; attempt += 1) {
      const proj2 = makeProject();
      try {
        const bucket = Math.floor(Date.now() / 60000);
        runGate(proj2, { stateDir, tool: 'Bash', command: 'touch x' });
        runGate(proj2, { stateDir, tool: 'Bash', command: 'touch x' });
        if (Math.floor(Date.now() / 60000) !== bucket) continue; // 跨桶：本尝试记录不构成幂等证据
        const recs3 = projIncidentsOf(proj2).filter((d) => d.kind === 'lease-deny');
        assert.equal(recs3.length, 1, '同 reason 同键同分钟桶幂等（deny 风暴不刷记录）');
        sameBucketVerified = true;
      } finally {
        rmSync(proj2, { recursive: true, force: true });
      }
    }
    assert.ok(sameBucketVerified, '未能取得同分钟桶内的幂等证据（连续 5 对调用全跨桶属异常）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('指针悬空（A2 细分）：current 在但挑战文件缺失 → deny 文案专属指引', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const ch = freshLease(proj, stateDir); // 写挑战 + current 指针
    const keyDigest = createHash('sha256').update(projectKey(proj)).digest('hex').slice(0, 16);
    const ptr = JSON.parse(readFileSync(join(stateDir, `wf-lease-current-${keyDigest}-null.json`), 'utf8'));
    rmSync(join(stateDir, `wf-lease-challenge-${ptr.leaseId}.json`), { force: true }); // 挑战没了、指针还在
    const r = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2, '悬空指针不得放行');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('指针悬空'), '须给出指针悬空专属 reason（非笼统「损坏」）');
    assert.ok(msg.includes('重新签发'), '须指引等待下一条用户消息重新签发');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('task-id 撞号（OPEN-76 升级阻断）：异会话同 task-id 声明 → 激活失败 exit 1 含阻断文案与建议号', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const chA = freshLease(proj, stateDir, { sessionId: 'sess-A' });
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, leaseId: chA, taskId: 'DEV-9' }).status, 0);
    const chB = freshLease(proj, stateDir, { sessionId: 'sess-B' });
    const r = runDeclare(proj, 'code-review', { stateDir, leaseId: chB, taskId: 'DEV-9' });
    assert.equal(r.status, 1, '撞号即阻断（OPEN-76，原「警告不阻断」形态废止）');
    assert.ok(r.stderr.includes('撞号阻断'), 'stderr 含阻断文案');
    assert.ok(r.stderr.includes('DEV-9'), '文案点名撞号 task-id');
    assert.ok(r.stderr.includes('延续本任务') && r.stderr.includes('取最小未用号'), '含双路指引（P8：延续同号/取最小未用号分诊——DEV-117 稠密措辞）');
    assert.ok(/声明于 \d{4}-\d{2}-\d{2}T/.test(r.stderr), '含对方声明时间证据');
    assert.ok(r.stderr.includes('DEV-1'), '含建议号（DEV-117 稠密：git 源空 → 最小未用 1）');
    assert.ok(!r.stderr.includes('最新一轮用户消息的租约行'), '不附「重取 leaseId」误导句（同令牌换号即可重试）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bootstrap 放行 cd <绝对路径> && node 声明命令（D1：A1 死锁的第一出路）', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const chN = freshLease(nested, stateDir); // 嵌套仓键的挑战
    const boot = runGate(root, {
      stateDir,
      tool: 'Bash',
      command: `cd ${nested} && node ${DECLARE} tdd --lease ${chN} --task-id TASK-1`,
    });
    assert.equal(boot.status, 0, 'cd 两段形态必须放行（声明键随进程 cwd 切到嵌套仓）');
    // 闸放行 ≠ 命令已执行：等价复现 cd 后的声明（进程 cwd=嵌套仓），再验租约生效
    const decl = spawnSync(
      process.execPath,
      [DECLARE, 'brainstorming', '--lease', chN, '--task-id', 'TASK-1'],
      { cwd: nested, encoding: 'utf8', env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir } },
    );
    assert.equal(decl.status, 0, '嵌套仓键的声明成功（等价于 cd 后执行）');
    assert.equal(runGate(nested, { stateDir, tool: 'Bash', command: 'touch x' }).status, 0, '嵌套仓租约已激活');
    // 负例：cd 形态携带的非声明命令仍拒
    assert.equal(runGate(root, { stateDir, tool: 'Bash', command: `cd ${nested} && rm -rf x` }).status, 2, '第二段非声明命令拒绝');
    assert.equal(runGate(root, { stateDir, tool: 'Bash', command: `cd / && node ${DECLARE} tdd | cat` }).status, 2, '第二段带管道拒绝');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('OPEN-10：cd 双引号包裹的含空白目标放行（含空白仓路径的嵌套声明）', () => {
  const { root, nested } = makeNestedProject();
  const spaced = join(root, 'dir with space', 'nested'); // 含空白仓路径（Windows 常见形态）
  mkdirSync(dirname(spaced), { recursive: true });
  cpSync(nested, spaced, { recursive: true });
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const chS = freshLease(spaced, stateDir);
    const fwd = spaced.split('\\').join('/');
    const boot = runGate(root, {
      stateDir,
      tool: 'Bash',
      command: `cd "${fwd}" && node ${DECLARE} tdd --lease ${chS} --task-id TASK-2`,
    });
    assert.equal(boot.status, 0, '引号包裹的含空白 cd 目标必须放行（OPEN-10）');
    // 负例：同一目标裸写（无引号）仍拒——deny 文案须引导双引号形态而非误指复合命令
    const bare = runGate(root, {
      stateDir,
      tool: 'Bash',
      command: `cd ${fwd} && node ${DECLARE} tdd --lease ${chS} --task-id TASK-2`,
    });
    assert.equal(bare.status, 2);
    const bareMsg = JSON.parse(bare.stdout).hookSpecificOutput.systemMessage;
    assert.ok(bareMsg.includes('双引号'), 'deny 文案含双引号指引（OPEN-10 hint 分支）');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('declare 参数校验：缺 skill/缺 --lease/缺 --task-id/坏 leaseId → 退出 1 不解锁闸', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const leaseId = freshLease(proj, stateDir);
  try {
    const badInvocations = [
      [DECLARE],
      [DECLARE, 'Not A Name!'],
      [DECLARE, 'brainstorming', '--task-id', 'TASK-1'], // 缺 --lease
      [DECLARE, 'brainstorming', '--lease', 'zzzz', '--task-id', 'TASK-1'], // 坏 leaseId
      [DECLARE, 'brainstorming', '--lease', leaseId], // 缺 --task-id
    ];
    for (const argv of badInvocations) {
      const r = spawnSync(process.execPath, argv, {
        cwd: proj,
        encoding: 'utf8',
        env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir },
      });
      assert.notEqual(r.status, 0, `非法参数组合必须失败可见：${argv.join(' ')}`);
    }
    assert.equal(runGate(proj, { stateDir }).status, 2, '失败的声明不得解锁闸');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── R3 回归（2026-09-14 终审）：漏写 skill 时旗标值不得误当 skill ──

test('漏写 skill：--lease 的 hex 值（首字符 a-f 恰配 SKILL_NAME_RE）不得被误当 skill 激活', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 无位置参数、leaseId 为合法 hex 形态：现实现 find(!startsWith('--')) 会把
    // '--lease' 的值 'f12abc0000000000' 误当 skill 继续走激活流程（报租约激活失败
    // 而非缺 skill）；正确行为是走缺 skill 报错路径
    const r = spawnSync(process.execPath, [DECLARE, '--lease', 'f12abc0000000000', '--task-id', 'TASK-1'], {
      cwd: proj,
      encoding: 'utf8',
      env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir },
    });
    assert.equal(r.status, 1, '无 skill 必须退出 1');
    assert.ok((r.stderr ?? '').includes('skill'), '报错须点名 skill（缺 skill 路径，而非激活失败路径）');
    assert.equal(runGate(proj, { stateDir }).status, 2, '失败的声明不得解锁闸');
    // 对照：正常形态（skill 在旗标前）不受解析改动影响
    const leaseId = freshLease(proj, stateDir);
    const ok = spawnSync(process.execPath, [DECLARE, 'brainstorming', '--lease', leaseId, '--task-id', 'TASK-1'], {
      cwd: proj,
      encoding: 'utf8',
      env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir },
    });
    assert.equal(ok.status, 0, 'skill 在前的正常形态照常激活');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── plan-execution 前置（内部规则-10：显式计划 + v2 sidecar 绑定）──

/**
 * 造一份 v2 评审 sidecar（默认与计划内容/taskId 绑定一致）。
 * @param {string} proj 项目根
 * @param {{ taskId?: string, pass?: boolean, mutatePlanAfter?: boolean, legacy?: boolean }} [o]
 */
function writeV2Artifact(proj, o = {}) {
  const dir = join(proj, 'docs', 'plans');
  mkdirSync(dir, { recursive: true });
  const planRel = 'docs/plans/feature-x.md';
  writeFileSync(join(proj, planRel), '---\nspecRefs: [FR-wf-1]\n---\n# 计划\n');
  if (o.legacy) {
    writeFileSync(join(proj, 'docs', 'plans', 'feature-x-review.md'), '# 评审记录\n\n结论：通过\n');
    return planRel;
  }
  const fm = [
    '---', 'schemaVersion: 2', `taskId: ${o.taskId ?? 'TASK-7'}`, `planPath: ${planRel}`,
    `planSha256: ${planSha256(join(proj, planRel))}`, 'reviewedAt: 2026-09-13T00:00:00+08:00',
    `reviewMode: ${o.reviewMode ?? 'self'}`, `reviewInstances: ${o.reviewInstances ?? 0}`, 'reviewReason: "routing-gate 夹具"', '---', '',
  ].join('\n');
  writeFileSync(join(proj, 'docs', 'plans', 'feature-x-review.md'), `${fm}结论：${o.pass === false ? '不通过' : '通过'}\n`);
  if (o.mutatePlanAfter) writeFileSync(join(proj, planRel), '---\nspecRefs: [FR-wf-1]\n---\n# 计划改\n');
  return planRel;
}

/** 内部任务-191：造 v3 sidecar（reviewRound + reviewProvenance；独立/mixed 强制形态）。 */
function writeV3Artifact(proj, o = {}) {
  const dir = join(proj, 'docs', 'plans');
  mkdirSync(dir, { recursive: true });
  const planRel = 'docs/plans/feature-x.md';
  writeFileSync(join(proj, planRel), '---\nspecRefs: [FR-wf-1]\n---\n# 计划\n');
  const taskId = o.taskId ?? 'TASK-7';
  const chain = `plan:${planRel}`;
  const prov = [
    { role: 'engineering', instance: 'eng-1', chain, state: 'fresh' },
    { role: 'ceo', instance: 'ceo-1', chain, state: 'fresh' },
  ];
  const fm = [
    '---', 'schemaVersion: 3', `taskId: ${taskId}`, `planPath: ${planRel}`,
    `planSha256: ${planSha256(join(proj, planRel))}`, 'reviewedAt: 2026-10-21T00:00:00+08:00',
    'reviewMode: independent', 'reviewInstances: 2', 'reviewReason: "routing-gate v3 夹具"',
    'reviewRound: 1', `reviewProvenance: ${JSON.stringify(prov)}`, '---', '',
  ].join('\n');
  writeFileSync(join(dir, 'feature-x-review.md'), `${fm}结论：${o.pass === false ? '不通过' : '通过'}\n`);
  return planRel;
}

test('plan-execution 无 --plan → 拒绝（不再扫描任意通过记录）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    writeV2Artifact(proj);
    const r = runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7' });
    assert.notEqual(r.status, 0, '缺显式计划必须拒绝');
    assert.ok(r.stderr.includes('--plan'), '拒绝文案须指出 --plan 要求');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('v2 sidecar 一致 → 放行且租约绑定计划哈希', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const planRel = writeV2Artifact(proj);
    const r = runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel });
    assert.equal(r.status, 0, 'v2 凭据一致应放行');
    assert.ok(r.stdout.includes('计划凭据已绑定'), '确认输出须回显绑定');
    assert.equal(runGate(proj, { stateDir }).status, 0);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-191：v3 sidecar（round1 + provenance）→ 放行；v2 independent → 拒绝并给 v3 迁移文案', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    let planRel = writeV3Artifact(proj);
    const ok = runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel });
    assert.equal(ok.status, 0, `v3 凭据应放行（stderr：${ok.stderr}）`);
    assert.ok(ok.stdout.includes('计划凭据已绑定'));
    planRel = writeV2Artifact(proj, { reviewMode: 'independent', reviewInstances: 2 });
    const bad = runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel });
    assert.notEqual(bad.status, 0, 'v2 independent 必须拒绝');
    assert.match(bad.stderr, /schemaVersion: 3|reviewProvenance/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('评审后计划被修改 / legacy sidecar / 结论不通过 / taskId 不符 → 拒绝', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    let planRel = writeV2Artifact(proj, { mutatePlanAfter: true });
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel }).status, 0, '哈希失配须拒');
    planRel = writeV2Artifact(proj, { legacy: true });
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel }).status, 0, 'legacy 须拒');
    planRel = writeV2Artifact(proj, { pass: false });
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-7', plan: planRel }).status, 0, '不通过须拒');
    planRel = writeV2Artifact(proj, {});
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-8', plan: planRel }).status, 0, 'taskId 不符须拒');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt 引文正形与 scope 必填（R-M1-12）：旧理由摘要/缺 scope 拒；逐字流程引文+scope 放行；仅限 plan-execution', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const old = runDeclare(proj, 'plan-execution', { stateDir, exempt: '用户口头批准的紧急止血', exemptSrc: 'user' });
    assert.notEqual(old.status, 0, '旧自由文本理由（缺 scope/未点名流程面）必须拒');
    assert.match(old.stderr, /--exempt-scope/, '拒因须给迁移三件套');
    const r = runDeclare(proj, 'plan-execution', {
      stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan',
    });
    assert.equal(r.status, 0, '合法 scope/引文应放行');
    assert.match(r.stdout, /scope=plan/, '确认输出须标明 scope');
    assert.equal(runGate(proj, { stateDir }).status, 0, '豁免租约对闸有效');
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.ok(d.valid && d.lease.exempt === '不用写计划，直接修', '逐字引文必须写入租约留痕');
      assert.equal(d.lease.exemptScope, 'plan');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    assert.notEqual(
      runDeclare(proj, 'brainstorming', { stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan' }).status,
      0,
      '豁免仅限 plan-execution',
    );
    const r2 = runDeclare(proj, 'plan-execution', { stateDir, exempt: '', exemptScope: 'plan' });
    assert.notEqual(r2.status, 0, '空理由不构成显式豁免');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 协议扩展（2026-09-14，内部决策-020/内部接口-20）：--change-scope / --exempt-src / 豁免审计 ──

test('--change-scope 非法输入：非 JSON / ".." 段 / 绝对路径 → 退出 1 不解锁闸', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    for (const bad of ['not-json', '["../x"]', '["/abs"]']) {
      const r = runDeclare(proj, 'brainstorming', { stateDir, changeScope: bad });
      assert.notEqual(r.status, 0, `非法 change-scope 必须拒绝：${bad}`);
      assert.ok(r.stderr.includes('--change-scope'), `拒绝文案须点名旗标：${bad}`);
    }
    assert.equal(runGate(proj, { stateDir }).status, 2, '失败的声明不得解锁闸');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--change-scope 合法：重复条目去重后单条入租约', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runDeclare(proj, 'brainstorming', { stateDir, changeScope: '["docs/plans","docs/plans"]' });
    assert.equal(r.status, 0, '合法 change-scope 声明应成功');
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.ok(d.valid, '租约有效');
      assert.deepEqual(d.lease.changeScope, ['docs/plans'], '去重后单条写入租约');
      // 2026-09-19 评审修复：超面 deny 文案须渲染实际 leaseId（扩面重声明用的正是它）
      // 内部任务-5 A组修正：旧误参 file→filePath（runGate 只读 filePath，误参时实际测的是
      // 缺省 a.ts——碰巧同拒但断言对象失真，总计划步骤 2「修旧 file 误参」）
      const tok = d.lease.leaseId;
      const g = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'outside-scope.txt') });
      assert.equal(g.status, 2, '超面写操作须 deny');
      assert.ok(g.stdout.includes(tok), `超面 deny 文案须含本轮实际令牌（期望 ${tok}）`);
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt 来源标注：缺 --exempt-src / 非法 src / 无 --exempt 的悬空 src → 退出 1', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    let r = runDeclare(proj, 'plan-execution', { stateDir, exempt: '用户当轮已批准' }); // 缺 src
    assert.notEqual(r.status, 0, '豁免缺来源标注必须拒绝');
    assert.ok(r.stderr.includes('user') && r.stderr.includes('preauthorized'), '须给出枚举指引 user|preauthorized');
    r = runDeclare(proj, 'plan-execution', { stateDir, exempt: '用户当轮已批准', exemptSrc: 'bogus' });
    assert.notEqual(r.status, 0, '非法来源必须拒绝');
    assert.ok(r.stderr.includes('user') && r.stderr.includes('preauthorized'), '非法来源同样给枚举指引');
    r = runDeclare(proj, 'brainstorming', { stateDir, exemptSrc: 'user' }); // 悬空 src：无 --exempt
    assert.notEqual(r.status, 0, '无 --exempt 的悬空 --exempt-src 必须拒绝');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt + scope plan：租约含 exemptScope/引文，审计 v2 落盘', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runDeclare(proj, 'plan-execution', {
      stateDir,
      taskId: 'TASK-7',
      exempt: '不用写计划，直接修',
      exemptSrc: 'user',
      exemptScope: 'plan',
    });
    assert.equal(r.status, 0, '合法 scope/引文豁免声明应成功');
    assert.equal(runGate(proj, { stateDir }).status, 0, '豁免租约对闸有效');
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.ok(
        d.valid && d.lease.exempt === '不用写计划，直接修'
          && d.lease.exemptSrc === 'user' && d.lease.exemptScope === 'plan',
        '租约含 exempt/exemptSrc/exemptScope 留痕',
      );
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    const auditText = readFileSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), 'utf8');
    const audit = auditText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      .filter((x) => x.taskId === 'TASK-7');
    assert.equal(audit.length, 1, '豁免审计恰好一条');
    assert.equal(audit[0].schemaVersion, 2);
    assert.equal(audit[0].src, 'user');
    assert.equal(audit[0].reason, '不用写计划，直接修');
    assert.equal(audit[0].scope, 'plan');
    assert.equal(audit[0].skill, 'plan-execution');
    assert.equal('planPath' in audit[0], false);
    assert.ok(audit[0].id.startsWith('ex-') && audit[0].digest.length === 12, 'id=ex-<digest12>');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt-revoke：用户撤销原话+已评审计划；租约回普通 plan-execution；负例拒', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const planRel = writeV2Artifact(proj, { taskId: 'TASK-9' });
    const ex = runDeclare(proj, 'plan-execution', {
      stateDir, taskId: 'TASK-9', exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan',
    });
    assert.equal(ex.status, 0, '先有合法豁免声明');
    const rv = runDeclare(proj, 'plan-execution', {
      stateDir, taskId: 'TASK-9', exemptRevoke: true,
      exempt: '撤销计划豁免，按正常评审计划走', exemptSrc: 'user', plan: planRel,
    });
    assert.equal(rv.status, 0, '显式退役应成功');
    assert.match(rv.stdout, /豁免退役已留痕/);
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.ok(d.valid);
      assert.equal(d.lease.exempt, undefined, '退役租约不携带 exempt');
      assert.equal(d.lease.exemptScope, undefined, '退役租约不携带 exemptScope');
      assert.equal(d.lease.planPath, planRel, '退役声明绑定已评审计划');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    const audit = readFileSync(join(proj, '.workflow', 'wf-exemptions.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      .filter((x) => x.taskId === 'TASK-9');
    const revoked = audit.filter((x) => x.scope === 'revoked');
    assert.equal(revoked.length, 1, '退役记录恰好一条');
    assert.equal(revoked[0].src, 'user');
    assert.equal(revoked[0].reason, '撤销计划豁免，按正常评审计划走');
    assert.equal(revoked[0].schemaVersion, 2);
    // 负例：缺计划/带 scope/src 非法
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-9', exemptRevoke: true, exempt: '撤销计划豁免', exemptSrc: 'user' }).status, 0);
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-9', exemptRevoke: true, exempt: '撤销计划豁免', exemptSrc: 'user', plan: planRel, exemptScope: 'plan' }).status, 0);
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, taskId: 'TASK-9', exemptRevoke: true, exempt: '撤销计划豁免', exemptSrc: 'bogus', plan: planRel }).status, 0);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt scope 与引文声明矩阵：目标引文拒/scope 必填/review 需计划+marker/plan 禁计划与 plan-root/审计失败回滚', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    for (const quote of ['继续', '先处理 X 再处理 Y', '逐项修复']) {
      const r = runDeclare(proj, 'plan-execution', { stateDir, exempt: quote, exemptSrc: 'user', exemptScope: 'plan' });
      assert.notEqual(r.status, 0, `目标/推进引文必须拒：${quote}`);
    }
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user' }).status, 0, '缺 scope 拒');
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'bogus' }).status, 0, '非法 scope 拒');
    const dangling = runDeclare(proj, 'plan-execution', { stateDir, exemptScope: 'plan' });
    assert.notEqual(dangling.status, 0, '悬空 scope（无 --exempt）拒');
    assert.match(dangling.stderr, /--exempt-scope 必须与 --exempt/, '悬空 scope 拒因须点名成对约束');
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, exempt: '跳过评审直接做', exemptSrc: 'user', exemptScope: 'review' }).status, 0, 'review 缺计划拒');
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan', plan: 'docs/plans/x.md' }).status, 0, 'plan 带计划拒');
    assert.notEqual(runDeclare(proj, 'plan-execution', { stateDir, exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan', planRoot: proj }).status, 0, 'plan 带 plan-root 拒');
    const plansDir = join(proj, 'docs', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'review-plan.md'), '---\nspecRefs: [FR-wf-1]\n---\n# P\n\n豁免引文：跳过评审直接做\n');
    const review = runDeclare(proj, 'plan-execution', {
      stateDir, exempt: '跳过评审直接做', exemptSrc: 'user', exemptScope: 'review', plan: 'docs/plans/review-plan.md',
    });
    assert.equal(review.status, 0, review.stderr || 'review scope + 计划 marker 放行');
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.equal(d.lease.exemptScope, 'review');
      assert.equal(d.lease.planPath, 'docs/plans/review-plan.md');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    // 审计写失败 → 回滚、无 active 租约（独立状态根，避免前序 review 租约干扰）
    const failStateDir = mkdtempSync(join(tmpdir(), 'rgate-state-fail-'));
    const blocker = join(proj, 'blocker');
    writeFileSync(blocker, 'x');
    const failed = runDeclare(proj, 'plan-execution', {
      stateDir: failStateDir, taskId: 'TASK-2', exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan', exemptRoot: blocker,
    });
    assert.notEqual(failed.status, 0, '审计写失败 fail-closed');
    assert.match(failed.stderr, /豁免审计失败|无留痕不豁免/, '拒因须点名审计失败/无留痕不豁免');
    process.env.WF_ROUTING_STATE_DIR = failStateDir;
    try {
      const d = readActiveLease(projectKey(proj));
      assert.equal(d.valid, false, '回滚后无有效租约');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
      rmSync(failStateDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--exempt-scope 前置解析：旗标在 skill 前不把 scope 值当 skill（悬空 scope 仍拒）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const leaseId = freshLease(proj, stateDir);
    const r = spawnSync(process.execPath, [
      DECLARE, '--exempt-scope', 'plan', 'plan-execution', '--lease', leaseId, '--task-id', 'TASK-1',
    ], {
      cwd: proj,
      encoding: 'utf8',
      env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir },
    });
    assert.notEqual(r.status, 0, '悬空 scope 仍须拒');
    assert.match(r.stderr, /--exempt-scope 必须与 --exempt/, '拒因须点名成对约束');
    assert.doesNotMatch(r.stderr, /skill 名非法/, 'VALUE_FLAGS 消费 scope 值，不得把 plan 当 skill');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('其他 skill 声明不受计划前置影响（无 plans 目录照常）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    assert.equal(runDeclare(proj, 'root-cause-debugging', { stateDir }).status, 0, '前置校验仅作用于 plan-execution');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部决策-016/018：deny 按失效原因分流（mismatch 分支经 legacy v2 状态构造——
//     v3 per-session 协议下他会话桶对观察者不可见，mismatch 仅在 null 桶解析到
//     带 sessionId 的旧租约时触发，即纵深防御 + 旧状态兼容路径）──

/** 写一对 legacy v2 项目级状态文件（challenge + active，sessionId 内嵌 sess-1）。 */
function writeLegacyMismatchState(proj, stateDir, mutateActive) {
  const digest = createHash('sha256').update(projectKey(proj)).digest('hex').slice(0, 16);
  const now = Date.now();
  const challenge = { leaseId: 'legacy0000000001', projectKey: projectKey(proj), sessionId: 'sess-1', promptEpoch: 3, issuedAt: now, expiresAt: now + 3600000 };
  const active = { leaseId: 'legacy0000000001', projectKey: projectKey(proj), sessionId: 'sess-1', taskId: 'TASK-9', skill: 'tdd', promptEpoch: 3, declaredAt: now, issuedAt: now, expiresAt: now + 3600000 };
  if (mutateActive) mutateActive(active);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `wf-lease-challenge-${digest}.json`), JSON.stringify(challenge));
  writeFileSync(join(stateDir, `wf-lease-active-${digest}.json`), JSON.stringify(active));
}

test('会话不匹配（legacy 路径）→ deny 明示重复声明无效+诊断字段，不再给注定无效的声明指引', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 旧 v2 单文件状态：租约内嵌 sess-1，闸以 sess-2 观察 → 纵深防御判他会话
    writeLegacyMismatchState(proj, stateDir);
    const r = runGate(proj, { stateDir, sessionId: 'sess-2' });
    assert.equal(r.status, 2, '他会话租约必须拦截');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('重复声明无效'), 'ADR-016：必须明示同令牌重声明无效');
    assert.ok(msg.includes('skill=tdd') && msg.includes('TASK-9') && msg.includes('declaredAt='), '必须附诊断字段 skill/taskId/declaredAt');
    assert.ok(!msg.includes('routing-declare.mjs'), '不得再给注定无效的声明命令指引');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('会话不匹配且租约 declaredAt 损坏（缺失）→ 诊断回退「未知」，deny 不因异常放行', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    writeLegacyMismatchState(proj, stateDir, (active) => {
      delete active.declaredAt; // 半损坏：可解析但缺 declaredAt
    });
    const r = runGate(proj, { stateDir, sessionId: 'sess-2' });
    assert.equal(r.status, 2, '损坏诊断字段不得使 deny 翻转为放行');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('declaredAt=未知') && msg.includes('重复声明无效'), '诊断字段回退「未知」且分支文案保持');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('其余失效原因 → deny 含原因标注且保留声明命令', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(proj, 'brainstorming', { stateDir, ttlMs: '0' });
    const r = runGate(proj, { stateDir });
    assert.equal(r.status, 2, '过期租约必须拦截');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('失效原因：'), '必须标注原因前缀');
    assert.ok(msg.includes('routing-declare.mjs'), '该场景重声明正确，保留声明命令');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--selftest 自检入口（B-M8-4）：闸与声明脚本各自可达', () => {
  for (const script of [GATE, DECLARE]) {
    const r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${script} --selftest 应通过`);
    assert.ok((r.stdout ?? '').includes('OK'), `${script} --selftest 应输出 OK`);
  }
});

// ── 内部决策-018：per-session 租约端到端 ──

test('双会话端到端：A、B 各自声明后写操作同时放行；A 的新 prompt 只拦 A', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const chA = freshLease(proj, stateDir, { sessionId: 'sess-A' });
    const chB = freshLease(proj, stateDir, { sessionId: 'sess-B' });
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, leaseId: chA, taskId: 'TASK-1' }).status, 0);
    assert.equal(runDeclare(proj, 'code-review', { stateDir, leaseId: chB, taskId: 'TASK-2' }).status, 0);
    // 双方同时持有效租约：各自的闸都放行
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'touch x', sessionId: 'sess-A' }).status, 0, 'A 写放行');
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'touch x', sessionId: 'sess-B' }).status, 0, 'B 写同时放行');
    // A 的新 prompt（签发新挑战）：只拦 A，B 不受影响
    freshLease(proj, stateDir, { sessionId: 'sess-A' });
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-A' }).status, 2, 'A 随本会话轮换被拦');
    assert.equal(runGate(proj, { stateDir, sessionId: 'sess-B' }).status, 0, 'B 仍放行');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('null 桶端到端（ADR-018 修正案 2026-09-22）：轮换后闸放行（扫描回退，TASK-LEASEGATE-1）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const leaseId = freshLease(proj, stateDir); // 双侧不可见
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, leaseId }).status, 0);
    assert.equal(runGate(proj, { stateDir }).status, 0, '无观察会话标识走 null 桶放行');
    freshLease(proj, stateDir); // null 桶轮换（可能是任一无标识会话的消息）
    assert.equal(runGate(proj, { stateDir }).status, 0, 'null 桶弱形态：轮换不吊销，扫描回退放行');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 嵌套 git 仓键控与 deny 诊断（2026-09-13 调试闭环：任务租约嵌套仓死锁等三缺陷）──

/** 造一个含嵌套 git 仓的项目：root/.git + root/docs/nested/.git（文档仓场景）。 */
function makeNestedProject() {
  const root = makeProject('rgate-nested-outer-');
  const nested = join(root, 'docs', 'nested');
  mkdirSync(join(nested, '.git'), { recursive: true });
  return { root, nested };
}

test('Edit/Write 键控按 file_path：cwd 落嵌套仓、文件在主仓 → 主仓租约放行', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(root, 'brainstorming', { stateDir });
    for (const tool of ['Edit', 'Write']) {
      const r = runGate(nested, { stateDir, tool, filePath: join(root, 'a.ts') });
      assert.equal(r.status, 0, `${tool} 文件在主仓须命中主仓租约（不跟 shell cwd）`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('编辑嵌套仓文件按嵌套仓键拦截：主仓租约不跨仓放行', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(root, 'brainstorming', { stateDir });
    const r = runGate(root, { stateDir, tool: 'Edit', filePath: join(nested, 'b.md') });
    assert.equal(r.status, 2, '嵌套仓文件须按嵌套仓键各自声明');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('W5 回归锁（2026-09-16 批次）：嵌套仓键租约不跨仓放行主仓文件——键控按文件归属仓', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(nested, 'brainstorming', { stateDir }); // 声明键=嵌套仓
    const r = runGate(nested, { stateDir, tool: 'Edit', filePath: join(root, 'a.ts') });
    assert.equal(r.status, 2, '嵌套仓租约不得放行主仓文件——键控按 tool_input.file_path 的 git 祖先，不跟声明键/会话 cwd');
    // 主仓文件放行路径已由「Edit/Write 键控按 file_path」既有用例覆盖，此处不重复
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Bash cwd 落嵌套仓 → deny 含跨键诊断（当前键 vs 最近成功声明键）与可执行指引', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(root, 'brainstorming', { stateDir });
    const r = runGate(nested, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('失效原因：状态缺失或损坏'), '须标注失效原因');
    const fwdNested = nested.split('\\').join('/'); // 内部未决-13：诊断键路径输出正斜杠形态
    const fwdRoot = root.split('\\').join('/');
    assert.ok(msg.includes(fwdNested), '诊断须给出当前键（嵌套仓根）');
    assert.ok(msg.includes(fwdRoot), '诊断须给出最近成功声明键（主仓根）');
    assert.ok(msg.includes('cd 回') && msg.includes('重新'), '诊断须给可执行指引（cd 回主仓根 / 当前仓重新声明）');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('挑战未激活 + 跨键诊断挂载（TASK-LEASEATT-1）：嵌套键已签发未声明 → deny 家族呈现双键指引', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(root, 'brainstorming', { stateDir }); // 主仓声明成功 → recentKey=主仓
    freshLease(nested, stateDir); // 嵌套键只签发不声明（active 从未写入）
    const r = runGate(nested, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('失效原因：挑战未激活'), '须标注新失效原因');
    const fwdNested = nested.split('\\').join('/');
    const fwdRoot = root.split('\\').join('/');
    assert.ok(msg.includes(fwdNested), '诊断须给出当前键（嵌套仓根）');
    assert.ok(msg.includes(fwdRoot), '诊断须给出最近成功声明键（主仓根）');
    assert.ok(msg.includes('cd 回') && msg.includes('重新'), '「无有效态」家族同挂可执行指引');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('本键从未签发过挑战 → deny 提示签发 hook 未运行（不指引抄不存在的令牌）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('签发'), '须提示挑战签发侧异常');
    assert.ok(msg.includes('检查 hooks 配置'), '须指引检查 hooks 配置（不得用路径里天然存在的 hooks 字样充当断言）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-103 F2（内部任务-111 修复）：具名桶租约 + 无/异会话标识 → deny 不误指「从未签发」 ──
test('具名桶租约 + 无/异 session_id → deny 会话隔离诊断（不误指从未签发）；真无签发仍原文案（DEV-103 F2）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const leaseId = freshLease(proj, stateDir, { sessionId: 'sess-holder' });
    const d = runDeclare(proj, 'brainstorming', { stateDir, leaseId, taskId: 'DEV-911' });
    assert.equal(d.status, 0, '播种：持有会话声明成功（具名桶租约在场）');
    // 形态 a：负载无 session_id（内部任务-103 探针 g4/g5 同形态）
    const a = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' });
    assert.equal(a.status, 2, '保护面不变：会话隔离照旧 deny（RC-1）');
    const msgA = JSON.parse(a.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(!msgA.includes('从未签发过任务挑战'), '不得误指从未签发（租约一直在，DEV-103 F2）');
    assert.ok(msgA.includes('未携带会话标识'), '须给会话标识缺失诊断');
    assert.ok(msgA.includes('task=DEV-911'), '须渲染持有租约的任务号（leaseNote 接线钉，DEV-111 评审发现 1）');
    // 形态 b：负载带他会话标识
    const b = runGate(proj, { stateDir, tool: 'Bash', command: 'touch x', sessionId: 'sess-other' });
    assert.equal(b.status, 2);
    const msgB = JSON.parse(b.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(!msgB.includes('从未签发过任务挑战'), '桶不一致形态同样不得误指从未签发');
    assert.ok(msgB.includes('与租约所在会话桶不一致'), '须给会话桶不一致诊断');
    assert.ok(msgB.includes('task=DEV-911'), '桶不一致形态同样渲染 leaseNote（DEV-111 评审发现 1）');
    // 负例：真·无签发（独立项目零播种）仍走原文案
    const proj2 = makeProject();
    const stateDir2 = mkdtempSync(join(tmpdir(), 'rgate-state-'));
    try {
      const n = runGate(proj2, { stateDir: stateDir2, tool: 'Bash', command: 'touch x' });
      assert.equal(n.status, 2);
      const msgN = JSON.parse(n.stdout.trim()).hookSpecificOutput.systemMessage;
      assert.ok(msgN.includes('从未签发过任务挑战'), '真无签发保留原文案（正例对照）');
      assert.ok(!msgN.includes('未携带会话标识'), '无租约在场不得挂会话隔离诊断');
    } finally {
      rmSync(proj2, { recursive: true, force: true });
      rmSync(stateDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-103 F2（内部任务-111）：扫描失败态不变量——recentKey undefined 时两门同闭，键控诊断整体不出 ──
test('state 根不可读（ENOTDIR）→ deny 照常且零键控诊断（扫描失败不出诊断，DEV-103 F2）', () => {
  const proj = makeProject();
  const stateFile = join(tmpdir(), 'rgate-state-file-'); // 文件占位状态根：readdir ENOTDIR → recentDeclaredProjectKey 返 undefined
  try {
    writeFileSync(stateFile, '{}');
    const r = runGate(proj, { stateDir: stateFile, tool: 'Bash', command: 'touch x' });
    assert.equal(r.status, 2, 'deny 主职责不变（fail-open 不适用：负载健康而凭据不成立）');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(!msg.includes('键控诊断'), '扫描失败态不得出任何键控诊断（跨键/从未签发/会话隔离三族全闭）');
    assert.ok(!msg.includes('从未签发过任务挑战') && !msg.includes('未携带会话标识'), '两诊断分支均不得误挂');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
});

// ── 内部任务-24 D3：双/多键工作区 deny 逐键声明状态清单 ──

test('DEV-24 D3：双仓工作区无有效态 deny 附逐键状态清单；单仓不附', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 主仓声明成功、嵌套仓仅签发未声明（同会话 sess-D3 视角）
    const chM = freshLease(root, stateDir, { sessionId: 'sess-D3' });
    assert.equal(runDeclare(root, 'brainstorming', { stateDir, leaseId: chM, taskId: 'TASK-1' }).status, 0);
    freshLease(nested, stateDir, { sessionId: 'sess-D3' });
    const r = runGate(nested, { stateDir, tool: 'Bash', command: 'touch x', sessionId: 'sess-D3' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('已签发键清单'), '双键工作区 deny 须附清单段（D3）');
    const fwdRoot = root.split('\\').join('/');
    const fwdNested = nested.split('\\').join('/');
    assert.ok(msg.includes(`${fwdRoot}：已声明`), '主仓行=已声明');
    assert.ok(msg.includes(`${fwdNested}：已签发未声明`), '嵌套仓行=已签发未声明');
    assert.ok(msg.includes(`（本操作执法键）`), '执法键须标注');
    // 对照：单仓工作区同款 deny 不附清单（噪音控制）
    const proj = makeProject();
    const stateDir2 = mkdtempSync(join(tmpdir(), 'rgate-state-'));
    try {
      freshLease(proj, stateDir2);
      const r1 = runGate(proj, { stateDir: stateDir2, tool: 'Bash', command: 'touch x' });
      assert.equal(r1.status, 2);
      const msg1 = JSON.parse(r1.stdout.trim()).hookSpecificOutput.systemMessage;
      assert.ok(!msg1.includes('已签发键清单'), '单仓 deny 不附清单段');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(stateDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-247 F1/F2：纯 cd 逃生通道与多键 deny 头部执法键提示 ──

test('纯 cd 无租约 Bash 放行（DEV-247 逃生通道）', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rgate-inc-'));
  try {
    // 无任何声明、cwd 落嵌套仓（执法键=嵌套仓）：纯 cd 回主仓根须 exit 0 静默放行
    // （不落 lease-deny、无输出）——多仓 cwd 漂移的逃生通道语义。
    // 内部任务-250（2026-10-28 win32 回归修复）：目标路径以**单引号字面量**传入——内部规则-14/内部验收-34
    // 已登记词法规定裸/双引号反斜杠按转义归一后非绝对路径（Windows 反斜杠路径须单引号）；
    // POSIX 单引号同样合法，跨平台同形。并补 内部验收-35「不落 lease-deny」留痕断言（隔离
    // WF_INCIDENT_ROOT，避免读真实账本）。
    const cdTarget = `cd '${root}'`;
    const r = runGate(nested, { stateDir, incidentRoot, tool: 'Bash', command: cdTarget });
    assert.equal(r.status, 0, '纯 cd 绝对路径须放行（白名单第三面）');
    assert.equal(r.stdout.trim(), '', '放行路径无输出（信封契约）');
    assert.equal(
      // 内部任务-250 round2 复审 F1：读面须在显式 WF_INCIDENT_ROOT 语境下（同文件 readIncidentsAt 惯例）——
      // incident-store 读根 `process.env.WF_INCIDENT_ROOT ?? root` 优先，直接 readIncidents(incidentRoot)
      // 在测试进程带该 env 时会读错账本（误红/真空通过）。
      readIncidentsAt(incidentRoot, nested).filter((rec) => rec.kind === 'lease-deny').length,
      0,
      '放行路径不落 lease-deny 留痕（A-M8-35）',
    );
    // 对照：复合/相对形态仍 deny(2)
    assert.equal(runGate(nested, { stateDir, incidentRoot, tool: 'Bash', command: `${cdTarget} && pwd` }).status, 2, '复合形态拒');
    assert.equal(runGate(nested, { stateDir, incidentRoot, tool: 'Bash', command: 'cd ..' }).status, 2, '相对路径拒');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('多键 deny 头部窗口含执法键提示与 --project-root（DEV-247）', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 复用 D3 场景：主仓已声明、嵌套仓已签发未声明（本操作执法键=嵌套仓）
    const chM = freshLease(root, stateDir, { sessionId: 'sess-F2' });
    assert.equal(runDeclare(root, 'brainstorming', { stateDir, leaseId: chM, taskId: 'TASK-1' }).status, 0);
    freshLease(nested, stateDir, { sessionId: 'sess-F2' });
    const r = runGate(nested, { stateDir, tool: 'Bash', command: 'touch x', sessionId: 'sess-F2' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    const fwd = nested.split('\\').join('/'); // makeProject 已 realpath 化——单形态（内部任务-337，内部未决-224⑭）
    // 头部窗口（宿主截断尾部的 P7 语义）：执法键短提示必须落在前 300 字符内
    assert.ok(msg.slice(0, 300).includes('执法键'), '头部窗口含执法键提示');
    assert.ok(msg.slice(0, 300).includes(fwd), '头部窗口含执法键路径');
    // 声明命令附 --project-root 实参形态（带引号——锚 cmd 拼接而非提示行自述文字，防假绿）
    assert.ok(msg.includes(`--project-root '${fwd}'`), '头部声明命令附执法键 --project-root');
    // 尾部清单保留（D3 既有断言面不回归）
    assert.ok(msg.includes('已签发键清单'), '尾部逐键清单保留');
    // 对照：单键面逐字节不变——deny 消息不附 --project-root
    const proj = makeProject();
    const stateDir2 = mkdtempSync(join(tmpdir(), 'rgate-state-'));
    try {
      freshLease(proj, stateDir2);
      const r1 = runGate(proj, { stateDir: stateDir2, tool: 'Bash', command: 'touch x' });
      assert.equal(r1.status, 2);
      const msg1 = JSON.parse(r1.stdout.trim()).hookSpecificOutput.systemMessage;
      assert.ok(!msg1.includes('--project-root'), '单键 deny 不附 --project-root');
      assert.ok(!msg1.includes('多仓提示'), '单键 deny 不附多仓提示');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(stateDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Bash 声明命令带管道/链式 → deny 追加「严格解析声明命令」明确提示（P5 扩后含顺序拼接口径）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runGate(proj, {
      stateDir,
      tool: 'Bash',
      command: `node ${DECLARE} tdd --lease abc --task-id TASK-1 | tail`,
    });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('管道') || msg.includes('链式'), '须明示被拒原因是附加了管道/链式');
    assert.ok(msg.includes('严格解析') && msg.includes('顺序拼接'), '须给出可执行提示（2026-10-10 DEV-29：旧「纯净单命令」措辞随链式放行面扩而废止）');
    // 非声明命令含元字符：主因是无租约而非元字符，不追加「去管道即可过闸」的死路指引
    const r2 = runGate(proj, { stateDir, tool: 'Bash', command: 'ls | grep x' });
    const msg2 = JSON.parse(r2.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(!msg2.includes('去掉非声明部分'), '普通复合命令不得附加声明命令专用提示（hint 专属短语；gateNote 通用头部不在判据内）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('文件无 .git 祖先但 cwd 是仓：按 cwd 仓键控仍拦；文件与 cwd 均非仓：静默放行（2026-09-15 激活域）', () => {
  const proj = makeProject();
  const outside = mkdtempSync(join(tmpdir(), 'rgate-outside-')); // 不放 .git
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 文件在仓外、会话在仓内：跟随 cwd 仓键控（不得把文件目录当键）
    const inRepo = runGate(proj, { stateDir, tool: 'Edit', filePath: join(outside, 'a.ts') });
    assert.equal(inRepo.status, 2, 'cwd 是仓即生效：无租约仍拦');
    // 文件与 cwd 均非仓：整套静默
    const bothOut = runGate(outside, { stateDir, tool: 'Edit', filePath: join(outside, 'sub', 'b.ts') });
    assert.equal(bothOut.status, 0, '均非仓静默放行');
    assert.equal(projIncidentsOf(outside).length, 0, '非仓零 lease-deny 留痕');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── Phase 3（2026-09-14，内部决策-020/内部接口-20）：闸侧 change-scope 执行（写面判定）──

test('声明成员校验：表外名拒绝（文案列候选），ad-hoc 保留名放行且租约归因可区分（2026-09-15 激活域批次）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const bad = runDeclare(proj, 'bogus-skill', { stateDir });
    assert.equal(bad.status, 1, '表外 skill 名必须拒绝（B-M1-1 机械兜底）');
    assert.ok(bad.stderr.includes('路由表'), '拒绝文案指引先查路由表');
    assert.ok(bad.stderr.includes('ad-hoc'), '拒绝文案列出保留名候选');
    assert.ok(bad.stderr.includes('plan-execution'), '拒绝文案列候选入口');
    const okAdhoc = runDeclare(proj, 'ad-hoc', { stateDir });
    assert.equal(okAdhoc.status, 0, 'ad-hoc 保留名放行（非开发任务显式绕行）');
    assert.ok(okAdhoc.stdout.includes('ad-hoc'), '确认文案标注 ad-hoc 语义');
    // readActiveLease 在父进程直调：须注入 WF_ROUTING_STATE_DIR（freshLease 同款模式）
    const prevDir = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    let lease;
    try {
      lease = readActiveLease(projectKey(proj));
    } finally {
      if (prevDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevDir;
    }
    assert.ok(lease.valid && lease.lease.skill === 'ad-hoc', '租约 skill 落 ad-hoc（自察归因可区分）');
    const gate = runGate(proj, { stateDir, tool: 'Edit' });
    assert.equal(gate.status, 0, 'ad-hoc 租约照常放行写操作');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bootstrap-reissue 自愈（2026-09-16 使用反馈批次 P9b）：目标仓完成声明后补签留痕转 resolved', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 预置：一条 open bootstrap-reissue（补签自救路径落下的审计留痕）+ 一条无关 open 作对照
    const now = Date.now();
    const mk = (id, kind, status) =>
      JSON.stringify({ schemaVersion: 1, id, ts: now, session: 'sess-x', taskId: null, skill: null, plugin: 'workflow', kind, tool: null, event: null, digest: `dg${id}`.slice(0, 16), status });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(
      join(proj, '.workflow', 'incidents.jsonl'),
      [mk('br-heal-1', 'bootstrap-reissue', 'open'), mk('tf-other-1', 'tool-failure', 'open')].join('\n') + '\n',
    );
    runDeclare(proj, 'plan-writing', { stateDir });
    const byId = Object.fromEntries(projIncidentsOf(proj).map((x) => [x.id, x]));
    assert.equal(byId['br-heal-1'].status, 'resolved', '补签留痕在目标仓完成声明后自愈——否则长期挂 open 制造待排查提醒');
    assert.ok(String(byId['br-heal-1'].note).includes('自愈'), '解决备注含自愈留痕');
    assert.equal(byId['tf-other-1'].status, 'open', '无关 kind 不受自愈影响');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('lease-deny 自愈：声明成功把本项目 open 租约拒绝留痕批量转 resolved（2026-09-15 激活域批次）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 预置：两条 open lease-deny + 一条 open tool-failure + 一条 triaged lease-deny
    const now = Date.now();
    const mk = (id, kind, status) =>
      JSON.stringify({ schemaVersion: 1, id, ts: now, session: 'sess-x', taskId: null, skill: null, plugin: 'workflow', kind, tool: 'Bash', event: null, digest: `dg${id}`.slice(0, 16), status });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(
      join(proj, '.workflow', 'incidents.jsonl'),
      [mk('ld-heal-1', 'lease-deny', 'open'), mk('ld-heal-2', 'lease-deny', 'open'), mk('tf-heal-1', 'tool-failure', 'open'), mk('ld-heal-3', 'lease-deny', 'triaged')].join('\n') + '\n',
    );
    // 先制造一次真实 deny（这条新留痕同样参与自愈），再走「deny → 声明成功」闭环
    assert.equal(runGate(proj, { stateDir, tool: 'Edit' }).status, 2, '无租约先拦');
    runDeclare(proj, 'brainstorming', { stateDir });
    assert.equal(runGate(proj, { stateDir }).status, 0, '声明后放行');
    const byId = Object.fromEntries(projIncidentsOf(proj).map((x) => [x.id, x]));
    assert.equal(byId['ld-heal-1'].status, 'resolved', '预置 open lease-deny 被自愈');
    assert.equal(byId['ld-heal-2'].status, 'resolved');
    assert.ok(String(byId['ld-heal-1'].note).includes('自愈'), '解决备注含自愈留痕');
    assert.equal(byId['tf-heal-1'].status, 'open', '非 lease-deny 不动');
    assert.equal(byId['ld-heal-3'].status, 'triaged', 'triaged 不回退');
    const liveDeny = projIncidentsOf(proj).filter((d) => d.kind === 'lease-deny' && d.status === 'open');
    assert.equal(liveDeny.length, 0, '含本轮 deny 新留痕在内全部 open lease-deny 归零');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-LEASEGATE-1（2026-09-22）：lease-loop 升级通道（内部规则-13 ④）──

test('lease-loop 升级：同 (session,digest) 窗内 resolved ≥2 再 deny → 追加不可自愈升级记录', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 预置两轮 open→resolved 振荡（行级，同 (session,digest) 签名——与闸 deny 留痕同款字段）
    const kd = digestOf([String(projectKey(proj))]);
    const dg = digestOf(['lease-deny', '状态缺失或损坏', kd]);
    const now = Date.now();
    const line = (i, status) =>
      JSON.stringify({ schemaVersion: 1, id: `ld-pre-${i}`, ts: now, session: 'default', taskId: null, skill: null, plugin: 'workflow', kind: 'lease-deny', tool: 'Bash', event: null, digest: dg, status });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(
      join(proj, '.workflow', 'incidents.jsonl'),
      [line(1, 'open'), line(2, 'resolved'), line(3, 'open'), line(4, 'resolved')].join('\n') + '\n',
    );
    const r = runGate(proj, { stateDir, tool: 'Edit' }); // 第三次 deny：升级
    assert.equal(r.status, 2, 'deny 照常执法');
    const loops = projIncidentsOf(proj).filter((d) => d.kind === 'lease-loop');
    assert.equal(loops.length, 1, '升级恰追加一条 lease-loop');
    assert.equal(loops[0].status, 'open', '升级记录 open——不可自愈、计入待排查');
    // 声明自愈不吞 lease-loop（内部规则-13 ④：升级信号必须人工 incident-cli 处置）
    runDeclare(proj, 'brainstorming', { stateDir });
    for (const x of projIncidentsOf(proj)) {
      if (x.kind === 'lease-loop') assert.equal(x.status, 'open', `lease-loop（${x.id}）不入自愈面`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('lease-loop 不误报：无振荡历史（resolved <2）的 deny 不升级', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const kd = digestOf([String(projectKey(proj))]);
    const dg = digestOf(['lease-deny', '状态缺失或损坏', kd]);
    const now = Date.now();
    const line = (i, status) =>
      JSON.stringify({ schemaVersion: 1, id: `ld-quiet-${i}`, ts: now, session: 'default', taskId: null, skill: null, plugin: 'workflow', kind: 'lease-deny', tool: 'Bash', event: null, digest: dg, status });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'incidents.jsonl'), [line(1, 'open'), line(2, 'resolved')].join('\n') + '\n');
    assert.equal(runGate(proj, { stateDir, tool: 'Edit' }).status, 2, 'deny 照常执法');
    assert.equal(projIncidentsOf(proj).filter((d) => d.kind === 'lease-loop').length, 0, '仅一轮自愈历史不构成振荡，不升级');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('deny 留痕根=执法键（cwd 非仓而文件在仓：incident 落文件仓，非仓 cwd 零垃圾，ADR-022）', () => {
  const proj = makeProject();
  const outside = mkdtempSync(join(tmpdir(), 'rgate-outside2-')); // cwd：非仓
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    const r = runGate(outside, { stateDir, tool: 'Edit', filePath: join(proj, 'a.ts') });
    assert.equal(r.status, 2, '文件在仓即执法：cwd 非仓仍拦');
    assert.ok(projIncidentsOf(proj).some((d) => d.kind === 'lease-deny'), '留痕落执法键（文件所在仓）');
    assert.equal(readIncidents(outside).length, 0, '非仓 cwd 不落 .workflow 垃圾');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('写面判定：面内放行（根级/子目录/相对路径按 cwd 解析），超面 deny 含写面指引', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, changeScope: '["docs/plans"]' }).status, 0, '带写面的声明应激活');
    assert.equal(
      runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'docs', 'plans', 'x.md') }).status,
      0,
      '面内根级文件放行',
    );
    assert.equal(
      runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'docs', 'plans', 'sub', 'y.md') }).status,
      0,
      '面子目录文件按条目目录前缀放行',
    );
    assert.equal(
      runGate(proj, { stateDir, tool: 'Write', filePath: 'docs/plans/z.md' }).status,
      0,
      '相对 file_path 须按负载 cwd 解析到面内放行',
    );
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'workflow', 'hooks', 'z.mjs') });
    assert.equal(r.status, 2, '超面写必须拦截');
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny', '信封仍走 deny 契约（R-M8-6）');
    const msg = env.hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('写面'), 'deny 文案须含写面提示（scopeHint）');
    assert.ok(msg.includes('--change-scope'), '须给出以 --change-scope 重声明写面的出路');
    assert.ok(msg.includes('workflow/hooks/z.mjs'), '须点名未覆盖的目标相对路径');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('无 change-scope 的租约 → Edit 任意路径照常放行（向后兼容）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(proj, 'brainstorming', { stateDir }); // 不带 --change-scope
    assert.equal(
      runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'workflow', 'hooks', 'z.mjs') }).status,
      0,
      '无写面声明的租约保持全仓放行（旧协议租约不受影响）',
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('嵌套仓：写面相对嵌套仓键根求值（与键控同源），面内放行、仓内面外拦', () => {
  const { root, nested } = makeNestedProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    mkdirSync(join(nested, 'docs', 'plans'), { recursive: true });
    runDeclare(nested, 'brainstorming', { stateDir, changeScope: '["docs/plans"]' }); // 声明键=嵌套仓根
    const r = runGate(root, { stateDir, tool: 'Edit', filePath: join(nested, 'docs', 'plans', 'x.md') });
    assert.equal(r.status, 0, 'cwd 在主仓不影响：写面须按 leaseKey（嵌套仓根）求值，不得按 cwd 求值');
    const r2 = runGate(root, { stateDir, tool: 'Edit', filePath: join(nested, 'src', 'a.ts') });
    assert.equal(r2.status, 2, '嵌套仓内面外文件仍须拦截');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('目标在键仓外（rel 以 .. 开头）→ deny：越界等同超面', () => {
  const proj = makeProject();
  const outside = mkdtempSync(join(tmpdir(), 'rgate-outside-')); // 无 .git：Edit 键回退负载 cwd
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(proj, 'brainstorming', { stateDir, changeScope: '["docs/plans"]' });
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(outside, 'x.md') });
    assert.equal(r.status, 2, '目标解析到键仓之外必须拦截');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('写面'), '越界 deny 同样给出写面指引');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── R2 回归（2026-09-14 终审）：键仓内 `..` 前缀文件名是合法文件，不得误判越界 ──

test('键仓内 .. 前缀文件名：面声明覆盖该文件 → 放行（不得以越界误拦）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    // 条目 '..draft.md' 无 .. 路径段（split('/') 后是单个非 '..' 段），是合法写面条目
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, changeScope: '["..draft.md"]' }).status, 0, '声明应激活');
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, '..draft.md') });
    assert.equal(r.status, 0, '面内 .. 前缀文件名必须放行——它没有逃出键仓，只是文件名以 .. 开头');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('键仓内 .. 前缀文件名：面未覆盖 → 以超面语义 deny（文案含写面指引，点名相对路径）', () => {
  const proj = makeProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    runDeclare(proj, 'brainstorming', { stateDir, changeScope: '["docs/plans"]' });
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, '..draft.md') });
    assert.equal(r.status, 2, '面未覆盖仍须 deny');
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(msg.includes('写面') && msg.includes('--change-scope'), '按超面语义给写面指引');
    assert.ok(msg.includes('..draft.md'), '点名未覆盖的目标相对路径');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── A组（2026-10-06 内部任务-5，F12 规划阶段写面边界）──────────────────────────────
// 契约（总计划「A 规则与规划阶段边界」）：plan-writing/plan-review 健康租约的 Edit/Write
// 仅允许 PLAN_DIRS（docs/plans 与 legacy docs/superpowers/plans，含子目录）下 .md 文件；
// canonical 化后相对键归一，链接逃逸/目录/非 md 拒；固定上界 AND 可选 changeScope——
// []/["."]/宽面不扩权、空交集不放行；旧租约（legacy v2 同会话、v3 null 扫描回退）同检；
// --plan-root 不构成跨仓写许可；Bash 不受上界（明示不是 shell 沙箱）；deny 复用信封/
// exit 2/留痕，专属 authoring 文案不携带 --change-scope 扩面尾句（与通用写面拒隔离）。
// 隔离纪律（总计划步骤 2）：子进程一律注入临时 WF_INCIDENT_ROOT/WF_EXEMPTIONS_ROOT，
// 父进程读同根并 finally 恢复——零真实台账污染、夹具项目根零 .workflow 垃圾。

/** 造规划夹具项目：makeProject 基础上补规划目录族（含 legacy 目录）与越界目标。 */
function makePlanProject(name = 'rgate-plan-') {
  const proj = makeProject(name);
  mkdirSync(join(proj, 'docs', 'plans', 'sub'), { recursive: true });
  mkdirSync(join(proj, 'docs', 'superpowers', 'plans', 'deep'), { recursive: true });
  mkdirSync(join(proj, 'specs'), { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'AGENTS.md'), '# agents\n');
  return proj;
}

/** 隔离根对（incident/exemption 同 home）——A组子进程注入与父进程读取共用。 */
function makeIsoRoots(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return { home, incidentRoot: join(home, 'inc'), exemptRoot: join(home, 'exem') };
}

/** 父进程在指定 WF_INCIDENT_ROOT 语境下读事件记录（finally 恢复 env，不污染进程）。 */
function readIncidentsAt(incidentRoot, proj) {
  const prev = process.env.WF_INCIDENT_ROOT;
  process.env.WF_INCIDENT_ROOT = incidentRoot;
  try {
    return readIncidents(proj);
  } finally {
    if (prev === undefined) delete process.env.WF_INCIDENT_ROOT;
    else process.env.WF_INCIDENT_ROOT = prev;
  }
}

/** 写一对 legacy v2 项目级状态文件（skill 可指定，sessionId 内嵌 sess-L1——同会话观察有效）。 */
function writeLegacyPlanState(proj, stateDir, skill) {
  const digest = createHash('sha256').update(projectKey(proj)).digest('hex').slice(0, 16);
  const now = Date.now();
  const challenge = { leaseId: 'legacy0000000001', projectKey: projectKey(proj), sessionId: 'sess-L1', promptEpoch: 3, issuedAt: now, expiresAt: now + 3600000 };
  const active = { leaseId: 'legacy0000000001', projectKey: projectKey(proj), sessionId: 'sess-L1', taskId: 'TASK-5', skill, promptEpoch: 3, declaredAt: now, issuedAt: now, expiresAt: now + 3600000 };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `wf-lease-challenge-${digest}.json`), JSON.stringify(challenge));
  writeFileSync(join(stateDir, `wf-lease-active-${digest}.json`), JSON.stringify(active));
}

test('A组 规划租约合法面（守卫）：PLAN_DIRS 下 .md 放行——根级/子目录/legacy 目录/相对路径；null 桶', () => {
  const proj = makePlanProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a1-');
  try {
    const d = runDeclare(proj, 'plan-writing', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot });
    assert.equal(d.status, 0, 'plan-writing 声明应成功（无计划前置，仅 plan-execution 有）');
    const cases = [
      ['Edit', join(proj, 'docs', 'plans', 'x.md')],
      ['Write', join(proj, 'docs', 'plans', 'sub', 'y.md')],
      ['Edit', join(proj, 'docs', 'superpowers', 'plans', 'hist.md')],
      ['Write', join(proj, 'docs', 'superpowers', 'plans', 'deep', 'z.md')],
    ];
    for (const [tool, fp] of cases) {
      assert.equal(runGate(proj, { stateDir, tool, filePath: fp, incidentRoot: iso.incidentRoot }).status, 0, `${tool} 面内 ${fp} 须放行`);
    }
    assert.equal(
      runGate(proj, { stateDir, tool: 'Write', filePath: 'docs/plans/rel.md', incidentRoot: iso.incidentRoot }).status,
      0,
      '相对 file_path 按负载 cwd 解析到面内放行',
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 规划租约越界拒绝：AGENTS/specs/src/非md/目录/面外md → exit 2 信封点名目标与三段流向，无扩面尾句', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a2-');
  const projects = [];
  try {
    for (const skill of ['plan-writing', 'plan-review']) {
      const p = makePlanProject(skill === 'plan-writing' ? 'rgate-pw-' : 'rgate-pr-');
      projects.push(p);
      const d = runDeclare(p, skill, { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot });
      assert.equal(d.status, 0, `${skill} 声明应成功`);
      const targets = [
        join(p, 'AGENTS.md'),
        join(p, 'specs', 'IF-COLLAB-1.md'),
        join(p, 'src', 'a.ts'),
        join(p, 'docs', 'plans', 'notes.txt'),
        join(p, 'docs', 'other.md'),
        join(p, 'docs', 'plans'), // 目录本身不是合法写目标
      ];
      for (const tool of ['Edit', 'Write']) {
        for (const fp of targets) {
          const r = runGate(p, { stateDir, tool, filePath: fp, incidentRoot: iso.incidentRoot });
          assert.equal(r.status, 2, `${skill} ${tool} 越界目标须 deny：${fp}`);
        }
      }
      const r = runGate(p, { stateDir, tool: 'Edit', filePath: join(p, 'AGENTS.md'), incidentRoot: iso.incidentRoot });
      assert.equal(r.status, 2, '信封取证前提：越界 deny');
      const env = JSON.parse(r.stdout.trim());
      assert.equal(env.hookSpecificOutput?.hookEventName, 'PreToolUse', '信封事件名契约（R-M8-6）');
      assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny');
      const msg = env.hookSpecificOutput?.systemMessage ?? '';
      assert.ok(msg.includes('AGENTS.md'), `专属文案须点名越界目标路径（skill=${skill}）`);
      assert.ok(
        msg.includes('plan-writing') && msg.includes('plan-review') && msg.includes('plan-execution'),
        `文案须给出 plan-writing→plan-review→plan-execution 流向指引（skill=${skill}）`,
      );
      assert.ok(!msg.includes('--change-scope'), `专属 authoring 拒绝不携带 --change-scope 扩面尾句（skill=${skill}）`);
      assert.ok(!msg.includes('扩面'), `不得引导以扩面绕过固定上界（skill=${skill}）`);
    }
  } finally {
    for (const p of projects) rmSync(p, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 规划写面 AND 语义：[]/["."]/宽面不扩权；空交集不放行；面内交集放行', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a3-');
  const projects = [];
  try {
    const cases = [
      { scope: '[]', plans: 2, src: 2 }, // 空数组不得退化为全仓放行：交集为空，全拒
      { scope: '["."]', plans: 0, src: 2 }, // 根条目＝上界本身：面内放行、面外仍拒
      { scope: '["docs","src"]', plans: 0, src: 2 }, // 宽面与上界求交：src 条目不能扩权
      { scope: '["docs/specs"]', plans: 2, src: 2 }, // 与上界空交集：面内目标也拒
    ];
    for (const c of cases) {
      const p = makePlanProject();
      projects.push(p);
      const d = runDeclare(p, 'plan-writing', { stateDir, changeScope: c.scope, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot });
      assert.equal(d.status, 0, `scope=${c.scope} 声明应成功（规范化面不拒合法条目）`);
      assert.equal(
        runGate(p, { stateDir, tool: 'Edit', filePath: join(p, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot }).status,
        c.plans,
        `scope=${c.scope} 面内目标（期望 ${c.plans === 0 ? '放行' : '拒绝'}）`,
      );
      assert.equal(
        runGate(p, { stateDir, tool: 'Edit', filePath: join(p, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
        c.src,
        `scope=${c.scope} 固定上界外目标必须拒绝（宽面不扩权）`,
      );
    }
    // 文案分流：面内越 scope 的拒绝不是固定上界问题——保留 --change-scope 扩面出路（通用写面语义）
    const p4 = projects[3];
    const rIn = runGate(p4, { stateDir, tool: 'Edit', filePath: join(p4, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot });
    assert.ok(JSON.parse(rIn.stdout.trim()).hookSpecificOutput.systemMessage.includes('--change-scope'), '面内越 scope 拒绝保留扩面出路');
    // 固定上界外的目标走专属文案：不得诱导以扩面绕过上界
    const rOut = runGate(p4, { stateDir, tool: 'Edit', filePath: join(p4, 'src', 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.ok(!JSON.parse(rOut.stdout.trim()).hookSpecificOutput.systemMessage.includes('--change-scope'), '上界外目标的拒绝不携带扩面尾句');
  } finally {
    for (const p of projects) rmSync(p, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 非规划租约不受固定上界；规划租约的 Bash 照常放行（守卫：明示不是 shell 沙箱）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a4-');
  const projects = [];
  try {
    const p1 = makeProject('rgate-a4-1-');
    projects.push(p1);
    assert.equal(runDeclare(p1, 'brainstorming', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    assert.equal(
      runGate(p1, { stateDir, tool: 'Edit', filePath: join(p1, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
      0,
      '非规划 skill 无写面声明保持全仓放行（向后兼容面不动）',
    );
    for (const scope of [undefined, '["docs/plans"]']) {
      const p = makePlanProject(`rgate-a4-${scope ? 'scoped' : 'free'}-`);
      projects.push(p);
      const d = runDeclare(p, 'plan-writing', {
        stateDir,
        incidentRoot: iso.incidentRoot,
        exemptRoot: iso.exemptRoot,
        ...(scope ? { changeScope: scope } : {}),
      });
      assert.equal(d.status, 0, `plan-writing 声明应成功（scope=${scope ?? '无'}）`);
      assert.equal(
        runGate(p, { stateDir, tool: 'Bash', command: 'touch x', incidentRoot: iso.incidentRoot }).status,
        0,
        `Bash 不受固定上界（scope=${scope ?? '无'}——阶段写面不是 shell 沙箱）`,
      );
    }
  } finally {
    for (const p of projects) rmSync(p, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 旧租约形态同检：legacy v2 同会话与 v3 null 扫描回退命中的 plan-writing 均受上界', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a5-');
  const projects = [];
  try {
    // legacy v2（同会话观察）：skill=plan-writing 的旧协议租约同样只放行面内
    const p1 = makePlanProject('rgate-a5-leg-');
    projects.push(p1);
    writeLegacyPlanState(p1, stateDir, 'plan-writing');
    assert.equal(
      runGate(p1, { stateDir, sessionId: 'sess-L1', tool: 'Edit', filePath: join(p1, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
      2,
      'legacy v2 plan-writing 租约的 src 目标须拒',
    );
    assert.equal(
      runGate(p1, { stateDir, sessionId: 'sess-L1', tool: 'Edit', filePath: join(p1, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot }).status,
      0,
      'legacy v2 plan-writing 租约的面内目标放行',
    );
    // 对照：legacy v2 非规划 skill 不受上界（旧租约向后兼容）
    const p2 = makePlanProject('rgate-a5-leg2-');
    projects.push(p2);
    writeLegacyPlanState(p2, stateDir, 'brainstorming');
    assert.equal(
      runGate(p2, { stateDir, sessionId: 'sess-L1', tool: 'Edit', filePath: join(p2, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
      0,
      'legacy v2 非规划租约保持全仓放行',
    );
    // v3 null 扫描回退：null 桶声明后指针失守 → 具名观察侧经扫描回退救回 null 桶租约。
    // 内部任务-8（内部规则-18 显式可见性表）形态改写：原「具名会话声明 + null 观察侧救回」在新表下
    // 不可达（null 观察侧只认 null 桶）——场景改为「null 桶声明 + 具名观察侧」，语义意图
    // 「扫描回退命中的 plan-writing 租约同受规划上界」不变（内部决策-018 修正案 2026-10-07 第 2 条）。
    const p3 = makePlanProject('rgate-a5-scan-');
    projects.push(p3);
    const tok = freshLease(p3, stateDir); // 无会话标识签发（null 桶）
    assert.equal(runDeclare(p3, 'plan-writing', { stateDir, leaseId: tok, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    freshLease(p3, stateDir); // null 桶再次轮换：指针失守 → 闸侧扫描回退救回租约
    const scannedDeny = runGate(p3, { stateDir, sessionId: 'sess-A5', tool: 'Edit', filePath: join(p3, 'src', 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.equal(scannedDeny.status, 2, '扫描回退救回的 plan-writing 租约的 src 目标须拒');
    // 内部任务-8 门 A F2：端到端锁定「main 把真实 readActiveLease 结果原样传给 denyMessage」——
    // 该拒因恰为 viaScan && viaNullBucket（null 桶救回 + 规划上界拒），诊断段须带标注字面量；
    // 若 main 侧改成重建对象/丢字段，selftest 与库层矩阵用例仍绿而本断言转红
    assert.ok(
      String(scannedDeny.stdout).includes('经 null 桶放行'),
      'deny 诊断须含 null 桶标注（链路中段透传锁定，F2）',
    );
    assert.equal(
      runGate(p3, { stateDir, sessionId: 'sess-A5', tool: 'Edit', filePath: join(p3, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot }).status,
      0,
      '扫描回退救回的 plan-writing 租约的面内目标放行',
    );
  } finally {
    for (const p of projects) rmSync(p, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 链接逃逸拒绝：docs/plans 下 symlink/junction 指向面外 → canonical 化后拒绝（环境不可能创建才跳过）', (t) => {
  const proj = makePlanProject('rgate-a6-');
  writeFileSync(join(proj, 'secret.md'), '# s\n');
  mkdirSync(join(proj, 'outsideDir'), { recursive: true });
  writeFileSync(join(proj, 'outsideDir', 'deep.md'), '# d\n');
  let fileLink = false;
  let jdir = false;
  try {
    symlinkSync(join(proj, 'secret.md'), join(proj, 'docs', 'plans', 'link.md'), 'file');
    fileLink = true;
  } catch {
    /* Windows 无特权创建 file symlink＝环境不可能：跳过该半边（非行为缺失） */
  }
  try {
    symlinkSync(join(proj, 'outsideDir'), join(proj, 'docs', 'plans', 'jdir'), 'junction');
    jdir = true;
  } catch {
    /* junction 不可用（非 Windows 或权限受限）：跳过该半边 */
  }
  if (!fileLink && !jdir) {
    rmSync(proj, { recursive: true, force: true });
    return t.skip('环境不支持创建 symlink/junction，链接逃逸面无法取证');
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a6-');
  try {
    assert.equal(runDeclare(proj, 'plan-writing', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    if (fileLink) {
      assert.equal(
        runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'docs', 'plans', 'link.md'), incidentRoot: iso.incidentRoot }).status,
        2,
        '面内 symlink 指向仓内面外文件：canonical 化后按越界拒',
      );
    }
    if (jdir) {
      assert.equal(
        runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'docs', 'plans', 'jdir', 'deep.md'), incidentRoot: iso.incidentRoot }).status,
        2,
        '面内 junction 目录内目标：canonical 化后按越界拒',
      );
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 嵌套仓隔离：主仓规划租约不放行嵌套仓计划文件；嵌套仓自身上界照常', () => {
  const { root, nested } = makeNestedProject();
  mkdirSync(join(nested, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(nested, 'AGENTS.md'), '# a\n');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a7-');
  try {
    assert.equal(runDeclare(root, 'plan-writing', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    assert.equal(
      runGate(root, { stateDir, tool: 'Edit', filePath: join(nested, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot }).status,
      2,
      '主仓租约不放行嵌套仓文件（键控隔离不因上界放宽）',
    );
    assert.equal(runDeclare(nested, 'plan-writing', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    assert.equal(
      runGate(nested, { stateDir, tool: 'Edit', filePath: join(nested, 'docs', 'plans', 'x.md'), incidentRoot: iso.incidentRoot }).status,
      0,
      '嵌套仓自身声明后面内放行',
    );
    assert.equal(
      runGate(nested, { stateDir, tool: 'Edit', filePath: join(nested, 'AGENTS.md'), incidentRoot: iso.incidentRoot }).status,
      2,
      '嵌套仓规划租约的 AGENTS 目标须拒',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('A组 上界 deny 复用留痕（隔离根零污染）；--exempt 对规划 skill 仍不可用（守卫）', () => {
  const proj = makePlanProject('rgate-a8-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  const iso = makeIsoRoots('rgate-iso-a8-');
  try {
    assert.equal(runDeclare(proj, 'plan-writing', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0);
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'AGENTS.md'), incidentRoot: iso.incidentRoot });
    assert.equal(r.status, 2, '越界目标 deny');
    const recs = readIncidentsAt(iso.incidentRoot, proj);
    assert.ok(recs.length >= 1, '上界 deny 须复用 deny 留痕面（隔离根可读）');
    assert.equal(readIncidents(proj).length, 0, '注入隔离根后夹具项目根零 .workflow 垃圾');
    const badExempt = runDeclare(proj, 'plan-writing', {
      stateDir,
      exempt: '用户当轮已批准',
      exemptSrc: 'user',
      incidentRoot: iso.incidentRoot,
      exemptRoot: iso.exemptRoot,
    });
    assert.notEqual(badExempt.status, 0, '--exempt 仍仅限 plan-execution（豁免面不因阶段上界扩员）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

// ── 内部任务-8（2026-10-07，内部规则-17）：钩内工具族分流——字面三工具闸退役 ──

test('DEV-8 任务 2.2：工具族分流——shell/edit 族（含 DSH 原生小写名）走租约判定，other 族零输出', () => {
  const proj = makeProject('rgate-dev8-fam-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-dev8-fam-state-'));
  const iso = makeIsoRoots('rgate-dev8-fam-iso-');
  try {
    // 无租约：pwsh（DSH 原生 shell 名）写命令 → deny（现状经字面三工具闸 exit 0＝RC-0 钩内面）
    assert.equal(
      runGate(proj, { stateDir, tool: 'pwsh', toolInput: { command: 'echo probe > out.txt' }, incidentRoot: iso.incidentRoot }).status,
      2,
      'pwsh 属 shell 族：须走整闸（RC-0 修复面）',
    );
    // edit 族小写名 → deny（键控与写面判定按族归一）
    assert.equal(
      runGate(proj, { stateDir, tool: 'edit', filePath: join(proj, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
      2,
      'edit 属 edit 族：须走整闸',
    );
    // other 族（只读工具）→ exit 0 零输出
    const other = runGate(proj, { stateDir, tool: 'Read', filePath: join(proj, 'src', 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.equal(other.status, 0, 'other 族静默放行');
    assert.equal(other.stdout.trim(), '', 'other 族零输出（R-M8-6 信封契约）');
    // 声明后 shell/edit 族放行（deny 语义不变的正向对照：null 桶声明 + null 观察侧）
    assert.equal(runDeclare(proj, 'brainstorming', { stateDir, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status, 0, '声明激活');
    assert.equal(
      runGate(proj, { stateDir, tool: 'pwsh', toolInput: { command: 'echo probe > out.txt' }, incidentRoot: iso.incidentRoot }).status,
      0,
      '持租约后 shell 族放行',
    );
    assert.equal(
      runGate(proj, { stateDir, tool: 'write', filePath: join(proj, 'src', 'a.ts'), incidentRoot: iso.incidentRoot }).status,
      0,
      '持租约后 edit 族放行',
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

// ── 内部任务-8 阶段 5（内部规则-19 ⑥）：deny 拒因与 LEASE_REASONS 单一来源 ──
test('DEV-8 任务 5.1：deny 拒因短语与 LEASE_REASONS 逐字同源（端到端两态 + 常量引用锚）', () => {
  const proj = makeProject('rgate-dev8-reason-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-dev8-reason-state-'));
  const iso = makeIsoRoots('rgate-dev8-reason-iso-');
  try {
    // ① 挑战未激活（签发后未声明）→ deny 文案含常量字面量（精确分流）
    freshLease(proj, stateDir, { sessionId: 'sess-R1' });
    const r1 = runGate(proj, { stateDir, sessionId: 'sess-R1', tool: 'Edit', filePath: join(proj, 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.equal(r1.status, 2, '未声明 → deny');
    assert.ok(String(r1.stdout).includes(LEASE_REASONS.UNACTIVATED), '拒因短语逐字来自常量（挑战未激活）');
    // ② 挑战已过期（声明成功后把挑战置过期）→ 前缀分流（startsWith 常量）+ 补签指引
    const ch2 = freshLease(proj, stateDir, { sessionId: 'sess-R2' });
    assert.equal(
      runDeclare(proj, 'brainstorming', { stateDir, leaseId: ch2, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status,
      0,
      '声明激活',
    );
    const chFile = join(stateDir, `wf-lease-challenge-${ch2}.json`);
    const raw = JSON.parse(readFileSync(chFile, 'utf8'));
    writeFileSync(chFile, JSON.stringify({ ...raw, expiresAt: Date.now() - 1000 }));
    // 同时让 active 过期：否则扫描回退会救回「仅挑战过期」的已声明租约（内部任务-LEASEGATE-1 语义）
    const actFile = join(stateDir, `wf-lease-active-${ch2}.json`);
    const actRaw = JSON.parse(readFileSync(actFile, 'utf8'));
    writeFileSync(actFile, JSON.stringify({ ...actRaw, expiresAt: Date.now() - 1000 }));
    const r2 = runGate(proj, { stateDir, sessionId: 'sess-R2', tool: 'Edit', filePath: join(proj, 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.equal(r2.status, 2, '挑战过期 → deny');
    assert.ok(String(r2.stdout).includes(LEASE_REASONS.EXPIRED_CHALLENGE), '拒因前缀逐字来自常量（挑战已过期）');
    assert.ok(String(r2.stdout).includes('补签'), '过期分流仍附补签出路（W2① 形态保持）');
    // ③ 静态锚：路由闸的三处分流点统一引常量（裸字面量退役的可判据）
    const src = readFileSync(GATE, 'utf8');
    const refs = (src.match(/LEASE_REASONS\./g) ?? []).length;
    assert.ok(refs >= 3, `deny 分流点须引 LEASE_REASONS 常量（实测引用 ${refs} 处，期望 ≥3）`);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('DEV-8 门禁实例1 F1：无 tool_name 的写面负载静默放行（设计语义锁定：族不可判即不定键）', () => {
  const proj = makeProject('rgate-dev8-notool-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-dev8-notool-state-'));
  try {
    const r = spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'echo probe > out.txt' }, cwd: proj }),
      encoding: 'utf8',
      env: { ...BASE_ENV, WF_ROUTING_STATE_DIR: stateDir, ZCODE_PLUGIN_ROOT: resolve(HOOKS, '..') },
    });
    assert.equal(r.status, 0, '族不可判（无 tool_name）→ fail-open 放行（判据依赖键控维度，无法定键不猜测）');
    assert.equal(String(r.stdout).trim(), '', '零输出（R-M8-6 信封契约）');
    // 对照：同一负载带上 shell 族名 → 走整闸并因无租约 deny
    assert.equal(
      runGate(proj, { stateDir, tool: 'pwsh', toolInput: { command: 'echo probe > out.txt' } }).status,
      2,
      '同负载带工具名 → deny（放行只因族不可判，非判据放宽）',
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-8 门B-F3：闸侧心跳接线——放行一次后 active.expiresAt 顺延（删接线即红）', () => {
  const proj = makeProject('rgate-dev8-hb-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-dev8-hb-state-'));
  const iso = makeIsoRoots('rgate-dev8-hb-iso-');
  try {
    const ch = freshLease(proj, stateDir); // null 桶（无会话标识）
    assert.equal(
      runDeclare(proj, 'brainstorming', { stateDir, leaseId: ch, incidentRoot: iso.incidentRoot, exemptRoot: iso.exemptRoot }).status,
      0,
      '声明激活',
    );
    const actFile = join(stateDir, `wf-lease-active-${ch}.json`);
    const raw = JSON.parse(readFileSync(actFile, 'utf8'));
    const near = Date.now() + 60 * 1000; // 剩余 < TTL/3 → 满足续期判据
    writeFileSync(actFile, JSON.stringify({ ...raw, expiresAt: near }));
    const r = runGate(proj, { stateDir, tool: 'Edit', filePath: join(proj, 'a.ts'), incidentRoot: iso.incidentRoot });
    assert.equal(r.status, 0, '持租约放行');
    const after = JSON.parse(readFileSync(actFile, 'utf8')).expiresAt;
    assert.ok(after > near + 60000, `闸放行后 expiresAt 须顺延（前 ${near} → 后 ${after}）——删心跳接线即红`);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(iso.home, { recursive: true, force: true });
  }
});

test('DEV-27 坑4：单域仓 deny 文案内联建议号，零域仓默认域兜底内联（DEV-75）', () => {
  const proj = makeProject('rgate-d27-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  let bare = '';
  try {
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    // 非只读命令（默认 echo hi 命中只读白名单会被放行——见 :137 先例）
    const r = runGate(proj, { stateDir, tool: 'Bash', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('--task-id DEV-1'), '单域仓 deny 文案内联建议号（与租约行同源）');
    // 零域仓：默认域兜底内联 内部任务-1（内部任务-75/IMP-4——旧「占位符保持」形态废止，接线断言=删兜底即红）
    bare = makeProject('rgate-d27b-');
    const stateDir2 = mkdtempSync(join(tmpdir(), 'rgate-state-'));
    const r2 = runGate(bare, { stateDir: stateDir2, tool: 'Bash', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"' });
    assert.equal(r2.status, 2);
    const msg2 = JSON.parse(r2.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg2.includes('--task-id DEV-1'), '零域仓默认域兜底内联建议号（DEV-75）');
    rmSync(stateDir2, { recursive: true, force: true });
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    if (bare) rmSync(bare, { recursive: true, force: true });
  }
});

test('OPEN-103：deny 文案建议号排除观察会话自身占用（claim 在场＋active 失效形态，DEV-52）', () => {
  const proj = makeProject('rgate-o103-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-state-'));
  try {
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    // 种子：闸负载同会话占 内部任务-7（claim+active+台账），随后删 active 文件模拟「active 失效
    // 而 claim 未过期」——闸因无有效租约 deny，建议号扫描面仍见本会话占用。
    const prevEnv = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const key = projectKey(proj);
      const ch = issueChallenge(key, { sessionId: 'sess-o103' });
      const r = activateLease(key, { leaseId: ch.leaseId, taskId: 'DEV-7', skill: 'tdd' });
      assert.ok(r.ok, `种子声明须成功：${r.reason}`);
      rmSync(join(stateDir, `wf-lease-active-${ch.leaseId}.json`), { force: true });
    } finally {
      if (prevEnv === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevEnv;
    }
    // 非只读命令（默认 echo hi 命中只读白名单会被放行——见 D27 用例同款约束）
    const g = runGate(proj, { stateDir, tool: 'Bash', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"', sessionId: 'sess-o103' });
    assert.equal(g.status, 2);
    const msg = JSON.parse(g.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('--task-id DEV-1'), '排除自身后建议回到空态取号（照抄即延续同号）');
    assert.ok(!msg.includes('--task-id DEV-8'), '未接线排除时会被自身占用顶成 DEV-8——删接线即红');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-41（2026-10-11，FIX-3 承接）：事故序列回归（验收不变量）+ deny 头窗前置 ──

test('DEV-41 实录 A 序列：复合声明被拒后，当轮令牌单条声明必须成功（deny 不杀新鲜挑战）', () => {
  const proj = makeProject('dev41-a-');
  const stateDir = mkdtempSync(join(tmpdir(), 'dev41-a-state-'));
  try {
    const leaseId = freshLease(proj, stateDir, { sessionId: 'sess-e2e' });
    const denied = runGate(proj, {
      stateDir,
      ttlMs: '5000',
      tool: 'Bash',
      sessionId: 'sess-e2e',
      command: `node "${DECLARE}" tdd --lease ${leaseId} --task-id DEV-41 2>/dev/null || true`,
    });
    assert.equal(denied.status, 2, '复合（重定向+链式混非声明命令）整条拒');
    const single = runDeclare(proj, 'verification', { stateDir, leaseId, taskId: 'DEV-41', ttlMs: '5000' });
    assert.equal(single.status, 0, 'deny 之后当轮令牌单条声明必须成功');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-41 实录 B 序列：双键同轮签发，deny 后嵌套仓与主仓当轮令牌声明均成功', () => {
  const main = makeProject('dev41-b-main-');
  const nested = join(main, 'docs', 'design-repo');
  mkdirSync(join(nested, '.git'), { recursive: true });
  const stateDir = mkdtempSync(join(tmpdir(), 'dev41-b-state-'));
  try {
    const leaseMain = freshLease(main, stateDir, { sessionId: 'sess-e2e' });
    const leaseNested = freshLease(nested, stateDir, { sessionId: 'sess-e2e' });
    const denied = runGate(main, {
      stateDir,
      ttlMs: '5000',
      tool: 'Bash',
      sessionId: 'sess-e2e',
      command: `cd "${nested}" && node "${DECLARE}" tdd --lease ${leaseNested} --task-id DEV-42 && cd "${main}" && git status`,
    });
    assert.equal(denied.status, 2, 'cwd 键控主仓的复合命令整条拒');
    const actNested = runDeclare(main, 'verification', { stateDir, leaseId: leaseNested, taskId: 'DEV-42', ttlMs: '5000', projectRoot: nested });
    assert.equal(actNested.status, 0, '嵌套仓当轮令牌声明成功（实录 B 步骤 2）');
    const actMain = runDeclare(main, 'verification', { stateDir, leaseId: leaseMain, taskId: 'DEV-43', ttlMs: '5000' });
    assert.equal(actMain.status, 0, '主仓当轮令牌声明成功（事故中失败的应是旧轮令牌）');
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-41 #2 声明命令元字符指引落在 deny 文案头部窗口（P7 截断教训）', () => {
  const proj = makeProject('dev41-c-');
  const stateDir = mkdtempSync(join(tmpdir(), 'dev41-c-state-'));
  try {
    const denied = runGate(proj, {
      stateDir,
      ttlMs: '5000',
      tool: 'Bash',
      sessionId: 'sess-e2e',
      command: `node "${DECLARE}" tdd --lease ${'c'.repeat(32)} --task-id DEV-41 | tail -5`,
    });
    assert.equal(denied.status, 2);
    const msg = JSON.parse(denied.stdout.trim()).hookSpecificOutput.systemMessage;
    assert.ok(
      msg.slice(0, 200).includes('声明命令请单独成条发送'),
      `头窗 200 字内须含单独成条指引，实际头窗：${msg.slice(0, 200)}`,
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// 内部任务-75/IMP-3（内部规则-20 基线写面）：映射表形态锁——SKILL_WRITE_FLOOR 单源导出于
// routing-lib（与 PLAN_DIRS 同模块），root-cause-debugging 条目=PLAN_DIRS 引用不复制。
test('DEV-75 SKILL_WRITE_FLOOR 映射表形态：恰 root-cause-debugging 条目=PLAN_DIRS', async () => {
  const { SKILL_WRITE_FLOOR, PLAN_DIRS } = await import('../../hooks/routing-lib.mjs');
  assert.deepEqual(Object.keys(SKILL_WRITE_FLOOR), ['root-cause-debugging'], '首批恰一 skill 条目');
  assert.equal(SKILL_WRITE_FLOOR['root-cause-debugging'], PLAN_DIRS, '条目引用 PLAN_DIRS（不复制，防双源漂移）');
  assert.deepEqual([...PLAN_DIRS], ['docs/plans', 'docs/superpowers/plans'], 'PLAN_DIRS 值锚定');
});

// 内部任务-75/IMP-3（内部规则-20 基线写面）：root-cause-debugging 声明下——无 changeScope 时
// docs/plans .md 放行、src/内部规格 拒（信封含「基线写面」与 --change-scope 指引、
// cmd 模板渲染当前租约实际 taskId）；带 changeScope 时并集扩面；非映射 skill 行为不变。
test('DEV-75 基线写面：root-cause 无声明时 docs/plans .md 放行、src/specs/learnings 拒且文案含补声明指引', () => {
  const proj = makeProject('rgate-floor-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-floor-state-'));
  try {
    const d = runDeclare(proj, 'root-cause-debugging', { stateDir, taskId: 'DEV-90001' });
    assert.equal(d.status, 0, `种子声明须成功：${d.stderr}`);
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    const okRun = runGate(proj, { stateDir, filePath: join(proj, 'docs', 'plans', 'DEBUG-REPORT.md') });
    assert.equal(okRun.status, 0, 'docs/plans .md 应放行（基线面内）');
    const denyRun = runGate(proj, { stateDir, filePath: join(proj, 'src', 'a.ts') });
    assert.equal(denyRun.status, 2, 'src 代码应被基线写面拦截');
    const msg = JSON.parse(denyRun.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('基线写面'), '专属文案点名基线写面');
    assert.ok(msg.includes('--change-scope'), '补声明指引在场');
    assert.ok(msg.includes('DEV-90001'), 'cmd 模板渲染当前租约实际 taskId（scopeHint 先例——沿原号扩面）');
    for (const p of [join(proj, 'specs', 'x.md'), join(proj, 'learnings.md')]) {
      assert.equal(runGate(proj, { stateDir, filePath: p }).status, 2, `${p} 应拒（规格/归档面不在基线面）`);
    }
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('DEV-75 基线写面：changeScope 并集扩面（声明 src 后 src 放行、面外仍拒、基线面半边仍放行）；宽面全仓放行', () => {
  const proj = makeProject('rgate-floor-scope-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-fs-state-'));
  const wide = makeProject('rgate-floor-wide-');
  const wideState = mkdtempSync(join(tmpdir(), 'rgate-fw-state-'));
  try {
    const d = runDeclare(proj, 'root-cause-debugging', { stateDir, taskId: 'DEV-90002', changeScope: '["src"]' });
    assert.equal(d.status, 0, `带写面种子声明须成功：${d.stderr}`);
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
    assert.equal(runGate(proj, { stateDir, filePath: join(proj, 'src', 'a.ts') }).status, 0, '声明面内放行（并集扩面）');
    assert.equal(runGate(proj, { stateDir, filePath: join(proj, 'services', 'b.py') }).status, 2, '声明面外仍拒');
    assert.equal(
      runGate(proj, { stateDir, filePath: join(proj, 'docs', 'plans', 'DEBUG-REPORT.md') }).status,
      0,
      '基线面半边：声明代码面后过程文档仍放行（并集不是 AND——收尾评审发现 1 修复锁定，通用写面判定对映射表 skill 单点跳过）',
    );
    const d2 = runDeclare(wide, 'root-cause-debugging', { stateDir: wideState, taskId: 'DEV-90003', changeScope: '["."]' });
    assert.equal(d2.status, 0, `宽面种子声明须成功：${d2.stderr}`);
    assert.equal(runGate(wide, { stateDir: wideState, filePath: join(wide, 'anywhere', 'c.md') }).status, 0, '根条目=显式宽面全仓放行');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wide, { recursive: true, force: true });
    rmSync(wideState, { recursive: true, force: true });
  }
});

test('DEV-75 基线写面：非映射 skill 不受影响（无声明 src 放行，向后兼容）', () => {
  const proj = makeProject('rgate-floor-other-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-fo-state-'));
  try {
    const d = runDeclare(proj, 'brainstorming', { stateDir, taskId: 'DEV-90004' });
    assert.equal(d.status, 0, `种子声明须成功：${d.stderr}`);
    assert.equal(runGate(proj, { stateDir, filePath: join(proj, 'src', 'a.ts') }).status, 0, '非映射 skill 无声明=全仓放行（既有语义回归）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ADR-045：维护者段仓 deny 文案内联三段建议号（soleTaskIdSuggestion 单源连带面）', () => {
  const proj = makeProject('rgate-adr45-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-adr45-state-'));
  try {
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    writeFileSync(join(proj, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    writeFileSync(join(proj, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'WP' }));
    const r = runGate(proj, { stateDir, tool: 'Bash', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"' });
    assert.equal(r.status, 2);
    const msg = JSON.parse(r.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('--task-id DEV-WP-1'), 'deny 文案内联三段建议号（≤11 字符，与租约行同源——soleTaskIdSuggestion 单源连带）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部模块-15 v2 写者接线（评审修复 N5）：闸侧 deny/lease-loop 记录带分类字段 ──

test('评审修复 N5：闸 deny/lease-loop 记录带 cause/ruleId/rulesVersion/observationSource', () => {
  const proj = makeProject('rgate-v2keep-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-v2keep-state-'));
  try {
    assert.equal(runGate(proj, { stateDir, tool: 'Bash', command: 'touch x' }).status, 2);
    const deny = projIncidentsOf(proj)
      .filter((d) => d.kind === 'lease-deny')
      .pop();
    assert.ok(deny, 'deny 留痕在场');
    assert.equal(deny.cause, 'mechanism-trace', 'lease-deny → mechanism-trace（规则表 r-lease-trace）');
    assert.equal(deny.ruleId, 'r-lease-trace');
    assert.equal(deny.rulesVersion, 1);
    assert.equal(deny.observationSource, 'hook:routing-gate', '观测来源标注');
    // lease-loop 升级记录：cause 必须 mechanism-escalation（恒计入待排查不变量）
    const kd = digestOf([String(projectKey(proj))]);
    const dg = digestOf(['lease-deny', '状态缺失或损坏', kd]);
    const now = Date.now();
    const line = (i, status) =>
      JSON.stringify({ schemaVersion: 1, id: `ld-v2-${i}`, ts: now, session: 'default', taskId: null, skill: null, plugin: 'workflow', kind: 'lease-deny', tool: 'Bash', event: null, digest: dg, status });
    writeFileSync(join(proj, '.workflow', 'incidents.jsonl'), readFileSync(join(proj, '.workflow', 'incidents.jsonl'), 'utf8') + [line(1, 'open'), line(2, 'resolved'), line(3, 'open'), line(4, 'resolved')].join('\n') + '\n');
    assert.equal(runGate(proj, { stateDir, tool: 'Edit' }).status, 2);
    const loop = projIncidentsOf(proj).find((d) => d.kind === 'lease-loop');
    assert.ok(loop, '振荡升级记录在场');
    assert.equal(loop.cause, 'mechanism-escalation', 'lease-loop → mechanism-escalation');
    assert.equal(loop.ruleId, 'r-lease-escalation');
    assert.equal(loop.rulesVersion, 1);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 内部任务-244 A01：委派会话 deny 指引（父链交付号内联 / 不可解析零具体号） ──

test('DEV-244 A01：委派 deny 文案——不可解析零具体号＋回报父会话；可解析内联继承号；顶层不变', () => {
  const proj = makeProject('rgate-deleg-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-deleg-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rgate-deleg-inc-'));
  try {
    const target = join(proj, 'a.ts');
    const base = {
      stateDir, tool: 'Edit', filePath: target, sessionId: 'child-1', incidentRoot,
      payloadPatch: { delegation_depth: 1, parent_session_id: 'parent-1' },
    };
    const r1 = runGate(proj, base);
    assert.equal(r1.status, 2, '委派会话无租约仍 deny');
    const msg1 = JSON.parse(r1.stdout).hookSpecificOutput.systemMessage;
    assert.ok(msg1.includes('回报父会话'), `不可解析须给父会话指引（实得：${msg1.slice(0, 240)}）`);
    assert.ok(msg1.includes('<父会话交付任务号>'), '零具体号占位');
    assert.ok(!/--task-id DEV-\d+/.test(msg1), '不得内联自取建议号');
    // 父链已签发台账 → 内联继承号
    const key = projectKey(proj);
    const kd = createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `wf-issued-${kd}.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, ts: Date.now(), taskId: 'DEV-77', sessionId: 'parent-1', inherited: false })}\n`,
    );
    const r2 = runGate(proj, base);
    const msg2 = JSON.parse(r2.stdout).hookSpecificOutput.systemMessage;
    assert.ok(msg2.includes('父链交付任务号 DEV-77'), `可解析内联继承号（实得：${msg2.slice(0, 240)}）`);
    assert.ok(msg2.includes('--task-id DEV-77'), '声明命令内联继承号');
    // 顶层（非委派）逐字节路径不变：无委派前缀
    const r3 = runGate(proj, { stateDir, tool: 'Edit', filePath: target, sessionId: 'child-1', incidentRoot });
    const msg3 = JSON.parse(r3.stdout).hookSpecificOutput.systemMessage;
    assert.ok(!msg3.includes('委派会话'), '顶层文案不得出现委派前缀');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 归因 taskId：routing-gate deny 记录在无本会话租约时 taskId/skill=null', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const proj = makeProject('rgate-d342-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-d342-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rgate-d342-ir-'));
  try {
    const r = runGate(proj, { stateDir, incidentRoot, tool: 'Edit', filePath: join(proj, 'a.ts') });
    assert.notEqual(r.status, 0, '无租约写须 deny');
    const recs = readIncidentsAt(incidentRoot, proj).filter((d) => d.kind === 'lease-deny');
    assert.ok(recs.length >= 1, 'deny 须留痕');
    assert.equal(recs.at(-1).taskId, null, '无本会话具名租约时 deny 记录 taskId=null');
    assert.equal(recs.at(-1).skill, null, '无本会话具名租约时 deny 记录 skill=null');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-342 归因 taskId：routing-gate 对失效的本会话具名租约 deny 时不冒领（visible≠valid）', async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const proj = makeProject('rgate-d342-exp-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-d342-exp-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rgate-d342-exp-ir-'));
  const prev = process.env.WF_ROUTING_STATE_DIR;
  try {
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const ch = issueChallenge(projectKey(proj), { sessionId: 'sess-exp' });
      assert.ok(activateLease(projectKey(proj), { leaseId: ch.leaseId, taskId: 'DEV-990', skill: 'plan-execution' }).ok, '夹具租约激活失败');
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    // 令本会话具名租约过期：lease body 仍可见，但 valid=false
    const activeFile = readdirSync(stateDir).find((n) => n.startsWith('wf-lease-active-'));
    assert.ok(activeFile, '须有 active 租约文件');
    const active = JSON.parse(readFileSync(join(stateDir, activeFile), 'utf8'));
    active.expiresAt = Date.now() - 1000;
    writeFileSync(join(stateDir, activeFile), JSON.stringify(active));
    const r = runGate(proj, { stateDir, incidentRoot, tool: 'Edit', filePath: join(proj, 'a.ts'), sessionId: 'sess-exp' });
    assert.notEqual(r.status, 0, '失效租约写须 deny');
    const rec = readIncidentsAt(incidentRoot, proj).filter((d) => d.kind === 'lease-deny').at(-1);
    assert.ok(rec, 'deny 须留痕');
    assert.equal(rec.taskId, null, '失效租约不得作为 deny 记录归因（visible≠valid；删 valid 门槛必红）');
    assert.equal(rec.skill, null, '失效租约 skill 亦不得冒领');
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});


test('DEV-341 项目 skill 缺 ack：Edit/Write deny 并附修复命令/重声明恢复/Bash 只读不受影响', () => {
  const proj = makeProject('rgate-dev341-');
  const stateDir = mkdtempSync(join(tmpdir(), 'rgate-dev341-st-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'rgate-dev341-ir-'));
  try {
    mkdirSync(join(proj, '.agents', 'skills', 'project-conventions'), { recursive: true });
    writeFileSync(
      join(proj, '.agents', 'skills', 'project-conventions', 'SKILL.md'),
      '---\nname: project-conventions\ndescription: 本仓操作约束\nx-load-scenario: 写/改任何文件前\nx-required-on-write: true\n---\n',
    );
    // 旧租约（无 projectSkills）→ Edit deny(2)
    const prev = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir;
    try {
      const ch = issueChallenge(projectKey(proj));
      const act = activateLease(projectKey(proj), { leaseId: ch.leaseId, taskId: 'TASK-1', skill: 'verification' });
      assert.equal(act.ok, true, act.reason);
    } finally {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
    }
    const denied = runGate(proj, { stateDir, incidentRoot, tool: 'Edit', filePath: join(proj, 'a.ts') });
    assert.equal(denied.status, 2, '必载集合未 ack 必须 deny');
    const msg = JSON.parse(denied.stdout.trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(msg.includes('项目 skill'), `文案须点名项目 skill 义务：${msg}`);
    assert.ok(msg.includes('--project-skill project-conventions'), '文案须给 ack 修复命令');
    // 声明 ack 后放行（含 changeScope 覆盖目标）
    const decl = runDeclare(proj, 'verification', { stateDir, incidentRoot, taskId: 'TASK-1', changeScope: '["a.ts"]', projectSkills: ['project-conventions'] });
    assert.equal(decl.status, 0, decl.stderr);
    assert.match(decl.stdout, /【项目 skill】已 ack：project-conventions/);
    const allowed = runGate(proj, { stateDir, incidentRoot, tool: 'Edit', filePath: join(proj, 'a.ts') });
    assert.equal(allowed.status, 0, 'ack 后应放行');
    // Bash 只读不受项目 skill 义务影响
    const ro = runGate(proj, { stateDir, incidentRoot, tool: 'Bash', command: 'ls' });
    assert.equal(ro.status, 0);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});
