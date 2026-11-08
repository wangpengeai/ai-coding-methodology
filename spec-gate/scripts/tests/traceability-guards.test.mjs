// 文件：traceability-guards.test.mjs
// 描述：内部任务-214 批 2（内部验收-15 单元测试）——G-T 全局时序编号守卫矩阵：
//       ①多目标细化（`细化 G-Tn`）与 `[G-Tn]` 引用均被掩蔽，不产生 RULE-SPEC-003；
//       ②同一文档出现两个「裸主编号」→ RULE-SPEC-003 blocking；
//       ③非法细化变体（[G-Tn 细化]/细化 Gx）→ RULE-SPEC-003 blocking。
//       进程内 import validateDocument（不 spawn CLI，保持单元层级，内部决策-064 决策 1）。
// 纪律：仅 node: 内置模块；tmp 夹具，零真机触达。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDocument } from '../../core/validator/validate_specs.mjs';

const DOC = { path: '内部规格', documentType: 'glossary' };

/** 在 tmp suiteRoot 下写 glossary.md 并跑 validateDocument，返回诊断。 */
function diagnose(text) {
  const suiteRoot = mkdtempSync(join(tmpdir(), 'dev214-gt-'));
  try {
    mkdirSync(join(suiteRoot, 'specs'), { recursive: true });
    writeFileSync(join(suiteRoot, DOC.path), text.startsWith('---') ? text : `---\ndocumentType: glossary\n---\n\n${text}`, 'utf8');
    return validateDocument(suiteRoot, DOC, 'draft', []);
  } finally {
    rmSync(suiteRoot, { recursive: true, force: true });
  }
}

const spec003 = (ds) => ds.filter((d) => d.ruleId === 'RULE-SPEC-003');
const textOf = (d) => String(d.fixHint ?? d.message ?? '');

test('多目标细化与 [G-Tn] 引用通过、双裸主编号阻断（内部规则-15）', () => {
  // ①通过：唯一裸主编号 内部时序-1，其余为细化/引用形态（多目标细化不另起主编号）
  const pass = diagnose([
    '## 全局时序',
    '| 内部时序-1 | 需求→计划→执行→验证 |',
    '## 模块细化',
    '模块 A：细化 内部时序-1（仅标注细化）',
    '模块 B：[内部时序-2] 引用与细化 内部时序-3 均不另起主编号',
  ].join('\n'));
  assert.equal(spec003(pass).length, 0, `多目标细化/引用形态不得出现 RULE-SPEC-003：${JSON.stringify(spec003(pass))}`);

  // ②阻断：同一文档出现两个裸主编号 → 逐枚阻断
  const block = diagnose([
    '## 全局时序',
    '| 内部时序-1 | 主时序一 |',
    '| 内部时序-2 | 主时序二（裸编号，应阻断） |',
  ].join('\n'));
  const blockSpec003 = spec003(block);
  assert.ok(blockSpec003.length >= 1, '双裸主编号须产生 RULE-SPEC-003 blocking');
  assert.ok(blockSpec003.every((d) => d.severity === 'blocking'), 'RULE-SPEC-003 须为 blocking');
  assert.ok(blockSpec003.some((d) => textOf(d).includes('多个全局时序主编号')), '诊断须点名多主编号');

  // ③阻断：非法细化变体（[G-Tn 细化] / 细化 Gx）
  const bad = diagnose('## 全局时序\n| 内部时序-1 | 合法 |\n模块 C：[内部时序-1 细化] 与 细化 Gx 均为非法变体\n');
  const badSpec003 = spec003(bad);
  assert.ok(badSpec003.length >= 1, '非法细化变体须产生 RULE-SPEC-003 blocking');
  assert.ok(badSpec003.some((d) => textOf(d).includes('细化 G-Tn')), '诊断须指明合法写法「细化 G-Tn」');
});
