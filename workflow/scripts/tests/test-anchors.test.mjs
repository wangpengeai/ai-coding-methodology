// 文件：test-anchors.test.mjs
// 描述：设计—测试锚定（内部决策-060/内部任务-225）测试矩阵——共享库（§6 解析/双载排除/锁定方式/
//       标题索引/ID 展开/registry 校验/覆盖计算）＋仓检查器 CLI（exit 2>1>0）＋计划检查器
//       CLI（三类行形态/说明行/n-a/整体豁免/planChangeSurface）＋覆盖报告五节＋
//       release-suite 接线防回退断言。fixture 自含（mkdtemp 临时根），零真机触达；
//       末条「真仓试点锚定下限」为只读真仓断言（读 ROOT 的 内部规格测试索引），
//       不写任何文件。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../../..');
const LIB = join(HERE, '..', 'lib', 'test-anchors-lib.mjs');
const CHECK_REPO = join(HERE, '..', 'check-test-anchors.mjs');
const CHECK_PLAN = join(HERE, '..', 'check-plan-test-anchors.mjs');
// 公开包守卫（内部任务-365）：仓级 scripts/、docs/plans 与 specs/ 未随公开包发布；源仓资产在位时照常执行。
const HAS_RELEASE_SUITE = existsSync(join(ROOT, 'scripts', 'release-suite.mjs'));
const HAS_DEV225_PLAN = existsSync(join(ROOT, 'docs', 'plans', '2026-10-23-DEV-225-test-anchoring-plan.md'));
const HAS_ANCHOR_REGISTRY = existsSync(join(ROOT, 'specs', 'test-anchors.json'));

/** 创建 fixture 根（含空 .git 目录供 gitAncestor 解析根）。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'anchor-fx-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

function writeRel(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

const MODULE_DEMO = `---
documentType: module-volume
---

# 模块 MX（fixture）

## 0. 公共部分

### 0.2 前提假设

| 编号 | 假设 | 依赖的条款 | 失效时的修订义务 |
|---|---|---|---|
| A-MX-1 | 前提假设行不得进入锚定解析（与 §6 同号双载） | — | — |

## 第一部分：规定性规格

### 1. 需求条目

| 编号 | 需求（可验证表述） | 追溯 |
|---|---|---|
| R-MX-1 | 规则一 | [FR-ed-1] |
| R-MX-2 | 规则二 | [FR-ed-1/2] |

### 6. 验收与追溯

| 编号 | 可验证行为 | 追溯 | 锁定方式 |
|---|---|---|---|
| A-MX-1 | 行为一 | [R-MX-1] | 单元测试｜tests/demo.test.mjs#行为一 |
| A-MX-2 | 行为二 | [R-MX-2] | 自动化测试（旧形态） |
`;

const REQUIREMENTS_DEMO = `---
documentType: requirement-baseline
---

# 需求

| 编号 | 需求 | 优先级 | 状态 | 来源 | 证据 |
|---|---|---|---|---|---|
| FR-ed-1 | 需求一 | P1 | accepted | ADR-1 | E-1 |
| FR-ed-2 | 需求二 | P1 | accepted | ADR-1 | E-1 |
`;

const MATRIX_ANCHOR = `---

# 追溯矩阵

## 4. V 模型层与测试锚定（ADR-060）

| V 模型层 | 设计面 | 测试锚类别 | 覆盖口径 |
|---|---|---|---|
| 架构设计↔系统测试 | system-design | 系统测试 | 报告 |
| 概要设计↔集成测试 | IF | 集成测试 | 报告 |
| 详细设计↔单元测试 | R | 单元测试 | 报告 |
| 需求↔验收测试 | FR | 验收测试 | 报告 |
`;

const TEST_FILE_DEMO = "import { test } from 'node:test';\ntest('行为一：回环', () => {});\ntest('行为二：唯一定位', () => {});\n";

function defaultRegistry(over = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-10-23',
    expectedARows: 2,
    baseline: { a: ['A-MX-2'], fr: ['FR-ed-2'] },
    waivers: [],
    visibility: { default: 'internal', overrides: {} },
    ...over,
  };
}

/**
 * 建立默认 fixture 根（2 条 A 行、1 条锚定、1 条基线；内部需求-1 经 R→A 锚定）。
 * @returns {{root:string, registryPath:string, demo:string, req:string, matrix:string, testFile:string}}
 */
function defaultRoot(over = {}) {
  const root = makeRoot();
  const reg = over.registry ?? defaultRegistry();
  writeRel(root, 'specs/modules/MX-demo.md', over.module ?? MODULE_DEMO);
  writeRel(root, 'specs/requirements.md', over.requirements ?? REQUIREMENTS_DEMO);
  writeRel(root, 'specs/traceability-matrix.md', over.matrix ?? MATRIX_ANCHOR);
  writeRel(root, 'specs/test-anchors.json', JSON.stringify(reg, null, 2));
  writeRel(root, 'tests/demo.test.mjs', over.testFile ?? TEST_FILE_DEMO);
  if (over.extraFiles) for (const [rel, content] of Object.entries(over.extraFiles)) writeRel(root, rel, content);
  return {
    root,
    registryPath: join(root, 'specs/test-anchors.json'),
    demo: join(root, 'specs/modules/MX-demo.md'),
    req: join(root, 'specs/requirements.md'),
    matrix: join(root, 'specs/traceability-matrix.md'),
    testFile: join(root, 'tests/demo.test.mjs'),
  };
}

