// 文件：routing-lib.mjs
// 描述：路由声明协议的共享键/标记库（内部规则-8）——routing-gate.mjs（闸）与
//       routing-declare.mjs（声明命令）必须对"项目键怎么算、标记怎么存怎么判有效"
//       得出完全一致的结论，否则闸永远拒（键不匹配死锁）。因此键计算与标记读写
//       只此一份，两个脚本都从这里 import（单一事实源）。
//       键控为什么是项目根（.git 祖先）+TTL 而不是会话 id：实测 Bash 工具环境
//       无会话标识变量（hook 侧有），声明命令经 Bash 发起时拿不到与会话闸相同
//       的会话键；项目根两侧都能从 cwd 独立推导（闸用负载 cwd，声明用进程 cwd）。
//       2026-09-13（内部决策-018）：标记键控升级为 per-session capability 任务租约（task-lease-lib.mjs），
//       本文件保留项目键计算与计划评审凭据 v2/v3（内部规则-10 / 内部规则-16）的单一实现。
//       2026-09-13（嵌套仓修复）：闸对 Edit/Write 改按 tool_input.file_path 推导项目键
//       （工具级键控选择在 routing-gate.deriveGateKey）；本文件仍是项目键计算的单一实现。
//       2026-09-15（激活域批次，内部决策-022）：新增 activationRoot——闸/租约
//       签发/提醒的生效域判定（git 仓判据），三消费点共用同一份（routing-gate/user-prompt/post-tool）。
//       2026-09-16（租约族缺陷批次，W3）：新增 workspaceRootAnchor——签发键锚定宿主
//       工作区根（ZCODE_PROJECT_DIR 环境快照），签发键不再随 shell 持久 cwd 漂移。
//       2026-09-25（Mac 首装批次，内部任务-MACKEY-1）：新增 canonicalRoot/canonicalPath——
//       键与写面目标统一 realpath 归一（macOS symlink 形态分裂：os.tmpdir() 原始形态
//       vs process.cwd() 物理形态，不归一则租约激活永久失败）；gitAncestor/markerAncestor
//       命中层与 projectKey 回退分支单点归一。
//       2026-10-21（内部任务-193 A6/A12/A7）：verifyReviewedPlan 单次 readdir 派生 siblings/candidates
//       （A6）；前轮档精确 stem + frontmatter 只校 planPath（A12）；头注/JSDoc 的 v2 表述同步 v2/v3（A7）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 注入缝：WF_ROUTING_STATE_DIR（标记目录，测试隔离）、WF_ROUTING_TTL_MS（TTL 毫秒）。
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

// 内部决策-045/内部任务-96（内部规则-19 ⑤ 修订，用户裁决 T-A+B 2026-10-15）：默认 TTL 取区间上界
// **60min**——过期判定锚改「最后活动观测起算」（PostToolUse 心跳观测点＋宽限复活，
// task-lease-lib reviveOrHeartbeat），死会话阻塞窗口 ≤60min（无观测即最后活动后释放，
// 较声明锚更精确）；WF_ROUTING_TTL_MS 覆盖语义不变（测试与诊断注入缝）。
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** skill 名合法形态（与 check-routing.mjs 的 SKILL_NAME_RE 同款语义） */
export const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** 计划工件候选目录（相对项目根）：主约定 + 本仓库历史布局兼容（plan-writing L54 / 内部决策-2） */
export const PLAN_DIRS = ['docs/plans', 'docs/superpowers/plans'];
/** skill→基线许可写面映射表（内部规则-20，内部任务-75/IMP-3）：映射表内 skill 声明激活期间，闸侧
 * 对 Edit/Write 增设基线写面判定（routing-gate floorViolation）——目标须 ∈ 基线面 ∪ 租约
 * changeScope（并集可扩语义，与规划固定上界 内部规则-16 的交集语义相反：基线面是免声明下界、
 * 显式声明即扩面，语义=「改什么」须显式，不是禁止修改）。基线面＝PLAN_DIRS 引用（不复制，
 * 防双源漂移）；插件配置层常量，新增 skill 条目即扩展；声明侧提示档在 routing-declare
 * （stderr 一行，不改退出码），闸侧 deny 为主档（内部决策-11）。 */
export const SKILL_WRITE_FLOOR = Object.freeze({
  'root-cause-debugging': PLAN_DIRS,
});
/** 评审记录结论行契约（内部规则-8）：「结论：通过」独占一行——机器门禁按此识别 */
export const REVIEW_PASS_RE = /^结论[：:]\s*通过\s*$/m;

/**
 * TTL 解析：环境变量覆盖，非法或缺省回落默认值。
 * @returns {number} 毫秒
 */
