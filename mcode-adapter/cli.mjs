// 文件：mcode-adapter/cli.mjs
// 描述：MCode 适配层安装器（内部决策-034 决策 2/13）。两个子命令：
//       · `install`——把六插件资产 + 适配层声明**物化**成六个 MCode 本地包
//         （`<数据目录>/plugins/<插件名>/`）。落盘前先过包上限与清单/声明校验，任一越界
//         即拒写；逐文件原子落盘（临时名 + rename），**不删目录**——运行中会话可能正持有
//         钩子脚本路径（ZCode 侧 2026-09-12 实测过删旧目录导致钩子静默失效，本层取同款
//         保守姿态）；`--prune` 显式清理计划外旧文件（升级删除面收口，如 Python core）。
//         `--dry-run` 只报计划；`--with-agents` 额外物化三份只读定位 agent（code-reviewer 工具面含 Bash，非纯只读）。
//       · `verify`——对已装包重算计划并逐文件**字节**比对（不依赖哈希），报缺失/多余/变更三类漂移；
//         并核对声明里的解释器路径是否仍指向当前解析结果；对已存在且**带本层管理标记**的
//         `agents/` 面做只读核对（无标记＝未管理面，不报漂移；本命令零写，内部决策-054 G-02/G-03）。非零退出即红。
//       写面三处：宿主数据目录的 `plugins/`、（可选）`agents/`、安装期**瞬时**备份根
//       `.mcode-adapter-backups/`（成功/完整回滚后清理，回滚不完整时保留供人工恢复）；
//       六插件源目录**只读**。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
// 用法：node mcode-adapter/cli.mjs [install|verify] [--dry-run] [--with-agents] [--prune]
//                            [--data-dir <路径>] [--repo-root <路径>] [--json]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderArtifacts } from '../plugin-core/src/materialize.mjs';
import { collectSourceFiles, isLocalArtifact, renderIconPng, sha256OfBuffer } from './src/assets.mjs';
import { auditDisposition, listCommandNames, materializeCommandSkill } from './src/command-skills.mjs';
import { translateHookDoc, validateHookDoc } from './src/hook-template.mjs';
import { detectHostApp } from './src/host-presence.mjs';
import { buildManifest, validateManifest, validateSkillDocs } from './src/manifest.mjs';
import { checkPlanLimits } from './src/package-limits.mjs';
import { PLUGINS, PLUGIN_META } from './src/plugin-meta.mjs';
import { diagnoseNode, nodeFailureText, resolveNode } from './src/node-resolve.mjs';
import { convertAgentFile, installAgentDoc, listAgentNames } from './src/agents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 适配层自身根（物化 shim 的来源）。 */
const ADAPTER_ROOT = HERE;

/** MCode 钩子声明在包内的路径（与 ZCode 的 `hooks/hooks.json` 并存，不覆盖）。 */
const MCODE_HOOK_DOC_REL = 'hooks/hooks.mcode.json';

/** 清单路径。 */
const MANIFEST_REL = '.minimax-plugin/plugin.json';

/** 适配层自有的 shim 文件（物化进每个包）。 */
const SHIM_FILES = Object.freeze(['mcode/hook-shim.mjs', 'mcode/hook-lib.mjs', 'mcode/relay-drain.mjs']);

/**
 * 引擎闭包（批 3 步骤 1）：`plugin-core` 的**可装载闭包超集**——`src/*.mjs`（`engine.mjs` 与其
 * 静态 import 的 `validate.mjs`，**含 `materialize.mjs` 等非运行期成员**）+ `src/strategies/*.mjs`
 * （六族）+ 两数据 JSON（`validate.mjs` 以 `dirname(import.meta.url)/..` 相对读取，故必须落在
 * 副本 `plugin-core/` 根）。**口径诚实**：这是 import 图的**超集**（目录枚举的代价＝上游新增
 * `src/` 文件会自动随包出货），由 `tests/engine-materialize.test.mjs` 的「import 图 ⊆ 清单」
 * 断言守住**必需面**、`verify` 的逐字节比对 + 装载探针守住**一致性**与**可装载性**（sha256 仅用于树指纹）。
 * @param {string} repoRoot 仓库根
 * @returns {{rel: string, bytes: Buffer}[]} 包内相对路径 → 字节（目录层级复刻上游算式）
 */
function listEngineFiles(repoRoot) {
  const coreDir = join(repoRoot, 'plugin-core');
  const out = [];
  for (const name of ['degradation-rules.json', 'capability-matrix.json']) {
    out.push({ rel: `plugin-core/${name}`, bytes: readFileSync(join(coreDir, name)) });
  }
  const srcDir = join(coreDir, 'src');
  for (const name of readdirSync(srcDir).filter((n) => n.endsWith('.mjs')).sort()) {
    out.push({ rel: `plugin-core/src/${name}`, bytes: readFileSync(join(srcDir, name)) });
  }
  const strategyDir = join(srcDir, 'strategies');
  for (const name of readdirSync(strategyDir).filter((n) => n.endsWith('.mjs')).sort()) {
    out.push({ rel: `plugin-core/src/strategies/${name}`, bytes: readFileSync(join(strategyDir, name)) });
  }
  return out;
}

/** 中立清单文件名（期二换源后的唯一手工编辑面，内部决策-036）。 */
const MANIFEST_FILE = 'plugin.manifest.json';

/**
 * 读取中立清单解析态（内部任务-5 B：展示合成的中立源 + 钩子声明源共用一次读）。
 * @param {string} sourceRoot 插件根
 * @param {string[]} problems 问题清单（损坏时记入——损坏 ≠ 缺失，不得静默回落）
 * @returns {object|null} 解析态清单；文件缺失或损坏返回 null（缺失=合法回落生成物）
 */
