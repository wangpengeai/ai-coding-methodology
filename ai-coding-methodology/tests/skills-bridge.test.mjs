// 文件：skills-bridge.test.mjs
// 描述：ai-coding-methodology skill 面测试——三层覆盖面：
//       ① 纯函数（frontmatter 解析 / 名归一 / 布尔字面量）；
//       ② 真实仓扫描（32 份 SKILL.md 全部可注册，字段翻译正确）；
//       ③ 装配（apply 动态探测 skills 服务；注册失败逐条隔离；无该服务时钩子面照常）。
//       宿主契约按 `@deepseek-ai/dsh-skill` 的 `validateRuntimeSkill` 复刻为伪注册表：
//       名必须匹配 kebab-case 正则、description 非空、invocation 两布尔齐备。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLogger as makeLoggerStub } from './helpers/logger-stub.cjs';
import { testEngine } from './helpers/engine-binding.mjs';

// 引擎绑定（批 2 阶段 2）：本文件直调 skillNameOf（引擎驱动），须先经共享 helper 绑定真实仓引擎
testEngine();

import { apply } from '../src/index.mjs';
import { SKILL_NAME_RE, booleanField, collectSkills, loadSkill, parseFrontmatter, registerSkills, skillDirNames, skillNameOf } from '../src/skills-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(COMPAT_ROOT, '..');

/** 建临时目录并在测试结束后自动清理。 */
function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-coding-methodology-skill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 伪 skill 注册表：**按宿主 `register()` 的完整语义**复刻（源码核实，2026-09-28 第 26 批，
 * `dsh-skill/lib/index.js`）：
 *   · 先过 `validateRuntimeSkill`——名字须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、描述非空、
 *     `invocation`（若给）的两个布尔字段必须是 boolean（对应 `validateInvocation` L505）；
 *   · **同层同名 first-wins**：已存在则记一条 warn 并返回**空操作 disposer**，
 *     新条目**不覆盖**、也**不入列**；
 *   · 缺省补 `invocation = {modelInvocable:true, userInvocable:true}` 与 `provider = RUNTIME_PROVIDER`。
 * 第一版替身少了 first-wins 与补默认值这两条，会让"重复注册"在测试里看起来是成功的。
 */
function makeFakeRegistry() {
  const registered = [];
  const warnings = [];
  const RUNTIME_PROVIDER = 'runtime';
  return {
    registered,
    warnings,
    register(skill) {
      if (typeof skill.name !== 'string' || !SKILL_NAME_RE.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`);
      if (typeof skill.description !== 'string' || skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`);
      const inv = skill.invocation;
      if (inv !== undefined) {
        if (typeof inv !== 'object' || inv === null || Array.isArray(inv)) throw new Error(`skill "${skill.name}" with a non-object invocation policy`);
        if (typeof inv.modelInvocable !== 'boolean') throw new Error(`skill "${skill.name}" with a non-boolean invocation.modelInvocable`);
        if (typeof inv.userInvocable !== 'boolean') throw new Error(`skill "${skill.name}" with a non-boolean invocation.userInvocable`);
      }
      // 同层同名 first-wins
      if (registered.some((s) => s.name === skill.name)) {
        warnings.push(`runtime skill "${skill.name}" ignored because it is already registered`);
        return () => {};
      }
      registered.push({
        ...skill,
        invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
        provider: skill.provider ?? RUNTIME_PROVIDER,
      });
      return () => {};
    },
  };
}

/** 造一个只带 skills 的插件根。 */
function makeSkillPlugin(t, plugin, skills) {
  const root = makeTemp(t);
  mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: plugin, version: '0.0.0' }), 'utf8');
  for (const [dirName, body] of Object.entries(skills)) {
    mkdirSync(join(root, 'skills', dirName), { recursive: true });
    writeFileSync(join(root, 'skills', dirName, 'SKILL.md'), body, 'utf8');
  }
  return root;
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

test('skillNameOf：插件前缀 + kebab 归一；非法形态返回空串', () => {
  assert.equal(skillNameOf('workflow', 'plan-writing'), 'workflow-plan-writing');
  assert.equal(skillNameOf('spec-gate', 'gate'), 'spec-gate-gate');
  assert.equal(skillNameOf('team_governance', 'agent_eval'), 'team-governance-agent-eval');
  assert.equal(skillNameOf('scout', 'Scout'), 'scout-scout');
  assert.equal(skillNameOf('', 'gate'), 'gate');
  assert.ok(SKILL_NAME_RE.test(skillNameOf('spec-gate', 'gate')));
  assert.equal(skillNameOf('p', '---'), '', '全符号目录名归一后为空 → 丢弃');
});

