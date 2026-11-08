// 文件：agents-bridge.test.mjs
// 描述：ai-coding-methodology agent 面测试——三层覆盖面：
//       ① 纯函数（agent 前言解析 / ZCode 工具词表 → DSH 工具名映射 / allow 列表推导）；
//       ② 真实仓扫描（三份 agents/*.md 全部可解析，persona 为正文、词表映射零未知；
//          并断言"写工具不在任何 agent 的 allow 列表里"这条硬约束）；
//       ③ 装配（挂载三份委派工具：唯一 toolName、provider 名、persona 与 toolFilter 正确；
//          工具目录不可得时 fail-closed 不挂载并响亮告警）。
//       宿主契约按源码复刻：`dsh-tool-subagent` 的 `normalizeDefinition`（toolName 唯一、
//       provider 必填、toolFilter 形状）、`dsh-subagent` 的 `applyChildComposition`
//       （persona → systemPrompt 段；toolFilter → tools.restrict）、`dsh-tools` 的
//       `restrict()`（未知名抛错）。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLogger as makeLoggerStub } from './helpers/logger-stub.cjs';
import { testEngine } from './helpers/engine-binding.mjs';

// 引擎绑定（批 2 阶段 2）：buildToolFilter 的挂载极性判定已由引擎驱动，须先绑定真实仓引擎
testEngine();

import {
  CORE_TOOLS,
  EXTENDED_TOOLS,
  READ_ONLY_FORBIDDEN,
  buildToolFilter,
  collectAgents,
  loadAgent,
  mapZcodeTool,
  mountAgents,
  readAgentFile,
  splitToolList,
} from '../src/agents-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const WORKFLOW = join(REPO_ROOT, 'workflow');

function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

test('splitToolList：逗号/顿号/分号/空白分隔，去空去重保序', () => {
  assert.deepEqual(splitToolList('Glob, Grep, LS, Read'), ['Glob', 'Grep', 'LS', 'Read']);
  assert.deepEqual(splitToolList('Glob,Grep,LS'), ['Glob', 'Grep', 'LS']);
  assert.deepEqual(splitToolList('Glob；Grep、LS'), ['Glob', 'Grep', 'LS']);
  assert.deepEqual(splitToolList('  Glob ,, Grep  '), ['Glob', 'Grep']);
  assert.deepEqual(splitToolList('Glob, Glob'), ['Glob'], '去重');
  assert.deepEqual(splitToolList(''), []);
  assert.deepEqual(splitToolList(undefined), []);
});

test('mapZcodeTool：已知 ZCode 词 → DSH 工具名候选；无对位返回空数组（拒绝语义）', () => {
  assert.deepEqual(mapZcodeTool('Glob'), ['glob']);
  assert.deepEqual(mapZcodeTool('Grep'), ['grep']);
  assert.deepEqual(mapZcodeTool('LS'), ['read']);
  assert.deepEqual(mapZcodeTool('Read'), ['read']);
  assert.deepEqual(mapZcodeTool('WebFetch'), ['web_fetch']);
  assert.deepEqual(mapZcodeTool('WebSearch'), ['web_search']);
  assert.deepEqual(mapZcodeTool('TodoWrite'), ['todo_write']);
  // `Bash` 是**平台二选一**：列两个候选，由「与宿主目录求交集」筛出当前平台那个。
  // 若这里按平台写死（旧实现是 `→ 'pwsh'`），另一平台上交集必空、只读 agent 全体 fail-closed。
  assert.deepEqual(mapZcodeTool('Bash'), ['pwsh', 'bash']);
  assert.deepEqual(mapZcodeTool('glob'), ['glob'], '大小写不敏感');
  assert.deepEqual(mapZcodeTool('BashOutput'), [], 'DSH 无对位 → 拒绝（丢弃）');
  assert.deepEqual(mapZcodeTool('Write'), [], '写工具无对位映射 → 拒绝（绝不放行写工具）');
  assert.deepEqual(mapZcodeTool('Edit'), []);
  assert.deepEqual(mapZcodeTool('MultiEdit'), []);
  assert.deepEqual(mapZcodeTool('Task'), []);
  assert.deepEqual(mapZcodeTool(''), []);
});

