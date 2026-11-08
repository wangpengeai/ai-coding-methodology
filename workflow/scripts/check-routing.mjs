// 文件：check-routing.mjs
// 描述：路由一致性 lint（内部规则-6，内部验收-2 的锁定方式=自动化 lint）——三项独立检查：
//       a) 必需 skill 目录存在（支持 ROUTING_EXPECT 增量模式，批次 2-4 期间部分通过）；
//       b) 各 SKILL.md frontmatter 规范（可解析 / name 与目录一致 / description ≥30 字符
//          且含「触发条件」锚点——内部验收-2：宿主靠 description 判定加载，触发条件必须写入）；
//       c) workflow 元技能路由表与实际 skill 集合双向对照（引用必存在、入口必入表；
//          含跨插件引用 spike-run/disposable-build 的 scout/skills 解析，内部决策-006 第 11 行）；
//          2026-09-15 激活域批次（内部决策-022）增两环漂移守卫：期望入口⊆路由表入口资产
//          routing-skills.mjs（rule=entry-asset-incomplete）、资产⊆路由表解析 refs
//          （rule=routing-entry-missing）——运行时声明成员校验的数据源与表不许漂移；
//          2026-09-17 使用反馈二批增 e 环：路由表行号引用核验（rule=line-ref-drift）——
//          各插件文档「第 N 行」引用按期望集比对当前表实算行号，漂移即报文件+行号。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 用法：node workflow/scripts/check-routing.mjs [skillsRoot]（缺省=脚本位置上溯，不受 cwd 影响）
//       ROUTING_EXPECT=skill1,skill2,…（逗号分隔，缺省=全部 20 个必需 skill）
// 退出码：0=一致；1=存在违例。JSON 报告输出到 stdout（checked/violations）。
// 说明：lint 是检查器，发现违例必须非 0 退出——不适用 fail-open。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTING_ENTRY_SKILLS } from './lib/routing-skills.mjs';
import { SKILL_NAME_RE } from '../hooks/routing-lib.mjs'; // 内部任务-244 Q10：形态正则单源（原本地同值双写）

/**
 * 20 个必需 skill 清单（内部模块-1 规格的 canonical 清单；场景新增/变更时同步维护本表，
 * 这是 内部规则-6 一致性校验的基准）。
 * @type {string[]}
 */
const REQUIRED_SKILLS = [
  'workflow',
  'idea-review',
  'brainstorming',
  'plan-writing',
  'plan-review',
  'plan-execution',
  'code-discipline',
  'doc-discipline',
  'tdd',
  'root-cause-debugging',
  'code-review',
  'production-change',
  'verification',
  'branch-finishing',
  'retro',
  'learnings',
  'health',
  'architecture-evolve',
  'external-radar',
  'writing-skills',
];

/**
 * 表外 skill：不参与"必须出现在路由表"方向。
 * 为什么含 workflow 自身：它是路由表宿主（判定者，不是路由目标），SKILL.md 的
 * "表外 skill"节只点名 code-discipline/tdd/writing-skills，但若把 workflow 也要求
 * 入表，路由表永远无法自洽（自己路由到自己）——故按语义豁免元技能。
 * @type {Set<string>}
 */
const NON_ENTRY_SKILLS = new Set(['workflow', 'code-discipline', 'doc-discipline', 'tdd', 'writing-skills']);

/**
 * 跨插件路由引用：scout 三行（内部决策-008）+ team-governance 治理行（内部决策-012，第 9 行）
 * + algo-loop 算法迭代行（内部决策-046，第 13 行）+ research-loop 研究环两行（内部决策-047，第 14/15 行）。
 * 解析方式：从 skillsRoot 上溯两级到仓库根，再进 <插件>/skills/<ref>。
 * 可选插件语义（内部规则-5）：team-governance/algo-loop/research-loop 是可选安装——目录存在时校验，
 * 缺失时不报结构错（路由表允许指向未安装的可选插件，运行时给安装指引）。
 * 为什么用白名单而不是任意相对路径：路由表是公开契约，跨插件引用必须逐名登记。
 * @type {Record<string, {plugin: string, optional: boolean}>}
 */
