// 文件：write-policy.mjs
// 描述：写仓闸/归因账的策略单源（内部决策-066 D4/D5，内部任务-261）——纯数据＋纯函数、零 I/O 零 spawn：
//       C1-C6 写意图分类（C1 仅命中「仓内目标」重定向，tmp/特殊设备不误报；含 `>|`）、受信命令
//       精确匹配（canonical 脚本路径＋子命令；含重定向/换行/复合一律不授信）、逐类模式解析
//       （默认 C1-C4 enforce、C5 恒 shadow、C6 不归闸；classes 只作用 C1-C4，classes.C5 拒绝/
//       忽略并 warning）、decideWriteIntent 统一裁决（allow/deny/record/skip）与坏 scriptWrites
//       降级。hooks 与 scripts 共用本文件，禁止复制词表（删词即红由测试锁定）。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；纯函数；无宿主术语分支；不碰文件系统。
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 分类闭集（C6 为 VCS 操作：不归写仓闸，由归因账单列）。 */
export const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

/** 写 API 词表（C3/C4 命中面；封闭枚举，改动须同批改测试）。 */
const WRITE_API_RE = /(writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|openSync|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync|write_text|\.write\(|WriteAllText|WriteAllBytes|Set-Content|Out-File|Add-Content)/;

/** 就地编辑工具（C2；内部任务-339/内部未决-254② 起 token 单源判定，整条正则退役；stage 复审 #1：
 * token 匹配须吃下路径前缀（bin/sed）与 win32 可执行后缀（sed.exe）——旧 `\btool\b` 按字面均命中；
 * r3 D3：捕获组即归一工具名——findIndex 处一次完成「识别＋归一」，baseToolName/死回退不另设）。 */
const IN_PLACE_TOOL_TOKEN_RE = /^(?:.*[/\\])?(sed|perl|awk)(?:\.(?:exe|cmd|bat))?$/;

/** 「被执行」的引号载荷（stage 复审 #1）：sh 族 -c 与解释器 -e/--eval/-c/-Command 的引号实参是
 * 代码不是数据——须逐层递归分类（r1 三维#2：保留与 INLINE_INTERP_RE 同源的 /i——PowerShell
 * 参数不区分大小写）；echo 等数据性引号实参不递归（字面量提及放行面保持）。 */
const SHELL_C_PAYLOAD_RE = /\b(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\s+(?:-{1,2}[a-zA-Z]*c[a-zA-Z]*\s+)?['"](.+)['"]/;
const INTERP_PAYLOAD_RE = /\b(?:node|python[0-9.]*|perl|ruby|pwsh|powershell)\b[^\n;&|]*?(?:\s(?:-e|--eval|-c|-Command)\b)\s+['"](.+)['"]/i;

/** 带值 flag（其后一 token 是该 flag 的实参，不算就地编辑目标）——**按工具分表**（r1 三维#1：
 *  并集表会吞掉唯一受检目标——sed `-E`/gawk `-M`/`-C` 不带值、`--var` 不存在；跳过带值实参
 *  须以该工具确带值为前提；r2 补：perl `-F`（仅粘连形态）/`-0`/`-C` 均不消费下一 token，删；
 *  旧并集常量 VALUE_FLAGS 已删——死代码且注释与新语义矛盾）。 */
const VALUE_FLAGS_BY_TOOL = {
  sed: new Set(['-f', '--file', '-e', '--expression']),
  perl: new Set(['-e', '-E', '-M', '-m']),
  awk: new Set(['-f', '-v', '--file']),
};

/** 旧整条正则族（仅作「被执行载荷」内的保守兜底——载荷内还嵌引号的数据（如 execSync('sed …')）
 * token 流抽不出工具名，宁多拦不漏拦；顶层不使用——echo 类字面量提及的放行面保持）。 */
const LEGACY_IN_PLACE_RES = [
  /\bsed\b[^\n;&|]*\s-{1,2}[a-zA-Z]*i/,
  /\bsed\b[^\n;&|]*--in-place\b/,
  /\bperl\b[^\n;&|]*\s-[a-zA-Z]*i/,
  /\bawk\b[^\n;&|]*\s-i\s+inplace\b/,
];
/** 解释器内联执行（C3）。 */
const INLINE_INTERP_RE = /\b(node|python[0-9.]*|perl|ruby|pwsh|powershell)\b[^\n;&|]*?(?:\s-e\b|\s--eval\b|\s-c\b|\s-Command\b)/i;
/**
 * heredoc 喂解释器（C4）：含 `node - <<EOF` 形态；**内部任务-308/内部未决-279** 起亦覆盖
 * 解释器与 `<<` 之间夹 `-`/`--` 选项的形态（如 `node --input-type=module <<'EOF'`），
 * 避免此前 flag 夹中间导致 `cls=null → skip` 的零拦截漏判。
 */
const HEREDOC_INTERP_RE = /(?:^|[\n;])\s*\b(node|python[0-9.]*|perl|ruby|pwsh|powershell)\b(?:\s+-{1,2}\S*(?:\s+(?!<)\S+)?)*\s+<</i;

/** 文件操作命令（C5）。 */
const FILE_OPS = new Set(['cp', 'mv', 'rm', 'ln', 'touch', 'truncate', 'tee', 'install', 'rsync']);

/** VCS 写工作树操作（C6）。 */
const VCS_RE = /^\s*git\s+(apply|restore|checkout|clean)\b/;

/** 受信写者/受信命令表（canonical 相对路径；subs 为空数组表示任意参数）。 */
const TRUSTED_SCRIPTS = new Map([
  ['workflow/scripts/mechanical-edit.mjs', []],
  ['workflow/scripts/evidence-gen.mjs', []],
  ['workflow/scripts/incident-cli.mjs', []],
  ['workflow/scripts/check-test-anchors.mjs', []],
  ['workflow/scripts/check-residuals.mjs', []],
  ['workflow/hooks/routing-declare.mjs', []],
  ['plugin-core/cli.mjs', ['materialize', 'verify']],
  ['zcode-adapter/cli.mjs', ['bump', 'verify', 'publish', 'install']],
  ['mcode-adapter/cli.mjs', []],
  ['kimi-code-adapter/cli.mjs', []],
  ['spec-gate/core/validator/validate_specs.mjs', []],
  ['workflow/scripts/generate-project-skills-manifest.mjs', ['--apply']],
  ['scripts/check-repo-consistency.mjs', []],
  ['scripts/coverage-gate.mjs', []],
  ['scripts/release-suite.mjs', []],
  ['scripts/verify-core-baseline.mjs', []],
]);

/** 从命令文本取首选词（受信命令不走 shell 复合形态；此处仅用于受信白名单）。 */
function words(cmd) {
  return String(cmd ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 目标是否落在 canonical 仓根内（纯词法；symlink 逃逸由工具侧 realpath 判定另行兜底）。
 * @param {string} root 仓根
 * @param {string} target 命令中的目标路径（可相对；相对路径按 cwd 解析，缺省＝root）
 * @param {string} [cwd] 命令执行目录（payload.cwd；缺省 root）
 * @returns {boolean}
 */
export function isInsideRoot(root, target, cwd = root) {
  const rootAbs = resolve(root);
  const t = String(target ?? '');
  if (t.startsWith('~')) return false;
  // 异盘/异形态绝对路径（posix 上的 C:\…）：不属于本仓（D10 仓外不约束），按仓外处理
  if (/^[A-Za-z]:[\\/]/.test(t) && !/^[A-Za-z]:[\\/]/.test(rootAbs)) return false;
  const abs = isAbsolute(t) ? resolve(t) : resolve(cwd ?? rootAbs, t);
  const rel = relative(rootAbs, abs);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * 裸 token 路径候选共享辅助（内部任务-339/内部未决-254⑤）：extractPathCandidates（带分隔符形态）
 * 与 scriptContentCandidates（带扩展名形态）的裸 token 循环单源。
 */
function barePathTokens(text, { extensionForm = false } = {}) {
  const out = [];
  for (const tok of String(text ?? '').split(/\s+/)) {
    const t = tok.replace(/^['"]|['"]$/g, '');
    if (!t || t.startsWith('-') || t.includes('://')) continue;
    if (extensionForm) {
      if (t.includes('/') || t.includes('\\')) continue;
      if (!/^[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8}$/.test(t)) continue;
    } else {
      if (!t.includes('/') && !t.includes('\\')) continue;
      if (/[*?[\]{}^$()]/.test(t)) continue; // shell/正则元字符（非路径）
    }
    if (/^[syg][/|#~]/.test(t)) continue; // sed/perl 表达式形态
    out.push(t);
  }
  return out;
}

/** 从命令文本抽取候选路径（绝对/点相对引号路径＋带扩展名引号相对路径＋含分隔符 token；过滤 sed/perl 表达式与元字符）。 */
function extractPathCandidates(cmd) {
  const out = [];
  const text = String(cmd ?? '');
  const quotedAbsRe = /['"]((?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^'"]{1,300})['"]/g;
  let m;
  while ((m = quotedAbsRe.exec(text)) !== null) out.push(m[1]);
  const quotedRelRe = /['"]((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})['"]/g;
  while ((m = quotedRelRe.exec(text)) !== null) out.push(m[1]);
  out.push(...barePathTokens(text));
  return [...new Set(out.filter((x) => x && !x.includes('\n')))];
}

/** 保守作用域：候选路径中是否有仓内目标；无候选时回退「命中」以保持旧语义。 */
function hasInRootTarget(cmd, root, cwd) {
  const candidates = extractPathCandidates(cmd);
  if (candidates.length === 0) return true;
  return candidates.some((c) => isInsideRoot(root, c, cwd));
}

/**
 * 单条受信脚本命令是否匹配（canonical 脚本路径＋允许的子命令）。
 * @param {string[]} argv
 * @param {string} root
 * @returns {string|null}
 */
function trustedScript(argv, root) {
  let i = 0;
  if (argv[0] === 'node' || argv[0] === process.execPath) i = 1;
  else return null;
  if (argv[i] === '--test') return 'node-test';
  const raw = argv[i];
  if (!raw || raw.includes('*') || raw.includes('?') || raw.startsWith('-')) return null;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, abs).split(sep).join('/');
  if (rel.startsWith('..')) return null;
  const subs = TRUSTED_SCRIPTS.get(rel);
  if (!subs) return null;
  if (subs.length === 0) return rel;
  return subs.includes(argv[i + 1]) ? `${rel}:${argv[i + 1]}` : null;
}

/**
 * 受信命令判定（精确匹配；含复合/通配/重定向/换行/内联执行一律不授信）。
 * 重定向必须在此拒绝：否则 `node <受信脚本> > 仓内文件` 会被误判 trusted 而绕过 C1。
 * @param {string} cmd
 * @param {{root: string}} ctx
 * @returns {{trusted: boolean, id: string|null}}
 */
export function isTrustedCommand(cmd, { root }) {
  const text = String(cmd ?? '').trim();
  if (text === '') return { trusted: false, id: null };
  if (/[;&|<>`]/.test(text) || /[\n\r]/.test(text) || text.includes('$(')) return { trusted: false, id: null };
  const argv = words(text);
  const id = trustedScript(argv, root);
  return { trusted: id !== null, id };
}

/** 引号外 `>`/`>>`/`>|` 目标扫描（C1；跳过 fd dup 与 /dev/* 特殊目标）。 */
function redirectTargets(cmd) {
  const out = [];
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) { if (ch === quote && cmd[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch !== '>') continue;
    let j = i + 1;
    if (cmd[j] === '|') j += 1; // `>|` 覆写重定向（D4 明列），不是管道
    else while (cmd[j] === '>') j += 1;
    while (cmd[j] === ' ' || cmd[j] === '\t') j += 1;
    if (cmd[j] === '&') { i = j; continue; } // fd dup（2>&1）
    let target = '';
    if (cmd[j] === '"' || cmd[j] === "'") {
      const q = cmd[j];
      j += 1;
      while (j < cmd.length && cmd[j] !== q) { target += cmd[j]; j += 1; }
    } else {
      const start = j;
      while (j < cmd.length && !/[\s;&|]/.test(cmd[j])) j += 1;
      target = cmd.slice(start, j);
    }
    if (target && target !== '/dev/null' && !target.startsWith('/dev/')) out.push(target);
    i = j - 1;
  }
  return out;
}

/**
 * 引号感知 tokenizer（内部任务-285，供 C2 操作数解析；内部任务-339 补反斜杠转义——与
 * splitOutsideQuotes 的单层语义对齐）：按空白切分、剥引号、保留引号内空白。
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeQuoted(text) {
  const out = [];
  const s = String(text ?? '');
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== '') out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * 引号感知的 shell 段切分（内部任务-285 code-review r1）：引号内的 `; & |` 是 sed/perl 表达式/参数，
 * 不得当命令分隔符——否则 `sed -i 's|a|b|' f` 的目标会被切丢（受检 C2 窄声明可被常见写法绕过）。
 * @param {string} text
 * @returns {string[]}
 */
function splitOutsideQuotes(text) {
  const parts = [];
  let cur = '';
  let quote = null;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * C2 就地编辑判定与目标抽取（内部任务-339/内部未决-254② token 单源）：splitOutsideQuotes 切段、
 * tokenizeQuoted 取 token 流——命中＝段内工具名后出现 sed/perl 短选项串含 i（`-i`/`-pi`/
 * `-pei`/`-i.bak` 前缀）或 `--in-place` 前缀；awk 需 `-i` 且下一 token `inplace`（长选项
 * 不按「含 i」判，防 `--quiet` 误命中）。目标＝工具名后 token 流剔除带值 flag 实参/选项/
 * 表达式/程序块/变量赋值后的剩余 token；**表外未知 flag 的实参默认当目标（多报优于漏报）**。
 * @param {string} text
 * @returns {{hit: boolean, targets: string[]}}
 */
function inPlaceInfo(text, { inPayload = false } = {}) {
  let hit = false;
  const out = [];
  for (const seg of splitOutsideQuotes(text)) {
    // stage 复审 #1：引号包裹的「被执行」载荷逐层递归（sh -c '…'／node -e "…" 内的 sed -i
    // 旧整条正则按字面命中，token 化不得丢失；数据性引号实参〔echo "sed -i …"〕不在此列）。
    for (const payloadRe of [SHELL_C_PAYLOAD_RE, INTERP_PAYLOAD_RE]) {
      const wrapped = seg.match(payloadRe);
      if (wrapped !== null) {
        const sub = inPlaceInfo(wrapped[1], { inPayload: true });
        if (sub.hit) {
          hit = true;
          out.push(...sub.targets);
        }
      }
    }
    const tokens = tokenizeQuoted(seg);
    let at = -1;
    let tool = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const m = tokens[i].match(IN_PLACE_TOOL_TOKEN_RE);
      if (m !== null) { at = i; tool = m[1]; break; } // r3 D3：捕获组即归一名（剥路径/.exe 后缀）
    }
    if (at === -1) {
      // 载荷内的保守兜底：嵌套引号数据（execSync('sed -i …')）token 抽不出工具名——旧正则族
      // 兜底命中（目标仍由 token 抽取合并，可能为空→受检判定走 generic 通道，宁多拦不漏拦）。
      if (inPayload && LEGACY_IN_PLACE_RES.some((re) => re.test(seg))) hit = true;
      continue;
    }
    let segHit = false;
    for (let i = at + 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tool === 'awk') {
        // r3 D4：gawk -i＝--include——分开写 `-i inplace` 与粘连/长形态 `-iinplace`/`--include=inplace`
        if (tok === '-i' && tokens[i + 1] === 'inplace') { segHit = true; i += 1; }
        else if (tok === '-iinplace' || tok === '--include=inplace') segHit = true;
      } else if (/^-(?!-)[a-zA-Z]*i/.test(tok) || tok.startsWith('--in-place')) {
        segHit = true;
      }
    }
    if (!segHit) continue;
    hit = true;
    const valueFlags = VALUE_FLAGS_BY_TOOL[tool];
    let skipNext = false;
    for (let i = at + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (skipNext) { skipNext = false; continue; }
      if (token === 'inplace') continue;
      if (valueFlags.has(token)) { skipNext = true; continue; } // 带值 flag：下一 token 是实参非目标（按工具分表，先于 - 前缀跳过）
      if (token.startsWith('-')) continue;
      if (token.includes('>')) continue; // 重定向符/粘连目标（>tracked.txt）不是文件操作数——受检判定由 redirects 链承载
      if (token.includes('/') && /^(s|y|d|p)[^A-Za-z0-9]/.test(token)) continue; // sed/perl 表达式（含 s|a|b|）
      if (/^[syg][/#~{|,]/.test(token)) continue; // 表达式片段（含 s{a}b / s,a,b 花括号/逗号分隔）
      if (/^\{.*\}$/.test(token)) continue; // awk 程序块（{print}）
      if (token.includes('=') && !token.includes('/') && !token.includes('.')) continue; // 变量赋值
      out.push(token);
    }
  }
  return { hit, targets: [...new Set(out)] };
}

/**
 * C2 就地编辑的目标操作数（内部任务-285；内部任务-339 起为 inPlaceInfo 薄包装，导出签名不变）。
 * @param {string} cmd
 * @returns {string[]}
 */
export function inPlaceTargets(cmd) {
  return inPlaceInfo(cmd).targets;
}

/**
 * C3/C4 文本中的路径候选（内部任务-285）：复用路径抽取启发式（引号路径/带分隔符 token/
 * 带扩展名 token），供受检路径判定。纯启发式、不承诺 sound。
 * @param {string} cmd
 * @returns {string[]}
 */
export function scriptContentCandidates(cmd) {
  const out = extractPathCandidates(cmd);
  const text = String(cmd ?? '');
  // 额外：带扩展名的引号相对文件名（`Path('a.txt')`）与裸 token（`a.txt`）——受检判定需要
  // 仓内相对文件名，基础抽取器只认带分隔符/绝对形态；启发式接受，不承诺 sound。
  const quotedFileRe = /['"]([A-Za-z0-9_.@-]+\.(?:[A-Za-z0-9]{1,8}))['"]/g;
  let m;
  while ((m = quotedFileRe.exec(text)) !== null) out.push(m[1]);
  out.push(...barePathTokens(text, { extensionForm: true }));
  return [...new Set(out.filter((x) => x && !x.includes('\n')))];
}

/**
 * shell 写意图分类（纯文本；不解析变量展开）。
 * @param {string} cmd
 * @param {{root?: string, cwd?: string}} [opts] root 提供时 C1 仅统计「仓内目标」；
 *        C2-C4 亦按候选路径作用域判定（全部候选均在仓外 → 不归类，符合 D10「不约束 tmp/仓外」）
 * @returns {{cls: string|null, targets: string[], redirects: string[], hits: string[]}}
 */
export function classifyShellWrite(cmd, opts = {}) {
  const text = String(cmd ?? '');
  const hits = [];
  if (text.trim() === '') return { cls: null, targets: [], redirects: [], hits };
  if (VCS_RE.test(text)) return { cls: 'C6', targets: [], redirects: [], hits: ['vcs'] };
  const scope = (candidates) => (opts.root ? candidates.filter((t) => isInsideRoot(opts.root, t, opts.cwd)) : candidates);
  const inScope = opts.root === undefined ? true : hasInRootTarget(text, opts.root, opts.cwd);
  const redirectsOf = () => scope(redirectTargets(text)); // 内部任务-339/内部未决-254①：重定向目标单列（受检逐目标恒拒判据）
  if (HEREDOC_INTERP_RE.test(text) && WRITE_API_RE.test(text) && inScope) {
    return { cls: 'C4', targets: scope([...redirectTargets(text), ...scriptContentCandidates(text)]), redirects: redirectsOf(), hits: ['heredoc-interp'] };
  }
  if (INLINE_INTERP_RE.test(text) && WRITE_API_RE.test(text) && inScope) {
    return { cls: 'C3', targets: scope([...redirectTargets(text), ...scriptContentCandidates(text)]), redirects: redirectsOf(), hits: ['inline-write-api'] };
  }
  const ip = inPlaceInfo(text);
  if (ip.hit && (opts.root === undefined || ip.targets.length === 0 || ip.targets.some((t) => isInsideRoot(opts.root, t, opts.cwd)))) {
    // 作用域按 token 目标判定（内部任务-339）：目标解析为空回退命中（保守旧语义）；全部目标仓外不归类（D10）
    return { cls: 'C2', targets: scope(ip.targets), redirects: redirectsOf(), hits: ['in-place'] };
  }
  const targets = redirectTargets(text);
  const scoped = opts.root ? targets.filter((t) => isInsideRoot(opts.root, t, opts.cwd)) : targets;
  if (scoped.length > 0) return { cls: 'C1', targets: scoped, redirects: scoped, hits: ['redirect'] };
  const first = words(text)[0] ?? '';
  if (FILE_OPS.has(first) || /\|\s*tee\b/.test(text) || /\bfind\b[^\n;&|]*-exec\b/.test(text)) {
    return { cls: 'C5', targets: [], redirects: [], hits: ['file-op'] };
  }
  return { cls: null, targets: [], redirects: [], hits };
}

/** 默认逐类有效模式（C6 不归闸＝null）。 */
function defaultModes() {
  return { C1: 'enforce', C2: 'enforce', C3: 'enforce', C4: 'enforce', C5: 'shadow', C6: null };
}

/**
 * 逐类模式解析：env（测试缝）> 项目配置 > 默认；classes 只作用 C1-C4，C5 强制 shadow。
 * 内部任务-285/内部决策-066 修正案 1 内部模块-4：另解析 tracked tier 模式（默认 enforce；配置 `trackedTier`
 * 可降 shadow；env 缝 `WF_WRITE_GUARD_TRACKED_TIER` 优先；非法回落默认并告警）。
 * @param {{envMode?: string, envTrackedTier?: string, configRaw?: string|null}} opts
 * @returns {{mode: string|null, source: string, modes: Record<string,string|null>, trackedTier: 'enforce'|'shadow', warning: string|null}}
 */
export function resolveMode({ envMode, envTrackedTier, configRaw } = {}) {
  const modes = defaultModes();
  const warnings = [];
  let source = 'default';
  let globalMode = null;
  let trackedTier = 'enforce';
  if (configRaw !== undefined && configRaw !== null && String(configRaw).trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(String(configRaw));
    } catch {
      warnings.push('write-guard 配置 JSON 无法解析，回落默认');
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      source = 'config';
      if (parsed.mode === 'shadow' || parsed.mode === 'enforce') {
        globalMode = parsed.mode;
        for (const c of ['C1', 'C2', 'C3', 'C4']) modes[c] = parsed.mode;
      } else if (parsed.mode !== undefined) {
        warnings.push(`write-guard 配置 mode 非法（${String(parsed.mode)}），回落默认`);
      }
      const classes = parsed.classes;
      if (classes !== undefined) {
        if (!classes || typeof classes !== 'object') warnings.push('write-guard 配置 classes 非法，忽略');
        else {
          for (const [key, value] of Object.entries(classes)) {
            if (key === 'C5' || key === 'C6') { warnings.push(`classes.${key} 不生效（C5 恒 shadow、C6 不归闸），已忽略`); continue; }
            if (!['C1', 'C2', 'C3', 'C4'].includes(key)) { warnings.push(`classes 未知类 ${key}，已忽略`); continue; }
            if (value !== 'shadow' && value !== 'enforce') { warnings.push(`classes.${key} 取值非法（${String(value)}），已忽略`); continue; }
            modes[key] = value;
          }
        }
      }
      // 内部任务-285：tracked tier 模式（受检路径分级），默认 enforce；非法回落默认并告警。
      if (parsed.trackedTier !== undefined) {
        if (parsed.trackedTier === 'shadow' || parsed.trackedTier === 'enforce') trackedTier = parsed.trackedTier;
        else warnings.push(`write-guard 配置 trackedTier 非法（${String(parsed.trackedTier)}），回落默认 enforce`);
      }
    }
  }
  if (envMode === 'shadow' || envMode === 'enforce') {
    source = 'env';
    modes.C1 = envMode; modes.C2 = envMode; modes.C3 = envMode; modes.C4 = envMode;
    modes.C5 = 'shadow';
  } else if (envMode !== undefined && envMode !== null && envMode !== '') {
    warnings.push(`WF_WRITE_GUARD_MODE 非法（${String(envMode)}），回落默认`);
  }
  if (envTrackedTier === 'shadow' || envTrackedTier === 'enforce') {
    source = 'env';
    trackedTier = envTrackedTier;
  } else if (envTrackedTier !== undefined && envTrackedTier !== null && envTrackedTier !== '') {
    warnings.push(`WF_WRITE_GUARD_TRACKED_TIER 非法（${String(envTrackedTier)}），回落默认 enforce`);
  }
  return { mode: globalMode, source, modes, trackedTier, warning: warnings.length > 0 ? warnings.join('；') : null };
}

/** 归一化租约 scriptWrites（坏数据→declared=false＋degraded，不放大为放行）。 */
function normalizeDeclarations(scriptWrites) {
  if (scriptWrites === undefined || scriptWrites === null) return { declared: false, degraded: false };
  if (!Array.isArray(scriptWrites)) return { declared: false, degraded: true };
  const ok = scriptWrites.every((e) => e && typeof e === 'object' && typeof e.reason === 'string' && e.reason.trim().length >= 8);
  if (!ok) return { declared: false, degraded: true };
  return { declared: scriptWrites.length > 0, degraded: false };
}

/** 逐目标三态跟踪判定（内部任务-285）：`isTracked` 缺省/异常/返回非法值一律按 unknown。 */
function trackedStateOf(target, isTracked) {
  if (typeof isTracked !== 'function') return 'unknown';
  try {
    const state = isTracked(target);
    return state === 'tracked' || state === 'untracked' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 写仓意图裁决（单点）。受信命中也要求无写意图（cls===null），否则按普通命令走分类/模式，
 * 防「受信脚本＋重定向」借壳写仓。
 * 内部任务-285/内部决策-066 修正案 1 内部模块-3：受检路径（git 跟踪）分级——C1 重定向受检目标直接拒绝（任何
 * 声明不放行）；C2/C3/C4 受检目标只认 `scriptEditCode`（通用 `scriptWrites` 不足）；目标解析
 * 不出/非受检维持现行；混合目标任一受检从严；`isTracked` 任一 unknown → `trackedDegraded=true`
 * 且不静默降格（未知路径按未受检裁决但事实面标 degraded）；trackedTier=shadow 时只记录
 * （`trackedTierViolation`＝「enforce 档会拦」——重定向受检/C1/窄声明缺额时 true，窄声明
 * 足额的纯就地受检编辑为 false；内部任务-339 stage 复审 #2）。
 * @param {{cmd: string, root: string, cwd?: string, mode: ReturnType<typeof resolveMode>, scriptWrites?: unknown, scriptEditCode?: unknown, isTracked?: (repoRelPath: string) => 'tracked'|'untracked'|'unknown'}} input
 * @returns {{cls: string|null, trusted: boolean, declared: boolean, decision: 'allow'|'deny'|'record'|'skip', reason: string, targets: string[], degraded: boolean, tier: 'tracked'|null, trackedTargets: string[], trackedDegraded: boolean, trackedTierViolation: boolean}}
 */
export function decideWriteIntent({ cmd, root, cwd, mode, scriptWrites, scriptEditCode, isTracked } = {}) {
  const { cls, targets, redirects } = classifyShellWrite(cmd, { root, cwd });
  const decl = normalizeDeclarations(scriptWrites);
  const editDecl = normalizeDeclarations(scriptEditCode);
  const trusted = isTrustedCommand(cmd, { root });
  // 受检路径分级事实面（只对仓内目标判定；无 root/无候选 → 不产生 tier）。r1 三维（正确性#1）：
  // 重定向目标并入受检态判定——`>tracked.txt`（无空格）等形态下重定向目标不进分类 targets，
  // 仅按 targets 构造 tier 会使逐目标恒拒不触发、generic 声明放行受检重定向写。
  const redirectList = redirects; // r3 D2：classifyShellWrite 各分支恒带数组（@returns 契约）——无手搓入参路径，不加守卫
  const inRoot = root ? targets.filter((t) => isInsideRoot(root, t, cwd)) : targets;
  const states = [...new Set([...inRoot, ...redirectList])].map((target) => ({ target, state: trackedStateOf(target, isTracked) }));
  const trackedTargets = states.filter((s) => s.state === 'tracked').map((s) => s.target);
  const trackedUnknown = states.some((s) => s.state === 'unknown');
  const tier = trackedTargets.length > 0 ? 'tracked' : null;
  const trackedDegraded = trackedUnknown;
  const trackedTier = mode?.trackedTier === 'shadow' ? 'shadow' : 'enforce';
  const base = {
    cls,
    targets,
    tier,
    trackedTargets,
    trackedDegraded,
    trackedTierViolation: false,
    degraded: decl.degraded || editDecl.degraded,
  };
  if (trusted.trusted && cls === null) {
    return { ...base, trusted: true, declared: decl.declared || editDecl.declared, decision: 'allow', reason: `trusted:${trusted.id}` };
  }
  if (cls === null) return { ...base, trusted: false, declared: decl.declared || editDecl.declared, decision: 'skip', reason: 'no-write-intent' };
  if (cls === 'C6') return { ...base, trusted: false, declared: decl.declared, decision: 'skip', reason: 'vcs' };
  // 受检路径分级（优先于通用声明面）
  if (tier === 'tracked') {
    // 内部任务-339/内部未决-254①：重定向受检目标逐目标恒拒（与宿主类无关）——混合形态（如
    // `sed -i 'x' f > tracked.txt` 判 C2）中的重定向写不得经窄声明放行，也不因就地/内联
    // 目标可窄声明而豁免。C1（redirects＝targets）与无空格/复合形态（重定向目标只进
    // redirects）均由 redirectHit 覆盖（r1 三维#1：redirects 并入受检态构造后恒可达）。
    const redirectsSet = new Set(redirectList);
    const redirectHit = trackedTargets.some((t) => redirectsSet.has(t));
    if (trackedTier === 'shadow') {
      // stage 复审 #2：违例旗＝「enforce 档会拦」（窄声明足额的受检 C2 在 enforce 下放行，
      // 不是违例）——shadow 观测与 wouldBeDeny 口径一致。
      const violation = redirectHit || editDecl.declared !== true;
      return { ...base, trusted: false, declared: decl.declared || editDecl.declared, decision: 'record', reason: 'tracked-shadow', trackedTierViolation: violation };
    }
    if (redirectHit) {
      return { ...base, trusted: false, declared: decl.declared || editDecl.declared, decision: 'deny', reason: 'tracked-redirect-rejected', trackedTierViolation: true };
    }
    if (editDecl.declared) {
      return { ...base, trusted: false, declared: true, decision: 'allow', reason: 'declared-edit-code' };
    }
    return { ...base, trusted: false, declared: false, decision: 'deny', reason: 'tracked-needs-script-edit-code', trackedTierViolation: true };
  }
  if (decl.declared) return { ...base, trusted: false, declared: true, decision: 'allow', reason: 'declared' };
  const effective = mode?.modes?.[cls] ?? null;
  if (cls === 'C5' || effective === 'shadow') {
    return { ...base, trusted: false, declared: false, decision: 'record', reason: cls === 'C5' ? 'c5-shadow' : 'shadow' };
  }
  if (effective === 'enforce') return { ...base, trusted: false, declared: false, decision: 'deny', reason: 'no-declaration' };
  return { ...base, trusted: false, declared: false, decision: 'record', reason: `mode-unknown:${String(effective)}`, degraded: true };
}
