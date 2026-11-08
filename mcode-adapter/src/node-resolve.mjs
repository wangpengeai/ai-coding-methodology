// 文件：mcode-adapter/src/node-resolve.mjs
// 描述：钩子解释器解析（内部决策-034 决策 10）。宿主**不为钩子注入独立 Node 可执行文件**
//       （local-plugin-hooks.md 明写），且钩子进程的 PATH 与交互式终端未必一致——故
//       安装期解析一次绝对路径并写进生成的处理器命令。三级来源：PATH 上的 `node`
//       → 常见绝对安装位置 → 当前进程自身的 node（仅当其文件名形如 node）。全部不可得
//       即返回 null，由安装器**拒绝安装并报缺依赖**（不静默降级、不写坏包）。
//       便携性代价如实登记：包内命令含绝对解释器路径，换机需重跑 `install`。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
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
 * 宿主不为钩子注入独立 Node 且钩子进程 PATH 未必一致，必须落绝对路径（见 mcode-adapter/README.md）。
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
 * 三级候选表（`resolveNode` 与 `diagnoseNode` 的**唯一**来源；不得复制第二份）。
 * @param {Record<string, string|undefined>} env 注入的环境
 * @param {string} execPath 当前进程自身的可执行路径
 * @returns {{source: string, value: string}[]}
 */
