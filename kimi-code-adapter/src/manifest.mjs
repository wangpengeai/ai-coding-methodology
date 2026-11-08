// 文件：kimi-code-adapter/src/manifest.mjs
// 描述：Kimi 插件清单（`kimi.plugin.json`）的生成与**宿主判据复刻校验**（内部决策-038 决策 2/9）。
//       字段映射自中立清单 `plugin.manifest.json`（声明源唯一）：name=插件目录名（校验宿主正则
//       `[a-z0-9][a-z0-9_-]{0,63}`）、version=中立清单 version、description/keywords/interface
//       同名搬运；skills=["./skills/"]（有 skills 目录时）、commands=["./commands/"]（有时）、
//       hooks=[...翻译数组...]。agents 键**不落**（走宿主自动发现；--with-agents 只决定是否
//       物化 agents/ 目录）；mcpServers/systemPrompt/sessionStart.skill 本批不启用。
//       校验面（坏包拒绝物化）：清单可解析且键/值合规；skill 每份 frontmatter 必填
//       name+description；hooks 四字段白名单（见 hook-template）；commands 全部 .md 且路径
//       解析后在包根内；所有 `./` 路径包根内（.. 与反斜杠判拒——符号链接逃逸由宿主安全模型
//       兜住，本层不造符号链接）。Kimi 无文档化包体积/文件数上限 → 本层不设限（README 登记）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.1/§5（含本机实样三份清单核读）

/** 插件名合法形态（宿主逐字正则）。 */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 清单清单面键白名单（宿主支持字段；`$schema` 为字符串时允许——与实样形态一致）。 */
const ALLOWED_KEYS = new Set(['$schema', 'name', 'version', 'description', 'keywords', 'author', 'license', 'homepage', 'skills', 'agents', 'commands', 'hooks', 'mcpServers', 'interface', 'systemPrompt', 'systemPromptPath', 'sessionStart', 'skillInstructions']);

/**
 * SemVer 判据（实样版本均为 SemVer；只判三段数字 + 可选预发布/构建后缀）。
 * @param {unknown} value 版本串
 * @returns {boolean}
 */
export function isSemVer(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * 包内相对路径合规判据（无 `./` 前缀要求；供命令面等包内路径判据用）：
 * 不得含 `..`、反斜杠、空段或非法字符。
 * @param {string} value 相对路径
 * @returns {boolean}
 */
export function isPackageInternalRel(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\\') || value.startsWith('/')) return false;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed === '') return false;
  const segments = trimmed.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment));
}

/**
 * 清单 `./` 路径合规判据（宿主要求：符号链接解析后须在插件根内；本层生成期判拒
 * `..`、反斜杠与绝对形态——宿主文档形为 `./` 前缀路径，缺前缀即不合规）。
 * @param {unknown} value 路径
 * @returns {boolean}
 */
export function isInPackageRelPath(value) {
  if (typeof value !== 'string' || !value.startsWith('./')) return false;
  return isPackageInternalRel(value.slice(2));
}

/**
 * 生成清单（输入全部来自中立清单/计划内事实，不内联第二份元数据）。
 * 中立清单顶层 `displayName`（内部任务-5 B，R-ka-10：唯一人工编辑展示源）映射到宿主已证展示位
 * `interface.displayName`——显式 `interface.displayName` 搬运值在场时以其为先，其余
 * interface 字段同名搬运不变。
 * @param {{plugin: string, manifest: object, hasSkills: boolean, hasCommands: boolean, hooks: object[]}} input 输入
 * @returns {object} 清单对象
 */
export function buildManifest(input) {
  const source = input.manifest && typeof input.manifest === 'object' ? input.manifest : {};
  const doc = {
    name: input.plugin,
    version: String(source.version ?? ''),
    description: String(source.description ?? ''),
  };
  if (typeof source.author === 'string' && source.author.trim() !== '') doc.author = source.author;
  if (Array.isArray(source.keywords)) doc.keywords = [...source.keywords];
  if (source.interface && typeof source.interface === 'object' && !Array.isArray(source.interface)) {
    doc.interface = {};
    for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'websiteURL', 'iconUrl', 'category', 'hostKind', 'platforms', 'mcpOverrides']) {
      if (source.interface[key] !== undefined) doc.interface[key] = source.interface[key];
    }
  }
  // 展示单源：顶层 displayName → interface.displayName（包/市场同源；interface 段缺该键时补入）
  const display = typeof source.displayName === 'string' && source.displayName.trim() !== '' ? source.displayName : null;
  if (display !== null && (doc.interface?.displayName === undefined || String(doc.interface.displayName).trim() === '')) {
    (doc.interface ??= {}).displayName = display;
  }
  if (input.hasSkills) doc.skills = ['./skills/'];
  if (input.hasCommands) doc.commands = ['./commands/'];
  if (input.hooks.length > 0) doc.hooks = [...input.hooks];
  return doc;
}

