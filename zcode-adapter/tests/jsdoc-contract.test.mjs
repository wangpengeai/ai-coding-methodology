// 文件：zcode-adapter/tests/jsdoc-contract.test.mjs
// 描述：JSDoc 契约与 README 计数记账（S5 步骤 14，形态复刻 mcode-adapter 同名文件）——
//       生产文件数固定（1+11）、逐导出 JSDoc @param/@returns 契约、README 逐文件 × N 计数
//       与实测 it/test 计数一致、总数一致（改测试不改 README 即红，改 README 数字不实也红）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, '..');

/** 生产面文件（cli.mjs + src/*.mjs；新增文件须同步本用例计数）。 */
function productionFiles() {
  return [
    join(ADAPTER_ROOT, 'cli.mjs'),
    ...readdirSync(join(ADAPTER_ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => join(ADAPTER_ROOT, 'src', f)),
  ];
}

/** 抽取一个文件的导出面（export function/const）与其紧邻 JSDoc 块。 */
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
    // 两种可识别形态：多行块（上一行以 /** 结尾）与单行块（/** … */ 同行闭合）
    const multi = j >= 0 && lines[j].trim().endsWith('/**');
    const single = j >= 0 && /^\/\*\*.*\*\/\s*$/.test(lines[j].trim());
    const hasDoc = multi || single;
    if (single) docLines.unshift(lines[j].trim());
    out.push({ name, isFunction: Boolean(m[1]), doc: hasDoc ? docLines.join('\n') : '' });
  }
  return out;
}

test('JSDoc 契约：每个导出有紧邻 JSDoc、@param 数=形参数、有 return 必有 @returns', () => {
  for (const file of productionFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const e of exportsOf(text)) {
      assert.ok(e.doc.length > 0, `${file} 的导出 ${e.name} 缺紧邻 JSDoc`);
      if (!e.isFunction) continue;
      const sigLine = text.split('\n').find((l) => l.includes(`function ${e.name}(`)) ?? '';
      // 剥解构对象段（{a, b} 记一个形参）后再按顶层逗号计数
      const paramText = sigLine.slice(sigLine.indexOf('(') + 1, sigLine.lastIndexOf(')')).replace(/\{[^{}]*\}/g, 'OBJ');
      const paramCount = paramText.split(',').filter((s) => s.trim() && !s.trim().startsWith('...')).length;
      const docParams = (e.doc.match(/@param/g) ?? []).length;
      assert.equal(docParams, paramCount, `${file} 的 ${e.name}：@param ${docParams} ≠ 形参 ${paramCount}`);
      const body = text.slice(text.indexOf(`function ${e.name}(`));
      const bodyEnd = body.indexOf('\n}');
      if (/\breturn\b/.test(body.slice(0, bodyEnd > 0 ? bodyEnd : undefined))) {
        assert.ok(e.doc.includes('@returns'), `${file} 的 ${e.name} 有 return 但缺 @returns`);
      }
    }
  }
});

test('生产面文件数固定：1 + 11 = 12（新增文件须同步本用例；阶段5 删 spawn-helpers）', () => {
  assert.equal(productionFiles().length, 1 + 11);
});

test('README 测试计数与实测一致（目录枚举对账——新增测试文件漏记 README 即红，mcode 先例）', () => {
  const readme = readFileSync(join(ADAPTER_ROOT, 'README.md'), 'utf8');
  const declared = new Map([...readme.matchAll(/`tests\/([a-z-]+\.test\.mjs)`\s*×\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const onDisk = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  let total = 0;
  for (const name of onDisk) {
    const text = readFileSync(join(HERE, name), 'utf8');
    const actual = (text.match(/^\s*(?:test|it)\(/gm) ?? []).length;
    assert.ok(declared.has(name), `README 漏记 tests/${name}（逐文件 × N 记账）`);
    assert.equal(actual, declared.get(name), `tests/${name}：README 声明 ${declared.get(name)} ≠ 实测 ${actual}`);
    total += actual;
  }
  for (const name of declared.keys()) {
    assert.ok(onDisk.includes(name), `README 记账的 tests/${name} 不存在于磁盘`);
  }
  const totalMatch = readme.match(/测试项共\s*(\d+)\s*项/);
  assert.ok(totalMatch, 'README 须有「测试项共 N 项」总数行');
  assert.equal(Number(totalMatch[1]), total, `总数 ${totalMatch[1]} ≠ 实测 ${total}`);
});

test('README 形态说明齐备（四子命令/七面/写后即验/bootstrap/已知限制）', () => {
  const readme = readFileSync(join(ADAPTER_ROOT, 'README.md'), 'utf8');
  for (const needle of ['verify', 'publish', 'install', 'bump', '七面', '写后即验', '--bootstrap', '已知限制', '旧版本']) {
    assert.ok(readme.includes(needle), `README 缺关键说明：${needle}`);
  }
});