function buildCandidates(env, execPath) {
  return [
    { source: 'path', value: 'node' },
    { source: 'program-files', value: env.ProgramFiles ? join(env.ProgramFiles, 'nodejs', 'node.exe') : '' },
    { source: 'local-appdata', value: env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '' },
    { source: 'self', value: execPath ?? process.execPath },
  ];
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
  for (const candidate of buildCandidates(env, options.execPath)) {
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

/** 三态诊断标签（内部未决-63 的可行动口径；`resolveNode` 的返回值契约不变，诊断另走一支）。 */
export const RESOLUTION_STATES = Object.freeze({
  OK: 'ok',
  NOT_INSTALLED: 'not-installed',
  READBACK_FAILED: 'readback-failed',
  UNUSABLE: 'unusable',
});

/**
 * 三态诊断：把 内部未决-63 登记的三个失败面**区分开**并留下逐候选证据。
 *
 * 登记原文（三态曾共用一条拒绝文案 ⇒ 运维者朝错误方向排查）：
 *   ①「未装 Node」②「PATH 候选探针通过但绝对化读回失败（宿主禁 `node -e`、stdout 被污染）」
 *   ③「全部候选不可得」
 *
 * 三态判据互斥、各自可达：
 * - `readback-failed`：**有候选探针通过、但绝对化读回拿不回路径**（探针活着却写不出命令）；
 * - `not-installed`：**候选路径一个都不存在**且 PATH 上的 node 也探不通 ⇒ 本机没有 node；
 * - `unusable`：**候选路径存在、却全部探针未通过**（装了但跑不起来：权限、架构、损坏，
 *   或 PATH 上是同名非 node 的桩）——与 ① 的区别是「找到了但不可用」与「压根没找到」。
 *
 * @param {object} options 注入缝同 `resolveNode`
 * @returns {{state: string, attempts: {source: string, stage: string, reason: string}[]}}
 */
export function diagnoseNode(options = {}) {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeNode;
  const exists = options.exists ?? existsSync;
  const resolveExecPath = options.resolveExecPath ?? absolutePathOf;
  const attempts = [];
  let anyProbePassed = false;
  let anyReadbackFailed = false;
  let anyTried = false;
  let anyExisted = false;
  for (const candidate of buildCandidates(env, options.execPath)) {
    if (!candidate.value) {
      attempts.push({ source: candidate.source, stage: 'skipped', reason: '环境变量缺席，候选未成形' });
      continue;
    }
    if (candidate.source === 'self' && !/^node(\.exe)?$/i.test(basename(candidate.value))) {
      attempts.push({ source: candidate.source, stage: 'skipped', reason: '当前进程自身不是 node 命名' });
      continue;
    }
    if (candidate.source !== 'path' && !exists(candidate.value)) {
      attempts.push({ source: candidate.source, stage: 'skipped', reason: `候选路径不存在：${candidate.value}` });
      continue;
    }
    anyTried = true;
    if (candidate.source !== 'path') anyExisted = true;
    if (!probe(candidate.value)) {
      attempts.push({ source: candidate.source, stage: 'probe', reason: '探针未通过（不可执行或非 node）' });
      continue;
    }
    anyProbePassed = true;
    if (candidate.source === 'self') {
      attempts.push({ source: candidate.source, stage: 'ok', reason: '命中当前进程自身' });
      return { state: RESOLUTION_STATES.OK, attempts };
    }
    const absolute = resolveExecPath(candidate.value);
    if (absolute !== null) {
      attempts.push({ source: candidate.source, stage: 'ok', reason: `绝对化读回成功：${absolute}` });
      return { state: RESOLUTION_STATES.OK, attempts };
    }
    // 与 `resolveNode` 同源：候选本身即绝对路径时解析器会**直接采用**它（不得因一次读回失败
    // 把它丢掉），故诊断同判成功——否则会出现「解析器成功、诊断报失败」的自相矛盾态
    // （内部任务-55 code-review 两实例独立命中）。stage 记 `degraded` 以示这是降级采用。
    if (isAbsolute(candidate.value)) {
      attempts.push({ source: candidate.source, stage: 'degraded', reason: `绝对化读回失败，但候选本身即绝对路径：${candidate.value}（解析器直接采用）` });
      return { state: RESOLUTION_STATES.OK, attempts };
    }
    anyReadbackFailed = true;
    attempts.push({ source: candidate.source, stage: 'readback', reason: '绝对化读回失败，且候选不是绝对路径（无路径可写）' });
  }
  const state = anyProbePassed && anyReadbackFailed
    ? RESOLUTION_STATES.READBACK_FAILED
    : anyTried && anyExisted
      ? RESOLUTION_STATES.UNUSABLE
      : RESOLUTION_STATES.NOT_INSTALLED;
  return { state, attempts };
}

/**
 * 三态 → **分支专属**的可行动拒绝文案（三态各自的下一步互不相同）。
 *
 * 取证背景（内部任务-55）：内部未决-63 的原始缺陷就是三态共用一条文案；拆分后每态钉一个互不相同的
 * 子串，删掉任一分支实现其对应用例必红（见 `tests/generate.test.mjs` 三态诊断用例）。
 * @param {string} state `diagnoseNode` 的 state
 * @returns {string} 多行拒绝文案（含边界说明与下一步动作）
 */
export function nodeFailureText(state) {
  const boundary = '宿主不为钩子注入独立 Node，本层必须写入绝对解释器路径。';
  if (state === RESOLUTION_STATES.READBACK_FAILED) {
    return `找到可执行的 node，但读不回它的绝对路径（${boundary}）\n`
      + '常见成因：宿主禁止在钩子里执行 `node -e`，或钩子进程 stdout 被污染。\n'
      + '下一步：在交互式终端确认 `node -e "process.stdout.write(process.execPath)"` 能正常输出，'
      + '并检查钩子运行环境是否限制子进程 spawn；确认后重跑本命令。';
  }
  if (state === RESOLUTION_STATES.UNUSABLE) {
    return `候选路径存在但一个都跑不起来（${boundary}）\n`
      + '常见成因：node 文件权限不足、架构不匹配、文件损坏，或 PATH 上的 node 是同名非 node 的桩。\n'
      + '下一步：在交互式终端逐个试跑候选路径的 `node -v`，修好可执行性或换掉被占用的 PATH 位置后重跑本命令。';
  }
    // 候选清单随平台成形（`buildCandidates`：两处绝对路径候选在非 win32 上恒缺席），
  // 故「已试遍」一句必须按平台择文——在 POSIX 上列出从未试过的 Windows 路径，
  // 与本函数要消除的 内部未决-63「文案把人导向错误方向」是同一类缺陷。
  const tried = process.platform === 'win32'
    ? '已试遍：PATH 上的 node、%ProgramFiles%\\nodejs\\node.exe、%LOCALAPPDATA%\\Programs\\nodejs\\node.exe，均不存在或探针未通过。'
    : '已试遍本平台可用的全部候选（PATH 上的 node 与当前进程自身），均不存在或探针未通过。';
  return `未找到可执行的 node（${boundary}）\n${tried}\n`
    + '下一步：安装 Node.js 后重跑本命令，或修好 PATH 让钩子进程能找到它。';
}
