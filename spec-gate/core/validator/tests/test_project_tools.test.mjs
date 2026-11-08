// AC-PROJ-001：项目接入工具 sdd_init/sdd_check（含 F-1/F-3/F-4/F-14）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';

const TOOLS = join(CORE_ROOT, 'validator/tools');
const INIT = join(TOOLS, 'sdd_init.mjs');
const CHECK = join(TOOLS, 'sdd_check.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-tools-')));
const run = (tool, args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 120000 });
const json = (r) => JSON.parse(r.stdout);
const init = (p) => run(INIT, ['--project', p, '--format', 'json']);
const check = (p, extra = []) => run(CHECK, ['--project', p, '--format', 'json', ...extra]);

test('init 生成 project/suite/ledger 骨架，suite 可跑 suite 模式', () => {
  const project = tmp();
  const r = init(project);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).specSystem, 'absent');
  const config = JSON.parse(readFileSync(join(project, '.sdd/project.json'), 'utf8'));
  assert.equal(config.ledgerPath, '.sdd/ledger.json');
  assert.ok(existsSync(join(project, '.sdd/ledger.json')));
  const suite = JSON.parse(readFileSync(join(project, '.sdd/suite.json'), 'utf8'));
  assert.ok(suite.manifest.endsWith('manifest.json'));
  assert.equal('validationRoots' in suite, false, 'init 产物不再含 validationRoots 死字段（DEV-347/OPEN-141）');
  const c = check(project);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(json(c).blockingCount, 0);
});

test('init 检测既有规格体系、幂等、缺目录退 2', () => {
  const project = tmp();
  mkdirSync(join(project, 'docs/design'), { recursive: true });
  writeFileSync(join(project, 'docs/design/software_design.md'), '# 规格\n');
  assert.equal(json(init(project)).specSystem, 'present');
  const before = readFileSync(join(project, '.sdd/project.json'), 'utf8');
  assert.equal(init(project).status, 0);
  assert.equal(readFileSync(join(project, '.sdd/project.json'), 'utf8'), before);
  assert.equal(run(INIT, ['--project', join(project, 'nope')]).status, 2);
});

test('init boundaries 坏形态退 1 并给样例；symlink 目标拒绝且不写出', () => {
  const project = tmp();
  init(project);
  const path = join(project, '.sdd/project.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.boundaries = 'src 不许 import tests';
  writeFileSync(path, JSON.stringify(config));
  const r = init(project);
  assert.equal(r.status, 1);
  assert.ok(json(r).problems.join('；').includes('boundaries 须为规则对象数组'));
  assert.ok(json(r).problems.join('；').includes('BOUND-1'));

  const p2 = tmp();
  mkdirSync(join(p2, '.sdd'));
  const outside = join(tmp(), 'outside.json');
  symlinkSync(outside, join(p2, '.sdd/suite.json'));
  const r2 = init(p2);
  assert.equal(r2.status, 2);
  assert.equal(existsSync(outside), false, 'symlink 目标不得被写出');
});

test('check：缺 config 退 2；缺 suite 退 2；缺 ledger 退 0＋warning', () => {
  const project = tmp();
  assert.equal(check(project).status, 2);
  const textMissing = run(CHECK, ['--project', join(project, 'nope'), '--format', 'text']);
  assert.equal(textMissing.status, 2);
  assert.ok(textMissing.stdout.startsWith('项目未接入'));
  const initMissing = run(INIT, ['--project', join(project, 'nope'), '--format', 'text']);
  assert.equal(initMissing.status, 2);
  assert.ok(initMissing.stdout.startsWith('项目目录不存在'));
  init(project);
  unlinkSync(join(project, '.sdd/suite.json'));
  const r2 = check(project);
  assert.equal(r2.status, 2);
  assert.ok(json(r2).error.includes('suite 配置不存在'));
  init(project);
  unlinkSync(join(project, '.sdd/ledger.json'));
  const r3 = check(project);
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.ok(json(r3).diagnostics.some((d) => d.severity === 'warning' && d.fixHint.includes('ledger 尚未建立')));
});

test('symlink 项目根与 suite 配置按目标读取（F-14 只拒绝写目标 symlink）', () => {
  const real = tmp();
  init(real);
  const projectLink = join(tmp(), 'project-link');
  symlinkSync(real, projectLink);
  const viaProject = check(projectLink);
  assert.equal(viaProject.status, 0, viaProject.stdout + viaProject.stderr);

  const p = tmp();
  init(p);
  const suitePath = join(p, '.sdd/suite.json');
  const realSuite = join(tmp(), 'suite.json');
  writeFileSync(realSuite, readFileSync(suitePath));
  unlinkSync(suitePath);
  symlinkSync(realSuite, suitePath);
  const viaSuite = check(p);
  assert.equal(viaSuite.status, 0, viaSuite.stdout + viaSuite.stderr);
});

test('F-14：并发 init 原子写，最终配置始终是完整 JSON', async () => {
  const project = tmp();
  const runOne = () => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [INIT, '--project', project, '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stderr }));
  });
  const runs = await Promise.all(Array.from({ length: 8 }, runOne));
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  for (const rel of ['.sdd/project.json', '.sdd/suite.json', '.sdd/ledger.json']) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(project, rel), 'utf8')), rel);
  }
});

