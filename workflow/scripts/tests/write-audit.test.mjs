// 文件：write-audit.test.mjs
// 描述：写归因账（内部决策-066 D6，内部任务-261；写者溯源五态 内部任务-342）单元测试——journal 追加/读取（坏行计数）、
//       baseline 快照、Stop 归因五态（attributed edit/trusted/declared/delegated/internal、preexisting、
//       external、unattributed、degraded）、会话过滤（他会话 trusted/declared 不得吸收本会话写、同 taskId 异会话计 delegated）、
//       绝对 edit 路径归一、C6 vcsHint、rename porcelain 解析、degraded 吸收态与 report 落盘。fixture：tmp git 仓＋手工 journal；
//       基线后改写一律经 writeChanged（显式推 mtime，粗时钟平台确定性，内部任务-264）。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；git 仅测试夹具用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendJournal,
  readJournal,
  snapshotBaseline,
  buildWriteReport,
  rotateJournal,
  parsePorcelainZ,
  baselinePath,
  reportPath,
  repoRelOf,
  journalPath,
  projectDigestOf,
  resolveBaselineBudget,
} from '../lib/write-audit.mjs';
import { AUDIT_BUDGET_ENV, ensureAuditBudget } from './helpers/test-budget.mjs';
import { projectKey } from '../../hooks/routing-lib.mjs';

// 内部任务-311 F3/F5：测试夹具统一预算注入（单文件直跑；全量由 release-suite envForScope 注入同名额）。
ensureAuditBudget();

test('内部任务-311 F3：测试预算注入单点生效（机制断言，先于加固的 RED 判据）', () => {
  const saved = process.env[AUDIT_BUDGET_ENV];
  assert.equal(ensureAuditBudget(), 60000, '未设置时 helper 写入 60000');
  assert.equal(resolveBaselineBudget(), 60000, '库读取到注入预算');
  delete process.env[AUDIT_BUDGET_ENV];
  assert.equal(resolveBaselineBudget(), undefined, '未注入时库回落 undefined（缺省 800ms 语义不变）');
  if (saved !== undefined) process.env[AUDIT_BUDGET_ENV] = saved;
});

/** 临时目录清理选项（同族形态，源自 `workflow/scripts/tests/verify-gate.test.mjs` 的 内部任务-8 阶段
 *  6.7 修法与 内部未决-83：Windows 下子进程句柄/AV 扫描会让 rmSync 偶发 EPERM——测试在 finally
 *  清理时假红、污染回归证据；用 Node 的 maxRetries/retryDelay 重试面吸收。内部任务-293 同族对齐）。 */
const RM_TEMP_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** 尽力清理临时目录：**清理失败不判红**——留一个 stale 临时目录无害，判据只在断言面。
 *  @param {string} target 目标路径 */
function rmTempBestEffort(target) {
  try {
    rmSync(target, RM_TEMP_OPTS);
  } catch {
    /* 句柄短暂占用：见 RM_TEMP_OPTS 注释（内部未决-83 同族） */
  }
}

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = 'projdigest';
const SID = 'siddigest';
const SHA = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const NOW = () => new Date().toISOString();

test('snapshotBaseline 的 git 预算可注入：极小预算 → 确定性降级', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'x.txt'), 'x\n');
    // 1ms 预算下 git status 必然超时 ⇒ 降级可确定性构造（内部任务-293：机器负载不再决定红绿）
    const r = snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 1 });
    assert.equal(r.status, 'degraded', `极小预算须降级（${r.reason}）`);
    assert.ok(String(r.reason).startsWith('git-status-failed'), `降级原因须指向 git 失败（${r.reason}）`);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('临时目录尽力清理：嵌套树删除成功、缺失路径不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'write-audit-best-effort-'));
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'deep', 'f.txt'), 'x\n');
  rmTempBestEffort(dir);
  assert.equal(existsSync(dir), false, '嵌套树须被删除');
  rmTempBestEffort(join(dir, 'never-existed'));
});

