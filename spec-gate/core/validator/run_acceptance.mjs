// 文件：run_acceptance.mjs
// 描述：24 项统一验收运行器（Python run_acceptance.py 的 JS 实现）。
//       F-5：零测试检测、坏台账/空路由不通过、baseline 缺失 unverified、AC 子进程超时、
//       --suite-root 仅作项目根/报告字段；技能目录含 gate。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './core/frontmatter.mjs';
import { checkMarkdownStructure } from './core/markdown.mjs';
import { treeDigest, treeDigestFingerprint } from './core/paths.mjs';
import { ConfigError, emitJson, emitText, isMainModule, nowIso, readJsonStrict } from './core/pycompat.mjs';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_TOOL = 2;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(HERE, '..');
const SKILLS_CANDIDATE = join(CORE_ROOT, '..', 'skills');
const SKILLS_ROOT = existsSync(join(SKILLS_CANDIDATE, 'sdd-ddd-tdd')) ? SKILLS_CANDIDATE : join(CORE_ROOT, '..');
const SKILL_DIRS = ['sdd-ddd-tdd', 'spec-backfill', 'spec-writing', 'gate'];
const TESTS_DIR = process.env.SDD_ACCEPTANCE_TESTS_DIR
  ? resolve(process.env.SDD_ACCEPTANCE_TESTS_DIR)
  : join(CORE_ROOT, 'validator', 'tests');
const TOTAL_BUDGET_MS = 600000;
const VALIDATOR = join(CORE_ROOT, 'validator', 'validate_specs.mjs');
const AC_TIMEOUT_MS = 120000;

function tailLines(text, n = 6) {
  return String(text ?? '').trim().split('\n').slice(-n);
}

function runTest(pattern) {
  const file = join(TESTS_DIR, pattern);
  if (!existsSync(file)) return { status: 'failed', evidence: [`测试文件不存在: ${pattern}`] };
  // node --test 对零用例文件仍报 pass 1（文件级），必须静态确认存在 test() 注册
  if (!/\btest\s*\(/.test(readFileSync(file, 'utf8'))) {
    return { status: 'failed', evidence: [`${pattern} 未定义任何测试（Ran 0）`] };
  }
  // 嵌套 node --test：清除父测试运行器注入的上下文，避免子进程被当作文档化子测试
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd: CORE_ROOT, encoding: 'utf8', timeout: AC_TIMEOUT_MS, env,
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    return { status: 'failed', evidence: [`${pattern} 超时（${AC_TIMEOUT_MS / 1000}s）`] };
  }
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) ?? [])[1] ?? 0);
  const fail = Number((out.match(/^# fail (\d+)$/m) ?? [])[1] ?? 0);
  if (fail > 0) return { status: 'failed', evidence: [`${pattern} 失败 ${fail} 项`] + tailLines(out) };
  if (r.status !== 0) return { status: 'failed', evidence: [`${pattern} 退出码 ${r.status}`] + tailLines(out) };
  if (pass === 0) return { status: 'failed', evidence: [`${pattern} 未运行任何测试（Ran 0）`] };
  return { status: 'passed', evidence: [`node --test ${pattern} 全绿（${pass} 项）`] };
}

const checkCore = () => runTest('test_manifest_contract.test.mjs');
const checkRule = () => runTest('test_rule_registry_contract.test.mjs');
const checkGate = () => runTest('test_gate_report_contract.test.mjs');
const checkSchema = () => runTest('test_specification_contract.test.mjs');
const checkDdd = () => runTest('test_ddd_contract.test.mjs');
const checkOpt = () => runTest('test_opt_out_contract.test.mjs');
const checkVal = () => runTest('test_cli.test.mjs');
const checkRo = () => runTest('test_read_only.test.mjs');
const checkPath = () => runTest('test_paths.test.mjs');
const checkAdr = () => runTest('test_adr_contract.test.mjs');
const checkIf = () => runTest('test_interface_contract.test.mjs');
const checkOpen = () => runTest('test_open_item_contract.test.mjs');
const checkPlug1 = () => runTest('test_plugin_commands.test.mjs');
const checkPlug2 = () => runTest('test_plugin_hooks.test.mjs');

function checkTdd() {
  const schemaPath = join(CORE_ROOT, 'schemas/gate_report.schema.json');
  if (!existsSync(schemaPath)) return { status: 'failed', evidence: ['gate_report.schema.json 不存在'] };
  const schema = readJsonStrict(schemaPath);
  const required = new Set(schema.properties?.tddCycles?.items?.required ?? []);
  const needed = ['redClassification', 'selectionHash', 'redEvidence', 'greenEvidence'];
  const missing = needed.filter((x) => !required.has(x));
  if (missing.length) return { status: 'failed', evidence: [`tddCycles 缺少必需证据字段: ${missing.join(', ')}`] };
  const baseline = join(CORE_ROOT, 'fixtures/skill_evals/baseline_results.json');
  if (!existsSync(baseline)) return { status: 'unverified', evidence: ['行为基线 baseline_results.json 缺失（F-5：不得判 passed）'] };
  return { status: 'passed', evidence: ['tddCycles 契约含四类 RED 分类与选择集哈希', '行为基线存在'] };
}

function checkFast() {
  const root = join(CORE_ROOT, 'fixtures/fast_track');
  const cases = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'case.json'))) : [];
  if (cases.length < 3) return { status: 'unverified', evidence: ['快速通道 fixture 不足（事故/超期/原型至少三类）'] };
  const schema = readJsonStrict(join(CORE_ROOT, 'schemas/gate_report.schema.json'));
  if (!(schema.properties?.finalStatus?.enum ?? []).includes('temporary-mitigation')) {
    return { status: 'failed', evidence: ['finalStatus 缺少 temporary-mitigation'] };
  }
  return { status: 'passed', evidence: [`快速通道 fixture ${cases.length} 个`, 'finalStatus 支持 temporary-mitigation'] };
}

