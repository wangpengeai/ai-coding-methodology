// 文件：plan-mode-gate.test.mjs
// 描述：内部任务-272 内部未决-236 plan 模式门控用例（A-da-9 唯一标题用例 + 服务缺失/异常/无缓存）
// 作者：wangp  创建：2026-11-01  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlanModeGate } from '../src/plan-mode-gate.mjs';

function makeGate(opts = {}) {
  const infos = [];
  const gate = createPlanModeGate({
    readService: opts.readService ?? (() => ({ get: () => ({ active: false }) })),
    info: (m) => infos.push(m),
    sidOf: (agent) => agent?.session?.header?.id ?? '',
  });
  return { gate, infos };
}
const agent = (id = 's1') => ({ session: { header: { id } } });

test('DEV-272 plan 模式机械识别：协议与续跑让位：isEngaged 四组合', () => {
  assert.equal(makeGate().gate.isEngaged(agent()), false);
  assert.equal(makeGate({ readService: () => ({ get: () => ({ active: true }) }) }).gate.isEngaged(agent()), true);
  assert.equal(makeGate({ readService: () => ({ get: () => ({ active: false, pending: true }) }) }).gate.isEngaged(agent()), true);
  assert.equal(makeGate({ readService: () => ({ get: () => ({ active: true, pending: false }) }) }).gate.isEngaged(agent()), true);
});

test('DEV-272 plan 模式机械识别：服务缺失 fail-open（false，首次解析一次 info）', () => {
  const { gate, infos } = makeGate({ readService: () => undefined });
  assert.equal(gate.isEngaged(agent()), false);
  assert.equal(infos.length, 1, '服务缺失时首次解析恰一次 info');
  assert.match(String(infos[0]), /planMode 服务缺失/, 'info 须说明「宿主 planMode 服务缺失」');
});

test('DEV-272 plan 模式机械识别：get 抛错 fail-open 且每会话至多一次 info', () => {
  const infos = [];
  const gate = createPlanModeGate({ readService: () => ({ get: () => { throw new Error('projection missing'); } }), info: (m) => infos.push(m), sidOf: (a) => a.session.header.id });
  assert.equal(gate.isEngaged(agent('x')), false);
  assert.equal(gate.isEngaged(agent('x')), false);
  assert.equal(infos.filter((m) => m.includes('x')).length, 1, '每会话一次 info');
});

test('DEV-272 plan 模式机械识别：engaged 状态不缓存（miss 后命中即生效）', () => {
  let state = { active: false };
  const gate = makeGate({ readService: () => ({ get: () => state }) }).gate;
  assert.equal(gate.isEngaged(agent()), false);
  state = { active: true };
  assert.equal(gate.isEngaged(agent()), true);
});

test('DEV-272 plan 模式机械识别：get 非函数 fail-open', () => {
  const gate = makeGate({ readService: () => ({}) }).gate;
  assert.equal(gate.isEngaged(agent()), false);
});

test('DEV-272 plan 模式机械识别：空 sessionId 不写 info 记录', () => {
  const infos = [];
  const gate = createPlanModeGate({ readService: () => ({ get: () => { throw new Error('x'); } }), info: (m) => infos.push(m), sidOf: () => '' });
  assert.equal(gate.isEngaged({ session: { header: {} } }), false);
  assert.equal(infos.length, 0);
});
