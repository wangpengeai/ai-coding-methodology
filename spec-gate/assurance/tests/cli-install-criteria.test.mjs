// 文件：cli-install-criteria.test.mjs
// 描述：install-criteria.mjs 永久单测（内部任务-92 阶段3a W2；对齐 test_cli.py 的
//       CliInstallCriteriaTest 19 方法逐方法移植＋2 条 dsh 新增用例〔内部任务-188/内部决策-054 G-05〕）——zcode 注册表 source 双形态受理
//       （./plugins/<名> 与 ./<名>、pluginRoot 元数据覆盖）、反斜杠/空段/.. 拒绝、
//       每插件 5 条判据＋全局镜像清单哈希、--host zcode 尾附在位判据、kimi installed.json
//       enabled 双读＋managed 目录、mcode 六包目录、dsh 仅在位判据（恰 1 条＋与 marketplace
//       互斥）、路径双基/相对路径基准、stdout 纯 JSON
//       与 stderr 收口指引。夹具全部 tmp，不触碰真机市场/注册表。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { sha256File } from '../common.mjs';
import { DEFAULT_IGNORE, treeHash } from '../probes.mjs';
import {
  cleanup, installArgs, makeCliProject, makeMarketFixture, readJson,
  rewriteRegistry, runCli, tmpRoot,
} from './cli-fixtures.mjs';

function jsonOf(r) {
  return JSON.parse(r.stdout);
}

const SUITE = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