export function ttlMs() {
  const raw = Number(process.env.WF_ROUTING_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * 用户级默认状态根：`~/.zcode/cli/routing-state`（跨重启存活——/tmp 会被清理，租约状态即丢，
 * 醒来必现「状态缺失或损坏」假象）> tmpdir() 兜底（home 不可写时保 fail-open）。
 * **不含**注入缝与项目记号判定——那两层在 `stateRootFor`（单点原语）。
 * @returns {string}
 */
function defaultStateDir() {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (home) {
      const dir = join(home, '.zcode', 'cli', 'routing-state');
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch {
    /* home 不可写：落 tmpdir 兜底（fail-open） */
  }
  return tmpdir();
}

/** 项目记号文件（相对项目根；内部决策-040 修正案 1）。 */
const ROUTING_CONFIG_REL = join('.workflow', 'routing.json');
/** 项目内状态根（相对项目根；内部决策-040 修正案 1）。 */
const LOCAL_STATE_REL = join('.workflow', 'routing-state');

/**
 * 读取项目级状态根记号（内部决策-040 修正案 1，内部任务-20 A2/F7）。合法取值仅 `{"stateRoot":"local"}`；
 * 缺文件 / 坏 JSON / 未知取值分别给 `reason`（消费方据此出可见告警，**不静默换根**）。
 * @param {string} root 项目根（canonical 形态；调用方经 activationRoot/canonicalRoot 归一）
 * @returns {{ok: boolean, stateRoot?: string, reason?: string}}
 */
export function readProjectRoutingConfig(root) {
  const file = join(String(root), ROUTING_CONFIG_REL);
  if (!existsSync(file)) return { ok: false, reason: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  const v = parsed?.stateRoot;
  if (v === 'local') return { ok: true, stateRoot: 'local' };
  return { ok: false, reason: typeof v === 'string' ? `unknown:${v}` : 'malformed' };
}

/**
 * 状态根解析**单点**（内部决策-040 修正案 1，内部任务-20 A2/F7）：优先级＝`WF_ROUTING_STATE_DIR`
 * 注入缝 > 项目记号（`local` ⇒ `<根>/内部工作流状态`）> 用户级默认根。签发钩 /
 * 闸 / 声明 CLI 三侧共用，**禁止**各处自行拼路径（范围表见 内部模块-8 §E）。
 * 键先归一到激活域根（`gitAncestor ?? markerAncestor`，回退 `canonicalRoot`）——同仓两键同根、
 * 异仓各归各根（逐键解析）；非法记号回落默认根。
 * @param {string} key 项目键（或该键内的任一路径；本函数自行归一）
 * @returns {string} 状态根绝对路径
 */
export function stateRootFor(key) {
  const seam = process.env.WF_ROUTING_STATE_DIR;
  if (seam) return seam;
  // **单点归一（收尾评审阻塞 2）**：调用方传键的形态不一（`routing-declare` 传 canonical 键、
  // `user-prompt` 的锚键是 `normalize` 形态——不解析 symlink）⇒ 不归一会让 symlink 仓出现
  // 「一处判 local、一处判非 local」的双根，正是 F7 要封的失效面。
  const root = canonicalRoot(String(activationRoot(String(key)) ?? key));
  const cfg = readProjectRoutingConfig(root);
  if (cfg.ok && cfg.stateRoot === 'local') return join(root, LOCAL_STATE_REL);
  return defaultStateDir();
}

/**
 * 记号非法时的**可见告警**（内部决策-040 修正案 1：不静默换根）。
 * @param {string} root 项目根
 * @param {{ok: boolean, reason?: string}} detail `readProjectRoutingConfig` 的结果
 * @returns {string} 单行告警：点明"已回落默认根"+ 两条处置指引
 */
export function stateRootDiagnostic(root, detail) {
  const reason = detail?.reason;
  const why =
    reason === 'unparsable' ? 'JSON 无法解析' : reason === 'malformed' ? '缺少 stateRoot 字段' : `未知取值 ${String(reason ?? '').replace(/^unknown:/, '')}`;
  return `【workflow 状态根】项目记号 ${join(String(root), ROUTING_CONFIG_REL)} 非法（${why}）——已回落用户级默认根（不静默换根）；处置：改为 {"stateRoot":"local"} 或删除该文件，或设 WF_ROUTING_STATE_DIR 显式指定。`;
}

/**
 * 初始化项目级状态根（`routing-declare --init-state-dir`，内部决策-040 修正案 1）：写记号 +
 * 建 `<根>/内部工作流状态` + 自忽略 `.gitignore`（兜 git 视角的 revision 排除）。
 * 幂等：记号已合法时不覆盖（`already: true`）；失败返回 `{ok:false, error}` 由调用方出文案。
 * @param {string} root 项目根
 * @returns {{ok: boolean, root?: string, already?: boolean, error?: string}}
 */
export function initProjectStateRoot(root) {
  const base = canonicalRoot(String(root));
  const dir = join(base, LOCAL_STATE_REL);
  try {
    const cfg = readProjectRoutingConfig(base);
    if (cfg.ok && cfg.stateRoot === 'local') return { ok: true, root: dir, already: true };
    mkdirSync(dir, { recursive: true });
    // **写序**：`.gitignore` 先写、**记号最后写**（记号是提交点）——反序时若 `.gitignore` 失败，
    // 项目已被锁进 local 而重跑走 `already` 分支不再补建（收尾评审非阻塞 4）。
    writeFileSync(join(dir, '.gitignore'), '*\n');
    writeFileSync(join(base, ROUTING_CONFIG_REL), `${JSON.stringify({ stateRoot: 'local' })}\n`);
    return { ok: true, root: dir };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * 运行态状态目录（对外语义不变）：`stateRootFor(process.cwd())` 的薄包装——注入缝 >
 * 项目记号 > 用户级默认；单一事实源：hook-lib.sessionStateFile 与本文件共用。
 * @returns {string}
 */
export function runtimeStateDir() {
  return stateRootFor(process.cwd());
}

/** 标记目录（注入缝或运行态状态目录）。 */
export function stateDir() {
  return runtimeStateDir();
}

/**
 * 键 canonical 归一（内部任务-MACKEY-1，2026-09-25）：resolve 后解析 symlink 得物理路径。
 * 为什么必须归一：macOS 上签发侧与声明侧的路径形态天然分裂——`os.tmpdir()` 返回
 * `/var/folders/...`（symlink 形态）而子进程 `process.cwd()` 返回物理形态
 * `/private/var/folders/...`；项目位于 symlink 目录下（如 ~/Projects→外部卷）同型。
 * 两形态不归一到同键，租约激活必判「挑战与本项目不匹配」（Linux/Windows tmpdir 无
 * symlink、两形态恒等，故从未暴露）。回退语义：路径不存在/不可解析时回退 normalize
 * 形态不抛（fail-open 姿态，归一失败不阻断闸）。
 * @param {string} p 路径（相对按 cwd 解析）
 * @returns {string} canonical 绝对路径
 */
export function canonicalRoot(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return normalize(abs);
  }
}

/**
 * 文件路径 canonical 归一（内部任务-MACKEY-1，2026-09-25）：与 canonicalRoot 同形态空间，
 * 但容忍目标不存在（Edit/Write 新建文件常态）——整路径 realpath 失败时对最近存在
 * 祖先解析后拼回余段。为什么需要：写面判定 `relative(键, 目标)` 两侧必须同形态
 * （键经 gitAncestor 已 canonical），目标残留 symlink 前缀形态会前缀失配误判越界。
 * 全链不存在（荒谬输入）回退 normalize 形态。
 * @param {string} p 文件路径
 * @returns {string} canonical 绝对路径
 */
export function canonicalPath(p) {
  const abs = resolve(p);
  // 内部任务-244 最终安全评审 B2：**逐段 canonical**——先按目录段 realpath 再处理 `..`，与 OS 语义
  // 一致（symlink `a -> docs/sub` 后 `a/..` 应回到 `docs`，而非词法消解回仓根）。原实现
  // 「先 path.resolve 词法消 `..` 再 realpath」在 symlink+`..` 组合下产生与内核不同的写面/键。
  const { root } = parse(abs);
  let cur = root || normalize('/');
  const rest = abs.slice(root.length).split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  for (const seg of rest) {
    if (seg === '..') { cur = dirname(cur); continue; }
    const next = join(cur, seg);
    try {
      cur = realpathSync(next);
    } catch {
      cur = next; // 不存在段保留字面形态（Edit/Write 新建文件常态；其父已 canonical）
    }
  }
  return cur === '' ? normalize(abs) : cur;
}

/**
 * 通用祖先上溯原语（2026-09-17 评审处置抽取——gitAncestor/markerAncestor 两份循环
 * 的同构上升）：自 dir 向上逐级以 probe 探测，命中返回该层，至根未命中返回 null。
 * @param {string} dir 起始目录
 * @param {(d: string) => boolean} probe 目录探针
 * @returns {string|null} 最近命中祖先（绝对路径；canonical 形态——键归一在命中层
 *           单点执行，probe 探测本身用原路径即穿透 symlink，无正确性差异）
 */
function nearestAncestor(dir, probe) {
  let d = resolve(dir);
  for (;;) {
    if (probe(d)) return canonicalRoot(d);
    const parent = dirname(d);
    if (parent === d) return null; // 到根仍未命中
    d = parent;
  }
}

/**
 * 从 dir 逐级上溯找最近的存在 .git 的祖先目录；找不到返回 null。
 * @param {string} dir 起始目录
 * @returns {string|null} 最近 .git 祖先（绝对路径）
 */
export function gitAncestor(dir) {
  return nearestAncestor(dir, (d) => existsSync(join(d, '.git')));
}

/**
 * `.sdd/` 目录判定（isDirectory——普通文件形态的 .sdd 不误激活，2026-09-17 评审处置）。
 * @param {string} d 目录
 * @returns {boolean}
 */
function isSddDir(d) {
  try {
    return statSync(join(d, '.sdd')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 显式接入标记根判定（2026-09-19 评审修复 H3 抽出导出）：`.scout/mode.json`（scout
 * 模式声明，仅由显式 scout 模式开启操作创建——mode-lifecycle open，内部决策-031；历史
 * 实现名 scout-open）或 `.sdd/`（spec-gate 项目接入）presence 即
 * 显式 opt-in。供 markerAncestor 与 task-lease-lib 的标记域键发现（discoverMarkerKeys）
 * 共用同一判据——闸键与签发键的标记语义必须同源，否则键集包含关系失守。
 * 同语义复刻：scout/hooks/session-start.mjs `scoutNudgeApplies`（内部决策-044 absent
 * 轻提醒判定，内部任务-89）——修改本文件的 .git/.scout/mode.json/.sdd 判定面时须同步
 * 评估该复刻的同构性（漂移哨兵，反向注记）。
 * @param {string} d 目录
 * @returns {boolean}
 */
export function isMarkerRoot(d) {
  return existsSync(join(d, '.scout', 'mode.json')) || isSddDir(d);
}

/**
 * 显式接入标记祖先（2026-09-17 使用反馈二批，内部决策-026）：自 dir 向上找含
 * `.scout/mode.json`（scout 模式声明，仅由显式 scout 模式开启操作创建——
 * mode-lifecycle open，内部决策-031）或 `.sdd/`
 * （spec-gate 项目接入）的目录——presence 即显式 opt-in，无自证循环。
 * @param {string} dir 起始目录
 * @returns {string|null} 最近标记目录；无则 null
 */
function markerAncestor(dir) {
  return nearestAncestor(dir, isMarkerRoot);
}

/**
 * 项目键：从 cwd 逐级上溯找最近的存在 .git 的祖先；找不到则锚显式接入标记根
 * （内部决策-026 键统一：标记域内与 activationRoot 同根——闸键/签发键/声明键/.workflow
 * 落盘根不分裂，否则子目录 cwd 在标记域内会持久 deny）；无标记才以 cwd 自身为键。
 * 为什么认 .git：项目根的最稳公共标志（子目录写操作须与根声明命中同一把钥匙）。
 * 键形态恒为 canonical（realpath，内部任务-MACKEY-1）：签发（负载 cwd 原始形态）与声明
 * （process.cwd() 物理形态）在 macOS symlink 下形态分裂，归一在 gitAncestor/
 * markerAncestor 命中层与回退分支单点执行。
 * @param {string} cwd 起始目录
 * @returns {string} 项目键（绝对路径，canonical 形态）
 */
export function projectKey(cwd) {
  return gitAncestor(cwd) ?? markerAncestor(cwd) ?? canonicalRoot(cwd);
}

/**
 * 激活域根（2026-09-15 激活域批次 内部决策-022；2026-09-17 内部决策-026 放宽）：租约闸/
 * 租约签发/路由提醒的生效条件——git 仓根优先，其次显式接入标记祖先；null=整套
 * 静默（哨兵告警除外）。放宽理由：内部决策-022 原拒绝标记文件，防的是 incident-store
 * 式「按需自创建」标记自证循环；mode.json 仅显式 scout 模式开启操作创建
 * （mode-lifecycle open，内部决策-031）、.sdd/ 仅项目接入创建，presence=显式 opt-in，不触发该循环——「模式生效 ⇒ 纪律在场」。
 * 键统一（同批评审处置）：标记域内 projectKey 亦锚标记根（见 projectKey 注释），
 * activationRoot 与其在此域恒等同；无标记非 git 目录 projectKey 仍回退 cwd 自身。
 * 消费点（routing-gate/user-prompt/post-tool）直接以返回值真值判定，无布尔包装。
 * @param {string} dir 起始目录
 * @returns {string|null} 激活域根；未激活 null
 */
export function activationRoot(dir) {
  return gitAncestor(dir) ?? markerAncestor(dir);
}

/**
 * 工作区根锚定（2026-09-16 W3 丙案主路径）：宿主经进程环境注入工作区根，是 hook
 * spawn 时刻的环境快照，不随持久 shell cwd 的 cd 漂移变化（scout/spec-gate/
 * team-governance 的 session-start/post-tool 钩已在消费同一变量，workflow 此前漏接）。
 * 仅取绝对路径形态；非绝对/未注入返回 null，调用方回退 cwd 路径或多仓发现。
 * 是否可直接作签发键由调用方判（非仓工作区根须转多仓签发——闸键永远来自 git 祖先）。
 * @returns {string|null} 工作区根绝对路径
 */
export function workspaceRootAnchor() {
  const env = process.env.ZCODE_PROJECT_DIR;
  if (typeof env === 'string' && env && isAbsolute(env)) return normalize(env);
  return null;
}

/**
 * 计划文本内容的哈希（与 assurance/revision 的 planSha256 同语义）：
 * CRLF 规范化为 LF 后取 sha256，输出 sha256:<64hex>。
 * @param {string} text 计划全文
 * @returns {string}
 */
function planSha256OfText(text) {
  const normalized = Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

/** 计划文件内容哈希（LF 归一；与 planSha256OfText 同源）。 */
export function planSha256(planFile) {
  return planSha256OfText(readFileSync(planFile, 'utf8'));
}

/** 计划嗅探常量（CODE_EXTS / 文件令牌形态为单源）。 */
const CODE_EXTS = [
  'mjs', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'json', 'yml', 'yaml',
  'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sql',
  'html', 'css', 'scss', 'vue', 'svelte',
];
const CODE_FENCE_LANGS = new Set([
  ...CODE_EXTS, 'javascript', 'typescript', 'python', 'node', 'rust', 'golang',
  'csharp', 'ruby',
]);
const CODE_PATH_RE = new RegExp(`[A-Za-z0-9_.@+\\-/]+\\.(?:${CODE_EXTS.join('|')})`, 'i');
const FILE_TOKEN_RE = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*\.[A-Za-z0-9]{1,8}$/;
const ROOT_FILE_RE = /^(?:\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]{2,}\.[A-Za-z0-9]{2,8}|LICENSE|NOTICE|Makefile|Dockerfile)$/;
const BARE_PATH_RE = /[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+\.[A-Za-z0-9]{1,8}/g;
const ACTION_CELL_WORDS = new Set(['新建', '新增', '创建', '添加', 'new', 'add', '改', '修改', '删除', 'delete']);
const NEW_ACTION_WORDS = new Set(['新建', '新增', '创建', '添加', 'new', 'add']);
const NEW_ACTION_PREFIX_RE = new RegExp(
  `^\\s*(?:[-*+]|\\d+[.)])\\s*(?:${[...NEW_ACTION_WORDS].join('|')})`, 'i',
);

/** 表格行/列表项里取文件级路径令牌（根级文件与任意扩展名；排除版本号/短缩写）。 */
function collectFileTokens(line) {
  const out = new Set();
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const p = m[1].trim();
    if (FILE_TOKEN_RE.test(p) && (p.includes('/') || ROOT_FILE_RE.test(p))) out.add(p);
  }
  for (const m of line.matchAll(BARE_PATH_RE)) out.add(m[0].trim());
  if (line.includes('|')) {
    for (const cell of line.split('|')) {
      const c = cell.trim().replace(/^`|`$/g, '');
      if (ROOT_FILE_RE.test(c)) out.add(c);
    }
  }
  return out;
}

/** 表格动作单元格（首个精确动作词单元格）或列表项前缀动作词。 */
function collectAction(line, kind) {
  if (kind === 'item') return NEW_ACTION_PREFIX_RE.test(line);
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  const actionCell = cells.find((c) => ACTION_CELL_WORDS.has(c.toLowerCase()));
  return actionCell !== undefined && NEW_ACTION_WORDS.has(actionCell.toLowerCase());
}

/**
 * 计划改动面嗅探（内部规则-16 / 内部任务-156）：步骤数按带编号/标题的步骤标题计（裸「## 步骤」
 * 伞标题不计；wave 标题与数字标题仅在无步骤标题时回退计数）；文件数只读「文件清单」
 * 节内的文件令牌（根级文件与任意扩展名均计；版本号/短缩写由形态排除）；新模块数按
 * 表格动作单元格/列表项前缀与路径排除面计。`isImplementation` 为 false 的纯文档计划
 * 不触发超阈值。
 * @param {string} text 计划全文
 * @returns {{steps:number, files:number, newModules:number, hasFileList:boolean,
 *            isImplementation:boolean, overThreshold:boolean}}
 */
export function planChangeSurface(text) {
  const textValue = String(text ?? '');
  const lines = textValue.split(/\r?\n/);
  let inFence = false;
  let hasCodeFence = false;
  let hasCodePath = false;
  let stepLike = 0;
  let waveLike = 0;
  let numericLike = 0;
  let inFileList = false;
  let fileListLevel = 0;
  let hasNonMdFile = false;
  let hasContractFile = false;
  const files = new Set();
  const newModules = new Set();
  for (const line of lines) {
    const fence = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        if (CODE_FENCE_LANGS.has(fence[2].toLowerCase())) hasCodeFence = true;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const isAcceptance = /^\s*(?:[-*+]\s*)?验收\s*[:：]/.test(line);
    if (!isAcceptance && CODE_PATH_RE.test(line)) hasCodePath = true;
    const h = /^(#{1,6})\s*(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2];
      const isStepTitle = /^(?:步骤|step|任务|task)\s*(?:\d+|[一二三四五六七八九十]+|[:：]|[A-Za-z0-9])/i.test(title);
      const isWave = /^(?:W\d+|Wave\s*\d+|阶段\s*\d+)/i.test(title);
      const isNumeric = /^\d+[.、]/.test(title);
      if (isStepTitle) stepLike += 1;
      else if (isWave) waveLike += 1;
      else if (isNumeric) numericLike += 1;
      // 文件清单节在下一个同级/更高级标题或任何步骤/任务标题处结束——任务正文里的
      // 表格/列表不得继续计入清单（终评正确性发现 1）。
      if (inFileList && (level <= fileListLevel || isStepTitle)) inFileList = false;
      if (/文件(?:级)?清单/.test(title)) {
        inFileList = true;
        fileListLevel = level;
      }
      continue;
    }
    if (!inFileList) continue;
    const isRow = line.includes('|') && !/^\s*[-*+]\s/.test(line);
    const isItem = /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
    if (!isRow && !isItem) continue;
    if (isRow && /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    const action = collectAction(line, isItem ? 'item' : 'row');
    for (const p of collectFileTokens(line)) {
      files.add(p);
      if (!p.endsWith('.md')) hasNonMdFile = true;
      if (p.startsWith('workflow/skills/')) hasContractFile = true;
      if (action && !p.endsWith('.md') && !p.includes('.test.')
        && !/(^|\/)(tests?|docs?|evidence)\//.test(p)) {
        newModules.add(p);
      }
    }
  }
  const steps = stepLike || waveLike || numericLike;
  const hasFileList = files.size > 0;
  const implementation = (hasFileList && (hasNonMdFile || hasContractFile))
    || (!hasFileList && (hasCodeFence || hasCodePath || /\bskill\b|\bhook\b/i.test(textValue)));
  return {
    steps,
    files: files.size,
    newModules: newModules.size,
    hasFileList,
    isImplementation: implementation,
    overThreshold: implementation
      && (!hasFileList || steps > 8 || files.size > 8 || newModules.size > 2),
  };
}

/** sidecar frontmatter 字段行解析（YAML-lite：仅识别单值键；v2/v3 共用）。 */
function parseSidecarFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)\s*$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^"|"$/g, '');
  }
  return fields;
}

/** 内部任务-191：sidecar 合法版本（v2 仅 self/ratified；v3 独立/mixed 强制）。 */
const SIDECAR_SCHEMA_VERSIONS = ['2', '3'];
/** 内部任务-191：provenance 状态词表。 */
const PROVENANCE_STATES = new Set(['fresh', 'reused', 'rehydrated']);

/** 计划评审的实例链身份（内部任务-191）：`plan:<项目根相对 POSIX planPath>`。 */
export function planChainIdentity(planRel) {
  return `plan:${String(planRel).replace(/\\/g, '/')}`;
}

/** 解析 reviewRound（v3）；返回 {ok,round} 或 {ok:false,reason}。 */
function parseReviewRound(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) {
    return { ok: false, reason: '评审 sidecar 缺 reviewRound 或非法（v3 须 1..999 整数）' };
  }
  const round = Number(raw);
  if (!Number.isSafeInteger(round) || round < 1 || round > 999) {
    return { ok: false, reason: '评审 sidecar reviewRound 须为 1..999 整数' };
  }
  return { ok: true, round };
}

/** 解析 reviewProvenance（v3 单行 JSON 数组）；返回 {ok,value} 或 {ok:false,reason}。 */
function parseReviewProvenance(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '评审 sidecar 缺 reviewProvenance（v3 须 JSON 数组：每实例声明 role/instance/chain/state）' };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'reviewProvenance 非法 JSON（须单行 JSON 数组；反斜杠须转义）' };
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'reviewProvenance 须为 JSON 数组' };
  return { ok: true, value };
}

/**
 * 内部任务-191：v3 实例来源校验——链身份等值、role/instance 同凭据唯一、词表、
 * round=1 全 fresh、countable 槽位=fresh|reused 数、rehydrated 补位不计入。
 * @param {Array<object>} entries reviewProvenance 数组
 * @param {{mode:string, instances:number, round:number, chain:string}} o
 * @returns {{ok:boolean, reason?:string, countable?:number}}
 */
function validatePlanProvenance(entries, { mode, instances, round, chain }) {
  if (mode === 'self' || mode === 'ratified') {
    if (entries.length !== 0) {
      return { ok: false, reason: `reviewMode=${mode} 须 reviewProvenance 为空数组（实际 ${entries.length} 条）` };
    }
    return { ok: true, countable: 0 };
  }
  const seenRole = new Set();
  const seenInstance = new Set();
  let countable = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, reason: `reviewProvenance[${i}] 须为对象` };
    }
    const role = typeof e.role === 'string' ? e.role.trim() : '';
    const instance = typeof e.instance === 'string' ? e.instance.trim() : '';
    if (role === '') return { ok: false, reason: `reviewProvenance[${i}] 缺 role` };
    if (instance === '') return { ok: false, reason: `reviewProvenance[${i}] 缺 instance` };
    if (!PROVENANCE_STATES.has(e.state)) {
      return { ok: false, reason: `reviewProvenance[${i}] state 非法：${String(e.state)}（合法 fresh|reused|rehydrated）` };
    }
    if (typeof e.chain !== 'string' || e.chain !== chain) {
      return { ok: false, reason: `reviewProvenance[${i}] chain（${String(e.chain)}）与当前链身份（${chain}）不一致——跨任务/跨链实例不得计入本链` };
    }
    if (seenRole.has(role)) return { ok: false, reason: `reviewProvenance role 重复：${role}（同凭据内每视角/维度各一）` };
    if (seenInstance.has(instance)) {
      return { ok: false, reason: `reviewProvenance instance 重复：${instance}（同一实例不得填多个视角充独立性计数）` };
    }
    seenRole.add(role);
    seenInstance.add(instance);
    if (e.crossStage !== undefined) {
      // D3：crossStage 仅 code-review receipt 的跨阶段复用元数据；plan-review sidecar 不接受（防契约越界）
      return { ok: false, reason: `reviewProvenance[${i}] 不接受 crossStage（D3：跨阶段元数据仅 code-review receipt 使用）` };
    }
    if (e.state === 'fresh' || e.state === 'reused') countable += 1;
  }
  if (round === 1 && entries.some((e) => e.state !== 'fresh')) {
    return { ok: false, reason: 'reviewRound=1 时全部评审实例须 state=fresh（首轮 fresh 契约）' };
  }
  if (countable !== instances) {
    return {
      ok: false,
      reason: `reviewInstances=${instances} 须等于 countable 槽位数（fresh|reused），实际 ${countable}；rehydrated 补位不计入`,
    };
  }
  return { ok: true, countable };
}

