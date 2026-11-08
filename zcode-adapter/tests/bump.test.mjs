// 文件：zcode-adapter/tests/bump.test.mjs
// 描述：bump 版本折叠端到端用例（S3 步骤 9）——迁自 scripts/tests/release-suite.test.mjs
//       的三块（:389 成功路径 / :413 拒绝路径 / :431 dry-run 与回滚）；阶段4 起校验器为 .mjs 桩；
//       语义变更点（计划全局约束 2）：参数面错（版本形态/note 缺失）统一退 2（CLI 契约优先），
//       执行拒绝与自检失败仍退 1。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { PLUGINS, HOOKED_PLUGINS, tempRoot, removeRoot, writeFile } from './helpers.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

/**
 * 造 bump 夹具仓库（对齐源 makeBumpFixture :102-139 同源双份原则）：六 plugin.manifest.json +
 * 六 plugin.json + 五 hooks.json + canonical 内部接口-1（登记哈希实算）+ 桩 check-repo-consistency
 * （读 .bump-fail-checker 标记退 1）+ 桩 validate_specs + 内部治理状态 + DSH 两文件
 * （内部未决-57，内部任务-44：package.json 严格闸面 + package-lock.json 自愈面；opts 造负例形态）。
 * @param {{dshVersion?: string, lockVersion?: string, lockPkgVersion?: string, badLock?: boolean, omitDsh?: boolean, lockCollision?: boolean}} [opts]
 * @returns {{repo: string, version: string, clean: () => void}}
 */
