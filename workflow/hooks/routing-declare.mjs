// 文件：routing-declare.mjs
// 描述：任务租约声明命令（内部规则-8，2026-09-13 内部决策-018 升级为 per-session capability 租约）
//       ——代理查完路由表后运行：
//         node routing-declare.mjs <命中skill名> --lease <本轮leaseId> --task-id <任务号>
//           [--plan <计划路径>] [--exempt "<逐字引文>" --exempt-scope plan|review --exempt-src user|preauthorized]
//           [--exempt-revoke --exempt "<撤销原话>" --exempt-src user|preauthorized --plan <已评审计划>]
//           [--change-scope '["docs/plans",…]']
//           [--manual-task-id <任务号> --manual-reason "<≥8 字>"]
//           [--resume-task --resume-reason "<≥8 字>"]
//       凭 leaseId 反查挑战所属会话并激活本会话任务租约（task-lease-lib 键控），
//       （Bash|Edit|Write）三类写操作据此放行（本会话内有效，本会话下一条用户消息自动轮换
//       【会话桶强形态】；会话标识不可见时 null 桶多活+TTL 自然过期，内部决策-018 修正案
//       2026-09-22 内部任务-LEASEGATE-1：null 桶轮换不吊销+闸校验扫描回退桶对称化；lease-deny
//       振荡升级通道 lease-loop 见自愈段注释）。
//       前置校验（plan-review 强制出口的机械兜底，内部规则-10 衔接）：声明 plan-execution
//       时必须显式点名计划（--plan）且 canonical 同名 -review.md 或同 stem
//       -review*.md 序列中与当前哈希匹配的 v2/v3 通过档在案（taskId/planPath/
//       planSha256 与当前计划内容一致、结论「通过」——P1 序列扫描，2026-10-10
//       内部任务-29；独立/mixed 强制 v3：reviewRound + reviewProvenance，v2 仅
//       self/ratified 历史可读——2026-10-21 内部任务-191）；legacy sidecar 不构成凭据，
//       --exempt 也不能把 legacy 提升为有效评审（显式豁免只留痕，完成侧 exemptAnchor 对无计划锚的 v2 豁免不签 gate receipt）。
//       协议扩展（2026-09-14 内部决策-020；2026-10-31 内部任务-265/内部决策-067）：--change-scope=写面声明（JSON 字符串数组、
//       相对项目根；闸侧仅对 Edit/Write 执行，Bash 维持整闸）；--exempt 改为逐字引文 + --exempt-scope plan|review
//       （review scope 的计划须含 `豁免引文：` 行并绑定 planPath/planSha256）；--exempt-revoke=用户显式退役
//       （撤销原话 + 已评审计划；禁 scope；委派/续任务拒绝）；--exempt-src=来源标注（user=用户当轮消息原文，
//       preauthorized=事前授权已显式记录；先例不构成豁免来源）。审计 schema v2 落 `内部工作流状态`
//       （内部接口-20；scope=plan|review|revoked）；豁免审计写失败 fail-closed（释放租约+exit 1），退役写失败只 warning。
//       2026-10-06（内部任务-5 A组，内部规则-16/F12）：plan-writing/plan-review 声明成功输出附
//       固定阶段许可行（该阶段 Edit/Write 仅限 PLAN_DIRS 过程 Markdown），确认语不再
//       无条件承诺「Bash/Edit/Write 放行」——许可按当前阶段与写面判定；Bash 不受该
//       上界（非 shell 沙箱）。闸侧固定上界执法在 routing-gate.mjs authoringViolation。
//       内部任务-342（2026-11-06）：claim/release/rollback 内部写补 internal journal（fail-open）——内部决策-066 修正案 2。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 姿态说明：本脚本是代理主动调用的交互命令，不是 hook——参数错误与前置缺失必须
//       失败可见（退出 1 + 指引），不走 fail-open；只有 --selftest 之外的意外异常
//       按 hook 家族惯例静默退出 0，避免把调用方卡死。
// 用法：见上；自检：node routing-declare.mjs --selftest（B-M8-4）
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectKey, canonicalRoot, verifyReviewedPlan, planSha256, normalizePlanRelPath, resolveDeclaredPlan, SKILL_NAME_RE, activationRoot, initProjectStateRoot, readProjectRoutingConfig, stateRootDiagnostic, SKILL_WRITE_FLOOR, stateRootFor } from './routing-lib.mjs';
import { applicableSkills, requiredProjectSkills, requiredProjectSkillsFromSource } from '../scripts/lib/project-skills.mjs';
import { activateLease, issueChallenge, readActiveLease, newestActiveLease, normalizeScopeEntries, normalizeScriptWrites, normalizeScriptEditCode, EXEMPT_SOURCES, TASK_ID_RE, challengeHomeKey, suggestedTaskId, repoDomains, repoMaintainers, releaseClaim, releaseClaimEx, rollbackActivation, LEASE_REASONS, challengeOwnerInfo, activationReachability, readDomainRequests, writeDomainRequest, DOMAIN_REQUEST_MAX, DOMAIN_REQUEST_TTL_MS, REISSUE_TRIAGE_NOTE, visibilityHints, DOMAINS_SETUP_HINT, readRecentDegraded, OCCUPANCY_ALL_SOURCES } from './task-lease-lib.mjs';
import { recordExemption, recordExemptionRevocation } from '../scripts/lib/exemption-store.mjs';
import { checkExemptDeclarationShape, checkExemptRevokeQuote, exemptionQuoteMatches, findExemptQuoteLine } from '../scripts/lib/exempt-protocol.mjs';
import { appendScriptEdit, appendScriptWrite } from '../scripts/lib/script-write-store.mjs';
import { appendInternalJournal, projectDigestOf } from '../scripts/lib/write-audit.mjs';
import { ROUTING_ENTRY_SKILLS, BRIDGING_ENTRY_SKILLS, AD_HOC, AD_HOC_DELIVERABLE, AD_HOC_NAMES, isDeclarableSkill, isBridgingSkill } from '../scripts/lib/routing-skills.mjs';
import { appendIncident, digestOf, applyDispositions } from '../scripts/lib/incident-store.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';

/**
 * 工作流内部写归因 journal（内部任务-342/内部决策-066 修正案 2 内部模块-3）：routing-declare 的 claim/release/rollback
 * 等非模型写仓后追加 `tool:'internal'` 行，供 Stop 报表归 attributed/internal 或 delegated/external。
 * owner 不可识别（null 桶声明）时 sid=null；写失败只 stderr 警示（fail-open，不阻断声明/释放）。
 * `WF_INTERNAL_JOURNAL_FAIL=1` 仅测试注入缝（L6 fail-open 用例）。
 */
function journalInternalWrite(key, { sessionId = null, taskId = null, targets = [] } = {}) {
  try {
    if (process.env.WF_INTERNAL_JOURNAL_FAIL === '1') throw new Error('injected-journal-failure');
    appendInternalJournal(stateRootFor(key), projectDigestOf(key), { sid: sessionId, taskId, targets });
  } catch (e) {
    process.stderr.write(`routing-declare：提示——内部写归因 journal 追加失败（不阻断声明/释放）：${String(e?.message ?? e)}\n`);
  }
}

/** 用法行（deny 文案与提醒都指向本命令，这里保持自解释） */
const USAGE =
  '用法：node routing-declare.mjs <命中skill名> --lease <本轮leaseId> --task-id <任务号> [--plan <计划路径>] [--project-root <仓根>] [--via <表内入口>] [--script-write "<理由≥8 字>"] [--script-edit-code "<理由≥8 字>"] [--exempt "<逐字引文>" --exempt-scope plan|review --exempt-src user|preauthorized] [--exempt-revoke --exempt "<撤销原话>" --exempt-src user|preauthorized --plan <已评审计划>] [--change-scope \'["docs/plans",…]\'] [--manual-task-id <任务号> --manual-reason "<≥8 字；人工指定号须由人裁决，模型不得自行编造>"] [--resume-task --resume-reason "<≥8 字>"]\n' +
  '  leaseId 取自本轮 UserPromptSubmit 注入的【workflow 任务租约】行；先查 workflow 元技能路由表命中一行再声明。\n' +
  '  --project-root（FB-1 批次）：显式目标仓根，声明键按该目录推导——多仓工作区不必 cd 到对应仓即可声明该行令牌（须为存在目录；缺省按 cwd 推导）。\n' +
  '  声明 plan-execution 必须显式 --plan <docs/plans/下路径>：凭据只认该计划当前哈希的 v2/v3 sidecar\n' +
  '  （v2：taskId/planPath/planSha256/reviewMode/reviewInstances/reviewReason +「结论：通过」，仅 self/ratified；\n' +
  '  独立/mixed 须 v3：另加 reviewRound + reviewProvenance（实例链身份/来源，DEV-191）；旧 sidecar 仅历史可读，须重审或原位补 v3 字段）；多仓工作区计划不在声明键仓内时加 --plan-root <计划所在仓根>（须为存在目录，W4 解耦）；--exempt 为用户显式流程豁免（逐字引文 + --exempt-scope plan|review；review scope 的计划须含 `豁免引文：` 行；留痕，不构成 full 完成链）；--exempt-revoke 为用户显式退役（撤销原话 + 已评审计划；禁 --exempt-scope；委派/续任务拒绝）；\n' +
  '  均须 --exempt-src 标注来源：user=用户当轮消息原文，preauthorized=事前授权已显式记录。\n' +
  '  --change-scope 为写面声明（JSON 字符串数组、相对项目根、拒绝绝对路径与 .. 段）：闸侧仅对 Edit/Write 生效，Bash 维持整闸。\n' +
  '  skill 名须命中三组可声明集（2026-10-10 DEV-29 扩；2026-10-15 ADR-046 增 algo-loop；2026-10-16 DEV-109 增研究环两行〔ADR-047〕、DEV-116 保留名分两道）：表内入口（22 个，查路由表命中）；跨插件衔接 skill（spec-writing/spec-backfill/sdd-ddd-tdd/gate——须凭 --via <表内入口> 标注来源行）；保留名 ad-hoc（状态型非开发任务）/ ad-hoc-deliverable（制品型交付，完成链＝verification→类型匹配评审〔--review-mode deliverable〕→operation→gate --deliverable-chain，见 verification skill）——均不可用于开发任务。\n' +
  '  补签自救（仅限长会话挑战过期场景，不替代路由表判定）：node routing-declare.mjs --bootstrap-reissue \'<目标仓根>\'\n' +
  '  ——前置=目标仓键或当前目录主键任一持有效租约（目标优先，DEV-247）；成功输出新令牌与声明命令模板，审计落 incident（kind=bootstrap-reissue）。\n' +
  '  ——' + REISSUE_TRIAGE_NOTE + '\n' +
  '  取号查询（OPEN-76/ADR-045，任务号为域前缀形态 <域码>-<序号>（默认）或 <域码>-<维护者码>-<序号>（三段））：node routing-declare.mjs --suggest-task-id [--domain <域码>] [--maintainer <维护者码>] [--project-root <仓根>]\n' +
  '  释放占用（DEV-8 任务 4.5，R-M8-19 ④；DEV-24 D2 三作用域；OPEN-87 探测链缺省）：node routing-declare.mjs --release <作用域> [--project-root <仓根>]\n' +
  '  ——释放本键的 task-id 占用（claim）+ 激活租约（active）+ current 指针；作用域＝显式三选一或探测链缺省本会话（命中已证实宿主会话变量时；未命中裸用拒绝）：\n' +
  '  --lease <本轮leaseId>（经令牌反查签发会话，只释放该会话条目——排障定向出口）｜--session <会话id>（直通会话过滤）｜\n' +
  '  --all-sessions（显式全量：同键其他会话的 active 一并删除 ⇒ 正在工作的会话当场丢写权限，直至其重新声明）；\n' +
  '  正常生命周期事件，零 incident 落盘。\n' +
  '  ——扫描活跃租约、.sdd/receipts/、docs/plans/evidence/ 子目录名（evidence 为 git 同步面，DEV-24；receipts 为本机面，OPEN-104 订正）及 docs/plans/ 平铺文件名内嵌任务号（DEV-37，git 同步面）按域建议下一个任务号；仓域声明见 .workflow/domains.json（schemaVersion 1）；零域态（无声明且无可推断域）回落内置默认域 DEV（DEV-75）；旧 TASK- 系形态不再接受。\n' +
  '  占位登记（ADR-050 D1，DEV-62）：声明成功即写 docs/plans/claims/<任务号>.json（git 同步面占用事实源）——随本任务首次提交一并 commit+push 即跨机可见；未推送的弃任务号随 TTL 回池。';

