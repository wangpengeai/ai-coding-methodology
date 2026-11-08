// 文件：workflow/scripts/lib/project-skills.mjs
// 描述：项目级 skill 发现/清单/消费义务的单源库（内部决策-070，内部任务-341）。负责发现根扫描、
//       YAML-lite frontmatter 解析、清单构建/序列化/校验/漂移比较、按宿主过滤的可适用
//       必载集合、ack 覆盖检查与声明命令片段；供 SessionStart、routing-declare、
//       routing-gate、write-guard、生成器与一致性检查器共用，防止多份实现漂移。
// 作者：内部任务-341 批
// 版权：MIT
// 用法：import { buildManifest, requiredProjectSkills, missingAcks } from './project-skills.mjs'

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { hostOf } from './host-detect.mjs';

/** 清单文件（项目根相对 POSIX 路径）。 */
export const MANIFEST_REL = '.agents/skills-manifest.json';
/** 生成器命令路径（清单 generator 字段恒值，亦用于受信写者表）。 */
export const GENERATOR_REL = 'workflow/scripts/generate-project-skills-manifest.mjs';
/** 生成面扫描的固定五根（顺序即清单 roots 顺序；消费面再按当前宿主过滤）。 */
export const ROOTS = ['.dsh/skills', '.zcode/skills', '.kimi-code/skills', '.minimax/skills', '.agents/skills'];
/** 共同发现根（恒扫、恒适用）。 */
export const COMMON_ROOT = '.agents/skills';
/** 宿主 → 专属项目级发现根。 */
export const HOST_ROOT_BY_HOST = {
  dsh: '.dsh/skills',
  zcode: '.zcode/skills',
  kimi: '.kimi-code/skills',
  mcode: '.minimax/skills',
};
/** skill 名合法形态。 */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** 注入行里加载场景的最大字符数（超出截断加 …）。 */
export const LOAD_SCENARIO_MAX = 160;
/** 清单 schema 版本。 */
export const SCHEMA_VERSION = 1;

const SKILL_FILE = 'SKILL.md';
const REQUIRED_TRUE = new Set(['true', 'yes', 'on', '1']);
const REQUIRED_FALSE = new Set(['false', 'no', 'off', '0']);

/** 行尾归一：CRLF→LF（清单哈希与比较的唯一口径）。 */
export function normalizeLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/** 内容哈希：LF 归一后小写 64 位 hex（不带 sha256: 前缀）。 */
export function lfSha256(text) {
  return createHash('sha256').update(normalizeLf(text), 'utf8').digest('hex');
}

/** 去引号与首尾空白。 */
function unquote(value) {
  const v = String(value).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 解析 SKILL.md 的 YAML-lite frontmatter：支持顶层 key: value、`>`/`|` 折叠块标量，
 * 跳过 `metadata:` 等嵌套块。解析失败/无 frontmatter 返回空对象（调用方按缺字段处理）。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseFrontmatter(text) {
  const lines = normalizeLf(text).split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return {};
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return {};
  const fields = Object.create(null);
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const collected = [];
      i += 1;
      while (i < end && /^\s+\S/.test(lines[i])) {
        collected.push(lines[i].trim());
        i += 1;
      }
      i -= 1;
      fields[key] = value.startsWith('>') ? collected.join(' ').trim() : collected.join('\n').trim();
    } else if (value === '') {
      // 嵌套块（如 metadata:）：跳过其缩进子行，不写入 fields。
      i += 1;
      while (i < end && /^\s+\S/.test(lines[i])) i += 1;
      i -= 1;
    } else {
      fields[key] = unquote(value);
    }
  }
  return fields;
}

