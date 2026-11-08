// 文件：research-loop/tests/skills-contract.test.mjs
// 描述：research-loop 两个 SKILL 的契约测试——frontmatter 形态（恰 name/description/license、
//       含「触发条件」）/路由两行双侧一致（意图词 c1↔description、门槛句逐句在 c3）/六样例判定面
//       （判别句→所在面文本矩阵）/禁行号字面量/无第二判定源/域锚定红线自查。
//       内部任务-270 评审修复批：R11 列职责切分、R12 frontmatter 键集合、R13 六样例判定面。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 research-loop/LICENSE）
// 修改记录：
//   v1.0.0 2026-10-16 wangp 初始创建（内部任务-109 S1 步骤 1.2，RED 先行）
//   v1.0.1 2026-11-01 wangp 内部任务-270：R11 路由列切分（c1↔desc、c3 门槛句）/R12 三键集合/
//           R13 六样例判定面新增用例；文件头规范化
// 自检：node --test "research-loop/tests/skills-contract.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const SKILLS = ['research-hypothesis', 'experiment-design'];

// 域锚定红线词表（与 scripts/check-repo-consistency.mjs 第 20 块同源口径；此处为 skill 资产自查副本）
const DOMAIN_ANCHOR_RE =
  /临床|患者|受试者|诊断|治疗|剂量|IRB|伦理审查|IACUC|生物安全|病原体|双用途|GUM|不确定度预算|单位传播|无量纲数|雷诺数/;

function readSkill(name) {
  const p = join(pluginRoot, 'skills', name, 'SKILL.md');
  return { p, text: existsSync(p) ? readFileSync(p, 'utf8') : null };
}

/** 解析 frontmatter 为键值对象（键值形态非法时直接失败，不静默跳过）。 */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    assert.ok(kv, `frontmatter 行非 key: value 形态：${line}`);
    fm[kv[1]] = kv[2];
  }
  return fm;
}

/** 剥离薄边界指针句（行内含「边界指针」明示标记的行豁免词表扫描——与第 20 块判法一致） */
function stripBoundaryPointerLines(text) {
  return text
    .split('\n')
    .filter((l) => !l.includes('边界指针'))
    .join('\n');
}

/** 路由表数据行按**未转义竖线**切列：cells[1]＝用户状态、cells[2]＝路由到、cells[3]＝显式触发条件；
 *  行内 `\|` 为 Markdown 表格转义（如 `--exempt-scope plan\|review`），切分时保留后还原为 `|`。 */
function routeRows(meta) {
  return meta
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split(/(?<!\\)\|/).map((s) => s.trim().replaceAll('\\|', '|')));
}

/** 按「路由到」列反引号技能名找行；找不到即失败。 */
function rowFor(rows, name) {
  const row = rows.find((c) => c.length === 5 && c[2] === `\`${name}\``);
  assert.ok(row, `路由表缺 \`${name}\` 行`);
  return row;
}

