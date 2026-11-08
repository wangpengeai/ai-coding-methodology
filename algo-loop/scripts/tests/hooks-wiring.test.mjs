// 文件：hooks-wiring.test.mjs
// 描述：algo-loop 真件只读机检——manifest 声明面七字段/脚本存在性/生成物单源对拍/入库策略与分期边界，
//       以及 20 个 .mjs 文件头齐备（内部任务-269 R19 机检承载）。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：新增文件头齐备用例（20 个 .mjs 均含「作者：」）。
// 自检：node --test "algo-loop/scripts/tests/hooks-wiring.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.manifest.json'), 'utf8'));

test('manifest 基本形态 + description 零内部编号（公开受众）', () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.name, 'algo-loop');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const pattern of [/\bADR-\d+/, /\bIF-[A-Z]+-\d+/, /\bR-M\d+/, /\bB-M\d+/, /\bOPEN-\d+/]) {
    assert.doesNotMatch(manifest.description, pattern);
    if (manifest.displayName) assert.doesNotMatch(manifest.displayName, pattern);
  }
});

test('SessionStart 钩声明七字段齐备且脚本存在（Stage 1 形态）', () => {
  assert.ok(Array.isArray(manifest.hooks), 'hooks 为数组');
  const hook = manifest.hooks.find((h) => h.event === 'SessionStart');
  assert.ok(hook, '含 SessionStart 钩');
  assert.equal(hook.type, 'process');
  assert.equal(hook.command, 'node');
  assert.equal(hook.matcher, 'startup|resume|clear|compact');
  assert.equal(hook.timeoutMs, 10000);
  assert.equal(typeof hook.statusMessage, 'string');
  assert.ok(hook.statusMessage.length > 0);
  assert.ok(Array.isArray(hook.args) && hook.args.length === 1);
  assert.ok(hook.args[0].startsWith('$' + '{PLUGIN_ROOT}/'), `args[0] 应以中立占位符开头：${hook.args[0]}`);
  const rel = hook.args[0].replace('$' + '{PLUGIN_ROOT}/', '');
  assert.ok(existsSync(join(pluginRoot, rel)), `钩脚本存在：${rel}`);
});

// —— 生成物对拍（内部任务-90 步骤 2.2；物化产物由 plugin-core/cli.mjs materialize 整体覆写，禁手改）——

test('生成物 plugin.json 四字段与 manifest 单源一致', () => {
  const generated = JSON.parse(readFileSync(join(pluginRoot, '.zcode-plugin', 'plugin.json'), 'utf8'));
  assert.equal(generated.name, manifest.name);
  assert.equal(generated.version, manifest.version);
  assert.equal(generated.description, manifest.description);
  assert.equal(generated.author, manifest.author);
});

test('生成物 hooks.json 宿主形态：两层嵌套 + ${ZCODE_PLUGIN_ROOT} 占位 + matcher/timeoutMs 保真', () => {
  const wiring = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const entries = wiring?.hooks?.SessionStart ?? [];
  assert.ok(entries.length >= 1, 'SessionStart 至少一个条目');
  const inner = entries.flatMap((e) => e.hooks ?? []);
  assert.ok(inner.length >= 1, '内层 hooks 数组至少一条（扁平形态会被宿主丢弃）');
  const hook = manifest.hooks.find((h) => h.event === 'SessionStart');
  assert.equal(entries[0].matcher, hook.matcher, 'matcher 从 manifest 保真');
  const cmd = inner.map((h) => (h.args ?? []).join(' ')).join('\n');
  assert.ok(cmd.includes('${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs'), '命令走宿主占位符');
  assert.equal(inner[0].timeoutMs, hook.timeoutMs, 'timeoutMs 从 manifest 保真');
  assert.equal(inner[0].statusMessage, hook.statusMessage, 'statusMessage 从 manifest 保真');
});

// ── 内部任务-214 批 3（内部验收-10/内部验收-11）：入库策略与分期边界 ──

test('入库策略：文档明示五件全量入库且模板无 .algo 条目', () => {
  const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8');
  const skill = readFileSync(join(pluginRoot, 'skills', 'algo-loop', 'SKILL.md'), 'utf8');
  assert.ok(readme.includes('五件全量入库'), 'README 明示 .algo/ 五件全量入库');
  assert.ok(readme.includes('bag/日志/数据集本体不入 `.algo/`'), 'README 注明本体不入 .algo（只存引用）');
  assert.ok(skill.includes('五件全量入库'), 'SKILL 正文同步入库纪律');
  const template = readFileSync(join(pluginRoot, '..', 'spec-gate', 'assets', 'gitignore-template'), 'utf8');
  const active = template.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.equal(active.some((l) => l.includes('.algo')), false, 'gitignore 模板不得忽略 .algo（全量入库前提）');
});

test('分期边界：P2/P3 资产零落地', () => {
  const skillDirs = readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(skillDirs, ['algo-loop'], 'P2/P3 不新增 skill（无 algo-release）');
  const scriptFiles = readdirSync(join(pluginRoot, 'scripts')).filter((f) => f.endsWith('.mjs')).sort();
  assert.equal(scriptFiles.some((f) => /release|gate/.test(f)), false, `P2/P3 闸/发布脚本零落地（实际 ${scriptFiles.join(',')}）`);
  const hookFiles = readdirSync(join(pluginRoot, 'hooks')).filter((f) => f.endsWith('.mjs')).sort();
  assert.deepEqual(hookFiles, ['session-start.mjs'], '钩面仅 Stage 1 SessionStart（P2/P3 钩零落地）');
  const m18 = readFileSync(join(pluginRoot, '..', 'specs', 'modules', '内部模块-18-algo-loop.md'), 'utf8');
  assert.ok(m18.includes('P2＝门禁机械化') && m18.includes('P3＝部署决策闸'), '内部模块-18 内部规则-12 分期边界登记在位');
});

// —— 内部任务-269 R19：文件头齐备（批次终值 20 个 .mjs；无自动化文件头 lint，本用例即机检承载）——

test('文件头齐备：20 个 .mjs 均含「作者：」且批次计数一致', () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const files = walk(pluginRoot).filter((f) => f.endsWith('.mjs'));
  assert.equal(files.length, 20, `批次终值 20 个 .mjs，实际 ${files.length}`);
  const missing = files.filter((f) => !readFileSync(f, 'utf8').includes('作者：'));
  assert.deepEqual(missing, [], `缺规范文件头：${missing.join(', ')}`);
});
