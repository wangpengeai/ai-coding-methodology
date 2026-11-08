// 文件：能力矩阵与降级规则库结构断言（A-pc-4/5）
// 描述：矩阵四列齐全/值类型封闭/开放键语义；规则库恰十条/枚举封闭/来源可解析；
//       kimi 列关键取值（内部决策-038 批：600/词表/relayEvents/不触发规则无 params.kimi）
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/matrix-rules.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAM_RULE_FIELDS, validateRules } from '../src/validate.mjs';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadMatrix() {
  return JSON.parse(readFileSync(join(CORE_ROOT, 'capability-matrix.json'), 'utf8'));
}

function loadRules() {
  return JSON.parse(readFileSync(join(CORE_ROOT, 'degradation-rules.json'), 'utf8'));
}

const ALLOWED_TYPES = ['boolean', 'number', 'string', 'null', 'string[]'];
const HOSTS = ['zcode', 'dsh', 'mcode', 'kimi'];
const EXPECTED_KEYS = [
  'surface.skills', 'surface.commands', 'surface.agents', 'surface.hooks',
  'hook.events', 'hook.declarationShape', 'hook.timeout.maxSeconds',
  'hook.envelope.systemMessage', 'hook.exitCode2.stdout', 'hook.stop.nonBlockingSlot',
  'command.promptExpansion', 'session.sources', 'toolName.vocabulary',
  'matcherVocabulary', 'hostToolInventory',
  'namespace.separator', 'pluginRoot.placeholder',
];

test('矩阵：版本与四宿主列', () => {
  const m = loadMatrix();
  assert.equal(m.matrixVersion, 1);
  assert.deepEqual(m.hosts, HOSTS);
});

test('矩阵：现行能力键快照（17 键含两物化消费键与两消歧键；新增键合法——见开放注册正例）', () => {
  const caps = loadMatrix().capabilities;
  for (const k of EXPECTED_KEYS) assert.ok(k in caps, `缺能力键 ${k}`);
  assert.equal(Object.keys(caps).length, EXPECTED_KEYS.length, `能力键数应为 ${EXPECTED_KEYS.length}`);
});

test('矩阵：能力键开放注册——新增键不破坏既有键', () => {
  const widened = structuredClone(loadMatrix());
  widened.capabilities['custom.surface'] = { type: 'boolean', zcode: true, dsh: true, mcode: true, kimi: true };
  const rules = {
    rulesVersion: 2,
    rules: [{
      id: 'tool-vocab-map', title: 'x', trigger: { capability: 'custom.surface', gap: false }, strategy: 'map',
      params: { dsh: { direction: 'widen', table: { A: ['a'] } } }, fidelity: 'lossy', sourceRef: ['ADR-037'],
    }],
  };
  const r = validateRules(rules, widened);
  assert.equal(r.ok, true, `新增能力键后规则应可装载：${JSON.stringify(r.errors)}`);
  for (const k of EXPECTED_KEYS) assert.ok(k in widened.capabilities, `既有键 ${k} 不得被破坏`);
});

test('矩阵：词表消歧两键——兼容镜像不变量 + inventory 语义（A-pc-10）', () => {
  // 本用例如实定位为「兼容镜像 + inventory 与 matcher 词表不同义」；matcher 词表的**外部锚**
  // 在跨包对拍面：ai-coding-methodology/tests/acceptance.test.mjs 的「中立数据面交叉核对」
  // 用例把矩阵 dsh 列与适配层 TOOL_ALIASES 展开集双向对拍（plugin-core 不引适配层，见门 A
  // 简洁性维发现 2 的处置：外部锚与兼容镜像断言分工，不重复造锚）。
  const caps = loadMatrix().capabilities;
  const oldRow = caps['toolName.vocabulary'];
  const matcherRow = caps.matcherVocabulary;
  const inventoryRow = caps.hostToolInventory;
  for (const h of HOSTS) {
    // 兼容镜像不变量：matcherVocabulary 继承旧键列值，两键不得分叉
    assert.deepEqual(matcherRow[h], oldRow[h], `matcherVocabulary.${h} 应等于 toolName.vocabulary.${h}`);
  }
  // inventory 与 matcher 词表语义不同：dsh 全集含只读工具 read 而 matcher 词表不含
  assert.ok(inventoryRow.dsh.includes('read'), 'hostToolInventory.dsh 应含 read（inventory 语义判据）');
  assert.ok(!matcherRow.dsh.includes('read'), 'matcherVocabulary.dsh 不应含 read（matcher 词表语义）');
  // zcode 列不得是 matcher 词表的同值重复（门 A 正确性维发现 2：全集应含 matcher 之外的宿主工具）
  assert.ok(inventoryRow.zcode.includes('Read'), 'hostToolInventory.zcode 应含 Read（全集语义，matcher 词表仅 Bash/Edit/Write）');
  assert.notDeepEqual(inventoryRow.zcode, matcherRow.zcode, 'hostToolInventory.zcode 不得等于 matcherVocabulary.zcode');
  // 内部任务-238 S6：note 与实际定位一致（兼容镜像 + 测试锚，不作策略输入）
  assert.ok(matcherRow.note.includes('兼容镜像'), `note 须写明兼容镜像定位：${matcherRow.note}`);
  assert.ok(matcherRow.note.includes('不作策略输入'), `note 须写明非策略输入：${matcherRow.note}`);
  assert.ok(!matcherRow.note.includes('消费方 = 期二批 2'), '过期「消费方=批 2 接线」承诺不得残留');
});

