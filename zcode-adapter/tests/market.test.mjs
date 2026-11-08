// 文件：zcode-adapter/tests/market.test.mjs
// 描述：市场同步与清单 upsert 用例（S2 步骤 5）——断言内容迁自 scripts/tests/release-suite.test.mjs
//       的市场面块（:154 同步刷新 / :179 排除字节码 / :210 版本不一致 / :226 清单缺失 /
//       :257 幂等 / :337 清单不可解析 / :350 字段不全 / :375 损坏先于写副作用），由子进程
//       spawn 形态改为直测 src/market.mjs 单元（夹具形态对齐源 makeFixture：vision-bridge
//       既有条目 + metadata.pluginRoot + description 含 内部决策-017）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadManifests, PLUGINS } from '../src/manifests.mjs';
import { readMarketDoc, refreshMarketManifest, syncPlugins, copyFiltered, cleanupPublishBackups, atomicWriteText, SUITE_DESC_ZH, EN_DESC } from '../src/market.mjs';
import { tempRoot, removeRoot, writeFile, writePluginPair, fingerprintTree } from './helpers.mjs';

/** 同步夹具（对齐源 makeFixture：六插件 0.1.0 + 市场旧清单含 vision-bridge 与 metadata）。 */
function makeSyncFixture() {
  const home = tempRoot('zmarket');
  const repo = join(home, 'repo');
  const market = join(home, 'market');
  for (const p of PLUGINS) {
    writePluginPair(repo, p, '0.1.0', `${p} 测试描述（内部决策-017）`);
    writeFile(join(repo, p, 'skills', 'demo.md'), '# demo\n');
  }
  mkdirSync(join(market, 'plugins'), { recursive: true });
  writeFileSync(join(market, 'marketplace.json'), JSON.stringify({
    name: 'fixture-market',
    description: '旧描述',
    plugins: [{ name: 'vision-bridge', version: '1.2.0', description: '识图', source: './vision-bridge' }],
    metadata: { pluginRoot: 'plugins' },
  }));
  return { home, repo, market, clean: () => removeRoot(home) };
}

/** 完整一轮「读闸 → 同步 → 刷新」（publish 的市场面三步序）。 */
function runMarketRound(repo, market) {
  const loaded = loadManifests(repo);
  if (!loaded.ok) return loaded;
  const doc = readMarketDoc(market);
  if (!doc.ok) return doc;
  syncPlugins(repo, market);
  return refreshMarketManifest(market, doc.doc, loaded.manifests);
}

test('同步与清单刷新：六条目 0.1.0、description 透传、vision-bridge 保留、插件目录落位', () => {
  const f = makeSyncFixture();
  try {
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, true, `应成功：${JSON.stringify(r)}`);
    const mj = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    // 内部任务-5 B：套件定位是公开槽——品牌在场、内部编号已去（旧断言曾锚 内部决策-017，随受众契约改写）
    assert.ok(mj.description.includes('AI Coding 方法论') && !/(ADR-\d+|IF-[A-Z]+-\d+|R-M\d+|B-M\d+|OPEN-\d+)/.test(mj.description), '顶层套件定位');
    const byName = new Map(mj.plugins.map((p) => [p.name, p]));
    for (const p of PLUGINS) {
      assert.equal(byName.get(p)?.version, '0.1.0', `${p} 版本 0.1.0`);
      assert.ok(byName.get(p)?.description.includes('内部决策-017'), `${p} description 由清单透传`);
      assert.ok(byName.get(p)?.description_i18n?.en, `${p} 英译条目`);
      assert.equal(byName.get(p)?.source, `./plugins/${p}`, `${p} source（相对市场根）`);
    }
    assert.equal(byName.get('vision-bridge')?.version, '1.2.0', '既有他插件条目保留');
    assert.equal(mj.metadata?.pluginRoot, 'plugins', 'metadata 不动');
    for (const p of PLUGINS) {
      assert.ok(readFileSync(join(f.market, 'plugins', p, '.zcode-plugin', 'plugin.json'), 'utf8').includes('0.1.0'), `${p} 目录同步`);
    }
  } finally {
    f.clean();
  }
});

