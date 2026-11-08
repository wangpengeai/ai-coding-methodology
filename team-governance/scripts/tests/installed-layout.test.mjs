// 文件：installed-layout.test.mjs
// 描述：六插件安装布局端到端测试（D 计划步骤 18 / A-M14 安装验收）——模拟 marketplace
//       缓存形态（<plugin>/<version>/）：六 manifest 加载、hooks 声明解析、脚本相对
//       引用可定位、旧版本目录保留语义（AGENTS 已知陷阱：清旧版致运行中 hook 静默失效）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGINS = ['workflow', 'spec-gate', 'scout', 'team-governance', 'algo-loop', 'research-loop'];

// ── 仓库形态守卫（内部未决-18，2026-09-15 激活域批次 内部任务-ACTDOMAIN-1）──
// REPO 以 import.meta.url 上溯三级推导，仅在仓库形态（<repo>/<插件>/scripts/tests）成立；
// 从真实装机树（cache/<市场>/<插件>/<版本>/scripts/tests）运行时上溯落点是市场目录，
// 三条用例会在共用 makeInstalledTree 处 ENOENT 三连红（0.3.0 装机实测 35/38，属测试
// 位置假设而非装机缺陷）。守卫使误跑输出可读跳过；实测 node --test 对零测试注册即
// exit 0 的文件判通过，故直接 process.exit(0)（评测记录见计划任务 6 验收）。
if (!existsSync(join(REPO, 'workflow', '.zcode-plugin', 'plugin.json'))) {
  console.log(
    `SKIP: 仓库形态守卫——本测试以 import.meta.url 上溯三级求 REPO（本次解析到 ${REPO}），` +
      '仅仓库形态（<repo>/<插件>/scripts/tests）可运行；请勿从装机树 cache/<市场>/<插件>/<版本>/ 运行' +
      '（release-suite 装机指引「装机态判据」节已指名）。',
  );
  process.exit(0);
}

