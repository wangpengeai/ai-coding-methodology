// 文件：skills-text.test.mjs
// 描述：技能正文契约的回归锁（内部规则-10/内部规则-3/T-M6-2 的机械锁定）——三族断言：
//       a) 路由表必须含「用户请求审查」行（PD-1：用户侧审查入口的合法路径存在性，
//          B-M1-3 与 code-review description 的联动基线）；
//       b) 8 个场景入口 skill 正文必须含 learnings 收尾移交锚点（T-M6-2 的承接
//          方在 learnings 单方面引用、上游零实现的规格-实现脱节修复后，防止回退）；
//       c) 内部决策-039 交割面与文档纪律锚点（2026-10-05，内部任务-HANDOFF-1）——过程/归档
//          分界条、doc-discipline 七条款、未决项移交核对行与两处指针。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；锚点用短语而非整句，容许措辞演进。
//       d 族（2026-10-06 内部任务-5，契约A 正文语义锁）：F1/F2/F3/F4/F11 与 F12 防绕过在技能
//       正文的落点——断言读实际章段（红旗表/计划格式契约/凭据链签发节切片），不以全文件
//       同词凑绿；既有 a/b/c 族 12 项保持不动。
//       f14-f17（2026-10-21 内部任务-189）：代理实例复用与再水化（内部规则-23）——读全局规则/模式 B+C/
//       两 skill 复审矩阵/内部规则-17 切片；反向断言禁宿主工具名与宿主术语（核心资产中立）。
//       f18（2026-10-21 内部任务-191）：链身份/跨任务=新链/再水化不计入＋plan-review 派发契约＋
//       code-review provenance 口径。
//       f19/f20（2026-10-22 内部任务-199 批 2）：f19＝计划期多宿主适配评估门禁（内部决策-056/内部规则-18，
//       格式契约第 8 条＋受理条）；f20＝元技能全局「阻塞停机协议」条（内部规则-24/内部决策-053 修正案，
//       含反向断言宿主术语零命中）。
//       f21-f23（2026-10-23 内部任务-220）：桥接通道复用纪律与稀缺资源定位——f21＝内部规则-23 通道政策＋
//       可续性探测程序（全局规则切片＋宿主中立反向断言）；f22＝plan-review/code-review 复审矩阵
//       「通道选择与复用步骤」；f23＝plan-execution 模式 B 探测程序/回派/续聊入口。
//       f24/f25（2026-10-23 内部任务-225）：设计—测试锚定门禁（内部决策-060/内部规则-19/内部规则-20）——f24＝
//       plan-writing 格式契约第 9 条「测试锚定」节＋plan-review 受理执行锚＋内部模块-3 登记；f25＝
//       批次级基线收缩联动（同批收缩/不收缩显式理由）与 内部规则-20/内部验收-20 登记。
//       f26（2026-10-23 内部任务-186）：doc-discipline 纪律七第五类受众「外部合同交付」＋内部模块-2 内部规则-9/内部验收-8 登记（内部决策-062）。
//       f13 更新＋f33-f36b（2026-11-06 内部任务-342，内部决策-069/内部需求-30）：评审→修复→复审机制——五因子反 churn、fix-induced 标注、修复设计决策四字段、每轮 fresh 回归、批次 full 双向独立、评审输出三件套。
//       内部未决-210 转锚族（2026-11-07 内部任务-347 B2）：六条文本行为锚（内部规则-6/内部模块-4-7/内部模块-5-3/内部模块-5-7/内部模块-9-4/内部模块-9-5）
//       ——断言既有受控文本（判别力由「改文本必红」承载，片段文件内恰一），为 内部未决-210 backlog 收缩转锚。
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const SPEC_GATE_SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec-gate', 'skills');
const SCOUT_SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scout', 'skills');
const TG_COMMANDS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'team-governance', 'commands');
const SPECS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'specs');
// 公开包守卫（内部任务-365）：specs/ 未随公开包发布；且公开包 skill 散文按散文面改写——
// 本文件整体断言源仓散文，公开包内声明 SKIP（源仓照跑）。
const HAS_SPECS = existsSync(SPECS);
const IS_SOURCE_REPO = existsSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), '.deliver'));
// 保留 `test(` 调用形态（锚定索引按此解析）；公开包内整体降级为 skip。
const test = IS_SOURCE_REPO ? nodeTest : nodeTest.skip;

/**
 * 取指定标题节的正文（到下一个任意级别标题行）——d 族断言面向实际章段，
 * 防止全文件任意位置的同词命中凑绿（总计划步骤 2 验收）。
 * @param {string} text 技能正文
 * @param {string} heading 标题全形态（如 '## 红旗反合理化表' / '### 凭据链签发'）
 * @returns {string} 命中节正文（含标题行）；未命中返回空串（后续断言即红）
 */
function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start);
  const nl = rest.indexOf('\n#');
  return nl === -1 ? rest : rest.slice(0, nl);
}

/** learnings 收尾移交锚点（统一措辞的可识别片段） */
const LEARNINGS_ANCHOR = '记一条 learning';
/** 8 个场景入口 skill（表外 skill 与元技能不在 T-M6-2 移交义务内） */
const ENTRY_SKILLS = [
  'idea-review',
  'brainstorming',
  'plan-writing',
  'plan-review',
  'plan-execution',
  'root-cause-debugging',
  'code-review',
  'verification',
];

test('a) 路由表含「用户请求审查」行且指向 code-review（R-M1-10）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const rows = meta
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .filter((l) => l.includes('`code-review`'));
  const hit = rows.find((l) => l.includes('用户请求审查'));
  assert.ok(hit, '路由表须含「用户请求审查/审计既有代码」行——否则用户侧审查入口无合法路径（PD-1）');
  assert.ok(hit.includes('非助手完成声称') || hit.includes('非完成声称'), '该行触发条件须与「代码已写完」行可区分（B-M1-3 唯一命中）');
});

test('a2) code-review description 与新行联动（B-M1-3）', () => {
  const fm = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8').split('---')[1] ?? '';
  assert.ok(fm.includes('用户要求审查'), 'code-review description 须含用户侧触发词（路由表与 description 不一致即校验失败）');
});

test('a3) 元技能红旗表含「代码量大收尾统一评审」条目（2026-09-16 使用反馈批次 P2）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const row = meta
    .split('\n')
    .find((l) => l.includes('代码量大，收尾统一评审更高效'));
  assert.ok(row, '红旗表须含「代码量大，收尾统一评审更高效」——缺该行则大 diff 单次评审被当成效率优化');
  assert.ok(
    row.includes('混成一锅') && row.includes('plan-execution'),
    '反驳须点名「阶段偏差与局部缺陷混成一锅」并指向 plan-execution 阶段复审节（指针式，禁转述判据）',
  );
});

test('a4) 元技能全局规则含长任务阶段复审指针条（2026-09-16 使用反馈批次 P2）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.includes('长任务阶段复审（指针条）'));
  assert.ok(line, '全局规则须含长任务阶段复审指针条——该功能只在不自动注入的 plan-execution 正文里会被跳过');
  assert.ok(line.includes('只做指针'), '指针条须明示「不转述判据」（双写漂移防线，learnings 2026-09-14 同款）');
});

test('b) 8 个场景入口 skill 正文含 learnings 收尾移交锚点（T-M6-2）', () => {
  const missing = [];
  for (const name of ENTRY_SKILLS) {
    const file = join(SKILLS, name, 'SKILL.md');
    assert.ok(existsSync(file), `skill 文件缺失：${name}`);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(LEARNINGS_ANCHOR)) missing.push(name);
  }
  assert.deepEqual(missing, [], `以下入口 skill 缺 learnings 收尾移交锚点（T-M6-2 承接链断裂）：${missing.join(', ')}`);
});

test('b3) branch-finishing 含工具链观察汇总可选项（2026-09-20 使用反馈三批，收尾反馈环）', () => {
  const text = readFileSync(join(SKILLS, 'branch-finishing', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('工具链观察汇总'), 'branch-finishing 第 4 步须含「工具链观察汇总」可选项');
  assert.ok(text.includes('无观察'), '工具链观察汇总须含「无观察」显式跳过出口');
  assert.ok(text.includes('OPEN-n'), '登记分流须指向 OPEN-n（经 spec-gate 流程，不直接写 specs/）');
});

test('b4) learnings 场景示例含工具链（缺陷观察可记一句话经验）', () => {
  const text = readFileSync(join(SKILLS, 'learnings', 'SKILL.md'), 'utf8');
  assert.ok(/场景.*工具链|工具链.*场景/.test(text), 'learnings「场景」取值示例须点名工具链');
});

test('b5) learnings 定期梳理节含四动作与守恒纪律（DEV-117：真系统化+归档机制）', () => {
  const text = readFileSync(join(SKILLS, 'learnings', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('四动作'), '梳理节须明示四动作（保留/并入同族/归档/删除）');
  assert.ok(text.includes('learnings-archive.md'), '归档载体 learnings-archive.md 须在案（长期维护历史实录）');
  assert.ok(text.includes('守恒'), '留痕须含条目守恒算式（前=保留+并族+归档+删除）');
  assert.ok(text.includes('全量处置'), '触发后必须全量处置——批量豁免非法');
  assert.ok(text.includes('禁止以删除替代归档'), '归档通道不得被删除压条数绕开');
});

// ── c 族：内部决策-039 交割面与文档纪律锚点（2026-10-05，内部任务-HANDOFF-1）──────────
// 为什么这一族存在：c1/c3 锁「过程文件里的未决项必须移交权威台账」的判据有载体
// （缺陷 A），c2 锁「文档与注释该怎么写」的正面规则有单一出处（缺陷 B）——
// 二者此前的真实故障是条款无处可查、无处可引，靠人撞。

test('c1) 元技能全局规则含「过程资产与归档资产分界」条（R-M1-15，ADR-039）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.includes('过程资产与归档资产分界'));
  assert.ok(line, '全局规则须含过程/归档分界条——缺陷 A/B 的分义定义无载体即回退');
  assert.ok(line.includes('不是事实源'), '铁律①：过程文件不是事实源');
  assert.ok(line.includes('经移交动作'), '铁律②：归档文件只收经移交动作的内容');
});

test('c2) doc-discipline 七条款锚点与 frontmatter（R-M2-6，ADR-039）', () => {
  const file = join(SKILLS, 'doc-discipline', 'SKILL.md');
  assert.ok(existsSync(file), 'doc-discipline skill 文件缺失');
  const text = readFileSync(file, 'utf8');
  const fm = text.split('---')[1] ?? '';
  assert.ok(fm.includes('description:') && fm.includes('触发条件'), 'description 须含显式触发条件（R-M1-2）');
  for (const anchor of ['而非「是什么」', '高危失效面', '改它的正确路径', '同一变更单元', '不混写', '过程文件豁免', '受众分层']) {
    assert.ok(text.includes(anchor), `doc-discipline 缺七条款锚点：${anchor}`);
  }
});

test('c3) branch-finishing 前置核对表含「未决项移交」行（R-M6-10，ADR-039）', () => {
  const text = readFileSync(join(SKILLS, 'branch-finishing', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('未决项移交'), '前置核对表须含未决项移交核对行');
  assert.ok(text.includes('权威台账'), '义务全文须含权威台账双通道声明');
  assert.ok(text.includes('未移交即收尾不成立'), '义务全文须含「未移交即收尾不成立」硬结论');
});

test('c3b) branch-finishing 前置核对表含「自察归属记录」行且两态口径分立（ADR-041，DEV-79 终评处置）', () => {
  const text = readFileSync(join(SKILLS, 'branch-finishing', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('自察归属记录（ADR-041）'), '前置核对表须含自察归属记录核对行');
  assert.ok(text.includes('warning 级不阻断'), '归属残留为 warning 级（B-M15-6 上界）');
  assert.ok(text.includes('--matching-excluded'), '批量处置入口指针在位');
  assert.ok(text.includes('本会话新增'), '接口行须分立「本会话新增留痕」与「归属残留不阻断」两态口径');
  assert.ok(text.includes('本任务归属待排查记录'), '归属行文案须更名待排查（ADR-041 修正案 1 / DEV-215）');
  assert.ok(text.includes('证据面 `probe-noise`/`replayable-rejection`/`mechanism-trace` 不计'), '归属行须声明证据面不计（ADR-063 D4.2）');
});

test('c4) plan-execution 收尾含未决项移交指针且随行纪律点名 doc-discipline（R-M4-10）', () => {
  const text = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  const pointer = text.split('\n').find((l) => l.includes('未决项移交') && l.includes('branch-finishing'));
  assert.ok(pointer, '收尾节须含未决项移交指针（指向 branch-finishing 义务全文）');
  // 随行纪律条目须落在「执行期随行纪律」节内——不限节匹配会被接口节同名词条顶替而假绿
  const discipline = text.split('### 执行期随行纪律')[1]?.split('###')[0] ?? '';
  assert.ok(discipline.includes('doc-discipline'), '「执行期随行纪律」节须点名 doc-discipline（该节是唯一随行条款载体）');
});

test('c5) code-review 检查单含「文档与注释同步性」项且会话收尾含移交指针（R-M5-13）', () => {
  const checklist = readFileSync(join(SKILLS, 'code-review', 'checklist.md'), 'utf8');
  assert.ok(checklist.includes('文档与注释同步性'), 'checklist.md NORMAL 表须含文档与注释同步性检查点');
  const text = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const pointer = text.split('\n').find((l) => l.includes('未决项移交') && l.includes('branch-finishing'));
  assert.ok(pointer, '会话收尾须含未决项移交指针（指向 branch-finishing 义务全文）');
});

// ── d 族：内部任务-5 契约A 正文语义锁（2026-10-06）──────────────────────────────
// 为什么这一族存在：F1–F4/F11/F12 的规则语义需要技能正文载体（写者权限≠执行批准、
// 规则冲突不得自授权、verification 仅阶段结论、full/scout-repro 分工、原创归档条件、
// 「先改权限规则就能继续」红旗封堵）——正文缺载体即回退为靠人撞的口头规则。

test('d1) 元技能红旗表含「先改权限规则就能继续」条目，反驳指向计划链/呈报（F12 防绕过）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const table = sectionOf(meta, '## 红旗反合理化表');
  const row = table.split('\n').find((l) => l.includes('先改权限'));
  assert.ok(row, '红旗表须含「先改权限规则就能继续」类话术条目——规划写面被拦时改规则自放行是本批封堵的绕行路径');
  assert.ok(
    row.includes('计划链') || row.includes('plan-writing') || row.includes('呈报'),
    '反驳须指向计划链/用户呈报，不得指引自改规则解锁',
  );
});

test('d2) 元技能明示规划写面不是 shell 沙箱（Bash 不受固定上界）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.includes('沙箱'));
  assert.ok(line, '须明示阶段写面拦截不是 shell 沙箱——否则用户误以为 Bash 也被 PLAN_DIRS 上界约束');
  assert.ok(line.includes('Bash'), '沙箱说明须点名 Bash 例外（上界只作用于 Edit/Write）');
});

test('d3) plan-writing 格式契约：ADR 引用与实际决策挂钩（FR 有效引用可独立满足追溯，F2）', () => {
  const text = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const contract = sectionOf(text, '## 计划格式契约');
  assert.ok(
    /实际决策|涉及决策/.test(contract),
    '契约须写明仅涉及实际决策才引用 ADR——FR 有效引用即可独立满足追溯，不设通用 ADR 要求（M3 与本 skill 契约统一）',
  );
});

test('d4) plan-writing 写者权限不等于执行批准（F1）', () => {
  const text = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('写者权限'), '须含「写者权限」定位句——会写计划不等于获执行/实现批准');
  assert.ok(
    /不等于|≠|不构成/.test(text),
    '须明示写作权限不构成执行批准（放行判据在 plan-review/路由，不在写者）',
  );
});

