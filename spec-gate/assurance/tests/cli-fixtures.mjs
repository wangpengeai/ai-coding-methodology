// 文件：cli-fixtures.mjs
// 描述：cli.mjs / install-criteria.mjs 永久单测与 CLI 双跑夹具（内部任务-92 阶段3a W2）——
//       tmp 项目根、stdout/stderr 捕获、证据/判据/操作记录构造、市场源/注册表/缓存/镜像
//       五面夹具（对齐 test_cli.py 的 `_project`/`_run`/`CliInstallCriteriaTest.setUp`）、
//       归档运行态与 scout 台账夹具。全部落 tmp，不读真仓；生产路径零注入（core runner 经
//       SG_CORE_VALIDATOR 指向桩脚本，与 原 Python 实现（迁移史见 内部决策-051）测试同款）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { main } from '../cli.mjs';

/** core 校验器桩（Node 源码；core-runner 以 node 执行）。 */
export const STUB_CORE = 'console.log(JSON.stringify({schemaVersion:"1.0.0",mode:"suite",filesChecked:1,blockingCount:0,warningCount:0,diagnostics:[]}));\n';

/** 证据 JSON 最小合法形态（单条引用）。 */
export const EVIDENCE_ONE = [{ path: 'src/ev.txt', sha256: `sha256:${'0'.repeat(64)}`, exitCode: 0 }];

/** tmp 根（调用方负责 cleanup）。 */
export function tmpRoot(prefix = 'dev92-cli-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 递归清理（win32 句柄延迟用 retries）。 */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** 写文件前建父目录。 */
export function writeNested(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, typeof data === 'string' ? 'utf8' : undefined);
}

/**
 * 最小项目根（对齐 test_cli.py `_project`）：src/a.py + 内部治理状态 + core 桩。
 * @param {string} base
 * @returns {{proj: string, stub: string, base: string}}
 */
export function makeCliProject(base) {
  const proj = join(base, 'p');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
  mkdirSync(join(proj, '.sdd'), { recursive: true });
  writeFileSync(join(proj, '.sdd', 'suite.json'), '{"documents": []}\n', 'utf8');
  const stub = join(base, 'stub-core.mjs');
  writeFileSync(stub, STUB_CORE, 'utf8');
  return { proj, stub, base };
}

/**
 * stdout/stderr 捕获器：io 供 main(argv, io)，stdout()/stderr() 取累积文本。
 * @returns {{io: {stdout: (s: string) => void, stderr: (s: string) => void},
 *            stdout: () => string, stderr: () => string}}
 */
export function capture() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (text) => { out.push(String(text)); },
      stderr: (text) => { err.push(String(text)); },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/**
 * 进程内跑 CLI：`--project-root <proj>` 置于子命令前（Python `_run` 同款）。
 * @param {string} proj
 * @param {string[]} argv
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function runCli(proj, argv) {
  const cap = capture();
  const code = main(['--project-root', proj, ...argv], cap.io);
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

/** 直接跑 main（自定义全局参数序／--help 冒烟）。 */
export function runCliRaw(argv) {
  const cap = capture();
  const code = main(argv, cap.io);
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

/** 写证据文件（数组）并返回绝对路径。 */
export function writeEvidence(base, data = EVIDENCE_ONE, name = 'ev.json') {
  const path = join(base, name);
  writeFileSync(path, JSON.stringify(data), 'utf8');
  return path;
}

/** 写判据文件（数组）并返回绝对路径。 */
export function writeCriteria(base, data = [{ criterion: '对拍 0 差异', evidenceRef: 'layout.log' }], name = 'criteria.json') {
  const path = join(base, name);
  writeFileSync(path, JSON.stringify(data), 'utf8');
  return path;
}

/** 写操作记录并返回仓库相对路径（issue-operation --record 用）。 */
export function writeRecord(proj, rel = 'ops/record.md', content = '# 记录\n') {
  const path = join(proj, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return rel;
}

/** 读 JSON（断言便利件）。 */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 市场源/缓存/镜像/注册表五面夹具（对齐 test_cli.py CliInstallCriteriaTest.setUp）：
 * 三面刻意不同值（装机/镜像各多一文件、清单条目版本与镜像清单字节均异于发布源）——
 * 鉴别 expect 是否确取自发布源。
 * @param {string} base
 * @returns {{home: string, market: string, cache: string, mirror: string, registry: string,
 *            marketName: string, version: string}}
 */
export function makeMarketFixture(base) {
  const home = join(base, 'home');
  const marketName = 'wangp-local-marketplace';
  const version = '0.3.11';
  const market = join(home, '.zcode', 'local-marketplace');
  const cache = join(home, '.zcode', 'cli', 'plugins', 'cache', marketName);
  const mirror = join(home, '.zcode', 'cli', 'plugins', 'marketplaces', marketName);
  for (const root of [
    join(market, 'plugins', 'workflow'),
    join(cache, 'workflow', version),
    join(mirror, 'plugins', 'workflow'),
  ]) {
    mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(root, '.zcode-plugin', 'plugin.json'),
      JSON.stringify({ name: 'workflow', version }), 'utf8');
  }
  writeFileSync(join(market, 'marketplace.json'),
    JSON.stringify({ name: marketName, plugins: [{ name: 'workflow', version: '0.0.0' }] }), 'utf8');
  writeFileSync(join(mirror, 'marketplace.json'),
    JSON.stringify({ name: marketName, extra: 1, plugins: [{ name: 'workflow', version }] }), 'utf8');
  writeFileSync(join(cache, 'workflow', version, 'installed-only.txt'), 'cache', 'utf8');
  writeFileSync(join(mirror, 'plugins', 'workflow', 'installed-only.txt'), 'mirror', 'utf8');
  const registry = join(home, '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  writeFileSync(registry, JSON.stringify({
    version: 1,
    plugins: [{
      id: `workflow@${marketName}`,
      name: 'workflow',
      marketplace: marketName,
      version,
      installPath: join(cache, 'workflow', version),
      source: './plugins/workflow',
    }],
  }), 'utf8');
  return { home, market, cache, mirror, registry, marketName, version };
}

