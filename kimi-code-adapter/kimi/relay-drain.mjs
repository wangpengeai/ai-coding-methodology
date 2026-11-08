// 文件：kimi/relay-drain.mjs
// 描述：四包观察面帧的 UserPromptSubmit 投递腿（内部任务-302 / 内部未决-269）。
//       spec-gate / scout / team-governance / algo-loop 的 SessionStart / PostToolUse /
//       PostToolUseFailure / Stop 帧落在**本包** relay-state.json；本脚本在每次提示把
//       当前会话的待投递帧取出并以纯文本打印（宿主 UPS 返回文本追加进上下文）。
//       策略单源：会话过滤、容量淘汰通告与计数清零全部交引擎 `stop-pending-relay`
//       （与 hook-shim 的 UPS 分支同规则、同端口），本脚本不自行实现。
//       投递原语与 shim 共用 `hook-lib.drainRelayForPrompt`；早退与失败面仍属本腿。
//       早退：文件级空队列且无淘汰计数时直接 exit 0（不装载引擎、不写盘）。
//       失败面两档：workflow shim 维持 R-ka-11 的 UPS 诊断直给；本腿为「零输出 + 诊断日志」
//       （投递的是诊断的诊断，二次注入无收益；帧留队下次重试）。
// 作者：wangp  创建：2026-11-03  版权：MIT（见 workflow/LICENSE）
// 依据：内部模块-17 R-ka-3/R-ka-11、内部接口-1 第四宿主差异面 row 1、内部未决-269

import { pathToFileURL } from 'node:url';

import {
  clampContext,
  createRelayPorts,
  drainRelayForPrompt,
  readState,
  readStdin,
  RELAY_CONTRACT_DRIFT,
  resolvePluginRoot,
  resolveStateDir,
  sessionKeyOf,
  writeDiagnostic,
} from './hook-lib.mjs';

/** 包内引擎入口（随包物化；与 hook-shim 同形态）。 */
const ENGINE_REL = 'plugin-core/src/engine.mjs';

/** 恢复指引（诊断行）。 */
const RECOVERY = '重跑 `node kimi-code-adapter/cli.mjs install` 后复核包内 plugin-core';

/**
 * 主流程：早退 → 引擎投递 → 打印；任何失败零输出 + 诊断，恒 exit 0。
 * @returns {Promise<number>} 进程退出码（恒 0）
 */
async function main() {
  const pluginRoot = resolvePluginRoot();
  const stateDir = resolveStateDir(pluginRoot);
  let payload = null;
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = null;
  }
  const sessionKey = sessionKeyOf(payload);
  const state = readState(stateDir);
  // 早退须含连击维度：否则该包的连击预算永不被 `deliverOn` 归零（新增 Stop 钩子即失效）
  // （内部任务-347：多会话字典——任一字典非空即不早退）
  const hasStreaks = Object.keys(state.streaks ?? {}).length > 0;
  const hasDropped = Object.keys(state.droppedBySession ?? {}).length > 0;
  if (state.frames.length === 0 && !hasStreaks && !hasDropped) return 0;
  let engine = null;
  try {
    const { loadEngine } = await import(pathToFileURL(`${pluginRoot}/${ENGINE_REL}`).href);
    engine = loadEngine(pluginRoot);
  } catch (error) {
    writeDiagnostic(stateDir, 'UserPromptSubmit', `投递腿引擎不可用：${error instanceof Error ? error.message : String(error)}`, RECOVERY);
    return 0;
  }
  const ports = createRelayPorts(stateDir, 'UserPromptSubmit');
  let text = '';
  try {
    text = drainRelayForPrompt({ engine, sessionKey, stateDir, ports });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const kind = error && typeof error === 'object' && error.code === RELAY_CONTRACT_DRIFT
      ? '投递腿规则库字段契约漂移'
      : '投递腿引擎异常';
    writeDiagnostic(stateDir, 'UserPromptSubmit', `${kind}：${detail}`, RECOVERY);
    return 0;
  }
  if (text !== '') process.stdout.write(`${clampContext(text)}\n`);
  return 0;
}

process.exitCode = await main();
