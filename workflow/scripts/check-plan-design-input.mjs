// 文件：check-plan-design-input.mjs
// 描述：设计输入凭据 checker（内部规则-17 / 内部任务-174）——plan-review 受理核对的机器检查点。
//       只校验**形态/可定位/完整性**：`## 设计输入` 节存在且位置正确、角色行三态合法、
//       证据路径可定位（可选 #sha256 按 LF 归一复算）；不证明实例真实性/报告内容/落笔时序/
//       waived 授权真实性（由 plan-review 事实核查与用户确认承载）。
//       边界：workflow 过程纪律检查器，不进 spec-gate core 校验器（内部规则-9 哈希冻结），
//       不作为对全仓 docs/plans 的验证步骤；唯一调用方＝plan-review 受理核对。
// 用法：node workflow/scripts/check-plan-design-input.mjs <plan.md> [...]
// 退出码（优先级 2 > 1 > 0）：2＝工具/用法错误（stderr，无 JSON）；1＝存在违规；0＝全过。
// 作者：wangp  创建：2026-10-20  版权：MIT（见 workflow/LICENSE）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { planChangeSurface } from '../hooks/routing-lib.mjs';
import { validateEvidenceRef } from './lib/plan-evidence-ref.mjs';
// 内部任务-348 批 D/内部未决-180①③：cleanForParse/STEP_HEADING/git 祖先收敛共享层 plan-text.mjs
//（原本地第三份为非行保形态——违规行号以清洗后索引上报与原文件行号系统性偏移；
//  单源替换后行号口径对齐原文件〔改准方向，内部任务-348〕，围栏行号锁定用例在测试面）
import { cleanForParse, STEP_HEADING_RE as STEP_HEADING, gitAncestor } from './lib/plan-text.mjs';

const ROLES = ['code-explorer', 'code-architect'];
const STATUSES = ['completed', 'self', 'waived'];
const SECTION_H2 = /^##\s+设计输入\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const ROLE_LINE = /^-\s*(code-explorer|code-architect)\s*[:：]/;
const WAIVER_LINE = /^-\s*设计输入\s*[:：]/;

/** CLI/用法错误：退出码 2（与"计划有缺陷"区分，内部未决-140 同姿态）。 */
class ToolError extends Error {}

/** 参数解析（只收位置参数；未知 flag 即工具错误）。 */
function parseArgs(argv) {
  if (argv.length === 0) throw new ToolError('用法：node check-plan-design-input.mjs <plan.md> [...]');
  const files = [];
  for (const a of argv) {
    if (a.startsWith('-')) throw new ToolError(`未知参数：${a}（只接受计划路径位置参数）`);
    files.push(a);
  }
  return files;
}

// 内部任务-348/内部未决-180①③：cleanForParse 与 git 祖先已收敛 plan-text.mjs（本地第三份删除）

/**
 * 校验单条角色行（completed/self/waived 三态）。
 * @returns {Array<{rule:string,message:string,line:number}>}
 */
function validateRoleLine(kind, line, lineNo, { planAbs, root }) {
  const violations = [];
  const push = (rule, message) => violations.push({ rule, message, line: lineNo });
  const body = line.replace(ROLE_LINE, '');
  const fields = body.split(/[｜|]/).map((s) => s.trim());
  if (fields.length !== 3) {
    push('invalid-line', `角色行须恰 3 个字段（实例｜证据｜状态），实际 ${fields.length} 个`);
    return violations;
  }
  const [instance, evidence, status] = fields;
  if (!STATUSES.includes(status)) {
    push('invalid-status', `状态须为 completed/self/waived，实际「${status}」`);
    return violations;
  }
  if (status === 'completed') {
    if (instance === '') push('invalid-instance', 'completed 行缺实例标识');
    if (instance.includes('主会话自评')) push('status-mismatch', 'completed 行不得写「主会话自评」（应写 self）');
    if (evidence === '') {
      push('missing-evidence', 'completed 行须给可定位证据路径');
      return violations;
    }
    violations.push(...validateEvidence(evidence, lineNo, { planAbs, root }));
    return violations;
  }
  if (status === 'self') {
    if (instance === '') push('invalid-instance', 'self 行缺实例标识（主会话自评）');
    if (evidence === '' || !/依据|理由/.test(evidence)) {
      push('invalid-evidence', 'self 行须写自评依据与理由（含「依据/理由」）');
    }
    return violations;
  }
  // waived：须有用户裁决引文与时间
  if (!/用户/.test(evidence) || !/\d{4}-\d{2}-\d{2}/.test(evidence)) {
    push('invalid-evidence', 'waived 行须写用户显式裁决引文与时间（用户 + YYYY-MM-DD）');
  }
  return violations;
}

