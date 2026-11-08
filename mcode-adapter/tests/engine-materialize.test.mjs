// 文件：引擎闭包物化测试（批 3 步骤 1-2）
// 描述：①物化清单＝`plugin-core` 可装载最小集；②**import 图 ⊆ 清单**（漏 `validate.mjs` 时副本
//       `import()` 会直接 ERR_MODULE_NOT_FOUND）；③**装载探针**：`loadEngine(<包根>)` 必须成功
//       （探针实参＝物化包根——多一级或少一级都不可读）；④逐字节全等但**不可装载**（删
//       `validate.mjs`）必须被探针抓住；⑤副本污损 → `verify` 报漂移。
// 作者：wangp  创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node --test "tests/engine-materialize.test.mjs"
// 自检：本文件即自检
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';

import { planPackage, verifyPackage } from '../cli.mjs';
import { normalizePayload, translateResponse } from '../mcode/hook-lib.mjs';
import { ensureEngineFixture, runShim, tempRoot } from './helpers.mjs';
import { MATCHER_TOOL_MAP } from '../src/plugin-meta.mjs';
import { PENDING_LIMIT, TOOL_MAP } from '../mcode/hook-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(ADAPTER_ROOT, '..');
const PLUGIN = 'workflow';

/** 物化到临时数据目录（真实 CLI，覆盖 install 路径）。 */
function installToTemp() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcode-engine-')));
  const r = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'install', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `install 应成功：${r.stdout}${r.stderr}`);
  return { dataDir, pkgRoot: join(dataDir, 'plugins', PLUGIN) };
}

/** 装载探针：以包根为 repoRoot 装载副本引擎（等价于运行期 shim 的装载路径）。 */
function probe(pkgRoot) {
  const script = `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs')).href)}).then((m) => { const e = m.loadEngine(${JSON.stringify(pkgRoot)}); if (typeof e.applyRule !== 'function') throw new Error('applyRule 缺失'); process.stdout.write(e.applyRule('tool-vocab-map','mcode',{matcher:'bash|edit'}).result); }).catch((e) => { process.stderr.write(String(e && e.message)); process.exit(3); });`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

/** 清理临时数据目录（守卫同时接受 tmpdir 与其 realpath）。 */
function cleanup(dir) {
  if (typeof dir !== 'string' || dir === '') return;
  if ([tmpdir(), realpathSync(tmpdir())].some((p) => dir.startsWith(p))) rmSync(dir, { recursive: true, force: true });
}

it('物化清单：引擎闭包齐备（两 JSON + src/*.mjs + strategies 六族）', () => {
  const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
  const rels = plan.files.map((f) => f.rel);
  for (const rel of ['plugin-core/degradation-rules.json', 'plugin-core/capability-matrix.json', 'plugin-core/src/engine.mjs', 'plugin-core/src/validate.mjs']) {
    assert.ok(rels.includes(rel), `清单应含 ${rel}`);
  }
  const strategies = readdirSync(join(REPO_ROOT, 'plugin-core', 'src', 'strategies')).filter((n) => n.endsWith('.mjs'));
  assert.equal(strategies.length, 6, '六族执行器');
  for (const name of strategies) assert.ok(rels.includes(`plugin-core/src/strategies/${name}`), `清单应含 strategies/${name}`);
});

it('import 图 ⊆ 物化清单：src 下相对 import 的目标文件必须全部在清单内', () => {
  const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
  const rels = new Set(plan.files.map((f) => f.rel));
  const srcDir = join(REPO_ROOT, 'plugin-core', 'src');
  const files = [...readdirSync(srcDir).filter((n) => n.endsWith('.mjs')), ...readdirSync(join(srcDir, 'strategies')).filter((n) => n.endsWith('.mjs')).map((n) => join('strategies', n))];
  for (const rel of files) {
    const text = readFileSync(join(srcDir, rel), 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join('plugin-core', 'src', dirname(rel), m[1]).split('\\').join('/');
      assert.ok(rels.has(target), `${rel} 的 import ${m[1]} → ${target} 必须在物化清单内`);
    }
  }
});

it('装载探针：物化包根可装载（多一级/少一级均不可读）', () => {
  const { dataDir, pkgRoot } = installToTemp();
  try {
    assert.ok(existsSync(join(pkgRoot, 'plugin-core', 'src', 'validate.mjs')), '副本应含 validate.mjs');
    const ok = probe(pkgRoot);
    assert.equal(ok.status, 0, `探针应成功：${ok.stderr}`);
    assert.equal(ok.stdout, 'bash|edit');
    // 反证：少一级（把 plugin-core 目录当 repoRoot）与多一级都不可读
    for (const wrong of [join(pkgRoot, 'plugin-core'), join(dataDir, 'plugins')]) {
      const bad = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs')).href)}).then((m) => { m.loadEngine(${JSON.stringify(wrong)}); process.exit(0); }).catch(() => process.exit(3));`], { encoding: 'utf8' });
      assert.equal(bad.status, 3, `${wrong} 不应可装载`);
    }
  } finally { cleanup(dataDir); }
});

it('逐字节外全等但不可装载：删 validate.mjs → 装载探针红、verify 红', () => {
  const { dataDir, pkgRoot } = installToTemp();
  try {
    rmSync(join(pkgRoot, 'plugin-core', 'src', 'validate.mjs'));
    const bad = probe(pkgRoot);
    assert.notEqual(bad.status, 0, '缺 validate.mjs 时探针必须失败');
    assert.match(String(bad.stderr), /validate\.mjs|MODULE_NOT_FOUND/, '失败原因须可诊断');
    const verify = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'verify', '--data-dir', dataDir], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, '副本缺失须被 verify 判红');
  } finally { cleanup(dataDir); }
});

