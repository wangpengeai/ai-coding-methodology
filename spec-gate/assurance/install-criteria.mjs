// 文件：install-criteria.mjs
// 描述：cli.py 的 `_install_criteria` 全量实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 D1/D5 运行时归一·阶段3a W2）——
//       装机收口判据生成（内部决策-027/048）：zcode 注册表目录源双形态受理（相对市场根
//       ./plugins/<名> 与相对 pluginRoot ./<名>，内部任务-COMPAT-1）、反斜杠/空段/./.. 拒绝、
//       每插件 5 条判据＋全局镜像清单哈希；--host zcode 尾附 host-app-present 在位判据；
//       kimi＝installed.json 六 id 条目 enabled 双读＋managed 目录 file-exists；
//       mcode＝六包目录 file-exists（无 registry 面）；dsh＝**仅在位判据**（无 managed 静态
//       装机面，内部决策-054 G-05）。expect 一律取自发布源、目标取自
//       被验证面（禁自证同源）；路径折探针双基 {base:'user-home'|'project', rel}。
//       错误一律 CliToolError（命令面退 2）；stdout 纯 JSON 由 cli.mjs 负责，本文件不写屏。
//       与 cli.py:144-396 逐函数对齐；行为冻结（不修复既有怪癖）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { isWithinRoot, looseRealpath, readUtf8Strict, sha256File, underRoot } from './common.mjs';
import { DEFAULT_IGNORE, treeHash } from './probes.mjs';

// CliToolError 在 cli.mjs 定义（同一命令面的单一错误族）；本模块只在函数体内引用，
// 模块求值期不触碰该绑定——循环 import 安全（cli.mjs 是本模块唯一入口）。
import { CliToolError } from './cli.mjs';

/** 套件六插件冻结元组（与 cli.py SUITE_PLUGINS、plugin-core/zcode-adapter Node 侧同批演进）。 */
export const SUITE_PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 普通对象判定（对齐 Python isinstance(x, dict)）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python dict.get 语义：非对象/缺键取缺省；键存在（含 null）取实值。 */
function get(obj, key, fallback = null) {
  if (!isPlainObject(obj)) return fallback;
  return hasOwn(obj, key) ? obj[key] : fallback;
}

/** Python 类型名（报错消息同形；仅供诊断文本）。 */
function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

