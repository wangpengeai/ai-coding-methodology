// 文件：plan-review-binding.test.mjs
// 描述：plan-review sidecar v2/v3 凭据绑定测试（内部决策-007 / 内部规则-10 / 内部规则-16）——显式计划、
//       当前哈希、taskId 一致才放行；v3 另校轮次/链身份/前轮档；陈旧/无关/legacy/越界一律拒绝。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyReviewedPlan, planSha256, planChangeSurface } from '../../hooks/routing-lib.mjs';

/** 计划内容的 LF 哈希（与 assurance revision.py 同语义）。 */
function lfHash(text) {
  return `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')}`;
}

/** 构造带一份计划 + 可选 sidecar 的临时项目。 */
function fixture({ planText = '# 计划正文\n', sidecar = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wf-planbind-'));
  const proj = join(home, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'plans', 'feat.md'), planText);
  if (sidecar !== null) writeFileSync(join(proj, 'docs', 'plans', 'feat-review.md'), sidecar);
  return {
    proj,
    planRel: '内部计划',
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 生成合法 v2 sidecar 文本（ratify=true 时 frontmatter 追加宿主追认档标记行；
 *  listPrefix=true 时结论行渲染为列表形——形态误写用例的唯一出口。
 *  includeReviewFields=false 用于锁「三评审字段是新凭据必填」的拒绝面。 */
function v2Sidecar({
  taskId = '内部任务-1', planRel = '内部计划', planText = '# 计划正文\n',
  pass = true, ratify = false, ratifyValue = 'host-plan', specRefs = false, listPrefix = false,
  includeReviewFields = true, includeReviewInstances = true,
  reviewMode = null, reviewInstances = null, reviewReason = null,
} = {}) {
  const mode = reviewMode ?? (ratify ? 'ratified' : 'self');
  const instances = reviewInstances ?? (mode === 'independent' ? 2 : mode === 'mixed' ? 1 : 0);
  const reason = reviewReason ?? (
    mode === 'independent' ? '工程/CEO 各由 fresh-context 实例执行'
      : mode === 'ratified' ? '宿主批准（测试夹具）'
        : '小计划自评（测试夹具）'
  );
  const fm = [
    '---',
    'schemaVersion: 2',
    `taskId: ${taskId}`,
    `planPath: ${planRel}`,
    `planSha256: ${lfHash(planText)}`,
    'reviewedAt: 2026-09-13T00:00:00+08:00',
    ...(includeReviewFields ? [
      `reviewMode: ${mode}`,
      ...(includeReviewInstances ? [`reviewInstances: ${instances}`] : []),
      `reviewReason: "${reason}"`,
    ] : []),
    ...(ratify ? [`ratify: ${ratifyValue}`] : []),
    ...(specRefs ? ['specRefs: [内部需求-1, 内部决策-007]'] : []), // 内部未决-9 同源追溯容忍字段
    '---',
    '',
  ].join('\n');
  const verdict = `${pass ? '通过' : '不通过'}`;
  return listPrefix ? `${fm}- 结论：${verdict}\n` : `${fm}结论：${verdict}\n`;
}

/** 生成 v3 sidecar（内部任务-191：reviewRound + reviewProvenance；独立/mixed 强制形态）。
 *  provenance 条目缺省为 instances 枚 fresh 同链实例；可通过 provenance 覆盖构造负例。
 *  A9（内部任务-193）：ratify/ratifyValue/extraFrontmatter 必须真写进 frontmatter——旧的
 *  「内部决策-020 容忍」用例通过 v2 helper 传 ratify 但 v3 路径静默丢弃，用例是空载的。 */
function v3Sidecar({
  taskId = '内部任务-1', planRel = '内部计划', planText = '# 计划正文\n',
  mode = 'independent', instances = 2, round = 1, provenance = null, pass = true,
  reason = null, omitRound = false, omitProvenance = false, rawProvenance = null,
  ratify = false, ratifyValue = 'host-plan', extraFrontmatter = [],
} = {}) {
  const chain = `plan:${planRel}`;
  const safeCount = Number.isSafeInteger(instances) && instances >= 0 && instances <= 1000 ? instances : 0;
  const entries = provenance ?? Array.from({ length: safeCount }, (_, i) => ({
    role: i === 0 ? 'engineering' : `role-${i + 1}`,
    instance: `inst-${i + 1}`,
    chain,
    state: 'fresh',
  }));
  const fm = [
    '---',
    'schemaVersion: 3',
    `taskId: ${taskId}`,
    `planPath: ${planRel}`,
    `planSha256: ${lfHash(planText)}`,
    'reviewedAt: 2026-10-21T00:00:00+08:00',
    `reviewMode: ${mode}`,
    `reviewInstances: ${instances}`,
    `reviewReason: "${reason ?? 'v3 夹具：工程/CEO 各 fresh'}"`,
    ...(omitRound ? [] : [`reviewRound: ${round}`]),
    ...(omitProvenance ? [] : [`reviewProvenance: ${rawProvenance ?? JSON.stringify(entries)}`]),
    ...(ratify ? [`ratify: ${ratifyValue}`] : []),
    ...extraFrontmatter,
    '---',
    '',
  ].join('\n');
  return `${fm}结论：${pass ? '通过' : '不通过'}\n`;
}

/** 生成可变规模的计划文本：steps 个步骤标题 + 可选文件级清单/代码围栏。 */
function sizedPlan({ steps = 0, files = [], includeFileList = true, fence = false } = {}) {
  const lines = ['---', 'specRefs: [内部需求-1]', '---', '# 规模计划', ''];
  if (fence) lines.push('```js', '### 步骤 99：围栏内的假步骤', '| 1 | `src/fenced.mjs` | 新建 | 职责 |', '```', '');
  for (let i = 1; i <= steps; i += 1) {
    lines.push(`### 步骤 ${i}：做第 ${i} 件事`, '', '验收：命令退出 0', '');
  }
  if (includeFileList) {
    lines.push('## 文件清单（文件级）', '', '| # | 文件 | 动作 | 职责 |', '|---|---|---|---|');
    files.forEach((f, i) => {
      const path = typeof f === 'string' ? f : f.path;
      const action = typeof f === 'string' ? '改' : (f.action ?? '改');
      lines.push(`| ${i + 1} | \`${path}\` | ${action} | 职责 |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

test('合法 v2 sidecar：哈希与 taskId 一致且结论通过 → 放行', () => {
  const f = fixture({ sidecar: v2Sidecar() });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true);
    assert.equal(r.planSha256, lfHash('# 计划正文\n'));
  } finally {
    f.cleanup();
  }
});

test('评审后计划改一字 → 拒绝（哈希失配）', () => {
  const f = fixture({ sidecar: v2Sidecar() });
  try {
    writeFileSync(join(f.proj, f.planRel), '# 计划正文改\n');
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /哈希/);
  } finally {
    f.cleanup();
  }
});

test('仓库中其他计划的通过记录不构成本计划凭据', () => {
  const f = fixture({ sidecar: v2Sidecar({ planRel: '内部计划', planText: '# 计划正文\n' }) });
  try {
    // 另一份计划 other.md 与其通过 sidecar——feat.md 声明不得被其放行
    writeFileSync(join(f.proj, 'docs', 'plans', 'other.md'), '# 其他计划\n');
    writeFileSync(join(f.proj, 'docs', 'plans', 'other-review.md'), v2Sidecar({ planRel: '内部计划', planText: '# 其他计划\n' }));
    const r = verifyReviewedPlan(f.proj, '内部计划', '内部任务-1');
    // 目标计划不存在 → 拒绝
    assert.equal(r.ok, false);
  } finally {
    f.cleanup();
  }
});

test('sidecar taskId 与声明 taskId 不一致 → 拒绝', () => {
  const f = fixture({ sidecar: v2Sidecar({ taskId: '内部任务-9' }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /taskId/);
  } finally {
    f.cleanup();
  }
});

test('sidecar planPath 与实际计划不一致 → 拒绝', () => {
  const planText = '# 计划正文\n';
  const fm = [
    '---', 'schemaVersion: 2', 'taskId: 内部任务-1', 'planPath: 内部计划',
    `planSha256: ${lfHash(planText)}`, 'reviewedAt: 2026-09-13T00:00:00+08:00',
    'reviewMode: self', 'reviewInstances: 0', 'reviewReason: "planPath 不一致夹具"', '---', '',
  ].join('\n');
  const f = fixture({ sidecar: `${fm}结论：通过\n` });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /planPath/);
  } finally {
    f.cleanup();
  }
});

test('路径越界（../ 与绝对路径）→ 拒绝', () => {
  const f = fixture({ sidecar: v2Sidecar() });
  try {
    assert.equal(verifyReviewedPlan(f.proj, '../escape.md', '内部任务-1').ok, false);
    assert.equal(verifyReviewedPlan(f.proj, '/etc/passwd', '内部任务-1').ok, false);
  } finally {
    f.cleanup();
  }
});

test('legacy sidecar（无 frontmatter 哈希）→ 拒绝并提示迁移', () => {
  const f = fixture({ sidecar: '# 评审记录\n\n结论：通过\n' });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /legacy|迁移/);
  } finally {
    f.cleanup();
  }
});

test('结论不通过 → 拒绝（即使哈希正确）', () => {
  const f = fixture({ sidecar: v2Sidecar({ pass: false }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /不通过|结论/);
  } finally {
    f.cleanup();
  }
});

// 用法修正批次（2026-09-16，内部任务-USAGEFIX-1）：plan-review 模板曾把结论渲染为
// 列表项，照抄产生「- 结论：通过」不命中行首锚定——拒因必须指认形态错误与修法，
// 否则用户面对笼统的「评审结论非通过」无法自纠（内部规则-8 契约的可用性兜底）。
test('列表形结论行（- 结论：通过）→ 拒因指明列表前缀与顶格要求', () => {
  const f = fixture({ sidecar: v2Sidecar({ listPrefix: true }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /列表前缀/);
    assert.match(r.reason ?? '', /顶格独占/);
  } finally {
    f.cleanup();
  }
});

// 三维评审正确性维处置：顶格「结论：不通过」为实质拒因时，正文引述列表形结论行
// 不得把拒因覆盖为形态诊断（误诊修法方向）。
test('顶格不通过 + 正文引述列表形结论行 → 拒因保持「非通过」而非形态诊断', () => {
  const quoted = `${v2Sidecar({ pass: false })}- 结论：通过（上次记录）\n`;
  const f = fixture({ sidecar: quoted });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.reason ?? '', /列表前缀/);
    assert.match(r.reason ?? '', /不通过|结论/);
  } finally {
    f.cleanup();
  }
});

test('无 sidecar / 计划不存在 → 拒绝', () => {
  const f = fixture({ sidecar: null });
  try {
    assert.equal(verifyReviewedPlan(f.proj, f.planRel, '内部任务-1').ok, false);
    assert.equal(verifyReviewedPlan(f.proj, '内部计划', '内部任务-1').ok, false);
  } finally {
    f.cleanup();
  }
});

test('planSha256 输出与 assurance 口径一致（LF 规范化）', () => {
  const f = fixture({ planText: '---\r\nspecRefs: [内部需求-1]\r\n---\r\n# P\r\n' });
  try {
    // CRLF 计划的哈希必须等于手工 LF 版本（与 assurance/revision.py 同语义）
    const manual = lfHash('---\nspecRefs: [内部需求-1]\n---\n# P\n');
    assert.equal(planSha256(join(f.proj, f.planRel)), manual);
  } finally {
    f.cleanup();
  }
});

// ── 宿主追认档容忍性锁死（内部决策-020 / 内部规则-10 扩充，Phase 5.1）──
// 追认档凭据 = 标准 v2 sidecar + frontmatter 增 ratify: host-plan 行；凭据判定
// （verifyReviewedPlan）对该字段零感知——未知 frontmatter 字段被容忍、四字段与
// 结论行契约不因追认标记改变。零改动设计，以下两用例是既有容忍行为的回归锁：
// 前者锁「追认档凭据与标准档同等放行」，后者锁「追认标记不豁免结论行契约」。

test('宿主追认档（ratify: host-plan）v2 sidecar：四字段齐备且结论通过 → 放行', () => {
  const f = fixture({ sidecar: v2Sidecar({ ratify: true }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true, 'ratify 字段不得破坏凭据判定（追认档与标准档同等放行）');
    assert.equal(r.planSha256, lfHash('# 计划正文\n'));
  } finally {
    f.cleanup();
  }
});

test('ratify sidecar 但正文结论不通过 → 仍拒（追认标记不豁免结论行契约）', () => {
  const f = fixture({ sidecar: v2Sidecar({ ratify: true, pass: false }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /不通过|结论/);
  } finally {
    f.cleanup();
  }
});

// 内部未决-9 批次（2026-09-15）：sidecar 携带 specRefs 同源追溯字段（供 core plan 批量扫描）
// ——与 ratify 同类的非凭据容忍字段，verifyReviewedPlan 零感知。
test('specRefs 同源追溯字段（内部未决-9）：sidecar 凭据判定不受影响 → 放行', () => {
  const f = fixture({ sidecar: v2Sidecar({ specRefs: true }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true, 'specRefs 字段不得破坏凭据判定（同源追溯容忍）');
  } finally {
    f.cleanup();
  }
});

// ── P1 序列形态（2026-10-10 内部任务-29 / 内部任务-103 P1；内部规则-10 扩）──
// 多轮评审的两种存量布局都须可声明：canonical=旧哈希不通过 + review2=现哈希通过
// （内部任务-100 布局）；canonical=通过 + 历史轮归档并存（内部任务-103 布局）。全序列
// 失配仍拒且拒因保留 canonical 诊断精度并注记扫描未命中。

test('P1 序列：canonical=旧哈希不通过 + review2=现哈希通过 → 放行', () => {
  const f = fixture({ planText: '# 修订后计划\n', sidecar: v2Sidecar({ planText: '# 旧版计划\n', pass: false }) });
  try {
    writeFileSync(join(f.proj, 'docs', 'plans', 'feat-review2.md'), v2Sidecar({ planText: '# 修订后计划\n', pass: true }));
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true, 'review2 内容匹配（当前哈希+通过）即构成 v2 凭据');
    assert.equal(r.planSha256, lfHash('# 修订后计划\n'));
  } finally {
    f.cleanup();
  }
});

test('P1 序列：canonical=通过 + 历史轮归档（-review-round1.md 旧哈希不通过）→ 放行', () => {
  const f = fixture({ sidecar: v2Sidecar({ pass: true }) });
  try {
    writeFileSync(join(f.proj, 'docs', 'plans', 'feat-review-round1.md'), v2Sidecar({ planText: '# 旧版计划\n', pass: false }));
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true, 'canonical 直接过，归档轮并存不失效');
  } finally {
    f.cleanup();
  }
});

test('P1 序列：canonical 缺失 + 仅 review2=现哈希通过 → 放行', () => {
  const f = fixture({ sidecar: null });
  try {
    writeFileSync(join(f.proj, 'docs', 'plans', 'feat-review2.md'), v2Sidecar({ pass: true }));
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, true, '序列扫描不要求 canonical 存在');
  } finally {
    f.cleanup();
  }
});

test('P1 序列：全序列哈希失配 → 拒绝并注记扫描未命中', () => {
  const f = fixture({ sidecar: v2Sidecar({ planText: '# 旧版一\n', pass: false }) });
  try {
    writeFileSync(join(f.proj, 'docs', 'plans', 'feat-review2.md'), v2Sidecar({ planText: '# 旧版二\n', pass: true }));
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /序列/);
    assert.match(r.reason ?? '', /未命中/);
  } finally {
    f.cleanup();
  }
});

// W4（2026-09-16 租约族缺陷批次）：凭据解析根与声明键解耦——多仓工作区下
// 计划与 sidecar 常在主仓而声明键可能落在嵌套仓，两条路都必须通。
test('W4 planRoot 解耦：缺省=声明键仓根（行为等价）；显式 planRoot 命中他仓凭据；非法值专属拒因', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-planbind-w4-'));
  const main = join(home, 'main');
  const nested = join(home, 'main', 'nested');
  mkdirSync(join(main, '.git'), { recursive: true });
  mkdirSync(join(nested, '.git'), { recursive: true });
  mkdirSync(join(main, 'docs', 'plans'), { recursive: true });
  const planText = '# W4 计划\n';
  writeFileSync(join(main, 'docs', 'plans', 'w4.md'), planText);
  const fm = `---\nschemaVersion: 2\ntaskId: 内部任务-4\nplanPath: 内部计划\nplanSha256: ${lfHash(planText)}\nreviewedAt: 2026-09-16T00:00:00+08:00\nreviewMode: self\nreviewInstances: 0\nreviewReason: "W4 夹具"\n---\n\n`;
  writeFileSync(join(main, 'docs', 'plans', 'w4-review.md'), `${fm}结论：通过\n`);
  try {
    // 缺省：凭据按声明键仓根解析——嵌套仓根下无 内部计划 → 拒（既有行为保持）
    const def = verifyReviewedPlan(nested, '内部计划', '内部任务-4');
    assert.equal(def.ok, false, '缺省行为等价回归：凭据根=声明键仓根');
    // 显式 planRoot=主仓根 → 命中凭据（W4 解锁的形态）
    const dec = verifyReviewedPlan(nested, '内部计划', '内部任务-4', main);
    assert.equal(dec.ok, true, '显式 planRoot 放行嵌套键声明');
    // planRoot 不存在 → 专属拒因（防以任意目录的 sidecar 冒充凭据）
    const bad = verifyReviewedPlan(nested, '内部计划', '内部任务-4', join(home, 'nope'));
    assert.equal(bad.ok, false);
    assert.ok(String(bad.reason).includes('plan-root'), '非法 planRoot 专属拒因');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 内部规则-16（内部任务-156）：plan 改动面嗅探与 sidecar 实例模式 ──

test('planChangeSurface：超过 8 步 / 超过 8 文件 / 超过 2 新模块才触发，8/8/2 不触发', () => {
  const bigSteps = planChangeSurface(sizedPlan({ steps: 9, includeFileList: false, fence: true }));
  assert.equal(bigSteps.isImplementation, true);
  assert.equal(bigSteps.steps, 9);
  assert.equal(bigSteps.overThreshold, true, '9 步实现类触发');

  const edge = planChangeSurface(sizedPlan({ steps: 8, files: Array.from({ length: 8 }, (_, i) => `src/f${i}.mjs`) }));
  assert.equal(edge.steps, 8);
  assert.equal(edge.files, 8);
  assert.equal(edge.newModules, 0);
  assert.equal(edge.overThreshold, false, '8 步/8 文件恰在阈值内');

  const manyFiles = planChangeSurface(sizedPlan({ steps: 0, files: Array.from({ length: 9 }, (_, i) => `src/f${i}.mjs`) }));
  assert.equal(manyFiles.overThreshold, true, '9 文件触发');

  const manyModules = planChangeSurface(sizedPlan({
    steps: 0,
    files: [
      { path: 'src/a.mjs', action: '新建' },
      { path: 'src/b.mjs', action: '新增' },
      { path: 'src/c.mjs', action: '创建' },
    ],
  }));
  assert.equal(manyModules.newModules, 3);
  assert.equal(manyModules.overThreshold, true, '3 个新模块触发');

  const pureDoc = planChangeSurface(sizedPlan({ steps: 9, files: [{ path: '内部计划', action: '新建' }] }));
  assert.equal(pureDoc.isImplementation, false, '纯文档计划不因步骤多被判实现类');
  assert.equal(pureDoc.overThreshold, false, '纯文档计划不触发独立实例义务');
});

test('planChangeSurface：代码围栏与过程文件节不计数；无文件清单的实现词兜底', () => {
  const fenced = planChangeSurface(sizedPlan({ steps: 8, includeFileList: false, fence: true }));
  assert.equal(fenced.steps, 8, '围栏内的步骤样例不计数');
  assert.equal(fenced.isImplementation, true, '代码围栏标识实现类');

  const proseImpl = planChangeSurface([
    '---', 'specRefs: [内部需求-1]', '---', '# 计划', '',
    '### 步骤 1：改 routing-lib 的 hook', '', '验收：测试退出 0', '',
  ].join('\n'));
  assert.equal(proseImpl.hasFileList, false);
  assert.equal(proseImpl.isImplementation, true, '无清单但含 hook/测试实现词 → 实现类');
  assert.equal(proseImpl.overThreshold, true, '无清单实现类按超阈值兜底');

  const withProcess = planChangeSurface([
    sizedPlan({ steps: 1, files: ['src/a.mjs'] }),
    '## 过程文件', '',
    '- `内部证据`',
  ].join('\n'));
  assert.equal(withProcess.files, 1, '过程文件节路径不计入文件数');
});

test('planChangeSurface：文件清单格式/目录级/职责列/过宽令牌/清单外代码路径（W1 评审处置）', () => {
  const ordered = ['---', 'specRefs: [内部需求-1]', '---', '# 计划', '', '## 文件清单', '',
    ...Array.from({ length: 9 }, (_, i) => `${i + 1}. \`src/f${i}.mjs\``)].join('\n');
  assert.equal(planChangeSurface(ordered).files, 9, '有序列表文件清单计数');
  assert.equal(planChangeSurface(ordered).overThreshold, true, '有序列表 9 文件触发');

  const pipeless = ['---', 'specRefs: [内部需求-1]', '---', '# 计划', '', '## 文件清单', '',
    '文件 | 动作 | 职责', '--- | --- | ---',
    ...Array.from({ length: 9 }, (_, i) => `\`src/p${i}.mjs\` | 改 | 职责`)].join('\n');
  assert.equal(planChangeSurface(pipeless).files, 9, '无前导管线表格计数');

  const dirOnly = ['# 计划', '', '## 文件清单', '', '| `src/core/` | 新建 | 职责 |', '',
    '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  const dirR = planChangeSurface(dirOnly);
  assert.equal(dirR.hasFileList, false, '目录级清单不算文件清单');
  assert.equal(dirR.overThreshold, true, '无文件级清单的实现类按超阈值兜底');

  const emptyList = ['# 计划', '', '## 文件清单', '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  assert.equal(planChangeSurface(emptyList).hasFileList, false, '空文件清单节按无清单');

  const responsibility = ['# 计划', '', '## 文件清单', '', '| # | 文件 | 动作 | 职责 |', '|---|---|---|---|',
    '| 1 | `src/a.mjs` | 改 | 新增说明 |', '| 2 | `src/b.mjs` | 改 | 添加说明 |',
    '| 3 | `src/c.mjs` | 改 | 创建说明 |', '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  const respR = planChangeSurface(responsibility);
  assert.equal(respR.newModules, 0, '职责列动作词不计入新模块');
  assert.equal(respR.overThreshold, false, '3 个修改文件不触发');

  const tokens = ['# 计划', '', '## 文件清单', '', '| # | 文件 | 动作 |', '|---|---|---|',
    ...Array.from({ length: 8 }, (_, i) => `| ${i + 1} | \`src/t${i}.mjs\` | 改 |`),
    '| 9 | `docs/plans/` | 改 |', '| 10 | `0.14.0` | 改 |', '| 11 | `e.g` | 改 |',
    '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  const tokenR = planChangeSurface(tokens);
  assert.equal(tokenR.files, 8, '无扩展名/版本号/e.g 不计入文件数');
  assert.equal(tokenR.overThreshold, false, '8 个真实文件不触发');

  const prosePath = ['# 计划', '', '### 步骤 1：改 src/core/plan_check.mjs', '', '验收：x'].join('\n');
  const proseR = planChangeSurface(prosePath);
  assert.equal(proseR.hasFileList, false);
  assert.equal(proseR.isImplementation, true, '清单外代码路径识别为实现类');
  assert.equal(proseR.overThreshold, true, '无清单实现类按超阈值兜底');

  const twoNew = ['# 计划', '', '## 文件清单', '', '| # | 文件 | 动作 |', '|---|---|---|',
    '| 1 | `src/a.mjs` | 新建 |', '| 2 | `src/b.mjs` | 新建 |', '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  const twoR = planChangeSurface(twoNew);
  assert.equal(twoR.newModules, 2);
  assert.equal(twoR.overThreshold, false, '恰 2 个新模块不触发');

  const umbrella = ['# 计划', '', '## 步骤', '',
    ...Array.from({ length: 8 }, (_, i) => `### 步骤 ${i + 1}：做第 ${i + 1} 件事\n\n验收：x\n`),
    '## 文件清单', '', '| 1 | `src/a.mjs` | 改 |'].join('\n');
  assert.equal(planChangeSurface(umbrella).steps, 8, '裸伞标题不计，只计带编号子步骤');
  assert.equal(planChangeSurface(umbrella).overThreshold, false, '8 步 + 1 文件不触发');

  const listBoundary = ['# 计划', '', '## 文件清单', '', '| 1 | `src/a.mjs` | 改 |', '',
    '### 任务 1：后续任务', '', '| 2 | `src/b.mjs` | 新建 |'].join('\n');
  const boundaryR = planChangeSurface(listBoundary);
  assert.equal(boundaryR.files, 1, '文件清单在步骤/任务标题处结束，任务正文路径不计入');
  assert.equal(boundaryR.newModules, 0);

  const rootFiles = ['# 计划', '', '## 文件清单', '', '| # | 文件 | 动作 |', '|---|---|---|',
    ...Array.from({ length: 8 }, (_, i) => `| ${i + 1} | \`root${i}.mjs\` | 改 |`),
    '| 9 | `经验记录` | 改 |', '| 10 | `src/a.go` | 新建 |', '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  const rootR = planChangeSurface(rootFiles);
  assert.equal(rootR.files, 10, '根级文件与非白名单扩展名均计数');
  assert.equal(rootR.newModules, 1);
  assert.equal(rootR.overThreshold, true, '10 文件触发');

  const pureDocCommand = ['# 计划', '', '### 步骤 1：删除条款', '', '验收：`node scripts/check-repo-consistency.mjs` 退出 0',
    '### 步骤 2：回写', '', '验收：阅读完成'].join('\n');
  assert.equal(planChangeSurface(pureDocCommand).isImplementation, false, '验收命令中的代码路径不把纯文档计划判为实现类');

  const specsOnly = ['# 计划', '', '## 文件清单', '',
    ...Array.from({ length: 9 }, (_, i) => `| ${i + 1} | \`内部规格${i}.md\` | 改 |`),
    '', '### 步骤 1：回写规格', '', '```js', 'const x = 1;', '```'].join('\n');
  const specsR = planChangeSurface(specsOnly);
  assert.equal(specsR.isImplementation, false, 'specs 纯文档计划（含示例围栏）不判实现类');
  assert.equal(specsR.overThreshold, false, 'specs 纯文档计划不触发');

  const fileLevel = ['# 计划', '', '## 文件级清单', '',
    ...Array.from({ length: 9 }, (_, i) => `| ${i + 1} | \`src/f${i}.mjs\` | 改 |`),
    '', '### 步骤 1：改 hook', '', '验收：x'].join('\n');
  assert.equal(planChangeSurface(fileLevel).files, 9, '「文件级清单」标题也识别');
  assert.equal(planChangeSurface(fileLevel).overThreshold, true);

  const waveSteps = ['# 计划', '', '## W1', '',
    ...Array.from({ length: 8 }, (_, i) => `### 步骤 ${i + 1}：做第 ${i + 1} 件事\n\n验收：x\n`),
    '## 文件清单', '', '| 1 | `src/a.mjs` | 改 |'].join('\n');
  assert.equal(planChangeSurface(waveSteps).steps, 8, 'wave 标题不与步骤标题双计');

  const pureNoList = ['# 计划', '', ...Array.from({ length: 9 }, (_, i) => `### 步骤 ${i + 1}：写文档\n\n验收：阅读完成\n`)].join('\n');
  const pureR = planChangeSurface(pureNoList);
  assert.equal(pureR.isImplementation, false, '无清单纯文档计划不触发');
  assert.equal(pureR.overThreshold, false);

  const fenced = planChangeSurface(sizedPlan({ steps: 8, files: ['src/a.mjs'], fence: true }));
  assert.equal(fenced.steps, 8, '围栏内 ### 步骤 99 不计数');
  assert.equal(fenced.files, 1, '围栏内文件行不计数');
});

/** 用给定计划文本构造 fixture 并校验。 */
function verifyWith(planText, opts = {}) {
  const mode = opts.reviewMode ?? (opts.ratify ? 'ratified' : 'self');
  // 内部任务-191：独立/mixed 为 v3 强制形态；self/ratified 仍可 v2。
  const isV3 = mode === 'independent' || mode === 'mixed';
  const sidecar = isV3
    ? v3Sidecar({
      planText,
      mode,
      instances: opts.reviewInstances ?? 2,
      reason: opts.reviewReason,
      pass: opts.pass ?? true,
      // A9：v3 路径也要透传 ratify/未知字段（旧实现只给 v2 helper，v3 用例因此空载）
      ratify: opts.ratify ?? false,
      ratifyValue: opts.ratifyValue,
      extraFrontmatter: opts.extraFrontmatter ?? [],
    })
    : v2Sidecar({ planText, ...opts });
  const f = fixture({ planText, sidecar });
  try {
    return verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
  } finally {
    f.cleanup();
  }
}

const lowPlan = sizedPlan({ steps: 1, files: ['src/a.mjs'] });
const bigPlan = sizedPlan({ steps: 9, files: ['src/a.mjs'] });

test('sidecar 真值表：超阈值只接受 independent ≥2 + 理由', () => {
  assert.equal(verifyWith(bigPlan, { reviewMode: 'independent', reviewInstances: 2 }).ok, true, 'independent/2 放行');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'independent', reviewInstances: 3 }).ok, true, 'independent/3 放行');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'independent', reviewInstances: 1 }).ok, false, 'independent/1 拒');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'independent', reviewInstances: 2, reviewReason: '' }).ok, false, 'independent 无理由拒');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'self' }).ok, false, '超阈值 self 拒');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'mixed', reviewInstances: 1 }).ok, false, '超阈值 mixed 拒');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'ratified' }).ok, false, '超阈值 ratified 拒');
});

