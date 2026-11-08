// 文件：algo-state.mjs
// 描述：.algo/ 五件状态读取客户端（内部接口-22 v1 唯一读取源）+ 全域 schema 诊断单源（内部任务-269 批）——
//       读侧不抛异常、不自动修（内部模块-18 内部规则-9：资产不静默改历史）；`explain*` 返回字段级错误（供 SessionStart
//       报修与 check-consistency 呈报），`validate*` 为布尔适配器；写侧复用同一校验（读写对称）。
//       退出码契约（内部接口-22 §3）：0=成功 / 1=校验或状态失败 / 2=用法错误。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：null-safe 单遍历诊断、corruptDetails/badLines 加法字段、§2a 字段补校验、
//           readJsonFile 类型化读取、badcases 逐件扫描（坏件不中断）、parseLedgerText 行级 schema 与坏行明细。
// 自检：node algo-loop/scripts/algo-state.mjs --selftest
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isMainModule } from './cli-args.mjs';

/** bad case 状态机常量（仅前向；单源导出供写侧复用，禁第二份副本）。 */
export const BADCASE_STATUSES = ['待归因', '已归因', '已修复验证', '闭环'];
/** 台账 decision 枚举（单源导出供写侧复用）。 */
export const LEDGER_DECISIONS = ['continue', 'rollback', 'raise-baseline', 'to-release'];
/** 终态：未闭环计数以状态表末项为准（禁第二份字面量；R21 单源化）。 */
const CLOSED_STATUS = BADCASE_STATUSES[BADCASE_STATUSES.length - 1];
/** ISO-8601 时间串形态（§2a `at` 口径：拒绝 Date.parse 的宽松扩展，如 `2026-1-1`）。 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86400000;

/** 非空字符串判定（单源导出，供写侧复用；R21 单源化）。 */
export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 普通对象判定（排除 null 与数组）。 */
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 指标形态诊断（contract.metrics 与 contract.guardrails 共用）。 */
function explainMetric(m, label) {
  const errors = [];
  if (!isPlainObject(m)) return [`${label} 须为对象`];
  if (!isNonEmptyString(m.name)) errors.push(`${label}.name 缺失或非字符串`);
  if (!isNonEmptyString(m.definition)) errors.push(`${label}.definition 缺失或非字符串`);
  if (m.direction !== 'higher-better' && m.direction !== 'lower-better') errors.push(`${label}.direction 须为 higher-better 或 lower-better`);
  if (!isNonEmptyString(m.unit)) errors.push(`${label}.unit 缺失或非字符串`);
  if (!isPlainObject(m.toolchain)) errors.push(`${label}.toolchain 须为 {command, version} 对象`);
  else {
    if (typeof m.toolchain.command !== 'string') errors.push(`${label}.toolchain.command 须为字符串`);
    if (typeof m.toolchain.version !== 'string') errors.push(`${label}.toolchain.version 须为字符串`);
  }
  return errors;
}

/**
 * project.json 诊断（§2a）。
 * @param {unknown} project
 * @returns {string[]} 字段级错误（空＝合法）
 */
export function explainProject(project) {
  if (!isPlainObject(project)) return ['project.json 须为对象'];
  const errors = [];
  if (project.schemaVersion !== 1) errors.push('schemaVersion 须为 1');
  if (!isNonEmptyString(project.projectId)) errors.push('projectId 缺失或非空字符串');
  if (!Number.isInteger(project.contractVersion) || project.contractVersion < 1) errors.push('contractVersion 须为正整数');
  return errors;
}

/**
 * contract.json 诊断（§2a；toolchain 空占位合法，首轮台账追加前由写侧/lint 把关）。
 * @param {unknown} contract
 * @returns {string[]}
 */
export function explainContract(contract) {
  if (!isPlainObject(contract)) return ['contract.json 须为对象'];
  const errors = [];
  if (contract.schemaVersion !== 1) errors.push('schemaVersion 须为 1');
  if (!Number.isInteger(contract.version) || contract.version < 1) errors.push('version 须为正整数');
  if (!Array.isArray(contract.metrics) || contract.metrics.length === 0) errors.push('metrics 须为非空数组');
  else contract.metrics.forEach((m, i) => errors.push(...explainMetric(m, `metrics[${i}]`)));
  if (typeof contract.baselineRef !== 'string') errors.push('baselineRef 须为字符串（立项期允许空串）');
  if (!isPlainObject(contract.targets)) errors.push('targets 须为对象');
  if (!Array.isArray(contract.guardrails)) errors.push('guardrails 须为数组');
  else contract.guardrails.forEach((g, i) => errors.push(...explainMetric(g, `guardrails[${i}]`)));
  return errors;
}

