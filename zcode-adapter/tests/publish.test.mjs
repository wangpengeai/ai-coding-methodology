// 文件：zcode-adapter/tests/publish.test.mjs
// 描述：publish 编排用例（S2 步骤 7）——桩验证集驱动（fixture 内 scripts/release-suite.mjs
//       记录 argv、按标记文件退 1）断言：spawn 形态（--validate-only + process.execPath）、
//       --skip-tests 透传、验证失败市场零写、成功路径同步与清单刷新、版本闸先行。
//       另含源码切片断言（runPublish 函数体含 spawn 形态字面量，learnings 源码级断言先例）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPublish } from '../src/publish.mjs';
import { cleanupPublishBackups } from '../src/market.mjs';
import { PLUGINS, tempRoot, removeRoot, writeFile, writePluginPair } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 发布夹具：六插件仓 + 旧市场清单 + 桩验证集脚本（记录 argv；存在 fail 标记文件即退 1）。 */
function makePublishFixture() {
  const home = tempRoot('zpub');
  const repo = join(home, 'repo');
  const market = join(home, 'market');
  for (const p of PLUGINS) {
    writePluginPair(repo, p, '0.1.0', `${p} 测试（ADR-017）`);
    writeFile(join(repo, p, 'skills', 'demo.md'), '# demo\n');
  }
  writeFile(join(market, 'marketplace.json'), JSON.stringify({ name: 'fixture-market', plugins: [] }));
  writeFile(join(repo, 'scripts', 'release-suite.mjs'), [
    "import { writeFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.cwd(), 'stub-argv.txt'), JSON.stringify(process.argv.slice(2)));",
    "if (existsSync(join(process.cwd(), 'stub-fail'))) process.exit(1);",
    // 内部任务-349：两种尾印形态——全绿吐肯定行；非全绿吐 release-suite 的真实负向尾印（含「不得称「验证全绿」」同串）
    "const nonGreen = existsSync(join(process.cwd(), 'stub-nongreen'));",
    "if (nonGreen) {",
    "  process.stdout.write('[release-suite] 测量对象：不可判定（git-status-failed:128）\\n');",
    "  process.stdout.write('[release-suite] 验证通过（3 项通过；测量对象不可判定或已跳过——不得称「验证全绿」）\\n');",
    "} else {",
    "  process.stdout.write('[release-suite] 测量对象：干净（HEAD abc1234）\\n');",
    "  process.stdout.write('[release-suite] 验证全绿（3 项）\\n');",
    "}",
    'process.exit(0);',
    '',
  ].join('\n'));
  return { home, repo, market, clean: () => removeRoot(home), stubArgv: () => JSON.parse(readFileSync(join(repo, 'stub-argv.txt'), 'utf8')) };
}

test('成功路径：spawn 形态（--validate-only + 解释器=process.execPath）、同步与清单刷新落地', () => {
  const f = makePublishFixture();
  try {
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `应成功：${lines.join('')}`);
    assert.equal(r.version, '0.1.0');
    const argv = f.stubArgv();
    // spawnSync(process.execPath, [脚本, --validate-only]) ⇒ 桩内 argv.slice(2) = ['--validate-only']
    //（脚本被执行本身即证明 spawn 目标命中；路径不在 slice(2) 内）
    assert.deepEqual(argv, ['--validate-only'], 'spawn 参数面恰为 --validate-only');
    assert.ok(lines.join('').includes('验证集全绿'), '非跳过路径输出「验证集全绿」');
    assert.ok(lines.join('').includes('[release-suite] 测量对象：干净（HEAD abc1234）'), '全绿分支须转发测量对象披露行（DEV-349）');
    const mj = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    assert.equal(mj.plugins.length, 6, '清单刷新六条目');
    // 内部任务-11：尾印计数＝实测条目数（防「5 条目」硬编码字面量回潮——与上一行同源，不复制数字）
    assert.ok(lines.join('').includes(`市场清单已刷新：${mj.plugins.length} 条目`), '尾印计数与清单实测一致');
    assert.ok(existsSync(join(f.market, 'plugins', 'workflow', '.zcode-plugin', 'plugin.json')), '插件目录同步');
    // 指引关键锚（S2 门 #2 补承接——旧 selftest 指引组的最低承接面；全量 6 组随 S3 selftest.mjs 迁入）
    const guidance = lines.join('');
    assert.ok(guidance.includes('旧版本 cache 目录必须保留'), '指引含旧目录警示句');
    assert.ok(guidance.includes('.sdd/*') && guidance.includes('!.sdd/suite.json'), '指引含 gitignore 片段基础行');
    assert.ok(guidance.includes('known_marketplaces.json'), '指引含市场源判别句（OPEN-19）');
    assert.ok(guidance.includes('install-criteria'), '尾印装机指引含操作链收口步');
  } finally {
    f.clean();
  }
});

