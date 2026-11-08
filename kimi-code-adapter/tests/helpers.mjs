// 文件：kimi-code-adapter/tests/helpers.mjs
// 描述：本套件测试的共享夹具——临时根、物化一次供真实钩子进程跑的包、以 spawnSync
//       驱动 shim 的助手。**驱动方式刻意用 spawnSync 的 `input` 而不是 shell 管道**：
//       PowerShell 管道按控制台代码页编码（本机 zh-CN 为 GBK），会把 JSON 负载打坏
//       （mcode 批实测：管道直喂真实护栏钩得到「无法解析工具负载」的假红）。
//       临时根一律 realpath 归一（darwin /var symlink 会让 ESM 模块 URL 与 argv 路径
//       分裂，真实钩子的入口守卫判等恒假而静默 no-op——内部任务-MACKEY-1 同款教训）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 适配层根（`<仓库根>/kimi-code-adapter`）。 */
export const ADAPTER_ROOT = resolve(HERE, '..');

/** 仓库根。 */
export const REPO_ROOT = resolve(ADAPTER_ROOT, '..');

/**
 * 建临时根（测试结束由调用方清理）。返回前 realpath 归一（见文件头说明）。
 * @param {string} tag 临时目录标签
 * @returns {string}
 */
export function tempRoot(tag) {
  return realpathSync(mkdtempSync(join(tmpdir(), `kimi-${tag}-`)));
}

/**
 * 递归删（仅用于测试临时根；守卫同时接受 tmpdir 与其 realpath 形态）。
 * @param {string} dir 目录
 * @returns {void}
 */
export function removeRoot(dir) {
  if (typeof dir !== 'string' || dir === '') return;
  if ([tmpdir(), realpathSync(tmpdir())].some((p) => dir.startsWith(p))) rmSync(dir, { recursive: true, force: true });
}

/**
 * 写文件（自动建父目录）。
 * @param {string} path 目标路径
 * @param {string} content 内容
 * @returns {string} 写入路径
 */
export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * 物化六个包到临时宿主根（真实 CLI，覆盖 install 路径；managed/ 形态）。
 * @param {string} homeDir 临时宿主根
 * @returns {string} 包根（managed/workflow）
 */
export function materializeAll(homeDir) {
  const result = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', homeDir], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`物化失败（exit ${result.status}）：${result.stdout}\n${result.stderr}`);
  }
  return join(homeDir, 'plugins', 'managed', 'workflow');
}

/**
 * 把引擎闭包复制进夹具包（复刻 `cli.mjs install` 的物化形态）：shim 装载包内引擎副本，
 * 夹具必须与真实包同形态，否则会落进"引擎不可得"的降级面。
 * @param {string} pkgRoot 夹具包根
 * @returns {void}
 */
export function ensureEngineFixture(pkgRoot) {
  const target = join(pkgRoot, 'plugin-core');
  if (existsSync(join(target, 'src', 'engine.mjs'))) return;
  cpSync(join(REPO_ROOT, 'plugin-core', 'src'), join(target, 'src'), { recursive: true });
  for (const name of ['degradation-rules.json', 'capability-matrix.json']) {
    cpSync(join(REPO_ROOT, 'plugin-core', name), join(target, name));
  }
}

/**
 * 以真实子进程驱动 shim（stdin 喂 Kimi 形态负载）。
 * @param {{pkgRoot: string, event: string, script: string, payload: object, timeoutSeconds?: number, env?: object, dataDir?: string, withoutEngine?: boolean}} input 输入；
 *   `withoutEngine: true` ＝**不快照引擎副本**（专测"引擎不可得"的失败可见面）
 * @returns {{status: number|null, stdout: string, stderr: string, frame: object|null, text: string}}
 */
export function runShim(input) {
  // 除显式 `withoutEngine`（专测失败可见面）外，先把引擎闭包复制进夹具包。
  if (input.withoutEngine !== true) ensureEngineFixture(input.pkgRoot);
  const result = spawnSync(
    process.execPath,
    [join(input.pkgRoot, 'kimi', 'hook-shim.mjs'), input.event, input.script, String(input.timeoutSeconds ?? 5)],
    {
      input: JSON.stringify(input.payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        KIMI_CODE_HOME: input.dataDir ?? join(tmpdir(), 'kimi-shim-default-data'),
        ...(input.env ?? {}),
      },
      timeout: 90_000,
      windowsHide: true,
    },
  );
  const stdout = String(result.stdout ?? '');
  // frame = 末行 JSON（PreToolUse deny 信封等）；text = 全 stdout 原文（UserPromptSubmit 纯文本面）
  let frame = null;
  const line = stdout.split('\n').map((item) => item.trim()).filter((item) => item !== '').pop();
  if (line) {
    try {
      frame = JSON.parse(line);
    } catch {
      frame = null;
    }
  }
  return { status: result.status, stdout, stderr: String(result.stderr ?? ''), frame, text: stdout };
}

/**
 * 判定 PreToolUse deny 帧是否符合宿主文档两键白名单（`hookSpecificOutput` 仅
 * `permissionDecision`/`permissionDecisionReason`）——宿主见白名单外键即整帧丢弃，
 * 本纪律防「帧被静默作废后 deny 变放行」。
 * @param {object|null} frame 响应帧
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function checkDenyShape(frame) {
  const problems = [];
  if (frame === null) return ['缺帧'];
  if (Object.keys(frame).join(',') !== 'hookSpecificOutput') problems.push(`顶层键越界：${Object.keys(frame).join(',')}`);
  const inner = frame.hookSpecificOutput;
  if (!inner || typeof inner !== 'object') problems.push('hookSpecificOutput 不是对象');
  else {
    for (const key of Object.keys(inner)) {
      if (!['permissionDecision', 'permissionDecisionReason'].includes(key)) problems.push(`内层键越界：${key}`);
    }
    if (inner.permissionDecision !== 'deny') problems.push(`permissionDecision 非 deny：${String(inner.permissionDecision)}`);
  }
  return problems;
}
