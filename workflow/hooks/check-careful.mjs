// 文件：check-careful.mjs
// 描述：workflow 插件危险命令护栏（PreToolUse | Bash，内部规则-1）。从 stdin 读
//       宿主 JSON 负载，提取 tool_input.command 做两档危险模式匹配：
//         HIGH   → deny（输出 deny 决策，退出码 2，阻断执行）
//         MEDIUM → ask（输出 ask 决策，退出码 0，交由用户确认后放行）
//       未命中静默放行（无输出，退出 0——宿主明示空输出合法）。
//       内部任务-8（2026-10-07，内部规则-17 工具族分流）：**已命名**的非 shell 族负载静默放行
//       （漂移防护：防未来宿主给 edit/只读族负载也带 command 字段时误拦编辑/读取操作）；
//       负载无工具名（legacy 形态）保持现状判定，历史语义零漂移。族判定单源见
//       scripts/lib/tool-families.mjs。
//       输出协议：决策 JSON 必须嵌套在 hookSpecificOutput 之下，且必须带
//       hookEventName:"PreToolUse"——宿主按事件名校验信封，缺失或不一致
//       时整帧丢弃（ask 档失效、deny 文案退化为原始 JSON）；顶层
//       permissionDecision 同样会被静默忽略而使护栏空转。
//       内部未决-14 批次（2026-09-15）：自 check-careful.sh 等价移植为 Node——宿主
//       spawn 环境解析不到 bash 使 bash 版装机态 100% 空转；语义（模式表/极性/
//       文案）逐字保留，ERE 按「拆行逐行 test + [[:space:]] 译显式 ASCII 类」
//       复刻 grep 行级语义，等价性由 check-careful.test.mjs 双跑对拍锁定。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 来源致谢：行为语义参考 gstack MIT © Garry Tan，自写实现
//
// 失败姿态（B-M8-1 fail-open）：负载解析失败、脚本自身任何异常 → 一律放行
// （退出 0）。理由：ask 档护栏误拦截的代价高于漏报，且护栏绝不能因自身故障
// 卡死宿主命令。实现手段是崩溃陷阱 + main().catch 兜底——经 emit 的显式决策
// 退出码原样保留（deny=2），未决策的异常死亡一律改写为 0（等价 bash EXIT
// trap 的 _DECIDED 二态）。
//
// 用法：stdin 喂负载；--selftest 运行内置自检（B-M8-4）；--help 查看说明。
// 注入缝：GUARD_HOOK_INJECT_CRASH=1 时在解析成功后抛错，供测试验证 fail-open
//       改写（正式运行勿设）。
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readStdin, emitPreToolUseDecision, installHookErrorTrap, pickString, runHookMain, bindHookContext } from './hook-lib.mjs';
import { familyOf } from '../scripts/lib/tool-families.mjs';

/** [[:space:]] 字符类（grep 行级语义：不含行首尾的换行；不用 \s 防 Unicode 扩展误配）。 */
const SP = '[ \\t\\r\\f\\v]';
const NSP = '[^ \\t\\r\\f\\v]';

// ── 危险模式表（集中文件头部便于维护；B-M8-3：表是脚本资产，skill 只引用）──
// HIGH 档（deny，4 条，需 token 级语义判断，见下方 high* 函数）：
//   H1  rm 递归删除根类目标（/ ~ $HOME /*——全部目标均为根类才命中）
//   H2  git push --force 推向主分支（main/master，含 +refspec 与 HEAD:ref 形式）
//   H3  git reset --hard 裸用法（未指定 ref，整段丢弃未提交改动）
//   H4  DROP DATABASE 整库删除（大小写不敏感；内部未决-62〔内部任务-44〕收窄：deny 需数据库客户端共现——
//       短语+客户端 token（mysql/psql/sqlite3…封闭词表）同现才 deny，纯文本提及降 MEDIUM 级 ask）
// MEDIUM 档（ask，10 条=9 条 ERE 逐行 + 1 条词级函数〔git push 行，B1 起〕，顺序即优先级，首个命中生效）：
//   · 锚约定（内部任务-HANDOVER1002-1）：命令名以 `(^|[^0-9A-Za-z_])` 为**左边界锚**（等价 \b）——词内子串
//     （form/legit/anpm…）不得命中；不写 `(^|SP)`：那会连 `/bin/rm` 这类绝对路径调用一起漏掉。
//     kill 行原为该约定的保留例外（旧锚 `(^|SP)`），2026-10-05（内部任务-2 批 B1）改齐词字符锚。
/** @type {[RegExp | ((cmd: string) => boolean), string][]} ERE 已按行级语义译为 JS RegExp（源 check-careful.sh:37-46 逐条对应）；
 *  git push 行 2026-10-05（内部任务-2 批 B1）起改词级函数 mediumForcePush（力旗标 token 级 + 前置旗标段）。 */
