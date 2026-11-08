// 文件：engine.mjs
// 描述：降级规则引擎（内部决策-037）——applyRule 分派顺序（与 内部接口-1 §2 / 内部模块-16 R-pc-10 同源）：
//       入参形状守卫 → 规则存在性 → 宿主在矩阵 hosts 内 → trigger.capability 矩阵键集 →
//       params[host] 参与判定与形态校验（未命中返回 applied:false，零降级宿主恒走此路径）→
//       端口必填校验 → 六族执行器分派；装载/物化期 fail-closed，异常具名抛出（消息含 ruleId/host/缺失面）。
//       另提供只读 hasRule（消费方装载期漂移闸用）。
//       **宿主中立**：本文件与 src/strategies/*.mjs 禁止宿主字面量——宿主名只作数据键
//       （params 键 / 矩阵列名），B-pc-3 对偶约束。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：import { createEngine, loadEngine } from './engine.mjs'
// 自检：node --test "plugin-core/tests/engine.test.mjs"
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { executors as emulateExecutors } from './strategies/emulate.mjs';
import { executors as mapExecutors } from './strategies/map.mjs';
import { executors as normalizeExecutors } from './strategies/normalize.mjs';
import { executors as relayExecutors } from './strategies/relay.mjs';
import { executors as degradeExecutors } from './strategies/degrade.mjs';
import { executors as disableExecutors } from './strategies/disable.mjs';
import { validateRules, RULES_VERSION } from './validate.mjs';

/** 规则 id → 执行器（六族模块汇总；内部决策-037 决策 2）。 */
const EXECUTORS = {
  ...emulateExecutors,
  ...mapExecutors,
  ...normalizeExecutors,
  ...relayExecutors,
  ...degradeExecutors,
  ...disableExecutors,
};

/** 端口契约：规则 id → 必需端口（缺失即 fail-closed）。按规则而非按族声明——同族内并非都有副作用
 *  （emulate 族的 command-to-skill 为纯映射，无端口）。 */
const PORT_REQUIREMENTS = {
  'followup-expansion': ['enqueue'],
  'stop-pending-relay': ['readState', 'writeState'],
  'agent-default-off-fail-closed': ['listRestrictableTools'],
};

/**
 * 创建引擎实例（数据注入式：规则库与矩阵由调用方加载，便于装载期与测试注入）。
 * fail-closed：入参形状不合立即抛错（消息含缺失面名）——rules/rulesVersion/capabilities/hosts 四道
 * 与规则表元素（对象、非空字符串 id、id 唯一）均在构造期校验。
 * @param {{rules: object, matrix: object}} input 规则库（rulesVersion 2）与能力矩阵
 * @returns {{applyRule: (ruleId: string, host: string, context?: object, ports?: object) => {applied: boolean, fidelity: string|undefined, result: any}, hasRule: (ruleId: string) => boolean}}
 */