/** 建 tmp git 仓（git init；state 目录在仓外，模拟运行态）。 */
function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'write-audit-'));
  const r = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) { rmTempBestEffort(root); return null; }
  const state = mkdtempSync(join(tmpdir(), 'write-audit-state-'));
  return { root, state };
}

/** 本会话 journal 行（sidDigest 与 report 的 SID 一致）。 */
function sessionRow(extra = {}) {
  return { tool: 'shell', sid: 's1', sidDigest: SID, ts: NOW(), ...extra };
}

/** 基线后改写：粗时钟平台（内核按 jiffy 截断 inode mtime）同尺寸双写可能 mtime 不变，落入
 *  (mtime,size) 全等的 preexisting 分支——改写后显式推 mtime（+60s，远超任何时钟刻度），
 *  保证「基线后写」对基线比对恒可见（内部任务-264；生产行为不变，仅夹具确定性）。 */
function writeChanged(root, file, content) {
  const p = join(root, file);
  writeFileSync(p, content);
  const t = new Date(Date.now() + 60_000);
  utimesSync(p, t, t);
}

test('journal 追加/读取：JSONL、坏行计数可见（不得静默）', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'edit', path: 'a.txt' }));
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C1', decision: 'record' }));
    writeFileSync(journalPath(repo.state, PROJ), 'not-json\n', { flag: 'a' });
    const r = readJournal(repo.state, PROJ);
    assert.equal(r.rows.length, 2);
    assert.equal(r.badLines, 1, '坏行须计数（report 据此 degraded）');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('baseline 快照：git 仓 dirty 文件记录；缺失仓 → degraded', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'dirty.txt'), 'x\n');
    const r = snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    assert.equal(r.status, 'ok', `快照须 ok（${r.reason}）`);
    const base = JSON.parse(readFileSync(baselinePath(repo.state, SID), 'utf8'));
    assert.ok(base.entries.some((e) => e.path === 'dirty.txt'), 'dirty 文件入基线');
    const notRepo = mkdtempSync(join(tmpdir(), 'write-audit-nogit-'));
    try {
      assert.equal(snapshotBaseline({ stateDir: repo.state, sidDigest: 'other', root: notRepo, gitTimeoutMs: 30_000 }).status, 'degraded');
    } finally {
      rmTempBestEffort(notRepo);
    }
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-261 归因账：四态分类与 degraded（Edit 目标绝对路径归 attributed）', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'a.txt'), 'one\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', 'two\n');
    // 真实宿主 Edit 负载是绝对路径；归因须归一后命中
    appendJournal(repo.state, PROJ, { tool: 'edit', path: join(repo.root, 'a.txt'), sid: 's1', sidDigest: SID, ts: NOW() });
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'clean', `绝对路径 Edit 归因后 clean（rows=${JSON.stringify(rep.rows)} degraded=${JSON.stringify(rep.degradedReasons)}）`);
    assert.equal(rep.attributed.edit, 1);
    assert.ok(existsSync(reportPath(repo.state, SID)), 'report 须落盘');
    assert.equal(JSON.parse(readFileSync(reportPath(repo.state, SID), 'utf8')).status, 'clean');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('无 journal 的改动 → unattributed；baseline 内未变 → preexisting', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'dirty.txt'), 'x\n');
    assert.equal(snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 }).status, 'ok');
    writeFileSync(join(repo.root, 'new.txt'), 'n\n');
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'unattributed');
    assert.ok(rep.rows.some((r) => r.path === 'new.txt' && r.state === 'unattributed'), '新文件须 unattributed');
    assert.ok(rep.rows.some((r) => r.path === 'dirty.txt' && r.state === 'preexisting'), '基线脏文件未变须 preexisting');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-261 归因账：受信与声明写归因（本会话），他会话行不得吸收本会话写', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    writeFileSync(join(repo.root, 'b.txt'), '1\n');
    writeFileSync(join(repo.root, 'c.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    writeChanged(repo.root, 'b.txt', '2\n');
    writeChanged(repo.root, 'c.txt', '2\n');
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C1', trusted: true, decision: 'allow', targets: ['a.txt'] }));
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C1', declared: true, decision: 'allow', targets: ['b.txt'] }));
    appendJournal(repo.state, PROJ, { tool: 'shell', cls: 'C1', trusted: false, decision: 'record', sid: 'other-session', sidDigest: SHA('other-session'), taskId: '内部任务-261', targets: ['c.txt'], ts: NOW() });
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.trusted, 1);
    assert.equal(rep.attributed.declared, 1);
    assert.equal(rep.attributed.delegated, 1);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('他会话 trusted/declared 行不吸收本会话写：external 文件须 unattributed', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'external.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'external.txt', '2\n');
    // 旧会话 trusted 行（不同 sid、不同 taskId）——不得把本会话写归成 trusted
    appendJournal(repo.state, PROJ, { tool: 'shell', cls: 'C1', trusted: true, decision: 'allow', sid: 'old', sidDigest: SHA('old'), taskId: 'DEV-OTHER', ts: NOW() });
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'unattributed', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.trusted, 0);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('B4 跨 Stop：路径无关配额不得复用（旧 trusted 行不吸收后续无记录写）', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C1', trusted: true, decision: 'allow', targets: ['a.txt'] }));
    const rep1 = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep1.status, 'clean');
    // 第二次 Stop：上一轮 trusted 行仍在 journal；新增无记录写 b.txt，不得被 absorbing 成 trusted
    writeFileSync(join(repo.root, 'b.txt'), '3\n');
    const rep2 = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep2.status, 'unattributed', JSON.stringify(rep2.rows));
    assert.ok(rep2.rows.some((r) => r.path === 'b.txt' && r.state === 'unattributed'), 'b.txt 须 unattributed');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('B4 delegated：taskId=null 不归因；同 taskId 且路径命中才计 delegated', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'c.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'c.txt', '2\n');
    appendJournal(repo.state, PROJ, { tool: 'shell', cls: 'C1', trusted: false, decision: 'record', sid: 'delegate', sidDigest: SHA('delegate'), taskId: '内部任务-261', targets: ['c.txt'], ts: NOW() });
    // taskId=null：不得归因
    const repNull = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: null });
    assert.equal(repNull.attributed.delegated, 0, 'taskId=null 不得计 delegated');
    // 同 taskId：路径命中才归因
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.delegated, 1);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('degraded 吸收态：journal 坏行/unknown edit 不得冒充 clean；C6 记 vcsHint', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'a.txt'), 'one\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', 'two\n');
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'edit', shape: 'unknown', degraded: true }));
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C6', decision: 'skip' }));
    writeFileSync(journalPath(repo.state, PROJ), '{bad\n', { flag: 'a' });
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'degraded', JSON.stringify(rep.degradedReasons));
    assert.ok(rep.degradedReasons.some((r) => r.startsWith('journal-bad-lines')), '坏行须入 degraded');
    assert.ok(rep.degradedReasons.some((r) => r.startsWith('edit-shape-unknown')), 'unknown edit 须入 degraded');
    assert.equal(rep.vcsHint, 1, 'C6 行须记 vcsHint');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('degraded 吸收态：baseline 缺失 / 非 git 仓 → status 不冒充 clean', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'degraded', '无 baseline 须 degraded');
    assert.ok(rep.degradedReasons.length >= 1);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('B5：baseline 失败留痕在后继成功基线之后仍须 degraded；delegated 无 sid 行不计', () => {
  const repo = makeGitRepo();
  if (!repo) return;
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    // 先记 baseline 失败留痕，再成功建 baseline（模拟后续 PreToolUse 恢复）
    appendJournal(repo.state, PROJ, { tool: 'baseline', status: 'degraded', reason: 'git-status-failed:128', sid: 's1', sidDigest: SID, ts: '2026-01-01T00:00:00.000Z' });
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'edit', path: 'a.txt' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
    assert.equal(rep.status, 'degraded', 'baseline 失败留痕不得被后续成功掩盖');
    assert.ok(rep.degradedReasons.some((r) => r.startsWith('journal-degraded-rows')));
    // delegated 行缺 sid：不归因
    writeFileSync(join(repo.root, 'c.txt'), '1\n');
    const rep2State = mkdtempSync(join(tmpdir(), 'write-audit-state2-'));
    try {
      snapshotBaseline({ stateDir: rep2State, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
      writeChanged(repo.root, 'c.txt', '2\n');
      appendJournal(rep2State, PROJ, { tool: 'shell', cls: 'C1', taskId: '内部任务-261', targets: ['c.txt'], ts: NOW() });
      const rep2 = buildWriteReport({ stateDir: rep2State, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-261' });
      assert.equal(rep2.attributed.delegated, 0, '无 sid 的 delegated 行不计');
      assert.ok(rep2.rows.some((r) => r.path === 'c.txt' && r.state === 'unattributed'));
    } finally {
      rmTempBestEffort(rep2State);
    }
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('parsePorcelainZ：rename/copy 对只取新路径（不产生幻影行）', () => {
  assert.deepEqual(parsePorcelainZ(' M a.txt\0?? new.txt\0R  new2.txt\0old2.txt\0'), ['a.txt', 'new.txt', 'new2.txt']);
});

test('内部任务-261 journal 轮转：>5000 行只留尾部 2500；未超上限不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-audit-rotate-'));
  try {
    const file = journalPath(dir, PROJ);
    writeFileSync(file, `${Array.from({ length: 5001 }, (_, i) => JSON.stringify({ i })).join('\n')}\n`, 'utf8');
    assert.equal(rotateJournal(dir, PROJ), true, '超上限须轮转');
    const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, 2500, '保留尾部 2500 行');
    assert.equal(JSON.parse(kept[kept.length - 1]).i, 5000, '最后一行须为最新记录');
    assert.equal(rotateJournal(dir, PROJ), false, '未超上限不轮转');
  } finally {
    rmTempBestEffort(dir);
  }
});

test('内部任务-261 appendScriptWrite 入参缺失：dir/reason/record 缺一即 {ok:false} 不抛', async () => {
  const { appendScriptWrite } = await import('../lib/script-write-store.mjs');
  assert.equal(appendScriptWrite({}).ok, false, '缺 dir');
  assert.equal(appendScriptWrite({ dir: tmpdir() }).ok, false, '缺 record');
  const home = mkdtempSync(join(tmpdir(), 'wf-audit-sw-'));
  try {
    assert.equal(appendScriptWrite({ dir: home, record: {} }).ok, false, '缺 reason');
    assert.equal(appendScriptWrite({ dir: home, record: { reason: '   ' } }).ok, false, '空白 reason');
  } finally {
    rmTempBestEffort(home);
  }
});

// ── 内部任务-332：归一锚（canonical root vs 原始符号链接形态路径；alias 夹具判别与宿主 tmpdir 形态无关） ──
test('内部任务-332 归一锚：alias 形态 edit 路径对 canonical root 仍归因（不落 unattributed）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用（夹具无法建仓）'); return; }
  const real = realpathSync(repo.root); // 生产面 root＝activationRoot 恒 canonical（task-recap.mjs:80）
  const alias = join(tmpdir(), `write-audit-alias-${basename(real)}`);
  let linked = true;
  try {
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (!linked) {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
    t.skip('当前环境不支持 symlink/junction（形态分裂用例不判红，登记跳过）');
    return;
  }
  try {
    writeFileSync(join(real, 'a.txt'), 'one\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: real, gitTimeoutMs: 30_000 });
    writeChanged(real, 'a.txt', 'two\n');
    // 旧 journal（修复前会话）edit 行为 alias 形态绝对路径——journal append-only 跨修复部署，
    // 报表须兼容旧形态行（修复后 write-guard 写归一仓相对路径）
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'edit', path: join(alias, 'a.txt') }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: real, taskId: '内部任务-332' });
    assert.equal(rep.status, 'clean', `alias 形态 edit 须归因（rows=${JSON.stringify(rep.rows)} degraded=${JSON.stringify(rep.degradedReasons)}）`);
    assert.equal(rep.attributed.edit, 1, '归一后须命中 porcelain 仓相对路径');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
    rmTempBestEffort(alias);
  }
});

