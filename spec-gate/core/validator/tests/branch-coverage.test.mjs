// 文件：spec-gate/core/validator/tests/branch-coverage.test.mjs
// 描述：内部任务-209 S2 达阈补测（内部未决-201，spec-gate-core branches 72→75）——以 in-process 调用
//       core 校验器/工具/验收器的导出面，覆盖 usage/配置错误/资产损坏/降级/脱敏等分支。
//       注：本文件为**新增** core 测试文件（不改既有 core 文件；core-baseline 头注「新增文件（非基线改动）」
//       先例，内部决策-064 修正案 5 与计划 R7 记录）。
// 作者：wangp 创建：2026-10-25 版权：MIT（见 spec-gate/LICENSE）
// 自检：node --test --test-concurrency=1 "spec-gate/core/validator/tests/branch-coverage.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main as validatorMain, selfcheck, suiteModeChecks, buildReport, validateDocument } from '../validate_specs.mjs';
import { ConfigError } from '../core/pycompat.mjs';
import { checkMarkdownStructure, fenceRanges } from '../core/markdown.mjs';
import { checkTraceability } from '../core/traceability.mjs';
import { ALL_ACS, main as acceptanceMain, checkPlugStructure, runCase } from '../run_acceptance.mjs';
import { main as sddInitMain } from '../tools/sdd_init.mjs';
import { SOURCE_EXTENSIONS, checkBoundaries } from '../core/boundaries.mjs';
import { main as sddCheckMain, checkSuite, checkLedger } from '../tools/sdd_check.mjs';
import { main as captureMain, evidenceExitCode, redactText, summarize } from '../tools/capture_evidence.mjs';

/** 静默 stdout/stderr 的入口调用。 */
function silently(fn) {
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = fn();
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
}

test('validate_specs.main：help/未知模式/plan 缺参/缺 config/坏 config 分支', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-core-'));
  try {
    assert.equal(silently(() => validatorMain(['--help'])).code, 0);
    assert.equal(silently(() => validatorMain(['--selfcheck'])).code, 0, 'selfcheck 分支退 0');
    assert.equal(silently(() => validatorMain(['--mode', 'bogus'])).code, 2);
    assert.equal(silently(() => validatorMain(['--mode', 'plan'])).code, 2, 'plan 缺 --plan 退 2');
    assert.equal(silently(() => validatorMain([])).code, 2, '缺 --config 退 2');
    const missing = join(home, 'no-such.json');
    assert.equal(silently(() => validatorMain(['--config', missing])).code, 2, 'config 不存在退 2');
    const badJson = join(home, 'bad.json');
    writeFileSync(badJson, '{bad', 'utf8');
    assert.equal(silently(() => validatorMain(['--config', badJson])).code, 2, '坏 JSON 退 2');
    const badShape = join(home, 'shape.json');
    writeFileSync(badShape, JSON.stringify({ suiteRoot: 42, documents: [] }), 'utf8');
    assert.throws(() => validatorMain(['--config', badShape]), /suiteRoot 须为字符串/, 'suiteRoot 非字符串抛配置错误');
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});

test('run_acceptance.main/runCase：help/未知 case/不存在 root/单项执行分支', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-core-'));
  try {
    assert.equal(silently(() => acceptanceMain(['--help'])).code, 0);
    assert.equal(silently(() => acceptanceMain(['--suite-root', join(home, 'nope')])).code, 2, 'suite-root 不存在退 2');
    assert.equal(silently(() => acceptanceMain(['--suite-root', process.cwd(), '--case', 'NO-SUCH-AC'])).code, 2, '未知验收项退 2');
    assert.ok(Array.isArray(ALL_ACS) && ALL_ACS.length > 0, 'ALL_ACS 应非空');
    const one = runCase(ALL_ACS[0]);
    assert.equal(typeof one.status, 'string', 'runCase 返回 status');
    assert.equal(one.acceptanceId, ALL_ACS[0]);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});

