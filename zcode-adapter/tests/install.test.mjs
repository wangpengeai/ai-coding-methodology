// 文件：zcode-adapter/tests/install.test.mjs
// 描述：install 写面用例（S4 步骤 11）——写序可观察、旧版本目录永不删、镜像对齐、登记表原子
//       更新（未触碰条目逐字保留）、config 启用补齐、写后即验失败回滚（三文件快照 + 新建 cache
//       目录删除；镜像幂等重对齐自愈）、幂等重放、--bootstrap 从零、备份 .bak-<ts>、dry-run
//       尾印、version 口径（缺省=市场清单；--version 不符退 2）、源仓零改动不变量（mcode
//       sourceFingerprint 先例）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { runInstall, cleanupBackups } from '../src/install.mjs';
import { runVerify } from '../src/verify.mjs';
import { buildExpectTree, diffTrees } from '../src/expect-tree.mjs';
import { clientPath } from '../src/manifests.mjs';
import { main } from '../cli.mjs';
import { MARKET, PLUGINS, VERSION, OLD_VERSION, makeRepo, makeMarket, makeZcodeHome, removeRoot, readJson, writeFile, copyFiltered, fingerprintTree, tempRoot, writePluginPair } from './helpers.mjs';

/**
 * 装机夹具：repo+market+zhome 三件套在 0.1.0 全绿态，再可选把 repo+market 升到 0.2.0
 * （install 的「待装机版本」场景）。
 * @param {{bumpTo?: string}} [opts]
 * @returns {object} 夹具句柄
 */
function makeInstallFixture(opts = {}) {
  const repo0 = makeRepo();
  const market0 = makeMarket(repo0.repo);
  const zhome = makeZcodeHome(market0.market);
  const f = {
    repo: repo0.repo,
    market: market0.market,
    zhome: zhome.home,
    z: zhome,
    clean: () => { removeRoot(repo0.repo); removeRoot(market0.market); removeRoot(zhome.home); },
  };
  if (opts.bumpTo) {
    const v = opts.bumpTo;
    for (const p of PLUGINS) {
      // 内部决策-036 源切换：版本源 = plugin.manifest.json；生成物同步抬版（随包分发自洽）
      const m = readJson(join(f.repo, p, 'plugin.manifest.json'));
      m.version = v;
      writeFileSync(join(f.repo, p, 'plugin.manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
      const pj = readJson(join(f.repo, p, '.zcode-plugin', 'plugin.json'));
      pj.version = v;
      writeFileSync(join(f.repo, p, '.zcode-plugin', 'plugin.json'), `${JSON.stringify(pj, null, 2)}\n`);
    }
    const mj = readJson(join(f.market, 'marketplace.json'));
    for (const e of mj.plugins) e.version = v;
    writeFileSync(join(f.market, 'marketplace.json'), `${JSON.stringify(mj, null, 2)}\n`);
    for (const p of PLUGINS) copyFiltered(join(f.repo, p), join(f.market, 'plugins', p));
  }
  return f;
}

/** 源仓指纹（sha256+mtime，mcode sourceFingerprint 先例；单源在 helpers.fingerprintTree，round1 S4）。 */
const fingerprint = (root) => fingerprintTree(root, true);

test('成功路径：cache 新版本落位、旧版本目录逐字节仍在、镜像对齐、登记表更新、config 补齐、写后即验全绿', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `应成功：${lines.join('')}`);
    for (const p of PLUGINS) {
      assert.ok(existsSync(join(f.z.cacheDir(p, '0.2.0'), '.zcode-plugin', 'plugin.json')), `${p} 新版本目录落位`);
      assert.ok(existsSync(f.z.cacheDir(p, VERSION)), `${p} 旧版本目录仍在（永不删）`);
      assert.ok(existsSync(f.z.cacheDir(p, OLD_VERSION)), `${p} 更旧版本目录仍在`);
      assert.ok(existsSync(join(f.z.mirrorRoot, 'plugins', p, '.zcode-plugin', 'plugin.json')), `${p} 镜像对齐`);
    }
    const reg = readJson(f.z.registryPath);
    const entry = reg.plugins.find((e) => e.name === 'workflow');
    assert.equal(entry.version, '0.2.0', '登记表版本更新');
    assert.ok(String(entry.installPath).includes('0.2.0'), 'installPath 指向新版本目录');
  // 内部任务-276 D20：写侧保留尾分隔符形态沿旧条目（锁因：宿主既有条目兼容，非设计意图）
  assert.ok(String(entry.installPath).endsWith(sep + sep), 'installPath 尾分隔符形态沿旧条目');
    // 内部任务-334/内部未决-247①：makeEntry 工厂键序＝JSON 字节契约（九键插入序，勿改）
    assert.deepEqual(Object.keys(entry), ['id', 'name', 'marketplace', 'version', 'installPath', 'installedAt', 'updatedAt', 'scope', 'source'], '登记表条目键序＝字节契约');
    const vb = reg.plugins.find((e) => e.name === 'vision-bridge');
    assert.equal(vb.version, '1.2.0', '未触碰条目保留');
    const cfg = readJson(f.z.configPath);
    assert.equal(cfg.plugins.enabledPlugins[`workflow@${MARKET}`], true, 'config 启用在位');
    const verify = runVerify({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome });
    assert.deepEqual(verify.problems, [], '写后即验面料全绿（F7 注册面豁免口径）');
    const text = lines.join('');
    assert.ok(text.includes('新版本需新会话生效') && text.includes('旧版本 cache 目录已保留'), '成功尾印警示句');
  } finally {
    f.clean();
  }
});

