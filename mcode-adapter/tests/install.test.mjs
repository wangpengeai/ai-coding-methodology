// 文件：mcode-adapter/tests/install.test.mjs
// 描述：安装面测试——临时数据目录上完整物化一次，逐条断言包结构、清单、声明、skill
//       清单与资产账；再断言三类漂移（缺失/多余/变更）都能被 `verify` 逮到；最后钉住
//       **ZCode 侧零改动**不变量（物化前后六插件源资产的 sha256 与 mtime 全等）——
//       这是 内部决策-034 决策 1 的结构性保证，也是本层存在的意义。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { collectSourceFiles, listSourceFiles, sha256OfFile } from '../src/assets.mjs';
import { listAgentNames } from '../src/agents.mjs';
import { validateHookDoc } from '../src/hook-template.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { inspectPackage } from '../src/package-limits.mjs';
import { PLUGINS } from '../src/plugin-meta.mjs';
import { ADAPTER_ROOT, REPO_ROOT, removeRoot, tempRoot } from './helpers.mjs';
import { fingerprintTree, installAgents, installPackages, planPackage, probeEngineInPackage, pruneAgents, readAgentsOwnership, verifyAgents } from '../cli.mjs';

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
    for (const file of listSourceFiles(join(REPO_ROOT, plugin))) {
      const abs = join(REPO_ROOT, plugin, ...file.rel.split('/'));
      out.set(`${plugin}/${file.rel}`, `${sha256OfFile(abs)}:${statSync(abs).mtimeMs}`);
    }
  }
  return out;
}

function runCli(args, env = {}) {
  // env 形参：内部决策-048 宿主在位探测等行为的注入缝（kimi runCli 先例形态；不影响既有调用）
  return spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
}