function checkIfFixtures() {
  const root = join(CORE_ROOT, 'fixtures/interfaces');
  const cases = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'case.json'))) : [];
  if (cases.length < 8) return { status: 'unverified', evidence: [`接口 fixture 不足（至少 8 类，当前 ${cases.length}）`] };
  const spec = readJsonStrict(join(CORE_ROOT, 'schemas/specification.schema.json'));
  if (!('interfaces' in (spec.properties ?? {}))) return { status: 'failed', evidence: ['specification.schema 缺少 interfaces 资产'] };
  if (!existsSync(join(CORE_ROOT, 'schemas/interface_registry.schema.json'))) return { status: 'failed', evidence: ['interface_registry.schema.json 不存在'] };
  return { status: 'passed', evidence: [`接口 fixture ${cases.length} 个`, 'interfaces 资产与接口注册表 schema 就位'] };
}

function checkPack() {
  const problems = [];
  for (const skill of SKILL_DIRS) {
    const md = join(SKILLS_ROOT, skill, 'SKILL.md');
    if (!existsSync(md)) { problems.push(`${skill}: 缺少 SKILL.md`); continue; }
    const { meta } = parseFrontmatter(readFileSync(md, 'utf8'));
    if (!meta) { problems.push(`${skill}: SKILL.md 缺少 frontmatter`); continue; }
    if (meta.name !== skill) problems.push(`${skill}: frontmatter name 与目录名不一致`);
    const description = meta.description ?? '';
    if (!description || [...description].length > 1024) problems.push(`${skill}: description 为空或超过 1024 字符`);
  }
  return problems.length ? { status: 'failed', evidence: problems } : { status: 'passed', evidence: ['四个技能 frontmatter 结构合规'] };
}

