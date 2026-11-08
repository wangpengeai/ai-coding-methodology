// 文件：os-observe-linux.test.mjs
// 描述：os-observation Linux 后端测试（内部规则-9/11、内部验收-14/15，内部任务-OBSO-LINUX-1）——
//       TCP 采集器 fixture 子进程（OS_OBSERVE_PROC_ROOT 替身 /proc，任意宿主平台可跑：
//       v4/v6 established 解析、监听/回环过滤、inode 归因、保留清理、fail-open）+
//       任务面平台分支注入缝（install crontab 标记锚/因子集校验/降级、uninstall 幂等、
//       taskQuery、statusReport 平台路径、机会式补位 Linux 分支、未实测平台负例）。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, copyFileSync } from 'node:fs'; // 内部任务-337：symlinkSync 随 makeProcTree 收口移除（零残余消费）
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { install as installTask, uninstall as uninstallTask, taskQuery, statusReport, opportunisticCollect, USER_POLL_MARKER } from '../lib/os-observe-tasks.mjs';
import { enterEnv, makeProcTree, tmpHome } from './helpers.mjs';
import { newDnsRoot } from './dns-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED_LINUX = join(HERE, '..', 'adapters', 'os-observe', 'collect-linux.mjs');

// 内部任务-337（内部未决-223）：tmpHome/makeProcTree 收口至 tests/helpers.mjs；dnsRoot 夹具至 dns-fixtures.mjs。

/** 子进程跑采集器（fixture env 注入）；返回 spawnSync 结果。 */
function runCollector(home, procRoot) {
  return spawnSync(process.execPath, [SHIPPED_LINUX], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, OS_OBSERVE_HOME: home, OS_OBSERVE_PROC_ROOT: procRoot },
  });
}

function todayName() {
  const n = new Date();
  return `samples-${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}.jsonl`;
}

// ── 采集器（内部验收-14：/proc fixture，任意平台可跑）──

test('collect-linux：established 采集/过滤/归因（fixture /proc 替身）', () => {
  const home = tmpHome('os-observe-linux-');
  const proc = makeProcTree(mkdtempSync(join(tmpdir(), 'proc-')));
  try {
    const r = runCollector(home, proc);
    assert.equal(r.status, 0, `采集器须退 0（stderr=${r.stderr}）`);
    const file = join(home, 'raw', todayName());
    assert.ok(existsSync(file), 'raw 日文件须落盘');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, `恰 3 行（v4 公网 + v6 公网 + v4-mapped；监听与回环被滤——收到 ${lines.length}）`);
    const v4 = JSON.parse(lines[0]);
    assert.equal(v4.kind, 'tcp');
    assert.equal(v4.ip, '203.0.113.5');
    assert.equal(v4.port, 443);
    assert.equal(v4.processName, 'zcode-agent'); // inode 4250434 → pid 4242 comm
    assert.equal(v4.source, 'linux-net-tcp-poll');
    assert.ok(Number.isFinite(Date.parse(v4.ts)), 'ts 可解析');
    const v6 = JSON.parse(lines[1]);
    assert.equal(v6.ip, '2001:db8::1'); // 字内字节反转 + RFC 5952 压缩
    assert.equal(v6.port, 80);
    assert.equal(v6.processName, null); // inode 99 无主——不伪造
    const mapped = JSON.parse(lines[2]);
    assert.equal(mapped.ip, '203.0.113.5', 'v4-mapped（::ffff:/96）归一为点分 v4——与 tcp 表同远端同 id 去重');
    assert.equal(mapped.port, 443);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proc, { recursive: true, force: true });
  }
});

test('collect-linux：7 天保留清理（旧 samples 删除、当日保留）', () => {
  const home = tmpHome('os-observe-linux-');
  const proc = makeProcTree(mkdtempSync(join(tmpdir(), 'proc-')));
  try {
    mkdirSync(join(home, 'raw'), { recursive: true });
    const old = join(home, 'raw', 'samples-20200101.jsonl');
    writeFileSync(old, '{"ts":"2020-01-01T00:00:00.000Z"}\n');
    const t = new Date('2020-01-02T00:00:00Z');
    utimesSync(old, t, t);
    const r = runCollector(home, proc);
    assert.equal(r.status, 0);
    assert.equal(existsSync(old), false, '超 7 天文件须删除');
    assert.ok(existsSync(join(home, 'raw', todayName())), '当日文件保留');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proc, { recursive: true, force: true });
  }
});