test('parseFrontmatter：标量 / 布尔 / metadata 嵌套 map / 无 frontmatter', () => {
  const text = '---\nname: gate\ndescription: 一句话功能 —— 触发条件：完成声明前\nlicense: MIT\nmetadata:\n  owner: wangp\n  tier: core\n---\n\n# 正文\n内容。\n';
  const p = parseFrontmatter(text);
  assert.equal(p.ok, true);
  assert.equal(p.fields.name, 'gate');
  assert.equal(p.fields.description, '一句话功能 —— 触发条件：完成声明前');
  assert.equal(p.fields.license, 'MIT');
  assert.deepEqual(p.fields.metadata, { owner: 'wangp', tier: 'core' });
  assert.ok(p.body.startsWith('\n# 正文'), '正文自定界符之后原样保留');

  const quoted = parseFrontmatter('---\ndescription: "带: 冒号 的值"\n---\nbody');
  assert.equal(quoted.fields.description, '带: 冒号 的值');

  const none = parseFrontmatter('# 没有 frontmatter');
  assert.equal(none.ok, false);
  assert.equal(none.body, '# 没有 frontmatter', '无定界符时正文即全文');
});

test('parseFrontmatter：块标量与流式集合按不支持处置（宁缺勿错析）', () => {
  const block = parseFrontmatter('---\ndescription: |\n  多行\n---\nbody');
  assert.equal(block.ok, false);
  assert.match(block.reason, /块标量/);
  const flow = parseFrontmatter('---\ntags: [a, b]\n---\nbody');
  assert.equal(flow.ok, false);
  assert.match(flow.reason, /取值形态不支持|流式/);
  const badLine = parseFrontmatter('---\nnot a kv line\n---\nbody');
  assert.equal(badLine.ok, false);
});

test('流式集合判据：只有"引号内"的分隔符不算顶层分隔符（判据文档的"引号外"）', () => {
  // 为什么需要（2026-09-28 第 89 批）：覆盖率显示 `hasTopLevelFlowSeparator` 的
  // **引号跟踪那两段**（进入引号 / 退出引号）从未执行——既有用例只喂了朴素的 `[a, b]`。
  // 而这两段正是该函数**文档明写**的判据的一部分（"顶层（深度 1、**引号外**）出现 `,` 或 `:`"）。
  //
  // ⚠ 输入必须让分隔符**出现在引号内**才走得到那两段。第一版我写了 `[a, "b,c"]` 并断言
  // "应放行"——错了：那个逗号在 `a` 之后、**引号之外**，检测在扫描到引号前就已返回 true。
  // 真正需要引号跟踪的是 `["a,b"]`：逗号前先遇到 `"` ⇒ 进入引号态 ⇒ 跳过 ⇒ 扫描到串尾
  // 仍未在顶层见分隔符 ⇒ 按普通标量读（判据"宁缺勿错"：误判成标量的代价只是把文本当字符串用）。
  const quoted = parseFrontmatter('---\ndescription: ["a,b"]\n---\nbody');
  assert.equal(quoted.ok, true, '引号内的逗号不算顶层分隔符 ⇒ 当普通标量读');
  assert.equal(quoted.fields.description, '["a,b"]', '原样保留');
  // 单引号同样被跟踪（引号字符是成对判据，不特判双引号）
  const single = parseFrontmatter("---\ndescription: ['a,b']\n---\nbody");
  assert.equal(single.ok, true);
  assert.equal(single.fields.description, "['a,b']");
  // 冒号同理（否则含冒号的引号值会被误判成 map）
  assert.equal(parseFrontmatter('---\ndescription: ["a:b"]\n---\nbody').ok, true);
  // **对照**：引号外只要还有一个真分隔符，就仍判为集合 ⇒ 不支持处置。
  // 这条把"引号跟踪只影响被引号包住的那段"钉死，防止将来把引号跟踪写成"见到引号就整体放行"。
  assert.equal(parseFrontmatter('---\ndescription: ["a,b", c]\n---\nbody').ok, false);
  assert.equal(parseFrontmatter('---\ndescription: [a, b]\n---\nbody').ok, false);
  // `{…}` 形态：闭合符按 `open` 选；`{k: "a,b"}` 的冒号在引号外 ⇒ 仍是集合
  assert.equal(parseFrontmatter('---\ndescription: {k: v}\n---\nbody').ok, false);
  assert.equal(parseFrontmatter('---\ndescription: {k: "a,b"}\n---\nbody').ok, false);
  // 深度归零于串尾（内层无分隔符）⇒ 当普通标量读
  const nested = parseFrontmatter('---\ndescription: [[a]]\n---\nbody');
  assert.equal(nested.ok, true);
  assert.equal(nested.fields.description, '[[a]]');
  // **括号内出现"不成对引号"**：闭合符被引号态吃掉 ⇒ depth 永远回不到 0 ⇒ 循环自然结束、
  // 走到函数末尾的 `return false` ⇒ 同样按普通标量读。这条覆盖的是 L158 那个兜底 return，
  // 2026-09-28 第 89 批先误判它"不可达"，用**直接计数**（把该行变异成累加计数器再穷举输入）
  // 才查清它其实可达（穷举 2928 条输入里 1212 条触达）。**判定"不可达"必须用仪器，不能只靠推理。**
  for (const v of ['[a"b,c]', "[a'b,c]", '{a"b,c}']) {
    const r = parseFrontmatter(`---\ndescription: ${v}\n---\nbody`);
    assert.equal(r.ok, true, `${v}：不成对引号 ⇒ 当普通标量读（不因此丢字段）`);
    assert.equal(r.fields.description, v);
  }
  // 对照：成对引号 + 引号外的真分隔符，仍按集合处置（走的是早退分支，不是这个兜底）
  assert.equal(parseFrontmatter('---\ndescription: ["a",b]\n---\nbody').ok, false);
});