test('未注册市场尾印指引：stdout 含注册指引且 known_marketplaces 字节不变〔DEV-275/OPEN-163〕', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const knownPath = join(f.zhome, 'cli', 'plugins', 'known_marketplaces.json');
    writeFileSync(knownPath, `${JSON.stringify({ version: 1, marketplaces: [] }, null, 2)}\n`);
    const knownBefore = readFileSync(knownPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `未注册只提示不阻断：${lines.join('')}`);
    assert.ok(lines.join('').includes('未注册到 known_marketplaces'), '尾印含未注册指引');
    assert.ok(lines.join('').includes('install --bootstrap'), '指引给出注册出路');
    assert.equal(readFileSync(knownPath, 'utf8'), knownBefore, 'known_marketplaces 字节不变（不自动写注册）');
  } finally {
    f.clean();
  }
});

test('注册指向旧路径：尾印含两路径不一致告警〔DEV-275/OPEN-163〕', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const staleDir = join(tmpdir(), `zcode-install-stale-${process.pid}`);
    rmSync(staleDir, { recursive: true, force: true });
    mkdirSync(staleDir, { recursive: true });
    const knownPath = join(f.zhome, 'cli', 'plugins', 'known_marketplaces.json');
    writeFileSync(knownPath, `${JSON.stringify({ version: 1, marketplaces: [
      { id: MARKET, name: MARKET, description: '旧路径', source: { source: 'directory', path: staleDir } },
    ] }, null, 2)}\n`);
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `不一致只提示不阻断：${lines.join('')}`);
    assert.ok(lines.join('').includes('注册指向与本次安装源不一致'), '尾印含不一致告警');
    assert.ok(lines.join('').includes('registered='), '告警给出注册路径');
    rmSync(staleDir, { recursive: true, force: true });
  } finally {
    f.clean();
  }
});

test('市场源陈旧（repo 领先）：退 1 零写并提示先 publish', () => {
  const f = makeInstallFixture();
  try {
    // repo 抬到 0.2.0 而市场不动 → F2 前置闸拒绝（内部决策-036：版本源=manifest）
    const m = readJson(join(f.repo, 'workflow', 'plugin.manifest.json'));
    m.version = '0.2.0';
    writeFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('publish'), '提示先 publish');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '登记表零写');
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), 'cache 零写');
  } finally {
    f.clean();
  }
});

test('写后即验失败回滚：三客户端文件字节一致回写 + 本次新建 cache 版本目录删除', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    // 经 verifyImpl 注入缝造必红（executeBump checksImpl 先例）——失败源在写面之外，
    // 断言回滚只覆盖三客户端文件 + 本次新建 cache 目录，镜像由对齐步自愈
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const cfgBefore = readFileSync(f.z.configPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      verifyImpl: () => ({ problems: ['F5：注入失配'], faces: [] }), out: (s) => lines.push(s) });
    assert.equal(r.code, 1, '写后即验失败退 1');
    assert.ok(lines.join('').includes('回滚'), '回滚明示');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '登记表字节一致回写');
    assert.equal(readFileSync(f.z.configPath, 'utf8'), cfgBefore, 'config 字节一致回写');
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), '本次新建 cache 版本目录删除');
    assert.ok(existsSync(f.z.cacheDir('workflow', VERSION)), '既有旧版本目录不受回滚影响');
  } finally {
    f.clean();
  }
});

test('幂等重放：同版本二次 install 结果一致且全绿', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const reg1 = readFileSync(f.z.registryPath, 'utf8');
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), reg1, '重放结果一致');
    assert.deepEqual(runVerify({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome }).problems, []);
  } finally {
    f.clean();
  }
});

