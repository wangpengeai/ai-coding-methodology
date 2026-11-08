// 文件：kimi-code-adapter/src/node-resolve.mjs
// 描述：钩子解释器解析（内部决策-038 决策 7）。Kimi 钩子 command 由宿主经 shell 执行、
//       **cwd=插件根**，不为钩子注入独立 Node——故安装期把解释器**绝对路径**解析一次并写进
//       生成的 hooks[].command（跨平台单形态，路径含空格以双引号安全引用）。
//       三级来源：PATH 上的 `node` → 常见绝对安装位置 → 当前进程自身的 node（仅当其文件名
//       形如 node）。全部不可得即返回 null，由安装器**拒绝安装并报缺依赖**（不静默降级、
//       不写坏包）。便携性代价如实登记：换机需重跑 `install`。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.8/§5；mcode-adapter/src/node-resolve.mjs 中立件
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

/** 探测超时（毫秒）：解释器探测是安装期一次性动作，卡住即视为不可得。 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 某候选是否可执行（`-v` 探针；不可执行/非 node 一律判否）。
 * @param {string} candidate 可执行路径或命令名
 * @returns {boolean}
 */
export function probeNode(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false;
  try {
    const result = spawnSync(candidate, ['-v'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return result.status === 0 && /^v\d+\./.test(String(result.stdout ?? '').trim());
  } catch {
    return false;
  }
}

/**
 * 读回候选解释器的**绝对路径**（`node -e` 自报 `process.execPath`）——PATH 命中时 "node" 只是名字，
 * 宿主钩子进程的 PATH 与安装期未必一致，必须落绝对路径。
 * @param {string} candidate 候选命令（PATH 名或绝对路径）
 * @returns {string|null} 绝对路径；不可执行/输出非绝对路径一律 null
 */
function absolutePathOf(candidate) {
  try {
    const r = spawnSync(candidate, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    if (r.error !== undefined && r.error !== null) return null;
    if (r.status !== 0) return null;
    const out = (r.stdout ?? '').trim();
    return out !== '' && isAbsolute(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * 解析解释器绝对路径。
 * @param {{env?: Record<string, string|undefined>, execPath?: string, probe?: (candidate: string) => boolean, exists?: (path: string) => boolean, resolveExecPath?: (candidate: string) => string|null}} options 注入缝（测试用）：`resolveExecPath` 为「候选命令 → 绝对路径」的解析器，默认走 `absolutePathOf`（真实 spawn 读回 `process.execPath`）
 * @returns {{path: string, source: string}|null} 解析结果；不可得返回 null
 */
export function resolveNode(options = {}) {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeNode;
  const exists = options.exists ?? existsSync;
  const resolveExecPath = options.resolveExecPath ?? absolutePathOf;
  const candidates = [
    { source: 'path', value: 'node' },
    { source: 'program-files', value: env.ProgramFiles ? join(env.ProgramFiles, 'nodejs', 'node.exe') : '' },
    { source: 'local-appdata', value: env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '' },
    { source: 'self', value: options.execPath ?? process.execPath },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    if (candidate.source === 'self' && !/^node(\.exe)?$/i.test(basename(candidate.value))) continue;
    // 非 PATH 候选仍先过存在性判据（保留 `exists` 注入缝语义；PATH 名的可执行性由 probe 判）
    if (candidate.source !== 'path' && !exists(candidate.value)) continue;
    if (!probe(candidate.value)) continue;
    if (candidate.source === 'self') return { path: candidate.value, source: 'self' };
    const absolute = resolveExecPath(candidate.value);
    if (absolute !== null) return { path: absolute, source: candidate.source };
    // 解析失败但候选本身已是绝对路径（program-files / local-appdata 形态）：probe 已证明其可执行，
    // 不得因一次读回失败把它丢掉（失败方向会是"安装器误报缺依赖"，与 内部未决-63 同源）
    if (isAbsolute(candidate.value)) return { path: candidate.value, source: candidate.source };
  }
  return null;
}
