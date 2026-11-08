// 文件：check-plan-design-input.test.mjs
// 描述：设计输入凭据 checker（check-plan-design-input.mjs）的 TDD 测试——覆盖 内部规则-17 契约 C：
//       节形态/角色行三态/证据可定位与哈希/围栏注释跳过/多计划/退出码 2>1>0 优先级。
//       纪律：仅 node: 内置模块；fixture 全部临时目录（不碰真实 docs/plans），证据相对路径以 fixture 为根。
// 作者：wangp  创建：2026-10-20  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-plan-design-input.mjs');

/**
 * 子进程运行被测脚本——checker 的契约就是 CLI 退出码/stdout JSON/stderr，必须整进程验证。
 * @param {string[]} args CLI 参数
 * @param {{cwd?: string}} [opts] 工作目录（证据相对路径解析根）；缺省为 fixture 根
 */
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: opts.cwd });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'plan-di-'));
}

const IMPL_TAIL = [
  '## 文件清单（1 文件）',
  '',
  '| 文件 | 动作 |',
  '|---|---|',
  '| `workflow/scripts/x.mjs` | 新建 |',
  '',
  '## 任务（1 步）',
  '',
  '### 步骤 1：实现',
  '',
  '验收：`node --test "workflow/scripts/tests/x.test.mjs"` → 绿。',
  '',
].join('\n');

const DOC_TAIL = [
  '## 文档变更',
  '',
  '仅调整措辞，无实现面。',
  '',
].join('\n');

/**
 * 构造计划文本。
 * @param {string[]} roleLines `## 设计输入` 节内的行
 * @param {{doc?: boolean, sectionAfterStep?: boolean, extraBefore?: string, duplicateSection?: boolean, h3?: boolean}} [opts]
 */
function planText(roleLines, opts = {}) {
  const fm = '---\nspecRefs: [FR-wf-1]\n---\n\n';
  const title = '# 计划：夹具计划\n\n';
  const heading = opts.h3 ? '### 设计输入' : '## 设计输入';
  const section = heading + '\n\n' + roleLines.join('\n') + '\n\n';
  const tail = opts.doc ? DOC_TAIL : IMPL_TAIL;
  const body = opts.sectionAfterStep ? title + '先写步骤：\n\n### 步骤 1：实现\n\n验收：略。\n\n' + section : title + (opts.extraBefore ?? '') + section;
  const dup = opts.duplicateSection ? '\n' + heading + '\n\n- code-explorer：dup｜x.md｜completed\n\n' : '';
  return fm + body + dup + tail;
}

