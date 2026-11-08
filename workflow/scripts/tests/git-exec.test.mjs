// 文件：git-exec.test.mjs
// 描述：git 子进程 locale 固定与命令解析助手单测（内部任务-345）——env 覆盖顺序、
//       基础环境保留、WF_GIT_BIN 的 .mjs 注入形态、timeout/maxBuffer 预算两侧、两条英文文案谓词。
// 作者：wangp  创建：2026-11-06  版权：MIT（见 workflow/LICENSE）
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIT_C_LOCALE_ENV,
  gitSpawnEnv,
  resolveGitCommand,
  spawnGitSync,
  isNotARepoStderr,
  isEmptyRepoStderr,
} from '../lib/git-exec.mjs';

test('gitSpawnEnv：locale 覆盖在后且保留基础环境', () => {
  const env = gitSpawnEnv({ PATH: '/usr/bin', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.LANG, 'C');
  assert.deepEqual(GIT_C_LOCALE_ENV, { LC_ALL: 'C', LANG: 'C' });
});

test('resolveGitCommand：缺省 git；.mjs 走 process.execPath 前缀', () => {
  assert.deepEqual(resolveGitCommand({}), { command: 'git', argvPrefix: [] });
  assert.deepEqual(resolveGitCommand({ WF_GIT_BIN: '/tmp/fake.mjs' }), {
    command: process.execPath,
    argvPrefix: ['/tmp/fake.mjs'],
  });
});

test('spawnGitSync：子进程看到 LC_ALL=C 且 cwd/预算按传入下发', () => {
  // darwin 的 os.tmpdir() 是 /var symlink 形态，而子进程 process.cwd() 返回物理形态
  // /private/var——两侧须同形态比较（routing-lib.test.mjs 同款先例，内部任务-6 实录）。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-exec-')));
  try {
    const fake = join(dir, 'fake.mjs');
    const out = join(dir, 'env.json');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ lcAll: process.env.LC_ALL, lang: process.env.LANG, cwd: process.cwd() }));\n`,
    );
    const r = spawnGitSync([], { envBase: { ...process.env, WF_GIT_BIN: fake }, cwd: dir });
    assert.equal(r.status, 0);
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(seen.lcAll, 'C');
    assert.equal(seen.lang, 'C');
    assert.equal(seen.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnGitSync：预算只在传入时下发（传 timeoutMs 生效、缺省不注入 2s 默认）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-exec-budget-'));
  try {
    const fake = join(dir, 'slow.mjs');
    // 桩运行时长远超 2s：未传侧若被误注入 2s 默认预算就会被杀（status===null），
    // 这样「不注入默认」才有判别力（200ms 桩对 2s 默认恒绿，等于没锁）。
    writeFileSync(fake, 'setTimeout(() => process.exit(0), 2300);\n');
    const timed = spawnGitSync([], { envBase: { ...process.env, WF_GIT_BIN: fake }, timeoutMs: 50 });
    assert.equal(timed.status, null, 'timeoutMs 传入后生效（超时被杀）');
    const untimed = spawnGitSync([], { envBase: { ...process.env, WF_GIT_BIN: fake } });
    assert.equal(untimed.status, 0, '未传 timeoutMs 时不得注入 2s 默认预算（2.3s 桩未被杀）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnGitSync：maxBuffer 只在传入时下发（传 3MB 容 2MB 输出；缺省 1MB 被杀）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-exec-maxbuf-'));
  try {
    const fake = join(dir, 'big.mjs');
    writeFileSync(fake, 'process.stdout.write("x".repeat(2 * 1024 * 1024));\n');
    const wide = spawnGitSync([], { envBase: { ...process.env, WF_GIT_BIN: fake }, maxBuffer: 3 * 1024 * 1024 });
    assert.equal(wide.status, 0, '传入 maxBuffer=3MB 时 2MB 输出不被杀');
    const narrow = spawnGitSync([], { envBase: { ...process.env, WF_GIT_BIN: fake } });
    assert.equal(narrow.status, null, '未传 maxBuffer 时按 Node 默认 1MB，2MB 输出被杀');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文案谓词：英文命中、中文不误判', () => {
  assert.equal(isNotARepoStderr('fatal: not a git repository (or any of the parent directories): .git'), true);
  assert.equal(isEmptyRepoStderr("fatal: your current branch 'main' does not have any commits yet"), true);
  assert.equal(isNotARepoStderr('fatal: 不是 Git 仓库（或者任何父目录）：.git'), false);
  assert.equal(isEmptyRepoStderr('fatal: 当前分支尚无任何提交'), false);
});