test('d5) plan-writing 规则冲突处置与产物上界：不得先改规则自放行；落盘限过程 Markdown', () => {
  const text = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('规则冲突'), '须含规则冲突处置条款（冲突记入计划/呈报用户）');
  assert.ok(
    text.includes('自放行') || text.includes('先改规则'),
    '须明示不得先改权限/治理规则再自放行（F12 技能面）',
  );
  assert.ok(
    text.includes('上界') || text.includes('过程文件'),
    '须写明规划产物上界＝docs/plans 过程文件（与闸侧固定写面同源，防双写漂移为口径漂移）',
  );
});

test('d6) plan-review 只评审不修改规则（含权限规则）', () => {
  const text = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('权限规则'),
    '须明示评审不修改权限/治理规则——放行判据来自规则本身，改规则须走计划链而非评审顺手改',
  );
});

test('d7) root-cause 修复分级判据覆盖受控仓规（AGENTS 等）：行为修复也是修复，须计划链', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('AGENTS'),
    '修复分级判据须覆盖 AGENTS/受控仓规类行为契约（不止协议/规格/ADR/skill——文档规则也是修复对象）',
  );
});

test('d8) root-cause 规格先行仅为顺序要求：合法上游设计规格写作保留', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('上游'),
    '须区分「受控资产的先改顺序要求」与「合法上游需求/设计规格写作」——不得全局禁止计划前规格写作（specs-first 只是 ordering）',
  );
});

test('d9) spec-writing 写作权限不构成实现批准，已定位修复不得借规格写作绕过计划链', () => {
  const text = readFileSync(join(SPEC_GATE_SKILLS, 'spec-writing', 'SKILL.md'), 'utf8');
  assert.ok(existsSync(join(SPEC_GATE_SKILLS, 'spec-writing', 'SKILL.md')), 'spec-writing skill 文件缺失');
  assert.ok(text.includes('实现批准'), '须明示规格写作权限≠实现批准（写规格解锁不了执行）');
  assert.ok(/不构成|不等于|≠/.test(text), '措辞须为否定性等价（写作权限不构成实现批准）');
  assert.ok(
    text.includes('绕过'),
    '须封堵「已定位修复借规格写作绕过计划链」的通道（规则冲突/已识别修复走计划或呈报，不自授权）',
  );
});

test('d10) verification 定位为阶段结论：验证输出非最终完成；「完成声称后的评审」措辞废止（F3）', () => {
  const text = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('阶段结论'),
    '须明示 verification 输出是阶段结论（code-complete 层），最终完成声明在链尾 finalize 之后',
  );
  assert.ok(
    !text.includes('完成声称后的评审'),
    'F3/ADR-007：不得再表述为「完成声称后的评审」——评审先于最终完成声明，旧措辞把时序倒置合法化',
  );
});

test('d11) verification 最终完成链顺序：证据→评审→prepare→gate→finalize', () => {
  const text = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  // 锚点须绑「最终完成链」语义行（含 最终/完成链/稳定 revision 限定词）——宽锚会被
  // 「操作型任务签发面」节的 L1/L2 操作链行（照常 prepare→gate→finalize）顶替而假绿
  const chainLine = text
    .split('\n')
    .find((l) => /prepare[^\n]*gate[^\n]*finalize/.test(l) && /最终|完成链|稳定|revision/.test(l));
  assert.ok(
    chainLine,
    '须写明最终 revision 完成链（verification 凭据→code-review→prepare→gate→finalize）且锚定「最终完成声明」语义——最终声明只挂链尾',
  );
});

test('d12) verification 凭据分支：full 证据关联逐条必填；scout-repro 按 M9 字段（F4）', () => {
  const text = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  const seg = sectionOf(text, '### 凭据链签发');
  assert.ok(seg.includes('scout-repro'), '凭据节须保留 scout-repro 分支');
  assert.ok(seg.includes('sourceRevision'), 'scout-repro 须按 M9 要求可复现凭据字段（含 sourceRevision）');
  assert.ok(seg.includes('退出码'), 'scout-repro 字段须含可复现命令退出码（M9 可复现三件套）');
  assert.ok(
    /必填/.test(seg),
    'full 分支证据关联逐条必填的分工须在凭据节可见（scout-repro 不套用 ruleId 逐条必填）',
  );
});

test('d13) idea-review 原创归档条件与不虚构过程史（F11）', () => {
  const text = readFileSync(join(SKILLS, 'idea-review', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('原创'), 'F11：须写明首次原创（初始架构/方法论）直接归档的条件');
  assert.ok(/审核|复核/.test(text), '原创归档须附评估证据与审核（不造循环自证）');
  assert.ok(
    text.includes('虚构'),
    '须明示不虚构过程史——过程资产移交与未决去向如实记录，不发明不存在的过程历史',
  );
});

test('d14) root-cause 分类检索清单强制项：三层权威面/检索命令/零命中证据/无检索证据无效（IMP-1，DEV-75）', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  const seg = sectionOf(text, '### 模式区分');
  assert.ok(seg, 'root-cause 须含独立的「### 模式区分」小节（锚点载体，DEV-75 重组）');
  assert.ok(seg.includes('分类检索清单'), '模式区分节须含分类检索清单强制项（IMP-1）');
  assert.ok(seg.includes('零命中证据'), '检索清单须要求零命中证据留痕');
  assert.ok(seg.includes('无检索证据'), '无检索证据的分类结论须显式判无效');
});

test('d15) root-cause R-M4-9 判例库与触发词：生产门禁/安全边界/契约语义=一律计划链（IMP-2，DEV-75）', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  const seg = sectionOf(text, '### 模式区分');
  for (const w of ['生产门禁', '安全边界', '契约语义']) {
    assert.ok(seg.includes(w), `触发词「${w}」须显式列为一律计划链词汇锚（IMP-2）`);
  }
  assert.ok(seg.includes('正例') && seg.includes('反例'), '判据须配正反判例（IMP-2）');
});

test('d16) root-cause 基线写面义务：--change-scope 显式声明与沿原任务号重声明（IMP-3 联动，DEV-75）', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  const seg = sectionOf(text, '### 模式区分');
  assert.ok(seg.includes('基线写面'), '模式区分节须含基线写面义务句（闸侧强制的 skill 面告知）');
  assert.ok(seg.includes('--change-scope'), '须指引以 --change-scope 显式声明写面');
  assert.ok(seg.includes('沿原任务号重声明'), '须明示扩面重声明沿原任务号（不换号）');
  assert.ok(text.includes('分类检索：'), 'DEBUG REPORT 模板须含分类检索必填行（IMP-1）');
});

// ── e 族（B 族）：内部任务-5 受众分层与公开槽纪律（2026-10-06）──────────────────────
// 为什么这一族存在：F5——公开说明此前以内部开发编号（ADR/IF/R-M/B-M/OPEN）代替解释，
// 普通使用者无从判断装了什么；受众规则的单一正文载体是 doc-discipline 纪律七，
// checklist/writing-skills 只引用不复制；公开 description 删编号后必须仍保留准确触发语义。

test('e1) doc-discipline 含「纪律七：受众分层」节——公开说明先功能/条件/限制/动作，元数据与公开帮助属生效面', () => {
  const text = readFileSync(join(SKILLS, 'doc-discipline', 'SKILL.md'), 'utf8');
  const section = sectionOf(text, '### 纪律七：受众分层');
  assert.ok(section, 'doc-discipline 须含「纪律七：受众分层」节（受众规则单源正文载体）');
  assert.ok(section.includes('公开选择说明') || section.includes('公开说明'), '纪律七须点名公开选择说明受众');
  assert.ok(/功能/.test(section) && /(条件|限制|动作)/.test(section), '纪律七须写明公开说明先讲功能/条件/限制/动作');
  assert.ok(
    section.includes('内部编号') || section.includes('开发编号'),
    '纪律七须明示内部开发编号不作公开说明前提',
  );
  assert.ok(
    /元数据|description|公开帮助/.test(section),
    '纪律七须把插件/技能/命令元数据与公开帮助纳入生效面',
  );
});

test('e2) code-review checklist「文档与注释同步性」行含受众判定口径（引用 doc-discipline，不复制条款）', () => {
  const checklist = readFileSync(join(SKILLS, 'code-review', 'checklist.md'), 'utf8');
  const row = checklist.split('\n').find((l) => l.includes('文档与注释同步性'));
  assert.ok(row, 'checklist NORMAL 表须含文档与注释同步性行');
  assert.ok(row.includes('受众'), '该行须补受众判定口径（公开槽零内部编号属受众纪律）');
  assert.ok(row.includes('doc-discipline'), '判定口径须引用 doc-discipline 单源（不在 checklist 复制第二份条款）');
});

test('e3) writing-skills 第 3 步含受众自查（frontmatter description 属公开生效面）', () => {
  const text = readFileSync(join(SKILLS, 'writing-skills', 'SKILL.md'), 'utf8');
  const step = sectionOf(text, '### 第 3 步：写/改技能');
  assert.ok(step, 'writing-skills 须有第 3 步节（sectionOf 防宽锚）');
  assert.ok(step.includes('受众'), '第 3 步须含受众自查（公开 description 按受众纪律写）');
  assert.ok(step.includes('doc-discipline'), '受众自查须指向 doc-discipline 单源条款');
});

test('e4) 公开 description 零内部编号且保留触发语义（production-change/sdd-ddd-tdd/scout/gate 命令）', () => {
  const ID_RE = /(ADR-\d+|IF-[A-Z]+-\d+|R-M\d+|B-M\d+|OPEN-\d+)/;
  const slots = [
    { name: 'production-change', file: join(SKILLS, 'production-change', 'SKILL.md') },
    { name: 'sdd-ddd-tdd', file: join(SPEC_GATE_SKILLS, 'sdd-ddd-tdd', 'SKILL.md') },
    { name: 'scout', file: join(SCOUT_SKILLS, 'scout', 'SKILL.md') },
    { name: 'team-governance gate 命令', file: join(TG_COMMANDS, 'gate.md') },
  ];
  for (const slot of slots) {
    const fm = readFileSync(slot.file, 'utf8').split('---')[1] ?? '';
    const desc = (/^description:\s*([\s\S]*)$/m.exec(fm) ?? [])[1] ?? '';
    assert.ok(desc.trim() !== '', `${slot.name} frontmatter 须有 description`);
    assert.ok(!ID_RE.test(desc), `${slot.name} 公开 description 零内部编号（实得片段：${desc.slice(0, 80)}）`);
  }
  // 删编号不丢激活语义：三份技能 description 保留「触发条件：」锚点
  for (const name of ['production-change', 'sdd-ddd-tdd', 'scout']) {
    const file = name === 'scout' ? join(SCOUT_SKILLS, 'scout', 'SKILL.md')
      : name === 'sdd-ddd-tdd' ? join(SPEC_GATE_SKILLS, 'sdd-ddd-tdd', 'SKILL.md')
        : join(SKILLS, 'production-change', 'SKILL.md');
    const fm = readFileSync(file, 'utf8').split('---')[1] ?? '';
    assert.ok(fm.includes('触发条件'), `${name} description 须保留「触发条件：」语义（删编号不删激活条件）`);
  }
});

