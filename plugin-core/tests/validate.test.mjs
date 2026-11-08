// 文件：manifest 校验器正负例（A-pc-1）
// 描述：schema 校验 + 中立性 lint + 声明面目录存在性；错误一次列全；坏 JSON 不裸崩
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/validate.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRoot, removeRoot, writeFile, REPO_ROOT } from './helpers.mjs';
import { validateManifest, lintNeutrality, validateRules, neutralPlaceholderHits, HOST_TERMS } from '../src/validate.mjs';
import { PLUGINS } from '../src/materialize.mjs';

// 正例基准 = 仓库真件 workflow/plugin.manifest.json（门 A 评审处置：内嵌副本会随版本折叠
// 静默腐烂，改读真件——顺带把「六插件 manifest 过校验」固化为常驻测试；PLUGINS 单源导入，
// 新增插件时本文件自动覆盖并另由 S5 的目录集对拍断言把守）。

function baseManifest() {
  return {
    manifestVersion: 1,
    name: 'demo',
    version: '1.0.0',
    description: '演示插件',
    author: 'wangp',
    hooks: [
      { event: 'SessionStart', matcher: 'startup|resume', type: 'process', command: 'node',
        args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 5000, statusMessage: 'demo' },
    ],
  };
}

function setup(root, manifest, opts = {}) {
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
  writeFile(root, 'demo/plugin.manifest.json', text);
  writeFile(root, 'demo/hooks/a.mjs', '// demo\n');
  if (opts.agents) writeFile(root, 'demo/agents/x.md', '# x\n');
  return root;
}

test('正例：套件插件真仓 manifest 全过校验（固化为常驻测试）', () => {
  for (const p of PLUGINS) {
    const r = validateManifest(REPO_ROOT, p);
    assert.equal(r.ok, true, `${p}: ${JSON.stringify(r.errors)}`);
  }
  // 内部任务-214 批 4（A-pc-1 补断言）：负例一次列全且拒时不产出（validate 纯函数面，拒即零写）
  const root = tempRoot('val-aggregate');
  try {
    const m = baseManifest();
    delete m.name;
    delete m.description;
    m.version = 42;
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false, '三类错误并存须拒');
    assert.ok(r.errors.length >= 3, `错误须一次列全（实际 ${JSON.stringify(r.errors)}）`);
    for (const key of ['name', 'description', 'version']) {
      assert.ok(r.errors.some((e) => e.includes(key)), `聚合错误须含 ${key}：${JSON.stringify(r.errors)}`);
    }
  } finally { removeRoot(root); }
});

test('缺 manifestVersion → 拒', () => {
  const root = tempRoot('val-n1');
  try {
    const m = baseManifest(); delete m.manifestVersion;
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('manifestVersion')));
  } finally { removeRoot(root); }
});

test('未知 manifestVersion → 拒', () => {
  const root = tempRoot('val-n2');
  try {
    const r = validateManifest(setup(root, { ...baseManifest(), manifestVersion: 2 }), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('manifestVersion')));
  } finally { removeRoot(root); }
});

test('元数据四字段缺失各一例 → 逐例拒且一次列全', () => {
  for (const field of ['name', 'version', 'description', 'author']) {
    const root = tempRoot('val-n3');
    try {
      const m = baseManifest(); delete m[field];
      const r = validateManifest(setup(root, m), 'demo');
      assert.equal(r.ok, false, `${field} 缺失应拒`);
      assert.ok(r.errors.some((e) => e.includes(field)), `${field} 应出现在错误清单`);
      assert.ok(r.errors.length >= 1);
    } finally { removeRoot(root); }
  }
});

test('hooks 条目缺 event / 未知 event → 拒（错误路径含条目下标）', () => {
  const root = tempRoot('val-n4');
  try {
    const m = baseManifest();
    m.hooks.push({ type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 1000, statusMessage: 'x' });
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('hooks[1]')));
  } finally { removeRoot(root); }
  const root2 = tempRoot('val-n4b');
  try {
    const r = validateManifest(setup(root2, { ...baseManifest(), hooks: [{ ...baseManifest().hooks[0], event: 'OnSave' }] }), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('OnSave') || e.includes('event')));
  } finally { removeRoot(root2); }
});

