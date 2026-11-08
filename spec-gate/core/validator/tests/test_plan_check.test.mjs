// RULE-PLAN-001：plan 校验（specRefs/验收/架构锚/BOM/CJK）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPlan, knownIds, STEP_HEADING_RE } from '../core/plan_check.mjs';
import { CORE_ROOT, MANIFEST_PATH } from './helpers.mjs';

const FIXTURES = join(CORE_ROOT, 'validator/tests/fixtures/plans');

function tempSuite() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev151-plan-')));
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, '内部规格'), '# 需求基线\n\n- 内部需求-6：plan 校验模式需求\n');
  writeFileSync(join(root, '内部规格'), '# ADR 册\n\n| 编号 | 状态 |\n|---|---|\n| 内部决策-001 | accepted |\n');
  mkdirSync(join(root, '.sdd'), { recursive: true });
  const config = {
    schemaVersion: '1.0.0', suiteRoot: '..', validationRoots: ['specs'], documents: [],
    manifest: MANIFEST_PATH, allowedPublicAssets: [],
  };
  const configPath = join(root, '内部治理状态');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { root, configPath, config };
}

test('fixtures：悬空 blocking@3 / 缺 refs warning / 缺验收 warning / valid 干净', () => {
  const { configPath, config } = tempSuite();
  const check = (name) => checkPlan(join(FIXTURES, name), config, { configPath });
  const dangling = check('dangling-ref.md');
  assert.equal(dangling.filter((d) => d.severity === 'blocking').length, 1);
  assert.equal(dangling.find((d) => d.severity === 'blocking').line, 3);
  assert.ok(check('no-refs.md').some((d) => d.fixHint.includes('未追溯')));
  assert.ok(check('missing-acceptance.md').some((d) => d.fixHint.includes('验收')));
  assert.deepEqual(check('valid.md'), []);
});

test('F-10：BOM 计划 frontmatter 可解析，悬空引用被检出', () => {
  const { root, configPath, config } = tempSuite();
  const plan = join(root, 'bom.md');
  writeFileSync(plan, '\ufeff---\nspecRefs: [FR-GHOST-9]\n---\n# 计划\n');
  const ds = checkPlan(plan, config, { configPath });
  assert.ok(ds.some((d) => d.ruleId === 'RULE-PLAN-001' && d.severity === 'blocking'));
});

test('architecture 型文档：标题锚收集、正文/围栏/无空格不收集', () => {
  const { root, configPath, config } = tempSuite();
  const arch = join(root, 'docs/architecture.md');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(arch, '# 架构\n\n## §8 ADR 登记册\n\n### 内部决策-029: 登录契约冻结\n\n正文提及 内部决策-999 仅是行文引用。\n#### 内部决策-030: 无冒号标题\n##### 内部决策-031: 五级深度\n\n##内部决策-017: 无空格形态\n\n```\n### 内部决策-998: 围栏示例\n```\n');
  config.documents.push({ path: 'docs/architecture.md', documentType: 'architecture' });
  const plan = join(root, 'p.md');
  const write = (refs) => writeFileSync(plan, `---\nspecRefs: [${refs}]\n---\n# 计划\n`);
  write('内部决策-029, 内部决策-030, 内部决策-031');
  assert.deepEqual(checkPlan(plan, config, { configPath }).filter((d) => d.severity === 'blocking'), []);
  write('内部决策-999');
  assert.equal(checkPlan(plan, config, { configPath }).filter((d) => d.severity === 'blocking').length, 1);
  write('内部决策-017, 内部决策-998');
  assert.equal(checkPlan(plan, config, { configPath }).filter((d) => d.severity === 'blocking').length, 2);
  write('architecture, FR-NOPE-9');
  assert.equal(checkPlan(plan, config, { configPath }).filter((d) => d.severity === 'blocking').length, 2);
});

test('STEP_HEADING_RE：步骤/step/任务/task/数字与大小写；BOM 不算空白', () => {
  for (const good of ['## 步骤 1', '### step 2', '# 任务', '## Task', '## 1 计划']) assert.ok(STEP_HEADING_RE.test(good), good);
  for (const bad of ['## 普通标题', '\ufeff## 步骤 1']) assert.equal(STEP_HEADING_RE.test(bad), false, bad);
});

test('plan 节无 .sdd 体系时由 CLI 跳过（checkPlan 自身仅做文件校验）', () => {
  const { root } = tempSuite();
  const plan = join(root, 'p.md');
  writeFileSync(plan, '---\nspecRefs: [内部需求-6]\n---\n# 计划\n\n## 步骤 1\n\n验收：检查\n');
  const ds = checkPlan(plan, {}, { configPath: null });
  assert.deepEqual(ds, [], '无已知编号来源时不误报（调用方负责 .sdd 前置）');
});

test('围栏内步骤标题不计（内部未决-152①）', () => {
  const { root } = tempSuite();
  const plan = join(root, 'p.md');
  writeFileSync(plan, '---\nspecRefs: [内部需求-6]\n---\n# 计划\n\n```text\n## 步骤 9（示例）\n```\n\n## 步骤 1\n\n验收：检查\n');
  const ds = checkPlan(plan, {}, { configPath: null });
  assert.deepEqual(ds.filter((d) => d.fixHint.includes('计划步骤无验收方式')), []);
  // 对照：围栏外真步骤无验收仍报
  writeFileSync(plan, '---\nspecRefs: [内部需求-6]\n---\n# 计划\n\n## 步骤 1\n\n无验收内容。\n');
  assert.equal(checkPlan(plan, {}, { configPath: null }).filter((d) => d.fixHint.includes('计划步骤无验收方式')).length, 1);
});

test('内部未决-152②：围栏与行内代码中的 ID 不入 knownIds（悬空引用不因围栏样本漏报）', () => {
  const { root, configPath, config } = tempSuite();
  // 正文裸写 FR-ZZ-1；FR-XX-99 仅在围栏内；内部验收-99 仅在行内代码
  writeFileSync(join(root, '内部规格'), '# 需求基线\n\n- FR-ZZ-1：正文条目\n\n```md\n- FR-XX-99：围栏内样本\n```\n\n行内样本 `内部验收-99` 说明。\n');
  const known = knownIds(config, null, configPath);
  assert.ok(known.has('FR-ZZ-1'), '正文裸 ID 入 knownIds');
  assert.equal(known.has('FR-XX-99'), false, '围栏内 ID 不入 knownIds（内部任务-347 内部未决-152②）');
  assert.equal(known.has('内部验收-99'), false, '行内代码 ID 不入 knownIds（内部任务-347 内部未决-152②）');
});
