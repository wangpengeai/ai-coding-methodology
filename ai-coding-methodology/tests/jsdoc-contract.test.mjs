// 文件：jsdoc-contract.test.mjs
// 描述：ai-coding-methodology 的 JSDoc 契约守卫——纯 JS 项目里 JSDoc 兼作类型与契约标注
//       （nodejs-best-practices §JSDoc 规范：导出的函数/类/常量必须有 JSDoc 说明契约），
//       故"导出了却没写契约"是可机检的硬项。此前靠人工抽查，本用例把它变成常驻断言：
//       ① 每个 `export function` / `export const` 必须有紧邻的 JSDoc 块；
//       ② `@param` 数不少于形参数（跳过 `{}` 解构整体与 `...rest`）；
//       ③ `export async function` 必须有 `@returns`。
//       豁免：纯 re-export 的 index 文件（本层入口不是纯 re-export，不豁免）。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAppBoot } from './helpers/dsh-engine.mjs';
import { collectAgents } from '../src/agents-bridge.mjs';
import { collectCommands } from '../src/commands-bridge.mjs';
import { Config, discoverPlugins } from '../src/index.mjs';
import { collectSkills } from '../src/skills-bridge.mjs';
import { testEngine } from './helpers/engine-binding.mjs';

// 引擎绑定（批 2 阶段 2）：本文件的资产计数断言经 collectSkills/collectCommands 间接调
// skillNameOf（引擎驱动），须先绑定真实仓引擎（与 apply() 同一 ensureBound 入口）。
testEngine();

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const README = join(HERE, '..', 'README.md');

/**
 * 数一个测试文件里声明的用例数（顶层 `test(...)` 调用）。
 * 与 `node --test` 报告的 `tests N` 在**本层全部 6 个文件上逐一对齐**过，故可作廉价替身
 * ——不必为了核对文档数字而在测试里再起 6 个 node --test 子进程。
 * @param {string} file 测试文件名（不含目录）
 * @returns {number} 用例数
 */
function countCases(file) {
  const text = readFileSync(join(HERE, file), 'utf8');
  return (text.match(/^test\(/gm) ?? []).length;
}

/**
 * 判定一个 export 声明前是否有合规 JSDoc。
 * 规则：紧邻上一行必须**以块注释收束**（一行式的 `/** … *​/` 或多行块的结尾行都算）；
 * 中间隔空行就算没有——否则反向扫描会越过空行找到上一个无关函数的注释，形成假通过。
 * @param {string[]} lines 文件按行切分
 * @param {number} index 声明所在行下标
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkAt(lines, index) {
  const prev = (lines[index - 1] ?? '').trim();
  const oneLine = prev.startsWith('/**');
  if (!oneLine && !prev.endsWith('*/')) {
    return { ok: false, reason: '缺 JSDoc 块（紧邻上一行不是块注释结尾）' };
  }
  // 一行式注释整块就是那一行；多行式向上找到 /** 开头
  let start = index - 1;
  if (!oneLine) {
    while (start > 0 && !lines[start].trim().startsWith('/**')) start -= 1;
  }
  const block = lines.slice(start, index).join('\n');
  const signature = lines[index].match(/^export (async )?function \w+\s*\(([^)]*)\)/);
  if (!signature) return { ok: true };
  const declared = signature[2]
    .split(',')
    .map((p) => p.trim().split('=')[0].trim())
    .filter((p) => p !== '' && p !== '{}' && !p.startsWith('...'));
  const documented = (block.match(/@param\b/g) ?? []).length;
  if (documented < declared.length) return { ok: false, reason: `@param ${documented}/${declared.length}` };
  if (signature[1] === 'async ' && !/@returns\b/.test(block)) return { ok: false, reason: 'async 缺 @returns' };
  return { ok: true };
}

test('JSDoc 契约：src 下每个 export（函数/常量）都有合规 JSDoc', () => {
  const problems = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.mjs'))) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const isFn = /^export (?:async )?function \w+/.test(lines[i]);
      const isConst = /^export (?:const|let) \w+/.test(lines[i]);
      if (!isFn && !isConst) continue;
      const verdict = checkAt(lines, i);
      if (!verdict.ok) problems.push(`${file}:${i + 1} ${verdict.reason}`);
    }
  }
  assert.deepEqual(problems, [], `导出缺 JSDoc 契约：\n${problems.join('\n')}`);
});