test('备份生命周期：成功路径清本次 .bak（OPEN-122/DEV-82）＋回滚路径保留', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} });
    assert.equal(r.code, 0);
    const pluginsRoot = join(f.zhome, 'cli', 'plugins');
    const cfgDir = join(f.zhome, 'cli');
    // 成功路径：本次 .bak 全部被清（内部未决-122/内部任务-82——kimi cleanupBackups 同款姿态）
    for (const rel of ['installed_plugins.json', 'known_marketplaces.json']) {
      const baks = readdirSync(pluginsRoot).filter((n) => n.startsWith(`${rel}.bak-`));
      assert.equal(baks.length, 0, `${rel} 成功路径 .bak 已清`);
    }
    assert.ok(!readdirSync(cfgDir).some((n) => n.startsWith('config.json.bak-')), 'config 成功路径 .bak 已清');
    // 回滚路径：写后即验失败（注入 verifyImpl 恒红）→ .bak 保留（人工恢复兜底）
    const f2 = makeInstallFixture({ bumpTo: '0.3.0' });
    try {
      const r2 = runInstall({
        repoRoot: f2.repo, marketRoot: f2.market, zcodeHome: f2.zhome, out: () => {},
        verifyImpl: () => ({ problems: ['注入失败'] }),
      });
      assert.equal(r2.code, 1, '注入验证失败退 1');
      const pr2 = join(f2.zhome, 'cli', 'plugins');
      assert.ok(readdirSync(pr2).some((n) => n.startsWith('installed_plugins.json.bak-')), '回滚路径 .bak 保留');
    } finally {
      f2.clean();
    }
  } finally {
    f.clean();
  }
});

test('超龄清理：31 天前 mtime 的旧 .bak 被清，29 天前的保留（OPEN-122/DEV-82）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    // 先装一次建立基线（成功后 .bak 已清）
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} });
    assert.equal(r.code, 0);
    const pluginsRoot = join(f.zhome, 'cli', 'plugins');
    const regPath = join(pluginsRoot, 'installed_plugins.json');
    // 手动造两条旧 .bak（一条 31 天前、一条 29 天前）
    const old31 = `${regPath}.bak-20000101-000000`;
    const old29 = `${regPath}.bak-20000102-000000`;
    writeFileSync(old31, '{}');
    writeFileSync(old29, '{}');
    const dayMs = 24 * 60 * 60 * 1000;
    utimesSync(old31, new Date(Date.now() - 31 * dayMs), new Date(Date.now() - 31 * dayMs));
    utimesSync(old29, new Date(Date.now() - 29 * dayMs), new Date(Date.now() - 29 * dayMs));
    // 再装一次（触发超龄清理）
    const r2 = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} });
    assert.equal(r2.code, 0);
    assert.ok(!existsSync(old31), '31 天前 .bak 被清');
    assert.ok(existsSync(old29), '29 天前 .bak 保留（未超 30 天）');
  } finally {
    f.clean();
  }
});

