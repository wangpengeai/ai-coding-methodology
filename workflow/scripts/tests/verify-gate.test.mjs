// 文件：verify-gate.test.mjs
// 描述：完成闸钩（verify-gate.mjs，内部未决-14 批次自 verify-gate.sh 等价移植）行为
//       测试——四态（未声明/首录/复跑/命令失败/篡改）、golden 信任哈希常量（旧 bash
//       版 2026-09-15 采集，字节级锁定归一化口径）、归一化边界（右剥不发生/每行剥
//       BOM/# 时机）、退出码合成（124/127）、执行 shell 四级探测、fail-open 双路、
//       双跑对拍（清场后 skip）。
// 作者：wangp  创建：2026-09-15  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；fixture 全部临时生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const HOOK = join(HOOKS, 'verify-gate.mjs');

/** golden 覆盖性样例字节（与常量一一对应；来源见 GOLDEN_TRUST 注释）。 */
const GOLDEN_SAMPLE = '﻿# 注释行\n\r\n  echo alpha\r\n#echo\necho beta  \nlast-cmd-no-newline';
/** 旧 bash 版对 GOLDEN_SAMPLE 首录的信任哈希（2026-09-15 采集于本机 Git Bash，删除 .sh 后为唯一基准）。 */
const GOLDEN_TRUST = '619f8e836f6154eb84a1ea50599a3baf3f5d8d3f893038ee5a843e1bd46cd4a1';

/**
 * 子进程驱动被测钩（cwd 用临时项目根，正斜杠形态——Git Bash 与 Node 双兼容）。
 * 2026-09-19 评审修复 B13：信任存储迁用户级目录，测试经 WF_TRUST_DIR 注入缝隔离——
 * 缺省每次调用独立临时信任目录并清理；多轮用例（首录→复跑/篡改/执行）必须显式传
 * 同一 trustDir 复用，否则轮次间信任不连续。
 * @param {string} cwd
 * @param {{env?: Record<string,string>, trustDir?: string}} [o]
 * @returns {{status: number|null, stdout: string}}
 */
function runGate(cwd, o = {}) {
  const trustDir = o.trustDir ?? mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd, ...(o.sessionId ? { session_id: o.sessionId } : {}) }),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, WF_TRUST_DIR: trustDir, WF_ROUTING_STATE_DIR: join(trustDir, 'state'), ...(o.env ?? {}) },
    });
    return { status: r.status, stdout: r.stdout ?? '' };
  } finally {
    if (!o.trustDir) rmTempBestEffort(trustDir);
  }
}

/** 临时目录清理选项（内部任务-8 阶段 6.7 实测根因：Windows 下子进程句柄/AV 扫描会让 rmSync 偶发
 *  EPERM → 测试在 finally 清理时假红、污染回归证据；用 Node 的 maxRetries/retryDelay 重试面吸收）。
 *  证据：`内部证据` 与 内部未决-83。 */
const RM_TEMP_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/**
 * 尽力清理临时目录：**清理失败不判红**——Windows 下钩子超时被杀时其孙进程（shell 内 `sleep`）
 * 可能短暂持有目录句柄（CWD），rmdir 因此 EPERM；留一个 stale 临时目录无害，判据只在断言面。
 * （残余：verify-gate 的 kill 不回收孙进程，属既有生产面小卫生项，见 内部未决-83。）
 * @param {string} target 目标路径
 */
function rmTempBestEffort(target) {
  try {
    rmSync(target, RM_TEMP_OPTS);
  } catch {
    /* 见上：清理失败不构成测试失败 */
  }
}

/**
 * 建临时项目根（可带声明内容）。
 */
function makeRoot(gateContent) {
  const root = mkdtempSync(join(tmpdir(), 'wf-vgtest-')).split('\\').join('/');
  if (gateContent !== undefined) writeFileSync(join(root, 'verify.gate'), gateContent, 'utf8');
  return { root, cleanup: () => rmTempBestEffort(root) };
}

test('态1：未声明项目静默放行（rc0 零输出）', () => {
  const { root, cleanup } = makeRoot();
  try {
    const r = runGate(join(root, 'sub'));
    assert.equal(r.status, 0, '未声明 exit 0');
    assert.equal(r.stdout.trim(), '', '零输出');
  } finally {
    cleanup();
  }
});

