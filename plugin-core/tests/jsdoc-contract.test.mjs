// 文件：plugin-core JSDoc 契约测试
// 描述：逐导出 JSDoc 契约（紧邻块、@param 数=形参数、有 return 必有 @returns）——形态复刻
//       zcode-adapter/tests/jsdoc-contract.test.mjs（终审处置：三适配层 3/3 先例，plugin-core
//       期二起是全部适配层的共享依赖，纳入同款机制）；README 计数记账面不设——plugin-core
//       测试文件数已由 release-suite 目录枚举承载，双记账反造漂移面。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/jsdoc-contract.test.mjs"
// 自检：本文件即自检
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..');

/** 生产面文件（cli.mjs + src/*.mjs + src/strategies/*.mjs；新增文件自动入册，含子目录）。 */
function productionFiles() {
  const srcDir = join(CORE_ROOT, 'src');
  const strategiesDir = join(srcDir, 'strategies');
  const list = (dir) => readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => join(dir, f));
  return [join(CORE_ROOT, 'cli.mjs'), ...list(srcDir), ...list(strategiesDir)];
}

/** 抽取一个文件的导出面（export function/const）与其紧邻 JSDoc 块（zcode-adapter 同款解析）。 */
function exportsOf(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^export (?:async )?function (\w+)|^export const (\w+)/);
    if (!m) continue;
    const name = m[1] ?? m[2];
    let j = i - 1;
    const docLines = [];
    while (j >= 0 && lines[j].trim().startsWith('*')) {
      docLines.unshift(lines[j]);
      j -= 1;
    }
    const multi = j >= 0 && lines[j].trim().endsWith('/**');
    const single = j >= 0 && /^\/\*\*.*\*\/\s*$/.test(lines[j].trim());
    const hasDoc = multi || single;
    const params = (lines[i].match(/\(([^)]*)\)/)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('...')).length;
    const docText = docLines.join('\n');
    const docParams = (docText.match(/@param/g) ?? []).length;
    const hasReturn = /^export (?:async )?function/.test(lines[i]) || /=>/.test(lines[i]);
    const docReturns = (docText.match(/@returns/g) ?? []).length;
    out.push({ name, hasDoc, params, docParams, hasReturn, docReturns, file: null });
  }
  return out;
}

test('JSDoc 契约：每个导出有紧邻 JSDoc、@param 数=形参数、有 return 必有 @returns', () => {
  for (const file of productionFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const e of exportsOf(text)) {
      assert.ok(e.hasDoc, `${file} 导出 ${e.name} 缺紧邻 JSDoc`);
      assert.ok(e.docParams === e.params, `${file} ${e.name}：@param ${e.docParams} 个 ≠ 形参 ${e.params} 个`);
      if (e.hasReturn) assert.ok(e.docReturns >= 1, `${file} ${e.name}：有 return 缺 @returns`);
    }
  }
});