/** 写一个计划文件（fixture 根下，支持子目录）。 */
function writePlan(dir, rel, text) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 断言 JSON stdout 中某条违规 rule。 */
function violation(r, rule) {
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout 不是 JSON：${r.stdout}/${r.stderr}`);
  }
  assert.equal(data.ok, false);
  return data.plans.flatMap((p) => p.violations).some((v) => v.rule === rule);
}

// ── 合法形态 ────────────────────────────────────────────────────────────────

test('合法：双角色 completed（路径 + 全量 sha256）→ 0', () => {
  const dir = tempDir();
  try {
    const ev = '证据正文\n';
    writeFileSync(join(dir, 'evidence.md'), ev, 'utf8');
    writePlan(dir, 'p.md', planText([
      `- code-explorer：explorer-1｜evidence.md#sha256:${hashOf(ev)}｜completed`,
      `- code-architect：architect-1｜evidence.md#sha256:${hashOf(ev)}｜completed`,
    ]));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：16 位前缀哈希 + 无哈希 → 0', () => {
  const dir = tempDir();
  try {
    const ev = '证据\n';
    writeFileSync(join(dir, 'e.md'), ev, 'utf8');
    writePlan(dir, 'p.md', planText([
      `- code-explorer：a｜e.md#sha256:${hashOf(ev).slice(0, 16)}｜completed`,
      '- code-architect：b｜e.md｜completed',
    ]));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：双 self（含依据与「无等待通道」判断）→ 0', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText([
      '- code-explorer：主会话自评｜依据：已读源码 3 处；无等待通道（工具面无 join/wait）｜self',
      '- code-architect：主会话自评｜依据：设计评审走可等待 teammate；无等待通道不适用｜self',
    ]));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：逐角色 waived（含用户裁决引文与时间）→ 0', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText([
      '- code-explorer：waiver-ref｜用户 2026-10-20「不派实例」｜waived',
      '- code-architect：waiver-ref-2｜用户 2026-10-20「跳过设计评审」｜waived',
    ]));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：纯文档计划单行整体豁免 → 0', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- 设计输入：waived｜纯文档修改，无设计面'], { doc: true }));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：半角 | 分隔符容忍 → 0', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText([
      '- code-explorer：a|e.md|completed',
      '- code-architect：b|e.md|completed',
    ]));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法：CRLF 证据按 LF 归一匹配哈希 → 0', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'a\r\nb\r\n', 'utf8');
    const lfHash = hashOf('a\nb\n');
    writePlan(dir, 'p.md', planText([
      `- code-explorer：a｜e.md#sha256:${lfHash}｜completed`,
      '- code-architect：b｜e.md｜completed',
    ]));
    assert.equal(run(['p.md'], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 节形态 ──────────────────────────────────────────────────────────────────

test('违规：缺节 → missing-section（1）', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', '---\nspecRefs: [FR-wf-1]\n---\n\n# 计划\n\n' + IMPL_TAIL);
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'missing-section'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：仅 ### 设计输入（非 H2）→ missing-section', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜x.md｜completed', '- code-architect：b｜x.md｜completed'], { h3: true }));
    assert.equal(run(['p.md'], { cwd: dir }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：节在首个步骤标题之后 → section-position', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜x.md｜completed', '- code-architect：b｜x.md｜completed'], { sectionAfterStep: true }));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'section-position'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：重复节 → duplicate-section', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜x.md｜completed', '- code-architect：b｜x.md｜completed'], { duplicateSection: true }));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'duplicate-section'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('豁免：围栏内伪节不计（只有围栏伪节 → missing-section）', () => {
  const dir = tempDir();
  try {
    const text = '---\nspecRefs: [FR-wf-1]\n---\n\n# 计划\n\n```md\n## 设计输入\n- code-explorer：a｜x.md｜completed\n```\n\n' + IMPL_TAIL;
    writePlan(dir, 'p.md', text);
    assert.equal(run(['p.md'], { cwd: dir }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('豁免：HTML 注释内伪节不计（只有注释伪节 → missing-section）', () => {
  const dir = tempDir();
  try {
    const text = '---\nspecRefs: [FR-wf-1]\n---\n\n# 计划\n\n<!--\n## 设计输入\n- code-explorer：a｜x.md｜completed\n-->\n\n' + IMPL_TAIL;
    writePlan(dir, 'p.md', text);
    assert.equal(run(['p.md'], { cwd: dir }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 内部任务-348 批 D（内部未决-180⑤ 行号口径）：单源 cleanForParse 为行保形态——frontmatter 与围栏
// 两占位同时进入判别面（S2 门评审发现 5：违规行置于围栏之后，删行实现报偏移行号即红；
// violations.line 与原文件行号对齐；design-input 旧第三份为非行保形态）
test('DEV-348 行号口径：frontmatter 与围栏后的缺字段行报原文件行号（行保占位不偏移）', () => {
  const dir = tempDir();
  try {
    const text = '---\nspecRefs: [FR-wf-1]\n---\n\n# 计划\n\n## 设计输入\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\n- code-explorer：e1｜x.md\n\n' + IMPL_TAIL;
    writePlan(dir, 'p.md', text);
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    const v = JSON.parse(r.stdout).plans[0].violations.find((x) => x.rule === 'invalid-line');
    assert.ok(v, '须报 invalid-line');
    assert.equal(v.line, 14, `角色行在原文件第 14 行（frontmatter 3 行＋围栏 3 行＋空行之后），实际报 ${v.line}（行保口径：占位不偏移）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 角色行/状态/证据 ────────────────────────────────────────────────────────

test('违规：缺 code-architect → missing-role', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜e.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'missing-role'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：重复角色 → duplicate-role', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜e.md｜completed', '- code-explorer：b｜e.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'duplicate-role'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：completed 缺实例 → invalid-instance', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：｜e.md｜completed', '- code-architect：b｜e.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'invalid-instance'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：completed 写「主会话自评」→ status-mismatch', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：主会话自评｜e.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'status-mismatch'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：completed 缺证据 → missing-evidence', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜｜completed', '- code-architect：b｜e.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'missing-evidence'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：self 缺理由 → invalid-evidence', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：主会话自评｜｜self']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'invalid-evidence'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：waived 缺用户引文/时间 → invalid-evidence', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：ref｜｜waived']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'invalid-evidence'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：非法 status（done）→ invalid-status', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜e.md｜done']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'invalid-status'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：字段数不对 → invalid-line', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜e.md']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'invalid-line'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：证据路径不存在 → evidence-missing', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜no-such.md｜completed', '- code-architect：b｜no-such.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'evidence-missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：证据是目录 → evidence-not-file', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'evdir'), { recursive: true });
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜evdir｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'evidence-not-file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：证据空文件 → evidence-empty', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'empty.md'), '', 'utf8');
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜empty.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'evidence-empty'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：../ 越界 / 绝对路径 → evidence-outside-root', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText([
      '- code-explorer：a｜../outside.md｜completed',
      '- code-architect：b｜C:/abs.md｜completed',
    ]));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'evidence-outside-root'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：证据=计划自身 → evidence-self-reference', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- code-explorer：a｜p.md｜completed', '- code-architect：b｜p.md｜completed']));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'evidence-self-reference') || violation(r, 'evidence-missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：哈希失配 → hash-mismatch', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), '正文\n', 'utf8');
    writePlan(dir, 'p.md', planText([`- code-explorer：a｜e.md#sha256:${'0'.repeat(16)}｜completed`]));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'hash-mismatch'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 豁免冲突 ────────────────────────────────────────────────────────────────

test('违规：实现类计划以纯文档为由整体豁免 → waiver-not-allowed', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'p.md', planText(['- 设计输入：waived｜纯文档修改'], { doc: false }));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'waiver-not-allowed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规：整体豁免 + 角色行并存 → waiver-ambiguous', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'p.md', planText(['- 设计输入：waived｜纯文档', '- code-explorer：a｜e.md｜completed'], { doc: true }));
    const r = run(['p.md'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(violation(r, 'waiver-ambiguous'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 退出码优先级 / 多计划 ───────────────────────────────────────────────────

test('工具错误：无参数 → 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.length > 0);
});

test('工具错误：未知 flag → 2', () => {
  const r = run(['--nope']);
  assert.equal(r.status, 2);
});

test('工具错误：计划不存在 → 2', () => {
  const r = run(['no-such-plan-9999.md']);
  assert.equal(r.status, 2);
});

test('优先级：既有违规计划 + 不可读计划 → 2（2>1）', () => {
  const dir = tempDir();
  try {
    writePlan(dir, 'bad.md', '# 无节计划\n\n' + IMPL_TAIL);
    const r = run(['bad.md', 'no-such-plan-9999.md'], { cwd: dir });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多计划：一个违规 → 1，violations 含红文件', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'ok.md', planText(['- code-explorer：a｜e.md｜completed', '- code-architect：b｜e.md｜completed']));
    writePlan(dir, 'bad.md', '# 无节计划\n\n' + IMPL_TAIL);
    const r = run(['ok.md', 'bad.md'], { cwd: dir });
    assert.equal(r.status, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.plans.length, 2);
    assert.ok(data.plans.find((p) => p.file === 'bad.md').ok === false);
    assert.ok(data.plans.find((p) => p.file === 'ok.md').ok === true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多计划：全部合法 → 0', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'e.md'), 'x', 'utf8');
    writePlan(dir, 'a.md', planText(['- code-explorer：a｜e.md｜completed', '- code-architect：b｜e.md｜completed']));
    writePlan(dir, 'b.md', planText(['- code-explorer：c｜e.md｜completed', '- code-architect：d｜e.md｜completed']));
    const r = run(['a.md', 'b.md'], { cwd: dir });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