test('矩阵：每键含 type 与四列、值类型封闭', () => {
  const caps = loadMatrix().capabilities;
  for (const [key, row] of Object.entries(caps)) {
    const types = Array.isArray(row.type) ? row.type : [row.type];
    for (const t of types) assert.ok(ALLOWED_TYPES.includes(t), `${key} 类型 ${t} 越封闭集`);
    for (const h of HOSTS) {
      assert.ok(h in row, `${key} 缺 ${h} 列`);
      const v = row[h];
      const tv = v === null ? 'null' : Array.isArray(v) ? 'string[]' : typeof v;
      assert.ok(types.includes(tv), `${key}.${h} 值类型 ${tv} 不在声明集 ${types.join('|')}`);
      if (tv === 'string[]') for (const e of v) assert.equal(typeof e, 'string', `${key}.${h} 数组含非字符串`);
    }
  }
});

// 开放键语义说明（门 A 评审处置）：开放注册的机器保证在消费方式本身——消费方按键取值、
// 不遍历全键（validate.mjs loadEventVocabulary 只读 hook.events）——不存在可构造失败的
// 断言形态；原恒真用例已删（评审记录 code-review-内部创意-MULTIHOST-1-stage-a.md 发现 1）。

test('规则库：版本、恰十条、id 唯一且为预期清单', () => {
  const r = loadRules();
  assert.equal(r.rulesVersion, 2);
  assert.equal(r.rules.length, 10, `规则数应恰 10，实测 ${r.rules.length}`);
  const ids = r.rules.map((x) => x.id);
  assert.equal(new Set(ids).size, 10, 'id 须唯一');
  assert.deepEqual(new Set(ids), new Set([
    'command-to-skill', 'followup-expansion', 'agent-default-off-fail-closed', 'message-slot-migration',
    'failure-event-merge', 'stop-pending-relay', 'timeout-cap-fail-open', 'source-widen-normalize',
    'tool-vocab-map', 'namespace-transform',
  ]));
});

test('规则库：trigger.capability 在矩阵能力键集内、枚举封闭、来源可解析', () => {
  const caps = loadMatrix().capabilities;
  const strategies = ['emulate', 'degrade', 'relay', 'map', 'disable', 'normalize'];
  const fidelities = ['lossless', 'lossy', 'degraded'];
  for (const rule of loadRules().rules) {
    assert.ok(rule.trigger.capability in caps, `${rule.id} 的 trigger.capability 不在矩阵键集`);
    assert.ok(strategies.includes(rule.strategy), `${rule.id} strategy 越枚举`);
    assert.ok(fidelities.includes(rule.fidelity), `${rule.id} fidelity 越枚举`);
    assert.ok(Array.isArray(rule.sourceRef) && rule.sourceRef.length >= 1, `${rule.id} sourceRef 非空数组`);
    for (const ref of rule.sourceRef) assert.match(ref, /^ADR-\d+/, `${rule.id} 来源 ${ref} 不以 ADR-n 开头`);
  }
});

// params 机读化（内部决策-037/内部需求-7，v2）：per-host 对象、规则级字段 schema、宿主键禁 zcode
// （「零降级宿主恒 applied:false」的数据面机器形态）。字段 schema 为**单源**：直接消费
// validate.mjs 的导出（门 B 简洁性维发现 6 处置——消灭「同源双份」无把守的假绿面）。

test('规则库：params 机读化（v2——per-host、规则级字段 schema、zcode 禁键）', () => {
  for (const rule of loadRules().rules) {
    const params = rule.params;
    assert.ok(params && typeof params === 'object' && !Array.isArray(params), `${rule.id} params 非对象`);
    const hosts = Object.keys(params);
    assert.ok(hosts.length >= 1, `${rule.id} params 无宿主键`);
    const fields = PARAM_RULE_FIELDS[rule.id];
    assert.ok(fields, `${rule.id} 无字段 schema 登记`);
    for (const h of hosts) {
      assert.ok(['dsh', 'mcode', 'kimi'].includes(h), `${rule.id} params 含非法宿主键 ${h}（zcode 恒不参与）`);
      const hp = params[h];
      assert.ok(hp && typeof hp === 'object' && !Array.isArray(hp) && Object.keys(hp).length > 0, `${rule.id}.${h} 参数须为非空对象`);
      for (const f of fields.allOf ?? []) assert.ok(f in hp, `${rule.id}.${h} 缺必需字段 ${f}`);
      if (fields.anyOf) {
        assert.ok(fields.anyOf.some((f) => f in hp), `${rule.id}.${h} 至少需含 ${fields.anyOf.join('/')} 之一`);
      }
    }
  }
});

