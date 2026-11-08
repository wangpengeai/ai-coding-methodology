// 文件：session-start.mjs
// 描述：team-governance SessionStart 摘要 hook（内部规则-6 / 内部规则-11，内部需求-1/17）——两段式：
//       ①os-observe 浮现段（用户级资产，先于项目治理门控——项目未接入治理不缺席
//       安全浮现）：增量物化后计未确认 suspicious，>0 注入计数+CLI 指针（默认无端点
//       明细——注入内容进模型上下文即出机，明细须 config surfaceDetail 显式开启，
//       B-M14-6），附停滞/配置警告从句；②治理段（原逻辑）：governance enabled/policy
//       版本/change set/lease 冲突/未闭环审批/eval。fail-open：任何异常静默退 0
//       （提醒不阻断，团队强制点在 CI/gate）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { countFindings, osObserveHome, rawFreshness, readFindings, staleOf } from '../scripts/lib/os-observe-store.mjs';
import { syncRawToFindings } from '../scripts/lib/os-observe-pipeline.mjs';
import { loadUserConfig } from '../scripts/lib/os-observe-classify.mjs';
import { opportunisticCollect } from '../scripts/lib/os-observe-tasks.mjs';
import { shouldSkipOsObserve } from '../scripts/lib/os-observe-switch.mjs';
import { foldApprovals, isValidExpiresAt } from '../scripts/lib/approval.mjs';

function projectRoot() {
  return process.env.ZCODE_PROJECT_DIR || process.env.QODER_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** os-observe 浮现段：未启用（无 findings 且无 raw）或无未确认项返回 null；异常由调用方 fail-open。 */
function osObserveSection() {
  const home = osObserveHome();
  // 机会式补位采集（内部任务-OBSO-COLLECT-1，内部规则-11）：部署面存在即各跑一轮，计划任务被
  // 终端安全策略禁用环境下的会话驱动补位通道；fail-open 零输出，不判任务态（游标/节流
  // 幂等吸收冗余）。必须在「未启用」早退守卫**之前**执行——目标场景恰是任务被禁而
  // raw/findings 尚空的冷启态（评审发现 1：置于守卫后则冷启态永不触发）。
  opportunisticCollect({});
  const fresh = rawFreshness(home);
  /** 最近采集失败留痕（内部任务-257 P5-3）：读取面可见，不冒充「无数据」。 */
  const readLastCollectError = () => {
    try { return JSON.parse(readFileSync(join(home, 'raw', 'last-error.json'), 'utf8')); } catch { return null; }
  };
  const lastCollectError = readLastCollectError();
  if (!existsSync(join(home, 'findings.jsonl')) && fresh.files === 0) {
    // 零样本但已部署过（有配置或失败留痕）→ 出最小停滞/失败从句；完全未部署则静默
    const deployed = existsSync(join(home, 'config.json')) || lastCollectError !== null;
    if (!deployed) return null;
    const parts = ['观测无样本（采集器可能未部署或未运行）'];
    if (lastCollectError) parts.push(`最近采集失败（${lastCollectError.phase}：${String(lastCollectError.error).slice(0, 80)}）`);
    return `【team-governance】os-observe：${parts.join('；')}（node 'team-governance/scripts/governance-cli.mjs' os-observe status 查看）`;
  }
  syncRawToFindings(home, { maxRows: 2000 }); // 增量物化（读取面职责）；余量下会话续传
  const agg = countFindings(readFindings(home));
  if (agg.openSuspicious === 0) return null;
  const cfg = loadUserConfig(home);
  const clauses = [];
  if (fresh.newestTsMs > 0) {
    const { staleMinutes, stale } = staleOf(fresh, cfg.config.pollMinutes, Date.now());
    if (stale) clauses.push(`观测停滞（最近样本 ${staleMinutes} 分钟前，采集器疑似失效）`);
  }
  // 内部任务-257（P5-3）：零样本 / 采集器失败留痕——不冒充「无数据」，出明确从句
  if (fresh.files === 0) clauses.push('观测无样本（采集器可能未部署或未运行）');
  if (lastCollectError) {
    const at = Date.parse(lastCollectError.ts);
    if (Number.isFinite(at) && Date.now() - at < Math.max(2 * cfg.config.pollMinutes, 30) * 60_000) {
      clauses.push(`最近采集失败（${lastCollectError.phase}：${String(lastCollectError.error).slice(0, 80)}）`);
    }
  }
  if (!cfg.ok) clauses.push(cfg.warning);
  if (cfg.config.surfaceDetail) {
    const details = agg.pending.map((f) => `${f.endpoint ?? '?'}${f.process ? `（${f.process}）` : ''}`);
    clauses.push(`明细（最多 3 条）：${details.slice(0, 3).join('、')}`);
  }
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'governance-cli.mjs');
  const head = `【team-governance】os-observe：${agg.openSuspicious} 条未确认可疑外发发现（node '${cli}' os-observe list --class suspicious 查看、os-observe ack <id> 确认）`;
  return clauses.length > 0 ? `${head}；${clauses.join('；')}` : head;
}

