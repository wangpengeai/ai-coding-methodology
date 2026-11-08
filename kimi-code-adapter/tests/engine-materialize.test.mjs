// 文件：kimi-code-adapter/tests/engine-materialize.test.mjs
// 描述：引擎随包物化与消费点接线判别力——①闭包清单＝两 JSON + src/*.mjs + strategies 六族；
//       ②import 图 ⊆ 清单；③包根装载探针正/负（多一级/少一级都不可读）；④「逐字节全等但
//       不可装载」（删 validate.mjs）唯探针判红；⑤兜底链单源（PENDING_LIMIT ≡ 规则
//       params.kimi.pendingLimit）；⑥kimi 规则数据断言（relayEvents/burstCap/capNote/
//       accepted=[startup,resume]/rename/defaultMount）；⑦三个消费点接线判别力（改包内
//       规则数据 ⇒ 行为随动；停用内联实现即红）；⑧入口守卫 symlink 判别力。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, test } from 'node:test';

import { loadEngine } from '../../plugin-core/src/engine.mjs';
import { planPackage, verifyPackageFiles } from '../cli.mjs';
import { PENDING_LIMIT, normalizePayload, translatePreToolUseResponse } from '../kimi/hook-lib.mjs';
import { applyAgentGate } from '../src/agents.mjs';
import { ADAPTER_ROOT, REPO_ROOT, removeRoot, tempRoot } from './helpers.mjs';

const PLUGIN = 'workflow';

/** 物化到临时宿主根（真实 CLI，覆盖 install 路径）。 */
function installToTemp() {
  const homeDir = tempRoot('engine-mat');
  const r = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', homeDir], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `install 应成功：${r.stdout}${r.stderr}`);
  return { homeDir, pkgRoot: join(homeDir, 'plugins', 'managed', PLUGIN) };
}

/** 装载探针：以包根为 repoRoot 装载副本引擎（等价于运行期 shim 的装载路径）。 */
function probe(pkgRoot) {
  const script = `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs')).href)}).then((m) => { const e = m.loadEngine(${JSON.stringify(pkgRoot)}); if (typeof e.applyRule !== 'function') throw new Error('applyRule 缺失'); const p = e.applyRule('source-widen-normalize', 'kimi', { source: 'resume' }); if (p.result !== 'resume') throw new Error('kimi 规则探针异常'); }).catch((e) => { process.stderr.write(String(e && e.message)); process.exit(3); });`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
}

/** 从包内动态 import 引擎（消费点判别力用例的引擎来源，等价运行期 shim 装载路径）。 */
async function engineFrom(pkgRoot) {
  const { loadEngine: load } = await import(pathToFileURL(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs')).href);
  return load(pkgRoot);
}

it('物化清单：引擎闭包齐备（两 JSON + src/*.mjs + strategies 六族）', () => {
  const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
  const rels = plan.files.map((f) => f.rel);
  for (const rel of ['plugin-core/degradation-rules.json', 'plugin-core/capability-matrix.json', 'plugin-core/src/engine.mjs', 'plugin-core/src/validate.mjs']) {
    assert.ok(rels.includes(rel), `清单应含 ${rel}`);
  }
  const strategies = readdirSync(join(REPO_ROOT, 'plugin-core', 'src', 'strategies')).filter((n) => n.endsWith('.mjs'));
  assert.equal(strategies.length, 6, '六族执行器');
  for (const name of strategies) assert.ok(rels.includes(`plugin-core/src/strategies/${name}`), `清单应含 strategies/${name}`);
});

it('import 图 ⊆ 物化清单：漏 validate.mjs 时副本 import() 直接 ERR_MODULE_NOT_FOUND', () => {
  const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
  const rels = new Set(plan.files.map((f) => f.rel));
  const srcDir = join(REPO_ROOT, 'plugin-core', 'src');
  const files = [...readdirSync(srcDir).filter((n) => n.endsWith('.mjs')), ...readdirSync(join(srcDir, 'strategies')).filter((n) => n.endsWith('.mjs')).map((n) => join('strategies', n))];
  for (const rel of files) {
    const text = readFileSync(join(srcDir, rel), 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join('plugin-core', 'src', rel.split('\\').join('/').split('/').slice(0, -1).join('/'), m[1]).split('\\').join('/');
      assert.ok(rels.has(target), `${rel} 的 import ${m[1]} → ${target} 必须在物化清单内`);
    }
  }
});

it('装载探针：物化包根可装载（多一级/少一级均不可读）', () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    assert.ok(existsSync(join(pkgRoot, 'plugin-core', 'src', 'validate.mjs')), '副本应含 validate.mjs');
    const ok = probe(pkgRoot);
    assert.equal(ok.status, 0, `探针应成功：${ok.stderr}`);
    for (const wrong of [join(pkgRoot, 'plugin-core'), join(homeDir, 'plugins', 'managed')]) {
      const bad = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs')).href)}).then((m) => { m.loadEngine(${JSON.stringify(wrong)}); process.exit(0); }).catch(() => process.exit(3));`], { encoding: 'utf8', windowsHide: true });
      assert.equal(bad.status, 3, `${wrong} 不应可装载`);
    }
  } finally { removeRoot(homeDir); }
});

