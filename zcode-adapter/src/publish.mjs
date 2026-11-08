// 文件：zcode-adapter/src/publish.mjs
// 描述：发布编排（S2 步骤 7，内部决策-035 决策 2/5）——版本一致闸 → spawn 仓库级验证集
//       （scripts/release-suite.mjs --validate-only，验证集归仓库级：调用而不拥有）→ 市场同步
//       与清单 upsert（迁自 release-suite 发布路径）→ 尾印装机指引与操作链收口提示。
//       顺序纪律：读闸（loadManifests/readMarketDoc）先于任何写副作用。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadManifests } from './manifests.mjs';
import { readMarketDoc, refreshMarketManifest, syncPlugins, cleanupPublishBackups } from './market.mjs';
import { installGuidance } from './guidance.mjs';

/** 验证集入口（仓库级，--validate-only 唯一模式由 S2 步骤 8 落地）。 */
const VALIDATE_SCRIPT = join('scripts', 'release-suite.mjs');

/**
 * 发布主流程。
 * @param {{repoRoot: string, marketRoot: string, skipTests?: boolean, out?: (s: string) => void, syncImpl?: typeof syncPlugins}} input 输入
 *   （syncImpl＝同步注入缝，缺省 syncPlugins；install verifyImpl 同款先例，测试失败路径退码用）
 * @returns {{code: number, version?: string}} 退出码与生效版本
 */
