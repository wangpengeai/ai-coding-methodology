// 文件：archive.test.mjs
// 描述：archive.mjs 单元面（内部决策-051 运行时归一·阶段1a）——tar 内核 roundtrip＋负例、
//       候选三条件、阈值注入缝、apply/restore 状态机（manifest 先落盘再删原目录时序）。
//       test_archive.py 库面移植（3 条 CLI 派发用例延后阶段3 cli.mjs 批——计划定案）；
//       互操作对拍（Py↔JS 双向）在 parity-stage1a。永久件。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { trySymlink } from './symlink-helpers.mjs';
import assert from 'node:assert/strict';

import { _tarInternals, _testHooks, archiveCandidates, archiveReceipts, CANDIDATE_DAYS, loadManifest, restoreReceipts, THRESHOLD_BYTES, THRESHOLD_DIRS } from '../archive.mjs';

const { tarRead, tarWrite, extractEntries, tarHeader: tarHeaderForTest } = _tarInternals;

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mkTask(root, taskId, { daysAgo = 200, evidence = true, receipts = true } = {}) {
  if (receipts) {
    mkdirSync(join(root, '.sdd', 'receipts', taskId), { recursive: true });
    writeFileSync(join(root, '.sdd', 'receipts', taskId, 'verification.json'), `{"id":"${taskId}"}`, 'utf8');
    mkdirSync(join(root, '.sdd', 'receipts', taskId, 'sub'));
    writeFileSync(join(root, '.sdd', 'receipts', taskId, 'sub', 'nested.md'), '# 嵌套', 'utf8');
  }
  mkdirSync(join(root, '.sdd', 'reports', taskId), { recursive: true });
  const finalizedAt = new Date(Date.now() - daysAgo * 86400e3).toISOString();
  writeFileSync(join(root, '.sdd', 'reports', taskId, 'delivery-final.json'), JSON.stringify({ finalStatus: 'complete', finalizedAt }), 'utf8');
  if (evidence) {
    mkdirSync(join(root, 'docs', 'plans', 'evidence', taskId), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'evidence', taskId, 'op.md'), 'x', 'utf8');
  }
  return root;
}

