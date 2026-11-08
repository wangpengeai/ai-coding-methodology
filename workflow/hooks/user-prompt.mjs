// 文件：user-prompt.mjs
// 描述：workflow 插件 UserPromptSubmit 节流提醒 + 护栏失效哨兵（套件级）+ 自察钩子
//       （内部规则-7 / 内部规则-7 / 内部模块-15-内部决策-019 / 内部接口-1）。职责：
//       A. 路由提醒：在任务到来/场景切换时点注入一行指针级提醒（先查路由表并
//          显式声明命中行），不重灌路由表全文（SessionStart 已注入全文）。
//          节流策略（可验证、确定性）：
//            1) 会话首条用户消息跳过——SessionStart 刚注入元技能全文，无需重复；
//            2) 同一会话冷却期（默认 30 分钟）内至多注入一次；
//            3) 消息已含「路由表」视为用户已自行声明，跳过并刷新节流起点。
//       B. 失效哨兵（2026-09-13 内部模块-15 升级为套件级；同日加固批次修订）：fail-open 把
//          hook 失败静默吞掉（B-M8-1 刻意姿态），宿主只在日志记 hook.run.failed——
//          本钩子增量扫描宿主日志，发现本会话【四插件任一】hook 执行失败记录时：
//          会话内首次注入一行告警（含次数与日志指引）；新增失败即按插件归因落
//          hook-failure 记录，id 带小时桶（同小时读侧幂等，跨小时复发累计可看热度）。
//          排除面仅限 workflow 自家的纯记录钩（PostToolUseFailure/PostToolUse——
//          用户按停连带杀钩属常态）；他插件在同事件上的保护钩失败照常计入。
//          另一排除面：与同会话 v4.stop 事件时间相邻（默认 2s 窗，可经
//          WF_GUARD_STOP_WINDOW_MS 覆盖）的 hook.run.failed 视为宿主按停预期噪音，
//          不告警不落 incident（hf-84c89b764 评估结论）；失败行缺 timestamp 时
//          无法判窗，照常计入（fail-visible）。
//          环境全坏时哨兵与护栏同死，环境恢复后首条健康消息即回溯告警。
//          告警优先于提醒节流（含首条消息），与到期提醒合帧输出。
//       C. 自察（内部模块-15/内部决策-019）：用户纠正信号捕获（保守模式清单 + **三层口径**：
//          ①信封豁免（对等消息 `Agent <id> sent a message` / 子代理完成通知 `Background subagent … finished` /
//          租约横幅【workflow 任务租约】/ 自察指针【workflow 自察】——都不是用户输入）
//          ②引文与代码段剥离（围栏/行内代码/`「」`/`“”`/`‘’`/ASCII 引号）
//          ③语境门（剥离后 ≤60 字符，或命中处 ±12 字符内有第二人称·祈使·疑问标记：
//          `你|您|请|别|不要|为什么|怎么`）——2026-09-29 内部任务-OPEN4344-1/内部未决-44①：插件领域词表
//          出现在简报/报告引文里会被旧口径误记为纠正，三例实证）；每会话同模式一次，
//          WF_UPROMPT_CORRECTION=off 关闭）落 user-correction 记录；项目存在 open
//          自察异常期间每条消息注入一行待排查指针（持续显示计数直到归零——
//          2026-09-13 C2 修订，原「会话内一次性」会让用户错过复发信号）。
//       状态文件按 session_id 隔离存于 runtimeStateDir（A4：跨重启存活）；写状态失败
//       时放弃本次注入（静默偏向不打扰，fail-open 的另一半：宁可漏提醒不可刷屏）。
//       2026-09-15（闸/文案批，内部未决-13）：租约行/提醒行的声明命令统一「双引号包裹
//       正斜杠绝对路径」形态（declareCmdPrefix 单一构造，Git Bash 可直接复制执行）。
//       2026-10-12（内部未决-94，内部任务-50）：形态订正为「单引号包裹」——bash/pwsh 双壳内零
//       展开，构造点仍在 declareCmdPrefix 单一构造。
//       2026-10-08 内部任务-20 A1：注入面增**委派轴**（委派会话只留租约行 + 哨兵告警，判据经
//       `hook-lib.isDelegatedSession`）+ 注入命令改**插件根绝对路径**（`incidentCliCommand`）
//       + 签发探针增 `delegated` 字段（收窄可观测）。
//       内部任务-342（2026-11-06）：hook-failure 归因改 own-only（leaseContextOfOwn）——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// fail-open：任何失败（负载垃圾、临时目录不可写、日志缺失/损坏、JSON 序列化失败）
//       静默退出 0，不阻断宿主（内部规则-10 同款姿态；project-conventions 硬规则 4）。
// 注入缝：WF_UPROMPT_STATE_DIR（状态目录，测试隔离用）、
//       WF_UPROMPT_COOLDOWN_MS（冷却期毫秒，测试覆盖用）、
//       WF_GUARD_LOG_PATH（宿主日志路径，测试与诊断用）、
//       WF_GUARD_HOUR（哨兵小时桶覆盖，测试隔离用）、
//       WF_UPROMPT_CORRECTION（=off 关闭纠正捕获）、
//       WF_INCIDENT_ROOT（自察记录根覆盖，incident-store 注入缝）。
// 用法：宿主经 hooks.json 以 process 方式调用（stdin=宿主 JSON 负载）；
//       手动运行：echo '{"session_id":"s","prompt":"..."}' | node user-prompt.mjs
//       自检：node user-prompt.mjs --selftest（B-M8-4）。
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
// createHash 消费已随 stateFile 迁移 hook-lib（2026-09-19 评审修复批，PHASE1 重审 B）删除本文件 import
import { pathToFileURL } from 'node:url';
import { projectKey, runtimeStateDir, stateDir, activationRoot, canonicalRoot } from './routing-lib.mjs';
import { declareCmdPrefix, incidentCliCommand, installHookErrorTrap, isDelegatedSession, noteHookIssue, readStdin, sessionStateFile, openCandidateLine, runHookMain } from './hook-lib.mjs';
// 2026-10-09 内部任务-24 D3：签发键集单源（issuanceKeys/cwdUnionKeys）迁 task-lease-lib.mjs
//（gate 逐键清单侧与签发侧严格同源），本文件改为 import 消费；行为零变更。
import { hostOf, issueChallenge, leaseContextOfOwn, markRequestGranted, readActiveLease, readDomainRequests, resolveInheritedTaskId, verifyChallengeOnDisk, issuanceKeys, soleTaskIdSuggestion, visibilityHints, DOMAINS_SETUP_HINT } from './task-lease-lib.mjs';
import { appendIncident, digestOf, normalizeSession, sessionMatches } from '../scripts/lib/incident-store.mjs';
import { buildSummary, countPromotions, formatPointerLine, formatPromotionLine } from '../scripts/lib/incident-summary.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';
import { scanOpenItems, scanOpenItemsCached } from '../scripts/lib/open-items-scan.mjs';

/** 提醒首行：指针级，指向路由表纪律（任务到来/场景切换共用，P-3 并入本文） */
const REMINDER =
  '【workflow 路由提醒】任务到来/场景切换：先查 workflow 元技能的路由表并显式声明命中行，再进入入口 skill 执行。';

/**
 * 评审/勘察类 skill 集合（漂移提示触发面，内部任务-DRIFTNUDGE-1）。
 * 首版文件内常量：仅本文件消费；出现第二个消费方再上移 routing-skills 共享资产。
 */
const REVIEW_SURVEY_SKILLS = new Set(['code-review', 'plan-review', 'idea-review']);

/**
 * 句首命令式修复/实现意图词表（2026-09-23 经 100 条真实用户消息语料校准）。
 * 只认句首锚点：评审报告中讨论修复、过程陈述（如「改动是必要的修复」）不命中。
 * 修订须先对真实语料回归，不得凭记忆增删。
 */
const IMPLEMENT_INTENT_PATTERNS = [
  /^定位[並并]?修复/,
  /^修复(?!批走)/, // 「修复批走 plan-writing…」已点名正确流程链，豁免
  /^处理\s*(?:specs\/open-items|OPEN-|[^\s，,：:]{1,40}?(?:存在)?的?问题)/,
  /^根据[\s\S]{0,80}?代码归正/,
  /^基于[\s\S]{0,80}?在项目中实现/,
  /^需要为[\s\S]{0,40}?补齐/,
  /^需要补全设计并实现/,
  /^拉取[\s\S]{0,40}?镜像/,
  /^进行\s*[A-Za-z0-9]+\s*集成/,
  /^流水线构建失败/,
  /^使用过程中发现问题/,
  /^我注意到插件工作异常/,
];

/**
 * 场景漂移判定（纯函数）：上一声明为评审/勘察类、本轮句首为修复/实现命令式时命中。
 * @param {string|null} declaredSkill 上一轮成功声明的 skill（无则 null）
 * @param {string} prompt 本轮用户消息
 * @returns {boolean}
 */
function isRoutingDrift(declaredSkill, prompt) {
  if (!declaredSkill || !REVIEW_SURVEY_SKILLS.has(declaredSkill)) return false;
  const head = prompt.replace(/^\s+/, '');
  return IMPLEMENT_INTENT_PATTERNS.some((re) => re.test(head));
}

/**
 * 漂移归因专用的上一声明读取：readActiveLease 命中后校验会话侧与观察侧同口径——
 * observer 有 id 只认同会话 lease；observer 为 null 只认 null 桶 lease（扫描回退
 * 救回的他会话可见 lease 一律不接受，防跨会话张冠李戴）。
 * @param {string} key 项目键
 * @param {string|null} sessionId 观察侧会话标识
 * @returns {object|null} 同口径有效 lease；无则 null（由调用方走持久化兜底）
 */