// ---- kimi 列关键取值（内部决策-038 批数据扩列的收敛断言；取值来源=设计文档 §6.1/§6.2 判定表）----

test('矩阵：kimi 列 17 键关键取值（ADR-038，A-pc-4 四列断言）', () => {
  const caps = loadMatrix().capabilities;
  assert.equal(caps['surface.commands'].kimi, true, 'kimi 命令面原生');
  assert.equal(caps['surface.agents'].kimi, 'optional', 'kimi agent 面可选（默认关是适配层策略）');
  assert.equal(caps['hook.timeout.maxSeconds'].kimi, 600, 'kimi 钩子时限上限 600 秒');
  assert.equal(caps['hook.declarationShape'].kimi, 'inline-manifest-array', 'kimi 声明形态新枚举');
  assert.equal(caps['hook.exitCode2.stdout'].kimi, 'deny-reason', 'kimi exit 2 新枚举');
  assert.equal(caps['hook.stop.nonBlockingSlot'].kimi, 'none', 'kimi 无 Stop 非阻断注入位');
  assert.equal(caps['command.promptExpansion'].kimi, 'native', 'kimi $ARGUMENTS 原生');
  assert.deepEqual(caps['session.sources'].kimi, ['startup', 'resume'], 'kimi SessionStart 来源词表');
  assert.deepEqual(caps['hook.events'].kimi, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'], 'kimi 六事件含原生 PostToolUseFailure');
  assert.deepEqual(caps['toolName.vocabulary'].kimi, ['Bash', 'Edit', 'Write'], 'kimi matcher 词表与 zcode 同型');
  assert.deepEqual(caps.matcherVocabulary.kimi, caps['toolName.vocabulary'].kimi, 'matcherVocabulary 兼容镜像');
  assert.equal(caps['namespace.separator'].kimi, ':', 'kimi 命名空间分隔符');
  assert.equal(caps['pluginRoot.placeholder'].kimi, null, 'kimi cwd=插件根，无占位符');
  assert.equal(caps.hostToolInventory.kimi.length, 24, 'kimi 工具全集 24 词（reference/tools.html 逐字）');
  for (const w of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'TodoList', 'FetchURL', 'Agent', 'CronDelete']) {
    assert.ok(caps.hostToolInventory.kimi.includes(w), `kimi 全集应含 ${w}`);
  }
  for (const absent of ['LS', 'TodoWrite', 'WebFetch', 'BashOutput']) {
    assert.ok(!caps.hostToolInventory.kimi.includes(absent), `kimi 全集不应含 ${absent}（四处空缺）`);
  }
});

test('规则库：kimi 判定表全录（4 触发含 relayEvents / 6 不触发无 params.kimi）', () => {
  const rules = loadRules().rules;
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  const triggered = ['agent-default-off-fail-closed', 'message-slot-migration', 'stop-pending-relay', 'source-widen-normalize'];
  const notTriggered = ['command-to-skill', 'followup-expansion', 'failure-event-merge', 'timeout-cap-fail-open', 'tool-vocab-map', 'namespace-transform'];
  for (const id of triggered) {
    assert.ok(byId[id].params.kimi, `${id} 应含 params.kimi（判定表触发）`);
    assert.ok(byId[id].sourceRef.some((ref) => ref.startsWith('ADR-038')), `${id} sourceRef 应含 ADR-038`);
  }
  for (const id of notTriggered) {
    assert.ok(!('kimi' in byId[id].params), `${id} 不应含 params.kimi（判定表不触发）`);
  }
  const relay = byId['stop-pending-relay'].params.kimi;
  assert.deepEqual(relay.relayEvents, ['Stop', 'SessionStart', 'PostToolUse', 'PostToolUseFailure'], 'kimi 列 relayEvents 四事件');
  assert.ok(relay.store.startsWith('$'), 'kimi 存储面为 $ 开头宿主路径模板');
  assert.equal(relay.deliverOn, 'UserPromptSubmit');
  assert.equal(relay.burstCap, 3);
  assert.equal(relay.pendingLimit, 20);
  assert.deepEqual(byId['source-widen-normalize'].params.kimi, { to: 'startup', accepted: ['startup', 'resume'] }, 'kimi 来源归一判据域');
  assert.deepEqual(byId['message-slot-migration'].params.kimi, { rename: { systemMessage: 'permissionDecisionReason' } }, 'kimi 文案位迁移同 mcode 形态');
  assert.deepEqual(byId['agent-default-off-fail-closed'].params.kimi, { defaultMount: false, unknownTool: 'reject' }, 'kimi agent 默认关 + 拒挂');
});