test('hooks 条目缺 type/command/args、args 非字符串数组、timeoutMs 非正整数 → 各拒', () => {
  const bads = [
    (h) => { delete h.type; },
    (h) => { delete h.command; },
    (h) => { delete h.args; },
    (h) => { h.args = [123]; },
    (h) => { h.timeoutMs = -1; },
    (h) => { h.timeoutMs = '5000'; },
  ];
  for (const mutate of bads) {
    const root = tempRoot('val-n5');
    try {
      const m = baseManifest(); mutate(m.hooks[0]);
      const r = validateManifest(setup(root, m), 'demo');
      assert.equal(r.ok, false, `变异 ${mutate} 应拒`);
    } finally { removeRoot(root); }
  }
});

test('lint：宿主占位符（非 PLUGIN_ROOT 的 ${...}）→ 拒并指明字面量', () => {
  const root = tempRoot('val-n6');
  try {
    const m = baseManifest();
    m.hooks[0].args = ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs'];
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('${ZCODE_PLUGIN_ROOT}')), '错误应含占位符字面量');
  } finally { removeRoot(root); }
});

test('lint：宿主专有名（词边界）→ 拒（全词表）', () => {
  for (const term of HOST_TERMS) {
    const root = tempRoot('val-n7');
    try {
      const m = { ...baseManifest(), description: `demo for ${term} users` };
      const r = validateManifest(setup(root, m), 'demo');
      assert.equal(r.ok, false, `${term} 应被 lint 拒`);
      assert.ok(r.errors.some((e) => e.includes(term)));
    } finally { removeRoot(root); }
  }
});

test('agents 目录存在但缺 surfaces.agents → 拒；agents 不存在但登记了 → 拒', () => {
  const root = tempRoot('val-n8');
  try {
    const r = validateManifest(setup(root, baseManifest(), { agents: true }), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('agents')));
  } finally { removeRoot(root); }
  const root2 = tempRoot('val-n8b');
  try {
    const m = { ...baseManifest(), surfaces: { agents: { defaultMount: false } } };
    const r = validateManifest(setup(root2, m), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('agents')));
  } finally { removeRoot(root2); }
});

test('surfaces.agents 登记时 defaultMount 非 boolean → 拒', () => {
  const root = tempRoot('val-n8c');
  try {
    writeFile(root, 'demo/agents/x.md', '# x\n');
    const m = { ...baseManifest(), surfaces: { agents: { defaultMount: 'no' } } };
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('defaultMount')));
  } finally { removeRoot(root); }
});

test('hooks 脚本文件缺失 → 拒', () => {
  const root = tempRoot('val-n9');
  try {
    writeFile(root, 'demo/plugin.manifest.json', JSON.stringify(baseManifest(), null, 2));
    // 不写 hooks/a.mjs
    const r = validateManifest(root, 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('a.mjs')));
  } finally { removeRoot(root); }
});

test('manifest 缺失 → 单错即返', () => {
  const root = tempRoot('val-n10');
  try {
    const r = validateManifest(root, 'demo');
    assert.equal(r.ok, false); assert.equal(r.errors.length, 1); assert.ok(r.errors[0].includes('缺失'));
  } finally { removeRoot(root); }
});

test('坏 JSON：语法损坏 → ok:false 且恰一条语法错误、不抛异常', () => {
  const root = tempRoot('val-n11');
  try {
    writeFile(root, 'demo/plugin.manifest.json', '{ "manifestVersion": 1, }');
    let r;
    assert.doesNotThrow(() => { r = validateManifest(root, 'demo'); });
    assert.equal(r.ok, false); assert.equal(r.errors.length, 1); assert.ok(r.errors[0].includes('语法错误'));
  } finally { removeRoot(root); }
});

test('坏 JSON：顶层为 null / 数组 → 单错即返、不抛异常（门 A 发现 1 回归锚）', () => {
  for (const text of ['null', '[1,2]']) {
    const root = tempRoot('val-n13');
    try {
      writeFile(root, 'demo/plugin.manifest.json', text);
      let r;
      assert.doesNotThrow(() => { r = validateManifest(root, 'demo'); }, `顶层 ${text} 不得抛异常`);
      assert.equal(r.ok, false, text);
      assert.ok(r.errors[0].includes('顶层须为对象'), `错误应指顶层形态，实测 ${r.errors[0]}`);
    } finally { removeRoot(root); }
  }
});