describe('安装与核对', () => {
  let dataDir;
  let sourceBefore;

  before(() => {
    sourceBefore = sourceFingerprint();
    dataDir = tempRoot('install');
    const result = runCli(['install', '--data-dir', dataDir]);
    assert.equal(result.status, 0, `install 应成功：${result.stdout}\n${result.stderr}`);
  });

  after(() => {
    removeRoot(dataDir);
  });

  it('六包各自成形：清单合规、声明合规、shim 在位、图标是 PNG', () => {
    for (const plugin of PLUGINS) {
      const root = join(dataDir, 'plugins', plugin);
      assert.ok(existsSync(root), `${plugin} 包应存在`);
      const manifest = JSON.parse(readFileSync(join(root, '.minimax-plugin', 'plugin.json'), 'utf8'));
      assert.deepEqual(validateManifest(manifest), [], `${plugin} 清单应合规`);
      assert.equal(manifest.name, plugin);
      assert.equal(manifest.version, JSON.parse(readFileSync(join(REPO_ROOT, plugin, '.zcode-plugin', 'plugin.json'), 'utf8')).version, '版本取源清单（套件版本即插件版本）');
      assert.ok(existsSync(join(root, 'mcode', 'hook-shim.mjs')), 'shim 应物化进包');
      assert.ok(existsSync(join(root, 'mcode', 'hook-lib.mjs')));
      for (const icon of ['icon.png', 'icon-dark.png']) {
        const bytes = readFileSync(join(root, icon));
        assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${icon} 应是 PNG`);
      }
      const hooksPath = join(root, 'hooks', 'hooks.mcode.json');
      if (!existsSync(hooksPath)) continue; // 零钩子插件不产 hooks 声明（research-loop，内部决策-047）
      const hookDoc = JSON.parse(readFileSync(hooksPath, 'utf8'));
      assert.deepEqual(validateHookDoc(hookDoc), [], `${plugin} 声明应合规`);
    }
  });

  test('skill 面合计 37 份（32 源 skill + 5 命令型 skill），薄指针不产副本', () => {
    let total = 0;
    const perPlugin = {};
    for (const plugin of PLUGINS) {
      const manifest = JSON.parse(readFileSync(join(dataDir, 'plugins', plugin, '.minimax-plugin', 'plugin.json'), 'utf8'));
      for (const entry of manifest.skills) {
        assert.ok(existsSync(join(dataDir, 'plugins', plugin, ...entry.split('/'))), `${plugin}/${entry} 应真实存在`);
      }
      perPlugin[plugin] = manifest.skills.length;
      total += manifest.skills.length;
    }
    assert.deepEqual(perPlugin, { workflow: 21, 'spec-gate': 6, scout: 3, 'team-governance': 4, 'algo-loop': 1, 'research-loop': 2 });
    assert.equal(total, 37);
    // 薄指针命令的 skill 仍只有一份，且就是源 skill（不是物化副本）
    const gateDir = join(dataDir, 'plugins', 'spec-gate', 'skills', 'gate');
    assert.equal(readdirSync(gateDir).length, 1, 'spec-gate/gate 只应是源 skill 一个文件');
  });

  it('处理器面合计 20 个（16 声明处理器 + 4 生成期合成 UPS；research-loop 零钩子不入面），命令均指向 shim', () => {
    let total = 0;
    for (const plugin of PLUGINS) {
      const hooksPath = join(dataDir, 'plugins', plugin, 'hooks', 'hooks.mcode.json');
      if (!existsSync(hooksPath)) continue; // 零钩子插件不产 hooks 声明（research-loop，内部决策-047）
      const doc = JSON.parse(readFileSync(hooksPath, 'utf8'));
      for (const groups of Object.values(doc.hooks)) {
        for (const group of groups) {
          for (const handler of group.hooks) {
            assert.match(handler.command, /hook-shim\.mjs" (\w+) "([^"]+)" (\d+)$/);
            const [, event, script] = handler.command.match(/hook-shim\.mjs" (\w+) "([^"]+)" (\d+)$/);
            assert.ok(existsSync(join(dataDir, 'plugins', plugin, ...script.split('/'))), `${plugin} 声明指向的脚本应随包物化：${script}`);
            assert.ok(Object.prototype.hasOwnProperty.call(doc.hooks, event));
            total += 1;
          }
        }
      }
    }
    assert.equal(total, 20);
  });

  it('资产账：源资产逐字节物化（sha256 相等），`.zcode-plugin` 与 `agents/` 不进包', () => {
    for (const plugin of PLUGINS) {
      const root = join(dataDir, 'plugins', plugin);
      for (const file of listSourceFiles(join(REPO_ROOT, plugin))) {
        const abs = join(root, ...file.rel.split('/'));
        assert.ok(existsSync(abs), `${plugin}/${file.rel} 应物化`);
        assert.equal(sha256OfFile(abs), sha256OfFile(join(REPO_ROOT, plugin, ...file.rel.split('/'))), `${plugin}/${file.rel} 字节应一致`);
      }
      assert.ok(!existsSync(join(root, '.zcode-plugin')), 'ZCode 清单不进包（由 MCode 清单取代）');
      // 内部任务-291：源 agents/*.md 是 ZCode 形态（含 skills:/features:），MCode 包内子代理走另一套契约，
      // 照搬只会留下宿主不认的死文件 ⇒ 排除面须显式钉住（本用例与「零改动不变量」都走 listSourceFiles，
      // 排除后它们会自然不再断言这三个文件；不显式钉住就会「排除写错但测试同步变绿」）。
      assert.ok(!existsSync(join(root, 'agents')), `${plugin} 包内不得含 agents/（内部任务-291）`);
    }
  });

  it('内部任务-291：listSourceFiles 不含 agents 前缀（排除面单源校验）', () => {
    const rels = listSourceFiles(join(REPO_ROOT, 'workflow')).map((f) => f.rel);
    assert.ok(rels.length > 0, 'workflow 源资产非空');
    assert.ok(!rels.some((rel) => rel.startsWith('agents/')), `源枚举不得含 agents/，实际样本：${rels.slice(0, 3).join(',')}`);
  });

  it('源资产符号链接：listSourceFiles 标记 link，collectSourceFiles 拒绝并记 problem', (t) => {
    const root = tempRoot('assets-symlink');
    try {
      mkdirSync(join(root, 'plugin', 'hooks'), { recursive: true });
      writeFileSync(join(root, 'plugin', 'hooks', 'real.mjs'), 'x');
      const outside = join(root, 'outside-dir');
      mkdirSync(outside, { recursive: true });
      try { symlinkSync(outside, join(root, 'plugin', 'hooks', 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (error && (error.code === 'EPERM' || error.code === 'EACCES')) { t.skip('本机无建链权限'); return; } throw error; }
      const entries = listSourceFiles(join(root, 'plugin'));
      assert.ok(entries.some((entry) => entry.rel === 'hooks/linkdir' && entry.link === true), '链接须被标记');
      const collected = collectSourceFiles(join(root, 'plugin'));
      assert.ok(collected.problems.some((p) => p.includes('符号链接') && p.includes('hooks/linkdir')), '链接须被拒绝');
      assert.ok(!collected.files.some((entry) => entry.rel === 'hooks/linkdir'), '链接不得进入物化计划');
    } finally { removeRoot(root); }
  });

  it('包上限：六包逐个过宿主 V1 校验（条目/文件/体积/路径/特殊条目）', () => {
    for (const plugin of PLUGINS) {
      const report = inspectPackage(join(dataDir, 'plugins', plugin));
      assert.deepEqual(report.problems, [], `${plugin} 包应无上限问题`);
      assert.ok(report.files > 0 && report.totalBytes > 0);
    }
  });

  it('ZCode 侧零改动：物化前后六插件源资产 sha256 与 mtime 全等', () => {
    const after = sourceFingerprint();
    assert.equal(after.size, sourceBefore.size, '源资产条目数不应变化');
    for (const [key, value] of sourceBefore) {
      assert.equal(after.get(key), value, `${key} 不应被安装器改动`);
    }
  });

  it('verify：干净状态零漂移', () => {
    const result = runCli(['verify', '--data-dir', dataDir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('内部任务-320 缺源预检：install 退 2（phase=precheck、零写入）／verify 退 1；report 含 problems 且 ok:false', () => {
    // 内部未决-270：--repo-root 指向缺失仓库时不得抛顶层 ENOENT（退回「安装器异常」退 2 且无 report）。
    const missing = join(tempRoot('install-missing'), 'no-such-repo');
    const inst = runCli(['install', '--dry-run', '--data-dir', tempRoot('install-missing-data'), '--repo-root', missing, '--json']);
    assert.equal(inst.status, 2, `缺源 install 应退 2：${inst.stdout}\n${inst.stderr}`);
    const ir = JSON.parse(inst.stdout);
    assert.equal(ir.ok, false, 'report.ok=false');
    assert.equal(ir.phase, 'precheck', 'report.phase=precheck');
    assert.equal(ir.exitCode, 2, 'report.exitCode 与进程退出码逐档一致（不得出现「退 1 但 exitCode:0」的错配）');
    assert.ok(ir.problems.some((p) => p.includes('插件源缺失')), 'report 含插件源缺失问题');
    assert.ok(ir.problems.some((p) => p.includes('引擎源缺失')), 'report 含引擎源缺失问题');
    const ver = runCli(['verify', '--repo-root', missing, '--json']);
    assert.equal(ver.status, 1, `缺源 verify 应退 1：${ver.stdout}\n${ver.stderr}`);
    const vr = JSON.parse(ver.stdout);
    assert.equal(vr.ok, false, 'verify report.ok=false');
    assert.equal(vr.exitCode, 1, 'verify report.exitCode=1');
    // 非 dry-run 真跑路径同口径（内部任务-320 stage1 复审发现：同一条问题曾被「plugin 条目」与「顶层 problems」
    // 各写一次 ⇒ 报告与输出各重复一遍；此处断言无重复条目，回退即红）。
    const missingReal = join(tempRoot('install-missing-real'), 'no-such-repo');
    const dataDirReal = tempRoot('install-missing-real-data');
    const instReal = runCli(['install', '--data-dir', dataDirReal, '--repo-root', missingReal, '--json']);
    assert.equal(instReal.status, 2, `缺源 install（非 dry-run）应退 2：${instReal.stdout}\n${instReal.stderr}`);
    const irReal = JSON.parse(instReal.stdout);
    assert.equal(irReal.phase, 'precheck', '非 dry-run 亦走 precheck 通道');
    assert.equal(new Set(irReal.problems).size, irReal.problems.length, 'problems 无重复条目（顶层与 plugin 条目不得双写）');
    // 判别力补口（内部任务-320 stage2 code-r2 N2）：「无重复」断言对空数组恒真 ⇒ 须另断言 **plugin 级原因不丢**
    // （早退对象漏 `plugins` 时 report.problems 可为空 ⇒ 机器消费方拿到「红但无因」的报告）。
    assert.ok(irReal.problems.some((p) => p.includes('插件源缺失')), 'plugin 级原因须经 plugin 条目进入报告（不得红但无因）');
    // 2026-11-04 收尾评审 F1：缺源事实单一来源——派生后果（清单缺失／处置表／引擎闭包枚举失败）
    // 不得重复入报告（此前 46 条＝同一事实三套措辞＋派生噪声）。
    assert.equal(irReal.problems.some((p) => p.includes('源清单缺失')), false, '派生后果不得入报告（缺源事实单一来源）');
    assert.equal(irReal.problems.some((p) => p.includes('引擎闭包：枚举失败')), false, '引擎源缺失只报一次（不按插件重复）');
    assert.equal(irReal.plugins.every((p) => p.written === 0), true, 'precheck 早退时 written 必须为 0（零写入不得虚报物化数）');
    assert.equal(existsSync(join(dataDirReal, 'plugins')), false, 'precheck 必须零写入');
  });

  it('verify：变更一个字节即报漂移并非零退出', () => {
    const target = join(dataDir, 'plugins', 'scout', 'skills', 'scout', 'SKILL.md');
    const original = readFileSync(target);
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n<!-- drift -->\n')]));
    try {
      const result = runCli(['verify', '--data-dir', dataDir]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /变更 1/);
      assert.match(result.stdout, /skills\/scout\/SKILL\.md/);
    } finally {
      writeFileSync(target, original);
    }
  });

  it('verify：缺失与多余都能逮到', () => {
    const removed = join(dataDir, 'plugins', 'workflow', 'NOTICE');
    const added = join(dataDir, 'plugins', 'workflow', 'stray.txt');
    rmSync(removed);
    writeFileSync(added, 'x');
    try {
      const result = runCli(['verify', '--data-dir', dataDir]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /缺失 1/);
      assert.match(result.stdout, /多余 1/);
      assert.match(result.stdout, /NOTICE/);
      assert.match(result.stdout, /stray\.txt/);
    } finally {
      rmSync(added);
    }
    // 恢复靠重新 install（verify 只读不写），顺带证明 install 会把被删的源资产补回来
    assert.equal(runCli(['install', '--data-dir', dataDir]).status, 0);
    assert.ok(existsSync(removed), '重跑 install 应补回缺失的源资产');
    assert.equal(runCli(['verify', '--data-dir', dataDir]).status, 0, '恢复后应回到零漂移');
  });

  it('--prune：显式清理计划外旧文件；默认 install 仍不删目录', () => {
    const stray = join(dataDir, 'plugins', 'spec-gate', 'core', 'validator', 'stale.py');
    writeFileSync(stray, 'x');
    assert.equal(runCli(['verify', '--data-dir', dataDir]).status, 1);
    const preview = runCli(['install', '--dry-run', '--data-dir', dataDir, '--prune']);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /prune 1 个旧文件/);
    assert.ok(existsSync(stray), 'dry-run 不得删除文件');
    assert.equal(runCli(['install', '--data-dir', dataDir]).status, 0);
    assert.ok(existsSync(stray), '默认 install 不得删除计划外文件（运行中会话路径保护）');
    const pruned = runCli(['install', '--data-dir', dataDir, '--prune']);
    assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    assert.ok(!existsSync(stray), '--prune 应清理计划外旧文件');
    assert.equal(runCli(['verify', '--data-dir', dataDir]).status, 0);
  });

  it('install 幂等：连跑两次逐字节一致，且不删目录', () => {
    const before2 = walkRel(join(dataDir, 'plugins', 'workflow')).map((rel) => `${rel}:${sha256OfFile(join(dataDir, 'plugins', 'workflow', ...rel.split('/')))}`);
    const result = runCli(['install', '--data-dir', dataDir]);
    assert.equal(result.status, 0);
    const after2 = walkRel(join(dataDir, 'plugins', 'workflow')).map((rel) => `${rel}:${sha256OfFile(join(dataDir, 'plugins', 'workflow', ...rel.split('/')))}`);
    assert.deepEqual(after2, before2);
  });

  test('agent 面：默认不装；显式开启时装三份且形态合规', () => {
    assert.ok(!existsSync(join(dataDir, 'agents')), '默认不装（保守取舍：未在跑起来的宿主上观测过委派）');
    const result = runCli(['install', '--data-dir', dataDir, '--with-agents']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const names = readdirSync(join(dataDir, 'agents')).filter((name) => !name.startsWith('.')).sort();
    assert.deepEqual(names, ['code-architect', 'code-explorer', 'code-reviewer']);
    assert.ok(existsSync(join(dataDir, 'agents', '.mcode-adapter-managed.json')), '管理标记应落盘（verify/prune 归属判定用）');
    for (const name of names) {
      const text = readFileSync(join(dataDir, 'agents', name, 'agent.md'), 'utf8');
      assert.match(text, /^---\nname: /);
      assert.match(text, /\ntools:\n {2}- /, '工具白名单须是原生名列表');
      assert.match(text, /\nfeatures:\n {2}delegation: false/);
    }
  });

  it('用法面：未知参数退 2，--help 退 0', () => {
    assert.equal(runCli(['--nope']).status, 2);
    assert.equal(runCli(['--help']).status, 0);
  });

  it('缺解释器即拒绝安装（不写坏包、不静默降级）', () => {
    const empty = tempRoot('install-nonode');
    try {
      const result = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', empty], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '', ProgramFiles: '', LOCALAPPDATA: '' },
        windowsHide: true,
      });
      // 本进程自身就是 node，故 self 级仍可能命中；断言只有一种合法结果：成功或明确拒绝
      assert.ok(result.status === 0 || (result.status === 2 && /node/.test(result.stderr)), `退出码 ${result.status}：${result.stderr}`);
    } finally {
      removeRoot(empty);
    }
  });

  it('写入面只有数据目录：仓内不留物化产物', () => {
    assert.ok(!existsSync(join(REPO_ROOT, 'mcode-adapter', 'plugins')), '仓内不得出现物化输出');
    assert.ok(!existsSync(join(REPO_ROOT, 'mcode-adapter', '.minimax-plugin')));
    const adapterEntries = readdirSync(join(REPO_ROOT, 'mcode-adapter')).sort();
    assert.deepEqual(adapterEntries, ['README.md', 'cli.mjs', 'mcode', 'src', 'tests'].filter((name) => adapterEntries.includes(name)), '适配层目录构成固定');
  });

  it('包内不得出现适配层之外的越界路径（相对路径 + 段字符集）', () => {
    for (const plugin of PLUGINS) {
      for (const rel of walkRel(join(dataDir, 'plugins', plugin))) {
        assert.ok(!rel.includes('..'), `${plugin}: ${rel}`);
        assert.ok(!rel.includes('\\'), `${plugin}: ${rel}`);
        for (const segment of rel.split('/')) assert.match(segment, /^[A-Za-z0-9._-]+$/, `${plugin}: ${rel}`);
      }
    }
  });
});

describe('计划面（不落盘）', () => {
  it('dry-run 报计划且不写任何文件', () => {
    const dir = tempRoot('install-dry');
    const result = runCli(['install', '--dry-run', '--data-dir', dir]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /计划 \d+ 个文件/);
    assert.ok(!existsSync(join(dir, 'plugins')), 'dry-run 不得落盘');
    removeRoot(dir);
  });

  it('临时目录可清理（测试自身不留垃圾）', () => {
    const dir = tempRoot('install-clean');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b.txt'), 'x');
    removeRoot(dir);
    assert.ok(!existsSync(dir));
  });

  it('A6 无参即打印用法退 2（不再缺省执行 install——行为孤例收敛，对齐 kimi/zcode/plugin-core）', () => {
    // 宿主根双保险（阶段复审① 约定8，kimi 侧同款）：MINIMAX_DATA_DIR 指 tmp——守卫回归
    // （退回缺省执行 install）时也不触真机数据目录。
    const guardDir = tempRoot('noarg-guard');
    mkdirSync(guardDir, { recursive: true });
    try {
      const result = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, MINIMAX_DATA_DIR: guardDir },
        windowsHide: true,
      });
      assert.equal(result.status, 2, `无参应退 2（实得 ${result.status}）`);
      assert.match(result.stderr, /用法：node mcode-adapter\/cli\.mjs/, '无参输出须附 USAGE');
    } finally {
      removeRoot(guardDir);
    }
  });

  it('A6 值旗标吞值防护：--data-dir --json → 用法错退 2（不把 --json 当路径）', () => {
    const dir = tempRoot('install-flagguard');
    try {
      const result = runCli(['install', '--data-dir', dir, '--repo-root', '--json']);
      assert.equal(result.status, 2, `值形如旗标必须退 2（实得 ${result.status}；stdout=${String(result.stdout).slice(0, 160)}）`);
      assert.match(result.stderr, /无法识别的参数/);
      assert.match(result.stderr, /用法：node mcode-adapter\/cli\.mjs/, '参数错须附 USAGE（三 CLI 一致）');
    } finally {
      removeRoot(dir);
    }
  });
});

// 内部任务-55 步骤 2.7 —— 物化面排除本地产物。口径与 `zcode-adapter/src/expect-tree.mjs` 的
// `IGNORED(rel)` 同款（内部任务-PYCLEAN-1，与 `spec-gate/assurance/probes.mjs` 的 DEFAULT_IGNORE
// 互见）：任一路径段为 `__pycache__`/`.mimosa`，或末段匹配 `*.pyc`。
//
// 为什么必须排除（不是洁癖，是可核账的前提）：这些是构建缓存而非资产，且**两侧各编译一次**——
// 源树一份、已装包一份，字节必然不同（实测 `receipts.cpython-314.pyc` 源 39,572 B / 装 39,570 B）。
// 只要两边各自跑过 Python，`verify` 就结构性报红，而失败方向会被误读成「资产被篡改」。
// 基线证据：内部证据
//
// 判别力：把 `isLocalArtifact` 短路为恒 `false` 时本用例必红（三种形态在一例内全覆盖）。
describe('内部任务-55 步骤 2.7：物化面排除本地产物', () => {
  it('__pycache__ 段、.mimosa 段与 *.pyc 末段一律不进物化计划，正常文件不受影响', () => {
    const dir = tempRoot('install-localartifact');
    try {
      mkdirSync(join(dir, 'assurance', '__pycache__'), { recursive: true });
      mkdirSync(join(dir, '.mimosa'), { recursive: true });
      writeFileSync(join(dir, 'assurance', '__pycache__', 'gate.cpython-314.pyc'), 'cache');
      writeFileSync(join(dir, '.mimosa', 'state.json'), 'cache');
      writeFileSync(join(dir, 'top.pyc'), 'cache');
      writeFileSync(join(dir, 'keep.json'), '{}');
      const rels = listSourceFiles(dir).map((f) => f.rel);
      assert.deepEqual(rels, ['keep.json'], `本地产物须全部排除（实得 ${JSON.stringify(rels)}）`);
    } finally {
      removeRoot(dir);
    }
  });

  it('真实源树枚举面已不含本地产物（spec-gate 的 __pycache__ 不得进计划）', () => {
    const rels = listSourceFiles(join(REPO_ROOT, 'spec-gate')).map((f) => f.rel);
    const leaked = rels.filter((rel) => rel.includes('__pycache__') || rel.endsWith('.pyc') || rel.includes('.mimosa/'));
    assert.deepEqual(leaked, [], `真实源树枚举出本地产物 ${leaked.length} 项：${leaked.slice(0, 3).join(', ')}`);
  });

  // 评审补强（内部任务-55 code-review 正确性维 F2）：上面两条只覆盖**计划侧**枚举。若 verify 的
  // 「多余」走查侧漏剪，已装包内的历史本地产物残留会被永久计为多余（本次热修的原始缺陷原样复发），
  // 而删掉那两行剪枝套件仍全绿。本条端到端钉住两侧：残留被放过、真实漂移仍被报出。
  it('verify 侧：已装包内的本地产物残留不计入多余，而真实漂移文件仍被报出', () => {
    const dir = tempRoot('install-artifact-extra');
    try {
      const installed = runCli(['install', '--data-dir', dir]);
      assert.equal(installed.status, 0, `install 应成功：${String(installed.stderr)}`);
      const pkg = join(dir, 'plugins', 'workflow');
      writeFileSync(join(pkg, 'stray.pyc'), 'cache');
      mkdirSync(join(pkg, 'sub', '__pycache__'), { recursive: true });
      writeFileSync(join(pkg, 'sub', '__pycache__', 'y.pyc'), 'cache');
      writeFileSync(join(pkg, 'drift.txt'), 'drift');
      const r = runCli(['verify', '--data-dir', dir]);
      const out = String(r.stdout) + String(r.stderr);
      assert.ok(!out.includes('stray.pyc'), `本地产物残留不得计入多余（实得：${out}）`);
      assert.ok(!out.includes('y.pyc'), `__pycache__ 段下的残留不得计入多余（实得：${out}）`);
      assert.ok(out.includes('drift.txt'), `真实漂移文件必须仍被报为多余（实得：${out}）`);
      assert.notEqual(r.status, 0, '存在真实漂移时 verify 须退非零（不得因剪枝而整体放行）');
    } finally {
      removeRoot(dir);
    }
  });
});

// ── 内部决策-048/内部任务-11：宿主应用在位探测输出（与 assurance 探针同库两独立读取者）──

describe('宿主应用在位行（内部决策-048）', () => {
  test('MINIMAX_APP_ROOT 指向真目录 → 输出在位行（含命中路径）', () => {
    const dir = tempRoot('mcode-host-present');
    try {
      const appDir = join(dir, 'MiniMax Code.app');
      mkdirSync(appDir, { recursive: true });
      const r = runCli(['install', '--dry-run', '--data-dir', dir], { MINIMAX_APP_ROOT: appDir });
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 0, out);
      assert.match(out, /宿主应用：在位（.*MiniMax Code\.app）/);
    } finally {
      removeRoot(dir);
    }
  });

  it('宿主未检出 → install 不硬失败（预装合法）＋收尾行如实改口数据面物化就绪', () => {
    const dir = tempRoot('mcode-host-absent');
    try {
      const r = runCli(['install', '--data-dir', dir], { MINIMAX_APP_ROOT: join(dir, 'nowhere.app') });
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 0, out); // 未检出不阻断安装
      assert.match(out, /宿主应用：未检出/);
      assert.match(out, /数据面物化就绪——宿主未检出，非宿主装机生效/);
      assert.match(out, /MINIMAX_APP_ROOT/); // 出路提示
    } finally {
      removeRoot(dir);
    }
  });
});

// ── 内部决策-054 G-01/G-02/G-03：写后即验/copy 备份/失败回滚/verify 只读/agents 面 ──

/** 备份根为空或不存在（成功/完整回滚后必须清理）。 */
function backupRootCleared(dataDir) {
  const root = join(dataDir, '.mcode-adapter-backups');
  return !existsSync(root) || readdirSync(root).length === 0;
}

describe('安装写后即验与 copy 式备份（内部决策-054 G-01）', () => {
  it('正常 install：写后即验通过且备份根清理', () => {
    const dir = tempRoot('install-verify-ok');
    try {
      const r = runCli(['install', '--data-dir', dir]);
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 0, out);
      assert.match(out, /写后即验通过/);
      assert.ok(backupRootCleared(dir), '成功路径应清理备份根');
    } finally {
      removeRoot(dir);
    }
  });

  it('库级注入写后即验漂移：回滚到调用前指纹（含备份回放判别哨兵）、清理备份根并返回 phase=verify', () => {
    const dir = tempRoot('install-rollback-inject');
    try {
      assert.equal(runCli(['install', '--data-dir', dir]).status, 0);
      // 判别力：向计划内文件写哨兵（与计划字节不同）——若实现只清备份而不做 restore，
      // 写后即验前的写盘会把哨兵覆盖为计划字节，回滚后指纹将与 before 不等。
      const sentinel = join(dir, 'plugins', 'workflow', 'NOTICE');
      writeFileSync(sentinel, 'sentinel-content');
      const before = {};
      for (const plugin of PLUGINS) before[plugin] = fingerprintTree(join(dir, 'plugins', plugin));
      const plans = PLUGINS.map((plugin) => planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: process.execPath }));
      const result = installPackages({
        plans,
        dataDir: dir,
        dryRun: false,
        verifyImpl: () => ({ missing: [], changed: ['注入漂移'], extra: [], problems: [] }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.phase, 'verify');
      assert.equal(result.exitCode, 1);
      assert.match(String(result.message), /已回滚本次写入/);
      for (const plugin of PLUGINS) assert.deepEqual(fingerprintTree(join(dir, 'plugins', plugin)), before[plugin], `${plugin} 回滚后指纹应等于调用前`);
      assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel-content', '备份回放应恢复哨兵内容（仅清备份的变异实现必红）');
      assert.ok(backupRootCleared(dir), '完整回滚后应清理备份根');
    } finally {
      removeRoot(dir);
    }
  });

  it('CLI 级写失败（计划内路径预建为目录）：回滚退 2 且调用前指纹保持', () => {
    const dir = tempRoot('install-rollback-writefail');
    try {
      mkdirSync(join(dir, 'plugins', 'workflow', 'NOTICE'), { recursive: true });
      const before = fingerprintTree(dir);
      const r = runCli(['install', '--data-dir', dir]);
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 2, out);
      assert.match(out, /安装失败：已回滚本次写入/);
      assert.deepEqual(fingerprintTree(dir), before, '回滚后数据目录文件级指纹应等于调用前');
      assert.ok(backupRootCleared(dir), '完整回滚后应清理备份根');
    } finally {
      removeRoot(dir);
    }
  });

  it('升级态：旧多余文件在场时默认 install 保留并退 0；--prune 清理', () => {
    const dir = tempRoot('install-upgrade-extra');
    try {
      assert.equal(runCli(['install', '--data-dir', dir]).status, 0);
      const stray = join(dir, 'plugins', 'workflow', 'stale.tmp');
      writeFileSync(stray, 'x');
      const plain = runCli(['install', '--data-dir', dir]);
      assert.equal(plain.status, 0, `默认 install 不应因计划外文件失败：${String(plain.stderr)}`);
      assert.ok(existsSync(stray), '默认 install 不得删除计划外文件');
      const pruned = runCli(['install', '--data-dir', dir, '--prune']);
      assert.equal(pruned.status, 0, `${String(pruned.stdout)}${String(pruned.stderr)}`);
      assert.match(String(pruned.stdout), /prune 1 个旧文件/, '真实 prune 安装的成功行应报告清理数（dry-run 之外路径）');
      assert.ok(!existsSync(stray), '--prune 应清理计划外旧文件');
    } finally {
      removeRoot(dir);
    }
  });
});

describe('verify 零写与 agents 面（内部决策-054 G-02/G-03）', () => {
  it('verify --with-agents 不产生写副作用（agents 目录不创建、数据目录指纹不变）', () => {
    const dir = tempRoot('install-verify-readonly');
    try {
      assert.equal(runCli(['install', '--data-dir', dir]).status, 0);
      // 宿主内建 agents 面（MCode 真机 `.builtin/` 实测形态）：无本层管理标记 ⇒ verify 不得误报缺失/多余
      mkdirSync(join(dir, 'agents', '.builtin', 'explore'), { recursive: true });
      writeFileSync(join(dir, 'agents', '.builtin', 'explore', 'agent.md'), 'host builtin');
      const before = fingerprintTree(dir);
      const r = runCli(['verify', '--with-agents', '--data-dir', dir]);
      assert.equal(r.status, 0, `${String(r.stdout)}${String(r.stderr)}`);
      assert.ok(!existsSync(join(dir, 'agents', 'code-explorer')), 'verify 不得物化本层 agent 目录');
      assert.ok(!existsSync(join(dir, 'agents', '.mcode-adapter-managed.json')), 'verify 不得写管理标记');
      assert.deepEqual(fingerprintTree(dir), before, 'verify 前后数据目录指纹应全等');
    } finally {
      removeRoot(dir);
    }
  });

  it('已安装 agents 被篡改 → verify（不带 --with-agents）报出并退 1', () => {
    const dir = tempRoot('install-agents-drift');
    try {
      assert.equal(runCli(['install', '--with-agents', '--data-dir', dir]).status, 0);
      const target = join(dir, 'agents', 'code-explorer', 'agent.md');
      assert.ok(existsSync(target), 'agents 应已安装');
      // 宿主内建 agent（顶层 `.` 目录）不参与多余判定；本层漂移仍须报出
      mkdirSync(join(dir, 'agents', '.builtin', 'mavis'), { recursive: true });
      writeFileSync(join(dir, 'agents', '.builtin', 'mavis', 'agent.md'), 'host builtin');
      writeFileSync(target, 'drift');
      const r = runCli(['verify', '--data-dir', dir]);
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 1, out);
      assert.match(out, /agents/);
      assert.match(out, /code-explorer/);
      assert.ok(!out.includes('.builtin'), '宿主内建 agent 不得计入多余');
    } finally {
      removeRoot(dir);
    }
  });

  it('install --with-agents --prune 只清理本层拥有项（他源 agent 保留）', () => {
    const dir = tempRoot('install-agents-prune');
    try {
      assert.equal(runCli(['install', '--with-agents', '--data-dir', dir]).status, 0);
      // 他源 agent：非本层标记拥有，--prune 不得删除
      const stray = join(dir, 'agents', 'stray', 'agent.md');
      mkdirSync(dirname(stray), { recursive: true });
      writeFileSync(stray, 'x');
      // 本层旧项：标记拥有、但已不在当前源集 → 应被 prune 回收
      const markerPath = join(dir, 'agents', '.mcode-adapter-managed.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      marker.files = [...marker.files, 'stale/agent.md'];
      writeFileSync(markerPath, JSON.stringify(marker));
      const stale = join(dir, 'agents', 'stale', 'agent.md');
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, 'x');
      const r = runCli(['install', '--with-agents', '--prune', '--data-dir', dir]);
      assert.equal(r.status, 0, `${String(r.stdout)}${String(r.stderr)}`);
      assert.ok(!existsSync(stale), '拥有但已不在源集的旧项应被 prune');
      assert.ok(existsSync(stray), '--prune 不得删除他源 agent');
    } finally {
      removeRoot(dir);
    }
  });

  it('agents 面归属：他源 agent 不被 verify 报多余、不被 --prune 删除', () => {
    const dir = tempRoot('agents-ownership');
    try {
      assert.equal(runCli(['install', '--with-agents', '--data-dir', dir]).status, 0);
      mkdirSync(join(dir, 'agents', 'my-custom'), { recursive: true });
      writeFileSync(join(dir, 'agents', 'my-custom', 'agent.md'), 'user agent');
      const before = fingerprintTree(dir);
      const v = runCli(['verify', '--data-dir', dir]);
      assert.equal(v.status, 0, `${String(v.stdout)}${String(v.stderr)}`);
      assert.ok(!String(v.stdout).includes('my-custom'), '他源 agent 不得被报为多余');
      assert.deepEqual(fingerprintTree(dir), before, 'verify 仍须零写');
      const p = runCli(['install', '--with-agents', '--prune', '--data-dir', dir]);
      assert.equal(p.status, 0, `${String(p.stdout)}${String(p.stderr)}`);
      assert.ok(existsSync(join(dir, 'agents', 'my-custom', 'agent.md')), '--prune 不得删除他源 agent');
    } finally { removeRoot(dir); }
  });

  it('agents 半装：一个 agent 映射为空不拖累其余，且安装侧与校验侧同谓词', () => {
    const repo = tempRoot('agents-partial-repo');
    const data = tempRoot('agents-partial-data');
    try {
      mkdirSync(join(repo, 'workflow', 'agents'), { recursive: true });
      writeFileSync(join(repo, 'workflow', 'agents', 'good.md'), '---\nname: good\ndescription: ok\ntools: Read\n---\nbody\n');
      writeFileSync(join(repo, 'workflow', 'agents', 'empty.md'), '---\nname: empty\ndescription: bad\ntools: BashOutput\n---\nbody\n');
      const r = installAgents({ repoRoot: repo, dataDir: data, dryRun: false });
      assert.deepEqual(r.targets.map((p) => relative(join(data, 'agents'), p).split(sep).join('/')), ['good/agent.md']);
      assert.ok(r.problems.some((p) => p.includes('empty')));
      const marker = JSON.parse(readFileSync(join(data, 'agents', '.mcode-adapter-managed.json'), 'utf8'));
      assert.deepEqual(marker.files, ['good/agent.md']);
      assert.ok(!existsSync(join(data, 'agents', 'empty', 'agent.md')), '映射为空的 agent 不落盘');
      assert.deepEqual(verifyAgents({ repoRoot: repo, dataDir: data }).missing, [], '校验侧不得把已跳过的 empty 判缺失');
    } finally { removeRoot(repo); removeRoot(data); }
  });

  it('agents 陈旧项收敛：不可装后 verify 报多余、--prune 删除并收窄标记', () => {
    const repo = tempRoot('agents-stale-repo');
    const data = tempRoot('agents-stale-data');
    try {
      mkdirSync(join(repo, 'workflow', 'agents'), { recursive: true });
      writeFileSync(join(repo, 'workflow', 'agents', 'a.md'), '---\nname: a\ndescription: ok\ntools: Read\n---\na\n');
      writeFileSync(join(repo, 'workflow', 'agents', 'b.md'), '---\nname: b\ndescription: ok\ntools: Read\n---\nb\n');
      assert.equal(installAgents({ repoRoot: repo, dataDir: data, dryRun: false }).targets.length, 2);
      // b 由可装变为空映射（不是删文件）：install 跳过、标记并集仍拥有、verify 判多余、prune 回收
      writeFileSync(join(repo, 'workflow', 'agents', 'b.md'), '---\nname: b\ndescription: ok\ntools: BashOutput\n---\nb\n');
      assert.equal(installAgents({ repoRoot: repo, dataDir: data, dryRun: false }).targets.length, 1);
      assert.deepEqual(verifyAgents({ repoRoot: repo, dataDir: data }).extra, ['b/agent.md'], '旧项须仍被标记拥有并报多余');
      assert.deepEqual(pruneAgents({ repoRoot: repo, dataDir: data }), ['b/agent.md']);
      assert.ok(!existsSync(join(data, 'agents', 'b', 'agent.md')));
      const markerPath = join(data, 'agents', '.mcode-adapter-managed.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.deepEqual(marker.files, ['a/agent.md'], 'prune 后标记收敛到当前可装集');
      // 坏标记（C2）：损坏 JSON 与越界条目都必须零删除授权 + problem
      writeFileSync(markerPath, '{ broken');
      const corruptProblems = [];
      assert.deepEqual([...readAgentsOwnership(join(data, 'agents'), corruptProblems)], [], '损坏标记零授权');
      assert.ok(corruptProblems.length > 0, '损坏标记须可见');
      writeFileSync(markerPath, JSON.stringify({ files: ['../evil/agent.md'] }));
      const badProblems = [];
      assert.deepEqual([...readAgentsOwnership(join(data, 'agents'), badProblems)], [], '越界条目零授权');
      assert.ok(badProblems.length > 0, '越界条目须可见');
      // 单段越界：`../agent.md` / `./agent.md` / names:['..'] 都必须零授权（字符类放行点号，须段级判据）
      const outsideFile = join(data, 'agent.md');
      writeFileSync(outsideFile, 'sentinel');
      writeFileSync(join(data, 'agents', 'agent.md'), 'sentinel2');
      for (const bad of [{ files: ['../agent.md'] }, { files: ['./agent.md'] }, { names: ['..'] }]) {
        writeFileSync(markerPath, JSON.stringify(bad));
        const p = [];
        assert.deepEqual([...readAgentsOwnership(join(data, 'agents'), p)], [], `单段越界须零授权：${JSON.stringify(bad)}`);
        assert.ok(p.length > 0, '单段越界须可见');
        assert.deepEqual(pruneAgents({ repoRoot: repo, dataDir: data }), [], '非法标记不得删除');
        assert.ok(existsSync(outsideFile), 'agents 根外文件不得被删');
        assert.ok(existsSync(join(data, 'agents', 'agent.md')), 'agents 根内非清单文件不得被删');
      }
    } finally { removeRoot(repo); removeRoot(data); }
  });

  it('--with-agents --prune：源 agents 不可得 ⇒ 零删除且退非 0', () => {
    const dir = tempRoot('agents-fatal-prune');
    let pruneCalls = 0;
    try {
      const plans = PLUGINS.map((plugin) => planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: process.execPath }));
      const r = installPackages({
        plans, dataDir: dir, dryRun: false, prune: true, withAgents: true,
        agentOps: {
          install: () => ({ names: [], targets: [], dropped: [], problems: [], fatal: ['源 agents 目录缺失'] }),
          verify: () => ({ missing: [], changed: [], extra: [], problems: [] }),
          prune: () => { pruneCalls += 1; return []; },
        },
      });
      assert.equal(r.ok, false, 'fatal 必须使安装失败');
      assert.equal(pruneCalls, 0, 'fatal 时不得调用 prune（keep 为空会删净本层 agent）');
      assert.ok((r.problems ?? []).some((p) => p.includes('源 agents 目录缺失')));
    } finally { removeRoot(dir); }
  });

  it('默认 install --with-agents 允许计划外 agent 文件在场（仅 --prune 清理）', () => {
    const dir = tempRoot('install-agents-extra-default');
    try {
      assert.equal(runCli(['install', '--with-agents', '--data-dir', dir]).status, 0);
      const stray = join(dir, 'agents', 'stray', 'agent.md');
      mkdirSync(dirname(stray), { recursive: true });
      writeFileSync(stray, 'x');
      const r = runCli(['install', '--with-agents', '--data-dir', dir]);
      assert.equal(r.status, 0, `默认 install 不应因计划外 agent 文件失败：${String(r.stderr)}`);
      assert.ok(existsSync(stray), '默认 install 不得删除计划外 agent 文件（与包面同向）');
    } finally {
      removeRoot(dir);
    }
  });

  it('库级 --with-agents 写后失败：本次新写 agents 文件随回滚删除（planned 登记生效）', () => {
    const dir = tempRoot('install-agents-rollback');
    try {
      assert.equal(runCli(['install', '--data-dir', dir]).status, 0);
      const plans = PLUGINS.map((plugin) => planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: process.execPath }));
      const agentsRoot = join(dir, 'agents');
      const result = installPackages({
        plans,
        dataDir: dir,
        dryRun: false,
        withAgents: true,
        agentOps: {
          install: (options) => {
            mkdirSync(join(agentsRoot, 'junk'), { recursive: true });
            writeFileSync(join(agentsRoot, 'junk', 'agent.md'), 'junk');
            options?.onPlan?.(['junk/agent.md']);
            return { names: ['junk'], targets: [join(agentsRoot, 'junk', 'agent.md')], dropped: [], problems: [], fatal: [] };
          },
          verify: () => ({ missing: [], changed: [], extra: [], problems: ['注入 agents 失败'] }),
          prune: () => [],
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.phase, 'verify');
      assert.ok(!existsSync(join(agentsRoot, 'junk', 'agent.md')), '本次新写 agents 文件应被回滚删除（planned 未登记时此处必红）');
      assert.ok(backupRootCleared(dir), '完整回滚后备份根清理');
    } finally {
      removeRoot(dir);
    }
  });

  it('首装多包写后失败（无备份删除分支）：已写包被清回调用前', () => {
    const dir = tempRoot('install-firstwrite-fail');
    try {
      // workflow 已写、spec-gate 写入时失败（skills 预置为文件 → mkdir 子目录 ENOTDIR），
      // 覆盖首装 backupTarget=null 的删除分支（此前用例均发生在有备份的升级态或首包）。
      mkdirSync(join(dir, 'plugins', 'spec-gate'), { recursive: true });
      writeFileSync(join(dir, 'plugins', 'spec-gate', 'skills'), 'block');
      const before = fingerprintTree(dir);
      const r = runCli(['install', '--data-dir', dir]);
      const out = `${String(r.stdout)}${String(r.stderr)}`;
      assert.equal(r.status, 2, out);
      assert.match(out, /安装失败：已回滚本次写入/);
      assert.deepEqual(fingerprintTree(dir), before, '回滚后文件级指纹应等于调用前（无备份包删除分支生效）');
      assert.ok(backupRootCleared(dir), '完整回滚后备份根清理');
    } finally {
      removeRoot(dir);
    }
  });

  it('备份根清理失败可见：warnings 含路径且安装仍成功', () => {
    const dir = tempRoot('install-backup-warn');
    try {
      const plans = PLUGINS.map((plugin) => planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: process.execPath }));
      const r = installPackages({
        plans, dataDir: dir, dryRun: false,
        removeImpl: () => { throw new Error('EBUSY: 被占用'); },
      });
      assert.equal(r.ok, true);
      assert.ok((r.warnings ?? []).some((w) => w.includes('.mcode-adapter-backups') && w.includes('EBUSY')));
    } finally { removeRoot(dir); }
  });

  it('装载探针超时：注入 spawn 桩返回超时 ⇒ problems 含「超时」', () => {
    const dir = tempRoot('probe-timeout');
    try {
      mkdirSync(join(dir, 'plugin-core', 'src'), { recursive: true });
      writeFileSync(join(dir, 'plugin-core', 'src', 'engine.mjs'), 'export function loadEngine(){return {applyRule(){}};}');
      const problem = probeEngineInPackage(dir, { spawn: () => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }) });
      assert.match(String(problem), /超时/);
    } finally { removeRoot(dir); }
  });

  it('--json 失败路径带 phase/message/backupRoot/warnings', () => {
    const dir = tempRoot('install-json');
    try {
      assert.equal(runCli(['install', '--data-dir', dir]).status, 0);
      rmSync(join(dir, 'plugins', 'workflow', 'README.md'), { force: true });
      mkdirSync(join(dir, 'plugins', 'workflow', 'README.md'), { recursive: true });
      const r = runCli(['install', '--data-dir', dir, '--json']);
      assert.notEqual(r.status, 0);
      const report = JSON.parse(String(r.stdout));
      assert.equal(report.ok, false);
      assert.ok(report.phase);
      assert.ok(report.message);
      assert.ok('backupRoot' in report);
      assert.ok(Array.isArray(report.warnings));
    } finally { removeRoot(dir); }
  });
});

// 内部任务-295 修复复审 round2（三维实例）新增：覆盖「源侧读失败不得被伪装成空源」与
// 「dry-run 结论必须与真跑同档」两条此前无用例守护的失败面。
describe('源枚举与归属守卫（复审 round2）', () => {
  it('listAgentNames：目录缺失 ⇒ 空数组（ENOENT 是常态，不是故障）', () => {
    const dir = tempRoot('agents-missing');
    try {
      assert.deepEqual(listAgentNames(join(dir, 'agents')), []);
    } finally { removeRoot(dir); }
  });

  it('listAgentNames：源路径不是目录 ⇒ 上抛（ENOTDIR 不得被吞成空集）', () => {
    const dir = tempRoot('agents-notdir');
    try {
      const file = join(dir, 'agents');
      writeFileSync(file, 'x');
      assert.throws(() => listAgentNames(file), '非 ENOENT 必须上抛，否则 fatal 守卫不可达');
    } finally { removeRoot(dir); }
  });

  it('pruneAgents：源枚举为空（目录存在但无 .md）⇒ 零删除且不改写标记', () => {
    const repo = tempRoot('agents-empty-repo');
    const data = tempRoot('agents-empty-data');
    try {
      mkdirSync(join(repo, 'workflow', 'agents'), { recursive: true });
      const agentFile = join(data, 'agents', 'keep', 'agent.md');
      mkdirSync(dirname(agentFile), { recursive: true });
      writeFileSync(agentFile, 'x');
      writeFileSync(join(data, 'agents', '.mcode-adapter-managed.json'), JSON.stringify({ names: ['keep'], files: ['keep/agent.md'] }));
      assert.deepEqual(pruneAgents({ repoRoot: repo, dataDir: data }), []);
      assert.ok(existsSync(agentFile), '空源不得删净本层 agent');
    } finally { removeRoot(repo); removeRoot(data); }
  });

  it('pruneAgents：源不可读（agents 路径是文件）⇒ 零删除', () => {
    const repo = tempRoot('agents-fatal-repo');
    const data = tempRoot('agents-fatal-data');
    try {
      mkdirSync(join(repo, 'workflow'), { recursive: true });
      writeFileSync(join(repo, 'workflow', 'agents'), 'x');
      const agentFile = join(data, 'agents', 'keep', 'agent.md');
      mkdirSync(dirname(agentFile), { recursive: true });
      writeFileSync(agentFile, 'x');
      writeFileSync(join(data, 'agents', '.mcode-adapter-managed.json'), JSON.stringify({ files: ['keep/agent.md'] }));
      assert.deepEqual(pruneAgents({ repoRoot: repo, dataDir: data }), []);
      assert.ok(existsSync(agentFile), '源不可读不得删净本层 agent');
    } finally { removeRoot(repo); removeRoot(data); }
  });

  it('pruneAgents：源有 .md 但全部不可装 ⇒ 零删除（可装集为空同样不得删净）', () => {
    const repo = tempRoot('agents-alldropped-repo');
    const data = tempRoot('agents-alldropped-data');
    try {
      mkdirSync(join(repo, 'workflow', 'agents'), { recursive: true });
      writeFileSync(join(repo, 'workflow', 'agents', 'empty.md'), '---\nname: empty\ndescription: bad\ntools: BashOutput\n---\nbody\n');
      const agentFile = join(data, 'agents', 'keep', 'agent.md');
      mkdirSync(dirname(agentFile), { recursive: true });
      writeFileSync(agentFile, 'x');
      writeFileSync(join(data, 'agents', '.mcode-adapter-managed.json'), JSON.stringify({ files: ['keep/agent.md'] }));
      assert.deepEqual(pruneAgents({ repoRoot: repo, dataDir: data }), []);
      assert.ok(existsSync(agentFile), '可装集为空不得删净本层 agent');
    } finally { removeRoot(repo); removeRoot(data); }
  });

  it('installPackages dry-run：计划有问题 ⇒ ok:false 且 exitCode 2（与真跑同档）', () => {
    const dir = tempRoot('install-dry-problems');
    try {
      const plans = [{
        plugin: 'workflow',
        files: [],
        stats: { skills: 0, handlers: 0, commandsGenerated: 0 },
        problems: ['坏清单：故意注入'],
      }];
      const r = installPackages({ plans, dataDir: dir, dryRun: true, prune: false });
      assert.equal(r.ok, false, 'dry-run 有计划问题不得报 ok');
      assert.equal(r.exitCode, 2, '退出码须与真跑 precheck 同档');
      assert.ok(!existsSync(join(dir, 'plugins')), 'dry-run 仍不得落盘');
      assert.ok(r.plugins[0].problems.includes('坏清单：故意注入'), '问题须随 plugin 条目透出');
    } finally { removeRoot(dir); }
  });

  it('装载探针：启动失败不得报成「超时」', () => {
    const dir = tempRoot('probe-startfail');
    try {
      mkdirSync(join(dir, 'plugin-core', 'src'), { recursive: true });
      writeFileSync(join(dir, 'plugin-core', 'src', 'engine.mjs'), 'export function loadEngine(){return {applyRule(){}};}');
      const problem = probeEngineInPackage(dir, {
        spawn: () => ({ status: null, error: Object.assign(new Error('denied'), { code: 'EACCES' }) }),
      });
      assert.match(String(problem), /启动失败/);
      assert.ok(!/超时/.test(String(problem)), '启动失败不得伪装成超时');
    } finally { removeRoot(dir); }
  });
});