/**
 * 自检入口（B-M8-4）：参数校验、租约激活回环、v2 计划凭据（通过/改字/legacy/错task）；
 * 失败可见退 1。
 * @returns {number} 退出码
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-rdec-selftest-'));
  const prevDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    process.env.WF_ROUTING_STATE_DIR = join(home, 'state');
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    check('项目键推导（canonical 形态，TASK-MACKEY-1）', key === canonicalRoot(proj));
    check('合法 skill 名通过校验', SKILL_NAME_RE.test('plan-execution'));
    check('非法 skill 名被拒', !SKILL_NAME_RE.test('Not A Name!'));
    // 成员校验（2026-09-15 激活域批次，内部决策-022）：表内入口放行、表外拒绝、ad-hoc 保留名放行
    check('表内入口可声明（plan-execution）', isDeclarableSkill('plan-execution'));
    check('表外名拒绝（bogus-skill）', !isDeclarableSkill('bogus-skill'));
    check('ad-hoc 保留名放行', isDeclarableSkill('ad-hoc'));
    check('ad-hoc 不在表内入口集合（防 lint 误当目录）', !ROUTING_ENTRY_SKILLS.has(AD_HOC));
    check('ad-hoc-deliverable 保留名放行（DEV-116）', isDeclarableSkill(AD_HOC_DELIVERABLE));
    check('ad-hoc-deliverable 不在表内入口集合（防 lint 误当目录）', !ROUTING_ENTRY_SKILLS.has(AD_HOC_DELIVERABLE));
    check('合法 taskId 通过校验', TASK_ID_RE.test('TASK-12')); // TASK=4 位大写，纯数字尾变体与新形态字符串重叠（内部未决-76 边界）
    check('旧主力形态 taskId 拒绝（OPEN-76）', !TASK_ID_RE.test('TASK-RELEASE-54'));
    check('ADR-045 三段形态受理（可选维护者段）', TASK_ID_RE.test('DEV-WP-96') && !TASK_ID_RE.test('DEV-WP-X-1') && !TASK_ID_RE.test('DEV-wp-1'));
    // 内部任务-75/IMP-4：旧「零域教育指引」断言对象随兜底落地废止——零域态现回落默认域
    // （恰单域 DEV 空态取 1 + usedDefaultDomains 标记）；CLI 附注面由 node --test 端到端覆盖。
    check('取号器零域默认域兜底（DEV-75）', (() => {
      const fresh = join(home, 'fresh-proj');
      mkdirSync(join(fresh, '.git'), { recursive: true });
      const s = suggestedTaskId(projectKey(fresh));
      return s.ok === true && s.usedDefaultDomains === true && s.suggestions[0]?.taskId === 'DEV-1';
    })());
    // P1（2026-09-16 使用反馈批次）：声明成功输出须带「读正文」指针行——断言用实现之外的
    // 字面量（删掉该行或抽掉锚点即红），不引用被测常量的自指形态
    check(
      '成功输出含读正文指针行（P1）',
      nextStepHintLine('plan-execution').includes('SKILL.md') &&
        nextStepHintLine('plan-execution').includes('阶段复审'),
    );
    // 内部任务-5 契约A（2026-10-06，内部规则-16）：规划阶段声明输出的固定许可反馈；main 侧
    // 输出接线由 node --test 端到端覆盖（routing-declare.test.mjs A组用例）
    check(
      '规划 skill 附固定阶段许可行',
      activationPermitNote('plan-writing').includes('规划阶段') &&
        activationPermitNote('plan-review').includes('docs/plans') &&
        activationPermitNote('plan-writing').includes('Markdown') &&
        activationPermitNote('plan-writing').includes('Bash'),
    );
    check(
      '非规划 skill 不附阶段许可行',
      activationPermitNote('brainstorming') === '' && activationPermitNote('plan-execution') === '',
    );
    check(
      '规划确认语不无条件承诺三类放行',
      !permitPhrase('plan-writing').includes('放行') &&
        permitPhrase('plan-writing').includes('阶段') &&
        permitPhrase('plan-review') === permitPhrase('plan-writing') &&
        permitPhrase('tdd') === 'Bash/Edit/Write 放行',
    );
    // FB-1（2026-09-18 反馈批次）：--project-root 解 cwd 耦合 + 错配双键对照指引
    check('--project-root 键推导命中目标仓', resolveDeclareKey(proj) === key);
    check(
      '--project-root 不存在目录拒绝',
      (() => {
        try {
          resolveDeclareKey(join(home, 'no-such-dir'));
          return false;
        } catch {
          return true;
        }
      })(),
    );
    check(
      '错配对照含双键与三步处置（跨域走 --request-domain 通道）',
      (() => {
        const other = join(home, 'other');
        const d = mismatchDiagnostic(key, other, {
          skill: 'tdd', leaseId: 'abc123', taskId: 'TASK-1', script: '/x/routing-declare.mjs',
        });
        return (
          d.includes('当前声明键') &&
          d.includes('挑战所属仓') &&
          d.includes(other) &&
          d.includes('--request-domain') &&
          d.includes('两步')
        );
      })(),
    );
    check(
      'challengeHomeKey 反查挑战所属仓（未知令牌返回 null）',
      (() => {
        const probe = issueChallenge(key); // 专用挑战：避免引用下方尚未初始化的 ch（TDZ）
        return challengeHomeKey(probe.leaseId, key) === key && challengeHomeKey('0'.repeat(32), key) === null;
      })(),
    );
    // 内部任务-8 任务 4.5（内部规则-19 ④）：--release 释放三件套 + 零态幂等（专用键，不扰本夹具主键）
    const relProj = join(home, 'rel-proj');
    mkdirSync(relProj, { recursive: true });
    const relKey = projectKey(relProj);
    check(
      'releaseClaim 释放 claim+active+current（计数 ≥3）',
      (() => {
        const chRel = issueChallenge(relKey, { sessionId: 'sess-rel' });
        if (!activateLease(relKey, { leaseId: chRel.leaseId, taskId: 'DEV-91', skill: 'tdd' }).ok) return false;
        const n = releaseClaim(relKey, null);
        return n >= 3 && !existsSync(join(home, 'state', `wf-lease-active-${chRel.leaseId}.json`));
      })(),
    );
    check('releaseClaim 零态返回 0（幂等）', releaseClaim(relKey, null) === 0);
    // v2 计划凭据四态
    const plans = join(proj, 'docs', 'plans');
    mkdirSync(plans, { recursive: true });
    const planText = '# 计划\n';
    writeFileSync(join(plans, 'f.md'), planText);
    const fm = `---\nschemaVersion: 2\ntaskId: TASK-1\nplanPath: docs/plans/f.md\nplanSha256: ${planSha256(join(plans, 'f.md'))}\nreviewedAt: 2026-09-13T00:00:00+08:00\nreviewMode: self\nreviewInstances: 0\nreviewReason: "selftest 夹具"\n---\n\n`;
    writeFileSync(join(plans, 'f-review.md'), `${fm}结论：通过\n`);
    check('v2 凭据命中放行', verifyReviewedPlan(proj, 'docs/plans/f.md', 'TASK-1').ok);
    writeFileSync(join(plans, 'f.md'), '# 计划改\n');
    check('计划改字判拒', !verifyReviewedPlan(proj, 'docs/plans/f.md', 'TASK-1').ok);
    writeFileSync(join(plans, 'f.md'), planText);
    writeFileSync(join(plans, 'f-review.md'), '# 评审\n\n结论：通过\n');
    check('legacy sidecar 判拒', !verifyReviewedPlan(proj, 'docs/plans/f.md', 'TASK-1').ok);
    // 内部任务-191：独立/mixed 强制 v3（reviewRound + reviewProvenance）；v2 独立判拒
    const v3chain = 'plan:docs/plans/f.md';
    const v3prov = JSON.stringify([
      { role: 'engineering', instance: 'st-eng', chain: v3chain, state: 'fresh' },
      { role: 'ceo', instance: 'st-ceo', chain: v3chain, state: 'fresh' },
    ]);
    const v3head = `---\nschemaVersion: 3\ntaskId: TASK-1\nplanPath: docs/plans/f.md\nplanSha256: ${planSha256(join(plans, 'f.md'))}\nreviewedAt: 2026-10-21T00:00:00+08:00\nreviewMode: independent\nreviewInstances: 2\nreviewReason: "selftest v3"\nreviewRound: 1\nreviewProvenance: ${v3prov}\n---\n\n`;
    writeFileSync(join(plans, 'f-review.md'), `${v3head}结论：通过\n`);
    check('v3 独立凭据命中放行', verifyReviewedPlan(proj, 'docs/plans/f.md', 'TASK-1').ok);
    const v2ind = `---\nschemaVersion: 2\ntaskId: TASK-1\nplanPath: docs/plans/f.md\nplanSha256: ${planSha256(join(plans, 'f.md'))}\nreviewedAt: 2026-10-21T00:00:00+08:00\nreviewMode: independent\nreviewInstances: 2\nreviewReason: "selftest v2 ind"\n---\n\n`;
    writeFileSync(join(plans, 'f-review.md'), `${v2ind}结论：通过\n`);
    check('v2 独立凭据判拒（须 v3）', !verifyReviewedPlan(proj, 'docs/plans/f.md', 'TASK-1').ok);
    // 租约激活回环
    const ch = issueChallenge(key);
    const act = activateLease(key, { leaseId: ch.leaseId, taskId: 'TASK-1', skill: 'tdd' });
    check('租约激活回环', act.ok);
    // 协议扩展（2026-09-14，内部决策-020）：豁免来源与写面声明的直调级校验
    const badSrc = activateLease(key, {
      leaseId: ch.leaseId,
      taskId: 'TASK-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'bogus',
      exemptScope: 'plan',
    });
    check('非法 exemptSrc 拒', !badSrc.ok);
    const act2 = activateLease(key, {
      leaseId: ch.leaseId,
      taskId: 'TASK-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'user',
      exemptScope: 'plan',
      changeScope: ['./docs/plans', 'docs/plans'],
    });
    check('合法豁免声明激活', act2.ok);
    const lease2 = readActiveLease(key);
    check(
      '合法声明字段齐备（exempt/exemptSrc/exemptScope/changeScope 去重）',
      lease2.valid &&
        lease2.lease.exempt === '不用写计划，直接修' &&
        lease2.lease.exemptSrc === 'user' &&
        lease2.lease.exemptScope === 'plan' &&
        Array.isArray(lease2.lease.changeScope) &&
        lease2.lease.changeScope.length === 1 &&
        lease2.lease.changeScope[0] === 'docs/plans',
    );
  } finally {
    if (prevDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevDir;
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL routing-declare.mjs selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK routing-declare.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

/**
 * 取选项值（--key value 形态）。
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|undefined}
 */
function opt(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

/** 收集可重复旗标的全部值（如 --script-write 一轮可声明多条）；缺值/后随旗标即报错（内部模块-8 §2）。 */
function collectStrict(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v === undefined || String(v).startsWith('--')) return { error: `${flag} 缺值（值不得省略或以 -- 开头）` };
    out.push(v);
  }
  return { values: out };
}

/** 带值的已知旗标清单（位置参数解析须跳过旗标及其值，防选项值误当 skill——R3 回归；--session 为 内部任务-24 D2 释放作用域旗标） */
const VALUE_FLAGS = new Set(['--lease', '--task-id', '--manual-task-id', '--manual-reason', '--resume-reason', '--plan', '--plan-root', '--project-root', '--exempt', '--exempt-src', '--exempt-scope', '--change-scope', '--script-write', '--script-edit-code', '--project-skill', '--bootstrap-reissue', '--session']);

/**
 * 取第一个位置参数（skill）：跳过已知带值旗标及其值——漏写 skill 时 --lease 的
 * hex 值首字符为 a-f 会匹配 SKILL_NAME_RE 而被旧实现（find(!startsWith('--'))）
 * 误当 skill 继续激活（2026-09-14 终审 R3）；未知 -- 旗标只跳过旗标本身（不吞
 * 其后的值，与旧行为一致）。取不到返回 ''，走既有「缺 skill」报错路径。
 * @param {string[]} args
 * @returns {string}
 */
function firstPositionalArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i += 1; // 消费该旗标的值：值不是位置参数
      continue;
    }
    if (a.startsWith('--')) continue;
    return a;
  }
  return '';
}

