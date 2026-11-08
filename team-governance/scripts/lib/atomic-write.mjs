// 文件：atomic-write.mjs
// 描述：原子写单源（内部任务-257 批 5 P5-1）——临时文件 + rename；失败清理 tmp。mkdir 由调用方保证
//       （保持既有三处调用面差异：governance-store 版自带 mkdir、run-manifest/lease 由调用方建目录）。
// 作者：wangp  创建：2026-10-30  版权：MIT（见 team-governance/LICENSE）
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * 原子写文本：写 tmp（同目录保证 rename 原子）→ rename；任一步失败清理 tmp 后抛出。
 * @param {string} absPath 目标绝对路径（目录须已存在）
 * @param {string} text
 */
export function atomicWriteText(absPath, text) {
  const tmp = `${absPath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, text); } finally { closeSync(fd); }
    renameSync(tmp, absPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 尽力清理 */ }
    throw e;
  }
}

/** 原子写 JSON（2 空格缩进 + 末尾换行，沿用既有落盘形态）。 */
export function atomicWriteJson(absPath, obj) {
  atomicWriteText(absPath, JSON.stringify(obj, null, 2) + '\n');
}
