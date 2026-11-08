// 文件：物化器测试（round-trip 字节恒等 + 物化单测 + 收敛判据）
// 描述：serializeHookDoc 对现仓库五份 hooks.json 的解析-再序列化逐字节恒等；renderArtifacts 纯函数行为
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/materialize.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT, tempRoot, removeRoot, writeFile } from './helpers.mjs';
import { serializeHookDoc, renderArtifacts, zcodeColumn, planAll, applyPlan, verifyPlan, PLUGINS } from '../src/materialize.mjs';

// 收敛判据（A-pc-2）：六插件物化产物与现仓库生成物 sha256 全等（零钩子插件恰一份生成物）
// PLUGINS 单源导入（内部任务-238 S5）：新增插件时本文件自动覆盖，并由下方目录集对拍断言把守。

test('round-trip：现仓库 hooks.json 解析后自写序列化逐字节恒等', () => {
  for (const p of PLUGINS) {
    // 零钩子插件不产 hooks.json（materialize 条件分支）——按 manifest hooks 键跳过
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, p, 'plugin.manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.hooks) || manifest.hooks.length === 0) continue;
    const file = join(REPO_ROOT, p, 'hooks', 'hooks.json');
    const original = readFileSync(file, 'utf8');
    const doc = JSON.parse(original);
    assert.equal(serializeHookDoc(doc), original, `${p}/hooks/hooks.json 序列化不恒等`);
  }
});

// —— 物化单测（序列化器/分组/占位符行为锁定）——

test('物化单测：行内标量数组 + 事件分组保序 + 无 matcher 条目不产键', () => {
  const doc = serializeHookDoc({ hooks: {
    Stop: [
      { hooks: [{ type: 'process', command: 'node', args: ['x.mjs'], timeoutMs: 1, statusMessage: 'a' }] },
      { matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['y.mjs', 'z'], timeoutMs: 2, statusMessage: 'b' }] },
    ],
  } });
  assert.ok(doc.includes('"args": ["x.mjs"]'), '单元素标量数组应行内');
  assert.ok(doc.includes('"args": ["y.mjs", "z"]'), '多元素标量数组应行内、逗号空格分隔');
  assert.ok(doc.match(/\{\n\s+"hooks": \[/), '无 matcher 条目应为单键形态');
  assert.ok(doc.indexOf('"matcher"') > doc.indexOf('"hooks": ['), 'matcher 键在前');
});

test('物化单测：占位符翻译恰一处、事件键按首次出现序（Stop 先于 PreToolUse）', () => {
  const arts = renderArtifacts({
    manifestVersion: 1, name: 'x', version: '1.0.0', description: 'd', author: 'a',
    hooks: [
      { event: 'Stop', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/a.mjs'], timeoutMs: 1000, statusMessage: 's' },
      { event: 'PreToolUse', matcher: 'Bash', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/b.mjs'], timeoutMs: 1000, statusMessage: 's' },
    ],
  });
  const text = arts.find((x) => x.rel === 'hooks/hooks.json').bytes.toString('utf8');
  assert.ok(text.includes('"${ZCODE_PLUGIN_ROOT}/hooks/a.mjs"'), '占位符应译为宿主形态');
  assert.ok(!text.includes('${PLUGIN_ROOT}'), '中立占位符不得残留');
  assert.ok(text.indexOf('"Stop"') < text.indexOf('"PreToolUse"'), '事件键序=首次出现序');
});

test('物化单测：空 hooks 只产 plugin.json 一份', () => {
  const arts = renderArtifacts({ manifestVersion: 1, name: 'x', version: '1.0.0', description: 'd', author: 'a' });
  assert.equal(arts.length, 1);
  assert.equal(arts[0].rel, '.zcode-plugin/plugin.json');
});

// —— 收敛判据（A-pc-2）：六插件物化产物与现仓库生成物 sha256 全等 ——

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('收敛判据（A-pc-2）：套件插件物化产物与现仓库生成物 sha256 全等（零钩子插件恰一份生成物）', () => {
  for (const p of PLUGINS) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, p, 'plugin.manifest.json'), 'utf8'));
    const hooked = Array.isArray(manifest.hooks) && manifest.hooks.length > 0;
    const artifacts = renderArtifacts(manifest, zcodeColumn());
    assert.equal(artifacts.length, hooked ? 2 : 1, `${p} 应产 ${hooked ? 2 : 1} 份生成物（零钩子＝仅 plugin.json）`);
    for (const { rel, bytes } of artifacts) {
      const onDisk = readFileSync(join(REPO_ROOT, p, rel));
      assert.equal(sha256Hex(bytes), sha256Hex(onDisk), `${p}/${rel} 与物化产物不一致`);
    }
  }
});

