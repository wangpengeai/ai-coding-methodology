// 文件：kimi-code-adapter/cli.mjs
// 描述：Kimi Code 适配层安装器（内部决策-038 决策 1/2/7/9）。两个子命令：
//       · `install`——把六插件资产 + 适配层 shim + 引擎闭包 + 生成的 `kimi.plugin.json`
//         **物化**成六个包直写 `<宿主根>/plugins/managed/<id>/`，并直写登记
//         `<宿主根>/plugins/installed.json`（只增改六插件 id 条目，他条目不碰；写入前实样
//         结构校验，不符即拒写 fail-loud 并还原备份）。落盘前先生成计划并过宿主判据复刻
//         校验（清单/skill 文档面/hooks 四字段白名单/命令面 .md/路径包根内），任一越界即
//         拒写；逐文件原子落盘（临时名 + rename），**不删目录**——运行中会话可能正持有
//         钩子脚本路径（ZCode 2026-09-12 与 mcode 同款教训）。`--dry-run` 只报计划；
//         `--staging <目录>` 只产六包 + marketplace.json 走宿主官方通道兜底（不经
//         installed.json）；`--with-agents` 额外物化三份只读定位 agent（code-reviewer 工具面含 Bash，非纯只读；默认关，内部决策-038 决策 5）；
//         `--prune` 显式清理计划外旧文件（升级删除面收口，如 Python core）。
//         写完即验（完整 verify 面：sha256 对拍 + 引擎装载探针 + installed.json 双读），
//         漂移即回滚本次写入并退 1。备份：managed 既有副本 copy 式副本 `<id>.bak-<ts>`（原目录留位）、
//         installed.json 复制 `.bak`。幂等：重复 install 结果不变。
//       · `verify`——对已装包重算计划并逐文件比对 sha256，报缺失/多余/变更三类漂移；
//         引擎装载探针（「逐字节全等但不可装载」唯探针判红）；installed.json 双读
//         （六条目在场/enabled/root 指向现包）。`--staging` 时验 staged 布局（跳过登记腿）。
//         非零退出即红。
//       写面仅三处：managed/、installed.json（仅六插件条目）、--staging 目标目录；
//       六插件源目录**只读**（sha256/mtime 前后全等不变量进测试）。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 用法：node kimi-code-adapter/cli.mjs [install|verify] [--dry-run] [--staging <目录>]
//                            [--with-agents] [--prune] [--data-dir <路径>] [--repo-root <路径>] [--json]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isLocalArtifact, listSourceFiles } from './src/assets.mjs';
import { applyAgentGate, buildAgentDoc, convertAgentText } from './src/agents.mjs';
import { buildManifest, validatePackageCriteria } from './src/manifest.mjs';
import { validateHookEntries as validateHookShape } from './src/hook-template.mjs';
import { listEngineFiles } from './src/engine-files.mjs';
import { detectHostApp } from './src/host-presence.mjs';
import { resolveHostRoot } from './src/host-root.mjs';
import { resolveNode } from './src/node-resolve.mjs';
import { buildMarketplaceJson, validateMarketplaceJson } from './src/staging.mjs';
import { testSeam } from './src/test-seams.mjs';
import { translateHookDeclarations } from './src/hook-template.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 适配层自身根（物化 shim 的来源）。 */
const ADAPTER_ROOT = HERE;

/** 套件六插件（Kimi 侧保持 1:1 身份与可选安装粒度，内部决策-038 决策 1；algo-loop 2026-10-15 内部任务-90/内部决策-046、research-loop 2026-10-16 内部任务-109/内部决策-047 入套）。 */
export const PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);

/** 适配层自有的 shim 文件（物化进每个包的 kimi/）。 */
const SHIM_FILES = Object.freeze(['kimi/hook-shim.mjs', 'kimi/hook-lib.mjs', 'kimi/compact-workflow.mjs', 'kimi/relay-drain.mjs']);

/** 清单文件名（包根唯一事实源）。 */
const MANIFEST_REL = 'kimi.plugin.json';

/** 登记文件名（宿主实样结构；schema 无文档，以实样为契约——探针 P3/内部未决-69 收口）。 */
const REGISTRY_REL = join('plugins', 'installed.json');

/** managed 根相对宿主根的路径。 */
const MANAGED_REL = join('plugins', 'managed');

/** marketplace JSON 文件名（--staging 产物）。 */
const MARKETPLACE_FILE = 'marketplace.json';

/** 装载探针超时（毫秒）：引擎 import 挂起时兜底（否则 verify/写后即验无限等待）。 */
const PROBE_TIMEOUT_MS = 10_000;

/** install 直写登记条目时的 source 常量：本机实样的本地目录枚举值（探针 P3 已实测受理，内部未决-69 关闭 2026-10-05）。 */
export const INSTALLED_SOURCE = 'local-dir';

/** 中立清单文件名（期二换源后的唯一手工编辑面，内部决策-036）。 */
const MANIFEST_FILE = 'plugin.manifest.json';

/** 相对路径 → 平台路径。 */
function toPlatform(rel) {
  return rel.split('/').join(sep);
}

/**
 * 仓库根解析：显式参数 > 本文件上溯两级（本文件在 `<仓库根>/kimi-code-adapter/cli.mjs`）。
 * @param {string} [flag] 显式仓库根（空串即自动推导）
 * @returns {string} 仓库根绝对路径
 */
export function resolveRepoRoot(flag) {
  if (flag) return resolve(flag);
  return resolve(ADAPTER_ROOT, '..');
}

/**
 * 读面换源（内部决策-036 决策 6）：中立清单在场即权威；**缺失**才回落生成物 `hooks/hooks.json`
 * （兼容面）；清单**损坏 ≠ 缺失**——记 problem 不静默回落（否则陈旧生成物会把撤销过的钩子复活）。
 * @param {string} sourceRoot 插件根
 * @param {string[]} problems 计划问题收集面
 * @returns {{kind: 'manifest'|'artifact'|'none', hooks: unknown, manifest: object|null}} 声明源
 */
export function readHookSource(sourceRoot, problems) {
  const manifestPath = join(sourceRoot, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`中立清单损坏：${MANIFEST_FILE}（${error instanceof Error ? error.message : String(error)}）`);
      return { kind: 'none', hooks: undefined, manifest: null };
    }
    // 清单在场即权威：`hooks` 缺失或显式空数组都表示"零声明"，**不得**回落生成物；
    // 非数组是形态错误（不是零声明）——必须记 problem，否则整套钩子静默消失
    if (manifest.hooks === undefined) return { kind: 'manifest', hooks: [], manifest };
    if (!Array.isArray(manifest.hooks)) {
      problems.push(`中立清单 hooks 形态非法（须为数组）：${MANIFEST_FILE}`);
      return { kind: 'none', hooks: undefined, manifest };
    }
    if (manifest.hooks.length === 0) return { kind: 'manifest', hooks: [], manifest };
    return { kind: 'manifest', hooks: manifest.hooks, manifest };
  }
  const artifactPath = join(sourceRoot, 'hooks', 'hooks.json');
  if (existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      return { kind: 'artifact', hooks: artifact, manifest: null };
    } catch (error) {
      problems.push(`生成物钩子声明损坏：hooks/hooks.json（${error instanceof Error ? error.message : String(error)}）`);
      return { kind: 'none', hooks: undefined, manifest: null };
    }
  }
  return { kind: 'none', hooks: undefined, manifest: null };
}