function readNeutralManifest(sourceRoot, problems) {
  const manifestPath = join(sourceRoot, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null; // 文件**缺失**才回落生成物（与 DSH 侧 内部决策-036 决策 6 同语义）
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    // 损坏 ≠ 缺失：必须记一条 problem（否则会静默回落到可能已陈旧的生成物，把撤销过的钩子复活）
    problems.push(`中立清单损坏：${MANIFEST_FILE}（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}

/**
 * 中立清单 → ZCode 形态 doc（批 3 步骤 3 的换源面）：**直接复用物化器**的 `renderArtifacts`
 * （单一源，本层不再保留第二份分组实现）；只保留「清单缺失/零声明」两态语义。
 * 坏声明（如缺 args）记 problem 并返回空声明，保持「可读拒绝、零写入」，不抛穿安装器。
 * @param {object|null} neutral 中立清单解析态（null=缺失/损坏，回落生成物）
 * @param {string[]} [problems] 收集翻译失败原因
 * @returns {{hooks: Record<string, object[]>}|null} ZCode 形态 doc；null 表示回落生成物
 */
export function manifestToZcodeDoc(neutral, problems = []) {
  if (neutral === null) return null;
  // 清单在场即权威：`hooks` 缺失或显式为空数组都表示"零声明"，**不得**回落生成物
  //（DSH 侧 `readManifestHookConfig` 同款两态）。
  // 内部未决-276（内部任务-308）：非数组 hooks＝形态非法，须记 problem（与 kimi 侧同口径；不得静默零声明）
  if (neutral.hooks !== undefined && !Array.isArray(neutral.hooks)) {
    problems.push('中立清单 hooks 形态非法（非数组，拒绝翻译）');
    return { hooks: {} };
  }
  if (!Array.isArray(neutral.hooks) || neutral.hooks.length === 0) return { hooks: {} };
  // 物化器的序列化器不处理 undefined（缺 statusMessage 会写出非法 JSON）——本层先归一必填/可选字段；
  // 缺 args 属坏声明，保持「可读拒绝」而不是让 renderArtifacts 抛穿。
  if (neutral.hooks.some((h) => !h || typeof h !== 'object' || !Array.isArray(h.args))) {
    problems.push('中立清单钩子声明缺 args（拒绝翻译）');
    return { hooks: {} };
  }
  const normalized = {
    ...neutral,
    hooks: neutral.hooks.map((h) => ({ ...h, statusMessage: typeof h.statusMessage === 'string' ? h.statusMessage : '' })),
  };
  try {
    const artifact = renderArtifacts(normalized).find((file) => file.rel === 'hooks/hooks.json');
    return artifact ? JSON.parse(artifact.bytes.toString('utf8')) : { hooks: {} };
  } catch (error) {
    problems.push(`中立清单钩子声明不可翻译：${error instanceof Error ? error.message : String(error)}`);
    return { hooks: {} };
  }
}

/** 相对路径 → 平台路径。 */
function toPlatform(rel) {
  return rel.split('/').join(sep);
}

/**
 * 读 JSON 文件；损坏时记 problem 并返回 null（不抛穿安装器，保持「损坏 ≠ 缺失」可读拒绝）。
 * @param {string} path 文件绝对路径
 * @param {string[]} problems 问题清单
 * @param {string} label 报错标签
 * @returns {object|null}
 */
function readJsonFile(path, problems, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${label}损坏：${path}（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}

/**
 * 仓库根解析：显式参数 > 本文件上溯两级（本文件在 `<仓库根>/mcode-adapter/cli.mjs`）。
 * @param {string} [flag] 显式仓库根（空串即自动推导）
 * @returns {string} 仓库根绝对路径
 */
export function resolveRepoRoot(flag) {
  if (flag) return resolve(flag);
  return resolve(ADAPTER_ROOT, '..');
}

/**
 * 数据目录解析：显式参数 > `MINIMAX_DATA_DIR` > 家目录下的 `.minimax`。
 * @param {string} [flag] 显式数据目录（空串即按环境推导）
 * @param {Record<string, string|undefined>} [env] 环境（注入缝）
 * @returns {string} 数据目录绝对路径；无法推导返回空串
 */
export function resolveDataDir(flag, env = process.env) {
  if (flag) return resolve(flag);
  if (typeof env.MINIMAX_DATA_DIR === 'string' && env.MINIMAX_DATA_DIR.trim() !== '') return resolve(env.MINIMAX_DATA_DIR);
  const home = env.USERPROFILE || env.HOME || '';
  return home === '' ? '' : resolve(home, '.minimax');
}

/**
 * 组装单个包的物化计划（纯读盘 + 纯计算，不落盘）。
 * @param {{repoRoot: string, plugin: string, nodePath: string}} input 输入
 * @returns {{plugin: string, files: {rel: string, bytes: Buffer}[], manifest: object, hookDoc: object, skills: string[], commands: {generated: string[], covered: string[]}, problems: string[], stats: object}}
 */
export function planPackage(input) {
  const problems = [];
  const sourceRoot = join(input.repoRoot, input.plugin);
  const files = [];
  // ① 源资产（只读照搬；符号链接记 problem 并拒装）
  // 内部任务-320（内部未决-270）：源目录缺失不再抛顶层 ENOENT——枚举失败就地降级为 problem
  // （对齐 kimi 侧同形态 `kimi-code-adapter/cli.mjs:178-183`）。**先给空回落再记 problem**，
  // 否则 `source.problems` 解引用 undefined 会退化为顶层「安装器异常」退 2（＝退回 内部未决-270
  // 原症状）。缺源由此进入 installPackages 的既有 precheck 通道 ⇒ `phase:'precheck'`／退 2／
  // 零写入；verify 侧同通道退 1。
  // 内部任务-320（2026-11-04 收尾评审 F1）：源目录缺失这一**事实只报一次**——措辞与 CLI 层
  // `插件源缺失（--repo-root 下无该目录）` 同源（此前预检与此处兜底各报一套措辞 ⇒ 同一事实两套
  // 文案，且派生后果把报告面撑到 46 条）。
  const sourceMissing = !existsSync(sourceRoot);
  let source = { files: [], problems: [] };
  try {
    source = collectSourceFiles(sourceRoot);
  } catch (error) {
    problems.push(sourceMissing
      ? '插件源缺失（--repo-root 下无该目录）'
      : `源资产：枚举失败（${error?.code ?? 'unknown'}）`);
  }
  problems.push(...source.problems);
  for (const entry of source.files) {
    files.push({ rel: entry.rel, bytes: readFileSync(join(sourceRoot, toPlatform(entry.rel))) });
  }
  // ② 适配层自有 shim
  for (const rel of SHIM_FILES) {
    files.push({ rel, bytes: readFileSync(join(ADAPTER_ROOT, toPlatform(rel))) });
  }
  // ②b 引擎闭包（批 3 步骤 1）：随包物化 `plugin-core` 的可装载闭包（超集，见 `listEngineFiles`
  //    注释）——目录层级复刻，使 `loadEngine(<包根>)` 的算式在包内成立；
  //    使 `loadEngine(<包根>)` 的 `join(repoRoot,'plugin-core',file)` 算式在包内成立；
  //    漂移由 `verify` 的逐字节比对 + 装载探针把守（sha256 仅用于树指纹；步骤 2）。
  // 同上（内部任务-320／内部未决-270）：引擎闭包枚举失败（`plugin-core/` 缺失）就地降级为 problem，
  // 不撞顶层异常；缺源同样进入 installPackages 的既有 precheck 通道。
  // 引擎闭包缺失是**仓库级**事实（`plugin-core/` 不在）：只由首个 plan 报一次（否则每插件一条 ⇒
  // 同一事实 6 条，F1），且**必须进 plan.problems** ⇒ install 的 precheck 通道能拦下「缺源零写入」
  // （收尾评审修复 delta 发现的回归：抑制 plan 级引擎 problem 后，仅缺 plugin-core 时 precheck 不再触发）。
  const engineRootMissing = !existsSync(join(input.repoRoot, 'plugin-core'));
  let engineFiles = [];
  try {
    engineFiles = listEngineFiles(input.repoRoot);
  } catch (error) {
    if (engineRootMissing) {
      if (input.plugin === PLUGINS[0]) problems.push('仓库级：引擎源缺失（--repo-root 下无该目录）');
    } else {
      problems.push(`引擎闭包：枚举失败（${error?.code ?? 'unknown'}）`);
    }
  }
  for (const entry of engineFiles) files.push(entry);
  // ③ ZCode 清单取版本与作者（套件版本即插件版本，内部决策-017；本层不另抄）；生成物描述留作回落值
  let version = '0.0.0';
  let author = 'unknown';
  let artifactDescription = null;
  const zcodeManifestPath = join(sourceRoot, '.zcode-plugin', 'plugin.json');
  if (existsSync(zcodeManifestPath)) {
    const zcode = readJsonFile(zcodeManifestPath, problems, '源清单 ');
    if (zcode) {
      if (typeof zcode.version === 'string') version = zcode.version;
      if (typeof zcode.author === 'string' && zcode.author.trim() !== '') author = zcode.author;
      if (typeof zcode.description === 'string' && zcode.description.trim() !== '') artifactDescription = zcode.description;
    }
  } else if (!sourceMissing) {
    // 缺源时跳过派生校验：清单缺失是「插件源缺失」的派生后果，重复入报告会把事实撑成噪声（F1）。
    problems.push(`源清单缺失：${input.plugin}/.zcode-plugin/plugin.json`);
  }
  // ③b 展示元数据自中立清单合成（内部任务-5 B，R-pc-14）：displayName/description 的唯一人工编辑源
  //     是 plugin.manifest.json——本层不留第二份品牌表；无中立源时 displayName 回落稳定 slug
  //    （插件目录名）、description 回落生成物描述；两侧皆缺即记 problem（公开槽空值装前即红）。
  const neutral = sourceMissing ? null : readNeutralManifest(sourceRoot, problems);
  const meta = { ...PLUGIN_META[input.plugin] };
  meta.displayName = typeof neutral?.displayName === 'string' && neutral.displayName.trim() !== '' ? neutral.displayName : input.plugin;
  const neutralDescription = typeof neutral?.description === 'string' && neutral.description.trim() !== '' ? neutral.description : null;
  meta.description = neutralDescription ?? artifactDescription;
  if (meta.description === null && !sourceMissing) problems.push('清单：description 缺失（中立清单与生成物均无可用描述）');
  // ④ 命令面 → skill（薄指针不物化；处置表与真实文件必须一一对应）
  const commandsDir = join(sourceRoot, 'commands');
  const audit = auditDisposition(input.plugin, commandsDir);
  if (!sourceMissing && audit.missing.length > 0) problems.push(`命令面有未登记文件：${audit.missing.join(', ')}`);
  if (!sourceMissing && audit.extra.length > 0) problems.push(`处置表登记了不存在的命令：${audit.extra.join(', ')}`);
  if (!sourceMissing && audit.invalid.length > 0) problems.push(`处置表条目非法：${audit.invalid.join(', ')}`);
  const generated = [];
  const covered = [];
  for (const command of listCommandNames(commandsDir)) {
    const skill = materializeCommandSkill(input.plugin, command, commandsDir);
    if (skill) {
      generated.push(command);
      files.push({ rel: skill.rel, bytes: Buffer.from(skill.content, 'utf8') });
    } else {
      covered.push(command);
    }
  }
  // ⑤ 钩子声明翻译（批 3 步骤 3：**中立清单优先**，生成物 `hooks/hooks.json` 降级为兼容回落面）
  const zcodeHooksPath = join(sourceRoot, 'hooks', 'hooks.json');
  const manifestDoc = sourceMissing ? null : manifestToZcodeDoc(neutral, problems);
  const hookSourceDoc = manifestDoc ?? (existsSync(zcodeHooksPath) ? readJsonFile(zcodeHooksPath, problems, '源钩子声明 ') : null);
  let hookDoc = { hooks: {} };
  let handlerCount = 0;
  let syntheticRelayDrain = false;
  if (hookSourceDoc !== null) {
    const translated = translateHookDoc(hookSourceDoc, { nodePath: input.nodePath, syntheticRelayDrain: true });
    hookDoc = translated.doc;
    handlerCount = translated.stats.handlers;
    syntheticRelayDrain = translated.stats.syntheticRelayDrain === true;
    for (const rel of translated.stats.scripts) {
      if (!files.some((file) => file.rel === rel)) problems.push(`钩子脚本不在物化计划内（拒绝包外路径）：${rel}`);
    }
    if (translated.stats.unresolved > 0) {
      const detail = translated.stats.unresolvedDetails.slice(0, 5)
        .map((item) => `${item.event}#${item.index}${item.scriptRel ? `(${item.scriptRel})` : ''}`)
        .join(', ');
      problems.push(`钩子声明有 ${translated.stats.unresolved} 条未能翻译（${detail}${translated.stats.unresolved > 5 ? ' …' : ''}）`);
    }
  } else if (!existsSync(zcodeHooksPath) && existsSync(join(sourceRoot, 'hooks'))) {
    problems.push(`源钩子声明缺失：${input.plugin}/hooks/hooks.json（且无可用中立清单）`);
  }
  const manifestHooks = Object.keys(hookDoc.hooks).length > 0 ? [MCODE_HOOK_DOC_REL] : [];
  if (manifestHooks.length > 0) {
    files.push({ rel: MCODE_HOOK_DOC_REL, bytes: Buffer.from(`${JSON.stringify(hookDoc, null, 2)}\n`, 'utf8') });
    problems.push(...validateHookDoc(hookDoc).map((item) => `钩子声明：${item}`));
  }
  // ⑥ skill 清单（源 skill + 命令型 skill）
  const skills = files
    .filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.rel))
    .map((file) => file.rel);
  // ⑥b skill 文档面（frontmatter 名/描述）：宿主对任一不符**整包拒收**，故装前必须拦
  problems.push(...validateSkillDocs(files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.rel))).map((item) => `skill：${item}`));
  // ⑦ 图标（自生成 PNG，确定性）
  files.push({ rel: 'icon.png', bytes: renderIconPng(meta.hue, false) });
  files.push({ rel: 'icon-dark.png', bytes: renderIconPng(meta.hue, true) });
  // ⑧ 清单
  const manifest = buildManifest({ plugin: input.plugin, meta, version, author, skills, hooks: manifestHooks });
  // 缺源时生成的清单本身是派生件，其校验失败同为派生噪声（不重复报同一事实，F1）。
  if (!sourceMissing) problems.push(...validateManifest(manifest).map((item) => `清单：${item}`));
  files.push({ rel: MANIFEST_REL, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  // ⑨ 包上限（落盘前）
  problems.push(...checkPlanLimits(files.map((file) => ({ rel: file.rel, bytes: file.bytes.length }))));
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    plugin: input.plugin,
    files,
    manifest,
    hookDoc,
    skills,
    commands: { generated: generated.sort(), covered: covered.sort() },
    problems,
    stats: { files: files.length, handlers: handlerCount, syntheticRelayDrain, skills: skills.length, commandsGenerated: generated.length },
  };
}

