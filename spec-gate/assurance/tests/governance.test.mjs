// 文件：governance.test.mjs
// 描述：governance.mjs 单元面——四态判定矩阵（手签夹具经 common.mjs canonical 签名）＋
//       normalizePolicy 三形态＋safeRel 拒绝面＋默认 allowedModels 与 capability-matrix hosts 对拍。
//       历史对拍面已随阶段3b 删除。永久件。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { trySymlink } from './symlink-helpers.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJsonBytes, sha256Prefix } from '../common.mjs';
import { DEFAULT_ALLOWED_MODELS } from '../governance.mjs';
import { checkGovernance, recomputeBinding } from '../governance.mjs';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupGovernanceFixture(root) {
  mkdirSync(join(root, '.ai-governance', 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ policy: { id: 'p1', riskLevel: 'low' } }), 'utf8');
  writeFileSync(join(root, '.ai-governance', 'runtime', 'runs', 'r1.json'), '{"x":1}', 'utf8');
  writeFileSync(join(root, 'src.txt'), 'hello', 'utf8');
  return root;
}

/** 手签一份报告（integrityHash 经 common.mjs canonical——与 Python _integrity_digest 同口径）。 */
function signReport(report) {
  const body = Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'integrityHash'));
  return { ...report, integrityHash: sha256Prefix(canonicalJsonBytes(body)) };
}