/** 解析布尔声明：true 集/ false 集之外返回 null（非法值由调用方报错）。 */
function parseDeclaredBoolean(value) {
  if (value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  if (REQUIRED_TRUE.has(v)) return true;
  if (REQUIRED_FALSE.has(v)) return false;
  return null;
}

/** 截断加载场景到注入安全长度（单行）。 */
export function clipLoadScenario(scenario) {
  const oneLine = String(scenario ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= LOAD_SCENARIO_MAX) return oneLine;
  return `${oneLine.slice(0, LOAD_SCENARIO_MAX - 1)}…`;
}

/** 当前宿主可适用的发现根（宿主专属根优先 + 共同根；未知宿主仅共同根）。 */
export function applicableRoots(host) {
  const hostRoot = HOST_ROOT_BY_HOST[host];
  return hostRoot ? [hostRoot, COMMON_ROOT] : [COMMON_ROOT];
}

function listSkillDirs(absRoot) {
  try {
    const names = readdirSync(absRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return { names, error: null };
  } catch (e) {
    if (e?.code === 'ENOENT') return { names: [], error: null };
    return { names: [], error: `发现根不可读（${e?.code ?? e?.message ?? 'unknown'}）` };
  }
}

/**
 * 扫描指定发现根下的项目级 skill。
 * @param {{projectRoot:string, roots?:string[]}} options
 * @returns {{skills:Array<{name:string,root:string,path:string,loadScenario:string,requiredOnWrite:boolean,sha256:string}>, errors:string[]}}
 */
export function scanProjectSkills({ projectRoot, roots = ROOTS }) {
  const skills = [];
  const errors = [];
  const rootErrors = [];
  for (const root of roots) {
    const absRoot = join(projectRoot, root);
    try {
      if (!existsSync(absRoot)) continue;
      if (!statSync(absRoot).isDirectory()) continue;
    } catch (e) {
      rootErrors.push(`${root}: 发现根不可读（${e.message}）`);
      continue;
    }
    const listed = listSkillDirs(absRoot);
    if (listed.error) {
      rootErrors.push(`${root}: ${listed.error}`);
      continue;
    }
    for (const dirName of listed.names) {
      const absSkill = join(absRoot, dirName, SKILL_FILE);
      let text;
      try {
        if (!existsSync(absSkill) || !statSync(absSkill).isFile()) continue;
        text = readFileSync(absSkill, 'utf8');
      } catch (e) {
        errors.push(`${root}/${dirName}/${SKILL_FILE}: 条目不可读（${e?.code ?? e?.message ?? 'unknown'}）`);
        continue;
      }
      const fields = parseFrontmatter(text);
      const name = String(fields.name ?? '').trim();
      if (!NAME_RE.test(name)) {
        errors.push(`${root}/${dirName}/${SKILL_FILE}: name 缺失或非法（${name || '空'}）`);
        continue;
      }
      const requiredOnWrite = parseDeclaredBoolean(fields['x-required-on-write']);
      if (requiredOnWrite === null) {
        errors.push(`${root}/${dirName}/${SKILL_FILE}: x-required-on-write 非布尔值`);
        continue;
      }
      const rawScenario = fields['x-load-scenario'] ?? fields.description ?? '';
      const loadScenario = clipLoadScenario(rawScenario);
      if (!loadScenario) {
        errors.push(`${root}/${dirName}/${SKILL_FILE}: 缺加载场景（x-load-scenario 与 description 均为空）`);
        continue;
      }
      skills.push({
        name,
        root,
        path: `${root}/${dirName}/${SKILL_FILE}`,
        loadScenario,
        requiredOnWrite,
        sha256: lfSha256(text),
      });
    }
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : ROOTS.indexOf(a.root) - ROOTS.indexOf(b.root)));
  return { skills, errors, rootErrors };
}

/**
 * 生成清单对象（生成面扫描固定五根；不写盘）。
 * @param {{projectRoot:string}} options
 * @returns {{manifest:object, errors:string[]}}
 */
export function buildManifest({ projectRoot }) {
  const { skills, errors, rootErrors } = scanProjectSkills({ projectRoot, roots: ROOTS });
  return {
    manifest: { schemaVersion: SCHEMA_VERSION, generator: GENERATOR_REL, roots: [...ROOTS], skills },
    errors: [...rootErrors, ...errors],
  };
}

/** 确定性序列化（2 空格缩进 + 末尾换行；无易变字段）。 */
export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** 校验清单形状与确定性约束；返回错误列表（空数组即合法）。 */
export function validateManifestShape(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['清单须为对象'];
  if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion 须为 ${SCHEMA_VERSION}`);
  if (manifest.generator !== GENERATOR_REL) errors.push('generator 字段与本生成器路径不一致');
  if (!Array.isArray(manifest.roots) || manifest.roots.join('|') !== ROOTS.join('|')) errors.push('roots 必须为固定五根且顺序一致');
  if (!Array.isArray(manifest.skills)) return [...errors, 'skills 须为数组'];
  let prev = null;
  for (const [index, skill] of manifest.skills.entries()) {
    const where = `skills[${index}]`;
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      errors.push(`${where} 须为对象`);
      continue;
    }
    for (const key of ['name', 'root', 'path', 'loadScenario', 'sha256']) {
      if (typeof skill[key] !== 'string' || !skill[key].trim()) errors.push(`${where}.${key} 须为非空字符串`);
    }
    if (typeof skill.name === 'string' && !NAME_RE.test(skill.name)) errors.push(`${where}.name 非法`);
    if (typeof skill.root === 'string' && !ROOTS.includes(skill.root)) errors.push(`${where}.root 不在固定五根内`);
    if (typeof skill.path === 'string' && !/^\.(dsh|zcode|kimi-code|minimax|agents)\/skills\/[a-z][a-z0-9-]*\/SKILL\.md$/.test(skill.path)) {
      errors.push(`${where}.path 非项目根相对 POSIX SKILL.md 路径`);
    }
    if (typeof skill.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(skill.sha256)) errors.push(`${where}.sha256 须为 64 位小写 hex`);
    if (typeof skill.requiredOnWrite !== 'boolean') errors.push(`${where}.requiredOnWrite 须为布尔`);
    if (typeof skill.loadScenario === 'string' && !clipLoadScenario(skill.loadScenario)) errors.push(`${where}.loadScenario 为空`);
    const key = typeof skill.name === 'string' && typeof skill.root === 'string' ? `${skill.name}@${skill.root}` : '';
    const sortKey = `${skill.name}\u0000${ROOTS.indexOf(skill.root)}`;
    if (prev !== null && sortKey < prev) errors.push(`${where} 排序不符合 name 字典序/root 顺序`);
    prev = sortKey;
    if (key && manifest.skills.filter((s) => `${s.name}@${s.root}` === key).length > 1) errors.push(`${where} 重复条目 ${key}`);
  }
  return errors;
}

/** 读清单；缺失/不可解析/形状非法返回 {ok:false,error}。 */
export function readManifest({ projectRoot }) {
  const abs = join(projectRoot, MANIFEST_REL);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, error: '清单不存在' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    return { ok: false, error: `清单 JSON 不可解析：${error.message}` };
  }
  const errors = validateManifestShape(manifest);
  if (errors.length > 0) return { ok: false, error: `清单形状非法：${errors.join('；')}` };
  return { ok: true, manifest };
}

/** 比较当前源与清单，返回漂移原因列表（空数组即同步）。 */
export function manifestDrift({ projectRoot }) {
  const expected = buildManifest({ projectRoot });
  if (expected.errors.length > 0) return { ok: false, errors: expected.errors };
  const rendered = renderManifest(expected.manifest);
  const abs = join(projectRoot, MANIFEST_REL);
  if (!existsSync(abs)) return { ok: false, errors: ['清单缺失'], expected: expected.manifest };
  const actualText = readFileSync(abs, 'utf8');
  if (actualText !== rendered) return { ok: false, errors: ['清单与源不同步（内容/顺序/哈希任一不一致）'], expected: expected.manifest };
  const shape = validateManifestShape(JSON.parse(actualText));
  if (shape.length > 0) return { ok: false, errors: shape, expected: expected.manifest };
  return { ok: true, errors: [], manifest: expected.manifest };
}

/** 读清单成功则用清单，否则按当前宿主可适用根扫描源（fail-open 但带来源与告警）。 */
export function loadProjectSkills({ projectRoot, env = process.env }) {
  const host = hostOf({}, env);
  const roots = applicableRoots(host);
  const read = readManifest({ projectRoot });
  if (read.ok) {
    return { source: 'manifest', host, skills: read.manifest.skills, warning: null };
  }
  const scan = scanProjectSkills({ projectRoot, roots });
  if (scan.rootErrors.length > 0) {
    return { source: 'scan-error', host, skills: [], warning: scan.rootErrors.join('；') };
  }
  const manifestProblem = read.error && !String(read.error).includes('不存在') ? [read.error] : [];
  const warningParts = [...manifestProblem, ...scan.errors];
  return { source: 'scan', host, skills: scan.skills, warning: warningParts.length > 0 ? warningParts.join('；') : null };
}

/** 按宿主过滤：宿主专属根优先于 .agents 同名条目；同名条目任一标注必载即必载（防覆盖降级）。 */
export function applicableSkills(skills, host) {
  const order = applicableRoots(host);
  const chosen = new Map();
  for (const skill of skills) {
    if (!order.includes(skill.root)) continue;
    const existing = chosen.get(skill.name);
    if (!existing) {
      chosen.set(skill.name, { ...skill });
      continue;
    }
    const preferred = order.indexOf(skill.root) < order.indexOf(existing.root) ? skill : existing;
    chosen.set(skill.name, { ...preferred, requiredOnWrite: existing.requiredOnWrite === true || skill.requiredOnWrite === true });
  }
  return [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 当前宿主可适用的必载集合（权威面：清单优先、缺失/损坏回退源扫描）。
 * @returns {{required:object[], advisory:object[], source:string, host:string, warning:string|null}}
 */
export function requiredProjectSkills({ projectRoot, env = process.env }) {
  const loaded = loadProjectSkills({ projectRoot, env });
  const applicable = loaded.source === 'scan-error' ? [] : applicableSkills(loaded.skills, loaded.host);
  return {
    required: applicable.filter((s) => s.requiredOnWrite === true),
    advisory: applicable.filter((s) => s.requiredOnWrite !== true),
    source: loaded.source,
    host: loaded.host,
    warning: loaded.warning,
  };
}

/** 源扫描版必载集合（供 declare 陈旧探针比较；不受清单影响）。 */
export function requiredProjectSkillsFromSource({ projectRoot, env = process.env }) {
  const host = hostOf({}, env);
  const scan = scanProjectSkills({ projectRoot, roots: applicableRoots(host) });
  const applicable = applicableSkills(scan.skills, host);
  return { host, skills: applicable, required: applicable.filter((s) => s.requiredOnWrite === true), errors: scan.errors, rootErrors: scan.rootErrors };
}

/** 租约 projectSkills 对必载集合的缺项（按 name 比对；旧租约无字段视为空）。 */
export function missingAcks(required, lease) {
  const acks = lease && typeof lease === 'object' && Array.isArray(lease.projectSkills) ? lease.projectSkills : [];
  const names = new Set(acks.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean));
  return required.filter((skill) => !names.has(skill.name));
}

/** 生成 routing-declare 的 ack 片段（逐项 --project-skill）。 */
export function ackFlags(names) {
  const flags = [];
  for (const name of names) flags.push('--project-skill', name);
  return flags;
}

/** SessionStart 注入行（每条一行；必载项带 ack 提示）。 */
export function renderProjectSkillIndexLines(skills) {
  return skills.map((skill) => {
    const ackHint = skill.requiredOnWrite ? `；必载项声明须 --project-skill ${skill.name}` : '';
    return `【项目 skill】${skill.name} @ ${skill.root}：${clipLoadScenario(skill.loadScenario)}（写操作前加载${ackHint}）`;
  });
}

export default {
  MANIFEST_REL,
  GENERATOR_REL,
  ROOTS,
  COMMON_ROOT,
  HOST_ROOT_BY_HOST,
  NAME_RE,
  LOAD_SCENARIO_MAX,
  SCHEMA_VERSION,
  normalizeLf,
  lfSha256,
  parseFrontmatter,
  clipLoadScenario,
  applicableRoots,
  scanProjectSkills,
  buildManifest,
  renderManifest,
  validateManifestShape,
  readManifest,
  manifestDrift,
  loadProjectSkills,
  applicableSkills,
  requiredProjectSkills,
  requiredProjectSkillsFromSource,
  missingAcks,
  ackFlags,
  renderProjectSkillIndexLines,
};
