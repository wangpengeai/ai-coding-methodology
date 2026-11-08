// 文件：governance-cli.mjs
// 描述：team-governance 统一 CLI（内部规则-8/9 / 内部需求-1/13）——init（幂等，播种内联默认
//       政策）/run-begin（真实 preflight：deny/violation 不落 run 文件）/run-finalize
//       （含 内部模块-15 自察拉取联动与可选 outcome 诚实封存）/learning-note/check（读同一归一
//       政策，不硬编码）/change-set（落 runtime/change-set.json）/lease/approve（原子
//       落盘 runtime/approvals）/gate（collectGovernanceInputs 全域收集+绑定 v1 报告）；
//       退出码 0/1/2。业务规则全在 lib/ 模块；本文件只做参数解析与编排（薄门面）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runBegin, runFinalize, manifestContentHash, RUN_ID_RE, RUN_OUTCOMES } from './lib/run-manifest.mjs';
import { preflight } from './lib/policy.mjs';
import { createChangeSet, changeSetDigest } from './lib/change-set.mjs';
import { acquireLease, renewLease, releaseLease, isValidResourceToken } from './lib/lease.mjs';
import { recordApproval, isValidExpiresAt, isUsableIdentity } from './lib/approval.mjs';
import { buildReport } from './lib/governance-gate.mjs';
import { checkContexts, registerContext } from './lib/context-trust.mjs';
import { loadGovernanceConfig, collectGovernanceInputs, computeBinding,
         persistApproval, persistChangeSet, atomicWriteText, DEFAULT_ALLOWED_MODELS } from './lib/governance-store.mjs';
import { promoteLearning } from './lib/learning.mjs';
import { appendObserved } from './lib/learning-store.mjs';
import { atomicWriteJson } from './lib/atomic-write.mjs';
import { isIoError } from './lib/io-errors.mjs';
import { VALID_HOSTS } from './lib/client-info.mjs';
import { redactChecked, redactSigned, RedactionResidualError } from './lib/redaction.mjs';
import { pullIncidentRefs, incidentExists } from './lib/incident-source.mjs';
import { install as osObserveInstall, uninstall as osObserveUninstall, statusReport as osObserveStatusReport } from './lib/os-observe-tasks.mjs';
import { syncRawToFindings } from './lib/os-observe-pipeline.mjs';
import { appendStatus, osObserveHome, readFindings, resolveFindingId } from './lib/os-observe-store.mjs';
import { isValidRulePattern, appendUserRule } from './lib/os-observe-classify.mjs';
import { runOsObserve } from './adapters/os-observe.mjs';
import { sysmonGuide, sysmonEnable, sysmonDisable } from './adapters/os-observe-sysmon.mjs';
import { dnsGuide, dnsEnable, dnsDisable } from './adapters/os-observe-linux-dns.mjs';
import { validateEnvelope } from './adapters/contract.mjs';

/** 取可重复选项的全部值（--evidence-ref v1 --evidence-ref v2）。 */
function opts(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && typeof args[i + 1] === 'string') out.push(args[i + 1]);
  }
  return out;
}

const EXIT_OK = 0;
const EXIT_CONTENT = 1;
const EXIT_TOOL = 2;
const EXIT_DEFERRED = 99; // 哨兵非真实退出码：异步自管分支（sysmon-enable）专用

