// 文件：cli.mjs
// 描述：cli.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 D1/D5 运行时归一·阶段3a W2）——assurance 外扩层 CLI
//       门面：19 个 argparse 子命令（14 可执行＋5 退役指引）的表驱动解析与分组 dispatch。
//       全局 --project-root 仅子命令前受理；`--flag value`/`--flag=value`；choices/required/
//       互斥组/条件必填/整数类型/`--change` 形态校验；**不实现 argparse 唯一前缀缩写**
//       （内部接口-11 已知边界）；--help 只承诺退出 0 与非 JSON 输出。
//       分组：A（12）revision/issue-verification/issue-code-review/issue-inspection/
//       issue-operation/prepare/chain-verify/finalize/archive-receipts/restore-receipts/
//       scout-register/scout-graduate → 既有实现；B gate→gate.mjs；C install-criteria→
//       install-criteria.mjs；D 5 个退役 scout 子命令→stderr 迁移指引＋退 2。
//       退出码沿 core 惯例：0=通过，1=内容/凭据阻断，2=工具/参数错误。错误映射单一入口
//       classifyCliError：ChainProfileError→2、CliToolError→2、CliValueError→1、
//       JSON.parse SyntaxError→2、Node fs 错误（有 code）→2、其他 Error→1。
//       路径基准（FB-2③）：_underRoot 镜像 cli.py:55-60 的 `Path.resolve()` 两分支——
//       绝对路径也 resolve、相对路径按 --project-root 再 resolve（不随调用方 cwd 漂移）。
//       已知怪癖逐字复刻（行为冻结）：finalize --plan 解析后忽略、archive-receipts --dry-run
//       在 --apply 下不被读取、gate production.status==="config-error" 退 2 其余阻断退 1。
//       stdout 只经 emitJson（JSON.stringify(obj,null,2)+"\n"，不混入指引）；finalize/
//       install-criteria 指引走 stderr。直跑守卫：process.exitCode = main(process.argv.slice(2))。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { archiveCandidates, archiveReceipts, restoreReceipts } from './archive.mjs';
import { looseRealpath, readUtf8Strict, sha256Hex, underRoot } from './common.mjs';
import {
  APPLICABILITY_VOCAB, SPEC_IMPACT_PLACEHOLDER, finalizeDelivery, prepareDelivery,
} from './delivery_reports.mjs';
import { runGate } from './gate.mjs';
import { installCriteria } from './install-criteria.mjs';
import {
  ChainProfileError, FIX_REVIEW_MODES, TASK_ID_RE, issueCodeReviewReceipt, issueInspectionReceipt,
  issueOperationReceipt, issueVerificationReceipt, normalizeFixReviewShape, verifyReceiptChain,
} from './receipts.mjs';
import { computeRevisionSet, revisionSetToDict } from './revision.mjs';
import { reValidChangeId } from './production_store.mjs';
import { graduate, register } from './scout_transactions.mjs';

/** 工具/参数/IO 错误（退出码 2），区别于内容与凭据阻断（退出码 1）。 */
export class CliToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliToolError';
  }
}

/** 内容/凭据阻断（退出码 1）；显式类型便于移植面与消费方区分。 */
export class CliValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliValueError';
  }
}

/**
 * 错误 → 退出码单一映射（对齐 原 Python 实现（迁移史见 内部决策-051）的 except 顺序与 JSONDecodeError 特判）：
 * ChainProfileError→2（工具/配置）、CliToolError→2、CliValueError→1、
 * JSON.parse SyntaxError→2、Node fs 错误（有 code）→2、其他 Error→1（内容/凭据阻断）。
 * @param {unknown} e
 * @returns {0|1|2}
 */
export function classifyCliError(e) {
  if (e instanceof ChainProfileError) return 2;
  if (e instanceof CliToolError) return 2;
  if (e instanceof CliValueError) return 1;
  if (e instanceof SyntaxError) return 2;
  if (e !== null && typeof e === 'object' && typeof e.code === 'string') return 2;
  return 1;
}

/** 写错误到 stderr 并返回退出码（main 的唯一错误出口；前缀区分工具错误与内容阻断）。 */
export function reportCliError(e, io) {
  const code = classifyCliError(e);
  const message = e !== null && typeof e === 'object' ? String(e.message ?? e) : String(e);
  if (code === 2) {
    if (e instanceof SyntaxError && !(e instanceof CliToolError)) {
      io.stderr(`assurance 工具错误：参数 JSON 非法：${message}\n`);
    } else {
      io.stderr(`assurance 工具错误：${message}\n`);
    }
  } else {
    io.stderr(`assurance：${message}\n`);
  }
  return code;
}

// ── 参数解析（表驱动；argparse 语义子集） ──────────────────────────────────────────────

/** 解析期错误（argparse 退出码 2 面；不进 classifyCliError 的异常族）。 */
class ParseError extends Error {}

/** 位置参数对：flag → dest。 */
function opt(flag, dest, extra = {}) {
  return { flag, dest, kind: 'str', ...extra };
}

