// 文件：commands-bridge.test.mjs
// 描述：ai-coding-methodology 命令面测试——三层覆盖面：
//       ① 纯函数（命令名归一 / 参数替换 / 行构造 / 文件筛选）；
//       ② 真实仓扫描（9 条命令全部可注册，hint 与 skills 指针解析正确）；
//       ③ 装配（apply 动态探测 commands 服务；followup 驱动 / 无 followup 降级 /
//          注册被拒逐条隔离）。
//       宿主契约按 `@deepseek-ai/dsh-commands` 的 `normalizeDefinition` 复刻为伪注册表：
//       名匹配 `^[a-z][a-z0-9_-]*$`、description 非空、handler 为函数、input.hint 非空。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLogger as makeLoggerStub } from './helpers/logger-stub.cjs';
import { testEngine } from './helpers/engine-binding.mjs';

// 引擎绑定（批 2 阶段 2）：本文件直调 commandNameOf→skillNameOf（引擎驱动），须先绑定真实仓引擎
testEngine();

import {
  ARGUMENTS_PLACEHOLDER,
  COMMAND_NAME_RE,
  IDENTIFIED_ID_RE,
  collectCommands,
  commandFileNames,
  commandLine,
  commandNameOf,
  loadCommand,
  registerCommand,
  registerCommands,
  renderCommandBody,
  userMessage,
} from '../src/commands-bridge.mjs';
import { apply } from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
// 公开包守卫（内部任务-365）：命令文档在公开包内按散文面改写，frontmatter 断言仅源仓执行。
const IS_SOURCE_REPO = existsSync(join(REPO_ROOT, '.deliver'));
const ROOTS = {
  workflow: join(REPO_ROOT, 'workflow'),
  'spec-gate': join(REPO_ROOT, 'spec-gate'),
  scout: join(REPO_ROOT, 'scout'),
  'team-governance': join(REPO_ROOT, 'team-governance'),
};

function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 伪命令注册表：按宿主 `normalizeDefinition` 的完整判据复刻（源码核实，2026-09-28 第 26 批，
 * `dsh-commands/lib/index.js:150`）：
 *   · 名字匹配 `^[a-z][a-z0-9_-]*$`；
 *   · `description` 必须是**字符串且 trim 后非空**（宿主用 trim 判空，第一版替身漏了这点，
 *     且把非串描述也归成同一个错——两种错因在宿主里是不同措辞，如实复刻便于定位）；
 *   · `handler` 必须是函数；
 *   · `input` 若给则须是对象且 `hint` 为非空串（ZCode 的 `argument-hint` 可能是单值或
 *     `[一句话风险]` 形态，适配层会归一）。
 * 另注：宿主限制**必给非空描述**，故本层对"无 description 的命令"必须跳过而不是硬注册。
 */
