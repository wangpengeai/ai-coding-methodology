#!/usr/bin/env node
// 文件：spec-gate/scripts/apply-gitignore.mjs
// 描述：接入期 .gitignore 推荐条目自动应用（内部决策-043 决策 4／内部规则-17②③）：读
//       ../assets/gitignore-template 活行（trim 后非空、非 # 起头行），行级幂等合并进
//       目标项目 .gitignore——已有字节零改动，缺失行追加于文件末尾节头注释下；
//       语义冲突（同路径主语不同行文本，或否定行顺序反转风险——目标已含主语之下否定行
//       而缺失排除行将追加于文件末、gitignore 后匹配优先会吞否定行）零写入、列举留人裁
//       决退 1；无目标文件时新建（模板全文，LF）；非 git 项目警示不阻断；EOL 跟随目标文
//       件主导形态。--dry-run 只读预览零写入。仅 Node 内置（硬规则 5）；跨平台无裸假设
//       （硬规则 10）。
// 用法：node apply-gitignore.mjs [--project <根>] [--dry-run] [--format json|text]
// 退出码：0=成功（含幂等无操作）；1=存在需人工裁决的语义冲突（零写入）；2=工具/调用错误。
// 作者：wangp  创建：2026-10-14  版权：MIT（见 spec-gate/LICENSE）
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_CONFLICT = 1;
export const EXIT_TOOL = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, '..', 'assets', 'gitignore-template');
export const SECTION_HEADER = '# AI Coding 方法论套件运行态（spec-gate:init 自动合并，IF-COLLAB-21）';
const USAGE = '用法: node apply-gitignore.mjs [--project <根>] [--dry-run] [--format json|text]';

/** 原子写（同目录临时件→rename）：E09（内部任务-241）——失败不产生半写截断的 .gitignore。 */
function atomicWriteFile(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 清理尽力 */ }
    throw e;
  }
}