function makeBumpFixture(opts = {}) {
  const repo = tempRoot('zbump');
  const version = '0.1.0';
  const hashes = {};
  for (const p of PLUGINS) {
    writeFile(join(repo, p, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({ name: p, version, description: `测试 ${p}`, author: 'wangp' }, null, 2)}\n`);
    writeFile(join(repo, p, 'plugin.manifest.json'), `${JSON.stringify({ manifestVersion: 1, name: p, version, description: `测试 ${p}`, author: 'wangp' }, null, 2)}\n`);
    if (HOOKED_PLUGINS.includes(p)) writeFile(join(repo, p, 'hooks', 'hooks.json'), '{"hooks":[]}\n');
    hashes[p] = {
      plugin: createHash('sha256').update(readFileSync(join(repo, p, '.zcode-plugin', 'plugin.json'))).digest('hex').slice(0, 16),
      ...(HOOKED_PLUGINS.includes(p)
        ? { hooks: createHash('sha256').update(readFileSync(join(repo, p, 'hooks', 'hooks.json'))).digest('hex').slice(0, 16) }
        : {}),
    };
  }
  const rows = [
    ...PLUGINS.map((p) => `| ${p} | ${version} | \`${p}/.zcode-plugin/plugin.json\` | sha256:${hashes[p].plugin} | \`sha256sum ${p}/.zcode-plugin/plugin.json\` |`),
    ...HOOKED_PLUGINS.map((p) => `| ${p} hooks 声明 | ${version} | \`${p}/hooks/hooks.json\` | sha256:${hashes[p].hooks} | \`sha256sum ${p}/hooks/hooks.json\` |`),
  ];
  writeFile(join(repo, 'specs', 'interfaces', '内部接口-1.md'), [
    '---', 'documentType: interface', 'validationMode: draft', '---', '',
    '# 接口 内部接口-1（测试）', '',
    `## 激活登记（2026-01-01，六插件统一 ${version} 版本折叠刷新，内部决策-017）`, '',
    `lifecycle 维持 active；契约工件哈希实测登记（${PLUGINS.join('/')} 统一折叠 ${version}——套件版本即插件版本（内部决策-017）；${version} 内容=夹具初版；hooks.json 均未动（五哈希沿 0.1.0 值；research-loop 零钩子无 hooks 登记行）；取代 2025-12-31 0.0.9 登记（0.0.9 内容=夹具前版））：`, '',
    '| 工件 | 版本 | 路径 | sha256（前 16 位） | 漂移检查 |', '|---|---|---|---|---|',
    ...rows, '',
  ].join('\n'));
  writeFile(join(repo, 'scripts', 'check-repo-consistency.mjs'),
    "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nprocess.exit(existsSync(join(process.cwd(), '.bump-fail-checker')) ? 1 : 0);\n");
  writeFile(join(repo, 'spec-gate', 'core', 'validator', 'validate_specs.mjs'), 'process.exit(0);\n');
  writeFile(join(repo, '.sdd', 'suite.json'), '{"documents": []}\n');
  // DSH 两文件（内部未决-57，内部任务-44）：缺省=正常同步态（package.json 与 lock 两处均=套件当前版）
  if (!opts.omitDsh) {
    writeFile(join(repo, 'ai-coding-methodology', 'package.json'),
      `${JSON.stringify({ name: 'ai-coding-methodology', version: opts.dshVersion ?? version }, null, 2)}\n`);
    if (!opts.omitLock) {
      if (opts.badLock) {
        writeFile(join(repo, 'ai-coding-methodology', 'package-lock.json'), '{ 坏 JSON\n');
      } else {
        const rootV = opts.lockVersion ?? (opts.dshVersion ?? version);
        const pkgV = opts.lockPkgVersion ?? rootV;
        const lock = { version: rootV, packages: { '': { version: pkgV } } };
        if (opts.lockCollision) lock.packages['node_modules/桩'] = { version: rootV };
        writeFile(join(repo, 'ai-coding-methodology', 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
      }
    }
  }
  return { repo, version, clean: () => removeRoot(repo) };
}

/**
 * 跑 bump 子命令（阶段4 起校验器为 .mjs，由当前 node 直接执行）。
 * @param {string} repo 夹具仓
 * @param {string[]} args bump 参数
 * @returns {{status: number, stdout: string}}
 */
function runBump(repo, args) {
  const r = spawnSync(process.execPath, [CLI, 'bump', repo, ...args],
    { encoding: 'utf8', env: { ...process.env } });
  return { status: r.status, stdout: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('成功路径：十五文件十六处更新（六 manifest + 六物化 plugin.json + 内部接口-1 + DSH package.json + lock 两处）、hooks 行版本列随折叠、哈希实算、hooks.json 不触碰、research-loop 无 hooks 行', () => {
  const f = makeBumpFixture();
  try {
    const r = runBump(f.repo, ['--version', '0.2.0', '--note', '测试批次']);
    assert.equal(r.status, 0, `应成功：${r.stdout}`);
    for (const p of PLUGINS) {
      assert.ok(readFileSync(join(f.repo, p, 'plugin.manifest.json'), 'utf8').includes('"0.2.0"'), `${p} manifest version 更新`);
      assert.ok(readFileSync(join(f.repo, p, '.zcode-plugin', 'plugin.json'), 'utf8').includes('"0.2.0"'), `${p} 生成物 version 随物化刷新`);
    }
    for (const p of HOOKED_PLUGINS) {
      assert.ok(readFileSync(join(f.repo, p, 'hooks', 'hooks.json'), 'utf8') === '{"hooks":[]}\n', `${p} hooks.json 不触碰`);
    }
    const host = readFileSync(join(f.repo, 'specs', 'interfaces', '内部接口-1.md'), 'utf8');
    assert.ok(host.includes('0.2.0 内容=测试批次'), 'prose 取代链接织入');
    assert.ok(host.includes('| workflow hooks 声明 | 0.2.0 |'), 'hooks 行版本列随折叠');
    assert.ok(host.includes('| research-loop | 0.2.0 |'), 'research-loop 清单行在表');
    assert.ok(!host.includes('research-loop hooks'), 'research-loop 零钩子无 hooks 登记行（条件十一行形制）');
    const newHash = createHash('sha256').update(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'))).digest('hex').slice(0, 16);
    assert.ok(host.includes(`| workflow | 0.2.0 | \`workflow/.zcode-plugin/plugin.json\` | sha256:${newHash} |`), 'plugin.json 哈希实算重登');
    // DSH 写面（内部未决-57）：package.json 严格闸通过后写目标版；lock 两处自愈带到目标版
    const dshPkg = JSON.parse(readFileSync(join(f.repo, 'ai-coding-methodology', 'package.json'), 'utf8'));
    assert.equal(dshPkg.version, '0.2.0', 'DSH package.json version 更新');
    const lock = JSON.parse(readFileSync(join(f.repo, 'ai-coding-methodology', 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '0.2.0', 'lock root version 更新');
    assert.equal(lock.packages[''].version, '0.2.0', 'lock packages[""] version 更新');
  } finally {
    f.clean();
  }
});

test('DSH 写面负例（内部未决-57，内部任务-44）：严格闸 / 缺失 / 自愈滞后 / 互异 / 坏 JSON / 撞值', () => {
  // ①package.json 版号≠套件当前版 ⇒ 退 1 且拒因为分支专属文案（严格闸）、零写入
  const f1 = makeBumpFixture({ dshVersion: '0.0.9' });
  try {
    const r = runBump(f1.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `严格闸应拒：${r.stdout}`);
    assert.ok(r.stdout.includes('不一致——先核对后重试'), '拒因为严格闸分支专属文案（防其他分支掩盖）');
    assert.ok(readFileSync(join(f1.repo, 'workflow', 'plugin.manifest.json'), 'utf8').includes('0.1.0'), '拒绝态零写入');
  } finally { f1.clean(); }
  // ②任一 DSH 文件缺失 ⇒ 退 1（非崩溃栈穿透）——package.json 缺失与 lock 单独缺失两分支（拒因各自专属）
  const f2 = makeBumpFixture({ omitDsh: true });
  try {
    const r = runBump(f2.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `缺失应拒：${r.stdout}`);
    assert.ok(r.stdout.includes('package.json 缺失'), '拒因为缺失分支专属文案');
    assert.ok(!r.stdout.includes('throw') && !r.stdout.includes('at '), '无崩溃栈穿透');
  } finally { f2.clean(); }
  const f2b = makeBumpFixture({ omitLock: true });
  try {
    const r = runBump(f2b.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `lock 单独缺失应拒：${r.stdout}`);
    assert.ok(r.stdout.includes('package-lock.json 缺失'), '拒因为 lock 缺失分支专属文案');
  } finally { f2b.clean(); }
  // ③lock 滞后（package.json=cur，lock 两处=更旧同值）⇒ 自愈成功且 lock 机械带到目标版
  const f3 = makeBumpFixture({ lockVersion: '0.0.9' });
  try {
    const r = runBump(f3.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 0, `自愈应成功：${r.stdout}`);
    const lock = JSON.parse(readFileSync(join(f3.repo, 'ai-coding-methodology', 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '0.2.0', '自愈后 root=目标版');
    assert.equal(lock.packages[''].version, '0.2.0', '自愈后 packages[""]=目标版');
  } finally { f3.clean(); }
  // ④lock 两处互异 ⇒ 退 1 且拒因为互异分支专属文案
  const f4 = makeBumpFixture({ lockVersion: '0.0.9', lockPkgVersion: '0.0.8' });
  try {
    const r = runBump(f4.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `互异应拒：${r.stdout}`);
    assert.ok(r.stdout.includes('互异'), '拒因为互异分支专属文案（防恰 2 断言分支掩盖）');
  } finally { f4.clean(); }
  // ⑤lock 坏 JSON ⇒ 退 1 非异常穿透
  const f5 = makeBumpFixture({ badLock: true });
  try {
    const r = runBump(f5.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `坏 JSON 应拒：${r.stdout}`);
    assert.ok(!r.stdout.includes('at '), '无崩溃栈穿透');
  } finally { f5.clean(); }
  // ⑥lock 互等撞值（同字面量命中 3 次）⇒ 退 1（恰 2 断言钉位——防依赖版本被静默误写）
  const f6 = makeBumpFixture({ lockCollision: true });
  try {
    const r = runBump(f6.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, `撞值应拒：${r.stdout}`);
    assert.ok(r.stdout.includes('lock'), '拒因指向 lock');
    const lock = JSON.parse(readFileSync(join(f6.repo, 'ai-coding-methodology', 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/桩'].version, '0.1.0', '依赖版本零误写');
  } finally { f6.clean(); }
});

test('参数面错统一退 2（CLI 契约优先）：版本形态非法 / note 缺失 / 同版本（同版本为执行拒绝退 1）', () => {
  const f = makeBumpFixture();
  try {
    assert.equal(runBump(f.repo, ['--version', '0.1', '--note', 'x']).status, 2, '版本格式非法=用法错');
    assert.equal(runBump(f.repo, ['--version', '0.2.0', '--note', '']).status, 2, 'note 缺失=用法错');
    const same = runBump(f.repo, ['--version', '0.1.0', '--note', 'x']);
    assert.equal(same.status, 1, '同版本=执行拒绝（未递增）');
    assert.ok(same.stdout.includes('递增'), '拒绝原因可见');
    assert.ok(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('0.1.0'), '拒绝态零写入');
    // 内部任务-214 批 4（A-za-1 补断言）：值旗标缺值/形似旗标均按用法错退 2 且零写入
    const jsonBefore = readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8');
    assert.equal(runBump(f.repo, ['--version']).status, 2, '值旗标缺值=用法错退 2');
    assert.equal(runBump(f.repo, ['--version', '--note', 'x']).status, 2, '值形似旗标=用法错退 2');
    assert.equal(runBump(f.repo, ['--note', 'x', '--version']).status, 2, '末尾值旗标缺值=用法错退 2');
    assert.equal(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8'), jsonBefore, '用法错零写入');
  } finally {
    f.clean();
  }
});

test('dry-run：退 0 且零写入（diff 只打印）', () => {
  const f = makeBumpFixture();
  try {
    const r = runBump(f.repo, ['--version', '0.2.0', '--note', '测试批次', '--dry-run']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('未写入'), 'dry-run 明示未写入');
    assert.ok(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('0.1.0'), '零写入');
  } finally {
    f.clean();
  }
});

test('后置自检失败：回滚字节一致（桩 check-repo-consistency 触发）', () => {
  const f = makeBumpFixture();
  try {
    writeFileSync(join(f.repo, '.bump-fail-checker'), 'x');
    const before = readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8');
    const hostBefore = readFileSync(join(f.repo, 'specs', 'interfaces', '内部接口-1.md'), 'utf8');
    const dshBefore = readFileSync(join(f.repo, 'ai-coding-methodology', 'package.json'), 'utf8');
    const lockBefore = readFileSync(join(f.repo, 'ai-coding-methodology', 'package-lock.json'), 'utf8');
    const r = runBump(f.repo, ['--version', '0.3.0', '--note', '测试批次']);
    assert.equal(r.status, 1, '自检失败退 1');
    assert.ok(r.stdout.includes('已回滚'), '回滚明示');
    assert.equal(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8'), before, '字节一致回滚');
    assert.equal(readFileSync(join(f.repo, 'specs', 'interfaces', '内部接口-1.md'), 'utf8'), hostBefore, '登记面字节一致回滚');
    assert.equal(readFileSync(join(f.repo, 'ai-coding-methodology', 'package.json'), 'utf8'), dshBefore, 'DSH package.json 字节一致回滚');
    assert.equal(readFileSync(join(f.repo, 'ai-coding-methodology', 'package-lock.json'), 'utf8'), lockBefore, 'DSH lock 字节一致回滚');
  } finally {
    f.clean();
  }
});

test('登记形态篡改：执行拒绝退 1 且零写入（形态闸）', () => {
  const f = makeBumpFixture();
  try {
    const hostPath = join(f.repo, 'specs', 'interfaces', '内部接口-1.md');
    writeFileSync(hostPath, readFileSync(hostPath, 'utf8').replace('| workflow |', '| workflow-x |'));
    const r = runBump(f.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, '形态闸拒绝');
    assert.ok(r.stdout.includes('形态不匹配'), '拒绝原因可见');
  } finally {
    f.clean();
  }
});

// ── 内部任务-276 D1：--repo-root 接线与缺省上溯推导 ──────────────────────────────

test('bump --repo-root 透传：作用于旗标指向的仓库而非 cwd（内部任务-276 D1）', () => {
  const f = makeBumpFixture();
  try {
    const r = spawnSync(process.execPath, [CLI, 'bump', '--repo-root', f.repo, '--version', '0.2.0', '--note', 'x', '--dry-run'],
      { encoding: 'utf8', cwd: tmpdir(), env: { ...process.env } });
    assert.equal(r.status, 0, `--repo-root 指向夹具应 dry-run 退 0：${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('workflow/plugin.manifest.json'), 'diff 针对夹具文件');
    assert.ok(readFileSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('0.1.0'), 'dry-run 零写');
  } finally {
    f.clean();
  }
});

test('bump 缺省上溯推导：无仓库根参数时作用于本 CLI 所在仓库而非 cwd（内部任务-276 D1，只读 dry-run）', (t) => {
  // 只读依赖真仓（dry-run 零写）；真仓处于版本折叠中途/DSH 版号漂移时 planBump 会拒绝——
  // 那是真仓状态的信号而非本用例要断言的行为，按要求 skip。
  const r = spawnSync(process.execPath, [CLI, 'bump', '--version', '9.9.9', '--note', 'x', '--dry-run'],
    { encoding: 'utf8', cwd: tmpdir(), env: { ...process.env } });
  if (r.status !== 0 && /\[bump\] 拒绝/.test(`${r.stdout}${r.stderr}`)) { t.skip('真仓当前不可 bump（拒绝态），跳过缺省上溯断言'); return; }
  assert.equal(r.status, 0, `缺省应上溯到真仓并 dry-run 退 0：${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes('[bump] dry-run：未写入任何文件'), 'dry-run 零写');
});

test('生成物不可读拒绝：缺物化 plugin.json 时 bump 执行拒绝退 1 且零写（内部任务-276 D7）', () => {
  const f = makeBumpFixture();
  try {
    rmSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), { force: true });
    const before = readFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'), 'utf8');
    const r = runBump(f.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stdout.includes('materialize'), r.stdout);
    assert.equal(readFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'), 'utf8'), before, '计划期拒绝零写');
  } finally {
    f.clean();
  }
});

test('生成物不可读拒绝：plugin.json 为同名目录时 bump 退 1 且零写（内部任务-276 D7/评审 correctness-2）', () => {
  const f = makeBumpFixture();
  try {
    const pj = join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json');
    rmSync(pj, { force: true });
    mkdirSync(pj); // 同名目录：readFileSync 抛 EISDIR（存在但不可读，锁住登记环内的守护）
    const before = readFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'), 'utf8');
    const r = runBump(f.repo, ['--version', '0.2.0', '--note', 'x']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stdout.includes('materialize'), r.stdout);
    assert.equal(readFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'), 'utf8'), before, '计划期拒绝零写');
  } finally {
    f.clean();
  }
});

test('note 内容闸：结构分隔子串/超长/全角括号不闭均退 2 且零写（内部任务-276 D20）', () => {
  const f = makeBumpFixture();
  try {
    const pj = join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json');
    const before = readFileSync(pj, 'utf8');
    for (const note of ['a；取代 b', 'x'.repeat(501), '（未闭']) {
      const r = runBump(f.repo, ['--version', '0.2.0', '--note', note]);
      assert.equal(r.status, 2, `note=${note.slice(0, 12)} 应退 2：${r.stdout}`);
    }
    assert.equal(readFileSync(pj, 'utf8'), before, '用法错零写入');
  } finally {
    f.clean();
  }
});
