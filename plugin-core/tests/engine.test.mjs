// 文件：规则引擎测试（A-pc-8/9）
// 描述：applyRule 分派 fail-closed 路径、装载面（坏 JSON/规则库校验拒载）、六族执行器语义
//       （map/normalize/emulate/degrade/relay/disable）与十条规则 × 四宿主全组合分派。
//       本文件同时充当批 2/3 接线等价用例的锚点集（门 B 正确性维 F1-F14 处置）。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/engine.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine, loadEngine } from '../src/engine.mjs';
import { validateRules, STRATEGIES, PARAM_RULE_FIELDS } from '../src/validate.mjs';
import { tempRoot, removeRoot, writeFile, REPO_ROOT } from './helpers.mjs';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadJson = (rel) => JSON.parse(readFileSync(join(CORE_ROOT, rel), 'utf8'));

/** 真实数据引擎（全组合测试钉现实）。 */
function realEngine() {
  return createEngine({ rules: loadJson('degradation-rules.json'), matrix: loadJson('capability-matrix.json') });
}

/** 内存端口桩（读写一对象；get() 供断言）。 */
function memPorts(initial = null) {
  let state = initial;
  return { readState: () => state, writeState: (s) => { state = s; }, get: () => state };
}

/** 带写盘计数的端口桩（「无变更不写盘」判别力）。 */
function spyPorts(initial = null) {
  let state = initial;
  let writes = 0;
  return {
    readState: () => state,
    writeState: (s) => { state = s; writes += 1; },
    get: () => state,
    writes: () => writes,
  };
}

/** 各族无端口桩集合（端口族在语义用例中以行为桩替换）。 */
const STUB_PORTS = {
  enqueue() {},
  readState() { return null; },
  writeState() {},
  listRestrictableTools() { return []; },
};

// ---- fail-closed 与装载面 ----

test('fail-closed：未知 ruleId 抛错且消息含 id', () => {
  const engine = realEngine();
  assert.throws(() => engine.applyRule('no-such-rule', 'dsh', {}, {}), /no-such-rule/);
});

test('fail-closed：trigger.capability 不在矩阵键集抛错且消息含键名', () => {
  const engine = createEngine({
    rules: { rulesVersion: 2, rules: [{ id: 'x', title: 'x', trigger: { capability: 'ghost.key', gap: false }, strategy: 'map', params: { dsh: { table: { A: ['a'] } } }, fidelity: 'lossy', sourceRef: ['ADR-001'] }] },
    matrix: { hosts: ['zcode', 'dsh', 'mcode'], capabilities: {} },
  });
  assert.throws(() => engine.applyRule('x', 'dsh', {}, {}), /ghost\.key/);
});

test('fail-closed：createEngine 入参形状校验（rulesVersion/capabilities/rules 形态）', () => {
  const matrix = loadJson('capability-matrix.json');
  const rules = loadJson('degradation-rules.json');
  assert.throws(() => createEngine({ rules: { rulesVersion: 1, rules: [] }, matrix }), /rulesVersion/);
  assert.throws(() => createEngine({ rules, matrix: { capabilities: null } }), /capabilities/);
  assert.throws(() => createEngine({ rules: { rulesVersion: 2, rules: 'x' }, matrix }), /rules\.rules/);
  assert.throws(() => createEngine({ rules: null, matrix }), /rules 须为对象/);
});

test('端口必填（表驱动）：缺端口即抛且消息含端口名与 ruleId/host', () => {
  const engine = realEngine();
  const cases = [
    ['followup-expansion', 'dsh', { body: 'b' }, {}, /enqueue/],
    ['stop-pending-relay', 'mcode', { event: 'Stop', text: 't', sessionKey: 's' }, { readState: () => null }, /writeState/],
    ['agent-default-off-fail-closed', 'dsh', { candidates: ['read'] }, {}, /listRestrictableTools/],
  ];
  for (const [ruleId, host, ctx, ports, re] of cases) {
    let message = '';
    try { engine.applyRule(ruleId, host, ctx, ports); } catch (e) { message = e.message; }
    assert.match(message, re, `${ruleId} 缺端口应抛错`);
    assert.ok(message.includes(`ruleId=${ruleId}`) && message.includes(`host=${host}`), `缺端口消息须双标识：${message}`);
  }
});

test('fail-closed：原型成员名作 ruleId 不得裸崩（消息须具名）', () => {
  const engine = realEngine();
  assert.throws(() => engine.applyRule('constructor', 'dsh', {}, STUB_PORTS), /constructor/);
  assert.throws(() => engine.applyRule('hasOwnProperty', 'dsh', {}, STUB_PORTS), /hasOwnProperty/);
});

test('loadEngine：真实仓根装载成功；坏 JSON 与不合契约规则库均拒载', () => {
  const engine = loadEngine(REPO_ROOT);
  assert.equal(typeof engine.applyRule, 'function');
  const root = tempRoot('eng-load');
  try {
    writeFile(root, 'plugin-core/degradation-rules.json', '{ bad json');
    writeFile(root, 'plugin-core/capability-matrix.json', JSON.stringify(loadJson('capability-matrix.json')));
    assert.throws(() => loadEngine(root), /degradation-rules\.json/);
  } finally { removeRoot(root); }
  const root2 = tempRoot('eng-load2');
  try {
    const badRules = loadJson('degradation-rules.json');
    badRules.rules[0].params.mcode = {}; // 空对象：不合契约
    writeFile(root2, 'plugin-core/degradation-rules.json', JSON.stringify(badRules));
    writeFile(root2, 'plugin-core/capability-matrix.json', JSON.stringify(loadJson('capability-matrix.json')));
    assert.throws(() => loadEngine(root2), /规则库校验失败/, '不合契约规则库须拒载（R-pc-12 装载期落点）');
  } finally { removeRoot(root2); }
});

test('applied=false：宿主无 params 条目（零降级宿主恒 false 的机检面）', () => {
  const engine = realEngine();
  for (const ruleId of ['followup-expansion', 'stop-pending-relay', 'tool-vocab-map', 'namespace-transform']) {
    const out = engine.applyRule(ruleId, 'zcode', {}, {});
    assert.equal(out.applied, false, `${ruleId}/零降级宿主 应 applied:false`);
  }
});

// ---- map 族 ----

