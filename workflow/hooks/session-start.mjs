// 文件：session-start.mjs
// 描述：workflow 插件 SessionStart 注入钩子（内部规则-5 / 内部接口-1）——把元技能全文
//       以 additionalContext 注入，使会话开始（含 resume/clear/compact 后）模型先见路由表。
//       内部任务-8（2026-10-07，内部规则-17 / 内部决策-8）增「护栏健康自检」：三护栏（check-careful /
//       check-freeze / routing-gate）各喂一次合成 PreToolUse 负载**并行**冒烟（单钩 ≤5s，
//       SessionStart 声明预算 10s），任一异常即在同一帧 additionalContext 追加告警行。
//       姿态=**告警不阻断**（不产 deny/ask）；自检自身异常 fail-open（不注入、不阻断启动）。
//       内部任务-79（2026-10-14，内部决策-041）增「证据类记录老化归档」：读 SessionStart 负载 cwd，
//       对项目账本幂等触发 archiveAgedIncidents（排除面命中＋超龄的 open 记录批量转
//       archived 终态）；全路径不抛、无 cwd 即跳过——钩姿态与自检一致。
//       内部任务-89（2026-10-15，内部决策-044/内部规则-17）增「非激活域 scout 轻提醒」：负载 cwd 无
//       git 祖先且无治理标记（activationRoot null）时在注入帧追加一行评估提醒（只提醒
//       不执法、文案不断言执法状态）；stdin 单次消费重构（main 统一读负载分发，防双读挂起）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// fail-open：任何失败（缺文件、无权限、JSON 序列化失败）静默退出 0，不阻断宿主
// （内部规则-10 同款姿态；project-conventions 硬规则 4）。
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installHookErrorTrap, noteHookIssue, readStdin, runHookMain } from './hook-lib.mjs';
import { projectKey, activationRoot, gitAncestor, runtimeStateDir } from './routing-lib.mjs';
import { cleanupExpiredOccupancyCaches } from './task-lease-lib.mjs';
import { scanOpenItems } from '../scripts/lib/open-items-scan.mjs';
import { applyDispositions, appendIncident, cleanupExpiredRetryIndexes, countLostFacts, incidentFile, readIncidents } from '../scripts/lib/incident-store.mjs';
import { classifyFact, loadRules } from '../scripts/lib/incident-rules.mjs';
import { loadContract, resolveCapabilities } from '../scripts/lib/observation-capabilities.mjs';
import { hostOf } from '../scripts/lib/host-detect.mjs';
import { renderProjectSkillIndexLines, requiredProjectSkills } from '../scripts/lib/project-skills.mjs';
import { resolveMode } from '../scripts/lib/write-policy.mjs';
// 判据单源（内部决策-063 修正案 3 决策 20）：canary 只许从 lib 导入 classifyResult——不得跨钩导入
// post-tool（接口方向倒置；该跨钩导入因就绪面 canary 而生）。
import { classifyResult } from '../scripts/lib/tool-result-classify.mjs';

/** 静态回落清单（manifest/hooks.json 均缺失或损坏时使用；正常路径从中立 manifest 派生实际注册项）。 */
const FALLBACK_GUARD_TARGETS = [
  { name: 'check-careful', file: 'check-careful.mjs' },
  { name: 'check-freeze', file: 'check-freeze.mjs' },
  { name: 'routing-gate', file: 'routing-gate.mjs' },
  { name: 'write-guard', file: 'write-guard.mjs' },
];

/** 从处理器命令行取钩子名。 */
function hookNameFromArg(arg) {
  const m = String(arg ?? '').match(/hooks\/([^/]+)\.mjs$/);
  return m ? m[1] : null;
}

/**
 * 从插件根派生 PreToolUse 处理器清单（内部决策-066 D11；内部任务-261 工程/约定评审处置）：
 * ①优先读**中立** `plugin.manifest.json`（Kimi/MCode 包不含生成物 hooks.json，读生成物会误告警）；
 * ②再退生成物 `hooks/hooks.json`；③都不可用→静态四钩回落。任何异常不得吞掉整帧注入。
 * 派生结果缺 write-guard 时仍返回可用清单，但显式告警「未注册」（不静默少测一钩）。
 * @param {string} root 插件根
 * @returns {{targets: Array<{name: string, file: string}>, warning: string|null}}
 */
function resolveGuardTargets(root) {
  const expected = FALLBACK_GUARD_TARGETS.map((t) => t.name);
  const toResult = (names) => {
    const uniq = [...new Set(names.filter(Boolean))];
    if (uniq.length === 0) throw new Error('empty');
    const missing = expected.filter((n) => !uniq.includes(n));
    const warning = missing.length > 0
      ? `\n\n⚠️ 护栏健康自检：manifest 未注册 ${missing.join('、')}（自检仅覆盖 ${uniq.length} 钩；请检查插件安装）\n`
      : null;
    return { targets: uniq.map((name) => ({ name, file: `${name}.mjs` })), warning };
  };
  // ① 中立 manifest（唯一手工编辑面；所有宿主包均在）
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'plugin.manifest.json'), 'utf8'));
    const groups = (manifest?.hooks ?? []).filter((h) => h?.event === 'PreToolUse');
    return toResult(groups.flatMap((h) => (Array.isArray(h?.args) ? h.args : []).map(hookNameFromArg)));
  } catch { /* 落到生成物 */ }
  // ② ZCode 生成物 hooks.json
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
    const groups = parsed?.hooks?.PreToolUse;
    if (!Array.isArray(groups)) throw new Error('no-pretooluse');
    const names = [];
    for (const g of groups) {
      const handlers = Array.isArray(g?.hooks) ? g.hooks : [g];
      for (const h of handlers) {
        for (const a of Array.isArray(h?.args) ? h.args : []) names.push(hookNameFromArg(a));
      }
    }
    return toResult(names);
  } catch { /* 落到静态清单 */ }
  return {
    targets: FALLBACK_GUARD_TARGETS,
    warning: '\n\n⚠️ 护栏健康自检：manifest/hooks.json 缺失或损坏，回退静态四钩清单（自检仍执行；请检查 workflow 插件安装）\n',
  };
}

/** 项目写仓闸配置告警（坏配置/被忽略的类覆盖可见；缺失或合法时零输出）。 */
function writeGuardModeWarnLine(cwd) {
  try {
    const cfgRoot = activationRoot(cwd ?? process.cwd()) ?? (cwd ?? process.cwd());
    const raw = readFileSync(join(cfgRoot, '.workflow', 'write-guard.json'), 'utf8');
    const m = resolveMode({ configRaw: raw });
    return m.warning ? `\n\n⚠️ 写仓闸配置：${m.warning}\n` : '';
  } catch {
    return '';
  }
}

