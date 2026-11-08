// 文件：core.test.mjs
// 描述：team-governance 核心库 TDD（内部决策-012..015 / 内部模块-12-内部模块-13）——canonical/schema 子集/
//       redaction/RunManifest/Policy/ContextTrust/ChangeSet/CAS Lease/Approval。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, integrityHash } from '../lib/canonical-json.mjs';
import { validateAgainstSchema, SchemaError } from '../lib/json-schema.mjs';
import { redact, scanSecrets } from '../lib/redaction.mjs';
import { runBegin, runFinalize, loadManifest } from '../lib/run-manifest.mjs';
import { hostOf, HOST_ENV_PREFIXES } from '../lib/client-info.mjs';
import { preflight } from '../lib/policy.mjs';
import { registerContext, checkContexts } from '../lib/context-trust.mjs';
import { createChangeSet, changeSetDigest } from '../lib/change-set.mjs';
import { runCli } from './helpers.mjs';
import { acquireLease, renewLease, releaseLease, pathsOverlap } from '../lib/lease.mjs';
import { recordApproval, validateApproval } from '../lib/approval.mjs';
import { buildReport } from '../lib/governance-gate.mjs';
import { loadGovernanceConfig, computeBinding, collectGovernanceInputs, selectRequestedBy } from '../lib/governance-store.mjs';

function tmpProj() {
  const root = mkdtempSync(join(tmpdir(), 'tg-core-'));
  mkdirSync(join(root, '.ai-governance', 'runtime', 'runs'), { recursive: true });
  mkdirSync(join(root, '.ai-governance', 'runtime', 'leases'), { recursive: true });
  // 内部任务-5 C：check/gate/run-begin 走真实政策（store 读归一 config）——夹具播种内联 relaxed 政策
  writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    policy: { id: 'default', version: 1, riskLevel: 'medium',
      allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
    requiredDomains: [], createdAt: '2026-10-06T00:00:00.000Z',
  }, null, 2) + '\n', 'utf8');
  return root;
}

// ── canonical JSON（NFR-tg-integrity）──

test('canonical JSON：键排序/无空白/UTF-8；integrity 排除自身', () => {
  const a = canonicalJson({ b: 1, a: { d: [3, 2], c: 'x' } });
  const b = canonicalJson({ a: { c: 'x', d: [3, 2] }, b: 1 });
  assert.equal(a, b);
  assert.ok(!a.includes(' '));
  const h = integrityHash({ x: 1, integrityHash: 'sha256:zzz' });
  assert.ok(h.startsWith('sha256:'));
  assert.equal(h.length, 71);
});

// ── schema 子集（内部规则-2）──

test('schema 子集：支持关键字全过；未支持关键字响亮失败', () => {
  const schema = {
    type: 'object', required: ['id', 'status'],
    properties: { id: { type: 'string', pattern: '^R-\\d+$' }, status: { enum: ['a', 'b'] }, n: { type: 'integer', minimum: 0, maximum: 10 } },
    additionalProperties: false,
  };
  assert.deepEqual(validateAgainstSchema({ id: 'R-1', status: 'a', n: 3 }, schema), []);
  assert.ok(validateAgainstSchema({ id: 'X', status: 'a' }, schema).length > 0);
  assert.ok(validateAgainstSchema({ id: 'R-1' }, schema).length > 0);
  // 2026-10-29 内部任务-253：元关键字（$schema/title/description）被忽略，schema 工件可被直接消费
  assert.deepEqual(validateAgainstSchema({}, { $schema: 'http://x', type: 'object' }), []);
});

// 内部任务-253：受控子集严格化（内部接口-1 §4.1 / 内部规则-2）
test('json-schema：$ref 与数组 type 响亮失败', () => {
  assert.throws(() => validateAgainstSchema({}, { type: 'object', properties: { a: { $ref: '#/x' } } }), SchemaError);
  assert.throws(() => validateAgainstSchema('x', { type: ['string', 'null'] }), SchemaError);
});

test('json-schema：嵌套 additionalProperties 中的 $ref/数组 type 同样响亮失败', () => {
  assert.throws(() => validateAgainstSchema({}, { type: 'object', additionalProperties: { $ref: '#/x' } }), SchemaError);
  assert.throws(() => validateAgainstSchema({}, { type: 'object', additionalProperties: { type: ['string', 'null'] } }), SchemaError);
});

test('json-schema：oneOf 恰一支；anyOf 至少一支', () => {
  const oneOf = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validateAgainstSchema('a', oneOf), []);
  assert.ok(validateAgainstSchema(true, oneOf).length > 0, 'oneOf 全不中');
  const overlap = { oneOf: [{ type: 'string' }, { type: 'string', pattern: '^a$' }] };
  assert.ok(validateAgainstSchema('a', overlap).length > 0, 'oneOf 两支同中须拒（恰一支语义）');
  assert.deepEqual(validateAgainstSchema('abc', overlap), [], '仅一支命中可通过');
  const anyOf = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validateAgainstSchema(1, anyOf), []);
  assert.ok(validateAgainstSchema(true, anyOf).length > 0);
});

// ── redaction（内部规则-4）──

test('redaction：五类秘密模式命中并脱敏', () => {
  const bad = { note: 'token=abc123456 password=hunter2secret', aws: 'AKIAIOSFODNN7EXAMPLE', pem: '-----BEGIN RSA PRIVATE KEY-----', hdr: 'Authorization: Bearer abcdefgh12345678', tok: 'ghp_' + 'a'.repeat(30) };
  const hits = scanSecrets(bad);
  const joined = hits.join('|');
  for (const label of ['凭据键值对', 'AWS-AccessKey', '私钥块', '授权头', '裸令牌前缀']) {
    assert.ok(joined.includes(label), `五类须各命中（缺 ${label}）：${joined}`);
  }
  assert.ok(hits.length >= 5, `五类命中（收到：${joined}）`);
  const out = redact(bad);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter2secret') && !text.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('redaction：第五类裸令牌前缀命中（2026-09-19 评审修复——无键名载体的值形态）', () => {
  const bad = {
    ref: 'ghp_' + 'a'.repeat(30),                 // GitHub PAT（无键名载体）
    openai: 'sk-' + 'b'.repeat(24),               // OpenAI 系
    jwt: 'eyJ' + 'c'.repeat(12) + '.' + 'd'.repeat(12), // JWT 双段
  };
  const hits = scanSecrets(bad);
  assert.ok(hits.length >= 3, `三种裸令牌各命中：${hits.join(';')}`);
  const text = JSON.stringify(redact(bad));
  assert.ok(!text.includes('ghp_') && !text.includes('sk-bbbb') && !text.includes('eyJccc'),
    '裸令牌值不得原样落盘');
  // 负例：短随机串不误伤
  const clean = scanSecrets({ note: 'sk-abc 普通文本 skip123' });
  assert.equal(clean.length, 0, '短串不误报');
});

