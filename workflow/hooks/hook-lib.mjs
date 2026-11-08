// 文件：hook-lib.mjs
// 描述：workflow 钩子脚本的无状态小工具共享库（内部模块-15 批次收拢——readStdin 与会话键
//       sha256 消毒此前各钩散拷，2026-09-13 三维评审 S5 处置；「单一事实源，不留
//       双份拷贝」同 task-lease-lib 纪律）。新钩一律从这里取；user-prompt/routing-gate
//       的历史本地拷贝已于 2026-09-19 评审修复批迁移完毕（readStdin/stateFile 消费
//       sessionStateFile，落盘文件名形态不变）。
//       2026-09-13 加固批次：sessionStateFile 缺省目录改 runtimeStateDir（A4，跨
//       重启存活）；新增 installHookErrorTrap（B1① 崩溃落盘）；appendStopProbe
//       （C1 Stop 通道探针，临时观测件）已随 2026-09-19 评审修复批移除——观测结论
//       已消费（P9 回退兜底，内部决策-025 ③），历史见 learnings 2026-09-16。
//       2026-09-15 内部未决-14 批次：新增 preToolUseEnvelope/emitPreToolUseDecision
//       （check-careful/check-freeze 护栏钩共用 PreToolUse 信封助手——bash 版两钩
//       各持一份逐字拷贝的 _emit，移植后收敛为单一事实源）。
//       2026-10-08 内部任务-20 A1：新增 pluginRootDir/incidentCliCommand/isDelegatedSession——
//       注入文本里的命令一律**插件根绝对路径**（消费仓仓相对路径必 MODULE_NOT_FOUND，F5）；
//       委派会话判据单点承载（三 Hook 共用，防语义三写漂移）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeStateDir } from './routing-lib.mjs';
import { hostOf } from '../scripts/lib/host-detect.mjs';

/**
 * 钩级上下文（内部任务-290/内部未决-260）：让 `noteHookIssue` 能把错误归属到具体会话。
 * 由钩子在解析负载后调用 `bindHookContext({ sessionKey })` 绑定；未绑定则不写该字段。
 * 为什么用模块级单槽而非传参：`runHookMain` 的 catch 与 `noteHookIssue` 都拿不到
 * main() 内部解析出的 payload，单槽是唯一不改全部调用签名的落点。
 */
let hookCtx = {};

/**
 * 绑定本进程的钩级上下文（仅取 `sessionKey`；非字符串忽略）。
 * @param {{sessionKey?: unknown}} ctx 上下文
 * @returns {void}
 */
export function bindHookContext(ctx) {
  const key = ctx && typeof ctx === 'object' ? ctx.sessionKey : undefined;
  if (typeof key === 'string' && key !== '') hookCtx = { sessionKey: key };
}

/**
 * 错误摘要脱敏（内部任务-290）：抹掉 Windows 盘符绝对路径与含分隔符的路径片段，再限长。
 * 为什么要脱敏：`hook-errors.jsonl` 是长期留档，栈常含本机路径；只保留"哪类错"不泄露目录结构。
 * 副作用：会把 `and/or` 这类正文片段也当路径抹掉——对错误摘要的可读性无实质影响。
 * @param {unknown} err 错误对象或任意值
 * @returns {string} 脱敏后摘要（≤200 字符）
 */
export function sanitizeError(err) {
  return String(err?.stack ?? err)
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>')
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    .slice(0, 200);
}

/**
 * 展示面文本净化（内部任务-244 S04/S07）：剥除 C0/C1 控制字符（含换行、ESC、OSC 终结符）
 * 并限长——账本/登记册内容在终端与模型上下文中只作**数据**展示，不得让控制序列
 * （ANSI 注入）或超长文本进入渲染/注入帧。
 * **单源位置**：定义在本文件（hooks 层纯函数，只依赖本层与一个零依赖纯模块
 * `scripts/lib/host-detect.mjs`——无任何 import 的纯函数模块，内部任务-290 起为 `host` 归因引入）。
 * 裁剪树场景须复制三件：`hooks/hook-lib.mjs`、`hooks/routing-lib.mjs`、`scripts/lib/host-detect.mjs`。
 * 本文件不得反向 import 其余脚本层模块；「零依赖」的实质约束是"不带传递依赖"——
 * 消费方（`check-careful.mjs`、`check-freeze.mjs`）早已各自 import `scripts/lib/tool-families.mjs`。
 * scripts 侧消费方经 incident-store 再导出。
 * @param {unknown} value 原始文本
 * @param {number} [max] 最大保留字符数（默认 200）
 * @returns {string}
 */
