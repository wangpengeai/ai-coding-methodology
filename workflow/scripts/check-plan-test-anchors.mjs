// 文件：check-plan-test-anchors.mjs
// 描述：计划期「测试锚定」门禁 checker（内部决策-060 决策 6＋修正案 1/2；内部规则-19）——位置参数
//       `<plan.md>...`；exit 0 通过 / 1 违规 / 2 工具错误（2>1>0）；stdout JSON
//       `{ok,plans:[{file,ok,violations:[{rule,message,line}]}]}`。解析去 frontmatter/围栏/
//       HTML 注释后取唯一 H2「## 测试锚定」（须位于首个步骤标题前），逐行按三类合法行形态
//       校验：①可执行锚（四测试类别「路径#片段」或第五类 `命令冒烟｜<脚本路径>`）②派生锚
//       `派生｜<A-ID 列表>` ③非可执行类别＋同行理由；`- 说明：…` 旁注显式忽略；n/a 与整体
//       豁免各为单行且互斥；实现类计划禁用整体豁免（判定 import `planChangeSurface`，与
//       内部规则-17/内部规则-18 同源单点，不自造第三判定源）。检查器无写模式、不进 spec-gate core
//       校验器（内部规则-9 哈希冻结）。
// 作者：wangp  创建：2026-10-23  版权：MIT（见仓库 LICENSE）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { planChangeSurface } from '../hooks/routing-lib.mjs';
import {
  EXECUTABLE_CATEGORIES,
  NON_EXECUTABLE_CATEGORIES,
  PLAN_ID_RE,
  idExistsInSpecs,
  pathProblem,
  specIdIndex,
} from './lib/test-anchors-lib.mjs';
// 内部任务-348 批 D/内部未决-180①③：cleanForParse/STEP_HEADING/git 祖先收敛共享层 plan-text.mjs
import { cleanForParse, STEP_HEADING_RE as STEP_HEADING, gitAncestor } from './lib/plan-text.mjs';

const USAGE = '用法：node workflow/scripts/check-plan-test-anchors.mjs <plan.md>...';
const SECTION_H2 = /^##\s+测试锚定\s*$/;
const WAIVER_NA = /^-\s*测试锚定[：:]\s*n\/a\s*[｜|]\s*(.*)$/i;
const WAIVER_ALL = /^-\s*测试锚定[：:]\s*整体豁免\s*[｜|]\s*(.*)$/i;
const NOTE_LINE = /^-\s*说明[：:]/;
// 内部任务-348 批 D/内部未决-180②a：类别闭集正则由 lib 常量派生（字面量第二源删除；生成形态与
// 旧字面量等价——四测试类别｜命令冒烟｜非可执行三类别，顺序随常量数组）。派生 ID 展开
// （②b）不复用 lib expandIdRefs：其 matchAll 静默丢弃非匹配 token，与本门「垃圾 token 须
// 落 invalid-anchor 点名」的透传语义相反（内部模块-3 内部验收-19 注记＋垃圾 token 负例锁定）。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMAND_CATEGORY = '命令冒烟';
const TEST_CATEGORIES = EXECUTABLE_CATEGORIES.filter((c) => c !== COMMAND_CATEGORY);
const EXEC_TEST_RE = new RegExp(`^(${TEST_CATEGORIES.map(escapeRe).join('|')})｜([^#]+)#(.+)$`);
const COMMAND_RE = new RegExp(`^${escapeRe(COMMAND_CATEGORY)}｜(.+)$`);
const DERIVED_RE = /^派生｜(.+)$/;
const NON_EXEC_RE = new RegExp(`^(${NON_EXECUTABLE_CATEGORIES.map(escapeRe).join('|')})(?:｜(.+))?$`);

/**
 * 展开派生锚引用列表（支持 `内部验收-21/22/23` 紧凑形态；以「、,，空白」分隔条目）。
 * @param {string} text 派生锚引用串
 * @returns {string[]}
 */
