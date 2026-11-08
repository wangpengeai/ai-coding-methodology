// 文件：zcode-adapter/tests/cli-main.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201）——以 in-process import 覆盖 `cli.mjs` 的 `main(argv)` 参数/
//       分发/退出码分支，以及 `src/client-state.mjs` 的 zcode-home/市场源解析与客户端状态读取分支。
//       不触发发布/装机写面（verify/publish 均用 tmp 空市场源，只走拒绝/报告路径）。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 workflow/LICENSE）
// 自检：node --test "zcode-adapter/tests/cli-main.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { main } from '../cli.mjs';
import { normalizePathTail, readClientState, resolveMarketRoot, resolveZcodeHome } from '../src/client-state.mjs';
import { clientPath } from '../src/manifests.mjs';

/** 吞掉被测入口的 stdout/stderr，返回 {code, out, err}。 */
function run(argv) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = main(argv);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { code, out: out.join(''), err: err.join('') };
}

test('cli main：用法/未知参数/未知子命令/值旗标缺值均退 2 且打印用法', () => {
  assert.equal(run([]).code, 2, '无参数退 2 并打印用法');
  assert.equal(run(['--help']).code, 0, '--help 退 0');
  assert.equal(run(['-h']).code, 0, '-h 别名同 --help 退 0（FLAG_DEFS alias 分支，DEV-334）');
  assert.equal(run(['--bogus']).code, 2, '未知旗标退 2');
  assert.equal(run(['nope']).code, 2, '未知子命令退 2');
  assert.equal(run(['--repo-root']).code, 2, '值旗标缺值退 2');
  assert.equal(run(['verify', '--skip-tests']).code, 2, 'verify 不接受 --skip-tests');
  assert.equal(run(['publish']).code, 2, 'publish 缺 --marketplace 退 2');
  assert.equal(run(['verify', '--zcode-home', join(tmpdir(), 'dev209-no-such-zcode-home')]).code, 2, '市场源不可解析退 2');
  // 内部任务-333：入口退出纪律源扫描（kimi cli:1169 内部任务-241 先例）——回归 process.exit(main 即红
  const cliSrc = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');
  assert.ok(!cliSrc.includes('process.exit(main'), 'cli.mjs 入口不得 process.exit(main（管道截断；DEV-241 纪律）');
  assert.ok(cliSrc.includes('process.exitCode'), 'cli.mjs 入口须以 exitCode 赋值退出');
});

test('参数面错配通用校验：旗标-子命令错配逐格退 2 且 stderr 指认旗标与子命令（R-za-1/OPEN-154，DEV-275；DEV-334 补全格）', () => {
  const cells = [
    ['verify', '--bootstrap'],
    ['verify', '--dry-run'],
    ['publish', '--json'],
    ['publish', '--dry-run'],
    ['publish', '--zcode-home', '/tmp/dev275-no-write'],
    ['install', '--json'],
    ['install', '--skip-tests'],
    ['bump', '--json'],
    ['bump', '--zcode-home', '/tmp/dev275-no-write'],
    // 内部任务-334/内部未决-247②：FLAG_DEFS.cmds 转录的补全格（round 2 评审——九格未覆盖的放宽方向在此锁死）
    ['verify', '--skip-tests'],
    ['verify', '--note', 'x'],
    ['publish', '--bootstrap'],
    ['publish', '--version', '9.9.9'],
    ['install', '--note', 'x'],
    ['bump', '--marketplace', '/tmp/dev334-no-write'],
    ['bump', '--bootstrap'],
  ];
  for (const cell of cells) {
    const r = run(cell);
    assert.equal(r.code, 2, `${cell.join(' ')} 应退 2：${r.err}`);
    assert.ok(r.err.includes(cell[1]), `stderr 须指认旗标名（${cell[1]}）：${r.err}`);
    assert.ok(r.err.includes(cell[0]), `stderr 须指认子命令名（${cell[0]}）：${r.err}`);
  }
  // 合法组合守卫：bump --dry-run 是现行支持的组合（bump.mjs dry-run 早退），不得被错配校验拒绝
  // （其后因缺 --version 的退 2 属 bump 自身参数校验，另案）。
  const guard = run(['bump', '--dry-run']);
  assert.ok(!guard.err.includes('不适用于'), `bump --dry-run 是合法组合：${guard.err}`);
});