function makeFakeCommandRegistry() {
  const registered = [];
  return {
    registered,
    register(definition) {
      if (typeof definition.name !== 'string' || !COMMAND_NAME_RE.test(definition.name)) {
        throw new TypeError(`command name "${definition.name}" must match`);
      }
      if (typeof definition.description !== 'string') throw new TypeError(`command "${definition.name}" description must be a string`);
      if (definition.description.trim() === '') throw new TypeError(`command "${definition.name}" description must not be empty`);
      if (typeof definition.handler !== 'function') throw new TypeError(`command "${definition.name}" handler must be a function`);
      if (definition.input !== undefined) {
        if (typeof definition.input !== 'object' || definition.input === null || typeof definition.input.hint !== 'string') {
          throw new TypeError(`command "${definition.name}" input hint must be a string`);
        }
        if (definition.input.hint.trim() === '') throw new TypeError(`command "${definition.name}" input hint must not be empty`);
      }
      if (registered.some((d) => d.name === definition.name)) throw new Error(`duplicate command "${definition.name}"`);
      registered.push(definition);
      return () => {};
    },
  };
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

test('commandNameOf：与 skill 面同规则的前缀命名；非法形态返回空串', () => {
  assert.equal(commandNameOf('workflow', 'feature-dev'), 'workflow-feature-dev');
  assert.equal(commandNameOf('spec-gate', 'gate'), 'spec-gate-gate');
  assert.equal(commandNameOf('team-governance', 'eval'), 'team-governance-eval');
  assert.ok(COMMAND_NAME_RE.test(commandNameOf('spec-gate', 'gate')));
  assert.equal(commandNameOf('p', '---'), '');
});

test('renderCommandBody：$ARGUMENTS 全量替换；无输入替换为空串；$$ 不误伤', () => {
  assert.equal(renderCommandBody('跑 $ARGUMENTS 然后停', '--task-id T-1'), '跑 --task-id T-1 然后停');
  assert.equal(renderCommandBody('跑 $ARGUMENTS 然后停', '   '), '跑  然后停');
  assert.equal(renderCommandBody('a$ARGUMENTSb$ARGUMENTS', 'X'), 'aXbX');
  assert.equal(renderCommandBody('无占位符', 'X'), '无占位符');
  assert.equal(ARGUMENTS_PLACEHOLDER, '$ARGUMENTS');
});

test('commandLine：空输入只回显命令名；有输入原样接续', () => {
  assert.equal(commandLine('spec-gate-gate', ''), '/spec-gate-gate');
  assert.equal(commandLine('spec-gate-gate', '  --task-id T-1  '), '/spec-gate-gate --task-id T-1');
});

test('userMessage：与宿主 createMessage **输出**同形（role + id），source.kind=user', () => {
  const m = userMessage('正文');
  // 宿主用的是 `createUserMessage({ content, source })`，其实现 `createMessage({...input, role:'user'})`
  // 补上 role；而 `createMessage` 自身是 `structuredClone({ ...input, id: randomUUID() })` —— id 同样
  // 是工厂补写的（2026-09-29 第 107 批，内部任务-DSHID-1）。本用例此前用 `deepEqual` 对手写期望
  // （第 76 批改为显式断言 role + 键集合），本轮把键集合换成工厂**输出**形态：含 id。
  assert.equal(m.role, 'user', '必须带 role: user（与宿主 createUserMessage 一致）');
  assert.deepEqual(m.content, [{ type: 'text', text: '正文' }]);
  assert.deepEqual(m.source, { kind: 'user' });
  assert.match(
    m.id,
    IDENTIFIED_ID_RE,
    'userMessage 必须带 uuid 形态的 id（宿主 createMessage 输出形态）',
  );
  assert.notEqual(userMessage('正文').id, userMessage('正文').id, '每次构造必须是新的稳定身份');
  assert.deepEqual(Object.keys(m).sort(), ['content', 'id', 'role', 'source'], '键集合须与宿主消息形态同构');
});

test('commandFileNames：只取顶层 .md、排序确定、目录缺失返回空数组', (t) => {
  const root = makeTemp(t);
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'b.md'), 'x', 'utf8');
  writeFileSync(join(root, 'commands', 'a.md'), 'x', 'utf8');
  writeFileSync(join(root, 'commands', 'note.txt'), 'x', 'utf8');
  mkdirSync(join(root, 'commands', 'sub.md'), { recursive: true });
  assert.deepEqual(commandFileNames(root), ['a.md', 'b.md']);
  assert.deepEqual(commandFileNames(makeTemp(t)), []);
});

test('loadCommand：丢弃条件矩阵（缺 description / 名非法 / 正文空 / frontmatter 坏）', (t) => {
  const root = makeTemp(t);
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'no-desc.md'), '---\nargument-hint: [x]\n---\n正文\n', 'utf8');
  writeFileSync(join(root, 'commands', 'bad.md'), '---\ndescription: d\nnot a kv\n---\n正文\n', 'utf8');
  writeFileSync(join(root, 'commands', 'empty.md'), '---\ndescription: d\n---\n', 'utf8');
  writeFileSync(join(root, 'commands', 'ok.md'), '---\ndescription: 说明\nargument-hint: [a] [b]\nskills: gate\n---\n跑 $ARGUMENTS\n', 'utf8');
  assert.match(loadCommand('workflow', root, 'no-desc.md').skip, /description/);
  assert.match(loadCommand('workflow', root, 'bad.md').skip, /frontmatter/);
  assert.match(loadCommand('workflow', root, 'empty.md').skip, /正文为空/);
  const ok = loadCommand('workflow', root, 'ok.md');
  assert.equal(ok.skip, undefined);
  assert.equal(ok.invocation.name, 'workflow-ok');
  assert.equal(ok.hint, '[a] [b]');
  assert.equal(ok.targetSkill, 'workflow-gate');
  assert.equal(ok.body, '跑 $ARGUMENTS\n');
});