export function sanitizeDisplayText(value, max = 200) {
  return String(value ?? '')
    // C0/C1（含 LF/TAB）→ 空格：展示面单行化，防多行注入伪造额外输出行（阶段门评审）
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, max);
}

/** 账本 kind 展示白名单（内部任务-244 S04）：唯一生产者见 内部模块-15/内部决策-063；未知/畸形值一律归一 unknown。 */
export const KNOWN_INCIDENT_KINDS = new Set([
  'tool-failure', 'hook-failure', 'lease-deny', 'lease-revive', 'bootstrap-reissue',
  'lease-read-anomaly', 'lease-loop', 'retry-loop', 'user-correction', 'observation-degraded',
]);

/**
 * kind 展示归一（内部任务-244 S04）：非白名单值显示 `unknown`，防任意注入文本以 kind 形态
 * 进入 Stop/自察注入帧（账本行只校验 id，kind 无枚举——注入面必须在消费侧收口）。
 * @param {unknown} kind
 * @returns {string}
 */
export function sanitizeIncidentKind(kind) {
  return typeof kind === 'string' && KNOWN_INCIDENT_KINDS.has(kind) ? kind : 'unknown';
}

/**
 * 读 stdin 全文（宿主负载）。关闭/出错都解析为空串，交由 fail-open 路径处理。
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/**
 * sha256 前 16 位摘要（**单源**，内部任务-244 Q10）：会话键 / 仓键 / claim 文件名 / 账本 digest
 * 等「脱敏短摘要」统一走本函数（原 hook-lib、task-lease-lib、incident-store 各写一份同构）。
 * @param {string} text 原文（调用方自行保证拼接口径）
 * @returns {string} 16 位 hex
 */
