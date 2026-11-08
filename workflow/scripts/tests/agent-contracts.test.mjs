// 文件：agent-contracts.test.mjs
// 描述：agent 定义文件的机械契约锁（FB-4 批次）——code-reviewer 的只读 git 白名单
//       面：frontmatter tools 须含 Bash（自取 diff 能力），正文须锁定四命令白名单
//       （git diff/status/log/show）与元字符禁令（禁重定向/管道/命令替换）。断言
//       用实现之外的字面量（删 Bash 或删禁令句即红），不引用被测文件的自指常量。
// 作者：wangp  创建：2026-09-18  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；锚点用短语而非整句，容许措辞演进。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
const CODE_REVIEWER = readFileSync(join(AGENTS, 'code-reviewer.md'), 'utf8');

test('code-reviewer frontmatter tools 含 Bash（FB-4：自取工作区 diff 能力）', () => {
  const fm = CODE_REVIEWER.match(/^tools:(.+)$/m);
  assert.ok(fm, 'frontmatter 须有 tools 行');
  const tools = fm[1].split(',').map((s) => s.trim());
  assert.ok(tools.includes('Bash'), 'tools 面须含独立的 Bash（BashOutput 不构成命令执行能力）');
});

test('code-reviewer 正文锁定四命令白名单与元字符禁令', () => {
  // 四命令逐一断言（短语锚点，容许 surrounding 措辞演进）
  for (const cmd of ['git diff', 'git status', 'git log', 'git show']) {
    assert.ok(CODE_REVIEWER.includes(cmd), `正文须点名 ${cmd}`);
  }
  assert.ok(CODE_REVIEWER.includes('重定向'), '正文须含元字符禁令（重定向）');
  assert.ok(CODE_REVIEWER.includes('管道'), '正文须含元字符禁令（管道）');
  assert.ok(CODE_REVIEWER.includes('写面'), '正文须禁写面子命令');
});

// 内部任务-214 批 1 新增（内部验收-4）：code-explorer/code-architect frontmatter 只读约束。
test('agent) code-explorer/code-architect frontmatter 无写工具', () => {
  for (const name of ['code-explorer', 'code-architect']) {
    const text = readFileSync(join(AGENTS, `${name}.md`), 'utf8');
    const fm = text.match(/^tools:(.+)$/m);
    assert.ok(fm, `${name} frontmatter 须有 tools 行`);
    const tools = fm[1].split(',').map((s) => s.trim());
    assert.ok(tools.length >= 1, `${name} tools 清单非空`);
    for (const writeTool of ['Write', 'Edit', 'Bash']) {
      assert.ok(!tools.some((tool) => tool === writeTool), `${name} 不得含写工具：${writeTool}`);
    }
    assert.ok(text.includes('只读'), `${name} 正文须声明只读约束`);
  }
});