test('JSDoc 契约：守卫自身有效（对缺 JSDoc / 缺 @param / 缺 @returns 都必须报错）', () => {
  // 反向对照——否则上面的断言可能因为正则不匹配而永远空转
  const fake = [
    '/** @param {number} a 入参 @returns {number} 原样 */', // 0
    'export function ok(a) {', // 1 ← 合规
    '  return a;', // 2
    '}', // 3
    '', // 4
    'export function missing(a) {', // 5 ← 前面是空行 ⇒ 必须报"缺 JSDoc"
    '  return a;', // 6
    '}', // 7
    '', // 8
    '/** @param {number} a 入参（只写了一个） */', // 9
    'export function partial(a, b) {', // 10 ← 必须报 @param 1/2
    '  return a + b;', // 11
    '}', // 12
    '', // 13
    '/** @param {number} a 入参 */', // 14
    'export async function noReturns(a) {', // 15 ← async 缺 @returns
    '  return a;', // 16
    '}', // 17
  ];
  assert.deepEqual(checkAt(fake, 1), { ok: true }, '合规样本应通过');
  const missing = checkAt(fake, 5);
  assert.equal(missing.ok, false, '缺 JSDoc 的必须被抓出');
  assert.match(missing.reason, /缺 JSDoc/);
  const partial = checkAt(fake, 10);
  assert.equal(partial.ok, false, '@param 不足必须被抓出');
  assert.match(partial.reason, /@param 1\/2/);
  const noReturns = checkAt(fake, 15);
  assert.equal(noReturns.ok, false, 'async 缺 @returns 必须被抓出');
  assert.match(noReturns.reason, /@returns/);
});

test('README 的测试计数声明与实测一致（防"文档数字是残留"这类漂移）', () => {
  // 为什么要有：本层 README 里同时写着总数与逐文件分解，2026-09-28 第 51 批实测发现
  // 两处已过期（总数 119 而实为 120、agent 面写 19 而实为 22，且后者与前者自相矛盾）——
  // 加了用例却忘了改文档，是典型的"改了代码没改文档"漂移。本用例把两者钉在一起。
  // 注：扫描面随测试面扩张同步增列（批 2 阶段 1 起含 engine-loader 与 apply-refuse）。
  const files = [
    'acceptance.test.mjs',
    'hooks-bridge.test.mjs',
    'agents-bridge.test.mjs',
    'commands-bridge.test.mjs',
    'skills-bridge.test.mjs',
    'jsdoc-contract.test.mjs',
    // 批 2 阶段 1 新增：装载/绑定面（engine-loader）与拒载语义（apply-refuse，独立文件——
    // 模块级绑定槽要求拒载负例与成功 apply 不同文件，见计划「负例顺序约束」）
    'engine-loader.test.mjs',
    'apply-refuse.test.mjs',
    // 阶段 2 起：逐点等价用例（消费点改引擎驱动后的快照钉桩）
    'equivalence.test.mjs',
    // 阶段 2 步骤 5 六件：声明源事件读面 + 允许表公式（含反向证明）与第六参装配级生效性
    'envelope-events.test.mjs',
    // 终审阻塞③：装载期字段契约断言的 apply() 级端到端用例
    'apply-shape.test.mjs',
    // 终审阻塞②：逐插件允许表注入的装配级端到端用例
    'apply-dispatch.test.mjs',
    // 内部决策-053（内部任务-171）：DSH 长任务编排（协议注入 + todo 驱动）状态机与装配级用例
    'long-task-driver.test.mjs',
    // 内部任务-189（F2）：适配层桥接工具（list/message/wait 三工具 + 装配级 created 接线）
    'agent-control-bridge.test.mjs',
    // 内部任务-189（F2）步骤 7 POC：真实 dsh-tools 注册契约 + 实现态相位 M（F2_POC_PHASE=M）
    'f2-poc.integration.test.mjs',
    // 内部任务-201（内部决策-057）：配置面——宿主 volatile 门控/恒装配标记/打包契约与客户端半侧 bundle 形态
    'config-surface.test.mjs',
    'client-bundle.test.mjs',
    'declaration-diagnostics.test.mjs',
    'plan-mode-gate.test.mjs',
  ];
  const actual = Object.fromEntries(files.map((f) => [f.replace('.test.mjs', ''), countCases(f)]));
  const total = Object.values(actual).reduce((a, b) => a + b, 0);
  const readme = readFileSync(README, 'utf8');

  // ① 总数行：`N 项（`acceptance` a + `hooks-bridge` b + `agents-bridge` c + `commands-bridge` d +`
  const m = readme.match(/^(\d+) 项（`acceptance` (\d+) \+ `hooks-bridge` (\d+) \+ `agents-bridge` (\d+) \+ `commands-bridge` (\d+) \+/m);
  assert.ok(m, 'README 应有总数声明行（格式：N 项（`acceptance` a + …））');
  assert.equal(Number(m[1]), total, `README 总数 ${m[1]} 与实测 ${total} 不一致`);
  for (const [name, claim] of [
    ['acceptance', m[2]],
    ['hooks-bridge', m[3]],
    ['agents-bridge', m[4]],
    ['commands-bridge', m[5]],
  ]) {
    assert.equal(Number(claim), actual[name], `README 中 ${name} 的 ${claim} 与实测 ${actual[name]} 不一致`);
  }

  // ② 分节行：`tests/<file>.test.mjs`，N 项 —— 每处都要与实测一致
  const sectionClaims = [...readme.matchAll(/`tests\/([\w-]+)\.test\.mjs`，(\d+) 项/g)];
  assert.ok(sectionClaims.length >= 2, 'README 应有分节计数声明');
  for (const [, file, claim] of sectionClaims) {
    assert.equal(Number(claim), actual[file], `README 分节 ${file} 的 ${claim} 与实测 ${actual[file]} 不一致`);
  }

  // ③ 反向对照：数用例的函数本身不能永远返回 0（否则上面全成假通过）
  assert.ok(total > 0 && actual.acceptance > 0, 'countCases 必须真的数到用例');
});

