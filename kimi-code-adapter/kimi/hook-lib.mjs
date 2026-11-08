// 文件：kimi-code-adapter/kimi/hook-lib.mjs
// 描述：Kimi Code 适配层的 shim 共享小工具（随包物化到 <包根>/kimi/）。四块职责：
//       ① 状态面——待投递提醒队列与 Stop 连击计数，落在 $KIMI_CODE_HOME/plugin-data/<插件id>/
//       （宿主注入缺席时退回 <包根>/../plugin-data/<插件id>/，运行中包被重写不丢队列）；
//       ② 负载面——Kimi 原生负载归一成 ZCode 形态（多键兼容读取 tool_name|name、prompt|text、
//       tool_result|tool_response，写类入参 path→file_path 补写保留原键，来源词表交引擎归一）；
//       ③ 响应面——PreToolUse 信封译成 Kimi 宿主母语位（deny 双通道 JSON+exit 2+stderr、
//       ask 保守翻 deny）；UserPromptSubmit / Stop 的阻断与投递译出在 shim 内联，
//       观察面帧一律交调用方入待投递队列（宿主观察面无注入位）；
//       ④ 能力域面——运行观测能力域声明（`WF_OBSERVATION_CAPABILITIES`）注入钩子子进程 env，
//       供核心 内部模块-15 就绪面判定「能力域已声明/降级」（2026-10-24 内部任务-192，内部接口-1 Kimi 列）。
//       全部 fail-open：任何异常都退化为「零输出」，绝不阻断宿主轮次
//       （project-conventions 硬规则 4；宿主自身对钩子失败同为 fail-open 放行）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2/§4（宿主契约取证与差异面 12 行）
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 待投递提醒队列上限（与规则 stop-pending-relay.params.kimi.pendingLimit 单源对拍，见 tests/engine-materialize）。 */
export const PENDING_LIMIT = 20;

/**
 * Kimi 运行观测能力域声明（2026-10-24 内部任务-192/内部决策-063 修正案 1 决策 13；事实源＝内部接口-1
 * 「运行观测能力登记」Kimi 列）：失败事实供给＝原生 `PostToolUseFailure`＋`error` 对象提取退出码；
 * 钩失败观测面＝仅引擎失败面 `hook-diagnostics.log`；提醒注入时效＝观察面 fire-and-forget 走
 * 待投递中继（Stop 阻断原生）；自检可达性＝钩 `--selftest`。
 * 值是**声明形态短串**（与核心镜像 `observation-capability-contract.json` 的 `declarationGrammar`
 * 同域，非五态登记词表本身）；核心据它判定「能力域已声明/降级」（内部模块-15 就绪面）。
 */
export const OBSERVATION_CAPABILITIES = Object.freeze({
  failureFacts: 'error-object',
  hookFailure: 'engine-log',
  injection: 'relay',
  selfCheck: 'selftest',
});

/** 阻断兜底文案（UPS/Stop/PreToolUse 共用单源，避免各处各写一份）。 */
export const BLOCK_FALLBACK_REASON = Object.freeze({
  prompt: '用户提示被阻断，但未提供可读原因。',
  stop: '完成闸阻断，但未提供可读原因；请复核完成闸判定。',
  preToolUse: '钩子返回阻断（exit 2），但响应信封不可识别；本次按阻断处理。',
});

/**
 * 阻断原因取值（单源）：已识别正文 → 子进程 stderr → 通用兜底文案。
 * @param {string} primary 已识别的阻断正文（信封迁移后的正文）
 * @param {string} stderr 子进程 stderr
 * @param {string} fallback 通用兜底文案
 * @returns {string} 可直接展示的阻断原因
 */
export function resolveBlockReason(primary, stderr, fallback) {
  if (typeof primary === 'string' && primary.trim() !== '') return primary.trim();
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return fallback;
}

/**
 * 把运行观测能力域声明注入钩子子进程环境（`hook-shim.mjs` 以 `{...process.env}` 构造子进程
 * env，故本模块装载时调用一次即对全部处理器生效；已存在的声明值**不覆盖**——外层调用方
 * （测试/嵌套 shim）可显式覆盖）。
 * 为什么落在 hook-lib 而非 shim：一宿主一写面（内部决策-054）＋本次改动面收敛（shim 是冻结转发层）。
 * @param {Record<string, string>} [env] 目标环境对象（缺省 `process.env`）
 * @returns {Record<string, string>} 同一对象（便于链式断言）
 */
export function applyObservationCapabilitiesEnv(env = process.env) {
  const target = env && typeof env === 'object' ? env : process.env;
  const current = target.WF_OBSERVATION_CAPABILITIES;
  if (typeof current !== 'string' || current.trim() === '') {
    target.WF_OBSERVATION_CAPABILITIES = JSON.stringify(OBSERVATION_CAPABILITIES);
  }
  return target;
}

/** 模块装载即声明（shim 先 import 本模块、后 spawn 子钩子 ⇒ 子进程经 `{...process.env}` 继承）。 */
applyObservationCapabilitiesEnv(process.env);


/** 状态文件名（单个 JSON 文件，读-改-写原子替换、无跨进程锁——tmp 带 pid+随机后缀防并发互踩；
 *  失效方向分层如实：帧丢失=保守（提醒非数据）；streak 重计使 burstCap 重数=非保守面，
 *  已由引擎连击单键对设计缓解混合写场景）。 */
const STATE_FILE = 'relay-state.json';

/**
 * 读 stdin 全文（宿主钩子负载）。关闭/出错都解析为空串，交由 fail-open 路径处理。
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

/** 记录对象判定（宿主负载字段值不可信，逐处判类型）。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析包根：以 shim **自身文件路径** realpath 推导（dirname(fileURLToPath(import.meta.url))/..），
 * 不依赖环境变量——宿主虽注入 KIMI_PLUGIN_ROOT，但本层以物化位置为准（env 仅作旁证，见 hook-shim）。
 * @returns {string}
 */
