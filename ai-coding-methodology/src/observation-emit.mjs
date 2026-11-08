// 文件：observation-emit.mjs
// 描述：DSH 适配层的观测事实上报封装（内部接口-26 「运行观测事件接入」＋ 内部决策-063 修正案 1
//       决策 14，2026-10-24 内部任务-192 P2）。核心无法自行观测的失败事实（本层「PostToolUse
//       观测面全暗」哨兵、能力缺口）经 `incident-cli emit` 上报；**唯一写者纪律**：本模块
//       不写 `内部工作流状态`，只 spawn 提供方的 CLI（消费方不得复制存储语义，见
//       内部接口-26 §3）。
//       失败兜底旁路：emit 失败（exit≠0／超时／跨单元路径不可得）时写
//       `内部工作流状态`——**非账本、非事实源**（修正案 1 决策 14）：每行
//       固定 `{schemaVersion,ts,kind,observationSource,count,digest}`，**禁命令/路径/stdout/
//       stderr/错误原文**；保留上限 200 行（先 append 保不丢行，超限 tmp+rename 原子轮转，
//       修正案 3 决策 22.1）；人工回放通道 `incident-cli emit --from-lost` 已实现
//       （修正案 3 决策 22，内部任务-195；本模块不写账本，回放在核心侧单写者内完成）。
//       **2026-11-04 内部任务-320**：旁路行的 `kind` 固定为 `observation-degraded`（回放侧规定性
//       固定值，见决策 22.2）——此前抄来件 kind（派发失败事实为 `hook-failure`）⇒ 旁路行
//       永远被判 invalid、回放恒不可用（内部未决-284）；来件原始 kind 由 digest 指纹保留可追溯性。
//       姿态：全链 fail-open——emit 失败不阻断宿主派发；`spawn` 可注入（测试缝），
//       日志失败不反噬（logWarn 由调用方注入）。
// 作者：wangp  创建：2026-10-24  版权：MIT（见仓库 LICENSE）
// 用法：被 `src/index.mjs`（全暗哨兵分支）消费；`node` 直跑无副作用（纯库）。
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 本层观测来源标识（内部接口-26 §2 的短串形态 `adapter:<宿主>`）。 */
export const OBSERVATION_SOURCE = 'adapter:dsh';

/**
 * DSH 运行观测能力域声明（内部决策-063 修正案 1 决策 13；事实源＝内部接口-1「运行观测能力登记」
 * 的 DSH 列）：失败事实供给＝适配层供给（合成 `{is_error,exit_code,error_code}` 且仅已派发
 * 透传）；钩失败观测面＝适配层供给，经 内部接口-26 emit 上报（无宿主派发日志）；
 * 提醒注入时效＝注入位（即时）；自检可达性＝钩 `--selftest`＋适配层测试。
 * 该对象由 `src/index.mjs` 的 `dispatch()` 序列化后以环境变量
 * **`WF_OBSERVATION_CAPABILITIES`** 注入每个钩子子进程（session-start 就绪面消费）。
 * 取值是**声明形态短串**（镜像 `declarationGrammar` 域），非五态登记词表本身——五态分类
 * 见 `workflow/scripts/lib/observation-capability-contract.json` 的 dsh 行（对拍由测试把守）。
 */
export const DSH_OBSERVATION_CAPABILITIES = Object.freeze({
  failureFacts: 'adapter',
  hookFailure: 'adapter-emit',
  injection: 'immediate',
  selfCheck: 'selftest+adapter-tests',
});

/** 兜底旁路文件相对项目根的路径（内部接口-26 §3.1 固定位置）。 */
export const LOST_FACTS_REL_PATH = join('.workflow', 'incidents-lost.jsonl');

/** 兜底旁路保留上限（修正案 1 决策 14：超出滚动丢弃最旧行）。 */
export const LOST_FACTS_MAX_LINES = 200;

/**
 * emit 子进程超时预算：走同步 spawnSync（在宿主 waterfall 监听器内），故以 3s 封顶最坏阻塞；
 * 本路径每会话至多一次（全暗哨兵去重）且 CLI 是本地进程。超时按失败走兜底旁路，不阻断派发。
 */
export const EMIT_TIMEOUT_MS = 3_000;

