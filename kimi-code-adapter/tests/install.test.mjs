// 文件：kimi-code-adapter/tests/install.test.mjs
// 描述：安装面测试——临时宿主根（--data-dir）上完整直写一次，逐条断言六包结构、清单、
//       hooks[]、skill/命令/引擎闭包计数与资产账；installed.json 实样结构、upsert 语义
//       （他条目不碰）与拒写回滚；三类漂移（缺失/多余/变更）都能被 `verify` 逮到；
//       --staging 产物（marketplace.json + staged verify）；--dry-run 零写；幂等；
//       **源资产零改动**不变量（物化前后六插件源资产 sha256 与 mtime 全等）——内部决策-038
//       决策 1 的结构性保证。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PLUGINS, INSTALLED_SOURCE, assertNoSymlinkPath, validateRegistryShape } from '../cli.mjs';
import { listSourceFiles, sha256OfFile } from '../src/assets.mjs';
import { listEngineFiles } from '../src/engine-files.mjs';
import { validateHookEntries } from '../src/hook-template.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { ADAPTER_ROOT, REPO_ROOT, removeRoot, tempRoot } from './helpers.mjs';

/** 递归枚举相对路径（排序）。 */
function walkRel(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkRel(root, abs, out);
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out.sort();
}

/** 源资产指纹（sha256 + mtimeMs），用于零改动不变量。 */
function sourceFingerprint() {
  const out = new Map();
  for (const plugin of PLUGINS) {
    for (const rel of listSourceFiles(join(REPO_ROOT, plugin))) {
      const abs = join(REPO_ROOT, plugin, ...rel.split('/'));
      out.set(`${plugin}/${rel}`, `${sha256OfFile(abs)}:${statSync(abs).mtimeMs}`);
    }
  }
  return out;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
    timeout: 120_000, // CLI 每次 install/verify 会对六个包各跑一次装载探针（探针自身 10s）
  });
}

