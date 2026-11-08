// 文件：manifest schema 校验与中立性 lint
// 描述：校验 plugin.manifest.json（schema + lint + 声明面目录/路径 containment + version 三段式）与
//       degradation-rules.json（params 机读化 v2 + 规则级跨字段不变式，内部决策-037/内部需求-7），
//       错误一次列全，fail-closed；**manifest 输入**不抛异常（缺能力矩阵属构建环境错误：
//       loadEventVocabulary 抛出具名错误含路径）。validateRules 是 rules 数据面的**唯一 schema 权威**；
//       check-repo-consistency 第 13 块只做静态字面对拍（不 spawn 校验器），二者分工不同、不构成双写。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：import { validateManifest, lintNeutrality, validateRules } from './validate.mjs'
// 自检：node --test "plugin-core/tests/validate.test.mjs"
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const TOP_KEYS = ['manifestVersion', 'name', 'version', 'description', 'displayName', 'author', 'surfaces', 'hooks'];
const HOOK_KEYS = ['event', 'matcher', 'type', 'command', 'args', 'timeoutMs', 'statusMessage'];
const META_FIELDS = ['name', 'version', 'description', 'author'];
/** 宿主专有名词表（中立性 lint 与一致性门的**单源**词表；内部任务-238 阶段门#2 起 scripts/check-repo-consistency.mjs 直接消费本模块判定函数，无本地副本）。 */
export const HOST_TERMS = ['ZCode', 'zcode', 'DSH', 'dsh', 'DeepSeek', 'deepseek', 'MCode', 'mcode', 'MiniMax', 'minimax', 'Kimi', 'kimi'];
/** 正则转义（宿主词表为开放列表：词条含元字符时不得改变匹配语义）。 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** JSON 转义形占位符前缀（`\u0024{`＝`${` 的转义写法）：manifest 须以字面 `${...}` 书写，转义形一律拒。 */
const ESCAPED_PLACEHOLDER_RE = /\\u0024\s*\{/i;

/**
 * 深度遍历 JSON 值：对每个字符串（键名与字符串值）回调——占位符/宿主词解码态扫描共用。
 * @param {unknown} value JSON 解析结果
 * @param {(s: string) => void} onString 字符串回调
 * @returns {void}
 */
function walkJsonStrings(value, onString) {
  if (typeof value === 'string') { onString(value); return; }
  if (Array.isArray(value)) { for (const item of value) walkJsonStrings(item, onString); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { onString(k); walkJsonStrings(v, onString); }
  }
}

/**
 * 占位符形态扫描（R-pc-3 机械面）：原文 + JSON 解码态（可解析时）双面扫描 `${...}` 与未闭合 `${`，
 * 并拒绝 JSON 转义形占位符（`\u0024{`）；同一命中消息只记一条。
 * @param {string} text manifest 原文
 * @returns {{hits: string[], decodedStrings: string[]|null}} 命中清单与解码态字符串集（不可解析为 null）
 */
function neutralScan(text) {
  const hits = [];
  const seen = new Set();
  const add = (msg) => { if (!seen.has(msg)) { seen.add(msg); hits.push(msg); } };
  const placeholderRe = /\$\{([^}]*)\}/g;
  const scanString = (s) => {
    let matchCount = 0;
    for (const m of s.matchAll(placeholderRe)) {
      matchCount += 1;
      if (m[1] !== 'PLUGIN_ROOT') add(`非中立占位符 ${m[0]}`);
    }
    if (s.split('${').length - 1 > matchCount) add('非中立占位符形态（未闭合 ${）');
  };
  scanString(text);
  if (ESCAPED_PLACEHOLDER_RE.test(text)) add('非中立占位符形态（JSON 转义占位符，须以字面 ${...} 书写）');
  let decodedStrings = null;
  try {
    decodedStrings = [];
    walkJsonStrings(JSON.parse(text), (s) => { decodedStrings.push(s); });
    for (const s of decodedStrings) scanString(s);
  } catch { decodedStrings = null; }
  return { hits, decodedStrings };
}

