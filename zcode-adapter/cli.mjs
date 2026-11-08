// 文件：zcode-adapter/cli.mjs
// 描述：ZCode 宿主适配层 CLI（内部决策-035）——子命令分发、参数解析、退出码映射（0 绿 / 1 漂移·
//       失败 / 2 用法错——内部模块-23 :107 窄口径）与 invokedDirectly 守卫（先例 mcode-adapter/cli.mjs）。
//       四子命令（verify/publish/install/bump）已全接线；未知名点名退 2 并给用法。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
// 用法：node zcode-adapter/cli.mjs <verify|publish|install|bump> [选项]
//       verify：--repo-root/--zcode-home/--marketplace/--json｜publish：--repo-root/--marketplace/--skip-tests
//       install：--repo-root/--zcode-home/--marketplace/--version/--bootstrap/--dry-run｜bump：--repo-root/--version/--note/--dry-run
//       公共仅 --repo-root 与 --help/-h；不适用的旗标一律显式退 2（R-za-1，内部任务-275/内部未决-154——禁静默忽略）
// 自检：node zcode-adapter/cli.mjs --selftest
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { MARKET_ID } from './src/manifests.mjs';
import { resolveZcodeHome, resolveMarketRoot } from './src/client-state.mjs';
import { detectHostApp, hostPresenceLine, detectHookInterpreter, hookInterpreterLine } from './src/host-presence.mjs';
import { runVerify } from './src/verify.mjs';
import { runPublish } from './src/publish.mjs';
import { runBumpCLI } from './src/bump.mjs';
import { runInstall } from './src/install.mjs';
import { selftest } from './src/selftest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 用法文本。 */
const USAGE =
  '用法：node zcode-adapter/cli.mjs <verify|publish|install|bump> [选项]\n'
  + '  verify：--repo-root <路径> --zcode-home <路径> --marketplace <市场源目录> --json\n'
  + '  publish：--repo-root <路径> --marketplace <市场源目录> --skip-tests\n'
  + '  install：--repo-root <路径> --zcode-home <路径> --marketplace <目录> [--version <校验>] --bootstrap --dry-run\n'
  + '  bump：[仓库根|--repo-root <路径>] --version <X.Y.Z> --note "<摘要>" --dry-run\n'
  + '  公共仅 --repo-root 与 --help/-h；不适用的旗标显式退 2（--json 仅 verify；--zcode-home 仅 verify/install；位置参数仅 bump）｜--selftest';

/**
 * 旗标单源定义（内部未决-247②：flag/键名/形态/适用子命令单源，派生 CONSUMED_FLAGS 与 FLAG_MATRIX 两形态——
 * 同一映射三种载体的收敛；help 与 selftest 为独立形态不入 CONSUMED）。**元素序＝字节契约**：对齐
 * 旧 CONSUMED_FLAGS 序（:119 stderr 文案旗标列举序逐字保真，round 3 计划裁定——蓝图块序作废）。
 */
const FLAG_DEFS = [
  { flag: '--repo-root', key: 'repoRoot', kind: 'value', cmds: ['verify', 'publish', 'install', 'bump'] },
  { flag: '--zcode-home', key: 'zcodeHome', kind: 'value', cmds: ['verify', 'install'] },
  { flag: '--marketplace', key: 'marketplace', kind: 'value', cmds: ['verify', 'publish', 'install'] },
  { flag: '--json', key: 'json', kind: 'bool', cmds: ['verify'] },
  { flag: '--skip-tests', key: 'skipTests', kind: 'bool', cmds: ['publish'] },
  { flag: '--dry-run', key: 'dryRun', kind: 'bool', cmds: ['install', 'bump'] },
  { flag: '--bootstrap', key: 'bootstrap', kind: 'bool', cmds: ['install'] },
  { flag: '--version', key: 'version', kind: 'value', cmds: ['install', 'bump'] },
  { flag: '--note', key: 'note', kind: 'value', cmds: ['bump'] },
  { flag: '--help', key: 'help', kind: 'bool', cmds: [], consumed: false, alias: '-h' },
  { flag: '--selftest', key: 'selftest', kind: 'bool', cmds: [], consumed: false },
];
const BY_FLAG = new Map(FLAG_DEFS.flatMap((d) => [[d.flag, d], ...(d.alias ? [[d.alias, d]] : [])]));
/** 旗标键名（parseArgs 字段）→ CLI 旗标名（错配报错指认用）；派生自 FLAG_DEFS，序保持定义序。 */
const CONSUMED_FLAGS = FLAG_DEFS.filter((d) => d.consumed !== false).map((d) => [d.flag, d.key]);

/**
 * 每子命令允许旗标键集合（R-za-1：参数语义与子命令一致——不支持的组合显式报错而非静默忽略）。
 * 2026-11-01 内部任务-275/内部未决-154 落地；2026-11-06 内部任务-334/内部未决-247② 改由 FLAG_DEFS.cmds 派生
 * （cmds 列自旧字面量逐字转录；名保留——内部模块-23 R-za-1 规格文本点名 FLAG_MATRIX）。
 */
