// 文件：acceptance.test.mjs
// 描述：ai-coding-methodology 端到端验收（宿主装载链的等价复刻 + ZCode 零影响不变量）——把三份
//       单元测试的零件按宿主真实装载顺序串成一条链，并回答本目标的另一半问题：
//       **适配层跑起来之后，ZCode 侧的契约面是否分毫未动**。
//       链条（与宿主装载器同序，逐条对应 `@deepseek-ai/dsh-*` 源码走查）：
//         ① 读 package.json → 校验 `dsh.engines.dsh` 与 `dsh.bundle.patch`（装载器入口）；
//         ② 解析 `cordis.patch.yml` → `insert` 条目（bundle 层）；
//         ③ 以条目 `name` 解析包入口并加载 → 导出 `name` / `inject` / `apply`（cordis 约定）；
//         ④ 用注入 `shell` +（探测到的）`skills` / `commands` 的伪 ctx 调 `apply`；
//         ⑤ 断言三面注册量 + 五个事件处理器齐备 + skill↔命令交叉一致；
//         ⑥ 驱动全部五个事件走**真实钩子进程**，断言决策；
//         ⑦ 断言 ZCode 契约面字节级未变（哈希 + mtime）+ 适配层源码无写调用。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as yaml from 'js-yaml';

import { createLogger as makeLoggerStub } from './helpers/logger-stub.cjs';
import { seedNullBucketLease } from './helpers/lease-seed.mjs';

import { IDENTIFIED_ID_RE } from '../src/commands-bridge.mjs';
import { normalizeMatcher } from '../src/hooks-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 公开包守卫（内部任务-365）：specs/ 未随公开包发布；源仓资产在位时照常执行。
const HAS_IF_HOST = existsSync(join(resolve(HERE, '..', '..'), 'specs', 'interfaces', 'IF-HOST-1.md'));
const COMPAT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(COMPAT_ROOT, '..');
const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

/**
 * 自察记录根（内部未决-44②，2026-09-29 内部任务-OPEN4344-1）：本套件驱动的真实钩子使用**合成 sessionId**
 * （`acceptance-session`/`inv`/`inv2`），若写生产账本 `<repo>/内部工作流状态` 会随每次
 * 跑套件再生 `retry-loop` 记录（实测账本 243 条全为该族）。模块级注入 `WF_INCIDENT_ROOT` 指向临时根
 * ——适配层构造钩子环境是 `{...process.env, …}`（src/index.mjs），必然透传。
 * 注意：本注入对**同进程内的其他测试文件**同样生效（node:test 默认每文件一进程，故当前无害）；
 * 将来新增依赖生产账本的用例须显式 `delete process.env.WF_INCIDENT_ROOT`，否则会静默假绿。
 * 另：`mkdtempSync` 在模块加载期执行，tmpdir 不可写会让整个文件 import 失败（此前该文件 import 期零 IO）。
 */
const INCIDENT_ROOT = mkdtempSync(join(tmpdir(), 'acm-incidents-'));
process.env.WF_INCIDENT_ROOT = INCIDENT_ROOT;
process.on('exit', () => rmSync(INCIDENT_ROOT, { recursive: true, force: true }));

// 重试环状态目录隔离（内部未决-61 / 内部任务-HANDOVER1002-1）：`post-tool.mjs` 的重试环默认落
// `$HOME/.zcode/cli/routing-state/wf-posttool-<sha16(session)>.json`（全局、跨运行），
// 不隔离则本文件驱动真实 PostToolUse 的用例（`acceptance-session`/`inv`/`inv2`）会写全局态。
const POSTTOOL_STATE_ROOT = mkdtempSync(join(tmpdir(), 'acm-acceptance-state-'));
process.env.WF_POSTTOOL_STATE_DIR = POSTTOOL_STATE_ROOT;
process.on('exit', () => rmSync(POSTTOOL_STATE_ROOT, { recursive: true, force: true }));

// 租约状态根隔离（内部未决-93③，内部任务-48）：不隔离则装载链⑥的闸 deny 压过 check-careful 的
// ask（既存红）。种子见 helpers/lease-seed.mjs；deny 留痕面由上方既有 WF_INCIDENT_ROOT
// 隔离覆盖（与本块无因果）。
const ROUTING_STATE_ROOT = mkdtempSync(join(tmpdir(), 'acm-accept-routing-state-'));
process.env.WF_ROUTING_STATE_DIR = ROUTING_STATE_ROOT;
process.on('exit', () => rmSync(ROUTING_STATE_ROOT, { recursive: true, force: true }));

/**
 * 读一份 incident 账本里**夹具会话**的记录行数（按来源归因，免疫并行/活跃真实会话的追加）。
 * @param {string} file 账本路径
 * @returns {number} 夹具会话的记录行数
 */
function fixtureLedgerLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /"session":"(acceptance-session|inv2|inv)"/.test(l)).length;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** ZCode 侧的契约工件（内部接口-1 §6 的清单面 + 活跃的钩子声明面）。 */
function zcodeContractArtifacts() {
  const files = [];
  for (const p of PLUGINS) {
    files.push(join(p, '.zcode-plugin', 'plugin.json'));
    // 零钩子插件不产 hooks.json（物化条件分支，research-loop Stage 1）——按磁盘实存收集
    if (existsSync(join(REPO_ROOT, p, 'hooks', 'hooks.json'))) files.push(join(p, 'hooks', 'hooks.json'));
  }
  return files;
}

/** ZCode 侧的纪律资产（钩子脚本 + skill/命令/agent 正文）：适配层绝不该碰。 */
function zcodeContentAssets() {
  const files = [];
  for (const p of PLUGINS) {
    for (const rel of ['hooks', 'skills', 'commands', 'agents']) {
      const dir = join(REPO_ROOT, p, rel);
      if (!existsSync(dir)) continue;
      collectFiles(dir, files);
    }
  }
  return files;
}

/** 递归收集文件（只用 node:fs，不引 glob 库）。 */
function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 不可读目录跳过（fail-soft）
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
}

/** 从 内部接口-1 激活登记表读出「路径 → 登记哈希前 16 位」对（含核心契约工件）。 */
function registeredArtifactHashes() {
  const text = readFileSync(join(REPO_ROOT, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8');
  const re = /\|\s*`?([^|\n]+?)`?\s*\|\s*`?sha256:([0-9a-fA-F]{16})/g;
  const pairs = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim().replace(/`/g, '');
    if (path.startsWith('spec-gate/core')) continue; // core 基线归 verify-core-baseline.mjs
    pairs.push([path, m[2].toLowerCase()]);
  }
  return pairs;
}

/** 按宿主 `validateRuntimeSkill` 的判据实现的伪 skill 注册表。 */
function makeSkillRegistry() {
  const entries = [];
  return {
    entries,
    register(skill) {
      if (typeof skill.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`);
      if (typeof skill.description !== 'string' || skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`);
      if (skill.invocation !== undefined) {
        if (typeof skill.invocation.modelInvocable !== 'boolean' || typeof skill.invocation.userInvocable !== 'boolean') throw new Error(`skill "${skill.name}" bad invocation`);
      }
      if (entries.some((s) => s.name === skill.name)) throw new Error(`duplicate skill "${skill.name}"`);
      entries.push(skill);
      return () => {};
    },
  };
}

/** 按宿主 `normalizeDefinition` 的判据实现的伪命令注册表。 */
function makeCommandRegistry() {
  const entries = [];
  return {
    entries,
    register(def) {
      if (typeof def.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(def.name)) throw new TypeError(`command name "${def.name}" must match`);
      if (typeof def.description !== 'string' || def.description.trim() === '') throw new TypeError('description must not be empty');
      if (typeof def.handler !== 'function') throw new TypeError('handler must be a function');
      if (def.input !== undefined && (typeof def.input.hint !== 'string' || def.input.hint.trim() === '')) throw new TypeError('input hint must not be empty');
      if (entries.some((d) => d.name === def.name)) throw new Error(`duplicate command "${def.name}"`);
      entries.push(def);
      return () => {};
    },
  };
}

/** 真实 spawn 的 shell seam（与 dsh-shell 的请求/spec 契约同形）。
 *  内部任务-311：win32 真实执行器是 PowerShell 5.1（`dsh-subprocess-local` runner），旧 seam 用
 *  `shell:true`（cmd.exe）与真实 runner 不同形，无法承接 `handlerCommandLine` 的 `&` 调用运算符
 *  （内部任务-308/内部未决-243 语义）——按真实 runner 同形化为 `powershell.exe -Command "<line>; exit ..."`。 */
function makeShell() {
  const win = process.platform === 'win32';
  return {
    resolve: (r) => r,
    async execute(spec) {
      const common = {
        cwd: spec.workdir,
        env: { ...process.env, ...(spec.env ?? {}) },
        input: spec.stdin ?? '',
        encoding: 'utf8',
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      };
      const r = win
        ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${spec.command}; exit $LASTEXITCODE`], common)
        : spawnSync(spec.command, { ...common, shell: true });
      return { result: async () => ({ exitCode: r.status ?? undefined, stdout: { text: r.stdout ?? '' }, stderr: { text: r.stderr ?? '' } }) };
    },
  };
}

/** 递归冻结：把交给处理器的负载冻死，任何原地改写都会在严格模式下抛错。 */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const v of Object.values(value)) deepFreeze(v, seen);
  return Object.freeze(value);
}

/** 组装宿主等价 ctx：`shell` 注入 + `skills`/`commands` 经 `get()` 探测（与真实路径同序）。 */
function hostLikeCtx() {
  const listeners = new Map();
  const logger = makeLoggerStub();
  const skillRegistry = makeSkillRegistry();
  const commandRegistry = makeCommandRegistry();
  const shell = makeShell();
  const services = new Map([
    ['shell', shell],
    ['skills', skillRegistry],
    ['commands', commandRegistry],
  ]);
  return {
    shell,
    skillRegistry,
    commandRegistry,
    logger,
    byLevel: (level) => logger.byLevel(level),
    get: (svc) => services.get(svc),
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    effect: () => {},
    async emit(event, ...args) {
      const fns = listeners.get(event) ?? [];
      assert.ok(fns.length > 0, `事件 ${event} 未注册监听器`);
      let out;
      for (const fn of fns) {
        out = await fn(...args);
        // 内部任务-220：pre-step 为 waterfall——上游返回 reject 即短路（真实宿主不会再调用内层监听器；
        // 旧顺序覆盖式替身会让内层监听器覆盖 reject，桥接提示监听加入后该失真会显形）。
        if (event === 'agent/pre-step' && out?.kind === 'reject') break;
      }
      return out;
    },
    listeners,
  };
}

// ── ①–⑤ 装载链 ─────────────────────────────────────────────────────────────

test('装载链①补：cordis.patch.yml 用宿主同一解析器（js-yaml）解出「顶层 insert」形状', () => {
  // 宿主 `dsh-app-boot` 用 `js-yaml` 的 `load`（JSON_SCHEMA + !!js 扩展）解析 patch 文件，
  // 再用 `applyEntryPatches` 应用。这里用**同一解析器**验证我的文件：形状错了当场可见。
  const text = readFileSync(join(COMPAT_ROOT, 'cordis.patch.yml'), 'utf8');
  const parsed = yaml.load(text);
  assert.ok(Array.isArray(parsed), 'patch 文件顶层必须是补丁列表');
  assert.equal(parsed.length, 1, '本包只需一条补丁');
  const patch = parsed[0];
  assert.deepEqual(Object.keys(patch).sort(), ['insert'], '顶层只应有 insert 键');
  assert.ok(Array.isArray(patch.insert), 'insert 值必须是数组');
  assert.equal(patch.insert.length, 1);
  assert.deepEqual(patch.insert[0], { id: 'ai-coding-methodology', name: 'ai-coding-methodology' });
  // 关键语义（对照宿主 applyEntryPatches 源码核实）：`id` 必须在**插入项内**、不在补丁顶层。
  // 宿主 insert 分支的判定是 `if (insert) { if (id) {…插进该 group…} else data.push(...insert) }`
  // ——若把 id 提到补丁顶层，宿主会去找 id 为 ai-coding-methodology 的**组**，找不到就
  // `patch insert: entry "ai-coding-methodology" not found` 并跳过，插件静默不加载。
  // 本断言把「id 必须位于插入项内」钉死在解析结果上。
  assert.equal(patch.id, undefined, 'id 不得出现在补丁顶层（那是"插入到某 group"的语义）');
  assert.equal(patch.insert[0].name, 'ai-coding-methodology', 'name 必须等于宿主可解析的模块说明符');
});

test('装载链①-⑤：包清单 → patch → 入口加载 → apply → 三面注册量与交叉一致性', async () => {
  // 本用例用"节点等价 ctx"驱动 apply，隐含前提是**加载器的 ctx 无 scope**（否则
  // `scopeOf(ctx)` 非空，注册会落到某个 agent 层而非 global）。该前提有两条依据：
  // ① 源码：`dsh-scope` 的 `scopeOf(ctx)` 就是 `return ctx[kScope]`，注释写明
  //    "or `undefined` for an unscoped context"；agent 的 scope 由 `createScope` 打标。
  // ② 观测：`--dump-config` 的层头显示本层与宿主自身 bundle **同为顶层 peer**
  //    （`# == @deepseek-ai/dsh-base` / `# == @deepseek-ai/dsh-headless` / `# == ai-coding-methodology`），
  //    即由同一次加载调用、同一个 profile 级 ctx 装载；宿主的 `dsh-skill-filesystem` 等
  //    也在这一级注册并服务于所有会话。
  // 故本层的 `ctx.skills.register` / `ctx.commands.register` 写进 `layers.global`。
  //
  // 另一条**验收替身的隐含前提**（2026-09-28 第 66 批核实）：本层注册五个事件监听器时
  // **不保存 `ctx.on` 返回的 disposer**，因为 cordis 会把它绑到本插件的 fiber 上自动回收。
  // 源码依据：`cordis/lib/index.js:371` 的 `on()` 结尾 `return this.register(label, hooks,
  // listener, options)`，而 `register`（同文件 :335-343）是
  //     return this.ctx.fiber.effect(() => { hooks[method]({ctx, callback, ...options});
  //                                          return () => this.unregister(hooks, callback); }, label);
  // ——效果登记在 fiber 上，fiber 销毁即撤销。故"不存 disposer"不会泄漏监听器，
  // **插件被卸载/重载时（组合树里有 `dsh-hmr`）不会留下野监听器**。本用例的替身只记录
  // `ctx.on` 的调用、不模拟回收，与该前提一致（回收由宿主 fiber 负责，非本层职责）。
  // ① 包清单（装载器入口判据）
  const pkg = JSON.parse(readFileSync(join(COMPAT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  const engineRange = pkg.dsh.engines.dsh;

  // ② patch（bundle 层）
  const patchPath = resolve(COMPAT_ROOT, pkg.dsh.bundle.patch);
  const patch = readFileSync(patchPath, 'utf8');
  const entry = patch.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  assert.match(entry[1], /^\s*-\s*id:\s*(\S+)\s*$/);
  assert.match(entry[2], /^\s*name:\s*'([^']+)'\s*$/);
  const idFromPatch = entry[1].match(/id:\s*(\S+)/)[1];
  const nameFromPatch = entry[2].match(/name:\s*'([^']+)'/)[1];

  // ③ 按 patch 的 name 解析并加载入口（宿主按 name 解析模块）
  assert.equal(nameFromPatch, pkg.name, 'patch 的 name 必须解析到本包');
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, pkg.main)).href);
  assert.equal(mod.name, idFromPatch, '导出的 name 必须与 patch 的 id 一致（宿主按 id 去重/寻址）');
  assert.deepEqual(mod.inject, ['shell'], '只声明 shell 注入；skills/commands 经 get() 探测');
  assert.equal(typeof mod.apply, 'function');

  // ④ apply（宿主等价 ctx）
  const ctx = hostLikeCtx();
  mod.apply(ctx, { projectDir: REPO_ROOT });

  // ⑤ 三面注册量 + 事件面 + 交叉一致性
  assert.equal(ctx.skillRegistry.entries.length, 32, '六插件 32 份 SKILL.md 全部注册');
  assert.equal(ctx.commandRegistry.entries.length, 9, '六插件 9 条命令全部注册（research-loop 零命令）');
  assert.deepEqual(
    [...ctx.listeners.keys()].sort(),
    ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/execute', 'tools/post-execute', 'tools/pre-execute'],
  );
  // skill ↔ 命令交叉一致：带 skills 薄指针的命令，其目标必须在已注册 skill 集合里
  // （`workflow-feature-dev` 是跨 7 个 skill 的编排命令、`spec-gate-evidence`/`init`
  // 直接调 CLI，三者按设计无单一 skill 指针，故只校验"有指针者必须落地"）。
  const skillNames = new Set(ctx.skillRegistry.entries.map((s) => s.name));
  const pointed = ctx.commandRegistry.entries.filter((d) => d.name !== 'workflow-feature-dev');
  assert.ok(pointed.length > 0);
  assert.ok(skillNames.has('spec-gate-gate') && skillNames.has('spec-gate-spec-writing') && skillNames.has('team-governance-agent-eval'),
    '命令薄指针的目标 skill 必须在注册集合内');
  // 日志必须如实报告三面
  const log = ctx.byLevel('info').join('\n');
  assert.match(log, /注册 skill 32 条/);
  assert.match(log, /注册命令 9 条/);
  assert.match(log, /注册事件|could not|已适配插件/);
  assert.deepEqual(ctx.byLevel('warn'), [], `apply 期间不应有告警：${JSON.stringify(ctx.byLevel('warn'))}`);
  assert.ok(engineRange.length > 0);
});

