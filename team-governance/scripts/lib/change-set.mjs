// 文件：change-set.mjs
// 描述：Change Set（内部规则-1 / 内部接口-15 / 内部决策-014）——跨仓/monorepo 变更聚合实体；
//       canonical digest 是审批与租约的 subject 锚（字段变即变）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { randomUUID } from 'node:crypto';

import { integrityHash } from './canonical-json.mjs';

const RESOURCE_RE = /^(repo|path|interface|schema|environment):[A-Za-z0-9._/-]+(:.*)?$/;

/**
 * 构造 Change Set（纯对象；持久化由 CLI/store 层做）。
 * @param {{repos: Array<{repoId: string, base?: string, head?: string}>,
 *          resources: string[], order?: {merge?: string[], release?: string[], rollback?: string[]}}} def
 */
export function createChangeSet(def) {
  for (const r of def.resources) {
    if (!RESOURCE_RE.test(r)) throw new Error(`非法资源标识：${r}（五类：repo:/path:/interface:/schema/environment:）`);
  }
  return {
    schemaVersion: '1.0.0',
    changeSetId: `cs-${randomUUID().slice(0, 10)}`,
    repos: def.repos,
    resources: [...def.resources].sort(),
    order: def.order ?? {},
    status: 'draft',
  };
}

/**
 * canonical digest（排除自身；字段变化即变）。
 * @param {{repos: object[], resources: string[], order?: object}} cs
 */
export function changeSetDigest(cs) {
  return integrityHash({ repos: cs.repos, resources: [...cs.resources].sort(), order: cs.order ?? {} });
}