test('--bootstrap 从零：空 zcode-home → 市场注册 + 启用 + 装机全链绿', () => {
  const repo0 = makeRepo();
  const market0 = makeMarket(repo0.repo);
  try {
    const home = removeRoot_mkdir();
    const lines = [];
    const r = runInstall({ repoRoot: repo0.repo, marketRoot: market0.market, zcodeHome: home, bootstrap: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `bootstrap 应成功：${lines.join('')}`);
    const km = readJson(join(home, 'cli', 'plugins', 'known_marketplaces.json'));
    const entry = km.marketplaces.find((m) => m.id === MARKET);
    assert.ok(entry && entry.source.source === 'directory' && entry.source.path === market0.market, '市场注册（directory 源）');
    const cfg = readJson(join(home, 'cli', 'config.json'));
    for (const p of PLUGINS) assert.equal(cfg.plugins.enabledPlugins[`${p}@${MARKET}`], true, `${p} 从零启用`);
    assert.deepEqual(runVerify({ repoRoot: repo0.repo, marketRoot: market0.market, zcodeHome: home }).problems, [], 'bootstrap 后七面全绿');
  } finally {
    removeRoot(repo0.repo);
    removeRoot(market0.market);
  }
});

test('--bootstrap 既有插件目录无清单：同步备份在成功收尾被清理（round1 C4）〔DEV-275〕', () => {
  const repo0 = makeRepo();
  const marketDir = mkdtempSync(join(tmpdir(), 'zcode-bootstrap-backup-'));
  try {
    // 市场目录已有插件树但缺 marketplace.json → bootstrap fresh 路径 → syncPlugins 备份既有目录
    for (const p of PLUGINS) copyFiltered(join(repo0.repo, p), join(marketDir, 'plugins', p));
    const home = removeRoot_mkdir();
    const lines = [];
    const r = runInstall({ repoRoot: repo0.repo, marketRoot: marketDir, zcodeHome: home, bootstrap: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 0, `bootstrap 应成功：${lines.join('')}`);
    assert.ok(!existsSync(join(marketDir, '.publish-backups')), 'bootstrap 同步备份须在成功收尾清理');
  } finally {
    removeRoot(repo0.repo);
    rmSync(marketDir, { recursive: true, force: true });
  }
});

test('--bootstrap 市场源不存在：缺省 <zcode-home>/local-marketplace 创建并全链绿', () => {
  const repo0 = makeRepo();
  try {
    const home = removeRoot_mkdir();
    const r = runInstall({ repoRoot: repo0.repo, marketRoot: '', zcodeHome: home, bootstrap: true, out: () => {} });
    assert.equal(r.code, 0, 'bootstrap 缺省市场源应成功');
    const marketRoot = join(home, 'local-marketplace');
    assert.ok(existsSync(join(marketRoot, 'marketplace.json')), '缺省市场源创建');
    assert.deepEqual(runVerify({ repoRoot: repo0.repo, marketRoot, zcodeHome: home }).problems, [], '全链绿');
  } finally {
    removeRoot(repo0.repo);
  }
});

test('version 口径：缺省取市场清单条目版本；--version 与市场不符退 2', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const r1 = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} });
    assert.equal(r1.code, 0);
    assert.equal(readJson(f.z.registryPath).plugins.find((e) => e.name === 'workflow').version, '0.2.0', '缺省=市场清单版本');
    const f2 = makeInstallFixture({ bumpTo: '0.2.0' });
    try {
      const r2 = runInstall({ repoRoot: f2.repo, marketRoot: f2.market, zcodeHome: f2.zhome, version: '9.9.9', out: () => {} });
      assert.equal(r2.code, 2, '--version 与市场不符=用法错退 2');
    } finally {
      f2.clean();
    }
    // 市场清单来源的 V 形态闸（内部任务-238 S9）：恶意版本不得进入 cache 路径拼接/rmSync
    const f3 = makeInstallFixture({ bumpTo: '0.2.0' });
    try {
      const mj = readJson(join(f3.market, 'marketplace.json'));
      for (const e of mj.plugins) e.version = '../../evil';
      writeFileSync(join(f3.market, 'marketplace.json'), `${JSON.stringify(mj, null, 2)}\n`);
      const lines = [];
      const r3 = runInstall({ repoRoot: f3.repo, marketRoot: f3.market, zcodeHome: f3.zhome, out: (s) => lines.push(s) });
      assert.equal(r3.code, 1, `非法市场版本须拒装：${lines.join('')}`);
      assert.ok(lines.join('').includes('三段式'), '拒绝原因须指认版本形态');
    } finally {
      f3.clean();
    }
  } finally {
    f.clean();
  }
});

test('dry-run：零写入、登记表/缓存不动、尾印含「未写入、未验证」', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, dryRun: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 0);
    assert.ok(lines.join('').includes('dry-run：未写入、未验证'), 'dry-run 尾印');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '登记表零写');
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), 'cache 零写');
  } finally {
    f.clean();
  }
});

test('源仓零改动不变量：install 前后 repo 指纹（sha256+mtime）全等', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const before = fingerprint(f.repo);
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    assert.equal(fingerprint(f.repo), before, '六插件源资产零改动');
  } finally {
    f.clean();
  }
});

test('CLI 面 --bootstrap 旗标可达（经 main 解析层，门 #3 修复的回归锚）', () => {
  const repo0 = makeRepo();
  const market0 = makeMarket(repo0.repo);
  try {
    const home = mkdtempSync(join(tmpdir(), 'zcode-cli-bootstrap-'));
    const code = main(['install', '--bootstrap', '--zcode-home', home, '--marketplace', market0.market, '--repo-root', repo0.repo]);
    assert.equal(code, 0, 'CLI 传 --bootstrap 必须激活冷启动（曾为死旗）');
    const km = readJson(join(home, 'cli', 'plugins', 'known_marketplaces.json'));
    assert.ok(km.marketplaces.some((m) => m.id === MARKET), '注册在位');
  } finally {
    removeRoot(repo0.repo);
    removeRoot(market0.market);
  }
});

/** 空白 zcode-home 临时根（bootstrap 从零面）。 */
function removeRoot_mkdir() {
  return mkdtempSync(join(tmpdir(), 'zcode-bootstrap-'));
}

// ── 内部任务-276 D18：退 2 用法错走 stderr ───────────────────────────────────────

test('退 2 用法错走 stderr：缺市场源与 --version 不符（DEV-276 D18）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  const errs = [];
  const orig = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = (c) => { errs.push(String(c)); return true; };
    const outs = [];
    const a = runInstall({ repoRoot: f.repo, marketRoot: '', zcodeHome: f.zhome, out: (s) => outs.push(s) });
    const b = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, version: '9.9.9', out: (s) => outs.push(s) });
    process.stderr.write = orig;
    assert.equal(a.code, 2);
    assert.equal(b.code, 2);
    assert.ok(errs.join('').includes('市场源不可解'), '缺市场源消息在 stderr');
    assert.ok(errs.join('').includes('一致性校验'), '--version 不符消息在 stderr');
    assert.ok(!outs.join('').includes('市场源不可解') && !outs.join('').includes('一致性校验'), '用法错不落 out');
  } finally {
    process.stderr.write = orig;
    f.clean();
  }
});

