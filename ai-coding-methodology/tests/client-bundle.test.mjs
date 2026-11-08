// 文件：client-bundle.test.mjs
// 描述：DSH 客户端半侧 bundle 测试（内部任务-201 / 内部决策-057）——以模拟宿主 ModuleLoader 求值
//       client/client.js，断言 factory id/导出面/plugins.bundle.config 注册结构、未服务诊断
//       （一次性 warn、零注册）、保存路径（buildSaveOps/readSnapshotDraft/saveDraft）与
//       脏草稿状态机（nextCardState 快照重读不清草稿）。RED 阶段 6 项因文件缺失逐项失败。
// 作者：wangp  创建：2026-10-22  版权：MIT（见仓库 LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(import.meta.dirname, '..', 'client', 'client.js');
const NS = 'ai-coding-methodology';
const FIELD = 'agentControlBridge';

/**
 * 以模拟宿主 ModuleLoader 求值客户端 bundle（每项 test 内部调用——顶层读取会让缺失文件只计 1 项失败）。
 * @returns {{ id: string, factory: Function, exports: object }}
 */
function loadBundle() {
  const source = readFileSync(SOURCE, 'utf8');
  let loaded;
  const window = { __ModuleLoader__: { load(mod) { loaded = mod; } } };
  // 宿主以普通脚本注入 bundle；此处等价求值。
  new Function('window', source)(window);
  assert.ok(loaded !== undefined, 'bundle 应调用 window.__ModuleLoader__.load');
  const fakeRequire = (name) => {
    if (name === 'react') return { createElement: (...args) => ({ args }), useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useEffect: (fn) => fn() };
    throw new Error(`client bundle 不得 require 其它模块：${name}`);
  };
  const exports = loaded.factory(fakeRequire);
  return { id: loaded.id, factory: loaded.factory, exports };
}

/** 构造客户端 apply 所需的最小 fake ctx/props（记录 whileServed 命名空间与 slots.inject 槽名——接线点本身要被断言）。 */
function makeClientCtx({ served = true, view = { namespaces: [] }, language = 'zh' } = {}) {
  const dicts = {};
  const registrations = [];
  const warns = [];
  const servedNamespaces = [];
  const slotNames = [];
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { [FIELD]: false }, revision: 1, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  };
  const ctx = {
    logger: { info() {}, warn(m) { warns.push(String(m)); } },
    locale: { register(ns, dict) { dicts[ns] = dict; }, bind: (ns) => (key) => { const d = dicts[ns]?.[language] ?? dicts[ns]?.en; return d?.[key] ?? key; } },
    configForms: {
      get: () => form,
      whileServed: (namespaces, register) => {
        servedNamespaces.push(namespaces);
        return served ? register(new Set([NS])) : () => {};
      },
      describe: () => ({ getSnapshot: () => ({ status: 'ready', view }), subscribe: (cb) => { cb(); return () => {}; } }),
    },
    slots: {
      inject: (name, register) => {
        slotNames.push(name);
        register();
      },
      register: (options, render) => { registrations.push({ options, render }); return () => {}; },
    },
    effect: (fn) => { fn(); },
  };
  return { ctx, registrations, warns, form, servedNamespaces, slotNames, dicts };
}

