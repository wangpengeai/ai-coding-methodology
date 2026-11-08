// 文件：cross-domain.test.mjs
// 描述：内部任务-20 A2/F6 端到端——**跨域声明两步通道**（请求 → 签发 → 声明）在两仓真实拓扑下走通，
//       并对「声明成功但闸仍拒」的混根失效面给出**证伪点**：第三跳声明成功后，对目标仓文件的
//       写操作必须被闸放行（闸按文件归属键读租约，而声明按键写租约——两者必须同根）。
//       夹具要点：**不设 WF_ROUTING_STATE_DIR**（注入缝优先级最高会短路项目记号，使 config 路径
//       零覆盖、混根负例不可复现）；改以 USERPROFILE/HOME 重定向隔离用户级默认根：A 走
//       `--init-state-dir` 得到项目内根，B 保持用户级默认根 ⇒ 天然异根（逐键解析的真实形态）。
// 作者：wangp  创建：2026-10-08  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；夹具全部临时生成；子进程 spawnSync input 喂负载（禁 shell 管道）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = resolve(HERE, '..', '..', 'hooks');
const DECLARE = join(HOOKS, 'routing-declare.mjs');
const GATE = join(HOOKS, 'routing-gate.mjs');
const UPROMPT = join(HOOKS, 'user-prompt.mjs');

/**
 * 跑一个钩子/CLI 子进程（输入经 stdin 喂，禁 shell 管道）。
 * @param {string} script 目标脚本绝对路径
 * @param {string[]} args 参数
 * @param {{cwd?: string, env: Record<string,string>, input?: string}} o 运行面
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function sh(script, args, o) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: o.cwd, env: o.env, input: o.input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('DEV-20 A2/F6 端到端：请求 → 签发 → 声明成功，且目标仓写操作被闸放行', () => {
  const base = mkdtempSync(join(tmpdir(), 'xdomain-'));
  const home = join(base, 'home');
  const a = join(base, 'A');
  const b = join(base, 'B');
  for (const d of [home, join(a, '.git'), join(b, '.git')]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZCODE_PLUGIN_ROOT: resolve(HOOKS, '..') };
  delete env.WF_ROUTING_STATE_DIR;
  delete env.ZCODE_PROJECT_DIR; // 内部任务-331：剥宿主锚（routing-lib.mjs:334 工作区锚）——A/B 夹具拓扑不得被宿主会话穿透
  try {
    // A 显式 opt-in 到项目内状态根（真实 config 路径）；B 保持用户级默认根 ⇒ 异根
    const init = sh(DECLARE, ['--init-state-dir', '--project-root', a], { cwd: a, env });
    assert.equal(init.status, 0, `A 初始化须退 0：${init.stderr}`);

    // 第一跳前置：A 先经签发面取得本会话令牌并完成一次正常声明
    const up1 = sh(UPROMPT, [], { cwd: a, env, input: JSON.stringify({ session_id: 'sess-x', cwd: a, prompt: '任务' }) });
    const tokenA = /--lease ([0-9a-f]{32})/.exec(up1.stdout)?.[1];
    assert.ok(tokenA, `首轮须注入 A 的租约行；实际：${up1.stdout.slice(0, 200)}`);
    const decA = sh(DECLARE, ['code-review', '--lease', tokenA, '--task-id', 'DEV-20'], { cwd: a, env });
    assert.equal(decA.status, 0, `A 声明须成功：${decA.stdout}${decA.stderr}`);

    // 第一跳：登记跨域请求（不含令牌、不激活租约）
    const req = sh(DECLARE, ['--request-domain', b, '--lease', tokenA, '--project-root', a], { cwd: a, env });
    assert.equal(req.status, 0, `请求须登记成功：${req.stdout}${req.stderr}`);

    // 第二跳：下一轮 UPS 把 B 的目标域租约行注入（多仓多行）
    const up2 = sh(UPROMPT, [], { cwd: a, env, input: JSON.stringify({ session_id: 'sess-x', cwd: a, prompt: '任务' }) });
    // 注意：注入文本经 **JSON 信封**回传，`\n` 在 stdout 里是转义形态 ⇒ 必须先解信封再按行切，
    // 否则"按行取令牌"会取到第一行（A）的令牌（本用例首版即因此误判为并入未生效）。
    const ctx2 = JSON.parse(up2.stdout).hookSpecificOutput.additionalContext;
    const bSlash = b.replaceAll('\\', '/');
    const bLine = ctx2.split('\n').find((l) => l.includes(bSlash));
    assert.ok(bLine, `须注入 B 的目标域租约行；实际：${ctx2.slice(0, 400)}`);
    const tokenB = /--lease ([0-9a-f]{32})/.exec(bLine)[1];

    // 第三跳：按注入行声明 B 的键（**声明侧零改动**）
    const decB = sh(DECLARE, ['code-review', '--lease', tokenB, '--task-id', 'DEV-20', '--project-root', b], { cwd: a, env });
    assert.equal(decB.status, 0, `B 声明须成功（声明侧零改动）：${decB.stdout}${decB.stderr}`);

    // 闸面断言（本用例的证伪点）：声明成功后，对 **B 仓文件**的写操作必须放行
    const gate = sh(GATE, [], {
      cwd: b,
      env,
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(b, 'x.ts') }, cwd: b, session_id: 'sess-x' }),
    });
    assert.notEqual(gate.status, 2, `闸须放行 B 仓写操作（混根即在此转红）；实际：${gate.stdout.slice(0, 300)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