export function resolvePluginRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

/**
 * 状态目录解析：优先宿主注入的 KIMI_CODE_HOME（<home>/plugin-data/<插件id>/）；缺席时退回
 * <包根>/../plugin-data/<插件id>/（与包同级，运行中包被整体重写时队列不丢），并在诊断注明。
 * @param {string} pluginRoot 包根绝对路径
 * @returns {string}
 */
export function resolveStateDir(pluginRoot) {
  const home = process.env.KIMI_CODE_HOME;
  const id = basename(pluginRoot);
  if (typeof home === 'string' && home.trim() !== '') return join(home, 'plugin-data', id);
  return join(dirname(pluginRoot), 'plugin-data', id);
}

/**
 * 状态目录来源说明（诊断用）：宿主 env 缺席时注明退回面，便于排查「队列写到了哪」。
 * @returns {string}
 */
export function stateDirNote() {
  return typeof process.env.KIMI_CODE_HOME === 'string' && process.env.KIMI_CODE_HOME.trim() !== ''
    ? `KIMI_CODE_HOME=${process.env.KIMI_CODE_HOME}`
    : 'KIMI_CODE_HOME 未注入，状态目录退回包旁 plugin-data/';
}

/**
 * 项目标记探测（`.git`/`.sdd`）：cwd 直用、path 上溯、会话缓存校验共用。
 */
function hasProjectMarker(dir) {
  try {
    return existsSync(join(dir, '.git')) || existsSync(join(dir, '.sdd'));
  } catch {
    return false;
  }
}

/**
 * 项目根解析链（实机探针 2026-10-05 登记，内部未决-75）：
 * Kimi **桌面端** `payload.cwd` 实测＝宿主应用安装目录（`…\Programs\Kimi Code`）而非会话
 * 项目目录（宿主未注入 KIMI_PROJECT_DIR 等价变量）——直接采用会让一切按项目根判定的
 * 钩子（routing-gate 租约 / check-freeze 冻结态 / spec-gate 规格路径 / **post-tool 事件
 * 落账根**）集体错置（实测 post-tool 以应用目录为根落账**静默失败**：错误陷阱吞写错，
 * exit 0 零帧，事件账丢失）。
 * 解析链：①cwd 自身带项目标记 → 直用（CLI 形态预计走此路）；
 * ②写类负载 `tool_input.file_path/path` 向上逐层找首个带标记的目录 → 用之；
 * ③兜底 cwd ?? process.cwd()（忠于宿主原值）。**Bash 类负载无 path 提示**——会话级
 * 缓存面见 `resolveSessionProjectRoot`（写类事件暖 cache，Bash 事件同会话复用）。
 * @param {unknown} payload 宿主负载
 * @returns {{root: string, via: 'cwd-marker' | 'path-walk' | 'fallback'}} 项目根与解析路径
 */
export function resolveProjectRootDetailed(payload) {
  const source = isRecord(payload) ? payload : {};
  const cwd = firstString(source, ['cwd']);
  if (cwd !== '' && hasProjectMarker(cwd)) return { root: cwd, via: 'cwd-marker' };
  const input = isRecord(source.tool_input) ? source.tool_input : {};
  const filePath = firstString(input, ['file_path', 'path']);
  if (filePath !== '') {
    let dir = dirname(filePath);
    for (let i = 0; i < 64; i += 1) {
      if (hasProjectMarker(dir)) return { root: dir, via: 'path-walk' };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { root: cwd !== '' ? cwd : process.cwd(), via: 'fallback' };
}

/** 会话项目根缓存文件名（旧单槽形态，仅作回落）。 */
const PROJECT_ROOT_CACHE_FILE = 'project-root.json';

/** 会话项目根缓存文件名前缀（按会话分槽：多会话互不覆盖）。 */
const PROJECT_ROOT_CACHE_PREFIX = 'project-root-';

/** 会话键摘要（缓存分槽文件名用）。 */
function sessionDigest12(sessionKey) {
  return createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 12);
}

/** 项目根缓存文件路径：pid- 兜底会话键每次调用都不同（不分槽，否则状态目录无界增殖）。 */
function projectRootCacheFile(stateDir, sessionKey) {
  if (typeof sessionKey === 'string' && sessionKey.startsWith('pid-')) return join(stateDir, PROJECT_ROOT_CACHE_FILE);
  return join(stateDir, `${PROJECT_ROOT_CACHE_PREFIX}${sessionDigest12(sessionKey)}.json`);
}

/** 会话槽位保留上限（个）：超出后按 mtime 淘汰最旧槽（状态目录不得无界增殖）。 */
const ROOT_CACHE_SLOT_LIMIT = 8;

/** 清理过期的会话槽位（保留最近 ROOT_CACHE_SLOT_LIMIT 个）。 */
function pruneRootCacheSlots(stateDir, keepPath) {
  try {
    const names = readdirSync(stateDir).filter((name) => name.startsWith(PROJECT_ROOT_CACHE_PREFIX) && name.endsWith('.json'));
    const entries = names
      .map((name) => ({ name, path: join(stateDir, name), mtime: statSync(join(stateDir, name)).mtimeMs }))
      .filter((entry) => entry.path !== keepPath)
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(Math.max(0, ROOT_CACHE_SLOT_LIMIT - 1))) rmSync(entry.path, { force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

/** 读会话项目根缓存（按会话分槽；旧单槽文件仅回落且校验会话键；损坏/缺键 → null，fail-open）。 */
function readProjectRootCache(stateDir, sessionKey) {
  const candidates = [
    projectRootCacheFile(stateDir, sessionKey),
    join(stateDir, PROJECT_ROOT_CACHE_FILE),
  ].filter((file, index, all) => all.indexOf(file) === index);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(parsed)) continue;
      const storedKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : '';
      const root = typeof parsed.root === 'string' ? parsed.root : '';
      if (storedKey === '' || root === '') continue;
      if (storedKey !== sessionKey) continue; // 旧单槽文件属别会话 → 不采用
      // 命中即刷新活跃度（mtime）：否则「只在消费缓存」的会话槽会被按 mtime 优先淘汰
      try { utimesSync(file, new Date(), new Date()); } catch { /* 刷新失败不影响读取 */ }
      return { sessionKey: storedKey, root };
    } catch {
      /* 损坏/缺失 → 试下一个候选 */
    }
  }
  return null;
}

/** 写会话项目根缓存（临时名 + rename 原子替换；失败静默——缓存是增强面）。 */
function writeProjectRootCache(stateDir, sessionKey, root) {
  // pid- 兜底会话键每次调用都不同：写缓存只产生噪声（读侧也永不会命中）→ 直接跳过
  if (typeof sessionKey === 'string' && sessionKey.startsWith('pid-')) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const target = projectRootCacheFile(stateDir, sessionKey);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ sessionKey, root, ts: Date.now() })}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败不反噬 */ }
      return;
    }
    try {
      renameSync(tmp, target);
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      return;
    }
    pruneRootCacheSlots(stateDir, target);
  } catch { /* 缓存不得再抛 */ }
}

