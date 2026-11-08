// 文件：retro-metrics.test.mjs
// 描述：retro 指标脚本（retro-metrics.mjs）的 TDD 测试——先写测试后写实现（内部规则-2、
//       内部决策-1 首选案），用临时 git 仓库构造已知提交序列，锁定四项指标数值与
//       无仓库错误路径的 CLI 契约（退出码 + JSON stdout）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；fixture 全部用临时 git 仓库，测完即清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'retro-metrics.mjs');

/**
 * 以子进程方式运行被测脚本——CLI 契约（stdout JSON + 退出码）必须整进程验证。
 * @param {string} repoPath 传给脚本的仓库路径参数
 * @param {Record<string, string>} [extraEnv] 追加环境变量（内部任务-345：fake git 注入用）
 * @returns {{ status: number | null, stdout: string, stderr: string, json: any }}
 */
function run(repoPath, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, repoPath], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null; // stdout 不是 JSON 本身就是断言失败证据，交给各用例判
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

/**
 * 在指定目录执行 git 命令——为什么不用 shell 串接：参数含中文与空格，数组形态免转义。
 * @param {string} cwd 工作目录
 * @param {string[]} args git 参数
 * @param {Record<string, string>} [envExtra] 附加环境变量（提交时间锁定用）
 * @returns {void}
 */
function git(cwd, args, envExtra = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...envExtra } });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
}

/**
 * 造一个已知提交：写入指定文件（各带 N 行新增）、git add 明确路径、按给定时间提交。
 * @param {string} repo 仓库路径
 * @param {{ message: string, at: string, files: Array<{ path: string, lines: number }> }} spec 提交规格
 * @returns {void}
 */
function commit(repo, spec) {
  for (const f of spec.files) {
    mkdirSync(dirname(join(repo, f.path)), { recursive: true });
    writeFileSync(join(repo, f.path), Array.from({ length: f.lines }, (_, i) => `line-${i + 1}`).join('\n') + '\n');
  }
  // 为什么锁两个时间：作者时间与提交时间都定死，指标切分才不受测试运行时钟影响
  const dateEnv = { GIT_AUTHOR_DATE: spec.at, GIT_COMMITTER_DATE: spec.at };
  git(repo, ['add', ...spec.files.map((f) => f.path)], dateEnv);
  git(repo, ['commit', '-q', '-m', spec.message], dateEnv);
}

/**
 * 建临时 git 仓库（含 user 配置，提交不依赖宿主全局配置）。
 * @returns {string} 仓库路径
 */
function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'retro-metrics-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'user.email', 'tester@example.com']);
  return repo;
}

/**
 * 写一个「locale 敏感」fake git（内部任务-345）：`LC_ALL !== 'C'` 时按中文文案退 128（模拟真实
 * git 在非英文 locale 下的空仓报错），`LC_ALL === 'C'` 时按英文文案退 128——用于确定性
 * 验证「spawn 侧固定 C locale」而不依赖本机是否安装 zh_CN 翻译。
 * @param {string} dir 存放桩的目录
 * @returns {string} 桩脚本路径
 */
function localeFakeGit(dir) {
  const fake = join(dir, 'fake-git.mjs');
  writeFileSync(
    fake,
    [
      "import { writeFileSync } from 'node:fs';",
      "const env = process.env;",
      "if (env.WF_FAKE_ENV_FILE) writeFileSync(env.WF_FAKE_ENV_FILE, JSON.stringify({ LC_ALL: env.LC_ALL, LANG: env.LANG }));",
      "if (process.argv.includes('rev-parse')) { process.stdout.write('true\\n'); process.exit(0); }",
      "if (env.WF_FAKE_LOCALE_SENSITIVE === '1' && env.LC_ALL !== 'C') { process.stderr.write('fatal: 当前分支尚无任何提交\\n'); process.exit(128); }",
      "if (process.argv.includes('log')) { process.stderr.write(\"fatal: your current branch 'main' does not have any commits yet\\n\"); process.exit(128); }",
      'process.exit(0);',
    ].join('\n'),
  );
  return fake;
}

/**
 * 已知提交序列 fixture：5 个提交、3 个会话（间隔 10/80/10/140 分钟）、
 * 2 个修复类消息（fix / resolve）、src 目录 7/8 的文件改动占比、
 * 加权得分 4+3+5+18+20=50（其中最后一个提交触发单提交上限 20）。
 * @returns {{ repo: string, expected: { weightedCommits: number, sessions: number, fixRatio: number, focusScore: number } }}
 */