/** 单钩冒烟超时（毫秒）：四钩并行总预算 ≈ 单钩上限，满足 SessionStart 10s 声明。 */
const SMOKE_TIMEOUT_MS = 5000;

/**
 * 冒烟负载的宿主工具名（内部规则-17 ③「含本宿主工具名」）：按宿主环境前缀选 **shell 族**名——
 * DSH（`DSH_*`）用 `pwsh`、ZCode（`ZCODE_*`）用 `Bash`、皆无则 `bash`。四钩在 shell 族上均有
 * 明确放行面（合成命令为只读），故任一取值都能真实驱动目标钩。
 * @returns {string} 工具名
 */
function smokeToolName() {
  const keys = Object.keys(process.env);
  if (keys.some((k) => k.startsWith('DSH_'))) return 'pwsh';
  if (keys.some((k) => k.startsWith('ZCODE_'))) return 'Bash';
  return 'bash';
}

/**
 * 冒烟单个护栏钩：喂合成 PreToolUse 负载，判定「响应可解析或无输出」为通过。
 * 失败面＝非零退出（除 2=deny 信封）/ 超时 / 坏 JSON / spawn 异常。
 * @param {string} root 插件根
 * @param {string} home 隔离夹具根（状态/留痕均不落真实仓库）
 * @param {{name: string, file: string}} target 目标钩
 * @returns {Promise<{name: string, ok: boolean}>}
 */
function smokeOne(root, home, target) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ name: target.name, ok });
    };
    const cwd = join(home, 'proj');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: smokeToolName(),
      session_id: 'session-guard-smoke',
      tool_input: { command: 'echo probe' },
      cwd,
    });
    let child;
    try {
      child = spawn(process.execPath, [join(root, 'hooks', target.file)], {
        env: {
          ...process.env,
          WF_ROUTING_STATE_DIR: join(home, 'state'),
          WF_INCIDENT_ROOT: join(home, 'incident'),
          ZCODE_PLUGIN_ROOT: root,
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(false);
    }, SMOKE_TIMEOUT_MS);
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      let parsable = true;
      if (text !== '') {
        try {
          JSON.parse(text);
        } catch {
          parsable = false;
        }
      }
      finish((code === 0 || code === 2) && parsable);
    });
    child.stdin.on('error', () => {
      /* 子进程提前退出：close 分支判定 */
    });
    child.stdin.end(payload);
  });
}

/**
 * 护栏并行冒烟（目标由中立 manifest/hooks.json 派生，异常回落静态清单）；返回失败项清单。异常向上抛，由调用方 fail-open 兜底。
 * @param {string} root 插件根
 * @param {Array<{name: string, file: string}>} targets 冒烟目标
 * @returns {Promise<Array<{name: string, ok: boolean}>>} 失败项
 */