/**
 * 会话面项目根解析（带解析路径）：shim 主流程使用——解析链带标记（cwd-marker/path-walk）
 * 即写入会话键缓存，让 Bash 事件的 post-tool 落账 / routing-gate 判定拿到与写类事件一致的
 * 项目根；`via === 'fallback'` 且负载带 cwd 是「项目根未解析」可见化（H-5）的判定位——最终
 * 仍 fallback 意味着租约闸/冻结护栏在本事件上落激活域之外；缓存命中（同会话键且缓存根仍带
 * 标记）返回 `via: 'cache-hit'`，失败一律退解析链兜底（忠于宿主，错位进可见面而非静默猜）。
 * @param {unknown} payload 宿主负载
 * @param {string} stateDir 状态目录（缓存落点）
 * @returns {{root: string, via: 'cwd-marker' | 'path-walk' | 'cache-hit' | 'fallback'}}
 */
export function resolveSessionProjectRootDetailed(payload, stateDir) {
  const detail = resolveProjectRootDetailed(payload);
  const sessionKey = sessionKeyOf(payload);
  if (detail.via !== 'fallback') {
    writeProjectRootCache(stateDir, sessionKey, detail.root);
    return detail;
  }
  const cached = readProjectRootCache(stateDir, sessionKey);
  if (cached !== null && cached.sessionKey === sessionKey && hasProjectMarker(cached.root)) {
    return { root: cached.root, via: 'cache-hit' };
  }
  return detail;
}

/**
 * 空状态（纯函数，保证字段齐备，测试可直测）——**形状＝引擎侧 relay 状态**：
 * `frames` 每帧自带非空 `sessionKey`（引擎 `isFrame` 硬要求）；连击/淘汰计数为引擎多会话字典
 * `streaks`/`droppedBySession`（内部任务-347/内部未决-277②/274——`s:` 前缀键；宿主读侧往返保留，
 * 不得抹掉引擎状态键；旧单键对/单值字段由引擎首读迁移，读侧不再重建）。
 * @returns {{frames: {sessionKey: string, id: string, text: string, ts: number}[], streaks: Object<string, number>, droppedBySession: Object<string, number>}}
 */
export function emptyState() {
  return { frames: [], streaks: {}, droppedBySession: {} };
}

/**
 * 帧会话键兜底（仅 enqueuePending 空串回落路径使用——底部兜底拿不到会话键时的尽力形态）：
 * 取 `streakKey`。kimi 无旧盘态史（单提交新建），无迁移哨兵——旧 `pending` 形态属 mcode 升级史，
 * 本侧读到即丢弃（引擎投递按会话过滤，合成错键的帧不可投递，丢弃更诚实）。
 */
function frameSessionKeyOf(state) {
  // 内部任务-347：字典无单键位——取最大计数键的前缀剥面作兜底；空字典返回空串＝帧丢弃（「丢弃更诚实」口径）。
  let best = '';
  let bestCount = 0;
  const streaks = state.streaks;
  if (streaks && typeof streaks === 'object' && !Array.isArray(streaks)) {
    for (const key of Object.keys(streaks)) {
      const count = streaks[key];
      if (Number.isFinite(count) && count > bestCount) { best = key.startsWith('s:') ? key.slice(2) : key; bestCount = count; }
    }
  }
  return best;
}

/**
 * 读状态（缺失 → 空状态；损坏 → 空状态 + 诊断日志，fail-open）。kimi 无旧盘态史：`pending` 旧形态与缺
 * `sessionKey` 的帧一律丢弃（投递按会话过滤，合成错键的帧不可投递）。
 * 引擎状态键（`streaks`/`droppedBySession` 多会话字典，内部任务-347）随往返保留——宿主读侧不得抹掉
 * 引擎状态键（计数条目逐键拷贝，非自有字面键白名单跳过——字典键任意、不可枚举声明）。
 * @param {string} stateDir 状态目录
 * @returns {{frames: {sessionKey: string, id: string, text: string, ts: number}[], streaks: Object<string, number>, droppedBySession: Object<string, number>}}
 */
