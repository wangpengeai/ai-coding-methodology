// AC-VAL-001 / RULE-PATH-003：validate_specs.mjs CLI 契约（模式、格式、退出码、F-8/F-18/F-20）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';
import { selfcheck } from '../validate_specs.mjs';

const VALIDATOR = join(CORE_ROOT, 'validator/validate_specs.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-cli-')));

function runCli(args, cwd = CORE_ROOT) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd, encoding: 'utf8', timeout: 120000 });
}
function writeSuite(dir, documents, modeMap = {}, extra = {}) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const entries = [];
  for (const [name, content, type] of documents) {
    writeFileSync(join(dir, 'docs', name), content);
    entries.push({ path: `docs/${name}`, documentType: type, validationMode: modeMap[name] ?? 'baseline' });
  }
  const config = {
    schemaVersion: '1.0.0', suiteRoot: dir, validationRoots: ['docs'], documents: entries,
    manifest: join(CORE_ROOT, 'manifest.json'), allowedPublicAssets: [],
    ...extra,
  };
  const path = join(dir, 'sdd_suite.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

test('干净 baseline 退 0；自由 TODO 退 1；draft OPEN-n 放行；模板声明占位符放行', () => {
  const dir = tmp();
  const clean = writeSuite(dir, [['clean.md', '# 干净\n\n无占位符。\n', 'note']]);
  let r = runCli(['--config', clean, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagnostics, []);

  const dir2 = tmp();
  const todo = writeSuite(dir2, [['todo.md', '# 草案\n\nTODO: 以后补。\n', 'note']]);
  r = runCli(['--config', todo, '--mode', 'baseline']);
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stdout).diagnostics.some((d) => d.ruleId === 'RULE-OPEN-001'));

  const dir3 = tmp();
  const draft = writeSuite(dir3, [['draft.md', '# 草案\n\nTODO: 以后补。\n\n- OPEN-1 状态 open：未决事项已登记。\n', 'note']], { 'draft.md': 'draft' });
  r = runCli(['--config', draft, '--mode', 'draft']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const dir4 = tmp();
  const tpl = writeSuite(dir4, [['tpl.md', '---\nallowedPlaceholders: {{TITLE}}\n---\n# {{TITLE}}\n', 'template']], { 'tpl.md': 'template' });
  r = runCli(['--config', tpl, '--mode', 'template']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('未知模式/缺配置/坏 JSON/模式冲突退 2；text 格式含 fixHint', () => {
  const dir = tmp();
  const good = writeSuite(dir, [['a.md', '# x\n', 'note']]);
  assert.equal(runCli(['--config', good, '--mode', 'bogus']).status, 2);
  assert.equal(runCli(['--config', join(dir, 'nope.json'), '--mode', 'baseline']).status, 2);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(runCli(['--config', bad, '--mode', 'baseline']).status, 2);
  const conflict = writeSuite(dir, [['d.md', '# x\n', 'note']], { 'd.md': 'draft' });
  assert.equal(runCli(['--config', conflict, '--mode', 'baseline']).status, 2);
  const todo = writeSuite(dir, [['todo.md', 'TODO: x\n', 'note']]);
  const r = runCli(['--config', todo, '--mode', 'baseline', '--format', 'text']);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('RULE-OPEN-001') && r.stdout.includes('fixHint'));
});

test('诊断字段齐全；F-8 行号为文件真实行号', () => {
  const dir = tmp();
  const config = writeSuite(dir, [['todo.md', '---\ntitle: x\n---\n# 文档\n\nTODO: x\n', 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  const report = JSON.parse(r.stdout);
  const d = report.diagnostics[0];
  for (const f of ['ruleId', 'severity', 'file', 'line', 'fixHint']) assert.ok(f in d);
  assert.equal(d.severity, 'blocking');
  assert.equal(d.line, 6);
});

test('selfcheck CLI 退 0；F-18 selfcheck({coreRoot}) 对注入坏占位符转红', () => {
  let r = runCli(['--selfcheck']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagnostics, []);
  const dir = tmp();
  cpSync(join(CORE_ROOT, 'templates'), join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'templates/atomic/glossary.template.md'),
    `${readFileSync(join(dir, 'templates/atomic/glossary.template.md'), 'utf8')}\n注入坏占位符：{{NOT_DECLARED_PLACEHOLDER}}\n`);
  const ds = selfcheck(dir);
  assert.ok(ds.some((d) => d.ruleId === 'RULE-SPEC-002'));
});

test('F-19：--help 退 0 且含 --root 保留说明；F-20：未知长选项拒绝', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--root') && help.stdout.includes('保留'));
  assert.equal(runCli(['--conf', 'x']).status, 2);
  assert.equal(runCli(['--bogus']).status, 2);
  const dir = tmp();
  const plan = join(dir, 'plan.md');
  writeFileSync(plan, '---\nspecRefs: [FR-sg-1]\n---\n# 计划\n\n## 步骤 1\n\n验收：x\n');
  const r = runCli(['--mode', 'plan', '--plan', plan]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.skipped, true);
  assert.equal(report.mode, 'plan');
  // 有 .sdd 体系却漏传 --config：工具错误退 2（F-20 的 skipped 仅限无体系）
  const sddProject = tmp();
  mkdirSync(join(sddProject, '.sdd'));
  writeFileSync(join(sddProject, 'plan.md'), '---\nspecRefs: [FR-sg-1]\n---\n# 计划\n\n## 步骤 1\n\n验收：x\n');
  const missingConfig = runCli(['--mode', 'plan', '--plan', join(sddProject, 'plan.md')]);
  assert.equal(missingConfig.status, 2);
  assert.ok(missingConfig.stdout.includes('缺少 --config'));
});

test('CLI 主模块判定：经文件符号链接调用仍真正执行（不得静默退 0）', () => {
  const dir = tmp();
  const link = join(dir, 'validator-link.mjs');
  symlinkSync(VALIDATOR, link);
  const r = spawnSync(process.execPath, [link, '--selfcheck'], { cwd: CORE_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('"diagnostics"'));
});

test('受检路径非字符串/为目录属工具错误退 2（不降级为内容阻断）', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const badPath = join(dir, 'bad-path.json');
  writeFileSync(badPath, JSON.stringify({ suiteRoot: dir, documents: [{ path: 5 }], manifest: join(CORE_ROOT, 'manifest.json') }));
  let r = runCli(['--config', badPath, '--mode', 'baseline']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('path 须为非空字符串'));

  mkdirSync(join(dir, 'docs/a-dir'));
  const dirPath = join(dir, 'dir-path.json');
  writeFileSync(dirPath, JSON.stringify({ suiteRoot: dir, documents: [{ path: 'docs/a-dir' }], manifest: join(CORE_ROOT, 'manifest.json') }));
  r = runCli(['--config', dirPath, '--mode', 'baseline']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('不是文件'));
});

test('F-9：仅行首「第二部分」标题降级，正文同串不降级', () => {
  const dir = tmp();
  const config = writeSuite(dir, [
    ['prose.md', '# 散文\n\n正文提到第二部分，但这不是注记层标题。\n\nwidget 细节。\n', 'note'],
    ['note.md', '# 注记\n\n## 第二部分\n\nwidget 细节。\n', 'note'],
  ], {}, { implementationNoiseTerms: ['widget'] });
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const ds = JSON.parse(r.stdout).diagnostics.filter((d) => d.ruleId === 'RULE-SPEC-004');
  assert.deepEqual(ds.map((d) => d.file).sort(), ['docs/prose.md']);
});

test('F-12：~~~ 与四反引号嵌套围栏内的内容不参与检查', () => {
  const dir = tmp();
  const doc = '# 文档\n\n~~~text\nTODO: tilde 内不报\n~~~\n\n````markdown\n```\nTODO: 嵌套内不报\n```\n````\n\n正文。\n';
  const config = writeSuite(dir, [['fence.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).diagnostics.some((d) => d.ruleId === 'RULE-OPEN-001'), false);
});

test('F-13：小写占位符纳入扫描；implementationNoiseTerms 非数组退 2', () => {
  const dir = tmp();
  const config = writeSuite(dir, [['lower.md', '# 文档\n\n{{lower_placeholder}}\n', 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).diagnostics.some((d) => d.ruleId === 'RULE-SPEC-002'));

  const badDir = tmp();
  const bad = writeSuite(badDir, [['ok.md', '# 文档\n', 'note']], {}, { implementationNoiseTerms: 'widget' });
  const rb = runCli(['--config', bad, '--mode', 'baseline']);
  assert.equal(rb.status, 2, rb.stdout + rb.stderr);
  assert.ok(rb.stdout.includes('implementationNoiseTerms 须为字符串数组'));
});

test('F-11/F-13：null 配置值不得被 ?? [] 静默归一', () => {
  for (const extra of [
    { implementationNoiseTerms: null },
    { allowedPublicAssets: null },
    { documents: null },
    { suiteRoot: null },
  ]) {
    const dir = tmp();
    const config = writeSuite(dir, [['ok.md', '# 文档\n', 'note']], {}, extra);
    const r = runCli(['--config', config, '--mode', 'baseline']);
    assert.equal(r.status, 2, `${JSON.stringify(extra)} 应退 2（实得 ${r.status}）`);
  }
});

test('CHG-19 缺陷A：占位符扫描排除代码语境（行内代码/顶层围栏/缩进围栏），正文裸写仍报；template 保持全文扫描', () => {
  const dir = tmp();
  const doc = '# 文档\n'
    + '\n'
    + '生成器记法见 `{{name}}` 与 `{{generated_date}}` 两处行内引用。\n'
    + '\n'
    + '```text {{info_placeholder}}\n'
    + 'name: {{name}}\n'
    + 'env_prefix: {{env_prefix}}\n'
    + '```\n'
    + '\n'
    + '- 物料模板示例：\n'
    + '\n'
    + '    ```yaml\n'
    + '    artifact: {{name}}\n'
    + '    ```\n'
    + '\n'
    + '正文裸写 {{real_placeholder}} 仍须拦截。\n'
    + '游离反引号 ` 后裸写 {{stray_placeholder}} 仍须拦截。\n';
  const config = writeSuite(dir, [['ctx.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const ds = JSON.parse(r.stdout).diagnostics.filter((d) => d.ruleId === 'RULE-SPEC-002');
  assert.deepEqual(ds.map((d) => d.line), [16, 17]);

  const dir2 = tmp();
  const config2 = writeSuite(dir2, [['upper.md', '# 文档\n\n密钥从 {{API_KEY}} 注入。\n', 'note']]);
  const r2 = runCli(['--config', config2, '--mode', 'baseline']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.ok(JSON.parse(r2.stdout).diagnostics.some((d) => d.ruleId === 'RULE-SPEC-002'));

  // template 模式保持全文扫描（占位符即模板内容）：围栏内未声明占位符仍报
  const dir3 = tmp();
  const doc3 = '---\nallowedPlaceholders: {{TITLE}}\n---\n# {{TITLE}}\n\n```text\n{{UNDECLARED}}\n```\n';
  const config3 = writeSuite(dir3, [['tpl-ctx.md', doc3, 'note']], { 'tpl-ctx.md': 'template' });
  const r3 = runCli(['--config', config3, '--mode', 'template']);
  assert.equal(r3.status, 1, r3.stdout + r3.stderr);
  assert.ok(JSON.parse(r3.stdout).diagnostics.some((d) => d.ruleId === 'RULE-SPEC-002' && d.line === 7));
  // 同一行内 span 与 span 外裸写并存：只报 span 外的
  const dir4 = tmp();
  const config4 = writeSuite(dir4, [['mixed.md', '# 文档\n\n见 `{{in_code}}` 与 {{bare_outside}}。\n', 'note']]);
  const r4 = runCli(['--config', config4, '--mode', 'baseline']);
  assert.equal(r4.status, 1, r4.stdout + r4.stderr);
  const ds4 = JSON.parse(r4.stdout).diagnostics.filter((d) => d.ruleId === 'RULE-SPEC-002');
  assert.deepEqual(ds4.map((d) => d.line), [3]);
  assert.ok(ds4[0].fixHint.includes('{{bare_outside}}'), ds4[0].fixHint);
  assert.equal(ds4[0].fixHint.includes('{{in_code}}'), false, ds4[0].fixHint);
});

test('CHG-19 缺陷B：列表项缩进围栏被识别——管线续行不触发 RULE-PACK-002；真表格缺分隔行仍报', () => {
  const dir = tmp();
  const doc = '# 文档\n'
    + '\n'
    + '- 清理日志：\n'
    + '\n'
    + '    ```bash\n'
    + '    find . -name "*.log" \\\n'
    + '      | xargs grep -l ERROR\n'
    + '    ```\n';
  const config = writeSuite(dir, [['indent.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).blockingCount, 0);

  const dir2 = tmp();
  const config2 = writeSuite(dir2, [['table.md', '# 文档\n\n| 列A | 列B |\n| 值1 | 值2 |\n', 'note']]);
  const r2 = runCli(['--config', config2, '--mode', 'baseline']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.ok(JSON.parse(r2.stdout).diagnostics.some((d) => d.ruleId === 'RULE-PACK-002'));
});

test('CHG-19：inlineCodeSpans 同长配对语义（多反引号/异长 run/未配对）', async () => {
  const { inlineCodeSpans } = await import('../core/markdown.mjs');
  assert.deepEqual(inlineCodeSpans('a `x` b'), [[2, 5]]);
  assert.deepEqual(inlineCodeSpans('``a`b`` c'), [[0, 7]]);
  assert.deepEqual(inlineCodeSpans('a `b'), []);
  assert.deepEqual(inlineCodeSpans('x `` y ` z'), []);
  // 前导未配对 run 不阻断后续同长配对；span 内的异长 run 被吞为代码内容
  assert.deepEqual(inlineCodeSpans('x ` y ``{{p}}`` z'), [[6, 15]]);
  assert.deepEqual(inlineCodeSpans('`` ` `` `'), [[0, 7]]);
});

test('表格列数不一致 → RULE-PACK-002（OPEN-120 守卫）', () => {
  const dir = tmp();
  const doc = '# 文档\n\n| 列A | 列B | 列C |\n|---|---|---|\n| 值1 | 值2 |\n';
  const config = writeSuite(dir, [['bad-table.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const ds = JSON.parse(r.stdout).diagnostics.filter((d) => d.ruleId === 'RULE-PACK-002');
  assert.ok(ds.some((d) => d.fixHint.includes('表格列数不一致')), JSON.stringify(ds));
});

test('表格列数一致 → 通过', () => {
  const dir = tmp();
  const doc = '# 文档\n\n| 列A | 列B | 列C |\n|---|---|---|\n| 值1 | 值2 | 值3 |\n';
  const config = writeSuite(dir, [['ok-table.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('围栏内表格不检查', () => {
  const dir = tmp();
  const doc = '# 文档\n\n```text\n| 列A | 列B |\n|---|---|\n| 值1 | 值2 | 值3 |\n```\n';
  const config = writeSuite(dir, [['fenced-table.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('相邻两表不串扰', () => {
  const dir = tmp();
  const doc = '# 文档\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D | E |\n|---|---|---|\n| 3 | 4 | 5 |\n';
  const config = writeSuite(dir, [['two-tables.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('可选边管（首尾竖线）不误报', () => {
  const dir = tmp();
  const doc = '# 文档\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  const config = writeSuite(dir, [['outer-pipe.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('checkGt 行内代码 span 遮蔽（非 BMP 前置不错位）', () => {
  const dir = tmp();
  // emoji（非 BMP）在行内代码之前：码元/码点下标混用会让遮蔽区间错位。
  const doc = '# 文档\n\n😀 示例 `G-T7` 与 G-T1 主编号。\n';
  const config = writeSuite(dir, [['gt-span.md', doc, 'note']]);
  const r = runCli(['--config', config, '--mode', 'baseline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ds = JSON.parse(r.stdout).diagnostics.filter((d) => d.ruleId === 'RULE-SPEC-003');
  assert.deepEqual(ds, []);
});
