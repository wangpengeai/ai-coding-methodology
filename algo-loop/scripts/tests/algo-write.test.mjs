// 文件：algo-write.test.mjs
// 描述：algo-loop 写侧五操作测试（内部接口-22 §2/§3/§4 + 内部模块-18 内部规则-4/6/7）——init 幂等/契约前置、
//       台账六要素与同 id 幂等、基线追加与追溯、bad case 状态机、原子写、CLI 契约与 dogfood 全环。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：init 契约前置校验/写侧门禁/CLI 严格参数与 `=` 形态/根守卫用例同步。
// 自检：node --test "algo-loop/scripts/tests/algo-write.test.mjs"
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const { applyWrite } = await import('../algo-write.mjs');

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'algo-write-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CONTRACT = (toolchainCmd) => ({
  schemaVersion: 1,
  version: 1,
  metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: toolchainCmd, version: 'v1' } }],
  baselineRef: 'b0',
  targets: {},
  guardrails: [],
});

function initProject(root, toolchainCmd = 'echo measure') {
  applyWrite(root, 'init', {
    projectId: 'demo',
    contract: CONTRACT(toolchainCmd),
  });
}

test('① init 成功建五件（空 ledger、badcases 目录、B0 注册）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'init', { projectId: 'demo', contract: CONTRACT('echo measure') });
  assert.ok(r.ok);
  const algo = join(root, '.algo');
  assert.ok(existsSync(join(algo, 'project.json')));
  assert.ok(existsSync(join(algo, 'badcases')));
  assert.equal(readFileSync(join(algo, 'ledger.jsonl'), 'utf8'), '');
  const baselines = JSON.parse(readFileSync(join(algo, 'baselines.json'), 'utf8'));
  assert.equal(baselines.entries.length, 1);
  assert.equal(baselines.entries[0].id, 'b0');
});

test('② init 幂等拒绝（已有 project.json → 失败不覆盖）', () => {
  const root = makeRoot();
  initProject(root);
  const before = readFileSync(join(root, '.algo', 'project.json'), 'utf8');
  const r = applyWrite(root, 'init', { projectId: 'other', contract: CONTRACT('') });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(root, '.algo', 'project.json'), 'utf8'), before);
});

test('③ init 时 toolchain 空占位合法（甲案：不强制非空）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'init', { projectId: 'demo', contract: CONTRACT('') });
  assert.ok(r.ok);
});

test('④ ledger-append 六要素齐备成功追加（自动 at 字段）', () => {
  const root = makeRoot();
  initProject(root);
  const r = applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
  assert.ok(r.ok);
  const lines = readFileSync(join(root, '.algo', 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.id, 'i1');
  assert.ok(typeof row.at === 'string' && row.at.includes('T'));
});

test('⑤ 缺 singleVariable / metricsRef 空串 → 失败（复审 F2：写侧校验 metricsRef 非空）', () => {
  const root = makeRoot();
  initProject(root);
  const r = applyWrite(root, 'ledger-append', { id: 'i2', hypothesis: 'h', change: 'c', metricsRef: 'r', decision: 'continue' });
  assert.equal(r.ok, false);
  const r2 = applyWrite(root, 'ledger-append', { id: 'i3', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: '', decision: 'continue' });
  assert.equal(r2.ok, false);
  assert.ok(r2.message.includes('metricsRef'), '拒因钉到字段名');
});

test('⑥ 同 id 二写 → 失败', () => {
  const root = makeRoot();
  initProject(root);
  applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
  const r = applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h2', change: 'c2', singleVariable: { declared: true, note: '' }, metricsRef: 'r2', decision: 'continue' });
  assert.equal(r.ok, false);
});

test('⑦ 契约 toolchain 空占位未补齐时首轮 append → 失败（消息含「测量工具链未声明」，甲案）；toolchain 缺键同拒（收尾审查修复：旧条件使缺键形态逃逸）', () => {
  const root = makeRoot();
  initProject(root, '');
  const r = applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('测量工具链未声明'));
  const root2 = makeRoot();
  const init2 = applyWrite(root2, 'init', {
    projectId: 'demo',
    contract: { schemaVersion: 1, version: 1, metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u' }], baselineRef: 'b0', targets: {}, guardrails: [] },
  });
  assert.equal(init2.ok, false, '指标缺 toolchain 键（非空串占位）须在 init 前置校验即拒——防写侧放行制造读侧 corrupt 态');
  assert.ok(init2.message.includes('toolchain'));
  assert.equal(existsSync(join(root2, '.algo')), false, '校验失败零残留');
});

test('⑧ baseline-register 成功追加且旧条目字节不变', () => {
  const root = makeRoot();
  initProject(root);
  applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
  const before = readFileSync(join(root, '.algo', 'baselines.json'), 'utf8');
  const r = applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 0.7 }, fromIteration: 'i1', reason: 'raise' });
  assert.ok(r.ok);
  const after = JSON.parse(readFileSync(join(root, '.algo', 'baselines.json'), 'utf8'));
  assert.equal(after.entries.length, 2);
  assert.equal(after.entries[0].id, 'b0');
  assert.equal(after.entries[1].id, 'b1');
  const beforeParsed = JSON.parse(before);
  assert.deepEqual(after.entries[0], beforeParsed.entries[0]);
});