test('装载链①.5：Config schema 用宿主真实 schemastery 解析——默认值齐备、类型严格', async () => {
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  assert.ok(mod.Config, '应导出 Config schema（宿主据此校验类型并派生表单）');
  // 默认值：宿主在未配置时把空对象解析成完整配置。2026-10-22 内部任务-201 起
  // `agentControlBridge` 是 `.volatile()` 引用（运行时可经插件页配置卡片修改），
  // 故按 `.get()` 断言当前值；其余四字段仍为普通值。
  const defaults = mod.Config({});
  assert.deepEqual(defaults.pluginRoots, {});
  assert.equal(defaults.projectDir, '');
  assert.equal(defaults.startTurn, true);
  assert.equal(defaults.mountAgents, false);
  assert.equal(typeof defaults.agentControlBridge.get, 'function', 'agentControlBridge 应为 volatile 引用');
  assert.equal(defaults.agentControlBridge.get(), false);
  // 部分配置：只给一个键，其余取默认
  const partial = mod.Config({ pluginRoots: { workflow: 'D:/x/workflow' }, startTurn: false });
  assert.deepEqual(partial.pluginRoots, { workflow: 'D:/x/workflow' });
  assert.equal(partial.projectDir, '');
  assert.equal(partial.startTurn, false);
  assert.equal(partial.mountAgents, false);
  assert.equal(partial.agentControlBridge.get(), false);
  // 类型严格：坏类型必须被拒（否则宿主设置面板写入的垃圾会静默生效）
  assert.throws(() => mod.Config({ startTurn: 'yes' }), /expected boolean/);
  assert.throws(() => mod.Config({ mountAgents: 'yes' }), /expected boolean/);
  assert.throws(() => mod.Config({ agentControlBridge: 'yes' }), /expected boolean/);
  // schema 自身可序列化（宿主渲染设置项需要），且字段名可见
  const dump = JSON.stringify(mod.Config.toJSON());
  assert.match(dump, /pluginRoots/);
  assert.match(dump, /startTurn/);
  assert.match(dump, /插件名/, '字段说明应随 schema 出给宿主设置面');
});

// ── ⑥ 五事件真实进程驱动 ────────────────────────────────────────────────────
test('装载链⑥：五个事件全部走真实钩子进程并产出预期决策', async () => {
  seedNullBucketLease(REPO_ROOT); // 内部未决-93③：闸见 null 桶租约即静默放行，护栏决策浮出
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  mod.apply(ctx, { projectDir: REPO_ROOT });

  const injected = [];
  const steered = [];
  const agent = {
    session: { header: { id: 'acceptance-session', cwd: REPO_ROOT } },
    inject: (m) => injected.push(m),
    steer: (m) => steered.push(m),
    followup: () => {},
  };

  // SessionStart：created 只执行钩子、不再 inject；首轮 pre-step 追加 messages（内部任务-173）
  await ctx.emit('agent/created', { agent, source: 'startup' });
  assert.equal(injected.length, 0, 'SessionStart 不得再走 agent.inject');
  const firstPreStep = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [{ content: [{ type: 'text', text: '帮我加一个导出功能' }] }], signal: undefined }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  const delivered = (firstPreStep.messages ?? []).find((m) => /路由表/.test((m.content ?? []).map((b) => b?.text ?? '').join('')));
  assert.ok(delivered, '首轮 pre-step 必须投递元技能全文');
  const deliveredText = (delivered.content ?? []).map((b) => b?.text ?? '').join('');
  assert.ok(deliveredText.length > 1000, '投递的是元技能全文而非摘要');
  assert.match(deliveredText, /路由表/, '投递体含路由表');
  // 真机资产面同样钉身份：这条消息会被宿主原样 append 成会话事件（2026-09-29 阶段 A 评审意见 testing#6）
  assert.match(delivered.id, IDENTIFIED_ID_RE, '真机 SessionStart 投递消息必须是 identified message');

  // PreToolUse：真实护栏（HIGH 危险命令 → deny，文案为 ZCode 原文）
  const denied = await ctx.emit(
    'tools/pre-execute',
    deepFreeze({ name: 'pwsh', arguments: { command: 'rm -rf /' }, agent, callId: 'c1', signal: undefined }),
    async () => ({ kind: 'continue' }),
  );
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /\[careful\]\[HIGH\]/, `拒因应为护栏原文，实际：${denied.reason}`);

  // PreToolUse：MEDIUM 危险命令 → ask
  const asked = await ctx.emit(
    'tools/pre-execute',
    deepFreeze({ name: 'pwsh', arguments: { command: 'git clean -fd' }, agent, callId: 'c2', signal: undefined }),
    async () => ({ kind: 'continue' }),
  );
  assert.equal(asked.kind, 'ask');

  // PreToolUse：干净命令 → 委托下游（零输出契约）
  let nextCalled = 0;
  const clean = await ctx.emit(
    'tools/pre-execute',
    deepFreeze({ name: 'pwsh', arguments: { command: 'node --version' }, agent, callId: 'c3', signal: undefined }),
    async () => {
      nextCalled += 1;
      return { kind: 'continue' };
    },
  );
  assert.equal(clean.kind, 'continue');
  assert.equal(nextCalled, 1);

  // UserPromptSubmit：真实路由提醒钩子（受节流控制，故只断言"不阻断且委托下游"）
  // 内部任务-173：UPS 之后注册了 SessionStartDelivery（本会话首轮已投递、槽已删）⇒ 串行 emit 下 next 被调用 2 次
  let preStepNext = 0;
  const entered = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [{ content: [{ type: 'text', text: '帮我加一个导出功能' }] }], signal: undefined }),
    async () => {
      preStepNext += 1;
      return { kind: 'enter', messages: [] };
    },
  );
  assert.equal(preStepNext, 3, 'UserPromptSubmit 与 SessionStartDelivery 各委托下游一次（DEV-220：BridgeChannelHint 纯直通 +1）');
  assert.equal(entered.kind, 'enter');

  // PostToolUse：真实自察记录钩子（纯记录、零输出）→ 委托下游
  // 内部任务-59（内部未决-60）：本层自本批起只对**已派发**的调用派发 PostToolUse 钩子 ⇒ 先经派发点登记
  // （同一 exec 对象），否则本用例退化为"未派发 ⇒ 不派发钩子"的另一分支，真实钩子覆盖丢失。
  let postNext = 0;
  const postExec = deepFreeze({ name: 'pwsh', arguments: { command: 'node --version' }, agent, callId: 'c4', signal: undefined });
  await ctx.emit('tools/execute', postExec, async () => ({ kind: 'continue' }));
  const post = await ctx.emit(
    'tools/post-execute',
    postExec,
    deepFreeze({ content: [{ type: 'text', text: 'v24.19.0' }] }),
    async () => {
      postNext += 1;
      return { kind: 'continue' };
    },
  );
  assert.equal(postNext, 1);
  assert.equal(post.kind, 'continue');

  // Stop：真实三钩（task-recap / learnings-recap 注入、verify-gate 未声明项目时静默退 0）。
  // 内部任务-173：真实钩子在隔离 HOME 下可能零输出（旧断言曾由 SessionStart inject 凑数），本步只钉"Stop 面执行且不冒错"。
  await assert.doesNotReject(() => ctx.emit('agent/turn-stopping', deepFreeze({ agent, signal: undefined })));
  assert.ok(!ctx.byLevel('warn').some((w) => /Stop 处置失败/.test(String(w))), 'Stop 通道不得冒错');
});

test('装载链⑥补：命令处理器把渲染后的正文入队为下一轮提示词（真实命令正文）', async () => {
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  mod.apply(ctx, { projectDir: REPO_ROOT });

  const enqueued = [];
  const agent = { session: { header: { id: 's', cwd: REPO_ROOT } }, followup: (m) => enqueued.push(m) };
  const def = ctx.commandRegistry.entries.find((d) => d.name === 'spec-gate-gate');
  assert.ok(def, 'spec-gate-gate 命令必须在册');
  const result = def.handler(deepFreeze({ agent, rawInput: '--task-id TASK-ACCEPT' }));
  assert.equal(result.kind, 'success');
  assert.equal(enqueued.length, 1);
  const text = enqueued[0].content[0].text;
  assert.match(text, /TASK-ACCEPT/, '命令正文里的 $ARGUMENTS 必须被真实输入替换');
  assert.deepEqual(enqueued[0].source, { kind: 'user' });
  // 入队消息落地时是会话里的 `user/message` 事件本体：宿主校验要求 data.id 非空
  // （缺 id ⇒ 整份日志在下次加载被拒）。2026-09-29 第 107 批（内部任务-DSHID-1）补钉。
  assert.match(
    enqueued[0].id,
    IDENTIFIED_ID_RE,
    '入队消息必须是 identified message（uuid 形态 id）',
  );
});

// ── ⑦ ZCode 零影响不变量 ────────────────────────────────────────────────────

test('不变量⑦：IF-HOST-1 登记的十一个契约工件哈希与登记值逐一相符', { skip: HAS_IF_HOST ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const pairs = registeredArtifactHashes();
  assert.equal(pairs.length, 11, `IF-HOST-1 应登记 11 个契约工件（条件十一行表——research-loop 零钩子无 hooks 行，ADR-047），读到 ${pairs.length}`);
  for (const [rel, expected] of pairs) {
    const file = join(REPO_ROOT, rel);
    assert.ok(existsSync(file), `登记工件不存在：${rel}`);
    assert.equal(sha256(file).slice(0, 16), expected, `${rel} 哈希漂移`);
  }
});

test('不变量⑦：apply 不触碰任何 ZCode 资产（契约工件与内容资产的哈希+mtime 前后一致）', async () => {
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const watched = [...new Set([...zcodeContractArtifacts(), ...zcodeContentAssets()].map((p) => resolve(REPO_ROOT, p)))];
  assert.equal(watched.length, 86, `受监视资产应恰为六插件全量内容（86 份；实际 ${watched.length}）`);
  const before = new Map(watched.map((f) => [f, { hash: sha256(f), mtime: statSync(f).mtimeMs }]));

  const ctx = hostLikeCtx();
  mod.apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'inv', cwd: REPO_ROOT } }, inject() {}, steer() {}, followup() {} };
  await ctx.emit('agent/created', { agent, source: 'startup' });
  await ctx.emit('tools/pre-execute', deepFreeze({ name: 'pwsh', arguments: { command: 'rm -rf /' }, agent }), async () => ({ kind: 'continue' }));
  // 内部任务-59（内部未决-60）：PostToolUse 自本批起只对已派发调用派发钩子 ⇒ 先经派发点登记（同一 exec 对象），
  // 使本不变量继续覆盖「真实自察钩子运行期间不得改动 ZCode 资产」这一原意（否则该面静默退化为空转）。
  const invExec = deepFreeze({ name: 'pwsh', arguments: {}, agent });
  await ctx.emit('tools/execute', invExec, async () => ({ kind: 'continue' }));
  await ctx.emit('tools/post-execute', invExec, deepFreeze({ content: 'x' }), async () => ({ kind: 'continue' }));
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent }));

  const drift = [];
  for (const [file, snapshot] of before) {
    const now = { hash: sha256(file), mtime: statSync(file).mtimeMs };
    if (now.hash !== snapshot.hash || now.mtime !== snapshot.mtime) drift.push({ file: file.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', ''), ...snapshot, ...now });
  }
  assert.deepEqual(drift, [], `apply 及其钩子运行期间 ZCode 资产被改动：${JSON.stringify(drift.slice(0, 5))}`);
});