test('错误一次列全：三类错误并存 → errors.length ≥ 3', () => {
  const root = tempRoot('val-n12');
  try {
    const m = baseManifest();
    delete m.version;                              // 错一：元数据
    m.hooks[0].event = 'OnSave';                   // 错二：未知事件
    m.hooks[0].args = ['${ZCODE_PLUGIN_ROOT}/hooks/a.mjs']; // 错三：宿主占位符
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false); assert.ok(r.errors.length >= 3, `应列全 ≥3 错，实测 ${r.errors.length}: ${JSON.stringify(r.errors)}`);
  } finally { removeRoot(root); }
});

test('lintNeutrality 纯函数：命中清单可直接消费', () => {
  const hits = lintNeutrality('{"a":"${FOO_BAR}","b":"ZCode"}');
  assert.ok(hits.some((h) => h.includes('${FOO_BAR}')));
  assert.ok(hits.some((h) => h.includes('ZCode')));
  assert.deepEqual(lintNeutrality('{"a":"${PLUGIN_ROOT}"}'), []);
  assert.ok(lintNeutrality('{"x":"Kimi Code"}').some((h) => h.includes('宿主专有名 Kimi')), 'Kimi 词边界命中');
  assert.ok(lintNeutrality('{"x":"kimi"}').some((h) => h.includes('宿主专有名 kimi')), 'kimi 词边界命中');
});

// ---- 规则库 params 机读化校验（validateRules，内部决策-037/内部需求-7）----
// 夹具：最小合法规则库 + 最小矩阵（能力键集只含被测键）；负例逐条变异。
const MINI_MATRIX = { hosts: ['zcode', 'dsh', 'mcode'], capabilities: { 'toolName.vocabulary': { type: 'string[]', zcode: [], dsh: [], mcode: [] } } };

function baseRules() {
  return {
    rulesVersion: 2,
    rules: [
      { id: 'tool-vocab-map', title: '工具名词表映射', trigger: { capability: 'toolName.vocabulary', gap: 'differs' },
        strategy: 'map', params: { dsh: { direction: 'widen', table: { Bash: ['bash'] } } }, fidelity: 'lossy', sourceRef: ['内部决策-032'] },
    ],
  };
}

test('validateRules 正例：真实规则库与真实矩阵全过', () => {
  const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const r = validateRules(rules, matrix);
  assert.equal(r.ok, true, `真实规则库应过校验：${JSON.stringify(r.errors)}`);
});

test('validateRules 负例：params 非对象 / 含 zcode 键 / 无宿主键', () => {
  const bad1 = baseRules(); bad1.rules[0].params = [];
  assert.ok(validateRules(bad1, MINI_MATRIX).errors.some((e) => e.includes('params')));
  const bad2 = baseRules(); bad2.rules[0].params = { zcode: { direction: 'widen', table: { Bash: ['bash'] } } };
  assert.ok(validateRules(bad2, MINI_MATRIX).errors.some((e) => e.includes('zcode')));
  const bad3 = baseRules(); bad3.rules[0].params = {};
  assert.ok(validateRules(bad3, MINI_MATRIX).errors.some((e) => e.includes('宿主键')));
});

test('validateRules 负例：host 条目非对象/空对象、缺必需字段', () => {
  const bad1 = baseRules(); bad1.rules[0].params.dsh = null;
  assert.ok(validateRules(bad1, MINI_MATRIX).errors.some((e) => e.includes('非空对象')));
  const bad2 = baseRules(); bad2.rules[0].params.dsh = {};
  assert.ok(validateRules(bad2, MINI_MATRIX).errors.some((e) => e.includes('非空对象')));
  const bad3 = baseRules(); delete bad3.rules[0].params.dsh.table;
  assert.ok(validateRules(bad3, MINI_MATRIX).errors.some((e) => e.includes('table')));
});