// ── 内部任务-276 D10/D9：install 前置守护 ────────────────────────────────────────

test('市场源目录缺失拒绝：清单有条目但 plugins/<p> 目录缺失→退 1 零写（DEV-276 D10）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    rmSync(join(f.market, 'plugins', 'workflow'), { recursive: true, force: true });
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('市场源目录缺失：workflow'), lines.join(''));
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '零写');
  } finally {
    f.clean();
  }
});

test('市场清单 plugins 非数组：install 退 1 零写（DEV-276 D9）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    writeFileSync(join(f.market, 'marketplace.json'), JSON.stringify({ name: 'x', plugins: 'x' }));
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('plugins 非数组'), lines.join(''));
  } finally {
    f.clean();
  }
});

// ── 内部任务-276 D12/D13/D14/D17：install 写面 ───────────────────────────────────

test('同版本重放原子化：内容一致零写跳过（cache 文件 mtime 不变）（DEV-276 D12）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const probe = join(f.z.cacheDir('workflow', '0.2.0'), '.zcode-plugin', 'plugin.json');
    const m1 = statSync(probe).mtimeMs;
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    assert.equal(statSync(probe).mtimeMs, m1, '一致重放零写：活跃目录文件未被重拷');
  } finally {
    f.clean();
  }
});

test('同版本重放原子化：内容漂移交换恢复且无瞬态残留（DEV-276 D12）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    writeFileSync(join(f.z.cacheDir('workflow', '0.2.0'), 'drift.txt'), 'x');
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    assert.ok(!existsSync(join(f.z.cacheDir('workflow', '0.2.0'), 'drift.txt')), '漂移内容被市场源替换');
    const parent = dirname(f.z.cacheDir('workflow', '0.2.0'));
    assert.deepEqual(readdirSync(parent).filter((n) => n.startsWith('.')), [], '无 .replay-staging/.replay-aside 瞬态残留');
    assert.deepEqual(runVerify({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome }).problems, []);
  } finally {
    f.clean();
  }
});

test('同版本重放交换失败回滚：renameFn 注入 EPERM→退 1 且活跃目录字节未变、无瞬态残留（DEV-276 D12）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const dir = f.z.cacheDir('workflow', '0.2.0');
    const before = fingerprintTree(dir);
    writeFileSync(join(dir, 'drift.txt'), 'x'); // 制造漂移，强制进入交换路径
    const after = fingerprintTree(dir);
    const lines = [];
    const eperm = () => { const e = new Error('EPERM: 注入瞬时锁'); e.code = 'EPERM'; throw e; };
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      renameFn: eperm, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('写入失败，已回滚'), lines.join(''));
    assert.deepEqual(fingerprintTree(dir), after, '首次 rename 失败：活跃目录字节未变');
    assert.deepEqual(readdirSync(dirname(dir)).filter((n) => n.includes('.replay-')), [], '无 .replay-* 瞬态残留');
    assert.notDeepEqual(after, before, '（夹具自检）漂移已写入');
  } finally {
    f.clean();
  }
});

test('同版本重放恢复失败：第二/三次 rename 均失败→告警指认旁路且原内容保全（DEV-276 D12）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const dir = f.z.cacheDir('workflow', '0.2.0');
    writeFileSync(join(dir, 'drift.txt'), 'x');
    let n = 0;
    const renameFn = (from, to) => { // 仅首次（dir→aside）放行；staging→dir 与 aside→dir 均失败
      n += 1;
      if (n === 1) { renameSync(from, to); return; }
      const e = new Error('EPERM: 注入恢复失败'); e.code = 'EPERM'; throw e;
    };
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      renameFn, warn: (s) => lines.push(s), out: (s) => lines.push(s) }); // warn 必须一并收集（缺省走 stderr）
    assert.equal(r.code, 1, lines.join(''));
    const aside = join(dirname(dir), '.replay-aside');
    assert.ok(lines.join('').includes('重放恢复失败'), lines.join(''));
    assert.ok(lines.join('').includes('.replay-aside'), '告警指认旁路路径');
    assert.ok(lines.join('').includes('回滚不完整'), '主 catch 分叉「回滚不完整」而非「已回滚」');
    assert.ok(existsSync(join(aside, 'drift.txt')), '原内容完整保全于旁路（含漂移标记文件）');
  } finally {
    f.clean();
  }
});