/**
 * 补签自救子命令（2026-09-16 租约族缺陷批次，W2①；语义见 内部接口-19 补签段）：
 * 长会话挑战 TTL 过期后的官方化补签出口。前置=目标仓键或 cwd 主键任一持有效租约
 * （显式目标优先——2026-10-28 内部任务-247 修订，原 cwd-only 前置在长会话 cwd 漂移时读错
 * 仓键拒掉合法补签；newestActiveLease 扫描命中——「全可见」语义保留，仅作补签前置判定）。
 * 补签挑战**恒挂 null 桶**（内部任务-24 D1，内部任务-99：CLI 场景无宿主会话标识，原「继承主键租约
 * sessionId」在多会话并行时继承的是他会话桶——真会话闸按可见性表永不可见，构成死循环铁证；
 * null 桶全观察侧可见，读侧弱形态已兼容，多活由 TTL 收敛）。审计落 incident
 * （kind=bootstrap-reissue，分钟桶读侧幂等；归因字段记命中键租约原会话——内部任务-247）。
 * 仅限补签用途，不替代路由表判定。
 * @param {string} targetRaw 目标仓根（--bootstrap-reissue 的值）
 * @returns {void}
 */
function bootstrapReissue(targetRaw) {
  if (!targetRaw || !targetRaw.trim()) {
    process.stderr.write(`routing-declare：--bootstrap-reissue 缺少目标仓根参数。\n${USAGE}\n`);
    process.exit(1);
  }
  // 内部任务-247（2026-10-28）：前置主键=显式目标仓键优先、cwd 主键回退——原 cwd-only 派生在长会话
  // cwd 漂移到别仓时读错仓键、拒掉合法补签（内部任务-16 实录：目标主仓持租约而 cwd 滞留嵌套文档仓）；
  // 两键任一 newestActiveLease 命中即过（「全可见」语义保留），审计落命中键，跨仓补签回退保留。
  // newestActiveLease 契约整体失败归 null 不抛（routing-gate 同口径），不设兜底 try/catch。
  const targetKey = projectKey(resolve(targetRaw.trim()));
  const cwdKey = projectKey(process.cwd());
  let mainKey = targetKey;
  let lease = newestActiveLease(mainKey);
  if (!lease && cwdKey !== targetKey) {
    mainKey = cwdKey;
    lease = newestActiveLease(mainKey);
  }
  if (!lease) {
    process.stderr.write(
      `routing-declare：补签被拒——目标仓键（${targetKey}）与当前目录键（${cwdKey}）均无有效租约。` +
        '补签前置是两键之一已声明：请先完成一次正常声明（从最新一轮租约行取令牌）。\n' + USAGE + '\n',
    );
    process.exit(1);
  }
  // D1（内部任务-24/内部任务-99）：补签挑战恒挂 null 桶——CLI 场景无宿主会话标识，继承
  // newestActiveLease 的 sessionId 在多会话并行时是他会话桶，真会话闸按可见性
  // 表永不可见 → 死循环；null 桶全观察侧可见（读侧弱形态已兼容：轮换豁免 +
  // newestVisibleActive 兜底），多活由 TTL 收敛。
  const ch = issueChallenge(targetKey, { sessionId: null });
  // 归因字段取命中键租约原会话（仅审计用，不再作桶归属——内部任务-247：目标键优先命中时记目标键租约）
  const ownerSession = typeof lease.sessionId === 'string' && lease.sessionId ? lease.sessionId : null;
  // 内部模块-15 v2（内部决策-063 修正案 3 决策 23.2，内部任务-195）：补签审计行同批携带 classifyFact 产出的
  // 分类字段（r-lease-trace ⇒ mechanism-trace/info）；禁止内联规则常量。
  const brCls = classifyFact({ kind: 'bootstrap-reissue' });
  appendIncident(mainKey, {
    id: `br-${digestOf(['bootstrap-reissue', ownerSession ?? 'default', targetKey, Math.floor(Date.now() / 60000)])}`,
    ts: Date.now(),
    session: ownerSession ?? 'default',
    taskId: typeof lease.taskId === 'string' ? lease.taskId : null,
    skill: typeof lease.skill === 'string' ? lease.skill : null,
    plugin: 'workflow',
    kind: 'bootstrap-reissue',
    tool: null,
    event: null,
    digest: digestOf(['bootstrap-reissue', targetKey]),
    cause: brCls?.cause ?? 'unclassified',
    severity: brCls?.severity ?? 'info',
    ruleId: brCls?.ruleId ?? null,
    rulesVersion: loadRules().rulesVersion,
    observationSource: 'hook:routing-declare',
  }); // 审计失败静默（fail-open 家族）——补签本身成功即可用，留痕缺失由 incident 读侧不可见但可诊断
  const script = process.argv[1] ? process.argv[1].replaceAll('\\', '/') : '<插件根>/hooks/routing-declare.mjs';
  process.stdout.write(
    `补签成功：目标仓 ${targetKey} 已获新挑战（令牌 ${ch.leaseId}，挂共享桶——CLI 无会话标识，任意会话声明后全观察侧可见）。\n` +
    `下一步（在目标仓任务场景下声明）：node '${script}' <命中skill名> --lease ${ch.leaseId} --task-id <任务号>\n` +
    '注记（DEV-36/DEV-122）：' + REISSUE_TRIAGE_NOTE + '。\n' +
    '本子命令仅限挑战过期补签，不替代路由表判定（先查 workflow 元技能路由表命中一行）。\n',
  );
  process.exit(0);
}

/**
 * 声明键推导（FB-1 批次，2026-09-18）：--project-root 解 cwd 耦合——显式给出目标仓根
 * 时以该路径推导 projectKey（须为存在目录，否则 throw 由 main 转 exit 1，失败可见）；
 * 缺省维持 cwd 推导（历史行为不变，单仓工作流零感知）。
 * @param {string|undefined} projectRootRaw --project-root 原始值（未给 undefined）
 * @returns {string} 项目键
 * @throws {Error} 路径不存在或不是目录（含中文原因）
 */
function resolveDeclareKey(projectRootRaw) {
  if (projectRootRaw === undefined) return projectKey(process.cwd());
  const target = resolve(projectRootRaw.trim());
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`--project-root 须为存在的目录（收到「${projectRootRaw}」）`);
  }
  return projectKey(target);
}

/**
 * 域声明损坏警示（内部未决-76）：文件存在而 repoDomains 返回 null = 真损坏（不可解析/非法），
 * stderr 一行警示——防「配置坏了但没人知道」的域成员收严静默失效；文件不存在 = lenient
 * 正常态（未配置仓），不警示。警示面自身 fail-open（读失败静默，不阻断声明/查询）。
 * @param {string} key 项目键
 */
function warnBrokenDomains(key) {
  try {
    if (!existsSync(join(canonicalRoot(key), '.workflow', 'domains.json'))) return;
    if (repoDomains(key) !== null) return;
    process.stderr.write('【域声明损坏】.workflow/domains.json 不可解析或非法，已退 form-only 校验（域成员收严失效）\n');
  } catch {
    /* 警示面 fail-open */
  }
}

/** 内部决策-045/内部任务-96：维护者注册表损坏可见性（warnBrokenDomains 同构——存在而解析失败才警示，lenient 正常态静默）。 */
function warnBrokenMaintainers(key) {
  try {
    if (!existsSync(join(canonicalRoot(key), '.workflow', 'maintainers.json'))) return;
    if (repoMaintainers(key) !== null) return;
    process.stderr.write('【维护者注册表损坏】.workflow/maintainers.json 不可解析或非法——三段声明被拒（fail-safe），修复 schemaVersion/codes 后可用\n');
  } catch {
    /* 警示面 fail-open */
  }
}

/**
 * 已证实的宿主会话环境变量（内部未决-87，内部任务-46）：新宿主变量经实证后扩链，未证实不猜
 * （ZCode 实测无会话环境变量——2026-10-12 本机 env 全量核验：sess_/session_id 形态与
 * 本会话 UUID 均零命中；Kimi/MCode 未证实）。
 */
const KNOWN_SESSION_ENV_VARS = ['DSH_SESSION_ID'];

/**
 * 探测本进程环境的宿主会话标识（内部未决-87）：按序取首个存在**且值非空**的已证实变量
 * （空串视同未设置——内部规则-19 ⑦ host 探测同款判据）。
 * @returns {{name: string, value: string}|null} 无命中返回 null
 */
function probeSessionEnv() {
  for (const name of KNOWN_SESSION_ENV_VARS) {
    const v = process.env[name];
    if (typeof v === 'string' && v !== '') return { name, value: v };
  }
  return null;
}

/**
 * 释放模式（内部规则-19 ④ / 内部任务-8 任务 4.5；内部任务-24 D2 重构；内部未决-87 探测链缺省）：
 * `--release [--project-root <仓根>]` + 作用域＝显式三选一或探测链缺省——宿主会话标识经
 * 已证实环境变量探测（未证实的宿主无该变量——ZCode 实测 2026-10-12；未命中时无法安全给
 * 默认作用域，裸用 exit 1 附用法教育位；旧「默认全量」在多会话并行下构成意外写权限吊销，
 * 内部任务-99 D2）。
 *   --lease <本轮令牌>：challengeOwnerInfo 反查签发会话，只释放该会话条目（CLI 侧唯一
 *                      可信的「本会话」定义；--request-domain 同款先例）；
 *   --session <会话id>：直通 releaseClaim(key, sessionId)；
 *   --all-sessions：旧全量语义显式化（releaseClaim(key, null)）；
 *   裸用：探测命中已证实变量 ⇒ 缺省作用域＝本会话（等价 --session）。
 * 互斥：>1 作用域旗标 exit 1。**零 incident 落盘**（正常生命周期事件，非异常）。
 * @param {string|undefined} projectRootRaw --project-root 的值（可缺省，按 cwd 推导）
 * @param {{lease?: string, session?: string, allSessions?: boolean}} scope 作用域旗标取值
 * @returns {void}
 */
