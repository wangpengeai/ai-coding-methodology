// 文件：mcode-adapter/tests/generate.test.mjs
// 描述：生成面测试——钩子声明翻译、清单构造与校验、包上限、命令面处置、agent 映射。
//       全部跑**真实资产**（六插件的 `hooks.json` / `commands/*.md` / `agents/*.md` /
//       `skills/*/SKILL.md`），不做替身；断言点按宿主 V1 判据复刻（字段白名单、取值域、
//       路径形态、限额），故"改了声明而宿主会拒"这类缺陷无处可藏。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, it, test } from 'node:test';

import { listCommandNames, materializeCommandSkill, auditDisposition, buildCommandSkill, parseFrontmatter } from '../src/command-skills.mjs';
import { matcherOf, scriptRelOf, timeoutOf, TIMEOUT_MAX_SECONDS, TIMEOUT_MIN_SECONDS, translateHookDoc, validateHookDoc } from '../src/hook-template.mjs';
import { buildManifest, isPortableRelPath, isSemVer, validateManifest, validateSkillDocs } from '../src/manifest.mjs';
import { LIMITS, checkPathShape, checkPlanLimits } from '../src/package-limits.mjs';
import { COMMAND_DISPOSITION, PLUGINS, PLUGIN_META } from '../src/plugin-meta.mjs';
import { convertAgentFile, listAgentNames, mapAgentTools } from '../src/agents.mjs';
import { renderIconPng } from '../src/assets.mjs';
import { RESOLUTION_STATES, diagnoseNode, nodeFailureText, probeNode, resolveNode } from '../src/node-resolve.mjs';
import { manifestToZcodeDoc, planPackage } from '../cli.mjs';
import { renderArtifacts } from '../../plugin-core/src/materialize.mjs';
import { REPO_ROOT } from './helpers.mjs';

const NODE = 'C:/fake/node.exe';