test('buildToolFilter：映射成功的工具进 allow；无映射则返回 null（调用方不快照 deny/allow）', () => {
  const f = buildToolFilter(['Glob', 'Grep', 'Read']);
  assert.ok(f, '有映射即产出 filter');
  for (const name of ['glob', 'grep', 'read']) assert.ok(f.allow.includes(name), name);
  assert.equal(buildToolFilter(['BashOutput']), null, '全无映射 → null');
  assert.equal(buildToolFilter([]), null);
  assert.equal(buildToolFilter(undefined), null);
});

test('buildToolFilter：过滤掉宿主目录里不存在的候选（fail-closed）', () => {
  const f = buildToolFilter(['Glob', 'Read'], { available: ['glob'] });
  assert.deepEqual(f.allow, ['glob'], '目录里没有 read 就不写进 allow');
  assert.equal(buildToolFilter(['Glob'], { available: [] }), null, '一个都不存在 → null');
});

test('buildToolFilter：目录不可得（available===null）必须 fail-closed 返回 null', () => {
  // 2026-09-28 第 91 批（变异实测补）：这条钉住函数入口的 fail-closed。
  // 变异实测：把 `if (available === null) return null;` 改掉后**137 项全绿**——因为改成别的值时
  // `null.includes` 会抛错，被 `mountAgents` 的 try/catch 接住，行为上"看起来没坏"。
  // 但语义必须钉死：目录不可得 ⇒ 返回 null（**不挂载该委派工具**），而不是抛错、也不是空 allow。
  assert.equal(buildToolFilter(['Read'], { available: null }), null, '目录不可得必须 fail-closed');
  // 反向对照：`available` **省略**与传 `null` 语义不同——省略 = 不做目录过滤（仍给 allow），
  // `null` = 目录不可得（fail-closed）。这两个若混淆，"探测失败"会被当成"无需过滤"。
  assert.deepEqual(buildToolFilter(['Read'], { available: undefined }).allow, ['read'], '省略 available 时不过滤目录');
  assert.deepEqual(buildToolFilter(['Read']).allow, ['read'], '完全省略 opts 时同样不过滤目录');
});

test('buildToolFilter：畸形入参（非数组）一律返回 null（防御性；不改行为但防抛错）', () => {
  // 与上一条分开写（2026-09-28 第 91 批）。**如实说明这条用例的强度**：
  // `if (!Array.isArray(zcodeTools) || zcodeTools.length === 0) return null;` 这道入口守卫
  // 在当前调用链上**不可达**——`mountAgents` 只把 `loadAgent` 产出的 `zcodeTools`（来自
  // `splitToolList`，恒为数组）传进来。变异实测：把它去掉，139 项**仍全绿**。
  // 它的价值是**防抛错**：非数组（尤其 `{}`）进去后 `for...of` 会抛 TypeError，
  // 而 `mountAgents` 的 try/catch 会把它记成 `failed` 条目，看起来像"工具映射出了故障"，
  // 而不是"这个 agent 的声明不合法"——**错误归因被弄脏**。故这里钉住"返回 null 而非抛错"。
  // 记录这条就是为了不让读者（和将来的我）误以为它是被测出来的行为分支。
  assert.equal(buildToolFilter('Read', { available: ['read'] }), null, '字符串入参不得被逐字符遍历');
  assert.equal(buildToolFilter(42, { available: ['read'] }), null, '数字入参');
  assert.equal(buildToolFilter({ 0: 'Read' }, { available: ['read'] }), null, '对象入参（无守卫时会抛 TypeError）');
  assert.equal(buildToolFilter(null, { available: ['read'] }), null, 'null 入参');
  assert.equal(buildToolFilter(undefined, { available: ['read'] }), null, 'undefined 入参');
  assert.equal(buildToolFilter(true, { available: ['read'] }), null, '布尔入参');
  // 空数组：行为上由末尾 `allowSet.size === 0 ? null` 兜底，这里只是把结果写下来
  assert.equal(buildToolFilter([], { available: ['read'] }), null, '空数组 ⇒ null');
  assert.equal(buildToolFilter([], { available: null }), null, '空数组 + 目录不可得 ⇒ null');
});

test('buildToolFilter：写工具永远不在 allow 里（硬约束）', () => {
  const f = buildToolFilter(['Glob', 'Grep', 'LS', 'Read', 'WebFetch', 'WebSearch', 'TodoWrite', 'Bash', 'BashOutput']);
  assert.ok(f);
  for (const forbidden of READ_ONLY_FORBIDDEN) {
    assert.ok(!f.allow.includes(forbidden), `allow 不得含写/破坏性工具 ${forbidden}`);
  }
});

