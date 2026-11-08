// 文件：mcode-adapter/src/plugin-meta.mjs
// 描述：六插件在 MCode 侧的元数据与词表的**单一事实源**。清单字段、示例查询、图标色、
//       命令面处置决策、agent 工具名映射、ZCode→MCode 事件与 matcher 映射都收在这里；
//       其它模块只读本表，不内联字面量。命令面处置是**语义决策**（哪些薄指针命令由
//       同名 skill 直接覆盖、哪些必须物化成 skill），无法从资产机械推出，故显式登记，
//       并由 `tests/generate.test.mjs` 的命令面处置用例对真实命令文件逐条反查（表与资产必须一一
//       对应，漂移即红）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2/§3；决策见 内部规格

/** 套件六插件（MCode 侧保持 1:1 身份与可选安装粒度，内部决策-034 决策 2；algo-loop 2026-10-15 内部任务-90/内部决策-046、research-loop 2026-10-16 内部任务-109/内部决策-047 入套）。 */
export const PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);

/** 清单 `category` 枚举（宿主 V1 白名单，见 local-plugin-v1.md）。 */
export const CATEGORY = 'Code';

/**
 * 六插件在 MCode 侧的宿主事实元数据。
 * - `exampleQueries`：宿主要求至少一条非空白示例查询
 * - `hue`：图标底色（0..359），安装期据此生成确定性 PNG，不依赖内置素材
 *
 * 展示名与描述**不在本表**（内部任务-5 B，R-pc-14）：中立清单 `plugin.manifest.json` 的
 * `displayName`/`description` 是唯一人工编辑展示源，`cli.mjs` 的 planPackage 在装前把
 * 其合入清单 meta（无中立源时回落生成物描述与稳定 slug）——本层不维护第二份品牌表。
 */
export const PLUGIN_META = Object.freeze({
  workflow: {
    exampleQueries: ['用 workflow 元技能给我今天的任务选一条流程', '/workflow:tdd 按 TDD 实现这个修复'],
    hue: 210,
  },
  'spec-gate': {
    exampleQueries: ['跑一次聚合门禁并签发 gate receipt', '/spec-gate:spec-writing 写一条新的验收需求'],
    hue: 145,
  },
  scout: {
    exampleQueries: ['这个需求还在探索阶段，给我一个低纪律档位的流程', '/scout:scout 声明探路模式'],
    hue: 32,
  },
  'team-governance': {
    exampleQueries: ['接入团队 AI 治理并生成治理报告', '/team-governance:agent-eval 跑一次 replay 评测'],
    hue: 280,
  },
  'algo-loop': {
    exampleQueries: ['看看算法迭代环的最新台账与未闭环 bad case', '/algo-loop:algo-loop 按迭代环登记一轮实验'],
    hue: 340,
  },
  'research-loop': {
    exampleQueries: ['帮我把这个观察转成竞争解释并预注册判据', '/research-loop:experiment-design 设计一个消融实验（种子与运行序）'],
    hue: 25,
  },
});

/**
 * 命令面处置表（内部决策-034 决策 8）。
 * - `covered-by-skill`：薄指针命令，正文即被指向的 skill —— MCode 侧由该 skill 直接覆盖，
 *   不物化副本（避免第二份事实源）。`covers` 记被覆盖的 skill 名。
 * - `skill`：操作型命令（自带工具调用步骤或编排多步），物化为同名 skill。
 */
export const COMMAND_DISPOSITION = Object.freeze({
  workflow: {
    'feature-dev': { mode: 'skill' },
  },
  'spec-gate': {
    backfill: { mode: 'covered-by-skill', covers: 'spec-backfill' },
    evidence: { mode: 'skill' },
    gate: { mode: 'covered-by-skill', covers: 'gate' },
    init: { mode: 'skill' },
    spec: { mode: 'covered-by-skill', covers: 'spec-writing' },
  },
  scout: {},
  'team-governance': {
    eval: { mode: 'covered-by-skill', covers: 'agent-eval' },
    gate: { mode: 'skill' },
    init: { mode: 'skill' },
  },
  'algo-loop': {},
  'research-loop': {},
});

/** ZCode 工具名 → MCode 原生工具名（agent 面 `tools:` 前言用；`hook-lib.mjs` 的 TOOL_MAP 是负载面的逆向表）。 */
export const AGENT_TOOL_MAP = Object.freeze({
  Glob: 'glob',
  Grep: 'grep',
  LS: 'glob', // 本宿主无独立列举工具，目录列举归 glob（映射后去重）
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todowrite',
  Bash: 'bash',
});

/** agent 工具白名单里在本宿主无对位的项：按「拒绝」丢弃（丢弃不放宽权限——均为只读输出面）。 */
export const AGENT_TOOL_DROPPED = Object.freeze(['BashOutput']);

/** ZCode 钩子事件 → MCode 事件（`PostToolUseFailure` 无对位，合并到 `PostToolUse`）。 */
export const EVENT_MAP = Object.freeze({
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUse',
  Stop: 'Stop',
});

/** MCode 钩子面 11 个宿主事件（local-plugin-hooks.md；与 ZCode 的 EVENT_MAP 键集无关）。 */
export const MCODE_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'PostCompact',
]);

/** ZCode matcher 工具名 → MCode 原生名。 */
export const MATCHER_TOOL_MAP = Object.freeze({
  Bash: 'bash',
  Edit: 'edit',
  Write: 'write',
});

/**
 * 合并后 PostToolUse 的 matcher 取窄到 ZCode **成功通道**的三个工具。
 *
 * 取窄而非取全（all tools）的理由：ZCode 的 `PostToolUseFailure` 没有 matcher 是**宿主
 * 事件拆分的副作用**，不是设计出来的观测范围；而成功通道的 `Bash|Edit|Write` 才是
 * 脚本实际按之推进重试环的粒度。取全会把 `read`/`grep` 等只读工具也拉进来——每个工具
 * 调用多起一个 Node 进程，且重试环口径被静默改宽。故取窄，并把由此产生的观测缺口
 * 如实登记（内部接口-1 第三宿主登记「事件面缺口」）。
 */
export const MERGED_POST_TOOL_MATCHER = 'bash|edit|write';

/** SessionStart 的 source matcher：ZCode 词表之外补 `fork`（本宿主多一个来源，漏配即静默丢注入）。 */
export const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork';