const MEDIUM_TABLE = [
  [new RegExp(`(^|[^0-9A-Za-z_])rm${SP}+[^;&|]*-[a-zA-Z]*[rR]`), '递归删除（rm -r 系）'],
  [mediumForcePush, 'git 强推（改写远端历史）'],
  [new RegExp(`(^|[^0-9A-Za-z_])git${SP}+reset${SP}+[^;&|]*--hard`), 'git reset --hard（丢弃未提交改动）'],
  [new RegExp(`(^|[^0-9A-Za-z_])git${SP}+clean${SP}+[^;&|]*-[a-zA-Z]*f`), 'git clean -f（删除未跟踪文件）'],
  [new RegExp(`(^|[^0-9A-Za-z_])chmod${SP}+[^;&|]*-[a-zA-Z]*R[^;&|]*777`), 'chmod -R 777（递归放开全部权限）'],
  [new RegExp(`(^|[^0-9A-Za-z_])(kill|killall|pkill)${SP}[^;&|]*([*]|[$][(])`), 'kill 通配/命令替换批量杀进程'],
  [new RegExp(`(^|[^0-9A-Za-z_])(mkfs(\\.[a-z0-9]+)?(${SP}|$)|diskpart${SP}+[^;&|]*${SP}clean(${SP}|$)|dd${SP}+[^;&|]*of=/dev/(sd|hd|nvme|vd))`), '磁盘格式化/裸写块设备'],
  [new RegExp(`(^|[^0-9A-Za-z_])(npm|pnpm)${SP}+(uninstall|remove|rm)${SP}+[^;&|]*(-g(${SP}|$)|--global)|(^|[^0-9A-Za-z_])yarn${SP}+global${SP}+(remove|uninstall)|(^|[^0-9A-Za-z_])pip[0-9]?${SP}+uninstall`), '包管理器全局卸载'],
  [new RegExp(`>${SP}*/dev/(sd|hd|nvme|vd)[a-z0-9]*`), '重定向覆写块设备（/dev/null 除外）'],
  [new RegExp(`(^|[^0-9A-Za-z_])(curl|wget)${SP}+[^;&|]*[|]${SP}*(sudo${SP}+)?(ba)?sh(${SP}|$)`), '下载内容管道直执行（curl|sh）'],
];

/**
 * ERE 行级匹配（bash `printf %s | grep -qE` 复刻）：按 \n 拆行逐行 test，任一行
 * 命中即真；^/$ 为行锚。
 * @param {RegExp} re 无 g/m 标志的正则
 * @param {string} text
 * @returns {boolean}
 */
export function matchEre(re, text) {
  const t = String(text);
  return t.split('\n').some((line) => re.test(line));
}

/**
 * 是否单一命令（无 ; && || | 换行）——token 级 HIGH 判断只对单一命令做：字符串
 * 匹配无法解析复合命令的执行语义，硬猜只会误判，复合命中的破坏性家族自然落入
 * MEDIUM 的 ask 档（保守降档而非放行）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function isSimpleCommand(cmd) {  return !/[;&|\n]/.test(cmd);
}

/**
 * 词拆分（bash `set -f; for w in $CMD` 复刻）：默认 IFS（空格/制表/换行）连续
 * 空白合一，不做 glob 展开（引号内空格同样拆开是现状语义）。
 * @param {string} cmd
 * @returns {string[]}
 */