test('逐字节全等但不可装载：删 validate.mjs → 装载探针红、verify 红', () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    rmSync(join(pkgRoot, 'plugin-core', 'src', 'validate.mjs'));
    const bad = probe(pkgRoot);
    assert.notEqual(bad.status, 0, '缺 validate.mjs 时探针必须失败');
    assert.match(String(bad.stderr), /validate\.mjs|MODULE_NOT_FOUND/, '失败原因须可诊断');
    const verify = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'verify', '--data-dir', homeDir], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(verify.status, 0, '副本缺失须被 verify 判红');
  } finally { removeRoot(homeDir); }
});

it('副本污损：改动引擎文件 → verify 报漂移（sha256 逐文件对拍）', () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    const target = join(pkgRoot, 'plugin-core', 'src', 'validate.mjs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// tampered\n`, 'utf8');
    const verify = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'verify', '--data-dir', homeDir], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(verify.status, 0, '污损须被 verify 判红');
    assert.match(`${verify.stdout}${verify.stderr}`, /变更 1/, '报告须体现变更计数');
  } finally { removeRoot(homeDir); }
});

it('装载探针判别力：计划与副本同时缺 strategies ⇒ sha256 面全绿、唯有探针判红', () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
    rmSync(join(pkgRoot, 'plugin-core', 'src', 'strategies'), { recursive: true, force: true });
    rmSync(join(pkgRoot, 'kimi.plugin.json'), { force: true });
    const trimmed = {
      ...plan,
      files: plan.files.filter((file) => !file.rel.startsWith('plugin-core/src/strategies/') && file.rel !== 'kimi.plugin.json'),
    };
    const report = verifyPackageFiles({ targetRoot: join(homeDir, 'plugins', 'managed'), plan: trimmed });
    assert.deepEqual(report.missing, [], 'sha256 面不应有缺失');
    assert.deepEqual(report.changed, [], 'sha256 面应全绿（探针的运行前提）');
    assert.deepEqual(report.extra, [], 'sha256 面应全绿（多余文件也不得出现）');
    assert.ok(report.probe !== null && /装载探针失败/.test(report.probe), `唯有装载探针能判红该形态，实得 probe=${String(report.probe)}`);
  } finally { removeRoot(homeDir); }
});

it('兜底链单源：PENDING_LIMIT ≡ 规则 stop-pending-relay.params.kimi.pendingLimit', () => {
  const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
  const relay = rules.rules.find((rule) => rule.id === 'stop-pending-relay');
  assert.equal(PENDING_LIMIT, relay?.params?.kimi?.pendingLimit, 'hook-lib 队列上限必须与规则 pendingLimit 同值（数据漂移即红）');
});

it('kimi 规则数据断言：stop-pending-relay 出 relayEvents/burstCap/pendingLimit/capNote；source-widen accepted=[startup,resume]；message-slot rename；agent 默认关', () => {
  const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
  const relay = rules.rules.find((rule) => rule.id === 'stop-pending-relay');
  assert.deepEqual(relay.params.kimi.relayEvents, ['Stop', 'SessionStart', 'PostToolUse', 'PostToolUseFailure'], '观察面帧同队列（差异面 row 1）');
  assert.equal(relay.params.kimi.burstCap, 3);
  assert.equal(relay.params.kimi.pendingLimit, 20);
  assert.match(relay.params.kimi.capNote, /连击上限/);
  assert.equal(relay.params.kimi.deliverOn, 'UserPromptSubmit');
  const widen = rules.rules.find((rule) => rule.id === 'source-widen-normalize');
  assert.deepEqual(widen.params.kimi, { to: 'startup', accepted: ['startup', 'resume'] }, '宿主词表仅 startup/resume（差异面 row 10）');
  const slot = rules.rules.find((rule) => rule.id === 'message-slot-migration');
  assert.deepEqual(slot.params.kimi.rename, { systemMessage: 'permissionDecisionReason' });
  const agent = rules.rules.find((rule) => rule.id === 'agent-default-off-fail-closed');
  assert.deepEqual(agent.params.kimi, { defaultMount: false, unknownTool: 'reject' });
  // applyRule 可调用且 kimi 列触发（executor 门控形态：无 triggerEvent 时入队腿走实施批接线）
  const engine = loadEngine(REPO_ROOT);
  const out = engine.applyRule('stop-pending-relay', 'kimi', { event: 'Stop', text: 't', sessionKey: 'sk', blocked: false }, { readState: () => null, writeState() {} });
  assert.equal(out.applied, true, 'kimi 列参与分派');
  assert.deepEqual(out.result, { enqueued: false, reason: 'event-not-relayed' }, '引擎测试登记的接线前提（实施批省略 ctx.event 走门控）');
});

