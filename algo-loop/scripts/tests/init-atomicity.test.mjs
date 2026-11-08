// 文件：init-atomicity.test.mjs
// 描述：algo-loop 立项（init）原子性与数据守护测试（内部任务-269 R01/R02/R07/R15；先 RED 后 GREEN）——
//       同父暂存目录 + rename 前显式 `.algo` 守卫：失败零残留、并发竞争干净拒因、孤儿资产拒绝不覆盖、
//       契约前置校验（复用读侧单源）、contractVersion 跟随契约版本、baselineRef 归一/拒绝、重复 init 幂等拒绝。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/init-atomicity.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _testHooks, applyWrite } from '../algo-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..', '..');
const LINT = join(PLUGIN, 'scripts', 'check-consistency.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-init-'));
  roots.push(root);
  return root;
}

const CONTRACT = (over = {}) => ({
  schemaVersion: 1,
  version: 1,
  metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'x', version: 'v1' } }],
  baselineRef: '',
  targets: {},
  guardrails: [],
  ...over,
});

const stagingLeftovers = (root) => readdirSync(root).filter((n) => n.startsWith('.algo.init-'));

test('注入式失败零残留（R01；暂存构造后、rename 前抛错 → 退 1、.algo 不存在、无暂存残留、钩子复原）', () => {
  const root = makeRoot();
  const before = _testHooks.beforeRename;
  _testHooks.beforeRename = () => {
    throw new Error('inject-boom');
  };
  let r;
  try {
    r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() });
  } finally {
    _testHooks.beforeRename = before;
  }
  assert.equal(r.ok, false);
  assert.ok(typeof r.message === 'string' && r.message.includes('inject-boom'));
  assert.equal(existsSync(join(root, '.algo')), false);
  assert.deepEqual(stagingLeftovers(root), []);
});

test('并发竞争干净拒因（rename 前显式 `.algo` 守卫；空目录即可命中、不依赖 errno）', () => {
  const root = makeRoot();
  const before = _testHooks.beforeRename;
  let injectedAlgo = null;
  _testHooks.beforeRename = () => {
    injectedAlgo = join(root, '.algo');
    mkdirSync(injectedAlgo);
    writeFileSync(join(injectedAlgo, 'marker.txt'), 'winner');
  };
  let r;
  try {
    r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() });
  } finally {
    _testHooks.beforeRename = before;
  }
  assert.equal(r.ok, false);
  assert.match(r.message, /并发 init 竞争/);
  assert.deepEqual(stagingLeftovers(root), []);
  assert.deepEqual(readdirSync(injectedAlgo), ['marker.txt'], '并发胜者占位内容须保持不变');
});

test('不完整 .algo 拒绝不覆盖（R02；孤儿资产 → 退 1 列现存件、四件字节不变、不生成 project.json）', () => {
  const root = makeRoot();
  const algo = join(root, '.algo');
  mkdirSync(join(algo, 'badcases'), { recursive: true });
  const files = {
    'contract.json': JSON.stringify(CONTRACT()),
    'ledger.jsonl': '{"id":"i1"}\n',
    'baselines.json': JSON.stringify({ schemaVersion: 1, entries: [] }),
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(algo, name), body);
  const r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() });
  assert.equal(r.ok, false);
  assert.match(r.message, /既有资产|不覆盖/);
  assert.equal(existsSync(join(algo, 'project.json')), false);
  for (const [name, body] of Object.entries(files)) assert.equal(readFileSync(join(algo, name), 'utf8'), body, `${name} 字节不变`);
  assert.ok(r.message.includes('ledger.jsonl') || r.message.includes('baselines.json'), '拒绝消息须列出既有件');
});

test('契约前置校验（R07；metrics 缺 toolchain → 退 1 且 .algo 不存在；contract:null 干净拒因）', () => {
  const root = makeRoot();
  const badMetric = { name: 'm', definition: 'd', direction: 'higher-better', unit: 'u' };
  const r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT({ metrics: [badMetric] }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /toolchain/);
  assert.equal(existsSync(join(root, '.algo')), false);
  const r2 = applyWrite(root, 'init', { projectId: 'p', contract: null });
  assert.equal(r2.ok, false);
  assert.equal(typeof r2.message, 'string');
});

test('contractVersion 与 baselineRef 归一（R15/R07；version=2 跟随、空 baselineRef→b0、非 b0 拒绝）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT({ version: 2 }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const project = JSON.parse(readFileSync(join(root, '.algo', 'project.json'), 'utf8'));
  const contract = JSON.parse(readFileSync(join(root, '.algo', 'contract.json'), 'utf8'));
  assert.equal(project.contractVersion, 2);
  assert.equal(contract.baselineRef, 'b0');
  const lint = spawnSync(process.execPath, [LINT, '--project-root', root], { encoding: 'utf8' });
  assert.equal(lint.status, 0, `lint 应一致：${lint.stdout}${lint.stderr}`);
  const root2 = makeRoot();
  const r2 = applyWrite(root2, 'init', { projectId: 'p', contract: CONTRACT({ baselineRef: 'b9' }) });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /baselineRef/);
  assert.equal(existsSync(join(root2, '.algo')), false);
});

test('连续两次 init 幂等拒绝；成功 init 后无暂存残留（R01）', () => {
  const root = makeRoot();
  const r1 = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() });
  assert.equal(r1.ok, true);
  assert.deepEqual(stagingLeftovers(root), []);
  const r2 = applyWrite(root, 'init', { projectId: 'q', contract: CONTRACT() });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /已存在 .algo\/project\.json/);
});

test('`.algo` 为普通文件 → 退 1 干净拒因（R02）', () => {
  const root = makeRoot();
  writeFileSync(join(root, '.algo'), 'not-a-dir');
  const r = applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() });
  assert.equal(r.ok, false);
  assert.match(r.message, /不是目录|非目录|已存在/);
  assert.deepEqual(stagingLeftovers(root), []);
});

// —— 内部任务-269 评审修复轮（A1 规格歧义 / E5 权限位）——

test('缺省 baselineRef 归一为 b0（§2「空/缺省归一」口径；§2a 存储面仍为字符串）', () => {
  const root = makeRoot();
  const contract = CONTRACT();
  delete contract.baselineRef;
  const r = applyWrite(root, 'init', { projectId: 'p', contract });
  assert.equal(r.ok, true, JSON.stringify(r));
  const stored = JSON.parse(readFileSync(join(root, '.algo', 'contract.json'), 'utf8'));
  assert.equal(stored.baselineRef, 'b0');
});

test('`.algo` 权限按常规目录位落位（mkdtemp 0700 不泄漏到提交态）', { skip: process.platform === 'win32' && 'win32 无 POSIX 权限位：fs.stat 对目录合成 mode 恒 0666，0777&~umask 断言仅在 POSIX 机可观测（内部任务-279；内部任务-278 归因 R1）' }, () => {
  const root = makeRoot();
  assert.equal(applyWrite(root, 'init', { projectId: 'p', contract: CONTRACT() }).ok, true);
  const mode = statSync(join(root, '.algo')).mode & 0o777;
  assert.equal(mode, 0o777 & ~process.umask(), `.algo 模式应为 0777&~umask，实际 ${mode.toString(8)}`);
});

test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