/**
 * baselines.json 诊断（§2a）：metrics 指标名→有限数值；B0 的 fromIteration 允许空串，
 * 其余条目必填非空串（引用存在性只在 lint/写侧校验——读侧不做引用核验）。
 * @param {unknown} baselines
 * @returns {string[]}
 */
export function explainBaselines(baselines) {
  if (!isPlainObject(baselines)) return ['baselines.json 须为对象'];
  const errors = [];
  if (baselines.schemaVersion !== 1) errors.push('schemaVersion 须为 1');
  if (!Array.isArray(baselines.entries)) return [...errors, 'entries 须为数组'];
  baselines.entries.forEach((e, i) => {
    const label = `entries[${i}]`;
    if (!isPlainObject(e)) {
      errors.push(`${label} 须为对象`);
      return;
    }
    if (!isNonEmptyString(e.id)) errors.push(`${label}.id 缺失或非字符串`);
    if (!isNonEmptyString(e.at)) errors.push(`${label}.at 缺失或非字符串`);
    if (!isNonEmptyString(e.reason)) errors.push(`${label}.reason 缺失或非字符串`);
    if (!isPlainObject(e.metrics)) errors.push(`${label}.metrics 须为对象`);
    else {
      for (const [name, value] of Object.entries(e.metrics)) {
        if (!isFiniteNumber(value)) errors.push(`${label}.metrics[${name}] 须为有限数值`);
      }
    }
    if (typeof e.fromIteration !== 'string') errors.push(`${label}.fromIteration 须为字符串`);
    else if (e.id !== 'b0' && !isNonEmptyString(e.fromIteration)) errors.push(`${label}.fromIteration 缺失或非字符串（B0 以外条目必填）`);
  });
  return errors;
}

/**
 * badcases/<id>.json 诊断（§2a；dataRefs 元素须为非空 {kind, ref} 对象）。
 * @param {unknown} body
 * @returns {string[]}
 */
export function explainBadcase(body) {
  if (!isPlainObject(body)) return ['badcase 文件须为对象'];
  const errors = [];
  if (!isNonEmptyString(body.id)) errors.push('id 缺失或非字符串');
  if (!isNonEmptyString(body.at)) errors.push('at 缺失或非字符串');
  if (!isNonEmptyString(body.symptom)) errors.push('symptom 缺失或非字符串');
  if (!isNonEmptyString(body.env)) errors.push('env 缺失或非空字符串');
  if (!Array.isArray(body.dataRefs)) errors.push('dataRefs 须为数组');
  else {
    body.dataRefs.forEach((ref, i) => {
      if (!isPlainObject(ref) || !isNonEmptyString(ref.kind) || !isNonEmptyString(ref.ref)) {
        errors.push(`dataRefs[${i}] 须为非空 {kind, ref} 对象`);
      }
    });
  }
  if (!BADCASE_STATUSES.includes(body.status)) errors.push(`status 须属 ${BADCASE_STATUSES.join('/')}`);
  return errors;
}

/**
 * 台账行诊断（§2a 六要素 + 类型口径，坏行定义单源）。
 * @param {unknown} row
 * @returns {string[]}
 */
