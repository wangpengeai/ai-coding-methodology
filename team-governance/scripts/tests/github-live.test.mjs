// 文件：github-live.test.mjs
// 描述：github live-read/live-write 受控路径测试（D 计划步骤 16）——网络哨兵（测试期
//       任何真实 HTTP 请求即失败）、fake HTTP server、五前置逐项缺失拒绝、host allowlist。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { githubLiveRead, githubLiveWrite } from '../adapters/github-live.mjs';

// 网络哨兵：篡改全局 fetch——真实网络请求在此测试内是失败
const realFetch = globalThis.fetch;
test.beforeEach(() => {
  globalThis._networkAttempts = 0;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function sentinelFetch(impl) {
  globalThis.fetch = async (...args) => {
    globalThis._networkAttempts += 1;
    return impl(...args);
  };
}

test('live-read：host 不在允许列表 → unavailable 不发请求', async () => {
  sentinelFetch(() => { throw new Error('不应发请求'); });
  const r = await githubLiveRead({ path: 'http://evil.example.com/x' });
  assert.equal(r.availability, 'unavailable');
  assert.match(r.result.summary, /允许列表/);
  assert.equal(globalThis._networkAttempts, 0, '不发请求');
});

test('live-read：无 token → unavailable；有 token 走 fake fetch → passed', async () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const r0 = await githubLiveRead({ path: '/repos/o/r/pulls/1/reviews' });
  assert.equal(r0.availability, 'unavailable');
  assert.match(r0.result.summary, /GITHUB_TOKEN/);
  process.env.GITHUB_TOKEN = 'fake-token';
  sentinelFetch(async () => new Response(JSON.stringify([{ state: 'approved' }]), { status: 200 }));
  const r1 = await githubLiveRead({ path: '/repos/o/r/pulls/1/reviews' });
  assert.equal(r1.availability, 'available');
  assert.equal(r1.result.status, 'passed');
  assert.equal(r1.body[0].state, 'approved');
  assert.equal(globalThis._networkAttempts, 1);
  if (saved !== undefined) process.env.GITHUB_TOKEN = saved; else delete process.env.GITHUB_TOKEN;
});

test('live-read：网络失败 → unverified 不冒充；超限 → degraded', async () => {
  process.env.GITHUB_TOKEN = 'fake';
  sentinelFetch(async () => { throw new TypeError('fetch failed'); });
  const r = await githubLiveRead({ path: '/repos/o/r/x' });
  assert.equal(r.result.status, 'unverified');
  assert.match(r.result.summary, /不使用旧缓存/);
  const big = 'x'.repeat((1 << 20) + 10);
  sentinelFetch(async () => new Response(big, { status: 200,
    headers: { 'content-length': String(big.length) } }));
  const r2 = await githubLiveRead({ path: '/repos/o/r/x' });
  assert.equal(r2.availability, 'degraded');
  delete process.env.GITHUB_TOKEN;
});

test('live-write：五前置逐项缺失 → 拒绝（零网络）；齐备 → 执行且 externalEffects 显式', async () => {
  const base = {
    confirmSubject: 'sha256:' + 'a'.repeat(64), currentSubject: 'sha256:' + 'a'.repeat(64),
    policyAllows: true, hasApproval: true, envAuthorized: true,
    executor: async () => ({ ok: true, summary: 'check created' }),
    target: 'org/repo check governance', capability: 'ci',
  };
  const r1 = await githubLiveWrite({ ...base, confirmSubject: 'sha256:' + 'b'.repeat(64) });
  assert.equal(r1.result.status, 'unverified');
  assert.match(r1.result.summary, /不匹配/);
  for (const key of ['policyAllows', 'hasApproval', 'envAuthorized']) {
    const r = await githubLiveWrite({ ...base, [key]: false });
    assert.equal(r.result.status, 'unverified', `${key} 缺失应拒绝`);
  }
  const ok = await githubLiveWrite(base);
  assert.equal(ok.result.status, 'passed');
  assert.equal(ok.externalEffects.length, 1, '外部效果显式声明');
  assert.equal(ok.mode, 'live-write');
});
