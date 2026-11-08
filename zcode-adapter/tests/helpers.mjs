// 文件：zcode-adapter/tests/helpers.mjs
// 描述：zcode-adapter 测试夹具——临时仓库 / 市场源 / 客户端 zcode-home 三件套。自含纪律：
//       ①一切夹具根必须在 os.tmpdir() 内（assertInTmp 把守，绝不触碰真实 ~/.zcode）；
//       ②config.json 夹具只合成 plugins.enabledPlugins 子树——真实文件含 mcp 凭证节，禁止复制；
//       ③installed_plugins.json 的四插件 installPath 复刻实机「尾双分隔符」形态（2026-09-30
//       勘察：四插件尾双反斜杠，官方/他插件条目**无尾分隔符**——对照条目取无尾形态）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, sep, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 市场名（与真实客户端注册一致）。 */
export const MARKET = 'wangp-local-marketplace';
/** 六插件（与 release-suite 迁移面同序；algo-loop 2026-10-15 内部任务-90/内部决策-046、research-loop 2026-10-16 内部任务-109/内部决策-047 入套件）。 */
export const PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);
/** 有钩子声明的插件子集（research-loop Stage 1 零钩子——内部接口-1 条件行形制：清单行恒有、hooks 行仅此集）。 */
export const HOOKED_PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop']);
/** 夹具统一版本（登记版本 / 市场清单版本 / repo 清单版本）。 */
export const VERSION = '0.1.0';
/** 夹具保留的旧版本目录（旧版本 cache 永不删语义的夹具面）。 */
export const OLD_VERSION = '0.0.9';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 临时夹具根（os.tmpdir() 内唯一落点）。
 * @param {string} tag 目录标签
 * @returns {string}
 */
export function tempRoot(tag) {
  return mkdtempSync(join(tmpdir(), `zcode-adapter-${tag}-`));
}

/**
 * 清理夹具根。
 * @param {string} dir
 * @returns {void}
 */