// 注记（2026-09-28 第 52 批）：曾试图再加一条"仓库文档不得另抄本层计数"的守卫，用正则扫
// ADR/AGENTS 里的"N 项"。**已弃用**——它对自然语言太脆：实测把一个无关的"64 项测试里"当成
// 违例（那是 ADR 里描述另一件事的句子）。根本解法不是"守卫去猜散文"，而是**不要有第二份副本**：
// 已把 README 定为唯一权威处，内部决策-032 与设计文档改为引用它而非另抄数字。宁少一条守卫，
// 不留一条会误报的。

test('README 声明的四面资产计数与脚本实收一致（数字以 README 与实测对拍为准）', () => {
  // 为什么要有：README 多处写着"N 份 SKILL.md + N 条命令 + N 份 agent 声明"，这几个数此前
  // 只由"人肉核对"保证——而本会话已两次抓到文档计数漂移（§8.39/§8.40）。本用例把脚本**实际
  // 收集到**的条数与 README 的声明绑在一起：改资产数而没改 README（或反之）都会红。
  // 历史注记：README 曾写 27 份（后随批次演进为 28→30→31），故标题**不写死数字副本**。
  const repo = join(HERE, '..', '..');
  const roots = discoverPlugins(repo);
  const actual = {
    skill: collectSkills(roots).skills.length,
    command: collectCommands(roots).commands.length,
    agent: collectAgents(roots).agents.length,
  };

  const readme = readFileSync(README, 'utf8');
  const claim = readme.match(/(\d+) 份 `SKILL\.md` \+ (\d+) 条命令 \+ (\d+) 份 agent 声明/);
  assert.ok(claim, 'README 应有"N 份 `SKILL.md` + N 条命令 + N 份 agent 声明"的计数声明');

  assert.equal(actual.skill, Number(claim[1]), `skill 实收 ${actual.skill}，README 写 ${claim[1]}`);
  assert.equal(actual.command, Number(claim[2]), `命令实收 ${actual.command}，README 写 ${claim[2]}`);
  assert.equal(actual.agent, Number(claim[3]), `agent 实收 ${actual.agent}，README 写 ${claim[3]}`);

  // 反向对照：三面都不能是 0（否则"相等"可能只是双方都空）
  for (const [k, v] of Object.entries(actual)) {
    assert.ok(v > 0, `${k} 面实收为 0——夹具/发现逻辑失效，等于本断言空转`);
  }
});

