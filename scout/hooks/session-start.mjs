// 文件：session-start.mjs
// 描述：scout SessionStart 注入 hook（v3，内部决策-031）——有有效探路模式时注入状态行
//       （第 17/18 行判定输入：explore→spike-run、disposable→disposable-build）；桥
//       缺席时附「本地档运行中」提示；过期时注入到期检查点三选一强提醒（内部规则-6，
//       不阻断）；事务待恢复时提示 mode-lifecycle recover；v2 声明提示一键迁移；
//       声明不可读（T17）与 journal 损坏备份（T2）恒注入处置行；静默态分层诊断
//       （内部任务-89，内部决策-044/内部规则-11）：corrupt/legacy 恒注入诊断行，absent 仅非治理域
//       （无 git 祖先且无 .scout/mode.json 或 .sdd 目录标记——祖先上溯，与 workflow
//       activationRoot 同构）注入轻提醒，仓内/治理域维持静默。
//       T19：所有注入命令用插件根绝对路径（正斜杠构造），不依赖仓库相对布局。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：fail-open——任何异常（含本地模块加载失败）静默退出 0（hooks 姿态，硬规则 4）；
//       信封事件名必须与事件一致；不读宿主负载（对照 workflow/hooks/session-start.mjs 先例，
//       SessionStart 注入不依赖 stdin 内容——R4 判定走 projectRoot() env/cwd 兜底链）。
// 用法：宿主经 hooks.json 注册调用；--selftest 冒烟自检（失败可见：诊断入口不静默）。

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// T19：注入命令一律使用插件根绝对路径 + `--project-root '<项目根>'`（正斜杠/单引号）；
// 相对仓库路径在装机布局下断裂，缺 --project-root 时粘贴命令会按 cwd 误操作其他项目。
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');
const CLI_REL = `${PLUGIN_ROOT}/scripts/mode-lifecycle.mjs`;
/** 单引号 shell 转义（路径含 ' 时闭合/重开；$、反引号、\ 在单引号内失效）。 */
function sq(v) {
  return String(v).replaceAll("'", "'\\''");
}
/** 构造可粘贴的 lifecycle 命令（绝对入口 + 项目根 + 子命令）。 */
function cli(sub, root) {
  return `node '${sq(CLI_REL)}' --project-root '${sq(root)}' ${sub}`;
}

/**
 * 从宿主环境取项目根（兜底链与 spec-gate session-start.mjs 对齐：多宿主预留）。
 * @returns {string}
 */