/** 文件名轮次解析（内部任务-193 A12）：只认精确 `${stem}-review-roundN.md` 与 `${stem}-reviewN.md`。
 * canonical `${stem}-review.md` 与任何异名档（如 `${stem}-review-review-round1.md`、其他 stem
 * 前缀）一律返回 null——旧实现按 startsWith 前缀 + 宽松正则识别，异常命名可冒充前轮档或
 * 绕过「文件名轮次与 reviewRound 一致」校验。返回 null 表示「本文件名不声明轮次」。
 * @param {string} name 同目录文件名
 * @param {string} stem 计划 stem（计划文件名去 .md）
 * @returns {number|null} 文件名声明的轮次（1..999），不声明时为 null
 */
function fileRoundNumberOf(name, stem) {
  if (typeof name !== 'string' || typeof stem !== 'string' || stem === '') return null;
  // stem 参与正则，须转义（计划名可含 `.` 等元字符）
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = new RegExp(`^${escaped}-review-round(\\d{1,3})\\.md$`).exec(name)
    ?? new RegExp(`^${escaped}-review(\\d{1,3})\\.md$`).exec(name);
  return hit ? Number(hit[1]) : null;
}

/** 前轮归档存在性 + 内容抽检（v3 round>1 结构锚；内部任务-193 A12 / D6）。
 * 只认 fileRoundNumberOf 命中的精确轮次档（1..round-1 任一在案即满足结构锚）；对命中档
 * 逐个读 frontmatter，**只校 planPath 相等**——taskId 仅记录不校验（同一计划换任务号续审
 * 合法，误拒会把合法历史档变成永久卡死面），也不比 planSha256（前轮档对应旧计划版本，
 * 哈希必然不同）。不可读/无 frontmatter/planPath 不符一律 fail-closed。
 * @param {string[]|undefined} siblings 同目录 .md 文件名
 * @param {string} stem 计划 stem
 * @param {number} round 当前轮次（须存在 1..round-1 的任一前轮档）
 * @param {{dir?:string, taskId?:string, norm?:string}} [opts] dir=同目录（文件读取根）；
 *        taskId 仅记录不参与判定；norm=期望 planPath（归一形态）
 * @returns {boolean} 是否存在内容可抽检且 planPath 一致的前轮档
 */
