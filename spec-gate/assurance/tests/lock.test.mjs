// 文件：lock.test.mjs
// 描述：lock.mjs 单测（内部任务-241 步骤 5）——双 acquire 第二者失败／陈旧锁回收单胜且返回
//       retired 诊断／release 非持有者不删新锁。tmp 夹具自含、零真机触达。
// 作者：wangp  创建：2026-10-27  版权：MIT（见 spec-gate/LICENSE）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { _testHooks, acquireLock, releaseLock } from '../lock.mjs';

describe('LockTest (DEV-241)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'dev241-lock-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); });

  test('双 acquire：第二者失败且持有者内容可读', () => {
    const lock = join(tmp, 'a.lock');
    const first = acquireLock(lock, { owner: 'owner-1' });
    assert.equal(first.ok, true);
    assert.equal(readFileSync(lock, 'utf8'), 'owner-1');
    const second = acquireLock(lock, { owner: 'owner-2' });
    assert.equal(second.ok, false, '未陈旧时第二者不得获取');
    assert.equal(readFileSync(lock, 'utf8'), 'owner-1', '失败者不得改写持有者');
  });

  test('陈旧锁回收：单胜并返回 retired 诊断；release 非持有者不删新锁', () => {
    const lock = join(tmp, 'b.lock');
    writeFileSync(lock, 'stale-owner', 'utf8');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, past, past);
    const got = acquireLock(lock, { owner: 'new-owner', staleSeconds: 300 });
    assert.equal(got.ok, true, '陈旧锁须被回收后获取成功');
    assert.ok(got.retired !== null, '回收事件须返回诊断');
    assert.equal(got.retired.retiredOwner, 'stale-owner', '回收诊断须带原持有者');
    assert.equal(readFileSync(lock, 'utf8'), 'new-owner');
    assert.equal(releaseLock(lock, 'stale-owner'), false, '非持有者不得删锁');
    assert.equal(readFileSync(lock, 'utf8'), 'new-owner', '锁仍在位');
  });

  test('release 持有者删除；缺失锁不抛', () => {
    const lock = join(tmp, 'c.lock');
    const got = acquireLock(lock, { owner: 'owner-x' });
    assert.equal(releaseLock(lock, got.owner), true);
    assert.equal(releaseLock(lock, 'owner-x'), false, '已删除的锁再释放返回 false 不抛');
  });

  test('锁写失败：清理自建锁文件（不留下新鲜空锁导致 300s ELOCKED）', () => {
    const lock = join(tmp, 'd.lock');
    _testHooks.afterOpen = () => {
      const e = new Error('注入故障：owner 写入失败');
      e.code = 'EIO';
      throw e;
    };
    try {
      assert.throws(() => acquireLock(lock, { owner: 'owner-y' }), (e) => e.code === 'EIO');
      assert.equal(existsSync(lock), false, '写失败锁文件须被清理');
    } finally {
      _testHooks.afterOpen = null;
    }
    const again = acquireLock(lock, { owner: 'owner-z' });
    assert.equal(again.ok, true, '清理后可正常获取');
  });

  test('DEV-242 §四-2：回收者偷到新鲜锁→link 复原让位（不覆盖、零残留）', () => {
    const lock = join(tmp, 'e.lock');
    writeFileSync(lock, 'fresh-owner', 'utf8');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, past, past); // 先伪装陈旧，让回收路径启动
    let retiredPath = null;
    _testHooks.afterStaleDecision = (_lockPath, retired) => {
      retiredPath = retired;
      utimesSync(retired, new Date(), new Date()); // 模拟回收瞬间被他人刷新为新鲜锁
    };
    try {
      const got = acquireLock(lock, { owner: 'raider', staleSeconds: 300 });
      assert.equal(got.ok, false, '偷到新鲜锁须认负');
      assert.equal(readFileSync(lock, 'utf8'), 'fresh-owner', '新鲜锁内容须被原子 link 复原');
      assert.equal(existsSync(retiredPath), false, 'retired 硬链须删除（零残留）');
    } finally {
      _testHooks.afterStaleDecision = null;
    }
  });

  test('DEV-242 §四-2：link 复原失败（第三方已建锁）→fail-stop 且不覆盖第三方锁', () => {
    const lock = join(tmp, 'f.lock');
    writeFileSync(lock, 'fresh-owner', 'utf8');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, past, past);
    let retiredPath = null;
    _testHooks.afterStaleDecision = (_lockPath, retired) => {
      retiredPath = retired;
      utimesSync(retired, new Date(), new Date());
      writeFileSync(lock, 'third-owner', 'utf8'); // 第三方已抢先建锁 → link 必 EEXIST
    };
    try {
      assert.throws(() => acquireLock(lock, { owner: 'raider', staleSeconds: 300 }), /锁回收冲突/, 'S-1：无法复原须 fail-stop');
      assert.equal(readFileSync(lock, 'utf8'), 'third-owner', '不得覆盖第三方锁');
      assert.equal(existsSync(retiredPath), true, '被摘新鲜锁保留为冲突证据（不得静默删除）');
    } finally {
      _testHooks.afterStaleDecision = null;
    }
  });

  test('DEV-242 安全复审 S-1：link 复原 EPERM（不支持硬链接）→fail-stop 且保留证据', () => {
    const lock = join(tmp, 'g.lock');
    writeFileSync(lock, 'fresh-owner', 'utf8');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, past, past);
    let retiredPath = null;
    _testHooks.afterStaleDecision = (_lockPath, retired) => {
      retiredPath = retired;
      utimesSync(retired, new Date(), new Date()); // 偷到新鲜锁
    };
    _testHooks.linkRestore = () => {
      const e = new Error('注入故障：不支持硬链接');
      e.code = 'EPERM';
      throw e;
    };
    try {
      assert.throws(() => acquireLock(lock, { owner: 'raider', staleSeconds: 300 }), /锁回收复原失败/, '非 EEXIST 的 link 失败须 fail-stop');
      assert.equal(existsSync(retiredPath), true, '被摘新鲜锁保留（不得 unlink 后静默返回）');
    } finally {
      _testHooks.afterStaleDecision = null;
      _testHooks.linkRestore = null;
    }
  });

  test('DEV-242 安全复审 S-2：release 原子隔离，非持有者不误删且锁内容复原', () => {
    const lock = join(tmp, 'h.lock');
    const first = acquireLock(lock, { owner: 'owner-s2' });
    assert.equal(first.ok, true);
    assert.equal(releaseLock(lock, 'not-owner'), false, '非持有者释放返回 false');
    assert.equal(readFileSync(lock, 'utf8'), 'owner-s2', 'quarantine 核验失败后原子复原原锁内容');
    assert.equal(releaseLock(lock, first.owner), true, '持有者释放成功');
    assert.equal(existsSync(lock), false, '持有者释放后锁不在位');
  });
});