function expandDerivedTokens(text) {
  const out = [];
  for (const token of String(text ?? '').split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^((?:[A-Za-z]{1,3}-(?:M\d+|[A-Za-z]{2,3})-))(\d+(?:\/\d+)*)$/.exec(token);
    if (m) for (const n of m[2].split('/')) out.push(`${m[1]}${n}`);
    else out.push(token);
  }
  return out;
}

class ToolError extends Error {}

// 内部任务-348/内部未决-180①③：cleanForParse 与 git 祖先已收敛 plan-text.mjs（本地副本删除）；

/**
 * 校验单个计划文件。
 * @param {string} fileArg 计划路径（命令行形态）
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
  // 内部任务-348/内部未决-180④：入口建一次全仓 ID 索引，逐行判定 O(1)（S2 门评审发现 4——第三参接线，
  // 替代逐 ID 全量重读规格树；无索引回退路径保留给 lib 直调消费方）
  const specIndex = specIdIndex(root);
  const clean = cleanForParse(text);
  const lines = clean.split('\n');
  const violations = [];
  const push = (rule, message, line = 1) => violations.push({ rule, message, line });

  const sectionIdx = [];
  lines.forEach((l, i) => { if (SECTION_H2.test(l)) sectionIdx.push(i); });
  if (sectionIdx.length === 0) push('missing-section', '缺 `## 测试锚定` H2 节（### 或围栏/注释内不计）');
  else if (sectionIdx.length > 1) push('duplicate-section', '`## 测试锚定` 节重复（须唯一）', sectionIdx[1] + 1);
  const firstStep = lines.findIndex((l) => STEP_HEADING.test(l));
  if (sectionIdx.length >= 1 && firstStep !== -1 && sectionIdx[0] > firstStep) {
    push('section-position', '`## 测试锚定` 节须位于首个步骤标题之前', sectionIdx[0] + 1);
  }

  if (sectionIdx.length === 1) {
    const start = sectionIdx[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    }
    const isImplementation = planChangeSurface(clean).isImplementation;
    const ids = new Set();
    let naLine = null;
    let waiverLine = null;
    let actionable = 0;
    for (let i = start + 1; i < end; i += 1) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;
      const lineNo = i + 1;
      if (NOTE_LINE.test(line)) continue; // 旁注行显式忽略
      const mNa = WAIVER_NA.exec(line);
      if (mNa) {
        if (naLine) push('invalid-line', 'n/a 行重复（须单行）', lineNo);
        naLine = { line: lineNo, reason: (mNa[1] ?? '').trim() };
        actionable += 1;
        continue;
      }
      const mWaiver = WAIVER_ALL.exec(line);
      if (mWaiver) {
        if (waiverLine) push('invalid-line', '整体豁免行重复（须单行）', lineNo);
        waiverLine = { line: lineNo, reason: (mWaiver[1] ?? '').trim() };
        actionable += 1;
        continue;
      }
      if (!line.startsWith('-')) { push('invalid-line', `测试锚定节仅接受「- 」行：${line}`, lineNo); continue; }
      const idm = /^-([^：:]+?)\s*[：:]\s*(.*)$/.exec(line);
      if (!idm) { push('invalid-line', `非法行形态（缺「- <ID>：<锚>」）：${line}`, lineNo); continue; }
      const id = idm[1].trim();
      const anchor = idm[2].trim();
      if (!PLAN_ID_RE.test(id)) { push('invalid-line', `非规格 ID 首字段：${id}`, lineNo); continue; }
      actionable += 1;
      if (ids.has(id)) push('duplicate-id', `测试锚定节 ID 重复：${id}`, lineNo);
      ids.add(id);
      if (!idExistsInSpecs(specIndex, id)) { push('dangling-id', `规格中不存在该 ID：${id}`, lineNo); continue; }
      // ① 可执行锚：四测试类别或命令冒烟
      const mExec = EXEC_TEST_RE.exec(anchor);
      if (mExec) {
        const path = (mExec[2] ?? '').trim();
        const fragment = (mExec[3] ?? '').trim();
        const p = pathProblem(path);
        if (p) push('invalid-anchor', `${id} 可执行锚路径非法：${p}`, lineNo);
        else if (!path.endsWith('.test.mjs')) push('invalid-anchor', `${id} 可执行锚路径须以 .test.mjs 结尾：${path}`, lineNo);
        else if (!fragment) push('invalid-anchor', `${id} 可执行锚缺用例标题片段`, lineNo);
        continue;
      }
      const mCmd = COMMAND_RE.exec(anchor);
      if (mCmd) {
        const path = (mCmd[1] ?? '').trim();
        const p = pathProblem(path);
        if (p) push('invalid-anchor', `${id} 命令冒烟锚路径非法：${p}`, lineNo);
        continue;
      }
      // ② 派生锚
      const mDer = DERIVED_RE.exec(anchor);
      if (mDer) {
        const tokens = expandDerivedTokens(mDer[1] ?? '');
        if (tokens.length === 0) { push('invalid-anchor', `${id} 派生锚缺引用 ID 列表`, lineNo); continue; }
        for (const t of tokens) {
          // 派生锚只指向验收条目链（A-ID 列表；内部决策-060 决策 2）
          if (!/^A-/.test(t)) push('invalid-anchor', `${id} 派生锚引用须为 A 行（验收条目）：${t}`, lineNo);
          else if (!PLAN_ID_RE.test(t) || !idExistsInSpecs(specIndex, t)) push('dangling-ref', `${id} 派生锚引用不存在：${t}`, lineNo);
        }
        continue;
      }
      // ③ 非可执行类别＋理由
      const mNon = NON_EXEC_RE.exec(anchor);
      if (mNon) {
        const reason = (mNon[2] ?? '').trim();
        if (reason.length < 8) push('invalid-anchor', `${id} 非可执行类别须同行给 ≥8 字理由`, lineNo);
        continue;
      }
      push('invalid-anchor', `${id} 锚描述不符合三类合法形态（可执行锚/派生锚/非可执行类别+理由）：${anchor}`, lineNo);
    }
    if (naLine && waiverLine) push('invalid-line', 'n/a 行与整体豁免行并存（互斥）', Math.max(naLine.line, waiverLine.line));
    // 整体豁免须为节内唯一 action 行（内部规则-19「与其他行并存即歧义」；对齐 design-input waiver-ambiguous 先例）
    if (waiverLine && (ids.size > 0 || naLine)) push('invalid-line', '整体豁免行不得与 ID 行或 n/a 行并存（歧义）', waiverLine.line);
    if (naLine && naLine.reason.length < 8) push('invalid-line', 'n/a 行理由须 ≥8 字', naLine.line);
    if (waiverLine) {
      if (waiverLine.reason.length < 8) push('invalid-line', '整体豁免行理由须 ≥8 字', waiverLine.line);
      if (isImplementation) push('waiver-not-allowed', '实现类计划禁用「测试锚定：整体豁免」', waiverLine.line);
    }
    if (actionable === 0) push('missing-lines', '测试锚定节无有效行（须至少一条 ID 行或 n/a/整体豁免行）', start + 1);
  }

  return { file: fileArg, ok: violations.length === 0, violations };
}

function main(argv) {
  if (argv.length === 0) {
    process.stderr.write(`check-plan-test-anchors: 缺少计划路径参数（${USAGE}）\n`);
    return 2;
  }
  const plans = [];
  try {
    for (const f of argv) {
      if (f.startsWith('-')) throw new ToolError(`未知参数：${f}（${USAGE}）`);
      plans.push(checkPlan(f));
    }
  } catch (e) {
    if (e instanceof ToolError) {
      process.stderr.write(`check-plan-test-anchors: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`check-plan-test-anchors: 工具错误：${e.message}\n`);
    return 2;
  }
  const ok = plans.every((p) => p.ok);
  process.stdout.write(`${JSON.stringify({ ok, plans }, null, 2)}\n`);
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