test('⑨ fromIteration 悬空或缺失 → 失败（复审 F1：空值同拒——内部接口-22 §4）', () => {
  const root = makeRoot();
  initProject(root);
  const r = applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 0.7 }, fromIteration: 'no-such', reason: 'raise' });
  assert.equal(r.ok, false);
  const r2 = applyWrite(root, 'baseline-register', { id: 'b2', metrics: { m: 0.7 }, fromIteration: '', reason: 'x' });
  assert.equal(r2.ok, false);
  assert.ok(r2.message.includes('fromIteration'), '拒因钉到字段名');
});

test('⑩ badcase-add 必填缺失 → 失败；id 含路径分隔符拒绝；缺 badcases/ 目录给干净拒因（收尾审查修复）', () => {
  const root = makeRoot();
  initProject(root);
  const r = applyWrite(root, 'badcase-add', { id: 'c1', symptom: '', env: 'field', dataRefs: [] });
  assert.equal(r.ok, false);
  const r2 = applyWrite(root, 'badcase-add', { id: '../escape', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }] });
  assert.equal(r2.ok, false, 'id 含分隔符须拒（防越出 badcases/ 目录）');
  assert.ok(r2.message.includes('路径分隔符'));
  const root2 = mkdtempSync(join(tmpdir(), 'algo-noalgo-'));
  const r3 = applyWrite(root2, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }] });
  assert.equal(r3.ok, false, '未立项根给干净拒因（不抛未捕获栈）');
  assert.ok(r3.message.includes('project.json'), '未立项根先命中 project 门（写侧统一前门）');
});

test('⑪ transition 待归因→已修复验证（跳级）成功', () => {
  const root = makeRoot();
  initProject(root);
  applyWrite(root, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [{ kind: 'bag', ref: '/x' }] });
  const r = applyWrite(root, 'badcase-transition', { id: 'c1', status: '已修复验证' });
  assert.ok(r.ok);
  const body = JSON.parse(readFileSync(join(root, '.algo', 'badcases', 'c1.json'), 'utf8'));
  assert.equal(body.status, '已修复验证');
});

test('⑫ transition 闭环→已归因（回退）→ 失败；非法源状态 → 失败不洗净（复审 F3）', () => {
  const root = makeRoot();
  initProject(root);
  applyWrite(root, 'badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [] });
  applyWrite(root, 'badcase-transition', { id: 'c1', status: '闭环' });
  const r = applyWrite(root, 'badcase-transition', { id: 'c1', status: '已归因' });
  assert.equal(r.ok, false);
  applyWrite(root, 'badcase-add', { id: 'c2', symptom: 's', env: 'field', dataRefs: [] });
  writeFileSync(join(root, '.algo', 'badcases', 'c2.json'), JSON.stringify({ id: 'c2', at: '2026-10-01T00:00:00Z', symptom: 's', env: 'field', dataRefs: [], status: '已作废' }) + '\n');
  const r2 = applyWrite(root, 'badcase-transition', { id: 'c2', status: '待归因' });
  assert.equal(r2.ok, false);
  assert.ok(r2.message.includes('停下报修'), '损坏态迁移被拒且拒因钉分支文案');
});

test('⑬ 原子写：目标文件写后为完整 JSON（wx 临时+rename，不留 .tmp 残件）', () => {
  const root = makeRoot();
  initProject(root);
  applyWrite(root, 'ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' });
  applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 0.7 }, fromIteration: 'i1', reason: 'x' });
  const algo = join(root, '.algo');
  JSON.parse(readFileSync(join(algo, 'baselines.json'), 'utf8'));
  const leftovers = readdirSync(algo).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('⑭ 写侧失败 message 非空（可写 stderr）', () => {
  const root = makeRoot();
  const r = applyWrite(root, 'ledger-append', { id: 'x' });
  assert.equal(r.ok, false);
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
});

