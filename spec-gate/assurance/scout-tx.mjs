// 文件：scout-tx.mjs
// 描述：Scout 增强桥 node 入口（内部决策-051 运行时归一·阶段1b 消费面切换）——薄 CLI：
//       scout-register/scout-graduate 两子命令（argv 面与 Python cli.py 的两分发面
//       逐字同——bridgeRegister 与 skill 指令行的兼容前提）。子命令名逐字复现
//       Python token（内部任务-86 计划修订 1）。stdout＝indent 2 JSON；退出码对齐 cli.py：
//       0=成功、1=内容阻断（register/graduate 返回 ok:false）、2=参数/工具错误
//       （未知旗标/多余参数/choices 形态/task-id 形态/JSON 解析/fs OSError）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { resolve } from 'node:path';

import { isMainModule } from '../core/validator/core/pycompat.mjs';
import { graduate, register } from './scout_transactions.mjs';

/** 与 cli.py 的 `receipts.TASK_ID_RE` 同形（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；Python `$`
 *  允许单个尾随换行）。终审发现：此前误用 mode-lifecycle 的窄式 TASK_ID_RE，已改回。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\n?$/;
const MODES = ['explore', 'disposable'];
const EVENTS = ['open', 'renew', 'abandon'];
const CMD_FLAGS = {
  'scout-register': ['task-id', 'mode', 'expiry', 'transaction-id', 'event', 'disposition', 'owner', 'project-root'],
  'scout-graduate': ['task-id', 'evidence-refs', 'project-root'],
};

/** 直跑入口守卫（内部任务-241 步骤18 Q10）：isMainModule 单一实现（core pycompat）。 */
const INVOKED_DIRECTLY = isMainModule(import.meta.url);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function usageExit2(msg) {
  process.stderr.write(`${msg}\n用法：node scout-tx.mjs [--project-root <根>] <scout-register|scout-graduate> …（IF-COLLAB-12 v2）\n`);
  return 2;
}

/**
 * CLI 主入口（错误分层对齐 cli.py：JSON 解析/fs OSError/task-id 形态/未知旗标→2；业务 ok:false→1）。
 * @param {string[]} argv @returns {number}
 */
export function main(argv) {
  try {
    return dispatch(argv);
  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write(`scout-tx 工具错误：参数 JSON 非法：${e.message}\n`);
      return 2;
    }
    if (e !== null && typeof e === 'object' && typeof e.code === 'string') {
      process.stderr.write(`scout-tx 工具错误：${e.message}\n`);
      return 2;
    }
    process.stderr.write(`scout-tx：${e.message}\n`);
    return 1;
  }
}

/** argparse 同构解析：`--flag=value` 与 `--flag value` 均受理；缺值/未知旗标由调用方退 2。 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      let name;
      let value;
      if (eq > 2) {
        name = tok.slice(2, eq);
        value = tok.slice(eq + 1);
      } else {
        name = tok.slice(2);
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { error: `旗标 --${name} 缺值` };
        value = argv[i + 1];
        i += 1;
      }
      flags[name] = value;
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

function dispatch(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return usageExit2(parsed.error);
  const { flags, positional } = parsed;
  if (positional.length > 1) return usageExit2(`多余参数：${positional.slice(1).join(' ')}`);
  const cmd = positional[0];
  const allowed = CMD_FLAGS[cmd];
  if (!allowed) return usageExit2(`未知子命令：${cmd ?? '(空)'}`);
  const unknown = Object.keys(flags).find((k) => !allowed.includes(k));
  if (unknown) return usageExit2(`未知旗标：--${unknown}`);
  const root = resolve(flags['project-root'] ?? process.cwd());
  if (cmd === 'scout-register') {
    if (!flags['task-id'] || !flags.mode || !flags.expiry || !flags['transaction-id'] || !flags.event) {
      return usageExit2('scout-register 须 --task-id/--mode/--expiry/--transaction-id/--event');
    }
    // argparse choices 语义：非法枚举是参数错（2），不是内容阻断（1）
    if (!MODES.includes(flags.mode)) return usageExit2(`--mode 须为 ${MODES.join('|')} 之一`);
    if (!EVENTS.includes(flags.event)) return usageExit2(`--event 须为 ${EVENTS.join('|')} 之一`);
    if (!TASK_ID_RE.test(flags['task-id'])) return usageExit2(`--task-id 形态非法：${flags['task-id']}`);
    const r = register(root, flags['task-id'], flags.mode, flags.expiry, flags['transaction-id'], flags.event,
      { disposition: flags.disposition ?? null, owner: flags.owner ?? null });
    emit(r);
    return r.ok ? 0 : 1;
  }
  // scout-graduate
  if (!flags['task-id'] || !flags['evidence-refs']) {
    return usageExit2('scout-graduate 须 --task-id 与 --evidence-refs');
  }
  if (!TASK_ID_RE.test(flags['task-id'])) return usageExit2(`--task-id 形态非法：${flags['task-id']}`);
  // JSON 解析错误→2（cli.py json.loads 同档）；非数组形态由 graduate 前置拒绝（1，零状态变更）
  const refs = JSON.parse(flags['evidence-refs']);
  const r = graduate(root, flags['task-id'], refs);
  emit(r);
  return r.ok ? 0 : 1;
}

if (INVOKED_DIRECTLY) {
  // E01（内部任务-241）：stdout 写后 process.exit 会截断管道输出；改用 exitCode。
  process.exitCode = main(process.argv.slice(2));
}
