// 文件：agent-eval.mjs
// 描述：Agent 行为评测 CLI（内部接口-17 / 内部验收-1 / 内部验收-25）——replay 优先（离线跑确定性
//       oracle）；live stdio 显式 opt-in（--live-adapter）。退出码 0=通过、1=内容阻断/未验证、
//       2=工具/参数错误。内部任务-5 C（内部规则-9）：replay 报告默认权威持久化
//       .ai-governance/runtime/evals/（gate 消费该目录）；--out 仅导出副本，不自动权威。
//       2026-10-29 内部任务-253（C1 修复）：live 路径完整化——非空 suite 握手、逐 case subjectHash 预检、
//       transport 失败先分流（spawn/超时/上限/不可解析→unverified 退 1；非零退出→工具错误退 2）、
//       parsed 经 validateEnvelope（非法→工具错误退 2）、single-source 判定、report/manifest/transcript
//       三件经 scanSecrets+redact（落盘本为脱敏版）后权威落盘，gate 只收 replay（由 store/spec-gate 过滤）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

import { atomicWriteText as libAtomicWriteText } from './lib/atomic-write.mjs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';

import { runReplaySuite, validateSuiteShape, EvalSuiteShapeError } from './lib/eval.mjs';
import { runStdioAdapter } from './adapters/stdio.mjs';
import { validateEnvelope } from './adapters/contract.mjs';
import { persistEvalReport } from './lib/governance-store.mjs';
import { integrityHash } from './lib/canonical-json.mjs';
import { scanSecrets, redact, redactSigned, RedactionResidualError } from './lib/redaction.mjs';
import { SchemaError } from './lib/json-schema.mjs';

const EXIT_OK = 0;
const EXIT_CONTENT = 1;
const EXIT_TOOL = 2;

function usage() {
  return [
    '用法：node agent-eval.mjs --project-root <dir> --suite <suite.json> --subject-hash <sha256> [options]',
    '  --suite <file>          评测套件（cases 数组，每 case 含 subjectHash/events/oracles）',
    '  --subject-hash <sha>    当前被测对象哈希（skill/agent/prompt canonical）',
    '  --live-adapter <cmd>    live stdio 适配器（脚本路径或内联代码；须实现 capability=agent-eval 握手）',
    '                          适配器末行 JSON 须为 IF-ADAPTER-1 §2 合法信封（schemaVersion/adapter/capability/request/',
    '                          result:{status,summary,可选 results:[{caseId,status,reason?}]}/availability/externalEffects/',
    '                          correlation.runId）；合法结果必须 exit 0；非零退出=进程异常（退 2）',
    '  --out <file>            导出 replay 报告副本（权威报告默认落 .ai-governance/runtime/evals/）',
    '  --selftest              冒烟自检',
    '退出码：0=passed；1=failed/unverified（内容面）；2=工具/参数/进程异常/信封非法',
  ].join('\n');
}