test('内部任务-332 repoRelOf：alias 形态绝对路径 canonical 命中仓相对', (t) => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'repoRelOf-')));
  const alias = join(tmpdir(), `repoRelOf-link-${basename(real)}`);
  try {
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    rmTempBestEffort(real);
    t.skip('当前环境不支持 symlink/junction（登记跳过）');
    return;
  }
  try {
    assert.equal(repoRelOf(real, join(alias, 'docs/a.md')), 'docs/a.md', 'alias 形态绝对路径 canonical 命中仓相对');
  } finally {
    rmTempBestEffort(real);
    rmTempBestEffort(alias);
  }
});

test('内部任务-332 repoRelOf：空串早退／不存在尾段保字面／仓外回落原值（不依赖 symlink，恒执行）', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'repoRelOf-plain-')));
  try {
    assert.equal(repoRelOf(real, ''), '', '空串早退原样返回');
    assert.equal(repoRelOf(real, join(real, 'docs/new-file.md')), 'docs/new-file.md', '不存在尾段（Edit/Write 新建常态）保字面不抛');
    const outside = join(tmpdir(), 'repoRelOf-outside-y.md');
    assert.equal(repoRelOf(real, outside), outside, '仓外目标回落原值');
  } finally {
    rmTempBestEffort(real);
  }
});