function readSameSessionLease(key, sessionId) {
  const r = readActiveLease(key, Date.now(), { sessionId });
  if (!r.valid || !r.lease) return null;
  const leaseSess = typeof r.lease.sessionId === 'string' && r.lease.sessionId ? r.lease.sessionId : null;
  return leaseSess === sessionId ? r.lease : null;
}

/**
 * 漂移提醒正文（非阻断条件句：点名当前 skill 与正确路由，不做断言式拦截）。
 * @param {string} skill 当前声明 skill
 * @returns {string}
 */
function driftText(skill) {
  return `【workflow 场景漂移提醒】当前声明为 ${skill}（评审/勘察类），本轮消息含修复/实现意图——若确要动手，先回 workflow 元技能路由表重判（修复=root-cause-debugging，实现=计划链），持本租约直接改道即违规。`;
}

/** 周期提示正文：一行指针，「workflow 定期提醒」的机械实化（内部规则-3/T-M6-2） */
function nudgeText(count) {
  return `【workflow 周期提示】本会话已 ${count} 轮：可触发 learnings/retro 收口（无收获可显式跳过，跳过要出口）。`;
}

/**
 * 提醒正文（首行 + 声明命令行）：声明命令在运行期用真实插件根拼出——代理拿到
 * 即可复制执行，与任务租约闸（内部规则-8）的 deny 文案同源同形。声明命令前缀已收敛至
 * hook-lib 的 declareCmdPrefix 单一构造（内部未决-91，内部任务-48）——自身位置优先 + 存在性
 * 校验 + 占位符回落，与 incidentCliCommand 同根同形。
 * @returns {string}
 */
function reminderText() {
  const cmd = declareCmdPrefix();
  return `${REMINDER}\n机械声明（本项目首个写操作前必过，R-M8-8）：${cmd} <命中skill名> --lease <本轮leaseId> --task-id <任务号>`;
}

/**
 * 签发本轮租约行（每键一行）并落签发探针。
 * 内部任务-8 任务 5.2/5.4（内部规则-19 ⑥）：
 *  ① **签发自校验**——`issueChallenge` 返回后回读挑战文件（`verifyChallengeOnDisk`），不通过则
 *     该键**不 push 令牌行**，改 push 降级指引（「本轮签发未落盘…」）；单键失败跳过与全失败
 *     返回 null 的既有语义保持（杜绝「照指引必败」）。
 *  ② **签发探针** `stateDir()/wf-prompt-probe.jsonl`（追加写、非 atomicWrite——审计日志语义
 *     同 hook-errors.jsonl；读侧幂等、文件可手删）：一行一 JSON，字段 ts/sessionId/keysIssued/
 *     verifyOk，供 RC-4「注入即可激活」判定实验取证。
 *  边界注记：自校验防不住「历史令牌被 goal/续跑通道复读」（旧轮真实签发过、已被轮换删除）
 *  ——复读防御＝精确拒因（LEASE_REASONS 单一来源）＋本探针取证。
 * 内部决策-061 D4（内部任务-227）：委派会话（delegated=true）优先解析父链交付任务号并内联继承号；
 * 解析失败不出任何具体号，只给「停止写操作→回报父会话→父会话先声明后重派」指引；
 * 非委派 degraded 时回退 `<任务号>` 占位并追加【取号暂不可得】说明行（D5 fail-loud）。
 * @param {string} cwd 会话 cwd
 * @param {string|null} sessionId 会话标识
 * @param {boolean} [delegated] 委派会话语义（delegation_depth>0）
 * @param {{depth: number, parentSessionId: string|null}|null} [delegation] 委派深度与父会话 id
 * @returns {string|null} 注入行（无任何可注入行时 null）
 */