export function explainLedgerRow(row) {
  if (!isPlainObject(row)) return ['台账行须为对象'];
  const errors = [];
  if (!isNonEmptyString(row.id)) errors.push('id 缺失或非字符串');
  if (!isNonEmptyString(row.at)) errors.push('at 缺失或非字符串');
  else if (!ISO_8601_RE.test(row.at) || !Number.isFinite(Date.parse(row.at))) errors.push('at 须为 ISO-8601 时间串');
  if (!isNonEmptyString(row.hypothesis)) errors.push('hypothesis 缺失或非字符串');
  if (!isNonEmptyString(row.change)) errors.push('change 缺失或非字符串');
  if (!isNonEmptyString(row.metricsRef)) errors.push('metricsRef 缺失或非字符串');
  if (!LEDGER_DECISIONS.includes(row.decision)) errors.push(`decision 须属 ${LEDGER_DECISIONS.join('/')}`);
  if (!isPlainObject(row.singleVariable)) errors.push('singleVariable 须为 {declared, note} 对象');
  else {
    if (typeof row.singleVariable.declared !== 'boolean') errors.push('singleVariable.declared 须为布尔');
    if (typeof row.singleVariable.note !== 'string') errors.push('singleVariable.note 须为字符串');
  }
  return errors;
}

/** 布尔适配器（既有调用面：只问合法与否）。 */
export function validateProject(project) {
  return explainProject(project).length === 0;
}
export function validateContract(contract) {
  return explainContract(contract).length === 0;
}
export function validateBaselines(baselines) {
  return explainBaselines(baselines).length === 0;
}
export function validateBadcase(body) {
  return explainBadcase(body).length === 0;
}
export function validateLedgerRow(row) {
  return explainLedgerRow(row).length === 0;
}

/**
 * 严格 JSON 读取（读侧写侧共用单源：存在性/可解析性由调用方按门禁处理，本函数只负责 parse）。
 * @param {string} path
 * @returns {any}
 */
export function readJsonStrict(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 类型化读取：区分「文件缺失」「不可读」「JSON 不可解析」三种坏态，不再用 null 兼作哨兵。
 * @param {string} path
 * @returns {{present: boolean, ok: boolean, value: any, error: string|null}}
 */
export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = err && err.code ? err.code : String(err && err.name ? err.name : err);
    if (code === 'ENOENT') return { present: false, ok: false, value: null, error: 'missing' };
    return { present: false, ok: false, value: null, error: `文件不可读（${code}）` };
  }
  try {
    return { present: true, ok: true, value: JSON.parse(text), error: null };
  } catch {
    return { present: true, ok: false, value: null, error: 'JSON 不可解析' };
  }
}

/**
 * 台账 JSONL 纯文本解析单源：合法行按 id 去重取首条；坏行（不可解析/六要素或类型不符）计数并留明细。
 * @param {string} text ledger.jsonl 全文
 * @returns {{rows: object[], badLines: number, badLineDetails: string[], ids: Set<string>}}
 */
export function parseLedgerText(text) {
  const rows = [];
  const seen = new Set();
  const badLineDetails = [];
  let badLines = 0;
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      badLineDetails.push(`第 ${i + 1} 行不可解析`);
      continue;
    }
    const errors = explainLedgerRow(parsed);
    if (errors.length > 0) {
      badLines += 1;
      badLineDetails.push(`第 ${i + 1} 行：${errors.join('；')}`);
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    rows.push(parsed);
  }
  return { rows, badLines, badLineDetails, ids: seen };
}