test('tool-vocab-map：取宽展开、未知词原样、one-to-one 取首、边界输入全匹配', () => {
  const engine = realEngine();
  const dsh = (matcher) => engine.applyRule('tool-vocab-map', 'dsh', { matcher }, {}).result;
  assert.equal(dsh('Bash|Edit'), 'pwsh|bash|Bash|edit|str_replace_editor|Edit');
  assert.equal(dsh('Foo|Bash'), 'Foo|pwsh|bash|Bash');
  assert.equal(engine.applyRule('tool-vocab-map', 'mcode', { matcher: 'Bash|Edit' }, {}).result, 'bash|edit');
  // 边界：缺省/空串/'*'/全分隔符/非字符串 → undefined（全匹配，值域对齐 normalizeMatcher）
  for (const v of [undefined, '', '  ', '*', '|', 123, null, {}]) {
    assert.equal(dsh(v), undefined, `边界输入 ${JSON.stringify(v)} 应全匹配`);
  }
});

test('tool-vocab-map：one-to-one 取首个映射（direction 参与行为）', () => {
  const rules = loadJson('degradation-rules.json');
  const rule = rules.rules.find((r) => r.id === 'tool-vocab-map');
  rule.params.dsh = { direction: 'one-to-one', table: { Bash: ['pwsh', 'bash'] } };
  const engine = createEngine({ rules, matrix: loadJson('capability-matrix.json') });
  assert.equal(engine.applyRule('tool-vocab-map', 'dsh', { matcher: 'Bash' }, {}).result, 'pwsh');
});

test('namespace-transform：kebab 归一 + 前缀拼接 + 非法名返回空串', () => {
  const engine = realEngine();
  const t = (plugin, dirName) => engine.applyRule('namespace-transform', 'dsh', { plugin, dirName }, {}).result;
  assert.equal(t('spec-gate', 'gate'), 'spec-gate-gate');
  assert.equal(t('Spec Gate', 'Agent Eval'), 'spec-gate-agent-eval');
  assert.equal(t('spec-gate', '__'), '', '非法名（形态不合）返回空串交调用方 skip');
  assert.equal(t('spec-gate', ''), '', '空目录名返回空串');
});

test('message-slot-migration：dsh 读取序 / mcode 目标键已存在不覆盖', () => {
  const engine = realEngine();
  const dsh = (envelope) => engine.applyRule('message-slot-migration', 'dsh', { envelope }, {}).result;
  assert.equal(dsh({ permissionDecisionReason: 'a', systemMessage: 'b' }), 'a');
  assert.equal(dsh({ systemMessage: 'b' }), 'b');
  assert.equal(dsh({}), '');
  const mcode = engine.applyRule('message-slot-migration', 'mcode', { envelope: { systemMessage: 'x', keep: 1 } }, {}).result;
  assert.deepEqual(mcode, { permissionDecisionReason: 'x', keep: 1 });
  const both = engine.applyRule('message-slot-migration', 'mcode', { envelope: { systemMessage: 'x', permissionDecisionReason: 'y' } }, {}).result;
  assert.equal(both.permissionDecisionReason, 'y', '目标键已存在不覆盖（与既有 shim 的 ?? 语义等价）');
});

// ---- normalize 族 ----

test('source-widen-normalize：域内原样、域外归一取宽（判据集 = params.accepted）', () => {
  const engine = realEngine();
  const dsh = (source) => engine.applyRule('source-widen-normalize', 'dsh', { source }, {}).result;
  assert.equal(dsh('resume'), 'resume', '域内原样');
  assert.equal(dsh('fork'), 'startup', '域外归一取宽');
  assert.equal(dsh('agent/created'), 'startup', '域外归一取宽');
  const mcode = (source) => engine.applyRule('source-widen-normalize', 'mcode', { source }, {}).result;
  assert.equal(mcode('fork'), 'startup', '宿主自身词表含额外词，但判据集是下游 matcher 域');
  assert.equal(mcode('compact'), 'compact');
});

test('source-widen-normalize：两宿主判据集同域且即下游四词域（机检锚）', () => {
  const { rules } = loadJson('degradation-rules.json');
  const rule = rules.find((r) => r.id === 'source-widen-normalize');
  assert.deepEqual(rule.params.dsh.accepted, rule.params.mcode.accepted, '两宿主判据集须同域（同一下游 matcher 域）');
  assert.deepEqual(rule.params.dsh.accepted, ['startup', 'resume', 'clear', 'compact'], '判据集即下游 matcher 四词域');
});

test('failure-event-merge：synthesize 合成 + constants 常量位（stderr 恒空串）', () => {
  const engine = realEngine();
  const merge = (ctx) => engine.applyRule('failure-event-merge', 'dsh', ctx, {}).result;
  assert.deepEqual(merge({ isError: true, exitCode: 1, text: 'out' }), {
    into: 'PostToolUse',
    tool_result: { is_error: true, exit_code: 1, stdout: 'out', stderr: '' },
  });
  const ok = merge({ isError: false, text: 'ok' });
  assert.equal(ok.tool_result.is_error, false);
  assert.equal(Object.hasOwn(ok.tool_result, 'exit_code'), false, '非数值退出码不得产 exit_code 键');
  assert.equal(ok.tool_result.stderr, '', '常量位恒在');
  assert.equal(Object.hasOwn(merge({ isError: false, exitCode: Number.NaN }).tool_result, 'exit_code'), false, 'NaN 不产键');
});

// ---- emulate 族 ----

test('command-to-skill：同名承接（form 参与契约）', () => {
  const engine = realEngine();
  const out = engine.applyRule('command-to-skill', 'mcode', { commandName: 'feature-dev' }, {});
  assert.deepEqual(out.result, { skillName: 'feature-dev' });
});

test('followup-expansion：$ARGUMENTS 渲染（仅 trim 入参、正文原样）入队；startTurn=false 走回执不驱动', () => {
  const engine = realEngine();
  const enqueued = [];
  const out = engine.applyRule('followup-expansion', 'dsh', { body: 'do $ARGUMENTS now\n', rawInput: ' x ' }, { enqueue: (t) => enqueued.push(t) });
  assert.deepEqual(enqueued, ['do x now\n']);
  assert.deepEqual(out.result, { driven: true, body: 'do x now\n' });
  const off = engine.applyRule('followup-expansion', 'dsh', { body: 'do $ARGUMENTS', startTurn: false }, { enqueue: () => assert.fail('startTurn=false 不得驱动') });
  assert.deepEqual(off.result, { driven: false, body: 'do ' });
});