test('sidecar 真值表：低阈值接受 self/mixed/independent/ratified，但实例数必须精确', () => {
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self' }).ok, true, 'self/0 + 理由放行');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self', reviewReason: '' }).ok, false, 'self 无理由拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self', reviewInstances: 1 }).ok, false, 'self/1 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'mixed', reviewInstances: 1 }).ok, true, 'mixed/1 + 理由放行');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'mixed', reviewInstances: 0 }).ok, false, 'mixed/0 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'mixed', reviewInstances: 2 }).ok, false, 'mixed/2 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'mixed', reviewInstances: 1, reviewReason: '' }).ok, false, 'mixed 无理由拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'independent', reviewInstances: 0 }).ok, false, 'independent/0 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'ratified' }).ok, true, 'ratified/0 + 理由放行');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'ratified', reviewInstances: 1 }).ok, false, 'ratified/1 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'ratified', reviewReason: '' }).ok, false, 'ratified 无理由拒');
});

test('sidecar 缺字段/缺实例/非法值：低阈值同样拒（新凭据必填）', () => {
  assert.equal(verifyWith(lowPlan, { includeReviewFields: false }).ok, false, '低阈值缺三字段拒');
  assert.equal(verifyWith(bigPlan, { includeReviewFields: false }).ok, false, '超阈值缺三字段拒');
  assert.equal(verifyWith(bigPlan, { reviewMode: 'self', includeReviewInstances: false }).ok, false, 'reviewMode 有值但缺 instances 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'bogus' }).ok, false, '非法 mode 拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self', reviewInstances: -1 }).ok, false, '负实例拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self', reviewInstances: '1.5' }).ok, false, '小数实例拒');
  assert.equal(verifyWith(lowPlan, { reviewMode: 'self', reviewInstances: 'abc' }).ok, false, '非数字实例拒');
  assert.equal(verifyWith(bigPlan, {
    reviewMode: 'independent', reviewInstances: '9'.repeat(400), reviewReason: 'x',
  }).ok, false, '超长数字（Number 后 Infinity）须拒');
});

test('内部决策-020 容忍：ratify 与 independent 同现时 ratify 不作机器判据', () => {
  // A9（内部任务-193）：旧 v3Sidecar 静默丢弃 ratify/未知字段，本用例是空载的——先做非空载
  // 断言（夹具必须真把字段写进 v3 frontmatter），再断言凭据判定对它们零感知。
  const loaded = v3Sidecar({
    planText: lowPlan, mode: 'independent', instances: 2, reason: '两视角独立',
    ratify: true, ratifyValue: 'host-plan', extraFrontmatter: ['reviewOrigin: 内部决策-020'],
  });
  assert.match(loaded, /^ratify: host-plan$/m, '夹具必须真载 ratify 字段（防空载回归）');
  assert.match(loaded, /^reviewOrigin: 内部决策-020$/m, '夹具必须真载未知 frontmatter 字段');
  const r = verifyFixtureWith(loaded, { planText: lowPlan });
  assert.equal(r.ok, true, 'ratify 字段不被校验（内部决策-020 D3 零改动）');
  const passthrough = verifyWith(lowPlan, {
    ratify: true, ratifyValue: 'host-plan', extraFrontmatter: ['reviewOrigin: 内部决策-020'],
    reviewMode: 'independent', reviewInstances: 2, reviewReason: '两视角独立',
  });
  assert.equal(passthrough.ok, true, 'verifyWith 透传 ratify/未知字段后仍放行');
  const arbitrary = v3Sidecar({
    planText: lowPlan, mode: 'independent', instances: 2, reason: '两视角独立',
    ratify: true, ratifyValue: 'not-host-plan',
  });
  assert.match(arbitrary, /^ratify: not-host-plan$/m, '任意 ratify 值同样须真载');
  assert.equal(
    verifyFixtureWith(arbitrary, { planText: lowPlan }).ok,
    true,
    '任意 ratify 值均不作机器判据',
  );
});

test('surface：计划可读时失败也附改动面；早退失败为 null', () => {
  const f = fixture({ planText: bigPlan, sidecar: v2Sidecar({ planText: bigPlan, includeReviewFields: false }) });
  try {
    const r = verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
    assert.equal(r.ok, false);
    assert.equal(r.surface?.overThreshold, true, '失败结果附 surface');
    const missing = verifyReviewedPlan(f.proj, '内部计划', '内部任务-1');
    assert.equal(missing.ok, false);
    assert.equal(missing.surface, null, '早退失败 surface=null');
  } finally {
    f.cleanup();
  }
});

// ── 内部任务-191：v3 provenance / round / 链身份（sidecar v3 契约）──

/** 以给定 sidecar 文本建夹具；extraFiles 为 [{rel,text}] 追加文件（前轮档/序列档）。 */
function verifyFixtureWith(sidecar, { planText = '# 计划正文\n', extraFiles = [] } = {}) {
  const f = fixture({ planText, sidecar });
  try {
    for (const { rel, text } of extraFiles) writeFileSync(join(f.proj, rel), text);
    return verifyReviewedPlan(f.proj, f.planRel, '内部任务-1');
  } finally {
    f.cleanup();
  }
}

const CHAIN = 'plan:内部计划';
const freshEntries = (n = 2) => Array.from({ length: n }, (_, i) => ({
  role: i === 0 ? 'engineering' : `role-${i + 1}`, instance: `inst-${i + 1}`, chain: CHAIN, state: 'fresh',
}));
/** 前轮失败档（round1 不通过）：只作结构锚与序列归档，不构成有效凭据。 */
const priorRoundFile = (planText = '# 计划正文\n') => ([{
  rel: '内部计划', text: v3Sidecar({ planText, round: 1, pass: false }),
}]);

test('内部任务-191：v2 independent/mixed → 判拒并给 v3 迁移文案（schemaVersion: 3 / reviewProvenance）', () => {
  for (const mode of ['independent', 'mixed']) {
    const r = verifyFixtureWith(v2Sidecar({ reviewMode: mode, reviewInstances: mode === 'independent' ? 2 : 1 }));
    assert.equal(r.ok, false, `${mode} v2 必须拒`);
    assert.match(r.reason ?? '', /schemaVersion: 3/);
    assert.match(r.reason ?? '', /reviewProvenance/);
  }
});

test('内部任务-191：v3 round=1 两 fresh 放行；round=2 同链 reused 放行（前轮档在案）', () => {
  assert.equal(verifyFixtureWith(v3Sidecar()).ok, true, 'v3 round1 fresh 放行');
  const reused = freshEntries(2).map((e) => ({ ...e, state: 'reused' }));
  const r = verifyFixtureWith(v3Sidecar({ round: 2, provenance: reused }), { extraFiles: priorRoundFile() });
  assert.equal(r.ok, true, `round2 同链 reused 应放行（reason：${r.reason}）`);
});

test('内部任务-191：v3 round=1 含 rehydrated → 拒；rehydrated 补位不计入 countable', () => {
  const mixedStates = [{ ...freshEntries(1)[0] }, { ...freshEntries(1)[0], role: 'ceo', instance: 'inst-2', state: 'rehydrated' }];
  const r1 = verifyFixtureWith(v3Sidecar({ provenance: mixedStates }));
  assert.equal(r1.ok, false, 'round1 必须全 fresh');
  assert.match(r1.reason ?? '', /fresh/);
  const r2 = verifyFixtureWith(v3Sidecar({ round: 2, provenance: mixedStates }), { extraFiles: priorRoundFile() });
  assert.equal(r2.ok, false, 'countable 不足（1<2）须拒');
  assert.match(r2.reason ?? '', /countable|reviewInstances/);
  const pass = verifyFixtureWith(v3Sidecar({ round: 2, provenance: [...freshEntries(2), { role: 'ceo-extra', instance: 'inst-9', chain: CHAIN, state: 'rehydrated' }] }), { extraFiles: priorRoundFile() });
  assert.equal(pass.ok, true, 'countable=2 时 rehydrated 可作补位');
});

test('内部任务-191：v3 跨任务 chain / JSON 非法 / 缺 round / 重复 instance·role / crossStage 缺 note → 拒', () => {
  const cross = verifyFixtureWith(v3Sidecar({ provenance: freshEntries(2).map((e) => ({ ...e, chain: 'plan:内部计划' })) }));
  assert.equal(cross.ok, false);
  assert.match(cross.reason ?? '', /链/);
  const badJson = verifyFixtureWith(v3Sidecar({ rawProvenance: '[{"role":' }));
  assert.equal(badJson.ok, false);
  assert.match(badJson.reason ?? '', /JSON/);
  const noRound = verifyFixtureWith(v3Sidecar({ omitRound: true }));
  assert.equal(noRound.ok, false);
  assert.match(noRound.reason ?? '', /reviewRound/);
  const dupInstance = verifyFixtureWith(v3Sidecar({ provenance: [
    { role: 'engineering', instance: 'same', chain: CHAIN, state: 'fresh' },
    { role: 'ceo', instance: 'same', chain: CHAIN, state: 'fresh' },
  ] }));
  assert.equal(dupInstance.ok, false);
  assert.match(dupInstance.reason ?? '', /instance/);
  const dupRole = verifyFixtureWith(v3Sidecar({ provenance: [
    { role: 'engineering', instance: 'a', chain: CHAIN, state: 'fresh' },
    { role: 'engineering', instance: 'b', chain: CHAIN, state: 'fresh' },
  ] }));
  assert.equal(dupRole.ok, false);
  assert.match(dupRole.reason ?? '', /role/);
  const crossStage = verifyFixtureWith(v3Sidecar({ provenance: [
    { role: 'engineering', instance: 'a', chain: CHAIN, state: 'fresh', crossStage: true },
    { role: 'ceo', instance: 'b', chain: CHAIN, state: 'fresh' },
  ] }));
  assert.equal(crossStage.ok, false);
  assert.match(crossStage.reason ?? '', /crossStage|note/);
});

test('内部任务-191：round>1 缺前轮档 → 拒；前轮档名 N 与 reviewRound 不符 → 拒', () => {
  const noPrior = verifyFixtureWith(v3Sidecar({ round: 2, provenance: freshEntries(2).map((e) => ({ ...e, state: 'reused' })) }));
  assert.equal(noPrior.ok, false);
  assert.match(noPrior.reason ?? '', /前轮/);
  const mismatched = verifyFixtureWith(null, {
    extraFiles: [{ rel: '内部计划', text: v3Sidecar({ round: 1 }) }],
  });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.reason ?? '', /文件名|reviewRound/);
});

