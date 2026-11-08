// 文件：revision.test.mjs
// 描述：revision.py 实现（唯一实现；迁移史见 内部决策-051）单测（内部决策-051 运行时归一·阶段2 凭据链 2.1；永久件）——逐方法移植
//       spec-gate/assurance/tests/test_revision.py 的 24 方法＋内部任务-91 2.0 新增 15 例（共 39），
//       类名/断言/夹具逐字对应；另加 JS 专属三例：`revisionSetMatches` 仅 head 不同→false、
//       `frame` 非 BMP 码点排序、无效 UTF-8 路径严格解码失败→fail-closed（win32 skip）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { trySymlink } from './symlink-helpers.mjs';

import {
  RevisionDecodeError, _testHooks, computeRevisionSet, contentBucketsEqual, gitChangedPaths,
  headEquivalent, revisionSetMatches, revisionSetToDict,
} from '../revision.mjs';
import {
  commitAll, currentHead, git, gitRaw, makeGitProject, makeGitProjectWithReceipts,
} from './git-fixtures.mjs';

/** tmp 夹具根（每个用例自建自清，零真机触达）。 */
function tmpRoot(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

/** 递归清理（Windows 锁文件重试；force 容忍已删除）。 */
function cleanup(root) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }

/** POSIX 专属用例（win32 无 symlink/文件名冒号/可靠 mode 语义——计划全局约束 4）。 */
const posixOnly = process.platform === 'win32' ? test.skip : test;

/** 记录提交前后两份 revision（对齐 HeadEquivalenceContentMatchTest._after_commit）。 */
function afterCommit(proj) {
  const before = computeRevisionSet(proj);
  commitAll(proj, 'commit dirty worktree');
  const after = computeRevisionSet(proj);
  return [before, after];
}

/** 断言提交持久化签发内容 ⇒ 等价。 */
function assertEquivalent(proj, before, after) {
  const r = headEquivalent(before.source, after.source, proj);
  assert.ok(r.ok, `提交持久化签发内容应判等价：${r.reason}`);
}

/** 断言内容不一致/不可比对 ⇒ fail-closed（保留既有前缀）。 */
function assertRejected(proj, before, after) {
  const r = headEquivalent(before.source, after.source, proj);
  assert.equal(r.ok, false, `内容不一致/不可比对必须 fail-closed：${r.reason}`);
  assert.ok(r.reason.includes('提交面含源码桶路径'), r.reason);
}