/**
 * 非中立占位符判定（R-pc-3「唯一合法占位符为 `${PLUGIN_ROOT}`」的机械面）：
 * 原文捕获任意非 PLUGIN_ROOT 的 `${...}` 与未闭合 `${`；JSON 可解析时对解码态键/字符串值复核，
 * 覆盖 `\u0024{plugin_root}` 等转义写法（转义形一律拒，与 内部接口-1 §2 冻结字面量一致）。
 * @param {string} text manifest 原文（或任何待扫文本）
 * @returns {string[]} 命中清单（空数组=干净）
 */
export function neutralPlaceholderHits(text) {
  return neutralScan(text).hits;
}

/** 宿主专有名词命中（解码态扫描；词表经 escapeRegExp 后按词边界匹配——转义形态可捕获）。 */
function hostHits(decoded) {
  const hits = [];
  for (const term of HOST_TERMS) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(decoded)) hits.push(`宿主专有名 ${term}`);
  }
  return hits;
}

/**
 * 宿主专有名词命中清单（供一致性门等只读消费；与 lintNeutrality 同一实现，单源无副本）。
 * @param {string} text manifest 原文
 * @returns {string[]} 命中清单（空数组=干净）
 */
export function hostTermHits(text) {
  const { decodedStrings } = neutralScan(text);
  return hostHits(decodedStrings === null ? text : decodedStrings.join('\n'));
}

/**
 * 中立性 lint：占位符形态（neutralScan 一次遍历）＋宿主专有名词；JSON 解码态结果与占位符扫描共用。
 * @param {string} text manifest 原文
 * @returns {string[]} 命中清单（空数组=干净）
 */
export function lintNeutrality(text) {
  const { hits, decodedStrings } = neutralScan(text);
  hits.push(...hostHits(decodedStrings === null ? text : decodedStrings.join('\n')));
  return hits;
}

/** 读取能力矩阵的 hook.events 词表（宿主列并集）；矩阵不可读/损坏抛具名错误（构建环境错误）。 */
function loadEventVocabulary() {
  let raw;
  try {
    raw = readFileSync(join(SRC_DIR, '..', 'capability-matrix.json'), 'utf8');
  } catch {
    throw new Error('能力矩阵缺失或不可读: ' + join(SRC_DIR, '..', 'capability-matrix.json'));
  }
  try {
    const matrix = JSON.parse(raw);
    const set = new Set();
    for (const host of matrix.hosts) for (const e of matrix.capabilities['hook.events'][host]) set.add(e);
    return set;
  } catch {
    throw new Error('能力矩阵缺失或损坏: ' + join(SRC_DIR, '..', 'capability-matrix.json'));
  }
}

