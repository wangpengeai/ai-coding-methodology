// 文件：zcode-adapter/tests/verify.test.mjs
// 描述：verify 七面核对用例（S1）——F1 期望树 / F2 市场源 / F3 派生镜像 / F4 cache /
//       F5 登记表双读 / F6 启用 / F7 市场注册面，退出码 0/1/2，以及树哈希金样（锁与 assurance
//       probes.mjs treeHash 的编帧互证口径——金样先于 Node 实现从历史 Python 参考实现采集，2026-09-30）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExpectTree, sha256OfBuffer, treeHash, IGNORED } from '../src/expect-tree.mjs';
import { runVerify } from '../src/verify.mjs';
import { resolveMarketRoot, normalizePathTail } from '../src/client-state.mjs';
import { main } from '../cli.mjs';
import { MARKET, VERSION, makeRepo, makeMarket, makeZcodeHome, removeRoot, readJson, tempRoot, writeFile } from './helpers.mjs';

/** stdout/stderr 捕获助手（verify.test 无既有捕获面；仿 cli-main.test.mjs:17-32 的 run()）。 */
function runMain(argv) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = main(argv);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { code, out: out.join(''), err: err.join('') };
}

/** 树哈希金样（历史 Python 参考实现于固定夹具实测，2026-09-30；JS probes.mjs treeHash 同构）。 */
const GOLDEN_TREE_HASH = 'f69c30ec7964327ebb08e418a1476641e207961557bb1635af55ccd89ff89d55';

