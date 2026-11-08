// 文件：tolerance.mjs
// 描述：格式容差判据单源（内部决策-051 D4）——阶段3 后仍被消费的只有三项：时间戳格式正则、
//       偏移解析与 $special 解包（common.test.mjs 等消费）。对拍断言器
//       `assertParityEqual`/`TOLERANCE_RULES` 的窗口消费者（parity-*.test.mjs）已随
//       Python 面拆除，长期零消费者＝死代码；内部任务-241 T08/步骤17 本批删除并收敛文件头。
// 作者：wangp  创建：2026-10-17  版权：MIT（见 spec-gate/LICENSE）

/** 时间戳族格式：本地时区带偏移、秒级（对齐 common.nowIso 的 isoformat(timespec="seconds") 形态）。 */
export const ISO_OFFSET_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/**
 * ISO 偏移段 → 偏移分钟数（'+08:00'→480、'-05:30'→-330）。单源导出——G3/P6 消费，
 * 勿在测试内联第二份（终审简洁性发现 1：两处内联公式发散且一版对负偏移整式翻号）。
 * @param {string} s 含 ±HH:MM 偏移段的时间戳串
 * @returns {number}
 */
export function isoOffsetMinutes(s) {
  const hh = Number(s.slice(-6, -3));
  const mm = Number(s.slice(-2));
  const sign = s.slice(-6, -3).startsWith('-') ? -1 : 1;
  return hh * 60 + mm * sign;
}

/**
 * 黄金向量 $special 包装解包：向量文件承载合法 JSON（NaN/Infinity 不是合法 JSON 字面量），
 * 解包后才还原浮点特殊值——与 gen_golden.py 的 _unwrap 同协议（Python 侧单源，本函数为
 * JS 侧单源：common.test.mjs 消费，勿在测试文件内重造）。
 * @param {unknown} value
 * @returns {unknown}
 */
export function unwrapSpecial(value) {
  if (Array.isArray(value)) return value.map(unwrapSpecial);
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$special') {
      if (value.$special === 'nan') return Number.NaN;
      if (value.$special === 'inf') return Infinity;
      if (value.$special === '-inf') return -Infinity;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapSpecial(v)]));
  }
  return value;
}