export function splitWords(cmd) {
  return String(cmd).split(/[ \t\n]+/).filter((w) => w !== '');
}

/**
 * 剥一层首尾引号（bash `${w#\"}` 族四次展开复刻）：首双引号、尾双引号、首单引
 * 号、尾单引号各至多一层，顺序执行。
 * @param {string} w
 * @returns {string}
 */
export function stripQuotes(w) {
  return w.replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, '');
}

/**
 * 保守词法归一（内部任务-244 S05）：只消除两类**纯文本层可静态判定**的 shell 混淆，
 * 让既有危险模式表在其上仍能命中；不展开变量、不解析复合命令（避免引入新的误判面）。
 * ① 空引号拼接：`r''m` / `r""m` 在 bash 中即 `rm`（空引号移除不改变词边界）；
 * ② `${IFS}` 字段分隔展开为空格（bash 默认 IFS 含空格，`rm${IFS}-rf${IFS}/` 即 `rm -rf /`）。
 * 边界：含字面空引号的安全命令可能被归一为相邻词（保守方向=宁可多 ask/deny，不放行危险面）。
 * @param {string} cmd 原始命令文本
 * @returns {string} 归一后命令文本
 */
export function normalizeCommandText(cmd) {
  return String(cmd)
    .replace(/''/g, '')
    .replace(/""/g, '')
    // ${IFS}/$IFS 展开为空格（bash 默认 IFS 含空格；阶段门评审补 $IFS 与 ${IFS:0:1} 变体）
    .replace(/\$\{IFS(?::[^}]*)?\}/gi, ' ')
    .replace(/\$IFS\b/g, ' ');
}

/** H1 根类字面集（bash case 引号语义下全部是字面量——'/*' 即两字符字面，非 glob）。 */
const ROOT_TARGETS = new Set(['/', '~', '~/', '$HOME', '$HOME/', '${HOME}', '${HOME}/', '/*', '//']);

/** H1 装饰跳过判定（bash case :150 复刻：`-*` 等为 glob、`'>'*` 为字面前缀）。 */
function isDecorativeToken(w) {
  return w === 'sudo' || w === 'rm' || w.startsWith('-') || w === '--'
    || w.startsWith('>') || w.startsWith('<') || /^[0-9]>.*&$/.test(w) || w === '&';
}

/** H1 前置预检（源 :142-143）。 */
const H1_HEAD_RE = new RegExp(`^${SP}*(sudo${SP}+)?rm${SP}`);
const H1_RECURSE_RE = new RegExp(`(^|${SP})-[a-zA-Z]*[rR]`);

/**
 * H1：递归删除根类目标（源 :140-157）。要求单一命令 + rm 开头 + 递归标志，token
 * 化后剥一层引号、跳过装饰，全部目标 token 均属根类字面集才命中。
 * @param {string} cmd
 * @returns {boolean}
 */
function highRmRoot(cmd) {
  if (!isSimpleCommand(cmd)) return false;
  if (!matchEre(H1_HEAD_RE, cmd) || !matchEre(H1_RECURSE_RE, cmd)) return false;
  let rootHit = false;
  let safeHit = false;
  for (const raw of splitWords(cmd)) {
    const w = stripQuotes(raw);
    if (isDecorativeToken(w)) continue;
    if (ROOT_TARGETS.has(w)) rootHit = true;
    else safeHit = true;
  }
  return rootHit && !safeHit;
}

/** 力旗标 token 判定（内部任务-2 批 B1，评审 H-2）：短簇含 f（-f/-fv/-fx…bundled 形态）、精确
 *  `--force` 与 `--force-if-includes`；`--force-with-lease` 不命中（lease 即保护，刻意放行——
 *  旧 ERE 要求力旗标为独立词，`-fv` 与 `git -C <path> push --force` 前置旗标形态零拦截）。 */