test('loadCommand：argument-hint 的方括号占位符形态不得导致整条命令被丢弃', (t) => {
  const root = makeTemp(t);
  mkdirSync(join(root, 'commands'), { recursive: true });
  for (const [file, hint] of [
    ['a.md', '[特性描述]'],
    ['b.md', '[项目根目录，缺省当前目录]'],
    ['c.md', '[--task-id TASK-n] [--plan docs/plans/x.md] [--plan-check-block]'],
    // 真实资产里唯一的非方括号形态（spec-gate/commands/evidence.md）：角度括号 + 前置 `--`
    ['d.md', '-- <验证命令及参数>'],
  ]) {
    writeFileSync(join(root, 'commands', file), `---\ndescription: d\nargument-hint: ${hint}\n---\n正文\n`, 'utf8');
    assert.equal(loadCommand('workflow', root, file).hint, hint, `${file} 的 hint 应原样保留`);
  }
});

test('真实 6 条 argument-hint 全形态原样保留（不做任何去括号/归一）', { skip: IS_SOURCE_REPO ? false : '公开包命令文档按散文面改写（源仓照跑）' }, () => {
  // 为什么"原样保留"是对的：方括号在 ZCode 里表达**可选**语义，是给用户看的占位符文案；
  // 适配层若擅自剥括号，UI 会显示成 `--task-id TASK-n] [--plan …`（第 27 批一次审计脚本
  // 的过度归一恰好演示了这个错误输出）。定位是"透传"，不是"美化"。
  const { commands } = collectCommands(ROOTS);
  const hints = commands.filter((c) => c.hint !== undefined).map((c) => c.hint);
  assert.equal(hints.length, 6, '五插件共 6 条命令带 argument-hint');
  for (const h of hints) {
    assert.ok(h.trim() !== '', 'hint 不得为空串（宿主 normalizeDefinition 会拒）');
    assert.ok(!/^\s|\s$/.test(h), 'hint 应已 trim（loadCommand 做的是 trim，不是去括号）');
  }
  // spec-gate gate 命令 argument-hint 在 内部任务-241 内部模块-05 修正为「--task-id 去外层方括号、可选参数保留方括号」；
  // 适配层定位是透传，故断言应跟随真实资产（不再期望旧的全外层方括号形态）。
  assert.ok(hints.includes('--task-id TASK-n [--plan docs/plans/x.md] [--plan-check-block]'));
  assert.ok(hints.includes('-- <验证命令及参数>'));
});

// ── ② 真实仓扫描 ────────────────────────────────────────────────────────────

test('collectCommands：坏条目计入 skipped 且不带倒其余（真实资产全绿，故需夹具）', (t) => {
  // 为什么需要（2026-09-28 第 87 批）：上一条真实资产用例断言 `skipped === []`——
  // 也就是说 `collectCommands` 里 `loaded.skip !== undefined` 那条**跳过分支从未被执行**。
  // 这与第 85 批在 `collectSkills` 上补的是**同一处缺陷的姊妹形态**（两个 collect 函数写法对称，
  // 覆盖缺口也对称）。真实五插件 9 条命令都健康，故只能用夹具造坏条目。
  const dir = makeTemp(t);
  const root = join(dir, 'p1');
  mkdirSync(join(root, 'commands'), { recursive: true });
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'p1', version: '0.0.0' }), 'utf8');
  const good = '---\ndescription: 好的命令\n---\n正文\n';
  writeFileSync(join(root, 'commands', 'ok.md'), good, 'utf8');
  // 三种坏法各造一条（**不造"不可读"那条**：`commandFileNames` 用 `statSync(...).isFile()`
  // 预筛，目录冒充文件会被预筛挡掉、根本进不了 loadCommand，故它在 collect 层不可达；
  // 该分支改由下一条用例直接调 loadCommand 覆盖）
  writeFileSync(join(root, 'commands', 'no-desc.md'), '---\ntitle: x\n---\n正文\n', 'utf8');
  writeFileSync(join(root, 'commands', 'bad-fm.md'), '没有定界符\n', 'utf8');
  writeFileSync(join(root, 'commands', 'empty.md'), '---\ndescription: 有描述\n---\n\n', 'utf8');
  // 非 .md 文件应被忽略（不进 skipped，也不进 commands）
  writeFileSync(join(root, 'commands', 'note.txt'), 'x', 'utf8');

  const out = collectCommands({ p1: root });
  assert.equal(out.commands.length, 1, '只有健康那条被收集');
  assert.equal(out.commands[0].invocation.name, 'p1-ok', '命令名 = <插件键>-<文件名>');
  assert.equal(out.skipped.length, 3, `三条坏条目都应计入 skipped：${JSON.stringify(out.skipped)}`);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons['no-desc.md'], /缺少 description/);
  assert.match(reasons['bad-fm.md'], /frontmatter 不可解析/);
  assert.match(reasons['empty.md'], /正文为空/);
  // counts 只统计成功条数；键为插件键 p1
  assert.deepEqual(out.counts, { p1: 1 });
  assert.ok(!out.skipped.some((s) => s.file === 'note.txt'), '非 .md 不该被当成坏条目');
});