/** store_true 旗标。 */
function flagOpt(flag, dest) {
  return { flag, dest, kind: 'flag' };
}

const CMD_HELP = {
  revision: '计算 RevisionSet',
  'issue-verification': '签发 verification 凭据',
  'issue-code-review': '签发 code-review 凭据',
  'issue-inspection': '签发 inspection-only 凭据',
  'issue-operation': '签发 operation 凭据（零变更操作型任务完成档第二环，ADR-023）',
  prepare: '生成交付草案（只能 partial）',
  'chain-verify': '校验凭据链',
  gate: '运行聚合 gate（零阻塞时签发 gate receipt）',
  'install-criteria': '生成装机收口判据（装入态三面探针，供 operation 凭据 criteria 使用）',
  finalize: '落最终交付报告',
  'archive-receipts': '.sdd 凭据归档（ADR-042/R-M7-16：阈值门控＋归档不删除＋号可见性不变量）',
  'restore-receipts': '从归档回放凭据（--task-id 或 --batch 二选一）',
  'scout-register': 'Scout 中央台账镜像登记（IF-COLLAB-12 v2 增强桥）',
  'scout-open': '（已退役 ADR-031）→ node scout/scripts/mode-lifecycle.mjs open',
  'scout-status': '（已退役 ADR-031）→ node scout/scripts/mode-lifecycle.mjs status',
  'scout-renew': '（已退役 ADR-031）→ node scout/scripts/mode-lifecycle.mjs renew',
  'scout-graduate': 'Scout 毕业（需 backfill/OPEN-n 证据引用；中央收敛+本地关闭+留痕单事务闭合）',
  'scout-abandon': '（已退役 ADR-031）→ node scout/scripts/mode-lifecycle.mjs abandon',
  'scout-recover': '（已退役 ADR-031）→ node scout/scripts/mode-lifecycle.mjs recover',
};

/** --change 形态校验：复用 production_store.reValidChangeId 单源（Python cli.py:38-44 同款；
 *  `$` 尾随换行语义由单源正则承载，避免内联正则与库侧静默漂移）。 */
function validChangeId(value) {
  return reValidChangeId(value);
}