function releaseMode(projectRootRaw, scope = {}) {
  let key;
  try {
    key = resolveDeclareKey(projectRootRaw);
  } catch (e) {
    process.stderr.write(`routing-declare：${e.message}\n`);
    process.exit(1);
  }
  let probedSession = null; // 内部未决-87：裸用探测命中时的缺省作用域来源
  const picked = [scope.lease, scope.session, scope.allSessions].filter((v) => v !== undefined && v !== false).length;
  if (picked === 0) {
    // 旗标缺值与旗标缺失分诊（阶段复审发现 3）：给了旗标漏值误报「缺少旗标」会误导排障
    const flagGivenNoValue =
      (process.argv.includes('--lease') && scope.lease === undefined) ||
      (process.argv.includes('--session') && scope.session === undefined);
    if (flagGivenNoValue) {
      process.stderr.write(
        'routing-declare：作用域旗标缺值（--lease/--session 须带值，见 USAGE 三作用域说明）。\n' + USAGE + '\n',
      );
      process.exit(1);
    }
    // 内部未决-87（内部任务-46）：裸用经环境探测链缺省——命中已证实宿主会话变量即本会话；未命中拒绝
    probedSession = probeSessionEnv();
    if (!probedSession) {
      process.stderr.write(
        'routing-declare：--release 缺少作用域旗标（未探测到已证实的宿主会话标识变量——探测链：' +
          `${KNOWN_SESSION_ENV_VARS.join('、')}；ZCode 实测无会话环境变量〔2026-10-12 本机核验〕，Kimi/MCode 未证实，新宿主变量实证后扩链` +
          '——裸用曾是默认删本键**全部会话**，多会话并行下构成意外写权限吊销，TASK-99 D2）；三作用域说明见 USAGE。\n' +
          USAGE +
          '\n',
      );
      process.exit(1);
    }
  }
  if (picked > 1) {
    process.stderr.write('routing-declare：--lease / --session / --all-sessions 互斥，只允许一个作用域旗标。\n' + USAGE + '\n');
    process.exit(1);
  }
  let sessionId = null;
  let scopeNote = '范围=本键全部会话（显式 --all-sessions）：同键其他会话的 active 一并删除，其写权限当场失效，需重新声明';
  if (probedSession) {
    sessionId = probedSession.value;
    scopeNote = `范围=会话 ${sessionId}（本会话——经 ${probedSession.name} 环境探测缺省，OPEN-87）：本键其他会话的 active 不受影响`;
  } else if (scope.lease !== undefined) {
    // 路径消毒（阶段复审发现 2）：leaseId 入文件名前必须过 TOKEN_RE（库契约 task-lease-lib
    // TOKEN_RE 注记；声明主路径 :671 同款先例）——非法形态不进 challengeOwnerInfo 的
    // 文件名拼接，直接走「无法反查」拒。
    if (typeof scope.lease !== 'string' || !/^[0-9a-f]{16,64}$/.test(scope.lease)) {
      process.stderr.write(
        `routing-declare：--lease「${String(scope.lease)}」形态非法（16-64 位十六进制）——请用本轮 UserPromptSubmit 租约行内的令牌。\n`,
      );
      process.exit(1);
    }
    const owner = challengeOwnerInfo(scope.lease, key);
    if (!owner || typeof owner.sessionId !== 'string' || !owner.sessionId) {
      process.stderr.write(
        `routing-declare：--lease「${scope.lease}」无法反查签发会话（挑战缺失/过期/字段损坏，或挑战本就挂共享桶）——` +
          '请改用本轮有效令牌，或以 --session <会话id> / --all-sessions 显式指定作用域。\n',
      );
      process.exit(1);
    }
    sessionId = owner.sessionId;
    scopeNote = `范围=会话 ${sessionId}（经令牌反查签发会话）：本键其他会话的 active 不受影响`;
  } else if (scope.session !== undefined) {
    // 非空校验（阶段复审发现 1）：空串经 releaseClaim 的 sess 归一会退化为**全量**释放，
    // 且下方文案谎报定向——正是 D2 要废止的意外吊销面经侧门复活；requestDomainMode 同款先例。
    if (typeof scope.session !== 'string' || !scope.session.trim()) {
      process.stderr.write('routing-declare：--session 值不得为空（空值会退化为全量释放语义，被显式拒绝）。\n' + USAGE + '\n');
      process.exit(1);
    }
    sessionId = scope.session;
    scopeNote = `范围=会话 ${sessionId}（显式指定）：本键其他会话的 active 不受影响`;
  }
  const rel = releaseClaimEx(key, sessionId);
  for (const c of rel.claims) {
    if (c.markerOk === true) {
      journalInternalWrite(key, { sessionId: c.sid, taskId: c.taskId, targets: [c.markerPath] });
    } else {
      process.stderr.write(`routing-declare：提示——release 后占位 released 标记失败（${c.markerPath}）：${c.error ?? 'unknown'}\n`);
    }
  }
  const released = rel.released;
  process.stdout.write(`已释放 ${released} 项（task-id 占用/激活租约/指针；${scopeNote}）\n`);
  process.exit(0);
}

/** 占用源集版本（内部决策-061 D8.2，内部任务-227）：源清单/语义变更时随批升级。 */
const OCCUPANCY_SOURCE_SET_VERSION = 'occupancy-sources-v5';

/**
 * 取号查询模式（内部未决-76＋内部决策-045）：--suggest-task-id [--domain <域码>] [--maintainer <维护者码>]
 * [--project-root <仓根>]——取号数据源七源按域（＋维护者段上下文）给建议号（多域仓逐域各一，
 * 携带域描述时附注——坑7）；零域态经默认域兜底恒有建议（内部任务-75）；注册表在场且本地指针有效时
 * 建议自动带维护者段（三段形态）；域/注册表损坏输出警示；均退 0（查询面教育可见，不失败）。
 * @param {string|undefined} domainRaw @param {string|undefined} projectRootRaw @param {string|undefined} maintainerRaw
 */
function suggestTaskIdMode(domainRaw, projectRootRaw, maintainerRaw) {
  let key;
  try {
    key = resolveDeclareKey(projectRootRaw);
  } catch (e) {
    process.stderr.write(`routing-declare：${e.message}\n`);
    process.exit(1);
  }
  const opts = {};
  if (domainRaw !== undefined) opts.domain = domainRaw;
  if (maintainerRaw !== undefined) opts.maintainer = maintainerRaw;
  const sug = suggestedTaskId(key, opts);
  if (sug.ok) {
    for (const s of sug.suggestions) {
      process.stdout.write(`建议任务号：${s.taskId}（域 ${s.domain}${s.description ? '：' + s.description : ''}）\n`);
    }
    // 内部决策-061 D8.2（内部任务-227）：查询面恒输出逐源状态（ok/absent/degraded）＋源集版本。
    const domainForSummary = opts.domain !== undefined ? String(opts.domain).toUpperCase() : (sug.suggestions[0]?.domain ?? null);
    if (domainForSummary !== null) {
      // 内部任务-244 P06：复用 suggestedTaskId 随建议号返回的 bySource（原二次 occ 全扫已删）。
      const bySource = sug.suggestions.find((s) => s.domain === domainForSummary)?.bySource ?? {};
      const srcLine = OCCUPANCY_ALL_SOURCES.map((src) => `${src}:${Object.hasOwn(bySource, src) ? 'ok' : 'absent'}`).join('、');
      process.stdout.write(`占用源：${srcLine}｜源集版本=${OCCUPANCY_SOURCE_SET_VERSION}（ADR-061 D8.2）\n`);
    }
    // 内部任务-75/IMP-4：默认域兜底生效时附注定制指引（旧「零域教育指引」的教育面在此保留）。
    // 内部决策-050 D3（内部任务-62）：升级为两途引导（自建样例/授权代建），经 DOMAINS_SETUP_HINT
    // 单源（三挂点同文案），visibilityHints 承载去重窗。
    if (sug.usedDefaultDomains) {
      process.stdout.write(DOMAINS_SETUP_HINT + '\n');
      visibilityHints(key); // 查询面触发即记账去重窗（与另两挂点共享）
    }
  } else if (Array.isArray(sug.degraded) && sug.degraded.length > 0) {
    // 内部决策-061 D5（内部任务-227）：degraded 时禁止内联任何具体号——输出「取号暂不可得」＋来源清单＋
    // 最近 ≤3 条降级摘要（查询面可诊断性）。
    process.stdout.write(`取号暂不可得（占用源降级：${sug.degraded.map((d) => d.source).join('/')}）——请稍后重试或排查来源后复查\n`);
    // 内部决策-061 D8.2：degraded 分支同样输出源集版本（跨安装对拍锚），避免「最需要清单时缺席」。
    process.stdout.write(`占用源降级：${[...new Set(sug.degraded.map((d) => d.source))].join('/')}｜源集版本=${OCCUPANCY_SOURCE_SET_VERSION}（ADR-061 D8.2）\n`);
    // 内部任务-244 遗留项⑥（内部未决-183④）：degraded 分支补**逐源 presence 清单**（present/absent/degraded），
    // 与 ok 分支逐源状态行同源（OCCUPANCY_ALL_SOURCES 单源），便于定位失败源与缺失源。
    if (sug.presence && typeof sug.presence === 'object') {
      for (const [dom, pres] of Object.entries(sug.presence)) {
        const line = OCCUPANCY_ALL_SOURCES.map((src) => `${src}:${pres[src] ?? 'unknown'}`).join('、');
        process.stdout.write(`逐源 presence（${dom}）：${line}\n`);
      }
    }
    const recent = readRecentDegraded(key, 3);
    if (recent.length > 0) {
      process.stdout.write(`最近降级记录（≤${recent.length} 条）：${recent.map((r) => `${new Date(r.ts).toISOString()}[${r.sources.join('/')}]`).join('；')}\n`);
    }
  } else {
    process.stdout.write(`${sug.hint}\n`);
  }
  warnBrokenDomains(key);
  warnBrokenMaintainers(key); // 内部决策-045/内部任务-96
  process.exit(0);
}

/**
 * 错配诊断文案（FB-1 批次）：「挑战与本项目不匹配」时报错给出「当前声明键 vs 挑战所属仓」
 * 双键对照与可复制示例命令（homeKey 反查不到时省略对照给占位指引，主信息不缺）。
 * 纯函数、字面量可被 selftest 断言（删行即红）。
 * @param {string} key 当前声明键（cwd 或 --project-root 推导）
 * @param {string|null} homeKey 挑战所属仓键（challengeHomeKey 反查结果）
 * @param {{ skill: string, leaseId: string, taskId: string, script: string }} ctx 示例命令上下文
 * @returns {string} 诊断文案段（多行，各带缩进）
 */
function mismatchDiagnostic(key, homeKey, ctx) {
  // 内部任务-20 A2/F6：旧「回到签发域」正解句**废止**——回到签发域并不解锁兄弟域写面（A2 简报 F6
  // 现场描述，已回本仓源码核实：挑战只对签发侧可见的键签发，工作区外的兄弟域永远拿不到挑战）。
  // 跨域写面走**两步通道**（内部决策-018 修正案）：请求（--request-domain）→ 签发侧并入该目标键 →
  // 按下一轮注入行声明（声明侧零改动）。同仓场景仍以「cd 到该仓 / --project-root 指向该仓」为
  // 正解——那是**键推导面**，与跨域通道是两件事，不得混为一谈。
  const target = homeKey ?? '<挑战所属仓根>';
  const channel =
    `  三种处置：\n` +
    `  ① 令牌取自本仓租约行（键推导面）：cd 到该仓目录重试，或 --project-root '${target}' 声明；\n` +
    `  ② 目标是工作区外的兄弟域（跨域通道，两步）：先登记请求，再按下一轮注入的租约行声明——\n` +
    `     node '${ctx.script}' --request-domain '<目标域根>' --lease ${ctx.leaseId} --project-root '${key}'\n` +
    `     请求不含令牌、不激活租约、不改闸；签发侧下一轮把目标域租约行并入注入面（多仓多行形态）。\n` +
    `  ③ 令牌已轮换/过期：用本会话最新一轮注入行里的令牌重试。\n`;
  if (homeKey) {
    return `当前声明键「${key}」vs 挑战所属仓「${homeKey}」。\n${channel}`;
  }
  return `当前声明键「${key}」（无法反查挑战所属仓——token 索引不可读）。\n${channel}`;
}

/**
 * 声明成功输出的「读正文」指针行（2026-09-16 使用反馈批次 P1）——租约只证明
 * 「查表已执行」，入口 skill 的强制条款全文在正文；此处纯指针、不逐 skill 枚举
 * 索引（索引会腐化），不转述判据（防双写漂移，learnings 2026-09-14 同款口径）。
 * @param {string} skill 声明的命中 skill 名
 * @returns {string} 指针行（含行尾换行）
 */
function nextStepHintLine(skill) {
  return `【下一步】读 skills/${skill}/SKILL.md 正文再动手——声明只完成路由判定，不替代读正文；强制条款在正文（如 plan-execution 的模式选择/检查点/长任务阶段复审节）。\n`;
}

/** 规划阶段 skill（声明激活即受闸侧固定写面上界约束，内部规则-16） */
const PLANNING_STAGE_SKILLS = new Set(['plan-writing', 'plan-review']);

/**
 * 声明确认语的写操作许可短语（内部任务-5 契约A，2026-10-06）：规划阶段不得无条件承诺
 * 「Bash/Edit/Write 放行」——该阶段 Edit/Write 受 PLAN_DIRS 固定上界，许可按当前
 * 阶段与写面判定；非规划 skill 维持原三类放行语义（守卫面，向后兼容不动）。
 * @param {string} skill 声明的命中 skill 名
 * @returns {string} 许可短语
 */
function permitPhrase(skill) {
  return PLANNING_STAGE_SKILLS.has(skill) ? '写操作按当前阶段与写面判定' : 'Bash/Edit/Write 放行';
}

/**
 * 规划阶段固定许可行（内部任务-5 契约A，内部规则-16）：plan-writing/plan-review 声明成功输出
 * 附阶段产物边界说明——Edit/Write 仅限 docs/plans（含历史目录 docs/superpowers/plans）
 * 下的过程 Markdown，Bash 不受此判定（非 shell 沙箱，仍走整闸）。纯提示行，不改变
 * 闸侧行为（固定上界执法在 routing-gate.mjs authoringViolation），无 schema/参数变化。
 * @param {string} skill 声明的命中 skill 名
 * @returns {string} 阶段许可行（含行尾换行）；非规划 skill 返回空串
 */
function activationPermitNote(skill) {
  if (!PLANNING_STAGE_SKILLS.has(skill)) return '';
  return (
    '【规划阶段许可】本阶段 Edit/Write 仅限 docs/plans（含历史目录 docs/superpowers/plans）下的过程 Markdown（.md）文档；' +
    'Bash 不受此判定（非 shell 沙箱，仍走整闸）。修改其余受控资产须待 plan-execution 阶段持已评审计划进行。\n'
  );
}