// ── 内部任务-342：写者溯源五态（external 单列 / internal 归 attributed / ownTouched 洗白防护） ──

/** 他会话行（sid 非空且 sidDigest 不同；用于 delegated/external 判定）。 */
function foreignRow(extra = {}) {
  return { sid: 'other-session', sidDigest: SHA('other-session'), ts: NOW(), ...extra };
}

test('内部任务-342 写者溯源：他会话跨任务 edit 行归 external 且 status 保持 clean', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'edit', path: 'a.txt', taskId: 'DEV-OTHER' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.unattributed, 0, '他会话跨任务写不得落 unattributed');
    assert.equal(rep.external, 1, 'external 单列顶层计数');
    const row = rep.rows.find((r) => r.path === 'a.txt');
    assert.equal(row.state, 'external');
    assert.deepEqual(row.writer, { sidDigest: SHA('other-session'), taskId: 'DEV-OTHER' });
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：同任务他会话 edit/internal 行归 delegated', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    writeFileSync(join(repo.root, 'b.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    writeChanged(repo.root, 'b.txt', '2\n');
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'edit', path: 'a.txt', taskId: '内部任务-342' }));
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'internal', shape: 'internal', targets: ['b.txt'], taskId: '内部任务-342' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.delegated, 2, '同任务他会话 edit 与 internal 行均归 delegated');
    assert.equal(rep.attributed.unattributed, 0);
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：internal journal 行归 attributed/internal（owner null 记 writer=null）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'c.txt'), '1\n');
    writeFileSync(join(repo.root, 'd.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'c.txt', '2\n');
    writeChanged(repo.root, 'd.txt', '2\n');
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'internal', shape: 'internal', targets: ['c.txt'] }));
    appendJournal(repo.state, PROJ, { tool: 'internal', shape: 'internal', targets: ['d.txt'], sid: null, sidDigest: null, ts: NOW() });
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.internal, 2, '本会话与 owner-null internal 行均归 attributed/internal');
    assert.equal(rep.attributed.unattributed, 0);
    const dRow = rep.rows.find((r) => r.path === 'd.txt');
    assert.equal(dRow.writer, null, 'owner 不可识别时 writer=null，不冒充 external');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：本会话未声明写+他会话 target 行不得被吸收（洗白负例）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'b.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'b.txt', '2\n');
    // 本会话真实写了 b.txt 但未受信/未声明（write-guard 记 record/skip 行，无 targetReason）
    appendJournal(repo.state, PROJ, sessionRow({ cls: null, decision: 'skip', targets: ['b.txt'] }));
    // 他会话同任务行也覆盖 b.txt——不得据此把本会话的写吸成 delegated
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'shell', targets: ['b.txt'], taskId: '内部任务-342' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'unattributed', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.delegated, 0, 'ownTouched 命中且无归因理由 → 不得吸收为 delegated');
    assert.equal(rep.attributed.unattributed, 1, '仍是 unattributed（洗白负例）');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：他会话 edit 行归 delegated/external（同任务）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'edit', path: 'a.txt', taskId: '内部任务-342' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.delegated, 1, '同任务他会话 edit 行归 delegated');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：execDir 归一——子目录 cwd 未受信写+他会话同名 target 不得洗白', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    mkdirSync(join(repo.root, 'sub'), { recursive: true });
    writeFileSync(join(repo.root, 'sub', 'b.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(join(repo.root, 'sub'), 'b.txt', '2\n');
    // 本会话未受信写：target 为子目录相对 token，行携带 execDir=sub
    appendJournal(repo.state, PROJ, sessionRow({ cls: null, decision: 'skip', targets: ['b.txt'], execDir: join(repo.root, 'sub') }));
    // 他会话同任务写命中 sub/b.txt——不得把本会话写吸收为 delegated
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'shell', targets: ['sub/b.txt'], taskId: '内部任务-342' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'unattributed', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.delegated, 0, 'execDir 归一后 ownTouched 命中，不得吸收为 delegated');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：他会话 unknown edit 不降级本会话（degraded 统计源分离）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, sessionRow({ tool: 'edit', path: 'a.txt' }));
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'edit', shape: 'unknown', degraded: true, taskId: 'DEV-OTHER' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.ok(!rep.degradedReasons.some((x) => String(x).startsWith('edit-shape-unknown')), '他会话 unknown edit 不得降级本会话');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：窗口外旧 foreign 行不参与 external 归因', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    appendJournal(repo.state, PROJ, foreignRow({ tool: 'edit', path: 'a.txt', taskId: 'DEV-OTHER', ts: '2026-01-01T00:00:00.000Z' }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'unattributed', JSON.stringify(rep.rows));
    assert.equal(rep.external, 0, '窗口外旧 foreign 行不得作为 external 证据');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