test('validateRules 负例：字段值越枚举/类型错', () => {
  const bad1 = baseRules(); bad1.rules[0].params.dsh.direction = 'sideways';
  assert.ok(validateRules(bad1, MINI_MATRIX).errors.some((e) => e.includes('direction')));
  const relay = { id: 'stop-pending-relay', title: '中继', trigger: { capability: 'toolName.vocabulary', gap: 'none' },
    strategy: 'relay', params: { mcode: { store: 'PLUGIN_DATA', deliverOn: 'UserPromptSubmit', burstCap: 0 } }, fidelity: 'degraded', sourceRef: ['内部决策-034'] };
  const bad2 = { rulesVersion: 2, rules: [relay] };
  assert.ok(validateRules(bad2, MINI_MATRIX).errors.some((e) => e.includes('burstCap')));
  const disable = { id: 'agent-default-off-fail-closed', title: '关门', trigger: { capability: 'toolName.vocabulary', gap: 'optional' },
    strategy: 'disable', params: { dsh: { defaultMount: 'no', unknownTool: 'reject' } }, fidelity: 'degraded', sourceRef: ['内部决策-032'] };
  assert.ok(validateRules({ rulesVersion: 2, rules: [disable] }, MINI_MATRIX).errors.some((e) => e.includes('defaultMount')));
});

test('validateRules 负例：trigger.capability 不在矩阵 / strategy 越枚举 / id 重复 / 版本错', () => {
  const bad1 = baseRules(); bad1.rules[0].trigger.capability = 'ghost.key';
  assert.ok(validateRules(bad1, MINI_MATRIX).errors.some((e) => e.includes('ghost.key')));
  const bad2 = baseRules(); bad2.rules[0].strategy = 'teleport';
  assert.ok(validateRules(bad2, MINI_MATRIX).errors.some((e) => e.includes('strategy')));
  const bad3 = baseRules(); bad3.rules.push(JSON.parse(JSON.stringify(bad3.rules[0])));
  assert.ok(validateRules(bad3, MINI_MATRIX).errors.some((e) => e.includes('重复')));
  const bad4 = baseRules(); bad4.rulesVersion = 1;
  assert.ok(validateRules(bad4, MINI_MATRIX).errors.some((e) => e.includes('rulesVersion')));
});

test('validateRules 错误一次列全：多类错误并存 errors.length ≥ 3', () => {
  const bad = baseRules();
  bad.rulesVersion = 1;
  bad.rules[0].strategy = 'teleport';
  bad.rules[0].params.dsh.direction = 'sideways';
  const r = validateRules(bad, MINI_MATRIX);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `应列全 ≥3 错，实测 ${r.errors.length}: ${JSON.stringify(r.errors)}`);
});

// 门 A 评审处置补测（正确性维 #1/#4、约定维 #1/#2）：原型成员键、anyOf 全缺、
// 早返回路径、fidelity/onTimeout 负例。
test('validateRules：原型成员名作键不得绕过校验或抛错（门 A/终审回归）', () => {
  const mkRule = (id, params, capability = 'toolName.vocabulary') => ({
    rulesVersion: 2,
    rules: [{ id, title: 'x', trigger: { capability, gap: 'differs' }, strategy: 'map', params, fidelity: 'lossy', sourceRef: ['内部决策-032'] }],
  });
  const okParams = { dsh: { direction: 'widen', table: { Bash: ['bash'] } } };
  // 判别性断言（修复前会假通过的两例）
  const capHit = validateRules(mkRule('tool-vocab-map', okParams, 'toString'), MINI_MATRIX);
  assert.equal(capHit.ok, false);
  assert.ok(capHit.errors.some((e) => e.includes('不在矩阵键集')), 'capability 原型成员须判越键集');
  const idHit = validateRules(mkRule('constructor', { dsh: { zzz: 1 } }), MINI_MATRIX);
  assert.equal(idHit.ok, false);
  assert.ok(idHit.errors.some((e) => e.includes('无 params 字段 schema 登记')), 'id 原型成员须判无 schema');
  // 不裸崩（修复前 hasOwnProperty 字段名会抛 TypeError）
  const fieldCases = [
    mkRule('tool-vocab-map', { dsh: JSON.parse('{"__proto__": 1}') }),
    mkRule('tool-vocab-map', { dsh: JSON.parse('{"hasOwnProperty": 1}') }),
    mkRule('tool-vocab-map', { dsh: JSON.parse('{"toString": 1}') }),
  ];
  for (const doc of fieldCases) {
    let r;
    assert.doesNotThrow(() => { r = validateRules(doc, MINI_MATRIX); }, '原型成员字段名不得致抛错');
    assert.equal(r.ok, false, '原型成员字段名不得被判通过');
  }
});

