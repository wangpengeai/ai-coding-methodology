// 文件：learning.mjs
// 描述：结构化 learning 生命周期（内部需求-12 / 内部决策-012）——observed→validated→adopted
//       →superseded/retired，带 owner/scope/evidence/复验/supersession；轻量 经验记录
//       保留为输入层（只有需要团队约束的经验才提升进治理生命周期）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

/** 合法转移表：observed→validated→adopted，adopted 后两个平行终态（superseded 被取代 / retired 不再适用）；无状态首进 observed。 */
const TRANSITIONS = new Set(['>observed', 'observed>validated', 'validated>adopted', 'adopted>superseded', 'adopted>retired']);
const ALL_STATES = ['observed', 'validated', 'adopted', 'superseded', 'retired'];

export function promoteLearning(learning, to, extra = {}) {
  const from = learning.status ?? '';
  if (!TRANSITIONS.has(`${from}>${to}`)) {
    throw new Error(`生命周期非法转移：${from}→${to}（合法：observed→validated→adopted→{superseded|retired}；跳级/回退/终态再转移拒绝）`);
  }
  // 证据字段归一：evidence 是 promote 时刻的简写，规范字段名是 evidenceReferences
  const merged = { ...learning, status: to, ...extra };
  if (Array.isArray(extra.evidence) && !extra.evidenceReferences) {
    merged.evidenceReferences = [...(learning.evidenceReferences ?? []), ...extra.evidence];
    delete merged.evidence;
  }
  const next = merged;
  if (to === 'validated' && !(extra.validationMethod || next.validationMethod)) {
    throw new Error('validated 须带 validationMethod（怎么验证的）');
  }
  if (to === 'adopted' && !(extra.adoptedInto || next.adoptedInto)) {
    throw new Error('adopted 须带 adoptedInto（进入哪些 policy/template/eval）');
  }
  if ((to === 'superseded' || to === 'retired') && !(extra.supersededBy || next.supersededBy)) {
    throw new Error(`${to} 须带 supersededBy 或处置说明（历史不改写，关系显式）`);
  }
  return next;
}

/**
 * 校验 learning 记录形态。
 * @param {object} learning
 * @returns {Array<{message: string}>}
 */
export function validateLearning(learning) {
  /** @type {Array<{message: string}>} */
  const diags = [];
  if (!learning.learningId) diags.push({ message: '缺 learningId' });
  if (!learning.statement) diags.push({ message: '缺 statement（一句话经验）' });
  if (!learning.owner) diags.push({ message: '缺 owner' });
  if (!Array.isArray(learning.evidenceReferences) || learning.evidenceReferences.length === 0) {
    diags.push({ message: '无证据条目无效（禁止编造：observed 也要有 evidence 指向）' });
  }
  if (!ALL_STATES.includes(learning.status)) diags.push({ message: `非法状态：${learning.status}` });
  return diags;
}