/** 建金样固定夹具（与采集时同内容：a.txt='hello\n'、sub/b.json='{"x":1}'）。 */
function goldenFixture() {
  const d = join(tmpdir(), `zcode-golden-node-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'sub'), { recursive: true });
  writeFileSync(join(d, 'a.txt'), 'hello\n');
  writeFileSync(join(d, 'sub', 'b.json'), '{"x":1}');
  return d;
}

/** 全绿三件套夹具（repo + market + zhome），返回 verify 输入与清理句柄。 */
function freshWorld() {
  const { repo } = makeRepo();
  const { market } = makeMarket(repo);
  const zhome = makeZcodeHome(market);
  return { repo, market, zhome, clean: () => { removeRoot(repo); removeRoot(market); removeRoot(zhome.home); } };
}

/** 取指定面的结果。 */
function faceOf(report, id) {
  return report.faces.find((f) => f.face === id);
}

test('IGNORED：三形态污染物命中、正常资产不命中', () => {
  assert.equal(IGNORED('__pycache__/demo.cpython-314.pyc'), true);
  assert.equal(IGNORED('a/.mimosa/scan.json'), true);
  assert.equal(IGNORED('stray.pyc'), true);
  assert.equal(IGNORED('skills/demo/SKILL.md'), false);
  assert.equal(IGNORED('.zcode-plugin/plugin.json'), false);
});

test('F1：期望树排除污染物且含正常资产', () => {
  const w = freshWorld();
  try {
    const rels = buildExpectTree(join(w.repo, 'workflow')).map((e) => e.rel);
    assert.ok(rels.includes('.zcode-plugin/plugin.json'));
    assert.ok(rels.includes('hooks/hooks.json'));
    assert.ok(rels.includes('skills/demo/SKILL.md'));
    assert.ok(rels.every((r) => !IGNORED(r)), '期望树不得含污染物');
  } finally {
    w.clean();
  }
});

test('金样：treeHash 与 assurance probes.mjs treeHash 同构（编帧口径锁定）', () => {
  const d = goldenFixture();
  try {
    assert.equal(treeHash(d), GOLDEN_TREE_HASH);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('七面全绿基线：全新夹具 runVerify 全 ok、problems 空', () => {
  const w = freshWorld();
  try {
    const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    assert.deepEqual(report.problems, []);
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']) {
      assert.equal(faceOf(report, id).ok, true, `${id} 应 ok`);
    }
    // 尾双分隔符 installPath 在基线内即被容忍（F5 归一侧）
    assert.equal(faceOf(report, 'F5').problems.length, 0);
  } finally {
    w.clean();
  }
});

test('F7 市场注册面：未注册／指向旧路径／一致三态', () => {
  const w = freshWorld();
  try {
    // 一致态：makeZcodeHome 注册 directory 源指向 w.market（同一真实路径）→ F7 ok
    let report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    assert.equal(faceOf(report, 'F7').ok, true, '注册一致态应 ok');
    // 未注册：known_marketplaces 清空 MARKET_ID 条目 → F7 红（missing＝内部未决-154 假绿场景）
    const known = join(w.zhome.home, 'cli', 'plugins', 'known_marketplaces.json');
    writeFileSync(known, `${JSON.stringify({ version: 1, marketplaces: [] }, null, 2)}\n`);
    report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    const f7 = faceOf(report, 'F7');
    assert.equal(f7.ok, false);
    assert.ok(f7.problems.some((s) => s.includes('未注册')), `应报未注册：${JSON.stringify(f7.problems)}`);
    assert.ok(report.problems.some((s) => s.startsWith('F7：')), 'F7 问题应计入汇总（verify CLI 口径）');
    // 指向旧路径：注册指向另一 tmp 目录 → F7 红（stale）
    const staleDir = join(tmpdir(), `zcode-f7-stale-${process.pid}`);
    rmSync(staleDir, { recursive: true, force: true });
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(known, `${JSON.stringify({ version: 1, marketplaces: [
      { id: MARKET, name: MARKET, description: '旧路径', source: { source: 'directory', path: staleDir } },
    ] }, null, 2)}\n`);
    report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    const f7b = faceOf(report, 'F7');
    assert.equal(f7b.ok, false);
    assert.ok(f7b.problems.some((s) => s.includes('不一致')), `应报注册指向不一致：${JSON.stringify(f7b.problems)}`);
    rmSync(staleDir, { recursive: true, force: true });
    // 悬挂注册（round1 C2）：注册指向已删除路径（市场迁移后旧目录已删）→ 仍判 stale，不得放行为 registered
    report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    assert.equal(faceOf(report, 'F7').ok, false, '注册路径不存在时 F7 须红（悬挂注册假绿主场景）');
  } finally {
    w.clean();
  }
});

test('F7 豁免：registrationFace=false 时 face 仍报但问题不计入（install 写后即验口径）', () => {
  const w = freshWorld();
  try {
    const known = join(w.zhome.home, 'cli', 'plugins', 'known_marketplaces.json');
    writeFileSync(known, `${JSON.stringify({ version: 1, marketplaces: [] }, null, 2)}\n`);
    const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home, registrationFace: false });
    assert.equal(faceOf(report, 'F7').ok, false, 'face 应仍呈红（报告面）');
    assert.ok(report.problems.every((s) => !s.startsWith('F7：')), 'F7 问题不得计入 problems（豁免口径）');
    // 其余六面不受豁免影响
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) assert.equal(faceOf(report, id).ok, true, `${id} 应保持 ok`);
  } finally {
    w.clean();
  }
});

test('F2：市场源三分类（变更/缺失/多余）', () => {
  const w = freshWorld();
  try {
    const p = join(w.market, 'plugins', 'workflow', 'hooks', 'hooks.json');
    writeFileSync(p, '{"hooks":{"x":1}}\n');
    rmSync(join(w.market, 'plugins', 'workflow', 'skills', 'demo', 'SKILL.md'));
    writeFile(join(w.market, 'plugins', 'workflow', 'EXTRA.md'), '多余');
    const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
    const f = faceOf(report, 'F2');
    assert.equal(f.ok, false);
    assert.ok(f.changed.some((r) => r.includes('hooks.json')));
    assert.ok(f.missing.some((r) => r.includes('SKILL.md')));
    assert.ok(f.extra.some((r) => r.includes('EXTRA.md')));
  } finally {
    w.clean();
  }
});

test('F2：市场清单条目版本与 repo 清单失配即红', () => {
  const w = freshWorld();
  try {
    const m = readJson(join(w.market, 'marketplace.json'));
    m.plugins.find((e) => e.name === 'workflow').version = '9.9.9';
    writeFileSync(join(w.market, 'marketplace.json'), `${JSON.stringify(m, null, 2)}\n`);
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F2');
    assert.equal(f.ok, false);
    assert.ok(f.problems.some((s) => s.includes('workflow') && s.includes('9.9.9')));
  } finally {
    w.clean();
  }
});

test('F3：派生镜像清单与插件树漂移即红', () => {
  const w = freshWorld();
  try {
    writeFileSync(join(w.zhome.mirrorRoot, 'marketplace.json'), '{"name":"x"}\n');
    writeFileSync(join(w.zhome.mirrorRoot, 'plugins', 'scout', 'hooks', 'hooks.json'), '{}\n');
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F3');
    assert.equal(f.ok, false);
    assert.ok(f.problems.some((s) => s.includes('marketplace.json')));
    assert.ok(f.changed.some((r) => r.includes('hooks.json')));
  } finally {
    w.clean();
  }
});

test('F4：登记版本的 cache 目录缺失即红', () => {
  const w = freshWorld();
  try {
    rmSync(w.zhome.cacheDir('workflow', VERSION), { recursive: true, force: true });
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F4');
    assert.equal(f.ok, false);
    assert.ok(f.missing.some((r) => r.includes('workflow')));
    // 旧版本目录删除不属于 F4 断言面（旧目录保留语义归 install 语义测试）
  } finally {
    w.clean();
  }
});

test('F5：登记表版本失配即红', () => {
  const w = freshWorld();
  try {
    const reg = readJson(w.zhome.registryPath);
    reg.plugins.find((e) => e.name === 'workflow').version = '0.2.0';
    writeFileSync(w.zhome.registryPath, `${JSON.stringify(reg, null, 2)}\n`);
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F5');
    assert.equal(f.ok, false);
    assert.ok(f.problems.some((s) => s.includes('workflow')));
  } finally {
    w.clean();
  }
});

test('F5：installPath 指向目录的清单版本与登记不符（双读）即红', () => {
  const w = freshWorld();
  try {
    const m = readJson(join(w.zhome.cacheDir('workflow', VERSION), '.zcode-plugin', 'plugin.json'));
    m.version = '0.0.8';
    writeFileSync(join(w.zhome.cacheDir('workflow', VERSION), '.zcode-plugin', 'plugin.json'), `${JSON.stringify(m, null, 2)}\n`);
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F5');
    assert.equal(f.ok, false);
    assert.ok(f.problems.some((s) => s.includes('workflow') && s.includes('0.0.8')));
  } finally {
    w.clean();
  }
});

test('F5：尾双分隔符与单分隔符 installPath 均被归一容忍', () => {
  assert.equal(normalizePathTail(`a\\b\\0.1.0\\\\`), 'a\\b\\0.1.0');
  assert.equal(normalizePathTail('a/b/0.1.0/'), 'a/b/0.1.0');
});

test('F6：enabledPlugins 缺条目即红', () => {
  const w = freshWorld();
  try {
    const cfg = readJson(w.zhome.configPath);
    delete cfg.plugins.enabledPlugins[`scout@${MARKET}`];
    writeFileSync(w.zhome.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    const f = faceOf(runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }), 'F6');
    assert.equal(f.ok, false);
    assert.ok(f.problems.some((s) => s.includes('scout')));
  } finally {
    w.clean();
  }
});

test('退出码：干净 0 / 漂移 1 / 市场不可解 2', () => {
  const w = freshWorld();
  try {
    const args = ['verify', '--zcode-home', w.zhome.home, '--marketplace', w.market];
    assert.equal(main([...args, '--repo-root', w.repo]), 0);
    writeFileSync(join(w.market, 'plugins', 'scout', 'hooks', 'hooks.json'), '{}\n');
    assert.equal(main([...args, '--repo-root', w.repo]), 1);
    // 市场不可解：清空 known_marketplaces 且不给 --marketplace
    writeFileSync(join(w.zhome.home, 'cli', 'plugins', 'known_marketplaces.json'), '{"version":1,"marketplaces":[]}\n');
    assert.equal(main(['verify', '--zcode-home', w.zhome.home, '--repo-root', w.repo]), 2);
  } finally {
    w.clean();
  }
});

test('resolveMarketRoot：只认 directory 源并按市场名过滤（url 诱饵不命中）', () => {
  const w = freshWorld();
  try {
    assert.equal(resolveMarketRoot(w.zhome.home, ''), w.market);
  } finally {
    w.clean();
  }
});

// ── 内部任务-276 D4/D5：读面守护族 ──────────────────────────────────────────────

test('symlink 三形态：目录链接跳过/文件链接按目标哈希/悬挂链接不产条目不抛（DEV-276 D4）', (t) => {
  const root = tempRoot('dev276-symlink');
  try {
    writeFile(join(root, 'real', 'a.txt'), 'A');
    writeFile(join(root, 'target.txt'), 'T');
    try {
      symlinkSync(join(root, 'real'), join(root, 'dirlink'), 'dir');
      symlinkSync(join(root, 'target.txt'), join(root, 'filelink.txt'), 'file');
      symlinkSync(join(root, 'no-such'), join(root, 'dangling'), 'file');
    } catch (e) {
      if (e.code === 'EPERM') { t.skip('win32 无符号链接特权'); return; }
      throw e;
    }
    const tree = buildExpectTree(root);
    const rels = tree.map((e) => e.rel);
    assert.ok(!rels.some((r) => r.startsWith('dirlink')), '目录链接整棵跳过');
    assert.equal(tree.find((e) => e.rel === 'filelink.txt')?.sha256, sha256OfBuffer('T'), '文件链接按目标内容哈希');
    assert.ok(!rels.includes('dangling'), '悬挂链接不产条目且不抛');
  } finally {
    removeRoot(root);
  }
});

test('期望树读面失败折叠：市场插件目录被同名文件占用→F2 面红、七面报告完整（DEV-276 D4）', () => {
  const w = freshWorld();
  try {
    rmSync(join(w.market, 'plugins', 'workflow'), { recursive: true, force: true });
    writeFileSync(join(w.market, 'plugins', 'workflow'), 'x'); // readdirSync 抛 ENOTDIR，跨平台稳定
    const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }); // 不得抛
    assert.equal(report.faces.length, 7, '七面报告完整');
    const f2 = report.faces.find((x) => x.face === 'F2');
    assert.equal(f2.ok, false);
    assert.ok(f2.problems.some((p) => p.includes('期望树不可读')), f2.problems.join('\n'));
  } finally {
    w.clean();
  }
});

test('F3 镜像清单不可读：镜像 marketplace.json 被同名目录占用→F3 面红（DEV-276 D5）', () => {
  const w = freshWorld();
  try {
    rmSync(join(w.zhome.mirrorRoot, 'marketplace.json'), { force: true });
    mkdirSync(join(w.zhome.mirrorRoot, 'marketplace.json')); // readFileSync 抛 EISDIR，跨平台稳定
    const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home }); // 不得抛
    const f3 = report.faces.find((x) => x.face === 'F3');
    assert.equal(f3.ok, false);
    assert.ok(f3.problems.some((p) => p.includes('镜像清单不可读')), f3.problems.join('\n'));
  } finally {
    w.clean();
  }
});

test('IGNORED：.publish-backups 段命中（DEV-276 D20）', () => {
  assert.equal(IGNORED('.publish-backups/20261101000000-1/workflow'), true);
});

// ── 内部任务-276 D20：verify 负分支与 --json 输出面 ─────────────────────────────

test('verify 负分支四例：F1 目录缺失/F1 清单不可读/F2 清单不可读/F3 镜像插件目录缺失（DEV-276 D20）', () => {
  const cases = [
    { name: 'F1 仓库源目录缺失', face: 'F1', text: '仓库源目录缺失', break: (w) => rmSync(join(w.repo, 'workflow'), { recursive: true, force: true }) },
    { name: 'F1 仓库清单不可读', face: 'F1', text: '仓库清单不可读', break: (w) => writeFileSync(join(w.repo, 'workflow', '.zcode-plugin', 'plugin.json'), '{bad') },
    { name: 'F2 市场清单不可读', face: 'F2', text: '市场清单不可读', break: (w) => writeFileSync(join(w.market, 'marketplace.json'), '{bad') },
    { name: 'F3 镜像插件目录缺失', face: 'F3', text: '镜像插件目录缺失', break: (w) => rmSync(join(w.zhome.mirrorRoot, 'plugins', 'workflow'), { recursive: true, force: true }) },
  ];
  for (const c of cases) {
    const w = freshWorld();
    try {
      c.break(w);
      const report = runVerify({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home });
      const face = report.faces.find((x) => x.face === c.face);
      assert.equal(face.ok, false, `${c.name}：${c.face} 应红`);
      assert.ok(face.problems.some((p) => p.includes(c.text)), `${c.name}：${face.problems.join('\n')}`);
      assert.ok(report.problems.length > 0, `${c.name}：problems 计入`);
    } finally {
      w.clean();
    }
  }
});

test('verify --json 输出面：全绿夹具退 0 且 JSON 含七面与探测键（DEV-276 D20）', () => {
  const w = freshWorld();
  try {
    const r = runMain(['verify', '--repo-root', w.repo, '--zcode-home', w.zhome.home, '--marketplace', w.market, '--json']);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    const doc = JSON.parse(r.out);
    assert.equal(doc.faces.length, 7, '七面');
    assert.ok('hookInterpreter' in doc, '含 hookInterpreter');
    assert.ok('hostApp' in doc, '含 hostApp');
  } finally {
    w.clean();
  }
});