async function runGuardSmoke(root, targets) {
  // 自检注入缝（先例：GUARD_HOOK_INJECT_CRASH）：模拟「自检自身异常」以验证 fail-open 不告警
  if (process.env.WF_GUARD_SMOKE_INJECT_CRASH === '1') throw new Error('inject-smoke-crash');
  const home = mkdtempSync(join(tmpdir(), 'wf-guard-smoke-'));
  try {
    mkdirSync(join(home, 'proj', '.git'), { recursive: true });
    const results = await Promise.all(targets.map((t) => smokeOne(root, home, t)));
    return results.filter((r) => !r.ok);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 告警行构造（纯函数，供 selftest 直断言字面量）。
 * @param {Array<{name: string}>} failed 失败项
 * @param {number} total 目标总数
 * @returns {string} 追加到 additionalContext 的告警段（无失败时空串）
 */
function guardWarnLine(failed, total) {
  if (!Array.isArray(failed) || failed.length === 0) return '';
  const names = failed.map((f) => `\`${f.name}\``).join('、');
  return `\n\n⚠️ 护栏健康自检：${names} 冒烟失败（${total - failed.length}/${total} 通过）——该钩可能存在安装/运行异常；本自检是**合成负载冒烟**（不覆盖宿主 matcher 层），请检查 workflow 插件安装与 hooks 配置\n`;
}

/**
 * fail-open 包装：冒烟/构造任一环节抛错（自检自身异常）→ 返回空串（不注入告警、不阻断启动）。
 * @param {string} root 插件根
 * @param {string|null} cwd 会话 cwd（写仓闸配置告警面；null＝process.cwd）
 * @returns {Promise<string>} 告警段（异常或全过时空串）
 */
async function guardWarnLineSafe(root, cwd = null) {
  try {
    const { targets, warning } = resolveGuardTargets(root);
    const bad = await runGuardSmoke(root, targets);
    return (warning ?? '') + guardWarnLine(bad, targets.length) + writeGuardModeWarnLine(cwd);
  } catch {
    return '';
  }
}

// 宿主 token 推导已下沉单源 `scripts/lib/host-detect.mjs`（内部决策-063 修正案 3 决策 19，内部任务-195）：
// 就绪面与租约审计共用同一张前缀表（ZCODE_ 末位），本钩不再维护第二张探测表。

/** hook-errors 近期窗口缺省：24 小时（可用 WF_READINESS_HOOK_ERRORS_MS 覆盖，仅测试缝）。 */
const READINESS_HOOK_ERRORS_WINDOW_MS = 24 * 3600 * 1000;

/**
 * 自检用能力域声明（四域原生）：让自检驱动的子进程环境**确定**——不受运行宿主注入面影响
 * （缺省会按宿主 token 走镜像缺省，DSH/Kimi/MCode 会带出「能力域未声明」告警，污染逐字注入断言）。
 */
const SELFTEST_CAPABILITIES = JSON.stringify({ failureFacts: 'native', hookFailure: 'native', injection: 'native', selfCheck: 'native' });

/**
 * 账本可读性探针（与 incident-cli 契约同判据）：missing/ok/unreadable 三态。
 * @param {string} file 账本路径
 * @returns {'missing'|'ok'|'unreadable'}
 */
function probeLedgerReadable(file) {
  if (!existsSync(file)) return 'missing';
  try {
    if (!statSync(file).isFile()) return 'unreadable';
    accessSync(file, constants.R_OK);
    return 'ok';
  } catch {
    return 'unreadable';
  }
}

/**
 * 账本**可写探针**（内部规则-12；评审修复 N7）：探 `.workflow` **实际目录**——mkdir -p 后写一枚
 * 临时探针文件再删除。只开账本 `'a'`（旧实现）在「账本文件不可写但目录可写」与「目录只读」
 * 两态下都会给出失真的结论（前者账本追加会失败、后者账本存在时却能开成功），目录可写性才是
 * 追加写（mkdir/rotate/追加）的真实前置。探针净零副作用：写完立即删除；`.workflow` 只读 ⇒
 * mkdir/写探针抛错 ⇒ 如实告警不可写（fail-open，不阻断会话）。
 * @param {string} file 账本路径（其目录即 .workflow）
 * @returns {boolean}
 */
function probeLedgerWritable(file) {
  const dir = dirname(file);
  const probe = join(dir, `.wf-write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      // 账本已存在：真实追加语义是 open(file,'a')——文件只读时该 open 会 EACCES/EPERM，
      // 目录可写但文件只读的「假可写」由此被如实识别（评审修复：文件级探针）。
      closeSync(openSync(file, 'a'));
      return true;
    }
    writeFileSync(probe, 'x');
    unlinkSync(probe);
    return true;
  } catch {
    try {
      unlinkSync(probe);
    } catch {
      /* 探针未创建/删除失败均可忽略（净零副作用尽力而为） */
    }
    return false;
  }
}

/**
 * 钩接线存在性检查（内部规则-12）：读 `<插件根>/hooks/hooks.json` 声明，逐处理器核对
 * `${ZCODE_PLUGIN_ROOT}/<rel>` / `${CLAUDE_PLUGIN_ROOT}/<rel>` 目标文件是否存在。
 * 无 hooks.json ⇒ 非插件根/裁剪树：**跳过**（不误报；接线面无从判定时不得编造结论）。
 * @param {string|null} pluginRoot 插件根
 * @returns {{missing: string[], unparsable: boolean}}
 */
function checkHookWiring(pluginRoot) {
  if (typeof pluginRoot !== 'string' || !pluginRoot) return { missing: [], unparsable: false };
  let text;
  try {
    text = readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8');
  } catch {
    return { missing: [], unparsable: false };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { missing: [], unparsable: true };
  }
  const missing = new Set();
  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        for (const arg of Array.isArray(handler?.args) ? handler.args : []) {
          const m = /\$\{(?:ZCODE|CLAUDE)_PLUGIN_ROOT\}\/(.+)$/.exec(String(arg));
          if (!m) continue;
          if (!existsSync(join(pluginRoot, m[1]))) missing.add(m[1]);
        }
      }
    }
  }
  return { missing: [...missing], unparsable: false };
}

/**
 * JSONL 行计数（窗口可选）：坏行跳过（计数面 fail-open），缺文件/读失败按 0。
 * @param {string} file 文件路径
 * @param {(rec: any, now: number) => boolean} [pred] 行过滤
 * @param {number} [now] 判定时刻
 * @returns {number}
 */
function countJsonLines(file, pred, now = Date.now()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (pred && !pred(rec, now)) continue;
    n += 1;
  }
  return n;
}

/**
 * 自察就绪面（内部规则-12 / 内部决策-063 修正案 1 决策 15）——**纯函数**八项检查：
 * ①能力域声明完整性（经镜像 resolver）②钩接线存在性 ③规则表可加载性 ④账本可读性
 * ⑤账本可写探针 ⑥捕获 canary（合成失败事实走 classifyResult＋规则表）⑦hook-errors 近期失败
 * ⑧lost-facts 非空。健康零输出；任一失败输出**一行**可行动告警（含失败项与指引）。
 * 本函数不落 incident（避免自产噪声）、不抛错（调用方另有 fail-open 包裹）。
 * @param {Record<string, string|undefined>} env 环境视图
 * @param {{projectRoot?: string|null, pluginRoot?: string|null, stateDir?: string|null, now?: number}} root 路径视图
 * @param {string} host 宿主 token（镜像查表键）
 * @returns {string} 追加段（''＝健康）
 */
function readinessLine(env, root, host) {
  const projectRoot = root?.projectRoot ?? null;
  if (typeof projectRoot !== 'string' || !projectRoot) return ''; // 非激活域不就绪检查（域外无运行态面）
  const now = Number.isFinite(root?.now) ? root.now : Date.now();
  const items = [];
  // ① 能力域声明（唯一人工源＝内部接口-1；核心消费机器可读镜像）
  const cap = resolveCapabilities(env?.WF_OBSERVATION_CAPABILITIES, loadContract(), host);
  if (!cap.ok) items.push(`能力域声明非法（宿主 ${cap.host}）`);
  else if (cap.degraded) items.push(`能力域未声明（宿主 ${cap.host}，按保守 ${cap.domains.failureFacts} 处理）`);
  // ② 钩接线
  const wiring = checkHookWiring(root?.pluginRoot ?? null);
  if (wiring.unparsable) items.push('hooks.json 不可解析');
  if (wiring.missing.length > 0) items.push(`钩接线缺失 ${wiring.missing.length} 件（${wiring.missing.slice(0, 3).join('、')}）`);
  // ③ 规则表
  const rules = loadRules({ path: env?.WF_INCIDENT_RULES_PATH });
  if (!rules.ok) items.push('规则表不可加载（已回退保守 unclassified）');
  // ④⑤ 账本可读 + 可写探针
  const file = incidentFile(projectRoot);
  if (probeLedgerReadable(file) === 'unreadable') items.push('账本不可读');
  if (!probeLedgerWritable(file)) items.push('账本不可写');
  // ⑥ 捕获 canary：合成失败事实走 classifyResult＋规则表——任一环节坏则本项失败
  const probe = classifyResult('canary', { is_error: true });
  const canary = probe ? classifyFact({ kind: 'tool-failure', errorClass: probe.errorClass, host }, rules) : null;
  if (!canary || canary.cause !== 'real-failure') items.push('canary 失败（捕获→分类链路异常）');
  // ⑦ hook-errors 近期失败（窗口内条数；缺失/坏行按 0）
  const stateDir = root?.stateDir ?? null;
  if (typeof stateDir === 'string' && stateDir) {
    const windowMs = positiveIntFromEnv('WF_READINESS_HOOK_ERRORS_MS', READINESS_HOOK_ERRORS_WINDOW_MS);
    const recent = countJsonLines(join(stateDir, 'hook-errors.jsonl'), (rec) => Number.isFinite(Number(rec.ts)) && now - Number(rec.ts) <= windowMs, now);
    if (recent > 0) items.push(`hook-errors 近期失败 ${recent} 条`);
  }
  // ⑧ lost-facts 非空（兜底旁路：评审修复 N4 单源 countLostFacts——与 retro lostFacts/digest 同口径）
  const lost = countLostFacts(projectRoot);
  if (lost > 0) items.push(`lost-facts 非空 ${lost} 条（emit 兜底旁路待人工回放）`);
  if (items.length === 0) return '';
  return `\n\n⚠️ 自察就绪面：${items.join('、')}——检查 workflow 插件安装 / hooks 配置 / 规则表与账本权限（M15 R-M15-12；本检查不落 incident）。\n`;
}

/**
 * fail-open 包装：就绪检查自身异常 → 空段（不注入告警、不阻断启动；内部规则-7）。
 * @param {Record<string, string|undefined>} env
 * @param {object} root 路径视图
 * @param {string} host 宿主 token
 * @returns {string}
 */
function readinessLineSafe(env, root, host) {
  try {
    return readinessLine(env, root, host);
  } catch {
    return '';
  }
}

/**
 * 内部任务-89 B2（内部决策-044/内部规则-17）：非仓无标记环境的 scout 评估轻提醒行（纯函数，selftest 直断言）。
 * 只提醒不执法：不签任何状态、不产 deny/ask；无 cwd/判定异常一律空串（fail-open）。
 * 文案红线（内部决策-044 决策 7）：不断言执法状态（多仓工作区锚场景租约闸照常工作——签发面
 * discoverRepoKeys 对子仓照签）；嵌入被评估目录（可观测性，内部决策-044 决策 6/7）。
 * 分工（内部决策-044 决策 6）：本行只做路由教育指路，不含开启命令（开启命令归 scout 侧 absent 行）。
 * @param {string|null} cwd 宿主负载 cwd
 * @returns {string} 提醒段（空串=不追加）
 */
function scoutNudgeLine(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd) return '';
    if (activationRoot(cwd) !== null) return '';
    return `\n\n【workflow 提醒】（工作目录 ${cwd}）无 git 祖先且无治理标记：若本任务呈探索性/一次性交付特征（探针、临时脚本、单次工具），请先评估是否开启 scout 探路模式（opt-in：与用户确认 mode 与 expiry，见 scout 元技能）；特征不符请忽略本行，照常路由。\n`;
  } catch {
    return '';
  }
}

/**
 * 内部任务-79（内部决策-041）：每会话轻量幂等触发证据类记录老化归档。
 * 内部模块-15 v2（内部决策-063 D4）：改经**统一处置入口**且只传 `aged-archive`（会话启动不得顺带解 lease 族/
 * 重试自愈——作用域最小化）；`failed>0` 经 noteHookIssue 落 hook-errors（新失败面不得静默）。
 * fail-open 同 guardWarnLineSafe——无 cwd / 账本不可读 / 迁移失败全部消化为不阻断；
 * main 尾部显式 exit，故必须 await 完成后返回（fire-and-forget 会被 exit 杀掉）。
 * 内部任务-89 重构：stdin 单次消费（readStdin 不可二次调用——'end' 事件只发射一次，
 * 二次调用的 promise 永不 resolve、钩挂起至宿主超时），负载由 main() 统一读取后传入 cwd。
 * @param {string|null} cwd 宿主负载 cwd（null 即跳过）
 */
async function archiveAgedQuiet(cwd) {
  try {
    if (!cwd) return;
    const disp = applyDispositions(projectKey(cwd), { sources: ['aged-archive'] });
    if (disp.failed > 0) noteHookIssue('session-start', 'aged-archive-failed');
    // 内部任务-244 P01：新会话清理过期重试自愈索引（纯缓存；失败可见不阻断）
    const cleaned = cleanupExpiredRetryIndexes(runtimeStateDir());
    if (cleaned.failed > 0) noteHookIssue('session-start', 'cache-degraded');
    // 内部任务-244 P02：启动清理过期占用缓存（纯缓存；失败可见不阻断）
    const occCleaned = cleanupExpiredOccupancyCaches(projectKey(cwd));
    if (occCleaned.failed > 0) noteHookIssue('session-start', 'cache-degraded');
  } catch {
    /* 全路径不抛 */
  }
}

/**
 * OPEN 存量面梳理提醒行（内部任务-57/内部规则-22②，内部决策-049 决策 6②，内部接口-8 v3 §7.2）：
 * 登记册已关项全文条目数（非墓碑）超阈值 50 时注入一行梳理提醒。只读（scanOpenItems，
 * 不写规格资产）；scoutNudgeLine 同族 fail-open——无 cwd/册缺席/解析失败/超时一律空串。
 * 插入位＝scout 行之后、自检告警之前（帧序变更由 内部验收-17 共存用例同步锁定）。
 * @param {string|null} cwd 宿主负载 cwd
 * @returns {string} 提醒段（空串=不追加）
 */
function openGroomNudgeLine(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd) return '';
    const repoRoot = gitAncestor(cwd); // fs 探针（.git 存在性逐级上溯，routing-lib 既有契约），非 git 子进程；非仓返 null
    if (!repoRoot) return '';
    const scan = scanOpenItems(join(repoRoot, 'specs', 'open-items.md'));
    if (!scan || scan.closedFullText <= 50) return '';
    return `\n\n【workflow 提醒】OPEN 登记册已关项全文 ${scan.closedFullText} 条超阈值 50——建议发起定期梳理（五动作：关闭/降级/保留/合并/归档，判据见 IF-COLLAB-8 §7.2 与 R-M7-18）。\n`;
  } catch {
    return '';
  }
}

/** 架构体检提醒阈值缺省（内部决策-052 决策 4 / 内部规则-23 / 内部规则-7）。 */
const ARCH_NUDGE_DAYS_DEFAULT = 14;
const ARCH_NUDGE_FACTS_DEFAULT = 10;
/** 计入「新增架构事实」的记录类型（review 仅作时间基线）。 */
const ARCH_FACT_KINDS = new Set(['finding', 'optimization', 'evolution']);

/**
 * 架构体检提醒行（内部决策-052/内部规则-23）：读被治理项目 `.context/architecture-feedback.jsonl`，
 * 距上次 review ≥N 天或自上次 review 后新增架构事实 ≥M 条时注入一行软提醒。
 * 无台账/无 review 基线时仅按事实条数阈（≥M 条视为从未体检）；坏行跳过（fail-open）。
 * 阈值环境变量可调仅作测试缝（WF_ARCH_NUDGE_DAYS / WF_ARCH_NUDGE_FACTS）。
 * @param {string|null} cwd 宿主负载 cwd
 * @returns {string} 提醒段（空串=不追加）
 */
function architectureNudgeLine(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd) return '';
    const root = activationRoot(cwd); // 内部规则-23：非激活域静默（内部规则-11 判据：git 祖先 ∪ 内部治理状态 标记）
    if (!root) return '';
    let text = '';
    try {
      const ledgerPath = join(root, '.context', 'architecture-feedback.jsonl');
      const st = statSync(ledgerPath); // 读前 stat：超限/非普通文件不读（SessionStart 预算）
      if (!st.isFile() || st.size > 1000000) return '';
      text = readFileSync(ledgerPath, 'utf8');
    } catch {
      return ''; // 台账缺席/不可读：新项目不提醒
    }
    const daysThreshold = positiveIntFromEnv('WF_ARCH_NUDGE_DAYS', ARCH_NUDGE_DAYS_DEFAULT);
    const factsThreshold = positiveIntFromEnv('WF_ARCH_NUDGE_FACTS', ARCH_NUDGE_FACTS_DEFAULT);
    const now = Date.now();
    const records = [];
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (!rec || typeof rec !== 'object' || typeof rec.ts !== 'string') {
          badLines += 1; // 形态坏行（非对象/缺 ts）：跳过并计数
          continue;
        }
        const ms = Date.parse(rec.ts);
        if (!Number.isFinite(ms) || ms > now) {
          badLines += 1; // 非法/未来 ts：跳过并计数（未来基线会静默关闭提醒）
          continue;
        }
        records.push({ ...rec, ms });
      } catch {
        badLines += 1; // JSON 语法坏行：跳过并计数（内部规则-23）
      }
    }
    let lastReviewMs = null;
    for (const rec of records) {
      if (rec.kind !== 'review') continue;
      if (lastReviewMs === null || rec.ms > lastReviewMs) lastReviewMs = rec.ms;
    }
    const sinceMs = lastReviewMs ?? 0;
    const facts = records.filter((rec) => ARCH_FACT_KINDS.has(rec.kind) && rec.ms > sinceMs).length;
    const days = lastReviewMs === null ? null : Math.floor((now - lastReviewMs) / 86400000);
    const daysHit = days !== null && days >= daysThreshold;
    const factsHit = facts >= factsThreshold;
    if (!daysHit && !factsHit) return '';
    const reason = [
      daysHit ? `距上次架构体检 ${days} 天（阈值 ${daysThreshold} 天）` : '',
      factsHit ? `新增架构事实 ${facts} 条（阈值 ${factsThreshold} 条）` : '',
    ].filter(Boolean).join('；');
    const badNote = badLines > 0 ? `（台账坏行 ${badLines} 条已跳过）` : '';
    return `\n\n【workflow 提醒】${reason}${badNote}——建议发起 architecture-evolve 周期体检（路由表「周期节点」行；台账 .context/architecture-feedback.jsonl）。\n`;
  } catch {
    return ''; // fail-open 静默（不写 stderr，不污染宿主输出；内部规则-23）
  }
}

/** 正整数环境变量读取（仅测试缝）：缺失/非法回缺省。 */
function positiveIntFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** 外部动态提醒阈值缺省（内部决策-052 二期 / 内部规则-8 / 内部模块-8 内部规则-24）。 */
const RADAR_NUDGE_DAYS_DEFAULT = 30;

/** 外部动态记录类型（内部模块-21 内部规则-2 五类；非枚举行计坏行）。 */
const RADAR_RECORD_KINDS = new Set(['source', 'entry', 'brief', 'triage', 'watch']);

/**
 * 外部动态提醒行（内部规则-8 / 内部模块-8 内部规则-24）：读项目 `.context/external-radar.jsonl`，
 * 按 id 取 ts 最新记录后判断：距上次 brief ≥N 天 或 最新状态为 watching 且 expiresAt 已过 ≥1 条；
 * 坏行（含损坏 watch 行）跳过并计数（fail-open；计数进入提醒文案）。
 * 阈值 WF_RADAR_NUDGE_DAYS 可调仅作测试缝。
 * @param {string|null} cwd 宿主负载 cwd
 * @returns {string} 提醒段（空串=不追加）
 */
function radarNudgeLine(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd) return '';
    const root = activationRoot(cwd); // 内部规则-11 激活域判据
    if (!root) return '';
    const ledgerPath = join(root, '.context', 'external-radar.jsonl');
    let text = '';
    try {
      const st = statSync(ledgerPath);
      if (!st.isFile() || st.size > 1000000) return ''; // 读前 stat：超限/非普通文件不读
      text = readFileSync(ledgerPath, 'utf8');
    } catch {
      return ''; // 台账缺席：未启动跟踪不提醒
    }
    const now = Date.now();
    const threshold = positiveIntFromEnv('WF_RADAR_NUDGE_DAYS', RADAR_NUDGE_DAYS_DEFAULT);
    const latest = new Map(); // id → 最新记录（同 ts 取后出现行）
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        badLines += 1;
        continue;
      }
      if (
        !rec ||
        typeof rec !== 'object' ||
        rec.schemaVersion !== 1 ||
        typeof rec.id !== 'string' ||
        typeof rec.kind !== 'string' ||
        typeof rec.ts !== 'string' ||
        typeof rec.summary !== 'string'
      ) {
        badLines += 1;
        continue;
      }
      if (!RADAR_RECORD_KINDS.has(rec.kind)) {
        badLines += 1;
        continue;
      }
      if (rec.kind === 'watch') {
        if (rec.status !== 'watching' && rec.status !== 'expired') {
          badLines += 1;
          continue;
        }
        if (typeof rec.trigger !== 'string' || typeof rec.expiresAt !== 'string' || !Number.isFinite(Date.parse(rec.expiresAt))) {
          badLines += 1;
          continue;
        }
      }
      const ts = Date.parse(rec.ts);
      if (!Number.isFinite(ts)) {
        badLines += 1;
        continue;
      }
      if (ts > now) {
        badLines += 1;
        continue;
      }
      const prev = latest.get(rec.id);
      if (!prev || ts >= prev.ts) latest.set(rec.id, { rec, ts });
    }
    let lastBriefMs = null;
    let dueWatch = 0;
    for (const { rec, ts } of latest.values()) {
      if (rec.kind === 'brief') lastBriefMs = lastBriefMs === null ? ts : Math.max(lastBriefMs, ts);
      if (rec.kind === 'watch' && rec.status === 'watching') {
        const exp = Date.parse(rec.expiresAt);
        if (Number.isFinite(exp) && exp <= now) dueWatch += 1;
      }
    }
    const days = lastBriefMs === null ? null : Math.floor((now - lastBriefMs) / 86400000);
    const daysHit = days !== null && days >= threshold;
    const dueHit = dueWatch >= 1;
    if (!daysHit && !dueHit) return '';
    const reason = [
      daysHit ? `距上次外部动态简报 ${days} 天（阈值 ${threshold} 天）` : '',
      dueHit ? `到期观察项 ${dueWatch} 条` : '',
      badLines > 0 ? `台账坏行 ${badLines} 条已跳过` : '',
    ]
      .filter(Boolean)
      .join('；');
    return `\n\n【workflow 提醒】${reason}——建议发起 external-radar 外部动态跟踪（路由表「周期节点」行；台账 .context/external-radar.jsonl）。\n`;
  } catch {
    return ''; // fail-open 静默
  }
}

/**
 * 内部任务-341/内部决策-070：项目级 skill 索引注入行（清单优先、缺失/损坏回退源扫描）。
 * 无 cwd/非激活域/无项目 skill → 空串；异常 fail-open 静默（不阻断会话启动）。
 * @param {string|null} cwd 负载 cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function projectSkillIndexLine(cwd, env = process.env) {
  try {
    if (!cwd) return '';
    const root = activationRoot(cwd);
    if (!root) return '';
    const info = requiredProjectSkills({ projectRoot: root, env });
    const skills = [...info.required, ...info.advisory];
    const warnLine = info.warning ? `【项目 skill】清单/扫描告警：${info.warning}` : null;
    if (skills.length === 0) return warnLine ? `\n\n${warnLine}\n` : '';
    const lines = renderProjectSkillIndexLines(skills);
    return `\n\n${[...(warnLine ? [warnLine] : []), ...lines].join('\n')}\n`;
  } catch (e) {
    // fail-open 但不静默（内部决策-070 D3）：异常须以告警行可见
    return `\n\n【项目 skill】索引读取异常（fail-open）：${e?.message ?? e}\n`;
  }
}

/** 主流程：注入元技能全文（+ 项目 skill 索引 + 自检告警）。 */
async function main() {
  const root = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? '';
  if (!root) process.exit(0);
  let skill = '';
  try {
    skill = readFileSync(join(root, 'skills', 'workflow', 'SKILL.md'), 'utf8');
  } catch {
    process.exit(0); // 占位/缺失：静默降级，不打断会话启动
  }
  // 内部任务-89：负载单次读取、分发归档消费方（stdin 单次消费，防双读挂起）
  let cwd = null;
  try {
    const parsed = JSON.parse(await readStdin());
    cwd = typeof parsed?.cwd === 'string' && parsed.cwd ? parsed.cwd : null;
  } catch {
    /* 垃圾/空负载：无 cwd 语义（fail-open） */
  }
  const warn = await guardWarnLineSafe(root, cwd); // 自检自身异常：fail-open（空告警）
  await archiveAgedQuiet(cwd); // 内部任务-79：老化归档先于注入帧完成（幂等，无 cwd 即跳过）
  const nudge = scoutNudgeLine(cwd); // 内部任务-89 B2：非激活域轻提醒（内部决策-044）
  const groom = openGroomNudgeLine(cwd); // 内部任务-57：OPEN 存量梳理提醒（超阈值 50）
  const arch = architectureNudgeLine(cwd); // 内部决策-052：架构体检提醒（内部规则-23）
  const radar = radarNudgeLine(cwd); // 内部决策-052 二期：外部动态提醒（内部规则-24）
  const projectSkills = projectSkillIndexLine(cwd, process.env); // 内部任务-341/内部决策-070：项目级 skill 索引＋义务
  // 内部模块-15 v2（内部决策-063 D8/修正案 1 决策 15）：自察就绪面——健康零输出，失败一行可行动告警；
  // 插入位＝自检告警之前（帧序由 内部验收-17 共存用例与 selftest 锁定）。
  const readiness = readinessLineSafe(
    process.env,
    { projectRoot: cwd ? activationRoot(cwd) : null, pluginRoot: root, stateDir: runtimeStateDir() },
    hostOf(),
  );
  // 帧序=正文＋scout 轻提醒＋OPEN 存量提醒＋架构体检提醒＋外部动态提醒＋就绪面＋自检告警（内部验收-17 全序由共存用例锁定）
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: skill + nudge + groom + arch + radar + projectSkills + readiness + warn } }) + '\n'
  );
  process.exit(0);
}

/**
 * 内置自检（B-M8-4，内部任务-8 任务 2.5 补齐——此前无分支静默 exit 0 为假绿）。
 * 夹具用桩钩脚本真跑（mkdtemp 先例同 routing-declare selftest）：三钩全过 / 单钩失败 /
 * 端到端注入两形态 / 自检异常 fail-open。
 * @returns {number} 退出码（失败退 1，可见）
 */
function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'wf-sstart-selftest-'));
  try {
    /** 造桩插件根：桩钩行为按 stubs 定制；SKILL.md 内容可注入；plugin.manifest.json 供目标派生。 */
    const mkRoot = (name, stubs, skillText = '# stub 元技能\n') => {
      const root = join(home, name);
      mkdirSync(join(root, 'hooks'), { recursive: true });
      mkdirSync(join(root, 'skills', 'workflow'), { recursive: true });
      writeFileSync(join(root, 'skills', 'workflow', 'SKILL.md'), skillText);
      for (const t of FALLBACK_GUARD_TARGETS) {
        writeFileSync(join(root, 'hooks', t.file), stubs[t.name] ?? 'process.exit(0);\n');
      }
      writeFileSync(join(root, 'plugin.manifest.json'), JSON.stringify({ hooks: FALLBACK_GUARD_TARGETS.map((t) => ({ event: 'PreToolUse', type: 'process', command: 'node', args: ['${PLUGIN_ROOT}/hooks/' + t.file], timeoutMs: 5000 })) }));
      return root;
    };
    const okRoot = mkRoot('ok', {});
    const badRoot = mkRoot('bad', { 'routing-gate': 'process.exit(3);\n' });
    const fallbackRoot = mkRoot('fallback', {});
    rmSync(join(fallbackRoot, 'plugin.manifest.json'), { force: true });
    // 内部模块-15 v2 就绪面（内部任务-192）：自检子进程须有确定性环境——能力域声明合法（否则就绪面按宿主
    // 缺省可能告警，污染「逐字注入」断言）、hook-errors 状态目录隔离到夹具根（不读真机运行态）。
    const envRoot = (root) => ({
      ...process.env,
      ZCODE_PLUGIN_ROOT: root,
      WF_ROUTING_STATE_DIR: join(home, 'state'),
      WF_OBSERVATION_CAPABILITIES: SELFTEST_CAPABILITIES,
    });
    const runMain = (root, input) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', env: envRoot(root), ...(input === undefined ? {} : { input }) });
    return selftestAsync(checks, check, home, okRoot, badRoot, fallbackRoot, runMain);
  } catch (e) {
    check('自检自身异常 fail-open（不抛）', false);
    for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    console.log(`FAIL session-start.mjs selftest（异常：${e && e.message}）`);
    rmSync(home, { recursive: true, force: true });
    return 1;
  }
}

/**
 * 自检的异步主体（冒烟调用是 async）：与 selftest 分离以便统一收尾打印。
 * @param {Array} checks 结果数组
 * @param {(name: string, cond: unknown) => void} check 收集器
 * @param {string} home 夹具根
 * @param {string} okRoot 全过桩根
 * @param {string} badRoot 单钩失败桩根
 * @param {string} fallbackRoot 缺 hooks.json 的回落桩根
 * @param {(root: string) => {status: number|null, stdout: string}} runMain 子进程驱动
 * @returns {Promise<number>} 退出码
 */
async function selftestAsync(checks, check, home, okRoot, badRoot, fallbackRoot, runMain) {
  try {
    const okTargets = resolveGuardTargets(okRoot).targets;
    const ok = await runGuardSmoke(okRoot, okTargets);
    check('四钩全过夹具 → 零失败项', ok.length === 0);
    const bad = await runGuardSmoke(badRoot, resolveGuardTargets(badRoot).targets);
    check('单钩失败夹具 → 失败项点名 routing-gate', bad.length === 1 && bad[0].name === 'routing-gate');
    const warn = guardWarnLine(bad, okTargets.length);
    check(
      '告警行字面量（含失败名与 N/4 计数）',
      warn.includes('⚠️ 护栏健康自检') && warn.includes('`routing-gate`') && warn.includes('3/4 通过'),
    );
    const good = runMain(okRoot);
    const goodFrame = JSON.parse(good.stdout);
    check(
      '端到端：健康态零告警 + 元技能注入在场',
      good.status === 0 && goodFrame.hookSpecificOutput.additionalContext === '# stub 元技能\n',
    );
    const badRes = runMain(badRoot);
    const badFrame = JSON.parse(badRes.stdout);
    check(
      '端到端：失败态同帧追加告警（注入不受影响）',
      badRes.status === 0 &&
        badFrame.hookSpecificOutput.additionalContext.includes('# stub 元技能') &&
        badFrame.hookSpecificOutput.additionalContext.includes('护栏健康自检'),
    );
    // 工程评审 B1：manifest/hooks.json 均缺失 → 回落静态四钩清单＋告警，注入不得空帧
    const fallen = runMain(fallbackRoot);
    const fallenCtx = JSON.parse(fallen.stdout).hookSpecificOutput.additionalContext;
    check(
      '端到端：manifest 缺失 → 静态回落＋告警且注入仍在',
      fallen.status === 0 && fallenCtx.startsWith('# stub 元技能') && fallenCtx.includes('回退静态四钩清单'),
    );
    const prevCrash = process.env.WF_GUARD_SMOKE_INJECT_CRASH;
    process.env.WF_GUARD_SMOKE_INJECT_CRASH = '1';
    let crashWarn = 'x';
    try {
      crashWarn = await guardWarnLineSafe(okRoot);
    } finally {
      if (prevCrash === undefined) delete process.env.WF_GUARD_SMOKE_INJECT_CRASH;
      else process.env.WF_GUARD_SMOKE_INJECT_CRASH = prevCrash;
    }
    check('自检自身异常 fail-open（注入缝 → 零告警不抛）', crashWarn === '');
    // 内部任务-79：老化归档触发——带 cwd 负载 + WF_INCIDENT_ROOT 指向造好超龄记录的夹具根
    {
      const projDir = join(home, 'proj');
      mkdirSync(join(projDir, '.git'), { recursive: true });
      appendIncident(home, { id: 'ri-aged-1', ts: Date.now() - 31 * 86400000, session: 'sess-aged', kind: 'tool-failure', tool: 'pwsh', errorClass: 'exit-nonzero', digest: 'dgaged000000001' });
      const agedEnv = {
        ...process.env,
        ZCODE_PLUGIN_ROOT: okRoot,
        WF_INCIDENT_ROOT: home,
        WF_ROUTING_STATE_DIR: join(home, 'state'),
        WF_OBSERVATION_CAPABILITIES: SELFTEST_CAPABILITIES,
      };
      const agedRes = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8',
        env: agedEnv,
        input: JSON.stringify({ session_id: 'sess-aged', cwd: projDir }),
      });
      let agedFrame = null;
      try { agedFrame = JSON.parse(agedRes.stdout); } catch { /* 解析失败即断言失败 */ }
      check(
        '归档触发：超龄排除类记录转 archived 且主注入不受影响',
        agedRes.status === 0 &&
          readIncidents(home).find((r) => r.id === 'ri-aged-1')?.status === 'archived' &&
          agedFrame?.hookSpecificOutput?.additionalContext === '# stub 元技能\n',
      );
      const noCwdRes = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8',
        env: agedEnv,
        input: JSON.stringify({ session_id: 'sess-aged' }),
      });
      check('归档触发：无 cwd 负载静默不抛', noCwdRes.status === 0);
    }
    // 内部任务-89 B2：scout 轻提醒三态＋纯函数直断言（内部决策-044）
    {
      const bare = join(home, 'bare');
      mkdirSync(bare, { recursive: true });
      const repo = join(home, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      check(
        'B2 纯函数：null 无提醒/非仓有提醒/仓无提醒',
        scoutNudgeLine(null) === '' && scoutNudgeLine(bare).includes('【workflow 提醒】') && scoutNudgeLine(repo) === '',
      );
      const nudgeRes = runMain(okRoot, JSON.stringify({ cwd: bare }));
      const nudgeCtx = JSON.parse(nudgeRes.stdout).hookSpecificOutput.additionalContext;
      check(
        'B2 端到端：非仓无标记 → 提醒行在场且正文在前',
        nudgeRes.status === 0 && nudgeCtx.startsWith('# stub 元技能\n') && nudgeCtx.includes('【workflow 提醒】'),
      );
      const repoRes = runMain(okRoot, JSON.stringify({ cwd: repo }));
      check('B2 端到端：仓 cwd → 无提醒行（逐字注入）', JSON.parse(repoRes.stdout).hookSpecificOutput.additionalContext === '# stub 元技能\n');
      const junkRes = runMain(okRoot, 'not-json');
      check('B2 端到端：垃圾负载 → 无提醒行 fail-open', JSON.parse(junkRes.stdout).hookSpecificOutput.additionalContext === '# stub 元技能\n');
    }
    // 内部决策-052：架构体检提醒纯函数与端到端（内部规则-23）
    {
      const archRepo = join(home, 'arch-repo');
      mkdirSync(join(archRepo, '.git'), { recursive: true });
      mkdirSync(join(archRepo, '.context'), { recursive: true });
      const oldReviewTs = new Date(Date.now() - 20 * 86400000).toISOString();
      writeFileSync(
        join(archRepo, '.context', 'architecture-feedback.jsonl'),
        JSON.stringify({ schemaVersion: 1, id: 'r1', kind: 'review', ts: oldReviewTs, summary: 'x', status: 'recorded' }) + '\n',
      );
      const archBare = join(home, 'arch-bare');
      mkdirSync(archBare, { recursive: true });
      const archActiveNoLedger = join(home, 'arch-active-no-ledger');
      mkdirSync(join(archActiveNoLedger, '.git'), { recursive: true });
      check('ADR-052 纯函数：天数阈命中返回提醒行', architectureNudgeLine(archRepo).includes('architecture-evolve'));
      check('ADR-052 纯函数：无 cwd/非激活域静默', architectureNudgeLine(null) === '' && architectureNudgeLine(archBare) === '');
      check('ADR-052 纯函数：激活域但无台账静默（missing-ledger 分支）', architectureNudgeLine(archActiveNoLedger) === '');
      const archRes = runMain(okRoot, JSON.stringify({ cwd: archRepo }));
      const archCtx = JSON.parse(archRes.stdout).hookSpecificOutput.additionalContext;
      check('ADR-052 端到端：仓 cwd + 超阈台账 → 提醒行注入', archRes.status === 0 && archCtx.startsWith('# stub 元技能\n') && archCtx.includes('architecture-evolve'));
    }
    // 内部决策-052 二期：外部动态提醒纯函数与端到端（内部规则-8 / 内部模块-8 内部规则-24）
    {
      const radarRepo = join(home, 'radar-repo');
      mkdirSync(join(radarRepo, '.git'), { recursive: true });
      mkdirSync(join(radarRepo, '.context'), { recursive: true });
      writeFileSync(
        join(radarRepo, '.context', 'external-radar.jsonl'),
        JSON.stringify({ schemaVersion: 1, id: 'b1', kind: 'brief', ts: new Date(Date.now() - 40 * 86400000).toISOString(), summary: 'x', status: 'published' }) + '\n',
      );
      const radarBare = join(home, 'radar-bare');
      mkdirSync(join(radarBare, '.context'), { recursive: true });
      writeFileSync(
        join(radarBare, '.context', 'external-radar.jsonl'),
        JSON.stringify({ schemaVersion: 1, id: 'b1', kind: 'brief', ts: new Date(Date.now() - 40 * 86400000).toISOString(), summary: 'x', status: 'published' }) + '\n',
      );
      const radarNoLedger = join(home, 'radar-active-no-ledger');
      mkdirSync(join(radarNoLedger, '.git'), { recursive: true });
      check('ADR-052 二期 纯函数：天数阈命中返回提醒行', radarNudgeLine(radarRepo).includes('external-radar'));
      check('ADR-052 二期 纯函数：无 cwd/非激活域静默', radarNudgeLine(null) === '' && radarNudgeLine(radarBare) === '');
      check('ADR-052 二期 纯函数：激活域但无台账静默', radarNudgeLine(radarNoLedger) === '');
      const radarRes = runMain(okRoot, JSON.stringify({ cwd: radarRepo }));
      const radarCtx = JSON.parse(radarRes.stdout).hookSpecificOutput.additionalContext;
      check('ADR-052 二期 端到端：仓 cwd + 超阈台账 → 提醒行注入', radarRes.status === 0 && radarCtx.startsWith('# stub 元技能\n') && radarCtx.includes('external-radar'));
    }
    // 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063 修正案 1）：能力域镜像 resolver 与就绪面告警行
    {
      const capZ = resolveCapabilities(undefined, loadContract(), 'zcode');
      const capD = resolveCapabilities(undefined, loadContract(), 'dsh');
      check('v2 能力域镜像：ZCode 缺省原生零告警 / DSH 缺省保守降级', capZ.ok && !capZ.degraded && capZ.source === 'mirror' && capD.ok && capD.degraded);
      check(
        'v2 能力域 env：合法声明解析 / 非法 JSON 保守降级',
        resolveCapabilities(SELFTEST_CAPABILITIES, loadContract(), 'dsh').ok === true && resolveCapabilities('{bad', loadContract(), 'dsh').ok === false,
      );
      const readyRepo = join(home, 'ready-repo');
      mkdirSync(join(readyRepo, '.git'), { recursive: true });
      const readyHealthy = readinessLine(
        { ...process.env, WF_OBSERVATION_CAPABILITIES: SELFTEST_CAPABILITIES },
        { projectRoot: readyRepo, pluginRoot: okRoot, stateDir: join(home, 'ready-state') },
        'zcode',
      );
      check('v2 就绪面健康零输出（八项全过 ⇒ 空串）', readyHealthy === '');
      const readyBad = readinessLine(
        { WF_INCIDENT_RULES_PATH: join(home, 'no-such-rules.json') },
        { projectRoot: readyRepo, pluginRoot: okRoot, stateDir: join(home, 'ready-state') },
        'dsh',
      );
      check(
        'v2 就绪面失败一行（能力域未声明 + 规则表 + canary）',
        readyBad.includes('自察就绪面') && readyBad.includes('能力域未声明（宿主 dsh') && readyBad.includes('规则表不可加载') && readyBad.includes('canary 失败'),
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  for (const [name, ok2] of checks) console.log(`${ok2 ? 'PASS' : 'FAIL'} ${name}`);
  const failedCount = checks.filter(([, ok2]) => !ok2).length;
  if (failedCount === 0) {
    console.log(`OK session-start.mjs selftest（${checks.length} 项通过）`);
    return 0;
  }
  console.log(`FAIL session-start.mjs selftest（${failedCount}/${checks.length} 失败）`);
  return 1;
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
    process.exit(await selftest()); // selftest 失败须可见退 1：陷阱不装（B-M8-4 优先）
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('用法：session-start.mjs [选项]\n  （无参数）从环境读插件根，注入元技能全文（含护栏健康自检告警）\n  --selftest 运行内置自检（B-M8-4）\n  --help    显示本说明\n');
    process.exit(0);
  }
  installHookErrorTrap('session-start'); // B1①：漏网抛错落 hook-errors.jsonl（fail-open 不破）
  runHookMain('session-start', main);
}