test('emulate 族：不支持的 form/api 取值 fail-closed', () => {
  const rules = loadJson('degradation-rules.json');
  rules.rules.find((r) => r.id === 'command-to-skill').params.mcode.form = 'other';
  const engine = createEngine({ rules, matrix: loadJson('capability-matrix.json') });
  assert.throws(() => engine.applyRule('command-to-skill', 'mcode', { commandName: 'x' }, {}), /form/);
});

// ---- degrade 族（两级派生：声明值→秒 夹取+宿主上限；秒→子进程预算 余量+下限） ----

test('timeout-cap-fail-open：六档派生（缺省/非法/下限/常规/上限夹取/封顶）', () => {
  const engine = realEngine();
  const cap = (declaredTimeoutMs) => engine.applyRule('timeout-cap-fail-open', 'mcode', { declaredTimeoutMs }, {}).result;
  assert.deepEqual(cap(undefined), { timeoutSeconds: 5, childBudgetMs: 4200, onTimeout: 'kill-fail-open-remind' }, '缺省 5s');
  assert.deepEqual(cap(null), { timeoutSeconds: 5, childBudgetMs: 4200, onTimeout: 'kill-fail-open-remind' }, '非法取缺省');
  assert.deepEqual(cap(0), { timeoutSeconds: 5, childBudgetMs: 4200, onTimeout: 'kill-fail-open-remind' }, '非正值取缺省');
  assert.deepEqual(cap(500), { timeoutSeconds: 1, childBudgetMs: 1000, onTimeout: 'kill-fail-open-remind' }, '下限夹取（1000-800=200 → 下限 1000）');
  assert.deepEqual(cap(5000), { timeoutSeconds: 5, childBudgetMs: 4200, onTimeout: 'kill-fail-open-remind' }, '常规档');
  assert.deepEqual(cap(60000), { timeoutSeconds: 10, childBudgetMs: 9200, onTimeout: 'kill-fail-open-remind' }, '宿主上限 10s 封顶 + 余量');
});

// ---- relay 族（连击仅计触发事件、未阻断清零、降级保正文、去重与容量） ----

test('stop-pending-relay：独立成帧 + deliverOn 投递后清空（未阻断 Stop 入队）', () => {
  const engine = realEngine();
  const ports = memPorts();
  const stop = (text) => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text, sessionKey: 's1', blocked: false }, ports);
  stop('A');
  stop('B');
  assert.equal(ports.get().frames.length, 2, '两帧须独立成帧（非拼接）');
  assert.deepEqual(ports.get().frames.map((f) => f.text), ['A', 'B']);
  for (const f of ports.get().frames) {
    assert.deepEqual(Object.keys(f).sort(), ['sessionKey', 'text', 'ts'], '帧含 {text,sessionKey,ts} 三键');
    assert.equal(typeof f.ts, 'number');
  }
  const drained = engine.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 's1' }, ports);
  assert.deepEqual(drained.result.delivered.map((f) => f.text), ['A', 'B']);
  assert.equal(ports.get().frames.length, 0, '投递后待投递面清空');
});

test('stop-pending-relay：deliverOn 按会话过滤（他会话帧保留待原会话）', () => {
  const engine = realEngine();
  const ports = memPorts();
  engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 'for-a', sessionKey: 'sess-a', blocked: false }, ports);
  engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 'for-b', sessionKey: 'sess-b', blocked: false }, ports);
  const drained = engine.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 'sess-a' }, ports);
  assert.deepEqual(drained.result.delivered.map((f) => f.text), ['for-a'], '只投本会话帧');
  assert.deepEqual(ports.get().frames.map((f) => f.text), ['for-b'], '他会话帧保留——投给当前会话即串话、丢弃即丢提醒');
});

test('stop-pending-relay：容量淘汰计数提醒（淘汰不静默吞，对齐 malformed 先例）', () => {
  const engine = realEngine();
  const ports = memPorts();
  for (let i = 0; i < 21; i += 1) {
    engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: `t${i}`, sessionKey: 's1', blocked: false }, ports);
  }
  assert.equal(ports.get().frames.length, 20, 'pendingLimit=20 封顶');
  const drained = engine.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 's1' }, ports);
  const texts = drained.result.delivered.map((f) => f.text);
  assert.ok(texts.includes('t20'), '最新帧在场');
  assert.ok(!texts.includes('t0'), '最旧帧被容量淘汰');
  assert.ok(texts.some((t) => t.includes('容量上限') && t.includes('1 条')), '投递附淘汰计数提醒');
  assert.equal(ports.get().droppedBySession['s:s1'], undefined, '提醒后计数清零（DEV-347 分账键删除）');
});

test('stop-pending-relay：阻断未超上限不入队（对齐既有 shim 门控）', () => {
  const engine = realEngine();
  const ports = memPorts();
  const out = engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 'reminder-1', sessionKey: 'sb', blocked: true }, ports);
  assert.deepEqual(out.result, { degraded: false, enqueued: false, streak: 1, text: 'reminder-1' });
  assert.equal(ports.get().frames.length, 0, '阻断直译路径不得入队（否则下一轮重复投递）');
});

test('stop-pending-relay：连击仅计阻断调用、未阻断不推进、换会话键重置', () => {
  const engine = realEngine();
  const ports = spyPorts();
  const call = (ctx) => engine.applyRule('stop-pending-relay', 'mcode', { sessionKey: 's2', ...ctx }, ports);
  assert.deepEqual(call({ event: 'PreToolUse', text: 'x' }).result, { enqueued: false, reason: 'event-not-relayed' });
  assert.equal(ports.writes(), 0, '非触发事件不写盘');
  assert.equal(ports.get(), null, '无状态变更时状态面不落盘');
  // 连续未阻断 Stop：不推进连击（也不清零）、可入队、上限永不触发
  for (let i = 0; i < 3; i += 1) {
    const out = call({ event: 'Stop', text: `n${i}`, blocked: false });
    assert.equal(out.result.degraded, false, '未阻断不得触发上限降级');
    assert.equal(out.result.streak, 0, '未阻断调用不推进连击');
  }
  // 连续阻断：连击 1..4，第 4 次降级
  const streaks = [];
  for (let i = 1; i <= 4; i += 1) {
    const out = call({ event: 'Stop', text: `b${i}`, blocked: true });
    streaks.push(out.result.streak);
    assert.equal(out.result.degraded, i === 4, `第 ${i} 次阻断的降级判定`);
  }
  assert.deepEqual(streaks, [1, 2, 3, 4], '只有阻断调用推进连击');
  // 换会话键即重置（单键对语义）
  const fresh = call({ event: 'Stop', text: 'z', sessionKey: 's2-other', blocked: true });
  assert.equal(fresh.result.streak, 1, '换会话键重置连击');
});

