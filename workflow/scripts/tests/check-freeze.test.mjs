// 文件：check-freeze.test.mjs
// 描述：编辑冻结护栏钩（check-freeze.mjs，内部未决-14 批次自 check-freeze.sh 等价移植）
//       行为测试——极性双断言（负载不可读→deny / 解析后自身异常→exit 0）、字符串级
//       路径归一与声明根上溯、glob 匹配（跨 / 通配与目录前缀）、selftest.sh:111-124
//       原 14 条用例一一迁移、双跑对拍（前置：bash 可用且旧 .sh 尚存；清场后自动 skip）。
// 作者：wangp  创建：2026-09-15  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；fixture 全部临时生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const HOOK = join(HOOKS, 'check-freeze.mjs');
const OLD_SH = join(HOOKS, 'check-freeze.sh');

// 内部任务-320（测试缝状态根隔离）：崩溃注入的观测面写入本文件专属的临时状态根，
// 不再污染项目真实状态根（<仓根>/内部工作流状态）——
// 此前 env 未注 WF_ROUTING_STATE_DIR，注入崩溃按 cwd 落进真实状态根并被他宿主误归因。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'wf-fz-state-'));
process.on('exit', () => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

/**
 * 子进程驱动被测钩：喂 stdin 负载，回退出码与 stdout。
 * @param {string} payload
 * @param {{injectCrash?: boolean}} [o]
 * @returns {{status: number|null, stdout: string}}
 */
function runFreeze(payload, o = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, WF_ROUTING_STATE_DIR: STATE_DIR, ...(o.injectCrash ? { GUARD_HOOK_INJECT_CRASH: '1' } : {}) },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** 构造 Edit/Write 负载 JSON。 */
const payF = (fp, cwd) => JSON.stringify({ tool_input: { file_path: fp }, cwd });

/**
 * 建 freeze 夹具根（selftest.sh:76-84 同构）：返回临时项目根与清理函数。
 * @param {string[]} declLines 声明行（空数组=不建声明文件）
 * @returns {{root: string, cleanup: () => void}}
 */
function makeRoot(declLines) {
  const root = mkdtempSync(join(tmpdir(), 'wf-fz-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'sub'), { recursive: true });
  if (declLines.length > 0) writeFileSync(join(root, '.workflow-freeze'), `${declLines.join('\n')}\n`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('冻结路径内 Edit → deny(2)，消息含解冻指引与信封契约', () => {
  const { root, cleanup } = makeRoot(['# 冻结声明样例：每行一个 glob，相对项目根', '', 'docs/*']);
  try {
    const r = runFreeze(payF(`${root}/docs/spec.md`, root));
    assert.equal(r.status, 2, '命中冻结必须 exit 2');
    const env = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(env.hookEventName, 'PreToolUse', '信封事件名');
    assert.equal(env.permissionDecision, 'deny', '信封决策');
    assert.ok(r.stdout.includes('deny'), 'deny 关键字（原用例对整输出匹配）');
    assert.ok(env.systemMessage.includes('解冻'), '解冻指引');
    assert.ok(env.systemMessage.includes('docs/*'), '命中声明行可见');
  } finally {
    cleanup();
  }
});

test('界外/无声明/仅注释/非 Edit|Write 负载 → 放行零输出', () => {
  const r1 = makeRoot(['docs/*']);
  const r2 = makeRoot([]);
  const r5 = makeRoot(['# 全是注释行', '# docs/*']);
  try {
    for (const [payload, label] of [
      [payF(`${r1.root}/src/a.ts`, r1.root), '冻结路径外'],
      [payF(`${r2.root}/notes.md`, r2.root), '无声明文件'],
      [payF(`${r5.root}/docs/a.md`, r5.root), '仅注释声明'],
      ['{"tool_name":"Bash","tool_input":{"command":"ls"}}', '非 Edit/Write 负载'],
    ]) {
      const r = runFreeze(payload);
      assert.equal(r.status, 0, `${label}：exit 0`);
      assert.equal(r.stdout.trim(), '', `${label}：零输出`);
    }
  } finally {
    r1.cleanup(); r2.cleanup(); r5.cleanup();
  }
});

test('极性双断言：负载垃圾 → deny(2)（fail-closed）；解析后自身异常 → exit 0（fail-open）', () => {
  const bad = runFreeze('{{{ not-json');
  assert.equal(bad.status, 2, '负载不可读必须 DENY（极性裁决，先于一切）');
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny', 'deny 信封');
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    const crash = runFreeze(payF(`${root}/docs/x.md`, root), { injectCrash: true });
    assert.equal(crash.status, 0, '解析成功后的自身异常被陷阱改写为 0');
    assert.equal(crash.stdout.trim(), '', '异常路径零输出');
  } finally {
    cleanup();
  }
});

test('内部任务-320 状态根隔离：崩溃注入的观测记录落在注入的临时状态根（不污染项目真实状态根）', () => {
  const errors = join(STATE_DIR, 'hook-errors.jsonl');
  const before = existsSync(errors) ? readFileSync(errors, 'utf8').split('\n').filter(Boolean).length : 0;
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    const crash = runFreeze(payF(`${root}/docs/x.md`, root), { injectCrash: true });
    assert.equal(crash.status, 0, '注入崩溃须 fail-open（exit 0）');
  } finally {
    cleanup();
  }
  assert.ok(existsSync(errors), '注入根内应产出 hook-errors.jsonl');
  const lines = readFileSync(errors, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > before, '注入后应新增至少一条崩溃记录');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.script, 'check-freeze', '归因字段 script');
  assert.equal(rec.reason, 'uncaught-in-main', '归因字段 reason');
});

test('glob 语义：无通配目录前缀（子树）与通配后缀 *.pem → deny', () => {
  const r3 = makeRoot(['secrets']);
  const r4 = makeRoot(['*.pem']);
  try {
    for (const [payload, root] of [[payF(`${r3.root}/secrets/key.pem`, r3.root), r3.root], [payF(`${r4.root}/creds/token.pem`, r4.root), r4.root]]) {
      const r = runFreeze(payload);
      assert.equal(r.status, 2, `命中 ${root} 声明`);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  } finally {
    r3.cleanup(); r4.cleanup();
  }
});

test('从子目录向上找到声明根（cwd 在项目子目录）', () => {
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    const r = runFreeze(payF(`${root}/docs/deep/x.md`, `${root}/sub`));
    assert.equal(r.status, 2, 'cwd 在子目录也要命中根声明');
  } finally {
    cleanup();
  }
});

test('Windows 路径形态：反斜杠 file_path 与小写盘符 cwd 等价命中', { skip: process.platform !== 'win32' ? '非 Windows 平台无盘符/反斜杠路径语义（条件用例跳过；内部任务-259 步骤10 归因）' : false }, () => {
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    const forward = String.raw`${root}`.replaceAll('/', '\\');
    const lowerCwd = root.length > 2 ? root[0].toLowerCase() + root.slice(1) : root; // 仅盘符小写化
    const r = runFreeze(payF(`${forward}\\docs\\a.md`, lowerCwd));
    assert.equal(r.status, 2, '反斜杠/小写盘符形态归一后仍命中');
  } finally {
    cleanup();
  }
});

test('嵌套声明取内层（越靠近起点越优先）', async () => {
  const { findDeclarationRoot } = await import('../../hooks/check-freeze.mjs');
  const outer = mkdtempSync(join(tmpdir(), 'wf-fz-nest-'));
  const inner = join(outer, 'inner');
  try {
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, '.workflow-freeze'), 'outer-declared\n');
    writeFileSync(join(inner, '.workflow-freeze'), 'inner-declared\n');
    assert.equal(findDeclarationRoot(join(inner, 'sub')), inner.replace(/\\/g, '/'), '起点近者优先（内层）');
    assert.equal(findDeclarationRoot(join(outer, 'other')), outer.replace(/\\/g, '/'), '无内层声明取外层');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('纯函数直测：normPathRaw/relToRoot/caseGlobTest 边界', async () => {
  const { normPathRaw, relToRoot, caseGlobTest } = await import('../../hooks/check-freeze.mjs');
  // normPathRaw：反斜杠→斜杠、盘符小写→大写、循环去尾斜杠（保留单字符根）
  assert.equal(normPathRaw('d:/x\\y\\'), 'D:/x/y');
  assert.equal(normPathRaw('D:/a/'), 'D:/a');
  assert.equal(normPathRaw('D:/a//'), 'D:/a');
  assert.equal(normPathRaw('/'), '/');
  assert.equal(normPathRaw('rel/path/'), 'rel/path');
  // relToRoot：等值→'.'；前缀剥除；不在根下→''（放行语义）
  assert.equal(relToRoot('D:/p/docs/a.md', 'd:/p'), 'docs/a.md');
  assert.equal(relToRoot('D:/p', 'D:/p'), '.');
  assert.equal(relToRoot('E:/q/a.md', 'D:/p'), '');
  // caseGlobTest：* 跨目录分隔符；? 单字符；纯字面=自身或子树前缀；声明行尾斜杠剥除
  assert.ok(caseGlobTest('docs/deep/a.md', 'docs/*'));
  assert.ok(caseGlobTest('a/b/c.pem', '*.pem'));
  assert.ok(caseGlobTest('secrets', 'secrets/'));
  assert.ok(caseGlobTest('secrets/deep/k', 'secrets'));
  assert.ok(!caseGlobTest('docsx/a.md', 'docs'));
  assert.ok(caseGlobTest('aXc', 'a?c'));
  assert.ok(!caseGlobTest('abbc', 'a?c'), '? 只匹配单个字符');
  // 评审加固（2026-09-15 收尾 code-review C3/S1）：病态字符类不中断、] 起始类为字面成员
  assert.ok(!caseGlobTest('docsx/a', 'docs[z-a]*'), '无效区间类按不匹配跳过（不抛错）');
  assert.ok(caseGlobTest('docs]x/a.md', 'docs[]x]*'), '] 紧随 [ 为字面成员（POSIX 语义）');
  const bad = makeRoot(['bad[ze-a]*', 'docs/*']);
  try {
    const r = runFreeze(payF(`${bad.root}/docs/a.md`, bad.root));
    assert.equal(r.status, 2, '病态行被跳过后，后续声明行仍命中 deny（不中断循环）');
  } finally {
    bad.cleanup();
  }
});

test('入口：--selftest 退 0 且含 OK；--help 退 0 且含用法', () => {
  const st = spawnSync(process.execPath, [HOOK, '--selftest'], { encoding: 'utf8' });
  assert.equal(st.status, 0, 'selftest 退 0');
  assert.ok(st.stdout.includes('OK'), '输出 OK');
  const help = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, 'help 退 0');
  assert.ok(help.stdout.includes('用法'), '含用法说明');
});

test('双跑对拍：与旧 check-freeze.sh 退出码与 stdout 逐字节一致（清场后 skip）', (t) => {
  // 已知有意偏差（收尾 code-review S3）：旧版 _json_scrub 删消息内引号/反斜杠（输出
  // 破损 JSON 是旧缺陷）；Node 版 JSON.stringify 合法转义。本对拍 payload 集不含引号
  // 路径（tmpdir 路径无引号），动态部分经 normPathRaw 已为正斜杠，字节一致成立。
  const bashProbe = spawnSync('bash', ['-c', 'echo bash-ok'], { encoding: 'utf8' });
  if (!(bashProbe.status === 0 && existsSync(OLD_SH))) {
    // 内部任务-244 T03：旧 .sh 已随 0.2.5 Node 移植批删除 → 前置恒假；显式 skip（裸 return 会以
    // pass 计入汇总并制造"锁定等价性"假象——与 entry-guard 消灭的假绿同构）。
    t.skip('旧 check-freeze.sh 已删（0.2.5 Node 移植批）或 bash 不可用——等价性由 golden/既有用例承担');
    return;
  }
  const runOld = (payload) => {
    const r = spawnSync('bash', [OLD_SH], { input: payload, encoding: 'utf8' });
    return { status: r.status, stdout: (r.stdout ?? '').trim() };
  };
  const runNew = (payload) => {
    const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
    return { status: r.status, stdout: (r.stdout ?? '').trim() };
  };
  const r1 = makeRoot(['# 声明', '', 'docs/*']);
  const r3 = makeRoot(['secrets']);
  const r5 = makeRoot(['# 全是注释行', '# docs/*']);
  try {
    const payloads = [
      payF(`${r1.root}/docs/spec.md`, r1.root),
      payF(`${r1.root}/src/a.ts`, r1.root),
      payF(`${r1.root}/docs/deep/x.md`, `${r1.root}/sub`),
      payF(`${r3.root}/secrets/key.pem`, r3.root),
      payF(`${r5.root}/docs/a.md`, r5.root),
      '{{{ not-json',
      '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
      JSON.stringify({ tool_input: { file_path: `${r1.root}\\docs\\a.md` }, cwd: r1.root }),
    ];
    for (const p of payloads) {
      const a = runOld(p);
      const b = runNew(p);
      assert.equal(b.status, a.status, `退出码一致（payload=${p.slice(0, 40)}…）`);
      assert.equal(b.stdout, a.stdout, `stdout 逐字节一致（payload=${p.slice(0, 40)}…）`);
    }
  } finally {
    r1.cleanup(); r3.cleanup(); r5.cleanup();
  }
});

// ── 内部任务-8（2026-10-07，内部规则-17）：钩内工具族分流——已命名的非 edit 族负载静默放行 ──

test('内部任务-8 任务 2.2：非 edit 族负载静默放行（漂移防护：shell/只读族带 file_path 不得误拦）', () => {
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    const frozen = `${root}/docs/spec.md`;
    // 漂移防护：shell 族负载携带 file_path 指向冻结目录 → 静默放行（现状无工具名分流 → 误拦）
    const shell = runFreeze(JSON.stringify({ tool_name: 'pwsh', tool_input: { file_path: frozen }, cwd: root }));
    assert.equal(shell.status, 0, 'shell 族静默放行');
    assert.equal(shell.stdout.trim(), '', '零输出（内部规则-6 信封契约）');
    assert.equal(
      runFreeze(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: frozen }, cwd: root })).status,
      0,
      'other 族静默放行',
    );
    // edit 族既有判定不变（大小写归一：ZCode 的 Edit 与 DSH 的 edit 同族）
    const upper = runFreeze(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: frozen }, cwd: root }));
    assert.equal(upper.status, 2, 'ZCode 形态 Edit 命中冻结仍 deny');
    assert.equal(runFreeze(JSON.stringify({ tool_name: 'write', tool_input: { file_path: frozen }, cwd: root })).status, 2, 'DSH 形态 write 同判');
    // legacy 形态（负载无工具名）保持现状判定：file_path 面照常判定（既有用例零红的前提）
    assert.equal(runFreeze(payF(frozen, root)).status, 2, '无工具名负载按现状判定');
  } finally {
    cleanup();
  }
});

