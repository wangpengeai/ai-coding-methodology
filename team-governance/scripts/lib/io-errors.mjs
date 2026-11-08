// 文件：io-errors.mjs
// 描述：写侧 IO 错误分类单源（内部任务-257 批 5 P5-5）——把 errno/系统级失败与内容错区分：
//       IO/持久化失败属「工具错误」语义（CLI 退 2），业务/内容错仍退 1。
// 作者：wangp  创建：2026-10-30  版权：MIT（见 team-governance/LICENSE）

/** 视为工具错误的 IO errno 集合（POSIX 名；Node e.code 同名字符串）。 */
export const IO_ERRNO_CODES = Object.freeze(new Set([
  'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EIO', 'ENOENT',
]));

/**
 * 是否写侧/持久化 IO 错误。
 * @param {{code?: string, errno?: number|string}|string|null|undefined} e
 * @returns {boolean}
 */
export function isIoError(e) {
  if (!e) return false;
  const code = typeof e === 'string' ? e : e.code;
  return typeof code === 'string' && IO_ERRNO_CODES.has(code);
}
