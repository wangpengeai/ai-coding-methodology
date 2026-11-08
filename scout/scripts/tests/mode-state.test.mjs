// 文件：mode-state.test.mjs
// 描述：探路模式只读客户端（mode-state.mjs v3，内部决策-031）的 TDD 测试——v3 本地判定
//       （单文件自含：absent/corrupt/legacy/migratable-v2/expired/pending-recovery/
//       valid 七态 + 读取零 spawn）与桥接定位（env → 同仓 → 装机同级不限版本：同版本
//       优先、最高版本兜底，内部未决-11 脆弱面不残留于增强档）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部用临时目录自建。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 相对说明符按本模块 URL 解析，跨平台一致（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { readStatus, providerCli, providerCandidates, bridgeAvailable, MODES, VERSION_DIR_RE, isValidExpiry, todayIso } = await import('../mode-state.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

// 临时目录统一登记、after 钩子统一清理（同批其余测试文件的 try/finally 口径在此收敛为钩子形态）
const tmpRoots = [];
const track = (r) => { tmpRoots.push(r); return r; };
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

/** 临时项目根（.scout 按需自建，v3 读取不依赖 .sdd）。 */
function tempProject() {
  return track(mkdtempSync(join(tmpdir(), 'scout-mode-')));
}

/** 未来第 n 天的 ISO 日期。 */
function future(n) {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function past(n) {
  return future(-n);
}

function writeMode(root, obj) {
  mkdirSync(join(root, '.scout'), { recursive: true });
  writeFileSync(join(root, '.scout', 'mode.json'), JSON.stringify(obj));
}

/** 造轻量装机树：复制本模块到 <mkt>/scout/<ver>/scripts/，可选造 <mkt>/spec-gate/<ver2>/assurance/scout-tx.mjs。 */
function makeInstalledTree(selfVer, specGateVers) {
  const mkt = track(mkdtempSync(join(tmpdir(), 'scout-mkt-')));
  const scriptsDir = join(mkt, 'scout', selfVer, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(join(HERE, '..', 'mode-state.mjs'), join(scriptsDir, 'mode-state.mjs'));
  cpSync(join(HERE, '..', 'cli-main.mjs'), join(scriptsDir, 'cli-main.mjs'));
  for (const v of specGateVers) {
    const dir = join(mkt, 'spec-gate', v, 'assurance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scout-tx.mjs'), 'process.exit(0); // stub（桥接定位只做存在性检测，v3 读取不 spawn）\n');
  }
  return { mkt, importMod: () => import(pathToFileURL(join(scriptsDir, 'mode-state.mjs')).href) };
}

// ── v3 本地判定七态 ──

test('读取：无声明文件 → valid=false 且 reason=absent', () => {
  const root = tempProject();
  const s = readStatus(root);
  assert.equal(s.valid, false);
  assert.equal(s.reason, 'absent');
  assert.equal(s.pendingRecovery, false);
});

test('读取：非 JSON / 缺字段 / 未知 schemaVersion / 非法 mode 枚举 → corrupt', () => {
  const root1 = tempProject();
  writeMode(root1, 'not-json');
  assert.equal(readStatus(root1).reason, 'corrupt');
  const root2 = tempProject();
  writeMode(root2, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-5' });
  assert.equal(readStatus(root2).reason, 'corrupt');
  const root3 = tempProject();
  writeMode(root3, { schemaVersion: 99, mode: 'explore', expiry: future(14), taskId: '内部任务-5', transactionId: 't' });
  assert.equal(readStatus(root3).reason, 'corrupt');
  const root4 = tempProject();
  writeMode(root4, { schemaVersion: 3, mode: 'bogus', expiry: future(14), taskId: '内部任务-5', transactionId: 't' });
  assert.equal(readStatus(root4).reason, 'corrupt');
});

test('读取：v1 两字段声明 → reason=legacy', () => {
  const root = tempProject();
  writeMode(root, { mode: 'explore', expiry: future(14) });
  const s = readStatus(root);
  assert.equal(s.valid, false);
  assert.equal(s.reason, 'legacy');
});

test('读取：合法未过期 v2 → reason=migratable-v2（参数保留、提示迁移）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 2, mode: 'disposable', expiry: future(30), taskId: '内部任务-V2', transactionId: 'oldtx' });
  const s = readStatus(root);
  assert.equal(s.valid, false);
  assert.equal(s.reason, 'migratable-v2');
  assert.equal(s.mode, 'disposable');
  assert.equal(s.expiry, future(30), '保留可解析值供 SessionStart 提示文案');
  assert.equal(s.taskId, '内部任务-V2');
});

test('读取：v2 与 v3 过期 → reason=expired 且 overdue=true（mode/expiry 保留供提醒分叉）', () => {
  const root2 = tempProject();
  writeMode(root2, { schemaVersion: 2, mode: 'explore', expiry: past(1), taskId: '内部任务-V2', transactionId: 't' });
  const s2 = readStatus(root2);
  assert.equal(s2.valid, false);
  assert.equal(s2.overdue, true);
  assert.equal(s2.reason, 'expired');
  assert.equal(s2.mode, 'explore');
  const root3 = tempProject();
  writeMode(root3, { schemaVersion: 3, mode: 'explore', expiry: past(1), taskId: '内部任务-3', transactionId: 't' });
  const s3 = readStatus(root3);
  assert.equal(s3.valid, false);
  assert.equal(s3.overdue, true);
  assert.equal(s3.reason, 'expired');
});

test('读取：合法 v3 → valid=true，契约字段齐（含 bridgeAvailable 与 transactionId）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-5', transactionId: 'tx-9' });
  const s = readStatus(root);
  assert.equal(s.valid, true);
  assert.equal(s.mode, 'explore');
  assert.equal(s.expiry, future(14));
  assert.equal(s.taskId, '内部任务-5');
  assert.equal(s.transactionId, 'tx-9');
  assert.equal(typeof s.bridgeAvailable, 'boolean');
  assert.equal(MODES.includes(s.mode), true);
});