/** 政策 id/version 取源（H3）：内联 `policy{id,version}` 权威，legacy 顶层兜底。
 * 说明：归一语义的唯一事实源是 `lib/governance-store.mjs#normalizePolicy`；本函数只做
 * 「展示用 id/version 取源」，不复制归一兜底（三维评审：指向单源，不造第三份判定）。 */
function policyRefOf(config) {
  const inline = config?.policy;
  if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
    return { id: inline.id ?? 'default', version: inline.version ?? 1 };
  }
  return { id: config?.policyId ?? 'default', version: config?.policyVersion ?? 1 };
}

/** change-set 摘要节（H3）：读 runtime/change-set.json 的 digest，缺省显式「未设」。 */
function changeSetSection(root) {
  try {
    const cs = JSON.parse(readFileSync(join(root, '.ai-governance', 'runtime', 'change-set.json'), 'utf8'));
    const digest = typeof cs?.digest === 'string' ? cs.digest : (cs?.changeSet ? 'sha256:未定' : '');
    return digest ? `change-set ${String(digest).slice(0, 23)}` : 'change-set 未设';
  } catch {
    return 'change-set 未设';
  }
}

/** JSONL 文本 → 记录数组（坏行/非对象行跳过；与 approval 台账读侧容忍同语义）。 */
function recordsFromJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 未闭环审批计数（H3）：轻量折叠（按 approvalId 后者覆盖）后统计不可用项——
 * 撤销/条件未闭环/过期/expiresAt 形态非法；不重算绑定（SessionStart 保持廉价）。
 */
function unclosedApprovals(root) {
  let text;
  try {
    text = readFileSync(join(root, '.ai-governance', 'runtime', 'approvals', 'approvals.jsonl'), 'utf8');
  } catch {
    return '未闭环审批=0';
  }
  const today = new Date().toISOString().slice(0, 10);
  let pending = 0;
  for (const rec of foldApprovals(recordsFromJsonl(text))) {
    const expired = !isValidExpiresAt(rec.expiresAt) || String(rec.expiresAt) < today;
    const conditions = Array.isArray(rec.conditions) && rec.conditions.length > 0;
    if (rec.revocation || conditions || expired) pending += 1;
  }
  return `未闭环审批=${pending}`;
}

/** eval 摘要节（H3）：最近一份 replay 报告（live 证据不参与 gate 判定面，故不进摘要）。 */
function evalSection(root) {
  try {
    const dir = join(root, '.ai-governance', 'runtime', 'evals');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('-manifest.json'))
      .sort()
      .reverse();
    for (const f of files) {
      let report;
      try { report = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!report || report.mode === 'live') continue;
      const status = typeof report.status === 'string' && report.status
        ? report.status
        : (report.summary?.failed > 0 ? 'failed' : 'passed');
      return `eval ${report.suiteId ?? '?'} ${status}`;
    }
  } catch { /* 无报告目录是常态 */ }
  return 'eval 未跑';
}