test('抽取缓存判据：身份三分量 + 新鲜度语义 + 内容哈希（OPEN-41 / OPEN-42①②，纯函数面）', async () => {
  // 为什么要有（2026-09-29 内部任务-OPEN3942-1 / 内部规格 内部未决-42）：dsh-engine 的缓存复用
  // 判据原本只有「marker 是否存在 + size:mtimeMs 指纹」（内部任务-DSHADAPTER-3 落 内部未决-41），仍留两条残余——
  // ①来源路径分量缺失：`DSH_APP_ROOT` 改指失效根时指纹变 undefined，"根失效"与"未装 DSH"不可分辨；
  // ②同 size 同 mtime 的宿主升级仍命中。本用例把身份三分量（appRoot 路径 / 指纹 / 内容哈希）与
  // 新鲜度语义钉在纯函数面上；调用点的四态集成用例见下一个用例（内部任务-OPEN3942-1 步骤 2）。
  const engine = await import('./helpers/dsh-engine.mjs');
  assert.equal(typeof engine.cacheIdentity, 'function', 'dsh-engine 应导出 cacheIdentity（OPEN-42①）');
  assert.equal(typeof engine.contentHash, 'function', 'dsh-engine 应导出 contentHash（OPEN-42②）');
  assert.equal(typeof engine.isCacheFresh, 'function', 'dsh-engine 应导出 isCacheFresh');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-fp-'));
  try {
    const file = join(dir, 'app.asar');
    writeFileSync(file, 'a');
    const fp1 = engine.asarFingerprint(file);
    assert.match(fp1, /^\d+:\d+$/, `指纹应是 size:mtimeMs 形态，实为 ${fp1}`);
    assert.equal(engine.asarFingerprint(file), fp1, '同一文件两次指纹应相等');
    const h1 = engine.contentHash(file);
    assert.match(String(h1), /^[0-9a-f]{16}$/, '内容哈希应是 16 位十六进制');
    writeFileSync(file, 'abcdef');
    assert.notEqual(engine.asarFingerprint(file), fp1, '内容变化后指纹应改变（size 分量）');
    assert.notEqual(engine.contentHash(file), h1, '内容哈希应随内容变化（OPEN-42② 的第二判据）');
    assert.equal(engine.contentHash(join(dir, 'missing.asar')), undefined, '不可读路径的内容哈希应 undefined（不抛）');
    assert.equal(engine.asarFingerprint(join(dir, 'missing.asar')), undefined, '不可读路径的指纹应 undefined（不抛）');
    const idA = engine.cacheIdentity('C:/rootA', fp1, h1);
    const idB = engine.cacheIdentity('C:/rootB', fp1, h1);
    assert.notEqual(idA, idB, '路径分量不同 ⇒ 身份不同（OPEN-42① 的核心）');
    assert.notEqual(idA, engine.cacheIdentity('C:/rootA', fp1, 'abcd1234'), '内容哈希分量不同 ⇒ 身份不同');
    assert.equal(engine.isCacheFresh(undefined, idA), false, '无戳不得判新鲜（须重抽）');
    assert.equal(engine.isCacheFresh(idA, idA), true, '身份全等才新鲜');
    assert.equal(engine.isCacheFresh('1:1', idA), false, '身份失配即不新鲜（宿主升级/换根路径）');
    assert.equal(engine.isCacheFresh(idA, idB), false, '路径分量失配即不新鲜');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 造一枚最小桩 asar（**按 asar 规范布局**：16 字节头 + `uint32LE(12)`=headerSize + JSON 头 +
 * **4 字节对齐补齐** + 每文件字节紧接其后，即 `16 + headerSize + pad + offset`）。
 *
 * 为什么改成"规范布局 + 逐字节断言"（2026-09-29 DSH 0.2.0-rc.2 批次）：本函数原先在头与数据之间
 * 插 `Buffer.alloc(2)`，与 `extractInto()` 当年那条 `+ 2` 偏移**同源假设**——桩与实现互相印证，
 * 于是"真实 asar 被错位 2 字节"这件事在整个套件里无处可现（真实 asar 解析只在 `loadEngine` 的
 * 既有用例里跑，而那几处宿主不可得时走跳过分支）。规范布局的桩配上**逐字节相等**的断言后，
 * 抽取偏移一旦再被写错（多/少一个字节），本用例立即红。
 *
 * **2026-10-01 再修（macOS 批次机，同族第三例）**：头 JSON 之后按 pickle 纪律补齐到 4 字节边界，
 * 桩原先「头后紧接数据、无填充」只在 `header.length % 4 === 0` 时与真实 asar 同形——本机 DSH
 * 的 app.asar 头长 %4=2，真实数据比"无填充"假设晚 2 字节，抽取器照旧式读法取到的是前一文件尾部
 * （10923/10923 个文件全残损）。桩必须与真实布局同形，否则它保护的正是它所掩盖的错。同时给每个
 * 条目补 `integrity.hash`（真实 asar 每个条目都带），让抽取器的**内容自证**分支进机器验证面。
 *
 * 边界（如实标注）：桩仍只用于验证**缓存状态机**与抽取字节保真；真实 asar 的装载面由
 * `loadEngine` 的既有用例覆盖（其中 内部未决-40 钉子宿主不可得时 fail-loud）。桩内**必须**带
 * `stub-probe/package.json` 的 `{"type":"module"}`：抽取器会写一个无 `type` 字段的
 * `<cache>/package.json`，只靠 Node 的模块语法探测在旧版本上会判 CJS 解析失败 ⇒ `loadEngine`
 * 返回 `undefined`，用例报错而非显式失败。
 * @param {string} root 宿主根（写入 `<root>/resources/app.asar`）
 * @param {Record<string, string>} files 相对 `dsh/` 的文件表（键用正斜杠）
 * @returns {string} asar 路径
 */
function writeStubAsar(root, files) {
  const entries = [];
  let offset = 0;
  for (const [rel, text] of Object.entries(files)) {
    const bytes = Buffer.from(text, 'utf8');
    entries.push({ rel, bytes, offset });
    offset += bytes.length;
  }
  const tree = {};
  for (const e of entries) {
    const parts = e.rel.split('/');
    let node = tree;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= { files: {} };
      node = node[p].files;
    }
    node[parts.at(-1)] = {
      size: e.bytes.length,
      offset: e.offset,
      integrity: { algorithm: 'SHA256', hash: createHash('sha256').update(e.bytes).digest('hex') },
    };
  }
  const header = Buffer.from(JSON.stringify({ files: { dsh: { files: tree } } }), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(header.length, 12);
  const pad = (4 - (header.length % 4)) % 4;
  mkdirSync(join(root, 'resources'), { recursive: true });
  const asar = join(root, 'resources', 'app.asar');
  // 头 JSON 之后按 pickle 纪律补齐到 4 字节边界（真实 asar 同形）；偏移若被写错，逐字节断言必红
  writeFileSync(asar, Buffer.concat([head, header, Buffer.alloc(pad), ...entries.map((e) => e.bytes)]));
  return asar;
}

test('抽取缓存判据（调用点）：临时根 + 桩 asar 四态 + 路径分量失配不复用（OPEN-42）', async (t) => {
  // 为什么要有（2026-09-29 内部任务-OPEN3942-1 / 内部规格 内部未决-42③）：纯函数用例测不到
  // "抽取后忘写戳""判据误改成或条件""根换掉仍复用"这三条静默失去收益的路径，故把**调用点**
  // `ensureEngineCache()` 与 `loadEngine()` 放进临时根 + 桩 asar 的端到端用例。
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-cache-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const rootA = join(tmp, 'rootA');
  const rootB = join(tmp, 'rootB');
  mkdirSync(rootB, { recursive: true });
  const cache = join(tmp, 'cache');
  const prevApp = process.env.DSH_APP_ROOT;
  const prevCache = process.env.DSH_ENGINE_CACHE_DIR;
  process.env.DSH_APP_ROOT = rootA;
  process.env.DSH_ENGINE_CACHE_DIR = cache;
  try {
    const markerRel = 'node_modules/@deepseek-ai/cordis/lib/index.js';
    const probeRel = 'node_modules/@deepseek-ai/stub-probe/lib/index.js';
    const marker = () => readFileSync(join(cache, markerRel), 'utf8');
    // 三个状态用**逐字节同长**的标记串（'aa' → 'bbbb' → 'cccc'）：'bbbb' 变更总尺寸（指纹失配），
    // 'cccc' 与 'bbbb' 同长（尺寸不变），配合 utimes 还原 mtime 即"同指纹同时间戳、内容变"。
    const stub = (tag) => ({
      [markerRel]: `export const STUB_MARKER = "${tag}";`,
      [probeRel]: `export const STUB_MARKER = "${tag}";`,
      // 常量项：让 stub-probe 的模块格式自明（见 writeStubAsar 的边界注），且不随 tag 改变尺寸
      'node_modules/@deepseek-ai/stub-probe/package.json': '{"name":"stub-probe","type":"module"}',
    });
    writeStubAsar(rootA, stub('aa'));
    assert.equal(engine.ensureEngineCache().mode, 'extracted', '首次必须抽取');
    // **逐字节相等**（不是 /"aa"/ 这类包含式断言：错位 2 字节的产物同样能匹配包含式断言）
    assert.equal(marker(), 'export const STUB_MARKER = "aa";', '抽取必须字节保真（偏移写错即红）');
    assert.equal(engine.ensureEngineCache().mode, 'reused', '身份全等必须复用（不重抽）');
    // 指纹分量失配（size 变）⇒ 重抽
    const asar = join(rootA, 'resources', 'app.asar');
    writeStubAsar(rootA, stub('bbbb'));
    // 先把 mtime 钉到**整秒**（整数毫秒）、**再**抽取：这样戳里记的指纹与后面还原出的指纹才可能是同一个
    // （聚焦复核阻塞项：钉戳若晚于抽取，戳记的是带毫秒小数的旧指纹，④ 场景会走"指纹失配 → 重抽"，
    //  内容哈希分支永不被咨询 ⇒ 即使把哈希判据整支删掉，用例照样绿——判据力为零）
    const pinned = Math.floor(Date.now() / 1000);
    utimesSync(asar, pinned, pinned);
    assert.equal(engine.ensureEngineCache().mode, 'extracted');
    assert.equal(marker(), 'export const STUB_MARKER = "bbbb";', '指纹失配重抽后仍须字节保真');
    // 内容哈希分量：size 与 mtime 都不变、内容变 ⇒ 仍须重抽（内部未决-42② 的残余路径）
    const st = statSync(asar);
    assert.equal(Number.isInteger(st.mtimeMs), true, '前置条件：mtime 必须是整毫秒（否则还原不可判）');
    const fpBefore = engine.asarFingerprint(asar);
    writeStubAsar(rootA, stub('cccc'));
    // 还原用**数值秒**口径（可带小数），不经 Date——Date 会把毫秒小数截断，与 `Math.round(mtimeMs)` 口径不符
    utimesSync(asar, st.atimeMs / 1000, st.mtimeMs / 1000);
    assert.equal(statSync(asar).size, st.size, '前置条件：size 必须未变');
    assert.equal(engine.asarFingerprint(asar), fpBefore, '前置条件：指纹（size:mtimeMs）必须未变，否则测的不是内容哈希');
    // 硬锁（聚焦复核建议）：戳的第二段必须等于当前指纹——否则上面的抽取出身于另一个指纹，
    // 本场景会走"指纹失配"分支、内容哈希判据不被咨询，断言就退化为无条件假绿。
    // 戳名与"第 2 段＝指纹"都与实现耦合（`STAMP_NAME` 从 helper 导入；分量顺序见 `cacheIdentity`）。
    assert.equal(
      readFileSync(join(cache, engine.STAMP_NAME), 'utf8').trim().split('|')[1],
      fpBefore,
      '前置条件：戳的指纹段必须与当前指纹相同（否则内容哈希分支不会被咨询）',
    );
    assert.equal(engine.ensureEngineCache().mode, 'extracted', '同指纹同尺寸、内容变 ⇒ 必须由内容哈希判据重抽');
    assert.equal(marker(), 'export const STUB_MARKER = "cccc";', '内容哈希判据重抽后仍须字节保真');
    // 调用点接线：loadEngine 必须真从抽取缓存导入（stub-probe 不是本机可解析的包名）
    assert.equal((await engine.loadEngine('@deepseek-ai/stub-probe'))?.STUB_MARKER, 'cccc');
    // 路径分量失配 ⇒ 不复用旧根副本（内部未决-42①）
    process.env.DSH_APP_ROOT = rootB;
    const other = engine.ensureEngineCache();
    assert.equal(other.mode, 'unavailable', 'DSH_APP_ROOT 指向无 asar 的另一根 ⇒ 不得复用旧根副本');
    assert.equal(other.dir, undefined);
    // 同根 asar 消失（缓存仍热）⇒ 保守复用但必须留诊断（内部未决-42①）；用 console.warn 探针断言**真打出**
    process.env.DSH_APP_ROOT = rootA;
    rmSync(asar);
    const warnings = [];
    const prevWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let stale;
    try {
      stale = engine.ensureEngineCache();
    } finally {
      console.warn = prevWarn;
    }
    assert.equal(stale.mode, 'reused-unverified', 'asar 不可得但路径分量一致 ⇒ 保守复用（可移植姿态不倒退）');
    assert.match(String(stale.note), /未经校验/, '保守复用必须在决策对象里留下原因');
    assert.ok(warnings.some((w) => /未经校验/.test(w)), '保守复用必须真打一次诊断，不是只把文本塞进返回值（首轮评审视角二 1 号阻塞项）');
    // ⑦/⑧ `hash === undefined` 支（阶段复审 内部模块-1）：本批唯一的防退化出口此前零覆盖——asar 可 stat 而内容
    // 读不到时必须 fail-closed（若日后被改回"复用旧副本"，本场景即红）。用**目录**当 asar：`statSync`
    // 成功拿到指纹，`readFileSync` 抛 EISDIR ⇒ 哈希 undefined；手写戳让身份前两段匹配，才进得了哈希支。
    const rootC = join(tmp, 'rootC');
    const cache2 = join(tmp, 'cache2');
    mkdirSync(join(rootC, 'resources', 'app.asar'), { recursive: true });
    mkdirSync(join(cache2, 'node_modules', '@deepseek-ai', 'cordis', 'lib'), { recursive: true });
    writeFileSync(join(cache2, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'), 'export const STUB_MARKER = "x";');
    const asarC = join(rootC, 'resources', 'app.asar');
    const fpC = engine.asarFingerprint(asarC);
    assert.equal(typeof fpC, 'string', '前置条件：目录也能拿到 size:mtimeMs 指纹');
    assert.equal(engine.contentHash(asarC), undefined, '前置条件：目录的内容读不到（EISDIR）');
    writeFileSync(join(cache2, engine.STAMP_NAME), `${engine.cacheIdentity(rootC, fpC, 'deadbeefdeadbeef')}\n`);
    process.env.DSH_APP_ROOT = rootC;
    process.env.DSH_ENGINE_CACHE_DIR = cache2;
    const broken = engine.ensureEngineCache();
    assert.equal(broken.mode, 'unavailable', '可 stat 而内容不可读 ⇒ 必须 fail-closed（不得复用旧副本）');
    assert.equal(broken.dir, undefined);
    assert.match(String(broken.note), /内容不可读/, '诊断必须点名"内容不可读"');
    // 维护提示（聚焦复核 W-d）：`warnOnce` 是**进程级**标志，本探针只断言"这次真发射"。当前安全——
    // 本文件没有别的 `ensureEngineCache`/`loadEngine` 调用者（实测 grep），且上面那次
    // `loadEngine('@deepseek-ai/stub-probe')` 走 `reused`、不触发警告；失败方向是**假红**而非假绿。
    // 日后若同文件前面新增会触发 `reused-unverified` 的用例，本探针需改成计数式断言。
  } finally {
    if (prevApp === undefined) delete process.env.DSH_APP_ROOT; else process.env.DSH_APP_ROOT = prevApp;
    if (prevCache === undefined) delete process.env.DSH_ENGINE_CACHE_DIR; else process.env.DSH_ENGINE_CACHE_DIR = prevCache;
  }
});

test('抽取内容自证：asar 条目 integrity.hash 失配 ⇒ fail-closed 不发布残树（2026-10-01 错位族第三例）', async (t) => {
  // 为什么要有：抽取偏移在 2026-09-29（+2 少 2 字节）与 2026-10-01（头 JSON 未按 4 字节对齐补齐，
  // 少 2 字节）两次出错，症状都是**整个抽取树静默残损**（文件照写、用例照绿或红在无关处）。桩 asar
  // 现在带 `integrity.hash`（真实 asar 10923/10923 个条目都有），抽取器读后即比对；本用例造一枚
  // **内容与头内哈希不符**的 asar，断言抽取器拒绝发布（`unavailable`）而不是把残树交出去。
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-integrity-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'root');
  const cache = join(tmp, 'cache');
  const prevApp = process.env.DSH_APP_ROOT;
  const prevCache = process.env.DSH_ENGINE_CACHE_DIR;
  process.env.DSH_APP_ROOT = root;
  process.env.DSH_ENGINE_CACHE_DIR = cache;
  try {
    const markerRel = 'node_modules/@deepseek-ai/cordis/lib/index.js';
    const markerText = 'export const STUB_MARKER = "aa";';
    const asar = writeStubAsar(root, {
      [markerRel]: markerText,
      'node_modules/@deepseek-ai/stub-probe/package.json': '{"name":"stub-probe","type":"module"}',
    });
    // 正向前置：未篡改时抽取成功（否则下面的红态可能来自别的失败原因）
    assert.equal(engine.ensureEngineCache().mode, 'extracted', '前置条件：未篡改的桩必须能抽取');
    assert.equal(readFileSync(join(cache, markerRel), 'utf8'), markerText);
    // 篡改**数据区**（头内哈希不动）：同长度替换 `"aa"` → `"bb"` ⇒ 尺寸不变、只有内容与哈希不符
    const bytes = readFileSync(asar);
    const at = bytes.indexOf(Buffer.from('"aa"', 'utf8'));
    assert.ok(at > 0, '前置条件：桩内容必须能在 asar 里定位');
    bytes.write('"bb"', at, 'utf8');
    writeFileSync(asar, bytes);
    rmSync(cache, { recursive: true, force: true }); // 清缓存逼重抽（身份也会随 mtime 变，清掉更直白）
    const r = engine.ensureEngineCache();
    assert.equal(r.mode, 'unavailable', '内容与头内 integrity.hash 不符 ⇒ 不得发布抽取树（fail-closed）');
    assert.equal(r.dir, undefined, 'fail-closed 时不得给出目录（否则调用方会拿残树当引擎）');
    assert.equal(existsSync(join(cache, markerRel)), false, '残树不得落进缓存');
  } finally {
    if (prevApp === undefined) delete process.env.DSH_APP_ROOT; else process.env.DSH_APP_ROOT = prevApp;
    if (prevCache === undefined) delete process.env.DSH_ENGINE_CACHE_DIR; else process.env.DSH_ENGINE_CACHE_DIR = prevCache;
  }
});

test('publishDir（直测）：同身份成品优先 / 异身份成品不得被复用 / 无 marker 半成品须清掉后发布 / 空目标直接发布（OPEN-43）', async () => {
  // 为什么要有（2026-09-29 内部任务-OPEN4344-1 计划步骤 1）：发布原语的判定序是 内部未决-43 并发修复的核心，
  // 而整链并发用例的红态取决于交错运气 ⇒ 直测四条判据给出**确定性**红态（含 P1 的判别力：
  // "只认 marker"的实现在第①条上必红——默认缓存目录是机器级单例，跨 DSH_APP_ROOT 会拿别根的树冒充 extracted）。
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-publish-'));
  try {
    const markerRel = join('node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
    const mkTree = (dir, tag, stampText) => {
      mkdirSync(dirname(join(dir, markerRel)), { recursive: true });
      writeFileSync(join(dir, markerRel), `TAG=${tag}`);
      if (stampText !== undefined) writeFileSync(join(dir, engine.STAMP_NAME), `${stampText}\n`);
      return dir;
    };
    const readTag = (dir) => readFileSync(join(dir, markerRel), 'utf8');
    // ① 异身份完整成品 ⇒ 不得复用（只认 marker 的实现会在此红）
    const outA = join(tmp, 'a', 'cache');
    mkTree(outA, 'X', 'rootX|1:2|deadbeefdeadbeef');
    const stagingA = mkTree(join(tmp, 'a', 'stagingY'), 'Y', 'rootY|3:4|feedfacefeedface');
    assert.equal(engine.publishDir(stagingA, outA, 'rootY|3:4|feedfacefeedface'), true);
    assert.equal(readTag(outA), 'TAG=Y', '异身份成品必须被换成本身份');
    assert.equal(readFileSync(join(outA, engine.STAMP_NAME), 'utf8').trim(), 'rootY|3:4|feedfacefeedface');
    // ② 同身份成品 ⇒ 复用 + 丢弃 staging
    const outB = join(tmp, 'b', 'cache');
    mkTree(outB, 'Y', 'rootY|3:4|feedfacefeedface');
    const stagingB = mkTree(join(tmp, 'b', 'stagingY2'), 'Y2', 'rootY|3:4|feedfacefeedface');
    assert.equal(engine.publishDir(stagingB, outB, 'rootY|3:4|feedfacefeedface'), true);
    assert.equal(readTag(outB), 'TAG=Y', '同身份成品保留原树');
    assert.equal(existsSync(stagingB), false, '同身份时 staging 必须被丢弃');
    // ③ 无 marker 半成品 ⇒ 清掉后发布本身份
    const outC = join(tmp, 'c', 'cache');
    mkdirSync(join(outC, 'node_modules', 'leftover'), { recursive: true });
    writeFileSync(join(outC, 'node_modules', 'leftover', 'x.js'), 'stale');
    const stagingC = mkTree(join(tmp, 'c', 'stagingZ'), 'Z', 'rootZ|5:6|cafebabecafebabe');
    assert.equal(engine.publishDir(stagingC, outC, 'rootZ|5:6|cafebabecafebabe'), true);
    assert.equal(readTag(outC), 'TAG=Z', '半成品目标必须换成本身份');
    assert.equal(existsSync(join(outC, 'node_modules', 'leftover', 'x.js')), false, '半成品残留必须被清掉');
    // ④ 空目标 ⇒ 直接发布
    const outD = join(tmp, 'd', 'cache');
    const stagingD = mkTree(join(tmp, 'd', 'stagingW'), 'W', 'rootW|7:8|0123456789abcdef');
    assert.equal(engine.publishDir(stagingD, outD, 'rootW|7:8|0123456789abcdef'), true);
    assert.equal(readTag(outD), 'TAG=W', '空目标直接发布本次 staging');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('抽取缓存（并发发布）：异身份多进程打同一缓存 ⇒ 不降级、不混合、异身份不被复用（OPEN-43）', async (t) => {
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-race-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // 四个**不同身份**的宿主根（各自桩 asar 的 marker 内容带自己的 tag）；前三个并发，第四个供父进程断言
  const roots = ['A', 'B', 'C', 'P'].map((tag) => {
    const root = join(tmp, `root${tag}`);
    writeStubAsar(root, {
      'node_modules/@deepseek-ai/cordis/lib/index.js': `export const STUB_MARKER = "${tag}";`,
      'node_modules/@deepseek-ai/stub-probe/package.json': '{"name":"stub-probe","type":"module"}',
    });
    return { tag, root };
  });
  const cache = join(tmp, 'cache');
  const markerRel = join('node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
  const markerOfCache = () => readFileSync(join(cache, markerRel), 'utf8');
  const helperHref = new URL('./helpers/dsh-engine.mjs', import.meta.url).href;
  const child = [
    `const m = await import(${JSON.stringify(helperHref)});`,
    'const d = m.ensureEngineCache();',
    'console.log(JSON.stringify({ mode: d.mode, dir: d.dir }));',
    // 按 mode 定退出码（否则 unavailable 也 exit 0、断言恒真）
    'process.exitCode = d.mode === "unavailable" || !d.dir ? 3 : 0;',
  ].join('\n');
  const runs = await Promise.all(
    roots.slice(0, 3).map(
      ({ root }) =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, ['--input-type=module', '-e', child], {
            env: { ...process.env, DSH_APP_ROOT: root, DSH_ENGINE_CACHE_DIR: cache },
          });
          let out = '';
          p.stdout.setEncoding('utf8');
          p.stderr.setEncoding('utf8');
          p.stdout.on('data', (c) => (out += c));
          p.stderr.on('data', (c) => (out += `\n[stderr] ${c}`));
          p.on('error', (error) => resolve({ code: -1, out: `${out}\nspawn error: ${error?.message ?? error}` }));
          p.on('close', (code) => resolve({ code, out }));
        }),
    ),
  );
  for (const r of runs) assert.equal(r.code, 0, `子进程不得降级为 unavailable：${JSON.stringify(r)}`);
  const modes = runs.map((r) => JSON.parse(r.out).mode);
  assert.ok(modes.includes('extracted'), `至少要有一个进程真的抽取：${JSON.stringify(modes)}`);
  for (const m of modes) assert.ok(['extracted', 'reused', 'reused-unverified'].includes(m), `非法 mode：${m}`);
  assert.ok(existsSync(join(cache, markerRel)), 'marker 必须就位');
  assert.ok(existsSync(join(cache, engine.STAMP_NAME)), '身份戳必须就位（随发布原子生效）');
  assert.deepEqual(
    readdirSync(tmp).filter((n) => n.includes('.staging-') || n.includes('.retired-')),
    [],
    '不得残留 staging/retired 目录',
  );
  // 父进程阶段（无并发写者，确定性）：第 4 个身份 ⇒ 必须重抽自己的树，绝不允许拿并存成品冒充
  const parentRoot = roots[3];
  const prevApp = process.env.DSH_APP_ROOT;
  const prevCache = process.env.DSH_ENGINE_CACHE_DIR;
  process.env.DSH_APP_ROOT = parentRoot.root;
  process.env.DSH_ENGINE_CACHE_DIR = cache;
  try {
    const decided = engine.ensureEngineCache();
    assert.equal(decided.mode, 'extracted', '异身份必须重抽（不得复用并存成品）');
    assert.equal(markerOfCache(), 'export const STUB_MARKER = "P";', '抽取出的树必须是本身份的');
    const asarPath = join(parentRoot.root, 'resources', 'app.asar');
    assert.equal(
      readFileSync(join(cache, engine.STAMP_NAME), 'utf8').trim(),
      engine.cacheIdentity(parentRoot.root, engine.asarFingerprint(asarPath), engine.contentHash(asarPath)),
      '发布后的戳必须是本身份（三段全等）',
    );
    assert.equal(engine.ensureEngineCache().mode, 'reused', '本身份成品应可判新鲜');
  } finally {
    if (prevApp === undefined) delete process.env.DSH_APP_ROOT; else process.env.DSH_APP_ROOT = prevApp;
    if (prevCache === undefined) delete process.env.DSH_ENGINE_CACHE_DIR; else process.env.DSH_ENGINE_CACHE_DIR = prevCache;
  }
});

test('抽取缓存（半成品目标）：目标处只有无 marker 的残留树 ⇒ 清掉后发布本身份成品（OPEN-43）', async (t) => {
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-partial-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'root');
  writeStubAsar(root, {
    'node_modules/@deepseek-ai/cordis/lib/index.js': 'export const STUB_MARKER = "fresh";',
    'node_modules/@deepseek-ai/stub-probe/package.json': '{"name":"stub-probe","type":"module"}',
  });
  const cache = join(tmp, 'cache');
  // "抽到一半"的残留：既有非 node_modules 的碎枝，也有已抽出一部分的 @deepseek-ai 树枝（但无 marker）
  mkdirSync(join(cache, 'node_modules', 'leftover'), { recursive: true });
  writeFileSync(join(cache, 'node_modules', 'leftover', 'x.js'), 'stale');
  mkdirSync(join(cache, 'node_modules', '@deepseek-ai', 'cordis', 'lib'), { recursive: true });
  writeFileSync(join(cache, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'partial.js'), 'half');
  const prevApp = process.env.DSH_APP_ROOT;
  const prevCache = process.env.DSH_ENGINE_CACHE_DIR;
  process.env.DSH_APP_ROOT = root;
  process.env.DSH_ENGINE_CACHE_DIR = cache;
  try {
    const decided = engine.ensureEngineCache();
    assert.equal(decided.mode, 'extracted', '半成品目标不得被当成品复用');
    assert.equal(
      readFileSync(join(cache, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'), 'utf8'),
      'export const STUB_MARKER = "fresh";',
      '发布的是本次抽取的树',
    );
    assert.equal(existsSync(join(cache, 'node_modules', 'leftover', 'x.js')), false, '半成品残留必须被清掉');
    assert.ok(existsSync(join(cache, engine.STAMP_NAME)), '身份戳必须就位');
    assert.equal(engine.ensureEngineCache().mode, 'reused');
  } finally {
    if (prevApp === undefined) delete process.env.DSH_APP_ROOT; else process.env.DSH_APP_ROOT = prevApp;
    if (prevCache === undefined) delete process.env.DSH_ENGINE_CACHE_DIR; else process.env.DSH_ENGINE_CACHE_DIR = prevCache;
  }
});

test('自察注入缝（OPEN-44②）：夹具会话记录落临时根，生产账本零新增', async () => {
  // 为什么要有：注入缝"生效"必须两头夹住——正向证明临时根确有记录落地（防注入写错目录仍绿），
  // 反向证明生产账本里夹具会话行数不变（防夹具会话继续污染；按来源归因，不受并行真实会话影响）。
  const repoLedger = join(REPO_ROOT, '.workflow', 'incidents.jsonl');
  const before = fixtureLedgerLines(repoLedger);
  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: 'acceptance-session',
    cwd: REPO_ROOT,
    tool_name: 'pwsh',
    tool_use_id: `seam-${process.pid}-${Date.now()}`,
    tool_input: { command: 'exit 1' },
    tool_result: { exit_code: 1, content: [] },
  };
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'workflow', 'hooks', 'post-tool.mjs')], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, WF_INCIDENT_ROOT: INCIDENT_ROOT },
  });
  assert.equal(r.status, 0, `post-tool 应静默退 0：${r.stderr}`);
  const tempLedger = join(INCIDENT_ROOT, '.workflow', 'incidents.jsonl');
  const tempLines = existsSync(tempLedger) ? readFileSync(tempLedger, 'utf8') : '';
  assert.match(tempLines, /"kind":"tool-failure"/, '临时根必须落地一条 tool-failure（证明注入缝真被走过）');
  assert.match(tempLines, /"session":"acceptance-session"/, '临时根记录应带夹具会话 id');
  // 反向（正确性维收尾评审 F2 补）：生产账本里夹具会话行数必须**不变**——按来源归因，
  // 免疫并行真实会话的追加；少了这一头，"注入写错目录"或"夹具会话回写生产账本"仍会假绿。
  assert.equal(fixtureLedgerLines(repoLedger), before, '生产账本里夹具会话行数不得变化');
  assert.equal(fixtureLedgerLines(repoLedger), before, '生产账本里夹具会话行数不得变化');
});

test('抽取缓存（陈旧清理）：陈旧 staging/retired 被清、新鲜与自己 pid 的保留、非本前缀不碰（OPEN-43）', async (t) => {
  // 为什么要有（正确性维收尾评审 F1）：`gcStaleStaging()` 是新增的兜底面（崩溃残留 staging 清理），
  // 而登记面曾声称"四条用例含陈旧清理"却无对应用例 ⇒ 零测试覆盖；本用例把它钉进机器验证面。
  const engine = await import('./helpers/dsh-engine.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-gc-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'root');
  writeStubAsar(root, {
    'node_modules/@deepseek-ai/cordis/lib/index.js': 'export const STUB_MARKER = "gc";',
    'node_modules/@deepseek-ai/stub-probe/package.json': '{"name":"stub-probe","type":"module"}',
  });
  const cache = join(tmp, 'cache');
  const stale = join(tmp, 'cache.staging-99999-stale');
  const fresh = join(tmp, 'cache.staging-99999-fresh');
  const own = join(tmp, `cache.staging-${process.pid}-own`);
  const retired = join(tmp, 'cache.retired-legacy');
  const bystander = join(tmp, 'other-cache.staging-99999-bystander');
  for (const d of [stale, fresh, own, retired, bystander]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'x.js'), 'x');
  }
  const oldSeconds = (Date.now() - 11 * 60 * 1000) / 1000; // 早于 10 min 阈值
  for (const d of [stale, own, retired, bystander]) utimesSync(d, oldSeconds, oldSeconds);
  const prevApp = process.env.DSH_APP_ROOT;
  const prevCache = process.env.DSH_ENGINE_CACHE_DIR;
  process.env.DSH_APP_ROOT = root;
  process.env.DSH_ENGINE_CACHE_DIR = cache;
  try {
    const decided = engine.ensureEngineCache();
    assert.equal(decided.mode, 'extracted', '抽取分支入口应先跑陈旧清理再抽取');
    assert.equal(existsSync(stale), false, '陈旧 staging（别人 pid）必须被清');
    assert.equal(existsSync(retired), false, '历史 retired 残留必须被清');
    assert.equal(existsSync(fresh), true, '新鲜 staging 不得被清（可能是别的进程正在抽）');
    assert.equal(existsSync(own), true, '自己 pid 的 staging 不得自删');
    assert.equal(existsSync(bystander), true, '非本缓存前缀的目录不得被碰');
    assert.ok(existsSync(join(cache, engine.STAMP_NAME)), '清理后仍完成本次抽取与发布');
  } finally {
    if (prevApp === undefined) delete process.env.DSH_APP_ROOT; else process.env.DSH_APP_ROOT = prevApp;
    if (prevCache === undefined) delete process.env.DSH_ENGINE_CACHE_DIR; else process.env.DSH_ENGINE_CACHE_DIR = prevCache;
  }
});

