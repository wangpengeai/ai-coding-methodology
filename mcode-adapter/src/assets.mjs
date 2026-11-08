// 文件：mcode-adapter/src/assets.mjs
// 描述：资产面——把六插件目录**只读**地枚举成"物化计划"，并在安装期落盘。三条纪律：
//       ① 单向只读：只读源、只写宿主数据目录，永不写回六插件（内部决策-034 决策 1）；
//       ② 排除面最小化：只排 `.zcode-plugin/`（ZCode 清单，由 MCode 清单取代）、
//          `node_modules`（本地产物）与**构建缓存本地产物**（`__pycache__`/`.mimosa` 段、
//          `*.pyc` 末段，口径同 `zcode-adapter` 的 `IGNORED`），其余**整目录照搬**——
//          包括测试目录。理由：照搬规则足够简单，不会"顺手排除"掉某个运行时依赖
//          （spec-gate 的 `core/`、`assurance/` 就是靠这条规则完整落进包）；
//          构建缓存例外**不**出于洁癖，而是可核账的前提——`.pyc` 两侧各编译一次、字节
//          必然不同，装进去会让 `verify` 结构性报红（内部任务-55 基线证据）。
//       ③ 可核账：`verify` 模式重算计划并**逐文件字节比对**「已装包 vs 源」，漂移即红
//          （不依赖哈希——生产侧不计算 sha256，测试侧需要时自算）。
//       图标为自生成 PNG（不引用宿主内置素材、不引第三方包），按插件色相确定性生成。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * 源目录里不物化的顶层项。
 * - `.zcode-plugin`：ZCode 清单，由 MCode 清单取代；
 * - `node_modules`：本地产物；
 * - `agents`（内部任务-291）：源 `agents/*.md` 是 **ZCode 形态**（含 `skills:`/`features:` 字段），
 *   而 MCode 的包内子代理走另一套 frontmatter 契约（`local-plugin-agents.md`），直接照搬
 *   只在包里留下一份宿主不认的死文件。agent 能力另由数据目录安装（`--with-agents`）提供。
 *   **升级面**：`verify` 走查侧不消费本常量（只比对"计划内 rel"），故已装包内残留的
 *   `agents/*.md` 会被判「多余」，须 `--prune` 收敛；`prune` 只删文件、不删空目录。
 */
export const EXCLUDED_TOP_LEVEL = Object.freeze(['.zcode-plugin', 'node_modules', 'agents']);

/** 本地产物目录段（构建缓存，非资产）：命中即整棵剪枝。 */
const LOCAL_ARTIFACT_DIRS = Object.freeze(['__pycache__', '.mimosa']);

/**
 * 本地产物判定——口径与 `zcode-adapter/src/expect-tree.mjs` 的 `IGNORED(rel)` 逐字同款
 * （内部任务-PYCLEAN-1，与 `spec-gate/assurance/probes.mjs` 的 `DEFAULT_IGNORE` 互见）：
 * 任一路径段为 `__pycache__`/`.mimosa`，或末段匹配 `*.pyc`；win32 下大小写归一。
 *
 * 计划侧（枚举）与 `verify` 的「多余」走查侧**必须同用本谓词**：只剪计划侧，已装包内的
 * 历史残留会被永久计为多余（内部任务-55 基线实测 4 项多余即此形态）。
 *
 * 移植说明：本仓共四份同款谓词（zcode `expect-tree.mjs` 的 `IGNORED`、mcode 本件、kimi
 * `assets.mjs` 的 `isLocalArtifact`、`spec-gate/assurance/probes.mjs` 的 `DEFAULT_IGNORE` 口径）。**上收 `plugin-core` 的路线已评估
 * 但本批不采**——适配层本就依赖 plugin-core，技术上可行；不采的理由是收益/代价比不足（要多动
 * 中立核心新增导出＋其测试＋`内部接口-1` 登记，回归面扩大，而省下的只是两份常量级谓词）。
 * 该取舍**可被后续批推翻**，记录见计划
 * `内部计划`「拆分论证」段。
 * @param {string} rel 包内相对路径（posix 分隔）
 * @returns {boolean} 是本地产物则 true
 */
export function isLocalArtifact(rel) {
  const parts = rel.split('/');
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (parts.some((p) => LOCAL_ARTIFACT_DIRS.includes(norm(p)))) return true;
  return norm(parts[parts.length - 1]).endsWith('.pyc');
}

/**
 * 逐文件枚举一个插件目录（返回包内相对路径 + 字节数 + link 标记，排序保证确定性）。
 * 符号链接**不跟随**：记 `link: true` 由调用方拒绝（否则站外内容会被原样物化进包）。
 * @param {string} sourceRoot 插件源根
 * @returns {{rel: string, bytes: number, link: boolean}[]}
 */
export function listSourceFiles(sourceRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const stat = lstatSync(abs);
      const rel = relative(sourceRoot, abs).split(sep).join('/');
      if (stat.isSymbolicLink()) {
        out.push({ rel, bytes: 0, link: true });
        continue;
      }
      if (stat.isDirectory()) {
        if (rel.split('/').length === 1 && EXCLUDED_TOP_LEVEL.includes(name)) continue;
        if (isLocalArtifact(rel)) continue; // `__pycache__`/`.mimosa` 段：整棵剪枝
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (isLocalArtifact(rel)) continue; // 末段 `*.pyc`
      out.push({ rel, bytes: stat.size, link: false });
    }
  };
  walk(sourceRoot);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * 收集可物化的源文件；符号链接记 problem 并跳过（不跟随、不读取）。
 * @param {string} sourceRoot 插件源根
 * @returns {{files: {rel: string, bytes: number}[], problems: string[]}}
 */
export function collectSourceFiles(sourceRoot) {
  const problems = [];
  const files = [];
  for (const entry of listSourceFiles(sourceRoot)) {
    if (entry.link) { problems.push(`源资产含符号链接（拒绝物化）：${entry.rel}`); continue; }
    files.push(entry);
  }
  return { files, problems };
}

/**
 * 文件 sha256（十六进制）。
 * @param {string} path 文件路径
 * @returns {string}
 */
export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 字节串 sha256（内容相同的两个文件必须同值——`verify` 的比对基准）。
 * @param {Buffer} buf 字节
 * @returns {string}
 */
export function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** CRC-32 表（PNG 分块校验用）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32（PNG 块校验）。
 * @param {Buffer} buf 字节
 * @returns {number} 无符号值
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG 分块（长度 + 类型 + 数据 + CRC）。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** HSL → RGB（色相转 RGB 的标准公式，s/l 固定故只需色相参数）。 */
function hslToRgb(hue, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/**
 * 自生成插件图标 PNG（64×64，RGBA）：底色为插件色相，四角留白 + 居中实心方块构成
 * 可辨识标记；暗色版压低亮度。**确定性**：同色相两次生成字节一致（故 `verify` 可比对）。
 * @param {number} hue 色相 0..359
 * @param {boolean} dark 是否暗色版
 * @returns {Buffer} PNG 字节
 */
export function renderIconPng(hue, dark) {
  const size = 64;
  const [br, bg, bb] = hslToRgb(hue, dark ? 0.45 : 0.62, dark ? 0.22 : 0.52);
  const [fr, fg, fb] = hslToRgb(hue, dark ? 0.7 : 0.9, dark ? 0.62 : 0.94);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const inMark = x >= 20 && x < 44 && y >= 20 && y < 44;
      const inBar = x >= 14 && x < 50 && y >= 29 && y < 35;
      const color = inMark || inBar ? [fr, fg, fb] : [br, bg, bb];
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = 255;
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
