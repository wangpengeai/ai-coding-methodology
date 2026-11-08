// 文件：引擎装载与绑定测试（批 2 阶段 1）
// 描述：resolveEngine（默认相对定位 / override 正例 / 缺失与坏 JSON 的具名抛错）与
//       engine-binding 三语义（未绑定抛错 / 同实例幂等 / 异实例抛错 / ensureBound 复用）
// 作者：wangp  创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/engine-loader.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindEngine, ensureBound, getEngine } from '../src/engine-binding.mjs';
import { CONSUMED_RULES, missingConsumedRules, resolveEngine } from '../src/engine-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** 临时根（mkdtemp + realpath 归一，写面不出 os.tmpdir()）。 */
function tempRoot(tag) {
  return realpathSync(mkdtempSync(join(tmpdir(), `dsh-${tag}-`)));
}

/** 清理临时根（守卫同时接受 tmpdir 与其 realpath 归一——macOS 上 `/var` 为 `/private/var` 符号链接）。 */
function removeRoot(root) {
  if (typeof root !== 'string' || root === '') return;
  const candidates = [tmpdir(), realpathSync(tmpdir())];
  if (candidates.some((prefix) => root.startsWith(prefix))) rmSync(root, { recursive: true, force: true });
}

/** 在根下写文件（自动建目录）。 */
function writeFile(root, rel, text) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

// ⑤ 未绑定失败面（须在最前：本文件后续用例会写入模块级绑定槽）
test('getEngine：未绑定即具名抛错（禁回落旧实现）', () => {
  assert.throws(() => getEngine(), /引擎未绑定/);
});

// ① 默认相对定位
test('resolveEngine：默认相对定位解析出引擎实例', () => {
  const engine = resolveEngine();
  assert.equal(typeof engine.applyRule, 'function');
});

// ② override 正例
test('resolveEngine：repoRootOverride 指向真实仓库根 → 命中', () => {
  const engine = resolveEngine({ repoRootOverride: REPO_ROOT });
  assert.equal(typeof engine.applyRule, 'function');
});

// ③ override 指向 plugin-core 不可达的树 → 具名抛错（含路径与修复指引）
test('resolveEngine：plugin-core 缺失 → 具名抛错（含尝试路径与修复指引）', () => {
  const root = tempRoot('eng-miss');
  try {
    assert.throws(
      () => resolveEngine({ repoRootOverride: root }),
      (error) => error.message.includes('plugin-core') && error.message.includes('修复'),
      '消息须含 plugin-core 与修复指引',
    );
  } finally { removeRoot(root); }
});

// ④ plugin-core 在场但数据损坏 → 抛错含文件路径（诊断权归 plugin-core：软链真实 src 使 loadEngine 真正读到坏数据）
test('resolveEngine：规则数据坏 JSON → 抛错含文件路径', (t) => {
  const root = tempRoot('eng-bad');
  try {
    writeFile(root, 'plugin-core/degradation-rules.json', '{ bad json');
    mkdirSync(join(root, 'plugin-core'), { recursive: true });
    try {
      symlinkSync(join(REPO_ROOT, 'plugin-core', 'src'), join(root, 'plugin-core', 'src'), 'dir');
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) { t.skip(`无符号链接权限（${e.code}）`); return; }
      throw e;
    }
    assert.throws(() => resolveEngine({ repoRootOverride: root }), /degradation-rules\.json/);
  } finally { removeRoot(root); }
});

// ⑦ 装载期机械断言：真实引擎下 7 条消费规则齐备；漂移（applied:false / 未登记）即报出
test('missingConsumedRules：真实引擎 → 无缺失（7 条消费规则均含 params.dsh）', () => {
  const engine = resolveEngine({ repoRootOverride: REPO_ROOT });
  assert.deepEqual(missingConsumedRules(engine), []);
});

test('missingConsumedRules：数据漂移 → 报出缺失 ruleId（applied:false 与未登记两形态）', (t) => {
  const drifted = {
    applyRule: (ruleId) => {
      if (ruleId === 'followup-expansion') return { applied: false, fidelity: 'lossy' }; // 宿主无 params 条目
      if (ruleId === 'message-slot-migration') throw new Error(`applyRule: ruleId=${ruleId} host=dsh: 未知规则（规则未登记）`); // 真实引擎文案（S8 起不依赖子串，兼容旧文案）
      return { applied: true, result: undefined };
    },
  };
  assert.deepEqual(missingConsumedRules(drifted), ['followup-expansion', 'message-slot-migration']);
  assert.equal(missingConsumedRules(null).length, CONSUMED_RULES.length, '非引擎对象即全缺');
  // hasRule 分支专属断言（阶段门#2 G3）：hasRule=false 直接判缺且不调用 applyRule；hasRule=true + applied:false 仍判缺
  const hasRuleFalse = { hasRule: () => false, applyRule: () => { throw new Error('applyRule 不应被调用'); } };
  assert.deepEqual(missingConsumedRules(hasRuleFalse), CONSUMED_RULES.map(([ruleId]) => ruleId), 'hasRule=false 须直接判缺');
  const appliedFalse = { hasRule: () => true, applyRule: () => ({ applied: false, fidelity: 'lossy' }) };
  assert.deepEqual(missingConsumedRules(appliedFalse), CONSUMED_RULES.map(([ruleId]) => ruleId), 'hasRule=true 且 applied:false 仍须判缺');

  // 真实引擎 + 删规则夹具（内部任务-238 S8）：hasRule 只读登记态须捕获「规则整条删除」形态
  const root = tempRoot('eng-drift');
  try {
    mkdirSync(join(root, 'plugin-core'), { recursive: true });
    try {
      symlinkSync(join(REPO_ROOT, 'plugin-core', 'src'), join(root, 'plugin-core', 'src'), 'dir');
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) { t.skip(`无符号链接权限（${e.code}）`); return; }
      throw e;
    }
    copyFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), join(root, 'plugin-core', 'capability-matrix.json'));
    const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
    rules.rules = rules.rules.filter((r) => r.id !== 'followup-expansion');
    writeFileSync(join(root, 'plugin-core', 'degradation-rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
    const real = resolveEngine({ repoRootOverride: root });
    assert.deepEqual(missingConsumedRules(real), ['followup-expansion'], '规则整条删除须被 hasRule 判定捕获（退化为静默缺规则即红）');
  } finally { removeRoot(root); }
});

// ⑥ 绑定三语义
test('bindEngine/ensureBound：同实例幂等、异实例抛错、已绑定复用', () => {
  const first = resolveEngine({ repoRootOverride: REPO_ROOT });
  const second = resolveEngine({ repoRootOverride: REPO_ROOT });
  assert.equal(bindEngine(first), first);
  assert.equal(bindEngine(first), first, '同实例幂等');
  assert.equal(getEngine(), first);
  let resolverCalls = 0;
  assert.equal(ensureBound(() => { resolverCalls += 1; return second; }), first, '已绑定即复用');
  assert.equal(resolverCalls, 0, '已绑定不得再调 resolver');
  assert.throws(() => bindEngine(second), /另一实例/, '异实例即抛');
});