export function readState(stateDir) {
  const file = join(stateDir, STATE_FILE);
  if (!existsSync(file)) return emptyState();
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // fs 读错误（EPERM/EBUSY/EMFILE 等瞬态）≠内容损坏——不隔离、不告警（重试语义由调用方承载）
    return emptyState();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 损坏与缺失分开：缺失是正常空态；损坏必须可见（写到 hook-diagnostics.log），不静默清空。
    // 内部任务-347/内部未决-280：告警一次后把坏文件改名隔离（固定名单 .corrupt 覆盖写——不引入
    // 时间戳后缀无界增长面）；后续读走「缺失=正常空态」分支零重复告警。
    writeDiagnostic(stateDir, 'state', `${STATE_FILE} 不可解析，已重置待投递队列与连击`, '检查 KIMI_CODE_HOME/plugin-data 权限或删除损坏状态文件');
    try {
      // rename 前复验（S 门评审 TOCTOU 面）：并发写者可能已原子换上有效态——仅当文件仍是
      // 我们读到的那份坏内容（逐字节重读比对）才隔离，避免把有效新状态误搬进 .corrupt。
      if (readFileSync(file, 'utf8') === raw) {
        renameSync(file, join(stateDir, `${STATE_FILE}.corrupt`));
      }
    } catch { /* 隔离尽力而为：失败维持现状（每次读重复告警，可诊断） */ }
    return emptyState();
  }
  try {
    if (!isRecord(parsed)) return emptyState();
    const streaks = {};
    if (parsed.streaks && typeof parsed.streaks === 'object' && !Array.isArray(parsed.streaks)) {
      for (const key of Object.keys(parsed.streaks)) {
        const count = parsed.streaks[key];
        if (Number.isFinite(count) && count > 0) streaks[key] = Math.floor(count);
      }
    }
    const droppedBySession = {};
    if (parsed.droppedBySession && typeof parsed.droppedBySession === 'object' && !Array.isArray(parsed.droppedBySession)) {
      for (const key of Object.keys(parsed.droppedBySession)) {
        const count = parsed.droppedBySession[key];
        if (Number.isFinite(count) && count > 0) droppedBySession[key] = Math.floor(count);
      }
    }
    // 旧单键对/单值吸收（内部任务-347 S 门：kimi 读侧此前剥字段使引擎迁移不可达——并入引擎可消化
    // 哨兵键，旧计数经首次投递提醒消化；与 mcode 读侧吸收对称，差异点登记于两文件头注）
    if (typeof parsed.streakKey === 'string' && parsed.streakKey !== '' && Number.isFinite(parsed.streakCount) && parsed.streakCount > 0) {
      const k = `s:${parsed.streakKey}`;
      streaks[k] = (streaks[k] ?? 0) + Math.floor(parsed.streakCount);
    }
    if (Number.isFinite(parsed.droppedByLimit) && parsed.droppedByLimit > 0) {
      const k = 's:__legacy__';
      droppedBySession[k] = (droppedBySession[k] ?? 0) + Math.floor(parsed.droppedByLimit);
    }
    const frames = [];
    if (Array.isArray(parsed.frames)) {
      for (const frame of parsed.frames) {
        if (!isRecord(frame) || typeof frame.text !== 'string') continue;
        if (typeof frame.sessionKey !== 'string' || frame.sessionKey === '') continue;
        frames.push({
          sessionKey: frame.sessionKey,
          id: typeof frame.id === 'string' ? frame.id : frameIdOf(frame.text),
          text: frame.text,
          ts: Number.isFinite(frame.ts) ? frame.ts : Date.now(),
        });
      }
    }
    return { frames: frames.slice(-PENDING_LIMIT), streaks, droppedBySession };
  } catch {
    // 形态异常（isRecord false 等逻辑分档）——不隔离文件（内容可解析，非字节损坏）
    return emptyState();
  }
}

/**
 * 清扫陈旧 tmp 残留（内部任务-347/内部未决-286）：原子写 tmp+rename 的进程被杀路径会留
 * `<target>.tmp-<pid>-<hex>` 孤儿件。活性判据钉死错误码——仅 `process.kill(pid,0)` 抛
 * `ESRCH`（进程不存在）判死；`EPERM`（进程存在但权限拒发——Windows pid4 System 实测）
 * 及其他错误码一律保守视为存活跳过。判死且 mtime 超过 1h 才 unlink（新鲜件保留——
 * 可能是并发写者的在途 tmp）。全程 best-effort fail-open（清扫失败不反噬状态写）。
 * @param {string} stateDir 状态目录
 * @returns {number} 清理件数
 */
export function sweepStaleTmp(stateDir) {
  let removed = 0;
  let names;
  try { names = readdirSync(stateDir); } catch { return 0; }
  for (const name of names) {
    const m = /^(.+)\.tmp-(\d+)-[0-9a-f]+$/.exec(name);
    if (m === null) continue;
    const pid = Number(m[2]);
    try {
      process.kill(pid, 0);
      continue; // 存活（含 EPERM 语义外的成功探针）→ 跳过
    } catch (error) {
      if (!(error && error.code === 'ESRCH')) continue; // EPERM/其他＝保守存活
    }
    const full = join(stateDir, name);
    try {
      const st = statSync(full);
      if (Date.now() - st.mtimeMs < 3600_000) continue; // 新鲜件保留
      rmSync(full, { force: true });
      removed += 1;
    } catch { /* 单件失败继续 */ }
  }
  return removed;
}

/** 诊断日志体积上限（字节）：超出后截断保留尾部（诊断不得无界增长）。 */
const DIAGNOSTIC_LOG_MAX_BYTES = 1024 * 1024;

