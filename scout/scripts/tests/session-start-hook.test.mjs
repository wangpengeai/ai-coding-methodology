// 文件：session-start-hook.test.mjs
// 描述：scout SessionStart 注入 hook（v3，内部决策-031）的 TDD 测试——有效模式注入
//       对应兜底行（explore→spike-run 第 17 行 / disposable→disposable-build 第 18 行）、
//       桥缺席「本地档运行中」提示、事务待恢复提示（mode-lifecycle recover）、过期注入
//       到期检查点三选一、v2 声明迁移提示、静默态分层诊断（内部任务-89，内部决策-044/内部规则-11：
//       无声明＋非治理域 absent 轻提醒/仓内与标记域静默；corrupt/legacy 恒诊断）、空 stdin 照常。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；spawnSync 驱动真实脚本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', 'hooks', 'session-start.mjs');

function future(n) {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 造 v3 单文件声明项目（v3 读取不依赖 .sdd）。 */
function v3Project({ mode, expiry, taskId = '内部任务-1', tx = 'tx-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'),
    JSON.stringify({ schemaVersion: 3, mode, expiry, taskId, transactionId: tx }));
  return root;
}

/**
 * 以子进程运行 hook（stdin 喂宿主负载）。
 * @param {string} projectRoot 项目根（经 ZCODE_PROJECT_DIR 注入）
 * @param {string} [script] hook 脚本路径（桥缺席用例传临时树副本）
 * @param {string} [stdin] 宿主负载；省略=空字符串
 */
function run(projectRoot, script = SCRIPT, stdin = '') {
  const env = { ...process.env, ZCODE_PROJECT_DIR: projectRoot };
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, input: stdin });
  let envelope = null;
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    /* 无注入时应无输出；保持 null 让断言分支 */
  }
  return { status: r.status, envelope, stdout: r.stdout };
}