export function digest16(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 会话键 → 状态文件路径：键先做 sha256 摘要再截断（宿主负载字段值不可信，不能
 * 让它直接成为路径成分——路径分隔符/越界字符，哈希后天然消毒；user-prompt 同款惯例）。
 * @param {string} prefix 文件名前缀（如 wf-posttool / wf-recap）
 * @param {string} key 会话键
 * @param {string} [stateDirOverride] 环境注入缝目录（缺省 runtimeStateDir，A4）
 * @returns {string}
 */
export function sessionStateFile(prefix, key, stateDirOverride) {
  const digest = digest16(key);
  const dir = stateDirOverride || runtimeStateDir();
  return join(dir, `${prefix}-${digest}.json`);
}

/**
 * 钩子崩溃落盘（B1①，2026-09-13 加固批次）：装 uncaughtException/unhandledRejection
 * 陷阱——main().catch 之外的漏网抛错（模块级、原生层）写 <runtimeStateDir>/hook-errors.jsonl
 * （O_APPEND 单行 JSON：ts/script/error 截断 200 字）后以 exit 0 收场，fail-open 姿态
 * 不破。诚实限制：宿主杀进程（用户按停，进程已死）与 import 失败（无 JS 可跑）不可
 * 捕获——前者靠宿主日志 v4.stop 时间关联诊断（本会话 5 次实录），后者发布前 selftest 挡。
 * @param {string} scriptName 脚本标识（入日志 script 字段）
 */
export function installHookErrorTrap(scriptName) {
  const trap = (err) => {
    try {
      const dir = runtimeStateDir();
      mkdirSync(dir, { recursive: true });
      const msg = String(err?.stack ?? err).slice(0, 200);
      appendFileSync(join(dir, 'hook-errors.jsonl'), `${JSON.stringify({ ts: Date.now(), script: scriptName, error: msg })}\n`);
    } catch {
      /* 落盘失败不反噬：fail-open 到底 */
    }
    process.exit(0);
  };
  process.on('uncaughtException', trap);
  process.on('unhandledRejection', (reason) => trap(reason));
}

/**
 * 钩自身处置失败的**归因落盘**（内部模块-15 v2 内部规则-7/内部决策-063 D8，2026-10-24 内部任务-192）：
 * 账本写失败、统一处置失败、就绪面检查失败等「新失败面」必须留痕，不得静默——
 * 与 installHookErrorTrap 写同一文件（`<runtimeStateDir>/hook-errors.jsonl`，O_APPEND 单行），
 * 但字段语义不同：`reason` 是**结构化类别名**（如 `disposition-failed`），不是堆栈。
 * 为什么单独入口：trap 只在漏网异常时触发，正常路径的失败汇聚（处置 failed>0）没有出口；
 * 直接内联写盘会让三个钩各抄一份路径/形态（漂移面），故收敛为单一事实源。
 * 全路径不抛（记录职责不得反噬主职责——fail-open）。
 * @param {string} script 脚本标识（如 'post-tool'）
 * @param {string} reason 结构化原因类别名（禁原文/命令/路径）
 */
export function noteHookIssue(script, reason, extra) {
  try {
    const dir = runtimeStateDir();
    mkdirSync(dir, { recursive: true });
    const record = { ts: Date.now(), script: String(script ?? ''), reason: String(reason ?? '').slice(0, 120) };
    // 内部任务-290（内部未决-258/260）：补可诊断内容与宿主归因。字段全可选，旧行（仅 ts/script/error 或 ts/script/reason）读侧零校验兼容。
    const host = hostOf({});
    if (host) record.host = host;
    if (typeof hookCtx.sessionKey === 'string' && hookCtx.sessionKey !== '') record.sessionKey = hookCtx.sessionKey;
    if (extra && extra.error !== undefined) record.error = sanitizeError(extra.error); // 脱敏单源在此，调用方不再处理
    const line = JSON.stringify(record);
    appendFileSync(join(dir, 'hook-errors.jsonl'), `${line}\n`);
  } catch {
    /* 落盘失败不反噬：fail-open 到底 */
  }
}

/**
 * 钩入口统一包装（内部任务-244 E02，内部规则-7 静默面义务）：`main()` 的 rejection 不得被
 * `main().catch(() => process.exit(0))` 无声吞掉——先以结构化原因 `uncaught-in-main`
 * 落 hook-errors.jsonl（与 noteHookIssue 同文件同字段面），再 fail-open exit 0。
 * 为什么 installHookErrorTrap 不够：它只接漏网的 uncaughtException/unhandledRejection；
 * 被 main().catch 主动捕获的 rejection 到不了它，九个钩各留一份同构静默 catch 正是
 * E02 的复现面（收敛为单一入口后，新增钩子不再有"忘了记录"的自由度）。
 * @param {string} script 脚本标识（如 'post-tool'）
 * @param {() => unknown} main 钩主函数
 * @returns {Promise<void>}
 */
export function runHookMain(script, main) {
  process.env.WF_HOOK_SCRIPT = String(script ?? ''); // 锁/降级留痕的持有者标识（incident-store 消费）
  return Promise.resolve()
    .then(main)
    .catch((err) => {
      try {
        noteHookIssue(script, 'uncaught-in-main', { error: err }); // 内部任务-290：把错误内容一并留痕（内部未决-258）
      } catch {
        /* fail-open：记录职责不得反噬 */
      }
      process.exit(0);
    });
}

/**
 * PreToolUse 决策信封构造（纯函数，内部规则-6 信封契约）：信封必须嵌套在 hookSpecificOutput
 * 下且 hookEventName 与触发事件一致，缺失整帧被宿主丢弃；deny → exit 2（宿主拦截），
 * ask → exit 0（宿主弹窗），放行由调用方零输出实现（不经过本函数）。
 * @param {string} decision 'deny' | 'ask'
 * @param {string} systemMessage 用户可见文案
 * @returns {string} 单行 JSON（stdout 原样写出）
 */
export function preToolUseEnvelope(decision, systemMessage) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, systemMessage: String(systemMessage) } });
}

/**
 * PreToolUse 决策信封发射：写出 stdout 并按决策退出（deny=2 / ask=0）。经显式
 * process.exit 退出，不会被 installHookErrorTrap 改写——护栏钩的「已决策」状态
 * 由本函数的退出码自身承载（等价 bash 版 _emit + _DECIDED 二态）。
 * @param {string} decision 'deny' | 'ask'
 * @param {string} systemMessage 用户可见文案
 */
export function emitPreToolUseDecision(decision, systemMessage) {
  process.stdout.write(`${preToolUseEnvelope(decision, systemMessage)}\n`);
  process.exit(decision === 'deny' ? 2 : 0);
}

/**
 * 按字段路径取字符串字段（bash 版 _json_get 的「缺失或非字符串→空串」语义收敛；
 * JSON 不可解析由调用方 JSON.parse 的 catch 承担——两护栏钩共用，单一事实源）。
 * @param {unknown} obj
 * @param {string[]} keys
 * @returns {string}
 */
export function pickString(obj, keys) {
  let v = obj;
  for (const k of keys) v = v && typeof v === 'object' ? v[k] : undefined;
  return typeof v === 'string' ? v : '';
}