test('README 配置表与 Config schema 逐字段一致（字段名不遗漏、默认值不漂移）', () => {
  // 为什么要有：本会话第三次抓到同一族漂移——README 写"三条配置"而表里是**四条**
  // （且 Config 实为四字段）。这类"散文里的数目/清单与代码不一致"靠人眼很难发现，
  // 而设置面板恰恰是照 Config 渲染的，读者照 README 数会数错。故钉住：
  // ① 表里出现的字段集合必须与 Config 解析出的字段集合完全相同（多写/漏写都红）；
  // ② 表里"默认"列必须与 schema 填出的默认值相符（`{}` / `''` / `true` / `false` 归一比较）。
  const schema = Config({});
  // 内部决策-057（内部任务-201）：`agentControlBridge` 是 volatile 运行时引用，默认值/类型对拍须解包 `.get()`；
  // README 配置表保持「boolean / false」的人读口径与行格式不变。
  const resolved = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value);
  const fields = Object.keys(schema).sort();

  const readme = readFileSync(README, 'utf8');
  // 配置表行形如：| `name` | `type` | `default` | 含义 |
  const rows = [...readme.matchAll(/^\|\s*`(\w+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/gm)];
  assert.ok(rows.length > 0, 'README 应有配置表（形如 | `字段` | `类型` | `默认` | … |）');
  const documented = rows.map((r) => r[1]).sort();
  assert.deepEqual(documented, fields, `README 配置表字段 ${JSON.stringify(documented)} 与 schema ${JSON.stringify(fields)} 不一致`);

  const norm = (v) => String(v).replace(/\s+/g, '');
  for (const [, name, type, dflt] of rows) {
    assert.equal(norm(type), norm(typeof resolved(schema[name]) === 'boolean' ? 'boolean' : type), `${name} 的类型列应为 schema 的实际类型`);
    const actualDefault = JSON.stringify(resolved(schema[name]) ?? '');
    const claimed = norm(dflt);
    const ok =
      claimed === norm(actualDefault) ||
      (claimed === '{}' && actualDefault === '{}') ||
      (claimed === "''" && actualDefault === '""');
    assert.ok(ok, `${name} 默认值：README 写 ${dflt}，schema 实为 ${actualDefault}`);
  }

  // 反向对照：不能因为表为空/字段为 0 而双方"相等"
  assert.ok(fields.length >= 4, `Config 字段数应 ≥ 4，实为 ${fields.length}`);
});

test('README 里的 `config:` YAML 示例只使用 Config 真实字段（复制即用，不许写错键名）', () => {
  // 为什么要有（2026-09-28 第 99 批）：README 的安装一节新增了一段**让用户照抄**的示例——
  //   - id: ai-coding-methodology
  //     config:
  //       mountAgents: true
  // 用户会直接粘到 `cordis.patch.yml`。若这里键名写错（例如 `mountAgent`），
  // **宿主不会报错**（配置块是自由字典），只会静默不生效——"照文档做却没反应"是最难排查的一类。
  // 故把示例里的键名钉在 Config schema 上：写错即红。
  const schema = Config({});
  const fields = new Set(Object.keys(schema));
  const readme = readFileSync(README, 'utf8');

  // 取所有围栏代码块中、含 `config:` 的块，抽出其下**两级缩进**的键
  const blocks = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const configBlocks = blocks.filter((b) => /^\s*config:\s*$/m.test(b));
  assert.ok(configBlocks.length > 0, 'README 应有一段带 `config:` 的 YAML 示例（安装一节）');

  const keys = [];
  for (const b of configBlocks) {
    const lines = b.split('\n');
    const idx = lines.findIndex((l) => /^\s*config:\s*$/.test(l));
    const baseIndent = (lines[idx].match(/^\s*/) ?? [''])[0].length;
    for (const line of lines.slice(idx + 1)) {
      if (line.trim() === '') continue;
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (indent <= baseIndent) break; // 回到同级说明 config 块结束
      const km = /^\s*([A-Za-z_]\w*)\s*:/.exec(line);
      if (km) keys.push(km[1]);
    }
  }
  assert.ok(keys.length > 0, `示例里应抽出至少一个配置键（实际：${JSON.stringify(keys)}）`);
  for (const k of keys) {
    assert.ok(fields.has(k), `README 的 config 示例写了不存在的字段 \`${k}\`（Config 实际字段：${[...fields].sort().join(', ')}）`);
  }
  // 反向对照：抽键逻辑本身有效——故意用不存在的键跑一遍必须能被判出
  assert.ok(!fields.has('mountAgent'), '抽键/判据有效性对照：mountAgent 不是合法字段');
});

