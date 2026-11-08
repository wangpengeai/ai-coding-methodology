// 文件：production.test.mjs
// 描述：production 家族实现（唯一实现；迁移史见 内部决策-051）单测（内部决策-051 运行时归一·阶段1b）——model（状态机/信封/
//       waiver/profile）＋policy（推导/裁决）＋store（链/锁/recover）＋门面三例（assess
//       编排＝原 Python 实现（迁移史见 内部决策-051）即无测试的最厚逻辑——计划修订 4）＋读面 BADLINE/OVERSIZE＋
//       变异裁决三处。永久件。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJsonBytes, sha256Hex } from '../common.mjs';
import {
  ALL_STATES, MAIN_CHAIN, TERMINAL_STATES, buildEvent, scanSecrets, transitionLegal, validateProfile, validateWaiver, verifyEventHash,
} from '../production_model.mjs';
import { assessClaim, resolveRequirements, GATE_DOMAINS } from '../production_policy.mjs';
import { _testHooks, advance, createChange, duplicateEventIdMessage, recover, replay, replayFile, reValidChangeId } from '../production_store.mjs';
import { main } from '../production.mjs';

const PROD_CLI = fileURLToPath(new URL('../production.mjs', import.meta.url));

function tmpRoot(p) { return mkdtempSync(join(tmpdir(), p)); }

function fixtureProfile(overrides = {}) {
  return {
    schemaVersion: '1.0.0', deliveryKind: 'service', distribution: 'container',
    scm: { prRequired: true }, environments: ['dev', 'prod'], exposure: 'public',
    dataClasses: [], secretUse: 'none', persistentState: 'database',
    availabilityTier: 'standard', recoveryTier: 'backup-restore',
    acceptanceAuthority: 'owner', evidenceMaxAgeHours: 24,
    vulnerabilityPolicy: 'none', requiredApprovals: [], ...overrides,
  };
}

const EV_ARGS = {
  changeId: '内部变更-1', sequence: 1, previousEventHash: null, fromState: '', toState: 'draft',
  taskId: 'T', profileId: 'service', profileDigest: 'sha256:x', sourceRevision: {},
  commitSha: '', artifactDigest: null, environment: 'dev', evidenceRefs: [], actorRef: 'T',
};
const FIXED = { uuidHex: 'abcd1234', now: '2026-10-18T00:00:00+08:00' };