// ── f 族（2026-10-14 内部任务-84，内部决策-043 纪律面正文语义锁）──────────────────────
// 断言读实际章段（全局规则节/红旗表/第 1 步节切片），不以全文件同词凑绿；锚点用短语。
// 载体：内部规则-16（全局规则新增条＋双面声明前言＋红旗两行）、内部规则-14（设计面核验＋处置优先级）、
// 内部规则-11（修复纪律桥接注记）、内部规则-15（code-review/verification 指针行）。

test('f1) 元技能全局规则含「自查举一反三」条且前言为双面声明（R-M1-16，ADR-043 修正案 1）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 全局规则');
  assert.ok(sec.includes('自查举一反三'), '全局规则须含「自查举一反三」条——义务全文唯一载体，缺该条即回退为口头规则');
  assert.ok(sec.includes('同类扫描') && sec.includes('不构成收口'), '义务全文锚点短语缺失（同类扫描／不构成收口）');
  assert.ok(!meta.includes('以下四条'), '前言「以下四条」计数字面量须已移除——实列五条的既有漂移（ADR-043 修正案 1）');
});

test('f1b) 元技能全局规则含「OPEN 消费面义务」指针条且前言含「开工前消费面」面向声明（R-M1-20，ADR-049）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 全局规则');
  assert.ok(sec.includes('OPEN 消费面义务'), '全局规则须含「OPEN 消费面义务」指针条（R-M1-20）——缺条则消费面义务退化为仅钩子提醒行承载');
  assert.ok(sec.includes('按任务域检索'), '指针条须含「按任务域检索」动作锚点');
  assert.ok(sec.includes('IF-COLLAB-8 §7.1') && sec.includes('不转述判据'), '指针条须明示义务全文唯一载体在 IF-COLLAB-8 §7.1、不转述判据（防双写漂移）');
  assert.ok(sec.includes('开工前消费面'), '作用域前言须含「开工前消费面」面向声明——本条作用面＝任务开工，非落盘文档/自查活动（R-M1-20）');
});

// ── g 族（2026-10-17 内部任务-36，内部决策-049 消费面入口 skill 指针条）──────────────────
test('g1) plan-writing 第 1 步含「未决项排查」指针条（R-M3-15，ADR-049）', () => {
  const text = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const step = sectionOf(text, '### 第 1 步：核对入口');
  assert.ok(step.includes('未决项排查'), 'plan-writing 第 1 步须含「未决项排查」指针条（R-M3-15）');
  assert.ok(step.includes('specs/open-items.md') && step.includes('IF-COLLAB-8 §7.1'), '指针条须含登记册路径与义务载体锚点');
  assert.ok(step.includes('不转述判据'), '指针条须明示不转述判据（防双写漂移）');
});

test('g2) brainstorming 三档勘察步各含 OPEN 检索指针（R-M2-8，ADR-049）', () => {
  const text = readFileSync(join(SKILLS, 'brainstorming', 'SKILL.md'), 'utf8');
  const recon = text.split('\n').filter((l) => l.includes('勘察项目上下文'));
  assert.equal(recon.length, 3, '三档勘察步各一行（Spike/Bounded/Architectural）');
  for (const [i, l] of recon.entries()) {
    assert.ok(l.includes('specs/open-items.md'), `第 ${i + 1} 档勘察步须含 open-items 检索指针（R-M2-8）`);
    assert.ok(l.includes('IF-COLLAB-8 §7.1'), `第 ${i + 1} 档指针须明示义务全文载体`);
    assert.ok(l.includes('不转述判据'), `第 ${i + 1} 档指针须明示不转述判据（防双写漂移）`);
  }
});

test('g3) root-cause-debugging 分类检索清单扩面到 open-items（R-M4-12，ADR-049）', () => {
  const text = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  const sec = sectionOf(text, '### 模式区分');
  assert.ok(sec.includes('specs/open-items.md'), '分类检索清单须扩到 specs/open-items.md（R-M4-12）');
  assert.ok(sec.includes('IF-COLLAB-8 §7.1') && sec.includes('不转述判据'), '扩面指针须明示义务全文载体、不转述判据（防双写漂移）');
});

test('f2) 元技能红旗表含「只修这一处」与「发现设计缺口，记个 OPEN」两条目（R-M1-16）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 红旗反合理化表');
  const rowA = sec.split('\n').find((l) => l.includes('只修这一处'));
  assert.ok(rowA, '红旗表须含「只修这一处，同类以后再说」条目');
  assert.ok(rowA.includes('同类扫描'), '反驳列须指向同类扫描义务');
  const rowB = sec.split('\n').find((l) => l.includes('发现设计缺口'));
  assert.ok(rowB, '红旗表须含「发现设计缺口，记个 OPEN 继续」条目');
  assert.ok(rowB.includes('退回修设计') && rowB.includes('兜底'), '反驳列须指向先修设计默认与 OPEN 兜底定位');
});

test('f3) plan-writing 含设计面核验条、处置优先级与举一反三指针行（R-M3-14）', () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(t, '### 第 1 步：核对入口');
  assert.ok(s1.includes('设计面核验'), '第 1 步须含「设计面核验」条');
  assert.ok(s1.includes('缺口') && s1.includes('矛盾') && s1.includes('过时'), '三类缺陷枚举缺失');
  assert.ok(s1.includes('退回修设计') && s1.includes('用户显式同意延后'), '处置优先级缺失（默认退回修设计／仅用户显式同意延后才转 OPEN-n）');
  const s5 = sectionOf(t, '### 第 5 步：落笔前自查');
  assert.ok(s5.includes('自查举一反三'), '第 5 步须含举一反三指针行');
  // C4/内部任务-193：契约改造类计划先冻结契约文本再实现、文本修订与哈希重登同批一次完成。
  for (const anchor of ['契约改造类', '先冻结', '同批一次完成']) {
    assert.ok(s5.includes(anchor), `第 5 步契约改造冻结条缺锚点：${anchor}`);
  }
  const boundary = sectionOf(t, '## 边界与禁止项');
  assert.ok(boundary.includes('带病进入执行'), '边界节须含处置优先级句（「带病进入执行」锚——v2 三维评审 C2：整文件级 includes 收窄为节切片）');
});

test('f4) plan-review 收尾自查含病根判定项与举一反三指针（R-M3-14）', () => {
  const t = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const closing = sectionOf(t, '### 第 6 步：结论与落盘');
  assert.ok(closing.includes('病根是设计缺口'), '收尾自查须含「病根是设计缺口→回设计面」判定项（v2 三维评审 C2：节切片锚——移出收尾自查节即红）');
  assert.ok(closing.includes('自查举一反三'), '收尾自查须含举一反三指针行');
});

test('f4b) plan-review 评审实例模式与 sidecar 七字段（R-M3-16 / DEV-156）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '## 评审实例模式（R-M3-16）');
  for (const anchor of [
    '超过 8 步', '超过 8 文件', '超过 2 个新模块',
    'independent', 'mixed', 'self', 'ratified',
    'independent ≥2', 'mixed =1', 'self =0', 'ratified =0',
    'reviewMode', 'reviewInstances', 'reviewReason',
    'fresh-context', '主会话自评', '执行实例标识', '拆小', '--exempt-src',
    '超阈值实现类计划只接受 `independent`',
  ]) {
    assert.ok(sec.includes(anchor), `实例模式节缺锚点：${anchor}`);
  }
  const template = sectionOf(t, '## 输出格式');
  for (const field of ['reviewMode:', 'reviewInstances:', 'reviewReason:']) {
    assert.ok(template.includes(field), `sidecar 模板缺字段：${field}`);
  }
  assert.ok(template.includes('四字段') && template.includes('三评审字段'), '模板须写四基础字段 + 三评审字段契约');
  const ratify = sectionOf(t, '## 宿主计划追认模式（ADR-020）');
  assert.ok(ratify.includes('仅适用于低阈值'), '追认档须写明仅低阈值适用');
  assert.ok(ratify.includes('reviewMode: ratified'), '追认档须写 ratified 模式');

  const m3 = readFileSync(join(SPECS, 'modules', 'M3-planning-skills.md'), 'utf8');
  assert.ok(m3.includes('R-M3-16'), 'M3 须登记 R-M3-16');
  assert.ok(m3.includes('A-M3-16'), 'M3 须登记 A-M3-16');
  assert.ok(m3.includes('D-M3-3'), 'M3 须登记 D-M3-3');
  const m8 = readFileSync(join(SPECS, 'modules', 'M8-guard-hooks.md'), 'utf8');
  const a88 = m8.split('\n').find((line) => line.startsWith('| A-M8-8'));
  assert.ok(a88 && a88.includes('R-M3-16'), 'M8 的 A-M8-8 接受行须引用 R-M3-16（不用整文件命中凑绿）');
  const adr = readFileSync(join(SPECS, 'adr', 'ADR-020.md'), 'utf8');
  assert.ok(adr.includes('修正案 1（2026-10-19'), 'ADR-020 须有修正案 1');
  assert.ok(adr.includes('仅低阈值计划适用'), 'ADR-020 修正案须写追认档仅低阈值');
});

test('f4c) code-review 修复复审分级与 verification 制品链命令（R-M5-16 / DEV-156）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 修复后的复审分级（D-M5-4）');
  for (const anchor of [
    'none', 'self', 'delta', 'full',
    '≤8', '≤200', '>8', '>200',
    '鉴权', '并发', '闸/钩子/租约/凭据链', '公开接口', '数据迁移', '新增依赖', '权限/ACL', '行为契约文本',
    'fresh-context', 'fixReviewMode', 'fixReviewInstances', 'fixReviewReason',
    'fixReviewBase', 'fixReviewDiffSha', '语义/风险优先于尺寸', 'git add -N',
  ]) {
    assert.ok(sec.includes(anchor), `修复复审节缺锚点：${anchor}`);
  }
  const m5 = readFileSync(join(SPECS, 'modules', 'M5-review-verification.md'), 'utf8');
  for (const id of ['R-M5-16', 'A-M5-16', 'D-M5-4']) {
    assert.ok(m5.includes(id), `M5 须登记 ${id}`);
  }
  const v = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  const deliverable = sectionOf(v, '### 制品型任务签发面');
  assert.ok(deliverable.includes('--fix-review-mode none'), '制品型命令须补 fix-review-mode none');
});

test('f5) code-review 意见处置闭环含举一反三指针与 diff 外扫描面（R-M5-15）', () => {
  const t = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 意见处置闭环');
  assert.ok(sec.includes('自查举一反三'), '意见处置闭环节须含指针行');
  assert.ok(sec.includes('diff 之外的同形态处'), '扫描面句缺失（含 diff 之外的同形态处）');
});

test('f6) verification 含失败证据举一反三指针行（R-M5-15）', () => {
  const t = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  const boundary = sectionOf(t, '## 边界与禁止项');
  assert.ok(boundary.includes('失败证据举一反三'), '边界节须含失败证据举一反三指针行（v2 三维评审 C2：节切片锚）');
  assert.ok(boundary.includes('自查举一反三'), '指针行须点名元技能全局规则名');
});

test('f7) root-cause-debugging 修复纪律含举一反三桥接注记（R-M4-11）', () => {
  const t = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 修复纪律');
  assert.ok(sec.includes('具体化'), '修复纪律节须含桥接注记（影响面＝全局规则调试面具体化）');
  assert.ok(sec.includes('自查举一反三'), '桥接注记须点名元技能全局规则名');
});

test('g1) 元技能红旗表含「一次性交付直接做就行」条目（DEV-89 scout 触发强化，ADR-044/R-M1-17）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8'); // meta 为用例内局部加载（d1 形态）
  const table = sectionOf(meta, '## 红旗反合理化表');
  const row = table.split('\n').find((l) => l.includes('一次性交付'));
  assert.ok(row, '红旗表须含「这个任务是一次性交付/临时脚本，直接做就行」条目——同类漏项已两次实证');
  assert.ok(row.includes('scout'), '反驳须指向 scout 评估（opt-in 确认）');
  assert.ok(row.includes('opt-in'), '反驳须保留 opt-in 语义（用户确认 mode/expiry，ADR-008）');
});

// ── g2（内部任务-116 / 内部未决-128 方案 B / 内部决策-023 修正案 2）：制品型保留名与制品链正文锚点 ──

test('g2) 元技能保留名段含两道保留名与制品链完成链（DEV-116）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const seg = meta.split('\n').find((l) => l.includes('ad-hoc-deliverable')) ?? '';
  assert.ok(seg, '元技能须含 ad-hoc-deliverable 保留名（表外声明段）');
  assert.ok(seg.includes('状态型') && seg.includes('制品型'), '两道保留名语义分工呈现');
  assert.ok(seg.includes('--deliverable-chain'), '制品链收口旗标呈现');
  assert.ok(seg.includes('deliverable'), '制品链评审环词表值呈现');
});

test('g3) verification skill 含制品链签发面（DEV-116）', () => {
  const v = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  const seg = sectionOf(v, '### 制品型任务签发面');
  assert.ok(seg, 'verification skill 须含「制品型任务签发面」节');
  assert.ok(seg.includes('--review-mode deliverable'), '评审环命令形态含词表值');
  assert.ok(seg.includes('--deliverable-chain'), '收口旗标呈现');
  assert.ok(seg.includes('四因子'), '四因子校验语义呈现');
});

