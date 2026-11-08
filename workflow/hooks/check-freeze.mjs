// 文件：check-freeze.mjs
// 描述：workflow 插件目录编辑冻结护栏（PreToolUse | Edit|Write，内部规则-2）。
//       从 stdin 读宿主 JSON 负载，提取 tool_input.file_path；以负载 cwd
//       （缺省用进程 cwd）为起点向上逐级查找 FREEZE_FILE_NAME 声明文件来
//       定位项目根；file_path 相对根的路径命中声明中任一 glob → 输出 deny
//       决策（退出码 2）并说明解冻方式；声明文件不存在 → 放行（内部规则-5：
//       用户项目内显式创建才启用）。未命中静默放行（无输出，退出 0——宿主
//       明示空输出合法）。
//       内部任务-8（2026-10-07，内部规则-17 工具族分流）：**已命名**的非 edit 族负载静默放行
//       （漂移防护：防未来宿主给 shell 族负载也带 file_path 时误拦；族判定单源见
//       scripts/lib/tool-families.mjs）；负载无工具名（legacy 形态）保持现状判定。
//       「负载不可读 → DENY」的 fail-closed 极性例外在分流之前，不受本批影响。
//       输出协议：决策 JSON 必须嵌套在 hookSpecificOutput 之下，且必须带
//       hookEventName:"PreToolUse"——宿主按事件名校验信封，缺失或不一致
//       时整帧丢弃（deny 文案退化为原始 JSON）；顶层 permissionDecision
//       同样会被静默忽略而使拦截空转。
//       内部未决-14 批次（2026-09-15）：自 check-freeze.sh 等价移植为 Node——宿主
//       spawn 环境解析不到 bash 使 bash 版装机态 100% 空转；语义（极性矩阵/
//       路径归一/glob 匹配/文案）逐字保留，等价性由 check-freeze.test.mjs
//       双跑对拍与原 14 条用例断言锁定。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 来源致谢：行为语义参考 gstack MIT © Garry Tan，自写实现
//
// 极性裁决（内部规则-4 对 B-M8-1 的显式偏离，规格已裁决，勿「修正」）：
//   - 负载不可读/解析失败 → DENY（退出 2）。失败关闭是冻结护栏的安全语义
//     核心：读不到的边界不是边界。该裁决先于一切其他判断，且 DENY 只能经
//     emitPreToolUseDecision 的显式 process.exit(2) 发出——严禁走 throw 路径
//     （throw 会被崩溃陷阱改写为 exit 0，极性静默反转）。
//   - 解析成功后的自身异常（匹配逻辑崩溃、声明文件读失败等）→ 退出 0。
//     fail-open 只适用于这一段，不得反向扩大到负载不可读。
//
// 声明文件格式：每行一个 glob（相对项目根），支持 # 注释行与空行。
//   含通配符（* ? [）的行按模式整串匹配（* 可跨目录分隔符）；
//   不含通配符的行按目录/文件前缀匹配（即冻结整个子树）。
//
// 用法：stdin 喂负载；--selftest 运行内置自检（B-M8-4）；--help 查看说明。
// 注入缝：GUARD_HOOK_INJECT_CRASH=1 在解析成功后抛错，供测试验证崩溃陷阱
//       改写为 exit 0（正式运行勿设）。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readStdin, emitPreToolUseDecision, installHookErrorTrap, pickString, runHookMain, bindHookContext } from './hook-lib.mjs';
import { familyOf } from '../scripts/lib/tool-families.mjs';

/** 声明文件名（项目根的冻结声明，集中于此便于维护）。 */
const FREEZE_FILE_NAME = '.workflow-freeze';

/** [[:space:]] 字符类（bash 语义不含全角/Unicode 空白，勿用 \s）。 */
const BASH_SPACE = ' \\t\\n\\v\\f\\r';

/**
 * 字符串级路径归一（bash _norm_path 逐字复刻）：反斜杠→斜杠、`[a-z]:/*` 盘符
 * 小写→大写、循环去尾斜杠（保留单字符根 '/'）。刻意不用 node:path——resolve/
 * normalize 会解析 `..` 并改变 `D:` 形态，与 bash 字符串语义处处不同，冻结
 * 边界会漂移。
 * **内部任务-244 S02 修订**：normPathRaw 继续只做字符串归一（声明行匹配的 bash 语义不变）；
 * 目标路径在进入匹配前先经 canonicalTargetPath（resolve＋最近存在祖先 realpath＋
 * win32 逐段大小写折叠），否则 `..`/symlink/大小写可绕过冻结。
 * @param {string} p
 * @returns {string}
 */