const FLAG_MATRIX = Object.fromEntries(['verify', 'publish', 'install', 'bump']
  .map((c) => [c, new Set(FLAG_DEFS.filter((d) => d.cmds.includes(c)).map((d) => d.key))]));

/**
 * 仓库根解析：显式参数 > 本文件上溯一级（本文件在 `<仓库根>/zcode-adapter/cli.mjs`）。
 * @param {string} [flag] 显式仓库根
 * @returns {string}
 */
export function resolveRepoRoot(flag) {
  return flag ? resolve(flag) : resolve(HERE, '..');
}

/**
 * 参数解析（值旗标显式列出）。值旗标必须带非 `--` 起头的值——缺值或值形如旗标即入 rest
 * （调用方退 2，防「值旗标吞掉后续旗标」把用法错降级为业务红，评审 C2 修复）。
 * @param {string[]} argv
 * @returns {{command: string, json: boolean, help: boolean, skipTests: boolean, repoRoot: string, zcodeHome: string, marketplace: string, rest: string[]}}
 */
function parseArgs(argv) {
  const args = { command: '', json: false, help: false, skipTests: false, dryRun: false, selftest: false, repoRoot: '', zcodeHome: '', marketplace: '', version: '', note: '', positional: '', rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const def = BY_FLAG.get(token);
    if (def !== undefined && def.kind === 'bool') args[def.key] = true;
    else if (def !== undefined) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        args.rest.push(token); // 值缺失/值形如旗标 → 用法错（退 2）
      } else {
        args[def.key] = value;
        i += 1;
      }
    } else if (token.startsWith('--')) args.rest.push(token);
    else if (args.command === '') args.command = token;
    else if (args.positional === '') args.positional = token;
    else args.rest.push(token);
  }
  return args;
}

