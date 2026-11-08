// 文件：skills-bridge.mjs
// 描述：DSH 宿主适配第二面——把六插件既有的 `skills/<name>/SKILL.md` 注册进 DSH 的
//       skill 注册表（`ctx.skills.register`，见 `@deepseek-ai/dsh-skill` 的
//       `validateRuntimeSkill` 契约）。与钩子面同一条纪律（内部决策-032）：**只读** ZCode
//       资产，不复制、不改写、不生成 `.dsh/skills` 之类镜像目录。
//       为什么走运行时注册而不是文件系统根：DSH 的 `dsh-skill-filesystem` 只扫
//       `<projectRoot>/.dsh/skills`、`<projectRoot>/项目级技能`、`$DSH_HOME/skills`、
//       `$DSH_AGENTS_HOME/skills` 四个根，本仓的 `skills/` 不在其中；要落进这些根就得
//       复制全部 skill 正文（当前 32 份，漂移面）或建符号链接（Windows 需特权）。运行时注册把"哪里找"
//       留在本层，正文始终是磁盘上的那一份。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { logWarn } from './log.mjs';
import { getEngine } from './engine-binding.mjs';

/** DSH 的 skill 名形态（`@deepseek-ai/dsh-skill` 的 SKILL_NAME 同款：kebab-case）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 从插件名 + 技能目录名构造 DSH 侧 skill 名。
 * 为什么要加插件前缀：DSH 注册表在一个层内同名**先到先得**——后到者只记一条 warning 并
 * 拿到空 disposer，等于静默失效，而这是纪律入口，不能静默。ZCode 侧的命名空间由
 * `/spec-gate:gate` 这类命令面承担，DSH 侧的对应物就是这个 kebab 前缀；前缀让来源在
 * 名字里可见，并消除跨插件同名（如 `spec-gate/skills/gate` 与 `workflow/skills/gate`
 * 并存时后者的静默被吞）与拼写变体撞名（`agent_eval` 目录 vs `agent-eval`）两类隐式冲突。
 * 前缀为下划线/点的插件名（非本仓形态）按连字符归一后再判定。
 * @param {string} plugin 插件名（`workflow` / `spec-gate` / …）
 * @param {string} dirName 技能目录名
 * @returns {string} DSH skill 名；形态非法时返回空串（调用方丢弃该技能）
 */
export function skillNameOf(plugin, dirName) {
  // 引擎驱动（内部决策-037 批 2 步骤 7a）：前缀/分隔符/撞名策略在 `namespace-transform` 的 `params.dsh`；
  // 漂移即具名抛错（不静默命名——错名会让技能被静默吞掉或撞名）。
  const outcome = getEngine().applyRule('namespace-transform', 'dsh', { plugin, dirName });
  if (outcome.applied !== true) {
    throw new Error('skills-bridge: 规则库字段契约漂移（namespace-transform 缺 params.dsh）——拒载而非静默命名');
  }
  return outcome.result;
}

/**
 * 解析 `SKILL.md` 的一段 frontmatter（YAML-lite，刻意不引第三方 YAML）。
 * 支持的形态就是本仓全部 skill 正文实际使用的形态：`key: value` 标量、布尔字面量、
 * 以及 `metadata:` 下的两层嵌套 map。**不支持**块标量（`|`/`>`）与流式集合——遇到
 * 块标量即视为不识别并整体放弃该字段（宁缺勿错析：错析出半个值比缺字段更坏）。
 * @param {string} text 文件全文
 * @returns {{fields: Record<string, unknown>, body: string, ok: boolean, reason?: string}}
 */