test('同步排除 Python 字节码缓存：__pycache__/.pyc/.mimosa 不进副本（源文件与边界锚照常同步）', () => {
  const f = makeSyncFixture();
  try {
    mkdirSync(join(f.repo, 'spec-gate', 'assurance', '__pycache__'), { recursive: true });
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', '__pycache__', 'x.cpython-314.pyc'), 'bytecode');
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', 'loose.pyc'), 'bytecode');
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', 'keep.py'), '# 源文件须照常同步\n');
    mkdirSync(join(f.repo, 'spec-gate', 'assurance', '.mimosa'), { recursive: true });
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', '.mimosa', 'state.json'), '{}');
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', 'legacy__pycache__.bin'), 'not bytecode');
    mkdirSync(join(f.repo, 'spec-gate', 'assurance', '__pycache__2'), { recursive: true });
    writeFileSync(join(f.repo, 'spec-gate', 'assurance', '__pycache__2', 'keep.txt'), 'x');
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    const dst = join(f.market, 'plugins', 'spec-gate', 'assurance');
    assert.ok(!existsSync(join(dst, '__pycache__')), '__pycache__ 不进发行副本（内部任务-PYCLEAN-1）');
    assert.ok(!existsSync(join(dst, 'loose.pyc')), '散落 .pyc 不进发行副本');
    assert.ok(!existsSync(join(dst, '.mimosa')), '.mimosa 不进发行副本（core-baseline 同口径）');
    assert.ok(existsSync(join(dst, 'keep.py')), '源文件照常同步');
    assert.ok(existsSync(join(dst, 'legacy__pycache__.bin')), '含 __pycache__ 字样的非段名文件照常同步（边界锚）');
    assert.ok(existsSync(join(dst, '__pycache__2', 'keep.txt')), '__pycache__2 目录照常同步（段名边界锚）');
  } finally {
    f.clean();
  }
});

test('版本不一致拒绝：一清单 0.2.0 → 拒绝且不动市场', () => {
  const f = makeSyncFixture();
  try {
    writeFileSync(join(f.repo, 'workflow', 'plugin.manifest.json'),
      JSON.stringify({ manifestVersion: 1, name: 'workflow', version: '0.2.0', description: 'x', author: 'wangp' }));
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, false, '版本不一致必须拒绝');
    assert.ok(r.reason.includes('版本不一致'), '失败原因可见');
    assert.ok(!readFileSync(join(f.market, 'marketplace.json'), 'utf8').includes('AI Coding 方法论'), '市场未被改动');
  } finally {
    f.clean();
  }
});

test('清单缺失拒绝：删一清单 → 拒绝且原因可见', () => {
  const f = makeSyncFixture();
  try {
    rmSync(join(f.repo, 'scout', 'plugin.manifest.json'));
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('清单缺失'), '失败原因可见');
  } finally {
    f.clean();
  }
});

test('幂等：连续两轮，marketplace.json 逐字节一致', () => {
  const f = makeSyncFixture();
  try {
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    const first = readFileSync(join(f.market, 'marketplace.json'), 'utf8');
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    assert.equal(readFileSync(join(f.market, 'marketplace.json'), 'utf8'), first, '重复执行结果一致');
  } finally {
    f.clean();
  }
});

test('清单不可解析：坏 JSON → 拒绝且原因可见', () => {
  const f = makeSyncFixture();
  try {
    writeFileSync(join(f.repo, 'spec-gate', 'plugin.manifest.json'), '{bad json');
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('清单不可解析'), '失败原因可见');
  } finally {
    f.clean();
  }
});

