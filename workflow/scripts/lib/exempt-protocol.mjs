// 文件：exempt-protocol.mjs
// 描述：内部任务-265 计划豁免协议纯函数库（内部决策-067 D1/D2/D4/D5）——逐字引文归一与正形、
//       声明形态、计划正文 marker 围栏解析、引文摘要/记录摘要分离、revoke 引文。
//       纯函数、零 fs、零第三方依赖；围栏语义与 gate/core markdown 由契约测试对拍。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';

/** 用户面 --exempt-scope 合法取值（plan=豁免计划编写与评审；review=仅豁免评审）。 */
export const EXEMPT_SCOPES = Object.freeze(['plan', 'review']);
/** 审计/gate 记录面合法 scope（revoked 仅由用户显式 --exempt-revoke 产生）。 */
export const EXEMPT_RECORD_SCOPES = Object.freeze(['plan', 'review', 'revoked']);
/** 逐字引文最大码点数（内部决策-067 D1.1）。 */
export const EXEMPT_QUOTE_MAX = 1000;

const LINE_SEP_RE = /[\r\n\u2028\u2029\v\f\x85\u001c-\u001e]/;
const PLAN_FACE_RE = /计划|规划|方案|流程|plan(?:ning)?|process|flow/i;
const REVIEW_FACE_RE = /评审|审查|复核|审|review|process|flow/i;
const REVOKE_FACE_RE = /撤销|退役|豁免|计划|评审|流程/;
const MARKER_RE = /^\s*豁免引文[ \t]*[：:][ \t]*(.*)$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const SPLITLINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

const sha12 = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

/**
 * 引文归一：trim、非空、单行、≤1000 码点。
 * @param {unknown} raw
 * @returns {{ok:true, quote:string} | {ok:false, reason:string}}
 */
export function normalizeExemptQuote(raw) {
  const rawText = String(raw ?? '');
  if (LINE_SEP_RE.test(rawText)) return { ok: false, reason: '豁免引文必须单行（含换行/行分隔符）' };
  const quote = rawText.trim();
  if (!quote) return { ok: false, reason: '豁免引文不能为空（须为用户逐字原话）' };
  if ([...quote].length > EXEMPT_QUOTE_MAX) {
    return { ok: false, reason: `豁免引文超过 ${EXEMPT_QUOTE_MAX} 码点上限` };
  }
  return { ok: true, quote };
}

/**
 * 引文正形：按 scope 点名被豁免的流程面（形态启发式，不验真）。
 * @param {string} quote
 * @param {string} scope
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkExemptQuoteFace(quote, scope) {
  if (!EXEMPT_SCOPES.includes(scope)) {
    return { ok: false, reason: `--exempt-scope 非法（收到「${String(scope)}」，合法取值 ${EXEMPT_SCOPES.join('|')}）` };
  }
  const re = scope === 'plan' ? PLAN_FACE_RE : REVIEW_FACE_RE;
  if (!re.test(String(quote ?? ''))) {
    return {
      ok: false,
      reason: `豁免引文未点名被豁免的流程面（scope=${scope}）——目标/推进指令不构成流程豁免（R-M1-12）；`
        + '请引用用户针对计划/评审/流程本身的明确表态，拿不准就当不豁免',
    };
  }
  return { ok: true };
}

/**
 * 撤销原话：先归一（单行/非空/≤1000）再点名撤销对象或流程面。
 * @param {unknown} raw
 * @returns {{ok:true, quote:string} | {ok:false, reason:string}}
 */
export function checkExemptRevokeQuote(raw) {
  const normalized = normalizeExemptQuote(raw);
  if (!normalized.ok) return normalized;
  if (!REVOKE_FACE_RE.test(normalized.quote)) {
    return {
      ok: false,
      reason: '撤销原话未点名撤销对象或流程面（撤销/退役/豁免/计划/评审/流程）——退役须由用户明确表态',
    };
  }
  return normalized;
}