test('不变量⑦补：apply 及其钩子运行期间仓库**不新增也不消失任何文件**', async (t) => {
  // 为什么要有（2026-09-28 第 93 批）：上一条只快照 **71 份已知资产**的哈希+mtime——
  // 它能发现"已有文件被改动"，但**发现不了"多出了文件"**。而这条真实存在：
  // 钩子是以**子进程 + `projectDir` 为 cwd** 跑的（`handlerCommandLine` + `shell.execute`），
  // 它们自身会写状态文件（workflow 的纠正记录、task-recap 的落盘等）。
  // 本层结构上无写调用（五个文件的 `node:fs` 导入全是 read*），但**子进程不是本层的代码**——
  // 所以"零影响"必须**实证**到"文件清单不变"这一粒度。
  //
  // 实测结论（本批跑出）：跑完整条验收链前后，仓库文件数 **1207 → 1207，新增 0、消失 0**。
  // 即有状态写入时它们落在仓库之外（用户级状态目录），不在项目树里。
  const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.mimosa']);
  // 运行态写入豁免（2026-09-29 内部任务-DSHADAPTER-2，收尾评审 F-1）：本用例在**并行会话**签发
  // verification 凭据、写验证证据时会假红（同窗落盘 `内部治理状态…/verification-*.json` 与
  // `内部计划…`），复跑即绿——那类写入是**本仓流程自身的运行态产物**，不是适配层
  // 写入面。豁免面必须逐条列名，且不得吞掉真保护面（五插件目录、`ai-coding-methodology/` 等
  // 仍受零新增/零消失断言约束）；下面四句双面对拍把该口径钉住，豁免面漂移即红。
  // 同族运行态写入（2026-09-29 delta 评审判据）：`内部治理状态`（scout 生命周期原子写）与
  // `内部治理状态`（capture-evidence --append）与 receipts 同属运行态，并发操作落在本用例
  // ~45s 窗口内会假红；故一并具名豁免（仍保留 `内部治理状态` 等版本化声明的非豁免断言）
  const RUNTIME_WRITE_FACES = ['.sdd/receipts/', 'docs/plans/evidence/', '.workflow/'];
  const RUNTIME_WRITE_FILES = new Set(['.sdd/ledger.json', '.sdd/evidence.jsonl']);
  const isRuntimeWriteFace = (rel) =>
    RUNTIME_WRITE_FILES.has(rel) || RUNTIME_WRITE_FACES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
  assert.equal(isRuntimeWriteFace('docs/plans/evidence/TASK-X/a.log'), true, '运行态证据面应被豁免（F-1）');
  assert.equal(isRuntimeWriteFace('.sdd/receipts/TASK-X/verification-1.json'), true, '凭据面应被豁免（F-1）');
  // 内部任务-273 步骤11 T-09（收窄后）：仅 `.workflow/` 运行态根豁免；`docs/plans/`/`docs/design-docs/` 整树
  // 不豁免（否则两个最大 tracked 文档面会让「仓库不新增/不消失」不变量空断言——终审正确性评审指出）。
  assert.equal(isRuntimeWriteFace('.workflow/routing-state/wf-write-report.json'), true, '.workflow 运行态根应被豁免');
  assert.equal(isRuntimeWriteFace('docs/plans/2026-11-01-DEV-273-x.md'), false, 'plans 文档面不得整树豁免（会掏空不变量）');
  assert.equal(isRuntimeWriteFace('docs/design-docs/2026-09-30-mcode-adapter.md'), false, 'design-docs 面不得整树豁免');
  // 真保护面不许缩水（2026-09-29 收尾评审判据）：五插件按名派生（不抽样两条）+ 适配层源码 +
  // 版本化 .sdd 声明文件——豁免只限 receipts 运行态面，`内部治理状态` 这类版本化文件不豁免
  for (const plugin of PLUGINS) {
    assert.equal(isRuntimeWriteFace(`${plugin}/hooks/post-tool.mjs`), false, `${plugin} 资产不得被豁免——真保护面不许缩水`);
  }
  assert.equal(isRuntimeWriteFace('ai-coding-methodology/src/index.mjs'), false, '适配层源码不得被豁免——真保护面不许缩水');
  assert.equal(isRuntimeWriteFace('.sdd/suite.json'), false, '版本化 .sdd 声明文件不得被豁免（豁免只限 receipts 运行态面）');
  const listFiles = (root) => {
    const out = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skipDirs.has(e.name)) continue;
        const cr = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(join(dir, e.name), cr);
        else out.push(cr);
      }
    };
    walk(root, '');
    return out.sort();
  };
  const before = new Set(listFiles(REPO_ROOT));
  // 下限取"恒远低于任一真实检出"的 400：断言目的是"枚举真跑起来了"（走错根会得到 0/个位数），
  // 不是给特定机器存档。2026-10-01 修正：原值 1000 是 Windows 批次机（含运行态证据目录，1207 份）
  // 的机队值，macOS 检出实测 959 份（版本化树 885 份 + 未入库运行态）⇒ 原阈值在新平台结构性报红。
  assert.ok(before.size > 400, `仓库文件清单应足够大才有判别力（实际 ${before.size}）`);

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  await mod.apply(ctx, { projectDir: REPO_ROOT });
  const agent = { session: { header: { id: 'inv2', cwd: REPO_ROOT } }, inject() {}, steer() {}, followup() {} };
  await ctx.emit('agent/created', deepFreeze({ agent, source: 'startup' }));
  await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [{ content: [{ type: 'text', text: '帮我加一个导出功能' }] }] }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  await ctx.emit(
    'tools/pre-execute',
    deepFreeze({ name: 'pwsh', arguments: { command: 'rm -rf /' }, agent, callId: 'z1' }),
    async () => ({ kind: 'enter' }),
  );
  await ctx.emit(
    'tools/post-execute',
    deepFreeze({ name: 'pwsh', arguments: {}, agent, callId: 'z2' }),
    deepFreeze({ content: [{ type: 'text', text: 'x' }] }),
    async () => ({ kind: 'accept' }),
  );
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent }));

  const after = new Set(listFiles(REPO_ROOT));
  const added = [...after].filter((f) => !before.has(f));
  const removed = [...before].filter((f) => !after.has(f));
  const addedReal = added.filter((f) => !isRuntimeWriteFace(f));
  const removedReal = removed.filter((f) => !isRuntimeWriteFace(f));
  const exemptAdded = added.filter(isRuntimeWriteFace).length;
  const exemptRemoved = removed.filter(isRuntimeWriteFace).length;
  assert.deepEqual(addedReal, [], `运行期间新增了文件（零影响被破坏）：${JSON.stringify(addedReal.slice(0, 10))}｜新增合计 ${added.length}（豁免面 ${exemptAdded}）`);
  assert.deepEqual(removedReal, [], `运行期间删除了文件（零影响被破坏）：${JSON.stringify(removedReal.slice(0, 10))}｜消失合计 ${removed.length}（豁免面 ${exemptRemoved}）`);
});