function hasPriorRoundFile(siblings, stem, round, { dir, taskId, norm } = {}) {
  if (typeof dir !== 'string' || typeof norm !== 'string' || !Array.isArray(siblings)) return false;
  void taskId; // D6：taskId 仅记录不校验——换号续审合法，接口保参以免调用方误以为要校验
  let found = false;
  for (const name of siblings) {
    const n = fileRoundNumberOf(name, stem);
    if (n === null || n < 1 || n >= round) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      return false; // 不可读 → fail-closed（结构锚不得因读失败而放行）
    }
    const fields = parseSidecarFrontmatter(text);
    if (!fields || typeof fields.planPath !== 'string' || fields.planPath !== norm) {
      return false; // 无 frontmatter / planPath 缺省或不符 → fail-closed（防异名档/他计划档冒充）
    }
    found = true;
  }
  return found;
}

/**
 * 单份 sidecar 文本的凭据内容校验（内部规则-10 / 内部规则-16 / 内部决策-007 / 内部任务-191）——canonical
 * 与序列扫描共用同一判定：v2 七字段 / v3 九字段自洽 + 结论「通过」独占行 +
 * taskId/planPath 一致 + planSha256 相等；独立/mixed 强制 v3（reviewRound + reviewProvenance），
 * v2 仅 self/ratified 历史可读；v3 校验链身份/轮次/前轮档/条目唯一/countable 计数。
 * @param {string} text sidecar 全文
 * @param {string} taskId 声明的任务标识
 * @param {string} norm 计划相对路径（归一形态）
 * @param {string} current 当前计划哈希
 * @param {{steps:number, files:number, newModules:number, hasFileList:boolean,
 *          isImplementation:boolean, overThreshold:boolean}} surface 计划改动面
 * @param {{fileName?:string, siblings?:string[], stem?:string, dir?:string}} [ctx] 文件名/同目录档/
 *        stem/目录（v3 轮次与文件名轮次锚、前轮档内容抽检）
 * @returns {{ok: boolean, reason?: string}}
 */