export function createEngine(input) {
  const { rules, matrix } = input ?? {};
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('createEngine: rules 须为对象');
  if (rules.rulesVersion !== RULES_VERSION) throw new Error(`createEngine: rulesVersion 须为 ${RULES_VERSION}，实测 ${JSON.stringify(rules.rulesVersion)}`);
  if (!Array.isArray(rules.rules)) throw new Error('createEngine: rules.rules 须为数组');
  const caps = matrix && typeof matrix === 'object' && matrix.capabilities && typeof matrix.capabilities === 'object' ? matrix.capabilities : null;
  if (caps === null) throw new Error('createEngine: matrix.capabilities 缺失或非对象');
  const hostList = matrix && Array.isArray(matrix.hosts) && matrix.hosts.length > 0 ? matrix.hosts : null;
  if (hostList === null) throw new Error('createEngine: matrix.hosts 缺失或空数组（宿主门禁不可得）');

  /** @type {Map<string, object>} */
  const ruleById = new Map();
  for (let i = 0; i < rules.rules.length; i += 1) {
    const rule = rules.rules[i];
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`createEngine: rules[${i}] 须为对象`);
    if (typeof rule.id !== 'string' || rule.id === '') throw new Error(`createEngine: rules[${i}].id 须为非空字符串`);
    if (ruleById.has(rule.id)) throw new Error(`createEngine: rules 重复 id ${rule.id}`);
    ruleById.set(rule.id, rule);
  }

  /**
   * 分派一条降级规则：宿主无 params 条目即 applied:false（无缺口，走原生路径）。
   * 顺序：入参形状守卫 → 规则存在性 → 宿主在矩阵 hosts 内 → capability 键集 → params 参与与形态
   * （空对象/非对象 fail-closed）→ 端口必填 → 执行器；错误消息统一含 `ruleId=` / `host=`。
   * @param {string} ruleId 规则 id（degradation-rules.json 的 id）
   * @param {string} host 宿主键（矩阵列名）
   * @param {object} [context] 规则上下文（各族语义不同，如 matcher/body/source）
   * @param {object} [ports] 宿主端口实现（按规则声明必需：followup-expansion:{enqueue}、stop-pending-relay:{readState,writeState}、agent-default-off-fail-closed:{listRestrictableTools}）
   * @returns {{applied: boolean, fidelity: string|undefined, result: any}}
   */
  function applyRule(ruleId, host, context = {}, ports = {}) {
    if (typeof ruleId !== 'string' || ruleId === '') throw new Error(`applyRule: ruleId 须为非空字符串，实测 ${JSON.stringify(ruleId)}`);
    if (typeof host !== 'string' || host === '') throw new Error(`applyRule: host 须为非空字符串，实测 ${JSON.stringify(host)}`);
    const at = `applyRule: ruleId=${ruleId} host=${host}`;
    const rule = ruleById.get(ruleId);
    if (rule === undefined) throw new Error(`${at}: 未知规则（规则未登记）`);
    if (!hostList.includes(host)) throw new Error(`${at}: 未知宿主（矩阵 hosts：${hostList.join('|')}）`);
    const ctx = context ?? {};
    const capability = rule.trigger && rule.trigger.capability;
    if (typeof capability !== 'string' || !Object.hasOwn(caps, capability)) {
      throw new Error(`${at}: trigger.capability 不在矩阵键集：${String(capability)}`);
    }
    const paramsDoc = rule.params;
    if (paramsDoc === null || typeof paramsDoc !== 'object' || Array.isArray(paramsDoc) || Object.keys(paramsDoc).length === 0) {
      throw new Error(`${at}: params 不合契约（规则 params 须为非空对象）`);
    }
    const hp = Object.hasOwn(paramsDoc, host) ? paramsDoc[host] : undefined;
    if (hp === undefined) return { applied: false, fidelity: rule.fidelity, result: undefined };
    if (hp === null || typeof hp !== 'object' || Array.isArray(hp) || Object.keys(hp).length === 0) {
      throw new Error(`${at}: params 条目须为非空对象`);
    }

    for (const port of Object.hasOwn(PORT_REQUIREMENTS, ruleId) ? PORT_REQUIREMENTS[ruleId] : []) {
      if (typeof ports?.[port] !== 'function') throw new Error(`${at}: 缺端口 ${port}`);
    }
    const executor = Object.hasOwn(EXECUTORS, ruleId) ? EXECUTORS[ruleId] : null;
    if (executor === null) throw new Error(`${at}: 未登记执行器（策略族 ${String(rule.strategy)}）`);
    // 执行器异常统一包裹：契约面错误消息一律含 ruleId=/host= 前缀（内部接口-1 §4）
    try {
      const result = executor({ context: ctx, host, matrix: caps }, hp, ports);
      return { applied: true, fidelity: rule.fidelity, result };
    } catch (e) {
      throw new Error(`${at}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 只读查询：规则 id 是否已在装载规则库登记（消费方装载期漂移闸用）。
   * 边界：非字符串/空字符串返回 false（不抛错）——与 applyRule 的入参守卫不同；其余登记态判定一致。
   * @param {string} ruleId 规则 id
   * @returns {boolean} 登记态
   */
  const hasRule = (ruleId) => typeof ruleId === 'string' && ruleById.has(ruleId);

  return { applyRule, hasRule };
}

/**
 * 从仓库根装载引擎（plugin-core 两数据文件）。
 * fail-closed 两道：①规则库过 `validateRules`（不合法即抛，消息含全部错误——R-pc-12「不合契约拒载」的装载期落点）；
 * ②文件缺失/坏 JSON 抛错且消息含文件路径。
 * @param {string} repoRoot 仓库根（plugin-core 的父目录）
 * @returns {ReturnType<typeof createEngine>}
 */
export function loadEngine(repoRoot) {
  const read = (file) => {
    const path = join(repoRoot, 'plugin-core', file);
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(`loadEngine: 规则数据不可读 ${path}：${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`loadEngine: 规则数据 JSON 损坏 ${path}：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const rules = read('degradation-rules.json');
  const matrix = read('capability-matrix.json');
  const checked = validateRules(rules, matrix);
  if (!checked.ok) throw new Error(`loadEngine: 规则库校验失败（拒载）：${checked.errors.join('；')}`);
  return createEngine({ rules, matrix });
}