/** Python list repr（仅错误消息里的 skipped_sources 增诊）。 */
function pyListRepr(items) {
  return `[${items.map((s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;
}

/** `Path(p).resolve()` 的 JS 承接（realpath 非 strict：looseRealpath 与 Path.resolve 同为
 *  「解析存在前缀、保留不存在尾段」）。 */
function resolvePath(p) {
  return looseRealpath(String(p));
}

/** `_under_root`：common.underRoot 拼接后 looseRealpath 归一（绝对路径原样；cli.py:55-60）。 */
const resolveUnderRoot = (root, p) => resolvePath(underRoot(root, p));

/** 文件/目录判定（Path.is_file()/is_dir() 语义：跟随 symlink）。 */
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** 读 JSON 对象（不可读/非法/顶层非对象统一 CliToolError 退 2——cli.py `_load_json_object`）。 */
function loadJsonObject(path, label) {
  let raw;
  try {
    raw = readUtf8Strict(path);
  } catch (e) {
    throw new CliToolError(`${label}不存在或不可读：${path}（${e.message}）`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliToolError(`${label}不是合法 JSON：${path}（${e.message}）`);
  }
  if (!isPlainObject(data)) {
    throw new CliToolError(`${label}顶层必须是对象（收到 ${pyTypeName(data)}）：${path}`);
  }
  return data;
}

/** 宿主在位判据（内部决策-048 决策 1/5）。 */
function hostPresenceCriterion(host, recordRef) {
  return {
    criterion: `宿主 ${host} 应用在位（宿主装机生效宣称，ADR-048）`,
    evidenceRef: recordRef,
    probe: { type: 'host-app-present', expect: { host, presence: 'present' } },
  };
}

/** 宿主数据根解析（内部未决-155/内部任务-241）：--data-dir → env 缝 → 平台标准根；返回来源标注。 */
function resolveHostDataRoot({ explicit, envName, fallback }) {
  if (typeof explicit === 'string' && explicit !== '') {
    return { path: resolvePath(explicit), source: '--data-dir' };
  }
  const envValue = process.env[envName];
  if (typeof envValue === 'string' && envValue !== '') {
    return { path: resolvePath(envValue), source: envName };
  }
  return { path: fallback, source: '默认标准根' };
}

/** user-home 基探针的相对路径（无法用该基表达时返回 null→降级人工走查）。 */
function relFromHome(home, target) {
  const rel = relative(home, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * kimi/mcode 分支：在位判据＋数据面判据（cli.py `_install_criteria_host`）。
 * 内部未决-155（内部任务-241）：数据根按「--data-dir → KIMI_CODE_HOME/MINIMAX_DATA_DIR → 标准根」解析；
 * 标准根下行为与原实现一致，自定义根不在 --home 之下时降级为人工走查判据（不静默伪造探针）。
 * @param {string} root @param {Record<string, unknown>} args @param {string} host
 * @returns {Array<Record<string, unknown>>}
 */
function installCriteriaHost(root, args, host) {
  const home = args.home ? resolvePath(args.home) : resolvePath(homedir());
  const recordRef = args.recordRef;
  const criteria = [hostPresenceCriterion(host, recordRef)];
  if (host === 'dsh') return criteria; // 第四宿主（内部决策-054 G-05）：DSH 无 managed 静态装机面，仅产在位判据
  const dataRoot = host === 'kimi'
    ? resolveHostDataRoot({ explicit: args.dataDir, envName: 'KIMI_CODE_HOME', fallback: join(home, '.kimi-code') })
    : resolveHostDataRoot({ explicit: args.dataDir, envName: 'MINIMAX_DATA_DIR', fallback: join(home, '.minimax') });
  const sourceNote = `（数据根来源：${dataRoot.source}）`;
  const humanCheck = (criterionText) => criteria.push({ criterion: `${criterionText}${sourceNote}`, evidenceRef: recordRef });
  if (host === 'kimi') {
    const installed = join(dataRoot.path, 'plugins', 'installed.json');
    if (!isFile(installed)) {
      throw new CliToolError(`kimi installed.json 不存在（装机未发生或路径不符；数据根来源 ${dataRoot.source}）：${installed}`);
    }
    const data = loadJsonObject(installed, 'kimi installed.json');
    const entries = data.plugins;
    if (!Array.isArray(entries)) {
      throw new CliToolError(`kimi installed.json 缺 plugins 数组：${installed}`);
    }
    const installedRel = relFromHome(home, installed);
    const managedRelRoot = relFromHome(home, join(dataRoot.path, 'plugins', 'managed'));
    for (const plugin of SUITE_PLUGINS) {
      const idx = entries.findIndex((e) => isPlainObject(e) && e.id === plugin);
      if (idx === -1) {
        throw new CliToolError(`kimi installed.json 缺「${plugin}」条目（装机不完整）：${installed}`);
      }
      const regText = `「${plugin}」kimi 登记条目在册且启用（installed.json plugins[${idx}].enabled）`;
      if (installedRel === null) {
        humanCheck(`${regText}——数据根不在 --home 之下的 user-home 基无法表达，人工走查`);
      } else {
        criteria.push({
          criterion: `${regText}${sourceNote}`,
          evidenceRef: recordRef,
          probe: {
            type: 'json-field-eq',
            path: { base: 'user-home', rel: installedRel },
            field: `plugins[${idx}].enabled`,
            expect: true,
          },
        });
      }
      const managedText = `「${plugin}」kimi managed 包目录在位`;
      const managedRel = managedRelRoot === null ? null : `${managedRelRoot}/${plugin}`;
      if (managedRel === null) {
        humanCheck(`${managedText}——数据根不在 --home 之下，人工走查`);
      } else {
        criteria.push({
          criterion: `${managedText}${sourceNote}`,
          evidenceRef: recordRef,
          probe: { type: 'file-exists', kind: 'dir', path: { base: 'user-home', rel: managedRel } },
        });
      }
    }
  } else {
    const managedRelRoot = relFromHome(home, join(dataRoot.path, 'plugins'));
    for (const plugin of SUITE_PLUGINS) {
      const text = `「${plugin}」mcode 包目录在位`;
      const rel = managedRelRoot === null ? null : `${managedRelRoot}/${plugin}`;
      if (rel === null) {
        humanCheck(`${text}——数据根不在 --home 之下，人工走查`);
      } else {
        criteria.push({
          criterion: `${text}${sourceNote}`,
          evidenceRef: recordRef,
          probe: { type: 'file-exists', kind: 'dir', path: { base: 'user-home', rel } },
        });
      }
    }
  }
  return criteria;
}

/**
 * 注册表目录源形态识别（cli.py `_parse_dir_tail`）：返回 ['root'|'pluginroot', tail] 或 null。
 * 反斜杠不归一而直接拒收（Windows 路径归一可令 `x\..\y` 越出市场根）。
 * @param {string} source
 * @returns {[string, string]|null}
 */
function parseDirTail(source) {
  if (source.includes('\\')) return null;
  const rest = source.slice(2);
  if (rest.startsWith('plugins/')) {
    const tail = rest.slice('plugins/'.length);
    if (tail.split('/').every((p) => p !== '' && p !== '.' && p !== '..')) return ['root', tail];
    return null;
  }
  if (rest && !rest.includes('/') && rest !== '.' && rest !== '..') return ['pluginroot', rest];
  return null;
}

/**
 * 绝对路径折探针路径双基 {base, rel}（cli.py `_probe_rel`）；两基皆不在其内即工具错误。
 * @returns {[string, string]}
 */
function probeRel(target, home, root, label) {
  const resolved = looseRealpath(String(target));
  for (const [base, baseRoot] of [['user-home', home], ['project', root]]) {
    const baseResolved = looseRealpath(String(baseRoot));
    if (isWithinRoot(baseResolved, resolved)) {
      const rel = relative(baseResolved, resolved);
      const posix = (rel === '' ? '.' : rel).split(sep).join('/');
      return [posix, base];
    }
  }
  throw new CliToolError(`${label} 须位于用户主目录或项目根内（探针路径双基约束）：${target}`);
}

/**
 * 装机相对路径 → 派生镜像相对目录（cli.py `_mirror_rel`）：
 * …/plugins/cache/<市场>/<插件>/<版本> → …/plugins/marketplaces/<市场>。
 */
function mirrorRel(installRel, marketplaceName, pluginName) {
  const parts = installRel.split('/').filter((p) => p !== '');
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === 'cache' && i > 0 && parts[i - 1] === 'plugins') {
      if (parts[i + 1] !== marketplaceName) {
        throw new CliToolError(`installPath 市场段与注册表 marketplace 不一致（${pluginName}）：${installRel}`);
      }
      return [...parts.slice(0, i), 'marketplaces', marketplaceName].join('/');
    }
  }
  throw new CliToolError(`installPath 形态不符（未含 plugins/cache/<市场>/…，${pluginName}）：${installRel}`);
}

/**
 * zcode 面判据生成（cli.py `_install_criteria_zcode`，行为零变更）。
 * @param {string} root @param {Record<string, unknown>} args
 * @returns {Array<Record<string, unknown>>}
 */
function installCriteriaZcode(root, args) {
  const home = args.home ? resolvePath(args.home) : resolvePath(homedir());
  const recordRef = args.recordRef;
  const market = resolveUnderRoot(root, args.marketplace);
  const registryPath = args.registry
    ? resolveUnderRoot(root, args.registry)
    : join(home, '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  const registry = loadJsonObject(registryPath, '注册表');
  const marketManifest = join(market, 'marketplace.json');
  const manifest = loadJsonObject(marketManifest, '市场清单');
  // 条目限定按市场名（防他市场误纳）；source 双形态受理
  const marketName = manifest.name;
  if (typeof marketName !== 'string' || marketName === '') {
    throw new CliToolError(`市场清单缺 name 字段（无法按市场限定注册表条目）：${marketManifest}`);
  }
  const registryEntries = registry.plugins;
  if (!Array.isArray(registryEntries)) {
    throw new CliToolError(`注册表缺 plugins 数组：${registryPath}`);
  }
  const marketEntries = registryEntries
    .map((entry, index) => [index, entry])
    .filter(([, entry]) => isPlainObject(entry) && entry.marketplace === marketName);
  const targets = [];
  const skippedSources = [];
  for (const [index, entry] of marketEntries) {
    const source = entry.source;
    if (typeof source !== 'string' || !source.startsWith('./')) {
      if (typeof source === 'string') skippedSources.push(source);
      continue;
    }
    const parsed = parseDirTail(source);
    if (parsed === null) {
      throw new CliToolError(
        `注册表条目 source 形态非法（plugins[${index}]，段不得为空/./..）：${source}`
        + '（受理形态：./plugins/<名> 或 ./<名>）',
      );
    }
    targets.push([index, entry, parsed]);
  }
  if (targets.length === 0) {
    if (marketEntries.length > 0) {
      throw new CliToolError(
        `注册表本市场（${marketName}）条目均非目录源形态`
        + `（实测 source：${pyListRepr(skippedSources)}；受理形态：./plugins/<名> 或 ./<名>）：${registryPath}`,
      );
    }
    throw new CliToolError(`注册表无本市场（${marketName}）条目（未安装或市场名不符）：${registryPath}`);
  }
  const manifestEntries = manifest.plugins;
  if (!Array.isArray(manifestEntries)) {
    throw new CliToolError(`市场清单缺 plugins 数组：${marketManifest}`);
  }
  // pluginRoot 自市场清单 metadata 读取；形态坏/缺省/含反斜杠回退惯例值 plugins
  const metadata = manifest.metadata;
  let pluginRoot = isPlainObject(metadata) ? metadata.pluginRoot : null;
  if (typeof pluginRoot !== 'string' || pluginRoot.includes('\\')
    || pluginRoot.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    pluginRoot = 'plugins';
  }
  const [marketRel, marketBase] = probeRel(market, home, root, '市场源目录');
  const [registryRel, regBase] = probeRel(registryPath, home, root, '注册表');
  const criteria = [];
  let lastMirrorRel = null;
  let lastStateBase = null;
  for (const [index, entry, parsed] of targets) {
    const name = entry.name;
    if (typeof name !== 'string' || name === '') {
      throw new CliToolError(`注册表条目缺 name：${registryPath}#plugins[${index}]`);
    }
    const installPath = entry.installPath;
    if (typeof installPath !== 'string' || installPath === '') {
      throw new CliToolError(`注册表条目缺 installPath（${name}）：${registryPath}#plugins[${index}]`);
    }
    // 双形态归一化落盘目录：root 形态取 market/plugins/<尾段>，pluginroot 形态取
    // market/<pluginRoot>/<名>——两形态在 pluginRoot=plugins 下同址
    const [kind, tail] = parsed;
    const pluginSrc = kind === 'root' ? join(market, 'plugins', tail) : join(market, pluginRoot, tail);
    if (!isDir(pluginSrc)) {
      throw new CliToolError(`发布源目录缺失（${name}）：${pluginSrc}`);
    }
    const version = get(loadJsonObject(join(pluginSrc, '.zcode-plugin', 'plugin.json'),
      `${name} 发布源清单`), 'version', null);
    if (typeof version !== 'string' || version === '') {
      throw new CliToolError(`发布源清单缺 version（${name}）：${join(pluginSrc, '.zcode-plugin', 'plugin.json')}`);
    }
    const manifestIdx = manifestEntries.findIndex((m) => isPlainObject(m) && m.name === name);
    if (manifestIdx === -1) {
      throw new CliToolError(`市场清单无「${name}」条目（清单陈旧或条目被移除）：${marketManifest}`);
    }
    const treeDigest = treeHash(pluginSrc, [...DEFAULT_IGNORE]);
    const [installRel, stateBase] = probeRel(installPath, home, root, `${name} installPath`);
    const mirror = mirrorRel(installRel, entry.marketplace, name);
    lastMirrorRel = mirror;
    lastStateBase = stateBase;
    criteria.push(
      {
        criterion: `「${name}」注册表版本=${version}（installed_plugins.json plugins[${index}].version）`,
        evidenceRef: recordRef,
        probe: {
          type: 'json-field-eq',
          path: { base: regBase, rel: registryRel },
          field: `plugins[${index}].version`,
          expect: version,
        },
      },
      {
        criterion: `「${name}」注册表双读（version==installPath 末段，TASK-INSTALL-038 教训）`,
        evidenceRef: recordRef,
        probe: {
          type: 'json-field-eq',
          path: { base: regBase, rel: registryRel },
          field: `plugins[${index}].version`,
          ref: {
            refBase: regBase,
            refPath: registryRel,
            refField: `plugins[${index}].installPath`,
            refTransform: 'last-segment',
          },
        },
      },
      {
        criterion: `「${name}」市场清单条目版本==发布源 plugin.json（${version}，跨面对照）`,
        evidenceRef: recordRef,
        probe: {
          type: 'json-field-eq',
          path: { base: marketBase, rel: `${marketRel}/marketplace.json` },
          field: `plugins[${manifestIdx}].version`,
          expect: version,
        },
      },
      {
        criterion: `「${name}」装机树哈希=发布源（${treeDigest.slice(0, 8)}）`,
        evidenceRef: recordRef,
        probe: {
          type: 'dir-tree-hash',
          path: { base: stateBase, rel: installRel },
          expect: treeDigest,
        },
      },
      {
        criterion: `「${name}」派生镜像树哈希=发布源（${treeDigest.slice(0, 8)}）`,
        evidenceRef: recordRef,
        probe: {
          type: 'dir-tree-hash',
          path: { base: stateBase, rel: `${mirror}/plugins/${name}` },
          expect: treeDigest,
        },
      },
    );
  }
  // 全局镜像清单哈希：rel/base 取循环末次值（原 Python 实现（迁移史见 内部决策-051）同口径——单市场条目一致）
  criteria.push({
    criterion: '派生镜像清单文件哈希=市场源（对齐完成，跨面比对）',
    evidenceRef: recordRef,
    probe: {
      type: 'file-sha256',
      path: { base: lastStateBase, rel: `${lastMirrorRel}/marketplace.json` },
      expect: sha256File(marketManifest),
    },
  });
  return criteria;
}

