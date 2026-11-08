// 文件：task-lease-lib.mjs
// 描述：per-session capability 任务租约协议的单一事实源（内部决策-018 / 内部规则-8）——
//       UserPromptSubmit（挑战签发）、routing-declare（租约激活）与 routing-gate
//       （shell/edit 族放行；工具族归一表见 scripts/lib/tool-families.mjs，内部任务-8 内部规则-17）三方共享同一份键控/有效性语义。
//       协议：leaseId 即 bearer capability——挑战按 token 索引并保存签发时 sessionId，
//       current[project, sessionId|null] 指针决定会话桶内当前挑战；声明凭 leaseId
//       反查 challenge 得 sessionId，激活写入 active-<token>；闸按 hook 负载 sessionId
//       解析会话桶（会话桶→null 桶→legacy 三级回退）校验。语义=会话内单活、会话间并行；
//       任一侧会话标识不可见时回退 null 桶（新旧并存不迁移）。
//       2026-09-22（内部任务-LEASEGATE-1，内部决策-018 修正案）：宿主负载 session_id 可见性按事件
//       漂移实录（同键 null+多会话桶并存、null 桶被他会话激活）——原「null 桶=项目级单活
//       +轮换即吊销」在共享桶上构成跨会话越权吊销，null 桶改弱形态：轮换不吊销，挑战/激活
//       按 TTL 自然过期（sweep 兜底清扫），会话桶维持强形态；readActiveLease 增扫描回退
//       （指针路径失守后按隔离口径扫本项目激活租约），签发/校验桶漂移下已声明租约仍可达
//       （桶对称化）；连带语义：null 桶旧 token TTL 内可再激活（激活仍需 token 知情）。
//       capability 义务（内部决策-018 决策 4）：熵 randomBytes(16)；作用域单项目；TTL 缺省
//       **60min**（内部决策-045/内部任务-96 2026-10-15 起——活动滑动锚〔PostToolUse 心跳＋宽限复活〕
//       下死会话阻塞窗口 ≤1 个 TTL 且较声明锚更精确；原 45min〔内部任务-8 任务 4.6〕、更早 6h；
//       WF_ROUTING_TTL_MS 覆盖不变）；同 token 重复激活=幂等覆盖（last-writer-wins，
//       显式不加锁——共享 tmpdir 加锁引入死锁面）；跨会话重放结构性无效（激活只写签发方会话桶）；
//       存储卫生=任何输出仅 token 前 8 位；签发时清理过期状态索引（内部任务-8 任务 4.4 扩为全目录）。
//       兼容：无 schemaVersion 的旧 v2 项目级状态（wf-lease-challenge-<digest>.json /
//       wf-lease-active-<digest>.json，digest 16 位 hex，与 token 32 位 hex 文件名不撞）
//       按 null 桶 legacy 校验。
//       2026-09-13（嵌套仓修复）：Edit/Write 键控按文件路径推导 + deny 键控诊断（跨键差异/
//       签发 hook 未运行）+ bootstrap 元字符提示；工具级键控选择在 routing-gate.deriveGateKey，
//       本文件保持协议语义单一事实源。
//       2026-09-14（协议扩展，内部决策-020）：activateLease 增 changeScope（写面声明——闸侧
//       2026-09-15（闸/文案批，内部未决-10/13）：cd 两段正则补双引号分支（含空白目标须
//       "…" 包裹、限绝对路径起笔、引号内禁 "/$/反引号——bash 展开面）；bootstrapRejectHint
//       补 cd 专项指引（目标未匹配时引导双引号，不误指复合命令）。
//       仅对 Edit/Write 执行，Bash 维持整闸）与 exemptSrc（豁免来源标注：user=用户当轮
//       消息原文，preauthorized=事前授权已显式记录；先例不构成豁免来源）可选入参，
//       均在库内复验（不信任调用方）；**schemaVersion（内部任务-227/内部决策-061 起）：challenge 恒 5
//       （委派三可选字段），current/active/claim 维持 4**；v4 存量读侧零校验兼容（见 hostOf）。
//       2026-10-23（内部任务-227，内部决策-061）：挑战体 v5＋委派继承（issued 台账解析/继承声明不写
//       claim 占位）＋占用集 `{used,bySource,degraded}`/fail-loud＋受理侧历史占用校验＋
//       `--resume-task`/`--manual-task-id` 受控通道＋内部决策-050 D2 探测失败保守回池。
//       2026-10-24（内部任务-190，内部决策-061 决策 2/内部规则-25 语义）：git 历史探测前置项目根三态判定
//       （classifyGitRootPresence）——根不存在/非目录＝源缺席 absent（spawn 前短路、零 spawn、
//       不置 degraded），根不可读（EACCES/EIO/ELOOP）仍 degraded 交既有 fail-loud；修复 macOS
//       上 `git -C <不存在根>` 的平台文案被误判 degraded 的回归（T-1/T-2 回归锁）。
//       2026-10-11（内部任务-41，FIX-3 承接）：签发自纠面——签发侧挑战台账（wf-challenges-*
//       逐签发追加 leaseId/sessionId/root，读侧 findChallengeIssuance）+ activateLease
//       absent 拒因二分（旧轮已失效 vs 从未签发）+ 内联键内在位挑战短令牌
//       （currentChallengeShort）——「旧轮/失真令牌声明→整轮报废」的轮内自纠出口。
//       2026-10-14（内部任务-75/IMP-4，内部规则-8）：取号零域态回落内置默认域集 DEFAULT_DOMAINS
//       =['DEV']（恰单域保 soleTaskIdSuggestion 内联建议开箱可用；结果增 usedDefaultDomains
//       标记供查询面附注——旧「零域输出教育指引」形态废止，内部工作流状态 仍为
//       唯一显式定制点）。
//       2026-10-16（内部任务-117，用户裁决「按项目发号、从 1 起、绝不跳号」）：取号建议改稠密
//       语义——denseSeqOfDomain 取占用集上最小未用（occupiedSeqsOfDomain 单源：git 同步源
//       ∪未过期 claim/active，过期回池）；发号台账退占用集、降级为纯审计轨迹（写入保留），
//       弃任务号不再永久烧号；跨机/久闲置同号窗口由 内部决策-045 让号协议承接。
//       内部任务-342（2026-11-06）：新增 ownNamedLease/leaseContextOfOwn/releaseClaimEx；leaseContextOf 标 deprecated——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 注入缝：WF_ROUTING_STATE_DIR（状态目录，测试隔离）、WF_ROUTING_TTL_MS（TTL 毫秒）。
//       TTL/skill 名正则/状态目录等共享原语从 routing-lib 复用（单一事实源，不留双份拷贝）。
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { DEFAULT_TTL_MS, SKILL_NAME_RE, ttlMs, stateDir, stateRootFor, projectKey, canonicalRoot, isMarkerRoot, gitAncestor, activationRoot, workspaceRootAnchor } from './routing-lib.mjs';
import { digest16, noteHookIssue } from './hook-lib.mjs';
import { EXEMPT_SCOPES, checkExemptDeclarationShape } from '../scripts/lib/exempt-protocol.mjs';
import { appendIncident, digestOf, normalizeSession } from '../scripts/lib/incident-store.mjs';
import { hostOf } from '../scripts/lib/host-detect.mjs';
import { spawnGitSync, isNotARepoStderr, isEmptyRepoStderr } from '../scripts/lib/git-exec.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';

export { DEFAULT_TTL_MS, SKILL_NAME_RE, ttlMs, stateDir };
// 宿主 token 探测单源（内部决策-063 修正案 3 决策 19）：实现移入 scripts/lib/host-detect.mjs，
// 本库**原样再导出**——各钩既有 `import { hostOf } from './task-lease-lib.mjs'` 调用点零改动，
// 同时消灭本地第二张探测表（旧表只有 DSH_/ZCODE_ 两前缀，Kimi/MCode 会被误判）。
export { hostOf };

/**
 * 租约拒因短语单一来源（内部任务-8 任务 5.3，内部规则-19 ⑥）：库层以「常量短语 + 补充文案」拼接，
 * 闸侧 `denyMessage` 的精确/前缀分流引同一常量集——两边文案不得各自硬编码（防漂移）。
 * 短语字面与既有文案**逐字一致**（纯迁移，不改正文）。前四项为前缀形态（完整文案附补充），
 * 其余为精确匹配形态（闸侧按 `===` 分流）。
 * 成员＝计划 5 短语（NO_CHALLENGE / EXPIRED_CHALLENGE / PROJECT_MISMATCH / DANGLING_POINTER /
 * UNACTIVATED）∪ 闸侧三处分流所需操作数（STATE_MISSING / OTHER_SESSION）∪ 读侧其余拒因
 * （ROTATED / LEASE_EXPIRED / TIME_ANOMALY，门 B F5 处置：消灭同文件内裸字面量自重复）。
 */
export const LEASE_REASONS = Object.freeze({
  NO_CHALLENGE: '无有效挑战',
  EXPIRED_CHALLENGE: '挑战已过期',
  PROJECT_MISMATCH: '挑战与本项目不匹配',
  DANGLING_POINTER: '指针悬空',
  UNACTIVATED: '挑战未激活（当前令牌尚未声明）',
  STATE_MISSING: '状态缺失或损坏',
  OTHER_SESSION: '租约属其他会话',
  ROTATED: 'prompt 已轮换',
  LEASE_EXPIRED: '租约已过期',
  TIME_ANOMALY: '状态时间异常（未来时间）',
});

/** 任务号合法形态（内部未决-76 域前缀，2026-10-05；内部决策-045/内部任务-96 扩可选维护者段）：
 * `<域码>-<序号>`（默认命名空间）或 `<域码>-<维护者码>-<序号>`（三段——维护者码 2-4 位
 * 大写字母同域码形态，段数二义消解：序号恒纯数字）；旧 TASK- 系形态为历史存量：读侧（存量
 * 租约/incident/exemption/sidecar 等值比较）零校验继续兼容，自本批起不再接受新声明（旧号
 * 不回填，从下一个任务起各域用前缀号）。 */
export const TASK_ID_FORM_RE = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{1,6}$/;
/** 兼容别名：既有消费点 import 名零改动（routing-declare 校验 / activateLease 复验 / selftest）。 */
export const TASK_ID_RE = TASK_ID_FORM_RE;

/**
 * 补签冷/热分诊句（内部任务-36/内部任务-122）——「拒因/闸附注/补签成功输出/USAGE 四面同口径」
 * （内部规则-8）的唯一载体：四方引用本常量，同口径由构造保证（终审简洁性发现处置——原五份
 * 手写近拷贝已现措辞漂移）。撞号 deny 的 selfHint 是另一语境变体（已发生阻断的分诊
 * 提示，含 incidents.jsonl 读法），不并此源。
 */
export const REISSUE_TRIAGE_NOTE =
  '冷/热分诊（DEV-36/DEV-122）：冷恢复（该 task 的 claim 已全过期）补签令牌可直接声明；同 task 热续期（具名 claim 仍存活）null 令牌不可用于同号重声明——出路＝等下一条用户消息的具名令牌，或 --release --session <会话id>／--release --all-sessions 释放后重声明';

/**
 * domains.json 零域态两途引导（内部决策-050 D3，内部任务-62——用户裁决「重要文件不静默」）：
 * 三挂点单源文案（租约行后独立行／声明成功输出尾行／--suggest-task-id 查询面，REISSUE_
 * TRIAGE_NOTE 四方引用先例）。两途＝自建（schema 样例）或授权 agent 代建（hook 非交互，
 * 授权后代建经正常编辑工具进行、全程可见）。触发面＝零域态（见 visibilityHints）。
 */
export const DOMAINS_SETUP_HINT =
  '【域声明引导】本仓以内置默认域 DEV 兜底（零域态）——可自建 .workflow/domains.json（schemaVersion 1，如 {"schemaVersion":1,"domains":["DEV"]}）定制域集，或回复「授权代建 domains.json」由我经正常编辑工具创建（hook 非交互，授权后代建全程可见）。';

/**
 * 零域态引导触发判定＋去重（内部决策-050 D3，内部任务-62）：domains.json 缺席且无可推断域才触发
 * （已声明/可推断域在场＝条件恒假，永不再触发——条件先行优于状态标记）；去重窗＝
 * `内部工作流状态` 机器本地 `{schemaVersion,domainsHintAt}`，缺省 24h，
 * `WF_SETUP_HINT_TTL_MS` 注入缝（测试可控）；窗口内已提示过即不再触发（触发即标记，
 * 三个挂点谁先到谁标记）。标记写失败仍触发（fail-open——可见性优先于去重）。
 * @param {string} key 项目键
 * @param {{ttlMs?: number}} [opts] 测试注入窗长
 * @returns {{domains: boolean}} true=应注入引导
 */
export function visibilityHints(key, opts = {}) {
  try {
    if (repoDomains(key) !== null) return { domains: false };
    if (inferDomainsCached(key).length > 0) return { domains: false };
    const stateFile = join(canonicalRoot(String(key)), '.workflow', 'setup-hints.json');
    const ttlRaw = Number(opts.ttlMs ?? process.env.WF_SETUP_HINT_TTL_MS);
    const ttl = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : 24 * 60 * 60 * 1000;
    const st = readJson(stateFile);
    if (st === null || !(Number(st?.domainsHintAt) > 0 && Date.now() - Number(st.domainsHintAt) < ttl)) {
      try {
        atomicWrite(stateFile, { schemaVersion: 1, domainsHintAt: Date.now() });
      } catch {
        /* 标记失败仍触发（fail-open） */
      }
      return { domains: true };
    }
    return { domains: false };
  } catch {
    return { domains: false }; // fail-open：引导不阻断任何主链路
  }
}

/** 域码形态（与 TASK_ID_FORM_RE 前段同源）：2-4 位大写字母。 */
const DOMAIN_RE = /^[A-Z]{2,4}$/;

/** 维护者码形态（内部决策-045，内部任务-96）：与域码同形态 2-4 位大写字母——三段号第二段。 */
const MAINTAINER_RE = /^[A-Z]{2,4}$/;

/** 内置默认域集（内部任务-75/IMP-4，内部规则-8 零域默认域兜底）：无仓域声明且无可推断域的仓取号
 * 回落——恰单域保 soleTaskIdSuggestion 内联建议开箱可用（免手工建域文件/显式 --domain
 * 前置）；内部工作流状态 仍为唯一显式定制点（插件不代写消费者仓跟踪文件——多域
 * 默认会令内联建议退 null 回到手动取号，与「避免手动触发」诉求冲突，如需多域默认属新决策）。 */
const DEFAULT_DOMAINS = ['DEV'];

/** 任务号捕获组（nextSeq/inferDomainsFromRepo 按捕获组比对域，不拼接动态 RegExp）。
 * 内部决策-045/内部任务-96：可选维护者段——m[1]=域码/m[2]=维护者码（三段时在场，二段 null）/m[3]=序号。 */
const DOMAIN_TASK_RE = /^([A-Z]{2,4})(?:-([A-Z]{2,4}))?-(\d{1,6})$/;

/** 平铺计划文件名内的嵌入式任务号 token（内部任务-37）：`2026-10-06-dev5-*.md` 的 dev5、
 * `2026-10-09-内部任务-27-*.md` 的 内部任务-27——仅作用于 docs/plans 平铺条目名（toUpperCase 后
 * matchAll 逐 token 提取，matchAll 内部克隆正则、模块级 /g 无 lastIndex 污染）；左边界
 * 捕获组＝词首锚（内部模块-8 §A 例外条同款形态，非 lookbehind），挡 `webdev42` 类词内子串；
 * 序号 >999999 由调用方跳过（与 DOMAIN_TASK_RE 的 {1,6} 上限一致）。仅计数面消费
 * （occupiedSeqsOfDomain），域推断面排除（inferDomainsFromRepo 过滤 plansFlat——防 `open76-*`
 * 类 slug 产幻域，契约见 内部规则-8 数据源句〔内部任务-81 归档 manifest 源并入〕）。 */
const FLAT_TASK_TOKEN_RE = /(^|[^A-Z])([A-Z]{2,4})(?:-([A-Z]{2,4}))?-?(\d+)/g;
// 导出（内部任务-57/内部未决-125）：冻结样本表哨兵消费——FLAT 域归属漂移样本的正主
// （内部任务-WP-96 旧版计 WP 域/新版计 DEV 域带维护者段）。导出 source 而非正则本体：
// 带 g 旗正则共享会互相污染 lastIndex。
export const FLAT_TASK_TOKEN_RE_SRC = FLAT_TASK_TOKEN_RE.source;

/** 仓级域声明相对路径（相对 canonicalRoot(key)；文件入库，内部未决-76 方案 B）。 */
const DOMAINS_REL = ['.workflow', 'domains.json'];

/** 仓级维护者注册表相对路径（内部决策-045，内部任务-96；文件入库 tracked 追加式）。 */
const MAINTAINERS_REL = ['.workflow', 'maintainers.json'];

/**
 * 读仓级域声明（内部未决-76）：合法返回去重域数组，缺失/损坏/非法返回 null——fail-open 家族，
 * 配置坏不阻断声明，退 form-only 校验（损坏可见性警示在 routing-declare CLI 层承载）；
 * 小文件非热路径，不缓存。
 * @param {string} key 项目键
 * @returns {string[]|null}
 */
export function repoDomains(key) {
  try {
    const parsed = JSON.parse(readFileSync(join(canonicalRoot(String(key)), ...DOMAINS_REL), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.domains)) return null;
    if (parsed.domains.length < 1 || parsed.domains.length > 4) return null;
    const seen = new Set();
    for (const d of parsed.domains) {
      const s = String(d).toUpperCase();
      if (!DOMAIN_RE.test(s) || seen.has(s)) return null;
      seen.add(s);
    }
    return [...seen];
  } catch {
    return null;
  }
}

/**
 * 仓级域描述（内部任务-27 批二坑7，可选字段）：domains.json 内 `descriptions` 对象
 * {域: 描述}——schemaVersion 1 内可选字段（读侧不拒未知同级字段，天然向后兼容）。
 * 非对象/任一值非非空字符串或超 120 字符 → 整字段忽略返回 {}（fail-open，不阻断
 * 取号）；文件缺失/损坏同返 {}（与 repoDomains 的 null 语义区分：描述缺失不是配置坏）。
 * @param {string} key 项目键 @returns {Record<string, string>}
 */