test('安装态：真实 ZCode 安装记录能补位出记录内全套插件，且指向的确实是同一份插件（缺记录则跳过）', async (t) => {
  // 为什么要有（2026-09-28 第 95 批）：本层在**开发态**（仓库检出）与**装机态**（DSH 装好后）
  //   走的是**不同**的插件根来源：
  //   · 开发态：`apply` 的 `discoverPlugins(dirname(HERE))` 同级命中 5/5（第 90 批仪器实测）；
  //   · 装机态：包被装进 `<profile>/node_modules/ai-coding-methodology/`，同级**一个都找不到**，
  //     于是必须由 `discoverFromInstalledPlugins(homedir())` 补位——**第 90 批实测该分支
  //     在仓库内不可达，装机态才是它的主场**，而它此前只在临时 home 上被验过。
  // 本用例读**操作者真实机器**的安装记录，把"装机态真能补位"钉住；记录不存在（CI/新机）
  // 则显式跳过——不把"没装 ZCode"当失败。
  // **2026-10-15 内部任务-90 期望面改判**：套件扩为五插件后，机器装机可能合法落后于仓库
  //   （algo-loop 归发布批装机——生效边界见交付报告）。断言改为**与记录自洽**：发现面必须
  //   恰等于记录里的套件插件条目（防解析回归/漏挂），记录缺席的套件插件打 diagnostic 如实
  //   报告（装机未做），发布批装机后记录齐五即自动回到全套硬断言面。
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const record = join(homedir(), '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  if (!existsSync(record)) {
    t.skip(`本机无 ZCode 安装记录：${record}`);
    return;
  }
  const found = mod.discoverFromInstalledPlugins();
  // 去重：同名多条记录（多 marketplace/多作用域——生产侧 discoverFromInstalledPlugins 取最后一条）
  // 与 Object.keys(found) 的唯一键集口径对齐，否则合法机器态上 deepEqual 假红（复审正确性#1）
  const recorded = [...new Set(JSON.parse(readFileSync(record, 'utf8')).plugins
    .map((e) => e.name)
    .filter((n) => PLUGINS.includes(n)))];
  assert.deepEqual(
    Object.keys(found).sort(),
    [...recorded].sort(),
    `真实安装记录内的套件插件应全部补位（记录 ${JSON.stringify(recorded)}，实际 ${JSON.stringify(Object.keys(found))}）`,
  );
  const absent = PLUGINS.filter((p) => !recorded.includes(p));
  if (absent.length > 0) {
    t.diagnostic(`套件插件未在安装记录中（装机未做——归发布批）：${absent.join('/')}`);
  }
  for (const p of Object.keys(found)) {
    const root = found[p];
    assert.ok(isAbsolute(root), `${p} 的根必须是绝对路径（相对路径会被按进程 cwd 解析而接错来源）`);
    assert.ok(mod.isPluginRoot(root), `${p} 的根必须通过 isPluginRoot：${root}`);
    // 装机根必须是**完整**的插件形态，而不是碰巧同名的目录。
    // 零钩子插件（research-loop，内部决策-047 决策 3）不产 hooks/hooks.json——物化器「hooks 非空才生成」
    // 是已登记约定（内部决策-047「十一行条件表」节；内部任务-109 已把 zcodeContractArtifacts 按磁盘实存条件化，
    // 本内联清单是当时漏改的同款点位）。故期望子面按**仓库源树的磁盘实存**收集，而非对所有插件硬编码。
    const expectedSubs = ['.zcode-plugin/plugin.json', 'skills'];
    if (existsSync(join(REPO_ROOT, p, 'hooks', 'hooks.json'))) expectedSubs.push('hooks/hooks.json');
    for (const sub of expectedSubs) {
      assert.ok(existsSync(join(root, sub)), `${p} 的装机根缺 ${sub}：${root}`);
    }
    // **版本一致性**：装机副本的清单版本必须与仓库一致，否则本层在测 A 而用户在跑 B。
    const installedVersion = JSON.parse(readFileSync(join(root, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    const repoVersion = JSON.parse(readFileSync(join(REPO_ROOT, p, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    assert.equal(installedVersion, repoVersion, `${p} 装机副本版本(${installedVersion}) 与仓库(${repoVersion}) 不一致`);
  }
});

test('ZCode 侧独立自证：真实钩子按**原生负载**直接运行时的四个关键姿态（不经适配层）', () => {
  // 为什么要有（2026-09-28 第 97 批）：这是"**不破坏 ZCode 可用性**"的**正面证据**。
  // 前面的零影响不变量证的是"没改坏"（静态 + 字节 + 清单），本用例证的是"**在 ZCode 侧照旧管用**"：
  // 直接把规范形态的负载喂给钩子脚本、**完全不经过 ai-coding-methodology**，看它是否仍是 ZCode 期望的行为。
  // 这也顺带把"适配层的环境变量契约"独立复核了一遍——钩子只认 `ZCODE_PLUGIN_ROOT` 等，
  // 缺了就静默退出（见下第 ④ 条的反向对照）。
  // 内部任务-331：基座剥插件根双键（session-start.mjs:689 是 `ZCODE_PLUGIN_ROOT ?? CLAUDE_PLUGIN_ROOT`
  // 回退链，须两键同删）——「缺根 ⇒ 静默」断言（④）的前提由夹具保证，而非宿主环境恰好不带；
  // 需要根的调用经 env 参数显式传（见 withRoot）。check-careful 不受影响（插件根解析自身位置优先，hook-lib.mjs:285）。
  const runHook = (script, payload, env = {}) => {
    const base = { ...process.env };
    delete base.ZCODE_PLUGIN_ROOT;
    delete base.CLAUDE_PLUGIN_ROOT;
    return spawnSync(process.execPath, [join(REPO_ROOT, script)], {
      input: `${JSON.stringify(payload)}\n`,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...base, ...env },
      timeout: 30000,
    });
  };
  const bash = (command) => ({
    session_id: 's1',
    transcript_path: '',
    cwd: REPO_ROOT,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'c1',
  });

  // ① 危险命令：deny + 带用户可见文案 + 退出码 2（ZCode 的阻断口径）
  const deny = runHook(join('workflow', 'hooks', 'check-careful.mjs'), bash('rm -rf /'));
  assert.equal(deny.status, 2, '危险命令必须退 2');
  const denyEnv = JSON.parse(deny.stdout.trim());
  assert.equal(denyEnv.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(denyEnv.hookSpecificOutput.systemMessage.length > 0, 'deny 必须带用户可见文案');
  // ② 正常命令：静默放行（零输出 + 退 0）——护栏不能误伤日常操作
  const allow = runHook(join('workflow', 'hooks', 'check-careful.mjs'), bash('git status'));
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout.trim(), '', '放行时不得输出任何内容');
  // ③ 保护性失败关闭：负载不可读时 check-freeze **必须 deny**（project-conventions 硬规则 4 的唯一例外，
  //    别"修正"它）。这条也用最直接的方式钉住。
  const failClosed = spawnSync(process.execPath, [join(REPO_ROOT, 'workflow', 'hooks', 'check-freeze.mjs')], {
    input: '不是 JSON\n',
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 30000,
  });
  assert.equal(failClosed.status, 2, '负载不可读必须退 2（保护性失败关闭）');
  assert.match(JSON.parse(failClosed.stdout.trim()).hookSpecificOutput.systemMessage, /fail-closed/);
  // ④ SessionStart 注入：**必须**设 `ZCODE_PLUGIN_ROOT` 才有输出（反向对照见注释）
  const noRoot = runHook(join('workflow', 'hooks', 'session-start.mjs'), {
    session_id: 's1',
    cwd: REPO_ROOT,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(noRoot.stdout.trim(), '', '缺 ZCODE_PLUGIN_ROOT 时钩子静默退出（故适配层必须注入它）');
  const withRoot = runHook(
    join('workflow', 'hooks', 'session-start.mjs'),
    { session_id: 's1', cwd: REPO_ROOT, hook_event_name: 'SessionStart', source: 'startup' },
    { ZCODE_PLUGIN_ROOT: join(REPO_ROOT, 'workflow') },
  );
  assert.equal(withRoot.status, 0);
  const injected = JSON.parse(withRoot.stdout.trim());
  assert.equal(injected.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(injected.hookSpecificOutput.additionalContext.length > 1000, '元技能全文应被注入');
  assert.match(injected.hookSpecificOutput.additionalContext, /路由表/, '注入内容应含路由表（R-M1-5 的目的）');

  // ⑤ 其余四插件也必须能按原生负载直接跑（2026-09-28 第 98 批补；2026-10-15 内部任务-90 扩 algo-loop）：
  //    此前本用例只直驱了 workflow 的钩子，而"五插件在 ZCode 侧照旧管用"这句声称覆盖五个。
  //    静默路径插件的**静默姿态**（触发条件未满足 ⇒ 零输出退 0）必须先确认——那是它们的常规姿态。
  const quiet = (script, payload, env = {}) =>
    spawnSync(process.execPath, [join(REPO_ROOT, script)], {
      input: `${JSON.stringify(payload)}\n`,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 30000,
    });
  // spec-gate session-start：无 ledger ⇒ 静默（其行为由 .sdd 数据驱动）
  const sgQuiet = quiet(join('spec-gate', 'hooks', 'session-start.mjs'), {
    session_id: 's1',
    cwd: REPO_ROOT,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(sgQuiet.status, 0);
  assert.equal(sgQuiet.stdout.trim(), '', 'spec-gate：无 ledger 数据时应静默放行');
  // scout session-start：非 scout 模式 ⇒ 静默（模式由项目状态驱动）
  const scoutQuiet = quiet(join('scout', 'hooks', 'session-start.mjs'), {
    session_id: 's1',
    cwd: REPO_ROOT,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(scoutQuiet.status, 0);
  assert.equal(scoutQuiet.stdout.trim(), '', 'scout：非 scout 模式时应静默放行');
  // algo-loop session-start：项目根无 .algo/（未立项）⇒ 静默（2026-10-15 内部任务-90 随五插件扩面）
  const algoQuiet = quiet(join('algo-loop', 'hooks', 'session-start.mjs'), {
    session_id: 's1',
    cwd: REPO_ROOT,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(algoQuiet.status, 0);
  assert.equal(algoQuiet.stdout.trim(), '', 'algo-loop：未立项（无 .algo/）时应静默放行');

  // ⑥ team-governance 的**动作路径**：它默认不打扰（要显式 `leaseEnforcement: true`），
  //    故必须用一个临时项目根把"显式启用 + 持有冲突租约"造出来，才能证明它**会提醒**。
  //    内部任务-5 C（内部规则-6 扩义）后命中 held 租约不再是本地 deny：护栏未执行调用者身份
  //    裁决（无法可信区分是否同一持有者），改输出 unverified 提醒并放行，真实互斥强制点在 CI/gate。
  //    这也复核了它的项目根取法：`ZCODE_PROJECT_DIR ?? QODER_CWD ?? CLAUDE_PROJECT_DIR ?? cwd`
  //    ——适配层注入的正是第一个。
  const govRoot = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-tg-'));
  try {
    mkdirSync(join(govRoot, '.ai-governance', 'runtime', 'leases'), { recursive: true });
    writeFileSync(join(govRoot, '.ai-governance', 'config.json'), JSON.stringify({ leaseEnforcement: true }), 'utf8');
    writeFileSync(
      join(govRoot, '.ai-governance', 'runtime', 'leases', 'leases.json'),
      JSON.stringify({
        leases: { L1: { state: 'held', expiresAt: Date.now() + 600000, resource: 'path:repo:src/**', holder: 'alice', fencingToken: 7 } },
      }),
      'utf8',
    );
    const pre = {
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(govRoot, 'src', 'a.ts') },
      tool_use_id: 'c9',
    };
    const warned = quiet(join('team-governance', 'hooks', 'pre-tool-use.mjs'), pre, { ZCODE_PROJECT_DIR: govRoot });
    assert.equal(warned.status, 0, '冲突租约命中必须退 0（unverified 提醒不阻断，强制点在 CI/gate）');
    const govEnv = JSON.parse(warned.stdout.trim()).hookSpecificOutput;
    assert.equal(govEnv.permissionDecision, 'allow', '提醒路径必须放行（本地不 deny）');
    assert.equal(govEnv.hookEventName, 'PreToolUse', '信封事件名必须与触发事件一致');
    assert.match(govEnv.systemMessage, /\[unverified\]/, '提醒文案必须带 unverified 标记');
    assert.match(govEnv.systemMessage, /alice/, '提醒文案要点名持有者');
    // 反向对照：同一根下**不冲突**的路径 ⇒ 放行（否则"永远拦"也能骗过上面那条）。
    // ⚠ 这里有个**必须注意的坑**（2026-09-28 第 98 批实测踩到）：钩子的匹配是**朴素子串**
    // （`String(target).includes(prefix)`，prefix=`src`）。我第一版用 `join(govRoot,'docs','x.md')`，
    // 而临时根路径里恰好含 `src` 片段 ⇒ 那条"对照"在**本机实际是命中并 deny 的**，
    // 用例只是靠 `leaseEnforcement` 闸提前退出才"绿"（把闸废掉后它才暴露）。
    // 改法：用确定不含 `src` 的路径，并把该前提**显式断言**出来，免得上游改名后静默失效。
    const safePath = join(govRoot, 'documentation', 'readme-file.md');
    assert.ok(!safePath.includes('src'), `对照路径不得含 'src' 子串（当前：${safePath}）`);
    const allowed = quiet(
      join('team-governance', 'hooks', 'pre-tool-use.mjs'),
      { ...pre, tool_input: { file_path: safePath } },
      { ZCODE_PROJECT_DIR: govRoot },
    );
    assert.equal(allowed.status, 0, `无冲突租约时必须放行，实际退出码 ${allowed.status}（输出：${allowed.stdout.trim().slice(0, 120)}）`);
    assert.equal(allowed.stdout.trim(), '', '无冲突租约时不得输出任何内容');
  } finally {
    rmSync(govRoot, { recursive: true, force: true });
  }
});

test('不变量⑦：五插件清单版本未被适配层改写（IF-HOST-1 版本行与 plugin.json 一致）', { skip: HAS_IF_HOST ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const host = readFileSync(join(REPO_ROOT, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8');
  for (const p of PLUGINS) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, p, '.zcode-plugin', 'plugin.json'), 'utf8'));
    const re = new RegExp(`\\|\\s*${p}\\s*\\|[^\\n]*?(\\d+\\.\\d+\\.\\d+)`);
    const m = host.match(re);
    assert.ok(m, `IF-HOST-1 缺 ${p} 的版本行`);
    assert.equal(m[1], manifest.version, `${p} 版本登记与清单不一致`);
  }
});

test('不变量⑦：ZCode 侧零反向耦合——五插件全树不出现 ai-coding-methodology 的任何引用', () => {
  // 这是"不破坏 ZCode 可用性"的**结构面**证明：新增的第五个顶层单元对五插件是全透明的。
  // 它比"跑一遍测试没红"更强——后者是抽检，前者是"不存在这条边"。
  const offenders = [];
  for (const p of PLUGINS) {
    const files = [];
    collectFiles(join(REPO_ROOT, p), files);
    for (const file of files) {
      if (!/\.(mjs|js|cjs|json|py|md)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('ai-coding-methodology')) offenders.push(file.replace(REPO_ROOT + sep, ''));
    }
  }
  assert.deepEqual(offenders, [], `六插件不得引用适配层：${JSON.stringify(offenders)}`);
});

test('不变量⑦：装机副本与仓库一致（把"验的是仓库"与"跑的是装机"对齐；缺 ZCode 时跳过）', (t) => {
  // 为什么要有：本层所有零影响结论都是对**仓库里的六插件**做的（哈希+mtime、86 份资产、
  // 契约工件）。但 ZCode 实际运行的是装机缓存 `~/.zcode/.../cache/<market>/<plugin>/<ver>/`。
  // 若两者内容不一致，那些结论就只是"仓库没被动过"，不等于"跑的东西没被动过"。
  //
  // 本用例把三跳摊开（repo → 市场源 → 装机缓存），并按"哪个相等是必须的"区分断言强度：
  //   · **市场源 == 装机缓存**：两者是同一个已发布版本的两份拷贝（客户端派生自市场源），
  //     不一致就是真问题 ⇒ **硬断言**。
  //   · **仓库 == 装机缓存**：仓库可能合法地领先于已发布版本（有未发布的改动），
  //     故只**报告**不判失败（差异会列出，便于判断是"领先"还是"漂移"）。
  //   · `.test.mjs` 一律不算运行时面。
  const cache = join(homedir(), '.zcode', 'cli', 'plugins', 'cache', 'wangp-local-marketplace');
  if (!existsSync(cache)) {
    t.skip('本机无 ZCode 装机缓存，跳过（该断言只在装了 ZCode 的机器上有意义）');
    return;
  }

  // 插件清单直接用文件级 PLUGINS（复审简洁性#1：局部副本遮蔽文件级同名常量=腐蚀面）；
  // 仓库根用文件级 REPO_ROOT 同理。
  const MARKET = join(homedir(), '.zcode', 'local-marketplace', 'plugins');
  // 内部任务-273 H-05：market 缺失时不得「只报告不判失败」地空转通过——显式 skip（skip 列表可见）；
  // 存在时下方按插件逐个比到全部六插件，断言从「>=1」收紧为等值，防再次空转。
  if (!existsSync(MARKET)) {
    t.skip('本机无 local-marketplace 市场源：市场源==装机缓存硬断言未执行（不得以空转代替；DEV-273 H-05）');
    return;
  }
  const SKIP = /(^|[\\/])(__pycache__|\.mimosa|node_modules)([\\/]|$)|\.pyc$/;
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

  const walk = (dir, rel = '') => {
    const out = new Map();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) for (const [k, v] of walk(p, r)) out.set(k, v);
      else out.set(r, sha(p));
    }
    return out;
  };
  // compare(a, b)：列出"b 有而 a 没有 / 内容不同 / a 有而 b 没有"三类差异，标签用调用方给的名字
  const compare = (a, b, aName, bName) => {
    const out = [];
    for (const [k, v] of b) {
      if (!a.has(k)) out.push(`仅 ${bName} 有 ${k}`);
      else if (a.get(k) !== v) out.push(`${aName}≠${bName}：${k}`);
    }
    for (const k of a.keys()) if (!b.has(k)) out.push(`仅 ${aName} 有 ${k}`);
    return out;
  };
  const runtime = (list) => list.filter((s) => !s.endsWith('.test.mjs'));

  const hardProblems = [];
  const repoNotes = [];
  let compared = 0;
  // 正确性评审 round1 #4：cache 侧缺装与 market 侧缺失必须分流——否则缓存缺任一插件即硬红且归因错误。
  const cacheMissing = [];

  for (const plugin of PLUGINS) {
    const repoDir = join(REPO_ROOT, plugin);
    const base = join(cache, plugin);
    if (!existsSync(repoDir) || !existsSync(base)) {
      cacheMissing.push(`${plugin}:装机缓存或仓库缺失`);
      continue;
    }
    const versions = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length === 0) {
      cacheMissing.push(`${plugin}:无版本目录`);
      continue;
    }
    const inst = join(base, versions[versions.length - 1]);
    const market = join(MARKET, plugin);

    const installedFiles = walk(inst);
    // ① 硬断言：市场源（同一版本）== 装机缓存
    // 内部任务-273 H-05：计数必须落在「确实比过」的分支内；market 目录逐个插件缺失时记为硬问题（而非静默跳过）。
    if (!existsSync(market)) {
      hardProblems.push(`${plugin}: 市场源缺失（${market}）——三跳硬断言未执行`);
    } else {
      const m = walk(market);
      compared += 1;
      for (const s of runtime(compare(m, installedFiles, '市场源', '装机缓存'))) {
        hardProblems.push(`${plugin}: ${s}`);
      }
    }

    // ② 报告：仓库 vs 装机（仓库可合法领先）
    const repoFiles = walk(repoDir);
    for (const s of compare(installedFiles, repoFiles, '装机缓存', '仓库')) repoNotes.push(`${plugin}: ${s}`);
  }

  // 缓存侧不全 ⇒ 三跳硬断言不可执行：显式 skip（环境形态，不得误报为「市场源不一致」或空转绿）。
  if (cacheMissing.length > 0) {
    t.skip(`装机缓存不全（${cacheMissing.join('；')}）——三跳硬断言未执行`);
    return;
  }
  assert.equal(compared, PLUGINS.length, `六插件必须全部比到市场源（实际 ${compared}/${PLUGINS.length}）——DEV-273 H-05 收紧，禁止空转`);
  assert.deepEqual(hardProblems, [], `市场源与装机缓存（同一已发布版本）运行时面不一致：\n${hardProblems.join('\n')}`);
  if (repoNotes.length > 0) {
    const rt = repoNotes.filter((s) => !s.endsWith('.test.mjs'));
    if (rt.length > 0) {
      // 运行时面差异值得显眼——若确属"未发布的改动"，发布后即消失
      console.log(`  注：仓库与装机副本有 ${rt.length} 处差异（若为未发布改动则属正常）：\n    ${rt.join('\n    ')}`);
    }
  }
});

test('不变量⑦：套件发布面仍只认五个插件（ai-coding-methodology 不进市场镜像）', () => {
  // 发布面清单的权威落点随 内部决策-035（内部任务-ZCODEORG-1）自 release-suite.mjs 迁至 zcode-adapter/src/manifests.mjs
  const manifests = readFileSync(join(REPO_ROOT, 'zcode-adapter', 'src', 'manifests.mjs'), 'utf8');
  const m = manifests.match(/export\s+const\s+PLUGINS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(m, 'zcode-adapter/src/manifests.mjs 应有显式 PLUGINS 清单');
  const names = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(names.sort(), [...PLUGINS].sort(), '发布面的插件清单必须恰为五插件');
  assert.ok(!names.includes('ai-coding-methodology'), '适配层不是 ZCode 插件，不得进套件发布面');
});

test('中立数据面交叉核对：能力矩阵 dsh 列 = 适配层工具词表展开的宿主侧（ADR-036 期一带入的矩阵）', () => {
  // 为什么要有（2026-10-01）：内部决策-036 把「宿主能力」搬进了中立数据面（`plugin-core/capability-matrix.json`），
  // 而本层的工具词表映射仍是源码常量（规则引擎属期二第 3 项，本批不接线）。两者一旦分叉，
  // 矩阵就不再是"宿主事实"的描述，而本层会按过期词表静默漏匹配（护栏空转）。故把**数据侧**
  // 与**实现侧**对拍钉住：矩阵 dsh 列列出的原生词必须逐条落在 `normalizeMatcher('Bash|Edit|Write')`
  // 的展开集里，且 ZCode 词表（本层必须认识的 matcher 用词）同样被覆盖。
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const vocab = matrix.capabilities['toolName.vocabulary'];
  const expanded = normalizeMatcher('Bash|Edit|Write').split('|');
  for (const word of vocab.dsh) {
    assert.ok(expanded.includes(word), `矩阵 dsh 列的原生词 ${word} 必须在本层展开集内（否则该工具永远不匹配 matcher）`);
  }
  for (const word of vocab.zcode) {
    assert.ok(expanded.includes(word), `矩阵 zcode 列的 matcher 用词 ${word} 必须被本层认识（否则该档声明整体失效）`);
  }
  // 反向核对：本层展开出的词只能是"宿主原生词 ∪ ZCode matcher 用词"——多出来的词意味着
  // 本层在往 matcher 里塞矩阵未登记的宿主词（既无矩阵依据，也无 ADR 依据）。
  const allowed = new Set([...vocab.dsh, ...vocab.zcode]);
  const extra = expanded.filter((w) => !allowed.has(w));
  assert.deepEqual(extra, [], `展开集出现了矩阵未登记的词：${extra.join(',')}`);
});

test('apply + mountAgents:true：agent 面按 DEV-308 裁决 a 退役（零挂载、无告警、恰一条 info；OPEN-244）', async (t) => {
  // 为什么要有（原 2026-09-28 第 83 批，内部任务-273 起重述）：该用例曾用于覆盖「apply 打开 agent 面」的
  // 整块通路（取 `subagents`、调 `resolveAvailableTools`、写日志）。**内部任务-273 H-03 起行为变更**：
  // 宿主 0.2.1-rc.5 把 persona/工具面移入 Agent Preset，本层不再调用 `mountAgents`/`ctx.plugin`，
  // 本用例改为锁「如实降级」：0 挂载、单次告警（含 内部未决-244）、旧「工具目录不可得」文案不再出现。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-mount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  // 只需 `subagents` 服务（用于覆盖「尾注不出现」的三元分支）；`tools` 夹具已随 H-03 降级退场。
  const services = new Map([
    ['shell', ctx.shell],
    ['skills', ctx.skillRegistry],
    ['commands', ctx.commandRegistry],
    ['subagents', { registerProvider: () => {} }],
  ]);
  ctx.get = (svc) => services.get(svc);

  const borked = join(dir, 'nope');
  // **必须 await**：`apply` 是 async 函数，agent 面块在它内部执行——不 await 会在日志产生前断言（假红）。
  await mod.apply(ctx, {
    projectDir: dir,
    mountAgents: true,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked, 'research-loop': borked },
  });

  // 内部任务-308（内部未决-244 裁决 a）：agent 面退役——保留配置键，移除挂载调用面；开启时恰一条退役 info，
  // 不得再有「0 挂载」日志或「agent 面不可用」告警（静默失效已由 info 兜底）。
  const log = ctx.byLevel('info').join('\n');
  assert.match(log, /已于 DEV-308 退役/, `mountAgents:true 须产生一条退役 info；实际 info：${JSON.stringify(ctx.byLevel('info'))}`);
  assert.ok(!/agent 面挂载/.test(log), '旧的 0 挂载日志不得再出现');
  const agentWarn = ctx.byLevel('warn').join('\n');
  assert.ok(!/agent 面不可用/.test(agentWarn), '不得再有 0 挂载告警');
  // `apply` 已 resolve ⇒ agent 面块确实跑完（不是"没跑到"）。夹具根下没有 hooks/，
  // 故事件面为空是**预期**：这里断言"确实没挂事件"，而不是假称"事件面正常"。
  // 同一条断言还兼作**保险丝**：若哪天"显式配置的坏路径"被改成回落到自动来源
  // （`apply` 会改用真实五插件），事件面就不再为空，这里会红（2026-09-28 第 90 批实测：
  // 变异②即由此条抓住——故文案里点明这层第二含义，免得看到"事件面为空"的报错时找不到方向）。
  // 2026-10-22 内部任务-201（内部决策-057）：apply 恒装配 F2 桥接监听（agent/created），故这里按
  // 「排除桥接监听后的业务监听器集合」断言；桥接监听带内部标记，不计入事件面。
  // 内部任务-220：另恒装配 BridgeChannelHint pre-step 监听（独立标记），同样排除。
  const BRIDGE_LISTENER_TAG = Symbol.for('ai-coding-methodology.agent-control-listener');
  const BRIDGE_HINT_TAG = Symbol.for('ai-coding-methodology.bridge-hint-listener');
  const businessListeners = [...ctx.listeners.values()].flat().filter((fn) => fn?.[BRIDGE_LISTENER_TAG] !== true && fn?.[BRIDGE_HINT_TAG] !== true);
  assert.equal(businessListeners.length, 0, '夹具根无 hooks/ ⇒ 业务事件面为空（恒装配的桥接监听除外）；若此处不为空，说明 apply 用上了非夹具的插件根（如显式坏路径回落到了自动来源）');
});

test('注入/投递失败时逐事件记账：SessionStart 与 Stop 各自告警且不外溢', async (t) => {
  // 为什么要有（2026-09-28 第 86 批）：覆盖率显示 `index.mjs` 里
  // 「SessionStart 注入失败」「Stop 处置失败」两条 catch 日志零覆盖。它们保护的是
  // **钩子成功、但把结果交给宿主 agent 时失败**这一形态（`agent.inject`/`agent.steer` 抛错）。
  // 该形态真实存在于版本差异：老宿主/替身的 agent 句柄可能是只读的、或带签名的（抛错），
  // 而这条路径若漏掉 try，异常会从监听器冒出（五个事件都无宿主兜底，见 §8.12）。
  // 夹具钩子分别产出 additionalContext（SessionStart）与 deny（Stop），再把 agent 的
  // inject/steer 换成抛错版，断言各自告警、且 `emit` 不 reject。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-err-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');
  const src = [
    "import { readFileSync } from 'node:fs';",
    'let raw = "";',
    "try { raw = readFileSync(0, 'utf8'); } catch {}",
    'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
    "const ev = String(p.hook_event_name ?? '');",
    "if (ev === 'SessionStart') {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '注入给我' } }) + '\\n');",
    "} else if (ev === 'Stop') {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', systemMessage: '别停' } }) + '\\n');",
    '}',
  ].join('\n');
  const hookPath = join(root, 'hooks', 'two.mjs');
  writeFileSync(hookPath, src, 'utf8');
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }],
        Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }],
      },
    }),
    'utf8',
  );

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  await mod.apply(ctx, {
    projectDir: dir,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked },
  });

  // agent 句柄：inject / steer 都抛错——模拟"钩子成功但投递失败"
  const agent = {
    session: { header: { id: 's1', cwd: dir } },
    inject() {
      throw new Error('注入被宿主拒绝');
    },
    steer() {
      throw new Error('投递被宿主拒绝');
    },
  };
  // 两个事件都不得 reject（safe() 是唯一防线）；内部任务-173：created 不再 inject，旧「SessionStart 注入失败」路径已删除
  await assert.doesNotReject(() => ctx.emit('agent/created', deepFreeze({ agent, source: 'startup', signal: undefined })));
  assert.doesNotMatch(ctx.byLevel('warn').join('\n'), /SessionStart 注入失败/, '旧 inject 失败路径已删除，不得再出现该告警');
  // 投递阶段失败 fail-open：messages getter 抛错 → 一次 warn、不 reject、槽不重试
  await assert.doesNotReject(async () =>
    ctx.emit(
      'agent/pre-step',
      deepFreeze({ agent, messages: [] }),
      async () => ({
        kind: 'enter',
        get messages() {
          throw new Error('投递被宿主拒绝');
        },
      }),
    ),
  );
  const warn = ctx.byLevel('warn').join('\n');
  assert.match(warn, /SessionStart 投递失败：.*投递被宿主拒绝/, `应记 SessionStart 投递失败，实际：${warn}`);
  await assert.doesNotReject(() => ctx.emit('agent/turn-stopping', deepFreeze({ agent, signal: undefined })));
  const warnAfterStop = ctx.byLevel('warn').join('\n');
  assert.match(warnAfterStop, /Stop 处置失败：.*投递被宿主拒绝/, `应记 Stop 处置失败，实际：${warnAfterStop}`);
});