function checkHost() {
  const dir = join(CORE_ROOT, 'host-examples');
  const examples = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md').map((e) => join(dir, e.name)) : [];
  if (examples.length === 0) return { status: 'not-applicable', evidence: ['无宿主示例：核心不依赖宿主示例（RULE-HOST-002）'] };
  const problems = [];
  for (const p of examples) {
    const text = readFileSync(p, 'utf8');
    const { meta } = parseFrontmatter(text);
    const declared = meta?.normative === 'false' && meta?.introducesRules === 'false';
    if (!declared && !text.includes('非规范性，不产生新规则')) problems.push(`${p}: 未声明非规范性`);
  }
  return problems.length ? { status: 'failed', evidence: problems } : { status: 'passed', evidence: [`${examples.length} 个宿主示例均声明非规范性`] };
}

function checkRoute() {
  const path = join(CORE_ROOT, 'fixtures/skill_evals/routing_results.json');
  if (!existsSync(path)) return { status: 'unverified', evidence: [`行为评测结果未记录: ${path}`] };
  let data;
  try { data = readJsonStrict(path); } catch { return { status: 'failed', evidence: ['routing_results.json 不是合法 JSON'] }; }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return { status: 'failed', evidence: ['路由评测结果为空（0 项不得判 passed）'] };
  const failed = results.filter((r) => !r.passed);
  if (failed.length) return { status: 'failed', evidence: [`路由评测失败 ${failed.length} 项: ${failed.slice(0, 5).map((r) => r.caseId)}`] };
  const evalRoot = join(CORE_ROOT, 'fixtures/skill_evals');
  const skills = readdirSync(evalRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(evalRoot, e.name, 'cases.json')));
  // 结果行按 `<skill>:<caseId|ROUTE-*-ALL>` 聚合；每个技能至少一条通过结果即视为覆盖
  for (const skill of skills) {
    const covered = results.some((r) => String(r.caseId ?? '').startsWith(`${skill.name}:`) && r.passed);
    if (!covered) return { status: 'failed', evidence: [`${skill.name} 评测覆盖缺失（无通过结果行）`] };
  }
  return { status: 'passed', evidence: [`路由评测全部通过（${results.length} 项，覆盖 ${skills.length} 个技能）`] };
}

function migrationLedger() {
  const path = join(CORE_ROOT, 'fixtures/migration/migration_ledger.json');
  if (!existsSync(path)) return { exists: false };
  try { return { exists: true, data: readJsonStrict(path) }; } catch (e) { return { exists: true, error: e.message }; }
}

function checkMig() {
  const ledger = migrationLedger();
  if (!ledger.exists) return { status: 'unverified', evidence: ['迁移台账尚未建立'] };
  if (ledger.error) return { status: 'failed', evidence: [`迁移台账不是合法 JSON: ${ledger.error}`] };
  const entries = ledger.data.entries ?? [];
  const problems = [];
  for (const entry of entries) {
    for (const f of ['asset', 'status', 'target', 'reason', 'referenceCleanupEvidence']) if (!entry[f]) problems.push(`${entry.asset ?? '?'}: 缺少 ${f}`);
    if (!['migrated', 'deleted', 'pending-delete'].includes(entry.status)) problems.push(`${entry.asset ?? '?'}: 非法状态 ${entry.status}`);
  }
  if (problems.length) return { status: 'failed', evidence: problems };
  const pending = entries.filter((e) => e.status === 'pending-delete').map((e) => e.asset);
  return { status: 'passed', evidence: [`迁移台账 ${entries.length} 条闭合；待物理删除 ${pending.length} 条`] };
}

