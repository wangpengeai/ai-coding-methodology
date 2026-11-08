// 文件：mcode-adapter/src/manifest.mjs
// 描述：MCode 插件清单（`.minimax-plugin/plugin.json`）的生成与校验。字段集严格取自
//       宿主 V1 文档：必填 `schemaVersion`/`name`/`version`/`description`/`author`/`icon`/
//       `category`/`exampleQueries`/`apps`/`mcpServers`/`skills`，可选 `displayName`/
//       `darkIcon`/`hooks`/`$schema`；**出现白名单外的键即整包被拒**，故本模块不产出
//       任何额外键（内部决策-034 决策 11）。`version` 取六插件 ZCode 清单的值（套件版本即
//       插件版本，内部决策-017），本层不另抄一份。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { CATEGORY } from './plugin-meta.mjs';
import { parseFrontmatter } from './command-skills.mjs';

/** 宿主 V1 清单的键白名单（`hooks` 可选；`$schema` 为字符串时允许）。 */
const ALLOWED_KEYS = new Set([
  'schemaVersion', 'name', 'displayName', 'version', 'description', 'author',
  'icon', 'darkIcon', 'category', 'exampleQueries', 'apps', 'mcpServers', 'skills', 'hooks', '$schema',
]);

/** 宿主 V1 `category` 枚举。 */
const CATEGORIES = new Set([
  'Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales',
  'Productivity', 'Science & Healthcare', 'Education', 'Other',
]);

/** 插件名 / MCP 服务器名的合法形态。 */
const NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** 宿主路径段字符集。 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** 清单必填键。 */
const REQUIRED_KEYS = ['schemaVersion', 'name', 'version', 'description', 'author', 'icon', 'category', 'exampleQueries', 'apps', 'mcpServers', 'skills'];

/**
 * SemVer 判据（宿主要求 `version` 为 SemVer；只判三段数字 + 可选预发布/构建后缀）。
 * @param {unknown} value 版本串
 * @returns {boolean}
 */
export function isSemVer(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * 包内相对路径合规判据（宿主：只用 `/`、段字符集受限、不得逃逸包根）。
 * @param {unknown} value 路径
 * @returns {boolean}
 */
export function isPortableRelPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..' && !segment.endsWith('.'));
}

/**
 * skill 文档面校验（宿主 `readPluginSkill` 的两条硬判据）。
 *
 * **为什么装前必须校**：宿主对 `frontmatter.name` 与目录名不符、或 `description` 为空，
 * 一律 `readerFail('SKILL_SCHEMA_INVALID')`——**抛异常即整包拒收**，不是"跳过这一个
 * skill"。本层原先只校路径形态，于是"改个 skill 目录名"这种最常见的改名操作，会让整个
 * 插件在宿主侧静默消失，而安装器一路绿灯。
 * @param {{rel: string, bytes: Buffer}[]} skillFiles 包内 `skills/<名>/SKILL.md` 文件
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateSkillDocs(skillFiles) {
  const problems = [];
  for (const file of skillFiles) {
    const name = file.rel.split('/')[1];
    const text = Buffer.isBuffer(file.bytes) ? file.bytes.toString('utf8') : String(file.bytes ?? '');
    const { data } = parseFrontmatter(text);
    if (typeof data.name !== 'string' || data.name.trim() === '') {
      problems.push(`${file.rel}：frontmatter 缺 name`);
    } else if (data.name.trim() !== name) {
      problems.push(`${file.rel}：frontmatter name「${data.name.trim()}」与目录名「${name}」不一致（宿主整包拒收）`);
    }
    if (typeof data.description !== 'string' || data.description.trim() === '') {
      problems.push(`${file.rel}：frontmatter 缺 description`);
    }
  }
  return problems;
}

/**
 * 生成清单。
 * @param {{plugin: string, meta: object, version: string, author: string, skills: string[], hooks: string[]}} input 输入
 * @returns {object} 清单对象
 */
export function buildManifest(input) {
  const doc = {
    schemaVersion: 1,
    name: input.plugin,
    displayName: input.meta.displayName,
    version: input.version,
    description: input.meta.description,
    author: input.author,
    icon: 'icon.png',
    darkIcon: 'icon-dark.png',
    category: CATEGORY,
    exampleQueries: [...input.meta.exampleQueries],
    apps: [],
    mcpServers: [],
    skills: [...input.skills].sort(),
  };
  if (input.hooks.length > 0) doc.hooks = [...input.hooks];
  return doc;
}

/**
 * 按宿主判据校验清单（复刻 `local-plugin-v1.md` 的必填/枚举/路径规则）。
 * @param {object} doc 清单对象
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateManifest(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['清单不是对象'];
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_KEYS.has(key)) problems.push(`清单含不被接受的键：${key}`);
  }
  for (const key of REQUIRED_KEYS) {
    if (doc[key] === undefined) problems.push(`清单缺必填键：${key}`);
  }
  if (doc.schemaVersion !== 1) problems.push('schemaVersion 必须为 1');
  if (!NAME_RE.test(String(doc.name ?? ''))) problems.push(`name 不合法：${String(doc.name ?? '')}`);
  if (!isSemVer(doc.version)) problems.push(`version 不是 SemVer：${String(doc.version ?? '')}`);
  if (typeof doc.description !== 'string' || doc.description.trim() === '') problems.push('description 缺失');
  if (typeof doc.author !== 'string' || doc.author.trim() === '') problems.push('author 缺失');
  if (!CATEGORIES.has(String(doc.category ?? ''))) problems.push(`category 不在枚举内：${String(doc.category ?? '')}`);
  if (!Array.isArray(doc.exampleQueries) || doc.exampleQueries.length === 0 || doc.exampleQueries.some((q) => typeof q !== 'string' || q.trim() === '')) {
    problems.push('exampleQueries 需至少一条非空字符串');
  }
  // 行为不变；理由随宿主契约更新（本地 App 能力不再被宿主忽略，见 内部未决-256 墓碑行）
  if (!Array.isArray(doc.apps) || doc.apps.length !== 0) problems.push('apps 必须为空数组（本层未实现 App 面；宿主支持 apps[]，接入时须校验 provider id 形态。历史登记见 open-items.md OPEN-256 墓碑行）');
  if (!Array.isArray(doc.mcpServers)) problems.push('mcpServers 必须是数组');
  if (!Array.isArray(doc.skills) || doc.skills.length === 0) problems.push('skills 必须是非空数组');
  else {
    for (const entry of doc.skills) {
      if (!isPortableRelPath(entry) || !/^skills\/[^/]+\/SKILL\.md$/.test(entry)) problems.push(`skill 路径形态非法：${String(entry)}`);
    }
    const names = doc.skills.map((entry) => entry.split('/')[1]);
    const lowered = names.map((name) => name.toLowerCase());
    if (new Set(lowered).size !== lowered.length) problems.push('skill 目录名存在大小写不敏感碰撞');
  }
  if (doc.darkIcon !== undefined && !isPortableRelPath(doc.darkIcon)) problems.push('darkIcon 路径非法');
  if (!isPortableRelPath(String(doc.icon ?? ''))) problems.push('icon 路径非法');
  if (doc.hooks !== undefined) {
    if (!Array.isArray(doc.hooks) || doc.hooks.length === 0) problems.push('hooks 必须是非空数组或省略');
    else for (const entry of doc.hooks) if (!isPortableRelPath(entry) || !entry.endsWith('.json')) problems.push(`hooks 路径非法：${String(entry)}`);
  }
  if (doc.$schema !== undefined && typeof doc.$schema !== 'string') problems.push('$schema 必须是字符串');
  return problems;
}