test('DEV-349 非全绿尾印：退 0 但验证集不称全绿时 publish 不得打「验证集全绿」', () => {
  const f = makePublishFixture();
  try {
    writeFile(join(f.repo, 'stub-nongreen'), '1');
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `退 0 应继续发布：${lines.join('')}`);
    const text = lines.join('');
    assert.equal(text.includes('[publish] 验证集全绿'), false, '负向尾印（含「不得称「验证全绿」」同串）不得被判成全绿（DEV-349 行首锚定）');
    assert.ok(text.includes('[publish] 验证集通过（非全绿'), '须明确非全绿通过态');
    assert.ok(text.includes('[release-suite] 测量对象：'), '须转发 release-suite 的测量对象披露行');
  } finally {
    f.clean();
  }
});

test('--skip-tests 透传：桩验证集收到该旗标；输出明确跳过态、不得冒充全绿', () => {
  const f = makePublishFixture();
  try {
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, skipTests: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 0);
    assert.ok(f.stubArgv().includes('--skip-tests'), '--skip-tests 须透传给验证集入口');
    assert.ok(lines.join('').includes('验证集已跳过（--skip-tests）'), '跳过态必须明示；不得冒充全绿');
    assert.ok(!lines.join('').includes('验证集全绿'), '跳过态不得打印「验证集全绿」');
  } finally {
    f.clean();
  }
});

test('验证集失败：退 1 且市场零写副作用', () => {
  const f = makePublishFixture();
  try {
    writeFileSync(join(f.repo, 'stub-fail'), 'x');
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('验证集失败'), '失败原因可见');
    const mj = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    assert.equal(mj.plugins.length, 0, '市场清单未被刷新');
    assert.ok(!existsSync(join(f.market, 'plugins', 'workflow')), '插件目录未被同步');
  } finally {
    f.clean();
  }
});

// ── 内部任务-276 D6/D16：生成物读守护与信号分支 ─────────────────────────────────

test('生成物缺失拒绝：未物化仓库 publish 退 1 且给 materialize 指引、市场零写（DEV-276 D6）', () => {
  const f = makePublishFixture();
  try {
    rmSync(join(f.repo, 'workflow', '.zcode-plugin', 'plugin.json'), { force: true });
    const marketBefore = readFileSync(join(f.market, 'marketplace.json'), 'utf8');
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, skipTests: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('materialize'), lines.join(''));
    assert.ok(!lines.join('').includes('    at '), '无崩溃栈');
    assert.equal(readFileSync(join(f.market, 'marketplace.json'), 'utf8'), marketBefore, '市场零写');
    assert.ok(!existsSync(join(f.market, 'plugins', 'workflow')), '插件目录未被同步');
  } finally {
    f.clean();
  }
});

test('验证集被信号杀死：退 1 且原因行含信号名（DEV-276 D16）', (t) => {
  if (process.platform === 'win32') { t.skip('win32 无 SIGKILL 语义'); return; }
  const f = makePublishFixture();
  try {
    writeFileSync(join(f.repo, 'scripts', 'release-suite.mjs'), "process.kill(process.pid, 'SIGKILL');\n");
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('被信号'), lines.join(''));
    assert.ok(lines.join('').includes('SIGKILL'), lines.join(''));
    assert.ok(!existsSync(join(f.market, 'plugins', 'workflow')), '市场零写');
  } finally {
    f.clean();
  }
});

