// 文件：routing-gate.mjs
// 描述：任务租约闸（内部规则-8，2026-09-13 内部决策-018 升级为 per-session capability 租约）——
//       PreToolUse(Bash|Edit|Write) 三类写路径护栏：本项目本会话无当前任务租约时 deny，
//       并在 systemMessage 给出可复制的声明命令（含本轮挑战 leaseId）。只读专用工具
//       不经本闸（研究自由不受限，内部模块-1 边界：纯对话与只读路径不设硬门）。
//       内部任务-8（2026-10-07，内部规则-17 工具族归一）：管辖面由字面三工具名改为**工具族**——
//       shell 族（bash/pwsh/powershell/sh/cmd/zsh）与 edit 族（edit/write/str_replace_editor，
//       大小写归一）走整闸，other 族静默放行；归一表唯一源在 scripts/lib/tool-families.mjs。
//       配套 manifest 侧 matcher 键省略（全命中——旧字面词表在 DSH 的 pwsh/edit/write 上
//       恒不匹配，护栏整体空转＝RC-0；`.*` 在 DSH 亦恒不匹配，不得回退）。工具名键只认
//       `tool_name`，不加多键兜底（归一职责在宿主 shim，未知键名 → other → fail-open）。
//       **无 `tool_name`/未识别名的语义（门禁实例1 F1 登记为设计语义）**：本闸按工具族选键控维度
//       （shell→cwd / edit→file_path），族不可判即**无法定键** ⇒ 静默放行（fail-open）。这与两护栏
//       钩不同（check-careful/check-freeze 的判据是**内容面**、与键控维度无关，故无工具名时按内容
//       照常判定）——差异是有意的：判据依赖族的钩子在族缺失时无法自证作用域，强行判定＝猜测键维度。
//       锁定用例：routing-gate.test.mjs「无工具名负载静默放行（设计语义）」。
//       Bash 特例（bootstrap）：未持租约时仅放行「严格解析的 routing-declare
//       声明命令」（单条或多条纯声明顺序拼接——P5，2026-10-10；管道/重定向/命令
//       替换/裸 &/非声明附加命令一律拒绝）及 cd 两段形态
//       `cd <绝对路径> && node routing-declare …`（2026-09-13 加固批次 D1：嵌套仓键
//       声明的第一出路）——声明命令本身是闭环的第一环，不能被闸自己拦死。
//       check-careful.mjs 继续独立承担危险命令分类，两职责不合并（内部未决-14 批次
//       起其为 Node 实现）。
//       键控与租约语义见 task-lease-lib.mjs；工具级键控选择（Edit/Write 按 file_path、
//       Bash 按 cwd）在本文件 deriveGateKey（2026-09-13 嵌套仓修复）。
//       2026-09-13 加固批次：deny 落 lease-deny incident（根取 cwd 仓，与横幅/Stop
//       观察链对齐）；「状态缺失或损坏」分支附键控诊断；崩溃陷阱（hook-lib）。
//       2026-09-14（协议扩展，内部决策-020）：写面（--change-scope）闸侧执行——带写面的
//       租约 Edit/Write 超面（含键仓外越界）即 deny，文案附 scopeHint 指引扩面或
//       升级计划链；无写面声明的租约保持全仓放行（向后兼容）。判定异常一律放行
//       （fail-open 姿态不破，project-conventions 硬规则 4）。
//       2026-09-15（闸/文案批，内部未决-10/13）：deny 声明命令与跨键诊断键路径统一
//       「双引号包裹正斜杠」形态（Git Bash 可直接复制执行，与解析面引号词法闭环）。
//       2026-10-12（内部未决-94，内部任务-50）：该形态订正为「单引号包裹」——bash/pwsh 双壳内零
//       展开（cd 目标例外维持双引号+禁字符，见 内部规则-9），解析面双接受。
//       2026-09-22（内部任务-LEASEGATE-1，内部决策-018 修正案）：deny 留痕段增 lease-loop 升级
//       （同 (session,digest) 窗内 resolved ≥2 再 deny 时追加不可自愈升级记录，内部规则-13 ④；
//       注入缝 WF_LEASE_LOOP_WINDOW_MS，缺省 600000）；null 桶轮换语义随 task-lease-lib
//       弱形态化（轮换不吊销、校验扫描回退），deny 文案括注同步改弱形态措辞。
//       2026-10-06（内部任务-5 A组，内部规则-16/F12）：plan-writing/plan-review 租约增设规划阶段
//       固定写面 authoringViolation——PLAN_DIRS 过程 Markdown 上界与 changeScope 逻辑
//       AND（空交集不放行），专属 authoringHint 与通用写面拒隔离（不引导 --change-scope
//       扩面绕过固定上界）；Bash 不受此判定（非 shell 沙箱），legacy 规划租约同检。
//       2026-10-14（内部任务-75/IMP-3，内部规则-20）：SKILL_WRITE_FLOOR 映射表内 skill（首批
//       root-cause-debugging）增设基线写面 floorViolation——目标须 ∈ 基线面 ∪ changeScope
//       （并集可扩，与规划上界的 AND 语义相反），专属 floorHint 指引沿原任务号补声明；
//       并集单点化=映射表内 skill 跳过通用写面判定（叠加会把基线面反向吊销成 AND）；
//       三写面判定的目标解析样板收敛为 editTargetRel/scopeCovers 单点（第三份同构即抽）。
//       内部任务-342（2026-11-06）：denyCtx 记录 taskId/skill 改本会话具名有效租约 own-only——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// fail-open：任何失败（负载垃圾、状态不可读、插件根未知导致无法给出声明命令）
//       静默退出 0，不阻断宿主（内部规则-10 同款姿态；project-conventions 硬规则 4）。
//       deny 只发生在"负载健康且明确无有效租约"或"租约有效但写面不覆盖目标"的判定上。
// 用法：宿主经 hooks.json 以 process 方式调用（stdin=宿主 JSON 负载）；
//       自检：node routing-gate.mjs --selftest（B-M8-4）。
import { dirname, join, relative, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { projectKey, gitAncestor, activationRoot, canonicalPath, canonicalRoot, PLAN_DIRS, SKILL_WRITE_FLOOR } from './routing-lib.mjs';
import { missingAcks, requiredProjectSkills } from '../scripts/lib/project-skills.mjs';
import { installHookErrorTrap, noteHookIssue, pluginRootDir, readStdin, runHookMain } from './hook-lib.mjs';
import {
  issueChallenge,
  activateLease,
  readActiveLease,
  currentChallengeToken,
  isBootstrapDeclareCommand,
  isReadOnlyCommand,
  isPureCdCommand,
  recentDeclaredProjectKey,
  newestActiveLease,
  bootstrapRejectHint,
  heartbeatLease,
  issuanceKeys,
  leaseStatusOfKeys,
  resolveInheritedTaskId,
  soleTaskIdSuggestion,
  LEASE_REASONS,
  REISSUE_TRIAGE_NOTE,
  ownNamedLease,
} from './task-lease-lib.mjs';
import { appendIncident, digestOf, reopensWithin, setStatus } from '../scripts/lib/incident-store.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';
import { familyOf } from '../scripts/lib/tool-families.mjs';

// readStdin 迁移 hook-lib（2026-09-19 评审修复批，消除逐字拷贝）

/**
 * 闸侧项目键推导：Edit/Write 按 tool_input.file_path 所在 git 仓键控——编辑哪个仓的文件
 * 就归哪个仓的租约，不跟会话 shell cwd（坑 1：cd 进嵌套文档仓不会把主仓文件编辑锁死，
 * 两仓编辑天然各归各键）；file_path 缺失/非字符串时回退 cwd 键控。文件不属任何仓时跟随
 * 会话 cwd 所在仓；文件与 cwd 均无 .git 祖先（激活域外）返回 null——main 据此整套静默
 * 放行（2026-09-15 激活域批次，内部决策-022；原 内部验收-7「无 .git 回退 cwd 自身为键」语义随
 * 之反转：非仓目录不再是自成一键的项目，而是不受闸约束的目录）。Bash 无文件路径可
 * 推导，维持 cwd 键控（嵌套仓场景由 deny 诊断文案兜底）。
 * @param {string} toolName 工具名（Bash|Edit|Write）
 * @param {object} payload 宿主负载
 * @returns {string|null} 项目键；激活域外 null
 */
function deriveGateKey(toolName, payload) {
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  if (familyOf(toolName) === 'edit') {
    const fp = payload?.tool_input?.file_path ?? payload?.file_path;
    if (typeof fp === 'string' && fp) {
      const fileDir = dirname(resolve(cwd, fp)); // 相对路径按负载 cwd 解析
      const fileRoot = gitAncestor(fileDir);
      if (fileRoot) return fileRoot; // 文件归其最近 .git 仓
      return activationRoot(cwd); // 文件不属任何仓：跟随会话所在仓；cwd 也非仓 → null
    }
  }
  return activationRoot(cwd);
}

/**
 * Edit/Write 目标相对键根的归一解析（内部任务-75 简洁性评审处置：三写面判定的目标解析样板
 * 落到第三份逐字拷贝，按「第三份同构即抽」阈值收敛为单点）：非 edit 族/无路径负载/
 * 解析异常统一返回 null（各判定方以 null=不拦，fail-open 家族姿态，project-conventions 硬规则 4）；
 * 目标 canonical 化（内部任务-MACKEY-1：目标残留 symlink 前缀按最近存在祖先的真实落点归一，
 * 键仓内 "..draft.md" 这类 .. 开头合法文件名不是逃逸，由调用方继续面匹配——R2 回归
 * 2026-09-14）+ 正斜杠归一（跨平台一致）；目标恰为键根本身返回 '.'。
 * @param {string} key 项目键（rel 相对该键根求值，与 deriveGateKey 键控同源）
 * @param {string} toolName 工具名（仅 Edit/Write 解析）
 * @param {object} payload 宿主负载
 * @returns {string|null} 归一 rel（含 '..'/'../' 键仓外形态与 '.' 键根形态），不可判定为 null
 */
function editTargetRel(key, toolName, payload) {
  try {
    if (familyOf(toolName) !== 'edit') return null;
    const fp = payload?.tool_input?.file_path ?? payload?.file_path;
    if (typeof fp !== 'string' || !fp) return null; // 无文件路径可判定：无从定面
    const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const absFile = canonicalPath(resolve(cwd, fp));
    const rel = relative(key, absFile).replace(/\\/g, '/');
    return rel === '' ? '.' : rel;
  } catch {
    return null; // 解析异常：fail-open，交调用方按不拦处理
  }
}

/**
 * changeScope 声明面匹配（scopeViolation/floorViolation 共用，内部任务-75 收敛）：条目本身或
 * 其目录前缀命中即覆盖；去尾斜杠后为空串或 "." 视为全仓覆盖（条目入库时已禁绝对路径
 * 与 .. 段）。
 * @param {string} rel editTargetRel 归一结果 @param {string[]} entries 声明面条目
 * @returns {boolean} 是否覆盖
 */
function scopeCovers(rel, entries) {
  for (const entry of entries) {
    const en = String(entry).replace(/\/+$/, '');
    if (en === '' || en === '.') return true; // 根条目＝全仓放行
    if (rel === en || rel.startsWith(`${en}/`)) return true; // 条目本身或目录前缀
  }
  return false;
}

/**
 * 写面（change-scope）判定（协议扩展 2026-09-14，内部决策-020）：租约带 changeScope 时，
 * Edit/Write 目标必须落在声明面内——目标绝对路径（相对路径按负载 cwd 解析，与
 * deriveGateKey 同款口径）相对项目键求 rel（键与 readActiveLease 同源，不新造键
 * 语义：scope 相对声明所在仓的根求值），命中条目本身或其目录前缀才放行；条目去
 * 尾斜杠后为空串或 "." 视为全仓放行。Bash 不判定；租约无 changeScope/空数组直接
 * 放行（旧协议租约向后兼容）。判定内部任何异常一律放行（fail-open 姿态不破，
 * project-conventions 硬规则 4），不向 stderr 输出。内部任务-75：SKILL_WRITE_FLOOR 映射表内 skill
 **不进本判定**（main 侧跳过）——其写面语义由 floorViolation 单点承载（基线面 ∪
 * 声明面的并集，内部规则-20），通用判定与并集判定叠加会把基线面反向吊销成 AND。
 * @param {{ valid: boolean, lease?: object }} lease readActiveLease 返回值（仅 valid 时进入）
 * @param {string} key 项目键（写面相对该键根求值）
 * @param {string} toolName 工具名（仅 Edit/Write 判定）
 * @param {object} payload 宿主负载
 * @returns {string|null} 超面时返回目标相对键根的路径（供 scopeHint 点名），否则 null
 */
/**
 * 内部决策-070 D5（内部任务-341）：项目 skill 必载集合的 ack 覆盖判定（仅 Edit/Write；仅 valid 租约）。
 * 清单缺失/损坏时 requiredProjectSkills 内部回退源扫描；判定异常返回 null（fail-open）。
 * @param {{ valid:boolean, lease?:object }} lease
 * @param {string} key 项目键（发现根相对该键根求值）
 * @param {string} toolName
 * @returns {{ missing:object[], required:object[] }|null}
 */
function projectSkillViolation(lease, key, toolName) {
  try {
    if (familyOf(toolName) !== 'edit') return null;
    const info = requiredProjectSkills({ projectRoot: key, env: process.env });
    if (info.source === 'scan-error' || info.warning) {
      try { process.stderr.write(`[routing-gate] 项目 skill 扫描异常（按源扫描失败，fail-open）：${info.warning ?? '未知'}\n`); } catch { /* stderr 不可写则静默 */ }
    }
    if (info.source === 'scan-error') return null;
    if (info.required.length === 0) return null;
    const missing = missingAcks(info.required, lease?.lease);
    if (missing.length === 0) return null;
    return { missing, required: info.required };
  } catch (e) {
    try { process.stderr.write(`[routing-gate] 项目 skill 判定异常（fail-open）：${e?.message ?? e}\n`); } catch { /* stderr 不可写则静默 */ }
    return null; // fail-open：项目 skill 判定异常不阻断写操作
  }
}

function scopeViolation(lease, key, toolName, payload) {
  try {
    const scope = lease?.lease?.changeScope;
    if (!Array.isArray(scope) || scope.length === 0) return null;
    const rel = editTargetRel(key, toolName, payload);
    if (rel === null) return null; // 非 edit 族/无路径/解析异常：无从定面，放行
    // 越界判定只认 ".." 或 "../" 前缀（键仓外即超面）；键仓内 .. 开头合法文件名交面匹配
    if (rel === '..' || rel.startsWith('../')) return rel;
    if (scopeCovers(rel, scope)) return null;
    return rel;
  } catch {
    return null; // 判定内部异常（含租约字段异常读取）：fail-open 放行，不阻断宿主
  }
}

/**
 * 规划阶段固定写面判定（内部规则-16，内部任务-5 A组 2026-10-06）：plan-writing/plan-review 声明
 * 激活期间，Edit/Write 增设与 changeScope 独立的固定上界——目标必须落在 PLAN_DIRS
 * （docs/plans 与历史 docs/superpowers/plans，含子目录）内的 .md 过程文件：
 * canonicalPath(resolve(cwd, fp)) 后 relative(键, 目标) 正斜杠归一，面内 symlink/junction
 * 指向面外在 canonical 化后自然越界，目录本身/非 Markdown/键仓外一律拒。上界与既有
 * changeScope 判定是逻辑 AND（内部决策-7：规划产物边界是客观事实，与租约自述面正交）——
 * []/["."]/宽面声明不扩权、空交集不放行（空数组不退化为「空 scope=全仓放行」的
 * 执行期兼容语义）；面内目标返回 null，剩余判定交还 scopeViolation（["."]/宽面/未
 * 覆盖的通用语义不变，超面仍走 scopeHint 扩面出路）。legacy 规划租约（v2 同会话、
 * v3 null 扫描回退）的 skill 字段同受检查；非规划 skill 与 Bash 不进本判定（明示
 * 不是 shell 沙箱，root-cause 来源分类仍按 内部规则-9，路径检查不证明分类）。判定内部
 * 任何异常返回 null（fail-open 姿态不破，project-conventions 硬规则 4）。
 * @param {{ valid: boolean, lease?: object }} active readActiveLease 返回值（读 active.lease.skill）
 * @param {string} key 项目键（上界相对该键根求值，与 deriveGateKey 键控同源）
 * @param {string} toolName 工具名（仅 Edit/Write 判定）
 * @param {object} payload 宿主负载
 * @returns {{ kind: 'authoring', rel: string } | { kind: 'scope', rel: string } | null}
 *          kind=authoring：固定上界越界（专属 authoringHint，不带扩面指引）；
 *          kind=scope：规划租约声明了空数组写面（空交集，走通用写面语义）；
 *          null：无阶段违规（放行判定交还调用方/scopeViolation）
 */
function authoringViolation(active, key, toolName, payload) {
  try {
    const skill = active?.lease?.skill;
    if (skill !== 'plan-writing' && skill !== 'plan-review') return null;
    const rel = editTargetRel(key, toolName, payload);
    if (rel === null) return null; // 非 edit 族/无路径/解析异常：无从定界，放行
    if (rel === '..' || rel.startsWith('../')) return { kind: 'authoring', rel }; // 键仓外即上界外
    // 固定上界：PLAN_DIRS 之下（含子目录）的 .md 文件——目录本身（rel 恰为目录名，无
    // 尾随段）与非 md 文件都不匹配「目录前缀 + .md 后缀」双条件，自然落拒；
    // 面内 symlink/junction 指向面外在 canonical 化（editTargetRel）后自然越界
    const inBound = PLAN_DIRS.some((d) => rel.startsWith(`${d}/`)) && /\.md$/.test(rel);
    if (!inBound) return { kind: 'authoring', rel };
    // 空交集不放行：规划租约显式声明空数组写面＝声明面与上界交集为空——scopeViolation
    // 对空数组返 null（执行期兼容语义），此处须按空交集拦截，否则空数组扩权成全仓
    if (Array.isArray(active.lease.changeScope) && active.lease.changeScope.length === 0) {
      return { kind: 'scope', rel };
    }
    return null; // 上界内且非空交集：通用写面判定归 scopeViolation（含 ["."]/宽面/未覆盖）
  } catch {
    return null; // 判定内部异常：fail-open 放行，不阻断宿主
  }
}

/**
 * skill 基线写面判定（内部规则-20，内部任务-75/IMP-3）：SKILL_WRITE_FLOOR 映射表内的 skill 声明
 * 激活期间，Edit/Write 目标须落在**基线面 ∪ 租约 changeScope**（并集可扩——与规划固定
 * 上界 authoringViolation 的交集语义相反：基线面是免声明下界，代码/测试/归档面以
 * --change-scope 显式声明即放行，语义=「改什么」须显式，不是禁止修改）。基线面=PLAN_DIRS
 * （含子目录）内的 .md 过程文件；无 changeScope 时越基线面即拒；Bash、非映射 skill、
 * 无路径负载、判定异常一律 null（fail-open 姿态不破，project-conventions 硬规则 4）。legacy 租约
 * （skill 字段一直在）经同一 lease 对象同检；与 changeScope 双违规时 denyMessage 以
 * floorHint 分支呈现（补声明出路同义，不重复渲染 scopeHint）。
 * @param {{ valid: boolean, lease?: object }} active readActiveLease 返回值（读 active.lease.skill/changeScope）
 * @param {string} key 项目键（基线面相对该键根求值，与键控同源）
 * @param {string} toolName 工具名（仅 Edit/Write 判定）
 * @param {object} payload 宿主负载
 * @returns {{ rel: string } | null} 越基线面时返回目标相对键根路径（供 floorHint 点名），否则 null
 */
function floorViolation(active, key, toolName, payload) {
  try {
    const floor = SKILL_WRITE_FLOOR[active?.lease?.skill];
    if (!floor) return null;
    const rel = editTargetRel(key, toolName, payload);
    if (rel === null) return null; // 非 edit 族/无路径/解析异常：无从定面，放行
    if (rel === '..' || rel.startsWith('../')) return { rel }; // 键仓外即越基线面
    const inFloor = floor.some((d) => rel.startsWith(`${d}/`)) && /\.md$/.test(rel);
    if (inFloor) return null;
    const scope = active.lease.changeScope;
    if (Array.isArray(scope) && scopeCovers(rel, scope)) return null; // 声明面内（并集扩面）
    return { rel };
  } catch {
    return null; // 判定内部异常（含租约字段异常读取）：fail-open 放行，不阻断宿主
  }
}

// FB-6（2026-09-18 反馈批次）：双仓结构下「Bash 被拒但 Edit 同路径放行」易被误读为 bug——
// deny 文案点明两维度键控口径（Bash 按会话 cwd 所在仓，Edit/Write 按目标文件归属仓），
// 与 routing-gate 头部 deriveGateKey 的分工注释同源。
const KEYING_DIMENSION_NOTE = '键控维度：Bash 按会话 cwd 所在仓键控，Edit/Write 按目标文件归属仓键控（同一路径两工具结论可以不同，属设计行为）；';

// 声明脚本相对路径单源（内部未决-91 门①评审 S2）：取根 marker（main）、bootstrap 比对
// （main）与 deny 文案路径（denyMessage）三处共用——脚本改名只改这一处。
const DECLARE_REL = 'hooks/routing-declare.mjs';

/**
 * lease-loop 升级判定滑动窗（内部任务-LEASEGATE-1 F3）：WF_LEASE_LOOP_WINDOW_MS 覆盖
 * （缺省 10 分钟），非法/负值回落缺省——与 ttlMs 等 WF_* 缝同款解析形态。
 * @returns {number} 毫秒
 */
function loopWindowMs() {
  const raw = Number(process.env.WF_LEASE_LOOP_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600000;
}

/**
 * 组装 deny 信封文案：含可复制的声明命令（带本轮 leaseId）与路由表指引。
 * 内部决策-016：按失效原因分流——会话不匹配分支不得给重声明指引（同令牌重声明
 * 激活的是仍属他会话的租约，注定无效），改指引等待本会话新挑战并附诊断字段。
 * @param {string} root 插件根（经 hook-lib.pluginRootDir 推导：自身位置优先、env 兜底均验存在性——内部未决-91 收敛，env 非唯一来源）
 * @param {string|null} leaseId 本轮挑战令牌（读不到时给占位说明）
 * @param {string} toolName 工具名（Bash 提示含 bootstrap 例外说明）
 * @param {{ valid: boolean, lease?: object, reason?: string }} [invalid] readActiveLease 返回值（失效原因与诊断）
 * @param {{ currentKey?: string, recentKey?: string|null, bootstrapHint?: string, authoringHint?: string, scopeHint?: string, otherBucketLease?: { observerNamed: boolean, taskId: string|null, skill: string|null }, multiKeyNote?: string }} [diag] 键控诊断
 *        （「无有效态」家族——「状态缺失或损坏」/「挑战未激活（当前令牌尚未声明）」两分支的
 *        跨键/无状态提示、Bash 元字符提示与写面越界提示，内部任务-LEASEATT-1 扩面；authoringHint
 *        为规划阶段固定写面越界提示，内部规则-16——先于 scopeHint 分支呈现且不携带扩面指引；
 *        multiKeyNote 为双/多键工作区逐键声明状态清单〔内部任务-24 D3〕，仅无有效态家族+键数>1
 *        非空，由通用分支尾部渲染——头部窗口保留可执行声明命令；otherBucketLease 为「键上
 *        已有租约而观察侧不可见」判据〔内部任务-103 F2/内部任务-111〕——仅 STATE_MISSING+recentKey
 *        为 null 分支消费，驱动「从未签发」文案的会话隔离分流，采集 fail-open）
 * @returns {string}
 */
/** 「无有效态」家族判定（阶段复审归一）：main 采集侧与 denyMessage 渲染门共用单点谓词。 */
function isNoValidStateFamily(reason) {
  return reason === LEASE_REASONS.STATE_MISSING || reason === LEASE_REASONS.UNACTIVATED;
}

/** 「从未签发」诊断窗（内部任务-103 F2/内部任务-111）：STATE_MISSING 且 recentKey 严格 null 的双条件单点谓词——
 *  main 采集门与 denyMessage 渲染门共用（isNoValidStateFamily 同型先例）；recentKey 为 undefined
 *  （recentDeclaredProjectKey 扫描失败态）时本谓词恒 false，两门同闭，「失败不出诊断」既有语义不变。 */
function isNeverIssuedWindow(reason, recentKey) {
  return reason === LEASE_REASONS.STATE_MISSING && recentKey === null;
}

function denyMessage(root, leaseId, toolName, invalid, diag = {}) {
  // 内部未决-94（内部任务-50）：声明命令统一「单引号包裹的正斜杠绝对路径」形态——bash/pwsh 双壳内
  // 单引号零展开（Git Bash 可直接复制执行不变；引号使含空格路径可用），与解析面双/单引号
  // 双接受词法闭环。历史 内部未决-13 双引号形态的命令仍被解析面放行。
  const declarePath = join(root, DECLARE_REL).replaceAll('\\', '/');
  // 内部任务-27 批二坑4：恰一条域建议时内联可照抄号（与租约行单源 soleTaskIdSuggestion）；
  // 多域/采集异常保持占位符（零域态经默认域兜底恰单建议即内联——内部任务-75，旧「零域保持
  // 占位符」形态废止；diag.suggestedTaskId 由调用方 fail-open 采集）。
  // 内部任务-244 A01：委派会话内联父链交付号（解析失败用指引占位，绝不内联自取建议号）。
  const taskIdArg =
    diag.delegated === true
      ? (typeof diag.inheritedTaskId === 'string' && diag.inheritedTaskId ? diag.inheritedTaskId : '<父会话交付任务号>')
      : (diag.suggestedTaskId ?? '<任务号>');
  const cmd = `node '${declarePath}' <命中skill名> --lease <本轮leaseId> --task-id ${taskIdArg}`;
  // 内部任务-247 F2（2026-10-28）：多键态头部命令附执法键 --project-root——尾部【已签发键清单】被
  // 宿主截断时，照抄头部命令在任意 cwd 都完成对执法键的正确声明（resolveDeclareKey 单引号
  // 口径一致）；单键/写面分支 multiKeyNote 为空，逐字节不变。
  const projectRootSuffix =
    diag.multiKeyNote && typeof diag.currentKey === 'string' && diag.currentKey
      ? ` --project-root '${diag.currentKey.replaceAll('\\', '/')}'`
      : '';
  const cmdWithRoot = `${cmd}${projectRootSuffix}`;
  const token = leaseId ?? '（本轮 UserPromptSubmit 注入的【workflow 任务租约】行内取）';
  // Bash 尾注（P7 后）：放行面已在头部 gateNote 述尽，此处只留头部未覆盖的补签出路
  // 与键控诊断的承接位——重复陈述会把可复制的声明命令挤到截断区之外。
  const bashNote = familyOf(toolName) === 'shell' ? '（声明命令逐段严格解析：纯声明顺序拼接可放行，混入非声明命令/管道/重定向/命令替换一律拒绝）' : '';
  const bootNote = diag.bootstrapHint ? ` ${diag.bootstrapHint}` : '';
  // 内部任务-8（内部规则-18 可审计路径）：租约经 null 桶救回时，deny 诊断段标注来源桶。判据由
  // readActiveLease 结果自身推导（不在调用方拼字符串——防「自指恒真」断言）；放行路径
  // 零输出不变（内部规则-6 信封契约），本标注只出现在「租约有效但因写面/规划上界另被拒」的文案里。
  const viaNullNote =
    invalid?.valid === true && invalid?.viaScan === true && invalid?.viaNullBucket === true
      ? '（经 null 桶放行：该租约由无会话标识的共享桶救回，跨会话可见——本操作因上述原因另行拦截）'
      : '';
  if (invalid?.reason === LEASE_REASONS.OTHER_SESSION && invalid.lease) {
    const l = invalid.lease;
    const rawDeclared = Number(l.declaredAt);
    const declared = Number.isFinite(rawDeclared) ? new Date(rawDeclared).toISOString() : '未知';
    const diag = `skill=${l.skill}｜task=${l.taskId}｜declaredAt=${declared}`;
    return (
      `[workflow][任务租约闸] 租约属其他会话（${diag}）：本会话用同一令牌重复声明无效——激活继承挑战签发方的会话标识。` +
      `请等待本会话下一条用户消息签发新挑战后再声明，或协调持锁会话完成/关闭。` +
      `Bash/Edit/Write 需持当前会话租约；${KEYING_DIMENSION_NOTE}宿主只读工具（Read/Glob/Grep 等）不受影响。` +
      `协议语义见 ADR-016。${bashNote}${bootNote}`
    );
  }
  const reasonNote = invalid?.reason ? `（失效原因：${invalid.reason}）` : '';
  // P9（2026-10-10 内部任务-29 / 内部任务-103 P9，内部未决-105）：「挑战未激活」的高发场景之一是
  // AskUserQuestion 答复后继续操作——答复是工具结果通道，不触发 UserPromptSubmit 签发
  // 与轮换，上一轮令牌未声明即失配 deny；给直接指引（以最近一轮租约行令牌重声明即恢复）。
  // 根因（答复通道不签发新挑战）登记 内部未决-105，待宿主 PostToolUse additionalContext
  // 采信面有实机探针后再修钩子面。
  const askNote =
    invalid?.reason === LEASE_REASONS.UNACTIVATED
      ? '若上一动作是 AskUserQuestion 答复：答复不触发租约轮换与签发——直接以最近一轮租约行令牌重新声明即可恢复（OPEN-105）。'
      : '';
  // W2①（2026-09-16 批次）：挑战过期场景附官方化补签出路——否则 deny 文案给不出任何
  // 可执行路径（等待下一条用户消息之外的唯一出路是补签），照指引必败死循环只解一半。
  // 判据用前缀匹配（评审 S5 处置）：readActiveLease 的过期 reason 是稳定前缀
  // 「挑战已过期」，includes 子串会在未来无关文案恰含该短语时误挂补签指引。
  const reissueNote =
    typeof invalid?.reason === 'string' && invalid.reason.startsWith(LEASE_REASONS.EXPIRED_CHALLENGE)
      ? ` 挑战过期补签：node '${declarePath}' --bootstrap-reissue '<当前仓根绝对路径>'（前置=该仓键已持有效租约的会话上下文；详见 USAGE）。${REISSUE_TRIAGE_NOTE}`
      : '';
  let diagNote = '';
  // 内部任务-LEASEATT-1（2026-09-26）：跨键诊断挂「无有效态」家族两 reason——全链无状态
  // 与「挑战健在而从未声明」都是键错配的高发形态（声明挂在别的仓键），漏挂会把排障引向
  // 会话漂移弯路（本批根因实录）。「签发 hook 未运行」提示仍仅挂「状态缺失或损坏」：
  // 挑战未激活+无最近声明键是轮换后未再声明的主路径，声明命令已是正确指引，
  // 误指 hook 故障与同帧活令牌自相矛盾（阶段复审发现 1 处置）。
  if (isNoValidStateFamily(invalid?.reason)) {
    if (diag.recentKey && diag.recentKey !== diag.currentKey) {
      const ck = String(diag.currentKey).replaceAll('\\', '/');
      const rk = String(diag.recentKey).replaceAll('\\', '/');
      diagNote =
        familyOf(toolName) === 'shell'
          ? ` 键控诊断：当前目录解析到激活域根「${ck}」（git 仓根或含 .scout/mode.json/.sdd 的目录），最近成功声明的租约键是「${rk}」——` +
            '若你要操作的是后者：cd 回该域根目录再重试；若确要在当前域工作：在该域根目录重新走声明流程（嵌套 git 仓各有独立租约键）。'
          : ` 键控诊断：该文件属于激活域根「${ck}」（git 仓根或含 .scout/mode.json/.sdd 的目录），最近成功声明的租约键是「${rk}」——` +
            '本文件的编辑须在其所属域完成声明（在该域根目录运行声明命令；嵌套 git 仓各有独立租约键）。';
    } else if (isNeverIssuedWindow(invalid?.reason, diag.recentKey)) {
      // 内部任务-103 F2（内部任务-111 修复，2026-10-16）：STATE_MISSING 与 recentKey 为空共用两种真因——
      // 真·从未签发，或键上实际持有有效租约但挂在他会话桶、对当前观察侧不可见（负载缺
      // session_id 或会话标识与租约桶不一致，内部规则-18 显式表的不可见格）。经 diag.
      // otherBucketLease（main 侧 newestActiveLease 全可见扫描，采集 fail-open）分流：
      // 后者不得误指「签发 hook 未运行」，真实动作是会话侧归位（回原会话或等本会话新挑战）。
      if (diag.otherBucketLease) {
        const ob = diag.otherBucketLease;
        // taskId/skill 由采集侧单层归一为 string|null（denyCtx :915 先例），此处直接消费
        const leaseNote = ob.taskId
          ? `（task=${ob.taskId}${ob.skill ? `｜skill=${ob.skill}` : ''}）`
          : '';
        diagNote = ob.observerNamed
          ? ` 键控诊断：该项目键已有有效任务租约${leaseNote}，但本负载的会话标识与租约所在会话桶不一致——跨会话复用租约被会话隔离拒绝（ADR-018）；请在原签发会话内完成操作，或在本会话再发送一条用户消息签发新挑战后声明（同令牌重复声明无效，ADR-016）。`
          : ` 键控诊断：该项目键已有有效任务租约${leaseNote}，但本负载未携带会话标识（session_id）——租约挂在具名会话桶、对无标识观察侧不可见（ADR-018 会话隔离），并非签发 hook 未运行；请在原签发会话内完成操作，或在本会话再发送一条用户消息签发新挑战后声明。`;
      } else {
        diagNote =
          ' 键控诊断：该项目键从未签发过任务挑战（UserPromptSubmit 签发 hook 可能未运行或已崩溃）——' +
          '请再发送一条消息触发重新签发；持续出现请检查 hooks 配置。';
      }
    }
  }
  // 项目 skill 消费义务拦截（内部决策-070 D5/D4，内部任务-341）：租约有效但必载集合未 ack——
  // 出路=先加载对应 SKILL.md，再逐项 --project-skill 重声明（不套用「无有效租约」开头）。
  if (diag.projectSkillHint) {
    const missingNames = diag.projectSkillHint.missing.join('、');
    const all = diag.projectSkillHint.required;
    const loadPaths = all.map((sk) => sk.path).join('、');
    const flags = all.map((sk) => `--project-skill ${sk.name}`).join(' ');
    const psCmd = `node '${declarePath}' <命中skill名> --lease <本轮leaseId> --task-id ${invalid?.lease?.taskId ?? '<任务号>'} ${flags}`;
    return (
      `[workflow][任务租约闸] 本操作被项目 skill 消费义务拦截：缺 ${missingNames} 的加载 ack。` +
      `先加载项目 skill（${loadPaths}），再运行 ${psCmd} 重声明后重试（本轮 leaseId：${token}）。` +
      `必载集合：${all.map((sk) => sk.name).join('、')}；ack 入租约 projectSkills[] 与发号台账（ADR-070）。` +
      `Bash/Edit/Write 需持当前会话租约；宿主只读工具（Read/Glob/Grep 等）不受影响。${viaNullNote}`
    );
  }
  // 规划阶段固定写面拦截（内部规则-16，内部任务-5 A组 2026-10-06）：阶段越界与通用写面拒完全
  // 隔离——扩面重声明解不了固定上界（PLAN_DIRS 是阶段产物边界，不是租约自述面），
  // 文案不得含 --change-scope 指引或扩面话术，只指 plan-writing→plan-review→
  // plan-execution 的合法流向；本分支先于通用 scopeHint 呈现。
  if (diag.authoringHint) {
    return (
      `[workflow][任务租约闸] 本操作被规划阶段写面拦截：${diag.authoringHint}` +
      `plan-writing/plan-review 声明期间 Edit/Write 仅限 docs/plans 与 docs/superpowers/plans（含子目录）下的 .md 过程文档，` +
      `修改其余受控资产（仓规/规格/源码等）属执行行为，不随规划租约放行。` +
      `合法流向：plan-writing 落计划 → plan-review 评审 → plan-execution 持已评审凭据执行修改。` +
      `Bash 不受此上界（非 shell 沙箱，仍走整闸）；宿主只读工具（Read/Glob/Grep 等）不受影响。${viaNullNote}`
    );
  }
  // skill 基线写面拦截（内部规则-20，内部任务-75/IMP-3）：租约本身有效、目标越该 skill 的免声明
  // 基线面——不套用「无有效任务租约」开头（不真实）；正确出路＝沿**原任务号**补
  // --change-scope 重声明（并集扩面——显式声明即放行，不是禁止修改；渲染实际 taskId 与
  // leaseId，scopeHint 分支同款口径），先于 scopeHint 分支呈现。
  if (diag.floorHint) {
    const floorCmd = `node '${declarePath}' <命中skill名> --lease <本轮leaseId> --task-id ${invalid?.lease?.taskId ?? '<任务号>'}`;
    return (
      `[workflow][任务租约闸] 本操作被 skill 基线写面拦截：${diag.floorHint}` +
      `可在本 prompt 内重运行 ${floorCmd} 并追加 --change-scope '["<目标路径>",…]' 沿原任务号重声明扩面后重试（本轮 leaseId：${token}）。` +
      `基线写面语义：该类 skill 未声明写面时 Edit/Write 仅放行过程文档（docs/plans 的 .md），代码/测试/归档面修改须显式声明写面（并集扩面，R-M8-20）。` +
      `Bash 不设该判定（非 shell 沙箱，仍走整闸）；宿主只读工具（Read/Glob/Grep 等）不受影响。${viaNullNote}`
    );
  }
  // 写面拦截（协议扩展 2026-09-14）：租约本身有效、写面不覆盖目标——不套用
  // 「无有效任务租约」开头（不真实），文案如实：给出超面路径与扩面出路。
  // 2026-09-19 评审修复：扩面重声明用的正是本轮令牌——须与通用分支同款渲染实际
  // leaseId（cur.leaseId），占位符 <本轮leaseId> 会让操作者回翻早前租约行找令牌
  if (diag.scopeHint) {
    // 写面越界的正确出路＝**沿用当前任务号**重声明扩面——taskId 与 leaseId 同款渲染
    // 实际值（:303 先例）：内联「下一个新号」会误导换号，plan-execution 扩面重声明还须
    // 过 sidecar taskId 一致性校验（照抄新号必拒，阶段复审正确性发现 1）；建议号内联
    // 只属「无有效租约」通用分支。
    const scopedCmd = `node '${declarePath}' <命中skill名> --lease <本轮leaseId> --task-id ${invalid?.lease?.taskId ?? '<任务号>'}`;
    return (
      `[workflow][任务租约闸] 本操作被租约写面拦截：${diag.scopeHint}` +
      `可在本 prompt 内重运行 ${scopedCmd} 并追加 --change-scope 扩面后重试（本轮 leaseId：${token}）。` +
      `Bash/Edit/Write 需持当前会话租约；宿主只读工具（Read/Glob/Grep 等）不受影响。${viaNullNote}`
    );
  }
  // P7（2026-09-16 使用反馈批次）：Bash 面把「放行面与格式要求」紧随信封前缀给出——
  // 实测宿主对长 systemMessage 尾部截断（格式要求原在消息尾部时调用方不可见，只看到
  // 「无有效任务租约」半句），可执行信息必须落在头部窗口内；同一信息不再在尾部重复
  // （头部已述两种放行面，尾部旧句「仅放行一条声明命令」在白名单落地后已失真）。
  // 内部任务-247（2026-10-28）：第三放行面纯 cd 导航并入清单（「有三种」），③ 附反斜杠须单引号
  // 的可发现性提示（词法面把裸/双引号反斜杠按转义归一拒）。
  const gateNote =
    familyOf(toolName) === 'shell'
      ? 'Bash 放行面有三种：①严格解析的 routing-declare 声明命令（单条，或多条纯声明命令的顺序拼接——; / && / 换行切段、逐段独立严格解析，任一段非声明命令即拒；禁管道/重定向/命令替换；cd 两段形态除外——目标含空白时双引号必加）②只读白名单命令（常用只读命令与 git 只读子命令——完整清单以 task-lease-lib.mjs 的 READONLY_COMMANDS/READONLY_GIT_SUBCOMMANDS 常量为准，同样禁重定向与管道）③纯 cd <绝对路径>（cwd 漂移自救；反斜杠路径须单引号，单参数禁复合/展开）。'
      : '';
  // 内部任务-247 F2（2026-10-28）：多键态头部另附执法键短提示——宿主对长文案尾部截断（P7 实测）
  // 会吞掉尾部【已签发键清单】，执法键点名与正确令牌指引必须落在头部窗口内；单键态零注入。
  // 措辞「声明命令」不写「上方命令」（提示渲染位在命令模板之前，CEO 评审 C3 处置）。
  const multiKeyHeadNote = diag.multiKeyNote
    ? `多仓提示：本操作按执法键「${String(diag.currentKey ?? '').replaceAll('\\', '/')}」判定，声明命令已附 --project-root（任意 cwd 可完成该键声明）；逐键令牌见尾部【已签发键清单】。`
    : '';
  return (
    `[workflow][任务租约闸] 本项目当前 prompt 无有效任务租约，写操作先行拦截${reasonNote}：${multiKeyHeadNote}${bootNote}${gateNote}先查 workflow 元技能的` +
    `路由表并命中一行，然后运行 ${cmdWithRoot} 完成声明（本轮 leaseId：${token}；task-id 用当前任务的域前缀任务号（<域码>-<序号>，可先 --suggest-task-id 取号）），` +
    `再重试本操作。${askNote}租约随本会话下一条用户消息自动轮换（会话标识不可见时多活+TTL 自然过期，ADR-018 修正案），` +
    `Bash/Edit/Write 需持当前会话租约；${KEYING_DIMENSION_NOTE}宿主只读工具（Read/Glob/Grep 等）不受影响。${reissueNote}${bashNote}${diagNote}${diag.multiKeyNote || ''}`
  );
}

/**
 * 自检入口（B-M8-4）：租约签发/激活/轮换、bootstrap 解析、文案四组冒烟；失败可见退 1。
 * @returns {number} 退出码
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-rgate-selftest-'));
  const prevDir = process.env.WF_ROUTING_STATE_DIR;
  const prevTtl = process.env.WF_ROUTING_TTL_MS;
  try {
    process.env.WF_ROUTING_STATE_DIR = join(home, 'state');
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    // 未声明 → 无效；声明 → 有效；轮换 → 失效
    check('未声明判无效', !readActiveLease(key, Date.now(), { sessionId: 's1' }).valid);
    process.env.WF_ROUTING_TTL_MS = '3600000';
    const ch = issueChallenge(key, { sessionId: 's1' });
    check('挑战含 leaseId', Boolean(ch.leaseId));
    check('激活租约回环', activateLease(key, { leaseId: ch.leaseId, taskId: 'TASK-1', skill: 'tdd' }).ok);
    check('激活后判有效', readActiveLease(key, Date.now(), { sessionId: 's1' }).valid);
    const ch2 = issueChallenge(key, { sessionId: 's1' });
    check('下一 prompt 旧租约失效（会话桶强形态）', !readActiveLease(key, Date.now(), { sessionId: 's1' }).valid);
    check('旧 leaseId 不能重新激活', !activateLease(key, { leaseId: ch.leaseId, taskId: 'TASK-1', skill: 'tdd' }).ok);
    check('currentChallengeToken 返回新挑战', currentChallengeToken(key, 's1')?.leaseId === ch2.leaseId);
    // null 桶弱形态（内部决策-018 修正案 2026-09-22，内部任务-LEASEGATE-1）：轮换不吊销（F1+F2）。
    // 内部任务-8（任务 4.2）夹具迁移：占用事实迁至 claim（耐轮换）后，null 桶与具名桶**同号**即
    // 异会话撞号（这正是 RC-2 修复面），故本组改用独立 taskId '内部任务-2'——检查面是 null 桶
    // 生命周期，不是跨会话撞号。
    const chN = issueChallenge(key);
    check('null 桶激活回环', activateLease(key, { leaseId: chN.leaseId, taskId: 'TASK-2', skill: 'tdd' }).ok);
    issueChallenge(key); // null 桶轮换（可能是任一无标识会话的消息）
    check('null 桶轮换后旧租约仍有效（弱形态+扫描回退）', readActiveLease(key).valid);
    check('null 桶旧 token TTL 内可再激活', activateLease(key, { leaseId: chN.leaseId, taskId: 'TASK-2', skill: 'tdd' }).ok);
    // 内部任务-LEASEGATE-1 F3 升级冒烟：判定输入面（同签名窗内 resolved 达阈值 + 窗口 env）；
    // main 侧接线由 node --test 端到端覆盖（routing-gate.test.mjs「lease-loop 升级」用例）
    const prevInc = process.env.WF_INCIDENT_ROOT;
    const incRoot = join(home, 'loop-inc');
    process.env.WF_INCIDENT_ROOT = incRoot;
    try {
      const smRec = (id) => ({ id, ts: Date.now(), session: 'default', kind: 'lease-deny', tool: 'Bash', event: null, plugin: 'workflow', digest: 'sm00000000000001', taskId: null, skill: null });
      appendIncident(incRoot, smRec('ld-sm-1'));
      setStatus(incRoot, 'ld-sm-1', 'resolved');
      appendIncident(incRoot, smRec('ld-sm-2'));
      setStatus(incRoot, 'ld-sm-2', 'resolved');
      check(
        'lease-loop 判定输入：同签名窗内 resolved≥2 达阈值',
        reopensWithin(incRoot, { kind: 'lease-deny', digest: 'sm00000000000001', session: 'default', windowMs: loopWindowMs() }) >= 2,
      );
    } finally {
      if (prevInc === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = prevInc;
    }
    const prevLoop = process.env.WF_LEASE_LOOP_WINDOW_MS;
    process.env.WF_LEASE_LOOP_WINDOW_MS = 'bogus';
    const loopFallback = loopWindowMs();
    process.env.WF_LEASE_LOOP_WINDOW_MS = '3600000';
    const loopOverride = loopWindowMs();
    if (prevLoop === undefined) delete process.env.WF_LEASE_LOOP_WINDOW_MS;
    else process.env.WF_LEASE_LOOP_WINDOW_MS = prevLoop;
    check('升级窗口 env 非法回落缺省', loopFallback === 600000);
    check('升级窗口 env 合法覆盖生效', loopOverride === 3600000);
    // bootstrap 严格解析
    check('单条声明命令放行', isBootstrapDeclareCommand('node /opt/wf/routing-declare.mjs tdd --lease x --task-id TASK-1'));
    check('复合命令拒绝', !isBootstrapDeclareCommand('node a/routing-declare.mjs t; rm -rf /'));
    // 文案含命令与例外说明
    const msg = denyMessage('/opt/workflow', 'abc123', 'Bash');
    check('deny 文案含声明命令与例外说明', msg.includes('routing-declare.mjs') && msg.includes('严格解析') && msg.includes('abc123'));
    // 内部决策-016：deny 按失效原因分流
    const msgOther = denyMessage('/opt/workflow', 'abc124', 'Bash', {
      reason: '租约属其他会话', lease: { skill: 'tdd', taskId: 'TASK-3', declaredAt: 1757700000000 },
    });
    check(
      '会话不匹配文案含无效明示与诊断',
      msgOther.includes('重复声明无效') && msgOther.includes('TASK-3') && !msgOther.includes('routing-declare.mjs'),
    );
    const msgGen = denyMessage('/opt/workflow', 'abc125', 'Edit', { reason: '租约已过期' });
    check('其余原因文案含原因标注与命令', msgGen.includes('失效原因：租约已过期') && msgGen.includes('routing-declare.mjs'));
    // 嵌套 git 仓键控与诊断（坑 1/3 回归）
    const nested = join(proj, 'docs', 'nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    check('嵌套仓键推导为嵌套根（canonical 形态，TASK-MACKEY-1）', projectKey(nested) === canonicalRoot(nested));
    check(
      'Edit 键控按文件路径（cwd 在嵌套仓）',
      deriveGateKey('Edit', { tool_input: { file_path: join(proj, 'a.ts') }, cwd: nested }) === key,
    );
    check(
      'Edit 文件在嵌套仓键到嵌套仓',
      deriveGateKey('Edit', { tool_input: { file_path: join(nested, 'b.md') }, cwd: proj }) === projectKey(nested),
    );
    check('Bash 维持 cwd 键控', deriveGateKey('Bash', { cwd: nested }) === projectKey(nested));
    // 激活域（2026-09-15 批次，内部决策-022）：非仓 → null（main 静默放行）；文件非仓但 cwd 是仓 → cwd 仓键
    const nonRepo = join(home, 'nonrepo');
    mkdirSync(nonRepo, { recursive: true });
    check('非仓 Bash 键为 null（域外静默）', deriveGateKey('Bash', { cwd: nonRepo }) === null);
    check('非仓 Edit 键为 null（域外静默）', deriveGateKey('Edit', { tool_input: { file_path: join(nonRepo, 'a.md') }, cwd: nonRepo }) === null);
    check('文件非仓但 cwd 是仓 → 按 cwd 仓键控', deriveGateKey('Edit', { tool_input: { file_path: join(nonRepo, 'a.md') }, cwd: proj }) === key);
    const mCross = denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' }, { currentKey: nested, recentKey: proj });
    // 内部未决-13：诊断键路径输出正斜杠形态（嵌套/主仓根以反斜杠构造的期望需同步归一）
    const fwdNested = String(nested).replaceAll('\\', '/');
    const fwdProj = String(proj).replaceAll('\\', '/');
    check('deny 跨键诊断含双键与指引', mCross.includes(fwdProj) && mCross.includes(fwdNested) && mCross.includes('cd 回'));
    const mNever = denyMessage('/opt/workflow', null, 'Bash', { reason: '挑战未激活（当前令牌尚未声明）' }, { currentKey: nested, recentKey: proj });
    check('deny 跨键诊断含双键与指引（挑战未激活家族）', mNever.includes(fwdProj) && mNever.includes(fwdNested) && mNever.includes('cd 回'));
    // P9（2026-10-10 内部任务-29 / 内部未决-105）：答复通道不签发的直接指引挂挑战未激活家族
    check(
      'P9 挑战未激活家族含 AskUserQuestion 答复指引',
      mNever.includes('AskUserQuestion') && mNever.includes('最近一轮租约行') && mNever.includes('OPEN-105'),
    );
    check(
      'deny 不误挂签发 hook 故障提示（挑战未激活家族，阶段复审发现 1）',
      !denyMessage('/opt/workflow', 'abc130', 'Bash', { reason: '挑战未激活（当前令牌尚未声明）' }, { currentKey: proj, recentKey: null }).includes('从未签发过任务挑战'),
    );
    check(
      'deny 无状态提示签发 hook',
      denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' }, { currentKey: proj, recentKey: null }).includes('签发'),
    );
    check(
      'deny 会话隔离诊断：无标识观察侧不误指从未签发（DEV-103 F2）',
      (() => {
        const m = denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' },
          { currentKey: proj, recentKey: null, otherBucketLease: { observerNamed: false, taskId: 'DEV-911', skill: 'brainstorming' } });
        return m.includes('未携带会话标识') && m.includes('（task=DEV-911｜skill=brainstorming）') && !m.includes('从未签发过任务挑战');
      })(),
    );
    check(
      'deny 会话隔离诊断：桶不一致形态给隔离指引（DEV-103 F2）',
      (() => {
        const m = denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' },
          { currentKey: proj, recentKey: null, otherBucketLease: { observerNamed: true, taskId: 'DEV-911', skill: 'brainstorming' } });
        return m.includes('与租约所在会话桶不一致') && m.includes('ADR-016') && m.includes('（task=DEV-911｜skill=brainstorming）') && !m.includes('从未签发过任务挑战');
      })(),
    );
    check(
      'deny 会话隔离诊断：taskId 缺失时 leaseNote 整段省略（DEV-103 F2）',
      (() => {
        const m = denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' },
          { currentKey: proj, recentKey: null, otherBucketLease: { observerNamed: false, taskId: null, skill: null } });
        return m.includes('未携带会话标识') && !m.includes('task=');
      })(),
    );
    check(
      'deny 真无签发不误挂会话隔离诊断（DEV-103 F2 负向）',
      !denyMessage('/opt/workflow', null, 'Bash', { reason: '状态缺失或损坏' }, { currentKey: proj, recentKey: null })
        .includes('未携带会话标识'),
    );
    check(
      '元字符提示',
      bootstrapRejectHint('node x/routing-declare.mjs tdd | tail').includes('严格解析') &&
        bootstrapRejectHint('node x/routing-declare.mjs tdd | tail').includes('顺序拼接') &&
        bootstrapRejectHint('ls') === '',
    );
    check('非声明命令不出元字符提示', bootstrapRejectHint('ls | grep x') === '');
    // P7（2026-09-16 使用反馈批次）：Bash deny 的放行面/格式要求必须落在头部窗口内
    // （宿主展示对长文案尾部截断，原尾部承载使该信息不可见）
    check(
      'Bash deny 格式要求前置（P7）',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc127', 'Bash');
        return m.slice(0, 200).includes('严格解析') && m.slice(0, 200).includes('只读白名单');
      })(),
    );
    // FB-6（2026-09-18 反馈批次）：deny 文案须点明两维度键控口径——双仓下「Bash 被拒但
    // Edit 同路径放行」不标注维度会被误读为 bug；断言覆盖一般分支与会话不匹配分支
    check(
      'deny 文案含键控维度说明（FB-6）',
      denyMessage('/opt/workflow', 'abc128', 'Bash').includes('键控维度')
        && denyMessage('/opt/workflow', 'abc128', 'Edit').includes('归属仓')
        && denyMessage('/opt/workflow', 'abc129', 'Bash', {
          reason: '租约属其他会话', lease: { skill: 'tdd', taskId: 'TASK-3', declaredAt: 1757700000000 },
        }).includes('键控维度'),
    );
    // 只读白名单（2026-09-16 使用反馈批次 P8）：放行面按字面量逐态锁，断言不引用被测常量
    check(
      '只读白名单放行纯读命令',
      ['ls .', 'grep -rn "x" src', 'wc -l a.md', 'cat a.md', 'head -20 a.md', 'find . -name "*.mjs"', 'pwd'].every(isReadOnlyCommand),
    );
    check(
      '只读白名单放行 git 只读子命令（含全局旗标与列举型 branch）',
      ['git status', 'git log --oneline -5', 'git diff', 'git show HEAD', 'git rev-parse HEAD', 'git branch',
       'git branch -a', 'git branch --show-current', 'git -C sub status', 'git --no-pager diff',
       'git describe', 'git ls-remote origin'].every(isReadOnlyCommand),
    );
    check(
      '只读白名单拒 git 写面（含 branch 的写形态）',
      ['git push', 'git commit -m x', 'git checkout .', 'git branch -d x', 'git branch -D x', 'git branch feature',
       'git branch --set-upstream-to=origin/main', 'git branch -f main'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      '只读白名单拒写面与任意代码面',
      ['git push', 'node -e "process.exit(1)"', 'python -c "print(1)"', 'rm -rf /'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      '只读白名单拒重定向/管道/命令替换/环境赋值',
      ['ls > out.txt', 'ls | wc -l', 'cat $(echo a)', 'cat a; rm b', 'FOO=1 ls', 'ls && rm b'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      '只读白名单：引号内的元字符按字面量放行（引号外仍然拒）',
      isReadOnlyCommand('grep -E "a|b" src') && isReadOnlyCommand("grep 'x > y' a.md") && !isReadOnlyCommand('grep -E "a|b" src > out.txt'),
    );
    check(
      '只读白名单拒双引号内命令替换/反引号（DEV-244 S01）',
      ['ls "$(id)"', 'ls `id`', 'grep -rn "$(pwd)" .'].every((c) => !isReadOnlyCommand(c))
        && isReadOnlyCommand("ls '$(id)'"),
    );
    check(
      '只读白名单拒路径形态命令名（DEV-244 S03）',
      ['./ls', 'sub/ls', 'C:/repo/ls.exe', '//host/share/ls', '/usr/bin/ls', 'ls.exe'].every((c) => !isReadOnlyCommand(c))
        && !isReadOnlyCommand('/usr/bin/sudo ls') && !isReadOnlyCommand('env'),
    );
    check(
      '只读白名单拒写/执行参数面（DEV-244 S06）',
      ['xxd -r in out', 'xxd --revert in out', 'sort --compress-program=/bin/sh a', 'sort -T /tmp a', 'sort --temporary-directory=/tmp a'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      '只读白名单拒嵌套引号命令替换/长选项缩写/xxd 写面（DEV-244 阶段门）',
      ["ls \"'$(id)'\"", "ls \\'$(id)\\'", 'sort --out=/p a', 'sort --compress-prog=/bin/sh a', 'sort --temp=/tmp a', 'xxd a.bin'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      '只读白名单拒 find 写/执行动作（含 + 收尾形态与 -okdir）',
      ['find . -delete', 'find . -name x -exec rm {} ;', 'find . -exec rm {} +', 'find . -execdir rm {} +',
       'find . -okdir rm {} +', 'find . -fprint out.txt'].every((c) => !isReadOnlyCommand(c)),
    );
    // 内部任务-ROCMD-1（2026-09-26）：扩面命令正例（口径=无写面/无执行面）与负面参数表负例
    check(
      '白名单扩面：纯读/纯输出命令放行（TASK-ROCMD-1）',
      ['date', 'date -d @1790000000', 'date -Iseconds', 'stat .', 'file x', 'du -sh .', 'df -h .', 'id', 'whoami', 'uname -a',
       'which node', 'whereis node', 'type ls', 'basename /a/b.txt', 'dirname /a/b.txt', 'printenv PATH',
       'realpath .', 'readlink f', 'md5sum a', 'sha256sum b', 'cksum c', 'base64 -d x', 'od -c x', 'nl x',
       'tac x', 'rev x', 'seq 1 5', 'echo ok', 'printf "%s"', 'sort x.txt'].every(isReadOnlyCommand),
    );
    check(
      '负面参数表：改时钟/写文件/执行面与短旗标簇逃逸全拒（TASK-ROCMD-1，收尾终审处置）',
      ['date -s 12:00', 'date --set 12:00', 'date --set=12:00', 'date -us 12:00', 'sort -o out.txt', 'sort --output=x',
       'sort -ro out.txt', 'sort -ofile', 'file -C x', 'file -bC x', 'git hash-object -w a',
       'git grep -Oless pat', 'git grep --open-in-pager pat', 'git grep --open-files-in-pager pat', 'git grep -nOless pat',
       'git ls-remote --upload-pack=prog .', 'git ls-remote --upload-pack prog .', 'git --exec-path=/tmp/e status',
       'hostname box', 'sleep 5', 'env'].every((c) => !isReadOnlyCommand(c)),
    );
    check(
      'deny 文案白名单概括式（防枚举漂移回潮，TASK-ROCMD-1）',
      !denyMessage('/opt/workflow', 'abc131', 'Bash').includes('ls/grep/wc/cat') && denyMessage('/opt/workflow', 'abc131', 'Bash').includes('READONLY_COMMANDS'),
    );
    // 纯 cd 导航白名单（2026-10-28 内部任务-247，多仓 cwd 漂移逃生通道）：正例绝对路径单参数，
    // 负例覆盖非绝对/复合/展开（详表见 task-lease.test.mjs 同名用例）
    check(
      '纯 cd 导航白名单（DEV-247）',
      isPureCdCommand('cd /root/projects/main') && isPureCdCommand('cd "C:/Program Files/x"')
        && ['cd', 'cd ..', 'cd /a && pwd', 'cd /a; ls', 'cd $(pwd)', 'cd ~', 'cd /a | cat'].every((c) => !isPureCdCommand(c)),
    );
    // gateNote 三放行面（内部任务-247）：③ 并入且首句计数一致（E3/C1 评审处置——断裂文案与
    // 「只有两种」自相矛盾都在此锁死）
    check(
      'gateNote 三放行面计数一致（DEV-247）',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc135', 'Bash');
        return m.includes('Bash 放行面有三种') && m.includes('③纯 cd <绝对路径>') && m.includes('反斜杠路径须单引号') && !m.includes('只有两种');
      })(),
    );
    // F2（内部任务-247）：多键态 deny 头部窗口含执法键短提示；断言锚 cmd 实参形态
    // `--project-root '<键>'`（带引号）——不锚提示行自述文字，防后缀漏拼时测试仍绿的假绿
    check(
      '多键 deny 头部含执法键提示与 --project-root（DEV-247）',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc134', 'Bash', { reason: '挑战未激活（当前令牌尚未声明）' },
          { currentKey: '/w/main', recentKey: null, multiKeyNote: '\n【已签发键清单】…' });
        return m.slice(0, 300).includes('执法键「/w/main」') && m.includes(`--project-root '/w/main'`);
      })(),
    );
    // cd 两段形态（D1）：放行声明用，拒绝第二段非声明命令/带管道
    check(
      'cd 形态放行真脚本',
      isBootstrapDeclareCommand(`cd /nested && node ${join(proj, 'hooks', 'routing-declare.mjs')} tdd --lease ab --task-id T-1`, join(proj, 'hooks', 'routing-declare.mjs')),
    );
    check(
      'cd 盘符形态放行（前斜杠与反斜杠）',
      ['C:/nested', 'C:\\nested'].every((target) =>
        isBootstrapDeclareCommand(`cd ${target} && node ${join(proj, 'hooks', 'routing-declare.mjs')} tdd --lease ab --task-id T-1`, join(proj, 'hooks', 'routing-declare.mjs')),
      ),
    );
    check('cd 形态第二段非声明拒', !isBootstrapDeclareCommand('cd /nested && rm -rf x'));
    check('cd 形态第二段带管道拒', !isBootstrapDeclareCommand(`cd / && node ${join(proj, 'hooks', 'routing-declare.mjs')} tdd | cat`));
    // 写面匹配（协议扩展 2026-09-14）：面内/前缀放行，超面/越界拒，无声明与异常放行。
    // key（canonical 形态，内部任务-MACKEY-1）：scopeViolation 签名即项目键——目标路径
    // 在判定内 canonical 化，键传原始形态（macOS tmpdir symlink）会恒误判越界
    const scoped = { valid: true, lease: { changeScope: ['docs/plans'] } };
    const scopePayload = (fp) => ({ tool_input: { file_path: fp }, cwd: proj });
    check('写面面内放行', scopeViolation(scoped, key, 'Edit', scopePayload(join(proj, 'docs', 'plans', 'x.md'))) === null);
    check('写面前缀放行', scopeViolation(scoped, key, 'Write', scopePayload(join(proj, 'docs', 'plans', 'sub', 'y.md'))) === null);
    check('写面超面拒', scopeViolation(scoped, key, 'Edit', scopePayload(join(proj, 'src', 'a.ts'))) === 'src/a.ts');
    check('写面键外越界拒', scopeViolation(scoped, key, 'Edit', scopePayload(join(home, 'outside.md'))) !== null);
    check(
      '写面键内 .. 文件名面内放行（R2 回归）',
      scopeViolation({ valid: true, lease: { changeScope: ['..draft.md'] } }, key, 'Edit', scopePayload(join(proj, '..draft.md'))) === null,
    );
    check(
      '写面键内 .. 文件名未覆盖按超面拒（R2 回归）',
      scopeViolation(scoped, key, 'Edit', scopePayload(join(proj, '..draft.md'))) === '..draft.md',
    );
    check('写面无声明全仓放行', scopeViolation({ valid: true, lease: {} }, key, 'Edit', scopePayload(join(proj, 'src', 'a.ts'))) === null);
    const evilLease = { valid: true, lease: {} };
    Object.defineProperty(evilLease.lease, 'changeScope', { get() { throw new Error('boom'); } });
    check('写面判定异常放行（fail-open）', scopeViolation(evilLease, key, 'Edit', scopePayload(join(proj, 'src', 'a.ts'))) === null);
    check(
      'deny 写面文案含扩面指引',
      denyMessage('/opt/workflow', 'abc126', 'Edit', undefined, {
        scopeHint: '写面声明未覆盖目标路径 src/a.ts；超面修改须升级计划链，或以 --change-scope 重声明写面。',
      }).includes('--change-scope'),
    );
    // 内部任务-27 批二坑4（阶段复审正确性发现 1 回归锁）：写面越界分支渲染**当前租约实际
    // taskId**（沿用原号扩面重声明）——不得内联「下一个新号」（照抄换号，plan-execution
    // 扩面重声明还过不了 sidecar taskId 一致性校验）。
    check(
      '写面越界分支渲染实际 taskId 而非建议新号',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc126', 'Edit', { valid: true, lease: { taskId: 'DEV-7', skill: 'plan-execution' } }, {
          currentKey: key,
          recentKey: null,
          suggestedTaskId: 'DEV-8',
          scopeHint: '写面声明未覆盖目标路径 src/a.ts；超面修改须升级计划链，或以 --change-scope 重声明写面。',
        });
        return m.includes('--task-id DEV-7') && !m.includes('--task-id DEV-8');
      })(),
    );
    // 内部任务-8（内部规则-18 可审计路径）：null 桶救回标注透出——判据由 lease 结果推导（非调用方
    // 传入字符串，防「自指恒真」）；具名桶救回文案不得带该标注（负向反证，删实现即红）
    const nullBucketLease = { valid: true, viaScan: true, viaNullBucket: true, lease: { skill: 'plan-execution', changeScope: ['src'] } };
    const namedBucketLease = { valid: true, viaScan: true, lease: { skill: 'plan-execution', changeScope: ['src'] } };
    const scopeDenyDiag = {
      currentKey: key,
      recentKey: null,
      bootstrapHint: '',
      authoringHint: '',
      scopeHint: '写面声明未覆盖目标路径 src/a.ts；超面修改须升级计划链，或以 --change-scope 重声明写面。',
    };
    check(
      'null 桶救回标注透出（DEV-8/R-M8-18）',
      denyMessage(join(proj, 'x'), 'abc126', 'Edit', nullBucketLease, scopeDenyDiag).includes('（经 null 桶放行'),
    );
    check(
      '具名桶救回不带 null 桶标注（负向反证）',
      !denyMessage(join(proj, 'x'), 'abc126', 'Edit', namedBucketLease, scopeDenyDiag).includes('经 null 桶放行'),
    );
    // 规划阶段固定写面（内部规则-16，内部任务-5 A组）：authoringViolation 判定输入面；main 侧
    // 接线与文案分流由 node --test 端到端覆盖（routing-gate.test.mjs A组用例）
    const planLease = { valid: true, lease: { skill: 'plan-writing' } };
    const authPayload = (fp) => ({ tool_input: { file_path: fp }, cwd: proj });
    check('规划面内 .md 放行', authoringViolation(planLease, key, 'Edit', authPayload(join(proj, 'docs', 'plans', 'x.md'))) === null);
    check('规划面内子目录 .md 放行', authoringViolation(planLease, key, 'Write', authPayload(join(proj, 'docs', 'plans', 'sub', 'y.md'))) === null);
    check('规划 legacy 目录 .md 放行', authoringViolation(planLease, key, 'Edit', authPayload(join(proj, 'docs', 'superpowers', 'plans', 'h.md'))) === null);
    check('规划 AGENTS 目标拒（authoring）', authoringViolation(planLease, key, 'Edit', authPayload(join(proj, 'AGENTS.md')))?.kind === 'authoring');
    check('规划目录本身拒', authoringViolation(planLease, key, 'Edit', authPayload(join(proj, 'docs', 'plans')))?.kind === 'authoring');
    check('规划非 md 目标拒', authoringViolation(planLease, key, 'Write', authPayload(join(proj, 'docs', 'plans', 'n.txt')))?.kind === 'authoring');
    check('规划面外 .md 拒', authoringViolation(planLease, key, 'Edit', authPayload(join(proj, 'docs', 'other.md')))?.kind === 'authoring');
    check('规划 Bash 不判定（非 shell 沙箱）', authoringViolation(planLease, key, 'Bash', { tool_input: { command: 'rm -rf x' }, cwd: proj }) === null);
    check('非规划租约不受固定上界', authoringViolation({ valid: true, lease: { skill: 'brainstorming' } }, key, 'Edit', authPayload(join(proj, 'src', 'a.ts'))) === null);
    check('plan-review 同受固定上界', authoringViolation({ valid: true, lease: { skill: 'plan-review' } }, key, 'Edit', authPayload(join(proj, 'src', 'a.ts')))?.kind === 'authoring');
    check('规划空数组写面空交集不放行', authoringViolation({ valid: true, lease: { skill: 'plan-writing', changeScope: [] } }, key, 'Edit', authPayload(join(proj, 'docs', 'plans', 'x.md')))?.kind === 'scope');
    check('规划宽面写面不扩权', authoringViolation({ valid: true, lease: { skill: 'plan-writing', changeScope: ['src'] } }, key, 'Edit', authPayload(join(proj, 'src', 'a.ts')))?.kind === 'authoring');
    check('规划键仓外越界拒', authoringViolation(planLease, key, 'Edit', authPayload(join(home, 'outside.md'))) !== null);
    const evilAuthoring = { valid: true, lease: {} };
    Object.defineProperty(evilAuthoring.lease, 'skill', { get() { throw new Error('boom'); } });
    check('规划判定异常放行（fail-open）', authoringViolation(evilAuthoring, key, 'Edit', authPayload(join(proj, 'src', 'a.ts'))) === null);
    check(
      'deny 规划文案含三段流向且无扩面尾句',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc132', 'Edit', undefined, {
          authoringHint: '目标 AGENTS.md 不在规划阶段固定写面（docs/plans 与 docs/superpowers/plans 下的 .md 过程文档）内；',
        });
        return m.includes('plan-writing') && m.includes('plan-review') && m.includes('plan-execution') && !m.includes('--change-scope') && !m.includes('扩面');
      })(),
    );
    // 内部任务-75/IMP-3（内部规则-20 基线写面）：映射表内 skill 的免声明基线面判定——模块内直调锁
    // （端到端信封面由 routing-gate.test.mjs 内部任务-75 三用例承载）。
    const rcLease = { valid: true, lease: { skill: 'root-cause-debugging', taskId: 'DEV-90001' } };
    check('基线面内 .md 放行', floorViolation(rcLease, key, 'Edit', authPayload(join(proj, 'docs', 'plans', 'DEBUG-REPORT.md'))) === null);
    check('基线面 src 代码拒', floorViolation(rcLease, key, 'Edit', authPayload(join(proj, 'src', 'a.ts')))?.rel === 'src/a.ts');
    check('基线面 Bash 不判定（非 shell 沙箱）', floorViolation(rcLease, key, 'Bash', { tool_input: { command: 'rm -rf x' }, cwd: proj }) === null);
    check('非映射 skill 不受基线面', floorViolation({ valid: true, lease: { skill: 'brainstorming' } }, key, 'Edit', authPayload(join(proj, 'src', 'a.ts'))) === null);
    check('基线写面 changeScope 并集扩面', floorViolation({ valid: true, lease: { skill: 'root-cause-debugging', changeScope: ['src'] } }, key, 'Edit', authPayload(join(proj, 'src', 'a.ts'))) === null);
    check('基线写面并集基线面半边（声明代码面后过程文档仍放行）', floorViolation({ valid: true, lease: { skill: 'root-cause-debugging', changeScope: ['src'] } }, key, 'Edit', authPayload(join(proj, 'docs', 'plans', 'DEBUG-REPORT.md'))) === null);
    const evilFloor = { valid: true, lease: {} };
    Object.defineProperty(evilFloor.lease, 'skill', { get() { throw new Error('boom'); } });
    check('基线判定异常放行（fail-open）', floorViolation(evilFloor, key, 'Edit', authPayload(join(proj, 'src', 'a.ts'))) === null);
    check(
      'deny 基线文案含补声明指引与实际 taskId',
      (() => {
        const m = denyMessage('/opt/workflow', 'abc133', 'Edit', { valid: true, lease: { skill: 'root-cause-debugging', taskId: 'DEV-90001' } }, {
          floorHint: '目标 src/a.ts 不在当前 skill（root-cause-debugging）的基线写面（docs/plans 与 docs/superpowers/plans 下的 .md 过程文档）内，且不在 --change-scope 声明面内；',
        });
        return m.includes('基线写面') && m.includes('--change-scope') && m.includes('DEV-90001') && m.includes('沿原任务号');
      })(),
    );
  } finally {
    if (prevDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevDir;
    if (prevTtl === undefined) delete process.env.WF_ROUTING_TTL_MS;
    else process.env.WF_ROUTING_TTL_MS = prevTtl;
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL routing-gate.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK routing-gate.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

/**
 * 主入口：解析负载 → 项目键 → 租约判定 → 放行（静默）/ bootstrap 放行 / deny（信封+退出 2）。
 * @returns {Promise<void>}
 */
async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // 负载非法：fail-open，无输出
  }
  const toolName = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (familyOf(toolName) === 'other') {
    process.exit(0); // 非本闸管辖工具族（只读/宿主控制面）：静默放行（内部规则-17 工具族归一，内部任务-8）
  }
  const key = deriveGateKey(toolName, payload);
  if (!key) process.exit(0); // 激活域外：整套静默放行（无租约判定/无 bootstrap/无 deny/无 lease-deny 留痕，内部决策-022）
  const sessionId =
    typeof payload?.session_id === 'string' && payload.session_id
      ? payload.session_id
      : typeof payload?.sessionId === 'string' && payload.sessionId
        ? payload.sessionId
        : null;
  // 内部任务-244 A01：委派会话 deny 指引——读 delegation_depth/parent_session_id，按父链已签发
  // 台账解析交付任务号（可解析内联继承号；不可解析则零具体号＋回报父会话指引）。
  const delegationDepth = Number.isSafeInteger(payload?.delegation_depth) && payload.delegation_depth > 0 ? payload.delegation_depth : 0;
  const parentSessionId =
    typeof payload?.parent_session_id === 'string' && payload.parent_session_id
      ? payload.parent_session_id
      : typeof payload?.parentSessionId === 'string' && payload.parentSessionId
        ? payload.parentSessionId
        : null;
  const delegated = delegationDepth > 0;
  let inheritedTaskId = null;
  if (delegated && parentSessionId) {
    try {
      const resolved = resolveInheritedTaskId(key, parentSessionId, delegationDepth);
      if (resolved.ok) inheritedTaskId = resolved.taskId;
    } catch {
      /* fail-open：解析失败走零具体号指引 */
    }
  }
  const lease = readActiveLease(key, Date.now(), { sessionId });
  // 规划阶段固定写面（内部规则-16，内部任务-5 A组 2026-10-06）：仅租约 valid 时判定，置于下方
  // valid 快返之前——plan-writing/plan-review 的 Edit/Write 先过 PLAN_DIRS 固定上界
  // （与 changeScope 逻辑 AND）；Bash、非规划租约、判定异常均返回 null → 不影响放行
  // （fail-open 姿态不破）。legacy 规划租约（skill 字段一直在）经同一 lease 对象同检。
  const authoringDeny = lease.valid ? authoringViolation(lease, key, toolName, payload) : null;
  // skill 基线写面（内部规则-20，内部任务-75/IMP-3）：仅租约 valid 时判定——映射表内 skill 的
  // Edit/Write 须落基线面 ∪ changeScope（并集可扩）；Bash、非映射 skill、判定异常均返回
  // null → 不影响放行（fail-open 姿态不破）。legacy 租约（skill 字段一直在）同检。
  const floorDeny = lease.valid ? floorViolation(lease, key, toolName, payload) : null;
  // 映射表内 skill 须跳过通用写面判定（内部规则-20 并集单点化，内部任务-75 评审发现 1 修复）：
  // 通用判定只认声明面，与并集判定叠加会把基线面目标（如 DEBUG REPORT）反向吊销成
  // AND——并集语义=基线面免声明可用 + 声明面显式扩面，由 floorViolation 独立承载。
  let floorSkill = false;
  try {
    floorSkill = lease.valid ? SKILL_WRITE_FLOOR[lease?.lease?.skill] !== undefined : false;
  } catch {
    floorSkill = false; // 租约字段异常读取按无映射处理（fail-open，floorViolation 同口径）
  }
  // 写面判定（协议扩展 2026-09-14）：仅租约 valid 时进行，Edit/Write 超面即拦；
  // Bash、无写面声明、判定异常均返回 null → 放行（fail-open 姿态不破）
  const scopeDeny = lease.valid && !floorSkill ? scopeViolation(lease, key, toolName, payload) : null;
  // 项目 skill 消费义务（内部决策-070 D5，内部任务-341）：必载集合未 ack 时兜底拦截（仅 Edit/Write；仅 valid；判定异常 fail-open）
  const projectSkillDeny = lease.valid ? projectSkillViolation(lease, key, toolName) : null;
  // 内部任务-8 任务 4.3（内部规则-19 ②）：有效租约命中即心跳续期（claim/active 同更、TTL/3 节流、
  // 异常吞掉 fail-open）——活跃会话不断气，死会话按 TTL 自然退出；对 deny 路径零影响
  if (lease.valid) heartbeatLease(lease.lease);
  if (lease.valid && scopeDeny === null && authoringDeny === null && floorDeny === null && projectSkillDeny === null) process.exit(0); // 持当前租约且写面覆盖（或无写面声明）：静默放行

  // 内部未决-91（内部任务-48）：取根收敛至 hook-lib.pluginRootDir 单点（自身位置优先 + 存在性校验，
  // marker=声明脚本自身）——原 env-only 取根在 env 缺席时直接静默放行整闸（下方「拿不到
  // 插件根就无法给出声明命令」的 fail-open 门），收敛后 env 缺席而自身位置有效时照常执法
  // （行为变更登记于 内部规则-7；四宿主生产路径 env 恒设，实际面不变，仅手工裸调场景翻转）。
  const root = pluginRootDir(DECLARE_REL);
  const cmd =
    typeof payload?.tool_input?.command === 'string'
      ? payload.tool_input.command
      : typeof payload?.command === 'string'
        ? payload.command
        : '';

  // Bash bootstrap：健康负载下仅放行严格解析的声明命令（单条或纯声明顺序拼接；脚本路径钉死到本插件）
  if (familyOf(toolName) === 'shell' && root) {
    const expectedScript = join(root, DECLARE_REL);
    if (isBootstrapDeclareCommand(cmd, expectedScript)) process.exit(0);
  }
  // Bash 只读白名单（2026-09-16 使用反馈批次 P8，内部决策-3「研究自由不设硬门」在 Bash 侧
  // 的落地）：无租约时的只读命令（清单见 task-lease-lib.mjs READONLY_COMMANDS/READONLY_GIT_SUBCOMMANDS）静默放行、不落 lease-deny
  // 留痕——只读用法被整闸拦下与「只读工具不经闸」的口径不一致（用户实测坑 P8）。
  // 纯 cd 导航（2026-10-28 内部任务-247）：第三放行面——多仓 cwd 漂移的逃生通道（纯 cd 无文件/
  // 执行面，词法底线同白名单；绝对路径单参数，判定=isPureCdCommand）。
  if (familyOf(toolName) === 'shell' && (isReadOnlyCommand(cmd) || isPureCdCommand(cmd))) process.exit(0);

  if (!root) process.exit(0); // 拿不到插件根就无法给出声明命令：fail-open 放行
  // B2 闸 deny 自留痕（2026-09-13 加固批次）：闸是唯一知道「租约异常正在发生」的组件，
  // 异常态必须进 incident（id=会话+原因+键摘要+分钟桶，读侧幂等——deny 风暴不刷记录）。
  // 键按 内部规则-2 只存 digest 不落路径明文；根取 cwd 仓而非文件所属仓（评审 C5：横幅/
  // Stop 汇总按 cwd 仓读，落文件仓则嵌套仓场景会话看不到自己制造的 deny）。
  // 2026-09-15 激活域批次修订：cwd 非仓而文件在仓时，cwd 的 projectKey 会退化为非仓
  // 目录自身——落执法键（文件仓）而非在非仓 cwd 制造 .workflow 垃圾（内部决策-022；
  // 该记录同时处于声明自愈可达的根上）。
  // appendIncident 契约即写失败返回 {ok:false} 不抛（评审 S5：不设不可达 try/catch）。
  const kd = digestOf([String(key)]);
  // 留痕 reason 分流（内部规则-16）：规划阶段固定上界越界与通用写面拒在留痕面即可区分
  // （待排查时能看出是阶段边界执法而非 scope 配置问题）；空交集属写面语义
  const reason = String(
    lease.reason ??
      (authoringDeny !== null
        ? authoringDeny.kind === 'authoring'
          ? '规划阶段固定写面未覆盖目标'
          : '写面声明为空数组（与规划固定写面空交集）'
        : floorDeny !== null
          ? 'skill 基线写面未覆盖目标'
          : scopeDeny !== null
            ? '写面未覆盖目标路径'
            : projectSkillDeny !== null
              ? '项目 skill 必载项未 ack'
              : 'unknown'),
  );
  // deny 路径统一的负载 cwd（阶段复审归一：denyRoot 与 D3 清单采集共用，不再两处内联三元式）
  const payloadCwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const denyRoot = activationRoot(payloadCwd) ?? key;
  const denyDigest = digestOf(['lease-deny', reason, kd]);
  const sessKey = sessionId ?? 'default'; // 与 task-recap 读侧/post-tool 口径一致（评审 C3：'null' 会被 Stop 过滤漏掉）
  // 内部任务-342（内部决策-066 修正案 2 内部模块-1）：记录归因 taskId/skill 仅认本会话具名桶**有效**租约；闸判定仍用
  // 已读 lease（不二次读、不换键，可见性/补签语义不变）。null 桶/他会话/失效租约 → 归因字段 null。
  const ownLease = lease.valid === true ? ownNamedLease(lease.lease, sessionId) : null;
  // 同一次 deny 执法上下文（lease-deny 与 lease-loop 两种 kind 共享，防逐字段拷贝漂移）
  const denyCtx = {
    ts: Date.now(),
    session: sessKey,
    taskId: typeof ownLease?.taskId === 'string' ? ownLease.taskId : null,
    skill: typeof ownLease?.skill === 'string' ? ownLease.skill : null,
    plugin: 'workflow',
    tool: toolName,
    event: null,
  };
  const denyWrote = appendIncident(denyRoot, {
    ...denyCtx,
    id: `ld-${digestOf(['lease-deny', sessKey, reason, kd, Math.floor(Date.now() / 60000)])}`,
    kind: 'lease-deny',
    digest: denyDigest,
    // 内部模块-15 v2 写者接线（评审修复 N5）：deny 留痕同批带分类字段（cause=mechanism-trace），
    // 供 cause 派生待排查与 retro 分类面直接消费；全部为加法字段，既有字段与执法行为零变更。
    ...classifyFact({ kind: 'lease-deny' }, loadRules()),
    observationSource: 'hook:routing-gate',
  });
  if (!denyWrote.ok) noteHookIssue('routing-gate', 'ledger-write-failed'); // 内部任务-244 E01
  // lease-loop 升级（内部任务-LEASEGATE-1 F3，内部规则-13 ④）：同 (session,digest) 窗内已有 ≥2 条
  // resolved 的 lease-deny 行——open→resolved 反复振荡即机制异常/死循环信号（声明自愈把振荡
  // 归零，人可见通道曾被静默吞掉）——追加不可自愈的升级记录：自愈调用面（routing-declare）
  // 仅 lease-deny/bootstrap-reissue，lease-loop 刻意排除、保持 open、计入待排查指针，
  // task-recap 对该 kind 无视会话匹配强制显示。阈值 2 固定不设缝（防误调放大静默）。
  // fail-open 姿态：reopensWithin 全路径返数值、appendIncident 返 {ok:false}，均不抛——
  // 不设兜底 try/catch（评审 S5 口径），升级缺席不反噬 deny 主职责。
  if (reopensWithin(denyRoot, { kind: 'lease-deny', digest: denyDigest, session: sessKey, windowMs: loopWindowMs() }) >= 2) {
    const loopWrote = appendIncident(denyRoot, {
      ...denyCtx,
      id: `ll-${digestOf(['lease-loop', sessKey, denyDigest])}-${Math.floor(Date.now() / 60000)}`,
      kind: 'lease-loop',
      digest: digestOf(['lease-loop', denyDigest]),
      // 内部模块-15 v2 写者接线（评审修复 N5）：lease-loop 恒得 cause=mechanism-escalation（规则表
      // r-lease-escalation）——「升级信号恒计入待排查」不变量由分类字段显式承载，不依赖读侧回退。
      ...classifyFact({ kind: 'lease-loop' }, loadRules()),
      observationSource: 'hook:routing-gate',
    });
    if (!loopWrote.ok) noteHookIssue('routing-gate', 'ledger-write-failed'); // 内部任务-244 E01
  }  // deny 文案按观察会话解析本轮令牌（内部决策-018：会话桶→null 桶→legacy 三级）；
  // 键控诊断数据（坑 1/2）无条件采集，是否呈现由 denyMessage 按失效原因单点判定
  // ——「无有效态」家族两 reason（状态缺失或损坏/挑战未激活）同挂（内部任务-LEASEATT-1）
  const cur = currentChallengeToken(key, sessionId);
  // 内部任务-24 D3：双/多键工作区逐键清单——「无有效态」家族且本轮签发键数>1 才呈现（单键
  // 工作区清单=纯噪音）；键集与签发严格同源（issuanceKeys 单源迁 lib，D3）；整段
  // fail-open，清单失败不反噬 deny 主职责。挂 deny 文案尾部（头部窗口保留可执行声明
  // 命令，P7 截断教训）。
  let multiKeyNote = '';
  try {
    if (isNoValidStateFamily(lease.reason)) {
      const issuedKeys = issuanceKeys(payloadCwd);
      if (issuedKeys.length > 1) {
        const lines = leaseStatusOfKeys(issuedKeys, Date.now(), { sessionId }).map((r) => {
          const st = r.state === 'declared' ? '已声明' : r.state === 'issued' ? `已签发未声明（令牌 ${r.tokenShort}…，取该键租约行全量）` : '无挑战';
          const mark = r.key === key ? '（本操作执法键）' : '';
          return `  - ${String(r.key).replaceAll('\\', '/')}：${st}${mark}`;
        });
        multiKeyNote =
          `\n【已签发键清单】本 prompt 签发的全部键与逐键声明状态：\n${lines.join('\n')}` +
          `\n（多仓工作区逐键各有租约行与令牌；被拦操作按执法键判定——须用「${String(key).replaceAll('\\', '/')}」本轮令牌完成声明）`;
      }
    }
  } catch {
    /* 清单采集 fail-open */
  }
  // 内部任务-103 F2（内部任务-111 修复，2026-10-16）：STATE_MISSING 的「从未签发」文案判据采集——键上
  // 是否实际持有有效租约（不分桶全可见，newestActiveLease 补签前置同款口径）。采集门与
  // denyMessage 渲染门共用单点谓词 isNeverIssuedWindow；readActiveLease 已 invalid ⇒ 观察侧
  // 可见集内无有效租约，全可见扫描再命中 ⇒ 租约只在不可见桶。newestActiveLease 契约整体
  // try/catch 失败归 null（目录缺失/坏 JSON）＝无判据 → 原文案（fail-open 于诊断面，不反噬
  // deny 主职责）——契约不抛故不设兜底 try/catch（appendIncident/lease-loop 评审 S5 同口径）；
  // 写面 deny（lease.valid 无 reason）不进采集门，零额外扫描开销。
  const recentKey = recentDeclaredProjectKey(sessionId);
  const hiddenLease = isNeverIssuedWindow(lease.reason, recentKey) ? newestActiveLease(key, Date.now()) : null;
  const otherBucketLease = hiddenLease
    ? {
        observerNamed: sessionId !== null,
        taskId: typeof hiddenLease.taskId === 'string' ? hiddenLease.taskId : null,
        skill: typeof hiddenLease.skill === 'string' ? hiddenLease.skill : null,
      }
    : null;
  const diag = {
    currentKey: key,
    recentKey, // 提为局部 const（内部任务-111：与 otherBucketLease 采集门共用同一三态值）
    // 内部任务-27 批二坑4：恰一条域建议时 deny 命令模板内联可照抄号（与租约行单源）；
    // 采集失败/多域为 null → 占位符保持（fail-open；零域态经默认域兜底恰单建议，内部任务-75）。
    // 内部未决-103（内部任务-52）：传观察会话标识排除自身未过期占用（与租约行同口径）。
    suggestedTaskId: delegated
      ? null // 内部任务-244 A01：委派会话不得给出自取建议号
      : (() => {
          try {
            return soleTaskIdSuggestion(key, { excludeSessionId: sessionId });
          } catch {
            return null;
          }
        })(),
    delegated,
    inheritedTaskId,
    bootstrapHint: familyOf(toolName) === 'shell' ? bootstrapRejectHint(cmd) : '',
    // 规划上界提示（内部规则-16）：置于 scopeHint 之前由 denyMessage 呈现——阶段越界不是
    // 写面配置问题，扩面重声明解不了固定上界，文案不引导以 --change-scope 绕过
    authoringHint:
      authoringDeny !== null && authoringDeny.kind === 'authoring'
        ? `目标 ${authoringDeny.rel} 不在规划阶段固定写面（docs/plans 与 docs/superpowers/plans 下的 .md 过程文档）内；`
        : '',
    // 基线写面提示（内部规则-20，内部任务-75）：置于 scopeHint 之前呈现——主信息是该 skill 的
    // 免声明基线面语义与补声明出路（沿原任务号重声明扩面，scopeHint 先例渲染实际 taskId；
    // 与 scopeHint 双违规时本分支先行呈现，补声明出路同义不重复渲染）
    floorHint:
      floorDeny !== null
        ? `目标 ${floorDeny.rel} 不在当前 skill（${typeof lease.lease?.skill === 'string' ? lease.lease.skill : '<未知>'}）的基线写面（docs/plans 与 docs/superpowers/plans 下的 .md 过程文档）内，且不在 --change-scope 声明面内；`
        : '',
    // 写面提示（仿 bootstrapHint 先例）：超面/越界时点名未覆盖路径并给出扩面出路；
    // 规划租约空数组写面（与上界空交集）同走通用写面语义——重声明写面是正确出路
    scopeHint:
      scopeDeny !== null
        ? `写面声明未覆盖目标路径 ${scopeDeny}；超面修改须升级计划链，或以 --change-scope 重声明写面。`
        : authoringDeny !== null && authoringDeny.kind === 'scope'
          ? `写面声明为空数组（与规划固定写面空交集），目标 ${authoringDeny.rel} 不在声明面内；以 --change-scope 重声明写面。`
          : '',
    // 内部决策-070 D5（内部任务-341）：项目 skill 必载集合未 ack 时点名缺项与加载路径（denyMessage 专用分支）
    projectSkillHint:
      projectSkillDeny !== null
        ? {
            missing: projectSkillDeny.missing.map((sk) => sk.name),
            required: projectSkillDeny.required.map((sk) => ({ name: sk.name, path: sk.path })),
          }
        : null,
    // 内部任务-103 F2（内部任务-111）：「从未签发」文案分流判据（采集语义见上方采集块注释）
    otherBucketLease,
    // 内部任务-24 D3：双/多键工作区逐键声明状态清单（呈现条件与采集语义见上方采集块单点注释）
    multiKeyNote,
  };
  const denyText = denyMessage(root, cur ? cur.leaseId : null, toolName, lease, diag);
  // 内部任务-244 A01：委派会话前缀（可解析内联继承号；失败零具体号+回报父会话指引；顶层逐字节不变）
  const delegPrefix = delegated
    ? inheritedTaskId
      ? `【委派会话】委派子会话（depth=${delegationDepth}）：声明命令须内联父链交付任务号 ${inheritedTaskId}，禁止自取新号。`
      : '【委派会话】委派子会话且父链交付任务号不可解析——停止写操作，回报父会话；由父会话先声明交付任务号后重新派发（禁止同轮重试与自取新号）。'
    : '';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        systemMessage: delegPrefix ? `${delegPrefix}${denyText}` : denyText,
      },
    }) + '\n',
  );
  process.exit(2);
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
    process.exit(selftest()); // selftest 失败须可见退 1：陷阱不装（评审 P1，B-M8-4 优先）
  }
  installHookErrorTrap('routing-gate'); // B1①：漏网抛错落 hook-errors.jsonl（fail-open 不破）
  runHookMain('routing-gate', main);
}