export function removeRoot(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 断言路径在 os.tmpdir() 内（测试不碰真实客户端状态的硬前提）。
 * @param {string} p
 * @returns {string} 原路径
 */
export function assertInTmp(p) {
  const abs = resolve(p);
  if (!abs.startsWith(tmpdir())) throw new Error(`夹具越界：${abs} 不在 ${tmpdir()} 内`);
  return abs;
}

/**
 * 写文件（自动建父目录）。
 * @param {string} path
 * @param {string} content
 * @returns {void}
 */
export function writeFile(path, content) {
  assertInTmp(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 过滤式目录拷贝（排除 __pycache__/.mimosa 段与 .pyc 后缀——与发布 filter 同口径；
 *       夹具侧独立实现，红阶段不依赖 src/）。
 * @param {string} src
 * @param {string} dest
 * @returns {void}
 */
export function copyFiltered(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const s = join(src, name);
    if (name === '__pycache__' || name === '.mimosa' || name.endsWith('.pyc')) continue;
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyFiltered(s, d);
    else cpSync(s, d);
  }
}

/**
 * 写 manifest + 派生 plugin.json 一对（内部决策-036 源切换后夹具的双文件不变量单点收敛——
 * 终审处置：四处夹具改经本助手双写，manifest 加必填字段时只改一处）。
 * @param {string} repo 仓库根
 * @param {string} p 插件名
 * @param {string} version 版本
 * @param {string} description 描述
 * @returns {void}
 */
export function writePluginPair(repo, p, version, description) {
  writeFile(join(repo, p, 'plugin.manifest.json'), `${JSON.stringify({ manifestVersion: 1, name: p, version, description, author: 'wangp' }, null, 2)}\n`);
  writeFile(join(repo, p, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({ name: p, version, description, author: 'wangp' }, null, 2)}\n`);
}

/**
 * 造最小仓库：六插件各含清单/hooks/一份 skill + 运行态污染物（过滤器证伪素材）。
 * @param {string} [tag='repo']
 * @returns {{repo: string, pluginDir: (p: string) => string}}
 */
export function makeRepo(tag = 'repo') {
  const repo = assertInTmp(tempRoot(tag));
  for (const p of PLUGINS) {
    const root = join(repo, p);
    writePluginPair(repo, p, VERSION, `测试 ${p}`);
    writeFile(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
    writeFile(join(root, 'skills', 'demo', 'SKILL.md'), `---\nname: demo\ndescription: ${p} 夹具技能\n---\n\n${p} 正文\n`);
    // 污染物：三形态各一（段目录/隐藏段目录/后缀文件）
    writeFile(join(root, '__pycache__', 'demo.cpython-314.pyc'), 'bin');
    writeFile(join(root, '.mimosa', 'scan.json'), '{}');
    writeFile(join(root, 'stray.pyc'), 'bin');
  }
  return { repo };
}

/**
 * 造市场源：marketplace.json（六条目）+ plugins/<p> 过滤树。
 * @param {string} repo makeRepo 产物
 * @returns {{market: string, manifestPath: () => string, pluginPath: (p: string) => string}}
 */
export function makeMarket(repo) {
  const market = assertInTmp(tempRoot('market'));
  const entries = PLUGINS.map((p) => ({
    name: p,
    version: VERSION,
    description: `测试 ${p}`,
    author: { name: 'wangp' },
    category: 'developer-tools',
    keywords: ['测试'],
    source: `./plugins/${p}`,
  }));
  writeFile(join(market, 'marketplace.json'), `${JSON.stringify({ name: MARKET, description: '测试市场', plugins: entries }, null, 2)}\n`);
  for (const p of PLUGINS) copyFiltered(join(repo, p), join(market, 'plugins', p));
  return { market };
}

/**
 * 造客户端 zcode-home：known_marketplaces（directory 源 + url 诱饵条目）/ 登记表（尾双分隔符形态）/
 *       config（仅 enabledPlugins）/ 派生镜像 / cache（登记版本 + 旧版本目录）。
 * @param {string} market 市场源根
 * @returns {{home: string, registryPath: string, configPath: string, cacheDir: (p: string, v: string) => string, mirrorRoot: string}}
 */
export function makeZcodeHome(market) {
  const home = assertInTmp(tempRoot('zhome'));
  const pluginsRoot = join(home, 'cli', 'plugins');
  // url 诱饵条目在前：证明 resolveMarketRoot 只认 directory 源（按市场名过滤）
  writeFile(join(pluginsRoot, 'known_marketplaces.json'), `${JSON.stringify({
    version: 1,
    marketplaces: [
      { id: 'official', name: 'official', description: '诱饵', source: { source: 'url', url: 'https://example.invalid/marketplace.json' } },
      { id: MARKET, name: MARKET, description: '测试市场', source: { source: 'directory', path: market }, pluginCount: PLUGINS.length },
    ],
  }, null, 2)}\n`);
  const cacheRoot = join(pluginsRoot, 'cache', MARKET);
  const registry = {
    version: 1,
    plugins: [
      // 无尾分隔符对照条目（官方/他插件形态，实机 2026-09-30 勘察）
      { id: `vision-bridge@${MARKET}`, name: 'vision-bridge', marketplace: MARKET, version: '1.2.0', installPath: join(pluginsRoot, 'cache', MARKET, 'vision-bridge', '1.2.0'), source: './plugins/vision-bridge' },
      ...PLUGINS.map((p) => ({
        id: `${p}@${MARKET}`,
        name: p,
        marketplace: MARKET,
        version: VERSION,
        // 尾双分隔符：实机四插件形态（2026-09-30 勘察），verify 比较侧须归一容忍
        installPath: join(cacheRoot, p, VERSION) + sep + sep,
        installedAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
        scope: 'user',
        source: `./plugins/${p}`,
      })),
    ],
  };
  const registryPath = join(pluginsRoot, 'installed_plugins.json');
  writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const configPath = join(home, 'cli', 'config.json');
  const enabled = Object.fromEntries(PLUGINS.map((p) => [`${p}@${MARKET}`, true]));
  enabled[`vision-bridge@${MARKET}`] = true;
  writeFile(configPath, `${JSON.stringify({ plugins: { enabledPlugins: enabled } }, null, 2)}\n`);
  // 派生镜像：清单逐字副本 + 四插件过滤树（不含诱饵——镜像只放四插件，vision-bridge 仅在诱饵语境缺席）
  const mirrorRoot = join(pluginsRoot, 'marketplaces', MARKET);
  cpSync(join(market, 'marketplace.json'), join(mirrorRoot, 'marketplace.json'));
  for (const p of PLUGINS) copyFiltered(join(market, 'plugins', p), join(mirrorRoot, 'plugins', p));
  // cache：登记版本目录 + 旧版本目录（内容取市场树，仅登记版本被 F4 核对；内部任务-276 D25 删死参数 opts.versions）
  for (const p of PLUGINS) {
    copyFiltered(join(market, 'plugins', p), join(cacheRoot, p, VERSION));
    copyFiltered(join(market, 'plugins', p), join(cacheRoot, p, OLD_VERSION));
  }
  return { home, registryPath, configPath, cacheDir: (p, v) => join(cacheRoot, p, v), mirrorRoot };
}

/**
 * 目录树字节指纹（回滚/零改动断言单源，round1 S4 处置：market.test 与 install.test 共用）。
 * @param {string} root 目录根
 * @param {boolean} [withMtime] 是否计入 mtimeMs（源仓零改动不变量需要；字节回滚比对不需要）
 * @returns {string} 逐文件「路径|sha256 前 16 hex[|mtimeMs]」行拼接
 */
export function fingerprintTree(root, withMtime = false) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${full}|${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}${withMtime ? `|${st.mtimeMs}` : ''}`);
    }
  };
  walk(root);
  return out.join('\n');
}

/**
 * 读 JSON（测试侧便利）。
 * @param {string} path
 * @returns {any}
 */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
