// 文件：retro-metrics.mjs
// 描述：retro 周期回顾的指标采集脚本（内部规则-2、内部决策-1 首选案：纯 Node + git CLI，
//       零第三方依赖）——读取仓库提交历史，输出指标 JSON 供 retro skill 解读：
//       weightedCommits（按改动规模加权的提交得分）、sessions（会话数）、
//       fixRatio（修复类提交占比）、focusScore（主目录改动占比）、
//       selfCheckHeat（自察热度：open 计数 + 30 天 digest 聚合 Top3，内部模块-15/内部决策-019；
//       2026-10-24 内部任务-192/内部决策-063 D7 增分类面 causeCounts/dispositionRate/
//       oldestPendingAgeDays/lostFacts——旧键不变，全部为加法键）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 用法：node workflow/scripts/retro-metrics.mjs [repoPath]（缺省 .）
// 输出：stdout 单个 JSON 对象 { weightedCommits, sessions, fixRatio, focusScore, selfCheckHeat, generatedAt }
// 退出码：0=成功（含零提交仓库）；1=非 git 仓库 / git 不可用。
import { pathToFileURL } from 'node:url';
import {
  DAY_MS,
  countCauses,
  countLostFacts,
  isEvidenceFace,
  isPendingIncidentV2,
  readIncidents,
} from './lib/incident-store.mjs';
import { spawnGitSync, isEmptyRepoStderr } from './lib/git-exec.mjs';

/** 会话切分阈值（毫秒）：相邻提交间隔严格大于 45 分钟才算新会话。 */
const SESSION_GAP_MS = 45 * 60 * 1000;
/** 单提交加权得分上限：防止巨型提交（如批量格式化）淹没整期指标。 */
const WEIGHT_CAP = 20;
/** 修复类提交关键词：conventional 前缀 fix/fixes/fixed、resolve 系、中文「修复」。 */
const FIX_MESSAGE_RE = /\bfix(?:es|ed)?\b|\bresolve[ds]?\b|修复/i;

/**
 * 在指定目录执行 git 命令。
 * 为什么走 `scripts/lib/git-exec.mjs` 而非直接 spawnSync：助手统一承载 `WF_GIT_BIN`
 * 注入口（内部规则-25 登记测试缝，`.mjs` 经 node 解释器执行）并把 locale 固定为 C——本脚本
 * 随后按**英文错误文案**判定空仓（`does not have any commits yet`），该匹配的前提正是
 * C locale（内部任务-345：否则中文 locale 下合法空仓被当成真错误、CLI 误退 1）。
 * 不传 timeout/maxBuffer：本脚本的 git log 需要既有缺省预算（大仓），不得注入钩子的 2s/4MB。
 * @param {string} repoPath 工作目录
 * @param {string[]} args git 参数
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error }}
 */