test('loadCommand：文件不可读时如实带上原始原因（错误信息不落黑洞）', (t) => {
  // 覆盖 `loadCommand` 的 readFileSync catch（第 87 批查出零覆盖）。collect 层到不了这里
  // （`commandFileNames` 已预筛 isFile），故直接调。
  // 造法：把 `commands/x.md` 造成**目录** ⇒ readFileSync 抛 EISDIR（Windows/POSIX 一致，
  // 不依赖 chmod——chmod 在 Windows 上不可靠）。
  const dir = makeTemp(t);
  mkdirSync(join(dir, 'commands', 'x.md'), { recursive: true });
  const r = loadCommand('workflow', dir, 'x.md');
  assert.ok(r.skip !== undefined, '必须走 skip 而不是抛出');
  assert.match(r.skip, /不可读/, '文案要说明不可读');
  assert.match(r.skip, /EISDIR|directory|目录/i, '必须保留原始错误原因（否则排查只剩"不可读"）');
  assert.match(r.path, /x\.md$/);
});

test('collectCommands：真实五插件 9 条命令全部可注册且名唯一', () => {
  const { commands, skipped, counts } = collectCommands(ROOTS);
  assert.deepEqual(skipped, [], `不应有被跳过的命令：${JSON.stringify(skipped)}`);
  assert.deepEqual(counts, { workflow: 1, 'spec-gate': 5, scout: 0, 'team-governance': 3 });
  assert.equal(commands.length, 9);
  const names = commands.map((c) => c.invocation.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.ok(COMMAND_NAME_RE.test(n), `非法命令名：${n}`);
  for (const c of commands) {
    assert.ok(c.invocation.description.length > 0);
    assert.ok(c.body.includes(ARGUMENTS_PLACEHOLDER), `${c.invocation.name} 的正文应含 $ARGUMENTS`);
    assert.ok(c.body.trim().length > 0);
  }
  assert.ok(names.includes('workflow-feature-dev'));
  assert.ok(names.includes('spec-gate-gate'));
});

test('collectCommands：skills 前言的薄指针翻译为带前缀的 skill 名', () => {
  const { commands } = collectCommands(ROOTS);
  const byName = new Map(commands.map((c) => [c.invocation.name, c]));
  assert.equal(byName.get('spec-gate-gate').targetSkill, 'spec-gate-gate');
  assert.equal(byName.get('spec-gate-spec').targetSkill, 'spec-gate-spec-writing');
  assert.equal(byName.get('team-governance-eval').targetSkill, 'team-governance-agent-eval');
  assert.equal(byName.get('workflow-feature-dev').targetSkill, undefined, 'feature-dev 是编排命令，无单一 skill 指针');
});

test('命令的 skill 薄指针必须落在真实注册的 skill 名上（两面交叉一致性）', async () => {
  const { skills } = await import('../src/skills-bridge.mjs').then((m) => m.collectSkills(ROOTS));
  const skillNames = new Set(skills.map((s) => s.name));
  const { commands } = collectCommands(ROOTS);
  const dangling = commands.filter((c) => c.targetSkill !== undefined && !skillNames.has(c.targetSkill));
  assert.deepEqual(dangling, [], `命令的 skills 指针必须指向已注册 skill：${JSON.stringify(dangling.map((c) => [c.invocation.name, c.targetSkill]))}`);
  const pointed = commands.filter((c) => c.targetSkill !== undefined);
  assert.equal(pointed.length, 6, '当前 9 条命令里 6 条带 skills 薄指针');
});

test('collectCommands + 伪注册表：真实 9 条全部通过宿主形态校验', () => {
  const { commands } = collectCommands(ROOTS);
  const registry = makeFakeCommandRegistry();
  const outcome = registerCommands(registry, commands);
  assert.equal(outcome.registered, 9);
  assert.deepEqual(outcome.failed, []);
  assert.equal(registry.registered.length, 9);
});

// ── ③ 装配 ──────────────────────────────────────────────────────────────────

test('registerCommand：followup 可用时把渲染后的正文入队为下一轮提示词', () => {
  const registry = makeFakeCommandRegistry();
  const entry = {
    plugin: 'workflow',
    body: '按 $ARGUMENTS 走七步流程\n',
    hint: '[特性描述]',
    invocation: { name: 'workflow-feature-dev', description: '说明' },
  };
  registerCommand(registry, entry);
  const enqueued = [];
  const invocation = { agent: { followup: (m) => enqueued.push(m) }, rawInput: ' 做导出功能 ' };
  const result = registry.registered[0].handler(invocation);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /workflow-feature-dev/);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].content, [{ type: 'text', text: '按 做导出功能 走七步流程\n' }]);
  assert.deepEqual(enqueued[0].source, { kind: 'user' });
  assert.equal(registry.registered[0].input.hint, '[特性描述]');
});

