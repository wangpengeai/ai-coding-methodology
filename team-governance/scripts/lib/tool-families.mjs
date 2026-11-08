// 文件：tool-families.mjs
// 描述：工具族归一表单源（内部任务-59，内部未决-84）——team-governance 侧副本。
//       为什么需要它：本插件的 PreToolUse 便利护栏（内部规则-6）原先以 ZCode 的 PascalCase
//       字面量（'Edit'/'Write'/'Bash'）判定工具名，而 DSH 与 MiniMax Code 的宿主原生名是
//       小写（edit/write/pwsh/bash）⇒ 钩体静默退 0、护栏在这两宿主整体空转（matcher 侧由
//       适配层 `tool-vocab-map` 归一已通，见 内部任务-59 步骤 1.1 证据）。判定改为**大小写归一
//       后的族成员资格**，四宿主形态同族。
//       词表锚点：`plugin-core/capability-matrix.json` 的 hostToolInventory（各宿主工具名全集）；
//       词表**外**的已命名工具一律归 'other' 并静默放行（白名单而非黑名单：漏判的代价是
//       "该工具不被本护栏覆盖"，而非误拦；漂移由两侧对拍测试把守——team-governance 侧
//       本目录 tests/tool-families.test.mjs，跨资产等值断言在 workflow 侧）。
//       与 workflow/scripts/lib/tool-families.mjs 同形（同词表同语义）：两插件各自独立发行
//       （装机态各落独立 cache 目录，跨插件相对导入不成立），故各自持一份、由测试锁等值。
// 作者：wangp  创建：2026-10-13  版权：MIT（见 team-governance/LICENSE）

/** shell 族工具名词表（小写；判定前归一）。 */
export const SHELL_TOOLS = ['bash', 'pwsh', 'powershell', 'sh', 'cmd', 'zsh'];

/** edit 族工具名词表（小写；判定前归一）。applypatch＝ZCode OpenAI 能力面别名（宿主取证见 内部任务-18）。 */
export const EDIT_TOOLS = ['edit', 'write', 'str_replace_editor', 'applypatch'];

/**
 * 工具名 → 族（'shell' | 'edit' | 'other'）。大小写归一后按词表成员资格判定。
 * @param {unknown} toolName 宿主负载中的工具名
 * @returns {'shell'|'edit'|'other'} 族名（未识别/空名一律 'other'，不抛）
 */
export function familyOf(toolName) {
  const t = String(toolName ?? '').toLowerCase();
  if (SHELL_TOOLS.includes(t)) return 'shell';
  if (EDIT_TOOLS.includes(t)) return 'edit';
  return 'other';
}
