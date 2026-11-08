// 文件：workflow/scripts/tests/generate-project-skills-manifest.test.mjs
// 描述：project-skills 单源库与项目级 skill 清单生成器的行为测试（内部决策-070 D2/D3，内部任务-341）：
//       确定性生成、加载场景校验、漂移分类、宿主过滤、ack 覆盖、生成器 --check/--apply、
//       清单缺失/损坏回退扫描。对应 内部验收-25/内部验收-45 锚。
// 作者：内部任务-341 批
// 版权：MIT
// 用法：node --test "workflow/scripts/tests/generate-project-skills-manifest.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  MANIFEST_REL,
  ROOTS,
  applicableSkills,
  ackFlags,
  buildManifest,
  clipLoadScenario,
  lfSha256,
  loadProjectSkills,
  manifestDrift,
  missingAcks,
  parseFrontmatter,
  readManifest,
  renderManifest,
  renderProjectSkillIndexLines,
  requiredProjectSkills,
  scanProjectSkills,
  validateManifestShape,
} from '../lib/project-skills.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const GENERATOR = join(REPO, 'workflow', 'scripts', 'generate-project-skills-manifest.mjs');

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'dev341-skills-'));
}

function writeSkill(repo, root, name, frontmatter) {
  const dir = join(repo, root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`, 'utf8');
}

function writeManifest(repo, manifest) {
  const abs = join(repo, MANIFEST_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return abs;
}

function manifestFor(repo) {
  const { manifest, errors } = buildManifest({ projectRoot: repo });
  assert.deepEqual(errors, []);
  return manifest;
}

function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
}

test('DEV-341 清单确定性生成与场景校验：固定 roots/排序/无时间戳/无变化零 diff/缺场景报错', () => {
  const repo = makeRepo();
  writeSkill(repo, '.agents/skills', 'zeta-skill', 'name: zeta-skill\ndescription: zeta 场景');
  writeSkill(repo, '.agents/skills', 'alpha-skill', 'name: alpha-skill\nx-load-scenario: alpha 场景');
  writeSkill(repo, '.dsh/skills', 'alpha-skill', 'name: alpha-skill\nx-load-scenario: dsh 覆盖场景\nx-required-on-write: true');
  const manifest = manifestFor(repo);
  assert.deepEqual(manifest.roots, ROOTS);
  assert.equal(manifest.generator, 'workflow/scripts/generate-project-skills-manifest.mjs');
  assert.equal('generatedAt' in manifest, false);
  assert.deepEqual(manifest.skills.map((s) => `${s.name}@${s.root}`), [
    'alpha-skill@.dsh/skills',
    'alpha-skill@.agents/skills',
    'zeta-skill@.agents/skills',
  ]);
  for (const skill of manifest.skills) assert.match(skill.sha256, /^[0-9a-f]{64}$/);
  const first = renderManifest(manifest);
  assert.equal(first, renderManifest(manifestFor(repo)), '两次生成必须字节相同');
  const alpha = manifest.skills.find((s) => s.root === '.dsh/skills');
  assert.equal(alpha.loadScenario, 'dsh 覆盖场景');
  assert.equal(alpha.requiredOnWrite, true);

  // 块标量 description 回退 + 截断；x-load-scenario 优先
  const long = '场景'.repeat(200);
  writeSkill(repo, '.agents/skills', 'beta-skill', `name: beta-skill\ndescription: >-\n  ${long.slice(0, 120)}\n  ${long.slice(120)}`);
  const beta = scanProjectSkills({ projectRoot: repo, roots: ['.agents/skills'] }).skills.find((s) => s.name === 'beta-skill');
  assert.ok(beta.loadScenario.length <= 160);
  assert.ok(beta.loadScenario.endsWith('…'));
  assert.equal(clipLoadScenario('  a   b  '), 'a b');

  // 缺场景报错
  writeSkill(repo, '.agents/skills', 'gamma-skill', 'name: gamma-skill');
  const bad = buildManifest({ projectRoot: repo });
  assert.equal(bad.errors.some((e) => e.includes('缺加载场景')), true);
});

test('DEV-341 清单漂移与确定性：missing/stale/extra/字段/顺序/哈希逐类红', () => {
  const repo = makeRepo();
  writeSkill(repo, '.agents/skills', 'alpha-skill', 'name: alpha-skill\nx-load-scenario: 场景');
  writeSkill(repo, '.agents/skills', 'beta-skill', 'name: beta-skill\nx-load-scenario: 场景二');
  const manifest = manifestFor(repo);
  assert.deepEqual(manifestDrift({ projectRoot: repo }).errors.includes('清单缺失'), true);
  writeManifest(repo, manifest);
  assert.deepEqual(manifestDrift({ projectRoot: repo }).errors, []);
  // stale：源变更
  writeSkill(repo, '.agents/skills', 'alpha-skill', 'name: alpha-skill\nx-load-scenario: 新场景');
  assert.equal(manifestDrift({ projectRoot: repo }).ok, false);
  // 坏 JSON
  writeFileSync(join(repo, MANIFEST_REL), '{bad json', 'utf8');
  assert.equal(readManifest({ projectRoot: repo }).ok, false);
  // 字段/顺序/哈希/extra 形状校验
  const copied = JSON.parse(JSON.stringify(manifest));
  copied.skills[0].sha256 = 'xyz';
  copied.skills.push({ ...copied.skills[0], name: 'zzz-skill', path: '.agents/skills/zzz-skill/SKILL.md' });
  copied.roots = ['.agents/skills', ...ROOTS.filter((r) => r !== '.agents/skills')];
  const shape = validateManifestShape(copied);
  assert.equal(shape.some((e) => e.includes('sha256')), true);
  assert.equal(shape.some((e) => e.includes('roots')), true);
  const unsorted = { ...manifest, skills: [...manifest.skills].reverse() };
  assert.equal(validateManifestShape(unsorted).some((e) => e.includes('排序')), true);
  // --check/--apply 端到端 + 无变化零 diff
  const repo2 = makeRepo();
  writeSkill(repo2, '.agents/skills', 'alpha-skill', 'name: alpha-skill\ndescription: 场景');
  assert.equal(runGenerator(['--check', '--project-root', repo2]).status, 1);
  const applied = runGenerator(['--apply', '--project-root', repo2]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).wrote, true);
  const second = runGenerator(['--check', '--project-root', repo2]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).drift.added.length, 0);
  // extra / removed / changed 分类经 diff 输出可见
  writeSkill(repo2, '.agents/skills', 'beta-skill', 'name: beta-skill\ndescription: 新增');
  const stale = runGenerator(['--check', '--project-root', repo2]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).drift.added.includes('beta-skill@.agents/skills'), true);
  rmSync(join(repo2, '.agents', 'skills', 'beta-skill'), { recursive: true, force: true });
});

test('DEV-341 项目级 skill 解析与宿主过滤：frontmatter 块标量/metadata 跳过/宿主根优先/ack 覆盖', () => {
  const fields = parseFrontmatter(
    '---\nname: demo\ndescription: >-\n  第一行\n  第二行\nmetadata:\n  k: v\nx-required-on-write: yes\n---\n正文',
  );
  assert.equal(fields.name, 'demo');
  assert.equal(fields.description, '第一行 第二行');
  assert.equal(fields['x-required-on-write'], 'yes');
  assert.equal('k' in fields, false);
  assert.equal(lfSha256('a\r\nb'), lfSha256('a\nb'));
  assert.notEqual(lfSha256('a\nb'), lfSha256('a\nc'));

  const repo = makeRepo();
  writeSkill(repo, '.agents/skills', 'baseline-skill', 'name: baseline-skill\ndescription: 共同根\nx-required-on-write: true');
  writeSkill(repo, '.dsh/skills', 'baseline-skill', 'name: baseline-skill\nx-load-scenario: 宿主根覆盖');
  writeSkill(repo, '.dsh/skills', 'host-only', 'name: host-only\ndescription: 宿主必载\nx-required-on-write: true');
  writeSkill(repo, '.kimi-code/skills', 'kimi-only', 'name: kimi-only\ndescription: 其他宿主\nx-required-on-write: true');
  const manifest = manifestFor(repo);
  const dsh = requiredProjectSkills({ projectRoot: repo, env: { DSH_SESSION_ID: 'sess' } });
  assert.deepEqual(dsh.required.map((s) => s.name), ['baseline-skill', 'host-only']);
  assert.equal(dsh.required.find((s) => s.name === 'baseline-skill').root, '.dsh/skills');
  const unknown = requiredProjectSkills({ projectRoot: repo, env: {} });
  assert.deepEqual(unknown.required.map((s) => s.name), ['baseline-skill']);
  assert.deepEqual(applicableSkills(manifest.skills, 'kimi').map((s) => `${s.name}@${s.root}`), [
    'baseline-skill@.agents/skills',
    'kimi-only@.kimi-code/skills',
  ]);
  const missing = missingAcks(dsh.required, { projectSkills: [{ name: 'baseline-skill', root: '.dsh/skills' }] });
  assert.deepEqual(missing.map((s) => s.name), ['host-only']);
  assert.deepEqual(ackFlags(['a', 'b']), ['--project-skill', 'a', '--project-skill', 'b']);
  assert.deepEqual(missingAcks([], undefined), []);
  // 清单缺失/损坏 → 回退扫描（不静默缩小义务）
  writeManifest(repo, manifest);
  assert.equal(requiredProjectSkills({ projectRoot: repo, env: { DSH_SESSION_ID: 's' } }).source, 'manifest');
  writeFileSync(join(repo, MANIFEST_REL), '{broken', 'utf8');
  const fallback = loadProjectSkills({ projectRoot: repo, env: { DSH_SESSION_ID: 's' } });
  assert.equal(fallback.source, 'scan');
  assert.ok(fallback.warning);
  assert.equal(fallback.skills.some((s) => s.name === 'host-only'), true);
  // 注入行含必载 ack 提示
  const lines = renderProjectSkillIndexLines(dsh.required);
  assert.ok(lines.some((line) => line.includes('【项目 skill】host-only') && line.includes('--project-skill host-only')));
});


test('DEV-341 条目级解析错误不关闭义务：保留可解析条目并告警（F1 回归）', () => {
  const repo = makeRepo();
  writeSkill(repo, '.agents/skills', 'good-skill', 'name: good-skill\nx-load-scenario: 场景\nx-required-on-write: true');
  writeSkill(repo, '.agents/skills', 'broken-skill', 'name: broken-skill'); // 缺 description/场景
  const loaded = loadProjectSkills({ projectRoot: repo, env: {} });
  assert.equal(loaded.source, 'scan');
  assert.equal(loaded.skills.some((sk) => sk.name === 'good-skill'), true, '有效条目必须保留');
  assert.ok(loaded.warning && loaded.warning.includes('缺加载场景'), '条目错误须作为告警上抛');
  const info = requiredProjectSkills({ projectRoot: repo, env: {} });
  assert.deepEqual(info.required.map((sk) => sk.name), ['good-skill'], '无关条目损坏不得清空义务');
  assert.ok(info.warning);
});


test('DEV-341 扫描 I/O 失败不静默：不可读条目保留其他条目并告警，不可读根归 rootErrors', { skip: process.platform === 'win32' ? 'chmod 0o000 在 win32 不改读权限（先例 routing-declare.test.mjs）' : (typeof process.getuid === 'function' && process.getuid() === 0 ? 'root 持 CAP_DAC_OVERRIDE，chmod 0o000 不阻读（先例 session-start.test.mjs:612）' : false) }, () => {
  const repo = makeRepo();
  writeSkill(repo, '.agents/skills', 'good-skill', 'name: good-skill\nx-load-scenario: 场景\nx-required-on-write: true');
  writeSkill(repo, '.agents/skills', 'locked-skill', 'name: locked-skill\nx-load-scenario: 场景');
  try {
    chmodSync(join(repo, '.agents/skills/locked-skill/SKILL.md'), 0o000);
    const loaded = loadProjectSkills({ projectRoot: repo, env: {} });
    assert.equal(loaded.source, 'scan');
    assert.equal(loaded.skills.some((sk) => sk.name === 'good-skill'), true);
    assert.ok(String(loaded.warning).includes('不可读'));
    const scan = scanProjectSkills({ projectRoot: repo, roots: ['.agents/skills'] });
    assert.equal(scan.rootErrors.length, 0);
    assert.ok(scan.errors.some((e) => e.includes('不可读')));
    // 根级不可读 → rootErrors（消费面 fail-open 且告警）
    try {
      chmodSync(join(repo, '.agents/skills'), 0o000);
      const rootScan = scanProjectSkills({ projectRoot: repo, roots: ['.agents/skills'] });
      assert.ok(rootScan.rootErrors.some((e) => String(e).includes('不可读')), `根不可读须入 rootErrors：${rootScan.rootErrors}`);
      const rootLoaded = loadProjectSkills({ projectRoot: repo, env: {} });
      assert.equal(rootLoaded.source, 'scan-error');
      assert.ok(rootLoaded.warning);
    } finally {
      try { chmodSync(join(repo, '.agents/skills'), 0o755); } catch { /* 清理失败不掩盖 */ }
    }
  } finally {
    try { chmodSync(join(repo, '.agents/skills/locked-skill/SKILL.md'), 0o644); } catch { /* 清理失败不掩盖 */ }
    rmSync(repo, { recursive: true, force: true });
  }
});
