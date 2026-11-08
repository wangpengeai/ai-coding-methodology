// 文件：learning-store.test.mjs
// 描述：learning-store.mjs（内部模块-15/内部决策-019 tg 拉取联动）的 TDD 测试——observed 态
//       learning 的追加/读取回环、坏行容忍、同 learningId 读侧幂等。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 用临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { appendObserved, readObserved, observedFile } = await import('../lib/learning-store.mjs');

const mkLearning = (id, over = {}) => ({
  learningId: id,
  statement: '一句话经验',
  owner: 'wangp',
  evidenceReferences: ['incident:abc'],
  status: 'observed',
  scope: 'self-observability',
  sourceIncidentId: 'ri-1',
  recordedAt: new Date().toISOString(),
  ...over,
});

test('追加→读取回环：字段保真，observed 落 .ai-governance/runtime/learnings/', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lstore-'));
  try {
    const r = appendObserved(root, mkLearning('L-1'));
    assert.ok(r.ok);
    assert.ok(observedFile(root).includes(join('.ai-governance', 'runtime', 'learnings', 'observed.jsonl')));
    const list = readObserved(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].learningId, 'L-1');
    assert.equal(list[0].status, 'observed');
    assert.equal(list[0].sourceIncidentId, 'ri-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏行容忍：混入非 JSON 行后读取仍返回有效记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lstore-'));
  try {
    appendObserved(root, mkLearning('L-ok'));
    writeFileSync(observedFile(root), 'not-json {{{\n', { flag: 'a' });
    const list = readObserved(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].learningId, 'L-ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同 learningId 二写：文件两行（追加不丢），读侧幂等只返回 1 条', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lstore-'));
  try {
    appendObserved(root, mkLearning('L-dup'));
    appendObserved(root, mkLearning('L-dup', { recordedAt: 'later' }));
    const lines = readFileSync(observedFile(root), 'utf8').split('\n').filter((l) => l.trim()).length;
    assert.equal(lines, 2);
    assert.equal(readObserved(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺文件：readObserved 返回 []', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lstore-'));
  try {
    assert.deepEqual(readObserved(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-255 批 3（H12：内部验收-24）──

test('appendObserved：落盘前脱敏（observed.jsonl 无明文秘密）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-lstore-redact-'));
  try {
    const r = appendObserved(root, mkLearning('L-secret', { statement: 'token=abcdef123456' }));
    assert.ok(r.ok, '正常记录仍成功落盘');
    const text = readFileSync(observedFile(root), 'utf8');
    assert.ok(!text.includes('token=abcdef123456'), '明文秘密不得落盘');
    assert.equal(readObserved(root)[0].learningId, 'L-secret', 'learningId 可读回');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