test('内部任务-342 写者溯源：decision=record 的声明写仍作归因理由（不能只认 allow）', (t) => {
  const repo = makeGitRepo();
  if (!repo) { t.skip('git 不可用'); return; }
  try {
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    snapshotBaseline({ stateDir: repo.state, sidDigest: SID, root: repo.root, gitTimeoutMs: 30_000 });
    writeChanged(repo.root, 'a.txt', '2\n');
    // trackedTier=shadow 观测模式下，已执行的声明写记 decision='record'（非 allow、非 deny）
    appendJournal(repo.state, PROJ, sessionRow({ cls: 'C1', trusted: false, declared: true, decision: 'record', targets: ['a.txt'] }));
    const rep = buildWriteReport({ stateDir: repo.state, sidDigest: SID, projDigest: PROJ, root: repo.root, taskId: '内部任务-342' });
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
    assert.equal(rep.attributed.declared, 1, 'decision=record 的声明写须计 attributed/declared');
  } finally {
    rmTempBestEffort(repo.root);
    rmTempBestEffort(repo.state);
  }
});

/**
 * 内部任务-349 e2e 夹具：按**症状仓布局**构造（`内部工作流状态` 被 git 跟踪）。
 * 本仓该路径被 gitignore（报表只遍历 git 状态路径），故本仓不可观测——用例以 tracked 布局验证归因链。
 * @returns {{repo:object|null, restore:()=>void}}
 */