export function repoDomainDescriptions(key) {
  try {
    const parsed = JSON.parse(readFileSync(join(canonicalRoot(String(key)), ...DOMAINS_REL), 'utf8'));
    const d = parsed?.descriptions;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out = {};
    for (const [dom, text] of Object.entries(d)) {
      if (typeof text !== 'string' || !text.trim() || text.length > 120) return {};
      out[String(dom).toUpperCase()] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 仓级维护者注册表（内部决策-045，内部任务-96）：`内部工作流状态`
 * （schemaVersion 1，codes 数组 1..16 个 2-4 位大写字母去重，入库 tracked 追加式）。
 * 缺失/损坏/非法返回 null（fail-open——三段声明照常被 taskidRejection 第四层拒，不静默放行；
 * 损坏可见性警示在 routing-declare CLI 层承载——warnBrokenMaintainers）。
 * @param {string} key 项目键
 * @returns {string[]|null}
 */
export function repoMaintainers(key) {
  try {
    const parsed = JSON.parse(readFileSync(join(canonicalRoot(String(key)), ...MAINTAINERS_REL), 'utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.codes) || parsed.codes.length < 1 || parsed.codes.length > 16) return null;
    const seen = new Set();
    for (const c of parsed.codes) {
      const s = String(c).toUpperCase();
      if (!MAINTAINER_RE.test(s) || seen.has(s)) return null;
      seen.add(s);
    }
    return [...seen];
  } catch {
    return null;
  }
}

/**
 * 本机维护者码（内部决策-045 机器本地指针，内部任务-96）：`内部工作流状态`（{code}）。
 * 缺失/损坏/非法返回 null（=默认二段命名空间）。无 env 覆盖面（指针文件唯一，零新注入缝——
 * 评审裁决 2026-10-15）；插件不代写消费者仓文件（内部任务-75）。
 * @param {string} key 项目键
 * @returns {string|null}
 */
export function localMaintainerCode(key) {
  try {
    const parsed = JSON.parse(readFileSync(join(canonicalRoot(String(key)), '.workflow', 'maintainer.local.json'), 'utf8'));
    return typeof parsed?.code === 'string' && MAINTAINER_RE.test(parsed.code) ? parsed.code : null;
  } catch {
    return null;
  }
}

/**
 * 任务号四层校验（不信任调用方）：①形态过 FORM_RE；②序号值域——无前导零、0 不受理
 * （内部未决-111，内部任务-52——受理侧收紧后与取号〔恒从 1 起〕/撞号〔字符串全等〕两侧值域对称；
 * 夹具号约定随批改用域内高位号）；③仓域声明存在且合法时前缀域须 ∈ 仓域集
 * （成员收严，拒跨域引用）；④三段形态（内部决策-045，内部任务-96）——注册表在场时维护者码须 ∈ codes
 * （后到者改码），注册表缺席时三段直接拒（用默认二段形态）。无配置/损坏退 form-only。
 * 返回 null=通过，或拒因字符串（activateLease 拒因细分：形态拒/值域拒/域成员拒/维护者拒各自文案）。
 * @param {string} taskId @param {string} key 项目键
 * @returns {string|null}
 */
export function taskidRejection(taskId, key) {
  const id = String(taskId ?? '');
  if (!TASK_ID_FORM_RE.test(id)) {
    return 'taskId 非法（域前缀形态 <域码>-<序号>（默认）或 <域码>-<维护者码>-<序号>（ADR-045 三段），旧 TASK- 系形态不再接受；取号 --suggest-task-id）';
  }
  const mt = DOMAIN_TASK_RE.exec(id);
  // 内部未决-111（内部任务-52）：序号取 DOMAIN_TASK_RE 尾段捕获组（三段号下 indexOf('-') 会切出
  // 'WP-1' 恒 NaN——内部任务-96 评审视角一 #2 修复：切片迁移至捕获组）。
  const seq = mt ? mt[3] : id.slice(id.lastIndexOf('-') + 1);
  if (seq !== String(Number(seq)) || Number(seq) < 1) {
    return 'taskId 序号非法（无前导零、0 不受理——受理与取号值域对称，OPEN-111）';
  }
  const domains = repoDomains(key);
  if (domains !== null && mt && !domains.includes(mt[1])) {
    return `taskId 域不在本仓域集（收到「${id}」，本仓域 ${domains.join('/')}——跨域引用拒绝；域集见 .workflow/domains.json）`;
  }
  if (mt && mt[2]) {
    const registry = repoMaintainers(key);
    if (registry === null) {
      return 'taskId 维护者命名空间未注册（三段形态需 .workflow/maintainers.json——本仓无注册表，用默认二段形态，ADR-045）';
    }
    if (!registry.includes(mt[2])) {
      return `taskId 维护者码 ${mt[2]} 不在本仓注册表（${registry.join('/')}）——注册冲突后到者改码（ADR-045）`;
    }
  }
  return null;
}

/**
 * 仓内任务号条目枚举（内部任务-24 B 阶段复审归一；内部任务-37 三源化；内部任务-81 四源化）：严格源三处
 * （内部治理状态 目录、内部计划 子目录、内部治理状态 任务号
 * 清单〔内部决策-042/内部规则-16 归档号可见性——条目全串匹配 DOMAIN_TASK_RE，缺席/损坏 fail-open 跳过〕）
 * + 平铺源（docs/plans/ 直接子项名，
 * 非递归——evidence/ 子目录走严格源，宽松嵌入式匹配 FLAT_TASK_TOKEN_RE，内部任务-37：历史任务号
 * 栖身平铺过程文件名〔dev4/dev5/内部任务-27 形态〕对全串源隐形致重复取号）。occupiedSeqsOfDomain 消费
 * 全部源；inferDomainsFromRepo 只消费严格源（src 缺失即严格源条目——仅平铺条目带
 * src='plansFlat' 标记，防 slug 幻域）。逐源质量面（内部决策-061 D5.2）
 * （缺席/不可读按 ENOENT=absent；其余读失败记 degraded——消费者仓 docs/ 整体 gitignore 形态行为不变）；旧主力形态
 * TASK-\<词\>-\<N\> 在严格源不匹配 DOMAIN_TASK_RE、在平铺源被词长/词首锚挡；纯数字尾变体
 * TASK-\<N\> 在平铺源按域码 TASK 计入计数面（内部规则-8 撞号句既有口径：与新形态字符串重叠、
 * 按域码 TASK 放行，配置仓由域集成员校验兜住——内部未决-76 旧号不回填的主力形态不受影响）。
 * @param {string} key 项目键
 * @param {{bySource: Map<string, Array<{domain: string, maintainer: string|null, seq: number}>>, degraded: Array<{source: string, reason: string}>}|null} [collector]
 *        可选收集器：按来源记录命中条目（供占用集 bySource）与逐源读失败（供 degraded）；null=仅返回条目
 * @returns {Array<{domain: string, seq: number, src?: 'plansFlat'}>} 命中条目（域码去重前；
 *   平铺源条目带 src='plansFlat'、历史两源（git subject/traceability，内部任务-36）带
 *   src='history'（不入域推断面）——严格目录源条目无消费方区分需要，不设标签）
 */
function scanTaskIdDirs(key, collector = null) {
  const out = [];
  const root = canonicalRoot(String(key));
  /** 命中条目入 out；collector 在场时按来源记 bySource（用于 degraded/bySource 报告）。 */
  const addEntry = (src, entry) => {
    out.push(entry);
    if (collector && typeof src === 'string' && src) {
      if (!collector.bySource.has(src)) collector.bySource.set(src, []);
      collector.bySource.get(src).push({ domain: entry.domain, maintainer: entry.maintainer ?? null, seq: entry.seq });
    }
  };
  const noteError = (src, target, err) => {
    // 内部决策-061 D5.2：源缺席（ENOENT/目标不存在）＝absent，不置 degraded；其余读错误＝degraded。
    if (!collector || (err && err.code === 'ENOENT')) return;
    collector.degraded.push({ source: src, reason: `读失败：${String(err?.code ?? err?.message ?? err)}` });
  };
  for (const rel of [['.sdd', 'receipts'], ['docs', 'plans', 'evidence']]) {
    const dir = join(root, ...rel);
    const src = rel.join('/');
    try {
      for (const name of readdirSync(dir)) {
        const m = DOMAIN_TASK_RE.exec(name);
        if (m) addEntry(src, { domain: m[1], maintainer: m[2] ?? null, seq: Number(m[3]) });
      }
    } catch (err) {
      noteError(src, dir, err);
    }
  }
  // 归档号可见性第三严格源（内部决策-042/内部规则-16，内部任务-81）：缺席/损坏 fail-open；损坏在 collector
  // 在场时按 degraded 上报（内部决策-061 D5.2：读失败≠缺席）。
  const archiveFile = join(root, '.sdd', 'archive', 'archive-manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(archiveFile, 'utf8'));
    for (const b of Array.isArray(manifest?.batches) ? manifest.batches : []) {
      for (const id of Array.isArray(b?.taskIds) ? b.taskIds : []) {
        const m = DOMAIN_TASK_RE.exec(String(id));
        if (m) addEntry('archive-manifest', { domain: m[1], maintainer: m[2] ?? null, seq: Number(m[3]) });
      }
    }
  } catch (err) {
    noteError('archive-manifest', archiveFile, err);
  }
  const plansDir = join(root, 'docs', 'plans');
  try {
    for (const name of readdirSync(plansDir)) {
      for (const t of scanFlatTokens(name, 'plansFlat')) addEntry('plansFlat', t);
    }
  } catch (err) {
    noteError('plansFlat', plansDir, err);
  }
  // 历史占号两源（git subject / traceability 正文）＋第九源 incidents：per-source fail-open；
  // 内部决策-061 D5.2：git/文件读失败须 degraded（git 源缺席不置 degraded——classifyGitProbe 判定）。
  const root7 = canonicalRoot(String(key));
  const gh = gitHistoryTokens(root7);
  for (const t of gh.tokens) addEntry('gitHistory', t);
  if (collector && gh.status === 'degraded') {
    collector.degraded.push({ source: 'gitHistory', reason: 'git log 探测失败（spawn 失败/超时/非零退出）' });
  }
  const traceFile = join(root7, 'specs', 'traceability-matrix.md');
  try {
    const tm = readFileSync(traceFile, 'utf8');
    for (const t of scanFlatTokens(tm, 'history')) addEntry('traceability', t);
  } catch (err) {
    noteError('traceability', traceFile, err);
  }
  const incidentsFile = join(root7, '.workflow', 'incidents.jsonl');
  try {
    const inc = readFileSync(incidentsFile, 'utf8');
    for (const m of inc.matchAll(/"taskId":"((?:[A-Z]{2,4})(?:-[A-Z]{2,4})?-\d{1,6})"/g)) {
      const t = DOMAIN_TASK_RE.exec(m[1]);
      if (t) addEntry('incidents', { domain: t[1], maintainer: t[2] ?? null, seq: Number(t[3]), src: 'history' });
    }
  } catch (err) {
    noteError('incidents', incidentsFile, err);
  }
  return out;
}

/** 仓级取号占位登记目录（相对 canonicalRoot(key)；内部决策-050 D1，文件入库=git 同步面）。 */
const CLAIMS_REL = ['docs', 'plans', 'claims'];

/** 占位仓内相对路径（posix 分隔单源——终审简洁性发现 5：路径拼接四处收敛；git ls-files
 * 的 pathspec 与 stdout 两侧恒以 / 存储，join 在 win32 产反斜杠会令跟踪判等恒 false）。 */
const claimRelPath = (taskId) => `${CLAIMS_REL.join('/')}/${taskId}.json`;

/**
 * claims 目录 containment（内部任务-244 遗留项⑤）：`内部计划` 是**仓库内相对路径**，
 * 仓库可把它提交成 symlink/junction 指向仓外——读/写/清理会在仓外创建或删除文件（内容受
 * taskId 白名单约束但仍是越界写面）。目录已存在时按 realpath 校验必须落在仓根内（含相等），
 * 越界以 `claim-dir-insecure` 留痕并拒绝读/写（不静默跟随）。目录不存在＝合法（首次写前）。
 * @param {string} key 项目键
 * @returns {{dir: string, ok: boolean}}
 */
function secureClaimsDir(key) {
  const root = canonicalRoot(String(key));
  const dir = join(root, ...CLAIMS_REL);
  let real = null;
  try {
    real = realpathSync(dir);
  } catch {
    return { dir, ok: true }; // 目录尚未创建：按字面路径建（父路径已 canonical）
  }
  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {
    /* 仓根 realpath 失败：退回 canonicalRoot 形态比较 */
  }
  if (real === rootReal || real.startsWith(rootReal + sep)) return { dir: real, ok: true };
  noteHookIssue('claim-dir-insecure');
  return { dir, ok: false };
}

/** 占位「claimed＋过期」谓词单源（occupiedClaimMarkers 与 sweep 共用）。 */
const isStaleClaim = (m) => m.status === 'claimed' && m.expiresAt > 0 && m.expiresAt <= Date.now();

/**
 * git 子进程入口（内部决策-061 D5.3，内部任务-227；内部任务-345 起委托 `scripts/lib/git-exec.mjs`）：
 * `WF_GIT_BIN` 注入缝（值为 `.mjs` 时以 node 解释器执行，跨平台测试桩形态）与 spawn
 * 形态由助手单源承载；助手同时把 locale 固定为 C——本文件随后按**英文错误文案**分类
 * absent/degraded，该匹配的前提正是「spawn 固定 LC_ALL=C」（内部任务-345；否则中文 locale
 * 下 `not a git repository` / `does not have any commits yet` 恒不命中，源缺席被误判
 * degraded）。本函数只保留既有调用预算：timeout 2s / maxBuffer 4MB（gitHistory 源另传 16MB）。
 * @param {string} _root 项目根（保留入参语义：调用方 args 已含 -C root）
 * @param {string[]} args git 参数（含 `-C <root>`）
 * @param {{maxBuffer?: number}} [opts]
 */
function spawnGitFor(_root, args, opts = {}) {
  return spawnGitSync(args, {
    timeoutMs: 2000,
    maxBuffer: Number.isSafeInteger(opts.maxBuffer) ? opts.maxBuffer : 4 * 1024 * 1024,
  });
}

/**
 * 「像是 git 工作树/仓」的强标记（`.git/HEAD` 或 worktree 的 `.git` 文件）——空 `.git`
 * 目录是测试夹具/残留形态，不构成仓库标记；用于 absent/degraded 判别辅证。
 * @param {string} root
 */
function hasGitRepoMarker(root) {
  try {
    const gitEntry = join(String(root), '.git');
    if (!existsSync(gitEntry)) return false;
    // worktree 形态：`.git` 为常规文件且内容以 `gitdir:` 开头（阶段复审约定维 #5 补实现）。
    try {
      const txt = readFileSync(gitEntry, 'utf8');
      if (/^\s*gitdir:/m.test(txt)) return true;
    } catch {
      /* 目录形态：readFileSync 抛 EISDIR，继续按 .git/HEAD 判定 */
    }
    return existsSync(join(gitEntry, 'HEAD'));
  } catch {
    return false;
  }
}

/**
 * git 探测失败分类（内部决策-061 D5.2 / 内部任务-227）：区分「源缺席」与「读失败」——
 * `status===128 && stderr 命中 not a git repository && 无仓标记` ⇒ absent（合法非仓形态）；
 * 其余 spawn 失败/超时（status===null）/非零退出 ⇒ degraded。`.git/HEAD` 存在性为辅证：
 * 破损真仓也常报同一句，属可判定异常不得归 absent。
 * 文案匹配前提＝spawn 固定 LC_ALL=C（`scripts/lib/git-exec.mjs`，内部任务-345）：否则非英文
 * locale 下 git 输出本地化文案，两条 absent 分支恒不命中、源缺席被误判 degraded。
 * @param {string} root 项目根 @param {{status:number|null, error?:unknown, stderr?:string}} git
 * @returns {'ok'|'absent'|'degraded'}
 */
function classifyGitProbe(root, git) {
  if (git && git.status === 0) return 'ok';
  const stderr = String(git?.stderr ?? '');
  if (git && git.status === 128 && isNotARepoStderr(stderr) && !hasGitRepoMarker(root)) return 'absent';
  // 空仓（git init 后零提交）读 `git log` 退 128＋"does not have any commits yet"——属源为空的
  // 合法形态（不是读失败），归 absent（阶段复审正确性 B2 旁发现：新仓首任务不得取号不可得）。
  if (git && git.status === 128 && isEmptyRepoStderr(stderr)) return 'absent';
  return 'degraded';
}

/**
 * 项目根存在性三态（内部决策-061 决策 2 / 内部任务-190）：git 历史探测的「源」是项目根本身——根不存在
 * 或非目录即源缺席（absent），不得 spawn git、不得置 degraded。macOS `git -C <不存在根>` 退
 * 128＋`cannot change to …: No such file or directory` 属平台文案差异，不能作为分类依据。
 * 读失败（EACCES/EIO/ELOOP 等）不是缺席——返回 'degraded' 交既有 fail-loud 判定。
 * @param {string} root canonical 项目根
 * @returns {'present'|'absent'|'degraded'}
 */
function classifyGitRootPresence(root) {
  try {
    return statSync(String(root)).isDirectory() ? 'present' : 'absent';
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    return 'degraded';
  }
}

const gitTrackedMemo = new Map();
/**
 * git ls-files 批单文件探测（内部决策-050 D2 修正 + 内部决策-061 D5.2，内部任务-227）：返回
 * `{tracked, status}`——status: ok（探测完成，tracked=Set）/ absent（非 git 仓：按未跟踪
 * 回落，旧语义）/ degraded（spawn 失败/超时/非零退出：调用方保守不回池并置 degraded）。
 * 进程内 30s memo 仅缓存成功非空命中集（已跟踪基本单调；空集与失败不缓存）。
 * @param {string} key @param {string[]} relFiles
 * @returns {{tracked: Set<string>|null, status: 'ok'|'absent'|'degraded'}}
 */
function trackedPaths(key, relFiles) {
  if (relFiles.length === 0) return { tracked: new Set(), status: 'ok' };
  const root = canonicalRoot(String(key));
  const binId = process.env.WF_GIT_BIN || 'git';
  const memoKey = `${root}\n${binId}\n${[...relFiles].sort().join('\n')}`;
  const hit = gitTrackedMemo.get(memoKey);
  if (hit && Date.now() - hit.at < 30_000) return { tracked: hit.set, status: 'ok' };
  const out = new Set();
  let status = 'degraded';
  try {
    const git = spawnGitFor(root, ['-C', root, 'ls-files', '--', ...relFiles]);
    status = classifyGitProbe(root, git);
    if (status === 'ok' && typeof git.stdout === 'string') {
      for (const line of git.stdout.split('\n')) if (line) out.add(line);
    }
  } catch {
    status = 'degraded';
  }
  if (status === 'ok' && out.size > 0) {
    if (gitTrackedMemo.size > 32) gitTrackedMemo.clear();
    gitTrackedMemo.set(memoKey, { at: Date.now(), set: out });
  }
  return { tracked: status === 'ok' ? out : null, status };
}

/**
 * 读 claims/ 占位登记原始条目（内部决策-050 D1 形态）。损坏 JSON 按 claimed＋永久保守计入
 * （expiresAt 归 0＝永不过期——与半损坏 claim 不清同侧，不可判定不静默放号）；目录
 * 缺席返回 []（absent）；其余读失败经 probe 记 degraded（D5.2）。文件名全串 DOMAIN_TASK_RE，非任务号形态忽略。
 * @param {string} key 项目键
 * @returns {Array<{taskId: string, domain: string, maintainer: string|null, seq: number, status: string, expiresAt: number, sessionDigest: string|null}>}
 */
function readClaimMarkers(key, probe = null) {
  const out = [];
  const sec = secureClaimsDir(key);
  if (!sec.ok) {
    if (probe) probe.degraded.push({ source: 'claimsMarkers', reason: '占位目录越出仓根（symlink/junction 拒绝跟随）' });
    return out;
  }
  const dir = sec.dir;
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    // 内部决策-061 D5.2（内部任务-227）：ENOENT＝源缺席（[] 不变）；其余读失败须 degraded 可见。
    if (probe && !(err && err.code === 'ENOENT')) probe.degraded.push({ source: 'claimsMarkers', reason: `占位目录读失败：${String(err?.code ?? err?.message ?? err)}` });
    return out;
  }
  for (const name of names) {
    const m = DOMAIN_TASK_RE.exec(name.replace(/\.json$/, ''));
    if (!m) continue;
    const body = readJson(join(dir, name));
    if (body === null && probe) probe.degraded.push({ source: 'claimsMarkers', reason: `占位文件损坏不可解析：${name}` });
    const exp = Number(body?.expiresAt);
    out.push({
      taskId: m[0],
      domain: m[1],
      maintainer: m[2] ?? null,
      seq: Number(m[3]),
      status: body?.status === 'released' ? 'released' : 'claimed',
      expiresAt: Number.isFinite(exp) && exp > 0 ? exp : 0,
      sessionDigest: typeof body?.sessionDigest === 'string' && body.sessionDigest ? body.sessionDigest : null,
    });
  }
  return out;
}

/**
 * 占位占用判定单源（内部决策-050 D2 回池真值表）：claimed＋（未过期 ∨ git 已跟踪）＝计入；
 * claimed＋未跟踪/探测失败＋已过期＝回池；released＝一律不计入。git 探测仅在存在
 * 「claimed＋过期」占位时触发（热路径零 spawn——leaseLine 每消息经 suggestedTaskId
 * 触达占用集）。**建议消费面会话排除同族适用**（内部未决-103 延伸，内部任务-62）：opts.excludeSessionId
 * 在场时按 sessionDigest 等值排除观察会话自身的占位——「照抄即延续同号」语义不因新
 * 占用源破坏（占位写入时 sessionDigest=sessDigest(sessionId)，脱敏但确定性可比对）。
 * @param {string} key 项目键 @param {{excludeSessionId?: string}} [opts]
 * @returns {Array<{taskId: string, domain: string, maintainer: string|null, seq: number, status: string, occupied: boolean}>}
 */
function occupiedClaimMarkers(key, opts = {}, probe = null) {
  const excl = normalizeSession(opts?.excludeSessionId);
  const ownDigest = excl !== null ? sessDigest(excl) : null;
  const markers = readClaimMarkers(key, probe).filter((m) => ownDigest === null || m.sessionDigest !== ownDigest);
  const stale = markers.filter(isStaleClaim);
  // undefined=未探测（无过期占位，零 spawn）；null=探测失败（内部决策-061 D5.2/D7：保守按已跟踪＝
  // 不回池并置 degraded——旧「按未跟踪回落（回池）」废止）；Set=探测完成。
  const trackedProbe = stale.length > 0 ? trackedPaths(key, stale.map((m) => claimRelPath(m.taskId))) : { tracked: undefined, status: 'ok' };
  const tracked = trackedProbe.tracked;
  const probeFailed = trackedProbe.status === 'degraded';
  if (probe && stale.length > 0 && probeFailed) {
    probe.degraded.push({ source: 'trackedPaths', reason: 'git ls-files 探测失败（spawn 失败/超时/非零退出）——保守不回池' });
  }
  return markers.map((m) => ({
    ...m,
    // D2 修正（内部任务-227）：探测失败→保守占用；源缺席（非 git 仓）→按未跟踪回落（旧语义）；
    // 探测成功→以 tracked 命中为准。
    occupied: m.status === 'claimed' && (!isStaleClaim(m) || (probeFailed ? true : (tracked?.has?.(claimRelPath(m.taskId)) ?? false))),
  }));
}

/**
 * 写取号占位登记（声明成功路径挂点调用；内部决策-050 D1）。幂等覆盖（atomicWrite）；
 * taskId 须过 DOMAIN_TASK_RE（防御——声明侧已拦旧形态）；写失败返回 {ok:false}
 * 由调用方降级可见（claimMarkerWritten=false 警告同 claimWritten 形态），不阻断声明。
 * @param {string} key 项目键 @param {{taskId: string, skill?: string|null, sessionId?: string|null, host?: string|null}} lease 声明体
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
export function writeClaimMarker(key, lease) {
  if (!lease || typeof lease.taskId !== 'string' || !DOMAIN_TASK_RE.test(lease.taskId)) {
    return { ok: false, error: 'task-id 形态不合法，不落占位' };
  }
  const sec = secureClaimsDir(key);
  if (!sec.ok) return { ok: false, error: 'claims 目录越出仓根（拒绝写占位）' };
  const file = join(sec.dir, `${lease.taskId}.json`);
  try {
    atomicWrite(file, {
      schemaVersion: 1,
      taskId: lease.taskId,
      skill: typeof lease.skill === 'string' && lease.skill ? lease.skill : null,
      ts: Date.now(),
      host: typeof lease.host === 'string' && lease.host ? lease.host : null,
      // 终审交叉命中（正确性/约定两维 90/92）：写侧对**归一形态**取摘要——读侧排除按
      // sessDigest(normalizeSession(excl)) 比对，两侧归一对称「照抄即延续同号」才在带
      // 前缀会话 id（session-/sess_/mvs_）宿主上成立；归一为 null（default/空）不落摘要
      //（保守：不可比对=不排除）。
      sessionDigest: (() => {
        const norm = normalizeSession(lease.sessionId);
        return norm !== null ? sessDigest(norm) : null;
      })(),
      status: 'claimed',
      expiresAt: Date.now() + ttlMs(),
      // 内部决策-061 修正案 1 第 3 条（内部任务-227）：续任务/人工通道审计字段随占位持久化
      //（lease/claim/台账三面可诊断；普通声明不写字段，保持既有文件字节形态）。
      ...(lease.resumed === true ? { resumed: true, resumeReason: String(lease.resumeReason ?? '') } : {}),
      ...(lease.manual === true ? { manual: true, manualReason: String(lease.manualReason ?? '') } : {}),
      ...(lease.inherited === true ? { inherited: true, parentSessionId: String(lease.parentSessionId ?? '') } : {}),
    });
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 占位改 released（--release 路径挂点；内部决策-050 D2「显式释放即回收」）。读-改-写保留
 * 其余字段；文件缺席/损坏返回 {ok:false}（释放主链照常——claim 删除不因此阻断）。
 * taskId 入口过 DOMAIN_TASK_RE（与 writeClaimMarker 同构防御——阶段复审发现 3：释放
 * 同为文件系统写面，`../` 形态不得经 join 逃出 claims 目录）；写回走 atomicWrite
 * （阶段复审发现 2：裸写撕裂留损坏体会被按 claimed＋永久固化烧号，原子写崩溃留旧
 * claimed 体可随 TTL 自愈回池）。
 * @param {string} key 项目键 @param {string} taskId @param {string|null} [holderDigest] 释放者
 *        会话摘要（sessDigest(normalizeSession(sessionId))；null 释放者只翻无摘要占位）
 * @returns {{ok: boolean, error?: string}}
 */
export function markClaimReleased(key, taskId, holderDigest = null) {
  if (typeof taskId !== 'string' || !DOMAIN_TASK_RE.test(taskId)) {
    return { ok: false, error: 'task-id 形态不合法，不改占位' };
  }
  const sec = secureClaimsDir(key);
  if (!sec.ok) return { ok: false, error: 'claims 目录越出仓根（拒绝改占位）' };
  const file = join(sec.dir, `${taskId}.json`);
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    // 持有者校验（终审约定维发现 2，置信度 85）：同名号占位按任务号共享幂等覆盖（D1），
    // 陈旧释放（他会话接管的旧 claim、跨机弃号后他机新占）不得把在持有者的活跃占位翻
    // released——仅当文件 sessionDigest 与释放者摘要等值（或文件本身无摘要）才翻转。
    const fileDigest = typeof body?.sessionDigest === 'string' && body.sessionDigest ? body.sessionDigest : null;
    if (fileDigest !== null && holderDigest !== null && fileDigest !== holderDigest) {
      return { ok: false, error: '占位持有者不匹配，不翻转（防陈旧释放摧毁在持有者占用）' };
    }
    // 内部任务-244 D05：写前**复读**——首校验与写回之间持有者可能已并发重声明；快照不一致即放弃
    // 翻转（不得用陈旧 body 覆盖新占位）。测试注入缝模拟「首校验后」的并发改写（生产零行为）。
    let fresh;
    try {
      fresh = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, error: '占位在释放前不可读，放弃翻转' };
    }
    if (process.env.WF_CLAIM_RELEASE_RACE_REWRITE === '1') {
      atomicWrite(file, { ...fresh, sessionDigest: 'newholder00000000', status: 'claimed' });
      fresh = JSON.parse(readFileSync(file, 'utf8'));
    }
    const sameSnap =
      (fresh?.sessionDigest ?? null) === (body?.sessionDigest ?? null)
      && String(fresh?.taskId ?? '') === String(body?.taskId ?? '')
      && String(fresh?.status ?? '') === String(body?.status ?? '');
    if (!sameSnap) {
      return { ok: false, error: '占位在释放前被并发改写，放弃翻转（防陈旧释放覆盖新占位）' };
    }
    atomicWrite(file, { ...fresh, status: 'released', releasedAt: Date.now() });
    // 写后回读校验（观测并发竞态；不一致如实报错，不静默成功）
    const after = JSON.parse(readFileSync(file, 'utf8'));
    if (after?.status !== 'released') return { ok: false, error: '释放写后回读状态不一致' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** FLAT token 口径扫描单点（平铺文件名/历史两源同族——改口径单点改；入参原文，内部大写）。 */
function scanFlatTokens(text, src) {
  const tokens = [];
  for (const m of String(text).toUpperCase().matchAll(FLAT_TASK_TOKEN_RE)) {
    const seq = Number(m[4]);
    if (seq > 999999) continue;
    tokens.push({ domain: m[2], maintainer: m[3] ?? null, seq, src });
  }
  return tokens;
}

/** git subject 历史占号 token（进程内 30s memo——热路径去重；条目上限防长生进程无界增长）。 */
const gitHistoryMemo = new Map();
function gitHistoryTokens(root) {
  const binId = process.env.WF_GIT_BIN || 'git';
  const memoKey = `${root}\n${binId}`;
  const hit = gitHistoryMemo.get(memoKey);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = { tokens: [], status: 'ok' };
  // 内部任务-190（内部决策-061 决策 2）：根不存在/非目录＝源缺席，spawn 前短路（零 spawn、不置 degraded）。
  const presence = classifyGitRootPresence(root);
  if (presence !== 'present') {
    value.status = presence; // absent＝源缺席；degraded＝根不可读（读失败，交既有 fail-loud）
  } else {
    try {
      const git = spawnGitFor(root, ['-C', root, 'log', '--format=%s'], { maxBuffer: 16 * 1024 * 1024 });
      const cls = classifyGitProbe(root, git);
      value.status = cls;
      if (cls === 'ok' && typeof git.stdout === 'string') value.tokens = scanFlatTokens(git.stdout, 'history');
    } catch {
      value.status = 'degraded';
    }
  }
  // 内部决策-061 D5.2：仅缓存成功结果——absent/degraded 不 memo（源可恢复性须在下一次调用即可见，
  // 否则 degraded→ok 的恢复窗口被 30s 缓存掩盖，与 fail-loud 可见性相悖）。
  if (value.status === 'ok') {
    if (gitHistoryMemo.size > 32) gitHistoryMemo.clear();
    gitHistoryMemo.set(memoKey, { at: Date.now(), value });
  }
  return value;
}

/**
 * 域占用序号全集（内部任务-117 稠密取号的占用集单源）：git 同步源（receipts 目录∪evidence
 * 目录∪归档 manifest∪docs/plans 平铺，经 scanTaskIdDirs——后者 git 同步面，内部任务-24 B/
 * 内部任务-37/内部任务-81 演进）∪ 未过期 claim/active（stateDir 全部 wf-lease-active-* 与
 * wf-lease-claim-* 的 taskId——active∪claim 与撞号守卫**扫描面同族**，过滤口径两途：
 * 取号=项目级过滤＋**过期回池**〔内部任务-117：expiresAt 已过期的弃任务占用不计，NaN/缺席
 * 保守计入〕＋建议消费面例外〔内部未决-103，内部任务-52：opts.excludeSessionId 在场时排除观察
 * 会话自身的 claim/active 占用〕；撞号=项目内 (projectKey,taskId)+未过期+异会话精确
 * 判定〕。**发号台账 issued.jsonl 不入占用集**（内部任务-117：降级为纯审计轨迹继续写入——
 * 旧「发号即占号解 TTL 遗忘」语义废止，弃任务号随 TTL 回池消除跳号；跨机同号面由 git
 * 同步源＋内部决策-045 让号协议在 evidence add/add 处承接）。逐源质量面（内部决策-061 D5.2）：缺席
 * （ENOENT/非 git 仓）记 absent 不计入；读失败（I/O/解析/spawn 失败/超时/非零退出）记 degraded
 * 并在返回面携带。
 * @param {string} key 项目键 @param {string} domain 域码（已过 DOMAIN_RE）
 * @param {{excludeSessionId?: string, maintainer?: string|null}} [opts] 会话排除与维护者
 *        分段三态（undefined=全部计入/null=仅二段默认命名空间/字符串=该维护者段）
 * @returns {{used: Set<number>, bySource: Map<string, Set<number>>, degraded: Array<{source: string, reason: string}>}} 该域占用事实集（`used` 序号集／`bySource` 逐源事实／`degraded` 降级来源）
 */
// ─────────────────────────────────────────────────────────────────────────────
// 内部任务-244 P02：占用集**文件级缓存**（纯缓存；缓存读面仅服务建议号/可见性提示，
// 撞号守卫与激活判定恒读实况——本函数不参与那两条判定）。
// 有效性＝TTL 30s ∧ 源戳一致（.git/HEAD、claims/、evidence/ 的 mtime+size）；源戳不一致或
// TTL 过期即失效重扫。写失败 noteHookIssue('cache-degraded')（每进程至多一次）并 fail-open。
// ─────────────────────────────────────────────────────────────────────────────
const OCCUPANCY_CACHE_TTL_MS = 30_000;
const occupancyCacheNoted = new Set();

/** 源戳：任一源文件/目录 mtime+size 变化即缓存失效（跨机/新占位/证据目录新增都会变）；
 * 另含状态根中 claim/active 文件名集（新增/删除立即失效——内容续期由 30s TTL 兜底）。 */
function occupancySourceStamp(key) {
  const root = canonicalRoot(String(key));
  const stampOf = (p) => {
    try {
      const s = statSync(p);
      return `${Math.floor(s.mtimeMs)}:${s.size}`;
    } catch {
      return 'absent';
    }
  };
  let leaseNames = '';
  try {
    leaseNames = readdirSync(stateRootFor(key))
      .filter((n) => n.startsWith('wf-lease-claim-') || n.startsWith('wf-lease-active-'))
      .sort()
      .join(',');
  } catch {
    leaseNames = 'absent';
  }
  return [
    stampOf(join(root, '.git', 'HEAD')),
    stampOf(join(root, ...CLAIMS_REL)),
    stampOf(join(root, 'docs', 'plans')), // 平铺计划文件名占用源（内部任务-37：新增 devN-*.md 立即失效）
    stampOf(join(root, 'docs', 'plans', 'evidence')),
    stampOf(join(root, 'specs', 'traceability-matrix.md')), // 占用源：traceability prose 扫描面
    stampOf(join(root, '.workflow', 'incidents.jsonl')), // 占用源：incidents 账本 taskId 面
    stampOf(join(root, '.sdd')), // 内部治理状态、archive 的父目录（新增/删除源目录即失效）
    stampOf(join(root, '.sdd', 'receipts')),
    stampOf(join(root, '.sdd', 'archive')),
    stampOf(join(root, '.sdd', 'archive', 'archive-manifest.json')), // 归档 manifest 内容编辑（占用第三源）
    String(process.env.WF_GIT_BIN ?? 'git'), // git 源切换（含测试桩）＝不同事实源，必须失效
    leaseNames,
  ].join('|');
}

/** 缓存文件路径（文件名仅含 repo 根 digest；域/维护者/排除会话进 entries 键）。 */
function occupancyCacheFile(key) {
  return join(stateRootFor(key), `wf-occupancy-cache-${keyDigest(String(key))}.json`);
}

/** 缓存条目键（variant）：域+维护者三态+排除会话。 */
function occupancyVariant(domain, opts) {
  const excl = normalizeSession(opts?.excludeSessionId) ?? '';
  const maint = opts?.maintainer === undefined ? 'all' : opts.maintainer === null ? 'default' : String(opts.maintainer).toUpperCase();
  return `${String(domain)}|${maint}|${excl}`;
}

/** 读缓存条目（TTL＋源戳命中才返回；degraded 结果不入缓存）。 */
function readOccupancyCache(key, domain, opts, stamp) {
  try {
    const body = readJson(occupancyCacheFile(key));
    if (!body || body.stamp !== stamp) return null;
    const e = body.entries?.[occupancyVariant(domain, opts)];
    if (!e || !(Number(e.ts) > 0) || Date.now() - Number(e.ts) > OCCUPANCY_CACHE_TTL_MS) return null;
    if (!Array.isArray(e.used) || typeof e.bySource !== 'object' || !Array.isArray(e.degraded) || e.degraded.length > 0) return null;
    return {
      used: new Set(e.used),
      bySource: new Map(Object.entries(e.bySource).map(([k, v]) => [k, new Set(Array.isArray(v) ? v : [])])),
      degraded: [],
    };
  } catch {
    return null;
  }
}

/** 写缓存条目（合并保留未过期 entries；失败留痕一次，fail-open）。 */
function writeOccupancyCache(key, domain, opts, stamp, result) {
  try {
    const file = occupancyCacheFile(key);
    const body = readJson(file) ?? { schemaVersion: 1, entries: {} };
    // 阶段门正确性评审 #5（跨戳漂白）：stamp 变化时旧 entries/domains 不得以新戳保留——
    // 否则失效源的旧占用被"洗"进新戳，TTL 内继续被当作有效缓存。
    const sameStamp = body.stamp === stamp;
    const entries = sameStamp ? { ...(body.entries ?? {}) } : {};
    for (const [k, v] of Object.entries(entries)) {
      if (!(Number(v?.ts) > 0) || Date.now() - Number(v.ts) > OCCUPANCY_CACHE_TTL_MS) delete entries[k];
    }
    entries[occupancyVariant(domain, opts)] = {
      ts: Date.now(),
      used: [...result.used],
      bySource: Object.fromEntries([...result.bySource].map(([k, v]) => [k, [...v]])),
      degraded: [],
    };
    // 保留同戳的域推断缓存段（同文件不同段，互不覆盖）
    const domains = sameStamp && body.domains ? body.domains : undefined;
    atomicWrite(file, { schemaVersion: 1, stamp, entries, ...(domains ? { domains } : {}) });
  } catch {
    if (!occupancyCacheNoted.has('cache-degraded')) {
      occupancyCacheNoted.add('cache-degraded');
      try { noteHookIssue('user-prompt', 'cache-degraded'); } catch { /* fail-open */ }
    }
  }
}

/** 域推断缓存读（同文件：stamp+TTL 命中才返回；仅缓存严格源推断结果）。 */
function readDomainInferenceCache(key, stamp) {
  try {
    const body = readJson(occupancyCacheFile(key));
    if (!body || body.stamp !== stamp || !Array.isArray(body.domains?.list)) return null;
    if (!(Number(body.domains.ts) > 0) || Date.now() - Number(body.domains.ts) > OCCUPANCY_CACHE_TTL_MS) return null;
    return body.domains.list.map(String);
  } catch {
    return null;
  }
}

/** 域推断缓存写（失败留痕一次，fail-open）。stamp 变化时不保留旧 entries（防跨戳漂白）。 */
function writeDomainInferenceCache(key, stamp, list) {
  try {
    const file = occupancyCacheFile(key);
    const previous = readJson(file) ?? { schemaVersion: 1, entries: {} };
    const body = previous.stamp === stamp ? previous : { schemaVersion: 1, entries: {} };
    atomicWrite(file, { ...body, schemaVersion: 1, stamp, domains: { ts: Date.now(), list: [...list] } });
  } catch {
    if (!occupancyCacheNoted.has('cache-degraded')) {
      occupancyCacheNoted.add('cache-degraded');
      try { noteHookIssue('user-prompt', 'cache-degraded'); } catch { /* fail-open */ }
    }
  }
}

/** 域推断（缓存包装，内部任务-244 P02）：声明域优先（无 git 面）；否则 stamp+TTL 命中复用。 */
function inferDomainsCached(key) {
  if (repoDomains(key) !== null) return inferDomainsFromRepo(key);
  const stamp = occupancySourceStamp(key);
  const cached = readDomainInferenceCache(key, stamp);
  if (cached !== null) return cached;
  const fresh = inferDomainsFromRepo(key);
  writeDomainInferenceCache(key, stamp, fresh);
  return fresh;
}

/**
 * 清理过期占用缓存文件（SessionStart 启动义务）：无新鲜 entries 即删。
 * @param {string} key 项目键 @param {number} [now]
 * @returns {{removed: number, failed: number}}
 */
export function cleanupExpiredOccupancyCaches(key, now = Date.now()) {
  let removed = 0;
  let failed = 0;
  try {
    for (const name of readdirSync(stateRootFor(key))) {
      if (!name.startsWith('wf-occupancy-cache-') || !name.endsWith('.json')) continue;
      const file = join(stateRootFor(key), name);
      let fresh = false;
      try {
        const body = readJson(file);
        const entries = body?.entries && typeof body.entries === 'object' ? Object.values(body.entries) : [];
        fresh = entries.some((e) => Number(e?.ts) > 0 && now - Number(e.ts) <= OCCUPANCY_CACHE_TTL_MS);
      } catch {
        fresh = false;
      }
      if (fresh) continue;
      try {
        rmSync(file, { force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    /* fail-open：目录缺失/读失败无缓存可清 */
  }
  return { removed, failed };
}

/**
 * 占用源全集（内部任务-244 遗留项⑥，单源导出）：九源按名称排序的固定清单——查询面逐源状态行
 * （ok 路径）与 degraded 路径的逐源 presence 渲染共用，防两处清单漂移。
 */
export const OCCUPANCY_ALL_SOURCES = Object.freeze([
  '.sdd/receipts', 'docs/plans/evidence', 'archive-manifest', 'plansFlat', 'gitHistory',
  'traceability', 'incidents', 'stateClaims', 'stateActive', 'claimsMarkers',
]);

/**
 * 占用集计算（内部核；无缓存）。JSDoc 见 {@link occupiedSeqsOfDomain}。
 */
function computeOccupiedSeqsOfDomain(key, domain, opts = {}) {
  // 会话排除判等（内部未决-103）：归一形态单源（normalizeSession——非字符串/空串/'default'
  // 一律归 null 恒不排，防 default 桶把他会话/未归属占用一并误排）。
  const excl = normalizeSession(opts?.excludeSessionId);
  const ownOccupancy = (raw) => excl !== null && normalizeSession(raw) === excl;
  const wantMaintainer =
    opts.maintainer === undefined ? undefined : opts.maintainer === null ? null : String(opts.maintainer).toUpperCase();
  const matchesScope = (m) => m !== null && (wantMaintainer === undefined || (m[2] ?? null) === wantMaintainer);
  const bySource = new Map();
  const degraded = [];
  const used = new Set();
  const collect = (src, seq) => {
    if (!bySource.has(src)) bySource.set(src, new Set());
    bySource.get(src).add(seq);
    used.add(seq);
  };
  const claimPrefix = `wf-lease-claim-${keyDigest(String(key))}-`;
  try {
    for (const name of readdirSync(stateRootFor(key))) {
      const isClaim = name.startsWith(claimPrefix);
      const isActive = name.startsWith('wf-lease-active-');
      if (!isClaim && !isActive) continue;
      const other = readJson(join(stateRootFor(key), name));
      if (other === null) {
        // 内部决策-061 D5.2：状态文件损坏＝读失败须 degraded（不可判定不放号；不静默按缺席跳过）。
        degraded.push({ source: isClaim ? 'stateClaims' : 'stateActive', reason: `状态文件损坏不可解析：${name}` });
        continue;
      }
      if (isActive && other?.projectKey !== undefined && other.projectKey !== String(key)) continue;
      if (isClaim || (isActive && other?.projectKey === String(key)) || (isActive && other?.projectKey === undefined)) {
        if (ownOccupancy(other?.sessionId)) continue;
        if (Number(other?.expiresAt) > 0 && Number(other?.expiresAt) <= Date.now()) continue;
        const m = other && typeof other.taskId === 'string' ? DOMAIN_TASK_RE.exec(other.taskId) : null;
        if (matchesScope(m) && m[1] === domain) collect(isClaim ? 'stateClaims' : 'stateActive', Number(m[3]));
      }
    }
  } catch (err) {
    // 状态根缺席（ENOENT）＝源缺席；其余读失败＝degraded（内部决策-061 D5.2）。
    if (!(err && err.code === 'ENOENT')) degraded.push({ source: 'state', reason: `状态根读失败：${String(err?.code ?? err?.message ?? err)}` });
  }
  const collector = { bySource: new Map(), degraded: [] };
  for (const e of scanTaskIdDirs(key, collector)) {
    if (e.domain === domain && (wantMaintainer === undefined || (e.maintainer ?? null) === wantMaintainer)) used.add(e.seq);
  }
  for (const [src, arr] of collector.bySource) {
    for (const e of arr) {
      if (e.domain === domain && (wantMaintainer === undefined || (e.maintainer ?? null) === wantMaintainer)) collect(src, e.seq);
    }
  }
  degraded.push(...collector.degraded);
  const probe = { degraded: [] };
  for (const m of occupiedClaimMarkers(key, opts, probe)) {
    if (m.occupied && m.domain === domain && (wantMaintainer === undefined || (m.maintainer ?? null) === wantMaintainer)) collect('claimsMarkers', m.seq);
  }
  degraded.push(...probe.degraded);
  return { used, bySource, degraded };
}

/**
 * 占用集（内部任务-244 P02 缓存包装）：出口与内部核同形；`opts.noCache=true` 强制实况计算。
 * **读面边界**：本函数只服务建议号/可见性提示；撞号守卫与激活判定恒读实况（不调本函数）。
 * @param {string} key 项目键 @param {string} domain 域码 @param {object} [opts]
 * @returns {{used: Set<number>, bySource: Map<string, Set<number>>, degraded: Array<{source: string, reason: string}>}}
 */
export function occupiedSeqsOfDomain(key, domain, opts = {}) {
  if (opts?.noCache === true) return computeOccupiedSeqsOfDomain(key, domain, opts);
  const stamp = occupancySourceStamp(key);
  const cached = readOccupancyCache(key, domain, opts, stamp);
  if (cached) return cached;
  const fresh = computeOccupiedSeqsOfDomain(key, domain, opts);
  if (fresh.degraded.length === 0) writeOccupancyCache(key, domain, opts, stamp, fresh);
  return fresh;
}

/**
 * 稠密取号（内部任务-117，用户裁决「按项目发号、从 1 起、绝不跳号」）：该域**最小未用**序号。
 * 占用集见 occupiedSeqsOfDomain JSDoc——**发号台账（wf-issued-*）不入占用集**（降级为纯
 * 审计轨迹继续写入：弃任务号随租约 TTL 过期回池，旧「声明即永久烧号」跳号根因废止）；
 * 跨机/久闲置同号窗口由 内部决策-045 让号协议在 evidence add/add 处承接——最终序列稠密。
 */
function denseSeqOfDomain(key, domain, opts = {}) {
  const { used } = occupiedSeqsOfDomain(key, domain, opts);
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/**
 * 从严格源目录名推断域集（无仓域声明时的兜底域来源；receipts 与 内部计划 目录名
 * ——内部任务-24 B 起 git 同步面兜底，跨机新克隆 receipts 缺席时仍有域可推；原名
 * inferDomainsFromReceipts，随扫描面扩展更名消名实漂移〔阶段复审发现〕）；**排除平铺源
 * 与历史源**（内部任务-37：`open76-*` 类 slug 的幻域会进建议列表致多域仓 soleTaskIdSuggestion
 * 退 null——推断面只认全串形态的严格源；内部任务-36 阶段 3 同款理由排除 git/traceability
 * prose 扫描源）；目录缺失返回 []。
 */
function inferDomainsFromRepo(key) {
  return [...new Set(scanTaskIdDirs(key).filter((e) => e.src == null).map((e) => e.domain))];
}

/**
 * 按域取号（内部未决-76）：占用集见 occupiedSeqsOfDomain（内部任务-117：发号台账退占用、过期
 * 回池），按域取**最小未用序号**（稠密——从 1 起、绝不跳号，内部任务-117），空态 <域>-1。
 * @param {string} key 项目键
 * @param {{domain?: string, excludeSessionId?: string}} [opts] 显式域（优先，仓域声明存在时须过成员校验——取号器的
 * 职责是给出可声明的号，口径与声明侧一致）；excludeSessionId（内部未决-103，内部任务-52——建议消费面排除
 * 观察会话自身占用，直调机器级语义不变）；缺省按仓域声明逐域，再缺省按 receipts 域推断，
 * 推断亦空（零域态）回落内置默认域集 ['DEV']（内部任务-75/IMP-4，恰单域保内联建议开箱可用）
 * @returns {{ok: boolean, suggestions: Array<{domain: string, taskId: string, description?: string}>, degraded: Array<{source: string, reason: string}>, usedDefaultDomains?: true, hint?: string}}
 *          degraded 非空时 ok=false 且不产出建议号（内部决策-061 D5 fail-loud）；usedDefaultDomains 仅在默认域兜底生效时携带
 */
export function suggestedTaskId(key, opts = {}) {
  const explicit = opts.domain !== undefined ? String(opts.domain).toUpperCase() : undefined;
  if (explicit !== undefined && !DOMAIN_RE.test(explicit)) {
    return { ok: false, suggestions: [], hint: `域码形态非法（收到「${String(opts.domain)}」）——2-4 位大写字母` };
  }
  if (explicit !== undefined) {
    const declared = repoDomains(key);
    if (declared !== null && !declared.includes(explicit)) {
      return { ok: false, suggestions: [], hint: `域 ${explicit} 不在本仓域集（${declared.join('/')}）——跨域号声明必被拒，取号口径与声明一致；域集见 .workflow/domains.json` };
    }
  }
  // 内部决策-045/内部任务-96：维护者上下文三态（显式字符串 > 注册表在场时的本地指针 > undefined）；
  // **null=显式默认命名空间**（仅二段——occupiedSeqsOfDomain 同款三态，跳过维护者成员校验）。
  // 成员校验（评审视角二 #3）：「不得给出必被拒的号」不变量随维护者段迁移——照显式域分支同构。
  let maintainer = opts.maintainer !== undefined ? opts.maintainer : undefined;
  if (maintainer === undefined) {
    maintainer = repoMaintainers(key) !== null ? localMaintainerCode(key) : undefined;
  } else if (maintainer !== null) {
    maintainer = String(maintainer).toUpperCase();
    if (!MAINTAINER_RE.test(maintainer)) {
      return { ok: false, suggestions: [], hint: `维护者码形态非法（收到「${String(opts.maintainer)}」）——2-4 位大写字母（ADR-045）` };
    }
    const registry = repoMaintainers(key);
    if (registry === null) {
      return { ok: false, suggestions: [], hint: '本仓无维护者注册表（.workflow/maintainers.json 缺席）——三段号声明必被拒，用默认二段形态（ADR-045）；如需多维护者命名空间可自建（schemaVersion 1，codes 数组）或回复「授权代建 maintainers.json」由我经正常编辑工具创建（ADR-050 D3 两途）' };
    }
    if (!registry.includes(maintainer)) {
      return { ok: false, suggestions: [], hint: `维护者码 ${maintainer} 不在本仓注册表（${registry.join('/')}）——注册冲突后到者改码；取号口径与声明一致（ADR-045）` };
    }
  }
  if (maintainer !== undefined && maintainer !== null && !repoMaintainers(key)?.includes(maintainer)) {
    const registry = repoMaintainers(key);
    return { ok: false, suggestions: [], hint: `本机指针维护者码 ${maintainer} 不在本仓注册表（${registry ? registry.join('/') : '无'}）——请更新 .workflow/maintainer.local.json 或改码（ADR-045）` };
  }
  let domains = explicit !== undefined ? [explicit] : (repoDomains(key) ?? inferDomainsCached(key));
  // 内部任务-75/IMP-4：零域态回落内置默认域集（见 DEFAULT_DOMAINS 头注）——显式域优先不受
  // 影响；结果携带 usedDefaultDomains 标记供查询面附注定制指引（CLI 渲染，教育面保留）。
  const usedDefaultDomains = explicit === undefined && domains.length === 0;
  if (domains.length === 0) domains = [...DEFAULT_DOMAINS];
  const suggestions = [];
  const degradedAll = [];
  const presenceByDomain = {};
  const descriptions = repoDomainDescriptions(key);
  for (const domain of domains) {
    const occ = occupiedSeqsOfDomain(key, domain, { excludeSessionId: opts.excludeSessionId, maintainer });
    degradedAll.push(...occ.degraded);
    // 内部任务-244 遗留项⑥（内部未决-183④）：degraded 查询面也需逐源 presence 清单——失败源标
    // degraded、产出过数据的源标 present、其余缺席标 absent（单源清单见 OCCUPANCY_ALL_SOURCES）。
    const degradedSources = new Set(occ.degraded.map((d) => String(d.source ?? d)));
    presenceByDomain[domain] = Object.fromEntries(OCCUPANCY_ALL_SOURCES.map((src) => [
      src,
      degradedSources.has(src) ? 'degraded' : (occ.bySource.has(src) ? 'present' : 'absent'),
    ]));
    let next = 1;
    while (occ.used.has(next)) next += 1;
    if (next > 999999) {
      return { ok: false, suggestions: [], hint: `域 ${domain} 序号已耗尽（上限 999999）——撞号阻断下的换号重试无解，请扩域或清理历史号` };
    }
    // 坑7：恰有域描述时作为可选字段携带（消费方 CLI 输出/agent 判域参考）
    // 内部决策-045/内部任务-96：维护者上下文在场时建议号取三段形态（该维护者命名空间内最小未用，内部任务-117）。
    // 内部任务-244 P06：建议号随附 `bySource`（逐占用源序号集）——查询面（routing-declare
    // --suggest-task-id）据此渲染逐源状态，不再二次调用 occupiedSeqsOfDomain（省一次全扫）。
    suggestions.push({
      domain,
      taskId: maintainer ? `${domain}-${maintainer}-${next}` : `${domain}-${next}`,
      ...(descriptions[domain] ? { description: descriptions[domain] } : {}),
      bySource: Object.fromEntries([...occ.bySource].map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
    });
  }
  // 内部决策-061 D5（内部任务-227）：degraded 时建议号不可用——结果携带 degraded，并追加审计行（可诊断面）。
  if (degradedAll.length > 0) {
    appendDegradedRecord(key, {
      sources: degradedAll,
      context: {
        skill: opts?.context?.skill ?? null,
        taskId: opts?.context?.taskId ?? null,
        sessionId: normalizeSession(opts?.excludeSessionId),
      },
    });
    return { ok: false, suggestions: [], degraded: degradedAll, presence: presenceByDomain, hint: `取号暂不可得（占用源降级：${degradedAll.map((d) => d.source).join('/')}）——请稍后重试或排查来源后复查` };
  }
  return { ok: true, suggestions, degraded: [], ...(usedDefaultDomains ? { usedDefaultDomains: true } : {}) };
}

/**
 * 唯一建议号（内部任务-27 批二坑4）：恰一条建议时返回该 taskId，否则 null——单域仓给出
 * 可照抄的号；多域仓取号必须人工判域（--suggest-task-id），内联反而误导；零域仓经默认
 * 域兜底恰单建议即内联（内部任务-75，旧「零域仓无可建议」形态废止）。租约行（user-prompt
 * leaseLine）与 deny 文案（routing-gate denyMessage cmd 模板）
 * 双消费方单源（issuanceKeys 迁 lib 同款先例）。内部未决-103（内部任务-52）：两消费面传
 * {excludeSessionId: 本会话}——续任务每轮建议不被自身未过期占用顶成 n+1（照抄即延续同号）。
 * @param {string} key 项目键 @param {{excludeSessionId?: string, meta?: object, context?: object}} [opts] 透传 suggestedTaskId；meta 为输出面（degraded 回填）
 * @returns {string|null}
 */
export function soleTaskIdSuggestion(key, opts = {}) {
  const meta = opts && typeof opts.meta === 'object' && opts.meta !== null ? opts.meta : null;
  const sug = suggestedTaskId(key, opts);
  const degraded = Array.isArray(sug.degraded) ? sug.degraded : [];
  if (meta) meta.degraded = degraded;
  // 内部决策-061 D5（内部任务-227）：degraded 时禁止内联任何具体号（消费面回退占位符/「取号暂不可得」）。
  if (degraded.length > 0) return null;
  // 内部决策-045/内部任务-96（评审视角一 #3）：内联条件加「建议号 ≤11 字符」——三段号最长
  // `AAAA-BBBB-999999`=16 字符超预算，超长回退 null（消费面保持 <任务号> 占位符；
  // 租约行与 deny 文案内联面单源连带，内部规则-7 行长口径 ≤230 不变）。
  if (!sug.ok || sug.suggestions.length !== 1) return null;
  return sug.suggestions[0].taskId.length <= 11 ? sug.suggestions[0].taskId : null;
}

/** 取号降级审计文件（stateRootFor(key) 下按 keyDigest；append-only，内部决策-061 D5 修正）。 */
function degradedAuditFile(key) {
  return join(stateRootFor(key), `wf-occupancy-degraded-${keyDigest(String(key))}.jsonl`);
}

/**
 * 追加一条占用集降级审计行（内部决策-061 D5 修正，内部任务-227）：`{ts, sources[], context}`；
 * append-only、写失败静默（stderr 告警与查询摘要由消费面承担，审计面不阻断取号）。
 * @param {string} key 项目键 @param {{sources?: Array<string|{source:string}>, context?: object|null}} [rec]
 */
export function appendDegradedRecord(key, rec = {}) {
  const raw = Array.isArray(rec.sources) ? rec.sources : [];
  const sources = [...new Set(raw.map((s) => (s && typeof s === 'object' ? s.source : s)).filter((s) => typeof s === 'string' && s))];
  try {
    mkdirSync(stateRootFor(key), { recursive: true });
    appendFileSync(degradedAuditFile(key), `${JSON.stringify({ ts: Date.now(), sources, context: rec.context ?? null })}\n`);
  } catch {
    /* 审计面 fail-open（可诊断性降级不阻断取号） */
  }
}

/**
 * 读最近 N 条降级审计（查询面摘要消费；坏行跳过，文件缺席返回 []）。
 * @param {string} key 项目键 @param {number} [limit]
 * @returns {Array<{ts:number, sources:string[], context:object|null}>}
 */
export function readRecentDegraded(key, limit = 3) {
  try {
    const lines = readFileSync(degradedAuditFile(key), 'utf8').split('\n').filter(Boolean);
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 3;
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 本仓 issued 台账行（append-only，逆序返回：最新在前；坏行跳过）。 */
function readIssuedRows(key) {
  try {
    const file = join(stateRootFor(key), `wf-issued-${keyDigest(String(key))}.jsonl`);
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

/** 审计源集合（仅这些源占号 → 属「历史已用号」；内部决策-061 D6.2）。 */
const AUDIT_SOURCES = new Set(['gitHistory', 'traceability', 'incidents']);

/**
 * 受理侧历史占用校验（内部决策-061 D6，内部任务-227）：仅被审计源占据且无交付面痕迹的号拒绝复用；
 * 交付面占号维持现行（放行，续任务/让号）；degraded 时历史校验不完整——返回 null 由调用方
 * stderr 告警（D5.5），不阻断声明。
 * @param {string} taskId @param {string} key
 * @param {{resume?: boolean, resumeReason?: string, occupancy?: {used: Set<number>, bySource: Map<string, Set<number>>, degraded: Array<object>}}} [opts] occupancy 由调用方复用（避免二次扫描）
 * @returns {string|null} 拒因（null=放行）
 */
export function declarationHistoryRejection(taskId, key, opts = {}) {
  const m = DOMAIN_TASK_RE.exec(String(taskId));
  if (!m) return null;
  // 内部决策-045 段隔离（内部任务-227 阶段复审发现 1）：维护者段参与占用口径——三段号只在自身段内
  // 判定审计源占号，不得以异段历史/交付面误拒或误放。
  const occ = opts.occupancy ?? occupiedSeqsOfDomain(key, m[1], { maintainer: m[2] ?? null });
  if (occ.degraded.length > 0) {
    if (opts.occupancy === undefined) appendDegradedRecord(key, { sources: occ.degraded, context: { skill: null, taskId: String(taskId), sessionId: null } });
    return null;
  }
  const seq = Number(m[3]);
  const sources = [...occ.bySource.entries()].filter(([, set]) => set.has(seq)).map(([src]) => src);
  if (sources.length === 0) return null;
  if (!sources.every((s) => AUDIT_SOURCES.has(s))) return null;
  const resume = opts?.resume === true;
  const reason = String(opts?.resumeReason ?? '').trim();
  if (resume && reason.length >= 8 && readIssuedRows(key).some((r) => r.taskId === String(taskId))) return null;
  const why = resume && reason.length >= 8 ? 'resume 缺少 issued 台账历史 issuance' : '未提供续任务声明或理由不足 8 字';
  return `历史占用拒绝：${taskId} 仅被审计源占用（来源：${sources.join('/')}）——${why}；三路处置：①续用原任务：--resume-task --resume-reason "<≥8 字理由>"（须 issued 台账有历史 issuance）；②取新号：--suggest-task-id；③跨机/跨会话让号协议（ADR-045）。人工指定号须由人裁决，模型不得自行编造。`;
}

/**
 * 解析委派会话应继承的父链交付任务号（内部决策-061 D4 修正，内部任务-227）：以 issued 台账
 * append-only 为主（`{sessionId, taskId, parentSessionId?, inherited?}` 行），沿
 * `parentSessionId` 上溯 ≤3 层；state claim/active 仅作兜底。
 * @param {string} parentSessionId 父会话 id @param {number} depth 委派深度
 * @returns {{ok: boolean, taskId?: string, chain?: string[], reason?: string}}
 */
export function resolveInheritedTaskId(key, parentSessionId, depth) {
  const d = Number(depth);
  if (!Number.isSafeInteger(d) || d <= 0) return { ok: false, reason: '非委派会话（delegationDepth≤0）' };
  let cur = typeof parentSessionId === 'string' && parentSessionId ? parentSessionId : '';
  if (!cur) return { ok: false, reason: '父会话标识缺席（parent_session_id 不可见）' };
  const rows = readIssuedRows(key);
  let stateBodies = null;
  const readStateBodies = () => {
    if (stateBodies !== null) return stateBodies;
    try { stateBodies = readdirSync(stateRootFor(key)).filter((n) => n.startsWith('wf-lease-claim-') || n.startsWith('wf-lease-active-')).map((n) => readJson(join(stateRootFor(key), n))).filter(Boolean); } catch { stateBodies = []; }
    return stateBodies;
  };
  const chain = [];
  for (let hop = 0; hop < 3 && cur; hop += 1) {
    chain.push(cur);
    // 按 sessionId 取最新行（readIssuedRows 最新在前）：最新行带 taskId 即交付号；否则其
    // parentSessionId 作为链上行继续上溯（阶段复审 delta3：不得因更早 taskId 行跳过最新链上行）。
    const latest = rows.find((r) => r.sessionId === cur);
    if (latest && typeof latest.taskId === 'string') return { ok: true, taskId: latest.taskId, chain };
    const hit = readStateBodies().find((b) => b.sessionId === cur && typeof b.taskId === 'string');
    if (hit) return { ok: true, taskId: hit.taskId, chain };
    cur = latest && typeof latest.parentSessionId === 'string' ? latest.parentSessionId : '';
  }
  return { ok: false, reason: '父链不可解析（父会话未声明任务号或链超 3 层）' };
}

/** leaseId（capability token）合法形态：16-64 位十六进制——入文件名前必须校验（路径消毒）。 */
const TOKEN_RE = /^[0-9a-f]{16,64}$/;

/** 豁免来源合法取值（内部决策-020 / 内部接口-20）：user=用户当轮消息原文，preauthorized=事前授权已显式记录。 */
export const EXEMPT_SOURCES = ['user', 'preauthorized'];

/** shell 控制字符（bootstrap 严格解析的拒绝面）：元字符（管道/链式/重定向/反引号/命令替换）与分隔符（换行/分号）。 */
const SHELL_META_RE = /[|&><`]|\$\(/;
const SHELL_SEP_RE = /[\n\r;]/;

/**
 * 项目键消毒：sha256 前 16 位（v1 routing-lib.markerFile 同款摘要形态，不入文件名明文）。
 * @param {string} key 项目键（项目根绝对路径）
 */
function keyDigest(key) {
  return digest16(String(key)); // 内部任务-244 Q10：摘要实现单源（hook-lib.digest16）
}

/**
 * 会话键消毒：null 桶用字面量 'null'，其余按 's:<sessionId>' 摘要——会话 id 来自宿主
 * 负载，不可信值不得直接成为路径成分。
 * @param {string|null} sessionId
 */
function sessDigest(sessionId) {
  return sessionId ? keyDigest(`s:${sessionId}`) : 'null';
}

/** token 短展示（存储卫生：输出仅前 8 位，禁止完整 token 落日志/文案）。 */
function tokenShort(token) {
  return `${String(token).slice(0, 8)}…`;
}

/**
 * 状态文件路径：token 索引挑战 / 会话桶 current 指针 / token 索引激活租约 / legacy v2。
 * **2026-10-08 内部任务-20 A2/F7 按键解析**：带键的构造器一律走 `stateRootFor(key)`（项目级
 * opt-in 后挑战/租约落项目内根）；**只吃 token 的构造器**（`challengeTokenFile`/
 * `activeTokenFile`）接受可选 `key`——有键按键解析（跨域/多根场景的必经路径），无键时
 * 回落 `stateDir()`（cwd 根）以保既有调用面零改动。逐键同名不变量见 内部模块-8 §E。
 */
function challengeTokenFile(token, key = null) {
  return join(key ? stateRootFor(key) : stateDir(), `wf-lease-challenge-${token}.json`);
}
function currentFile(key, sessionId) {
  return join(stateRootFor(key), `wf-lease-current-${keyDigest(key)}-${sessDigest(sessionId)}.json`);
}
function activeTokenFile(token, key = null) {
  return join(key ? stateRootFor(key) : stateDir(), `wf-lease-active-${token}.json`);
}
/**
 * claim 文件路径（第 6 个状态文件，内部规则-19 ① / 内部任务-8 任务 4.2；注释按门 B F7 按真实机制更正）：
 * `wf-lease-claim-<keyDigest(key)>-<keyDigest('t:'+taskId)>.json`。
 * 隔离机制＝①族前缀 `wf-lease-claim-` 与 challenge/active/current/legacy 四族互斥；
 * ②两段 16 位 hex **位置化**（前段恒为键、后段恒为任务号），跨槽相等不构成混淆；
 * ③全仓无按文件名段解析的消费方（守卫/GC/释放一律读 JSON 体并按 projectKey+taskId 过滤）——
 * 故 digest 截断碰撞只可能落在「同键同号」上（＝同一占用，语义正确）。
 * `t:` 前缀为**防御性冗余**（projectKey 恒为绝对路径，可达输入内不可能等于 `t:<taskId>`）。
 */
function claimFile(key, taskId) {
  return join(stateRootFor(key), `wf-lease-claim-${keyDigest(key)}-${keyDigest(`t:${String(taskId)}`)}.json`);
}

/**
 * 签发侧挑战台账文件（内部任务-41，FIX-3 承接）：每次 issueChallenge 追加一行
 * {schemaVersion,ts,leaseId,sessionId,host,promptEpoch,expiresAt,root}——补「该
 * token 是否签发过/写到哪个根」审计缺口（激活侧 wf-issued 台账只记 {ts,taskId}，
 * 2026-10-11 两事故定位受阻的直接原因）。leaseId 全值入状态文件（与 current 指针
 * 同类面；存储卫生只约束输出文案）。append-only、坏行跳过、写失败静默（fail-open：
 * 台账损失不损失签发，wf-issued 同姿态）。sweep 各前缀族（challenge-/active-/claim-/
 * current-）均不匹配本前缀，无生命周期交互。
 */
function challengeLedgerFile(key) {
  return join(stateRootFor(key), `wf-challenges-${keyDigest(String(key))}.jsonl`);
}

/**
 * 台账反查（内部任务-41）：该令牌是否曾由本键签发——activateLease absent 拒因二分的
 * 数据源。倒序扫首条命中即返（同令牌重签不可能——token 为 128 位随机）；台账缺
 * 失/坏行/不可读一律 null（保守：视同未签发，走「疑似誊抄失真」文案——两态自纠
 * 路径相同，误分类只损失诊断精度不损失可行动性）。
 * @param {string} key 项目键 @param {string} leaseId 挑战令牌
 * @returns {object|null} 台账记录；未命中 null
 */
export function findChallengeIssuance(key, leaseId) {
  try {
    const lines = readFileSync(challengeLedgerFile(key), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue;
      try {
        const rec = JSON.parse(lines[i]);
        if (rec && rec.leaseId === String(leaseId)) return rec;
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 台账缺失/不可读：视同未签发面 */
  }
  return null;
}

/**
 * 键内在位挑战短令牌（内部任务-41）：扫本键全部 current 指针（不分桶——声明 CLI 侧无
 * 观察会话标识），取指向未过期挑战的 updatedAt 最新者，返回 8 位短显；无可行者
 * null。仅供 absent 拒因的自纠指引文案，不参与任何放行判定。
 * @param {string} key 项目键 @returns {string|null}
 */
function currentChallengeShort(key) {
  try {
    const dir = stateRootFor(key);
    const prefix = `wf-lease-current-${keyDigest(key)}-`;
    let best = null;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const ptr = readJson(join(dir, name));
      if (!ptr || !TOKEN_RE.test(String(ptr.leaseId ?? ''))) continue;
      const ch = readJson(challengeTokenFile(ptr.leaseId, key));
      if (!ch || Number(ch.expiresAt) < Date.now()) continue;
      if (!best || Number(ptr.updatedAt ?? 0) > Number(best.updatedAt ?? 0)) best = ptr;
    }
    return best ? tokenShort(best.leaseId) : null;
  } catch {
    return null;
  }
}

/**
 * 写占用登记（claim）：声明成功时建立；心跳时顺延 expiresAt。
 * **姿态**：写失败=占用降级为无（等同现状 active 扫描 fail-open，评审处置 #6：非缺陷而是姿态继承）——
 * 占用面永不阻断放行，只在撞号守卫里充当「占用事实」；写失败仅损失占用保护不损失写权限。
 * @param {string} key 项目键
 * @param {{taskId?: unknown, sessionId?: unknown, host?: unknown, declaredAt?: unknown, expiresAt?: unknown}} lease 租约体
 * @returns {boolean} 是否写盘成功
 */
function writeClaim(key, lease) {
  try {
    atomicWrite(claimFile(key, lease.taskId), claimBodyOf(key, lease));
    return true;
  } catch {
    return false;
  }
}

/** 占用登记体组装（内部任务-244 D01：writeClaim 与 acquireClaim 共用同一字段面，schemaVersion 4 不变）。 */
function claimBodyOf(key, lease) {
  return {
    schemaVersion: 4,
    projectKey: String(key),
    taskId: String(lease.taskId),
    sessionId: typeof lease.sessionId === 'string' && lease.sessionId ? lease.sessionId : null,
    host: typeof lease.host === 'string' && lease.host ? lease.host : 'unknown',
    claimedAt: Number(lease.declaredAt) || Date.now(),
    expiresAt: Number(lease.expiresAt),
    // 内部决策-061 修正案 1 第 3 条（内部任务-227）：续任务/人工审计字段随 claim 持久化。
    ...(lease.resumed === true ? { resumed: true, resumeReason: String(lease.resumeReason ?? '') } : {}),
    ...(lease.manual === true ? { manual: true, manualReason: String(lease.manualReason ?? '') } : {}),
  };
}

/**
 * 属主判等（内部任务-244 D01）：sessionId 双侧均已知才比对；host 双侧均已知且不同 → 异属主
 * （内部规则-19 ⑦ 交叉校验），缺失侧不可比 → 视为同属主（null 桶弱形态例外沿用既有权重）。
 * @param {object|null} claim 既有 claim
 * @param {object} lease 本次声明体
 * @returns {boolean}
 */
function sameClaimOwner(claim, lease) {
  const cs = typeof claim?.sessionId === 'string' && claim.sessionId ? claim.sessionId : null;
  const ls = typeof lease?.sessionId === 'string' && lease.sessionId ? lease.sessionId : null;
  if (cs === null || ls === null) return true;
  if (cs !== ls) return false;
  const ch = typeof claim?.host === 'string' && claim.host && claim.host !== 'unknown' ? claim.host : null;
  const lh = typeof lease?.host === 'string' && lease.host && lease.host !== 'unknown' ? lease.host : null;
  return !(ch !== null && lh !== null && ch !== lh);
}

/** 排他链接（内部任务-244 D01 注入缝：WF_CLAIM_FORCE_LINKFAIL=1 模拟硬链接不可用，生产零行为）。 */
function claimLink(tmp, target) {
  if (process.env.WF_CLAIM_FORCE_LINKFAIL === '1') {
    const e = new Error('forced link failure');
    e.code = 'EPERM';
    throw e;
  }
  return linkSync(tmp, target);
}

/** 过期/无效 claim 隔离回收（内部任务-244 D01）：先改名到 quarantine，失败才直删；失败不阻断。
 *  内部任务-348/内部未决-214①：rename 后复核用变体——返回隔离位路径（null＝隔离失败走旧兜底路径）。 */
function quarantineClaimFileRename(file) {
  try {
    const qdir = join(dirname(file), 'quarantine');
    mkdirSync(qdir, { recursive: true });
    const dest = join(qdir, `${basename(file)}.${Date.now()}`);
    renameSync(file, dest);
    return dest;
  } catch {
    try { rmSync(file, { force: true }); } catch { /* fail-open */ }
    return null;
  }
}

/**
 * 原子占用建立（内部任务-244 D01，内部规则-19 ①）：唯一 tmp 文件写完整 JSON → `linkSync` 排他落位；
 * EEXIST 后按属主分流（①同属主未过期→atomicWrite 刷新；②同属主已过期→quarantine 后单次
 * 重试 link；③其余一律撞号，**不得清理/改写**「读时不存在、link 时 EEXIST」的新建占位）。
 * 硬链接不可用（非 EEXIST 错误）→ 降级「wx 直建 + complete:true」读侧就绪标记。
 * @param {string} key 项目键
 * @param {object} lease 声明体（taskId/sessionId/host/declaredAt/expiresAt…）
 * @returns {{ok: boolean, mode: 'created'|'refreshed'|'degraded'|'conflict'|'failed', claim?: object}}
 */
export function acquireClaim(key, lease) {
  const target = claimFile(key, lease.taskId);
  const dir = dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, mode: 'failed' };
  }
  const body = claimBodyOf(key, lease);
  const tmp = join(dir, `.wf-claim-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(body), { flag: 'wx' });
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错 */ } // 内部任务-244 E05 纪律：失败无 tmp 残留
    return { ok: false, mode: 'failed' };
  }
  try {
    try {
      claimLink(tmp, target);
      return { ok: true, mode: 'created', claim: body };
    } catch (e) {
      if (e?.code !== 'EEXIST') {
        // 降级：硬链接不可用 → wx 直建 + 就绪标记（读侧 readClaim 拒绝 complete===false）
        try {
          writeFileSync(target, JSON.stringify({ ...body, complete: true }), { flag: 'wx' });
          return { ok: true, mode: 'degraded', claim: body };
        } catch (e2) {
          return { ok: false, mode: e2?.code === 'EEXIST' ? 'conflict' : 'failed' };
        }
      }
      const existing = readJson(target);
      if (!existing) return { ok: false, mode: 'conflict' }; // 读不到/半写：撞号，不清理
      const exp = Number(existing.expiresAt);
      if (!Number.isFinite(exp)) {
        // 半损坏/不可判（NaN 安全侧「误放非误拒」，与守卫口径一致）：沿用旧 writeClaim 的覆写
        // 语义重建占位；文件保留（sweep 不删不可判证据）。
        try {
          atomicWrite(target, body);
          return { ok: true, mode: 'refreshed', claim: body };
        } catch {
          return { ok: false, mode: 'failed' };
        }
      }
      if (!sameClaimOwner(existing, lease)) return { ok: false, mode: 'conflict', claim: existing };
      // 内部任务-244 阶段门正确性评审 #6：硬链接降级形态（SMB/FAT，complete:true）同属主重声明须可刷新
      if (existing.complete === true && exp > Date.now()) {
        try {
          atomicWrite(target, { ...body, complete: true, claimedAt: Number(existing.claimedAt) || body.claimedAt });
          return { ok: true, mode: 'refreshed', claim: body };
        } catch {
          return { ok: false, mode: 'failed' };
        }
      }
      if (exp > Date.now()) {
        // 同属主未过期 → 原子替换刷新（同属主覆写不破坏互斥）
        try {
          atomicWrite(target, { ...body, claimedAt: Number(existing.claimedAt) || body.claimedAt });
          return { ok: true, mode: 'refreshed', claim: body };
        } catch {
          return { ok: false, mode: 'failed' };
        }
      }
      // 同属主已过期（或半损坏不可判）→ 隔离后单次重试（仍 EEXIST 即撞号）
      // 内部任务-348/内部未决-214①：隔离采 activateLease 撞号守卫（内部任务-244）同款**双段复核**——
      // ① rename 前复核：文件被并发方刷新（未过期）则不隔离，按撞号返回；
      // ② rename 后复核：隔离位重读仍过期才落定，未过期（复核与 rename 间被续期）即回滚
      //    rename 并按 EEXIST 重试——消灭「复核通过→rename」残余窗。
      if (process.env.WF_CAS_INJECT_QUARANTINE_REFRESH === '1') {
        // 测试缝：模拟「读判之后、隔离之前」并发方刷新 claim 为未过期
        try {
          atomicWrite(target, { ...existing, expiresAt: Date.now() + 3600000, claimedAt: Number(existing.claimedAt) || Date.now() });
        } catch { /* 注入缝 */ }
      }
      const existingNow = readJson(target);
      if (existingNow && Number.isFinite(Number(existingNow.expiresAt)) && Number(existingNow.expiresAt) > Date.now()) {
        recordLeaseReadAnomaly(String(key), 'claim', 'cas-stale-window', {});
        return { ok: false, mode: 'conflict', claim: existingNow };
      }
      const quarantinedTo = quarantineClaimFileRename(target);
      if (quarantinedTo !== null) {
        // 测试缝（值 2，三维正确性维发现 1 用例形态）：模拟「隔离 rename 之后、隔离位重读之前」
        // 旧属主续期＋第三方在原位新建——命中回滚分支并检验回滚不覆盖新占用方。
        if (process.env.WF_CAS_INJECT_QUARANTINE_REFRESH === '2') {
          try {
            atomicWrite(quarantinedTo, { ...existing, expiresAt: Date.now() + 3600000, claimedAt: Number(existing.claimedAt) || Date.now() });
            atomicWrite(target, { ...existing, sessionId: 'sess-rebuilder', host: 'rebuild', claimedAt: Date.now(), expiresAt: Date.now() + 3600000 });
          } catch { /* 注入缝 */ }
        }
        const inQuarantine = readJson(quarantinedTo);
        if (inQuarantine && Number.isFinite(Number(inQuarantine.expiresAt)) && Number(inQuarantine.expiresAt) <= Date.now()) {
          // 仍过期：隔离落定
        } else {
          // 隔离位显示未过期（rename 前后间被续期）——回滚，按撞号返回。回滚经 hardlink 探路
          // （三维正确性维发现 1）：rename 无条件覆盖会把 rename-away 与复核间在原位新建的
          // 并发方 claim 静默吞掉；linkSync 对已存在 target 抛 EEXIST → 放弃回滚留隔离位
          // （新占用方优先，隔离件可人工恢复），link 成功后删隔离件（同 inode 双名收敛）。
          try {
            linkSync(quarantinedTo, target);
            try { rmSync(quarantinedTo, { force: true }); } catch { /* 隔离件删除尽力 */ }
          } catch { /* target 已被并发方重建（EEXIST）或其他失败：留隔离位，不覆盖新占用 */ }
          recordLeaseReadAnomaly(String(key), 'claim', 'cas-stale-window', {});
          return { ok: false, mode: 'conflict', claim: inQuarantine ?? existingNow };
        }
      }
      try {
        claimLink(tmp, target);
        return { ok: true, mode: 'created', claim: body };
      } catch (e2) {
        return { ok: false, mode: e2?.code === 'EEXIST' ? 'conflict' : 'failed' };
      }
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* 临时件尽力清理 */ }
  }
}

/** 读占用登记；不存在/损坏/未完成态返回 null（半损坏由调用方按 NaN 安全侧处置）。 */
function readClaim(key, taskId) {
  const body = readJson(claimFile(key, taskId));
  if (!body || body.complete === false) return null;
  return body;
}
function legacyChallengeFile(key) {
  return join(stateRootFor(key), `wf-lease-challenge-${keyDigest(key)}.json`);
}
function legacyActiveFile(key) {
  return join(stateRootFor(key), `wf-lease-active-${keyDigest(key)}.json`);
}

/** 跨域请求登记面（内部任务-20 A2/F6，内部决策-018 修正案）：每会话在册请求上限。 */
export const DOMAIN_REQUEST_MAX = 3;
/** 跨域请求有效期（毫秒）：超期请求不再并入签发键集。 */
export const DOMAIN_REQUEST_TTL_MS = 30 * 60 * 1000;

/** 请求登记面文件（按请求方键的解析根；逐键同名不变量见 内部模块-8 §E）。 */
function domainRequestsFile(key) {
  return join(stateRootFor(key), 'wf-domain-requests.jsonl');
}

/**
 * 读跨域请求：坏行跳过、同 `id` 取最新、按 TTL / 会话 / host 过滤（host 侧 unknown/缺失宽容——内部任务-31）；已授予项标 `granted`。
 * TTL 过滤在**本函数内**（调用方不得自行判期）。
 * @param {string} key 请求方键
 * @param {{now?: number, ttlMs?: number, sessionId?: string|null, host?: string|null}} [o] 过滤面
 * @returns {Array<object>} 过滤后的请求记录（含 `granted` 标注）
 */
export function readDomainRequests(key, { now = Date.now(), ttlMs = DOMAIN_REQUEST_TTL_MS, sessionId = null, host = null } = {}) {
  const file = domainRequestsFile(key);
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（容错语义与账本读侧一致）
    }
    if (!rec || typeof rec.id !== 'string' || !rec.id) continue;
    const prev = byId.get(rec.id) ?? {};
    // **先按键合并、后过滤**（收尾评审阻塞 1 的第二半）：授予行只带 `{id,ts,grantedAt}`，
    // 无 sessionId/host ⇒ 若逐行先做会话过滤，授予行会被整行丢掉、`granted` 永不置真。
    byId.set(rec.id, { ...prev, ...rec, granted: Boolean(prev.granted || rec.grantedAt) });
  }
  const out = [];
  for (const rec of byId.values()) {
    if (!(Number(rec.ts) > 0) || now - Number(rec.ts) > ttlMs) continue;
    if (typeof rec.targetKey !== 'string' || !rec.targetKey) continue; // 孤儿授予行不构成请求
    if (sessionId !== null && String(rec.sessionId ?? '') !== String(sessionId)) continue;
    // host 双比对 unknown/缺失侧宽容（内部任务-31，内部规则-8 双比句修订）：对齐 sessionMatches
    // 「仅显式异宿才拒绝」模式（内部决策-040 决策 3——host 是审计与消歧字段而非隔离维度），
    // 且 'unknown'=探测不可判定、与缺失同视；双侧均为已知宿主且不同才过滤。
    const recHost = typeof rec.host === 'string' && rec.host ? rec.host : null;
    const wantHost = typeof host === 'string' && host ? host : null;
    const recKnown = recHost !== null && recHost !== 'unknown';
    const wantKnown = wantHost !== null && wantHost !== 'unknown';
    if (recKnown && wantKnown && recHost !== wantHost) continue;
    out.push(rec);
  }
  return out;
}

/**
 * 落一条请求（追加写）。**上限判定由调用方先行**（本函数只负责写盘并回读记录）。
 * @param {{key: string, targetKey: string, targetRoot: string, sessionId: string, host: string, ts?: number, id?: string}} req
 * @returns {{ok: boolean, record?: object, error?: string}}
 */
export function writeDomainRequest({ key, targetKey, targetRoot, sessionId, host, ts = Date.now(), id = randomBytes(8).toString('hex') }) {
  const record = {
    id,
    targetKey: String(targetKey),
    targetRoot: String(targetRoot),
    sessionId: String(sessionId),
    host: String(host),
    ts,
  };
  try {
    const file = domainRequestsFile(key);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * 授予留痕（审计行；授予后该请求即消费——`markRequestGranted` 之后读侧标 `granted`）。
 * @param {string} key 请求方键
 * @param {string} id 请求 id
 * @param {number} [ts] 授予时刻
 * @returns {boolean} 是否写盘成功
 */
export function markRequestGranted(key, id, ts = Date.now()) {
  try {
    const file = domainRequestsFile(key);
    mkdirSync(dirname(file), { recursive: true });
    // `ts` 必须随行——读侧按 `Number(rec.ts) > 0` 过滤，缺 ts 的标记行会被整行跳过，
    // 使 `granted` 永远为 false（"授予后请求即消费"落空，收尾评审阻塞 1）。
    appendFileSync(file, `${JSON.stringify({ id, ts, grantedAt: ts })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * capability 反查挑战归属（内部任务-20 A2/F6）：由令牌得 `{projectKey, sessionId, host}`，供跨域
 * 请求绑定会话——Bash 侧无会话标识（内部决策-018 既有结论），故请求方以**自己的租约令牌**自证。
 * @param {string} leaseId 租约令牌
 * @param {string|null} [key] 令牌所属键（调用方按 cwd/`--project-root` 推导；缺省回落 cwd 根）
 * @returns {{projectKey: string, sessionId: string|null, host: string}|null}
 */
export function challengeOwnerInfo(leaseId, key = null) {
  const ch = readJson(challengeTokenFile(String(leaseId), key));
  if (!ch || typeof ch.projectKey !== 'string' || !ch.projectKey) return null;
  // 过期挑战不得再自证会话身份（授权面：内部决策-018 第 4 条「授权非自授」依赖此反查）——
  // 过期但未被 sweep 的挑战仍可读，故须在此显式判期（收尾评审约定项 9）。
  if (!(Number(ch.expiresAt) > Date.now())) return null;
  return {
    projectKey: ch.projectKey,
    sessionId: typeof ch.sessionId === 'string' && ch.sessionId ? ch.sessionId : null,
    host: typeof ch.host === 'string' && ch.host ? ch.host : 'unknown',
    // 内部决策-070 D4（内部任务-341）：继承声明解析父租约所需委派字段（挑战体 v5 面；旧挑战缺省回退）。
    delegationDepth: Number.isSafeInteger(ch.delegationDepth) && ch.delegationDepth > 0 ? ch.delegationDepth : 0,
    parentSessionId: typeof ch.parentSessionId === 'string' && ch.parentSessionId ? ch.parentSessionId : null,
    inheritTaskId: typeof ch.inheritTaskId === 'string' && ch.inheritTaskId ? ch.inheritTaskId : null,
  };
}

/**
 * 声明后闸侧可达性判定（内部任务-24 D4，内部任务-99）：activateLease 成功 ≠ 闸可达——指针/桶
 * 状态损坏或错配时真会话按读侧判定看不见，「Bash/Edit/Write 放行」承诺即成假象（内部任务-99
 * 排障多绕数轮的误导源）。判据=以挑战签发方会话（challengeOwnerInfo 反查，null 桶挑战则
 * null 观察侧——可见面最窄的保守口径）回读 readActiveLease；判据由读侧结果自身推导，
 * 不做裸指针比对（防自指恒真，viaNullNote 先例）。只读无副作用，供声明 CLI 成功路径自检。
 * @param {string} key 项目键 @param {string} leaseId 令牌 @param {number} [now]
 * @returns {{ok: true} | {ok: false, reason?: string}} 可达/不可达（reason 透传读侧拒因）
 */
export function activationReachability(key, leaseId, now = Date.now()) {
  const owner = challengeOwnerInfo(leaseId, key);
  const observer = owner && typeof owner.sessionId === 'string' && owner.sessionId ? owner.sessionId : null;
  const reach = readActiveLease(key, now, { sessionId: observer });
  return reach.valid ? { ok: true } : { ok: false, reason: reach.reason ?? undefined };
}

/**
 * 原子写（唯一临时文件 + rename；与 mode-state 同款尽力原子）。
 * 内部任务-244 E05：失败路径必须清掉唯一 tmp——原实现 catch 全无，tmp 写入后 rename 失败会
 * 在状态根留下 `.tmp` 残件（清理义务目前只由 sweep 的按族前缀扫描兜底，`.tmp` 不在族内）。
 */
function atomicWrite(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(obj));
    // 测试注入缝：模拟「tmp 已写、rename 前」失败（生产零行为）
    if (process.env.WF_FORCE_ATOMIC_WRITE_FAIL === '1') throw new Error('forced atomic write failure');
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错 */ }
    throw err;
  }
}

/** 读 JSON 文件；任何失败返回 null（损坏一律按无效处理，不抛）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 三态读 JSON（诊断专用，内部任务-27 坑1）：'ok' / 'absent'（existsSync 前置分流 + 读时
 * ENOENT/ENOTDIR——并发删除/路径组件被替换＝读时缺席，同 readViaPointer 的
 * UNACTIVATED 分层与 routing-lib readProjectRoutingConfig 的 absent/unparsable/malformed
 * 先例）/ 'corrupt'（其余 readFileSync 异常或 JSON.parse 失败——readJson 的 catch 全吞
 * 语义收窄到此态）。仅诊断点使用（verifyChallengeOnDisk / activateLease /
 * readViaPointer）；其余 readJson 调用面不动（YAGNI）。
 * FIX-2 异象①根因＝errno 被吞使「真不存在」与「读失败」不可分，本函数按态分化。
 * @param {string} file 文件路径
 * @returns {{state: 'ok', value: object} | {state: 'absent'|'corrupt', value: null}}
 */
function readJsonState(file) {
  if (!existsSync(file)) return { state: 'absent', value: null };
  try {
    return { state: 'ok', value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    // existsSync 命中后的窗口内被并发删除（桶内轮换 rmSync/清理，ENOENT）或路径组件被
    // 替换（ENOTDIR，读时不可达）＝读时缺席非损坏——按 errno 分流，防把正常轮换误诊为
    // 磁盘故障落 spurious corrupt 取证（阶段复审正确性发现 2 / 终审正确性发现 1 同族）。
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent', value: null };
    return { state: 'corrupt', value: null };
  }
}

/** 取证环境名单（内部任务-27 坑3，presence-only）：只记「在/不在」不取值——同 hostOf
 * 前缀探测的脱敏思路；覆盖状态根/事件账注入缝、插件根、项目锚、宿主会话标识五类
 * 进程上下文差异候选（FIX-2 异象①未闭合项「声明 CLI 进程上下文瞬态读失败」的取证面，
 * 登记于 内部接口-19 §2）。 */
const ANOMALY_ENV_VARS = Object.freeze([
  'WF_ROUTING_STATE_DIR', 'WF_INCIDENT_ROOT', 'WF_ROUTING_TTL_MS',
  'ZCODE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'ZCODE_PROJECT_DIR',
  'ZCODE_SESSION_ID', 'DSH_SESSION_ID',
  // 内部任务-348/内部未决-214①：CAS 注入缝入名单（presence-only 标记——误设时可归因排除注入源；
  // 缝会实改盘态属主，产出 cas-stale-window anomaly 需可甄别）。内部任务-244 遗留两缝
  // （WF_CLAIM_FORCE_LINKFAIL/WF_SWEEP_CLAIM_RACE_REWRITE 同为实改行为注入面）三维终评同批补入。
  'WF_CAS_INJECT_CLAIM_SWAP', 'WF_CAS_INJECT_QUARANTINE_REFRESH',
  'WF_HEARTBEAT_RACE_DELETE', 'WF_REVIVE_RACE_DELETE',
  'WF_CLAIM_FORCE_LINKFAIL', 'WF_SWEEP_CLAIM_RACE_REWRITE',
]);

/**
 * 租约族记录的分类字段（内部决策-063 修正案 3 决策 23.2，内部任务-195）：`lease-read-anomaly` /
 * `lease-revive` 等写者**一律经 classifyFact**（规则表 r-lease-trace ⇒ mechanism-trace/info），
 * 禁止内联规则常量（规则表版本化后，内联副本必然漂移）。classifyFact 未命中时按规范回退
 * `cause=unclassified`，severity 回退 info（保守：留痕不冒充产品缺陷）。
 * @param {string} kind 记录 kind（规则表匹配键）
 * @param {string} observationSource 观测来源短标识（`hook:...` 形态）
 * @returns {{cause: string, severity: string, ruleId: string|null, rulesVersion: number, observationSource: string}}
 */
function leaseClassification(kind, observationSource) {
  const cls = classifyFact({ kind });
  return {
    cause: cls?.cause ?? 'unclassified',
    severity: cls?.severity ?? 'info',
    ruleId: cls?.ruleId ?? null,
    rulesVersion: loadRules().rulesVersion,
    observationSource,
  };
}

/**
 * 读侧取证埋点（内部任务-27 坑3，kind=lease-read-anomaly，内部接口-19 §2 登记）：
 * 挑战/激活文件 corrupt、或激活时挑战 absent（F7 双根诊断现场）时落一条 incident——
 * 闸侧（readActiveLease 路径）与声明侧（activateLease）各自记录本进程视图，
 * stateRootDigest/envDigest 供跨进程比对（FIX-2 异象①：同刻闸侧可读、声明侧读失败）。
 * 分钟桶幂等同 ld-/br- 先例；appendIncident 契约 {ok:false} 不抛，不设兜底 try/catch。
 * @param {string} key 项目键 @param {'challenge'|'lease'} fileKind
 * @param {'corrupt'|'absent'} state @param {{recovered?: boolean}} [extra] recovered 仅 corrupt 携带（首腐后好翻转取证）
 */
/** 状态件仍存在且令牌一致（内部任务-244 D03/D04 写回前复核：轮换/清理删除后不得回写复活）。 */
function leaseFileHasToken(file, leaseId) {
  const body = readJson(file);
  return !!body && String(body.leaseId ?? '') === String(leaseId ?? '');
}

function recordLeaseReadAnomaly(key, fileKind, state, extra = {}) {
  const rec = {
    id: `lra-${digestOf(['lease-read-anomaly', keyDigest(String(key)), fileKind, state, Math.floor(Date.now() / 60000)])}`,
    ts: Date.now(),
    session: null, taskId: null, skill: null, plugin: 'workflow',
    kind: 'lease-read-anomaly',
    host: hostOf({}),
    tool: null, event: null,
    fileKind, state,
    digest: digestOf(['lease-read-anomaly', keyDigest(String(key)), fileKind, state]),
    stateRootDigest: digestOf([stateRootFor(String(key))]),
    envDigest: digestOf(ANOMALY_ENV_VARS.filter((n) => process.env[n] !== undefined)),
    ...leaseClassification('lease-read-anomaly', 'hook:task-lease'),
  };
  if (typeof extra.recovered === 'boolean') rec.recovered = extra.recovered;
  appendIncident(canonicalRoot(String(activationRoot(String(key)) ?? key)), rec);
}

/**
 * 损坏件计龄隔离（内部未决-86，内部任务-46）：解析失败的状态件 mtime 距今超过当前 TTL 即迁
 * quarantine/ 子目录（证据保留不删——「不可判定不静默删证据」立场不变，超龄即出扫描面；
 * TTL 内新鲜损坏不动——容忍瞬态写入）。撞名追加 mtime 后缀；单件失败自吞（不破 sweep 主循环）。
 */
function quarantineIfStale(dir, name) {
  try {
    const file = join(dir, name);
    const { mtimeMs } = statSync(file);
    if (Date.now() - mtimeMs <= ttlMs()) return;
    const qdir = join(dir, 'quarantine');
    mkdirSync(qdir, { recursive: true });
    let target = join(qdir, name);
    if (existsSync(target)) target = join(qdir, `${name}.${mtimeMs}`);
    renameSync(file, target);
  } catch {
    /* fail-open：隔离是非关键路径，单件失败不影响其余清理 */
  }
}

/**
 * 过期件删除（内部任务-244 D02/D03/D04）：先原子改名到 quarantine 再复核——复核仍满足过期判据
 * 才物理删；不满足（并发续期/重建）则回滚改名。避免「读快照→删除」窗口误删并发写入的新件。
 * @param {string} dir 状态根 @param {string} name 文件名 @param {(body:object)=>boolean} stillExpired 复核判据
 * @returns {boolean} 是否删除
 */
function rmExpiredAfterRecheck(dir, name, stillExpired) {
  const file = join(dir, name);
  try {
    const qdir = join(dir, 'quarantine');
    mkdirSync(qdir, { recursive: true });
    const q = join(qdir, `${name}.${Date.now()}.${process.pid}`);
    renameSync(file, q);
    const body = readJson(q);
    if (!body || !stillExpired(body)) {
      try { renameSync(q, file); } catch { /* 回滚失败：隔离件留存（不静默删证据） */ }
      return false;
    }
    rmSync(q, { force: true });
    return true;
  } catch {
    return false; // fail-open：单件失败不影响 sweep 主循环
  }
}

/**
 * 清理过期租约状态（签发时顺带执行，内部决策-018 清理义务；内部任务-8 任务 4.4 扩面）。
 * 范围=**全目录扫描**（内部决策-040 全局命名空间语义：跨项目过期项回收义务，磁盘 4 条 9/20–10/6 实证）：
 * 过期挑战 / 过期激活租约 / 过期 claim / 悬空 current 指针（指针仍按本键前缀——指针是键内概念）。
 * 半损坏 claim（expiresAt 非数值）**不清**：不可判定不静默删证据（NaN 安全侧）。
 * 解析失败（readJson null）四类件超 TTL 计龄隔离入 quarantine/（内部未决-86，内部任务-46）。
 * 清理失败静默（fail-open 家族，与既有 sweep 的 catch 全吞一致——评审处置 #3）。
 * @param {string} key 项目键（仅 current 指针扫描用；三类状态文件已是全目录）
 */
function sweepExpiredChallenges(key) {
  try {
    const dir = stateRootFor(key);
    const keyPrefix = `wf-lease-current-${keyDigest(key)}-`;
    const currents = new Map(); // 本项目 current 指针：sessDigest → 指针对象
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (name.startsWith('wf-lease-challenge-')) {
        const ch = readJson(join(dir, name));
        if (!ch) quarantineIfStale(dir, name);
        else if (Number(ch.expiresAt) < now) rmExpiredAfterRecheck(dir, name, (b) => Number(b.expiresAt) < Date.now());
      } else if (name.startsWith('wf-lease-active-')) {
        const lease = readJson(join(dir, name));
        if (!lease) quarantineIfStale(dir, name);
        else if (Number(lease.expiresAt) < now) rmExpiredAfterRecheck(dir, name, (b) => Number(b.expiresAt) < Date.now());
      } else if (name.startsWith('wf-lease-claim-')) {
        const claim = readJson(join(dir, name));
        if (!claim) quarantineIfStale(dir, name);
        else {
          const exp = Number(claim?.expiresAt);
          if (Number.isFinite(exp) && exp < now) {
            rmExpiredAfterRecheck(dir, name, (b) => {
              const e = Number(b.expiresAt);
              return Number.isFinite(e) && e < Date.now();
            });
          }
        }
      } else if (name.startsWith(keyPrefix)) {
        const ptr = readJson(join(dir, name));
        if (ptr) currents.set(name, ptr);
        else quarantineIfStale(dir, name);
      }
    }
    // current 指针：指向的挑战已不存在或已过期 → 指针失效删除
    for (const [name, ptr] of currents) {
      if (!ptr.leaseId || !TOKEN_RE.test(String(ptr.leaseId ?? ''))) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      const ch = readJson(challengeTokenFile(ptr.leaseId, key));
      if (!ch || Number(ch.expiresAt) < Date.now()) rmSync(join(dir, name), { force: true });
    }
    // 占位登记物理清理（内部决策-050 D2，内部任务-62）：「未跟踪且（released 或 claimed＋过期）」
    // 的占位文件删除——已跟踪占位永不物理删（跨机审计面）。探测失败（null）跳过本轮
    // 删除（终审发现：瞬态失败不得转化为工作树删除——占用侧按未跟踪回落是 D2 明文
    // 宽松侧，删除侧与「永不物理删」不变量冲突）。
    try {
      const staleOrReleased = readClaimMarkers(key).filter((m) => m.status === 'released' || isStaleClaim(m));
      if (staleOrReleased.length > 0) {
        const trackedProbe = trackedPaths(key, staleOrReleased.map((m) => claimRelPath(m.taskId)));
        const tracked = trackedProbe.status === 'degraded' ? null : (trackedProbe.tracked ?? new Set());
        if (tracked !== null) {
          let seamDone = false;
          const claimSec = secureClaimsDir(key); // 内部任务-244 遗留项⑤：越界 claims 目录不跟随（拒绝删仓外文件）
          for (const m of staleOrReleased) {
            if (tracked.has(claimRelPath(m.taskId))) continue;
            if (!claimSec.ok) continue;
            const file = join(claimSec.dir, `${m.taskId}.json`);
            // 测试注入缝：快照后并发重写为新 fresh 占位（生产零行为）
            if (!seamDone && process.env.WF_SWEEP_CLAIM_RACE_REWRITE === '1') {
              seamDone = true;
              try {
                writeFileSync(file, JSON.stringify({
                  schemaVersion: 1, taskId: m.taskId, skill: 'tdd', ts: Date.now(), host: 'dsh',
                  status: 'claimed', expiresAt: Date.now() + 3600000,
                }));
              } catch { /* 注入缝失败不阻断 */ }
            }
            // 内部任务-244 D02：删除前**重读并比对快照**（status/expiresAt/sessionDigest）——不一致
            // 即放弃删除（快照后被并发重写的新占位不得误删）。
            let current = null;
            try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 不可读 → 不删 */ }
            const sameSnapshot = current !== null
              && String(current.status ?? '') === String(m.status ?? '')
              && Number(current.expiresAt) === Number(m.expiresAt)
              && (current.sessionDigest ?? null) === (m.sessionDigest ?? null);
            if (!sameSnapshot) continue;
            rmSync(file, { force: true });
          }
        }
      }
    } catch {
      /* claims 清理失败不阻断 sweep（fail-open） */
    }
  } catch {
    /* fail-open：清理是非关键路径 */
  }
}

/**
 * 工作区 git 仓键发现（2026-09-16 租约族缺陷批次，W3 丙案回退路径）：自工作区根
 * 向下枚举含 .git 的目录（排除 node_modules 与 .git 内部，深度限 6），返回 git 仓根
 * 集合——多仓工作区对全部仓键同轮签发，保证签发键集 ⊇ 闸可达键集（闸键来自
 * 文件/cwd 的 git 祖先 ∪ 显式接入标记根，内部决策-026）。结果按 {workspaceRoot, repos,
 * scannedAt} 缓存 5 分钟（wf-repos-cache.json，写入失败只损失性能不损失正确性——
 * 重扫兜底）。
 * @param {string} root 工作区根
 * @returns {string[]} git 仓根绝对路径集合（含 root 自身若为仓；无仓返回空数组）
 */
/** 工作区发现共享骨架（2026-09-19 收尾评审 S3 抽取）：深度上限/排除面/5 分钟缓存对
 * git 仓键与标记域键两个发现面单源——两者共同维护「签发键集 ⊇ 闸可达键集」不变量
 * （H3 修复核心），骨架拷贝会让深度/排除面调整在两侧行为静默分叉。
 * @param {object} p 参数
 * @param {string} p.base 工作区根（resolve 后）
 * @param {string} p.cacheFile 缓存文件路径
 * @param {string} p.arrayKey 缓存 JSON 内的结果数组键名
 * @param {(sub: string, walkState: unknown, out: string[]) => unknown} p.enter 进入判定：
 *        对根目录以 walkState=null 调用一次（根自身入列判定），此后对每个子目录调用
 *        （含收集副作用），返回值作为该子树下探的 walkState
 * @returns {string[]}
 */
function discoverWithCache({ base, cacheFile, arrayKey, enter }) {
  const DISCOVER_MAX_DEPTH = 6;
  // 内部任务-244 P07：缓存改**多槽**（键＝workspaceRoot）——原单槽 {workspaceRoot,...} 在多个
  // 工作区共用同一状态根时互相顶掉（每切一次工作区即全量重扫）；槽超 5 分钟失效、写时剪枝。
  const readBody = () => {
    const body = readJson(cacheFile);
    return body && typeof body === 'object' && body.slots && typeof body.slots === 'object'
      ? body
      : null;
  };
  const body = readBody();
  const slot = body?.slots?.[base];
  if (
    slot &&
    Array.isArray(slot[arrayKey]) &&
    slot[arrayKey].every((r) => typeof r === 'string') &&
    Date.now() - Number(slot.scannedAt) < 5 * 60 * 1000
  ) {
    return slot[arrayKey];
  }
  const out = [];
  const walk = (dir, depth, state) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过（发现是非关键路径）
    }
    for (const e of entries) {
      const sub = join(dir, e.name);
      // 内部任务-244 C04：符号链接目录也参与仓键发现（isSymbolicLink 时 statSync 目标确认）——
      // 工作区用 symlink 引用仓目录时，签发键集须覆盖闸可达键。目标不可解析则跳过。
      const dirLike = e.isDirectory()
        || (e.isSymbolicLink() && (() => {
          try {
            return statSync(sub).isDirectory();
          } catch {
            return false;
          }
        })());
      if (!dirLike || e.name === '.git' || e.name === 'node_modules') continue;
      const nextState = enter(sub, state, out); // 进入判定：返回下探状态（含收集副作用）
      if (depth < DISCOVER_MAX_DEPTH) walk(sub, depth + 1, nextState);
    }
  };
  const initialState = enter(base, null, out); // 根目录自身判定（null 状态=根层）
  walk(base, 0, initialState);
  try {
    // 多槽合并写：保留其他工作区未过期槽（≤24 槽有界），当前槽覆盖。
    const prev = readBody();
    const slots = { ...(prev?.slots ?? {}) };
    for (const [k, v] of Object.entries(slots)) {
      if (!(Number(v?.scannedAt) > 0) || Date.now() - Number(v.scannedAt) > 5 * 60 * 1000) delete slots[k];
    }
    slots[base] = { [arrayKey]: out, scannedAt: Date.now() };
    const keys = Object.keys(slots);
    for (const k of keys.slice(0, Math.max(0, keys.length - 24))) delete slots[k];
    atomicWrite(cacheFile, { schemaVersion: 1, slots });
  } catch {
    /* 缓存写失败静默——重扫兜底 */
  }
  return out;
}

export function discoverRepoKeys(root) {
  // base 归一（内部任务-MACKEY-1）：签发键集须与闸可达键集（git 祖先 canonical 归一）同形态，
  // 否则 macOS symlink 形态分裂下多仓签发漏闸键；缓存 workspaceRoot 随归一值变化失效一次重扫，无害。
  const base = canonicalRoot(String(root));
  return discoverWithCache({
    base,
    cacheFile: join(stateRootFor(root), 'wf-repos-cache.json'),
    arrayKey: 'repos',
    enter: (sub, state, out) => {
      const isRepo = existsSync(join(sub, '.git'));
      if (isRepo) out.push(sub); // 仓内还可能嵌套仓，继续下探（无分层语义，状态恒 null）
      return null;
    },
  });
}

/**
 * 工作区标记域键发现（2026-09-19 评审修复 H3）：自工作区根向下枚举显式接入标记根
 * （isMarkerRoot：.scout/mode.json 或 .sdd/，判据与 routing-lib.markerAncestor 同源），
 * 返回非 git 侧的标记根集合——内部决策-026 放宽后闸可达键含标记根（activationRoot =
 * git 祖先 ?? 标记祖先），签发侧漏标记键会在锚定多仓工作区内形成「声明永不满足闸」
 * 的永久 deny 死循环。git 仓内部的标记目录不收集（仓内文件的闸键恒取 git 祖先，
 * 标记祖先在仓内不可达——收集只会产生无消费方的噪音键）。骨架与 git 侧共用
 * discoverWithCache（收尾评审 S3），缓存 5 分钟（wf-markers-cache.json）。
 * @param {string} root 工作区根
 * @returns {string[]} 标记根绝对路径集合（含 root 自身若为标记根；无标记返回空数组）
 */
export function discoverMarkerKeys(root) {
  // base 归一同 discoverRepoKeys（内部任务-MACKEY-1）：标记域键与闸键同形态。
  const base = canonicalRoot(String(root));
  return discoverWithCache({
    base,
    cacheFile: join(stateRootFor(root), 'wf-markers-cache.json'),
    arrayKey: 'markers',
    enter: (sub, insideRepo, out) => {
      const subIsRepo = existsSync(join(sub, '.git'));
      // 根层（insideRepo===null）：base 自身按标记根判定入列；子层：只收非 git 侧标记
      if (insideRepo === null) {
        if (isMarkerRoot(sub) && !subIsRepo) out.push(sub);
        return subIsRepo;
      }
      if (!insideRepo && !subIsRepo && isMarkerRoot(sub)) out.push(sub);
      return insideRepo || subIsRepo;
    },
  });
}

/**
 * 签发键集单源（2026-10-09 内部任务-24 D3 自 user-prompt.mjs 迁入，函数体原样）：UserPromptSubmit
 * 签发侧与 routing-gate 逐键清单侧**严格同源**的键集推导——签发/诊断两侧任何分叉都会让
 * deny 清单与实际签发面不一致（多键容错的历史教训见原注释）。迁移动机：gate 消费
 * issuanceKeys 而它此前只存在于 user-prompt（hook 互相 import 不如协议库单源）。
 * @param {string} cwd 负载 cwd
 * @returns {string[]} 签发键集合（canonical 形态，去重）
 */
export function issuanceKeys(cwd) {
  const anchor = workspaceRootAnchor();
  if (anchor) {
    // 标记域键（2026-09-19 评审修复 H3）：非 git 的 内部治理状态 接入项目与 git 仓同轮签发
    const markerKeys = discoverMarkerKeys(anchor);
    const anchorRepo = gitAncestor(anchor);
    if (anchorRepo) {
      // 锚仓内部可能嵌套仓（submodule/vendored）——Edit/Write 键控按文件 git 祖先，
      // 漏签嵌套键会让嵌套仓编辑回到 W3 死锁形态；锚仓+仓内嵌套仓同轮签发
      //（评审 C1 处置；无嵌套时 discoverRepoKeys 恰返回 [锚仓]，输出与单键形态一致）。
      // 2026-09-26 内部任务-LEASEATT-1：并集 cwd 域键——锚可见但指错仓（漂移实录）时实际
      // 工作仓（闸执法键）无挑战即「声明永不满足闸」死循环；cwd 域 ⊆ 锚键集且锚仓
      // 无 git 祖先仓时无新键、单键历史形态不变（锚仓嵌套于外层仓时外层祖先照签——
      // 外层仓文件的 Edit/Write 闸键可达，属不变量应有之义）。
      return [...new Set([anchorRepo, ...discoverRepoKeys(anchor).filter((k) => k !== anchorRepo), ...markerKeys, ...cwdUnionKeys(cwd)])];
    }
    const discovered = discoverRepoKeys(anchor);
    if (discovered.length > 0 || markerKeys.length > 0) {
      // 多仓/标记工作区：git 仓全集 + 标记域全集 + cwd 域并集同轮签发（纯标记工作区也走
      // 此支——锚下只有 .sdd 项目时不再落回 cwd 回退，否则标记键永远无挑战；cwd 非仓时
      // cwdUnionKeys 返空，形态与历史一致）
      return [...new Set([...discovered, ...markerKeys, ...cwdUnionKeys(cwd)])];
    }
  }
  // 无锚/发现为空的回退（2026-09-16 使用反馈批次 P9 修订）：锚的可见性随宿主 spawn
  // 环境漂移（ZCODE_PROJECT_DIR 经 w3-anchor-probe 观测确认不稳定），原「cwd 上溯单键」
  // 会在锚不可见的那一轮漏掉仓内嵌套仓——嵌套仓只能走补签自救（用户实测坑 P9）。cwd
  // 落在 git 仓内时按锚在时的同款语义（cwd 仓 + 仓内嵌套仓 + 上溯祖先仓）全量签发；
  // cwd 非仓才维持单键（内部任务-LEASEATT-1：全量语义单源到 cwdUnionKeys）。
  const union = cwdUnionKeys(cwd);
  if (union.length > 0) return union;
  return [projectKey(cwd)]; // cwd 也无 .git 祖先：维持既有 cwd 自身为键
}

/**
 * cwd 域键并集（2026-09-26 内部任务-LEASEATT-1；2026-10-09 内部任务-24 D3 自 user-prompt.mjs 迁入，
 * 函数体原样）：cwd 仓 + 仓内嵌套仓 + 上溯祖先仓——与无锚回退同款语义，抽出供锚分支并集
 * 与无锚回退共用（消除两分支逻辑分叉）。「签发键集 ⊇ 闸可达键集」不变量的 cwd 侧兜底：
 * 锚漂移/多工作区穿插时，Bash 闸执法键（会话持久 cwd 仓）恒有挑战；非 git 的 cwd 按
 * 标记根兜底（activationRoot 同判据），无标记返空数组（域外静默，不制造噪音键）。
 * @param {string} cwd 负载 cwd
 * @returns {string[]} cwd 域仓根键集合（canonical 形态，去重）
 */
export function cwdUnionKeys(cwd) {
  const cwdRepo = gitAncestor(cwd);
  if (!cwdRepo) {
    // 非 git 的 cwd：标记根（如有）仍是闸执法键（activationRoot=git ∪ 标记）——同判据
    // 兜底（收尾终审发现：锚漂移+cwd 落锚域外纯标记项目形态下不变量曾失守）；无标记
    // 返空（域外静默，不造噪音键；无锚回退路径经 projectKey 兜底，行为不变）。
    // gitAncestor 已判空，activationRoot 此处恒 ≡ markerAncestor（routing-lib 单源）。
    const markerRoot = activationRoot(cwd);
    return markerRoot ? [markerRoot] : [];
  }
  // 键集=仓内嵌套仓 + cwd 仓 + 该仓的 git 祖先仓：cwd 落在嵌套仓内时，父仓的
  // Edit/Write（deriveGateKey 按文件 git 祖先）同样需要挑战，漏签即回到 W3 死锁。
  // 祖先探测从 cwdRepo 直接父目录起逐级自探（阶段复审发现 2 处置：原循环先跳 parent
  // 再探测，直接父目录永不被检——outer/child 拓扑漏签 outer）。
  const ancestors = [];
  let dir = dirname(resolve(cwdRepo));
  for (;;) {
    if (existsSync(join(dir, '.git'))) ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set([cwdRepo, ...discoverRepoKeys(cwdRepo).filter((k) => k !== cwdRepo), ...ancestors])];
}

/**
 * 逐键租约状态（内部任务-24 D3）：deny 逐键清单数据源。declared=观察会话可见有效租约；
 * issued=有未过期挑战未声明；none=无挑战。token 短显 8 位（完整令牌在各键租约行）。
 * 只读无副作用；单键异常按 none 收口（fail-open——清单不得反噬 deny 主职责）。
 * @param {string[]} keys 签发键集（issuanceKeys 产物，与签发严格同源）
 * @param {number} now @param {{sessionId?: string|null}} observer 观察会话
 * @returns {Array<{key: string, state: 'declared'|'issued'|'none', tokenShort?: string}>}
 */
export function leaseStatusOfKeys(keys, now, observer = {}) {
  const out = [];
  for (const key of keys) {
    let state = 'none';
    let tokenShort;
    try {
      if (readActiveLease(key, now, { sessionId: observer.sessionId ?? null }).valid) {
        state = 'declared';
      } else {
        const cur = currentChallengeToken(key, observer.sessionId ?? null);
        if (cur && typeof cur.leaseId === 'string') {
          state = 'issued';
          tokenShort = cur.leaseId.slice(0, 8);
        }
      }
    } catch {
      state = 'none';
    }
    out.push(tokenShort === undefined ? { key, state } : { key, state, tokenShort });
  }
  return out;
}

/**
 * 宿主标识三态（内部任务-8 任务 3.3，内部决策-040 决策 3；内部规则-19 ⑦）：**实现已移入单源**
 * `scripts/lib/host-detect.mjs`（内部决策-063 修正案 3 决策 19，内部任务-195）——本库只再导出，
 * 不再持有探测表。语义：meta.host 非空字符串 → 之；否则按 DSH_/KIMI_/MCODE_/ZCODE_
 * 表序探测首个非空前缀（**ZCODE_ 末位**：Kimi/MCode shim 恒注入 ZCODE_*）；皆无 → 'unknown'。
 * 空串值视同未设置（内部任务-31，2026-10-09：以「变量名存在」为判据会使「空串变量屏蔽宿主锚」的
 * spawn 环境与无变量环境跨进程分叉，登记面读写两侧 host 不等即整条丢弃）。
 * host 是**审计与消歧**字段（异宿主同 sessionId 字符串不误判同会话的判定面之一），
 * **不是隔离维度**——读侧（readViaPointer/扫描面/撞号过滤）一律不按 host 过滤。
 */

/**
 * 签发自校验（内部任务-8 任务 5.2，内部规则-19 ⑥）：`issueChallenge` 返回后**回读挑战文件**，
 * 防「注入了令牌却不可激活」的必败路径（RC-4）——写后立读失败的罕见态（AV 锁/NFS 延迟/
 * 磁盘满）正是该缺陷的成因族。返回 `ok=false` 时调用方（leaseLine）改注降级指引。
 * 边界注记：RC-4 实测成因的另一半「历史令牌被 goal/续跑通道复读」**本自校验防不住**
 * （旧轮真实签发过、已被轮换删除）——复读防御＝精确拒因（内部规则-19 ⑥「单一来源」）＋探针取证。
 * `reason` 词义（门禁实例1 F7 澄清）：`missing`＝挑战文件不存在；`expired`＝已过期；
 * `mismatch`＝**字段非法**（`projectKey` 缺失/非字符串）——**不**表示「与某个期望键不符」
 * （本函数无期望键入参；键一致性由调用方 activateLease 的 projectKey 比对承担）；
 * `corrupt`＝文件存在但不可解析（内部任务-27 坑1 三态分层——损坏与缺失分态，missing 字面不变）。
 * @param {string} leaseId 挑战令牌
 * @param {number} [now] 判定时刻（缺省当前）
 * @returns {{ok: boolean, reason?: 'missing'|'expired'|'mismatch'|'corrupt'}}
 */
export function verifyChallengeOnDisk(leaseId, now = Date.now(), key = null) {
  const read = readJsonState(challengeTokenFile(String(leaseId), key));
  if (read.state === 'corrupt') {
    recordLeaseReadAnomaly(key ?? '', 'challenge', 'corrupt', {});
    return { ok: false, reason: 'corrupt' };
  }
  const ch = read.value;
  if (!ch) return { ok: false, reason: 'missing' };
  if (Number(ch.expiresAt) < now) return { ok: false, reason: 'expired' };
  if (typeof ch.projectKey !== 'string' || !ch.projectKey) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

/**
 * 签发新挑战（每个有效 UserPromptSubmit 调用一次，不受提醒节流约束）。
 * 会话桶内轮换：只更新本会话 current 指针，不影响他会话桶（内部决策-018）。
 * schema 版本（内部任务-227/内部决策-061）：**挑战体恒 5**（委派会话写三可选字段，顶层不写字段）；
 * 会话桶 current 指针/active/claim 维持 4 并带 `host`；v4/v3 存量状态读侧零校验、按路径兼容。
 * @param {string} key 项目键
 * @param {{sessionId?: string|null, host?: string, delegationDepth?: number, parentSessionId?: string|null, inheritTaskId?: string|null}} [meta] 会话标识/宿主标识；委派时可带深度/父会话 id/继承任务号（depth>0 且父 id 非空时挑战体升 v5 三字段）
 * @returns {{leaseId: string, promptEpoch: number, issuedAt: number, expiresAt: number}}
 */
export function issueChallenge(key, meta = {}) {
  const sessionId = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : null;
  const host = hostOf(meta);
  // 内部任务-244 C01：**sweep 之前**捕获本会话 current 指针——上一轮挑战过期时 sweep 会删指针；
  // 若 sweep 后再读 prev 会得 null，轮换吊销段整段跳过，旧 active（被心跳续命）经扫描回退
  // 继续授权（内部验收-9「会话内下一 prompt 旧租约失效」失守）；promptEpoch 也会回退为 1。
  const prevBeforeSweep = readJson(currentFile(key, sessionId));
  sweepExpiredChallenges(key);
  const prev = prevBeforeSweep ?? readJson(currentFile(key, sessionId));
  const promptEpoch = Number.isFinite(prev?.promptEpoch) ? prev.promptEpoch + 1 : 1;
  const now = Date.now();
  // 内部决策-061 D3（内部任务-227）：schemaVersion 恒 5；委派字段仅在 depth>0 且父会话 id 非空时写入
  // （顶层会话不写三字段；v4 读侧兼容：字段缺席即不可解析，禁止推断）。
  const delegationDepth = Number.isSafeInteger(meta.delegationDepth) && meta.delegationDepth > 0 ? meta.delegationDepth : 0;
  const parentSessionId = typeof meta.parentSessionId === 'string' && meta.parentSessionId ? meta.parentSessionId : null;
  const inheritTaskId = typeof meta.inheritTaskId === 'string' && DOMAIN_TASK_RE.test(meta.inheritTaskId) ? meta.inheritTaskId : null;
  const delegated = delegationDepth > 0 && parentSessionId !== null;
  const challenge = {
    schemaVersion: 5,
    leaseId: randomBytes(16).toString('hex'),
    projectKey: String(key),
    sessionId,
    host,
    promptEpoch,
    issuedAt: now,
    expiresAt: now + ttlMs(),
  };
  if (delegated) {
    challenge.delegationDepth = delegationDepth;
    challenge.parentSessionId = parentSessionId;
    if (inheritTaskId !== null) challenge.inheritTaskId = inheritTaskId;
  }
  atomicWrite(challengeTokenFile(challenge.leaseId, key), challenge);
  atomicWrite(currentFile(key, sessionId), {
    schemaVersion: 4,
    leaseId: challenge.leaseId,
    sessionId,
    host,
    promptEpoch,
    updatedAt: now,
  });
  // 签发台账（内部任务-41）：写失败静默——签发已生效，台账是审计面不是正确性面。
  try {
    const ledger = challengeLedgerFile(key);
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(
      ledger,
      `${JSON.stringify({ schemaVersion: 1, ts: now, leaseId: challenge.leaseId, sessionId, host, promptEpoch, expiresAt: challenge.expiresAt, root: stateRootFor(key) })}\n`,
    );
  } catch {
    /* fail-open */
  }
  // 桶内轮换即吊销（内部决策-018 决策 4，2026-09-22 修正案：仅会话桶）：删除本桶上一轮挑战与
  // 激活文件（「下一用户消息自动使上一租约失效」的强形态；旧 token 立即不可再激活，不等
  // TTL）。null 桶刻意豁免——共享桶上任一无标识会话的消息都会轮换它，强吊销=跨会话越权
  // （内部任务-LEASEGATE-1 死循环根因）；弱形态下挑战/激活按 TTL 自然过期，sweepExpired-
  // Challenges 在同项目下次签发时兜底清扫，读侧 TTL 校验独立兜底正确性。
  if (sessionId !== null && prev && TOKEN_RE.test(String(prev.leaseId ?? '')) && prev.leaseId !== challenge.leaseId) {
    rmSync(challengeTokenFile(prev.leaseId, key), { force: true });
    rmSync(activeTokenFile(prev.leaseId, key), { force: true });
  }
  // 内部任务-244 C01 加固：按 sessionId 扫描兜底——current 指针被 sweep/quarantine/人工删除时，
  // 指针路径给不出 prev，旧 active 仍会被扫描回退救回；故本会话桶内除新令牌外的
  // active/challenge 一律吊销（null 桶仍豁免；失败 fail-open 不阻断签发）。
  if (sessionId !== null) {
    try {
      const dir = stateRootFor(key);
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('wf-lease-active-') && !name.startsWith('wf-lease-challenge-')) continue;
        const body = readJson(join(dir, name));
        if (!body || body.projectKey !== String(key) || body.sessionId !== sessionId) continue;
        if (body.leaseId === challenge.leaseId) continue;
        // 异宿主同 sessionId 字符串不算本会话（内部规则-19 ⑦ 交叉校验）；host 缺失/unknown 侧不可比 →
        // 视为同会话（维护性评审：'unknown' 与缺失同归 null，防旧租约逃过吊销）。
        const bodyHost = typeof body.host === 'string' && body.host && body.host !== 'unknown' ? body.host : null;
        const chHost = typeof challenge.host === 'string' && challenge.host && challenge.host !== 'unknown' ? challenge.host : null;
        if (bodyHost !== null && chHost !== null && bodyHost !== chHost) continue;
        rmSync(join(dir, name), { force: true });
      }
    } catch {
      /* fail-open：吊销扫描失败不阻断签发（读侧 TTL/桶一致校验另兜底） */
    }
  }
  return { leaseId: challenge.leaseId, promptEpoch, issuedAt: now, expiresAt: challenge.expiresAt };
}

/**
 * 解析会话桶当前挑战：会话桶 → null 桶 → legacy v2 三级（内部决策-018 解析顺序）。
 * 返回已读的指针对象/挑战对象供调用方复用（legacy 场景同一文件只读一次）。
 * @param {string} key 项目键
 * @param {string|null} observerSess 观察侧会话标识（可缺省）
 * @returns {{leaseId: string, bucketSession: string|null, legacy: boolean, ptr?: object, ch?: object}|null}
 */
function resolveCurrent(key, observerSess) {
  if (observerSess) {
    const c = readJson(currentFile(key, observerSess));
    if (c && TOKEN_RE.test(String(c.leaseId ?? ''))) {
      const ch = readJson(challengeTokenFile(c.leaseId, key));
      if (ch) return { leaseId: c.leaseId, bucketSession: observerSess, legacy: false, ptr: c, ch };
    }
  }
  const c0 = readJson(currentFile(key, null));
  if (c0 && TOKEN_RE.test(String(c0.leaseId ?? ''))) {
    const ch = readJson(challengeTokenFile(c0.leaseId, key));
    if (ch) return { leaseId: c0.leaseId, bucketSession: null, legacy: false, ptr: c0, ch };
  }
  const lch = readJson(legacyChallengeFile(key));
  if (lch && typeof lch.leaseId === 'string' && lch.leaseId) {
    return { leaseId: lch.leaseId, bucketSession: null, legacy: true, ch: lch };
  }
  return null;
}

/**
 * 按观察会话解析当前挑战 token（routing-gate deny 文案「本轮 leaseId」的数据源）。
 * legacy 分支返回 null：旧 v2 挑战文件不能经 activateLease 激活（token 索引路径
 * 永不命中），把它的 leaseId 写进 deny 文案会形成结构性指引死循环——占位文案
 * 指引等待本会话下一条用户消息签发 v3 挑战（评审处置：concurrency 发现 1）。
 * @param {string} key 项目键
 * @param {string|null} [sessionId] 观察侧会话标识
 * @returns {{leaseId: string, promptEpoch: number}|null}
 */
export function currentChallengeToken(key, sessionId = null) {
  const cur = resolveCurrent(key, sessionId || null);
  if (!cur || cur.legacy) return null;
  // 过期挑战不得作为 deny 文案令牌来源：照抄过期 leaseId 声明必吃「挑战已过期」，
  // 形成照指引必败死循环——与 legacy 分支同款防护（concurrency 发现 1 的过期分支补漏）。
  if (Number(cur.ch.expiresAt) < Date.now()) return null;
  return { leaseId: cur.leaseId, promptEpoch: Number(cur.ch.promptEpoch) || 0 };
}

/**
 * 答复通道只读租约提示（内部任务-352，内部模块-8 内部规则-8 / 内部验收-47）：
 * AskUserQuestion 答复经 tool result 通道到达、不触发 UserPromptSubmit ⇒ 本轮租约行不会重注；
 * 本函数对 issuanceKeys(cwd) 逐键**只读**判定「当前挑战令牌存在 ∧ active 租约无效」，命中即返回
 * 重述令牌与声明命令的提示行（多键带 `仓 <basename>` 标签与 ` --project-root`；单键历史形态）。
 * 纯读：不签发、不激活、不写租约状态（底层读原语可能使用既有发现缓存/进程内 memo，不影响状态面）。
 * 委派会话直接返回 []（自取号与 内部决策-061 D4 冲突）。
 * @param {{cwd: string, sessionId: string, now?: number, declarePrefix: string,
 *          suggest?: (key: string) => string|null, delegated?: boolean}} input
 * @returns {string[]} 零至多行提示（每键至多一行）
 */
export function answerChannelLeaseHint(input) {
  const out = [];
  try {
    if (!input || typeof input !== 'object' || input.delegated === true) return out;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : '';
    const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : '';
    const declarePrefix = typeof input.declarePrefix === 'string' && input.declarePrefix ? input.declarePrefix : '';
    if (!cwd || !sessionId || !declarePrefix) return out;
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const suggest = typeof input.suggest === 'function' ? input.suggest : () => null;
    let keys = [];
    try {
      keys = issuanceKeys(cwd) ?? [];
    } catch {
      return out;
    }
    const multi = keys.length > 1;
    for (const key of keys) {
      const ch = currentChallengeToken(key, sessionId);
      if (!ch || typeof ch.leaseId !== 'string' || ch.leaseId === '') continue;
      let lease = null;
      try {
        lease = readActiveLease(key, now, { sessionId });
      } catch {
        lease = null;
      }
      if (lease && lease.valid === true) continue;
      const label = multi ? `仓 ${basename(key).slice(0, 24)}｜` : '';
      const projectRootArg = multi ? ` --project-root '${key.replaceAll('\\', '/')}'` : '';
      const suggested = suggest(key);
      const taskId = typeof suggested === 'string' && suggested ? suggested : '<任务号>';
      out.push(
        `【workflow 任务租约】${label}本轮令牌 ${ch.leaseId}｜首个写操作前完成声明：${declarePrefix} <命中skill名> ` +
        `--lease ${ch.leaseId} --task-id ${taskId}${projectRootArg}（答复通道提示：答复不轮换令牌；按此行重声明即可恢复）`,
      );
    }
  } catch {
    /* 只读提示 fail-open：调用方主职责不受影响 */
  }
  return out;
}

/**
 * 反查挑战所属项目键（FB-1 批次，2026-09-18）：按 leaseId 读 token 索引挑战文件，
 * 返回其 projectKey；文件不存在/损坏/缺字段返回 null——调用方决定文案呈现，
 * 库层不抛（fail-open 家族姿态，与 hook 异常语义一致）。
 * @param {string} leaseId 挑战令牌
 * @returns {string|null} 签发该挑战的项目键；查不到返回 null
 */
export function challengeHomeKey(leaseId, key = null) {
  try {
    const ch = readJson(challengeTokenFile(String(leaseId), key));
    return ch && typeof ch.projectKey === 'string' && ch.projectKey ? ch.projectKey : null;
  } catch {
    return null;
  }
}

/**
 * changeScope 条目复验与规范化（协议扩展 2026-09-14，不信任调用方）：条目反斜杠
 * 归一为 /、去前导 ./、拒绝空串/绝对路径（含 Windows 盘符形态）/.. 段，去重保持
 * 首现顺序。非法即 throw——declare 侧 catch 转 exit 1（失败可见），本库不吞协议错误。
 * @param {string[]} arr 原始条目数组
 * @returns {string[]} 规范化去重后的条目
 * @throws {Error} 非数组/非字符串条目/空串/绝对路径/含 .. 段
 */
export function normalizeScopeEntries(arr) {
  if (!Array.isArray(arr)) throw new Error('changeScope 必须是字符串数组');
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') throw new Error(`changeScope 条目必须是字符串（收到 ${typeof raw}）`);
    const e = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!e) throw new Error(`changeScope 条目不得为空（收到「${raw}」）`);
    if (e.startsWith('/') || /^[A-Za-z]:[\\/]/.test(e)) throw new Error(`changeScope 条目不得为绝对路径（收到「${raw}」）`);
    if (e.split('/').includes('..')) throw new Error(`changeScope 条目不得含 .. 段（收到「${raw}」）`);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * 归一化租约 `scriptWrites`（内部决策-066 D3，内部任务-261）：数组元素可为字符串理由或
 * `{reason, declaredAt?}` 对象；理由 trim 后须 ≥8 字；declaredAt 缺省由本库打时间戳。
 * 只做形状/长度校验，不判断放行（放行由写仓闸读租约数组非空决定）。
 * @param {unknown} arr
 * @returns {Array<{reason: string, declaredAt: string}>}
 */
/**
 * 理由清单归一核心（内部任务-348/内部未决-254⑤ 单源）：数组、元素理由或 {reason,declaredAt}、
 * trim 后 ≥8 字——错误文案由 label 参数构造（不再 replaceAll 派生）。
 * @param {unknown} arr
 * @param {string} label 字段名（错误文案用）
 * @returns {Array<{reason: string, declaredAt: string}>}
 */
function normalizeReasonList(arr, label) {
  if (!Array.isArray(arr)) throw new Error(`${label} 必须是数组`);
  const out = [];
  for (const raw of arr) {
    let reason = '';
    let declaredAt = '';
    if (typeof raw === 'string') reason = raw;
    else if (raw && typeof raw === 'object' && typeof raw.reason === 'string') {
      reason = raw.reason;
      if (typeof raw.declaredAt === 'string' && raw.declaredAt) declaredAt = raw.declaredAt;
    } else throw new Error(`${label} 条目须为字符串理由或 {reason,declaredAt} 对象`);
    const r = reason.trim();
    if (r.length < 8) throw new Error(`${label} 理由须 ≥8 字（收到 ${r.length} 字）`);
    out.push({ reason: r, declaredAt: declaredAt || new Date().toISOString() });
  }
  return out;
}

/**
 * 只做形状/长度校验，不判断放行（放行由写仓闸读租约数组非空决定）。
 * @param {unknown} arr
 * @returns {Array<{reason: string, declaredAt: string}>}
 */
export function normalizeScriptWrites(arr) {
  return normalizeReasonList(arr, 'scriptWrites');
}

/**
 * 归一化租约 `scriptEditCode`（内部决策-066 修正案 1 内部模块-2，内部任务-285）：形状/长度规则与
 * `scriptWrites` 同源（单源核心＋label），错误文案直构。放行判定归写仓闸。
 * @param {unknown} arr
 * @returns {Array<{reason: string, declaredAt: string}>}
 */
export function normalizeScriptEditCode(arr) {
  return normalizeReasonList(arr, 'scriptEditCode');
}

/**
 * 归一化租约 `projectSkills`（内部决策-070 D4，内部任务-341）：项目 skill 已加载 ack 数组。
 * 元素为 skill 名或 `{name, root}`；name 过 SKILL_NAME_RE；同 name 去重（保留首条）；
 * root 只接受仓根相对 POSIX 形态（禁止绝对路径与 `..`）。失败 throw 由调用方转拒因。
 * @param {unknown} arr
 * @returns {Array<{name: string, root: string}>}
 */
export function normalizeProjectSkills(arr) {
  if (!Array.isArray(arr)) throw new Error('projectSkills 必须是数组');
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    let name = '';
    let root = '';
    if (typeof raw === 'string') name = raw;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      name = typeof raw.name === 'string' ? raw.name : '';
      root = typeof raw.root === 'string' ? raw.root : '';
    } else throw new Error('projectSkills 条目须为 skill 名或 {name,root} 对象');
    const n = name.trim();
    if (!SKILL_NAME_RE.test(n)) throw new Error(`projectSkills name 非法：${n || '空'}`);
    const r = root.trim();
    if (r && (r.startsWith('/') || /^[A-Za-z]:/.test(r) || r.split('/').includes('..'))) {
      throw new Error(`projectSkills root 须为仓根相对 POSIX 路径：${r}`);
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ name: n, root: r });
  }
  return out;
}

/**
 * 激活租约：leaseId 反查 token 挑战（不存在/过期/项目不符拒绝），写入 active-<token>
 * （last-writer-wins 幂等覆盖，sessionId 取自挑战签发方——跨会话重放只写签发方桶，
 * 结构性无效）。taskId/skill 必须合法；changeScope/exempt/exemptScope/exemptSrc/scriptWrites 均在库内复验
 * （不信任调用方）：条目规范化非法拒、exempt 仅 plan-execution、exemptScope 限 plan|review 且与 plan/引文成对、
 * exemptSrc 限枚举、scriptWrites 逐条理由 ≥8 字且 declaredAt 由本库补。
 * @param {string} key 项目键
 * @param {{leaseId: string, taskId: string, skill: string, planPath?: string, planSha256?: string, planRoot?: string, exempt?: string, exemptScope?: string, exemptSrc?: string, changeScope?: string[], scriptWrites?: Array<string|{reason: string, declaredAt?: string}>, via?: string, manual?: boolean, manualReason?: string, resume?: boolean, resumeReason?: string}} req
 * @returns {{ok: boolean, reason?: string, inherited?: boolean, parentSessionId?: string, delegationDepth?: number, degraded?: Array<{source: string, reason: string}>, claimWritten?: boolean, claimMarkerWritten?: boolean, claimMode?: string, warning?: string}}
 */
export function activateLease(key, req) {
  const token = String(req.leaseId ?? '');
  if (!TOKEN_RE.test(token)) return { ok: false, reason: `leaseId 非法（${tokenShort(token)}）` };
  const chFile = challengeTokenFile(token, key);
  let chRead = readJsonState(chFile);
  // 内部任务-27 坑2+3：corrupt 态单次重试（FIX-2 异象①实录——同刻闸侧可读、声明 CLI 瞬态
  // 读失败，recovered 取证记录「首腐后好」翻转）；absent 不重试（轮换删除是正常语义）
  // 但落 absent-at-activate 取证（F7 双根诊断现场：挑战写根 A、激活读根 B）。
  if (chRead.state === 'corrupt') {
    const retried = readJsonState(chFile);
    recordLeaseReadAnomaly(key, 'challenge', 'corrupt', { recovered: retried.state === 'ok' });
    chRead = retried;
  } else if (chRead.state === 'absent') {
    recordLeaseReadAnomaly(key, 'challenge', 'absent', {});
  }
  const ch = chRead.value;
  if (!ch) {
    if (chRead.state === 'corrupt') {
      return {
        ok: false,
        reason: `${LEASE_REASONS.NO_CHALLENGE}（token ${tokenShort(token)} 挑战文件损坏不可解析）——请再发一条消息重新签发后声明新令牌；反复出现请检查状态目录写权限/磁盘`,
      };
    }
    // 内部任务-41（FIX-3 承接）：absent 二分——台账命中=旧轮令牌（轮换吊销/过期清扫；
    // 长会话复读与誊抄失真是 2026-10-11 两事故根因），未命中=从未签发。两态均内联
    // 键内在位挑战短令牌，给轮内自纠路径（此前唯一出路=等下一条用户消息重签）。
    const issuedRec = findChallengeIssuance(key, token);
    const curShort = currentChallengeShort(key);
    const curNote = curShort ? `当前在位挑战 ${curShort}，` : '';
    return {
      ok: false,
      reason: issuedRec
        ? `${LEASE_REASONS.NO_CHALLENGE}（token ${tokenShort(token)} 是已失效的旧轮令牌——挑战文件已被轮换吊销或过期清扫，旧令牌不可复用；${curNote}请改用本会话最新一轮【workflow 任务租约】行内的完整令牌重试）`
        : `${LEASE_REASONS.NO_CHALLENGE}（token ${tokenShort(token)} 不在本仓签发记录中——疑似誊抄失真或他仓令牌；${curNote}请改用本会话最新一轮【workflow 任务租约】行内的完整令牌重试）`,
    };
  }
  if (Number(ch.expiresAt) < Date.now()) {
    return {
      ok: false,
      reason:
        `${LEASE_REASONS.EXPIRED_CHALLENGE}——长会话补签出路：node routing-declare.mjs --bootstrap-reissue '<该仓根>'（前置=本目录主键持有效租约，2026-09-16 批次 W2①）。${REISSUE_TRIAGE_NOTE}`,
    };
  }
  if (ch.projectKey !== String(key)) return { ok: false, reason: LEASE_REASONS.PROJECT_MISMATCH };
  const tidRejection = taskidRejection(req.taskId, key); // 内部未决-76：形态+域成员双层，拒因细分两文案
  if (tidRejection !== null) return { ok: false, reason: tidRejection };
  if (!SKILL_NAME_RE.test(String(req.skill ?? ''))) return { ok: false, reason: 'skill 名非法' };
  // 内部决策-066 D3（内部任务-261）＋修正案 1 内部模块-2（内部任务-285）＋内部任务-348/内部未决-254⑤ 单源合一：
  // scriptWrites/scriptEditCode 两通道参数化（字段名/归一函数对），语义各保持原样。
  const declareNormalizers = [
    ['scriptWrites', normalizeScriptWrites],
    ['scriptEditCode', normalizeScriptEditCode],
  ];
  const declareEntries = {};
  for (const [field, normalize] of declareNormalizers) {
    if (req[field] !== undefined) {
      try {
        declareEntries[field] = normalize(req[field]);
      } catch (e) {
        return { ok: false, reason: `${field} 非法——${e.message}` };
      }
    }
  }
  const scriptWriteEntries = declareEntries.scriptWrites;
  const scriptEditEntries = declareEntries.scriptEditCode;
  // 内部决策-070 D4（内部任务-341）：projectSkills 形状校验（失败拒，不静默降级）
  let projectSkillEntries;
  if (req.projectSkills !== undefined) {
    try {
      projectSkillEntries = normalizeProjectSkills(req.projectSkills);
    } catch (e) {
      return { ok: false, reason: `projectSkills 非法——${e.message}` };
    }
  }
  // 内部决策-061 D4（内部任务-227）：委派继承声明面——挑战体 v5 的 inheritTaskId 绑定 req.taskId；
  // 继承声明不触发撞号守卫（占用归父）、不写 claim/claims 占位（占用归父），只写 active。
  const delegationDepth = Number.isSafeInteger(ch.delegationDepth) && ch.delegationDepth > 0 ? ch.delegationDepth : 0;
  const inherited = delegationDepth > 0;
  if (inherited) {
    const inheritId = typeof ch.inheritTaskId === 'string' ? ch.inheritTaskId : '';
    if (!inheritId) {
      return { ok: false, reason: '委派会话不可解析继承任务号（挑战缺 inheritTaskId）——停止写操作，回报父会话：由父会话先声明交付任务号后重新派发（禁止同轮重试）' };
    }
    if (String(req.taskId) !== inheritId) {
      return { ok: false, reason: `委派会话不得自取任务号（挑战 inheritTaskId=${inheritId}）——停止写操作，回报父会话：由父会话先声明交付任务号后重新派发（禁止同轮重试）` };
    }
  }
  // 内部决策-061 D5 修正（内部任务-227）：受控人工通道——reason ≥8 字；占用集 degraded 时须「用户授权：」
  // 前缀携带用户裁决引文（机检，防降级期人工通道绕过历史占用面；模型不得自行编造）。
  const manual = req.manual === true;
  const manualReason = String(req.manualReason ?? '').trim();
  if (manual && manualReason.length < 8) return { ok: false, reason: 'manual 通道须提供 --manual-reason（≥8 字，说明人工裁决依据）；人工指定号须由人裁决，模型不得自行编造' };
  // 内部决策-061 修正案 1 第 3 条（内部任务-227）：续任务通道理由前置校验——不论占号面如何，旗标成对且 ≥8 字。
  const resume = req.resume === true;
  const resumeReason = String(req.resumeReason ?? '').trim();
  if (resume && resumeReason.length < 8) return { ok: false, reason: '--resume-task 须提供 --resume-reason（≥8 字，说明续用依据）' };
  const domForTask = DOMAIN_TASK_RE.exec(String(req.taskId));
  // 内部决策-045 段隔离＋内部决策-061 D5.2：占用扫描一次，维护者段与 degraded 同时参与（阶段复审发现 1/4）。
  // 内部任务-244 P02 阶段门：激活判定**恒读实况**（noCache）——占用缓存只服务建议号/可见性提示，
  // 历史占用拒绝不得依据 TTL 内的旧快照（维护性评审阻塞 1）。
  const occupancyForTask = domForTask
    ? occupiedSeqsOfDomain(key, domForTask[1], { maintainer: domForTask[2] ?? null, noCache: true })
    : { degraded: [] };
  const degradedNow = Array.isArray(occupancyForTask.degraded) ? occupancyForTask.degraded : [];
  if (manual && degradedNow.length > 0 && !/^用户授权[：:]/.test(manualReason)) {
    return { ok: false, reason: '占用集降级（历史占用校验不完整）时人工指定号须提供 --manual-reason 以「用户授权：」开头并携带用户裁决引文；人工指定号须由人裁决，模型不得自行编造' };
  }
  // 内部决策-061 D5 修正 2(b)（内部任务-227）：声明路径每次 degraded 追加审计行（可诊断面，写失败静默）。
  if (degradedNow.length > 0) {
    appendDegradedRecord(key, {
      sources: degradedNow,
      context: { skill: String(req.skill), taskId: String(req.taskId), sessionId: typeof ch.sessionId === 'string' ? ch.sessionId : null },
    });
  }
  // 内部决策-061 D6（内部任务-227）：非委派声明受理侧历史占用校验——仅审计源占号拒绝复用（交付面占号放行）。
  if (!inherited) {
    const histRejection = declarationHistoryRejection(String(req.taskId), key, {
      resume,
      resumeReason,
      occupancy: occupancyForTask,
    });
    if (histRejection !== null) return { ok: false, reason: histRejection };
  }
  if (req.exempt !== undefined && String(req.skill) !== 'plan-execution') {
    return { ok: false, reason: 'exempt 仅 plan-execution 可用' };
  }
  if (req.exemptScope !== undefined && req.exempt === undefined) {
    return { ok: false, reason: 'exemptScope 必须与 exempt 同时使用' };
  }
  if (req.exempt !== undefined && !EXEMPT_SOURCES.includes(req.exemptSrc)) {
    return { ok: false, reason: `exemptSrc 非法（收到「${String(req.exemptSrc)}」，合法取值 ${EXEMPT_SOURCES.join('|')}）` };
  }
  if (req.exempt !== undefined) {
    const shape = checkExemptDeclarationShape({
      skill: String(req.skill),
      exempt: req.exempt,
      scope: req.exemptScope,
      hasPlan: typeof req.planPath === 'string' && req.planPath !== '',
      hasPlanRoot: typeof req.planRoot === 'string' && req.planRoot !== '',
    });
    if (!shape.ok) return shape;
    if (req.exemptScope === 'review'
      && (typeof req.planSha256 !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(req.planSha256))) {
      return { ok: false, reason: 'scope=review 必须绑定 64 位 planSha256' };
    }
  }
  let scopeEntries; // undefined=未声明写面（不写字段）；规范化失败即拒
  if (req.changeScope !== undefined) {
    try {
      scopeEntries = normalizeScopeEntries(req.changeScope);
    } catch (e) {
      return { ok: false, reason: `changeScope 非法——${e.message}` };
    }
  }
  const lease = {
    schemaVersion: 4,
    leaseId: token,
    projectKey: String(key),
    sessionId: typeof ch.sessionId === 'string' && ch.sessionId ? ch.sessionId : null,
    // host 继承挑战签发侧（v4）；v3 存量挑战无 host → 'unknown'（读侧不按 host 过滤，纯审计面）
    host: typeof ch.host === 'string' && ch.host ? ch.host : 'unknown',
    taskId: String(req.taskId),
    skill: String(req.skill),
    promptEpoch: Number(ch.promptEpoch) || 0,
    issuedAt: Number(ch.issuedAt),
    declaredAt: Date.now(),
    expiresAt: Date.now() + ttlMs(),
  };
  if (typeof req.planPath === 'string' && req.planPath) lease.planPath = req.planPath;
  if (typeof req.planSha256 === 'string' && req.planSha256) lease.planSha256 = req.planSha256;
  if (typeof req.planRoot === 'string' && req.planRoot) lease.planRoot = req.planRoot;
  if (typeof req.exempt === 'string' && req.exempt) lease.exempt = req.exempt;
  if (typeof req.exemptSrc === 'string' && req.exemptSrc) lease.exemptSrc = req.exemptSrc;
  if (typeof req.exemptScope === 'string' && req.exemptScope) lease.exemptScope = req.exemptScope;
  // P4（2026-10-10 内部任务-29）：跨插件衔接 skill 声明的来源路由行标注（--via），入租约
  // 供审计（claim 面不扩——占用语义最小，见 内部规则-12 扩集条款）。
  if (typeof req.via === 'string' && req.via) lease.via = req.via;
  if (scopeEntries !== undefined) lease.changeScope = scopeEntries;
  if (scriptWriteEntries !== undefined) lease.scriptWrites = scriptWriteEntries;
  if (scriptEditEntries !== undefined) lease.scriptEditCode = scriptEditEntries;
  if (projectSkillEntries !== undefined) lease.projectSkills = projectSkillEntries;
  // 内部决策-061 审计字段（内部任务-227）：继承/人工/续任务可诊断面。
  if (inherited) {
    lease.inherited = true;
    lease.delegationDepth = delegationDepth;
    lease.parentSessionId = String(ch.parentSessionId);
  }
  if (manual) {
    lease.manual = true;
    lease.manualReason = manualReason;
  }
  if (req.resume === true) {
    lease.resumed = true;
    lease.resumeReason = String(req.resumeReason ?? '').trim();
  }
  // 撞号守卫（内部任务-8 任务 4.2 迁移 + 门 B F1 并集修法，内部规则-19 ① / RC-2 根因）——
  // **数据源＝claim ∪ 无 claim 兜底的 active**：claim 为主（耐轮换：桶内轮换只删 active/challenge），
  // 占用事实不随写权限销毁；active 兜底覆盖「持有效租约但无 claim」的持有者（存量 v3 在途租约 /
  // TOCTOU 竞态落败者 / claim 写失败降级者）——只读 claim 会让这些持有者对守卫不可见而双持并存
  // （门 B F1 实测复现并阻塞）。同号已有有效 claim 时 active 兜底让位（以 claim 为准，不重复判定）。
  // 过滤键=(projectKey, taskId) + 未过期 + 异会话（内部决策-040 决策 2）；过期 claim 即清并继续
  // （死会话退出；active 由 GC 按 TTL 清）；半损坏条目（expiresAt 非数值）不阻断（NaN 安全侧：
  // 误放非误拒）；扫描异常 fail-open 放行。域前缀形态下 taskId 字符串全等即 (domain, taskId) 复合键。
  // 内部决策-061 D4（内部任务-227）：继承声明不得触发撞号守卫（占用归父会话）——整段跳过。
  if (!inherited) try {
    const dir = stateRootFor(key);
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const isClaim = name.startsWith('wf-lease-claim-');
      const isActive = name.startsWith('wf-lease-active-');
      if (!isClaim && !isActive) continue;
      const other = readJson(join(dir, name));
      if (!other || other.taskId !== String(req.taskId)) continue;
      if (other.projectKey !== String(key)) continue;
      const exp = Number(other.expiresAt);
      if (!Number.isFinite(exp)) continue; // 半损坏：不可判定 → 不阻断（误放非误拒）
      if (exp <= now) {
        if (isClaim) {
          // 内部任务-244 阶段门：过期 claim 清理改「改名入 quarantine→复核仍过期才留」——防守卫读旧
          // 快照期间并发方恰好 link 出的新 claim 被本进程直接 rm（双持窄窗，正确性评审阻塞 3a）。
          const stalePath = join(dir, name);
          try {
            const again = readJson(stalePath);
            const stillStale = again && Number.isFinite(Number(again.expiresAt)) && Number(again.expiresAt) <= Date.now();
            if (stillStale) {
              const qdir = join(dir, 'quarantine');
              mkdirSync(qdir, { recursive: true });
              const q = join(qdir, `${name}.${Date.now()}.${process.pid}`);
              renameSync(stalePath, q);
              const recheck = readJson(q);
              if (!(recheck && Number.isFinite(Number(recheck.expiresAt)) && Number(recheck.expiresAt) <= Date.now())) {
                try { renameSync(q, stalePath); } catch { /* 回滚失败：隔离件留存（不静默删证据） */ }
              }
            }
          } catch {
            /* fail-open：清理失败不阻断守卫 */
          }
        }
        continue;
      }
      if (isActive) {
        // active 兜底仅在无同号有效 claim 时生效（同现时以 claim 为准，避免同一占用重复判定）
        const c = readClaim(key, other.taskId);
        if (c && Number.isFinite(Number(c.expiresAt)) && Number(c.expiresAt) > now) continue;
      }
      const os = typeof other.sessionId === 'string' && other.sessionId ? other.sessionId : null;
      // sessionId 交叉校验（内部规则-19 ⑦ / 内部决策-040 决策 4）：**具名**会话须 sessionId 与 host 双等
      // 才算同会话——异宿主同 sessionId 字符串不得误判同会话；null 会话不比对 host（null 桶多活弱形态）。
      // 门 B delta N-1：**host 缺失侧视为不可比**（存量 v3 无 host 不得构成「异宿主」证据）——
      // 否则同一会话会被自家旧租约判成撞号（自我阻断，且被误伤者正是存量持有人）。
      const ohost = typeof other.host === 'string' && other.host ? other.host : null;
      // 内部决策-061 D4（内部任务-227，阶段复审正确性 B2/delta）：继承 active 的属主判定沿 parentSessionId
      // 链传递（depth=2 孙会话 active.parentSessionId=子会话，须上溯到根属主）；同一交付号属主
      // （父会话）重声明放行，第三方仍按撞号处理。上溯 ≤3 层，链上行取 issued 台账 inherited 行。
      if (other.inherited === true && typeof other.parentSessionId === 'string') {
        let curOwner = other.parentSessionId;
        let sameOwner = false;
        for (let hop = 0; hop < 3 && curOwner; hop += 1) {
          if (curOwner === lease.sessionId) { sameOwner = true; break; }
          const ownerRow = readIssuedRows(key).find((r) => r.sessionId === curOwner && r.inherited === true);
          curOwner = ownerRow && typeof ownerRow.parentSessionId === 'string' ? ownerRow.parentSessionId : '';
        }
        if (sameOwner) continue;
      }
      // P2（2026-10-10 内部任务-29 / 内部任务-103 P2 实录）：持有者为 null 桶（bootstrap-reissue
      // 补签占位/共享桶弱形态）时放行覆盖——null 会话无受保护身份，占位可被任何具名
      // 会话或新补签幂等接管（内部规则-19 ① null 桶持有者例外；补签后令牌轮换、真会话
      // 同号重声明被占位卡死且 release 三作用域不可达正是该实录）；具名互斥不变。
      const sameSession = os === null || (os === lease.sessionId && (ohost === null || ohost === lease.host));
      if (!sameSession) {
        const rawAt = Number(other.claimedAt ?? other.declaredAt);
        const declaredAtText = Number.isFinite(rawAt) ? new Date(rawAt).toISOString() : '未知';
        const expiresText = new Date(exp).toISOString();
        // 内部决策-045/内部任务-96：撞号建议按 DOMAIN_TASK_RE 捕获组取域段＋透传维护者上下文
        // （原 indexOf('-') 切分在三段号下会把维护者码当域段——结构化解析）。
        const hit = DOMAIN_TASK_RE.exec(String(req.taskId));
        const sug = suggestedTaskId(key, { domain: hit ? hit[1] : String(req.taskId).slice(0, String(req.taskId).indexOf('-')), ...(hit?.[2] ? { maintainer: hit[2] } : {}) });
        const sugDegraded = Array.isArray(sug.degraded) && sug.degraded.length > 0;
        const sugText = sugDegraded ? '取号暂不可得，请重试或查询占用源' : (sug.ok && sug.suggestions[0] ? sug.suggestions[0].taskId : '（取号不可得：--suggest-task-id 查询）');
        // 内部任务-36/内部任务-122（2026-10-17）：自撞注记（内部验收-9）——声明者经 null 桶（补签形态）
        // 而持有者具名时，守卫无法自证同会话（阻断本身是设计预期，内部决策-040 决策 2），但须
        // 分诊提示「疑似本会话补签热续期」并给出本场景真正可达的三条出路（等下一条用户
        // 消息的具名令牌／--release --session〔id 可从状态根 claim/active 体或
        // 内部工作流状态 读全值〕／--release --all-sessions）；具名×具名不触发
        // （不误报他会话抢号）。
        const selfHint =
          lease.sessionId == null && os != null
            ? `疑似本会话补签热续期（声明者经 null 桶无法自证同会话）——可达出路：等下一条用户消息的具名令牌后同号重声明，或 --release --session <会话id>（id 可从状态根 claim/active 体或 .workflow/incidents.jsonl 读全值）／--release --all-sessions 释放后重声明；`
            : '';
        return {
          ok: false,
  // P8（2026-10-10 内部任务-29 / 内部任务-103 P8）：双路指引取代旧「顺延取号即出路」单路
  // 话术——延续任务换号即割裂 sidecar/台账/receipts 任务链（交接实录），延续路
  // （等 TTL/原会话 release 后同号重声明）必须与取号路（内部任务-117 稠密措辞）并列呈现。
          reason:
            `撞号阻断：task-id ${String(req.taskId)} 已被会话 ${String(os ?? 'null').slice(0, 8)}… 持有（声明于 ${declaredAtText}，按 TTL 将于 ${expiresText} 过期）——${selfHint}` +
            '①延续本任务（同号必须保留：plan sidecar/台账/receipts 均锚定原任务号）：待上述 TTL 过期后同号重声明（注：TTL 随活动心跳持续顺延——活跃会话需整整一个 TTL 零工具调用才过期），或由原会话以 --release --lease <原会话令牌> 释放后同号重声明（原令牌已过期无法反查时改用 --release --session <会话id>／--release --all-sessions）；' +
            `②确属新任务撞旧号：${sugDegraded ? '取号暂不可得（占用源降级：' + (sug.degraded ?? []).map((d) => d.source).join('/') + '）——请重试或查询占用源' : `取最小未用号——请改用 ${sugText} 重试（本令牌仍有效，无需等待新令牌）`}`,
        };
      }
    }
  } catch {
    /* 扫描失败不阻断声明（fail-open 家族） */
  }
  // 声明成功：先建占用登记（claim，耐轮换），再落写权限（active）——占用与写权限解耦（内部决策-9）。
  // claim 写失败＝占用降级为无（并集守卫仍由 active 兜底保护本会话，TTL 内有效）；**可见化**
  // （门禁实例1 F3：「零静默失败」义务——失败不得无声）：返回值带 `claimWritten`，调用方输出告警。
  // 内部任务-244 D01：claim 改为**原子占用建立**（唯一 tmp 写完整 JSON → linkSync 排他；EEXIST 按
  // 属主分流）。原 writeClaim=atomicWrite(tmp+rename) 是「先扫后覆写」的覆写根因：并发同号
  // 可双双通过守卫并互相覆盖 claim（双持）。继承声明不建占用（占用归父会话）。
  const claimAcq = inherited ? { ok: false, mode: 'inherited' } : acquireClaim(key, lease);
  const claimWritten = claimAcq.ok === true;
  if (claimAcq.mode === 'conflict') {
    return {
      ok: false,
      reason:
        `撞号阻断（claim 原子建立冲突）：task-id ${String(req.taskId)} 的占用登记已存在且属其他会话/未过期——` +
        '并发同号声明只能有一方成功。请按双路指引处置：①延续本任务：等占用 TTL 过期或由持有会话 release 后同号重声明；' +
        '②确属新任务：改用取号建议的最小未用号重试（本令牌仍有效，无需等待新令牌）。',
    };
  }
  // git 同步面占位登记（内部决策-050 D1，内部任务-62）：声明成功即写 claims/<taskId>.json——「已取号」
  // 跨机经 git 可见（不依赖本机状态根）；写失败降级可见不阻断（claimMarkerWritten=false
  // 走 claimWritten 同款 stderr 警告形态，占用退回机器本地 claim/active 兜底）。
  // 内部决策-061 D4：继承声明不写 claim/claims 占位（占用归父会话），只写 active。
  const claimMarker = inherited ? { ok: false } : writeClaimMarker(key, lease);
  // 内部任务-244 E05：active 写（=写权限落盘）失败时必须回滚本次占用并返回 {ok:false}——原实现
  // 失败直接抛出被外层 CLI 吞成通用错误，且 claim/占位残留在账上（半激活：占用在但写权限无）。
  try {
    if (process.env.WF_FORCE_ACTIVE_WRITE_FAIL === '1') throw new Error('forced active write failure');
    atomicWrite(activeTokenFile(token, key), lease);
  } catch (err) {
    // 阶段门正确性评审 #6：仅回滚**本次新建**的占用（refreshed 是既有同属主占位，删了会丢先前占用）
    if (claimWritten && claimAcq.mode === 'created') {
      try { rmSync(claimFile(key, lease.taskId), { force: true }); } catch { /* 回滚尽力 */ }
    }
    if (claimMarker?.ok && claimAcq.mode === 'created') {
      // 内部任务-265：与 rollbackActivation 同语义——git 占位翻 released（不再内联 rm 删除）
      const norm = normalizeSession(lease.sessionId);
      const holderDigest = norm !== null ? sessDigest(norm) : null;
      try { markClaimReleased(key, lease.taskId, holderDigest); } catch { /* 回滚尽力 */ }
    }
    return {
      ok: false,
      claimWritten,
      claimMode: claimAcq.mode,
      claimMarkerWritten: claimMarker?.ok === true,
      reason: `租约写权限保存失败（active 落盘异常：${err?.code ?? err?.name ?? 'unknown'}）——声明未生效，占用已回滚；请检查 WF_ROUTING_STATE_DIR 写权限后重试`,
    };
  }
  // 发号台账（内部任务-27 批二坑6 引入）：append-only 单行挂状态根（随 wf-lease-* 状态族，经
  // stateRootFor 单点解析——测试注入缝天然隔离，不写消费仓工作树），写失败静默
  // （fail-open：台账损失不损失激活）；**内部任务-117 起为纯审计轨迹（不入占用集）**——占号
  // 由 claim/active 未过期窗口与 git 同步源承担，弃号回池消除跳号。内部未决-103（内部任务-52）：
  // 条目 sessionId 维持保留（审计归因面）。
  try {
    const ledger = join(stateRootFor(key), `wf-issued-${keyDigest(String(key))}.jsonl`);
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, JSON.stringify({
      schemaVersion: 1,
      ts: Date.now(),
      taskId: String(req.taskId),
      ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
      ...(inherited ? { inherited: true, parentSessionId: lease.parentSessionId, delegationDepth } : {}),
      ...(lease.manual ? { manual: true, manualReason: lease.manualReason } : {}),
      ...(lease.resumed ? { resumed: true, resumeReason: lease.resumeReason } : {}),
      ...(projectSkillEntries !== undefined ? { projectSkills: projectSkillEntries } : {}),
    }) + '\n');
  } catch {
    /* 台账写失败静默：声明已生效 */
  }
  // 占位结果字段组单源（终审简洁性发现 3）：两返回分支同构展开，改一处漏一处的风险面减半。
  const markerFields = { claimMarkerWritten: claimMarker.ok, ...(claimMarker.ok ? {} : { claimMarkerError: claimMarker.error }) };
  const degradedField = degradedNow.length > 0 ? { degraded: degradedNow } : {};
  if (inherited) {
    return { ok: true, claimWritten: false, claimMarkerWritten: false, claimMode: 'inherited', inherited: true, parentSessionId: lease.parentSessionId, delegationDepth, ...degradedField };
  }
  if (claimWritten) {
    return { ok: true, claimWritten: true, claimMode: claimAcq.mode, ...markerFields, ...degradedField };
  }
  return {
    ok: true,
    claimWritten: false,
    claimMode: claimAcq.mode,
    ...markerFields,
    ...degradedField,
    warning: '占用登记（claim）写盘失败：本次声明仍生效，但占用保护退化为 active 兜底（TTL 内有效）',
  };
}

/**
 * 释放本键占用的**明细版**（内部任务-342；内部规则-19 ④ / 内部任务-8 任务 4.2，供 routing-declare `--release` 消费）：
 * 删 claim + active + current 指针，返回 `{released, claims}`；claims 为被删 claim 中可映射占位者的
 * 明细 `{taskId, sid, markerPath, markerOk, error?}`（供报表 internal 归因；markerOk=false 不写伪 internal 行）。
 * **会话过滤语义**：`sessionId` 非空 → 只释放该会话的条目；`null`（CLI 形态）→ 释放本键**全部会话**
 * 的条目。CLI **未做**宿主会话标识推导（跨宿主取值面未定，转 内部未决-87），故以键为范围并如实输出
 * 后果（同键其他会话 active 一并删除、其写权限当场失效，需重新声明）。
 * fail-open：任何删除失败静默，返回已成功计数。
 * @param {string} key 项目键
 * @param {string|null} [sessionId] 目标会话标识（null=本键全部会话）
 * @returns {{released: number, claims: Array<{taskId: string, sid: string|null, markerPath: string, markerOk: boolean, error?: string}>}}
 */
export function releaseClaimEx(key, sessionId = null) {
  const sess = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const mine = (v) => {
    const s = typeof v === 'string' && v ? v : null;
    return sess === null || s === sess;
  };
  let released = 0;
  const claims = [];
  try {
    const dir = stateRootFor(key);
    const keyPrefix = `wf-lease-current-${keyDigest(key)}-`;
    for (const name of readdirSync(dir)) {
      try {
        if (name.startsWith('wf-lease-claim-')) {
          const c = readJson(join(dir, name));
          if (!c || c.projectKey !== String(key) || !mine(c.sessionId)) continue;
          rmSync(join(dir, name), { force: true });
          released += 1;
          // 内部决策-050 D2（内部任务-62）：占位登记同步 released——显式释放即回收，git 同步面
          // 可见「号已让出」（fail-open：占位缺席/损坏/持有者不匹配不阻断释放主链——
          // 持有者摘要防陈旧释放翻转他持有者的占位，终审约定维发现 2）。
          if (typeof c.taskId === 'string') {
            const norm = normalizeSession(c.sessionId);
            const marker = markClaimReleased(key, c.taskId, norm !== null ? sessDigest(norm) : null);
            claims.push({
              taskId: c.taskId,
              sid: typeof c.sessionId === 'string' && c.sessionId ? c.sessionId : null,
              markerPath: `docs/plans/claims/${c.taskId}.json`,
              markerOk: marker && marker.ok === true,
              ...(marker && marker.ok !== true ? { error: String(marker?.error ?? 'unknown') } : {}),
            });
          }
        } else if (name.startsWith('wf-lease-active-')) {
          const l = readJson(join(dir, name));
          if (!l || l.projectKey !== String(key) || !mine(l.sessionId)) continue;
          rmSync(join(dir, name), { force: true });
          released += 1;
        } else if (name.startsWith(keyPrefix)) {
          const p = readJson(join(dir, name));
          if (!p || !mine(p.sessionId)) continue;
          rmSync(join(dir, name), { force: true });
          released += 1;
        }
      } catch {
        /* 单件失败继续（fail-open） */
      }
    }
  } catch {
    /* fail-open */
  }
  return { released, claims };
}

/** 释放本键占用的兼容入口（返回释放计数）；明细版见 releaseClaimEx（内部任务-342）。 */
export function releaseClaim(key, sessionId = null) {
  return releaseClaimEx(key, sessionId).released;
}

/**
 * token 级定向回滚（内部决策-067 D5.4，内部任务-265）：审计写失败时只撤销本次激活产生的
 * active/（created|degraded 的）claim/占位，不删 current 指针（由 issueChallenge
 * 写入、不属激活产物），不影响同键其他任务/会话。失败项逐条返回，不抛。
 * @param {string} key 项目键
 * @param {{leaseId:string, taskId:string, claimMode?:string, markerWritten?:boolean, sessionId?:string|null}} req
 * @returns {{removed:string[], failed:Array<{path:string,error:string}>, residual:string[]}}
 */
export function rollbackActivation(key, req = {}) {
  const removed = [];
  const failed = [];
  const residual = ['issued-ledger', 'challenge-ledger', 'challenge-token', 'incidents', 'script-writes', 'script-edits'];
  const leaseId = typeof req.leaseId === 'string' ? req.leaseId : '';
  const taskId = typeof req.taskId === 'string' ? req.taskId : '';
  const sess = typeof req.sessionId === 'string' && req.sessionId ? req.sessionId : null;
  if (!leaseId || !taskId) {
    return { removed, failed: [{ path: '(input)', error: 'leaseId/taskId 缺失' }], residual };
  }
  // active：只删本 token 且 key 匹配的写权限文件
  try {
    const file = activeTokenFile(leaseId, key);
    const body = readJson(file);
    if (body && body.projectKey === String(key) && body.leaseId === leaseId) {
      try { rmSync(file, { force: true }); removed.push(file); } catch (e) {
        failed.push({ path: file, error: String(e?.message ?? e) });
      }
    }
  } catch (e) {
    failed.push({ path: '(active)', error: String(e?.message ?? e) });
  }
  // claim/占位：仅回滚本次新建（created/degraded）；refreshed/继承保留既有占用
  if (req.claimMode === 'created' || req.claimMode === 'degraded') {
    try {
      const file = claimFile(key, taskId);
      const body = readJson(file);
      const bodySess = body && typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
      if (body && body.taskId === String(taskId) && bodySess === sess) {
        try { rmSync(file, { force: true }); removed.push(file); } catch (e) {
          failed.push({ path: file, error: String(e?.message ?? e) });
        }
      }
    } catch (e) {
      failed.push({ path: '(claim)', error: String(e?.message ?? e) });
    }
    if (req.markerWritten === true) {
      const norm = normalizeSession(sess);
      const holderDigest = norm !== null ? sessDigest(norm) : null;
      const marker = markClaimReleased(key, taskId, holderDigest);
      if (marker.ok) removed.push(`claim-marker:${taskId}`);
      else failed.push({ path: `claims/${taskId}.json`, error: String(marker.error ?? 'unknown') });
    }
  }
  return { removed, failed, residual };
}

/**
 * 心跳续期（内部规则-19 ② / 内部任务-8 任务 4.3）：闸命中有效租约后调用，顺延 claim 与 active 的
 * expiresAt（同一顺延值 now+ttlMs，claim/active 同更）。
 * **节流判据落盘**（门 B F2 处置，2026-10-07）：剩余有效期 > 2/3 TTL ⇒ 无需续期（跳过写盘）——
 * 闸是「一次调用一进程」（hooks.json 声明为命令处理器），原进程内 Map 节流在生产形态**恒冷失效**
 * （实测每受闸调用都写盘）；盘上判据零额外 IO（本就要读 active）且跨进程一致。
 * 异常吞掉（心跳不阻断放行，fail-open）。
 * @param {{leaseId?: unknown, projectKey?: unknown, taskId?: unknown}} lease 读侧租约对象
 * @returns {boolean} 本次是否写盘（节流跳过/异常/缺字段返回 false）
 */
export function heartbeatLease(lease) {
  try {
    if (!lease || typeof lease !== 'object') return false;
    const id = typeof lease.leaseId === 'string' && lease.leaseId ? lease.leaseId : '';
    const key = typeof lease.projectKey === 'string' && lease.projectKey ? lease.projectKey : '';
    if (!id || !key) return false;
    const now = Date.now();
    const ttl = ttlMs();
    // active 回读分流（门禁实例2 发现「legacy v2 租约不续期」）：token 索引文件优先；
    // 未命中时按 legacy v2 形态（`wf-lease-active-<keyDigest>.json`，无 schemaVersion）
    // 回读同键文件并要求 leaseId 与调用方一致——否则 legacy 活跃会话按 TTL 落闸而占用被他人取得。
    let act = readJson(activeTokenFile(id, lease?.projectKey ?? null));
    let actFile = activeTokenFile(id, lease?.projectKey ?? null);
    if (!act) {
      const legacyFile = legacyActiveFile(key);
      const legacy = readJson(legacyFile);
      if (legacy && String(legacy.leaseId ?? '') === id) {
        act = legacy;
        actFile = legacyFile;
      }
    }
    const actExp = Number(act?.expiresAt);
    if (Number.isFinite(actExp) && actExp - now > (ttl * 2) / 3) return false; // 剩余充足：节流跳过
    // 内部任务-244 D03：写回前复核 active 件仍存在且令牌一致——轮换/清理删除后不得凭旧快照回写复活。
    if (process.env.WF_HEARTBEAT_RACE_DELETE === '1') {
      try { rmSync(actFile, { force: true }); } catch { /* 注入缝 */ }
    }
    if (!act || !leaseFileHasToken(actFile, id)) {
      recordLeaseReadAnomaly(key, 'active', 'rotated', {});
      return false;
    }
    // 内部任务-348/内部未决-214① CAS：写前内容复核——读侧快照与写之间的并发改写不得被旧快照覆盖。
    // 身份键不一致弃写（claim 比 sessionId/host 双键——null↔具名翻转或异宿主同 sessionId 均拒；
    // active 比 leaseId）——弃写＝本次未续期，租约按原 TTL 自然衰减（再声明摩擦，接受）；
    // 优于旧快照回写（回写会把并发新持有方 claim 覆盖回旧会话＝双持复活，恰是本项要消灭的
    // 窄窗）。弃写记 anomaly——生产面唯一实录信号源（两调用方均弃用布尔返回；内部未决-214①
    // 回头条件「并发双持实录」依赖）。仅 expiresAt 漂移（同会话心跳自竞态，良性）不记防噪。
    const expiresAt = now + ttl;
    if (typeof lease.taskId === 'string' && lease.taskId) {
      const c = readClaim(key, lease.taskId);
      if (c && Number.isFinite(Number(c.expiresAt))) {
        if (process.env.WF_CAS_INJECT_CLAIM_SWAP === '1') {
          // 测试缝：模拟「读侧快照之后、写之前」claim 被他会话改写
          atomicWrite(claimFile(key, lease.taskId), { ...c, sessionId: 'sess-other', expiresAt: Date.now() + 60000 });
        }
        const cNow = readClaim(key, lease.taskId);
        if (!cNow) {
          recordLeaseReadAnomaly(key, 'claim', 'cas-stale-window', {});
          return false;
        }
        // 身份双键比对（含 null↔具名翻转）：任一漂移即弃写——sameClaimOwner 对 null 侧放行，
        // 此处须严于它（写侧防御而非读侧判等）
        const sessFlip = String(cNow.sessionId ?? '') !== String(c.sessionId ?? '');
        const hostFlip = String(cNow.host ?? '') !== String(c.host ?? '');
        if (sessFlip || hostFlip) {
          recordLeaseReadAnomaly(key, 'claim', 'cas-stale-window', {});
          return false;
        }
        // 仅 expiresAt 漂移（同会话自竞态，良性）——以最新盘态为准续期（不记）
        writeClaim(key, { ...cNow, declaredAt: cNow.claimedAt, expiresAt });
      }
    }
    // active 复核紧邻其写（claim 块含一次盘写，其间并发方可轮换/删除）——写用复核值非旧快照
    const actNow = readJson(actFile);
    if (!actNow || String(actNow.leaseId ?? '') !== String(act.leaseId ?? '')) {
      recordLeaseReadAnomaly(key, 'active', 'cas-stale-window', {});
      return false;
    }
    atomicWrite(actFile, { ...actNow, expiresAt });
    return true;
  } catch {
    return false; // fail-open：心跳失败不阻断放行
  }
}

/**
 * 活动观测（内部决策-045 决策 2a/2b，内部任务-96）：PostToolUse 心跳观测点统一入口。
 * ① 会话持有效租约 → heartbeatLease 顺延（节流语义不变）；
 * ② 租约已过期但距过期 ≤ 一个 TTL 且会话身份匹配（均为具名——null 桶不复活，
 *    内部未决-118 语义不扩）→ **复活守卫（评审视角二 #1）**：先按撞号守卫同款判据扫同
 *    (projectKey, taskId) 的有效占用（claim ∪ 无 claim 兜底的 active；未过期＋异会话）——
 *    他会话已重持有同号（设计内延续路径，内部规则-8 双路指引①）时不复活（action='none'，
 *    可落审计 incident）；守卫通过 → 宽限复活：active 与 claim 的 expiresAt 重写 now+ttl
 *    （claim 重写前校验体归属——claim.sessionId===observer 才顺延，防改写他会话占用），
 *    落 incident 留痕（kind=lease-revive——排除面登记后不计待排查，incident-store 同批）；
 * ③ 其余（无租约/异会话/超宽限/null 桶过期/守卫命中他会话）→ 无操作。
 * 全路径不抛（异常吞、返回 {ok:false}）；返回值供测试断言。归因审计落项目根（canonicalRoot(activationRoot(key) ?? key)——incident-cli/readIncidents 可见，与 recordLeaseReadAnomaly 同款惯例）。
 * @param {string} key 项目键
 * @param {string|null} observer 观察会话（PostToolUse 负载 sessionId；null/'default' 只走 ①）
 * @returns {{ok: boolean, action: 'heartbeat'|'revived'|'none'|'error'}}
 */
export function reviveOrHeartbeat(key, observer) {
  try {
    const now = Date.now();
    const ttl = ttlMs();
    const obs = typeof observer === 'string' && observer && observer !== 'default' ? observer : null;
    const cur = readActiveLease(key, now, { sessionId: obs });
    if (cur.valid && cur.lease) {
      heartbeatLease(cur.lease);
      return { ok: true, action: 'heartbeat' };
    }
    if (obs === null) return { ok: true, action: 'none' }; // null 观察侧不复活（②要求具名匹配）
    // ② 扫过期 active 件找同会话租约（宽限窗内）
    let revived = null;
    let revivedFile = null;
    try {
      for (const name of readdirSync(stateRootFor(key))) {
        if (!name.startsWith('wf-lease-active-')) continue;
        const other = readJson(join(stateRootFor(key), name));
        if (!other || typeof other.taskId !== 'string' || other.projectKey !== String(key)) continue;
        if (other.sessionId !== obs) continue; // 会话身份匹配（具名）
        const exp = Number(other.expiresAt);
        if (!Number.isFinite(exp)) continue;
        const age = now - exp;
        if (age <= 0 || age > ttl) continue; // 未过期（读侧应已 valid——防御双跳）或超宽限
        revived = other;
        revivedFile = join(stateRootFor(key), name);
        break;
      }
    } catch {
      /* 扫描失败：无复活（保守） */
    }
    if (!revived) return { ok: true, action: 'none' };
    // 复活守卫：同 (projectKey, taskId) 有效占用（claim∪active 兜底）中存在**异会话**持有 → 不复活。
    // 判等统一**原串**（对齐本函数复活扫描与 activateLease 撞号守卫——终审发现 1：归一值与
    // 原串互比在带前缀会话 id 宿主上会误拒本会话占用）；claim 无**有效**占用时 active 兜底照走
    // （终审发现 7：claim 过期幸存态与撞号守卫「清后重判」同款判据）。
    const taskId = revived.taskId;
    const claim = readClaim(key, taskId);
    const claimHoldsOtherSession = (() => {
      if (!claim) return false;
      const cExp = Number(claim.expiresAt);
      return Number.isFinite(cExp) && cExp > now && typeof claim.sessionId === 'string' && claim.sessionId && claim.sessionId !== obs;
    })();
    let guardHit = claimHoldsOtherSession;
    let guardVia = 'claim';
    if (!claimHoldsOtherSession) {
      guardVia = 'active-fallback';
      try {
        for (const name of readdirSync(stateRootFor(key))) {
          if (!name.startsWith('wf-lease-active-')) continue;
          const other = readJson(join(stateRootFor(key), name));
          if (!other || other.taskId !== taskId || other.projectKey !== String(key)) continue;
          const oExp = Number(other.expiresAt);
          if (Number.isFinite(oExp) && oExp > now && typeof other.sessionId === 'string' && other.sessionId && other.sessionId !== obs) {
            guardHit = true;
            break;
          }
        }
      } catch {
        /* 扫描失败：保守放行复活（本会话自己的租约文件在手，误复活面窄） */
      }
    }
    if (guardHit) {
      appendIncident(canonicalRoot(String(activationRoot(String(key)) ?? key)), {
        id: `lr-guard-${digestOf([key, taskId, obs])}-${Math.floor(now / 60000)}`,
        ts: now,
        session: obs,
        taskId,
        skill: revived.skill ?? null,
        plugin: null,
        kind: 'lease-revive',
        host: revived.host ?? null,
        tool: null,
        event: null,
        digest: digestOf(['lease-revive-guard', key, taskId]),
        ...leaseClassification('lease-revive', 'hook:task-lease'),
        note: `复活守卫命中（${guardVia}）：该任务号已被他会话重新持有（设计内延续路径）——不复活，防双持并存`,
      });
      return { ok: true, action: 'none' };
    }
    // 宽限复活：双写顺延＋incident 留痕（claim 只在本会话归属时顺延——防改写他会话占用）
    // 内部任务-244 D04：写回前复核目标 active 件仍存在且令牌一致——清理/轮换删除后不得复活重建。
    if (process.env.WF_REVIVE_RACE_DELETE === '1') {
      try { rmSync(revivedFile, { force: true }); } catch { /* 注入缝 */ }
    }
    if (!leaseFileHasToken(revivedFile, String(revived.leaseId ?? ''))) {
      recordLeaseReadAnomaly(key, 'active', 'rotated', {});
      return { ok: true, action: 'none' };
    }
    // 内部任务-244 阶段门正确性评审阻塞 3b：写回前**再读 claim**——窗口内新声明若已建立 claim+active，
    // 复活旧 active 会形成双持；此处与写后各复核一次（写后不符即回滚旧 expiresAt 并放弃复活）。
    const claimNow = readClaim(key, taskId);
    const otherHoldsNow = claimNow && Number(claimNow.expiresAt) > now
      && typeof claimNow.sessionId === 'string' && claimNow.sessionId && claimNow.sessionId !== obs;
    if (otherHoldsNow) {
      recordLeaseReadAnomaly(key, 'active', 'rotated', {});
      return { ok: true, action: 'none' };
    }
    const expiresAt = now + ttl;
    atomicWrite(revivedFile, { ...revived, expiresAt });
    const claimAfter = readClaim(key, taskId);
    const otherHoldsAfter = claimAfter && Number(claimAfter.expiresAt) > Date.now()
      && typeof claimAfter.sessionId === 'string' && claimAfter.sessionId && claimAfter.sessionId !== obs;
    if (otherHoldsAfter) {
      try { atomicWrite(revivedFile, revived); } catch { /* 回滚尽力：不掩盖主失败面 */ }
      recordLeaseReadAnomaly(key, 'active', 'rotated', {});
      return { ok: true, action: 'none' };
    }
    if (claim && claim.sessionId === obs) {
      // 内部任务-348/内部未决-214①（S1 门 #1）：claim 写前身份复核——null 桶并发 claim（补签占位形态）
      // 不触发 otherHoldsNow/After 两道判据（均要求非空 sessionId），旧快照照写会覆盖他方；
      // 快照 vs 重读身份漂移（sessionId/host）即弃写并记 anomaly（三维约定维发现 2 补判别缝：
      // 复用 WF_CAS_INJECT_CLAIM_SWAP——写前复核读之前把 claim 翻回 null 桶，本路径返回值
      // 不变仍 action:'revived'，弃写仅以 anomaly 遥测承载，判别面＝claim 文件属主未被回写）。
      if (process.env.WF_CAS_INJECT_CLAIM_SWAP === '1') {
        try { writeClaim(key, { ...claim, sessionId: null, host: 'other-host', declaredAt: claim.claimedAt, expiresAt: Date.now() + 3600000 }); } catch { /* 注入缝 */ }
      }
      const cBeforeWrite = readClaim(key, taskId);
      const sessFlip = cBeforeWrite && String(cBeforeWrite.sessionId ?? '') !== String(claim.sessionId ?? '');
      const hostFlip = cBeforeWrite && String(cBeforeWrite.host ?? '') !== String(claim.host ?? '');
      if (cBeforeWrite && (sessFlip || hostFlip)) {
        recordLeaseReadAnomaly(key, 'claim', 'cas-stale-window', {});
      } else {
        writeClaim(key, { ...claim, declaredAt: claim.claimedAt, expiresAt });
      }
    }
    appendIncident(canonicalRoot(String(activationRoot(String(key)) ?? key)), {
      id: `lr-${digestOf([revived.leaseId ?? '', obs])}-${Math.floor(now / 60000)}`,
      ts: now,
      session: obs,
      taskId,
      skill: revived.skill ?? null,
      plugin: null,
      kind: 'lease-revive',
      host: revived.host ?? null,
      tool: null,
      event: null,
      digest: digestOf(['lease-revive', String(revived.leaseId ?? ''), taskId]),
      ...leaseClassification('lease-revive', 'hook:task-lease'),
      note: '宽限复活：过期 ≤1TTL 且会话匹配——active/claim 顺延（ADR-045 决策 2b）',
    });
    return { ok: true, action: 'revived' };
  } catch {
    return { ok: false, action: 'error' }; // fail-open：观测失败不抛、不阻断钩
  }
}

/**
 * 读取并判定激活租约有效性（闸侧）——current 指针路径 + 扫描回退（内部任务-LEASEGATE-1 F2，
 * 内部决策-018 修正案 2026-09-22）。指针路径逐项校验清单见 readViaPointer；指针失守（桶漂移/
 * null 桶弱形态轮换/指针悬空）时按隔离口径扫描本项目激活租约，命中即有效——签发落桶与
 * 校验解析桶不一致（宿主 session_id 可见性漂移）下已声明租约仍可达（桶对称化）。挑战 TTL
 * 只门控激活（activateLease），不回收已声明租约——扫描回退只看租约自身 TTL，不分桶。
 * 未命中时原样透传指针路径的 invalid 结果：reason 是 deny 分流契约字符串
 * （routing-gate denyMessage 精确/前缀匹配），不得改写——2026-09-26 内部任务-LEASEATT-1
 * 新增「挑战未激活（当前令牌尚未声明）」为增量枚举，既有字面全部保留。
 * @param {string} key 项目键
 * @param {number} [now] 判定时刻（缺省当前）
 * @param {{sessionId?: string|null}} [observer] 读取方（闸）可观察的会话标识
 * @returns {{valid: boolean, lease?: object, reason?: string, viaScan?: boolean, viaNullBucket?: boolean}}
 *          viaScan=扫描回退命中；viaNullBucket 仅当救回的是 null 桶租约时置 true
 *          （具名桶救回与指针路径直出均不带该键——内部任务-8/内部规则-18 定死形态）
 */
export function readActiveLease(key, now = Date.now(), observer = {}) {
  const viaPointer = readViaPointer(key, now, observer);
  if (viaPointer.valid) return viaPointer;
  const obs = typeof observer.sessionId === 'string' && observer.sessionId ? observer.sessionId : null;
  const rescued = newestVisibleActive(key, now, obs);
  if (rescued) {
    // null 桶救回 → 带可审计标注（内部规则-18）；具名桶救回不带该键
    const out = { valid: true, lease: rescued.lease, viaScan: true };
    if (rescued.viaNullBucket) out.viaNullBucket = true;
    return out;
  }
  return viaPointer;
}

/**
 * 扫描本项目中观察侧可见的最新激活租约——readActiveLease 扫描回退的数据源（内部函数，
 * 内部任务-LEASEGATE-1 阶段复审采纳降级：导出面必有外部消费方是本文件惯例；终审采纳单选化：
 * 唯一消费点只取最新一条，max 跟踪不排序）。过滤口径：projectKey 匹配 + 时间正常
 * （declaredAt≤now≤expiresAt，与 newestActiveLease 同款）+ **显式可见性表**（内部任务-8，
 * 内部规则-18 / 内部决策-018 修正案 2026-10-07 第 2 条）：
 *   观察侧 null   → 只可见 null 桶租约（lease.sessionId 非字符串/空 ⇒ null 桶）
 *   观察侧具名    → 只可见同会话桶租约 + null 桶租约
 *   「不确定即放宽」禁止——2026-09-22 修正案 5 的隐式「双边可见且不同才排除」语义废止
 *   （null 观察侧曾据此救回他会话声明，构成越权放行面，RC-1）。
 * legacy v2 active 文件（无 sessionId）按 null 桶语义全可见，与指针路径 legacy 回退同判有效。
 * 注意：与 newestActiveLease 的时间口径须两处同步（内部任务-LEASEGATE-1 刻意不合并——W2①
 * 补签冻结语义邻近面不进本批回归面）；与 recentDeclaredProjectKey 的隔离口径须同表。
 * @param {string} key 项目键
 * @param {number} [now] 判定时刻（缺省当前）
 * @param {string|null} [observerSess] 读取方可观察的会话标识（可缺省）
 * @returns {{lease: object, viaNullBucket: boolean}|null} 最新可见有效租约与 null 桶救回标注；
 *          无匹配/扫描异常返回 null
 */
function newestVisibleActive(key, now = Date.now(), observerSess = null) {
  try {
    const dir = stateRootFor(key);
    let best = null;
    let bestViaNull = false;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('wf-lease-active-')) continue;
      const lease = readJson(join(dir, name));
      if (!lease || lease.projectKey !== String(key)) continue;
      const at = Number(lease.declaredAt);
      const exp = Number(lease.expiresAt);
      if (!Number.isFinite(at) || !Number.isFinite(exp) || exp < now || at > now) continue;
      // 显式可见性表（内部任务-8，内部规则-18）：
      //   观察侧 null        → 只可见 null 桶租约（ls === null）
      //   观察侧具名         → 只可见同会话桶租约 + null 桶租约
      //   「不确定即放宽」禁止——隐式「双边可见且不同才排除」语义废止（内部决策-018 修正案 2026-10-07 第 2 条）
      const ls = typeof lease.sessionId === 'string' && lease.sessionId ? lease.sessionId : null;
      if (observerSess) {
        if (ls !== null && observerSess !== ls) continue; // 具名观察侧：他会话桶排除
      } else if (ls !== null) {
        continue; // null 观察侧：只认 null 桶
      }
      // null 桶救回 → 结果带可审计标注（内部规则-18 可审计路径义务）
      if (!best || at > Number(best.declaredAt)) {
        best = lease;
        bestViaNull = ls === null;
      }
    }
    return best ? { lease: best, viaNullBucket: bestViaNull } : null;
  } catch {
    return null;
  }
}

/**
 * current 指针路径校验（readActiveLease 的第一段，内部任务-LEASEGATE-1 F2 拆出）。
 * 解析顺序（内部决策-018）：观察会话桶 → null 桶 → legacy v2；命中后按
 * 活跃文件存在性/一致性/挑战过期/租约过期/未来时间/会话隔离逐项校验。
 * 激活文件缺失（非 legacy）判「挑战未激活（当前令牌尚未声明）」——「无有效态」家族，
 * 与「状态缺失或损坏」同挂 deny 跨键诊断（内部任务-LEASEATT-1）。
 * 有效 = 状态可解析 ∧ leaseId 与桶当前挑战一致 ∧ 双方可见 sessionId 一致 ∧ 未过期。
 * @param {string} key 项目键
 * @param {number} now 判定时刻
 * @param {{sessionId?: string|null}} observer 读取方（闸）可观察的会话标识
 * @returns {{valid: boolean, lease?: object, reason?: string}}
 */
function readViaPointer(key, now, observer) {
  const cur = resolveCurrent(key, observer.sessionId || null);
  if (!cur) {
    // 指针悬空细分（A2，2026-09-13 加固批次）：任一会话桶 current 指针在、token 合法、
    // 但挑战文件缺失——区别于全链无状态的笼统「损坏」，给等待重签发的可执行指引
    for (const sess of [observer.sessionId || null, null]) {
      const ptr = readJson(currentFile(key, sess));
      if (ptr && TOKEN_RE.test(String(ptr.leaseId ?? ''))) {
        // 内部任务-27 坑1：损坏与缺失分态（原 readJson 全吞使两态同文案）
        const chRead = readJsonState(challengeTokenFile(ptr.leaseId, key));
        if (chRead.state === 'corrupt') {
          recordLeaseReadAnomaly(key, 'challenge', 'corrupt', {});
          return { valid: false, reason: `${LEASE_REASONS.DANGLING_POINTER}（挑战文件损坏不可解析，等待下一条用户消息重新签发；反复出现请检查状态目录写权限/磁盘）` };
        }
        if (chRead.state === 'absent') {
          return { valid: false, reason: `${LEASE_REASONS.DANGLING_POINTER}（挑战文件缺失，等待下一条用户消息重新签发）` };
        }
      }
    }
    return { valid: false, reason: LEASE_REASONS.STATE_MISSING };
  }
  const leaseFile = cur.legacy ? legacyActiveFile(key) : activeTokenFile(cur.leaseId, key);
  const leaseRead = readJsonState(leaseFile);
  const lease = leaseRead.value;
  if (!lease) {
    // 2026-09-26 内部任务-LEASEATT-1：挑战存活而激活文件缺失——轮换删旧挑战+激活不留史
    // （issueChallenge 桶内吊销段）、租约 TTL 恒晚于挑战 TTL（激活时刻>签发时刻+同 TTL），
    // 故挑战存活时激活缺失恒等于「当前令牌从未激活」；真轮换残留（leaseId 不匹配/legacy）
    // 在下方分支仍报「prompt 已轮换」。存在但损坏（corrupt 态）归「状态缺失或损坏」并落
    // 取证——单次三态读分流，消 readJson+existsSync 双查窗口（终审正确性发现 1：窗口内
    // 并发激活落盘会被误诊 corrupt；readJsonState 的读时 ENOENT 同归缺席＝轮换语义）。
    if (!cur.legacy && leaseRead.state === 'absent') return { valid: false, reason: LEASE_REASONS.UNACTIVATED };
    if (leaseRead.state === 'corrupt') recordLeaseReadAnomaly(key, 'lease', 'corrupt', {});
    return { valid: false, reason: LEASE_REASONS.STATE_MISSING };
  }
  if (lease.leaseId !== cur.leaseId) return { valid: false, reason: LEASE_REASONS.ROTATED, lease };
  const ch = cur.ch;
  if (!ch) return { valid: false, reason: cur.legacy ? LEASE_REASONS.STATE_MISSING : LEASE_REASONS.ROTATED, lease };
  const challengeExpires = Number(ch.expiresAt);
  if (Number.isFinite(challengeExpires) && challengeExpires < now) {
    return { valid: false, reason: `${LEASE_REASONS.EXPIRED_CHALLENGE}（须用最新一轮租约令牌重新声明）`, lease };
  }
  const expires = Number(lease.expiresAt);
  if (!Number.isFinite(expires) || expires < now) return { valid: false, reason: LEASE_REASONS.LEASE_EXPIRED, lease };
  const declared = Number(lease.declaredAt);
  if (Number.isFinite(declared) && declared > now) {
    return { valid: false, reason: LEASE_REASONS.TIME_ANOMALY, lease };
  }
  const chIssued = Number(ch.issuedAt);
  if (Number.isFinite(chIssued) && chIssued > now) {
    return { valid: false, reason: LEASE_REASONS.TIME_ANOMALY, lease };
  }
  // 会话隔离（纵深防御）：双方 sessionId 均可见且不同 → 拒绝（不可见时不比对）。
  const obsSess = typeof observer.sessionId === 'string' && observer.sessionId ? observer.sessionId : null;
  const leaseSess = typeof lease.sessionId === 'string' && lease.sessionId ? lease.sessionId : null;
  if (obsSess && leaseSess && obsSess !== leaseSess) {
    return { valid: false, reason: LEASE_REASONS.OTHER_SESSION, lease };
  }
  return { valid: true, lease };
}

/**
 * 主键最新有效激活租约（2026-09-16 租约族缺陷批次，W2① 补签前置）：扫描本项目全部
 * active-<token> 条目，取 declaredAt 最新且未过期、时间正常者。与 readActiveLease 的
 * 差别：不经 current 指针解析、不区分会话桶——Bash 发起的 --bootstrap-reissue 无观察
 * 会话标识（内部决策-4 实测），但能跑声明命令的进程必与主键声明同会话上下文（见
 * 内部接口-19 补签段）；返回的 sessionId 仅审计归因用——补签挑战恒挂 null 桶（D1，
 * 内部任务-24/内部任务-99：继承他会话桶构成真会话闸死循环，勿改回继承形态）。
 * 注意：时间/隔离口径与 scanActiveLeases（内部任务-LEASEGATE-1）须两处同步——本函数无
 * 隔离过滤（补签前置刻意全可见），改时间口径或补隔离时两处同改。
 * @param {string} key 项目键
 * @param {number} [now] 判定时刻（缺省当前）
 * @returns {object|null} 最新有效租约对象（含 sessionId/taskId/skill/declaredAt）；无则 null
 */
export function newestActiveLease(key, now = Date.now()) {
  try {
    const dir = stateRootFor(key);
    let best = null;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('wf-lease-active-')) continue;
      const lease = readJson(join(dir, name));
      if (!lease || lease.projectKey !== String(key)) continue;
      const at = Number(lease.declaredAt);
      const exp = Number(lease.expiresAt);
      if (!Number.isFinite(at) || !Number.isFinite(exp) || exp < now || at > now) continue;
      if (!best || at > Number(best.declaredAt)) best = lease;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 最近成功声明键诊断（deny「状态缺失或损坏」分支的跨键提示数据源，2026-09-13 嵌套仓
 * 死锁修复）：扫描激活租约，按**显式可见性表**过滤（内部任务-8/内部规则-18，与 newestVisibleActive
 * 同表——观察侧 null 只认 null 桶、观察侧具名只认同会话桶 + null 桶；两处判据不得分叉），
 * 取 declaredAt 最新者的 projectKey；无候选或扫描失败返回 null。
 * 仅用于诊断文案，不参与放行判定。
 * @param {string|null} [observerSess] 观察侧会话标识
 * @returns {string|null} 最近成功声明的租约键（项目根路径）
 */
export function recentDeclaredProjectKey(observerSess = null) {
  try {
    const obs = typeof observerSess === 'string' && observerSess ? observerSess : null;
    // 诊断专用扫描面：本函数**无键入参**（deny 文案取"最近成功声明"），故仍按 cwd 根扫描——
    // 多根/opt-in 下只覆盖 cwd 键的解析根（范围表已注明；不参与放行判定，故不构成失效面）。
    const dir = stateDir();
    let best = null;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('wf-lease-active-')) continue;
      const lease = readJson(join(dir, name));
      if (!lease || typeof lease.projectKey !== 'string' || !lease.projectKey) continue;
      // 显式可见性表（内部任务-8，内部规则-18；头注「同款隔离语义」已按显式表修订）
      const ls = typeof lease.sessionId === 'string' && lease.sessionId ? lease.sessionId : null;
      if (obs) {
        if (ls !== null && obs !== ls) continue; // 具名观察侧：他会话桶排除
      } else if (ls !== null) {
        continue; // null 观察侧：只认 null 桶
      }
      const at = Number(lease.declaredAt);
      if (!Number.isFinite(at)) continue; // 半损坏条目不得占据「最近」位（NaN 比较恒 false 会冻结 best）
      if (!best || at > best.at) best = { at, key: lease.projectKey };
    }
    return best ? best.key : null;
  } catch {
    return undefined; // 扫描失败与「确无租约」（null）区分：失败不出诊断，避免误指签发 hook
  }
}

/**
 * bootstrap 拒绝诊断（坑 3）：无租约 Bash 的声明命令含 shell 控制字符（管道/链式/重定向/
 * 命令替换/分隔）时给出明确提示文案，否则空串——deny 文案据此把被拒原因说清（deny 即
 * 用法教育位，诊断写进文案比 README/口头纪律可靠）。仅对声明尝试（命令字串含
 * routing-declare）生效：普通复合命令被拒的主因是无租约而非元字符，去掉管道也过不了闸，
 * 主文案已是正确指引，附加本提示只会制造死路。
 * @param {string} cmd 负载命令
 * @returns {string} 提示文案（非声明命令或无控制字符时为空串）
 */
// 双引号包裹的 cd 目标词法（内部未决-10）：引号内限绝对路径起笔（/ 或 盘符:/\），
// 禁 `"`/`$`/反引号——bash 双引号展开面的安全边界（cd 目标无 resolve 核验，与
// 单段脚本路径不同——后者有 expectedScript 钉死兜底故单段词法可容忍单个 $）。
// `&&` 两侧空白为量词形态（内部任务-2 批 B3）：字面单空格 ` && ` 会误拒双空格等合法排版。
const CD_JOIN = '[ \\t\\r\\f\\v]+&&[ \\t\\r\\f\\v]+';
const CD_TARGET_QUOTED = new RegExp(`^cd ("(?:\\/|[A-Za-z]:[\\\\/])[^"$\`]+")${CD_JOIN}`);
const CD_TWO_SEGMENT = new RegExp(`^cd ("(?:\\/|[A-Za-z]:[\\\\/])[^"$\`]+"|\\/[^\\s|&><;\`$()]+|[A-Za-z]:[\\\\/][^\\s|&><;\`$()]+)${CD_JOIN}(.+)$`);

export function bootstrapRejectHint(cmd) {
  if (typeof cmd !== 'string' || !cmd) return '';
  if (!cmd.includes('routing-declare')) return '';
  // 内部未决-10 专项：cd 两段形态但目标未匹配（典型=含空白未加引号）——引导双引号包裹，
  // 而非误指为复合命令问题（&& 两段本身是解析面放行的合法形态）。cd 段已合法时
  // fall through 到元字符文案（真因在第二段的场景须拿到「纯净单命令」指引，内部模块-8 条款）。
  if (/^cd /.test(cmd) && cmd.includes('&&') && !CD_TARGET_QUOTED.test(cmd) && !new RegExp(`^cd (\\/[^\\s|&><;\`$()]+|[A-Za-z]:[\\\\/][^\\s|&><;\`$()]+)${CD_JOIN}`).test(cmd)) {
    return 'cd 目标含空白时请用双引号包裹（如 cd "C:/Program Files/repo" && node …）——引号内须绝对路径起笔，且不得含 $ 或反引号（bash 双引号展开面）。';
  }
  if (SHELL_SEP_RE.test(cmd) || SHELL_META_RE.test(cmd)) {
    // 内部任务-41（FIX-3 承接 #2）：首句点明「单独成条」——该指引在事故引信时刻出现，
    // 经 denyMessage 头窗前置渲染（P7 截断教训），措辞按可照抄动作组织。
    return '声明命令请单独成条发送——检测到命令含管道/链式混入非声明命令/重定向/命令替换符号，bootstrap 仅放行严格解析的声明命令（单条，或多条纯 routing-declare 声明命令的顺序拼接——; / && / 换行切段、逐段独立严格解析），请去掉非声明部分后原样运行。';
  }
  return '';
}

/**
 * @deprecated 内部任务-342 起记录消费点改用 {@link leaseContextOfOwn}（本会话具名桶 own-only 归因）；
 * 本函数保留为**可见性口径**的公共兼容导出（无生产调用者），勿新增消费。
 * 活跃租约的任务上下文快照（自察记录归因用，内部模块-15/内部决策-019）：返回当前有效租约的
 * {taskId, skill}，无租约/不可读/字段异常一律 {taskId:null, skill:null}——记录方
 * 不得因租约状态而失败（失败常发生在声明之前）。
 * observer 会话透传（内部任务-LEASEGATE-1 阶段复审采纳）：扫描回退生效后无 observer 会把
 * 本会话事件归因到他会话的最新租约（session=B + taskId=A 的混行）——调用方须传各自
 * 已解析的会话标识，扫描隔离口径据此过滤。
 * @param {string} cwd 项目目录（与闸/声明同款 projectKey 推导，调用方传入）
 * @param {string|null} [sessionId] 记录方会话标识（可缺省）
 * @returns {{taskId: string|null, skill: string|null}}
 */
export function leaseContextOf(cwd, sessionId = null) {
  try {
    const lease = readActiveLease(projectKey(cwd), Date.now(), { sessionId: sessionId || null });
    if (lease.valid && lease.lease) {
      return {
        taskId: typeof lease.lease.taskId === 'string' ? lease.lease.taskId : null,
        skill: typeof lease.lease.skill === 'string' ? lease.lease.skill : null,
      };
    }
  } catch {
    /* 租约状态不可读：归因字段置空，不影响记录主职责 */
  }
  return { taskId: null, skill: null };
}

/**
 * 本会话具名桶租约判定单源（内部任务-342）：lease 存在、sessionId 为非空字符串（且非 'default' 哨兵，
 * 该哨兵在记录入口已归一为 null）并与 lease.sessionId 严格相等时返回 lease，否则 null。
 * 可见性≠归因：null 桶（补签可见性形态）与他会话租约不参与归因。
 * 调用方各自决定用已读 lease（闸侧不二次读）还是 readActiveLease 结果。
 * @param {object|null} lease 租约对象
 * @param {string|null} sessionId 记录方会话标识
 * @returns {object|null}
 */
export function ownNamedLease(lease, sessionId) {
  if (!lease || typeof lease !== 'object') return null;
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === 'default') return null;
  if (typeof lease.sessionId !== 'string' || lease.sessionId === '' || lease.sessionId !== sessionId) return null;
  return lease;
}

/**
 * 归因专用租约快照（内部任务-342/内部决策-066 修正案 2 内部模块-1）：只认**本会话具名桶**租约；null 桶（补签可见性
 * 形态）与他会话租约不参与归因（无本会话租约 → null）。与 leaseContextOf 的差别是**可见性≠归因**：
 * 闸侧可见性/补签语义不变，仅记录归因字段用它。sessionId 须为非空字符串且与 lease.sessionId 严格相等。
 * @param {string} cwd 项目目录
 * @param {string|null} [sessionId] 记录方会话标识
 * @returns {{taskId: string|null, skill: string|null}}
 */
export function leaseContextOfOwn(cwd, sessionId = null) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return { taskId: null, skill: null };
    const lease = readActiveLease(projectKey(cwd), Date.now(), { sessionId });
    const l = ownNamedLease(lease.valid ? lease.lease : null, sessionId);
    if (l) {
      return {
        taskId: typeof l.taskId === 'string' ? l.taskId : null,
        skill: typeof l.skill === 'string' ? l.skill : null,
      };
    }
  } catch {
    /* 归因失败不阻断记录主职责 */
  }
  return { taskId: null, skill: null };
}

/**
 * P5 声明链切段（2026-10-10 内部任务-29 / 内部任务-103 P5，内部规则-9 扩）：按**引号外**分隔符
 * 集合切分命令串；无引号外分隔符返回 null（走单命令严格解析，行为不变）；段 trim
 * （`A; cd …` 段首空白不致 CD 锚失配——三维评审处置），空段原样保留——空段经
 * isBootstrapDeclareCommand 递归判 false，`;;`/尾随分隔符等形态整体拒。两级切分
 * 语义在调用侧：先 `;`/换行（cd 两段的 `&&` 绑定优先——`A; cd /r && D2` 的 cd 段
 * 不可被 && 拆散），段内非 cd 起笔再 `&&` 细切（纯声明 `A && B` 形态）。引号内的
 * 分隔字符不切段（与既有单命令口径一致：段内含引号内分隔符仍由 SHELL_SEP_RE 拒，
 * 不因链式放宽禁面）。
 * @param {string} cmd 命令串
 * @param {string[]} seps 单字符分隔符集合（可含 '&&' 双字符项）
 * @returns {string[]|null} 段数组（含引号外分隔符时）或 null
 */
function splitDeclareChain(cmd, seps) {
  let sawSep = false;
  let inQuote = false;
  const segs = [];
  let cur = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    // 双/单引号态跟踪（内部未决-94，内部任务-50）：注入命令自本批起为单引号形态，单引号段内的
    // `&&`/分隔符不得当链切点——与双引号同权 toggle。
    if (c === '"' || c === "'") {
      inQuote = !inQuote;
      cur += c;
      continue;
    }
    let hit = false;
    let skip = 0;
    if (!inQuote) {
      if (seps.includes(c)) hit = true;
      else if (seps.includes('&&') && c === '&' && cmd[i + 1] === '&') {
        hit = true;
        skip = 1; // 跳过第二个 &
      }
    }
    if (hit) {
      sawSep = true;
      segs.push(cur.trim());
      cur = '';
      i += skip;
      continue;
    }
    cur += c;
  }
  segs.push(cur.trim());
  return sawSep ? segs : null;
}

/**
 * Bash bootstrap 严格解析：无租约时放行「严格解析的声明命令」——单条，或多条纯
 * 声明命令的顺序拼接（P5，2026-10-10 内部任务-29：引号外 `;`/`&&`/换行切段、逐段
 * 独立过本函数，任一段非声明形态或空段即整体拒——双仓双键工作区单条 Bash 合并
 * 两键声明）。管道/重定向/命令替换/裸 `&` 仍拒（段内 SHELL_META_RE 一票否决）。
 * 传入 expectedScript 时进一步钉死脚本路径（resolve 后与预期严格相等——防前缀
 * 欺骗与同名脚本冒充；闸侧持有 ZCODE_PLUGIN_ROOT，应始终传入；链式逐段生效）。
 * @param {string} cmd
 * @param {string|null} [expectedScript] 预期脚本绝对路径（缺省退化为后缀匹配）
 * @returns {boolean}
 */
export function isBootstrapDeclareCommand(cmd, expectedScript = null) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  // cd 两段形态（D1，2026-09-13 加固批次；2026-09-14 补 Windows 盘符形态）：cd <绝对路径>
  // && node <routing-declare.mjs> [args…]——解 A1 嵌套仓死锁的第一出路（声明键随进程
  // cwd 切到目标仓）。绝对路径接受 POSIX（/…）与盘符（C:/… 或 C:\…；Git Bash 实测前斜杠
  // 形态可用，反斜杠形态在宿主 shell 内自会失败而非误键）两种写法；2026-09-15 内部未决-10
  // 批次补双引号分支：含空白目标（Windows 常见 C:\Program Files\…）须 "…" 包裹（限绝对
  // 路径起笔），引号内禁 `"`/`$`/反引号——安全边界依据见 CD_TARGET_QUOTED 注释。
  // 第二段交递归统一裁决（含 P5 链式切段——cd 前缀只作用首段，后续段逐段独立
  // 严格解析；段内元字符由递归的单命令拒绝面拦截）。
  const cdMatch = cmd.match(CD_TWO_SEGMENT);
  if (cdMatch) {
    return isBootstrapDeclareCommand(cdMatch[2], expectedScript);
  }
  // P5 链式拼接：两级切分——先 `;`/换行（cd 两段的 && 绑定优先，段不可被拆散），
  // 段内非 cd 起笔再 `&&` 细切；逐段递归，全过才放行。
  const semis = splitDeclareChain(cmd, [';', '\n', '\r']);
  if (semis !== null) {
    return semis.every((seg) => isBootstrapDeclareCommand(seg, expectedScript));
  }
  const ands = splitDeclareChain(cmd, ['&&']);
  if (ands !== null) {
    return ands.every((seg) => isBootstrapDeclareCommand(seg, expectedScript));
  }
  if (SHELL_SEP_RE.test(cmd)) return false;
  if (SHELL_META_RE.test(cmd)) return false;
  // 去引号路径词法：node <路径含 routing-declare.mjs> [args...]——双/单引号段同权成单
  // token、首尾引号同剥（内部未决-94，内部任务-50：注入命令单引号形态，双接受保持旧命令放行；
  // 含空格路径的两种包裹都能成单 token）。
  const tokens = cmd.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  if (tokens.length < 2) return false;
  if (tokens[0] !== 'node') return false;
  const script = tokens[1].replace(/^["']|["']$/g, '');
  if (expectedScript !== null) {
    return resolve(script) === resolve(expectedScript);
  }
  if (!/routing-declare\.mjs$/.test(script)) return false;
  return true;
}

/** 只读命令白名单（2026-09-16 使用反馈批次 P8）：无租约 Bash 的放行面——纯读取，
 *  不含任何改状态或执行任意代码的能力（解释器类一律不在面内，node -e/python -c 与
 *  git -c 都是任意代码面——-c 可注入 diff.external/core.fsmonitor 等执行类配置，
 *  2026-09-19 评审修复 C1 收紧）。研究自由不设硬门（内部决策-3）在 Bash 侧的落地：
 *  只读用法不必先声明。
 *  2026-09-26 内部任务-ROCMD-1 扩面：+31 纯读/纯输出命令与 +4 git 子命令（口径=无写面/
 *  无执行面，完整清单见 内部规则-14）；负面参数表由 find 特例泛化为 COMMAND_WRITE_ARGS/
 *  GIT_SUB_WRITE_ARGS；deny 文案清单指针指向本表区（概括式，防枚举漂移）。 */
const READONLY_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'grep', 'wc', 'find',
  // 2026-09-26 内部任务-ROCMD-1 扩面（echo/printf 纯 stdout 输出无状态面故纳入；md5sum/
  // sha256sum 等仅许可面条目而非脚本调用，不涉跨平台裸假设与 lint 调用锚）
  'stat', 'file', 'du', 'df', 'id', 'whoami', 'uname', 'which', 'whereis', 'type',
  'basename', 'dirname', 'printenv', 'realpath', 'readlink',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'base64', 'od',
  'nl', 'tac', 'rev', 'column', 'seq', 'date', 'echo', 'printf', 'sort',
  // 注：xxd **不在**白名单——内部任务-244 阶段门安全评审阻塞 2：xxd 第二位置参数即输出文件，
  // 无需 -r 亦可创建/截断/覆写任意路径（命令名本身即写面，无法靠负面参数穷尽）。
]);
/** git 只读子命令集（白名单外一律不放行——push/commit/checkout/reset 等皆为写面；
 *  hash-object/grep 受 GIT_SUB_WRITE_ARGS 负面表收紧，内部任务-ROCMD-1）。 */
const READONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'shortlog',
  'ls-remote', 'describe', 'hash-object', 'grep']);
/** git 全局旗标：带值者（取值后再定子命令）与纯开关者分列——`git -C <dir> status` 是常见只读形态。
 *  -c 不在面内（2026-09-19 评审修复 C1）：-c <任意配置>=<值> 是任意执行面，fail-closed 整拒；
 *  --exec-path 亦移出（内部任务-ROCMD-1 收尾终审发现 3）：spawn 型子命令（ls-remote 起
 *  git-upload-pack）语境下可劫持执行路径，同 -c 口径整拒；其余带值旗标保留——白名单内
 *  其余子命令全为 builtin，无外部程序消费面。 */
const GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
const GIT_SWITCH_FLAGS = new Set(['--no-pager', '--no-replace-objects', '--literal-pathspecs']);
/** `git branch` 的列举型旗标（branch 只在列举形态下只读：-d/-D/-m/-f/新分支名/--set-upstream-to 皆写面）。 */
const GIT_BRANCH_LIST_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list',
  '--show-current', '--points-at', '--contains', '--no-contains', '--merged', '--no-merged']);
/** 普通命令负面参数表（内部任务-ROCMD-1：P8 批次的 FIND_WRITE_ARGS 特例泛化，find 为
 *  首项行为等价迁移）：tokens=精确 token 拒、prefixes=前缀拒、cluster=短旗标簇正则拒
 *  （GNU getopt 短旗标捆绑逃逸——`date -us`/`sort -ro`/`file -bC` 类簇内含写旗标字母，
 *  正则按命令各自给定且大小写敏感；date 的 (?!I) 放行 `-Iseconds` 类 timespec 连值）。
 *  find 的 -exec 家族可执行任意命令、-fprint 家族写文件、-okdir 同 -ok 家族；date
 *  -s/--set 改系统时钟；sort -o/--output= 写文件；file -C/--compile 编译 magic 落盘。
 *  命中即拒，fail-closed 收紧方向（收尾终审发现 1/4/5 处置）。 */
const COMMAND_WRITE_ARGS = new Map([
  ['find', { tokens: new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls', '-fprint0']) }],
  // 内部任务-244 阶段门安全评审：GNU getopt_long 支持唯一前缀缩写——`sort --out=/p` ≡ `-o`，
  // `--compress-prog=…`/`--temp=…` 同族；故 dangerous 长选项以 `long` 前缀族拒（≥3 字符前缀）。
  ['date', { tokens: new Set(['-s', '--set']), prefixes: [/^--set=/], long: ['--set'], cluster: /^-(?!-)(?!I)[A-Za-z]*s/ }],
  // 内部任务-244 S06 + 阶段门：sort 的写/执行面——-o/--output 写文件；--compress-program 执行任意程序、
  // -T/--temporary-directory 在任意目录建临时文件。
  ['sort', { tokens: new Set(['-o', '-T']), prefixes: [/^--output(=|$)/, /^--compress-program(=|$)/, /^--temporary-directory(=|$)/, /^-T./], long: ['--output', '--compress-program', '--temporary-directory'], cluster: /^-(?!-)[A-Za-z]*(?:o|T)/ }],
  ['file', { tokens: new Set(['-C', '--compile']), long: ['--compile'], cluster: /^-(?!-)[A-Za-z]*C/ }],
]);
/** git 子命令负面参数表（内部任务-ROCMD-1）：hash-object -w 写对象库；git grep 的 -O 与
 *  --open 两族依参数起 pager（含短簇 -nO 形态）；ls-remote --upload-pack=<prog> 指定
 *  执行程序（收尾终审发现 2/3 处置）。内部任务-244 阶段门：长选项前缀缩写同拒（`long` 族）。 */
const GIT_SUB_WRITE_ARGS = new Map([
  ['hash-object', { tokens: new Set(['-w']) }],
  ['grep', { prefixes: [/^-O/, /^--open/], long: ['--open-in-pager', '--open-files-in-pager'], cluster: /^-(?!-)[A-Za-z]*O/ }],
  ['ls-remote', { prefixes: [/^--upload-pack(=|$)/], long: ['--upload-pack'] }],
]);

/**
 * Bash 只读命令判定（2026-09-16 使用反馈批次 P8）：与 bootstrap 声明命令共用同一套
 * 词法底线——**引号之外**出现管道/重定向/命令替换/分隔符即拒（重定向能把「只读命令」
 * 变成写文件；引号内的 `|`、'>' 是正则或文件名的一部分，交给 shell 时已被引用，
 * 不构成 shell 语义——故先剥引号片段再测），再按命令名与参数白名单收窄。
 * 姿态同闸其余判定：非白名单即拒绝（fail-closed 于放行面；异常一律交函数外按既有
 * deny 流程处理，fail-open 于异常面）。
 * @param {string} cmd 负载命令
 * @returns {boolean} 可放行（只读）为真
 */
/**
 * shell 词法底线解析（内部任务-244 阶段门安全评审阻塞 1 修复）：按引号状态机逐字符解析——
 * 单引号内全字面量；双引号内保留内容供展开检查且其中的单引号是字面量；反斜杠转义下一字符。
 * 原实现「先剥单引号段再匹配双引号」会把 `ls "'$(id)'"` 归一成 `ls ""` 漏检命令替换。
 * @param {string} cmd 命令文本
 * @returns {{tokens: string[], unquoted: string, dq: string}|null} null=未配对引号/悬空转义（fail-closed）
 */
function lexReadOnlyCommand(cmd) {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let state = 'none';
  let unquoted = '';
  let dq = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (state === 'none') {
      // 内部任务-244 最终安全评审 B1：shell 展开面 fail-closed——引号外 `$`/`{`/`}` 可构成
      // `${IFS}` 分词、brace expansion（`{--output,/tmp/pwn}`），使词法 token 冒充无害参数；
      // 白名单命令不需要任何展开，一律拒绝（单引号内为字面量，不受影响）。
      if (c === '$' || c === '{' || c === '}') return null;
      if (c === "'") { state = 'single'; inToken = true; continue; }
      if (c === '"') { state = 'double'; inToken = true; continue; }
      if (c === '\\') {
        if (i + 1 >= cmd.length) return null;
        const n = cmd[i + 1];
        cur += n; unquoted += n; inToken = true; i += 1; continue;
      }
      if (/\s/.test(c)) {
        if (inToken) { tokens.push(cur); cur = ''; inToken = false; }
        unquoted += c; continue;
      }
      cur += c; unquoted += c; inToken = true; continue;
    }
    if (state === 'single') {
      if (c === "'") { state = 'none'; continue; }
      cur += c; inToken = true; continue;
    }
    // double：内容进 token 与 dq；反斜杠转义下一字符
    if (c === '\\') {
      if (i + 1 >= cmd.length) return null;
      const n = cmd[i + 1];
      cur += n; dq += n; inToken = true; i += 1; continue;
    }
    // 内部任务-244 最终安全评审 B1：双引号内 `$`/反引号仍会展开（`"${IFS}"`/`$VAR`）——
    // 白名单命令不需要变量展开，一律 fail-closed（转义 `\$` 走上支保留字面量）。
    if (c === '$' || c === '`') return null;
    if (c === '"') { state = 'none'; continue; }
    cur += c; dq += c; inToken = true; continue;
  }
  if (state !== 'none') return null;
  if (inToken) tokens.push(cur);
  return { tokens, unquoted, dq };
}

/**
 * 长选项前缀缩写判定（GNU getopt_long 唯一前缀语义）：a 以 `--` 开头且是 dangerous 全名
 * 的 ≥3 字符前缀（去 `=值`）即命中——`sort --out=/p` ≡ `-o`（阶段门安全评审阻塞 2）。
 * @param {string} a 参数 token @param {string[]|undefined} longs dangerous 长选项全名
 * @returns {boolean}
 */
function isLongAbbrev(a, longs) {
  if (!Array.isArray(longs) || longs.length === 0 || !a.startsWith('--')) return false;
  const name = a.split('=')[0];
  return name.length >= 3 && longs.some((full) => full.startsWith(name));
}

export function isReadOnlyCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  // 内部任务-244 S01/S06 阶段门修复：按 shell 引号状态机逐字符解析（单引号字面量/双引号展开面/
  // 反斜杠转义/未配对 fail-closed），替代「先剥单引号再匹配双引号」的漏检归一。
  const lex = lexReadOnlyCommand(cmd);
  if (lex === null) return false;
  const { tokens, unquoted, dq } = lex;
  if (/\$\(|`/.test(dq)) return false; // 双引号内命令替换/反引号仍会展开（bash/pwsh）
  if (SHELL_SEP_RE.test(unquoted) || SHELL_META_RE.test(unquoted)) return false;
  if (tokens.length === 0) return false;
  const bare = (t) => t;
  const firstRaw = bare(tokens[0]);
  // 环境赋值前缀（`FOO=bar ls`）：bash 词法无法在纯文本层可靠再解析，一律拒
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstRaw)) return false;
  // 命令名形态（内部任务-244 S03）：只接受**裸名**——含路径分隔符/盘符/UNC/家目录前缀或 `.exe`
  // 后缀一律拒。basename 归一会让仓内/远端可执行文件（克隆仓可携带 `ls`/`ls.exe`，Windows
  // 还会搜索 cwd）冒充系统命令；sudo/env 等提权与注入面本来就不在白名单。
  if (/[\\/:]/.test(firstRaw) || /^~/.test(firstRaw) || /\.exe$/i.test(firstRaw)) return false;
  const first = firstRaw;
  if (first === 'git') {
    let i = 1;
    // 跳过 git 全局旗标后再取子命令（带值旗标连其值一起跳过）
    for (; i < tokens.length; i += 1) {
      const t = bare(tokens[i]);
      if (GIT_VALUE_FLAGS.has(t)) {
        i += 1;
        continue;
      }
      if (GIT_SWITCH_FLAGS.has(t)) continue;
      break;
    }
    const sub = i < tokens.length ? bare(tokens[i]) : '';
    if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    // 写文件参数面（2026-09-19 评审修复 C1）：diff/show/log 家族的 --output=<path> 把
    // 「只读」变成写任意文件，一律拒（branch 的列举形态过滤更严，天然不含该形态）
    for (const t of tokens.slice(i + 1)) {
      if (/^--output(=|$)/.test(bare(t))) return false;
    }
    // git 子命令负面参数表（内部任务-ROCMD-1）：hash-object -w / git grep -O* / ls-remote
    // --upload-pack 等子命令级写·执行面（cluster 正则自锚 ^-(?!-)，长选项不误中）
    const subDeny = GIT_SUB_WRITE_ARGS.get(sub);
    if (subDeny) {
      for (const t of tokens.slice(i + 1)) {
        const a = bare(t);
        if (subDeny.tokens?.has(a) || subDeny.prefixes?.some((re) => re.test(a)) || subDeny.cluster?.test(a)) return false;
        if (isLongAbbrev(a, subDeny.long)) return false;
      }
    }
    if (sub !== 'branch') return true;
    // branch 只收列举形态：位置参数（分支名）与写旗标（-d/-D/-m/-f/--set-upstream-to…）一律拒
    for (const t of tokens.slice(i + 1)) {
      const a = bare(t);
      if (a.startsWith('-')) {
        if (GIT_BRANCH_LIST_FLAGS.has(a) || a.startsWith('--format=') || a.startsWith('--sort=')) continue;
        return false;
      }
      return false;
    }
    return true;
  }
  if (!READONLY_COMMANDS.has(first)) return false;
  // 普通命令负面参数表（内部任务-ROCMD-1 泛化：原 find 特判迁此，date/sort/file 同款收口；
  // cluster 正则自锚 ^-(?!-)，长选项不误中，无需外层旗标守卫）
  const deny = COMMAND_WRITE_ARGS.get(first);
  if (deny) {
    for (const t of tokens.slice(1)) {
      const a = bare(t);
      if (deny.tokens?.has(a) || deny.prefixes?.some((re) => re.test(a)) || deny.cluster?.test(a)) return false;
      if (isLongAbbrev(a, deny.long)) return false;
    }
  }
  return true;
}

/**
 * 纯 cd 导航命令判定（2026-10-28 内部任务-247，多仓 cwd 漂移逃生通道）：无租约 Bash 的第三
 * 放行面——`cd <绝对路径>` 单参数形态。纯 cd 只改 shell 进程 cwd，无文件/执行面；作用＝
 * 会话持久 cwd 滞留嵌套仓时（Bash 执法键随 cwd 漂移、声明键在主仓）经白名单 cd 逃回目标
 * 仓根，消除「cd 被拦 → 无法回主仓 → 只能声明途经仓」的鸡生蛋（robot-integration-platform-
 * backend 内部任务-16 实录；验证续篇 内部计划）。
 * 词法经 lexReadOnlyCommand 引号状态机（引号外 $/{}/元字符/分隔符、双引号内 $/反引号、
 * 未配对引号一律拒）；目标限绝对路径起笔（POSIX `/` 或 Windows 盘符）——相对路径、~、-、
 * 旗标、多参数、复合形态全拒（fail-closed）。注：状态机把引号外与双引号内的反斜杠按转义
 * 归一（`C:\repo` 归一为 `C:repo`），裸/双引号反斜杠形态自然落拒——Windows 反斜杠路径须
 * 单引号字面量（与 CD_TWO_SEGMENT 直接正则不同款，口径=绝对路径起笔同判据、词法面更严）。
 * @param {string} cmd 负载命令
 * @returns {boolean} 可放行（纯 cd 导航）为真
 */
export function isPureCdCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  const lex = lexReadOnlyCommand(cmd);
  if (lex === null) return false;
  const { tokens, unquoted } = lex;
  if (SHELL_SEP_RE.test(unquoted) || SHELL_META_RE.test(unquoted)) return false;
  if (tokens.length !== 2 || tokens[0] !== 'cd') return false; // 只认 cd <目标> 两 token
  return /^(\/|[A-Za-z]:[\\/])/.test(tokens[1]); // 绝对路径起笔（裸 / 与盘符形态均收）
}
