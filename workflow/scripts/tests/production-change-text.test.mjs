// 文件：production-change-text.test.mjs
// 描述：production-change 入口与相邻 skill 增强的文本契约测试（内部验收-2/3、内部验收-3）——
//       十二阶段编排、人工授权中断、checklist 只消费 policy 输出、incident lane、
//       交接节、claim 分层锚点、无第二入口。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = readFileSync(join(ROOT, 'workflow/skills/production-change/SKILL.md'), 'utf8');
const CHECKLIST = readFileSync(join(ROOT, 'workflow/skills/production-change/checklist.md'), 'utf8');
const RCD = readFileSync(join(ROOT, 'workflow/skills/root-cause-debugging/SKILL.md'), 'utf8');
const BF = readFileSync(join(ROOT, 'workflow/skills/branch-finishing/SKILL.md'), 'utf8');
const VER = readFileSync(join(ROOT, 'workflow/skills/verification/SKILL.md'), 'utf8');
const ROUTING = readFileSync(join(ROOT, 'workflow/skills/workflow/SKILL.md'), 'utf8');

function join(...parts) {
  return parts.join('/');
}

test('production-change：十二阶段编排齐备且顺序含授权中断', () => {
  const stages = ['装载交接', '建立/读取变更记录', '刷新 PR/CI', '生产就绪', 'release',
    '部署/安装授权', '环境推进与迁移', '观测窗口', 'UAT', 'claim 顶层', '反馈引用留存', '收尾'];
  for (const s of stages) assert.ok(SKILL.includes(s), `缺阶段：${s}`);
  assert.ok(SKILL.includes('中断等待明确授权'), '外部副作用前必须中断等待授权（内部决策-2）');
  assert.ok(SKILL.includes('回路由表'), '失败信号必须回路由表');
});

test('production-change：机械裁决只指向 内部接口-13，无第二判定源', () => {
  assert.ok(SKILL.includes('内部接口-13'));
  assert.ok(SKILL.includes('gate --claim'), '须给出 gate --claim 裁决命令');
  // 第二入口的形态是"命令正文建议新增 slash 命令"，不是正文里出现 release/deploy 单词
  assert.ok(!/`\/(release|deploy|rollback|incident|production-ready)`/.test(SKILL),
    '不得建议平行生产 slash 命令（形如 `/release`）');
  // 2026-10-25 内部任务-214 批 2 S5 采样 B1：删除历史恒真断言（`!… || true`），checklist 透传面由下条
  // 「只消费 policy 输出」用例承载，此处不再保留空断言。
});

test('checklist：只消费 policy 输出，不复制 specialist 正文', () => {
  assert.ok(CHECKLIST.includes('policy 输出'), 'checklist 须声明消费 policy 输出');
  assert.ok(!CHECKLIST.includes('specialists/'), 'checklist 不得复制 specialist 正文');
  assert.ok(CHECKLIST.includes('不可豁免'), '底线核对项存在');
});

test('root-cause：active incident lane 含协调五项与 incidentRef 留痕', () => {
  assert.ok(RCD.includes('活跃事故车道'), 'incident lane 节存在');
  for (const anchor of ['严重级', '事故负责人', '时间线', '证据保全', 'incident-ref']) {
    assert.ok(RCD.includes(anchor), `incident lane 缺锚点：${anchor}`);
  }
  assert.ok(RCD.includes('止血完成 ≠ 事故闭环'), '止血后回根因调查的衔接存在');
});

test('branch-finishing：交付前置含 delivery-final，交接节存在且不推进', () => {
  assert.ok(BF.includes('delivery-final'), '收尾前置须含交付报告（gate receipt 链）');
  assert.ok(BF.includes('生产交付交接'), '交接节存在（内部规则-5）');
  assert.ok(BF.includes('只交接不推进'), '本 skill 不等待 CI/不发布/不部署');
  assert.ok(BF.includes('production.mjs') && BF.includes('init'), '交接含 create-change 命令（node 入口；内部决策-051 阶段1b）');
});

test('verification：claim 分层锚点（code-complete 不冒充高层）', () => {
  assert.ok(VER.includes('code-complete 层'), 'claim 分层表述存在');
  assert.ok(VER.includes('内部接口-13'), '高层 claim 指向 内部接口-13');
});

test('路由表：第 8 行生产行存在且置于 code-review 之后', () => {
  const rows = ROUTING.split('\n').filter((l) => l.startsWith('| ') && l.includes('`'));
  const routingRows = ROUTING.split('\n').filter((l) => /^\| [^|]+\| `/.test(l.replace(/\s+/g, ' ')));
  const findRow = (name) => routingRows.findIndex((r) => r.includes(`\`${name}\``));
  const prodIdx = findRow('production-change');
  const rcIdx = findRow('root-cause-debugging');
  const crIdx = findRow('code-review');
  assert.ok(prodIdx >= 0, '路由表含 production-change 行');
  assert.ok(rcIdx >= 0 && prodIdx > rcIdx, '生产行在 root-cause 行之后（异常优先）');
  assert.ok(prodIdx < findRow('verification'), '生产行在完成声称行之前');
  assert.ok(crIdx >= 0);
  // S5 采样 W6：标题承诺「置于 code-review 之后」必须被真断言（不只是存在性）
  assert.ok(prodIdx > crIdx, '生产行须位于 code-review 行之后（路由顺序契约）');
});
