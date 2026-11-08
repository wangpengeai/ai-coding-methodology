// 文件：probes.test.mjs
// 描述：probes.test.mjs（probes.mjs 单元面；原 Python 测试移植，历史文件已于阶段3b 删除）——
//       语义以 probes.mjs 源码为准：判据项＝{criterion, evidenceRef, probe} 嵌套形态、
//       坏探针经 runOne 漏斗转 CONFIG 诊断不抛、路径缺失转 ASSERT 诊断、json-field-eq
//       宽松相等而 jsonl 严格类型。历史件（阶段3 拆 Python 面前置；同模块 JS 测试绿）。
//       注入缝：命名 opts（spawnImpl/platform/env/signaturesPath/homeOverride）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { trySymlink } from './symlink-helpers.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACL_RIGHTS, DEFAULT_IGNORE, HOST_ENV_OVERRIDE, PATH_BASES, PATH_OPTIONAL_TYPES, PROBE_TYPES,
  ProbeConfigError, _jsonEqInternals, guidOk, jsonDotted, loadHostSignatures, parseAuditpolInclusion,
  parseIcaclsDeny, resolveProbePath, runProbes, treeHash,
} from '../probes.mjs';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const GOLDEN = join(TESTS, 'golden');
const treeVector = JSON.parse(readFileSync(join(GOLDEN, 'dir-tree-hash.json'), 'utf8'));