test('同版本重放交换成功后写后即验失败：退 1、登记表回滚、重放目录仍＝市场源（DEV-276 D12/D14）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const dir = f.z.cacheDir('workflow', '0.2.0');
    writeFileSync(join(dir, 'drift.txt'), 'x');
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      verifyImpl: () => ({ problems: ['注入失配'], faces: [] }), out: () => {} });
    assert.equal(r.code, 1);
    assert.ok(!existsSync(join(dir, 'drift.txt')), '交换已生效：漂移物被市场源内容替换');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '登记表回滚');
    assert.deepEqual(diffTrees(buildExpectTree(join(f.market, 'plugins', 'workflow')), buildExpectTree(dir)).changed, [], '重放目录＝市场源（回滚无需恢复）');
  } finally {
    f.clean();
  }
});

test('客户端状态写前解析：坏 JSON 登记表→退 1 指认文件且零写（DEV-276 D13）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    writeFileSync(f.z.registryPath, '{bad');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('installed_plugins.json'), '指认文件');
    assert.ok(lines.join('').includes('未做任何写入'), lines.join(''));
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), '无 cache 写副作用');
    assert.deepEqual(readdirSync(dirname(f.z.registryPath)).filter((n) => n.includes('.bak-')), [], '无备份写副作用');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), '{bad', '原文件原样');
  } finally {
    f.clean();
  }
});

test('bootstrap known 形态损坏：marketplaces 非数组→退 1 零写（DEV-276 D9）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const km = clientPath(f.z.home, 'knownMarketplaces');
    writeFileSync(km, JSON.stringify({ marketplaces: 'x' }));
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, bootstrap: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('marketplaces 非数组'), lines.join(''));
    assert.equal(readFileSync(km, 'utf8'), JSON.stringify({ marketplaces: 'x' }), '零写');
  } finally {
    f.clean();
  }
});

test('重放旁路存在即拒绝：上次中断遗留 .replay-aside 不被静默删除、且零写副作用（DEV-276 D12/CEO2）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: () => {} }).code, 0);
    const aside = join(dirname(f.z.cacheDir('workflow', '0.2.0')), '.replay-aside');
    writeFile(join(aside, 'precious.txt'), '原内容');
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('未处置的重放旁路目录'), lines.join(''));
    assert.ok(lines.join('').includes('未做任何写入'), '定性为写前拒绝');
    assert.ok(existsSync(join(aside, 'precious.txt')), '旁路内容未被删除');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '登记表零写');
    assert.deepEqual(readdirSync(dirname(f.z.registryPath)).filter((n) => n.includes('.bak-')), [], '无备份写副作用');
  } finally {
    f.clean();
  }
});

test('写中途失败回滚：copyFn 注入失败→退 1、三客户端文件字节一致、新建 cache 目录删除（DEV-276 D14）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    const cfgBefore = readFileSync(f.z.configPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      copyFn: () => { throw new Error('注入拷贝失败'); }, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('写入失败，已回滚'), lines.join(''));
    assert.ok(lines.join('').includes('幂等重建'), '兜底指引含重跑 install 出路');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore);
    assert.equal(readFileSync(f.z.configPath, 'utf8'), cfgBefore);
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), '新建 cache 目录删除');
  } finally {
    f.clean();
  }
});

test('rollback 逐项恢复：单文件回写失败不中止其余恢复且逐项告警（DEV-276 D14）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const regBefore = readFileSync(f.z.registryPath, 'utf8');
    // 快照在此之前完成；用 copyFn 在写入中途把 config 换成同名目录，使「回滚回写 config」抛 EISDIR，
    // 而 registry 仍应被逐项恢复（单一大 try 的旧实现会在此中止、registry 停在被改态）。
    let calls = 0;
    const copyFn = (src, dest) => {
      calls += 1;
      if (calls === 3) {
        rmSync(f.z.configPath, { force: true });
        mkdirSync(f.z.configPath);
        throw new Error('注入拷贝失败');
      }
      copyFiltered(src, dest);
    };
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome,
      copyFn, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('回滚部分失败'), lines.join(''));
    assert.ok(lines.join('').includes(f.z.configPath), '告警指认失败文件');
    assert.equal(readFileSync(f.z.registryPath, 'utf8'), regBefore, '其余文件仍被恢复');
  } finally {
    f.clean();
  }
});

test('cleanupBackups 清理失败告警：不抛、warn 指认路径（DEV-276 D17）', () => {
  const root = tempRoot('dev276-bak');
  try {
    const files = { known: join(root, 'k.json'), registry: join(root, 'r.json'), config: join(root, 'c.json') };
    const bakDir = `${files.registry}.bak-20991231-000000`;
    writeFile(join(bakDir, 'inner.txt'), 'x'); // 同名非空目录：rmSync(force) 抛 EISDIR → 走告警路径
    const warns = [];
    cleanupBackups(files, [bakDir], Date.now(), { warn: (s) => warns.push(s) });
    assert.ok(warns.join('').includes(bakDir) && warns.join('').includes('留存无害'), warns.join(''));
  } finally {
    removeRoot(root);
  }
});