test('清单字段不全：缺 version/description → 拒绝且原因可见', () => {
  const f = makeSyncFixture();
  try {
    writeFileSync(join(f.repo, 'spec-gate', 'plugin.manifest.json'),
      JSON.stringify({ manifestVersion: 1, name: 'spec-gate', author: 'wangp' }));
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('清单字段不全'), '失败原因可见');
    // 版本形态（内部任务-238 S9）：三段式以外一律拒（version 会被下游拼入路径）
    writeFileSync(join(f.repo, 'spec-gate', 'plugin.manifest.json'),
      JSON.stringify({ manifestVersion: 1, name: 'spec-gate', version: '../../x', description: 'x', author: 'wangp' }));
    const r2 = runMarketRound(f.repo, f.market);
    assert.equal(r2.ok, false, '非法版本须拒');
    assert.ok(r2.reason.includes('三段式'), `失败原因须指认版本形态：${r2.reason}`);
  } finally {
    f.clean();
  }
});

test('buildEntry 旧条目沿用与缺省（迁自源 selftest :687-690 断言组——S2 门 #2 补承接）', () => {
  const f = makeSyncFixture();
  try {
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    // 预置旧条目：workflow 带 category/keywords 旧值 → 沿用；scout 无旧条目 → 缺省
    const doc = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    const byName = new Map(doc.plugins.map((p) => [p.name, p]));
    assert.equal(byName.get('scout')?.category, 'developer-tools', '无旧条目用缺省 category');
    assert.ok(Array.isArray(byName.get('scout')?.keywords) && byName.get('scout').keywords.includes('探路'), '无旧条目用缺省 keywords');
    assert.equal(byName.get('workflow')?.description_i18n?.['zh-CN'], 'workflow 测试描述（内部决策-017）', 'zh-CN 由清单 description 透传');
    assert.ok(byName.get('workflow')?.description_i18n?.en, '英译条目在位');
    // 再跑一轮预置旧值沿用：给 scout 造旧条目（category/keywords 旧值），重跑后沿用
    doc.plugins.find((p) => p.name === 'scout').category = 'custom-cat';
    doc.plugins.find((p) => p.name === 'scout').keywords = ['旧值'];
    writeFileSync(join(f.market, 'marketplace.json'), `${JSON.stringify(doc, null, 2)}\n`);
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    const doc2 = JSON.parse(readFileSync(join(f.market, 'marketplace.json'), 'utf8'));
    const scout2 = doc2.plugins.find((p) => p.name === 'scout');
    assert.equal(scout2.category, 'custom-cat', '旧 category 沿用');
    assert.deepEqual(scout2.keywords, ['旧值'], '旧 keywords 沿用（非空即不补缺省）');
  } finally {
    f.clean();
  }
});

test('市场清单原子写形态：temp+rename（.suite-tmp）在源码面（迁自旧测试编排健壮性第三项——S2 门 #2 补承接）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'market.mjs'), 'utf8');
  assert.ok(src.includes("'.suite-tmp'"), '原子写后缀 .suite-tmp 在场（中断不留截断 JSON，原评审修复 3.5）');
  assert.ok(src.includes('renameSync'), 'temp+rename 语义在场');
});

// ── B 批（内部任务-5，R-pc-14/内部规则-7）：公开槽零内部编号——市场套件定位与六条目英译是
// 面向普通使用者的公开选择说明，不得以 ADR/IF/R-M/B-M/OPEN 等内部开发编号代替解释。 ──
test('B：SUITE_DESC_ZH 与 EN_DESC 六条目零内部编号，且含套件品牌（公开槽受众纪律）', () => {
  const ID_RE = /(ADR-\d+|IF-[A-Z]+-\d+|R-M\d+|B-M\d+|OPEN-\d+)/;
  assert.ok(!ID_RE.test(SUITE_DESC_ZH), `套件中文定位不得含内部编号（实得：${SUITE_DESC_ZH}）`);
  assert.ok(SUITE_DESC_ZH.includes('AI Coding 方法论'), '套件定位须含套件品牌（zh）');
  assert.deepEqual([...Object.keys(EN_DESC)].sort(), [...PLUGINS].sort(), 'EN_DESC 须恰覆盖六插件');
  for (const [name, text] of Object.entries(EN_DESC)) {
    assert.equal(typeof text, 'string', `${name} 英译须为字符串`);
    assert.ok(!ID_RE.test(text), `${name} 英译不得含内部编号（实得：${text}）`);
    assert.ok(text.includes('AI Coding Methodology'), `${name} 英译须含套件品牌（en）`);
  }
});