function runCli(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: cwd ?? ROOT });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function lib() {
  return import(pathToFileURL(LIB).href);
}

function rules(report) {
  return report.violations.map((v) => v.rule);
}

// ── 内部验收-21 锚：共享库：锚定模型与 registry 语义矩阵 ────────────────────────

test('共享库：锚定模型与 registry 语义矩阵', async () => {
  const { parseLockMethod, parseSpecs, buildTestIndex, validateRegistry, parseTestTitles } = await lib();

  // ── §6 解析域与 §0.2 双载排除 ──
  {
    const f = defaultRoot();
    try {
      const specs = parseSpecs(f.root);
      assert.equal(specs.aRows.length, 2, '只解析 §6 验收表（§0.2 前提假设 A-MX-1 不计入）');
      assert.ok(specs.aRows.every((r) => r.file === 'specs/modules/MX-demo.md'));
      assert.deepEqual(specs.aRows.map((r) => r.id), ['A-MX-1', 'A-MX-2']);
      assert.equal(specs.frIds.size, 2, 'requirements FR 行解析');
      const index = buildTestIndex(f.root);
      assert.ok(index.size >= 1, '测试文件索引非空');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── 锁定方式解析：五类可执行＋三类非可执行＋legacy/missing ──
  {
    const ex = parseLockMethod('单元测试｜tests/demo.test.mjs#行为一');
    assert.equal(ex.kind, 'executable');
    assert.equal(ex.anchors.length, 1);
    assert.equal(ex.anchors[0].category, '单元测试');
    assert.equal(ex.anchors[0].path, 'tests/demo.test.mjs');
    assert.equal(ex.anchors[0].fragment, '行为一');
    assert.equal(parseLockMethod('集成测试｜a.test.mjs#x；验收测试｜b.test.mjs#y').anchors.length, 2, '多锚分号分隔');
    assert.equal(parseLockMethod('系统测试｜a.test.mjs#x').anchors[0].category, '系统测试', '系统测试类别');
    assert.equal(parseLockMethod('命令冒烟｜workflow/hooks/post-tool.mjs').kind, 'executable', '命令冒烟为第五类可执行锚');
    assert.equal(parseLockMethod('人工走查').kind, 'nonExecutable');
    assert.equal(parseLockMethod('审查清单｜人工抽查').kind, 'nonExecutable');
    assert.equal(parseLockMethod('构建期检查').kind, 'nonExecutable', '构建期检查类别');
    assert.equal(parseLockMethod('自动化测试（旧形态）').kind, 'legacy');
    assert.equal(parseLockMethod('').kind, 'missing');
    const bad = parseLockMethod('单元测试｜');
    assert.equal(bad.kind, 'executable');
    assert.ok(bad.errors.length > 0, '空路径即语法错误');
  }

  // ── 用例标题索引：字面量解析＋非字面量 fail-loud＋模板/注释剥离＋test(/it( 双别名（内部决策-060 修正案 5）──
  {
    const ok = parseTestTitles("test('甲：一', () => {});\ntest('乙：二', () => {});");
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.titles, ['甲：一', '乙：二']);
    const bad = parseTestTitles("test('甲', () => {});\ntest(`模板${x}`, () => {});");
    assert.equal(bad.ok, false, '非字面量标题须 fail-loud');
    const embedded = parseTestTitles("const SAMPLE = `\ntest('模板内假标题', () => {});\n`;\ntest('真标题', () => {});\n// test('注释内假标题', () => {});\n/*\ntest('块注释内假标题', () => {});\n*/\n");
    assert.equal(embedded.ok, true, '模板/注释内 test( 不计入声明数');
    assert.deepEqual(embedded.titles, ['真标题'], '只解析顶层真实用例标题');
    // it( 双别名（内部未决-194）：declared/titles 同口径；混合文件计数相等；非字面量与模板内 it( 同款 fail-loud/剥离
    const alias = parseTestTitles("it('it 标题甲', () => {});\ntest('test 标题乙', () => {});\nit('it 标题丙', () => {});");
    assert.equal(alias.ok, true, '双别名混合文件须可解析');
    assert.equal(alias.declared, 3, 'declared 同时计 test(/it( 行首锚');
    assert.deepEqual(alias.titles, ['it 标题甲', 'test 标题乙', 'it 标题丙']);
    const aliasBad = parseTestTitles("it(`模板${x}`, () => {});");
    assert.equal(aliasBad.ok, false, '非字面量 it( 标题须 fail-loud');
    const aliasEmbedded = parseTestTitles("const S = `\nit('模板内假 it', () => {});\n`;\n// it('注释内假 it', () => {});\nit('真 it', () => {});\n");
    assert.equal(aliasEmbedded.ok, true, '模板/注释内 it( 不计入声明数');
    assert.deepEqual(aliasEmbedded.titles, ['真 it'], '只解析顶层真实 it 标题');
    const doubleQuote = parseTestTitles('it("双引号标题", () => {});');
    assert.equal(doubleQuote.ok, false, '双引号非单引号字面量 → 整文件 fail-loud（仍限单引号）');
    const each = parseTestTitles("it.each([[1,2]])('参数化', () => {});");
    assert.equal(each.ok, false, 'it.each( 形态不属行首 it( 字面量 → fail-loud');
  }

  // ── 基础 fixture 全绿 ──
  {
    const f = defaultRoot();
    try {
      const { registry, specs, index } = { registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), index: buildTestIndex(f.root) };
      const report = validateRegistry({ projectRoot: f.root, registry, specs, testIndex: index });
      assert.deepEqual(report.violations, [], `基础 fixture 应全绿：${JSON.stringify(report.violations)}`);
      assert.equal(report.summary.aRows, 2);
      assert.equal(report.summary.frAnchored, 1, 'FR-ed-1 经 R→A 链锚定');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── 可执行锚错误族：路径缺失/非 .test.mjs/片段 0 匹配/片段多匹配/脚本无 selftest ──
  const execCases = [
    ['anchor-path-missing', '单元测试｜tests/nope.test.mjs#行为一'],
    ['anchor-not-test-file', '单元测试｜tests/demo.txt#行为一'],
    ['anchor-title-missing', '单元测试｜tests/demo.test.mjs#不存在的片段'],
    ['anchor-title-ambiguous', '单元测试｜tests/demo.test.mjs#行为'],
    ['anchor-script-missing', '命令冒烟｜workflow/hooks/nope.mjs'],
    ['anchor-script-no-selftest', '命令冒烟｜tests/demo.test.mjs'],
  ];
  for (const [rule, lock] of execCases) {
    const f = defaultRoot({ module: MODULE_DEMO.replace('单元测试｜tests/demo.test.mjs#行为一', lock), extraFiles: { 'workflow/hooks/post-tool.mjs': "if (arg === '--selftest') {}" } });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes(rule), `期望规则 ${rule}，实得 ${JSON.stringify(rules(report))}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  {
    const f = defaultRoot({ module: MODULE_DEMO.replace('单元测试｜tests/demo.test.mjs#行为一', '命令冒烟｜workflow/hooks/post-tool.mjs'), extraFiles: { 'workflow/hooks/post-tool.mjs': "if (arg === '--selftest') {}" } });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.deepEqual(report.violations, [], `命令冒烟合法锚应通过：${JSON.stringify(report.violations)}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── 基线/豁免族 ──
  const baseCases = [
    ['a-row-unanchored', null, '自动化测试（旧形态）', { baseline: { a: [], fr: ['FR-ed-2'] } }],
    ['baseline-stale', '单元测试｜tests/demo.test.mjs#行为一', null, { baseline: { a: ['A-MX-2'], fr: ['FR-ed-2'] } }],
    ['baseline-unknown-id', null, null, { baseline: { a: ['A-MX-2', 'A-MX-99'], fr: ['FR-ed-2'] } }],
    ['fr-unanchored', null, null, { baseline: { a: ['A-MX-2'], fr: [] } }],
    ['fr-baseline-unknown', null, null, { baseline: { a: ['A-MX-2'], fr: ['FR-ed-2', 'FR-ed-99'] } }],
  ];
  for (const [rule, anchorLock, legacyLock, over] of baseCases) {
    let module = MODULE_DEMO;
    if (anchorLock) module = module.replace('自动化测试（旧形态）', anchorLock);
    if (legacyLock) module = module.replace('单元测试｜tests/demo.test.mjs#行为一', legacyLock);
    const f = defaultRoot({ module, registry: defaultRegistry({ ...(over ?? {}) }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes(rule), `期望规则 ${rule}，实得 ${JSON.stringify(rules(report))}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── waiver 合法/非法 ──
  {
    const module = MODULE_DEMO.replace('自动化测试（旧形态）', '人工走查');
    const registry = defaultRegistry({ baseline: { a: [], fr: ['FR-ed-2'] }, waivers: [{ id: 'A-MX-2', category: '人工走查', reason: '仅人工演练可覆盖', ref: 'ADR-060' }] });
    const f = defaultRoot({ module, registry });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.deepEqual(report.violations, [], `合法 waiver 应通过：${JSON.stringify(report.violations)}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const waiverCases = [
    ['waiver-invalid', { id: 'A-MX-2', category: '人工走查', reason: '短', ref: 'ADR-060' }],
    ['waiver-invalid', { id: 'A-MX-2', category: '单元测试', reason: '仅人工演练可覆盖', ref: 'ADR-060' }],
    ['waiver-invalid', { id: 'A-MX-99', category: '人工走查', reason: '仅人工演练可覆盖', ref: 'ADR-060' }],
    ['waiver-invalid', { id: 'A-MX-2', category: '人工走查', reason: '仅人工演练可覆盖', ref: '' }],
  ];
  for (const [rule, waiver] of waiverCases) {
    const module = MODULE_DEMO.replace('自动化测试（旧形态）', '人工走查');
    const f = defaultRoot({ module, registry: defaultRegistry({ baseline: { a: [], fr: ['FR-ed-2'] }, waivers: [waiver] }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes(rule), `期望规则 ${rule}，实得 ${JSON.stringify(rules(report))}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── 存活锚：0 A 行 / 0 测试文件 / A 行总数不等 ──
  {
    const emptyModule = `---
documentType: module-volume
---

### 6. 验收与追溯

| 编号 | 可验证行为 | 追溯 | 锁定方式 |
|---|---|---|---|
`;
    const f = defaultRoot({ module: emptyModule, registry: defaultRegistry({ expectedARows: 0, baseline: { a: [], fr: [] } }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('scope-empty'), 'A 行扫描数 0 须红（存活锚）');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  {
    const f = defaultRoot({ registry: defaultRegistry({ expectedARows: 3 }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('a-row-count-mismatch'), 'A 行数不等于 expectedARows 须红');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── registry schema 形态负例（schemaVersion/visibility/expectedARows）──
  for (const [name, badReg, expectRule] of [
    ['schemaVersion 非法', defaultRegistry({ schemaVersion: 2 }), 'registry-schema'],
    ['visibility.default 非法', defaultRegistry({ visibility: { default: 'public', overrides: {} } }), 'registry-schema'],
    ['expectedARows 非法', defaultRegistry({ expectedARows: 0 }), 'registry-schema'],
  ]) {
    const f = defaultRoot({ registry: badReg });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes(expectRule), `${name} 须红（${expectRule}）`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── legacy 行登记 waiver → 非法（内部决策-060 修正案 4 决策 13；基线内外均违例）──
  for (const [name, registry] of [
    ['legacy 非基线 + waiver', defaultRegistry({ baseline: { a: [], fr: ['FR-ed-2'] }, waivers: [{ id: 'A-MX-2', category: '人工走查', reason: '仅人工演练可覆盖断言', ref: 'ADR-060' }] })],
    ['legacy 在基线 + waiver', defaultRegistry({ waivers: [{ id: 'A-MX-2', category: '人工走查', reason: '仅人工演练可覆盖断言', ref: 'ADR-060' }] })],
  ]) {
    const f = defaultRoot({ registry });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('waiver-invalid'), `${name} 须精确 waiver-invalid`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── §6 三列表头兼容（内部决策-060 修正案 4；内部模块-16/内部模块-17 形态）──
  {
    const threeCol = `---
documentType: module-volume
---

### 1. 需求条目

| 编号 | 需求（可验证表述） | 追溯 |
|---|---|---|
| R-MX-1 | 规则一 | [FR-ed-1] |
| R-MX-2 | 规则二 | [FR-ed-1] |

### 6. 验收与追溯

| 验收 | 行为 | 锁定方式 |
|---|---|---|
| A-MX-1 | 行为一 —— [R-MX-1] | 单元测试｜tests/demo.test.mjs#行为一 |
| A-MX-2 | 行为二 —— [R-MX-2] | 自动化测试（旧形态） |
`;
    const f = defaultRoot({ module: threeCol });
    try {
      const specs = parseSpecs(f.root);
      assert.equal(specs.aRows.length, 2, '三列表头须解析 2 条 A 行');
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs, testIndex: buildTestIndex(f.root) });
      assert.deepEqual(report.violations, [], `三列表头 fixture 应全绿：${JSON.stringify(report.violations)}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // ── 不受支持的 §6 表头形态 → spec-table-header fail-loud ──
  {
    const fiveCol = `---
documentType: module-volume
---

### 6. 验收与追溯

| 编号 | 可验证行为 | 追溯 | 锁定方式 | 备注 |
|---|---|---|---|---|
| A-MX-1 | 行为一 | [R-MX-1] | 自动化测试（旧形态） | x |
`;
    const f = defaultRoot({ module: fiveCol, registry: defaultRegistry({ expectedARows: 1 }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('spec-table-header'), `五列表头须 spec-table-header，实际 ${JSON.stringify(rules(report))}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── 可执行锚行登记 waiver → 非法 ──
  {
    const f = defaultRoot({ registry: defaultRegistry({ waivers: [{ id: 'A-MX-1', category: '人工走查', reason: '仅人工演练可覆盖断言', ref: 'ADR-060' }] }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('waiver-invalid'), '可执行锚行 + waiver 须红');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }

  // ── §6 表行缺列 → spec-row-malformed fail-loud（不得静默丢弃绕过锚校验）──
  {
    const malformed = `---
documentType: module-volume
---

### 6. 验收与追溯

| 编号 | 可验证行为 | 追溯 | 锁定方式 |
|---|---|---|---|
| A-MX-1 | 行为一 | [R-MX-1] | 自动化测试（旧形态） |
| A-MX-2 | 缺列行 | [R-MX-2] |
`;
    const f = defaultRoot({ module: malformed, registry: defaultRegistry({ expectedARows: 2 }) });
    try {
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('spec-row-malformed'), `缺列 A 行须 spec-row-malformed，实际 ${JSON.stringify(rules(report))}`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // ── 测试用例索引为 0 → scope-empty 存活锚 ──
  {
    const f = defaultRoot();
    try {
      rmSync(join(f.root, 'tests'), { recursive: true, force: true });
      const report = validateRegistry({ projectRoot: f.root, registry: JSON.parse(readFileSync(f.registryPath, 'utf8')), specs: parseSpecs(f.root), testIndex: buildTestIndex(f.root) });
      assert.ok(rules(report).includes('scope-empty'), '测试索引 0 须红（存活锚）');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

// ── 内部验收-23 锚：覆盖报告与 release-suite 接线矩阵 ────────────────────────────

test('覆盖报告与 release-suite 接线矩阵', async (t) => {
  const { validateRegistry, parseSpecs, buildTestIndex, computeCoverage, formatMarkdownReport, expandIdRefs } = await lib();
  const f = defaultRoot();
  try {
    const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
    const specs = parseSpecs(f.root);
    const index = buildTestIndex(f.root);
    const report = validateRegistry({ projectRoot: f.root, registry, specs, testIndex: index });
    // 五节齐备
    for (const key of ['modules', 'layers', 'domains', 'interfaces', 'summary']) {
      assert.ok(Object.prototype.hasOwnProperty.call(report.coverage, key), `coverage 缺节：${key}`);
    }
    assert.ok(report.coverage.modules['specs/modules/MX-demo.md'], '模块级覆盖存在');
    for (const layer of ['unit', 'integration', 'system', 'acceptance', 'command', 'nonExecutable']) {
      assert.ok(Object.prototype.hasOwnProperty.call(report.coverage.layers, layer), `layers 缺层：${layer}`);
    }
    assert.equal(report.coverage.layers.unit.executable, 1, '单元测试层可执行锚计数');
    assert.ok(report.coverage.domains['ed'], 'FR 域覆盖存在');
    assert.equal(report.coverage.summary.frAnchored, 1);
    // 命令冒烟锚计入命令级层
    const cf = defaultRoot({
      module: MODULE_DEMO.replace('单元测试｜tests/demo.test.mjs#行为一', '命令冒烟｜workflow/hooks/post-tool.mjs'),
      extraFiles: { 'workflow/hooks/post-tool.mjs': "if (arg === '--selftest') {}" },
    });
    try {
      const creport = validateRegistry({ projectRoot: cf.root, registry: JSON.parse(readFileSync(cf.registryPath, 'utf8')), specs: parseSpecs(cf.root), testIndex: buildTestIndex(cf.root) });
      assert.deepEqual(creport.violations, [], `命令冒烟 fixture 应通过：${JSON.stringify(creport.violations)}`);
      assert.equal(creport.coverage.layers.command.executable, 1, '命令级层可执行锚计数');
      const cmdMd = formatMarkdownReport(creport);
      assert.ok(/\|\s*command\s*\|\s*1\s*\|/.test(cmdMd), 'md 命令级行须含数值 1');
    } finally { rmSync(cf.root, { recursive: true, force: true }); }
    // md 渲染
    const md = formatMarkdownReport(report);
    assert.ok(md.includes('## 覆盖报告'), 'md 含覆盖报告标题');
    assert.ok(md.includes('命令级') || md.includes('command'), 'md 呈现命令级层');
    // ID 引用展开（斜杠与区间）
    const refs = expandIdRefs('[R-M8-1/2][R-M20-1..3][FR-wf-2/10]');
    assert.ok(refs.R.has('R-M8-1') && refs.R.has('R-M8-2') && refs.R.has('R-M20-1') && refs.R.has('R-M20-3'));
    assert.ok(refs.FR.has('FR-wf-2') && refs.FR.has('FR-wf-10'));
    // computeCoverage 单独可调（覆盖算法五节）
    const cov = computeCoverage({ specs, testIndex: index, methodStates: report.methodStates, anchoredFr: new Set() });
    assert.ok(cov.summary && typeof cov.summary.aRows === 'number');
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  // release-suite 接线防回退断言（源码含新步骤）；公开包无仓级 scripts/ 时声明 SKIP
  await t.test('release-suite 接线', { skip: HAS_RELEASE_SUITE ? false : '公开包不含仓级 scripts/（源仓照跑）' }, () => {
    const suite = readFileSync(join(ROOT, 'scripts/release-suite.mjs'), 'utf8');
    assert.ok(suite.includes('check-test-anchors.mjs'), 'release-suite 须含 check-test-anchors.mjs 步');
    const selftest = suite.slice(suite.indexOf('function selftest'));
    assert.ok(selftest.includes('check-test-anchors.mjs'), 'release-suite selftest 须含防回退锚');
  });
});

// ── 内部验收-19 锚：计划「测试锚定」门禁矩阵 ────────────────────────────────────

function planText({ sectionLines = [], implementation = true, hasSection = true, position = 'before' } = {}) {
  const fileRow = implementation ? '| workflow/scripts/lib/x.mjs | 新建 | 代码 |' : '| docs/plans/x.md | 新建 | 文档 |';
  const section = hasSection
    ? ['## 测试锚定', '', ...sectionLines, '']
    : [];
  const step = ['## 执行步骤', '', '### 步骤 1：x', '', '验收：exit 0', ''];
  return ['---', 'specRefs: [FR-ed-1]', '---', '', '# 计划：fixture', '', '## 目标', '', 'demo', '', '## 文件清单（文件级）', '', '| 文件 | 动作 | 职责 |', '|---|---|---|', fileRow, '', ...(position === 'before' ? section : step), ...(position === 'before' ? step : section)].join('\n');
}

function planRoot(textContent) {
  const root = makeRoot();
  writeRel(root, 'specs/modules/MX-demo.md', MODULE_DEMO);
  writeRel(root, 'specs/requirements.md', REQUIREMENTS_DEMO);
  writeRel(root, 'specs/traceability-matrix.md', MATRIX_ANCHOR);
  writeRel(root, 'specs/test-anchors.json', JSON.stringify(defaultRegistry(), null, 2));
  writeRel(root, 'tests/demo.test.mjs', TEST_FILE_DEMO);
  writeRel(root, 'docs/plans/fixture-plan.md', textContent);
  return { root, plan: join(root, 'docs/plans/fixture-plan.md') };
}

test('计划「测试锚定」门禁矩阵', async (t) => {
  // 合法：可执行锚＋派生锚＋非可执行类别＋说明行
  {
    const { root, plan } = planRoot(planText({ sectionLines: [
      '- A-MX-1：单元测试｜tests/demo.test.mjs#行为一',
      '- FR-ed-1：派生｜A-MX-1',
      '- A-MX-2：人工走查｜人工演练可覆盖断言',
      '- 说明：本批新增 A-MX-1 锚',
    ] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 0, `合法计划节应 exit 0：${r.stdout}${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // n/a 单行合法
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- 测试锚定：n/a｜本批无新增或变更规格条目'] }));
    try {
      assert.equal(runCli(CHECK_PLAN, [plan]).status, 0, 'n/a 合法');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 缺节
  {
    const { root, plan } = planRoot(planText({ hasSection: false }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'missing-section'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 节位置错（位于步骤后）
  {
    const { root, plan } = planRoot(planText({ position: 'after', sectionLines: ['- A-MX-1：单元测试｜tests/demo.test.mjs#行为一'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'section-position'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 内部任务-348/内部未决-180③ STEP_HEADING 新门判别（负向）：日期起首标题（数字后无 [.、:：]）不判
  // 步骤——旧门裸 \d 把 `## 2026-…` 当步骤锚点会触发 section-position 误报（回退旧门即红）
  {
    const withDate = planText({ sectionLines: ['- A-MX-1：单元测试｜tests/demo.test.mjs#行为一'] })
      .replace('## 测试锚定', '## 2026-11-07 日期起首标题不判步骤\n\n叙事行\n\n## 测试锚定');
    const { root, plan } = planRoot(withDate);
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 0, `日期起首标题不判步骤、节位合法应 exit 0：${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // STEP_HEADING 新门判别（正向）：`\d+[.、:：]` 编号标题判步骤（节位于其后即 section-position）
  {
    const withNumbered = planText({ sectionLines: ['- A-MX-1：单元测试｜tests/demo.test.mjs#行为一'] })
      .replace('## 测试锚定', '## 1. 编号步骤标题\n\n验收：demo。\n\n## 测试锚定');
    const { root, plan } = planRoot(withNumbered);
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1, '编号步骤标题（1.）须被识别为步骤锚点');
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'section-position'), '须报 section-position');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 重复节
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- A-MX-1：单元测试｜tests/demo.test.mjs#行为一'] }) + '\n## 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n');
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'duplicate-section'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // n/a 与整体豁免并存 → 违例
  {
    const { root, plan } = planRoot(planText({ implementation: false, sectionLines: [
      '- 测试锚定：n/a｜本批无新增或变更规格条目',
      '- 测试锚定：整体豁免｜纯文档批次无规格面',
    ] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-line'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 叙事行（非三类形态）→ invalid-anchor
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- A-MX-1：经 A-MX-2 链可达（叙事行）'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-anchor'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 派生引用悬空
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- FR-ed-1：派生｜A-MX-99'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'dangling-ref'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 命令冒烟路径空 → invalid-anchor
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- A-MX-1：命令冒烟｜'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-anchor'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 实现类整体豁免 → 违例
  {
    const { root, plan } = planRoot(planText({ implementation: true, sectionLines: ['- 测试锚定：整体豁免｜本批仅改代码无规格面'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'waiver-not-allowed'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 纯文档 + 整体豁免 → 通过
  {
    const { root, plan } = planRoot(planText({ implementation: false, sectionLines: ['- 测试锚定：整体豁免｜纯文档批次无规格面变更'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 0, `纯文档整体豁免应通过：${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 整体豁免 + ID 行并存 → 歧义违例（内部规则-19「与其他行并存即歧义」）
  {
    const { root, plan } = planRoot(planText({ implementation: false, sectionLines: [
      '- A-MX-1：单元测试｜tests/demo.test.mjs#行为一',
      '- 测试锚定：整体豁免｜纯文档批次无规格面变更',
    ] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-line'), '整体豁免 + ID 行须歧义红');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 行内 ID 悬空 → dangling-id
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- A-MX-99：单元测试｜tests/demo.test.mjs#行为一'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'dangling-id'), 'ID 悬空须 dangling-id');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 非法类别 / 空片段 → invalid-anchor
  for (const line of ['- A-MX-1：未知类别｜x', '- A-MX-1：单元测试｜tests/demo.test.mjs#']) {
    const { root, plan } = planRoot(planText({ sectionLines: [line] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1, `应红：${line}`);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-anchor'), `须 invalid-anchor：${line}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 计划不存在 → exit 2
  {
    const r = runCli(CHECK_PLAN, ['docs/plans/no-such-plan-' + Date.now() + '.md'], ROOT);
    assert.equal(r.status, 2, '不可读计划为工具错误退 2');
  }
  // 围栏内伪节 / HTML 注释伪节 / H3 同名节 → 均不算 `## 测试锚定` 节
  for (const [name, body] of [
    ['围栏伪节', '```markdown\n## 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n```\n'],
    ['注释伪节', '<!--\n## 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n-->\n'],
    ['H3 同名节', '### 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n'],
    // S2 门复审注记 2：多行注释内的围栏标记行不得误开 fence——否则 `-->` 被围栏吞掉，
    // 注释后的正文围栏错位闭合、围栏内伪节漏判（修前该形态 exit 0 漏报，修后 missing-section）
    ['注释内围栏＋闭合后正文围栏伪节', '<!--\n```\n-->\n```markdown\n## 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n```\n'],
    ['注释内围栏伪节', '<!--\n```\n## 测试锚定\n\n- A-MX-1：单元测试｜tests/demo.test.mjs#行为一\n-->\n'],
  ]) {
    const text = planText({ hasSection: false }) + '\n' + body;
    const { root, plan } = planRoot(text);
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1, `${name} 应判 missing-section`);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'missing-section'), `${name} 须 missing-section`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 派生锚引用非 A 行 → invalid-anchor（派生只指向验收条目链）
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- FR-ed-1：派生｜R-MX-1'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-anchor'), '派生锚非 A-ID 须 invalid-anchor');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 内部任务-348/内部未决-180①：派生列表混入垃圾 token → 透传后仍 invalid-anchor（lib expandIdRefs
  // 用 matchAll 静默丢弃非匹配 token，直接消费会丢垃圾 token 检出＝门禁变宽；本地展开保留透传语义）
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- FR-ed-1：派生｜A-MX-1、garbage'] }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1, '垃圾 token 不得被静默丢弃');
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-anchor' && v.message.includes('garbage')), '垃圾 token 须点名 invalid-anchor');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 内部任务-348/内部未决-180④：IF 族长段 ID（内部接口-1，段长 7 超 {1,6}）索引不漏——specIdIndex
  // 行首 token 经 PLAN_ID_RE 单源判定（S2 门评审发现 1：平行段长正则会漏收 → dangling-id 假红）
  {
    const { root, plan } = planRoot(planText({ sectionLines: ['- IF-ADAPTER-1：单元测试｜tests/demo.test.mjs#行为一'] }));
    try {
      writeRel(root, 'specs/interface-registry.md', '# 接口登记\n\n| ID | 名称 |\n|---|---|\n| IF-ADAPTER-1 | 外部控制面适配信封 |\n');
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 0, `IF-ADAPTER-1 已在 interface-registry 登记须可解析（漏索引即 dangling-id 假红）：${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // n/a 行重复 / 整体豁免行重复 → invalid-line
  for (const [name, lines] of [
    ['n/a 行重复', ['- 测试锚定：n/a｜本批无新增或变更规格条目', '- 测试锚定：n/a｜另一条重复理由']],
    ['整体豁免行重复', ['- 测试锚定：整体豁免｜纯文档批次无规格面', '- 测试锚定：整体豁免｜重复豁免理由']],
  ]) {
    const { root, plan } = planRoot(planText({ implementation: false, sectionLines: lines }));
    try {
      const r = runCli(CHECK_PLAN, [plan]);
      assert.equal(r.status, 1, `${name} 应 exit 1`);
      assert.ok(JSON.parse(r.stdout).plans[0].violations.some((v) => v.rule === 'invalid-line'), `${name} 须 invalid-line`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // 无参 → exit 2
  {
    const r = runCli(CHECK_PLAN, []);
    assert.equal(r.status, 2, '无参为工具错误退 2');
  }
  // 本仓真实计划自适用（引入批：checker 落盘后必须能跑当前计划）；公开包无该计划时声明 SKIP
  await t.test('本仓真实计划自适用', { skip: HAS_DEV225_PLAN ? false : '公开包不含内部计划（源仓照跑）' }, () => {
    const r = runCli(CHECK_PLAN, ['docs/plans/2026-10-23-DEV-225-test-anchoring-plan.md'], ROOT);
    assert.equal(r.status, 0, `本批计划自身应通过：${r.stdout.slice(0, 400)}${r.stderr}`);
  });
});

// ── 仓检查器 CLI：exit 2>1>0 与 fixture 矩阵 ────────────────────────────────

test('仓检查器 CLI：fixture 绿/红/配置错误与双载排除', async () => {
  {
    const f = defaultRoot();
    try {
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 0, `fixture 应 exit 0：${r.stdout}${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.coverage.summary.aRows, 2);
      const md = runCli(CHECK_REPO, ['--project-root', f.root, '--format', 'md']);
      assert.equal(md.status, 0);
      assert.ok(md.stdout.includes('覆盖报告'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // 未锚 → exit 1
  {
    const f = defaultRoot({ module: MODULE_DEMO.replace('自动化测试（旧形态）', '自动化测试（新但未锚）'), registry: defaultRegistry({ baseline: { a: [], fr: ['FR-ed-2'] } }) });
    try {
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).violations.some((v) => v.rule === 'a-row-unanchored'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // 缺 registry → exit 2（配置错误）
  {
    const f = defaultRoot();
    try {
      rmSync(join(f.root, 'specs/test-anchors.json'));
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 2, '缺 registry 为配置错误 exit 2');
      assert.ok(r.stderr.length > 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // 坏 JSON registry → exit 2
  {
    const f = defaultRoot();
    try {
      writeRel(f.root, 'specs/test-anchors.json', '{ not json');
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 2, '坏 JSON registry 为配置错误 exit 2');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // registry 为非对象 JSON（[]/null）→ exit 2
  for (const raw of ['[]', 'null']) {
    const f = defaultRoot();
    try {
      writeRel(f.root, 'specs/test-anchors.json', raw);
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 2, `非对象 registry（${raw}）为配置错误 exit 2`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // --registry 显式路径等价
  {
    const f = defaultRoot();
    try {
      const r = runCli(CHECK_REPO, ['--project-root', f.root, '--registry', 'specs/test-anchors.json']);
      assert.equal(r.status, 0, '显式 --registry 同路径应等价通过');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  // 缺 内部规格 → exit 2
  {
    const f = defaultRoot();
    try {
      rmSync(join(f.root, 'specs/modules'), { recursive: true, force: true });
      const r = runCli(CHECK_REPO, ['--project-root', f.root]);
      assert.equal(r.status, 2, '缺 specs/modules 为工具错误 exit 2');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

// ── 内部验收-23 真仓下限：试点 内部模块-15 ≥6 / 内部模块-8 ≥11、点名行逐 ID 有效可执行锚、0 missing ──

test('真仓试点锚定下限与点名行（M15 ≥6 / M8 ≥11 / 0 missing）', { skip: HAS_ANCHOR_REGISTRY ? false : '公开包不含内部资产 specs/（源仓照跑）' }, async () => {
  const { parseSpecs, buildTestIndex, loadRegistry, validateRegistry } = await lib();
  const report = validateRegistry({
    projectRoot: ROOT,
    registry: loadRegistry(join(ROOT, 'specs/test-anchors.json')),
    specs: parseSpecs(ROOT),
    testIndex: buildTestIndex(ROOT),
  });
  assert.equal(report.ok, true, `真仓锚定面须全绿：${JSON.stringify(report.violations.slice(0, 5))}`);
  const m15 = report.coverage.modules['specs/modules/M15-run-self-observability.md'];
  const m8 = report.coverage.modules['specs/modules/M8-guard-hooks.md'];
  assert.ok(m15 && m15.executable >= 6, `M15 可执行锚须 ≥6（实际 ${m15?.executable}）`);
  assert.equal(m15.missing, 0, 'M15 须 0 missing');
  assert.ok(m8 && m8.executable >= 11, `M8 可执行锚须 ≥11（实际 ${m8?.executable}）`);
  assert.equal(m8.missing, 0, 'M8 须 0 missing');
  const named = [
    'A-M15-1', 'A-M15-22', 'A-M15-2', 'A-M15-3', 'A-M15-5', 'A-M15-6',
    'A-M8-9', 'A-M8-10', 'A-M8-15', 'A-M8-16', 'A-M8-18', 'A-M8-20',
    'A-M8-21', 'A-M8-23', 'A-M8-24', 'A-M8-25', 'A-M8-26',
  ];
  for (const id of named) {
    assert.equal(report.methodStates[id]?.validExec, true, `${id} 须为有效可执行锚（点名行逐 ID 断言）`);
  }
});