function readGolden(name) {
  return JSON.parse(readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8'));
}

test('golden event-hash：固定注入下单事件与三事件链哈希逐字节相等（Python 实算）', () => {
  const vec = readGolden('event-hash.json');
  assert.ok(vec.cases.length >= 3, '单事件/extra/三事件链三组');
  for (const c of vec.cases) {
    let prev = null;
    for (const ev of c.events) {
      assert.equal(ev.args.previousEventHash, prev, `${c.name} previousEventHash 链连续`);
      const built = buildEvent(ev.args, ev.opts);
      assert.equal(built.eventHash, ev.eventHash, `${c.name} eventHash 逐字节相等`);
      assert.ok(verifyEventHash(built), `${c.name} 验真`);
      prev = built.eventHash;
    }
  }
});

test('golden secret-patterns：JS scanSecrets 与 Python 期望列逐条相等（redaction 对照列随 parity 复核）', () => {
  const vec = readGolden('secret-patterns.json');
  assert.ok(vec.cases.length >= 13);
  for (const c of vec.cases) {
    assert.deepEqual(scanSecrets(c.text), c.expectedHits, c.name);
  }
  assert.deepEqual(scanSecrets({ nested: ['ok', 'token=abcdef123456'] }), ['凭据键值对: token=abcdef123456…'], '递归与截断形态');
});

test('状态机：主链相邻/终态恒拒/旁路与创世/全状态对拍矩阵', () => {
  assert.ok(transitionLegal('draft', 'pr-open'));
  assert.ok(!transitionLegal('draft', 'merged'));
  assert.ok(!transitionLegal('closed', 'draft'));
  assert.ok(!transitionLegal('abandoned', 'draft'));
  assert.ok(transitionLegal('', 'draft'));
  assert.ok(transitionLegal('deployed', 'rolled-back'));
  assert.ok(transitionLegal('deployed', 'temporary-mitigation'));
  assert.ok(transitionLegal('blocked', 'draft'));
  assert.ok(!transitionLegal('blocked', 'accepted'));
  assert.ok(transitionLegal('temporary-mitigation', 'observing'));
  assert.ok(!transitionLegal('observing', 'draft'));
  assert.equal(ALL_STATES.size, 15);
  assert.equal(MAIN_CHAIN.length, 11);
  // 全状态对拍矩阵：终态恒拒＋非邻主链恒拒（变异裁决锚——改表必红）
  for (const frm of ['', ...ALL_STATES]) {
    for (const to of ALL_STATES) {
      const legal = transitionLegal(frm, to);
      if (TERMINAL_STATES.has(frm)) assert.ok(!legal, `${frm}->${to} 终态恒拒`);
      if (MAIN_CHAIN.includes(frm) && MAIN_CHAIN.includes(to)
        && Math.abs(MAIN_CHAIN.indexOf(to) - MAIN_CHAIN.indexOf(frm)) > 1) {
        assert.ok(!legal, `${frm}->${to} 非邻主链恒拒`);
      }
    }
  }
});

test('事件信封：21 固定键＋extra 合并＋eventHash 验真与排除集', () => {
  const ev = buildEvent(EV_ARGS, FIXED);
  assert.equal(ev.eventId, '内部变更-1-e1-abcd1234');
  assert.equal(Object.keys(ev).length, 21, '固定键 21（含 eventHash）');
  assert.ok(verifyEventHash(ev));
  const ev2 = buildEvent({ ...EV_ARGS, extra: { custom: 'x' } }, FIXED);
  assert.ok(verifyEventHash(ev2), 'extra 合并后哈希覆盖全字段');
  const tampered = { ...ev, toState: 'pr-open' };
  assert.ok(!verifyEventHash(tampered), '篡改后验真失败');
  assert.ok(!verifyEventHash({ foo: 1 }), '无 eventHash 返 false');
});

test('scanSecrets：五模式命中＋前 24 字符截断＋不命中对照', () => {
  const hits = scanSecrets({
    a: 'token = abcdef123456',
    b: 'AKIAIOSFODNN7EXAMPLE',
    c: '-----BEGIN RSA PRIVATE KEY-----',
    d: 'Authorization: Bearer eyJhbGciOi.abcdefghij',
    e: 'ghp_' + 'x'.repeat(25),
    f: 'plain text no secret',
  });
  assert.equal(hits.length, 5);
  assert.ok(hits[0].startsWith('凭据键值对: '));
  assert.ok(hits.every((h) => h.length <= 24 + 24), '命中描述前 24 字符截断');
  assert.deepEqual(scanSecrets({ x: 'nothing here' }), []);
  assert.deepEqual(scanSecrets([['nested', 'sk-' + 'a'.repeat(25)]]).length >= 1 ? ['ok'] : [], ['ok'], '数组递归');
});

test('waiver：五要素/过期/scope 整词覆盖/<CHG>/<环境> 形态/畸形日期', () => {
  const future = new Date(Date.now() + 86400e3 * 30).toISOString().slice(0, 10);
  const w = (o) => ({ authority: 'lead', scope: '内部变更-1/prod', expiresAt: future, alternativeVerification: 'x', residualRisk: 'y', ...o });
  assert.deepEqual(validateWaiver(w({}), '内部变更-1', 'prod'), [true, 'ok']);
  assert.deepEqual(validateWaiver(w({ authority: '' }), '内部变更-1', 'prod'), [false, 'waiver 缺 authority']);
  assert.deepEqual(validateWaiver(w({ expiresAt: '2020-01-01' }), '内部变更-1', 'prod')[0], false, '过期拒');
  assert.deepEqual(validateWaiver(w({ expiresAt: '2026-13-45' }), '内部变更-1', 'prod'), [false, 'waiver expiresAt 非法日期'], '畸形日期拒（字符串比较前置合法性校验——修订 15）');
  assert.deepEqual(validateWaiver(w({ scope: '内部变更-12/prod' }), '内部变更-1', 'prod')[0], false, 'scope 整词不含拒');
  assert.deepEqual(validateWaiver(w({ scope: '内部变更-1|prod' }), '内部变更-1', 'prod'), [true, 'ok'], '| 分隔');
  assert.deepEqual(validateWaiver(w({ scope: 'prod' }), '内部变更-1', 'prod')[0], false, '裸环境不含变更');
  assert.deepEqual(validateWaiver(w({}), '内部变更-1', '')[0], true, '空环境免环境覆盖');
});

test('profile：缺项/枚举/scm.prRequired/非对象', () => {
  assert.deepEqual(validateProfile(fixtureProfile()), [true, 'ok']);
  const bad = fixtureProfile();
  delete bad.recoveryTier;
  assert.deepEqual(validateProfile(bad), [false, 'profile 缺必填字段：recoveryTier']);
  assert.deepEqual(validateProfile(fixtureProfile({ deliveryKind: 'space-station' }))[0], false);
  assert.deepEqual(validateProfile(fixtureProfile({ scm: { noPr: true } })), [false, 'scm 段缺 prRequired']);
  assert.deepEqual(validateProfile(null), [false, 'profile 不是对象']);
});

test('resolveRequirements：service profile 十二域推导＋impact 只抬不降', () => {
  const gates = resolveRequirements(fixtureProfile(), []);
  assert.equal(Object.keys(gates).length, 12);
  assert.equal(gates['pr-ci'].mode, 'required');
  assert.equal(gates['deploy-authorization'].mode, 'required', 'hosting=service');
  assert.equal(gates['rollback-followup'].mode, 'required', '恒 required');
  const gates2 = resolveRequirements(fixtureProfile({ deliveryKind: 'library', distribution: 'none', persistentState: 'none', exposure: 'internal' }), ['security']);
  assert.equal(gates2['deploy-authorization'].mode, 'not-applicable');
  assert.equal(gates2.security.mode, 'required', 'impact security 只抬不降');
  assert.equal(gates2.security.reason, '公网暴露或 security impact', '内联升级条件命中的 reason（升级循环只改写 not-applicable 基线——Python 同款，实测对齐）');
  const gates3 = resolveRequirements(fixtureProfile({ deliveryKind: 'library', distribution: 'none', persistentState: 'none', exposure: 'internal', secretUse: 'none', dataClasses: [] }), ['config']);
  assert.equal(gates3['environment-promotion'].mode, 'required', '基线 N/A 被 impact 升级');
  assert.ok(gates3['environment-promotion'].reason.includes('临时升级'), '升级循环路径的 reason 形态');
  assert.throws(() => resolveRequirements({ bad: 1 }, []), /profile 非法/);
});

test('assessClaim：未知层/短路/无 profile/底线/对象级必备/逐域', () => {
  assert.equal(assessClaim(null, 'bogus', {}, {}).status, 'config-error');
  assert.equal(assessClaim(null, 'code-complete', {}, {}).status, 'passed');
  assert.equal(assessClaim(null, 'merge-ready', {}, {}).status, 'config-error');
  const profile = fixtureProfile();
  const gates = resolveRequirements(profile, []);
  const okStates = Object.fromEntries(GATE_DOMAINS.map((d) => [d, { ...gates[d], status: 'passed' }]));
  const r1 = assessClaim(profile, 'merge-ready', okStates, { commitSha: 'a', prHead: 'a' });
  assert.equal(r1.status, 'passed');
  const r2 = assessClaim(profile, 'merge-ready', okStates, { commitSha: 'a', prHead: 'b' });
  assert.equal(r2.status, 'blocked');
  assert.ok(r2.diagnostics.some((d) => d.ruleId === 'PROD-SECURITY-SUBJECT'));
  const r3 = assessClaim(profile, 'merge-ready', okStates, { scoutActive: true, commitSha: 'a', prHead: 'a' });
  assert.ok(r3.diagnostics.some((d) => d.ruleId === 'PROD-SECURITY-SCOUT'));
  const r4 = assessClaim(profile, 'production-ready', okStates, {});
  assert.ok(r4.diagnostics.some((d) => d.ruleId === 'PROD-CLAIM-SUBJECT' && d.message.includes('artifactDigest')));
  const r5 = assessClaim(profile, 'merge-ready', {}, { commitSha: 'a', prHead: 'a' });
  assert.ok(r5.diagnostics.some((d) => d.ruleId === 'PROD-CLAIM-DOMAIN-MISSING'));
  const future = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  const waivedStates = { 'pr-ci': { mode: 'required', status: 'waived', waiver: { authority: 'x', scope: '内部变更-1/prod', expiresAt: future, alternativeVerification: 'x', residualRisk: 'y' } } };
  const r6 = assessClaim(profile, 'merge-ready', waivedStates, { commitSha: 'a', prHead: 'a', changeId: '内部变更-1', environment: 'prod' });
  assert.equal(r6.status, 'passed', '合法 waiver 放行');
});

test('内部任务-242 §三-3：replay 与 replayFile 同坏行输入产同 ruleId 序列前缀（stopOnFirst 显式）', () => {
  const root = tmpRoot('dev242-scan-');
  try {
    createChange(root, 'T-1', fixtureProfile());
    advance(root, '内部变更-1', 'pr-open', [{ sourceRef: 'pr-1' }], { commitSha: 'abc', taskId: 'T-1' });
    const path = join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    writeFileSync(path, [...lines, lines[1]].join('\n') + '\n', 'utf8');
    const full = replay(root, '内部变更-1');
    const probe = replayFile(path);
    const fullIds = full.diagnostics.map((d) => d.ruleId);
    const probeIds = probe.diagnostics.map((d) => d.ruleId);
    assert.ok(fullIds.includes('PROD-INTEGRITY-SEQUENCE'), 'replay 全量收集须见 sequence 断裂');
    assert.deepEqual(probeIds, fullIds.slice(0, probeIds.length), '首错停止且前缀逐项同码（单源 scanEvents）');
    assert.ok(probeIds.length < fullIds.length, 'stopOnFirst 差异显式：replayFile 只到首错');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('store：create→advance 全链＋断链/篡改/迁移非法矩阵＋锁占用', () => {
  const root = tmpRoot('dev86-store-');
  try {
    const created = createChange(root, 'T-1', fixtureProfile());
    assert.ok(created.ok, JSON.stringify(created));
    assert.equal(created.changeId, '内部变更-1');
    let st = replay(root, '内部变更-1');
    assert.ok(st.ok && st.state === 'draft' && st.events === 1);
    let r = advance(root, '内部变更-1', 'pr-open', [{ sourceRef: 'pr-1' }], { commitSha: 'abc', taskId: 'T-1' });
    assert.ok(r.ok, JSON.stringify(r));
    r = advance(root, '内部变更-1', 'merged', [], { notApplicable: [{ domain: 'deploy', reason: 'library' }] });
    assert.ok(!r.ok && r.error.includes('非法迁移'), '非邻主链迁移 transition_legal 先拒（N/A 跨级检查在其后——Python 同序，实测对齐）');
    r = advance(root, '内部变更-1', 'merge-ready', []);
    assert.ok(r.ok, '相邻推进合法');
    // 篡改断链
    const path = join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    writeFileSync(path, [...lines, lines[1]].join('\n') + '\n', 'utf8');
    st = replay(root, '内部变更-1');
    assert.ok(!st.ok);
    // T02（内部任务-241）：不得用「ruleId 存在」恒真断言——须断到具体完整性代码（重复事件＝DUP）
    assert.ok(st.diagnostics.some((d) => d.ruleId === 'PROD-INTEGRITY-DUP'), '重复事件须命中 PROD-INTEGRITY-DUP');
    // recover：损坏原件保留 .corrupt 副本（内部验收-3），副本字节须等于篡改前内容
    const beforeRecover = readFileSync(path, 'utf8');
    const rec = recover(root, '内部变更-1');
    assert.ok(rec.ok);
    assert.notEqual(rec.action, 'clean', '有损坏须截断');
    assert.ok(rec.corruptCopy, 'recover 须保留损坏原件副本');
    assert.equal(readFileSync(join(root, '.sdd', 'production', 'changes', rec.corruptCopy), 'utf8'), beforeRecover,
      'corrupt 副本与篡改前原文字节一致（原件保留）');
    st = replay(root, '内部变更-1');
    assert.ok(st.ok, '恢复后链完整');
    // 锁占用：单胜
    writeFileSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.lock'), 'other');
    r = advance(root, '内部变更-1', 'merged', []);
    assert.ok(!r.ok && r.error.includes('锁被占用'));
    rmSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.lock'));
    // 陈旧锁回收
    writeFileSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.lock'), 'stale');
    const old = new Date(Date.now() - 400 * 1000);
    utimesSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.lock'), old, old);
    r = advance(root, '内部变更-1', 'merged', []);
    assert.ok(r.ok, '陈旧锁回收后推进成功');
    assert.equal(reValidChangeId('内部变更-42'), true);
    assert.equal(reValidChangeId('内部变更-0'), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('store 读面：BADLINE（坏行/半行）与 OVERSIZE 诊断', () => {
  const root = tmpRoot('dev86-read-');
  try {
    createChange(root, 'T', fixtureProfile());
    const path = join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n{"broken": \n`, 'utf8');
    const st = replay(root, '内部变更-1');
    assert.ok(!st.ok);
    assert.ok(st.diagnostics.some((d) => d.ruleId === 'PROD-INTEGRITY-BADLINE'), '坏行诊断');
    writeFileSync(path, `${readFileSync(path, 'utf8').split('\n')[0]}\n${'x'.repeat(1 << 21)}\n`, 'utf8');
    const st2 = replay(root, '内部变更-1');
    assert.ok(st2.diagnostics.some((d) => d.ruleId === 'PROD-INTEGRITY-LINE-OVERSIZE'), '超限行诊断');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('门面三例：assess 漂移注入→blocked 退 1／config-error→2／passed→0（原 Python 实现（迁移史见 内部决策-051）即无测试的最厚逻辑）', () => {
  const root = tmpRoot('dev86-cli-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), JSON.stringify(fixtureProfile()), 'utf8');
    writeFileSync(join(root, 'ctx.json'), JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { mode: 'not-applicable', status: 'passed' } } }), 'utf8');
    // MODE-DRIFT：自报 mode 与推导不符→blocked 退 1
    let rc = main(['assess', '--change', '内部变更-9', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root);
    assert.equal(rc, 1, '漂移强制 blocked');
    // config-error：claim 非法→2
    rc = main(['assess', '--change', '内部变更-9', '--claim', 'galactic', '--context', join(root, 'ctx.json')], root);
    assert.equal(rc, 2);
    // passed：对齐推导的自报→0
    writeFileSync(join(root, 'ctx.json'), JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { mode: 'required', status: 'passed' } } }), 'utf8');
    rc = main(['assess', '--change', '内部变更-9', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root);
    assert.equal(rc, 0, '全过→0');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('变异裁决①：状态机表临时改一迁移→矩阵红', () => {
  // 判别力件（行为断言替代源码变异——transitionLegal 的 ''→draft 创世行删除即红）
  assert.ok(transitionLegal('', 'draft'), '创世迁移在表（删除即本断言红）');
  assert.ok(!transitionLegal('draft', 'deployed'), '跨级不在表');
});

test('变异裁决②：eventHash 排除集临时加字段→verify 红', () => {
  const ev = buildEvent(EV_ARGS, FIXED);
  const withExtra = { ...ev, injected: 'field' };
  assert.ok(!verifyEventHash(withExtra), '额外字段（未参与哈希）验真必失败——排除集判别力');
});

// ── 门①（正确性维）回归钉：B1-B4＋N1/N2/N3/N6/N7/N8 ──

test('门① B1：assess 不得用推导态补齐缺域/缺 mode（原 Python 实现（迁移史见 内部决策-051） DOMAIN-MISSING/MODE-DRIFT 阻断）', () => {
  const root = tmpRoot('dev86-b1-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), JSON.stringify(fixtureProfile()), 'utf8');
    // 缺域：context 无 gateStates → DOMAIN-MISSING blocked 退 1
    writeFileSync(join(root, 'ctx1.json'), JSON.stringify({ commitSha: 'a', prHead: 'a' }), 'utf8');
    let rc = main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx1.json')], root);
    assert.equal(rc, 1, '缺域必须阻断（旧实现会补推导态放行）');
    // 缺 mode：自报 pr-ci 只有 status → MODE-DRIFT blocked 退 1
    writeFileSync(join(root, 'ctx2.json'), JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { status: 'passed' } } }), 'utf8');
    rc = main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx2.json')], root);
    assert.equal(rc, 1, '缺 mode 必须判漂移（旧实现跳过检查）');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('门① B2：--project-root 全局参数＋绝对 context 路径不重复拼接', () => {
  const root = tmpRoot('dev86-b2-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), JSON.stringify(fixtureProfile()), 'utf8');
    const created = createChange(root, 'T', fixtureProfile());
    assert.ok(created.ok);
    assert.equal(main(['--project-root', root, 'status', '--change', '内部变更-1'], process.cwd()), 0, '全局 --project-root + status');
    const ctxAbs = join(root, 'abs-ctx.json');
    writeFileSync(ctxAbs, JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { mode: 'required', status: 'passed' } } }), 'utf8');
    assert.equal(main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', ctxAbs], root), 0, '绝对 context 路径');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('门① B3/N1：waiver 用本地日期判定＋显式 null 要素按原 Python 实现（迁移史见 内部决策-051）视为已提供', () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = { authority: 'lead', scope: '内部变更-1/prod', expiresAt: today, alternativeVerification: 'x', residualRisk: 'y' };
  assert.deepEqual(validateWaiver(base, '内部变更-1', 'prod'), [true, 'ok'], '到期日当天仍有效（date.today 本地语义）');
  assert.equal(validateWaiver({ ...base, expiresAt: '2020-01-01' }, '内部变更-1', 'prod')[0], false);
  assert.deepEqual(validateWaiver({ ...base, authority: null }, '内部变更-1', 'prod'), [true, 'ok'], '原 Python 实现（迁移史见 内部决策-051） str(None)="None" 非空');
  assert.equal(validateWaiver({ ...base, authority: undefined }, '内部变更-1', 'prod')[0], false, '缺键仍拒');
});

test('门① B4：退出码分层（坏 profile JSON→1；参数坏 JSON→2〔内部任务-241 E02 契约变更〕；缺文件 OSError→2）', () => {  const root = tmpRoot('dev86-b4-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), '{bad json', 'utf8');
    writeFileSync(join(root, 'ctx.json'), JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { mode: 'required', status: 'passed' } } }), 'utf8');
    assert.equal(main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root), 1, '坏 profile JSON→1');
    assert.equal(main(['init', '--task-id', 'T', '--profile', join(root, 'missing.json')], root), 2, 'profile 缺文件→2');
    assert.equal(main(['advance', '--change', '内部变更-1', '--to', 'pr-open', '--evidence', '{bad'], root), 2, '坏 evidence JSON＝参数错误→2（与 cli.mjs 同类参数对齐）');
    assert.equal(main(['advance', '--change', '内部变更-1', '--to', 'pr-open', '--not-applicable', '{bad'], root), 2, '坏 not-applicable JSON→2');
    assert.equal(main(['status', '--change', 'BAD'], root), 1, '坏 changeId→1（bug-for-bug）');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('门① N2：秘密扫描跟随 Python 空白类与码点截断', () => {
  assert.equal(scanSecrets('token\x1c=abcdefgh').length, 1, 'U+001C 属 Python \\s');
  assert.equal(scanSecrets('token\x85=abcdefgh').length, 1, 'U+0085 属 Python \\s');
  assert.equal(scanSecrets('token\ufeff=abcdefgh').length, 0, 'U+FEFF 不属 Python \\s');
  const emoji = scanSecrets(`token=${'😀'.repeat(20)}`)[0];
  assert.equal([...emoji].filter((c) => c === '😀').length, 18, '按码点截 24：token= 后 18 个 emoji');
});

test('门① N3/N6/N7/N8：尾换行 changeId／空 taskId 真值回退／context changeId 保留／原型链键', () => {
  assert.equal(reValidChangeId('内部变更-1\n'), true, 'Python $ 允许单个尾随换行');
  assert.equal(reValidChangeId('内部变更-1\n\n'), false);
  const root = tmpRoot('dev86-n-');
  try {
    const created = createChange(root, 'T-1', fixtureProfile());
    assert.ok(created.ok);
    const r = advance(root, '内部变更-1', 'pr-open', [], { taskId: '' });
    assert.ok(r.ok);
    const lines = readFileSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(JSON.parse(lines[lines.length - 1]).taskId, 'T-1', '空串回退建链 taskId（原 Python 实现（迁移史见 内部决策-051） or 语义）');
    // N7：context 自带 changeId 优先于 --change（原 Python 实现（迁移史见 内部决策-051） setdefault）
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), JSON.stringify(fixtureProfile()), 'utf8');
    const future = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
    writeFileSync(join(root, 'ctx.json'), JSON.stringify({
      changeId: '内部变更-9', environment: 'prod', commitSha: 'a', prHead: 'a',
      gateStates: { 'pr-ci': { mode: 'required', status: 'waived', waiver: { authority: 'x', scope: '内部变更-9/prod', expiresAt: future, alternativeVerification: 'x', residualRisk: 'y' } } },
    }), 'utf8');
    assert.equal(main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root), 0, 'context changeId=内部变更-9 使 waiver scope 生效');
    // N8：原型链键不得 TypeError
    assert.ok(resolveRequirements(fixtureProfile(), ['toString']));
    assert.equal(assessClaim(fixtureProfile(), 'toString', {}, {}).status, 'config-error');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('变异裁决③：advance 写后回放失败→截断回滚到写前长度（B-M11-4；终审发现 6）', () => {
  const root = tmpRoot('dev86-rollback-');
  try {
    createChange(root, 'T', fixtureProfile());
    const path = join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl');
    const before = readFileSync(path, 'utf8');
    _testHooks.afterAppend = () => {
      writeFileSync(path, `${readFileSync(path, 'utf8')}{"broken":\n`, 'utf8');
    };
    const r = advance(root, '内部变更-1', 'pr-open', []);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('已回滚'), r.error);
    assert.equal(readFileSync(path, 'utf8'), before, '文件截回写前内容');
    assert.ok(replay(root, '内部变更-1').ok, '链保持写前完好');
  } finally {
    _testHooks.afterAppend = null;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('replay：省略 previousEventHash 键的单事件按 Python dict.get 语义认链（终审发现 9）', () => {
  const root = tmpRoot('dev86-nokey-');
  try {
    const ev = buildEvent({ ...EV_ARGS, previousEventHash: null }, FIXED);
    delete ev.previousEventHash;
    const body = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'eventHash'));
    ev.eventHash = `sha256:${sha256Hex(canonicalJsonBytes(body))}`;
    mkdirSync(join(root, '.sdd', 'production', 'changes'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8');
    const st = replay(root, '内部变更-1');
    assert.ok(st.ok, JSON.stringify(st.diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('production.mjs 直跑：0/1/2 三态＋未知旗标退 2＋--flag=value（终审阻塞 1）', () => {
  const root = tmpRoot('dev86-direct-');
  try {
    const profilePath = join(root, 'p.json');
    writeFileSync(profilePath, JSON.stringify(fixtureProfile()), 'utf8');
    const run = (args) => spawnSync(process.execPath, [PROD_CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run(['--project-root', root, 'init', '--task-id', 'T', '--profile', profilePath]).status, 0);
    assert.equal(run(['--project-root', root, 'status', '--change=内部变更-1']).status, 0, '--flag=value 受理');
    assert.equal(run(['--project-root', root, 'status', '--change', 'BAD']).status, 1);
    assert.equal(run(['--project-root', root, 'status']).status, 2);
    assert.equal(run(['--project-root', root, 'status', '--change', '内部变更-1', '--bogus', 'x']).status, 2, '未知旗标退 2');
    assert.equal(run(['--project-root', root, 'status', '--change', '内部变更-1', 'extra']).status, 2, '多余位置参数退 2');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('S04（内部任务-241）：秘密扫描补 URL 凭据/gh[pousr]_/裸 Bearer；普通 URL 与短串不误报', () => {
  assert.ok(scanSecrets('see https://user:pass@example.com/x').some((h) => h.startsWith('URL 凭据')), 'URL 凭据命中');
  assert.ok(scanSecrets(`gho_${'A'.repeat(30)}`).some((h) => h.includes('裸令牌')), 'gho_ 前缀命中');
  assert.ok(scanSecrets(`tok ghu_${'b'.repeat(30)}`).some((h) => h.includes('裸令牌')), 'ghu_ 前缀命中');
  assert.ok(scanSecrets('Bearer abcdefghij').some((h) => h.includes('裸 Bearer')), '裸 Bearer 命中');
  assert.equal(scanSecrets('https://example.com/path').length, 0, '普通 URL 不误报');
  assert.equal(scanSecrets('base64 aGVsbG8=').length, 0, '短 base64 说明串不误报（长 base64 不进 fail-closed 判定）');
});

test('门① B4 补：JSON 根非对象/非法 UTF-8 按原 Python 实现（迁移史见 内部决策-051） ValueError→1', () => {
  const root = tmpRoot('dev86-b4x-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    writeFileSync(join(root, 'ctx.json'), JSON.stringify({ commitSha: 'a', prHead: 'a', gateStates: { 'pr-ci': { mode: 'required', status: 'passed' } } }), 'utf8');
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), '[]', 'utf8');
    assert.equal(main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root), 1, '根非对象→1');
    writeFileSync(join(root, '.sdd', 'delivery-profile.json'), Buffer.from([0xff, 0xfe, 0x00]), 'utf8');
    assert.equal(main(['assess', '--change', '内部变更-1', '--claim', 'merge-ready', '--context', join(root, 'ctx.json')], root), 1, '非法 UTF-8→1');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('D01（内部任务-241）：JSONL 含合法非对象行 → replay 报 BADLINE 不抛、recover 截断不抛', () => {
  const root = tmpRoot('dev241-d01-');
  try {
    const r = createChange(root, 'T', fixtureProfile());
    assert.equal(r.ok, true, r.error ?? '');
    const file = join(root, '.sdd', 'production', 'changes', '内部变更-1.jsonl');
    writeFileSync(file, 'null\n', { flag: 'a' });
    const st = replay(root, '内部变更-1');
    assert.equal(st.ok, false, '非对象行必须作为链损坏呈现而非进程崩溃');
    assert.ok(st.diagnostics.some((d) => d.ruleId === 'PROD-INTEGRITY-BADLINE'), '须产 BADLINE 诊断');
    const rec = recover(root, '内部变更-1');
    assert.equal(rec.ok, true, '修复通道对该类损坏不得崩溃');
    assert.equal(rec.action, 'truncated');
    assert.ok(rec.corruptCopy, '损坏原件保留 .corrupt 副本');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('redaction 泄漏面：production_store 诊断只出标签与计数（不回显原文）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prod-leak-'));
  try {
    const ev = buildEvent({ ...EV_ARGS, evidenceRefs: ['token=abcdef123456 泄漏样例'] }, FIXED);
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
    const r = replayFile(file);
    const secrets = r.diagnostics.filter((d) => d.ruleId === 'PROD-SECURITY-SECRETS');
    assert.equal(secrets.length, 1, `恰一条 SECRETS 诊断：${JSON.stringify(r.diagnostics)}`);
    const msg = secrets[0].message;
    assert.ok(!msg.includes('abcdef123456'), '诊断不得回显原文');
    assert.ok(!msg.includes('token='), '诊断不得回显键值原文');
    assert.ok(msg.includes('凭据键值对'), '须保留规则标签');
    assert.ok(/命中 \d+ 处/.test(msg), '须含命中计数');
    assert.equal(secrets[0].severity, 'blocking');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production_store：eventId 序号化不回显原文', () => {
  const msg = duplicateEventIdMessage(7);
  assert.match(msg, /event#7/, '诊断按序号定位');
  assert.ok(!msg.includes('AKIA'), '不得回显可变 eventId 原文');
});