// —— B 批（内部任务-5，R-pc-14/A-pc-11）：展示单源与 ZCode 物化四元数据键不变 ——

test('B：套件真件 manifest 携带非空 displayName（唯一人工编辑展示源在场）', () => {
  for (const p of PLUGINS) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, p, 'plugin.manifest.json'), 'utf8'));
    assert.equal(typeof manifest.displayName, 'string', `${p} manifest 须有 string displayName`);
    assert.ok(manifest.displayName.trim() !== '', `${p} displayName 不得为空白`);
  }
});

test('B：ZCode 物化保持四元数据键——不产宿主未确认的 displayName 键', () => {
  for (const p of PLUGINS) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, p, 'plugin.manifest.json'), 'utf8'));
    const artifacts = renderArtifacts(manifest, zcodeColumn());
    const pluginJson = JSON.parse(artifacts.find((x) => x.rel === '.zcode-plugin/plugin.json').bytes.toString('utf8'));
    assert.deepEqual(Object.keys(pluginJson).sort(), ['author', 'description', 'name', 'version'], `${p} 物化 plugin.json 键集须为四元数据键`);
  }
});

test('B：SUITE_NAME 套件标题常量（product-meta 单源，仅此一导出、zh/en 两键）', async () => {
  // 动态 import：新增文件落地前本用例按目标行为红（模块缺失即失败），不拖垮本文件其余用例
  const mod = await import('../src/product-meta.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['SUITE_NAME'], 'product-meta 仅导出 SUITE_NAME（无子名表无描述）');
  assert.deepEqual(mod.SUITE_NAME, { zh: 'AI Coding 方法论', en: 'AI Coding Methodology' });
});

/** 递归快照：相对路径 → 内容 sha256 形态（A-pc-1 零写断言用）。 */
function treeSnapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.set(full.slice(root.length), createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

test('拒生成零写：坏 manifest 下 materialize 退 1 且生成物树零新增零改写（A-pc-1 闭口，内部未决-199）', () => {
  const root = tempRoot('materialize-nowrite');
  try {
    writeFile(root, 'workflow/plugin.manifest.json', JSON.stringify({ manifestVersion: 1, name: 'workflow', version: '1.0.0', description: 'bad' }));
    const before = treeSnapshot(root);
    const cliPath = join(REPO_ROOT, 'plugin-core', 'cli.mjs');
    const r = spawnSync(process.execPath, [cliPath, 'materialize', '--plugin', 'workflow', '--repo-root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1, `坏 manifest 物化须退 1：${(r.stderr || r.stdout).slice(0, 600)}`);
    const after = treeSnapshot(root);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '拒生成时不得新增/删除文件');
    for (const [rel, hash] of before) assert.equal(after.get(rel), hash, `拒生成时既有文件不得被改写：${rel}`);
  } finally { removeRoot(root); }
});

// ---- 内部任务-238 S3：物化器反向检测与写面自愈（自愈 / 陈旧清理 / extra / 成员断言 / 白名单 / 符号链接）----

/** 迷你仓：复制套件真件 manifest（plugin 名），按 hooks.args 生成空壳脚本并建 agents 目录。 */
function seedPlugin(root, plugin, { withHooks = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, plugin, 'plugin.manifest.json'), 'utf8'));
  if (!withHooks) delete manifest.hooks;
  writeFile(root, `${plugin}/plugin.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const h of manifest.hooks ?? []) {
    for (const a of h.args ?? []) {
      if (typeof a === 'string' && a.startsWith('${PLUGIN_ROOT}/')) {
        writeFile(root, `${plugin}/${a.slice('${PLUGIN_ROOT}/'.length)}`, '// stub\n');
      }
    }
  }
  if (manifest.surfaces && manifest.surfaces.agents) writeFile(root, `${plugin}/agents/stub.md`, '# stub\n');
  return manifest;
}

test('applyPlan 自愈：目标目录缺失时 mkdir 重建（materialize 可修复 verify 报的 missing）', () => {
  const root = tempRoot('mat-heal');
  try {
    seedPlugin(root, 'scout');
    // 不建 .zcode-plugin：RED 为 ENOENT；实现后 applyPlan 自行 mkdir
    const plan = planAll(root, ['scout']);
    assert.ok(plan.every((item) => typeof item.pluginRoot === 'string'), 'plan 项须携带 pluginRoot（供陈旧清理定位）');
    applyPlan(plan);
    assert.ok(existsSync(join(root, 'scout', '.zcode-plugin', 'plugin.json')), 'plugin.json 须重建');
    assert.ok(existsSync(join(root, 'scout', 'hooks', 'hooks.json')), 'hooks.json 须重建');
  } finally { removeRoot(root); }
});

test('applyPlan 清除计划外陈旧生成物：manifest 去 hooks 后 hooks.json 被删除', () => {
  const root = tempRoot('mat-stale');
  try {
    seedPlugin(root, 'scout');
    mkdirSync(join(root, 'scout', '.zcode-plugin'), { recursive: true });
    applyPlan(planAll(root, ['scout']));
    assert.ok(existsSync(join(root, 'scout', 'hooks', 'hooks.json')), '首次物化应产 hooks.json');
    seedPlugin(root, 'scout', { withHooks: false });
    applyPlan(planAll(root, ['scout']));
    assert.equal(existsSync(join(root, 'scout', 'hooks', 'hooks.json')), false, '去钩子后陈旧 hooks.json 须被清理');
    assert.equal(verifyPlan(root, ['scout']).every((r) => r.status === 'ok'), true, '清理后 verify 应全 ok');
  } finally { removeRoot(root); }
});

test('verifyPlan：计划外生成物报 extra（零钩子插件被手工补 hooks.json）', () => {
  const root = tempRoot('mat-extra');
  try {
    seedPlugin(root, 'research-loop', { withHooks: false });
    mkdirSync(join(root, 'research-loop', '.zcode-plugin'), { recursive: true });
    applyPlan(planAll(root, ['research-loop']));
    writeFile(root, 'research-loop/hooks/hooks.json', '{"hooks":{}}\n');
    const results = verifyPlan(root, ['research-loop']);
    assert.ok(results.some((r) => r.rel === 'hooks/hooks.json' && r.status === 'extra'), `须报 extra：${JSON.stringify(results)}`);
  } finally { removeRoot(root); }
});

test('planAll：非套件插件成员即拒（库调用面白名单，不只 CLI 一层）', () => {
  const root = tempRoot('mat-member');
  try {
    seedPlugin(root, 'scout');
    assert.throws(() => planAll(root, ['demo']), /未知插件/, '非 PLUGINS 成员须拒');
  } finally { removeRoot(root); }
});

test('applyPlan：越白名单写目标即拒', () => {
  const root = tempRoot('mat-rel');
  try {
    seedPlugin(root, 'scout');
    assert.throws(
      () => applyPlan([{ plugin: 'scout', rel: 'x.txt', absPath: join(root, 'scout', 'x.txt'), pluginRoot: join(root, 'scout'), bytes: Buffer.from('x') }]),
      /越白名单写目标/,
    );
  } finally { removeRoot(root); }
});

test('applyPlan：白名单 rel + 越界 absPath 即拒（写目标归属校验）', () => {
  const root = tempRoot('mat-abs');
  try {
    seedPlugin(root, 'scout');
    const outside = writeFile(root, 'outside/plugin.json', '{}\n');
    assert.throws(
      () => applyPlan([{ plugin: 'scout', rel: '.zcode-plugin/plugin.json', absPath: outside, pluginRoot: join(root, 'scout'), bytes: Buffer.from('{}') }]),
      /越白名单写目标/,
      '合法 rel 但 absPath 越出插件根须拒',
    );
  } finally { removeRoot(root); }
});

test('applyPlan：plan 项缺 pluginRoot 即拒（写目标归属守卫不得静默跳过）', () => {
  const root = tempRoot('mat-noroot');
  try {
    seedPlugin(root, 'scout');
    const absPath = join(root, 'scout', '.zcode-plugin', 'plugin.json');
    assert.throws(
      () => applyPlan([{ plugin: 'scout', rel: '.zcode-plugin/plugin.json', absPath, bytes: Buffer.from('{}') }]),
      /plan 项缺 pluginRoot/,
    );
  } finally { removeRoot(root); }
});

test('applyPlan：.pc-tmp 为符号链接时拒绝写入（防写重定向）', (t) => {
  const root = tempRoot('mat-symlink');
  try {
    seedPlugin(root, 'scout');
    const targetDir = join(root, 'scout', '.zcode-plugin');
    mkdirSync(targetDir, { recursive: true });
    const victim = join(root, 'victim.txt');
    writeFile(root, 'victim.txt', 'original\n');
    const tmpLink = join(targetDir, 'plugin.json.pc-tmp');
    try {
      symlinkSync(victim, tmpLink, 'file');
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
        t.skip(`无符号链接权限（${e.code}），跳过跨机不可达用例`);
        return;
      }
      throw e;
    }
    assert.throws(() => applyPlan(planAll(root, ['scout'])), /符号链接/);
    assert.equal(readFileSync(victim, 'utf8'), 'original\n', '符号链接目标不得被写入');
  } finally { removeRoot(root); }
});

test('物化器边界：空集合序列化 / 非法 declarationShape / 无 hooks 只产 plugin.json', () => {
  assert.equal(serializeHookDoc({ hooks: [] }), '{\n  "hooks": []\n}\n');
  assert.equal(serializeHookDoc({ hooks: {} }), '{\n  "hooks": {}\n}\n');
  const manifest = { manifestVersion: 1, name: 'x', version: '1.0.0', description: 'd', author: 'a' };
  assert.throws(() => renderArtifacts(manifest, { declarationShape: 'bogus' }), /不支持的声明形态/);
});

test('拒生成零写（六插件夹具）：合法插件不得先写、错误集仅含坏件 spec-gate', () => {
  const root = tempRoot('mat-multi');
  try {
    for (const p of PLUGINS) seedPlugin(root, p);
    const badPath = join(root, 'spec-gate', 'plugin.manifest.json');
    const bad = JSON.parse(readFileSync(badPath, 'utf8'));
    delete bad.version;
    writeFile(root, 'spec-gate/plugin.manifest.json', `${JSON.stringify(bad, null, 2)}\n`);
    const before = treeSnapshot(root);
    const cliPath = join(REPO_ROOT, 'plugin-core', 'cli.mjs');
    const r = spawnSync(process.execPath, [cliPath, 'materialize', '--repo-root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1, `坏件须退 1：${(r.stderr || r.stdout).slice(0, 600)}`);
    const after = treeSnapshot(root);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '任何合法插件的生成物不得先写（零新增）');
    for (const [rel, hash] of before) assert.equal(after.get(rel), hash, `拒生成时既有文件不得被改写：${rel}`);
    for (const p of PLUGINS) {
      if (p === 'spec-gate') continue;
      assert.ok(!r.stderr.includes(`${p}:`), `合法插件 ${p} 不得入错误集`);
    }
    assert.ok(r.stderr.includes('spec-gate'), '错误集须含坏件 spec-gate');
  } finally { removeRoot(root); }
});

test('套件插件清单单源：PLUGINS 与仓库带 manifest 的插件目录集一致（新增第 7 插件须同批更新）', () => {
  const fromDir = readdirSync(REPO_ROOT).filter((d) => existsSync(join(REPO_ROOT, d, 'plugin.manifest.json'))).sort();
  assert.deepEqual([...PLUGINS].sort(), fromDir, 'PLUGINS 与仓库实存插件集不一致');
  assert.deepEqual(PLUGINS, ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);
});

test('README 与 CLI USAGE 的套件口径与 PLUGINS 一致（六名单齐全、无过期计数）', () => {
  const readme = readFileSync(join(REPO_ROOT, 'plugin-core', 'README.md'), 'utf8');
  for (const p of PLUGINS) assert.ok(readme.includes(p), `README 须列出插件名 ${p}`);
  assert.ok(!/[四五]插件/.test(readme), 'README 不得残留过期套件计数口径');
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'plugin-core', 'cli.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2, '无子命令应以用法错退 2');
  const usage = `${r.stdout}${r.stderr}`;
  for (const p of PLUGINS) assert.ok(usage.includes(p), `CLI USAGE 须含插件名 ${p}`);
  assert.ok(usage.includes('缺省＝套件全部插件'), 'USAGE 须由 PLUGINS 派生（不得手写名单）');
  for (const f of readdirSync(join(REPO_ROOT, 'plugin-core', 'tests')).filter((x) => x.endsWith('.mjs'))) {
    const text = readFileSync(join(REPO_ROOT, 'plugin-core', 'tests', f), 'utf8');
    assert.ok(!/[四五]插件/.test(text), `测试文件不得残留旧套件计数口径：${f}`);
  }
});