test('registerCommand：无 followup 时不假装驱动——回执里交出渲染后的正文', () => {
  const registry = makeFakeCommandRegistry();
  registerCommand(registry, { plugin: 'spec-gate', body: '跑 $ARGUMENTS\n', invocation: { name: 'spec-gate-evidence', description: '说明' } });
  const result = registry.registered[0].handler({ agent: {}, rawInput: 'npm test' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /未驱动 agent/);
  assert.match(result.text, /跑 npm test/);
});

test('registerCommand：startTurn=false 时只回执（配置面可控）', () => {
  const registry = makeFakeCommandRegistry();
  registerCommand(registry, { plugin: 'workflow', body: 'x $ARGUMENTS\n', invocation: { name: 'workflow-x', description: 'd' } }, { startTurn: false });
  const enqueued = [];
  const result = registry.registered[0].handler({ agent: { followup: (m) => enqueued.push(m) }, rawInput: 'a' });
  assert.equal(enqueued.length, 0);
  assert.match(result.text, /未驱动 agent/);
});

test('registerCommand：followup 抛错时返回 error 结果（有界失败，不冒泡）', () => {
  const registry = makeFakeCommandRegistry();
  const warnings = [];
  registerCommand(registry, { plugin: 'workflow', body: 'x\n', invocation: { name: 'workflow-x', description: 'd' } }, { logger: { warn: (m) => warnings.push(String(m)) } });
  const result = registry.registered[0].handler({ agent: { followup: () => { throw new Error('队列关闭'); } }, rawInput: '' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /队列关闭/);
  assert.equal(warnings.length, 1);
});

test('registerCommand：带上插件命名空间的稳定 definitionId（宿主据此跨文案认出同一条命令）', () => {
  const registry = makeFakeCommandRegistry();
  registerCommand(registry, { plugin: 'workflow', body: 'x\n', invocation: { name: 'workflow-x', description: 'd' } });
  const def = registry.registered[0];
  assert.equal(def.definitionId, 'ai-coding-methodology/ai-coding-methodology/workflow-x');
  assert.ok(def.definitionId.includes('ai-coding-methodology'), 'definitionId 必须带插件命名空间（宿主按此认身份）');
});

test('registerCommands：真实 9 条命令各自 definitionId 唯一且稳定', () => {
  const { commands } = collectCommands(ROOTS);
  const registry = makeFakeCommandRegistry();
  registerCommands(registry, commands);
  const ids = registry.registered.map((d) => d.definitionId);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9, 'definitionId 必须唯一');
  for (const id of ids) assert.match(id, /^ai-coding-methodology\/ai-coding-methodology\/[a-z][a-z0-9_-]*$/);
});

test('真实 9 条命令全部通过宿主 normalizeDefinition 的完整判据', () => {
  const { commands, skipped } = collectCommands(ROOTS);
  assert.deepEqual(skipped, [], `不应有命令被跳过：${JSON.stringify(skipped)}`);
  const registry = makeFakeCommandRegistry();
  const outcome = registerCommands(registry, commands);
  assert.equal(outcome.registered, 9, `全部必须被宿主接受，实际失败：${JSON.stringify(outcome.failed)}`);
  assert.deepEqual(outcome.failed, []);
  // 每条的 description 与 handler 都必须真实可用（宿主会 trim 判空、并调用 handler）
  for (const d of registry.registered) {
    assert.ok(d.description.trim().length > 0, `${d.name} 描述不得为空`);
    assert.equal(typeof d.handler, 'function');
    if (d.input !== undefined) assert.ok(d.input.hint.trim().length > 0, `${d.name} 的 input.hint 不得为空`);
  }
});

test('registerCommands：注册被拒逐条隔离，不带倒其余', () => {
  const registry = makeFakeCommandRegistry();
  const warnings = [];
  const outcome = registerCommands(registry, [
    { plugin: 'a', body: 'x\n', invocation: { name: 'ok-one', description: 'd' } },
    { plugin: 'a', body: 'x\n', invocation: { name: 'Bad Name', description: 'd' } },
    { plugin: 'a', body: 'x\n', invocation: { name: 'ok-two', description: 'd' } },
  ], { logger: { warn: (m) => warnings.push(String(m)) } });
  assert.equal(outcome.registered, 2);
  assert.equal(outcome.failed.length, 1);
  assert.equal(warnings.length, 1);
});

/** 造伪 ctx：可注入 commands 服务（并复用真实 shell/skills 探测路径）。 */
function makeCtx({ withCommands = true } = {}) {
  const listeners = new Map();
  const logger = makeLoggerStub();
  const commandRegistry = withCommands ? makeFakeCommandRegistry() : undefined;
  const services = new Map();
  if (withCommands) services.set('commands', commandRegistry);
  services.set('skills', { register: () => () => {} });
  services.set('shell', {
    resolve: (r) => r,
    async execute(spec) {
      const r = spawnSync(spec.command, { shell: true, cwd: spec.workdir, env: { ...process.env, ...(spec.env ?? {}) }, input: spec.stdin ?? '', encoding: 'utf8', windowsHide: true });
      return { result: async () => ({ exitCode: r.status, stdout: { text: r.stdout ?? '' }, stderr: { text: r.stderr ?? '' } }) };
    },
  });
  return {
    commandRegistry,
    logger,
    byLevel: (level) => logger.byLevel(level),
    get: (serviceName) => services.get(serviceName),
    on: (e, fn) => {
      if (!listeners.has(e)) listeners.set(e, []);
      listeners.get(e).push(fn);
    },
    effect: () => {},
  };
}

test('apply：三面共存——五事件 + 32 skill + 9 命令', async () => {
  const ctx = makeCtx();
  await apply(ctx, { projectDir: REPO_ROOT });
  assert.equal(ctx.commandRegistry.registered.length, 9);
  assert.ok(ctx.byLevel('info').some((m) => m.includes('注册命令 9 条')));
  assert.ok(ctx.byLevel('info').some((m) => m.includes('注册 skill 32 条')));
});

test('apply：宿主无 commands 服务时命令面跳过，钩子面与 skill 面照常', async () => {
  const ctx = makeCtx({ withCommands: false });
  await apply(ctx, { projectDir: REPO_ROOT });
  assert.ok(ctx.byLevel('info').some((m) => m.includes('未提供 commands 服务')));
  assert.ok(ctx.byLevel('info').some((m) => m.includes('注册 skill 32 条')));
});

test('apply：startTurn 配置透传（false 时命令不回执入队）', async () => {
  const ctx = makeCtx();
  await apply(ctx, { projectDir: REPO_ROOT, startTurn: false });
  const enqueued = [];
  const def = ctx.commandRegistry.registered.find((d) => d.name === 'spec-gate-gate');
  const result = def.handler({ agent: { followup: (m) => enqueued.push(m) }, rawInput: '--task-id T-1' });
  assert.equal(enqueued.length, 0);
  assert.match(result.text, /未驱动 agent/);
});