const EXTERNAL_SKILLS = {
  scout: { plugin: 'scout', optional: false },
  'spike-run': { plugin: 'scout', optional: false },
  'disposable-build': { plugin: 'scout', optional: false },
  'team-governance': { plugin: 'team-governance', optional: true },
  'algo-loop': { plugin: 'algo-loop', optional: true },
  'research-hypothesis': { plugin: 'research-loop', optional: true },
  'experiment-design': { plugin: 'research-loop', optional: true },
};
/** Scout 族行（内部规则-9）：每行必须单目标，explore/disposable 条件必须分行互斥 */
const SCOUT_ROW_SKILLS = new Set(['scout', 'spike-run', 'disposable-build']);
// （内部任务-57/内部未决-127 处置）原 OPTIONAL_ROW_SKILLS 死声明已删——注释自述的「正文须含安装
// 指引语义」机检从未实现（全仓零消费点），行为语义由 内部规则-5 规格＋走查验收承载。

/** description 统一格式锚点（内部规则-2：触发条件必须写进 description） */
const TRIGGER_ANCHOR = '触发条件';
/** description 最短长度（字符数，按 JS length 计，中英文均 1 字符/码元） */
const MIN_DESCRIPTION_LENGTH = 30;
/** skill 名合法形态（小写字母/数字/连字符） */
/**
 * 解析期望存在的 skill 清单：ROUTING_EXPECT 环境变量（逗号分隔）或缺省全部 20 个。
 * 为什么有增量模式：批次 2-4 交付期间只有部分 skill 落盘，缺省全量会让每次中间
 * 验收都红；gate 最终跑时用全量模式收口。
 * @returns {string[]} 期望存在的 skill 名列表
 */
function expectedSkills() {
  const raw = process.env.ROUTING_EXPECT;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...REQUIRED_SKILLS];
}

/**
 * 解析 SKILL.md 的 frontmatter（仅取 name/description 两键，YAML 子集）。
 * 为什么不引 YAML 库：内部非功能需求-1 零第三方依赖，frontmatter 实际只用这两个标量键。
 * @param {string} text SKILL.md 全文
 * @returns {{ ok: boolean, name?: string, description?: string, error?: string }}
 */
function parseFrontmatter(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!lines[0] || lines[0].trim() !== '---') {
    return { ok: false, error: '文件不以 frontmatter 起始 --- 开头' };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { ok: false, error: 'frontmatter 未闭合（缺少第二个 ---）' };
  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/); // 只按第一个冒号切分：description 值内含中文冒号
    if (m) kv[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!kv.name) return { ok: false, error: 'frontmatter 缺 name 键' };
  return { ok: true, name: kv.name, description: kv.description ?? '' };
}

/**
 * 路由表行迭代器（2026-09-17 评审处置抽取）：「## 路由表」节定位 + 表头/分隔行跳过 +
 * 数据行编号（从 1 数），parseRoutingRefs/checkScoutRows/checkLineRefs 三消费方共用
 * ——此前三者各持一份同构遍历骨架（第三份拷贝由本抽取消除）。
 * @param {string} text workflow SKILL.md 全文
 * @returns {Array<{rowNo: number, cells: string[]}>} 数据行（cells=去空首尾的单元格数组）
 */
function routingTableRows(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let inRouting = false;
  let headerSkipped = false;
  /** @type {Array<{rowNo: number, cells: string[]}>} */
  const rows = [];
  let rowNo = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inRouting = /路由表/.test(line); // 进入/离开"## 路由表"节（红旗表等其他表格不混入）
      headerSkipped = false;
      continue;
    }
    if (!inRouting || !line.trim().startsWith('|')) continue;
    if (!headerSkipped) {
      headerSkipped = true; // 表头行（「用户状态 | 路由到 | 显式触发条件」）不是数据行
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells.slice(1, -1).every((c) => /^:?-{3,}:?$/.test(c))) continue; // 分隔行
    rowNo += 1;
    rows.push({ rowNo, cells });
  }
  return rows;
}

/**
 * 从 workflow/SKILL.md 全文提取路由表"路由到"列引用的 skill 名（去重、排序）。
 * 解析范围限定在"## 路由表"节内——为什么：同文档还有红旗表等多个表格，全部解析会
 * 把反驳话术里的词误当路由目标（节定位由 routingTableRows 统一承载）。
 * "路由到"列的两种复合形态都要拆开：`verification` → `code-review`（→ 分隔）、
 * `retro`/`health`/`learnings`（/ 分隔）；反引号内优先，无反引号的裸词也兜底识别。
 * @param {string} text workflow SKILL.md 全文
 * @returns {string[]} 引用的 skill 名列表（字典序去重）
 */
