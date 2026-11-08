// 文件：deliver-export.mjs
// 描述：保密交付投影命令（内部决策-062 D1/D4/D5/D8）——读取项目 `.deliver/{contract,policy}.json`，
//       按 CDM 白名单生成交付包：`--out` 同父目录 staging → 生成交付报告/审计包/manifest →
//       包内 lint（悬空引用/泄漏/清单/许可 blocking）→ 全新 git 历史（单 commit）→ 原子 rename 落位。
//       失败不留半成品；源仓只读（投影前后源树除源 `.git/` 外 sha256/mtime 全等、源 `.git` 历史不变）。
//       退出码：0 成功；1 内容违例（包内 lint blocking）；2 配置/参数/工具错误。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；零第三方依赖；不内置任何保密词表（全部规则来自 policy）。
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ConfigError,
  GENERATED_NAMES,
  MANIFEST_NAME,
  ViolationError,
  buildManifest,
  checkPackage,
  expandSources,
  formatViolationsMd,
  gitHistoryFingerprint,
  loadConfigs,
  renderAuditPacket,
  renderDeliveryReport,
  rewritePackage,
  scanInternalText,
  sha256File,
  sourceSnapshot,
  walkFiles,
} from './lib/delivery-lib.mjs';

const USAGE =
  '用法：node workflow/scripts/deliver-export.mjs --project-root <项目根> --out <目录> [--no-git] [--json]\n'
  + '  前置：项目根 `.deliver/contract.json`（CDM）与 `.deliver/policy.json`（保密策略，用户可编辑）\n'
  + '  退出码：0 成功／1 内容违例（包内 lint blocking）／2 配置、参数或工具错误';

function parseArgs(argv) {
  const opts = { projectRoot: process.cwd(), out: null, noGit: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project-root') opts.projectRoot = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-git') opts.noGit = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new ConfigError(`未知参数：${a}（见 --help）`);
  }
  if (!opts.out) throw new ConfigError('缺少 --out（交付包输出目录）');
  return opts;
}

function runGit(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `${(r.stderr ?? '').trim()}（exit ${r.status}）`;
    throw new ConfigError(`git 不可用或执行失败：git ${args.join(' ')} → ${why}`);
  }
  return r.stdout ?? '';
}

function emit(json, payload) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (payload.ok) process.stdout.write(`OK：交付包已生成 ${payload.out}（${payload.files} files；git=${payload.git}）\n`);
}

