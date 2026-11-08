// 文件：check-residuals.mjs
// 描述：gstack/旧形态残留扫描 lint（B-M2-3、B-M3-3、B-M6-2、内部接口-8）——递归扫描
//       Markdown 文本，行级匹配红线模式并输出 file:line 定位；这是 内部验收-2/内部验收-3/内部验收-2
//       验收的"自动化文本扫描"锁定方式。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 用法：node workflow/scripts/check-residuals.mjs <dir>（缺省 workflow/）
// 退出码：0=干净；1=存在残留违例；2=目录不存在或环境错误。
// 说明：lint 本身就是检查器，发现违例必须非 0 退出——不适用 fail-open（与业务钩子相反）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 红线模式清单：每条注明对应的规格红线编号，报告输出与验收条目一一对应。
 * 为什么逐条列出而非合并成一个大正则：违例报告需要指明违反哪条红线，便于修复定位。
 * @type {Array<{ re: RegExp, tag: string, why: string }>}
 */
const PATTERNS = [
  // B-M2-3：抽取件禁止残留 gstack- 前缀引用（命令/目录/子模块触点）
  { re: /gstack-[a-z-]+/, tag: 'gstack-ref', why: 'B-M2-3 gstack- 前缀引用残留' },
  // B-M6-2：禁止 ~/.gstack 全局路径（gstack 私有目录触点，一律改项目内路径）
  { re: /~\/\.gstack/, tag: 'gstack-path', why: 'B-M6-2 ~/.gstack 全局路径残留' },
  // B-M3-3：禁止 greptile 对抗评审引用（ZCode 无对应 CLI，触点删除）
  { re: /greptile/i, tag: 'greptile', why: 'B-M3-3 greptile 对抗评审引用残留' },
  // B-M3-3：禁止 codex-probe 触点（同上，外部 CLI 依赖一律裁剪）
  { re: /codex-probe/i, tag: 'codex-probe', why: 'B-M3-3 codex-probe 触点残留' },
  // 内部规则-7：gstack review-log 日志触点全部删除（评审结论走项目内文档与 OPEN-n）
  { re: /gstack-review-log/, tag: 'gstack-review-log', why: 'R-M3-7 gstack-review-log 触点残留' },
  // 内部规则-7：gstack decision-log 日志触点全部删除（同理）
  { re: /gstack-decision-log/, tag: 'gstack-decision-log', why: 'R-M3-7 gstack-decision-log 触点残留' },
  // B-M6-2：learnings 的 jsonl 私有格式已改为项目内 markdown，禁止回潮
  { re: /learnings\.jsonl/, tag: 'learnings-jsonl', why: 'B-M6-2 learnings.jsonl 存储格式残留' },
  // gstack preamble 模板占位符：{{VAR}} 形态一律视为未裁剪干净（内部证据-23 触点删除原则）
  { re: /\{\{[A-Z_]+\}\}/, tag: 'template-placeholder', why: '模板占位符 {{VAR}} 残留（preamble 裁剪红线）' },
  // 内部接口-8：自由文本待办标记禁止——词边界防误伤 TODOS/TODAY 等（同 spec-gate TODO_TOKEN 思路）
  { re: /\b(TODO|TBD|FIXME)\b/, tag: 'todo-token', why: 'IF-COLLAB-8 自由文本待办标记' },
];

/**
 * 递归收集目录下全部 .md 文件。
 * 为什么跳过 node_modules 与点目录：依赖与工具私有目录不属于受检文本集，
 * 且点目录（如 .zcode-plugin/.git）是宿主/版本库资产，不是本插件的落盘文档。
 * @param {string} dir 目录路径
 * @param {string[]} acc 累积结果（递归传递）
 * @returns {string[]} .md 文件绝对/相对路径列表（按遍历序）
 */
function collectMarkdown(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue; // 点目录整体跳过
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectMarkdown(p, acc);
    else if (p.endsWith('.md')) acc.push(p);
  }
  return acc;
}

/**
 * 扫描单个文件：逐行匹配全部模式，返回违例描述数组。
 * 为什么行级而非全文匹配：报告需要 file:line 定位，行级也让"一行多处违例"可见。
 * @param {string} file 文件路径
 * @returns {Array<{ file: string, line: number, tag: string, why: string, source: string }>}
 */
function scanFile(file) {
  const hits = [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n'); // CRLF 残留的 \r 对模式匹配无影响，不额外归一
  lines.forEach((line, i) => {
    for (const pat of PATTERNS) {
      if (pat.re.test(line)) {
        hits.push({ file, line: i + 1, tag: pat.tag, why: pat.why, source: pat.re.source });
      }
    }
  });
  return hits;
}

/**
 * 主入口：解析参数 → 校验目录 → 扫描 → 输出与退出。
 * @returns {void}
 */
function main() {
  const root = process.argv[2] ?? 'workflow'; // 缺省 workflow/：本插件自身的受检根
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`错误：目录不存在或不是目录：${root}\n`);
    process.exit(2);
  }
  const hits = [];
  try {
    for (const f of collectMarkdown(root)) hits.push(...scanFile(f));
  } catch (err) {
    // 环境错误（权限/编码）与"文本干净"必须区分：环境错误退 2，不冒充通过
    process.stderr.write(`错误：扫描失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (hits.length === 0) {
    // 干净结论走 stdout：stderr 只承载违例与错误，避免 CI 日志误读
    process.stdout.write(`残留扫描：干净（${PATTERNS.length} 条红线模式，0 命中）\n`);
    process.exit(0);
  }
  for (const h of hits) {
    process.stderr.write(`${h.file}:${h.line}: ${h.source} [${h.why}]\n`);
  }
  process.stderr.write(`残留扫描：${hits.length} 处违例\n`);
  process.exit(1);
}

main();
