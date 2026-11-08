// 文件：fixtures.mjs
// 描述：fixture 解释器（六族结构化＋F-7 opt_out）；oracle 比较覆盖现有键。
import { basename, dirname, join, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diagnostic, hasBlocking } from './diagnostics.mjs';
import { fencedBlockRanges, inFenced, TODO_TOKEN_PATTERN } from './markdown.mjs';
import { codePointCompare, readJsonStrict, readUtf8Text } from './pycompat.mjs';
import {
  checkAdr, checkAdrRegistry, checkDddAssets, checkFastTrack, checkInterfaceRegistry,
  checkInterfaces, checkOpenItems, checkTaskLedger,
} from './structured.mjs';
import { effectiveSuppressedScopes, restore, ruleIdsForNotes } from './optout.mjs';

const FAMILIES = ['adr', 'open_items', 'ddd', 'fast_track', 'task_ledger', 'interfaces', 'opt_out'];
const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let severityByRule = null;
function ruleSeverity(ruleId) {
  if (severityByRule === null) {
    severityByRule = new Map();
    try {
      for (const rule of readJsonStrict(join(CORE_ROOT, 'schemas/rule_registry.json')).rules ?? []) {
        severityByRule.set(rule.ruleId, rule.severity);
      }
    } catch { /* 注册表不可读时按 blocking 保守推导 */ }
  }
  return severityByRule.get(ruleId) ?? 'blocking';
}
function expectedExitFromRules(rules) {
  return rules.some((id) => ruleSeverity(id) === 'blocking') ? 1 : 0;
}

export function runMarkdownFixture(inputPath, rel, lineOffset = 0) {
  const diagnostics = [];
  const text = readUtf8Text(inputPath);
  const lines = text.split('\n');
  const ranges = fencedBlockRanges(text); // 内部任务-237/内部未决-152③：围栏内禁词不计
  for (let i = 0; i < lines.length; i += 1) {
    if (inFenced(i + 1, ranges)) continue;
    if (TODO_TOKEN_PATTERN.test(lines[i])) {
      diagnostics.push(diagnostic('RULE-OPEN-001', 'blocking', rel, i + 1 + lineOffset, '禁止自由文本 TODO/TBD；改用结构化未决项'));
    }
  }
  return { diagnostics, exitCode: hasBlocking(diagnostics) ? 1 : 0, meta: null };
}

function runOptOut(caseData, rel) {
  const data = readJsonStrict(join(caseData.caseDir, caseData.case.input));
  const records = Array.isArray(data) ? data : (Array.isArray(data.records) ? data.records : []);
  if (caseData.case.restoreScope) {
    const [remaining, stillSuppressed, notes] = restore(records, caseData.case.restoreScope);
    const ruleIds = ruleIdsForNotes(notes);
    return {
      diagnostics: ruleIds.map((id) => diagnostic(id, 'blocking', rel, 1, notes.join('；'))),
      exitCode: ruleIds.length ? 1 : 0,
      meta: { suppressed: [], notes, remainingCount: remaining.length, stillSuppressed },
    };
  }
  const [suppressed, notes] = effectiveSuppressedScopes(
    records, caseData.case.now ?? null, caseData.case.taskId ?? null, Boolean(caseData.case.explicitEnable),
  );
  const ruleIds = ruleIdsForNotes(notes);
  return {
    diagnostics: ruleIds.map((id) => diagnostic(id, 'blocking', rel, 1, notes.join('；'))),
    exitCode: ruleIds.length ? 1 : 0,
    meta: { suppressed: [...suppressed].sort(codePointCompare), notes, remainingCount: null, stillSuppressed: null },
  };
}

/** 执行单个 fixture；返回 {diagnostics, exitCode, meta}。 */
export function runFixture(caseDir) {
  let caseJson;
  try { caseJson = readJsonStrict(join(caseDir, 'case.json')); } catch {
    return { diagnostics: [diagnostic('RULE-CORE-002', 'blocking', 'case.json', 1, 'fixture case.json 不是合法 JSON')], exitCode: 2, meta: null };
  }
  const inputRel = caseJson.input;
  if (!inputRel) return { diagnostics: [diagnostic('RULE-CORE-002', 'blocking', 'case.json', 1, 'fixture 缺少 input 声明')], exitCode: 2, meta: null };
  const inputPath = join(caseDir, inputRel);
  let st;
  try { st = statSync(inputPath); } catch { st = null; }
  if (!st || !st.isFile()) return { diagnostics: [diagnostic('RULE-CORE-002', 'blocking', inputRel, 1, 'fixture 输入文件不存在')], exitCode: 2, meta: null };
  const rel = String(inputRel).replace(/\\/g, '/');
  const family = familyOf(caseDir);

  if (inputPath.endsWith('.md')) return runMarkdownFixture(inputPath, rel);
  if (family === 'opt_out') return runOptOut({ caseDir, case: caseJson }, rel);

  let data;
  try { data = readJsonStrict(inputPath); } catch {
    return { diagnostics: [diagnostic('RULE-CORE-002', 'blocking', rel, 1, 'fixture 输入文件不是合法 JSON')], exitCode: 2, meta: null };
  }
  let diagnostics = [];
  if (family === 'adr') {
    diagnostics = rel.endsWith('registry.json') ? checkAdrRegistry(data, rel) : checkAdr(data, rel);
  } else if (family === 'open_items') {
    diagnostics = checkOpenItems(data, rel, caseJson.mode ?? 'baseline');
  } else if (family === 'ddd') {
    diagnostics = checkDddAssets(data, rel, caseJson.level ?? 'strategic');
  } else if (family === 'fast_track') {
    diagnostics = checkFastTrack(data, rel, caseJson.category ?? 'production-incident', caseJson.now ?? null);
  } else if (family === 'task_ledger') {
    diagnostics = checkTaskLedger(data, rel, caseJson.now ?? null);
  } else if (family === 'interfaces') {
    diagnostics = rel.endsWith('registry.json') ? checkInterfaceRegistry(data, rel) : checkInterfaces(data, rel);
  } else {
    return { diagnostics: [diagnostic('RULE-CORE-002', 'blocking', 'case.json', 1, `未知 fixture 族: ${family}`)], exitCode: 2, meta: null };
  }
  return { diagnostics, exitCode: hasBlocking(diagnostics) ? 1 : 0, meta: null };
}