/** 记录对象判定。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 生成物 `hooks/hooks.json`（ZCode 分组形态）→ 中立清单扁平 hooks 数组（兼容回落面的翻译适配；
 * 占位符 `${ZCODE_PLUGIN_ROOT}` 归一为中立 `${PLUGIN_ROOT}`——`scriptRelOf` 两形都认，统一只为核账一致）。
 * @param {object} artifactDoc 生成物解析结果
 * @returns {object[]} 扁平 hooks 数组
 */
export function artifactHooksToFlat(artifactDoc) {
  const out = [];
  if (!artifactDoc || !isRecord(artifactDoc.hooks)) {
    throw new Error('生成物 hooks 字段须为对象（hooks/hooks.json）');
  }
  const groups = artifactDoc.hooks;
  for (const [event, groupList] of Object.entries(groups)) {
    if (!Array.isArray(groupList)) continue;
    for (const group of groupList) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (!isRecord(handler)) continue;
        out.push({
          event,
          matcher: group.matcher,
          type: handler.type,
          command: handler.command,
          args: Array.isArray(handler.args) ? handler.args.map((a) => String(a).replaceAll('${ZCODE_PLUGIN_ROOT}', '${PLUGIN_ROOT}')) : [],
          timeoutMs: handler.timeoutMs,
          statusMessage: handler.statusMessage,
        });
      }
    }
  }
  return out;
}

/**
 * 组装单个包的物化计划（纯读盘 + 纯计算，不落盘）。
 * @param {{repoRoot: string, plugin: string, nodePath: string, withAgents?: boolean, engine?: object, hostInventory?: string[]}} input 输入
 * @returns {{plugin: string, files: {rel: string, bytes: Buffer}[], manifest: object, hooks: object[], problems: string[], stats: object, agents?: {names: string[], dropped: string[], skipped: string[]}}}
 */
export function planPackage(input) {
  const problems = [];
  const sourceRoot = join(input.repoRoot, input.plugin);
  const files = [];
  // ① 源资产（只读照搬；排除面见 assets.mjs——`.zcode-plugin/`、`node_modules/`、`hooks/hooks.json`）
  // 源资产含符号链接时 listSourceFiles 抛错——在本步捕获为 problem（不得落到顶层异常退 2）
  let sourceRels = [];
  try {
    sourceRels = listSourceFiles(sourceRoot);
  } catch (error) {
    problems.push(`源资产：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const rel of sourceRels) {
    files.push({ rel, bytes: readFileSync(join(sourceRoot, toPlatform(rel))) });
  }
  // ② 适配层自有 shim（源真值，逐字节拷贝进包）
  for (const rel of SHIM_FILES) {
    files.push({ rel, bytes: readFileSync(join(ADAPTER_ROOT, toPlatform(rel))) });
  }
  // ②b 引擎闭包（随包物化；目录层级复刻上游使 loadEngine(<包根>) 在包内成立）
  try {
    for (const entry of listEngineFiles(input.repoRoot)) files.push(entry);
  } catch (error) {
    problems.push(`引擎闭包：${error instanceof Error ? error.message : String(error)}`);
  }
  // ③ 中立清单取版本/描述/作者/keywords/interface（套件版本即插件版本，内部决策-017；本层不另抄）
  const manifestPath = join(sourceRoot, MANIFEST_FILE);
  let neutral = null;
  if (existsSync(manifestPath)) {
    try {
      neutral = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`中立清单损坏：${MANIFEST_FILE}（${error instanceof Error ? error.message : String(error)}）`);
    }
  } else {
    problems.push(`中立清单缺失：${input.plugin}/${MANIFEST_FILE}`);
  }
  // ④ agent 面（仅 --with-agents；默认关，内部决策-038 决策 5；挂装门控交引擎规则 fail-closed）
  // 门控恒调用（目录不可得时引擎 reject）；allowedTools 必须回写；单 agent 跳过是 warning，
  // 全部跳过才是 problem（--with-agents 请求未兑现）。
  const warnings = [];
  let agentsInfo;
  if (input.withAgents) {
    const agentsDir = join(sourceRoot, 'agents');
    const names = existsSync(agentsDir)
      ? readdirSync(agentsDir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort()
      : [];
    const dropped = [];
    const skipped = [];
    if (!input.engine) {
      problems.push('agent 门控引擎不可用（--with-agents 前置）');
    } else {
      for (const name of names) {
        const doc = convertAgentText(readFileSync(join(agentsDir, `${name}.md`), 'utf8'), name);
        for (const tool of doc.dropped) dropped.push(`${name}:${tool}`);
        if (doc.tools.length === 0) {
          skipped.push(`${name}（映射后工具白名单为空）`);
          continue;
        }
        const gate = applyAgentGate(input.engine, doc.tools, input.hostInventory);
        if (gate.reject === true) {
          skipped.push(`${name}（${String(gate.reason)}）`);
          continue;
        }
        const allowedTools = Array.isArray(gate.allowedTools) ? gate.allowedTools : doc.tools;
        files.push({ rel: `agents/${name}.md`, bytes: Buffer.from(buildAgentDoc({ ...doc.parts, tools: allowedTools }), 'utf8') });
      }
      if (names.length > 0 && names.length === skipped.length) {
        problems.push('--with-agents 请求未兑现：全部 agent 被拒挂（见 warnings）');
      }
    }
    agentsInfo = { names, dropped, skipped };
    for (const item of dropped) warnings.push(`agent 丢弃工具：${item}`);
    for (const item of skipped) warnings.push(`agent 跳过：${item}`);
  }
  // ⑤ 面在场判据（skills/commands 目录形声明的前置事实）
  const hasSkills = files.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.rel));
  const hasCommands = files.some((file) => file.rel.startsWith('commands/'));
  // ⑥ 钩子声明翻译（中立清单优先，生成物兼容回落）
  const hookSource = readHookSource(sourceRoot, problems);
  let flatHooks = hookSource.hooks;
  if (hookSource.kind === 'artifact') {
    try {
      flatHooks = artifactHooksToFlat(hookSource.hooks);
    } catch (error) {
      problems.push(`生成物钩子声明形态非法：hooks/hooks.json（${error instanceof Error ? error.message : String(error)}）`);
      flatHooks = [];
    }
  }
  const translated = translateHookDeclarations(flatHooks ?? [], { nodePath: input.nodePath, plugin: input.plugin });
  const hooks = translated.hooks;
  if (translated.stats.unresolved > 0) {
    problems.push(`钩子声明有 ${translated.stats.unresolved} 条未能翻译（脚本路径不可解析）`);
  }
  if (translated.stats.capped > 0) {
    problems.push(`钩子声明有 ${translated.stats.capped} 条 timeout 超宿主上限 600s，已封顶`);
  }
  // ⑦ 清单生成 + 判据复刻校验（坏包拒绝物化）
  const manifest = buildManifest({ plugin: input.plugin, manifest: neutral ?? {}, hasSkills, hasCommands, hooks });
  problems.push(...validatePackageCriteria({ manifest, files }).map((item) => `清单：${item}`));
  problems.push(...validateHookShape(hooks).map((item) => `hooks：${item}`));
  files.push({ rel: MANIFEST_REL, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    plugin: input.plugin,
    files,
    manifest,
    hooks,
    problems,
    warnings,
    agents: agentsInfo,
    stats: {
      files: files.length,
      handlers: translated.stats.handlers,
      skills: files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.rel)).length,
      commands: files.filter((file) => file.rel.startsWith('commands/') && file.rel.endsWith('.md')).length,
    },
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
  const tmp = `${target}.kimi-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    // 独占创建：预置同名链接/文件时直接失败（不覆写他人内容）
    writeFileSync(tmp, bytes, { flag: 'wx' });
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* tmp 清理失败不反噬主流程 */ }
    throw error;
  }
  try {
    // rename 经 retryFsOp（阶段复审①实测：AV/宿主并发读占用下 EPERM/EBUSY 瞬态可重试——
    // zcode-adapter/src/market.mjs 同款，避免装机链在文件锁上假红）
    retryFsOp(() => renameSync(tmp, target), `原子写 ${basename(target)}`);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 同上 */ }
    throw error;
  }
}