function checkSidecarContent(text, taskId, norm, current, surface, ctx = {}) {
  const fields = parseSidecarFrontmatter(text);
  if (!fields || !SIDECAR_SCHEMA_VERSIONS.includes(fields.schemaVersion) || !fields.planSha256) {
    return { ok: false, reason: 'legacy 评审记录（无 v2/v3 哈希绑定）：请重新评审生成 v2/v3 sidecar（迁移：重跑 plan-review 或原位补 frontmatter）' };
  }
  if (!REVIEW_PASS_RE.test(text)) {
    // 真·不通过优先于形态诊断（三维评审正确性维处置）：顶格「结论：不通过」存在时
    // 实质拒因必须呈现，不得因正文引述了列表形结论行而误导修法方向。
    if (/^结论[：:]\s*不通过\s*$/m.test(text)) {
      return { ok: false, reason: '评审结论非「通过」' };
    }
    // 列表形结论行诊断（2026-09-16 用法修正批次）：plan-review 模板曾把结论渲染为
    // 列表项，照抄产生「- 结论：通过」不命中行首锚定——拒因必须指认形态错误与
    // 修法，否则用户面对笼统的「评审结论非通过」无法自纠（内部规则-8 契约的可用性兜底）。
    if (/^\s*[-*]\s*结论[：:]\s*(通过|不通过)/m.test(text)) {
      return { ok: false, reason: '评审结论行带了列表前缀（如「- 结论：通过」）——机器门禁按行首「结论」锚定（R-M3-8）：请删去列表符、顶格独占一行后重试' };
    }
    return { ok: false, reason: '评审结论非「通过」' };
  }
  if (fields.taskId !== taskId) return { ok: false, reason: `sidecar taskId（${fields.taskId}）与声明 taskId（${taskId}）不一致` };
  if (fields.planPath !== norm) {
    return { ok: false, reason: `sidecar planPath（${fields.planPath}）与实际计划（${norm}）不一致` };
  }
  if (fields.planSha256 !== current) {
    return { ok: false, reason: `计划哈希失配（评审后计划已修改：sidecar=${fields.planSha256.slice(0, 16)}… 当前=${current.slice(0, 16)}…），须重审` };
  }
  const mode = fields.reviewMode;
  if (typeof mode !== 'string' || mode === '') {
    return {
      ok: false,
      reason: '评审 sidecar 缺 reviewMode/reviewInstances/reviewReason（R-M3-16）：新凭据三字段必填，请重审并补字段（旧 sidecar 仅历史可读，不构成新声明凭据）',
    };
  }
  if (!['independent', 'mixed', 'self', 'ratified'].includes(mode)) {
    return { ok: false, reason: `评审 sidecar reviewMode 非法：${mode}（合法值 independent|mixed|self|ratified）` };
  }
  if (fields.schemaVersion === '2' && (mode === 'independent' || mode === 'mixed')) {
    return { ok: false, reason: `v2 sidecar 的 ${mode} 不构成新凭据：独立/mixed 须 schemaVersion: 3 + reviewRound + reviewProvenance（迁移：重审或原位补 v3 字段）` };
  }
  const instRaw = fields.reviewInstances;
  if (typeof instRaw !== 'string' || !/^\d+$/.test(instRaw)) {
    return { ok: false, reason: '评审 sidecar 缺 reviewInstances 或非法（须为非负整数；reviewMode 有值时不得缺省）' };
  }
  const instances = Number(instRaw);
  if (!Number.isSafeInteger(instances)) {
    return { ok: false, reason: '评审 sidecar reviewInstances 须为安全非负整数（超长数字/Infinity 不受理）' };
  }
  const reason = String(fields.reviewReason ?? '').trim();
  if (reason === '') {
    return { ok: false, reason: '评审 sidecar 缺 reviewReason（R-M3-16：自评/混合/追认须记理由，独立评审也须记录实例分配）' };
  }
  if (mode === 'independent' && instances < 2) {
    return { ok: false, reason: `reviewMode=independent 须 ≥2 个 fresh-context 实例（当前 ${instances}）` };
  }
  if (mode === 'mixed' && instances !== 1) {
    return { ok: false, reason: `reviewMode=mixed 须恰 1 个独立实例（当前 ${instances}）` };
  }
  if (mode === 'self' && instances !== 0) {
    return { ok: false, reason: `reviewMode=self 须 0 个独立实例（当前 ${instances}）` };
  }
  if (mode === 'ratified' && instances !== 0) {
    return { ok: false, reason: `reviewMode=ratified 须 0 个独立实例（当前 ${instances}）` };
  }
  if (fields.schemaVersion === '3') {
    const roundParsed = parseReviewRound(fields.reviewRound);
    if (!roundParsed.ok) return roundParsed;
    if (typeof ctx.fileName === 'string') {
      // A12：文件名轮次锚只认精确 stem 的两种形态（canonical `<stem>-review.md` 不声明轮次，
      // null 即跳过）；`-review-roundN` 与 `-reviewN` 同校，异常命名不再被宽松前缀匹配收编。
      const fileRound = fileRoundNumberOf(ctx.fileName, ctx.stem ?? '');
      if (fileRound !== null && fileRound !== roundParsed.round) {
        return { ok: false, reason: `文件名轮次（${fileRound}）与 reviewRound（${roundParsed.round}）不一致` };
      }
    }
    const provParsed = parseReviewProvenance(fields.reviewProvenance);
    if (!provParsed.ok) return provParsed;
    if (roundParsed.round > 1
      && !hasPriorRoundFile(ctx.siblings, ctx.stem ?? '', roundParsed.round, {
        dir: ctx.dir, taskId, norm,
      })) {
      return { ok: false, reason: `reviewRound=${roundParsed.round} 缺前轮归档或前轮档 planPath 不符（须存在精确 stem 的 -review-round1..N-1.md 或 -reviewN.md，且 frontmatter planPath 与本计划一致）` };
    }
    const prov = validatePlanProvenance(provParsed.value, {
      mode, instances, round: roundParsed.round, chain: planChainIdentity(norm),
    });
    if (!prov.ok) return prov;
  }
  if (surface.overThreshold && mode !== 'independent') {
    return {
      ok: false,
      reason: `超阈值实现类计划须 reviewMode=independent（≥2 fresh-context 实例；当前 ${mode}/${instances}）——请补独立实例或拆小；宿主无子代理能力时由用户显式 --exempt "<逐字引文>" --exempt-scope plan|review --exempt-src user|preauthorized`,
    };
  }
  return { ok: true };
}

