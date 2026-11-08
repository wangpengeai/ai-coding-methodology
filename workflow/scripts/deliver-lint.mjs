// 文件：deliver-lint.mjs
// 描述：交付包独立复核命令（内部决策-062 D6）——泄漏/悬空引用（恒 blocking、无降级开关）/清单/许可/
//       最小交付对账；规则单源在 lib/delivery-lib.mjs。`--selftest` 以内嵌 tmp 夹具跑规则矩阵
//       （命令冒烟锚 内部验收-7 / release-suite 显式步）。
//       退出码：0 通过；1 内容违例；2 配置/参数/工具错误。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；零第三方依赖；不内置任何保密词表（全部规则来自 policy）。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ConfigError,
  buildManifest,
  checkPackage,
  formatViolationsMd,
  loadConfigs,
  RULES,
} from './lib/delivery-lib.mjs';

const USAGE =
  '用法：node workflow/scripts/deliver-lint.mjs --project-root <项目根> --package <交付包目录> [--json] [--format md]\n'
  + '      node workflow/scripts/deliver-lint.mjs --selftest\n'
  + `  规则闭集（blocking）：${Object.values(RULES).join('/')}\n`
  + '  悬空引用恒 blocking、无降级开关（ADR-062 修正案 1）。退出码：0/1/2。';

function parseArgs(argv) {
  const opts = { projectRoot: process.cwd(), packageDir: null, json: false, format: 'text', selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project-root') opts.projectRoot = argv[++i];
    else if (a === '--package') opts.packageDir = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new ConfigError(`未知参数：${a}（见 --help）`);
  }
  if (!opts.selftest && !opts.packageDir) throw new ConfigError('缺少 --package（交付包目录）或 --selftest');
  if (!['text', 'md'].includes(opts.format)) throw new ConfigError(`--format 只支持 text/md（收到 ${opts.format}）`);
  return opts;
}

