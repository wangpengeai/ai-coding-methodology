// 文件：sdd_check.mjs
// 描述：项目级门禁检查（Python sdd_check.py 的 JS 实现）。F-4：suite 模式、缺路径语义、
//       validator 工具错误透传、顶层 JSON 错误；F-1 boundaries 校验。
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkBoundaries, validateBoundaryRules } from '../core/boundaries.mjs';

import { diagnostic } from '../core/diagnostics.mjs';
import { checkTaskLedger } from '../core/structured.mjs';
import { ConfigError, emitJson, emitText, isMainModule, nowIso, parseNowOrThrow, readJsonStrict } from '../core/pycompat.mjs';

const EXIT_OK = 0;
const EXIT_CONTENT = 1;
const EXIT_TOOL = 2;
const HERE = dirname(fileURLToPath(import.meta.url));
/** 被测校验器入口（测试缝 SDD_CHECK_VALIDATOR；每次调用读取，便于用例注入）。 */
function validatorPath() {
  return process.env.SDD_CHECK_VALIDATOR || resolve(HERE, '..', 'validate_specs.mjs');
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function checkSuite(project, suiteConfigRel) {
  const suitePath = resolve(project, suiteConfigRel);
  let suiteStat;
  try { suiteStat = statSync(suitePath); } catch { suiteStat = null; }
  if (!suiteStat || !suiteStat.isFile()) {
    throw new ConfigError(`suite 配置不存在: ${suiteConfigRel}`);
  }
  let suite;
  try { suite = readJsonStrict(suitePath); } catch (e) {
    // F-4：配置已声明却不可读属工具错误（exit 2）；语法错误维持内容诊断
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new ConfigError(`suite 配置不可读: ${suiteConfigRel}（${e.code}）`);
    return [diagnostic('RULE-PROJ-001', 'blocking', suiteConfigRel, 1, `suite 配置不是合法 JSON: ${e.message}`)];
  }
  if (!isObject(suite)) return [diagnostic('RULE-PROJ-001', 'blocking', suiteConfigRel, 1, 'suite 配置须为对象')];
  const documents = suite.documents ?? [];
  if (!Array.isArray(documents)) return [diagnostic('RULE-PROJ-001', 'blocking', suiteConfigRel, 1, 'suite documents 须为数组')];
  if (documents.length === 0) return [];
  const proc = spawnSync(process.execPath, [validatorPath(), '--config', suitePath, '--mode', 'suite', '--format', 'json'], {
    cwd: dirname(validatorPath()), encoding: 'utf8', timeout: 600000,
  });
  // 内部任务-242 C04/E03：工具错误分类必须覆盖 proc.error/超时/被信号杀（status=null）与未知退出码——
  // 不得落入「校验器输出不可解析」的内容阻断（退 1）。
  if (proc.error) throw new ConfigError(`校验器执行失败: ${proc.error.message}`);
  if (typeof proc.signal === 'string' && proc.signal !== '') throw new ConfigError(`校验器被信号终止: ${proc.signal}`);
  if (proc.status === null) throw new ConfigError('校验器未正常退出（status=null，可能超时或被信号杀）');
  if (proc.status !== EXIT_OK && proc.status !== EXIT_CONTENT) {
    let detail = proc.stdout?.trim() ?? '';
    try { detail = JSON.parse(proc.stdout).error ?? detail; } catch { /* 保留原文 */ }
    throw new ConfigError(`校验器工具错误（status=${proc.status}）: ${String(detail).slice(0, 300)}`);
  }
  // S-7（内部任务-242 安全复审）：status 0/1 但输出不可解析/报告形态非法＝工具/协议故障（退 2），
  // 不得伪装成内容阻断（E03 同一口径）。
  let report;
  try { report = JSON.parse(proc.stdout); } catch {
    throw new ConfigError(`校验器输出不可解析（status=${proc.status}，工具/协议故障）: ${String(proc.stdout ?? '').slice(0, 200)}`);
  }
  if (!isObject(report) || !Array.isArray(report.diagnostics) || typeof report.blockingCount !== 'number') {
    throw new ConfigError('校验器报告形态非法（缺 diagnostics/blockingCount，工具/协议故障）');
  }
  return report.diagnostics;
}

export function checkLedger(project, ledgerRel, now) {
  const ledgerPath = resolve(project, ledgerRel);
  if (!existsSync(ledgerPath)) {
    return [diagnostic('RULE-LEDGER-001', 'warning', ledgerRel, 1, 'ledger 尚未建立：本次未执行台账超期检查')];
  }
  let ledger;
  try { ledger = readJsonStrict(ledgerPath); } catch {
    return [diagnostic('RULE-LEDGER-001', 'blocking', ledgerRel, 1, '台账不是合法 JSON')];
  }
  return checkTaskLedger(ledger, ledgerRel, now);
}

const USAGE = 'usage: sdd_check.mjs --project PATH [--now ISO-8601] [--format json|text]';

function parseArgs(argv) {
  const out = { format: 'json', project: null, now: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    let name = a; let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (!['--project', '--now', '--format'].includes(name)) throw new Error(`unrecognized arguments: ${a}`);
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) throw new Error(`argument ${name}: expected one argument`);
      value = argv[i];
    }
    if (name === '--project') out.project = value;
    else if (name === '--now') out.now = value;
    else out.format = value;
  }
  if (!['json', 'text'].includes(out.format)) throw new Error(`argument --format: invalid choice: '${out.format}'`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { emitText(USAGE); return EXIT_OK; }
  if (!args.project) { emitJson({ error: '缺少 --project' }); return EXIT_TOOL; }
  const project = resolve(args.project);
  const configPath = join(project, '.sdd/project.json');
  let projectIsDir = false;
  try { projectIsDir = statSync(project).isDirectory(); } catch { projectIsDir = false; }
  if (!projectIsDir || !existsSync(configPath)) {
    const message = `项目未接入（缺少 .sdd/project.json）: ${args.project}`;
    if (args.format === 'text') emitText(message); else emitJson({ error: message });
    return EXIT_TOOL;
  }
  let config;
  try { config = readJsonStrict(configPath); } catch {
    emitJson({ error: 'project.json 不是合法 JSON' });
    return EXIT_TOOL;
  }
  if (!isObject(config)) { emitJson({ error: 'project.json 须为对象' }); return EXIT_TOOL; }
  try {
    const now = args.now === null ? nowIso() : args.now;
    if (String(now).trim() === '') throw new ConfigError('--now 不能为空字符串');
    parseNowOrThrow(now, '--now');
    const boundaryRules = config.boundaries === undefined ? [] : config.boundaries;
    const suiteConfigRel = config.suiteConfig === undefined ? '.sdd/suite.json' : config.suiteConfig;
    const ledgerRel = config.ledgerPath === undefined ? '.sdd/ledger.json' : config.ledgerPath;
    const problems = validateBoundaryRules(boundaryRules, project);
    if (problems.length) {
      emitJson({ error: 'project.json boundaries 配置非法', problems });
      return EXIT_TOOL;
    }
    const diagnostics = [
      ...checkSuite(project, suiteConfigRel),
      ...checkLedger(project, ledgerRel, now),
      ...checkBoundaries(project, boundaryRules),
    ];
    const blocking = diagnostics.filter((d) => d.severity === 'blocking').length;
    const report = {
      schemaVersion: '1.0.0',
      projectRoot: String(args.project).replace(/\\/g, '/'),
      specSystem: config.specSystem,
      blockingCount: blocking,
      warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
      diagnostics,
    };
    if (args.format === 'json') emitJson(report);
    else {
      emitText(`blocking=${blocking} warning=${report.warningCount}`);
      for (const d of diagnostics) emitText(`${d.ruleId} [${d.severity}] ${d.file}:${d.line} fixHint=${d.fixHint}`);
    }
    return blocking ? EXIT_CONTENT : EXIT_OK;
  } catch (e) {
    if (e instanceof ConfigError) {
      emitJson({ error: e.message });
      return EXIT_TOOL;
    }
    emitJson({ error: `项目检查内部错误: ${e.message}` });
    return EXIT_TOOL;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    emitJson({ error: `项目检查内部错误: ${e.message}` });
    process.exitCode = EXIT_TOOL;
  }
}
