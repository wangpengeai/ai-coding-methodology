// 文件：adapters.test.mjs
// 描述：波次 D 适配器 TDD（内部决策-015 / 内部接口-1 / 内部规则-1/2/8）——信封契约校验、
//       stdio live adapter（握手/不可用/非零退出；超时与输出上限由 eval-gate 覆盖）、github-ci warning-only、
//       github-pr dry-run（事件文件→审批，新 commit 失效）、git-ref-lease 本地 CAS、
//       结构化 learning 生命周期。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { validateEnvelope } from '../adapters/contract.mjs';
import { validateAgainstSchema } from '../lib/json-schema.mjs';
import { runStdioAdapter } from '../adapters/stdio.mjs';
import { runGithubCi } from '../adapters/github-ci.mjs';
import { integrityHash } from '../lib/canonical-json.mjs';
import { loadGovernanceConfig, computeBinding, collectGovernanceInputs } from '../lib/governance-store.mjs';
import { prEventToApprovals } from '../adapters/github-pr.mjs';
import { gitRefAcquire, gitRefRelease } from '../adapters/git-ref-lease.mjs';

// 内部任务-256：治理报告夹具须带 integrityHash（verifyReport 复核的前置）
function withHash(report) {
  const body = { ...report };
  delete body.integrityHash;
  return { ...body, integrityHash: integrityHash(body) };
}

// 内部任务-256（N-H）：github-ci 经 verifyReport(report,{projectRoot}) 复核——夹具必须是与当前项目输入一致的真签名报告。
const CLI_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'governance-cli.mjs');
function initCiProj() {
  const root = mkdtempSync(join(tmpdir(), 'tg-ci-'));
  execFileSync(process.execPath, [CLI_JS, '--project-root', root, 'init'], { encoding: 'utf8' });
  return root;
}
function ciReportBody(root, status = 'passed') {
  const { config, policy } = loadGovernanceConfig(root);
  const binding = computeBinding(root, config, policy);
  const collected = collectGovernanceInputs(root);
  return withHash({
    schemaVersion: '1.0.0', status, blockingCount: status === 'passed' ? 0 : 1, externalEffects: [],
    binding: { subject: binding.subject, validUntil: binding.validUntil ?? null },
    sources: { refs: collected.sourceRefs, inventory: collected.sourceInventory },
  });
}
function writeCiReport(root, report) {
  const dir = join(root, '.ai-governance', 'runtime', 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'governance-report.json');
  writeFileSync(file, typeof report === 'string' ? report : JSON.stringify(report), 'utf8');
  return file;
}

/** 临时 git 仓库夹具（git-ref-lease 用例共用）。 */
function initRefRepo(dir) {
  execSync('git init -q && git config user.email t@e.c && git config user.name t', { cwd: dir });
  execSync('git commit -q --allow-empty -m init', { cwd: dir });
}
import { promoteLearning, validateLearning } from '../lib/learning.mjs';

// ── 信封契约（内部接口-1）──

test('envelope：合法信封通过；缺必需字段/专有字段泄漏/不可解析 → 明确失败', () => {
  const ok = { schemaVersion: '1.0.0', adapter: 'stdio', capability: 'ci',
    request: {}, result: { status: 'passed', summary: 'ok' },
    availability: 'available', externalEffects: [], correlation: { runId: 'r1' } };
  assert.deepEqual(validateEnvelope(ok), []);
  const missing = { ...ok };
  delete missing.availability;
  assert.ok(validateEnvelope(missing).length > 0);
  const badStatus = { ...ok, result: { status: 'excellent' } };
  assert.ok(validateEnvelope(badStatus).length > 0, 'result.status 枚举校验');
  const githubLeak = { ...ok, adapter: 'github-ci', request: { pull_request: { number: 1 } } };
  const diags = validateEnvelope(githubLeak, { forbidPlatformKeys: true });
  assert.ok(diags.some((d) => /专有/.test(d.message)), '平台专有字段泄漏进核心被拒');
});