export function parseFrontmatter(text) {
  const src = typeof text === 'string' ? text : '';
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { fields: {}, body: src, ok: false, reason: '缺少 frontmatter 定界符' };
  const body = src.slice(m[0].length);
  /** @type {Record<string, unknown>} */
  const fields = {};
  let currentMap = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const indentMatch = /^(\s*)(.*)$/.exec(rawLine);
    const indent = indentMatch[1].length;
    const line = indentMatch[2];
    if (line.startsWith('#')) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      // S-02（内部未决-245）：原「缩进 + currentMap 非空 ⇒ 再按同一正则试 nested」分支不可达
      // （该正则与上面 kv 逐字相同、输入同为 line，!kv 时 nested 恒不命中），已删除；
      // 判定与 reason 文案不变。缩进型嵌套 map 由上方 kv 分支与下方 `else if (currentMap !== null)` 承接。
      return { fields: {}, body, ok: false, reason: `frontmatter 行无法解析：${line.slice(0, 40)}` };
    }
    const key = kv[1];
    const rest = kv[2].trim();
    if (indent === 0) {
      currentMap = null;
      if (rest === '') {
        // 空值 + 后续缩进行 = 嵌套 map；本仓只用于 `metadata:`
        currentMap = {};
        fields[key] = currentMap;
        continue;
      }
      const value = scalarOf(rest);
      if (value === undefined) return { fields: {}, body, ok: false, reason: `字段 ${key} 的取值形态不支持（块标量/流式集合）` };
      fields[key] = value;
    } else if (currentMap !== null) {
      const value = scalarOf(rest);
      if (value === undefined) return { fields: {}, body, ok: false, reason: `嵌套字段 ${key} 的取值形态不支持` };
      currentMap[key] = value;
    } else {
      return { fields: {}, body, ok: false, reason: `缩进行缺少父级键：${line.slice(0, 40)}` };
    }
    // 注：此处原有一条"字段值为 `|`/`>` 即块标量，拒绝"的守卫，2026-09-28 第 85 批经
    // 覆盖率审计 + 逐调用点核对后**删除**——它不可达：三条赋值路径的值都出自 `scalarOf()`，
    // 而 `scalarOf` 对 `|`/`>` 开头**一律返回 undefined**，于是调用点先一步以
    // 「取值形态不支持（块标量/流式集合）」返回。留着只会让覆盖率永远缺一块、并让读者
    // 以为这里还有一条独立防线。块标量的拒绝语义**未变**，只是唯一出处落在 `scalarOf`。
  }
  return { fields, body, ok: true };
}

/**
 * 标量取值：去引号；块标量标记返回 undefined（调用方按不支持处置）；流式集合按保守
 * 启发式处置。
 * 为什么流式集合不能一刀切拒绝：本仓 `argument-hint` 的真实形态外层就带方括号
 * （`[特性描述]`、`[--task-id TASK-n] [--plan …]`）——那是占位符书写习惯，不是 YAML
 * 流式序列。只把「带顶层分隔符的括号串」（`[a, b]` / `{k: v}`）判为流式集合并拒绝，
 * 单元素无分隔符的括号串按普通标量读（YAML 允许裸标量以 `[` 开头）。
 * @param {string} raw
 * @returns {string|undefined}
 */
function scalarOf(raw) {
  const s = String(raw).trim();
  if (s.startsWith('|') || s.startsWith('>')) return undefined;
  if (hasTopLevelFlowSeparator(s)) return undefined;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 是否形如流式集合：整串恰以 `[`/`{` 开头、以对应闭合符结尾，且顶层（深度 1、引号外）
 * 出现 `,` 或 `:`。判据只需"这看起来是集合语法"——按不支持处置的代价只是丢一个字段，
 * 而误判成普通标量的代价是把集合文本当字符串用。
 * @param {string} s
 * @returns {boolean}
 */
function hasTopLevelFlowSeparator(s) {
  const open = s[0];
  if (open !== '[' && open !== '{') return false;
  const close = open === '[' ? ']' : '}';
  if (!s.endsWith(close)) return false;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return false; // 顶层闭合于串尾：内层无分隔符 → 当普通标量读
      continue;
    }
    if (depth === 1 && (ch === ',' || ch === ':')) return true;
  }
  return false;
}

/** YAML 布尔字面量（大小写不敏感，含 yes/no/on/off/1/0——与宿主 filesystem 提供方同表）。 */
const TRUE_LITERALS = new Set(['true', 'yes', 'on', '1']);
const FALSE_LITERALS = new Set(['false', 'no', 'off', '0']);

/**
 * 取布尔字段。缺失返回 undefined；形态不合法返回 null（调用方据此丢弃该技能——
 * 与宿主 filesystem 提供方「被拒绝的拼写让整个 skill 随警告丢弃」同姿态）。
 * @param {unknown} value
 * @returns {boolean|null|undefined}
 */
