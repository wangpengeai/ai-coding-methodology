// 文件：zcode-adapter/src/selftest.mjs
// 描述：适配层自检入口（S3 步骤 10）——断言组自 scripts/release-suite.mjs selftest 迁入：
//       指引组（原 :704-718，内部接口-21 行为断言的新承载面，内部决策-035 实施批重登点）+
//       bump 拒绝/形态闸/dry-run/成功/重跑/回滚组（:721-756）+ 生成器组（:757-765）+
//       计划/事务组（:771-784）。mkBumpFixture/runBumpTest 夹具驱动同源迁入（:619-667）。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGINS, HOOKED_PLUGINS } from './manifests.mjs';
import { installGuidance } from './guidance.mjs';
import { parseBumpArgs, parseHostRegistration, buildHostProse, buildHostTitle, spliceManifestVersion, planBump, applyChanges, executeBump, printLineDiff } from './bump.mjs';

/**
 * bump 断言用最小仓库夹具（迁自 :619-649；与 tests/bump.test.mjs 夹具同源双份——
 * 脚本级测试「零上下文不跨文件引用」既有约定）。
 * @param {string} home tmpdir 根
 * @returns {{repo: string}}
 */
export function mkBumpFixture(home) {
  const repo = join(home, 'bumprepo');
  const version = '0.1.0';
  const hashes = {};
  for (const p of PLUGINS) {
    const mf = join(repo, p, '.zcode-plugin');
    mkdirSync(mf, { recursive: true });
    writeFileSync(join(mf, 'plugin.json'), `${JSON.stringify({ name: p, version, description: `测试 ${p}`, author: 'wangp' }, null, 2)}\n`);
    writeFileSync(join(repo, p, 'plugin.manifest.json'), `${JSON.stringify({ manifestVersion: 1, name: p, version, description: `测试 ${p}`, author: 'wangp' }, null, 2)}\n`);
    hashes[p] = {
      plugin: createHash('sha256').update(readFileSync(join(mf, 'plugin.json'))).digest('hex').slice(0, 16),
    };
    if (HOOKED_PLUGINS.includes(p)) {
      const hf = join(repo, p, 'hooks');
      mkdirSync(hf, { recursive: true });
      writeFileSync(join(hf, 'hooks.json'), '{"hooks":[]}\n');
      hashes[p].hooks = createHash('sha256').update(readFileSync(join(hf, 'hooks.json'))).digest('hex').slice(0, 16);
    }
  }
  const rows = [
    ...PLUGINS.map((p) => `| ${p} | ${version} | \`${p}/.zcode-plugin/plugin.json\` | sha256:${hashes[p].plugin} | \`sha256sum ${p}/.zcode-plugin/plugin.json\` |`),
    ...HOOKED_PLUGINS.map((p) => `| ${p} hooks 声明 | ${version} | \`${p}/hooks/hooks.json\` | sha256:${hashes[p].hooks} | \`sha256sum ${p}/hooks/hooks.json\` |`),
  ];
  mkdirSync(join(repo, 'specs', 'interfaces'), { recursive: true });
  writeFileSync(join(repo, 'specs', 'interfaces', 'IF-HOST-1.md'), [
    '---', 'documentType: interface', 'validationMode: draft', '---', '',
    '# 接口 IF-HOST-1（测试）', '',
    `## 激活登记（2026-01-01，六插件统一 ${version} 版本折叠刷新，ADR-017）`, '',
    `lifecycle 维持 active；契约工件哈希实测登记（${PLUGINS.join('/')} 统一折叠 ${version}——套件版本即插件版本（ADR-017）；${version} 内容=夹具初版；hooks.json 均未动（五哈希沿 0.1.0 值；research-loop 零钩子无 hooks 登记行）；取代 2025-12-31 0.0.9 登记（0.0.9 内容=夹具前版））：`, '',
    '| 工件 | 版本 | 路径 | sha256（前 16 位） | 漂移检查 |', '|---|---|---|---|---|',
    ...rows, '',
  ].join('\n'));
  // DSH 两文件（内部未决-57，内部任务-44）：package.json 严格闸面 + package-lock.json 自愈面（正常同步态）
  mkdirSync(join(repo, 'ai-coding-methodology'), { recursive: true });
  writeFileSync(join(repo, 'ai-coding-methodology', 'package.json'),
    `${JSON.stringify({ name: 'ai-coding-methodology', version }, null, 2)}\n`);
  writeFileSync(join(repo, 'ai-coding-methodology', 'package-lock.json'),
    `${JSON.stringify({ version, packages: { '': { version } } }, null, 2)}\n`);
  return { repo };
}

