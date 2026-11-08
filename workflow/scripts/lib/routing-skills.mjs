// 文件：routing-skills.mjs
// 描述：路由表入口集合的脚本资产（2026-09-15 激活域批次，内部决策-022）——运行时
//       routing-declare.mjs 的声明成员校验与 check-routing.mjs 的漂移两环校验共用
//       同一数据源（B-M8-3 同款纪律：模式清单是脚本资产，不进 skill 正文）。
//       集合口径 = 路由表 18 行「路由到」列目标去重（15 本地入口 + 跨插件
//       scout/spike-run/disposable-build/team-governance/algo-loop/research-hypothesis/
//       experiment-design，共 22）；agent-eval 不在
//       路由表目标列故不入集。漂移守卫在 check-routing.mjs：期望入口⊆资产
//       （漏收即 entry-asset-incomplete）、资产⊆表（删行即 routing-entry-missing）。
//       保留名 ad-hoc 不是 skill 目录、不入集合——它是路由表外的合法绕行出口
//       （非开发任务显式声明，不可用于开发任务），由 isDeclarableSkill 单独放行。
//       保留名两道（内部任务-116 / 内部未决-128 方案 B / 内部决策-023 修正案 2）：ad-hoc＝状态型
//       操作（装机/发布/环境运维，完成链走纯操作链）；ad-hoc-deliverable＝制品型
//       交付（PPT/文档/图表，完成链走制品链：verification→类型匹配评审→operation
//       →gate --deliverable-chain）——两者均为非开发任务显式绕行，不可用于开发任务。
// 作者：wangp  创建：2026-09-15  版权：MIT（见 workflow/LICENSE）
// 用法：被 hooks/routing-declare.mjs 与 scripts/check-routing.mjs 共同消费；直接运行无副作用（纯库）。

/** 路由表入口集合（成员校验与 lint 两环校验的数据源）。 */
export const ROUTING_ENTRY_SKILLS = new Set([
  'idea-review',
  'brainstorming',
  'plan-writing',
  'plan-review',
  'plan-execution',
  'root-cause-debugging',
  'code-review',
  'production-change',
  'verification',
  'branch-finishing',
  'retro',
  'health',
  'architecture-evolve',
  'external-radar',
  'learnings',
  'scout',
  'spike-run',
  'disposable-build',
  'team-governance',
  'algo-loop',
  'research-hypothesis',
  'experiment-design',
]);

/** ad-hoc 保留名的单一字面量（消费方引用本常量，不散写字符串；非 skill 目录，不参与 check-routing 目录检查）。 */
export const AD_HOC = 'ad-hoc';

/** ad-hoc-deliverable 保留名（内部任务-116 / 内部未决-128 方案 B）：制品型非开发任务的显式绕行出口。 */
export const AD_HOC_DELIVERABLE = 'ad-hoc-deliverable';

/** 保留名集合（两道：状态型 ad-hoc / 制品型 ad-hoc-deliverable；文案侧经 join 呈现）。 */
export const AD_HOC_NAMES = new Set([AD_HOC, AD_HOC_DELIVERABLE]);

/** 跨插件衔接 skill 集（P4，2026-10-10 内部任务-29 / 内部任务-103 P4；内部规则-12 扩集）：
 *  spec-gate 面的衔接 skill 可声明——声明时须凭 `--via <表内入口>` 标注来源路由行
 *  （via 必填且值必须为表内入口，校验在 routing-declare 声明侧；lease 体记 via 供审计）。
 *  路由表仍是唯一场景判定入口（B-M1-1）：衔接 skill 不设路由行、不参与 check-routing
 *  双向守卫（守卫只对照 ROUTING_ENTRY_SKILLS 与路由表目标列）。 */
export const BRIDGING_ENTRY_SKILLS = new Set(['spec-writing', 'spec-backfill', 'sdd-ddd-tdd', 'gate']);

/** 衔接 skill 判定（P4）：名称是否属跨插件衔接集（声明须另过 --via 校验）。 */
export function isBridgingSkill(name) {
  return BRIDGING_ENTRY_SKILLS.has(String(name ?? ''));
}

/**
 * 声明成员校验（B-M1-1 禁止第二判定源的机械兜底）：skill 名必须是路由表入口、
 * 保留名（ad-hoc 状态型 / ad-hoc-deliverable 制品型，内部任务-116）或跨插件衔接 skill
 * （衔接须凭 --via 溯源，P4 扩集），其余一律拒绝——声明写什么就被采信什么的时代结束。
 * @param {string} name 声明的 skill 名
 * @returns {boolean}
 */
export function isDeclarableSkill(name) {
  return AD_HOC_NAMES.has(name) || ROUTING_ENTRY_SKILLS.has(name) || BRIDGING_ENTRY_SKILLS.has(name);
}