// 内部任务-253（D2 方向 B）：信封必填约束矩阵（内部接口-1 §2 全部约束）
test('信封必填约束：request/adapter(≤64)/capability/status/summary/digest/subjectDigest/runId/externalEffects', () => {
  const ok = {
    schemaVersion: '1.0.0', adapter: 'stdio', capability: 'agent-eval',
    request: {}, result: { status: 'passed', summary: 'ok', digest: 'sha256:' + 'a'.repeat(64) },
    availability: 'available', externalEffects: [], correlation: { runId: 'r1', subjectDigest: 'sha256:' + 'b'.repeat(64) },
  };
  assert.deepEqual(validateEnvelope(ok), []);
  const drop = (key) => { const e = structuredClone(ok); delete e[key]; return e; };
  const cases = [
    ['缺 request', drop('request')],
    ['adapter 非法', { ...ok, adapter: 'Bad Name' }],
    ['adapter 超长', { ...ok, adapter: 'a' + 'b'.repeat(64) }],
    ['capability 非枚举', { ...ok, capability: 'agent-eval-x' }],
    ['status 非枚举', { ...ok, result: { status: 'excellent', summary: 'x' } }],
    ['summary 非字符串', { ...ok, result: { status: 'passed' } }],
    ['digest 非法', { ...ok, result: { status: 'passed', summary: 'x', digest: 'sha256:zz' } }],
    ['subjectDigest 非法', { ...ok, correlation: { runId: 'r1', subjectDigest: 'abc' } }],
    ['externalEffects 非数组', { ...ok, externalEffects: {} }],
    ['runId 非字符串', { ...ok, correlation: {} }],
  ];
  for (const [label, env] of cases) assert.ok(validateEnvelope(env).length > 0, `${label} 须被拒`);
  // null/undefined 可选字段不参与 pattern；平台键默认拒绝、可显式关闭
  assert.deepEqual(validateEnvelope({ ...ok, correlation: { runId: 'r1' } }), []);
  assert.deepEqual(validateEnvelope({ ...ok, correlation: { runId: 'r1', subjectDigest: null } }), []);
  assert.ok(validateEnvelope({ ...ok, request: { pull_request: 1 } }).length > 0, '平台键默认拒');
  assert.deepEqual(validateEnvelope({ ...ok, request: { pull_request: 1 } }, { forbidPlatformKeys: false }), []);
});

