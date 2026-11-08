// 文件：plan-text.mjs
// 描述：计划类检查器共享文本层（内部任务-348 批 D/内部未决-180①③；plan-evidence-ref.mjs 同款
//       「内部未决-180 拟议共享层」形态的第二件）——cleanForParse（frontmatter/围栏/HTML 注释
//       剥离，行保形态：剥除内容以空行占位保持行号对齐）＋STEP_HEADING_RE（新门口径：
//       `\d+[.、:：]`——日期起首标题（`## 2026-…`）不判步骤，步骤语义单源；core 侧旧门
//       分歧为登记残余）＋git 祖先（re-export routing-lib gitAncestor——host-impact
//       resolveRoot 既有消费形态）。
// 作者：wangp 创建：2026-11-07  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；纯函数零写面。
export { gitAncestor } from '../../hooks/routing-lib.mjs';

/** 步骤标题判据（新门，内部任务-348/内部未决-180③）：`\d+[.、:：]` 或步骤/step/任务/task 词头。 */
export const STEP_HEADING_RE = /^#{1,6}\s*(?:步骤|step|任务|task|\d+[.、:：])\s*/i;

/**
 * 计划文本清洗（行保形态）：剥 frontmatter 块、剥围栏代码块内容（围栏行保留为空行占位）、
 * 剥 HTML 注释——违规行号以清洗后索引与原文件行号对齐（占位不删行）。
 * 以 check-plan-test-anchors.mjs 份（行保状态机）为准收敛三份实现。
 * @param {string} text 原文
 * @returns {string} 清洗后文本（等行数）
 */
export function cleanForParse(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let fence = null;
  let inComment = false;
  for (const line of lines) {
    if (!frontmatterDone && !inFrontmatter && line.trimEnd() === '---' && out.length === 0) {
      inFrontmatter = true;
      out.push('');
      continue;
    }
    if (inFrontmatter) {
      if (line.trimEnd() === '---') inFrontmatter = false;
      out.push('');
      continue;
    }
    frontmatterDone = true;
    // S2 门复审注记 2：注释状态优先于围栏检测——多行 HTML 注释内的围栏标记行不得误开 fence
    // （否则注释闭合 `-->` 被围栏吞掉，注释后的正文围栏错位、围栏内伪节漏报）。闭合行余段
    // 继续走围栏判定（`--> ```js` 的围栏标记合法生效，对齐 design-input 旧正则形态能力面）。
    // 已知局限：闭合余段内再开注释只按字面保留（剥不净方向 fail-safe，墓碑注记登记）。
    if (inComment) {
      const close = line.indexOf('-->');
      if (close === -1) { out.push(''); continue; }
      inComment = false;
      const rest = line.slice(close + 3);
      const restFence = /^\s*(```|~~~)/.exec(rest);
      if (restFence) { fence = restFence[1]; out.push(''); continue; }
      out.push(rest);
      continue;
    }
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      out.push('');
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push('');
      continue;
    }
    const openIdx = line.indexOf('<!--');
    if (openIdx !== -1) {
      const closeIdx = line.indexOf('-->', openIdx);
      if (closeIdx === -1) { out.push(line.slice(0, openIdx)); inComment = true; continue; }
      out.push(line.slice(0, openIdx) + line.slice(closeIdx + 3));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