test('README 的 config 示例能通过**宿主真实补丁引擎**落地（写对了才算写对）', async (t) => {
  // 为什么要有（2026-09-28 第 100 批）：上一条只验"键名存在"，但用户真正关心的是
  // **把它贴进 cordis.patch.yml 之后配置会不会真的生效**。这条用宿主自己的引擎回答：
  // `@deepseek-ai/dsh-app-boot` 的 `composeEntries(layers, warn)` 与 `--dump-config`/启动
  // 走**同一个** `applyEntryPatches`，故它给出的结果就是 dump 所见的组合结果。
  //
  // 实测确认（0.1.7-rc.2）：非 insert 补丁按 `id` 找行，随后 `target[key] = value` 覆盖
  // （`name` 非必填），于是 `- id: ai-coding-methodology` + `config: {…}` 恰好把该行的 config 设成我们要的值。
  // 反例也在同批实测：`id` 写错 ⇒ 宿主发 `patch: entry "…" not found` 警告并**跳过**，
  // 目标行 config 不变——这正是用户"照抄却没反应"时该去 dump 里找的信号（README 已写明）。
  // 解析收拢到 `helpers/dsh-engine.mjs`（第 103 批）：默认跑法下自动从 DSH 安装目录提取，不再静默跳过。
  const engine = await loadAppBoot();
  if (engine === undefined || typeof engine.composeEntries !== 'function') {
    t.diagnostic(
      '跳过：本机未找到可用的 @deepseek-ai/dsh-app-boot（可设 DSH_APP_BOOT_PATH 或 DSH_APP_ROOT，' +
        '或把它装成 devDependency）。',
    );
    return;
  }

  // 从 README 抽出示例 config（与上一条同一抽法）
  const readmeText = readFileSync(README, 'utf8');
  const blocks = [...readmeText.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const configBlocks = blocks.filter((b) => /^\s*config:\s*$/m.test(b));
  assert.ok(configBlocks.length > 0, 'README 应有一段带 `config:` 的 YAML 示例');
  const lines = configBlocks[0].split('\n');
  const ci = lines.findIndex((l) => /^\s*config:\s*$/.test(l));
  const baseIndent = (lines[ci].match(/^\s*/) ?? [''])[0].length;
  const example = {};
  for (const line of lines.slice(ci + 1)) {
    if (line.trim() === '') continue;
    if ((line.match(/^\s*/) ?? [''])[0].length <= baseIndent) break;
    const km = /^\s*([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/.exec(line);
    if (km) example[km[1]] = km[2] === 'true' ? true : km[2] === 'false' ? false : km[2];
  }
  assert.ok(Object.keys(example).length > 0, `README 示例应至少含一个配置键，实际 ${JSON.stringify(example)}`);

  // ① 正常情形：bundle 补丁先插入本层行，用户补丁再设置 config ⇒ config 落地且无警告
  const warn = [];
  const composed = engine.composeEntries(
    [[{ insert: [{ id: 'ai-coding-methodology', name: 'ai-coding-methodology' }] }], [{ id: 'ai-coding-methodology', config: example }]],
    (m) => warn.push(m),
  );
  const row = composed.find((e) => e.id === 'ai-coding-methodology');
  assert.ok(row, '组合结果里应有 ai-coding-methodology 行');
  assert.deepEqual(row.config, example, `README 示例应被应用到该行，实际 ${JSON.stringify(row.config)}`);
  assert.deepEqual(warn, [], `不应有补丁告警，实际 ${JSON.stringify(warn)}`);

  // ② 反向对照：`id` 写错时宿主**会告警并跳过**（证明上一条的通过不是"引擎总是成功"）
  const warn2 = [];
  const composed2 = engine.composeEntries(
    [[{ insert: [{ id: 'ai-coding-methodology', name: 'ai-coding-methodology' }] }], [{ id: 'dsh-comapt', config: example }]],
    (m) => warn2.push(m),
  );
  assert.ok(warn2.some((m) => /not found/.test(m)), `id 写错应告警，实际 ${JSON.stringify(warn2)}`);
  assert.equal(composed2.find((e) => e.id === 'ai-coding-methodology').config, undefined, 'id 写错时该行不应被设置 config');
});

test('本层真实 cordis.patch.yml 能通过宿主真实补丁引擎组合出正确条目', async (t) => {
  // 为什么要有（2026-09-28 第 101 批）：`cordis.patch.yml` 是**本层与宿主之间的唯一接口文件**，
  // 但此前只用**正则**做结构核对（"三行有效内容、顶层 insert、id/name 相同"）——
  // 那是"看起来对"，不是"宿主能消费"。这条用宿主自己的引擎回答后者：
  // `composeEntries` 与启动/`--dump-config` 走同一个 `applyEntryPatches`（见 §8.87），
  // 故它给出的组合结果就是宿主装出来的结果。
  //
  // 与上一条（README 示例）的分工：那条验**用户怎么改配置**，这条验**本层自带的补丁文件本身**。
  // 解析收拢到 `helpers/dsh-engine.mjs`（第 103 批）：默认跑法下自动提取。
  const engine = await loadAppBoot();
  if (engine === undefined || typeof engine.composeEntries !== 'function') {
    t.diagnostic('跳过：本机未找到可用的 @deepseek-ai/dsh-app-boot（可设 DSH_APP_BOOT_PATH 或 DSH_APP_ROOT）。');
    return;
  }
  // 用本仓 devDependency 的 js-yaml（与宿主同一解析器），按 ESM 形态取导出
  const yamlMod = await import('js-yaml');
  const yaml = yamlMod.default ?? yamlMod;
  const patchPath = join(HERE, '..', 'cordis.patch.yml');
  const parsed = yaml.load(readFileSync(patchPath, 'utf8'));
  assert.ok(Array.isArray(parsed), 'patch 顶层必须是数组');

  // ① 单独应用：应恰组合出本层这一条，且零告警
  const warn = [];
  const composed = engine.composeEntries([parsed], (m) => warn.push(m));
  assert.deepEqual(warn, [], `组合本层 patch 不应有告警，实际 ${JSON.stringify(warn)}`);
  assert.deepEqual(
    composed,
    [{ id: 'ai-coding-methodology', name: 'ai-coding-methodology' }],
    `本层 patch 应组合出 {id,name} 均为 ai-coding-methodology 的条目，实际 ${JSON.stringify(composed)}`,
  );

  // ② 叠加用户配置（README 里那段）后，两条补丁应能同时成立
  const warn2 = [];
  const composed2 = engine.composeEntries([parsed, [{ id: 'ai-coding-methodology', config: { mountAgents: true } }]], (m) => warn2.push(m));
  assert.deepEqual(warn2, [], '叠加用户补丁不应有告警');
  assert.deepEqual(composed2, [{ id: 'ai-coding-methodology', name: 'ai-coding-methodology', config: { mountAgents: true } }]);
});

test('本层全树无 BOM（含 README/patch 等**非源码**文件；仓库 lint 的扫描面不含它们）', () => {
  // 为什么要有（2026-09-28 第 101 批）：本会话**第三次**因 PowerShell `Set-Content -Encoding UTF8`
  // 给仓库文件写进 BOM（前两次见 §8.82/§8.87）。仓库的 `cp-eol-bom` lint **不含 markdown 文档**，
  // 故 README 这类文件**没有任何机械防线**——只能靠人复查字节，而人会忘。
  // 这条把 `ai-coding-methodology/` 全树（排除 node_modules）纳入 BOM 检查，把"靠记性"换成"靠断言"。
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const buf = readFileSync(p);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        offenders.push(p.slice(join(HERE, '..').length + 1));
      }
    }
  };
  walk(join(HERE, '..'));
  assert.deepEqual(offenders, [], `以下文件带 UTF-8 BOM（仓库口径为无 BOM）：${JSON.stringify(offenders)}`);
  // 反向对照：判据本身有效——构造一个带 BOM 的缓冲必须被同一判据判出
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x', 'utf8')]);
  assert.ok(withBom[0] === 0xef && withBom[1] === 0xbb && withBom[2] === 0xbf, 'BOM 判据应对已知 BOM 成立');
});