/** install-criteria 默认参数（对齐 test_cli.py `_args`）。 */
export function installArgs(fx, extra = []) {
  return [
    'install-criteria',
    '--marketplace', fx.market,
    '--registry', fx.registry,
    '--home', fx.home,
    '--record-ref', '内部治理状态#验证判据',
    ...extra,
  ];
}

/** 重写注册表（mutate 收到解析后的对象，原地改）。 */
export function rewriteRegistry(fx, mutate) {
  const data = readJson(fx.registry);
  mutate(data);
  writeFileSync(fx.registry, JSON.stringify(data), 'utf8');
}

/** 未来日期（YYYY-MM-DD；相对计算纪律——不写死绝对日期）。 */
export function future(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 过去 N 天的 ISO 时间（秒级 +00:00 偏移——容差表时间戳族格式；归档候选判据）。 */
export function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400e3);
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

/**
 * 造归档候选任务面（对齐 test_archive.py `mk_task`）：receipts 收据＋可选终稿＋可选 evidence 承载。
 * @param {string} root @param {string} taskId @param {number} daysAgo
 * @param {{withFinalize?: boolean, withEvidence?: boolean}} [opts]
 */
export function mkArchiveTask(root, taskId, daysAgo, { withFinalize = true, withEvidence = false } = {}) {
  const dir = join(root, '.sdd', 'receipts', taskId);
  mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: 2,
    receiptId: `verification-${taskId}-1`,
    kind: 'verification',
    taskId,
    createdAt: isoDaysAgo(daysAgo),
    status: 'passed',
  };
  writeFileSync(join(dir, `verification-${taskId}-1.json`), JSON.stringify(rec), 'utf8');
  if (withFinalize) {
    const fin = { ...rec, receiptId: `gate-${taskId}-1`, kind: 'gate' };
    writeFileSync(join(dir, `gate-${taskId}-1.json`), JSON.stringify(fin), 'utf8');
    const rdir = join(root, '.sdd', 'reports', taskId);
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, 'delivery-final.json'),
      JSON.stringify({ schemaVersion: 2, taskId, finalizedAt: isoDaysAgo(daysAgo) }), 'utf8');
  }
  if (withEvidence) mkdirSync(join(root, 'docs', 'plans', 'evidence', taskId), { recursive: true });
}

/** 写活跃 scout 台账条目（scout-graduate 前置；对齐 test_scout_transactions 的 register 结果形态）。 */
export function writeScoutLedger(root, taskId = '内部任务-1', txId = 'tx-1') {
  mkdirSync(join(root, '.sdd'), { recursive: true });
  const ledger = {
    tasks: [{
      id: taskId,
      title: '【scout 探路模式】explore 模式开启',
      createdAt: future(0),
      fastTrack: true,
      taskType: 'scout-mode',
      status: 'active',
      deadline: future(14),
      mode: 'explore',
      transactionId: txId,
    }],
  };
  writeFileSync(join(root, '.sdd', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({
    schemaVersion: 3, mode: 'explore', expiry: future(14), taskId, transactionId: txId,
  }), 'utf8');
  writeFileSync(join(root, '.scout', 'ledger.jsonl'),
    `{"event": "open", "taskId": "${taskId}", "transactionId": "${txId}", "at": "2026-10-18T00:00:00+08:00"}\n`,
    'utf8');
}