test('check：draft 文档套件退 0（F-4）；边界违规退 1；坏 boundaries/坏 now 退 2', () => {
  const project = tmp();
  init(project);
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs/spec.md'), '# 规格\n');
  const suitePath = join(project, '.sdd/suite.json');
  const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
  suite.documents = [{ path: 'docs/spec.md', documentType: 'glossary', validationMode: 'draft' }];
  writeFileSync(suitePath, JSON.stringify(suite));
  let r = check(project);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const configPath = join(project, '.sdd/project.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.boundaries = [{ id: 'BOUND-1', scope: 'lib/domain', deny: ['package:flutter/'], severity: 'blocking', rationale: '领域层零框架依赖' }];
  writeFileSync(configPath, JSON.stringify(config));
  mkdirSync(join(project, 'lib/domain'), { recursive: true });
  writeFileSync(join(project, 'lib/domain/order.dart'), "import 'package:flutter/widgets.dart';\n");
  r = check(project);
  assert.equal(r.status, 1);
  assert.ok(json(r).diagnostics.some((d) => d.ruleId === 'RULE-BOUND-001'));

  config.boundaries = 'src 不许 import tests';
  writeFileSync(configPath, JSON.stringify(config));
  r = check(project);
  assert.equal(r.status, 2);
  assert.ok(json(r).error.includes('boundaries 配置非法'));

  config.boundaries = [{ id: 'BOUND-2', scope: '..', deny: ['x'], severity: 'blocking', rationale: 'r' }];
  writeFileSync(configPath, JSON.stringify(config));
  r = check(project);
  assert.equal(r.status, 2);
  assert.ok(json(r).problems.join('；').includes('路径安全拒绝'));

  config.boundaries = [];
  writeFileSync(configPath, JSON.stringify(config));
  r = check(project, ['--now', 'bogus']);
  assert.equal(r.status, 2);
  r = check(project, ['--now', '']);
  assert.equal(r.status, 2, '空 --now 不得静默关闭超期检查');
  assert.ok(json(r).error.includes('不能为空字符串'));

  config.boundaries = null;
  writeFileSync(configPath, JSON.stringify(config));
  r = check(project);
  assert.equal(r.status, 2, 'boundaries:null 不得被 ?? [] 静默归一');
  assert.ok(json(r).problems.join('；').includes('boundaries 须为规则对象数组'));
  assert.equal(init(project).status, 1, 'init 对 boundaries:null 应报 problems');
});

test('check：坏 project.json 退 2；逾期台账退 1', () => {
  const project = tmp();
  init(project);
  writeFileSync(join(project, '.sdd/project.json'), '[]');
  assert.equal(check(project).status, 2);

  const project2 = tmp();
  init(project2);
  const ledger = {
    schemaVersion: '1.0',
    tasks: [{ id: 'TASK-1', title: '旧缓解', status: 'temporary-mitigation', createdAt: '2026-08-01T00:00:00+00:00', fastTrack: true, deadline: '2026-08-15T00:00:00+00:00', owner: 'dev' }],
  };
  writeFileSync(join(project2, '.sdd/ledger.json'), JSON.stringify(ledger));
  const r = check(project2, ['--now', '2026-09-01T00:00:00+00:00']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(json(r).diagnostics.some((d) => d.ruleId === 'RULE-LEDGER-002'));
});