test('打包契约：files 白名单**有意不含** plugin-core（引擎随仓不随包，ADR-037 裁决 A）', () => {
  // 为什么要有：批 2 起装载面在 `apply()` 首步经相对路径读取 `<仓库根>/plugin-core`，且
  // **不可得即拒载**（响亮失败、四面不注册）。把 plugin-core 排除在 `files` 之外是**有意的
  // 支持面声明**（README 安装节：只支持 plugin-core 随仓/profile 可用的装法）；若无本断言，
  // 后来者会把"打包漏文件"误当缺陷而顺手把 plugin-core 塞进发布面，反而制造第二份引擎副本
  // （违背单一事实源）。本断言钉住"排除是有意的"，并配合 README 的迁移指引。
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  const files = pkg.files.map((f) => String(f));  assert.ok(
    !files.some((f) => f.includes('plugin-core')),
    'files 白名单不得含 plugin-core：引擎随仓不随包（需要它请用 link 装法）',
  );
  assert.ok(files.includes('src/**/*.mjs'), 'files 须覆盖 src 入口面（新模块随包发布）');
});

test('打包契约：files 白名单必须覆盖入口与 patch，且 patch 路径确实相对包根', () => {
  // 为什么要有：装机时宿主按 `bundlePatchPaths(packageDir, bundle)` = `join(packageDir, patch)`
  // 解析 patch（设计文档 §8.32），而 `packageDir` 是**安装后的包目录**——若 patch 未被
  // `files` 白名单带上，装完就找不到 patch，插件静默不进组合树。这类"发布面漏文件"用
  // 源码测试很难发现，用打包器一查即明。本条把该契约钉住（实测 `npm pack` 9 个文件，
  // 含 `cordis.patch.yml`，2026-09-28 第 55 批）。
  const pkgPath = join(HERE, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const files = pkg.files ?? [];
  assert.ok(Array.isArray(files) && files.length > 0, 'package.json 应有 files 白名单');

  // ① patch 声明存在，且其路径被 files 覆盖
  const patch = pkg.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch 应为字符串路径');
  assert.ok(patch.startsWith('./'), `patch 应写成相对包根的 ./ 形式，实为 ${patch}`);
  const patchRel = patch.replace(/^\.\//, '');
  assert.ok(
    files.includes(patchRel),
    `files 白名单必须含 patch 文件 ${patchRel}，实为 ${JSON.stringify(files)}`,
  );

  // ② 入口声明存在，且其所在目录被 files 覆盖（用 glob 前缀判断，不写死具体 glob 形态）
  const main = pkg.main;
  assert.equal(typeof main, 'string', 'main 应指向入口模块');
  assert.ok(main.startsWith('src/'), `main 应在 src 下，实为 ${main}`);
  assert.ok(
    files.some((f) => f.startsWith('src/')),
    `files 必须覆盖 src 下的入口，实为 ${JSON.stringify(files)}`,
  );

  // ③ patch 文件与入口文件都真实存在（否则白名单写对了也没内容）
  assert.ok(existsSync(join(HERE, '..', patchRel)), `patch 文件应存在：${patchRel}`);
  assert.ok(existsSync(join(HERE, '..', main)), `入口文件应存在：${main}`);

  // ④ 装机通道声明齐备：engines 与 bundle 都在 dsh 命名空间下
  assert.ok(pkg.dsh?.engines?.dsh, 'dsh.engines.dsh 应存在（宿主据此判版本兼容）');
  assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch 应存在（宿主据此找 patch）');
});

test('元数据契约：可发布、可被搜到、介绍说人话（防"名字无语义 + 无介绍"复发）', () => {
  // 为什么要有（2026-09-29 第 106 批）：用户指出包名 `dsh-compat` **完全无法体现功能**，
  // 且缺少功能介绍。根因不是"字段缺失"，而是**名字是自造的类别词、介绍是内部行话**。
  // 本层要发布到 npm，故这几条必须机械守住——靠人记得写，早晚漂回"compat"那种命名。
  const pkgPath = join(HERE, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // ① 可发布：`private: true` 会让 npm 直接拒绝——npm `lib/commands/publish.js` 抛 EPRIVATE，
  //    提示 "Remove the 'private' field from the package.json to publish it."
  assert.notEqual(pkg.private, true, 'package.json 不得含 private:true（会使 npm publish 抛 EPRIVATE）');

  // ② 有介绍：宿主按 npm 约定读 `description` 当插件介绍（官方 bundle 皆如此），
  //    空描述等于"用户看不到这个插件干什么"
  assert.equal(typeof pkg.description, 'string', 'package.json 应有 description');
  assert.ok(pkg.description.trim().length >= 30, `description 应有实质内容，实为 ${JSON.stringify(pkg.description)}`);
  for (const jargon of ['cordis', '拦截扩展点', 'ZCode 钩子声明']) {
    assert.ok(!pkg.description.includes(jargon), `description 不应含内部术语「${jargon}」：${pkg.description}`);
  }

  // ③ 可被搜到：包名是无 scope 的通用词，光看名字看不出"这是 DSH 插件"，
  //    故 keywords 必须带 DSH 标识，否则在 npm 上搜不到
  const keywords = pkg.keywords ?? [];
  assert.ok(Array.isArray(keywords) && keywords.length > 0, 'package.json 应有 keywords');
  assert.ok(
    keywords.some((k) => /dsh|deepseek/i.test(k)),
    `keywords 必须含 DSH 标识（否则 npm 上搜不到本适配层），实为 ${JSON.stringify(keywords)}`,
  );

  // ④ 名字本身要体现功能：不得回到"只说明它是个兼容层"的命名
  assert.ok(/methodology|plugin|adapter|bridge|harness|zcode/i.test(pkg.name), `包名应体现功能，实为 ${pkg.name}`);

  // 反向对照：判据自身有效——对构造的坏元数据，同一判据必须判出
  assert.equal(JSON.parse('{"private":true}').private, true, 'private 判据应能识别 true');
});

test('插件页元数据：`exports` 必须导出宿主读取面（`./package.json` 与 `./locale/*`）', () => {
  // 为什么要有（2026-09-29 第 108 批）：宿主插件管理器**不读 npm `description` 字段**当介绍——
  // `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta(specifier, parentURL)` 用**宿主自己的模块解析器**
  // 解析 `${包名}/package.json`（取 title/description 的回落值）与 `${包名}/locale/*.json`
  // （取本地化文案），而它的 `optionalResourcePath` 把 `ERR_PACKAGE_PATH_NOT_EXPORTED` 当
  // "不存在"吞掉、返回 undefined → `meta` 缺失 → 插件卡片回退成只显示包名、介绍整行不渲染。
  // 本机实测：`ai-coding-methodology/package.json` ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED`；
  // 对照包 `@linxin666/dsh-client-ui-git-graph/package.json` ⇒ 正常解析。
  // 故本包声明了 `exports` 就必须导出这两个子路径；守卫按 Node 的 exports 语义机械复算。
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  const exportsMap = pkg.exports ?? {};

  /**
   * 按 Node 的 `exports` 语义解析一个子路径（本包实际使用的两种形态：精确键与 `*` 模式）。
   * @param {Record<string, unknown>} map exports 映射
   * @param {string} subpath 子路径（形如 `./locale/en.json`）
   * @returns {string|undefined} 目标相对路径；无匹配返回 undefined
   */
  const resolveSubpathIn = (map, subpath) => {
    const direct = map[subpath];
    if (typeof direct === 'string') return direct;
    for (const [key, target] of Object.entries(map)) {
      if (typeof target !== 'string') continue;
      const star = key.indexOf('*');
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.length >= prefix.length + suffix.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        return target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length));
      }
    }
    return undefined;
  };
  const resolveSubpath = (subpath) => resolveSubpathIn(exportsMap, subpath);

  // ① manifest 可达：宿主的 title/description 回落值全部来自这个子路径
  assert.equal(
    resolveSubpath('./package.json'),
    './package.json',
    '`exports` 必须导出 `./package.json`（宿主 readPluginMeta 靠它读 title/description）',
  );
  assert.ok(existsSync(join(HERE, '..', './package.json')), '导出的 manifest 目标文件应存在');

  // ② 本地化文案可达且形态合法：宿主 dictionariesOf 只认 `locale/*.json` 的 meta.title/description，
  //    且 `textOf` 对空串/非字符串**直接抛错**——那会让整份 meta 退化为 {error}，比"没有介绍"更糟
  const localeDir = join(HERE, '..', 'locale');
  const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
  assert.ok(localeFiles.length > 0, '包内应有 locale/*.json（介绍的中文本地化面）');
  for (const file of localeFiles) {
    const target = resolveSubpath(`./locale/${file}`);
    assert.equal(target, `./locale/${file}`, `\`exports\` 必须能解析 ./locale/${file}（宿主按 ${pkg.name}/locale/… 读取）`);
    assert.ok(existsSync(join(HERE, '..', target)), `导出的本地化文件应存在：${target}`);
    const parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8'));
    assert.equal(typeof parsed?.meta?.title, 'string', `${file} 应有 meta.title 字符串`);
    assert.ok(parsed.meta.title.trim() !== '', `${file} 的 meta.title 不得为空`);
    assert.equal(typeof parsed?.meta?.description, 'string', `${file} 应有 meta.description 字符串`);
    assert.ok(parsed.meta.description.trim() !== '', `${file} 的 meta.description 不得为空`);
    // npm 打包面：files 白名单必须收进这些文件，否则装机形态下宿主又读不到
    assert.ok(
      (pkg.files ?? []).some((entry) => entry === `locale/${file}` || entry === 'locale/*.json' || entry === 'locale/*'),
      `package.json 的 files 应覆盖 ${file}`,
    );
  }

  // ③ 反向对照：判据自身有效——旧 exports（不含这两条）在同一个解析函数下必须解析失败
  const legacy = { '.': './src/index.mjs', './log': './src/log.mjs' };
  assert.equal(resolveSubpathIn(legacy, './package.json'), undefined, '旧 exports 应解析不出 ./package.json（守卫据此判红）');
  assert.equal(resolveSubpathIn(legacy, './locale/zh.json'), undefined, '旧 exports 应解析不出 ./locale/zh.json（守卫据此判红）');
  assert.equal(resolveSubpathIn({ './locale/*': './locale/*' }, './locale/zh.json'), './locale/zh.json', '`*` 模式应按 Node 语义替换');
});

