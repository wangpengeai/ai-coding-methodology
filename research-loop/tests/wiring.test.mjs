// 文件：research-loop/tests/wiring.test.mjs
// 描述：research-loop 插件形态与接线测试——manifest 字段面/生成物对拍/零钩子形制/目录同构/
//       分期边界（Stage 2/3 资产零落地，状态目录以规格 `.research/` 为源）/README 先验复审义务登记/
//       README 门面口径（Node ≥21、宿主接入、未安装安装指引、计数单源）。
//       内部任务-270 评审修复批：`.rl`→`.research`（R02）、hostTermHits 单源（R06）、死导入清理（R07）、
//       LICENSE+目录同构与 README 先验复审断言（R13）、validateManifest 真调用（R17）、README 门面（R03/R15/R16）。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 research-loop/LICENSE）
// 修改记录：
//   v1.0.0 2026-10-16 wangp 初始创建（内部任务-109 S2 步骤 2.2）
//   v1.0.1 2026-11-01 wangp 内部任务-270：R02 `.research`/R06 单源词表/R07 导入清理/R13 目录同构与
//           README 先验复审/R17 validateManifest/R05 四文件头守卫/R03+R15+R16 README 门面；文件头规范化
//   v1.0.2 2026-11-04 wangp 内部任务-317：§A 版本改单源指针（折叠句正/负双断言，内部未决-263）；死读取清理＋注释同步
// 自检：node --test "research-loop/tests/wiring.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateManifest, hostTermHits } from '../../plugin-core/src/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// 公开包守卫（内部任务-365）：specs/ 未随公开包发布；且 README 在公开包内按散文面改写。
const HAS_SPECS = existsSync(join(root, '..', 'specs'));
const IS_SOURCE_REPO = existsSync(join(root, '..', '.deliver'));
const repoRoot = join(root, '..');

test('manifest 在场且基础字段可解析（字段面自断言＋validateManifest 真调用，A-M19-1）', () => {
  const m = JSON.parse(readFileSync(join(root, 'plugin.manifest.json'), 'utf8'));
  assert.equal(m.manifestVersion, 1);
  for (const k of ['name', 'version', 'description', 'author']) assert.ok(typeof m[k] === 'string' && m[k].length > 0, `${k} 非空字符串`);
  assert.ok(m.displayName && m.displayName.trim().length > 0, 'displayName 可选但出现须非空');
  // R17：真调用 plugin-core 单源校验（import 零副作用；真仓六插件全过由 validate.test.mjs:40-44 先例）
  assert.deepEqual(validateManifest(repoRoot, 'research-loop'), { ok: true, errors: [] }, 'validateManifest 单源校验通过');
});

test('目录同构：manifest/skills/assets/README/LICENSE 齐备（A-M19-1）', () => {
  for (const rel of ['plugin.manifest.json', 'skills', 'assets', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(root, rel)), `目录形态与 algo-loop 同构缺项：${rel}`);
  }
});