// ── Windows 瞬时锁重试（内部任务-RELEASE-058 根因修复：发布验证集两次栽在 EPERM rename）────
// 现象：install bootstrap 写 known_marketplaces.json 时 `EPERM: rename ... .zinstall-tmp`，
// 装机整体回滚、发布验证集红。根因：atomicWriteText 单发 rename，Windows 上目标文件被
// 瞬时占用（AV/索引器/宿主并发读配置）即抛错，无重试。修法＝仅对可重试 errno 做有限次
// 退避重试，真实失败照旧抛出（install 的回滚语义不变）。
test('原子写：rename 遇瞬时 EPERM/EBUSY/EACCES 有限重试后成功（非重试错误直抛）', () => {
  const root = tempRoot('zatomic');
  const target = join(root, 'client.json');
  writeFileSync(target, '旧内容\n');
  let calls = 0;
  const flaky = (from, to) => {
    calls += 1;
    if (calls <= 2) {
      const e = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
      e.code = 'EPERM';
      throw e;
    }
    renameSync(from, to);
  };
  atomicWriteText(target, '新内容\n', '.ztmp', flaky);
  assert.equal(readFileSync(target, 'utf8'), '新内容\n', '重试成功后目标为新内容');
  assert.equal(calls, 3, `rename 实调 3 次（前两次 EPERM + 一次成功），实际 ${calls}`);
  assert.ok(!existsSync(`${target}.ztmp`), '成功后不留 tmp 残留');
  removeRoot(root);
});

test('原子写：非重试 errno（如 ENOSPC）直抛不重试，且清 tmp 残留', () => {
  const root = tempRoot('zatomic');
  const target = join(root, 'client.json');
  writeFileSync(target, '旧内容\n');
  let calls = 0;
  const hardFail = () => {
    calls += 1;
    const e = new Error('ENOSPC: no space left on device');
    e.code = 'ENOSPC';
    throw e;
  };
  assert.throws(() => atomicWriteText(target, '新内容\n', '.ztmp', hardFail), /ENOSPC/);
  assert.equal(calls, 1, `非重试错误只调 1 次，实际 ${calls}`);
  assert.ok(!existsSync(`${target}.ztmp`), '失败后 tmp 残留已清（不留半截文件）');
  assert.equal(readFileSync(target, 'utf8'), '旧内容\n', '目标保持原内容（未截断）');
  removeRoot(root);
});

test('原子写：持续 EPERM 达重试上限后抛出（不静默假绿，装机回滚语义保留）', () => {
  const root = tempRoot('zatomic');
  const target = join(root, 'client.json');
  writeFileSync(target, '旧内容\n');
  let calls = 0;
  const alwaysLock = () => {
    calls += 1;
    const e = new Error(`EPERM: rename 一直失败 #${calls}`);
    e.code = 'EPERM';
    throw e;
  };
  assert.throws(() => atomicWriteText(target, '新内容\n', '.ztmp', alwaysLock), /EPERM/);
  assert.ok(calls >= 2, `瞬时锁须至少重试一次，实际调用 ${calls} 次`);
  assert.ok(calls <= 8, `重试次数须有上限（不得无限重试），实际 ${calls} 次`);
  assert.ok(!existsSync(`${target}.ztmp`), '最终失败后 tmp 残留已清');
  assert.equal(readFileSync(target, 'utf8'), '旧内容\n', '目标保持原内容');
  removeRoot(root);
});

test('市场清单损坏先于写副作用：读闸失败 → 拒绝且 plugins 目录未落任何新插件', () => {
  const f = makeSyncFixture();
  try {
    writeFileSync(join(f.market, 'marketplace.json'), '{broken');
    const r = runMarketRound(f.repo, f.market);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('市场清单不可读'), '失败原因可见');
    for (const p of PLUGINS) {
      assert.ok(!existsSync(join(f.market, 'plugins', p)), `${p} 未被同步（读闸先于写副作用）`);
    }
  } finally {
    f.clean();
  }
});