/** 19 子命令规格（顺序对齐 cli.py argparse 声明；choices 与库侧词表同源）。 */
const COMMANDS = {
  revision: {
    options: [opt('--plan', 'plan')],
  },
  'issue-verification': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--evidence-file', 'evidenceFile'),
      opt('--profile', 'profile', { choices: ['full', 'scout-repro'], default: 'full' }),
      opt('--plan', 'plan'),
      opt('--scout-mode', 'scoutMode'),
      opt('--scout-disposition', 'scoutDisposition'),
    ],
  },
  'issue-code-review': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--verification', 'verification'),
      opt('--summary', 'summary', { default: '' }),
      opt('--plan', 'plan'),
      opt('--review-instances', 'reviewInstances', { kind: 'int', required: true }),
      opt('--review-mode', 'reviewMode', {
        choices: ['three-dim', 'single-instance', 'user-audit', 'exempt', 'deliverable'],
        default: 'three-dim',
      }),
      opt('--fix-review-mode', 'fixReviewMode', { choices: FIX_REVIEW_MODES, required: true }),
      opt('--fix-review-instances', 'fixReviewInstances', { kind: 'int', default: 0 }),
      opt('--fix-review-reason', 'fixReviewReason'),
      opt('--fix-review-base', 'fixReviewBase'),
      opt('--fix-review-diff-sha', 'fixReviewDiffSha'),
      opt('--exemption-reason', 'exemptionReason'),
      opt('--stage', 'stage'),
      opt('--review-round', 'reviewRound', { kind: 'int', default: 1 }),
      opt('--review-provenance', 'reviewProvenance'),
      opt('--fix-review-provenance', 'fixReviewProvenance'),
    ],
  },
  'issue-inspection': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--scope', 'scope', { required: true }),
    ],
  },
  'issue-operation': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--verification', 'verification', { required: true }),
      opt('--authorization-quote', 'authorizationQuote', { required: true }),
      opt('--authorization-scope', 'authorizationScope', { required: true }),
      opt('--criteria-file', 'criteriaFile', { required: true }),
      opt('--rollback', 'rollback', { required: true }),
      opt('--boundary', 'boundary', { required: true }),
      opt('--record', 'record', { required: true }),
      opt('--plan', 'plan'),
      opt('--risk-level', 'riskLevel', { choices: ['L1', 'L2'], default: 'L2' }),
    ],
  },
  prepare: {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--applicability-sdd', 'applicabilitySdd', { choices: APPLICABILITY_VOCAB.sdd, required: true }),
      opt('--applicability-ddd', 'applicabilityDdd', { choices: APPLICABILITY_VOCAB.ddd, required: true }),
      opt('--applicability-tdd', 'applicabilityTdd', { choices: APPLICABILITY_VOCAB.tdd, required: true }),
      opt('--applicability-reasons', 'applicabilityReasons', { required: true }),
      opt('--change-scope', 'changeScope', { default: '[]' }),
      opt('--receipt-refs', 'receiptRefs', { default: '[]' }),
      opt('--spec-impact', 'specImpact', { default: SPEC_IMPACT_PLACEHOLDER }),
    ],
  },
  'chain-verify': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--plan', 'plan'),
      flagOpt('--operation-chain', 'operationChain'),
      flagOpt('--deliverable-chain', 'deliverableChain'),
    ],
    mutex: [['--operation-chain', '--deliverable-chain']],
  },
  gate: {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--plan', 'plan'),
      flagOpt('--plan-check-block', 'planCheckBlock'),
      flagOpt('--operation-chain', 'operationChain'),
      flagOpt('--deliverable-chain', 'deliverableChain'),
      opt('--claim', 'claim'),
      opt('--change', 'change', {
        validate: validChangeId,
        validateMessage: (v) => `changeId 非法：${v}（须 ^CHG-[1-9][0-9]*$）`,
      }),
      opt('--change-context', 'changeContext'),
    ],
    mutex: [['--operation-chain', '--deliverable-chain']],
  },
  'install-criteria': {
    options: [
      opt('--marketplace', 'marketplace'),
      opt('--registry', 'registry'),
      opt('--home', 'home'),
      opt('--data-dir', 'dataDir'),
      opt('--host', 'host', { choices: ['zcode', 'mcode', 'kimi', 'dsh'] }),
      opt('--record-ref', 'recordRef', { required: true }),
    ],
  },
  finalize: {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--plan', 'plan'),
    ],
  },
  'archive-receipts': {
    options: [
      flagOpt('--dry-run', 'dryRun'),
      flagOpt('--apply', 'apply'),
    ],
  },
  'restore-receipts': {
    options: [
      opt('--task-id', 'taskId'),
      opt('--batch', 'batch'),
    ],
    requiredMutex: [['--task-id', '--batch']],
  },
  'scout-register': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--mode', 'mode', { choices: ['explore', 'disposable'], required: true }),
      opt('--expiry', 'expiry', { required: true }),
      opt('--transaction-id', 'transactionId', { required: true }),
      opt('--event', 'event', { choices: ['open', 'renew', 'abandon'], required: true }),
      opt('--disposition', 'disposition'),
      opt('--owner', 'owner'),
    ],
  },
  // 以下五命令随 内部决策-031 退役：保留参数面使合法调用也得到一致的退 2 迁移指引
  'scout-open': {
    options: [
      opt('--mode', 'mode', { choices: ['explore', 'disposable'], required: true }),
      opt('--expiry', 'expiry', { required: true }),
      opt('--task-id', 'taskId', { required: true }),
      opt('--owner', 'owner', { default: 'unknown' }),
    ],
  },
  'scout-status': { options: [] },
  'scout-renew': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--new-expiry', 'newExpiry', { required: true }),
    ],
  },
  'scout-graduate': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--evidence-refs', 'evidenceRefs', { required: true }),
    ],
  },
  'scout-abandon': {
    options: [
      opt('--task-id', 'taskId', { required: true }),
      opt('--disposition', 'disposition', { required: true }),
    ],
  },
  'scout-recover': { options: [] },
};

// 每个命令的 flag → 描述索引（重复构建无意义，模块初始化一次）。
for (const spec of Object.values(COMMANDS)) {
  spec.byFlag = new Map(spec.options.map((o) => [o.flag, o]));
}

/** Python int() 的常见字面量形态（空白/符号/下划线分隔）；失败返回 null。 */
function parsePyInt(raw) {
  const text = String(raw).trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) return null;
  const value = Number(text.replace(/_/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

/** 解析期 usage/error 输出（argparse 形态；测试只依赖退出码与关键词）。 */
function parseFailure(command, message, io) {
  const sub = command ? ` ${command}` : '';
  io.stderr(`usage: cli.mjs [--project-root PROJECT_ROOT]${sub} [options]\n`);
  io.stderr(`cli.mjs: error: ${message}\n`);
  return 2;
}

/** 全局段：--project-root 与命令名（argparse：全局选项只受理于子命令前）。 */
function parseTop(argv) {
  let projectRoot = '.';
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '-h' || token === '--help') return { help: true, top: true };
    if (token === '--') { i += 1; break; }
    if (token === '--project-root') {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new ParseError('argument --project-root: expected one argument');
      }
      projectRoot = next;
      i += 2;
      continue;
    }
    if (token.startsWith('--project-root=')) {
      projectRoot = token.slice('--project-root='.length);
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new ParseError(`unrecognized arguments: ${token}`);
    }
    break;
  }
  if (i >= argv.length) throw new ParseError('the following arguments are required: command');
  const command = argv[i];
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    throw new ParseError(`invalid choice: '${command}'`);
  }
  return { projectRoot, command, rest: argv.slice(i + 1) };
}

