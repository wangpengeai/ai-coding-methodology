// 文件：session-start.mjs
// 描述：algo-loop SessionStart 钩子 —— 迭代摘要注入（内部模块-18 内部规则-8）+ 字段级损坏报修（内部任务-269 批）——
//       姿态 fail-open（main().catch 静默退 0，硬规则 4）；仅 additionalContext，不产 deny/ask；
//       分支全序：corrupt 报修（含 corruptDetails 字段级细节）> 合法摘要（坏行计数行按需附加）>
//       absent 静默（无轻提醒——立项是显式动作，内部接口-22 §4）。
//       本钩不读 stdin 负载（同 scout 先例：注入只依赖项目根状态）；以行名「算法迭代行」指代路由，不嵌行号字面量（内部决策-4）。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：报修行消费 corruptDetails（文件:字段级错误）；baselines 空态与损坏态措辞区分；
//           selftest 断言化（absent/合法/损坏三态，失败退 1）。
// 自检：node algo-loop/hooks/session-start.mjs --selftest
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isMainModule } from '../scripts/cli-args.mjs';

/** 从宿主环境取项目根（四级兜底，scout 同款）。 */
export function projectRoot() {
  // 四级根（scout/hooks/session-start.mjs 同款）
  return process.env.ZCODE_PROJECT_DIR || process.env.QODER_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** 输出 SessionStart 信封（仅 additionalContext，不产 deny/ask）。 */
export function envelope(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/** 合法摘要行（四要素 + 坏行计数按需附加）。 */
export function summaryLines(state) {
  const lines = ['【algo-loop】算法迭代项目已立项（路由表算法迭代行承载会话纪律）：'];
  lines.push(`- 指标契约版本：v${state.contractVersion ?? '?'}${state.corrupt.includes('contract.json') ? '（契约损坏）' : ''}`);
  if (state.currentBaseline) {
    lines.push(`- 当前基线：${state.currentBaseline.id}（metrics：${JSON.stringify(state.currentBaseline.metrics)}）`);
  } else if (state.corrupt.includes('baselines.json')) {
    lines.push('- 当前基线：不可读（baselines 损坏——见报修行）');
  } else {
    lines.push('- 当前基线：未登记（基线注册表 entries 为空）');
  }
  lines.push(`- 未闭环 bad case：${state.openBadcases} 个`);
  if (state.lastIterationAgeDays === null) {
    if (state.badLines > 0) lines.push('- 距上次迭代：台账无可解析行（含坏行，见下）');
    else lines.push('- 距上次迭代：尚无台账行（立项后未登记任何迭代）');
  } else {
    lines.push(`- 距上次迭代：${state.lastIterationAgeDays} 天`);
  }
  if (state.badLines > 0) {
    lines.push(`- 台账含 ${state.badLines} 条坏行（可见呈报，不自动修——人工处置后再继续登记）`);
  }
  return lines;
}

/** 损坏报修行（件名 + corruptDetails 字段级细节；缺明细时退化为件名）。 */
export function repairLines(state) {
  const lines = ['【algo-loop】检测到损坏资产（停下报修，不自动修——资产不静默改历史）：'];
  const detailByFile = new Map((state.corruptDetails || []).map((d) => [d.file, d.errors]));
  for (const file of state.corrupt) {
    const errors = detailByFile.get(file);
    lines.push(errors && errors.length > 0 ? `- ${file}：${errors.slice(0, 6).join('；')}` : `- ${file}`);
  }
  lines.push('处置：按 IF-COLLAB-22 §4 逐件修复（具体字段错见上；修复前停止迭代登记，不自动修）。');
  return lines;
}

/** 钩子主流程（可注入 root 供测试；宿主调用时缺省走 projectRoot()）。 */
export async function main(root = projectRoot()) {
  if (!existsSync(join(root, '.algo'))) return; // absent：零输出静默
  const { readAlgoState } = await import('../scripts/algo-state.mjs');
  const state = readAlgoState(root);
  if (!state.present) {
    if (state.reason === 'corrupt' && state.corrupt.length > 0) envelope(repairLines(state).join('\n'));
    return;
  }
  let lines = summaryLines(state);
  if (state.corrupt.length > 0) lines = [...repairLines(state), ...lines];
  envelope(lines.join('\n'));
}

async function selftest() {
  let failures = 0;
  const assert = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? `（${extra}）` : ''}`);
    if (!cond) failures += 1;
  };
  try {
    const { readAlgoState } = await import('../scripts/algo-state.mjs');
    const state = readAlgoState(process.cwd());
    assert('状态读取形态（present/corrupt/badLines 字段齐备）', typeof state.present === 'boolean' && Array.isArray(state.corrupt) && typeof state.badLines === 'number');

    const okText = summaryLines({
      contractVersion: 1,
      currentBaseline: { id: 'b0', metrics: {} },
      openBadcases: 0,
      lastIterationAgeDays: null,
      corrupt: [],
      corruptDetails: [],
      badLines: 0,
    }).join('\n');
    assert('合法摘要含四要素', okText.includes('指标契约版本') && okText.includes('当前基线') && okText.includes('未闭环') && okText.includes('距上次迭代'), okText.split('\n')[0]);

    const repairText = repairLines({
      corrupt: ['contract.json'],
      corruptDetails: [{ file: 'contract.json', errors: ['metrics 须为非空数组'] }],
    }).join('\n');
    assert('损坏报修含字段级细节', repairText.includes('contract.json') && repairText.includes('metrics') && repairText.includes('不自动修'));

    const prevWrite = process.stdout.write;
    let captured = '';
    try {
      // 仅捕获 string；非 string 块＝运行器协议帧，原样转发回原 stream（R11 同型防复发）
      process.stdout.write = (chunk, encoding, callback) => {
        if (typeof chunk === 'string') {
          captured += chunk;
          return true;
        }
        return prevWrite.call(process.stdout, chunk, encoding, callback);
      };
      envelope('selftest-context');
    } finally {
      process.stdout.write = prevWrite;
    }
    const parsed = JSON.parse(captured.trim());
    assert('信封形态（SessionStart + additionalContext）', parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'SessionStart' && parsed.hookSpecificOutput.additionalContext === 'selftest-context');
  } catch (err) {
    assert('selftest 无异常', false, err && err.message ? err.message : String(err));
  }
  if (failures > 0) {
    console.log(`FAIL session-start selftest：${failures} 条断言失败`);
    process.exit(1);
  }
  console.log('SELFTEST OK session-start (algo-loop)');
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--selftest') {
    selftest();
  } else {
    main().catch(() => process.exit(0));
  }
}
