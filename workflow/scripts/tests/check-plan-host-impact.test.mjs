// 文件：check-plan-host-impact.test.mjs
// 描述：check-plan-host-impact.mjs 用例矩阵（内部任务-199 批 2 步骤 A1；19 用例，RED→GREEN）。
//       夹具为零依赖临时目录：计划/证据/步骤标题按 C-1 契约构造，checker 以子进程驱动。
// 作者：wangp  创建：2026-10-22  版权：MIT（见仓库 LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = fileURLToPath(new URL('../check-plan-host-impact.mjs', import.meta.url));
const STEP = '### 步骤 1：实施\n\n验收：`node -v` 退出 0。\n';
const H2 = '## 多宿主适配评估\n';

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'host-impact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: 'utf8' });
}

function parse(stdout) {
  return JSON.parse(stdout);
}

function writePlan(root, { section = '', stepFirst = false, name = 'plan.md', body = '' } = {}) {
  const parts = ['# 计划：夹具\n\n'];
  if (stepFirst) parts.push(STEP, '\n');
  if (section !== null) parts.push(H2, '\n', section, '\n');
  if (!stepFirst) parts.push(STEP);
  parts.push(body);
  const file = join(root, name);
  writeFileSync(file, parts.join(''), 'utf8');
  return file;
}

function writeEvidence(root) {
  writeFileSync(join(root, 'evidence.md'), 'evidence\n', 'utf8');
}

function rulesOf(result) {
  return parse(result.stdout).plans[0].violations.map((v) => v.rule);
}

test('合法：四状态各一（4 计划全部 exit 0）＋带括注 H2 容差正例', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const rows = [
    '- 宿主A：已适配并真机验证｜evidence.md',
    '- 宿主A：已适配未真机验证｜evidence.md',
    '- 宿主A：本批不适用｜理由：无宿主适配语义',
    '- 宿主A：无验证条件｜理由：本批无宿主侧行为变化',
  ];
  rows.forEach((row, i) => {
    const file = writePlan(root, { section: `${row}\n`, name: `p${i}.md` });
    const r = run([file], root);
    assert.equal(r.status, 0, `${row} 应通过：${r.stderr}`);
  });
  // 带括注 H2 容差（C-1 未写容差；本计划自身标题即带括注——CEO round4 执行注意 #4）
  writeFileSync(
    join(root, 'paren.md'),
    `# 计划：夹具\n\n## 多宿主适配评估（内部决策-056 格式契约第 8 条）\n\n- 宿主A：本批不适用｜理由：x\n\n${STEP}`,
    'utf8',
  );
  const rp = run([join(root, 'paren.md')], root);
  assert.equal(rp.status, 0, `带括注 H2 应容差通过：${rp.stderr}`);
});

test('缺节：无 H2 → missing-section 且 exit 1', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: null });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('missing-section'));
});

test('H3 伪节不算节 → missing-section', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: null, body: '### 多宿主适配评估\n\n- 宿主A：本批不适用｜理由：x\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('missing-section'));
});

test('重复 H2 → duplicate-section', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：本批不适用｜理由：x\n\n## 多宿主适配评估\n\n- 宿主B：本批不适用｜理由：y\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('duplicate-section'));
});

test('节位在首个步骤标题之后 → section-position（步骤/任务两种标题形态）', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：本批不适用｜理由：x\n', stepFirst: true });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('section-position'));
  // 任务标题形态（仓内权威 STEP_HEADING 含「任务」——f1 阻塞 #1 回归钉）
  const taskPlan = join(root, 'task.md');
  writeFileSync(taskPlan, `# 计划：夹具\n\n## 任务 1：实施\n\n验收：\`node -v\` 退出 0。\n\n${H2}\n- 宿主A：本批不适用｜理由：x\n`, 'utf8');
  const rt = run([taskPlan], root);
  assert.equal(rt.status, 1);
  assert.ok(rulesOf(rt).includes('section-position'), '任务标题须被识别为步骤标题');
  // 内部任务-348/内部未决-180③ 新门判别（负向）：日期起首标题不判步骤——旧门裸 \d 会把 `## 2026-…`
  // 当首个步骤锚点触发 section-position 误报（S2 门评审发现 3 补判别；回退旧门即红）
  const datePlan = join(root, 'date.md');
  writeFileSync(datePlan, `# 计划：夹具\n\n## 2026-11-07 日期起首标题\n\n叙事行。\n\n${H2}\n- 宿主A：本批不适用｜理由：x\n\n${STEP}`, 'utf8');
  const rd = run([datePlan], root);
  assert.equal(rd.status, 0, `日期起首标题不判步骤、节位合法须 exit 0：${rd.stdout}`);
});

