// 文件：jsonl.mjs
// 描述：JSONL 容错读单源（内部任务-257 批 5 P5-2）——坏行跳过并计数，仅提供读面；不引入 id 折叠语义
//       （learning 首条 / incident 末条折叠留调用点自行决定）。写入面按 P5-1 原子写/append 处理。
// 作者：wangp  创建：2026-10-30  版权：MIT（见 team-governance/LICENSE）

/**
 * 容错解析 JSONL 文本。
 * @param {string} text
 * @returns {{records: Array<object>, badLines: number}}
 */
export function readJsonlTolerant(text) {
  const records = [];
  let badLines = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d === 'object') records.push(d);
      else badLines += 1;
    } catch { badLines += 1; }
  }
  return { records, badLines };
}