/**
 * 校验 plan-execution 的评审凭据 v2/v3（内部规则-10 / 内部规则-16 / 内部决策-007）：先认 canonical
 * `<计划名>-review.md`；canonical 失配（含缺失）时扫描同目录 `<计划名>-review*.md`
 * 全序列按内容匹配 v2/v3 通过档（P1，2026-10-10 内部任务-29 / 内部任务-103 实录：多轮评审
 * 「新记录标注取代旧记录」惯例把通过档写在 -review2.md，canonical-only 读取使
 * 声明被首轮不通过档卡死）——历史轮归档与 canonical 并存时，有效凭据＝与当前
 * 计划哈希匹配的那一份（内容绑定、单有效）；全序列无匹配即拒绝，拒因保留
 * canonical 诊断精度并注记序列扫描未命中。legacy（无 frontmatter 哈希）sidecar
 * 可读作历史但不构成 v2/v3 凭据；其他计划的通过记录（不同 stem）不进扫描面。
 * @param {string} root 项目根
 * @param {string} planRel 计划相对路径（必须位于 PLAN_DIRS 之下）
 * @param {string} taskId 声明的任务标识
 * @returns {{ok: boolean, reason?: string, planSha256?: string, sidecar?: string,
 *            surface: object|null}} surface 在计划可读时非空（失败也附），早退为 null
 */