/** 读取迭代状态（内部接口-22 §2）——纯本地文件操作，不 spawn、不抛解析异常。 */
export function readAlgoState(root) {
  const algo = join(root, '.algo');
  const result = {
    present: false,
    contractVersion: null,
    currentBaseline: null,
    openBadcases: 0,
    lastIterationAgeDays: null,
    corrupt: [],
    corruptDetails: [],
    badLines: 0,
    reason: 'absent',
  };
  const addCorrupt = (file, errors) => {
    if (!result.corrupt.includes(file)) result.corrupt.push(file);
    const existing = result.corruptDetails.find((d) => d.file === file);
    if (existing) existing.errors.push(...errors);
    else result.corruptDetails.push({ file, errors: [...errors] });
  };

  const project = readJsonFile(join(algo, 'project.json'));
  if (!project.present && project.error === 'missing') return result; // absent：未立项
  const projectErrors = project.ok ? explainProject(project.value) : [project.error ?? 'JSON 不可解析'];
  if (projectErrors.length > 0) {
    result.reason = 'corrupt';
    addCorrupt('project.json', projectErrors);
    return result;
  }
  result.present = true;
  result.reason = '';
  result.contractVersion = project.value.contractVersion;

  const contract = readJsonFile(join(algo, 'contract.json'));
  const contractErrors = contract.ok ? explainContract(contract.value) : [contract.error === 'missing' ? '文件缺失' : (contract.error ?? 'JSON 不可解析')];
  if (contractErrors.length > 0) addCorrupt('contract.json', contractErrors);

  const baselines = readJsonFile(join(algo, 'baselines.json'));
  const baselineErrors = baselines.ok ? explainBaselines(baselines.value) : [baselines.error === 'missing' ? '文件缺失' : (baselines.error ?? 'JSON 不可解析')];
  if (baselineErrors.length > 0) addCorrupt('baselines.json', baselineErrors);
  else if (baselines.value.entries.length > 0) {
    const last = baselines.value.entries[baselines.value.entries.length - 1];
    result.currentBaseline = { id: last.id, metrics: last.metrics };
  }

  let ledgerText = null;
  try {
    ledgerText = readFileSync(join(algo, 'ledger.jsonl'), 'utf8');
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    addCorrupt('ledger.jsonl', [code === 'ENOENT' ? '文件缺失' : `文件不可读（${code}）`]);
  }
  if (ledgerText !== null) {
    const parsed = parseLedgerText(ledgerText);
    result.badLines = parsed.badLines;
    if (parsed.rows.length > 0) {
      let latest = -Infinity;
      for (const row of parsed.rows) {
        const t = Date.parse(row.at);
        if (Number.isFinite(t) && t > latest) latest = t;
      }
      if (Number.isFinite(latest)) result.lastIterationAgeDays = Math.max(0, Math.floor((Date.now() - latest) / DAY_MS));
    }
  }

  let badcaseNames = null;
  try {
    badcaseNames = readdirSync(join(algo, 'badcases'));
  } catch {
    addCorrupt('badcases/', ['目录缺失或不可读']);
  }
  if (badcaseNames !== null) {
    for (const name of badcaseNames) {
      if (!name.endsWith('.json')) continue;
      const file = join(algo, 'badcases', name);
      const body = readJsonFile(file);
      const errors = body.ok ? explainBadcase(body.value) : [body.error === 'missing' ? '文件缺失' : (body.error ?? 'JSON 不可解析')];
      if (errors.length > 0) {
        addCorrupt(`badcases/${name}`, errors);
        continue;
      }
      if (body.value.status !== CLOSED_STATUS) result.openBadcases += 1;
    }
  }
  return result;
}

/** 用法文本（CLI 用法错误面；导出供测试直接覆盖）。 */
export function usage() {
  console.error('用法：node algo-state.mjs --selftest');
  console.error('本脚本是只读客户端；写操作归 algo-write.mjs。');
}

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'algo-selftest-'));
  let failures = 0;
  try {
    const absent = readAlgoState(root);
    const checkAbsent = absent.present === false && absent.reason === 'absent';
    console.log(`${checkAbsent ? 'PASS' : 'FAIL'} absent 读取为未立项`);

    const algo = join(root, '.algo');
    mkdirSync(join(algo, 'badcases'), { recursive: true });
    writeFileSync(join(algo, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'st', contractVersion: 1 }));
    writeFileSync(join(algo, 'contract.json'), JSON.stringify({ schemaVersion: 1, version: 1, metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: '', version: '' } }], baselineRef: '', targets: {}, guardrails: [] }));
    writeFileSync(join(algo, 'ledger.jsonl'), '');
    writeFileSync(join(algo, 'baselines.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
    const okState = readAlgoState(root);
    const checkOk = okState.present === true && okState.corrupt.length === 0;
    console.log(`${checkOk ? 'PASS' : 'FAIL'} 合法五件读取为已立项`);

    writeFileSync(join(algo, 'project.json'), '{broken');
    const corruptState = readAlgoState(root);
    const checkCorrupt = corruptState.present === false && corruptState.reason === 'corrupt' && corruptState.corrupt.includes('project.json');
    console.log(`${checkCorrupt ? 'PASS' : 'FAIL'} 损坏声明读取为 corrupt`);
    failures = (checkAbsent ? 0 : 1) + (checkOk ? 0 : 1) + (checkCorrupt ? 0 : 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  console.log('SELFTEST OK algo-state');
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--selftest') selftest();
  else {
    usage();
    process.exit(2);
  }
}