/** 内嵌 tmp 夹具：正例包通过 → 移除被引用文档后 removed-doc-reference → 内部词命中 internal-pattern。 */
function selftest() {
  const checks = [];
  const check = (name, cond, detail = '') => checks.push([name, Boolean(cond), detail]);
  const home = mkdtempSync(join(tmpdir(), 'deliver-lint-selftest-'));
  try {
    const contract = {
      schemaVersion: 1,
      contract: { id: 'ST-1', party: '示例甲方', deliveryDate: '2026-10-23' },
      items: [
        { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true, audience: 'external' },
        { id: 'D-2', kind: 'file', source: 'docs/guide.md', target: 'docs/guide.md', audience: 'external' },
      ],
      generated: [{ id: 'D-3', generator: 'manifest', required: true }],
      thirdParty: [{ name: 'demo', license: 'MIT' }],
    };
    const policy = {
      schemaVersion: 1,
      internal: { pathPatterns: ['specs/**'], idPatterns: ['\\bDEV-\\d+\\b'], termPatterns: [] },
      dangling: { allowExternal: true },
      scan: { extensions: ['.md'] },
      license: { requireLicenseFile: false, requiredFields: ['name', 'license'] },
    };
    const project = join(home, 'project');
    const pkg = join(project, 'dist');
    const write = (rel, text) => {
      const abs = join(project, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, 'utf8');
    };
    write('README.md', '# Demo\n\n详见 [指南](docs/guide.md)。\n');
    write('docs/guide.md', '# 指南\n\n返回 [README](../README.md)。\n');
    mkdirSync(join(pkg, 'docs'), { recursive: true });
    writeFileSync(join(pkg, 'README.md'), readFileSync(join(project, 'README.md')));
    writeFileSync(join(pkg, 'docs/guide.md'), readFileSync(join(project, 'docs/guide.md')));
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const ok = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('正例交付包 0 违例', ok.violations.length === 0, JSON.stringify(ok.violations));

    // 移除被引用文档 → removed-doc-reference
    rmSync(join(pkg, 'docs/guide.md'));
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const removed = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('移除文档后 removed-doc-reference', removed.violations.some((v) => v.rule === RULES.REMOVED_DOC), JSON.stringify(removed.violations));
    check('移除文档后仍恒 blocking（无降级开关）', removed.violations.length > 0);

    // 内部 ID 命中 → internal-pattern
    writeFileSync(join(pkg, 'README.md'), '# Demo\n\n内部引用 DEV-999 未配置规则前也如实检测。\n');
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const leak = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('内部 ID 命中 internal-pattern', leak.violations.some((v) => v.rule === RULES.INTERNAL_PATTERN), JSON.stringify(leak.violations));

    // 恢复干净包（guide 被删过，重建以便后续规则检查）
    const rebuild = (extra = {}) => {
      // 清掉上一用例留下的附加路径，保证每个规则矩阵用例自含（内部决策-062 修正案 5 新增矩阵依赖此隔离）
      for (const rel of ['assets', 'tests', 'specs', 'extra.txt']) rmSync(join(pkg, rel), { recursive: true, force: true });
      writeFileSync(join(pkg, 'README.md'), '# Demo\n\n详见 [指南](docs/guide.md)。\n');
      mkdirSync(join(pkg, 'docs'), { recursive: true });
      writeFileSync(join(pkg, 'docs/guide.md'), '# 指南\n\n返回 [README](../README.md)。\n');
      writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
      for (const [rel, content] of Object.entries(extra)) writeFileSync(join(pkg, rel), content);
    };

    // 未声明文件 → unlisted-file
    writeFileSync(join(pkg, 'extra.txt'), 'not declared\n');
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const unlisted = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('未声明文件 unlisted-file', unlisted.violations.some((v) => v.rule === RULES.UNLISTED), JSON.stringify(unlisted.violations));

    // manifest 缺失 → manifest-missing
    rebuild();
    rmSync(join(pkg, 'MANIFEST.sha256.json'));
    const noManifest = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('缺 manifest → manifest-missing', noManifest.violations.some((v) => v.rule === RULES.MANIFEST_MISSING), JSON.stringify(noManifest.violations));

    // 许可完整性：thirdParty 缺 license 字段 → license-incomplete
    rebuild();
    const badContract = { ...contract, thirdParty: [{ name: '缺少许可字段' }] };
    const lic = checkPackage({ projectRoot: project, packageDir: pkg, contract: badContract, policy });
    check('第三方许可缺字段 → license-incomplete', lic.violations.some((v) => v.rule === RULES.LICENSE_INCOMPLETE), JSON.stringify(lic.violations));

    // 本地协议引用 → reference-escapes-root；https 外链 allowExternal=true 时放行
    rebuild();
    writeFileSync(join(pkg, 'README.md'), '# Demo\n\n[本地](file:///etc/passwd)\n[外链](https://example.invalid/x)\n');
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const escapes = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('file: 本地协议 → reference-escapes-root', escapes.violations.some((v) => v.rule === RULES.ESCAPES_ROOT), JSON.stringify(escapes.violations));
    check('https 外链在 allowExternal=true 时放行', !escapes.violations.some((v) => v.message.includes('https://')), JSON.stringify(escapes.violations));

    // CDM required 条目在包内无产出 → contract-missing-item
    rebuild();
    const missingContract = { ...contract, items: [...contract.items, { id: 'D-9', kind: 'file', source: 'nope.md', required: true }] };
    const missing = checkPackage({ projectRoot: project, packageDir: pkg, contract: missingContract, policy });
    check('required 无产出 → contract-missing-item', missing.violations.some((v) => v.rule === RULES.CONTRACT_MISSING), JSON.stringify(missing.violations));

    // 悬空引用（包内目标不存在且源仓也不存在）→ dangling-reference
    rebuild();
    writeFileSync(join(pkg, 'README.md'), '# Demo\n\n[缺失](nowhere.md)\n');
    writeFileSync(join(pkg, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const dangling = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('悬空引用 → dangling-reference', dangling.violations.some((v) => v.rule === RULES.DANGLING), JSON.stringify(dangling.violations));

    // manifest 哈希漂移 → manifest-hash-mismatch
    rebuild();
    writeFileSync(join(pkg, 'README.md'), '# Demo\n\n详见 [指南](docs/guide.md)。\n# 篡改\n');
    const drifted = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('哈希漂移 → manifest-hash-mismatch', drifted.violations.some((v) => v.rule === RULES.MANIFEST_HASH), JSON.stringify(drifted.violations));

    // manifest 条目指向不存在文件 → manifest-extra-file
    rebuild();
    const manifestPath = join(pkg, 'MANIFEST.sha256.json');
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mf.files.push({ path: 'ghost.md', sha256: '0'.repeat(64), bytes: 0 });
    writeFileSync(manifestPath, `${JSON.stringify(mf, null, 2)}\n`);
    const extra = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('manifest 多余条目 → manifest-extra-file', extra.violations.some((v) => v.rule === RULES.MANIFEST_EXTRA), JSON.stringify(extra.violations));

    // 包内路径命中 policy.internal.pathPatterns → internal-artifact-present
    rebuild();
    mkdirSync(join(pkg, 'specs'), { recursive: true });
    writeFileSync(join(pkg, 'specs', 'leak.md'), '# 内部\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const internalArtifact = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy });
    check('内部路径进入包 → internal-artifact-present', internalArtifact.violations.some((v) => v.rule === RULES.INTERNAL_ARTIFACT), JSON.stringify(internalArtifact.violations));

    // 内部决策-062 修正案 4：rewrite 零残留硬检——替换后仍命中规则即 rewrite-residual（blocking）
    rebuild();
    const rewritePolicy = { ...policy, rewrite: { rules: [{ id: 'rw-self', pattern: 'DEV-\\d+', replacement: 'DEV-$&' }] } };
    writeFileSync(join(pkg, 'README.md'), '# Demo\n\n内部引用 DEV-1\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const rewriteResidual = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy: rewritePolicy });
    check('改写残留 → rewrite-residual', rewriteResidual.violations.some((v) => v.rule === RULES.REWRITE_RESIDUAL), JSON.stringify(rewriteResidual.violations));

    // 内部决策-062 修正案 5：改写面 v2——exclude/data 面不计残留；test-code 注释面仍硬检、字符串面不计
    rebuild();
    mkdirSync(join(pkg, 'assets'), { recursive: true });
    writeFileSync(join(pkg, 'assets', 'gitignore-template'), '!/.sdd/suite.json\nDEV-1\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const excludePolicy = { ...policy, rewrite: { rules: [{ id: 'rw-ex', pattern: 'DEV-\\d+', replacement: 'DEV-$&' }], exclude: ['assets/gitignore-template'] } };
    const excluded = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy: excludePolicy });
    check('rewrite.exclude 面 → 不计 rewrite-residual', !excluded.violations.some((v) => v.rule === RULES.REWRITE_RESIDUAL), JSON.stringify(excluded.violations));

    rebuild();
    mkdirSync(join(pkg, 'tests', 'fixtures'), { recursive: true });
    writeFileSync(join(pkg, 'tests', 'fixtures', 'f.json'), '{"id":"DEV-1"}\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const dataResidual = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy: rewritePolicy });
    check('data 面 → 不计 rewrite-residual', !dataResidual.violations.some((v) => v.rule === RULES.REWRITE_RESIDUAL), JSON.stringify(dataResidual.violations));

    rebuild();
    mkdirSync(join(pkg, 'tests'), { recursive: true });
    writeFileSync(join(pkg, 'tests', 't.test.mjs'), '// DEV-1\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const testCommentResidual = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy: rewritePolicy });
    check('test-code 注释面 → rewrite-residual', testCommentResidual.violations.some((v) => v.rule === RULES.REWRITE_RESIDUAL), JSON.stringify(testCommentResidual.violations));

    rebuild();
    mkdirSync(join(pkg, 'tests'), { recursive: true });
    writeFileSync(join(pkg, 'tests', 't.test.mjs'), 'const s = "DEV-1";\n');
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(pkg, contract, { gitMode: 'none' }), null, 2)}\n`);
    const testStrResidual = checkPackage({ projectRoot: project, packageDir: pkg, contract, policy: rewritePolicy });
    check('test-code 字符串面 → 不计 rewrite-residual', !testStrResidual.violations.some((v) => v.rule === RULES.REWRITE_RESIDUAL), JSON.stringify(testStrResidual.violations));

    const failed = checks.filter(([, okFlag]) => !okFlag);
    for (const [name, okFlag] of checks) process.stdout.write(`${okFlag ? 'PASS' : 'FAIL'} ${name}\n`);
    if (failed.length > 0) {
      process.stdout.write(`FAIL deliver-lint --selftest（${failed.length} 项未过）\n`);
      return 1;
    }
    process.stdout.write(`OK deliver-lint --selftest（${checks.length} 项通过）\n`);
    return 0;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.selftest) return selftest();
    const { contract, policy } = loadConfigs(opts.projectRoot);
    const report = checkPackage({ projectRoot: opts.projectRoot, packageDir: opts.packageDir, contract, policy });
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: report.violations.length === 0, ...report }, null, 2)}\n`);
    else if (opts.format === 'md') process.stdout.write(formatViolationsMd(report));
    else {
      if (report.violations.length === 0) process.stdout.write(`OK：${report.summary.fileCount} 个文件复核通过（0 违例）\n`);
      else {
        process.stdout.write(`FAIL：${report.violations.length} 条违例\n`);
        for (const v of report.violations) process.stdout.write(`- [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}：${v.message}\n`);
      }
    }
    return report.violations.length === 0 ? 0 : 1;
  } catch (e) {
    process.stderr.write(`deliver-lint 错误：${e instanceof ConfigError ? e.message : (e?.stack ?? e)}\n`);
    return 2;
  }
}

// 内部任务-244 Q01（阶段门安全评审回归修复）：直跑判定两段式——原文比对（--preserve-symlinks-main
// 下 import.meta.url 为别名形态）∪ realpath 归一比对；缺任一段在别名/硬链接形态会静默 no-op。
// 内部任务-333 同族（内部决策-062 修正案 3）：直跑用 process.exitCode 而非 process.exit——后者不等待
// POSIX 管道 stdout 排空，>64KiB 的 violations JSON 会被截断；--help 小输出仍用 process.exit(0)。
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  process.exitCode = main(process.argv.slice(2));
}