test('注入：有效 explore 模式 → 含模式/到期日与 spike-run（第 17 行）指向', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  try {
    const r = run(root, SCRIPT, '{}');
    assert.equal(r.status, 0);
    assert.equal(r.envelope?.hookSpecificOutput?.hookEventName, 'SessionStart');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('探路模式'));
    assert.ok(ctx.includes(future(14)));
    assert.ok(ctx.includes('spike-run（第 17 行）'));
    assert.ok(!ctx.includes('disposable-build'), 'explore 模式不得指向 disposable-build 行');
    assert.ok(!ctx.includes('本地档运行中'), '仓库布局桥在场，不得注入缺席提示');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入：有效 disposable 模式 → 指向 disposable-build（第 18 行）', () => {
  const root = v3Project({ mode: 'disposable', expiry: future(14) });
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('disposable-build（第 18 行）'));
    assert.ok(!ctx.includes('spike-run'), 'disposable 模式不得指向 spike-run 行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入：桥缺席（无 spec-gate 同级）→ 追加「本地档运行中」提示', () => {
  // 复制 hooks+scripts 到临时树（无 spec-gate 同级）驱动副本 hook，使 bridgeAvailable=false 可达
  const tree = mkdtempSync(join(tmpdir(), 'scout-notree-'));
  cpSync(resolve(HERE, '..', '..', 'hooks'), join(tree, 'scout', 'hooks'), { recursive: true });
  cpSync(resolve(HERE, '..'), join(tree, 'scout', 'scripts'), { recursive: true });
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  try {
    const r = run(root, join(tree, 'scout', 'hooks', 'session-start.mjs'), '{}');
    assert.equal(r.status, 0);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('spike-run（第 17 行）'), '锚句字面保留（check-routing 锚定）');
    assert.ok(ctx.includes('本地档运行中'), '桥缺席须注入降级提示');
    assert.ok(ctx.includes('毕业不可用'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});

test('注入：事务待恢复（journal 残留）→ 指向 mode-lifecycle recover', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    const pluginRoot = resolve(HERE, '..', '..').replaceAll('\\', '/');
    assert.ok(ctx.includes('事务待恢复'));
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' recover`), `T19 完整命令：${ctx}`);
    assert.ok(ctx.includes(`（项目根 ${root}）`), '验收②：提醒含被评估根路径');
    assert.ok(!ctx.includes('assurance'), 'v3 注入不得再指向 assurance 提供方');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入：过期模式 → 到期检查点三选一（含 mode-lifecycle 命令）且不阻断', () => {
  const root = v3Project({ mode: 'explore', expiry: future(-1) });
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    const pluginRoot = resolve(HERE, '..', '..').replaceAll('\\', '/');
    assert.ok(ctx.includes('到期检查点'));
    assert.ok(ctx.includes('毕业'));
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' renew`), 'T19 renew 完整命令');
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' abandon`), 'T19 abandon 完整命令');
    assert.ok(ctx.includes(`（项目根 ${root}）`), '验收②：提醒含被评估根路径');
    assert.ok(ctx.includes('不阻断'), '内部规则-6：到期只强提醒不阻断');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入：v2 声明待迁移 → 提示 migrate-v2 一键迁移', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'),
    JSON.stringify({ schemaVersion: 2, mode: 'explore', expiry: future(30), taskId: '内部任务-V2', transactionId: 't' }));
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    const pluginRoot = resolve(HERE, '..', '..').replaceAll('\\', '/');
    assert.ok(ctx.includes('v2 声明待迁移'));
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' migrate-v2`), 'T19 migrate 完整命令');
    assert.ok(ctx.includes(`（项目根 ${root}）`), '验收②：提醒含被评估根路径');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('诊断：无声明＋非仓无标记 → absent 轻提醒（R4/内部决策-044；翻转原「零输出」锁死用例）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    const pluginRoot = resolve(HERE, '..', '..').replaceAll('\\', '/');
    assert.ok(ctx.includes('【scout 未开启】'), 'absent 诊断行在场');
    assert.ok(ctx.includes('opt-in'), 'opt-in 指引（内部决策-008）');
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' open --mode explore|disposable`), `T19 完整命令：${ctx}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('静默：无声明＋仓内（.git 祖先）→ 零输出退 0（治理场景零噪声）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('静默：无声明＋非仓但有 .sdd 治理标记（本层）→ 零输出退 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.sdd'), { recursive: true });
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('静默：无声明＋非仓但祖先层有 .sdd 治理标记 → 零输出退 0（判据同构核验，视角一 #2）', () => {
  const home = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(home, '.sdd'), { recursive: true });
  const sub = join(home, 'sub'); // 项目根=标记根的子目录（内部决策-026 标记域形态）
  mkdirSync(sub, { recursive: true });
  try {
    const r = run(sub);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '祖先上溯命中 .sdd → 治理域静默（本层判定实现会误注入即红）');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('诊断：声明损坏（坏 JSON）→ corrupt 诊断行（fail-safe 指引；仓内同样恒输出——双驱动）', () => {
  // 双驱动：非仓＋仓内（.git）——corrupt 恒诊断不分仓（内部决策-044），仓内半边防未来误加 absent 域门控（阶段复审正确性维发现 1）
  for (const withGit of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
    mkdirSync(join(root, '.scout'), { recursive: true });
    if (withGit) mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), '{broken');
    try {
      const r = run(root);
      const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
      assert.ok(ctx.includes('【scout 声明损坏】'), `withGit=${withGit}：corrupt 诊断行恒在场`);
      assert.ok(ctx.includes('按无模式处理'), `withGit=${withGit}：fail-safe 指引在场`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('诊断：v1 legacy 声明 → legacy 诊断行（不指向 migrate-v2；仓内同样恒输出——双驱动）', () => {
  for (const withGit of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
    mkdirSync(join(root, '.scout'), { recursive: true });
    if (withGit) mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify({ mode: 'explore', expiry: future(30) }));
    try {
      const r = run(root);
      const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
      assert.ok(ctx.includes('【scout 旧版声明】'), `withGit=${withGit}`);
      assert.ok(ctx.includes('v1 不支持自动迁移'), `withGit=${withGit}`);
      assert.ok(!ctx.includes('migrate-v2'), 'v1 不得指向 v2 迁移命令（migrate-v2 仅受理 v2 声明）');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('优先级：journal 残留＋声明缺失 → 恒待恢复分支，不触 absent 提醒（分支全序锁定）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('事务待恢复'));
    assert.ok(!ctx.includes('【scout 未开启】'), 'pendingRecovery 优先于 absent 诊断（readStatus 此时 reason=absent 且 pendingRecovery=true）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('优先级：journal 残留＋声明损坏 → 恒待恢复分支，不触 corrupt 诊断（全序交叉点锁定，视角一 #8）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), '{broken');
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  try {
    const r = run(root);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('事务待恢复'));
    assert.ok(!ctx.includes('【scout 声明损坏】'), 'pendingRecovery 优先于 corrupt 诊断（readStatus 此时 reason=corrupt 且 pendingRecovery=true——corrupt 分支被提前即红）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('纪律：空 stdin＋非仓 absent → 诊断照常（无宿主负载依赖，头注纪律保持）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-'));
  try {
    const r = run(root, SCRIPT, '');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('【scout 未开启】'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入：不依赖宿主负载内容——空 stdin 下有效模式仍注入（对照 workflow 注入先例）', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  try {
    const r = run(root, SCRIPT, '');
    assert.ok(r.envelope, '空 stdin 不影响注入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('诊断：声明不可读（mode.json 为目录）→ unreadable 权限/占用处置文案（T17）', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  rmSync(join(root, '.scout', 'mode.json'), { force: true });
  mkdirSync(join(root, '.scout', 'mode.json'), { recursive: true });
  try {
    const r = run(root, SCRIPT, '{}');
    assert.equal(r.status, 0);
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('【scout 声明不可读】'), ctx);
    assert.ok(ctx.includes('EISDIR'), ctx);
    assert.ok(!ctx.includes('【scout 声明损坏】'), 'unreadable 不得误报 corrupt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 步骤 8（T19/T2 文案与命令面）──

test('T19：注入命令含插件根绝对路径 + --project-root 单引号项目根 + 正斜杠', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-t19-'));
  try {
    const r = run(root, SCRIPT, '{}');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    const pluginRoot = resolve(HERE, '..', '..').replaceAll('\\', '/');
    assert.ok(ctx.includes(`node '${pluginRoot}/scripts/mode-lifecycle.mjs' --project-root '${root}' open --mode explore|disposable`), `T19 open 完整命令：${ctx}`);
    assert.ok(!ctx.includes('mode-lifecycle.mjs"'), 'T19 要求单引号包裹（双引号会触发 $/反引号展开）');
    assert.ok(!ctx.includes('node scout/scripts/mode-lifecycle.mjs'), '不得仓库相对硬编码');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('静默：祖先 .git 文件（worktree 形态）→ absent 轻提醒抑制', () => {
  const base = mkdtempSync(join(tmpdir(), 'scout-hook-gitfile-'));
  const root = join(base, 'nested', 'deep');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(base, '.git'), 'gitdir: /tmp/fake-worktree\n');
  try {
    const r = run(root, SCRIPT, '{}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '静默须无输出（排除 fail-open 异常静默）');
    assert.equal(r.envelope, null, '祖先 .git 文件形态应抑制 absent 轻提醒');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('静默：祖先 .scout/mode.json → absent 轻提醒抑制', () => {
  const base = mkdtempSync(join(tmpdir(), 'scout-hook-ancmode-'));
  const root = join(base, 'nested', 'deep');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(base, '.scout'), { recursive: true });
  writeFileSync(join(base, '.scout', 'mode.json'), JSON.stringify({ schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: 'TASK-A', transactionId: 't' }));
  try {
    const r = run(root, SCRIPT, '{}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '静默须无输出（排除 fail-open 异常静默）');
    assert.equal(r.envelope, null, '祖先 .scout/mode.json 应抑制 absent 轻提醒');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('T19：诊断文案含被评估根路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-hook-root-'));
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), 'not-json');
  try {
    const r = run(root, SCRIPT, '{}');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes(root), `诊断须含被评估根路径：${ctx}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T2：journalCorrupt 追加行（valid 模式行保留、仅一次）', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.corrupt-20260101T000000Z.json'), '{}');
  try {
    const r = run(root, SCRIPT, '{}');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('【scout 探路模式】'), 'journal 行不得替换模式行');
    const hits = ctx.split('【scout journal 损坏备份待处理】').length - 1;
    assert.equal(hits, 1, `journal 行须仅出现一次：${ctx}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T2：pendingRecovery + journalCorrupt → 两行并存（交互）', () => {
  const root = v3Project({ mode: 'explore', expiry: future(14) });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  writeFileSync(join(root, '.scout', 'transactions', 'journal.corrupt-20260101T000000Z.json'), '{}');
  try {
    const r = run(root, SCRIPT, '{}');
    const ctx = r.envelope?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('【scout 事务待恢复】'), ctx);
    assert.ok(ctx.includes('【scout journal 损坏备份待处理】'), ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