function multiset(list) {
  const counts = new Map();
  for (const item of list ?? []) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}
function sameMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** 返回不一致描述列表；空列表=与 oracle 一致。F-7：ruleId 计数参与、opt_out 现有键逐键比较。 */
export function compareWithOracle(caseDir, diagnostics, exitCode, meta = null) {
  const oracle = readJsonStrict(join(caseDir, 'oracle.json'));
  const mismatches = [];
  const expectedRules = oracle.expectedRuleIds ?? [];
  const actualRules = diagnostics.map((d) => d.ruleId);
  if (!sameMultiset(multiset(expectedRules), multiset(actualRules))) {
    mismatches.push(`ruleId 不一致: 期望 ${[...multiset(expectedRules)].map(([k, v]) => `${k}x${v}`).join(',')}，实际 ${[...multiset(actualRules)].map(([k, v]) => `${k}x${v}`).join(',')}`);
  }
  const expectedExit = oracle.expectedExitCode !== undefined ? oracle.expectedExitCode : expectedExitFromRules(expectedRules);
  if (expectedExit !== exitCode) {
    mismatches.push(`退出码不一致: 期望 ${expectedExit}，实际 ${exitCode}`);
  }
  if (meta) {
    const notes = meta.notes ?? [];
    if (Array.isArray(oracle.expectedSuppressedScopes)) {
      const expected = [...oracle.expectedSuppressedScopes].sort(codePointCompare);
      const actual = [...(meta.suppressed ?? [])].sort(codePointCompare);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push(`抑制 scope 不一致: 期望 ${expected}，实际 ${actual}`);
    }
    if (Array.isArray(oracle.expectedNotesContain)) {
      for (const needle of oracle.expectedNotesContain) {
        if (!notes.some((n) => String(n).includes(needle))) mismatches.push(`notes 缺少「${needle}」: ${notes.join('；')}`);
      }
    }
    if (oracle.expectedRemainingCount !== undefined && meta.remainingCount !== oracle.expectedRemainingCount) {
      mismatches.push(`剩余记录数不一致: 期望 ${oracle.expectedRemainingCount}，实际 ${meta.remainingCount}`);
    }
    if (oracle.expectedStillSuppressed !== undefined && meta.stillSuppressed !== oracle.expectedStillSuppressed) {
      mismatches.push(`仍被抑制不一致: 期望 ${oracle.expectedStillSuppressed}，实际 ${meta.stillSuppressed}`);
    }
  }
  return mismatches;
}

export function familyOf(caseDir) {
  return basename(dirname(caseDir));
}

export function discoverFixtureDirs(root) {
  const dirs = [];
  for (const family of FAMILIES) {
    const familyRoot = join(root, family);
    let entries;
    try { entries = readdirSync(familyRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(familyRoot, entry.name);
      try { if (statSync(join(dir, 'case.json')).isFile()) dirs.push(dir); } catch { /* 无 case.json */ }
    }
  }
  dirs.sort((a, b) => codePointCompare(a, b));
  return dirs;
}

/** 运行全部 fixture；返回 [失败数, 报告行]。 */
export function runAll(root) {
  let failures = 0;
  const report = [];
  for (const caseDir of discoverFixtureDirs(root)) {
    const { diagnostics, exitCode, meta } = runFixture(caseDir);
    const mismatches = compareWithOracle(caseDir, diagnostics, exitCode, meta);
    const name = `${basename(join(caseDir, '..'))}/${basename(caseDir)}`;
    if (mismatches.length) {
      failures += 1;
      report.push(`FAIL ${name}: ${mismatches.join('; ')}`);
    } else {
      report.push(`PASS ${name} (exit=${exitCode}, rules=${[...new Set(diagnostics.map((d) => d.ruleId))].sort(codePointCompare).join(',')})`);
    }
  }
  return [failures, report];
}
