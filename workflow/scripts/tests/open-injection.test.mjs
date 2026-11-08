// 文件：open-injection.test.mjs
// 描述：OPEN 机械预筛注入＋存量提醒位（内部任务-57/内部规则-22，内部接口-8 v3 §7.1/§7.2）行为测试
//       ——子进程驱动真实钩＋tmp 夹具仓（含 内部规格）：命中注入/哨位只提示/
//       会话内一次节流（命中才置位）/无命中不注入且不置位/委派跳过/坏册 fail-open/
//       session-start 超阈值提醒与帧序。
// 作者：wangp  创建：2026-10-17  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；不 mock 被测脚本本体。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPROMPT = resolve(HERE, '..', '..', 'hooks', 'user-prompt.mjs');
const SSTART = resolve(HERE, '..', '..', 'hooks', 'session-start.mjs');

/** 夹具仓：带 .git 与 内部规格（六列）。 */
function fixtureRepo(rows) {
  const d = mkdtempSync(join(tmpdir(), 'oinj-repo-'));
  mkdirSync(join(d, '.git'));
  mkdirSync(join(d, 'specs'));
  writeFileSync(
    join(d, 'specs', 'open-items.md'),
    '---\ndocumentType: open-item-register\nvalidationMode: draft\n---\n\n# 未决项登记（OPEN-n）\n\n' +
      '| 编号 | 描述 | 类型 | 状态 | 提出日期 | 阻塞性 |\n|---|---|---|---|---|---|\n' +
      rows.join('\n') +
      '\n',
    'utf8',
  );
  process.on('exit', () => rmSync(d, { recursive: true, force: true }));
  return d;
}

function runUprompt(payload, opts = {}) {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'oinj-state-'));
  const env = {
    ...process.env,
    ZCODE_PROJECT_DIR: '',
    WF_UPROMPT_STATE_DIR: stateDir,
    WF_UPROMPT_COOLDOWN_MS: '3600000',
    WF_ROUTING_STATE_DIR: join(stateDir, 'lease'),
    WF_GUARD_LOG_PATH: join(stateDir, 'no-guard.jsonl'),
    WF_INCIDENT_ROOT: stateDir,
  };
  const r = spawnSync(process.execPath, [UPROMPT], { input: payload, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout ?? '' };
}

test('内部任务-57 预筛：命中注入一行（含编号与截断描述），哨位项只提示触发条件', () => {
  const repo = fixtureRepo([
    '| 内部未决-9001 | zcode-adapter install 备份无清理路径（.bak 累积） | 缺陷 | OPEN | 2026-10-14 | non-blocking |',
    '| 内部未决-9002 | kimi 签名取证 | 机制设计 | OPEN | 2026-10-16 | non-blocking（延后——等触发条件） |',
    '| 内部未决-9003 | 无关条目锚词 mismatchmark | 技术核实 | OPEN | 2026-10-17 | non-blocking |',
  ]);
  const r = runUprompt(JSON.stringify({ session_id: 's-oinj1', cwd: repo, prompt: '处理 zcode-adapter 的备份清理和 kimi 签名' }));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('【OPEN 候选】'), '命中注入候选行');
  assert.ok(r.stdout.includes('内部未决-9001'), '非哨位命中列编号');
  assert.ok(r.stdout.includes('哨位项，触发条件见登记册'), '哨位项（内部未决-9002 延后）只提示不催办');
  assert.ok(!r.stdout.includes('内部未决-9003'), '无关节未列入');
});