test('stop-pending-relay：三处理器声明序（两非阻断＋一阻断）下第 4 轮降级', () => {
  const engine = realEngine();
  const ports = memPorts();
  // kimi 列无 triggerEvent，shim 省略 ctx.event 即过执行器门控——此处同形态
  const call = (blocked, text) => engine.applyRule('stop-pending-relay', 'kimi', { sessionKey: 'seq', blocked, text }, ports);
  for (let turn = 1; turn <= 4; turn += 1) {
    const a = call(false, `task-recap-${turn}`);
    const b = call(false, `learnings-recap-${turn}`);
    const c = call(true, `verify-gate-${turn}`);
    assert.equal(a.result.streak, turn - 1, '非阻断处理器不推进连击');
    assert.equal(b.result.streak, turn - 1, '非阻断处理器不推进连击');
    assert.equal(c.result.streak, turn, '阻断处理器按轮推进连击');
    assert.equal(c.result.degraded, turn === 4, `第 ${turn} 轮的降级判定`);
  }
  const frames = ports.get().frames.map((f) => f.text).join('\n');
  assert.ok(frames.includes('连击上限'), '降级帧须带 capNote');
  assert.ok(frames.includes('verify-gate-4'), '降级帧须保留原正文');
});

test('stop-pending-relay：deliverOn 按会话重置连击预算', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = (ctx) => engine.applyRule('stop-pending-relay', 'mcode', { sessionKey: 'sd', ...ctx }, ports);
  call({ event: 'Stop', text: 'b1', blocked: true });
  call({ event: 'Stop', text: 'b2', blocked: true });
  assert.equal(ports.get().streaks['s:sd'], 2, '阻断调用推进连击（DEV-347 字典形态）');
  call({ event: 'UserPromptSubmit' });
  assert.equal(ports.get().streaks['s:sd'], undefined, '用户提示后连击预算归零（删键）');
  const after = call({ event: 'Stop', text: 'b3', blocked: true });
  assert.equal(after.result.streak, 1, '归零后重新计数');
});

test('stop-pending-relay：无状态变更的调用不写盘', () => {
  const engine = realEngine();
  const ports = spyPorts({ frames: [], streaks: {}, droppedBySession: {} });
  const call = (ctx) => engine.applyRule('stop-pending-relay', 'mcode', { sessionKey: 'sw', ...ctx }, ports);
  call({ event: 'Stop', text: '', blocked: false });
  assert.equal(ports.writes(), 0, '空文本非阻断 Stop 不写盘');
  call({ event: 'PreToolUse', text: 'x' });
  assert.equal(ports.writes(), 0, '非触发事件不写盘');
  call({ event: 'UserPromptSubmit' });
  assert.equal(ports.writes(), 0, '空队列投递不写盘');
  call({ event: 'Stop', text: '有文本', blocked: false });
  assert.equal(ports.writes(), 1, '入队须写盘');
});

test('stop-pending-relay：连续阻断超上限降级，且降级帧保留原正文', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = (text) => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text, sessionKey: 's3', blocked: true }, ports);
  call('第一'); call('第二'); call('第三');
  const fourth = call('第四');
  assert.equal(fourth.result.degraded, true, '第 4 次阻断须降级');
  assert.equal(fourth.result.enqueued, true, '降级帧须入待投递面');
  assert.equal(fourth.result.frame.text.includes('第四'), true, '降级帧不得丢原正文');
  assert.equal(fourth.result.frame.text.includes('连击上限'), true, '降级帧须带上限注记');
});

test('stop-pending-relay：原型成员名作会话键不得静默失效（门 B 终审 M2 回归）', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = () => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 't', sessionKey: '__proto__', blocked: true }, ports);
  const results = [call(), call(), call(), call()].map((o) => o.result);
  assert.deepEqual(results.map((r) => r.streak), [1, 2, 3, 4], '__proto__ 会话键须正常计数');
  assert.equal(results[3].degraded, true, '第 4 次超上限降级（防护不得对特定键失效）');
  assert.equal(ports.get().streaks['s:__proto__'], 4, 'DEV-347 s: 前缀字典形态');
  assert.equal(Object.hasOwn(ports.get().streaks, '__proto__'), false, '不得出现裸 __proto__ 自有键形态歧义');
});

test('stop-pending-relay：同会话同文本覆盖去重 + 容量上限 + 空文本不入队', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = (text) => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text, sessionKey: 's4', blocked: false }, ports);
  call('same'); call('same');
  assert.equal(ports.get().frames.length, 1, '同文本覆盖去重');
  assert.equal(call('').result.reason, 'empty-text');
  assert.equal(ports.get().frames.length, 1, '空文本不入队（不自造假坏帧）');
  assert.equal(call('   ').result.reason, 'empty-text', '纯空白视为空');
});

test('stop-pending-relay：容量上限（pendingLimit）丢最旧', () => {
  const rules = loadJson('degradation-rules.json');
  rules.rules.find((r) => r.id === 'stop-pending-relay').params.mcode.pendingLimit = 2;
  const engine = createEngine({ rules, matrix: loadJson('capability-matrix.json') });
  const ports = memPorts();
  const call = (text) => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text, sessionKey: 's5', blocked: false }, ports);
  call('a'); call('b'); call('c');
  assert.deepEqual(ports.get().frames.map((f) => f.text), ['b', 'c'], '超上限丢最旧');
});

