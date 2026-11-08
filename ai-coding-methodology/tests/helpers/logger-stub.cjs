// 文件：logger-stub.cjs
// 描述：cordis logger 的忠实测试替身。**为什么必须按 printf 协议实现**：cordis 源码
//       （`cordis/src/logger.ts`）把每个级别方法定型为 `LoggerMethod = (format, ...param)`，
//       即 `logger.warn('%s', msg)` 形态。此前各测试文件里的替身写成 `warn: (m) => arr.push(m)`
//       ——**只记不格式化**，于是适配层改用 printf 协议后，`logWarn()` 因为 `typeof fn === 'function'`
//       的守卫仍在，实际是被调用了、只是替身把它当成了"整条消息"，断言随之失配；更坏的是若
//       替身连函数都不是（`{}`），日志会被静默吞掉而测试照样绿。
//       本替身实现最小 printf（仅 `%s`/`%d`/`%%`，够用且不引第三方），并把格式化后的整条
//       消息交给调用方断言。扩展名刻意用 `.cjs`：Node 的测试发现只认 `.test.*`，故本文件
//       不会被当成测试文件执行。
// 作者：wangp  创建：2026-09-28  版权：MIT（见仓库 LICENSE）
'use strict';

/**
 * 极简 printf：支持 %s / %d / %i / %% ；参数不足时保留原样占位符（与常见实现一致）。
 * @param {string} format
 * @param {unknown[]} args
 * @returns {string}
 */
function formatMessage(format, args) {
  let index = 0;
  return String(format).replace(/%[sdif%]/g, (match) => {
    if (match === '%%') return '%';
    if (index >= args.length) return match;
    const value = args[index];
    index += 1;
    return String(value);
  });
}

/**
 * 造一个 cordis 形态的 logger 替身（同时记录格式化后的消息）。
 * @returns {{error: Function, info: Function, warn: Function, debug: Function,
 *   messages: string[], byLevel: (level: string) => string[]}}
 */
function createLogger() {
  const messages = [];
  const make = (level) => (format, ...args) => {
    messages.push({ level, text: formatMessage(format, args) });
  };
  return {
    error: make('error'),
    info: make('info'),
    warn: make('warn'),
    debug: make('debug'),
    messages,
    byLevel: (level) => messages.filter((m) => m.level === level).map((m) => m.text),
  };
}

module.exports = { createLogger, formatMessage };
