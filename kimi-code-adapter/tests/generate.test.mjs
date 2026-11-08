// 文件：kimi-code-adapter/tests/generate.test.mjs
// 描述：生成面测试——hooks[] 声明翻译（近恒等直译 + SessionStart 收窄 + 22 计数）、清单
//       构造与宿主判据复刻校验（name 正则 / SemVer / 包根内路径 / 白名单键）、skill 文档面、
//       命令面 .md 判据、agent 词表映射、引擎闭包清单与 import 图、解释器三级回退、
//       staging marketplace JSON。全部跑**真实资产**（六插件中立清单 / commands / agents /
//       skills），不做替身；断言点按宿主文档判据复刻，「改了声明而宿主会拒」无处可藏。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, it, test } from 'node:test';

import { applyAgentGate, buildAgentDoc, convertAgentText, mapAgentTools, AGENT_TOOL_MAP, AGENT_TOOL_DROPPED } from '../src/agents.mjs';
import { loadEngine } from '../../plugin-core/src/engine.mjs';
import { listEngineFiles } from '../src/engine-files.mjs';
import { commandLineOf, matcherOf, scriptRelOf, timeoutOf, translateHookDeclarations, validateHookEntries } from '../src/hook-template.mjs';
import { buildManifest, isInPackageRelPath, isSemVer, parseFrontmatter, validateCommandFiles, validateManifest, validateSkillDocs } from '../src/manifest.mjs';
import { buildMarketplaceJson, validateMarketplaceJson } from '../src/staging.mjs';
import { resolveNode } from '../src/node-resolve.mjs';
import { PLUGINS, planPackage } from '../cli.mjs';
import { REPO_ROOT } from './helpers.mjs';

const NODE = 'C:/fake/node.exe';

/** 4 条薄指针（内部接口-1.md:146 点名；与 mcode COMMAND_DISPOSITION covered-by-skill 一致）。 */
const THIN_POINTERS = [
  { plugin: 'spec-gate', command: 'gate', skill: 'gate' },
  { plugin: 'spec-gate', command: 'backfill', skill: 'spec-backfill' },
  { plugin: 'spec-gate', command: 'spec', skill: 'spec-writing' },
  { plugin: 'team-governance', command: 'eval', skill: 'agent-eval' },
];

const normLine = (s) => s.trim().replace(/\s+/g, ' ');

/** 剥离围栏代码块，取出围栏外正文；围栏内容由 `copiesSkillBody` 单独逐段比对。 */
function stripFences(text) {
  return text.split('```').filter((_, i) => i % 2 === 0).join('');
}

/** 读取命令/skill 文本并拆出 frontmatter 与正文。 */
function readSplit(rel) {
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const body = text.replace(/^---[\s\S]*?---\r?\n?/, '');
  return { data, body };
}

/** 副本检测：分别比对命令的围栏外正文与每个围栏内容（均与 stripFences(skill) 比较），
 *  命中 ≥60 字连续片段或 ≥40 字逐行相同即判副本。围栏内容必须单独比较——整段粘贴进
 *  单围栏时 stripFences(command) 为空，旧实现恒 false。只与 stripFences(skillBody) 比较：
 *  与原始 skill 正文比较会把 skill 自身围栏里的命令片段误判为副本。 */
function copiesSkillBody(commandBody, skillBody) {
  const skill = stripFences(skillBody);
  const skillFlat = skill.replace(/\s+/g, ' ');
  const skillLines = new Set(skill.split(/\r?\n/).map(normLine).filter((l) => l.length >= 40));
  const parts = commandBody.split('```');
  const candidates = [parts.filter((_, i) => i % 2 === 0).join(''), ...parts.filter((_, i) => i % 2 === 1)];
  for (const candidate of candidates) {
    const flat = candidate.replace(/\s+/g, ' ');
    for (let i = 0; i + 60 <= flat.length; i += 1) if (skillFlat.includes(flat.slice(i, i + 60))) return true;
    if (candidate.split(/\r?\n/).map(normLine).some((l) => skillLines.has(l))) return true;
  }
  return false;
}

/** 读真实中立清单。 */
function neutralManifest(plugin) {
  return JSON.parse(readFileSync(join(REPO_ROOT, plugin, 'plugin.manifest.json'), 'utf8'));
}

