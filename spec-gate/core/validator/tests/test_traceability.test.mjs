// RULE-SPEC-001/005：编号唯一性与追溯链（含 F-13 列表引用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTraceability } from '../core/traceability.mjs';

const ids = (ds) => ds.map((d) => d.ruleId);

test('R/AC 重复编号 → RULE-SPEC-005', () => {
  const text = '| R-1 | 需求 | [内部需求-1] |\n| R-1 | 重复 | [内部需求-1] |\n| AC-1 | 验收 | [R-1] |\n| AC-1 | 重复 | [R-1] |\n';
  const ds = checkTraceability('x.md', text);
  assert.deepEqual(ids(ds), ['RULE-SPEC-005', 'RULE-SPEC-005']);
  assert.ok(ds.every((d) => d.severity === 'blocking'));
});

test('验收无 R 追溯 / 追溯不存在 / 需求无验收 → RULE-SPEC-001', () => {
  const text = '| R-1 | 需求一 | [内部需求-1] |\n| R-2 | 需求二 | [内部需求-1] |\n| AC-1 | 无追溯 | [内部需求-1] |\n| AC-2 | 悬空 | [R-9] |\n';
  const ds = checkTraceability('x.md', text);
  assert.ok(ids(ds).every((r) => r === 'RULE-SPEC-001'));
  assert.ok(ds.some((d) => d.fixHint.includes('必须追溯至少一条 R')));
  assert.ok(ds.some((d) => d.fixHint.includes('R-9 不存在')));
  assert.ok(ds.some((d) => d.fixHint.includes('需求 R-2 缺少验收条目')));
  assert.ok(ds.some((d) => d.fixHint.includes('需求 R-1 缺少验收条目')));
});

test('F-13：[R-1, R-2] 列表引用被识别（不再误报）', () => {
  const text = '| R-1 | 需求一 | [内部需求-1] |\n| R-2 | 需求二 | [内部需求-1] |\n| AC-1 | 验收 | [R-1, R-2] |\n';
  assert.deepEqual(checkTraceability('x.md', text), []);
});

test('围栏内表格不参与追溯、行号含 offset', () => {
  const text = '```\n| R-1 | 示例 | [内部需求-1] |\n```\n| AC-1 | 验收 | [R-2] |\n';
  const ds = checkTraceability('x.md', text, 4);
  assert.ok(ds.length > 0);
  assert.ok(ds.every((d) => d.line >= 5));
});

test('AC 编号接受 ASCII 常见形态，不接受 CJK', () => {
  const text = '| R-1 | 需求 | [内部需求-1] |\n| AC-验收 | 中文 | [R-1] |\n';
  const ds = checkTraceability('x.md', text);
  assert.ok(ds.some((d) => d.fixHint.includes('需求 R-1 缺少验收条目')));
});

test('module-volume 追溯行与存量分档', () => {
  const text = '## 6. 验收表\n\n| 编号 | 追溯 | 锁定方式 |\n|---|---|---|\n| 内部验收-1 | [内部规则-1] | 单元测试｜x.test.mjs#用例 |\n\n| 内部规则-1 | 需求一 | 说明 |\n| 内部规则-2 | 需求二 | 说明 |\n';
  const ds = checkTraceability('x.md', text, 0, { documentType: 'module-volume' });
  assert.deepEqual(ids(ds), ['RULE-SPEC-001']);
  assert.equal(ds[0].severity, 'warning');
  assert.ok(ds[0].fixHint.includes('存量档[module-volume]'));
  assert.ok(ds[0].fixHint.includes('内部规则-2'));
});

test('A 行反向追溯解析（四列「追溯」列）', () => {
  const text = '## 6. 验收表\n\n| 编号 | 可验证行为 | 追溯 | 锁定方式 |\n|---|---|---|---|\n| 内部验收-1 | 行为 | [内部规则-1] | 单元测试｜x.test.mjs#用例 |\n| 内部验收-2 | 行为 | [内部规则-2] | 单元测试｜x.test.mjs#用例 |\n\n| 内部规则-1 | 需求一 | 说明 |\n| 内部规则-2 | 需求二 | 说明 |\n';
  assert.deepEqual(checkTraceability('x.md', text, 0, { documentType: 'module-volume' }), []);
});

test('非 module-volume 缺 A 仍 blocking（沿用 AC 口径）', () => {
  const text = '| R-1 | 需求一 | [内部需求-1] |\n| AC-1 | 验收 | [R-1] |\n';
  assert.deepEqual(checkTraceability('x.md', text), []);
  const bad = '| R-1 | 需求一 | [内部需求-1] |\n| R-2 | 需求二 | [内部需求-1] |\n';
  const ds = checkTraceability('x.md', bad);
  assert.deepEqual(ds.map((d) => d.severity), ['blocking', 'blocking']);
  assert.ok(ds.every((d) => d.ruleId === 'RULE-SPEC-001'));
});

test('module-volume R 行正则覆盖 R-M/R-ka', () => {
  const text = '## 6. 验收表\n\n| 编号 | 追溯 | 锁定方式 |\n|---|---|---|\n| 内部验收-1 | [内部规则-1] | 单元测试｜x.test.mjs#用例 |\n| A-ka-1 | [R-ka-1] | 单元测试｜x.test.mjs#用例 |\n\n| 内部规则-1 | 需求一 | 说明 |\n| R-ka-1 | 需求二 | 说明 |\n';
  assert.deepEqual(checkTraceability('x.md', text, 0, { documentType: 'module-volume' }), []);
});

test('§0.2 同号 A 行不入锚', () => {
  const text = '## 0.2 前提假设\n\n| 内部验收-1 | 假设 | [内部规则-1] | 说明 |\n\n## 6. 验收表\n\n| 编号 | 可验证行为 | 追溯 | 锁定方式 |\n|---|---|---|---|\n| 内部验收-2 | 行为 | [内部规则-2] | 单元测试｜x.test.mjs#用例 |\n\n| 内部规则-1 | 需求一 | 说明 |\n| 内部规则-2 | 需求二 | 说明 |\n';
  const ds = checkTraceability('x.md', text, 0, { documentType: 'module-volume' });
  assert.deepEqual(ids(ds), ['RULE-SPEC-001']);
  assert.ok(ds[0].fixHint.includes('内部规则-1'));
});

test('三列表头 A 行行为列追溯提取', () => {
  const text = '## 6. 验收表\n\n| 验收 | 行为 | 锁定方式 |\n|---|---|---|\n| A-pc-6 | 行为描述 —— [R-pc-8] | 单元测试｜x.test.mjs#用例 |\n| A-ka-1 | 行为描述 —— [R-ka-9 规格面] | 单元测试｜x.test.mjs#用例 |\n\n| R-pc-8 | 需求 | 说明 |\n| R-ka-9 | 需求 | 说明 |\n';
  assert.deepEqual(checkTraceability('x.md', text, 0, { documentType: 'module-volume' }), []);
});