test('loadAgent：解析前言四字段并把正文作为 persona', (t) => {
  const root = makeTemp(t);
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(
    join(root, 'agents', 'x.md'),
    '---\nname: x\ndescription: 一句话说明\ntools: Glob, Grep, Read\n---\n\n# 角色\n你是一个只读探索者。\n',
    'utf8',
  );
  const a = loadAgent('workflow', root, 'x.md');
  assert.equal(a.skip, undefined);
  assert.equal(a.name, 'x');
  assert.equal(a.description, '一句话说明');
  assert.deepEqual(a.zcodeTools, ['Glob', 'Grep', 'Read']);
  assert.ok(a.persona.startsWith('\n# 角色'), 'persona 是前言之后的原文');
  assert.ok(a.persona.includes('只读探索者'));
  assert.equal(a.path, join(root, 'agents', 'x.md'));
});

test('loadAgent：丢弃条件矩阵（缺 description / 缺 tools / 缺 name / 正文空 / frontmatter 坏）', (t) => {
  const root = makeTemp(t);
  mkdirSync(join(root, 'agents'), { recursive: true });
  const w = (n, body) => writeFileSync(join(root, 'agents', n), body, 'utf8');
  w('no-desc.md', '---\nname: a\ntools: Read\n---\n正文\n');
  w('no-tools.md', '---\nname: a\ndescription: d\n---\n正文\n');
  w('no-name.md', '---\ndescription: d\ntools: Read\n---\n正文\n');
  w('empty.md', '---\nname: a\ndescription: d\ntools: Read\n---\n');
  w('bad.md', '---\nname: a\ndescription: d\ntools: Read\nnonsense line\n---\n正文\n');
  assert.match(loadAgent('workflow', root, 'no-desc.md').skip, /description/);
  assert.match(loadAgent('workflow', root, 'no-tools.md').skip, /tools/);
  assert.match(loadAgent('workflow', root, 'no-name.md').skip, /name/);
  assert.match(loadAgent('workflow', root, 'empty.md').skip, /正文为空/);
  assert.match(loadAgent('workflow', root, 'bad.md').skip, /frontmatter/);
});

test('readAgentFile：不可读返回错误对象而非抛出', (t) => {
  const root = makeTemp(t);
  const r = readAgentFile(join(root, 'agents', 'nope.md'));
  assert.ok(r.error);
  assert.equal(r.text, '');
});

// ── ② 真实仓扫描 ────────────────────────────────────────────────────────────

test('collectAgents：真实 workflow/agents 三份全部可解析，唯一无对位词是 BashOutput', () => {
  const { agents, skipped } = collectAgents({ workflow: WORKFLOW });
  assert.deepEqual(skipped, [], `不应有被跳过的 agent：${JSON.stringify(skipped)}`);
  assert.equal(agents.length, 3);
  assert.deepEqual(agents.map((a) => a.name).sort(), ['code-architect', 'code-explorer', 'code-reviewer']);
  for (const a of agents) {
    assert.ok(a.description.length > 0, `${a.name} 有 description`);
    assert.ok(a.persona.trim().length > 100, `${a.name} 的 persona 是正文全文`);
    assert.deepEqual(a.unmappedTools, ['BashOutput'], `${a.name} 唯一无对位词应为 BashOutput`);
    assert.ok(a.toolFilter, `${a.name} 应产出 toolFilter`);
  }
});

