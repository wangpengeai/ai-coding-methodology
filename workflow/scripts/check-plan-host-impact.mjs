// 文件：check-plan-host-impact.mjs
// 描述：计划期多宿主适配评估门禁 checker（内部任务-199 批 2；内部决策-056 / 内部规则-18）——位置参数
//       `<plan.md>...`；exit 0 通过 / 1 违规 / 2 工具错误（2>1>0）；stdout JSON
//       `{ok,plans:[{file,ok,violations:[{rule,message,line}]}]}`。解析去 frontmatter/围栏/
//       HTML 注释后取唯一 H2「## 多宿主适配评估」（须位于首个步骤标题前），逐行按
//       `- <对象>：<状态词>｜<证据或理由>` 校验；四态闭集与豁免单行语义见计划 C-1。
//       不进 spec-gate core 校验器（内部规则-9 哈希冻结）。
// 作者：wangp  创建：2026-10-22  版权：MIT（见仓库 LICENSE）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { planChangeSurface } from '../hooks/routing-lib.mjs';
import { validateEvidenceRef } from './lib/plan-evidence-ref.mjs';
// 内部任务-348 批 D/内部未决-180①③：cleanForParse/STEP_HEADING 收敛共享层 plan-text.mjs（新门形态）；
// git 祖先同经共享层取（三维简洁性维发现 3：通道归一，re-export 单通道——与另两检查器一致）
import { cleanForParse, gitAncestor, STEP_HEADING_RE as STEP_HEADING } from './lib/plan-text.mjs';

const USAGE = '用法：node workflow/scripts/check-plan-host-impact.mjs <plan.md>...';
const SECTION_H2 = /^##\s+多宿主适配评估(?:\s*[（(].*)?$/;
const WAIVER = /^-\s*多宿主适配评估[：:]\s*整体豁免[｜|]\s*(.*)$/;
const STRICT_STATUSES = ['已适配并真机验证', '已适配未真机验证'];
const LOOSE_STATUSES = ['本批不适用', '无验证条件'];
const EVIDENCE_STATES = new Set(STRICT_STATUSES);

class ToolError extends Error {}

/** 归一状态词：剥尾随括注（全/半角），trim。 */
function normalizeStatus(raw) {
  return raw.trim().replace(/[（(][^（()）]*[)）]\s*$/, '').trim();
}

function resolveRoot(planAbs) {
  return gitAncestor(dirname(planAbs)) ?? process.cwd();
}

/** 证据路径可定位性与可选哈希复算（共享单源 `validateEvidenceRef`；内部任务-244 Q11）。 */
function checkEvidence(evidence, root, planAbs) {
  const r = validateEvidenceRef(evidence, { planAbs, root });
  return r.ok ? null : r.message;
}

function checkPlan(fileArg) {
  const planAbs = resolve(process.cwd(), fileArg);
  let text;
  try {
    text = readFileSync(planAbs, 'utf8');
  } catch (e) {
    throw new ToolError(`计划不存在或不可读：${fileArg}（${e.message}）`);
  }
  const root = resolveRoot(planAbs);
  const clean = cleanForParse(text);
  const lines = clean.split('\n');
  const violations = [];
  const push = (rule, message, line = 1) => violations.push({ rule, message, line });

  const sectionIdx = [];
  lines.forEach((l, i) => { if (SECTION_H2.test(l)) sectionIdx.push(i); });
  if (sectionIdx.length === 0) push('missing-section', '缺 `## 多宿主适配评估` H2 节');
  else if (sectionIdx.length > 1) push('duplicate-section', '`## 多宿主适配评估` 节重复', sectionIdx[1] + 1);
  const firstStep = lines.findIndex((l) => STEP_HEADING.test(l));
  if (sectionIdx.length >= 1 && firstStep !== -1 && sectionIdx[0] > firstStep) {
    push('section-position', '`## 多宿主适配评估` 节须位于首个步骤标题之前', sectionIdx[0] + 1);
  }

  if (sectionIdx.length === 1) {
    const start = sectionIdx[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    }
    let rowCount = 0;
    let waiverSeen = false;
    for (let i = start + 1; i < end; i += 1) {
      const line = lines[i].trim();
      if (line === '' || !line.startsWith('-')) continue;
      const lineNo = i + 1;
      const waiver = line.match(WAIVER);
      if (waiver) {
        waiverSeen = true;
        const reason = waiver[1].trim();
        if (reason === '') push('invalid-evidence', '整体豁免须写理由', lineNo);
        if (planChangeSurface(clean).isImplementation) {
          push('waiver-not-allowed', '实现类计划不得以「纯文档」为由整体豁免', lineNo);
        }
        continue;
      }
      rowCount += 1;
      const segs = line.replace(/^-\s*/, '').split(/[｜|]/).map((s) => s.trim());
      if (segs.length !== 2) {
        push('invalid-line', '行须为 `- <对象>：<状态词>｜<证据或理由>`（竖线恰 1 个）', lineNo);
        continue;
      }
      const m = segs[0].match(/^(.+?)[：:]\s*(.+)$/);
      if (!m) {
        push('invalid-line', '行须为 `- <对象>：<状态词>｜<证据或理由>`（缺对象/状态词分隔）', lineNo);
        continue;
      }
      const rawStatus = m[2].trim();
      let status = rawStatus;
      if (!STRICT_STATUSES.includes(status) && !LOOSE_STATUSES.includes(status)) {
        const stripped = normalizeStatus(rawStatus);
        if (LOOSE_STATUSES.includes(stripped) && stripped !== rawStatus) status = stripped;
      }
      const rest = segs[1];
      if (!STRICT_STATUSES.includes(status) && !LOOSE_STATUSES.includes(status)) {
        push('invalid-status', `状态词须属闭集（实际「${rawStatus}」；前两态不接受尾随括注）`, lineNo);
        continue;
      }
      if (EVIDENCE_STATES.has(status)) {
        const err = checkEvidence(rest, root, planAbs);
        if (err !== null) push('invalid-evidence', err, lineNo);
      } else if (rest.length < 4) {
        push('invalid-evidence', '「本批不适用」「无验证条件」须写 ≥4 字理由', lineNo);
      }
    }
    if (waiverSeen && rowCount > 0) {
      push('waiver-ambiguous', '整体豁免行与评估行并存（歧义）', sectionIdx[0] + 1);
    }
    if (!waiverSeen && rowCount === 0) {
      push('empty-section', '`## 多宿主适配评估` 节为空（须评估行或整体豁免行）', sectionIdx[0] + 1);
    }
  }

  return { file: fileArg, ok: violations.length === 0, violations };
}

function main(argv) {
  if (argv.length === 0) throw new ToolError(USAGE);
  const plans = argv.map((p) => checkPlan(p));
  const ok = plans.every((p) => p.ok);
  process.stdout.write(`${JSON.stringify({ ok, plans })}\n`);
  return ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e instanceof ToolError ? e.message : `工具错误：${e.message}`}\n`);
  process.exitCode = 2;
}