function checkMd() {
  const problems = [];
  const r = spawnSync(process.execPath, [VALIDATOR, '--selfcheck', '--format', 'json'], { cwd: CORE_ROOT, encoding: 'utf8', timeout: AC_TIMEOUT_MS });
  if (r.error?.code === 'ETIMEDOUT') return { status: 'failed', evidence: ['内核模板 selfcheck 超时'] };
  if (r.status !== 0) problems.push('内核模板 selfcheck 未通过');
  const ledger = migrationLedger();
  if (ledger.error) return { status: 'failed', evidence: [`迁移台账不是合法 JSON: ${ledger.error}`] };
  const pending = new Set((ledger.data?.entries ?? []).filter((e) => e.status === 'pending-delete').map((e) => e.asset.replace(/\\/g, '/')));
  for (const skill of SKILL_DIRS) {
    const root = join(SKILLS_ROOT, skill);
    if (!existsSync(root)) continue;
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.md') ? [join(dir, e.name)] : []));
    for (const md of walk(root)) {
      const rel = md.slice(SKILLS_ROOT.length + 1).split(/[\\/]/).join('/');
      if (pending.has(rel)) continue;
      const { body } = parseFrontmatter(readFileSync(md, 'utf8'));
      problems.push(...checkMarkdownStructure(rel, body).filter((d) => d.severity === 'blocking').map((d) => `${d.file}:${d.line} ${d.fixHint}`));
    }
  }
  return problems.length ? { status: 'failed', evidence: problems.slice(0, 20) } : { status: 'passed', evidence: ['内核模板与四个技能 Markdown 结构合法'] };
}

function checkScope() {
  const path = join(CORE_ROOT, 'fixtures/phases/phase_evidence.json');
  if (!existsSync(path)) return { status: 'unverified', evidence: ['阶段证据文件不存在'] };
  const phases = readJsonStrict(path).phases ?? [];
  const order = phases.map((p) => p.id);
  if (JSON.stringify(order) !== JSON.stringify(['A', 'B', 'C', 'D', 'E'])) return { status: 'failed', evidence: [`阶段顺序不完整: ${order}`] };
  const notDone = phases.filter((p) => p.status !== 'completed').map((p) => p.id);
  if (notDone.length) return { status: 'failed', evidence: [`以下阶段未完成: ${notDone}`] };
  return { status: 'passed', evidence: ['A–E 五阶段证据连续且全部完成'] };
}

/** AC-PLUG-003 多宿主插件根定位（内部任务-242 C09）：ZCode 布局优先 `.zcode-plugin/plugin.json`；
 * 非 ZCode 物化包（MCode/Kimi/DSH）无该目录，按宿主中立 `plugin.manifest.json` 回退定位与校验。 */
export function checkPlugStructure() {
  const overrideRoot = process.env.SDD_AC_PLUG_ROOT;
  let candidate = overrideRoot ? resolve(overrideRoot) : join(CORE_ROOT, '..');
  const hasZcode = (dir) => existsSync(join(dir, '.zcode-plugin/plugin.json'));
  const hasNeutral = (dir) => existsSync(join(dir, 'plugin.manifest.json'));
  while (dirname(candidate) !== candidate && !hasZcode(candidate) && !hasNeutral(candidate)) candidate = dirname(candidate);
  const zcode = hasZcode(candidate);
  const neutral = !zcode && hasNeutral(candidate);
  if (!zcode && !neutral) return { status: 'failed', evidence: ['缺少插件根（.zcode-plugin/plugin.json 与 plugin.manifest.json 均未找到）'] };
  const manifestPath = join(candidate, zcode ? '.zcode-plugin/plugin.json' : 'plugin.manifest.json');
  let manifest;
  try { manifest = readJsonStrict(manifestPath); } catch { return { status: 'failed', evidence: [`${manifestPath} 不是合法 JSON`] }; }
  const problems = [];
  const names = [candidate.split(/[\\/]/).pop(), dirname(candidate).split(/[\\/]/).pop()];
  // S-8（内部任务-242 安全复审）：name 缺失/非字符串/含非法字符不得静默放行（原实现仅比对字符串名）。
  if (typeof manifest.name !== 'string') {
    problems.push(`插件清单 name 缺失或非字符串: ${JSON.stringify(manifest.name)}`);
  } else if (!/^[A-Za-z0-9._-]+$/.test(manifest.name)) {
    problems.push(`插件清单 name 含非法字符: ${JSON.stringify(manifest.name)}`);
  } else if (!names.includes(manifest.name)) {
    problems.push(`插件名与目录名不符: ${manifest.name}`);
  }
  const components = zcode ? ['skills', 'commands', 'hooks'] : ['skills'];
  for (const component of components) {
    if (!existsSync(join(candidate, component)) || !statSync(join(candidate, component)).isDirectory()) problems.push(`缺少组件目录: ${component}`);
  }
  for (const skill of SKILL_DIRS) if (!existsSync(join(candidate, 'skills', skill, 'SKILL.md'))) problems.push(`缺少技能: skills/${skill}`);
  return problems.length
    ? { status: 'failed', evidence: problems }
    : { status: 'passed', evidence: [zcode ? '插件清单与组件结构合法（ZCode 布局）' : '插件清单与组件结构合法（宿主中立 plugin.manifest.json 回退）'] };
}