/** 六样例判定面：逐句断言「判别句 → 所在面」（TEST-FROZEN 内部任务-270 规格冻结第 7 条）。 */
function assertSixSampleMatrix(meta) {
  const rows = routeRows(meta);
  const rh = rowFor(rows, 'research-hypothesis');
  const ed = rowFor(rows, 'experiment-design');
  const algo = rowFor(rows, 'algo-loop');
  const planExec = rowFor(rows, 'plan-execution');
  const rootCause = rowFor(rows, 'root-cause-debugging');
  const scoutRows = rows.filter((c) => c.length === 5 && ['`spike-run`', '`disposable-build`'].includes(c[2]));
  assert.ok(scoutRows.length >= 1, '路由表缺 Scout 兜底行');

  // ① 显式假设检验/预注册 → research-hypothesis 行（c3 触发意图＋c1 用户状态）
  assert.ok(rh[3].includes('显式科研假设/检验/预注册意图'), '① c3 缺显式科研假设/检验/预注册意图');
  assert.ok(rh[1].includes('科研问题/假设检验/预注册意图'), '① c1 缺科研问题/假设检验/预注册意图');

  // ② 显式消融/对照 → experiment-design 行
  assert.ok(ed[3].includes('显式实验设计意图'), '② c3 缺显式实验设计意图');
  assert.ok(ed[1].includes('消融/基准/种子对照/运行序'), '② c1 缺消融/基准/种子对照/运行序');

  // ③ 调参改进实现 → 目的判据分界文案在研究环两行区域切片（实际命中 research-hypothesis 行）
  const loopRegion = `${rh.join('|')}\n${ed.join('|')}`;
  assert.ok(loopRegion.includes('改进实现/产品指标→算法迭代行'), '③ 研究环两行区域缺目的判据分界文案');
  assert.ok(rh[3].includes('改进实现/产品指标→算法迭代行'), '③ 目的判据分界文案实际命中 research-hypothesis 行（记录命中行）');
  assert.ok(algo[1].includes('算法迭代'), '③ algo-loop 行 c1 缺算法迭代');

  // ④ 进行中获批计划的研究类任务 → 计划优先在研究环两行；plan-execution 行含「计划已批准」
  for (const [label, row] of [['research-hypothesis', rh], ['experiment-design', ed]]) {
    assert.ok(row[3].includes('无进行中获批准计划（计划优先走 plan-execution 行）'), `④ ${label} c3 缺计划优先句`);
  }
  assert.ok(planExec[1].includes('计划已批准'), '④ plan-execution 行 c1 缺「计划已批准」');

  // ⑤ scout disposable＋科研意图 → 纪律档压探索档在研究环两行；Scout 兜底行含「未命中其余 15 行」
  for (const [label, row] of [['research-hypothesis', rh], ['experiment-design', ed]]) {
    assert.ok(row[3].includes('与 Scout 三行同命中时本行优先（纪律档压探索档）'), `⑤ ${label} c3 缺纪律档压探索档句`);
  }
  for (const row of scoutRows) assert.ok(row[3].includes('未命中其余 15 行'), '⑤ Scout 兜底行缺「未命中其余 15 行」');

  // ⑥ 研究代码 bug 报告 → root-cause-debugging 行＋互斥规则节「互斥规则 1（调试禁执行）」
  assert.ok(rootCause[1].includes('报 bug/异常/回归'), '⑥ root-cause-debugging 行 c1 缺报 bug/异常/回归');
  const rulesStart = meta.indexOf('两条互斥规则');
  const rulesEnd = meta.indexOf('## 全局规则', rulesStart);
  const rulesSection = rulesStart >= 0 ? meta.slice(rulesStart, rulesEnd < 0 ? meta.length : rulesEnd) : '';
  assert.ok(rulesSection.includes('互斥规则 1（调试禁执行）'), '⑥ 互斥规则节缺「互斥规则 1（调试禁执行）」');
}

test('两 SKILL.md 在场且 frontmatter 三键可解析（硬规则 1：恰 name/description/license）', () => {
  for (const name of SKILLS) {
    const { p, text } = readSkill(name);
    assert.ok(text, `缺失 ${p}`);
    const fm = parseFrontmatter(text);
    assert.ok(fm, `${name} frontmatter 不可解析`);
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'license', 'name'], `${name} frontmatter 须恰三键（name/description/license）`);
    assert.equal(fm.name, name, `${name} fm.name 与目录名一致`);
    assert.ok(fm.description && fm.description.length >= 30, `${name} description ≥30 字`);
    assert.equal(fm.license, 'MIT', `${name} license=MIT`);
  }
  // 负样本自检：第 4 键字面量样本必须使「恰三键」断言失败（内存样本，不写文件）
  const fourKeys = parseFrontmatter('---\nname: x\ndescription: y\nlicense: MIT\nallowed-tools: Read\n---\n');
  assert.notDeepEqual(Object.keys(fourKeys).sort(), ['description', 'license', 'name'], '负样本：第 4 键须被键集合断言拒绝');
});