/** 子命令段：选项解析、required、choices/int/validate、互斥组。 */
function parseCommand(command, tokens) {
  const spec = COMMANDS[command];
  const values = {};
  for (const o of spec.options) {
    if (o.kind === 'flag') values[o.dest] = false;
    else if (Object.prototype.hasOwnProperty.call(o, 'default')) values[o.dest] = o.default;
  }
  const seen = new Set();
  const positionals = [];
  let endOptions = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!endOptions && token === '--') { endOptions = true; continue; }
    if (!endOptions && (token === '-h' || token === '--help')) return { help: true };
    if (!endOptions && token.startsWith('--')) {
      let flag = token;
      let inline;
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flag = token.slice(0, eq);
        inline = token.slice(eq + 1);
      }
      const option = spec.byFlag.get(flag);
      if (!option) throw new ParseError(`unrecognized arguments: ${token}`);
      if (option.kind === 'flag') {
        if (inline !== undefined) {
          throw new ParseError(`argument ${flag}: ignored explicit argument '${inline}'`);
        }
        values[option.dest] = true;
        seen.add(flag);
        continue;
      }
      let raw;
      if (inline !== undefined) {
        raw = inline;
      } else {
        const next = tokens[i + 1];
        // argparse：候选值是选项形态即报缺参（负数为数值面例外）
        if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/.test(next))) {
          throw new ParseError(`argument ${flag}: expected one argument`);
        }
        raw = next;
        i += 1;
      }
      if (option.choices !== undefined && !option.choices.includes(raw)) {
        const choices = option.choices.map((c) => `'${c}'`).join(', ');
        throw new ParseError(`argument ${flag}: invalid choice: '${raw}' (choose from ${choices})`);
      }
      if (option.kind === 'int') {
        const value = parsePyInt(raw);
        if (value === null) {
          throw new ParseError(`argument ${flag}: invalid int value: '${raw}'`);
        }
        values[option.dest] = value;
      } else {
        if (option.validate && !option.validate(raw)) {
          throw new ParseError(`argument ${flag}: ${option.validateMessage(raw)}`);
        }
        values[option.dest] = raw;
      }
      seen.add(flag);
      continue;
    }
    if (!endOptions && token.startsWith('-') && token !== '-') {
      throw new ParseError(`unrecognized arguments: ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length > 0) {
    throw new ParseError(`unrecognized arguments: ${positionals.join(' ')}`);
  }
  const missing = spec.options.filter((o) => o.required && !seen.has(o.flag)).map((o) => o.flag);
  if (missing.length > 0) {
    throw new ParseError(`the following arguments are required: ${missing.join(', ')}`);
  }
  for (const group of spec.mutex ?? []) {
    const present = group.filter((flag) => seen.has(flag));
    if (present.length > 1) {
      throw new ParseError(`argument ${present[present.length - 1]}: not allowed with argument ${present[0]}`);
    }
  }
  for (const group of spec.requiredMutex ?? []) {
    const present = group.filter((flag) => seen.has(flag));
    if (present.length === 0) {
      throw new ParseError(`the following arguments are required: ${group.join(' or ')}`);
    }
    if (present.length > 1) {
      throw new ParseError(`argument ${present[present.length - 1]}: not allowed with argument ${present[0]}`);
    }
  }
  return { values };
}

// ── 参数/路径助手（cli.py 同名函数逐行对齐） ────────────────────────────────────────────

/** `Path(p).resolve()`：looseRealpath 与 Path.resolve 同为「解析存在前缀、保留不存在尾段」。 */
function resolvePath(p) {
  return looseRealpath(String(p));
}

/** `_under_root`（cli.py:55-60）：common.underRoot 拼接后再 looseRealpath 归一
 *  （不随调用方 cwd 漂移；绝对路径原样）。 */
const resolveUnderRoot = (root, p) => resolvePath(underRoot(root, p));

/** Python `re.match` 的 `$` 语义：允许单个尾随换行。 */
function pyReMatch(re, value) {
  const s = String(value);
  return re.test(s) || (s.endsWith('\n') && re.test(s.slice(0, -1)));
}

/** Python repr 的单引号形态（taskId 报错消息用）。 */
function pyStrRepr(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 普通对象判定（对齐 Python isinstance(x, dict)）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python 类型名（证据加载报错同形）。 */
function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

/** Python `x or ""` 语义（空数组/空对象/0/false 均折空串）——applyability 理由折叠用。 */
function pyOrEmpty(value) {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'number') return value === 0 ? '' : value;
  if (typeof value === 'string') return value === '' ? '' : value;
  if (Array.isArray(value)) return value.length === 0 ? '' : value;
  if (typeof value === 'object') return Object.keys(value).length === 0 ? '' : value;
  return value;
}

/** 证据文件最小合法形态提示（三类报错共用）。 */
const EVIDENCE_FILE_HINT = 'JSON 数组，形如 [{"path": "tests/x.log", '
  + '"sha256": "sha256:<64 位十六进制>", "exitCode": 0}]';

/**
 * 证据引用从 JSON 文件读入（`_load_evidence`）：不存在/不可读、JSON 解析失败、字段缺省
 * 三分法报错；顶层数组；各项 path/sha256 非空字符串、exitCode 非布尔整数。
 * @param {string|undefined|null} path @param {string} root
 * @returns {Array<Record<string, unknown>>}
 */
export function loadEvidence(path, root) {
  if (!path) return [];
  const evidencePath = resolveUnderRoot(root, path);
  let raw;
  try {
    raw = readUtf8Strict(evidencePath);
  } catch (e) {
    throw new CliToolError(`证据文件不存在或不可读：${path}（${e.message}）。${EVIDENCE_FILE_HINT}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliToolError(`证据文件不是合法 JSON：${path}（${e.message}）。${EVIDENCE_FILE_HINT}`);
  }
  if (!Array.isArray(data)) {
    throw new CliToolError(`证据文件顶层必须是数组（收到 ${pyTypeName(data)}）。${EVIDENCE_FILE_HINT}`);
  }
  data.forEach((item, i) => {
    if (!isPlainObject(item)) {
      throw new CliToolError(`证据文件第 ${i + 1} 项必须是对象（收到 ${pyTypeName(item)}）。${EVIDENCE_FILE_HINT}`);
    }
    const missing = [];
    for (const key of ['path', 'sha256']) {
      const value = item[key];
      if (!(typeof value === 'string' && value.trim() !== '')) missing.push(key);
    }
    const exitCode = item.exitCode;
    // 布尔是 Python int 子类——显式排除（True 不是合法退出码）
    if (typeof exitCode === 'boolean' || !Number.isInteger(exitCode)) {
      missing.push('exitCode（须为整数）');
    }
    if (missing.length > 0) {
      throw new CliToolError(`证据文件第 ${i + 1} 项字段缺省：${missing.join('、')}。${EVIDENCE_FILE_HINT}`);
    }
  });
  return data;
}

