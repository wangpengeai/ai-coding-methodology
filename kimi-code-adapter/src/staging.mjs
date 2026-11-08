// 文件：kimi-code-adapter/src/staging.mjs
// 描述：`--staging <目录>` 兜底通道的产物：marketplace JSON（官方通道形态，经
//       `/plugins marketplace <source>` 或 KIMI_CODE_PLUGIN_MARKETPLACE_URL 消费）+
//       六个包落暂存目录。marketplace 实样结构（设计文档 §2.7 本机核读）：
//       `{"version":"2","plugins":[{"id","displayName","source"}]}`——source 字段指向六包相对
//       staging 根的 `./<id>` 路径。写面只有目标目录；不经 installed.json（staging 路径只产
//       六包 + marketplace JSON，内部决策-038 决策 2）。
//       displayName **不查表**（内部任务-5 B，R-ka-10）：buildMarketplaceJson 消费已规划包的
//       `{id, manifest}` 数组，取包清单 `interface.displayName`（其源头＝中立清单
//       `displayName`），缺省回落稳定 slug（id）——包/市场展示同源，本模块零名称表。
// 作者：wangp  创建：2026-10-05  版权：MIT（见 workflow/LICENSE）
// 依据：内部设计记录 §2.7/§5

/**
 * 生成 marketplace JSON（version 恒 "2"；source=六包相对 staging 根的 `./<id>`）。
 * @param {{id: string, manifest: {interface?: {displayName?: unknown}}}[]} entries 已规划包条目（id + 包清单）
 * @returns {{version: string, plugins: {id: string, displayName: string, source: string}[]}}
 */
export function buildMarketplaceJson(entries) {
  return {
    version: '2',
    plugins: entries.map(({ id, manifest }) => {
      const display = manifest?.interface?.displayName;
      return {
        id,
        displayName: typeof display === 'string' && display.trim() !== '' ? display : id,
        source: `./${id}`,
      };
    }),
  };
}

/**
 * 按宿主实样判据校验 marketplace JSON（version "2" / plugins 数组 / 三键齐备）。
 * @param {unknown} doc marketplace 对象
 * @returns {string[]} 违规描述（空数组 = 合规）
 */
export function validateMarketplaceJson(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['marketplace 不是对象'];
  if (doc.version !== '2') problems.push(`marketplace version 须为 "2"：${String(doc.version)}`);
  if (!Array.isArray(doc.plugins)) problems.push('marketplace plugins 必须是数组');
  else {
    for (const entry of doc.plugins) {
      if (!entry || typeof entry !== 'object') {
        problems.push('marketplace 条目必须是对象');
        continue;
      }
      for (const key of ['id', 'displayName', 'source']) {
        if (typeof entry[key] !== 'string' || entry[key].trim() === '') problems.push(`marketplace 条目缺 ${key}`);
      }
    }
  }
  return problems;
}
