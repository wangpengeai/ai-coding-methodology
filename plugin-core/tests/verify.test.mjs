// 文件：verify 子命令漂移语义测试（A-pc-3）
// 描述：tempRoot 迷你仓 spawn 真实 CLI——无漂移退 0；注入一字节漂移退 1 且消息含 manifest 编辑面指引
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "plugin-core/tests/verify.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRoot, removeRoot, writeFile, REPO_ROOT } from './helpers.mjs';

const CLI = join(REPO_ROOT, 'plugin-core', 'cli.mjs');

function runCli(root, args) {
  // 刻意不经 shell 拼接（防代码页打坏参数），env 透传
  return spawnSync(process.execPath, [CLI, ...args, '--repo-root', root], { encoding: 'utf8' });
}

function buildMiniRepo(root) {
  // scout 形态迷你仓：manifest + 空壳脚本（validate 只查存在性）——写面全在 tmp，零真机触达
  mkdirSync(join(root, 'scout'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'scout', 'plugin.manifest.json'), join(root, 'scout', 'plugin.manifest.json'));
  writeFile(root, 'scout/hooks/session-start.mjs', '// 空壳（存在性校验用）\n');
  mkdirSync(join(root, 'scout', '.zcode-plugin'), { recursive: true });
  return root;
}

test('verify：迷你仓物化后无漂移退 0', () => {
  const root = tempRoot('ver-ok');
  try {
    buildMiniRepo(root);
    const mat = runCli(root, ['materialize', '--plugin', 'scout']);
    assert.equal(mat.status, 0, mat.stderr);
    assert.equal(mat.stdout.trim().split('\n').length, 2, '恰两行生成清单');
    const ver = runCli(root, ['verify', '--plugin', 'scout']);
    assert.equal(ver.status, 0, ver.stdout + ver.stderr);
    assert.ok(ver.stdout.includes('ok scout/.zcode-plugin/plugin.json'));
  } finally { removeRoot(root); }
});

test('verify：注入一字节漂移 → 退 1 且消息含 manifest 指引（A-pc-3）', () => {
  const root = tempRoot('ver-drift');
  try {
    buildMiniRepo(root);
    runCli(root, ['materialize', '--plugin', 'scout']);
    const target = join(root, 'scout', '.zcode-plugin', 'plugin.json');
    // 版本无关注入（首版硬编码 0.5.4 在套件 bump 后失效——漂移须对任意现行版本可检出）
    const text = readFileSync(target, 'utf8').replace(/"version": "[^"]*"/, '"version": "9.9.9-drift"');
    writeFileSync(target, text, 'utf8');
    const ver = runCli(root, ['verify', '--plugin', 'scout']);
    assert.equal(ver.status, 1);
    assert.ok(ver.stderr.includes('changed scout/.zcode-plugin/plugin.json'), `漂移行走 stderr 并逐文件列出: ${ver.stderr}`);
    assert.ok(ver.stderr.includes('plugin.manifest.json'), '失败消息须指明唯一编辑面');
    assert.ok(ver.stderr.includes('materialize'), '失败消息须含恢复动作指引');
  } finally { removeRoot(root); }
});

test('verify：生成物缺失 → missing 分类退 1', () => {
  const root = tempRoot('ver-miss');
  try {
    buildMiniRepo(root);
    runCli(root, ['materialize', '--plugin', 'scout']);
    const mat = runCli(root, ['verify', '--plugin', 'scout']);
    assert.equal(mat.status, 0);
    rmSync(join(root, 'scout', 'hooks', 'hooks.json'));
    const ver = runCli(root, ['verify', '--plugin', 'scout']);
    assert.equal(ver.status, 1);
    assert.ok(ver.stderr.includes('missing'), '缺失应报 missing 分类（漂移行流契约=stderr）');
  } finally { removeRoot(root); }
});

