// 文件：host-presence.mjs
// 描述：宿主应用在位探测（内部决策-048/内部任务-11）——候选与判定单源＝仓内共享签名库
//       spec-gate/assurance/host-signatures.json，本模块只读该库；与 assurance 探针
//       （probes.mjs host-app-present）构成同库两个独立读取者，互证而非自证。
//       语义约定（与 assurance 探针侧一致）：env 覆盖优先（KIMI_APP_ROOT）、`~/` 前缀按
//       用户主目录展开、≥1 候选存在＝present。未检出与探测失败均不阻断安装（预装
//       合法，内部决策-048 决策 3）；探测失败（库不可读等）如实报因。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'kimi';
const ENV_OVERRIDE = 'KIMI_APP_ROOT'; // DP3：应用根覆盖（DSH_APP_ROOT 先例；与数据目录语义名分立）
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
  // 2026-11-02 内部任务-281/内部未决-208 起——zcode 有取证候选、本宿主 linux 空占位仍 fail-loud）；无记载
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