describe('钩子声明翻译', () => {
  it('脚本路径：去占位符与前导斜杠，不可解析形态返回空串', () => {
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/hooks/check-freeze.mjs']), 'hooks/check-freeze.mjs');
    assert.equal(scriptRelOf(['${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs']), 'hooks/x.mjs');
    assert.equal(scriptRelOf(['/hooks/y.mjs']), 'hooks/y.mjs');
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/hooks/a b.mjs']), '', '含空格的路径不可解析（宿主路径段字符集不允许）');
    assert.equal(scriptRelOf('not-array'), '');
    assert.equal(scriptRelOf([1, 2]), '');
  });

  it('钩子脚本路径：包外相对路径被拒（scriptRelOf 与 validateHookDoc 双层）', () => {
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/../../evil.mjs']), '', '`..` 段必须拒绝');
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/./hooks/x.mjs']), '', '`.` 段必须拒绝');
    assert.equal(scriptRelOf(['${ZCODE_PLUGIN_ROOT}/hooks/x.mjs']), 'hooks/x.mjs');
    const doc = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '"node" "${PLUGIN_ROOT}/mcode/hook-shim.mjs" PreToolUse "hooks/x.mjs" 5', timeout: 5 }] }] } };
    assert.deepEqual(validateHookDoc(doc), []);
    const bad = { hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }] }] } };
    assert.ok(validateHookDoc(bad).some((p) => p.includes('未知事件')), 'ZCode 专有事件不得被当宿主事件');
  });

  it('生成期时限常量 ≡ 规则 params（单一事实源对拍）', () => {
    const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
    const rule = rules.rules.find((item) => item.id === 'timeout-cap-fail-open');
    assert.equal(TIMEOUT_MAX_SECONDS, rule.params.mcode.maxSeconds);
    assert.equal(TIMEOUT_MIN_SECONDS, rule.params.mcode.minSeconds);
    assert.equal(timeoutOf(undefined), rule.params.mcode.defaultSeconds);
  });

  it('时限：按 1..10 封顶取小，缺失取默认 5', () => {
    assert.equal(timeoutOf(60000), 10);
    assert.equal(timeoutOf(30000), 10);
    assert.equal(timeoutOf(20000), 10);
    assert.equal(timeoutOf(5000), 5);
    assert.equal(timeoutOf(999), 1);
    assert.equal(timeoutOf(undefined), 5);
    assert.equal(timeoutOf('bogus'), 5);
  });

  it('matcher：工具名原生化；SessionStart 补 fork；PostToolUse 取窄到三工具', () => {
    assert.equal(matcherOf('Bash', 'PreToolUse'), 'bash');
    assert.equal(matcherOf('Bash|Edit|Write', 'PreToolUse'), 'bash|edit|write');
    assert.equal(matcherOf('Write|Edit', 'PreToolUse'), 'write|edit');
    assert.equal(matcherOf('startup|resume|clear|compact', 'SessionStart'), 'startup|resume|clear|compact|fork');
    assert.equal(matcherOf(undefined, 'PostToolUse'), 'bash|edit|write');
    assert.equal(matcherOf('', 'UserPromptSubmit'), undefined, '无 matcher 即每次都跑');
  });

  it('六插件真实声明翻译后全部合规，且处理器数与事件面符合登记', () => {
    const expected = { workflow: { handlers: 10, events: ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'] }, 'spec-gate': { handlers: 3, events: ['PostToolUse', 'SessionStart', 'UserPromptSubmit'] }, scout: { handlers: 2, events: ['SessionStart', 'UserPromptSubmit'] }, 'team-governance': { handlers: 3, events: ['PreToolUse', 'SessionStart', 'UserPromptSubmit'] }, 'algo-loop': { handlers: 2, events: ['SessionStart', 'UserPromptSubmit'] }, 'research-loop': { handlers: 0, events: [] } };
    let total = 0;
    for (const plugin of PLUGINS) {
      const hooksPath = join(REPO_ROOT, plugin, 'hooks', 'hooks.json');
      if (!existsSync(hooksPath)) {
        assert.equal(expected[plugin].handlers, 0, `${plugin} 无 hooks.json（零钩子插件，ADR-047）`);
        continue;
      }
      const zcode = JSON.parse(readFileSync(hooksPath, 'utf8'));
      const { doc, stats } = translateHookDoc(zcode, { nodePath: NODE, syntheticRelayDrain: true });
      assert.deepEqual(validateHookDoc(doc), [], `${plugin} 声明应合规`);
      assert.equal(stats.unresolved, 0, `${plugin} 不应有未能翻译的处理器`);
      assert.equal(stats.handlers, expected[plugin].handlers, `${plugin} 处理器数`);
      assert.deepEqual(stats.events, expected[plugin].events, `${plugin} 事件面`);
      total += stats.handlers;
      for (const [, groups] of Object.entries(doc.hooks)) {
        for (const group of groups) {
          for (const handler of group.hooks) {
            assert.match(handler.command, /"\$\{PLUGIN_ROOT\}\/mcode\/hook-shim\.mjs"/);
            assert.ok(!('args' in handler), 'MCode 处理器不接受 args 字段');
          }
        }
      }
    }
    assert.equal(total, 20, '17 个 ZCode 声明处理器 + 4 个生成期合成 UPS 投递腿（post-tool 双声明去重一次）= 20');
  });

  test('四包缺 UPS 时合成 relay-drain 处理器；workflow 不重复', () => {
    const one = { hooks: { SessionStart: [{ hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs'], timeoutMs: 10000 }] }] } };
    const a = translateHookDoc(one, { nodePath: NODE, syntheticRelayDrain: true });
    assert.equal(a.stats.handlers, 2);
    assert.equal(a.stats.syntheticRelayDrain, true);
    assert.ok(a.stats.scripts.includes('mcode/relay-drain.mjs'));
    assert.equal(a.doc.hooks.UserPromptSubmit.length, 1);
    assert.equal(a.doc.hooks.UserPromptSubmit[0].hooks[0].command.includes('mcode/relay-drain.mjs'), true);
    assert.equal(a.doc.hooks.UserPromptSubmit[0].matcher, undefined);
    const wf = { hooks: {
      SessionStart: [{ hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs'], timeoutMs: 10000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/user-prompt.mjs'], timeoutMs: 5000 }] }],
    } };
    const b = translateHookDoc(wf, { nodePath: NODE, syntheticRelayDrain: true });
    assert.equal(b.stats.handlers, 2);
    assert.equal(b.stats.syntheticRelayDrain, false);
    // 开关缺省为关（评审 S1）：`syntheticRelayDrain` 不传或非 true 时**不得**合成——这条钉住
    // 「未显式开启 ⇒ 输出与旧版逐字一致」，给该布尔参数一个可证伪的语义（否则它只是恒真装饰）。
    for (const flag of [undefined, false]) {
      const off = translateHookDoc(one, { nodePath: NODE, syntheticRelayDrain: flag });
      assert.equal(off.stats.handlers, 1, `syntheticRelayDrain=${String(flag)} 时不得补腿`);
      assert.equal(off.stats.syntheticRelayDrain, false);
      assert.equal(off.doc.hooks.UserPromptSubmit, undefined);
      assert.equal(off.stats.scripts.includes('mcode/relay-drain.mjs'), false);
    }
    const tg = planPackage({ repoRoot: REPO_ROOT, plugin: 'team-governance', nodePath: process.execPath });
    assert.equal(tg.stats.syntheticRelayDrain, true, 'planPackage 透传合成 UPS 事实');
    const wfp = planPackage({ repoRoot: REPO_ROOT, plugin: 'workflow', nodePath: process.execPath });
    assert.equal(wfp.stats.syntheticRelayDrain, false, 'workflow 已有 UPS，不合成');
  });

  test('PostToolUse 双通道合并：同事件同脚本只留一个处理器（否则每次调用跑两遍）', () => {
    const zcode = {
      hooks: {
        PostToolUseFailure: { hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/post-tool.mjs'], timeoutMs: 5000 }] },
        PostToolUse: [{ matcher: 'Bash|Edit|Write', hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/post-tool.mjs'], timeoutMs: 5000 }] }],
      },
    };
    zcode.hooks.PostToolUseFailure = [zcode.hooks.PostToolUseFailure];
    const { doc, stats } = translateHookDoc(zcode, { nodePath: NODE });
    assert.equal(stats.handlers, 1);
    assert.equal(stats.deduped, 1);
    assert.equal(doc.hooks.PostToolUse.length, 1);
    assert.equal(doc.hooks.PostToolUse[0].matcher, 'bash|edit|write');
  });

  it('未知事件按未解析计数（不静默丢弃）', () => {
    const { stats } = translateHookDoc({ hooks: { SubagentStart: [{ hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/x.mjs'] }] }] } }, { nodePath: NODE });
    assert.equal(stats.unresolved, 1);
    assert.equal(stats.handlers, 0);
  });

  it('声明校验器会拒掉宿主不接受的形态', () => {
    assert.ok(validateHookDoc({ hooks: { PreToolUse: [{ matcher: 'a'.repeat(300), hooks: [{ type: 'command', command: 'x' }] }] } }).some((p) => p.includes('matcher')));
    assert.ok(validateHookDoc({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', args: [] }] }] } }).some((p) => p.includes('args')));
    assert.ok(validateHookDoc({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 30 }] }] } }).some((p) => p.includes('timeout')));
    assert.ok(validateHookDoc({ hooks: { Nope: [{ hooks: [{ type: 'command', command: 'x' }] }] } }).some((p) => p.includes('未知事件')));
    const many = { hooks: { PreToolUse: [] } };
    many.hooks.PreToolUse = Array.from({ length: 65 }, () => ({ hooks: [{ type: 'command', command: 'x' }] }));
    assert.ok(validateHookDoc(many).some((p) => p.includes('64')));
  });

  it('commandWindows 必须用 cmd.exe 变量语法（Windows 上整面静默失效的回归守卫）', () => {
    // D1：宿主在 win32 **优先取 commandWindows**（`commandValue`），而 MINIMAX 形态只能
    // 走 `shell: true` ⇒ `cmd.exe` 不展开 `${VAR}`。两条命令形态必须只在包根语法上不同。
    const doc = translateHookDoc(
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/hooks/check-freeze.mjs'], timeoutMs: 5000 }] }] } },
      { nodePath: NODE },
    );
    const handler = doc.doc.hooks.PreToolUse[0].hooks[0];
    assert.match(handler.command, /\$\{PLUGIN_ROOT\}\/mcode\/hook-shim\.mjs/, 'POSIX 形态用 ${PLUGIN_ROOT}');
    assert.match(handler.commandWindows, /%PLUGIN_ROOT%\/mcode\/hook-shim\.mjs/, 'Windows 形态必须用 %PLUGIN_ROOT%');
    assert.ok(!handler.commandWindows.includes('${'), 'commandWindows 残留 POSIX 变量语法即 Windows 上全部处理器起不来');
    assert.equal(
      handler.commandWindows.replace('%PLUGIN_ROOT%', '${PLUGIN_ROOT}'),
      handler.command,
      '两条形态只允许在包根变量语法上不同（其余逐字相同）',
    );
    assert.deepEqual(validateHookDoc(doc.doc), [], '本层生成的声明必须过自己的校验器');
  });

  it('声明校验器把 POSIX 语法的 commandWindows 判为越界（装前红，不留给宿主静默失败）', () => {
    const bad = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "x.mjs"', commandWindows: 'node "${PLUGIN_ROOT}/mcode/hook-shim.mjs" PreToolUse "h.mjs" 5' }] }] } };
    assert.ok(
      validateHookDoc(bad).some((p) => p.includes('POSIX 变量语法')),
      'commandWindows 含 ${} 必须报（否则 Windows 上钩子面静默消失）',
    );
    const good = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "x.mjs"', commandWindows: 'node "%PLUGIN_ROOT%/mcode/hook-shim.mjs" PreToolUse "h.mjs" 5' }] }] } };
    assert.deepEqual(validateHookDoc(good), [], 'cmd.exe 语法不应误报');
  });
});

describe('钩子分组单源（DEV-295）', () => {
  it('manifestToZcodeDoc 直接复用 renderArtifacts（等价护栏）', () => {
    const normalize = (value) => JSON.parse(JSON.stringify(value));
    for (const plugin of PLUGINS) {
      const neutral = JSON.parse(readFileSync(join(REPO_ROOT, plugin, 'plugin.manifest.json'), 'utf8'));
      const local = normalize(manifestToZcodeDoc(neutral));
      const artifact = renderArtifacts(neutral).find((file) => file.rel === 'hooks/hooks.json');
      const generated = artifact ? normalize(JSON.parse(artifact.bytes.toString('utf8'))) : { hooks: {} };
      assert.deepEqual(local, generated, `${plugin} 分组算法已分叉`);
    }
    const badProblems = [];
    manifestToZcodeDoc({ hooks: [{ event: 'Stop', type: 'process', command: 'node' }] }, badProblems);
    assert.ok(badProblems.length > 0, '缺 args 的声明须受控拒绝（记 problem），不得抛穿');
  });

  it('OPEN-276：hooks 非数组须记 problem（不得静默零声明）', () => {
    const problems = [];
    const doc = manifestToZcodeDoc({ hooks: {} }, problems);
    assert.deepEqual(doc, { hooks: {} }, '非数组不得回落生成物（权威零声明）');
    assert.ok(problems.some((p) => p.includes('hooks 形态非法')), '须记形态非法 problem（不静默）');
  });
});

describe('清单构造与校验', () => {
  const skills = ['skills/tdd/SKILL.md', 'skills/gate/SKILL.md'];
  // B 批起 PLUGIN_META 只含宿主事实（exampleQueries/hue）；清单构造的 meta 须带展示位
  //（真实链路=planPackage 自中立清单合成，见「B 批：展示元数据单源」组；此处注夹具值）
  const metaOf = (plugin) => ({ ...PLUGIN_META[plugin], displayName: `展示-${plugin}`, description: `${plugin} 夹具描述。` });

  it('生成的六份清单字段齐备且合规', () => {
    for (const plugin of PLUGINS) {
      const doc = buildManifest({ plugin, meta: metaOf(plugin), version: '0.5.2', author: 'wangp', skills, hooks: ['hooks/hooks.mcode.json'] });
      assert.deepEqual(validateManifest(doc), [], `${plugin} 清单应合规`);
      assert.equal(doc.apps.length, 0);
      assert.equal(doc.hooks[0], 'hooks/hooks.mcode.json');
    }
  });

  it('校验器拒掉白名单外键、非法 name、非 SemVer、非法 skill 路径、空 apps', () => {
    const base = () => buildManifest({ plugin: 'workflow', meta: metaOf('workflow'), version: '0.5.2', author: 'wangp', skills, hooks: [] });
    assert.ok(validateManifest({ ...base(), extra: 1 }).some((p) => p.includes('extra')));
    assert.ok(validateManifest({ ...base(), name: 'Workflow' }).some((p) => p.includes('name')));
    assert.ok(validateManifest({ ...base(), version: '0.5' }).some((p) => p.includes('SemVer')));
    assert.ok(validateManifest({ ...base(), skills: ['../x/SKILL.md'] }).some((p) => p.includes('skill 路径')));
    assert.deepEqual(validateManifest({ ...base(), skills: ['skills/TDD/SKILL.md'] }), [], '大写目录名合法（宿主只禁大小写碰撞，不禁大写）');
    assert.ok(validateManifest({ ...base(), apps: ['a.app.json'] }).some((p) => p.includes('apps') && p.includes('本层未实现 App 面')), '过期理由（宿主忽略本地 App）不得回退');
    assert.ok(validateManifest({ ...base(), category: 'Nope' }).some((p) => p.includes('category')));
    assert.ok(validateManifest({ ...base(), exampleQueries: [] }).some((p) => p.includes('exampleQueries')));
    assert.ok(validateManifest({ ...base(), skills: ['skills/a/SKILL.md', 'skills/A/SKILL.md'] }).some((p) => p.includes('碰撞')));
  });

  it('skill 文档面：六插件真实 SKILL.md 全部合规（frontmatter 名＝目录名、描述非空）', () => {
    // D4：宿主对任一不符 `readerFail('SKILL_SCHEMA_INVALID')` ⇒ **整包拒收**，不是跳过该 skill。
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
    // 下界口径：只锁「枚举到了源 skill」这一回归，精确计数由 install.test.mjs 的
    // per-plugin deepEqual 负责，此处不写死避免随 skill 增删双改
    assert.ok(docs.length >= 27, `应枚举到六插件源 skill（实测 ${docs.length}）`);
    assert.deepEqual(validateSkillDocs(docs), [], '真实 skill 文档面必须全部合规');
  });

  it('skill 文档面校验器：名不符/缺名/缺描述逐条报（整包拒收面）', () => {
    const doc = (name, description) => Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`, 'utf8');
    assert.deepEqual(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('tdd', '按 TDD 实现修复 —— 触发条件：新增或修改功能。') }]), []);
    assert.ok(
      validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('TDD', '描述在。') }]).some((p) => p.includes('与目录名')),
      'frontmatter 名与目录名不符必须报',
    );
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('', '描述在。') }]).some((p) => p.includes('缺 name')));
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: doc('tdd', '') }]).some((p) => p.includes('缺 description')));
    assert.ok(validateSkillDocs([{ rel: 'skills/tdd/SKILL.md', bytes: Buffer.from('没有 frontmatter 的正文', 'utf8') }]).some((p) => p.includes('缺 name')));
  });

  it('SemVer 与相对路径判据', () => {
    assert.ok(isSemVer('0.5.2'));
    assert.ok(isSemVer('1.0.0-rc.1'));
    assert.ok(!isSemVer('0.5'));
    assert.ok(!isSemVer('v0.5.2'));
    assert.ok(isPortableRelPath('skills/a/SKILL.md'));
    assert.ok(!isPortableRelPath('skills\\a\\SKILL.md'));
    assert.ok(!isPortableRelPath('/abs/path'));
    assert.ok(!isPortableRelPath('a//b'));
    assert.ok(!isPortableRelPath('a/../b'));
  });
});

describe('包上限', () => {
  it('路径形态：字符集、保留名、段数、段尾点', () => {
    assert.deepEqual(checkPathShape('skills/tdd/SKILL.md'), []);
    assert.ok(checkPathShape('skills/中文字/SKILL.md').length > 0);
    assert.ok(checkPathShape('hooks/CON.mjs').some((p) => p.includes('保留名')));
    assert.ok(checkPathShape('a/b/').some((p) => p.length > 0));
    assert.ok(checkPathShape('x.').some((p) => p.includes('以点结尾')));
    assert.ok(checkPathShape(Array.from({ length: 17 }, (_, i) => `d${i}`).join('/')).some((p) => p.includes('段数')));
  });

  it('计划上限：文件数、体积、大小写碰撞逐条报', () => {
    assert.deepEqual(checkPlanLimits([{ rel: 'a/b.txt', bytes: 10 }]), []);
    const tooMany = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ rel: `f${i}.txt`, bytes: 1 }));
    assert.ok(checkPlanLimits(tooMany).some((p) => p.includes('文件')));
    assert.ok(checkPlanLimits([{ rel: 'big.bin', bytes: LIMITS.maxFileBytes + 1 }]).some((p) => p.includes('单文件')));
    assert.ok(checkPlanLimits([{ rel: 'x.txt', bytes: 1 }, { rel: 'X.txt', bytes: 1 }]).some((p) => p.includes('碰撞')));
  });

  it('大小写碰撞按**逐级前缀**判定（宿主 registerPortablePrefixes 同款，D3）', () => {
    // 宿主对每级前缀都登记折叠键：`Skills/demo/x` 与 `skills/demo/y` 虽整路径不同，
    // 父目录拼写不同即 `CASE_COLLISION` 整包拒收（local-plugin-v1.md 点名的例子）。
    assert.ok(
      checkPlanLimits([{ rel: 'Skills/demo/a.md', bytes: 1 }, { rel: 'skills/demo/b.md', bytes: 1 }]).some((p) => p.includes('碰撞')),
      '仅父目录拼写不同也必须报（否则装得上、宿主侧整包拒）',
    );
    assert.deepEqual(
      checkPlanLimits([{ rel: 'skills/a/SKILL.md', bytes: 1 }, { rel: 'skills/b/SKILL.md', bytes: 1 }]),
      [],
      '同拼写的公共父目录是常态，不得误报',
    );
    assert.deepEqual(
      checkPlanLimits([{ rel: 'plugin-core/src/engine.mjs', bytes: 1 }, { rel: 'plugin-core/src/strategies/a.mjs', bytes: 1 }]),
      [],
      '真实包形态（多级同前缀）不得误报',
    );
  });

  it('六插件实测规模远在限内（限额校验不是摆设，但也确实不触发）', () => {
    // 逐插件枚举真实文件数与体积（只读，不物化）
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
      const abs = join(dir, entry.name);
      return entry.isDirectory() ? sum + walk(abs) : sum + 1;
    }, 0);
    for (const plugin of PLUGINS) {
      const count = walk(join(REPO_ROOT, plugin));
      assert.ok(count < LIMITS.maxFiles, `${plugin} 源文件数 ${count} 应在限内`);
      assert.ok(count > 0, `${plugin} 应有资产`);
    }
  });
});

describe('命令面处置', () => {
  it('处置表与真实命令文件一一对应（漂移即红）', () => {
    for (const plugin of PLUGINS) {
      const audit = auditDisposition(plugin, join(REPO_ROOT, plugin, 'commands'));
      assert.deepEqual(audit.missing, [], `${plugin} 有未登记的命令`);
      assert.deepEqual(audit.extra, [], `${plugin} 处置表登记了不存在的命令`);
      assert.deepEqual(audit.invalid, [], `${plugin} 处置表条目非法`);
    }
  });

  test('薄指针命令的 covers 目标必须是真实存在的 skill', () => {
    for (const [plugin, table] of Object.entries(COMMAND_DISPOSITION)) {
      for (const [command, entry] of Object.entries(table)) {
        if (entry.mode !== 'covered-by-skill') continue;
        assert.ok(existsSync(join(REPO_ROOT, plugin, 'skills', entry.covers, 'SKILL.md')), `${plugin}/${command} 指向的 skill ${entry.covers} 不存在`);
        assert.equal(materializeCommandSkill(plugin, command, join(REPO_ROOT, plugin, 'commands')), null, '薄指针不物化副本');
      }
    }
  });

  // 内部任务-295 复审 round2（项目约定维）：命令面口径「1 条同名 + 3 条改名」此前只有散文登记，
  // 无机械锁——改名集合一旦漂移，README/内部模块-25/内部接口-1 的措辞会静默失实。此处逐条钉死。
  it('薄指针命令的改名集合锁定：1 条同名（gate）＋3 条改名', () => {
    const covered = [];
    for (const [plugin, table] of Object.entries(COMMAND_DISPOSITION)) {
      for (const [command, entry] of Object.entries(table)) {
        if (entry.mode !== 'covered-by-skill') continue;
        covered.push(`${plugin}:${command}→${entry.covers}`);
      }
    }
    assert.deepEqual(covered.sort(), [
      'spec-gate:backfill→spec-backfill',
      'spec-gate:gate→gate',
      'spec-gate:spec→spec-writing',
      'team-governance:eval→agent-eval',
    ], '薄指针命令的覆盖目标发生漂移，须同步 README/M25 R-mc-5/IF-HOST-1 的措辞');
    const sameName = covered.filter((item) => item.split('→')[0].split(':')[1] === item.split('→')[1]);
    assert.deepEqual(sameName, ['spec-gate:gate→gate'], '逐字复现的只有同名项 gate');
  });

  it('命令型 skill：frontmatter 名等于目录名、来源标注在位、参数占位符已改写', () => {
    const skill = materializeCommandSkill('team-governance', 'gate', join(REPO_ROOT, 'team-governance', 'commands'));
    assert.ok(skill);
    const { data, body } = parseFrontmatter(skill.content);
    assert.equal(data.name, 'gate');
    assert.equal(skill.rel, 'skills/gate/SKILL.md');
    assert.match(skill.content, /来源：ZCode 命令 `team-governance\/commands\/gate\.md`/);
    assert.match(skill.content, /\/team-governance:gate/);
    assert.ok(!skill.content.includes('$ARGUMENTS'), '占位符必须改写，否则模型会去找不存在的变量');
    assert.ok(body.length > 0);
  });

  it('命令型 skill 不与既有 skill 目录撞名', () => {
    for (const [plugin, table] of Object.entries(COMMAND_DISPOSITION)) {
      for (const [command, entry] of Object.entries(table)) {
        if (entry.mode !== 'skill') continue;
        assert.ok(!existsSync(join(REPO_ROOT, plugin, 'skills', command)), `${plugin}/${command} 与既有 skill 目录撞名`);
      }
    }
  });

  it('frontmatter 解析：无 frontmatter 时整体当正文', () => {
    assert.deepEqual(parseFrontmatter('# 标题\n正文').data, {});
    assert.equal(parseFrontmatter('---\nname: a\ndescription: b\n---\n正文').data.description, 'b');
  });

  it('命令清单枚举稳定（排序、无扩展名）', () => {
    assert.deepEqual(listCommandNames(join(REPO_ROOT, 'spec-gate', 'commands')), ['backfill', 'evidence', 'gate', 'init', 'spec']);
    assert.deepEqual(listCommandNames(join(REPO_ROOT, 'scout', 'commands')), []);
  });

  it('构造面：空描述不崩但仍产出可解析文档', () => {
    const built = buildCommandSkill({ plugin: 'x', command: 'y', sourceRel: 'x/commands/y.md', frontmatter: {}, body: '正文' });
    assert.match(built.content, /name: y/);
    assert.match(built.content, /正文/);
  });
});

describe('agent 面', () => {
  it('工具映射：LS 归 glob 并去重，BashOutput 与未知名按拒绝丢弃', () => {
    const mapped = mapAgentTools('Glob, Grep, LS, Read, WebFetch, WebSearch, TodoWrite, BashOutput, Nope');
    assert.deepEqual(mapped.tools, ['glob', 'grep', 'read', 'web_fetch', 'web_search', 'todowrite']);
    assert.deepEqual(mapped.dropped, ['BashOutput', 'Nope']);
    const reviewer = mapAgentTools('Glob, Grep, LS, Read, WebFetch, WebSearch, TodoWrite, BashOutput, Bash');
    assert.ok(reviewer.tools.includes('bash'), 'code-reviewer 带 Bash（不是纯只读，边界由护栏承担）');
  });

  it('三份真实 agent 声明转换后 frontmatter 合宿主形态且工具面非空', () => {
    const names = listAgentNames(join(REPO_ROOT, 'workflow', 'agents'));
    assert.deepEqual(names, ['code-architect', 'code-explorer', 'code-reviewer']);
    for (const name of names) {
      const doc = convertAgentFile(join(REPO_ROOT, 'workflow', 'agents', `${name}.md`), name);
      const { data, body } = parseFrontmatter(doc.content);
      assert.equal(data.name, name);
      assert.ok(String(data.description).length > 0);
      assert.ok(doc.tools.length > 0, `${name} 映射后不得为空（宁可不装，不给无过滤的子 agent）`);
      assert.match(doc.content, /features:\n {2}delegation: false/);
      assert.ok(body.includes('职责'), '正文原样保留');
    }
  });
});

describe('图标与解释器', () => {
  it('图标 PNG 确定性且带合法签名（宿主按扩展名与字节核对）', () => {
    const a = renderIconPng(210, false);
    const b = renderIconPng(210, false);
    assert.ok(a.equals(b), '同色相两次生成字节一致（verify 才能比对）');
    assert.ok(a.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(!renderIconPng(210, true).equals(a), '暗色版与亮色版不同');
  });

  it('解释器解析：三级回退，探测缝可注入', () => {
    // 期望值用 join 归一（Windows 下 join 会把 'C:/PF' 写成 'C:\PF'，逐字比较会假红）
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
    assert.equal(resolveNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => true, probe: () => false }), null, '全不可得即 null，由安装器拒绝安装');
  });

  it('解释器解析：PATH 命中须绝对化，不得写裸 node（TASK-HANDOVER1002-1）', () => {
    const viaPath = resolveNode({
      env: {},
      execPath: 'C:/x/other.exe',
      exists: () => false,
      probe: (candidate) => candidate === 'node',
      resolveExecPath: () => '/usr/local/bin/node',
    });
    assert.deepEqual(viaPath, { path: '/usr/local/bin/node', source: 'path' });
    // PATH 探针命中但绝对化失败 ⇒ 继续回退；本例全部不可得 ⇒ null（安装器据此拒绝安装）
    assert.equal(
      resolveNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => null }),
      null,
    );
    // 解析失败但候选已是绝对路径（program-files 形态）⇒ 回落候选本身（不得丢弃已验证可执行的解释器）
    // 绝对根取平台无关形态：'/pf' 在 win32 与 posix 上 isAbsolute 均为真；字面量 'C:/PF' 在
    // POSIX 上是相对路径，会让本用例在 macOS/Linux 恒假红且失去判别力（硬规则 10 同旨）
    assert.deepEqual(
      resolveNode({
        env: { ProgramFiles: '/pf' },
        execPath: 'C:/x/other.exe',
        exists: () => true,
        probe: (candidate) => candidate === join('/pf', 'nodejs', 'node.exe'),
        resolveExecPath: () => null,
      }),
      { path: join('/pf', 'nodejs', 'node.exe'), source: 'program-files' },
    );
    // 真机形态：任何来源的返回值都必须是绝对路径（宿主不为钩子注入独立 Node）
    const real = resolveNode();
    assert.ok(real !== null && isAbsolute(real.path), `解释器须为绝对路径，实得 ${real?.path}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B 批（内部任务-5，R-pc-14）：展示元数据单源——中立清单 description/displayName 合入
// input.meta，本层不再维护 displayName/description 同义副本（hue/exampleQueries
// 等宿主事实仍归 PLUGIN_META）。
// ─────────────────────────────────────────────────────────────────────────────
describe('B 批：展示元数据单源', () => {
  it('PLUGIN_META 不含 displayName/description 同义副本（品牌表已删；hue/exampleQueries 宿主事实保留）', () => {
    for (const plugin of PLUGINS) {
      const meta = PLUGIN_META[plugin];
      assert.ok(!('displayName' in meta), `${plugin} PLUGIN_META 不得再含 displayName（中立清单是唯一人工编辑展示源）`);
      assert.ok(!('description' in meta), `${plugin} PLUGIN_META 不得再含 description 同义副本`);
      assert.ok(Number.isInteger(meta.hue), `${plugin} hue（图标底色，宿主事实）应保留`);
      assert.ok(Array.isArray(meta.exampleQueries) && meta.exampleQueries.length > 0, `${plugin} exampleQueries（宿主要求，事实字段）应保留`);
    }
  });

  it('planPackage 展示自中立清单合成：包清单 displayName/description 与 plugin.manifest.json 同源', () => {
    for (const plugin of PLUGINS) {
      const neutral = JSON.parse(readFileSync(join(REPO_ROOT, plugin, 'plugin.manifest.json'), 'utf8'));
      const plan = planPackage({ repoRoot: REPO_ROOT, plugin, nodePath: process.execPath });
      assert.equal(plan.manifest.displayName, neutral.displayName, `${plugin} 包清单 displayName 须取中立清单`);
      assert.equal(plan.manifest.description, neutral.description, `${plugin} 包清单 description 须取中立清单`);
    }
  });

  it('无中立源回退：displayName=稳定 slug、description=生成物描述（不留本地品牌表）', () => {
    // 夹具形态同 source-switch.test.mjs：真件插件名 + plugin-core 软链（planPackage 物化引擎闭包）
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcode-brand-')));
    try {
      symlinkSync(join(REPO_ROOT, 'plugin-core'), join(base, 'plugin-core'), 'dir');
      const root = join(base, 'workflow');
      mkdirSync(join(root, '.zcode-plugin'), { recursive: true });
      writeFileSync(join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({
        name: 'workflow', version: '0.6.5', description: '回退描述（生成物）', author: 'wangp',
      }), 'utf8');
      const plan = planPackage({ repoRoot: base, plugin: 'workflow', nodePath: process.execPath });
      assert.equal(plan.manifest.displayName, 'workflow', '无中立 displayName 时回落稳定 slug（插件目录名）');
      assert.equal(plan.manifest.description, '回退描述（生成物）', '无中立清单时 description 回落生成物（.zcode-plugin/plugin.json）');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// 内部任务-55 步骤 1.6 —— 内部未决-65 未验证面 ①：`program-files` / `local-appdata` 两级探测分支的
// **Windows 真机**验证（登记于 2026-10-02，此前只有「宿主源码取证 + macOS 真机对拍」，
// 未在 Windows 真机跑过）。
//
// 为什么必须真机：这两级的判据链是「`exists` 守卫 → 真实 `-v` 探针 → 真实绝对化读回」，
// 用注入替身跑绿证明不了「宿主机上 `env.ProgramFiles` 拼出的路径真能命中可执行文件」。
//
// 唯一注入点与理由：PATH 名的 `node` 候选在本机**必然**探通（真机装了 Node），会吃掉整条
// 回退链，故只对该候选返回 false；绝对路径候选的 probe 与绝对化读回**全部走真实实现**。
describe('DEV-55 步骤 1.6：OPEN-65 ① 解释器两级探测分支（Windows 真机）', () => {
  const onlyAbsolute = (candidate) => (candidate === 'node' ? false : probeNode(candidate));
  const skip = process.platform === 'win32'
    ? false
    : '仅 Windows 存在 ProgramFiles / LOCALAPPDATA 两级变量；其他平台的同款回退面归各自宿主分支，不在本条断言范围';

  it('program-files 级：命中即绝对路径，且与 env.ProgramFiles 拼出值逐字相等', { skip }, () => {
    const expected = join(process.env.ProgramFiles, 'nodejs', 'node.exe');
    // Windows 环境变量原始键大小写随会话而异（2026-10-13 实录：本会话原始键为 PROGRAMFILES
    // 全大写）——process.env 直读大小写不敏感，但 `{...process.env}` 展开后只剩原始键，
    // buildCandidates 读 PascalCase 得 undefined ⇒ program-files 候选未成形、假红回落 self。
    // 显式归一防环境假红（生产路径默认传 process.env 本体、无展开面，不受此影响）。
    const env = { ...process.env };
    if (env.ProgramFiles === undefined && typeof env.PROGRAMFILES === 'string') env.ProgramFiles = env.PROGRAMFILES;
    const resolved = resolveNode({ env, probe: onlyAbsolute });
    assert.ok(resolved !== null, '真机上必须可解析出 node（否则装包会写进不可执行的命令）');
    assert.ok(isAbsolute(resolved.path), '写入包内的解释器路径必须是绝对路径（宿主不为钩子注入独立 Node）');
    if (!existsSync(expected)) {
      // 非标准 Windows 布局（nvm-windows / fnm / scoop / choco / Volta 等）：该路径本就不存在，
      // 断言「必然命中 program-files」会在这些机器上假红。改为断言**如实回落**且仍给绝对路径。
      assert.notEqual(resolved.source, 'program-files', '该路径不存在时不得伪报命中 program-files');
      return;
    }
    assert.equal(resolved.source, 'program-files', `实得来源 ${String(resolved.source)}`);
    assert.equal(resolved.path, expected, '绝对化读回应与 ProgramFiles 拼出值逐字相等');
  });

  it('local-appdata 级：该位置有 node 时命中、无 node 时不得误命中并如实回落', { skip }, () => {
    const expected = join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe');
    const resolved = resolveNode({ env: { ...process.env, ProgramFiles: '' }, probe: onlyAbsolute });
    if (existsSync(expected)) {
      assert.equal(resolved && resolved.source, 'local-appdata', '该位置确有 node 时应命中 local-appdata 级');
    } else {
      assert.notEqual(resolved && resolved.source, 'local-appdata', '该位置无 node 时不得误命中 local-appdata 级（误命中=写出坏路径）');
      assert.equal(resolved && resolved.source, 'self', '应如实回落到 self 源（当前进程自身的 node），而非静默返回 null');
    }
  });

  // 评审补强（内部任务-55 code-review 简洁性/约定维第 3 条）：上面那条真机用例在本机只走「该位置
  // 无 node」的缺席分支 ⇒ 删掉 `local-appdata` 候选也不会转红（零判别力）。本条用注入 env 覆盖
  // **命中侧**，使 内部未决-65 ① 的关闭不依赖执行机的 node 安装位置。
  it('local-appdata 级：注入 env 下的命中侧（不依赖执行机是否装了 node）', () => {
    const resolved = resolveNode({
      env: { LOCALAPPDATA: 'C:/la', ProgramFiles: '' },
      execPath: 'C:/x/other.exe',
      exists: () => true,
      probe: (c) => c.endsWith('node.exe'),
      resolveExecPath: (c) => c,
    });
    assert.equal(resolved && resolved.source, 'local-appdata', `注入下该级必须命中（实得 ${JSON.stringify(resolved)}）`);
    assert.equal(resolved && resolved.path, join('C:/la', 'Programs', 'nodejs', 'node.exe'), '命中路径须由 LOCALAPPDATA 拼出（用 join 取本平台分隔符）');
  });
});

// 内部任务-55 步骤 2.1/2.2 —— 内部未决-63 解释器解析三态诊断。登记原文：三态曾共用一条拒绝文案
// ⇒ 运维者朝错误方向排查（真去装 Node／真去修 PATH，而实际可能是读回失败或装而不可用）。
// 本组把三态各自钉一个**分支专属**文案子串，三条文案互不相同。
//
// 诚实记录：本组用例**晚于**实现落盘（纯函数面，无宿主依赖可先跑），故判别力以变异裁决补证
// （删掉任一分支实现，其对应用例必红）——见 内部证据。
describe('DEV-55 步骤 2.1：解释器解析三态诊断（OPEN-63）', () => {
  it('① 未装 Node：候选路径一个都不存在，PATH 探针也未通过', () => {
    const options = { env: { ProgramFiles: 'C:/pf', LOCALAPPDATA: 'C:/la' }, execPath: 'C:/x/other.exe', exists: () => false, probe: () => false };
    const d = diagnoseNode(options);
    assert.equal(d.state, RESOLUTION_STATES.NOT_INSTALLED, `实得 ${d.state}`);
    const text = nodeFailureText(d.state);
    assert.match(text, /未找到可执行的 node/, '该态须指名「未找到」');
    assert.ok(!text.includes('读不回'), '该态不得混入读回失败的下一步');
    assert.equal(resolveNode(options), null, 'resolveNode 契约不变：仍返回 null');
  });

  it('② 读回失败：候选探针通过但绝对化读回拿不回路径', () => {
    const options = { env: {}, exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => null, execPath: 'C:/x/other.exe' };
    const d = diagnoseNode(options);
    assert.equal(d.state, RESOLUTION_STATES.READBACK_FAILED, `实得 ${d.state}`);
    const text = nodeFailureText(d.state);
    assert.match(text, /读不回它的绝对路径/);
    assert.match(text, /禁止在钩子里执行/, '该态须指向「宿主禁 node -e」这一真实成因');
    assert.ok(!text.includes('安装 Node.js 后重跑'), '该态的下一步不得是「装 Node」');
  });

  it('③ 装了但不可用：候选路径存在却全部探针未通过', () => {
    const d = diagnoseNode({ env: { ProgramFiles: 'C:/pf', LOCALAPPDATA: 'C:/la' }, execPath: 'C:/x/other.exe', exists: () => true, probe: () => false });
    assert.equal(d.state, RESOLUTION_STATES.UNUSABLE, `实得 ${d.state}`);
    const text = nodeFailureText(d.state);
    assert.match(text, /候选路径存在但一个都跑不起来/);
    assert.match(text, /权限不足|架构不匹配/, '该态须指向可执行性而非「没装」');
    assert.ok(!text.includes('安装 Node.js 后重跑'), '该态的下一步不得是「装 Node」——它装了');
  });

  it('三态文案逐条不同（共用文案即 OPEN-63 的原始缺陷）', () => {
    const texts = [RESOLUTION_STATES.NOT_INSTALLED, RESOLUTION_STATES.READBACK_FAILED, RESOLUTION_STATES.UNUSABLE].map(nodeFailureText);
    assert.equal(new Set(texts).size, 3, '三态文案必须互不相同');
  });

  it('成功路径同样给出 OK 与逐候选证据（诊断不得改变解析成功时的行为）', () => {
    const d = diagnoseNode({ env: {}, exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => 'C:/pf/nodejs/node.exe' });
    assert.equal(d.state, RESOLUTION_STATES.OK);
    assert.ok(d.attempts.some((a) => a.stage === 'ok'), '须留逐候选证据');
  });

  // 评审补强（内部任务-55 code-review 正确性维 F1 / 简洁性维第 2 条，两个实例独立命中）：诊断与解析器
  // 在「读回失败但候选本身是绝对路径」形态下曾给出相反结论（解析器采用、诊断报失败）。本条把
  // 「state === OK ⟺ resolveNode() 非 null」钉成不变量——删掉 `degraded` 分支即红。
  it('诊断与解析器同向：state === OK ⟺ resolveNode() 非 null', () => {
    const cases = [
      { label: '全不可得', options: { env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: () => false } },
      { label: 'PATH 读回失败且非绝对', options: { env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: (c) => c === 'node', resolveExecPath: () => null } },
      { label: 'local-appdata 命中', options: { env: { LOCALAPPDATA: 'C:/la' }, execPath: 'C:/x/other.exe', exists: () => true, probe: (c) => c.endsWith('node.exe'), resolveExecPath: (c) => c } },
      { label: '读回失败但候选本身是绝对路径（degraded 采用）', options: { env: { ProgramFiles: 'C:/pf' }, execPath: 'C:/x/other.exe', exists: () => true, probe: () => true, resolveExecPath: () => null } },
    ];
    for (const { label, options } of cases) {
      const resolved = resolveNode(options);
      const state = diagnoseNode(options).state;
      assert.equal(state === RESOLUTION_STATES.OK, resolved !== null, `${label}：state=${state} 与 resolveNode(${JSON.stringify(resolved)}) 不同向`);
    }
  });

  // 评审补强（正确性维 F7）：attempts 面此前零断言，删空或写死仍全绿。
  it('逐候选证据：三态各态的 attempts 记全（缺席原因也留痕）', () => {
    const d = diagnoseNode({ env: {}, execPath: 'C:/x/other.exe', exists: () => false, probe: () => false });
    assert.deepEqual(d.attempts.map((a) => a.source), ['path', 'program-files', 'local-appdata', 'self'], '四候选都要留痕');
    assert.ok(d.attempts.some((a) => a.stage === 'probe'), '须留下 probe 阶段记录');
    assert.ok(d.attempts.some((a) => a.stage === 'skipped'), '缺席候选须留下 skipped 记录');
    assert.ok(d.attempts.every((a) => typeof a.reason === 'string' && a.reason.length > 0), '每条都要有可读原因');
  });
});