/**
 * 按宿主判据校验清单（name 正则 / SemVer / description / 各 `./` 路径包根内）。
 * @param {object} doc 清单对象
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateManifest(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['清单不是对象'];
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_KEYS.has(key)) problems.push(`清单含不被接受的键：${key}`);
  }
  if (!NAME_RE.test(String(doc.name ?? ''))) problems.push(`name 不合法（须 ${NAME_RE}）：${String(doc.name ?? '')}`);
  if (!isSemVer(doc.version)) problems.push(`version 不是 SemVer：${String(doc.version ?? '')}`);
  if (typeof doc.description !== 'string' || doc.description.trim() === '') problems.push('description 缺失');
  for (const key of ['skills', 'commands']) {
    if (doc[key] === undefined) continue;
    if (!Array.isArray(doc[key])) {
      problems.push(`${key} 必须是数组`);
      continue;
    }
    for (const entry of doc[key]) {
      if (!isInPackageRelPath(entry)) problems.push(`${key} 路径须为包根内 ./ 相对路径：${String(entry)}`);
    }
  }
  if (doc.hooks !== undefined && !Array.isArray(doc.hooks)) problems.push('hooks 必须是数组');
  return problems;
}

/**
 * 极简 frontmatter 解析（只需标量 `key: value`；不支持的形态整体放弃，宁缺勿错析）。
 * @param {string} text 全文
 * @returns {{data: Record<string, string>, body: string}}
 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '').replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].trim();
  }
  return { data, body: match[2] };
}

/**
 * skill 文档面校验（宿主：目录形 SKILL.md frontmatter 必填 name + description，缺一解析失败）。
 * @param {{rel: string, bytes: Buffer}[]} skillFiles 包内 `skills/<名>/SKILL.md` 文件
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateSkillDocs(skillFiles) {
  const problems = [];
  for (const file of skillFiles) {
    const text = Buffer.isBuffer(file.bytes) ? file.bytes.toString('utf8') : String(file.bytes ?? '');
    const { data } = parseFrontmatter(text);
    if (typeof data.name !== 'string' || data.name.trim() === '') {
      problems.push(`${file.rel}：frontmatter 缺 name`);
    }
    if (typeof data.description !== 'string' || data.description.trim() === '') {
      problems.push(`${file.rel}：frontmatter 缺 description`);
    }
  }
  return problems;
}

/**
 * 命令面源文件判据：全部 .md（宿主递归收 `.md`；非 .md 混进 commands/ 即拒）。
 * @param {{rel: string}[]} commandFiles 包内 `commands/` 相对路径清单
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateCommandFiles(commandFiles) {
  const problems = [];
  for (const file of commandFiles) {
    if (!file.rel.endsWith('.md')) problems.push(`命令面含非 .md 文件：${file.rel}`);
    else if (!isPackageInternalRel(file.rel)) problems.push(`命令路径逃逸包根：${file.rel}`);
  }
  return problems;
}

/**
 * 包级判据汇总：清单 + skill 文档面 + 命令面 + hooks[]（翻译数组的宿主判据复刻校验
 * 在 hook-template.validateHookEntries，此处一并汇总，安装期单点读 problems）。
 * @param {{manifest: object, files: {rel: string, bytes: Buffer}[]}} input 清单与计划文件
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validatePackageCriteria(input) {
  const problems = [];
  problems.push(...validateManifest(input.manifest));
  problems.push(...validateSkillDocs(input.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.rel))));
  problems.push(...validateCommandFiles(input.files.filter((file) => file.rel.startsWith('commands/'))));
  return problems;
}