/** 治理段（H3）：policy/lease/change-set/未闭环审批/eval 五节；配置不可读/政策缺失显式降级 warning。 */
function governanceSection(root) {
  const configPath = join(root, '.ai-governance', 'config.json');
  if (!existsSync(configPath)) return null; // 未接入治理：不注入（fail-open 静默是设计，非降级）
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return `【team-governance】治理摘要降级：配置不可读（${configPath}）——治理提醒可能不完整；`
      + `请修复 .ai-governance/config.json（${e.message}）`;
  }
  // 内部任务-254（H3）：配置可读但政策信息整体缺失 → 显式降级（不静默冒充 default@1）。
  // legacy 兜底只认 policyId/policyVersion；仅 enforcement 不足以判 id/version（三维评审建议 6）。
  const inline = config?.policy;
  const hasInline = inline && typeof inline === 'object' && !Array.isArray(inline);
  const hasLegacy = config?.policyId !== undefined || config?.policyVersion !== undefined;
  if (!hasInline && !hasLegacy) {
    return `【team-governance】治理摘要降级：配置缺 policy（${configPath}）——policy/change-set/审批/eval 提醒不可判；`
      + '请补内联 policy{id,version} 或旧顶层 policyId/policyVersion';
  }
  const ref = policyRefOf(config);
  const parts = [`policy ${ref.id}@${ref.version}`];
  // lease 冲突/过期提醒（读运行态，读失败静默）
  try {
    const state = JSON.parse(readFileSync(join(root, '.ai-governance', 'runtime', 'leases', 'leases.json'), 'utf8'));
    const held = Object.values(state.leases ?? {}).filter((l) => l.state === 'held');
    const expired = held.filter((l) => l.expiresAt < Date.now());
    if (held.length > 0) parts.push(`lease held=${held.length}${expired.length ? `（过期 ${expired.length}）` : ''}`);
  } catch { /* 无租约状态是常态 */ }
  parts.push(changeSetSection(root));
  parts.push(unclosedApprovals(root));
  parts.push(evalSection(root));
  return `【team-governance】治理已接入：${parts.join('｜')}；治理操作经 workflow 路由表治理行进入（CI/gate 是团队强制点，本提醒不阻断）。`;
}

async function main() {
  const root = projectRoot();
  const sections = [];
  try {
    // 内部任务-268/内部决策-068 决策 3：宿主适配层按用户配置注入 AI_CODING_OS_OBSERVE=0 时跳过
    // os-observe 浮现段与机会式补位采集；治理摘要段照常（其余取值不分支）。
    const s = shouldSkipOsObserve(process.env) ? null : osObserveSection(); // 用户级，先于治理门控（内部规则-11）
    if (s) sections.push(s);
  } catch { /* fail-open */ }
  try {
    const g = governanceSection(root);
    if (g) sections.push(g);
  } catch { /* fail-open */ }
  if (sections.length === 0) return; // 未接入治理且观测无未确认项：不注入
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sections.join('\n'),
    },
  }) + '\n');
}