function knownSeriesRepo() {
  const repo = tempRepo();
  const D = '2026-09-01T';
  commit(repo, { at: `${D}10:00:00`, message: 'feat: add parser core', files: [{ path: 'src/a.txt', lines: 1 }, { path: 'src/b.txt', lines: 1 }] });
  commit(repo, { at: `${D}10:10:00`, message: 'chore: 更新构建配置', files: [{ path: 'src/c.txt', lines: 3 }] });
  commit(repo, { at: `${D}11:30:00`, message: 'fix: 修复文档排版错误', files: [{ path: 'docs/guide.md', lines: 5 }] });
  commit(repo, { at: `${D}11:40:00`, message: 'feat: add api endpoints', files: [{ path: 'src/d.txt', lines: 2 }, { path: 'src/e.txt', lines: 2 }, { path: 'src/f.txt', lines: 2 }] });
  commit(repo, { at: `${D}14:00:00`, message: 'resolve 构建告警', files: [{ path: 'src/big.txt', lines: 30 }] });
  return {
    repo,
    expected: { weightedCommits: 50, sessions: 3, fixRatio: 2 / 5, focusScore: 7 / 8 },
  };
}

/** 浮点比率用容差断言——2/5 不是二进制精确值，硬等值会假红。 */
function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}：期望 ${expected}，实际 ${actual}`);
}

test('指标：已知提交序列 → 四项指标逐项命中，且输出含全部五个契约键', () => {
  const { repo, expected } = knownSeriesRepo();
  try {
    const r = run(repo);
    assert.equal(r.status, 0, `stderr：${r.stderr}`);
    assert.equal(r.json.weightedCommits, expected.weightedCommits);
    assert.equal(r.json.sessions, expected.sessions);
    assertClose(r.json.fixRatio, expected.fixRatio, 'fixRatio');
    assertClose(r.json.focusScore, expected.focusScore, 'focusScore');
    // 契约键完整性：五个指标键 + 自察热度键（内部模块-15/内部决策-019）+ 周期口径键（内部规则-8）
    assert.deepEqual(
      Object.keys(r.json).sort(),
      ['fixRatio', 'focusScore', 'generatedAt', 'period', 'selfCheckHeat', 'sessions', 'weightedCommits'],
    );
    assert.equal(r.json.period.range, 'full-history', '无边界参数必须显式标注全历史口径');
    // generatedAt 必须是合法 ISO 时间——快照对比依赖它排序
    assert.ok(!Number.isNaN(Date.parse(r.json.generatedAt)), `generatedAt 不是合法时间：${r.json.generatedAt}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('会话切分：间隔恰为 45 分钟不切（严格大于才切新会话）', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    commit(repo, { at: '2026-09-02T09:45:00', message: 'feat: second', files: [{ path: 'src/y.txt', lines: 1 }] });
    const r = run(repo);
    assert.equal(r.status, 0);
    assert.equal(r.json.sessions, 1, '45 分钟整间隔应留在同一会话');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('空仓库：git init 但零提交 → 退出 0，指标全为 0（与无仓库错误区分）', () => {
  const repo = tempRepo();
  try {
    const r = run(repo);
    assert.equal(r.status, 0, `stderr：${r.stderr}`);
    assert.equal(r.json.weightedCommits, 0);
    assert.equal(r.json.sessions, 0);
    assert.equal(r.json.fixRatio, 0);
    assert.equal(r.json.focusScore, 0);
    // 内部模块-15：无 .workflow/ 运行态 → 自察热度为空态（如实报告无数据，不冒充）
    assert.deepEqual(r.json.selfCheckHeat, {
      open: 0,
      top: [],
      causeCounts: {},
      dispositionRate: 0,
      oldestPendingAgeDays: 0,
      lostFacts: 0,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('retro-metrics 空仓库 locale 固定：宿主非 C 环境仍退 0（WF_GIT_BIN 桩）', () => {
  const repo = tempRepo();
  const dir = mkdtempSync(join(tmpdir(), 'retro-locale-'));
  const prev = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  try {
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.LANG = 'zh_CN.UTF-8';
    const fake = localeFakeGit(dir);
    const envFile = join(dir, 'seen-env.json');
    const r = run(repo, { WF_GIT_BIN: fake, WF_FAKE_LOCALE_SENSITIVE: '1', WF_FAKE_ENV_FILE: envFile });
    assert.equal(r.status, 0, `stderr：${r.stderr}`);
    assert.equal(r.json.weightedCommits, 0);
    assert.equal(r.json.sessions, 0);
    const seen = JSON.parse(readFileSync(envFile, 'utf8'));
    assert.equal(seen.LC_ALL, 'C', 'git 子进程 LC_ALL=C');
    assert.equal(seen.LANG, 'C', 'git 子进程 LANG=C');
  } finally {
    if (prev.LC_ALL === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = prev.LC_ALL;
    if (prev.LANG === undefined) delete process.env.LANG; else process.env.LANG = prev.LANG;
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自察热度（内部模块-15）：读 repoPath 下 内部工作流状态 聚合 open 与 digest Top', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    const rec = (id, digest, status) =>
      JSON.stringify({ schemaVersion: 1, id, ts: Date.now(), session: 's', kind: 'tool-failure', digest, status });
    writeFileSync(
      join(repo, '.workflow', 'incidents.jsonl'),
      [rec('i1', 'hot111111111111', 'open'), rec('i2', 'hot111111111111', 'open'), rec('i3', 'hot111111111111', 'resolved'), rec('i4', 'cold22222222222', 'open')].join('\n') + '\n',
    );
    const r = run(repo);
    assert.equal(r.status, 0, `stderr：${r.stderr}`);
    assert.equal(r.json.selfCheckHeat.open, 3, 'open 只数未解决记录');
    assert.ok(Array.isArray(r.json.selfCheckHeat.top) && r.json.selfCheckHeat.top.length >= 1);
    assert.equal(r.json.selfCheckHeat.top[0].digest, 'hot111111111111', '热度榜首为复发 digest');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('错误路径：非 git 目录 → 退出 1，stdout 是含 error 键的 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-metrics-nogit-'));
  try {
    writeFileSync(join(dir, 'plain.txt'), 'not a repo\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.ok(r.json && typeof r.json.error === 'string' && r.json.error.length > 0, `error 键缺失：${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏 --base 引用：退 1 + error JSON（不折成全零指标假绿，2026-09-19 评审修复 3.7）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-badbase-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'c1']);
    const r = spawnSync(process.execPath, [SCRIPT, dir, '--base', 'nonexistent-ref'], { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    assert.equal(r.status, 1, '坏 base 是采集错误退 1');
    assert.ok(json && typeof json.error === 'string' && json.error.includes('git log 采集失败'),
      `error JSON 点名采集失败：${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063 D7）：selfCheckHeat 分类面/处置率/最老待排查/lost-facts。
// ─────────────────────────────────────────────────────────────────────────────

/** 在仓库根写自察账本（覆盖写；WF_INCIDENT_ROOT 未设时同根）。 */
function seedIncidents(repo, rows) {
  mkdirSync(join(repo, '.workflow'), { recursive: true });
  writeFileSync(join(repo, '.workflow', 'incidents.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/** 一条自察记录（缺省 open/近期）。 */
const irec = (over = {}) => ({ schemaVersion: 1, id: 'ri-r', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'dr0000000000001', status: 'open', ...over });

test('内部模块-15 v2 retro 分类面：causeCounts 30 天窗口按 cause 分组（旧记录回退 unclassified）', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    const now = Date.now();
    seedIncidents(repo, [
      irec({ id: 'c1', cause: 'real-failure', ts: now - 86400000 }),
      irec({ id: 'c2', cause: 'real-failure', ts: now - 86400000, digest: 'dr0000000000002' }),
      irec({ id: 'c3', cause: 'probe-noise', ts: now - 86400000, digest: 'dr0000000000003' }),
      irec({ id: 'c4', ts: now - 86400000, digest: 'dr0000000000004' }), // 旧行：unclassified
      irec({ id: 'c5', cause: 'real-failure', ts: now - 60 * 86400000, digest: 'dr0000000000005' }), // 窗外
    ]);
    const r = run(repo);
    assert.equal(r.status, 0, `stderr：${r.stderr}`);
    const h = r.json.selfCheckHeat;
    assert.deepEqual(h.causeCounts, { 'real-failure': 2, 'probe-noise': 1, unclassified: 1 }, '窗口内按 cause 分组；窗外不计');
    assert.equal(h.open, 5, '旧键 open 口径不变（未解决计数，窗口无关）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 retro 分类面：dispositionRate（窗内非证据面已处置占比；空态 0 不除零）', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    const now = Date.now();
    seedIncidents(repo, [
      irec({ id: 'd1', cause: 'real-failure', status: 'resolved', ts: now - 86400000 }),
      irec({ id: 'd2', cause: 'real-failure', status: 'open', ts: now - 86400000, digest: 'dr1000000000002' }),
      irec({ id: 'd3', cause: 'probe-noise', status: 'archived', ts: now - 86400000, digest: 'dr1000000000003' }), // 证据面：不入分母
      irec({ id: 'd4', cause: 'real-failure', status: 'resolved', ts: now - 40 * 86400000, digest: 'dr1000000000004' }), // 窗外
    ]);
    const h = run(repo).json.selfCheckHeat;
    assert.equal(h.dispositionRate, 0.5, '分母＝窗内非证据面 2 条、分子＝其中已处置 1 条');
    // 空态：无记录 ⇒ 0（不除零、不出 NaN）
    const empty = tempRepo();
    try {
      commit(empty, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/y.txt', lines: 1 }] });
      const h0 = run(empty).json.selfCheckHeat;
      assert.equal(h0.dispositionRate, 0, '空态 0（不除零）');
      assert.equal(h0.oldestPendingAgeDays, 0, '无待排查 ⇒ 0 天');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 retro 分类面：oldestPendingAgeDays（最老待排查年龄；证据面/非 open 不计）', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    const now = Date.now();
    seedIncidents(repo, [
      irec({ id: 'o1', cause: 'real-failure', ts: now - 10 * 86400000 }),
      irec({ id: 'o2', cause: 'real-failure', ts: now - 3 * 86400000, digest: 'dr2000000000002' }),
      irec({ id: 'o3', cause: 'probe-noise', ts: now - 90 * 86400000, digest: 'dr2000000000003' }), // 证据面：不算
      irec({ id: 'o4', cause: 'real-failure', status: 'triaged', ts: now - 120 * 86400000, digest: 'dr2000000000004' }), // 非 open：不算
    ]);
    const h = run(repo).json.selfCheckHeat;
    assert.equal(h.oldestPendingAgeDays, 10, '最老待排查＝10 天前（证据面/已 triage 的更老记录不计）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部模块-15 v2 retro 分类面：lostFacts 读兜底旁路行数（缺失 0；与 digest/SessionStart 同源）', () => {
  const repo = tempRepo();
  try {
    commit(repo, { at: '2026-09-02T09:00:00', message: 'feat: first', files: [{ path: 'src/x.txt', lines: 1 }] });
    assert.equal(run(repo).json.selfCheckHeat.lostFacts, 0, '缺失按 0');
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'incidents-lost.jsonl'), '{"schemaVersion":1,"kind":"observation-degraded"}\n{"schemaVersion":1,"kind":"hook-failure"}\n\n');
    assert.equal(run(repo).json.selfCheckHeat.lostFacts, 2, '非空行数（空行不计）');
    // 评审修复 N4：坏行/半行（无末尾换行）口径与 store 单源一致——都按非空行计
    writeFileSync(join(repo, '.workflow', 'incidents-lost.jsonl'), '{"schemaVersion":1}\n\n{half-written');
    assert.equal(run(repo).json.selfCheckHeat.lostFacts, 2, '坏行/半行照计、空行不计（单源 countLostFacts）');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部任务-244 Q05/Q06：computeSelfCheckHeat 单次读盘派生 open/Top3；证据面谓词单源（规则表）', async () => {
  const repo = tempRepo();
  // 内部任务-349：appendIncident 现会补 internal 归因行（写状态根）——夹具注入独立状态根，防写真实用户级目录
  const savedStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = join(repo, '.tmp-routing-state');
  try {
    const { appendIncident } = await import('../lib/incident-store.mjs');
    const { computeSelfCheckHeat } = await import('../retro-metrics.mjs');
    appendIncident(repo, { id: 'q5-a', ts: Date.now(), session: 's', kind: 'tool-failure', status: 'open', digest: 'q5a' });
    appendIncident(repo, { id: 'q5-b', ts: Date.now(), session: 's', kind: 'tool-failure', status: 'resolved', digest: 'q5a', cause: 'real-failure' });
    appendIncident(repo, { id: 'q5-c', ts: Date.now(), session: 's', kind: 'lease-deny', status: 'open', digest: 'q5c' });
    let reads = 0;
    const reader = (file) => {
      reads += 1;
      return readFileSync(file, 'utf8');
    };
    const h = computeSelfCheckHeat(repo, { reader });
    assert.equal(reads, 1, '自察指标单次读盘（原 openCount+heat 各再读一次＝3 次）');
    assert.equal(h.open, 2, 'open 计数由同一 rows 派生');
    assert.equal(h.top[0].digest, 'q5a', 'Top3 由同一 rows 派生');
    assert.equal(h.top[0].count, 2);
    // 证据面单源：lease-deny（无 cause 旧口径）计证据面、tool-failure 计入分母 → 处置率 1/2
    assert.equal(h.dispositionRate, 0.5, '证据面谓词单源（规则表 evidenceCauses/旧两层回退）');
  } finally {
    if (savedStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = savedStateDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