function usage() {
  return [
    '用法：node governance-cli.mjs --project-root <dir> <command> [args]',
    '  init                                  幂等接入（写 .ai-governance/config.json，播种内联默认政策；已有配置不覆写）',
    '  run-begin --task-id T [--policy p1] [--initiator ID] [--host zcode|dsh|mcode|kimi|unknown]',
    '                                       开启受治理 run（先跑真实 policy preflight：deny/violation 拒开且不落 run 文件；模型不可观察自动 unavailable）',
    '                                       （riskLevel=high 时 --initiator 必填——产品面不得静默不可归属；stdout 增 openHash 供 finalize CAS）',
    '  run-finalize --run-id R --repo-head S --diff-digest D [--evidence-ref E ...]',
    '                                        [--outcome completed|cancelled|failed] [--reason S] [--expect-hash sha256:<64>]',
    '                                        （outcome 缺省 completed；cancelled/failed 必填 reason——诚实封存，取消不冒充成功；',
    '                                          --expect-hash 为 run-begin 的 openHash，不符退 2（CAS）；',
    '                                          无显式 --evidence-ref 时自动拉取项目根 .workflow/incidents.jsonl 的 open 自察异常，M15）',
    '  learning-note --statement S --incident <id> [--owner O]',
    '                                        自察异常沉淀为 observed 态 learning（M15）',
    '  check --contexts-file <contexts.json> policy preflight + 上下文检查（读归一后政策：strict 不可观察 deny、relaxed warning；',
    '                                        无 contexts/文件不可读/条目非法一律参数错退 2——不得空转）',
    '  change-set --repos a,b [--resources r1,r2] [--out <file>]',
    '                                        （落 .ai-governance/runtime/change-set.json；--out 另导出副本）',
    '  lease acquire --resource R | --resources r1,r2 [--holder H] [--all-or-nothing]',
    '                                        （--resource/--resources 互斥且必填其一；--holder 缺省 manual；参数错退 2）',
    '  lease renew --lease-id L --revision N  （过期 holder 的 renew 拒绝退 1——先 release 清理或重新 acquire）',
    '  lease release --lease-id L --revision N（不设过期守卫：过期记录经此进入 released 终态，审计清理通道）',
    '  approve [--subject-digest D] --role accountable --identity ID [--expires-at YYYY-MM-DD]',
    '                                        （审批原子落 runtime/approvals；本地登记恒 local-attested；--subject-digest 仅一致性断言，',
    '                                          当前 subject 由当前项目现算——已验证身份只能来自白名单源 approval.mjs VERIFIED_SOURCES）',
    '  gate                                  出治理报告（唯一聚合出口；含 binding/sources/coverage 绑定 v1 三节）',
    '  os-observe install [--poll-minutes N] 安装 OS 外发观测采集（幂等；用户级，不依赖 --project-root；win32/linux/darwin 注册周期调度——darwin=launchd LaunchAgent，会话机会式补位兜底）',
    '  os-observe uninstall                   对称移除调度（win32 计划任务/linux crontab/darwin LaunchAgent；findings/config 保留，不销账）',
    '  os-observe status                      采集在装/新鲜度/发现计数（只读）',
    '  os-observe list [--class C] [--status S] 列出发现（折叠视图，读侧 fail-open）',
    '  os-observe ack <id|前缀≥4> [--note S]  确认可疑发现（写侧 IO 错误退 2；内容错退 1）',
    '  os-observe allow <pattern|id|前缀≥4>  加白名单（写 config.allow；id 命中取该 finding 端点；域名 glob(* 通配)/IP/CIDR）',
    '  os-observe deny <pattern|id|前缀≥4>   加用户可疑（写 config.suspicious；同 allow 参形态）',
    '  os-observe report                      出 IF-ADAPTER-1 信封（只读面）',
    '  os-observe sysmon-guide                win-sysmon 扩展位启用引导（四要素+步骤，只读，NFR-tg-supplychain）',
    '  os-observe sysmon-enable               下载→签名核验记账→UAC 提权装驱动+一次性 Event Log Readers 授予→非提权注册采集任务（重登后生效，TASK-SYSMON-1）',
    '  os-observe sysmon-disable              移除 Sysmon 采集计划任务（驱动卸载属用户决策面，见输出引导）',
    '  os-observe dns-guide                   linux-dns-tcpdump 扩展位启用引导（四要素+步骤，只读，不代装，NFR-tg-supplychain）',
    '  os-observe dns-enable                  包校验+sha256 记账→部署 root 属主载体（/var/lib/os-observe-dns）→sudo 写 root crontab 保活（tcpdump 常驻监听 port 53）+用户 crontab 转换器（TASK-OBSO-LINUX-1；H10 修复 DEV-281）',
    '  os-observe dns-disable                 移除 DNS 保活/转换器条目并停监听进程（新旧载体均清理；spool/provenance 不销账）',
  ].join('\n');
}

