// 文件：run-in-process.mjs
// 描述：scout CLI 测试共享夹具（步骤 6 结构重构，零行为变更）——in-process argv 执行单脚本入口：
//       临时接管 process.argv/exit/stdout/stderr，动态 import 目标脚本触发其 main 分发，恢复现场后
//       返回捕获的退出码与输出。Node 22 测试运行器经 stdout 通道发自身协议帧（V8 结构化克隆 Buffer，
//       内部任务-233 实测；Node 24 窗口内无帧）——帧与被测 CLI 的 string 输出按类型分流：只捕获 string
//       （被测输出恒为字符串），Buffer 帧转发原流（内部未决-231：原实现 return true 吞帧——潜在缺帧，
//       2026-11-06 内部任务-337 修复）。
//       已知约束（S-08/S-09/S-10）：①ESM 缓存——同一测试进程对同一文件二次 runAsMain 不会重跑 main
//       （一个测试文件只测一个入口；需要多入口用不同文件/子进程）；②process.exit 桩只记录不终止，
//       usage 路径会继续执行（断言应看 code 而非仅 exits）；③stdout/stderr 合并进 logs（仅用于
//       覆盖率与存在性断言，流分离断言用子进程）。
// 作者：wangp 创建：2026-10-31 版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { pathToFileURL } from 'node:url';

/**
 * 以 in-process argv 方式执行 CLI 脚本入口一次。
 * @param {string} file 入口脚本绝对路径
 * @param {string[]} [args] CLI 参数（不含 node/脚本本身）
 * @returns {Promise<{code: number|null, logs: string[], exits: number[]}>}
 */
export async function runAsMain(file, args = []) {
  const prevArgv = process.argv;
  const prevExit = process.exit;
  const prevExitCode = process.exitCode;
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  const logs = [];
  const exits = [];
  process.argv = [process.execPath, file, ...args];
  process.exit = (value) => { exits.push(value ?? 0); };
  process.exitCode = undefined;
  const captureTo = (sink) => (chunk, ...rest) => {
    if (typeof chunk === 'string') { logs.push(chunk); return true; }
    return sink(chunk, ...rest); // 运行器协议帧（Buffer）转发原流——不吞帧（内部未决-231）
  };
  process.stdout.write = captureTo(prevOut);
  process.stderr.write = captureTo(prevErr);
  let exitCode = null;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    exitCode = process.exitCode;
    process.argv = prevArgv;
    process.exit = prevExit;
    process.exitCode = prevExitCode;
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
  return { code: exits.length > 0 ? exits[0] : (exitCode === undefined ? null : exitCode), logs, exits };
}