test('syncPlugins 失败回滚：市场恢复字节一致（备份 rename 回＋新建目录删除）〔内部任务-275/内部未决-163〕', () => {
  const f = makeSyncFixture();
  try {
    assert.equal(runMarketRound(f.repo, f.market).ok, true, '先建立既有市场目录（备份面）');
    const before = fingerprintTree(join(f.market, 'plugins'));
    const copyFn = (src, dest) => {
      if (dest.endsWith(join('plugins', 'scout'))) throw new Error('注入：copy 失败（copyFn 注入缝）');
      copyFiltered(src, dest);
    };
    assert.throws(() => syncPlugins(f.repo, f.market, { copyFn }), /注入：copy 失败/, '注入失败须上抛（函数层；CLI 面由 runPublish 收为退 1，见 publish.test）');
    assert.equal(fingerprintTree(join(f.market, 'plugins')), before, '市场恢复同步前字节状态（R-za-9 失败零净写）');
    assert.ok(!existsSync(join(f.market, '.publish-backups')), '回滚后备份目录清空');
  } finally {
    f.clean();
  }
});

test('syncPlugins 写后自检：落位后损坏检出且回滚〔内部任务-275/内部未决-163〕', () => {
  const f = makeSyncFixture();
  try {
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    const before = fingerprintTree(join(f.market, 'plugins'));
    const copyFn = (src, dest) => {
      copyFiltered(src, dest);
      // 模拟「拷贝完成但内容损坏/被并发改写」：最后插件目录混入计划外文件 → 树哈希失配
      if (dest.endsWith(join('plugins', 'research-loop'))) writeFileSync(join(dest, 'TAMPER.txt'), '篡改');
    };
    assert.throws(() => syncPlugins(f.repo, f.market, { copyFn }), /写后自检失配：research-loop/, '自检须指认插件');
    assert.equal(fingerprintTree(join(f.market, 'plugins')), before, '自检失败后市场恢复同步前状态');
  } finally {
    f.clean();
  }
});

test('syncPlugins 写后自检不可读：目标目录被同名文件替换 → problem 优先于哈希比对且回滚（内部未决-249）', () => {
  const f = makeSyncFixture();
  try {
    assert.equal(runMarketRound(f.repo, f.market).ok, true);
    const before = fingerprintTree(join(f.market, 'plugins'));
    const copyFn = (src, dest) => {
      copyFiltered(src, dest);
      // 模拟「拷完后 dest 被替换为同名文件」：readdirSync 抛 ENOTDIR → tryBuildExpectTree 折叠为 problem
      if (dest.endsWith(join('plugins', 'research-loop'))) {
        rmSync(dest, { recursive: true, force: true });
        writeFileSync(dest, 'x');
      }
    };
    assert.throws(() => syncPlugins(f.repo, f.market, { copyFn }), /写后自检不可读：research-loop/, '折叠族文案须指认插件与不可读性');
    assert.equal(fingerprintTree(join(f.market, 'plugins')), before, '不可读拒绝后市场恢复同步前状态（R-za-9 失败零净写）');
  } finally {
    f.clean();
  }
});

test('备份超龄清理：31 天前备份目录被清、29 天前保留（install .bak 超龄先例同款，round1 S2）〔内部任务-275〕', () => {
  const f = makeSyncFixture();
  try {
    const root = join(f.market, '.publish-backups');
    const old31 = join(root, '20000101000000-1');
    const old29 = join(root, '20000102000000-1');
    mkdirSync(old31, { recursive: true });
    mkdirSync(old29, { recursive: true });
    const dayMs = 24 * 60 * 60 * 1000;
    utimesSync(old31, new Date(Date.now() - 31 * dayMs), new Date(Date.now() - 31 * dayMs));
    utimesSync(old29, new Date(Date.now() - 29 * dayMs), new Date(Date.now() - 29 * dayMs));
    cleanupPublishBackups(f.market, '');
    assert.ok(!existsSync(old31), '31 天前备份被清');
    assert.ok(existsSync(old29), '29 天前备份保留（未超 30 天）');
  } finally {
    f.clean();
  }
});