describe('hooks[] 声明翻译', () => {
  it('脚本路径：去占位符与前导斜杠，不可解析形态返回空串', () => {
    assert.equal(scriptRelOf(['${PLUGIN_ROOT}/hooks/check-freeze.mjs']), 'hooks/check-freeze.mjs');
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/hooks/x.mjs']), 'hooks/x.mjs');
    assert.equal(scriptRelOf(['/hooks/y.mjs']), 'hooks/y.mjs');
    assert.equal(scriptRelOf(['${PLUGIN_ROOT}/hooks/a b.mjs']), '', '含空格的路径不可解析（宁缺勿猜）');
    assert.equal(scriptRelOf(['hooks/../x.mjs']), '', '`..` 段拒绝（路径穿越）');
    assert.equal(scriptRelOf(['hooks/./x.mjs']), '', '`.` 段拒绝（路径穿越）');
    assert.equal(scriptRelOf(['hooks/..data/x.mjs']), 'hooks/..data/x.mjs', '`..data` 是合法文件名，不得误杀');
    assert.equal(scriptRelOf('not-array'), '');
    assert.equal(scriptRelOf([1, 2]), '');
  });

  it('时限：声明值直传（Math.floor），越 1..600 才封顶/抬底', () => {
    assert.deepEqual(timeoutOf(60000), { seconds: 60, capped: false });
    assert.deepEqual(timeoutOf(20000), { seconds: 20, capped: false });
    assert.deepEqual(timeoutOf(5000), { seconds: 5, capped: false });
    assert.deepEqual(timeoutOf(999), { seconds: 1, capped: false }, '不足 1 秒抬到底 1');
    assert.deepEqual(timeoutOf(700000), { seconds: 600, capped: true }, '超 600 封顶并记 capped');
    assert.deepEqual(timeoutOf(undefined), { seconds: 1, capped: false });
  });

  it('matcher：SessionStart 收窄到 startup|resume（宿主词表 only）；工具 matcher 原样直传；空省略键', () => {
    assert.equal(matcherOf('startup|resume|clear|compact', 'SessionStart'), 'startup|resume');
    assert.equal(matcherOf('Bash', 'PreToolUse'), 'Bash');
    assert.equal(matcherOf('Edit|Write', 'PreToolUse'), 'Edit|Write');
    assert.equal(matcherOf('Bash|Edit|Write', 'PreToolUse'), 'Bash|Edit|Write');
    assert.equal(matcherOf('', 'UserPromptSubmit'), undefined);
    assert.equal(matcherOf(undefined, 'Stop'), undefined);
  });

  it('command：单态跨平台——引号 abs-node + ./shim + 事件 + 脚本 + 时限，无 %PLUGIN_ROOT% 双形态', () => {
    const cmd = commandLineOf(NODE, 'PreToolUse', 'hooks/check-freeze.mjs', 5);
    assert.equal(cmd, '"C:/fake/node.exe" ./kimi/hook-shim.mjs PreToolUse hooks/check-freeze.mjs 5');
    assert.ok(!cmd.includes('commandWindows') && !cmd.includes('%PLUGIN_ROOT%'), 'Kimi 无双形字段（delta 清单：不搬 mcode 双形态）');
    assert.match(cmd, /^"[^"]+" \.\/kimi\/hook-shim\.mjs \w+ \S+ \d+$/, 'abs-node 带引号、shim 以 ./ 相对插件根引用');
  });

  it('六插件真实中立清单翻译后全部合规：22 处理器（research-loop 零钩子）、事件面与 matcher 收窄符合登记', () => {
    const expected = {
      workflow: { handlers: 12, events: ['PostCompact', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'] },
      'spec-gate': { handlers: 3, events: ['PostToolUse', 'SessionStart', 'UserPromptSubmit'] },
      scout: { handlers: 2, events: ['SessionStart', 'UserPromptSubmit'] },
      'team-governance': { handlers: 3, events: ['PreToolUse', 'SessionStart', 'UserPromptSubmit'] },
      'algo-loop': { handlers: 2, events: ['SessionStart', 'UserPromptSubmit'] },
      'research-loop': { handlers: 0, events: [] },
    };
    let total = 0;
    for (const plugin of PLUGINS) {
      const neutral = neutralManifest(plugin);
      if (!Array.isArray(neutral.hooks) || neutral.hooks.length === 0) {
        assert.equal(expected[plugin].handlers, 0, `${plugin} 零钩子（无 hooks 声明，ADR-047）`);
        continue;
      }
      const { hooks, stats } = translateHookDeclarations(neutral.hooks, { nodePath: NODE, plugin });
      assert.deepEqual(validateHookEntries(hooks), [], `${plugin} 声明应合规`);
      assert.equal(stats.unresolved, 0, `${plugin} 不应有未能翻译的处理器`);
      assert.equal(stats.handlers, expected[plugin].handlers, `${plugin} 处理器数`);
      assert.deepEqual([...new Set(hooks.map((h) => h.event))].sort(), expected[plugin].events, `${plugin} 事件面`);
      total += stats.handlers;
      for (const entry of hooks) {
        if (entry.event === 'PostCompact') {
          assert.match(entry.command, new RegExp(`^"${NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" \\./kimi/compact-workflow\\.mjs$`));
          assert.equal(entry.matcher, 'manual|auto');
        } else if (entry.event === 'UserPromptSubmit' && entry.command.includes('relay-drain')) {
          assert.match(entry.command, new RegExp(`^"${NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" \\./kimi/relay-drain\\.mjs$`), '投递腿形态：静态脚本、无事件/脚本/时限参数');
          assert.equal(entry.matcher, undefined, '投递腿无 matcher');
        } else {
          assert.match(entry.command, new RegExp(`^"${NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" \\./kimi/hook-shim\\.mjs ${entry.event} \\S+ \\d+$`));
        }
        if (entry.event === 'SessionStart') assert.equal(entry.matcher, 'startup|resume', 'SessionStart matcher 必须收窄');
        if (entry.event === 'PostToolUseFailure') assert.equal(entry.matcher, undefined, '失败通道无 matcher 原样省略键');
      }
    }
    assert.equal(total, 22, 'workflow 12 / spec-gate 3 / scout 2 / team-governance 3 / algo-loop 2 = 22（17 中立＋1 workflow PostCompact＋4 投递腿）');
  });

  it('翻译统计：不可解析/缺事件计入 unresolved（不静默丢弃）', () => {
    const { stats } = translateHookDeclarations([{ event: 'Stop', args: ['bad arg with space'] }, { args: ['${PLUGIN_ROOT}/hooks/x.mjs'] }], { nodePath: NODE });
    assert.equal(stats.unresolved, 2);
    assert.equal(stats.handlers, 0);
  });

  it('校验器拒掉宿主不接受的形态（第五键/未知事件/正则可编译/command 空/timeout 越界）', () => {
    const good = { event: 'PreToolUse', matcher: 'Bash', command: '"x" ./kimi/hook-shim.mjs PreToolUse hooks/a.mjs 5', timeout: 5 };
    assert.deepEqual(validateHookEntries([good]), []);
    assert.ok(validateHookEntries([{ ...good, extra: 1 }]).some((p) => p.includes('不被接受')));
    assert.ok(validateHookEntries([{ ...good, event: 'Nope' }]).some((p) => p.includes('未知事件')));
    assert.ok(validateHookEntries([{ ...good, matcher: 'a(b' }]).some((p) => p.includes('正则不可编译')));
    assert.ok(validateHookEntries([{ ...good, command: '' }]).some((p) => p.includes('command')));
    assert.ok(validateHookEntries([{ ...good, timeout: 0 }]).some((p) => p.includes('timeout')));
    assert.ok(validateHookEntries([{ ...good, timeout: 601 }]).some((p) => p.includes('timeout')));
    assert.ok(validateHookEntries([{ ...good, timeout: 5.5 }]).some((p) => p.includes('timeout')));
  });
});

describe('清单构造与校验', () => {
  it('生成的六份清单字段齐备且合规（name=目录名，version=中立清单同源）', () => {
    for (const plugin of PLUGINS) {
      const neutral = neutralManifest(plugin);
      const doc = buildManifest({ plugin, manifest: neutral, hasSkills: true, hasCommands: true, hooks: [{ event: 'Stop', command: 'x', timeout: 5 }] });
      assert.deepEqual(validateManifest(doc), [], `${plugin} 清单应合规`);
      assert.equal(doc.name, plugin);
      assert.equal(doc.version, neutral.version, '版本取中立清单（套件版本即插件版本，ADR-017）');
      assert.equal(doc.description, neutral.description, 'description 同名搬运');
      assert.equal(doc.author, neutral.author);
      assert.deepEqual(doc.skills, ['./skills/']);
      assert.deepEqual(doc.commands, ['./commands/']);
      assert.equal(doc.hooks.length, 1);
    }
  });

  it('interface/keywords 同名搬运；无则不落键', () => {
    const withIface = buildManifest({
      plugin: 'workflow',
      manifest: { version: '0.6.2', description: 'd', author: 'a', keywords: ['x'], interface: { displayName: 'DN', shortDescription: 'SD', developerName: 'DEV', bogus: 1 } },
      hasSkills: false,
      hasCommands: false,
      hooks: [],
    });
    assert.deepEqual(withIface.keywords, ['x']);
    assert.equal(withIface.interface.displayName, 'DN');
    assert.equal(withIface.interface.developerName, 'DEV');
    assert.ok(!('bogus' in withIface.interface), 'interface 只搬运宿主字段面');
    assert.ok(!('skills' in withIface) && !('commands' in withIface) && !('hooks' in withIface), '面缺席即键省略');
    assert.ok(!('agents' in withIface), 'agents 键不落（走宿主自动发现）');
  });

  it('校验器拒：坏 name / 非 SemVer / 包根逃逸路径 / 白名单外键', () => {
    const base = buildManifest({ plugin: 'workflow', manifest: { version: '0.6.2', description: 'd' }, hasSkills: true, hasCommands: false, hooks: [] });
    assert.deepEqual(validateManifest(base), []);
    assert.ok(validateManifest({ ...base, name: 'Workflow' }).some((p) => p.includes('name')), '大写开头违宿主正则');
    assert.ok(validateManifest({ ...base, name: 'a'.repeat(65) }).some((p) => p.includes('name')), '超 64 字符');
    assert.ok(validateManifest({ ...base, version: '0.6' }).some((p) => p.includes('SemVer')));
    assert.ok(validateManifest({ ...base, skills: ['../x/'] }).some((p) => p.includes('包根内')));
    assert.ok(validateManifest({ ...base, skills: ['skills/'] }).some((p) => p.includes('包根内')), '缺 ./ 前缀不合宿主形态');
    assert.ok(validateManifest({ ...base, extra: 1 }).some((p) => p.includes('不被接受')));
    assert.ok(validateManifest({ ...base, description: '' }).some((p) => p.includes('description')));
  });

  it('包根路径判据：目录形 ./skills/ 合规；反斜杠/绝对/.. 判拒', () => {
    assert.ok(isInPackageRelPath('./skills/'));
    assert.ok(isInPackageRelPath('./commands/'));
    assert.ok(isInPackageRelPath('./skills/tdd/SKILL.md'));
    assert.ok(!isInPackageRelPath('skills/x.md'), '缺 ./ 前缀');
    assert.ok(!isInPackageRelPath('./a/../b.md'));
    assert.ok(!isInPackageRelPath('./a//b.md'));
    assert.ok(!isInPackageRelPath('./a\\b.md'));
    assert.ok(!isInPackageRelPath('/abs/x.md'));
  });

  it('SemVer 判据', () => {
    assert.ok(isSemVer('0.6.2'));
    assert.ok(isSemVer('1.0.0-rc.1'));
    assert.ok(!isSemVer('0.6'));
    assert.ok(!isSemVer('v0.6.2'));
  });

  it('skill 文档面：六插件真实 32 份 SKILL.md 全部合规（frontmatter name+description 必填）', () => {
    const docs = [];
    for (const plugin of PLUGINS) {
      const skillDir = join(REPO_ROOT, plugin, 'skills');
      if (!existsSync(skillDir)) continue;
      for (const name of readdirSync(skillDir)) {
        const abs = join(skillDir, name, 'SKILL.md');
        if (!existsSync(abs)) continue;
        docs.push({ rel: `skills/${name}/SKILL.md`, bytes: readFileSync(abs) });
      }
    }
    assert.equal(docs.length, 32, '六插件源 skill 合计 32 份');
    assert.deepEqual(validateSkillDocs(docs), [], '真实 skill 文档面必须全部合规');
  });

  it('skill 文档面校验器：缺 name / 缺 description / 无 frontmatter 逐条报', () => {
    const doc = (name, description) => Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`, 'utf8');
    assert.deepEqual(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('tdd', '按 TDD 实现修复 —— 触发条件：新增或修改功能。') }]), []);
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('', '描述在。') }]).some((p) => p.includes('缺 name')));
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('tdd', '') }]).some((p) => p.includes('缺 description')));
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: Buffer.from('没有 frontmatter 的正文', 'utf8') }]).some((p) => p.includes('缺 name')));
  });

  it('命令面判据：非 .md 判拒；路径逃逸判拒；真实 9 条命令全部 .md；4 条薄指针指向且不复制目标 skill 正文', () => {
    assert.deepEqual(validateCommandFiles([{ rel: 'commands/gate.md' }]), []);
    assert.ok(validateCommandFiles([{ rel: 'commands/gate.txt' }]).some((p) => p.includes('非 .md')));
    assert.ok(validateCommandFiles([{ rel: 'commands/../escape.md' }]).some((p) => p.includes('逃逸')));
    let total = 0;
    for (const plugin of PLUGINS) {
      const dir = join(REPO_ROOT, plugin, 'commands');
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).map((name) => ({ rel: `commands/${name}` }));
      total += files.length;
      assert.deepEqual(validateCommandFiles(files), [], `${plugin} 命令面应全 .md`);
    }
    assert.equal(total, 9, '4 薄指针 + 5 操作型 = 9 条命令');
    // 定义（内部模块-17 B-ka-5 / 内部未决-158 收口口径，2026-10-26 内部任务-235）：「指针正文 ⊆ 指针段」的机检形态＝
    // ①命令 frontmatter `skills:` 与正文指针句均指向目标 skill（指针落在指针段内）；
    // ②命令正文不复制目标 SKILL 正文（剥离围栏后无 ≥60 字连续共同片段、无 ≥40 字逐行相同）——副本即越出指针段。
    const covered = [];
    for (const { plugin, command, skill } of THIN_POINTERS) {
      const cmd = readSplit(`${plugin}/commands/${command}.md`);
      const sk = readSplit(`${plugin}/skills/${skill}/SKILL.md`);
      assert.equal(cmd.body.split('```').length % 2, 1, `${plugin}/${command} 围栏成对（奇数围栏即 fail，防静默丢段）`);
      assert.equal(sk.body.split('```').length % 2, 1, `${plugin}/skills/${skill}/SKILL.md 围栏成对`);
      assert.equal(cmd.data.skills, skill, `${plugin}/${command} 的 skills 前言须指向 ${skill}`);
      assert.ok(cmd.body.includes(skill), `${plugin}/${command} 正文须含 ${skill} 指针`);
      assert.ok(!copiesSkillBody(cmd.body, sk.body), `${plugin}/${command} 不得复制 ${skill} 正文（薄指针不产副本）`);
      covered.push(`${plugin}/${command}`);
    }
    assert.equal(covered.length, 4, '4 条薄指针逐一审计且与 5 条操作型合计 9');
    const gateBody = readSplit('spec-gate/commands/gate.md').body;
    const gateSkillBody = readSplit('spec-gate/skills/gate/SKILL.md').body;
    assert.ok(copiesSkillBody(`${gateBody}\n${gateSkillBody}`, gateSkillBody), '反例夹具：拼接副本必须被检测（防同义反复）');
  });

  it('副本检测补盲：skill 正文整段粘进命令单围栏即判副本', () => {
    const prose = '甲'.repeat(80);
    const fencedOnly = '乙'.repeat(80);
    const skillBody = `# 目标技能\n\n${prose}\n\n\`\`\`sh\n${fencedOnly}\n\`\`\`\n`;
    const pasted = `# 指针\n\n\`\`\`text\n${stripFences(skillBody)}\n\`\`\`\n`;
    assert.equal(stripFences(pasted).trim(), '# 指针', '夹具判别力：剥离后命令正文为空（旧实现盲区）');
    assert.ok(copiesSkillBody(pasted, skillBody), '围栏内整段粘贴必须被检出');
    assert.ok(!copiesSkillBody(`# 指针\n\n\`\`\`sh\n${fencedOnly}\n\`\`\`\n`, skillBody), 'skill 自身围栏内容不是正文副本（不得与原始 skill 正文比较）');
  });

  it('副本检测：≥40 字逐行相同判副本且 39 字不误判', () => {
    const skillBody = `# 目标\n\n${'丙'.repeat(48)}\n${'戊'.repeat(40)}\n${'丁'.repeat(20)}\n`;
    assert.ok(copiesSkillBody(`# 指针\n\n${'丙'.repeat(48)}\n`, skillBody), '48 字整行相同判副本');
    assert.ok(copiesSkillBody(`# 指针\n\n${'戊'.repeat(40)}\n`, skillBody), '40 字（阈值）判副本');
    assert.ok(!copiesSkillBody(`# 指针\n\n${'戊'.repeat(39)}\n`, skillBody), '39 字不达阈值（不得放宽）');
    assert.ok(!copiesSkillBody(`# 指针\n\n${'丁'.repeat(20)}\n`, skillBody), '短行（<40）不误判');
    assert.ok(!copiesSkillBody(`# 指针\n\n${'戊'.repeat(20)}\n\`\`\`\n${'戊'.repeat(20)}\n\`\`\`\n`, skillBody), '跨围栏拼接不得被拼成整行');
  });

  it('frontmatter 解析：无 frontmatter 整体当正文；标量键值对', () => {
    assert.deepEqual(parseFrontmatter('# 标题\n正文').data, {});
    assert.equal(parseFrontmatter('---\nname: a\ndescription: b\n---\n正文').data.description, 'b');
  });
});

describe('agent 词表映射', () => {
  it('映射表登记：LS→Glob / TodoWrite→TodoList / WebFetch→FetchURL；BashOutput 拒', () => {
    assert.equal(AGENT_TOOL_MAP.LS, 'Glob');
    assert.equal(AGENT_TOOL_MAP.TodoWrite, 'TodoList');
    assert.equal(AGENT_TOOL_MAP.WebFetch, 'FetchURL');
    assert.deepEqual(AGENT_TOOL_DROPPED, ['BashOutput']);
  });

  it('mapAgentTools：映射 + 去重 + 保序；无对位按拒绝丢弃；未知名原样直映（门控面再过滤）', () => {
    const mapped = mapAgentTools('Glob, Grep, LS, Read, WebFetch, WebSearch, TodoWrite, BashOutput, Nope');
    assert.deepEqual(mapped.tools, ['Glob', 'Grep', 'Read', 'FetchURL', 'WebSearch', 'TodoList', 'Nope'], '其余同名直映（含未知词——挂装门控与宿主词表求交集时再过滤）');
    assert.deepEqual(mapped.dropped, ['BashOutput'], 'BashOutput 无对位按拒绝丢弃（只读输出，丢弃不放宽权限）');
    const reviewer = mapAgentTools('Glob, Grep, LS, Read, WebFetch, WebSearch, TodoWrite, BashOutput, Bash');
    assert.ok(reviewer.tools.includes('Bash'), 'code-reviewer 带 Bash（不是纯只读，边界由护栏承担）');
    const noDup = mapAgentTools('Glob, LS, TodoWrite, TodoList');
    assert.deepEqual(noDup.tools, ['Glob', 'TodoList'], 'Glob/LS 映射去重、TodoWrite/TodoList 映射去重');
  });

  it('applyAgentGate：目录不可得拒挂、交集过滤未知工具（fail-closed）', () => {
    const engine = loadEngine(REPO_ROOT);
    const inventory = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8')).capabilities.hostToolInventory.kimi;
    const gate = applyAgentGate(engine, ['Glob', 'Read', 'EvilTool'], inventory);
    assert.equal(gate.reject, false);
    assert.deepEqual(gate.allowedTools, ['Glob', 'Read'], '未知工具必须被交集过滤');
    assert.equal(applyAgentGate(engine, ['Glob'], null).reject, true, '目录不可得必须拒挂');
  });

  it('rebuildAgentDoc：按门控白名单重建，frontmatter 其余字段与正文保留', () => {
    const doc = convertAgentText(readFileSync(join(REPO_ROOT, 'workflow', 'agents', 'code-explorer.md'), 'utf8'), 'code-explorer');
    const rebuilt = buildAgentDoc({ ...doc.parts, tools: ['Glob', 'Read'] });
    const { data, body } = parseFrontmatter(rebuilt);
    assert.equal(data.name, 'code-explorer');
    assert.match(rebuilt, /\ntools:\n {2}- Glob\n {2}- Read/);
    assert.ok(!rebuilt.includes('- Bash'), '门控白名单外的工具不得写回');
    assert.equal(body, doc.parts.body.trim() + '\n', '正文原样保留');
  });

  it('产物级：agent 文档的 tools 恰为门控交集（allowedTools 必须回写）', () => {
    const engine = loadEngine(REPO_ROOT);
    const plan = planPackage({ repoRoot: REPO_ROOT, plugin: 'workflow', nodePath: NODE, withAgents: true, engine, hostInventory: ['Read'] });
    const agents = plan.files.filter((file) => file.rel.startsWith('agents/'));
    assert.ok(agents.length > 0, '交集非空时应物化 agent');
    for (const file of agents) {
      const text = file.bytes.toString('utf8');
      const front = text.slice(0, text.indexOf('\n---', 3)); // 只取 frontmatter（正文里的列表项不得混入）
      const tools = [...front.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]);
      assert.deepEqual(tools, ['Read'], `${file.rel} 的 tools 须恰为门控交集（Grep/Glob 等未授权工具不得出现）`);
    }
  });

  it('planPackage：--with-agents 且 hostInventory=null → 全跳过并记 problem', () => {
    const engine = loadEngine(REPO_ROOT);
    const plan = planPackage({ repoRoot: REPO_ROOT, plugin: 'workflow', nodePath: NODE, withAgents: true, engine, hostInventory: null });
    assert.equal(plan.files.filter((file) => file.rel.startsWith('agents/')).length, 0, '目录不可得时不得物化任何 agent');
    assert.ok(plan.problems.some((item) => item.includes('请求未兑现')), `应记请求未兑现，实得：${JSON.stringify(plan.problems)}`);
    assert.ok(plan.warnings.some((item) => item.includes('工具目录不可得')), `应带拒挂原因，实得：${JSON.stringify(plan.warnings)}`);
  });

  it('三份真实 agent 声明转换后 frontmatter 合宿主形态且工具面非空（Kimi 字段直映）', () => {
    const names = readdirSync(join(REPO_ROOT, 'workflow', 'agents')).filter((n) => n.endsWith('.md')).sort();
    assert.deepEqual(names, ['code-architect.md', 'code-explorer.md', 'code-reviewer.md']);
    for (const file of names) {
      const doc = convertAgentText(readFileSync(join(REPO_ROOT, 'workflow', 'agents', file), 'utf8'), file.slice(0, -3));
      const content = buildAgentDoc({ ...doc.parts, tools: doc.tools });
      const { data, body } = parseFrontmatter(content);
      assert.equal(data.name, file.slice(0, -3));
      assert.ok(String(data.description).length > 0);
      assert.ok(doc.tools.length > 0, `${file} 映射后不得为空（宁可不装，不给无过滤的子 agent）`);
      assert.match(content, /\ntools:\n {2}- /, '工具白名单须是 YAML 列表（Kimi 形态）');
      assert.ok(body.includes('职责'), '正文原样保留');
    }
  });
});