test('g4) code-review skill 冒用判定句含制品链 carve-out（DEV-116）', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const line = cr.split('\n').find((l) => l.includes('冒用')) ?? '';
  assert.ok(line, '受理核验须含冒用判定句');
  assert.ok(line.includes('制品链'), '制品链 carve-out 呈现（合法形态不计冒用）');
  assert.ok(line.includes('四因子'), 'carve-out 锚定四因子口径');
});

// ── f8-f12（内部任务-174 / 内部规则-17）：设计输入凭据门与可等待委派文本锚 ────────────

test('f8) plan-writing 第 1 步含设计输入凭据与可等待通道要求（R-M3-17）', () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(t, '### 第 1 步：核对入口');
  for (const anchor of ['设计输入凭据（R-M3-17）', '可等待通道', 'fire-and-forget', '不得把未返回的报告记为 completed']) {
    assert.ok(s1.includes(anchor), `第 1 步须含「${anchor}」（R-M3-17 文本回归锁）`);
  }
});

test('f9) plan-writing 格式契约含设计输入节与 checker 边界（R-M3-17）', () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  // 不用 sectionOf：契约内含 ```markdown 示例，示例里的「### 步骤」会被 sectionOf 当下一标题截断；
  // 改按「## 计划格式契约」→「## 工具」的显式边界切片（documented 取舍，避免改共享 helper 牵连既有断言）。
  const start = t.indexOf('## 计划格式契约');
  const end = t.indexOf('\n## 工具', start);
  const contract = start === -1 ? '' : t.slice(start, end === -1 ? undefined : end);
  for (const anchor of ['设计输入', 'check-plan-design-input.mjs', 'exit 0', 'R-M7-9', 'IF-COLLAB-1']) {
    assert.ok(contract.includes(anchor), `格式契约须含「${anchor}」（第 7 条契约+边界）`);
  }
});

test('f10) plan-review 第 1 步含 checker 执行与追认档豁免（R-M3-17）', () => {
  const t = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(t, '### 第 1 步：受理核对');
  for (const anchor of ['check-plan-design-input.mjs', 'exit 0', 'exit 1', 'exit 2', '追认档']) {
    assert.ok(s1.includes(anchor), `受理核对须含「${anchor}」（checker 三分支+ADR-020 豁免）`);
  }
});

test('f11) plan-review 第 2 步含设计输入证据抽查且不随小计划跳过（R-M3-17）', () => {
  const t = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const s2 = sectionOf(t, '### 第 2 步：事实核查（code-explorer，按需）');
  assert.ok(s2.includes('设计输入证据'), '事实核查须含设计输入证据抽查项');
  assert.ok(s2.includes('不因本步跳过') || s2.includes('不随'), '抽查不随小计划跳过（防绕过）');
});

test('f12) M3 登记 R-M3-17 与 A-M3-17（设计输入凭据门，DEV-174）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const m3 = readFileSync(join(SPECS, 'modules', 'M3-planning-skills.md'), 'utf8');
  assert.ok(m3.includes('R-M3-17'), 'M3 须登记 R-M3-17');
  assert.ok(m3.includes('A-M3-17'), 'M3 须登记 A-M3-17（锁定=checker 测试+skills-text）');
  assert.ok(m3.includes('D-M3-4'), 'M3 须登记 D-M3-4 设计决策（采纳形态）');
});

test('ADR-052：第 19 个 skill、周期节点行与台账/闭环/边界契约', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.startsWith('| 周期节点 |'));
  assert.ok(line && line.includes('architecture-evolve'), '周期节点行目标列含 architecture-evolve');
  const table = meta.slice(meta.indexOf('## 路由表'), meta.indexOf('两条互斥规则'));
  const dataRows = table.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('用户状态'));
  assert.equal(dataRows.length, 18, '路由表数据行 18');
  const skill = readFileSync(join(SKILLS, 'architecture-evolve', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: architecture-evolve\n/m);
  assert.ok(skill.includes('触发条件'), 'description 含触发条件锚点');
  for (const anchor of ['review', 'finding', 'optimization', 'evolution', 'watch', 'open|triaged|planned|executed|verified|closed', 'trigger']) {
    assert.ok(skill.includes(anchor), `台账契约锚点：${anchor}`);
  }
  const schemaSec = sectionOf(skill, '## 台账记录格式');
  assert.ok(schemaSec.includes('kind'), 'schema 节以 kind 为字段名（非 type）');
  assert.ok(schemaSec.includes('drivers') && schemaSec.includes('candidates') && schemaSec.includes('decisionEntry'), 'evolution 必填字段可机读');
  assert.ok(schemaSec.includes('同 id 追加新行'), '状态迁移记录形态已定义');
  assert.ok(skill.includes('三类去向'), '第 4 步三类去向在正文');
  assert.ok(skill.includes('未达行动门槛的观察项登记为 watch'), 'watch 产出规则在正文');
  for (const anchor of ['未闭环发现年龄分布', '优化执行率', '上次演化提案状态', '设计基线新鲜度', '复查完成率']) {
    assert.ok(skill.includes(anchor), `闭环五节锚点：${anchor}`);
  }
  for (const anchor of ['.context/architecture-reviews/', '不写 specs', '不写 `docs/plans/`', '只读', '非 git']) {
    assert.ok(skill.includes(anchor), `边界锚点：${anchor}`);
  }
  // 内部任务-214 批 3 S1 补断言（内部验收-1）：流程五步逐标题在位（不止同词）
  const stepHeads = skill.match(/^### 第 \d 步：[^\n]+$/gm) ?? [];
  assert.equal(stepHeads.length, 5, `流程须恰 5 步标题（实得 ${stepHeads.length}）`);
  for (const step of ['读台账与上次报告', '定向抽读结构面', '闭环校验', '产报告与三类去向', '落报告与收尾']) {
    assert.ok(stepHeads.some((h) => h.includes(step)), `流程步骤标题在位：${step}`);
  }
  // 内部任务-214 批 3 S1 补断言（内部验收-5）：演化提案六要素中风险面字面（drivers/candidates/decisionEntry 已在上方 schema 断言）
  for (const key of ['impact', 'risk']) {
    assert.ok(skill.includes(`\`${key}\``), `演化提案字段在位：${key}`);
  }
  assert.ok(skill.includes('风险与回滚'), '演化提案 risk 语义字面（风险与回滚）在位');
  assert.ok(skill.includes('至少两个') && skill.includes('保留/退役对照'), '候选路径规则（≥2 且保留/退役对照）在位');
});

test('ADR-052 边界：体检零网络零依赖且写入面仅 .context', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const skill = readFileSync(join(SKILLS, 'architecture-evolve', 'SKILL.md'), 'utf8');
  const io = sectionOf(skill, '## 输入与输出');
  assert.ok(io.includes('.context/architecture-feedback.jsonl'), '输入须为被治理项目 .context 台账');
  assert.ok(io.includes('不写其他文件'), '写入面显式限定（不写其他文件）');
  assert.ok(skill.includes('不实施不裁决'), '不实施不裁决边界在位');
  assert.ok(!/https?:\/\//.test(skill), '技能正文不得含网络 URL（零网络调用面）');
  const m20 = readFileSync(join(SPECS, 'modules', 'M20-architecture-evolution.md'), 'utf8');
  const r9 = m20.split('\n').find((l) => l.startsWith('| R-M20-9 |'));
  assert.ok(r9 && r9.includes('不联网') && r9.includes('不引入第三方依赖'), 'R-M20-9 零网络/零第三方依赖条文在位');
});

test('ADR-052：plan-execution 与 code-review 含架构事实记录义务指针', () => {
  const planExec = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  const codeReview = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  for (const text of [planExec, codeReview]) {
    assert.ok(text.includes('architecture-feedback.jsonl'), '含台账路径锚点');
    assert.ok(text.includes('R-M20-6'), '含义务全文载体编号');
    assert.ok(text.includes('只做指针'), '明示不转述判据');
  }
});

test('f13) 评审轮次熔断与复审实例复用锚点（DEV-181）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.includes('评审轮次熔断（3 轮 ROI 评估'));
  assert.ok(line, '元技能全局规则须含评审轮次熔断条');
  for (const kw of ['五因子', '默认继续', '三种处置', '红线', '与其他闸关系', 'fix-induced ≥2', '≥80 非重复']) {
    assert.ok(line.includes(kw), `熔断条缺要素：${kw}`);
  }
  assert.ok(line.includes('不得产生通过态'), '熔断须禁止通过态凭据');
  assert.ok(line.includes('部分通过'), '熔断须禁用第三态措辞');
  assert.ok(line.includes('code-review＝首轮对象标识（taskId 仅辅助）'), '全局规则 code-review 链锚须与矩阵一致');
  const crText = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const crGrading = crText.slice(crText.indexOf('### 修复后的复审分级（D-M5-4）'), crText.indexOf('### 复审实例复用矩阵（DEV-181）'));
  assert.ok(!crGrading.includes('四因子评估'), 'code-review D-M5-4 节不得残留「四因子评估」（应五因子）');

  const planReview = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const prSec = planReview.slice(
    planReview.indexOf('## 评审实例模式（R-M3-16）'),
    planReview.indexOf('## 宿主计划追认模式（ADR-020）'),
  );
  assert.ok(prSec.includes('复审实例复用矩阵'), 'plan-review 复用矩阵须在 R-M3-16 节内');
  for (const kw of ['全部实例', 'ratified 禁止', '换号不重置']) {
    assert.ok(prSec.includes(kw), `plan-review 矩阵缺要素：${kw}`);
  }

  const codeReview = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const crSec = codeReview.slice(
    codeReview.indexOf('### 修复后的复审分级（D-M5-4）'),
    codeReview.indexOf('## 接收评审'),
  );
  assert.ok(crSec.includes('复审实例复用矩阵'), 'code-review 复用矩阵须在 D-M5-4 节内');
  for (const kw of ['缺失维度', '禁止把 3 个实例压成 1 个', '`none`/`self` 0 实例', 'docs/plans/code-review-<task>.md']) {
    assert.ok(crSec.includes(kw), `code-review 矩阵缺要素：${kw}`);
  }

  // C1/C2（内部任务-193）：评审冻结点与首轮发现处置时序——C1 落在「评审对象与范围」节，C2 落在 内部决策-4 节。
  const crScope = codeReview.slice(
    codeReview.indexOf('### 评审对象与范围（三态，R-M5-8）'),
    codeReview.indexOf('### 三维并行评审（code-reviewer agent）'),
  );
  assert.ok(crScope, 'code-review 须有「评审对象与范围（三态，R-M5-8）」节');
  for (const kw of ['评审冻结点', '冻结评审对象', '同一快照', '一波', '一次性']) {
    assert.ok(crScope.includes(kw), `评审对象与范围节缺评审冻结点要素：${kw}`);
  }
  for (const kw of ['一次改完', 'delta/full 复审', '行为契约']) {
    assert.ok(crSec.includes(kw), `D-M5-4 节缺首轮发现处置时序要素：${kw}`);
  }
});

test('ADR-052 二期：external-radar 四段/台账/分诊/简报/信任契约', () => {
  const skill = readFileSync(join(SKILLS, 'external-radar', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: external-radar\n/m);
  assert.ok(skill.includes('触发条件'));
  const sources = sectionOf(skill, '### 第 1 步：源登记');
  for (const a of ['架构演化', '算法优化', '研究选题', '30 天', '白名单', 'config', 'config 不可用', 'sourceId']) assert.ok(sources.includes(a), `源登记锚点：${a}`);
  const collect = sectionOf(skill, '### 第 2 步：采集归纳');
  for (const a of ['不可信数据', '不执行', 'evidenceLevel', 'fact', 'claim', 'inference', '简报限长', '未采集']) assert.ok(collect.includes(a), `采集锚点：${a}`);
  const triage = sectionOf(skill, '### 第 3 步：内化分诊');
  for (const a of ['adopt', 'watch', 'reject', 'expired', 'adoptedRef', '可复核的项目内变化', 'trigger', 'expiresAt']) assert.ok(triage.includes(a), `分诊锚点：${a}`);
  const brief = sectionOf(skill, '### 第 4 步：产简报与反馈复盘');
  for (const a of ['<YYYY-MM-DD>.json', 'schemaVersion', 'feedback', '落地率', '来源有效性', '成本信噪比', '不可判定']) assert.ok(brief.includes(a), `反馈锚点：${a}`);
  const ledger = sectionOf(skill, '## 台账格式（`.context/external-radar.jsonl`，追加式）');
  for (const a of ['source', 'entry', 'brief', 'triage', 'watch', '坏行', '计数', 'entryId']) assert.ok(ledger.includes(a), `台账锚点：${a}`);
  const iface = sectionOf(skill, '## 与其他 skill 的接口');
  assert.ok(iface.includes('IF-COLLAB-24') && iface.includes('最小契约'));
  const boundary = sectionOf(skill, '## 边界与禁止项');
  for (const a of ['不可信数据', '禁止执行', '禁止写', '零第三方依赖', '自写表达']) assert.ok(boundary.includes(a), `边界锚点：${a}`);
});

// ── f14-f17（内部任务-189 / 内部规则-23）：代理实例复用与再水化规范 ──────────────────

test('f14) 元技能全局规则含代理实例复用与再水化（R-M1-23，宿主中立）', () => {
  const t = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '## 全局规则');
  for (const anchor of ['代理实例复用与再水化', '复用优先', '可续实例', '实例台账', '不可用三态', '跨会话不承诺续聊原实例', '委派派发活动']) {
    assert.ok(sec.includes(anchor), `全局规则缺锚点：${anchor}`);
  }
  for (const banned of ['list_agents', 'send_message', 'message_subagent', 'list_subagents', 'wait_subagent', 'spawn_teammate', 'wait_agent', 'subagent_fork', 'ZCode', 'MCode', 'Kimi', 'MiniMax', 'DeepSeek', 'DSH', 'Team']) {
    assert.equal(sec.includes(banned), false, `全局规则不得写死宿主工具名/宿主术语：${banned}`);
  }
});