/**
 * 插件根目录（内部任务-20 A1/F5；**内部未决-91 收敛为注入命令构造面的唯一根推导点**——
 * user-prompt 的 `declareCmdPrefix` 与 routing-gate 的 env-only 取根均已改经本函数；
 * session-start 的 SKILL.md 全文注入面保留自家 env-only 取根——服务对象与失败形态
 * 不同，不在 内部未决-91 登记范围）。
 * 优先级：本文件自身位置推导（realpath 归一）> ZCODE_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT。
 * 为什么自身位置优先：环境变量可能是上一个版本/别的安装根，而本文件所在目录=**正在执行**
 * 的插件版本目录（cache/<市场>/<插件>/<版本>/），与钩子行为同版；symlink 归一失败回落原形态
 * （内部任务-GUARDSYML-1 同款 fail-open：不抛）。
 * env 兜底**也验存在性**（CEO PD2-c）：指向上一版/他装根时命令"看着能跑"却读写别的状态根。
 * 两处都不成立 ⇒ 返回 null（不得回落 process.cwd()——那会产出"看似可执行却是错根"的命令，
 * 正是 F5 原缺陷的静默变体）；消费方（`incidentCliCommand`/`declareCmdPrefix`）据此改走
 * 占位符形态。
 * 为什么 marker 做参数（内部未决-91）：不同消费面钉不同的「根确实完整」证据——自察命令钉
 * `scripts/incident-cli.mjs`，声明命令钉 `hooks/routing-declare.mjs`；裁剪树里两者可能
 * 一存一缺，按消费面各自校验才不会"根可用而目标文件不在"。默认值=既有 marker，
 * 既有零参调用方行为不变。
 * @param {string} [marker] 相对根的存在性证据文件（正斜杠相对路径）
 * @returns {string|null} 绝对路径（不含尾分隔符）；不可判定时 null
 */
export function pluginRootDir(marker = 'scripts/incident-cli.mjs') {
  let self = null;
  try {
    const p = fileURLToPath(import.meta.url);
    let real = p;
    try {
      real = realpathSync(p);
    } catch {
      /* 归一失败：用原形态（不抛） */
    }
    self = dirname(dirname(real)); // <插件根>/hooks/hook-lib.mjs → <插件根>
  } catch {
    self = null;
  }
  // 两级候选都**验存在性**（plan-review 三维①1：校验不得只挂在"运行时不可达"的 env 分支上——
  // 自身位置分支才是主路径，若它指向半装/裁剪树同样会产出错根路径）：
  // 自身位置优先，其次 env；都不成立 ⇒ null（消费方退占位符）。
  for (const cand of [self, process.env.ZCODE_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]) {
    if (typeof cand === 'string' && cand !== '' && existsSync(join(cand, marker))) return cand;
  }
  return null;
}

/**
 * 命令格式器（私有，内部未决-91）：marker=目标文件自身——根可得 → 可复制执行形态；否则占位符
 * （两导出共用，防回落逻辑双写）。包裹形态＝**单引号**（内部未决-94，内部任务-50）：bash 与 pwsh 的
 * 双引号内 `$` 都会展开（路径含 `$`/反引号即被改写），单引号在两壳内都字面——转义路线因两壳
 * 转义字符冲突（bash `\` vs pwsh 反引号）不可行，单引号是唯一跨壳正确形态；解析面
 * `isBootstrapDeclareCommand` 双引号/单引号**双接受**（旧双引号命令继续放行）。cd 目标例外：
 * 维持双引号+引号内禁字符（内部规则-9 安全边界，无 resolve 核验故须禁——不在本格式器管辖）。
 * 对称代价（门①正确性 C3 登记）：路径含撇号（如用户目录 O'Brien）时单引号形态不可表示
 * （双壳内未闭合引号）且闸侧解析拒——与旧双引号形态的 `$`/反引号暴露互为镜像的残留类，
 * 取舍依据＝`$`/反引号在 shell 中触发**变量注入/命令替换**（安全向），撇号仅致不可执行（可检向）。
 * @param {string} relPath 相对插件根的目标文件路径（正斜杠）
 * @returns {string} 形如 node 'D:/…/workflow/<relPath>' 或 node '<插件根>/<relPath>'
 */
function quotedNodeCommand(relPath) {
  const root = pluginRootDir(relPath);
  return root
    ? `node '${join(root, relPath).replaceAll('\\', '/')}'`
    : `node '<插件根>/${relPath}'`;
}