test('booleanField：宿主同表的布尔字面量；非法形态返回 null', () => {
  assert.equal(booleanField(undefined), undefined);
  assert.equal(booleanField(true), true);
  for (const v of ['true', 'TRUE', 'yes', 'On', '1']) assert.equal(booleanField(v), true, v);
  for (const v of ['false', 'no', 'OFF', '0']) assert.equal(booleanField(v), false, v);
  assert.equal(booleanField('maybe'), null);
  assert.equal(booleanField(1), null);
});

test('loadSkill：字段翻译与丢弃条件矩阵', (t) => {
  const root = makeSkillPlugin(t, 'workflow', {
    good: '---\nname: good\ndescription: 描述体\nlicense: MIT\nwhenToUse: 需要时\n---\n正文\n',
    'no-desc': '---\nname: x\n---\n正文\n',
    'no-invocation': '---\ndescription: d\ndisable-model-invocation: true\n---\n正文\n',
    'not-for-user': '---\ndescription: d\nuser-invocable: false\n---\n正文\n',
    'bad-bool': '---\ndescription: d\nuser-invocable: maybe\n---\n正文\n',
    'empty-body': '---\ndescription: d\n---\n',
  });
  const good = loadSkill('workflow', root, 'good');
  assert.equal(good.skip, undefined);
  assert.equal(good.skill.name, 'workflow-good');
  assert.equal(good.skill.description, '描述体');
  assert.equal(good.skill.whenToUse, '需要时');
  assert.equal(good.skill.source, 'ai-coding-methodology:workflow');
  assert.equal(good.skill.content, '正文\n');
  assert.deepEqual(good.skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.ok(good.skill.path.endsWith(join('good', 'SKILL.md')));
  assert.equal(good.skill.license, undefined, 'license 不透传（宿主运行时条目无自定义字段位）');

  assert.match(loadSkill('workflow', root, 'no-desc').skip, /description/);
  assert.match(loadSkill('workflow', root, 'no-invocation').skip, /disable-model-invocation/);
  assert.match(loadSkill('workflow', root, 'not-for-user').skip, /user-invocable/);
  assert.match(loadSkill('workflow', root, 'bad-bool').skip, /非布尔/);
  assert.match(loadSkill('workflow', root, 'empty-body').skip, /正文为空/);
  assert.match(loadSkill('workflow', root, 'missing').skip, /不可读/);
});

test('skillDirNames：只取目录、排序确定、缺失目录返回空数组', (t) => {
  const root = makeSkillPlugin(t, 'workflow', { b: '---\ndescription: d\n---\nx\n', a: '---\ndescription: d\n---\nx\n' });
  writeFileSync(join(root, 'skills', 'loose.md'), 'x', 'utf8');
  assert.deepEqual(skillDirNames(root), ['a', 'b']);
  assert.deepEqual(skillDirNames(makeTemp(t)), []);
});

test('collectSkills：坏条目计入 skipped 且不带倒其余（真实资产全绿，故需夹具）', (t) => {
  // 为什么需要（2026-09-28 第 85 批）：上一条真实资产用例断言 `skipped === []`——
  // 也就是说 `collectSkills` 里 `loaded.skip !== undefined` 那条**跳过分支从未被执行**。
  // 真实六插件 32 份都健康，故只能用夹具造坏条目。这条通路关系"一个坏 skill 不该
  // 让整批收集失败"（fail-open 的同族姿态），值得单独钉住。
  const good = { p1: makeSkillPlugin(t, 'workflow', { ok: '---\ndescription: 好的\n---\n正文\n' }) };
  const badArgs = [
    // ① 缺 description
    ['no-desc', '---\ntitle: x\n---\n正文\n'],
    // ② frontmatter 不可解析
    ['bad-fm', '正文没有定界符\n'],
    // ③ 正文为空
    ['empty-body', '---\ndescription: 有描述\n---\n\n'],
    // ④ 不可读（用目录冒充 SKILL.md ⇒ readFileSync(EISDIR)）
    ['unreadable', null],
  ];
  for (const [dir, content] of badArgs) {
    const p = join(good.p1, 'skills', dir);
    mkdirSync(p, { recursive: true });
    if (content === null) mkdirSync(join(p, 'SKILL.md'), { recursive: true });
    else writeFileSync(join(p, 'SKILL.md'), content, 'utf8');
  }
  const out = collectSkills(good);
  assert.equal(out.skills.length, 1, '只有健康那条被收集');
  assert.equal(out.skills[0].name, 'p1-ok', 'skill 名 = <插件键>-<目录名>，键是 p1 不是 workflow');
  assert.equal(out.skipped.length, 4, `四条坏条目都应计入 skipped：${JSON.stringify(out.skipped)}`);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.dir, s.reason]));
  assert.match(reasons['no-desc'], /缺少 description/);
  assert.match(reasons['bad-fm'], /frontmatter 不可解析/);
  assert.match(reasons['empty-body'], /正文为空/);
  assert.match(reasons['unreadable'], /不可读/);
  // counts 只统计成功条数（否则日志里的分插件计数会把坏条目也算进去）；键同为插件键 p1
  assert.equal(out.counts.p1, 1);
  assert.deepEqual(Object.keys(out.counts), ['p1']);
  // 反向对照：健康那条的正文与描述确实取到了（不是"全都跳过了"
  assert.ok(out.skills[0].content.includes('正文'));
  assert.equal(out.skills[0].description, '好的');
});

