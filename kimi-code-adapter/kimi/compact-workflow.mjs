// 文件：kimi/compact-workflow.mjs
// 描述：Kimi 宿主 PostCompact 的 workflow 压缩轻量回放（内部任务-297）。
//       Kimi 的 SessionStart 只在 startup|resume 触发；compaction 不重跑元技能注入，
//       而 workflow/hooks/user-prompt.mjs 只注入「去查路由表」的指针、不重灌全文。
//       本脚本只读取包内 skills/workflow/SKILL.md，把全文作为 additionalContext 写入
//       workflow 包自己的待投递队列（workflow 包有 UserPromptSubmit 投递腿），
//       不运行原 SessionStart 的护栏健康自检/归档/nudge。
//       失败极性 fail-open：负载不可读或 SKILL 缺失时写诊断并尽量入队一条降级提醒；
//       非 workflow 包误触发只写诊断（它们没有 UPS 投递腿）。
// 作者：wangp  创建：2026-11-03  版权：MIT（见 workflow/LICENSE）
// 依据：内部模块-17 R-ka-3、内部接口-1 第四宿主差异面 row 1、内部证据

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  clampContext,
  enqueuePending,
  readState,
  readStdin,
  resolvePluginRoot,
  resolveStateDir,
  sessionKeyOf,
  writeDiagnostic,
  writeState,
} from './hook-lib.mjs';

/** 降级提醒文案（workflow 包有 UPS 投递腿，下一次用户消息可见）。 */
const DEGRADED_TEXT = '【压缩回放降级】上下文压缩后未能重投 workflow 元技能；请重新加载 workflow 技能或检查包内 skills/workflow/SKILL.md。';

/**
 * 主流程：读负载与 SKILL.md，把元技能全文入队；失败 fail-open。
 * @returns {Promise<number>} 进程退出码（恒 0）
 */
async function main() {
  const pluginRoot = resolvePluginRoot();
  const stateDir = resolveStateDir(pluginRoot);
  const isWorkflow = basename(pluginRoot) === 'workflow';
  if (!isWorkflow) {
    writeDiagnostic(stateDir, 'PostCompact', '非 workflow 包触发压缩回放，已忽略', '该脚本仅由 workflow 包声明');
    return 0;
  }
  let payload = null;
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = null;
  }
  const sessionKey = sessionKeyOf(payload);
  const enqueue = (text) => {
    const ok = writeState(stateDir, enqueuePending(readState(stateDir), text, sessionKey));
    if (!ok) writeDiagnostic(stateDir, 'PostCompact', '状态写入失败', '检查 KIMI_CODE_HOME/plugin-data 权限');
  };
  const fail = (detail) => {
    writeDiagnostic(stateDir, 'PostCompact', detail, '重新加载 workflow 技能或检查包内 skills/workflow/SKILL.md');
    if (isWorkflow) enqueue(DEGRADED_TEXT);
    return 0;
  };
  if (payload === null) return fail('压缩回放负载不可读');
  let skill = '';
  try {
    skill = readFileSync(join(pluginRoot, 'skills', 'workflow', 'SKILL.md'), 'utf8');
  } catch {
    return fail('skills/workflow/SKILL.md 不可读');
  }
  if (skill.trim() === '') return fail('skills/workflow/SKILL.md 为空');
  enqueue(clampContext(skill));
  return 0;
}

process.exitCode = await main();