function forceFlagOf(tok) {
  const t = String(tok).toLowerCase(); // 终审③：NTFS 大小写不敏感下 `-F/--FORCE` 真实可执行——归一判定
  return /^-[a-z]*f[a-z]*$/.test(t) || t === '--force' || t === '--force-if-includes';
}

/** git 全局旗标词表（带值旗标消耗下一 token；`--opt=val` 形单 token 自含）。 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '--no-paginate', '--paginate', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--bare']);

/** 词级判定：git 本体形态（`git` 或绝对路径 `/…/git`——阶段复审① F2：绝对路径调用与
 *  `sh -c`/env 包装形态不得因段首非裸 `git` 而漏拦）。 */
function isGitWord(w) {
  const t = String(w).toLowerCase(); // 终审③：同 forceFlagOf——`Git` 在 NTFS 上真实解析到 git.exe
  return t === 'git' || t.endsWith('/git');
}

/** 从 git 位之后扫全局旗标段，返回其后的首个非旗标词（push 判定用；非 push 返回 undefined）。 */
function subcommandAfterGlobals(words, start) {
  let i = start;
  while (i < words.length) {
    const w = stripQuotes(words[i]);
    if (GIT_GLOBAL_VALUE_FLAGS.has(w)) {
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(w) || (w.startsWith('--') && w.includes('='))) {
      i += 1;
      continue;
    }
    if (w.startsWith('-') && w !== '-') return undefined; // 其他旗标/子命令——非 push
    return w;
  }
  return undefined;
}

/** 词级判定（H2 用）：本段命令的 git 子命令是否为 push——段首（剥 sudo）为 git 本体
 *  （容忍全局旗标段——`git -C <p> push`）。 */
function wordsAreGitPush(words) {
  let i = 0;
  if (stripQuotes(words[0] ?? '') === 'sudo') i = 1;
  if (!isGitWord(stripQuotes(words[i] ?? ''))) return false;
  return subcommandAfterGlobals(words, i + 1) === 'push';
}

/** 词级判定（MEDIUM 用，阶段复审① F2）：段内**任意位置**的 git→push 链——保住旧 ERE
 *  「行内任意词边界」的覆盖面（`sh -c "git push -f …"`、env 前缀、echo 文本等形态不收窄）。 */
function segmentHasGitPush(words) {
  for (let i = 0; i < words.length; i += 1) {
    if (!isGitWord(stripQuotes(words[i]))) continue;
    if (subcommandAfterGlobals(words, i + 1) === 'push') return true;
  }
  return false;
}

/** MEDIUM git push 行（B1 起词级函数，替代正则行）：push 子命令（按分隔符分段——复合命令
 *  行级语义维持）且带力旗标（token 级）或 +refspec 力语法 → ask。 */
function mediumForcePush(cmd) {
  return String(cmd).split(/[;&|\n]/).some((seg) => {
    const words = splitWords(seg);
    if (!segmentHasGitPush(words)) return false;
    return words.some(forceFlagOf) || words.some((w) => w.startsWith('+') && w.length > 1);
  });
}

/** H2 力来源的加号力语法（+refspec——非空白字符随行；词级判定见 forceFlagOf）。 */
const H2_PLUS_RE = new RegExp(`(^|${SP})\\+${NSP}`);

/**
 * H2：强推主分支（源 :161-199；B1 起词级 push 判定——HEAD 正则的紧邻要求漏掉 bundled 力
 * 旗标与 git 全局旗标前置段）。命中显式 main/master ref → true；无显式 ref
 * （或仅一个疑似 remote 名）时借 cwd 探测当前分支，主分支才升 deny，探测不到
 * 留给 MEDIUM。
 * @param {string} cmd
 * @param {string} cwd
 * @returns {boolean}
 */