export function normPathRaw(p) {
  let s = String(p).replaceAll('\\', '/');
  if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Windows 目录段大小写折叠（内部任务-244 S02）：Windows FS 大小写不敏感，但 `realpath` 只能
 * 解析已存在前缀；对不存在的尾段按父目录实际项做大小写不敏感匹配（`Docs`→`docs`）。
 * @param {string} dir 父目录（真实路径）
 * @param {string} seg 目标段
 * @returns {string} 折叠后段名（无匹配时原样）
 */
function foldCaseSegment(dir, seg) {
  if (process.platform !== 'win32' || seg === '' || seg === '.' || seg === '..') return seg;
  try {
    return readdirSync(dir).find((name) => name.toLowerCase() === seg.toLowerCase()) ?? seg;
  } catch {
    return seg;
  }
}

/**
 * Windows 整路径大小写折叠（内部任务-244 S02）：`realpath` 对已存在路径**不折叠大小写**
 * （实测 `realpathSync('…\\Docs')` 原样返回 `Docs`），故对盘符形态路径从根逐段按
 * 实际目录项折叠（`Docs`→`docs`）。UNC/非盘符形态原样返回（不猜网络路径大小写）。
 * @param {string} p 绝对路径
 * @returns {string} 折叠后路径
 */
function foldCasePath(p) {
  const norm = String(p).replaceAll('\\', '/');
  const drive = /^([A-Za-z]:)(\/|$)/.exec(norm);
  if (!drive) return p;
  let out = `${drive[1]}/`;
  for (const seg of norm.slice(drive[0].length).split('/').filter((s) => s !== '' && s !== '.')) {
    out = join(out, foldCaseSegment(out, seg));
  }
  return out;
}

/**
 * 目标路径 canonical 归一（内部任务-244 S02）：相对路径按负载 cwd 解析；对最近存在祖先做
 * `realpath`（消解 `..` 与 symlink/junction），不存在的尾段拼回并对 win32 做逐段大小写折叠；
 * 已存在前缀在 win32 上另做整路径大小写折叠（realpath 不折叠目录段大小写）。
 * 冻结判定必须基于归一路径——纯字符串比较可被 `src/../docs/x.md`、symlink 别名、
 * `Docs/x.md`（Windows）绕过（内部规则-2「命中冻结目录拒绝」失守）。
 * @param {string} fp 负载 file_path（可相对）
 * @param {string} cwd 负载 cwd
 * @returns {string} 绝对 canonical 形态（祖先不可解析时原样返回绝对路径）
 */
export function canonicalTargetPath(fp, cwd) {
  const abs = isAbsolute(String(fp)) ? String(fp) : resolve(String(cwd || '.'), String(fp));
  // 内部任务-244 最终安全评审 B2：**逐段 canonical**——先对目录段 realpath 再处理 `..`，与 OS 内核
  // 语义一致（symlink `a -> docs/sub` 后 `a/../secret.md` 实际是 `docs/secret.md`；原实现
  // 先 path.resolve 词法消掉 `..` 得 `secret.md`，冻结 `docs/*` 被绕过）。
  const { root } = parse(abs);
  let cur = root || normalizeRoot(abs);
  const rest = abs.slice(root.length).split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  for (const seg of rest) {
    if (seg === '..') { cur = dirname(cur); continue; }
    const next = join(cur, seg);
    try {
      cur = realpathSync(next);
    } catch {
      cur = next; // 不存在尾段保留字面形态（其父已 canonical）
    }
    if (process.platform === 'win32') cur = foldCasePath(cur);
  }
  return cur === '' ? abs : cur;
}

/** 无卷根形态（POSIX 相对/异常输入）时回退为目录根字面量。 */
function normalizeRoot(abs) {
  const d = dirname(abs);
  return d === abs ? abs : resolve('/');
}

/**
 * 自起点目录向上逐级找声明文件（bash _find_root 逐字复刻）：越靠近起点越优先
 * （嵌套项目取内层声明）。上溯终点复刻 bash `${d%/*}` 削斜杠语义：`D:/a`→`D:`
 * （无斜杠即停），`/a`→空串（不检查 `/` 本身）——与 path.dirname 行为不同。
 * @param {string} startDir 起点目录（负载 cwd）
 * @returns {string} 声明所在根（归一形态）；无声明返回空串
 */
export function findDeclarationRoot(startDir) {
  // 内部任务-244 最终安全评审 B2：起点 cwd 先 canonical 化再上溯——cwd 为 symlink 指向子目录时，
  // 真实目录上的 `.workflow-freeze` 原实现永不命中（词法上溯只经过别名路径），冻结静默放行。
  let resolvedStart;
  try {
    resolvedStart = realpathSync(String(startDir));
  } catch {
    resolvedStart = String(startDir);
  }
  let d = normPathRaw(resolvedStart);
  while (d !== '') {
    if (isPlainFile(`${d}/${FREEZE_FILE_NAME}`)) return d; // bash `[ -f ]`：目录不算声明，继续上溯
    const i = d.lastIndexOf('/');
    if (i < 0) break; // 已到无斜杠可削的根（如 D:），防死循环
    d = d.slice(0, i);
  }
  return '';
}

/** 普通文件判定（bash `[ -f ]` 等价：存在且非目录）。 */
function isPlainFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 相对根路径化（bash _rel_to_root 复刻）：等值→'.'；根前缀剥除；不在根下→空串
 * （调用方按放行处理）。
 * @param {string} filePath
 * @param {string} root
 * @returns {string}
 */
export function relToRoot(filePath, root) {
  const f = normPathRaw(filePath);
  const r = normPathRaw(root);
  if (f === r) return '.';
  if (f.startsWith(`${r}/`)) return f.slice(r.length + 1);
  return '';
}

/**
 * 声明行 glob 匹配（bash _glob_match 复刻）：含 `*`/`?`/`[` 的行整串按模式匹配
 * （`*` 跨目录分隔符）；纯字面行按「等于自身或自身+/前缀」匹配（目录冻结整个子树）。
 * 声明行尾斜杠先剥除（`docs/` 与 `docs` 同义）。
 * @param {string} rel 相对根路径
 * @param {string} declLine 声明行（已剥空白）
 * @returns {boolean}
 */
export function caseGlobTest(rel, declLine) {
  const pat = declLine.endsWith('/') ? declLine.slice(0, -1) : declLine;
  if (/[*?\[]/.test(pat)) {
    const re = globToRegExp(pat);
    return re === null ? false : re.test(rel); // 译不动的病态类按不匹配跳过（勿中断后续行）
  }
  return rel === pat || rel.startsWith(`${pat}/`);
}

/**
 * bash case 通配模式 → 锚定 RegExp（无 extglob）：* 任意串（含 /）、? 单字符、
 * [...] 字符类（支持 [!...] 反选与区间，`]` 紧随 `[`/`[!` 为字面成员——POSIX 语义），
 * 其余字符按字面转义。译不动的病态输入返回 null（按不匹配处理，保住后续声明行）。
 * 已知不支持面（与 bash fnmatch 的差异）：POSIX 类（如 [[:space:]]）不在支持范围。
 * @param {string} pat
 * @returns {RegExp|null}
 */
function globToRegExp(pat) {
  let out = '^';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const neg = pat[i + 1] === '!';
      let j = i + (neg ? 2 : 1);
      let cls = '';
      if (pat[j] === ']') { cls += '\\]'; j += 1; } // POSIX：] 紧随 [ / [! 为字面成员
      const close = pat.indexOf(']', j);
      if (close === -1) { out += '\\['; continue; } // 未闭合按字面
      cls += pat.slice(j, close);
      out += `[${neg ? '^' : ''}${cls.replace(/[\]\\]/g, '\\$&')}]`;
      i = close;
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`${out}$`);
  } catch {
    return null; // 病态区间（如 [z-a]）：跳过该行，不中断循环（评审 S/P1）
  }
}

