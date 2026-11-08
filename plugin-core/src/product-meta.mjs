// 文件：套件标题常量（宿主中立）
// 描述：SUITE_NAME——套件标题的唯一派生源（内部任务-5 B，R-pc-14/内部接口-1 §6 扩展注记）。
//       各宿主适配层（DSH locale 静态标题、市场文案等）只映射该值，不得手抄第二份；
//       本文件**只此一导出**——子插件展示名归各插件 plugin.manifest.json 的可选
//       displayName（唯一人工编辑展示源），描述归清单 description，均不在此登记。
// 作者：wangp 创建：2026-10-06  版权：MIT（见 workflow/LICENSE）
// 用法：import { SUITE_NAME } from './product-meta.mjs'
// 自检：node --test "plugin-core/tests/materialize.test.mjs"（B 批用例）
/**
 * 套件标题（zh/en 两键，浅冻结防意外改写）。
 * @type {Readonly<{zh: string, en: string}>}
 */
export const SUITE_NAME = Object.freeze({
  zh: 'AI Coding 方法论',
  en: 'AI Coding Methodology',
});