test('tar 内核：写→读 roundtrip（101 字节文件/嵌套目录/中文文件名/pax path 通路）', () => {
  const src = tmpRoot('dev85-tar-rt-');
  const dst = tmpRoot('dev85-tar-rt-out-');
  try {
    mkdirSync(join(src, 'DEV-1', 'sub'), { recursive: true });
    writeFileSync(join(src, 'DEV-1', 'a.txt'), 'x'.repeat(101), 'utf8');
    writeFileSync(join(src, 'DEV-1', '中文文件.json'), '{"k":"值"}', 'utf8');
    writeFileSync(join(src, 'DEV-1', 'sub', 'nested.md'), '# 嵌套', 'utf8');
    const buf = tarWrite([{ fsRoot: join(src, 'DEV-1'), taskId: 'DEV-1' }]);
    const entries = tarRead(buf);
    const names = entries.map((e) => e.name).sort();
    assert.ok(names.includes('DEV-1'), '任务根目录条目');
    assert.ok(names.includes('DEV-1/中文文件.json'), '中文文件名（读侧 ustar 直读——JS 写侧无 pax 需求）');
    assert.ok(names.includes('DEV-1/sub/nested.md'));
    extractEntries(entries, dst);
    assert.equal(readFileSync(join(dst, 'DEV-1', 'a.txt'), 'utf8'), 'x'.repeat(101), '101 字节文件 roundtrip');
    assert.equal(readFileSync(join(dst, 'DEV-1', '中文文件.json'), 'utf8'), '{"k":"值"}');
    assert.equal(readFileSync(join(dst, 'DEV-1', 'sub', 'nested.md'), 'utf8'), '# 嵌套');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('tar 内核负例：checksum 翻字节→明确错误；截断流→条目缺失可检；未识别 pax 键 fail-loud', () => {
  const src = tmpRoot('dev85-tar-neg-');
  try {
    mkdirSync(join(src, 'DEV-1'), { recursive: true });
    writeFileSync(join(src, 'DEV-1', 'a.txt'), 'payload', 'utf8');
    writeFileSync(join(src, 'DEV-1', 'b.txt'), 'payload2', 'utf8');
    const buf = tarWrite([{ fsRoot: join(src, 'DEV-1'), taskId: 'DEV-1' }]);
    // 翻第一块头一字节（name 区）→ checksum 不符
    const corrupted = Buffer.from(buf);
    const raw = Buffer.from(gunzipSync(corrupted));
    raw[5] = raw[5] === 0x41 ? 0x42 : 0x41;
    assert.throws(() => tarRead(gzipSync(raw)), /checksum/);
    // 截断流（保留头部几块、去后半）→ 条目数严格少于完整流（不静默全绿——终审简 2 修正恒真式）
    const full = tarRead(buf);
    const truncated = gzipSync(rawFullSub(buf, Math.floor(rawLen(buf) / 2)));
    assert.ok(tarRead(truncated).length < full.length, `截断后条目（${tarRead(truncated).length}）须少于完整（${full.length}）`);
    // 未识别 pax 键（经生产 tarHeader 造头——checksum 由实现保证，负例只注入坏记录族）
    const paxRecord = '16 unknownKey=1\n'; // len 字段含自身数字位：'16 ' + 'unknownKey=1\n' = 16 字节
    assert.equal(paxRecord.length, 16);
    const paxData = Buffer.from(paxRecord, 'utf8');
    const pad = (512 - (paxData.length % 512)) % 512;
    const tar = Buffer.concat([
      tarHeaderForTest('PaxHeader', paxData.length, 0, 'x'),
      paxData,
      Buffer.alloc(pad),
      tarHeaderForTest('DEV-2/x.txt', 0, 0, '0'),
      Buffer.alloc(1024),
    ]);
    assert.throws(() => tarRead(gzipSync(tar)), /未识别键/);
    // 已识别 pax 键（mtime/path/size）不触发 fail-loud——用合法记录验证分野
    const okRecord = '27 mtime=1700000000.000000\n';
    assert.equal(okRecord.length, 27);
    const okData = Buffer.from(okRecord, 'utf8');
    const okPad = (512 - (okData.length % 512)) % 512;
    const okTar = Buffer.concat([
      tarHeaderForTest('PaxHeader', okData.length, 0, 'x'),
      okData,
      Buffer.alloc(okPad),
      tarHeaderForTest('DEV-2/y.txt', 0, 0, '0'),
      Buffer.alloc(1024),
    ]);
    const okEntries = tarRead(gzipSync(okTar));
    assert.equal(okEntries.length, 1, '已识别键合并后仅文件条目');
    assert.equal(okEntries[0].mtime, 1700000000, 'pax mtime 合并');
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

/** gunzip 后字节长（截断负例辅助）。 */
function rawLen(gzBuf) {
  return gunzipSync(gzBuf).length;
}

/** gunzip 后截断再回压。 */
function rawFullSub(gzBuf, len) {
  return gunzipSync(gzBuf).subarray(0, len);
}

test('tar 内核：symlink 条目 roundtrip（写侧 lstat 存 type-2 不物化＋读侧 linkname 真源恢复）', (t) => {
  const src = tmpRoot('dev85-tar-sym-');
  const dst = tmpRoot('dev85-tar-sym-out-');
  try {
    mkdirSync(join(src, 'DEV-1', 'sub'), { recursive: true });
    writeFileSync(join(src, 'DEV-1', 'sub', 'target.json'), '{"t":1}', 'utf8');
    if (!trySymlink(t, 'sub/target.json', join(src, 'DEV-1', 'link.json'))) return;
    // 断链 symlink 目标用相对路径（S03/内部任务-241 后 restore 拒绝绝对/越界 linkTarget；
    // tar linkname 真源恢复语义用相对目标即可覆盖）
    if (!trySymlink(t, 'missing-broken.target', join(src, 'DEV-1', 'broken.link'))) return;
    const buf = tarWrite([{ fsRoot: join(src, 'DEV-1'), taskId: 'DEV-1' }]);
    const entries = tarRead(buf); // JS 自读自写必须成立（终审正确性发现 1：checksum 含 linkname）
    const sym = entries.filter((e) => e.type === '2');
    assert.equal(sym.length, 2, 'symlink 条目数');
    assert.equal(sym.find((e) => e.name === 'DEV-1/link.json').linkTarget, 'sub/target.json', 'linkname 头字段＝真源');
    extractEntries(entries, dst);
    assert.equal(readlinkSync(join(dst, 'DEV-1', 'link.json')).replaceAll('\\', '/'), 'sub/target.json', 'restore 恢复 symlink');
    assert.equal(readFileSync(join(dst, 'DEV-1', 'sub', 'target.json'), 'utf8'), '{"t":1}');
  } finally {
    rmSync(src, { recursive: true, force: true, maxRetries: 5 });
    rmSync(dst, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tar 内核：POSIX symlink linkname 中的反斜杠是合法字面量，不归一', { skip: process.platform === 'win32' && 'win32 路径分隔符语义不同' }, (t) => {
  const src = tmpRoot('dev85-tar-sym-backslash-');
  try {
    mkdirSync(join(src, 'DEV-1'), { recursive: true });
    if (!trySymlink(t, 'a\\b', join(src, 'DEV-1', 'link.json'))) return;
    const entries = tarRead(tarWrite([{ fsRoot: join(src, 'DEV-1'), taskId: 'DEV-1' }]));
    assert.equal(entries.find((e) => e.name === 'DEV-1/link.json').linkTarget, 'a\\b', 'POSIX 反斜杠不得被改写为 /');
  } finally {
    rmSync(src, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('候选三条件：超龄＋evidence 承载→候选；未超龄/无终稿/号无承载→非候选；manifest 承载', () => {
  const root = tmpRoot('dev85-cand-');
  try {
    mkTask(root, 'DEV-OLD', { daysAgo: 200, evidence: true });
    mkTask(root, 'DEV-YOUNG', { daysAgo: 10 });
    mkTask(root, 'DEV-NOFINAL', { daysAgo: 200, evidence: true });
    rmSync(join(root, '.sdd', 'reports', 'DEV-NOFINAL', 'delivery-final.json'), { force: true });
    mkTask(root, 'DEV-NOCARRY', { daysAgo: 200, evidence: false });
    const info = archiveCandidates(root);
    const ids = info.candidates.map((c) => c.taskId);
    assert.deepEqual(ids, ['DEV-OLD'], `超龄＋承载才候选（实测 ${JSON.stringify(ids)}）`);
    assert.equal(info.candidates[0].carriedBy, 'evidence');
    assert.equal(info.dirs, 4);
    assert.equal(info.thresholdMet, false, '未达阈');
    // manifest 承载
    const m = loadManifest(root);
    m.batches.push({ batch: 'b1', taskIds: ['DEV-NOCARRY'], files: [] });
    mkdirSync(join(root, '.sdd', 'archive'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'archive', 'archive-manifest.json'), JSON.stringify(m), 'utf8');
    const info2 = archiveCandidates(root);
    const ids2 = info2.candidates.map((c) => c.taskId);
    assert.ok(ids2.includes('DEV-NOCARRY'), 'manifest 承载→候选');
    assert.equal(info2.candidates.find((c) => c.taskId === 'DEV-NOCARRY').carriedBy, 'manifest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('阈值注入缝：boundary 翻转（严格大于语义）＋apply 拒绝与状态机', () => {
  const root = tmpRoot('dev85-thr-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    mkTask(root, 'DEV-B', { daysAgo: 200 });
    let info = archiveCandidates(root, { thresholds: { thresholdDirs: 1 } });
    assert.equal(info.thresholdMet, true, '2 目录 > 1 阈（严格大于）');
    info = archiveCandidates(root, { thresholds: { thresholdDirs: 2 } });
    assert.equal(info.thresholdMet, false, '2 目录 > 2 不成立');
    assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 2 } }), /阈值未达/);
    // apply：达阈打包＋manifest 先落盘再删原目录
    const r = archiveReceipts(root, { thresholds: { thresholdDirs: 1 } });
    assert.equal(r.archived, 2);
    assert.match(r.batch, /^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/, '批次名＝时间戳＋唯一后缀（D07/DEV-241：防同秒覆盖）');
    const m = loadManifest(root);
    assert.equal(m.batches.length, 1);
    assert.deepEqual(m.batches[0].taskIds, ['DEV-A', 'DEV-B']);
    assert.equal(readdirSync(join(root, '.sdd', 'receipts')).length, 0, '原目录已移除');
    // 幂等二跑：目录已清→阈值不再满足→拒（Python test_archive 幂等用例同款 throws 语义）
    assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 1 } }), /阈值未达/);
    // 「达阈但零候选」note 分支：目录在但全部不超龄（thresholdDirs:0 恒达阈——0>0 false 但 bytes 分支？恒 false；改用 thresholdBytes:0 使 0 字节不达——直接造非空年轻任务配 thresholdDirs:0：dirs>0 恒真）
    mkTask(root, 'DEV-YOUNG2', { daysAgo: 5 });
    const again = archiveReceipts(root, { thresholds: { thresholdDirs: 0 } });
    assert.equal(again.archived, 0);
    assert.ok(again.note.includes('零候选'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore：task 级 roundtrip 逐字节＋manifest 剔除；batch 级 manifest 清空；参数互斥', () => {
  const root = tmpRoot('dev85-rest-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    mkTask(root, 'DEV-B', { daysAgo: 200 });
    archiveReceipts(root, { thresholds: { thresholdDirs: 1 } });
    assert.throws(() => restoreReceipts(root, {}), /须且仅须/);
    assert.throws(() => restoreReceipts(root, { taskId: 'DEV-A', batch: 'b' }), /须且仅须/);
    assert.throws(() => restoreReceipts(root, { taskId: 'DEV-NOPE' }), /未命中/);
    const r = restoreReceipts(root, { taskId: 'DEV-A' });
    assert.equal(r.restored, 1);
    assert.equal(readFileSync(join(root, '.sdd', 'receipts', 'DEV-A', 'verification.json'), 'utf8'), '{"id":"DEV-A"}', 'roundtrip 逐字节');
    assert.equal(readFileSync(join(root, '.sdd', 'receipts', 'DEV-A', 'sub', 'nested.md'), 'utf8'), '# 嵌套');
    const m1 = loadManifest(root);
    assert.deepEqual(m1.batches[0].taskIds, ['DEV-B'], 'task 级批内剔除');
    // D05（内部任务-241 修复）：--task-id 只解该任务子树——DEV-B 不得物理复活（manifest 仍准确记录其归档）
    assert.equal(exists(join(root, '.sdd', 'receipts', 'DEV-B')), false, '兄弟任务不得随整包复活（D05）');
    restoreReceipts(root, { taskId: 'DEV-B' });
    assert.equal(loadManifest(root).batches.length, 0, '批空自动移除');
    // batch 级：重新归档两任务再整批还原
    mkTask(root, 'DEV-C', { daysAgo: 200 });
    mkTask(root, 'DEV-D', { daysAgo: 200 });
    rmSync(join(root, '.sdd', 'receipts', 'DEV-A'), { recursive: true, force: true });
    rmSync(join(root, '.sdd', 'receipts', 'DEV-B'), { recursive: true, force: true });
    const r2 = archiveReceipts(root, { thresholds: { thresholdDirs: 1 } });
    const rb = restoreReceipts(root, { batch: r2.batch });
    assert.equal(rb.restored, 2);
    assert.equal(loadManifest(root).batches.length, 0, 'batch 级整批移除');
    assert.equal(readFileSync(join(root, '.sdd', 'receipts', 'DEV-C', 'verification.json'), 'utf8'), '{"id":"DEV-C"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('D02（DEV-241）：manifest 损坏 → strict 拒写并保留 .corrupt 副本、原 receipts 不删', () => {
  const root = tmpRoot('dev241-arch-man-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    mkdirSync(join(root, '.sdd', 'archive'), { recursive: true });
    const mpath = join(root, '.sdd', 'archive', 'archive-manifest.json');
    writeFileSync(mpath, '{broken', 'utf8');
    assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 0 } }), /manifest 损坏/);
    assert.ok(readdirSync(join(root, '.sdd', 'archive')).some((n) => n.startsWith('archive-manifest.json.corrupt-')), '损坏原件另存副本');
    assert.ok(exists(join(root, '.sdd', 'receipts', 'DEV-A')), '原目录不得删除');
    assert.equal(readdirSync(join(root, '.sdd', 'archive')).filter((n) => n.endsWith('.tar.gz')).length, 0,
      'manifest 损坏不得留下未登记的 tar 副本（失败原子性）');
    assert.equal(readFileSync(mpath, 'utf8'), '{broken', '损坏 manifest 不被覆盖');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D02（DEV-241）：tar 读回校验失败 → 不删原目录且清理坏 tar', () => {
  const root = tmpRoot('dev241-arch-rb-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    _testHooks.afterTarWrite = (tarPath) => writeFileSync(tarPath, 'corrupt-tar-bytes', 'utf8');
    assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 0 } }), /读回校验失败/);
    assert.ok(exists(join(root, '.sdd', 'receipts', 'DEV-A')), '读回失败不得删原件');
    assert.equal(readdirSync(join(root, '.sdd', 'archive')).filter((n) => n.endsWith('.tar.gz')).length, 0, '坏 tar 已清理');
  } finally {
    _testHooks.afterTarWrite = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('D02（DEV-241）：成功归档记录 tarSha256 且批次名带唯一后缀', () => {
  const root = tmpRoot('dev241-arch-ok-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    const r = archiveReceipts(root, { thresholds: { thresholdDirs: 0 } });
    assert.match(r.batch, /^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/, `批次名唯一后缀：${r.batch}`);
    const m = loadManifest(root);
    const b = m.batches.find((x) => x.batch === r.batch);
    assert.ok(b && b.tarSha256, 'manifest 批次含 tarSha256');
    const tarPath = join(root, '.sdd', 'archive', b.files[0]);
    assert.equal(b.tarSha256, `sha256:${sha256Buf(readFileSync(tarPath))}`, 'tarSha256 与实际文件一致');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 用 tar 头合法构造对抗性 tar（内部任务-241 步骤 12 安全用例）。 */
function craftTar(entries) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(tarHeaderForTest(e.name, e.size ?? 0, 0, e.type, e.linkTarget ?? ''));
    if (e.data) {
      chunks.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function writeCraftedArchive(root, tarBuf) {
  const adir = join(root, '.sdd', 'archive');
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'receipts-x.tar.gz'), tarBuf);
  writeFileSync(join(adir, 'archive-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    batches: [{
      batch: 'x', taskIds: ['TASK-1'], files: ['receipts-x.tar.gz'],
      tarSha256: `sha256:${sha256Buf(tarBuf)}`,
    }],
  }), 'utf8');
}

test('S03（DEV-241）：restore 拒绝 ../ 条目（不落仓外）', () => {
  const root = tmpRoot('dev241-rest-trav-');
  try {
    writeCraftedArchive(root, craftTar([{ name: '../evil.txt', type: '0', size: 4, data: Buffer.from('evil') }]));
    assert.throws(() => restoreReceipts(root, { batch: 'x' }), /越界拒绝|越出目标根/);
    assert.equal(exists(join(root, '.sdd', 'evil.txt')), false, '不得落 .sdd 层');
    assert.equal(exists(join(root, 'evil.txt')), false, '不得落项目根');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S03（DEV-241）：restore 拒绝 symlink 目标越界', () => {
  const root = tmpRoot('dev241-rest-link-');
  try {
    writeCraftedArchive(root, craftTar([{ name: 'TASK-1/link', type: '2', linkTarget: '../../outside' }]));
    assert.throws(() => restoreReceipts(root, { batch: 'x' }), /symlink 目标非法|越出目标根/);
    assert.equal(exists(join(root, '.sdd', 'outside')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D05（DEV-241）：restore --task-id 只还原该任务，兄弟任务不复活', () => {
  const root = tmpRoot('dev241-rest-filter-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    mkTask(root, 'DEV-B', { daysAgo: 200 });
    const r = archiveReceipts(root, { thresholds: { thresholdDirs: 1 } });
    assert.equal(r.archived, 2);
    restoreReceipts(root, { taskId: 'DEV-A' });
    assert.ok(exists(join(root, '.sdd', 'receipts', 'DEV-A', 'verification.json')), '目标任务已还原');
    assert.equal(exists(join(root, '.sdd', 'receipts', 'DEV-B')), false, '兄弟任务不得复活');
    const m = loadManifest(root);
    assert.equal(m.batches.length, 1);
    assert.deepEqual(m.batches[0].taskIds, ['DEV-B'], 'manifest 仍准确记录其余归档任务');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D05（DEV-241 复审）：restore --task-id 在 tar 无该任务条目时拒绝剔除 manifest', () => {
  const root = tmpRoot('dev241-rest-empty-');
  try {
    const tarBuf = craftTar([{ name: 'OTHER/x.txt', type: '0', size: 1, data: Buffer.from('x') }]);
    writeCraftedArchive(root, tarBuf);
    assert.throws(() => restoreReceipts(root, { taskId: 'TASK-1' }), /无任何 tar 条目/);
    assert.deepEqual(loadManifest(root).batches[0].taskIds, ['TASK-1'], 'manifest 不得被空解包剔除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-242 安全复审 S-1：manifest 锁被回收后写前 fencing 失败→清理 tar 且原目录保留', () => {
  const root = tmpRoot('dev242-arch-fence-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    const lockPath = join(root, '.sdd', 'archive', '.manifest.lock');
    _testHooks.afterTarWrite = () => {
      writeFileSync(lockPath, 'intruder-owner', 'utf8'); // 模拟锁在 tar 落盘后被回收/替换
    };
    try {
      assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 0 } }), /fencing 失败/);
    } finally {
      _testHooks.afterTarWrite = null;
    }
    assert.deepEqual(readdirSync(join(root, '.sdd', 'archive')).filter((n) => n.endsWith('.tar.gz')), [], '未登记 tar 须清理');
    assert.ok(exists(join(root, '.sdd', 'receipts', 'DEV-A')), '原目录不得删除');
  } finally {
    _testHooks.afterTarWrite = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S03（DEV-241）：restore 校验 tarSha256，被替换即拒', () => {
  const root = tmpRoot('dev241-rest-tamper-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    const r = archiveReceipts(root, { thresholds: { thresholdDirs: 0 } });
    const m = loadManifest(root);
    const tarPath = join(root, '.sdd', 'archive', m.batches.find((b) => b.batch === r.batch).files[0]);
    writeFileSync(tarPath, Buffer.from('tampered'), 'utf8');
    assert.throws(() => restoreReceipts(root, { batch: r.batch }), /tar 哈希失配/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-242 §四-1：归档 manifest 锁占用时 apply 拒绝且零残留', () => {
  const root = tmpRoot('dev242-arch-lock-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    mkdirSync(join(root, '.sdd', 'archive'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'archive', '.manifest.lock'), 'other-owner', 'utf8');
    assert.throws(() => archiveReceipts(root, { thresholds: { thresholdDirs: 0 } }), /归档索引被并发占用/);
    assert.deepEqual(readdirSync(join(root, '.sdd', 'archive')).filter((n) => n.endsWith('.tar.gz')), [], '锁占用零 tar 残留');
    assert.ok(exists(join(root, '.sdd', 'receipts', 'DEV-A')), '原目录不得删除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-242 §四-1：归档 manifest 锁占用时 restore 拒绝且 manifest 零改', () => {
  const root = tmpRoot('dev242-rest-lock-');
  try {
    mkTask(root, 'DEV-A', { daysAgo: 200 });
    const r = archiveReceipts(root, { thresholds: { thresholdDirs: 0 } });
    const manifestPath = join(root, '.sdd', 'archive', 'archive-manifest.json');
    const before = readFileSync(manifestPath, 'utf8');
    writeFileSync(join(root, '.sdd', 'archive', '.manifest.lock'), 'other-owner', 'utf8');
    assert.throws(() => restoreReceipts(root, { batch: r.batch }), /归档索引被并发占用/);
    assert.equal(readFileSync(manifestPath, 'utf8'), before, 'manifest 不得改动');
    assert.equal(exists(join(root, '.sdd', 'receipts', 'DEV-A')), false, '锁占用时不得解包');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