/** 主流程：极性矩阵见文件头；命中声明经显式 emit deny（exit 2），其余一律静默 exit 0。 */
async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
    bindHookContext({ sessionKey: pickString(payload, ['session_id']) }); // 内部任务-290：崩溃留痕归属到会话（内部未决-260）
  } catch {
    // 极性裁决：deny 档护栏读不到负载必须失败关闭，这条优先于一切（文案逐字直搬 .sh :184）
    emitPreToolUseDecision('deny', '[freeze] 已阻断：无法解析工具负载，按冻结护栏极性拒绝（fail-closed）。请重试或检查钩子安装。');
    return;
  }
  // 内部任务-8（内部规则-17）工具族分流：**已命名**的非 edit 族负载（shell/只读等）静默放行——
  // 漂移防护：防未来宿主给 shell 族负载也带 tool_input.file_path 时冻结护栏误拦；
  // 负载无工具名（legacy 形态）保持现状判定（file_path 存在性），既有语义零漂移。
  const toolName = pickString(payload, ['tool_name']);
  if (toolName && familyOf(toolName) !== 'edit') process.exit(0);
  const fp = pickString(payload, ['tool_input', 'file_path']);
  if (fp === '') process.exit(0); // 非 Edit/Write 负载（无 file_path 字段）
  const cwd = pickString(payload, ['cwd']) || process.cwd();
  // 自检注入缝：解析成功后模拟自身异常，验证崩溃陷阱改写为 0（位置与 bash 版等价）
  if (process.env.GUARD_HOOK_INJECT_CRASH === '1') throw new Error('inject-crash');
  const root = findDeclarationRoot(cwd);
  if (root === '') process.exit(0); // 项目未声明冻结（内部规则-5：显式创建才启用）
  // 内部任务-244 S02：目标与声明根先 canonical 归一（消解 `..`/symlink/Windows 大小写、相对 file_path
  // 按负载 cwd 解析）再做声明行匹配——纯字符串比较会被 `src/../docs/x.md`、symlink 别名、
  // `Docs/x.md` 绕过冻结。
  const targetPath = canonicalTargetPath(fp, cwd);
  const canonicalRoot = canonicalTargetPath(root, root);
  const rel = relToRoot(targetPath, canonicalRoot);
  if (rel === '') process.exit(0); // 目标在声明项目之外，不受该项目冻结约束
  const decl = readFileSync(`${canonicalRoot}/${FREEZE_FILE_NAME}`, 'utf8');
  for (const raw of decl.split('\n')) { // split 天然容忍末行无换行
    const line = raw.replace(new RegExp(`^[${BASH_SPACE}]+`), '').replace(new RegExp(`[${BASH_SPACE}]+$`), '');
    if (line === '' || line.startsWith('#')) continue;
    if (caseGlobTest(rel, line)) {
      emitPreToolUseDecision('deny', `[freeze] 已阻断：${rel} 命中冻结声明 [${line}]。解冻方式：编辑项目根的 ${FREEZE_FILE_NAME} 删除对应行，或删除整个声明文件。`);
    }
  }
  process.exit(0);
}

