// 文件：tool-families.test.mjs
// 描述：工具族归一表测试（内部任务-8 任务 2.1，内部规则-17）——词表内容断言 + 单源断言（删词即传导，
//       防实现内另藏第二份列表）+ 对拍断言（锚 plugin-core/capability-matrix.json 的
//       hostToolInventory 四宿主列；「非只读写面工具必须命中族」以显式分类清单表达——
//       宿主控制面词（kimi 的 Agent/Cron*/TodoList 等）与只读观察面词归 other 并逐词点名，
//       清单完备性本身即断言：inventory 出现未分类新词即红）。
// 作者：wangp  创建：2026-10-07  版权：MIT（见 workflow/LICENSE）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SHELL_TOOLS, EDIT_TOOLS, familyOf } from '../lib/tool-families.mjs';
// 内部任务-59（内部未决-84）：team-governance 侧同款表（两插件各自独立发行 ⇒ 各持一份副本，本用例锁等值）。
import { SHELL_TOOLS as TG_SHELL_TOOLS, EDIT_TOOLS as TG_EDIT_TOOLS, familyOf as tgFamilyOf } from '../../../team-governance/scripts/lib/tool-families.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('工具族内容断言：词表成员、大小写归一、未识别与空名一律 other 且不抛', () => {
  assert.equal(familyOf('pwsh'), 'shell');
  assert.equal(familyOf('Bash'), 'shell', 'PascalCase 归一（ZCode/Kimi 同名工具）');
  assert.equal(familyOf('POWERSHELL'), 'shell');
  assert.equal(familyOf('edit'), 'edit');
  assert.equal(familyOf('Write'), 'edit');
  assert.equal(familyOf('str_replace_editor'), 'edit', 'DSH 别名形态');
  assert.equal(familyOf('Read'), 'other');
  assert.equal(familyOf('Glob'), 'other');
  assert.equal(familyOf('Skill'), 'other');
  assert.equal(familyOf('TodoWrite'), 'other');
  assert.equal(familyOf(undefined), 'other', '缺工具名 → other（fail-open 分流）');
  assert.equal(familyOf(''), 'other');
  assert.equal(familyOf(null), 'other', '不抛');
  assert.equal(familyOf({}), 'other', '非字符串不抛（String() 兜底）');
  assert.ok(Array.isArray(SHELL_TOOLS) && Array.isArray(EDIT_TOOLS), '词表以数组常量导出（单源消费面）');
});

test('OPEN-89（DEV-46）：ApplyPatch 登记为 edit 族——ZCode 别名写面工具（宿主 0.16.9 WYi 表取证）', () => {
  assert.equal(familyOf('ApplyPatch'), 'edit', 'PascalCase 归一（DEV-18 宿主 bundle 取证：ApplyPatch="file-write"）');
  assert.equal(familyOf('applypatch'), 'edit', '小写形态同族');
  assert.ok(EDIT_TOOLS.includes('applypatch'), '词表成员（单源）');
});

test('跨资产等值（DEV-59/OPEN-84）：team-governance 侧同款表与 workflow 侧逐词等值且判定一致', () => {
  // 两插件各自独立发行（装机态各落独立 cache 目录 ⇒ 跨插件相对导入不成立），故各持一份副本；
  // 本断言即两副本的漂移把守：任一侧改词表（增/删/改名）而未同步另一侧即红。
  assert.deepEqual(TG_SHELL_TOOLS, SHELL_TOOLS, 'shell 词表逐词等值');
  assert.deepEqual(TG_EDIT_TOOLS, EDIT_TOOLS, 'edit 词表逐词等值');
  const samples = [...new Set([...SHELL_TOOLS, ...EDIT_TOOLS, 'read', 'Read', 'grep', 'unknown_tool', ''])];
  for (const t of samples) {
    assert.equal(tgFamilyOf(t), familyOf(t), `两副本对 ${JSON.stringify(t)} 的判定一致`);
  }
});