test('内部任务-191：v3 self/ratified 须 round 且 provenance 为空数组', () => {
  const selfEmpty = verifyFixtureWith(v3Sidecar({ mode: 'self', instances: 0, provenance: [] }));
  assert.equal(selfEmpty.ok, true, 'v3 self/0 + 空 provenance 放行');
  const selfNonEmpty = verifyFixtureWith(v3Sidecar({ mode: 'self', instances: 0, provenance: freshEntries(1) }));
  assert.equal(selfNonEmpty.ok, false);
  assert.match(selfNonEmpty.reason ?? '', /reviewProvenance/);
  const selfNoRound = verifyFixtureWith(v3Sidecar({ mode: 'self', instances: 0, provenance: [], omitRound: true }));
  assert.equal(selfNoRound.ok, false);
  assert.match(selfNoRound.reason ?? '', /reviewRound/);
});

// ── 内部任务-193 A12：前轮档/文件名轮次锚加固（D6：精确 stem + 内容抽检只校 planPath）──

// A12：前轮档结构锚须认得精确 stem——`<stem>-review-roundN.md` / `<stem>-reviewN.md`
// 才算；异常命名（多一段 `-review-`、前缀不同）不得以 startsWith 前缀旁路轮次锚。
test('A12 前轮档精确 stem：异常命名不构成前轮档，精确命名在案才放行', () => {
  const reused = freshEntries(2).map((e) => ({ ...e, state: 'reused' }));
  const canonical = v3Sidecar({ round: 2, provenance: reused });
  // 反例：feat-review-review-round1.md 对 stem=feat 是异名档（旧逻辑按前缀误认）
  const bypass = verifyFixtureWith(canonical, {
    extraFiles: [{
      rel: '内部计划',
      text: v3Sidecar({ round: 1, pass: false }),
    }],
  });
  assert.equal(bypass.ok, false, '异常命名不得充当 round1 前轮档（round2 缺前轮档须拒）');
  assert.match(bypass.reason ?? '', /前轮/);
  // 正例：精确命名 feat-review-round1.md 在案 → 放行
  const ok = verifyFixtureWith(canonical, { extraFiles: priorRoundFile() });
  assert.equal(ok.ok, true, `精确 stem 前轮档应放行（reason：${ok.reason}）`);
});