/**
 * 本仓的 git 祖先仓键链（P9b）：补签留痕可能落在祖先仓，自愈须连带清理。
 * 只上溯含 .git 的目录（不含起点自身），到文件系统根即止；不可读目录跳过。
 * @param {string} key 项目键（仓根绝对路径）
 * @returns {string[]} 祖先仓根列表（由近及远）
 */
function ancestorRepoKeys(key) {
  const out = [];
  let dir = dirname(resolve(key));
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (existsSync(join(dir, '.git'))) out.push(dir);
  }
  return out;
}

/**
 * 主入口：解析参数 → 补签子命令分流 → 前置校验（plan-execution 须显式计划 + v2 凭据）→ 激活租约 → 确认与 learnings 检索指引。
 * @returns {void}
 */
/**
 * 状态根不可写时的**三分支可执行文案**（内部任务-20 A2/F7，plan-review 非阻塞 3 处置）：
 * 每分支都带**可执行命令 + 适用条件**——只给"提权/调整策略"这类人的动作，等于把用户留在
 * 死结里；`--init-state-dir` 与 `--request-domain` 两处共用本助手（同一份文案，防两写漂移）。
 * @param {string} script 本脚本路径（生成可复制命令）
 * @param {string} root 目标项目根
 * @returns {string} 多行文案
 */
function stateRootBranches(script, root) {
  const slash = root.replaceAll('\\', '/');
  return (
    `  三分支（按适用条件择一）：\n` +
    `  ① 项目内可写、只是目录形态被占（如 .workflow 已存在同名文件）：清理占位后重跑本命令 ——\n` +
    `     node '${script}' --init-state-dir --project-root '${slash}'\n` +
    `  ② 宿主策略可改（提权 / 放宽 workspace 写面）：调整后**重跑上一条命令**（人工动作，无自动命令）。\n` +
    `  ③ 只求先跑通：退回用户级根 —— 删除 "${slash}/.workflow/routing.json"，或设环境变量\n` +
    `     WF_ROUTING_STATE_DIR=<某个可写目录> 后重跑本命令。\n`
  );
}

/**
 * `--init-state-dir`（内部任务-20 A2/F7，内部决策-040 修正案 1）：把项目显式 opt-in 到项目内状态根。
 * 判据＝**激活域根**（`activationRoot(target) !== null`，即 `gitAncestor ?? markerAncestor`；
 * **不得**用 `repoDomains`——那是 `内部工作流状态` 的域声明集）；幂等由
 * `initProjectStateRoot` 保证（记号已合法则跳过写、不覆盖）。失败一律退 2 并给可执行分支。
 * @param {string|undefined} projectRootRaw `--project-root` 取值（缺省 cwd）
 * @returns {never} 直接 process.exit
 */
function initStateDir(projectRootRaw) {
  const target = resolve(typeof projectRootRaw === 'string' && projectRootRaw ? projectRootRaw : process.cwd());
  if (activationRoot(target) === null) {
    process.stderr.write(
      `--init-state-dir：${target} 不在激活域（无 .git 祖先、无标记根）——激活域判据＝gitAncestor ?? markerAncestor；请在该域内执行，或先接入 .sdd/ 或 .scout/mode.json 标记根。\n`,
    );
    process.exit(2);
  }
  // 运行态可见告警（内部决策-040 §7 第 6 条：非法记号回落**并可见告警**）——此前只在测试里直调渲染器，
  // 运行路径零输出（收尾评审非阻塞 3 / 收紧版 §4-D）。
  const cfg = readProjectRoutingConfig(canonicalRoot(target));
  if (!cfg.ok && cfg.reason !== 'absent') process.stderr.write(`${stateRootDiagnostic(target, cfg)}\n`);
  const res = initProjectStateRoot(target);
  if (!res.ok) {
    // 写失败与「记号非法」是两件事：不得用 stateRootDiagnostic 渲染（会把操作者引向删一个不存在的
    // routing.json——收紧版评审文案项 D）。
    process.stderr.write(`【workflow 状态根】状态根写入失败（项目记号本身校验通过）：${res.error}\n`);
    process.stderr.write(stateRootBranches(process.argv[1], target));
    process.exit(2);
  }
  process.stdout.write(`已启用项目级状态根：${res.root}${res.already ? '（记号已存在，幂等跳过）' : ''}\n`);
  process.exit(0);
}

/**
 * `--request-domain <目标域根>`（内部任务-20 A2/F6，内部决策-018 修正案）：跨域声明两步通道的**第一跳**——
 * 登记一次请求（不含令牌、不激活租约、不改闸）。会话绑定经 **capability 反查**：请求方提交自己的
 * 租约令牌（`--lease`），由 `challengeOwnerInfo` 得 `{projectKey, sessionId, host}`；无令牌或反查
 * 不到会话一律拒（null 桶＝共享桶，不得借它跨会话可见）。目标键与声明路径**同源**
 * （`projectKey(resolve(target))`），目标须过激活域根判据（`activationRoot !== null`）。
 * 上限＝`DOMAIN_REQUEST_MAX`（在册未授予且未过期者计）；超出退 2 并列在册请求。
 * @param {string|undefined} targetRaw 目标域根
 * @param {string|undefined} leaseId 请求方租约令牌
 * @param {string|undefined} projectRootRaw 请求方仓根（缺省 cwd）
 * @returns {never} 直接 process.exit
 */