/**
 * 主入口（测试经 import 调用，直接执行时由守卫赋 process.exitCode——写 stdout 后不得立即 exit，内部任务-241 纪律/内部任务-333）。
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (args.command === '' && args.rest.length === 0 && !args.selftest)) {
    // 帮助走 stdout 退 0；「无子命令」属用法错退 2，通道固定 stderr（与其余退 2 一致，评审 api-contract）
    const sink = args.help ? process.stdout : process.stderr;
    sink.write(`${USAGE}\n`);
    return args.help ? 0 : 2;
  }
  // 内部任务-276 D3：--selftest 是独立形态，不与子命令/其他参数组合——此前本行先于 rest 校验短路，
  // `--selftest --bogus` 静默忽略 bogus、`verify --selftest` 静默以 selftest 替换 verify。
  if (args.selftest) {
    const others = CONSUMED_FLAGS.filter(([, key]) => args[key]).map(([flag]) => flag);
    if (args.command !== '' || args.rest.length > 0 || others.length > 0) {
      const extra = [args.command, args.positional, ...args.rest, ...others].filter(Boolean).join(' ');
      process.stderr.write(`--selftest 是独立形态，不与子命令/其他参数组合（收到：${extra}）。\n${USAGE}\n`);
      return 2;
    }
    return selftest();
  }
  if (args.rest.length > 0) {
    process.stderr.write(`无法识别的参数：${args.rest.join(' ')}\n${USAGE}\n`);
    return 2;
  }
  // 旗标-子命令错配通用校验（R-za-1/内部未决-154，内部任务-275）：任一已消费旗标不在该子命令允许集 → 退 2。
  // 取代原 verify+--skip-tests 单例特判（该形态现由本表覆盖，报错文案统一指认旗标与子命令）。
  const allowedFlags = FLAG_MATRIX[args.command];
  if (allowedFlags) {
    for (const [flag, key] of CONSUMED_FLAGS) {
      if (args[key] && !allowedFlags.has(key)) {
        process.stderr.write(`${flag} 不适用于 ${args.command}（该子命令的允许旗标见用法）。\n${USAGE}\n`);
        return 2;
      }
    }
    // 内部任务-276 D2：位置参数仅 bump（仓库根）支持——其余已知子命令收到即用法错（R-za-1 禁静默忽略；
    // 此前 `install /path` 被静默收纳为 args.positional 并装进缺省 zcode-home）。
    if (args.command !== 'bump' && args.positional) {
      process.stderr.write(`多余的位置参数：${args.positional}（位置参数仅 bump 支持〔仓库根〕；${args.command} 不接受位置参数）。\n${USAGE}\n`);
      return 2;
    }
  }
  if (args.command === 'verify') {
    const repoRoot = resolveRepoRoot(args.repoRoot);
    const zcodeHome = resolveZcodeHome(args.zcodeHome);
    if (zcodeHome === '') {
      process.stderr.write('无法确定 zcode-home：请用 --zcode-home 指定（或设 ZCODE_HOME）。\n');
      return 2;
    }
    const marketRoot = resolveMarketRoot(zcodeHome, args.marketplace);
    if (!marketRoot) {
      process.stderr.write(`无法解析市场源：known_marketplaces.json 无 ${MARKET_ID} 的 directory 源——请用 --marketplace 指定。\n`);
      return 2;
    }
    const report = runVerify({ repoRoot, marketRoot, zcodeHome });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ repoRoot, marketRoot, zcodeHome, hostApp: detectHostApp(), hookInterpreter: detectHookInterpreter(), ...report }, null, 2)}\n`);
    } else {
      const hostApp = detectHostApp(); // 内部决策-048：与 assurance 探针同库两独立读取者（信息面，不参与七面判定）
      process.stdout.write(`仓库根：${repoRoot}\n市场源：${marketRoot}\nzcode-home：${zcodeHome}\n`);
      process.stdout.write(`${hostPresenceLine(hostApp)}\n`);
      process.stdout.write(`${hookInterpreterLine(detectHookInterpreter())}\n`); // 内部未决-243 缓解面（内部任务-275）：信息面，不参与判定
      for (const f of report.faces) {
        const bits = [f.problems.length ? `问题 ${f.problems.length}` : null, f.missing.length ? `缺失 ${f.missing.length}` : null, f.extra.length ? `多余 ${f.extra.length}` : null, f.changed.length ? `变更 ${f.changed.length}` : null].filter(Boolean).join(' / ');
        process.stdout.write(`[${f.face}] ${f.ok ? 'ok' : '红'}${bits ? `（${bits}）` : ''}\n`);
        for (const line of f.problems) process.stdout.write(`  ! ${line}\n`);
        for (const r of f.missing) process.stdout.write(`  - 缺失 ${r}\n`);
        for (const r of f.extra) process.stdout.write(`  - 多余 ${r}\n`);
        for (const r of f.changed) process.stdout.write(`  - 变更 ${r}\n`);
      }
    }
    return report.problems.length > 0 ? 1 : 0;
  }
  if (args.command === 'publish') {
    if (!args.marketplace) {
      process.stderr.write('publish 需要 --marketplace <市场源目录>（发布目标必须显式）。\n');
      return 2;
    }
    const r = runPublish({ repoRoot: resolveRepoRoot(args.repoRoot), marketRoot: resolve(args.marketplace), skipTests: args.skipTests });
    return r.code;
  }
  if (args.command === 'bump') {
    // 仓库根：--repo-root（公共旗标）或位置参数，二者互斥；缺省走 resolveRepoRoot() 上溯推导
    // （与其余三子命令同款，兑现 README「缺省上溯推导」）。内部任务-276 D1：--repo-root 此前被本分支
    // 重组时静默丢弃（FLAG_MATRIX 放行但未消费，实际落 cwd——cwd 为合法仓库副本时会写错目标树）。
    if (args.repoRoot && args.positional) {
      process.stderr.write(`仓库根重复指定：--repo-root ${args.repoRoot} 与位置参数 ${args.positional} 互斥（二选一）。\n${USAGE}\n`);
      return 2;
    }
    const rest = [];
    if (args.repoRoot) rest.push(resolve(args.repoRoot));
    else if (args.positional) rest.push(args.positional);
    else rest.push(resolveRepoRoot());
    if (args.version) rest.push('--version', args.version);
    if (args.note) rest.push('--note', args.note);
    if (args.dryRun) rest.push('--dry-run');
    return runBumpCLI(rest);
  }
  if (args.command === 'install') {
    const zcodeHome = resolveZcodeHome(args.zcodeHome);
    if (zcodeHome === '') {
      process.stderr.write('无法确定 zcode-home：请用 --zcode-home 指定（或设 ZCODE_HOME）。\n');
      return 2;
    }
    const marketRoot = resolveMarketRoot(zcodeHome, args.marketplace);
    const version = args.version || undefined;
    const r = runInstall({ repoRoot: resolveRepoRoot(args.repoRoot), marketRoot: marketRoot ?? '', zcodeHome, version, bootstrap: args.bootstrap, dryRun: args.dryRun });
    return r.code;
  }
  process.stderr.write(`未知子命令：${args.command}（可用：verify/publish/install/bump）\n${USAGE}\n`);
  return 2;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    // symlink 形态归一（内部未决-52，内部任务-44；形态同 内部任务-GUARDSYML-1 九钩）：argv[1] 为别名形态时
    // 字符串级比对恒 false → CLI 整体静默 no-op；realpath 归一后再比一次（失败落 catch 判 false）。
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    // 写 stdout 后不得立即 exit（管道截断；内部任务-241 纪律，内部任务-333 对齐 kimi 先例）
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`适配层异常：${String(error && error.message ? error.message : error)}\n`);
    process.exitCode = 1; // 内部任务-276 D11：残余穿透异常属执行期失败而非用法错（内部模块-23 :107；publish.mjs:62-63 同向先例）；catch 面亦不得立即 exit（内部任务-241 纪律，内部任务-333）
  }
}
