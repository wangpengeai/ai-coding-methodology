// 文件：mcode-adapter/tests/jsdoc-contract.test.mjs
// 描述：文档契约面——① 本层每个导出（函数/常量）必须带紧邻 JSDoc，`@param` 数量与形参
//       一致、函数体有返回的必须带 `@returns`（DSH 适配层同款纪律，防"改了签名没改文档"）；
//       ② README 的测试计数与实测逐文件一致（防"改了测试没改文档"的残留数字）；
//       ③ README 必须写明四个面的形态与已知降级（形态说明的单一事实源在此）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ADAPTER_ROOT } from './helpers.mjs';

/** 生产面源文件（测试固件整面豁免，与仓库 lint 第 9/12 块同款姿态）。 */
function productionFiles() {
  const out = [join(ADAPTER_ROOT, 'cli.mjs')];
  for (const dir of ['src', 'mcode']) {
    for (const name of readdirSync(join(ADAPTER_ROOT, dir)).sort()) {
      if (name.endsWith('.mjs')) out.push(join(ADAPTER_ROOT, dir, name));
    }
  }
  return out;
}

/** 抽取某文件的导出符号与其紧邻 JSDoc。 */
function exportsOf(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fn = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(line);
    const constant = /^export\s+(?:const|let)\s+([A-Za-z0-9_$]+)/.exec(line);
    const name = fn ? fn[1] : constant ? constant[1] : null;
    if (!name) continue;
    // 向上找紧邻的 JSDoc 块（中间只允许空行）
    let cursor = i - 1;
    while (cursor >= 0 && lines[cursor].trim() === '') cursor -= 1;
    let doc = '';
    if (cursor >= 0 && lines[cursor].trim().endsWith('*/')) {
      const end = cursor;
      while (cursor >= 0 && !lines[cursor].trim().startsWith('/**')) cursor -= 1;
      if (cursor >= 0) doc = lines.slice(cursor, end + 1).join('\n');
    }
    const params = fn && fn[2].trim() !== '' ? fn[2].split(',').length : 0;
    const hasReturn = /^\s*return\b/m.test(lines.slice(i).join('\n').split(/\n\s*\}/)[0] ?? '');
    found.push({ name, line: i + 1, doc, params, hasReturn, isFunction: Boolean(fn) });
  }
  return found;
}

describe('JSDoc 契约', () => {
  it('每个导出都带紧邻 JSDoc，@param 数量与形参一致，有返回的带 @returns', () => {
    const problems = [];
    for (const file of productionFiles()) {
      for (const item of exportsOf(file)) {
        const rel = file.slice(ADAPTER_ROOT.length + 1);
        if (item.doc === '') {
          problems.push(`${rel}:${item.line} 导出 ${item.name} 缺紧邻 JSDoc`);
          continue;
        }
        const params = (item.doc.match(/@param\b/g) ?? []).length;
        if (params !== item.params) problems.push(`${rel}:${item.line} ${item.name} 的 @param 数量 ${params} ≠ 形参 ${item.params}`);
        if (item.isFunction && item.hasReturn && !item.doc.includes('@returns')) {
          problems.push(`${rel}:${item.line} ${item.name} 有返回值但缺 @returns`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('生产面源文件数量固定（新增文件须同步本用例覆盖面）', () => {
    assert.equal(productionFiles().length, 1 + 9 + 3, 'cli.mjs + src/9（含 host-presence.mjs，内部决策-048）+ mcode/3（hook-shim/hook-lib/relay-drain）');
  });
});

describe('README 契约', () => {
  const readme = readFileSync(join(ADAPTER_ROOT, 'README.md'), 'utf8');

  it('测试计数与实测逐文件一致（防改了测试没改文档）', () => {
    const declared = new Map();
    for (const match of readme.matchAll(/`tests\/([a-z-]+\.test\.mjs)`\s*×\s*(\d+)/g)) declared.set(match[1], Number(match[2]));
    const problems = [];
    let total = 0;
    for (const name of readdirSync(join(ADAPTER_ROOT, 'tests')).filter((item) => item.endsWith('.test.mjs')).sort()) {
      const count = (readFileSync(join(ADAPTER_ROOT, 'tests', name), 'utf8').match(/^\s*(?:it|test)\(/gm) ?? []).length;
      total += count;
      if (declared.get(name) !== count) problems.push(`${name} 声明 ${String(declared.get(name))} ≠ 实测 ${count}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    const totalMatch = /测试项共\s*(\d+)\s*项/.exec(readme);
    assert.ok(totalMatch, 'README 须声明测试项总数');
    assert.equal(Number(totalMatch[1]), total, 'README 总数与实测不符');
  });

  it('测试计数与实测逐文件一致（含「N 项」写法；只校文件总数站点）', () => {
    // 只校验文件总数站点：「shim 纯函数面 22 项」「生成面 46 项」等是子面计数，不能按本正则判等。
    const installTotal = /`install\.test\.mjs`\s*(\d+)\s*项/.exec(readme);
    assert.ok(installTotal, 'README 须声明 install.test.mjs 的文件总数');
    const count = (readFileSync(join(ADAPTER_ROOT, 'tests', 'install.test.mjs'), 'utf8').match(/^\s*(?:it|test)\(/gm) ?? []).length;
    assert.equal(Number(installTotal[1]), count, 'install.test.mjs 的「N 项」写法与实测不符');
  });

  it('形态说明齐备：四个面、命令面处置、降级登记、agent 面默认关', () => {
    for (const needle of ['钩子面', 'skill 面', '命令面', 'agent 面', '待投递', '连击上限', '默认关闭', '内部未决-48']) {
      assert.ok(readme.includes(needle), `README 缺「${needle}」`);
    }
  });
});