test('cli main：verify 在 tmp 空市场源上报告逐面红并退 1（不写宿主）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-zcode-cli-'));
  const market = join(home, 'market');
  mkdirSync(join(market, 'plugins'), { recursive: true });
  writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ plugins: [] }), 'utf8');
  const zcodeHome = join(home, 'zcode-home');
  mkdirSync(join(zcodeHome, 'cli', 'plugins'), { recursive: true });
  writeFileSync(join(zcodeHome, 'cli', 'plugins', 'known_marketplaces.json'), JSON.stringify({ marketplaces: [{ id: 'wangp-local-marketplace', source: { source: 'directory', path: market } }] }), 'utf8');
  try {
    const r = run(['verify', '--zcode-home', zcodeHome]);
    assert.equal(r.code, 1, `空市场源应报告逐面问题并退 1：${r.err}`);
    assert.match(r.out, /仓库根：/, '须打印仓库根');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('client-state：zcode-home/市场源/尾分隔符/客户端状态读取分支', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-zcode-state-'));
  try {
    assert.equal(resolveZcodeHome('', { HOME: '', USERPROFILE: '' }), '', '无家目录环境时退空串');
    assert.equal(resolveZcodeHome('/x/y'), resolve('/x/y'), '显式参数优先（按平台 path.resolve 归一）');
    assert.equal(resolveZcodeHome('', { ZCODE_HOME: join(home, 'zh') }), join(home, 'zh'), 'ZCODE_HOME 优先');
    assert.equal(resolveZcodeHome('', { USERPROFILE: home }), join(home, '.zcode'), 'win USERPROFILE 派生');
    assert.equal(resolveMarketRoot(home), null, 'known_marketplaces 缺失 → null');
    mkdirSync(join(home, 'cli', 'plugins'), { recursive: true });
    writeFileSync(join(home, 'cli', 'plugins', 'known_marketplaces.json'), '{bad', 'utf8');
    assert.equal(resolveMarketRoot(home), null, '坏 JSON → null');
    writeFileSync(join(home, 'cli', 'plugins', 'known_marketplaces.json'), JSON.stringify({ marketplaces: [
      { id: 'wangp-local-marketplace', source: { source: 'url', path: '/x' } },
      { id: 'other', source: { source: 'directory', path: '/y' } },
    ] }), 'utf8');
    assert.equal(resolveMarketRoot(home), null, '非 directory 源/非目标 id 不命中');
    writeFileSync(join(home, 'cli', 'plugins', 'known_marketplaces.json'), JSON.stringify({ marketplaces: [
      { id: 'wangp-local-marketplace', source: { source: 'directory', path: '/market-root' } },
    ] }), 'utf8');
    assert.equal(resolveMarketRoot(home), resolve('/market-root'), 'directory 源命中（按平台 path.resolve 归一）');
    assert.equal(normalizePathTail('/a/b///'), '/a/b', '尾分隔符归一（比较侧）');
    assert.equal(normalizePathTail('C:\\a\\b\\\\'), 'C:\\a\\b', 'win 反斜杠尾归一');
    const state = readClientState(home);
    assert.equal(state.registry, null, '缺登记表 → null');
    assert.equal(state.config, null, '缺 config → null');
    assert.equal(state.problems.length, 2, '两文件缺失各落一条 problem');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ── 内部任务-276 D1/D2/D3：参数面收紧 ────────────────────────────────────────────

test('bump 仓库根互斥：--repo-root 与位置参数同给退 2（DEV-276 D1）', () => {
  const r = run(['bump', '/tmp/dev276-a', '--repo-root', '/tmp/dev276-b', '--version', '1.0.0', '--note', 'x']);
  assert.equal(r.code, 2, r.err);
  assert.ok(r.err.includes('互斥'), r.err);
});

test('位置参数仅 bump：verify/publish/install 收到位置参数退 2（DEV-276 D2）', () => {
  for (const cmd of ['verify', 'publish', 'install']) {
    const r = run([cmd, '/tmp/dev276-positional']);
    assert.equal(r.code, 2, `${cmd} 应退 2：${r.err}`);
    assert.ok(r.err.includes('位置参数仅 bump'), r.err);
  }
  assert.ok(run(['nope', 'x']).err.includes('未知子命令'), '未知子命令仍报未知子命令（拦截限已知子命令）');
});

test('--selftest 独立形态：单独调用退 0；与子命令/其他参数组合退 2（DEV-276 D3）', () => {
  const solo = run(['--selftest']);
  assert.equal(solo.code, 0, `release-suite 调用形态须退 0：${solo.out.slice(-400)}${solo.err}`);
  for (const argv of [['--selftest', '--bogus'], ['verify', '--selftest'], ['--selftest', '--json'], ['--selftest', '--dry-run'], ['--selftest', '--repo-root', '/tmp/x']]) {
    const r = run(argv);
    assert.equal(r.code, 2, `${argv.join(' ')} 应退 2`);
    assert.ok(r.err.includes('独立形态'), r.err);
  }
});

test('known_marketplaces marketplaces 非数组不崩：解析返回 null、verify 按不可解退 2（DEV-276 D8）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev276-km-'));
  try {
    const km = clientPath(home, 'knownMarketplaces');
    mkdirSync(dirname(km), { recursive: true });
    writeFileSync(km, JSON.stringify({ marketplaces: 'x' }));
    assert.equal(resolveMarketRoot(home), null, '形态损坏按不可解返回 null（不抛 TypeError）');
    assert.equal(run(['verify', '--zcode-home', home]).code, 2, '显式「无法解析市场源」退 2，非异常穿透');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
