// 文件：collect-common.mjs
// 描述：OS 采集器共享尾段单源（内部任务-257 批 5 P5-3）——样本追加 + 7 天保留清理 + 采集失败留痕。
//       部署面：与 collect-linux/collect-darwin 同目录拷贝（os-observe-tasks 与相关测试夹具同步）。
// 作者：wangp  创建：2026-10-30  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 追加当日样本并清理超期保留文件（默认 7 天；与 collect.ps1 同口径）。
 * @param {string} rawDir
 * @param {string[]} lines
 * @param {{keepDays?: number, now?: number}} [opts]
 */
export function appendSamplesAndPrune(rawDir, lines, { keepDays = 7, now = Date.now() } = {}) {
  const d = new Date(now);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  if (Array.isArray(lines) && lines.length > 0) {
    appendFileSync(join(rawDir, `samples-${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }
  const cutoff = now - keepDays * 24 * 3600_000;
  let files = [];
  try { files = readdirSync(rawDir); } catch { return; }
  for (const f of files) {
    if (!/^samples-.*\.jsonl$/.test(f)) continue;
    try { if (statSync(join(rawDir, f)).mtimeMs < cutoff) rmSync(join(rawDir, f), { force: true }); } catch { /* 竞态容忍 */ }
  }
}

/**
 * 采集失败留痕（best-effort；读取面据此给「采集失败」从句，不冒充无数据）。
 * @param {string} rawDir
 * @param {string} phase
 * @param {unknown} error
 */
export function writeCollectorFailure(rawDir, phase, error) {
  try {
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, 'last-error.json'), JSON.stringify({
      ts: new Date().toISOString(), phase, error: String(error?.message ?? error).slice(0, 500),
    }) + '\n', 'utf8');
  } catch { /* 留痕失败不阻断 */ }
}
