// 文件：装载期字段契约断言的 apply() 级用例（批 2 终审阻塞③）
// 描述：真实引擎（非 stub）在**缺一条 `params.dsh`** 时必须让 `apply()` 拒载——先 logWarn、零注册。
//       本用例存在的理由：把 `missingConsumedRules(...)` 短路成空数组后，全部其它用例仍绿；
//       端到端断言是"断言接上了没有"的唯一证据。**独立文件**：模块级绑定槽要求绑定态与
//       拒载负例分处不同文件（计划「负例顺序约束」）。
// 作者：wangp 创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/apply-shape.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { createLogger } from './helpers/logger-stub.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

test('apply：规则库缺 params.dsh → 装载期断言拒载（先 logWarn、零注册）', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-shape-')));
  try {
    // 夹具：真实 plugin-core 的 src（软链）+ 两份数据里抹掉某条规则的 params.dsh
    mkdirSync(join(root, 'plugin-core'), { recursive: true });
    symlinkSync(join(REPO_ROOT, 'plugin-core', 'src'), join(root, 'plugin-core', 'src'), 'dir');
    for (const file of ['degradation-rules.json', 'capability-matrix.json']) {
      const source = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', file), 'utf8'));
      if (Array.isArray(source.rules)) {
        for (const rule of source.rules) {
          if (rule.id === 'tool-vocab-map' && rule.params) delete rule.params.dsh;
        }
      }
      writeFileSync(join(root, 'plugin-core', file), JSON.stringify(source), 'utf8');
    }
    const logger = createLogger();
    const calls = [];
    const ctx = {
      logger,
      on: (...args) => calls.push(['on', ...args]),
      get: (name) => { calls.push(['get', name]); return undefined; },
    };
    await assert.rejects(() => apply(ctx, { repoRootOverride: root }), /params\.dsh|字段契约/, '缺 params.dsh 必须拒载');
    assert.equal(calls.length, 0, '拒载不得注册任何面');
    const warned = logger.byLevel('warn').join('\n');
    assert.match(warned, /字段契约不满足/, '拒载须先落 logWarn');
    assert.match(warned, /tool-vocab-map/, '日志须点名漂移的 ruleId');
  } finally {
    const prefixes = [tmpdir(), realpathSync(tmpdir())];
    if (prefixes.some((p) => root.startsWith(p))) rmSync(root, { recursive: true, force: true });
  }
});
