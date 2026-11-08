// 文件：os-observe-darwin.test.mjs
// 描述：os-observation darwin 后端（内部任务-OBSO-DARWIN-1，内部决策-029 决策 7；2026-10-13 内部任务-66
//       任务面升级 launchd 载体）——①采集器组：collect-darwin.mjs 整进程 fixture 子进程
//       （OS_OBSERVE_LSOF_OUT 输出替身——设置即读文件不 spawn，全平台可跑；真实样本
//       fixtures/os-observe/real-darwin-lsof.txt 锁 lsof 列方言）；②任务面 darwin 分支组
//       （install/uninstall/taskQuery/statusReport/opportunisticCollect——launchd LaunchAgent
//       语义，内部验收-19/23：spawnFn 桩 + platform 显式注入 + OS_OBSERVE_LAUNCHAGENTS_DIR
//       tmp 隔离，内部未决-32 纪律：一律显式 platform:'darwin'）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { agentDomain, install as installTask, uninstall as uninstallTask, opportunisticCollect, statusReport, taskQuery } from '../lib/os-observe-tasks.mjs';
import { tmpHome } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTOR = resolve(HERE, '..', 'adapters', 'os-observe', 'collect-darwin.mjs');
const REAL_LSOF = resolve(HERE, 'fixtures', 'os-observe', 'real-darwin-lsof.txt');

// 内部任务-337（内部未决-223）：tmpHome 收口至 tests/helpers.mjs（本地 withEnv/tmpAgents/runCollector 属同族域件，按登记边界不动）。

/** LaunchAgents 注入缝 tmp 目录（与 tmpHome 平行——任务面用例共用）。 */
function tmpAgents() {
  return mkdtempSync(join(tmpdir(), 'agents-'));
}

/** 注入缝环境键值设置与 finally 还原包裹（undefined→delete 口径，routing-lib.test withEnv 同款语义）。 */
function withEnv(pairs, fn) {
  const saved = pairs.map(([k]) => process.env[k]);
  for (const [k, v] of pairs) process.env[k] = v;
  try {
    return fn();
  } finally {
    pairs.forEach(([k], i) => {
      if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i];
    });
  }
}

/** 整进程跑采集器（OS_OBSERVE_HOME+OS_OBSERVE_LSOF_OUT 注入），返回 spawnSync 结果。 */
function runCollector(home, lsofOut, extraEnv = {}) {
  return spawnSync(process.execPath, [COLLECTOR], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, OS_OBSERVE_HOME: home, ...(lsofOut ? { OS_OBSERVE_LSOF_OUT: lsofOut } : {}), ...extraEnv },
  });
}