function main(argv) {
  let opts;
  let staging = null;
  try {
    opts = parseArgs(argv);
    const { root, contract, policy } = loadConfigs(opts.projectRoot);
    const outAbs = resolve(opts.out);
    if (existsSync(outAbs)) {
      // 已存在空目录可复用（IF 前置「不存在或为空」）；非空即拒绝覆盖。
      if (!statSync(outAbs).isDirectory() || readdirSync(outAbs).length > 0) throw new ConfigError(`--out 已存在且非空（拒绝覆盖）：${outAbs}`);
    }
    mkdirSync(dirname(outAbs), { recursive: true });
    staging = `${outAbs}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    // 源仓只读快照排除交付输出面（支持 `--out` 位于源仓内；staging 与 out 均不计入源树）。
    const excludeRel = [outAbs, staging]
      .filter((p) => p === root || p.startsWith(`${root}${sep}`))
      .map((p) => (p === root ? '' : p.slice(root.length + 1)))
      .filter((p) => p !== '');

    const before = sourceSnapshot(root, { exclude: excludeRel });
    const beforeGit = gitHistoryFingerprint(root);
    const { entries, missing } = expandSources(root, contract, policy);
    if (missing.length > 0) throw new ViolationError('CDM required 条目无产出（导出中止）', missing);

    mkdirSync(staging, { recursive: true });
    for (const e of entries) {
      const dest = join(staging, e.targetRel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(e.abs, dest);
    }
    if (contract.audit?.enabled) writeFileSync(join(staging, GENERATED_NAMES['audit-packet']), renderAuditPacket(contract, root), 'utf8');
    for (const g of contract.generated ?? []) {
      if (g.generator === 'delivery-report') writeFileSync(join(staging, GENERATED_NAMES['delivery-report']), renderDeliveryReport(contract, root), 'utf8');
    }
    // 内部决策-062 修正案 4：投影期内容改写（仅写 staging；源仓只读断言在事务尾部覆盖）。
    const rewrite = rewritePackage(staging, policy);
    const gitMode = !opts.noGit && contract.git?.freshHistory !== false ? 'fresh' : 'none';
    const manifest = buildManifest(staging, contract, { gitMode });
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const report = checkPackage({ projectRoot: root, packageDir: staging, contract, policy });
    if (report.violations.length > 0) {
      rmSync(staging, { recursive: true, force: true });
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, ...report }, null, 2)}\n`);
      else process.stdout.write(`${formatViolationsMd(report)}\n`);
      return 1;
    }

    if (gitMode === 'fresh') {
      const author = contract.git?.author ?? 'Delivery Bot <delivery@example.invalid>';
      const message = contract.git?.commitMessage ?? 'Initial delivery';
      // 提交信息/作者同受 policy 内部 ID/术语规则约束（内部规则-6：提交信息不含内部编号/路径）。
      // 内部决策-062 修正案 3：该面恒用 internal.pathPatterns（不随文本分面 textPathPatterns 收窄）。
      const hits = scanInternalText(`${message}\n${author}`, policy, { projectRoot: root, surface: 'path' });
      if (hits.length > 0) {
        rmSync(staging, { recursive: true, force: true });
        throw new ViolationError('git 提交信息/作者命中内部规则（导出中止）', hits.map((h) => ({ rule: h.rule, file: 'contract.git', message: `命中内部规则 ${h.pattern}：${h.match}` })));
      }
      runGit(['init', '-q'], staging);
      runGit(['add', '-A'], staging);
      runGit(['-c', `user.name=${author.replace(/<.*$/, '').trim() || 'Delivery Bot'}`, '-c', `user.email=${(author.match(/<([^>]+)>/)?.[1]) ?? 'delivery@example.invalid'}`, 'commit', '-q', '-m', message], staging);
    }

    const after = sourceSnapshot(root, { exclude: excludeRel });
    const afterGit = gitHistoryFingerprint(root);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new ConfigError('源仓在投影期间发生变化（源仓只读断言失败）');
    if (JSON.stringify(beforeGit) !== JSON.stringify(afterGit)) throw new ConfigError('源仓 .git 历史在投影期间发生变化（不改内部历史断言失败）');

    if (existsSync(outAbs)) rmSync(outAbs, { recursive: true, force: true }); // 仅空目录，rename 前移除
    renameSync(staging, outAbs);
    staging = null;
    const payload = {
      ok: true,
      out: outAbs,
      files: walkFiles(outAbs).length,
      git: gitMode,
      manifestSha256: sha256File(join(outAbs, MANIFEST_NAME)),
      contractId: contract.contract.id,
      rewrite,
    };
    emit(opts.json, payload);
    return 0;
  } catch (e) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (e instanceof ViolationError) {
      if (opts?.json) process.stdout.write(`${JSON.stringify({ ok: false, violations: e.violations, summary: { blockingCount: e.violations.length } }, null, 2)}\n`);
      else process.stdout.write(`${e.message}\n${e.violations.map((v) => `- [${v.rule}] ${v.file}：${v.message}`).join('\n')}\n`);
      return 1;
    }
    process.stderr.write(`deliver-export 错误：${e instanceof ConfigError ? e.message : (e?.stack ?? e)}\n`);
    return 2;
  }
}

// 内部任务-244 Q01（阶段门安全评审回归修复）：直跑判定两段式（原文 ∪ realpath 归一）——单段在
// --preserve-symlinks-main / 硬链接别名形态下静默 no-op。
// 内部任务-333 同族（内部决策-062 修正案 3）：直跑用 process.exitCode 而非 process.exit——后者不等待
// POSIX 管道 stdout 排空，>64KiB 的 violations JSON 会被截断；--help 小输出仍用 process.exit(0)。
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  process.exitCode = main(process.argv.slice(2));
}