// A12（D6）：前轮档命中后须抽检 frontmatter——只校 planPath 相等（taskId 仅记录不校验：
// 同一计划换任务号续审合法），不比 planSha256；不可读/无 frontmatter/planPath 不符 fail-closed。
test('A12 前轮档内容抽检：planPath 相等才认锚，taskId 可异', () => {
  const reused = freshEntries(2).map((e) => ({ ...e, state: 'reused' }));
  const canonical = v3Sidecar({ round: 2, provenance: reused });
  // 正例：taskId 异 / planPath 同（换号续审）——前轮档对应旧计划版本，planSha256 故意不同
  const otherTaskId = verifyFixtureWith(canonical, {
    extraFiles: [{
      rel: '内部计划',
      text: v3Sidecar({ planText: '# 上一版计划\n', round: 1, pass: false, taskId: 'TASK-OTHER' }),
    }],
  });
  assert.equal(otherTaskId.ok, true, `taskId 异 / planPath 同应放行（reason：${otherTaskId.reason}）`);
  // 反例：planPath 异 → 前轮档不属于本计划，fail-closed
  const otherPlan = verifyFixtureWith(canonical, {
    extraFiles: [{
      rel: '内部计划',
      text: v3Sidecar({ planRel: '内部计划', planText: '# 上一版计划\n', round: 1, pass: false }),
    }],
  });
  assert.equal(otherPlan.ok, false, 'planPath 异不得作前轮档');
  assert.match(otherPlan.reason ?? '', /前轮/);
  // 反例：无 frontmatter（legacy 档）→ 无法抽检，fail-closed
  const noFrontmatter = verifyFixtureWith(canonical, {
    extraFiles: [{ rel: '内部计划', text: '# 历史轮记录\n\n结论：通过\n' }],
  });
  assert.equal(noFrontmatter.ok, false, '无 frontmatter 前轮档 fail-closed');
  assert.match(noFrontmatter.reason ?? '', /前轮/);
});