test('⑮ CLI 成功输出首行 ok <操作> <id> 稳定前缀（spawnSync 子进程不经 shell）；中文大载荷跨块解码完好（复审 F5）', () => {
  const root = makeRoot();
  initProject(root);
  const script = join(import.meta.dirname, '..', 'algo-write.mjs');
  const bigHypothesis = '假设：'.padEnd(4, '设') + '压测中文载荷跨六十四千字节读块边界'.repeat(4300); // >64KiB 多字节
  const run = spawnSync(process.execPath, [script, 'ledger-append', '--project-root', root], {
    encoding: 'utf8',
    input: JSON.stringify({ id: 'cli1', hypothesis: bigHypothesis, change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' }),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `stderr：${run.stderr}`);
  assert.ok(run.stdout.startsWith('ok ledger-append cli1\n'), `stdout 首行前缀不符：${run.stdout.split('\n')[0]}`);
  const round = JSON.parse(readFileSync(join(root, '.algo', 'ledger.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(round.hypothesis, bigHypothesis, '大载荷逐字节完好（分块解码不拆多字节字符）');
});

test('⑯ 未知子命令/--project-root 缺值 → 退 2（用法错误与校验失败分界，复审 F4 补守卫）', () => {
  const script = join(import.meta.dirname, '..', 'algo-write.mjs');
  const runUnknown = spawnSync(process.execPath, [script, 'no-such-sub'], { encoding: 'utf8', input: '{}' });
  assert.equal(runUnknown.status, 2);
  const runNoValue = spawnSync(process.execPath, [script, 'init', '--project-root'], { encoding: 'utf8', input: JSON.stringify({ projectId: 'x' }) });
  assert.equal(runNoValue.status, 2, '--project-root 缺值须退 2（不静默回落 cwd）');
  const runNoRoot = spawnSync(process.execPath, [script, 'badcase-transition'], { encoding: 'utf8', input: JSON.stringify({ id: 'c1', status: '闭环' }) });
  assert.equal(runNoRoot.status, 1); // 根下无 .algo → 状态失败退 1（非用法错误）
  // 内部任务-269：`=` 形态可用；未知旗标/根不存在 → 退 2（写侧不创建根）
  const root = mkdtempSync(join(tmpdir(), 'algo-cli-'));
  const runEq = spawnSync(process.execPath, [script, 'init', `--project-root=${root}`], { encoding: 'utf8', input: JSON.stringify({ projectId: 'x' }) });
  assert.equal(runEq.status, 0, `= 形态应可用：${runEq.stderr}`);
  const runUnknownFlag = spawnSync(process.execPath, [script, 'init', '--project-rooot', root], { encoding: 'utf8', input: JSON.stringify({ projectId: 'x' }) });
  assert.equal(runUnknownFlag.status, 2, '未知旗标须退 2（不静默回落 cwd）');
  const runLoopMissing = mkdtempSync(join(tmpdir(), 'algo-cli-'));
  const runMissingRoot = spawnSync(process.execPath, [script, 'init', '--project-root', join(runLoopMissing, 'no-such')], { encoding: 'utf8', input: JSON.stringify({ projectId: 'x' }) });
  assert.equal(runMissingRoot.status, 2, '根不存在须退 2（写侧不创建根）');
  rmSync(root, { recursive: true, force: true });
  rmSync(runLoopMissing, { recursive: true, force: true });
});

test('⑰ dogfood 全环：立项→三轮迭代（含单变量 false 声明）→bad case 全链→抬基线→check-consistency 收口（内部验收-9）', () => {
  const root = makeRoot();
  initProject(root);
  for (let round = 1; round <= 3; round += 1) {
    const r = applyWrite(root, 'ledger-append', {
      id: `i${round}`,
      hypothesis: `假设${round}`,
      change: `变更${round}`,
      singleVariable: { declared: round !== 2, note: round === 2 ? '第二轮同时动了脚本与参数——归因债如实声明' : '' },
      metricsRef: `runs/round${round}.json`,
      decision: round === 2 ? 'rollback' : 'continue',
    });
    assert.ok(r.ok, `第 ${round} 轮登记成功`);
  }
  applyWrite(root, 'badcase-add', { id: 'f1', symptom: '窄道停滞', env: 'field', dataRefs: [{ kind: 'bag', ref: '/data/f1.bag' }] });
  assert.ok(applyWrite(root, 'badcase-transition', { id: 'f1', status: '已归因' }).ok); // 跳级
  assert.ok(applyWrite(root, 'badcase-transition', { id: 'f1', status: '闭环' }).ok);
  assert.ok(applyWrite(root, 'baseline-register', { id: 'b1', metrics: { m: 0.72 }, fromIteration: 'i3', reason: '三轮后抬升' }).ok);
  const baselines = JSON.parse(readFileSync(join(root, '.algo', 'baselines.json'), 'utf8'));
  assert.equal(baselines.entries.length, 2, 'B0+b1 两条（抬高留痕）');
  const cons = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'check-consistency.mjs'), '--project-root', root], { encoding: 'utf8' });
  assert.equal(cons.status, 0, `全环收口 consistent：${cons.stdout}`);
});
