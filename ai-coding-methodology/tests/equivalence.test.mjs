// 文件：逐点等价用例（批 2 阶段 2；批 3 步骤 14② 补齐至 7 面）
// 描述：消费点改引擎驱动后，「引擎输出 ≡ 旧实现输出快照」的钉桩断言。快照值取自接线前的
//       手写实现（批 1 已用 15 组输入对拍引擎与旧实现：0 差异），此处固化为回归基线——
//       后续任何引擎/数据变更若改变这些值，即为行为漂移，必须显式评审而非静默通过。
// 作者：wangp 创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：node --test "tests/equivalence.test.mjs"
// 自检：本文件即自检
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPayload, decodeHookOutput, normalizeMatcher } from '../src/hooks-bridge.mjs';
import { normalizeSessionSource } from '../src/index.mjs';
import { renderCommandBody } from '../src/commands-bridge.mjs';
import { skillNameOf } from '../src/skills-bridge.mjs';
import { buildToolFilter } from '../src/agents-bridge.mjs';
import { testEngine } from './helpers/engine-binding.mjs';

testEngine(); // 纯函数面直调，须先绑定（与 apply() 同一 ensureBound 入口）

// 步骤 4：matcher 展开（tool-vocab-map）——旧 TOOL_ALIASES 展开快照
const MATCHER_SNAPSHOT = [
  ['Bash|Edit', 'pwsh|bash|Bash|edit|str_replace_editor|Edit'],
  ['Foo|Bash', 'Foo|pwsh|bash|Bash'],
  ['Bash|Bash', 'pwsh|bash|Bash'],
  ['Edit', 'edit|str_replace_editor|Edit'],
  ['Write', 'write|Write'],
  ['Foo', 'Foo'],
  ['', undefined],
  ['*', undefined],
  ['|', undefined],
  ['  ', undefined],
  [123, undefined],
  [undefined, undefined],
];

test('等价面：normalizeMatcher ≡ 旧实现快照（12 组输入，含边界与非法类型）', () => {
  for (const [input, expected] of MATCHER_SNAPSHOT) {
    assert.equal(normalizeMatcher(input), expected, `输入 ${JSON.stringify(input)} 的输出与旧实现快照不一致`);
  }
});

// 步骤 7a：命名空间（namespace-transform）——旧 kebab 前缀实现快照（先对旧实现取值，再切引擎）
const SKILL_NAME_SNAPSHOT = [
  [['workflow', 'gate'], 'workflow-gate'],
  [['spec-gate', 'gate'], 'spec-gate-gate'],
  [['Workflow', 'Gate'], 'workflow-gate'],
  [['workflow', 'a_b'], 'workflow-a-b'],
  [['__', 'x'], 'x'],
  [['', 'gate'], 'gate'],
  [['workflow', '__'], ''],
  [['workflow', '中文'], ''],
];

test('等价面：skillNameOf ≡ 旧实现快照（8 组输入，含非法/空形态）', () => {
  for (const [[plugin, dir], expected] of SKILL_NAME_SNAPSHOT) {
    assert.equal(skillNameOf(plugin, dir), expected, `(${plugin}, ${dir}) 的命名的与旧实现快照不一致`);
  }
});

// 步骤 6：会话来源归一（source-widen-normalize）——旧内联白名单快照
const SESSION_SOURCE_SNAPSHOT = [
  ['startup', 'startup'],
  ['resume', 'resume'],
  ['clear', 'clear'],
  ['compact', 'compact'],
  ['fork', 'startup'],
  ['', 'startup'],
  [undefined, 'startup'],
  [123, 'startup'],
];

test('等价面：normalizeSessionSource ≡ 旧实现快照（8 组输入，含未接受值与非法类型）', () => {
  for (const [input, expected] of SESSION_SOURCE_SNAPSHOT) {
    assert.equal(normalizeSessionSource(input), expected, `输入 ${JSON.stringify(input)} 的归一结果与旧实现快照不一致`);
  }
});

// 步骤 5b：信封面——`message-slot-migration` 的读取序（`permissionDecisionReason` → `systemMessage`）
// 旧实现在 `hooks-bridge.decodeHookOutput` 内联做 `hso.permissionDecisionReason ?? hso.systemMessage`；
// 接线后由规则 `params.dsh.readPriority` 提供，快照值取自接线前后实跑一致的三态。
const SLOT_SNAPSHOT = [
  [{ hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: 'SM' }, 'SM', '仅 systemMessage ⇒ 读它（否则 deny 会退化为默认串、文案丢失）'],
  [{ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'PDR', systemMessage: 'SM' }, 'PDR', '两者都在 ⇒ permissionDecisionReason 优先'],
  [{ hookEventName: 'PreToolUse', permissionDecision: 'allow' }, undefined, '都无 ⇒ 不产出 reason 键'],
];