test('① bundle 与打包契约：ModuleLoader id 为包名、factory 为函数、文件头齐全；exports/files/dsh.client 可定位', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.match(source, /^\/\/ 文件：/m, '文件头应有「文件：」');
  assert.match(source, /^\/\/ 描述：/m, '文件头应有「描述：」');
  const { id, factory } = loadBundle();
  assert.equal(id, NS);
  assert.equal(typeof factory, 'function');
  // 打包契约（本批新增发布面）：宿主按 package.json 发现客户端半侧；漏项会静默不挂 bundle。
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 应为 web');
  assert.equal('inject' in (pkg.dsh?.client ?? {}), false, 'dsh.client 应省略 inject（省略＝空集；DEV-236/O2 单调锁）');
  const clientExport = pkg.exports?.['./client'];
  assert.equal(typeof clientExport, 'string', 'exports 应声明 ./client');
  assert.ok(existsSync(join(import.meta.dirname, '..', clientExport.replace(/^\.\//, ''))), './client 应解析到存在的文件');
  assert.ok((pkg.files ?? []).includes('client/**/*.js'), 'files 白名单应精确覆盖 client/**/*.js（漏包即客户端半侧静默缺失）');
});

test('② 导出面：inject 服务集恰为 slots/configForms/locale', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.inject, ['slots', 'configForms', 'locale']);
});

test('③ 注册面：apply 后注册 plugins.bundle.config（key=包名），summary 视图返回 null', () => {
  const { exports } = loadBundle();
  const { ctx, registrations, servedNamespaces, slotNames } = makeClientCtx({ served: true, view: { namespaces: [{ ns: NS }] } });
  exports.apply(ctx);
  // 接线点断言：槽名与命名空间是「卡片静默不出现」的唯一入口，fake 不得丢弃这两个入参。
  assert.deepEqual(servedNamespaces, [[NS]], 'whileServed 应以 [NS] 订阅');
  assert.deepEqual(slotNames, ['plugins.bundle.config'], '必须经 plugins.bundle.config 槽注入卡片');
  assert.equal(registrations.length, 1, '应注册一条配置卡片');
  const { options, render } = registrations[0];
  assert.equal(options.name, 'plugins.bundle.config');
  assert.equal(options.key, NS);
  assert.equal(options.locale, NS);
  assert.equal(typeof options.inject, 'function', '卡片 props 注入函数应存在');
  const injected = options.inject();
  assert.equal(typeof injected.t, 'function');
  assert.equal(typeof injected.form, 'object');
  assert.equal(render({ view: 'summary' }), null);
});

test('④ 未服务降级：零注册且 ctx.logger.warn 恰一次（首个非空 view 不含 namespace）', () => {
  const { exports } = loadBundle();
  const { ctx, registrations, warns, slotNames } = makeClientCtx({ served: false, view: { namespaces: [] } });
  exports.apply(ctx);
  assert.equal(registrations.length, 0, '命名空间未服务时不得注册卡片');
  assert.equal(slotNames.length, 0, '命名空间未服务时不得进入 slots.inject 接线');
  assert.equal(warns.filter((w) => w.includes('配置命名空间')).length, 1, '诊断 warn 应恰一次');
});

test('⑤ 保存参数构造：buildSaveOps/readSnapshotDraft', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.buildSaveOps(true), [{ op: 'set', path: [FIELD], value: true }]);
  assert.deepEqual(exports.readSnapshotDraft({ value: { [FIELD]: true }, revision: 3 }), { draft: true, revision: 3 });
});

test('⑥ 保存路径：saveDraft 传 ops+revision；失败保草稿并分类；nextCardState 快照重读不清脏草稿', async () => {
  const { exports } = loadBundle();
  const calls = [];
  const form = {
    mutate: async (ops, revision) => { calls.push({ ops, revision }); return true; },
  };
  const ok = await exports.saveDraft(form, true, 7);
  assert.deepEqual(calls[0], { ops: [{ op: 'set', path: [FIELD], value: true }], revision: 7 });
  assert.deepEqual(ok, { ok: true });

  const rejected = { mutate: async () => false };
  assert.deepEqual(await exports.saveDraft(rejected, false, 8), { ok: false, reason: 'rejected', keepDraft: true });
  const broken = { mutate: async () => { throw new Error('boom'); } };
  const brokenResult = await exports.saveDraft(broken, true, 9);
  assert.deepEqual(
    { ok: brokenResult.ok, reason: brokenResult.reason, keepDraft: brokenResult.keepDraft },
    { ok: false, reason: 'error', keepDraft: true },
  );
  assert.equal(brokenResult.message, 'boom', 'DEV-273 M-07：错误原文不得吞掉');
  const warns = [];
  await exports.saveDraft(broken, true, 9, { warn: (m) => warns.push(m) });
  assert.equal(warns.length, 1, '注入 logger 时记一条 warn（生产不注入，测试注入 fake）');
  assert.match(warns[0], /配置保存失败：boom/);

  const dirty = { draft: true, revision: 9, dirty: true };
  const next = exports.nextCardState(dirty, { value: { [FIELD]: false }, revision: 10 });
  assert.equal(next.draft, true, '快照重读不得覆盖用户脏草稿');
  assert.equal(next.revision, 10, '应采纳新快照 revision');
});