function parseRoutingRefs(text) {
  const refs = new Set();
  for (const { cells } of routingTableRows(text)) {
    const routeCell = cells[2]; // 第 2 列 = "路由到"
    // 反引号内的名字（当前表格的标准形态）
    for (const bt of routeCell.match(/`([^`]+)`/g) ?? []) {
      const name = bt.slice(1, -1).trim();
      if (SKILL_NAME_RE.test(name)) refs.add(name);
    }
    // 无反引号兜底：按 → / 、 逗号 空白 拆词，仍须长得像 skill 名
    const rest = routeCell.replace(/`[^`]+`/g, ' ');
    for (const tok of rest.split(/[→/、,，\s]+/)) {
      if (SKILL_NAME_RE.test(tok) && tok.length >= 2) refs.add(tok);
    }
  }
  return [...refs].sort();
}

/**
 * 检查 a：期望清单内每个 skill 的目录必须存在。
 * @param {string} skillsRoot skills 根目录
 * @param {string[]} expected 期望清单
 * @param {Array<{rule: string, file: string, message: string}>} violations 违例累积
 * @returns {Set<string>} 目录存在的 skill 名集合
 */
function checkDirectories(skillsRoot, expected, violations) {
  const present = new Set();
  for (const name of expected) {
    const dir = join(skillsRoot, name);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      present.add(name);
      continue;
    }
    violations.push({
      rule: 'missing-skill',
      file: dir,
      message: `必需 skill 目录缺失：${name}（期望清单见 checked.expected）`,
    });
  }
  return present;
}

/**
 * 检查 b：存在的 skill 逐一校验 SKILL.md frontmatter。
 * @param {string} skillsRoot skills 根目录
 * @param {Set<string>} present 目录存在的 skill 名集合
 * @param {Array<{rule: string, file: string, message: string}>} violations 违例累积
 * @returns {Set<string>} frontmatter 全部通过的 skill 名集合（供检查 c 双向对照）
 */
function checkFrontmatter(skillsRoot, present, violations) {
  const passed = new Set();
  for (const name of present) {
    const file = join(skillsRoot, name, 'SKILL.md');
    if (!existsSync(file)) {
      violations.push({ rule: 'skill-file-missing', file, message: `skill 目录存在但缺 SKILL.md：${name}` });
      continue;
    }
    const fm = parseFrontmatter(readFileSync(file, 'utf8'));
    if (!fm.ok) {
      violations.push({ rule: 'frontmatter-invalid', file, message: `frontmatter 不可解析：${fm.error}` });
      continue;
    }
    let ok = true;
    if (fm.name !== name) {
      violations.push({
        rule: 'name-mismatch',
        file,
        message: `frontmatter name「${fm.name}」与目录名「${name}」不一致`,
      });
      ok = false;
    }
    const desc = fm.description ?? '';
    if (desc.length === 0) {
      violations.push({ rule: 'description-empty', file, message: `description 为空：${name}` });
      ok = false;
    } else if (desc.length < MIN_DESCRIPTION_LENGTH) {
      violations.push({
        rule: 'description-length',
        file,
        message: `description 长度 ${desc.length} < ${MIN_DESCRIPTION_LENGTH}：${name}`,
      });
      ok = false;
    }
    if (!desc.includes(TRIGGER_ANCHOR)) {
      violations.push({
        rule: 'description-trigger',
        file,
        message: `description 缺「${TRIGGER_ANCHOR}」锚点（R-M1-2：触发条件必须写进 description）：${name}`,
      });
      ok = false;
    }
    if (ok) passed.add(name);
  }
  return passed;
}

/**
 * 检查 c：路由表与实际 skill 集合双向对照。
 * 方向 1（引用必存在）：路由表"路由到"列引用的 skill 必须有目录——增量模式下
 *   期望清单之外的引用视为未来批次而容忍（否则批次 2 期间路由表永远红）；
 *   全量模式下所有引用必须存在。
 * 方向 2（入口必入表）：期望清单内、磁盘上通过 frontmatter 检查的场景入口 skill
 *   （20 清单减去表外 skill 与元技能自身）必须出现在路由表。
 * @param {string} skillsRoot skills 根目录
 * @param {string[]} expected 期望清单
 * @param {Set<string>} passed frontmatter 通过的 skill 名集合
 * @param {Array<{rule: string, file: string, message: string}>} violations 违例累积
 * @returns {string[]} 路由表引用的 skill 名（排序去重），供报告 checked.routingRefs
 */