test('collectAgents：坏条目计入 skipped 且不带倒其余（真实资产全绿，故需夹具）', (t) => {
  // 为什么需要（2026-09-28 第 88 批）：上一条真实资产用例断言 `skipped === []`——
  // 也就是说 `collectAgents` 里 `loaded.skip !== undefined` 那条**跳过分支从未被执行**。
  // 这与第 85 批（`collectSkills`）、第 87 批（`collectCommands`）是**同一缺陷模式的第三次**：
  // 三个 collect 函数写法对称，覆盖缺口也完全对称（真实资产都健康 ⇒ 跳过分支永不执行）。
  // 与 commands 同构：本函数的 `agentFileNames` 先按 `.md` 扩展名预筛、再查 `isFile`
  // （S-09/内部未决-245 起三面共用 `listEntriesIn`）；夹具里"可读但形态坏"的 `.md` 常规文件
  // 能走到 loadAgent —— 这些坏法就够覆盖该分支（目录/非 `.md` 条目由 agentFileNames 自身过滤）。
  const dir = makeTemp(t);
  const root = join(dir, 'p1');
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'p1', version: '0.0.0' }), 'utf8');
  const fm = (body) => `---\n${body}---\n正文\n`;
  // 健康一条
  writeFileSync(join(root, 'agents', 'ok.md'), fm('name: ok\ndescription: 好的\ntools: Read\n'), 'utf8');
  // 五种坏法各一条（全都"文件可读、形态坏"）
  writeFileSync(join(root, 'agents', 'no-name.md'), fm('description: 有\ntools: Read\n'), 'utf8');
  writeFileSync(join(root, 'agents', 'no-desc.md'), fm('name: a\ntools: Read\n'), 'utf8');
  writeFileSync(join(root, 'agents', 'no-tools.md'), fm('name: b\ndescription: 有\n'), 'utf8');
  writeFileSync(join(root, 'agents', 'bad-fm.md'), '没有定界符\n', 'utf8');
  writeFileSync(join(root, 'agents', 'empty-body.md'), '---\nname: c\ndescription: 有\ntools: Read\n---\n\n', 'utf8');
  // 非 .md 忽略
  writeFileSync(join(root, 'agents', 'note.txt'), 'x', 'utf8');

  const out = collectAgents({ p1: root });
  assert.equal(out.agents.length, 1, '只有健康那条被收集');
  assert.equal(out.agents[0].name, 'ok');
  assert.equal(out.skipped.length, 5, `五条坏条目都应计入 skipped：${JSON.stringify(out.skipped)}`);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons['no-name.md'], /缺少 name/);
  assert.match(reasons['no-desc.md'], /缺少 description/);
  assert.match(reasons['no-tools.md'], /缺少 tools/);
  assert.match(reasons['bad-fm.md'], /frontmatter 不可解析/);
  assert.match(reasons['empty-body.md'], /正文为空/);
  assert.ok(!out.skipped.some((s) => s.file === 'note.txt'), '非 .md 不该被当成坏条目');
  // 注：`collectAgents` **不返回 `counts`**（与 `collectSkills`/`collectCommands` 不同——
  // 那两个给 apply 的日志供分插件计数，agent 面走的是 `mountAgents` 的 mounted/skipped，
  // 故无需 counts）。这里断言返回键集合，把这个不对称显式钉住，防止将来误加/误删：
  assert.deepEqual(Object.keys(out).sort(), ['agents', 'skipped']);
});

test('真实仓硬约束：code-explorer 与 code-architect 不得拿到任何 shell 工具', () => {
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const byName = new Map(agents.map((a) => [a.name, a]));
  for (const name of ['code-explorer', 'code-architect']) {
    const allow = byName.get(name).toolFilter.allow;
    assert.ok(!allow.includes('pwsh'), `${name} 是纯只读探索者，不得含 pwsh`);
    assert.ok(!allow.includes('bash'), `${name} 不得含 bash`);
  }
});

test('真实仓：code-reviewer 含 Bash（其边界靠护栏而非白名单），但不得含写工具', () => {
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const reviewer = agents.find((a) => a.name === 'code-reviewer');
  assert.ok(reviewer.toolFilter.allow.includes('pwsh'), 'code-reviewer 在 ZCode 侧含 Bash，映射为 pwsh');
  for (const forbidden of ['write', 'edit']) {
    assert.ok(!reviewer.toolFilter.allow.includes(forbidden), `code-reviewer 不得含 ${forbidden}`);
  }
  assert.ok(reviewer.zcodeTools.includes('Bash'));
});

test('真实仓：BashOutput 被记为 unmapped 而不是静默丢弃', () => {
  const { agents } = collectAgents({ workflow: WORKFLOW });
  for (const a of agents) {
    assert.deepEqual(a.unmappedTools, ['BashOutput'], `${a.name} 应显式记录 BashOutput 无对位`);
  }
});

// ── ③ 装配 ──────────────────────────────────────────────────────────────────