test('单源断言：familyOf 判定与词表成员资格一一对应，删词即传导（无第二份列表）', () => {
  for (const t of SHELL_TOOLS) assert.equal(familyOf(t), 'shell', `词表成员 ${t} 必须判 shell`);
  for (const t of EDIT_TOOLS) assert.equal(familyOf(t), 'edit', `词表成员 ${t} 必须判 edit`);
  // 删词变异：把词表当唯一判定源——删掉一个词，familyOf 立刻改判 other（若实现内另藏
  // 第二份列表，本断言转红：声明表必须可重放验证，learnings 2026-09-15）
  const removedShell = SHELL_TOOLS.splice(SHELL_TOOLS.indexOf('pwsh'), 1)[0];
  try {
    assert.equal(familyOf('pwsh'), 'other', '删 shell 词表条目后判定随之改判');
  } finally {
    SHELL_TOOLS.push(removedShell);
  }
  const removedEdit = EDIT_TOOLS.splice(EDIT_TOOLS.indexOf('write'), 1)[0];
  try {
    assert.equal(familyOf('write'), 'other', '删 edit 词表条目后判定随之改判');
  } finally {
    EDIT_TOOLS.push(removedEdit);
  }
  assert.equal(familyOf('pwsh'), 'shell', '复原后判定回收');
  assert.equal(familyOf('write'), 'edit', '复原后判定回收');
});

// 对拍面（lead 通扫裁决 1）：hostToolInventory 四宿主列逐词分类——
// MUST_HIT＝写面工具（必须命中 shell/edit 族，逐词点名期望族）；
// ALLOWED_OTHER＝只读观察面 + 宿主控制面词（允许 other，逐词点名来源列）。
// 分类清单是**完备性断言的一部分**：inventory 新增未分类词即红（防宿主漂移静默）。
const MUST_HIT = {
  zcode: { ApplyPatch: 'edit', Bash: 'shell', Edit: 'edit', Write: 'edit' },
  dsh: { pwsh: 'shell', bash: 'shell', edit: 'edit', str_replace_editor: 'edit', write: 'edit' },
  mcode: { bash: 'shell', edit: 'edit', write: 'edit' },
  kimi: { Bash: 'shell', Edit: 'edit', Write: 'edit' },
};
const ALLOWED_OTHER = {
  zcode: ['BashOutput', 'Glob', 'Grep', 'LS', 'Read', 'TodoWrite', 'WebFetch', 'WebSearch'],
  dsh: ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write'],
  mcode: [],
  kimi: [
    'Read', 'Grep', 'Glob', 'ReadMediaFile', 'WebSearch', 'FetchURL',
    'EnterPlanMode', 'ExitPlanMode', 'TodoList', 'Agent', 'AgentSwarm', 'AskUserQuestion',
    'NotifyUser', 'Skill', 'TaskList', 'TaskOutput', 'TaskStop', 'WaitFor',
    'CronCreate', 'CronList', 'CronDelete',
  ],
};

test('对拍断言：hostToolInventory 四宿主列逐词分族，分类清单完备（新增未分类词即红）', () => {
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const inv = matrix?.capabilities?.hostToolInventory;
  assert.ok(inv && typeof inv === 'object', 'hostToolInventory 键在场（对拍锚点）');
  for (const host of ['zcode', 'dsh', 'mcode', 'kimi']) {
    const tools = inv[host];
    assert.ok(Array.isArray(tools) && tools.length > 0, `${host} 列存在且非空`);
    const must = MUST_HIT[host];
    const allowed = ALLOWED_OTHER[host];
    for (const t of tools) {
      if (Object.prototype.hasOwnProperty.call(must, t)) {
        assert.equal(familyOf(t), must[t], `${host} 写面工具 ${t} 必须命中 ${must[t]} 族`);
      } else {
        assert.ok(allowed.includes(t), `${host} 工具 ${t} 未分类——新增/改名须在测试与本表同步登记（防宿主漂移静默）`);
        assert.equal(familyOf(t), 'other', `${host} 非写面工具 ${t} 归 other（静默放行）`);
      }
    }
  }
});

// ── 内部任务-352（2026-11-08）：ask 族归一谓词（内部模块-8 内部规则-8/内部验收-47）──

test('isAskUserQuestionTool：跨宿主 ask 族归一（DEV-352）', async () => {
  const { isAskUserQuestionTool } = await import('../lib/tool-families.mjs');
  for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion', 'ASKUSERQUESTION', 'ask-user-question']) {
    assert.equal(isAskUserQuestionTool(name), true, `${name} 必须命中 ask 族`);
  }
  for (const name of ['pwsh', 'read', '', null, undefined, 'ask']) {
    assert.equal(isAskUserQuestionTool(name), false, `${String(name)} 不得命中`);
  }
});