/**
 * 原子落盘（临时名 + rename；同目录内 rename 在 Windows 上覆盖既有文件）。
 * @param {string} target 目标绝对路径
 * @param {Buffer} bytes 内容
 * @returns {void}
 */
export function writeFileAtomic(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.mcode-tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
}

/** 本地产物/临时文件谓词（指纹/备份/回滚/prune/verify 同一口径）。 */
function isEphemeralRel(rel) {
  return isLocalArtifact(rel) || rel.includes('.mcode-tmp-');
}

/**
 * **只读**列举已装包内不在当前计划中的文件（`verify` 的「多余」与 `--prune` 的删除集共用同一来源）。
 * 默认保守不删目录，升级后旧版本残留（如 Python core 删除面）由用户显式 prune 收口。
 * 本地产物（isLocalArtifact）与临时文件保留——它们不属于计划面。
 * @param {string} target 包根
 * @param {Set<string>} planned 计划内包相对路径
 * @returns {string[]} 计划外文件相对路径
 */
function listExtras(target, planned) {
  const extras = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      const rel = relative(target, child).split(sep).join('/');
      if (entry.isDirectory()) { walk(child); continue; }
      if (isEphemeralRel(rel)) continue;
      if (!planned.has(rel)) extras.push(rel);
    }
  };
  if (existsSync(target)) walk(target);
  return extras.sort();
}

/**
 * 清理已装包内不在当前计划中的文件（仅显式 `--prune`）。
 * @param {string} target 包根
 * @param {Set<string>} planned 计划内包相对路径
 * @returns {string[]} 已删除的相对路径
 */
export function pruneExtras(target, planned) {
  const removed = listExtras(target, planned);
  for (const rel of removed) unlinkSync(join(target, toPlatform(rel)));
  return removed;
}

/**
 * 物化单个包。
 * @param {{plan: object, dataDir: string, dryRun: boolean, prune?: boolean}} input 输入
 * @returns {{plugin: string, target: string, written: number, pruned: string[], problems: string[]}}
 */