test('validateRules：anyOf/allOf 型规则缺形态须判拒（门 A/终审假阴性补测）', () => {
  const anyOfCases = [
    { id: 'command-to-skill', params: { mcode: { note: 'x' } } },
    { id: 'message-slot-migration', params: { dsh: { note: 'x' } } },
  ];
  for (const c of anyOfCases) {
    const r = validateRules({ rulesVersion: 2, rules: [{ ...c, strategy: 'emulate', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: 'none' }, fidelity: 'lossy', sourceRef: ['内部决策-032'] }] }, MINI_MATRIX);
    assert.equal(r.ok, false, `${c.id} 全缺形态应判拒`);
    assert.ok(r.errors.some((e) => e.includes('至少需含')), `${c.id} 应报 anyOf 违例：${JSON.stringify(r.errors)}`);
  }
  const allOfCases = [
    ['followup-expansion', 'emulate', { dsh: { api: 'agent.followup' } }, 'fallback'],
    ['source-widen-normalize', 'normalize', { dsh: { to: 'startup' } }, 'accepted'],
    ['failure-event-merge', 'normalize', { dsh: { into: 'PostToolUse' } }, 'synthesize'],
    ['stop-pending-relay', 'relay', { mcode: { store: 'PLUGIN_DATA', deliverOn: 'UserPromptSubmit', triggerEvent: 'Stop', burstCap: 3, pendingLimit: 20 } }, 'capNote'],
  ];
  for (const [id, strategy, params, missing] of allOfCases) {
    const r = validateRules({ rulesVersion: 2, rules: [{ id, strategy, title: 'x', trigger: { capability: 'toolName.vocabulary', gap: 'none' }, params, fidelity: 'lossy', sourceRef: ['内部决策-032'] }] }, MINI_MATRIX);
    assert.equal(r.ok, false, `${id} 缺 ${missing} 应判拒`);
    assert.ok(r.errors.some((e) => e.includes(`缺必需字段 ${missing}`)), `${id} 应报缺字段 ${missing}：${JSON.stringify(r.errors)}`);
  }
});

test('validateRules：stop-pending-relay anyOf 扩 relayEvents（内部决策-038 kimi 列契约）', () => {
  const mk = (params) => ({ rulesVersion: 2, rules: [{ id: 'stop-pending-relay', title: '中继', trigger: { capability: 'toolName.vocabulary', gap: 'none' }, strategy: 'relay', params, fidelity: 'degraded', sourceRef: ['内部决策-038'] }] });
  const KIMI_WIDE = { hosts: ['zcode', 'dsh', 'mcode', 'kimi'], capabilities: MINI_MATRIX.capabilities };
  // 正例：kimi 形态（store 为 $ 路径模板、relayEvents 替代 triggerEvent）过校验
  const kimiOk = mk({ kimi: { store: '$KIMI_CODE_HOME/plugin-data/<id>', deliverOn: 'UserPromptSubmit', relayEvents: ['Stop', 'SessionStart', 'PostToolUse', 'PostToolUseFailure'], burstCap: 3, pendingLimit: 20, capNote: '（上限降级）' } });
  assert.equal(validateRules(kimiOk, KIMI_WIDE).ok, true, JSON.stringify(validateRules(kimiOk, KIMI_WIDE).errors));
  // 负例：triggerEvent 与 relayEvents 全缺 → anyOf 违例
  const bothMissing = mk({ kimi: { store: '$HOME/x', deliverOn: 'UserPromptSubmit', burstCap: 3, pendingLimit: 20, capNote: 'n' } });
  const r1 = validateRules(bothMissing, KIMI_WIDE);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('至少需含 triggerEvent/relayEvents 之一')), JSON.stringify(r1.errors));
  // 负例：relayEvents 非 string[]（空数组/非数组）
  const badRelay = mk({ kimi: { store: '$HOME/x', deliverOn: 'UserPromptSubmit', relayEvents: [], burstCap: 3, pendingLimit: 20, capNote: 'n' } });
  const r2 = validateRules(badRelay, KIMI_WIDE);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('relayEvents')), JSON.stringify(r2.errors));
  // 负例：store 既非 PLUGIN_DATA 亦非 $ 路径模板（门禁位收窄仍 fail-closed）
  const badStore = mk({ kimi: { store: 'PLAIN_DIR', deliverOn: 'UserPromptSubmit', relayEvents: ['Stop'], burstCap: 3, pendingLimit: 20, capNote: 'n' } });
  const r3 = validateRules(badStore, KIMI_WIDE);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes('store')), JSON.stringify(r3.errors));
});