function incidentAttributionRepo() {
  const repo = makeGitRepo();
  if (!repo) return { repo: null, restore: () => {} };
  const saved = { state: process.env.WF_ROUTING_STATE_DIR, incident: process.env.WF_INCIDENT_ROOT };
  delete process.env.WF_INCIDENT_ROOT;
  process.env.WF_ROUTING_STATE_DIR = repo.state;
  for (const args of [['config', 'user.name', 'tester'], ['config', 'user.email', 'tester@example.com']]) {
    spawnSync('git', args, { cwd: repo.root, encoding: 'utf8' });
  }
  return {
    repo,
    restore: () => {
      if (saved.state === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = saved.state;
      if (saved.incident === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = saved.incident;
      rmTempBestEffort(repo.root);
      rmTempBestEffort(repo.state);
    },
  };
}

test('内部任务-349 异常存储内部写归因：appendIncident → attributed/internal（tracked 台账布局）', async (t) => {
  const fx = incidentAttributionRepo();
  if (!fx.repo) { t.skip('git 不可用'); return; }
  const { root, state } = fx.repo;
  try {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'incidents.jsonl'), '');
    spawnSync('git', ['add', '内部工作流状态'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, encoding: 'utf8' });
    const SID_RAW = 'session-abc';
    const SID_DIGEST = SHA(SID_RAW);
    const projDigest = projectDigestOf(projectKey(root));
    snapshotBaseline({ stateDir: state, sidDigest: SID_DIGEST, root, gitTimeoutMs: 30_000 });
    const { appendIncident } = await import('../lib/incident-store.mjs');
    const a = appendIncident(root, { id: 'ri-dev349-e2e', ts: Date.now(), session: SID_RAW, taskId: '内部任务-349', kind: 'tool-failure', digest: 'd000000000000001' });
    assert.equal(a.ok, true, '账本写须成功');
    const rep = buildWriteReport({ stateDir: state, sidDigest: SID_DIGEST, projDigest, root, taskId: '内部任务-349' });
    const row = rep.rows.find((r) => r.path === '内部工作流状态');
    assert.ok(row, `须有账本行（rows=${JSON.stringify(rep.rows)}）`);
    assert.equal(row.state, 'attributed', `账本变更须已归因（row=${JSON.stringify(row)}）`);
    assert.equal(row.reason, 'internal', '内部写归 attributed/internal');
    // 判别链：journal 行自身的 sidDigest 才是归因依据（row.writer 由报表入参回填，断言它属同义反复）
    const { rows: journalRows } = readJournal(state, projDigest);
    assert.ok(journalRows.some((r) => r.sidDigest === SID_DIGEST), 'journal 行的 sidDigest 与报表同算法');
    assert.ok(journalRows.some((r) => Array.isArray(r.targets) && r.targets[0] === '内部工作流状态'), 'journal 行 target 为账本等值路径');
    assert.equal(rep.attributed.unattributed, 0, '不得落 unattributed');
    assert.equal(rep.status, 'clean', JSON.stringify(rep.rows));
  } finally {
    fx.restore();
  }
});

