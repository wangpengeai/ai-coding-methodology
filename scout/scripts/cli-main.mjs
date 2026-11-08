// 文件：cli-main.mjs
// 描述：scout CLI 三脚本（mode-lifecycle/mode-state/check-consistency）的共享入口原语
//       （内部决策-065 D-9/D-8 步骤 6 结构重构 + T13/T14 步骤 7 CLI 行为）——「是否直接运行」
//       判定（symlink 形态归一＝内部未决-52，内部任务-44）、`--project-root` 任意位置解析（内部任务-86）、
//       旗标白名单/两形态（`--flag value`/`--flag=value`）/缺值拒绝（T13）、JSON 输出。
//       T14 约定：成功/内容阻断经 `process.exitCode` 收尾（不立即 exit）；工具错误由各脚本
//       顶层 catch 转 `{ok:false,code:'tool-error',error}` 后 exitCode=2。
// 作者：wangp 创建：2026-10-31 版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 是否以入口脚本方式直接运行（resolve 两侧对齐 + symlink realpath 归一）。
 * 单源判定：三脚本不得各自复制 realpath 归一比较逻辑。
 * @param {string} metaUrl 调用方 `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  try {
    if (!process.argv[1]) return false;
    const self = fileURLToPath(metaUrl);
    if (resolve(process.argv[1]) === self) return true;
    return resolve(realpathSync(process.argv[1])) === self;
  } catch {
    return false;
  }
}

/**
 * 解析 `--project-root <dir>` / `--project-root=<dir>`（T13：任意位置；缺值/空值/尾随旗标用法错误）。
 * @param {string[]} argv
 * @returns {{root: string|null, rest: string[]}|null} null=用法错误；root=null 表示未提供
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
 * 解析旗标（T13）：`--flag value` 与 `--flag=value` 两形态；`booleans` 列出的旗标不接受 `=值`
 * （`--force=false` 判用法错误，不得以 truthy 字符串绕过安全开关）；flags 用无原型对象防 `--__proto__` 漏检。
 * @param {string[]} argv
 * @param {{booleans?: string[]}} [opts]
 * @returns {{positionals: string[], flags: Record<string, string|boolean>, invalid: string|null}}
 */
export function parseFlags(argv, { booleans = [] } = {}) {
  const positionals = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    let name;
    let value;
    let consumed = false;
    if (a.includes('=')) {
      const eq = a.indexOf('=');
      name = a.slice(2, eq);
      value = a.slice(eq + 1);
      if (value === '') return { positionals, flags, invalid: `旗标 --${name} 缺少值` };
      if (booleans.includes(name)) return { positionals, flags, invalid: `布尔旗标 --${name} 不接受 =值` };
      // `--flag=value` 不消费下一个 argv（consumed 保持 false）
    } else {
      name = a.slice(2);
      if (booleans.includes(name)) {
        value = true;
      } else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { positionals, flags, invalid: `旗标 --${name} 缺少值` };
        }
        consumed = true;
      }
    }
    flags[name] = value;
    if (consumed) i += 1;
  }
  return { positionals, flags, invalid: null };
}

/**
 * 输出 JSON 一行并设置退出码（T14：用 `process.exitCode`，不立即 exit，便于调用方收尾/测试内省）。
 * @param {unknown} result
 * @param {{code?: number}} [opts]
 */
export function emitJson(result, { code } = {}) {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (code !== undefined) process.exitCode = code;
}
