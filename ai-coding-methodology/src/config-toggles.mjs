// 文件：config-toggles.mjs
// 描述：DSH 插件页配置面 v2 的插件开关纯函数（内部任务-268 / 内部决策-068）——单一事实源：
//       `PLUGIN_TOGGLE_FIELDS`（插件名→Config 字段映射）、`isPluginEnabled`、`enabledPluginsOf`、
//       `isOsObservationEnabled`、`unwrapVolatile`（volatile 解包单源，M-18/内部未决-245）。
//       兼容语义：字段缺失/undefined 视为 `true`——仅测试/嵌入调用方可能绕过宿主 schema；
//       生产链路 config 经宿主 schema 归一后恒有字段，以 schema 默认值（核心开/其余关）为准。
//       该语义由测试锁定，裸 config 调用在 index.mjs 记一次 logInfo（不用 logWarn）。
//       依据：内部决策-068 决策 1/2/3/6、内部模块-24 R-da-17/A-da-17；纯函数零依赖。
// 作者：wangp  创建：2026-10-31  版权：MIT（见仓库 LICENSE）

/** 插件名 → Config 字段名（与 内部决策-068 决策 1 一致；顺序即配置卡片行顺序）。 */
export const PLUGIN_TOGGLE_FIELDS = Object.freeze({
  workflow: 'pluginWorkflow',
  'spec-gate': 'pluginSpecGate',
  scout: 'pluginScout',
  'team-governance': 'pluginTeamGovernance',
  'algo-loop': 'pluginAlgoLoop',
  'research-loop': 'pluginResearchLoop',
});

/**
 * volatile 值解包（M-18/内部未决-245：本函数是**服务端 volatile 解包谓词的唯一实现**——6 个插件开关、
 * `osObservation` 与 `agentControlBridge` 共 8 个 volatile 字段统一经它取当前值；客户端半侧
 * `client/client.js` 是独立 web bundle（仅 require react，不能 import 服务端模块），另持等价解包，本批不处置）。
 * 真实宿主传 `createVolatile` 冻结引用（loader `_commitVolatile` 原地提交，运行期值变化经
 * `.get()` 读取）；测试注入缝允许普通值。**不缓存**——每次调用都取当前值。
 * @param {unknown} value 原始字段值（可能是 volatile 引用）
 * @returns {unknown} 解包后的当前值（无 `get()` 的普通值原样返回）
 */
export function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * 六个插件开关字段是否全部缺失（裸 config 调用，仅测试/嵌入；用于一次性 logInfo）。
 * @param {object} config 插件配置
 * @returns {boolean}
 */
export function hasNoPluginToggles(config) {
  return Object.values(PLUGIN_TOGGLE_FIELDS).every((field) => config?.[field] === undefined);
}

/**
 * 判定某插件是否启用：显式 false 才关闭；缺字段/undefined 按 open 处理（兼容语义）。
 * @param {object} config 插件配置
 * @param {string} plugin 插件名（PLUGIN_TOGGLE_FIELDS 的键）
 * @returns {boolean}
 */
export function isPluginEnabled(config, plugin) {
  const field = PLUGIN_TOGGLE_FIELDS[plugin];
  if (field === undefined) return false;
  const value = unwrapVolatile(config?.[field]);
  return value === undefined ? true : value === true;
}

/**
 * 启用插件名数组（固定 PLUGIN_TOGGLE_FIELDS 顺序）。
 * @param {object} config 插件配置
 * @returns {string[]}
 */
export function enabledPluginsOf(config) {
  return Object.keys(PLUGIN_TOGGLE_FIELDS).filter((plugin) => isPluginEnabled(config, plugin));
}

/**
 * OS 监测开关：显式 false 才关闭；缺字段/undefined 按 open 处理（同兼容语义）。
 * @param {object} config 插件配置
 * @returns {boolean}
 */
export function isOsObservationEnabled(config) {
  const value = unwrapVolatile(config?.osObservation);
  return value === undefined ? true : value === true;
}