test('零钩子形态：无 hooks 键（缺席即权威零声明）＋manifest 原文无宿主专有名（R06 单源词表）', () => {
  const raw = readFileSync(join(root, 'plugin.manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  assert.equal(m.hooks, undefined, 'hooks 键整体缺席（plugin-core/src/validate.mjs:196 条件校验缺席合法；零钩子插件推荐形态）');
  // R06：消费 plugin-core 的 HOST_TERMS 单源（不再维护本地正则副本；HOST_TERMS 不含 Claude，属既知覆盖收缩登记）
  assert.deepEqual(hostTermHits(raw), [], `manifest 原文无宿主专有名：${JSON.stringify(hostTermHits(raw))}`);
  assert.ok(hostTermHits('Kimi').length > 0, '灵敏度控件：Kimi 应被单源词表命中');
  assert.ok(hostTermHits('DeepSeek').length > 0, '灵敏度控件：DeepSeek 应被单源词表命中');
  assert.ok(!raw.includes('${'), '无未译占位符');
});

test('生成物对拍：.zcode-plugin/plugin.json 在场且四元数据键与 manifest 一致；hooks.json 不存在（A-M19-1 零钩子生成物形态）', () => {
  const m = JSON.parse(readFileSync(join(root, 'plugin.manifest.json'), 'utf8'));
  const gen = join(root, '.zcode-plugin', 'plugin.json');
  assert.ok(existsSync(gen), `生成物 ${gen} 在场（须跑 plugin-core/cli.mjs materialize）`);
  const g = JSON.parse(readFileSync(gen, 'utf8'));
  // 生成物形态＝四元数据键固定序（displayName 留在中立清单层，不进宿主生成物）
  assert.deepEqual(Object.keys(g), ['name', 'version', 'description', 'author'], '生成物恰四键固定序');
  for (const k of ['name', 'version', 'description', 'author']) assert.equal(g[k], m[k], `${k} 一致`);
  assert.ok(!existsSync(join(root, 'hooks', 'hooks.json')), '零钩子插件不产 hooks.json（materialize 条件分支）');
});

// ── 内部任务-214 批 3（内部验收-7）/ 内部任务-270（R02/R13）：分期边界 + 状态目录以规格 `.research/` 为源 ──

test('README 门面口径：Node ≥21/DSH 运行时接入/未安装时路由行仍命中＋安装指引/唯一模板/计数单源（R03/R15/R16）', { skip: IS_SOURCE_REPO ? false : '公开包 README 按散文面改写（源仓照跑）' }, () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const line = (needle) => readme.split('\n').find((x) => x.includes(needle)) ?? '';
  assert.match(line('Node.js'), /Node\.js ≥ ?21/, 'Node 下限须 ≥21（根 README/OPEN-15 单源口径）');
  const hostLine = line('受支持宿主');
  assert.ok(hostLine.includes('add link'), 'DSH 须写运行时 add link 接入');
  assert.ok(!hostLine.includes('物化安装'), 'DSH 不得写「物化安装」（应为运行时 add link）');
  assert.ok(hostLine.includes('MCode') && hostLine.includes('Kimi'), 'MCode/Kimi 接入措辞在位');
  assert.match(readme, /未安装时路由两行仍命中/, '未安装时路由两行仍命中的正向断言在位');
  assert.match(readme, /可行动安装指引/, '未安装时安装指引叙述在位');
  assert.doesNotMatch(readme, /路由行不生效/, '不得声称未安装时路由行不生效（路由表在 workflow 插件内仍命中）');
  assert.ok(readme.includes('唯一模板'), 'README 保留「唯一模板」声明');
  assert.match(readme, /M19-research-loop\.md[^\n]*§B/, '计数指针须指向 M19 §B 单源');
  // R01 防复发计数互锁（计划复审非阻塞 #1）：§B 分项和＝§D 总数＝实测 test( 声明数；§A 版本走单源指针（plugin.manifest.json 实测为准，禁写死版本号——内部未决-263/内部任务-317）
  const m19 = readFileSync(join(root, '..', 'specs', 'modules', 'M19-research-loop.md'), 'utf8');
  const testFiles = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
  const total = testFiles.reduce((n, f) => n + ((readFileSync(join(here, f), 'utf8').match(/^test\(/gm) || []).length), 0);
  const budget = m19.split('\n').find((l) => l.includes('| 测试预算 |'));
  assert.ok(budget, 'M19 §B 测试预算行在位');
  assert.ok(budget.includes(`实测 ${total} 项`), `§B 测试预算总数须＝实测 test( 声明数 ${total}`);
  const parts = [...budget.matchAll(/(skills-contract|prereg-template|wiring|protocol-contract) (\d+)/g)].map((m) => Number(m[2]));
  assert.ok(parts.length >= 4, '§B 测试预算须列四文件分项');
  assert.equal(parts.reduce((a, b) => a + b, 0), total, '§B 分项和须＝实测总数');
  const foldLine = m19.split('\n').find((l) => l.includes('随套件统一版本折叠'));
  assert.ok(foldLine, '§A manifest 折叠句在位');
  assert.ok(foldLine.includes('当前版本以 `plugin.manifest.json` 实测为准'), '§A 须写单源指针（plugin.manifest.json 实测为准）');
  assert.ok(!/本批 \d+\.\d+\.\d+/.test(foldLine), '折叠句不得写死版本号（禁「本批 X.Y.Z」回流；OPEN-263）');
});

test('四个测试文件规范头齐备（文件/描述/作者/创建/版权/修改记录/自检，R05）', { skip: IS_SOURCE_REPO ? false : '公开包注释按注释面改写（源仓照跑）' }, () => {
  const files = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort();
  assert.deepEqual(
    files,
    ['prereg-template.test.mjs', 'protocol-contract.test.mjs', 'skills-contract.test.mjs', 'wiring.test.mjs'],
    '研究环测试文件集合恰四个（新增文件须同批更新本断言与 M19 计数）',
  );
  for (const f of files) {
    const head = readFileSync(join(here, f), 'utf8').split('\n').slice(0, 20).join('\n');
    assert.match(head, /^\/\/ 文件：/m, `${f} 缺「文件：」头`);
    assert.match(head, /^\/\/ 描述：\S/m, `${f} 缺「描述：」头`);
    assert.match(
      head,
      /^\/\/ 作者：wangp\s+创建：\d{4}-\d{2}-\d{2}\s+版权：MIT（见 research-loop\/LICENSE）/m,
      `${f} 缺作者/创建/版权头或版权引用错误（应 research-loop/LICENSE）`,
    );
    assert.match(head, /^\/\/ 修改记录：$/m, `${f} 缺「修改记录：」段`);
    assert.match(head, /^\/\/\s+v\d+\.\d+\.\d+ \d{4}-\d{2}-\d{2} \S+ DEV-270：\S/m, `${f} 修改记录缺 DEV-270 行`);
    assert.match(head, /^\/\/ 自检：node --test /m, `${f} 缺自检行`);
  }
});

test('分期边界：Stage 2/3 资产零落地（无脚本无钩子无状态目录）＋README 先验复审义务登记', { skip: HAS_SPECS ? false : '公开包不含内部资产 specs/（源仓照跑）' }, () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('Stage 2＝统计机械层') && readme.includes('Stage 3＝写作/评审面'), 'README 分期基线在位（Stage 1 文本层）');
  // R02：状态目录名以规格为源（`.research/`；旧版误查 `.rl` 会对提前落地的 `.research/` 假绿）
  const m19 = readFileSync(join(root, '..', 'specs', 'modules', 'M19-research-loop.md'), 'utf8');
  assert.ok(m19.includes('`.research/`'), '规格登记状态目录名 `.research/`');
  for (const dir of ['scripts', 'hooks', '.research']) {
    assert.equal(existsSync(join(root, dir)), false, `Stage 2/3 资产不得落地：${dir}`);
  }
  // R13/内部验收-7：先验复审义务在插件 README 登记（交付报告为 内部任务-109 历史批留痕）
  assert.ok(readme.includes('先验复审义务'), 'README 含先验复审义务节');
  for (const p of ['首个真实科研任务完成后', 'spec-writing', '双登记', 'OPEN-n']) {
    assert.ok(readme.includes(p), `README 先验复审义务缺要素：${p}`);
  }
  assert.ok(m19.includes('Stage 2') && m19.includes('Stage 3'), 'M19 分期边界登记在位');
  // 内部验收-7：内部接口-23（Stage 2/3 协作契约）零落地——工件缺席且注册表无在册行
  assert.equal(existsSync(join(root, '..', 'specs', 'interfaces', 'IF-COLLAB-23.md')), false, 'IF-COLLAB-23 工件不得提前落地');
  const registry = readFileSync(join(root, '..', 'specs', 'interface-registry.md'), 'utf8');
  assert.equal(registry.includes('IF-COLLAB-23'), false, 'IF-COLLAB-23 不得在接口注册表登记（Stage 2/3 前）');
});