/**
 * install-criteria 门面（cli.py `_install_criteria`）：host 分支与 zcode 面选路。
 * @param {string} root @param {{marketplace?: string|null, registry?: string|null,
 *          home?: string|null, host?: string|null, recordRef: string}} args
 * @returns {Array<Record<string, unknown>>}
 */
export function installCriteria(root, args) {
  const host = args.host ?? '';
  if (host === 'kimi' || host === 'mcode' || host === 'dsh') {
    if (args.marketplace || args.registry) {
      throw new CliToolError(
        'install-criteria --host kimi|mcode|dsh 与 --marketplace/--registry 互斥'
        + '（ZCode 注册表面参数不适用于该宿主分支，ADR-048/ADR-054）',
      );
    }
    if (args.dataDir && host === 'dsh') {
      throw new CliToolError('install-criteria --data-dir 仅适用于 --host kimi|mcode（dsh 无 managed 数据面，ADR-054）');
    }
    return installCriteriaHost(root, args, host);
  }
  if (args.dataDir) {
    throw new CliToolError('install-criteria --data-dir 须与 --host kimi|mcode 同用（zcode 面数据根由注册表源决定）');
  }
  if (!args.marketplace) {
    throw new CliToolError('install-criteria 缺 --marketplace（zcode 面必填；分宿主面用 --host kimi|mcode|dsh）');
  }
  const criteria = installCriteriaZcode(root, args);
  if (host === 'zcode') criteria.push(hostPresenceCriterion('zcode', args.recordRef));
  return criteria;
}