test('f15) plan-execution 模式 B/C 含复用/交接/台账且不写死宿主工具名（R-M1-23）', () => {
  const t = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 模式 B：子代理派发');
  for (const anchor of ['可续', '回派', '完整交接', '实例台账']) {
    assert.ok(sec.includes(anchor), `模式 B 缺锚点：${anchor}`);
  }
  for (const banned of ['message_subagent', 'list_subagents', 'wait_subagent', 'spawn_teammate']) {
    assert.equal(sec.includes(banned), false, `模式 B 不得写死宿主工具名：${banned}`);
  }
  const secC = sectionOf(t, '### 模式 C：并行派发');
  for (const anchor of ['批内不得复用同一实例', '并登记实例台账']) {
    assert.ok(secC.includes(anchor), `模式 C 缺锚点：${anchor}`);
  }
  const boundary = sectionOf(t, '## 边界与禁止项');
  for (const anchor of ['复用尝试', '台账记录替代']) {
    assert.ok(boundary.includes(anchor), `禁令节缺锚点：${anchor}`);
  }
});

test('f16) plan-review/code-review 复审矩阵含首轮台账/跨阶段/再水化（R-M3-16/R-M5-16）', () => {
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  // 用显式边界切片而非 sectionOf：矩阵是「## 评审实例模式（内部规则-16）」内的 H3，
  // sectionOf 会在下一个任意标题（矩阵标题本身）处截断，取不到矩阵正文（f13 同款写法）。
  const prStart = pr.indexOf('## 评审实例模式（R-M3-16）');
  const prEnd = pr.indexOf('\n## 宿主计划追认模式（ADR-020）', prStart);
  const prSec = prStart === -1 ? '' : pr.slice(prStart, prEnd === -1 ? undefined : prEnd);
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const crStart = cr.indexOf('### 复审实例复用矩阵（DEV-181）');
  const crEnd = cr.indexOf('\n## 接收评审（流程下章）', crStart);
  const crSec = crStart === -1 ? '' : cr.slice(crStart, crEnd === -1 ? undefined : crEnd);
  for (const [label, sec] of [['plan-review', prSec], ['code-review', crSec]]) {
    for (const anchor of ['首轮', '实例台账', '跨阶段', '再水化']) {
      assert.ok(sec.includes(anchor), `${label} 复用矩阵缺锚点：${anchor}`);
    }
    // C3/内部任务-193：superseded 台账词表——草案/作废实例登记口径，且不计入计数、不进 provenance state。
    for (const anchor of ['superseded', '草案/作废', '不计入']) {
      assert.ok(sec.includes(anchor), `${label} 复用矩阵缺 superseded 锚点：${anchor}`);
    }
  }
});

test('f17) plan-writing R-M3-17 含实例台账与复用指针（R-M3-17/R-M1-23）', () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 第 1 步：核对入口');
  for (const anchor of ['设计输入凭据（R-M3-17）', '实例台账', '复用']) {
    assert.ok(sec.includes(anchor), `第 1 步缺锚点：${anchor}`);
  }
});

// ── f18（内部任务-191 / 内部规则-23 / 内部规则-16 / 内部规则-16）：实例链身份与 provenance ──────

test('f18) 链身份/跨任务=新链/再水化不计入 + plan-review 派发契约 + code-review provenance 口径', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 全局规则');
  for (const anchor of ['链身份', '跨任务', '新链', '不计入', 'rehydrated']) {
    assert.ok(sec.includes(anchor), `全局规则缺锚点：${anchor}`);
  }
  // C3/内部任务-193：superseded 台账口径入元技能全局规则（草案/作废实例不计入 reviewInstances）。
  for (const anchor of ['superseded', 'reviewInstances']) {
    assert.ok(sec.includes(anchor), `全局规则缺 superseded 口径锚点：${anchor}`);
  }
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  for (const anchor of ['派发提示词契约', 'reviewProvenance', 'reviewRound', 'plan:<planPath>']) {
    assert.ok(pr.includes(anchor), `plan-review 缺锚点：${anchor}`);
  }
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  for (const anchor of ['reviewProvenance', '2.1.0', 'legacy', '--review-round', 'fixReviewProvenance']) {
    assert.ok(cr.includes(anchor), `code-review 缺锚点：${anchor}`);
  }
  const ver = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  assert.ok(ver.includes('--review-provenance'), 'verification 制品命令模板缺 provenance');
  // C5/内部任务-193：完成链证据预写禁令——证据只列已生成凭据，未执行步骤不得写成既成结果。
  for (const anchor of ['未执行步骤', '不得写成既成结果']) {
    assert.ok(ver.includes(anchor), `verification 缺证据预写禁令锚点：${anchor}`);
  }
  const pe = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  for (const anchor of ['v2/v3', 'reviewProvenance', 'v3']) {
    assert.ok(pe.includes(anchor), `plan-execution 缺锚点：${anchor}`);
  }
});

// ── f19（内部任务-199 / 内部决策-056 / 内部规则-18）：计划期多宿主适配评估门禁 ──────────────

test('f19) plan-writing 格式契约与 plan-review 受理含多宿主适配门禁（ADR-056/R-M3-18）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  // 同 f9：契约内含 ```markdown 示例，用显式边界切片而非 sectionOf。
  const start = t.indexOf('## 计划格式契约');
  const end = t.indexOf('\n## 工具', start);
  const contract = start === -1 ? '' : t.slice(start, end === -1 ? undefined : end);
  for (const anchor of [
    '多宿主适配评估', 'check-plan-host-impact.mjs', 'exit 0', 'exit 1', 'exit 2', 'R-M7-9', '整体豁免',
    '已适配并真机验证', '已适配未真机验证', '本批不适用', '无验证条件',
  ]) {
    assert.ok(contract.includes(anchor), `格式契约须含「${anchor}」（R-M3-18 契约+边界）`);
  }
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(pr, '### 第 1 步：受理核对');
  for (const anchor of ['多宿主适配', 'check-plan-host-impact.mjs', 'exit 1', 'exit 2', '追认档']) {
    assert.ok(s1.includes(anchor), `受理核对须含「${anchor}」（多宿主门禁三分支+ADR-020 豁免）`);
  }
  const m3 = readFileSync(join(SPECS, 'modules', 'M3-planning-skills.md'), 'utf8');
  assert.ok(m3.includes('R-M3-18'), 'M3 须登记 R-M3-18');
  assert.ok(m3.includes('A-M3-18'), 'M3 须登记 A-M3-18');
});

// ── f20（内部任务-199 / 内部决策-053 修正案 / 内部规则-24）：全局「阻塞停机协议」条 ──────────

test('f20) 元技能全局规则含阻塞停机协议且宿主中立（R-M1-24）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 全局规则');
  for (const anchor of ['阻塞停机协议', '外部阻塞', '停止', '报告', '可解性', '不得', '空转', '同一外部阻塞', '阈值']) {
    assert.ok(sec.includes(anchor), `全局规则缺锚点：${anchor}`);
  }
  for (const term of ['TodoWrite', 'Bash', 'Glob', 'DSH', 'ZCode', 'MCode', 'Kimi']) {
    assert.ok(!sec.includes(term), `阻塞停机协议条须宿主中立，禁止宿主术语：${term}`);
  }
  const m1 = readFileSync(join(SPECS, 'modules', 'M1-workflow-meta.md'), 'utf8');
  assert.ok(m1.includes('R-M1-24'), 'M1 须登记 R-M1-24');
  assert.ok(m1.includes('A-M1-24'), 'M1 须登记 A-M1-24');
});

// ── f21-f23（2026-10-23 内部任务-220）：桥接通道复用纪律与稀缺资源定位 ─────────────

test('f21) 元技能全局规则含通道政策与可续性探测程序且宿主中立（R-M1-23/DEV-220）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const sec = sectionOf(meta, '## 全局规则');
  for (const anchor of [
    '通道政策', '稀缺资源', '不得作为计划', '代码复审通道', '适配层桥接清单',
    '可续性探测程序', '清单不可见', '不可投递', '正确续聊入口', '普通子代理（可续）',
  ]) {
    assert.ok(sec.includes(anchor), `全局规则缺 DEV-220 锚点：${anchor}`);
  }
  for (const banned of ['list_agents', 'send_message', 'message_subagent', 'list_subagents', 'wait_subagent', 'spawn_teammate', 'wait_agent', 'subagent_fork', 'ZCode', 'MCode', 'Kimi', 'MiniMax', 'DeepSeek', 'DSH', 'Team']) {
    assert.equal(sec.includes(banned), false, `全局规则 DEV-220 条不得写死宿主工具名/宿主术语：${banned}`);
  }
});

test('f22) plan-review/code-review 复审矩阵含通道选择与复用步骤（R-M3-16/R-M5-16/DEV-220）', () => {
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const prSec = sectionOf(pr, '### 复审实例复用矩阵（DEV-181）');
  for (const anchor of ['通道选择与复用步骤', '续聊入口', '不得改用持久成员通道']) {
    assert.ok(prSec.includes(anchor), `plan-review 复用矩阵缺 DEV-220 锚点：${anchor}`);
  }
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const crSec = sectionOf(cr, '### 复审实例复用矩阵（DEV-181）');
  for (const anchor of ['通道选择与复用步骤', '续聊入口', '不得改用持久成员通道', '维度映射']) {
    assert.ok(crSec.includes(anchor), `code-review 复用矩阵缺 DEV-220 锚点：${anchor}`);
  }
});

test('f23) plan-execution 模式 B 含可续性探测程序与回派复用（R-M1-23/DEV-220）', () => {
  const t = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 模式 B：子代理派发');
  for (const anchor of ['可寻址实例清单', '回派', '续聊入口', '可续', '完整交接', '实例台账']) {
    assert.ok(sec.includes(anchor), `模式 B 缺 DEV-220 锚点：${anchor}`);
  }
});

// ── f24-f25（2026-10-23 内部任务-225 / 内部决策-060）：设计—测试锚定门禁 ──────────────

test('f24) plan-writing 格式契约第 9 条与 plan-review 受理含测试锚定门禁（ADR-060/R-M3-19）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const start = t.indexOf('## 计划格式契约');
  const end = t.indexOf('\n## 工具', start);
  const contract = start === -1 ? '' : t.slice(start, end === -1 ? undefined : end);
  for (const anchor of [
    '测试锚定', '## 测试锚定', 'check-plan-test-anchors.mjs', '三类合法行形态', '派生', '命令冒烟',
    '说明：', 'n/a', '整体豁免', 'planChangeSurface', 'exit 0', 'exit 1', 'exit 2', 'R-M7-9', '引入批',
  ]) {
    assert.ok(contract.includes(anchor), `格式契约须含「${anchor}」（R-M3-19 契约+边界）`);
  }
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(pr, '### 第 1 步：受理核对');
  for (const anchor of ['测试锚定', 'check-plan-test-anchors.mjs', '引入批', 'exit 1', 'exit 2']) {
    assert.ok(s1.includes(anchor), `受理核对须含「${anchor}」（测试锚定门禁分支+引入批过渡）`);
  }
  const m3 = readFileSync(join(SPECS, 'modules', 'M3-planning-skills.md'), 'utf8');
  assert.ok(m3.includes('R-M3-19'), 'M3 须登记 R-M3-19');
  assert.ok(m3.includes('A-M3-19'), 'M3 须登记 A-M3-19');
});

test('f25) 批次级基线收缩联动与发布绑定锚点（R-M3-20/ADR-060 修正案 1）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 第 1 步：核对入口');
  for (const anchor of ['批次级基线收缩', '同批收缩', '不收缩', 'test-anchors.json']) {
    assert.ok(sec.includes(anchor), `plan-writing 第 1 步缺「${anchor}」（R-M3-20 批次级收缩联动）`);
  }
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const s1 = sectionOf(pr, '### 第 1 步：受理核对');
  for (const anchor of ['批次级基线收缩', '同批收缩', '不收缩']) {
    assert.ok(s1.includes(anchor), `plan-review 受理核对缺「${anchor}」（R-M3-20）`);
  }
  const m3 = readFileSync(join(SPECS, 'modules', 'M3-planning-skills.md'), 'utf8');
  assert.ok(m3.includes('R-M3-20'), 'M3 须登记 R-M3-20');
  assert.ok(m3.includes('A-M3-20'), 'M3 须登记 A-M3-20');
});

// ── f26（2026-10-23 内部任务-186 / 内部决策-062）：doc-discipline 纪律七第五类受众 ──