/**
 * 计划相对路径归一与受检目录守卫（内部任务-265）：verifyReviewedPlan 与
 * resolveDeclaredPlan 共用，保证 docs/plans 口径单源。
 * @param {string} planRel
 * @returns {{ok:true, planRel:string} | {ok:false, reason:string}}
 */
export function normalizePlanRelPath(planRel) {
  const norm = normalize(String(planRel ?? '')).replace(/\\/g, '/');
  if (!norm || norm.startsWith('../') || norm.startsWith('/')) {
    return { ok: false, reason: '计划路径非法（越界）' };
  }
  const inAllowed = PLAN_DIRS.some((d) => norm === `${d}/${norm.split('/').pop()}` || norm.startsWith(`${d}/`));
  if (!inAllowed) return { ok: false, reason: '计划不在受检目录（docs/plans/）内' };
  return { ok: true, planRel: norm };
}

/**
 * 只解析声明计划（内部任务-265 review scope）：路径/存在/可读/哈希，不要求 review sidecar。
 * @param {string} root 项目根
 * @param {string} planRel 项目根相对计划路径
 * @returns {{ok:true, planRel:string, planFile:string, text:string, planSha256:string} | {ok:false, reason:string}}
 */
export function resolveDeclaredPlan(root, planRel) {
  const norm = normalizePlanRelPath(planRel);
  if (!norm.ok) return norm;
  const planFile = resolve(root, norm.planRel);
  if (!existsSync(planFile)) return { ok: false, reason: '计划文件不存在' };
  let text;
  try {
    text = readFileSync(planFile, 'utf8');
  } catch {
    return { ok: false, reason: '计划文件不可读' };
  }
  return { ok: true, planRel: norm.planRel, planFile, text, planSha256: planSha256OfText(text) };
}

