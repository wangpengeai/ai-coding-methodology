// 文件：zcode-adapter/src/expect-tree.mjs
// 描述：F1 期望树与树哈希。过滤器 IGNORED 为单点谓词（__pycache__/.mimosa 段、*.pyc 末段），
//       与 spec-gate/assurance/probes.mjs 的 DEFAULT_IGNORE 同口径（互见 probes.mjs:42 与
//       isIgnored()：末段 fnmatch + 分段相等包含）；treeHash 逐字承接历史 Python 实现的编帧
//       （排序 rel+digest 逐行 join 后整体 sha256，probes.mjs:227 treeHash）
//       ——两端口径由 tests/verify.test.mjs 金样锁定（内部未决-51 显式互证的实现面）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 平台归一（对齐 Python fnmatch 在 Windows 的 normcase 语义：win32 双双小写后比较，
 * posix 原样——评审 C3 修复，防 `Foo.PYC`/`__PYCACHE__` 大小写变体在两端口径分叉）。
 * @param {string} s
 * @returns {string}
 */
const NORM = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

/**
 * 污染物判定（posix rel）：任一路径段为 __pycache__/.mimosa/.publish-backups，或末段匹配 *.pyc。
 * （.publish-backups＝publish 写面加固的备份目录段，内部任务-275/内部未决-163——仓内 repo 树不存在该段，
 * 对仓库树零影响；市场树哈希/对拍排除备份目录。）
 * @param {string} rel posix 相对路径
 * @returns {boolean}
 */
export function IGNORED(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => NORM(p) === '__pycache__' || NORM(p) === '.mimosa' || NORM(p) === '.publish-backups')) return true;
  return NORM(parts[parts.length - 1]).endsWith('.pyc');
}

/**
 * 缓冲区 sha256（裸 hex，与 assurance common.sha256_hex 同形态）。
 * @param {Buffer|string} buf
 * @returns {string}
 */
export function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 文件 sha256（裸 hex，与 assurance common.sha256_file 同形态）。
 * @param {string} path
 * @returns {string}
 */
export function sha256OfFile(path) {
  return sha256OfBuffer(readFileSync(path));
}

/**
 * 递归收集一棵期望树（过滤污染物；排序保证确定性）。目录符号链接不下潜、不产条目——
 * 对齐 probes.mjs treeHash 的 os.walk（followlinks=False）语义；文件符号链接按目标内容
 * 哈希（两侧一致），成环目录天然免疫（评审 C1 修复）。
 * @param {string} root 目录根
 * @returns {Array<{rel: string, sha256: string}>} 按 rel 排序
 */
export function buildExpectTree(root) {
  const out = [];
  const walk = (dir, base) => {
    // 遍历序排序对齐 probes 的 dns.sort()/fns.sort() 形态；最终输出序由下方全序排序承载
    for (const name of readdirSync(dir).sort()) {
      const rel = base === '' ? name : `${base}/${name}`;
      if (IGNORED(rel)) continue;
      const full = join(dir, name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        // 目录链接整棵跳过（followlinks=False 同构）；悬挂链接无目标内容可哈希、同样不产条目
        // （内部任务-276 D4：此前悬挂链接 statSync 抛 ENOENT 穿透，verify 整体崩退 2、七面报告零输出）
        let target = null;
        try { target = statSync(full); } catch (e) {
          // 只吞 ENOENT（悬挂链接无目标内容可哈希）；EACCES/ELOOP 等真实读面故障照旧抛出，
          // 由 tryBuildExpectTree 折叠为面 problem（评审 correctness-3：吞全部异常会 fail-open 假绿）
          if (e && e.code === 'ENOENT') continue;
          throw e;
        }
        if (target.isDirectory()) continue;
        out.push({ rel, sha256: sha256OfFile(full) }); // 文件链接按目标内容哈希（两侧一致）
        continue;
      }
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out.push({ rel, sha256: sha256OfFile(full) });
    }
  };
  walk(root, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 已收集条目的树哈希（编帧同 treeHash，免二次走盘）。
 * @param {Array<{rel: string, sha256: string}>} entries
 * @returns {string} 裸 hex
 */
export function treeHashOfEntries(entries) {
  const framed = entries.map((e) => `${e.rel}\n${e.sha256}\n`).join('');
  return sha256OfBuffer(Buffer.from(framed, 'utf8'));
}

/**
 * 目录树哈希（与 probes.mjs treeHash 同构编帧：排序 (rel,sha) 逐行 `rel\nsha\n` join 后整体 sha256）。
 * @param {string} root 目录根
 * @returns {string} 裸 hex
 */
export function treeHash(root) {
  return treeHashOfEntries(buildExpectTree(root));
}

/**
 * 两棵期望树的三分类比对。
 * @param {Array<{rel: string, sha256: string}>} expected 期望侧
 * @param {Array<{rel: string, sha256: string}>} actual 实际侧
 * @returns {{missing: string[], extra: string[], changed: string[]}}
 */
export function diffTrees(expected, actual) {
  const a = new Map(expected.map((e) => [e.rel, e.sha256]));
  const b = new Map(actual.map((e) => [e.rel, e.sha256]));
  const missing = [];
  const changed = [];
  for (const [rel, sha] of a) {
    if (!b.has(rel)) missing.push(rel);
    else if (b.get(rel) !== sha) changed.push(rel);
  }
  const extra = [...b.keys()].filter((rel) => !a.has(rel));
  return { missing: missing.sort(), extra: extra.sort(), changed: changed.sort() };
}

/**
 * buildExpectTree 的安全包装：读面失败（权限/IO/路径被同名文件占用）折叠为 problem 返回、不抛，
 * 调用方落面红退 1。内部任务-276 D4/D5：此前裸 I/O 异常穿透到 CLI 兜底（用法错档）且七面报告零输出。
 * @param {string} root 目录根
 * @returns {{tree: Array<{rel: string, sha256: string}>, problem: string|null}}
 */
export function tryBuildExpectTree(root) {
  try {
    return { tree: buildExpectTree(root), problem: null };
  } catch (e) {
    return { tree: [], problem: `期望树不可读：${root}（${e.message}）` };
  }
}