function opt(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function emit(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 原子写（tmp + rename）：落盘失败由调用方统一映射为工具错误退 2。 */
function atomicWriteText(file, content) {
  libAtomicWriteText(file, content);
}

function evalsDir(projectRoot) {
  return join(projectRoot, '.ai-governance', 'runtime', 'evals');
}

/** 工具错误分支：只写 error manifest（内部接口-17 §4），不写 report/transcript。 */
function writeErrorManifest({ suiteId, projectRoot, failureKind, detail, adapterExitCode, subjectHash, command, startedAt }) {
  try {
    const dir = evalsDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifest = redact({
      schemaVersion: '1.0.0',
      mode: 'live',
      runId: `live-${stamp}`,
      adapter: 'stdio',
      capability: 'agent-eval',
      command,
      startedAt,
      finishedAt: Date.now(),
      adapterExitCode: adapterExitCode ?? null,
      subjectHash,
      transcriptDigest: null,
      reportPath: null,
      status: 'tool-error',
      failureKind,
      detail,
    });
    if (scanSecrets(manifest).length > 0) return { ok: false, path: null };
    const name = `${suiteId}-live-${stamp}-manifest.json`;
    writeFileSync(join(dir, name), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { ok: true, path: `.ai-governance/runtime/evals/${name}`, manifest };
  } catch {
    return { ok: false, path: null };
  }
}

/** 构建/落盘 live 三件（report/manifest/transcript）：先校验脱敏，再算 digest/integrityHash，再写（原子写，失败退 2）。 */
function persistLiveOutcome({ suite, subjectHash, projectRoot, cases, summary, caseCoverage, status, adapterStatus, availability, failureKind, detail, transcriptEvents, transcriptErrors, command, startedAt, finishedAt, adapterExitCode, durationMs }) {
  const reportBase = {
    schemaVersion: '1.0.0',
    suiteId: suite.suiteId,
    caseSetVersion: suite.caseSetVersion,
    subjectHash,
    skillHash: null,
    mode: 'live',
    status,
    adapterStatus,
    availability: availability ?? null,
    failureKind: failureKind ?? null,
    detail: detail ?? null,
    caseCoverage,
    cases,
    summary,
    resources: {
      tokens: { value: null, measurement: 'unavailable' },
      cost: { value: null, measurement: 'unavailable' },
      latencyMs: { value: typeof durationMs === 'number' ? durationMs : null, measurement: 'wall-clock' },
    },
    transcriptErrors,
  };
  // 对象级脱敏（transcript 逐行 JSON 事件 → 递归 redact → 逐行重新序列化）
  // 测试缝：DEV253_FORCE_REDACT_RESIDUAL=1 时跳过脱敏（仅用于「残余命中→拒写」分支回归；生产不设置）
  const redactedEvents = process.env.DEV253_FORCE_REDACT_RESIDUAL === '1' ? transcriptEvents : transcriptEvents.map((e) => redact(e));
  const redactedReport = process.env.DEV253_FORCE_REDACT_RESIDUAL === '1' ? reportBase : redact(reportBase);
  const redactedErrors = redact(transcriptErrors);
  redactedReport.transcriptErrors = redactedErrors;
  const residual = scanSecrets({ report: redactedReport, events: redactedEvents });
  if (residual.length > 0) {
    const err = writeErrorManifest({ suiteId: suite.suiteId, projectRoot, failureKind: 'secret_redaction_failure', detail: `脱敏后仍残余 ${residual.length} 项（不回显片段）`, adapterExitCode, subjectHash, command, startedAt });
    return { ok: false, exit: EXIT_TOOL, errorManifest: err.path, reason: 'secret_redaction_failure' };
  }
  let transcriptJsonl = '';
  for (const e of redactedEvents) {
    const line = JSON.stringify(e);
    try {
      JSON.parse(line);
    } catch {
      return { ok: false, exit: EXIT_TOOL, reason: 'transcript_not_serializable' };
    }
    transcriptJsonl += line + '\n';
  }
  const transcriptDigest = 'sha256:' + sha256Hex(transcriptJsonl);
  const dir = evalsDir(projectRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${suite.suiteId}-live-${stamp}`;
  const reportPath = `.ai-governance/runtime/evals/${prefix}.json`;
  // integrityHash 按「落盘 body 逐字可复算」计算：不得混入 reportPath/transcriptPath（落盘 report 不含这两字段）
  redactedReport.integrityHash = integrityHash(redactedReport);
  const manifest = redact({
    schemaVersion: '1.0.0',
    mode: 'live',
    runId: `${prefix}`,
    adapter: 'stdio',
    capability: 'agent-eval',
    command,
    startedAt,
    finishedAt,
    adapterExitCode: adapterExitCode ?? null,
    subjectHash,
    transcriptDigest,
    reportPath,
    failureKind: failureKind ?? null,
    detail: detail ?? null,
  });
  if (scanSecrets(manifest).length > 0) {
    return { ok: false, exit: EXIT_TOOL, reason: 'manifest_redaction_residual' };
  }
  try {
    mkdirSync(dir, { recursive: true });
    atomicWriteText(join(dir, `${prefix}-transcript.jsonl`), transcriptJsonl);
    atomicWriteText(join(dir, `${prefix}.json`), JSON.stringify(redactedReport, null, 2) + '\n');
    atomicWriteText(join(dir, `${prefix}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  } catch (e) {
    // 内部接口-17 §4：live 报告落盘失败＝工具错误退 2
    return { ok: false, exit: EXIT_TOOL, reason: `persist_failed: ${e.message}` };
  }
  return {
    ok: true,
    exit: status === 'passed' ? EXIT_OK : EXIT_CONTENT,
    report: redactedReport,
    manifest,
    paths: {
      reportPath,
      manifestPath: `.ai-governance/runtime/evals/${prefix}-manifest.json`,
      transcriptPath: `.ai-governance/runtime/evals/${prefix}-transcript.jsonl`,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    // 冒烟：最小 suite 的 replay 路径
    const suite = { suiteId: 's-self', caseSetVersion: 'v0', cases: [
      { caseId: 'c0', subjectHash: 'sha256:' + 'a'.repeat(64),
        events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: 'ok' }] } ] };
    const report = runReplaySuite(suite, { currentSubjectHash: 'sha256:' + 'a'.repeat(64) });
    if (report.summary.passed !== 1) { console.error('FAIL selftest'); return EXIT_CONTENT; }
    console.log('OK agent-eval selftest（replay 1/1）');
    return EXIT_OK;
  }
  const suitePath = opt(argv, '--suite');
  const subjectHash = opt(argv, '--subject-hash');
  if (!suitePath || !subjectHash) {
    console.error(usage());
    return EXIT_TOOL;
  }
  const projectRoot = resolve(opt(argv, '--project-root') ?? '.');
  let suite;
  try {
    suite = JSON.parse(readFileSync(resolve(projectRoot, suitePath), 'utf8'));
  } catch (e) {
    console.error(`套件不可读：${e.message}`);
    return EXIT_TOOL;
  }
  // suiteId 进入权威报告文件名（live/replay 共用落盘面）：拒绝路径分隔符/上跳/盘符前缀（内部接口-17 §3）
  if (typeof suite.suiteId !== 'string' || suite.suiteId === '' || /[\\/]|\.\./.test(suite.suiteId) || /^[A-Za-z]:/.test(suite.suiteId)) {
    console.error('suite.suiteId 非法：不得含路径分隔符/上跳/绝对路径前缀');
    return EXIT_TOOL;
  }
  const liveCmd = opt(argv, '--live-adapter');
  // 内部任务-254（H8）：suite/case 形态校验（先于任何执行/落盘）——空 cases/缺字段/未知 oracle
  // kind 一律工具错误退 2，不产报告、无栈。live 路径 oracles 允许为空（adapter 自带执行面）。
  try {
    validateSuiteShape(suite, { requireOracles: !liveCmd });
  } catch (e) {
    if (e instanceof EvalSuiteShapeError) {
      console.error(`评测套件形态非法：${e.message}`);
      return EXIT_TOOL;
    }
    throw e;
  }
  if (liveCmd) {
    // ── live 路径（内部任务-253）──
    // 非空 cases 已由上方 validateSuiteShape 统一判（空套件退 2），此处不重复检查。
    const matched = [];
    const precheck = [];
    for (const c of suite.cases) {
      if (c && c.subjectHash === subjectHash) matched.push(c);
      else precheck.push({ caseId: c && c.caseId, status: 'unverified', reason: 'case.subjectHash 与当前对象哈希不匹配（预检终态）' });
    }
    // 测试缝：超时/输出上限可经环境变量收紧（仅测试用；生产走默认值）
    const liveTimeoutMs = Number(process.env.DEV253_LIVE_TIMEOUT_MS ?? 60000);
    const liveMaxOutputBytes = Number(process.env.DEV253_LIVE_MAX_OUTPUT_BYTES ?? (1 << 20));
    const t = await runStdioAdapter(liveCmd, { capability: 'agent-eval', timeoutMs: liveTimeoutMs, maxOutputBytes: liveMaxOutputBytes, payload: { suite: { ...suite, cases: matched }, subjectHash } });
    const startedAt = t.startedAt;
    const mkSummary = (cases) => ({
      total: cases.length,
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      unverified: cases.filter((c) => c.status === 'unverified').length,
      passRate: cases.length === 0 ? null : cases.filter((c) => c.status === 'passed').length / cases.length,
    });
    // transport 类失败（spawn/超时/上限/不可解析）→ unverified 报告退 1
    const transportUnverified = { 'spawn-error': 'adapter_spawn_error', timeout: 'timeout', overflow: 'output_overflow', unparseable: 'unparseable_output' };
    if (transportUnverified[t.transport]) {
      const cases = [...precheck, ...matched.map((c) => ({ caseId: c.caseId, status: 'unverified', reason: `transport 失败：${transportUnverified[t.transport]}` }))];
      const out = persistLiveOutcome({
        suite, subjectHash, projectRoot, cases, summary: mkSummary(cases),
        caseCoverage: 'adapter-summary-only', status: 'unverified', adapterStatus: null, availability: t.availability ?? 'unavailable',
        failureKind: transportUnverified[t.transport], detail: t.result?.summary ?? '', transcriptEvents: [], transcriptErrors: [], command: t.command, startedAt, finishedAt: t.finishedAt, adapterExitCode: t.exitCode, durationMs: t.durationMs,
      });
      if (!out.ok) { console.error(`live 落盘失败：${out.reason}`); return EXIT_TOOL; }
      emit({ mode: 'live', status: out.report.status, summary: out.report.summary, failureKind: out.report.failureKind, ...out.paths });
      return out.exit;
    }
    // 进程异常（非零退出）→ 工具错误退 2（不写 report/transcript，仅 error manifest）
    if (t.transport === 'nonzero-exit') {
      const err = writeErrorManifest({ suiteId: suite.suiteId, projectRoot, failureKind: 'adapter_nonzero_exit', detail: `适配器退出码 ${t.exitCode}`, adapterExitCode: t.exitCode, subjectHash, command: t.command, startedAt });
      emit({ mode: 'live', status: 'tool-error', failureKind: 'adapter_nonzero_exit', adapterExitCode: t.exitCode, errorManifest: err.path });
      return EXIT_TOOL;
    }
    // 信封校验（非法→工具错误退 2，仅 error manifest）
    const diags = validateEnvelope(t.parsed ?? {});
    if (diags.length > 0) {
      const err = writeErrorManifest({ suiteId: suite.suiteId, projectRoot, failureKind: 'invalid_envelope', detail: `信封非法（${diags.length} 项）：${diags.slice(0, 3).map((d) => d.message).join('；')}`, adapterExitCode: t.exitCode, subjectHash, command: t.command, startedAt });
      emit({ mode: 'live', status: 'tool-error', failureKind: 'invalid_envelope', diagnostics: redact(diags.slice(0, 5)), errorManifest: err.path });
      return EXIT_TOOL;
    }
    // transcript：stdout 逐行解析（非 JSON 行按 caseId 归属记 failed；解析不出则全部已运行匹配 case failed）
    const transcriptEvents = [];
    const transcriptErrors = [];
    const damagedCases = new Set(); // transcript 损坏导致 failed 的 case（合并时优先于 adapter results）
    let stdoutLineNo = 0;
    for (const line of String(t.stdoutText ?? '').split('\n')) {
      stdoutLineNo += 1;
      if (line.trim() === '') continue;
      try {
        const parsedLine = JSON.parse(line);
        // secret-like caseId 预检（内部接口-17 §3）：caseId 本身命中五类秘密模式 → 整行进 transcriptErrors、不落盘
        if (parsedLine && typeof parsedLine.caseId === 'string' && scanSecrets({ caseId: parsedLine.caseId }).length > 0) {
          transcriptErrors.push({ line: stdoutLineNo, caseId: null, reason: 'caseId 命中秘密模式（该行不落盘）' });
          continue;
        }
        if (parsedLine && parsedLine.schemaVersion && parsedLine.result) continue; // 信封末行不入 transcript（§2：transcript=事件流）
        transcriptEvents.push(parsedLine);
      } catch {
        const m = line.match(/"caseId"\s*:\s*"([^"]+)"/);
        const caseId = m ? m[1] : null;
        if (caseId && matched.some((c) => c.caseId === caseId)) {
          transcriptErrors.push({ line: stdoutLineNo, caseId, reason: '非 JSON 行（该 case 记 failed）' });
          damagedCases.add(caseId);
        } else if (!caseId && matched.length > 0) {
          transcriptErrors.push({ line: stdoutLineNo, caseId, reason: '非 JSON 行（无法归属，全部已运行匹配 case 记 failed）' });
          for (const c of matched) damagedCases.add(c.caseId);
        } else {
          transcriptErrors.push({ line: stdoutLineNo, caseId, reason: '非 JSON 行（caseId 不属已运行匹配项，仅记录）' });
        }
      }
    }
    // results 合并（非数组视同无 results；非法条目/未知 caseId 记 transcriptErrors）
    const parsedResult = (t.parsed && typeof t.parsed.result === 'object' && t.parsed.result) ? t.parsed.result : {};
    const results = Array.isArray(parsedResult.results) ? parsedResult.results : null;
    if (parsedResult.results != null && !Array.isArray(parsedResult.results)) {
      transcriptErrors.push({ line: 0, caseId: null, reason: 'results 非数组，按无 results 处理' });
    }
    const resultsById = new Map();
    let duplicateConflict = false;
    for (const r of results ?? []) {
      if (!r || typeof r !== 'object' || typeof r.caseId !== 'string' || !['passed', 'failed', 'unverified'].includes(r.status)) {
        transcriptErrors.push({ line: 0, caseId: null, reason: 'results 非法条目（该 case 按缺失处理）' });
        continue;
      }
      if (!matched.some((c) => c.caseId === r.caseId)) {
        transcriptErrors.push({ line: 0, caseId: r.caseId, reason: 'suite 外 caseId（忽略）' });
        continue;
      }
      const prev = resultsById.get(r.caseId);
      if (prev) {
        transcriptErrors.push({ line: null, caseId: r.caseId, reason: '重复 caseId（后者覆盖前者）' });
        if (prev.status !== r.status) duplicateConflict = true;
      }
      resultsById.set(r.caseId, r);
    }
    const cases = [...precheck];
    for (const c of matched) {
      if (damagedCases.has(c.caseId)) {
        cases.push({ caseId: c.caseId, status: 'failed', reason: 'transcript 损坏（按受影响 case 记 failed）' });
        continue;
      }
      const r = resultsById.get(c.caseId);
      cases.push(r ? { caseId: c.caseId, status: r.status, reason: r.reason ?? null } : { caseId: c.caseId, status: 'unverified', reason: 'adapter-result-missing' });
    }
    const summary = mkSummary(cases);
    const adapterStatus = parsedResult.status;
    const availability = t.parsed.availability;
    // status_mismatch：adapter status 与其自报 results 不一致 → 工具错误退 2
    // 只比较**已归属匹配 case 的合法条目**（未知 caseId/非法条目已记 transcriptErrors，不得参与矛盾判定）
    let statusMismatch = false;
    if (results) {
      const owned = [...resultsById.values()];
      const hasFailed = owned.some((r) => r.status === 'failed');
      // passed 定义要求所有已归属 results 均 passed；failed 定义要求至少一项 failed
      if (adapterStatus === 'passed' && owned.some((r) => r.status !== 'passed')) statusMismatch = true;
      if (adapterStatus === 'failed' && owned.length > 0 && !hasFailed) statusMismatch = true;
      if (duplicateConflict) statusMismatch = true;
    }
    if (statusMismatch) {
      const err = writeErrorManifest({ suiteId: suite.suiteId, projectRoot, failureKind: 'status_mismatch', detail: 'adapter status 与其自报 results 不一致（fail-closed）', adapterExitCode: t.exitCode, subjectHash, command: t.command, startedAt });
      emit({ mode: 'live', status: 'tool-error', failureKind: 'status_mismatch', errorManifest: err.path });
      return EXIT_TOOL;
    }
    // capability 值比较（合法性已由 validateEnvelope 校验；合法但不等于请求值 → 握手不符 unverified 退 1）
    if (t.parsed.capability !== 'agent-eval') {
      const cases = [...precheck, ...matched.map((c) => ({ caseId: c.caseId, status: 'unverified', reason: 'capability_mismatch（适配器握手能力与请求不符）' }))];
      const out = persistLiveOutcome({
        suite, subjectHash, projectRoot, cases, summary: mkSummary(cases),
        caseCoverage: 'adapter-summary-only', status: 'unverified', adapterStatus: t.parsed.result?.status ?? null,
        availability: 'unavailable', failureKind: 'capability_mismatch', detail: `capability=${t.parsed.capability}`,
        transcriptEvents: [], transcriptErrors: [], command: t.command, startedAt, finishedAt: t.finishedAt, adapterExitCode: t.exitCode, durationMs: t.durationMs,
      });
      if (!out.ok) { console.error(`live 落盘失败：${out.reason}`); return EXIT_TOOL; }
      emit({ mode: 'live', status: out.report.status, summary: out.report.summary, failureKind: out.report.failureKind, ...out.paths });
      return out.exit;
    }
    // 单一源判定（唯一判定处）
    let status;
    if (availability !== 'available') status = 'unverified';
    else if (adapterStatus === 'passed' && summary.failed === 0 && summary.unverified === 0) status = 'passed';
    else if (summary.failed > 0) status = 'failed';
    else status = 'unverified';
    const out = persistLiveOutcome({
      suite, subjectHash, projectRoot, cases, summary,
      caseCoverage: results ? 'per-case' : 'adapter-summary-only',
      status, adapterStatus, availability, failureKind: null, detail: null,
      transcriptEvents, transcriptErrors, command: t.command, startedAt, finishedAt: t.finishedAt, adapterExitCode: t.exitCode, durationMs: t.durationMs,
    });
    if (!out.ok) { console.error(`live 落盘失败：${out.reason}`); return EXIT_TOOL; }
    emit({ mode: 'live', status: out.report.status, summary: out.report.summary, caseCoverage: out.report.caseCoverage, adapterStatus, ...out.paths });
    return out.exit;
  }
  // ── replay 路径（行为不变）──
  let report;
  try {
    report = runReplaySuite(suite, { currentSubjectHash: subjectHash });
  } catch (e) {
    if (e instanceof SchemaError) {
      console.error(`评测套件的 oracle schema 不在受控子集内：${e.message}`);
      return EXIT_TOOL;
    }
    throw e;
  }
  let reportPath = null;
  try {
    // 内部任务-255（H12）：replay 报告落盘前脱敏＋残余复核＋integrityHash 重算（与 live 侧同口径）
    report = redactSigned(report);
    reportPath = persistEvalReport(projectRoot, report).path;
  } catch (e) {
    if (e instanceof RedactionResidualError) {
      console.error(`评测报告脱敏残余命中——拒绝落盘：${e.message}`);
      return EXIT_TOOL;
    }
    console.error(`评测报告权威落盘失败（runtime/evals）：${e.message}`);
    return EXIT_TOOL;
  }
  const out = { ...report, reportPath };
  const outArg = opt(argv, '--out');
  if (outArg) {
    try {
      mkdirSync(dirname(resolve(outArg)), { recursive: true });
      writeFileSync(resolve(outArg), JSON.stringify(report, null, 2) + '\n', 'utf8');
      out.exportPath = outArg;
    } catch (e) {
      console.error(`--out 导出失败：${e.message}`);
      return EXIT_TOOL;
    }
  }
  emit(out);
  return report.summary.failed === 0 && report.summary.unverified === 0 ? EXIT_OK : EXIT_CONTENT;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof SchemaError) {
    console.error(`评测套件 oracle schema 不在受控子集内：${e.message}`);
    process.exitCode = EXIT_TOOL;
  } else if (e instanceof RedactionResidualError) {
    console.error(`脱敏残余命中——拒绝输出：${e.message}`);
    process.exitCode = EXIT_TOOL;
  } else {
    throw e;
  }
}