describe('引擎闭包清单', () => {
  it('清单＝两 JSON + src/*.mjs + strategies 六族（复刻 mcode 口径）', () => {
    const rels = listEngineFiles(REPO_ROOT).map((f) => f.rel);
    for (const rel of ['plugin-core/degradation-rules.json', 'plugin-core/capability-matrix.json', 'plugin-core/src/engine.mjs', 'plugin-core/src/validate.mjs']) {
      assert.ok(rels.includes(rel), `清单应含 ${rel}`);
    }
    const strategies = readdirSync(join(REPO_ROOT, 'plugin-core', 'src', 'strategies')).filter((n) => n.endsWith('.mjs'));
    assert.equal(strategies.length, 6, '六族执行器');
    for (const name of strategies) assert.ok(rels.includes(`plugin-core/src/strategies/${name}`), `清单应含 strategies/${name}`);
  });

  it('import 图 ⊆ 物化清单：src 下相对 import 的目标文件必须全部在清单内', () => {
    const rels = new Set(listEngineFiles(REPO_ROOT).map((f) => f.rel));
    const srcDir = join(REPO_ROOT, 'plugin-core', 'src');
    const files = [...readdirSync(srcDir).filter((n) => n.endsWith('.mjs')), ...readdirSync(join(srcDir, 'strategies')).filter((n) => n.endsWith('.mjs')).map((n) => join('strategies', n))];
    for (const rel of files) {
      const text = readFileSync(join(srcDir, rel), 'utf8');
      for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = join('plugin-core', 'src', rel.split('\\').join('/').split('/').slice(0, -1).join('/'), m[1]).split('\\').join('/');
        assert.ok(rels.has(target), `${rel} 的 import ${m[1]} → ${target} 必须在物化清单内`);
      }
    }
  });
});