describe('直写安装与核对', () => {
  let homeDir;
  let sourceBefore;

  before(() => {
    sourceBefore = sourceFingerprint();
    homeDir = tempRoot('install');
    const result = runCli(['install', '--data-dir', homeDir]);
    assert.equal(result.status, 0, `install 应成功：${result.stdout}\n${result.stderr}`);
  });

  after(() => {
    removeRoot(homeDir);
  });

  it('六包各自成形：kimi.plugin.json 合规、hooks[] 合规、shim 与引擎闭包在位', () => {
    for (const plugin of PLUGINS) {
      const root = join(homeDir, 'plugins', 'managed', plugin);
      assert.ok(existsSync(root), `${plugin} 包应存在`);
      const manifest = JSON.parse(readFileSync(join(root, 'kimi.plugin.json'), 'utf8'));
      assert.deepEqual(validateManifest(manifest), [], `${plugin} 清单应合规`);
      assert.equal(manifest.name, plugin);
      assert.equal(manifest.version, JSON.parse(readFileSync(join(REPO_ROOT, plugin, 'plugin.manifest.json'), 'utf8')).version, '版本取中立清单（套件版本即插件版本）');
      assert.deepEqual(validateHookEntries(manifest.hooks ?? []), [], `${plugin} hooks[] 应合规`);
      assert.ok(existsSync(join(root, 'kimi', 'hook-shim.mjs')), 'shim 应物化进包');
      assert.ok(existsSync(join(root, 'kimi', 'hook-lib.mjs')));
      assert.ok(existsSync(join(root, 'plugin-core', 'src', 'engine.mjs')), '引擎闭包应随包');
    }
  });

  it('计数：skill/命令/处理器三面与引擎闭包（22 处理器；research-loop 零钩子）', () => {
    const counts = {};
    let handlerTotal = 0;
    for (const plugin of PLUGINS) {
      const root = join(homeDir, 'plugins', 'managed', plugin);
      const manifest = JSON.parse(readFileSync(join(root, 'kimi.plugin.json'), 'utf8'));
      const skillFiles = walkRel(root).filter((rel) => /^skills\/[^/]+\/SKILL\.md$/.test(rel));
      const commandFiles = walkRel(root).filter((rel) => /^commands\/[^/]+\.md$/.test(rel));
      counts[plugin] = { skills: skillFiles.length, commands: commandFiles.length, handlers: (manifest.hooks ?? []).length };
      handlerTotal += (manifest.hooks ?? []).length;
      for (const engineFile of listEngineFiles(REPO_ROOT)) {
        assert.ok(existsSync(join(root, ...engineFile.rel.split('/'))), `${plugin}/${engineFile.rel} 应随包`);
      }
    }
    assert.deepEqual(counts, {
      workflow: { skills: 20, commands: 1, handlers: 12 },
      'spec-gate': { skills: 4, commands: 5, handlers: 3 },
      scout: { skills: 3, commands: 0, handlers: 2 },
      'team-governance': { skills: 2, commands: 3, handlers: 3 },
      'algo-loop': { skills: 1, commands: 0, handlers: 2 },
      'research-loop': { skills: 2, commands: 0, handlers: 0 },
    });
    assert.equal(handlerTotal, 22);
    const workflowRoot = join(homeDir, 'plugins', 'managed', 'workflow');
    assert.ok(existsSync(join(workflowRoot, 'kimi', 'compact-workflow.mjs')), 'workflow 包应物化 compact-workflow.mjs');
    const workflowManifest = JSON.parse(readFileSync(join(workflowRoot, 'kimi.plugin.json'), 'utf8'));
    assert.ok((workflowManifest.hooks ?? []).some((entry) => entry.event === 'PostCompact'), 'workflow 包应含 PostCompact 条目');
  });

  it('资产账：源资产逐字节物化（sha256 相等）；`.zcode-plugin` 与 `hooks/hooks.json` 不进包', () => {
    for (const plugin of PLUGINS) {
      const root = join(homeDir, 'plugins', 'managed', plugin);
      for (const rel of listSourceFiles(join(REPO_ROOT, plugin))) {
        const abs = join(root, ...rel.split('/'));
        const sourceAbs = join(REPO_ROOT, plugin, ...rel.split('/'));
        assert.ok(existsSync(abs), `${plugin}/${rel} 应物化`);
        assert.equal(sha256OfFile(abs), sha256OfFile(sourceAbs), `${plugin}/${rel} 字节应一致`);
      }
      assert.ok(!existsSync(join(root, '.zcode-plugin')), 'ZCode 清单不进包（由 kimi.plugin.json 取代）');
      assert.ok(!existsSync(join(root, 'hooks', 'hooks.json')), 'hooks.json 不进包（声明面只留一份事实源）');
    }
  });

  it('登记面：installed.json 六条目（root/enabled/source=local-dir），实样结构合规', () => {
    const registry = JSON.parse(readFileSync(join(homeDir, 'plugins', 'installed.json'), 'utf8'));
    assert.equal(registry.version, 1);
    assert.deepEqual(validateRegistryShape(registry).problems, []);
    assert.equal(registry.plugins.length, 6);
    for (const id of PLUGINS) {
      const entry = registry.plugins.find((item) => item.id === id);
      assert.ok(entry, `${id} 条目应在场`);
      assert.equal(entry.enabled, true);
      assert.equal(entry.source, INSTALLED_SOURCE, '本地目录 source 常量（OPEN-69/P3 探针收口）');
      assert.equal(entry.root, join(homeDir, 'plugins', 'managed', id));
      assert.ok(!Number.isNaN(Date.parse(entry.installedAt)) && !Number.isNaN(Date.parse(entry.updatedAt)), '时间戳 ISO');
    }
  });

  it('upsert 语义：他插件条目不碰、六条目原位更新（位置与 installedAt 保留）', () => {
    const registryPath = join(homeDir, 'plugins', 'installed.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.plugins.push({ id: 'other-plugin', root: 'C:/somewhere', source: 'zip-url', enabled: false, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', originalSource: 'https://x/y.zip' });
    registry.plugins[0].originalSource = 'https://legacy.example/pkg.zip';
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    const result = runCli(['install', '--data-dir', homeDir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const after2 = JSON.parse(readFileSync(registryPath, 'utf8'));
    const other = after2.plugins.find((item) => item.id === 'other-plugin');
    assert.ok(other, '他插件条目不得丢');
    assert.equal(other.enabled, false, '他插件条目的字段不得被改写');
    assert.equal(after2.plugins.length, 7);
    const workflowEntry = after2.plugins.find((item) => item.id === 'workflow');
    assert.equal(workflowEntry.originalSource, 'https://legacy.example/pkg.zip', '宿主既有 originalSource 字段保留（DEV-305 B6）');
    assert.equal(workflowEntry.installedAt, registry.plugins[0].installedAt, 'installedAt 原位保留（upsert 语义）');
    assert.equal(runCli(['verify', '--data-dir', homeDir]).status, 0, '改过的登记被 install 重建六条目后 verify 应零漂移');
  });

  it('B6 upsert：enabled:false（宿主侧有意态）不被 install 覆盖，verify 记 warning 不计漂移', () => {
    const registryPath = join(homeDir, 'plugins', 'installed.json');
    const original = readFileSync(registryPath, 'utf8');
    try {
      const registry = JSON.parse(original);
      registry.plugins.find((item) => item.id === 'workflow').enabled = false;
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      const result = runCli(['install', '--data-dir', homeDir]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const after = JSON.parse(readFileSync(registryPath, 'utf8'));
      assert.equal(after.plugins.find((item) => item.id === 'workflow').enabled, false, '用户禁用态必须保留');
      const verify = runCli(['verify', '--data-dir', homeDir]);
      assert.equal(verify.status, 0, '禁用态不计漂移（warning 而非 problem）');
      assert.match(verify.stdout, /enabled 非 true/);
    } finally {
      writeFileSync(registryPath, original, 'utf8');
    }
  });

  it('verify：整包缺失 → 退 1 并报缺失（不崩）', () => {
    const pkgDir = join(homeDir, 'plugins', 'managed', 'scout');
    const backup = tempRoot('install-pkgbackup');
    try {
      cpSync(pkgDir, backup, { recursive: true });
      rmSync(pkgDir, { recursive: true, force: true });
      const result = runCli(['verify', '--data-dir', homeDir]);
      assert.equal(result.status, 1, '整包缺失必须退 1');
      assert.match(result.stdout, /缺失/);
    } finally {
      cpSync(backup, pkgDir, { recursive: true });
      removeRoot(backup);
    }
  });

  it('--json 报告契约：ok/exitCode/mode/problems/warnings/pruned 齐备（verify 干净态）', () => {
    const result = runCli(['verify', '--data-dir', homeDir, '--json']);
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.mode, 'direct');
    assert.ok(Array.isArray(report.problems) && report.problems.length === 0, '干净态无问题');
    assert.ok(Array.isArray(report.warnings), 'warnings 恒为数组');
    assert.ok(Array.isArray(report.pruned), 'pruned 恒为数组');
    assert.ok(Array.isArray(report.plugins) && report.plugins.length === 6, 'plugins 逐包可核');
  });

  it('--json：用法错退 2 时 stdout 仍是合法 JSON（机器消费面不空）', () => {
    const result = runCli(['install', '--nope', '--json']);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 2);
    assert.ok(report.problems.some((p) => /无法识别的参数/.test(p)), '错误须进 problems');
  });

  it('--json：dry-run 带 plan[]（逐包文件清单，不含字节载荷）', () => {
    const result = runCli(['install', '--dry-run', '--json', '--data-dir', homeDir]);
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.ok(Array.isArray(report.plan) && report.plan.length === 6, 'dry-run 须给逐包计划');
    assert.ok(report.plan[0].files.every((rel) => typeof rel === 'string'), 'files 须为相对路径清单');
    assert.ok(!result.stdout.includes('"type": "Buffer"'), '报告不得序列化字节载荷');
  });

  it('--json 报告：verify 漂移态 → ok=false + problems 点名多余', () => {
    const stray = join(homeDir, 'plugins', 'managed', 'spec-gate', 'NOTICE-JSON');
    writeFileSync(stray, 'x');
    try {
      const result = runCli(['verify', '--data-dir', homeDir, '--json']);
      const report = JSON.parse(result.stdout);
      assert.equal(result.status, 1);
      assert.equal(report.ok, false);
      assert.equal(report.exitCode, 1);
      assert.ok(report.problems.some((p) => /多余/.test(p)), '漂移须点名');
    } finally {
      rmSync(stray, { force: true });
    }
  });

  it('verify --staging：marketplace.json 缺失/损坏 → 退 1 并点名', () => {
    const staging = tempRoot('staging-market');
    try {
      assert.equal(runCli(['install', '--staging', staging]).status, 0);
      rmSync(join(staging, 'marketplace.json'));
      const missing = runCli(['verify', '--staging', staging, '--json']);
      assert.equal(missing.status, 1, '缺 marketplace 必须退 1');
      assert.ok(JSON.parse(missing.stdout).problems.some((p) => /marketplace.json 缺失/.test(p)), '须点名缺失');
      writeFileSync(join(staging, 'marketplace.json'), '{ 坏 JSON');
      const broken = runCli(['verify', '--staging', staging, '--json']);
      assert.equal(broken.status, 1, '坏 marketplace 必须退 1');
      assert.ok(JSON.parse(broken.stdout).problems.some((p) => /不可解析/.test(p)), '须点名不可解析');
    } finally {
      removeRoot(staging);
    }
  });

  it('登记结构不符即拒写 fail-loud 并回滚（managed 既有副本还原）', () => {
    const registryPath = join(homeDir, 'plugins', 'installed.json');
    const original = readFileSync(registryPath, 'utf8');
    const sentinel = join(homeDir, 'plugins', 'managed', 'workflow', 'NOTICE');
    writeFileSync(registryPath, '{"version":"1","plugins":"corrupted"}', 'utf8');
    try {
      const result = runCli(['install', '--data-dir', homeDir]);
      assert.equal(result.status, 1, '坏登记必须拒装退 1');
      assert.match(`${result.stdout}${result.stderr}`, /installed\.json/);
      assert.ok(existsSync(sentinel), 'managed 既有副本不得因拒写而丢（回滚还原）');
      assert.equal(readFileSync(registryPath, 'utf8'), '{"version":"1","plugins":"corrupted"}', '坏登记原样保留（回滚还原）');
    } finally {
      writeFileSync(registryPath, original, 'utf8');
    }
    assert.equal(runCli(['verify', '--data-dir', homeDir]).status, 0, '还原后回到零漂移');
  });

  it('verify：干净状态零漂移（含装载探针与登记双读）', () => {
    const result = runCli(['verify', '--data-dir', homeDir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('verify：变更一个字节即报漂移并非零退出', () => {
    const target = join(homeDir, 'plugins', 'managed', 'scout', 'skills', 'scout', 'SKILL.md');
    const original = readFileSync(target);
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n<!-- drift -->\n')]));
    try {
      const result = runCli(['verify', '--data-dir', homeDir]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /变更 1/);
      assert.match(result.stdout, /skills\/scout\/SKILL\.md/);
    } finally {
      writeFileSync(target, original);
    }
  });

  it('verify：缺失与多余都能逮到（恢复靠重跑 install 补回）', () => {
    const removed = join(homeDir, 'plugins', 'managed', 'workflow', 'NOTICE');
    const added = join(homeDir, 'plugins', 'managed', 'workflow', 'stray.txt');
    rmSync(removed);
    writeFileSync(added, 'x');
    try {
      const result = runCli(['verify', '--data-dir', homeDir]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /缺失 1/);
      assert.match(result.stdout, /多余 1/);
      assert.match(result.stdout, /NOTICE/);
      assert.match(result.stdout, /stray\.txt/);
    } finally {
      rmSync(added);
    }
    assert.equal(runCli(['install', '--data-dir', homeDir]).status, 0);
    assert.ok(existsSync(removed), '重跑 install 应补回缺失的源资产');
    assert.equal(runCli(['verify', '--data-dir', homeDir]).status, 0, '恢复后应回到零漂移');
  });

  it('--prune：显式清理计划外旧文件；默认 install 仍保留', () => {
    const stray = join(homeDir, 'plugins', 'managed', 'spec-gate', 'core', 'validator', 'stale.py');
    writeFileSync(stray, 'x');
    try {
      assert.equal(runCli(['verify', '--data-dir', homeDir]).status, 1);
      assert.equal(runCli(['install', '--data-dir', homeDir]).status, 1, '默认 install 遇计划外文件应在写后即验红并回滚');
      assert.ok(existsSync(stray), '默认 install 不得删除计划外文件');
      const pruned = runCli(['install', '--data-dir', homeDir, '--prune', '--json']);
      assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
      assert.ok(!existsSync(stray), '--prune 应清理计划外旧文件');
      const prunedReport = JSON.parse(pruned.stdout);
      assert.ok(
        prunedReport.pruned.some((item) => item.plugin === 'spec-gate' && item.rel === 'core/validator/stale.py'),
        `删除清单必须进报告（实得：${JSON.stringify(prunedReport.pruned)}）`,
      );
      assert.equal(runCli(['verify', '--data-dir', homeDir]).status, 0);
    } finally {
      if (existsSync(stray)) rmSync(stray);
    }
  });

  it('写面符号链接拒装：managed/<id> 为链接 → install 退 2 且不写链接目标', () => {
    const home = tempRoot('install-symlink');
    const outside = tempRoot('install-symlink-outside');
    try {
      mkdirSync(join(home, 'plugins', 'managed'), { recursive: true });
      symlinkSync(outside, join(home, 'plugins', 'managed', 'workflow'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = runCli(['install', '--data-dir', home]);
      assert.equal(result.status, 2, `符号链接写面必须退 2：${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /符号链接/);
      assert.deepEqual(readdirSync(outside), [], '链接目标不得被写入');
      assert.throws(() => assertNoSymlinkPath([join(home, 'plugins', 'managed', 'workflow')]), /符号链接/, '直接调用同样拒链接');
      assert.doesNotThrow(() => assertNoSymlinkPath([join(home, 'not-exist')]), '不存在的路径放行');
    } finally {
      removeRoot(home);
      removeRoot(outside);
    }
  });

  it('缺子命令：只带旗标（不带 install/verify）→ 退 2 且零写', () => {
    const result = runCli(['--dry-run', '--data-dir', homeDir, '--json']);
    assert.equal(result.status, 2, '只带旗标必须退 2（缺省 install 会向真机宿主根落盘）');
    assert.match(`${result.stdout}${result.stderr}`, /缺子命令/);
  });

  it('旗标矩阵：verify 不接受 --prune/--dry-run → 退 2 并说明', () => {
    for (const flag of ['--prune', '--dry-run']) {
      const result = runCli(['verify', '--data-dir', homeDir, flag]);
      assert.equal(result.status, 2, `verify ${flag} 须退 2（实得 ${result.status}）`);
      assert.match(`${result.stdout}${result.stderr}`, /旗标矩阵/);
    }
  });

  it('install 幂等：连跑两次逐字节一致', () => {
    const before2 = walkRel(join(homeDir, 'plugins', 'managed', 'workflow')).map((rel) => `${rel}:${sha256OfFile(join(homeDir, 'plugins', 'managed', 'workflow', ...rel.split('/')))}`);
    const result = runCli(['install', '--data-dir', homeDir]);
    assert.equal(result.status, 0);
    const after2 = walkRel(join(homeDir, 'plugins', 'managed', 'workflow')).map((rel) => `${rel}:${sha256OfFile(join(homeDir, 'plugins', 'managed', 'workflow', ...rel.split('/')))}`);
    assert.deepEqual(after2, before2);
  });

  it('agent 面：默认不装（包内无 agents/）；--with-agents 三份进包且形态合规', () => {
    for (const plugin of PLUGINS) {
      assert.ok(!existsSync(join(homeDir, 'plugins', 'managed', plugin, 'agents')), `${plugin} 默认不得装 agents/`);
    }
    const result = runCli(['install', '--data-dir', homeDir, '--with-agents']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const names = readdirSync(join(homeDir, 'plugins', 'managed', 'workflow', 'agents')).sort();
    assert.deepEqual(names, ['code-architect.md', 'code-explorer.md', 'code-reviewer.md']);
    for (const name of names) {
      const text = readFileSync(join(homeDir, 'plugins', 'managed', 'workflow', 'agents', name), 'utf8');
      assert.match(text, /^---\nname: /);
      assert.match(text, /\ntools:\n {2}- /, '工具白名单须是 Kimi 原生名 YAML 列表');
      assert.ok(!text.includes('BashOutput'), 'BashOutput 按拒绝丢弃（不放宽权限）');
    }
    assert.equal(runCli(['verify', '--data-dir', homeDir, '--with-agents']).status, 0, 'agents 进包后须带同旗标 verify 才零漂移（计划面含 agents/）');
    const noFlag = runCli(['verify', '--data-dir', homeDir]);
    assert.equal(noFlag.status, 1, '不带旗标 verify 须报 agents 面漂移');
    assert.match(noFlag.stdout, /检测到已装 agents 面/, '须给出配对提示与出路');
  });

  it('usage 面：未知参数退 2，--help 退 0', () => {
    assert.equal(runCli(['--nope']).status, 2);
    assert.equal(runCli(['install', '--bogus']).status, 2);
    assert.equal(runCli(['--help']).status, 0);
    assert.match(runCli(['--help']).stdout, /用法/);
  });

  it('宿主根探测失败 fail-loud（env 与标准位全缺的注入环境）', () => {
    const empty = tempRoot('install-nohome');
    try {
      // 不带 --data-dir 且 KIMI_CODE_HOME/USERPROFILE/HOME 全空 → resolveHostRoot 失败 fail-loud。
      // （内部任务-2 批 A5 起 `--data-dir` 缺值属用法错退 2——该形态的守卫见 install-rollback.test.mjs。）
      const result = runCli(['install'], { KIMI_CODE_HOME: '', USERPROFILE: '', HOME: '' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /宿主根/);
      assert.ok(!existsSync(join(empty, 'plugins')), '不得落盘');
    } finally {
      removeRoot(empty);
    }
  });

  it('缺解释器即拒绝安装（PATH/标准位全空时唯一合法结果是成功或明确拒绝）', () => {
    const empty = tempRoot('install-nonode');
    try {
      const result = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', empty], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '', ProgramFiles: '', LOCALAPPDATA: '' },
        windowsHide: true,
      });
      // 本进程自身就是 node，self 级仍可能命中；断言合法结果二选一
      assert.ok(result.status === 0 || (result.status === 2 && /node/.test(result.stderr)), `退出码 ${result.status}：${result.stderr}`);
    } finally {
      removeRoot(empty);
    }
  });

  it('源资产零改动：直写前后六插件源资产 sha256 与 mtime 全等', () => {
    const after = sourceFingerprint();
    assert.equal(after.size, sourceBefore.size, '源资产条目数不应变化');
    for (const [key, value] of sourceBefore) {
      assert.equal(after.get(key), value, `${key} 不应被安装器改动`);
    }
  });

  it('写面只有宿主目录：仓内与适配层不留物化产物，目录构成固定', () => {
    assert.ok(!existsSync(join(ADAPTER_ROOT, 'plugins')), '适配层内不得出现物化输出');
    assert.ok(!existsSync(join(ADAPTER_ROOT, 'kimi.plugin.json')));
    const entries = readdirSync(ADAPTER_ROOT).sort();
    assert.deepEqual(entries, ['README.md', 'cli.mjs', 'kimi', 'src', 'tests'], '适配层目录构成固定（缺项即红）');
    assert.ok(!existsSync(join(REPO_ROOT, 'plugins', 'managed')), '仓库根不得出现宿主 managed 面');
  });

  it('包内路径合规：无 ..、无反斜杠段、段字符集受限', () => {
    for (const plugin of PLUGINS) {
      for (const rel of walkRel(join(homeDir, 'plugins', 'managed', plugin))) {
        assert.ok(!rel.includes('..'), `${plugin}: ${rel}`);
        assert.ok(!rel.includes('\\'), `${plugin}: ${rel}`);
        for (const segment of rel.split('/')) assert.match(segment, /^[A-Za-z0-9._-]+$/, `${plugin}: ${rel}`);
      }
    }
  });
});

describe('staging 与 dry-run', () => {
  it('--staging：六包 + marketplace.json（version "2"）+ 立即 staged verify 通过', () => {
    const staging = tempRoot('staging');
    try {
      const result = runCli(['install', '--staging', staging]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      for (const id of PLUGINS) assert.ok(existsSync(join(staging, id, 'kimi.plugin.json')), `${id} 包应落 staging`);
      const market = JSON.parse(readFileSync(join(staging, 'marketplace.json'), 'utf8'));
      assert.equal(market.version, '2');
      assert.equal(market.plugins.length, 6);
      assert.ok(!existsSync(join(staging, 'installed.json')), 'staging 路径不经 installed.json');
      const verify = runCli(['verify', '--staging', staging]);
      assert.equal(verify.status, 0, `staged verify 应通过：${verify.stdout}\n${verify.stderr}`);
      const drifted = join(staging, 'workflow', 'NOTICE');
      rmSync(drifted);
      const verify2 = runCli(['verify', '--staging', staging]);
      assert.equal(verify2.status, 1, 'staged verify 同样逮漂移');
    } finally {
      removeRoot(staging);
    }
  });

  it('--staging 不改宿主：宿主根下不出现 managed/installed.json', () => {
    const staging = tempRoot('staging2');
    const home = tempRoot('staging2-home');
    try {
      const result = runCli(['install', '--staging', staging, '--data-dir', home]);
      assert.equal(result.status, 0);
      assert.ok(!existsSync(join(home, 'plugins')), '--staging 时写面只有目标目录');
    } finally {
      removeRoot(staging);
      removeRoot(home);
    }
  });

  it('--dry-run：只报计划、零写盘、结论可复算', () => {
    const dir = tempRoot('dry');
    try {
      const result = runCli(['install', '--dry-run', '--data-dir', dir]);
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /计划物化 \d+ 个文件/);
      assert.ok(!existsSync(join(dir, 'plugins')), 'dry-run 不得落盘');
    } finally {
      removeRoot(dir);
    }
  });

  it('临时目录可清理（测试自身不留垃圾）', () => {
    const dir = tempRoot('clean');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b.txt'), 'x');
    removeRoot(dir);
    assert.ok(!existsSync(dir));
  });
});

// 内部任务-55 步骤 2.7 —— 物化面排除本地产物（与 mcode 侧同因同修）。口径与
// `zcode-adapter/src/expect-tree.mjs` 的 `IGNORED(rel)` 同款（内部任务-PYCLEAN-1，与
// `spec-gate/assurance/probes.mjs` 的 `DEFAULT_IGNORE` 互见）：任一路径段为
// `__pycache__`/`.mimosa`，或末段匹配 `*.pyc`。
//
// 为什么必须排除：`.pyc` 是构建缓存而非资产，且**两侧各编译一次**（源树一份、已装包
// 一份），字节必然不同 ⇒ 只要任一侧跑过 Python，`verify` 就结构性报红，且失败方向会被
// 误读成「资产被篡改」。基线证据：内部证据
//
// 判别力：把 `isLocalArtifact` 短路为恒 `false` 时本用例必红（三种形态在一例内全覆盖）。
describe('DEV-55 步骤 2.7：物化面排除本地产物', () => {
  it('__pycache__ 段、.mimosa 段与 *.pyc 末段一律不进物化计划，正常文件不受影响', () => {
    const dir = tempRoot('install-localartifact');
    try {
      mkdirSync(join(dir, 'assurance', '__pycache__'), { recursive: true });
      mkdirSync(join(dir, '.mimosa'), { recursive: true });
      writeFileSync(join(dir, 'assurance', '__pycache__', 'gate.cpython-314.pyc'), 'cache');
      writeFileSync(join(dir, '.mimosa', 'state.json'), 'cache');
      writeFileSync(join(dir, 'top.pyc'), 'cache');
      writeFileSync(join(dir, 'keep.json'), '{}');
      const rels = listSourceFiles(dir);
      assert.deepEqual(rels, ['keep.json'], `本地产物须全部排除（实得 ${JSON.stringify(rels)}）`);
    } finally {
      removeRoot(dir);
    }
  });

  it('真实源树枚举面已不含本地产物（spec-gate 的 __pycache__ 不得进计划）', () => {
    const rels = listSourceFiles(join(REPO_ROOT, 'spec-gate'));
    const leaked = rels.filter((rel) => rel.includes('__pycache__') || rel.endsWith('.pyc') || rel.includes('.mimosa/'));
    assert.deepEqual(leaked, [], `真实源树枚举出本地产物 ${leaked.length} 项：${leaked.slice(0, 3).join(', ')}`);
  });

  // 与 mcode 侧同款补强（内部任务-55 code-review 正确性维 F2）：verify 的「多余」走查侧必须同谓词剪枝，
  // 否则已装包内的历史本地产物残留被永久计为多余（热修的原始缺陷复发）且套件仍全绿。
  it('verify 侧：已装包内的本地产物残留不计入多余，而真实漂移文件仍被报出', () => {
    const dir = tempRoot('install-artifact-extra');
    try {
      const installed = runCli(['install', '--data-dir', dir]);
      assert.equal(installed.status, 0, `install 应成功：${String(installed.stdout)}${String(installed.stderr)}`);
      const pkg = join(dir, 'plugins', 'managed', 'workflow');
      writeFileSync(join(pkg, 'stray.pyc'), 'cache');
      mkdirSync(join(pkg, 'sub', '__pycache__'), { recursive: true });
      writeFileSync(join(pkg, 'sub', '__pycache__', 'y.pyc'), 'cache');
      writeFileSync(join(pkg, 'drift.txt'), 'drift');
      const r = runCli(['verify', '--data-dir', dir]);
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.ok(!out.includes('stray.pyc'), `本地产物残留不得计入多余（实得：${out}）`);
      assert.ok(!out.includes('y.pyc'), `__pycache__ 段下的残留不得计入多余（实得：${out}）`);
      assert.ok(out.includes('drift.txt'), `真实漂移文件必须仍被报为多余（实得：${out}）`);
      assert.notEqual(r.status, 0, '存在真实漂移时 verify 须退非零');
    } finally {
      removeRoot(dir);
    }
  });
});

// ── 内部决策-048/内部任务-11：宿主应用在位探测输出（与 assurance 探针同库两独立读取者）──

describe('宿主应用在位行（ADR-048）', () => {
  it('KIMI_APP_ROOT 指向真目录 → 输出在位行（含命中路径）', () => {
    const dir = tempRoot('kimi-host-present');
    try {
      const appDir = join(dir, 'Kimi.app');
      mkdirSync(appDir, { recursive: true });
      // dry-run：只报计划零写盘——承载头部行断言且不受空数据目录漂移影响
      const r = runCli(['install', '--dry-run', '--data-dir', dir], { KIMI_APP_ROOT: appDir });
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 0, out);
      assert.match(out, /宿主应用：在位（.*Kimi\.app）/);
    } finally {
      removeRoot(dir);
    }
  });

  it('宿主未检出 → install 不硬失败（预装合法）＋尾行如实改口数据面物化就绪', () => {
    const dir = tempRoot('kimi-host-absent');
    try {
      const r = runCli(['install', '--data-dir', dir], { KIMI_APP_ROOT: join(dir, 'nowhere.app') });
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 0, out); // 未检出不阻断安装
      assert.match(out, /宿主应用：未检出/);
      assert.match(out, /数据面物化就绪——宿主未检出，非宿主装机生效/);
      assert.match(out, /KIMI_APP_ROOT/); // 出路提示
    } finally {
      removeRoot(dir);
    }
  });

  // ── 内部任务-347 批 C（内部未决-273）：install 互斥锁＋写前重读 ──

  it('OPEN-273 install 互斥：锁被持（新鲜）时 install 拒绝退 2；stale 锁强占放行；正常完成即释放', () => {
    const dir = tempRoot('kimi-install-lock');
    try {
      runCli(['install', '--data-dir', dir]);
      const lockFile = join(dir, 'plugins', 'install.lock');
      assert.equal(existsSync(lockFile), false, '正常完成后锁须释放（不留残留）');
      // 模拟另一持锁者：新鲜锁（mtime=now）
      writeFileSync(lockFile, `${process.pid}\n${Date.now()}\n`, 'utf8');
      const held = runCli(['install', '--data-dir', dir]);
      const out = `${String(held.stdout)}${String(held.stderr)}`;
      assert.equal(held.status, 2, `持锁时须退 2：${out}`);
      assert.match(out, /另一 install 进行中|install\.lock/);
      // stale 锁（mtime>5min 前）→ 强占放行
      const stale = new Date(Date.now() - 6 * 60 * 1000);
      utimesSync(lockFile, stale, stale);
      const takeover = runCli(['install', '--data-dir', dir]);
      assert.equal(takeover.status, 0, 'stale 锁强占后正常完成');
      assert.equal(existsSync(lockFile), false, '强占完成后同样释放');
    } finally {
      removeRoot(dir);
    }
  });
});