function checkRoutingTable(skillsRoot, expected, passed, violations, metaText) {
  const incremental = Boolean(process.env.ROUTING_EXPECT && process.env.ROUTING_EXPECT.trim());
  const universe = new Set(expected);
  const metaFile = join(skillsRoot, 'workflow', 'SKILL.md');
  if (!existsSync(metaFile)) {
    violations.push({
      rule: 'meta-skill-missing',
      file: metaFile,
      message: 'workflow 元技能 SKILL.md 不存在，路由表无从解析',
    });
    return { refs: [], externalRefs: [] };
  }
  const refs = parseRoutingRefs(metaText);

  /**
   * 跨插件引用存在性判定：命中白名单且在对应插件 skills 下有目录即真；
   * 可选插件缺失是合法形态（返回 'optional-missing'，调用方不报结构错）。
   * @param {string} root skills 根目录
   * @param {string} ref 路由表引用的 skill 名
   * @returns {boolean|'optional-missing'}
   */
  function externalRefInstalled(root, ref) {
    const entry = EXTERNAL_SKILLS[ref];
    if (!entry) return false;
    const dir = join(resolve(root, '..', '..'), entry.plugin, 'skills', ref);
    if (existsSync(dir) && statSync(dir).isDirectory()) return true;
    return entry.optional ? 'optional-missing' : false;
  }

  // 方向 1：引用必存在（本插件目录优先，其次跨插件白名单映射，均按磁盘实际存在判定）
  const externalRefs = [];
  for (const ref of refs) {
    const local = join(skillsRoot, ref);
    if (existsSync(local) && statSync(local).isDirectory()) continue;
    const external = externalRefInstalled(skillsRoot, ref);
    if (external === true) {
      externalRefs.push(ref);
      continue;
    }
    if (external === 'optional-missing') {
      externalRefs.push(`${ref}(optional-missing)`);
      continue; // 可选插件未安装：合法，运行时给安装指引（内部规则-5）
    }
    if (incremental && !universe.has(ref)) continue; // 未来批次引用，容忍
    violations.push({
      rule: 'missing-skill',
      file: metaFile,
      message: `路由表引用的 skill 不存在：${ref}（本插件与跨插件白名单映射均已检查）`,
    });
  }

  // 方向 2：入口必入表
  for (const name of expected) {
    if (NON_ENTRY_SKILLS.has(name)) continue;
    if (!passed.has(name)) continue; // 未落盘/未通过 frontmatter 的不做此方向要求
    if (!refs.includes(name)) {
      violations.push({
        rule: 'unrouted-skill',
        file: metaFile,
        message: `场景入口 skill 未出现在路由表"路由到"列：${name}`,
      });
    }
  }

  // 方向 2a（2026-09-15 激活域批次，内部决策-022）：期望入口 ⊆ 路由表入口资产——
  // routing-declare 按 routing-skills.mjs 做声明成员校验，资产漏收新入口会把合法
  // 入口误拒（lint 是这对漂移的提前暴露面）。expected 缺省即 REQUIRED 全集。
  for (const name of expected) {
    if (NON_ENTRY_SKILLS.has(name)) continue;
    if (!passed.has(name)) continue;
    if (!ROUTING_ENTRY_SKILLS.has(name)) {
      violations.push({
        rule: 'entry-asset-incomplete',
        file: metaFile,
        message: `路由表入口资产（routing-skills.mjs）未收录期望入口：${name}——运行时声明成员校验会误拒`,
      });
    }
  }

  // 方向 2b：资产 ⊆ 路由表解析 refs——表行被删而资产残留时，声明会放行不存在的
  // 入口（B-M1-3 表-技能一致性的资产侧镜像）。仅全量模式执行：增量模式容忍残缺表
  // （与方向 1 的未来批次容忍同 rationale）；必需入口的表存在性由方向 2 覆盖，
  // 本环的独特价值在跨插件入口（scout 族/team-governance 不在 REQUIRED 清单）。
  if (!incremental) {
    for (const name of ROUTING_ENTRY_SKILLS) {
      if (!refs.includes(name)) {
        violations.push({
          rule: 'routing-entry-missing',
          file: metaFile,
          message: `路由表入口资产收录但路由表"路由到"列已不存在：${name}（资产与表漂移）`,
        });
      }
    }
  }
  return { refs, externalRefs };
}