test('validateRules：早返回路径（顶层非对象 / rule 非对象 / trigger 缺失）不裸崩', () => {
  assert.equal(validateRules([], MINI_MATRIX).ok, false);
  assert.equal(validateRules(null, MINI_MATRIX).ok, false);
  const badRule = { rulesVersion: 2, rules: [null] };
  assert.equal(validateRules(badRule, MINI_MATRIX).ok, false);
  const noTrigger = { rulesVersion: 2, rules: [{ id: 'tool-vocab-map', strategy: 'map', params: { dsh: { direction: 'widen', table: { A: ['a'] } } }, fidelity: 'lossy', sourceRef: ['内部决策-032'] }] };
  const r = validateRules(noTrigger, MINI_MATRIX);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('trigger.capability')));
});

test('validateRules：fidelity 越枚举 / onTimeout 非枚举须判拒', () => {
  const bad = baseRules(); bad.rules[0].fidelity = 'perfect';
  assert.ok(validateRules(bad, MINI_MATRIX).errors.some((e) => e.includes('fidelity')));
  const degrade = { rulesVersion: 2, rules: [{ id: 'timeout-cap-fail-open', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: 'below-declared' }, strategy: 'degrade', params: { mcode: { cap: 'host-max', onTimeout: 'ignore' } }, fidelity: 'degraded', sourceRef: ['内部决策-034'] }] };
  assert.ok(validateRules(degrade, MINI_MATRIX).errors.some((e) => e.includes('onTimeout')));
});

// —— B 批（内部任务-5，R-pc-14/A-pc-11）：可选 displayName 校验（展示单源）——
// 为什么要有：displayName 是各插件唯一人工编辑展示源（四宿主适配只映射该值），schema 必须
// 收窄「出现即非空白字符串」——空串/空白/非字符串都是「公开槽位空值」，装前即红。
test('B：displayName 可选——缺省合法（strict-backward，无既有键语义变更）', () => {
  const root = tempRoot('val-b1');
  try {
    const r = validateManifest(setup(root, baseManifest()), 'demo');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  } finally { removeRoot(root); }
});

test('B：displayName 出现且非空白字符串 → 合法（真件同款取值）', () => {
  const root = tempRoot('val-b2');
  try {
    const r = validateManifest(setup(root, { ...baseManifest(), displayName: 'AI Coding 方法论 · 工作流' }), 'demo');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  } finally { removeRoot(root); }
});

test('B：displayName 空串/纯空白 → 拒', () => {
  for (const bad of ['', '   ', '\t']) {
    const root = tempRoot('val-b3');
    try {
      const r = validateManifest(setup(root, { ...baseManifest(), displayName: bad }), 'demo');
      assert.equal(r.ok, false, `空白形态 ${JSON.stringify(bad)} 应拒`);
      assert.ok(r.errors.some((e) => e.includes('displayName')), `错误须指名 displayName（实得 ${JSON.stringify(r.errors)}）`);
    } finally { removeRoot(root); }
  }
});

test('B：displayName 非字符串（数字/数组/对象）→ 拒', () => {
  for (const bad of [42, ['x'], { zh: 'x' }]) {
    const root = tempRoot('val-b4');
    try {
      const r = validateManifest(setup(root, { ...baseManifest(), displayName: bad }), 'demo');
      assert.equal(r.ok, false, `非字符串形态应拒`);
      assert.ok(r.errors.some((e) => e.includes('displayName')), `错误须指名 displayName（实得 ${JSON.stringify(r.errors)}）`);
    } finally { removeRoot(root); }
  }
});

test('validateRules：宿主集单源——params 键须在矩阵 hosts 内（禁 zcode 恒不参与）', () => {
  const bad = baseRules(); bad.rules[0].params = { zcode: { direction: 'widen', table: { Bash: ['bash'] } } };
  assert.ok(validateRules(bad, MINI_MATRIX).errors.some((e) => e.includes('恒不参与')));
  const bad2 = baseRules(); bad2.rules[0].params = { linux: { direction: 'widen', table: { Bash: ['bash'] } } };
  assert.ok(validateRules(bad2, MINI_MATRIX).errors.some((e) => e.includes('不在矩阵 hosts')));
  // 矩阵 hosts 扩列后，同一份数据自然放行（新增宿主=矩阵加列+params 加项）
  const wideMatrix = { hosts: ['zcode', 'dsh', 'mcode', 'linux'], capabilities: MINI_MATRIX.capabilities };
  assert.equal(validateRules(bad2, wideMatrix).ok, true, JSON.stringify(validateRules(bad2, wideMatrix).errors));
});

