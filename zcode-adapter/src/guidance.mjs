// 文件：zcode-adapter/src/guidance.mjs
// 描述：发布尾印/装机指引全文（S2 步骤 6，自 scripts/release-suite.mjs installGuidance :282-301
//       与 GITIGNORE_SNIPPET :76-84 **逐字迁移**——含第 10 块 opchain-copy-sync 第三副本锚
//       （步骤 4 收口行）与全部文本令牌；check-repo-consistency 的该副本锚随本迁移改指本文件。
//       注意：本头注释不得复现锚串原文——lint 按「首个 includes(anchor) 行 + 后续 3 行」取
//       令牌窗，头注释命中即整块失锚。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { join } from 'node:path';

import { PLUGINS } from './manifests.mjs';

/** 消费项目推荐 .gitignore 片段（内部接口-21 v2；镜像 spec-gate/assets/gitignore-template 活行——唯一事实源在模板，本常量为装机指引传导镜像，check-repo-consistency 第 18 块机械锚定，不自创条目）。 */
export const GITIGNORE_SNIPPET = [
  '.sdd/*',
  '!.sdd/suite.json',
  '!.sdd/project.json',
  '!.sdd/assurance.json',
  '/.workflow/*',
  '!/.workflow/domains.json',
  '!/.workflow/maintainers.json',
  '/.scout/',
  '.ai-governance/runtime/',
  '__pycache__/',
];

/**
 * 装机指引全文（纯函数；迁移原注记：内部决策-021 路线甲——提取为纯函数供断言）。
 * @param {string} marketRoot 市场源目录
 * @param {string} version 套件版本
 * @returns {string} 指引文本（换行结尾）
 */
export function installGuidance(marketRoot, version) {
  return [
    '装机侧步骤（人工执行，ADR-017）:',
    '  （发布目标必须取本机 ~/.zcode/cli/plugins/known_marketplaces.json 中本市场注册的 source 路径——directory 源形如 <...>/marketplace-sources/<市场>-<hash>；cli/plugins/marketplaces/ 下副本是客户端派生镜像，镜像对齐见步骤 2）',
    `  1. cache 落位：for p in ${PLUGINS.join(' ')}; do rm -rf "$HOME/.zcode/cli/plugins/cache/wangp-local-marketplace/$p/${version}" && command cp -r "${join(marketRoot, 'plugins', '$p')}" "$HOME/.zcode/cli/plugins/cache/wangp-local-marketplace/$p/${version}/"; done（先删目标版本目录再拷=可重复执行；command cp 绕过交互式 shell 的 cp -i 别名——否则覆盖复制静默不生效）`,
    `  2. 派生镜像对齐（客户端派生镜像不自愈，须显式 cp；先删后拷可重复执行）：command cp -f "${join(marketRoot, 'marketplace.json')}" "$HOME/.zcode/cli/plugins/marketplaces/wangp-local-marketplace/marketplace.json"；六插件目录对 "$HOME/.zcode/cli/plugins/marketplaces/wangp-local-marketplace/plugins/<插件>" 执行 rm -rf 后 command cp -r 同法`,
    `  3. 更新 ~/.zcode/cli/plugins/installed_plugins.json 中六插件 version 为 ${version}（installPath 指向新版本目录；双读判据由步骤 4 生成）`,
    `  4. 收口（机械化，禁手写探针）：node <spec-gate 插件根>/assurance/cli.mjs --project-root <项目根> install-criteria --marketplace ${marketRoot} --record-ref <操作记录仓库相对路径>#验证判据 > <判据文件>；随后 issue-verification → issue-operation（--criteria-file <判据文件>，--risk-level L1）→ gate --operation-chain（三面=市场源/派生镜像/装机 cache 探针全过即完成标记，ADR-027）；操作记录与判据落 docs/plans/evidence/<专用操作任务号>/（固定三件 operation-record.md/criteria.json/evidence.json，任务号不复用开发任务号），装机完成即提交推送（跨机取号经该目录名同步可见，DEV-24）；宣称宿主装机生效前先证宿主在位——install-criteria --host <zcode|mcode|kimi|dsh> 尾附/生成宿主在位判据，宿主不在位则如实改口「数据面物化就绪」（ADR-048，DEV-121 教训：数据目录残留≠宿主在位）`,
    '  5. 警示：旧版本 cache 目录必须保留——运行中会话的 hook 路径指向启动时加载的版本目录，删除即静默失效（AGENTS.md 已知陷阱）',
    '装机态判据（仅位置无关者可在装机树内运行）:',
    '  可用：① 带 `--selftest` 分支的 hooks/、scripts/ 脚本（`node <脚本> --selftest`；插件无 scripts/ 目录属正常，grep 命中的 .md/注释/测试文件不算入口）；② SessionStart 冒烟：`ZCODE_PROJECT_DIR=<空目录> node <插件根>/hooks/session-start.mjs < /dev/null`（喂空 stdin 防挂起——spec-gate 钩子会读 stdin；判据=退 0，仅抓模块级加载错误，workflow 钩子在缺资产时恒退 0 无鉴别力）；③ spec-gate 校验器就地跑：`node <插件根>/core/validator/validate_specs.mjs --mode draft --config <项目>/.sdd/suite.json`',
    '  禁止：team-governance 的 scripts/tests/installed-layout.test.mjs——以 import.meta.url 上溯三级求仓库根（仓库内模拟装机形态）；0.3.1 起带仓库形态守卫，装机树误跑输出可读 SKIP 退 0（OPEN-18 已关），仓库侧运行仍是该文件唯一有效形态',
    '消费项目推荐 .gitignore 片段（运行态不跟踪、配置三件套白名单，IF-COLLAB-21）:',
    ...GITIGNORE_SNIPPET.map((line) => `  ${line}`),
    '团队约定摘要（判据全文唯一载体：specs/interfaces/IF-COLLAB-21.md）:',
    '  1. 跟踪文档只承载共享契约、冻结历史、追加式登记册，不嵌随机器变化的活状态',
    '  2. 登记册冲突保留双方；合并后必跑门禁（校验 0 阻断 + 一致性检查）',
    '  3. merge=union 仅限纯追加文件；状态流转型登记册与 JSON 禁用',
  ].join('\n') + '\n';
}