/**
 * 检查 d（内部规则-9，内部决策-008）：Scout 三行单目标与条件互斥。
 * - 含 Scout 族目标的行，「路由到」列必须只有一个目标（一行双目标即判定歧义）；
 * - spike-run 行条件必须含 mode=explore、disposable-build 行必须含 mode=disposable，
 *   两行条件必须互斥（同一状态不得同时命中两个兜底行）。
 * @param {string} skillsRoot skills 根目录
 * @param {Array<{rule: string, file: string, message: string}>} violations 违例累积
 * @returns {void}
 */
function checkScoutRows(skillsRoot, violations, metaText) {
  const metaFile = join(skillsRoot, 'workflow', 'SKILL.md');
  if (!existsSync(metaFile)) return; // 元技能缺失已由检查 c 报告
  /** @type {Array<{row: string, targets: string[], cond: string}>} */
  const scoutRows = [];
  for (const { cells } of routingTableRows(metaText)) {
    const routeCell = cells[2];
    const targets = [...routeCell.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
    if (!targets.some((t) => SCOUT_ROW_SKILLS.has(t))) continue;
    scoutRows.push({ row: cells[1], targets, cond: cells[3] });
    if (targets.length > 1) {
      violations.push({
        rule: 'scout-row-multi-target',
        file: metaFile,
        message: `Scout 行必须单目标（R-M1-9/ADR-008）：「${cells[1]}」路由到 ${targets.join(' / ')}`,
      });
    }
  }
  const exploreRow = scoutRows.find((r) => r.targets.includes('spike-run'));
  const disposableRow = scoutRows.find((r) => r.targets.includes('disposable-build'));
  const lifecycleRow = scoutRows.find((r) => r.targets.includes('scout'));
  if (!lifecycleRow) {
    violations.push({ rule: 'scout-row-missing', file: metaFile, message: '路由表缺 Scout 生命周期管理行（→ scout）' });
  }
  if (!exploreRow || !disposableRow) {
    violations.push({ rule: 'scout-row-missing', file: metaFile, message: '路由表缺 explore/disposable 兜底行（ADR-008 拆行）' });
  } else {
    if (!/mode\s*=\s*explore/.test(exploreRow.cond)) {
      violations.push({ rule: 'scout-row-condition', file: metaFile, message: 'spike-run 行条件必须含 mode=explore' });
    }
    if (!/mode\s*=\s*disposable/.test(disposableRow.cond)) {
      violations.push({ rule: 'scout-row-condition', file: metaFile, message: 'disposable-build 行条件必须含 mode=disposable' });
    }
  }
}

/**
 * 检查 e（2026-09-17 使用反馈二批，内部规则-14）：路由表行号引用核验。
 * 背景：scout 文档「第 11 行」漂移（内部决策-009/012 各插一行后编号 +2 而正文未跟上）漏网
 * ——a-d 环均不校验文档行号引用。做法：期望集逐条登记（文件+目标 skill+抓取正则），
 * 期望行号由当前路由表实算（rowOf(target)），文件内每处「第 N 行」声明值与实算比对，
 * 不符即 line-ref-drift 并指名文件与行号。未登记文件中的行号引用不报错、期望目标行
 * 缺席时该条静默跳过（增量容忍，防误伤——行在不在由 a-d 环守卫）；新引用随批次登记进本集。
 * @param {string} skillsRoot skills 根目录
 * @param {Array<{rule: string, file: string, message: string}>} violations 违例累积
 * @returns {void}
 */
function checkLineRefs(skillsRoot, violations, metaText) {
  const metaFile = join(skillsRoot, 'workflow', 'SKILL.md');
  if (!existsSync(metaFile)) return; // 元技能缺失已由检查 c 报告
  /** @type {Map<string, number>} 路由到列 skill 名 → 当前表实算行号（首个命中行） */
  const rowOf = new Map();
  for (const { rowNo, cells } of routingTableRows(metaText)) {
    for (const m of cells[2].matchAll(/`([a-z][a-z0-9-]*)`/g)) {
      if (!rowOf.has(m[1])) rowOf.set(m[1], rowNo);
    }
  }
  const repoRoot = resolve(skillsRoot, '..', '..');
  for (const exp of LINE_REF_EXPECTATIONS) {
    const expected = rowOf.get(exp.target);
    // 目标行缺席不报本环——行在不在由 a-d 环（unrouted-skill/entry 资产/表漂移）守卫；
    // 本环唯一职责：行存在时「第 N 行」声明值与实算行号的漂移核验（增量夹具容忍同理）。
    if (expected === undefined) continue;
    const file = join(repoRoot, exp.file);
    if (!existsSync(file)) continue; // 文件缺失由既有检查报告
    const text = readFileSync(file, 'utf8');
    exp.re.lastIndex = 0;
    let m;
    while ((m = exp.re.exec(text)) !== null) {
      const claimed = Number(m[1]);
      if (claimed !== expected) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        violations.push({
          rule: 'line-ref-drift',
          file: exp.file,
          message: `路由表行号引用漂移：${exp.file}:${lineNo} 声明第 ${claimed} 行，实际第 ${expected} 行（目标 ${exp.target}）`,
        });
      }
      if (m.index === exp.re.lastIndex) exp.re.lastIndex += 1; // 零宽步进保护
    }
  }
}