function leaseLine(cwd, sessionId, delegated = false, delegation = null) {
  try {
    const keys = issuanceKeys(cwd);
    // 内部任务-20 A2/F6（内部决策-018 修正案）：把**本会话在册且未过期**的跨域请求目标键并入签发键集
    // ——两步通道的第二跳。TTL 与会话/host 过滤都在登记面读侧（readDomainRequests）内；
    // 委派轴不影响本并入（子代理同样需要目标域令牌——A1 的收窄面只涉自察/提醒类注入）。
    // 并入只增不减 ⇒「签发键集 ⊇ 闸可达键集」不变量保持；签发成功后授予落审计行。
    const ownerKey = projectKey(cwd);
    const domainReqs = sessionId
      ? readDomainRequests(ownerKey, { sessionId, host: hostOf({}) }).filter((r) => !r.granted && !keys.includes(r.targetKey))
      : [];
    const domainById = new Map(domainReqs.map((r) => [r.targetKey, r.id]));
    const allKeys = [...keys, ...domainReqs.map((r) => r.targetKey)];
    const cmd = declareCmdPrefix();
    const multi = allKeys.length > 1;
    const lines = [];
    let keysIssued = 0;
    let verifyOk = true;
    for (const key of allKeys) {
      try {
        // 内部决策-061 D4（内部任务-227）：委派会话优先解析父链交付任务号（issued 台账 append-only 为主，
        // 上溯 ≤3 层）；解析成功把继承号写入挑战（v5）并在租约行内联；失败不出号＋停报重派指引。
        const depth = Number.isSafeInteger(delegation?.depth) && delegation.depth > 0 ? delegation.depth : 0;
        const parentSessionId = typeof delegation?.parentSessionId === 'string' && delegation.parentSessionId ? delegation.parentSessionId : null;
        let inheritTaskId = null;
        let inheritFailure = '';
        if (delegated) {
          if (depth > 0 && parentSessionId) {
            const resolved = resolveInheritedTaskId(key, parentSessionId, depth);
            if (resolved.ok) inheritTaskId = resolved.taskId;
            else inheritFailure = resolved.reason ?? '父链不可解析';
          } else {
            inheritFailure = depth > 0 ? '父会话标识不可见（parent_session_id 缺席）' : '委派深度不可见（缺 delegation_depth）';
          }
        }
        // 内部任务-244 E04 注入缝：模拟单键签发异常（生产零行为）
        if (process.env.WF_UPROMPT_FORCE_ISSUE_THROW === '1') {
          const e = new Error('forced issue failure');
          e.code = 'EFORCED';
          throw e;
        }
        const ch = issueChallenge(key, {
          sessionId: sessionId ?? null,
          ...(depth > 0 ? { delegationDepth: depth } : {}),
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(inheritTaskId ? { inheritTaskId } : {}),
        });
        // 注入缝（先例：GUARD_HOOK_INJECT_CRASH）：模拟「写后立读不可见」的罕见态
        // （AV 锁/NFS 延迟/磁盘满——RC-4 必败注入的成因族），供端到端测试降级路径
        if (process.env.WF_UPROMPT_INJECT_DROP_CHALLENGE === '1') {
          rmSync(join(stateDir(), `wf-lease-challenge-${ch.leaseId}.json`), { force: true });
        }
        const verified = verifyChallengeOnDisk(ch.leaseId, Date.now(), key);
        if (!verified.ok) {
          verifyOk = false;
          lines.push(DEGRADED_LEASE_TEXT(verified.reason));
          continue; // 不注入注定不可激活的令牌行
        }
        keysIssued += 1;
        // 跨域请求授予留痕（第二步完成：目标域令牌已注入 ⇒ 请求即消费）
        if (domainById.has(key)) markRequestGranted(ownerKey, domainById.get(key), Date.now());
        const label = multi ? `仓 ${basename(key).slice(0, 24)}｜` : '';
        // FB-1（2026-09-18 反馈批次）：多仓行命令附 --project-root「仓根」——该行令牌
        // 已绑定所属仓根，任意目录可直接复制执行（解 cwd 耦合；仓根归一正斜杠；内部未决-94
        // 〔内部任务-50〕起实参为单引号包裹——bash/pwsh 双壳零展开）；单仓行维持历史形态逐字节不变。
        // 内部任务-247（2026-10-28）：多仓 tail 增 Bash 键控提示——「任意目录可声明」只解声明侧，
        // Bash 执法键仍随会话持久 cwd 漂移（内部任务-16 实录）；纯 cd 逃生通道同批落地（isPureCdCommand）。
        const projectRootArg = multi ? ` --project-root '${key.replaceAll('\\', '/')}'` : '';
        const tail = multi ? '（已绑定仓根，任意目录可声明；Bash 按 cwd 所在仓执法，cwd 漂移时纯 cd 回仓根）' : '（声明后本会话放行）';
        if (delegated) {
          // 内部决策-061 D4：委派会话租约行——继承成功内联父链交付号；失败不内联任何具体号。
          if (inheritTaskId) {
            lines.push(
              `【workflow 任务租约】${label}本轮令牌 ${ch.leaseId}｜首个写操作前完成声明：` +
              `${cmd} <命中skill名> --lease ${ch.leaseId} --task-id ${inheritTaskId}（继承父链交付任务号，禁止自取新号）${projectRootArg}${tail}`,
            );
          } else {
            lines.push(
              `【workflow 任务租约】${label}本轮令牌 ${ch.leaseId}｜子代理会话不可解析继承任务号（${inheritFailure}）——停止写操作，回报父会话：由父会话先声明交付任务号后重新派发（禁止同轮重试）。`,
            );
          }
          continue;
        }
        // 内部任务-27 批二坑4：恰一条域建议时内联可照抄号（soleTaskIdSuggestion 与 deny 文案
        // 单源）；多域/异常保持 <任务号> 占位符（零域态经默认域兜底恰单建议即内联——
        // 内部任务-75，旧「零域保持占位符」形态废止）。
        // 内部未决-103（内部任务-52）：传观察会话标识——续任务每轮建议号不被自身未过期占用顶成
        // n+1，照抄即延续同号；会话不可判（undefined/null）回落机器级口径。
        // 内部决策-061 D5（内部任务-227）：degraded 时禁止内联任何具体号 + 追加「取号暂不可得」说明行。
        const meta = {};
        const sole = soleTaskIdSuggestion(key, { excludeSessionId: sessionId, meta }) ?? '<任务号>';
        lines.push(
          `【workflow 任务租约】${label}本轮令牌 ${ch.leaseId}｜首个写操作前完成声明：` +
          `${cmd} <命中skill名> --lease ${ch.leaseId} --task-id ${sole}${projectRootArg}${tail}`,
        );
        if (Array.isArray(meta.degraded) && meta.degraded.length > 0) {
          lines.push(
            `【取号暂不可得】（占用源降级：${meta.degraded.map((d) => d.source).join('/')}）——本轮不内联具体号；请排查来源或稍后重试（ADR-061 D5）；查询：${cmd} --suggest-task-id`,
          );
        }
      } catch (e) {
        // 内部任务-244 E04：单键签发异常不得静默——注入降级行（异常类别，禁原文/路径）并结构化
        // 留痕；其余键继续（单键失败跳过语义不变），全部失败才返回 null。
        lines.push(DEGRADED_LEASE_TEXT(`issue 异常：${e?.code ?? e?.name ?? 'unknown'}`));
        noteHookIssue('user-prompt', 'issue-challenge-failed');
      }
    }
    writePromptProbe({ sessionId, keysIssued, verifyOk, delegated });
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

/**
 * RC-4 取证件：签发探针（追加写；写失败静默——审计日志语义，不阻断注入）。
 * 2026-10-08 内部任务-20 A1：增 `delegated` 字段——注入面收窄是否在生效要有**非注入**的运行时
 * 可见面（否则交付后无法回答"子代理会话为什么没有提示"，CEO 可观测性项）。
 * @param {{sessionId?: string|null, keysIssued: number, verifyOk: boolean, delegated?: boolean}} rec 本轮签发事实
 */
function writePromptProbe({ sessionId, keysIssued, verifyOk, delegated = false }) {
  try {
    const file = join(stateDir(), 'wf-prompt-probe.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), sessionId: sessionId ?? null, keysIssued, verifyOk, delegated })}\n`);
  } catch {
    /* 探针写失败静默（与预警状态持久化同款姿态：漏提醒不刷屏） */
  }
}

/**
 * 降级指引行（内部任务-8 任务 5.2，内部规则-19 ⑥）：签发自校验失败时**替代令牌行**注入——
 * 明确说明未落盘、给出重试动作与排查项（杜绝「照指引必败」）。抽常量供 selftest 锚字面量。
 * @param {string} reason 失败原因（missing/expired/mismatch）
 * @returns {string} 注入行
 */
const DEGRADED_LEASE_TEXT = (reason) =>
  `【workflow 任务租约】本轮签发未落盘（回读验证失败：${reason}）——请再发一条消息获取新令牌；持续失败请排查 WF_ROUTING_STATE_DIR 写权限`;

// W3 环境锚观测注记（w3-anchor-probe，2026-09-16 临时观测件）已随 2026-09-19 评审修复
// 批收口移除——观测结论已消费（锚可见性漂移实证，P9 无锚回退已兜底，内部决策-025 ③），
// 历史见 learnings 2026-09-16「W3 观测」条。
/** 冷却期缺省值：30 分钟（同一会话内至多提醒一次） */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
/** 周期提示缺省值：每 20 轮用户消息提示一次 learnings/retro 收口（内部规则-7/内部规则-3） */
const DEFAULT_NUDGE_EVERY = 20;
/** 用户消息中视为"已自行声明路由"的锚点 */
const DECLARED_ANCHOR = '路由表';
/** 哨兵看整套件（内部模块-15 套件级）：source 前缀清单是脚本资产（B-M8-3 同款，不进 skill 正文） */
const SUITE_SOURCE_PREFIXES = [
  'plugin.workflow@',
  'plugin.spec-gate@',
  'plugin.scout@',
  'plugin.team-governance@',
  'plugin.algo-loop@',
];
/** 从 source 解析插件名（hook-failure 归因用）：plugin.<name>@<marketplace>.<Event>.<i>.<j> */
const SOURCE_PLUGIN_RE = /^plugin\.([a-z0-9-]+)@/;
/**
 * 自家纯记录钩事件段（哨兵排除面，2026-09-13 评审 C1 窄化）：post-tool.mjs 双注册的
 * PostToolUseFailure/PostToolUse 是纯记录职责，失败不构成护栏失效（没有任何保护被
 * fail-open）；且用户按停会连带杀掉在飞 hook 进程（2026-09-13 评估：5 次失败全部与
 * v4.stop 毫秒级相邻、时长 2-16ms 远低于 node 启动耗时）——计入只会对正常按停制造
 * 「保护可能未生效」误报。**仅限 workflow 自家**：他插件（如 spec-gate 的
 * post-tool-use.mjs）在 PostToolUse 上注册的是阻断性保护钩，失败必须照常计入告警。
 */
const RECORDER_EVENT_RE = /\.(PostToolUseFailure|PostToolUse)\./;
/**
 * 按停噪音窗宽（毫秒）：与同会话 v4.stop 事件时间相邻的 hook.run.failed 视为宿主
 * 按停杀掉在飞 hook 进程的预期噪音（hf-84c89b764：失败与 stop 事件毫秒级相邻、
 * 时长 2-16ms）——不告警不落 incident；WF_GUARD_STOP_WINDOW_MS 可覆盖（测试缝）。
 */
const STOP_WINDOW_MS = Number(process.env.WF_GUARD_STOP_WINDOW_MS) || 2000;
/** 宿主日志单次扫描上限（内部任务-244 P04）：首次/偏移越界时只读尾部 8MB，并置 truncated 可见化。 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** 用户纠正信号的保守模式清单（脚本资产；命中即记一条 user-correction 自察异常） */
const CORRECTION_PATTERNS = [/不对/, /错了/, /重来/, /不是这样/, /你搞错/, /我不是这个意思/];
/** 纠正捕获的信封与引文/语境口径（内部未决-44①，2026-09-29 内部任务-OPEN4344-1）。 */
const CORRECTION_ENVELOPE_RE = /^(Agent |Background subagent )|【workflow 任务租约】|【workflow 自察】/;
const CORRECTION_SIGNAL_NEAR_RE = /[你您请]|为什么|怎么|别|不要/;
const CORRECTION_SHORT_MAX = 60;
const CORRECTION_NEAR_WINDOW = 12;
/** 哨兵告警前缀（测试与文档共同锚点） */
const ALERT_PREFIX = '【workflow 护栏异常】';

/**
 * 会话键 → 状态文件路径：迁移至 hook-lib.sessionStateFile（2026-09-19 评审修复批，
 * 消除逐字拷贝）；前缀 wf-uprompt 维持既有落盘文件名形态（摘要消毒语义不变）。
 * @param {string} stateDir 状态目录
 * @param {string} key 会话键
 * @returns {string} 状态文件绝对路径
 */
function stateFile(stateDir, key) {
  return sessionStateFile('wf-uprompt', key, stateDir);
}

/**
 * 扫描状态条目规范化：旧 number 形态（纯字节 offset，按停窗窄化前遗留）宽容包成
 * 对象——lastStopTs 无从考证归 null（fail-visible：不因升级吞掉排除判据）。
 * @param {number | { offset?: number, lastStopTs?: number } | undefined | null} v
 * @returns {{ offset: number, lastStopTs: number | null }}
 */
function normalizeScanEntry(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { offset: v, lastStopTs: null };
  if (v && typeof v === 'object' && Number.isFinite(v.offset)) {
    return { offset: v.offset, lastStopTs: Number.isFinite(v.lastStopTs) ? v.lastStopTs : null };
  }
  return { offset: 0, lastStopTs: null };
}

/**
 * 日志行 timestamp 解析：宿主写 ISO 字符串（fixture 对齐形态），防御性兼容数字毫秒。
 * @param {unknown} v 日志行的 timestamp 字段值
 * @returns {number | null} 可解析返回 epoch 毫秒；否则 null（判窗依据缺失）
 */
function parseLogTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * 读状态；缺失/损坏一律视为"无状态"（首条消息语义），不抛错。
 * 字段逐个容错还原——丢 alerted/failSeen/scan/corrected 任一字段
 * 都会让对应机制按"未发生"重走一遍（哨兵重扫重报/纠正重记），不致错乱。
 * @param {string} file 状态文件路径
 * @returns {{ count: number, last: number, failSeen: number, alerted: boolean, scan: Record<string, { offset: number, lastStopTs: number | null }>, corrected: string[], declaredSkill: string | null, declaredEpoch: number | null, driftShown: boolean }}
 */
function loadState(file) {
  const empty = { count: 0, last: 0, failSeen: 0, alerted: false, scan: {}, corrected: [], declaredSkill: null, declaredEpoch: null, driftShown: false, openScanShown: false };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return {
      count: Number.isFinite(s.count) ? s.count : 0,
      last: Number.isFinite(s.last) ? s.last : 0,
      failSeen: Number.isFinite(s.failSeen) ? s.failSeen : 0,
      alerted: Boolean(s.alerted),
      scan:
        s.scan && typeof s.scan === 'object' && s.scan !== null
          ? Object.fromEntries(Object.entries(s.scan).map(([f, v]) => [f, normalizeScanEntry(v)]))
          : {},
      corrected: Array.isArray(s.corrected) ? s.corrected.map(String) : [],
      declaredSkill: typeof s.declaredSkill === 'string' ? s.declaredSkill : null,
      declaredEpoch: Number.isFinite(s.declaredEpoch) ? s.declaredEpoch : null,
      driftShown: Boolean(s.driftShown),
      openScanShown: Boolean(s.openScanShown),
    };
  } catch {
    return empty;
  }
}

/**
 * 决策：本条消息是否注入提醒，以及新的状态值。纯函数，便于 --selftest 直测。
 * @param {{ prompt: string }} payload 宿主负载（已容错提取）
 * @param {{ count: number, last: number }} state 旧状态
 * @param {number} now 当前 epoch 毫秒
 * @param {number} cooldownMs 冷却期毫秒
 * @returns {{ emit: boolean, state: { count: number, last: number } }}
 */
function decide(payload, state, now, cooldownMs) {
  const declared = payload.prompt.includes(DECLARED_ANCHOR);
  // 首条消息：SessionStart 已注入全文，跳过；同时把节流时钟拨到会话起点
  if (state.count === 0) {
    return { emit: false, state: { count: 1, last: now } };
  }
  // 已自行声明：视为路由行为发生，刷新节流起点，不再提醒
  if (declared) {
    return { emit: false, state: { count: state.count + 1, last: now } };
  }
  // 冷却期外：注入并刷新节流；冷却期内：静默（仍计数，便于观测）
  if (now - state.last >= cooldownMs) {
    return { emit: true, state: { count: state.count + 1, last: now } };
  }
  return { emit: false, state: { count: state.count + 1, last: state.last } };
}

/**
 * 宿主日志候选路径（哨兵数据源）。宿主按天写 ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl，
 * 日期按本地还是 UTC 切分不可知，两个候选都给；WF_GUARD_LOG_PATH 覆盖（测试/诊断缝）。
 * 为什么敢读宿主日志：只读、自引用（只统计自家插件 source 的失败记录），路径缺失
 * 或格式漂移都走 fail-open 静默——告警能力降级为无，不影响其余职责。
 * @returns {string[]} 候选日志文件路径（去重）
 */
function logCandidates() {
  const override = process.env.WF_GUARD_LOG_PATH;
  if (override) return [override];
  // 内部任务-290/内部任务-308（内部未决-259）：只有 ZCode 有 `~/.zcode/cli/log` 派发日志面；dsh/kimi/mcode
  // 扫该目录会把别家宿主的失败算到自己头上 ⇒ 直接返回空（行为上＝本宿主无日志面）。
  if (hostOf({}) !== 'zcode') return [];
  const dir = join(homedir(), '.zcode', 'cli', 'log');
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const utc = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return [...new Set([fmt(now), fmt(utc)])].map((day) => join(dir, `zcode-${day}.jsonl`));
}

/**
 * 增量扫描一个日志文件：从 prev.offset 起读新增内容，两趟处理——第一趟收集
 * 同会话 v4.stop.* 行的全部时刻（含继承 prev.lastStopTs），第二趟统计"本会话 +
 * 套件任一插件"的 hook.run.failed，排除与段内任一 stop 时刻相邻（≤STOP_WINDOW_MS，
 * 宿主按停杀在飞 hook 的预期噪音）者——R4 回归（2026-09-14 终审）：同段两次按停
 * （ts1<ts2）时贴近 ts1 的失败行不得因距 ts2 超窗被误计，故判窗取「全部 stop
 * 时刻的最近距离」而非单值；失败行 timestamp 缺失或不可解析时不排除（fail-visible）。
 * 持久化只存 max（lastStopTs）：跨段继承以段内最新 stop 为界即可——段边界是
 * UserPromptSubmit，跨段的失败与旧 stop 相邻性已弱（隔了整轮用户交互），按 max
 * 收窄判窗是可接受口径。返回新 offset（对齐最后一个完整行，半行留给下次）与
 * 最新 lastStopTs。
 * 容错：文件缺失/读失败 → 0 新增、状态原样返回；文件变短（轮转重写）→ 从头重扫；
 * 坏行跳过。三段预过滤（事件名/会话 id/插件前缀的子串包含）在 JSON.parse 之前，
 * 大日志下只对极少数行付出解析成本。
 * @param {string} file 日志文件路径
 * @param {{ offset: number, lastStopTs: number | null }} prev 上次扫描状态
 * @param {string} sessionId 本会话 id
 * @returns {{ count: number, offset: number, sources: string[], lastStopTs: number | null }}
 */
function scanFailures(file, prev, sessionId) {
  const { offset, lastStopTs: prevStopTs } = normalizeScanEntry(prev);
  const unchanged = { count: 0, offset, sources: [], lastStopTs: prevStopTs, truncated: false };
  let lastStopTs = prevStopTs;
  /** 段内全部 stop 时刻（含继承 prev）：判窗基准集，任一相邻即排除 */
  const stopTsList = prevStopTs !== null ? [prevStopTs] : [];
  try {
    const st = statSync(file);
    if (!st.isFile()) return unchanged;
    const size = st.size;
    if (size === offset) return unchanged;
    let start = size < offset ? 0 : offset; // 截断/轮转：偏移越界则从头重扫
    // 内部任务-244 P04：单次读盘上限——超限只读尾部并置 truncated（调用方留痕/告警，不静默半扫）。
    let truncated = false;
    if (size - start > MAX_SCAN_BYTES) {
      start = size - MAX_SCAN_BYTES;
      truncated = true;
    }
    const fd = openSync(file, 'r');
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      // 阶段门正确性评审 #8：偏移单位统一为**字节**（原实现 start 为字节、headOffset/lastNl 为
      // UTF-16 下标；中文日志下 offset 会偏小 → 下次重读已计行、失败重复计数）。
      let headByte = 0;
      if (truncated) {
        const nl = buf.subarray(0, read).indexOf(0x0a);
        if (nl === -1) return { count: 0, offset: start + read, sources: [], lastStopTs, truncated };
        headByte = nl + 1;
      }
      const bodyBuf = buf.subarray(headByte, read);
      const lastNlByte = bodyBuf.lastIndexOf(0x0a);
      if (lastNlByte === -1) return { ...unchanged, offset: start + headByte, truncated }; // 尚无完整行，等下次
      const lines = bodyBuf.toString('utf8', 0, lastNlByte).split('\n');
      // 第一趟：同会话 v4.stop.* 行收集全部按停时刻（判噪基准集，含继承 prev）
      for (const line of lines) {
        if (!line.includes('v4.stop.')) continue;
        if (!line.includes(sessionId)) continue;
        try {
          const d = JSON.parse(line);
          const ts = parseLogTs(d.timestamp);
          if (String(d.event).startsWith('v4.stop.') && d.sessionId === sessionId && ts !== null) {
            stopTsList.push(ts);
            if (lastStopTs === null || ts > lastStopTs) lastStopTs = ts;
          }
        } catch {
          /* 坏行容忍：日志格式漂移不构成告警理由 */
        }
      }
      // 第二趟：失败计数（按停窗内排除——对每个失败行取与段内全部 stop 时刻的最近距离判窗）
      let count = 0;
      const sources = new Set();
      for (const line of lines) {
        if (!line.includes('hook.run.failed')) continue;
        if (!line.includes(sessionId)) continue;
        if (!SUITE_SOURCE_PREFIXES.some((p) => line.includes(p))) continue;
        try {
          const d = JSON.parse(line);
          const src = String(d.context?.source ?? '');
          const tsFail = parseLogTs(d.timestamp);
          const inStopWindow =
            tsFail !== null && stopTsList.some((t) => Math.abs(tsFail - t) <= STOP_WINDOW_MS);
          if (
            d.event === 'hook.run.failed' &&
            d.sessionId === sessionId &&
            SUITE_SOURCE_PREFIXES.some((p) => src.startsWith(p)) &&
            !(src.startsWith('plugin.workflow@') && RECORDER_EVENT_RE.test(src)) && // 排除面仅限 workflow 自家纯记录钩（评审 C1 窄化：他插件同事件保护钩照常计入）
            !inStopWindow // 按停噪音窗（hf-84c89b764）：被按停杀掉的在飞 hook 失败是预期噪音
          ) {
            count += 1;
            sources.add(src);
          }
        } catch {
          /* 坏行容忍：日志格式漂移不构成告警理由 */
        }
      }
      return { count, offset: start + headByte + lastNlByte + 1, sources: [...sources], lastStopTs, truncated };
    } finally {
      closeSync(fd);
    }
  } catch {
    return unchanged;
  }
}

/**
 * 哨兵主逻辑：扫描全部候选日志（按文件各记 {offset, lastStopTs}，天然处理跨天轮转
 * 与按停噪音窗的跨段继承），累计本会话套件插件失败数与本次新增 source 集，判定是否
 * 应在本条消息注入告警。
 * @param {{ failSeen?: number, alerted?: boolean, scan?: Record<string, number | { offset: number, lastStopTs: number | null }> }} state 旧状态
 * @param {string} sessionId 本会话 id
 * @returns {{ alertPending: boolean, newSources: string[], state: { failSeen: number, alerted: boolean, scan: Record<string, { offset: number, lastStopTs: number | null }> } }}
 */
function watchGuardFailures(state, sessionId) {
  const failSeen0 = Number.isFinite(state.failSeen) ? state.failSeen : 0;
  const scan = { ...(state.scan ?? {}) };
  let failSeen = failSeen0;
  const newSources = new Set();
  let truncated = false;
  for (const file of logCandidates()) {
    const prev = normalizeScanEntry(scan[file]);
    const r = scanFailures(file, prev, sessionId);
    failSeen += r.count;
    for (const s of r.sources) newSources.add(s);
    truncated = truncated || r.truncated === true;
    scan[file] = { offset: r.offset, lastStopTs: r.lastStopTs };
  }
  // 内部任务-244 P04：truncated 置位即结构化留痕（每会话一次；就绪面经 hook-errors 计数承接告警）。
  if (truncated && !state.scanTruncated) noteHookIssue('user-prompt', 'scan-truncated');
  const alerted0 = Boolean(state.alerted);
  const alertPending = failSeen > 0 && !alerted0;
  return {
    alertPending,
    newSources: [...newSources],
    truncated,
    state: { failSeen, alerted: alerted0 || alertPending, scan, ...(truncated || state.scanTruncated ? { scanTruncated: true } : {}) },
  };
}

/** 告警正文：一行，含累计次数与日志指引（指针级，不展开失败明细） */
function alertText(failSeen, source = 'log') {
  // 内部任务-290/内部任务-308（内部未决-259）：host×source 两格。账本来源（hook-failure 记录）落项目状态根，
  // 指引统一指向 `内部工作流状态`；日志来源——**宿主中立**（硬规则：
  // workflow 代码/文案不得出现宿主术语与宿主私有路径）：说明「派发日志面不可用」并指向项目账本，
  // 宿主专属观测目录由适配层/内部接口-1 承载。
  const hint =
    source === 'ledger'
      ? '保护可能未生效；详见本仓账本 .workflow/routing-state/hook-errors.jsonl（event=hook.run.failed）。环境恢复后建议复查关键操作。'
      : '保护可能未生效；派发日志面不可用（宿主差异见 IF-HOST-1；若本宿主提供该面，其失败计数见项目账本 hook-errors.jsonl，event=hook.run.failed）。环境恢复后建议复查关键操作。';
  return `${ALERT_PREFIX}本会话已累计 ${failSeen} 次套件插件 hook 执行失败——护栏按 fail-open 放行了相关操作，${hint}`;
}

/**
 * 自察异常落盘（内部模块-15）：新增失败即按插件归因各记一条 hook-failure；id 绑定
 * 「会话+插件+事件+小时桶」（B3 修订 2026-09-13：source 级幂等会把复发吞成一条，
 * 复发必须可见可看热度——小时桶内幂等，跨小时累计；WF_GUARD_HOUR 为测试注入缝）。
 * 任何失败静默（记录职责不得反噬告警主职责）。
 * @param {string} root 项目根（incident-store 键）
 * @param {string} sessionId 本会话 id
 * @param {string[]} sources 本次新增的失败 source 全串
 * @returns {void}
 */
function recordHookFailures(root, sessionId, sources) {
  try {
    // observer 会话透传（内部任务-LEASEGATE-1）：扫描回退下不传会归因到他会话租约
    // 内部任务-342（内部决策-066 修正案 2 内部模块-1）：归因字段只认本会话具名桶（leaseContextOfOwn）——
    // null 桶/他会话租约不参与归因，无本会话具名租约即 taskId/skill=null。
    const { taskId, skill } = leaseContextOfOwn(root, sessionId === 'default' ? null : sessionId);
    const hourBucket = process.env.WF_GUARD_HOUR ?? String(new Date().getHours());
    for (const source of sources) {
      const plugin = SOURCE_PLUGIN_RE.exec(source)?.[1] ?? null;
      const event = (source.split('.')[2] ?? null) || null; // plugin.<name>@<marketplace>.<Event>.<i>.<j>
      const digest = digestOf(['hook-failure', plugin ?? 'unknown', event ?? 'unknown']);
      // 内部模块-15 v2 写者接线（评审修复 N5）：hook-failure 记录同批带分类字段（cause＝real-failure），
      // 供 cause 派生待排查与 retro 分类面直接消费，不再依赖读侧回退猜测。
      const cls = classifyFact({ kind: 'hook-failure', plugin: plugin ?? '', event: event ?? '', host: hostOf({}) }, loadRules());
      const hfRecorded = appendIncident(root, {
        id: `hf-${digestOf(['guard', sessionId, plugin ?? 'unknown', event ?? 'unknown'])}-${hourBucket}`,
        ts: Date.now(),
        session: sessionId,
        taskId,
        skill,
        plugin,
        kind: 'hook-failure',
        // 内部任务-20 B/F9（内部决策-033 修正案 1）：记录带 host（三态，与租约侧同源 `hostOf`）——
        // 归属判等按「归一 session + host 四态」消费（内部模块-15 内部规则-2）；旧记录无该键走 legacy 路径。
        host: hostOf({}),
        tool: null,
        event,
        digest,
        cause: cls.cause,
        severity: cls.severity,
        ruleId: cls.ruleId,
        rulesVersion: cls.rulesVersion,
        observationSource: 'hook:user-prompt',
      });
      if (!hfRecorded.ok) noteHookIssue('user-prompt', 'ledger-write-failed'); // 内部任务-244 E01
    }
  } catch {
    // 内部任务-244 E01：记录失败不得静默（内部规则-7）——落结构化原因供事后自察
    noteHookIssue('user-prompt', 'ledger-write-failed');
  }
}

/**
 * 纠正匹配前的归一（纯函数，导出供单测）：剥掉引文与代码段、丢弃信封类消息。
 *
 * 为什么（内部未决-44① 三条实证）：插件自身领域词表出现在**引文/清单/表格**里会被当成用户纠正
 * （"允许推翻重来"在派发简报的 Prime Directive 清单里；"对不上"在评审报告正文里；
 * "这一步为什么不对？请解释"在派发评审实例的提示词引文里）；对等消息、子代理完成通知、
 * 租约横幅与自察指针都不是用户输入。
 * 信封判定的锚定口径：对等消息/子代理通知按**行首**锚定（`^`），两条中文横幅（租约/自察）
 * 允许**任意位置**命中——它们只会由插件自己注入，出现在正文里也属引用而非用户判断。
 * @param {string} prompt 用户消息原文
 * @returns {string} 归一后的文本；信封类消息返回空串（等同不匹配）
 */
export function normalizeForCorrection(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return '';
  if (CORRECTION_ENVELOPE_RE.test(prompt.trim())) return '';
  return prompt
    .replace(/```[\s\S]*?```/g, ' ') // 围栏代码（防御性剥离：行内规则通常已把围栏标记成对吃光）
    .replace(/`[^`]*`/g, ' ') // 行内代码（delta 实例的真实触发形态就在反引号里）
    .replace(/「[^」]*」/g, ' ') // 中文引文
    .replace(/“[^”]*”/g, ' ')
    .replace(/‘[^’]*’/g, ' ')
    .replace(/"[^"]*"/g, ' ') // ASCII 双引号引文（简报/报告最常见的引用形态）
    .replace(/'[^']*'/g, ' ') // ASCII 单引号引文
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 用户纠正信号匹配（纯函数，selftest 与单测直测）：返回命中的模式索引升序列表（**不去重**，
 * 多个模式重叠命中时全列——调用点只取 `hits[0]`）。
 *
 * 语境门（内部未决-44① 裁决）：仅当"归一后消息 ≤ 60 字符"或"命中处 ±12 字符内有第二人称/祈使/疑问
 * 标记（你|您|请|别|不要|为什么|怎么）"才算纠正——真纠正通常短促直指，长文里的清单/表格措辞不是纠正。
 * @param {string} prompt 用户消息
 * @returns {number[]}
 */
export function matchCorrections(prompt) {
  const text = normalizeForCorrection(prompt);
  if (text === '') return [];
  const hits = [];
  CORRECTION_PATTERNS.forEach((re, i) => {
    const m = re.exec(text);
    if (!m) return;
    const short = text.length <= CORRECTION_SHORT_MAX;
    const near = CORRECTION_SIGNAL_NEAR_RE.test(
      text.slice(Math.max(0, m.index - CORRECTION_NEAR_WINDOW), m.index + m[0].length + CORRECTION_NEAR_WINDOW),
    );
    if (short || near) hits.push(i);
  });
  return hits;
}

/**
 * 输出注入信封并退出。信封契约：hookSpecificOutput 嵌套 + hookEventName 与触发
 * 事件一致——宿主按事件名严格校验，缺失或不一致整帧丢弃（内部规则-6）。
 * @param {string} context 注入正文（提醒/告警可合帧）
 */
function emitContext(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }) + '\n',
  );
}

/**
 * 自检入口（B-M8-4）：对纯函数决策与状态读写跑一遍真实冒烟，全过输出 OK 退 0，
 * 任一断言失败输出 FAIL 退 1（自检是人工入口，失败必须可见，不走 fail-open）。
 * @returns {number} 退出码
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const dir = mkdtempSync(join(tmpdir(), 'wf-uprompt-selftest-'));
  const log = join(dir, 'sentinel.jsonl'); // 哨兵 fixture：finally 也要用，声明在 try 外
  const envPrev = process.env.WF_GUARD_LOG_PATH;
  try {
    const now = Date.now();
    // 决策：首条跳过 → 冷却期外注入 → 冷却期内静默 → 声明刷新节流
    let r = decide({ prompt: '帮我修 bug' }, { count: 0, last: 0 }, now, 0);
    check('首条消息不注入', !r.emit && r.state.count === 1);
    r = decide({ prompt: '新任务' }, r.state, now, 0);
    check('冷却期外注入', r.emit);
    r = decide({ prompt: '又一个任务' }, r.state, now + 1, 60000);
    check('冷却期内静默', !r.emit);
    r = decide({ prompt: '我查过路由表了' }, { count: 5, last: now - 999999 }, now, 60000);
    check('已声明跳过并刷新节流', !r.emit && r.state.last === now);
    // 状态读写回环 + 损坏容错
    const f = stateFile(dir, 'sess-x');
    const { emit } = decide({ prompt: 't' }, { count: 1, last: 0 }, now, 0);
    check('决策纯函数可用', emit);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ count: 2, last: now }));
    check('状态写读回环', loadState(f).count === 2);
    writeFileSync(f, '{{{ not-json');
    check('状态损坏按无状态处理', loadState(f).count === 0);
    // 信封契约
    const env = JSON.parse(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER } }),
    );
    check('信封事件名 = UserPromptSubmit', env.hookSpecificOutput.hookEventName === 'UserPromptSubmit');
    check('提醒为指针级单行', !REMINDER.includes('\n') && REMINDER.length < 200);
    // 哨兵：只数"本会话 + 本插件"的失败；增量幂等；截断重扫；坏行容忍
    const mk = (session, source) =>
      JSON.stringify({ event: 'hook.run.failed', sessionId: session, context: { source } });
    writeFileSync(
      log,
      [
        mk('sess-a', 'plugin.workflow@wangp-local-marketplace.PreToolUse.0.0'),
        mk('sess-a', 'plugin.mimosa@zcode-plugins-official.Stop.1.0'), // 他插件：不数
        mk('sess-b', 'plugin.workflow@wangp-local-marketplace.Stop.0.0'), // 他会话：不数
        '{{{ not-json',
      ].join('\n') + '\n',
    );
    let s = scanFailures(log, { offset: 0, lastStopTs: null }, 'sess-a');
    check('哨兵只数本会话本插件失败', s.count === 1 && s.offset > 0);
    s = scanFailures(log, { offset: s.offset, lastStopTs: s.lastStopTs }, 'sess-a');
    check('哨兵增量幂等', s.count === 0);
    // watchGuardFailures 经 logCandidates() 取路径（env 注入缝）——自检期间指向 fixture
    // （恢复用外层 envPrev，2026-09-14 终审 C2：此处曾有遮蔽外层的死变量，已删）
    process.env.WF_GUARD_LOG_PATH = log;
    const w1 = watchGuardFailures({ failSeen: 0, alerted: false, scan: {} }, 'sess-a');
    check('哨兵首见失败→待告警并置位', w1.alertPending && w1.state.failSeen === 1 && w1.state.alerted);
    const w2 = watchGuardFailures(w1.state, 'sess-a');
    check('哨警会话内一次性', !w2.alertPending && w2.state.failSeen === 1);
    writeFileSync(log, mk('sess-a', 'plugin.workflow@wangp-local-marketplace.Stop.0.0') + '\n'); // 变短
    const s3 = scanFailures(log, w2.state.scan[log], 'sess-a');
    check('日志变短从头重扫', s3.count === 1);
    check('日志缺失零计数', scanFailures(join(dir, 'no-such.jsonl'), { offset: 0, lastStopTs: null }, 'sess-a').count === 0);
    check('告警正文含次数与日志指引', alertText(435).includes('435') && alertText(435).includes('hook.run.failed'));
    // 内部任务-290/内部任务-308（内部未决-259）：host×source 两分支——账本面统一指向项目账本；日志来源宿主中
    // ZCode 式派发日志面不跨宿主扫描（宿主差异见 内部接口-1；避免把别家失败算到自己头上）。
    check('账本来源告警指向项目账本', alertText(3, 'ledger').includes('.workflow/routing-state/hook-errors.jsonl') && !alertText(3, 'ledger').includes('~/.zcode/cli/log/'));
    {
      const prevM = process.env.MCODE_HOOK_EVENT;
      const prevO = process.env.WF_GUARD_LOG_PATH;
      // 内部未决-282（内部任务-308）：hostOf 按 DSH_ → KIMI_ → MCODE_ → ZCODE_ 优先级扫描 env，
      // 非 mcode 宿主会话内跑自检时 DSH_/KIMI_ 会抢先命中断言恒红——自检期间临时屏蔽
      // 这两个宿主前缀，结束原样恢复（不在进程级改动宿主环境）。
      const prevHostEnv = Object.keys(process.env)
        .filter((k) => k.startsWith('DSH_') || k.startsWith('KIMI_'))
        .map((k) => [k, process.env[k]]);
      for (const [k] of prevHostEnv) delete process.env[k];
      delete process.env.WF_GUARD_LOG_PATH; // 覆盖缝优先级最高，本断言要验宿主分支
      try {
        // dsh 格（DSH_ 前缀在场 → hostOf=dsh）
        process.env.DSH_HOME = 'C:/tmp/dsh-selftest';
        check('dsh 日志来源不指 zcode 日志', alertText(3, 'log').includes('派发日志面不可用') && !alertText(3, 'log').includes('~/.zcode/cli/log/'));
        check('dsh 下不扫 ZCode 日志候选', logCandidates().length === 0);
        // mcode 格（去掉 DSH_ 前缀、MCODE_HOOK_EVENT 在场）
        delete process.env.DSH_HOME;
        process.env.MCODE_HOOK_EVENT = 'PreToolUse';
        check('mcode 日志来源告警改指宿主中立说明', alertText(3, 'log').includes('派发日志面不可用') && !alertText(3, 'log').includes('~/.zcode/cli/log/'));
        check('mcode 下日志候选为空（不扫别家日志）', logCandidates().length === 0);
        check('mcode 账本来源指向项目账本', alertText(3, 'ledger').includes('.workflow/routing-state/hook-errors.jsonl'));
      } finally {
        if (prevM === undefined) delete process.env.MCODE_HOOK_EVENT;
        else process.env.MCODE_HOOK_EVENT = prevM;
        if (prevO !== undefined) process.env.WF_GUARD_LOG_PATH = prevO;
        if (!prevHostEnv.some(([k]) => k === 'DSH_HOME')) delete process.env.DSH_HOME;
        for (const [k, v] of prevHostEnv) process.env[k] = v;
      }
    }
    // 内部模块-15 套件级：四插件前缀都计数并归因；纠正模式匹配；新状态字段回环
    writeFileSync(log, mk('sess-a', 'plugin.spec-gate@wangp-local-marketplace.SessionStart.1.0') + '\n' + mk('sess-a', 'plugin.scout@wangp-local-marketplace.SessionStart.0.0') + '\n');
    const sSuite = scanFailures(log, { offset: 0, lastStopTs: null }, 'sess-a');
    check('套件级哨兵数兄弟插件失败', sSuite.count === 2 && sSuite.sources.length === 2);
    // 按停噪音窗（hf-84c89b764）：与同会话 v4.stop 相邻的失败排除；窗外照常计
    const ts0 = Date.parse('2026-09-14T10:00:00.000Z');
    const mkTs = (ts, source) =>
      JSON.stringify({ timestamp: new Date(ts).toISOString(), event: 'hook.run.failed', sessionId: 'sess-a', context: { source } });
    const mkStop = (ts) =>
      JSON.stringify({ timestamp: new Date(ts).toISOString(), event: 'v4.stop.foreground_execution_inspected', sessionId: 'sess-a' });
    writeFileSync(log, mkStop(ts0) + '\n' + mkTs(ts0 + 500, 'plugin.workflow@wangp-local-marketplace.Stop.1.2') + '\n');
    const sWin = scanFailures(log, { offset: 0, lastStopTs: null }, 'sess-a');
    check('按停窗内失败不计数并记录 stop 时戳', sWin.count === 0 && sWin.lastStopTs === ts0);
    writeFileSync(log, mkStop(ts0) + '\n' + mkTs(ts0 + 5000, 'plugin.workflow@wangp-local-marketplace.Stop.1.2') + '\n');
    check('按停窗外失败照常计数', scanFailures(log, { offset: 0, lastStopTs: null }, 'sess-a').count === 1);
    check('matchCorrections 命中纠正模式', JSON.stringify(matchCorrections('不对，重来')) === '[0,2]');
    check('matchCorrections 正常消息零命中', matchCorrections('帮我看下这个功能').length === 0);
    // 内部任务-DRIFTNUDGE-1：漂移判定两触发 + 三豁免 + 两不触发 + 文案
    check('漂移：code-review + 修复意图命中', isRoutingDrift('code-review', '定位并修复这个问题'));
    check('漂移：idea-review + 实现意图命中', isRoutingDrift('idea-review', '基于设计文档在项目中实现该功能'));
    check('漂移豁免：评审主导句不命中', !isRoutingDrift('code-review', '全面审查目录代码，发现问题则逐项修复'));
    check('漂移豁免：已点名流程链不命中', !isRoutingDrift('code-review', '修复批走 plan-writing → plan-review → plan-execution'));
    check('漂移豁免：过程陈述不命中', !isRoutingDrift('code-review', '改动是必要的修复，没必要新建分支'));
    check('漂移不触发：非评审类 skill', !isRoutingDrift('plan-execution', '定位并修复这个问题'));
    check('漂移不触发：无上一声明', !isRoutingDrift(null, '定位并修复这个问题'));
    check('漂移文案点名 skill 与路由表', driftText('code-review').includes('code-review') && driftText('code-review').includes('路由表'));
    writeFileSync(join(dir, 'st2.json'), JSON.stringify({ count: 3, corrected: ['p0'], alerted: true }));
    const st2 = loadState(join(dir, 'st2.json'));
    check('新状态字段回环', st2.corrected.length === 1 && st2.corrected[0] === 'p0' && st2.alerted);
    // 签发键集（P9，2026-09-16 使用反馈批次）：锚不可见时按 cwd 仓 + 仓内嵌套仓全量签发。
    // 环境隔离=宿主 ZCODE_PROJECT_DIR 必须清（否则锚存在走另一分支，测不到回退），
    // 且 WF_ROUTING_STATE_DIR 单独指向（discoverRepoKeys 的 5 分钟缓存写 stateDir）。
    const projDir = mkdtempSync(join(tmpdir(), 'wf-uprompt-issuance-'));
    const nestedDir = join(projDir, 'docs', 'nested');
    mkdirSync(join(projDir, '.git'), { recursive: true });
    mkdirSync(join(nestedDir, '.git'), { recursive: true });
    const driftIso = mkdtempSync(join(tmpdir(), 'wf-uprompt-driftL-'));
    mkdirSync(join(driftIso, '.git'), { recursive: true }); // 锚域外的 cwd 仓（漂移形态）
    const prevAnchor = process.env.ZCODE_PROJECT_DIR;
    const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
    const isoStateDir = mkdtempSync(join(tmpdir(), 'wf-uprompt-issuance-state-'));
    delete process.env.ZCODE_PROJECT_DIR;
    process.env.WF_ROUTING_STATE_DIR = isoStateDir;
    try {
      const keys = issuanceKeys(projDir).map((k) => resolve(k));
      check(
        '无锚回退：cwd 仓与仓内嵌套仓同批签发（P9；键 canonical 形态，TASK-MACKEY-1）',
        keys.includes(canonicalRoot(projDir)) && keys.includes(canonicalRoot(nestedDir)),
      );
      // 内部任务-LEASEATT-1：锚可见但 cwd 域外——锚键与 cwd 键并集同签；锚覆盖 cwd——单键保持
      // （单键场景须用无嵌套仓的独立仓：projDir 自带 nestedDir，锚=projDir 时嵌套键合法在集）
      process.env.ZCODE_PROJECT_DIR = projDir;
      const keysUnion = issuanceKeys(driftIso).map((k) => resolve(k));
      check('锚分支 cwd 并集：锚键与 cwd 键同签（TASK-LEASEATT-1）',
        keysUnion.includes(canonicalRoot(projDir)) && keysUnion.includes(canonicalRoot(driftIso)));
      process.env.ZCODE_PROJECT_DIR = driftIso;
      const keysSame = issuanceKeys(driftIso).map((k) => resolve(k));
      check('锚覆盖 cwd：并集后仍单键（历史形态保持）', keysSame.length === 1 && keysSame.includes(canonicalRoot(driftIso)));
      // 内部任务-8 任务 5.2（内部规则-19 ⑥）：签发自校验三态锚 + 降级指引字面量
      const chv = issueChallenge(canonicalRoot(projDir), { sessionId: 'sess-v' });
      check('verifyChallengeOnDisk 真签回读通过', verifyChallengeOnDisk(chv.leaseId).ok === true);
      const miss = verifyChallengeOnDisk('0'.repeat(32));
      check('verifyChallengeOnDisk 缺失判 missing（三态锚）', miss.ok === false && miss.reason === 'missing');
      check(
        '降级指引字面量（未落盘 + 重试动作 + 可排查项）',
        DEGRADED_LEASE_TEXT('missing').includes('本轮签发未落盘') &&
          DEGRADED_LEASE_TEXT('missing').includes('WF_ROUTING_STATE_DIR') &&
          DEGRADED_LEASE_TEXT('missing').includes('请再发一条消息获取新令牌'),
      );
    } finally {
      if (prevAnchor === undefined) delete process.env.ZCODE_PROJECT_DIR;
      else process.env.ZCODE_PROJECT_DIR = prevAnchor;
      if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
      rmSync(projDir, { recursive: true, force: true });
      rmSync(isoStateDir, { recursive: true, force: true });
      rmSync(driftIso, { recursive: true, force: true });
    }
    // 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：分类标注、摘要三分口径、指针文案、promotions 过龄
    const clsCorr = classifyFact({ kind: 'user-correction', host: 'dsh' }, loadRules());
    check(
      'v2 纠正分类标注（cause/severity/ruleId/rulesVersion）',
      clsCorr.cause === 'user-correction' && clsCorr.severity === 'warn' && clsCorr.ruleId === 'r-user-correction' && clsCorr.rulesVersion === 1,
    );
    const sumV2 = buildSummary('/nonexistent-summary-root', {
      sessionId: 's-v2',
      taskId: 'DEV-1',
      reader: () => ({
        records: [
          { id: 'a', ts: 1, session: 's-v2', taskId: 'DEV-1', kind: 'tool-failure', cause: 'real-failure', status: 'open' },
          { id: 'b', ts: 1, session: 's-v2', kind: 'user-correction', cause: 'user-correction', status: 'open' },
          { id: 'c', ts: 1, session: 'other', kind: 'lease-loop', cause: 'mechanism-escalation', status: 'open' },
          { id: 'd', ts: 1, session: 'other', kind: 'tool-failure', cause: 'probe-noise', status: 'open' },
        ],
        dropped: 1,
      }),
    });
    check(
      'v2 摘要三分之和＝待排查且证据面单列',
      sumV2.total === 3 && sumV2.byTask === 1 && sumV2.bySession === 1 && sumV2.byOthers === 1 && sumV2.evidence === 1 && sumV2.dropped === 1,
    );
    check(
      'v2 指针文案（三分与证据面逐字口径 + 归零空串）',
      formatPointerLine(sumV2) === '3 条待排查（本任务 1 / 本会话 1 / 其他会话 1；证据面 1 条已分层排除）' &&
        formatPointerLine({ total: 0 }) === '',
    );
    const promoDir = join(dir, '.workflow', 'promotions');
    mkdirSync(promoDir, { recursive: true });
    writeFileSync(join(promoDir, `${Date.now()}-fresh.md`), '# x\n');
    writeFileSync(join(promoDir, `${Date.now() - 40 * 86400000}-stale.md`), '# x\n');
    // 草案目录与账本共用根覆盖缝（WF_INCIDENT_ROOT）：自检期间指向自身夹具根，避免被外层注入缝带走
    const prevIncidentRoot = process.env.WF_INCIDENT_ROOT;
    let promo;
    try {
      process.env.WF_INCIDENT_ROOT = dir;
      promo = countPromotions(dir, { now: Date.now() });
    } finally {
      if (prevIncidentRoot === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = prevIncidentRoot;
    }
    check('v2 promotions 30 天过龄不提醒（未过龄 1 / 过龄 1）', promo.promotions === 1 && promo.expiredPromotions === 1);
  } finally {
    if (process.env.WF_GUARD_LOG_PATH === log) process.env.WF_GUARD_LOG_PATH = envPrev;
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) {
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  }
  if (failed.length > 0) {
    process.stdout.write(`FAIL user-prompt.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK user-prompt.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

/**
 * 主入口：解析负载 → 决策 → 落状态 → 按需注入。任何异常静默退出 0。
 * @returns {Promise<void>}
 */
async function main() {
  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // 负载非法：fail-open，无输出
  }
  const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt : '';
  if (!prompt.trim()) process.exit(0);
  // 会话键容错多形态字段名；缺省 'default'（不区分会话时退化为全局节流）
  const rawKey = parsed.session_id ?? parsed.sessionId ?? 'default';
  const sessionKey = typeof rawKey === 'string' && rawKey ? rawKey : 'default';

  const stateDir = process.env.WF_UPROMPT_STATE_DIR || runtimeStateDir(); // A4 同款（评审 C4：留在 tmpdir 则重启重扫产生幻影复发）
  const cooldownRaw = Number(process.env.WF_UPROMPT_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS);
  const cooldownMs = Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : DEFAULT_COOLDOWN_MS;
  const nudgeRaw = Number(process.env.WF_UPROMPT_NUDGE_EVERY ?? DEFAULT_NUDGE_EVERY);
  const nudgeEvery = Number.isInteger(nudgeRaw) && nudgeRaw > 0 ? nudgeRaw : DEFAULT_NUDGE_EVERY;

  const file = stateFile(stateDir, sessionKey);
  const loaded = loadState(file);
  const { emit, state: decided } = decide({ prompt }, loaded, Date.now(), cooldownMs);
  // 哨兵与提醒解耦：告警不受首条跳过/已声明/冷却期约束（失效可见优先于安静）
  const { alertPending: logAlertPending, newSources, truncated: logTruncated, state: watched } = watchGuardFailures({ ...loaded, ...decided }, sessionKey);
  // 任务租约行每轮必注（内部规则-8：挑战签发不随提醒节流）
  const cwd = typeof parsed?.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd();
  const projRoot = projectKey(cwd);
  // 激活域（2026-09-15 批次，内部决策-022）：非仓目录（cwd 无 .git 祖先）整套静默——
  // 不签租约、不注入提醒/周期提示、不做纠偏捕获、不落 hook-failure/待排查指针，
  // 唯一保留哨兵告警（环境健康与项目纪律无关，fail-open 家族刻意保留失效可见半边）。
  const repo = activationRoot(cwd);

  // 场景漂移（内部任务-DRIFTNUDGE-1）：本轮新挑战「签发前」读上一声明——
  // 会话桶强形态下签发即吊销上一 active（task-lease-lib issueChallenge），签发后读不到；
  // active 缺失（上轮未声明/已被轮换吊销）时以状态持久化 declaredSkill/declaredEpoch 兜底。
  const leaseSessionId = sessionKey === 'default' ? null : sessionKey;
  let prevSkill = null;
  let prevEpoch = null;
  // 本会话已声明租约的交付任务号（内部模块-15 v2 归属三分「本任务」桶的键；无租约即 null）
  let prevLeaseTaskId = null;
  if (repo) {
    // 归因读严于闸读：要求 lease 会话侧与观察侧同口径（observer null 只认 null 桶），
    // 不接受扫描回退救回的他会话 lease——漂移归因张冠李戴比漏提醒危害大。
    const prev = readSameSessionLease(projRoot, leaseSessionId);
    if (prev) {
      prevSkill = prev.skill;
      prevEpoch = Number(prev.promptEpoch) || null;
      prevLeaseTaskId = typeof prev.taskId === 'string' && prev.taskId ? prev.taskId : null;
    } else {
      prevSkill = loaded.declaredSkill;
      prevEpoch = loaded.declaredEpoch;
    }
  }
  // 一次性提醒的重置：新激活（epoch 变化，含同名 skill 的新一轮声明）即重置；
  // 无新激活（未声明的连续轮次，含兜底）保持已显示态
  const driftShown = prevSkill !== null && prevEpoch === loaded.declaredEpoch ? loaded.driftShown : false;
  const driftAlert = isRoutingDrift(prevSkill, prompt) && !driftShown;

  // OPEN 预筛（内部任务-57/内部规则-22；内部任务-244 P05 改口径）：激活域内、非委派时**会话内一次性扫描**——
  // 按当前消息任务域 token 匹配登记册未关项；命中与否都置 openScanShown（后续消息不再扫描/
  // 注入），册解析结果按 mtime/size 缓存复用；委派会话整体跳过（不扫描不置位——delegated
  // 判定前移共用，检查点①发现 3 处置＋终审简洁性发现 1 收敛单名）；册缺席/解析失败/构造
  // 异常一律零输出（fail-open，义务全文在 内部接口-8 §7.1）。
  const delegated = isDelegatedSession(parsed);
  // 内部决策-061 D3/D4（内部任务-227）：委派深度与父会话标识——DSH 适配层 UPS 负载注入；缺键即顶层语义。
  const delegationDepth = Number.isSafeInteger(parsed?.delegation_depth) && parsed.delegation_depth > 0 ? parsed.delegation_depth : 0;
  const parentSessionId = typeof parsed?.parent_session_id === 'string' && parsed.parent_session_id ? parsed.parent_session_id : null;
  const delegation = { depth: delegationDepth, parentSessionId };
  let openScanShown = Boolean(loaded.openScanShown);
  let openCandidate = '';
  if (repo && !delegated && !openScanShown) {
    // 内部任务-244 P05：会话内**一次性**预筛（命中与否都置位，防每轮全扫）＋册 mtime/size 缓存
    // （同册未变不重复解析；册变更自动失效重扫）。
    openScanShown = true;
    try {
      openCandidate = openCandidateLine(
        prompt,
        prevSkill,
        scanOpenItemsCached(join(repo, 'specs/open-items.md'), join(stateDir, 'wf-open-items-cache.json')),
      );
    } catch {
      openCandidate = '';
    }
  }

  // 内部模块-15 v2 摘要库（内部决策-063 D6）：单次读盘给出指针与后续消费面所需的全部数字/记录视图，
  // 禁止下游各自再读（并发追加落窗时两处数字自相矛盾——内部任务-DEBTFIX-1 先例）。
  // **先读后记**：本轮的 hook-failure 落账（recordHookFailures）放在摘要之后——否则哨兵
  // 第二来源会把「日志来源同一失败」重复计入，去重口径（取 max）当场失效。
  let summary = null;
  try {
    summary = repo ? buildSummary(projRoot, { sessionId: sessionKey, host: hostOf({}), taskId: prevLeaseTaskId, openOnly: true }) : null;
  } catch {
    summary = null; // 读盘异常：摘要缺席（指针/轻提醒缺席，不报错）
  }
  // 自察 B：告警触发时按插件归因落 hook-failure 记录（记录失败不反噬告警）
  // B3 修订：新增失败即落记录（跨小时桶新 id）——告警仍会话内一次，记录不再被 source 幂等吞掉
  if (repo && newSources.length > 0) recordHookFailures(projRoot, sessionKey, newSources);
  // 内部模块-15 v2 哨兵第二来源（内部决策-063 D8/内部验收-3）：适配层经 emit 落的 hook-failure 记录与
  // 宿主日志来源合并为**一次**告警——同一失败两来源并存时计数取 max（不叠加），
  // 且沿用「会话内一次性」语义（已告警后不再重复）。
  let ledgerHookFailures = 0;
  if (summary) {
    const sid = normalizeSession(sessionKey);
    const myHost = hostOf({});
    ledgerHookFailures = summary.records.filter((r) => r.kind === 'hook-failure' && sessionMatches(r, sid, myHost)).length;
  }
  let alertPending = logAlertPending;
  const watchedMerged = { ...watched, failSeen: Math.max(watched.failSeen, ledgerHookFailures) };
  // 内部任务-290：来源判定——日志计数更大（或相等）走 'log' 指引，账本计数更大走 'ledger'（后者在 MCode 下文案不变）
  const alertSource = watched.failSeen >= ledgerHookFailures ? 'log' : 'ledger';
  if (!alertPending && ledgerHookFailures > 0 && !loaded.alerted) {
    alertPending = true;
    watchedMerged.alerted = true;
  }

  // 自察 C-1：用户纠正捕获（每消息至多一条——取首个命中模式；每会话同模式一次；
  // WF_UPROMPT_CORRECTION=off 关闭）
  let corrected = [...loaded.corrected];
  let correctionNoted = false;
  if (repo && process.env.WF_UPROMPT_CORRECTION !== 'off') {
    const hits = matchCorrections(prompt);
    if (hits.length > 0) {
      const key = `p${hits[0]}`;
      if (!corrected.includes(key)) {
        corrected.push(key);
        // 内部模块-15 v2（内部决策-063 D3）：纠正记录同样走规则表分类（cause/severity/ruleId 由数据资产决定，
        // 不在代码里硬编码类别——新增纠正面/宿主时零核心改动）。
        const cls = classifyFact({ kind: 'user-correction', host: hostOf({}) }, loadRules());
        appendIncident(projRoot, {
          id: `uc-${digestOf(['uc', sessionKey, key])}`,
          ts: Date.now(),
          session: sessionKey,
          taskId: null,
          skill: null,
          plugin: null,
          kind: 'user-correction',
          // 内部任务-20 B/F9：同上（host 三态；可选字段，旧记录零校验）
          host: hostOf({}),
          tool: null,
          event: null,
          digest: digestOf(['user-correction', key]),
          cause: cls.cause,
          severity: cls.severity,
          ruleId: cls.ruleId,
          rulesVersion: cls.rulesVersion,
          observationSource: 'hook:user-prompt',
        });
        correctionNoted = true;
      }
    }
  }

  // 自察 C-2：待排查指针（C2 修订 2026-09-13：open>0 期间每条消息持续显示计数直到
  // 归零——「会话内一次性」会让用户错过复发信号；归零即消失，再 open 即恢复。
  // 评审 S1：原 triageNotified 门已删，字段随之退役）
  // 内部模块-15 v2（内部决策-063 D6）：文案改由摘要库统一构造——「N 条待排查（本任务 X / 本会话 Y /
  // 其他会话 Z；证据面 M 条已分层排除）」；口径＝cause 派生（旧行两层回退），
  // lease-loop 恒计入由 `isPendingIncidentV2` 承接。非仓目录不渲染（活状态只跟随项目走）。
  let pointerLine = null;
  try {
    if (summary) {
      const line = formatPointerLine(summary);
      if (line) {
        pointerLine = `【workflow 自察】项目有 ${line}：${incidentCliCommand()} list --project-root '${repo.replaceAll('\\', '/')}'（账本 .workflow/incidents.jsonl）`;
      }
    }
  } catch {
    /* 计数不可读：指针缺席，不报错 */
  }

  const merged = { ...decided, ...watchedMerged, corrected, declaredSkill: prevSkill, declaredEpoch: prevEpoch, driftShown: driftAlert || driftShown, openScanShown };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(merged));
  } catch {
    process.exit(0); // 状态落不下：宁可漏提醒也不刷屏（fail-open 的另一半）
  }
  const parts = [];
  // 内部任务-20 A1/F4：委派子代理会话注入面收窄——只留租约行。为什么：被注入自察指针/漂移提醒
  // 时，委派的评审/勘察代理会把整轮用于 incident 归因（F4 取证）；租约行必须保留
  // （子代理仍需声明，内部未决-81）。判据吃结构化字段（共享谓词，缺键/0/非法 ⇒ 顶层会话语义）。
  // 哨兵告警**不**随委派收窄（plan-review A2 裁决 a）：它按会话扫描宿主日志，是子代理自身
  // hook 失败的唯一可见面（抑制=制造静默失败）。
  // （delegated 已前移至 OPEN 预筛块前共用——终审简洁性发现 1：同一谓词一次求值单名）
  if (alertPending) parts.push(alertText(watchedMerged.failSeen, alertSource));
  if (!delegated && driftAlert) parts.push(driftText(prevSkill));
  // 租约行/提醒/周期提示只在激活域内注入（非仓静默，见上 repo 注释）
  if (repo) {
    const line = leaseLine(cwd, leaseSessionId, delegated, delegation);
    if (line) parts.push(line);
    if (!delegated) {
      if (emit) parts.push(reminderText());
      // 周期提示与提醒节流解耦：只看轮数计数（首条跳过的是提醒，不是周期提示）
      if (decided.count % nudgeEvery === 0) parts.push(nudgeText(decided.count));
      if (openCandidate) parts.push(openCandidate);
      // 零域态两途引导（内部决策-050 D3，内部任务-62）：租约行后独立行（不并入——内部规则-7 行长口径），
      // visibilityHints 自包异常兜底（恒返 {domains:false}，fail-open）＋复用 849 行 projRoot。
      if (visibilityHints(projRoot).domains) parts.push(DOMAINS_SETUP_HINT);
    }
  }
  // 纠正捕获的**记账**不因委派而关闭（收窄的是注入面，不是留痕面）；注入面则收窄
  if (!delegated && correctionNoted) parts.push('【workflow 自察】检测到纠正信号，已记一条自察异常（.workflow/incidents.jsonl）——任务收尾时会再提醒排查。');
  if (!delegated && pointerLine) parts.push(pointerLine);
  // 内部任务-244 P04：日志扫描截断可见化（本会话首次；早期 hook 失败可能未计入）
  if (!delegated && logTruncated && !loaded.scanTruncated) {
    parts.push('【workflow 自察】宿主日志超过扫描上限（8MB）——本次仅扫描尾部，早期 hook 失败可能未计入（scan-truncated 已留痕；完整日志见 ~/.zcode/cli/log/）。');
  }
  // 内部模块-15 v2（内部决策-063 D6）：promote 草案轻提醒——过龄草案不计（summary.promotions 已排除），
  // 只提醒**未过龄**待转正者；文案由摘要库单源构造（评审修复 N9，与 task-recap 逐字共用）。
  if (!delegated) {
    const promoLine = formatPromotionLine(summary);
    if (promoLine) parts.push(promoLine);
  }
  if (parts.length > 0) emitContext(parts.join('\n'));
  process.exit(0);
}

export { decide, loadState, stateFile, reminderText, issuanceKeys };

// 宿主调用入口（被 import 时不执行；node user-prompt.mjs 直接运行时才进 main/--selftest）
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
  installHookErrorTrap('user-prompt'); // B1①：漏网抛错落 hook-errors.jsonl（fail-open 不破）
  runHookMain('user-prompt', main);
}