test('collect-linux：fail-open——/proc 替身缺失静默退 0 不落样本', () => {
  const home = tmpHome('os-observe-linux-');
  try {
    const r = runCollector(home, join(tmpdir(), 'no-such-proc'));
    assert.equal(r.status, 0);
    assert.equal(readdirSync(join(home, 'raw')).length, 0, '无有效连接不落样本文件');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 任务面平台分支（内部验收-15：注入缝桩 + platform 注入；OS_OBSERVE_HOME 隔离）──
// 平台注入：本组断言 linux/win32 语义一律显式 platform 注入（内部未决-32 纪律，不依赖宿主）。

test('install(linux)：部署+播种+crontab 标记锚（因子集校验）', () => {
  const home = tmpHome('os-observe-linux-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  const calls = [];
  let table = '';
  const spawnFn = (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    if (args[0] === '-l') return { status: table ? 0 : 1, stdout: table, stderr: '' }; // 空=无 crontab 基线（exit 1）
    if (args[0] === '-') { table = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const bad = installTask({ pollMinutes: 7, spawnFn, platform: 'linux', nodePath: '/n/node' });
    assert.equal(bad.usage, true, '7 非 60 因子须 usage 拒绝');
    assert.ok(String(bad.error).includes('1/2/3/4/5/6/10/12/15/20/30/60'), `error 须列候选（收到 ${bad.error}）`);
    assert.equal(installTask({ pollMinutes: 60, spawnFn, platform: 'linux', nodePath: '/n/node' }).ok, true, '60 合法');
    assert.equal(installTask({ pollMinutes: 1439, spawnFn, platform: 'linux', nodePath: '/n/node' }).usage, true);

    const r = installTask({ pollMinutes: 5, spawnFn, platform: 'linux', nodePath: '/n/node' });
    assert.equal(r.ok, true, `install 须成功（收到 ${JSON.stringify(r)}）`);
    assert.equal(r.task, USER_POLL_MARKER);
    assert.ok(existsSync(join(home, 'bin', 'collect-linux.mjs')), '部署面须落 bin/');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.pollMinutes, 5, 'config 播种');
    // crontab 序列：读 → 写（marker+命令行）→ 复核读（取末次写——前序 60 因子用例已写过一轮）
    const write = calls.filter(([, args]) => args[0] === '-').at(-1);
    assert.ok(write, '须有 crontab 写调用');
    assert.equal(write[0], 'crontab');
    assert.ok(String(write[2]?.input).includes(USER_POLL_MARKER), '写入须含 marker');
    assert.ok(String(write[2]?.input).includes(`*/5 * * * * '/n/node' `), '写入须含轮询命令行（路径经 shQuote）');
    assert.ok(String(write[2]?.input).includes(`'${join(home, 'bin', 'collect-linux.mjs')}'`), '命令行指向部署面（引号形态）');
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('install(linux)：复核读见 marker → ok；复核读不见 → ok:false', () => {
  const home = tmpHome('os-observe-linux-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  let written = '';
  const spawnFn = (cmd, args, opts) => {
    if (args[0] === '-l') return { status: 0, stdout: written, stderr: '' };
    if (args[0] === '-') { written = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = installTask({ pollMinutes: 5, spawnFn, platform: 'linux', nodePath: '/n/node' });
    assert.equal(r.ok, true, `回读一致须成功（收到 ${JSON.stringify(r)}）`);
    assert.ok(String(r.note).includes('crontab'));
    // 复核失败：写成功但回读永不出现 marker
    const badFn = (cmd, args, opts) => {
      if (args[0] === '-') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' }; // -l 恒空
    };
    const home2 = tmpHome('os-observe-linux-');
    process.env.OS_OBSERVE_HOME = home2;
    const bad = installTask({ pollMinutes: 5, spawnFn: badFn, platform: 'linux', nodePath: '/n/node' });
    assert.equal(bad.ok, false, '复核未过须 ok:false');
    assert.ok(String(bad.error).includes('复核'));
    rmSync(home2, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('install(linux)：crontab 不可读 → 降级机会式（明示）', () => {
  const home = tmpHome('os-observe-linux-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  const spawnFn = (cmd, args) => {
    if (args[0] === '-l') return { error: { code: 'ENOENT' }, status: null }; // crontab 缺席（spawn error）
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = installTask({ pollMinutes: 5, spawnFn, platform: 'linux', nodePath: '/n/node' });
    assert.equal(r.ok, true, '部署完成仍 ok（降级形态）');
    assert.ok(existsSync(join(home, 'bin', 'collect-linux.mjs')), '部署面仍在');
    assert.ok(String(r.note).includes('机会式'), `note 须明示降级（收到 ${r.note}）`);
    // 读 ok 空基线但写失败：可重试错误（非降级——写面失败须可见）
    const wFail = (cmd, args, opts) => {
      if (args[0] === '-l') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === '-') return { error: { code: 'EIO' }, status: null };
      return { status: 0, stdout: '', stderr: '' };
    };
    const home2 = tmpHome('os-observe-linux-');
    process.env.OS_OBSERVE_HOME = home2;
    const w = installTask({ pollMinutes: 5, spawnFn: wFail, platform: 'linux', nodePath: '/n/node' });
    assert.equal(w.ok, false, '写失败须 ok:false（可重跑，不静默降级）');
    rmSync(home2, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall(linux)：标记块移除幂等；taskQuery 按 marker 判在册', () => {
  const home = tmpHome('os-observe-linux-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  let table = `0 0 * * * echo hi\n${USER_POLL_MARKER}\n*/5 * * * * /n/node ${join(home, 'bin', 'collect-linux.mjs')} >/dev/null 2>&1\n`;
  const spawnFn = (cmd, args, opts) => {
    if (args[0] === '-l') return { status: 0, stdout: table, stderr: '' };
    if (args[0] === '-') { table = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    assert.equal(taskQuery({ spawnFn, platform: 'linux' }).installed, true);
    const r = uninstallTask({ spawnFn, platform: 'linux' });
    assert.equal(r.ok, true);
    assert.ok(String(r.note).includes('保留') || String(r.note).includes('不销账'), 'note 须声明不销账');
    assert.ok(table.includes('echo hi'), '无关用户行保留');
    assert.ok(!table.includes(USER_POLL_MARKER), 'marker 块移除');
    assert.ok(!table.includes('collect-linux.mjs'), '配对命令行移除');
    assert.equal(taskQuery({ spawnFn, platform: 'linux' }).installed, false);
    assert.equal(uninstallTask({ spawnFn, platform: 'linux' }).ok, true, '二次卸载幂等');
    // 无 crontab 基线：读 exit 1 空 → 幂等 ok
    const emptyFn = (cmd, args) => (args[0] === '-l' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' });
    assert.equal(uninstallTask({ spawnFn: emptyFn, platform: 'linux' }).ok, true);
    assert.equal(taskQuery({ spawnFn: emptyFn, platform: 'linux' }).installed, false);
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('statusReport(linux)：deployedScript 平台路径 + 对拍 + sysmon 非(win32) 语义', () => {
  const home = tmpHome('os-observe-linux-');
  // DNS 载体根隔离（内部任务-281/H10 迁移）：dnsStatus 读 dnsRootDir()/dns-spool——不注入会读真机
  // /var/lib/os-observe-dns（真机启用后恒有 pcap），环境态泄入致「空 spool」断言漂移（步骤 12 实录）
  const dnsRoot = newDnsRoot();
  const restoreEnv = enterEnv({ OS_OBSERVE_HOME: home, OS_OBSERVE_DNS_ROOT: dnsRoot });
  const spawnFn = (cmd, args) => {
    if (cmd === 'pgrep') return { status: 1, stdout: '', stderr: '' }; // 无监听实例
    if (args[0] === '-l') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    mkdirSync(join(home, 'bin'), { recursive: true });
    copyFileSync(SHIPPED_LINUX, join(home, 'bin', 'collect-linux.mjs'));
    copyFileSync(join(HERE, '..', 'adapters', 'os-observe', 'collect-common.mjs'), join(home, 'bin', 'collect-common.mjs'));
    const s = statusReport({ spawnFn, platform: 'linux', now: Date.now() });
    assert.equal(s.ok, true);
    assert.ok(String(s.deployedScript.path).endsWith(join('bin', 'collect-linux.mjs')), 'linux 部署路径');
    assert.equal(s.deployedScript.matchesShipped, true, '部署=内置 对拍通过');
    assert.equal(s.wrapperScript, null, 'linux 无 wscript 包装（node 直拉）');
    assert.equal(s.sysmon.platform, false, '非 win32 的 sysmon 段语义');
    assert.equal(s.dns.platform, true, 'linux 的 dns 段语义');
    assert.equal(s.dns.process, false, 'dns 段 fail-open 默认形态');
    assert.deepEqual(s.dns.spool, { files: 0, newestTsMs: 0 }, '空 spool');
    assert.equal(s.installed, false, '空 crontab 未在册');
  } finally {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
    rmSync(dnsRoot, { recursive: true, force: true });
  }
});

test('opportunisticCollect(linux)：部署面存在即跑 node 采集器（注入缝桩）', () => {
  const home = tmpHome('os-observe-linux-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  const ran = [];
  const spawnFn = (cmd, args, opts) => { ran.push([cmd, args, opts]); return { status: 0, stdout: '', stderr: '' }; };
  try {
    assert.deepEqual(opportunisticCollect({ spawnFn, platform: 'linux' }), { ran: [] }, '空部署零 spawn');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect-linux.mjs'), '// stub\n');
    let r = opportunisticCollect({ spawnFn, platform: 'linux' });
    assert.deepEqual(r.ran, ['collect-linux.mjs']);
    assert.equal(ran[0][0], process.execPath, '经 node 拉起');
    assert.equal(ran[0][1][0], join(home, 'bin', 'collect-linux.mjs'));
    assert.equal(ran[0][2]?.timeout, 6000, '6s 超时');
    assert.equal(ran[0][2]?.stdio, 'ignore', '静默姿态');
    writeFileSync(join(home, 'bin', 'collect-linux-dns.mjs'), '// stub\n');
    r = opportunisticCollect({ spawnFn, platform: 'linux' });
    assert.deepEqual(r.ran, ['collect-linux.mjs', 'collect-linux-dns.mjs'], '恰序各跑一轮');
    // 单脚本失败 fail-open：后续照跑
    const failFirst = (cmd, args, opts) => {
      if (args[0]?.endsWith('collect-linux.mjs')) throw new Error('boom');
      ran.push([cmd, args, opts]);
      return { status: 0, stdout: '', stderr: '' };
    };
    r = opportunisticCollect({ spawnFn: failFirst, platform: 'linux' });
    assert.deepEqual(r.ran, ['collect-linux.mjs', 'collect-linux-dns.mjs'], 'ran 含尝试面（不含成败）');
    // 未实测平台零 spawn（darwin 自 内部任务-OBSO-DARWIN-1 有 PLAN——负例换 sunos 承接）
    ran.length = 0;
    assert.deepEqual(opportunisticCollect({ spawnFn, platform: 'sunos' }), { ran: [] });
    assert.equal(ran.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('未实测平台负例：install/uninstall/taskQuery unavailable 且不写未实测命令（D5；三平台入列后负例换 sunos）', () => {
  const spawnFn = () => { throw new Error('未实测平台不得 spawn'); };
  for (const r of [
    installTask({ pollMinutes: 5, spawnFn, platform: 'sunos' }),
    uninstallTask({ spawnFn, platform: 'sunos' }),
  ]) {
    assert.equal(r.availability, 'unavailable');
    assert.ok(!String(r.error).includes('crontab'), 'error 不含平台命令');
    assert.ok(!String(r.error).includes('tcpdump'));
  }
  assert.deepEqual(taskQuery({ spawnFn, platform: 'sunos' }), { installed: false });
});

// ── 内部任务-257（P5-3）：采集失败留痕 ──
test('collect-linux：采集失败留痕（last-error.json）', () => {
  const home = tmpHome('os-observe-linux-');
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  try {
    makeProcTree(proc);
    // 平台门：linux 采集器在非 linux 平台不自跑（保留既有语义）；仅 linux 上断言留痕
    const r = spawnSync(process.execPath, [SHIPPED_LINUX], {
      encoding: 'utf8',
      env: { ...process.env, OS_OBSERVE_HOME: home, OS_OBSERVE_PROC_ROOT: proc, OS_OBSERVE_FORCE_FAIL: '1' },
    });
    assert.equal(r.status, 0, 'fail-open：异常仍退 0');
    const file = join(home, 'raw', 'last-error.json');
    assert.ok(existsSync(file), '失败须写 last-error.json（不冒充无数据）');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(String(rec.error), /injected|failure/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proc, { recursive: true, force: true });
  }
});