/** 帧 id（内容指纹，用于去重）。 */
function frameIdOf(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 落状态（临时文件 + rename 原子替换；失败静默——状态是增强面，不值得反噬轮次）。
 * @param {string} stateDir 状态目录
 * @param {object} state 状态对象
 * @returns {boolean} 是否落盘成功
 */
export function writeState(stateDir, state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    sweepStaleTmp(stateDir); // 内部任务-347/内部未决-286：每脏写一次清扫（readdir 亚毫秒、fail-open）
    const target = join(stateDir, STATE_FILE);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败不反噬 */ }
      return false;
    }
    try {
      renameSync(tmp, target);
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 入队一条待投递提醒（同文本按 digest 覆盖去重，保留最新时间戳）。
 * 观察面帧与失败面降级共用本原语；Stop 连击门控不在此层（语义单源＝引擎 stop-pending-relay）。
 * @param {object} state 当前状态
 * @param {string} text 提醒正文
 * @param {string} [sessionKey] 当前事件会话键——非空时帧键忠实取之（不再错挂旧 streakKey）；
 *   空串/缺省回落 `streakKey`（底部兜底拿不到会话键时的尽力形态，回落帧可能不可投递）。
 * @returns {object} 新状态
 */
export function enqueuePending(state, text, sessionKey) {
  const body = String(text ?? '').trim();
  if (body === '') return state;
  const id = frameIdOf(body);
  const key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : frameSessionKeyOf(state);
  // 去重键＝会话 + 内容（与引擎 relay 同语义）：只按文本会把他会话的同文案帧删掉
  const rest = state.frames.filter((frame) => !(frame.id === id && frame.sessionKey === key));
  const frame = { sessionKey: key, id, text: body, ts: Date.now() };
  const nextFrames = [...rest, frame];
  const evicted = nextFrames.length - PENDING_LIMIT; // 容量淘汰不静默（阶段复审① F5：shim 侧入队腿同计数——按会话分账，内部任务-347/内部未决-274）
  const nextState = { ...state, frames: nextFrames.slice(-PENDING_LIMIT) };
  if (evicted > 0) {
    const ek = `s:${key}`;
    nextState.droppedBySession = { ...(state.droppedBySession ?? {}) };
    nextState.droppedBySession[ek] = (nextState.droppedBySession[ek] ?? 0) + evicted;
  }
  return nextState;
}

/**
 * 入队并保证可见（宿主适配层的统一入队原语）：状态面写失败时写诊断并退 stderr 兜底——
 * 降级事实不得静默消失（宿主 stderr 非用户可见面，但仍是最后一道痕迹）。
 * @param {string} stateDir 状态目录
 * @param {string} text 提醒正文
 * @param {string} sessionKey 会话键
 * @param {string} event 事件名（诊断用）
 * @returns {boolean} 是否落盘成功
 */
export function enqueueOrReport(stateDir, text, sessionKey, event) {
  const ok = writeState(stateDir, enqueuePending(readState(stateDir), text, sessionKey));
  if (!ok) {
    writeDiagnostic(stateDir, event, '状态面不可写：待投递帧未落盘', '检查 KIMI_CODE_HOME/plugin-data 权限');
    try { process.stderr.write(`${text}\n`); } catch { /* 不得再抛 */ }
  }
  return ok;
}

/**
 * 取出并清空待投递提醒（拼成一段文本；无则空串）。
 * @param {object} state 当前状态
 * @returns {string}
 */
export function drainPending(state) {
  if (state.frames.length === 0) return '';
  return state.frames.map((frame) => frame.text).join('\n');
}

/**
 * 收养孤儿帧（内部任务-302 自 hook-shim 下沉，行为零变更）：`pid-` 起头的帧键来自「负载不可读/缺
 * session_id」的兜底会话键——每次钩子调用都是新进程新 pid，投递按会话过滤后这类帧永不可投递
 * （死信）。投递前收养为当前会话键（恢复可达性；真会话键帧不受影响）。
 * @param {string} stateDir 状态目录
 * @param {string} sessionKey 当前会话键
 */
export function adoptOrphanFrames(stateDir, sessionKey) {
  const state = readState(stateDir);
  if (!state.frames.some((frame) => frame.sessionKey.startsWith('pid-'))) return;
  state.frames = state.frames.map((frame) => (frame.sessionKey.startsWith('pid-') ? { ...frame, sessionKey } : frame));
  writeState(stateDir, state);
}

/** 投递腿契约漂移错误码（`drainRelayForPrompt` 抛出；调用方据此分档诊断，不依赖文案）。 */
export const RELAY_CONTRACT_DRIFT = 'RELAY_CONTRACT_DRIFT';

/**
 * 中继状态端口（引擎 `stop-pending-relay` 的 IO 端口）：读面直通，写失败统一记诊断。
 * 两腿（shim UPS/Stop 与 relay-drain）共用，诊断文案与事件槽位不再各写一份。
 * @param {string} stateDir 状态目录
 * @param {string} event 诊断事件名（UserPromptSubmit / Stop）
 * @returns {{readState: () => object, writeState: (state: object) => boolean}} 引擎端口
 */
export function createRelayPorts(stateDir, event = 'UserPromptSubmit') {
  return {
    readState: () => readState(stateDir),
    writeState: (next) => {
      const ok = writeState(stateDir, next);
      if (!ok) writeDiagnostic(stateDir, event, '状态面不可写：中继状态未落盘（下一轮可能重复投递）', '检查 KIMI_CODE_HOME/plugin-data 权限');
      return ok;
    },
  };
}

/**
 * 投递腿共享原语：收养孤儿帧 → 引擎 `stop-pending-relay` deliverOn → 字段契约校验 → 出队文本。
 * 策略单源：会话过滤、容量淘汰通告与连击归零全在规则 `params.kimi`；本函数只管接线顺序。
 * **不吞异常**：引擎异常与契约漂移一律抛出，由调用方按各自失败面处置
 * （shim → `main().catch` 可见面；relay-drain → 零输出 + 诊断日志）。
 * @param {{engine: {applyRule: Function}, sessionKey: string, stateDir: string, ports: {readState: Function, writeState: Function}}} input 引擎、会话键、状态目录与状态端口
 * @returns {string} 待投递文本（未钳位；空串＝无投递）
 */
export function drainRelayForPrompt(input) {
  const { engine, sessionKey, stateDir, ports } = input;
  adoptOrphanFrames(stateDir, sessionKey);
  const outcome = engine.applyRule('stop-pending-relay', 'kimi', { event: 'UserPromptSubmit', sessionKey }, ports);
  if (!outcome.applied || !outcome.result || !Array.isArray(outcome.result.delivered)) {
    const error = new Error('hook-lib: 规则库字段契约漂移（stop-pending-relay 缺 params.kimi）——拒跑而非静默堵住投递');
    error.code = RELAY_CONTRACT_DRIFT;
    throw error;
  }
  return drainPending({ frames: outcome.result.delivered });
}

/** 退出标记尾部行式样（宿主渲染文本的 seam 契约；只在**最后一个非空行**命中才算数）。 */
const EXIT_MARKER = /\[exit code:\s*(-?\d+)\]\s*$/i;

/** 从对象里取第一个非空字符串字段。 */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 从对象里取第一个布尔字段（只认真正的布尔，避免 'false' 字符串被当真）。 */
function firstBoolean(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === 'boolean') return source[key];
  }
  return undefined;
}