if (process.argv.includes('--selftest')) {
  // 2026-09-19 评审修复 H11（PHASE2 门处置加强）：子进程驱动 + 输出锚点断言——
  // ①OS_OBSERVE_HOME 隔离（原直跑 main 会写真实用户级 ~/.zcode/os-observe/）；
  // ②断言治理段锚点（原 then 无断言，治理段整段删除 selftest 仍绿，鉴别力为零）；
  // ③失败退 1 输出 FAIL（原 catch 退 0 属自察假绿灯）。
  // 内部任务-254（H3/内部验收-5）：四节摘要（policy/change-set/审批/eval）＋内联 policy 取源＋配置不可读显式降级。
  const home = mkdtempSync(join(tmpdir(), 'tg-sess-selftest-'));
  try {
    const gov = join(home, '.ai-governance');
    mkdirSync(join(gov, 'runtime', 'approvals'), { recursive: true });
    mkdirSync(join(gov, 'runtime', 'evals'), { recursive: true });
    writeFileSync(join(gov, 'config.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      policy: { id: 'p1', version: 2, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      requiredDomains: [],
    }), 'utf8');
    writeFileSync(join(gov, 'runtime', 'change-set.json'), JSON.stringify({
      ok: true, changeSet: { changeSetId: 'cs-1', repos: [{ repoId: 'main' }], resources: [] },
      digest: 'sha256:' + 'c'.repeat(64),
    }), 'utf8');
    writeFileSync(join(gov, 'runtime', 'approvals', 'approvals.jsonl'), [
      JSON.stringify({ approvalId: 'apr-open', subjectDigest: 'sha256:' + 'a'.repeat(64), role: 'accountable',
        identity: { source: 'local', verified: false, id: 'u1' }, decidedAt: '2026-10-01',
        expiresAt: '2099-01-01', conditions: ['补一轮测试'], revocation: null }),
      JSON.stringify({ approvalId: 'apr-ok', subjectDigest: 'sha256:' + 'b'.repeat(64), role: 'accountable',
        identity: { source: 'local', verified: false, id: 'u2' }, decidedAt: '2026-10-01',
        expiresAt: '2099-01-01', conditions: [], revocation: null }),
    ].join('\n') + '\n', 'utf8');
    writeFileSync(join(gov, 'runtime', 'evals', 's1-2026.json'), JSON.stringify({
      schemaVersion: '1.0.0', suiteId: 's1', mode: 'replay', status: 'passed',
      summary: { total: 1, passed: 1, failed: 0, unverified: 0, passRate: 1 },
    }), 'utf8');
    const me = fileURLToPath(import.meta.url);
    const run = (projectDir) => spawnSync(process.execPath, [me], {
      encoding: 'utf8',
      env: { ...process.env, ZCODE_PROJECT_DIR: projectDir, OS_OBSERVE_HOME: join(projectDir, 'obs') },
    });
    const r = run(home);
    const out = r.stdout ?? '';
    const checks = [];
    const check = (name, ok) => checks.push([name, ok]);
    check('SessionStart 信封', r.status === 0 && out.includes('"hookEventName":"SessionStart"'));
    check('内联 policy id/version 取源', out.includes('policy p1@2'));
    check('change-set 节', out.includes('change-set'));
    check('未闭环审批节', out.includes('未闭环审批=1'));
    check('eval 节', out.includes('eval s1'));
    // legacy 顶层配置兜底（旧形态 project 仍须显示 policy id/version）
    const legacyHome = mkdtempSync(join(tmpdir(), 'tg-sess-legacy-'));
    try {
      mkdirSync(join(legacyHome, '.ai-governance'), { recursive: true });
      writeFileSync(join(legacyHome, '.ai-governance', 'config.json'),
        JSON.stringify({ policyId: 'p1', policyVersion: 2 }), 'utf8');
      const rl = run(legacyHome);
      check('legacy 顶层 policy 兜底', rl.status === 0 && (rl.stdout ?? '').includes('policy p1@2'));
    } finally { rmSync(legacyHome, { recursive: true, force: true }); }
    // 配置不可读 → 显式降级 warning（不得静默 fail-open 无声）
    const brokenHome = mkdtempSync(join(tmpdir(), 'tg-sess-broken-'));
    try {
      mkdirSync(join(brokenHome, '.ai-governance'), { recursive: true });
      writeFileSync(join(brokenHome, '.ai-governance', 'config.json'), '{bad json', 'utf8');
      const rb = run(brokenHome);
      const ob = rb.stdout ?? '';
      check('配置不可读显式降级', rb.status === 0 && ob.includes('降级') && ob.includes('config.json'));
    } finally { rmSync(brokenHome, { recursive: true, force: true }); }
    // 配置可读但政策信息整体缺失 → 显式降级（不得静默冒充 default@1）
    const noPolicyHome = mkdtempSync(join(tmpdir(), 'tg-sess-nopolicy-'));
    try {
      mkdirSync(join(noPolicyHome, '.ai-governance'), { recursive: true });
      writeFileSync(join(noPolicyHome, '.ai-governance', 'config.json'), JSON.stringify({ schemaVersion: '1.0.0' }), 'utf8');
      const rn = run(noPolicyHome);
      const on = rn.stdout ?? '';
      check('配置缺 policy 显式降级', rn.status === 0 && on.includes('降级') && on.includes('缺 policy'));
    } finally { rmSync(noPolicyHome, { recursive: true, force: true }); }
    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
    if (failed.length > 0) {
      process.stdout.write(`FAIL session-start selftest（${failed.length} 项未过；stdout=${out.slice(0, 300)}）\n`);
      process.exit(1);
    }
    process.stdout.write('SELFTEST OK session-start (tg)\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  main().catch(() => process.exit(0)); // fail-open
}
