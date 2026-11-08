// 文件：kimi-code-adapter/tests/jsdoc-contract.test.mjs
// 描述：文档契约面——① 本层每个导出（函数/常量）必须带紧邻 JSDoc，`@param` 数量与形参
//       一致、函数体有返回的必须带 `@returns`（DSH/MCode 适配层同款纪律，防"改了签名没改
//       文档"）；② README 的测试计数与实测逐文件一致（防"改了测试没改文档"的残留数字）；
//       ③ README 必须写明四个面的形态与已知降级（形态说明的单一事实源在此）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, test } from 'node:test';

import { ADAPTER_ROOT } from './helpers.mjs';

// 公开包守卫（内部任务-365）：specs/ 未随公开包发布；源仓资产在位时照常执行。
const HAS_IF_HOST = existsSync(join(resolve(ADAPTER_ROOT, '..'), 'specs', 'interfaces', 'IF-HOST-1.md'));
// 公开包守卫（内部任务-365）：README 在公开包内按散文面改写；源仓照跑。
const IS_SOURCE_REPO = existsSync(join(resolve(ADAPTER_ROOT, '..'), '.deliver'));
import { testSeam } from '../src/test-seams.mjs';

/** 生产面源文件（测试固件整面豁免，与仓库 lint 第 9 块同款姿态）。 */
function productionFiles() {
  const out = [join(ADAPTER_ROOT, 'cli.mjs')];
  for (const dir of ['src', 'kimi']) {
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

  it('生产面源文件数量固定（新增文件须同步本用例覆盖面）；测试缝只经 src/test-seams.mjs 读取', () => {
    assert.equal(productionFiles().length, 1 + 10 + 4, 'cli.mjs + src/10（含 test-seams.mjs，DEV-335）+ kimi/4（含 compact-workflow.mjs/relay-drain.mjs，DEV-297/DEV-302）');
    const leaks = [];
    for (const file of productionFiles()) {
      const rel = file.slice(ADAPTER_ROOT.length + 1).split('\\').join('/');
      if (rel === 'src/test-seams.mjs') continue;
      const hits = readFileSync(file, 'utf8').match(/KIMI_TEST_[A-Z0-9_]+/g) ?? [];
      if (hits.length > 0) leaks.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
    }
    assert.deepEqual(leaks, [], `生产面只允许 src/test-seams.mjs 出现 KIMI_TEST_*：\n${leaks.join('\n')}`);
    const prevRollback = process.env.KIMI_TEST_ROLLBACK_FAIL;
    const prevPrune = process.env.KIMI_TEST_PRUNE_LOCK;
    try {
      process.env.KIMI_TEST_ROLLBACK_FAIL = '1';
      process.env.KIMI_TEST_PRUNE_LOCK = '1';
      assert.equal(testSeam('rollbackFail'), true);
      assert.equal(testSeam('pruneLock'), true);
      process.env.KIMI_TEST_ROLLBACK_FAIL = '0';
      assert.equal(testSeam('rollbackFail'), false, '非 1 值视为关闭');
      assert.throws(() => testSeam('nope'), /未登记的测试缝/);
    } finally {
      if (prevRollback === undefined) delete process.env.KIMI_TEST_ROLLBACK_FAIL;
      else process.env.KIMI_TEST_ROLLBACK_FAIL = prevRollback;
      if (prevPrune === undefined) delete process.env.KIMI_TEST_PRUNE_LOCK;
      else process.env.KIMI_TEST_PRUNE_LOCK = prevPrune;
    }
  });

  it('生产面 kimi/*.mjs 不得在写 stdout 后立即 process.exit（DEV-241 教训）', () => {
    for (const name of ['hook-shim.mjs', 'relay-drain.mjs', 'compact-workflow.mjs']) {
      const src = readFileSync(join(ADAPTER_ROOT, 'kimi', name), 'utf8');
      assert.ok(!/process\.exit\s*\(/.test(src), `${name} 含 process.exit( —— 写 stdout 后应使用 process.exitCode`);
    }
  });
});

describe('README 契约', () => {
  const readme = readFileSync(join(ADAPTER_ROOT, 'README.md'), 'utf8');

  test('测试计数与实测逐文件一致（防改了测试没改文档）', () => {
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

  it('IF-HOST-1 第四宿主差异面恰 13 行且编号 1..13 连续', { skip: HAS_IF_HOST ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
    // 内部任务-209 S4（内部未决-194/内部未决-199）：A-ka-11 的「13 行差异面与本分册一致」由 内部接口-1 §第四宿主
    // 实例化登记节的差异表机检——编号连续 1..13（缺行/重号/多行即红）。
    const repoRoot = resolve(ADAPTER_ROOT, '..');
    const ifHost = readFileSync(join(repoRoot, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8');
    const start = ifHost.indexOf('## 第四宿主实例化登记');
    assert.ok(start >= 0, 'IF-HOST-1 须有第四宿主实例化登记节');
    const rest = ifHost.slice(start + 1);
    const next = rest.indexOf('\n## ');
    const section = next >= 0 ? rest.slice(0, next) : rest;
    const ids = [...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, Array.from({ length: 13 }, (_, i) => i + 1), `差异面须恰 13 行且编号 1..13 连续（实测 ${ids.length} 行：${ids.join(',')}）`);
  });

  it('形态说明齐备：四个面、差异处置、降级登记、agent 默认关、staging、已知限制', { skip: IS_SOURCE_REPO ? false : '公开包 README 按散文面改写（源仓照跑）' }, () => {
    for (const needle of ['钩子面', 'skill 面', '命令面', 'agent 面', '待投递', '连击上限', '默认关闭', '--staging', 'marketplace', '已知限制', 'OPEN-69', 'hooks.json']) {
      assert.ok(readme.includes(needle), `README 缺「${needle}」`);
    }
  });
});