test('f26 纪律七第五类受众外部合同交付面（ADR-062/M2 R-M2-9/A-M2-8）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const t = readFileSync(join(SKILLS, 'doc-discipline', 'SKILL.md'), 'utf8');
  const sec = sectionOf(t, '### 纪律七：受众分层');
  assert.ok(sec, 'doc-discipline 须含纪律七节');
  for (const anchor of ['外部合同交付', '甲方', '最小交付', '内部任务号', '不得悬空', '投影工具生成', '审计对象']) {
    assert.ok(sec.includes(anchor), `纪律七第五类受众缺锚点「${anchor}」（ADR-062 D9）`);
  }
  const m2 = readFileSync(join(SPECS, 'modules', 'M2-assessment-clarification-skills.md'), 'utf8');
  assert.ok(m2.includes('R-M2-9'), 'M2 须登记 R-M2-9');
  assert.ok(m2.includes('A-M2-8'), 'M2 须登记 A-M2-8');
});

// ── 运行观测能力域登记（2026-10-24 内部任务-192 P2，内部决策-063 D9；A-ha-10 锚面） ──────────────────

test('M22 运行观测能力域登记', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  // A-ha-10 承载（R-ha-10）：四宿主×四能力域的**文本事实源**两处必须同时在位——
  // 内部接口-1「运行观测能力登记」节（唯一人工事实源）与 内部模块-22 §B 细表（同步登记面）；
  // 核心机器可读镜像 `observation-capability-contract.json` 的一致性由对拍单测把守，
  // 本用例只锁规格文本不消失（锚点用短语，容许措辞演进）。
  const ifHost = readFileSync(join(SPECS, 'interfaces', 'IF-HOST-1.md'), 'utf8');
  const capsStart = ifHost.indexOf('## 运行观测能力登记');
  assert.ok(capsStart >= 0, 'IF-HOST-1 须含「运行观测能力登记」节（D9.1）');
  const capsEnd = ifHost.indexOf('\n## 激活登记', capsStart);
  const capsBlock = capsEnd === -1 ? ifHost.slice(capsStart) : ifHost.slice(capsStart, capsEnd);
  assert.ok(capsBlock.includes('| 能力域 | ZCode | DSH | MCode | Kimi |'), '四宿主×四能力域表头在位（ZCode/DSH/MCode/Kimi 四列）');
  for (const domain of ['①失败事实供给', '②钩失败观测面', '③提醒注入时效', '④自检可达性']) {
    assert.ok(capsBlock.includes(domain), `能力登记表缺能力域行「${domain}」`);
  }
  const capRows = capsBlock.split('\n').filter((line) => /^\|\s*[①②③④]/.test(line));
  assert.equal(capRows.length, 4, '能力登记表须恰四行（四能力域）');
  assert.ok(capsBlock.includes('原生可用／适配层供给／降级可用／不可用／未验证'), '取值闭集五态在位（原生可用/适配层供给/降级可用/不可用/未验证）');
  // 逐格事实锚（内部接口-1 是能力事实的唯一人工源；内部模块-22 只同步登记，不另立事实）：
  for (const anchor of ['PostToolUseFailure', 'hook.run.failed', 'hook-diagnostics.log', '适配层供给', '不可用', '待投递中继', 'agent.inject', 'emit']) {
    assert.ok(capsBlock.includes(anchor), `能力登记表缺事实锚点「${anchor}」`);
  }
  assert.ok(capsBlock.includes('observation-capability-contract.json'), '须登记核心消费的机器可读镜像路径（修正案 1 决策 13）');
  assert.ok(capsBlock.includes('唯一人工事实源'), '须明示唯一人工事实源仍是本表（防核心内置默认表双源）');
  assert.ok(capsBlock.includes('IF-COLLAB-26'), '须登记观测事件接入契约指向 IF-COLLAB-26');
  // 内部模块-22 §B 同步面（2026-10-24 内部任务-192 增；2026-10-25 内部任务-209 内部未决-198 收口：两行入 18 行矩阵、细表迁 §B）。
  const m22 = readFileSync(join(SPECS, 'modules', 'M22-host-adapters-overview.md'), 'utf8');
  const sectionB = m22.indexOf('### B 跨宿主能力矩阵');
  const sectionC = m22.indexOf('### C 机制差异留档');
  assert.ok(sectionB >= 0 && sectionC > sectionB, 'M22 §B/§C 节须在位');
  const detailAt = m22.indexOf('#### 运行观测能力域细表');
  assert.ok(detailAt > sectionB && detailAt < sectionC, '细表须已迁入 §B（OPEN-198；不得停留在 §C）');
  const m22Block = m22.slice(detailAt, sectionC);
  assert.ok(m22Block.includes('| 能力域 | ZCode（M23） | DSH（M24） | MCode（M25） | Kimi（M17） |'), 'M22 细表表头＝四宿主分册列');
  for (const domain of ['失败事实供给', '钩失败观测面', '提醒注入时效', '自检可达性']) {
    assert.ok(m22Block.includes(`| ${domain} |`), `M22 细表缺能力域行「${domain}」`);
  }
  const m22Rows = m22Block.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.includes('能力域 |'));
  assert.equal(m22Rows.length, 5, 'M22 细表数据行＝四域＋观测事件接入（R-ha-10 两行同步面）');
  assert.ok(m22Block.includes('观测事件接入（IF-COLLAB-26）'), 'M22 细表须含观测事件接入行');
  for (const anchor of ['PostToolUseFailure', '适配层供给', '不可用', '注入位（即时', '待投递中继', 'selftest']) {
    assert.ok(m22Block.includes(anchor), `M22 细表缺事实锚点「${anchor}」`);
  }
  // 18 行矩阵：两观测行在位且首词属五态闭集（内部未决-198 收口判据）
  const matrix = m22.slice(sectionB, detailAt).split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.includes('能力域 |'));
  assert.equal(matrix.length, 18, `M22 §B 主矩阵须 18 行（实际 ${matrix.length}）`);
  const FIVE = ['原生可用', '物化或转发可用', '降级可用', '不可用', '不适用'];
  for (const domain of ['运行观测能力', '观测事件接入']) {
    const row = matrix.find((line) => line.startsWith(`| ${domain}`));
    assert.ok(row, `§B 18 行须含「${domain}」行（R-ha-10 两行缺位修复）`);
    const cells = row.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '');
    for (const cell of cells.slice(1)) assert.ok(FIVE.some((word) => cell.startsWith(word)), `「${domain}」行首词须属五态：${cell}`);
  }
  // 登记编号在位（R-ha-10/A-ha-10；规格文本与测试锚同批可查）。
  assert.ok(m22.includes('R-ha-10'), 'M22 须登记 R-ha-10');
  assert.ok(m22.includes('A-ha-10'), 'M22 须登记 A-ha-10');
});

// 内部任务-214 批 1（内部模块-1-内部模块-6 全覆盖）新增锚用例：内部模块-1/内部模块-2 组（规格条文一致性/机制文本断言）。
test('g5) 路由表 18 行＋两互斥规则＋全局规则节齐全', () => {
  const text = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const block = sectionOf(text, '## 路由表');
  const rows = block.split('\n').filter((line) => line.startsWith('|') && !line.includes('---') && !line.includes('用户状态'));
  assert.equal(rows.length, 18, '路由表数据行须恰 18 行');
  assert.ok(text.includes('互斥规则 1（调试禁执行）'), '互斥规则 1 展开节在位');
  assert.ok(text.includes('互斥规则 2（验证先于评审）'), '互斥规则 2 展开节在位');
  assert.ok(text.includes('## 全局规则'), '全局规则节在位');
});

test('m1-4) 15 个样例状态判定唯一（路由表条件文本与样例矩阵一致性）', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const m1 = readFileSync(join(SPECS, 'modules', 'M1-workflow-meta.md'), 'utf8');
  assert.ok(m1.includes('**可验证条件**：对 15 个样例用户状态逐一判定'), '规格侧 15 样例可验证条件在位');
  assert.ok(m1.includes('认可既有分析后提出建新插件'), '边界反例样例在位（对象明确/无裁决）');
  for (const mapping of [
    '用户请求审查 → code-review 行',
    '第 17 行 spike-run',
    '第 18 行 disposable-build',
    '第 13 行 algo-loop',
    '第 14 行 research-hypothesis',
    '第 15 行 experiment-design',
    'root-cause-debugging 行',
  ]) {
    assert.ok(m1.includes(mapping), `样例→行映射在位：${mapping}`);
  }
  // 真表核对：解析路由表 18 行数据行，验证映射的目标行/目标 skill 与规格矩阵一致。
  const table = sectionOf(meta, '## 路由表');
  const rows = table.split('\n').filter((line) => line.startsWith('|') && !line.includes('---') && !line.includes('用户状态'));
  assert.equal(rows.length, 18, '路由表数据行 18（映射行号上限）');
  const rowOf = (needle) => rows.findIndex((row) => row.includes(needle));
  assert.ok(rows[rowOf('用户请求审查')].includes('code-review'), '规格映射：用户请求审查 → code-review 行');
  assert.ok(rows[rowOf('报 bug')].includes('root-cause-debugging'), '规格映射：bug 报告 → root-cause-debugging 行');
  for (const [rowNo, skill] of [[13, 'algo-loop'], [14, 'research-hypothesis'], [15, 'experiment-design'], [17, 'spike-run'], [18, 'disposable-build']]) {
    assert.ok(rows[rowNo - 1].includes(skill), `第 ${rowNo} 行路由到 ${skill}（与样例矩阵一致）`);
  }
  assert.ok(meta.includes('提出新想法/新产品方向，无 spec'), '行 1 显式触发条件在位（与样例矩阵一致）');
  assert.ok(meta.includes('任务已明确，方案未定'), '任务已明确行的触发条件在位');
});

test('m1-8) 行 1/2 边界判别（进入条件文本与入口自检一致性）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const brainstorm = readFileSync(join(SKILLS, 'brainstorming', 'SKILL.md'), 'utf8');
  assert.ok(meta.includes('无 spec 且尚无「值得做」裁决'), '行 1 边界：新方向无裁决');
  assert.ok(meta.includes('已持 idea-review「值得做」结论'), '行 2 边界：新方向已持裁决');
  assert.ok(brainstorm.includes('入口自检'), 'brainstorming 入口自检节在位');
  assert.ok(brainstorm.includes('idea-review'), '入口自检指向 idea-review 行');
});

test('g6) 行 1 description 为状态判别且红旗表含认可后提议', () => {
  const text = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('按用户状态唯一命中入口 skill'), '元技能 description 为状态判别口径');
  const redFlags = sectionOf(text, '## 红旗反合理化表');
  assert.ok(redFlags.includes('认可完分析'), '红旗表含「认可后提议」反合理化条目');
  assert.ok(redFlags.includes('idea-review'), '该条目指回 idea-review 行');
});

test('g7) 红旗表含「用户叫我修」且豁免括注口径一致', () => {
  const text = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const redFlags = sectionOf(text, '## 红旗反合理化表');
  assert.ok(redFlags.includes('用户叫我修'), '红旗表含「用户叫我修」条目');
  assert.ok(redFlags.includes('豁免须显式表态'), '条目写明豁免须显式表态');
  assert.ok(text.includes('对结果目标的指令不构成流程豁免'), '计划已批准行豁免括注口径一致');
});

test('g8) 行 16 特征 opt-in 分支与 scout 措辞对齐', () => {
  const text = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const scout = readFileSync(join(SCOUT_SKILLS, 'scout', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('或任务呈探索性/一次性交付特征'), '行 16 含特征分支（opt-in 两态）');
  assert.ok(text.includes('由用户确认 mode 与 expiry 后开'), '特征分支须用户确认 mode/expiry');
  assert.ok(scout.includes('探索') && scout.includes('一次性交付'), 'scout 适用场景措辞与表行对齐');
});

test('m1) idea-review/brainstorming/code-discipline 含 R-M2-1..4 要素', () => {
  const idea = readFileSync(join(SKILLS, 'idea-review', 'SKILL.md'), 'utf8');
  const brainstorm = readFileSync(join(SKILLS, 'brainstorming', 'SKILL.md'), 'utf8');
  const discipline = readFileSync(join(SKILLS, 'code-discipline', 'SKILL.md'), 'utf8');
  assert.ok(idea.includes('评估结论'), 'idea-review 含三态评估结论要素');
  assert.ok(brainstorm.includes('三档'), 'brainstorming 含三档分级要素');
  assert.ok(discipline.includes('外科手术'), 'code-discipline 含外科手术式修改要素');
});

test('m2) brainstorming 的 .sdd 出现面仅为移交指引', () => {
  const brainstorm = readFileSync(join(SKILLS, 'brainstorming', 'SKILL.md'), 'utf8');
  const lines = brainstorm.split('\n').filter((line) => line.includes('.sdd'));
  assert.ok(lines.length >= 1, 'brainstorming 须出现 .sdd（移交面）');
  for (const line of lines) assert.ok(line.includes('移交'), `含 .sdd 的行须为移交指引：${line.slice(0, 60)}`);
});

test('m2-4) 新想法→评估→澄清无双重触发（路由表第 1/2 行边界与描述文本一致性）', () => {
  const text = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const brainstorm = readFileSync(join(SKILLS, 'brainstorming', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('无 spec 且尚无「值得做」裁决'), '行 1 触发条件：新想法无裁决先评估');
  assert.ok(text.includes('已持 idea-review「值得做」结论'), '行 2 触发条件：已持裁决才进澄清');
  assert.ok(brainstorm.includes('方案未定'), 'brainstorming 描述与行 2 边界一致');
});

// 内部任务-214 批 1 新增锚用例：内部模块-3/内部模块-4 组（计划/执行/调试/评审技能契约）。
test('p1) plan-writing 三模式语义与 plan-review 四视角齐全', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(pr.includes('四视角'), 'plan-review 四视角评审面在位');
  assert.ok(pw.includes('零上下文'), 'plan-writing 零上下文读者假设在位');
  assert.ok(pw.includes('任务尺寸'), 'plan-writing 任务尺寸纪律在位');
});

test('p2) plan-writing 第 4/5 步含来源意见处置与自查检项', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(pw.includes('来源意见的处置状态'), '第 4 步来源意见四态处置条在位');
  assert.ok(pw.includes('自查'), '第 5 步落笔前自查检项在位');
});