/** 证据路径可定位性与可选哈希复算（共享单源 `validateEvidenceRef`；内部任务-244 Q11）。 */
function validateEvidence(evidence, lineNo, { planAbs, root }) {
  const r = validateEvidenceRef(evidence, { planAbs, root });
  return r.ok ? [] : [{ rule: r.rule, message: r.message, line: lineNo }];
}

/**
 * 校验单个计划文件。
 * @param {string} fileArg 计划路径（命令行形态）
 * @returns {{file:string, ok:boolean, violations:Array}}
 * @throws {ToolError} 计划不可读
 */
function checkPlan(fileArg) {
  const planAbs = resolve(process.cwd(), fileArg);
  let text;
  try {
    text = readFileSync(planAbs, 'utf8');
  } catch (e) {
    throw new ToolError(`计划不存在或不可读：${fileArg}（${e.message}）`);
  }
  const root = gitAncestor(dirname(planAbs)) ?? process.cwd();
  const clean = cleanForParse(text);
  const lines = clean.split('\n');

  /** @type {Array<{rule:string,message:string,line:number}>} */
  const violations = [];
  const push = (rule, message, line = 1) => violations.push({ rule, message, line });

  // 节：唯一 H2、位置在首个步骤标题之前
  const sectionIdx = [];
  lines.forEach((l, i) => {
    if (SECTION_H2.test(l)) sectionIdx.push(i);
  });
  if (sectionIdx.length === 0) {
    push('missing-section', '缺 `## 设计输入` H2 节（### 或围栏/注释内不计）');
  } else if (sectionIdx.length > 1) {
    push('duplicate-section', '`## 设计输入` 节重复（须唯一）', sectionIdx[1] + 1);
  }
  const firstStepIdx = lines.findIndex((l) => STEP_HEADING.test(l));
  if (sectionIdx.length >= 1 && firstStepIdx !== -1 && sectionIdx[0] > firstStepIdx) {
    push('section-position', '`## 设计输入` 节须位于首个步骤/任务标题之前', sectionIdx[0] + 1);
  }

  // 节内角色行 / 整体豁免行
  let waiverLine = null;
  const roleKinds = [];
  if (sectionIdx.length === 1) {
    const start = sectionIdx[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (ANY_HEADING.test(lines[i])) {
        end = i;
        break;
      }
    }
    for (let i = start + 1; i < end; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      if (WAIVER_LINE.test(line)) {
        waiverLine = { text: line, line: i + 1 };
        continue;
      }
      if (ROLE_LINE.test(line)) {
        const kind = line.match(ROLE_LINE)[1];
        roleKinds.push(kind);
        violations.push(...validateRoleLine(kind, line, i + 1, { planAbs, root }));
      }
      // 非角色行（如「- 说明：…」）忽略不校验
    }
  }

  if (waiverLine) {
    const reason = waiverLine.text.replace(WAIVER_LINE, '').trim();
    if (roleKinds.length > 0) {
      push('waiver-ambiguous', '整体豁免行与角色行并存（歧义）', waiverLine.line);
    }
    if (reason === '') push('invalid-evidence', '整体豁免须写理由或用户裁决引文', waiverLine.line);
    if (planChangeSurface(clean).isImplementation) {
      push('waiver-not-allowed', '实现类计划不得以「纯文档」为由整体豁免（planChangeSurface 判为实现类）', waiverLine.line);
    }
    return { file: fileArg, ok: violations.length === 0, violations };
  }

  // 两个必需角色各恰一行
  for (const role of ROLES) {
    const count = roleKinds.filter((k) => k === role).length;
    if (count === 0) push('missing-role', `缺必需角色行：${role}`);
    if (count > 1) push('duplicate-role', `角色行重复：${role}`);
  }
  return { file: fileArg, ok: violations.length === 0, violations };
}

function main(argv) {
  let files;
  try {
    files = parseArgs(argv);
  } catch (e) {
    if (e instanceof ToolError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const plans = [];
  try {
    for (const f of files) plans.push(checkPlan(f));
  } catch (e) {
    if (e instanceof ToolError) {
      process.stderr.write(`check-plan-design-input: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const ok = plans.every((p) => p.ok);
  process.stdout.write(`${JSON.stringify({ ok, plans }, null, 2)}\n`);
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