it('兜底链单源：队列形态常量 ≡ 规则 params.mcode.pendingLimit（失败面常量不得与规则漂移）', () => {
  const rules = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'degradation-rules.json'), 'utf8'));
  const relay = rules.rules.find((rule) => rule.id === 'stop-pending-relay');
  const limit = relay?.params?.mcode?.pendingLimit;
  assert.equal(PENDING_LIMIT, limit, `hook-lib 的 PENDING_LIMIT(${PENDING_LIMIT}) 必须等于规则 pendingLimit(${String(limit)})`);
});

it('mcode 列 ↔ 适配层映射表机械对拍（批 3 步骤 11）：矩阵 hostToolInventory.mcode ⊆ TOOL_MAP 键集，且键集 ⊇ MATCHER_TOOL_MAP 值集', () => {
  // KV 方向必须按实码：`TOOL_MAP` 是**宿主原名词键 → 上游规范名值**（与 MATCHER_TOOL_MAP /
  // 规则表方向相反）——门 A 曾把这条断言的键值写反（实跑为假），这里按实码钉住。
  const matrix = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin-core', 'capability-matrix.json'), 'utf8'));
  const declared = matrix.capabilities.hostToolInventory.mcode;
  const hostKeys = Object.keys(TOOL_MAP);
  for (const word of declared) assert.ok(hostKeys.includes(word), `矩阵 mcode 列 ${word} 应在 TOOL_MAP 键集内（宿主词侧）`);
  for (const upstream of Object.values(MATCHER_TOOL_MAP)) {
    assert.ok(hostKeys.includes(upstream), `MATCHER_TOOL_MAP 值 ${upstream} 应在 TOOL_MAP 键集内`);
  }
  // 未列入矩阵 mcode 列的宿主词走**原样透传**（等价面登记；本批不接 tool-vocab-map）
  const unmapped = hostKeys.filter((word) => !declared.includes(word));
  assert.equal(unmapped.length, 11, `14 键中 11 个不在 mcode 列（原样透传）：${unmapped.join(',')}`);
});

