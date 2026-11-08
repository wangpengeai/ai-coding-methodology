// 文件：ZCode 物化器
// 描述：自写序列化器（纯标量数组行内）+ renderArtifacts 纯函数 + planAll/applyPlan/verifyPlan（原子写、内存对拍）
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：import { serializeHookDoc, renderArtifacts, zcodeColumn, planAll, applyPlan, verifyPlan } from './materialize.mjs'
// 自检：node --test "plugin-core/tests/materialize.test.mjs"
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './validate.mjs';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
/** 六插件套件（与 zcode-adapter/src/manifests.mjs 的 PLUGINS 同源——加插件时两侧同步；research-loop 2026-10-16 内部任务-109/内部决策-047 入套）。 */
export const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];
const ARTIFACT_RELS = ['.zcode-plugin/plugin.json', 'hooks/hooks.json'];

function loadMatrix() {
  const path = join(SRC_DIR, '..', 'capability-matrix.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    throw new Error('能力矩阵缺失或损坏: ' + path);
  }
}

/**
 * 读矩阵 zcode 列构造物化参数；bump（zcode-adapter）/收敛测试/物化器三处共用同一构造。
 * @returns {{placeholder: string, declarationShape: string}}
 */
export function zcodeColumn() {
  const caps = loadMatrix().capabilities;
  return {
    placeholder: caps['pluginRoot.placeholder'].zcode,
    declarationShape: caps['hook.declarationShape'].zcode,
  };
}

// —— 自写序列化器：与现仓库生成物字节一致的三规则 ——
// ① 对象 2 空格缩进逐键展开；② 纯标量数组行内（", " 分隔，空数组 []）；③ 含对象数组展开 + 文件尾 \n
function serializeValue(v, indent) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((e) => e === null || typeof e !== 'object')) {
      return '[' + v.map((e) => JSON.stringify(e)).join(', ') + ']';
    }
    const inner = v.map((e) => indent + '  ' + serializeValue(e, indent + '  ')).join(',\n');
    return '[\n' + inner + '\n' + indent + ']';
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  const inner = keys
    .map((k) => indent + '  ' + JSON.stringify(k) + ': ' + serializeValue(v[k], indent + '  '))
    .join(',\n');
  return '{\n' + inner + '\n' + indent + '}';
}

/**
 * 自写序列化：{hooks} 文档 → 与仓库生成物字节一致的文本（纯标量数组行内 + 2 空格缩进 + 尾 LF）。
 * @param {{hooks: Object}} doc 解析态文档
 * @returns {string}
 */
export function serializeHookDoc(doc) {
  return serializeValue(doc, '') + '\n';
}

// —— renderArtifacts：中立 manifest → 生成物字节（纯函数，矩阵经 import.meta.url 相对解析）——
/**
 * 中立 manifest → 生成物字节清单：plugin.json 恒有（四字段固定键序 JSON.stringify 2 空格 + LF），
 * hooks 非空时含 hooks.json（扁平声明按首次出现序分组、占位符译宿主形态、自写序列化）。
 * @param {object} manifest 解析态中立清单
 * @param {{placeholder: string, declarationShape: string}} [hostColumn] 物化参数（缺省 zcodeColumn()）
 * @returns {Array<{rel: string, bytes: Buffer}>}
 */
export function renderArtifacts(manifest, hostColumn = zcodeColumn()) {
  if (hostColumn.declarationShape !== 'event-grouped-envelope') {
    throw new Error(`不支持的声明形态: ${hostColumn.declarationShape}（期一唯一支持 event-grouped-envelope）`);
  }
  const artifacts = [{
    rel: ARTIFACT_RELS[0],
    bytes: Buffer.from(JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
    }, null, 2) + '\n', 'utf8'),
  }];
  if (Array.isArray(manifest.hooks) && manifest.hooks.length > 0) {
    // 扁平声明按首次出现序分组（稳定保序；禁止按键名排序——PostToolUseFailure 先于 PostToolUse 即由此复现）
    const grouped = {};
    for (const h of manifest.hooks) {
      const entry = h.matcher !== undefined ? { matcher: h.matcher, hooks: [] } : { hooks: [] };
      entry.hooks.push({
        type: h.type,
        command: h.command,
        args: h.args.map((a) => a.replaceAll('${PLUGIN_ROOT}', hostColumn.placeholder)),
        timeoutMs: h.timeoutMs,
        statusMessage: h.statusMessage,
      });
      (grouped[h.event] ??= []).push(entry);
    }
    artifacts.push({ rel: ARTIFACT_RELS[1], bytes: Buffer.from(serializeHookDoc({ hooks: grouped }), 'utf8') });
  }
  return artifacts;
}

function loadManifest(repoRoot, plugin) {
  return JSON.parse(readFileSync(join(repoRoot, plugin, 'plugin.manifest.json'), 'utf8'));
}

// 计划：先 validate（fail-closed 列全错即拒），再逐插件物化至内存——先读后算，全程零写
/**
 * @param {string} repoRoot 仓库根（realpath 形态）
 * @param {string[]} [plugins] 插件名清单（缺省六插件；非套件成员即 fail-closed）
 * @returns {Array<{plugin: string, rel: string, absPath: string, pluginRoot: string, bytes: Buffer}>}
 */
