// 文件：sdd_init.mjs
// 描述：项目接入工具（Python sdd_init.py 的 JS 实现）。F-14：合法骨架、原子写、拒绝 symlink、
//       空 ledger 骨架；F-1：boundaries scope 形态/逃逸校验。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBoundaryRules } from '../core/boundaries.mjs';
import { ConfigError, emitJson, emitText, isMainModule, readJsonStrict } from '../core/pycompat.mjs';

const EXIT_OK = 0;
const EXIT_CONTENT = 1;
const EXIT_TOOL = 2;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_MANIFEST = resolve(HERE, '../..', 'manifest.json');

const SPEC_MARKERS = [
  ['docs/design', 'software_design.md'],
  ['docs/design', 'system_specification.md'],
  ['.agents/specs', 'requirements.md'],
  ['specs', 'requirements.md'],
];

const PROJECT_CONFIG_TEMPLATE = {
  schemaVersion: '1.0.0',
  projectRoot: '.',
  specSystem: 'absent',
  suiteConfig: '.sdd/suite.json',
  ledgerPath: '.sdd/ledger.json',
  validationCommands: [],
  boundaries: [],
  implementationNoiseTerms: [],
};
const SUITE_CONFIG_TEMPLATE = {
  schemaVersion: '1.0.0',
  suiteRoot: '..',
  documents: [],
  exemptions: [],
  manifest: CORE_MANIFEST,
  allowedPublicAssets: [],
  implementationNoiseTerms: [],
};
const LEDGER_TEMPLATE = { schemaVersion: '1.0', tasks: [], openItems: [], optOuts: [] };

function assertNotSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ConfigError(`拒绝写入符号链接: ${path}`);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    if (e.code !== 'ENOENT') throw e;
  }
}
function writeFileAtomic(path, content) {
  assertNotSymlink(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function detectSpecSystem(project) {
  for (const [relDir, entry] of SPEC_MARKERS) {
    if (existsSync(join(project, relDir, entry))) return 'present';
  }
  if (existsSync(join(project, 'docs/design'))) return 'partial';
  return 'absent';
}

export function initProject(project, { dryRun = false } = {}) {
  const specSystem = detectSpecSystem(project);
  const sddDir = join(project, '.sdd');
  const configPath = join(sddDir, 'project.json');
  if (dryRun) {
    // 内部未决-204/内部任务-242：--dry-run 只报计划，零写盘（不创建 .sdd/、不改既有文件）。
    // C-5（正确性复审）：route 与实跑同口径——既有配置的 specSystem 优先于探测值。
    let existing = null;
    try { existing = existsSync(configPath) ? readJsonStrict(configPath) : null; } catch { existing = null; }
    const effectiveSpecSystem = existing?.specSystem ?? specSystem;
    return {
      projectRoot: project.replace(/\\/g, '/'),
      specSystem: effectiveSpecSystem,
      created: !existsSync(configPath),
      dryRun: true,
      configPath: '.sdd/project.json',
      suitePath: '.sdd/suite.json',
      route: effectiveSpecSystem !== 'present' ? 'spec-backfill' : 'spec-writing',
      hint: 'dry-run：未写入任何文件；去掉 --dry-run 执行',
    };
  }
  assertNotSymlink(sddDir);
  mkdirSync(sddDir, { recursive: true });

  let created = false;
  let config;
  if (existsSync(configPath)) {
    config = readJsonStrict(configPath);
  } else {
    config = { ...PROJECT_CONFIG_TEMPLATE, specSystem };
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    created = true;
  }

  const suitePath = join(sddDir, 'suite.json');
  if (!existsSync(suitePath)) {
    assertNotSymlink(suitePath);
    writeFileAtomic(suitePath, `${JSON.stringify(SUITE_CONFIG_TEMPLATE, null, 2)}\n`);
  }

  const ledgerPath = join(sddDir, 'ledger.json');
  if (!existsSync(ledgerPath)) {
    assertNotSymlink(ledgerPath);
    writeFileAtomic(ledgerPath, `${JSON.stringify(LEDGER_TEMPLATE, null, 2)}\n`);
  }

  return {
    projectRoot: project.replace(/\\/g, '/'),
    specSystem: config.specSystem ?? specSystem,
    created,
    configPath: '.sdd/project.json',
    suitePath: '.sdd/suite.json',
    route: (config.specSystem ?? specSystem) !== 'present' ? 'spec-backfill' : 'spec-writing',
    hint: '请登记项目验证命令（validationCommands）与受检文档（suite.json documents）；收窄/排除受检文档的裁决记入 suite.json 顶层 exemptions（{path,reason,ref}，清单自解释）；boundaries 须为规则对象数组（id/scope/deny/…，定义见 project_config.schema.json）',
  };
}

export function validateConfig(config, projectRoot = null) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['project.json 须为对象'];
  for (const field of ['schemaVersion', 'projectRoot', 'specSystem', 'suiteConfig', 'ledgerPath']) {
    if (!config[field]) problems.push(`project.json 缺少必填字段: ${field}`);
  }
  if (!['present', 'partial', 'absent'].includes(config.specSystem)) problems.push(`specSystem 非法值: ${config.specSystem}`);
  problems.push(...validateBoundaryRules(config.boundaries === undefined ? [] : config.boundaries, projectRoot));
  return problems;
}

const USAGE = 'usage: sdd_init.mjs --project PATH [--dry-run] [--format json|text]';

function parseArgs(argv) {
  const out = { format: 'json', project: null, help: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    let name = a; let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (name !== '--project' && name !== '--format') throw new Error(`unrecognized arguments: ${a}`);
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) throw new Error(`argument ${name}: expected one argument`);
      value = argv[i];
    }
    if (name === '--project') out.project = value;
    else out.format = value;
  }
  if (!['json', 'text'].includes(out.format)) throw new Error(`argument --format: invalid choice: '${out.format}'`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  // 内部未决-204/内部任务-242：未知旗标/参数形态属工具错误（退 2、stderr JSON），不向调用方抛裸异常。
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    emitJson({ error: `参数错误: ${e.message}` });
    return EXIT_TOOL;
  }
  if (args.help) { emitText(USAGE); return EXIT_OK; }
  if (!args.project) { emitJson({ error: '缺少 --project' }); return EXIT_TOOL; }
  const project = resolve(args.project);
  try {
    let projectIsDir = false;
    try { projectIsDir = statSync(project).isDirectory(); } catch { projectIsDir = false; }
    if (!projectIsDir) {
      const message = `项目目录不存在: ${args.project}`;
      if (args.format === 'text') emitText(message); else emitJson({ error: message });
      return EXIT_TOOL;
    }
    const report = initProject(project, { dryRun: args.dryRun });
    const config = existsSync(join(project, '.sdd/project.json'))
      ? readJsonStrict(join(project, '.sdd/project.json'))
      : { ...PROJECT_CONFIG_TEMPLATE, specSystem: report.specSystem };
    report.problems = validateConfig(config, project);
    if (args.format === 'json') emitJson(report);
    else {
      emitText(`specSystem=${report.specSystem} route=${report.route}`);
      for (const p of report.problems) emitText(`  - ${p}`);
    }
    return report.problems.length ? EXIT_CONTENT : EXIT_OK;
  } catch (e) {
    emitJson({ error: `初始化失败: ${e.message}` });
    return EXIT_TOOL;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    emitJson({ error: `初始化失败: ${e.message}` });
    process.exitCode = EXIT_TOOL;
  }
}
