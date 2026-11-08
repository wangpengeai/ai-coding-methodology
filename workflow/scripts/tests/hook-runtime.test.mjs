// 文件：hook-runtime.test.mjs
// 描述：运行态基础设施行为测试（2026-09-13 加固批次 A4/B1①）——runtimeStateDir
//       优先级（WF_ROUTING_STATE_DIR 注入 > ~/.zcode/cli/routing-state 缺省 > tmpdir
//       兜底）、installHookErrorTrap 捕获同步抛错落 hook-errors.jsonl 后以 exit 0 收场。
//       2026-09-15 内部未决-14 批次：preToolUseEnvelope/emitPreToolUseDecision（护栏钩
//       共用信封助手，消灭 bash 版 _emit 双拷贝的 Node 对应物）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；fixture 全部临时生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const LIB = join(HOOKS, 'hook-lib.mjs');

test('runtimeStateDir 优先级：注入缝 > ~/.zcode/cli/routing-state > tmpdir 兜底', async () => {
  // 相对说明符按本模块 URL 解析，跨平台一致（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  const { runtimeStateDir } = await import('../../hooks/routing-lib.mjs');
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-home-'));
  // 环境隔离（内部任务-274 发布验证发现）：本用例断言「无项目记号时的 home 默认根」，但
  // `runtimeStateDir()` 以 process.cwd() 为键解析项目记号；在**本身已 `--init-state-dir` 的仓库根**
  // 跑套件时，仓内 `内部工作流状态`（gitignored 机器态）会把结果改成项目内状态根 → 假红。
  // 故切到无任何标记的临时 cwd 再测（finally 恢复）。
  const prevCwd = process.cwd();
  const sandboxCwd = mkdtempSync(join(tmpdir(), 'wf-rt-cwd-'));
  const prev = {
    dir: process.env.WF_ROUTING_STATE_DIR,
    home: process.env.HOME,
    up: process.env.USERPROFILE,
  };
  try {
    process.chdir(sandboxCwd);
    delete process.env.WF_ROUTING_STATE_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(runtimeStateDir(), join(home, '.zcode', 'cli', 'routing-state'), '缺省落 home 下 routing-state');
    const injected = join(home, 'injected');
    process.env.WF_ROUTING_STATE_DIR = injected;
    assert.equal(runtimeStateDir(), injected, '注入缝优先');
    delete process.env.WF_ROUTING_STATE_DIR;
    // home 不可写兜底：把 home 设为「文件之下」的路径（mkdir 递归必失败，root 也拦得住）
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.HOME = join(blocker, 'sub');
    process.env.USERPROFILE = process.env.HOME;
    assert.equal(runtimeStateDir(), tmpdir(), 'home 不可写时兜底 tmpdir（fail-open）');
  } finally {
    if (prev.dir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev.dir;
    if (prev.home === undefined) delete process.env.HOME;
    else process.env.HOME = prev.home;
    if (prev.up === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prev.up;
    rmSync(home, { recursive: true, force: true });
    process.chdir(prevCwd);
    rmSync(sandboxCwd, { recursive: true, force: true });
  }
});

test('installHookErrorTrap：同步抛错落 hook-errors.jsonl 且进程 exit 0（fail-open）', async () => {
  const { installHookErrorTrap } = await import('../../hooks/hook-lib.mjs');
  assert.equal(typeof installHookErrorTrap, 'function', 'helper 必须导出');
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-trap-'));
  const state = join(home, 'state');
  const script = join(home, 'crash.mjs');
  try {
    writeFileSync(
      script,
      [
        // 子脚本内容里只能给 URL 字符串（绝对路径直传在 Windows 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
        `import { installHookErrorTrap } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `process.env.WF_ROUTING_STATE_DIR = ${JSON.stringify(state)};`,
        `installHookErrorTrap('crash-test');`,
        `throw new Error('boom-for-test');`,
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 0, '陷阱须以 exit 0 收场（fail-open 姿态不破）');
    const log = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(log), '崩溃日志必须落盘');
    const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.equal(line.script, 'crash-test', '日志含脚本标识');
    assert.ok(String(line.error).includes('boom-for-test'), '日志含错误信息');
    assert.ok(Number.isFinite(line.ts), '日志含时间戳');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('preToolUseEnvelope：deny/ask 两形态信封字段全等，特殊字符仍为合法 JSON', async () => {
  const { preToolUseEnvelope } = await import('../../hooks/hook-lib.mjs');
  assert.equal(typeof preToolUseEnvelope, 'function', 'helper 必须导出');
  for (const decision of ['deny', 'ask']) {
    const env = JSON.parse(preToolUseEnvelope(decision, '简单文案'));
    assert.equal(env.hookSpecificOutput.hookEventName, 'PreToolUse', '事件名固定 PreToolUse');
    assert.equal(env.hookSpecificOutput.permissionDecision, decision, 'decision 透传');
    assert.equal(env.hookSpecificOutput.systemMessage, '简单文案', '消息透传');
  }
  const nasty = '路径 C:\\Users\\x 与 "引号" 与\n换行';
  const env = JSON.parse(preToolUseEnvelope('deny', nasty));
  assert.equal(env.hookSpecificOutput.systemMessage, nasty, '含引号/反斜杠/换行的消息经 JSON.parse 回读逐字全等');
});

test('emitPreToolUseDecision：deny 退 2、ask 退 0，stdout 为可解析信封', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-emit-'));
  const script = join(home, 'emit.mjs');
  try {
    writeFileSync(
      script,
      [
        `import { emitPreToolUseDecision } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `emitPreToolUseDecision(process.argv[2], process.argv[3]);`,
      ].join('\n'),
    );
    const deny = spawnSync(process.execPath, [script, 'deny', '已阻断：测试'], { encoding: 'utf8' });
    assert.equal(deny.status, 2, 'deny 必须 exit 2（宿主拦截语义）');
    assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny', 'stdout 为 deny 信封');
    const ask = spawnSync(process.execPath, [script, 'ask', '请确认：测试'], { encoding: 'utf8' });
    assert.equal(ask.status, 0, 'ask 必须 exit 0（宿主弹窗语义）');
    assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask', 'stdout 为 ask 信封');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pluginRootDir：指向含 hooks/scripts 的插件根（内部任务-20 A1/F5）', async () => {
  // 为什么要有：注入文本要给出**可直接执行**的绝对路径（消费仓里仓相对命令必 MODULE_NOT_FOUND），
  // 推导根必须就是运行中的插件版本目录——用"根下确有这两个文件"钉住形态，而不是只比字符串。
  const { pluginRootDir } = await import('../../hooks/hook-lib.mjs');
  const root = pluginRootDir();
  assert.ok(typeof root === 'string' && isAbsolute(root), '必须是绝对路径（注入文本要可直接复制执行）');
  assert.ok(existsSync(join(root, 'hooks', 'hook-lib.mjs')), '推导根须含 hooks/hook-lib.mjs');
  assert.ok(existsSync(join(root, 'scripts', 'incident-cli.mjs')), '推导根须含 scripts/incident-cli.mjs');
});

test('pluginRootDir：自身位置优先于环境变量（内部任务-20 A1/F5）', async () => {
  const { pluginRootDir } = await import('../../hooks/hook-lib.mjs');
  const prev = process.env.ZCODE_PLUGIN_ROOT;
  process.env.ZCODE_PLUGIN_ROOT = 'C:/nonexistent-plugin-root';
  try {
    assert.equal(pluginRootDir(), realpathSync(resolve(HOOKS, '..')), 'env 指错不得改变结果（运行中的插件版本目录才是权威）');
  } finally {
    if (prev === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = prev;
  }
});

test('pluginRootDir marker 参数：声明命令 marker 与默认 marker 同根（内部未决-91，内部任务-48）', async () => {
  const { pluginRootDir } = await import('../../hooks/hook-lib.mjs');
  assert.equal(pluginRootDir('hooks/routing-declare.mjs'), pluginRootDir(), '健康插件树上两 marker 指向同一根');
});

test('declareCmdPrefix（hook-lib 导出）：env 双清空 → 真路径非占位符（内部未决-91，内部任务-48）', async () => {
  const { declareCmdPrefix } = await import('../../hooks/hook-lib.mjs');
  const prevZ = process.env.ZCODE_PLUGIN_ROOT;
  const prevC = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.ZCODE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    const cmd = declareCmdPrefix();
    assert.ok(cmd.startsWith("node '"), '单引号包裹形态（内部未决-94：bash/pwsh 双壳内单引号零展开）');
    assert.ok(cmd.endsWith("/hooks/routing-declare.mjs'"), '正斜杠绝对路径形态');
    assert.ok(!cmd.includes('<插件根>'), '自身位置有效时不得退占位符（收敛前的 env-only 缺陷形态）');
  } finally {
    if (prevZ === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = prevZ;
    if (prevC === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prevC;
  }
});

test('占位符回落：裁剪树（marker 文件俱缺）→ null 根 → 占位符命令（内部未决-91，内部任务-48）', async () => {
  // 只拷 hook-lib 与其唯一仓内依赖 routing-lib 到 tmp——树里没有 scripts/incident-cli.mjs
  // 也没有 hooks/routing-declare.mjs，两级候选全部失败 ⇒ null 根 ⇒ 两个命令都退占位符
  // （不产"看似可执行却是错根"的命令，内部任务-20 A1/F5 的回落语义在收敛后保持）。
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-stripped-'));
  try {
    mkdirSync(join(home, 'hooks'), { recursive: true });
    copyFileSync(join(HOOKS, 'hook-lib.mjs'), join(home, 'hooks', 'hook-lib.mjs'));
    copyFileSync(join(HOOKS, 'routing-lib.mjs'), join(home, 'hooks', 'routing-lib.mjs'));
    // 内部任务-290：hook-lib 自本批起静态 import scripts/lib/host-detect.mjs（零依赖纯模块），裁剪树须三件
    mkdirSync(join(home, 'scripts', 'lib'), { recursive: true });
    copyFileSync(join(HOOKS, '..', 'scripts', 'lib', 'host-detect.mjs'), join(home, 'scripts', 'lib', 'host-detect.mjs'));
    const prevZ = process.env.ZCODE_PLUGIN_ROOT;
    const prevC = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.ZCODE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const mod = await import(pathToFileURL(join(home, 'hooks', 'hook-lib.mjs')).href);
      assert.equal(mod.pluginRootDir(), null, '裁剪树：默认 marker 不在 ⇒ null（不回落 cwd）');
      assert.equal(mod.declareCmdPrefix(), "node '<插件根>/hooks/routing-declare.mjs'", '声明命令退占位符');
      assert.equal(mod.incidentCliCommand(), "node '<插件根>/scripts/incident-cli.mjs'", '自察命令退占位符');
    } finally {
      if (prevZ === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
      else process.env.ZCODE_PLUGIN_ROOT = prevZ;
      if (prevC === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = prevC;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runtimeStateDir 与单点原语一致（内部任务-20 A2/F7）', async () => {
  // 收敛判据：运行态状态目录只允许经单点原语解析（注入缝 > 项目记号 > 用户级默认），
  // 存在第二套拼路径即本断言转红——「无 cwd 参与的第二解析链」是 A2 的核心不变量之一。
  const { runtimeStateDir, stateRootFor } = await import('../../hooks/routing-lib.mjs');
  assert.equal(runtimeStateDir(), stateRootFor(process.cwd()), '运行态状态目录＝单点原语对 cwd 键的解析结果');
});

// ── 内部任务-290：runHookMain 记录 error/host/sessionKey（内部未决-258/260）与脱敏 ──

test('内部任务-290：runHookMain 记录 error、host 与 sessionKey，且 error 经路径脱敏', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-dev290-'));
  const state = join(home, 'state');
  const script = join(home, 'main-crash2.mjs');
  try {
    writeFileSync(
      script,
      [
        `import { runHookMain, bindHookContext } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `process.env.WF_ROUTING_STATE_DIR = ${JSON.stringify(state)};`,
        `bindHookContext({ sessionKey: 'sess-dev290' });`,
        `runHookMain('dev290-test', async () => { throw new Error('boom at C:\\\\tmp\\\\x.mjs and/or y'); });`,
      ].join('\n'),
    );
    // 内部未决-282 同族（内部任务-308）：宿主任一会话自带 DSH_/KIMI_ 前缀时会抢占 hostOf 优先级，
    // 断言须在隔离 env 上验 mcode 分支（本机 DSH 会话下否则恒红）。
    const env = { ...process.env, MCODE_HOOK_EVENT: 'PreToolUse' };
    for (const k of Object.keys(env)) if (k.startsWith('DSH_') || k.startsWith('KIMI_')) delete env[k];
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    assert.equal(r.status, 0, 'fail-open 不破');
    const line = JSON.parse(readFileSync(join(state, 'hook-errors.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(line.reason, 'uncaught-in-main');
    assert.equal(line.sessionKey, 'sess-dev290', '绑定后须写入会话键（内部未决-260）');
    assert.equal(line.host, 'mcode', 'MCODE_ 前缀 ⇒ host=mcode（内部未决-260 归因）');
    assert.ok(typeof line.error === 'string' && line.error.length > 0, '须记录错误内容（内部未决-258）');
    assert.ok(!line.error.includes('C:\\tmp'), `盘符绝对路径须被脱敏，实际：${line.error}`);
    assert.ok(line.error.includes('boom'), '非路径信息应保留可读');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部任务-290：未绑定上下文时不写 sessionKey（旧行为兼容）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-dev290b-'));
  const state = join(home, 'state');
  const script = join(home, 'main-crash3.mjs');
  try {
    writeFileSync(
      script,
      [
        `import { runHookMain } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `process.env.WF_ROUTING_STATE_DIR = ${JSON.stringify(state)};`,
        `runHookMain('dev290-nobind', async () => { throw new Error('boom'); });`,
      ].join('\n'),
    );
    // 内部未决-282 同族（内部任务-308/内部任务-331）：四前缀皆无才可断言 unknown——hostOf 按前缀扫任意
    // 非空键（host-detect.mjs:38-40），故须清空全部 DSH_/KIMI_/MCODE_/ZCODE_ 前缀键（宿主会话自带整族）。
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(DSH_|KIMI_|MCODE_|ZCODE_)/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    assert.equal(r.status, 0);
    const line = JSON.parse(readFileSync(join(state, 'hook-errors.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(line.sessionKey, undefined, '未绑定时不写该字段');
    assert.equal(line.host, 'unknown', '四前缀皆无 ⇒ unknown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 内部任务-244 E02：main rejection 可见化（runHookMain）与九钩入口收敛 ──

test('内部任务-244 E02：runHookMain 的 main rejection 落 hook-errors（uncaught-in-main）且 exit 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-main-'));
  const state = join(home, 'state');
  const script = join(home, 'main-crash.mjs');
  try {
    writeFileSync(
      script,
      [
        `import { runHookMain } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `process.env.WF_ROUTING_STATE_DIR = ${JSON.stringify(state)};`,
        `runHookMain('main-crash-test', async () => { throw new Error('boom-main'); });`,
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'main rejection 仍须以 exit 0 fail-open');
    const log = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(log), 'main rejection 必须可见（不得静默）');
    const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.equal(line.script, 'main-crash-test');
    assert.equal(line.reason, 'uncaught-in-main', '结构化原因类别名');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部任务-244 E02：十个钩入口统一经 runHookMain（不得保留静默 main().catch）', () => {
  const names = ['check-careful', 'check-freeze', 'verify-gate', 'task-recap', 'learnings-recap', 'post-tool', 'user-prompt', 'session-start', 'routing-gate', 'write-guard'];
  for (const name of names) {
    const src = readFileSync(join(HOOKS, `${name}.mjs`), 'utf8');
    assert.ok(src.includes(`runHookMain('${name}'`), `${name} 经 runHookMain 统一收口`);
    assert.ok(!src.includes('main().catch(() => process.exit(0))'), `${name} 不得保留静默 catch`);
  }
});

test('内部任务-244 T05：installHookErrorTrap 捕获 unhandledRejection（删掉注册即红）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-rt-rej-'));
  const state = join(home, 'state');
  const script = join(home, 'reject.mjs');
  try {
    writeFileSync(
      script,
      [
        `import { installHookErrorTrap } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
        `process.env.WF_ROUTING_STATE_DIR = ${JSON.stringify(state)};`,
        `installHookErrorTrap('rejection-test');`,
        `Promise.reject(new Error('boom-rejection'));`,
        `setTimeout(() => {}, 50);`, // 维持事件循环，让 unhandledRejection 触发
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'unhandledRejection 须以 exit 0 收场（fail-open）');
    const log = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(log), 'unhandledRejection 必须落盘（注册缺失时本断言红）');
    const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.equal(line.script, 'rejection-test');
    assert.ok(String(line.error).includes('boom-rejection'), '日志含 rejection 原因');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