export function planAll(repoRoot, plugins = PLUGINS) {
  for (const p of plugins) {
    if (!PLUGINS.includes(p)) throw new Error(`planAll: 未知插件 ${p}（候选：${PLUGINS.join('/')}）`);
  }
  const failures = [];
  for (const p of plugins) {
    const r = validateManifest(repoRoot, p);
    if (!r.ok) failures.push(`${p}: ${r.errors.join('；')}`);
  }
  if (failures.length > 0) throw new Error('manifest 校验失败（拒物化）:\n' + failures.join('\n'));
  const plan = [];
  for (const p of plugins) {
    const pluginRoot = join(repoRoot, p);
    for (const { rel, bytes } of renderArtifacts(loadManifest(repoRoot, p))) {
      plan.push({ plugin: p, rel, absPath: join(pluginRoot, rel), pluginRoot, bytes });
    }
  }
  return plan;
}

/** 生成物成员键（plugin + rel 单一构造；写面清理与 verify 反向检测共用，防两处枚举漂移）。 */
const artifactKey = (plugin, rel) => `${plugin}|${rel}`;

/**
 * 写面落地：两类目标 × plan 派生路径；tmp+rename 同目录原子替换（.pc-tmp）。
 * 失败即报不修（fail-closed）——两目标各原子，交错失败由 verify 兜底检出。
 * 写前建目录（目标目录缺失可自愈 verify 的 missing）；.pc-tmp 为符号链接时拒绝写入（防写重定向）；
 * 写后清理计划外陈旧生成物（插件改零钩子/删 hooks 时旧 hooks.json 不得残留被宿主执行）。
 * plan 项须携带 pluginRoot（写目标归属校验与陈旧清理依赖；缺失即抛，不静默跳过守卫）。
 * @param {Array<{plugin: string, rel: string, absPath: string, pluginRoot: string, bytes: Buffer}>} plan planAll 产物
 * @returns {void}
 */
export function applyPlan(plan) {
  for (const item of plan) {
    if (!ARTIFACT_RELS.includes(item.rel)) throw new Error(`越白名单写目标: ${item.rel}`);
    if (typeof item.pluginRoot !== 'string') throw new Error(`plan 项缺 pluginRoot（写目标归属不可校验）: ${item.rel}`);
    // 写目标归属校验：absPath 必须恰为 pluginRoot/rel（拒绝「合法 rel + 越界 absPath」的库调用面绕过）
    const relRaw = relative(item.pluginRoot, item.absPath);
    const relCheck = relRaw.split(/[\\/]/).join('/');
    if (isAbsolute(relRaw) || relCheck !== item.rel) throw new Error(`越白名单写目标: ${item.rel}（absPath 越出插件根）`);
    const tmp = item.absPath + '.pc-tmp';
    try {
      mkdirSync(dirname(item.absPath), { recursive: true });
      const existing = lstatSync(tmp, { throwIfNoEntry: false });
      if (existing && existing.isSymbolicLink()) throw new Error(`.pc-tmp 为符号链接，拒绝写入: ${tmp}`);
      writeFileSync(tmp, item.bytes);
      renameSync(tmp, item.absPath);
    } catch (e) {
      throw new Error(`物化写失败 ${item.absPath}: ${e.message}`);
    }
  }
  // 计划外陈旧生成物清理（白名单仍是两类目标；成员判定与 verify 共用 artifactKey）
  const roots = new Map();
  for (const item of plan) roots.set(item.plugin, item.pluginRoot);
  const planned = new Set(plan.map(({ plugin, rel }) => artifactKey(plugin, rel)));
  for (const [plugin, pluginRoot] of roots) {
    for (const rel of ARTIFACT_RELS) {
      if (planned.has(artifactKey(plugin, rel))) continue;
      const stale = join(pluginRoot, rel);
      if (existsSync(stale)) unlinkSync(stale);
    }
  }
}

// 对拍：重算物化输出至内存，与磁盘逐文件 Buffer.equals；另反向枚举计划外生成物（extra），
// 使 内部接口-1 §3「verify 退 0 当且仅当仓库生成物=当前物化输出」双向成立。
/**
 * @param {string} repoRoot 仓库根（realpath 形态）
 * @param {string[]} [plugins] 插件名清单（缺省六插件）
 * @returns {Array<{plugin: string, rel: string, status: 'ok'|'changed'|'missing'|'extra'}>}
 */
export function verifyPlan(repoRoot, plugins = PLUGINS) {
  const plan = planAll(repoRoot, plugins);
  const results = plan.map(({ plugin, rel, absPath, bytes }) => {
    if (!existsSync(absPath)) return { plugin, rel, status: 'missing' };
    const onDisk = readFileSync(absPath);
    return { plugin, rel, status: Buffer.compare(onDisk, bytes) === 0 ? 'ok' : 'changed' };
  });
  const planned = new Set(plan.map(({ plugin, rel }) => artifactKey(plugin, rel)));
  for (const p of plugins) {
    for (const rel of ARTIFACT_RELS) {
      if (planned.has(artifactKey(p, rel))) continue;
      if (existsSync(join(repoRoot, p, rel))) results.push({ plugin: p, rel, status: 'extra' });
    }
  }
  return results;
}