test('p3) plan-review 受理含「收尾缺审查步骤」阻塞项', () => {
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(pr.includes('收尾审查'), '受理核对含收尾审查判定（R-M3-11）');
  assert.ok(pr.includes('受理核对'), 'plan-review 受理核对节在位');
  assert.ok(pr.includes('阻塞'), '缺项记阻塞项语义在位');
  // 内部任务-349：learnings 沉淀缺项与顺序口径（用受理条新文本独有片段——接口节已有 learnings 提示行，整文件 token 无判别力）
  assert.ok(pr.includes('缺「learnings 沉淀」步骤'), '受理核对须含 learnings 沉淀缺项（R-M3-11，DEV-349）');
  assert.ok(pr.includes('未排在 verification 之前'), '受理核对须含 learnings 顺序口径（R-M3-11，DEV-349）');
});

test('p3b) plan-writing 收尾节含 learnings 沉淀且排在 verification 前', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  // 按节切片：正文第 5 步与格式契约第 5 条同时出现同词，整文件 token 无判别力
  const contractStart = pw.indexOf('## 计划格式契约');
  assert.ok(contractStart > 0, 'plan-writing 须含格式契约节');
  const contract = pw.slice(contractStart);
  assert.ok(contract.includes('learnings 沉淀须位于'), '契约第 5 条须锁定 learnings 顺序（DEV-349）');
  assert.ok(contract.includes('显式声明「无收获」'), '契约第 5 条须含无收获显式出口（DEV-349）');
  assert.ok(contract.includes('learnings.md'), '契约第 5 条须指向 learnings.md（DEV-349）');
  const step5 = pw.slice(pw.indexOf('### 第 5 步'), contractStart);
  assert.ok(step5.includes('见格式契约第 5 条'), '第 5 步须保留指向契约第 5 条的指针（禁正文双写，DEV-349）');
  const pe = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  assert.ok(pe.includes('learnings 沉淀'), 'plan-execution 收尾须含 learnings 沉淀指针（DEV-349）');
  assert.ok(pe.includes('verification 签发前'), 'plan-execution 须写明写入时点在 verification 签发前（DEV-349）');
});

test('p4) plan-writing 第 1 步批准凭据三形态与 decisionSource', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(pw.includes('decisionSource'), '批准凭据来源字段 decisionSource 在位');
  assert.ok(pw.includes('批准凭据'), '批准凭据形态核对条在位');
  assert.ok(pw.includes('brainstorming') && pw.includes('退回'), '三类来源以外退回 brainstorming');
});

test('p5) plan-review 受理含「长任务缺阶段复审门」', () => {
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(pr.includes('阶段复审'), '阶段复审门判定在位');
  assert.ok(pr.includes('8 步'), '长任务阈值口径（超 8 步）在位');
  assert.ok(pr.includes('长任务'), '长任务缺阶段复审门条在位');
});

test('x1) plan-execution 三模式章与隔离工作区前置', () => {
  const pe = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  assert.ok(pe.includes('模式 A') && pe.includes('模式 B') && pe.includes('模式 C'), '三种执行模式章节齐备');
  assert.ok(pe.includes('隔离工作区'), '隔离工作区前置条件在位');
});

test('x2) tdd 含 Goal-Driven 节与 IF-COLLAB-5 引用', () => {
  const tdd = readFileSync(join(SKILLS, 'tdd', 'SKILL.md'), 'utf8');
  assert.ok(tdd.includes('Goal-Driven'), 'tdd Goal-Driven 成功标准节在位');
  assert.ok(tdd.includes('IF-COLLAB-5'), 'tdd 引用证据契约 IF-COLLAB-5');
});

test('x3) root-cause 含 Iron Law/3-strike/DEBUG REPORT/缺陷判定', () => {
  const rc = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  assert.ok(rc.includes('Iron Law'), 'Iron Law 节在位');
  assert.ok(rc.includes('3-strike'), '3-strike 规则在位');
  assert.ok(rc.includes('DEBUG REPORT'), 'DEBUG REPORT 载体在位');
  assert.ok(rc.includes('缺陷'), '缺陷判定/规格影响判定语义在位');
});

test('x4) 证据格式节含命令/退出码/摘要/关联 ID（IF-COLLAB-5）', () => {
  const tdd = readFileSync(join(SKILLS, 'tdd', 'SKILL.md'), 'utf8');
  const bf = readFileSync(join(SKILLS, 'branch-finishing', 'SKILL.md'), 'utf8');
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(tdd.includes('IF-COLLAB-5'), '证据格式契约引用 IF-COLLAB-5');
  assert.ok(bf.includes('命令/退出码/输出摘要俱全'), '证据四要素消费面在位（命令/退出码/摘要）');
  assert.ok(pw.includes('验收行'), '机制面验收行语义在位');
});

test('x5) plan-execution 阶段复审节与三级处置判据', () => {
  const pe = readFileSync(join(SKILLS, 'plan-execution', 'SKILL.md'), 'utf8');
  assert.ok(pe.includes('三级处置'), '漂移三级处置节在位');
  assert.ok(pe.includes('计划未破'), '一级处置（计划未破就地纠偏）在位');
  assert.ok(pe.includes('计划破了'), '二级处置（计划破了回炉重审）在位');
});

// 内部任务-214 批 1 新增锚用例：内部模块-5/内部模块-6 组（评审/验证与收尾技能契约）。
test('v1) code-review 两章节＋八 specialist 派发面齐全', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('## 发起评审（流程上章）'), '发起评审章标题在位');
  assert.ok(cr.includes('## 接收评审（流程下章）'), '接收评审章标题在位');
  const specialistRows = cr.split('\n').filter((line) => line.startsWith('|') && line.includes('specialists/'));
  assert.equal(specialistRows.length, 8, 'specialist 派发表恰 8 行（八专职提示词）');
  for (const name of ['testing', 'security', 'performance', 'concurrency', 'api-contract', 'error-handling', 'data-integrity', 'docs-consistency']) {
    assert.ok(specialistRows.some((row) => row.includes(`specialists/${name}.md`)), `specialist 文件在位：${name}.md`);
  }
});

test('v2) ≥80 置信度协议与低置信不报告', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('置信度'), '置信度协议在位');
  assert.ok(cr.includes('80'), '≥80 置信度阈值口径在位');
  assert.ok(cr.includes('低置信') && cr.includes('不报告'), '低置信不报告规则在位');
});

test('v3) verification 证据先行纪律与 IF-COLLAB-5 引用', () => {
  const vf = readFileSync(join(SKILLS, 'verification', 'SKILL.md'), 'utf8');
  assert.ok(vf.includes('证据先于断言'), '证据先于断言纪律在位');
  assert.ok(vf.includes('IF-COLLAB-5'), '引用证据契约 IF-COLLAB-5');
});

test('v4) feature-dev 薄命令七步且每步单行 skill 调用', () => {
  const fd = readFileSync(join(SKILLS, '..', 'commands', 'feature-dev.md'), 'utf8');
  assert.ok(fd.includes('共七步'), 'thin command 七步编排在位');
  assert.ok(fd.includes('只串联 skill 调用') || fd.includes('薄命令'), '薄命令（流程细节在 skill 正文）语义在位');
  assert.ok(fd.includes('七步'), '七步计数口径在位');
});

// 内部任务-244 T06 偏差登记：内部验收-5 为**文本锚**（路由表/评审入口文本一致性）；「验证未运行时执行面
// 拒绝」无可执行载体（code-review 是 skill 文本，无 CLI 入口）。原计划「waiver 或补执行面断言」
// 两途均未落（waiver 上限 2 已满；执行面断言无载体），本批保持既有文本锚不动、不新增 waiver；
// 偏差已登记于 内部证据 步骤 21 行，后续 spec-writing 批承接。
test('m5-5) 验证未运行时路由表拒评审（路由表 verification 前置行与评审入口文本一致性）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(meta.includes('verification 证据未运行，code-review 不得开始'), '路由表互斥规则 2 在位');
  assert.ok(cr.includes('未运行'), '评审入口含 verification 前置判定');
});

test('v5) 评审对象三态与全量模式取证义务', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('三态'), '评审对象三态判定在位');
  assert.ok(cr.includes('全量'), '全量模式取证义务在位');
});

test('v6) 受理核验两路径与退回 verification 措辞', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('受理'), '受理核验章节在位');
  assert.ok(cr.includes('退回 verification'), '拒绝受理退回 verification 措辞在位');
});

test('c6) 四收尾 skill 要素结构齐全（branch/retro/learnings/health）', () => {
  const anchors = {
    'branch-finishing': 'finalize',
    retro: 'B-M6-4',
    learnings: 'learning',
    health: '评分',
  };
  for (const [name, anchor] of Object.entries(anchors)) {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(anchor), `${name} 关键要素锚点在位：${anchor}`);
    assert.ok((text.match(/^## /gm) ?? []).length >= 2, `${name} 章节结构齐全（≥2 节）`);
  }
});

test('c7) suite.json 受检文档清单不含本模块四类资产', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const root = resolve(SPECS, '..');
  const suite = JSON.parse(readFileSync(join(root, '.sdd', 'suite.json'), 'utf8'));
  const docs = (suite.documents ?? []).map((d) => (typeof d === 'string' ? d : d.path ?? ''));
  assert.ok(docs.length >= 100, 'suite 受检文档清单非空（141 量级）');
  const hits = docs.filter((p) => /branch-finishing|retro|learnings|health/i.test(p));
  assert.equal(hits.length, 0, `受检清单不得含收尾四类资产：${hits.join(',')}`);
});

test('m6-4) retro 每次评审带证据引用（断言 retro SKILL.md 的 B-M6-4 规则与正反例条文）', () => {
  const retro = readFileSync(join(SKILLS, 'retro', 'SKILL.md'), 'utf8');
  // 动态定位含 B-M6-4 的节标题（不锁编号/引号措辞），节切片到下一个标题为止。
  const lines = retro.split('\n');
  const start = lines.findIndex((line) => line.startsWith('#') && line.includes('B-M6-4'));
  assert.ok(start >= 0, 'B-M6-4 规则节标题存在');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  const rule = lines.slice(start, end).join('\n');
  assert.ok(rule.includes('必须引用具体锚点'), '规则条：每条评价必须引用具体锚点');
  assert.ok(rule.includes('提交短哈希'), '锚点类型：提交短哈希');
  assert.match(rule, /合格\s*[：:]/u, '正例条文在位');
  assert.match(rule, /不合格\s*[：:]/u, '反例条文在位');
  assert.ok(rule.includes('禁止凭印象编造'), '禁止编造锚点的约束在位');
});

// 内部任务-214 批 2（内部模块-7/内部模块-9）新增锚用例：规格门/探路技能契约（条文一致性口径，每条 ≥2 独立事实）。
test('f27) sdd-ddd-tdd 正文无 TDD 执行步骤且按名引用 tdd skill（R-M7-1）', () => {
  const sdd = readFileSync(join(SPEC_GATE_SKILLS, 'sdd-ddd-tdd', 'SKILL.md'), 'utf8');
  assert.ok(sdd.includes('## 7 TDD 门禁（RULE-TDD-001..005）'), 'TDD 门禁章节在位');
  assert.ok(sdd.includes('由 workflow 插件的 `tdd` skill 承载'), '执行纪律按名移交 tdd skill');
  assert.ok(sdd.includes('本技能保留 RULE-TDD 的规则 ID'), '本技能仅保留规则 ID/证据校验职责');
  assert.ok(sdd.includes('不编排实现流程'), '本技能不编排实现流程（无 TDD 执行步骤）');
  // S6 正确性维 F4：§7 正文负向扫描——不得出现 TDD 执行步骤标记（未来加步骤本用例即红；
  // 「红-绿-重构怎么操作」是移交 tdd skill 的免责句，不作标记）
  const section7 = sdd.slice(sdd.indexOf('## 7 '), sdd.indexOf('## 8 '));
  assert.ok(section7.length > 0, '§7 正文可切片');
  for (const marker of ['执行步骤', '动手步骤', '操作步骤']) {
    assert.ok(!section7.includes(marker), `§7 不得含 TDD 执行步骤标记：${marker}`);
  }
});

test('f28) 判定矩阵三结论各带理由栏位且触发权归路由表（R-M7-2）', () => {
  const sdd = readFileSync(join(SPEC_GATE_SKILLS, 'sdd-ddd-tdd', 'SKILL.md'), 'utf8');
  assert.ok(sdd.includes('分别判定并记录理由'), '三项独立输出且记录理由');
  for (const axis of ['**SDD**：`required`', '**DDD**：', '**TDD**：']) {
    assert.ok(sdd.includes(axis), `判定矩阵含 ${axis} 栏位`);
  }
  assert.ok(sdd.includes('由 workflow 元技能路由表在进入 plan-execution 前触发'), '触发权归路由表');
});

test('f29) 完成门禁仅指向 /gate 且 RULE-FLOW-003/004 引用恰一处（R-M7-3）', () => {
  const sdd = readFileSync(join(SPEC_GATE_SKILLS, 'sdd-ddd-tdd', 'SKILL.md'), 'utf8');
  assert.ok(sdd.includes('## 8 完成门禁（RULE-FLOW-003/004）'), '完成门禁章节标题在位');
  assert.ok(sdd.includes('完成门禁以 `/gate` 命令为唯一聚合入口'), '唯一聚合入口指向 /gate');
  const occurrences = sdd.split('RULE-FLOW-003').length - 1;
  assert.equal(occurrences, 1, `RULE-FLOW-003 引用须恰一处（实得 ${occurrences}）`);
  // S6 正确性维 F3：标题承诺 003/004 联合引用，断言联合标记亦恰一处（004 仅以联合标题形态登记）
  const pairOccurrences = sdd.split('RULE-FLOW-003/004').length - 1;
  assert.equal(pairOccurrences, 1, `RULE-FLOW-003/004 联合引用须恰一处（实得 ${pairOccurrences}）`);
});

test('f30) spec-writing 第七条「先读代码」纪律在位（R-M7-4）', () => {
  const sw = readFileSync(join(SPEC_GATE_SKILLS, 'spec-writing', 'SKILL.md'), 'utf8');
  assert.ok(sw.includes('7. **先读代码再盘问**'), '第七条先读代码纪律在位');
  assert.ok(sw.includes('引用 file:line'), '纪律要求引用 file:line 证据');
});

test('f31) gate SKILL 单源含交付报告核验与模式固化、命令为薄指针（R-M7-12）', () => {
  const gate = readFileSync(join(SPEC_GATE_SKILLS, 'gate', 'SKILL.md'), 'utf8');
  for (const anchor of ['单一事实源', '薄指针', '交付草案存在性与必检节', 'delivery-final.json']) {
    assert.ok(gate.includes(anchor), `gate SKILL 缺单源/交付锚点：${anchor}`);
  }
  const command = readFileSync(join(SPEC_GATE_SKILLS, '..', 'commands', 'gate.md'), 'utf8');
  assert.ok(command.length < 800, '命令须为薄指针（不内联流程细节）');
  assert.ok(command.includes('薄指针') && command.includes('skills/gate/SKILL.md'), '命令显式指向 skill 单一事实源');
});

test('纪律三受控通道五要素（DEV-285）：code-discipline 承载受信写者/声明/受检路径窄声明/仓外写通道', () => {
  const text = readFileSync(join(SKILLS, 'code-discipline', 'SKILL.md'), 'utf8');
  for (const anchor of ['一律使用 Edit/Write', '受信写者工具', 'mechanical-edit', 'evidence-gen', '--script-write', '--script-edit-code', '受检路径', '仓外写', 'ADR-066']) {
    assert.ok(text.includes(anchor), `code-discipline 缺受控通道锚点：${anchor}`);
  }
});

test('f32) scout 三 skill Safety Floor 齐备且 scout-repro 档位不提升（R-M9-10）', () => {
  const texts = Object.fromEntries(['scout', 'spike-run', 'disposable-build']
    .map((name) => [name, readFileSync(join(SCOUT_SKILLS, name, 'SKILL.md'), 'utf8')]));
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.includes('## Safety Floor（不可降级'), `${name} Safety Floor 章节在位`);
    assert.ok(text.includes('scout-repro 档'), `${name} 含 scout-repro 档位（不提升）`);
  }
  assert.ok(texts.scout.includes('不随模式降级'), 'scout 明示安全/隐私/数据完整性不随模式降级');
  assert.ok(texts.scout.includes('gate 不得将其报告为 full'), 'scout 明示 gate 不得报 full');
  assert.ok(texts['spike-run'].includes('gate 不得将其报告为 full'), 'spike-run 明示 gate 不得报 full');
  assert.ok(texts['disposable-build'].includes('IF-COLLAB-11'), 'disposable-build 绑定统一凭据链档位');
});