test('registerSkills：逐条隔离失败，单条形态非法不带倒其余', () => {
  const registry = makeFakeRegistry();
  const logger = makeLoggerStub();
  const outcome = registerSkills(registry, [
    { name: 'ok-one', description: 'd', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'Bad Name', description: 'd' },
    { name: 'no-desc', description: '' },
    { name: 'ok-two', description: 'd' },
  ], logger);
  assert.equal(outcome.registered, 2);
  assert.deepEqual(registry.registered.map((s) => s.name), ['ok-one', 'ok-two']);
  assert.equal(outcome.failed.length, 2);
  assert.equal(logger.byLevel('warn').length, 2);
});

test('内部任务-273 M-05：registerSkills 保留宿主 disposer（回收由装配层 ctx.effect 负责）', () => {
  const calls = [];
  const registry = {
    register: (s) => {
      calls.push(`register:${s.name}`);
      return () => calls.push(`dispose:${s.name}`);
    },
  };
  const outcome = registerSkills(registry, [
    { name: 'a', description: 'd' },
    { name: 'b', description: 'd' },
  ], undefined);
  assert.equal(outcome.registered, 2);
  assert.equal(outcome.disposers.length, 2, '每个成功注册都保留 disposer（旧实现丢弃）');
  for (const dispose of outcome.disposers) dispose();
  assert.deepEqual(calls, ['register:a', 'register:b', 'dispose:a', 'dispose:b']);
  // 宿主返回非函数（形态差异）时不误收
  const noDisposer = registerSkills({ register: () => undefined }, [{ name: 'c', description: 'd' }], undefined);
  assert.deepEqual(noDisposer.disposers, []);
});