/**
 * 校验单插件中立清单：schema（键白名单/字段类型/version 三段式/args containment）+ 中立性 lint +
 * 声明面目录存在性，错误一次列全；**manifest 输入**不抛异常（缺失/坏 JSON/顶层非对象均单错即返；
 * 能力矩阵不可读属构建环境错误，由 loadEventVocabulary 抛出具名错误）。
 * @param {string} repoRoot 仓库根
 * @param {string} plugin 插件名
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(repoRoot, plugin) {
  const manifestPath = join(repoRoot, plugin, 'plugin.manifest.json');
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return { ok: false, errors: [`manifest 缺失: ${manifestPath}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`manifest JSON 语法错误: ${e.message}`] };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest JSON 顶层须为对象，实测 ' + (Array.isArray(manifest) ? '数组' : JSON.stringify(manifest))] };
  }

  const errors = [];
  const events = loadEventVocabulary();

  for (const k of Object.keys(manifest)) {
    if (!TOP_KEYS.includes(k)) errors.push(`未知顶层键 ${k}`);
  }
  if (manifest.manifestVersion !== 1) errors.push(`manifestVersion 须为 1，实测 ${JSON.stringify(manifest.manifestVersion)}`);
  for (const f of META_FIELDS) {
    if (typeof manifest[f] !== 'string' || manifest[f].length === 0) errors.push(`${f} 须为非空字符串`);
  }
  // version 三段式（内部决策-017 统一版本约定 + bump 闸同款形态）：版本会被下游适配层拼入文件系统路径，
  // 非三段形态（含 `..`/分隔符/前缀）须在唯一编辑面即拒，防路径穿越链。
  if (typeof manifest.version === 'string' && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push(`version 须为三段式 SemVer（\\d+.\\d+.\\d+），实测 ${JSON.stringify(manifest.version)}`);
  }
  // 可选 displayName（内部任务-5 B，R-pc-14）：各插件唯一人工编辑展示源——出现即须为非空白字符串
  //（缺省合法：strict-backward 扩展，无既有键语义变更）。四宿主适配只把该值映射到已证展示位。
  if (manifest.displayName !== undefined) {
    if (typeof manifest.displayName !== 'string') errors.push('displayName 须为字符串');
    else if (manifest.displayName.trim() === '') errors.push('displayName 须为非空白字符串（展示单源不得为空值）');
  }

  const agentsDir = join(repoRoot, plugin, 'agents');
  const hasAgentsDir = existsSync(agentsDir);
  const surfaces = manifest.surfaces;
  if (surfaces !== undefined) {
    if (typeof surfaces !== 'object' || surfaces === null || Array.isArray(surfaces)) {
      errors.push('surfaces 须为对象');
    } else {
      for (const k of Object.keys(surfaces)) {
        if (k !== 'agents') errors.push(`surfaces 未知键 ${k}（skills/commands 按目录扫描派生，不登记）`);
      }
      if (surfaces.agents !== undefined) {
        if (typeof surfaces.agents !== 'object' || surfaces.agents === null) errors.push('surfaces.agents 须为对象');
        else if (typeof surfaces.agents.defaultMount !== 'boolean') errors.push('surfaces.agents.defaultMount 须为 boolean');
      }
    }
  }
  if (hasAgentsDir && !(surfaces && surfaces.agents)) errors.push('agents/ 目录存在但 surfaces.agents 未登记');
  if (!hasAgentsDir && surfaces && surfaces.agents) errors.push('surfaces.agents 已登记但 agents/ 目录不存在');

  if (manifest.hooks !== undefined) {
    if (!Array.isArray(manifest.hooks)) {
      errors.push('hooks 须为数组');
    } else {
      manifest.hooks.forEach((h, i) => {
        const at = `hooks[${i}]`;
        if (typeof h !== 'object' || h === null || Array.isArray(h)) { errors.push(`${at} 须为对象`); return; }
        for (const k of Object.keys(h)) {
          if (!HOOK_KEYS.includes(k)) errors.push(`${at} 未知键 ${k}`);
        }
        if (!Object.hasOwn(h, 'event')) errors.push(`${at}.event 缺失`);
        else if (!events.has(h.event)) errors.push(`${at}.event 未知事件 ${h.event}（合法集：${[...events].join('|')}）`);
        if (h.type !== 'process') errors.push(`${at}.type 须为 "process"`);
        if (typeof h.command !== 'string' || h.command.length === 0) errors.push(`${at}.command 须为非空字符串`);
        if (h.matcher !== undefined && typeof h.matcher !== 'string') errors.push(`${at}.matcher 须为字符串`);
        if (!Array.isArray(h.args) || !h.args.every((a) => typeof a === 'string')) errors.push(`${at}.args 须为字符串数组`);
        if (!Number.isInteger(h.timeoutMs) || h.timeoutMs <= 0) errors.push(`${at}.timeoutMs 须为正整数`);
        if (typeof h.statusMessage !== 'string') errors.push(`${at}.statusMessage 须为字符串`);
        // 声明面存在性 + containment：${PLUGIN_ROOT}/ 展开后须落在插件根内且在磁盘上
        for (const a of Array.isArray(h.args) ? h.args : []) {
          if (typeof a === 'string' && a.startsWith('${PLUGIN_ROOT}/')) {
            const rel = a.slice('${PLUGIN_ROOT}/'.length);
            const pluginRoot = join(repoRoot, plugin);
            const resolved = resolve(pluginRoot, rel);
            const relCheck = relative(pluginRoot, resolved);
            // 越界判定：relative 为 '..' 或以 '../' 开头才是越界（`..data` 属插件根内合法目录名）
            if (relCheck === '..' || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck)) errors.push(`${at}.args 越出插件根: ${rel}`);
            else if (!existsSync(resolved)) errors.push(`${at}.args 引用的脚本缺失: ${rel}`);
          }
        }
      });
    }
  }

  for (const hit of lintNeutrality(raw)) errors.push(`lint: ${hit}`);

  return { ok: errors.length === 0, errors };
}

/** 规则库版本（params 机读化形态，内部决策-037；**单源导出**：engine.mjs 与测试共用）。 */
export const RULES_VERSION = 2;
/** 策略族枚举（六族，内部决策-037 决策 2；单源导出）。 */
export const STRATEGIES = ['emulate', 'degrade', 'relay', 'map', 'disable', 'normalize'];
/** 保真度枚举（单源导出）。 */
export const FIDELITIES = ['lossless', 'lossy', 'degraded'];
/** params 恒不参与的宿主键——zcode 零降级（「zcode 恒 applied:false」的数据面机器形态）。 */
const NON_PARTICIPATING_HOST = 'zcode';
/** 非空 string[] 谓词（readPriority/synthesize 共用，避免同语义双写）。 */
const isNonEmptyStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
/**
 * 规则级 params 字段 schema（**单源**：测试与校验器共用本导出，门 B 简洁性维发现 6 处置——
 * 原「同源双份」注释承诺改为构造性事实）：allOf=每 host 条目必备字段；anyOf=每 host 条目至少含其一。
 */
