// 文件：tool-families.test.mjs
// 描述：team-governance 侧工具族归一表测试（内部任务-59，内部未决-84）——本插件单跑套件时即可发现
//       词表漂移：①词表内容与大小写归一语义；②单源断言（删词即传导，防实现内另藏第二份列表）；
//       ③对拍断言（锚 plugin-core/capability-matrix.json 的 hostToolInventory 四宿主列，分类
//       清单完备性本身即断言：出现未分类新词即红）。跨资产等值（本表 ≡ workflow 侧同款表）
//       由 workflow/scripts/tests/tool-families.test.mjs 的对应用例把守（两侧各持一份副本）。
// 作者：wangp  创建：2026-10-13  版权：MIT（见 team-governance/LICENSE）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SHELL_TOOLS, EDIT_TOOLS, familyOf } from '../lib/tool-families.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('工具族内容断言：词表成员、大小写归一、未识别与空名一律 other 且不抛', () => {
  assert.equal(familyOf('pwsh'), 'shell');
  assert.equal(familyOf('Bash'), 'shell', 'PascalCase 归一（ZCode/Kimi 同名工具）');
  assert.equal(familyOf('edit'), 'edit', 'DSH/MCode 小写形态（OPEN-84 的判别面）');
  assert.equal(familyOf('write'), 'edit');
  assert.equal(familyOf('Edit'), 'edit');
  assert.equal(familyOf('Write'), 'edit');
  assert.equal(familyOf('str_replace_editor'), 'edit', 'DSH 别名形态');
  assert.equal(familyOf('ApplyPatch'), 'edit', 'ZCode 写面别名');
  assert.equal(familyOf('read'), 'other', '只读观察面不入护栏面');
  assert.equal(familyOf('Read'), 'other');
  assert.equal(familyOf(undefined), 'other', '缺工具名 → other（fail-open 分流）');
  assert.equal(familyOf(''), 'other');
  assert.equal(familyOf(null), 'other', '不抛');
  assert.equal(familyOf({}), 'other', '非字符串不抛（String() 兜底）');
  assert.ok(Array.isArray(SHELL_TOOLS) && Array.isArray(EDIT_TOOLS), '词表以数组常量导出（单源消费面）');
});

test('单源断言：familyOf 判定与词表成员资格一一对应，删词即传导（无第二份列表）', () => {
  for (const t of SHELL_TOOLS) assert.equal(familyOf(t), 'shell', `词表成员 ${t} 必须判 shell`);
  for (const t of EDIT_TOOLS) assert.equal(familyOf(t), 'edit', `词表成员 ${t} 必须判 edit`);
  const removedEdit = EDIT_TOOLS.splice(EDIT_TOOLS.indexOf('write'), 1)[0];
  try {
    assert.equal(familyOf('write'), 'other', '删 edit 词表条目后判定随之改判');
  } finally {
    EDIT_TOOLS.push(removedEdit);
  }
  assert.equal(familyOf('write'), 'edit', '复原后判定回收');
});

// 对拍面：hostToolInventory 四宿主列逐词分类（与本仓 workflow 侧同名清单同口径，
// 分类清单是完备性断言的一部分：inventory 出现未分类新词即红，防宿主漂移静默）。
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