test('真实 32 条 skill 全部通过宿主 validateRuntimeSkill 的完整判据', () => {
  const roots = {
    workflow: join(REPO_ROOT, 'workflow'),
    'spec-gate': join(REPO_ROOT, 'spec-gate'),
    scout: join(REPO_ROOT, 'scout'),
    'team-governance': join(REPO_ROOT, 'team-governance'),
    'algo-loop': join(REPO_ROOT, 'algo-loop'),
    'research-loop': join(REPO_ROOT, 'research-loop'),
  };
  const { skills } = collectSkills(roots);
  assert.equal(skills.length, 32, '六插件共 32 条 skill');
  const registry = makeFakeRegistry();
  const outcome = registerSkills(registry, skills, makeLoggerStub());
  assert.equal(outcome.registered, 32, `全部必须被宿主接受，实际失败：${JSON.stringify(outcome.failed)}`);
  assert.deepEqual(outcome.failed, []);
  // 落进注册表的条目必须带上宿主补的默认值（provider=runtime、invocation 双 true）
  for (const s of registry.registered) {
    assert.equal(s.provider, 'runtime');
    assert.deepEqual(s.invocation, { modelInvocable: true, userInvocable: true });
  }
});

test('宿主同名 first-wins：重复注册被拒且不入列，第二条不覆盖第一条', () => {
  const registry = makeFakeRegistry();
  const first = { name: 'dup-skill', description: '第一条', invocation: { modelInvocable: true, userInvocable: true } };
  const second = { name: 'dup-skill', description: '第二条（不应覆盖）', invocation: { modelInvocable: true, userInvocable: true } };
  registry.register(first);
  registry.register(second);
  assert.equal(registry.registered.length, 1, '同层同名只保留第一条');
  assert.equal(registry.registered[0].description, '第一条');
  assert.ok(registry.warnings.some((w) => /already registered/.test(w)), '重复注册必须告警');
});

// ── ② 真实仓扫描 ────────────────────────────────────────────────────────────

test('collectSkills：真实六插件 32 份 SKILL.md 全部可注册且名唯一', () => {
  const roots = {
    workflow: join(REPO_ROOT, 'workflow'),
    'spec-gate': join(REPO_ROOT, 'spec-gate'),
    scout: join(REPO_ROOT, 'scout'),
    'team-governance': join(REPO_ROOT, 'team-governance'),
    'algo-loop': join(REPO_ROOT, 'algo-loop'),
    'research-loop': join(REPO_ROOT, 'research-loop'),
  };
  const { skills, skipped, counts } = collectSkills(roots);
  assert.deepEqual(skipped, [], `不应有被跳过的 skill：${JSON.stringify(skipped)}`);
  assert.deepEqual(counts, { workflow: 20, 'spec-gate': 4, scout: 3, 'team-governance': 2, 'algo-loop': 1, 'research-loop': 2 });
  assert.equal(skills.length, 32);
  const names = skills.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'DSH 名不得重名（重名会被注册表静默忽略后者）');
  for (const n of names) assert.ok(SKILL_NAME_RE.test(n), `非法 DSH 名：${n}`);
  for (const s of skills) {
    assert.ok(s.description.length > 0);
    assert.ok(s.content.trim().length > 0);
    assert.ok(s.path.endsWith('SKILL.md'));
    assert.match(s.source, /^ai-coding-methodology:/);
  }
  // 前缀让来源在名字里可见，并消除跨插件同名与拼写变体撞名
  assert.ok(names.includes('spec-gate-gate'), 'spec-gate/skills/gate 必须带前缀');
  assert.ok(names.includes('workflow-workflow'), '元技能入口带前缀后即为 workflow-workflow');
  assert.ok(names.includes('team-governance-agent-eval'), '下划线目录名归一为 kebab');
});