test('态2：首次发现记录基线并阻断一拍（rc2 不执行）→ 复跑比对一致 rc0（2026-09-19 B13）', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    const a = runGate(root, { trustDir });
    assert.equal(a.status, 2, '首次发现 rc2（当次不执行）');
    assert.ok(a.stdout.includes('首次发现'), '首次发现提示可见');
    const files = readdirSync(trustDir);
    assert.equal(files.length, 1, '信任文件落在用户级目录（单文件）');
    const trust = readFileSync(join(trustDir, files[0]), 'utf8').trim();
    assert.match(trust, /^[0-9a-f]{64}$/, '信任为 64 位 hex');
    assert.ok(!existsSync(join(root, '.verify-gate.trust')), '项目根不再写信任文件');
    const b = runGate(root, { trustDir });
    assert.equal(b.status, 0, '复跑一致 rc0');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('同源预置伪造信任无效（2026-09-19 B13）：repo 根带伪造 .verify-gate.trust（含正确哈希）不被采信，仍走首次发现路径', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  try {
    // 攻击面形态：仓库同时预置 verify.gate 与内容匹配的 .verify-gate.trust——项目根信任
    // 已完全不读作凭据（legacy 不采信，正确哈希同拒），首次 Stop 仍记录用户级基线并阻断一拍
    writeFileSync(join(root, '.verify-gate.trust'), `${createHash('sha256').update('echo ok\n').digest('hex')}\n`, 'utf8');
    const r = runGate(root);
    assert.equal(r.status, 2, '同源预置不得静默放行');
    assert.ok(r.stdout.includes('首次发现'), '仍走首次发现（可见一拍）');
  } finally {
    cleanup();
  }
});