/**
 * 内置自检（B-M8-4，断言集对齐 bash 版 :227-230）：子进程驱动自身，四断言
 * 界内 deny/信封关键字/界外静默/负载垃圾 deny（极性）。
 * @returns {number}
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-freeze-selftest-'));
  try {
    mkdirSync(join(home, 'docs'), { recursive: true });
    writeFileSync(join(home, FREEZE_FILE_NAME), '# 自检声明\ndocs/*\n');
    const me = fileURLToPath(import.meta.url);
    const run = (payload) => {
      const r = spawnSync(process.execPath, [me], { input: payload, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '' };
    };
    // 负载一律 JSON.stringify 构造：Windows 临时目录路径含反斜杠，手拼 JSON 会因未转义而炸
    const pay = (fp, cwd) => JSON.stringify({ tool_input: { file_path: fp }, cwd });
    const a = run(pay(`${home}/docs/a.md`, home));
    check('界内 deny(2)', a.status === 2 && a.stdout.includes('deny'));
    check('信封契约（hookEventName）', a.status === 2 && a.stdout.includes('"hookEventName":"PreToolUse"'));
    const b = run(pay(`${home}/src/a.ts`, home));
    check('界外放行（零输出）', b.status === 0 && b.stdout.trim() === '');
    const c = run('not-json');
    check('负载垃圾 deny（极性 fail-closed）', c.status === 2 && c.stdout.includes('deny'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL check-freeze.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK check-freeze.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    // symlink 形态归一（内部任务-GUARDSYML-1）：ESM 默认按 realpath 解析主模块，argv[1] 保留
    // 别名形态时字符串级比对恒 false → 钩子整体静默 no-op；realpath 归一后再比一次
    // （realpath 失败落 catch 判 false，fail-open 段不变；首轮原始比对保留，兼容
    // --preserve-symlinks-main 下 import.meta.url 为别名形态的运行方式）。
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest()); // selftest 失败须可见退 1：陷阱不装
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('用法：check-freeze.mjs [选项]\n  （无参数）从 stdin 读宿主 JSON 负载，检查 tool_input.file_path 冻结边界\n  --selftest 运行内置自检（B-M8-4）\n  --help    显示本说明\n');
    process.exit(0);
  }
  installHookErrorTrap('check-freeze'); // 解析成功后的自身异常 → exit 0（fail-open 段）
  runHookMain('check-freeze', main);
}
