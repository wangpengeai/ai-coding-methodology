// 文件：git-exec.mjs
// 描述：workflow 内**按 stderr 文案分类**的两处 git 调用（task-lease-lib 占用源三态、
//       retro-metrics 空仓判定）的统一执行入口（内部任务-345）——固定 C locale 使错误文案稳定为英文，
//       调用方在任意宿主 locale 下得到同一判定。git 的 stdout 契约（%s/%aI/--numstat/
//       ls-files/--porcelain）与 locale 无关，固定 locale 不改这些输出。
//       为什么集中在一处：本轮缺陷根因是两处各自依赖「宿主 locale 是英文」的隐含假设。
//       边界：仓内另有 7 个模块的 8 处 git spawn（write-guard×2/check-careful/write-audit/deliver-export/
//       revision/check-repo-consistency/git-ref-lease）只解析 status/stdout，不依赖文案，
//       本批不迁移；将来若要新增「按 stderr 文案分类」的 git 调用，必须经本模块。
// 作者：wangp  创建：2026-11-06  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';

/** git 错误文案判定的 locale 前提（gettext 优先级 LC_ALL > LC_MESSAGES > LANG）。 */
export const GIT_C_LOCALE_ENV = Object.freeze({ LC_ALL: 'C', LANG: 'C' });

/**
 * 构造 git 子进程环境：基础环境展开后**最后**覆盖 locale（顺序反了会被宿主 locale 反杀）。
 * @param {Record<string, string | undefined>} [base] 基础环境（缺省 process.env）
 * @returns {Record<string, string | undefined>}
 */
export function gitSpawnEnv(base = process.env) {
  return { ...base, ...GIT_C_LOCALE_ENV };
}

/**
 * 解析 git 可执行命令：`WF_GIT_BIN` 注入口（内部规则-25 登记测试缝）；以 `.mjs` 结尾时
 * 经 process.execPath 执行（fake git 夹具约定）。
 * @param {Record<string, string | undefined>} [env] 环境注入缝（缺省 process.env）
 * @returns {{command: string, argvPrefix: string[]}}
 */
export function resolveGitCommand(env = process.env) {
  const bin = env.WF_GIT_BIN || 'git';
  return typeof bin === 'string' && bin.endsWith('.mjs')
    ? { command: process.execPath, argvPrefix: [bin] }
    : { command: bin, argvPrefix: [] };
}

/**
 * 统一的 git spawn：encoding=utf8＋C locale；cwd/timeoutMs/maxBuffer **传入才下发**
 * （不给调用方注入默认预算——retro-metrics 的大仓 git log 与钩子的 2s 预算不同）。
 * @param {string[]} args git 参数
 * @param {{cwd?: string, timeoutMs?: number, maxBuffer?: number, envBase?: Record<string, string | undefined>}} [opts]
 * @returns {ReturnType<typeof spawnSync>}
 */
export function spawnGitSync(args, opts = {}) {
  const envBase = opts.envBase ?? process.env;
  const { command, argvPrefix } = resolveGitCommand(envBase);
  const spawnOpts = { encoding: 'utf8', env: gitSpawnEnv(envBase) };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
  if (Number.isSafeInteger(opts.timeoutMs)) spawnOpts.timeout = opts.timeoutMs;
  if (Number.isSafeInteger(opts.maxBuffer)) spawnOpts.maxBuffer = opts.maxBuffer;
  return spawnSync(command, [...argvPrefix, ...args], spawnOpts);
}

/** 非 git 仓文案（git 在 C locale 下的稳定英文形态）。 */
export function isNotARepoStderr(stderr) {
  return /not a git repository/i.test(String(stderr ?? ''));
}

/** 空仓文案（git init 后零提交）。 */
export function isEmptyRepoStderr(stderr) {
  return /does not have any commits yet/i.test(String(stderr ?? ''));
}