// 内部任务-253：手写校验与 schema 工件双向对拍（合法与非法语料结论一致；平台键面由手写校验独占（schema 子集无法表达），不入对拍语料——内部接口-1 §4.1）
test('信封 schema 双向对拍：合法与非法语料结论一致', () => {
  const schemaPath = new URL('../../core/schemas/adapter_envelope.schema.json', import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ok = {
    schemaVersion: '1.0.0', adapter: 'stdio', capability: 'agent-eval',
    request: {}, result: { status: 'passed', summary: 'ok' },
    availability: 'available', externalEffects: [], correlation: { runId: 'r1', subjectDigest: null },
  };
  const samples = [
    ok,
    { ...ok, adapter: 'github-ci', capability: 'ci', result: { status: 'failed', summary: 'bad' } },
    { ...ok, result: { status: 'unverified', summary: 'u', digest: 'sha256:' + 'c'.repeat(64) } },
    { ...ok, capability: 'os-observation' },
    { ...ok, result: { status: 'passed', summary: 'x', digest: null } },
    { ...ok, externalEffects: [1] },
  ];
  const bads = [
    { ...ok, schemaVersion: '2.0.0' },
    { ...ok, adapter: 'Bad Name' },
    { ...ok, capability: 'unknown-cap' },
    { ...ok, result: { status: 'excellent', summary: 'x' } },
    { ...ok, result: { status: 'passed' } },
    { ...ok, result: { status: 'passed', summary: 'x', digest: 'zz' } },
    { ...ok, correlation: { runId: 'r1', subjectDigest: 'abc' } },
    { ...ok, externalEffects: {} },
    { ...ok, availability: 'unknown' },
  ];
  for (const env of samples) {
    assert.equal(validateEnvelope(env).length === 0, validateAgainstSchema(env, schema).length === 0,
      `合法语料对拍不一致：${JSON.stringify(env).slice(0, 120)}`);
    assert.equal(validateEnvelope(env).length, 0, '合法语料手写校验须通过');
  }
  for (const env of bads) {
    assert.equal(validateEnvelope(env).length === 0, validateAgainstSchema(env, schema).length === 0,
      `非法语料对拍不一致：${JSON.stringify(env).slice(0, 120)}`);
    assert.ok(validateEnvelope(env).length > 0, '非法语料手写校验须拒');
  }
});

// ── stdio live adapter（内部规则-2）──

test('stdio：能力握手成功执行；不可用记 unverified；非零退出记 unverified（超时/上限见 eval-gate）', async () => {
  // fake agent：读一行 JSON 请求，回一行 JSON 结果
  const fake = `import { readFileSync } from 'node:fs';
const line = readFileSync(0, 'utf8').split('\\n')[0];
const req = JSON.parse(line);
if (req.capability === 'agent-eval') {
  console.log(JSON.stringify({ status: 'passed', summary: 'fake-ok', events: [{ text: 'ok' }] }));
} else {
  console.log(JSON.stringify({ status: 'unavailable', summary: 'no capability' }));
}`;
  const r1 = await runStdioAdapter(fake, { capability: 'agent-eval', timeoutMs: 5000, maxOutputBytes: 65536 });
  assert.equal(r1.transport, 'ok');
  assert.equal(r1.availability, 'available');
  assert.equal(r1.result.status, 'passed');
  assert.equal(typeof r1.parsed, 'object', 'stdio 返回原始 parsed 供调用方验信封');
  assert.equal('envelope' in r1, false, 'stdio 不合成信封（plan F2）');
  const r2 = await runStdioAdapter(fake, { capability: 'unknown-cap', timeoutMs: 5000, maxOutputBytes: 65536 });
  assert.equal(r2.result.status, 'unverified', '能力不匹配记 unverified 不伪装 passed');
  const r3 = await runStdioAdapter('process.exit(1);', { capability: 'agent-eval', timeoutMs: 5000, maxOutputBytes: 65536 });
  assert.equal(r3.availability, 'unavailable');
  assert.equal(r3.result.status, 'unverified');
});

// ── github-ci warning-only（内部规则-8）──

test('github-ci：读本地治理报告出中立结论；缺报告 degraded；退出码 0/1/2', () => {
  const root = initCiProj();
  try {
    const r0 = runGithubCi(root, {});
    assert.equal(r0.envelope.availability, 'degraded', '无报告 degraded（warning-only）');
    writeCiReport(root, ciReportBody(root, 'passed'));
    const r1 = runGithubCi(root, {});
    assert.equal(r1.envelope.result.status, 'passed');
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.envelope.mode, 'dry-run');
    assert.deepEqual(r1.envelope.externalEffects, []);
    writeCiReport(root, ciReportBody(root, 'blocked'));
    const r2 = runGithubCi(root, {});
    assert.equal(r2.envelope.result.status, 'failed');
    assert.equal(r2.exitCode, 1);
    // 不可解析 → 工具错误语义（退 2）不变
    const blocked = ciReportBody(root, 'blocked');
    blocked.diagnostics = 'oops-not-array';
    writeCiReport(root, blocked);
    const rMal = runGithubCi(root, {});
    assert.equal(rMal.envelope.result.status, 'failed', 'diagnostics 非数组不得崩（容器守卫）');
    blocked.diagnostics = [null, { message: 'm' }];
    writeCiReport(root, blocked);
    const rMal2 = runGithubCi(root, {});
    assert.equal(rMal2.envelope.result.status, 'failed', 'diagnostics 元素畸形不得崩');
    writeCiReport(root, 'not-json {{{');
    const r3 = runGithubCi(root, {});
    assert.equal(r3.envelope.result.status, 'unverified');
    assert.equal(r3.exitCode, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── github-pr dry-run（评审 D2）──

test('github-pr：事件文件→审批记录；review dismissal/new commit 失效；默认零网络', () => {
  const head = 'a'.repeat(40);
  const base = { subjectDigest: 'sha256:' + 'b'.repeat(64) };
  // approved review
  const approved = prEventToApprovals({
    action: 'reviewed', pull_request: { head: { sha: head } }, signatureVerified: true,
    review: { state: 'approved', user: { login: 'alice', id: 1 }, submitted_at: '2026-09-13T00:00:00Z', commit_id: head },
  }, base);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].identity.source, 'github-review');
  assert.equal(approved[0].identity.verified, true, '签名验证通过的事件构成已验证身份');
  // 本地无签名事件：identity 降级 local-attested（verified=false——评审 C7）
  const unsigned = prEventToApprovals({
    action: 'reviewed', pull_request: { head: { sha: head } },
    review: { state: 'approved', user: { login: 'alice', id: 1 }, submitted_at: '2026-09-13T00:00:00Z', commit_id: head },
  }, base);
  assert.equal(unsigned[0].identity.verified, false, '未签名事件不构成已验证身份');
  // dismissal
  const dismissed = prEventToApprovals({
    action: 'review_dismissed', pull_request: { head: { sha: head } },
    review: { user: { login: 'alice' }, commit_id: head },
  }, base);
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].revocation.reason, 'review-dismissed');
  // stale commit：审批绑定旧 commit → subjectDigest 失配
  const stale = prEventToApprovals({
    action: 'reviewed', pull_request: { head: { sha: 'c'.repeat(40) } },
    review: { state: 'approved', user: { login: 'bob' }, commit_id: head, submitted_at: '2026-09-13T00:00:00Z' },
  }, base);
  assert.equal(stale.length, 0, '审批 commit ≠ PR head → 不产生有效审批');
});

