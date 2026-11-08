// 文件：host-presence.mjs
// 描述：宿主应用在位探测（内部决策-048/内部任务-11）——候选与判定单源＝仓内共享签名库
//       spec-gate/assurance/host-signatures.json，本模块只读该库；与 assurance 探针
//       （probes.mjs host-app-present）构成同库两个独立读取者，互证而非自证。
//       语义约定（与 assurance 探针侧一致）：env 覆盖优先（ZCODE_APP_ROOT）、`~/` 前缀按
//       用户主目录展开、≥1 候选存在＝present。未检出与探测失败均不阻断安装（预装
//       合法，内部决策-048 决策 3）；探测失败（库不可读等）如实报因。
//       2026-11-01 内部任务-275（内部未决-243 缓解面）另承载钩子解释器探测（detectHookInterpreter/
//       hookInterpreterLine）：按本 CLI 进程 PATH 解析裸 `node`，只报告不改写声明。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 workflow/LICENSE）
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'zcode';
const ENV_OVERRIDE = 'ZCODE_APP_ROOT'; // DP3：应用根覆盖（DSH_APP_ROOT 先例；与数据目录语义名分立）
const SIGNATURES_REL = '../../spec-gate/assurance/host-signatures.json'; // src/ 上两级＝仓根（三 adapter 同形；adapter CLI 恒自仓库运行）

/**
 * 探测宿主应用本体在位性。
 * @param {object} env 环境注入缝（缺省 process.env；测试零真机触达）
 * @param {string} platform 平台注入缝（缺省 process.platform；win32/darwin/linux 各归各候选表，无记载平台 fail-loud——内部任务-281）
 * @returns {{present: boolean, hit?: string, reason?: string, candidates: string[]}} 在位判定与命中/候选明细
 */
export function detectHostApp(env = process.env, platform = process.platform) {
  const override = typeof env[ENV_OVERRIDE] === 'string' && env[ENV_OVERRIDE] ? env[ENV_OVERRIDE] : '';
  if (override) return { present: existsSync(override), hit: override, candidates: [override] };
  let signatures;
  try {
    signatures = JSON.parse(readFileSync(fileURLToPath(new URL(SIGNATURES_REL, import.meta.url)), 'utf8'));
  } catch (error) {
    return { present: false, reason: `探测失败：签名库不可读（${error instanceof Error ? error.message : String(error)}）`, candidates: [] };
  }
  // 平台三态对齐 assurance 探针侧（probes.mjs hostCandidates）：darwin/win32/linux 有记载（linux
  // 2026-11-02 内部任务-281/内部未决-208 起——zcode 有取证候选、mcode/kimi/dsh 空占位仍 fail-loud）；无记载
  // 平台与空列/非法元素一样按「不可机检」fail-loud 返回 reason——静默判 absent 会把真装机误报
  // 未检出（评审发现：内部任务-121 假信号的镜像形态），且证伪两侧「同语义」自述（内部决策-048 决策 4）。
  const key = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : '';
  if (key === '') {
    return { present: false, reason: `探测失败：本平台（${platform}）无签名候选记载（不可机检，转人工复核；签名库候选契约见 ADR-048）`, candidates: [] };
  }
  const list = signatures?.hosts?.[HOST]?.[key];
  if (!Array.isArray(list) || list.length === 0) {
    return { present: false, reason: `探测失败：${HOST} 在 ${key} 无签名候选（该平台未取证、空占位 fail-loud；不可机检，转人工复核，ADR-048）`, candidates: [] };
  }
  if (!list.every((entry) => typeof entry === 'string' && entry && entry !== '~/')) {
    return { present: false, reason: '探测失败：签名候选含非法元素（须非空字符串路径；~/ 须带具体相对段）', candidates: [] };
  }
  // ~/ 展开用 os.homedir()（含 USERPROFILE 回退）——与 Python Path.home() 同优先序，恒绝对形态
  const home = homedir();
  const candidates = list.map((entry) => (entry.startsWith('~/') ? join(home, entry.slice(2)) : entry));
  const hit = candidates.find((candidate) => existsSync(candidate));
  return { present: Boolean(hit), hit, candidates };
}

/**
 * 在位行渲染（cli.mjs verify 头部与 install.mjs 收尾区共用——包内单源，防两处文案漂移）。
 * @param {{present: boolean, hit?: string, reason?: string, candidates: string[]}} probe detectHostApp 返回值
 * @param {string} prefix 行前缀（如 '[install] '；缺省空串）
 * @returns {string} 完整输出行（不含换行）
 */
export function hostPresenceLine(probe, prefix = '') {
  return probe.present
    ? `${prefix}宿主应用：在位（${probe.hit}）`
    : `${prefix}宿主应用：未检出（${probe.reason ?? `候选：${probe.candidates.join('；')}均不存在`}；装在别处请设 ${ENV_OVERRIDE}）`;
}

/**
 * 钩子解释器解析探测（内部未决-243 缓解面，内部任务-275）：六插件 hooks.json 以裸 `node` 声明解释器、由
 * 宿主进程按**其** PATH 解析——PATH 解析不到时钩子 fail-open 静默空转。本函数按**本 CLI 进程** PATH
 * 做同款解析并报告（不改写任何声明文件；宿主进程 PATH 可能不同，成功行亦标注口径）。
 * 分隔符与可执行名按注入平台取（win32 补 node.exe/node.cmd、`;` 分隔且不验 X_OK——B-za-6 无平台裸假设）。
 * @param {object} env 环境注入缝（缺省 process.env；win32 兼容 Path 键形态）
 * @param {string} platform 平台注入缝（缺省 process.platform）
 * @returns {{resolved: string|null}} 第一个命中的绝对路径；未解析返回 null
 */
export function detectHookInterpreter(env = process.env, platform = process.platform) {
  const isWin = platform === 'win32';
  const pathVar = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : '';
  const names = isWin ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  for (const dir of pathVar.split(isWin ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!isWin) accessSync(candidate, constants.X_OK);
        return { resolved: candidate };
      } catch {
        /* 候选不存在或不可执行：继续下一候选（探测面只报告，不抛） */
      }
    }
  }
  return { resolved: null };
}

/**
 * 解释器探测行渲染（install 收尾区与 verify 头部共用——包内单源，防两处文案漂移）。
 * @param {{resolved: string|null}} probe detectHookInterpreter 返回值
 * @param {string} prefix 行前缀（如 '[install] '；缺省空串）
 * @returns {string} 完整输出行（不含换行）
 */
export function hookInterpreterLine(probe, prefix = '') {
  return probe.resolved
    ? `${prefix}钩子解释器：node → ${probe.resolved}（本 CLI 进程 PATH 解析；宿主进程 PATH 可能不同）`
    : `${prefix}⚠ 钩子解释器：PATH 内未解析到 node：宿主侧钩子将以 fail-open 静默空转（OPEN-243 缓解面）——请核对宿主进程 PATH`;
}
