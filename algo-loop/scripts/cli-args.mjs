// 文件：cli-args.mjs
// 描述：algo-loop CLI 共享参数解析与项目根守卫（内部任务-269 R08）——`isMainModule` 入口守卫、
//       `parseProjectRootArg`（`--project-root <dir>` 与 `--project-root=<dir>` 两形态；缺值/空值/
//       尾随旗标判用法错误）、`resolveExistingRoot`（根必须存在且为目录，写侧不创建根）。
//       口径对齐 scout cli-main（T13）与 内部接口-22 §3；本模块零第三方依赖、只读。
// 作者：wangp 创建：2026-11-01 版权：MIT（见 algo-loop/LICENSE）
// 自检：node --test "algo-loop/scripts/tests/cli-args.test.mjs"
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 入口守卫：当前模块是否被直接执行（ESM 主模块判定，symlink 形态归一）。
 * 为什么需要：三个 CLI 入口共用同一判定，避免复制带 realpath 归一的三份实现。
 * @param {string} metaUrl 模块 `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(metaUrl);
    const invoked = resolve(process.argv[1]);
    if (invoked === self) return true;
    return resolve(realpathSync(process.argv[1])) === resolve(realpathSync(self));
  } catch {
    return false;
  }
}

/**
 * 解析 `--project-root <dir>` / `--project-root=<dir>`（任意位置）。
 * 用法错误（返回 null，调用方退 2）：缺值、空值、值以 `--` 起笔（尾随旗标）。
 * 其余未知参数/位置参数按原序收入 `rest`，由调用方按命令面判定是否为用法错误。
 * @param {string[]} argv
 * @returns {{root: string|null, rest: string[]}|null}
 */
export function parseProjectRootArg(argv) {
  const rest = [];
  let root = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project-root') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) return null;
      root = v;
      i += 1;
    } else if (a.startsWith('--project-root=')) {
      const v = a.slice('--project-root='.length);
      if (v === '') return null;
      root = v;
    } else {
      rest.push(a);
    }
  }
  return { root, rest };
}

/**
 * 项目根守卫：缺省 cwd；根必须存在且为目录（写侧不创建根；读侧对不存在的根给用法错误而非假绿）。
 * @param {string|null} rootArg 解析出的 `--project-root` 值（null=cwd）
 * @returns {{ok: true, root: string}|{ok: false, reason: string}}
 */
export function resolveExistingRoot(rootArg) {
  const root = resolve(rootArg === null || rootArg === undefined ? process.cwd() : String(rootArg));
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ok: false, reason: `项目根不存在或不是目录：${root}` };
    }
    return { ok: true, root };
  } catch (err) {
    return { ok: false, reason: `项目根不可读：${root}（${err && err.code ? err.code : String(err)}）` };
  }
}
