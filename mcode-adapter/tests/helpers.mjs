// 文件：mcode-adapter/tests/helpers.mjs
// 描述：本套件测试的共享夹具——临时根、物化一次供真实钩子进程跑的包、以 spawnSync
//       驱动 shim 的助手。**驱动方式刻意用 spawnSync 的 `input` 而不是 shell 管道**：
//       PowerShell 管道按控制台代码页编码（本机 zh-CN 为 GBK），会把 JSON 负载打坏
//       （实测：管道直喂真实 `check-freeze.mjs` 得到「无法解析工具负载」的假红）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 适配层根（`<仓库根>/mcode-adapter`）。 */
export const ADAPTER_ROOT = resolve(HERE, '..');

/** 仓库根。 */
export const REPO_ROOT = resolve(ADAPTER_ROOT, '..');

/** 建临时根（测试结束由调用方清理）。返回前 realpath 归一：darwin 的 os.tmpdir()
 * 原始形态走 /var symlink（realpath 为 /private/var/...），而 ESM 加载器按 realpath
 * 计算模块 URL——真实钩子入口守卫（argv[1] ↔ import.meta.url 字符串级等值）在
 * 两形态分裂下判 false，物化包内的真实钩子整体静默 no-op（2026-09-30 Mac 发布
 * 验证实录，内部任务-INSTALL-055；内部任务-MACKEY-1 键控面同族）。返回 realpath 形态使
 * 派生路径（PLUGIN_ROOT/被 spawn 的脚本路径）与模块 URL 形态恒一致；无 symlink
 * 平台 realpath 幂等零变化。 */
export function tempRoot(tag) {
  return realpathSync(mkdtempSync(join(tmpdir(), `mcode-${tag}-`)));
}

/** 递归删（仅用于测试临时根）。 */
export function removeRoot(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 写文件（自动建父目录）。 */
export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * 物化六个包到临时数据目录（供真实钩子进程与包面断言共用）。
 * @param {string} dataDir 临时数据目录
 * @returns {string} 传入的数据目录
 */
export function materializeAll(dataDir) {
  const result = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', dataDir], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`物化失败（exit ${result.status}）：${result.stdout}\n${result.stderr}`);
  }
  return dataDir;
}

/**
 * 把引擎闭包复制进夹具包（复刻 `cli.mjs install` 的物化形态）：批 3 起 shim 装载包内引擎副本，
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
 * 以真实子进程驱动 shim（stdin 喂 MCode 负载）。
 * @param {{pkgRoot: string, event: string, script: string, payload: object, timeoutSeconds?: number, env?: object, dataDir?: string, withoutEngine?: boolean}} input 输入；
 *   `withoutEngine: true` ＝**不快照引擎副本**（专测"引擎不可得"的失败可见面）
 * @returns {{status: number|null, stdout: string, stderr: string, frame: object|null}}
 */
export function runShim(input) {
  // 除显式 `withoutEngine`（专测失败可见面）外，先把引擎闭包复制进夹具包。
  if (input.withoutEngine !== true) ensureEngineFixture(input.pkgRoot);
  const result = spawnSync(
    process.execPath,
    [join(input.pkgRoot, 'mcode', 'hook-shim.mjs'), input.event, input.script, String(input.timeoutSeconds ?? 5)],
    {
      input: JSON.stringify(input.payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        PLUGIN_ROOT: input.pkgRoot,
        PLUGIN_DATA: input.dataDir ?? join(tmpdir(), 'mcode-shim-default-data'),
        ...(input.env ?? {}),
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  const stdout = String(result.stdout ?? '');
  let frame = null;
  const line = stdout.split('\n').map((item) => item.trim()).filter((item) => item !== '').pop();
  if (line) {
    try {
      frame = JSON.parse(line);
    } catch {
      frame = null;
    }
  }
  return { status: result.status, stdout, stderr: String(result.stderr ?? ''), frame };
}

/**
 * 判定响应帧是否符合宿主白名单（复刻 `allowedWireOutputKeys` 与各事件内层键集合）——
 * 本套件的核心纪律：**任何经 shim 的输出都必须落在白名单内**，否则整帧被宿主丢弃。
 * @param {string} event 事件名
 * @param {object|null} frame 响应帧
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function checkFrameAgainstHost(event, frame) {
  const problems = [];
  if (frame === null) return [];
  const common = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage']);
  const allowed = {
    SessionStart: new Set([...common, 'hookSpecificOutput']),
    UserPromptSubmit: new Set([...common, 'decision', 'reason', 'hookSpecificOutput']),
    PreToolUse: new Set([...common, 'decision', 'reason', 'hookSpecificOutput']),
    PostToolUse: new Set([...common, 'decision', 'reason', 'hookSpecificOutput']),
    Stop: new Set([...common, 'decision', 'reason', 'hookSpecificOutput']),
  }[event] ?? new Set(common);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) problems.push(`顶层键越界：${key}`);
  }
  const specific = frame.hookSpecificOutput;
  if (specific !== undefined) {
    if (typeof specific !== 'object' || specific === null) problems.push('hookSpecificOutput 不是对象');
    else {
      const inner = event === 'PreToolUse'
        ? new Set(['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'])
        : new Set(['hookEventName', 'additionalContext', 'updatedMCPToolOutput']);
      for (const key of Object.keys(specific)) {
        if (!inner.has(key)) problems.push(`hookSpecificOutput 内层键越界：${key}`);
      }
      if (specific.hookEventName !== event) problems.push(`hookEventName 不一致：${String(specific.hookEventName)}`);
    }
  }
  if (frame.permissionDecision !== undefined) problems.push('顶层 permissionDecision 会被宿主忽略');
  return problems;
}