// ── B 批（内部任务-5，R-pc-14）：locale 套件标题与 SUITE_NAME 跨源对拍 ──
// 为什么要有：整包展示标题（宿主插件卡片读 locale meta.title）此前自写成「…工作流」，
// 与套件真实标题漂移；套件标题唯一源是 plugin-core/src/product-meta.mjs 的 SUITE_NAME，
// 本地化文件必须与之对拍（跨源测试锁同一事实，不引包外 npm 运行时依赖——仅仓内相对
// 路径动态 import，与 engine-loader 的随仓解析同形态）。
test('B：locale 静态标题与 SUITE_NAME 跨源对拍（套件标题单源，zh/en 两键）', async () => {
  const { SUITE_NAME } = await import(
    pathToFileURL(join(HERE, '..', '..', 'plugin-core', 'src', 'product-meta.mjs')).href
  );
  assert.deepEqual(Object.keys(SUITE_NAME).sort(), ['en', 'zh'], 'SUITE_NAME 恰 zh/en 两键');
  const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8'));
  assert.equal(zh.meta.title, SUITE_NAME.zh, `zh 标题须等于套件常量（实得 ${zh.meta.title} ≠ ${SUITE_NAME.zh}）`);
  assert.equal(en.meta.title, SUITE_NAME.en, `en 标题须等于套件常量（实得 ${en.meta.title} ≠ ${SUITE_NAME.en}）`);
  // locale description 属公开选择说明：不得以内部开发编号代替解释
  const ID_RE = /(ADR-\d+|IF-[A-Z]+-\d+|R-M\d+|B-M\d+|OPEN-\d+)/;
  assert.ok(!ID_RE.test(zh.meta.description ?? ''), 'zh description 零内部编号');
  assert.ok(!ID_RE.test(en.meta.description ?? ''), 'en description 零内部编号');
  // 内部任务-273 H-06（内部模块-24 R-da-7）：code-reviewer 含 Bash，公开文案不得把三 agent 整体表述为只读——
  // 事实源＝README「agent 面」三行表；锁两语描述：禁「只读委派 agent」整段措辞，须体现评审 agent 可执行命令。
  assert.ok(!/只读委派\s*agent/.test(zh.meta.description ?? ''), 'zh description 不得把委派 agent 整体表述为只读');
  assert.ok(/shell|可执行[^。]*命令/.test(zh.meta.description ?? ''), 'zh description 须体现评审 agent 可执行 shell 命令的边界');
  assert.ok(!/read-only delegation agents?/i.test(en.meta.description ?? ''), 'en description 不得把委派 agent 整体表述为只读');
  assert.ok(/shell commands?/i.test(en.meta.description ?? ''), 'en description 须体现评审 agent 可执行 shell 命令的边界');
});
