// 文件：evidence-gen.mjs
// 描述：受信写者工具——证据清单生成（内部决策-066 D2，内部任务-261；硬规则 9 白名单受信写者）。
//       只读计算输入文件 LF 归一 sha256，输出 [{path,sha256,exitCode}]；默认 dry-run 打印到
//       stdout，--write 才落盘 out 并「写后重读输入重算＋读回 out」双复核；自指文件（out 自身）
//       排除；schema/存在性/严格 UTF-8 校验；out 必须 canonical 后落在仓根内；审计追加
//       <状态根>/wf-evidence-gen.jsonl（失败行含 status:'failed' 与原因；>5000 行轮转）。
//       退出码：0 成功；1 校验/写入失败；2 用法错误。--selftest 内置自检（B-M8-4 同款）。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；无 shell 依赖；LF/UTF-8。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE =
  '用法：node evidence-gen.mjs --files <a,b,...> --out <证据 JSON 路径> --state-dir <目录> [--write] [--selftest]\n' +
  '  默认 dry-run（打印 JSON）；--write 落盘 out 并写后复核；自指文件（out 自身）自动排除。\n';

const AUDIT_FILE = 'wf-evidence-gen.jsonl';
const AUDIT_MAX_LINES = 5000;

/** 目标 canonical 形态（容忍目标不存在：对最近存在祖先 realpath 后拼回尾段）。 */
function canonicalTarget(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* 尾段可能不存在 */ }
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** canonical 目标是否落在仓根内（relative + isAbsolute，跨平台含 symlink 逃逸防护）。 */
function isWithinRoot(rootReal, targetCanon) {
  const rel = relative(rootReal, targetCanon);
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** 严格 UTF-8 解码（非法字节→拒）。 */
function readUtf8Strict(fileAbs, label) {
  let st;
  try { st = statSync(fileAbs); } catch { throw new Error(`输入文件不存在：${label}`); }
  if (!st.isFile()) throw new Error(`输入不是常规文件：${label}`);
  const buf = readFileSync(fileAbs);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`输入含非法 UTF-8 字节：${label}`);
  return text;
}

/** LF 归一 sha256（与证据消费端口径一致）。 */
function lfSha(text) {
  return 'sha256:' + createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

/** 审计行追加＋>5000 行轮转（保留尾部 2500 行）；失败只 stderr 警示。 */
function appendAudit(stateDir, record) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, AUDIT_FILE);
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > AUDIT_MAX_LINES) {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${lines.slice(-Math.floor(AUDIT_MAX_LINES / 2)).join('\n')}\n`, 'utf8');
        renameSync(tmp, file);
      }
    } catch { /* 轮转失败不影响主流程 */ }
  } catch (err) {
    process.stderr.write(`[evidence-gen] 审计写失败（不阻断）：${err?.message ?? err}\n`);
  }
}

/** 解析 argv（未知旗标/缺值 → 用法错误）。 */
function parseArgs(argv) {
  const args = { write: false, selftest: false, help: false, files: null, out: null, stateDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') args.write = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--files' || a === '--out' || a === '--state-dir') {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} 缺值` };
      if (a === '--files') args.files = v; else if (a === '--out') args.out = v; else args.stateDir = v;
    } else return { error: `未知参数：${a}` };
  }
  return args;
}

/** 生成条目（schema/存在性/严格 UTF-8/仓内；自指排除按 canonical 比较）。 */
function buildEntries(filesArg, outPath, rootReal) {
  const raw = String(filesArg ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) throw new Error('--files 不得为空');
  const outCanon = outPath === null ? null : canonicalTarget(resolve(rootReal, outPath));
  if (outCanon !== null && !isWithinRoot(rootReal, outCanon)) throw new Error(`--out 越出工作目录：${outPath}`);
  const entries = [];
  for (const rel of raw) {
    const abs = canonicalTarget(resolve(rootReal, rel));
    if (!isWithinRoot(rootReal, abs)) throw new Error(`输入路径越出工作目录：${rel}`);
    if (outCanon !== null && abs === outCanon) continue; // 自指排除
    const text = readUtf8Strict(abs, rel);
    entries.push({ path: rel.split('\\').join('/'), sha256: lfSha(text), exitCode: 0 });
  }
  if (entries.length === 0) throw new Error('自指排除后条目为空');
  return entries;
}