const CHECKS = {
  'AC-CORE-001': { blocking: true, name: 'checkCore', fn: checkCore },
  'AC-RULE-001': { blocking: true, name: 'checkRule', fn: checkRule },
  'AC-GATE-001': { blocking: true, name: 'checkGate', fn: checkGate },
  'AC-SCHEMA-001': { blocking: true, name: 'checkSchema', fn: checkSchema },
  'AC-DDD-001': { blocking: true, name: 'checkDdd', fn: checkDdd },
  'AC-TDD-001': { blocking: true, name: 'checkTdd', fn: checkTdd },
  'AC-FAST-001': { blocking: true, name: 'checkFast', fn: checkFast },
  'AC-OPT-001': { blocking: true, name: 'checkOpt', fn: checkOpt },
  'AC-VAL-001': { blocking: true, name: 'checkVal', fn: checkVal },
  'AC-RO-001': { blocking: true, name: 'checkRo', fn: checkRo },
  'AC-PATH-001': { blocking: true, name: 'checkPath', fn: checkPath },
  'AC-ADR-001': { blocking: true, name: 'checkAdr', fn: checkAdr },
  'AC-OPEN-001': { blocking: true, name: 'checkOpen', fn: checkOpen },
  'AC-IF-001': { blocking: true, name: 'checkIf', fn: checkIf },
  'AC-IF-002': { blocking: true, name: 'checkIfFixtures', fn: checkIfFixtures },
  'AC-PACK-001': { blocking: true, name: 'checkPack', fn: checkPack },
  'AC-HOST-001': { blocking: true, name: 'checkHost', fn: checkHost },
  'AC-ROUTE-001': { blocking: true, name: 'checkRoute', fn: checkRoute },
  'AC-MIG-001': { blocking: true, name: 'checkMig', fn: checkMig },
  'AC-MD-001': { blocking: true, name: 'checkMd', fn: checkMd },
  'AC-SCOPE-001': { blocking: true, name: 'checkScope', fn: checkScope },
  'AC-PLUG-001': { blocking: true, name: 'checkPlug1', fn: checkPlug1 },
  'AC-PLUG-002': { blocking: true, name: 'checkPlug2', fn: checkPlug2 },
  'AC-PLUG-003': { blocking: true, name: 'checkPlugStructure', fn: checkPlugStructure },
};
export const ALL_ACS = Object.keys(CHECKS);