/**
 * 写面根/关键文件符号链接检查（只读；不存在视为通过）。
 * @param {string[]} paths 待检查路径
 * @returns {void}
 */
export function assertNoSymlinkPath(paths) {
  for (const path of paths) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(`写面为符号链接：${path}（迁移为实体目录后重跑 install，或删除该链接后重跑——安装器会重建该包）`);
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

/**
 * 目标文件父链符号链接检查（到包根为止；不存在的段跳过）。
 * @param {string} target 目标文件
 * @param {string} root 包根
 * @returns {void}
 */
function assertNoSymlinkAncestors(target, root) {
  const stop = resolve(root);
  let dir = dirname(resolve(target));
  for (;;) {
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        throw new Error(`写面父链为符号链接：${dir}（迁移为实体目录后重跑 install，或删除该链接后重跑——安装器会重建该包）`);
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
    }
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * 计划内文件的父目录集合（去重）：写前逐目录做链接检查（包内子目录链接不得写穿站外）。
 * @param {object[]} plans 物化计划
 * @param {string} targetRoot 目标根
 * @returns {string[]} 待检查目录
 */
function planAncestorDirs(plans, targetRoot) {
  const dirs = new Set();
  for (const plan of plans) {
    const pkgRoot = join(targetRoot, plan.plugin);
    for (const file of plan.files) {
      let dir = dirname(join(pkgRoot, toPlatform(file.rel)));
      while (dir.length > pkgRoot.length) {
        dirs.add(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return [...dirs];
}

/** 同步睡（Atomics.wait——无定时器线程开销，zcode-adapter/src/market.mjs 同款）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 瞬时锁退避重试：EPERM/EBUSY/EACCES（Windows 上目录被运行中宿主会话/AV 短暂占用——
 * zcode-adapter 侧 内部任务-RELEASE-058 实测形态）。非可重试错误与耗尽后如实抛出。
 * @param {() => void} op 文件操作
 * @param {string} label 诊断标签
 */
function retryFsOp(op, label) {
  const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const DELAYS = [200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try {
      op();
      return;
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : '';
      if (!RETRYABLE.has(code) || attempt >= DELAYS.length) {
        throw new Error(`${label} 失败（${code || '未知错误码'}）：${error instanceof Error ? error.message : String(error)}`);
      }
      sleepSync(DELAYS[attempt]);
    }
  }
}

/**
 * 备份既有 managed 副本（**copy 式**：原目录留位——「不删目录」对运行中会话钩子路径的
 * 保护；rename 会把 managed/<id>/ 整目录移走制造路径真空，zcode-adapter/src/install.mjs
 * copy 式先例）与登记（复制 `.bak`）。
 * @param {string} managedRoot managed 根目录
 * @param {string} registryPath installed.json 绝对路径
 * @param {string[]} plugins 插件 id 清单
 * @param {string | number} ts 时间戳段（备份目录名后缀）
 * @returns {{backups: Map<string, string>, registryBackup: string|null}} 备份账
 */
export function backupExisting(managedRoot, registryPath, plugins, ts) {
  const backups = new Map();
  let registryBackup = null;
  try {
    for (const plugin of plugins) {
      const dir = join(managedRoot, plugin);
      if (existsSync(dir)) {
        const bak = `${dir}.bak-${ts}`;
        retryFsOp(() => cpSync(dir, bak, { recursive: true }), `备份 ${plugin}`);
        backups.set(plugin, bak);
      }
    }
    if (existsSync(registryPath)) {
      registryBackup = `${registryPath}.bak-${ts}`;
      retryFsOp(() => copyFileSync(registryPath, registryBackup), '备份登记');
    }
  } catch (error) {
    // 中途失败自清已产出 .bak（调用方拿不到局部账——不留孤儿副本）；copy 式下原目录原位未动
    for (const bak of backups.values()) rmSync(bak, { recursive: true, force: true });
    if (registryBackup !== null) rmSync(registryBackup, { force: true });
    throw error;
  }
  return { backups, registryBackup };
}

/**
 * 回滚本次写入：还原 managed 备份（cp 对称还原，.bak 留待 cleanupBackups 统一清）、
 * 还原登记（本次新建则移除）。**整体容错**：单个插件的还原失败不中断其余还原，
 * 失败项保留 .bak 并计入 failures（人工恢复指引由调用方输出）。
 * @param {string} managedRoot managed 根目录
 * @param {string} registryPath installed.json 绝对路径
 * @param {Map<string, string>} backups backupExisting 的备份账
 * @param {string|null} registryBackup 登记备份路径（null=本次新建）
 * @returns {{ok: boolean, failures: string[]}} 回滚结论
 */
export function rollbackWrite(managedRoot, registryPath, backups, registryBackup) {
  const failures = [];
  for (const [plugin, bak] of backups) {
    try {
      // 测试缝：rollbackFail=1 时首个还原步注入失败（仅测试态——「回滚失败保留 .bak」路径的
      // 判别力；缝名与环境变量映射见 src/test-seams.mjs 登记表）。
      if (testSeam('rollbackFail')) throw new Error('rollbackFail 注入的回滚失败（测试缝）');
      const dir = join(managedRoot, plugin);
      retryFsOp(() => rmSync(dir, { recursive: true, force: true }), `回滚清理 ${plugin}`);
      retryFsOp(() => cpSync(bak, dir, { recursive: true }), `回滚还原 ${plugin}`);
    } catch (error) {
      failures.push(`${plugin}：${error instanceof Error ? error.message : String(error)}（备份保留在 ${bak}）`);
    }
  }
  for (const plugin of PLUGINS) {
    if (backups.has(plugin)) continue;
    try {
      retryFsOp(() => rmSync(join(managedRoot, plugin), { recursive: true, force: true }), `回滚移除新建 ${plugin}`);
    } catch (error) {
      failures.push(`${plugin}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    if (registryBackup !== null) retryFsOp(() => copyFileSync(registryBackup, registryPath), '回滚登记');
    else retryFsOp(() => rmSync(registryPath, { force: true }), '移除新建登记');
  } catch (error) {
    failures.push(`登记：${error instanceof Error ? error.message : String(error)}${registryBackup !== null ? `（备份保留在 ${registryBackup}）` : ''}`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * 清理备份：仅「安装成功」与「回滚完整成功」两条路径调用——回滚失败路径**保留** .bak
 * 供人工恢复（zcode-adapter/src/install.mjs 同款姿态）；清理失败不反噬结果（.bak 留存无害）。
 * @param {Map<string, string>} backups backupExisting 的备份账
 * @param {string|null} registryBackup 登记备份路径
 * @returns {void}
 */
export function cleanupBackups(backups, registryBackup) {
  for (const bak of backups.values()) {
    try {
      retryFsOp(() => rmSync(bak, { recursive: true, force: true }), '清理备份');
    } catch { /* .bak 留存无害 */ }
  }
  if (registryBackup !== null) {
    try {
      retryFsOp(() => rmSync(registryBackup, { force: true }), '清理登记备份');
    } catch { /* 同上 */ }
  }
}

/**
 * 登记结构实样校验（内部决策-038 决策 9：以本机实样为写入契约，不符即拒写 fail-loud，不静默猜写）。
 * @param {unknown} doc 登记解析结果
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateRegistryShape(doc) {
  const problems = [];
  const warnings = [];
  if (!isRecord(doc)) return { problems: ['installed.json 顶层须为对象'], warnings };
  if (typeof doc.version !== 'number') problems.push('installed.json version 须为 number');
  if (!Array.isArray(doc.plugins)) problems.push('installed.json plugins 须为数组');
  else {
    for (const entry of doc.plugins) {
      if (!isRecord(entry)) {
        problems.push('登记条目须为对象');
        continue;
      }
      const label = typeof entry.id === 'string' && entry.id !== '' ? entry.id : '#index';
      // 六插件条目严格（写入契约）；他插件/宿主自有条目只提示不阻断（写面纪律＝只动六条目）
      const push = PLUGINS.includes(entry.id) ? problems : warnings;
      for (const key of ['id', 'root', 'source', 'installedAt', 'updatedAt']) {
        if (typeof entry[key] !== 'string' || entry[key] === '') push(`登记条目 ${label} 缺 ${key}（string）`);
      }
      if (typeof entry.enabled !== 'boolean') push(`登记条目 ${label} enabled 须为 boolean`);
      if (entry.originalSource !== undefined && typeof entry.originalSource !== 'string') push(`登记条目 ${label} originalSource 须为 string`);
    }
  }
  return { problems, warnings };
}

/**
 * 读登记（缺失 → 空登记骨架；损坏 → problems 非空）。
 * @param {string} registryPath 登记绝对路径
 * @returns {{doc: object, problems: string[]}}
 */
export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return { doc: { version: 1, plugins: [] }, problems: [], warnings: [] };
  try {
    const doc = JSON.parse(readFileSync(registryPath, 'utf8'));
    const { problems, warnings } = validateRegistryShape(doc);
    return { doc, problems, warnings };
  } catch (error) {
    return { doc: { version: 1, plugins: [] }, problems: [`installed.json 不可解析：${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
}

/**
 * upsert 六插件条目（只增改六 id，他条目不碰；root=绝对路径；时间戳 ISO）。
 * @param {object} doc 登记文档
 * @param {{managedRoot: string, now: string}} input 落点与时间
 * @returns {object} 新登记文档（不改原对象）
 */
export function upsertEntries(doc, input) {
  const plugins = Array.isArray(doc.plugins) ? [...doc.plugins] : [];
  for (const id of PLUGINS) {
    const idx = plugins.findIndex((item) => isRecord(item) && item.id === id);
    const prev = idx >= 0 && isRecord(plugins[idx]) ? plugins[idx] : null;
    const entry = {
      // 保留宿主既有字段（originalSource 与其他未知键），只更新本层负责的键
      ...(prev ?? {}),
      id,
      root: join(input.managedRoot, id),
      source: INSTALLED_SOURCE,
      enabled: typeof prev?.enabled === 'boolean' ? prev.enabled : true,
      installedAt: typeof prev?.installedAt === 'string' && prev.installedAt !== '' ? prev.installedAt : input.now,
      updatedAt: input.now,
    };
    if (idx >= 0) plugins[idx] = entry;
    else plugins.push(entry);
  }
  return { ...doc, version: typeof doc.version === 'number' ? doc.version : 1, plugins };
}

/**
 * 清理已装包内不在当前计划中的文件（仅显式 `--prune`）：默认不删目录的保护姿态不变，
 * 升级后旧版本残留（如 Python core 删除面）由用户显式 prune 收口。
 * 本地产物与临时文件保留。
 * @param {string} target 包根
 * @param {Set<string>} planned 计划内包相对路径
 * @returns {string[]} 已删除的相对路径
 */
export function pruneExtras(target, planned) {
  const removed = [];
  let lockInjected = false;
  const unlinkWithRetry = (child, rel) => {
    retryFsOp(() => {
      // 测试缝：注入一次 EPERM（Windows 文件锁形态），验证退避重试路径
      if (testSeam('pruneLock') && !lockInjected) {
        lockInjected = true;
        const injected = new Error('pruneLock 注入的文件锁（测试缝）');
        injected.code = 'EPERM';
        throw injected;
      }
      unlinkSync(child);
    }, `prune ${rel}`);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      const rel = relative(target, child).split(sep).join('/');
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        // 链接只删链接本身，绝不递归进链接目标（沿链删会毁损站外文件）
        if (!planned.has(rel) && !isLocalArtifact(rel) && !rel.includes('.kimi-tmp-')) {
          unlinkWithRetry(child, rel);
          removed.push(rel);
        }
        continue;
      }
      if (stat.isDirectory()) { walk(child); continue; }
      if (isLocalArtifact(rel) || rel.includes('.kimi-tmp-')) continue;
      if (!planned.has(rel)) {
        unlinkWithRetry(child, rel);
        removed.push(rel);
      }
    }
  };
  if (existsSync(target)) walk(target);
  return removed.sort();
}

/**
 * 物化单个包（逐文件原子落盘；`--prune` 时清理计划外旧文件）。
 * @param {{plan: object, targetRoot: string, prune?: boolean}} input 输入
 * @returns {{plugin: string, target: string, written: number, pruned: string[]}}
 */
export function installPackageFiles(input) {
  const target = join(input.targetRoot, input.plan.plugin);
  for (const file of input.plan.files) {
    const abs = join(target, toPlatform(file.rel));
    assertNoSymlinkAncestors(abs, target);
    writeFileAtomic(abs, file.bytes);
  }
  const pruned = input.prune ? pruneExtras(target, new Set(input.plan.files.map((file) => file.rel))) : [];
  return { plugin: input.plan.plugin, target, written: input.plan.files.length, pruned };
}

/**
 * 在物化包上真实装载一次引擎（装载探针）：「逐字节全等但不可装载」唯探针判红。
 * `loadEngine` 收**包根**（契约 `join(repoRoot,'plugin-core',file)`）。
 * @param {string} target 物化包根
 * @returns {string|null} 失败描述；通过时 null
 */
export function probeEngineInPackage(target) {
  const entry = join(target, 'plugin-core', 'src', 'engine.mjs');
  if (!existsSync(entry)) return `装载探针：缺少引擎入口 ${entry}`;
  const script = `import(${JSON.stringify(pathToFileURL(entry).href)}).then((m) => { const e = m.loadEngine(${JSON.stringify(target)}); if (typeof e.applyRule !== 'function') throw new Error('applyRule 缺失'); const probe = e.applyRule('source-widen-normalize', 'kimi', { source: 'resume' }); if (probe.result !== 'resume') throw new Error('kimi 规则探针异常'); }).catch((e) => { process.stderr.write(String(e && e.message)); process.exit(3); });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  if (r.status === 0) return null;
  const reason = r.error
    ? `spawn 失败（${String(r.error.code ?? r.error.message ?? '未知')}）`
    : (r.signal ? `被信号终止（${String(r.signal)}）` : `退出 ${String(r.status)}`);
  return `装载探针失败（${reason}）：${String(r.stderr ?? '').split('\n')[0].slice(0, 300)}`;
}

/**
 * 核对一个已装包与当前计划的漂移（缺失/多余/变更 + 装载探针）。
 * @param {{plan: object, targetRoot: string}} input 输入
 * @returns {{plugin: string, target: string, missing: string[], extra: string[], changed: string[], probe: string|null}}
 */
export function verifyPackageFiles(input) {
  const target = join(input.targetRoot, input.plan.plugin);
  const missing = [];
  const changed = [];
  if (!existsSync(target)) {
    return { plugin: input.plan.plugin, target, missing: ['<整包缺失>'], extra: [], changed: [], probe: null };
  }
  const planned = new Map(input.plan.files.map((file) => [file.rel, file.bytes]));
  for (const [rel, bytes] of planned) {
    const abs = join(target, toPlatform(rel));
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    try {
      if (!readFileSync(abs).equals(bytes)) changed.push(rel);
    } catch {
      changed.push(rel); // 不可读文件按漂移报（不抛顶层异常）
    }
  }
  const extra = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        // 链接不是计划内的常规文件：计划内路径判变更，计划外判多余（不跟随链接读内容）
        const rel = relative(target, child).split(sep).join('/');
        if (planned.has(rel)) changed.push(rel);
        else if (!isLocalArtifact(rel) && !rel.includes('.kimi-tmp-')) extra.push(rel);
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
        continue;
      }
      const rel = relative(target, child).split(sep).join('/');
      if (isLocalArtifact(rel)) continue; // 与计划侧同谓词剪枝：已装包内的历史本地产物残留不算漂移
      if (!planned.has(rel) && !rel.includes('.kimi-tmp-')) extra.push(rel);
    }
  };
  walk(target);
  // 装载探针：sha256 只证「字节等于计划」，证不了「可装载」——探针失败即漂移
  const probe = missing.length === 0 && changed.length === 0 ? probeEngineInPackage(target) : null;
  return { plugin: input.plan.plugin, target, missing: missing.sort(), extra: extra.sort(), changed: changed.sort(), probe };
}

/**
 * installed.json 双读核对（直接模式的 verify 腿）：六条目在场、enabled、root 指向现包、结构实样合规。
 * @param {{registryPath: string, managedRoot: string}} input 输入
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function verifyRegistry(input) {
  const problems = [];
  const warnings = [];
  const { doc, problems: readProblems, warnings: readWarnings } = readRegistry(input.registryPath);
  problems.push(...readProblems);
  warnings.push(...readWarnings);
  if (readProblems.length > 0) return { problems, warnings };
  for (const id of PLUGINS) {
    const entry = doc.plugins.find((item) => isRecord(item) && item.id === id);
    if (!entry) {
      problems.push(`installed.json 缺 ${id} 条目`);
      continue;
    }
    // enabled:false 视为宿主侧有意态（用户在宿主面板禁用）——记 warning 不计问题
    if (entry.enabled !== true) warnings.push(`installed.json ${id} 条目 enabled 非 true（宿主侧有意态，不计问题）`);
    if (resolve(entry.root) !== resolve(join(input.managedRoot, id))) problems.push(`installed.json ${id} 条目 root 未指向现包：${String(entry.root)}`);
  }
  return { problems, warnings };
}

/**
 * 组装 verify 报告（install 写后即验与 verify 子命令共用）。
 * @param {{plans: object[], targetRoot: string, registryPath: string|null, managedRoot: string}} input 输入
 * @returns {{plugins: object[], problems: string[]}}
 */
export function runVerify(input) {
  const problems = [];
  const warnings = [];
  const plugins = [];
  for (const plan of input.plans) {
    const report = verifyPackageFiles({ plan, targetRoot: input.targetRoot });
    plugins.push(report);
    for (const rel of report.missing) problems.push(`${plan.plugin}：缺失 ${rel}`);
    for (const rel of report.changed) problems.push(`${plan.plugin}：变更 ${rel}`);
    for (const rel of report.extra) problems.push(`${plan.plugin}：多余 ${rel}`);
    if (report.probe !== null) problems.push(`${plan.plugin}：${report.probe}`);
  }
  if (input.registryPath !== null) {
    const registry = verifyRegistry({ registryPath: input.registryPath, managedRoot: input.managedRoot });
    problems.push(...registry.problems);
    warnings.push(...registry.warnings);
  }
  return { plugins, problems, warnings };
}

/**
 * 加载宿主工具目录（矩阵 `capabilities.hostToolInventory.kimi`，agent 挂装门控的目录端口面）。
 * @param {string} repoRoot 仓库根
 * @returns {string[]|null} 24 词词表；缺失/损坏返回 null（门控 fail-closed）
 */
function loadHostInventory(repoRoot) {
  try {
    const matrix = JSON.parse(readFileSync(join(repoRoot, 'plugin-core', 'capability-matrix.json'), 'utf8'));
    // hostToolInventory 是「宿主 → 词表数组」的映射（capability-matrix.json 的实际形态）
    const inventory = matrix && matrix.capabilities ? matrix.capabilities.hostToolInventory : null;
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return null;
    return Array.isArray(inventory.kimi) ? inventory.kimi : null;
  } catch {
    return null;
  }
}

/** 加载规则引擎（仓库 plugin-core；--with-agents 的挂装门控用）。 */
async function loadRepoEngine(repoRoot) {
  const { loadEngine } = await import(pathToFileURL(join(repoRoot, 'plugin-core', 'src', 'engine.mjs')).href);
  return loadEngine(repoRoot);
}

/** 用法与参数解析（未知参数收集到 rest，由主流程退 2 指路）。 */
function parseArgs(argv) {
  const args = { command: 'install', commandExplicit: false, dryRun: false, withAgents: false, prune: false, json: false, staging: '', dataDir: '', repoRoot: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === 'install' || token === 'verify') { args.command = token; args.commandExplicit = true; }
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--with-agents') args.withAgents = true;
    else if (token === '--prune') args.prune = true;
    else if (token === '--json') args.json = true;
    else if (token === '--staging' || token === '--data-dir' || token === '--repo-root') {
      // 值旗标必须带非 `--` 起头的值——缺值或值形如旗标即入 rest（调用方退 2，防「值旗标
      // 吞掉后续旗标/缺值落真机宿主根」把用法错降级为业务红；zcode-adapter/cli.mjs 评审 C2 同源）。
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) {
        rest.push(token);
      } else {
        if (token === '--staging') args.staging = v;
        else if (token === '--data-dir') args.dataDir = v;
        else args.repoRoot = v;
        i += 1;
      }
    }
    else if (token === '--help' || token === '-h') { args.command = 'help'; args.commandExplicit = true; }
    else rest.push(token);
  }
  args.rest = rest;
  return args;
}

const USAGE = '用法：node kimi-code-adapter/cli.mjs <install|verify> [旗标]\n'
  + '  install：--dry-run --staging <目录> --with-agents --prune --data-dir <路径> --repo-root <路径> --json\n'
  + '  verify ：--staging <目录> --with-agents --data-dir <路径> --repo-root <路径> --json\n'
  + '  退出码：0 绿 / 1 漂移·失败 / 2 用法错·环境缺失；无参退 2；旗标缺值或值形如旗标退 2\n';

/** 主流程（返回退出码）。 */
async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  // 早期失败（用法错/环境缺失）统一出口：`--json` 下 stdout 恒为合法 JSON（形状与正常报告同源）
  const fail = (message, { usage = true } = {}) => {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        command: args.command,
        mode: args.staging ? 'staging' : 'direct',
        hostRoot: null,
        targetRoot: args.staging ? resolve(args.staging) : null,
        repoRoot: null,
        node: null,
        staging: args.staging ? resolve(args.staging) : '',
        hostApp: null,
        plugins: [],
        problems: [message],
        warnings: [],
        pruned: [],
        ok: false,
        exitCode: 2,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(usage ? `${message}\n${USAGE}` : `${message}\n`);
    }
    return 2;
  };
  // 无参即打印用法退 2（阶段复审① F6：对齐 mcode/zcode/plugin-core——缺省 install 会在误触时
  // 向真机宿主根完整落盘；更安全方向）。
  if (argv.length === 0) {
    return fail('用法错：缺子命令（install|verify）', { usage: false });
  }
  // **只带旗标不带子命令同样退 2**：缺省 install 会向真机宿主根完整落盘（含 --prune 删计划外文件），
  // 「零参退 2」只堵了空 argv 一种形态（2026-11-03 内部任务-305 终审发现）。
  if (!args.commandExplicit) {
    return fail('用法错：缺子命令（install|verify）', { usage: false });
  }
  if (args.rest.length > 0) {
    return fail(`无法识别的参数：${args.rest.join(' ')}`);
  }
  // 旗标矩阵（禁静默忽略，zcode 适配层 FLAG_MATRIX 同款）：verify 不接受写面旗标
  if (args.command === 'verify' && (args.prune || args.dryRun)) {
    return fail('verify 不接受 --prune/--dry-run（旗标矩阵）');
  }
  const repoRoot = resolveRepoRoot(args.repoRoot);
  const stagingDir = args.staging ? resolve(args.staging) : '';
  const hostRoot = stagingDir !== '' ? stagingDir : resolveHostRoot(args.dataDir);
  if (hostRoot === '') {
    return fail('无法确定宿主根：请用 --data-dir 指定（或设 KIMI_CODE_HOME）。', { usage: false });
  }
  const node = resolveNode();
  if (!node) {
    return fail('未解析到可执行的 node：宿主不为钩子注入独立 Node，本层必须写入绝对解释器路径。\n请安装 Node.js 或修好 PATH 后重跑。', { usage: false });
  }
  // 计划生成（六包共用一次引擎/目录装载）
  let engine = null;
  let hostInventory = null;
  if (args.withAgents) {
    try {
      engine = await loadRepoEngine(repoRoot);
      hostInventory = loadHostInventory(repoRoot);
    } catch (error) {
      return fail(`规则引擎装载失败（--with-agents 门控前置）：${error instanceof Error ? error.message : String(error)}`, { usage: false });
    }
  }
  const plans = PLUGINS.map((plugin) => planPackage({ repoRoot, plugin, nodePath: node.path, withAgents: args.withAgents, engine, hostInventory }));
  const hostApp = detectHostApp(); // 内部决策-048：与 assurance 探针同库两独立读取者；不阻断安装
  const lines = [];
  const report = {
    command: args.command,
    mode: stagingDir !== '' ? 'staging' : 'direct',
    hostRoot,
    targetRoot: stagingDir !== '' ? stagingDir : join(hostRoot, ...MANAGED_REL.split(sep)),
    repoRoot,
    node,
    staging: stagingDir,
    hostApp,
    plugins: [],
    problems: [],
    warnings: [],
    pruned: [],
    ok: false,
    exitCode: null,
  };
  // 仓库根预检：插件源目录与引擎源缺失 → 记 problem（不撞顶层 ENOENT 异常）
  for (const plugin of PLUGINS) {
    if (!existsSync(join(repoRoot, plugin))) report.problems.push(`${plugin}：插件源缺失（--repo-root 下无该目录）`);
  }
  if (!existsSync(join(repoRoot, 'plugin-core'))) report.problems.push('plugin-core：引擎源缺失（--repo-root 下无该目录）');
  lines.push(`宿主根：${hostRoot}`);
  lines.push(`仓库根：${repoRoot}`);
  lines.push(`解释器：${node.path}（来源 ${node.source}）`);
  lines.push(hostApp.present
    ? `宿主应用：在位（${hostApp.hit}）`
    : `宿主应用：未检出（${hostApp.reason ?? `候选：${hostApp.candidates.join('；')}均不存在`}；装在别处请设 KIMI_APP_ROOT）`);
  for (const plan of plans) {
    lines.push(`[${plan.plugin}] 计划物化 ${plan.files.length} 个文件（skill ${plan.stats.skills} / 命令 ${plan.stats.commands} / 处理器 ${plan.stats.handlers}）`);
    for (const problem of plan.problems) {
      report.problems.push(`${plan.plugin}：${problem}`);
      lines.push(`  ✗ ${problem}`);
    }
    for (const warning of plan.warnings ?? []) {
      report.warnings.push(`${plan.plugin}：${warning}`);
      lines.push(`  ⚠ ${warning}`);
    }
  }
  // prune 删除清单（可见性面）：收集被删路径并在人类输出与 --json 报告同源呈现
  const prunedAll = [];
  const collectPruned = (plan, result) => {
    for (const rel of result.pruned ?? []) prunedAll.push({ plugin: plan.plugin, rel });
  };
  const emitPruned = () => {
    report.pruned = prunedAll;
    if (prunedAll.length === 0) return;
    lines.push(`prune：清理计划外文件 ${prunedAll.length} 个`);
    for (const item of prunedAll.slice(0, 20)) lines.push(`  - ${item.plugin}/${item.rel}`);
    if (prunedAll.length > 20) lines.push(`  …（其余 ${prunedAll.length - 20} 项见 --json 报告）`);
    if (prunedAll.some((item) => item.rel.startsWith('agents/'))) {
      const note = '--prune 移除了 --with-agents 安装面；如需保留请带 --with-agents 重跑';
      report.warnings.push(note);
      lines.push(`  ⚠ ${note}`);
    }
  };
  // --with-agents 配对提示：agents 面不在当前计划集内 ⇒ 多余漂移（提示三条出路，不静默）
  const agentPairingHint = (plugin) => {
    if (args.withAgents) return null;
    if (!plugin || !Array.isArray(plugin.extra) || plugin.extra.length === 0) return null;
    if (!plugin.extra.every((rel) => rel.startsWith('agents/'))) return null;
    return `${plugin.plugin}：检测到已装 agents 面——请带 --with-agents 复核，或用 --prune 移除，或手工删除 managed/${plugin.plugin}/agents`;
  };
  // 统一出口：人类输出与 --json 报告同源（ok/exitCode 由收尾处计算）
  const finish = (code) => {
    report.ok = code === 0;
    report.exitCode = code;
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${lines.join('\n')}\n`);
    return code;
  };
  if (stagingDir !== '' && args.dataDir !== '') {
    report.warnings.push(`staging 模式忽略 --data-dir：${args.dataDir}`);
    lines.push(`  ⚠ staging 模式忽略 --data-dir：${args.dataDir}`);
  }
  if (args.command === 'verify') {
    if (stagingDir !== '') {
      const marketPath = join(stagingDir, MARKETPLACE_FILE);
      let marketProblems = ['marketplace.json 缺失'];
      if (existsSync(marketPath)) {
        try {
          marketProblems = validateMarketplaceJson(JSON.parse(readFileSync(marketPath, 'utf8')));
        } catch (error) {
          marketProblems = [`marketplace.json 不可解析：${error instanceof Error ? error.message : String(error)}`];
        }
      }
      const verified = runVerify({ plans, targetRoot: stagingDir, registryPath: null, managedRoot: '' });
      report.plugins = verified.plugins;
      report.problems.push(...marketProblems.map((item) => `marketplace：${item}`), ...verified.problems);
    } else {
      const managedRoot = join(hostRoot, ...MANAGED_REL.split(sep));
      const verified = runVerify({ plans, targetRoot: managedRoot, registryPath: join(hostRoot, ...REGISTRY_REL.split(sep)), managedRoot });
      report.plugins = verified.plugins;
      report.problems.push(...verified.problems);
      for (const warning of verified.warnings ?? []) {
        report.warnings.push(warning);
        lines.push(`  ⚠ ${warning}`);
      }
    }
    for (const plugin of report.plugins) {
      lines.push(`[${plugin.plugin}] 核对 ${plugin.target}：缺失 ${plugin.missing.length} / 多余 ${plugin.extra.length} / 变更 ${plugin.changed.length}`);
      for (const rel of plugin.missing) lines.push(`  - 缺失 ${rel}`);
      for (const rel of plugin.changed) lines.push(`  - 变更 ${rel}`);
      for (const rel of plugin.extra) lines.push(`  - 多余 ${rel}`);
      const hint = agentPairingHint(plugin);
      if (hint) {
        report.warnings.push(hint);
        lines.push(`  ⚠ ${hint}`);
      }
    }
    for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
    return finish(report.problems.length > 0 ? 1 : 0);
  }
  // install 面
  if (args.dryRun) {
    lines.push('（dry-run：不落盘）');
    report.plan = plans.map((plan) => ({
      plugin: plan.plugin,
      fileCount: plan.files.length,
      files: plan.files.map((file) => file.rel),
      stats: plan.stats,
      problems: plan.problems,
      warnings: plan.warnings ?? [],
    }));
    return finish(report.problems.length > 0 ? 1 : 0);
  }
  if (report.problems.length > 0) {
    return finish(1);
  }
  if (stagingDir !== '') {
    // --staging：写面只有目标目录（六包 + marketplace.json），不经 installed.json。
    // marketplace displayName 消费已规划包清单（内部任务-5 B，R-ka-10：包/市场展示同源自中立清单）
    try {
      // 写面链接拒装（与直写同款）：staging 目标根与包内父链
      assertNoSymlinkPath([stagingDir, ...PLUGINS.map((id) => join(stagingDir, id)), ...planAncestorDirs(plans, stagingDir)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.problems.push(message);
      lines.push(`  ✗ ${message}`);
      process.stderr.write(`${message}\n`);
      return finish(2);
    }
    try {
      for (const plan of plans) collectPruned(plan, installPackageFiles({ plan, targetRoot: stagingDir, prune: args.prune }));
      const marketDoc = buildMarketplaceJson(plans.map((plan) => ({ id: plan.plugin, manifest: plan.manifest })));
      writeFileAtomic(join(stagingDir, MARKETPLACE_FILE), Buffer.from(`${JSON.stringify(marketDoc, null, 2)}\n`, 'utf8'));
      const staged = runVerify({ plans, targetRoot: stagingDir, registryPath: null, managedRoot: '' });
      report.plugins = staged.plugins;
      report.problems.push(...staged.problems);
      for (const warning of staged.warnings ?? []) {
        report.warnings.push(warning);
        lines.push(`  ⚠ ${warning}`);
      }
      lines.push(`staging → ${stagingDir}（六包 + marketplace.json，立即 staged verify）`);
      for (const problem of staged.problems) lines.push(`  ✗ ${problem}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.problems.push(`staging 写入失败：${message}`);
      lines.push(`  ✗ staging 写入失败：${message}`);
      const halfNote = 'staging 目录可能处于半成品状态（安装器不清理已写内容）';
      report.warnings.push(halfNote);
      lines.push(`  ⚠ ${halfNote}`);
      emitPruned(); // 删除清单同源进报告（--json 消费方须知道装了什么、删了什么）
      // 链接类拒装与直写同款退 2（其余按业务失败退 1）
      return finish(message.includes('符号链接') ? 2 : 1);
    }
    emitPruned();
    return finish(report.problems.length > 0 ? 1 : 0);
  }
  // 直写模式：备份 → 原子落盘 managed/ → 登记校验+upsert+原子写 → 写后即验（漂移回滚）
  const managedRoot = join(hostRoot, ...MANAGED_REL.split(sep));
  const registryPath = join(hostRoot, ...REGISTRY_REL.split(sep));
  try {
    // 写面根/包根/登记/包内父链的符号链接拒装（防沿链接写穿站外；检查在备份之前 ⇒ 统一退 2）
    assertNoSymlinkPath([
      managedRoot,
      dirname(managedRoot),
      ...PLUGINS.map((id) => join(managedRoot, id)),
      registryPath,
      ...planAncestorDirs(plans, managedRoot),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.problems.push(message);
    lines.push(`  ✗ ${message}`);
    process.stderr.write(`${message}
`);
    return finish(2);
  }
  mkdirSync(managedRoot, { recursive: true });
  mkdirSync(dirname(registryPath), { recursive: true });
  // install 互斥锁（内部任务-347/内部未决-273）：锁文件在 managed/ 父目录（不进包清单、不进 pruneExtras
  // 走查面——其走查只按 managed/<id>/ 包目录）；新鲜锁（<5min）视为他方持锁退 2，stale（≥5min）
  // 强占（unlink→O_EXCL 重建，败者退 2——持有方慢盘/杀软扫描超 5min 被强占的双并发残余由下方
  // 写前重读第二道门承接）；持锁方硬崩溃遗留由 stale 强占＋install 幂等自愈。
  const lockPath = join(dirname(managedRoot), 'install.lock');
  const lockStaleMs = 5 * 60 * 1000;
  try {
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      let stale = true;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs >= lockStaleMs;
      } catch (statError) {
        // stat 失败（如并发方恰在此时删除锁）不吞 ReferenceError——只吞真实 fs 错误并取保守 stale
        if (!(statError && typeof statError.code === 'string')) throw statError;
      }
      if (!stale) {
        const message = `另一 install 进行中（install.lock 新鲜持有）——本进程拒绝并发写，稍后重试`;
        process.stderr.write(`${message}\n`);
        report.problems.push(message);
        lines.push(`  ✗ ${message}`);
        return finish(2);
      }
      process.stderr.write(`install.lock 已陈旧（≥5min），强占继续\n`);
      try { rmSync(lockPath, { force: true }); } catch { /* 败者由 O_EXCL 定胜负 */ }
      try {
        writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
      } catch (error2) {
        const message = `install.lock 强占竞争失败（他方先到）——本进程退出`;
        process.stderr.write(`${message}\n`);
        report.problems.push(message);
        lines.push(`  ✗ ${message}`);
        return finish(2);
      }
    } else {
      throw error;
    }
  }
  // 释放校验所有权（S 门评审：被强占方退出时不得删除继任者的在持锁——比对锁内容首行 pid）
  const releaseInstallLock = () => {
    try {
      const content = readFileSync(lockPath, 'utf8');
      if (content.startsWith(`${process.pid}\n`)) rmSync(lockPath, { force: true });
    } catch { /* 释放尽力而为（锁已不在/不可读＝无事可做） */ }
  };
  // 备份名带进程与随机后缀（与同批 tmp 随机化口径一致）：同毫秒两次 install 不撞同一 `.bak`
  const ts = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  // 写前重读基线（内部任务-347/内部未决-273 第二道门）：备份前读一次 installed.json，落盘前重读比对——
  // 期间被并发方改写即中止（已物化包保留幂等重跑收敛，不回滚——回滚反而覆盖他方）。
  let backups = new Map();
  let registryBackup = null;
  let preSnapshot = '';
  try {
    preSnapshot = JSON.stringify(readRegistry(registryPath).doc);
    ({ backups, registryBackup } = backupExisting(managedRoot, registryPath, PLUGINS, ts));
  } catch (error) {
    const message = `备份阶段失败（既有安装未改动）：${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    report.problems.push(message);
    lines.push(`  ✗ ${message}`);
    releaseInstallLock();
    return finish(2);
  }
  try {
    for (const plan of plans) collectPruned(plan, installPackageFiles({ plan, targetRoot: managedRoot, prune: args.prune }));
    const { doc: registryDoc, problems: registryProblems, warnings: registryWarnings } = readRegistry(registryPath);
    // 写前重读比对（内部未决-273 第二道门）：备份期间 installed.json 被并发方改写 ⇒ 中止。
    // 独立中止路径（S 门评审）：**不进 rollbackWrite**——回滚会用本进程备份覆盖并发方写入
    // （恰是要避免的事）；已物化文件保留（幂等重跑收敛）。
    if (JSON.stringify(registryDoc) !== preSnapshot) {
      const message = 'installed.json 并发变更（备份期间内容漂移）——本进程中止，已物化文件保留（重跑幂等收敛；不回滚——回滚会覆盖并发方写入）';
      process.stderr.write(`${message}\n`);
      report.problems.push(message);
      lines.push(`  ✗ ${message}`);
      releaseInstallLock();
      return finish(1);
    }
    for (const warning of registryWarnings ?? []) {
      report.warnings.push(warning);
      lines.push(`  ⚠ ${warning}`);
    }
    if (registryProblems.length > 0) {
      for (const problem of registryProblems) lines.push(`  ✗ 登记：${problem}`);
      throw new Error(`installed.json 实样结构校验失败：${registryProblems.join('；')}`);
    }
    const next = upsertEntries(registryDoc, { managedRoot, now: new Date().toISOString() });
    writeFileAtomic(registryPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
    // 写后即验：完整 verify 面（sha256 对拍 + 装载探针 + installed.json 双读）
    const verified = runVerify({ plans, targetRoot: managedRoot, registryPath, managedRoot });
    report.plugins = verified.plugins;
    for (const warning of verified.warnings ?? []) {
      report.warnings.push(warning);
      lines.push(`  ⚠ ${warning}`);
    }
    for (const plugin of verified.plugins) {
      const hint = agentPairingHint(plugin);
      if (hint) {
        report.warnings.push(hint);
        lines.push(`  ⚠ ${hint}`);
      }
    }
    if (verified.problems.length > 0) {
      report.problems.push(...verified.problems);
      throw new Error(`写后即验失败（${verified.problems.length} 项漂移）`);
    }
    lines.push(hostApp.present
      ? `install 完成：managed/ 六包 + installed.json 六条目；verify 通过（sha256 对拍 + 装载探针 + 登记双读）`
      : `install 完成（数据面物化就绪——宿主未检出，非宿主装机生效，宿主装机后自拾）：managed/ 六包 + installed.json 六条目；verify 通过（sha256 对拍 + 装载探针 + 登记双读）`);
    cleanupBackups(backups, registryBackup); // 仅安装成功路径清备份
    emitPruned(); // 删除清单只在成功路径报（回滚路径删除已被还原，报了会误导）
  } catch (error) {
    const rollback = rollbackWrite(managedRoot, registryPath, backups, registryBackup);
    if (rollback.ok) {
      cleanupBackups(backups, registryBackup); // 回滚完整成功——备份统一清理
    } else {
      // 回滚未完整成功：备份**保留**，输出 .bak 路径人工恢复指引（zcode-adapter install 同款姿态）
      lines.push('⚠ 回滚未完整成功——原始包备份保留，可按以下路径改名回用人工恢复：');
      for (const bak of backups.values()) lines.push(`  ${bak}`);
      if (registryBackup !== null) lines.push(`  ${registryBackup}`);
      for (const failure of rollback.failures) lines.push(`  ✗ ${failure}`);
      report.problems.push('回滚未完整成功（备份保留，路径见输出）');
    }
    report.problems.push(error instanceof Error ? error.message : String(error));
    lines.push(`✗ 安装失败已回滚：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
  releaseInstallLock();
  return finish(report.problems.length > 0 ? 1 : 0);
}

const invokedDirectly = (() => {
  try {
    // `realpathSync` 必须做：经**符号链接路径**调用时（macOS `/tmp` → `/private/tmp`），不归一会让
    // 判等恒假 ⇒ 整条 CLI 静默 no-op（mcode 内部任务-MACKEY-1 同款教训）。
    return process.argv[1] ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href : false;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code; // 写 stdout 后不得立即 exit（管道截断；内部任务-241 纪律）
  }).catch((error) => {
    const message = String(error && error.message ? error.message : error);
    if (process.argv.includes('--json')) {
      // 形状与正常报告同源（README「CLI 契约」承诺：失败路径同样输出 JSON，顶层异常亦然）
      const cmd = process.argv[2] === 'verify' ? 'verify' : 'install';
      process.stdout.write(`${JSON.stringify({
        command: cmd,
        mode: 'unknown',
        hostRoot: null,
        targetRoot: null,
        repoRoot: null,
        node: null,
        staging: '',
        hostApp: null,
        plugins: [],
        problems: [`安装器异常：${message}`],
        warnings: [],
        pruned: [],
        ok: false,
        exitCode: 2,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`安装器异常：${message}\n`);
    }
    process.exitCode = 2;
  });
}

export { main };