function runGit(repoPath, args) {
  const r = spawnGitSync(args, { cwd: repoPath });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

/**
 * 判断路径是否为 git 仓库（工作树内即可，含子目录）。
 * @param {string} repoPath 待判定路径
 * @returns {boolean}
 */
function isGitRepo(repoPath) {
  const r = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

/**
 * 解析一行 numstat 输出（ins \t del \t path）。
 * 为什么单独成函数：这是与 git 输出格式的唯一耦合点，收拢后其余解析逻辑不感知
 * 制表符细节；三种非常规形态在此归一——二进制文件（-）按 0 行计、重命名行
 * （old => new）落新路径、路径含制表符（slice 后重新拼接）。
 * @param {string} line numstat 行
 * @returns {{ path: string, ins: number, del: number } | null} 解析结果；非 numstat 形态返回 null
 */
function parseNumstatLine(line) {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const ins = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
  const del = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
  let path = parts.slice(2).join('\t');
  const arrow = path.lastIndexOf(' => ');
  if (arrow !== -1) path = path.slice(arrow + 4);
  return { path, ins, del };
}

/**
 * 采集提交历史：每条提交带哈希、作者时间、主题与文件级增删行数。
 * 为什么用作者时间（%aI）而非提交时间：作者时间反映工作发生的时刻，会话切分
 * 应贴近实际工作节律；rebase/cherry-pick 会重写提交时间，但保留作者时间。
 * 为什么排除 merge 提交（--no-merges）：merge 的 numstat 是冲突解的补丁，
 * 与真实工作量语义不同，计入会让加权得分虚高。
 * 周期边界（内部规则-8）：since/until 映射 git log --since/--until；base 为基线引用
 * （tag/分支/哈希），存在时限定为该基线之后的提交（base..HEAD）。
 * @param {string} repoPath 仓库路径
 * @param {{ since?: string, until?: string, base?: string }} [range] 周期边界
 * @returns {Array<{ hash: string, date: Date, subject: string, files: Array<{ path: string, ins: number, del: number }> }>}
 *          提交列表（按 git log 输出序，新→旧）；零提交仓库返回 []
 */
function collectCommits(repoPath, range = {}) {
  const SEP = '\u001f';
  const rangeArgs = [];
  if (range.base) rangeArgs.push(`${range.base}..HEAD`);
  if (range.since) rangeArgs.push(`--since=${range.since}`);
  if (range.until) rangeArgs.push(`--until=${range.until}`);
  const r = runGit(repoPath, [
    '-c', 'core.quotepath=false',
    'log', '--no-merges',
    ...rangeArgs,
    `--format=${SEP}%H${SEP}%aI${SEP}%s`,
    '--numstat',
  ]);
  // 零提交仓库：git log 以 128 退出（"does not have any commits yet"），是唯一合法空集；
  // 其余非零退出（坏 --base 的 "unknown revision/ambiguous argument" 等）是真错误——
  // 折成空集会产出全零指标假绿，上抛 null 由主流程按 error JSON 退 1（isGitRepo 先例
  // 姿态，2026-09-19 评审修复；自查实录：首版把 unknown revision 误列入白名单，实测纠正）
  if (r.status !== 0) {
    const errText = `${r.stderr ?? ''}`;
    if (isEmptyRepoStderr(errText)) return [];
    return null;
  }
  /** @type {Array<{ hash: string, date: Date, subject: string, files: Array<{ path: string, ins: number, del: number }> }>} */
  const commits = [];
  for (const rawLine of r.stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // CRLF 容错
    if (line.startsWith(SEP)) {
      const [hash, dateStr, subject] = line.slice(SEP.length).split(SEP);
      commits.push({ hash, date: new Date(dateStr), subject: subject ?? '', files: [] });
      continue;
    }
    if (!line.trim() || commits.length === 0) continue;
    const stat = parseNumstatLine(line);
    if (stat) commits[commits.length - 1].files.push(stat);
  }
  return commits;
}

/**
 * weightedCommits：按改动规模加权的提交得分——单提交权重 = 文件数 ×(新增+删除行数)，
 * 上限 WEIGHT_CAP；总分 = 各提交权重之和。为什么加权：裸提交数把"改一行"与
 * "改一个模块"计为等同，加权后更接近工作量；为什么设上限：单次大批量改动
 * （vendored 引入、格式化）不应淹没整期信号。
 * @param {Array<{ files: Array<{ ins: number, del: number }> }>} commits 提交列表
 * @returns {number} 加权总分
 */
function computeWeightedCommits(commits) {
  let total = 0;
  for (const c of commits) {
    const lines = c.files.reduce((sum, f) => sum + f.ins + f.del, 0);
    total += Math.min(c.files.length * lines, WEIGHT_CAP);
  }
  return total;
}

/**
 * sessions：按提交时间间隔切分的会话数——相邻提交间隔严格大于 SESSION_GAP_MS
 * 即开新会话。为什么用「严格大于」：恰好在阈值上的间隔归同一会话，边界行为
 * 可预期（测试已锁定）。局限（供解读，不在本函数处理）：提交时间≠编码时间，
 * 提交习惯（攒批提交）会改变切分结果。
 * @param {Array<{ date: Date }>} commits 提交列表
 * @returns {number} 会话数
 */
function computeSessions(commits) {
  const times = commits.map((c) => c.date.getTime()).sort((a, b) => a - b);
  let sessions = 0;
  for (let i = 0; i < times.length; i++) {
    if (i === 0 || times[i] - times[i - 1] > SESSION_GAP_MS) sessions++;
  }
  return sessions;
}

/**
 * fixRatio：修复类提交占比——主题匹配 FIX_MESSAGE_RE 的提交数 / 总提交数。
 * 局限：关键词匹配有误报（"fix typo in docs" 也计入）与漏报（未按惯例写消息），
 * 解读时当方向信号而非精确值。
 * @param {Array<{ subject: string }>} commits 提交列表
 * @returns {number} 占比（0..1，四舍五入到 4 位小数）；零提交返回 0
 */
function computeFixRatio(commits) {
  if (commits.length === 0) return 0;
  const fixed = commits.filter((c) => FIX_MESSAGE_RE.test(c.subject)).length;
  return round4(fixed / commits.length);
}

/**
 * focusScore：聚焦度——改动最集中的顶层目录的文件改动次数占比。高值=深耕单一
 * 区域，低值=跨域切换多；根目录文件（无斜杠）归入 (root) 桶。
 * @param {Array<{ files: Array<{ path: string }> }>} commits 提交列表
 * @returns {number} 占比（0..1，四舍五入到 4 位小数）；零文件改动返回 0
 */
function computeFocusScore(commits) {
  /** @type {Map<string, number>} */
  const dirs = new Map();
  let total = 0;
  for (const c of commits) {
    for (const f of c.files) {
      const top = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
      dirs.set(top, (dirs.get(top) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return 0;
  return round4(Math.max(...dirs.values()) / total);
}

/**
 * 比率四舍五入到 4 位小数——为什么统一处理：快照对比与趋势展示需要稳定的
 * 序列化值，浮点尾数（如 0.4000000000000001）只会制造假差异。
 * @param {number} v 原始比率
 * @returns {number} 圆整后的比率
 */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** 自察热度窗口：30 天（与 incident-store 的 heat 窗口同口径，retro 周期口径）。 */
const HEAT_WINDOW_MS = 30 * DAY_MS;

/**
 * 自察热度（内部模块-15/内部决策-019，内部规则-5；2026-10-24 内部任务-192 扩面）：读 repoPath 下 `内部工作流状态`——
 * 旧键＝open 计数 + 30 天窗口 digest 聚合 Top3；v2 加法键＝
 *  · `causeCounts`：30 天窗口按 cause 分组（缺 cause 旧行归 unclassified）；
 *  · `dispositionRate`：窗内「已处置（resolved/archived）的非证据面记录」占「窗内非证据面总量」
 *    （分母 0 时给 0，不除零）；
 *  · `oldestPendingAgeDays`：当前最老待排查（v2 谓词，只认 open）的天数（无待排查给 0）；
 *  · `lostFacts`：兜底旁路非空行数（emit 失败计数；缺失 0）。
 * 内部任务-244 Q05/Q06：**单次读盘**派生全部自察指标（原 openCount/heat 各再整读一次＝一次指标
 * 三次读盘、快照可能不一致）；证据面谓词改用 incident-store 单源 `isEvidenceFace`（读规则表）。
 * @param {string} root 仓库根（运行自察记录同根）
 * @param {{reader?: (file: string) => string}} [opts] 仅测试注入（读次数计数；生产零行为）
 * @returns {{open: number, top: Array<{digest: string, kind: string|null, count: number, lastTs: number}>,
 *            causeCounts: Record<string, number>, dispositionRate: number, oldestPendingAgeDays: number, lostFacts: number}}
 */
export function computeSelfCheckHeat(root, opts = {}) {
  const now = Date.now();
  const rows = readIncidents(root, opts.reader ? { reader: opts.reader } : null);
  // 内部决策-063 修正案 3 决策 24.1：先按 30 天窗过滤得 windowRows，再 `countCauses(windowRows)`
  // （**无零键**——保持既有用例的 deepEqual 口径：键集＝窗内实计 cause）。
  const windowRows = rows.filter((r) => {
    const ts = Number(r?.ts);
    return Number.isFinite(ts) && now - ts <= HEAT_WINDOW_MS;
  });
  const causeCounts = countCauses(windowRows);
  let nonEvidence = 0;
  let disposed = 0;
  for (const r of windowRows) {
    if (isEvidenceFace(r)) continue; // Q06：单源谓词（规则表 evidenceCauses）
    nonEvidence += 1;
    if (r.status === 'resolved' || r.status === 'archived') disposed += 1;
  }
  let oldestTs = null;
  for (const r of rows) {
    if (!isPendingIncidentV2(r)) continue;
    const ts = Number(r?.ts);
    if (!Number.isFinite(ts)) continue;
    oldestTs = oldestTs === null ? ts : Math.min(oldestTs, ts);
  }
  // 旧键 open 与 Top3 热度从同一 rows/windowRows 派生（Q05：与 incident-store heat 同算法）
  const open = rows.filter((r) => r.status === 'open').length;
  const by = new Map();
  for (const r of windowRows) {
    const key = typeof r.digest === 'string' && r.digest ? r.digest : '?';
    const e = by.get(key) ?? { digest: key, kind: typeof r.kind === 'string' ? r.kind : null, count: 0, lastTs: 0 };
    e.count += 1;
    e.lastTs = Math.max(e.lastTs, Number(r.ts));
    by.set(key, e);
  }
  const top = [...by.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, 3);
  return {
    open,
    top,
    causeCounts,
    dispositionRate: nonEvidence === 0 ? 0 : round4(disposed / nonEvidence),
    oldestPendingAgeDays: oldestTs === null ? 0 : Math.max(0, Math.floor((now - oldestTs) / DAY_MS)),
    lostFacts: countLostFacts(root), // 评审修复 N4：与 SessionStart 就绪面/digest 同源单点
  };
}

/**
 * 汇总指标——输出契约（六键：原四指标 + selfCheckHeat + generatedAt）的唯一组装点，
 * 新增指标只改这里。
 * @param {Array<{ hash: string, date: Date, subject: string, files: Array<{ path: string, ins: number, del: number }> }>} commits 提交列表
 * @param {{ open: number, top: Array<object> }} selfCheckHeat 自察热度（内部模块-15，main 侧计算传入）
 * @returns {{ weightedCommits: number, sessions: number, fixRatio: number, focusScore: number, selfCheckHeat: object, generatedAt: string }}
 */
function computeMetrics(commits, selfCheckHeat = { open: 0, top: [] }) {
  return {
    weightedCommits: computeWeightedCommits(commits),
    sessions: computeSessions(commits),
    fixRatio: computeFixRatio(commits),
    focusScore: computeFocusScore(commits),
    selfCheckHeat,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 解析命令行参数：[repoPath] [--since <ISO|日期>] [--until <ISO|日期>] [--base <ref|hash>]。
 * 兼容旧形态（裸路径第一参），周期参数映射到 git log 的 --since/--until；
 * --base 提供基线引用（tag/分支/哈希），指标只统计该基线之后的提交。
 * @returns {{ repoPath: string, since?: string, until?: string, base?: string, rangeMode: boolean }}
 */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since' || a === '--until' || a === '--base') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} 需要一个值`);
      opts[a.slice(2)] = v;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return {
    repoPath: positional[0] ?? '.',
    since: opts.since,
    until: opts.until,
    base: opts.base,
    rangeMode: Boolean(opts.since || opts.until || opts.base),
  };
}

/**
 * 主入口：校验仓库 → 采集（可带周期边界）→ 计算 → 输出 JSON。
 * 非仓库路径输出 { error } 并退 1——错误也走 stdout 的 JSON 信封，
 * 消费方（retro skill）只需解析 stdout 一种格式。
 * 周期口径（内部规则-8）：带 --since/--until/--base 时输出附 period 字段；
 * 无边界参数时输出附 period.range='full-history'——不得把全历史冒充「本周期」。
 * @returns {void}
 */
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err.message) }) + '\n');
    process.exit(1);
  }
  const { repoPath, since, until, base } = args;
  if (!isGitRepo(repoPath)) {
    process.stdout.write(JSON.stringify({ error: `${repoPath} 不是 git 仓库（git rev-parse --is-inside-work-tree 未通过）` }) + '\n');
    process.exit(1);
  }
  const period = args.rangeMode
    ? { range: 'bounded', since: since ?? null, until: until ?? null, base: base ?? null }
    : { range: 'full-history', since: null, until: null, base: null };
  const commits = collectCommits(repoPath, { since, until, base });
  if (commits === null) {
    // git log 真错误（坏 --base 等）——2026-09-19 评审修复：不得折成空集产出全零指标假绿
    const why = base ? `（--base ${base}：引用不存在或范围非法）` : '（git 报错或仓库异常）';
    process.stdout.write(JSON.stringify({ error: `git log 采集失败${why}，指标未计算` }) + '\n');
    process.exit(1);
  }
  const metrics = computeMetrics(commits, computeSelfCheckHeat(repoPath));
  process.stdout.write(JSON.stringify({ ...metrics, period }) + '\n');
  process.exit(0);
}

// 内部任务-244 Q09：直跑判定（import 供测试时不得触发 main）
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