test('fail-closed 门禁位（表驱动）：取值不受支持即抛错且消息可行动', () => {
  const cases = [
    ['command-to-skill', 'mcode', { commandName: 'x' }, {}, 'form', 'other'],
    ['followup-expansion', 'dsh', { body: 'b' }, { enqueue() {} }, 'api', 'other.api'],
    ['followup-expansion', 'dsh', { body: 'b' }, { enqueue() {} }, 'fallback', 'other-fallback'],
    ['agent-default-off-fail-closed', 'dsh', { candidates: [] }, { listRestrictableTools: () => ['read'] }, 'unknownTool', 'allow'],
    ['timeout-cap-fail-open', 'mcode', { declaredTimeoutMs: 1000 }, {}, 'cap', 'none'],
    ['stop-pending-relay', 'mcode', { event: 'Stop', text: 't', sessionKey: 's', blocked: false }, { readState: () => null, writeState() {} }, 'store', 'MEMORY'],
    ['stop-pending-relay', 'kimi', { event: 'Stop', text: 't', sessionKey: 's', blocked: false }, { readState: () => null, writeState() {} }, 'store', 'PLAIN_DIR'],
    ['namespace-transform', 'dsh', { plugin: 'p', dirName: 'd' }, {}, 'collision', 'last-wins'],
    ['namespace-transform', 'dsh', { plugin: 'p', dirName: 'd' }, {}, 'prefix', 'bogus'],
  ];
  for (const [ruleId, host, ctx, ports, field, badValue] of cases) {
    const rules = loadJson('degradation-rules.json');
    const rule = rules.rules.find((r) => r.id === ruleId);
    rule.params[host][field] = badValue;
    const engine = createEngine({ rules, matrix: loadJson('capability-matrix.json') });
    assert.throws(() => engine.applyRule(ruleId, host, ctx, ports), new RegExp(field), `${ruleId}.${field} 取值不受支持须抛错`);
  }
});

test('fail-closed：未知宿主 / params 条目非对象 / context=null 均具名报错或安全兜底', () => {
  const engine = realEngine();
  assert.throws(() => engine.applyRule('tool-vocab-map', 'typo-host', { matcher: 'Bash' }, {}), /typo-host/, '拼错的宿主须报错而非静默 applied:false');
  const rules = loadJson('degradation-rules.json');
  rules.rules.find((r) => r.id === 'tool-vocab-map').params.dsh = null;
  const engine2 = createEngine({ rules, matrix: loadJson('capability-matrix.json') });
  assert.throws(() => engine2.applyRule('tool-vocab-map', 'dsh', { matcher: 'Bash' }, {}), /params 条目/, 'params 条目非对象须具名报错');
  assert.doesNotThrow(() => engine.applyRule('tool-vocab-map', 'dsh', null, {}), 'context=null 由引擎兜底为 {}');
});

test('stop-pending-relay：坏帧丢弃 + 降级提醒（不静默吞）', () => {
  const engine = realEngine();
  const ports = memPorts({ frames: [{ text: 'ok', sessionKey: 's6', ts: 1 }, { bad: true }, { text: 'x', sessionKey: 's6', ts: 'no' }, { text: 'y', sessionKey: '', ts: 2 }], streak: {} });
  const out = engine.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 's6' }, ports);
  assert.equal(out.result.dropped, 3);
  assert.deepEqual(out.result.delivered.map((f) => f.text), ['ok', '[relay] 丢弃 3 条 malformed 待投递帧']);
});

test('stop-pending-relay：sessionKey 缺失即抛（不设缺省）', () => {
  const engine = realEngine();
  assert.throws(() => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 't' }, memPorts()), /sessionKey/);
});

test('stop-pending-relay：kimi $ 存储路径模板过 store 门禁（ADR-038；relayEvents 消费语义归实施批接线）', () => {
  const engine = realEngine();
  const ports = memPorts();
  // kimi hp 无 triggerEvent（以 relayEvents 声明被中继事件集）：当前执行器门控后按 event-not-relayed 放行，
  // 不断言 relayEvents 行为——其消费语义随 kimi 适配层实施批接线（内部模块-17 A-ka-2 锚点）。
  const out = engine.applyRule('stop-pending-relay', 'kimi', { event: 'Stop', text: 't', sessionKey: 'sk', blocked: false }, ports);
  assert.equal(out.applied, true);
  assert.deepEqual(out.result, { enqueued: false, reason: 'event-not-relayed' });
});

// ---- disable 族 ----

test('agent-default-off-fail-closed：交集过滤 + 目录不可得/空交集拒挂（fail-closed 极性）', () => {
  const engine = realEngine();
  const run = (candidates, directory) =>
    engine.applyRule('agent-default-off-fail-closed', 'dsh', { candidates }, { listRestrictableTools: () => directory }).result;
  assert.deepEqual(run(['read', 'glob', 'evil'], ['read', 'glob', 'grep']), { reject: false, defaultMount: false, allowedTools: ['read', 'glob'] });
  assert.equal(run(['read'], null).reject, true, '目录不可得 → 拒挂');
  assert.equal(run(['evil'], ['read']).reject, true, '交集为空 → 拒挂（不得退化成不过滤）');
  assert.equal(run([], []).reject, true, '空候选亦拒挂');
});

// ---- 步骤 9：全组合分派（A-pc-8） + 执行器覆盖清账 ----

test('全组合：10 规则 × 4 宿主 applied 形态（A-pc-8；ADR-038 批 kimi 列加入分派）', () => {
  const engine = realEngine();
  const { rules } = loadJson('degradation-rules.json');
  const HOSTS = ['zcode', 'dsh', 'mcode', 'kimi'];
  const ctx = { sessionKey: 's', event: 'Stop', text: 't', blocked: true, candidates: ['read'], matcher: 'Bash', source: 'startup', envelope: {}, body: 'b', rawInput: '', declaredTimeoutMs: 1000, commandName: 'x', plugin: 'p', dirName: 'd', isError: false };
  for (const rule of rules) {
    for (const host of HOSTS) {
      const out = engine.applyRule(rule.id, host, ctx, STUB_PORTS);
      const participates = Object.prototype.hasOwnProperty.call(rule.params, host);
      assert.equal(out.applied, participates, `${rule.id}/${host} applied 应为 ${participates}`);
      if (participates) {
        assert.equal(out.fidelity, rule.fidelity, `${rule.id}/${host} fidelity`);
        assert.notEqual(out.result, undefined, `${rule.id}/${host} 参与组合须有 result`);
      } else {
        assert.equal(out.result, undefined, `${rule.id}/${host} 未参与组合 result 须 undefined`);
      }
      if (host === 'zcode') assert.equal(out.applied, false, `${rule.id}/零降级宿主 恒 false`);
    }
  }
});

