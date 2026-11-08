// 文件：canonical-json.mjs
// 描述：canonical JSON 与完整性哈希（NFR-tg-integrity）——键码点排序、无空白、UTF-8；
//       integrity 哈希排除自身 integrityHash 字段（与 assurance common.mjs 同语义）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { createHash } from 'node:crypto';

/**
 * 规范性 JSON 字符串（排序键、无空白）。
 * @param {unknown} obj
 * @returns {string}
 */
export function canonicalJson(obj) {
  return JSON.stringify(sortValue(obj));
}

/** 递归排序对象键（数组保序）。 */
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

/**
 * 完整性哈希：sha256:<64hex>，排除 integrityHash 字段。
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
export function integrityHash(obj) {
  const { integrityHash: _drop, ...body } = obj ?? {};
  return `sha256:${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')}`;
}