/** 从对象里取第一个可解析为整数的字段（数字或非空数字字符串）。刻意**不读 `status`**：
 * MCP/HTTP 形态的 `status`（如 500）会被误当成退出码，凭空记一条不存在的 tool-failure
 * ——与 内部未决-46「宁漏不误报」纪律相反（mcode 收尾评审同款教训）。 */
function firstInteger(source, keys) {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Math.trunc(Number(raw));
  }
  return null;
}

/**
 * 结果面 → ZCode 侧 `tool_result` 结构面（内部接口-1 第四宿主登记差异 #7）。
 *
 * 判序固定：结构化字段（`is_error` / `isError`、`exit_code` / `exitCode` / `code`）
 * → Kimi 实测失败面 `error` 对象（`error.message` 正则提取退出码——`error.code` 是
 *    **类别串**（如 "internal"），刻意不冒认为退出码；内部未决-116 起透传为 `errorCode`
 *    字段，形态/语义作用域由核心件 classifyResult 单点收口）→ 宿主渲染文本（`tool_output` /
 *    `tool_response`，尾部退出标记只在**最后一个非空行**命中）→ 皆无即「不可知」
 * （`exit_code: null`，交由 `post-tool.mjs` 的结构化判据走「宁漏不误报」分支）。
 * 文本单独**不**构成失败判据（内部未决-46 纪律：文本启发式归适配层，不进核心件）。
 * 实机探针（2026-10-05，内部未决-67/P1）：Kimi 成功面结果键=`tool_output`（无结构化字段、
 * 渲染文本无退出标记）；失败面=`error:{code,message,retryable}`（message 含
 * "Process exited with code 3\nCommand failed with exit code: 3."）。
 * @param {unknown} toolResponse 宿主结果字段（`tool_output` / `tool_response` / `error`，字符串或对象，形态不可预知）
 * @returns {{is_error: boolean, exit_code: number|null, stdout: string, stderr: string, errorCode?: string}} errorCode 仅错误分支携带（缺省空串；语义收口在核心件 classifyResult）
 */
export function deriveToolResult(toolResponse) {
  if (isRecord(toolResponse)) {
    // Kimi 失败面：error 对象在场即失败事件（宿主语义：error 键=工具失败），
    // 退出码从 message 提取（两种实测句式："exited with code N" / "exit code: N"）。
    const errorObj = isRecord(toolResponse.error) ? toolResponse.error : null;
    const message = errorObj === null ? '' : firstString(errorObj, ['message']);
    if (errorObj !== null) {
      const matched = /exit(?:ed)? with code:?\s*(-?\d+)/i.exec(message) ?? /exit\s*code:?\s*(-?\d+)/i.exec(message);
      const code = matched === null ? null : Number(matched[1]);
      return {
        is_error: true,
        exit_code: code,
        // 内部未决-116：error.code（类别串，如 "internal"）透传为 errorCode——不冒认退出码的取舍不变
        //（exit_code 只从 message 提取），码面语义（形态/作用域）由核心件 classifyResult 的
        // CODE_RE + errorClass 门控单点收口；缺省空串（CODE_RE 拒收，等价不携带）。
        errorCode: firstString(errorObj, ['code']),
        stdout: firstString(toolResponse, ['stdout', 'output', 'text', 'content', 'result', 'tool_output']),
        stderr: message,
      };
    }
    const stdout = firstString(toolResponse, ['stdout', 'output', 'text', 'content', 'result', 'tool_output']);
    const flag = firstBoolean(toolResponse, ['is_error', 'isError']);
    const code = firstInteger(toolResponse, ['exit_code', 'exitCode', 'code']);
    if (flag !== undefined || code !== null) {
      return {
        is_error: flag ?? (code !== null && code !== 0),
        exit_code: code,
        stdout,
        stderr: firstString(toolResponse, ['stderr']),
      };
    }
    return { is_error: false, exit_code: null, stdout, stderr: '' };
  }
  const stdout = typeof toolResponse === 'string' ? toolResponse : '';
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const matched = EXIT_MARKER.exec(line);
    if (matched) {
      const code = Number(matched[1]);
      return { is_error: code !== 0, exit_code: code, stdout, stderr: '' };
    }
    break; // 只认最后一行：正文里出现的同形文本不算退出标记
  }
  return { is_error: false, exit_code: null, stdout, stderr: '' };
}