describe('解释器解析与 staging', () => {
  it('解释器解析：三级回退，探测缝可注入；PATH 命中须绝对化', () => {
    const tried = [];
    const hit = resolveNode({
      env: { ProgramFiles: 'C:/PF', LOCALAPPDATA: 'C:/LA' },
      execPath: 'C:/x/node.exe',
      exists: () => true,
      probe: (candidate) => { tried.push(candidate); return candidate === join('C:/PF', 'nodejs', 'node.exe'); },
      resolveExecPath: (candidate) => candidate,
    });
    assert.deepEqual(hit, { path: join('C:/PF', 'nodejs', 'node.exe'), source: 'program-files' });
    assert.deepEqual(tried, ['node', join('C:/PF', 'nodejs', 'node.exe')]);
    assert.deepEqual(
      resolveNode({ env: {}, execPath: 'C:/x/node.exe', exists: () => true, probe: (candidate) => candidate === 'C:/x/node.exe' }),
      { path: 'C:/x/node.exe', source: 'self' },
    );
    // PATH 命中须绝对化，不得写裸 node；绝对化失败继续回退
    assert.deepEqual(
      resolveNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => '/usr/local/bin/node' }),
      { path: '/usr/local/bin/node', source: 'path' },
    );
    assert.equal(
      resolveNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => null }),
      null,
    );
    assert.equal(resolveNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => true, probe: () => false }), null, '全不可得即 null，由安装器拒绝安装');
    const real = resolveNode();
    assert.ok(real !== null && isAbsolute(real.path), `解释器须为绝对路径，实得 ${real?.path}`);
  });

  it('marketplace JSON：version "2" + 六包 source=./<id> + 校验器拒坏形态', () => {
    // entries 形态=生产链路（cli.mjs staging 传 plans.map → {id, manifest}），manifest 为
    // buildManifest 产物（interface.displayName 是宿主展示位——顶层 displayName 已被映射入）
    const entries = PLUGINS.map((id) => ({
      id,
      manifest: buildManifest({ plugin: id, manifest: { version: '0.6.5', description: 'd', displayName: `展示-${id}` }, hasSkills: true, hasCommands: false, hooks: [] }),
    }));
    const doc = buildMarketplaceJson(entries);
    assert.deepEqual(validateMarketplaceJson(doc), []);
    assert.equal(doc.version, '2');
    assert.equal(doc.plugins.length, 6);
    for (let i = 0; i < PLUGINS.length; i += 1) {
      assert.equal(doc.plugins[i].id, PLUGINS[i]);
      assert.equal(doc.plugins[i].source, `./${PLUGINS[i]}`);
      assert.equal(doc.plugins[i].displayName, `展示-${PLUGINS[i]}`, 'displayName 须取自条目携带的清单（同源）');
    }
    assert.ok(validateMarketplaceJson({ version: '1', plugins: [] }).some((p) => p.includes('version')));
    assert.ok(validateMarketplaceJson({ version: '2', plugins: [{ id: 'x' }] }).some((p) => p.includes('displayName')));
  });
});

