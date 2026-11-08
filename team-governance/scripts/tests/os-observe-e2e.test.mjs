// 文件：os-observe-e2e.test.mjs
// 描述：os-observation 整进程 e2e（内部规则-11 / 内部验收-8/9，内部需求-17）——CLI 子命令族
//       （list 过滤/ack 写侧可见/report 信封/status 只读聚合，OS_OBSERVE_HOME 注入
//       tmpdir，不触真实用户目录与真实计划任务）+ session-start hook 两段式浮现
//       （计数+指针默认无端点明细/ack 后消失/停滞从句/配置警告从句/surfaceDetail
//       明细 opt-in/与治理段并存）。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'; // 内部任务-337：symlinkSync 随 makeProcTreeMinimal 收口移除（零残余消费）
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { syncRawToFindings } from '../lib/os-observe-pipeline.mjs';
import { appendStatus, digestOf, readFindings } from '../lib/os-observe-store.mjs';
import { makeProcTreeMinimal, runNode, tmpHome as tmpHomeShared } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'governance-cli.mjs');
const HOOK = resolve(HERE, '..', '..', 'hooks', 'session-start.mjs');

// 内部任务-337（内部未决-223）：tmpHome 一行前缀适配（32 调用点零改）；makeProcTree 收口 helpers（精简树）。
const tmpHome = () => tmpHomeShared('os-observe-e2e-');