describe('RevisionSourceBucketTest', () => {
  test('test_clean_repo_stable：干净仓两次计算稳定且记录 HEAD', () => {
    const tmp = tmpRoot('dev91-rev-clean-');
    try {
      const proj = makeGitProject(tmp);
      const a = computeRevisionSet(proj);
      const b = computeRevisionSet(proj);
      assert.equal(a.source.worktreeHash, b.source.worktreeHash);
      assert.equal(a.source.head, b.source.head);
      assert.ok(a.source.head, 'git 仓库必须记录 HEAD');
    } finally { cleanup(tmp); }
  });

  test('test_modify_tracked_source_changes_hash：改被跟踪源码改变源码桶哈希', () => {
    const tmp = tmpRoot('dev91-rev-mod-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      const after = computeRevisionSet(proj);
      assert.notEqual(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_untracked_source_changes_hash：未跟踪源码改变源码桶哈希', () => {
    const tmp = tmpRoot('dev91-rev-untracked-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'new.py'), 'x = 1\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.notEqual(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_delete_tracked_source_changes_hash：删除被跟踪源码改变源码桶哈希', () => {
    const tmp = tmpRoot('dev91-rev-delete-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      unlinkSync(join(proj, 'src', 'app.py'));
      const after = computeRevisionSet(proj);
      assert.notEqual(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_runtime_writes_do_not_change_source：运行态写入不影响源码桶', () => {
    const tmp = tmpRoot('dev91-rev-runtime-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      const receipts = join(proj, '.sdd', 'receipts', 'T1');
      mkdirSync(receipts, { recursive: true });
      writeFileSync(join(receipts, 'gate.json'), '{}', 'utf8');
      const reports = join(proj, '.sdd', 'reports', 'T1');
      mkdirSync(reports, { recursive: true });
      writeFileSync(join(reports, 'delivery.json'), '{}', 'utf8');
      writeFileSync(join(proj, '.sdd', 'evidence.jsonl'), '{}\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_spec_change_does_not_change_source：规格改动只动规格桶', () => {
    const tmp = tmpRoot('dev91-rev-spec-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'specs', 'x.md'), '# X changed\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assert.notEqual(before.spec.suiteHash, after.spec.suiteHash);
    } finally { cleanup(tmp); }
  });

  test('test_plan_change_does_not_change_source：计划改动只动计划桶', () => {
    const tmp = tmpRoot('dev91-rev-plan-');
    try {
      const proj = makeGitProject(tmp);
      const plan = join(proj, 'docs', 'plans', 'p.md');
      const before = computeRevisionSet(proj, plan);
      writeFileSync(plan, '---\nspecRefs: [FR-wf-1]\n---\n# 计划改\n', 'utf8');
      const after = computeRevisionSet(proj, plan);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assert.notEqual(before.plan.sha256, after.plan.sha256);
    } finally { cleanup(tmp); }
  });
});

describe('RevisionNoGitTest', () => {
  /** 无 git 的最小项目（对齐 setUp）：src/a.py + 内部规格 + 内部治理状态。 */
  function plainProject(tmp) {
    const proj = join(tmp, 'plain');
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(proj, 'specs'), { recursive: true });
    mkdirSync(join(proj, '.sdd'), { recursive: true });
    writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
    writeFileSync(join(proj, 'specs', 'x.md'), '# X\n', 'utf8');
    writeFileSync(join(proj, '.sdd', 'suite.json'),
      '{"schemaVersion":"1.0.0","suiteRoot":"..","validationRoots":["specs"],'
      + '"documents":[{"path":"specs/x.md","documentType":"requirement-baseline","validationMode":"draft"}]}', 'utf8');
    return proj;
  }

  test('test_tree_fallback_stable_and_sensitive：无 git 回退稳定且内容敏感', () => {
    const tmp = tmpRoot('dev91-rev-nogit-');
    try {
      const proj = plainProject(tmp);
      const first = computeRevisionSet(proj);
      assert.equal(first.source.algorithm, 'tree-content-v1');
      const second = computeRevisionSet(proj);
      assert.equal(first.source.worktreeHash, second.source.worktreeHash);
      writeFileSync(join(proj, 'src', 'a.py'), 'a = 2\n', 'utf8');
      const third = computeRevisionSet(proj);
      assert.notEqual(first.source.worktreeHash, third.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_tree_fallback_excludes_runtime：无 git 回退仍排除运行态', () => {
    const tmp = tmpRoot('dev91-rev-nogit-runtime-');
    try {
      const proj = plainProject(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, '.sdd', 'evidence.jsonl'), '{}\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });
});

describe('RevisionSafetyTest', () => {
  test('test_escaping_symlink_skipped：越界 symlink 不被跟随读取', (t) => {
    const tmp = tmpRoot('dev91-rev-symlink-');
    try {
      const outside = join(tmp, 'outside.txt');
      writeFileSync(outside, 'secret\n', 'utf8');
      const proj = join(tmp, 'proj');
      mkdirSync(join(proj, 'src'), { recursive: true });
      writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
      if (!trySymlink(t, outside, join(proj, 'src', 'escape'))) return;
      const before = computeRevisionSet(proj);
      writeFileSync(outside, 'changed\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
    } finally { cleanup(tmp); }
  });

  test('test_plan_path_escape_rejected：计划路径逃逸被拒绝', () => {
    const tmp = tmpRoot('dev91-rev-planescape-');
    try {
      const outside = join(tmp, 'outside.txt');
      writeFileSync(outside, 'secret\n', 'utf8');
      const proj = join(tmp, 'proj');
      mkdirSync(join(proj, 'src'), { recursive: true });
      writeFileSync(join(proj, 'src', 'a.py'), 'a = 1\n', 'utf8');
      assert.throws(() => computeRevisionSet(proj, outside), /计划路径越出项目根/);
    } finally { cleanup(tmp); }
  });
});

describe('RevisionSetShapeTest', () => {
  test('test_shape_and_lf_normalization：四字段齐全、CRLF 规范化、算法版本固定', () => {
    const tmp = tmpRoot('dev91-rev-shape-');
    try {
      const proj = join(tmp, 'p');
      mkdirSync(join(proj, 'src'), { recursive: true });
      writeFileSync(join(proj, 'src', 'a.py'), 'a\n', 'utf8');
      const plan = join(proj, 'plan.md');
      writeFileSync(plan, '---\nspecRefs: [FR-wf-1]\r\n---\r\n# P\r\n', 'utf8');
      const rs = computeRevisionSet(proj, plan);
      const d = revisionSetToDict(rs);
      for (const key of ['sourceRevision', 'specRevision', 'planSha256', 'algorithmVersion']) {
        assert.ok(Object.prototype.hasOwnProperty.call(d, key), key);
      }
      assert.equal(d.algorithmVersion, '1');
      // CRLF 输入按 LF 内容计哈希：与手工 LF 版本一致
      const manual = createHash('sha256')
        .update(Buffer.from('---\nspecRefs: [FR-wf-1]\n---\n# P\n', 'utf8'))
        .digest('hex');
      assert.equal(d.planSha256.sha256, `sha256:${manual}`);
      assert.equal(d.planSha256.path, 'plan.md');
    } finally { cleanup(tmp); }
  });
});

describe('RuntimeWorkflowExclusionTest', () => {
  /** 有 git 且不 ignore `.workflow` 的夹具（三枚运行态产物＋豁免工件均被跟踪）。 */
  function workflowProject(tmp) {
    const proj = makeGitProject(tmp);
    const wf = join(proj, '.workflow');
    mkdirSync(wf);
    writeFileSync(join(wf, 'routing.json'), '{"stateRoot": "local"}\n', 'utf8');
    mkdirSync(join(wf, 'routing-state'));
    writeFileSync(join(wf, 'routing-state', 'wf-lease-active-t1.json'), '{}\n', 'utf8');
    writeFileSync(join(wf, 'incidents.jsonl'), '{"id": "a"}\n', 'utf8');
    writeFileSync(join(wf, 'wf-exemptions.jsonl'), '{"id": "e"}\n', 'utf8');
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'wf files');
    return proj;
  }

  /** 写入 `rel` 前后各算一次源码桶哈希。 */
  function worktreeHashAfterWrite(proj, rel, content) {
    const before = computeRevisionSet(proj).source.worktreeHash;
    writeFileSync(join(proj, ...rel.split('/')), content, 'utf8');
    const after = computeRevisionSet(proj).source.worktreeHash;
    return [before, after];
  }

  test('test_runtime_artifacts_excluded_from_source_bucket：三枚运行态产物改动不影响源码桶', () => {
    const tmp = tmpRoot('dev91-rev-wf-');
    try {
      const proj = workflowProject(tmp);
      for (const rel of [
        '.workflow/routing.json',
        '.workflow/routing-state/wf-lease-active-t1.json',
        '.workflow/incidents.jsonl',
      ]) {
        const [before, after] = worktreeHashAfterWrite(proj, rel, '{"changed": true}\n');
        assert.equal(before, after, `${rel} 属运行态排除面：改动不得影响源码桶`);
      }
    } finally { cleanup(tmp); }
  });

  test('test_exemptions_file_still_in_source_bucket：豁免工件仍入源码桶（正向钉）', () => {
    const tmp = tmpRoot('dev91-rev-wf-exempt-');
    try {
      const proj = workflowProject(tmp);
      const [before, after] = worktreeHashAfterWrite(proj, '.workflow/wf-exemptions.jsonl', '{"id": "e2"}\n');
      assert.notEqual(before, after, '豁免工件不入排除面：改动必须影响源码桶');
    } finally { cleanup(tmp); }
  });

  test('test_prefix_lookalikes_not_excluded：相似名不因前缀被误排除（整名相等语义）', () => {
    const tmp = tmpRoot('dev91-rev-wf-lookalike-');
    try {
      const proj = workflowProject(tmp);
      for (const rel of ['.workflow/routing.jsonx', '.workflow/incidents.jsonl.bak']) {
        writeFileSync(join(proj, ...rel.split('/')), '{"x": 1}\n', 'utf8');
        const [before, after] = worktreeHashAfterWrite(proj, rel, '{"x": 2}\n');
        assert.notEqual(before, after, `${rel} 不属排除面：改动必须影响源码桶`);
      }
    } finally { cleanup(tmp); }
  });

  test('test_repeated_runtime_writes_stable：反复写运行态产物源码桶哈希逐次稳定', () => {
    const tmp = tmpRoot('dev91-rev-wf-stable-');
    try {
      const proj = workflowProject(tmp);
      const first = computeRevisionSet(proj).source.worktreeHash;
      for (let i = 0; i < 3; i += 1) {
        writeFileSync(join(proj, '.workflow', 'incidents.jsonl'), `{"id": "a${i}"}\n`, 'utf8');
      }
      assert.equal(first, computeRevisionSet(proj).source.worktreeHash);
    } finally { cleanup(tmp); }
  });
});

describe('HeadEquivalenceTest', () => {
  test('test_head_shift_without_content_change_keeps_buckets：提交运行态产物只移 head', () => {
    const tmp = tmpRoot('dev91-rev-headshift-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, '.sdd', 'receipts', 'T1', 'verification-T1-2.json'), '{}\n', 'utf8');
      commitAll(proj, 'chore: 提交运行态产物');
      const after = computeRevisionSet(proj);
      assert.notEqual(before.source.head, after.source.head);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assert.equal(before.spec.suiteHash, after.spec.suiteHash);
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_true_for_excluded_only_commit：排除面提交⇒等价', () => {
    const tmp = tmpRoot('dev91-rev-headeq-excluded-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, '.sdd', 'receipts', 'T1', 'verification-T1-2.json'), '{}\n', 'utf8');
      commitAll(proj, 'chore: 提交运行态产物');
      const after = computeRevisionSet(proj);
      assert.deepEqual(headEquivalent(before.source, after.source, proj), { ok: true, reason: 'ok' });
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_false_when_commit_modifies_source_then_worktree_restored：DEV-40 攻击形态被 blob 比对拦下', () => {
    const tmp = tmpRoot('dev91-rev-headeq-dev40-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      commitAll(proj, 'feat: 改源码并提交');
      writeFileSync(join(proj, 'src', 'app.py'), "print('v1')\n", 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      const r = headEquivalent(before.source, after.source, proj);
      assert.equal(r.ok, false, `提交面含源码路径必须判不等价：${r.reason}`);
      assert.ok(r.reason.includes('提交面含源码桶路径'));
      assert.ok(r.reason.includes('提交内容与工作树不一致'), 'B 的分因：内容不一致（非不可比对）');
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_false_when_content_changes：源码内容变化即使仍是祖先也不等价', () => {
    const tmp = tmpRoot('dev91-rev-headeq-content-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      commitAll(proj, 'feat: 改源码');
      const after = computeRevisionSet(proj);
      const r = headEquivalent(before.source, after.source, proj);
      assert.equal(r.ok, false, r.reason);
    } finally { cleanup(tmp); }
  });

  test('test_head_equal_short_circuits：head 逐字相等即等价', () => {
    const tmp = tmpRoot('dev91-rev-headeq-equal-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const rs = computeRevisionSet(proj);
      assert.deepEqual(headEquivalent(rs.source, rs.source, proj), { ok: true, reason: 'ok' });
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_false_for_non_ancestor_head：非祖先⇒不等价且理由点名祖先', () => {
    const tmp = tmpRoot('dev91-rev-headeq-orphan-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      git(proj, 'checkout', '-q', '--orphan', 'other');
      git(proj, 'add', '-A', '--force');
      git(proj, 'commit', '-q', '-m', 'orphan');
      const after = computeRevisionSet(proj);
      const r = headEquivalent(before.source, after.source, proj);
      assert.equal(r.ok, false, r.reason);
      assert.ok(r.reason.includes('祖先'));
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_false_for_bad_head_shape：形态非法⇒不等价并点名形态', () => {
    const tmp = tmpRoot('dev91-rev-headeq-shape-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const rs = computeRevisionSet(proj);
      const after = computeRevisionSet(proj);
      for (const bad of ['unborn', 'HEAD~1', '', 'abc']) {
        const tampered = { ...rs.source, head: bad };
        const r = headEquivalent(tampered, after.source, proj);
        assert.equal(r.ok, false, `${JSON.stringify(bad)} 应判不等价`);
        assert.ok(r.reason.includes('形态'), r.reason);
      }
    } finally { cleanup(tmp); }
  });

  test('test_head_equivalent_false_when_head_unreachable：仓内不存在 sha⇒不等价（非 fail-open）', () => {
    const tmp = tmpRoot('dev91-rev-headeq-unreachable-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const after = computeRevisionSet(proj);
      const tampered = { ...after.source, head: '0'.repeat(40) };
      const r = headEquivalent(tampered, after.source, proj);
      assert.equal(r.ok, false, r.reason);
      assert.ok(r.reason.includes('不可达'));
    } finally { cleanup(tmp); }
  });
});

describe('HeadEquivalenceContentMatchTest', () => {
  test('test_commit_of_modified_dirty_worktree_is_equivalent：签发时已改的 tracked 文件提交后等价', () => {
    const tmp = tmpRoot('dev91-rev-cm-dirty-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      const [before, after] = afterCommit(proj);
      assert.notEqual(before.source.head, after.source.head);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_commit_of_untracked_worktree_file_is_equivalent：untracked 文件提交后等价', () => {
    const tmp = tmpRoot('dev91-rev-cm-untracked-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, 'src', 'new.py'), "print('new')\n", 'utf8');
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_commit_of_multiple_matching_paths_is_equivalent：多路径全匹配⇒等价', () => {
    const tmp = tmpRoot('dev91-rev-cm-multi-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      writeFileSync(join(proj, 'src', 'b.py'), 'b2\n', 'utf8');
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_partial_match_is_rejected：部分匹配⇒拒绝', () => {
    const tmp = tmpRoot('dev91-rev-cm-partial-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, 'src', 'app.py'), "print('v2')\n", 'utf8');
      writeFileSync(join(proj, 'src', 'b.py'), 'b2\n', 'utf8');
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'b.py'), 'b3\n', 'utf8');
      commitAll(proj, 'partial mismatch');
      writeFileSync(join(proj, 'src', 'b.py'), 'b2\n', 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertRejected(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_added_path_missing_in_worktree_is_rejected：提交后删掉新增路径⇒拒绝', () => {
    const tmp = tmpRoot('dev91-rev-cm-added-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, 'src', 'new.py'), 'new\n', 'utf8');
      commitAll(proj, 'add then delete');
      unlinkSync(join(proj, 'src', 'new.py'));
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertRejected(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_deleted_path_is_rejected：删除路径仍拒绝（双侧缺失不判等）', () => {
    const tmp = tmpRoot('dev91-rev-cm-deleted-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      unlinkSync(join(proj, 'src', 'app.py'));
      commitAll(proj, 'delete tracked file');
      writeFileSync(join(proj, 'src', 'app.py'), "print('v1')\n", 'utf8');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertRejected(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_rename_is_expanded_to_a_and_d：重命名展开为 A/D 双路径', () => {
    const tmp = tmpRoot('dev91-rev-cm-rename-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      git(proj, 'mv', 'src/app.py', 'src/app2.py');
      commitAll(proj, 'rename');
      const after = computeRevisionSet(proj);
      const changed = gitChangedPaths(proj, before.source.head, after.source.head);
      assert.notEqual(changed, null);
      assert.ok(changed.includes('src/app.py'));
      assert.ok(changed.includes('src/app2.py'));
    } finally { cleanup(tmp); }
  });

  test('test_non_ascii_path_is_equivalent：非 ASCII 路径⇒等价', () => {
    const tmp = tmpRoot('dev91-rev-cm-nonascii-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, 'src', '中文.py'), "print('中文')\n", 'utf8');
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_crlf_filtered_path_is_equivalent：CRLF 过滤路径⇒等价（走 git hash-object 过滤）', () => {
    const tmp = tmpRoot('dev91-rev-cm-crlf-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, '.gitattributes'), '*.txt text eol=crlf\n', 'utf8');
      writeFileSync(join(proj, 'src', 'a.txt'), Buffer.from('a\r\nb\r\n', 'utf8'));
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  posixOnly('test_symlink_commit_is_equivalent：symlink 提交⇒等价（POSIX）', (t) => {
    const tmp = tmpRoot('dev91-rev-cm-symlink-');
    try {
      const proj = makeGitProject(tmp);
      if (!trySymlink(t, 'app.py', join(proj, 'src', 'link.py'))) return;
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_gitlink_change_is_rejected：gitlink 变更⇒拒绝（不可比对）', () => {
    const tmp = tmpRoot('dev91-rev-cm-gitlink-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      const head = currentHead(proj);
      git(proj, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
      git(proj, 'commit', '-q', '-m', 'add gitlink');
      const after = computeRevisionSet(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertRejected(proj, before, after);
    } finally { cleanup(tmp); }
  });

  posixOnly('test_mode_only_commit_is_equivalent_under_blob_rule：仅 mode 变更⇒等价（blob 口径）', () => {
    const tmp = tmpRoot('dev91-rev-cm-mode-');
    try {
      const proj = makeGitProject(tmp);
      const target = join(proj, 'src', 'app.py');
      chmodSync(target, 0o755);
      const [before, after] = afterCommit(proj);
      assert.ok(git(proj, 'ls-tree', 'HEAD', '--', 'src/app.py').includes('100755'), '提交确含 mode 变更');
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  posixOnly('test_whitespace_path_is_equivalent：首尾空格/内嵌换行路径⇒等价（钉 -z 与无 strip）', () => {
    const tmp = tmpRoot('dev91-rev-cm-space-');
    try {
      const proj = makeGitProject(tmp);
      // 首空格测试 .strip()、尾空格测试路径边界、内嵌换行测试 -z（去掉任一即红）
      writeFileSync(join(proj, ' lead\nx.py'), "print('space')\n", 'utf8');
      writeFileSync(join(proj, 'trail.py '), "print('trail')\n", 'utf8');
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  posixOnly('test_leading_colon_path_is_equivalent：前导冒号路径⇒等价（钉 --literal-pathspecs）', () => {
    const tmp = tmpRoot('dev91-rev-cm-colon-');
    try {
      const proj = makeGitProject(tmp);
      writeFileSync(join(proj, ':x.py'), "print('colon')\n", 'utf8');
      const [before, after] = afterCommit(proj);
      assert.equal(before.source.worktreeHash, after.source.worktreeHash);
      assertEquivalent(proj, before, after);
    } finally { cleanup(tmp); }
  });

  test('test_committed_blob_oid_rejects_tree_and_gitlink：tree/gitlink/缺失一律拒（B 防御直测）', () => {
    const tmp = tmpRoot('dev91-rev-cm-bloboid-');
    try {
      const proj = makeGitProject(tmp);
      const head = currentHead(proj);
      const { committedBlobOid } = _testHooks;
      assert.equal(committedBlobOid(proj, head, 'src'), null, 'tree 路径必须拒');
      assert.equal(committedBlobOid(proj, head, 'nope'), null, '缺失路径必须拒');
      assert.notEqual(committedBlobOid(proj, head, 'src/app.py'), null, 'blob 正例');
      git(proj, 'update-index', '--add', '--cacheinfo', `160000,${head},sub2`);
      git(proj, 'commit', '-q', '-m', 'add gitlink for helper');
      const head2 = currentHead(proj);
      assert.equal(committedBlobOid(proj, head2, 'sub2'), null, 'gitlink 必须拒');
    } finally { cleanup(tmp); }
  });
});

describe('RevisionJsSpecificTest', () => {
  test('revisionSetMatches 严格含 head：仅 head 不同⇒false（contentBucketsEqual 仍 true）', () => {
    const tmp = tmpRoot('dev91-rev-js-head-');
    try {
      const proj = makeGitProjectWithReceipts(tmp);
      const before = computeRevisionSet(proj);
      writeFileSync(join(proj, '.sdd', 'receipts', 'T1', 'verification-T1-2.json'), '{}\n', 'utf8');
      commitAll(proj, 'chore: 提交运行态产物');
      const after = computeRevisionSet(proj);
      assert.notEqual(before.source.head, after.source.head);
      assert.ok(contentBucketsEqual(revisionSetToDict(before), revisionSetToDict(after)), '内容桶全等');
      assert.equal(revisionSetMatches(before, after), false, 'head 是严格相等面的一部分');
      assert.equal(revisionSetMatches(after, computeRevisionSet(proj)), true);
    } finally { cleanup(tmp); }
  });

  test('frame 非 BMP 排序：按码点序（U+FF61 先于 U+1F600；与 JS 默认 UTF-16 码元序相反）', () => {
    const out = _testHooks.frame([['😀.py', 'd1'], ['\uFF61.py', 'd2']]);
    assert.equal(out, '\uFF61.py\0d2\n😀.py\0d1\n', 'Python sorted 按码点：U+FF61(65377) < U+1F600(128512)');
    assert.ok(out.indexOf('\uFF61.py') < out.indexOf('😀.py'));
  });

  posixOnly('无效 UTF-8 路径：computeRevisionSet 抛 RevisionDecodeError、headEquivalent fail-closed', () => {
    // macOS APFS/HFS+ 拒收非法 UTF-8 文件名（EILSEQ），故经 git plumbing 的原始字节 stdin
    // 构造「索引/树含非 UTF-8 路径」形态——与 Linux 上的真实文件名等价，且不依赖文件系统。
    const tmp = tmpRoot('dev91-rev-js-badutf8-');
    try {
      const proj = makeGitProject(tmp);
      const before = computeRevisionSet(proj);
      const blob = gitRaw(proj, ['hash-object', '-w', '--stdin'], Buffer.from('x = 1\n', 'utf8'))
        .stdout.toString('utf8').trim();
      const badRecord = Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tsrc/`), Buffer.from([0xff, 0xfe]), Buffer.from('bad.py\0'),
      ]);
      gitRaw(proj, ['update-index', '-z', '--index-info'], badRecord);
      // 严格解码失败不回退 tree-content-v1：computeRevisionSet 直接抛出（内部未决-131 边界）
      assert.throws(() => computeRevisionSet(proj), (e) => e instanceof RevisionDecodeError);
      // 合成含非 UTF-8 路径的提交（父＝签发 head）：headEquivalent 捕获解码失败→具名 fail-closed
      const tree = gitRaw(proj, ['write-tree'], Buffer.alloc(0)).stdout.toString('utf8').trim();
      const commit = gitRaw(proj, ['commit-tree', tree, '-p', before.source.head, '-m', 'non-utf8 path'], Buffer.alloc(0))
        .stdout.toString('utf8').trim();
      const after = { ...before.source, head: commit };
      const r = headEquivalent(before.source, after, proj);
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes('UTF-8'), r.reason);
    } finally { cleanup(tmp); }
  });
});