test('读取：journal 残留 → pendingRecovery=true 且恢复前按无模式（reason=pending-recovery）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-5', transactionId: 'tx' });
  mkdirSync(join(root, '.scout', 'transactions'), { recursive: true });
  writeFileSync(join(root, '.scout', 'transactions', 'journal.json'), '{"state":"prepared"}');
  const s = readStatus(root);
  assert.equal(s.valid, false);
  assert.equal(s.pendingRecovery, true);
  assert.equal(s.reason, 'pending-recovery');
  assert.equal(s.mode, 'explore'); // 字段保留供提示文案
});

test('读取零 spawn：SCOUT_TX_PROVIDER 指向不存在路径时本地判定照常（读取不经提供方）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-5', transactionId: 'tx' });
  const prev = process.env.SCOUT_TX_PROVIDER;
  process.env.SCOUT_TX_PROVIDER = '/nonexistent/scout-tx.mjs';
  try {
    const s = readStatus(root);
    assert.equal(s.valid, true); // v2 语义此处会 fail-safe 为 provider-unavailable；v3 读取纯本地
  } finally {
    if (prev === undefined) delete process.env.SCOUT_TX_PROVIDER;
    else process.env.SCOUT_TX_PROVIDER = prev;
  }
});

// ── 桥接定位（env → 同仓 → 装机同级不限版本）──

test('同仓布局：仓库内 providerCli 可定位 → bridgeAvailable=true（node 入口 scout-tx.mjs）', () => {
  assert.notEqual(providerCli(), null);
  assert.ok(providerCli().endsWith('scout-tx.mjs'), `仓库段入口名，实际：${providerCli()}`);
  assert.equal(bridgeAvailable(), true);
});

test('发现层副本随 1b 删除：mode-state 不再导出 pythonBin', async () => {
  const mod = await import('../mode-state.mjs');
  assert.equal(mod.pythonBin, undefined, '内部决策-051 D1 原文：pythonBin()/PY_CANDIDATES 随删');
});

test('装机树：同版本目录优先命中', async () => {
  const tree = makeInstalledTree('9.9.9', ['9.9.9', '1.0.0']);
  const mod = await tree.importMod();
  const cli = mod.providerCli();
  assert.ok(cli && cli.includes(join('spec-gate', '9.9.9')), `同版本优先，实际：${cli}`);
});

test('装机树：无同版本时最高版本目录兜底命中（内部决策-031 决策 3，不限版本）', async () => {
  const tree = makeInstalledTree('9.9.9', ['1.0.0', '0.9.9']);
  const mod = await tree.importMod();
  const cli = mod.providerCli();
  assert.ok(cli && cli.includes(join('spec-gate', '1.0.0')), `最高版本兜底，实际：${cli}`);
});