test('⑦ 保存成功后 revision 采纳：连续两次保存不假冲突（装配级 2-save 链）', async () => {
  const { exports } = loadBundle();
  let revision = 7;
  const calls = [];
  const form = {
    mutate: async (ops, rev) => { calls.push({ ops, revision: rev }); revision += 1; return true; },
    getSnapshot: () => ({ value: { [FIELD]: true }, revision }),
    subscribe: () => () => {},
  };
  const s0 = { draft: true, revision: 7, dirty: true, saved: false };
  assert.deepEqual(await exports.saveDraft(form, s0.draft, s0.revision), { ok: true }, '第一次保存成功');
  const s1 = exports.adoptSavedRevision({ ...s0 }, form);
  assert.equal(s1.revision, 8, '成功后必须采纳新 revision（不等宿主 subscribe 通知）');
  assert.deepEqual(await exports.saveDraft(form, s1.draft, s1.revision), { ok: true }, '第二次保存成功（不假冲突）');
  assert.deepEqual(calls.map((c) => c.revision), [7, 8], '两次 mutate 分别使用 7、8');
});

test('DEV-273 M-06：performSave 读取校验失败——单次重读成功采纳 revision；两次失败→verify-failed 且 revision 不前进', async () => {
  const { exports } = loadBundle();
  let calls = 0;
  const formRetry = {
    mutate: async () => true,
    getSnapshot: () => {
      calls += 1;
      if (calls === 1) throw new Error('read-fail');
      return { value: { pluginScout: true }, revision: 11 };
    },
  };
  const ok = await exports.performSave({ form: formRetry, draft: { pluginScout: true }, saved: { pluginScout: false }, revision: 8 });
  assert.equal(ok.status, 'saved', '单次重读成功 ⇒ saved（不得误判 verify-failed）');
  assert.equal(ok.latest.revision, 11, '采纳最新 revision');
  assert.equal(calls, 2, '恰一次重读');
  const formAlwaysFail = { mutate: async () => true, getSnapshot: () => { throw new Error('nope'); } };
  const bad = await exports.performSave({ form: formAlwaysFail, draft: { pluginScout: true }, saved: { pluginScout: false }, revision: 8 });
  assert.equal(bad.status, 'verify-failed', '两次读取均失败 ⇒ verify-failed（不谎称已重读）');
  assert.equal(bad.latest, null, 'latest 为 null ⇒ revision 不前进');
  assert.ok(String(bad.message).includes('nope'), '错误原文透出供诊断');
});

test('DEV-268 分组列表卡片多字段保存', async () => {
  const { exports } = loadBundle();
  assert.equal(exports.PLUGIN_ROWS.length, 6, '插件开关六行');
  assert.equal(exports.FIELD_ORDER.length, 8, '八字段（六插件＋桥接＋OS）');
  // 只提交变更字段（多字段一次 mutate）
  const ops = exports.buildSaveOps(
    { pluginScout: true, osObservation: false },
    { pluginScout: false, osObservation: true, agentControlBridge: false },
  );
  assert.deepEqual(ops, [
    { op: 'set', path: ['pluginScout'], value: true },
    { op: 'set', path: ['osObservation'], value: false },
  ]);
  const calls = [];
  const form = { mutate: async (opsArg, revision) => { calls.push({ ops: opsArg, revision }); return true; } };
  assert.deepEqual(await exports.saveDraft(form, ops, 5), { ok: true });
  assert.equal(calls.length, 1, '多字段变更只调用一次 mutate');
  assert.equal(calls[0].ops.length, 2, '一次提交全部变更字段');
  assert.equal(calls[0].revision, 5);
  // 读快照缺字段用 DEFAULTS（核心开/其余关/桥接关/OS 开）
  const read = exports.readFields({ value: {}, revision: 9 });
  assert.equal(read.fields.pluginWorkflow, true);
  assert.equal(read.fields.pluginScout, false);
  assert.equal(read.fields.osObservation, true);
  assert.equal(read.revision, 9);
  // 部分落盘 → verifySaved=false（多字段 mutate 原子性未取证的防护；调用方按 rejected 保草稿）
  assert.equal(exports.verifySaved({ value: { pluginScout: true, osObservation: true } }, ops), false, '部分字段未落盘');
  assert.equal(exports.verifySaved({ value: { pluginScout: true, osObservation: false } }, ops), true, '全部落盘');
  // 保存编排四态（performSave：全成功/部分落盘/宿主拒绝/异常/无变更）
  const base = { draft: { pluginScout: true, osObservation: false }, saved: { pluginScout: false, osObservation: true }, revision: 4 };
  const run = (snapshot, mutate, override = {}) => exports.performSave({ ...base, ...override, form: { mutate, getSnapshot: () => snapshot } });
  assert.equal((await run({ value: { pluginScout: true, osObservation: false } }, async () => true)).status, 'saved', '全成功');
  assert.equal((await run({ value: { pluginScout: true, osObservation: true } }, async () => true)).status, 'rejected', '部分落盘→rejected');
  assert.equal((await run({ value: {} }, async () => false)).status, 'rejected', '宿主拒绝');
  assert.equal((await run({ value: {} }, async () => { throw new Error('boom'); })).status, 'error', '异常');
  assert.equal((await run({ value: {} }, async () => true, { draft: { pluginScout: false, osObservation: true } })).status, 'idle', '无变更→idle');
});


