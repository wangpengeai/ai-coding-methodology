// 文件：engine-loader.mjs
// 描述：引擎装载（内部决策-037 期二批 2）——`resolveEngine` 解析**仓库根**（plugin-core 的父目录）并
//       交给 plugin-core 的 `loadEngine(repoRoot)`（其契约为 `join(repoRoot,'plugin-core',file)`）。
//       定位：`repoRootOverride` 显式注入优先（给了就用，不再自动兜底——先例 `pluginRoots`），
//       否则按 `<本模块>/../../plugin-core` 相对定位（随仓/随 profile 成立；registry 单包装法不可得）。
//       失败即具名抛错（含尝试路径与按装法的修复指引）——**装载期响亮失败**（裁决 A）。
//       跨层读取用 `require`（require(esm) 在 engines 约束的 Node 22.19+/24 默认可用），避免静态
//       import 在 plugin-core 缺失时以模块解析错误替代本层的具名诊断。
// 作者：wangp  创建：2026-10-01  版权：MIT（见仓库 LICENSE）
// 用法：import { resolveEngine } from './engine-loader.mjs'
// 自检：node --test "tests/engine-loader.test.mjs"
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE_DIR = dirname(fileURLToPath(import.meta.url));

/** plugin-core 目录名（解析产物＝其父目录，即仓库根）。 */
const PLUGIN_CORE_DIRNAME = 'plugin-core';

/** 修复指引（纳入抛错消息；按装法分列）。 */
const FIX_HINT =
  '修复：①link 装法（推荐）——确认 <仓库根>/plugin-core 存在，或用 link:<repo>/ai-coding-methodology 重新安装；' +
  '②registry 单包装法不可用（plugin-core 不随包分发）——改用 link 装法，或将 plugin-core 置于可解析位置';

/**
 * 本层消费的 **7 条规则**（内部决策-037 批 2 消费点表）——每条附最小探针上下文与端口桩。
 * 探针只用于判定「规则已登记且含 `params.dsh`」（`applied === false` 即数据漂移），不落任何副作用。
 */
export const CONSUMED_RULES = Object.freeze([
  ['tool-vocab-map', { matcher: 'Bash' }, {}],
  ['source-widen-normalize', { source: 'startup' }, {}],
  ['namespace-transform', { plugin: 'workflow', dirName: 'gate' }, {}],
  // 探针上下文与生产调用同形（门 B 回流：`text`/`slot`/`restricted` 等旧键名已校正），
  // 以免读者误以为探针验证了语义——它只证「规则已登记且含 `params.dsh`」。
  ['followup-expansion', { body: 'x', rawInput: '', startTurn: false }, { enqueue: () => {} }],
  ['message-slot-migration', { envelope: {} }, {}],
  ['failure-event-merge', { isError: false, exitCode: undefined, text: '' }, {}],
  ['agent-default-off-fail-closed', { candidates: [] }, { listRestrictableTools: () => [] }],
]);

/**
 * 装载期机械断言：7 条消费规则**均存在且均含 `params.dsh`**——不合即返回缺失清单（调用方 `logWarn` + 拒载）。
 * 判据：①规则整条缺失＝`hasRule(ruleId) === false`（只读登记态，不依赖错误文案）；②`applied !== true`
 * 或 `applyRule` 抛出「未知规则/未知 ruleId/规则未登记」（兼容旧文案）＝漂移；其余抛错（端口/门禁）
 * 说明 `params.dsh` 在场，视为通过——不二次读规则 JSON，保持单一事实源。
 * @param {object} engine 引擎实例
 * @returns {string[]} 缺失规则的 ruleId 清单（空数组＝通过）
 */
export function missingConsumedRules(engine) {
  const missing = [];
  if (engine === null || typeof engine !== 'object' || typeof engine.applyRule !== 'function') {
    return CONSUMED_RULES.map(([ruleId]) => ruleId);
  }
  for (const [ruleId, context, ports] of CONSUMED_RULES) {
    if (typeof engine.hasRule === 'function' && engine.hasRule(ruleId) === false) {
      missing.push(ruleId); // 规则整条缺失：优先只读登记态判定
      continue;
    }
    try {
      const outcome = engine.applyRule(ruleId, 'dsh', context, ports);
      if (!outcome || outcome.applied !== true) missing.push(ruleId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('未知规则') || message.includes('未知 ruleId') || message.includes('规则未登记')) missing.push(ruleId); // 规则缺失：拒载（兼容旧文案）
    }
  }
  return missing;
}

/**
 * 解析引擎：定位仓库根 → `loadEngine(repoRoot)`；失败具名抛错（含尝试路径与修复指引）。
 * @param {{repoRootOverride?: string}} [options] `repoRootOverride` ＝ 仓库根（plugin-core 的父目录）显式覆盖
 * @returns {object} 引擎实例（含 `applyRule`）
 */
export function resolveEngine(options = {}) {
  const explicit = typeof options.repoRootOverride === 'string' && options.repoRootOverride !== '' ? resolve(options.repoRootOverride) : null;
  const candidates = explicit === null ? [resolve(HERE_DIR, '..', '..')] : [explicit];
  for (const repoRoot of candidates) {
    const rulesPath = join(repoRoot, PLUGIN_CORE_DIRNAME, 'degradation-rules.json');
    if (!existsSync(rulesPath)) continue;
    // 诊断权归 plugin-core：`loadEngine` 内部读两 JSON 并对坏数据抛含完整路径的具名错（下方 catch 包装补仓库根与修复指引）
    try {
      const { loadEngine } = require(join(repoRoot, PLUGIN_CORE_DIRNAME, 'src', 'engine.mjs'));
      return loadEngine(repoRoot);
    } catch (error) {
      throw new Error(`engine-loader: plugin-core 装载失败（${repoRoot}）：${error instanceof Error ? error.message : String(error)}。${FIX_HINT}`);
    }
  }
  throw new Error(`engine-loader: 未找到 ${PLUGIN_CORE_DIRNAME}（尝试路径：${candidates.join('、')}）。${FIX_HINT}`);
}
