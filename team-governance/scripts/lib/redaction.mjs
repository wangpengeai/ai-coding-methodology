// 文件：redaction.mjs
// 描述：秘密扫描与脱敏（NFR-tg-privacy / 内部规则-4）——五类模式：凭据键值对、AWS Key、私钥块、
//       授权头、裸令牌前缀；治理报告/learning observed/replay 评测报告落盘前必经 redact
//       （内部任务-255 H12；唯一执行点本文件）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

// 五类模式（2026-09-19 评审修复批增第五类；2026-10-30 内部任务-255 顺修头注与枚举同步）：键值对/
// AWS Key/私钥块/授权头之外，补常见**裸令牌前缀**（无键名载体时的值形态）——ghp_/github_pat_/
// glpat-/sk-/xox?/eyJ(JWT)。**与 spec-gate/assurance/production_model.mjs 为有意分叉**：assurance 侧
// 保持自身七类模式与 golden/secret-patterns.json 锁定口径（内部任务-255 N-1 只统一「不回显」边界、不合并实现）
import { integrityHash } from './canonical-json.mjs';

const PATTERNS = [
  [/(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S{6,}/gi, '凭据键值对'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS-AccessKey'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '私钥块'],
  [/Authorization:\s*(?:Bearer\s+)?[A-Za-z0-9._-]{8,}/gi, '授权头'],
  [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '裸令牌前缀'],
];

/**
 * 递归扫描明文秘密，返回命中描述（空=干净）。
 * @param {unknown} obj
 * @returns {string[]}
 */
export function scanSecrets(obj) {
  /** @type {string[]} */
  const hits = [];
  (function walk(node) {
    if (typeof node === 'string') {
      for (const [re, label] of PATTERNS) {
        const m = node.match(re);
        if (m) hits.push(`${label}: 命中（不回显原文，长度 ${m[0].length}）`);
      }
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  })(obj);
  return hits;
}

/**
 * 递归脱敏：命中片段替换为 <redacted:label>；返回新对象（不改原对象）。
 * @param {unknown} obj
 * @returns {unknown}
 */
export function redact(obj) {
  if (typeof obj === 'string') {
    let s = obj;
    for (const [re, label] of PATTERNS) s = s.replace(re, `<redacted:${label}>`);
    return s;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redact(v);
    return out;
  }
  return obj;
}

/**
 * 脱敏后仍检出秘密（残余）或结构节含秘密时的拒绝信号（fail-closed；调用方按工具错退 2）。
 */
export class RedactionResidualError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedactionResidualError';
  }
}

/**
 * 脱敏+残余复核（写盘/输出前必经）。DEV255_FORCE_REDACT_RESIDUAL=1 为测试缝
 * （模拟「脱敏失效」以验证拒写路径；生产环境不设置）。残余命中抛 RedactionResidualError。
 * @param {unknown} obj
 * @returns {unknown}
 */
export function redactChecked(obj) {
  const skip = process.env.DEV255_FORCE_REDACT_RESIDUAL === '1'; // 测试缝（A-M14-* 用例；生产不设置）
  const safe = skip
    ? (obj !== null && typeof obj === 'object' ? JSON.parse(JSON.stringify(obj)) : obj) // 深拷贝：拒写测试不得污染调用方对象
    : redact(obj);
  if (scanSecrets(safe).length > 0) throw new RedactionResidualError('脱敏后仍检出秘密——拒绝落盘/输出');
  return safe;
}

/**
 * 报告类对象：脱敏＋残余复核＋结构节守卫＋integrityHash 重算。
 * 结构节（binding/sources/coverage）不参与改写：其中命中秘密即拒写（fail-closed）。
 * 必须保留结构节快照检查——redact 会先改写结构节内的命中串而使残余复核不再命中。
 * @param {unknown} obj
 * @returns {unknown}
 */
export function redactSigned(obj) {
  const structural = {};
  if (obj && typeof obj === 'object') {
    for (const k of ['binding', 'sources', 'coverage']) if (k in obj) structural[k] = obj[k];
  }
  const safe = redactChecked(obj);
  if (scanSecrets(structural).length > 0) throw new RedactionResidualError('结构节（binding/sources/coverage）含秘密——拒绝写报告（fail-closed）');
  if (safe && typeof safe === 'object' && 'integrityHash' in safe) {
    delete safe.integrityHash;
    safe.integrityHash = integrityHash(safe);
  }
  return safe;
}
