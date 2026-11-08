// 文件：config.test.mjs
// 描述：config.mjs 单元面（内部决策-051 运行时归一·阶段1a）——净新增（Python 侧无直接单测，
//       source 三值矩阵/损坏降级/threshold 校验矩阵/未知键丢弃）。永久件。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, reviewCoverageThreshold } from '../config.mjs';

function tmpRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sdd'), { recursive: true });
  return dir;
}

test('loadConfig 三级降级：缺失→default／损坏与根非对象→unparsable-default／正常→file 只拷已知键', () => {
  const root = tmpRoot('dev85-cfg-');
  try {
    let cfg = loadConfig(root);
    assert.equal(cfg.source, 'default');
    assert.equal(cfg.planCheckBlock, false);
    assert.equal(cfg.reviewCoverage.planStepThreshold, 8);

    writeFileSync(join(root, '.sdd', 'assurance.json'), '{oops', 'utf8');
    cfg = loadConfig(root);
    assert.equal(cfg.source, 'unparsable-default', '损坏→按缺省降级并注明（强干涉项不静默放行）');
    assert.equal(cfg.planCheckBlock, false);

    writeFileSync(join(root, '.sdd', 'assurance.json'), '[1,2]', 'utf8');
    cfg = loadConfig(root);
    assert.equal(cfg.source, 'unparsable-default', '根非对象→unparsable-default');

    writeFileSync(join(root, '.sdd', 'assurance.json'), JSON.stringify({ schemaVersion: '1.0.0', planCheckBlock: true, unknown: 'x' }), 'utf8');
    cfg = loadConfig(root);
    assert.equal(cfg.source, 'file');
    assert.equal(cfg.planCheckBlock, true);
    assert.equal('unknown' in cfg, false, '未知键丢弃');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig：governanceRequired 布尔键透传，坏类型按 unparsable-default 降级（G03/内部任务-241）', () => {
  const root = tmpRoot('dev241-gov-');
  try {
    writeFileSync(join(root, '.sdd', 'assurance.json'), JSON.stringify({ governanceRequired: true }), 'utf8');
    let cfg = loadConfig(root);
    assert.equal(cfg.source, 'file');
    assert.equal(cfg.governanceRequired, true, '真值透传（内部接口-18 required 可达——旧实现该键被白名单丢弃恒 false）');
    writeFileSync(join(root, '.sdd', 'assurance.json'), JSON.stringify({ governanceRequired: false }), 'utf8');
    cfg = loadConfig(root);
    assert.equal(cfg.governanceRequired, false);
    writeFileSync(join(root, '.sdd', 'assurance.json'), JSON.stringify({ governanceRequired: 'yes' }), 'utf8');
    cfg = loadConfig(root);
    assert.equal(cfg.source, 'unparsable-default', '坏类型→按缺省降级');
    assert.equal(cfg.governanceRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewCoverageThreshold：int 排 bool 且 >0 才受理，否则回 8', () => {
  const root = tmpRoot('dev85-th-');
  try {
    const write = (v) => writeFileSync(join(root, '.sdd', 'assurance.json'), JSON.stringify({ reviewCoverage: { planStepThreshold: v } }), 'utf8');
    for (const [v, want] of [[3, 3], [1, 1], [100, 100], [0, 8], [-2, 8], [true, 8], [false, 8], ['5', 8], [2.5, 8]]) {
      write(v);
      assert.equal(reviewCoverageThreshold(root), want, `threshold(${JSON.stringify(v)})`);
    }
    writeFileSync(join(root, '.sdd', 'assurance.json'), '{}', 'utf8');
    assert.equal(reviewCoverageThreshold(root), 8, '无 reviewCoverage 键→8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