it('消费点判别力（来源归一）：改包内 accepted ⇒ 归一结果随规则变化（证明真走引擎）', async () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    const normalize = async (engine) => normalizePayload('SessionStart', { source: 'clear' }, { projectDir: 'C:/tmp', engine }).source;
    assert.equal(await normalize(await engineFrom(pkgRoot)), 'startup', '基线：域外值 clear 归一为 startup');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'source-widen-normalize') rule.params.kimi.accepted = ['startup', 'resume', 'clear'];
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      assert.equal(await normalize(await engineFrom(pkgRoot)), 'clear', '改规则后必须随动（否则说明该点没走引擎）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
    assert.equal(await normalize(await engineFrom(pkgRoot)), 'startup', '还原后回到基线');
  } finally { removeRoot(homeDir); }
});

it('消费点判别力（槽位迁移）：改包内 rename ⇒ 槽位不再迁移（证明真走引擎）', async () => {
  const { homeDir, pkgRoot } = installToTemp();
  try {
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    const envelope = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: 'SM' } };
    const reasonOf = async (engine) => translatePreToolUseResponse(envelope, { engine }).stderr;
    assert.equal(await reasonOf(await engineFrom(pkgRoot)), 'SM', '基线：systemMessage 迁移为 permissionDecisionReason');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'message-slot-migration') rule.params.kimi.rename = { otherSlot: 'permissionDecisionReason' };
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      assert.equal(await reasonOf(await engineFrom(pkgRoot)), '', '改规则后槽位必须不再迁移（否则说明该点没走引擎）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  } finally { removeRoot(homeDir); }
});

it('消费点判别力（agent 门控）：目录不可得/交集为空 → 拒挂（fail-closed 极性来自规则）', () => {
  const engine = loadEngine(REPO_ROOT);
  const inventory = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8')).capabilities.hostToolInventory.kimi;
  assert.ok(Array.isArray(inventory) && inventory.includes('Bash') && inventory.includes('Glob'), '矩阵 kimi 列词表在位');
  const pass = applyAgentGate(engine, ['Glob', 'Read', 'EvilTool'], inventory);
  assert.deepEqual(pass, { reject: false, defaultMount: false, allowedTools: ['Glob', 'Read'] }, '交集过滤 + defaultMount 数据驱动');
  const noDir = applyAgentGate(engine, ['Glob'], null);
  assert.equal(noDir.reject, true, '目录不可得 → 拒挂');
  const empty = applyAgentGate(engine, ['EvilTool'], inventory);
  assert.equal(empty.reject, true, '交集为空 → 拒挂（不得退化成不过滤）');
  assert.throws(() => applyAgentGate({ applyRule: () => ({ applied: false }) }, ['Glob'], inventory), /规则库字段契约漂移/, '规则漂移具名抛错（禁静默放行）');
});

it('矩阵 kimi 列对拍：hostToolInventory.kimi 词表与 agent 映射值域一致（Glob/TodoList/FetchURL 在册）', () => {
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const inventory = matrix.capabilities.hostToolInventory.kimi;
  for (const mapped of Object.values({ LS: 'Glob', TodoWrite: 'TodoList', WebFetch: 'FetchURL' })) {
    assert.ok(inventory.includes(mapped), `映射目标 ${mapped} 须在宿主词表内`);
  }
  assert.ok(!inventory.includes('LS') && !inventory.includes('TodoWrite') && !inventory.includes('WebFetch'), 'ZCode 侧词不得混入宿主词表');
  assert.equal(matrix.hosts.includes('kimi'), true, '矩阵 hosts 含 kimi');
});

it('入口守卫：经**符号链接路径**调用 CLI 必须正常执行（realpathSync 判别力）', () => {
  const linkRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-symlink-')));
  try {
    const linkPath = join(linkRoot, 'cli-link.mjs');
    symlinkSync(join(ADAPTER_ROOT, 'cli.mjs'), linkPath);
    const r = spawnSync(process.execPath, [linkPath, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0);
    assert.match(String(r.stdout), /用法/, `symlink 路径下 CLI 必须有输出（实得 stdout=${JSON.stringify(r.stdout)}）`);
  } finally { removeRoot(linkRoot); }
});