/**
 * Kimi 负载 → ZCode 负载归一（内部接口-1 第四宿主登记差异 #4）。
 * 负载字段名实机探针已钉死（2026-10-05，内部未决-67 部分关闭）：`tool_name`/`tool_input`
 * 与文档推断一致；结果面 Kimi 原生键=`tool_output`/`error`（见 deriveToolResult）；
 * 兼容读取仍保留（`tool_name|name`；`prompt` 兼容**消息块数组**与裸字符串两形态——真机
 * 实测桌面端为 `[{type:"text",text:…}]` 块数组）防宿主形态漂移。写类入参
 * `path→file_path` 补写且**保留原键**（下游按 ZCode 名读，原生键不删）。
 * `cwd` 无条件归一为项目根（ctx.projectDir=resolveProjectRoot 解析链产物，链内已含
 * 「忠于宿主」兜底）——桌面端 payload.cwd=应用目录的实测语义见 resolveProjectRoot。
 * @param {string} event 事件名（argv 权威，负载里的同名键不覆盖）
 * @param {unknown} payload 宿主负载（不可信，字段逐处判类型）
 * @param {{projectDir: string, engine?: object}} ctx 上下文（工作区兜底 + **规则引擎**：来源归一单源；
 *   缺引擎即具名抛错，不回落内联白名单）
 * @returns {object} 归一后的负载
 */
export function normalizePayload(event, payload, ctx) {
  const source = isRecord(payload) ? payload : {};
  const out = { ...source };
  out.hook_event_name = event; // argv 事件为权威（负载里的同名键不覆盖）
  const toolName = firstString(source, ['tool_name', 'name']);
  if (toolName !== '') out.tool_name = toolName;
  // Kimi 实测键 `tool_call_id` → ZCode 键 `tool_use_id`（post-tool 的幂等 id/重试环调用键
  // 以 tool_use_id 为准——2026-10-05 真机探针：缺该映射时事件账静默丢失，映射后恢复落账）。
  if ((typeof out.tool_use_id !== 'string' || out.tool_use_id === '') && typeof source.tool_call_id === 'string' && source.tool_call_id !== '') {
    out.tool_use_id = source.tool_call_id;
  }
  if (isRecord(out.tool_input)) {
    const toolInput = { ...out.tool_input };
    if (typeof toolInput.file_path !== 'string' && typeof toolInput.path === 'string') toolInput.file_path = toolInput.path;
    out.tool_input = toolInput;
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    // 实机探针（2026-10-05）：Kimi 结果面原生键=`tool_output`（成功渲染文本）/ `error`（失败
    // 结构化对象），位于负载顶层；`tool_response` 嵌套形态（旧文档推断面）优先解包以兼容。
    // 派生源：tool_response 为对象时解包之，否则以整个负载为源（deriveToolResult 判序见上）。
    if (!isRecord(out.tool_result)) {
      const resultSource = isRecord(source.tool_response) ? source.tool_response : source;
      out.tool_result = deriveToolResult(resultSource);
    }
  }
  // 用户文本提取（真机探针 2026-10-05 钉死）：Kimi 桌面端 UPS 的 `prompt` 是**消息块
  // 数组**（OpenAI 风格 `[{type:"text",text:"…"},…]`），非裸字符串——旧 firstString 读法
  // 恒为空串，user-prompt 子钩在「无 prompt」分支静默退出（租约签发/提醒全丢，本日
  // 真机缺口根因）。块数组取各块 `text` 拼接（多段以换行相连）；裸字符串/`text` 键兼容保留。
  const promptRaw = source.prompt !== undefined ? source.prompt : source.text;
  let prompt = '';
  if (typeof promptRaw === 'string') {
    prompt = promptRaw;
  } else if (Array.isArray(promptRaw)) {
    prompt = promptRaw
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : typeof block === 'string' ? block : ''))
      .filter((part) => part !== '')
      .join('\n');
    // 块数组形态**无条件**以提取串覆写 out.prompt（空串也覆写）——否则展开透传会把原始
    // 数组留给子钩，子钩的字符串判型（typeof==='string'）把它当「无 prompt」静默退出，
    // 与「提取后空文本」语义虽同，但保持 ZCode 面「prompt 恒为字符串」形态更忠实。
    out.prompt = prompt;
  }
  if (prompt !== '') out.prompt = prompt;
  if (typeof out.source === 'string') {
    // 引擎驱动：判据域与归一目标单源在 `source-widen-normalize.params.kimi`
    // （accepted=["startup","resume"]，域外 → startup）。无引擎即具名抛错——
    // 禁回落内联白名单（那会成为第二条策略实现；shim 已在装载期传入引擎）。
    const engine = ctx?.engine;
    if (!engine || typeof engine.applyRule !== 'function') {
      throw new Error('hook-lib: normalizePayload 需要引擎（ctx.engine）——来源归一由 source-widen-normalize 单源');
    }
    const outcome = engine.applyRule('source-widen-normalize', 'kimi', { source: out.source });
    if (outcome.applied !== true || typeof outcome.result !== 'string') {
      throw new Error('hook-lib: 规则库字段契约漂移（source-widen-normalize 缺 params.kimi）——拒跑而非静默归一');
    }
    out.source = outcome.result;
  }
  // 项目根归一（ZCode 语义 cwd=项目目录）：解析链兜底已含宿主原值，故无条件采用。
  out.cwd = ctx.projectDir;
  return out;
}

/**
 * ZCode **PreToolUse** 信封 → Kimi 宿主母语位（内部接口-1 第四宿主登记差异 #1/#2/#3）。
 * 逐决策：deny → stdout JSON 信封（宿主两键白名单）+ exit 2 + stderr 同文案；
 * ask 无文档位 → 保守翻 deny（reason 前缀「需用户确认：」）；allow/defer/无决策/空信封 → null。
 * **仅 PreToolUse**：UserPromptSubmit 的阻断/纯文本与 Stop 的 stderr 阻断由 `hook-shim.mjs`
 * 各自内联译出（生产不可达的旧分支已于 2026-11-06 内部任务-335 删除）。
 * @param {unknown} envelope 子进程 stdout 解析出的信封（可为空）
 * @param {{engine: object}} ctx 规则引擎（槽位迁移 `message-slot-migration.params.kimi.rename` 单源）
 * @returns {{exit: number, stdout: string, stderr: string}|null} 宿主响应动作；null = 零输出 exit 0
 */
