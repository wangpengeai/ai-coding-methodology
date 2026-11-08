// 文件：incident-source.mjs
// 描述：运行自察工件（内部接口-19）的 tg 侧只读源——pullIncidentRefs（open 记录
//       digest 提取，同 id 以末条为准、坏行跳过，与提供方读侧同语义）与
//       incidentExists（learning-note 证据存在性校验）。从 governance-cli 内嵌实现
//       迁出（2026-09-13 三维评审 S2/R-7/R-8 处置：CLI 保持薄门面，业务归 lib/）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonlTolerant } from './jsonl.mjs';

/** 读全部记录：同 id 以末条为准（状态变更即追加同 id 新行），坏行跳过；缺失返回 []。 */
function readAll(root) {
  const file = join(root, '.workflow', 'incidents.jsonl');
  if (!existsSync(file)) return { records: [], unavailable: false }; // 文件缺失＝确无异常源（非不可读）
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // 内部任务-257（P5-4）：文件存在但不可读 → unavailable（诚实降级，不冒充「无异常」）
    return { records: [], unavailable: true };
  }
  const byId = new Map();
  for (const d of readJsonlTolerant(text).records) { // 内部任务-257 P5-2：JSONL 解析单源
    if (!d || typeof d.id !== 'string' || !d.id) continue;
    byId.set(d.id, d);
  }
  return { records: [...byId.values()], unavailable: false };
}

/**
 * 提取 open 记录的 evidenceRefs（incident:<digest> 形态，digest 去重）。
 * 文件缺失按「确无异常源」处理；文件存在但不可读返回 unavailable（内部任务-257 P5-4：不冒充空）。
 * @param {string} root 项目根
 * @returns {{refs: string[], unavailable: boolean}}
 */
export function pullIncidentRefs(root) {
  const { records, unavailable } = readAll(root);
  const refs = new Set();
  for (const d of records) {
    if (d.status === 'open' && typeof d.digest === 'string' && d.digest) refs.add(`incident:${d.digest}`);
  }
  return { refs: [...refs], unavailable };
}

/**
 * 校验 incident id 在项目根工件中存在（悬空证据引用拒绝，内部规则-6「observed 必须有
 * 证据指向」的语义闭合）。
 * @param {string} root 项目根
 * @param {string} id 记录 id
 * @returns {boolean}
 */
export function incidentExists(root, id) {
  return readAll(root).records.some((d) => d.id === id);
}