test('sdd_check.main/checkSuite/checkLedger：help/未接入/坏 JSON/非法 boundaries/坏 suite+ledger', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-core-'));
  try {
    assert.equal(silently(() => sddCheckMain(['--help'])).code, 0);
    assert.equal(silently(() => sddCheckMain([])).code, 2, '缺 --project 退 2');
    assert.equal(silently(() => sddCheckMain(['--project', join(home, 'nope')])).code, 2, '未接入退 2');
    const project = join(home, 'proj');
    mkdirSync(join(project, '.sdd'), { recursive: true });
    writeFileSync(join(project, '.sdd', 'project.json'), '{bad', 'utf8');
    assert.equal(silently(() => sddCheckMain(['--project', project])).code, 2, 'project.json 坏 JSON 退 2');
    writeFileSync(join(project, '.sdd', 'project.json'), '[]', 'utf8');
    assert.equal(silently(() => sddCheckMain(['--project', project])).code, 2, 'project.json 非对象退 2');
    writeFileSync(join(project, '.sdd', 'project.json'), JSON.stringify({ boundaries: [{ id: 'B', scope: 'x' }] }), 'utf8');
    assert.equal(silently(() => sddCheckMain(['--project', project])).code, 2, '非法 boundaries 退 2');
    writeFileSync(join(project, '.sdd', 'project.json'), JSON.stringify({ boundaries: [] }), 'utf8');
    // 业务分支：坏 suite / 坏 ledger 各自抛错或产出诊断（不静默跳过）
    assert.throws(() => checkSuite(project, '内部治理状态'), /suite 配置不存在/, 'suite 缺失应显式报错');
    writeFileSync(join(project, '.sdd', 'suite.json'), '{bad', 'utf8');
    let badSuite = null;
    try { badSuite = checkSuite(project, '内部治理状态'); } catch (error) { badSuite = [{ message: String(error.message) }]; }
    assert.ok(Array.isArray(badSuite) && badSuite.length > 0, '坏 suite JSON 应可见（抛错或诊断）');
    let ledgerDiag = null;
    try { ledgerDiag = checkLedger(project, '内部治理状态', new Date().toISOString()); } catch (error) { ledgerDiag = [{ message: String(error.message) }]; }
    assert.ok(Array.isArray(ledgerDiag) && ledgerDiag.length > 0, 'ledger 缺失/坏件应可见');
    writeFileSync(join(project, '.sdd', 'ledger.json'), JSON.stringify({ tasks: 'bad' }), 'utf8');
    let badLedger = null;
    try { badLedger = checkLedger(project, '内部治理状态', new Date().toISOString()); } catch (error) { badLedger = [{ message: String(error.message) }]; }
    assert.ok(Array.isArray(badLedger) && badLedger.length > 0, '坏 ledger 形状应可见');
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});

test('capture_evidence.main/redactText/summarize：help/缺参/不存在目录/脱敏与截断/成功包装命令', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev209-core-'));
  try {
    assert.equal(silently(() => captureMain(['--help'])).code, 0);
    assert.equal(silently(() => captureMain([])).code, 2, '缺 --project 退 2');
    assert.equal(silently(() => captureMain(['--project', home])).code, 2, '缺 --criteria 退 2');
    assert.equal(silently(() => captureMain(['--project', home, '--criteria', 'x'])).code, 2, '缺被包装命令退 2');
    assert.equal(silently(() => captureMain(['--project', join(home, 'nope'), '--criteria', 'x', '--', 'node', '-e', '0'])).code, 2, '项目目录不存在退 2');
    assert.match(redactText('token=abc api_key=def password:ghi'), /\[redacted\]/);
    assert.match(redactText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), /\[redacted\]/);
    assert.equal(summarize('', 3), '', '空输出 summarize 为空串');
    assert.equal(redactText('no secret here'), 'no secret here');
    const summary = summarize('l1\nl2\nl3\nl4', 2);
    assert.match(summary, /l1\|\|l2|两行|截断|omitted|truncated/i);
    // 成功包装命令（含敏感旗标 → 脱敏）
    const ok = silently(() => captureMain(['--project', home, '--criteria', 'x', '--', process.execPath, '-e', 'console.log("ok")']));
    assert.equal(ok.code, 0, `包装命令成功应透传 0：${ok.err}`);
    assert.ok(ok.out.includes('ok'), '证据 stdout 应含被包装命令输出');
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});