export function runCase(acId) {
  const spec = CHECKS[acId];
  const before = treeDigest(CORE_ROOT, new Set(['__pycache__', '.DS_Store']));
  const started = Date.now();
  let status;
  let evidence;
  try {
    const result = spec.fn();
    status = result.status;
    evidence = result.evidence;
  } catch (e) {
    status = 'error';
    evidence = [`验收器异常: ${e.message}`];
  }
  const after = treeDigest(CORE_ROOT, new Set(['__pycache__', '.DS_Store']));
  if (treeDigestFingerprint(before) !== treeDigestFingerprint(after)) {
    evidence = [...evidence, '验收执行改变了内核树（违反只读约束）'];
    if (spec.blocking) status = 'failed';
  }
  if (status === 'failed' || status === 'error') evidence = [`[${acId}] ${evidence[0] ?? '失败'}`, ...evidence.slice(1)];
  return {
    acceptanceId: acId,
    status,
    blocking: spec.blocking,
    oracle: spec.name,
    evidence,
    diagnostics: [],
    duration: Date.now() - started,
  };
}

const USAGE = 'usage: run_acceptance.mjs --suite-root PATH [--format json|text] [--case AC-ID]';

function parseArgs(argv) {
  const out = { format: 'json', suiteRoot: null, caseId: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    let name = a; let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (!['--suite-root', '--format', '--case'].includes(name)) throw new Error(`unrecognized arguments: ${a}`);
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) throw new Error(`argument ${name}: expected one argument`);
      value = argv[i];
    }
    if (name === '--suite-root') out.suiteRoot = value;
    else if (name === '--format') out.format = value;
    else out.caseId = value;
  }
  if (!out.help && !out.suiteRoot) throw new ConfigError('缺少 --suite-root');
  if (!['json', 'text'].includes(out.format)) throw new Error(`argument --format: invalid choice: '${out.format}'`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    emitJson({ error: e.message });
    return EXIT_TOOL;
  }
  if (args.help) { emitText(USAGE); return EXIT_OK; }
  const suiteRoot = resolve(args.suiteRoot);
  if (!existsSync(suiteRoot)) {
    emitJson({ error: `suite-root 不存在: ${args.suiteRoot}` });
    return EXIT_TOOL;
  }
  let selected;
  if (args.caseId) {
    if (!(args.caseId in CHECKS)) { emitJson({ error: `未知验收项: ${args.caseId}` }); return EXIT_TOOL; }
    selected = [args.caseId];
  } else selected = ALL_ACS;

  const started = Date.now();
  const results = selected.map((acId) => {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      return {
        acceptanceId: acId, status: 'failed', blocking: CHECKS[acId].blocking, oracle: CHECKS[acId].name,
        evidence: [`[${acId}] 整套验收超过 ${TOTAL_BUDGET_MS / 1000}s 预算，未执行`], diagnostics: [], duration: 0,
      };
    }
    return runCase(acId);
  });
  const blockingPassed = results.filter((r) => r.blocking && r.status === 'passed').length;
  const blockingFailed = results.filter((r) => r.blocking && (r.status === 'failed' || r.status === 'error')).length;
  const unverified = results.filter((r) => r.status === 'unverified').length;
  const blocked = blockingFailed > 0 || unverified > 0;
  const report = {
    schemaVersion: '1.0.0',
    suiteRoot: args.suiteRoot.replace(/\\/g, '/'),
    generatedAt: nowIso(),
    selectedCases: selected,
    results,
    blockingPassed,
    blockingFailed,
    unverified,
    finalStatus: blocked ? 'blocked' : 'complete',
    exitCode: blocked ? EXIT_FAILED : EXIT_OK,
  };
  if (args.format === 'json') emitJson(report);
  else {
    emitText(`blockingPassed=${blockingPassed} blockingFailed=${blockingFailed} unverified=${unverified}`);
    for (const r of results) {
      emitText(`${r.acceptanceId} [${r.status}] blocking=${r.blocking}`);
      for (const line of r.evidence) emitText(`  - ${line}`);
    }
  }
  return report.exitCode;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    emitJson({ error: `验收器内部错误: ${e.message}` });
    process.exitCode = EXIT_TOOL;
  }
}