// ── 内部任务-276 D20：覆盖缺口补强（F2 两臂 / 前置拒绝 / F2 读面 arm） ──────────

test('F2 前置闸两臂：版本臂与树漂移臂各退 1 且零写（DEV-276 D20）', () => {
  // 版本臂：六清单统一抬到 0.2.0（过 loadManifests）而市场清单仍 0.1.0
  const a = makeInstallFixture();
  try {
    for (const p of PLUGINS) writePluginPair(a.repo, p, '0.2.0', `${p} 测试（ADR-017）`);
    const regBefore = readFileSync(a.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: a.repo, marketRoot: a.market, zcodeHome: a.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('与市场清单') && lines.join('').includes('不一致'), lines.join(''));
    assert.equal(readFileSync(a.z.registryPath, 'utf8'), regBefore, '零写');
  } finally {
    a.clean();
  }
  // 树漂移臂：版本全对齐、市场树内多一文件
  const b = makeInstallFixture();
  try {
    writeFileSync(join(b.market, 'plugins', 'workflow', 'extra.txt'), 'x');
    const regBefore = readFileSync(b.z.registryPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: b.repo, marketRoot: b.market, zcodeHome: b.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('不新鲜') && lines.join('').includes('多余 1'), lines.join(''));
    assert.equal(readFileSync(b.z.registryPath, 'utf8'), regBefore, '零写');
  } finally {
    b.clean();
  }
});

test('install 前置拒绝三例：坏 JSON / 缺条目 / 版本不统一（DEV-276 D20）', () => {
  const a = makeInstallFixture();
  try {
    writeFileSync(join(a.market, 'marketplace.json'), '{bad');
    const lines = [];
    assert.equal(runInstall({ repoRoot: a.repo, marketRoot: a.market, zcodeHome: a.zhome, out: (s) => lines.push(s) }).code, 1);
    assert.ok(lines.join('').includes('市场清单不可读'), lines.join(''));
  } finally {
    a.clean();
  }
  const b = makeInstallFixture();
  try {
    const mj = readJson(join(b.market, 'marketplace.json'));
    mj.plugins = mj.plugins.slice(0, 3);
    writeFileSync(join(b.market, 'marketplace.json'), `${JSON.stringify(mj, null, 2)}\n`);
    const lines = [];
    assert.equal(runInstall({ repoRoot: b.repo, marketRoot: b.market, zcodeHome: b.zhome, out: (s) => lines.push(s) }).code, 1);
    assert.ok(lines.join('').includes('缺六插件条目'), lines.join(''));
  } finally {
    b.clean();
  }
  const c = makeInstallFixture();
  try {
    const mj = readJson(join(c.market, 'marketplace.json'));
    mj.plugins[0].version = OLD_VERSION;
    writeFileSync(join(c.market, 'marketplace.json'), `${JSON.stringify(mj, null, 2)}\n`);
    const lines = [];
    assert.equal(runInstall({ repoRoot: c.repo, marketRoot: c.market, zcodeHome: c.zhome, out: (s) => lines.push(s) }).code, 1);
    assert.ok(lines.join('').includes('版本不统一'), lines.join(''));
  } finally {
    c.clean();
  }
});

test('F2 闸读面问题臂：市场插件目录被同名文件占用→退 1 含「期望树不可读」（DEV-276 D20/N1）', () => {
  const f = makeInstallFixture();
  try {
    rmSync(join(f.market, 'plugins', 'workflow'), { recursive: true, force: true });
    writeFileSync(join(f.market, 'plugins', 'workflow'), 'x'); // readdirSync 抛 ENOTDIR（跨平台稳定）
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1, lines.join(''));
    assert.ok(lines.join('').includes('期望树不可读'), lines.join(''));
  } finally {
    f.clean();
  }
});

// ── 内部任务-276 覆盖率：缺省注入缝（out/warn）+ 顶层非对象闸 ─────────────────────

test('缺省注入缝：out/warn 不注入时走 process 流且不抛（DEV-276 覆盖率）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    // 缺省 out（默认箭头）＋缺省 warn；缺市场源退 2 走 stderr 默认流
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: '', zcodeHome: f.zhome }).code, 2);
    // 失败路径缺省 out：copyFn 注入失败 → catch 分支用默认 out 打印回滚文案
    assert.equal(runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, copyFn: () => { throw new Error('注入失败'); } }).code, 1);
    // cleanupBackups 缺省 warn：同名非空目录制造失败，默认 stderr 流不抛
    const root = tempRoot('dev276-def');
    try {
      const files = { known: join(root, 'k.json'), registry: join(root, 'r.json'), config: join(root, 'c.json') };
      const bakDir = `${files.registry}.bak-20991231-000000`;
      writeFile(join(bakDir, 'inner.txt'), 'x');
      cleanupBackups(files, [bakDir]);
    } finally {
      removeRoot(root);
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    f.clean();
  }
});