test('执行器覆盖清账：十条规则全部登记执行器（按规则最小上下文探测）', () => {
  const engine = realEngine();
  const { rules } = loadJson('degradation-rules.json');
  const CTX_BY_RULE = {
    'command-to-skill': { commandName: 'x' },
    'followup-expansion': { body: 'b' },
    'agent-default-off-fail-closed': { candidates: [] },
    'message-slot-migration': { envelope: {} },
    'failure-event-merge': {},
    'stop-pending-relay': { event: 'Stop', text: 't', sessionKey: 's' },
    'timeout-cap-fail-open': { declaredTimeoutMs: 1000 },
    'source-widen-normalize': { source: 'startup' },
    'tool-vocab-map': { matcher: 'Bash' },
    'namespace-transform': { plugin: 'p', dirName: 'd' },
  };
  for (const rule of rules) {
    const host = Object.keys(rule.params)[0];
    assert.doesNotThrow(() => engine.applyRule(rule.id, host, CTX_BY_RULE[rule.id], STUB_PORTS), `${rule.id} 执行器未登记或上下文不合`);
  }
});

test('params schema 负例逐族：六族各一坏值均被 validateRules 拒且错误含规则 id（A-pc-9 闭口，OPEN-199）', () => {
  const matrix = loadJson('capability-matrix.json');
  const base = loadJson('degradation-rules.json');
  const byStrategy = new Map();
  for (const rule of base.rules) if (!byStrategy.has(rule.strategy)) byStrategy.set(rule.strategy, rule);
  assert.equal(byStrategy.size, STRATEGIES.length, `规则库须覆盖全部策略族（实际 ${byStrategy.size}/${STRATEGIES.length}）`);
  for (const strategy of STRATEGIES) {
    const rule = byStrategy.get(strategy);
    assert.ok(rule, `策略族 ${strategy} 须有规则样本`);
    const fields = PARAM_RULE_FIELDS[rule.id];
    const host = Object.keys(rule.params).find((h) => h !== 'zcode');
    assert.ok(host, `规则 ${rule.id} 须有参与宿主`);
    const mutated = structuredClone(base);
    const target = mutated.rules.find((item) => item.id === rule.id);
    const required = (fields?.allOf ?? []).find((field) => Object.hasOwn(target.params[host], field));
    if (required) delete target.params[host][required];
    else target.params[host] = {};
    const report = validateRules(mutated, matrix);
    assert.equal(report.ok, false, `族 ${strategy}（${rule.id}）坏 params 须被拒`);
    const index = base.rules.indexOf(rule);
    assert.ok(
      report.errors.some((error) => error.includes(rule.id)),
      `族 ${strategy} 拒因须含规则 id（id=${rule.id} / rules[${index}]）：${report.errors.join(' | ')}`,
    );
  }
});

// ---- 内部任务-238 S1：引擎 fail-closed 守卫（createEngine 形状 / 分派顺序与消息 / params 契约 / degrade 矩阵门禁）----

test('fail-closed：createEngine 缺 matrix.hosts → 拒构造（宿主门禁不可得；含空数组）', () => {
  const rules = loadJson('degradation-rules.json');
  const matrix = loadJson('capability-matrix.json');
  assert.throws(
    () => createEngine({ rules, matrix: { capabilities: matrix.capabilities } }),
    /matrix\.hosts/,
    '缺 hosts 时不得静默放弃宿主门禁',
  );
  assert.throws(
    () => createEngine({ rules, matrix: { hosts: [], capabilities: matrix.capabilities } }),
    /matrix\.hosts/,
    '空 hosts 数组同样须拒（消息声称含空数组）',
  );
});

test('fail-closed：createEngine 规则表形状（重复 id / 非对象元素 / 非字符串 id）', () => {
  const matrix = loadJson('capability-matrix.json');
  const rules = loadJson('degradation-rules.json');
  const dup = structuredClone(rules);
  dup.rules.push(structuredClone(dup.rules[0]));
  assert.throws(() => createEngine({ rules: dup, matrix }), /重复 id/, '重复 id 须拒构造');
  assert.throws(() => createEngine({ rules: { rulesVersion: 2, rules: [null] }, matrix }), /rules\[0\]/, '非对象元素须具名拒');
  const noId = { rulesVersion: 2, rules: [{ title: 'x' }] };
  assert.throws(() => createEngine({ rules: noId, matrix }), /id/, '非字符串 id 须具名拒');
});

test('fail-closed：applyRule 入参形状守卫（ruleId/host 非空字符串）', () => {
  const engine = realEngine();
  assert.throws(() => engine.applyRule('', 'dsh', {}, {}), /ruleId 须为非空字符串/);
  assert.throws(() => engine.applyRule(42, 'dsh', {}, {}), /ruleId 须为非空字符串/);
  assert.throws(() => engine.applyRule('tool-vocab-map', 123, {}, {}), /host 须为非空字符串/);
});

test('fail-closed：分派顺序＝规则存在性先于宿主门（双错输入报未知规则，消息含 ruleId/host）', () => {
  const engine = realEngine();
  let message = '';
  try {
    engine.applyRule('no-such-rule', 'typo-host', {}, {});
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /未知规则/, `双错输入须先报未知规则：${message}`);
  assert.ok(message.includes('ruleId=no-such-rule'), `消息须含 ruleId：${message}`);
  assert.ok(message.includes('host=typo-host'), `消息须含 host：${message}`);
  assert.ok(message.includes('规则未登记'), `兼容判别串：DSH legacy（S8 前）降级闸依赖「规则未登记」子串：${message}`);
});