function projectRoot() {
  return process.env.ZCODE_PROJECT_DIR || process.env.QODER_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * R4（内部决策-044）：absent 轻提醒适用判定——与 workflow activationRoot **同构语义**（内部任务-89）：
 * 祖先上溯查 .git（文件或目录，含 worktree 形态）∪ .scout/mode.json ∪ .sdd 目录（statSync 辨析），
 * 至不动点（dirname(d)===d，兼容盘符根/UNC）全不命中 → 非治理域=提醒适用。
 * 跨插件 import 禁止（装机布局下插件为独立包，仓相对路径在装机态断裂）；内部非功能需求-1 零第三方。
 * 漂移哨兵：routing-lib.mjs gitAncestor/isMarkerRoot 处反向注记（内部任务-89）。
 * 判定异常 → 返回 false（抑制提醒，回落现状静默=最小意外 fail-open 方向）。
 * @param {string} root 项目根（projectRoot() env 链取值）
 * @returns {boolean} 是否适用 absent 轻提醒
 */
function scoutNudgeApplies(root) {
  try {
    let d = String(root);
    for (;;) {
      if (existsSync(join(d, '.git'))) return false;
      if (existsSync(join(d, '.scout', 'mode.json'))) return false;
      try {
        if (statSync(join(d, '.sdd')).isDirectory()) return false;
      } catch {
        /* .sdd 缺席或非目录：继续上溯 */
      }
      const up = dirname(d);
      if (up === d) return true;
      d = up;
    }
  } catch {
    return false; // 判定异常：抑制（现状静默）
  }
}

/**
 * 主流程：加载 mode-state → 读模式状态 → 拼注入文本 → 输出信封。
 * 本地模块的动态 import 在本函数内进行——放顶层会使加载失败绕过 fail-open 保护。
 * @returns {Promise<void>}
 */
async function main() {
  // 相对说明符按本模块 URL 解析（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME，
  // 而该异常会被下方 fail-open 静默吞掉——Windows 上注入会整体失效且全程无信号）
  const { readStatus } = await import('../scripts/mode-state.mjs');
  const root = projectRoot();
  const state = readStatus(root);
  let context = '';
  if (state.pendingRecovery) {
    context =
      `【scout 事务待恢复】（项目根 ${root}）检测到生命周期事务中断残留：运行 ${cli('recover', root)} 恢复；` +
      '恢复完成前按无模式处理（全量门禁，fail-safe，ADR-031）。';
  } else if (state.valid) {
    const entry = state.mode === 'explore' ? 'spike-run（第 17 行）' : 'disposable-build（第 18 行）';
    context =
      `【scout 探路模式】当前模式 ${state.mode}，到期 ${state.expiry}；` +
      `未命中路由表其余 15 行时命中 ${entry}；到期检查点三选一见 scout 元技能（ADR-031）。`;
    if (!state.bridgeAvailable) {
      context += '本地档运行中：中央台账登记与毕业不可用（spec-gate 桥缺席）；模式不受影响，桥可用后经 sync 补登。';
    }
  } else if (state.overdue) {
    context =
      `【scout 到期检查点】（项目根 ${root}）探路模式（${state.mode}）已于 ${state.expiry} 到期且未作三选一裁决：` +
      `继续（${cli('renew', root)}；v2 声明不可续期，需先处理版本）/ 毕业（scout 元技能——spec-gate 桥编排，桥缺席不可用）/ ` +
      `放弃归档（${cli('abandon', root)}；过期 v2 声明不可迁移，放弃后可重新开启）；本提醒不阻断任何操作（R-M9-6）。`;
  } else if (state.reason === 'migratable-v2') {
    context =
      `【scout v2 声明待迁移】（项目根 ${root}）检测到 v2 模式声明（mode=${state.mode}，到期 ${state.expiry}）：` +
      `运行 ${cli('migrate-v2', root)} 一键迁移 v3（保留模式/到期日/任务号）；迁移前按无模式（全量门禁）。`;
  } else if (state.reason === 'unreadable') {
    context =
      `【scout 声明不可读】（项目根 ${root}）.scout/mode.json 存在但读取失败（errno=${state.errno ?? 'unknown'}）——按无模式处理（全量门禁 fail-safe，R-M9-2/T17）；` +
      '处置：检查文件权限/占用后重试；无法恢复时运行 ' + cli('recover', root) + '，或删除后重新开启（' + cli('open', root) + '）。';
  } else if (state.reason === 'corrupt') {
    context =
      `【scout 声明损坏】（项目根 ${root}）.scout/mode.json 不可解析或字段非法——按无模式处理（全量门禁 fail-safe，R-M9-2）；` +
      '处置：修复后重新开启（' + cli('open', root) + ' 覆盖旧声明）或删除该文件。';
  } else if (state.reason === 'legacy') {
    context =
      `【scout 旧版声明】（项目根 ${root}）检测到 v1 模式声明（mode=${state.mode}，到期 ${state.expiry}）——v1 不支持自动迁移，` +
      '按无模式处理（全量门禁 fail-safe）；请删除后按 v3 重新开启（' + cli('open', root) + '）。';
  } else if (state.reason === 'absent' && scoutNudgeApplies(root)) {
    context =
      `【scout 未开启】（项目根 ${root}）无模式声明，且该根无 git 祖先、无治理标记：若本任务呈探索性/一次性交付特征` +
      '（探针、临时脚本、单次工具），可考虑开启 scout 低纪律模式（opt-in：与用户确认 mode 与 expiry，' +
      cli('open --mode explore|disposable --expiry <到期日> --task-id <任务号>', root) + '）；' +
      '特征不符请忽略本行（全量纪律照常）。';
  }
  // T2：journal 损坏备份提示行（与模式状态无关，恒注入；内部决策-065 T2/T4）
  if (state.journalCorrupt) {
    const journalLine = `【scout journal 损坏备份待处理】（项目根 ${root}）检测到 .scout/transactions/journal.corrupt-*：人工核对后删除备份；备份不阻塞本地模式（ADR-065 T2/T4）。`;
    context = context ? `${context}\n${journalLine}` : journalLine;
  }
  if (!context) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }) + '\n'
  );
}

if (process.argv.includes('--selftest')) {
  // 冒烟：验证本地模块可加载、readStatus 可调用。失败必须可见（非 0 + 判读行）——
  // 静默退 0 会让"只查退出码"的调用方（发布验证集、人工冒烟）把失效当通过；
  // hook 运行态仍是 fail-open（下方 else 分支），本处只收紧诊断入口。
  import('../scripts/mode-state.mjs')
    .then(({ readStatus }) => {
      const s = readStatus(process.cwd());
      process.stdout.write(`SELFTEST OK session-start (${s.valid ? 'mode-on' : 'no-mode'})\n`);
    })
    .catch((e) => {
      process.stdout.write(`FAIL session-start selftest：本地模块加载失败（${e?.code ?? e}）\n`);
      process.exit(1);
    });
} else {
  main().catch(() => process.exit(0)); // fail-open：提醒永不阻断
}
