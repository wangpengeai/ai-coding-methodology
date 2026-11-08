// 文件：check-routing.test.mjs
// 描述：路由一致性 lint（check-routing.mjs）的 TDD 测试——先写测试后写实现，
//       覆盖 a) 必需目录（含 ROUTING_EXPECT 增量模式）b) frontmatter 规范 c) 路由表双向对照
//       d) Scout 三行单目标互斥 e) 行号引用核验环（line-ref-drift）f) 缺省 skillsRoot 脚本定位。
//       内部规则-14/内部验收-14 带理由豁免：f) 用例对真实仓库 workflow/skills 跑全量 lint——
//       异目录 cwd 缺省定位回归只有真实布局可验（头注「真实 skills 不进测试」的豁免条目）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部用临时 skills 目录，
//       真实 workflow/skills 只作为 gate 手工跑的对象，不进测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-routing.mjs');

/**
 * 以子进程方式运行被测脚本，可注入 ROUTING_EXPECT（增量模式契约靠环境变量表达）。
 * @param {string} skillsRoot skills 根目录
 * @param {{ expect?: string }} [opts] expect 为 ROUTING_EXPECT 的值；省略键=从环境删除（全量模式）
 * @returns {{ status: number | null, report: any, stderr: string }}
 */
function run(skillsRoot, opts = {}) {
  const env = { ...process.env };
  if ('expect' in opts) env.ROUTING_EXPECT = opts.expect;
  else delete env.ROUTING_EXPECT; // 为什么显式删：防止外层环境泄漏导致用例漂移
  const r = spawnSync(process.execPath, [SCRIPT, skillsRoot], { encoding: 'utf8', env });
  let report = null;
  try {
    report = JSON.parse(r.stdout); // 报告契约：stdout 是单个 JSON 对象
  } catch {
    /* RED 阶段脚本不存在，stdout 为空——保持 report=null 让断言失败 */
  }
  return { status: r.status, report, stderr: r.stderr ?? '' };
}

/** 临时 skills 根目录。 */
function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'routing-lint-'));
}

/**
 * 造一个合格的 workflow 元技能 SKILL.md（含 Scout 三行——内部规则-9 lint 的合法基线）。
 * @param {string[]} refs 路由表"路由到"列要引用的 skill 名（每名一行；scout 三行自动附加）
 * @returns {string} SKILL.md 全文
 */
function metaSkill(refs) {
  const rows = refs
    .filter((n) => !['scout', 'spike-run', 'disposable-build'].includes(n))
    .map((n) => `| 状态-${n} | \`${n}\` | 触发条件-${n} |`)
    .join('\n');
  const scoutRows = [
    '| 管理 Scout 生命周期 | `scout` | 用户表达模式开关/续期/毕业/放弃意图 |',
    '| 有效 explore 模式兜底 | `spike-run` | 项目根有效 mode=explore 且未命中其余行 |',
    '| 有效 disposable 模式兜底 | `disposable-build` | 项目根有效 mode=disposable 且未命中其余行 |',
  ].join('\n');
  return `---
name: workflow
description: 元技能：任何开发任务开始时先查路由表，按用户状态唯一命中入口 skill —— 触发条件：会话开始、任务到来、场景切换时。
license: MIT
---

# workflow 元技能

## 路由表

| 用户状态 | 路由到 | 显式触发条件 |
|---|---|---|
${rows}
${scoutRows}
`;
}

/**
 * 造一个合格（或按需注入缺陷）的入口 skill SKILL.md。
 * @param {string} name 目录名（默认也作 frontmatter name）
 * @param {{ name?: string, description?: string }} [defects] 覆盖 frontmatter 字段以注入缺陷
 * @returns {string} SKILL.md 全文
 */
function entrySkill(name, defects = {}) {
  const fmName = defects.name ?? name;
  const desc =
    defects.description ??
    `入口技能夹具：${name} 场景的完整描述文本，长度超过三十个字符 —— 触发条件：用户处于 ${name} 场景时。`;
  return `---
name: ${fmName}
description: ${desc}
license: MIT
---

# ${name}
`;
}

/**
 * 在临时根下建一个 skill 目录。
 * @param {string} root skills 根
 * @param {string} name 目录名
 * @param {string} content SKILL.md 内容
 */
function makeSkill(root, name, content) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), content);
}