it('副本污损：改动引擎文件 → verify 报漂移（sha256 逐文件对拍）', () => {
  const { dataDir, pkgRoot } = installToTemp();
  try {
    const target = join(pkgRoot, 'plugin-core', 'src', 'validate.mjs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// tampered\n`, 'utf8');
    const verify = spawnSync(process.execPath, [join(ADAPTER_ROOT, 'cli.mjs'), 'verify', '--data-dir', dataDir], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, '污损须被 verify 判红');
    assert.match(`${verify.stdout}${verify.stderr}`, /变更|drift|1/, '报告须体现变更计数');
  } finally { cleanup(dataDir); }
});

it('装载探针的**判别力**：计划与副本同时缺 strategies ⇒ sha256 面全绿、唯有探针判红', () => {
  // 终审（正确性维度）指出：把 `probeEngineInPackage` 调用注释掉后全套仍 99/99 全绿 ⇒ 探针"存在但无判别力"。
  // 本用例构造探针**唯一**能发现的形态：**计划与副本同时**缺 `strategies/`（逐字节仍全等、无缺失/多余/变更），
  // 但 `engine.mjs` 的静态 import 落空 ⇒ 副本不可装载。判据：**引擎闭包**上 sha256 面全绿（missing/extra 全空、
  // changed 不含 `plugin-core/`）而 problems 含探针失败。（`hooks/hooks.mcode.json` 会因安装期重生成而进入
  // changed，与本用例无关，故按前缀过滤。）
  const { dataDir, pkgRoot } = installToTemp();
  try {
    const plan = planPackage({ repoRoot: REPO_ROOT, plugin: PLUGIN, nodePath: process.execPath });
    rmSync(join(pkgRoot, 'plugin-core', 'src', 'strategies'), { recursive: true, force: true });
    // 探针只在 `missing`/`changed` 全空时运行（有漂移时已红，逻辑自洽）⇒ 这里必须让**全部**面归零：
    // 安装期重生成的 `hooks/hooks.mcode.json` 也会进 changed，故两侧一致移除之。
    rmSync(join(pkgRoot, 'hooks', 'hooks.mcode.json'), { force: true });
    const trimmed = {
      ...plan,
      files: plan.files.filter((file) => !file.rel.startsWith('plugin-core/src/strategies/') && file.rel !== 'hooks/hooks.mcode.json'),
    };
    const report = verifyPackage({ dataDir, plan: trimmed });
    assert.deepEqual(report.missing, [], 'sha256 面不应有缺失');
    assert.deepEqual(report.changed, [], 'sha256 面应全绿（探针的运行前提）');
    assert.deepEqual(report.extra, [], 'sha256 面应全绿（多余文件也不得出现）');
    assert.ok(
      report.problems.some((item) => item.includes('装载探针失败')),
      `唯有装载探针能判红该形态，实得 problems=${JSON.stringify(report.problems)}`,
    );
  } finally { cleanup(dataDir); }
});

it('来源归一的**接入**判别力：改包内 `accepted` ⇒ 归一结果随规则变化（证明真的走引擎）', () => {
  // 终审指出：把该消费点换回内联实现仍全绿 ⇒ "接入面无判别力"。本用例改**包内**规则数据，
  // 断言行为随之变化：把 `fork` 加进 `accepted` 后，`fork` 必须归一为 `fork` 而非 `startup`。
  const { dataDir, pkgRoot } = installToTemp();
  try {
    const engineFrom = () => {
      const require = createRequire(import.meta.url);
      const { loadEngine } = require(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs'));
      return loadEngine(pkgRoot);
    };
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    const normalize = (engine) => normalizePayload('SessionStart', { source: 'fork' }, { projectDir: '/tmp', engine }).source;
    assert.equal(normalize(engineFrom()), 'startup', '基线：域外值 fork 归一为 startup');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'source-widen-normalize') rule.params.mcode.accepted = ['startup', 'resume', 'clear', 'compact', 'fork'];
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      assert.equal(normalize(engineFrom()), 'fork', '改规则后必须随动（否则说明该点没走引擎）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
    assert.equal(normalize(engineFrom()), 'startup', '还原后回到基线');
  } finally { cleanup(dataDir); }
});

it('入口守卫：经**符号链接路径**调用 CLI 必须正常执行（realpathSync 判别力）', () => {
  // 形态：`import.meta.url === pathToFileURL(argv[1]).href` 在 symlink 别名路径下判等恒假 ⇒ 整条 CLI 静默 no-op。
  // 判别力：去掉 `realpathSync` 即红（输出为空且 exit 0）。
  const linkRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcode-symlink-')));
  try {
    const linkPath = join(linkRoot, 'cli-link.mjs');
    symlinkSync(join(ADAPTER_ROOT, 'cli.mjs'), linkPath);
    const r = spawnSync(process.execPath, [linkPath, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(String(r.stdout), /用法/, `symlink 路径下 CLI 必须有输出（实得 stdout=${JSON.stringify(r.stdout)}）`);
  } finally { cleanup(linkRoot); }
});

it('槽位迁移的**接入**判别力：改包内 `rename` ⇒ 槽位不再迁移（证明真的走引擎）', () => {
  const { dataDir, pkgRoot } = installToTemp();
  try {
    const engineFrom = () => {
      const require = createRequire(import.meta.url);
      const { loadEngine } = require(join(pkgRoot, 'plugin-core', 'src', 'engine.mjs'));
      return loadEngine(pkgRoot);
    };
    const envelope = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', systemMessage: 'SM' } };
    const reasonOf = (engine) => translateResponse('PreToolUse', envelope, { blocked: true, engine }).hookSpecificOutput.permissionDecisionReason;
    assert.equal(reasonOf(engineFrom()), 'SM', '基线：systemMessage 迁移为 permissionDecisionReason');
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'message-slot-migration') rule.params.mcode.rename = { otherSlot: 'permissionDecisionReason' };
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      assert.equal(reasonOf(engineFrom()), undefined, '改规则后槽位必须不再迁移（否则说明该点没走引擎）');
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  } finally { cleanup(dataDir); }
});

it('deadline 派生的**接入**判别力：改包内 `defaultSeconds` ⇒ 子进程预算随动（走引擎公式）', () => {
  const { dataDir, pkgRoot } = installToTemp();
  try {
    // 夹具：耗时 1400ms 的子钩子——规则 `defaultSeconds=5` ⇒ 预算 4200ms（跑完）；改为 1 ⇒ 预算触到
    // `minBudgetMs` 下限 **1000ms**（< 1400ms ⇒ 被终止 ⇒ 降级）。注意下限是硬地板，别把夹具设得太短。
    writeFileSync(join(pkgRoot, 'hooks', 'slow.mjs'), 'setTimeout(() => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "OK" } }) + "\\n"); }, 1400);\n', 'utf8');
    // `timeoutSeconds: 0` ⇒ 走规则 `defaultSeconds`（否则命令行尾参会覆盖默认值，注不进默认值面）
    const run = () => runShim({ pkgRoot, dataDir, timeoutSeconds: 0, event: 'SessionStart', script: 'hooks/slow.mjs', payload: {} });
    const baseline = run();
    assert.match(String(baseline.frame?.hookSpecificOutput?.additionalContext ?? ''), /OK/, '基线预算（defaultSeconds=5）应让子钩子跑完');
    const rulesPath = join(pkgRoot, 'plugin-core', 'degradation-rules.json');
    const original = readFileSync(rulesPath, 'utf8');
    try {
      const rules = JSON.parse(original);
      for (const rule of rules.rules) if (rule.id === 'timeout-cap-fail-open') rule.params.mcode.defaultSeconds = 1;
      writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      const squeezed = run();
      // 超时降级**不产帧**：提醒入队等下一次 UserPromptSubmit 投递（内部决策-034 决策 5/7）⇒ 判据取状态面
      assert.equal(squeezed.frame, null, '超时必须零输出（不假装通过）');
      const pending = JSON.parse(readFileSync(join(dataDir, 'relay-state.json'), 'utf8')).frames.map((f) => f.text).join('\n');
      assert.match(pending, /钩子降级/, `预算被规则压到下限 1000ms 后应落降级提醒（实得：${JSON.stringify(pending)}）`);
    } finally {
      writeFileSync(rulesPath, original, 'utf8');
    }
  } finally { cleanup(dataDir); }
});