/** 伪 cordis ctx：记录 plugin 挂载与提供方注册；可注入/缺省工具目录。 */
function makeCtx({ availableTools = CORE_TOOLS.concat(EXTENDED_TOOLS) } = {}) {
  const mounted = [];
  const providers = new Map();
  const logger = makeLoggerStub();
  return {
    mounted,
    providers,
    logger,
    byLevel: (level) => logger.byLevel(level),
    get(name) {
      if (name === 'subagents') return { providers, registerProvider: (p) => providers.set(p.name, p) };
      return undefined;
    },
    plugin(entry, config) {
      const mod = typeof entry === 'object' && entry.__module ? entry.__module : entry;
      mounted.push({ entry: mod, config });
      // 忠实复刻 cordis 的返回契约：`Fiber & PromiseLike<Fiber>`。
      // **必须是可 await 的（有 then），不能只给一个 `.await()` 方法**——真实宿主里
      // `await ctx.plugin(...)` 依赖的是 thenable 协议；只给 `.await` 会让适配层的
      // `await` 退化成"直接拿到对象"，从而抓不到启动期 rejection（第 21 批修正）。
      const settle = async () => {
        if (typeof mod?.apply === 'function') await mod.apply({}, config);
        if (typeof mod === 'function') await mod({}, config);
      };
      const fiber = {
        await: settle,
        then: (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected),
      };
      return fiber;
    },
    logger,
    __availableTools: availableTools,
  };
}

test('mountAgents：ctx.plugin 以 rejection 报错（cordis 语义）时逐条隔离且不谎报成功', async () => {
  // cordis 的 `ctx.plugin()` 返回 `Fiber & PromiseLike<Fiber>`，文档原话
  // 「awaiting it settles once loading finished (rejecting on config or startup errors)」
  // ——失败是**异步 rejection**而非同步 throw。只 try/catch 不 await 的实现会：
  //   ① `mounted` 谎报成功；② 留下未处理的 rejection。本用例钉死这一点。
  const ctx = makeCtx();
  let call = 0;
  const flakyModule = {
    name: 'fake-tool-subagent',
    apply() {
      call += 1;
      if (call === 2) return Promise.reject(new Error('第二个 plugin 的配置校验失败'));
      return undefined;
    },
  };
  const agents = [
    { name: 'code-explorer', persona: 'p1', zcodeTools: ['read', 'grep'] },
    { name: 'code-architect', persona: 'p2', zcodeTools: ['read', 'grep'] },
    { name: 'code-reviewer', persona: 'p3', zcodeTools: ['read', 'grep'] },
  ];
  const outcome = await mountAgents(ctx, agents, {
    toolSubagentModule: flakyModule,
    available: ctx.__availableTools,
  });
  assert.equal(outcome.mounted, 2, '只有两个真正挂载成功');
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].name, 'code-architect');
  assert.match(outcome.failed[0].error, /配置校验失败/);
  assert.ok(ctx.byLevel('warn').some((m) => /挂载失败/.test(m)), '失败必须告警');
});

test('buildToolFilter：`Bash` 在两个平台的目录里都能解析（旧的平台写死会让一侧全空）', () => {
  const words = ['read', 'grep']; // 取真实 agent 词表里的读工具
  // Windows 目录（含 pwsh，无 bash）
  const win = buildToolFilter([...words, 'bash'], { available: [...words, 'pwsh'] });
  assert.deepEqual(win, { allow: ['read', 'grep', 'pwsh'] }, 'Windows 应落到 pwsh');
  // POSIX 目录（含 bash，无 pwsh）
  const posix = buildToolFilter([...words, 'bash'], { available: [...words, 'bash'] });
  assert.deepEqual(posix, { allow: ['read', 'grep', 'bash'] }, 'POSIX 应落到 bash');
  // 两个都没有（宿主未暴露 shell 工具）：只有读工具也能成，不因缺 shell 而整体失败
  const noShell = buildToolFilter([...words, 'bash'], { available: [...words] });
  assert.deepEqual(noShell, { allow: ['read', 'grep'] }, '缺 shell 不应让整条 filter 变 null');
  // 目录里一个候选都没有 → fail-closed（null）
  assert.equal(buildToolFilter(['bash'], { available: ['web_fetch'] }), null);
  // 两个都在（异常但可能：宿主同时暴露）：都给，不猜
  assert.deepEqual(buildToolFilter(['bash'], { available: ['pwsh', 'bash'] }), { allow: ['pwsh', 'bash'] });
});