/**
 * `gate --change-context` 装载（G02/内部任务-241）：变更上下文是「域状态+对象级证据」对象，
 * 与证据数组装载（loadEvidence）明确分流——旧实现误用数组装载器导致真实 ctx 必退 2。
 * @param {string|undefined|null} path @param {string} root
 * @returns {Record<string, unknown>}
 */
export function loadChangeContext(path, root) {
  if (!path) return {};
  const ctxPath = resolveUnderRoot(root, path);
  let raw;
  try {
    raw = readUtf8Strict(ctxPath);
  } catch (e) {
    throw new CliToolError(`--change-context 文件不存在或不可读：${path}（${e.message}）`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliToolError(`--change-context 不是合法 JSON：${path}（${e.message}）`);
  }
  if (!isPlainObject(data)) {
    throw new CliToolError(`--change-context 顶层必须是对象（收到 ${pyTypeName(data)}）`);
  }
  return data;
}

/**
 * CLI JSON 参数解析（`_loads_cli_arg`）：坏 JSON 以 CliToolError 退 2 并指名参数与期望形态。
 * @param {string} raw @param {string} flag
 * @returns {unknown}
 */
export function loadsCliArg(raw, flag) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const shape = {
      '--applicability-reasons': 'JSON 对象，键 sdd/ddd/tdd 各为字符串理由',
      '--change-scope': 'JSON 字符串数组',
      '--receipt-refs': 'JSON 字符串数组（凭据 receiptId 列表）',
      '--review-provenance': 'JSON 数组：[{role,instance,chain,state}]，chain=task:<taskId>',
      '--fix-review-provenance': 'JSON 数组：[{role,instance,chain,state}]，chain=task:<taskId>',
    }[flag] ?? '合法 JSON 值';
    throw new CliToolError(
      `参数 ${flag} 必须是合法 JSON（期望形态：${shape}；收到：${String(raw).slice(0, 60)}）：${e.message}`,
    );
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────────────

/** stdout 唯一出口：JSON + 换行（不混入指引文本）。 */
function emitJson(io, obj) {
  io.stdout(`${JSON.stringify(obj, null, 2)}\n`);
}

/** io 写入器适配：函数或 {write} 对象；缺省落 process.stdout/stderr。 */
function makeWriter(candidate, fallback) {
  if (typeof candidate === 'function') return candidate;
  if (candidate !== null && typeof candidate === 'object' && typeof candidate.write === 'function') {
    return (text) => candidate.write(text);
  }
  return (text) => fallback.write(text);
}

const FINALIZE_GUIDANCE = '【链尾指引】完成链已闭合：按 workflow 纪律记一条 learnings'
  + '（允许显式说「无收获」跳过，跳过要出口）；周期节点再考虑 retro。';

const INSTALL_GUIDANCE = '【收口指引】下一步：issue-verification → issue-operation --criteria-file <判据文件> '
  + '--risk-level L1 → gate --operation-chain（本判据 JSON 已输出到 stdout，可重定向存盘；'
  + '操作记录与判据落 docs/plans/evidence/<专用操作任务号>/（固定三件，任务号不复用'
  + '开发任务号），装机完成即提交推送）';

const RETIRED_GUIDANCE = '【已退役】scout 生命周期子命令随 ADR-031 退役：模式生命周期归 scout 本地——'
  + 'node scout/scripts/mode-lifecycle.mjs <open|renew|abandon|status|recover|migrate-v2|sync>';

// ── dispatch（cli.py:569-746 逐分支对齐） ─────────────────────────────────────────────

/** 链形态旗标 → chainProfile（operation/deliverable 互斥组已由解析器保证）。 */
function chainProfileOf(args) {
  if (args.deliverableChain) return 'deliverable';
  if (args.operationChain) return 'operation';
  return 'dev';
}

/**
 * 命令分发。
 * @param {string} root @param {Record<string, unknown>} args @param {{stdout: Function, stderr: Function}} io
 * @returns {0|1|2}
 */
function dispatch(root, args, io) {
  const command = args.command;

  if (command === 'revision') {
    const planPath = args.plan ? resolveUnderRoot(root, args.plan) : null;
    emitJson(io, revisionSetToDict(computeRevisionSet(root, planPath)));
    return 0;
  }

  if (command === 'issue-verification') {
    let scout = null;
    if (args.profile === 'scout-repro') {
      if (!args.scoutMode || !args.scoutDisposition) {
        io.stderr('scout-repro 档必须提供 --scout-mode 与 --scout-disposition\n');
        return 2;
      }
      scout = { mode: args.scoutMode, disposition: args.scoutDisposition };
    }
    // 空证据清单拒签——verification 的语义是「证据先于断言」，零证据不构成验证
    const evidence = loadEvidence(args.evidenceFile, root);
    if (evidence.length === 0) {
      throw new CliToolError(
        'issue-verification 拒绝签发：证据清单为空（--evidence-file 未提供或数组为空）'
        + '——verification 的语义是「证据先于断言」，零证据不构成验证；'
        + `请先运行验证命令并把证据数组经 --evidence-file 提交（${EVIDENCE_FILE_HINT}）`,
      );
    }
    const receipt = issueVerificationReceipt(root, args.taskId, evidence, {
      profile: args.profile,
      planPath: args.plan ? underRoot(root, args.plan) : null,
      scout,
    });
    emitJson(io, receipt);
    return 0;
  }

  if (command === 'issue-code-review') {
    if (!args.stage && !args.verification) {
      io.stderr('assurance 工具错误：issue-code-review 须给 --verification（任务级）；'
        + '阶段级评审请给 --stage\n');
      return 2;
    }
    if (args.reviewMode === 'exempt'
      && (!(args.exemptionReason && args.exemptionReason.trim()) || !args.plan || args.stage)) {
      io.stderr('assurance 工具错误：豁免形态（--review-mode exempt）须给 --exemption-reason <非空理由>'
        + '与 --plan <计划引用>，且不支持 --stage\n');
      return 2;
    }
    // 内部任务-191：receipt 2.1.0 实例 provenance 条件必填（exempt/user-audit 免；fix 环按实例数）
    const instanceMode = args.reviewMode !== 'exempt' && args.reviewMode !== 'user-audit';
    const provRaw = args.reviewProvenance;
    const haveProv = provRaw !== undefined && provRaw !== null && String(provRaw).trim() !== '';
    if (instanceMode && !haveProv) {
      io.stderr('assurance 工具错误：非豁免形态须给 --review-provenance <JSON 数组>'
        + '（每实例 {role,instance,chain,state}；chain=task:<taskId>；round=1 全 fresh）\n');
      return 2;
    }
    if (!instanceMode && haveProv) {
      io.stderr(`assurance 工具错误：reviewMode=${args.reviewMode} 不得携带 --review-provenance（人审/豁免无代理实例）\n`);
      return 2;
    }
    if (haveProv) loadsCliArg(provRaw, '--review-provenance');
    // 内部任务-193 A11：先做「模式×实例数」形态校验（内容阻断退 1），再要求 fix 环 provenance（退 2）——
    // 否则档位/实例数错误会被误报成「缺 --fix-review-provenance」，把调用方引向错误的修复方向。
    // 校验单源＝receipts.normalizeFixReviewShape（normalizeFixReview 内部复用同一真值表）。
    try {
      normalizeFixReviewShape({
        fixReviewMode: args.fixReviewMode,
        fixReviewInstances: args.fixReviewInstances,
      }, args.reviewMode);
    } catch (e) {
      io.stderr(`assurance：${e.message}\n`);
      return 1;
    }
    const fixInstances = Number(args.fixReviewInstances ?? 0);
    const fixProvRaw = args.fixReviewProvenance;
    const haveFixProv = fixProvRaw !== undefined && fixProvRaw !== null && String(fixProvRaw).trim() !== '';
    if (fixInstances > 0 && !haveFixProv) {
      io.stderr('assurance 工具错误：fixReviewInstances>0 须给 --fix-review-provenance <JSON 数组>\n');
      return 2;
    }
    if (fixInstances === 0 && haveFixProv) {
      io.stderr('assurance 工具错误：fixReviewInstances=0 不得携带 --fix-review-provenance\n');
      return 2;
    }
    if (haveFixProv) loadsCliArg(fixProvRaw, '--fix-review-provenance');
    const receipt = issueCodeReviewReceipt(root, args.taskId, args.verification ?? null,
      args.summary ?? '', {
        planPath: args.plan ? underRoot(root, args.plan) : null,
        reviewInstances: args.reviewInstances,
        reviewMode: args.reviewMode,
        reviewRound: args.reviewRound,
        reviewProvenance: haveProv ? provRaw : null,
        fixReviewProvenance: haveFixProv ? fixProvRaw : null,
        fixReviewMode: args.fixReviewMode,
        fixReviewInstances: args.fixReviewInstances,
        fixReviewReason: args.fixReviewReason ?? null,
        fixReviewBase: args.fixReviewBase ?? null,
        fixReviewDiffSha: args.fixReviewDiffSha ?? null,
        stage: args.stage ?? null,
        exemptionReason: args.exemptionReason ?? null,
      });
    emitJson(io, receipt);
    return 0;
  }

  if (command === 'issue-inspection') {
    emitJson(io, issueInspectionReceipt(root, args.taskId, args.scope));
    return 0;
  }

  if (command === 'issue-operation') {
    // --record 一并走 _under_root（与 criteria-file 同写法，统一基准覆盖被引用的先例本身）
    const recordAbs = resolveUnderRoot(root, args.record);
    let recordStat = null;
    try { recordStat = statSync(recordAbs); } catch { recordStat = null; }
    if (recordStat === null || !recordStat.isFile()) {
      io.stderr(`assurance 工具错误：操作记录文件不存在：${args.record}\n`);
      return 2;
    }
    const criteria = JSON.parse(readUtf8Strict(resolveUnderRoot(root, args.criteriaFile)));
    const recordRef = {
      path: args.record,
      sha256: `sha256:${sha256Hex(readFileSync(recordAbs))}`,
    };
    const receipt = issueOperationReceipt(root, args.taskId, args.verification, {
      authorizationQuote: args.authorizationQuote,
      authorizationScope: args.authorizationScope,
      verificationCriteria: criteria,
      rollback: args.rollback,
      effectiveBoundary: args.boundary,
      recordRef,
      planPath: args.plan ? underRoot(root, args.plan) : null,
      riskLevel: args.riskLevel,
    });
    emitJson(io, receipt);
    return 0;
  }

  if (command === 'prepare') {
    const reasons = loadsCliArg(args.applicabilityReasons, '--applicability-reasons');
    const reasonOf = (key) => {
      const value = isPlainObject(reasons) ? reasons[key] : null;
      return pyOrEmpty(value);
    };
    const applicability = {
      sdd: { conclusion: args.applicabilitySdd, reason: reasonOf('sdd') },
      ddd: { conclusion: args.applicabilityDdd, reason: reasonOf('ddd') },
      tdd: { conclusion: args.applicabilityTdd, reason: reasonOf('tdd') },
    };
    const draft = prepareDelivery(root, args.taskId, {
      applicability,
      changeScope: loadsCliArg(args.changeScope, '--change-scope'),
      receiptRefs: loadsCliArg(args.receiptRefs, '--receipt-refs'),
      specImpact: args.specImpact,
    });
    emitJson(io, draft);
    return 0;
  }

  if (command === 'chain-verify') {
    const [ok, reason] = verifyReceiptChain(root, args.taskId, {
      planPath: args.plan ? underRoot(root, args.plan) : null,
      chainProfile: chainProfileOf(args),
    });
    emitJson(io, { ok, reason });
    return ok ? 0 : 1;
  }

  if (command === 'gate') {
    let changeContext = null;
    if (args.changeContext) {
      // G02（内部任务-241）：变更上下文是对象形态（域状态+对象级证据），与证据数组装载分流；
      // 旧实现误用 loadEvidence（要求顶层数组+path/sha256/exitCode）导致真实 ctx 必退 2。
      changeContext = loadChangeContext(args.changeContext, root);
    }
    const report = runGate(root, args.taskId, {
      planPath: args.plan ? underRoot(root, args.plan) : null,
      planCheckBlock: args.planCheckBlock,
      claim: args.claim ?? null,
      change: args.change ?? null,
      changeContext,
      chainProfile: chainProfileOf(args),
    });
    emitJson(io, report);
    if (Number(report.blockingCount) === 0) return 0;
    // G05（内部任务-241）：任一节/顶层带 toolError 标记 → 工具错误退 2（不被内容阻断 1 吞并）。
    const hasToolError = Array.isArray(report.diagnostics) && report.diagnostics.some((d) => d && d.toolError === true);
    if (hasToolError) return 2;
    // config-error 归工具/配置错误（2），其余内容阻断（1）
    const production = report.sections?.production ?? {};
    return production.status === 'config-error' ? 2 : 1;
  }

  if (command === 'finalize') {
    emitJson(io, finalizeDelivery(root, args.taskId));
    // stdout 须保持纯 JSON（消费方按 JSON.parse 解析）；指引走 stderr
    io.stderr(`${FINALIZE_GUIDANCE}\n`);
    return 0;
  }

  if (command === 'archive-receipts') {
    // 缺省 dry-run 只列候选；--apply 显式执行且受阈值门控（--dry-run 在 apply 下不被读取）
    if (!args.apply) {
      emitJson(io, archiveCandidates(root));
      return 0;
    }
    emitJson(io, archiveReceipts(root));
    return 0;
  }

  if (command === 'restore-receipts') {
    emitJson(io, restoreReceipts(root, {
      taskId: args.taskId ?? null,
      batch: args.batch ?? null,
    }));
    return 0;
  }

  if (command === 'install-criteria') {
    emitJson(io, installCriteria(root, {
      marketplace: args.marketplace ?? null,
      registry: args.registry ?? null,
      home: args.home ?? null,
      dataDir: args.dataDir ?? null,
      host: args.host ?? null,
      recordRef: args.recordRef,
    }));
    io.stderr(`${INSTALL_GUIDANCE}\n`);
    return 0;
  }

  if (command.startsWith('scout-')) {
    if (command === 'scout-register') {
      const result = register(root, args.taskId, args.mode, args.expiry, args.transactionId,
        args.event, {
          disposition: args.disposition ?? null,
          owner: args.owner ?? null,
        });
      emitJson(io, result);
      return result.ok === true ? 0 : 1;
    }
    if (command === 'scout-graduate') {
      // 坏 JSON → SyntaxError（退 2）；非数组沿用既有实现行为（ok:false → 退 1）
      const evidenceRefs = JSON.parse(args.evidenceRefs);
      const result = graduate(root, args.taskId, evidenceRefs);
      emitJson(io, result);
      return result.ok === true ? 0 : 1;
    }
    // 退役指引（内部接口-12 v2 §4）：不静默执行，退 2 + 明示迁移去向
    io.stderr(`${RETIRED_GUIDANCE}\n`);
    return 2;
  }

  throw new CliToolError(`未知命令：${command}`);
}

// ── 帮助与入口 ───────────────────────────────────────────────────────────────────────

const TOP_HELP = `usage: cli.mjs [--project-root PROJECT_ROOT] <command> [options]

spec-gate assurance 完成链 CLI（ADR-007）

commands:
${Object.entries(CMD_HELP).map(([name, help]) => `  ${name.padEnd(22)} ${help}`).join('\n')}
`;

/** 子命令帮助（非 JSON 承诺）。 */
function commandHelp(command) {
  const spec = COMMANDS[command];
  const lines = [`usage: cli.mjs ${command} [options]`, '', CMD_HELP[command] ?? '', ''];
  for (const o of spec.options) {
    const required = o.required ? ' (required)' : '';
    const choices = o.choices ? ` (choices: ${o.choices.join(', ')})` : '';
    lines.push(`  ${o.flag}${required}${choices}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CLI 入口：返回 0/1/2（不 throw；解析错误/业务错误分别收敛）。
 * @param {string[]} argv 不含 node/脚本名
 * @param {{stdout?: Function|{write: Function}, stderr?: Function|{write: Function}}} [io]
 * @returns {0|1|2}
 */
export function main(argv = [], io = {}) {
  const writer = {
    stdout: makeWriter(io.stdout, process.stdout),
    stderr: makeWriter(io.stderr, process.stderr),
  };
  let top;
  try {
    top = parseTop(argv);
  } catch (e) {
    if (e instanceof ParseError) return parseFailure(null, e.message, writer);
    return reportCliError(e, writer);
  }
  if (top.help) {
    writer.stdout(TOP_HELP);
    return 0;
  }
  let parsed;
  try {
    parsed = parseCommand(top.command, top.rest);
  } catch (e) {
    if (e instanceof ParseError) return parseFailure(top.command, e.message, writer);
    return reportCliError(e, writer);
  }
  if (parsed.help) {
    writer.stdout(commandHelp(top.command));
    return 0;
  }
  const root = resolvePath(top.projectRoot);
  const args = { ...parsed.values, command: top.command };
  try {
    // 形态前置校验：taskId 直拼落盘目录段，穿越形态属参数错（退 2）
    if (args.taskId !== undefined && args.taskId !== null && !pyReMatch(TASK_ID_RE, String(args.taskId))) {
      throw new CliToolError(
        `taskId 非法：${pyStrRepr(args.taskId)}（须 ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$，`
        + '首字符字母数字——防凭据写到 receipts 目录之外）',
      );
    }
    return dispatch(root, args, writer);
  } catch (e) {
    return reportCliError(e, writer);
  }
}

/** 直跑判定（realpath 比对；测试/导入形态 argv[1] 指向测试文件）。 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return looseRealpath(process.argv[1]) === looseRealpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