export function booleanField(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (TRUE_LITERALS.has(s)) return true;
    if (FALSE_LITERALS.has(s)) return false;
  }
  return null;
}

/**
 * 扫描插件根下一个资产子目录并返回排序后的条目名（S-09/内部未决-245：skills/commands/agents 三面共用）。
 * 三面原实现逐字同构——目录不可读＝该面为空（fail-open，`[]`）；逐条目 `statSync` 失败（扫描期被删/
 * 权限不足）只跳过该条；`ext` 小写比较（保留 `.MD` 语义与「名为 `.md` 的 dotfile 不被匹配」的
 * `extname` 语义）；末尾默认 `sort()` 保证注册/派发顺序确定。不递归、不写、不缓存。
 * **为什么挂在本模块**：skills-bridge 是三面唯一共同依赖（agents-bridge/commands-bridge 都已从本模块
 * import `parseFrontmatter`/`skillNameOf`）；若挂 agents-bridge，skills-bridge 反向 import 会形成
 * `agents→skills→agents` 循环依赖，故本助手落此处（计划「设计面核验」第 1 条）。
 * @param {string} rootDir 插件根目录
 * @param {string} subdir 资产子目录名（'skills'|'commands'|'agents'）
 * @param {{kind?: 'file'|'directory', ext?: string}} [options] kind 缺省 file（isFile 判定）；ext 形如 '.md'（小写比较）
 * @returns {string[]} 条目名（字典序）
 */
export function listEntriesIn(rootDir, subdir, options = {}) {
  const pickDir = options.kind === 'directory';
  const ext = typeof options.ext === 'string' ? options.ext.toLowerCase() : null;
  let entries;
  try {
    entries = readdirSync(join(rootDir, subdir));
  } catch {
    // 目录不存在/不可读 = 该面为空：不是错误，按空集合继续（fail-open；三面原语义）。
    return [];
  }
  return entries
    .filter((name) => (ext === null ? true : extname(name).toLowerCase() === ext))
    .filter((name) => {
      try {
        const st = statSync(join(rootDir, subdir, name));
        return pickDir ? st.isDirectory() : st.isFile();
      } catch {
        // 条目扫描期被删（竞态）或权限不足：跳过这一条，不让整次收集失败。
        return false;
      }
    })
    .sort();
}

/**
 * 扫描一个插件的 skill 目录（S-09 后是 `listEntriesIn` 的具名薄包装；导出名/返回值不变）。
 * @param {string} pluginRoot 插件根
 * @returns {string[]} 技能目录名（排序后，保证注册顺序确定）
 */
export function skillDirNames(pluginRoot) {
  return listEntriesIn(pluginRoot, 'skills', { kind: 'directory' });
}

/**
 * 读一条 skill 并翻译为 DSH 注册输入。
 * 字段映射：`name` → 插件前缀 + 目录名；`description` 原样（ZCode 的
 * 「一句话功能 —— 触发条件：…」本身已是可路由描述）；`whenToUse` 有则透传；
 * `disable-model-invocation` / `user-invocable` → `invocation` 策略；`license` 与
 * `metadata` 之外的键不透传（DSH 运行时条目没有自定义字段位）。
 * 丢弃条件（任一命中即返回 null，并给具名 reason）：frontmatter 不可解析、
 * 缺 `description`、`invocation` 布尔形态非法、`disable-model-invocation: true`、
 * `user-invocable: false`、skill 名形态非法、正文为空。
 * @param {string} plugin 插件名
 * @param {string} pluginRoot 插件根
 * @param {string} dirName 技能目录名
 * @returns {{skill: object, path: string}|{skip: string, path: string}}
 */