export function installPackage(input) {
  const target = join(input.dataDir, 'plugins', input.plan.plugin);
  const problems = [...input.plan.problems];
  const planned = new Set(input.plan.files.map((file) => file.rel));
  if (input.dryRun) {
    return { plugin: input.plan.plugin, target, written: input.plan.files.length, pruned: input.prune ? listExtras(target, planned) : [], problems };
  }
  if (problems.length > 0) return { plugin: input.plan.plugin, target, written: 0, pruned: [], problems };
  for (const file of input.plan.files) writeFileAtomic(join(target, toPlatform(file.rel)), file.bytes);
  const pruned = input.prune ? pruneExtras(target, planned) : [];
  return { plugin: input.plan.plugin, target, written: input.plan.files.length, pruned, problems };
}

/**
 * 核对一个已装包与当前计划的漂移。
 * @param {{plan: object, dataDir: string}} input 输入
 * @returns {{plugin: string, target: string, missing: string[], extra: string[], changed: string[], problems: string[]}}
 */
export function verifyPackage(input) {
  const target = join(input.dataDir, 'plugins', input.plan.plugin);
  const missing = [];
  const changed = [];
  const problems = [...input.plan.problems];
  if (!existsSync(target)) return { plugin: input.plan.plugin, target, missing: ['<整包缺失>'], extra: [], changed: [], problems };
  const planned = new Map(input.plan.files.map((file) => [file.rel, file.bytes]));
  for (const [rel, bytes] of planned) {
    const abs = join(target, toPlatform(rel));
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const actual = readFileSync(abs);
    if (!actual.equals(bytes)) changed.push(rel);
  }
  // 计划外文件走查与 prune 同一实现（单一谓词，避免删除集与「多余」集分叉）
  const extra = listExtras(target, new Set(planned.keys()));
  // 装载探针（批 3 步骤 2）：sha256 只证「字节等于计划」，证不了「可装载」——清单漏文件或目录
  // 层级错时，副本仍可逐字节全等却 import 失败（运行期 shim 会整体落入降级面）。故 verify 必须
  // 真实装载一次。入口 URL 用 `pathToFileURL`（Windows 上裸绝对路径喂 import 会抛
  // ERR_UNSUPPORTED_ESM_URL_SCHEME）。
  if (missing.length === 0 && changed.length === 0) {
    const probe = probeEngineInPackage(target);
    if (probe !== null) problems.push(probe);
  }
  return { plugin: input.plan.plugin, target, missing, extra, changed: changed.sort(), problems };
}

/**
 * 在物化包上真实装载一次引擎（批 3 步骤 2 的装载探针）。
 * `loadEngine` 收**包根**（契约 `join(repoRoot,'plugin-core',file)`）。
 * @param {string} target 物化包根
 * @param {{timeoutMs?: number, spawn?: Function}} [options] 注入缝（测试用）：超时毫秒与 spawn 实现
 * @returns {string|null} 失败描述；通过时 null
 */
export function probeEngineInPackage(target, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnSync;
  const entry = join(target, 'plugin-core', 'src', 'engine.mjs');
  if (!existsSync(entry)) return `装载探针：缺少引擎入口 ${entry}`;
  const script = `import(${JSON.stringify(pathToFileURL(entry).href)}).then((m) => { const e = m.loadEngine(${JSON.stringify(target)}); if (typeof e.applyRule !== 'function') throw new Error('applyRule 缺失'); }).catch((e) => { process.stderr.write(String(e && e.message)); process.exit(3); });`;
  const r = spawn(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (r.status === 0) return null;
  // 失败分类与运行期 `describeChildFailure` 同姿态：超时 ≠ 起不来 ≠ 被信号杀掉。混报会把排查
  // 带偏（内部任务-295 复审 round2 N5；CR-04 已把同类误报定为 HIGH，本处为安装期落点故按 NORMAL 处置）。
  if (r.error && r.error.code === 'ETIMEDOUT') return `装载探针失败（超时，${timeoutMs}ms）`;
  if (r.error) return `装载探针失败（启动失败 ${String(r.error.code ?? r.error.message ?? '')}）`;
  if (r.status === null) return `装载探针失败（被信号终止：${String(r.signal ?? '未知')}）`;
  return `装载探针失败（退出 ${String(r.status)}）：${String(r.stderr ?? '').split('\n')[0].slice(0, 300)}`;
}

/**
 * 目录树文件级指纹：包相对路径 → sha256（跳过本地产物与 `.mcode-tmp-`；目录不入指纹）。
 * @param {string} target 包根/agents 根
 * @returns {Record<string, string>} 指纹映射（空对象＝不存在或空树）
 */
export function fingerprintTree(target) {
  const out = {};
  if (!existsSync(target)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      const rel = relative(target, child).split(sep).join('/');
      if (isEphemeralRel(rel)) continue;
      if (entry.isDirectory()) { walk(child); continue; }
      out[rel] = sha256OfBuffer(readFileSync(child));
    }
  };
  walk(target);
  return out;
}

/**
 * 指纹全等判定（键集与逐文件哈希；与枚举顺序无关）。
 * @param {Record<string, string>} a 指纹 A
 * @param {Record<string, string>} b 指纹 B
 * @returns {boolean} 是否全等
 */
function fingerprintsEqual(a, b) {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false;
    if (a[keysA[i]] !== b[keysB[i]]) return false;
  }
  return true;
}

/**
 * 备份根目录名（可移植：无冒号等平台非法字符）。
 * @param {Date} [now] 时间注入缝
 * @returns {string} `YYYYMMDD-HHmmss-<pid>`
 */