test('collectSkills + 伪注册表：真实 32 条全部通过宿主形态校验', () => {
  const { skills } = collectSkills({
    workflow: join(REPO_ROOT, 'workflow'),
    'spec-gate': join(REPO_ROOT, 'spec-gate'),
    scout: join(REPO_ROOT, 'scout'),
    'team-governance': join(REPO_ROOT, 'team-governance'),
    'algo-loop': join(REPO_ROOT, 'algo-loop'),
    'research-loop': join(REPO_ROOT, 'research-loop'),
  });
  const registry = makeFakeRegistry();
  const outcome = registerSkills(registry, skills);
  assert.equal(outcome.registered, 32);
  assert.deepEqual(outcome.failed, []);
});

test('真实 skill 正文以磁盘为准：注册内容与文件字节一致（不复制、不加工）', () => {
  const file = join(REPO_ROOT, 'workflow', 'skills', 'workflow', 'SKILL.md');
  const loaded = loadSkill('workflow', join(REPO_ROOT, 'workflow'), 'workflow');
  const raw = readFileSync(file, 'utf8');
  assert.ok(raw.endsWith(loaded.skill.content), 'content 是 frontmatter 之后的原文');
  assert.equal(loaded.skill.path, file);
});

// ── ③ 装配 ──────────────────────────────────────────────────────────────────

/** 造伪 ctx：可注入或不注入 skills 服务。 */
function makeCtx({ withSkills = true } = {}) {
  const listeners = new Map();
  const logger = makeLoggerStub();
  const registry = withSkills ? makeFakeRegistry() : undefined;
  const services = new Map();
  if (withSkills) services.set('skills', registry);
  services.set('shell', {
    resolve: (r) => r,
    async execute(spec) {
      const r = spawnSync(spec.command, { shell: true, cwd: spec.workdir, env: { ...process.env, ...(spec.env ?? {}) }, input: spec.stdin ?? '', encoding: 'utf8', windowsHide: true });
      return { result: async () => ({ exitCode: r.status, stdout: { text: r.stdout ?? '' }, stderr: { text: r.stderr ?? '' } }) };
    },
  });
  return {
    registry,
    logger,
    byLevel: (level) => logger.byLevel(level),
    listeners,
    get: (name) => services.get(name),
    on: (e, fn) => {
      if (!listeners.has(e)) listeners.set(e, []);
      listeners.get(e).push(fn);
    },
    effect: () => {},
  };
}

test('apply：宿主提供 skills 服务时完成 32 条注册，钩子面同时在线', async () => {
  const ctx = makeCtx({ withSkills: true });
  await apply(ctx, { projectDir: REPO_ROOT });
  assert.equal(ctx.registry.registered.length, 32);
  const names = ctx.registry.registered.map((s) => s.name);
  assert.ok(names.includes('workflow-workflow'), '元技能入口必须在册');
  assert.ok(names.includes('spec-gate-gate'), '完成门禁入口必须在册');
  assert.ok(names.includes('plan-execution') === false, 'ZCode 原名不直接使用（统一带插件前缀）');
  assert.ok(names.includes('workflow-plan-execution'));
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/execute', 'tools/post-execute', 'tools/pre-execute']);
});

test('apply：宿主无 skills 服务时 skill 面跳过，钩子面照常注册（两面独立）', async () => {
  const ctx = makeCtx({ withSkills: false });
  await apply(ctx, { projectDir: REPO_ROOT });
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/execute', 'tools/post-execute', 'tools/pre-execute']);
  assert.ok(ctx.byLevel('info').some((m) => m.includes('未提供 skills 服务')));
});

test('apply：注册表抛错时逐条隔离，apply 本身不抛（fail-open）', () => {
  const ctx = makeCtx({ withSkills: true });
  const realRegister = ctx.get('skills').register;
  let calls = 0;
  ctx.get('skills').register = (skill) => {
    calls += 1;
    if (calls === 1) throw new Error('宿主拒收');
    return realRegister.call(ctx.get('skills'), skill);
  };
  assert.doesNotThrow(() => apply(ctx, { projectDir: REPO_ROOT }));
  // 32 条实收中第 1 条被宿主拒收 → 落表 31 条（fail-open 逐条隔离）
  assert.equal(ctx.registry.registered.length, 31);
});