// ── 内部任务-244 S02：冻结判定规范化——`..` 消解 / symlink 别名 / Windows 大小写 / 相对路径不可绕过 ──

test('冻结判定规范化（内部任务-244 S02）：..、symlink、Windows 大小写、相对路径均不能绕过', (t) => {
  const { root, cleanup } = makeRoot(['docs/*']);
  try {
    // `..` 级联：字符串形态不在 docs/ 下，但解析后就在冻结目录内
    assert.equal(runFreeze(payF('src/../docs/spec.md', root)).status, 2, '级联 .. 目标须命中冻结');
    // 相对 file_path：按负载 cwd 解析后命中
    assert.equal(runFreeze(payF('docs/spec.md', root)).status, 2, '相对路径目标须命中冻结');
    // Windows 大小写不敏感 FS：Docs 实际解析到 docs
    if (process.platform === 'win32') {
      assert.equal(runFreeze(payF(`${root}/Docs/spec.md`, root)).status, 2, 'Windows 大小写变体须命中冻结');
    }
    // symlink / junction 别名指向冻结目录
    const linkPath = join(root, 'docs-alias');
    let linked = true;
    try {
      symlinkSync(join(root, 'docs'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip('当前环境不支持 symlink/junction（不判红，登记跳过）');
      return;
    }
    assert.equal(runFreeze(payF(`${linkPath}/spec.md`, root)).status, 2, 'symlink 别名目标须命中冻结');
    // 最终安全评审 B2：symlink 后再 `..` 必须按 OS 语义（落到 docs/）判冻结，而非词法消解回仓根
    mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
    const alias2 = join(root, 'sub-alias');
    let linked2 = true;
    try {
      symlinkSync(join(root, 'docs', 'sub'), alias2, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked2 = false;
    }
    if (linked2) {
      assert.equal(runFreeze(payF(`${alias2}/../spec.md`, root)).status, 2, 'symlink+.. 组合不可绕过冻结（OS 语义）');
      // symlinked cwd 上溯：真实目录上的声明文件须被发现
      assert.equal(runFreeze(payF(`${root}/docs/spec.md`, alias2)).status, 2, 'symlinked cwd 上溯须发现声明');
    }
    // 回归：界外目标仍放行零输出
    const outside = runFreeze(payF(`${root}/src/a.ts`, root));
    assert.equal(outside.status, 0, '界外目标放行');
    assert.equal(outside.stdout.trim(), '', '界外放行零输出');
  } finally {
    cleanup();
  }
});
