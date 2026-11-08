// 文件：mechanical-edit.mjs
// 描述：受信写者工具——按 spec 做「字面量机械替换」的批量落盘（内部决策-066 D2，内部任务-261；硬规则 9
//       白名单受信写者）。默认 dry-run；--apply 才写；literal-only（不接受正则/语义参数）；
//       expectCount 必填且逐条校验（同一文件多条按顺序对当前文本校验），任一条不符整体不写；
//       事务式落盘（tmp+rename；任一失败/读回不符回滚全部已写文件）；写后按字节读回；
//       UTF-8 严格解码（非法字节拒写）＋BOM/CRLF 拒写（含 replace 与结果文本）；路径 canonical
//       后必须落在当前工作目录（仓根）内；stdout 输出 JSON（含 diff 摘要）；审计追加
//       <状态根>/wf-mechanical-edit.jsonl（>5000 行轮转保留尾部 2500 行）。
//       退出码：0 成功；1 校验/写入失败；2 用法错误。--selftest 内置自检（B-M8-4 同款）。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；无 shell 依赖；LF/UTF-8。
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE =
  '用法：node mechanical-edit.mjs --spec <spec.json> --state-dir <目录> [--apply] [--selftest]\n' +
  '  spec.json：{"edits":[{"file":"相对路径","find":"字面量","replace":"替换文本","expectCount":N}]}\n' +
  '  默认 dry-run（打印 JSON 摘要含 diff）；--apply 才落盘；任一条 expectCount 不符即整体不写（exit 1）。\n';

const FLAGS_WITH_VALUE = ['--spec', '--state-dir'];
const AUDIT_FILE = 'wf-mechanical-edit.jsonl';
const AUDIT_MAX_LINES = 5000;

/** 目标 canonical 形态（容忍目标不存在：对最近存在祖先 realpath 后拼回尾段）。 */
function canonicalTarget(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* 尾段可能不存在 */ }
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** canonical 目标是否落在仓根内（relative + isAbsolute 判定，跨平台且含 symlink 逃逸防护）。 */
function isWithinRoot(rootReal, targetCanon) {
  const rel = relative(rootReal, targetCanon);
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** 严格 UTF-8 解码（非法字节→拒；BOM/CRLF→拒；返回原文 Buffer 与文本）。 */
function readUtf8Strict(fileAbs, label) {
  let st;
  try { st = statSync(fileAbs); } catch { throw new Error(`目标不存在：${label}`); }
  if (!st.isFile()) throw new Error(`目标不是常规文件：${label}`);
  const buf = readFileSync(fileAbs);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`目标含非法 UTF-8 字节，拒写：${label}`);
  if (text.startsWith('\uFEFF')) throw new Error(`目标含 BOM，拒写：${label}`);
  if (text.includes('\r')) throw new Error(`目标含 CRLF/CR，拒写（仓库 LF 口径）：${label}`);
  return { buf, text };
}

/** replace 文本与最终结果均不得引入 BOM/CRLF。 */
function assertLfNoBom(value, label) {
  if (value.startsWith('\uFEFF')) throw new Error(`${label} 含 BOM，拒绝`);
  if (value.includes('\r')) throw new Error(`${label} 含 CRLF/CR，拒绝（仓库 LF 口径）`);
}

/** 行级 diff 摘要（逐行对齐，最多 200 条；供 dry-run/apply 的 stdout 复核）。 */
function lineDiff(fileRel, oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < 200; i += 1) {
    const before = i < a.length ? a[i] : null;
    const after = i < b.length ? b[i] : null;
    if (before !== after) out.push({ file: fileRel, line: i + 1, old: before, new: after });
  }
  return out;
}

/** 审计行追加＋>5000 行轮转（保留尾部 2500 行）；失败只 stderr 警示，不改变主流程退出码。 */
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
    process.stderr.write(`[mechanical-edit] 审计写失败（不阻断）：${err?.message ?? err}\n`);
  }
}

