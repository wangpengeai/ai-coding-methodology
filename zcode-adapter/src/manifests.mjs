// 文件：zcode-adapter/src/manifests.mjs
// 描述：套件常量、六清单加载与版本折叠登记面常量。常量（六插件名/市场名/客户端相对位置）S1 落；
//       loadManifests / hash16 / IF-HOST 登记面常量随 S2 步骤 6 从 scripts/release-suite.mjs 迁入
//       （校验语义与失败文案逐字保留；打印副作用上提到调用方，返回 {ok, reason} 形态便于单测）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 六插件套件（内部决策-017，与 release-suite 迁移面同序；algo-loop 2026-10-15 内部任务-90/内部决策-046、research-loop 2026-10-16 内部任务-109/内部决策-047 入套件）。 */
export const PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop']);

/** 有钩子声明的插件子集（内部接口-1 条件行形制：清单行恒有、hooks 行仅此集——research-loop Stage 1 零钩子，内部决策-047 影响节修订文）。 */
export const HOOKED_PLUGINS = Object.freeze(['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop']);

/** 套件版本形态（三段式 X.Y.Z）：版本会被拼入宿主 cache 路径并参与清理，单源供 loadManifests/install/bump 复用。 */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 本机市场名（known_marketplaces 注册 id，内部决策-017 装机实录）。 */
export const MARKET_ID = 'wangp-local-marketplace';

/**
 * 客户端 zcode-home 下的关键相对位置（实机勘察 2026-09-30；posix 字面量，path.join 消费侧自动归一）。
 * 内部任务-334/内部未决-247③：模块私有——外部消费一律经 `clientPath()`（撤 export 让 split 单源由结构而非纪律保证）。
 */
const CLIENT_PATHS = Object.freeze({
  knownMarketplaces: 'cli/plugins/known_marketplaces.json',
  registry: 'cli/plugins/installed_plugins.json',
  config: 'cli/config.json',
  marketplaces: 'cli/plugins/marketplaces',
  cache: 'cli/plugins/cache',
});

/**
 * zcode-home 下客户端相对位置拼接单源（内部未决-247③：`CLIENT_PATHS.<key>.split('/')` 全仓仅存于此；
 * posix 字面量权威见 CLIENT_PATHS，path.join 自动归一）。追加段（如 MARKET_ID）由调用方外层 join。
 * @param {string} root 根目录（如 zcodeHome）
 * @param {string} key CLIENT_PATHS 键名
 * @returns {string} 拼接路径
 */
export function clientPath(root, key) {
  return join(root, ...CLIENT_PATHS[key].split('/'));
}

/** 内部接口-1 激活登记文档（bump 写面，内部决策-024；迁自 release-suite.mjs:26）。 */
export const IF_HOST_REL = join('specs', 'interfaces', 'IF-HOST-1.md');

/** 内部接口-1 激活登记标题行形态（解析与生成共用同一字面量，防两处漂移；迁自 :41）。 */
export const HOST_TITLE_RE = /^## 激活登记（(\d{4}-\d{2}-\d{2})，六插件统一 (\d+\.\d+\.\d+) 版本折叠刷新，ADR-017）$/;

/**
 * 16 位 sha256 前段（与 check-repo-consistency / IF 激活登记同口径，LF 字节；迁自 :36-38）。
 * @param {Buffer|string} buf
 * @returns {string}
 */
export function hash16(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * 本地日期 YYYY-MM-DD（bump 标题用；禁用 toISOString——UTC 跨日错标；迁自 :48-51）。
 * @param {Date} [d]
 * @returns {string}
 */
export function localDate(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 读六清单并校验：任一缺失/损坏/字段不全/版本不一致 → {ok:false, reason}（**首错即返**，
 * 迁自 :91-118 逐字——原版 fail-fast 语义保留，多问题只报首个）。
 * @param {string} root 仓库根
 * @returns {{ok: true, manifests: Object<string, {version: string, description: string, author: string}>}|{ok: false, reason: string}}
 */
export function loadManifests(root) {
  const out = {};
  for (const p of PLUGINS) {
    // 2026-10-01 内部决策-036 源切换：读面从 .zcode-plugin/plugin.json（生成物）迁至 plugin.manifest.json
    //（唯一手工编辑面）；校验语义与失败文案形态不变，publish 同函数消费、值经收敛判据不变
    const file = join(root, p, 'plugin.manifest.json');
    if (!existsSync(file)) return { ok: false, reason: `清单缺失：${file}` };
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof m.version !== 'string' || typeof m.description !== 'string') {
        return { ok: false, reason: `清单字段不全（version/description）：${file}` };
      }
      // 版本形态纵深防御（内部任务-238 S9）：version 会被下游拼入 cache 目录路径，非三段式即拒
      if (!VERSION_RE.test(m.version)) {
        return { ok: false, reason: `清单版本须为三段式 X.Y.Z：${file}（实测 ${m.version}）` };
      }
      out[p] = { version: m.version, description: m.description, author: typeof m.author === 'string' ? m.author : 'wangp' };
    } catch (e) {
      return { ok: false, reason: `清单不可解析：${file}（${e.message}）` };
    }
  }
  const versions = [...new Set(PLUGINS.map((p) => out[p].version))];
  if (versions.length !== 1) {
    const lines = ['版本不一致（ADR-017 要求统一版本）：'];
    for (const p of PLUGINS) lines.push(`  ${p.padEnd(16)} ${out[p].version}`);
    return { ok: false, reason: lines.join('\n') };
  }
  return { ok: true, manifests: out };
}
