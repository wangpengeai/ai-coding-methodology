// 文件：plan-evidence-ref.mjs
// 描述：计划检查器共享的**证据引用校验**（内部任务-244 Q11/内部未决-180 拟议共享层的最小落地）——
//       `check-plan-design-input.mjs:124-173` 与 `check-plan-host-impact.mjs:67-88` 原为逐行
//       同构复制且防御形态已漂移（一处 `!m` 判断在正则恒匹配下不可达、一处 `m?.[1]` 静默兜底）。
//       本模块把「形态解析→仓库相对路径约束→计划自引用→存在/常规文件/非空→可选 #sha256 LF 复算」
//       收为单一事实源；调用方只负责把 `{rule,message}` 映射到各自违例面。
// 作者：wangp  创建：2026-10-28  版权：MIT（见 workflow/LICENSE）
// 用法：仅 node 内置模块；纯读（不写任何文件）。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 证据引用形态：`<仓库相对路径>[#sha256:<16..64 hex>]`。 */
const EVIDENCE_REF_RE = /^(.*?)(?:#sha256:([0-9a-fA-F]{16,64}))?$/;

/**
 * 证据引用校验（共享单源）：返回 `{ok:true, rel, declared, abs, digest}` 或
 * `{ok:false, rule, message}`；rule 供设计输入检查器映射违例类别，host-impact 只取 message。
 * @param {string} evidence 引用原文
 * @param {{planAbs: string, root: string}} ctx 计划绝对路径与所属根
 * @returns {{ok: true, rel: string, declared: string, abs: string, digest: string|null}
 *          | {ok: false, rule: string, message: string}}
 */
export function validateEvidenceRef(evidence, { planAbs, root }) {
  const m = EVIDENCE_REF_RE.exec(String(evidence ?? ''));
  // 正则对任意字符串恒可匹配（两组都可选）——无匹配仅防御空串/异常入参，语义为形态非法。
  if (m === null) return { ok: false, rule: 'invalid-evidence', message: `证据形态非法：${String(evidence)}` };
  const rel = (m[1] ?? '').trim();
  const declared = (m[2] ?? '').toLowerCase();
  if (rel === '') return { ok: false, rule: 'missing-evidence', message: '证据路径为空' };
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return { ok: false, rule: 'evidence-outside-root', message: `证据须为仓库根相对路径（拒绝绝对路径）：${rel}` };
  }
  const abs = resolve(root, rel);
  const relToRoot = relative(root, abs);
  if (relToRoot.startsWith('..') || relToRoot.split(sep).includes('..')) {
    return { ok: false, rule: 'evidence-outside-root', message: `证据越出计划所属根：${rel}` };
  }
  if (abs === planAbs) return { ok: false, rule: 'evidence-self-reference', message: '证据不得是计划自身' };
  if (!existsSync(abs)) return { ok: false, rule: 'evidence-missing', message: `证据不存在：${rel}` };
  if (!statSync(abs).isFile()) return { ok: false, rule: 'evidence-not-file', message: `证据不是常规文件：${rel}` };
  const buf = readFileSync(abs);
  if (buf.length === 0) return { ok: false, rule: 'evidence-empty', message: `证据为空文件：${rel}` };
  if (declared) {
    const lf = buf.toString('utf8').replace(/\r\n?/g, '\n');
    const digest = createHash('sha256').update(lf, 'utf8').digest('hex');
    if (!digest.startsWith(declared)) {
      return {
        ok: false,
        rule: 'hash-mismatch',
        message: `证据哈希失配：${rel}（声明 ${declared.slice(0, 16)}…，实算 ${digest.slice(0, 16)}…）`,
      };
    }
    return { ok: true, rel, declared, abs, digest };
  }
  return { ok: true, rel, declared, abs, digest: null };
}
