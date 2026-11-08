// 文件：zcode-adapter/src/client-state.mjs
// 描述：ZCode 客户端状态面读取与归一——zcode-home 解析（显式参数 > ZCODE_HOME > ~/.zcode，
//       注入缝对齐 mcode-adapter 的 MINIMAX_DATA_DIR 先例）、市场源解析与**市场注册登记读取**
//       （resolveMarketRoot 与 readMarketplaceRegistration 共用 findDirectoryMarketEntry 单源，
//       2026-11-01 内部任务-275/内部未决-154）、登记表/配置读取。installPath 的尾分隔符归一只在比较侧
//       （normalizePathTail），写侧保留原字符串形态（实机四插件尾双分隔符与官方单分隔符并存，
//       2026-09-30 勘察）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { MARKET_ID, clientPath } from './manifests.mjs';

/**
 * zcode-home 解析：显式参数 > 环境变量 ZCODE_HOME > 家目录 ~/.zcode。
 * @param {string} [flag] 显式路径（空串即按环境推导）
 * @param {Record<string, string|undefined>} [env] 环境注入缝
 * @returns {string} 绝对路径；无法推导返回空串
 */
export function resolveZcodeHome(flag, env = process.env) {
  if (flag) return resolve(flag);
  if (typeof env.ZCODE_HOME === 'string' && env.ZCODE_HOME.trim() !== '') return resolve(env.ZCODE_HOME);
  const home = env.USERPROFILE || env.HOME || '';
  return home === '' ? '' : resolve(home, '.zcode');
}

/**
 * 读 known_marketplaces 的 MARKET_ID directory 源条目（resolveMarketRoot 与 F7 注册面共用单源，
 * round1 S1 处置——防两函数谓词漂移）。失败折叠为 {entry:null, note} 由调用方定性。
 * @param {string} zcodeHome
 * @returns {{entry?: object, note?: string}}
 */
function findDirectoryMarketEntry(zcodeHome) {
  const file = clientPath(zcodeHome, 'knownMarketplaces');
  if (!existsSync(file)) return { entry: null, note: 'known_marketplaces.json 不存在' };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { entry: null, note: `known_marketplaces.json 不可解析（${e.message}）` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    // 评审 correctness-2：`null`/数组顶层同属形态损坏（JSON.parse('null') 合法但不可用）
    return { entry: null, note: 'known_marketplaces.json 顶层非对象（形态损坏）' };
  }
  if (!Array.isArray(doc.marketplaces)) {
    // 内部任务-276 D8：合法 JSON 但 marketplaces 非数组（手改损坏）此前 .find 抛 TypeError 穿透；
    // 对齐同文件 readClientState「解析失败不抛」承诺
    return { entry: null, note: 'known_marketplaces.json marketplaces 非数组（形态损坏）' };
  }
  const entry = doc.marketplaces.find(
    (m) => m !== null && typeof m === 'object' && m.id === MARKET_ID && m.source && m.source.source === 'directory' && typeof m.source.path === 'string',
  );
  return entry ? { entry } : { entry: null, note: `无 ${MARKET_ID} 的 directory 源条目` };
}

/**
 * 市场源解析：显式参数优先；否则读 known_marketplaces.json，取 **id 匹配**（计划口径）的
 * directory 源 path（url/github 源不构成装机写面，不命中）。
 * @param {string} zcodeHome
 * @param {string} [flag] 显式市场源路径
 * @returns {string|null} 市场源绝对路径；不可解返回 null
 */
export function resolveMarketRoot(zcodeHome, flag = '') {
  if (flag) return resolve(flag);
  const { entry } = findDirectoryMarketEntry(zcodeHome);
  return entry ? resolve(entry.source.path) : null;
}

/**
 * 市场注册登记读取（F7 数据源，内部未决-154）：不折叠失败原因（与 resolveMarketRoot 的差别——那边把
 * 六类失败全折 null）。marketRoot 传入时与注册指向比对产 stale（注册指向旧路径/市场迁移后旧路径已删
 * ＝六面可全绿的假绿主场景；realpath 双侧可得＝形态归一比对，规避 /var↔/private/var 形态分裂，
 * 任一侧不存在＝回退 resolve 字符串比对——注册路径悬挂不得放行为 registered，round1 C2 处置）。
 * install 尾印核对与 verify F7 面共用本单源。
 * @param {{zcodeHome: string, marketRoot: string}} input
 * @returns {{state: 'registered'|'missing'|'stale', registeredPath?: string, note?: string}}
 */
export function readMarketplaceRegistration({ zcodeHome, marketRoot }) {
  const { entry, note } = findDirectoryMarketEntry(zcodeHome);
  if (!entry) return { state: 'missing', note };
  const registeredPath = resolve(entry.source.path);
  const rp = realpathOrNull(registeredPath);
  const mp = realpathOrNull(resolve(marketRoot));
  const same = rp && mp ? rp === mp : registeredPath === resolve(marketRoot); // registeredPath 已是 resolve 产物（幂等，round2 简洁性处置）
  return same ? { state: 'registered', registeredPath } : { state: 'stale', registeredPath };
}

/** realpath 包装：失败返回 null（F7 比对侧回退字符串比对——悬挂注册不得放行，round1 C2）。 */
function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 尾分隔符归一（仅比较侧使用）：剥掉路径尾全部 / 与 \。
 * @param {string} p
 * @returns {string}
 */
export function normalizePathTail(p) {
  return String(p).replace(/[\\/]+$/, '');
}

/**
 * 读客户端三文件（登记表/配置）。解析失败不抛——落 problems（target 定面）由调用方定性。
 * @param {string} zcodeHome
 * @returns {{registry: object|null, config: object|null, problems: Array<{target: 'registry'|'config', text: string}>}}
 */
export function readClientState(zcodeHome) {
  const problems = [];
  const registryFile = clientPath(zcodeHome, 'registry');
  const configFile = clientPath(zcodeHome, 'config');
  let registry = null;
  let config = null;
  try {
    registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  } catch (e) {
    problems.push({ target: 'registry', text: `登记表不可读：${registryFile}（${e.message}）` });
  }
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (e) {
    problems.push({ target: 'config', text: `config 不可读：${configFile}（${e.message}）` });
  }
  return { registry, config, problems };
}
