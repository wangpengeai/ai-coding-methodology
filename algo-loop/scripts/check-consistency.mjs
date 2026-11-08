// 文件：check-consistency.mjs
// 描述：.algo/ 五件一致性 lint（只读、非 hook、不 fail-open：违例如实退 1）+ CLI 严格参数面（内部任务-269 批）——
//       蓝本 scout/scripts/check-consistency.mjs：文本输出 consistent:/violation:，退出码 0/1/2；
//       覆盖：内部接口-22 跨件一致性 + 坏行计数可见（不自动修）+ 甲案既成态兜底（台账行存在而 toolchain 未补齐）
//       + 基线 fromIteration 悬空 + 损坏件字段级呈报（corruptDetails）。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：CLI 严格参数（cli-args；未知/缺值/根守卫退 2）、
//           损坏呈报消费 corruptDetails、toolchain.command+version 同权、fromIteration 悬空违例、工具错误顶层 catch 退 2。
// 自检：node algo-loop/scripts/check-consistency.mjs --selftest
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { readAlgoState, parseLedgerText, readJsonStrict } from './algo-state.mjs';
import { isMainModule, parseProjectRootArg, resolveExistingRoot } from './cli-args.mjs';

function parseLedgerRows(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseLedgerText(text).rows;
}

/** 返回违例数组（空=一致）。未立项（absent）返回 []——立项是显式动作，缺 .algo/ 非违例。
 *  导出面为 P2 门禁机械化预留消费点（内部决策-046 分期；当前仓内消费方=本 CLI 与测试）。 */
export function findViolations(root) {
  const algo = join(root, '.algo');
  const state = readAlgoState(root);
  if (!state.present && state.reason === 'absent') return [];
  const v = [];
  if (state.corrupt.length > 0) {
    // 损坏资产呈报：件名 + 字段级细节（corruptDetails，内部接口-22 §4；内部任务-269 R09）
    const detailByFile = new Map((state.corruptDetails || []).map((d) => [d.file, d.errors]));
    const rendered = state.corrupt.map((file) => {
      const errors = detailByFile.get(file);
      return errors && errors.length > 0 ? `${file}（${errors.slice(0, 6).join('；')}）` : file;
    });
    v.push(`损坏资产（停下报修，不自动修）：${rendered.join('、')}`);
  }
  if (state.badLines > 0) v.push(`台账含 ${state.badLines} 条坏行（不可解析或 schema 不合规；可见呈报，不自动修）`);
  if (!existsSync(join(algo, 'contract.json')) || !existsSync(join(algo, 'project.json'))) return v;
  let project;
  let contract;
  try {
    project = readJsonStrict(join(algo, 'project.json'));
    contract = readJsonStrict(join(algo, 'contract.json'));
  } catch {
    return v;
  }
  if (project === null || typeof project !== 'object' || contract === null || typeof contract !== 'object') return v;
  if (project.contractVersion !== contract.version) {
    v.push(`契约版本失配：project.contractVersion=${project.contractVersion} ≠ contract.version=${contract.version}`);
  }
  const rows = parseLedgerRows(join(algo, 'ledger.jsonl'));
  const ledgerIds = new Set(rows.map((row) => row.id));
  let baselines = null;
  if (existsSync(join(algo, 'baselines.json'))) {
    try {
      baselines = readJsonStrict(join(algo, 'baselines.json'));
    } catch {
      baselines = null;
    }
  }
  if (baselines !== null && typeof baselines === 'object' && Array.isArray(baselines.entries)) {
    const ids = new Set(baselines.entries.map((e) => (e !== null && typeof e === 'object' ? e.id : null)));
    if (typeof contract.baselineRef === 'string' && contract.baselineRef !== '' && !ids.has(contract.baselineRef)) {
      v.push(`契约基线引用悬空：baselineRef=${contract.baselineRef} 不在 baselines 条目中`);
    }
    // 基线 fromIteration 悬空（B0 空串例外；内部接口-22 §2a：引用存在性只在 lint 与写侧校验）
    for (const e of baselines.entries) {
      if (e === null || typeof e !== 'object') continue;
      if (e.id === 'b0') continue;
      if (typeof e.fromIteration !== 'string' || e.fromIteration === '') continue;
      if (!ledgerIds.has(e.fromIteration)) v.push(`基线 ${e.id} 的 fromIteration 悬空：${e.fromIteration} 不在台账中`);
    }
  }
  for (const row of rows) {
    if (typeof row.metricsRef !== 'string' || row.metricsRef.trim() === '') {
      v.push(`台账行 ${row.id} 的 metricsRef 为空（指标引用缺失——归因纪律根基）`);
    }
  }
  if (rows.length > 0 && Array.isArray(contract.metrics)) {
    for (let i = 0; i < contract.metrics.length; i += 1) {
      const m = contract.metrics[i];
      const name = m !== null && typeof m === 'object' && typeof m.name === 'string' ? m.name : `metrics[${i}]`;
      const toolchain = m !== null && typeof m === 'object' && m.toolchain !== null && typeof m.toolchain === 'object' ? m.toolchain : null;
      const cmd = toolchain ? toolchain.command : undefined;
      const ver = toolchain ? toolchain.version : undefined;
      if (typeof cmd !== 'string' || cmd.trim() === '' || typeof ver !== 'string' || ver.trim() === '') {
        v.push(`测量工具链未声明：指标 ${name} 的 toolchain.command/version 未补齐，但台账已有 ${rows.length} 行（甲案：首轮台账追加前必须补齐）`);
        break;
      }
    }
  }
  return v;
}

function usage() {
  console.error('用法：node check-consistency.mjs [--project-root <目录>]（支持 --project-root=<目录>；--selftest 自检）');
}

function runSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'algo-cons-selftest-'));
  try {
    const run = spawnSync(process.execPath, [process.argv[1], '--project-root', root], { encoding: 'utf8' });
    const okFlag = run.status === 0 && run.stdout.includes('consistent');
    console.log(`${okFlag ? 'PASS' : 'FAIL'} 空根（未立项）读取 consistent 退 0`);
    if (!okFlag) process.exit(1);
    console.log('SELFTEST OK check-consistency');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--selftest') {
    runSelftest();
    return;
  }
  const parsed = parseProjectRootArg(args);
  if (parsed === null || parsed.rest.length > 0) {
    usage();
    process.exit(2);
  }
  const rootRes = resolveExistingRoot(parsed.root);
  if (!rootRes.ok) {
    console.error(`用法错误：${rootRes.reason}`);
    process.exit(2);
  }
  let v;
  try {
    v = findViolations(rootRes.root);
  } catch (err) {
    console.error(`工具错误：${err && err.message ? err.message : String(err)}`);
    process.exit(2);
  }
  if (v.length === 0) {
    console.log(`consistent: .algo/ 五件一致性通过（项目根 ${rootRes.root}）`);
    return;
  }
  console.log(`violation: ${v.length} 项（逐条见下）`);
  for (const item of v) console.log(`  - ${item}`);
  process.exit(1);
}

if (isMainModule(import.meta.url)) main();