test('客户端状态顶层非对象：数组形态→退 1 零写（DEV-276 D13；DEV-334/OPEN-251② 补零写断言）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    writeFileSync(f.z.configPath, '[]');
    const badConfig = readFileSync(f.z.configPath, 'utf8');
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    assert.ok(lines.join('').includes('顶层非对象'), lines.join(''));
    assert.ok(readdirSync(join(f.zhome, 'cli')).every((n) => !n.includes('.bak-')), '写前拒绝：无 .bak 备份件');
    assert.ok(readdirSync(join(f.zhome, 'cli', 'plugins')).every((n) => !n.includes('.bak-')), '写前拒绝：plugins 目录无 .bak');
    assert.equal(readFileSync(f.z.configPath, 'utf8'), badConfig, '客户端字节不变');
  } finally {
    f.clean();
  }
});

test('形态闸四格：config.plugins / enabledPlugins / registry 条目 / known 条目非对象均零写拒绝（DEV-276 评审 N3；DEV-334/OPEN-251② 补零写断言）', () => {
  // 快照路径集对四格恒同（三客户端文件）——单常量避免逐 case 重复闭包
  const clientFilesOf = (f) => [f.z.configPath, f.z.registryPath, clientPath(f.z.home, 'knownMarketplaces')];
  const cases = [
    { name: 'config.plugins 非对象', write: (f) => writeFileSync(f.z.configPath, JSON.stringify({ plugins: 'x' })), text: 'plugins 非对象' },
    { name: 'enabledPlugins 非对象', write: (f) => writeFileSync(f.z.configPath, JSON.stringify({ plugins: { enabledPlugins: 'x' } })), text: 'enabledPlugins 非对象' },
    { name: 'registry 含非对象条目', write: (f) => writeFileSync(f.z.registryPath, JSON.stringify({ version: 1, plugins: [null] })), text: '含非对象条目' },
    { name: 'known 含非对象条目', write: (f) => writeFileSync(clientPath(f.z.home, 'knownMarketplaces'), JSON.stringify({ marketplaces: [null] })), text: '含非对象条目' },
  ];
  for (const c of cases) {
    const f = makeInstallFixture({ bumpTo: '0.2.0' });
    try {
      c.write(f);
      const before = Object.fromEntries(clientFilesOf(f).map((p) => [p, readFileSync(p, 'utf8')]));
      const lines = [];
      const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, bootstrap: true, out: (s) => lines.push(s) });
      assert.equal(r.code, 1, `${c.name}：${lines.join('')}`);
      assert.ok(lines.join('').includes(c.text), `${c.name}：${lines.join('')}`);
      assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), `${c.name}：无 cache 写副作用`);
      assert.ok(readdirSync(join(f.zhome, 'cli')).every((n) => !n.includes('.bak-')), `${c.name}：无 .bak 备份件（写前拒绝先于备份步）`);
      assert.ok(readdirSync(join(f.zhome, 'cli', 'plugins')).every((n) => !n.includes('.bak-')), `${c.name}：plugins 目录无 .bak`);
      for (const [p, content] of Object.entries(before)) assert.equal(readFileSync(p, 'utf8'), content, `${c.name}：客户端字节不变 ${p}`);
    } finally {
      f.clean();
    }
  }
});

test('客户端状态不可读：同名目录造 EISDIR → 拒绝退 1 且零写（OPEN-251①）', () => {
  const f = makeInstallFixture({ bumpTo: '0.2.0' });
  try {
    const knownPath = clientPath(f.z.home, 'knownMarketplaces');
    const knownBefore = readFileSync(knownPath, 'utf8');
    rmSync(f.z.configPath, { force: true });
    mkdirSync(f.z.configPath); // existsSync 真＋readFileSync EISDIR（bump.test.mjs:286 同款注入，跨平台稳定）
    const lines = [];
    const r = runInstall({ repoRoot: f.repo, marketRoot: f.market, zcodeHome: f.zhome, bootstrap: true, out: (s) => lines.push(s) });
    assert.equal(r.code, 1);
    const text = lines.join('');
    assert.ok(text.includes('客户端状态不可读'), `文案指认：${text}`);
    assert.ok(text.includes('未做任何写入'), `零写声明：${text}`);
    assert.ok(!existsSync(f.z.cacheDir('workflow', '0.2.0')), '零 cache 写');
    assert.equal(readFileSync(knownPath, 'utf8'), knownBefore, 'known 字节不变');
  } finally {
    f.clean();
  }
});
