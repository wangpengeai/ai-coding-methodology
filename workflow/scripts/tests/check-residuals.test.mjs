// 文件：check-residuals.test.mjs
// 描述：残留扫描 lint（check-residuals.mjs）的 TDD 测试——先写测试后写实现，
//       覆盖 B-M2-3/B-M3-3/B-M6-2/内部接口-8 各红线模式与退出码契约。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部用临时目录，不碰真实 skills。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-residuals.mjs');

/**
 * 以子进程方式运行被测脚本——lint 的契约就是 CLI 退出码与 stderr，必须整进程验证。
 * @param {string[]} args CLI 参数
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 建临时目录并在结束时清理——为什么：测试不得污染仓库，也不依赖真实 skills 状态。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'resid-lint-'));
}

test('残留：gstack-foo 命中 → 退出 1，stderr 含 文件:行 与红线标注', () => {
  const dir = tempDir();
  try {
    // 违例放第 3 行，验证行号报告准确
    writeFileSync(join(dir, 'a.md'), '第一行\n第二行\n请运行 gstack-foo 工具\n');
    const r = run([dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.md:3/);
    assert.match(r.stderr, /B-M2-3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('残留：干净目录 → 退出 0 且 stderr 无违例输出', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'clean.md'), '# 正常文档\n\n没有任何旧插件触点的内容。\n');
    const r = run([dir]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('残留：目录不存在 → 退出 2 且 stderr 报错', () => {
  const r = run([join(tmpdir(), 'resid-lint-no-such-dir-9999')]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.length > 0);
});

test('残留：待办标记词边界——TODOS 不命中，TODO 命中（防误伤，同 spec-gate TODO_TOKEN 思路）', () => {
  const dir = tempDir();
  try {
    // 先写 TODOS：词边界后无边界，不应命中
    writeFileSync(join(dir, 'todo.md'), 'We have many TODOS in the backlog.\n');
    assert.equal(run([dir]).status, 0, 'TODOS 不应命中 \\b(TODO|TBD|FIXME)\\b');
    // 再写裸 TODO：必须命中 内部接口-8
    writeFileSync(join(dir, 'todo.md'), 'Fix TODO in parser.\n');
    const r = run([dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /todo\.md:1/);
    assert.match(r.stderr, /IF-COLLAB-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('残留：模板占位符与 jsonl/全局路径——递归子目录也要扫到', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    // 一文件两处违例：占位符（第 1 行）+ jsonl 格式（第 3 行）
    writeFileSync(join(dir, 'docs', 'retro.md'), '嵌入 {{PREAMBLE}} 文本\n第二行\n历史存储 learnings.jsonl\n');
    // 另一文件：~/.gstack 全局路径（B-M6-2）
    writeFileSync(join(dir, 'docs', 'health.md'), '读取 ~/.gstack/metrics 目录\n');
    const r = run([dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /retro\.md:1/);
    assert.match(r.stderr, /retro\.md:3/);
    assert.match(r.stderr, /health\.md:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('残留：跳过 node_modules 与点目录——其中的违例不算', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'x.md'), 'use gstack-foo\n');
    writeFileSync(join(dir, '.hidden', 'y.md'), 'TODO later\n');
    const r = run([dir]);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 内部任务-214 批 1 新增（内部验收-2/内部验收-3/内部验收-2 共享锚）：真仓 workflow 零残留。
test('res1) 真仓 workflow 零残留（gstack/karpathy；codex/greptile/review-log；learnings.jsonl/gstack-retro）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = run([join(ROOT, 'workflow')]);
  assert.equal(r.status, 0, `真仓 workflow 残留扫描须零命中：${r.stderr ?? ''}`);
  const output = `${r.stdout}\n${r.stderr}`;
  for (const marker of ['gstack', 'karpathy', 'codex', 'greptile', 'review-log', 'learnings.jsonl', 'gstack-retro']) {
    assert.ok(!output.includes(marker), `零残留输出不得点名红线模式：${marker}`);
  }
});