/**
 * 兜底旁路文件绝对路径。
 * 根推导与 workflow 侧 `incident-store.incidentFile` 同源：测试隔离注入缝
 * `WF_INCIDENT_ROOT` 优先（否则 ledger 落别处而旁路落项目根，两侧读数会分叉——
 * SessionStart 就绪面/retro `lostFacts`/`digest` 都按同一目录读）。
 * @param {string} projectRoot 项目根（会话 cwd）
 * @returns {string}
 */
export function lostFactsPath(projectRoot) {
  const root = process.env.WF_INCIDENT_ROOT ?? String(projectRoot ?? '.');
  return join(root, LOST_FACTS_REL_PATH);
}

/**
 * 事实摘要（脱敏）：只对**结构化事实的键值**取 sha256 前 16 位——绝不存原文；
 * 用于兜底旁路行的 `digest`，让操作者能对齐「哪条上报失败了」而不必读原文。
 * @param {object} fact 观测事实（白名单字段）
 * @returns {string} 16 位十六进制摘要
 */
export function digestOfFact(fact) {
  const keys = Object.keys(fact ?? {}).sort();
  const parts = keys.map((key) => `${key}=${typeof fact[key] === 'object' ? JSON.stringify(fact[key]) : String(fact[key])}`);
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * 追加一行兜底旁路并执行上限滚动（丢弃最旧行并计数）——**原子轮转**（内部决策-063 修正案 3
 * 决策 22.1，内部任务-195）：
 *   ① 先 `appendFileSync` 追加新行（即使轮转中途崩溃也**不丢行**——最多留 max+1 行，
 *      下次追加再轮转）；
 *   ② 仅当非空行数超上限时，取**末 N 行**（新行在 append 后恰出现一次，不再额外拼接）
 *      写入同目录 tmp 文件，再 `renameSync` **原子替换**（读侧永不见半截文件）；
 *   ③ 崩溃于 rename 前最多留 max+1 行、不残留 `.tmp-*`（写/替换失败即清 tmp）。
 * 写失败**不抛**（返回 `{ok:false}`）：兜底旁路自身失败不得反噬宿主派发路径。
 * @param {string} path 兜底旁路文件路径
 * @param {Record<string, unknown>} record 固定六键记录（调用方保证脱敏）
 * @param {{maxLines?: number}} [opts]
 * @returns {{ok: boolean, lines: number, dropped: number}}
 */
export function appendLostFact(path, record, opts = {}) {
  const maxLines = Number.isSafeInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : LOST_FACTS_MAX_LINES;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
    if (lines.length <= maxLines) return { ok: true, lines: lines.length, dropped: 0 };
    const kept = lines.slice(lines.length - maxLines);
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* tmp 清理失败不反噬（文件仍可读，最坏留一个同名前缀临时件） */
      }
      throw error;
    }
    return { ok: true, lines: kept.length, dropped: lines.length - maxLines };
  } catch {
    return { ok: false, lines: 0, dropped: 0 };
  }
}

/**
 * 构造「观测面全暗」降级事实（内部接口-26 白名单内字段，无原文）。
 * 语义：PostToolUse 派发面事件累计 ≥3 次而经派发点命中 0 次——本层观测面可能整体全暗。
 * `note` 只放**结构化类别名**（不写会话 id/路径/命令）。
 * @param {{sessionId?: string, count?: number, dispatchFactSeen?: boolean, now?: number}} [arg]
 * @returns {object} ObservationFact（可直接交 emit）
 */
export function buildObservationDegradedFact(arg = {}) {
  const count = Number.isFinite(arg.count) ? arg.count : 0;
  const fact = {
    schemaVersion: 1,
    kind: 'observation-degraded',
    observationSource: OBSERVATION_SOURCE,
    ts: Number.isFinite(arg.now) ? arg.now : Date.now(),
    host: 'dsh',
    event: 'PostToolUse',
    count,
    note: arg.dispatchFactSeen === true ? 'dispatch-criterion-drift' : 'dispatch-fact-absent',
  };
  if (typeof arg.sessionId === 'string' && arg.sessionId !== '') fact.session = arg.sessionId;
  return fact;
}