test('内部任务-57 预筛节流：命中后会话内一次（第二条同消息不再注入）', () => {
  const repo = fixtureRepo(['| 内部未决-9001 | zcode-adapter 备份清理 | 缺陷 | OPEN | 2026-10-14 | non-blocking |']);
  const stateDir = mkdtempSync(join(tmpdir(), 'oinj-st-'));
  try {
    const p = JSON.stringify({ session_id: 's-oinj2', cwd: repo, prompt: 'zcode-adapter 备份' });
    const r1 = runUprompt(p, { stateDir });
    const r2 = runUprompt(p, { stateDir });
    assert.ok(r1.stdout.includes('【OPEN 候选】'), '首条命中注入');
    assert.ok(!r2.stdout.includes('【OPEN 候选】'), '第二条不再注入（openScanShown）');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-244 P05 预筛：无命中亦置位（会话内一次性扫描）＋册 mtime 缓存＋坏册/缺册 fail-open', () => {
  const repo = fixtureRepo(['| 内部未决-9001 | zcode-adapter 备份清理 | 缺陷 | OPEN | 2026-10-14 | non-blocking |']);
  const stateDir = mkdtempSync(join(tmpdir(), 'oinj-st2-'));
  try {
    const miss = runUprompt(JSON.stringify({ session_id: 's-oinj3', cwd: repo, prompt: '完全不相关的消息锚词 nothinghere' }), { stateDir });
    assert.ok(!miss.stdout.includes('【OPEN 候选】'), '无命中零输出');
    // P05：命中与否都置位——同会话后续消息不再扫描/注入（会话内一次性）
    const same = runUprompt(JSON.stringify({ session_id: 's-oinj3', cwd: repo, prompt: 'zcode-adapter' }), { stateDir });
    assert.ok(!same.stdout.includes('【OPEN 候选】'), '无命中已置位——同会话后续消息不再注入');
    // 新会话：册未变 → 预筛仍生效（扫描缓存不改变结论）
    const hit = runUprompt(JSON.stringify({ session_id: 's-oinj3b', cwd: repo, prompt: 'zcode-adapter' }), { stateDir });
    assert.ok(hit.stdout.includes('【OPEN 候选】'), '新会话命中仍注入');
    assert.ok(existsSync(join(stateDir, 'wf-open-items-cache.json')), '册扫描缓存落状态根（mtime/size 键）');
    // 坏册：覆盖为乱文（mtime 变化 → 缓存失效重扫）→ 新会话不炸不注入
    writeFileSync(join(repo, 'specs', 'open-items.md'), 'not a table at all\n', 'utf8');
    const bad = runUprompt(JSON.stringify({ session_id: 's-oinj4', cwd: repo, prompt: 'zcode-adapter' }), { stateDir });
    assert.equal(bad.status, 0);
    assert.ok(!bad.stdout.includes('【OPEN 候选】'), '坏册 fail-open 零输出');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('内部任务-57 预筛：委派会话跳过（delegation_depth>1 形态）', () => {
  const repo = fixtureRepo(['| 内部未决-9001 | zcode-adapter 备份清理 | 缺陷 | OPEN | 2026-10-14 | non-blocking |']);
  const r = runUprompt(JSON.stringify({ session_id: 's-oinj5', cwd: repo, delegation_depth: 2, prompt: 'zcode-adapter 备份' }));
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('【OPEN 候选】'), '委派收窄面跳过注入');
});

test('内部任务-57 存量提醒：已关全文 >50 注入（帧序＝scout 后/warn 前）；真实仓（0）不注入', () => {
  const over = fixtureRepo(
    Array.from({ length: 51 }, (_, i) => `| OPEN-${9100 + i} | 已关闭全文第 ${i} 条无指针 | 决策 | CLOSED | 2026-09-0${(i % 9) + 1} | 曾 non-blocking——已解除 |`),
  );
  const mkRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'oinj-sroot-'));
    mkdirSync(join(root, 'skills', 'workflow'), { recursive: true });
    writeFileSync(join(root, 'skills', 'workflow', 'SKILL.md'), '# meta\n', 'utf8');
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
    return root;
  };
  const runStart = (cwd, root) => {
    const env = { ...process.env, ZCODE_PLUGIN_ROOT: root, WF_ROUTING_STATE_DIR: join(root, 'st'), WF_INCIDENT_ROOT: join(root, 'ir') };
    const r = spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    return ctx;
  };
  const ctxOver = runStart(over, mkRoot());
  assert.ok(ctxOver.includes('超阈值 50'), '51 条已关全文注入提醒');
  assert.ok(ctxOver.includes('定期梳理'), '提醒指向梳理判据');
  // 帧序可达断言（检查点①发现 1 处置）：正文＜存量提醒＜自检告警（warn 本夹具缺席，断言与正文次序）
  assert.ok(ctxOver.indexOf('# meta') < ctxOver.indexOf('超阈值 50'), '存量提醒在正文之后');
  // 真实仓（本仓 closedFullText=0）不注入
  const realRoot = mkRoot();
  const ctxReal = runStart(resolve(HERE, '..', '..', '..'), realRoot);
  assert.ok(!ctxReal.includes('超阈值 50'), '真实仓全墓碑化（0 条）不注入');
});

// ── 内部任务-244 S04：OPEN 候选注入行剥控制字符并限长（防控制序列/超长文本进模型上下文） ──

test('内部任务-244 S04：OPEN 候选行剥控制字符并限长', () => {
  const repo = fixtureRepo([
    `| 内部未决-9101 | adhoc\u001b[31m 关键注入词 mark9 ${'x'.repeat(80)} | 缺陷 | OPEN | 2026-10-14 | non-blocking |`,
  ]);
  const r = runUprompt(JSON.stringify({ session_id: 's-oinj-s04', cwd: repo, prompt: '处理 adhoc 相关事项' }));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('【OPEN 候选】'), '命中注入候选行');
  assert.ok(!r.stdout.includes('\u001b'), 'ESC 控制字符被剥除');
  assert.ok(!r.stdout.includes('x'.repeat(60)), '描述被截断（≤40 字符），超长文本不整段注入');
});

// ── 内部任务-244 遗留项①：册扫描缓存不得跨仓误用（路径键 + schema/形态校验） ──

test('内部任务-244 遗留：同 mtime/size 跨仓册不得复用缓存（路径键生效）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'oinj-cache-x-'));
  try {
    const repoA = fixtureRepo(['| 内部未决-9301 | alphaunique-token-x | 缺陷 | OPEN | 2026-10-14 | non-blocking |']);
    const repoB = fixtureRepo(['| 内部未决-9402 | betaunique-token-y | 缺陷 | OPEN | 2026-10-14 | non-blocking |']);
    const a = runUprompt(JSON.stringify({ session_id: 's-cache-a', cwd: repoA, prompt: '处理 alphaunique 事项' }), { stateDir });
    assert.ok(a.stdout.includes('内部未决-9301'), 'A 仓候选注入');
    const cachePath = join(stateDir, 'wf-open-items-cache.json');
    assert.ok(existsSync(cachePath), '册扫描缓存落盘');
    // 把 B 册 mtime/size 与 A 对齐（同 stat 不同内容）：旧实现会复用 A 的解析结果
    const aStat = statSync(join(repoA, 'specs', 'open-items.md'));
    utimesSync(join(repoB, 'specs', 'open-items.md'), aStat.atime, aStat.mtime);
    const b = runUprompt(JSON.stringify({ session_id: 's-cache-b', cwd: repoB, prompt: '处理 betaunique 事项' }), { stateDir });
    assert.ok(b.stdout.includes('内部未决-9402'), 'B 仓同 stat 册须重扫并注入自身条目（不得复用 A 缓存）');
    assert.ok(!b.stdout.includes('内部未决-9301'), '不得把 A 仓条目注入 B 仓上下文');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