test('原生分隔符 cwd 上溯（2026-09-19 评审修复 H2）：子目录会话在 win32 反斜杠形态下仍能发现根声明文件', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    // join 产出原生分隔符形态（win32=反斜杠；posix 本用例退化为正斜杠回归）——
    // 修复前（win32）parentDir 纯 POSIX 上溯一步即坍缩到盘符根，根声明文件静默不可见
    const r = runGate(join(root, 'sub'), { trustDir });
    assert.equal(r.status, 2, '子目录 cwd 首次发现 rc2（发现即记录，B13 语义）');
    assert.equal(readdirSync(trustDir).length, 1, '信任基线落在根键——上溯发现生效');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('态3：声明命令失败 → rc2，信封可解析且摘要含命令原文与输出行', () => {
  const { root, cleanup } = makeRoot('echo boom-output-line; exit 1\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现：记录基线（B13 当次不执行）
    const r = runGate(root, { trustDir }); // 第二次起按基线执行——命令失败阻断
    assert.equal(r.status, 2, '失败阻断 exit 2');
    const env = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(env.hookEventName, 'Stop', '信封事件名');
    assert.ok(r.stdout.includes('boom-output-line'), '摘要含命令输出行');
    assert.ok(r.stdout.includes('echo boom-output-line; exit 1'), '摘要含命令原文');
    assert.ok(!('permissionDecision' in env), '不新增键（严格 schema）');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('态4：声明被篡改 → rc2 且提示重新确认（T-M8-3 不得静默继续）', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现（记录基线）
    writeFileSync(join(root, 'verify.gate'), 'echo ok\ntamper\n', 'utf8');
    const r = runGate(root, { trustDir });
    assert.equal(r.status, 2, '篡改阻断');
    assert.ok(r.stdout.includes('重新确认'), '重新确认提示');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('信任文件存在但空 → 防篡改阻断（PHASE1 评审门 #6：不并入首发现静默重录）', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现（记录基线）
    const files = readdirSync(trustDir);
    writeFileSync(join(trustDir, files[0]), '', 'utf8'); // 基线被外部清空：完整性无法证明
    const r = runGate(root, { trustDir });
    assert.equal(r.status, 2, '存在但空 → 防篡改阻断（非首发现重录）');
    assert.ok(r.stdout.includes('重新确认'), '走 tamper 路径');
    assert.ok(!r.stdout.includes('首次发现'), '不得按首发现静默重录基线');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('golden：归一化命令流哈希与旧 bash 版首录常量逐字节一致', async () => {
  const { normalizeGateCommands } = await import('../../hooks/verify-gate.mjs');
  const normalized = normalizeGateCommands(GOLDEN_SAMPLE);
  const hex = createHash('sha256').update(normalized, 'utf8').digest('hex');
  assert.equal(hex, GOLDEN_TRUST, 'golden 信任哈希锁定归一化口径（BOM/每行剥、\\r 去、仅左剥、行尾空白保留、# 时机）');
  // 集成面：同样例首次发现的 trust 文件（用户级）必须等于 golden 常量
  const { root, cleanup } = makeRoot(GOLDEN_SAMPLE);
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现：记录基线（B13 当次不执行命令）
    const files = readdirSync(trustDir);
    assert.equal(files.length, 1, '单信任文件');
    assert.equal(readFileSync(join(trustDir, files[0]), 'utf8').trim(), GOLDEN_TRUST, '首录值=golden');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('normalizeGateCommands 边界：右剥不发生；每行剥 BOM；# 在左剥后判定；末行无换行容忍', async () => {
  const { normalizeGateCommands } = await import('../../hooks/verify-gate.mjs');
  assert.equal(normalizeGateCommands('  echo a  \n'), 'echo a  \n', '行尾空白保留');
  assert.equal(normalizeGateCommands('﻿# a\n\uFEFFecho b\n'), 'echo b\n', '每行行首 BOM 都剥');
  assert.equal(normalizeGateCommands('  # 注释\n'), '', '注释在左剥后跳过');
  assert.equal(normalizeGateCommands('no-newline'), 'no-newline\n', '末行无换行仍产出且补 \\n');
  assert.equal(normalizeGateCommands('\n\n'), '', '空声明归一为空串');
});

test('synthesizeStatus：数字直用；null+超时→124；null+spawn失败→127', async () => {
  const { synthesizeStatus } = await import('../../hooks/verify-gate.mjs');
  assert.equal(synthesizeStatus({ status: 3 }).status, 3);
  assert.equal(synthesizeStatus({ status: null, signal: 'SIGTERM' }).status, 124);
  assert.equal(synthesizeStatus({ status: null, error: { killed: true } }).status, 124);
  assert.equal(synthesizeStatus({ status: null, error: { code: 'ETIMEDOUT' } }).status, 124);
  const notFound = synthesizeStatus({ status: null, error: { code: 'ENOENT' } });
  assert.equal(notFound.status, 127);
  assert.ok(notFound.note.includes('ENOENT'), '附 error.code');
});

test('resolveGateShell：VERIFY_GATE_SHELL 覆盖生效；坏路径返回 null（自身异常 fail-open）', async () => {
  const { resolveGateShell } = await import('../../hooks/verify-gate.mjs');
  const prev = process.env.VERIFY_GATE_SHELL;
  try {
    process.env.VERIFY_GATE_SHELL = 'bash';
    const ok = resolveGateShell();
    assert.equal(ok?.kind, 'bash', '注入缝生效');
    process.env.VERIFY_GATE_SHELL = 'C:/definitely/not/a/real/bash.exe';
    assert.equal(resolveGateShell(), null, '坏路径=fail-open 信号');
  } finally {
    if (prev === undefined) delete process.env.VERIFY_GATE_SHELL;
    else process.env.VERIFY_GATE_SHELL = prev;
  }
  // 集成：坏路径 shell 下声明项目 → fail-open exit 0（环境故障不放大成误阻断）
  const { root, cleanup } = makeRoot('echo hi\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir, env: { VERIFY_GATE_SHELL: 'C:/definitely/not/a/real/bash.exe' } }); // 首次发现（记录基线）
    const r = runGate(root, { trustDir, env: { VERIFY_GATE_SHELL: 'C:/definitely/not/a/real/bash.exe' } });
    assert.equal(r.status, 0, 'shell 注入缝坏路径 fail-open');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('超时：VERIFY_GATE_CMD_TIMEOUT=1 + 长命令（node 跨平台）→ rc2 且含 124 注记', () => {
  // 内部任务-244 T04：原 `sleep 5` 依赖宿主 shell 语义——无 bash 时落 shellTrue(cmd.exe) 立即
  // 退 1 必红。改 node -e 长驻（bash 与 cmd.exe 同语义），并配 shellTrue 分支用例（下条）。
  const { root, cleanup } = makeRoot('node -e "setTimeout(()=>{},5000)"\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现（B13 当次不执行）
    const r = runGate(root, { trustDir, env: { VERIFY_GATE_CMD_TIMEOUT: '1' } });
    assert.equal(r.status, 2, '超时阻断');
    assert.ok(r.stdout.includes('124'), '124 注记（GNU timeout 语义合成）');
    assert.ok(r.stdout.includes('超时'), '超时文案');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('DEV-244 T04：shellTrue 分支可执行（清 PATH/ProgramFiles 注入缝 → cmd.exe 语义真跑）', () => {
  const { root, cleanup } = makeRoot('node -e "process.exit(0)"\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  // 清空 shell 探测面：无 PATH 内 bash、无 ProgramFiles 惯例位置 → resolveGateShell 必走 shellTrue
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(path|pathext|programfiles(\(x86\))?|localappdata|verify_gate_shell)$/i.test(k)) continue;
    env[k] = v;
  }
  try {
    const a = runGate(root, { trustDir, env });
    assert.equal(a.status, 2, '首次发现 rc2（shellTrue 分支不影响首录语义）');
    const b = runGate(root, { trustDir, env });
    assert.equal(b.status, 0, `shellTrue 分支命令真执行（rc0；若分支不可达/命令未跑会 rc2/127：${b.stdout}）`);
    assert.equal(b.stdout.trim(), '', '通过路径零输出');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('DEV-244 T07：信任文件按项目根 digest 键控——同 trustDir 两项目互不共享信任', () => {
  const a = makeRoot('echo a\n');
  const b = makeRoot('echo b\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    assert.equal(runGate(a.root, { trustDir }).status, 2, 'A 首录');
    assert.equal(runGate(b.root, { trustDir }).status, 2, 'B 首录（不得因 A 已信任而放行）');
    const files = readdirSync(trustDir).filter((f) => f.endsWith('.sha256')).sort();
    assert.equal(files.length, 2, '两项目根两信任文件（固定文件名实现会只留 1 个）');
    for (const f of files) assert.match(readFileSync(join(trustDir, f), 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.equal(runGate(a.root, { trustDir }).status, 0, 'A 复跑放行');
    assert.equal(runGate(b.root, { trustDir }).status, 0, 'B 复跑放行');
  } finally {
    a.cleanup(); b.cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('DEV-244 C02：整轮执行预算耗尽 → 124 阻断并注记（防多条长命令击穿宿主 60s）', () => {
  // 首条用 shell 内建 echo（毫秒级），保证预算耗尽一定发生在第二条之前（node 启动在负载下可 >1s）
  const { root, cleanup } = makeRoot('echo ok\nnode -e "setTimeout(()=>{},3000)"\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    runGate(root, { trustDir }); // 首次发现
    // 预算 1ms：首条命令后即耗尽，第二条按 124 阻断且带预算注记（不走默认超时文案）
    const r = runGate(root, { trustDir, env: { WF_VERIFY_GATE_TOTAL_MS: '1' } });
    assert.equal(r.status, 2, '预算耗尽阻断');
    assert.ok(r.stdout.includes('124'), '合成 124 退出码');
    assert.ok(r.stdout.includes('总执行预算耗尽'), '注记点名预算而非普通超时');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
  }
});

test('fail-open：解析成功后自身异常（注入缝）→ exit 0 零输出', () => {
  const { root, cleanup } = makeRoot('echo ok\n');
  try {
    const r = runGate(root, { env: { GUARD_HOOK_INJECT_CRASH: '1' } });
    assert.equal(r.status, 0, '崩溃陷阱改写为 0');
    assert.equal(r.stdout.trim(), '', '零输出');
  } finally {
    cleanup();
  }
});

test('入口：--selftest 退 0 含 OK；--help 退 0 含 verify.gate', () => {
  const st = spawnSync(process.execPath, [HOOK, '--selftest'], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(st.status, 0);
  assert.ok(st.stdout.includes('OK'));
  const help = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('verify.gate'));
});

// ── 内部任务-261 步骤18（内部决策-066 D7）：verify-gate 只读写归因报表 warning（不改变 gate 判据/退出码） ──

/** 与 write-audit 报表文件口径一致的短摘要。 */
function sha16(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 准备「已录信任」的项目，并可选写入本会话 baseline/report，返回二次运行结果。
 * @param {{sessionId?: string, report?: object|null, reportRaw?: string, baseline?: boolean}} o
 */
function runWithReport(o = {}) {
  const sessionId = o.sessionId ?? 's1';
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-vgstate-'));
  const sidDigest = sha16(sessionId);
  const report = join(stateDir, `wf-write-report-${sidDigest}.json`);
  const baseline = join(stateDir, `wf-write-baseline-${sidDigest}.json`);
  try {
    // 首跑录信任（rc2），随后写入测试数据，第二次跑 rc0 并检查 warning
    const first = runGate(root, { trustDir, sessionId, env: { WF_ROUTING_STATE_DIR: stateDir } });
    assert.equal(first.status, 2, '首跑须录信任并阻断');
    if (o.baseline) writeFileSync(baseline, JSON.stringify({ v: 1, sidDigest, root, ts: new Date().toISOString(), entries: [] }));
    if (o.reportRaw !== undefined) writeFileSync(report, o.reportRaw);
    else if (o.report) writeFileSync(report, JSON.stringify({ sidDigest, ts: new Date().toISOString(), ...o.report }));
    const second = runGate(root, { trustDir, sessionId, env: { WF_ROUTING_STATE_DIR: stateDir } });
    return { ...second, cleanup: () => { cleanup(); rmTempBestEffort(trustDir); rmTempBestEffort(stateDir); } };
  } catch (err) {
    cleanup();
    rmTempBestEffort(trustDir);
    rmTempBestEffort(stateDir);
    throw err;
  }
}

test('DEV-261 写归因报表：clean → 静默；unattributed/degraded/缺失/过期/损坏 → 显式 warning', () => {
  const clean = runWithReport({ baseline: true, report: { status: 'clean', attributed: {}, rows: [] } });
  try {
    assert.equal(clean.status, 0, 'gate 仍放行');
    assert.equal(clean.stdout.trim(), '', 'clean 零输出');
  } finally { clean.cleanup(); }

  const un = runWithReport({ baseline: true, report: { status: 'unattributed', attributed: { unattributed: 1 }, rows: [{ path: 'a.txt', state: 'unattributed' }] } });
  try {
    assert.equal(un.status, 0);
    assert.ok(un.stdout.includes('【workflow 写归因】unattributed 1 项'), `unattributed 须显式：${un.stdout}`);
    assert.ok(un.stdout.includes('a.txt'), 'warning 含未归因路径');
  } finally { un.cleanup(); }

  const deg = runWithReport({ baseline: true, report: { status: 'degraded', degradedReasons: ['git-status-failed:128'], attributed: {}, rows: [] } });
  try {
    assert.equal(deg.status, 0);
    assert.ok(deg.stdout.includes('degraded：git-status-failed:128'), `degraded 须显式：${deg.stdout}`);
  } finally { deg.cleanup(); }

  const miss = runWithReport({ baseline: true });
  try {
    assert.equal(miss.status, 0);
    assert.ok(miss.stdout.includes('缺失'), `missing report 须显式 degraded：${miss.stdout}`);
  } finally { miss.cleanup(); }

  const old = runWithReport({ baseline: true, report: { status: 'clean', attributed: {}, rows: [], ts: new Date(Date.now() - 7 * 3600 * 1000).toISOString() } });
  try {
    assert.equal(old.status, 0);
    assert.ok(old.stdout.includes('过期'), `过期 report 须显式 degraded：${old.stdout}`);
  } finally { old.cleanup(); }

  const bad = runWithReport({ baseline: true, reportRaw: '{bad json' });
  try {
    assert.equal(bad.status, 0);
    assert.ok(bad.stdout.includes('损坏'), `损坏 report 须显式 degraded：${bad.stdout}`);
  } finally { bad.cleanup(); }
});

test('DEV-261 写归因报表：sid 不匹配/ts 非法/degraded 无原因/未生效会话静默/坏负载 fail-open', () => {
  const mismatch = runWithReport({ baseline: true, reportRaw: JSON.stringify({ sidDigest: 'deadbeefdeadbeef', ts: new Date().toISOString(), status: 'clean', attributed: {}, rows: [] }) });
  try {
    assert.equal(mismatch.status, 0);
    assert.ok(mismatch.stdout.includes('会话不匹配'), `sid 不匹配须显式 degraded：${mismatch.stdout}`);
  } finally { mismatch.cleanup(); }

  const badTs = runWithReport({ baseline: true, report: { status: 'clean', attributed: {}, rows: [], ts: 'not-a-date' } });
  try {
    assert.equal(badTs.status, 0);
    assert.ok(badTs.stdout.includes('ts 非法'), `ts 非法须显式 degraded：${badTs.stdout}`);
  } finally { badTs.cleanup(); }

  const noReason = runWithReport({ baseline: true, report: { status: 'degraded', attributed: {}, rows: [] } });
  try {
    assert.equal(noReason.status, 0);
    assert.ok(noReason.stdout.includes('未知原因'), `degraded 无原因须显式：${noReason.stdout}`);
  } finally { noReason.cleanup(); }

  // write-guard 未在本会话生效（无 baseline、无 report）→ 静默，不误报
  const inactive = runWithReport({});
  try {
    assert.equal(inactive.status, 0);
    assert.equal(inactive.stdout.trim(), '', '未生效会话不输出 warning');
  } finally { inactive.cleanup(); }

  // 坏负载：currentPayload JSON 解析失败 → 回退 cwd、零输出退 0（fail-open）
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  try {
    const r = spawnSync(process.execPath, [HOOK], { input: '{bad json', encoding: 'utf8', env: { ...process.env, WF_TRUST_DIR: trustDir } });
    assert.equal(r.status, 0);
    assert.equal((r.stdout ?? '').trim(), '');
  } finally { rmTempBestEffort(trustDir); }
});

test('DEV-261 写归因报表：形状损坏（字段类型非法）→ 显式 degraded；状态根不可解析且无 baseline → 静默', () => {
  const badShape = runWithReport({ baseline: true, reportRaw: JSON.stringify({ sidDigest: sha16('s1'), ts: new Date().toISOString(), status: 'clean', degradedReasons: 'not-array', attributed: {}, rows: [] }) });
  try {
    assert.equal(badShape.status, 0);
    assert.ok(badShape.stdout.includes('形状损坏'), `字段类型非法须显式 degraded：${badShape.stdout}`);
  } finally { badShape.cleanup(); }

  // 状态根为文件 → report/baseline 均不可见（无 baseline 早返回静默）；钩内异常另由外层 catch fail-open
  const { root, cleanup } = makeRoot('echo ok\n');
  const trustDir = mkdtempSync(join(tmpdir(), 'wf-vgtrust-'));
  const badState = join(tmpdir(), `wf-vg-badstate-${process.pid}-${Date.now()}`);
  writeFileSync(badState, 'x');
  try {
    const first = runGate(root, { trustDir, env: { WF_ROUTING_STATE_DIR: badState } });
    assert.equal(first.status, 2, '首跑录信任');
    const second = runGate(root, { trustDir, env: { WF_ROUTING_STATE_DIR: badState } });
    assert.equal(second.status, 0, '报表不可见不得阻断完成闸');
    assert.equal(second.stdout.trim(), '', '无 baseline 时不输出 warning（不误报）');
  } finally {
    cleanup();
    rmTempBestEffort(trustDir);
    rmSync(badState, { force: true });
  }
});

// 双跑对拍用例（对旧 verify-gate.sh 逐字对拍）已删除（2026-09-19 评审修复批收尾 S2）：
// OLD_SH（verify-gate.sh）自 0.2.5 Node 移植批删除后恒不存在，该用例永久 skip 成为死夹具；
// 其断言锚旧语义（首录即执行/信任落项目根），与 B13 信任迁移后的首发现语义相矛盾，且
// runNew 未设 WF_TRUST_DIR（一旦旧脚本回归会写真实用户目录）。golden 信任哈希的等价锁定
// 由上方「golden：归一化命令流哈希与旧 bash 版首录常量逐字节一致」用例持续承载。