/**
 * 声明形态：skill/exempt/scope/plan/planRoot 成对规则；不校验 src（src 单源在 CLI/租约库）。
 * @param {{skill?:string, exempt?:unknown, scope?:string, hasPlan?:boolean, hasPlanRoot?:boolean}} req
 * @returns {{ok:true, quote:string} | {ok:false, reason:string}}
 */
export function checkExemptDeclarationShape(req = {}) {
  if (req.skill !== 'plan-execution') {
    return { ok: false, reason: '--exempt 仅用于 plan-execution 的已评审计划前置豁免' };
  }
  const normalized = normalizeExemptQuote(req.exempt);
  if (!normalized.ok) return normalized;
  const scope = req.scope;
  if (!EXEMPT_SCOPES.includes(scope)) {
    return { ok: false, reason: `--exempt 必须同时标注 --exempt-scope（收到「${String(scope ?? '')}」，合法取值 ${EXEMPT_SCOPES.join('|')}）` };
  }
  if (scope === 'review') {
    if (!req.hasPlan) return { ok: false, reason: 'scope=review 必须给 --plan（计划已存在、仅豁免计划评审）' };
    if (req.hasPlanRoot) return { ok: false, reason: 'scope=review 不支持 --plan-root 跨仓计划（gate 无法做项目根相对锚比对）' };
  } else {
    if (req.hasPlan) return { ok: false, reason: 'scope=plan 禁止 --plan（计划编写已豁免，计划存在请用 scope=review）' };
    if (req.hasPlanRoot) return { ok: false, reason: 'scope=plan 禁止 --plan-root' };
  }
  const face = checkExemptQuoteFace(normalized.quote, scope);
  if (!face.ok) return face;
  return { ok: true, quote: normalized.quote };
}

/**
 * 计划正文 marker 解析：围栏外逐行匹配 `豁免引文：<原话>`（全角/半角冒号、行首空白）。
 * 围栏语义：三反引号/三波浪线开启；关闭须同字符且长度≥开启、关闭行 info 为空；未闭合到 EOF。
 * @param {string} text
 * @returns {{found:boolean, quote:string|null, line:number|null, count:number, conflict:boolean}}
 */
export function findExemptQuoteLine(text) {
  const lines = String(text ?? '').split(SPLITLINES_RE);
  const quotes = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    const fenceInfo = fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))
      ? { char: fenceMatch[1][0], length: fenceMatch[1].length, rest: fenceMatch[2] }
      : null;
    if (fence !== null) {
      if (fenceInfo && fenceInfo.char === fence.char && fenceInfo.length >= fence.length
        && fenceInfo.rest.trim() === '') {
        fence = null;
      }
      continue;
    }
    if (fenceInfo) {
      fence = fenceInfo;
      continue;
    }
    const marker = MARKER_RE.exec(line);
    if (marker) {
      const quote = marker[1].trim();
      if (quote) quotes.push({ quote, line: i + 1 });
    }
  }
  const distinct = new Set(quotes.map((q) => q.quote));
  return {
    found: quotes.length > 0,
    quote: quotes.length > 0 ? quotes[0].quote : null,
    line: quotes.length > 0 ? quotes[0].line : null,
    count: quotes.length,
    conflict: distinct.size > 1,
  };
}

/**
 * marker 捕获值与审计引文是否一致：trim 后全等（内部空白原样保留）。
 * @param {unknown} markerQuote @param {unknown} reason
 * @returns {boolean}
 */
export function exemptionQuoteMatches(markerQuote, reason) {
  return String(markerQuote ?? '').trim() === String(reason ?? '').trim();
}

/** gate quoteSha 口径：sha256(quote) 前 12 位 hex。 */
export function exemptQuoteDigest(quote) {
  return sha12(quote);
}

/** 审计 id/digest 口径：sha256(taskId|reason) 前 12 位 hex（沿用既有公式）。 */
export function exemptionRecordDigest(taskId, reason) {
  return sha12(`${String(taskId ?? '')}|${String(reason ?? '')}`);
}