export function translatePreToolUseResponse(envelope, ctx) {
  if (!isRecord(envelope)) return null;
  const specific = isRecord(envelope.hookSpecificOutput) ? envelope.hookSpecificOutput : null;
  const decision = specific ? specific.permissionDecision : undefined;
  if (decision === 'deny' || decision === 'ask') {
    // 槽位迁移交引擎：`systemMessage → permissionDecisionReason` 的重命名与
    // 「目标键已存在不覆盖」语义单源在 `message-slot-migration.params.kimi.rename`；
    // 无引擎即具名抛错（禁回落内联读取＝禁第二份策略实现）。
    const slotEngine = ctx?.engine;
    if (!slotEngine || typeof slotEngine.applyRule !== 'function') {
      throw new Error('hook-lib: translatePreToolUseResponse 需要引擎（ctx.engine）——槽位迁移由 message-slot-migration 单源');
    }
    const migrated = slotEngine.applyRule('message-slot-migration', 'kimi', { envelope: specific ?? {} });
    if (migrated.applied !== true || !migrated.result || typeof migrated.result !== 'object') {
      throw new Error('hook-lib: 规则库字段契约漂移（message-slot-migration 缺 params.kimi）——拒译而非静默丢 reason');
    }
    const rawReason = typeof migrated.result.permissionDecisionReason === 'string' ? migrated.result.permissionDecisionReason : '';
    const reason = clampContext(decision === 'ask' ? `需用户确认：${rawReason === '' ? '该操作需要用户确认意图后再放行' : rawReason}` : rawReason);
    // 双通道：JSON 信封走 stdout（宿主文档两键白名单），exit 2 + stderr 为 belt-and-braces
    // 兜底（即使宿主忽略信封，阻断语义与原因仍经原生退出码位成立）。
    const frame = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } };
    return { exit: 2, stdout: `${JSON.stringify(frame)}\n`, stderr: reason };
  }
  return null; // allow/defer/无决策：宿主默认放行，零输出
}

/**
 * 输出上限（宿主 stdout 追加进上下文；单字段 32KB 预算系提示注入而非硬截，留一半余量后截断）。
 * **三条注入面（UserPromptSubmit 纯文本 / Stop stderr 阻断理由 / PreToolUse deny 文案）
 * 必须共用这一个闸**：超大注入会撑爆宿主 prompt build 预算（64KB/插件）并被整段跳过。
 */
const MAX_CONTEXT_CHARS = 32_000;

/**
 * 截断注入文本到宿主上限内（32,000 字符，避免与其它上下文叠加后越界）。
 * @param {string} text 文本
 * @returns {string}
 */
export function clampContext(text) {
  const body = String(text ?? '');
  return body.length <= MAX_CONTEXT_CHARS ? body : `${body.slice(0, MAX_CONTEXT_CHARS)}\n…（已截断）`;
}

/**
 * 会话键（负载 session_id → 会话同义词 → 进程 pid，逐级兜底；键只进状态文件不外泄）。
 * @param {unknown} payload 宿主负载
 * @returns {string}
 */
export function sessionKeyOf(payload) {
  const source = isRecord(payload) ? payload : {};
  for (const key of ['session_id', 'sessionId']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key];
  }
  return `pid-${process.pid}`;
}

/** 把任意错误/细节压成**单行**（多行 Node 诊断会打断句子与 TSV 记录）。 */
function singleLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' / ').slice(0, 400);
}

/**
 * 诊断日志落点（宿主 stderr 非用户可见面，故必须自己送面；落点=状态目录内）。
 * @param {string} stateDir 状态目录
 * @returns {string} 日志文件绝对路径
 */
export function diagnosticLogPath(stateDir) {
  return join(stateDir, 'hook-diagnostics.log');
}

/**
 * 追加一条诊断（单行 TSV：时间 + 事件 + 原因 + 恢复指引）；**目录先建后写**，
 * 落点不可用/写入失败一律静默（诊断不得再抛）。
 * @param {string} stateDir 状态目录
 * @param {string} event 事件名
 * @param {string} detail 失败原因
 * @param {string} recovery 恢复指引
 * @returns {void}
 */
export function writeDiagnostic(stateDir, event, detail, recovery) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = diagnosticLogPath(stateDir);
    // 符号链接拒写（内部任务-347/内部未决-280）：预置链接指向站外时跟随写入＝越权写面——拒写退 stderr。
    try {
      if (lstatSync(file).isSymbolicLink()) {
        process.stderr.write(`[${event}] 诊断落点为符号链接，拒写（不跟随）：${file}\n`);
        return;
      }
    } catch (lstatError) {
      if (!(lstatError && lstatError.code === 'ENOENT')) throw lstatError; // 非「不存在」的 lstat 失败照常走追加路径的兜底
    }
    // 体积上限（1 MiB）：状态持续损坏时诊断不得无界增长——轮转（rename）而非原地截断，
    // 原地重写既非原子，也会丢掉最早触发故障的那段取证。
    try {
      if (statSync(file).size > DIAGNOSTIC_LOG_MAX_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
    } catch { /* 轮转失败不影响追加 */ }
    appendFileSync(file, `${new Date().toISOString()}\t${event}\t${singleLine(detail)}\t${singleLine(recovery)}\n`, 'utf8');
  } catch {
    // 诊断面不可用（目录不可写/磁盘满）→ 退到 stderr：宿主 stderr 非用户可见面，但不静默丢失
    try { process.stderr.write(`[${event}] ${singleLine(detail)}\n`); } catch { /* 诊断不得再抛 */ }
  }
}