/** 解析 argv（未知旗标/缺值 → 用法错误）。 */
function parseArgs(argv) {
  const args = { apply: false, selftest: false, help: false, spec: null, stateDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (FLAGS_WITH_VALUE.includes(a)) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} 缺值` };
      if (a === '--spec') args.spec = v; else args.stateDir = v;
    } else return { error: `未知参数：${a}` };
  }
  return args;
}

const ALLOWED_EDIT_KEYS = new Set(['file', 'find', 'replace', 'expectCount']);

/** 读入并校验 spec；返回编辑列表（路径规范化到 canonical 仓内文件）。 */
function loadSpec(specPath, rootReal) {
  const raw = readFileSync(specPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`spec JSON 无法解析：${err.message}`); }
  const edits = parsed?.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('spec.edits 必须为非空数组');
  return edits.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`edits[${i}] 须为对象`);
    const unknown = Object.keys(e).filter((k) => !ALLOWED_EDIT_KEYS.has(k));
    if (unknown.length > 0) throw new Error(`edits[${i}] 含不支持的键（literal-only）：${unknown.join(',')}`);
    for (const k of ['file', 'find', 'replace']) if (typeof e[k] !== 'string' || e[k] === '') throw new Error(`edits[${i}].${k} 须为非空字符串`);
    if (!Number.isInteger(e.expectCount) || e.expectCount < 1) throw new Error(`edits[${i}].expectCount 须为正整数`);
    const fileAbs = canonicalTarget(resolve(rootReal, e.file));
    if (!isWithinRoot(rootReal, fileAbs)) throw new Error(`edits[${i}].file 越出工作目录：${e.file}`);
    return { fileAbs, fileRel: relative(rootReal, fileAbs).split('\\').join('/'), find: e.find, replace: e.replace, expectCount: e.expectCount };
  });
}

/** 计划全部变更：同文件多条按序对当前文本校验；先全验后写（任一条失败整体不写）。 */
function planChanges(edits) {
  const groups = new Map();
  for (const e of edits) {
    if (!groups.has(e.fileAbs)) groups.set(e.fileAbs, []);
    groups.get(e.fileAbs).push(e);
  }
  const changes = [];
  for (const [fileAbs, list] of groups) {
    const fileRel = list[0].fileRel;
    const { text } = readUtf8Strict(fileAbs, fileRel);
    let cur = text;
    const counts = [];
    for (const e of list) {
      assertLfNoBom(e.replace, `edits 的 replace（${fileRel}）`);
      const count = cur.split(e.find).length - 1;
      if (count !== e.expectCount) throw new Error(`计数不符：${fileRel} 期望 ${e.expectCount} 实得 ${count}`);
      cur = cur.split(e.find).join(e.replace);
      counts.push({ find: e.find, replace: e.replace, count });
    }
    assertLfNoBom(cur, `替换结果（${fileRel}）`);
    changes.push({ fileAbs, fileRel, original: text, next: cur, counts, diff: lineDiff(fileRel, text, cur) });
  }
  return changes;
}

/** 事务式写全部变更：tmp 全写→rename→按字节读回；任一步失败恢复全部备份。 */
function applyChanges(changes) {
  const backups = new Map(changes.map((c) => [c.fileAbs, c.original]));
  const tmps = [];
  try {
    for (const c of changes) {
      const tmp = join(dirname(c.fileAbs), `.mech-edit-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
      writeFileSync(tmp, Buffer.from(c.next, 'utf8'));
      tmps.push({ tmp, fileAbs: c.fileAbs, next: c.next });
    }
    for (let i = 0; i < tmps.length; i += 1) {
      renameSync(tmps[i].tmp, tmps[i].fileAbs);
      if (process.env.WF_MECH_EDIT_INJECT_WRITE_FAIL === '1' && i === 0) throw new Error('注入写失败（测试缝）');
    }
    if (process.env.WF_MECH_EDIT_INJECT_READBACK_FAIL === '1') throw new Error('注入读回失败（测试缝）');
    for (const t of tmps) {
      if (!readFileSync(t.fileAbs).equals(Buffer.from(t.next, 'utf8'))) throw new Error(`写后读回不符：${relative(process.cwd(), t.fileAbs)}`);
    }
  } catch (err) {
    for (const [fileAbs, original] of backups) {
      try { writeFileSync(fileAbs, Buffer.from(original, 'utf8')); } catch { /* 尽力回滚 */ }
    }
    for (const t of tmps) { try { rmSync(t.tmp, { force: true }); } catch { /* ignore */ } }
    throw err;
  }
}

/** 主流程；返回退出码。 */
function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { process.stderr.write(`mechanical-edit：${args.error}\n${USAGE}`); return 2; }
  if (args.help) { process.stdout.write(USAGE); return 0; }
  if (args.selftest) return selftest();
  if (!args.spec) { process.stderr.write(`mechanical-edit：缺 --spec\n${USAGE}`); return 2; }
  if (!args.stateDir) { process.stderr.write(`mechanical-edit：缺 --state-dir（审计落盘必须显式指定）\n${USAGE}`); return 2; }
  const rootReal = realpathSync(process.cwd());
  let changes;
  try {
    const edits = loadSpec(args.spec, rootReal);
    changes = planChanges(edits);
  } catch (err) {
    appendAudit(args.stateDir, { ts: new Date().toISOString(), status: 'failed', reason: String(err?.message ?? err) });
    process.stderr.write(`mechanical-edit：${err?.message ?? err}\n`);
    return 1;
  }
  const diff = changes.flatMap((c) => c.diff);
  const summary = { ok: true, applied: args.apply === true, changes: changes.map((c) => ({ file: c.fileRel, count: c.counts.reduce((s, x) => s + x.count, 0), edits: c.counts.length })), diff };
  if (args.apply) {
    try {
      applyChanges(changes);
    } catch (err) {
      appendAudit(args.stateDir, { ts: new Date().toISOString(), status: 'failed', reason: String(err?.message ?? err), changes: summary.changes });
      process.stderr.write(`mechanical-edit：${err?.message ?? err}\n`);
      return 1;
    }
  }
  appendAudit(args.stateDir, { ts: new Date().toISOString(), status: 'ok', applied: summary.applied, changes: summary.changes });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

/** 内置自检（B-M8-4）。 */
function selftest() {
  let pass = 0;
  const fail = [];
  const check = (name, ok) => { if (ok) pass += 1; else fail.push(name); };
  const dir = join(tmpdir(), `mech-edit-selftest-${process.pid}-${Date.now()}`);
  const state = join(dir, 'state');
  const prev = process.cwd();
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'foo foo\n');
    const specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 }] }));
    process.chdir(dir);
    try {
      check('dry-run 退 0', main(['--spec', specPath, '--state-dir', state]) === 0);
      check('dry-run 零写', readFileSync(target, 'utf8') === 'foo foo\n');
      writeFileSync(specPath, JSON.stringify({ edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 1 }] }));
      check('计数不符退 1', main(['--spec', specPath, '--state-dir', state]) === 1);
      writeFileSync(specPath, JSON.stringify({ edits: [{ file: 'a.txt', find: 'foo', replace: 'bar', expectCount: 2 }] }));
      check('apply 退 0', main(['--spec', specPath, '--apply', '--state-dir', state]) === 0);
      check('apply 落盘', readFileSync(target, 'utf8') === 'bar bar\n');
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
  process.stdout.write(`PASS ${pass} 项\nOK mechanical-edit selftest（${pass} 项通过）\n`);
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