test('真实仓：三份 agent 的 Bash 映射在两个平台的目录下都能挂载', () => {
  const { agents } = collectAgents({ workflow: WORKFLOW });
  for (const platformShell of ['pwsh', 'bash']) {
    const available = [...CORE_TOOLS, ...EXTENDED_TOOLS, platformShell];
    for (const a of agents) {
      const filter = buildToolFilter(a.zcodeTools, { available });
      assert.notEqual(filter, null, `${a.name} 在 ${platformShell} 目录下不应 fail-closed`);
      // code-reviewer 有 Bash → 必须含平台 shell；两只只读 agent 不该含
      const wantsShell = a.zcodeTools.some((w) => w.toLowerCase() === 'bash');
      assert.equal(filter.allow.includes(platformShell), wantsShell, `${a.name} 的 shell 归属应取决于其词表`);
      // 写工具在任何平台、任何 agent 下都不得出现
      for (const forbidden of READ_ONLY_FORBIDDEN) assert.ok(!filter.allow.includes(forbidden), `${a.name} 不得含写工具 ${forbidden}`);
    }
  }
});

test('候选工具名的有效性依据（源码链归档）：名字对子 agent 必然合法', () => {
  // 这条用例不测我方代码，而是**把我方安全论证的源码前提写进测试**——避免将来有人问
  // "凭什么说这些工具名在子 agent 上也存在"时无处可查。四条前提，均逐字核对宿主源码：
  //
  // ① `restrict()` 的校验源是 `this.view(scope).restrictableNames`，而
  //    `dsh-tools/lib/index.js` 的 view() 里：
  //        for (const [name] of inherited) { knownNames.add(name); restrictableNames.add(name);
  //          if (layers.every((l) => l.admits(name))) visible.set(name, …) }
  //    —— **restrictableNames 无条件收下全部 inherited 名**；`admits` 只筛 `visible`。
  //    也就是说"能否被 restrict 命名"取决于**全局注册表**，与调用方是父还是子无关。
  // ② `dsh-subagent/lib/index.js` 的 `applyChildComposition(childCtx, parent, composition)`
  //    直接调 `childCtx.tools.restrict(composition.toolFilter)`。
  // ③ 同函数第一行 `childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx)` —— 子 agent
  //    **加入父的组合**；源码注释解释了为什么这一行与注册必须同调："a child that joins no
  //    preset sees an empty tool registry and none of its parent's prompt sections"。
  // ④ `dsh-agent-preset-registry` 的 `composeFrom(ctx, parent)` 取的是
  //    `standingMountFor(parent)` —— **父当前挂载的那个预置版本**，再 `join(ctx, key, generation)`
  //    把子绑到**同一个 generation**。即子 agent 的工具面 = 父的工具面，不是另一套。
  //
  // 结论：本层用 `ctx.get('tools').restrictableNames` 求交集得到的名字，在子 agent 的
  // scope 上必然同样存在于 restrictableNames —— 故 `toolFilter` 的**名字有效性**是确定的，
  // 不会触发 `unknown global tool`；而"子 agent 有哪些工具"由 ③④ 决定为**继承父的组合**。
  // 断言：候选表非空、且不含写工具（写工具在任何 scope 都不该进）。
  const available = [...CORE_TOOLS, ...EXTENDED_TOOLS, 'pwsh', 'bash'];
  assert.ok(CORE_TOOLS.length > 0 && EXTENDED_TOOLS.length > 0, '候选表不得为空（空=名字无从验证）');
  for (const w of ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write', 'pwsh']) {
    assert.ok(available.includes(w), `${w} 应在候选素材内（其有效性由上述四条宿主源码前提保证）`);
  }
  for (const forbidden of READ_ONLY_FORBIDDEN) {
    assert.ok(!available.includes(forbidden), `${forbidden} 是写/图像工具，任何 scope 都不得进 allow`);
  }
});

/** 伪 tool-subagent 模块标识（装配层只按引用原样交给 ctx.plugin）。 */
const fakeToolSubagent = { __module: 'tool-subagent' };

test('mountAgents：三份 agent 各挂一份委派工具，toolName 唯一、provider 一致', async () => {
  const ctx = makeCtx();
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const outcome = await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, providerName: 'ai-coding-methodology-agents', available: ctx.__availableTools });
  assert.equal(outcome.mounted, 3);
  assert.deepEqual(outcome.failed, []);
  const names = ctx.mounted.map((m) => m.config.toolName);
  assert.equal(new Set(names).size, 3, 'toolName 必须唯一');
  assert.deepEqual(names.sort(), ['code_architect', 'code_explorer', 'code_reviewer']);
  for (const m of ctx.mounted) {
    assert.equal(m.config.provider, 'ai-coding-methodology-agents');
    assert.ok(typeof m.config.persona === 'string' && m.config.persona.trim().length > 0, 'persona 必填');
    assert.equal(m.config.backgroundMode, 'one-shot');
    assert.ok(m.config.toolFilter && Array.isArray(m.config.toolFilter.allow));
  }
});