function materialize(base, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const target = join(base, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return base;
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 判据包装（生产者/验证者分离形态：探针在 probe 键下）。 */
const C = (probe) => ({ criterion: 'test', evidenceRef: 'test', probe });

test('常量族：八类词表/路径可选集/双基/默认忽略/ACL 权限/宿主 env 覆盖', () => {
  assert.deepEqual(PROBE_TYPES, ['file-exists', 'file-sha256', 'json-field-eq', 'jsonl-record-field-eq', 'dir-tree-hash', 'acl-state', 'audit-policy-state', 'host-app-present']);
  assert.deepEqual([...PATH_OPTIONAL_TYPES].sort(), ['audit-policy-state', 'host-app-present']);
  assert.deepEqual(PATH_BASES, ['project', 'user-home']);
  assert.deepEqual(DEFAULT_IGNORE, ['__pycache__', '.mimosa', '*.pyc']);
  assert.equal(ACL_RIGHTS.size, 20);
  for (const r of ['F', 'M', 'RX', 'GA', 'RD']) assert.ok(ACL_RIGHTS.has(r), `ACL 白名单含 ${r}`);
  assert.deepEqual(HOST_ENV_OVERRIDE, { zcode: 'ZCODE_APP_ROOT', mcode: 'MINIMAX_APP_ROOT', kimi: 'KIMI_APP_ROOT', dsh: 'DSH_APP_ROOT' });
});

test('guidOk：36 位花括号 GUID 形态', () => {
  assert.ok(guidOk('{0A1B2C3D-4E5F-6a7b-8c9d-0E1F2A3B4C5D}'));
  assert.ok(!guidOk('0A1B2C3D-4E5F-6a7b-8c9d-0E1F2A3B4C5D'));
  assert.ok(!guidOk('{0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5}'));
  assert.ok(!guidOk('{0a1b2c3d_4e5f-6a7b-8c9d-0e1f2a3b4c5d}'));
});

test('parseIcaclsDeny：DENY 段位置判定＋前邻空白防子串＋无 DENY/无匹配返回 null', () => {
  const text = 'f.txt EVIL\\acct:(DENY)(N,WD,AD)\nBUILTIN\\Users:(F)\n';
  const rights = parseIcaclsDeny(text, 'EVIL\\acct');
  assert.deepEqual([...rights].sort(), ['AD', 'N', 'WD'].sort(), '权限按逗号拆（Python 同款——分号系 icacls 标志位形态不拆）');
  assert.equal(parseIcaclsDeny('acct2:(F)', 'acct'), null, '子串不匹配');
  assert.equal(parseIcaclsDeny('a X:(F)', 'X'), null, '无 DENY 段→null');
  assert.equal(parseIcaclsDeny('别的账户:(DENY, F)', 'acct'), null, '无匹配行→null');
});

test('parseAuditpolInclusion：按 GUID 值定位列（大小写/引号不敏感）＋下一列空/非空＋缺行抛', () => {
  const csv = 'Machine Name,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting\r\nPC,File System,{0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D},Failure,\r\nPC,Other,{FFFFFFFF-0000-0000-0000-000000000000},,\r\n';
  assert.equal(parseAuditpolInclusion(csv, '{0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d}'), 'not-empty');
  assert.equal(parseAuditpolInclusion(csv, '{ffffffff-0000-0000-0000-000000000000}'), 'empty');
  const csvPolicyTarget = 'Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting\r\nPC,System,File System,{0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D},Failure,\r\nPC,System,Other,{FFFFFFFF-0000-0000-0000-000000000000},,\r\n';
  assert.equal(parseAuditpolInclusion(csvPolicyTarget, '{0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d}'), 'not-empty');
  assert.equal(parseAuditpolInclusion(csvPolicyTarget, '{ffffffff-0000-0000-0000-000000000000}'), 'empty');
  const csvQuoted = 'Machine Name,Subcategory,Subcategory GUID,Inclusion Setting\r\n"PC","File System","{0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D}","Failure"\r\n';
  assert.equal(parseAuditpolInclusion(csvQuoted, '{0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d}'), 'not-empty', '字段引号不参与值比较');
  assert.throws(() => parseAuditpolInclusion(csv, '{11111111-2222-3333-4444-555555555555}'));
});

test('jsonDotted：点号+[i] 方言（路径不存在抛、括号坏 CONFIG、裸数字点号＝普通键名）', () => {
  const doc = { a: { b: [{ c: 7 }], 'd.x': 8 }, '0': 'zero' };
  assert.equal(jsonDotted(doc, 'a.b[0].c'), 7);
  assert.throws(() => jsonDotted(doc, 'a.d.x'), /a\.d\.x/, "键 'd.x' 存在但 field 点号拆词后按 d 段取——Python 同款抛");
  assert.equal(jsonDotted(doc, '0'), 'zero', '裸数字作键名可直取');
  assert.throws(() => jsonDotted(doc, 'a.b.0.c'), /a\.b\.0\.c/, '裸数字点号段＝普通键名→不存在抛');
  assert.throws(() => jsonDotted(doc, 'a.b[0'), /括号不闭合/, '括号词法＝CONFIG');
  assert.throws(() => jsonDotted(doc, 'a.b[x]'), /下标/, '下标非数字＝CONFIG');
  assert.throws(() => jsonDotted(null, 'a'));
});

test('resolveProbePath：双基/形态坏/非法 base/绝对与 .. 拒绝/穿越拒绝/反斜杠归一', (t) => {
  const root = tmpRoot('dev85-rpp-');
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'f.txt'), 'x');
    // realpath 形态断言（macOS tmpdir symlink：/var→/private/var——内部任务-121 形态分裂同族，
    // 与 Python realpath 行为逐字对齐：resolve 结果即 realpath 后形态）
    assert.equal(resolveProbePath(root, { base: 'project', rel: 'sub/f.txt' }), realpathSync(join(root, 'sub', 'f.txt')));
    assert.equal(resolveProbePath(root, { base: 'project', rel: 'sub\\f.txt' }), realpathSync(join(root, 'sub', 'f.txt')), '反斜杠归一 /');
    const outside = tmpRoot('dev85-out-');
    if (!trySymlink(t, outside, join(root, 'sub', 'link'))) return;
    assert.throws(() => resolveProbePath(root, { base: 'project', rel: 'sub/link/x' }), ProbeConfigError, 'symlink 穿越拒绝');
    assert.throws(() => resolveProbePath(root, { base: 'project', rel: '/abs.txt' }), ProbeConfigError);
    assert.throws(() => resolveProbePath(root, { base: 'project', rel: '../esc.txt' }), ProbeConfigError);
    assert.throws(() => resolveProbePath(root, { base: 'invalid', rel: 'x' }), ProbeConfigError);
    assert.throws(() => resolveProbePath(root, { rel: 'x' }), ProbeConfigError, '形态坏：缺 base');
    assert.equal(resolveProbePath(root, { base: 'user-home', rel: 'x' }, { homeOverride: outside }), join(realpathSync(outside), 'x'), 'home 覆盖缝（基 realpath＋rel 拼接——宽松语义）');
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('treeHash：黄金向量全 case（通配全形态/目录级忽略/空树/中文嵌套/码点排序）', () => {
  for (const c of treeVector.cases) {
    const base = tmpRoot(`dev85-th-${c.name}-`);
    try {
      const root = materialize(join(base, 'tree'), c.tree);
      assert.equal(treeHash(root, c.ignores, false), c.expectedHex, c.name);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('treeHash caseFold 开关：win32 默认忽略大小写，与 POSIX golden（false）哈希不同', () => {
  const base = tmpRoot('dev85-th-case-');
  try {
    const root = materialize(join(base, 'tree'), { 'a.txt': 'same' });
    assert.notEqual(treeHash(root, ['A.TXT'], false), treeHash(root, ['A.TXT'], true), 'caseFold=false 保留 a.txt；true 忽略它');
    assert.equal(
      treeHash(root, ['A.TXT']),
      treeHash(root, ['A.TXT'], process.platform === 'win32'),
      '平台默认 caseFold 与显式值一致（win32=true，POSIX=false）',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('treeHash 分帧形态钉子：同内容异名不同哈希（判别力件）', () => {
  const base = tmpRoot('dev85-th-frame-');
  try {
    const t1 = materialize(join(base, 't1'), { 'a.txt': 'same' });
    const t2 = materialize(join(base, 't2'), { 'b.txt': 'same' });
    assert.notEqual(treeHash(t1, []), treeHash(t2, []));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runProbes：判据嵌套形态＋纯文本跳过（legacy）＋非对象判据抛', () => {
  const root = tmpRoot('dev85-crit-');
  try {
    writeFileSync(join(root, 'a.txt'), 'x');
    let r = runProbes(root, [
      { criterion: '人工复核', evidenceRef: 'e' }, // 无 probe 键＝纯文本人核证据
      C({ type: 'file-exists', path: { base: 'project', rel: 'a.txt' } }),
    ]);
    assert.deepEqual([r.total, r.passed, r.failed, r.legacy], [1, 1, 0, false]);
    r = runProbes(root, [{ criterion: '仅文本' }]);
    assert.deepEqual([r.total, r.legacy], [0, true]);
    assert.throws(() => runProbes(root, [42]), ProbeConfigError, '项非对象→抛（gate 捕获）');
    assert.throws(() => runProbes(root, ['字符串也是非对象']), ProbeConfigError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：file-exists 正反/kind 三态（fail 走 ASSERT 诊断不抛）', () => {
  const root = tmpRoot('dev85-fe-');
  try {
    writeFileSync(join(root, 'a.txt'), 'x');
    mkdirSync(join(root, 'd'));
    let r = runProbes(root, [
      C({ type: 'file-exists', path: { base: 'project', rel: 'a.txt' }, expect: true }),
      C({ type: 'file-exists', path: { base: 'project', rel: 'no.txt' }, expect: false }),
      C({ type: 'file-exists', path: { base: 'project', rel: 'd' }, kind: 'dir' }),
      C({ type: 'file-exists', path: { base: 'project', rel: 'd' }, kind: 'file', expect: false }),
    ]);
    assert.deepEqual([r.total, r.passed, r.failed], [4, 4, 0]);
    r = runProbes(root, [C({ type: 'file-exists', path: { base: 'project', rel: 'no.txt' } })]);
    assert.equal(r.failed, 1);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：file-sha256 前缀剥离/不符 ASSERT/目标缺失 ASSERT/expect 空 CONFIG', () => {
  const root = tmpRoot('dev85-sha-');
  try {
    writeFileSync(join(root, 'f.bin'), 'payload');
    const hex = createHash('sha256').update('payload').digest('hex');
    let r = runProbes(root, [C({ type: 'file-sha256', path: { base: 'project', rel: 'f.bin' }, expect: `sha256:${hex}` })]);
    assert.equal(r.failed, 0);
    r = runProbes(root, [C({ type: 'file-sha256', path: { base: 'project', rel: 'f.bin' }, expect: `sha256:${'0'.repeat(64)}` })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT');
    r = runProbes(root, [C({ type: 'file-sha256', path: { base: 'project', rel: 'gone.bin' }, expect: hex })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT', '目标缺失＝ASSERT 诊断（非 CONFIG 非抛）');
    r = runProbes(root, [C({ type: 'file-sha256', path: { base: 'project', rel: 'f.bin' }, expect: '' })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：json-field-eq 点号取值/ref 双读/last-segment/坏 transform CONFIG/宽松相等（True==1 族）', () => {
  const root = tmpRoot('dev85-jfe-');
  try {
    writeFileSync(join(root, 'a.json'), JSON.stringify({ v: 'Name', n: 1, env: 'PROD' }));
    writeFileSync(join(root, 'b.json'), JSON.stringify({ full: '/x/y/Name', env: 'PROD' }));
    let r = runProbes(root, [
      C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'v', expect: 'Name' }),
      // ref 双读＋last-segment：期望值取 b.json 的 full 字段末段（038 installPath 末段==version 场景）
      C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'v', ref: { refPath: 'b.json', refField: 'full', refTransform: 'last-segment' } }),
      C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'env', ref: { refPath: 'b.json', refField: 'env' } }),
      C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'n', expect: true }), // 宽松：1==True（Python != 语义）
    ]);
    assert.equal(r.failed, 0, JSON.stringify(r.diagnostics));
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'n', expect: '1' })]);
    assert.equal(r.failed, 1, 'str vs number 不等（Python != 语义）');
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'nope', expect: 'x' })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT', '路径不存在→ASSERT 诊断');
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'v', ref: { refPath: 'b.json', refField: 'full', refTransform: 'bogus' } })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', '坏 transform→CONFIG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：jsonl 末条为准/严格类型/match 两形态/坏行与数组缺键 CONFIG/ref 拒', () => {
  const root = tmpRoot('dev85-jle-');
  try {
    writeFileSync(join(root, 'l.jsonl'), '{"e":"open","t":"A"}\n{"e":"close","t":"B"}\n');
    let r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: { e: 'close' }, field: 't', expect: 'B' })]);
    assert.equal(r.failed, 0);
    r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: [{ field: 'e', equals: 'close' }], field: 't', expect: 'A' })]);
    assert.equal(r.failed, 1, '末条为准：close 行 t=B');
    r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: { e: 'open' }, field: 't', expect: 1 })]);
    assert.equal(r.failed, 1, "严格类型：'A' ≠ 1（jsonl 禁 True==1 同族）");
    writeFileSync(join(root, 'bad.jsonl'), 'not-json\n');
    r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'bad.jsonl' }, match: { e: 'x' }, field: 't', expect: 'y' })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', '坏行→CONFIG');
    r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: [{ field: 'e' }], field: 't', expect: 'B' })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', '数组项缺 equals→CONFIG');
    r = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: { e: 'x' }, field: 't', expect: 'y', ref: { refPath: 'l.jsonl', refField: 't' } })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', 'ref 不支持→CONFIG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：dir-tree-hash 判据口径（DEFAULT_IGNORE 合成＋目标缺失 ASSERT）', () => {
  const root = tmpRoot('dev85-dth-');
  try {
    writeFileSync(join(root, 'keep.txt'), 'k');
    mkdirSync(join(root, '__pycache__'));
    writeFileSync(join(root, '__pycache__', 'junk.pyc'), 'j');
    const inner = createHash('sha256').update('k').digest('hex');
    const treeHex = createHash('sha256').update(`keep.txt\n${inner}\n`).digest('hex');
    let r = runProbes(root, [C({ type: 'dir-tree-hash', path: { base: 'project', rel: '.' }, expect: `sha256:${treeHex}` })]);
    assert.equal(r.failed, 0, JSON.stringify(r.diagnostics));
    r = runProbes(root, [C({ type: 'dir-tree-hash', path: { base: 'project', rel: 'no-dir' }, expect: `sha256:${treeHex}` })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT', '目标目录缺失→ASSERT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：host-app-present expect 嵌套/env 覆盖/win32 空列与非法 host CONFIG', () => {
  const sigDir = tmpRoot('dev85-sig-');
  try {
    const sigPath = join(sigDir, 'host-signatures.json');
    writeFileSync(sigPath, JSON.stringify({ version: 1, hosts: { zcode: { darwin: ['/Applications/ZCode.app'], win32: [] }, mcode: { darwin: ['~/Applications/MiniMax Code.app'], win32: [] }, kimi: { darwin: ['/Applications/Kimi Code.app'], win32: [] } } }));
    const marker = join(sigDir, 'present-marker');
    mkdirSync(marker, { recursive: true });
    const hostOpts = { signaturesPath: sigPath, platform: 'darwin' };
    let r = runProbes('/', [C({ type: 'host-app-present', expect: { host: 'zcode', presence: 'present' } })], { ...hostOpts, env: { ZCODE_APP_ROOT: marker } });
    assert.equal(r.failed, 0, JSON.stringify(r.diagnostics));
    r = runProbes('/', [C({ type: 'host-app-present', expect: { host: 'zcode', presence: 'absent' } })], { ...hostOpts, env: { ZCODE_APP_ROOT: marker } });
    assert.equal(r.failed, 1);
    r = runProbes('/', [C({ type: 'host-app-present', expect: { host: 42, presence: 'present' } })], hostOpts);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', '不可哈希 host→CONFIG（isinstance 前置守卫语义）');
    r = runProbes('/', [C({ type: 'host-app-present', expect: { host: 'zcode', presence: 'present' } })], { ...hostOpts, platform: 'win32' });
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', 'win32 空列 fail-loud（内部未决-129）');
  } finally {
    rmSync(sigDir, { recursive: true, force: true });
  }
});

test('runProbes：CONFIG 档矩阵（坏 type/缺 path/非法 kind/非 GUID/ACL 白名单外）——诊断不抛', () => {
  const root = tmpRoot('dev85-cfg-');
  try {
    writeFileSync(join(root, 'a.txt'), 'x');
    const bad = [
      { type: 'no-such-type' },
      { type: 'file-exists' },
      { type: 'file-exists', path: { base: 'project', rel: 'a.txt' }, kind: 'weird' },
      { type: 'audit-policy-state', expect: { subcategoryGuid: 'not-guid', inclusion: 'empty' } },
      { type: 'acl-state', path: { base: 'project', rel: 'a.txt' }, expect: { denyAccount: 'X', denyRights: ['NOPE'] } },
    ];
    for (const probe of bad) {
      const r = runProbes(root, [C(probe)]);
      assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG', JSON.stringify(probe));
      assert.ok(r.diagnostics[0].message.startsWith('探针配置错误'), JSON.stringify(probe));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbes：spawn 注入缝——icacls/auditpol 判定闭环（无 DENY→ASSERT）＋spawn 失败 ASSERT', () => {
  const root = tmpRoot('dev85-spawn-');
  try {
    writeFileSync(join(root, 'f.txt'), 'x');
    const icaclsText = 'f.txt EVIL\\u:(DENY)(WD,AD)\nBUILTIN\\Users:(F)\n';
    let r = runProbes(root, [
      C({ type: 'acl-state', path: { base: 'project', rel: 'f.txt' }, expect: { denyAccount: 'EVIL\\u', denyRights: ['WD', 'AD'] } }),
    ], { spawnImpl: () => icaclsText });
    assert.equal(r.failed, 0, JSON.stringify(r.diagnostics));
    r = runProbes(root, [
      C({ type: 'acl-state', path: { base: 'project', rel: 'f.txt' }, expect: { denyAccount: 'NOBODY' } }),
    ], { spawnImpl: () => icaclsText });
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT', '无 DENY 段→ASSERT');
    const auditCsv = 'Machine Name,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting\r\nPC,File System,{0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D},,\r\n';
    r = runProbes(root, [
      C({ type: 'audit-policy-state', expect: { subcategoryGuid: '{0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d}', inclusion: 'empty' } }),
    ], { spawnImpl: (argv) => (argv[0] === 'auditpol' ? auditCsv : icaclsText) });
    assert.equal(r.failed, 0, JSON.stringify(r.diagnostics));
    r = runProbes(root, [
      C({ type: 'acl-state', path: { base: 'project', rel: 'f.txt' }, expect: { denyAccount: 'EVIL\\u' } }),
    ], { spawnImpl: () => { throw new Error('spawn ENOENT'); } });
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT', '命令缺失→ASSERT（探针执行异常）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const win32 = process.platform === 'win32' ? test : test.skip;
win32('runProbes：auditpol 实机往返（win32-only；darwin skip——台账 win32 基线节登记）', () => {
  const root = tmpRoot('dev85-live-');
  try {
    const r = runProbes(root, [C({ type: 'audit-policy-state', expect: { subcategoryGuid: '{0CCE9210-69AE-11D9-BED3-505054503030}', inclusion: 'not-empty' } })]);
    // T01（内部任务-241）：不得只断 total==1（CONFIG/ASSERT 失败同样 total=1）——须断「命令/解析闭环」语义：
    // 通过＝零诊断；未通过＝ASSERT 断言不匹配（RULE-GATE-OPASSERT），而不是 CONFIG/spawn 故障。
    assert.equal(r.total, 1);
    if (r.failed === 0) {
      assert.equal(r.passed, 1, '成功路径恰 1 条通过');
      assert.deepEqual(r.diagnostics, [], '成功路径零诊断');
    } else {
      assert.equal(r.passed, 0);
      const diag = r.diagnostics[0] ?? {};
      assert.equal(diag.ruleId, 'RULE-GATE-OPASSERT',
        `实机策略不匹配须为 ASSERT 判定（命令名/解析/spawn 已闭环），实得 ${JSON.stringify(diag)}`);
      assert.ok(String(diag.message).includes('audit'), 'ASSERT 诊断须指向 audit 策略判定');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadHostSignatures：坏 JSON/缺 hosts 键 fail-loud＋按路径缓存', () => {
  const dir = tmpRoot('dev85-lhs-');
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{oops');
    assert.throws(() => loadHostSignatures(bad), ProbeConfigError);
    const noHosts = join(dir, 'nh.json');
    writeFileSync(noHosts, '{"version":1}');
    assert.throws(() => loadHostSignatures(noHosts), ProbeConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真值签名库形态契约：四宿主键齐/win32 三宿主非空含身份锚/DSH 行在场/darwin DSH 已取证含身份锚（内部任务-222）', () => {
  const lib = loadHostSignatures();
  assert.deepEqual(Object.keys(lib.hosts).sort(), ['dsh', 'kimi', 'mcode', 'zcode']);
  for (const h of ['zcode', 'mcode', 'kimi']) {
    assert.ok(Array.isArray(lib.hosts[h].darwin) && lib.hosts[h].darwin.length > 0, `${h}.darwin 非空`);
    assert.ok(Array.isArray(lib.hosts[h].win32) && lib.hosts[h].win32.length > 0, `${h}.win32 非空（2026-10-21 内部任务-188 回填）`);
    for (const p of lib.hosts[h].win32) assert.ok(p.startsWith('~/'), `${h}.win32 候选以 ~/ 展开形态登记`);
  }
  assert.ok(lib.hosts.zcode.win32.some((p) => p.includes('ZCode')), 'zcode win32 候选含 ZCode 安装位');
  assert.ok(lib.hosts.mcode.win32.some((p) => p.includes('MiniMax Code')), 'mcode win32 候选含 MiniMax Code 安装位');
  assert.ok(lib.hosts.kimi.win32.some((p) => p.includes('Kimi Code')), 'kimi win32 候选含 Kimi Code 安装位');
  assert.ok(lib.hosts.kimi.darwin.some((p) => p.includes('Kimi Code')), 'kimi 候选须含 "Kimi Code"');
  assert.ok(lib.hosts.dsh.win32.some((p) => p.includes('DeepSeek Harness')), 'dsh win32 候选含 DeepSeek Harness 安装位');
  assert.ok(Array.isArray(lib.hosts.dsh.darwin) && lib.hosts.dsh.darwin.length > 0, 'dsh.darwin 非空（2026-10-25 内部任务-222 取证回填）');
  assert.ok(lib.hosts.dsh.darwin.some((p) => p.includes('DeepSeek Harness')), 'dsh darwin 候选含 "DeepSeek Harness"（身份锚，内部未决-129 取证纪律）');
  // linux：zcode 已取证回填（2026-11-02 内部任务-281，内部未决-208）——身份锚=宿主自管 release 树；
  // mcode/kimi/dsh 空数组占位（宿主不在位无安装位证据，fail-loud 语义，内部未决-129 先例）
  for (const h of ['zcode', 'mcode', 'kimi', 'dsh']) {
    assert.ok(Array.isArray(lib.hosts[h].linux), `${h}.linux 键在场（数组形态）`);
  }
  assert.equal(lib.hosts.zcode.linux.length, 1, 'zcode linux 恰 1 条取证候选');
  assert.ok(lib.hosts.zcode.linux[0].startsWith('~/') && lib.hosts.zcode.linux[0].includes('.zcode/server/releases'), 'zcode linux 候选=~/ 展开形态的宿主 release 树（身份锚）');
  for (const h of ['mcode', 'kimi', 'dsh']) {
    assert.equal(lib.hosts[h].linux.length, 0, `${h}.linux 空占位（未取证 fail-loud）`);
  }
});

test('源码扫描守卫：spawn 收敛单点＋判据键无自由命令位＋分派闭环尾块在位（test_spawn_surface 同款）', () => {
  const src = readFileSync(join(TESTS, '..', 'probes.mjs'), 'utf8');
  assert.ok(!src.includes('execSync') && !src.includes('exec('), '无 exec 形态');
  assert.ok(!/"command"\s*:|"shell"\s*:/.test(src), '判据键无自由命令位');
  assert.ok(src.includes('function spawnTemplate'), 'spawn 单点在位');
  assert.ok(src.includes('未实现分派'), '分派闭环尾块在位（内部未决-102②——白名单与分支集脱节时显式拒绝，删除即本锚红）');
});

test('门①行为锁定：嵌套 null 期望/原型链键/词法坏→CONFIG/无效 UTF-8→ASSERT/probe 非对象崩溃对齐', () => {
  const root = tmpRoot('dev85-g1-');
  try {
    writeFileSync(join(root, 'a.json'), JSON.stringify({ v: null, o: { n: 5 } }));
    // 嵌套 null 期望：pass 与 fail 两态都不崩（门①发现 1）
    let r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'v', expect: null })]);
    assert.equal(r.failed, 0);
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'o', expect: { n: null } })]);
    assert.equal(r.failed, 1, '嵌套值 5≠null→ASSERT（不崩）');
    // primitive vs object 深比较不装箱恒真（门①发现 2）
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'o.n', expect: {} })]);
    assert.equal(r.failed, 1);
    // 原型链键不泄漏（门①发现 8）：a.__proto__ → 路径不存在→ASSERT
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'o.__proto__', expect: {} })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT');
    // 词法坏 field→CONFIG（门①发现 7）
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'a.json' }, field: 'a[x]', expect: 1 })]);
    assert.equal(r.diagnostics[0].ruleId, 'RULE-GATE-OPASSERT-CONFIG');
    // 无效 UTF-8→ASSERT 不静默替换（门①发现 3）
    writeFileSync(join(root, 'bad.json'), Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    r = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'bad.json' }, field: 'k', expect: '\ufffd' })]);
    assert.equal(r.failed, 1, '无效 UTF-8 拒绝静默通过');
    // probe 非对象→崩溃对齐（门①发现 15：Python AttributeError 逃逸）
    assert.throws(() => runProbes(root, [{ criterion: 'x', probe: 'notadict' }]), TypeError);
    // guidOk 尾换行容忍（门①发现 12）
    assert.ok(guidOk('{0A1B2C3D-4E5F-6a7b-8c9d-0E1F2A3B4C5D}\n'), 'Python re $ 尾换行前匹配对齐');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('门①行为锁定：treeHash 断链 symlink 文件→外抛（不静默跳帧，门①发现 4）', (t) => {
  const root = tmpRoot('dev85-g2-');
  try {
    writeFileSync(join(root, 'ok.txt'), 'x');
    if (!trySymlink(t, join(root, 'nonexistent-target'), join(root, 'broken.link'))) return;
    assert.throws(() => treeHash(root, []), /ENOENT/, '断链文件哈希错误上抛（Python FileNotFoundError→ASSERT 同安全方向）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S01（内部任务-241）：探针诊断不回显实际值（json-field-eq / jsonl-record-field-eq）', () => {
  const root = tmpRoot('dev241-sec-');
  try {
    writeFileSync(join(root, 'secret.json'), JSON.stringify({ token: 'abc123secret' }), 'utf8');
    const r1 = runProbes(root, [C({ type: 'json-field-eq', path: { base: 'project', rel: 'secret.json' }, field: 'token', expect: 'expected' })]);
    assert.equal(r1.failed, 1);
    const msg1 = r1.diagnostics.map((d) => String(d.message)).join('\n');
    assert.match(msg1, /不回显|脱敏/, '诊断须明示脱敏口径');
    assert.equal(msg1.includes('abc123secret'), false, '实际值不得进入 gate 报告/模型上下文');
    writeFileSync(join(root, 'l.jsonl'), `${JSON.stringify({ token: 'zzz999' })}\n`, 'utf8');
    const r2 = runProbes(root, [C({ type: 'jsonl-record-field-eq', path: { base: 'project', rel: 'l.jsonl' }, match: { token: 'zzz999' }, field: 'token', expect: 'nope' })]);
    assert.equal(r2.failed, 1);
    const msg2 = r2.diagnostics.map((d) => String(d.message)).join('\n');
    assert.equal(msg2.includes('zzz999'), false, 'jsonl 实际值同样不得回显');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('内部任务-242 正确性复审 C-1：jsonl 严格仅顶层类型，容器内按 Python == 宽松', () => {
  const { looseJsonEq, strictJsonEq } = _jsonEqInternals;
  // json-field-eq：宽松（True==1 允许）
  assert.equal(looseJsonEq(true, 1), true);
  // jsonl：顶层严格，嵌套宽松（[1]==[True]、{a:1}=={a:true}）
  assert.equal(strictJsonEq(true, 1), false, '顶层 bool↔number 必须不等');
  assert.equal(strictJsonEq(1, 1), true);
  assert.equal(strictJsonEq([1], [true]), true, '嵌套 [1]==[True]（Python 容器语义）');
  assert.equal(strictJsonEq({ a: 1 }, { a: true }), true, '嵌套 {a:1}=={a:true}');
  assert.equal(strictJsonEq({ a: '1' }, { a: 1 }), false, 'str↔number 不等');
});