// ── git-ref-lease 本地 CAS（内部决策-014 跨开发者后端；本地仓库验证）──

test('git-ref-lease：本地临时仓库 CAS 单胜；release 后可重取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-ref-'));
  try {
    initRefRepo(dir);
    const l1 = gitRefAcquire(dir, { resource: 'repo:main', holder: 'run-a' });
    assert.ok(l1.ok, l1.error);
    const l2 = gitRefAcquire(dir, { resource: 'repo:main', holder: 'run-b' });
    assert.equal(l2.ok, false, '同资源 ref CAS 单胜');
    assert.ok(/冲突|expected/.test(l2.error));
    const rel = gitRefRelease(dir, { leaseId: l1.lease.leaseId, holder: 'run-a' });
    assert.ok(rel.ok, rel.error);
    const l3 = gitRefAcquire(dir, { resource: 'repo:main', holder: 'run-c' });
    assert.ok(l3.ok, '释放后可重取');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 结构化 learning（内部需求-12）──

test('learning：observed→validated→adopted→retired 生命周期与校验', () => {
  let l = promoteLearning({ learningId: 'L-1', statement: 'Bash 环境无会话变量', scope: 'routing' }, 'observed', { owner: 'wangp', evidence: ['e1'] });
  assert.equal(l.status, 'observed');
  assert.throws(() => promoteLearning(l, 'adopted'), /observed.*validated/, '跳级拒绝');
  l = promoteLearning(l, 'validated', { validationMethod: 'repro', evidence: ['e2'] });
  l = promoteLearning(l, 'adopted', { adoptedInto: ['workflow/hooks/routing-lib.mjs'] });
  const v = validateLearning(l);
  assert.deepEqual(v, []);
  const noEvidence = { learningId: 'L-2', statement: 'x', status: 'observed', owner: 'w', evidenceReferences: [] };
  assert.ok(validateLearning(noEvidence).some((d) => /证据/.test(d.message)));
  l = promoteLearning(l, 'retired', { supersededBy: 'L-9' });
  assert.equal(l.status, 'retired');
});

// ── 内部任务-255 批 3（N-4：内部验收-1）──

test('git-ref-lease：fencing token 跨 acquire/release 单调递增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-ref-fence-'));
  try {
    initRefRepo(dir);
    const holder = 'run-m';
    for (let i = 0; i < 3; i += 1) {
      const l = gitRefAcquire(dir, { resource: 'repo:fence', holder });
      assert.ok(l.ok, l.error);
      assert.equal(l.lease.fencingToken, i + 1, `第 ${i + 1} 次 acquire 的 fencingToken 应单调递增`);
      const rel = gitRefRelease(dir, { leaseId: l.lease.leaseId, holder });
      assert.ok(rel.ok, rel.error);
    }
    const last = gitRefAcquire(dir, { resource: 'repo:fence', holder });
    assert.ok(last.ok, last.error);
    assert.equal(last.lease.fencingToken, 4, '跨周期 token 严格大于前次（不得重号）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('git-ref-lease：fencing 登记失败即回滚租约并拒绝获取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-ref-fail-'));
  try {
    initRefRepo(dir);
    const digest = createHash('sha256').update('repo:fail').digest('hex').slice(0, 16);
    const fencingRef = `refs/governance/fencing/${digest}`;
    const leaseRef = `refs/governance/leases/${digest}`;
    const failingGitFn = (repo, args) => {
      if (args[0] === 'update-ref' && String(args[1]) === fencingRef) throw new Error('injected fence CAS failure');
      return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    };
    const r = gitRefAcquire(dir, { resource: 'repo:fail', holder: 'run-f' }, { gitFn: failingGitFn });
    assert.equal(r.ok, false, 'fencing 登记失败须拒绝获取');
    assert.ok(/fencing|回滚/.test(String(r.error)), `错误须点名 fencing 失败/回滚（收到 ${r.error}）`);
    let leaseExists = true;
    try { execFileSync('git', ['-C', dir, 'rev-parse', leaseRef], { encoding: 'utf8' }); } catch { leaseExists = false; }
    assert.equal(leaseExists, false, '失败须回滚租约 ref（不留僵尸租约）');
    const ok = gitRefAcquire(dir, { resource: 'repo:fail', holder: 'run-f' });
    assert.ok(ok.ok, '回滚后可正常获取');
    assert.equal(ok.lease.fencingToken, 1, '失败尝试不得消耗 token');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('git-ref-lease：fencing 计数器损坏即 fail-closed（不重发低号 token）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-ref-bad-'));
  try {
    initRefRepo(dir);
    const digest = createHash('sha256').update('repo:bad').digest('hex').slice(0, 16);
    const fencingRef = `refs/governance/fencing/${digest}`;
    const tree = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const badOid = execFileSync('git', ['-C', dir, 'commit-tree', tree, '-m', 'garbage-counter'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', dir, 'update-ref', fencingRef, badOid], { encoding: 'utf8' });
    const r = gitRefAcquire(dir, { resource: 'repo:bad', holder: 'run-b' });
    assert.equal(r.ok, false, '计数器不可解析须拒绝获取（fail-closed）');
    assert.ok(/计数器损坏/.test(String(r.error)), `错误须点名计数器损坏（收到 ${r.error}）`);
    let leaseExists = true;
    try { execFileSync('git', ['-C', dir, 'rev-parse', `refs/governance/leases/${digest}`], { encoding: 'utf8' }); } catch { leaseExists = false; }
    assert.equal(leaseExists, false, '拒绝时不得留下租约 ref');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('github-live：UA 版本来自 plugin.manifest.json 单源（fake fetch 捕获请求头）', async () => {
  const { githubLiveRead } = await import('../adapters/github-live.mjs');
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_TOKEN;
  const prevVersion = JSON.parse(readFileSync(new URL('../../plugin.manifest.json', import.meta.url), 'utf8')).version;
  try {
    process.env.GITHUB_TOKEN = 'fake-token';
    let captured = null;
    globalThis.fetch = async (url, opts) => { captured = opts; return new Response('[]', { status: 200 }); };
    const r = await githubLiveRead({ path: '/repos/o/r/pulls/1/reviews' });
    assert.equal(r.availability, 'available');
    const ua = captured?.headers?.['X-Governance-Adapter'];
    assert.ok(ua, 'X-Governance-Adapter 头须存在');
    assert.equal(ua, `team-governance/${prevVersion}`, 'UA 版本须读 plugin.manifest.json（不得硬编码 0.1）');
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
  }
});

test('github-live：双 digest 缺失即拒（不得以 undefined 相等通过）', async () => {
  const { githubLiveWrite } = await import('../adapters/github-live.mjs');
  const base = {
    policyAllows: true, hasApproval: true, envAuthorized: true,
    executor: async () => ({ ok: true, summary: 'should-not-run' }),
    target: 'org/repo', capability: 'ci',
  };
  const cases = [
    [{}, '两者都缺失'],
    [{ confirmSubject: 'sha256:' + 'a'.repeat(64) }, '缺 currentSubject'],
    [{ currentSubject: 'sha256:' + 'a'.repeat(64) }, '缺 confirmSubject'],
    [{ confirmSubject: '', currentSubject: '' }, '两者空串'],
  ];
  for (const [extra, label] of cases) {
    let executed = false;
    const r = await githubLiveWrite({ ...base, ...extra, executor: async () => { executed = true; return { ok: true, summary: 'x' }; } });
    assert.equal(r.result.status, 'unverified', `${label} 应拒绝`);
    assert.equal(executed, false, `${label} 不得执行外部写`);
    assert.match(r.result.summary, /digest|缺失|不匹配/, `${label} 错误须点名缺失`);
  }
});

test('github-ci：报告未经 verifyReport 复核不得判 passed（stale/tampered→failed，缺报告→unverified）', () => {
  const root = initCiProj();
  try {
    const rMissing = runGithubCi(root, {});
    assert.equal(rMissing.envelope.result.status, 'unverified', '缺报告 unverified');
    assert.equal(rMissing.exitCode, 0, 'warning-only 不阻断');
    // 无 integrityHash：自报 passed 也不得通过（tampered 面）
    writeCiReport(root, { schemaVersion: '1.0.0', status: 'passed', blockingCount: 0, externalEffects: [] });
    const r1 = runGithubCi(root, {});
    assert.equal(r1.envelope.result.status, 'failed', '无 integrityHash 的自报 passed 不得判 passed');
    assert.equal(r1.exitCode, 1);
    // legacy（无 binding）：verifyReport 判 stale → failed
    writeCiReport(root, withHash({ schemaVersion: '1.0.0', status: 'passed', blockingCount: 0, externalEffects: [] }));
    const r2 = runGithubCi(root, {});
    assert.equal(r2.envelope.result.status, 'failed', 'legacy 无 binding → stale → failed');
    assert.match(r2.envelope.result.summary, /stale/, 'summary 须点名 stale（与 tampered 可区分）');
    // 篡改：hash 后改 body → tampered
    const tampered = ciReportBody(root);
    tampered.blockingCount = 0; tampered.tamperedNote = 'x';
    writeCiReport(root, tampered);
    const r3 = runGithubCi(root, {});
    assert.equal(r3.envelope.result.status, 'failed', 'body 被改 → tampered → failed');
    assert.match(r3.envelope.result.summary, /tampered/, 'summary 须点名 tampered');
    // gate 后项目内容变化：绑定失配 → stale
    const staleReport = ciReportBody(root);
    const configPath = join(root, '.ai-governance', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.createdAt = '2026-10-30T00:00:00.000Z';
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    writeCiReport(root, staleReport);
    const r4 = runGithubCi(root, {});
    assert.equal(r4.envelope.result.status, 'failed', 'gate 后控制输入变化 → stale → failed（verifyReport 重收集）');
    assert.match(r4.envelope.result.summary, /stale/, 'summary 须点名 stale');
    // 真签名且与当前输入一致 → passed/0
    writeCiReport(root, ciReportBody(root, 'passed'));
    const r5 = runGithubCi(root, {});
    assert.equal(r5.envelope.result.status, 'passed', '签名完整且与当前控制输入一致 → passed');
    assert.equal(r5.exitCode, 0);
    // 控制输入不可读（未 init 的项目）→ 复核异常按 unverified 不崩
    const bare = mkdtempSync(join(tmpdir(), 'tg-ci-bare-'));
    try {
      writeCiReport(bare, withHash({ schemaVersion: '1.0.0', status: 'passed', blockingCount: 0, externalEffects: [],
        binding: { subject: 'sha256:' + 'a'.repeat(64), validUntil: null } }));
      const r6 = runGithubCi(bare, {});
      assert.equal(r6.envelope.result.status, 'unverified', '控制输入不可读 → unverified（不崩、不阻断）');
      assert.equal(r6.exitCode, 0);
    } finally { rmSync(bare, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-257（P5-7）：stdio 硬上限（kill 后宽限 settle）──
test('stdio：子进程超时/输出超限后孙进程持管道仍按 deadline settle', async () => {
  const { runStdioAdapter } = await import('../adapters/stdio.mjs');
  // 子进程派孙进程持 stdout/stderr 管道后自身被杀（close 可能永不触发）
  const script = "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit',detached:true}).unref();" +
    "setTimeout(()=>{},5000);";
  const t0 = Date.now();
  const r = await runStdioAdapter(script, { capability: 'agent-eval', timeoutMs: 600, maxOutputBytes: 65536 });
  const elapsed = Date.now() - t0;
  assert.equal(r.transport, 'timeout', '须按 deadline 判 timeout（不永久挂起）');
  assert.equal(r.availability, 'unavailable');
  assert.ok(elapsed < 4000, `宽限内 settle（实得 ${elapsed}ms）`);
}, { timeout: 9000 });

// ── 内部任务-257（P5-7 修复轮）：输出超限 transport 判定与宽限 settle（冒烟；非判别性回归）──
// 诚实登记：用旧实现（3fd1a2c8）回放本用例同样通过（`red-overflow-probe.log`）——该场景 close 会快速到达，
// 无法判别「重复 arm」缺陷；重复 arm 的判别性回归承接 内部未决-222（需可注入计时器/流控测试缝）。
test('stdio：输出超限 transport 与宽限 settle（overflow 冒烟）', async () => {
  const { runStdioAdapter } = await import('../adapters/stdio.mjs');
  // 父进程先灌超限输出，再派持管道的孙进程持续写（复现「每块迟数据重挂宽限→无限续期」回归面）。
  // runStdioAdapter 走 `-e` 内联：孙进程必须同样以 `-e childCode` 启动（argv[1] 无文件路径可复用——fix-review 修复）。
  const childCode = "const t=setInterval(()=>{try{process.stdout.write('y'.repeat(1024))}catch{}},20);t.unref();setTimeout(()=>{},6000);";
  const script = "process.stdout.write('x'.repeat(4096));" +
    "const{spawn}=require('node:child_process');" +
    `spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',detached:true}).unref();` +
    "setTimeout(()=>{},6000);";
  const t0 = Date.now();
  const r = await runStdioAdapter(script, { capability: 'agent-eval', timeoutMs: 2500, maxOutputBytes: 1024 });
  const elapsed = Date.now() - t0;
  assert.equal(r.transport, 'overflow', '须判 overflow（宽限只 arm 一次，不被迟数据续期）');
  assert.ok(elapsed < 4000, `宽限内 settle（实得 ${elapsed}ms）`);
}, { timeout: 12000 });