test('路由：增量模式合格夹具（workflow + 入口 skill + ROUTING_EXPECT）→ 退出 0', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['idea-review']));
    makeSkill(root, 'idea-review', entrySkill('idea-review'));
    const r = run(root, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 0);
    assert.ok(r.report, 'stdout 应输出可解析的 JSON 报告');
    assert.deepEqual(r.report.violations, []);
    assert.deepEqual(r.report.checked.expected, ['workflow', 'idea-review']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：路由表引用不存在的 skill（且在期望清单内）→ 退出 1，违规则含 missing-skill', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['ghost-skill']));
    const r = run(root, { expect: 'workflow,ghost-skill' });
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'missing-skill'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：name 与目录名不一致 → 退出 1，违规则含 name-mismatch', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['idea-review']));
    makeSkill(root, 'idea-review', entrySkill('idea-review', { name: 'wrong-name' }));
    const r = run(root, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'name-mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：description 缺「触发条件」→ 退出 1，违规则含 description-trigger', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['idea-review']));
    // 描述足够长但无触发条件锚点（内部规则-2：触发条件必须写进 description）
    makeSkill(
      root,
      'idea-review',
      entrySkill('idea-review', { description: '这是一个足够长的描述，但完全没有统一格式锚点字样。' })
    );
    const r = run(root, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'description-trigger'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：description 不足 30 字符 → 退出 1，违规则含 description-length', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['idea-review']));
    makeSkill(root, 'idea-review', entrySkill('idea-review', { description: '太短 —— 触发条件：x。' }));
    const r = run(root, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'description-length'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：全量模式（无 ROUTING_EXPECT）缺 20 清单目录 → 退出 1，违规则含 missing-skill', () => {
  const root = tempRoot();
  try {
    makeSkill(root, 'workflow', metaSkill(['idea-review']));
    makeSkill(root, 'idea-review', entrySkill('idea-review'));
    const r = run(root, {}); // 不注入 ROUTING_EXPECT → 期望全部 20 个
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'missing-skill'));
    assert.equal(r.report.checked.mode, 'full');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：增量模式下引用清单外的未来 skill 容忍，但清单内入口 skill 未入表 → 违规则含 unrouted-skill', () => {
  const root = tempRoot();
  try {
    // 路由表只引用 brainstorming（不在期望清单=未来批次，应容忍）；
    // idea-review 在期望清单且存在，却未出现在路由表 → 覆盖方向违例
    makeSkill(root, 'workflow', metaSkill(['brainstorming']));
    makeSkill(root, 'idea-review', entrySkill('idea-review'));
    const r = run(root, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 1);
    assert.ok(r.report.violations.some((v) => v.rule === 'unrouted-skill'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：路由表多目标行（→ 与 / 分隔）应拆出全部 skill 名', () => {
  const root = tempRoot();
  try {
    // 覆盖真实路由表两种复合行形态：`verification` → `code-review`、`retro`/`health`/`learnings`
    const meta = metaSkill([]).replace(
      '|---|---|---|\n',
      [
        '|---|---|---|',
        '| 代码已写完 | `verification` → `code-review` | 互斥规则 2 |',
        '| 周期节点 | `retro`/`health`/`learnings` | 显式触发 |',
        '',
      ].join('\n')
    );
    makeSkill(root, 'workflow', meta);
    const r = run(root, { expect: 'workflow' });
    // 复合行拆词 + 基线 Scout 三行（metaSkill 自动附加）一并入 refs
    assert.deepEqual(r.report.checked.routingRefs, [
      'code-review',
      'disposable-build',
      'health',
      'learnings',
      'retro',
      'scout',
      'spike-run',
      'verification',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：跨插件引用（spike-run/disposable-build）在 scout/skills 存在时通过，报告登记 externalRefs', () => {
  // 目录布局模拟仓库根：root/workflow/skills（skillsRoot，两层嵌套与真实仓库一致，
  // resolver 按上溯两级定位仓库根）+ root/scout/skills（兄弟插件）
  const root = mkdtempSync(join(tmpdir(), 'routing-ext-'));
  const skillsRoot = join(root, 'workflow', 'skills');
  try {
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(join(root, 'scout', 'skills', 'spike-run'), { recursive: true });
    mkdirSync(join(root, 'scout', 'skills', 'disposable-build'), { recursive: true });
    writeFileSync(join(root, 'scout', 'skills', 'spike-run', 'SKILL.md'), entrySkill('spike-run'));
    writeFileSync(join(root, 'scout', 'skills', 'disposable-build', 'SKILL.md'), entrySkill('disposable-build'));
    const meta = metaSkill(['idea-review', 'spike-run', 'disposable-build']);
    makeSkill(skillsRoot, 'workflow', meta);
    makeSkill(skillsRoot, 'idea-review', entrySkill('idea-review'));
    const r = run(skillsRoot, { expect: 'workflow,idea-review' });
    assert.equal(r.status, 0);
    assert.deepEqual(r.report.checked.externalRefs, ['disposable-build', 'spike-run']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：期望内入口未收录进路由表入口资产 → 违规则含 entry-asset-incomplete（2026-09-15 激活域批次）', () => {
  const root = tempRoot();
  try {
    // 期望清单内的合格入口（目录+frontmatter 通过）但不在 ROUTING_ENTRY_SKILLS 资产内——
    // 运行时声明成员校验会把它误拒，lint 必须提前报资产漏收
    makeSkill(root, 'workflow', metaSkill([])); // 路由表仅 Scout 三行基线
    makeSkill(root, 'fake-entry', entrySkill('fake-entry'));
    const r = run(root, { expect: 'workflow,fake-entry' });
    assert.equal(r.status, 1);
    assert.ok(
      r.report.violations.some((v) => v.rule === 'entry-asset-incomplete' && v.message.includes('fake-entry')),
      `资产漏收期望内入口须报 entry-asset-incomplete（收到：${JSON.stringify(r.report.violations)}）`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：全量模式下资产入口缺表行 → 违规则含 routing-entry-missing（资产与表漂移守卫）', () => {
  // 仓库形态布局（跨插件 resolver 上溯两级）+ 全量模式（2b 仅全量执行：增量容忍残缺表）
  const root = mkdtempSync(join(tmpdir(), 'routing-asset-'));
  const skillsRoot = join(root, 'workflow', 'skills');
  try {
    mkdirSync(skillsRoot, { recursive: true });
    // direction 1 存在性：scout 插件目录（spike-run 行将被删除，其目录仍建无妨）；algo-loop 可选插件目录（内部决策-046）
    for (const n of ['scout', 'spike-run', 'disposable-build']) {
      mkdirSync(join(root, 'scout', 'skills', n), { recursive: true });
      writeFileSync(join(root, 'scout', 'skills', n, 'SKILL.md'), entrySkill(n));
    }
    mkdirSync(join(root, 'algo-loop', 'skills', 'algo-loop'), { recursive: true });
    writeFileSync(join(root, 'algo-loop', 'skills', 'algo-loop', 'SKILL.md'), entrySkill('algo-loop'));
    // 内部任务-109 研究环两行（内部决策-047）：可选插件目录＋表行（21 成员口径）
    for (const n of ['research-hypothesis', 'experiment-design']) {
      mkdirSync(join(root, 'research-loop', 'skills', n), { recursive: true });
      writeFileSync(join(root, 'research-loop', 'skills', n, 'SKILL.md'), entrySkill(n));
    }
    // 全量模式缺 REQUIRED 目录即 missing-skill——fixture 须 20 目录齐全（与本案无关的红要排除）
    const LOCAL20 = [
      'workflow', 'idea-review', 'brainstorming', 'plan-writing', 'plan-review', 'plan-execution',
      'code-discipline', 'doc-discipline', 'tdd', 'root-cause-debugging', 'code-review', 'production-change',
      'verification', 'branch-finishing', 'retro', 'learnings', 'health', 'architecture-evolve', 'external-radar', 'writing-skills',
    ];
    for (const n of LOCAL20.filter((x) => x !== 'workflow')) makeSkill(skillsRoot, n, entrySkill(n));
    // 完整路由表（14 本地入口 + team-governance/algo-loop/研究环两行）但删去 spike-run 行 → 资产⊄表
    const spikeRow = '| 有效 explore 模式兜底 | `spike-run` | 项目根有效 mode=explore 且未命中其余行 |';
    const meta = metaSkill([
      'idea-review', 'brainstorming', 'plan-writing', 'plan-review', 'plan-execution',
      'root-cause-debugging', 'code-review', 'production-change', 'verification',
      'branch-finishing', 'retro', 'learnings', 'health', 'architecture-evolve', 'external-radar', 'team-governance', 'algo-loop',
      'research-hypothesis', 'experiment-design',
    ]).replace(`${spikeRow}\n`, '');
    makeSkill(skillsRoot, 'workflow', meta);
    const r = run(skillsRoot, {}); // 全量模式
    assert.equal(r.status, 1);
    const drift = r.report.violations.filter((v) => v.rule === 'routing-entry-missing');
    assert.equal(drift.length, 1, `恰好一条资产漂移违例（收到：${JSON.stringify(r.report.violations)}）`);
    assert.ok(drift[0].message.includes('spike-run'), '缺行的跨插件入口被点名');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：跨插件引用在 scout/skills 缺失时报 missing-skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-ext-'));
  const skillsRoot = join(root, 'workflow', 'skills');
  try {
    mkdirSync(skillsRoot, { recursive: true });
    const meta = metaSkill(['idea-review', 'spike-run']);
    makeSkill(skillsRoot, 'workflow', meta);
    makeSkill(skillsRoot, 'idea-review', entrySkill('idea-review'));
    // 把外部 skill 放进期望清单：增量模式的「未来批次容忍」不适用于期望内引用，
    // 缺失必须报违例（外部引用被显式期待时的缺席不是未来批次）。
    // 断言收紧到方向 1 的跨插件违例特征——否则 checkDirectories 的同名违例会让
    // 本用例在删掉跨插件逻辑后依然绿（评审 T2）
    const r = run(skillsRoot, { expect: 'workflow,idea-review,spike-run' });
    assert.equal(r.status, 1);
    assert.ok(
      r.report.violations.some((v) => v.rule === 'missing-skill' && v.message.includes('跨插件白名单映射'))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 行号核验环（e 环）夹具仓库：root/workflow/skills + root/scout/skills，
 * scout SKILL.md 含一条「路由表第 N 行」引用（N 由 refs 决定：refs=['idea-review'] 时
 * scout 生命周期行=第 2 行）。
 * @param {string} root 夹具仓库根
 * @param {number} claimed scout 文档声明的行号
 */
function lineRefFixture(root, claimed) {
  const skillsRoot = join(root, 'workflow', 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  makeSkill(skillsRoot, 'workflow', metaSkill(['idea-review']));
  mkdirSync(join(root, 'scout', 'skills', 'scout'), { recursive: true });
  writeFileSync(
    join(root, 'scout', 'skills', 'scout', 'SKILL.md'),
    `---
name: scout
description: 探路模式元技能 —— 触发条件：workflow 路由表第 ${claimed} 行命中后进入。
license: MIT
---

# scout
`,
  );
  return skillsRoot;
}

test('路由：行号引用漂移（e 环）→ 退出 1，line-ref-drift 指名文件与行号（2026-09-17 使用反馈二批）', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-lineref-'));
  try {
    const skillsRoot = lineRefFixture(root, 99); // 夹具表中 scout 生命周期行=第 2 行
    const r = run(skillsRoot, { expect: 'workflow' });
    assert.equal(r.status, 1);
    const drift = r.report.violations.filter((v) => v.rule === 'line-ref-drift');
    assert.equal(drift.length, 1, `恰一条行号漂移违例（收到：${JSON.stringify(r.report.violations)}）`);
    assert.ok(drift[0].message.includes('scout/skills/scout/SKILL.md:3'), '指名文件与行号');
    assert.ok(drift[0].message.includes('声明第 99 行，实际第 2 行'), '声明值与实算值并陈');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：行号引用正确（e 环）→ 退出 0（2026-09-17 使用反馈二批）', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-lineref-'));
  try {
    const skillsRoot = lineRefFixture(root, 2); // 与夹具表实算行号一致
    const r = run(skillsRoot, { expect: 'workflow' });
    assert.equal(r.status, 0);
    assert.deepEqual(r.report.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路由：缺省 skillsRoot 按脚本位置解析——异目录 cwd 不再出全量 skill 缺失假报告（2026-09-17）', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'routing-cwd-'));
  try {
    // 不传 skillsRoot 参数、cwd 设为非仓库目录：缺省须锚定脚本位置（真实仓库 workflow/skills）
    const env = { ...process.env };
    delete env.ROUTING_EXPECT;
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env, cwd: foreign });
    const report = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `真实仓库检查须通过（stderr：${r.stderr}）`);
    assert.ok(report.checked.skillsRoot.endsWith('workflow\\skills') || report.checked.skillsRoot.endsWith('workflow/skills'), 'skillsRoot 为脚本定位的绝对路径');
    // 下界口径：只锁「非 0 命中」这一回归（异目录 cwd 假报告），精确计数由 lint 与
    // REQUIRED_SKILLS 清单断言负责（内部验收-2），此处刻意不写死避免随 skill 增删双改
    assert.ok(report.checked.present.length >= 18, '非 0 个 skill 命中（假报告回归锁死）');
    // 内部验收-8/内部验收-6：REQUIRED 清单 20 与第 20 个 skill 成员由自动化锁定（防删清单后 lint 静默失效）
    assert.equal(report.checked.expected.length, 20, 'REQUIRED_SKILLS 须为 20');
    assert.ok(report.checked.expected.includes('architecture-evolve'), 'architecture-evolve 须在 REQUIRED 清单');
    assert.ok(report.checked.expected.includes('external-radar'), 'external-radar 须在 REQUIRED 清单');
    // 内部验收-6：周期节点行目标列含 external-radar 且路由表仍 18 行（防目标列静默挪行/删行）
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const meta = readFileSync(join(ROOT, 'workflow', 'skills', 'workflow', 'SKILL.md'), 'utf8');
    const cycleRow = meta.split('\n').find((l) => l.startsWith('| 周期节点 |'));
    assert.ok(cycleRow && cycleRow.includes('`external-radar`'), '周期节点行目标列须含 external-radar');
    const table = meta.slice(meta.indexOf('## 路由表'), meta.indexOf('两条互斥规则'));
    const dataRows = table.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('用户状态'));
    assert.equal(dataRows.length, 18, '路由表数据行仍须 18（周期节点行不得新增行）');
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

// 内部任务-214 批 1 新增（内部验收-2/内部验收-18/内部验收-19/内部验收-10 共享锚）：真仓全量 lint 零违例。
test('r1) 真仓全量 lint 零违例（20 description 与表一致；含算法迭代行与研究环两行；N description 口径）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = run(join(ROOT, 'workflow', 'skills'));
  assert.equal(r.status, 0, `真仓全量 lint 须零违例：${r.stderr ?? ''}`);
  assert.equal(r.report?.checked?.expected?.length, 20, 'REQUIRED_SKILLS 20 与 description 口径一致');
  const refs = r.report?.checked?.routingRefs ?? [];
  assert.ok(refs.includes('algo-loop'), '算法迭代行对应 skill 在位');
  assert.ok(refs.includes('research-hypothesis'), '研究环假设行对应 skill 在位');
  assert.ok(refs.includes('experiment-design'), '研究环实验设计行对应 skill 在位');
});

test('r2) 真仓 Scout 三行单目标与条件互斥零违例', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = run(join(ROOT, 'workflow', 'skills'));
  assert.equal(r.status, 0, `真仓 Scout 三行互斥 lint 须零违例：${r.stderr ?? ''}`);
  const refs = r.report?.checked?.routingRefs ?? [];
  for (const skill of ['scout', 'spike-run', 'disposable-build']) {
    assert.ok(refs.includes(skill), `Scout 三行 skill 在位：${skill}`);
  }
});

// 内部任务-214 批 3（内部验收-3）：治理操作行定位＋可选插件三态不误路由。
test('路由：第 9 行治理操作行目标 team-governance 且可选插件三态不误路由', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = run(join(ROOT, 'workflow', 'skills'));
  assert.equal(r.status, 0, `真仓全量 lint 须零违例：${r.stderr ?? ''}`);
  const refs = r.report?.checked?.routingRefs ?? [];
  assert.ok(refs.includes('team-governance'), '路由表含 team-governance 入口');
  const meta = readFileSync(join(ROOT, 'workflow', 'skills', 'workflow', 'SKILL.md'), 'utf8');
  const table = meta.slice(meta.indexOf('## 路由表'), meta.indexOf('两条互斥规则'));
  const rows = table.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('用户状态'));
  const idx = rows.findIndex((l) => l.includes('`team-governance`'));
  assert.equal(idx + 1, 9, '治理操作行须为路由表第 9 行');
  assert.ok(rows[idx].includes('治理操作意图'), '第 9 行显式触发条件含治理操作意图');
  // 可选插件三态（未安装不报结构错/已安装校验/映射声明）以 lint 源码契约机检
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(/team-governance':\s*\{\s*plugin:\s*'team-governance',\s*optional:\s*true\s*\}/.test(src),
    'team-governance 在可选插件映射中声明 optional: true');
  assert.ok(src.includes('缺失时不报结构错'), '可选插件缺失不报结构错的契约在位');
  for (const [name, plugin] of [['algo-loop', 'algo-loop'], ['research-hypothesis', 'research-loop']]) {
    assert.ok(new RegExp(`'${name}':\\s*\\{\\s*plugin:\\s*'${plugin}',\\s*optional:\\s*true\\s*\\}`).test(src),
      `可选插件映射覆盖面在位：${name}（${plugin}）`);
  }
});