function readSamples(home) {
  const rawDir = join(home, 'raw');
  const files = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.startsWith('samples-')) : [];
  return files.flatMap((f) => readFileSync(join(rawDir, f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
}

// ── 采集器组（fixture 子进程，全平台可跑；内部验收-19）──

test('采集器：真实样本方言——established 远端/归因/回环过滤/source（real-darwin-lsof.txt）', () => {
  const home = tmpHome('os-observe-darwin-');
  try {
    const r = runCollector(home, REAL_LSOF);
    assert.equal(r.status, 0, `fail-open 退 0（stderr=${r.stderr}）`);
    const samples = readSamples(home);
    assert.equal(samples.length, 9, '11 行 - 2 回环对 = 9 样本');
    for (const s of samples) {
      assert.equal(s.kind, 'tcp');
      assert.equal(s.source, 'darwin-net-tcp-poll');
      assert.equal(typeof s.ip, 'string');
      assert.equal(typeof s.port, 'number');
      assert.ok(!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(s.ip), '回环/未指定不落盘');
      assert.ok(!('user' in s) && !('fd' in s) && !('device' in s), '白名单外 lsof 列不落盘（B-M14-5）');
    }
    const wetype = samples.find((s) => s.ip === '140.207.55.20');
    assert.ok(wetype && wetype.port === 443 && wetype.processName === 'WeType');
    const lan = samples.find((s) => s.ip === '192.168.3.83');
    assert.ok(lan && lan.port === 54020 && lan.processName === 'UURemote', '局域网远端保留（只滤回环/未指定）');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('采集器：合成变体——IPv6 方括号+zone 剥离/含空格 COMMAND/pid≤4/坏行/LISTEN/未指定', () => {
  const home = tmpHome('os-observe-darwin-');
  const synth = join(home, 'synthetic-lsof.txt');
  try {
    writeFileSync(synth, [
      'COMMAND    PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'WeType     948 wangpeng  102u  IPv4 0xd2743329244c3cfb      0t0  TCP 192.168.3.190:49165->140.207.55.20:443 (ESTABLISHED)',
      'Good Helper 1234 wangpeng  10u  IPv6 0xabc                 0t0  TCP [fe80::1%en0]:49166->[2001:db8::2]:443 (ESTABLISHED)',
      'Rsync      95 wangpeng    6u  IPv6 0x5                    0t0  TCP [fe80::a%en1]:5000->[fe80::9%en1]:443 (ESTABLISHED)',
      'QQLive    1384 wangpeng   10u  IPv4 0x6047bfa8b1b13177      0t0  TCP 127.0.0.1:56169->127.0.0.1:11119 (ESTABLISHED)',
      'kernel      0 root          6u  IPv4 0x1                   0t0  TCP 192.168.3.190:1->10.0.0.1:80 (ESTABLISHED)',
      'sshd       90 wangpeng    3u   IPv4 0x2                    0t0  TCP 10.0.0.3:5->10.0.0.1:abc (ESTABLISHED)',
      'node       91 wangpeng    4u   IPv4 0x3                    0t0  TCP 10.0.0.3:6->0.0.0.0:80 (ESTABLISHED)',
      'mDNS      99 wangpeng    5u   IPv4 0x4                    0t0  TCP *:5353 (LISTEN)',
      'broken line without tcp',
    ].join('\n'));
    const r = runCollector(home, synth);
    assert.equal(r.status, 0);
    const samples = readSamples(home);
    assert.equal(samples.length, 3, 'v4 行与两条 IPv6 行成样本');
    const v6 = samples.find((s) => s.ip === '2001:db8::2');
    assert.ok(v6 && v6.port === 443 && v6.processName === 'Good Helper', 'zone 剥离+方括号剥离+空格命令归因');
    const zoned = samples.find((s) => s.ip === 'fe80::9');
    assert.ok(zoned && zoned.port === 443 && zoned.processName === 'Rsync', '远端 %zone 后缀剥离（A-M14-19 子项）');
    assert.ok(samples.some((s) => s.ip === '140.207.55.20' && s.processName === 'WeType'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('采集器：7 天保留清理（旧 samples 删、当日保留）', () => {
  const home = tmpHome('os-observe-darwin-');
  try {
    mkdirSync(join(home, 'raw'), { recursive: true });
    writeFileSync(join(home, 'raw', 'samples-20200101.jsonl'), '{"old":1}\n');
    const past = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(home, 'raw', 'samples-20200101.jsonl'), past, past);
    const r = runCollector(home, REAL_LSOF);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(home, 'raw', 'samples-20200101.jsonl')), false, '超 7 天删除');
    assert.ok(readdirSync(join(home, 'raw')).some((f) => /^samples-\d{8}\.jsonl$/.test(f)), '当日落盘');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('采集器：fail-open 两形态——lsof 二进制缺失/输出替身文件缺失（退 0 无样本）', () => {
  const home = tmpHome('os-observe-darwin-');
  try {
    const r1 = runCollector(home, null, { OS_OBSERVE_LSOF_BIN: join(home, 'no-lsof') });
    assert.equal(r1.status, 0, 'lsof 缺失静默退 0');
    const r2 = runCollector(home, join(home, 'missing.txt'));
    assert.equal(r2.status, 0, '输出替身缺失静默退 0');
    assert.equal(readSamples(home).length, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 任务面 darwin 分支组（spawnFn 桩 + platform 显式注入；内部验收-19/23，内部任务-66 launchd 载体）──

test('install(darwin)：LaunchAgent 注册——plist 形态（Label/StartInterval×60/ProgramArguments 绝对路径/RunAtLoad）+bootstrap；白名单 1..1439（A-M14-23）', () => {
  const home = tmpHome('os-observe-darwin-');
  const agents = tmpAgents();
  try {
    withEnv([['OS_OBSERVE_HOME', home], ['OS_OBSERVE_LAUNCHAGENTS_DIR', agents]], () => {
      const calls = [];
      const spawnFn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
      const r = installTask({ pollMinutes: 5, spawnFn, platform: 'darwin' });
      assert.equal(r.ok, true);
      assert.equal(r.task, 'OsObserve-NetDnsPoll');
      assert.ok(r.note.includes('LaunchAgent'), 'note 明示载体形态');
      assert.ok(existsSync(join(home, 'bin', 'collect-darwin.mjs')), '部署到稳定路径');
      assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).pollMinutes, 5, 'config 播种（停滞阈值输入）');
      const plist = readFileSync(join(agents, 'OsObserve-NetDnsPoll.plist'), 'utf8');
      assert.ok(plist.includes('<string>OsObserve-NetDnsPoll</string>'), 'Label=任务标签');
      assert.ok(plist.includes(`<integer>${5 * 60}</integer>`), 'StartInterval=pollMinutes×60 秒');
      assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'), 'RunAtLoad=true（登录/注册即采首轮）');
      assert.ok(plist.includes(process.execPath), 'ProgramArguments=安装期解析 node 绝对路径');
      assert.ok(plist.includes(join(home, 'bin', 'collect-darwin.mjs')), 'ProgramArguments=部署面采集器路径');
      assert.deepEqual(calls, [['launchctl', 'bootstrap', agentDomain(), join(agents, 'OsObserve-NetDnsPoll.plist')]], '恰一次 bootstrap gui 域注册（非提权）');
      assert.equal(installTask({ pollMinutes: 0, spawnFn, platform: 'darwin' }).usage, true);
      assert.equal(installTask({ pollMinutes: 1440, spawnFn, platform: 'darwin' }).usage, true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test('install(darwin)：bootstrap 首败（已加载形态）→bootout+重登覆写式幂等（调用序列钉住）；真失败显式报错可重跑', () => {
  const home = tmpHome('os-observe-darwin-');
  const agents = tmpAgents();
  try {
    withEnv([['OS_OBSERVE_HOME', home], ['OS_OBSERVE_LAUNCHAGENTS_DIR', agents]], () => {
      const plistPath = join(agents, 'OsObserve-NetDnsPoll.plist');
      // 序列桩：bootstrap 失败（已加载形态）→bootout→bootstrap 成功；调用序（cmd,args）钉住防退化
      let n = 0;
      const seq = [5, 0, 0];
      const calls = [];
      const seqFn = (cmd, args) => { calls.push([cmd, ...args]); return { status: seq[n++] ?? 0, stdout: '', stderr: '' }; };
      const r = installTask({ pollMinutes: 10, spawnFn: seqFn, platform: 'darwin' });
      assert.equal(r.ok, true, '已加载→bootout 后重登=覆写式幂等');
      assert.deepEqual(calls, [
        ['launchctl', 'bootstrap', agentDomain(), plistPath],
        ['launchctl', 'bootout', `${agentDomain()}/OsObserve-NetDnsPoll`],
        ['launchctl', 'bootstrap', agentDomain(), plistPath],
      ], '首败→bootout→重登恰三连（顺序与目标钉住）');
      const r2 = installTask({ pollMinutes: 10, spawnFn: () => ({ status: 37, stdout: '', stderr: 'Input/output error' }), platform: 'darwin' });
      assert.equal(r2.ok, false, '重登仍败=显式失败');
      assert.ok(r2.error.includes('launchctl') && r2.error.includes('重跑'), '失败可见含重跑指引');
      assert.ok(existsSync(plistPath), '部署面（plist）已就绪——重跑 install 幂等');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test('uninstall(darwin)：bootout+删 plist=停采；bin/findings/config/raw 保留；未加载幂等；bootout 真失败可见且不删 plist', () => {
  const home = tmpHome('os-observe-darwin-');
  const agents = tmpAgents();
  try {
    withEnv([['OS_OBSERVE_HOME', home], ['OS_OBSERVE_LAUNCHAGENTS_DIR', agents]], () => {
      const plistPath = join(agents, 'OsObserve-NetDnsPoll.plist');
      mkdirSync(join(home, 'bin'), { recursive: true });
      writeFileSync(join(home, 'bin', 'collect-darwin.mjs'), '// deployed\n');
      writeFileSync(join(home, 'findings.jsonl'), '{"schemaVersion":1}\n');
      writeFileSync(plistPath, '<plist/>\n');
      // 已加载形态：bootout 成功
      const ok = uninstallTask({ spawnFn: () => ({ status: 0, stdout: '', stderr: '' }), platform: 'darwin' });
      assert.equal(ok.ok, true);
      assert.ok(ok.note.includes('已移除'), '真实移除报已移除');
      assert.equal(existsSync(plistPath), false, 'plist 移除');
      assert.ok(existsSync(join(home, 'bin', 'collect-darwin.mjs')), 'bin 保留（回归 win/linux 不销账形态）');
      assert.ok(existsSync(join(home, 'findings.jsonl')), '账目保留');
      // 未加载形态：bootout 非零+print 非零 → 按已移除幂等
      const again = uninstallTask({ spawnFn: (c, a) => ({ status: a[0] === 'print' ? 1 : 5, stdout: '', stderr: '' }), platform: 'darwin' });
      assert.equal(again.ok, true, '未加载按已移除（幂等）');
      assert.ok(again.note.includes('幂等'));
      // 真失败形态：bootout 非零+print 仍在册 → 显式失败且不动 plist（写面失败可见、无副作用）
      writeFileSync(plistPath, '<plist/>\n');
      const fail = uninstallTask({ spawnFn: (c, a) => ({ status: a[0] === 'print' ? 0 : 9, stdout: '', stderr: 'bootout error' }), platform: 'darwin' });
      assert.equal(fail.ok, false, '仍在册而 bootout 失败=显式失败');
      assert.ok(fail.error.includes('launchctl'));
      assert.ok(existsSync(plistPath), '失败态不删 plist（失败前置于文件系统访问）');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test('taskQuery(darwin)：在册判定=launchctl print（gui 域任务标签）；部署面在场不再充数（A-M14-23）', () => {
  let code = 1;
  const spawnFn = (cmd, args) => {
    assert.equal(cmd, 'launchctl');
    assert.deepEqual(args, ['print', `${agentDomain()}/OsObserve-NetDnsPoll`]);
    return { status: code, stdout: '', stderr: '' };
  };
  assert.deepEqual(taskQuery({ spawnFn, platform: 'darwin' }), { installed: false }, '未注册');
  code = 0;
  assert.deepEqual(taskQuery({ spawnFn, platform: 'darwin' }), { installed: true }, '已注册');
});

test('statusReport(darwin)：installed 随 launchctl 在册；deployedScript 对拍 darwin 采集器；wrapper null', () => {
  const home = tmpHome('os-observe-darwin-');
  const agents = tmpAgents();
  try {
    withEnv([['OS_OBSERVE_HOME', home], ['OS_OBSERVE_LAUNCHAGENTS_DIR', agents]], () => {
      let printCode = 1;
      const spawnFn = (cmd, args) => (args[0] === 'print' ? { status: printCode, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' });
      let s = statusReport({ spawnFn, platform: 'darwin' });
      assert.equal(s.ok, true);
      assert.equal(s.installed, false, 'launchctl 未在册=未在装');
      assert.ok(s.deployedScript.path.endsWith(join('bin', 'collect-darwin.mjs')), '对拍对象=darwin 采集器');
      assert.equal(s.deployedScript.sha256, null);
      assert.equal(s.wrapperScript, null, 'darwin 无启动包装（键恒定）');
      assert.equal(s.sysmon.platform, false, 'win-sysmon 空 skeleton（非目标平台）');
      assert.equal(s.dns.platform, false, 'linux-dns 空 skeleton（非目标平台）');
      installTask({ pollMinutes: 5, spawnFn, platform: 'darwin' });
      printCode = 0;
      s = statusReport({ spawnFn, platform: 'darwin' });
      assert.equal(s.installed, true, 'launchctl 在册=在装');
      assert.equal(s.deployedScript.matchesShipped, true, '部署面 sha256 与插件内置一致');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test('opportunisticCollect(darwin)：部署面存在即经 node 拉起 6s fail-open；未实测平台零 spawn', () => {
  const home = tmpHome('os-observe-darwin-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  const ran = [];
  const spawnFn = (cmd, args, opts) => { ran.push([cmd, args, opts]); return { status: 0, stdout: '', stderr: '' }; };
  try {
    assert.deepEqual(opportunisticCollect({ spawnFn, platform: 'darwin' }), { ran: [] }, '空部署零 spawn');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect-darwin.mjs'), '// stub\n');
    const r = opportunisticCollect({ spawnFn, platform: 'darwin' });
    assert.deepEqual(r.ran, ['collect-darwin.mjs']);
    assert.equal(ran[0][0], process.execPath, '经 node 拉起');
    assert.equal(ran[0][1][0], join(home, 'bin', 'collect-darwin.mjs'));
    assert.equal(ran[0][2]?.timeout, 6000, '6s 超时');
    assert.equal(ran[0][2]?.stdio, 'ignore', '静默姿态');
    ran.length = 0;
    assert.deepEqual(opportunisticCollect({ spawnFn, platform: 'sunos' }), { ran: [] }, '未实测平台零 spawn（负例换 sunos）');
    assert.equal(ran.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