export function verifyReviewedPlan(root, planRel, taskId, planRoot = null) {
  const normalized = normalizePlanRelPath(planRel);
  if (!normalized.ok) return { ok: false, surface: null, reason: normalized.reason };
  const norm = normalized.planRel;
  // W4（2026-09-16 租约族缺陷批次）：凭据解析根与声明键解耦——缺省=声明键仓根
  // （行为等价），显式 planRoot 支持多仓工作区（计划在主仓、声明键落嵌套仓）。
  // planRoot 必须为存在的目录（resolve 核验），否则任何人都能拿任意目录的 sidecar
  // 冒充凭据——防御纵深的另一半。
  const hasPlanRoot = planRoot !== null && planRoot !== undefined;
  const credRoot = hasPlanRoot ? resolve(String(planRoot)) : resolve(root);
  if (hasPlanRoot && !existsSync(credRoot)) {
    return { ok: false, surface: null, reason: `--plan-root 指向的目录不存在（收到「${planRoot}」）——凭据解析根必须为存在的目录` };
  }
  const planFile = resolve(credRoot, norm);
  if (!existsSync(planFile)) return { ok: false, surface: null, reason: '计划文件不存在' };
  let planText;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch {
    return { ok: false, surface: null, reason: '计划文件不可读' };
  }
  const current = planSha256OfText(planText);
  const surface = planChangeSurface(planText);
  // A6（内部任务-193）：计划 stem 单次派生，sidecar 名/前轮档锚/序列扫描面共用；
  // 目录只解析一次、只 readdirSync 一次（旧实现 siblings 与 P1 扫描对同一目录各读一次，
  // dirname 也重复计算——两次读之间目录变化会让两处看到不同快照）。
  const stem = norm.split('/').pop().replace(/\.md$/, '');
  const sidecarName = `${stem}-review.md`;
  const sidecarDir = resolve(credRoot, dirname(norm));
  const sidecarFile = join(sidecarDir, sidecarName);
  let siblings = [];
  try {
    siblings = readdirSync(sidecarDir).filter((n) => n.endsWith('.md'));
  } catch {
    /* 目录不可读：前轮档结构锚按缺失处理（fail-closed 于 v3 round>1，canonical 拒因兜底） */
  }
  const ctxFor = (fileName) => ({ fileName, siblings, stem, dir: sidecarDir });
  let canonicalReason = null;
  if (existsSync(sidecarFile)) {
    try {
      const text = readFileSync(sidecarFile, 'utf8');
      const canonical = checkSidecarContent(text, taskId, norm, current, surface, ctxFor(sidecarName));
      if (canonical.ok) return { ok: true, planSha256: current, surface };
      canonicalReason = canonical.reason;
    } catch {
      canonicalReason = '评审记录不可读';
    }
  } else {
    canonicalReason = '同名评审记录不存在';
  }
  // P1 序列扫描：同 stem 的 -review*.md（排除 canonical 自身，按名排序逐份内容
  // 校验）；扫描面按文件名前缀收窄——其他计划的 sidecar（不同 stem）与本计划的
  // 执行台账（-exec.md 等）天然不进面。A6：candidates 由上方 siblings 派生（同一份
  // 目录快照），不再二次 readdir；目录不可读时 siblings=[]，保持 canonical 拒因。
  const candidates = siblings
    .filter((n) => n !== sidecarName && n.startsWith(`${stem}-review`) && n.endsWith('.md'))
    .sort();
  let candidateReason = null;
  for (const name of candidates) {
    let text;
    try {
      text = readFileSync(join(sidecarDir, name), 'utf8');
    } catch {
      continue; // 单份不可读跳过（尽力扫描，canonical 拒因兜底）
    }
    const hit = checkSidecarContent(text, taskId, norm, current, surface, ctxFor(name));
    if (hit.ok) return { ok: true, planSha256: current, surface, sidecar: name };
    if (candidateReason === null && typeof hit.reason === 'string' && hit.reason !== '') {
      candidateReason = hit.reason;
    }
  }
  const tail =
    candidates.length > 0 ? `（已扫描同 stem -review*.md 序列 ${candidates.length} 份，未命中与当前哈希匹配的 v2/v3 通过档）` : '';
  const candidateTail = candidateReason === null ? '' : `；候选拒因：${candidateReason}`;
  return { ok: false, surface, reason: `${canonicalReason}${tail}${candidateTail}` };
}