test('端到端：宿主 session id 被如实抬进钩子负载的 session_id（跨会话状态隔离的前提）', async (t) => {
  // 为什么要有（2026-09-28 第 94 批）：ZCode 钩子把 `session_id` 当**状态文件键**
  // （`user-prompt.mjs`：`parsed.session_id ?? 'default'`，再 `sessionStateFile(prefix, key)` ⇒
  // sha256(key) 作文件名）。若本层抬成空串，**所有会话会共用同一个状态文件**——
  // 表现为跨会话的节流/租约/哨兵状态互相污染，且**完全静默**（钩子照跑、状态照写）。
  //
  // 宿主侧形状已核实（0.1.7-rc.2 源码）：`Session` 的 `get id() { return this.header.id; }`，
  // 而 header 由 `{ version: 4, id: sessionId, … }` 构造 ⇒ `agent.session.header.id` 是对的。
  // 本用例把这条**端到端**钉住：夹具钩子把收到的 `session_id` 回显进 additionalContext，
  // 断言它与传入的 header.id 一致——而不是只验"buildPayload 会填 sessionId 参数"。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-sid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');
  const hookPath = join(root, 'hooks', 'echo-sid.mjs');
  writeFileSync(
    hookPath,
    [
      "import { readFileSync } from 'node:fs';",
      'let raw = "";',
      "try { raw = readFileSync(0, 'utf8'); } catch {}",
      'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "  hookEventName: 'SessionStart',",
      "  additionalContext: 'SID=' + String(p.session_id) + '|CWD=' + String(p.cwd),",
      "} }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }] } }),
    'utf8',
  );

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  await mod.apply(ctx, {
    projectDir: dir,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked },
  });

  const agent = { session: { header: { id: 'sess-abc-123', cwd: dir } }, steer() {} };
  await ctx.emit('agent/created', deepFreeze({ agent, source: 'startup' }));
  const out = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [] }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  const text = (out.messages ?? []).map((m) => (m.content ?? []).map((b) => b?.text ?? '').join('')).join('\n');
  assert.match(text, /SID=sess-abc-123/, `session_id 必须等于 host 的 session.header.id；实际投递：${JSON.stringify(text)}`);
  assert.match(text, new RegExp(`CWD=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'cwd 必须等于会话 cwd');
  // 反向对照：header 缺 id 时钩子仍执行并如实收到**空串**（本层不编造假 id）；但空 sid 会话不写槽/不投递，并一次性告警。
  const agent2 = { session: { header: { cwd: dir } }, steer() {} };
  await ctx.emit('agent/created', deepFreeze({ agent: agent2, source: 'startup' }));
  const out2 = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent: agent2, messages: [] }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal((out2.messages ?? []).length, 0, '空 sid 会话不投递（防跨会话串投）');
  assert.ok(ctx.byLevel('warn').some((w) => /会话 id 缺失/.test(String(w))), '空 sid 必须一次性告警（零静默失败）');
});

test('端到端（期二换源）：只带中立 manifest 的插件根也能装配钩子面并真跑钩子', async (t) => {
  // 为什么要有（2026-10-01，内部决策-036 决策 6 / 内部接口-1 §1 期二）：换源后的生产形态是"插件树里
  // 中立清单是唯一手工编辑面"，`hooks/hooks.json` 只是它的物化生成物。本用例造一个**只有**
  // `plugin.manifest.json`（无 `.zcode-plugin/`、无 `hooks/hooks.json`）的插件根，走完整
  // apply → 事件派发 → 真实子进程链路，断言：① 该根被认作插件根；② 中立声明的钩子真被执行；
  // ③ 中立形态的 `${PLUGIN_ROOT}` 占位符被替换成插件根（夹具声明里写占位符而非绝对路径）。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-neutral-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const hookPath = join(root, 'hooks', 'neutral.mjs');
  writeFileSync(
    hookPath,
    [
      "import { readFileSync } from 'node:fs';",
      'let raw = "";',
      "try { raw = readFileSync(0, 'utf8'); } catch {}",
      'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "  hookEventName: 'SessionStart',",
      "  additionalContext: '中立声明注入|EVENT=' + String(p.hook_event_name),",
      "} }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'plugin.manifest.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        name: 'workflow',
        version: '0.0.0',
        description: '夹具中立清单',
        author: 'wangp',
        hooks: [
          { event: 'SessionStart', matcher: 'startup|resume|clear|compact', type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/neutral.mjs'], timeoutMs: 15000, statusMessage: '夹具' },
          // 宿主无此事件：必须被跳过（不注册、不报错）——与 ZCode 生成物形态同语义
          { event: 'PostToolUseFailure', type: 'process', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/neutral.mjs'], timeoutMs: 15000, statusMessage: '夹具' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  assert.equal(existsSync(join(root, 'hooks', 'hooks.json')), false, '前置条件：本夹具不得有 ZCode 生成物');
  assert.equal(existsSync(join(root, '.zcode-plugin')), false, '前置条件：本夹具不得有 .zcode-plugin');

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  assert.equal(mod.isPluginRoot(root), true, '中立清单形态必须被判为插件根（换源后的树形态）');
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  await mod.apply(ctx, {
    projectDir: dir,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked },
  });
  const agent = { session: { header: { id: 'neutral-1', cwd: dir } }, steer() {} };
  await ctx.emit('agent/created', deepFreeze({ agent, source: 'startup' }));
  const out = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [] }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  const text = (out.messages ?? []).map((m) => (m.content ?? []).map((b) => b?.text ?? '').join('')).join('\n');
  assert.match(text, /中立声明注入\|EVENT=SessionStart/, `中立清单声明的钩子必须真被执行；实际投递：${JSON.stringify(text)}`);
});

test('PostToolUse 阻断通路：夹具钩子跑 block 分支（feedback + additionalContexts）', async (t) => {
  // 为什么需要（2026-09-28 第 80 批）：`block` 分支此前**零覆盖**。它并非不可达——
  // `spec-gate/hooks/post-tool-use.mjs` 在 `ZCODE_USER_CONFIG_SDD_HOOK_BLOCK=true` 且有
  // blocking 诊断时**确实会退 2**（即 deny）。但真实资产默认不开该开关，故验收里跑不到；
  // 用夹具根可稳定构造该形态。
  // 宿主消费契约（`dsh-tools` 的 postExecute）：`kind==='block'` 时取 `decision.feedback`
  // **直接作为 content**，并 `failureMessageFromContent(decision.feedback)` 取 message；
  // 另有 `decision.additionalContexts ?? []`。故本用例同时钉住这三项的形态。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-blk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');
  const hookPath = join(root, 'hooks', 'deny-post.mjs');
  writeFileSync(
    hookPath,
    [
      "import { readFileSync } from 'node:fs';",
      'let raw = "";',
      "try { raw = readFileSync(0, 'utf8'); } catch {}",
      'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "  hookEventName: 'PostToolUse',",
      "  permissionDecision: 'deny',",
      "  systemMessage: '夹具阻断：工具 ' + String(p.tool_name ?? '') + ' 被拦',",
      "  additionalContext: '夹具附加上下文',",
      "} }) + '\\n');",
      'process.exit(2);',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }],
      },
    }),
    'utf8',
  );

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  mod.apply(ctx, {
    projectDir: dir,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked },
  });

  const agent = { session: { header: { id: 's1', cwd: dir } } };
  let nextCalled = 0;
  const exec = deepFreeze({ name: 'pwsh', arguments: { command: 'echo hi' }, agent, callId: 'c9', signal: undefined });
  // 内部任务-59（内部未决-60）：本层自本批起只对**已派发**的调用派发 PostToolUse 钩子 ⇒ 先经宿主派发点
  // （`tools/execute`）登记"已派发"事实（同一 exec 对象）；否则未派发 ⇒ 直接委托下游，block 分支不可达。
  await ctx.emit('tools/execute', exec, async () => ({ kind: 'continue' }));
  const out = await ctx.emit(
    'tools/post-execute',
    exec,
    deepFreeze({ content: [{ type: 'text', text: 'hi' }] }),
    async () => {
      nextCalled += 1;
      return { kind: 'accept' };
    },
  );
  assert.equal(out.kind, 'block', 'deny 必须映射为 block');
  assert.equal(nextCalled, 0, 'block 时不得委托下游');
  assert.ok(Array.isArray(out.feedback) && out.feedback[0]?.type === 'text', 'feedback 必须是内容块数组');
  assert.match(out.feedback[0].text, /夹具阻断：工具 pwsh 被拦/, 'feedback 必须带钩子文案');
  assert.ok(Array.isArray(out.additionalContexts) && out.additionalContexts.length === 1, 'additionalContext 应折成一个上下文消息');
  assert.match(out.additionalContexts[0].content[0].text, /夹具附加上下文/);
  assert.equal(out.additionalContexts[0].role, 'user', '上下文消息必须带 role（第 75 批修正）');
});

test('UserPromptSubmit 阻断通路：用夹具钩子跑真实 reject 分支（真插件不产出 deny，故需夹具）', async (t) => {
  // 为什么用**夹具插件根**：ZCode 套件插件的 UserPromptSubmit **只注入 additionalContext、
  // 不产出 permissionDecision**（实测 `workflow/hooks/user-prompt.mjs`），所以 `deny → reject`
  // 这条分支**在真实资产上不可达**。但它是本层对外契约的一部分（别的来源/将来可能用），
  // 且第 79 批刚给它加了 `reason` 透传，不能留成"写了没测"。
  // `pluginRoots` 正是为此准备的注入缝：给了就用、不做自动兜底，故夹具根可完全接管五插件位。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');
  // 夹具钩子：读 stdin 负载后输出 **UserPromptSubmit 的 deny 信封**（含 systemMessage 文案）
  const hookPath = join(root, 'hooks', 'deny-prompt.mjs');
  writeFileSync(
    hookPath,
    [
      "import { readFileSync } from 'node:fs';",
      'let raw = "";',
      "try { raw = readFileSync(0, 'utf8'); } catch {}",
      'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "  hookEventName: 'UserPromptSubmit',",
      "  permissionDecision: 'deny',",
      "  systemMessage: '夹具阻断：命中禁语 ' + String(p.prompt ?? ''),",
      "} }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }],
      },
    }),
    'utf8',
  );

  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  mod.apply(ctx, {
    projectDir: dir,
    pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked, 'algo-loop': borked },
  });

  const agent = { session: { header: { id: 's1', cwd: dir } } };
  const out = await ctx.emit(
    'agent/pre-step',
    deepFreeze({ agent, messages: [{ content: [{ type: 'text', text: '禁语在这里' }] }], signal: undefined }),
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(out.kind, 'reject', 'deny 必须映射为 reject（阻断该轮）');
  // 第 79 批加的通路：宿主对 reject 是 `{...decision}` 透传，故 reason 会随 turn/end 留档。
  assert.match(String(out.reason), /夹具阻断：命中禁语 禁语在这里/, 'reject 必须带上钩子的阻断文案（否则文案无处可查）');
});

test('宿主契约钉子（OPEN-46）：pwsh/bash 的结构化 value 与 isError 面', async () => {
  // 为什么要有：适配层读 `result.value.exitCode`（终端工具真退出码）与 `result.isError`
  // （edit/read 类失败的唯一事实）。若宿主升级把退出码只留在渲染文本里、或改名 `isError`，
  // 适配层会静默退化（失败不记），恰是本批修复要防的形态。钉子直读宿主抽取副本源，锚两处。
  // 姿态（评审视角一 #2）：宿主不可得**不静默跳过**——与 hooks-bridge.test.mjs:747 既有钉子
  // 同姿态（静默跳过会让钉子退化为装饰）；本机装有 DSH，故 fail-loud。
  const engine = await import('./helpers/dsh-engine.mjs');
  const decided = engine.ensureEngineCache(); // 契约：dir = `<cache>/node_modules`（dsh-engine.mjs:329/347/376）
  assert.ok(decided.dir !== undefined, `宿主引擎不可得（${decided.mode}）：OPEN-46 宿主契约钉子必须真实执行，不得静默跳过`);
  for (const pkg of ['dsh-tool-pwsh', 'dsh-tool-bash']) {
    const file = join(decided.dir, '@deepseek-ai', pkg, 'lib', 'index.js');
    assert.ok(existsSync(file), `宿主 ${pkg} 源码必须在抽取副本内（宿主升级挪包即红）`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, /exitCode: result\.exitCode/, `${pkg} 的 canonical*Result 必须把真退出码放进结构化 value`);
    assert.match(src, /\[exit code: \$\{result\.exitCode\}\]/, `${pkg} 的渲染标记契约（对照面，不由本层解析）`);
  }
  // 第二锚（评审视角二 #3）：`isError` 半边——edit/read/write 类失败的唯一结构化来源。
  const catalogFile = join(decided.dir, '@deepseek-ai', 'dsh-tool-cordis', 'lib', 'types', 'api-catalog.js');
  assert.ok(existsSync(catalogFile), '宿主类型目录必须在抽取副本内（宿主升级挪包即红）');
  const catalog = readFileSync(catalogFile, 'utf8');
  assert.match(catalog, /ToolExecutionSuccess/, '宿主工具结果成功面类型声明必须在');
  assert.match(catalog, /readonly isError: false;/, '成功面 `isError: false` 字段是适配层读法的宿主依据');
  assert.match(catalog, /ToolExecutionFailure/, '宿主工具结果失败面类型声明必须在');
  assert.match(catalog, /readonly isError: true;/, '失败面 `isError: true` 字段是 edit 类失败的唯一结构化来源');
});

test('端到端：委派深度被如实抬进 Stop 负载（DEV-20 A1/F4）', async (t) => {
  // 为什么要有：夹具钩回显的是**宿主真实抬升链**的产物（agent.session.header / agent.options
  // → payload）。只测 buildPayload 形态证不了这条链（learning 2026-10-01：契约要端到端钉）。
  // 深度来源＝镜像宿主 delegationDepthOf 的两源 max；仅 origin='subagent' 不足以产键。
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-depth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workflow');
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow', version: '0.0.0' }), 'utf8');
  const hookPath = join(root, 'hooks', 'echo-depth.mjs');
  writeFileSync(
    hookPath,
    [
      "import { readFileSync } from 'node:fs';",
      'let raw = "";',
      "try { raw = readFileSync(0, 'utf8'); } catch {}",
      'const p = raw.trim() === "" ? {} : JSON.parse(raw);',
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "  hookEventName: 'Stop',",
      "  additionalContext: 'DEPTH=' + String(p.delegation_depth) + '|HAS=' + String(Object.hasOwn(p, 'delegation_depth')),",
      "} }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'process', command: process.execPath, args: [hookPath], timeoutMs: 15000 }] }] } }),
    'utf8',
  );
  const mod = await import(pathToFileURL(join(COMPAT_ROOT, 'src', 'index.mjs')).href);
  const ctx = hostLikeCtx();
  const borked = join(dir, 'nope');
  await mod.apply(ctx, { projectDir: dir, pluginRoots: { workflow: root, 'spec-gate': borked, scout: borked, 'team-governance': borked } });

  const seen = [];
  const child = { session: { header: { id: 'sess-child', cwd: dir, delegationDepth: 2, origin: 'subagent' } }, inject: (m) => seen.push(m.content[0].text), steer() {} };
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent: child, signal: undefined }));
  assert.match(seen.join('\n'), /DEPTH=2\|HAS=true/, `子代理深度必须如实抬升；实际注入：${JSON.stringify(seen)}`);

  seen.length = 0;
  const parent = { session: { header: { id: 'sess-parent', cwd: dir } }, inject: (m) => seen.push(m.content[0].text), steer() {} };
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent: parent, signal: undefined }));
  assert.match(seen.join('\n'), /DEPTH=0\|HAS=true/, '顶层会话语义＝深度 0（适配层如实抬 0，不编造非零；消费方按 >0 判委派）');

  seen.length = 0;
  const originOnly = { session: { header: { id: 'sess-origin', cwd: dir, origin: 'subagent' } }, inject: (m) => seen.push(m.content[0].text), steer() {} };
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent: originOnly, signal: undefined }));
  assert.match(seen.join('\n'), /DEPTH=0\|HAS=true/, '仅 origin 不足以提升深度（无地板语义，与实现一致）');
  // 内部未决-95（内部任务-48）：同会话再触发一次——漂移告警须恰一次（两事件面共享去重），且本用例
  // 其余会话（有效深度/顶层/运行时源）零告警。
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent: originOnly, signal: undefined }));
  const driftWarns = ctx.byLevel('warn').filter((w) => w.includes('委派深度判据漂移'));
  assert.equal(driftWarns.length, 1, '端到端：origin=subagent 而两深度源皆缺失 → 漂移告警恰一次');

  seen.length = 0;
  const runtimeOnly = { session: { header: { id: 'sess-runtime', cwd: dir } }, options: { subagentDepth: 3 }, inject: (m) => seen.push(m.content[0].text), steer() {} };
  await ctx.emit('agent/turn-stopping', deepFreeze({ agent: runtimeOnly, signal: undefined }));
  assert.match(seen.join('\n'), /DEPTH=3\|HAS=true/, 'options.subagentDepth 是第二权威来源，须取 max 口径');
});

