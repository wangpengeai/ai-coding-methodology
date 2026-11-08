// 文件：plugin-core 测试共享夹具
// 描述：tempRoot（realpath 归一）/ removeRoot / writeFile / REPO_ROOT 解析；写面仅限 os.tmpdir()
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：import { tempRoot, removeRoot, writeFile, REPO_ROOT } from './helpers.mjs'
// 自检：无（本件为测试固件）
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

export function tempRoot(tag) {
  // darwin /var 为 symlink，不归一会击穿 ESM 入口守卫（mcode-adapter/tests/helpers.mjs 同款实录）
  return realpathSync(mkdtempSync(join(tmpdir(), `plugin-core-${tag}-`)));
}

export function removeRoot(root) {
  if (root && root.startsWith(realpathSync(tmpdir()))) rmSync(root, { recursive: true, force: true });
}

export function writeFile(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}