function requestDomainMode(targetRaw, leaseId, projectRootRaw) {
  const ownerRoot = resolve(typeof projectRootRaw === 'string' && projectRootRaw ? projectRootRaw : process.cwd());
  const ownerKey = projectKey(ownerRoot);
  if (typeof leaseId !== 'string' || !leaseId) {
    process.stderr.write(
      '--request-domain：须附本会话租约令牌（--lease <令牌>）——请求的会话绑定经 capability 反查（Bash 侧无会话标识，ADR-018）；先完成一次声明取得租约，或从注入的租约行复制令牌后重试。\n',
    );
    process.exit(2);
  }
  const owner = challengeOwnerInfo(leaseId, ownerKey);
  if (!owner || !owner.sessionId) {
    process.stderr.write('--request-domain：令牌无法反查会话（未签发 / 已轮换清理 / 已过期）——空会话请求一律拒（null 桶＝共享桶，不得借它跨会话可见）；请重新声明取得新令牌后重试。\n');
    process.exit(2);
  }
  const target = resolve(String(targetRaw ?? ''));
  if (activationRoot(target) === null) {
    process.stderr.write(`--request-domain：${target} 不在激活域（无 .git 祖先、无标记根）——激活域判据＝gitAncestor ?? markerAncestor。\n`);
    process.exit(2);
  }
  // 运行态可见告警（同 initStateDir：记号非法即回落默认根，但不得静默）
  const ownerCfg = readProjectRoutingConfig(canonicalRoot(ownerRoot));
  if (!ownerCfg.ok && ownerCfg.reason !== 'absent') process.stderr.write(`${stateRootDiagnostic(ownerRoot, ownerCfg)}\n`);
  const pending = readDomainRequests(ownerKey, { sessionId: owner.sessionId, host: owner.host }).filter((r) => !r.granted);
  if (pending.length >= DOMAIN_REQUEST_MAX) {
    process.stderr.write(
      `--request-domain：本会话在册请求已达上限 ${DOMAIN_REQUEST_MAX}（${pending.map((r) => r.targetKey).join('、')}）——先让已有请求被签发（下一轮用户消息后按注入行声明），或等待其过期（TTL ${Math.round(DOMAIN_REQUEST_TTL_MS / 60000)} 分钟）。\n`,
    );
    process.exit(2);
  }
  const w = writeDomainRequest({ key: ownerKey, targetKey: projectKey(target), targetRoot: target, sessionId: owner.sessionId, host: owner.host });
  if (!w.ok) {
    process.stderr.write(`【workflow 状态根】跨域请求写入失败（项目记号本身校验通过）：${w.error}\n`);
    process.stderr.write(stateRootBranches(process.argv[1], ownerRoot));
    process.exit(2);
  }
  process.stdout.write(
    `已登记跨域请求：${w.record.targetKey}（请求不含令牌、不激活租约、不改闸）\n三步通道：①本条已登记 → ②下一轮用户消息后，签发侧把该目标域的租约行注入（沿用多仓多行形态）→ ③按注入行原样声明即可（声明侧零改动）。\n`,
  );
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const selftestFlag = args.includes('--selftest');
  if (selftestFlag) return; // 由直接调用层处理
  const reissueTarget = opt(args, '--bootstrap-reissue');
  if (reissueTarget !== undefined) {
    // 内部任务-348/内部未决-214②：补签旗标与状态写子命令互斥——共见时静默走补签会遮蔽他子命令
    //（如 --release --bootstrap-reissue X 会静默丢弃释放意图）。共存即报错退 2。
    const conflicts = ['--release', '--init-state-dir', '--request-domain', '--suggest-task-id'].filter((f) => args.includes(f));
    if (conflicts.length > 0) {
      process.stderr.write(`--bootstrap-reissue 与 ${conflicts.join('、')} 互斥（补签只做挑战补签，不做状态写）——请分开执行\n`);
      process.exit(2);
    }
    return bootstrapReissue(reissueTarget);
  }
  if (args.includes('--suggest-task-id')) return suggestTaskIdMode(opt(args, '--domain'), opt(args, '--project-root'), opt(args, '--maintainer'));
  // 释放模式（内部任务-8 任务 4.5；内部任务-24 D2 三作用域）：作用域旗标取值在此集中构造，
  // releaseMode 内做择一/互斥判定——正常生命周期事件，零 incident
  if (args.includes('--release')) {
    return releaseMode(opt(args, '--project-root'), {
      lease: opt(args, '--lease'),
      session: opt(args, '--session'),
      allSessions: args.includes('--all-sessions'),
    });
  }
  // 项目级状态根初始化（内部任务-20 A2/F7，内部决策-040 修正案 1）：纯旗标；先过激活域判据，
  // 再走单点原语 `initProjectStateRoot`（幂等）；失败给三分支文案并退 2。
  if (args.includes('--init-state-dir')) return initStateDir(opt(args, '--project-root'));
  // 跨域请求（内部任务-20 A2/F6）：两步通道第一跳——登记请求（不含令牌、不激活租约、不改闸）。
  if (args.includes('--request-domain')) return requestDomainMode(opt(args, '--request-domain'), opt(args, '--lease'), opt(args, '--project-root'));
  const skill = firstPositionalArg(args);
  const leaseId = opt(args, '--lease');
  const taskIdRaw = opt(args, '--task-id');
  const plan = opt(args, '--plan');
  const planRoot = opt(args, '--plan-root');
  const projectRoot = opt(args, '--project-root');
  const exempt = opt(args, '--exempt');
  const exemptSrc = opt(args, '--exempt-src');
  const exemptScope = opt(args, '--exempt-scope');
  const exemptRevoke = args.includes('--exempt-revoke');
  if (args.includes('--exempt-scope') && (exemptScope === undefined || String(exemptScope).startsWith('--'))) {
    process.stderr.write('routing-declare：--exempt-scope 缺值（须为 plan 或 review）。\n' + USAGE + '\n');
    process.exit(1);
  }
  const changeScopeRaw = opt(args, '--change-scope');
  const scriptWriteCollected = collectStrict(args, '--script-write');
  // 内部决策-066 修正案 1 内部模块-2（内部任务-285）：更窄声明级别——受检路径的 C2/C3/C4 脚本编辑放行依据。
  const scriptEditCollected = collectStrict(args, '--script-edit-code');
  const projectSkillCollected = collectStrict(args, '--project-skill');
  // 内部决策-061 D5/D6（内部任务-227）：受控人工通道与续任务通道——--manual-task-id 可替代 --task-id
  // 作为声明目标号（仍过撞号/历史占用校验；degraded 时 reason 须「用户授权：」前缀）。
  const manualTaskId = opt(args, '--manual-task-id');
  const manualReason = opt(args, '--manual-reason');
  const resumeTask = args.includes('--resume-task');
  const resumeReason = opt(args, '--resume-reason');
  const manualMode = manualTaskId !== undefined || manualReason !== undefined;
  const taskId = manualTaskId !== undefined ? manualTaskId : taskIdRaw;
  // 内部决策-061 修正案 1 第 3 条（内部任务-227）：manual/resume 旗标成对且理由 ≥8 字——参数面错误退 2
  //（与用法错误同档，不进入声明流程；库层亦复验，双保险）。
  if (manualMode && String(manualReason ?? '').trim().length < 8) {
    process.stderr.write('routing-declare：--manual-task-id/--manual-reason 须成对使用且 --manual-reason ≥8 字（人工指定号须由人裁决，模型不得自行编造）。\n');
    process.exit(2);
  }
  if (resumeTask && String(resumeReason ?? '').trim().length < 8) {
    process.stderr.write('routing-declare：--resume-task 须成对携带 --resume-reason（≥8 字，说明续用依据）。\n');
    process.exit(2);
  }

  if (!skill || !SKILL_NAME_RE.test(skill)) {
    process.stderr.write(`routing-declare：参数非法（收到 skill「${skill}」）\n${USAGE}\n`);
    process.exit(1);
  }
  // 成员校验（2026-09-15 激活域批次，内部决策-022；2026-10-10 内部任务-29 P4 扩衔接集）：声明名
  // 必须命中路由表入口集合、跨插件衔接集或保留名 ad-hoc——B-M1-1「禁止第二判定源」
  // 在执行面的机械兜底，拒时按三组列全部候选（deny 即用法教育位）。
  if (!isDeclarableSkill(skill)) {
    const candidates = [...ROUTING_ENTRY_SKILLS].sort();
    const bridging = [...BRIDGING_ENTRY_SKILLS].sort();
    process.stderr.write(
      `routing-declare：「${skill}」不在可声明集内——先查 workflow 元技能的路由表并唯一命中一行再声明。\n` +
        `候选分三组——表内入口（${candidates.length} 个）：${candidates.join('、')}；跨插件衔接 skill（声明须凭 --via <表内入口> 标注来源行）：${bridging.join('、')}；保留名两道：${AD_HOC}＝状态型操作 / ${AD_HOC_DELIVERABLE}＝制品型交付〔完成链含类型匹配评审〕（均为非开发任务显式绕行，不可用于开发任务）。\n${USAGE}\n`,
    );
    process.exit(1);
  }
  // P4（2026-10-10 内部任务-29 / 内部任务-103 P4）：跨插件衔接 skill 须凭 --via <表内入口> 溯源
  // 声明——路由表仍是唯一判定入口（B-M1-1），衔接 skill 不设路由行，via 记录来源路由
  // 行入租约供审计；via 不是通用注记位，表内入口/ad-hoc 携带 via 即拒（防滥用面）。
  const via = opt(args, '--via');
  if (isBridgingSkill(skill)) {
    if (typeof via !== 'string' || !via.trim()) {
      process.stderr.write(
        `routing-declare：跨插件衔接 skill「${skill}」声明必须带 --via <表内入口>（来源路由行标注，入租约供审计）——如 --via brainstorming。\n${USAGE}\n`,
      );
      process.exit(1);
    }
    if (!ROUTING_ENTRY_SKILLS.has(via)) {
      process.stderr.write(
        `routing-declare：--via 值「${via}」不是表内入口（合法取值：${[...ROUTING_ENTRY_SKILLS].sort().join('、')}）。\n${USAGE}\n`,
      );
      process.exit(1);
    }
  } else if (via !== undefined) {
    process.stderr.write('routing-declare：--via 仅用于跨插件衔接 skill 的来源行标注，表内入口与 ad-hoc 声明不适用。\n');
    process.exit(1);
  }
  if (!leaseId || !/^[0-9a-f]{16,}$/.test(leaseId)) {
    process.stderr.write(
      'routing-declare：缺少或非法 --lease——leaseId 取自本轮 UserPromptSubmit 注入的【workflow 任务租约】行（prompt 轮换后旧值失效，请用最新一轮）。\n' + USAGE + '\n',
    );
    process.exit(1);
  }
  if (!taskId || !TASK_ID_RE.test(taskId)) {
    process.stderr.write(
      `routing-declare：缺少或非法 --task-id（收到「${taskId ?? ''}」）——任务号为域前缀形态 <域码>-<序号>（默认，如 DEV-1）或 <域码>-<维护者码>-<序号>（ADR-045 三段，如 DEV-WP-1；旧 TASK- 系形态不再接受），本仓建议号经 --suggest-task-id 查询。\n${USAGE}\n`,
    );
    process.exit(1);
  }
  const hasExempt = exempt !== undefined;
  if (exemptScope !== undefined && !hasExempt) {
    process.stderr.write('routing-declare：--exempt-scope 必须与 --exempt 同时使用（豁免范围只对显式豁免有意义）。\n');
    process.exit(1);
  }
  if (hasExempt && skill !== 'plan-execution') {
    process.stderr.write('routing-declare：--exempt 仅用于 plan-execution 的已评审计划前置豁免，其他 skill 不适用。\n');
    process.exit(1);
  }
  if (exemptRevoke && skill !== 'plan-execution') {
    process.stderr.write('routing-declare：--exempt-revoke 仅用于 plan-execution。\n');
    process.exit(1);
  }
  if (hasExempt && !exempt.trim()) {
    process.stderr.write('routing-declare：豁免引文/撤销原话必须非空（显式豁免要留痕，空引文不构成豁免）。\n');
    process.exit(1);
  }
  if (exemptSrc !== undefined && !hasExempt) {
    process.stderr.write('routing-declare：--exempt-src 必须与 --exempt 同时使用（来源标注只对显式豁免/退役有意义）。\n');
    process.exit(1);
  }
  if (hasExempt && !EXEMPT_SOURCES.includes(exemptSrc)) {
    process.stderr.write(
      `routing-declare：--exempt 必须同时标注来源 --exempt-src（收到「${exemptSrc ?? ''}」）——` +
        `合法取值 ${EXEMPT_SOURCES.join('|')}：user=用户当轮消息原文，preauthorized=事前授权已显式记录（先例不构成豁免来源）。\n`,
    );
    process.exit(1);
  }
  if (exemptRevoke) {
    if (exemptScope !== undefined) {
      process.stderr.write('routing-declare：--exempt-revoke 不允许同时给 --exempt-scope（退役不是豁免声明）。\n');
      process.exit(1);
    }
    if (!plan) {
      process.stderr.write('routing-declare：--exempt-revoke 必须给 --plan <同任务已评审计划>（退役前置＝正规计划链已就位）。\n');
      process.exit(1);
    }
    if (planRoot !== undefined) {
      process.stderr.write('routing-declare：--exempt-revoke 不支持 --plan-root（跨仓退役不纳入本批）。\n');
      process.exit(1);
    }
    if (args.includes('--resume-task')) {
      process.stderr.write('routing-declare：--exempt-revoke 不支持 --resume-task（退役是任务级治理动作，由任务持有者执行）。\n');
      process.exit(1);
    }
    const rq = checkExemptRevokeQuote(exempt);
    if (!rq.ok) {
      process.stderr.write(`routing-declare：--exempt-revoke 被拒——${rq.reason}。\n`);
      process.exit(1);
    }
  } else if (hasExempt) {
    const shape = checkExemptDeclarationShape({
      skill,
      exempt,
      scope: exemptScope,
      hasPlan: !!plan,
      hasPlanRoot: planRoot !== undefined,
    });
    if (!shape.ok) {
      process.stderr.write(`routing-declare：--exempt 被拒——${shape.reason}。\n${USAGE}\n`);
      process.exit(1);
    }
  }
  // 写面声明：JSON 字符串数组 → 库级规范化复验（非法即 exit 1 附原因，失败可见）
  let scopeEntries;
  if (changeScopeRaw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(changeScopeRaw);
    } catch {
      process.stderr.write('routing-declare：--change-scope 必须是 JSON 字符串数组（如 \'["docs/plans",…]\'）。\n');
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write('routing-declare：--change-scope 必须是 JSON 字符串数组（收到非数组 JSON）。\n');
      process.exit(1);
    }
    try {
      scopeEntries = normalizeScopeEntries(parsed);
    } catch (e) {
      process.stderr.write(`routing-declare：--change-scope 非法——${e.message}。\n`);
      process.exit(1);
    }
  }
  // 脚本声明双通道（内部决策-066 D3＋修正案 1 内部模块-2；内部任务-348/内部未决-254⑤ 参数化单源）：
  // 理由 trim 后 ≥8 字；缺值/非法即 exit 1（内部模块-8 §2 契约），合法则随激活入对应租约字段
  // 并追加对应审计文件（库层复验单源）。两通道共用本 helper（旗标名/字段名/审计文件名三参）。
  const declareScriptChannel = ({ flag, field, auditFile, collected, normalize }) => {
    if (collected.error) {
      process.stderr.write(`routing-declare：${collected.error}；理由须 ≥8 字，并将入租约 ${field}[] 与 ${auditFile} 审计。\n`);
      process.exit(1);
    }
    if (collected.values.length > 0) {
      try {
        return normalize(collected.values);
      } catch (e) {
        process.stderr.write(`routing-declare：${flag} 非法——${e.message}；理由入租约 ${field}[] 与 ${auditFile} 审计。\n`);
        process.exit(1);
      }
    }
    return undefined;
  };
  const scriptWrites = declareScriptChannel({
    flag: '--script-write', field: 'scriptWrites', auditFile: 'wf-script-writes.jsonl',
    collected: scriptWriteCollected, normalize: normalizeScriptWrites,
  });
  const scriptEditCode = declareScriptChannel({
    flag: '--script-edit-code', field: 'scriptEditCode', auditFile: 'wf-script-edits.jsonl',
    collected: scriptEditCollected, normalize: normalizeScriptEditCode,
  });

  // 键推导（FB-1 批次）：--project-root 显式目标仓根解 cwd 耦合（双仓工作区从主仓目录
  // 直接声明文档仓租约）；非法值失败可见（exit 1），缺省维持 cwd 推导
  let key;
  try {
    key = resolveDeclareKey(projectRoot);
  } catch (e) {
    process.stderr.write(`routing-declare：${e.message}\n${USAGE}\n`);
    process.exit(1);
  }
  let planInfo;
  if (skill === 'plan-execution' && exempt === undefined) {
    if (!plan) {
      process.stderr.write(
        'routing-declare：声明 plan-execution 必须显式 --plan <docs/plans/下计划路径>（R-M3-10：凭据绑定具体计划，不再扫描任意通过记录）。\n' + USAGE + '\n',
      );
      process.exit(1);
    }
    const proof = verifyReviewedPlan(key, plan, taskId, planRoot ?? null);
    if (!proof.ok) {
      const surface = proof.surface;
      const surfaceLine = surface
        ? `  改动面：${surface.steps} 步 / ${surface.files} 文件 / ${surface.newModules} 新模块${surface.overThreshold ? '（超阈值）' : ''}。\n`
        : '';
      const exemptLine = proof.reason.includes('--exempt')
        ? ''
        : '  宿主无子代理能力时用 --exempt "<逐字引文>" --exempt-scope plan|review --exempt-src user|preauthorized（留痕可审计，不构成 full 完成链）。\n';
      const overThresholdLine = surface?.overThreshold
        ? '  超阈值实现类计划须 reviewMode=independent（≥2 fresh-context 实例）或拆小；超阈值不适用追认档（ratified 仅低阈值）。\n'
        : '';
      process.stderr.write(
        `routing-declare：声明 plan-execution 被拒——${proof.reason}。\n` +
        '  先走 plan-writing 落盘 → plan-review 评审（v2 sidecar：taskId/planPath/planSha256/reviewMode/reviewInstances/reviewReason +「结论：通过」；独立/mixed 须 v3：另加 reviewRound/reviewProvenance，实例 chain 须等于 plan:<计划路径>）；\n' +
        surfaceLine +
        overThresholdLine +
        exemptLine +
        '  评审通过后计划再被修改即须重审。\n',
      );
      process.exit(1);
    }
    planInfo = { planPath: plan, planSha256: proof.planSha256 };
  } else if (exemptRevoke) {
    const normPlan = normalizePlanRelPath(plan);
    if (!normPlan.ok) {
      process.stderr.write(`routing-declare：退役计划路径非法——${normPlan.reason}。\n${USAGE}\n`);
      process.exit(1);
    }
    const proof = verifyReviewedPlan(key, normPlan.planRel, taskId, null);
    if (!proof.ok) {
      process.stderr.write(`routing-declare：--exempt-revoke 的计划未过评审——${proof.reason}。退役前置＝同任务已评审计划。\n`);
      process.exit(1);
    }
    planInfo = { planPath: normPlan.planRel, planSha256: proof.planSha256 };
  } else if (exempt !== undefined && exemptScope === 'review') {
    const resolved = resolveDeclaredPlan(key, plan);
    if (!resolved.ok) {
      process.stderr.write(`routing-declare：--exempt-scope review 的计划不可用——${resolved.reason}。\n${USAGE}\n`);
      process.exit(1);
    }
    const marker = findExemptQuoteLine(resolved.text);
    if (marker.conflict) {
      process.stderr.write('routing-declare：计划含多条值不同的 `豁免引文：` 行（歧义）——请只保留与用户原话一致的一行。\n');
      process.exit(1);
    }
    if (!marker.found) {
      process.stderr.write('routing-declare：--exempt-scope review 的计划正文缺少 `豁免引文：<用户原话>` 行（围栏外）。\n');
      process.exit(1);
    }
    if (!exemptionQuoteMatches(marker.quote, exempt.trim())) {
      process.stderr.write('routing-declare：计划 `豁免引文：` 行与 --exempt 原话不一致——请逐字复制用户原话。\n');
      process.exit(1);
    }
    planInfo = { planPath: resolved.planRel, planSha256: resolved.planSha256 };
  }

  // 内部决策-070 D4（内部任务-341）：项目 skill 消费义务——必载集合校验、预 ack、继承父覆盖项与陈旧探针
  let projectSkills;
  {
    if (projectSkillCollected.error) {
      process.stderr.write(`routing-declare：${projectSkillCollected.error}；项目 skill ack 形如 --project-skill <name>（可重复）。\n`);
      process.exit(1);
    }
    const requested = projectSkillCollected.values;
    for (const name of requested) {
      if (!SKILL_NAME_RE.test(name)) {
        process.stderr.write(`routing-declare：--project-skill 名非法：${name}（须匹配 ${SKILL_NAME_RE.source}）。\n`);
        process.exit(1);
      }
    }
    let sourceInfo;
    let manifestInfo;
    try {
      sourceInfo = requiredProjectSkillsFromSource({ projectRoot: key, env: process.env });
      manifestInfo = requiredProjectSkills({ projectRoot: key, env: process.env });
    } catch (e) {
      sourceInfo = { host: 'unknown', skills: [], required: [], errors: [String(e?.message ?? e)], rootErrors: [String(e?.message ?? e)] };
      manifestInfo = { required: [], advisory: [], source: 'scan-error', host: 'unknown', warning: String(e?.message ?? e) };
    }
    // 内部决策-070 §5.4/计划 §3：源扫描失败与清单损坏都必须可见（不得静默改变义务面）
    if (sourceInfo.rootErrors.length > 0) {
      process.stderr.write(`routing-declare：【项目 skill】源扫描失败（${sourceInfo.rootErrors.join('；')}），fail-open 回退清单。\n`);
    }
    if (manifestInfo.warning) {
      process.stderr.write(`routing-declare：【项目 skill】清单异常（${manifestInfo.warning}），按源解析。\n`);
    }
    const useSource = sourceInfo.rootErrors.length === 0;
    const required = useSource ? sourceInfo.required : manifestInfo.required;
    const candidates = useSource
      ? sourceInfo.skills
      : applicableSkills([...manifestInfo.required, ...(manifestInfo.advisory ?? [])], manifestInfo.host);
    if (useSource && sourceInfo.errors.length > 0) {
      process.stderr.write(`routing-declare：【项目 skill】部分条目解析失败（${sourceInfo.errors.join('；')}）——已保留可解析条目（ADR-070 §5.4）。\n`);
    }
    if (useSource && manifestInfo.source === 'manifest') {
      const src = sourceInfo.required.map((sk) => sk.name).sort().join('|');
      const man = manifestInfo.required.map((sk) => sk.name).sort().join('|');
      if (src !== man) {
        process.stderr.write('routing-declare：【项目 skill】清单陈旧（与源不一致），本次按源解析；请运行 node workflow/scripts/generate-project-skills-manifest.mjs --apply 刷新。\n');
      }
    }
    const known = new Map(candidates.map((sk) => [sk.name, sk]));
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      const list = candidates.map((sk) => `${sk.name}@${sk.root}`).join('、') || '（当前无可适用项目 skill）';
      process.stderr.write(`routing-declare：--project-skill 未知名：${unknown.join('、')}；当前可适用候选：${list}。\n`);
      process.exit(1);
    }
    let inheritedNames = [];
    try {
      const owner = challengeOwnerInfo(leaseId, key);
      if (owner && owner.parentSessionId) {
        const parent = readActiveLease(key, Date.now(), { sessionId: owner.parentSessionId });
        if (parent.valid && Array.isArray(parent.lease.projectSkills)) {
          inheritedNames = parent.lease.projectSkills.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean);
        }
      }
    } catch {
      /* 继承反查 fail-open：缺项按缺失处理（子可自行补 ack） */
    }
    const covered = new Set([...requested, ...inheritedNames]);
    const missing = required.filter((sk) => !covered.has(sk.name));
    if (missing.length > 0) {
      const names = required.map((sk) => sk.name);
      const flags = names.map((n) => `--project-skill ${n}`).join(' ');
      process.stderr.write(
        `routing-declare：项目 skill 必载集合未 ack：缺 ${missing.map((sk) => sk.name).join('、')}。\n` +
        `  必载集合：${names.join('、')}；先加载对应 SKILL.md（${required.map((sk) => sk.path).join('、')}）。\n` +
        `  修复：在声明命令追加 ${flags}（本令牌仍有效，可同轮改参数重声明）。\n`,
      );
      process.exit(1);
    }
    if (covered.size > 0) {
      const entries = [];
      for (const name of covered) {
        const hit = known.get(name);
        if (hit) entries.push({ name, root: hit.root });
      }
      if (entries.length > 0) projectSkills = entries;
    }
  }

  const act = activateLease(key, {
    leaseId,
    taskId,
    skill,
    ...(planInfo ?? {}),
    ...(typeof planRoot === 'string' && planRoot ? { planRoot } : {}),
    ...(hasExempt && !exemptRevoke ? { exempt: exempt.trim(), exemptSrc, exemptScope } : {}),
    ...(typeof via === 'string' && via ? { via } : {}),
    ...(scopeEntries !== undefined ? { changeScope: scopeEntries } : {}),
    ...(scriptWrites !== undefined ? { scriptWrites } : {}),
    ...(scriptEditCode !== undefined ? { scriptEditCode } : {}),
    ...(projectSkills !== undefined ? { projectSkills } : {}),
    ...(manualMode ? { manual: true, manualReason: manualReason ?? '' } : {}),
    ...(resumeTask ? { resume: true, resumeReason: resumeReason ?? '' } : {}),
  });
  if (!act.ok) {
    // 内部任务-342（内部决策-066 修正案 2 内部模块-3）：失败路径若已改写 claim/占位（active 落盘失败后的回滚会
    // markClaimReleased），同样必须补 internal journal 行——不得留空归因链（正确性维阶段 L #1）。
    if (act.claimMarkerWritten === true) {
      const chOwner = challengeOwnerInfo(leaseId, key);
      journalInternalWrite(key, {
        sessionId: chOwner && typeof chOwner.sessionId === 'string' && chOwner.sessionId ? chOwner.sessionId : null,
        taskId,
        targets: [`docs/plans/claims/${taskId}.json`],
      });
    }
    // 撞号阻断与域成员拒分流（内部未决-76）：两态令牌均无问题（换 task-id 才是出路），reason 已
    // 含各自指引——不得再附「请从最新一轮取 leaseId」误导句（同撞号裁决口径）。
    if (String(act.reason).startsWith('撞号阻断')) {
      process.stderr.write(`routing-declare：${act.reason}\n`);
      process.exit(1);
    }
    if (String(act.reason).includes('域不在本仓域集')) {
      process.stderr.write(`routing-declare：${act.reason}\n（取号口径与声明一致：--suggest-task-id 查询本仓可用的域与建议号）\n`);
      process.exit(1);
    }
    // FB-1 批次：错配（令牌属其他仓）从「请重试」升级为双键对照 + 可复制示例命令——
    // 报错本身完成用法教育，不再要求操作者源码考古
    let detail = '';
    if (act.reason === LEASE_REASONS.PROJECT_MISMATCH) {
      const script = process.argv[1] ? process.argv[1].replaceAll('\\', '/') : '<插件根>/hooks/routing-declare.mjs';
      detail = mismatchDiagnostic(key, challengeHomeKey(leaseId, key), { skill, leaseId, taskId, script });
    }
    // 拒因分流（内部任务-227 约定维 #4＋正确性 delta #1）：委派绑定类禁同轮重声明；其余「令牌有效但
    // 语义拒」按各自出路处置（允许同轮改参数重声明，不得空等）。仅真正令牌面失败才提示重取。
    const delegatedReject = /委派会话/.test(String(act.reason));
    const semanticReject = /历史占用拒绝|人工指定号须由人裁决|--resume-task 须提供|占用集降级|taskId 非法|序号非法|维护者|skill 名非法|exempt|exempt-scope|exemptScope|exempt-revoke|引文|豁免范围|退役|changeScope 非法/.test(String(act.reason));
    const tail = delegatedReject
      ? '本令牌仍有效，按上述出路处置；不得在同一轮内再次声明。'
      : semanticReject
        ? '本令牌仍有效，按上述出路处置（可同轮改参数重声明）。'
        : '请从最新一轮用户消息的租约行取 leaseId 重试。';
    process.stderr.write(`routing-declare：租约激活失败——${act.reason}。${tail}\n${detail}`);
    process.exit(1);
  }
  // 占用登记写失败可见化（门禁实例1 F3：「零静默失败」义务）：声明仍生效（active 兜底），
  // 但占用保护降级——必须给出可行动提示（重跑声明即可重建 claim），不得无声。
  if (act.claimWritten === false && act.inherited !== true) {
    process.stderr.write(`routing-declare：${act.warning ?? '占用登记（claim）写盘失败'}\n`);
  }
  // 内部决策-066 D3（内部任务-261）：--script-write 审计逐条追加（写失败 stderr 警示、不阻断已激活租约）
  if (scriptWrites !== undefined) {
    const failed = [];
    for (const sw of scriptWrites) {
      const r = appendScriptWrite({ dir: stateRootFor(key), record: { taskId, skill, leaseId, projectKey: String(key), reason: sw.reason } });
      if (!r.ok) failed.push(r.reason);
    }
    if (failed.length > 0) process.stderr.write(`routing-declare：scriptWrites 审计写失败（不阻断已激活租约）：${failed.join('；')}\n`);
  }
  // 内部决策-066 修正案 1 内部模块-2（内部任务-285）：--script-edit-code 审计逐条追加（同款 fail-open 口径）。
  if (scriptEditCode !== undefined) {
    const failed = [];
    for (const se of scriptEditCode) {
      const r = appendScriptEdit({ dir: stateRootFor(key), record: { taskId, skill, leaseId, projectKey: String(key), reason: se.reason } });
      if (!r.ok) failed.push(r.reason);
    }
    if (failed.length > 0) process.stderr.write(`routing-declare：scriptEditCode 审计写失败（不阻断已激活租约）：${failed.join('；')}\n`);
  }
  // 内部决策-061 D4.3：继承声明不写 claim/占位（占用归父会话）——正向说明，不误报失败。
  if (act.inherited === true) {
    process.stdout.write(`routing-declare：继承声明生效——task-id=${taskId}（父会话 ${String(act.parentSessionId ?? '').slice(0, 8)}…）占用归父会话，本次不写 claim/占位。\n`);
  }
  if (manualMode) {
    process.stdout.write('routing-declare：已按人工通道受理——人工指定号须由人裁决，模型不得自行编造（manual=true 已入租约/占位/台账审计）。\n');
  }
  // 占位登记写失败可见化（内部决策-050 D1，内部任务-62）：同款「零静默失败」两档——占用退回机器
  // 本地 claim/active 兜底（TTL 内有效），跨机可见性缺席须让声明者知晓。
  // 内部决策-061 D4：继承声明不写 claim/claims 占位（占用归父），不产生该告警。
  if (act.claimMarkerWritten === false && act.inherited !== true) {
    process.stderr.write(`routing-declare：警告——git 同步面占位登记（docs/plans/claims/${taskId}.json）写盘失败：占用保护退回本机 claim/active（TTL 内有效），跨机占用不可见；重跑声明可重建占位。\n`);
  }
  // 内部决策-061 D5.5（内部任务-227）：声明成功路径占用集 degraded → stderr 告警一行（含规格字面量
  // 「历史占用校验不完整」与降级来源），不改变退出码（声明本身仍成功；fail-loud 可诊断面）。
  if (Array.isArray(act.degraded) && act.degraded.length > 0) {
    process.stderr.write(
      `routing-declare：警告——历史占用校验不完整（占用源降级：${act.degraded.map((d) => d.source).join('/')}）；本次声明仍生效。取证：--suggest-task-id 查询最近降级摘要或查看 wf-occupancy-degraded 审计行（ADR-061 D5.5）。\n`,
    );
  }
  // 内部规则-20（内部任务-75/IMP-3）：映射表内 skill 未附 --change-scope 的声明侧强提示——提示档
  // （stderr 一行，不改退出码、不阻断声明）；闸侧 deny 为主档，两档互补（内部决策-11）。
  if (SKILL_WRITE_FLOOR[skill] !== undefined && scopeEntries === undefined) {
    process.stderr.write(
      `routing-declare：提示——${skill} 的基线写面为过程文档（docs/plans 的 .md）：未附 --change-scope 时闸侧 Edit/Write 将只放行该面，代码/测试/归档面修改会被基线写面拦截；如需修改请在本条声明命令追加 --change-scope '["<路径>",…]'。\n`,
    );
  }
  // lease-deny 自愈（2026-09-15 激活域批次，内部决策-022）：声明成功=机制回到正常执法轨道，
  // 本项目全部 open 的租约拒绝留痕批量转 resolved（按项目全域不区分会话——lease-deny
  // 定义上即机制正常执法留痕，与「真异常」分层）。resolveOpenByKind 全路径不抛
  //（与豁免审计段同款：无调用点 try/catch，评审 S5 口径）。
  // 注意（内部任务-LEASEGATE-1，内部规则-13 ④）：kind=lease-loop（同签名振荡升级信号）刻意不在
  // 自愈面——升级记录必须人工 incident-cli 处置，声明成功不得把它一并归零（防再静默）。
  // 自愈键集=本仓 + 本仓 git 祖先仓（内部任务-LEASEGATE-1 阶段复审采纳）：deny 留痕落「会话
  // cwd 激活域根」（routing-gate denyRoot），双仓拓扑（cwd 在外层仓、编辑嵌套仓文件）下
  // 落外层仓而声明键是嵌套仓——不连带祖先仓则振荡行永远无人置 resolved，lease-loop 升级
  // 判定（窗内 resolved≥2）在该拓扑恒不触发（bootstrap-reissue 的 P9b 同款先例）。
  // 已接受限制（终审处置登记）：反向拓扑（cwd 在嵌套仓、编辑外层仓文件——deny 落嵌套根
  // 而声明键是外层仓）不在覆盖面，该拓扑振荡不升级（欠报不误报）；完整可达面须声明键
  // 嵌套仓下探，收益/复杂度比不划算，触发条件=该拓扑死循环实录出现。
  // 自愈族（lease-deny/bootstrap-reissue/lease-read-anomaly，键集＝本仓+git 祖先仓）：
  // 三段同构收敛为单助手（阶段复审简洁性发现 2——第三份拷贝越过仓库「两份同构即抽」
  // 阈值，且已见输出粒度漂移：第一段跨键汇总、后两段逐键各打——统一为按 kind 汇总一行）。
  const healAncestors = (kind, note, label) => {
    let resolved = 0;
    let failed = 0;
    for (const healKey of [key, ...ancestorRepoKeys(key)]) {
      const r = applyDispositions(healKey, { sources: ['lease-heal'], lease: { kind, note } });
      resolved += r.leaseHealed;
      // 内部任务-244 E01：处置失败不得静默（此前返回值丢弃）——聚合后以 stderr 可见化。
      failed += Number(r.failed ?? 0);
    }
    if (failed > 0) process.stderr.write(`【warn】${label}自愈处置失败 ${failed} 项（声明不受影响，请查 hook-errors/账本）\n`);
    if (resolved > 0) {
      process.stdout.write(`【自察自愈】${resolved} 条 open ${label}已批量解决（incident-cli list 可见历史）。\n`);
    }
  };
  // 豁免/退役审计（内部接口-20 v2）：先审计，成功后才自愈（失败声明不产生不可逆自愈）。
  // 豁免审计失败 fail-closed（释放租约+exit 1）；退役审计失败只 warning（内部决策-067 D5.4）。
  let revokeWarn = '';
  const chOwner = challengeOwnerInfo(leaseId, key);
  const ownerSession = chOwner && typeof chOwner.sessionId === 'string' && chOwner.sessionId ? chOwner.sessionId : null;
  if (exemptRevoke) {
    if (act.inherited === true) {
      const rb = rollbackActivation(key, {
        leaseId, taskId, claimMode: act.claimMode, markerWritten: act.claimMarkerWritten, sessionId: ownerSession,
      });
      process.stderr.write(
        'routing-declare：--exempt-revoke 在委派继承声明中不可用——退役是任务级治理动作，由任务持有者执行；'
          + `已回滚本次激活（removed=${rb.removed.length} / failed=${rb.failed.length}）。\n`,
      );
      process.exit(1);
    }
    const rr = recordExemptionRevocation(key, { taskId, reason: exempt.trim(), src: exemptSrc });
    if (!rr.ok) revokeWarn = '（豁免退役未留痕：gate 可能仍按旧豁免阻断，请修复状态根后重试）';
  } else if (hasExempt) {
    const rec = recordExemption(key, {
      taskId,
      skill,
      reason: exempt.trim(),
      src: exemptSrc,
      scope: exemptScope,
      ...(exemptScope === 'review' && planInfo ? { planPath: planInfo.planPath } : {}),
    });
    if (!rec.ok) {
      const rb = rollbackActivation(key, {
        leaseId, taskId, claimMode: act.claimMode, markerWritten: act.claimMarkerWritten, sessionId: ownerSession,
      });
      if (act.claimMarkerWritten === true) {
        journalInternalWrite(key, { sessionId: ownerSession, taskId, targets: [`docs/plans/claims/${taskId}.json`] });
      }
      process.stderr.write(
        `routing-declare：豁免审计失败——${rec.error}；已回滚本次激活`
          + `（removed=${rb.removed.length} / failed=${rb.failed.length} / residual=${rb.residual.join(',')}）。`
          + '无留痕不豁免；请修复状态根后重试。\n',
      );
      process.exit(1);
    }
  }
  // 内部任务-342（内部决策-066 修正案 2 内部模块-3）：声明成功且确有 claim/占位写仓时追加 internal journal 行
  // （继承声明/未写 claim 不落行；落点须在 ownerSession 解析与两条 rollback 分支之后、stdout 之前）。
  if (act.claimMarkerWritten === true && act.inherited !== true) {
    journalInternalWrite(key, { sessionId: ownerSession, taskId, targets: [`docs/plans/claims/${taskId}.json`] });
  }
  healAncestors('lease-deny', '声明自愈：项目租约已激活，租约拒绝留痕批量解决', '租约拒绝留痕');
  healAncestors('bootstrap-reissue', '声明自愈：补签目标仓已完成声明，bootstrap-reissue 留痕解决', '补签留痕');
  // 读侧异常自愈（内部任务-27 坑3）：声明成功＝读侧机制回到正常轨道；lease-loop 排除口径
  // 见上方 lease-deny 自愈注记（内部规则-13 ④），此处不重复展开。
  healAncestors('lease-read-anomaly', '声明自愈：租约已激活，读侧异常留痕批量解决', '读侧异常留痕');
  warnBrokenDomains(key); // 内部未决-76：域声明损坏可见性（存在而解析失败才警示，lenient 正常态静默）
  warnBrokenMaintainers(key); // 内部决策-045/内部任务-96：维护者注册表损坏可见性（同构）
  // D4（内部任务-24/内部任务-99）：激活后闸侧可达性自检——activateLease 成功 ≠ 闸可达（指针/桶
  // 状态损坏或错配时真会话按读侧判定看不见，成功文案的「放行」承诺即成假象）。不可达时
  // 成功输出后追加警告块（成功语义不污染——claimWritten stderr 警示先例）；自检异常静默
  // （fail-open，不影响已激活租约）。
  let reachWarn = '';
  try {
    const reach = activationReachability(key, leaseId);
    if (!reach.ok) {
      reachWarn =
        `【警告】租约已激活但闸侧不可达（失效原因：${reach.reason ?? '未知'}）——会话桶归属或指针状态异常，` +
        '「放行」承诺不成立。若下一条写操作仍被拦：发送一条新用户消息触发重签发后再声明，或按 deny 文案的键控诊断排查状态根。\n';
    }
  } catch {
    /* 自检 fail-open */
  }
  const suffix =
    exemptRevoke
      ? (revokeWarn || `（豁免退役已留痕：scope=revoked，计划=${planInfo?.planPath ?? ''}；后续 gate 不再要求豁免引文）`)
      : hasExempt
        ? `（豁免登记：scope=${exemptScope}，引文已留痕；${exemptScope === 'review' ? `计划已锚定：${planInfo?.planPath ?? ''}` : '完成侧须补追溯计划并绑定 verification'}）`
        : planInfo
          ? `（计划凭据已绑定：${planInfo.planPath} @ ${planInfo.planSha256.slice(0, 16)}…）`
          : skill === AD_HOC_DELIVERABLE
            ? `（${AD_HOC_DELIVERABLE} 制品型声明：完成链＝verification → 类型匹配评审〔--review-mode deliverable〕→ operation → gate --deliverable-chain；不可用于开发任务，自察归因按 ${AD_HOC_DELIVERABLE} 区分）`
            : skill === AD_HOC
              ? `（${AD_HOC} 绕行声明：非开发任务无对应路由行；不可用于开发任务，自察归因按 ${AD_HOC} 区分）`
              : '';
  process.stdout.write(
    `任务租约已激活：skill=${skill}｜task=${taskId}｜本会话内有效（本会话下一条用户消息自动轮换；会话标识不可见时多活+TTL 自然过期，ADR-018 修正案），${permitPhrase(skill)}${suffix}。\n` +
    activationPermitNote(skill) +
    nextStepHintLine(skill) +
    (scriptWrites !== undefined
      ? `【脚本写声明】${scriptWrites.length} 条（理由已入租约 scriptWrites[]；审计 ${stateRootFor(key)}/wf-script-writes.jsonl）\n`
      : '') +
    (scriptEditCode !== undefined
      ? `【受检路径脚本编辑声明】${scriptEditCode.length} 条（理由已入租约 scriptEditCode[]；审计 ${stateRootFor(key)}/wf-script-edits.jsonl）\n`
      : '') +
    (projectSkills !== undefined
      ? `【项目 skill】已 ack：${projectSkills.map((item) => item.name).join('、')}（入租约 projectSkills[] 与 wf-issued 台账）\n`
      : '') +
    // 内部决策-050 D1：提交纪律句按占位实落条件化（复审门②发现 2——写失败时不断言「已落」，
    // 失败细节由 stderr 警告承载，与 claimWritten 失败路径「成功文本不虚报」同款口径）。
    // 内部决策-061 D4.3（内部任务-227）：继承声明不写占位（占用归父）——不渲染「已落/失败」两态。
    (act.inherited === true
      ? `【取号占位】继承声明不写 docs/plans/claims/ 占位（占用归父会话；跨机占用可见性由父会话占位承载）。\n`
      : act.claimMarkerWritten === false
        ? `【取号占位】git 同步面占位登记写盘失败（docs/plans/claims/${taskId}.json）——重跑声明可重建；未重建前占用仅本机可见。\n`
        : `【取号占位】已落 docs/plans/claims/${taskId}.json——请随本任务首次提交一并 commit+push（跨机占用可见的前提，ADR-050 D1；插件不代提交）。\n`) +
    (visibilityHints(key).domains ? DOMAINS_SETUP_HINT + '\n' : '') +
    `【learnings 检索】按已声明 skill（${skill}）检索项目根 learnings.md 的同场景条目，命中即读入本轮任务上下文（R-M6-7）。\n` +
    `【OPEN 检索】按任务域检索 specs/open-items.md（或项目声明的权威台账）相关未决项并显式处置——软约束不阻断，义务全文见 IF-COLLAB-8 §7.1（消费面义务，R-M8-21）。\n`,
  );
  if (reachWarn) process.stdout.write(reachWarn);
  process.exit(0);
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
    process.exit(selftest());
  }
  main();
}