export function backupDirectoryName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${process.pid}`;
}

/**
 * copy 式备份既有包/agents 根（原目录留位；目标不存在＝无备份）。
 * @param {string} target 包根/agents 根
 * @param {string} backupTarget 备份目标路径
 * @returns {boolean} 是否实际创建了备份
 */
export function backupPackage(target, backupTarget) {
  if (!existsSync(target)) return false;
  mkdirSync(backupTarget, { recursive: true });
  cpSync(target, backupTarget, { recursive: true, force: true });
  return true;
}

/**
 * 回滚单个包/agents 根到调用前状态：计划内文件（含链接，目录跳过）删除 → 有备份则回放 →
 * 清理本进程遗留 `.mcode-tmp-*`（rename 失败残留）。
 * @param {{target: string, backupTarget: string|null, planned: string[]}} input 输入
 * @returns {void}
 */
export function restorePackage(input) {
  const { target, backupTarget, planned } = input;
  if (existsSync(target)) {
    for (const rel of planned) {
      const abs = join(target, toPlatform(rel));
      let st = null;
      try { st = lstatSync(abs); } catch { st = null; }
      if (st !== null && !st.isDirectory()) unlinkSync(abs);
    }
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        const rel = relative(target, child).split(sep).join('/');
        if (entry.isDirectory()) { walk(child); continue; }
        if (rel.includes('.mcode-tmp-')) unlinkSync(child);
      }
    };
    walk(target);
  }
  if (backupTarget !== null && existsSync(backupTarget)) cpSync(backupTarget, target, { recursive: true, force: true });
}

/**
 * 安装编排（内部决策-054 G-01）：写前 copy 式备份 → 逐包原子写 → 写后即验（extra 仅 `--prune` 纳入）→
 * 漂移/异常回滚到调用前指纹 → 备份生命周期（成功/完整回滚清理、回滚不完整保留）。
 * @param {{
 *   plans: object[], dataDir: string, dryRun: boolean, prune?: boolean, withAgents?: boolean,
 *   agentOps?: {install: Function, verify: Function, prune: Function},
 *   verifyImpl?: Function, now?: Date,
 * }} input 输入
 * @returns {{
 *   ok: boolean,
 *   phase?: 'precheck'|'write'|'verify'|'rollback-incomplete',
 *   exitCode?: 1|2, message?: string, backupRoot?: string,
 *   plugins?: object[], problems?: string[], agents?: object,
 *   warnings?: string[],
 * }} 编排结果（problems 非空即非 ok；warnings 为**不阻断**的残留告警，如备份根清理失败）
 */
export function installPackages(input) {
  const { plans, dataDir, dryRun } = input;
  const prune = input.prune === true;
  const withAgents = input.withAgents === true && typeof input.agentOps === 'object' && input.agentOps !== null;
  const verifyImpl = typeof input.verifyImpl === 'function' ? input.verifyImpl : verifyPackage;
  const removeImpl = typeof input.removeImpl === 'function' ? input.removeImpl : (target) => rmSync(target, { recursive: true, force: true });
  const warnings = [];
  const plugins = plans.map((plan) => ({
    plugin: plan.plugin,
    target: join(dataDir, 'plugins', plan.plugin),
    written: plan.files.length,
    pruned: [],
    stats: plan.stats,
    problems: plan.problems,
  }));
  const precheck = plans.flatMap((plan) => plan.problems.map((item) => `${plan.plugin}：${item}`));
  if (dryRun) {
    for (const plugin of plugins) {
      const plan = plans.find((item) => item.plugin === plugin.plugin);
      const result = installPackage({ plan, dataDir, dryRun: true, prune });
      plugin.pruned = result.pruned;
      plugin.written = result.written;
    }
    // dry-run 只演算不落盘，但**结论必须与真跑一致**：有计划问题即 ok:false ＋ 与真跑同档退出码。
    // 否则 JSON 报 ok:true/exitCode:0 而进程退 1，机器消费方会把「计划有问题」当成功
    // （内部任务-295 复审 round2 N6，CR-12 的验收口径即「字段与实际分支一一对应」）。
    // problems 由各 plugin 条目承载（调用方已逐条打印并聚合），此处留空以避双写。
    if (precheck.length > 0) {
      return { ok: false, phase: 'precheck', exitCode: 2, problems: [], plugins, warnings, message: '计划校验未通过（dry-run 未写入任何文件；修复后重跑）' };
    }
    return { ok: true, plugins, warnings };
  }
  if (precheck.length > 0) {
    // 与 dry-run 分支同口径：problems 由各 plugin 条目承载（调用方已逐条打印并入账），顶层留空以避**双写**
    // （内部任务-320 stage1 复审发现：非 dry-run 路径曾把同一条问题在 plugin 条目与顶层各写一次 ⇒ 报告与输出各重复一遍）。
    // **同时必须回传 `plugins`／`warnings`**：早退对象若漏 `plugins`，调用方的 plugin 循环（`report.plugins = result.plugins ?? []`）
    // 不会执行 ⇒ plugin 级原因（清单缺失／枚举失败等）两路皆空 ⇒ 报告变成「红但无因」（内部任务-320 stage2 code-r2 N1）。
    // `written` 归 0：precheck 早退**零写入**，沿用编排期的计划文件数会把「物化 N 个文件」虚报成已落盘
    // （2026-11-04 收尾评审 correctness #1；与 `installPackage` 的 problems 非空 ⇒ written=0 语义对齐）。
    return { ok: false, phase: 'precheck', exitCode: 2, problems: [], plugins: plugins.map((item) => ({ ...item, written: 0 })), warnings, message: '写前校验失败：未写入任何文件（修复后重跑）' };
  }
  // 写面根符号链接拒绝：install/prune 均直接 join 写面根，若根是指向外部的链接会写穿「写面仅数据目录」。
  const symlinkRoots = [];
  for (const plan of plans) {
    const target = join(dataDir, 'plugins', plan.plugin);
    try { if (existsSync(target) && lstatSync(target).isSymbolicLink()) symlinkRoots.push(target); } catch { /* 不可读留给写阶段报错 */ }
  }
  if (withAgents) {
    const agentsRoot = join(dataDir, 'agents');
    try { if (existsSync(agentsRoot) && lstatSync(agentsRoot).isSymbolicLink()) symlinkRoots.push(agentsRoot); } catch { /* 同上 */ }
  }
  if (symlinkRoots.length > 0) {
    return { ok: false, phase: 'precheck', exitCode: 2, problems: symlinkRoots.map((item) => `写面根为符号链接，拒绝写入：${item}`), message: '写前校验失败：未写入任何文件（修复后重跑）' };
  }
  const backupRoot = join(dataDir, '.mcode-adapter-backups', backupDirectoryName(input.now));
  const snapshots = new Map();
  /**
   * 逆序回滚并核对调用前指纹。
   * @returns {boolean} 回滚是否完整
   */
  const rollback = () => {
    let complete = true;
    for (let i = plans.length - 1; i >= 0; i -= 1) {
      const plan = plans[i];
      const snap = snapshots.get(plan.plugin);
      if (!snap) continue;
      try {
        restorePackage({ target: snap.target, backupTarget: snap.backupTarget, planned: plan.files.map((file) => file.rel) });
        if (!fingerprintsEqual(fingerprintTree(snap.target), snap.fingerprint)) complete = false;
      } catch {
        complete = false;
      }
    }
    if (withAgents) {
      const snap = snapshots.get('agents');
      if (snap) {
        try {
          restorePackage({ target: snap.target, backupTarget: snap.backupTarget, planned: snap.planned ?? [] });
          if (!fingerprintsEqual(fingerprintTree(snap.target), snap.fingerprint)) complete = false;
        } catch {
          complete = false;
        }
      }
    }
    if (complete) {
      try { removeImpl(backupRoot); } catch (error) {
        warnings.push(`备份根残留：${backupRoot}（${error instanceof Error ? error.message : String(error)}），请手动清理`);
      }
    }
    return complete;
  };
  try {
    for (const plan of plans) {
      const target = join(dataDir, 'plugins', plan.plugin);
      const backupTarget = backupPackage(target, join(backupRoot, 'plugins', plan.plugin)) ? join(backupRoot, 'plugins', plan.plugin) : null;
      snapshots.set(plan.plugin, { target, backupTarget, fingerprint: fingerprintTree(target) });
    }
    if (withAgents) {
      const agentsRoot = join(dataDir, 'agents');
      const backupTarget = backupPackage(agentsRoot, join(backupRoot, 'agents')) ? join(backupRoot, 'agents') : null;
      snapshots.set('agents', { target: agentsRoot, backupTarget, fingerprint: fingerprintTree(agentsRoot) });
    }
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      const result = installPackage({ plan, dataDir, dryRun: false, prune });
      plugins[i].written = result.written;
      plugins[i].pruned = result.pruned;
    }
    let agents = null;
    if (withAgents) {
      const agentsSnapshot = snapshots.get('agents');
      agents = input.agentOps.install({
        onPlan: (rels) => {
          if (agentsSnapshot) agentsSnapshot.planned = [...rels, AGENTS_MANAGED_MARKER];
        },
      });
    }
    const problems = [];
    const agentsFatal = agents && Array.isArray(agents.fatal) ? agents.fatal : [];
    for (const item of agentsFatal) problems.push(`agents：${item}`);
    // 必须带 withAgents：install --prune（不带 --with-agents）时 agents 为 null，对 null 赋值会 TypeError
    if (withAgents && prune && agents && agentsFatal.length === 0 && typeof input.agentOps.prune === 'function') {
      agents.pruned = input.agentOps.prune();
    }
    for (const plan of plans) {
      const result = verifyImpl({ plan, dataDir });
      const extras = prune ? result.extra : [];
      for (const rel of result.missing) problems.push(`${plan.plugin}：缺失 ${rel}`);
      for (const rel of result.changed) problems.push(`${plan.plugin}：变更 ${rel}`);
      for (const rel of extras) problems.push(`${plan.plugin}：多余 ${rel}`);
      for (const item of result.problems) problems.push(`${plan.plugin}：${item}`);
    }
    if (withAgents) {
      const checked = input.agentOps.verify();
      for (const rel of checked.missing ?? []) problems.push(`agents：缺失 ${rel}`);
      for (const rel of checked.changed ?? []) problems.push(`agents：变更 ${rel}`);
      // 与包面同向：计划外 agent 文件仅 `--prune` 时纳入失败判据（默认 install 允许在场退 0）
      if (prune) {
        for (const rel of checked.extra ?? []) problems.push(`agents：多余 ${rel}`);
      }
      for (const item of checked.problems ?? []) problems.push(`agents：${item}`);
    }
    if (problems.length > 0) {
      const complete = rollback();
      if (complete) return { ok: false, phase: 'verify', exitCode: 1, problems, warnings, message: '写后即验失败：已回滚本次写入' };
      return { ok: false, phase: 'rollback-incomplete', exitCode: 2, problems, warnings, backupRoot, message: `回滚不完整：备份保留于 ${backupRoot}，请按 verify 清单人工恢复` };
    }
    // 备份清理是 best-effort：清理失败（如 win32 AV/索引器占用）不得把已通过写后即验的安装回滚成混合态，
    // 但失败必须可见（warnings → CLI/JSON），否则用户无从区分「已清理」与「残留」。
    try { removeImpl(backupRoot); } catch (error) {
      warnings.push(`备份根残留：${backupRoot}（${error instanceof Error ? error.message : String(error)}），请手动清理`);
    }
    return { ok: true, plugins, agents, warnings };
  } catch (error) {
    const complete = rollback();
    const detail = error instanceof Error ? error.message : String(error);
    if (complete) return { ok: false, phase: 'write', exitCode: 2, problems: [], warnings, message: `安装失败：已回滚本次写入（${detail}）` };
    return { ok: false, phase: 'rollback-incomplete', exitCode: 2, problems: [], warnings, backupRoot, message: `回滚不完整：备份保留于 ${backupRoot}，请按 verify 输出的人工恢复清单处理（${detail}）` };
  }
}

/**
 * agents 面管理标记（放在 `<数据目录>/agents/.mcode-adapter-managed.json`）：只有本层写过
 * 该标记，`verify`/`prune` 才核对/清理 agents 面——MCode 真机数据目录自带 `.builtin/`
 * 内建 agent（实测 2026-10-21），未管理面不得被误报缺失/多余（G-03 真机修正）。
 */
const AGENTS_MANAGED_MARKER = '.mcode-adapter-managed.json';

/** 归属条目形态：`<name>/agent.md`（字符类放行点号，段级另判）。 */
const AGENT_OWNED_REL_RE = /^[A-Za-z0-9._-]+\/agent\.md$/;

/**
 * 归属条目判据：形态匹配 **且** 首段不是 `.`/`..`。字符类本身放行点号——
 * 单段 `..` 会经 `join` 归一为 `<数据目录>/agent.md` 越出 agents 根，必须显式拒。
 * @param {unknown} rel 包内相对路径
 * @returns {boolean}
 */
function isOwnedAgentRel(rel) {
  if (typeof rel !== 'string' || !AGENT_OWNED_REL_RE.test(rel)) return false;
  const [name] = rel.split('/');
  return name !== '.' && name !== '..';
}

/**
 * 读 agents 面管理标记，返回本层**拥有的包内相对路径**集合；`null`＝未管理面（无标记）。
 * 标记是**删除授权**，故必须严格校验：损坏/形状非法 → 记 problem 且返回空集（零删除授权）；
 * 条目必须匹配 `<name>/agent.md`（禁 `.`/`..`/绝对路径/目录穿越）。旧标记只有 `names` 时兼容。
 * @param {string} agentsRoot `<数据目录>/agents`
 * @param {string[]} [problems] 收集损坏/非法条目
 * @returns {Set<string>|null}
 */
export function readAgentsOwnership(agentsRoot, problems = []) {
  const markerPath = join(agentsRoot, AGENTS_MANAGED_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const doc = JSON.parse(readFileSync(markerPath, 'utf8'));
    // 旧标记只有 `names`（纯字符串数组假设）时兼容迁移；非字符串条目一律**零删除授权**——
    // 模板化强转会把 `null` 变成合法条目 `null/agent.md`，而标记本身是删除授权
    // （内部任务-295 复审 round2 N10）。
    let raw;
    if (Array.isArray(doc.files)) {
      raw = doc.files;
    } else if (Array.isArray(doc.names)) {
      const bad = doc.names.filter((name) => typeof name !== 'string');
      if (bad.length > 0) {
        problems.push(`agents 管理标记 names 含非字符串条目（零删除授权）：${markerPath}`);
        return new Set();
      }
      raw = doc.names.map((name) => `${name}/agent.md`);
    } else {
      raw = null;
    }
    if (raw === null) { problems.push(`agents 管理标记形状非法（缺 files/names）：${markerPath}`); return new Set(); }
    const valid = raw.filter(isOwnedAgentRel);
    if (valid.length !== raw.length) { problems.push(`agents 管理标记含非法条目（零删除授权）：${markerPath}`); return new Set(); }
    return new Set(valid);
  } catch (error) {
    problems.push(`agents 管理标记损坏（零删除授权）：${markerPath}（${error instanceof Error ? error.message : String(error)}）`);
    return new Set();
  }
}

/**
 * 收集可安装的 agent 文档：`tools` 映射后为空的 agent 记 `problems` 并跳过；
 * 源目录缺失/不可读记 `fatal`（**硬错误**：install 必须失败且 `--prune` 零删除——否则 `keep` 为空会删净本层 agent）。
 * install/verify/prune 必须共用本函数，否则安装侧跳过的 agent 会被校验侧判缺失。
 * @param {string} repoRoot 仓库根
 * @returns {{docs: object[], dropped: string[], problems: string[], fatal: string[], count: number}}
 */
function collectAgentDocs(repoRoot) {
  const problems = [];
  const fatal = [];
  const dropped = [];
  const docs = [];
  const sourceDir = join(repoRoot, 'workflow', 'agents');
  if (!existsSync(sourceDir)) { fatal.push(`源 agents 目录缺失：${sourceDir}`); return { docs, dropped, problems, fatal, count: 0 }; }
  let names;
  try { names = listAgentNames(sourceDir); } catch (error) { fatal.push(`源 agents 目录不可读：${error instanceof Error ? error.message : String(error)}`); return { docs, dropped, problems, fatal, count: 0 }; }
  for (const name of names) {
    const doc = convertAgentFile(join(sourceDir, `${name}.md`), name);
    for (const tool of doc.dropped) dropped.push(`${name}:${tool}`);
    if (doc.tools.length === 0) { problems.push(`agent ${name} 映射后工具白名单为空（宁可不装）`); continue; }
    docs.push(doc);
  }
  return { docs, dropped, problems, fatal, count: names.length };
}

/**
 * agents 面只读核对（G-03）：期望内容只经 `convertAgentFile` 的内存返回值；目录不存在或
 * **无本层管理标记**＝未安装/未管理（不算漂移）；宿主内建（顶层 `.` 开头目录）不参与多余判定。
 * @param {{repoRoot: string, dataDir: string}} input 输入
 * @returns {{missing: string[], changed: string[], extra: string[], problems: string[]}}
 */
export function verifyAgents(input) {
  const agentsRoot = join(input.dataDir, 'agents');
  const result = { missing: [], changed: [], extra: [], problems: [] };
  if (!existsSync(agentsRoot)) return result;
  const owned = readAgentsOwnership(agentsRoot, result.problems);
  if (owned === null) return result;
  const { docs, fatal } = collectAgentDocs(input.repoRoot);
  for (const item of fatal) result.problems.push(item);
  const expected = new Map();
  for (const doc of docs) expected.set(`${doc.name}/agent.md`, Buffer.from(doc.content, 'utf8'));
  for (const [rel, bytes] of expected) {
    const abs = join(agentsRoot, ...rel.split('/'));
    if (!existsSync(abs)) { result.missing.push(rel); continue; }
    if (!readFileSync(abs).equals(bytes)) result.changed.push(rel);
  }
  // 只核对本层拥有项：他源/用户自建 agent 不在标记里，既不报多余也不参与 prune
  for (const rel of owned) {
    if (expected.has(rel)) continue;
    if (existsSync(join(agentsRoot, ...rel.split('/')))) result.extra.push(rel);
  }
  return result;
}

/**
 * agents 面计划外文件清理（仅 `install --with-agents --prune`）。
 * @param {{repoRoot: string, dataDir: string}} input 输入
 * @returns {string[]} 已删除的相对路径（排序）
 */
export function pruneAgents(input) {
  const agentsRoot = join(input.dataDir, 'agents');
  if (!existsSync(agentsRoot)) return [];
  const markerProblems = [];
  const owned = readAgentsOwnership(agentsRoot, markerProblems);
  if (owned === null) return []; // 未管理面不清理（防删宿主内建/他源 agent）
  const { docs, fatal, count } = collectAgentDocs(input.repoRoot);
  // 源不可得 / 源枚举为空 / **可装集为空** / 标记非法 ⇒ 零删除且不改写标记：keep 为空会把本层
  // agent 全删掉。`count === 0` 覆盖「目录存在但一个 .md 都没有」；`docs.length === 0` 再覆盖
  // 「有 .md 但全部不可装（映射后工具白名单为空 / 非 agent 文档）」——否则 `keep` 为空仍会删净
  // 本层 agent 且退 0（内部任务-295 复审 round3 N-a）。保守方向：宁可留陈旧项，也不静默清空。
  if (fatal.length > 0 || markerProblems.length > 0 || count === 0 || docs.length === 0) return [];
  const keep = new Set(docs.map((doc) => `${doc.name}/agent.md`));
  const removed = [];
  for (const rel of owned) {
    if (keep.has(rel)) continue;
    const abs = join(agentsRoot, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    unlinkSync(abs);
    removed.push(rel);
  }
  writeFileSync(join(agentsRoot, AGENTS_MANAGED_MARKER), `${JSON.stringify({ names: [...keep].map((rel) => rel.split('/')[0]), files: [...keep], updatedAt: new Date().toISOString() }, null, 2)}\n`);
  return removed.sort();
}

/**
 * agent 面物化（显式开启；默认不装）。
 * @param {{repoRoot: string, dataDir: string, dryRun: boolean, onPlan?: (rels: string[]) => void}} input
 *   输入（`onPlan`：写盘前把本次目标登记给编排层，供中途失败回滚删除已写文件）
 * @returns {{names: string[], targets: string[], dropped: string[], problems: string[], fatal: string[]}}
 *   `fatal` 非空＝源不可得（调用方须失败且 `--prune` 零删除）
 */
export function installAgents(input) {
  const agentsRoot = join(input.dataDir, 'agents');
  const { docs, dropped, problems, fatal } = collectAgentDocs(input.repoRoot);
  const names = docs.map((doc) => doc.name);
  if (input.dryRun) return { names, targets: [], dropped, problems, fatal };
  const rels = docs.map((doc) => `${doc.name}/agent.md`);
  // 写前把本次目标登记给编排层：写盘中途失败时回滚能删掉已写文件
  if (typeof input.onPlan === 'function') input.onPlan(rels);
  const targets = docs.map((doc) => installAgentDoc(doc, agentsRoot));
  if (targets.length > 0) {
    // 标记写并集：安装不删除旧文件，旧项必须继续被拥有，verify 才能报多余、prune 才能回收
    const ownedBefore = readAgentsOwnership(agentsRoot) ?? new Set();
    const files = [...new Set([...ownedBefore, ...rels])].sort();
    writeFileSync(join(agentsRoot, AGENTS_MANAGED_MARKER), `${JSON.stringify({ names, files, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return { names, targets, dropped, problems, fatal };
}

/** 用法单行（参数错/无参共用，与 --help 输出同源——三 CLI 中不再是无 USAGE 孤例）。 */
const USAGE = '用法：node mcode-adapter/cli.mjs [install|verify] [--dry-run] [--with-agents] [--prune] [--data-dir <路径>] [--repo-root <路径>] [--json]\n';

function parseArgs(argv) {
  const args = { command: 'install', dryRun: false, withAgents: false, prune: false, json: false, dataDir: '', repoRoot: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === 'install' || token === 'verify') args.command = token;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--with-agents') args.withAgents = true;
    else if (token === '--prune') args.prune = true;
    else if (token === '--json') args.json = true;
    else if (token === '--data-dir' || token === '--repo-root') {
      // 值旗标必须带非 `--` 起头的值——缺值或值形如旗标即入 rest（调用方退 2，防「值旗标
      // 吞掉后续旗标/缺值落真机数据目录」把用法错降级为业务红；zcode-adapter 评审 C2 同源，
      // kimi 侧 内部任务-2 批 A5 同款）。
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) {
        rest.push(token);
      } else {
        if (token === '--data-dir') args.dataDir = v;
        else args.repoRoot = v;
        i += 1;
      }
    }
    else if (token === '--help' || token === '-h') args.command = 'help';
    else rest.push(token);
  }
  args.rest = rest;
  return args;
}