function highForcePushDefault(cmd, cwd) {
  if (!isSimpleCommand(cmd)) return false;
  const words = splitWords(cmd);
  if (!wordsAreGitPush(words)) return false;
  if (!words.some(forceFlagOf) && !matchEre(H2_PLUS_RE, cmd)) return false;
  let hit = false;
  let others = 0;
  let pushCwd = ''; // 阶段复审① F3：`git -C <他仓>` 的目标仓——cwd 探测跟随 -C，否则误读会话仓
  for (let i = 0; i < words.length; i += 1) {
    const raw = stripQuotes(words[i]);
    const w = raw.toLowerCase(); // 终审③：NTFS 大小写不敏感下 `Git push -F` 真实可执行——命令词/旗标词/ref 归一后判定（-C/-C 需原始大小写区分，见下）
    if (raw === '-C' && i + 1 < words.length) {
      pushCwd = stripQuotes(words[i + 1]); // -C（大写）＝目标仓路径，探测跟随（阶段复审① F3）
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(w) && i + 1 < words.length) {
      i += 1; // 终审①：带值全局旗标（-c/-C/--git-dir 等）的值 token 不是 ref——跳过
      continue;
    }
    if (w === 'git' || w === 'push' || w === 'sudo' || w.startsWith('-') || isGitWord(w)) continue;
    let tail = w.startsWith('+') ? w.slice(1) : w; // 去掉力语法前导加号
    if (tail.includes(':')) tail = tail.slice(tail.lastIndexOf(':') + 1); // refspec 取冒号后目标 ref
    tail = tail.replace(/^refs\/heads\//, ''); // 终审②：全 refspec 形态剥前缀归一
    if (tail === 'main' || tail === 'master') hit = true;
    else others += 1;
  }
  if (hit) return true;
  const probeCwd = pushCwd !== '' ? pushCwd : cwd;
  if (others <= 1 && probeCwd !== '' && isDir(probeCwd)) {
    const r = spawnSync('git', ['-C', probeCwd, 'branch', '--show-current'], { encoding: 'utf8' });
    const cur = (r.stdout ?? '').trim();
    if (cur === 'main' || cur === 'master') return true;
  }
  return false;
}

/** 目录存在性判定（bash `[ -d ]` 等价）。 */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** H3：裸 git reset --hard（源 :204-206）——--hard 之后到行尾无 ref；不受单一命令门槛限制。 */
const H3_RE = new RegExp(`(^|[;&|]${SP}*)git${SP}+reset(${SP}+-[a-zA-Z]+)*${SP}+--hard${SP}*$`);

/** H4：DROP DATABASE（源 :209-213）——小写化后匹配；不限单一命令。 */
const H4_RE = new RegExp(`drop${SP}+database`);

/**
 * H4 客户端共现（内部未决-62，内部任务-44）：整库删除 deny 需数据库客户端在场；纯文本提及降 ask。
 * 判定输入与 H4_RE 同跑在小写化命令串上；词表为**封闭枚举**——漏收录客户端（如 sqlplus/mysqlsh/
 * 超集名 pg_dumpall 被词字符边界排除）⇒ 该例降 ask，属已裁决方向（误拒代价高于误 ask）；补词走下一守卫批次。
 */
const DB_CLIENT_RE = /(^|[^0-9a-z_.-])(mysql|mysqldump|mariadb|psql|pg_dump|pg_restore|sqlite3|sqlcmd|cockroach|beeline|isql|db2)([^0-9a-z_.-]|$)/;

/** 主流程：fail-open 全段（解析失败/命令空/未命中一律静默 exit 0），HIGH 先判 deny、MEDIUM 后 ask。 */
async function main() {
  let payload;
  let cmd = '';
  let cwd = '';
  try {
    payload = JSON.parse(await readStdin());
    bindHookContext({ sessionKey: pickString(payload, ['session_id']) }); // 内部任务-290：崩溃留痕归属到会话（内部未决-260）
    cmd = pickString(payload, ['tool_input', 'command']);
    if (cmd === '') process.exit(0); // 解析失败或无命令字段：ask 档护栏 fail-open 放行（B-M8-1）
    cwd = pickString(payload, ['cwd']);
  } catch {
    process.exit(0); // JSON 不可解析：fail-open 放行
  }
  // 内部任务-8（内部规则-17）工具族分流：**已命名**的非 shell 族负载静默放行（漂移防护——防未来宿主
  // 给 edit/只读族负载也带 tool_input.command 时危险命令护栏误拦编辑/读取操作）。
  // 负载无工具名（legacy 形态）保持现状判定：command 面照常判定，既有语义零漂移。
  const toolName = pickString(payload, ['tool_name']);
  if (toolName && familyOf(toolName) !== 'shell') process.exit(0);
  const norm = normalizeCommandText(cmd); // 内部任务-244 S05：保守词法归一（空引号拼接/${IFS}）后再判定
  if (process.env.GUARD_HOOK_INJECT_CRASH === '1') throw new Error('inject-crash');
  if (highRmRoot(norm)) {
    emitPreToolUseDecision('deny', '[careful][HIGH] 已阻断：递归删除根目录/家目录不可恢复。如确属意图，请在终端人工执行。');
  }
  if (highForcePushDefault(norm, cwd)) {
    emitPreToolUseDecision('deny', '[careful][HIGH] 已阻断：向主分支强推会改写公共历史。请改用 --force-with-lease 或在特性分支操作。');
  }
  if (matchEre(H3_RE, norm)) {
    emitPreToolUseDecision('deny', '[careful][HIGH] 已阻断：未指定 ref 的 git reset --hard 会丢弃全部未提交改动。请改用带 ref 的形式逐项确认。');
  }
  if (matchEre(H4_RE, norm.toLowerCase())) {
    // 内部未决-62（内部任务-44）：客户端共现维持 deny（既有语义）；纯文本提及（提交说明/grep 模式串等）降 ask
    if (DB_CLIENT_RE.test(norm.toLowerCase())) {
      emitPreToolUseDecision('deny', '[careful][HIGH] 已阻断：DROP DATABASE 会删除整个数据库。如确属意图，请在终端人工执行。');
    } else {
      emitPreToolUseDecision('ask', '[careful] 建议确认：命令文本提及整库删除短语但未见数据库客户端命令。操作具破坏性，请确认意图后再放行。');
    }
  }
  for (const [matcher, desc] of MEDIUM_TABLE) {
    const hit = typeof matcher === 'function' ? matcher(norm) : matchEre(matcher, norm);
    if (hit) {
      emitPreToolUseDecision('ask', `[careful] 建议确认：${desc}。操作具破坏性，请确认意图后再放行。`);
    }
  }
  process.exit(0);
}

/**
 * 内置自检（B-M8-4，断言集对齐 bash 版 :268-273）：子进程驱动自身六断言。
 * @returns {number}
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const me = fileURLToPath(import.meta.url);
  const run = (payload) => {
    const r = spawnSync(process.execPath, [me], { input: payload, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '' };
  };
  const pay = (command) => JSON.stringify({ tool_input: { command } });
  const a = run(pay('rm -rf /'));
  check('HIGH rm 根删除 deny(2)', a.status === 2 && a.stdout.includes('deny'));
  const b = run(pay('git reset --hard HEAD~2'));
  check('MEDIUM reset 带 ref ask(0)', b.status === 0 && b.stdout.includes('ask'));
  check('deny 信封契约（hookEventName）', a.stdout.includes('"hookEventName":"PreToolUse"'));
  check('ask 信封契约（hookEventName）', b.stdout.includes('"hookEventName":"PreToolUse"'));
  const c = run(pay('git status --short'));
  check('干净命令放行（零输出）', c.status === 0 && c.stdout.trim() === '');
  const d = run('not-json');
  check('负载垃圾放行（fail-open）', d.status === 0 && d.stdout.trim() === '');
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL check-careful.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK check-careful.mjs selftest（${checks.length} 项通过）\n`);
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
    process.stdout.write('用法：check-careful.mjs [选项]\n  （无参数）从 stdin 读宿主 JSON 负载，检查 tool_input.command\n  --selftest 运行内置自检（B-M8-4）\n  --help    显示本说明\n');
    process.exit(0);
  }
  installHookErrorTrap('check-careful'); // 未决策的异常死亡改写为 exit 0（fail-open）
  runHookMain('check-careful', main);
}