// ── 内部任务-342 / 内部决策-069：评审→修复→复审机制（评审记录口径收紧） ──

test('f33) 修复设计决策与复审对象（ADR-069 D1/D3，四字段＋每轮 fresh 回归＋批次 full 独立）', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const sec = sectionOf(cr, '### 修复设计决策与复审对象（D-M5-5，ADR-069）');
  assert.ok(sec, 'code-review 须有「修复设计决策与复审对象（D-M5-5，ADR-069）」节');
  const recvIdx = cr.indexOf('## 接收评审（流程下章）');
  const secIdx = cr.indexOf('### 修复设计决策与复审对象');
  const verifyIdx = cr.indexOf('### 验证先于处置');
  assert.ok(recvIdx !== -1 && secIdx !== -1 && verifyIdx !== -1, '接收章/修复节/验证先于处置三锚须在位');
  assert.ok(recvIdx < secIdx && secIdx < verifyIdx, '该节须位于接收评审章内、验证先于处置之前');
  for (const kw of ['病根分类', '修复后不变量', '修复批次', '设计缺口回退']) {
    assert.ok(sec.includes(kw), `修复设计决策缺四字段：${kw}`);
  }
  for (const kw of ['评审建议文本不得直接作为修复依据', '按不变量重新推导改法', '每轮', '至少 1 个 fresh 回归实例', 'fresh 回归实例不计入 fixReviewInstances', '批次交互', '不替代', '逐条标注 fix-induced', '缺失 D1 修复设计决策节', 'delta/full 轮', 'none/self', '双向独立', 'brainstorming', 'spec-writing', 'plan-writing']) {
    assert.ok(sec.includes(kw), `修复设计决策缺硬句要素：${kw}`);
  }
  const grading = sectionOf(cr, '### 修复后的复审分级（D-M5-4）');
  assert.ok(grading.includes('单意见/单位置局部修复'), 'D-M5-4 档位表须含 delta 单意见/单位置限定');
  assert.ok(grading.includes('none/self 轮以 D1 记录与回归证据自证、不派实例'), 'D-M5-4 节须写明 none/self 自证例外（精确句）');
  assert.ok(grading.includes('批次交互'), 'D-M5-4 档位表须含 full 批次交互触发');
  assert.ok(grading.includes('fresh 回归实例职责'), 'D-M5-4 节须写明每轮 fresh 回归实例职责');
  assert.ok(grading.includes('不计入 fixReviewInstances'), 'D-M5-4 节须写明 fresh 回归不计入 fixReviewInstances');
});

test('f34) 评审输出三件套与补丁建议不作修复依据（ADR-069 D4）', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  const scope = sectionOf(cr, '### 评审对象与范围（三态，R-M5-8）');
  assert.ok(scope.includes('计划设计决策/不变量清单'), '派发输入须附计划设计决策/不变量清单');
  const conf = sectionOf(cr, '### ≥80 置信度协议（R-M5-2）');
  const three = sectionOf(cr, '### 三维并行评审（code-reviewer agent）');
  for (const [name, sec] of [['≥80 协议', conf], ['三维汇总', three]]) {
    for (const kw of ['违反的要求或不变量', '证据', '0-100 置信度', '补丁建议不作为修复依据']) {
      assert.ok(sec.includes(kw), `${name} 缺三件套/补丁语义：${kw}`);
    }
  }
});

test('f35) 熔断五因子与反 churn 阈值（ADR-069 D2）', () => {
  const meta = readFileSync(join(SKILLS, 'workflow', 'SKILL.md'), 'utf8');
  const line = meta.split('\n').find((l) => l.includes('评审轮次熔断（3 轮 ROI 评估'));
  assert.ok(line, '元技能须有评审轮次熔断条');
  for (const kw of ['五因子', '非 fix-induced', 'fix-induced ≥2', '≥80 非重复', '半数', '不得以「边际收益高」继续', '设计修订', '上一轮修复诱发', 'blocking 新发现', '逐条标注 fix-induced', '每轮']) {
    assert.ok(line.includes(kw), `熔断条缺要素：${kw}`);
  }
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(pr.includes('每轮逐条标注 fix-induced'), 'plan-review 链亦须含每轮 fix-induced 标注义务（ADR-069 D2）');
});

test('f36a) plan-review 修订前置修复设计决策（ADR-069 D1）', () => {
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  const redo = pr.split('\n').find((l) => l.includes('评审未通过后的重审'));
  assert.ok(redo && redo.includes('修复设计决策节'), '重审条须要求先产修复设计决策节');
  const rootCause = pr.split('\n').find((l) => l.includes('病根判定（R-M3-14）'));
  assert.ok(rootCause && rootCause.includes('修复设计决策节') && rootCause.includes('未产出即修订未完成'), '收尾病根判定须引用修复设计决策节且未产出即阻塞');
  const advice = pr.split('\n').find((l) => l.includes('**建议**：'));
  assert.ok(advice && advice.includes('方向性提示，非实施依据'), '输出格式建议列须收窄为方向性提示、非实施依据');
});

test('f36b) plan-writing 修订前置修复设计决策（R-M3-9/R-M3-14）', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  const r9 = pw.split('\n').find((l) => l.includes('来源意见的处置状态（R-M3-9）'));
  assert.ok(r9 && r9.includes('修复设计决策'), 'R-M3-9 条须含修复设计决策');
  const r14 = pw.split('\n').find((l) => l.includes('设计面核验（R-M3-14）'));
  assert.ok(r14 && r14.includes('同 R-M3-9'), 'R-M3-14 条须以 R-M3-9 指针落字（避免双写）');
});


test('f37) 项目 skill 消费义务与声明纪律', () => {
  const text = readFileSync(new URL('../../skills/workflow/SKILL.md', import.meta.url), 'utf8');
  const rules = sectionOf(text, '## 全局规则');
  assert.ok(rules && rules.includes('项目 skill 消费义务'), '全局规则须含项目 skill 消费义务条');
  assert.ok(rules.includes('--project-skill'), '规则条须含 --project-skill 指针');
  assert.ok(rules.includes('x-required-on-write'), '规则条须含必载声明键');
  assert.ok(rules.includes('projectSkills'), '规则条须含租约字段名');
  const decl = text.split('\n').find((line) => line.includes('命中行须机械声明'));
  assert.ok(decl && decl.includes('--project-skill'), '声明纪律句须含 --project-skill');
  assert.equal(rules.includes('project-conventions'), false, '规则条不得写死具体项目 skill 名');
});

// ── 内部未决-210 转锚（内部任务-347 批 B2）：文本行为锚——断言既有受控文本，判别力由「改文本必红」承载 ──

test('OPEN-210 R-M3-6：plan-writing 委派计数与 plan-review 事实核查不计入口径', () => {
  const pw = readFileSync(join(SKILLS, 'plan-writing', 'SKILL.md'), 'utf8');
  assert.ok(pw.includes('1-3 个 code-explorer'), '勘察步须写 1-3 个 code-explorer 并行口径（R-M3-6）');
  assert.ok(pw.includes('2-3 个实例各领一个侧面或倾向'), '设计步须写 2-3 个实例口径（R-M3-6）');
  const pr = readFileSync(join(SKILLS, 'plan-review', 'SKILL.md'), 'utf8');
  assert.ok(pr.includes('事实核查实例不计入'), 'plan-review 须写事实核查不计入评审实例数（R-M3-6）');
  assert.ok(pr.includes('不承担默认两视角的评审判断'), '不计入的理由句（只核对事实不承担评审判断）须在案（R-M3-6）');
});

test('OPEN-210 R-M4-7：修复前最小复现测试与不可行替代验证纪律', () => {
  const rc = readFileSync(join(SKILLS, 'root-cause-debugging', 'SKILL.md'), 'utf8');
  assert.ok(rc.includes('先写最小复现测试再修'), '修复前必须存在最小复现测试义务句（R-M4-7/RULE-TDD-005）');
  assert.ok(rc.includes('原因与替代验证'), '复现不可行时必须记录原因与替代验证（R-M4-7）');
});

test('OPEN-210 R-M5-3：code-review 规格歧义判定必填节与回流', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('规格歧义判定（必填节，IF-COLLAB-4）'), '接收章须含规格歧义判定必填节（R-M5-3）');
});

test('OPEN-210 R-M5-7：评审意见双处置边界（代码级/规格文档）', () => {
  const cr = readFileSync(join(SKILLS, 'code-review', 'SKILL.md'), 'utf8');
  assert.ok(cr.includes('代码级意见不得处置规格文档本身'), '双处置边界句须在案（R-M5-7/B-M5-2）');
  assert.ok(cr.includes('review_disposition'), '规格文档意见处置归属 review_disposition 须点名（R-M5-7）');
});

test('OPEN-210 R-M9-4：spike-run 一次性标注与保留须重新分级过批准门', () => {
  const sp = readFileSync(join(SCOUT_SKILLS, 'spike-run', 'SKILL.md'), 'utf8');
  assert.ok(sp.includes('一次性'), '一次性标注纪律须在案（R-M9-4）');
  assert.ok(sp.includes('重新分级（brainstorming 三档）并独立过批准门'), '保留须重新分级过批准门（R-M9-4）');
});

test('OPEN-210 R-M9-5：disposable-build 处置标注与无显式毕业不并入主干', () => {
  const db = readFileSync(join(SCOUT_SKILLS, 'disposable-build', 'SKILL.md'), 'utf8');
  assert.ok(db.includes('标注处置'), '完成即标注处置纪律须在案（R-M9-5）');
  assert.ok(db.includes('未经毕业不得并入主干'), '无显式毕业不并入主干（R-M9-5/B-M9-3）');
});
