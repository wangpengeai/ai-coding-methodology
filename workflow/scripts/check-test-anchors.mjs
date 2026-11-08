// 文件：check-test-anchors.mjs
// 描述：设计—测试锚定仓检查器（内部决策-060 / 内部任务-225）——位置参数用 `--project-root`／`--registry`
//       指定仓根与基线 registry；只读解析模块分册 §6 验收表、测试用例标题索引与 registry，
//       输出 JSON `{ok,violations,coverage,summary}`（或 `--format md` 人读表格）。
//       退出码（优先级 2 > 1 > 0）：2＝工具/配置错误（缺 registry/坏 JSON/缺 内部规格
//       参数非法）；1＝存在违规；0＝全过。契约边界：检查器自身无写模式（基线由共享库实算后
//       经 Edit/Write 落盘）；不进 spec-gate core 校验器（内部规则-9 哈希冻结）。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildTestIndex,
  formatMarkdownReport,
  loadRegistry,
  parseSpecs,
  validateRegistry,
} from './lib/test-anchors-lib.mjs';

const USAGE = '用法：node workflow/scripts/check-test-anchors.mjs [--project-root <dir>] [--registry <path>] [--format json|md]';

class ToolError extends Error {}

function parseArgs(argv) {
  const opts = { projectRoot: process.cwd(), registry: 'specs/test-anchors.json', format: 'json' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    if (a === '--project-root') { opts.projectRoot = argv[i + 1]; i += 1; continue; }
    if (a === '--registry') { opts.registry = argv[i + 1]; i += 1; continue; }
    if (a === '--format') { opts.format = argv[i + 1]; i += 1; continue; }
    throw new ToolError(`未知参数：${a}（${USAGE}）`);
  }
  if (!opts.projectRoot) throw new ToolError(`--project-root 缺值（${USAGE}）`);
  if (!opts.registry) throw new ToolError(`--registry 缺值（${USAGE}）`);
  if (!['json', 'md'].includes(opts.format)) throw new ToolError(`--format 须为 json|md（实际 ${opts.format}）`);
  const root = resolve(opts.projectRoot);
  return { root, registryPath: resolve(root, opts.registry), format: opts.format };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ToolError) { process.stderr.write(`check-test-anchors: ${e.message}\n`); return 2; }
    throw e;
  }
  const { root, registryPath, format } = args;
  try {
    if (!existsSync(join(root, 'specs', 'modules'))) {
      throw new ToolError(`specs/modules 不存在（project-root=${root}）——无可校验的规格验收面`);
    }
    if (!existsSync(registryPath)) {
      throw new ToolError(`registry 不存在：${registryPath}（配置错误；基线登记册须随批落盘）`);
    }
    const registry = loadRegistry(registryPath);
    // 内部任务-348/内部未决-180⑤：CLI 只判对象形态（null/数组/标量＝配置错误退 2——内部决策-060 修正案 2
    // 决策 9 钉死「缺 registry/坏 JSON＝exit 2」；S2 门评审发现 2：schema 级违规不前置退 2，
    // 经 validateRegistry 内部展开 shape violations 以 exit 1 报出——退码契约与 内部任务-225 落地面等价）
    if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new ToolError(`registry 形态非法（须为 JSON 对象；null/数组/标量即 fail-loud）：${registryPath}`);
    }
    const specs = parseSpecs(root);
    const testIndex = buildTestIndex(root);
    const report = validateRegistry({ projectRoot: root, registry, specs, testIndex });
    if (format === 'md') process.stdout.write(`${formatMarkdownReport(report)}\n`);
    else process.stdout.write(`${JSON.stringify({ ok: report.ok, violations: report.violations, coverage: report.coverage, summary: report.summary }, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof ToolError) { process.stderr.write(`check-test-anchors: ${e.message}\n`); return 2; }
    process.stderr.write(`check-test-anchors: 工具错误：${e.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
