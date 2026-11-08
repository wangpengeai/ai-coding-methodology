// 文件：log.mjs
// 描述：适配层唯一的日志出口。为什么需要它：cordis 的 logger 是 **printf 风格**
//       （源码 `cordis/src/logger.ts`：`LoggerMethod = (format: any, ...param: any[])`），
//       直接传模板串会被当**格式串**解释——消息里若含 `%d`/`%s`（例如带 `%` 的路径或
//       URI 编码错误文本）就会被错误替换或丢参。故所有日志统一以 `'%s'` 作格式、
//       整条消息作参数，消息永不被当格式串。
//       另外：这里吞掉所有日志异常（logger 缺失、级别方法被禁）——适配层 fail-open 姿态
//       不允许"记日志失败"反噬业务路径。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）

/**
 * 按级别安全记一行日志。
 * @param {object} logger cordis logger（或测试替身；可为 undefined）
 * @param {'error'|'info'|'warn'|'debug'} level 级别（cordis 的 LoggerType 四值之一）
 * @param {string} message 完整消息（不做格式化）
 */
export function logLine(logger, level, message) {
  try {
    const fn = logger?.[level];
    if (typeof fn === 'function') fn.call(logger, '%s', String(message));
  } catch {
    /* 日志失败不反噬（与钩子 fail-open 同姿态） */
  }
}

/**
 * 以 `info` 级记一行（`logLine(logger, 'info', …)` 的简写）。
 * @param {object} logger cordis logger（或测试替身；可为 undefined）
 * @param {string} message 完整消息（不做格式化）
 * @returns {void}
 */
export function logInfo(logger, message) {
  logLine(logger, 'info', message);
}

/**
 * 以 `warn` 级记一行（`logLine(logger, 'warn', …)` 的简写）。
 * @param {object} logger cordis logger（或测试替身；可为 undefined）
 * @param {string} message 完整消息（不做格式化）
 * @returns {void}
 */
export function logWarn(logger, message) {
  logLine(logger, 'warn', message);
}
