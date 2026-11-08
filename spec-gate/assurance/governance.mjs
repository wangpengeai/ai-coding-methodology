// 文件：governance.mjs
// 描述：JS 原生实现（历史 Python 实现已于阶段3b/内部任务-100 删除）——治理报告只读复核四态
//       （tampered/stale/passed/blocked）＋绑定 v1 只读重算。canonical 基座＝common.mjs
//       码点序（历史 Python 实现逐字节对齐优先；team-governance/scripts/lib/governance-store.mjs
//       的 stringify 序基座不改动——其值域收敛由 team-governance 的 default-policy-hosts 测试
//       与 内部任务-153 新增的 capability-matrix 对拍共同钉住）。
//       历史对拍面已随阶段3b 删除；本文件行为由 tests/governance.test.mjs 覆盖。
//       2026-10-25 内部任务-222：EXCLUDED_PREFIX 尾斜杠死分支修复——docs/plans 全树按 内部接口-18 §3 口径实际入排除（历史 Python 同缺陷；黄金夹具无 docs/plans 面；内部接口-11/18 双登记面哈希随本批步骤 6 重登）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { canonicalJsonBytes, codePointCompare, loadJson, readUtf8Strict, sha256File, sha256Prefix } from './common.mjs';

/** 治理报告路径（项目根相对）。 */
export const REPORT_PATH = '.ai-governance/runtime/reports/governance-report.json';
const CONFIG_REL = '.ai-governance/config.json';
// 内部任务-254 批 2（H5，内部验收-21）：排除面收窄——不再排除任意名为 runtime 的目录；只保留
// 运行态/依赖段（.ai-governance/runtime 仍由 .ai-governance 段整段排除）。与
// team-governance/scripts/lib/governance-store.mjs 同批同表（生产/消费两侧一致）。
const EXCLUDED_SEGMENT_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.workflow', '.scout', '.sdd', '.ai-governance']);
const EXCLUDED_PREFIX = 'docs/plans';
export const DEFAULT_ALLOWED_MODELS = [
  { provider: 'zcode', capabilities: ['code'] },
  { provider: 'dsh', capabilities: ['code'] },
  { provider: 'mcode', capabilities: ['code'] },
  { provider: 'kimi', capabilities: ['code'] },
];
const FIXED_SOURCES = {
  runs: '.ai-governance/runtime/runs',
  leases: '.ai-governance/runtime/leases/leases.json',
  approvals: '.ai-governance/runtime/approvals/approvals.jsonl',
  evals: '.ai-governance/runtime/evals',
  learnings: '.ai-governance/runtime/learnings',
  changeSet: '.ai-governance/runtime/change-set.json',
};

function integrityDigest(obj) {
  const body = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'integrityHash'));
  return sha256Prefix(canonicalJsonBytes(body));
}

/** 结构深比较（键序无关——Python dict/list == 语义；治理值域无浮点）。 */
function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && kb.every((k) => k in a) && ka.every((k) => deepEq(a[k], b[k]));
}

function loadConfigRaw(root) {
  let raw;
  try {
    raw = readUtf8Strict(join(root, CONFIG_REL));
  } catch {
    throw new Error(`治理配置缺失：${CONFIG_REL}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error(`治理配置不可解析（${CONFIG_REL}）：${e.message}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`治理配置根不是对象（${CONFIG_REL}）`);
  }
  return config;
}

function stringArray(config, key) {
  const raw = config[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
    throw new Error(`配置 ${key} 必须为字符串数组`);
  }
  return [...raw];
}

/** 政策归一（canonical 形态＝policyDigest 输入；内联 policy 权威＋旧顶层兼容＋同轴冲突拒绝）。 */
function normalizePolicy(config) {
  const inline = config.policy;
  const hasInline = inline !== null && typeof inline === 'object' && !Array.isArray(inline);
  if (config.policy != null && !hasInline) throw new Error(`配置 policy 必须为对象（${CONFIG_REL}）`);
  let src;
  if (hasInline) {
    for (const [top, inner] of [['enforcement', 'enforcement'], ['policyId', 'id'], ['policyVersion', 'version']]) {
      if (config[top] != null && inline[inner] != null && String(config[top]) !== String(inline[inner])) {
        throw new Error(`配置冲突（${CONFIG_REL}）：内联 policy.${inner}=${JSON.stringify(inline[inner])} 与旧顶层 ${top}=${JSON.stringify(config[top])} 不一致——请删除旧字段或改为一致`);
      }
    }
    src = inline;
  } else {
    src = { id: config.policyId, version: config.policyVersion, enforcement: config.enforcement };
  }
  return {
    id: src.id != null ? src.id : 'default',
    version: src.version != null ? src.version : 1,
    riskLevel: src.riskLevel != null ? src.riskLevel : 'medium',
    allowedModels: src.allowedModels != null ? src.allowedModels : DEFAULT_ALLOWED_MODELS,
    fallbacks: src.fallbacks != null ? src.fallbacks : [],
    enforcement: src.enforcement != null ? src.enforcement : 'relaxed',
  };
}