test('缺省注入缝与市场清单不可读：默认 out 走 process 流、坏清单拒绝退 1（DEV-276 覆盖率）', () => {
  const f = makePublishFixture();
  const origOut = process.stdout.write.bind(process.stdout);
  try {
    process.stdout.write = () => true;
    // 缺省 out（默认箭头）：绿路径 spawn 桩成功 → 走默认 stdout
    assert.equal(runPublish({ repoRoot: f.repo, marketRoot: f.market, skipTests: true }).code, 0);
    // 市场清单坏 JSON：readMarketDoc 拒绝分支
    writeFileSync(join(f.market, 'marketplace.json'), '{bad');
    assert.equal(runPublish({ repoRoot: f.repo, marketRoot: f.market, skipTests: true }).code, 1);
  } finally {
    process.stdout.write = origOut;
    f.clean();
  }
});

test('版本闸先行：清单不一致在 spawn 之前拒绝', () => {
  const f = makePublishFixture();
  try {
    writeFileSync(join(f.repo, 'scout', 'plugin.manifest.json'),
      JSON.stringify({ manifestVersion: 1, name: 'scout', version: '0.2.0', description: 'x', author: 'wangp' }));
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('版本不一致'), '失败原因可见');
    assert.ok(!existsSync(join(f.repo, 'stub-argv.txt')), '验证集未被 spawn（版本闸先行）');
  } finally {
    f.clean();
  }
});

test('源码切片：runPublish 函数体锁 spawn 形态（--validate-only / process.execPath / 1800s 超时）', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'publish.mjs'), 'utf8');  const start = src.indexOf('export function runPublish');
  assert.ok(start >= 0, 'runPublish 存在');
  const body = src.slice(start); // runPublish 是本文件末函数，切片至文件尾
  assert.ok(body.includes("'--validate-only'"), 'spawn 参数面含 --validate-only 字面量');
  assert.ok(body.includes('process.execPath'), '解释器取 process.execPath（防同名 shim 解析面）');
  assert.ok(body.includes('1_800_000'), '整集超时 1800s 契约在场（原每步 600s 的整集口径，见 publish.mjs 注记）');
});

test('同步失败退 1（非 CLI 兜底退 2）：syncImpl 注入抛错 → 「拒绝：…已回滚」且清单未刷新〔round1 C3〕', () => {
  const f = makePublishFixture();
  try {
    const lines = [];
    const r = runPublish({ repoRoot: f.repo, marketRoot: f.market, out: (s) => lines.push(s),
      syncImpl: () => { throw new Error('注入：同步失败'); } });
    assert.equal(r.code, 1, 'R-za-1：业务失败退 1');
    assert.ok(lines.join('').includes('[publish] 拒绝：市场同步失败（已回滚'), `失败原因与回滚语义须可见：${lines.join('')}`);
    const mj = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    assert.equal(mj.plugins.length, 0, '同步失败后清单不得被刷新');
  } finally {
    f.clean();
  }
});

test('publish 成功后备份清理：二次发布经备份面后无 .publish-backups 残留〔DEV-275/OPEN-163〕', () => {
  const f = makePublishFixture();
  try {
    assert.equal(runPublish({ repoRoot: f.repo, marketRoot: f.market, out: () => {} }).code, 0, '首轮（新建面）');
    assert.equal(runPublish({ repoRoot: f.repo, marketRoot: f.market, out: () => {} }).code, 0, '二轮（备份→同步→自检→清理）');
    assert.ok(!existsSync(join(f.market, '.publish-backups')), '成功路径备份目录已清');
  } finally {
    f.clean();
  }
});

test('备份清理失败注入：stderr 警告且不抛出〔round1 C2——清理失败不静默不阻断〕', () => {
  const f = makePublishFixture();
  try {
    assert.equal(runPublish({ repoRoot: f.repo, marketRoot: f.market, out: () => {} }).code, 0);
    const backupRoot = join(f.market, '.publish-backups', '20261101000000');
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(backupRoot, 'workflow'), 'x');
    const warns = [];
    cleanupPublishBackups(f.market, backupRoot, { rmFn: () => { throw new Error('注入：rm 失败'); }, warn: (s) => warns.push(s) });
    assert.ok(warns.some((s) => s.includes('备份清理失败')), `清理失败须打警告：${warns.join('')}`);
    assert.ok(existsSync(backupRoot), '清理失败目录留存（无害，可手工删）');
  } finally {
    f.clean();
  }
});