test('verify：计划外生成物（extra）→ 退 1 并逐条列出；materialize 清理后回绿', () => {
  const root = tempRoot('ver-extra');
  try {
    // 零钩子插件（research-loop 真件）迷你仓：materialize 只产 plugin.json
    mkdirSync(join(root, 'research-loop'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'research-loop', 'plugin.manifest.json'), join(root, 'research-loop', 'plugin.manifest.json'));
    const mat = runCli(root, ['materialize', '--plugin', 'research-loop']);
    assert.equal(mat.status, 0, mat.stderr);
    writeFile(root, 'research-loop/hooks/hooks.json', '{"hooks":{}}\n');
    const ver = runCli(root, ['verify', '--plugin', 'research-loop']);
    assert.equal(ver.status, 1, '计划外 hooks.json 须判漂移');
    assert.ok(ver.stderr.includes('extra research-loop/hooks/hooks.json'), `须列出 extra：${ver.stderr}`);
    const mat2 = runCli(root, ['materialize', '--plugin', 'research-loop']);
    assert.equal(mat2.status, 0, mat2.stderr);
    assert.equal(existsSync(join(root, 'research-loop', 'hooks', 'hooks.json')), false, 'materialize 须清理陈旧生成物');
    const ver2 = runCli(root, ['verify', '--plugin', 'research-loop']);
    assert.equal(ver2.status, 0, ver2.stderr);
  } finally { removeRoot(root); }
});

test('CLI 退码 2：未知参数 / 旗标缺值 / 未知子命令 / 未知插件', () => {
  const cases = [['--bogus'], ['--plugin'], ['nope']];
  for (const args of cases) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')} 应退 2：${r.stderr}`);
    assert.ok((r.stderr + r.stdout).trim().length > 0, '用法/错误信息须可见');
  }
  const r = spawnSync(process.execPath, [CLI, 'materialize', '--plugin', 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `未知插件应退 2：${r.stderr}`);
  assert.ok(r.stderr.includes('未知插件名'), `须触达未知插件分支：${r.stderr}`);
});

test('CLI 错误边界：--repo-root 不存在 → 退 2 且单行（非栈）', () => {
  const r = spawnSync(process.execPath, [CLI, 'verify', '--repo-root', join(REPO_ROOT, '__no_such_repo__')], { encoding: 'utf8' });
  assert.equal(r.status, 2, `应退 2：${r.stderr}`);
  assert.ok(r.stderr.includes('仓库根不存在或不可访问'), r.stderr);
  assert.ok(!/\n\s+at /.test(r.stderr), '不得输出栈回溯');
});

test('CLI 错误边界：manifest 校验失败 → 退 1 且单行 [plugin-core]（非栈）', () => {
  const root = tempRoot('cli-bad');
  try {
    writeFile(root, 'scout/plugin.manifest.json', '{"manifestVersion":1,"name":"scout","version":"1.0.0","description":"bad"}');
    const r = spawnSync(process.execPath, [CLI, 'materialize', '--plugin', 'scout', '--repo-root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1, `应退 1：${r.stderr}`);
    assert.ok(r.stderr.includes('[plugin-core]'), `须带统一前缀：${r.stderr}`);
    assert.ok(!/\n\s+at /.test(r.stderr), '不得输出栈回溯');
    assert.equal(r.stderr.trim().split('\n').length, 1, `预期内错误须单行输出：${r.stderr}`);
    // 内部任务-333：入口退出纪律源扫描（kimi cli:1169 内部任务-241 先例）——回归 process.exit(main 即红
    const cliSrc = readFileSync(CLI, 'utf8');
    assert.ok(!cliSrc.includes('process.exit(main'), 'cli.mjs 入口不得 process.exit(main（管道截断；内部任务-241 纪律）');
    assert.ok(cliSrc.includes('process.exitCode'), 'cli.mjs 入口须以 exitCode 赋值退出');
  } finally { removeRoot(root); }
});

test('consistency 第 13 块存活锚（终审处置）：pc-* 全部规则须出现在 checked.checks——整块被删即红', () => {
  // 外部消费者形态（release-suite 防回退锚同款）：块内恒真锚在被删时随块消失，唯有跨文件断言真防跳过
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-repo-consistency.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `一致性本身须绿：${r.stdout}${r.stderr}`);
  const checked = JSON.parse(r.stdout).checked.checks;
  // 只断言恒执行路径的规则（pc-*-parse/-exists 的失败分支规则无坏输入时不登记，不在此列）
  for (const rule of ['pc-manifest-exists', 'pc-manifest-version', 'pc-version-match',
    'pc-no-host-placeholder', 'pc-no-host-term', 'pc-artifact-no-neutral-placeholder']) {
    assert.ok(checked.includes(rule), `第 13 块规则 ${rule} 须在册（块被删/改名即红）`);
  }
});