test('空节（仅 H2）→ empty-section', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('empty-section'));
});

test('闭集外状态词 → invalid-status（含前两态带尾随括注）', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：已适配｜evidence.md\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('invalid-status'));
  // 前两态不接受尾随括注（f1 delta 非阻塞 #1 回归钉）
  const paren = writePlan(root, { section: '- 宿主A：已适配并真机验证（x）｜evidence.md\n', name: 'strict-paren.md' });
  const rp = run([paren], root);
  assert.equal(rp.status, 1);
  assert.deepEqual(rulesOf(rp), ['invalid-status']);
});

test('字段数≠3 → invalid-line（2 字段与 4 字段双向，规则集精确）', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const two = writePlan(root, { section: '- 宿主A：本批不适用\n', name: 'two.md' });
  const r2 = run([two], root);
  assert.equal(r2.status, 1);
  assert.deepEqual(rulesOf(r2), ['invalid-line']);
  const four = writePlan(root, { section: '- 宿主A：本批不适用｜理由：x｜备注\n', name: 'four.md' });
  const r4 = run([four], root);
  assert.equal(r4.status, 1);
  assert.deepEqual(rulesOf(r4), ['invalid-line'], '4 字段（多余竖线）须判 invalid-line');
  // 规则集结构断言（A1⑱ 口径；f1 delta 非阻塞 #4）：多违规时规则集精确可证伪
  const mixed = writePlan(root, {
    section: '- 宿主A：本批不适用｜理由：x｜备注\n- 宿主A：已适配｜evidence.md\n',
    name: 'mixed.md',
  });
  const rm = run([mixed], root);
  assert.equal(rm.status, 1);
  assert.deepEqual(rulesOf(rm), ['invalid-line', 'invalid-status']);
});

test('前两态证据不可定位 → invalid-evidence', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：已适配未真机验证｜missing.md\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('invalid-evidence'));
});

test('证据 #sha256 失配 → invalid-evidence', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：已适配未真机验证｜evidence.md#sha256:0000000000000000\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('invalid-evidence'));
});

test('负态理由 <4 字 → invalid-evidence', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 宿主A：本批不适用｜好\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('invalid-evidence'));
});

test('豁免理由为空 → invalid-evidence', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 多宿主适配评估：整体豁免｜\n' });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('invalid-evidence'));
});

test('实现类计划用整体豁免 → waiver-not-allowed', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, {
    section: '- 多宿主适配评估：整体豁免｜理由：纯文档\n',
    body: '涉及 workflow/skills/workflow/SKILL.md 的文本修改。\n',
  });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('waiver-not-allowed'));
});

test('纯文档计划 + 豁免理由非空 → exit 0', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, { section: '- 多宿主适配评估：整体豁免｜理由：纯文档计划无宿主面\n' });
  const r = run([file], root);
  assert.equal(r.status, 0, r.stderr);
});

test('豁免行与评估行并存 → waiver-ambiguous', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, {
    section: '- 宿主A：本批不适用｜理由：x\n- 多宿主适配评估：整体豁免｜理由：y\n',
  });
  const r = run([file], root);
  assert.equal(r.status, 1);
  assert.ok(rulesOf(r).includes('waiver-ambiguous'));
});

test('0 参数 → exit 2', (t) => {
  const root = makeRoot(t);
  const r = run([], root);
  assert.equal(r.status, 2);
});

test('计划不存在 → exit 2', (t) => {
  const root = makeRoot(t);
  const r = run(['missing.md'], root);
  assert.equal(r.status, 2);
});

test('多计划混合：一过一违规 → exit 1 且 plans 两条', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const ok = writePlan(root, { section: '- 宿主A：本批不适用｜理由：x\n', name: 'ok.md' });
  const bad = writePlan(root, { section: '- 宿主A：已适配｜evidence.md\n', name: 'bad.md' });
  const r = run([ok, bad], root);
  assert.equal(r.status, 1);
  const out = parse(r.stdout);
  assert.equal(out.plans.length, 2);
  assert.equal(out.plans.find((p) => p.file.endsWith('ok.md')).ok, true);
  assert.equal(out.plans.find((p) => p.file.endsWith('bad.md')).ok, false);
});

test('对象轴：宿主行与功能面行混合合法 → exit 0', (t) => {
  const root = makeRoot(t);
  writeEvidence(root);
  const file = writePlan(root, {
    section: '- 宿主A：本批不适用｜理由：x\n- 功能面B（校验器）：本批不适用｜理由：y\n',
  });
  const r = run([file], root);
  assert.equal(r.status, 0, r.stderr);
});