// ── Run Manifest（内部规则-4 / 内部需求-2/10）──

test('RunManifest：begin→finalize 不可变；unavailable 诚实；digest 失效', () => {
  const root = tmpProj();
  try {
    const run = runBegin(root, { taskId: '内部任务-1', initiator: 'wangp', agentRole: 'implementer',
      policyRef: 'p1@1', model: { observation: 'unavailable' } });
    assert.ok(run.runId);
    const fin = runFinalize(root, run.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'b'.repeat(64),
      evidenceRefs: ['ev-1'] });
    assert.equal(fin.status, 'finalized');
    assert.ok(fin.integrityHash.startsWith('sha256:'));
    assert.equal(fin.model.observation, 'unavailable', '模型不可观察必须显式 unavailable');
    const again = loadManifest(root, run.runId);
    assert.equal(again.integrityHash, fin.integrityHash);
    // S1 补断言（内部验收-1）：finalize 后 diff/policy 变化判失效——治理门复算 integrityHash
    const goodReport = buildReport({ manifests: [fin] });
    assert.equal(goodReport.blockingCount, 0, 'finalized manifest 未被改动 → 治理门零阻断');
    const tamperedManifest = { ...fin, diffDigest: 'sha256:' + 'c'.repeat(64) };
    const badReport = buildReport({ manifests: [tamperedManifest] });
    assert.ok(badReport.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-TAMPERED'),
      'finalize 后 diff 变化 → TG-MANIFEST-TAMPERED');
    assert.ok(badReport.blockingCount >= 1, '篡改须计入 blocking');
    // S6 简洁性维：verifyReport→tampered 面已有 governance-cli/eval-gate 既有覆盖，此处不重复断言；
    // A 行「policy 变化判失效」合取由 内部验收-1 覆盖（本文件既有用例），此处不重复断言。
    assert.throws(() => runFinalize(root, run.runId, { repoHead: 'c'.repeat(40), diffDigest: 'sha256:' + 'd'.repeat(64) }),
      /不可变|finalize/);
    // 2026-09-19 评审修复（安全面 N）：runId 形态校验——非法形态在拼路径前即拒
    assert.throws(
      () => runFinalize(root, '../../evil', { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'b'.repeat(64) }),
      /runId 非法/,
      '穿越形态 runId 必须在路径拼接前拒绝',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Policy preflight（内部规则-5 / 内部需求-3）──

test('Policy：strict 档模型不可观察 deny；relaxed 档 warning；fallback 权限更高判违例', () => {
  const strict = { riskLevel: 'high', allowedModels: [{ provider: 'x', capabilities: ['code'] }],
    fallbacks: [], enforcement: 'strict' };
  const r1 = preflight(strict, { modelObserved: null, requiredCapability: 'code' });
  assert.equal(r1.decision, 'deny', 'strict + 不可观察 = deny');
  const relaxed = { ...strict, enforcement: 'relaxed' };
  const r2 = preflight(relaxed, { modelObserved: null, requiredCapability: 'code' });
  assert.equal(r2.decision, 'warning');
  const fb = { ...strict, allowedModels: [{ provider: 'x', capabilities: ['code'] }],
    fallbacks: [{ provider: 'y', capabilities: ['code', 'admin'] }] };
  const r3 = preflight(fb, { modelObserved: { provider: 'y', capabilities: ['code', 'admin'] }, requiredCapability: 'code' });
  assert.equal(r3.decision, 'violation', 'fallback 权限高于主档判违例');
  const r4 = preflight(strict, { modelObserved: { provider: 'x', capabilities: ['code'] }, requiredCapability: 'code' });
  assert.equal(r4.decision, 'allow');
});

test('Policy：provider 不在允许集 → deny（relaxed 亦拒；多宿主默认政策防线，内部任务-2 回归钉）', () => {
  const p = { riskLevel: 'medium', allowedModels: [{ provider: 'x', capabilities: ['code'] }],
    fallbacks: [], enforcement: 'relaxed' };
  const r = preflight(p, { modelObserved: { provider: 'other', capabilities: ['code'] }, requiredCapability: 'code' });
  assert.equal(r.decision, 'deny', '未知 provider 不放行（deny 分支不看 enforcement 档位）');
  assert.match(r.reason, /不在允许集/);
});

// ── Context Trust（内部规则-6 / 内部需求-4）──

test('ContextTrust：untrusted 作 instruction 拒；无 digest 远程进高风险 run 拒', () => {
  const ctxs = [];
  registerContext(ctxs, { source: 'web:example.com/x', digest: 'sha256:' + 'a'.repeat(64), retrievedAt: '2026-09-13T00:00:00Z', trust: 'external-unverified' });
  const d1 = checkContexts(ctxs, { riskLevel: 'high' });
  assert.ok(d1.some((x) => /instruction/.test(x.message)), 'external-unverified 不得作 instruction');
  const ctxs2 = [];
  registerContext(ctxs2, { source: 'web:example.com/y', digest: null, retrievedAt: null, trust: 'external-verified' });
  const d2 = checkContexts(ctxs2, { riskLevel: 'high' });
  assert.ok(d2.some((x) => /digest/.test(x.message)), '高风险 run 无 digest 远程内容拒');
  const ctxs3 = [];
  registerContext(ctxs3, { source: '内部规格', digest: 'sha256:' + 'b'.repeat(64), retrievedAt: '2026-09-13T00:00:00Z', trust: 'repository' });
  assert.deepEqual(checkContexts(ctxs3, { riskLevel: 'high' }), [], 'repository 上下文合法');
});

// ── Change Set（内部规则-1）──

test('ChangeSet：digest 稳定且字段变化即变', () => {
  const cs = createChangeSet({ repos: [{ repoId: 'main', base: 'a'.repeat(40), head: 'b'.repeat(40) }],
    resources: ['repo:main', 'path:main:src/**'] });
  const d1 = changeSetDigest(cs);
  const d2 = changeSetDigest(createChangeSet({ repos: cs.repos, resources: cs.resources }));
  assert.equal(d1, d2);
  const d3 = changeSetDigest(createChangeSet({ repos: [{ ...cs.repos[0], head: 'c'.repeat(40) }], resources: cs.resources }));
  assert.notEqual(d1, d3);
});

// ── CAS Lease（内部规则-2）──

test('Lease：状态损坏拒绝读改写（2026-09-19 评审修复 H5——损坏≠空态，文件字节不变）', () => {
  const root = tmpProj();
  try {
    const hold = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a' });
    assert.ok(hold.ok, '先持一把租约');
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const corrupt = '{"schemaVersion": "1.0.0", "revision": 3, "leases":'; // 截断 JSON
    writeFileSync(stateFile, corrupt, 'utf8');
    assert.throws(
      () => acquireLease(root, { resource: 'path:main:docs/**', holder: 'run-b' }),
      /损坏/,
      '损坏态上 acquire 必须抛错（不得静默当空态覆盖写）',
    );
    assert.equal(readFileSync(stateFile, 'utf8'), corrupt, '损坏文件字节不变（存量租约与 fencing 不被销毁）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Lease：并发单胜/stale renew 拒/过期重取/父子互斥兄弟放行', () => {
  const root = tmpProj();
  try {
    const l1 = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a', changeSetId: 'cs1' });
    assert.ok(l1.ok, l1.error);
    assert.equal(l1.lease.fencingToken, 1);
    const l2 = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-b', changeSetId: 'cs2' });
    assert.equal(l2.ok, false, '同资源并发必须单胜');
    const r1 = renewLease(root, { leaseId: l1.lease.leaseId, revision: l1.lease.revision - 1 });
    assert.equal(r1.ok, false, 'stale revision 拒');
    const child = acquireLease(root, { resource: 'path:main:src/lib/**', holder: 'run-c' });
    assert.equal(child.ok, false, '父锁持有中子路径互斥');
    const sibling = acquireLease(root, { resource: 'path:main:docs/**', holder: 'run-d' });
    assert.equal(sibling.ok, true, '兄弟路径放行');
    const rel = releaseLease(root, { leaseId: l1.lease.leaseId, revision: l1.lease.revision });
    assert.ok(rel.ok);
    const again = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-e' });
    assert.ok(again.ok);
    assert.equal(again.lease.fencingToken, 2, 'fencing token 单调递增');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Lease：多仓 partial acquire 补偿释放', () => {
  const root = tmpProj();
  try {
    const hold = acquireLease(root, { resource: 'repo:second', holder: 'run-x' });
    assert.ok(hold.ok);
    const r = acquireLease(root, { resources: ['repo:main', 'repo:second'], holder: 'run-y', allOrNothing: true });
    assert.equal(r.ok, false, '第二仓被占应整体失败');
    assert.equal(r.released.length, 1, '已获租约补偿释放');
    assert.equal(r.released[0], 'repo:main');
    const check = acquireLease(root, { resource: 'repo:main', holder: 'run-z' });
    assert.ok(check.ok, '补偿释放后 main 可得');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pathsOverlap：父子判定', () => {
  assert.ok(pathsOverlap('path:main:src/**', 'path:main:src/lib/**'));
  assert.ok(pathsOverlap('path:main:src/lib/**', 'path:main:src/**'));
  assert.ok(!pathsOverlap('path:main:src/**', 'path:main:docs/**'));
  assert.ok(!pathsOverlap('repo:main', 'repo:second'));
  assert.ok(pathsOverlap('repo:main', 'path:main:src/**'));
});

// 内部任务-252 批 1a（C2）：过期 holder 旧 token 写入拒绝（内部规则-2 / 内部接口-15 §2、§4）
test('Lease：过期后 renew 拒（不可复活）且过期后重取单胜', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a' });
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.leases[a.lease.leaseId].expiresAt = Date.now() - 1000;
    writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n');
    const b = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-b' });
    assert.ok(b.ok, '过期不构成冲突：他人可重取');
    const beforeRenew = readFileSync(stateFile, 'utf8');
    const renew = renewLease(root, { leaseId: a.lease.leaseId, revision: a.lease.revision });
    assert.equal(renew.ok, false, '过期 holder 旧 token 写入必须被拒（内部规则-2）');
    assert.match(String(renew.error), /过期/);
    assert.equal(readFileSync(stateFile, 'utf8'), beforeRenew, '拒绝路径不得改写台账');
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    const live = Object.values(after.leases).filter(
      (l) => l.state === 'held' && l.expiresAt >= Date.now() && l.resource === 'path:main:src/**');
    assert.equal(live.length, 1, '同资源同时至多一个有效 holder（内部接口-15 §3）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 批 1a（C2）：合法期内续租成功（守卫不得误杀正常路径；无同毫秒 flake）
test('Lease：合法期内 renew 成功（expiresAt 不倒退/revision 递增/fencingToken 不变）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:docs/**', holder: 'run-a' });
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const t0 = JSON.parse(readFileSync(stateFile, 'utf8')).leases[a.lease.leaseId];
    const r = renewLease(root, { leaseId: a.lease.leaseId, revision: t0.revision });
    assert.equal(r.ok, true, '未过期续租必须成功（守卫不得误杀正常路径）');
    const t1 = JSON.parse(readFileSync(stateFile, 'utf8')).leases[a.lease.leaseId];
    assert.ok(t1.expiresAt >= t0.expiresAt, 'expiresAt 不倒退（同毫秒合法）');
    assert.ok(t1.expiresAt >= Date.now(), '续租后仍在新有效期内');
    assert.equal(t1.revision, t0.revision + 1, 'revision 恰 +1（CAS 语义）');
    assert.equal(t1.fencingToken, t0.fencingToken, 'fencingToken 不变（同一 holder 续租）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 批 1a（C2）：过期记录保留 release 清理通道（不自动终态；回归锁）
test('Lease：过期记录保留 release 清理通道（不自动终态）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a' });
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.leases[a.lease.leaseId].expiresAt = Date.now() - 1000;
    writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n');
    const rel = releaseLease(root, { leaseId: a.lease.leaseId, revision: a.lease.revision });
    assert.equal(rel.ok, true, '过期记录允许 release（审计清理通道；内部规则-2 的写入拒绝面＝renew）');
    const after = JSON.parse(readFileSync(stateFile, 'utf8')).leases[a.lease.leaseId];
    assert.equal(after.state, 'released', '过期记录经 release 进入终态');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 评审修复：expiresAt 不可判定（非数值）时 fail-closed 拒绝续租（不得 NaN 比较 fail-open 复活）
test('Lease：expiresAt 非数值时拒绝续租（不可判定不 fail-open）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a' });
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.leases[a.lease.leaseId].expiresAt = 'abc';
    writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n');
    const beforeRenew = readFileSync(stateFile, 'utf8');
    const renew = renewLease(root, { leaseId: a.lease.leaseId, revision: a.lease.revision });
    assert.equal(renew.ok, false, 'expiresAt 不可判定必须拒绝续租（NaN 比较会 fail-open）');
    assert.match(String(renew.error), /不可判定/);
    assert.equal(readFileSync(stateFile, 'utf8'), beforeRenew, '拒绝路径不得改写台账');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 评审修复：lib 直调（不经 CLI）也要归一 padded resource，并让同键冲突可见
test('Lease：lib 直调 padded resource 归一写入且冲突可见（双侧归一非仅 CLI）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: ' path:main:src/**', holder: 'run-a' });
    assert.ok(a.ok);
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(Object.values(st.leases).find((l) => l.leaseId === a.lease.leaseId).resource, 'path:main:src/**',
      'lib 层写入前归一（台账不得出现前导空格死键）');
    const b = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-b' });
    assert.equal(b.ok, false, '归一后同一资源再次 acquire 必须冲突（mutual exclusion 不因 padded 输入失效）');
    const list = acquireLease(root, { resources: [' path:main:docs/** ', 'path:main:tests/**'], holder: 'run-c' });
    assert.ok(list.ok);
    const st2 = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.values(st2.leases).filter((l) => l.holder === 'run-c').map((l) => l.resource).sort(),
      ['path:main:docs/**', 'path:main:tests/**'], '资源数组逐元素归一');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 评审修复：存量 padded 记录读侧归一（旧公共 API 产物不得让新归一 acquire 双持有）
test('Lease：存量 padded 记录读侧归一（legacy 死键不再绕过冲突判定）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:src/**', holder: 'legacy' });
    assert.ok(a.ok);
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.leases[a.lease.leaseId].resource = ' path:main:src/**'; // 模拟旧版本写入的 padded 键
    writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n');
    const b = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-b' });
    assert.equal(b.ok, false, '读侧归一后 legacy padded 记录仍构成冲突（不得并存双持有）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-252 批 1a（C3）：lib 层参数错双保险（四例矩阵覆盖防御分支）
test('acquireLease：resource/resources 缺失或非法一律参数错（lib 双保险）', () => {
  const root = tmpProj();
  try {
    assert.throws(() => acquireLease(root, { holder: 'x' }), /resource/);
    assert.throws(() => acquireLease(root, { resources: [], holder: 'x' }), /resource/);
    assert.throws(() => acquireLease(root, { resources: 'x', holder: 'x' }), /resource/);
    assert.throws(() => acquireLease(root, { resource: 42, holder: 'x' }), /resource/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Approval（内部规则-3）──

test('Approval：自批拒/未验证 strict 拒/digest 变失效/过期失效/条件≠通过', () => {
  const subject = { changeSetDigest: 'sha256:' + 'a'.repeat(64), policyDigest: 'sha256:' + 'b'.repeat(64) };
  // subject 锚 = changeSet digest（内部接口-16：对象组合的规范锚）
  const base = { subjectDigest: subject.changeSetDigest, role: 'accountable',
    identity: { source: 'local', verified: false, id: 'wangp' }, decidedAt: '2026-09-13', expiresAt: '2099-01-01' };
  const selfExec = recordApproval({ ...base, requestedBy: 'wangp' }, { executor: 'wangp', highRisk: true });
  assert.equal(selfExec.ok, false, '高风险自批拒');
  const strict = validateApproval({ ...base, identity: { source: 'local', verified: false, id: 'wangp' } },
    { ...subject, policy: 'strict', highRisk: true, requestedBy: 'other' });
  assert.equal(strict.ok, false, 'strict 拒未验证身份');
  // 2026-09-19 评审修复 H1：白名单四源各补一条 strict 通过断言——原 ' oidc' 前导空格使
  // oidc 源永拒，测试只测 github-review 分支掩盖了该断裂
  for (const src of ['github-review', 'sso', 'oidc', 'ci-signed']) {
    const pass = validateApproval(
      { ...base, identity: { source: src, verified: true, id: 'u1' } },
      { ...subject, policy: 'strict', highRisk: true, requestedBy: 'other' },
    );
    assert.equal(pass.ok, true, `strict 白名单源 ${src} 须通过`);
  }
  const loose = validateApproval({ ...base, identity: { source: 'local', verified: true, id: 'wangp' } },
    { ...subject, policy: 'relaxed', highRisk: false, requestedBy: 'other' });
  assert.equal(loose.ok, true);
  const stale = validateApproval({ ...base, identity: { source: 'local', verified: true, id: 'w' } },
    { changeSetDigest: 'sha256:' + 'c'.repeat(64), policyDigest: 'sha256:' + 'b'.repeat(64), policy: 'relaxed', requestedBy: 'o' });
  assert.equal(stale.ok, false, '对象 digest 变化即失效');
  const expired = validateApproval({ ...base, identity: { source: 'l', verified: true, id: 'w' }, expiresAt: '2020-01-01' },
    { ...subject, policy: 'relaxed', requestedBy: 'o' });
  assert.equal(expired.ok, false, '过期失效');
  const cond = validateApproval({ ...base, identity: { source: 'l', verified: true, id: 'w' }, conditions: ['补一轮测试'] },
    { ...subject, policy: 'relaxed', requestedBy: 'o' });
  assert.equal(cond.ok, false, '条件批准不等于通过');
  // S1 补断言（内部验收-2）：撤销失效（approval.mjs revocation 分支）
  const revoked = validateApproval(
    { ...base, identity: { source: 'local', verified: true, id: 'w' }, revocation: { revokedAt: '2026-09-14', reason: '撤销' } },
    { ...subject, policy: 'relaxed', requestedBy: 'o' });
  assert.equal(revoked.ok, false, '撤销失效');
  assert.equal(revoked.reason, 'revoked', '拒因须为 revoked');
});

// ── CLI 子进程面（2026-09-19 评审修复 PHASE2 门 #3：lease 损坏/gate 坏件/runId 校验/统一收口）──

const CLI = fileURLToPath(new URL('../governance-cli.mjs', import.meta.url));
const AGENT_EVAL = fileURLToPath(new URL('../agent-eval.mjs', import.meta.url));

// 内部任务-337（内部未决-223）：runCli 收口至 tests/helpers.mjs（返回含 json 超集，既有断言只读 status/stdout/stderr）。

test('CLI lease：损坏状态退 2 + stderr 点名（不静默销毁存量租约）', () => {
  const root = tmpProj();
  try {
    const hold = acquireLease(root, { resource: 'path:main:src/**', holder: 'run-a' });
    assert.ok(hold.ok, '先持一把');
    writeFileSync(join(root, '.ai-governance', 'runtime', 'leases', 'leases.json'), '{"broken":', 'utf8');
    const r = runCli(CLI, root, ['lease', 'acquire', '--resource', 'path:main:docs/**', '--holder', 'run-b']);
    assert.equal(r.status, 2, `损坏态=工具错误退 2（实测 ${r.status}）`);
    assert.ok(r.stderr.includes('损坏'), 'stderr 点名损坏');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI gate：好坏混合退 1 且报告点名坏件；空目录 passed 退 0（回归）', () => {
  const root = tmpProj();
  const empty = tmpProj();
  try {
    const run = runBegin(root, { taskId: 'T-1' });
    const fin = runFinalize(root, run.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'b'.repeat(64) });
    assert.equal(fin.status, 'finalized');
    writeFileSync(join(root, '.ai-governance', 'runtime', 'runs', 'run-bad00000-000.json'), 'not-json {{{', 'utf8');
    const r = runCli(CLI, root, ['gate']);
    assert.equal(r.status, 1, '坏件即 blocking 退 1');
    const report = JSON.parse(readFileSync(join(root, '.ai-governance', 'runtime', 'reports', 'governance-report.json'), 'utf8'));
    assert.ok(
      report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-UNREADABLE' && d.message.includes('run-bad00000-000.json')),
      '报告按名点名坏件（不吞集）',
    );
    const ok = runCli(CLI, empty, ['gate']);
    assert.equal(ok.status, 0, '空 runs 目录 passed 退 0（回归）');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('CLI run-finalize：非法 runId 形态退 2 + 拒绝路径拼接（不读仓外文件）', () => {
  const root = tmpProj();
  try {
    const r = runCli(CLI, root, ['run-finalize', '--run-id', '../../evil', '--repo-head', 'a'.repeat(40), '--diff-digest', 'sha256:' + 'b'.repeat(64)]);
    assert.equal(r.status, 2, '形态错=参数错退 2');
    assert.ok(r.stderr.includes('runId 非法'), 'stderr 点名形态错误');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI 统一收口：run-begin 落盘失败退 2 + stderr 可读一行（非裸栈）', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-cli-block-'));
  try {
    const blocker = join(home, 'blocker'); // 普通文件占位 root：其下 mkdir 必 ENOTDIR
    writeFileSync(blocker, 'x');
    const r = runCli(CLI, blocker, ['run-begin', '--task-id', 'T-1']);
    assert.equal(r.status, 2, 'FS 异常=工具错误退 2');
    assert.ok(r.stderr.includes('governance-cli：') && r.stderr.includes('工具错误'), '可读一行而非裸栈');
    assert.ok(!r.stderr.includes(' at '), '无裸堆栈帧');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 内部任务-254 批 2（治理语义 HIGH：内部验收-1/内部验收-5/内部验收-1/内部验收-3/内部验收-21）──

test('manifest 生命周期：finalize 后 policy/change-set digest 变化判失效且不可重开（CAS）', () => {
  const root = tmpProj();
  try {
    const b1 = { policyDigest: 'sha256:' + '1'.repeat(64), changeSetDigest: 'sha256:' + '2'.repeat(64) };
    const run = runBegin(root, { taskId: 'T-1', initiator: 'devA' });
    assert.equal(run.humanInitiator, 'devA', 'run-begin 的 initiator 落 humanInitiator 顶层字段');
    const fin = runFinalize(root, run.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'b'.repeat(64),
      policyDigest: b1.policyDigest, changeSetDigest: b1.changeSetDigest });
    assert.equal(fin.policyDigest, b1.policyDigest, 'finalized manifest 记 policyDigest');
    assert.equal(fin.changeSetDigest, b1.changeSetDigest, 'finalized manifest 记 changeSetDigest');
    // 最近 finalized completed manifest 与现算 binding 一致 → 零阻断
    const same = buildReport({ manifests: [fin], binding: b1 });
    assert.equal(same.blockingCount, 0, `stale 复核同锚不得阻断：${JSON.stringify(same.report.diagnostics)}`);
    // binding 变化（policy digest）→ TG-MANIFEST-STALE blocking
    const changed = buildReport({ manifests: [fin], binding: { ...b1, policyDigest: 'sha256:' + '3'.repeat(64) } });
    assert.ok(changed.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-STALE' && d.severity === 'blocking'),
      '最近 completed manifest 与现算 binding 不符 → blocking');
    // 更旧 completed stale 仅 warning（新 completed run 成为最近即降级）——同时断言恢复通道：
    // 新 completed run 落在当前 binding 上后，gate 复跑退 0（旧 stale 自动降级 warning）
    const fin2Run = runBegin(root, { taskId: 'T-2' });
    const fin2 = runFinalize(root, fin2Run.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'c'.repeat(64),
      policyDigest: 'sha256:' + '3'.repeat(64), changeSetDigest: b1.changeSetDigest });
    const binding2 = { ...b1, policyDigest: 'sha256:' + '3'.repeat(64) };
    const two = buildReport({ manifests: [fin, fin2], binding: binding2 });
    const staleDiags = two.report.diagnostics.filter((d) => d.ruleId === 'TG-MANIFEST-STALE');
    assert.equal(two.blockingCount, 0, '恢复通道：新 completed run 成为最近 → 旧 stale 不再 blocking');
    assert.equal(staleDiags.filter((d) => d.severity === 'blocking').length, 0, '更旧 completed 只降 warning');
    assert.equal(staleDiags.filter((d) => d.severity === 'warning').length, 1, '更旧 completed 须留 warning 痕迹');
    // changeSetDigest 变化同样触发失效（不只 policyDigest）
    const csChanged = buildReport({ manifests: [fin2], binding: { ...binding2, changeSetDigest: 'sha256:' + '9'.repeat(64) } });
    assert.ok(csChanged.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-STALE' && d.severity === 'blocking'),
      'changeSetDigest 变化同样判最近 completed 失效');
    // legacy（缺两 digest）→ TG-MANIFEST-LEGACY warning
    const legacyRun = runBegin(root, { taskId: 'T-3' });
    const legacy = runFinalize(root, legacyRun.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'd'.repeat(64) });
    const legacyReport = buildReport({ manifests: [legacy], binding: b1 });
    assert.equal(legacyReport.blockingCount, 0, 'legacy 不阻断');
    assert.ok(legacyReport.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-LEGACY' && d.severity === 'warning'),
      'legacy manifest 记 TG-MANIFEST-LEGACY warning');
    // cancelled/failed 不参与 stale 作用域，仅自身 warning 不阻断
    const cRun = runBegin(root, { taskId: 'T-4' });
    const cancelled = runFinalize(root, cRun.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'e'.repeat(64),
      outcome: 'cancelled', reason: 'abort', policyDigest: 'sha256:' + '4'.repeat(64), changeSetDigest: b1.changeSetDigest });
    const cReport = buildReport({ manifests: [cancelled], binding: b1 });
    assert.equal(cReport.blockingCount, 0, 'cancelled 不阻断');
    assert.ok(cReport.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-STALE' && d.severity === 'warning'),
      'cancelled 仅 TG-MANIFEST-STALE warning（ruleId 须精确）');
    // cancelled/failed 新 run 不解除既有 stale blocking（不参与「最近」作用域）
    const staleLatest = fin;
    const cRun2 = runBegin(root, { taskId: 'T-4b' });
    const cancelled2 = runFinalize(root, cRun2.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'e'.repeat(64),
      outcome: 'failed', reason: 'boom', policyDigest: 'sha256:' + '3'.repeat(64), changeSetDigest: b1.changeSetDigest });
    const stillStale = buildReport({ manifests: [staleLatest, cancelled2], binding: { ...b1, policyDigest: 'sha256:' + '3'.repeat(64) } });
    assert.ok(stillStale.report.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-STALE' && d.severity === 'blocking'),
      'cancelled/failed 新 run 不得解除既有 stale blocking');
    // finalized 后不可重开
    assert.throws(() => runFinalize(root, run.runId, { repoHead: 'c'.repeat(40), diffDigest: 'sha256:' + 'd'.repeat(64) }),
      /不可变/);
    // CAS：--expect-hash 不符拒绝（lib 层，异常须可识别）
    const casRun = runBegin(root, { taskId: 'T-5' });
    assert.throws(() => runFinalize(root, casRun.runId, { repoHead: 'a'.repeat(40), diffDigest: 'sha256:' + 'f'.repeat(64),
      expectHash: 'sha256:' + '0'.repeat(64) }), /CAS|expect-hash|期望/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contentDigest 排除面：.ai-governance 段不入（runtime 与 config.json），任意 runtime 业务目录计入', () => {
  const root = tmpProj();
  try {
    mkdirSync(join(root, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(root, 'src', 'runtime', 'x.js'), 'v1', 'utf8');
    const cfg = () => loadGovernanceConfig(root);
    const digestOf = () => { const c = cfg(); return computeBinding(root, c.config, c.policy).contentDigest; };
    const d1 = digestOf();
    writeFileSync(join(root, 'src', 'runtime', 'x.js'), 'v2', 'utf8');
    const d2 = digestOf();
    assert.notEqual(d2, d1, '任意名为 runtime 的业务目录（src/runtime）计入 contentDigest');
    mkdirSync(join(root, '.ai-governance', 'runtime', 'evals'), { recursive: true });
    writeFileSync(join(root, '.ai-governance', 'runtime', 'evals', 'r.json'), '{"x":1}', 'utf8');
    const d3 = digestOf();
    assert.equal(d3, d2, '.ai-governance/runtime 运行态不计入 contentDigest');
    // 口径固化（阶段复审建议）：.ai-governance 段整体不入 contentDigest（config 由
    // policyDigest/sources 覆盖；任意 runtime 目录仍按业务目录计入，见上）
    const cfgBefore = d3;
    const cfgPath = join(root, '.ai-governance', 'config.json');
    const cfgObj = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfgObj.createdAt = '2026-10-29T00:00:00.000Z';
    writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');
    assert.equal(digestOf(), cfgBefore, '.ai-governance/config.json 不在 contentDigest（由 policyDigest/sources 覆盖）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('change-set：digest 稳定且语义坏件点名', () => {
  const root = tmpProj();
  const ok = tmpProj();
  try {
    const cs = createChangeSet({ repos: [{ repoId: 'main' }], resources: ['path:main:a'] });
    assert.equal(changeSetDigest(cs), changeSetDigest({ ...cs }), 'digest 稳定（同内容同值）');
    assert.notEqual(changeSetDigest(cs), changeSetDigest(createChangeSet({ repos: [{ repoId: 'main' }], resources: ['path:main:b'] })));
    // 语义坏件（缺 repos/resources）→ invalidAssets(changeSet) → coverage invalid → TG-ASSET-INVALID
    writeFileSync(join(root, '.ai-governance', 'runtime', 'change-set.json'),
      JSON.stringify({ ok: true, changeSet: { order: {} } }), 'utf8');
    const collected = collectGovernanceInputs(root);
    assert.ok(collected.parts.invalidAssets.some((a) => a.domain === 'changeSet'), '语义坏件须点名 invalidAssets(changeSet)');
    assert.equal(collected.coverage.changeSet, 'invalid', 'changeSet 域 coverage=invalid');
    const { report } = buildReport({ ...collected.parts, binding: collected.binding,
      sources: { refs: collected.sourceRefs, inventory: collected.sourceInventory }, coverage: collected.coverage });
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'TG-ASSET-INVALID' && d.message.includes('changeSet')),
      '坏 change-set 不得当作「无锚」判通过（须 TG-ASSET-INVALID 阻断）');
    // 语义坏件（resources 含非字符串）→ 同判 invalid（阶段复审阻塞 2：Node sort 不抛会静默通过）
    writeFileSync(join(root, '.ai-governance', 'runtime', 'change-set.json'),
      JSON.stringify({ ok: true, changeSet: { repos: [], resources: [null, 'path:main:a'], order: {} } }), 'utf8');
    const collected2 = collectGovernanceInputs(root);
    assert.ok(collected2.parts.invalidAssets.some((a) => a.domain === 'changeSet' && String(a.error).includes('非字符串')),
      'resources 非字符串须点名 invalidAssets(changeSet)');
    assert.equal(collected2.coverage.changeSet, 'invalid');
    // 合法 change-set digested 且无 invalid
    const clean = collectGovernanceInputs(ok);
    assert.equal(clean.coverage.changeSet, 'missing', '无 change-set 文件为 missing（合法 not-applicable）');
    assert.ok(!clean.parts.invalidAssets.some((a) => a.domain === 'changeSet'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ok, { recursive: true, force: true });
  }
});

test('json-schema：SchemaError → 工具错误退 2（本批仅此面；eval suite 形态另锚 内部验收-1）', () => {
  const root = tmpProj();
  try {
    const suite = { suiteId: 's-schema', caseSetVersion: 'v1', cases: [{
      caseId: 'c1', subjectHash: 'sha256:' + 'a'.repeat(64), events: [{ json: { id: 'x' } }],
      oracles: [{ kind: 'json-schema', schema: { $ref: '#/defs/x' } }],
    }] };
    writeFileSync(join(root, 'suite.json'), JSON.stringify(suite), 'utf8');
    const r = spawnSync(process.execPath, [AGENT_EVAL, '--project-root', root, '--suite', 'suite.json',
      '--subject-hash', 'sha256:' + 'a'.repeat(64)], { encoding: 'utf8' });
    assert.equal(r.status, 2, `SchemaError 须工具错误退 2（实测 ${r.status}；stderr=${r.stderr}）`);
    assert.ok(String(r.stderr).includes('oracle schema'), 'stderr 可读点名 schema 子集限制');
    assert.ok(!String(r.stderr).includes(' at '), '无裸堆栈帧');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Lease：过期/独占/并发单胜（H17 仅补缺口）', () => {
  const root = tmpProj();
  try {
    const a = acquireLease(root, { resource: 'path:main:src/**', holder: 'A' });
    assert.ok(a.ok, '首取成功');
    const b = acquireLease(root, { resource: 'path:main:src/**', holder: 'B' });
    assert.equal(b.ok, false, '独占：异 holder 冲突拒绝');
    assert.ok(b.error, '冲突须可见诊断');
    const c = acquireLease(root, { resource: 'path:main:src/**', holder: 'A' });
    assert.equal(c.ok, false, '持有者重复取用同资源亦拒（需 renew）');
    // 过期：把 expiresAt 拨到过去后 renew 拒（不可复活）
    const leasesFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const state = JSON.parse(readFileSync(leasesFile, 'utf8'));
    const id = Object.keys(state.leases)[0];
    state.leases[id].expiresAt = Date.now() - 1000;
    writeFileSync(leasesFile, JSON.stringify(state), 'utf8');
    const renew = renewLease(root, { leaseId: id, revision: state.leases[id].revision });
    assert.equal(renew.ok, false, '过期后 renew 拒（不可复活）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate 归属：requestedBy 取候选池 startedAt 最大者（completedAt/runId 决胜）', () => {
  const base = Date.parse('2026-10-29T00:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (over) => ({ startedAt: iso(base), humanInitiator: 'x', ...over });
  // ① startedAt 最大者胜出（候选池＝open＋finalized 全部）
  assert.equal(selectRequestedBy([
    mk({ runId: 'run-a', startedAt: iso(base), humanInitiator: 'earlier', status: 'finalized' }),
    mk({ runId: 'run-b', startedAt: iso(base + 1000), humanInitiator: 'later', status: 'open' }),
  ]), 'later', '取 startedAt 最大者的 humanInitiator');
  // ② 同 startedAt 取 completedAt 较大者（open 无 completedAt 视为最旧）
  assert.equal(selectRequestedBy([
    mk({ runId: 'run-a', completedAt: iso(base + 5000), humanInitiator: 'done-later', outcome: 'completed' }),
    mk({ runId: 'run-b', completedAt: iso(base + 1000), humanInitiator: 'done-earlier', outcome: 'completed' }),
  ]), 'done-later', '同刻取 completedAt 较大者');
  // ③ 同 startedAt 且均无 completedAt → 按 runId 字典序（取小者，确定性）
  assert.equal(selectRequestedBy([
    mk({ runId: 'run-b', humanInitiator: 'id-b' }),
    mk({ runId: 'run-a', humanInitiator: 'id-a' }),
  ]), 'id-a', '同刻均无 completedAt 按 runId 字典序');
  // ③′ 同 startedAt：open（无 completedAt）视为最旧，completed 胜出（阶段复审建议）
  assert.equal(selectRequestedBy([
    mk({ runId: 'run-open', humanInitiator: 'open-init' }),
    mk({ runId: 'run-done', completedAt: iso(base + 1000), humanInitiator: 'done-init', outcome: 'completed' }),
  ]), 'done-init', 'open 无 completedAt 视为最旧，同 startedAt 时 completed 者胜');
  // ④ unknown/缺失/空串按无值 → null（无归属，不判自批）
  assert.equal(selectRequestedBy([mk({ runId: 'run-a', humanInitiator: 'unknown' })]), null);
  assert.equal(selectRequestedBy([mk({ runId: 'run-a', humanInitiator: '   ' })]), null);
  assert.equal(selectRequestedBy([]), null);
  // ⑤ 字段整体缺失的坏件按最旧（不因坏件夺走归属）
  assert.equal(selectRequestedBy([
    mk({ runId: 'run-a', humanInitiator: 'good' }),
    { runId: 'run-b', humanInitiator: 'broken-no-startedAt' },
  ]), 'good', '缺 startedAt 的坏件按最旧处理');
});

if (process.env.NODE_TEST_CONTEXT === undefined) {
  // node --test 直接驱动时无需手动 run
}

// ── 内部任务-255 批 3（N-1：内部验收-4）──

test('redaction：scanSecrets 不回显原文（N 组安全加固）', () => {
  const hits = scanSecrets({ aws: 'AKIAIOSFODNN7EXAMPLE', kv: 'token=abcdef123456' });
  assert.equal(hits.length, 2, `两类各一：${JSON.stringify(hits)}`);
  const joined = hits.join('|');
  assert.ok(!joined.includes('AKIA'), 'AKIA 类不得回显原文片段');
  assert.ok(!joined.includes('abcdef123456'), '键值对类不得回显原文片段');
  assert.ok(joined.includes('AWS-AccessKey') && joined.includes('凭据键值对'), '须保留规则标签');
  assert.ok(/长度 \d+/.test(joined), '命中描述含长度而非原文');
});

// ── 内部任务-256 批 4（H9：内部验收-1）──

test('run-manifest：client 字段单源派生（plugin 版本读 manifest，host 显式参数优先/环境探测/unknown 兜底）', () => {
  const root = tmpProj();
  const savedEnv = { ...process.env };
  try {
    const pluginVersion = JSON.parse(readFileSync(new URL('../../plugin.manifest.json', import.meta.url), 'utf8')).version;
    // env 探测：仅 ZCODE_ 前缀 → zcode
    for (const k of Object.keys(process.env)) if (/^(DSH_|KIMI_|MCODE_|ZCODE_)/.test(k)) delete process.env[k];
    process.env.ZCODE_PROJECT_DIR = root;
    const m1 = runBegin(root, { taskId: '内部任务-CLIENT-1' });
    assert.equal(m1.client.host, 'zcode', 'ZCODE_ 前缀探测为 zcode');
    assert.equal(m1.client.plugin, `team-governance@${pluginVersion}`, 'plugin 版本读 plugin.manifest.json 单源（不得硬编码 0.1.0）');
    // 显式参数优先
    const m2 = runBegin(root, { taskId: '内部任务-CLIENT-2', clientHost: 'mcode' });
    assert.equal(m2.client.host, 'mcode', '显式 clientHost 优先于环境探测');
    // 未知环境 → unknown（不冒充 zcode）
    for (const k of Object.keys(process.env)) if (/^(DSH_|KIMI_|MCODE_|ZCODE_)/.test(k)) delete process.env[k];
    const m3 = runBegin(root, { taskId: '内部任务-CLIENT-3' });
    assert.equal(m3.client.host, 'unknown', '无宿主环境变量落 unknown');
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-manifest：host 探测 ZCODE_ 末位（DSH/Kimi/MCode 同时注入 ZCODE_* 时不得误判 zcode）', () => {
  const root = tmpProj();
  const savedEnv = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(DSH_|KIMI_|MCODE_|ZCODE_)/.test(k)) delete process.env[k];
    // 适配层事实：DSH/Kimi/MCode 也会注入 ZCODE_*，探测必须让 DSH_ 优先
    process.env.ZCODE_PROJECT_DIR = root;
    process.env.DSH_SESSION_ID = 'sess-1';
    const mDsh = runBegin(root, { taskId: '内部任务-Z-1' });
    assert.equal(mDsh.client.host, 'dsh', 'DSH_ 与 ZCODE_ 并存时判 dsh（ZCODE_ 末位）');
    delete process.env.DSH_SESSION_ID;
    process.env.KIMI_CODE_HOME = root;
    const mKimi = runBegin(root, { taskId: '内部任务-Z-2' });
    assert.equal(mKimi.client.host, 'kimi', 'KIMI_ 与 ZCODE_ 并存时判 kimi');
    delete process.env.KIMI_CODE_HOME;
    process.env.MCODE_DATA_DIR = root;
    const mMcode = runBegin(root, { taskId: '内部任务-Z-3' });
    assert.equal(mMcode.client.host, 'mcode', 'MCODE_ 与 ZCODE_ 并存时判 mcode');
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-manifest：host 探测空串视同未设置', () => {
  const root = tmpProj();
  const savedEnv = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(DSH_|KIMI_|MCODE_|ZCODE_)/.test(k)) delete process.env[k];
    process.env.ZCODE_PROJECT_DIR = '';
    process.env.DSH_SESSION_ID = 'x';
    const m = runBegin(root, { taskId: '内部任务-Z-4' });
    assert.equal(m.client.host, 'dsh', '空串前缀不参与探测（值非空才命中），继续走下一前缀');
    process.env.DSH_SESSION_ID = '';
    const m2 = runBegin(root, { taskId: '内部任务-Z-5' });
    assert.equal(m2.client.host, 'unknown', '空串/空值不命中任何前缀 → unknown');
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-manifest：host 探测表序固定（DSH_→KIMI_→MCODE_→ZCODE_，空串不命中）', () => {
  assert.deepEqual(HOST_ENV_PREFIXES.map(([token]) => token), ['dsh', 'kimi', 'mcode', 'zcode'], '表序即优先级（ZCODE_ 末位）');
  // 直调 hostOf（注入 env，避免 win32 对 process.env 置 '' 实为删变量的判别力丢失）
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '/x' }), 'zcode');
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '/x', MCODE_DATA_DIR: '/m' }), 'mcode', 'MCODE_ 先于 ZCODE_');
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '/x', KIMI_CODE_HOME: '/k' }), 'kimi', 'KIMI_ 先于 ZCODE_');
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '/x', DSH_SESSION_ID: 's' }), 'dsh', 'DSH_ 先于其余');
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '' }), 'unknown', '空串不命中（falsy）');
  assert.equal(hostOf({}, { ZCODE_PROJECT_DIR: '   ' }), 'zcode', '纯空白按 workflow 同口径视为存在（truthy，不做 trim 归一）');
  assert.equal(hostOf({ host: 'mcode' }, { ZCODE_PROJECT_DIR: '/x' }), 'mcode', '显式 host 恒优先');
});

// ── 内部任务-257（P5-2）：approvals/learnings 读失败记 invalid ──
test('governance-store：approvals/learnings 读失败记 invalid（不当空集）', () => {
  const root = tmpProj();
  try {
    mkdirSync(join(root, '.ai-governance', 'runtime', 'approvals'), { recursive: true });
    mkdirSync(join(root, '.ai-governance', 'runtime', 'learnings'), { recursive: true });
    mkdirSync(join(root, '.ai-governance', 'runtime', 'approvals', 'approvals.jsonl'), { recursive: true });
    mkdirSync(join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl'), { recursive: true });
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      policy: { id: 'default', version: 1, riskLevel: 'medium', allowedModels: [], fallbacks: [], enforcement: 'relaxed' },
      requiredDomains: [], approvalProfile: 'default', evalSuiteFiles: [], evalReportFiles: [], learningFiles: [],
    }), 'utf8');
    const collected = collectGovernanceInputs(root);
    const domains = collected.parts.invalidAssets.map((a) => a.domain);
    assert.ok(domains.includes('approvals'), 'approvals 读失败须记 invalid');
    assert.ok(domains.includes('learnings'), 'learnings 读失败须记 invalid');
    assert.equal(collected.coverage.approvals, 'invalid', 'approvals 读失败 → coverage invalid（非 empty/missing）');
    assert.equal(collected.coverage.learnings, 'invalid', 'learnings 读失败 → coverage invalid（非 empty/missing）');
  } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } }
});

// ── 内部任务-257（P5-6）：锁 EEXIST 分流与失败清理 ──
test('lease：状态锁非 EEXIST 错误点名 errno 且清理锁文件', async () => {
  const { acquireStateLock, LeaseLockError } = await import('../lib/lease.mjs');
  const root = tmpProj();
  try {
    const eacces = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
    assert.throws(() => acquireStateLock(root, 'owner-a', eacces),
      (err) => err instanceof LeaseLockError && err.code === 'EACCES' && /EACCES/.test(err.message),
      '非 EEXIST 须抛 LeaseLockError 并点名 errno');
    // 写/关失败须清理锁文件（注入无效 fd）
    const badFd = () => 999999;
    assert.throws(() => acquireStateLock(root, 'owner-b', badFd), /状态锁获取失败/);
    const lock = join(root, '.ai-governance', 'runtime', 'leases', 'leases.lock');
    assert.equal(existsSync(lock), false, '写失败须清理锁文件（不留僵尸锁）');
    // 正常获取/释放回环
    assert.equal(acquireStateLock(root, 'owner-c'), true);
    const { releaseStateLock } = await import('../lib/lease.mjs');
    releaseStateLock(root);
    assert.equal(existsSync(lock), false);
  } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } }
});

// ── 内部任务-257（P5-10）：坏 run 单计（UNREADABLE 优先，不双计 ASSET-INVALID）──
test('gate：坏 run 只计一条 blocking 且 coverage.runs 仍 invalid', () => {
  const report = buildReport({
    manifests: [],
    unreadableRuns: ['runtime/runs/bad.json'],
    invalidAssets: [{ domain: 'runs', path: 'runtime/runs/bad.json', error: 'JSON 解析失败' }],
  });
  const built = report.report ?? report;
  const rules = (built.diagnostics ?? []).filter((d) => d.ruleId === 'TG-MANIFEST-UNREADABLE' || d.ruleId === 'TG-ASSET-INVALID');
  assert.equal(rules.length, 1, '同一坏 run 只计一条诊断（不双计）');
  assert.equal(rules[0].ruleId, 'TG-MANIFEST-UNREADABLE', 'UNREADABLE 优先');
  assert.equal(report.blockingCount ?? built.blockingCount, 1);
});