// ---- 内部任务-238 S2：占位符形态 / 解码态 lint / version SemVer / args containment / 跨字段不变式 ----

test('占位符形态：仅 ${PLUGIN_ROOT} 合法（大小写变体均拒）', () => {
  for (const bad of ['${plugin_root}/hooks/a.mjs', '${PluginRoot}/hooks/a.mjs']) {
    const root = tempRoot('val-ph');
    try {
      const m = baseManifest();
      m.hooks[0].args = [bad];
      const r = validateManifest(setup(root, m), 'demo');
      assert.equal(r.ok, false, `${bad} 应拒`);
      assert.ok(r.errors.some((e) => e.includes('占位符')), `错误须指认占位符（${bad}）：${JSON.stringify(r.errors)}`);
    } finally { removeRoot(root); }
  }
  const root = tempRoot('val-ph-ok');
  try {
    assert.equal(validateManifest(setup(root, baseManifest()), 'demo').ok, true, '合法 ${PLUGIN_ROOT} 须放行');
  } finally { removeRoot(root); }
});

test('中立性 lint：JSON 转义形态（解码态）与转义占位符均命中', () => {
  const root = tempRoot('val-esc');
  try {
    const raw = JSON.stringify({ ...baseManifest(), description: 'ZCode 演示' }, null, 2).replace('"ZCode 演示"', '"Z\\u0043ode 演示"');
    writeFile(root, 'demo/plugin.manifest.json', raw);
    writeFile(root, 'demo/hooks/a.mjs', '// stub\n');
    const r = validateManifest(root, 'demo');
    assert.equal(r.ok, false, '转义宿主词须被解码态 lint 拦下');
    assert.ok(r.errors.some((e) => e.includes('宿主专有名')), JSON.stringify(r.errors));
  } finally { removeRoot(root); }
  const root2 = tempRoot('val-esc-ph');
  try {
    const raw = JSON.stringify(baseManifest(), null, 2).replace('${PLUGIN_ROOT}', '\\u0024{plugin_root}');
    writeFile(root2, 'demo/plugin.manifest.json', raw);
    writeFile(root2, 'demo/hooks/a.mjs', '// stub\n');
    const r = validateManifest(root2, 'demo');
    assert.equal(r.ok, false, '转义占位符须被拦下');
    assert.ok(r.errors.some((e) => e.includes('占位符')), JSON.stringify(r.errors));
  } finally { removeRoot(root2); }
});

test('version：三段式 SemVer 强校验（非三段即拒）', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '../../x']) {
    const root = tempRoot('val-ver');
    try {
      const r = validateManifest(setup(root, { ...baseManifest(), version: bad }), 'demo');
      assert.equal(r.ok, false, `${bad} 应拒`);
      assert.ok(r.errors.some((e) => e.includes('version')), JSON.stringify(r.errors));
    } finally { removeRoot(root); }
  }
  const root = tempRoot('val-ver-ok');
  try {
    assert.equal(validateManifest(setup(root, { ...baseManifest(), version: '1.0.0' }), 'demo').ok, true);
  } finally { removeRoot(root); }
});

test('args containment：${PLUGIN_ROOT}/../ 越出插件根即拒（即使目标存在）', () => {
  const root = tempRoot('val-args');
  try {
    writeFile(root, 'outside.mjs', '// outside\n');
    const m = baseManifest();
    m.hooks[0].args = ['${PLUGIN_ROOT}/../outside.mjs'];
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('越出插件根')), JSON.stringify(r.errors));
  } finally { removeRoot(root); }
});

test('args containment：插件根内以 .. 开头的合法目录名不误判越界', () => {
  const root = tempRoot('val-args-dot');
  try {
    writeFile(root, 'demo/..data/a.mjs', '// inside plugin root\n');
    const m = baseManifest();
    m.hooks[0].args = ['${PLUGIN_ROOT}/..data/a.mjs'];
    const r = validateManifest(setup(root, m), 'demo');
    assert.equal(r.ok, true, `..data 属插件根内合法目录：${JSON.stringify(r.errors)}`);
  } finally { removeRoot(root); }
});