describe('CliInstallCriteriaTest', () => {
  let tmp; let proj; let fx;
  beforeEach(() => {
    tmp = tmpRoot('dev92-cli-crit-');
    ({ proj } = makeCliProject(tmp));
    fx = makeMarketFixture(tmp);
  });
  afterEach(() => cleanup(tmp));

  function args(extra = []) {
    return installArgs(fx, extra);
  }

  test('test_install_criteria_exit_0', () => {
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    assert.equal(criteria.length, 6);
    assert.ok([...new Set(criteria.map((c) => c.probe.field).filter(Boolean))].includes('plugins[0].version'));
    const expect = treeHash(join(fx.market, 'plugins', 'workflow'), [...DEFAULT_IGNORE]);
    const hashes = criteria.filter((c) => c.probe.type === 'dir-tree-hash').map((c) => c.probe.expect);
    assert.deepEqual(hashes, [expect, expect]);
    const manifestProbes = criteria.filter((c) => (c.probe.path?.rel ?? '').includes('marketplace.json')
      && c.probe.field === 'plugins[0].version');
    assert.equal(manifestProbes.length, 1);
    assert.equal(manifestProbes[0].probe.expect, '0.3.11');
    const mirrorHashProbe = criteria.filter((c) => c.probe.type === 'file-sha256');
    assert.equal(mirrorHashProbe.length, 1);
    assert.equal(mirrorHashProbe[0].probe.expect, sha256File(join(fx.market, 'marketplace.json')));
    assert.ok(criteria.every((c) => c.evidenceRef === '.sdd/evidence/x.md#验证判据'));
    assert.ok(r.stderr.includes('【收口指引】'), 'stderr 收口指引（stdout 保持纯 JSON）');
  });

  test('test_install_criteria_missing_registry_exit_2', () => {
    const argv = args();
    argv[argv.indexOf('--registry') + 1] = join(fx.home, 'nope.json');
    const r = runCli(proj, argv);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('注册表'));
  });

  test('test_install_criteria_stale_manifest_entry_exit_2', () => {
    writeFileSync(join(fx.market, 'marketplace.json'),
      JSON.stringify({ name: fx.marketName, plugins: [] }), 'utf8');
    const r = runCli(proj, args());
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('市场清单无'));
  });

  test('test_install_criteria_default_no_presence_without_host', () => {
    const criteria = jsonOf(runCli(proj, args()));
    assert.equal(criteria.length, 6);
    assert.ok(!criteria.some((c) => c.probe.type === 'host-app-present'));
  });

  test('test_install_criteria_host_zcode_appends_presence', () => {
    const criteria = jsonOf(runCli(proj, args(['--host', 'zcode'])));
    assert.equal(criteria.length, 7);
    const hp = criteria.filter((c) => c.probe.type === 'host-app-present');
    assert.equal(hp.length, 1);
    assert.deepEqual(hp[0].probe.expect, { host: 'zcode', presence: 'present' });
    assert.equal(hp[0].evidenceRef, '.sdd/evidence/x.md#验证判据');
  });

  test('test_install_criteria_host_kimi', () => {
    const kimiHome = join(fx.home, '.kimi-code');
    const managed = join(kimiHome, 'plugins', 'managed');
    for (const plugin of SUITE) mkdirSync(join(managed, plugin), { recursive: true });
    writeFileSync(join(kimiHome, 'plugins', 'installed.json'), JSON.stringify({
      version: 1,
      plugins: SUITE.map((plugin) => ({
        id: plugin, root: join(managed, plugin), source: 'local-dir', enabled: true,
      })),
    }), 'utf8');
    const r = runCli(proj, [
      'install-criteria', '--host', 'kimi', '--home', fx.home,
      '--record-ref', '.sdd/evidence/x.md#验证判据',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    const types = criteria.map((c) => c.probe.type);
    assert.equal(types.filter((t) => t === 'host-app-present').length, 1);
    assert.equal(types.filter((t) => t === 'json-field-eq').length, 6);
    assert.equal(types.filter((t) => t === 'file-exists').length, 6);
    const jf = criteria.filter((c) => c.probe.type === 'json-field-eq');
    assert.ok(jf.every((c) => c.probe.expect === true), 'enabled 断言 expect=true');
    assert.ok(jf.every((c) => c.probe.field.endsWith('enabled')));
    assert.ok(jf.every((c) => c.probe.path.rel.includes('installed.json')));
  });

  test('test_install_criteria_host_mcode_without_registry_face', () => {
    for (const plugin of SUITE) mkdirSync(join(fx.home, '.minimax', 'plugins', plugin), { recursive: true });
    const r = runCli(proj, [
      'install-criteria', '--host', 'mcode', '--home', fx.home, '--record-ref', '.sdd/evidence/x.md#验证判据',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const types = jsonOf(r).map((c) => c.probe.type);
    assert.equal(types.filter((t) => t === 'host-app-present').length, 1);
    assert.equal(types.filter((t) => t === 'file-exists').length, 6);
    assert.equal(types.filter((t) => t === 'json-field-eq').length, 0);
  });

  test('test_install_criteria_host_kimi_rejects_marketplace', () => {
    const r = runCli(proj, [
      'install-criteria', '--host', 'kimi', '--marketplace', fx.market,
      '--home', fx.home, '--record-ref', 'x#y',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('互斥'));
  });

  test('test_install_criteria_host_dsh_presence_only', () => {
    // 第四宿主（内部决策-054 G-05）：DSH 无 managed 静态装机面，恰 1 条 host-app-present 在位判据
    const r = runCli(proj, [
      'install-criteria', '--host', 'dsh', '--home', fx.home, '--record-ref', '.sdd/evidence/x.md#验证判据',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].probe.type, 'host-app-present');
    assert.equal(criteria[0].probe.expect.host, 'dsh');
    assert.equal(criteria[0].probe.expect.presence, 'present');
    assert.equal(criteria[0].evidenceRef, '.sdd/evidence/x.md#验证判据');
  });

  test('test_install_criteria_host_dsh_rejects_marketplace', () => {
    const r = runCli(proj, [
      'install-criteria', '--host', 'dsh', '--marketplace', fx.market,
      '--home', fx.home, '--record-ref', 'x#y',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('互斥'));
  });

  test('test_install_criteria_host_kimi_missing_installed_json_exit_2', () => {
    const r = runCli(proj, [
      'install-criteria', '--host', 'kimi', '--home', fx.home, '--record-ref', 'x#y',
    ]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('installed.json'));
  });

  test('test_install_criteria_relative_registry_under_project_root', () => {
    writeFileSync(join(proj, 'registry.json'), JSON.stringify(readJson(fx.registry)), 'utf8');
    const argv = args();
    argv[argv.indexOf('--registry') + 1] = 'registry.json';
    const r = runCli(proj, argv);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).length, 6);
  });

  test('test_install_criteria_bad_registry_shape_exit_2', () => {
    writeFileSync(fx.registry, '[]', 'utf8');
    const r = runCli(proj, args());
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('顶层必须是对象'));
  });

  test('test_install_criteria_skips_other_marketplace_entries', () => {
    rewriteRegistry(fx, (d) => {
      d.plugins.push({
        id: 'frontend-design@claude-plugins-official',
        name: 'frontend-design',
        marketplace: 'claude-plugins-official',
        version: '0.0.0',
        installPath: join(fx.home, 'nowhere'),
        source: './plugins/frontend-design',
      });
    });
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).length, 6);
  });

  test('test_install_criteria_pluginroot_form_exit_0', () => {
    rewriteRegistry(fx, (d) => { d.plugins[0].source = './workflow'; });
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    assert.equal(criteria.length, 6);
    const expect = treeHash(join(fx.market, 'plugins', 'workflow'), [...DEFAULT_IGNORE]);
    const hashes = criteria.filter((c) => c.probe.type === 'dir-tree-hash').map((c) => c.probe.expect);
    assert.deepEqual(hashes, [expect, expect]);
    const mirrorHashProbe = criteria.filter((c) => c.probe.type === 'file-sha256');
    assert.equal(mirrorHashProbe[0].probe.expect, sha256File(join(fx.market, 'marketplace.json')));
  });

  test('test_install_criteria_no_dir_source_exit_2', () => {
    rewriteRegistry(fx, (d) => { d.plugins[0].source = 'git+https://example.com/x'; });
    const r = runCli(proj, args());
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('均非目录源'));
    assert.ok(r.stderr.includes('git+https://example.com/x'));
    assert.ok(r.stderr.includes('./plugins/<名> 或 ./<名>'));
  });

  test('test_install_criteria_no_marketplace_entry_exit_2', () => {
    rewriteRegistry(fx, (d) => { d.plugins[0].marketplace = 'other-market'; });
    const r = runCli(proj, args());
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('未安装或市场名不符'));
  });

  test('test_install_criteria_traversal_source_exit_2', () => {
    for (const bad of ['./..', './plugins/../x', './plugins/x\\..\\y', './x\\..\\y', './', './plugins/']) {
      rewriteRegistry(fx, (d) => { d.plugins[0].source = bad; });
      const r = runCli(proj, args());
      assert.equal(r.code, 2, bad);
      assert.ok(r.stderr.includes('形态非法'), bad);
      assert.ok(r.stderr.includes('plugins[0]'), bad);
    }
  });

  test('test_install_criteria_mixed_source_forms', () => {
    const scoutSrc = join(fx.market, 'plugins', 'scout');
    mkdirSync(join(scoutSrc, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(scoutSrc, '.zcode-plugin', 'plugin.json'),
      JSON.stringify({ name: 'scout', version: fx.version }), 'utf8');
    writeFileSync(join(fx.market, 'marketplace.json'), JSON.stringify({
      name: fx.marketName,
      plugins: [{ name: 'workflow', version: '0.0.0' }, { name: 'scout', version: fx.version }],
    }), 'utf8');
    rewriteRegistry(fx, (d) => {
      d.plugins[0].source = './workflow';
      d.plugins.push({
        id: `scout@${fx.marketName}`,
        name: 'scout',
        marketplace: fx.marketName,
        version: fx.version,
        installPath: join(fx.cache, 'scout', fx.version),
        source: './plugins/scout',
      });
    });
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    assert.equal(criteria.length, 11);
    const wf = criteria.filter((c) => c.criterion.includes('「workflow」'));
    const sc = criteria.filter((c) => c.criterion.includes('「scout」'));
    assert.deepEqual([wf.length, sc.length], [5, 5]);
    assert.ok(wf.some((c) => c.probe.field === 'plugins[0].version'));
    assert.ok(sc.some((c) => c.probe.field === 'plugins[1].version'));
  });

  test('test_install_criteria_skips_other_marketplace_pluginroot_form', () => {
    rewriteRegistry(fx, (d) => {
      d.plugins.push({
        id: 'frontend-design@claude-plugins-official',
        name: 'frontend-design',
        marketplace: 'claude-plugins-official',
        version: '0.0.0',
        installPath: join(fx.home, 'nowhere'),
        source: './frontend-design',
      });
    });
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).length, 6);
  });

  test('test_install_criteria_pluginroot_metadata_override', () => {
    const pkgs = join(fx.market, 'pkgs', 'workflow');
    mkdirSync(join(pkgs, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(pkgs, '.zcode-plugin', 'plugin.json'),
      JSON.stringify({ name: 'workflow', version: fx.version }), 'utf8');
    writeFileSync(join(pkgs, 'pkg-only.txt'), 'x', 'utf8');
    writeFileSync(join(fx.market, 'marketplace.json'), JSON.stringify({
      name: fx.marketName,
      metadata: { pluginRoot: 'pkgs' },
      plugins: [{ name: 'workflow', version: '0.0.0' }],
    }), 'utf8');
    rewriteRegistry(fx, (d) => { d.plugins[0].source = './workflow'; });
    const r = runCli(proj, args());
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    const expect = treeHash(pkgs, [...DEFAULT_IGNORE]);
    const hashes = criteria.filter((c) => c.probe.type === 'dir-tree-hash').map((c) => c.probe.expect);
    assert.deepEqual(hashes, [expect, expect]);
  });

  // ── 内部未决-155 / 内部任务-241：宿主数据根 env 缝与 --data-dir ──

  function mkKimiTree(base, { withInstalled = true } = {}) {
    for (const plugin of SUITE) mkdirSync(join(base, 'plugins', 'managed', plugin), { recursive: true });
    if (withInstalled) {
      writeFileSync(join(base, 'plugins', 'installed.json'), JSON.stringify({
        version: 1, plugins: SUITE.map((plugin) => ({ id: plugin, enabled: true })),
      }), 'utf8');
    }
  }

  test('test_host_kimi_env_seam（DEV-241 OPEN-155）', () => {
    const custom = join(fx.home, 'custom-kimi');
    mkKimiTree(custom);
    const before = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = custom;
    try {
      const r = runCli(proj, ['install-criteria', '--host', 'kimi', '--home', fx.home, '--record-ref', 'x#y']);
      assert.equal(r.code, 0, r.stderr);
      const criteria = jsonOf(r);
      const jf = criteria.filter((c) => c.probe?.type === 'json-field-eq');
      assert.equal(jf.length, 6);
      assert.ok(jf.every((c) => c.probe.path.rel === 'custom-kimi/plugins/installed.json'), 'env 缝命中且 rel 相对 home');
      assert.ok(criteria.some((c) => String(c.criterion).includes('KIMI_CODE_HOME')), '判据标注数据根来源');
    } finally {
      if (before === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = before;
    }
  });

  test('test_host_kimi_data_dir_priority（DEV-241）', () => {
    const alt = join(fx.home, 'alt-kimi');
    mkKimiTree(alt);
    const before = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = join(fx.home, 'env-should-lose');
    try {
      const r = runCli(proj, ['install-criteria', '--host', 'kimi', '--home', fx.home, '--data-dir', alt, '--record-ref', 'x#y']);
      assert.equal(r.code, 0, r.stderr);
      const jf = jsonOf(r).filter((c) => c.probe?.type === 'json-field-eq');
      assert.ok(jf.every((c) => c.probe.path.rel === 'alt-kimi/plugins/installed.json'), '--data-dir 优先级高于 env');
    } finally {
      if (before === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = before;
    }
  });

  test('test_host_kimi_custom_dir_outside_home_degrades_to_human_check（DEV-241）', () => {
    const outside = join(tmp, 'outside-kimi');
    mkKimiTree(outside);
    const r = runCli(proj, ['install-criteria', '--host', 'kimi', '--home', fx.home, '--data-dir', outside, '--record-ref', 'x#y']);
    assert.equal(r.code, 0, r.stderr);
    const criteria = jsonOf(r);
    assert.ok(criteria.some((c) => c.probe === undefined && String(c.criterion).includes('人工走查')), 'home 外数据根降级人工走查判据');
  });

  test('test_host_data_dir_mutex（DEV-241）', () => {
    const r = runCli(proj, ['install-criteria', '--host', 'kimi', '--data-dir', join(fx.home, 'x'), '--marketplace', fx.market, '--record-ref', 'x#y']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /互斥/);
  });

  test('test_host_mcode_env_seam（DEV-241）', () => {
    const custom = join(fx.home, 'custom-mcode');
    for (const plugin of SUITE) mkdirSync(join(custom, 'plugins', plugin), { recursive: true });
    const before = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = custom;
    try {
      const r = runCli(proj, ['install-criteria', '--host', 'mcode', '--home', fx.home, '--record-ref', 'x#y']);
      assert.equal(r.code, 0, r.stderr);
      const fe = jsonOf(r).filter((c) => c.probe?.type === 'file-exists');
      assert.ok(fe.every((c) => c.probe.path.rel.startsWith('custom-mcode/plugins/')), 'MINIMAX_DATA_DIR 缝命中');
    } finally {
      if (before === undefined) delete process.env.MINIMAX_DATA_DIR; else process.env.MINIMAX_DATA_DIR = before;
    }
  });
});
