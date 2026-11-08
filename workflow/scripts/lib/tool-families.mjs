// 文件：tool-families.mjs
// 描述：工具族归一表单源（内部任务-8，内部规则-17；B-M8-3 同款：词表是脚本资产，skill 正文只引用）。
//       词表锚点：plugin-core/capability-matrix.json 的 hostToolInventory（各宿主写面工具名全集，
//       含 PascalCase 形态）——判定一律小写归一后比较（Kimi/ZCode 的 Edit/Write 与 DSH 的
//       edit/write 同族）。消费方：routing-gate / check-careful / check-freeze 的钩内分流：
//       非目标族**静默放行**（唯一理由是漂移防护——防未来宿主给 edit 族负载也带 command 字段，
//       或给 shell 族负载也带 file_path 字段时护栏误拦；fail-open 姿态不破）。
//       未识别工具名 → 'other'（不抛）；空名/undefined → 'other'。
//       **设计语义（内部任务-8 门 A 发现 F3 处置，2026-10-07）**：词表**外**的已命名工具一律归
//       'other' 并静默放行（fail-open 方向，内部规则-17 ①「工具识别收进钩内」的显式取舍）——
//       词表是**白名单**而非黑名单：新增宿主工具名须经本文件登记才进族，未登记即为「不判定」；
//       方向选择理由＝①避免在钩内另建第二判定源（词表外按 command/file_path 猜测族＝第二判定源）；
//       ②漏判的代价是「该工具不被护栏覆盖」而非误拦；③漂移由 tool-families.test.mjs 的
//       hostToolInventory 分类完备性断言把守（新增宿主工具名未分类即红）。
// 作者：wangp  创建：2026-10-07  版权：MIT（见 workflow/LICENSE）

/** shell 族工具名词表（小写；判定前归一）。 */
export const SHELL_TOOLS = ['bash', 'pwsh', 'powershell', 'sh', 'cmd', 'zsh'];

/** edit 族工具名词表（小写；判定前归一）。applypatch＝ZCode OpenAI 能力面别名
 *  （宿主 0.16.9 WYi 表＋matcher 别名面 bZs，内部任务-18 取证，内部未决-89）。 */
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

/**
 * ask 族工具名归一判据（内部任务-352，内部模块-8 内部规则-8/内部验收-47）：AskUserQuestion 答复是 tool result 通道，
 * 与 shell/edit 写面族无关，故独立谓词而不扩 familyOf 闭集（避免改变 routing-gate 等消费方语义）。
 * 宿主中立：小写去非字母后等值 `askuserquestion`（覆盖 AskUserQuestion / ask_user_question / askUserQuestion）。
 * @param {unknown} toolName 宿主负载中的工具名
 * @returns {boolean}
 */
export function isAskUserQuestionTool(toolName) {
  return String(toolName ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'askuserquestion';
}