test('fail-closed：未知宿主 / 未登记执行器消息含 ruleId 与 host', () => {
  const engine = realEngine();
  let msg = '';
  try { engine.applyRule('tool-vocab-map', 'typo-host', { matcher: 'Bash' }, {}); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('ruleId=tool-vocab-map') && msg.includes('host=typo-host'), `未知宿主消息须双标识：${msg}`);
  const ghost = { rulesVersion: 2, rules: [{ id: 'ghost-rule', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: false }, strategy: 'map', params: { dsh: { note: 'x' } }, fidelity: 'lossy', sourceRef: ['ADR-001'] }] };
  const ghostEngine = createEngine({ rules: ghost, matrix: loadJson('capability-matrix.json') });
  try { ghostEngine.applyRule('ghost-rule', 'dsh', {}, {}); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('ruleId=ghost-rule') && msg.includes('host=dsh') && /未登记执行器/.test(msg), `未登记执行器消息须双标识：${msg}`);
});

test('分派顺序：宿主门先于 capability 键集 / params 形态先于端口必填', () => {
  const rules = loadJson('degradation-rules.json');
  const matrix = loadJson('capability-matrix.json');
  const noVocab = structuredClone(matrix);
  delete noVocab.capabilities['toolName.vocabulary'];
  const e1 = createEngine({ rules, matrix: noVocab });
  let msg = '';
  try { e1.applyRule('tool-vocab-map', 'typo-host', { matcher: 'Bash' }, {}); } catch (e) { msg = e.message; }
  assert.match(msg, /未知宿主/, `宿主门须先于 capability 键集：${msg}`);
  const emptyHp = structuredClone(rules);
  emptyHp.rules.find((r) => r.id === 'followup-expansion').params.dsh = {};
  const e2 = createEngine({ rules: emptyHp, matrix });
  msg = '';
  try { e2.applyRule('followup-expansion', 'dsh', { body: 'b' }, {}); } catch (e) { msg = e.message; }
  assert.match(msg, /params 条目须为非空对象/, `params 形态须先于端口必填：${msg}`);
});

test('fail-closed：params 契约（整段非对象 / 整段空对象 / 条目空对象）具名拒', () => {
  const matrix = loadJson('capability-matrix.json');
  const rules = loadJson('degradation-rules.json');
  const arrayParams = structuredClone(rules);
  arrayParams.rules.find((r) => r.id === 'tool-vocab-map').params = [];
  const e1 = createEngine({ rules: arrayParams, matrix });
  assert.throws(() => e1.applyRule('tool-vocab-map', 'dsh', { matcher: 'Bash' }, {}), /params 不合契约/);
  const emptyDoc = structuredClone(rules);
  emptyDoc.rules.find((r) => r.id === 'tool-vocab-map').params = {};
  const e2 = createEngine({ rules: emptyDoc, matrix });
  assert.throws(() => e2.applyRule('tool-vocab-map', 'dsh', { matcher: 'Bash' }, {}), /params 不合契约/, '整段空对象须 fail-closed，不得回落 applied:false');
  const emptyHp = structuredClone(rules);
  emptyHp.rules.find((r) => r.id === 'message-slot-migration').params.dsh = {};
  const e3 = createEngine({ rules: emptyHp, matrix });
  assert.throws(() => e3.applyRule('message-slot-migration', 'dsh', { envelope: {} }, {}), /params 条目须为非空对象/, '空对象条目须在分派期 fail-closed，不得 applied:true/result:undefined');
});

test('fail-closed：loadEngine 数据文件缺失 → 具名错含路径', () => {
  const root = tempRoot('eng-missing');
  try {
    assert.throws(
      () => loadEngine(root),
      (e) => e.message.includes('不可读') && e.message.includes(join('plugin-core', 'degradation-rules.json')),
      '缺数据文件须报不可读且消息含文件路径',
    );
  } finally { removeRoot(root); }
});

test('fail-closed：timeout-cap-fail-open 矩阵上限不可得 → 拒分派（不得静默不封顶；消息含 ruleId=/host=）', () => {
  const rules = loadJson('degradation-rules.json');
  const matrix = loadJson('capability-matrix.json');
  // 判别力：保留能力键（越过键集检查），仅把 mcode 列值置 null（cap=host-max 门禁位不可得）
  matrix.capabilities['hook.timeout.maxSeconds'].mcode = null;
  const engine = createEngine({ rules, matrix });
  let message = '';
  try {
    engine.applyRule('timeout-cap-fail-open', 'mcode', { declaredTimeoutMs: 60000 }, {});
  } catch (e) { message = e.message; }
  assert.match(message, /hook\.timeout\.maxSeconds/);
  assert.ok(message.includes('ruleId=timeout-cap-fail-open') && message.includes('host=mcode'), `执行器异常须带引擎前缀（IF-CORE-1 §4）：${message}`);
});

test('hasRule：只读查询登记态（消费方装载期漂移闸用）', () => {
  const engine = realEngine();
  assert.equal(engine.hasRule('tool-vocab-map'), true);
  assert.equal(engine.hasRule('no-such-rule'), false);
  assert.equal(engine.hasRule(''), false);
  assert.equal(engine.hasRule(42), false);
});

test('IF-CORE-1 §4 兼容判别串：逐串在真实错误消息中命中', () => {
  const matrix = loadJson('capability-matrix.json');
  const engine = realEngine();
  const messageOf = (fn) => {
    try { fn(); } catch (e) { return e.message; }
    return '';
  };
  const messages = [
    messageOf(() => engine.applyRule('no-such-rule', 'dsh', {}, {})),
    messageOf(() => engine.applyRule('tool-vocab-map', 'typo-host', { matcher: 'Bash' }, {})),
    messageOf(() => createEngine({
      rules: { rulesVersion: 2, rules: [{ id: 'ghost-cap', title: 'x', trigger: { capability: 'ghost.key', gap: false }, strategy: 'map', params: { dsh: { table: { A: ['a'] } } }, fidelity: 'lossy', sourceRef: ['ADR-001'] }] },
      matrix,
    }).applyRule('ghost-cap', 'dsh', {}, {})),
    messageOf(() => createEngine({
      rules: { rulesVersion: 2, rules: [{ id: 'ghost-params', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: false }, strategy: 'map', params: {}, fidelity: 'lossy', sourceRef: ['ADR-001'] }] },
      matrix,
    }).applyRule('ghost-params', 'dsh', {}, {})),
    messageOf(() => createEngine({
      rules: { rulesVersion: 2, rules: [{ id: 'ghost-empty', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: false }, strategy: 'map', params: { dsh: {} }, fidelity: 'lossy', sourceRef: ['ADR-001'] }] },
      matrix,
    }).applyRule('ghost-empty', 'dsh', {}, {})),
    messageOf(() => engine.applyRule('followup-expansion', 'dsh', { body: 'b' }, {})),
    messageOf(() => createEngine({
      rules: { rulesVersion: 2, rules: [{ id: 'ghost-exec', title: 'x', trigger: { capability: 'toolName.vocabulary', gap: false }, strategy: 'map', params: { dsh: { direction: 'widen', table: { A: ['a'] } } }, fidelity: 'lossy', sourceRef: ['ADR-001'] }] },
      matrix,
    }).applyRule('ghost-exec', 'dsh', {}, {})),
  ].join('\n');
  for (const s of ['未知规则（规则未登记）', '未知宿主（矩阵 hosts', '矩阵键集', 'params 不合契约', 'params 条目须为非空对象', '缺端口', '未登记执行器']) {
    assert.ok(messages.includes(s), `IF-CORE-1 §4 判别串须在实现消息中逐字命中：${s}`);
  }
});