/** 写后复核：重读输入重算 sha（防 TOCTOU；复用同一 out 排除保持自指语义）＋读回 out 逐项比对。 */
function verifyAfterWrite(rootReal, outCanon, filesArg, outPath, entries) {
  const recomputed = buildEntries(filesArg, outPath, rootReal);
  if (JSON.stringify(recomputed) !== JSON.stringify(entries)) throw new Error('写后重算不符：输入在哈希后发生变化');
  let back;
  try { back = JSON.parse(readFileSync(outCanon, 'utf8')); } catch (err) { throw new Error(`写后复核读取失败：${err.message}`); }
  if (JSON.stringify(back) !== JSON.stringify(entries)) throw new Error('写后复核不符：out 内容与重算结果不一致');
  if (process.env.WF_EVIDENCE_GEN_INJECT_VERIFY_MISMATCH === '1') throw new Error('写后复核不符（注入缝）');
}

/** 写 out（tmp+rename 到 canonical 目标）并复核。 */
function writeAndVerify(rootReal, outCanon, filesArg, outPath, entries) {
  const tmp = join(dirname(outCanon), `.evidence-gen-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    renameSync(tmp, outCanon);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  verifyAfterWrite(rootReal, outCanon, filesArg, outPath, entries);
}

/** 主流程；返回退出码。 */
function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { process.stderr.write(`evidence-gen：${args.error}\n${USAGE}`); return 2; }
  if (args.help) { process.stdout.write(USAGE); return 0; }
  if (args.selftest) return selftest();
  if (args.files === null || args.out === null) { process.stderr.write(`evidence-gen：缺 --files 或 --out\n${USAGE}`); return 2; }
  if (args.stateDir === null) { process.stderr.write(`evidence-gen：缺 --state-dir（审计落盘必须显式指定）\n${USAGE}`); return 2; }
  const rootReal = realpathSync(process.cwd());
  let entries;
  try {
    entries = buildEntries(args.files, args.out, rootReal);
    if (args.write) writeAndVerify(rootReal, canonicalTarget(resolve(rootReal, args.out)), args.files, args.out, entries);
  } catch (err) {
    appendAudit(args.stateDir, { ts: new Date().toISOString(), status: 'failed', reason: String(err?.message ?? err), out: args.out });
    process.stderr.write(`evidence-gen：${err?.message ?? err}\n`);
    return 1;
  }
  appendAudit(args.stateDir, { ts: new Date().toISOString(), status: 'ok', applied: args.write === true, count: entries.length, out: args.out });
  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  return 0;
}

/** 内置自检（B-M8-4）。 */
function selftest() {
  let pass = 0;
  const fail = [];
  const check = (name, ok) => { if (ok) pass += 1; else fail.push(name); };
  const dir = join(tmpdir(), `evidence-gen-selftest-${process.pid}-${Date.now()}`);
  const state = join(dir, 'state');
  const prev = process.cwd();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    process.chdir(dir);
    try {
      const out = join(dir, 'evidence.json');
      check('dry-run 退 0', main(['--files', 'a.txt', '--out', out, '--state-dir', state]) === 0);
      check('dry-run 未落盘', (() => { try { statSync(out); return false; } catch { return true; } })());
      check('write 退 0', main(['--files', 'a.txt', '--out', out, '--write', '--state-dir', state]) === 0);
      const arr = JSON.parse(readFileSync(out, 'utf8'));
      check('条目形态', Array.isArray(arr) && arr.length === 1 && arr[0].path === 'a.txt' && /^sha256:[0-9a-f]{64}$/.test(arr[0].sha256) && arr[0].exitCode === 0);
      check('sha256 口径', arr[0].sha256 === lfSha('alpha\n'));
    } finally {
      process.chdir(prev);
    }
  } catch (err) {
    fail.push(`异常：${err?.message ?? err}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (fail.length > 0) {
    process.stdout.write(`FAIL ${fail.length} 项：${fail.join('；')}\n`);
    return 1;
  }
  process.stdout.write(`PASS ${pass} 项\nOK evidence-gen selftest（${pass} 项通过）\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