export function loadSkill(plugin, pluginRoot, dirName) {
  const file = join(pluginRoot, 'skills', dirName, 'SKILL.md');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // 保留真实原因（EACCES/ENOENT/编码错各不相同）——只写「不可读」会让排查
    // 无从下手，属 skill 反模式清单的「错误信息黑洞」。
    return { skip: `SKILL.md 不可读（${error instanceof Error ? error.message : String(error)}）`, path: file };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { skip: `frontmatter 不可解析（${parsed.reason}）`, path: file };
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : '';
  if (description === '') return { skip: '缺少 description', path: file };
  const modelInvocable = booleanField(parsed.fields['disable-model-invocation']);
  if (modelInvocable === null) return { skip: 'disable-model-invocation 取值非布尔', path: file };
  const userInvocable = booleanField(parsed.fields['user-invocable']);
  if (userInvocable === null) return { skip: 'user-invocable 取值非布尔', path: file };
  if (modelInvocable === true) return { skip: '声明 disable-model-invocation（对模型不可调用）', path: file };
  if (userInvocable === false) return { skip: '声明 user-invocable: false', path: file };
  const name = skillNameOf(plugin, dirName);
  if (name === '') return { skip: `skill 名形态非法（${plugin}/${dirName}）`, path: file };
  if (parsed.body.trim() === '') return { skip: '正文为空', path: file };
  const whenToUse = typeof parsed.fields.whenToUse === 'string' ? parsed.fields.whenToUse.trim() : undefined;
  return {
    path: file,
    skill: {
      name,
      description,
      ...(whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
      // 只读注册：正文即磁盘内容，加载时不重读（宿主对 runtime 条目按 locator 直接返回）
      content: parsed.body,
      source: `ai-coding-methodology:${plugin}`,
      path: file,
      invocation: { modelInvocable: true, userInvocable: true },
    },
  };
}

/**
 * 收集四个插件下全部可注册 skill。
 * @param {Record<string, string>} roots 插件名 → 插件根
 * @returns {{skills: object[], skipped: {plugin: string, dir: string, reason: string}[], counts: Record<string, number>}}
 */
export function collectSkills(roots) {
  const skills = [];
  const skipped = [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [plugin, root] of Object.entries(roots)) {
    if (typeof root !== 'string' || root === '') continue;
    let n = 0;
    for (const dir of skillDirNames(root)) {
      const loaded = loadSkill(plugin, root, dir);
      if (loaded.skip !== undefined) {
        skipped.push({ plugin, dir, reason: loaded.skip });
        continue;
      }
      skills.push(loaded.skill);
      n += 1;
    }
    counts[plugin] = n;
  }
  return { skills, skipped, counts };
}

/**
 * 把收集到的 skill 注册进宿主注册表。
 * 注册失败逐条隔离：单条形态非法（宿主 `validateRuntimeSkill` 抛错）不得带走其余技能，
 * 也不得让适配层整体失败（fail-open，与钩子面同姿态）。
 * **服务经参数传入**，不从 ctx 属性读：cordis 源码里 `ctx.<service>` 属性访问在
 * `inject` 未声明该服务时抛 `cannot get property "X" without inject`
 * （`cordis/src/reflect.ts` 的 ReflectService handler）——本插件的 `inject` 只声明 `shell`，
 * 故任何 `ctx.skills` / `ctx.commands` 属性读都会在真实宿主上炸。取服务一律走
 * `ctx.get(name)`（cordis 源码原话：`Read a service from the store without the inject
 * requirement`，服务缺席时返回 undefined 而非抛错）。
 * @param {{register: Function}|undefined} skillsService 宿主的 skill 注册表
 * @param {object[]} skills
 * @param {{warn?: Function}} [logger]
 * @returns {{registered: number, failed: {name: string, error: string}[], disposers: Function[]}}
 */
export function registerSkills(skillsService, skills, logger) {
  const failed = [];
  const disposers = [];
  let registered = 0;
  for (const skill of skills) {
    try {
      // 内部任务-273 M-05：宿主注册返回的 disposer 必须保留（装配层经 ctx.effect 回收）——
      // 旧实现丢弃返回值，重载后旧条目先到先得压新正文、apply 失败时半注册无回收。
      const disposer = skillsService.register(skill);
      if (typeof disposer === 'function') disposers.push(disposer);
      registered += 1;
    } catch (error) {
      failed.push({ name: skill.name, error: error instanceof Error ? error.message : String(error) });
      logWarn(logger, `ai-coding-methodology: skill ${skill.name} 注册被拒（${String(error)}）`);
    }
  }
  return { registered, failed, disposers };
}