function emit(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function opt(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function dispatch() {
  const argv = process.argv.slice(2);
  let root = opt(argv, '--project-root') ?? '.';
  root = resolve(root);
  const rest = argv.filter((a, i) => a !== '--project-root' && argv[i - 1] !== '--project-root');
  const command = rest[0];
  const args = rest.slice(1);

  switch (command) {
    case 'init': {
      const dir = join(root, '.ai-governance');
      const configPath = join(dir, 'config.json');
      if (existsSync(configPath)) {
        emit({ ok: true, note: '已接入（幂等：不覆写既有配置）', configPath });
        return EXIT_OK;
      }
      // 播种运行态目录（evals/approvals/learnings 为 内部任务-5 C 新读写面）
      for (const sub of ['runs', 'leases', 'reports', 'evals', 'approvals', 'learnings']) {
        mkdirSync(join(dir, 'runtime', sub), { recursive: true });
      }
      // 内部任务-5 C（内部规则-9）：播种内联默认政策（config.policy 为权威源；最小明确配置）
      atomicWriteJson(configPath, {
        schemaVersion: '1.0.0',
        policy: { id: 'default', version: 1, riskLevel: 'medium',
          allowedModels: DEFAULT_ALLOWED_MODELS, fallbacks: [], enforcement: 'relaxed' },
        requiredDomains: [],
        approvalProfile: 'default',
        evalSuiteFiles: [], evalReportFiles: [], learningFiles: [],
        createdAt: new Date().toISOString(),
      });
      emit({ ok: true, created: configPath });
      return EXIT_OK;
    }
    case 'run-begin': {
      const taskId = opt(args, '--task-id');
      if (!taskId) { console.error('run-begin 需要 --task-id'); return EXIT_TOOL; }
      // 内部任务-5 C（内部规则-9/内部接口-14）：先跑真实 preflight——deny/violation 拒开且不落
      // run 文件；warning 留痕继续。政策来自归一后 config（不再硬编码 relaxed）；
      // 配置缺失/损坏/引用越界由 store 抛错、经 main 统一收口为工具错退 2。
      const { policy } = loadGovernanceConfig(root);
      // 内部任务-254（H2）：highRisk 必须显式 --initiator（缺失/空白/旗标当值＝参数错退 2，不落 run 文件）
      const rawInitiator = opt(args, '--initiator');
      const initiator = rawInitiator === undefined ? undefined : String(rawInitiator).trim();
      if (initiator !== undefined && initiator.startsWith('--')) {
        console.error(`run-begin：--initiator 取值非法（收到旗标当值「${initiator}」）——请给出身份 id`);
        return EXIT_TOOL;
      }
      if (policy.riskLevel === 'high' && (initiator === undefined || initiator === '')) {
        console.error('run-begin：riskLevel=high 政策必须 --initiator <id>（产品面不得静默不可归属/不可判自批）');
        return EXIT_TOOL;
      }
      const pf = preflight(policy, { modelObserved: null, requiredCapability: 'code' });
      if (pf.decision === 'deny' || pf.decision === 'violation') {
        emit({ ok: false, preflight: pf, note: 'preflight 拒绝——未创建 run 文件' });
        console.error(`run-begin preflight ${pf.decision}：${pf.reason}（零 run 文件落盘）`);
        return EXIT_CONTENT;
      }
      // 内部任务-256（H9）：--host 显式指定审计宿主（缺省由 lib/client-info 环境探测；非法值/旗标当值退 2）
      const rawHost = opt(args, '--host');
      let clientHost;
      if (rawHost === undefined && args.includes('--host')) {
        console.error('run-begin：--host 缺值（须 <zcode|dsh|mcode|kimi|unknown>）');
        return EXIT_TOOL;
      }
      if (rawHost !== undefined) {
        const h = String(rawHost).trim();
        if (!VALID_HOSTS.includes(h)) {
          console.error(`run-begin：--host 取值非法（收到「${h}」，须 ∈ ${VALID_HOSTS.join('|')}）`);
          return EXIT_TOOL;
        }
        clientHost = h;
      }
      const manifest = runBegin(root, { taskId, policyRef: opt(args, '--policy'),
        ...(clientHost !== undefined ? { clientHost } : {}),
        ...(initiator !== undefined && initiator !== '' ? { initiator } : {}) });
      // H7：stdout 增 openHash（open manifest body 的 integrityHash；finalize --expect-hash CAS 锚）
      emit({ ok: true, ...manifest, openHash: manifestContentHash(manifest), preflight: pf });
      return EXIT_OK;
    }
    case 'run-finalize': {
      const runId = opt(args, '--run-id');
      const repoHead = opt(args, '--repo-head');
      const diffDigest = opt(args, '--diff-digest');
      if (!runId || !repoHead || !diffDigest) { console.error('run-finalize 需要 --run-id/--repo-head/--diff-digest'); return EXIT_TOOL; }
      // 2026-09-19 评审修复（安全面 N）：runId 形态前置校验——非法形态属参数错（退 2），
      // 不进内容错通道；runId 直拼 manifestPath，无校验可越界读+覆写（形态与生成面单源 RUN_ID_RE）
      if (!RUN_ID_RE.test(runId)) {
        console.error(`run-finalize：runId 非法（收到「${runId}」，生成形态 run-<uuid 前 12 字符>）`);
        return EXIT_TOOL;
      }
      // 内部任务-5 C（内部规则-4 扩义）：outcome 参数面校验（参数错退 2；语义校验在 lib 双保险）
      const outcome = opt(args, '--outcome') ?? 'completed';
      const reason = opt(args, '--reason');
      if (!RUN_OUTCOMES.has(outcome)) {
        console.error(`run-finalize：outcome 非法（收到「${outcome}」，枚举 completed|cancelled|failed）`);
        return EXIT_TOOL;
      }
      if (outcome !== 'completed' && (typeof reason !== 'string' || reason.trim() === '')) {
        console.error(`run-finalize：outcome=${outcome} 必填 --reason（诚实封存：取消/失败须留可审计理由）`);
        return EXIT_TOOL;
      }
      // 内部模块-15 拉取联动：--evidence-ref 显式传入优先；否则自动拉取 open 自察异常 digest
      const explicitRefs = opts(args, '--evidence-ref');
      const incidentPull = explicitRefs.length > 0
        ? { refs: explicitRefs, unavailable: false }
        : pullIncidentRefs(root);
      const evidenceRefs = incidentPull.refs;
      if (incidentPull.unavailable) {
        // 内部任务-257（P5-4）：incident 源存在但不可读——按 unavailable 处理，不冒充「无异常」
        console.error('run-finalize：incident 源不可读（.workflow/incidents.jsonl）——evidenceReferences 按 unavailable 处理，不冒充无异常');
      }
      // 内部任务-254（H7）：--expect-hash CAS 参数面（形态非法即参数错退 2）
      const expectHash = opt(args, '--expect-hash');
      if (expectHash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(expectHash))) {
        console.error(`run-finalize：--expect-hash 形态非法（收到「${String(expectHash)}」，须 sha256:<64hex>）`);
        return EXIT_TOOL;
      }
      // 绑定 digest（finalized manifest 记 policy/change-set digest 供 gate stale 复核）
      const { config, policy } = loadGovernanceConfig(root);
      const binding = computeBinding(root, config, policy);
      try {
        const finalized = runFinalize(root, runId, { repoHead, diffDigest, evidenceRefs, outcome, reason,
          ...(expectHash !== undefined ? { expectHash } : {}),
          policyDigest: binding.policyDigest, changeSetDigest: binding.changeSetDigest });
        emit({ ok: true, ...finalized });
        return EXIT_OK;
      } catch (e) {
        // 内部任务-254 错误码收口：finalize 异常一律工具错退 2（原 generic catch 退 1 是已知需修点）
        console.error(String(e.message));
        return EXIT_TOOL;
      }
    }
    case 'learning-note': {
      const statement = opt(args, '--statement');
      const incidentId = opt(args, '--incident');
      const owner = opt(args, '--owner') ?? 'unknown';
      if (!statement || !incidentId) { console.error('learning-note 需要 --statement/--incident'); return EXIT_TOOL; }
      // 悬空证据拒绝（评审 R-8）：--incident 必须指向项目根工件中真实存在的记录
      if (!incidentExists(root, incidentId)) { console.error(`incident ${incidentId} 不存在于 .workflow/incidents.jsonl（learning 的证据必须真实指向）`); return EXIT_CONTENT; }
      // observed 也要有证据指向（learning.mjs 纪律）：证据即自察异常记录 id
      const evidenceReferences = [`.workflow/incidents.jsonl#${incidentId}`];
      try {
        const learning = promoteLearning(
          { learningId: `L-${Date.now().toString(36)}`, statement, scope: 'self-observability' },
          'observed',
          { owner, evidenceReferences },
        );
        const stored = appendObserved(root, { ...learning, sourceIncidentId: incidentId });
        if (!stored.ok) {
          console.error(`learning 落盘失败（${stored.error ?? 'unknown'}）`);
          return isIoError(stored) ? EXIT_TOOL : EXIT_CONTENT;
        }
        emit({ ok: true, ...redactChecked(learning) });
        return EXIT_OK;
      } catch (e) {
        console.error(String(e.message));
        return e instanceof RedactionResidualError ? EXIT_TOOL : EXIT_CONTENT;
      }
    }
    case 'check': {
      // 内部任务-5 C（内部规则-9）：读归一后政策做 preflight（不再硬编码 relaxed——strict 下
      // 模型不可观察必须 deny）+ 上下文检查（checkContexts 是上下文判定的唯一实现）。
      // 内部任务-254（H14）：check 不得空转——`--contexts-file` 为唯一输入载体；缺旗标/文件
      // 不存在/坏 JSON/空清单/条目非法一律参数错退 2＋usage；配置错经 main 统一收口退 2。
      const usageHint = '用法：node governance-cli.mjs --project-root <dir> check --contexts-file <contexts.json>\n'
        + '  contexts.json 为上下文登记数组（每项 {source, trust, digest?, retrievedAt?}；trust 取 R-M12-6 七级）——无 contexts 不空转。';
      const contextsFile = opt(args, '--contexts-file');
      if (contextsFile === undefined || String(contextsFile).trim() === '') {
        console.error(`check 需要 --contexts-file <path>（无 contexts 不空转）\n${usageHint}`);
        return EXIT_TOOL;
      }
      const { policy } = loadGovernanceConfig(root);
      let rawContexts;
      try {
        rawContexts = JSON.parse(readFileSync(resolve(root, String(contextsFile)), 'utf8'));
      } catch (e) {
        console.error(`check：contexts 文件不存在或不可解析（${contextsFile}）：${e.message}\n${usageHint}`);
        return EXIT_TOOL;
      }
      if (!Array.isArray(rawContexts) || rawContexts.length === 0) {
        console.error(`check：contexts 清单为空（无 contexts 不空转）\n${usageHint}`);
        return EXIT_TOOL;
      }
      let contexts;
      try {
        contexts = [];
        for (const c of rawContexts) {
          if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.source !== 'string' || !c.source) {
            throw new Error('条目须为对象且含非空 source');
          }
          registerContext(contexts, c); // trust 非法等在此抛（参数错）
        }
      } catch (e) {
        console.error(`check：contexts 条目非法——${e.message}\n${usageHint}`);
        return EXIT_TOOL;
      }
      const pf = preflight(policy, { modelObserved: null, requiredCapability: 'code' });
      const contextDiagnostics = checkContexts(contexts, { riskLevel: policy.riskLevel });
      emit({ ok: pf.decision === 'allow' || pf.decision === 'warning', preflight: pf, contexts: contextDiagnostics });
      return pf.decision === 'deny' ? EXIT_CONTENT : EXIT_OK;
    }
    case 'change-set': {
      const repos = (opt(args, '--repos') ?? '').split(',').filter(Boolean).map((repoId) => ({ repoId }));
      const resources = (opt(args, '--resources') ?? '').split(',').filter(Boolean);
      try {
        const cs = createChangeSet({ repos, resources });
        const digest = changeSetDigest(cs);
        // 内部任务-5 C（内部规则-9）：权威落 runtime/change-set.json（digest 重算校验在 store 内）
        const persisted = persistChangeSet(root, { changeSet: cs, digest });
        const out = { ok: true, changeSet: cs, digest, persistedPath: persisted.path };
        if (opt(args, '--out')) {
          // 评审 S3 处置：--out 落盘到指定文件（导出副本；原实现两臂相同是死旗标）
          writeFileSync(opt(args, '--out'), JSON.stringify({ ok: true, changeSet: cs, digest }, null, 2) + '\n', 'utf8');
        }
        emit(out);
        return EXIT_OK;
      } catch (e) { console.error(String(e.message)); return EXIT_TOOL; }
    }
    case 'lease': {
      const sub = args[0];
      // 2026-09-19 评审修复 H5：状态损坏=工具错误（退 2），不混入内容阻断（退 1）——
      // 损坏态上拒绝读改写，文案指引人工核对（LeaseStateCorruptError 语义见 lease.mjs）
      try {
        if (sub === 'acquire') {
          // 内部任务-252 批 1a（C3）：必填参数面校验（参数错退 2，不落台账）——内部规则-8/内部规则-9
          // 内部任务-252 评审修复：取值先 trim 归一（前导/尾随空白与逗号后空格不再是死键），元素级合法性
          // 复用 lib 单源谓词 isValidResourceToken——一层放行一层拒的分叉会静默破坏互斥/钩子护栏。
          const rawSingle = opt(args, '--resource');
          const single = rawSingle === undefined ? undefined : rawSingle.trim();
          const rawList = opt(args, '--resources');
          const resources = rawList === undefined ? [] : rawList.split(',').map((s) => s.trim());
          if (single === undefined && resources.length === 0) { console.error('lease acquire 需要 --resource 或 --resources'); return EXIT_TOOL; }
          if (single !== undefined && resources.length > 0) { console.error('--resource 与 --resources 互斥'); return EXIT_TOOL; }
          // 空/纯空白元素＝参数错（不得静默过滤：过滤会旁路元素级校验并与 lib 双保险分叉）
          if (resources.some((r) => r === '')) { console.error('--resources 含空元素（空值或逗号尾随）'); return EXIT_TOOL; }
          if (single !== undefined && !isValidResourceToken(single)) {
            console.error(`--resource 取值非法：「${rawSingle}」（不得为空或以 -- 开头）`);
            return EXIT_TOOL;
          }
          const badResource = resources.find((r) => !isValidResourceToken(r));
          if (badResource !== undefined) {
            console.error(`--resources 含非法元素：「${badResource}」（不得为空或以 -- 开头）`);
            return EXIT_TOOL;
          }
          const holder = (opt(args, '--holder') ?? 'manual').trim();
          if (holder === '') { console.error('--holder 不得为空（缺省用 manual）'); return EXIT_TOOL; }
          const req = { resource: single, resources: resources.length ? resources : undefined,
                        holder, allOrNothing: args.includes('--all-or-nothing') };
          const r = acquireLease(root, req);
          emit(r);
          // 内部任务-257（P5-6）：锁/IO 错误（带 code）按工具错退 2；内容/占用错退 1
          return r.ok ? EXIT_OK : (isIoError(r) ? EXIT_TOOL : EXIT_CONTENT);
        }
        if (sub === 'renew' || sub === 'release') {
          // 内部任务-252 批 1a（C3）：lease-id/revision 必填校验（参数错退 2）
          const leaseId = opt(args, '--lease-id');
          if (!leaseId) { console.error(`lease ${sub} 需要 --lease-id`); return EXIT_TOOL; }
          const revision = Number(opt(args, '--revision'));
          if (!Number.isInteger(revision) || revision < 1) {
            console.error(`lease ${sub} 需要正整数 --revision（收到 ${opt(args, '--revision') ?? '(缺)'}）`);
            return EXIT_TOOL;
          }
          const req = { leaseId, revision };
          const r = sub === 'renew' ? renewLease(root, req) : releaseLease(root, req);
          emit(r);
          // 内部任务-257（P5-6）三维评审修复：lock/IO 错误（带 code）按工具错退 2，与 acquire 分支一致
          return r.ok ? EXIT_OK : (isIoError(r) ? EXIT_TOOL : EXIT_CONTENT);
        }
      } catch (e) {
        console.error(`lease ${sub ?? ''}：${e.message}`);
        return EXIT_TOOL;
      }
      console.error('lease 需要 acquire|renew|release'); return EXIT_TOOL;
    }
    case 'approve': {
      // 评审 C7 处置①：本地 CLI 登记一律 local-attested（verified 恒 false）——
      // strict 策略的已验证身份只能来自白名单源（github-review/sso 等），不可旗标自证
      // 内部任务-5 C（内部规则-3 扩义/内部接口-16）：审批绑定当前 subject（由当前项目现算），
      // 经 recordApproval 后原子落盘 runtime/approvals；--subject-digest 仅一致性断言
      // （传过期快照≠当前 subject 即拒）。配置/绑定错误经 main 统一收口退 2。
      const { config, policy } = loadGovernanceConfig(root);
      const subject = computeBinding(root, config, policy).subject;
      const asserted = opt(args, '--subject-digest');
      if (asserted !== undefined && asserted !== subject) {
        console.error(`--subject-digest 与当前 subject 不一致（传入 ${String(asserted).slice(0, 16)}… vs 当前 ${subject.slice(0, 16)}…）——审批必须绑定当前对象，不接受过期快照`);
        return EXIT_CONTENT;
      }
      // H6（内部任务-254）：--expires-at 严格 YYYY-MM-DD（真实日期）——非法参数属工具错退 2
      const expiresRaw = opt(args, '--expires-at');
      if (expiresRaw !== undefined && !isValidExpiresAt(expiresRaw)) {
        console.error(`approve：--expires-at 形态非法（收到「${String(expiresRaw)}」，须真实 YYYY-MM-DD 且补零）`);
        return EXIT_TOOL;
      }
      // 内部任务-254（H2「独立审批」）：身份必须可归属（非空且非 unknown）——否则不构成有效
      // 独立审批，会允许 highRisk 自批被匿名审批降档绕过（三维评审正确性阻塞 B1）。
      const identityId = opt(args, '--identity');
      if (!isUsableIdentity(identityId)) {
        console.error('approve：必须 --identity <id>（非空且非 unknown——审批身份须可归属，匿名审批不构成有效独立审批）');
        return EXIT_TOOL;
      }
      const record = {
        subjectDigest: subject,
        role: opt(args, '--role') ?? 'accountable',
        identity: { source: 'local', verified: false, id: identityId,
                    note: 'local-attested（CLI 登记，非已验证身份源）' },
        decidedAt: new Date().toISOString().slice(0, 10),
        expiresAt: expiresRaw ?? '2099-01-01',
      };
      const r = recordApproval(record, { executor: opt(args, '--executor'), highRisk: args.includes('--high-risk') });
      if (!r.ok) { emit(r); return EXIT_CONTENT; }
      let persisted;
      try {
        persisted = persistApproval(root, r.approval);
      } catch (e) { console.error(`审批落盘失败（runtime/approvals）：${e.message}`); return EXIT_TOOL; }
      emit({ ok: true, approval: r.approval, subjectDigest: subject, persistedPath: persisted.path });
      return EXIT_OK;
    }
    case 'gate': {
      // 内部任务-5 C（内部规则-9/内部规则-4/12）：经 collectGovernanceInputs 全域收集（config/policy/
      // runs/leases/approvals/evals/learnings/change-set + 配置引用；坏件点名不吞集）后
      // buildReport——报告含 binding/sources/coverage 三节（绑定 v1）；收集/写盘错误经
      // main 统一收口退 2。
      const collected = collectGovernanceInputs(root);
      const { report, blockingCount } = buildReport({
        ...collected.parts,
        binding: collected.binding,
        sources: { refs: collected.sourceRefs, inventory: collected.sourceInventory },
        coverage: collected.coverage,
      });
      const reportPath = join(root, '.ai-governance', 'runtime', 'reports', 'governance-report.json');
      // 内部任务-255（H12）：报告落盘/输出前必经脱敏（残余命中/结构节命中抛 RedactionResidualError → main 收口退 2）
      const safeReport = redactSigned(report);
      atomicWriteText(reportPath, JSON.stringify(safeReport, null, 2) + '\n');
      emit({ ok: blockingCount === 0, reportPath, status: safeReport.status,
             blockingCount, warningCount: safeReport.warningCount,
             coverage: safeReport.coverage, validUntil: safeReport.binding?.validUntil ?? null,
             diagnostics: safeReport.diagnostics });
      return blockingCount === 0 ? EXIT_OK : EXIT_CONTENT;
    }
    case 'os-observe': {
      // 用户级操作（~/.zcode/os-observe/，内部决策-029）：不依赖 --project-root（内部规则-8/内部规则-11）
      const sub = args[0];
      const subArgs = args.slice(1);
      if (sub === 'install') {
        const pmRaw = opt(subArgs, '--poll-minutes');
        const r = osObserveInstall({ pollMinutes: pmRaw === undefined ? 5 : Number(pmRaw) });
        emit(r);
        if (r.usage) return EXIT_TOOL;
        return r.ok ? EXIT_OK : EXIT_CONTENT;
      }
      if (sub === 'uninstall') {
        const r = osObserveUninstall();
        emit(r);
        return r.ok ? EXIT_OK : EXIT_CONTENT;
      }
      if (sub === 'status') {
        emit(osObserveStatusReport()); // 只读：读取问题以降级字段呈现，恒退 0（读侧 fail-open）
        return EXIT_OK;
      }
      if (sub === 'list') {
        const home = osObserveHome();
        syncRawToFindings(home, { maxRows: 2000 });
        const cls = opt(subArgs, '--class');
        const st = opt(subArgs, '--status');
        let rows = [...readFindings(home).values()];
        if (cls) rows = rows.filter((f) => f.class === cls);
        if (st === 'open') rows = rows.filter((f) => f.class === 'suspicious' && f.status !== 'acknowledged');
        else if (st === 'acknowledged') rows = rows.filter((f) => f.status === 'acknowledged');
        rows.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
        emit(rows);
        return EXIT_OK;
      }
      if (sub === 'ack') {
        const id = subArgs[0];
        const note = opt(subArgs, '--note');
        if (!id || id.startsWith('--')) { console.error('ack 需要 <id|唯一前缀≥4> [--note S]'); return EXIT_TOOL; }
        try {
          const full = resolveFindingId(osObserveHome(), id);
          appendStatus(osObserveHome(), full, { status: 'acknowledged', note });
          emit({ ok: true, id: full, note });
          return EXIT_OK;
        } catch (e) { console.error(String(e.message)); return isIoError(e) ? EXIT_TOOL : EXIT_CONTENT; }
      }
      if (sub === 'allow' || sub === 'deny') {
        const arg = subArgs[0];
        if (!arg || arg.startsWith('--')) { console.error(`${sub} 需要 <pattern|id|唯一前缀≥4>`); return EXIT_TOOL; }
        let pattern = arg;
        let resolvedFrom = null;
        // id/前缀形态锚定生产 id 命名空间（of-<hex>）：of- 开头走 id 解析（未知/歧义/无端点显式失败，
        // 不得把 id 文本当 pattern 静默落盘——终审正确性 1）；其余一律 pattern。输出 resolvedFrom 明示走向。
        if (arg.startsWith('of-')) {
          let full;
          try {
            full = resolveFindingId(osObserveHome(), arg);
          } catch (e) { console.error(String(e.message)); return EXIT_CONTENT; }
          const f = readFindings(osObserveHome()).get(full);
          if (!f || !f.endpoint) { console.error(`finding ${full} 无端点（parse-error 行）——无可加规则的端点`); return EXIT_CONTENT; }
          pattern = f.endpoint;
          resolvedFrom = { id: full, endpoint: pattern };
        }
        if (!isValidRulePattern(pattern)) { console.error(`非法 pattern（须为域名 glob（* 通配）或 IP/CIDR）：${pattern}`); return EXIT_TOOL; }
        try {
          const r = appendUserRule({ kind: sub, pattern, home: osObserveHome() });
          emit({
            ok: true, kind: sub, pattern: r.pattern, added: r.added, resolvedFrom, list: r.list,
            note: r.added
              ? `已加入 config.${sub === 'allow' ? 'allow' : 'suspicious'}${sub === 'deny' ? '（deny→suspicious 映射）' : ''}；下一轮采集（≤pollMinutes 分钟）该端点自动重分类，未确认计数随之自愈`
              : '已在列表中（幂等，无变更）',
          });
          return EXIT_OK;
        } catch (e) { console.error(String(e.message)); return isIoError(e) ? EXIT_TOOL : EXIT_CONTENT; }
      }
      if (sub === 'report') {
        const { envelope } = runOsObserve();
        const diags = validateEnvelope(envelope);
        if (diags.length > 0) { console.error(diags.map((d) => d.message).join('; ')); return EXIT_TOOL; }
        emit(envelope);
        return EXIT_OK;
      }
      if (sub === 'sysmon-guide') {
        emit(sysmonGuide());
        return EXIT_OK;
      }
      if (sub === 'sysmon-enable') {
        // 写面（下载/记账/UAC 安装）：失败可见退 1；引导先行=用户已可经 sysmon-guide 看四要素。
        // 异步自管退出（fetch/UAC 链在 .then 内 process.exit）——返回 DEFERRED 哨兵，
        // 外层 main 收口不得先于异步链退出（阶段门正确性处置 2026-09-19）
        sysmonEnable().then((r) => {
          emit(r);
          process.exit(r.ok ? EXIT_OK : r.availability ? EXIT_TOOL : EXIT_CONTENT);
        }, (e) => { console.error(String(e?.message ?? e)); process.exit(EXIT_TOOL); });
        return EXIT_DEFERRED;
      }
      if (sub === 'sysmon-disable') {
        const r = sysmonDisable();
        emit(r);
        return r.ok ? EXIT_OK : EXIT_CONTENT;
      }
      if (sub === 'dns-guide') {
        // 四要素引导只读（NFR-tg-supplychain；不代装系统包——用户裁决 2026-09-20）
        emit(dnsGuide());
        return EXIT_OK;
      }
      if (sub === 'dns-enable') {
        // 写面（记账+crontab 双条目）：全同步（无下载链）——失败可见；usage/needInstall/availability 分因退码
        const r = dnsEnable();
        emit(r);
        if (r.usage) return EXIT_TOOL;
        return r.ok ? EXIT_OK : r.availability ? EXIT_TOOL : EXIT_CONTENT;
      }
      if (sub === 'dns-disable') {
        const r = dnsDisable();
        emit(r);
        return r.ok ? EXIT_OK : EXIT_CONTENT;
      }
      console.error('os-observe 需要 install|uninstall|status|list|ack|allow|deny|report|sysmon-guide|sysmon-enable|sysmon-disable|dns-guide|dns-enable|dns-disable');
      return EXIT_TOOL;
    }
    case undefined:
      console.error(usage());
      return EXIT_TOOL;
    default:
      console.error(`未知命令：${command}\n${usage()}`);
      return EXIT_TOOL;
  }
}

/**
 * 统一薄门面（2026-09-19 评审修复，错误处理 N）：dispatch 内未收口分支（run-begin/
 * init/gate 报告写盘/os-observe install 的 FS 与内部异常）原裸穿透——裸栈 + 默认退 1
 * 占用内容错语义；此处统一收口为工具错误（退 2）+ 可读一行。既有分支内显式 catch
 * （内容错退 1）优先命中，不受本层影响。
 * @returns {number} 退出码
 */
function main() {
  try {
    return dispatch();
  } catch (e) {
    console.error(`governance-cli：命令执行失败（${e.message}）——工具错误`);
    return EXIT_TOOL;
  }
}

// 异步自管分支哨兵：sysmon-enable 的下载/UAC 链在 .then 内自管退出码，
// 外层不得先于异步链 process.exit（阶段门正确性处置 2026-09-19）
const rc = main();
if (rc !== EXIT_DEFERRED) process.exit(rc);