/** 模板活行：trim 后非空、非 # 起头的行，保序去重（CRLF 容忍）。 */
export function templateActiveLines(templateText) {
  const seen = new Set();
  const out = [];
  for (const raw of String(templateText).split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#') || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** 路径主语：剥否定行前导 !，再剥尾部 * 与 /——语义冲突判定键（同主语不同文本＝冲突留人裁决）。 */
export function subjectOf(line) {
  let s = String(line).trim();
  if (s.startsWith('!')) s = s.slice(1);
  return s.replace(/[*/]+$/, '');
}

/** 主导 EOL 形态：\r\n 计数胜出取 CRLF，否则（含平局与无换行）LF。 */
export function dominantEol(text) {
  const crlf = (String(text).match(/\r\n/g) ?? []).length;
  const lf = (String(text).match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** 目标文本归一为 trim 后行数组（CRLF 容忍单源——三维评审 S4：三处同构收敛）。 */
export function normLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim());
}

/**
 * 合并决策纯函数（targetText=null 表示目标不存在）。
 * 冲突语义＝原子性：任一冲突 → 整体零写入（action='conflict'），避免半合并态。
 * 冲突两类：①同路径主语不同行文本；②否定行顺序反转风险——目标已含该主语之下的否定行，
 * 而缺失的排除行将追加于文件末尾，gitignore 后匹配优先会静默吞掉否定行（内部未决-17 同族）。
 * @returns {{action:'create'|'append'|'noop'|'conflict', active:string[], appended:string[],
 *   existing:string[], missing:string[], conflicts:Array<{templateLine:string,targetLine:string}>}}
 */
export function planMerge(templateText, targetText) {
  const active = templateActiveLines(templateText);
  if (targetText === null) {
    return { action: 'create', active, appended: active, existing: [], missing: active, conflicts: [] };
  }
  const targetLines = normLines(targetText);
  const targetSet = new Set(targetLines);
  const existing = active.filter((l) => targetSet.has(l));
  const missing = active.filter((l) => !targetSet.has(l));
  const conflicts = [];
  for (const m of missing) {
    const sm = subjectOf(m);
    for (const l of targetLines) {
      if (!l || l.startsWith('#')) continue;
      if (l !== m && subjectOf(l) === sm) conflicts.push({ templateLine: m, targetLine: l });
      // 否定行顺序反转风险（内部未决-17 同族，plan-review 视角二发现 1）：判 conflict 零写入，
      // 留人裁决——不追加，防止排除行落文件末吞掉 domains.json 这类白名单否定行。
      if (!m.startsWith('!') && l.startsWith('!') && subjectOf(l).startsWith(`${sm}/`)) {
        conflicts.push({ templateLine: m, targetLine: l });
      }
    }
  }
  const action = conflicts.length > 0 ? 'conflict' : missing.length > 0 ? 'append' : 'noop';
  return { action, active, appended: action === 'append' ? missing : [], existing, missing, conflicts };
}

function parseArgs(argv) {
  const opts = { project: '.', dryRun: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project 缺值');
      opts.project = v;
      i += 1;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--format') {
      const v = argv[i + 1];
      if (v !== 'json' && v !== 'text') throw new Error('--format 仅支持 json|text');
      opts.format = v;
      i += 1;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

function render(report, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [`apply-gitignore: ${report.action}${report.dryRun ? '（dry-run 预览，零写入）' : ''}`];
  if (report.action === 'create') lines.push(`  将新建: ${report.gitignorePath}（模板全文）`);
  if (report.appended.length > 0) lines.push(`  ${report.action === 'create' ? '活行' : '将追加行'}: ${report.appended.join(', ')}`);
  if (report.existing.length > 0) lines.push(`  已在位行: ${report.existing.join(', ')}`);
  for (const c of report.conflicts) {
    lines.push(`  冲突（需人工裁决）: 模板行 ${c.templateLine} vs 既有行 ${c.targetLine}——语义冲突（同主语不同形态或否定行顺序反转），本次零写入`);
  }
  if (report.warning) lines.push(`  警示: ${report.warning}`);
  if (report.action !== 'conflict') {
    lines.push('  可选: docs/* 白名单段见模板头注（目录级 docs/ 排除会吞否定行——OPEN-17 教训）');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`apply-gitignore: ${err.message}\n${USAGE}\n`);
    process.exit(EXIT_TOOL);
  }
  const root = resolve(opts.project);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`apply-gitignore: --project 非存在目录: ${root}\n`);
    process.exit(EXIT_TOOL);
  }
  let templateText;
  try {
    templateText = readFileSync(TEMPLATE_PATH, 'utf8');
  } catch {
    process.stderr.write(`apply-gitignore: 模板缺失或不可读: ${TEMPLATE_PATH}\n`);
    process.exit(EXIT_TOOL);
  }
  const gitignorePath = join(root, '.gitignore');
  const hasTarget = existsSync(gitignorePath);
  let targetText = null;
  if (hasTarget) {
    try {
      targetText = readFileSync(gitignorePath, 'utf8');
    } catch (err) {
      process.stderr.write(`apply-gitignore: .gitignore 不可读: ${err.message}\n`);
      process.exit(EXIT_TOOL);
    }
  }
  const plan = planMerge(templateText, targetText);
  // S06/内部任务-242（§四-4 抽取）：目标为符号链接时拒绝跟随写入；guard 抛错统一收口为工具错误。
  if (hasTarget) {
    try {
      guardTargetSymlink(gitignorePath);
    } catch (err) {
      process.stderr.write(`apply-gitignore: ${err.message}\n`);
      process.exit(EXIT_TOOL);
    }
  }
  const willChange = plan.action === 'create' || plan.action === 'append';
  const isGit = existsSync(join(root, '.git'));
  const report = {
    action: plan.action,
    dryRun: opts.dryRun,
    gitignorePath,
    existing: plan.existing,
    appended: plan.appended,
    conflicts: plan.conflicts,
    gitRepo: isGit,
    warning: isGit ? null : '目标不是 git 仓库——照常写入（无害，git init 后生效）',
    written: false,
  };
  if (plan.action === 'conflict') {
    render(report, opts.format);
    process.exitCode = EXIT_CONFLICT; // E01：写 stdout 后不 process.exit（管道截断）
    return;
  }
  if (willChange && !opts.dryRun) {
    try {
      if (plan.action === 'create') {
        atomicWriteFile(gitignorePath, templateText.replace(/\r\n/g, '\n'));
      } else {
        const eol = dominantEol(targetText);
        const base = targetText === '' || targetText.endsWith('\n') ? targetText : targetText + eol;
        const hasHeader = normLines(targetText).some((l) => l === SECTION_HEADER);
        const block = [...(hasHeader ? [] : [SECTION_HEADER]), ...plan.missing].join(eol) + eol;
        atomicWriteFile(gitignorePath, base + block);
      }
      // 写后即验：回读确认全部缺失行在位。验失败＝写入不完整（磁盘满/文件锁类）——已写字节
      // 不回滚：追加行本身是合法条目、脚本行级幂等，重跑即收敛（与 zcode-adapter install 的
      // 备份-回滚姿态差异如实登记：本脚本零改动已有字节，无「还原旧态」语义可言）
      const after = new Set(normLines(readFileSync(gitignorePath, 'utf8')));
      if (!plan.missing.every((l) => after.has(l))) {
        process.stderr.write('apply-gitignore: 写后即验失败——追加行未全部在位\n');
        process.exit(EXIT_TOOL);
      }
      report.written = true;
    } catch (err) {
      process.stderr.write(`apply-gitignore: 写入失败: ${err.message}\n`);
      process.exit(EXIT_TOOL);
    }
  }
  render(report, opts.format);
  process.exitCode = EXIT_OK;
}

/** 目标符号链接守卫（内部任务-242 §四-4 抽取为可测纯函数；失败抛带可读文案）。 */
function guardTargetSymlink(gitignorePath) {
  let lst = null;
  try { lst = lstatSync(gitignorePath); } catch { lst = null; }
  if (lst !== null && lst.isSymbolicLink()) {
    throw new Error('目标 .gitignore 是符号链接（拒绝跟随写入，避免越界覆盖）');
  }
}

/** 直跑兜底：未预期异常不得裸栈 + exit 1（与「语义冲突需人工裁决」契约混档）。 */
function safeRun(fn) {
  try {
    fn();
  } catch (err) {
    process.stderr.write(`apply-gitignore: 未预期错误：${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = EXIT_TOOL;
  }
}

/** 测试注入面（内部任务-242）：入口判定、原子写失败、参数解析、符号链接守卫与直跑兜底的可测单源。 */
export const _testInternals = { atomicWriteFile, guardTargetSymlink, isMainEntry, parseArgs, safeRun };

// 直跑守卫（scout mode-state／plugin-core cli 同款形态，argv[1]↔import.meta.url 双 realpath 归一）：
// 仅直接运行时执行 main()——测试面命名导出 import 不触发 CLI（否则测试子进程会以 cwd 语义
// 早退于 main，且以运行目录的真实 .gitignore 为操作对象，违背 tmp 夹具自含纪律）。
function isMainEntry() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    // EH10/E04（内部任务-241 复审）：入口判定异常不得吞成「静默退 0」——如实报错退工具错误。
    process.stderr.write(`apply-gitignore: 入口判定失败：${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = EXIT_TOOL;
    return false;
  }
}
if (isMainEntry()) {
  safeRun(main);
}