/** 配置引用的安全相对路径（绑定 v1：拒绝对路径/../链接出根；'/' 分隔返回）。 */
function safeRel(root, configured, value) {
  if (typeof value !== 'string' || value === '') throw new Error(`配置 ${configured} 含非法空路径`);
  if (value.startsWith('/') || (value.length > 1 && value[1] === ':') || value.startsWith('\\')) {
    throw new Error(`配置 ${configured} 拒绝绝对路径：${value}`);
  }
  const absP = resolve(root, value);
  const rel = relative(root, absP);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`配置 ${configured} 越界（不得逃出项目根）：${value}`);
  }
  // 链接出根：向上找最近存在祖先做 realpath，祖先已出根即整链越界
  let probe = absP;
  while (!existsSync(probe) && resolve(probe) !== resolve(root)) {
    probe = dirname(probe);
  }
  const realRoot = realpathSync(root);
  const realProbe = realpathSync(probe);
  const realRel = relative(realRoot, realProbe);
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new Error(`配置 ${configured} 经符号链接逃出项目根：${value}`);
  }
  return rel.split(sep).join('/');
}

/** 枚举 contentDigest 文件集（排除运行态/过程目录、符号链接、登记的报告产物；返回已排序）。 */
function iterSubjectFiles(root, extraExcluded) {
  const out = [];
  const walk = (relDir) => {
    const base = relDir ? join(root, relDir) : root;
    let names;
    try {
      names = readdirSync(base).sort(codePointCompare);
    } catch {
      return; // 不可读目录跳过（收集面失败由固定来源点名承载）
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (EXCLUDED_SEGMENT_NAMES.has(name)) continue;
      if (rel === EXCLUDED_PREFIX || rel.startsWith(`${EXCLUDED_PREFIX}/`)) continue;
      if (extraExcluded.has(rel)) continue;
      const absEntry = join(base, name);
      let st;
      try {
        st = lstatSync(absEntry);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // 链接不进 subject（防逃逸/环）
      if (st.isDirectory()) walk(rel);
      else if (st.isFile()) out.push(rel);
    }
  };
  walk('');
  out.sort(codePointCompare);
  return out;
}

function collectSources(root, evalSuiteFiles, evalReportFiles, learningFiles) {
  const inventory = new Map();
  const mark = (rel, present) => inventory.set(rel, present);
  mark(CONFIG_REL, true);
  const dirFiles = (relDir, suffix) => {
    const base = join(root, relDir);
    let st;
    try { st = statSync(base); } catch { st = null; }
    if (!st || !st.isDirectory()) return [];
    return readdirSync(base).filter((n) => n.endsWith(suffix)).map((n) => `${relDir}/${n}`).sort(codePointCompare);
  };
  const runs = dirFiles(FIXED_SOURCES.runs, '.json');
  // 内部任务-253：live/opt-in 证据不进 sources/inventory/coverage（与 team-governance 消费侧同一规则各自实现）；
  // 只按解析后的 mode==='live' 排除（文件名不作排除依据）；不可解析件保留进面；缺 mode 的报告按 replay 处理。
  // 先解析、后按 mode 判定（live manifest 自带 mode:"live"；文件名不得作为排除依据；不可解析件保留进面）
  const evals = dirFiles(FIXED_SOURCES.evals, '.json').filter((rel) => {
    try {
      return JSON.parse(readFileSync(join(root, rel), 'utf8')).mode !== 'live';
    } catch {
      return true; // 不可解析件保留进面（由后续校验点名），不静默缩小判定面
    }
  });
  const learnings = dirFiles(FIXED_SOURCES.learnings, '.jsonl');
  for (const rel of [...runs, ...evals, ...learnings]) mark(rel, true);
  const isFile = (p) => {
    try { return statSync(join(root, p)).isFile(); } catch { return false; }
  };
  mark(FIXED_SOURCES.leases, isFile(FIXED_SOURCES.leases));
  mark(FIXED_SOURCES.approvals, isFile(FIXED_SOURCES.approvals));
  mark(FIXED_SOURCES.changeSet, isFile(FIXED_SOURCES.changeSet));
  for (const rel of [...evalSuiteFiles, ...evalReportFiles, ...learningFiles]) {
    mark(rel, isFile(rel));
  }
  const ordered = [...inventory.entries()].sort(([a], [b]) => codePointCompare(a, b));
  const inventoryList = ordered.map(([path, present]) => ({ path, present }));
  const refs = [];
  for (const [path, present] of ordered) {
    if (present) refs.push({ path, sha256: `sha256:${sha256File(join(root, path))}` });
  }
  return { refs, inventoryList };
}

function changeSetDigest(changeSet) {
  const order = changeSet.order;
  const body = {
    repos: changeSet.repos ?? null, // 缺失→null 入 canonical（Python .get 缺省 None 同款）
    resources: [...changeSet.resources].sort(codePointCompare), // null 抛 TypeError 被外层吞→digest null（Python sorted(None) 同款）
    order: order ?? {},
  };
  return integrityDigest(body);
}

/**
 * 重读当前项目重算绑定 v1（subject 与 control sources）。黄金夹具对拍面：subject/refs/
 * inventory 与 原 Python 实现（迁移史见 内部决策-051）逐字一致（parity-stage1a）。
 * @param {string} root
 * @returns {{subject: string, contentDigest: string, changeSetDigest: string|null, policyDigest: string, approvalProfile: string, evalSuiteDigests: Array<string|null>, refs: Array<object>, inventory: Array<object>}}
 */
export function recomputeBinding(root) {
  const config = loadConfigRaw(root);
  const policy = normalizePolicy(config);
  const policyDigest = integrityDigest(policy);
  let approvalProfile = config.approvalProfile;
  approvalProfile = typeof approvalProfile === 'string' && approvalProfile !== '' ? approvalProfile : 'default';
  const evalSuiteFiles = stringArray(config, 'evalSuiteFiles').map((v) => safeRel(root, 'evalSuiteFiles', v));
  const evalReportFiles = stringArray(config, 'evalReportFiles').map((v) => safeRel(root, 'evalReportFiles', v));
  const learningFiles = stringArray(config, 'learningFiles').map((v) => safeRel(root, 'learningFiles', v));

  // contentDigest：全项目常规文件 [相对路径, 原始字节 sha256] 排序元组 canonical 哈希
  const excluded = new Set(evalReportFiles);
  const files = iterSubjectFiles(root, excluded);
  const tuples = files.map((rel) => [rel, `sha256:${sha256File(join(root, rel))}`]);
  const contentDigest = sha256Prefix(canonicalJsonBytes(tuples));

  // changeSetDigest：消费时重算（坏件按无锚处理）
  let changeSetDigestValue = null;
  const csPath = join(root, FIXED_SOURCES.changeSet);
  try {
    const persisted = loadJson(csPath);
    changeSetDigestValue = changeSetDigest(persisted.changeSet);
  } catch {
    changeSetDigestValue = null;
  }

  const isFileRel = (rel) => {
    try { return statSync(join(root, rel)).isFile(); } catch { return false; }
  };
  const evalSuiteDigests = evalSuiteFiles.map((rel) => (isFileRel(rel) ? `sha256:${sha256File(join(root, rel))}` : null));
  const subject = sha256Prefix(canonicalJsonBytes({
    contentDigest,
    changeSetDigest: changeSetDigestValue,
    policyDigest,
    approvalProfile,
    evalSuiteDigests,
  }));

  const { refs, inventoryList } = collectSources(root, evalSuiteFiles, evalReportFiles, learningFiles);
  return {
    subject,
    contentDigest,
    changeSetDigest: changeSetDigestValue,
    policyDigest,
    approvalProfile,
    evalSuiteDigests,
    refs,
    inventory: inventoryList,
  };
}

/**
 * 读取治理报告并复核（对齐 governance.check_governance）：返回 gate 的 governance 节形态
 * {present, status, blockingCount, warningCount, diagnostics}。required=False（缺省）缺失不
 * 阻断；required=True 缺失即阻断；坏 JSON＝tampered 档（与文件缺失不同档）。
 * @param {string} root
 * @param {{required?: boolean, allowLegacy?: boolean, now?: string}} [opts]
 * @returns {{present: boolean, status: string, blockingCount: number, warningCount: number, diagnostics: Array<object>}}
 */
export function checkGovernance(root, opts = {}) {
  const required = opts.required ?? false;
  const path = join(root, REPORT_PATH);
  let st = null;
  try { st = statSync(path); } catch { st = null; }
  if (!st || !st.isFile()) {
    return {
      present: false,
      status: 'not-configured',
      blockingCount: required ? 1 : 0,
      warningCount: 0,
      diagnostics: required ? [{
        ruleId: 'RULE-GATE-GOVERNANCE', severity: 'blocking', file: REPORT_PATH, line: 1,
        fixHint: '治理已声明 required 但报告缺失：先运行 team-governance gate（IF-COLLAB-18）',
      }] : [],
    };
  }
  let report;
  try {
    report = loadJson(path);
  } catch (e) {
    return {
      present: true,
      status: 'tampered',
      blockingCount: 1,
      warningCount: 0,
      diagnostics: [{
        ruleId: 'RULE-GATE-GOVERNANCE', severity: 'blocking', file: REPORT_PATH, line: 1,
        fixHint: `治理报告不可解析（工具错误语义）：${e.message}`,
      }],
    };
  }
  const [verdict, detail] = verifyReport(root, report, opts);
  if (verdict === 'passed') {
    return { present: true, status: 'passed', blockingCount: 0, warningCount: 0, diagnostics: [] };
  }
  const hints = {
    blocked: '治理报告存在阻断项：逐条处置 team-governance 诊断',
    stale: `治理报告与当前项目不一致（${detail}）：重出报告（team-governance gate）`,
    tampered: '治理报告 integrity 复核失败（内容被改动）：重出报告',
  };
  return {
    present: true,
    status: verdict,
    blockingCount: 1,
    warningCount: 0,
    diagnostics: [{
      ruleId: 'RULE-GATE-GOVERNANCE', severity: 'blocking', file: REPORT_PATH, line: 1,
      fixHint: hints[verdict] ?? '',
    }],
  };
}

function verifyReport(root, report, { allowLegacy = false, now }) {
  const recorded = report.integrityHash;
  if (typeof recorded !== 'string') return ['tampered', ''];
  const body = Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'integrityHash'));
  if (sha256Prefix(canonicalJsonBytes(body)) !== recorded) return ['tampered', ''];
  const binding = report.binding;
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    if (!allowLegacy) return ['stale', 'legacy 报告无真实 subject 锚（allow_legacy 未授权）'];
    return [report.status === 'passed' ? 'passed' : 'blocked', ''];
  }
  let current;
  try {
    current = recomputeBinding(root);
  } catch (e) {
    return ['stale', `当前输入重算失败：${e.message}`];
  }
  if (binding.subject !== current.subject) {
    return ['stale', 'subject 摘要与当前项目不一致（内容/政策/change-set/eval 套件变化）'];
  }
  const sources = report.sources;
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    return ['stale', '报告缺 sources 节'];
  }
  // 结构深比较（终审正确性发现 6：JSON.stringify 键序敏感，Python dict == 序无关——
  // 键序不同的等值报告不应一侧 stale 一侧 passed）
  if (!deepEq(sources.refs, current.refs)) {
    return ['stale', '控制输入清单变化（新增/删除/内容变化）'];
  }
  if (!deepEq(sources.inventory, current.inventory)) {
    return ['stale', '输入集 inventory 变化（新增/删除文件）'];
  }
  const validUntil = binding.validUntil;
  if (typeof validUntil === 'string' && validUntil !== '') {
    // UTC 日口径（内部任务-5 D）：与 Node governance-gate 的 toISOString().slice(0,10) 对齐
    const today = (now ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (validUntil < today) return ['stale', `validUntil 到界（${validUntil} < ${today}）`];
  }
  return [report.status === 'passed' ? 'passed' : 'blocked', ''];
}