test('等价面：信封面槽位读取序 ≡ 旧实现快照（3 组）', () => {
  for (const [specific, expected, why] of SLOT_SNAPSHOT) {
    const out = decodeHookOutput(0, JSON.stringify({ hookSpecificOutput: specific }), '', 'PreToolUse');
    assert.equal(out.decision, specific.permissionDecision);
    assert.equal(out.reason, expected, why);
    // 注：返回对象**恒有** `reason` 键（值为 undefined），故判据取"值未定义"而非"键不存在"
    if (expected === undefined) assert.equal(out.reason, undefined, '无槽位时 reason 必须为 undefined（不得产出空串）');
  }
});

// 步骤 5a：失败事件合并——合成的 `tool_result` 键集与常量位（`failure-event-merge.constants.stderr === ''`）
test('等价面：合成的 tool_result 键集与 stderr 常量位 ≡ 旧实现快照（3 组事件）', () => {
  // 合成面**只发生在 PostToolUse**（其余事件不带 `tool_result`）——旧实现同此，勿外推。
  const post = buildPayload('PostToolUse', {});
  assert.deepEqual(Object.keys(post.tool_result).sort(), ['is_error', 'stderr', 'stdout'], 'PostToolUse：合成 tool_result 的键集');
  assert.equal(post.tool_result.is_error, false);
  assert.equal(post.tool_result.stderr, '', 'constants.stderr 恒为空串（本宿主不渲染退出标记，见 OPEN-49）');
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.equal(buildPayload(event, {}).tool_result, undefined, `${event} 不带合成 tool_result`);
  }
});

// 步骤 6e：声明源事件允许表——`(静态表[event] ∩ D_root) ∪ {event}`
// 「只有真的声明了 `PostToolUseFailure` 的根」才采信该信封；未声明即拒（反向证明声明来源）。
const ENVELOPE = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'CTX' } });

test('等价面：声明源事件允许表 ≡ 旧实现快照（3 组）', () => {
  const notDeclared = decodeHookOutput(0, ENVELOPE, '', 'PostToolUse', { allowedEvents: new Set(['PostToolUse']) });
  assert.equal(notDeclared.additionalContext, undefined, '未声明该事件 ⇒ 信封被拒（不得采信）');
  const declared = decodeHookOutput(0, ENVELOPE, '', 'PostToolUse', { allowedEvents: new Set(['PostToolUse', 'PostToolUseFailure']) });
  assert.equal(declared.additionalContext, 'CTX', '已声明 ⇒ 采信');
  const noFilter = decodeHookOutput(0, ENVELOPE, '', 'PostToolUse');
  assert.equal(noFilter.additionalContext, 'CTX', '缺省不过滤（兼容回落根与既有装配级用例的行为基线）');
});

// 步骤 7b：followup 三态——`followup-expansion` 的渲染语义（**仅 trim 入参**、正文原样替换）
// 旧实现在 `renderCommandBody` 内联做替换；接线后由规则 `params.dsh` 提供，快照值取自实跑三态。
const FOLLOWUP_SNAPSHOT = [
  ['正文 $ARGUMENTS 结束', 'X', '正文 X 结束', '占位符被替换（原样保留两侧文本）'],
  ['无占位符', 'X', '无占位符', '无占位符 ⇒ 原样返回，不追加参数'],
  ['  $ARGUMENTS  ', undefined, '    ', '仅占位符 + 无入参 ⇒ 替换后**正文原样**（首尾空白属正文；旧实现不整体 trim）'],
];

test('等价面：followup 渲染三态 ≡ 旧实现快照（3 组）', () => {
  for (const [body, rawInput, expected, why] of FOLLOWUP_SNAPSHOT) {
    assert.equal(renderCommandBody(body, rawInput), expected, why);
  }
});

// 步骤 8：agent 面四态——`agent-default-off-fail-closed` 的挂载极性判定
// 旧实现在 `buildToolFilter` 内联做 fail-closed；接线后由规则 `params.dsh` 提供。
test('等价面：agent 面工具过滤四态 ≡ 旧实现快照（4 组）', () => {
  assert.equal(buildToolFilter([]), null, '空工具集 ⇒ 不产出过滤面');
  assert.equal(buildToolFilter(['Read', 'Bash', 'Write'], { available: ['Bash', 'Write'] }), null,
    '限制清单与候选**无交集**（此处故意用 ZCode 词表 ⇒ 交集空）⇒ fail-closed 返回 null');
  assert.equal(buildToolFilter(['Bash'], { available: [] }), null, '目录为空 ⇒ fail-closed');
  assert.deepEqual(buildToolFilter(['Read', 'Bash', 'Write'], { available: ['bash', 'write'] }), { allow: ['bash'] },
    '宿主词表且与候选有交集 ⇒ 产出交集 allow（write 不在候选内，不臆造）');
  assert.deepEqual(buildToolFilter(['Read', 'Bash', 'Write']), { allow: ['read', 'pwsh', 'bash'] },
    '缺省不传限制清单 ⇒ 以候选自身充作目录（等价旧实现"不过滤"）');
});
