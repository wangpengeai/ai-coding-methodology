// 文件：capture_evidence.mjs
// 描述：命令证据捕获工具（Python capture_evidence.py 的 JS 实现）。F-2：脱敏族扩充、
//       command 逐 argv 脱敏、PEM 跨行块、Buffer 有损解码与替换计数、append 先验证后输出。
import { closeSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { emitJson, emitText, isMainModule, nowIso, pySplitLines } from '../core/pycompat.mjs';

const EXIT_TOOL = 2;
const EXIT_OK = 0;

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_PATTERNS = [
  // Authorization 整值替换（Bearer/Basic/Digest 或裸 token 都不得残留）
  /((["']?authorization["']?)\s*[:=]\s*["']?)[^"'\r\n,}]+/gi,
  /(["']?(?:api[_-]?key|secret|token|password|passphrase|credential)["']?\s*[:=]\s*)["']?[^\s"',}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI/Anthropic 形态的 sk- 键（允许连字符分段）；长度下界避免误伤 sk-learners 一类普通词
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g,
  /(\/\/)[^:/@\s]+:[^@\s]+@/g,
];
// S-3（内部任务-242 安全复审）：旗标脱敏按「归一化词元」判定，覆盖常见别名与组合短旗标——
// 宁可过度脱敏，不得让秘密落盘到 evidence/append。
const SENSITIVE_WORDS = new Set([
  'password', 'passwd', 'pwd', 'pass', 'passphrase', 'token', 'secret',
  'credential', 'credentials', 'bearer', 'auth', 'authorization', 'username', 'user', 'account', 'login',
  'key', 'apikey', 'accesskey', 'privatekey', 'secretkey',
]);
const SENSITIVE_TOKEN_RE = /password|passwd|pwd|passphrase|token|secret|credential|bearer|auth|username|user|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|apikey|accesskey|privatekey|secretkey/i;
const SHORT_SENSITIVE_FLAGS = new Set(['-u', '-U', '-p', '-P']);

function isSensitiveFlag(arg) {
  const text = String(arg);
  if (SHORT_SENSITIVE_FLAGS.has(text)) return true;
  if (/^-[^-]/.test(text)) {
    // 组合短旗标（-vpsecret）：簇内含敏感词或 p/P/u/U 即整体视为敏感（含粘连值形态）。
    const body = text.replace(/^-+/, '');
    return /[pPuU]/.test(body) || SENSITIVE_TOKEN_RE.test(body);
  }
  const name = text.replace(/^-+/, '').toLowerCase().replace(/_/g, '-');
  if (SENSITIVE_TOKEN_RE.test(name)) return true;
  return name.split('-').some((seg) => SENSITIVE_WORDS.has(seg));
}
function redactArg(arg) {
  const text = String(arg);
  // 粘连短旗标：-psecret / -PmyPass / -vpsecret（冻结旗标前缀，值整体替换）。
  const attachedShort = /^(-[A-Za-z]*[pPuU])(.+)$/.exec(text);
  if (attachedShort) return `${attachedShort[1]}[redacted]`;
  const eq = text.indexOf('=');
  if (eq > 0 && isSensitiveFlag(text.slice(0, eq))) return `${text.slice(0, eq)}=[redacted]`;
  return redactText(text);
}

/** 旗标是否已内嵌值（粘连短旗标/`=` 形态）——此时下一位不是它的值，链式脱敏不得吞。 */
function isAttachedValueFlag(arg) {
  const text = String(arg);
  if (/^(-[A-Za-z]*[pPuU])(.+)$/.test(text)) return true;
  const eq = text.indexOf('=');
  return eq > 0 && isSensitiveFlag(text.slice(0, eq));
}

/** 证据退出码（内部任务-242 C08）：Python 语义——正常退出取 returncode，被信号杀取**负信号号**；
 *  Node spawnSync 的 status=null＋signal 字符串向 Python 负 returncode 归一（不再一律记 1）。 */
export function evidenceExitCode(r) {  if (typeof r.status === 'number') return r.status;
  if (typeof r.signal === 'string' && r.signal !== '') {
    const num = osConstants.signals[r.signal];
    return typeof num === 'number' ? -num : -1;
  }
  return 1;
}

export function redactText(text) {
  let out = String(text).replace(PEM_BLOCK, '[redacted]');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => {
      if (typeof prefix !== 'string') return '[redacted]';
      if (prefix === '//') return '//[redacted]@';
      return `${prefix}[redacted]`;
    });
  }
  return out;
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function decodeLossy(buffer) {
  const strict = new TextDecoder('utf-8', { fatal: true });
  try { return { text: strict.decode(buffer), replaced: 0 }; } catch {
    const text = new TextDecoder('utf-8').decode(buffer);
    return { text, replaced: (text.match(/\uFFFD/g) ?? []).length };
  }
}

export function summarize(output, maxLines) {
  // 先做全文脱敏（PEM 跨行块），再按行截断
  const lines = pySplitLines(redactText(String(output)));
  const limit = Number.isFinite(maxLines) ? maxLines : 20;
  const kept = [];
  for (const line of lines) {
    kept.push(line);
    if (kept.length >= limit) break;
  }
  if (lines.length > kept.length) kept.push(`...（已截断，共 ${lines.length} 行）`);
  return kept.join('\n');
}

const USAGE = 'usage: capture_evidence.mjs --project PATH --criteria TEXT [--max-lines N] [--append PATH] -- CMD [ARGS...]';

function parseArgs(argv) {
  const out = { project: null, criteria: null, maxLines: 20, append: null, command: null, help: false };
  const valueOpts = new Set(['--project', '--criteria', '--max-lines', '--append']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--') { out.command = argv.slice(i + 1); break; }
    let name = a; let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (!valueOpts.has(name)) { out.command = argv.slice(i); break; }
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) throw new Error(`argument ${name}: expected one argument`);
      value = argv[i];
    }
    if (name === '--project') out.project = value;
    else if (name === '--criteria') out.criteria = value;
    else if (name === '--append') out.append = value;
    else {
      if (!/^-?\d+$/.test(value)) throw new Error(`argument --max-lines: invalid int value: '${value}'`);
      out.maxLines = Number(value);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    emitJson({ error: e.message });
    return EXIT_TOOL;
  }
  if (args.help) { emitText(USAGE); return EXIT_OK; }
  if (!args.project) { emitJson({ error: '缺少 --project' }); return EXIT_TOOL; }
  if (!args.criteria) { emitJson({ error: '缺少 --criteria' }); return EXIT_TOOL; }
  if (!args.command || args.command.length === 0) {
    emitJson({ error: '缺少被包装命令（-- CMD [ARGS...]）' });
    return EXIT_TOOL;
  }
  const project = resolve(args.project);
  try {
    if (!statSync(project).isDirectory()) {
      emitJson({ error: `项目目录不存在: ${args.project}` });
      return EXIT_TOOL;
    }
  } catch {
    emitJson({ error: `项目目录不存在: ${args.project}` });
    return EXIT_TOOL;
  }

  const r = spawnSync(args.command[0], args.command.slice(1), {
    cwd: project, encoding: null, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) {
    emitJson({ error: `命令执行失败: ${r.error.message}` });
    return EXIT_TOOL;
  }
  const stdout = decodeLossy(r.stdout ?? Buffer.alloc(0));
  const stderr = decodeLossy(r.stderr ?? Buffer.alloc(0));
  const combined = stdout.text + (stderr.text ? `\n${stderr.text}` : '');
  const replaced = stdout.replaced + stderr.replaced;
  const summary = summarize(combined, args.maxLines)
    + (replaced > 0 ? `\n[decoding: ${replaced} invalid UTF-8 bytes replaced]` : '');
  // S-3 复核二：以「原 argv」的敏感旗标位为单源——敏感旗标的下一位一律脱敏（含以 -/-- 开头的
  // 秘密值）；若下一位本身也是敏感旗标，则继续链式脱敏其值（修复「下一项像旗标就跳过」造成的
  // `--api-key -secret18` / `--password --hunter2` 泄漏）。粘连/`=` 形态的值已内嵌，不吞下一位。
  const original = args.command.slice();
  const flags = original.map((a) => isSensitiveFlag(a));
  const attached = original.map((a) => isAttachedValueFlag(a));
  const redactedArgs = original.map((a) => redactArg(a));
  for (let i = 0; i < original.length; i += 1) {
    if (!flags[i] || attached[i]) continue;
    let j = i + 1;
    if (j >= original.length) break;
    redactedArgs[j] = '[redacted]';
    while (j < original.length - 1 && flags[j]) {
      j += 1;
      redactedArgs[j] = '[redacted]';
    }
  }
  const evidence = {
    command: redactedArgs.map((a) => quoteArg(a)).join(' '),
    workingDirectory: String(args.project).replace(/\\/g, '/'),
    selectionCriteria: redactText(args.criteria),
    exitCode: evidenceExitCode(r),
    executedAt: nowIso(),
    keyOutputSummary: summary,
  };

  // append 先验证并落盘后输出（F-2）：写失败不产生“已输出但未落盘”的半态
  if (args.append) {
    const path = resolve(args.append);
    let fd = null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, 'a');
      writeSync(fd, `${JSON.stringify(evidence)}\n`);
      fsyncSync(fd);
    } catch (e) {
      emitJson({ error: `证据追加失败: ${e.message}` });
      return EXIT_TOOL;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  emitJson(evidence);
  return evidence.exitCode;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    emitJson({ error: `证据捕获内部错误: ${e.message}` });
    process.exitCode = EXIT_TOOL;
  }
}