export const PARAM_RULE_FIELDS = {
  'command-to-skill': { anyOf: ['form'] },
  'followup-expansion': { allOf: ['api', 'fallback'] },
  'agent-default-off-fail-closed': { allOf: ['defaultMount', 'unknownTool'] },
  'message-slot-migration': { anyOf: ['readPriority', 'rename'] },
  'failure-event-merge': { allOf: ['into', 'synthesize'] },
  'stop-pending-relay': { allOf: ['store', 'deliverOn', 'burstCap', 'pendingLimit', 'capNote'], anyOf: ['triggerEvent', 'relayEvents'] },
  'timeout-cap-fail-open': { allOf: ['cap', 'onTimeout', 'minSeconds', 'maxSeconds', 'defaultSeconds', 'marginMs', 'minBudgetMs'] },
  'source-widen-normalize': { allOf: ['to', 'accepted'] },
  'tool-vocab-map': { allOf: ['direction', 'table'] },
  'namespace-transform': { allOf: ['separator', 'collision'] },
};
/**
 * 字段值契约：返回 null=通过，否则返回期望描述。未登记字段不判（开放键）。
 */
const PARAM_FIELD_RULES = {
  direction: (v) => (['widen', 'one-to-one'].includes(v) ? null : '须为 widen|one-to-one'),
  unknownTool: (v) => (v === 'reject' ? null : '须为 reject'),
  cap: (v) => (v === 'host-max' ? null : '须为 host-max'),
  onTimeout: (v) => (v === 'kill-fail-open-remind' ? null : '须为 kill-fail-open-remind'),
  store: (v) => (v === 'PLUGIN_DATA' || (typeof v === 'string' && v.startsWith('$') && v.length > 1) ? null : '须为 PLUGIN_DATA 或 $ 开头的宿主存储路径模板'),
  deliverOn: (v) => (v === 'UserPromptSubmit' ? null : '须为 UserPromptSubmit'),
  collision: (v) => (v === 'first-wins-warn' ? null : '须为 first-wins-warn'),
  prefix: (v) => (v === 'plugin-name' ? null : '须为 plugin-name'),
  form: (v) => (v === 'same-name-skill' ? null : '须为 same-name-skill'),
  api: (v) => (v === 'agent.followup' ? null : '须为 agent.followup'),
  fallback: (v) => (v === 'receipt-no-drive' ? null : '须为 receipt-no-drive'),
  burstCap: (v) => (Number.isInteger(v) && v > 0 ? null : '须为正整数'),
  defaultMount: (v) => (typeof v === 'boolean' ? null : '须为 boolean'),
  separator: (v) => (typeof v === 'string' && v !== '' ? null : '须为非空字符串'),
  to: (v) => (typeof v === 'string' && v !== '' ? null : '须为非空字符串'),
  into: (v) => (typeof v === 'string' && v !== '' ? null : '须为非空字符串'),
  note: (v) => (typeof v === 'string' ? null : '须为字符串'),
  table: (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isNonEmptyStringArray)
      ? null
      : '须为 词→非空 string[] 的映射',
  rename: (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string') ? null : '须为 string→string 的映射',
  readPriority: (v) => (isNonEmptyStringArray(v) ? null : '须为非空 string[]'),
  synthesize: (v) => (isNonEmptyStringArray(v) ? null : '须为非空 string[]'),
  accepted: (v) => (isNonEmptyStringArray(v) ? null : '须为非空 string[]'),
  triggerEvent: (v) => (typeof v === 'string' && v !== '' ? null : '须为非空字符串'),
  relayEvents: (v) => (isNonEmptyStringArray(v) ? null : '须为非空 string[]（被中继事件清单，ADR-038 kimi 列扩字段）'),
  capNote: (v) => (typeof v === 'string' ? null : '须为字符串'),
  pendingLimit: (v) => (Number.isInteger(v) && v > 0 ? null : '须为正整数'),
  minSeconds: (v) => (Number.isInteger(v) && v > 0 ? null : '须为正整数'),
  maxSeconds: (v) => (Number.isInteger(v) && v > 0 ? null : '须为正整数'),
  defaultSeconds: (v) => (Number.isInteger(v) && v > 0 ? null : '须为正整数'),
  marginMs: (v) => (Number.isInteger(v) && v >= 0 ? null : '须为非负整数'),
  minBudgetMs: (v) => (Number.isInteger(v) && v >= 0 ? null : '须为非负整数'),
  constants: (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => ['string', 'number', 'boolean'].includes(typeof x))
      ? null
      : '须为 常量名→标量 的映射',
};

/**
 * 校验降级规则库（params 机读化 v2，内部决策-037/内部需求-7）：结构 + 规则级字段 schema + 字段值契约，
 * 错误一次列全；任何输入不抛异常。`trigger.capability` 的键集校验消费矩阵。
 * @param {object} rulesDoc degradation-rules.json 的解析结果
 * @param {object} matrixDoc capability-matrix.json 的解析结果
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRules(rulesDoc, matrixDoc) {
  const errors = [];
  if (rulesDoc === null || typeof rulesDoc !== 'object' || Array.isArray(rulesDoc)) {
    return { ok: false, errors: ['规则库 JSON 顶层须为对象'] };
  }
  if (rulesDoc.rulesVersion !== RULES_VERSION) {
    errors.push(`rulesVersion 须为 ${RULES_VERSION}，实测 ${JSON.stringify(rulesDoc.rulesVersion)}`);
  }
  if (!Array.isArray(rulesDoc.rules)) return { ok: false, errors: [...errors, 'rules 须为数组'] };
  const caps = matrixDoc && typeof matrixDoc === 'object' && matrixDoc.capabilities && typeof matrixDoc.capabilities === 'object' ? matrixDoc.capabilities : null;
  if (caps === null) errors.push('矩阵 capabilities 缺失或非对象');
  // 宿主集单一真相源 = 矩阵 hosts（门 A 正确性/约定维发现 3：「新增宿主=矩阵加列+params 加项」的成本式
  // 要求宿主集不得在本文件二次硬编码）；zcode 恒不参与（零降级）为唯一例外。
  const hostList = matrixDoc && typeof matrixDoc === 'object' && Array.isArray(matrixDoc.hosts) ? matrixDoc.hosts : null;
  if (hostList === null) errors.push('矩阵 hosts 缺失或非数组');

  const seen = new Set();
  rulesDoc.rules.forEach((rule, i) => {
    const at = `rules[${i}]${rule && typeof rule === 'object' && !Array.isArray(rule) && typeof rule.id === 'string' && rule.id !== '' ? `(${rule.id})` : ''}`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${at} 须为对象`);
      return;
    }
    if (typeof rule.id !== 'string' || rule.id === '') errors.push(`${at}.id 须为非空字符串`);
    else if (seen.has(rule.id)) errors.push(`${at}.id 重复：${rule.id}`);
    else seen.add(rule.id);
    if (!STRATEGIES.includes(rule.strategy)) errors.push(`${at}.strategy 越枚举：${JSON.stringify(rule.strategy)}（合法集：${STRATEGIES.join('|')}）`);
    if (!FIDELITIES.includes(rule.fidelity)) errors.push(`${at}.fidelity 越枚举：${JSON.stringify(rule.fidelity)}（合法集：${FIDELITIES.join('|')}）`);
    if (!rule.trigger || typeof rule.trigger !== 'object' || typeof rule.trigger.capability !== 'string') {
      errors.push(`${at}.trigger.capability 须为字符串`);
    } else if (caps !== null && !Object.hasOwn(caps, rule.trigger.capability)) {
      errors.push(`${at}.trigger.capability 不在矩阵键集：${rule.trigger.capability}（见 capability-matrix.json 的 capabilities 键集）`);
    }
    if (!Array.isArray(rule.sourceRef) || rule.sourceRef.length === 0) errors.push(`${at}.sourceRef 须为非空数组`);

    const params = rule.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      errors.push(`${at}.params 须为对象（机读化 v2）`);
      return;
    }
    const paramHosts = Object.keys(params);
    if (paramHosts.length === 0) errors.push(`${at}.params 无宿主键`);
    const fields = Object.hasOwn(PARAM_RULE_FIELDS, rule.id) ? PARAM_RULE_FIELDS[rule.id] : null;
    if (!fields) errors.push(`${at} 无 params 字段 schema 登记：${rule.id}`);
    for (const h of paramHosts) {
      const hpAt = `${at}.params.${h}`;
      if (h === NON_PARTICIPATING_HOST) errors.push(`${hpAt} 宿主键 ${h} 恒不参与（零降级）`);
      else if (hostList !== null && !hostList.includes(h)) errors.push(`${hpAt} 宿主键 ${h} 不在矩阵 hosts（${hostList.join('|')}）`);
      const hp = params[h];
      if (hp === null || typeof hp !== 'object' || Array.isArray(hp) || Object.keys(hp).length === 0) {
        errors.push(`${hpAt} 须为非空对象`);
        continue;
      }
      if (fields) {
        for (const f of fields.allOf ?? []) if (!Object.hasOwn(hp, f)) errors.push(`${hpAt} 缺必需字段 ${f}`);
        if (fields.anyOf && !fields.anyOf.some((f) => Object.hasOwn(hp, f))) errors.push(`${hpAt} 至少需含 ${fields.anyOf.join('/')} 之一`);
      }
      for (const [f, v] of Object.entries(hp)) {
        if (!Object.hasOwn(PARAM_FIELD_RULES, f)) continue; // 未登记字段不判（开放键）
        const msg = PARAM_FIELD_RULES[f](v);
        if (msg) errors.push(`${hpAt}.${f} ${msg}，实测 ${JSON.stringify(v)}`);
      }
      // 规则级跨字段不变式（内部任务-238 S2）：数据误改从「运行期静默失效」提前到装载期拒载
      if (rule.id === 'source-widen-normalize' && Array.isArray(hp.accepted) && typeof hp.to === 'string' && !hp.accepted.includes(hp.to)) {
        errors.push(`${hpAt}.to 须在 accepted 内（归一结果须落在下游 matcher 域），实测 ${JSON.stringify(hp.to)}`);
      }
      if (rule.id === 'timeout-cap-fail-open' && [hp.minSeconds, hp.maxSeconds, hp.defaultSeconds].every(Number.isInteger)) {
        if (hp.minSeconds > hp.maxSeconds || hp.defaultSeconds < hp.minSeconds || hp.defaultSeconds > hp.maxSeconds) {
          errors.push(`${hpAt} 秒数区间须满足 minSeconds ≤ defaultSeconds ≤ maxSeconds，实测 ${JSON.stringify([hp.minSeconds, hp.defaultSeconds, hp.maxSeconds])}`);
        }
      }
      if (rule.id === 'stop-pending-relay' && typeof hp.triggerEvent === 'string' && typeof hp.deliverOn === 'string' && hp.triggerEvent === hp.deliverOn) {
        errors.push(`${hpAt}.triggerEvent 不得等于 deliverOn（中继触发事件与投递事件须分离），实测 ${JSON.stringify(hp.triggerEvent)}`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