test('内部任务-242 C01/C08＋安全复审 S-3/S-4：别名/组合短旗标/criteria 脱敏＋信号退出码映射', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev242-c01-'));
  const out = join(home, 'evidence.jsonl');
  try {
    const r = silently(() => captureMain([
      '--project', home, '--criteria', 'password=criteriaSecret', '--append', out, '--',
      process.execPath, '-e', 'console.log("ok")', '--',
      '-P', 'myPass', '--password', 'topSecret',
      '--secret-key', 'secret6', '--credentials', 'secret8', '--pwd', 'secret10', '--bearer', 'secret11',
      '-vpsecret5',
      '--api-key', 'keySecret1', '--access-key', 'keySecret2', '--private-key', 'keySecret3',
      '--api_key', 'keySecret4', '--apikey', 'keySecret5',
      '--api-key', '-secret18', '--token', '-abc19', '--password', '--hunter2',
    ]));
    assert.equal(r.code, 0, `证据工具成功收口：${r.err}`);
    const line = readFileSync(out, 'utf8').trim().split('\n').pop();
    const rec = JSON.parse(line);
    for (const secret of ['myPass', 'topSecret', 'secret6', 'secret8', 'secret10', 'secret11', 'secret5', 'criteriaSecret',
      'keySecret1', 'keySecret2', 'keySecret3', 'keySecret4', 'keySecret5', '-secret18', '-abc19', '--hunter2']) {
      assert.ok(!rec.command.includes(secret) && !rec.selectionCriteria.includes(secret), `秘密 ${secret} 不得落盘（S-3/S-4）`);
    }
    assert.match(rec.command, /\[redacted\]/, '脱敏标记须落盘');
    assert.match(rec.selectionCriteria, /\[redacted\]/, 'criteria 含秘密须脱敏（S-4）');
    // C08 信号→Python 负 returncode 映射（跨平台以纯函数断言，避免平台 signal 呈现差异）
    assert.equal(evidenceExitCode({ status: 0 }), 0);
    assert.equal(evidenceExitCode({ status: 7 }), 7);
    assert.equal(evidenceExitCode({ status: null, signal: 'SIGTERM' }), -15, '信号终止记负信号号');
    assert.equal(evidenceExitCode({ status: null, signal: null }), 1, '无状态无信号兜底 1');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-242 C05/C06/C07/C10：分隔行列数/行切分同源/围栏 A 行/expandRefs 压缩形态', () => {
  // C05：分隔行列数与表头不一致 → blocking（旧实现只查数据行）
  const badSep = checkMarkdownStructure('x.md', '|a|b|\n|---|\n|1|2|\n');
  assert.ok(badSep.some((d) => d.severity === 'blocking' && d.fixHint.includes('分隔行')), `分隔行列数须报：${JSON.stringify(badSep)}`);
  // C05 反例：HTML 表不检测（无 pan 起首管道）
  const html = checkMarkdownStructure('h.md', '<table><tr><td>a</td></tr></table>\n');
  assert.deepEqual(html, [], 'HTML 表不产生诊断');
  // C06：fenceRanges 与 pySplitLines 同源（\v 断行不使围栏区间错位）
  const ranges = fenceRanges('```\nA\vB\n```\nX\n');
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].end, 4, `\\v 断行后围栏闭合行号应为 4：${JSON.stringify(ranges)}`);
  // C07 + C10：expandRefs 斜杠多段/范围展开；围栏内 A 行不得冒充追溯
  const docText = [
    '## 2 需求', '', '| 编号 | 描述 |', '|---|---|',
    '| 内部规则-1 | a |', '| 内部规则-2 | b |', '| 内部规则-3 | c |', '| 内部规则-9 | d |', '',
    '## 6 验收表', '', '| 编号 | 行为 | 锁定方式 |', '|---|---|---|',
    '| 内部验收-1 | 压缩斜杠 | 内部规则-1/2/3 |',
    '| 内部验收-2 | 范围 | 内部规则-2至3 |', '',
    '~~~text', '| 内部验收-9 | 围栏示例 | 内部规则-9 |', '~~~', '',
  ].join('\n');
  const diags = checkTraceability('m.md', docText, 0, { documentType: 'module-volume' });
  const lackA = diags.filter((d) => d.severity === 'warning' && d.fixHint.includes('尚无 A 行追溯'));
  assert.equal(lackA.length, 1, `仅 内部规则-9 缺 A（围栏 A 行不得冒充）：${JSON.stringify(lackA)}`);
  assert.ok(lackA[0].fixHint.includes('内部规则-9'), '缺口须为 内部规则-9（内部规则-1/2/3 被压缩展开覆盖）');
});