/** 造一个 marketplace 缓存形态的安装树（含新旧两版本目录）。 */
function makeInstalledTree() {
  const root = mkdtempSync(join(tmpdir(), 'tg-install-'));
  const cache = join(root, 'cache', 'wangp-local-marketplace');
  for (const p of PLUGINS) {
    const src = join(REPO, p);
    const ver = JSON.parse(readFileSync(join(src, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    // 新版本目录（当前源）
    cpSync(src, join(cache, p, ver), { recursive: true });
    // 旧版本目录（占位：保留语义——旧目录不删，运行中会话 hook 路径仍指向它）
    mkdirSync(join(cache, p, '0.0.1'), { recursive: true });
    writeFileSync(join(cache, p, '0.0.1', 'placeholder'), '');
  }
  // installed_plugins.json：指针只指向新版本
  const installed = {};
  for (const p of PLUGINS) {
    const ver = JSON.parse(readFileSync(join(REPO, p, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    installed[p] = `${ver}`;
  }
  writeFileSync(join(cache, 'installed_plugins.json'), JSON.stringify(installed, null, 2));
  return { root, cache };
}

test('六插件 manifest 加载与 hooks 声明解析（安装树内相对路径可定位）', () => {
  const { root, cache } = makeInstalledTree();
  try {
    for (const p of PLUGINS) {
      const ver = JSON.parse(readFileSync(join(REPO, p, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
      const pluginDir = join(cache, p, ver);
      const manifest = JSON.parse(readFileSync(join(pluginDir, '.zcode-plugin', 'plugin.json'), 'utf8'));
      assert.equal(manifest.name, p, `${p} manifest name 一致`);
      assert.ok(manifest.version, `${p} 有版本号`);
      // hooks 声明内引用的脚本在安装树内存在
      const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
      if (existsSync(hooksPath)) {
        const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
        for (const [event, matchers] of Object.entries(hooks.hooks ?? {})) {
          for (const m of matchers) {
            for (const h of m.hooks ?? []) {
              const script = h.args?.[0]?.replace('${ZCODE_PLUGIN_ROOT}', pluginDir);
              if (script) {
                assert.ok(existsSync(script), `${p}/${event} hook 脚本存在：${script}`);
              }
            }
          }
        }
      }
      // skill frontmatter 可解析
      const skillsDir = join(pluginDir, 'skills');
      if (existsSync(skillsDir)) {
        for (const s of readdirSyncSafe(skillsDir)) {
          const skill = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
          assert.ok(skill.startsWith('---'), `${p}/${s} frontmatter 存在`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧版本目录保留语义：指针更新后旧目录不删（运行中会话 hook 不静默失效）', () => {
  const { root, cache } = makeInstalledTree();
  try {
    // 模拟发布新版本：新增 9.9.9 目录，指针只改 installed_plugins.json
    for (const p of PLUGINS) {
      mkdirSync(join(cache, p, '9.9.9'), { recursive: true });
    }
    const installed = JSON.parse(readFileSync(join(cache, 'installed_plugins.json'), 'utf8'));
    for (const p of PLUGINS) installed[p] = '9.9.9';
    writeFileSync(join(cache, 'installed_plugins.json'), JSON.stringify(installed));
    // 旧版本目录仍存在（保留即语义正确）
    for (const p of PLUGINS) {
      const ver = JSON.parse(readFileSync(join(REPO, p, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
      assert.ok(existsSync(join(cache, p, ver)), `${p} 旧版本目录 ${ver} 保留`);
      assert.ok(existsSync(join(cache, p, '0.0.1')), `${p} 占位旧目录保留`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('仓库形态守卫：装机树形态运行本文件输出可读 SKIP 并退 0（OPEN-18 对拍判据）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tg-skip-'));
  try {
    // 把本文件拷贝成装机树形态（上溯三级落点是市场目录，无 workflow/.zcode-plugin）
    const fakeInstall = join(tmp, 'cache', 'market', 'team-governance', '0.3.0', 'scripts', 'tests');
    mkdirSync(fakeInstall, { recursive: true });
    cpSync(fileURLToPath(import.meta.url), join(fakeInstall, 'installed-layout.test.mjs'));
    const r = spawnSync(process.execPath, [join(fakeInstall, 'installed-layout.test.mjs')], {
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, `装机树形态应可读跳过而非 ENOENT 三连红（stderr：${r.stderr}）`);
    assert.ok((r.stdout ?? '').includes('SKIP'), `输出含可读 SKIP 说明（收到：${r.stdout}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('五 SessionStart hook 冒烟（安装树内 node 可执行、fail-open 退 0；零钩子插件跳过——research-loop Stage 1 无 hooks，ADR-047）', async () => {
  // 仓库形态守卫前置：本文件在装机树形态会 process.exit(0)，故 lib 依赖用动态 import
  // （静态 import 会在守卫前求值，装机树形态直接 ENOENT——内部任务-254 H16 顺修）。
  const { osObserveHome } = await import('../lib/os-observe-store.mjs');
  const { root, cache } = makeInstalledTree();
  try {
    for (const p of PLUGINS) {
      const ver = JSON.parse(readFileSync(join(REPO, p, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
      const pluginDir = join(cache, p, ver);
      const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
      if (!existsSync(hooksPath)) continue; // 零钩子插件无 hooks 树（物化条件分支）
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
      const sessionHooks = (hooks.hooks?.SessionStart ?? []).flatMap((m) => m.hooks ?? []);
      assert.ok(sessionHooks.length > 0, `${p} 有 SessionStart hook`);
      for (const h of sessionHooks) {
        const script = h.args[0].replace('${ZCODE_PLUGIN_ROOT}', pluginDir);
        // 内部任务-254（H16）：冒烟自含——注入 OS_OBSERVE_HOME=<tmp>，真实用户目录零触达；
        // 注入根内预置一条 raw 样本，使「产物只落注入根」成为可观察断言（不是空跑）。
        const obsHome = join(root, 'os-observe');
        if (p === 'team-governance') {
          mkdirSync(join(obsHome, 'raw'), { recursive: true });
          writeFileSync(join(obsHome, 'raw', 'samples-h16.jsonl'),
            JSON.stringify({ ts: '2026-10-29T10:00:00.000Z', source: 'dns', endpoint: 'evil.example.com', process: 'curl' }) + '\n',
            'utf8');
        }
        const onDisk = process.env.OS_OBSERVE_HOME;
        process.env.OS_OBSERVE_HOME = obsHome;
        try {
          assert.equal(osObserveHome(), obsHome, `${p} osObserveHome() 解析根＝注入根`);
        } finally {
          if (onDisk === undefined) delete process.env.OS_OBSERVE_HOME;
          else process.env.OS_OBSERVE_HOME = onDisk;
        }
        // 两处取值理由：
        // ① 解释器用 process.execPath 而非裸 'node'：PATH 名字解析在 Windows 上会命中同名
        //    shim（Python 应用执行别名先例，AGENTS 已知陷阱），解释器取当前进程自己的
        //    可执行文件既更严格也更确定（本文件另一用例同款做法）。
        // ② timeout 必须 ≥ 该 hook 声明的自身上限：team-governance 的 SessionStart 声明
        //    timeoutMs=20000，其内部补位采集（os-observe 两枚部署脚本各 6s 超时）是合法
        //    工作；用 10s 卡它会让「装机树内可执行且 fail-open」这条断言在采集路径上偶发
        //    假红（2026-09-28 实测：12 次全仓批跑复现 2 次，单跑与冷启动均不复现）。
        const r = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 25000,
          env: { ...process.env, ZCODE_PROJECT_DIR: root, OS_OBSERVE_HOME: obsHome }, stdio: ['ignore', 'pipe', 'pipe'] });
        // fail-open：不因未接入而崩
        if (p === 'team-governance') {
          // 产物只落注入根：findings 物化在注入根内，项目根与真实用户目录零写入
          assert.ok(existsSync(join(obsHome, 'findings.jsonl')), 'os-observe 产物落在注入根（H16 自含）');
          assert.ok(!existsSync(join(root, 'findings.jsonl')), '产物不得落项目根');
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readdirSyncSafe(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