test('description 含「触发条件」且与路由行关键词双侧一致（R11 列职责切分：意图词 c1↔desc、门槛句在 c3）', () => {
  const meta = readFileSync(join(pluginRoot, '..', 'workflow', 'skills', 'workflow', 'SKILL.md'), 'utf8');
  const rows = routeRows(meta);
  // 负样本自检：行内转义竖线不得被当作列分隔（路由表 plan-execution 行含 `plan\|review` 等）
  const escaped = routeRows('| a | `x` | b \\| c |')[0];
  assert.equal(escaped.length, 5, '负样本：转义竖线行应切出 5 列');
  assert.equal(escaped[3], 'b | c', '负样本：转义竖线须还原为字面 |');
  assert.notEqual('| a | `x` | b \\| c |'.split('|').length, 5, '负样本：裸 split 会切出 6 段（非 5 列），故需转义感知切分');
  const SPEC = {
    'research-hypothesis': {
      intent: ['科研问题', '假设检验', '预注册'],
      gate: [
        '无进行中获批准计划（计划优先走 plan-execution 行）',
        '目的判据',
        '两可时向用户澄清不得猜',
        '与 Scout 三行同命中时本行优先（纪律档压探索档）',
        '插件未安装时输出可行动安装指引',
      ],
    },
    'experiment-design': {
      intent: ['实验设计', '消融', '基准', '种子', '运行序'],
      gate: [
        '无进行中获批准计划（计划优先走 plan-execution 行）',
        '目的判据',
        '两可澄清不猜',
        '与 Scout 三行同命中时本行优先（纪律档压探索档）',
        '插件未安装时输出可行动安装指引',
        '研究假设行优先',
      ],
    },
  };
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.ok(text, `${name} 缺失`);
    const fm = parseFrontmatter(text);
    assert.ok(fm.description.includes('触发条件'), `${name} description 含「触发条件」`);
    const row = rowFor(rows, name);
    for (const kw of SPEC[name].intent) {
      assert.ok(row[1].includes(kw), `${name} 用户状态列（c1）缺意图词 ${kw}`);
      assert.ok(fm.description.includes(kw), `${name} description 缺意图词 ${kw}`);
    }
    for (const phrase of SPEC[name].gate) {
      assert.ok(row[3].includes(phrase), `${name} 显式触发条件列（c3）缺门槛句：${phrase}`);
    }
  }
});

test('路由六样例判定面（判别句→所在面文本矩阵）', () => {
  const meta = readFileSync(join(pluginRoot, '..', 'workflow', 'skills', 'workflow', 'SKILL.md'), 'utf8');
  assertSixSampleMatrix(meta);
});

test('禁行号字面量（内部决策-4 同构：以行名/插件名指代）', () => {
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.ok(text, `${name} 缺失`);
    assert.doesNotMatch(text, /路由表第/, `${name} 不嵌「路由表第 N 行」字面量`);
  }
});

test('无第二判定源：正文含唯一判定指针、无自建判定表', () => {
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.ok(text, `${name} 缺失`);
    assert.match(text, /workflow 路由表/, `${name} 指向 workflow 路由表（唯一判定源 B-M1-1）`);
    // 负向断言锚功能性判定语言；边界节「禁止自建场景判定表」类合规表述不误伤
    assert.doesNotMatch(text, /本判定表|下表判定|按表命中/, `${name} 不含自建判定表的功能性表述`);
  }
});

test('域锚定红线自查（第 20 块同源词表，薄边界指针行豁免）', () => {
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.ok(text, `${name} 缺失`);
    const stripped = stripBoundaryPointerLines(text);
    assert.doesNotMatch(stripped, DOMAIN_ANCHOR_RE, `${name} 域锚定红线词命中`);
  }
});