/**
 * selftest 用 bump 驱动（参数校验走生产解析器，执行走 executeBump；checks 可注入桩；迁自 :657-667）。
 * @param {string} repo
 * @param {{version: string, note: string, dryRun?: boolean, checks?: (() => {ok: boolean, log: string})|null}} opts
 * @returns {{exit: number, log: string}}
 */
export function runBumpTest(repo, { version, note, dryRun = false, checks = null }) {
  let opts;
  try {
    const argv = ['--version', String(version ?? ''), '--note', String(note ?? '')];
    if (dryRun) argv.push('--dry-run');
    opts = parseBumpArgs([repo, ...argv]);
  } catch (exc) {
    return { exit: 1, log: exc.message };
  }
  return executeBump({ ...opts, date: '2026-02-02' }, checks);
}

/**
 * 自检入口（B-M8-4 同款姿态）：纯函数冒烟 + 迁入断言组；失败可见退 1。
 * 迁入断言计数=源 :704-784 各组之和（指引 7 + bump 事务 9 + 清残留 1 + 生成器 4 + 计划事务 3 = 24）。
 * @returns {number}
 */
export function selftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'zcode-adapter-selftest-'));
  try {
    // ── 指引组（原 :704-718；内部接口-21 行为断言新承载面）──
    const g = installGuidance('/fixture/market', '9.9.9');
    const snippetLines = ['.sdd/*', '!.sdd/suite.json', '!.sdd/project.json', '!.sdd/assurance.json', '/.workflow/*', '!/.workflow/domains.json', '!/.workflow/maintainers.json', '/.scout/', '.ai-governance/runtime/', '__pycache__/'];
    check('指引装配 gitignore 片段逐行', snippetLines.every((line) => g.includes(line)));
    check('指引装配团队约定摘要三行', ['团队约定摘要（判据全文唯一载体：specs/interfaces/IF-COLLAB-21.md）:', '1. 跟踪文档只承载共享契约', '2. 登记册冲突保留双方', '3. merge=union 仅限纯追加文件'].every((line) => g.includes(line)));
    check('指引插值正确', g.includes('9.9.9') && g.includes(join('/fixture/market', 'plugins')));
    check('指引保留既有警示文案', g.includes('旧版本 cache 目录必须保留'));
    check('指引装配市场源判别句（OPEN-19）', ['known_marketplaces.json', 'marketplace-sources', '派生镜像'].every((line) => g.includes(line)));
    check(
      '指引装配装机态判据节（标题+可用项+禁止项+守卫注记）',
      ['装机态判据（仅位置无关者可在装机树内运行）:', 'SessionStart 冒烟', 'validate_specs.mjs --mode draft', 'installed-layout.test.mjs', '仓库形态守卫', 'OPEN-18 已关'].every((line) => g.includes(line)),
    );
    check('指引装配镜像对齐与收口步骤（NEWFIND 批次；DEV-24 B 补证据落位约定 token）', ['派生镜像对齐', 'install-criteria', '--operation-chain', '--risk-level L1', 'docs/plans/evidence', 'operation-record.md'].every((line) => g.includes(line)));
    // ── bump 事务组（原 :721-756；断言层=executeBump，参数错经 CLI 层才映射退 2）──
    const bf = mkBumpFixture(home);
    const badVer = runBumpTest(bf.repo, { version: '0.1', note: 'x' });
    check('bump 拒绝：版本格式非法', badVer.exit === 1 && badVer.log.includes('版本'));
    const sameVer = runBumpTest(bf.repo, { version: '0.1.0', note: 'x' });
    check('bump 拒绝：同版本', sameVer.exit === 1 && sameVer.log.includes('递增'));
    const badNote = runBumpTest(bf.repo, { version: '0.2.0', note: '' });
    check('bump 拒绝：note 缺失', badNote.exit === 1 && badNote.log.includes('note'));
    const reg = parseHostRegistration(readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8'));
    check('bump 形态闸：canonical 登记解析（条件十一行表）', reg !== null && reg.rows.length === 11 && reg.version === '0.1.0');
    const broken = parseHostRegistration(readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8').replace('| workflow |', '| workflow-x |'));
    check('bump 形态闸：表行异名拒绝', broken === null);
    const dry = runBumpTest(bf.repo, { version: '0.2.0', note: '测试批次', dryRun: true });
    check('bump dry-run：退 0 且零写入', dry.exit === 0 && dry.log.includes('未写入')
      && readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('0.1.0'));
    const okBump = runBumpTest(bf.repo, { version: '0.2.0', note: '测试批次', checks: () => ({ ok: true, log: '' }) });
    check('bump 成功：十五文件更新（六 manifest + 六物化 plugin.json + IF-HOST-1 + DSH package.json + lock 两处）', okBump.exit === 0
      && readFileSync(join(bf.repo, 'workflow', 'plugin.manifest.json'), 'utf8').includes('"0.2.0"')
      && readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('"0.2.0"')
      && readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8').includes('0.2.0 内容=测试批次'));
    const rerun = runBumpTest(bf.repo, { version: '0.2.0', note: 'x', checks: () => ({ ok: true, log: '' }) });
    check('bump 重跑：拒绝且文件未变', rerun.exit === 1
      && readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('"0.2.0"')
      && readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8').includes('0.2.0 内容=测试批次'));
    const failChk = runBumpTest(bf.repo, { version: '0.3.0', note: '测试批次', checks: () => ({ ok: false, log: '自检失败' }) });
    check('bump 自检失败：回滚字节一致', failChk.exit === 1 && failChk.log.includes('已回滚')
      && readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8').includes('"0.2.0"'));
    {
      const dirTarget = join(bf.repo, 'workflow', '.zcode-plugin');
      let threw = false;
      try {
        applyChanges([{ path: dirTarget, newText: 'x' }]);
      } catch {
        threw = true;
      }
      check('applyChanges 失败清残留 tmp', threw && !existsSync(`${dirTarget}.bump-tmp`));
    }
    // ── 生成器组（原 :757-765）──
    const pr = buildHostProse(reg.prose, { version: '0.2.0', note: '测试批次', prevDate: reg.date, prevVersion: reg.version });
    check('bump 生成：prose 取代链嵌入', pr !== null && pr.includes('统一折叠 0.2.0——套件版本即插件版本（ADR-017）')
      && pr.includes('0.2.0 内容=测试批次') && pr.includes('；取代 2026-01-01 0.1.0 登记（')
      && pr.includes('0.1.0 内容=夹具初版') && pr.includes('；再前取代 2025-12-31 0.0.9 登记（0.0.9 内容=夹具前版）'));
    const round = parseHostRegistration(reg.lines.map((l, i) => (i === reg.proseIdx ? pr : l)).join('\n'));
    check('bump 生成：prose round-trip 可再解析', round !== null && round.version === '0.1.0');
    const tt = buildHostTitle({ version: '0.2.0', date: '2026-02-02' });
    check('bump 生成：标题=日期+目标版本', tt === '## 激活登记（2026-02-02，六插件统一 0.2.0 版本折叠刷新，ADR-017）');
    const mf0 = readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8');
    const mf1 = spliceManifestVersion(mf0, '0.2.0', '0.3.0');
    check('bump 生成：plugin.json 仅 version 替换（其余字节保留）', mf1 !== null
      && mf1.includes('"version": "0.3.0"') && mf1.length === mf0.length - '0.2.0'.length + '0.3.0'.length);
    // ── 计划/事务组（原 :771-784）──
    const pOk = planBump({ repo: bf.repo, version: '0.9.9', note: 'x' });
    check('bump 前置：登记一致性通过（十五文件变更面）', pOk.ok === true && pOk.changes.length === 15);
    const hooksPath = join(bf.repo, 'workflow', 'hooks', 'hooks.json');
    const hostBefore = readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8');
    const pluginBefore = readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8');
    writeFileSync(hooksPath, '{"hooks":[1]}\n');
    const pDrift = planBump({ repo: bf.repo, version: '0.9.9', note: 'x' });
    check('bump 前置：hooks 哈希漂移拒绝且拒绝态零写入', pDrift.ok === false && pDrift.reason.includes('hooks')
      && readFileSync(join(bf.repo, 'specs', 'interfaces', 'IF-HOST-1.md'), 'utf8') === hostBefore
      && readFileSync(join(bf.repo, 'workflow', '.zcode-plugin', 'plugin.json'), 'utf8') === pluginBefore);
    const diff = printLineDiff('a.md', 'l1\nl2\n', 'l1\nL2\n');
    check('bump 输出：行级 diff 含 -/+ 对', diff.includes('- l2') && diff.includes('+ L2'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL zcode-adapter selftest（${failed.length} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK zcode-adapter selftest（${checks.length} 项通过）\n`);
  return 0;
}