// ===== 内部任务-272 内部未决-237：客户端六插件行 i18n（A-da-13/A-da-17 唯一锁定用例） =====
test('DEV-272 配置卡英文 locale 渲染六插件行：zh 六行中文', () => {
  const { exports } = loadBundle();
  const zh = exports.localeDict('zh');
  const labels = exports.PLUGIN_ROWS.map((r) => zh['plugin.' + r.field + '.label']);
  assert.equal(labels.length, 6);
  for (const s of labels) assert.match(s, /[\u4e00-\u9fff]/u, 'zh 六行含汉字：' + s);
});

test('DEV-272 配置卡英文 locale 渲染六插件行：en 六行英文零汉字', () => {
  const { exports } = loadBundle();
  const en = exports.localeDict('en');
  for (const r of exports.PLUGIN_ROWS) {
    const label = en['plugin.' + r.field + '.label'];
    const desc = en['plugin.' + r.field + '.desc'];
    assert.ok(typeof label === 'string' && label !== '');
    assert.ok(typeof desc === 'string' && desc !== '');
    assert.doesNotMatch(label + desc, /[\u4e00-\u9fff]/u, 'en 六行不得含汉字：' + label);
  }
});

test('DEV-272 配置卡英文 locale 渲染六插件行：双语键齐备', () => {
  const { exports } = loadBundle();
  const zh = exports.localeDict('zh');
  const en = exports.localeDict('en');
  for (const r of exports.PLUGIN_ROWS) {
    for (const suffix of ['.label', '.desc']) {
      const key = 'plugin.' + r.field + suffix;
      assert.ok(Object.hasOwn(zh, key), 'zh 缺键 ' + key);
      assert.ok(Object.hasOwn(en, key), 'en 缺键 ' + key);
    }
  }
});

test('DEV-272 配置卡英文 locale 渲染六插件行：DEFAULTS 跨源对拍', async () => {
  const { exports } = loadBundle();
  const { Config } = await import('../src/index.mjs');
  const cfg = Config({});
  for (const field of exports.FIELD_ORDER) {
    const expected = cfg[field] && typeof cfg[field].get === 'function' ? cfg[field].get() : undefined;
    assert.equal(exports.DEFAULTS[field], expected, 'DEFAULTS 与 Config 默认值不一致：' + field);
  }
});


// ===== 内部任务-272 B3：渲染级 i18n 回归锁（en 视图六插件行零汉字） =====
test('DEV-272 配置卡英文 locale 渲染六插件行：en 渲染零汉字（渲染级）', () => {
  const { ctx, registrations, dicts } = makeClientCtx({ language: 'en' });
  const { exports } = loadBundle();
  exports.apply(ctx);
  const { render } = registrations[0];
  const en = dicts[NS].en;
  const tree = renderTree(render({ view: 'page', t: (k) => en[k] ?? k, form: ctx.configForms.get() }));
  const text = JSON.stringify(tree);
  assert.ok(text.includes('Workflow engine'), 'en 六插件行 label 应渲染为英文：' + text.slice(0, 300));
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/u, 'en 渲染整棵树不得含汉字：' + text.slice(0, 500));
});


/** 测试侧最小渲染器：把 fake-React 元素树递归求值到可 JSON 化的结构（组件函数就地调用）。 */
function renderTree(node) {
  if (Array.isArray(node)) return node.map(renderTree);
  if (node !== null && typeof node === 'object' && Array.isArray(node.args)) {
    const [type, props] = node.args;
    if (typeof type === 'function') return renderTree(type(props ?? {}));
    return { type: typeof type === 'string' ? type : 'component', props: { ...(props ?? {}), children: node.args.slice(2).map(renderTree) } };
  }
  return node;
}