/**
 * 行号引用核验期望集（仓库根相对路径）：已知引用清单，新引用随批次登记。
 * target=路由到列 skill 名（期望行号由当前表实算，不硬编码）；SKILL.md 引用统一抓
 * 「路由表第 N 行」形态，测试标题文件用其专属措辞形态。
 * @type {Array<{file: string, target: string, re: RegExp}>}
 */
const LINE_REF_EXPECTATIONS = [
  { file: 'workflow/skills/production-change/SKILL.md', target: 'production-change', re: /路由表第\s*(\d+)\s*行/g },
  { file: 'scout/skills/scout/SKILL.md', target: 'scout', re: /路由表第\s*(\d+)\s*行/g },
  { file: 'scout/skills/spike-run/SKILL.md', target: 'spike-run', re: /路由表第\s*(\d+)\s*行/g },
  { file: 'scout/skills/disposable-build/SKILL.md', target: 'disposable-build', re: /路由表第\s*(\d+)\s*行/g },
  { file: 'scout/scripts/tests/session-start-hook.test.mjs', target: 'spike-run', re: /explore→spike-run 第\s*(\d+)\s*行/g },
  { file: 'scout/scripts/tests/session-start-hook.test.mjs', target: 'disposable-build', re: /disposable→disposable-build 第\s*(\d+)\s*行/g },
  { file: 'scout/scripts/tests/session-start-hook.test.mjs', target: 'spike-run', re: /spike-run（第\s*(\d+)\s*行）/g },
  { file: 'scout/scripts/tests/session-start-hook.test.mjs', target: 'disposable-build', re: /disposable-build（第\s*(\d+)\s*行）/g },
];

/**
 * 主入口：依序跑五项检查，输出 JSON 报告并按违例数退出。
 * @returns {void}
 */
function main() {
  const skillsRoot =
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'skills'); // 脚本定位（2026-09-17）：缺省不受 cwd 影响，杜绝「站错目录 20 skill 全缺失」假报告
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
    // skillsRoot 不属用法契约的一部分（退出码只有 0/1），按"全部缺失"出报告退 1
    process.stderr.write(`错误：skillsRoot 不存在或不是目录：${skillsRoot}（按缺失处理）\n`);
  }
  const expected = expectedSkills();
  /** @type {Array<{rule: string, file: string, message: string}>} */
  const violations = [];
  const metaFile = join(skillsRoot, 'workflow', 'SKILL.md');
  const metaText = existsSync(metaFile) ? readFileSync(metaFile, 'utf8') : ''; // 元技能全文单次读取，三消费方共用
  const present = checkDirectories(skillsRoot, expected, violations);
  const passed = checkFrontmatter(skillsRoot, present, violations);
  const { refs: routingRefs, externalRefs } = checkRoutingTable(skillsRoot, expected, passed, violations, metaText);
  checkScoutRows(skillsRoot, violations, metaText);
  checkLineRefs(skillsRoot, violations, metaText);
  const report = {
    checked: {
      mode: process.env.ROUTING_EXPECT && process.env.ROUTING_EXPECT.trim() ? 'incremental' : 'full',
      skillsRoot,
      expected,
      present: [...present].sort(),
      routingRefs,
      externalRefs,
      frontmatterPassed: [...passed].sort(),
    },
    violations,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(violations.length > 0 ? 1 : 0);
}

main();