// A12（D6）：文件名轮次锚从「仅 -review-roundN」扩到 `-reviewN` 同校——文件名声明的
// 轮次必须与 frontmatter reviewRound 一致；canonical `<stem>-review.md` 不适用。
test('A12 -reviewN 轮次一致：文件名轮次与 reviewRound 同校', () => {
  // 反例：feat-review2.md 内容自称 round1 → 拒
  const mismatch = verifyFixtureWith(null, {
    extraFiles: [{ rel: '内部计划', text: v3Sidecar({ round: 1 }) }],
  });
  assert.equal(mismatch.ok, false, '-reviewN 文件名轮次与 reviewRound 不符须拒');
  assert.match(mismatch.reason ?? '', /文件名|reviewRound/);
  // 反例（-review-roundN 形态同校）：feat-review-round2.md 内容自称 round1 → 拒
  const roundName = verifyFixtureWith(null, {
    extraFiles: [{ rel: '内部计划', text: v3Sidecar({ round: 1 }) }],
  });
  assert.equal(roundName.ok, false, '-review-roundN 文件名轮次与 reviewRound 不符须拒');
  assert.match(roundName.reason ?? '', /文件名|reviewRound/);
  // 正例：feat-review2.md 内容 round2 + 前轮档在案 → 序列扫描放行
  const reused = freshEntries(2).map((e) => ({ ...e, state: 'reused' }));
  const ok = verifyFixtureWith(null, {
    extraFiles: [
      { rel: '内部计划', text: v3Sidecar({ round: 1, pass: false }) },
      { rel: '内部计划', text: v3Sidecar({ round: 2, provenance: reused }) },
    ],
  });
  assert.equal(ok.ok, true, `-reviewN 轮次一致应放行（reason：${ok.reason}）`);
  assert.equal(ok.sidecar, 'feat-review2.md', '有效凭据来自 -reviewN 序列档');
});