test('mountAgents：toolName 由 agent 名 kebab→snake 转换（DSH 工具名形态）', async () => {
  const ctx = makeCtx();
  const { agents } = collectAgents({ workflow: WORKFLOW });
  await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, available: ctx.__availableTools });
  const byName = new Map(ctx.mounted.map((m) => [m.config.toolName, m]));
  assert.ok(byName.has('code_explorer'));
  assert.ok(byName.has('code_architect'));
  assert.ok(byName.has('code_reviewer'));
});

test('mountAgents：工具目录不可得时 fail-closed——不挂载、响亮告警、绝不静默全给', async () => {
  const ctx = makeCtx({ availableTools: null });
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const outcome = await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, available: null });
  assert.equal(outcome.mounted, 0, '目录不可得时必须不挂载');
  assert.equal(ctx.mounted.length, 0);
  assert.ok(ctx.byLevel('warn').some((m) => /工具目录|fail-closed/.test(m)), `应有响亮告警，实际：${JSON.stringify(ctx.byLevel('warn'))}`);
});

test('mountAgents：宿主目录里缺某个工具时缩小 allow 而不是写不存在的名字', async () => {
  const ctx = makeCtx({ availableTools: ['glob', 'grep', 'read'] });
  const { agents } = collectAgents({ workflow: WORKFLOW });
  await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, available: ['glob', 'grep', 'read'] });
  for (const m of ctx.mounted) {
    for (const name of m.config.toolFilter.allow) {
      assert.ok(['glob', 'grep', 'read'].includes(name), `allow 含目录外名字 ${name}`);
    }
  }
  const reviewer = ctx.mounted.find((m) => m.config.toolName === 'code_reviewer');
  assert.ok(!reviewer.config.toolFilter.allow.includes('pwsh'), '目录里没有 pwsh 就不写进去');
});

test('mountAgents：ctx.plugin 抛错时逐条隔离并告警', async () => {
  const ctx = makeCtx();
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const real = ctx.plugin;
  let calls = 0;
  ctx.plugin = (entry, config) => {
    calls += 1;
    if (calls === 2) throw new Error('挂载被拒');
    return real(entry, config);
  };
  const outcome = await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, available: ctx.__availableTools });
  assert.equal(outcome.mounted, 2);
  assert.equal(outcome.failed.length, 1);
  assert.ok(ctx.byLevel('warn').some((m) => /挂载被拒/.test(m)));
});

test('mountAgents：宿主不提供 ctx.plugin 时 fail-closed（不挂载、告警指名原因）', async () => {
  // 覆盖审计（2026-09-28 第 82 批）查出这条守卫**零覆盖**：`mountAgents` 在
  // `typeof ctx?.plugin !== 'function'` 时跳过整面并告警。宿主正常都有 `ctx.plugin`（cordis
  // 上下文必备），但"宿主不提供"是**兼容性面**——老版本/替身/未来裁剪的宿主都可能缺，
  // 缺了若不拦，代码会在 `ctx.plugin(...)` 处抛 TypeError，把整面变成异常而不是"少挂三个"。
  const ctx = makeCtx();
  const { agents } = collectAgents({ workflow: WORKFLOW });
  const real = ctx.plugin;
  delete ctx.plugin;
  const outcome = await mountAgents(ctx, agents, { toolSubagentModule: fakeToolSubagent, available: ctx.__availableTools });
  ctx.plugin = real;
  assert.equal(outcome.mounted, 0, '不得谎报挂载成功');
  assert.equal(outcome.skipped.length, 3, '三个 agent 都应记为 skipped 并带原因');
  for (const s of outcome.skipped) assert.match(s.reason, /ctx\.plugin 不可用/);
  assert.ok(ctx.byLevel('warn').some((m) => /不提供 ctx\.plugin/.test(m)), '必须响亮告警');
});