// ─── B 批（内部任务-5，R-ka-10/A-ka-7）：展示单源——包 interface.displayName 与 marketplace
// 条目同源自中立清单 displayName（缺省回落稳定 slug），仓内无第二份名称表。 ───
describe('B 批：展示单源', () => {
  it('buildManifest：中立清单顶层 displayName → interface.displayName（宿主已证展示位）', () => {
    const doc = buildManifest({
      plugin: 'workflow',
      manifest: { version: '0.6.5', description: 'd', displayName: 'AI Coding 方法论 · 工作流' },
      hasSkills: true,
      hasCommands: false,
      hooks: [],
    });
    assert.equal(doc.interface.displayName, 'AI Coding 方法论 · 工作流', '顶层 displayName 须映射到 interface.displayName');
  });

  test('包/市场展示同源：planPackage 清单与 marketplace 条目均取中立清单 displayName（真实资产）', () => {
    const plans = PLUGINS.map((plugin) => planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: NODE }));
    const doc = buildMarketplaceJson(PLUGINS.map((plugin, i) => ({ id: plugin, manifest: plans[i].manifest })));
    assert.deepEqual(validateMarketplaceJson(doc), []);
    for (let i = 0; i < PLUGINS.length; i += 1) {
      const neutral = neutralManifest(PLUGINS[i]);
      assert.equal(typeof neutral.displayName, 'string', `${PLUGINS[i]} 中立清单须有 displayName`);
      assert.equal(plans[i].manifest.interface?.displayName, neutral.displayName, `${PLUGINS[i]} 包清单展示同源`);
      assert.equal(doc.plugins[i].displayName, neutral.displayName, `${PLUGINS[i]} 市场条目展示同源`);
    }
  });

  it('displayName 缺省回落稳定 slug（包与市场同一回落口径）', () => {
    const manifest = buildManifest({ plugin: 'workflow', manifest: { version: '0.6.5', description: 'd' }, hasSkills: false, hasCommands: false, hooks: [] });
    const doc = buildMarketplaceJson([{ id: 'workflow', manifest }]);
    assert.equal(doc.plugins[0].displayName, 'workflow', '无中立 displayName 时回落稳定 slug');
  });

  it('仓内无第二份名称表：staging.mjs 不再导出 PLUGIN_DISPLAYNAME（R-ka-10 静态断言）', () => {
    const src = readFileSync(new URL('../src/staging.mjs', import.meta.url), 'utf8');
    assert.ok(!src.includes('PLUGIN_DISPLAYNAME'), '适配层不得维护第二份名称表——marketplace 消费已规划 {id,manifest} 数组');
  });
});