test('validateRules 跨字段不变式：to∈accepted / 秒数区间 / triggerEvent≠deliverOn', () => {
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const base = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
  const widen = structuredClone(base);
  widen.rules.find((r) => r.id === 'source-widen-normalize').params.dsh = { to: 'startup', accepted: ['resume'] };
  assert.ok(validateRules(widen, matrix).errors.some((e) => e.includes('accepted')), 'to∉accepted 须拒');
  for (const combo of [[5, 2, 1], [5, 2, 10], [2, 10, 5]]) {
    const timer = structuredClone(base);
    Object.assign(timer.rules.find((r) => r.id === 'timeout-cap-fail-open').params.mcode, { minSeconds: combo[0], maxSeconds: combo[2], defaultSeconds: combo[1] });
    assert.ok(validateRules(timer, matrix).errors.some((e) => e.includes('秒数区间须满足')), `秒数区间须拒：${combo.join('/')}`);
  }
  const boundary = structuredClone(base);
  Object.assign(boundary.rules.find((r) => r.id === 'timeout-cap-fail-open').params.mcode, { minSeconds: 2, maxSeconds: 2, defaultSeconds: 2 });
  assert.equal(validateRules(boundary, matrix).ok, true, 'min=default=max 边界合法');
  const relay = structuredClone(base);
  relay.rules.find((r) => r.id === 'stop-pending-relay').params.mcode.triggerEvent = 'UserPromptSubmit';
  assert.ok(validateRules(relay, matrix).errors.some((e) => e.includes('triggerEvent')), 'triggerEvent===deliverOn 须拒');
});

test('neutralPlaceholderHits：直测（合法 / 大小写变体 / 未闭合 / 转义形态）', () => {
  assert.deepEqual(neutralPlaceholderHits('{"a":"${PLUGIN_ROOT}"}'), []);
  assert.deepEqual(neutralPlaceholderHits('{"a":"${plugin_root}"}'), ['非中立占位符 ${plugin_root}'], '小写变体须恰命中 1 条（原文/解码态同消息去重）');
  assert.ok(neutralPlaceholderHits('{"a":"${PLUGIN_ROOT"').some((h) => h.includes('未闭合')), '原文未闭合须命中');
  assert.ok(neutralPlaceholderHits('{"a":"\\u0024{plugin_root}"}').some((h) => h.includes('JSON 转义占位符')), '转义占位符须按字面规则拒');
  assert.ok(neutralPlaceholderHits('{"a":"\\u0024{PLUGIN_ROOT}"}').some((h) => h.includes('JSON 转义占位符')), '转义形态的中立占位符同样拒（须字面书写）');
  assert.ok(neutralPlaceholderHits('{"a":"\\u0024{PLUGIN_ROOT"}').some((h) => h.includes('JSON 转义占位符')), '转义+未闭合亦须命中');
});

test('schema 拒绝分支：未知顶层键 / surfaces / hooks 条目形态各拒且可定位', () => {
  const cases = [
    ['未知顶层键', (m) => { m.displayname = 'x'; }, /未知顶层键/],
    ['surfaces 非对象', (m) => { m.surfaces = []; }, /surfaces 须为对象/],
    ['surfaces 未知键', (m) => { m.surfaces = { skills: [] }; }, /surfaces 未知键 skills/],
    ['surfaces.agents 非对象', (m) => { m.surfaces = { agents: 'x' }; }, /surfaces\.agents 须为对象/],
    ['hooks 条目非对象', (m) => { m.hooks = [null]; }, /hooks\[0\] 须为对象/],
    ['hook 未知键', (m) => { m.hooks[0].cwd = '/tmp'; }, /hooks\[0\] 未知键 cwd/],
    ['matcher 非字符串', (m) => { m.hooks[0].matcher = 1; }, /matcher 须为字符串/],
    ['statusMessage 非字符串', (m) => { m.hooks[0].statusMessage = 1; }, /statusMessage 须为字符串/],
  ];
  for (const [name, mutate, re] of cases) {
    const root = tempRoot('val-schema');
    try {
      const m = baseManifest();
      mutate(m);
      const r = validateManifest(setup(root, m), 'demo');
      assert.equal(r.ok, false, `${name} 应拒`);
      assert.ok(r.errors.some((e) => re.test(e)), `${name} 错误须定位：${JSON.stringify(r.errors)}`);
    } finally { removeRoot(root); }
  }
});