/**
 * 建一个 emit 器（每次 `apply` 一个，闭包持有「失败只告警一次」状态）。
 * @param {object} [opts]
 * @param {typeof spawnSync} [opts.spawn] 子进程执行器（**测试注入缝**；缺省 node:child_process.spawnSync）
 * @param {string} [opts.cliPath] 提供方 CLI 绝对路径（`<workflow 插件根>/scripts/incident-cli.mjs`）；
 *   跨单元路径不可得时按失败走兜底旁路（内部接口-26 §3.1 的「路径不可得」形态）
 * @param {(message: string) => void} [opts.warn] 失败告警出口（调用方注入 logWarn；每闭包至多一条）
 * @param {number} [opts.maxLines] 兜底旁路保留上限（测试可调小）
 * @returns {{emitFact: (fact: object, target?: {projectRoot?: string}) => {ok: boolean, reason?: string, lost?: boolean, dropped?: number}}}
 */
export function createObservationEmitter(opts = {}) {
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : spawnSync;
  const cliPath = typeof opts.cliPath === 'string' && opts.cliPath !== '' ? opts.cliPath : '';
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  // 超时预算固定 EMIT_TIMEOUT_MS（内部决策-063 修正案 3 决策 24.1：删除无调用方的可选参数，
  // 防「声明超时 ≠ 实际超时」的第二配置面）。
  const maxLines = Number.isSafeInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : LOST_FACTS_MAX_LINES;
  let lostWarned = false;

  return {
    /**
     * 上报一条观测事实；任何失败（含 spawn 抛错/超时/退出码非 0/路径不可得）都**不抛**：
     * 写兜底旁路 + 首次告警一次。
     * @param {object} fact 白名单字段的观测事实
     * @param {{projectRoot?: string}} [target]
     * @returns {{ok: boolean, reason?: string, lost?: boolean, dropped?: number}}
     */
    emitFact(fact, target = {}) {
      const projectRoot = typeof target.projectRoot === 'string' && target.projectRoot !== '' ? target.projectRoot : '.';
      if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) return { ok: false, reason: 'fact-not-object' };
      let failure = '';
      if (cliPath === '') failure = 'cli-unavailable';
      if (failure === '') {
        try {
          const result = spawn(process.execPath, [cliPath, 'emit', '--project-root', projectRoot], {
            input: `${JSON.stringify(fact)}\n`,
            encoding: 'utf8',
            timeout: EMIT_TIMEOUT_MS,
            killSignal: 'SIGTERM',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          if (result === null || typeof result !== 'object') failure = 'spawn-no-result';
          else if (result.error) failure = 'spawn-error';
          else if (result.status !== 0) failure = `exit-${String(result.status)}`;
        } catch {
          failure = 'spawn-throw';
        }
      }
      if (failure === '') return { ok: true };
      const lost = appendLostFact(
        lostFactsPath(projectRoot),
        {
          schemaVersion: 1,
          ts: Number.isFinite(fact.ts) ? fact.ts : Date.now(),
          // 内部任务-320（内部未决-284）：旁路行 kind 固定为 `observation-degraded`——回放侧的规定性固定值
          // （内部决策-063 修正案 3 决策 22.2：回放逐行校验六键后按 kind=observation-degraded 走 emit
          // 白名单/终态校验/落账，**旁路行 kind 非此值按 invalid 跳过**）。此前本行抄来件 kind
          // （适配层派发失败事实为 `hook-failure`）⇒ 旁路行永远无法回放（回放恒不可用）。
          // 来件的原始 kind 仍由 digest（digestOfFact 覆盖全字段指纹）保留可追溯性；旁路行按
          // 内部决策-063 修正案 1 决策 14 只允许六键，不另加字段。
          kind: 'observation-degraded',
          observationSource: String(fact.observationSource ?? ''),
          // 2026-11-04 收尾评审 correctness #2：`count` 必须落在**核心回放侧可接受域**
      // （`incident-cli` 的 `parseLostLine` 要求安全整数且 ≥0）——否则旁路行被判 invalid、
      // 回放恒不可用（与 内部未决-284 修复前同型失效）。域外值（非整数/负数/非有限）归 0。
      count: Number.isSafeInteger(fact.count) && fact.count >= 0 ? fact.count : 0,
          digest: digestOfFact(fact),
        },
        { maxLines },
      );
      if (!lostWarned) {
        lostWarned = true;
        warn(
          `ai-coding-methodology: 观测事实上报失败（${failure}），已写兜底旁路 .workflow/incidents-lost.jsonl` +
            '（非账本、非事实源；人工回放通道已实现（DEV-195）；不阻断本钩子派发，本会话仅提示一次）',
        );
      }
      return { ok: false, reason: failure, lost: lost.ok, dropped: lost.dropped };
    },
  };
}