test('recomputeBinding：subject 五要素结构＋refs/inventory 形态＋排除面', () => {
  const root = setupGovernanceFixture(tmpRoot('dev85-gov-'));
  try {
    const b = recomputeBinding(root);
    assert.match(b.subject, /^sha256:[0-9a-f]{64}$/);
    assert.match(b.contentDigest, /^sha256:/);
    assert.equal(b.changeSetDigest, null, '无 change-set.json→null');
    assert.equal(b.approvalProfile, 'default');
    const paths = b.inventory.map((e) => e.path);
    assert.ok(paths.includes('.ai-governance/config.json'));
    assert.ok(paths.includes('.ai-governance/runtime/runs/r1.json'));
    assert.ok(!paths.some((p) => p.startsWith('.ai-governance/runtime/reports')), 'runtime 报告位不进 inventory');
    assert.ok(b.refs.every((r) => r.sha256.startsWith('sha256:')));
    // subject 文件集排除 .ai-governance 段（EXCLUDED_SEGMENT_NAMES）——src.txt 在但配置不在
    assert.equal(b.evalSuiteDigests.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recomputeBinding 排除面：docs/plans 全树不入 subject（内部未决-135，内部接口-18 §3 口径）', () => {
  const root = setupGovernanceFixture(tmpRoot('dev222-gov-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'evidence.md'), 'x', 'utf8');
    const b1 = recomputeBinding(root);
    // 测试运行期间向 docs/plans 写入（PG5 假红现场）——subject 不得变化
    writeFileSync(join(root, 'docs', 'plans', 'late-write.log'), 'y', 'utf8');
    const b2 = recomputeBinding(root);
    assert.equal(b2.subject, b1.subject, 'docs/plans 写入不得改变 subject');
    assert.equal(b2.contentDigest, b1.contentDigest, 'contentDigest 同口径排除 docs/plans');
    // 对照组：排除不得吞掉 subject 面真变更
    writeFileSync(join(root, 'src.txt'), 'changed', 'utf8');
    const b3 = recomputeBinding(root);
    assert.notEqual(b3.subject, b1.subject, 'src.txt 变化仍入 subject');
    // 内部任务-254（H5/内部验收-21）：排除面收窄——只排除 .ai-governance/runtime，
    // 任意名为 runtime 的业务目录计入 subject（生产/消费两侧同口径）
    mkdirSync(join(root, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(root, 'src', 'runtime', 'x.js'), 'v1', 'utf8');
    const b4 = recomputeBinding(root);
    writeFileSync(join(root, 'src', 'runtime', 'x.js'), 'v2', 'utf8');
    const b5 = recomputeBinding(root);
    assert.notEqual(b5.subject, b4.subject, '名为 runtime 的业务目录（src/runtime）计入 subject');
    mkdirSync(join(root, '.ai-governance', 'runtime', 'evals'), { recursive: true });
    writeFileSync(join(root, '.ai-governance', 'runtime', 'evals', 'r.json'), '{"x":1}', 'utf8');
    const b6 = recomputeBinding(root);
    assert.equal(b6.subject, b5.subject, '.ai-governance/runtime 运行态不计入 subject');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recomputeBinding 拒绝面：配置缺失/损坏/数组键/绝对路径与 .. 引用/同轴冲突', () => {
  const root = tmpRoot('dev85-gov-rej-');
  try {
    assert.throws(() => recomputeBinding(root), /治理配置缺失/);
    mkdirSync(join(root, '.ai-governance'), { recursive: true });
    writeFileSync(join(root, '.ai-governance', 'config.json'), '{bad', 'utf8');
    assert.throws(() => recomputeBinding(root), /不可解析/);
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ evalSuiteFiles: [42] }), 'utf8');
    assert.throws(() => recomputeBinding(root), /字符串数组/);
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ evalSuiteFiles: ['/abs/x'] }), 'utf8');
    assert.throws(() => recomputeBinding(root), /绝对路径/);
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ evalSuiteFiles: ['../esc'] }), 'utf8');
    assert.throws(() => recomputeBinding(root), /越界/);
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ policy: { id: 'p1' }, policyId: 'p2' }), 'utf8');
    assert.throws(() => recomputeBinding(root), /配置冲突/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkGovernance 四态：not-configured/tampered/stale/passed（手签夹具；节形态 present/status/blockingCount）', () => {
  const root = setupGovernanceFixture(tmpRoot('dev85-gov-4s-'));
  try {
    const reportDir = join(root, '.ai-governance', 'runtime', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, 'governance-report.json');

    // not-configured（required 时 blocking；缺省不阻断——治理是可选插件）
    let r = checkGovernance(root, { required: true });
    assert.equal(r.status, 'not-configured');
    assert.equal(r.present, false);
    assert.equal(r.blockingCount, 1);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-GOVERNANCE');
    r = checkGovernance(root);
    assert.equal(r.blockingCount, 0);
    assert.deepEqual(r.diagnostics, []);

    // 坏 JSON＝tampered 档（与缺失不同档）
    writeFileSync(reportPath, '{bad', 'utf8');
    r = checkGovernance(root);
    assert.equal(r.status, 'tampered');
    assert.equal(r.blockingCount, 1);

    const binding = recomputeBinding(root);
    const validUntil = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    const report = signReport({
      schemaVersion: '1.0.0', status: 'passed', generatedAt: '2026-10-18T00:00:00+00:00',
      binding: { ...binding, validUntil },
      sources: { refs: binding.refs, inventory: binding.inventory },
    });
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');
    r = checkGovernance(root);
    assert.equal(r.status, 'passed', '手签完整报告→passed');
    assert.equal(r.blockingCount, 0);

    // tampered：integrityHash 篡改
    const tampered = { ...report, integrityHash: `sha256:${'0'.repeat(64)}` };
    writeFileSync(reportPath, JSON.stringify(tampered), 'utf8');
    r = checkGovernance(root);
    assert.equal(r.status, 'tampered');

    // stale：subject 文件变化
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');
    writeFileSync(join(root, 'src.txt'), 'changed', 'utf8');
    r = checkGovernance(root);
    assert.equal(r.status, 'stale');
    assert.ok(r.diagnostics[0].fixHint.includes('不一致'), r.diagnostics[0].fixHint);

    // stale：validUntil 到界（now 注入未来日）
    writeFileSync(join(root, 'src.txt'), 'hello', 'utf8');
    r = checkGovernance(root, { now: '2099-01-01' });
    assert.equal(r.status, 'stale');

    // blocked：status 非 passed
    const blocked = signReport({ ...report, status: 'blocked' });
    writeFileSync(reportPath, JSON.stringify(blocked), 'utf8');
    r = checkGovernance(root);
    assert.equal(r.status, 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('签名变异裁决：body 篡改未重签→tampered 红（判别力件）', () => {
  const root = setupGovernanceFixture(tmpRoot('dev85-gov-mut-'));
  try {
    const reportDir = join(root, '.ai-governance', 'runtime', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const binding = recomputeBinding(root);
    const report = signReport({
      status: 'passed',
      binding: { ...binding, validUntil: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) },
      sources: { refs: binding.refs, inventory: binding.inventory },
    });
    // body 篡改（status→passedx）保留原 integrityHash：重算必失配
    const mutated = { ...report, status: 'passedx' };
    const reportPath = join(reportDir, 'governance-report.json');
    writeFileSync(reportPath, JSON.stringify(mutated), 'utf8');
    const r = checkGovernance(root);
    assert.equal(r.status, 'tampered', `body 篡改未重签（实测 ${r.status}/${JSON.stringify(r.diagnostics[0]?.fixHint ?? '')}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safeRel 链接出根拒绝（../ 与 symlink 逃逸）', (t) => {
  const root = tmpRoot('dev85-gov-link-');
  const outside = tmpRoot('dev85-gov-out-');
  try {
    mkdirSync(join(root, '.ai-governance'), { recursive: true });
    if (!trySymlink(t, outside, join(root, 'leak'))) return;
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({ evalSuiteFiles: ['leak/x'] }), 'utf8');
    assert.throws(() => recomputeBinding(root), /符号链接逃出/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('DEFAULT_ALLOWED_MODELS 与 capability-matrix hosts 对拍（内部规则-9）', () => {
  const matrixPath = resolve(import.meta.dirname, '../../../plugin-core/capability-matrix.json');
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  assert.deepEqual(DEFAULT_ALLOWED_MODELS.map((item) => item.provider), matrix.hosts);
});

test('changeSetDigest：resources 含非字符串项→digest null（fail-closed；内部任务-241 wp3 复审）', () => {
  const root = tmpRoot('dev241-gov-cs-');
  try {
    mkdirSync(join(root, '.ai-governance', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify({}), 'utf8');
    writeFileSync(
      join(root, '.ai-governance', 'runtime', 'change-set.json'),
      JSON.stringify({ changeSet: { resources: [null, 'x'], order: {} } }),
      'utf8',
    );
    const binding = recomputeBinding(root);
    assert.equal(binding.changeSetDigest, null,
      '非字符串 resources 须按坏件处理（Python sorted(None) TypeError → digest null 同款）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