test('内部任务-242 C09：非 ZCode 布局按 plugin.manifest.json 回退定位并通过结构校验', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev242-c09-'));
  const pluginDir = join(root, 'my-plugin');
  const old = process.env.SDD_AC_PLUG_ROOT;
  try {
    for (const skill of ['sdd-ddd-tdd', 'spec-backfill', 'spec-writing', 'gate']) {
      mkdirSync(join(pluginDir, 'skills', skill), { recursive: true });
      writeFileSync(join(pluginDir, 'skills', skill, 'SKILL.md'), '# skill\n', 'utf8');
    }
    writeFileSync(join(pluginDir, 'plugin.manifest.json'), JSON.stringify({ name: 'my-plugin' }), 'utf8');
    process.env.SDD_AC_PLUG_ROOT = pluginDir;
    const r = checkPlugStructure();
    assert.equal(r.status, 'passed', `非 ZCode 布局须回退通过：${JSON.stringify(r.evidence)}`);
    assert.ok(r.evidence[0].includes('回退'), '证据须标明宿主中立回退');
    // S-8（内部任务-242 安全复审）：name 缺失/非字符串/非法字符不得静默放行
    for (const bad of [{ name: 123 }, {}, { name: '../evil' }]) {
      writeFileSync(join(pluginDir, 'plugin.manifest.json'), JSON.stringify(bad), 'utf8');
      const rr = checkPlugStructure();
      assert.equal(rr.status, 'failed', `name=${JSON.stringify(bad.name)} 须判失败`);
      assert.ok(rr.evidence.some((e) => e.includes('name')), '失败证据须点名 name');
    }
  } finally {
    if (old === undefined) delete process.env.SDD_AC_PLUG_ROOT; else process.env.SDD_AC_PLUG_ROOT = old;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-242 内部未决-204：sdd_init --dry-run 零写盘＋未知旗标退 2', () => {
  const project = mkdtempSync(join(tmpdir(), 'dev242-204-'));
  try {
    const dry = silently(() => sddInitMain(['--project', project, '--dry-run']));
    assert.equal(dry.code, 0, `dry-run 应成功：${dry.err}`);
    assert.equal(existsSync(join(project, '.sdd')), false, 'dry-run 不得创建 .sdd/');
    const bad = silently(() => sddInitMain(['--project', project, '--nope']));
    assert.equal(bad.code, 2, '未知旗标 fail-loud 退 2');
    const real = silently(() => sddInitMain(['--project', project]));
    assert.equal(real.code, 0, `实跑初始化应成功：${real.err}`);
    assert.equal(existsSync(join(project, '.sdd', 'project.json')), true, '实跑创建配置');
  } finally {
    rmSync(project, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-242 C04/E03：校验器工具错误/未知退出码→ConfigError（不退 1 内容诊断）', () => {
  const project = mkdtempSync(join(tmpdir(), 'dev242-c04-'));
  const old = process.env.SDD_CHECK_VALIDATOR;
  try {
    mkdirSync(join(project, '.sdd'), { recursive: true });
    writeFileSync(join(project, 'x.md'), '# x\n', 'utf8');
    writeFileSync(join(project, '.sdd', 'suite.json'), JSON.stringify({ documents: [{ path: 'x.md' }] }), 'utf8');
    const stub = join(project, 'stub-validator.mjs');
    writeFileSync(stub, 'process.exit(3);\n', 'utf8');
    process.env.SDD_CHECK_VALIDATOR = stub;
    assert.throws(() => checkSuite(project, '内部治理状态'), ConfigError, '未知退出码 3 属工具错误');
    writeFileSync(stub, "process.stdout.write(JSON.stringify({error:'boom'})); process.exit(2);\n", 'utf8');
    assert.throws(() => checkSuite(project, '内部治理状态'), ConfigError, 'status=2 属工具错误');
    writeFileSync(stub, 'process.exit(1);\n', 'utf8');
    assert.throws(() => checkSuite(project, '内部治理状态'), /输出不可解析/, 'S-7：status=1 无输出属工具/协议故障');
    writeFileSync(stub, "process.stdout.write(JSON.stringify({diagnostics:[]}));\n", 'utf8');
    assert.throws(() => checkSuite(project, '内部治理状态'), /报告形态非法/, 'S-7：缺 blockingCount 属工具/协议故障');
    writeFileSync(stub, "process.stdout.write(JSON.stringify({diagnostics:[],blockingCount:0}));\n", 'utf8');
    assert.deepEqual(checkSuite(project, '内部治理状态'), [], '正常报告返回诊断数组');
  } finally {
    if (old === undefined) delete process.env.SDD_CHECK_VALIDATOR; else process.env.SDD_CHECK_VALIDATOR = old;
    rmSync(project, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-242 C03：边界扫描收录 .mjs/.cjs 源文件', () => {
  assert.ok(SOURCE_EXTENSIONS.has('.mjs'), '.mjs 属源文件');
  assert.ok(SOURCE_EXTENSIONS.has('.cjs'), '.cjs 属源文件');
  const root = mkdtempSync(join(tmpdir(), 'dev242-c03-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.mjs'), "import x from '../tests/x.mjs';\n", 'utf8');
    const diags = checkBoundaries(root, [{
      id: 'B1', scope: 'src', deny: ['tests'], allow: [], severity: 'blocking', rationale: '测试代码不得被生产代码反向依赖',
    }]);
    assert.ok(diags.some((d) => d.ruleId === 'RULE-BOUND-001' && d.severity === 'blocking'), `mjs 文件须被扫描并命中：${JSON.stringify(diags)}`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-242 C02：受检文件缺失→RULE-PACK-002；非 UTF-8→RULE-PACK-002；目录→ConfigError（工具错误）', () => {  const root = mkdtempSync(join(tmpdir(), 'dev242-c02-'));
  try {
    const missing = validateDocument(root, { path: 'nope.md' }, 'draft', []);
    assert.ok(missing.some((d) => d.ruleId === 'RULE-PACK-002' && d.severity === 'blocking'), '缺失文件按内容诊断');
    writeFileSync(join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0x00]));
    const bad = validateDocument(root, { path: 'bad.md' }, 'draft', []);
    assert.ok(bad.some((d) => d.ruleId === 'RULE-PACK-002'), '非 UTF-8 内容诊断');
    mkdirSync(join(root, 'dir.md'));
    assert.throws(() => validateDocument(root, { path: 'dir.md' }, 'draft', []), ConfigError, '目录形态属工具错误');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('内部任务-347 内部未决-152⑤：噪音词在行内代码中不计（RULE-SPEC-004 误报方向收口）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev347-o152e-'));
  try {
    // 正文裸写命中；行内代码与围栏内不命中
    writeFileSync(join(root, 'doc.md'), '# 文档\n\n正文提及 stub 实现占位。\n\n行内代码 `use stub here` 说明。\n\n```text\nstub in fence\n```\n');
    const diags = validateDocument(root, { path: 'doc.md' }, 'release', ['stub']);
    const noise = diags.filter((d) => d.ruleId === 'RULE-SPEC-004');
    assert.equal(noise.length, 1, `恰正文裸写一条（行内代码与围栏不计），实际 ${JSON.stringify(noise)}`);
    assert.equal(noise[0].line, 3, '行号锚正文行');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('validate_specs selfcheck：真仓核心资产自检无 blocking 诊断', () => {
  const diags = selfcheck();
  assert.ok(Array.isArray(diags), 'selfcheck 返回诊断数组');
  assert.ok(!diags.some((d) => d.severity === 'blocking'), `selfcheck 不得有 blocking：${JSON.stringify(diags.slice(0, 3))}`);
});

test('buildReport/suiteModeChecks/parseArgs 边界分支（CR-12 余量补测）', () => {
  // buildReport：blocking/warning 计数分支
  const diags = [
    { ruleId: 'R1', severity: 'blocking', file: 'a.md', line: 1, fixHint: 'x' },
    { ruleId: 'R2', severity: 'warning', file: 'b.md', line: 2, fixHint: 'y' },
    { ruleId: 'R3', severity: 'warning', file: 'c.md', line: 3, fixHint: 'z' },
  ];
  const report = buildReport('suite', diags, 3);
  assert.equal(report.blockingCount, 1);
  assert.equal(report.warningCount, 2);
  assert.equal(report.filesChecked, 3);
  assert.equal(buildReport('draft', [], 0).blockingCount, 0);
  // suiteModeChecks：manifest 缺键/不存在/坏 JSON/allowedPublicAssets 坏形态/SKILL.md 共存
  const suiteRoot = mkdtempSync(join(tmpdir(), 'dev209-core-suite-'));
  try {
    assert.throws(() => suiteModeChecks({}, suiteRoot), ConfigError, 'manifest 缺失须抛 ConfigError');
    assert.throws(() => suiteModeChecks({ manifest: 'nope.json' }, suiteRoot), ConfigError, 'manifest 不存在须抛 ConfigError');
    writeFileSync(join(suiteRoot, 'manifest.json'), '{bad', 'utf8');
    const badJson = suiteModeChecks({ manifest: 'manifest.json' }, suiteRoot);
    assert.ok(badJson.some((d) => d.ruleId === 'RULE-CORE-002' && d.severity === 'blocking'), '坏 JSON manifest 须产 blocking 诊断');
    writeFileSync(join(suiteRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [] }), 'utf8');
    assert.throws(() => suiteModeChecks({ manifest: 'manifest.json', allowedPublicAssets: 'x' }, suiteRoot), ConfigError, 'allowedPublicAssets 非数组须抛');
    assert.throws(() => suiteModeChecks({ manifest: 'manifest.json', allowedPublicAssets: [1] }, suiteRoot), ConfigError, 'allowedPublicAssets 条目非字符串须抛');
    writeFileSync(join(suiteRoot, 'SKILL.md'), '# x', 'utf8');
    const withSkill = suiteModeChecks({ manifest: 'manifest.json' }, suiteRoot);
    assert.ok(withSkill.some((d) => d.ruleId === 'RULE-CORE-003'), '共享内核含 SKILL.md 须产诊断');
  } finally { rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 3 }); }
  // parseArgs 分支：未知参数 / 缺值 / 非法 format / --key=value 形态
  assert.throws(() => validatorMain(['--bogus']), /unrecognized arguments/);
  assert.throws(() => validatorMain(['--config']), /expected one argument/);
  assert.throws(() => validatorMain(['--format', 'xml']), /invalid choice/);
  assert.equal(silently(() => validatorMain(['--mode=plan', '--plan=/nonexistent-plan-xyz.md', '--config=内部治理状态'])).code, 2, '不存在计划须退 2');
});