/**
 * 自察 CLI 的可复制命令（内部任务-20 A1/F5）：插件根绝对路径 + 正斜杠 + 单引号包裹
 * （内部未决-94，内部任务-50——bash/pwsh 双壳零展开；Git Bash 可直接复制执行，与声明命令文案闭环）。
 * 根不可判定时**退占位符**，不产错根路径。
 * @returns {string} 形如 node 'D:/…/workflow/scripts/incident-cli.mjs'
 */
export function incidentCliCommand() {
  return quotedNodeCommand('scripts/incident-cli.mjs');
}

/**
 * 声明命令前缀（**内部未决-91 自 user-prompt.mjs 迁入为单点**，内部未决-94 起单引号形态）：租约行/提醒
 * （user-prompt）与 deny 文案/bootstrap 判定（routing-gate 经 pluginRootDir）共用同一
 * 根推导——自身位置 realpath 优先、两级 env 兜底均验存在性、皆不成立退占位符
 * （内部决策-022「declareCmdPrefix 单一构造」表述保持，构造点现承载于 hook-lib）。
 * @returns {string} 形如 node 'D:/…/workflow/hooks/routing-declare.mjs'
 */
export function declareCmdPrefix() {
  return quotedNodeCommand('hooks/routing-declare.mjs');
}

/**
 * 委派会话判据（**单一事实源**，CEO「六个月后的自己」）：负载 `delegation_depth` 为非负安全
 * 整数且 `>0` 即委派；缺键 / 0 / 负数 / 非整数 / 字符串一律**顶层会话语义**（不得强转、不得编造）。
 * 三个注入钩（`user-prompt` / `task-recap` / `learnings-recap`）共用，防语义三写漂移。
 * @param {unknown} parsed 钩子负载（已 JSON.parse）
 * @returns {boolean}
 */
export function isDelegatedSession(parsed) {
  const d = parsed?.delegation_depth;
  return Number.isSafeInteger(d) && d > 0;
}

/**
 * OPEN 预筛候选行构造（内部任务-57/内部规则-22，内部接口-8 v3 §7.1 机械承载）。纯函数：
 * 按当前消息任务域 token（拉丁 ≥3 字符词＋上一声明 skill 名）匹配登记册未关项描述，
 * 命中 ≤3 条时返回一行【OPEN 候选】；哨位项只列编号＋触发条件指引不催办（P4'）；
 * 无命中/册缺席（scanResult 为 null/空）返回 ''（零输出不骚扰）。
 * @param {string} message 当前用户消息原文
 * @param {string|null} skill 上一声明 skill 名（可为 null）
 * @param {{unclosed: Array<{id: string, desc: string, sentry: boolean}>}|null} scanResult
 *        scanOpenItems 返回值（null＝册缺席/解析失败）
 * @returns {string} 注入行（含前导换行）；或 ''
 */
export function openCandidateLine(message, skill, scanResult) {
  if (!scanResult || !Array.isArray(scanResult.unclosed) || scanResult.unclosed.length === 0) return '';
  // 停用词（U2 调参，检查点①发现 2 处置）：套件/资产自名在几乎所有条目描述里都被方法
  // 论引用（区分度为零，宽召回只添噪）——learnings 检索场景由 内部规则-7 独立承载，不在本面。
  const STOPWORDS = new Set(['WORKFLOW', 'SPECS', 'SPEC', 'GATE', 'SKILL', 'SKILLS', 'HOOK', 'HOOKS', 'DOCS', 'PLANS', 'OPEN', 'ADR', 'LEARNINGS', 'SCOUT', 'ALGO', 'RESEARCH', 'META']);
  const tokens = new Set();
  const collect = (text) => {
    for (const m of String(text ?? '').matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) {
      const t = m[0].toUpperCase();
      if (!STOPWORDS.has(t)) tokens.add(t);
    }
  };
  collect(message);
  if (skill) collect(skill);
  if (tokens.size === 0) return '';
  const hits = [];
  for (const item of scanResult.unclosed) {
    const desc = String(item.desc ?? '').toUpperCase();
    if (![...tokens].some((t) => desc.includes(t))) continue;
    hits.push(item.sentry ? `${item.id}（哨位项，触发条件见登记册）` : `${item.id}：${sanitizeDisplayText(item.desc, 40)}`);
    if (hits.length >= 3) break;
  }
  if (hits.length === 0) return '';
  return `\n【OPEN 候选】任务域相关未决项：${hits.join('；')}——显式处置（软约束），义务全文见 IF-COLLAB-8 §7.1`;
}