function writeRaw(home, lines, day = '20260919') {
  mkdirSync(join(home, 'raw'), { recursive: true });
  writeFileSync(join(home, 'raw', `samples-${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

function dnsLine(domain, ip, ts) {
  return JSON.stringify({ ts, kind: 'dns', domain, data: ip, qtype: 1 });
}

/** 整进程跑 hook，返回 {status, stdout, context}（context=additionalContext，缺席为 null）。
 *  timeout 注入缝：补位采集用例须大于 hook 内部 6s/脚本预算（阶段门勘察发现 a 修复：
 *  原三参调用未接线，30_000 被静默丢弃、实际恒 10_000——内部任务-OBSO-LINUX-1 步骤 3.5）。 */
function runHook(home, projectDir, timeout = 10_000, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, OS_OBSERVE_HOME: home, ZCODE_PROJECT_DIR: projectDir, ...extraEnv },
  });
  let context = null;
  const firstLine = (r.stdout ?? '').split('\n')[0];
  if (firstLine) {
    try { context = JSON.parse(firstLine).hookSpecificOutput.additionalContext; } catch { context = null; }
  }
  return { status: r.status, stdout: r.stdout ?? '', context };
}

function runCli(home, args) {
  return runNode(CLI, ['os-observe', ...args], { env: { OS_OBSERVE_HOME: home }, timeout: 20_000 });
}

// ── hook 浮现段 ──

test('hook：无 findings 且无 raw → 空输出退 0（未启用静默）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    const r = runHook(home, proj);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：未确认 suspicious 计数浮现，默认不含端点明细（注入即出机，B-M14-6）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [
      dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'),
      dnsLine('acked.aliyuncs.com', '203.0.113.2', '2026-09-19T10:00:00.000Z'),
      dnsLine('a.example.com', '203.0.113.3', '2026-09-19T10:00:00.000Z'),
    ]);
    syncRawToFindings(home);
    appendStatus(home, `of-${digestOf(['win-dns-cache-poll||acked.aliyuncs.com'])}`, { status: 'acknowledged', note: 'e2e' });
    const r = runHook(home, proj);
    assert.equal(r.status, 0);
    assert.ok(r.context.includes('1 条未确认可疑外发'), `context=${r.context}`);
    assert.ok(r.context.includes('os-observe list'));
    assert.ok(!r.context.includes('evil.aliyuncs.com')); // 默认无端点明细
    assert.ok(!r.context.includes('a.example.com'));     // unknown 不浮现
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：ack 后浮现段消失（两段全缺席时静默退 0）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    appendStatus(home, `of-${digestOf(['win-dns-cache-poll||evil.aliyuncs.com'])}`, { status: 'acknowledged' });
    const r = runHook(home, proj);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：raw 停滞超 30 分钟 → 附观测停滞从句', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    const past = new Date(Date.now() - 40 * 60_000); // 停滞判据=raw 最新 mtime
    utimesSync(join(home, 'raw', 'samples-20260919.jsonl'), past, past);
    const r = runHook(home, proj);
    assert.ok(r.context.includes('观测停滞'), `context=${r.context}`);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：config 坏 JSON → 附配置警告从句（fail-toward-alert 不静默吞）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    writeFileSync(join(home, 'config.json'), '{broken', 'utf8');
    const r = runHook(home, proj);
    assert.ok(r.context.includes('不可读'), `context=${r.context}`);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：surfaceDetail 显式开启 → 附端点明细（opt-in）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: [], suspicious: [], pollMinutes: 5, surfaceDetail: true }), 'utf8');
    const r = runHook(home, proj);
    assert.ok(r.context.includes('evil.aliyuncs.com'), `context=${r.context}`);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('hook：项目接入治理 → 两段并存（治理段原文不回归）', () => {
  const home = tmpHome();
  const proj = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    mkdirSync(join(proj, '.ai-governance'), { recursive: true });
    writeFileSync(join(proj, '.ai-governance', 'config.json'), JSON.stringify({ policyId: 'default', policyVersion: 1 }), 'utf8');
    const r = runHook(home, proj);
    assert.ok(r.context.includes('【team-governance】os-observe'), `context=${r.context}`);
    assert.ok(r.context.includes('治理已接入'));
    assert.ok(r.context.includes('policy default@1'));
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// ── CLI 子命令族 ──

test('CLI list：空目录 → [] 退 0；--class suspicious 过滤', () => {
  const home = tmpHome();
  try {
    const empty = runCli(home, ['list']);
    assert.equal(empty.status, 0);
    assert.deepEqual(JSON.parse(empty.stdout), []);
    writeRaw(home, [
      dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'),
      dnsLine('a.example.com', '203.0.113.3', '2026-09-19T10:00:00.000Z'),
    ]);
    const r = runCli(home, ['list', '--class', 'suspicious']);
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, 'evil.aliyuncs.com');
    assert.equal(rows[0].status, 'open');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI ack：成功退 0 落 acknowledged 行；未知 id → stderr+1', () => {
  const home = tmpHome();
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home);
    const id = `of-${digestOf(['win-dns-cache-poll||evil.aliyuncs.com'])}`;
    const ok = runCli(home, ['ack', id, '--note', 'e2e 确认']);
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).id, id);
    assert.equal(readFindings(home).get(id).status, 'acknowledged');
    const bad = runCli(home, ['ack', 'of-nonexistent']);
    assert.equal(bad.status, 1);
    assert.ok((bad.stderr ?? '').includes('未知'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI report：有数据→failed 信封；空 home→unavailable+unverified（内部验收-9）', () => {
  const home = tmpHome();
  try {
    const empty = runCli(home, ['report']);
    assert.equal(empty.status, 0);
    const env0 = JSON.parse(empty.stdout);
    assert.equal(env0.capability, 'os-observation');
    assert.equal(env0.availability, 'unavailable');
    assert.equal(env0.result.status, 'unverified');

    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    const r = runCli(home, ['report']);
    assert.equal(r.status, 0);
    const env = JSON.parse(r.stdout);
    assert.equal(env.capability, 'os-observation');
    if (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') {
      // 已实测平台（linux 2026-09-20、darwin 2026-09-30 入列，内部验收-9 语义扩）：数据在场即 available/degraded + failed
      assert.ok(env.availability === 'available' || env.availability === 'degraded');
      assert.equal(env.result.status, 'failed');
    } else {
      // 未实测平台：无内置后端 → unavailable+unverified（内部决策-029 决策 5，不伪装 passed）；
      // 三批次机（win/linux/mac）均命中正例分支，本支降为语义文档形态（内部任务-VALFAIL-0.4.3 先例）
      assert.equal(env.availability, 'unavailable');
      assert.equal(env.result.status, 'unverified');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI status：只读聚合（installed 布尔/发现计数字段在场）', () => {
  const home = tmpHome();
  try {
    const r = runCli(home, ['status']);
    assert.equal(r.status, 0);
    const s = JSON.parse(r.stdout);
    assert.equal(typeof s.installed, 'boolean'); // 真实任务在册与否都合法，只断言字段
    assert.ok(s.findings && typeof s.findings.total === 'number');
    assert.ok(s.raw && typeof s.raw.stale === 'boolean');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── win-sysmon CLI e2e（内部任务-SYSMON-1，内部验收-12——收尾评审发现 2 补齐：计划步骤 6b 承诺的整进程用例）──

test('e2e：sysmon-guide 出四要素与六步（只读，退 0）', () => {
  const home = tmpHome();
  try {
    const r = runCli(home, ['sysmon-guide']);
    assert.equal(r.status, 0);
    const g = JSON.parse(r.stdout);
    assert.equal(g.ok, true);
    assert.ok(g.elements.source.includes('download.sysinternals.com'));
    assert.ok(g.elements.verification.includes('签名'));
    assert.ok(g.elements.policy.includes('不启用'));
    assert.equal(g.steps.length >= 6, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('e2e：未知子命令退 2 且提示含 sysmon-guide（分派落空枚举同步）', () => {
  const home = tmpHome();
  try {
    const r = runCli(home, ['no-such-sub']);
    assert.equal(r.status, 2);
    assert.ok(String(r.stderr).includes('sysmon-guide'), `提示须含新子命令枚举（收到：${r.stderr}）`);
    assert.ok(String(r.stderr).includes('sysmon-disable'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── SessionStart 机会式补位采集 e2e（内部任务-OBSO-COLLECT-1，内部验收-13——hook 整进程真跑 marker）──

test('e2e：SessionStart 补位采集真执行（部署面 marker 落盘 + 浮现段含 os-observe 头行）', () => {
  const home = tmpHome();
  try {
    // 部署面：两个假采集器（真 powershell 执行，各写一个 marker 文件）
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.ps1'), `Set-Content -Path (Join-Path $env:OS_OBSERVE_HOME 'marker-builtin.txt') -Value ok`);
    writeFileSync(join(home, 'bin', 'collect-sysmon.ps1'), `Set-Content -Path (Join-Path $env:OS_OBSERVE_HOME 'marker-sysmon.txt') -Value ok`);
    // findings 种子：一条 open suspicious 使浮现段非空
    const id = `of-${digestOf(['win-sysmon|x.exe|evil.example'])}`;
    writeFileSync(join(home, 'findings.jsonl'), `${JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), source: 'win-sysmon', process: 'x.exe', endpoint: 'evil.example', endpointKind: 'domain', class: 'suspicious', basis: { rule: 'user-suspicious' }, firstSeen: Date.now(), lastSeen: Date.now(), count: 1, status: 'open' })}\n`);
    const r = runHook(home, tmpHome(), 30_000); // 独立项目目录（治理段省略）；预算与 hooks.json 同口径
    assert.equal(r.status, 0);
    assert.ok(r.context && r.context.includes('os-observe'), '浮现段须含 os-observe 头行');
    if (process.platform === 'win32') { // 平台分支（内部任务-VALFAIL-0.4.3 先例；内部未决-32 语义）
      assert.ok(existsSync(join(home, 'marker-builtin.txt')), 'builtin 补位采集器真执行（marker 落盘）');
      assert.ok(existsSync(join(home, 'marker-sysmon.txt')), 'sysmon 补位采集器真执行（marker 落盘）');
    } else {
      // 非 win32（linux/darwin）：collect.ps1 不在平台清单——零 spawn（已登记语义；darwin 走自有采集器清单，见 内部任务-OBSO-DARWIN-1 e2e）
      assert.equal(existsSync(join(home, 'marker-builtin.txt')), false, '非 win32 零 spawn（已登记语义）');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('e2e：补位采集平台分支 + 冷启态触发（内部任务-OBSO-COLLECT-1 评审处置 1/3/4）', () => {
  const home = tmpHome();
  try {
    // 冷启态：部署面在、raw/findings 全空——采集必须仍触发（目标场景），
    // 段本身为 null（无 findings 可浮现）但 marker 证明采集先于守卫执行
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.ps1'), `Set-Content -Path (Join-Path $env:OS_OBSERVE_HOME 'cold-marker.txt') -Value ok`);
    if (process.platform === 'win32') {
      const r = runHook(home, tmpHome(), 30_000); // 预算与 hooks.json 同口径（评审处置 4：外层须大于内部 6s×N）
      assert.equal(r.status, 0);
      assert.equal(r.context, null, '冷启态无 findings → 段省略');
      assert.ok(existsSync(join(home, 'cold-marker.txt')), '冷启态补位采集仍执行（marker 落盘）');
    } else {
      // 非 win32（linux/darwin）：collect.ps1 不在平台清单——零 spawn（已登记语义；darwin 走自有采集器清单，见 内部任务-OBSO-DARWIN-1 e2e）
      const r = runHook(home, tmpHome());
      assert.equal(r.status, 0);
      assert.equal(existsSync(join(home, 'cold-marker.txt')), false, '非 win32 零 spawn（marker 不落盘）');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('e2e：Linux 补位采集真跑（PROC_ROOT 替身经 env 传播；1b3067e 平台分支先例）', () => {
  const home = tmpHome();
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  try {
    makeProcTreeMinimal(proc);
    mkdirSync(join(home, 'bin'), { recursive: true });
    copyFileSync(resolve(HERE, '..', 'adapters', 'os-observe', 'collect-linux.mjs'), join(home, 'bin', 'collect-linux.mjs'));
    copyFileSync(resolve(HERE, '..', 'adapters', 'os-observe', 'collect-common.mjs'), join(home, 'bin', 'collect-common.mjs'));
    const r = runHook(home, tmpHome(), 30_000, { OS_OBSERVE_PROC_ROOT: proc });
    assert.equal(r.status, 0);
    if (process.platform === 'linux') {
      // 部署面在 → 采集器真执行（node 子进程读 fixture /proc → raw 落样本）
      const rawDir = join(home, 'raw');
      const files = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.startsWith('samples-')) : [];
      assert.equal(files.length, 1, 'raw 日文件落盘');
      const lines = readFileSync(join(rawDir, files[0]), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const s = JSON.parse(lines[0]);
      assert.equal(s.ip, '203.0.113.5');
      assert.equal(s.processName, 'zcode-agent');
      assert.equal(s.source, 'linux-net-tcp-poll');
    } else {
      // 非 linux（win32/darwin）：linux 采集器不在平台清单——零副作用（已登记语义）
      assert.equal(existsSync(join(home, 'raw')), false, 'linux 采集器不执行（平台清单语义）');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proc, { recursive: true, force: true });
  }
});

test('e2e：darwin 补位采集真跑（LSOF_OUT 替身经 env 传播；内部任务-OBSO-DARWIN-1）', () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, 'bin'), { recursive: true });
    copyFileSync(resolve(HERE, '..', 'adapters', 'os-observe', 'collect-darwin.mjs'), join(home, 'bin', 'collect-darwin.mjs'));
    copyFileSync(resolve(HERE, '..', 'adapters', 'os-observe', 'collect-common.mjs'), join(home, 'bin', 'collect-common.mjs'));
    const r = runHook(home, tmpHome(), 30_000, { OS_OBSERVE_LSOF_OUT: resolve(HERE, 'fixtures', 'os-observe', 'real-darwin-lsof.txt') });
    assert.equal(r.status, 0);
    if (process.platform === 'darwin') {
      // 部署面在 → 采集器真执行（node 子进程读 lsof 替身 → raw 落样本）
      const rawDir = join(home, 'raw');
      const files = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.startsWith('samples-')) : [];
      assert.equal(files.length, 1, 'raw 日文件落盘');
      const lines = readFileSync(join(rawDir, files[0]), 'utf8').trim().split('\n');
      assert.equal(lines.length, 9);
      const s = JSON.parse(lines[0]);
      assert.equal(s.source, 'darwin-net-tcp-poll');
      assert.equal(typeof s.ip, 'string');
    } else {
      // 非 darwin（win32/linux）：darwin 采集器不在平台清单——零副作用（已登记语义）
      assert.equal(existsSync(join(home, 'raw')), false, 'darwin 采集器不执行（平台清单语义）');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('e2e：os-observe allow/deny——pattern 追加、坏 pattern 退 2、id 前缀解析取端点（内部任务-ALLOWCLI-1）', () => {
  const home = tmpHome();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: [], suspicious: [], pollMinutes: 5, surfaceDetail: false }), 'utf8');
    // pattern 直给
    let r = runCli(home, ['allow', '*.aliyuncs.com']);
    assert.equal(r.status, 0, `allow 应成功（stderr=${r.stderr}）`);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).allow, ['*.aliyuncs.com']);
    // 坏 pattern → 退 2
    r = runCli(home, ['allow', 'bad pattern!']);
    assert.equal(r.status, 2);
    // id 前缀解析：seed 一条 finding（生产 id 形态 of-<hex>），of- 前缀命中取 endpoint
    writeFileSync(join(home, 'findings.jsonl'), `${JSON.stringify({ id: 'of-ab12cd34ef56ab12cd34ef56ab12cd34', ts: '2026-09-21T00:00:00.000Z', source: 'win-dns-cache-poll', process: 'x.exe', endpoint: 'evil.example.com', endpointKind: 'domain', class: 'suspicious', basis: { rule: 'builtin-suspicious' }, firstSeen: '2026-09-21T00:00:00.000Z', lastSeen: '2026-09-21T00:00:00.000Z', count: 1, status: 'open' })}\n`, 'utf8');
    r = runCli(home, ['deny', 'of-ab12cd34']);
    assert.equal(r.status, 0, `deny 前缀解析应成功（stderr=${r.stderr}）`);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).suspicious, ['evil.example.com']);
    const out = JSON.parse(r.stdout);
    assert.equal(out.resolvedFrom.endpoint, 'evil.example.com');
    // 未知 of- id：显式失败退 1（不得把 id 文本当 pattern 静默落盘，终审正确性 1）
    r = runCli(home, ['allow', 'of-ff00ff00ff00']);
    assert.equal(r.status, 1);
    // id 命中但 finding 无端点（parse-error 形态行）：显式失败退 1
    writeFileSync(join(home, 'findings.jsonl'), `${JSON.stringify({ id: 'of-99887766554499887766554499887766', ts: '2026-09-21T00:00:00.000Z', source: 'parse', process: null, endpoint: null, endpointKind: null, class: 'unknown', basis: { rule: 'parse-error' }, firstSeen: '2026-09-21T00:00:00.000Z', lastSeen: '2026-09-21T00:00:00.000Z', count: 1, status: 'open' })}\n`, 'utf8');
    r = runCli(home, ['allow', 'of-998877']);
    assert.equal(r.status, 1);
    assert.ok(String(r.stderr).includes('端点'), '报错须点名无端点');
    // 非 of- 开头：不进 id 解析，按 pattern 走（大写归一后落盘）
    r = runCli(home, ['allow', 'EXAMPLE.COM']);
    assert.equal(r.status, 0, `大写 pattern 应归一成功（stderr=${r.stderr}）`);
    assert.ok(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).allow.includes('example.com'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('e2e：开关环境缝下机会式采集零执行', () => {
  const home = tmpHome();
  const project = tmpHome();
  const marker = join(home, 'marker.txt');
  try {
    mkdirSync(join(home, 'bin'), { recursive: true });
    // 最小采集器：执行即写 marker（仅 darwin/linux 的 node 采集器面；win32 分支不进断言）
    const script = "import { writeFileSync } from 'node:fs';\nif (process.env.MARKER_FILE) writeFileSync(process.env.MARKER_FILE, 'ran');\n";
    if (process.platform === 'darwin') writeFileSync(join(home, 'bin', 'collect-darwin.mjs'), script, 'utf8');
    else if (process.platform === 'linux') writeFileSync(join(home, 'bin', 'collect-linux.mjs'), script, 'utf8');
    const nodePlatform = process.platform === 'darwin' || process.platform === 'linux';
    const enabled = runHook(home, project, 30_000, { MARKER_FILE: marker });
    assert.equal(enabled.status, 0);
    if (nodePlatform) assert.equal(existsSync(marker), true, '缺省态机会式采集执行（marker 生成）');
    rmSync(marker, { force: true });
    const disabled = runHook(home, project, 30_000, { MARKER_FILE: marker, AI_CODING_OS_OBSERVE: '0' });
    assert.equal(disabled.status, 0);
    assert.equal(existsSync(marker), false, '开关=0 时机会式采集零执行（marker 未生成）');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