/** 主流程。 */
function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  // 无参即打印用法退 2（对齐 kimi/zcode/plugin-core——此前无参缺省执行 install 是行为孤例，
  // 误触即真机重装；内部任务-2 批 A6 收敛，更安全方向）。
  if (argv.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.rest.length > 0) {
    process.stderr.write(`无法识别的参数：${args.rest.join(' ')}\n${USAGE}`);
    return 2;
  }
  const repoRoot = resolveRepoRoot(args.repoRoot);
  const dataDir = resolveDataDir(args.dataDir);
  if (dataDir === '') {
    process.stderr.write('无法确定宿主数据目录：请用 --data-dir 指定（或设 MINIMAX_DATA_DIR）。\n');
    return 2;
  }
  const node = resolveNode();
  if (!node) {
    // 内部未决-63：三态区分 + 分支专属文案。三态曾共用一条「未解析到可执行的 node…」拒绝文案，
    // 运维者会朝错误方向排查（真装 Node / 真修 PATH，而实际可能是读回失败）。
    process.stderr.write(`${nodeFailureText(diagnoseNode().state)}\n`);
    return 2;
  }
  const lines = [];
  const hostApp = detectHostApp(); // 内部决策-048：与 assurance 探针同库两独立读取者；不阻断安装
  const report = {
    command: args.command,
    dataDir,
    repoRoot,
    node,
    hostApp,
    ok: null,
    phase: null,
    exitCode: null,
    message: null,
    backupRoot: null,
    warnings: [],
    plugins: [],
    problems: [],
  };
  lines.push(`数据目录：${dataDir}`);
  lines.push(`仓库根：${repoRoot}`);
  lines.push(`解释器：${node.path}（来源 ${node.source}）`);
  lines.push(hostApp.present
    ? `宿主应用：在位（${hostApp.hit}）`
    : `宿主应用：未检出（${hostApp.reason ?? `候选：${hostApp.candidates.join('；')}均不存在`}；装在别处请设 MINIMAX_APP_ROOT）`);
  // 内部任务-320（内部未决-270）：仓库根预检——**逐插件源缺失**由 planPackage 单一来源报告（措辞同此处的引擎条目），
  // 避免同一事实两套措辞（2026-11-04 收尾评审 F1）；**引擎源缺失**亦由 planPackage 的首个 plan 以
  // 「仓库级：…」措辞报告一次（须进 plan.problems ⇒ precheck 通道可拦下「缺源零写入」）。
  // install 侧由此走既有 precheck 通道产出 `phase:'precheck'`／退 2／零写入，verify 侧同通道退 1。
  // 文案对齐 kimi 侧形态（`kimi-code-adapter/cli.mjs:911-915`）。
  const plans = PLUGINS.map((plugin) => planPackage({ repoRoot, plugin, nodePath: node.path }));
  if (args.command === 'install') {
    // 内部决策-054 G-01/G-02/G-03：写前 copy 式备份 → 逐包原子写 → 写后即验（extra 仅 --prune 纳入）→
    // 漂移/异常回滚到调用前指纹 → 备份生命周期（成功/完整回滚清理、回滚不完整保留）。
    const result = installPackages({
      plans,
      dataDir,
      dryRun: args.dryRun,
      prune: args.prune,
      withAgents: args.withAgents,
      agentOps: {
        install: (options) => installAgents({ repoRoot, dataDir, dryRun: false, ...options }),
        verify: () => verifyAgents({ repoRoot, dataDir }),
        prune: () => pruneAgents({ repoRoot, dataDir }),
      },
    });
    report.plugins = result.plugins ?? [];
    for (const item of report.plugins) {
      const plan = plans.find((candidate) => candidate.plugin === item.plugin);
      lines.push(`[${item.plugin}] ${args.dryRun ? '计划' : '物化'} ${item.written} 个文件 → ${item.target}（skill ${plan.stats.skills} / 处理器 ${plan.stats.handlers}${plan.stats.syntheticRelayDrain ? '（含合成 UPS）' : ''} / 命令型 skill ${plan.stats.commandsGenerated}${item.pruned && item.pruned.length ? `；prune ${item.pruned.length} 个旧文件` : ''}）`);
      for (const problem of item.problems ?? []) {
        // 仓库级事实（`仓库级：…`）不加插件前缀——它不属于任一插件（2026-11-04 收尾评审 F1 修复 delta）。
        const scoped = problem.startsWith('仓库级：') ? problem : `${item.plugin}：${problem}`;
        report.problems.push(scoped);
        lines.push(`  ✗ ${scoped}`);
      }
    }
    if (result.agents) {
      report.agents = result.agents;
      // dry-run 不写盘（targets 必空），故份数与措辞都按「演算」口径走，避免输出
      // 「物化 0 份：a, b」这种自相矛盾（内部任务-295 复审 round2 N4）。
      const agentNames = result.agents.names ?? [];
      lines.push(`[agents] ${args.dryRun ? '计划' : '物化'} ${agentNames.length} 份：${agentNames.join(', ') || '（无）'}`);
      if (result.agents.dropped && result.agents.dropped.length > 0) lines.push(`  · 丢弃无对位工具（预期）：${result.agents.dropped.join(', ')}`);
      for (const problem of result.agents.problems ?? []) {
        report.problems.push(`agents：${problem}`);
        lines.push(`  ! ${problem}`);
      }
    }
    if (!result.ok) {
      report.ok = false;
      report.phase = result.phase ?? null;
      report.exitCode = result.exitCode ?? 1;
      report.message = result.message ?? null;
      report.backupRoot = result.backupRoot ?? null;
      report.warnings = result.warnings ?? [];
      for (const warning of report.warnings) lines.push(`  ! ${warning}`);
      for (const problem of result.problems ?? []) {
        report.problems.push(problem);
        lines.push(`  ✗ ${problem}`);
      }
      lines.push(result.message);
      process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${lines.join('\n')}\n`);
      return result.exitCode ?? 1;
    }
    report.ok = true;
    report.exitCode = 0;
    report.warnings = result.warnings ?? [];
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
    if (!args.dryRun) {
      lines.push('写后即验通过');
      // 内部决策-048：install 收尾行按在位分叉——宿主未检出时如实改口「数据面物化就绪」，
      // 防预装形态被误读为宿主装机生效（内部任务-121 教训）
      lines.push(hostApp.present
        ? 'install 完成：六包物化（宿主在位）'
        : 'install 完成（数据面物化就绪——宿主未检出，非宿主装机生效，宿主装机后自拾）：六包物化');
    } else {
      lines.push('dry-run 完成：零写入');
    }
  } else {
    for (const plan of plans) {
      const result = verifyPackage({ plan, dataDir });
      report.plugins.push({ plugin: plan.plugin, target: result.target, missing: result.missing, extra: result.extra, changed: result.changed, problems: result.problems, stats: plan.stats });
      lines.push(`[${plan.plugin}] 核对 ${result.target}：缺失 ${result.missing.length} / 多余 ${result.extra.length} / 变更 ${result.changed.length}`);
      for (const problem of result.problems) {
        report.problems.push(`${plan.plugin}：${problem}`);
        lines.push(`  ✗ ${problem}`);
      }
      for (const rel of result.missing) {
        report.problems.push(`${plan.plugin}：漂移 ${rel}`);
        lines.push(`  - 缺失 ${rel}`);
      }
      for (const rel of result.changed) {
        report.problems.push(`${plan.plugin}：漂移 ${rel}`);
        lines.push(`  - 变更 ${rel}`);
      }
      for (const rel of result.extra) {
        report.problems.push(`${plan.plugin}：多余文件 ${rel}`);
        lines.push(`  - 多余 ${rel}`);
      }
    }
    // G-03：verify 对「已安装的 agents 面」做只读核对，但**仅限带本层管理标记的项**——
    // 无标记＝未管理面（宿主内建/他源 agent），既不报多余也不参与 prune。目录不存在＝未安装，不算漂移；
    // 本命令不得产生任何宿主写副作用。problems 独立输出：零漂移时也不得静默（C3）。
    const agents = verifyAgents({ repoRoot, dataDir });
    if (agents.problems.length > 0) {
      report.agents = agents;
      for (const problem of agents.problems) {
        report.problems.push(`agents：${problem}`);
        lines.push(`  ! ${problem}`);
      }
    }
    if (agents.missing.length + agents.changed.length + agents.extra.length > 0) {
      report.agents = agents;
      lines.push(`[agents] 核对：缺失 ${agents.missing.length} / 多余 ${agents.extra.length} / 变更 ${agents.changed.length}`);
      for (const [key, label] of [['missing', '缺失'], ['changed', '变更'], ['extra', '多余']]) {
        for (const rel of agents[key]) {
          report.problems.push(`agents：${label} ${rel}`);
          lines.push(`  - ${label} ${rel}`);
        }
      }
    }
  }
  // agents 面安装告警历史上不阻断（映射后为空不装等为预期）；仅 install 保持该口径。
  const blocking = report.problems.filter((item) => !(args.command === 'install' && item.startsWith('agents：')));
  if (args.command !== 'install') {
    report.ok = blocking.length === 0;
    report.exitCode = report.ok ? 0 : 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
  return blocking.length > 0 ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    // `realpathSync` 必须做：经**符号链接路径**调用时（macOS `/tmp` → `/private/tmp`），不归一会让
    // 判等恒假 ⇒ `install`/`verify` **什么都不做却退 0**（静默绿，门 A 复核实跑发现；同族 内部任务-MACKEY-1）。
    return process.argv[1] ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href : false;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    // 写 stdout 后不得立即 exit（管道截断；内部任务-241 纪律，内部任务-333 对齐 kimi 先例）
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`安装器异常：${String(error && error.message ? error.message : error)}\n`);
    process.exitCode = 2; // catch 面亦不得立即 exit（内部任务-241 纪律，内部任务-333）
  }
}
