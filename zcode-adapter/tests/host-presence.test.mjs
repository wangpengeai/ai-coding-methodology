// 文件：host-presence.test.mjs
// 描述：宿主应用在位探测用例（内部决策-048/内部任务-11）——detectHostApp 注入缝单测（零真机）＋
//       runInstall 收尾行按在位分叉（在位＝正常完成句；未检出＝如实改口「数据面物化
//       就绪」且不阻断安装——预装合法，内部任务-121 教训的输出面兑现）。与 assurance 探针
//       （probes.mjs host-app-present）同库两独立读取者的 Node 侧行为锚。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 workflow/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { detectHostApp, detectHookInterpreter, hookInterpreterLine } from '../src/host-presence.mjs';
import { runInstall } from '../src/install.mjs';
import { makeRepo, makeMarket, makeZcodeHome, removeRoot } from './helpers.mjs';

/** 全绿三件套（verify.test freshWorld 同款）＋清理句柄。 */
function freshWorld() {
  const { repo } = makeRepo();
  const { market } = makeMarket(repo);
  const zhome = makeZcodeHome(market);
  return { repo, market, zhome, clean: () => { removeRoot(repo); removeRoot(market); removeRoot(zhome.home); } };
}

/** 进程 env 临时覆盖（用后必还）。 */
function withEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('detectHookInterpreter 注入缝：PATH 命中 tmp 假 node 返回绝对路径／空 PATH 返回 null（内部未决-243 缓解面，内部任务-275）', { skip: process.platform === 'win32' && 'win32 夹具绝对路径盘符冒号被 darwin PATH 分隔符「:」撕碎，POSIX PATH 形态探测仅 POSIX 机可测（内部任务-279；内部任务-278 归因 R2）' }, () => {
  const d = join(tmpdir(), `zcode-interp-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  try {
    const bin = join(d, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'node');
    writeFileSync(fake, '');
    chmodSync(fake, 0o755);
    // posix 注入（分隔符 ':'），按 PATH 顺序取第一个可执行命中；空目录在前不命中
    const hit = detectHookInterpreter({ PATH: [join(d, 'empty'), bin].join(':') }, 'darwin');
    assert.equal(hit.resolved, fake, '按 PATH 顺序返回第一个命中的绝对路径');
    const miss = detectHookInterpreter({ PATH: '' }, 'darwin');
    assert.equal(miss.resolved, null, '空 PATH 返回 null');
    assert.match(hookInterpreterLine(hit), /钩子解释器：node → .*本 CLI 进程 PATH 解析；宿主进程 PATH 可能不同/);
    assert.match(hookInterpreterLine(miss), /PATH 内未解析到 node：宿主侧钩子将以 fail-open 静默空转/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('runInstall 输出解释器探测行：PATH 无 node 时显著告警且不阻断（内部任务-275）', () => {
  const w = freshWorld();
  try {
    const lines = [];
    const r = withEnv('PATH', '', () =>
      runInstall({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home, out: (s) => lines.push(s) }));
    const out = lines.join('');
    assert.equal(r.code, 0, `解释器未解析不阻断安装：${out}`);
    assert.match(out, /PATH 内未解析到 node：宿主侧钩子将以 fail-open 静默空转/);
  } finally {
    w.clean();
  }
});

test('detectHostApp 注入缝：env 覆盖命中＝present、未命中＝absent（零真机）', () => {
  const d = join(tmpdir(), `zcode-host-seam-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  try {
    const appDir = join(d, 'ZCode.app');
    mkdirSync(appDir, { recursive: true });
    const yes = detectHostApp({ ZCODE_APP_ROOT: appDir });
    assert.equal(yes.present, true);
    assert.equal(yes.hit, appDir);
    const no = detectHostApp({ ZCODE_APP_ROOT: join(d, 'nowhere.app') });
    assert.equal(no.present, false);
    assert.deepEqual(no.candidates, [join(d, 'nowhere.app')]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('detectHostApp 平台三态：win32/linux 走真值候选（含身份锚）/无记载平台 fail-loud', () => {
  // win32：真值签名库已回填（2026-10-21 内部任务-188，内部未决-129 三宿主 win32 面关闭）——候选表返回，
  // 命中与否按本机安装位判定；不以「不可机检」记账（该状态仅剩未取证空列平台）。
  const win32 = detectHostApp({}, 'win32');
  assert.ok(win32.candidates.some((c) => c.includes('ZCode')), `win32 候选应含 ZCode 安装位（实得 ${JSON.stringify(win32.candidates)}）`);
  assert.equal(win32.present, win32.candidates.some((c) => existsSync(c)));
  if (!win32.present) assert.ok(win32.reason === undefined || !win32.reason.includes('不可机检'), String(win32.reason));
  // linux：真值签名库 2026-11-02 回填（内部任务-281，内部未决-208）——候选=宿主自管 release 树（产品安装
  // 事实；~/.zcode 裸目录不可作锚——adapter 装机也写它，数据面≠在位，内部任务-121 教训）
  const linux = detectHostApp({}, 'linux');
  assert.deepEqual(linux.candidates, [join(homedir(), '.zcode', 'server', 'releases')], 'linux 候选=签名库 ~/ 展开形态');
  assert.equal(linux.present, existsSync(linux.candidates[0]), 'present ≡ 候选存在');
  if (!linux.present) assert.ok(linux.reason === undefined || !linux.reason.includes('不可机检'), String(linux.reason));
  // 非记载平台（sunos）⇒ 同款 fail-loud，不折叠到已记载平台候选表（linux 升记载后负例换 sunos 承载）
  const sunos = detectHostApp({}, 'sunos');
  assert.equal(sunos.present, false);
  assert.ok(sunos.reason.includes('无签名候选记载'), sunos.reason);
});

test('runInstall 收尾行：宿主未检出 → 不阻断＋如实改口数据面物化就绪', () => {
  const w = freshWorld();
  try {
    const lines = [];
    const r = withEnv('ZCODE_APP_ROOT', join(w.zhome.home, 'nowhere.app'), () =>
      runInstall({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home, out: (s) => lines.push(s) }));
    const out = lines.join('');
    assert.equal(r.code, 0, `未检出不阻断安装：${out}`);
    assert.match(out, /宿主应用：未检出/);
    assert.match(out, /数据面物化就绪——宿主未检出，非宿主装机生效/);
    assert.match(out, /ZCODE_APP_ROOT/); // 出路提示
  } finally {
    w.clean();
  }
});

test('runInstall 收尾行：宿主在位 → 常规完成句（不带改口措辞）', () => {
  const w = freshWorld();
  const appDir = join(tmpdir(), `zcode-host-present-${process.pid}.app`);
  mkdirSync(appDir, { recursive: true });
  try {
    const lines = [];
    const r = withEnv('ZCODE_APP_ROOT', appDir, () =>
      runInstall({ repoRoot: w.repo, marketRoot: w.market, zcodeHome: w.zhome.home, out: (s) => lines.push(s) }));
    const out = lines.join('');
    assert.equal(r.code, 0, out);
    assert.match(out, /宿主应用：在位/);
    assert.ok(!out.includes('数据面物化就绪'), `在位态不得带改口措辞：${out}`);
    assert.match(out, /六插件 @ .* 装机、写后即验全绿（F7 注册面不计入、由尾印承载）/);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
    w.clean();
  }
});