// ── 内部任务-347 批 C（内部未决-274/277②）：淘汰分账＋多会话连击 ──

test('OPEN-277② 多会话连击：A 阻断 2 次→B 触发不清零 A→A 再阻断计 3 达 burstCap（s: 键前缀防原型键）', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = (sk, ctx) => engine.applyRule('stop-pending-relay', 'mcode', { sessionKey: sk, ...ctx }, ports);
  // A 阻断两次（不入队直译）
  assert.equal(call('sess-a', { event: 'Stop', text: 'a1', blocked: true }).result.streak, 1);
  assert.equal(call('sess-a', { event: 'Stop', text: 'a2', blocked: true }).result.streak, 2);
  // B 触发（未阻断）不得清零 A 的计数（现行单键对：换键即重置——红面）
  call('sess-b', { event: 'Stop', text: 'b1', blocked: false });
  const a3 = call('sess-a', { event: 'Stop', text: 'a3', blocked: true }).result;
  assert.equal(a3.streak, 3, 'A 的连击不受 B 触发影响（多会话字典）');
  assert.equal(a3.degraded, false, '第 3 次未超 burstCap=3（A 独立计数不因 B 交替清零而永不达上限）');
  const a4 = call('sess-a', { event: 'Stop', text: 'a4', blocked: true }).result;
  assert.equal(a4.streak, 4, '第 4 次推进');
  assert.equal(a4.degraded, true, '第 4 次超 burstCap=3 降级（A 独立计数下可达）');
  // deliverOn 只归零本会话键（B 投递不清 A）
  call('sess-b', { event: 'UserPromptSubmit' });
  const a5 = call('sess-a', { event: 'Stop', text: 'a5', blocked: true }).result;
  assert.equal(a5.streak, 5, 'B 投递归零不影响 A（按会话分键）');
});

test('OPEN-277② 原型键会话名不静默失效（__proto__/constructor 不得命中继承键）', () => {
  const engine = realEngine();
  const ports = memPorts();
  const call = (sk, blocked) => engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: `t-${sk}`, sessionKey: sk, blocked }, ports);
  assert.equal(call('__proto__', true).result.streak, 1, '__proto__ 会话计数正常推进');
  assert.equal(call('__proto__', true).result.streak, 2, '__proto__ 第二次推进（不得走原型 setter 静默丢）');
  assert.equal(call('constructor', true).result.streak, 1, 'constructor 会话计数独立（不得读继承函数 +1）');
  const state = ports.get();
  assert.equal(Object.hasOwn(state.streaks, '__proto__'), false, '字典不得出现裸 __proto__ 自有键（s: 前缀——读面 [`__proto__`] 命中继承原型属读取侧现象，写侧恒走前缀键）');
  assert.ok(Object.hasOwn(state.streaks, 's:__proto__'), 's: 前缀键在案');
});

test('OPEN-274 淘汰分账：A 帧被挤出→B 投递只报 B 自己的淘汰数（A 的不被吞）', () => {
  const engine = realEngine();
  // 先只放 A 的帧挤满容量（pendingLimit 实测取规则值）
  const rules = loadJson('degradation-rules.json');
  const hp = rules.rules.find((r) => r.id === 'stop-pending-relay').params.mcode;
  const limit = hp.pendingLimit;
  const portsA = memPorts();
  const eng = engine;
  for (let i = 0; i < limit; i += 1) {
    eng.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: `a-${i}`, sessionKey: 'sess-a', blocked: false }, portsA);
  }
  // A 再入一帧 → 最旧 A 帧被挤出（淘汰计入 A 键）
  eng.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 'a-new', sessionKey: 'sess-a', blocked: false }, portsA);
  // B 投递：B 自己零淘汰——不得吞 A 的淘汰计数（现行全局单值：B 投递把 A 的计数报给 B 并清零——红面）
  const outB = eng.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 'sess-b' }, portsA);
  const evictionNoteB = outB.result.delivered.filter((f) => f.text.includes('容量上限被淘汰'));
  assert.equal(evictionNoteB.length, 0, 'B 投递不得附 A 的淘汰提醒（分账）');
  // A 投递：A 收到自己的淘汰提醒
  const outA = eng.applyRule('stop-pending-relay', 'mcode', { event: 'UserPromptSubmit', sessionKey: 'sess-a' }, portsA);
  const evictionNoteA = outA.result.delivered.filter((f) => f.text.includes('容量上限被淘汰'));
  assert.equal(evictionNoteA.length, 1, 'A 投递收到自己的淘汰提醒（计数不静默）');
});

test('OPEN-277② 兼容：旧单键对状态首读迁移（streakKey/streakCount → streaks 字典）', () => {
  const engine = realEngine();
  const ports = memPorts({ frames: [], streakKey: 'old-sess', streakCount: 2, droppedByLimit: 1 });
  const out = engine.applyRule('stop-pending-relay', 'mcode', { event: 'Stop', text: 'next', sessionKey: 'old-sess', blocked: true }, ports);
  assert.equal(out.result.streak, 3, '旧计数续接（2→3）');
  const state = ports.get();
  assert.equal(state.streakKey, undefined, '旧字段迁移后删除');
  assert.equal(state.streaks['s:old-sess'], 3, '迁移入 s: 前缀字典');
});