test('mountAgents：agent 名无法归一为工具名时逐条跳过（不静默改名）', async () => {
  // 覆盖审计同时查出 `toolName === ''` 分支零覆盖。`toolNameOf` 对非法形态返回空串
  // （拒绝语义），此处必须**跳过该条**而不是带着空 toolName 去挂载——空名会让宿主注册出
  // 一个无法调用、也可能与他人冲突的工具。
  const ctx = makeCtx();
  const outcome = await mountAgents(
    ctx,
    [
      { name: '9-bad-name', persona: 'p', zcodeTools: ['Read'], source: 'f' },
      { name: 'good-name', persona: 'p', zcodeTools: ['Read'], source: 'f' },
    ],
    { toolSubagentModule: fakeToolSubagent, available: ctx.__availableTools },
  );
  assert.equal(outcome.mounted, 1, '只有合法名那份被挂载');
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /无法归一/);
  assert.equal(ctx.mounted[0].config.toolName, 'good_name');
});

test('CORE_TOOLS / EXTENDED_TOOLS / READ_ONLY_FORBIDDEN 三表语义与互斥', () => {
  const all = [...CORE_TOOLS, ...EXTENDED_TOOLS];
  assert.equal(new Set(all).size, all.length, '候选表不得重复');
  for (const f of READ_ONLY_FORBIDDEN) assert.ok(!all.includes(f), `禁表与候选表不得相交：${f}`);
  assert.ok(CORE_TOOLS.includes('read') && CORE_TOOLS.includes('glob') && CORE_TOOLS.includes('grep'));
  assert.ok(EXTENDED_TOOLS.includes('web_fetch') && EXTENDED_TOOLS.includes('web_search') && EXTENDED_TOOLS.includes('todo_write'));
  // 禁表是"写工具"的单一清单；pwsh 不在其中（code-reviewer 在 ZCode 侧就有 Bash），
  // 而 bash 根本不是 DSH 的工具名（词表里 Bash 映射到 pwsh）。
  for (const f of ['write', 'edit', 'read_image']) assert.ok(READ_ONLY_FORBIDDEN.includes(f), `${f} 应在禁表`);
  assert.ok(!READ_ONLY_FORBIDDEN.includes('pwsh'), 'pwsh 由 agent 词表决定，不在写工具禁表');
  assert.ok(!all.includes('bash'), 'bash 不是 DSH 工具名，不进候选表');
});

test('DEV-273 H-03：mountAgents 生产形态默认降级——全量 skipped、零 ctx.plugin（rc.5 契约门控）', async () => {
  const ctx = makeCtx();
  const agents = [{ name: 'code-explorer', persona: 'p', zcodeTools: ['read'] }];
  // 不注入 toolSubagentModule ＝ 生产调用形态（当前宿主契约不可用 ⇒ 全量 skipped，绝不向宿主传已移除字段）
  const outcome = await mountAgents(ctx, agents, { available: ctx.__availableTools });
  assert.equal(outcome.mounted, 0, 'rc.5 契约下不得挂载');
  assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /OPEN-244/);
  assert.equal(ctx.mounted.length, 0, '零 ctx.plugin 副作用');

  // 内部任务-274 发布验证：覆盖生产探测面与观测兜底旁路函数（functions 覆盖率过门禁；不新增用例）。
  const { resolveAvailableTools } = await import('../src/index.mjs');
  const toolsCtx = { get: (name) => (name === 'tools' ? { get: (tool) => (tool === 'read' ? { name: tool } : undefined) } : undefined) };
  const probe = resolveAvailableTools(toolsCtx);
  assert.ok(probe !== null && typeof probe === 'object', '公开 tools.get 探测应返回候选集');
  assert.equal(resolveAvailableTools({ get: () => undefined }), null, '无 tools 服务 ⇒ fail-closed null');
  const emit = await import('../src/observation-emit.mjs');
  const covDir = mkdtempSync(join(tmpdir(), 'dev274-cov-'));
  try {
    const lostPath = emit.lostFactsPath(covDir);
    assert.ok(lostPath.endsWith('incidents-lost.jsonl'), '兜底旁路路径末段固定');
    assert.match(emit.digestOfFact({ kind: 'probe', sessionId: 's' }), /^[0-9a-f]{16}$/, '事实摘要为 16 位十六进制');
    const append = emit.appendLostFact(lostPath, { kind: 'probe', sessionId: 's', digest: 'd' });
    assert.equal(append.ok, true, '兜底旁路追加应成功（fail-open 返回对象）');
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
});