test('装机树：无 spec-gate 同级且无 env → 穷尽 false（bridgeAvailable=false）', async () => {
  const tree = makeInstalledTree('9.9.9', []);
  const prev = process.env.SCOUT_TX_PROVIDER;
  delete process.env.SCOUT_TX_PROVIDER;
  try {
    const mod = await tree.importMod();
    assert.equal(mod.providerCli(), null);
    assert.equal(mod.bridgeAvailable(), false);
    const cands = mod.providerCandidates();
    assert.equal(cands.find((c) => c.source === 'repo').path, null); // 副本上溯三级无 spec-gate
  } finally {
    if (prev !== undefined) process.env.SCOUT_TX_PROVIDER = prev;
  }
});

test('env 段：SCOUT_TX_PROVIDER 命中即用（显式用户意志，不做存在性回退）', async () => {
  const tree = makeInstalledTree('9.9.9', []);
  const stub = join(tree.mkt, 'explicit-bridge.mjs');
  writeFileSync(stub, '// 显式注入\n');
  const prev = process.env.SCOUT_TX_PROVIDER;
  process.env.SCOUT_TX_PROVIDER = stub;
  try {
    const mod = await tree.importMod();
    assert.equal(mod.providerCli(), stub);
  } finally {
    if (prev === undefined) delete process.env.SCOUT_TX_PROVIDER;
    else process.env.SCOUT_TX_PROVIDER = prev;
  }
});

test('版本目录正则：X.Y.Z 与预发布后缀命中、非版本名不命中（排序比较用，非激活门控）', () => {
  assert.ok(VERSION_DIR_RE.test('9.9.9'));
  assert.ok(VERSION_DIR_RE.test('0.2.5-beta'));
  assert.ok(!VERSION_DIR_RE.test('scout'));
  assert.ok(!VERSION_DIR_RE.test('scripts'));
});

test('装机树副本 readStatus：本地判定生效（fixture v3 → valid，全程零 spawn）', async () => {
  const tree = makeInstalledTree('9.9.9', ['9.9.9']);
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'disposable', expiry: future(14), taskId: '内部任务-7', transactionId: 'tx' });
  const mod = await tree.importMod();
  const s = mod.readStatus(root);
  assert.equal(s.valid, true);
  assert.equal(s.mode, 'disposable');
  assert.equal(existsSync(join(root, '.sdd')), false); // v3 不创建不依赖 .sdd
});

// ── 步骤 5（T15/T17）：严格日历日 / id 类型 / 当天口径 / 读异常分类 ──

test('T15 严格日历日：2027-02-30 → corrupt（不接受 Date.parse 滚日）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: '2027-02-30', taskId: '内部任务-T15-1', transactionId: 'tx' });
  assert.equal(readStatus(root).reason, 'corrupt');
  assert.equal(isValidExpiry('2027-02-30'), false);
  assert.equal(isValidExpiry('2027-02-28'), true);
  assert.equal(isValidExpiry('2027-3-1'), false);
});

test('T15 id 类型：taskId / transactionId 非字符串 → corrupt', () => {
  const root1 = tempProject();
  writeMode(root1, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: 123, transactionId: 'tx' });
  assert.equal(readStatus(root1).reason, 'corrupt');
  const root2 = tempProject();
  writeMode(root2, { schemaVersion: 3, mode: 'explore', expiry: future(14), taskId: '内部任务-5', transactionId: {} });
  assert.equal(readStatus(root2).reason, 'corrupt');
});

test('T15 当天 expiry：v3 valid 且 overdue=false（严格日历日口径）', () => {
  const root = tempProject();
  writeMode(root, { schemaVersion: 3, mode: 'explore', expiry: todayIso(), taskId: '内部任务-5', transactionId: 'tx' });
  const s = readStatus(root);
  assert.equal(s.valid, true, JSON.stringify(s));
  assert.equal(s.overdue, false);
});

test('T15 v2 当天 expiry：migratable-v2 且 migrate 当天可迁', async () => {
  const { migrateV2 } = await import('../mode-lifecycle.mjs');
  const root = tempProject();
  writeMode(root, { schemaVersion: 2, mode: 'explore', expiry: todayIso(), taskId: '内部任务-5', transactionId: 'tx' });
  assert.equal(readStatus(root).reason, 'migratable-v2');
  const r = migrateV2(root);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('T17 读异常分类：mode.json 为目录 → reason=unreadable 且保留 errno', () => {
  const root = tempProject();
  mkdirSync(join(root, '.scout', 'mode.json'), { recursive: true });
  const s = readStatus(root);
  assert.equal(s.reason, 'unreadable', JSON.stringify(s));
  assert.equal(s.errno, 'EISDIR');
});