export function runPublish({ repoRoot, marketRoot, skipTests = false, out = (s) => process.stdout.write(s), syncImpl = syncPlugins }) {
  const loaded = loadManifests(repoRoot);
  if (!loaded.ok) {
    out(`[publish] 拒绝：${loaded.reason}\n`);
    return { code: 1 };
  }
  const version = loaded.manifests[Object.keys(loaded.manifests)[0]].version;
  out(`[publish] 版本一致 ${version}\n`);
  // 内部决策-036 源切换绊线（终审处置）：市场条目版本取自 manifest、被同步树携带生成物——两源在
  // 漂移态（改 manifest 未物化）下可分叉；此只读断言不受 --skip-tests 影响，防内部失配市场落盘
  for (const p of Object.keys(loaded.manifests)) {
    let pj;
    try {
      pj = JSON.parse(readFileSync(join(repoRoot, p, '.zcode-plugin', 'plugin.json'), 'utf8'));
    } catch (e) {
      // 内部任务-276 D6：此前裸读穿透到 CLI 兜底且只有裸 ENOENT；clone 后未物化的仓库在此被拦截并给出路
      out(`[publish] 拒绝：${p} 生成物不可读/不可解析（${e.message}）——先 node plugin-core/cli.mjs materialize\n`);
      return { code: 1 };
    }
    if (pj.version !== loaded.manifests[p].version) {
      out(`[publish] 拒绝：${p} 生成物版本（${pj.version}）与 manifest（${loaded.manifests[p].version}）不一致——先 node plugin-core/cli.mjs materialize\n`);
      return { code: 1 };
    }
  }
  // 验证集恒经 spawn（--skip-tests 透传给验证集入口，由其内部决定跳过面——顺序与形态可断言）。
  // 超时口径注记（S2 门 #2 评审修复）：原版验证集为**每步** 600s（约 24 步），本层对整集
  // spawn 只能设单一上限——取 1800s（每步上限 × 3 余量，覆盖慢机/冷启动下的全绿套件），
  // 语义收缩点在此显式登记。
  const args = [join(repoRoot, VALIDATE_SCRIPT), '--validate-only', ...(skipTests ? ['--skip-tests'] : [])];
  const r = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: 1_800_000 });
  if (r.status !== 0 || r.error) {
      const why = r.error ? `（${r.error.code === 'ETIMEDOUT' ? '超时 1800s 被杀' : r.error.message}）`
        : r.signal ? `（被信号 ${r.signal} 杀死）` : ''; // 内部任务-276 D16：信号杀死（OOM-killer 等）此前原因行为空
    out(`[publish] 验证集失败${why}：\n${(r.stdout ?? '') + (r.stderr ?? '')}\n`);
    return { code: 1 };
  }
  if (skipTests) {
    out('[publish] 验证集已跳过（--skip-tests）：未执行全量验证；装机后必须复跑 release-suite --validate-only 并留证\n');
  } else {
    // 内部任务-349：判绿必须**行首锚定**肯定行——release-suite 的负向尾印含「不得称「验证全绿」」同串，
    // 用 includes 会把「不可判定／SKIP>0／--allow-dirty」判成全绿（假绿复现）。
    const lines = String(r.stdout ?? '').split('\n');
    const green = lines.some((line) => line.startsWith('[release-suite] 验证全绿'));
    // 测量对象披露行在两种尾印下都须转发（内部规则-8 无条件披露在发布面的落点）
    const subjectTail = lines
      .filter((line) => line.startsWith('[release-suite] 测量对象'))
      .slice(-2)
      .join('\n');
    const tailSuffix = subjectTail === '' ? '' : `${subjectTail}\n`;
    if (green) {
      out(`[publish] 验证集全绿\n${tailSuffix}`);
    } else {
      const tail = lines
        .filter((line) => line.startsWith('[release-suite] 测量对象') || line.startsWith('[release-suite] 验证通过'))
        .slice(-4)
        .join('\n');
      out(`[publish] 验证集通过（非全绿：测量对象不可判定或存在 SKIP——不得称「验证全绿」）\n${tail === '' ? '' : `${tail}\n`}`);
    }
  }
  const doc = readMarketDoc(marketRoot);
  if (!doc.ok) {
    out(`[publish] 拒绝：${doc.reason}\n`);
    return { code: 1 };
  }
  // 内部任务-275/内部未决-163：备份→落位→写后自检，失败回滚零净写后上抛——此处收为业务失败退 1
  // （不穿透到 CLI 兜底退 2〔用法错档〕，R-za-1 退码契约；round1 C3 处置）
  let synced;
  try {
    synced = syncImpl(repoRoot, marketRoot);
  } catch (e) {
    // 回滚完整性分叉（round2 N1 处置）：restoreFailed 路径下备份保留供人工恢复，不得宣称零净写
    const incomplete = Boolean(e && e.rollbackIncomplete);
    out(`[publish] 拒绝：市场同步失败（${incomplete ? '已回滚但存在不完整项——按 stderr「回滚不完整」告警人工恢复' : '已回滚至同步前状态，零净写'}）：${e instanceof Error ? e.message : String(e)}\n`);
    return { code: 1 };
  }
  out(`[publish] 已同步六插件目录至 ${join(marketRoot, 'plugins')}（镜像；写后自检通过）\n`);
  const refreshed = refreshMarketManifest(marketRoot, doc.doc, loaded.manifests);
  if (!refreshed.ok) {
    out(`[publish] 拒绝：${refreshed.reason}\n`);
    return { code: 1 }; // 清单刷新失败：备份保留供人工比对（市场可重跑收敛，不自动清）
  }
  // 尾印计数＝刷新后清单实测总条目数（重读 marketplace.json——含保留的非套件条目，与
  // 刷新语义同源；内部任务-11：原为硬编码套件数字面量，research-loop 入套时漏改）
  const refreshedEntries = JSON.parse(readFileSync(join(marketRoot, 'marketplace.json'), 'utf8')).plugins?.length ?? 0;
  out(`[publish] 市场清单已刷新：${refreshedEntries} 条目 @ ${version}\n`);
  cleanupPublishBackups(marketRoot, synced.backupRoot); // 内部任务-275：成功路径清本次＋超龄备份；失败告警不阻断（C2）
  out(installGuidance(marketRoot, version));
  out('下一步（机械化收口）：node zcode-adapter/cli.mjs install --marketplace <市场源>\n');
  return { code: 0, version };
}