test('内部任务-349 异常存储内部写归因：账本 gitignore 的仓零噪声（本仓形态）', async (t) => {
  const fx = incidentAttributionRepo();
  if (!fx.repo) { t.skip('git 不可用'); return; }
  const { root, state } = fx.repo;
  try {
    writeFileSync(join(root, '.gitignore'), '/.workflow/*\n');
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'incidents.jsonl'), '');
    spawnSync('git', ['add', '.gitignore'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, encoding: 'utf8' });
    const SID_RAW = 'session-abc';
    const SID_DIGEST = SHA(SID_RAW);
    const projDigest = projectDigestOf(projectKey(root));
    snapshotBaseline({ stateDir: state, sidDigest: SID_DIGEST, root, gitTimeoutMs: 30_000 });
    const { appendIncident } = await import('../lib/incident-store.mjs');
    const a = appendIncident(root, { id: 'ri-dev349-e2e2', ts: Date.now(), session: SID_RAW, taskId: '内部任务-349', kind: 'tool-failure', digest: 'd000000000000002' });
    assert.equal(a.ok, true);
    const rep = buildWriteReport({ stateDir: state, sidDigest: SID_DIGEST, projDigest, root, taskId: '内部任务-349' });
    assert.equal(rep.rows.some((r) => r.path === '内部工作流状态'), false, 'gitignore 路径不进报表（本仓零噪声）');
    assert.equal(rep.status, 'clean');
  } finally {
    fx.restore();
  }
});
