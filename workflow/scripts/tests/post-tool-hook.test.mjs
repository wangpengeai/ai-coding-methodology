// 文件：post-tool-hook.test.mjs
// 描述：自察捕获钩判据面单测（内部模块-15/内部决策-019，内部任务-OPEN46-1）——钉住"结构化事实唯一判据"：
//       ①字符串形态不再单独构成失败判据（判据缺陷期假阳性族：退 0 且正文含 error.js/
//       Traceback 回显/宿主退出标记）；②对象面 is_error/exit-nonzero/error-field/stderr；
//       ③digest 按 errorClass+退出变体+工具动作身份细分（内部任务-DIGESTDISC-1），且不得落原文（B-M15-1）；
//       ④返回面透出 errorClass/exitCode 供账本可读。
//       **命名空间导入**：RED 阶段 `commandFingerprint` 尚未导出——具名导入缺失导出是链接期
//       SyntaxError（整文件加载失败、行为断言全跑不到），命名空间导入把红收敛到具体用例。
// 作者：wangp  创建：2026-09-29  版权：MIT（见 workflow/LICENSE）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as postTool from '../../hooks/post-tool.mjs';
import { digestOf } from '../lib/incident-store.mjs';

/** 判据缺陷期（内部未决-46）账本实测的粗 digest 字面量——防回归判据，删掉即失去锚。 */
const LEGACY_COARSE = ['d7a83521cf4fdddf', '7d8dcda09367dc59'];

test('字符串形态不再单独构成失败判据（OPEN-46① 假阳性族）', () => {
  assert.equal(postTool.classifyResult('pwsh', 'error.js\ndone-listing'), null, '真实文件名行不得判失败');
  assert.equal(postTool.classifyResult('pwsh', 'ok\nTraceback (most recent call last)'), null, '回显他次正文不得判失败');
  assert.equal(postTool.classifyResult('edit', 'error-field'), null, '正文含 token 不得判失败');
  assert.equal(postTool.classifyResult('pwsh', '(no output)\n[exit code: 1]'), null, '宿主文本标记不进核心件');
  assert.equal(postTool.classifyResult('pwsh', 'all good'), null);
});

test('对象面结构化事实：is_error / exit_code / error / stderr（DSH + ZCode 两形态）', () => {
  assert.equal(postTool.classifyResult('edit', { is_error: true })?.errorClass, 'error-flag', 'DSH edit 失败形态');
  assert.equal(postTool.classifyResult('edit', { isError: true })?.errorClass, 'error-flag', '驼峰兼容');
  assert.equal(postTool.classifyResult('pwsh', { exit_code: 1 })?.errorClass, 'exit-nonzero');
  assert.equal(postTool.classifyResult('pwsh', { code: 3 })?.errorClass, 'exit-nonzero', 'ZCode code 字段');
  assert.equal(postTool.classifyResult('pwsh', { error: 'boom' })?.errorClass, 'error-field');
  assert.equal(postTool.classifyResult('pwsh', { error: 42, exit_code: 1 })?.errorClass, 'exit-nonzero', 'error 非字符串继续下判');
  assert.equal(postTool.classifyResult('pwsh', { exit_code: null, code: 1 })?.errorClass, 'exit-nonzero', 'exit_code 为 null 回落 code');
  assert.equal(postTool.classifyResult('pwsh', { exit_code: '', stderr: 'boom' })?.errorClass, 'stderr', '空串退出码不得强转 0 吞掉 stderr 分支（阶段复审 C2）');
  assert.equal(postTool.classifyResult('pwsh', { exit_code: false, stderr: 'boom' })?.errorClass, 'stderr', '布尔退出码同款不吃分支');
  assert.equal(postTool.classifyResult('pwsh', { stderr: 'oops' })?.errorClass, 'stderr');
  assert.equal(postTool.classifyResult('pwsh', { is_error: false, stdout: 'error.js' }), null, '显式成功不记');
  assert.equal(postTool.classifyResult('pwsh', { is_error: 'true', stderr: 'x' })?.errorClass, 'stderr', '非布尔 is_error 不认（真值判断会误记）');
  assert.equal(postTool.classifyResult('pwsh', { exit_code: 0, stdout: 'ok', stderr: 'Warning' }), null, '退 0 的 stderr 告警不记');
  assert.equal(postTool.classifyResult('pwsh', { stdout: 'x' }), null, '无结构化事实不记');
  assert.equal(postTool.classifyResult('pwsh', null), null);
  assert.equal(postTool.classifyResult('pwsh', 42), null, '非对象形态不记');
});

test('判序：error 字段 > is_error > 退出码（显式事实优先于推断）', () => {
  assert.equal(postTool.classifyResult('pwsh', { error: 'x', is_error: true, exit_code: 1 })?.errorClass, 'error-field');
  assert.equal(postTool.classifyResult('pwsh', { is_error: true, exit_code: 1 })?.errorClass, 'error-flag');
});

test('digest 细分：errorClass + 退出变体 + 命令指纹（OPEN-46③）', () => {
  const a = postTool.classifyResult('pwsh', { exit_code: 2 }, { command: 'git status' });
  const b = postTool.classifyResult('pwsh', { exit_code: 2 }, { command: 'git log' });
  const a2 = postTool.classifyResult('pwsh', { exit_code: 2 }, { command: 'git   status' });
  const c = postTool.classifyResult('pwsh', { exit_code: 1 }, { command: 'git status' });
  assert.ok(a && b && c);
  assert.notEqual(a.digest, b.digest, '不同命令必须可区分（判据缺陷期四例同 digest）');
  assert.equal(a.digest, a2.digest, '空白归一一视同仁（同命令同 digest）');
  assert.notEqual(a.digest, c.digest, '同命令不同退出码必须可区分');
  assert.ok(!LEGACY_COARSE.includes(a.digest), '不得等于判据缺陷期粗 digest');
  assert.match(a.digest, /^[0-9a-f]{16}$/);
  assert.ok(!a.digest.includes('git'), 'digest 不得含原文片段（B-M15-1）');
  assert.equal(a.exitCode, 2, '退出码透出（账本可读，视角二 #2）');
  assert.equal(postTool.classifyResult('edit', { is_error: true })?.exitCode, null, '非退出码类失败 exitCode 为 null');
  // digest 组成可复算锚：errorClass + 变体 + 指纹三段参与（用公开 digestOf 复算，锁死语义）
  assert.equal(a.digest, digestOf(['tool-failure', 'pwsh', 'exit-nonzero', '2', postTool.commandFingerprint({ command: 'git status' })]));

  // 内部任务-DIGESTDISC-1：同文件上的**异质** edit 失败必须异 digest（动作身份进指纹）
  const unread = postTool.classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'README.md:1', new_string: 'X' });
  const noop = postTool.classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'same', new_string: 'same' });
  const mismatch = postTool.classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'A', new_string: 'B' });
  assert.ok(unread && noop && mismatch);
  assert.match(unread.digest, /^[0-9a-f]{16}$/, '动作路径 digest 仍须是 16 位小写 hex（形态锚，收尾评审 C2）');
  assert.equal(new Set([unread.digest, noop.digest, mismatch.digest]).size, 3, '同文件三种不同编辑尝试必须三个不同 digest');
  assert.equal(
    postTool.classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: 'README.md:1', new_string: 'X' }).digest,
    unread.digest,
    '不变量钉子（非 RED 项）：同文件同替换对幂等',
  );
  // 判序消歧（plan-review 第 1 轮 #4）：动作定义字段**全部并入**，不依赖"edit/write 参数互斥"这一**未经证实**的宿主前提
  assert.notEqual(
    postTool.classifyResult('write', { is_error: true }, { file_path: '/p/a.md', old_string: 'A', new_string: 'B', content: 'one' }).digest,
    postTool.classifyResult('write', { is_error: true }, { file_path: '/p/a.md', old_string: 'A', new_string: 'B', content: 'two' }).digest,
    '同时带替换对与 content 时，content 也必须进 digest（不得被判序吞掉）',
  );
  // 写入类同理
  assert.notEqual(
    postTool.classifyResult('write', { is_error: true }, { file_path: '/p/a.md', content: 'one' }).digest,
    postTool.classifyResult('write', { is_error: true }, { file_path: '/p/a.md', content: 'two' }).digest,
    '同文件不同写入内容必须异 digest',
  );
  // 有意边界（plan-review 第 1 轮 #6）：空串/非字符串动作字段等价于"无该字段"（沿用既有 commandFingerprint 口径，非本批新债）
  assert.equal(
    postTool.classifyResult('edit', { is_error: true }, { file_path: '/p/a.md', old_string: '', new_string: '' }).digest,
    digestOf(['tool-failure', 'edit', 'error-flag', 'flag', postTool.commandFingerprint({ file_path: '/p/a.md' })]),
    '空替换对 ≡ 无动作字段（有意退化口径）',
  );
  // 零迁移面：无动作定义字段的工具与原口径逐字一致（**不变量钉子，非 RED 项**——旧实现本来就绿）
  assert.equal(
    postTool.classifyResult('bash', { exit_code: 1 }, { command: 'x' }).digest,
    digestOf(['tool-failure', 'bash', 'exit-nonzero', '1', postTool.commandFingerprint({ command: 'x' })]),
    'bash 类 digest 不得漂移',
  );
});

test('commandFingerprint：字段优先级、空白归一、缺省 nocmd、路径类字段、不可逆', () => {
  assert.equal(postTool.commandFingerprint({ command: 'git  status' }), postTool.commandFingerprint({ command: 'git status' }));
  assert.notEqual(postTool.commandFingerprint({ command: 'git status' }), postTool.commandFingerprint({ command: 'git log' }));
  assert.equal(postTool.commandFingerprint({ command: 'x', file_path: 'y' }), postTool.commandFingerprint({ command: 'x' }), 'command 优先');
  assert.equal(postTool.commandFingerprint({ file_path: 'a.txt', path: 'b.txt' }), postTool.commandFingerprint({ file_path: 'a.txt' }), 'file_path 优先于 path');
  assert.equal(postTool.commandFingerprint({ path: 'a.txt', filePath: 'b.txt' }), postTool.commandFingerprint({ path: 'a.txt' }), 'path 优先于 filePath');
  assert.equal(postTool.commandFingerprint({ file_path: 'a.txt' }), postTool.commandFingerprint({ filePath: 'a.txt' }), '路径类字段同值同款归一');
  assert.equal(postTool.commandFingerprint({ path: 'a.txt' }), postTool.commandFingerprint({ file_path: 'a.txt' }), 'path 与 file_path 同款');
  assert.equal(postTool.commandFingerprint({}), 'nocmd');
  assert.equal(postTool.commandFingerprint(undefined), 'nocmd');
  assert.equal(postTool.commandFingerprint('raw-string'), 'nocmd', '非对象入参回落 nocmd');
  assert.equal(postTool.commandFingerprint({ command: 'x'.repeat(500) }), postTool.commandFingerprint({ command: 'x'.repeat(400) }), '截断 300 字符');
  // 截断点边界（收尾评审 内部模块-6 变异不红的补钉）：第 300 字符处的差异被保留、第 301 起被截掉
  assert.notEqual(postTool.commandFingerprint({ command: 'x'.repeat(299) + 'A' }), postTool.commandFingerprint({ command: 'x'.repeat(299) + 'B' }), '300 字符内的差异必须可区分');
  assert.equal(postTool.commandFingerprint({ command: 'x'.repeat(300) + 'A' }), postTool.commandFingerprint({ command: 'x'.repeat(300) + 'B' }), '300 字符之后的差异按截断合并');
  assert.match(postTool.commandFingerprint({ command: 'secret-token-abc' }), /^[0-9a-f]{16}$/);
  assert.ok(!postTool.commandFingerprint({ command: 'secret-token-abc' }).includes('secret'));
});

test('N-4（DEV-2 批）：重试环状态写面为 tmp+rename（静态断言——双注册并行下裸覆写产生半截 JSON）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../hooks/post-tool.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('writeFileSync(ringStateFile(sessionId)'), 'ringStateFile 不得裸 writeFileSync（须 tmp+rename 原子替换）');
  assert.ok(src.includes('.wftmp-'), 'tmp 后缀形态在场');
});

// ── 内部任务-8（2026-10-07，任务 2.2）：post-tool 分流锁定（实现零改动，用例锁死 matcher 放宽后语义）──

/** 子进程驱动 post-tool.mjs（记录钩：恒 exit 0；除 内部任务-352 ask 答复提示外零 stdout）。extraEnv 供用例补隔离缝（如 WF_POSTTOOL_STATE_DIR）。 */
async function runPostTool(payload, incidentRoot, extraEnv = {}) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const hook = fileURLToPath(new URL('../../hooks/post-tool.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, WF_INCIDENT_ROOT: incidentRoot, WF_ROUTING_STATE_DIR: join(incidentRoot, 'state'), ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

test('DEV-8 任务 2.2：非目标族 PostToolUse 成功负载零拦截零输出、零落账（matcher 放宽后锁定）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev8-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev8-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  try {
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'call_read_1', cwd: proj, tool_result: { is_error: false } },
      incidentRoot,
    );
    assert.equal(r.status, 0, '纯记录钩恒 exit 0');
    assert.equal(r.stdout.trim(), '', '零输出（零拦截）');
    assert.equal(readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure').length, 0, '成功结果不落账');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-8 任务 2.2：双通道去重语义不变——同一次失败经两通道到达只算一条（读侧 id 幂等）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev8-dedup-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev8-dedup-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  try {
    const base = { cwd: proj, tool_name: 'pwsh', tool_use_id: 'call_dup_1', tool_input: { command: 'exit 1' }, tool_result: { exit_code: 1 } };
    // 主通道（PostToolUseFailure 语义）→ 兜底通道（PostToolUse 语义）：同 callId 同形负载
    assert.equal((await runPostTool({ ...base, hook_event_name: 'PostToolUseFailure' }, incidentRoot)).status, 0);
    assert.equal((await runPostTool({ ...base, hook_event_name: 'PostToolUse' }, incidentRoot)).status, 0);
    const recs = readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure');
    assert.equal(recs.length, 1, '同一 callId 双通道到达只算一条（读侧 id 幂等，防 matcher 放宽后双记）');
    assert.equal(recs[0].id, 'tf-call_dup_1', 'id 契约：tf-<callId>');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-20 B 批（F3）：errorCode 的形态化 + 语义作用域 + provenance ──

test('DEV-20 B/F3：errorCode 形态化——大写蛇形与小写类别串均接受，拒形不落', () => {
  const okUpper = postTool.classifyResult('edit', { is_error: true, errorCode: 'FS_STALE_VERSION' });
  assert.equal(okUpper?.errorCode, 'FS_STALE_VERSION', '宿主守卫码（大写蛇形）须落');
  const okLower = postTool.classifyResult('edit', { is_error: true, errorCode: 'internal' });
  assert.equal(okLower?.errorCode, 'internal', 'Kimi 小写类别串须落（宿主兼容形态）');
  for (const bad of ['1INVALID', 'a b', 'x'.repeat(42), '', ' ok']) {
    const r = postTool.classifyResult('edit', { is_error: true, errorCode: bad });
    assert.ok(r, '记录仍按 errorClass 落（拒形不影响失败判定）');
    assert.ok(!Object.hasOwn(r, 'errorCode'), `拒形不得落 errorCode：${JSON.stringify(bad)}`);
  }
  const absent = postTool.classifyResult('edit', { is_error: true });
  assert.ok(!Object.hasOwn(absent, 'errorCode'), '缺省 ⇒ 不产键');
});

test('DEV-20 B/F3：语义作用域——exit-nonzero 永不携带 errorCode（证据层不被染成可归因失败）', () => {
  const r = postTool.classifyResult('Bash', { exit_code: 1, errorCode: 'FS_IO_ERROR' });
  assert.equal(r?.errorClass, 'exit-nonzero', '判序不变');
  assert.ok(!Object.hasOwn(r, 'errorCode'), 'exit-nonzero 属证据层：即使载荷带码也不落（评审阻塞 1）');
});

test('DEV-20 B/F3：provenance——码只认结构化字段，禁止从文案抠取', () => {
  const r = postTool.classifyResult('edit', { is_error: true, stdout: 'error FS_STALE_VERSION happened' });
  assert.ok(r, '仍有失败事实');
  assert.ok(!Object.hasOwn(r, 'errorCode'), '文案里出现码字样不得落字段（provenance 收口）');
});

test('OPEN-110 e2e：失败落账（带 inputDigest）→ 同参数成功 → open tool-failure 自动 resolved（DEV-52）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-o110-'));
  const ringRoot = mkdtempSync(join(tmpdir(), 'wf-pt-o110-ring-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-o110-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  const iso = { WF_POSTTOOL_STATE_DIR: ringRoot };
  const sess = 'sess-o110';
  const input = { command: 'git status' };
  try {
    // ①失败落账（具名 tool_use_id ⇒ id=tf-u1）——记录须带 inputDigest（自愈匹配键）
    const f = await runPostTool(
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u1', session_id: sess, cwd: proj, tool_input: input, tool_result: { exit_code: 1 } },
      incidentRoot,
      iso,
    );
    assert.equal(f.status, 0, '纯记录钩恒 exit 0');
    const afterFail = readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure');
    assert.equal(afterFail.length, 1, '失败恰落一条');
    assert.equal(afterFail[0].status, 'open');
    assert.ok(typeof afterFail[0].inputDigest === 'string' && afterFail[0].inputDigest, '记录带 inputDigest');
    // ②同参数成功（新调用、同会话同输入）→ open 态自动收口（删成功路径自愈即红）
    const s = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u2', session_id: sess, cwd: proj, tool_input: input, tool_result: { exit_code: 0 } },
      incidentRoot,
      iso,
    );
    assert.equal(s.status, 0);
    const healed = readIncidents(incidentRoot).find((x) => x.id === afterFail[0].id);
    assert.equal(healed.status, 'resolved', '同参数成功后 open tool-failure 被自动收口');
    assert.equal(healed.note, '同参数随即成功自愈（OPEN-110）');
    // ③负例：异工具名（同 command）成功不误收口——inputDigest 含工具名，换名即不同键
    const f2 = await runPostTool(
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u3', session_id: sess, cwd: proj, tool_input: input, tool_result: { exit_code: 1 } },
      incidentRoot,
      iso,
    );
    assert.equal(f2.status, 0);
    const openId = readIncidents(incidentRoot).find((x) => x.kind === 'tool-failure' && x.status === 'open').id;
    const s2 = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'pwsh', tool_use_id: 'u4', session_id: sess, cwd: proj, tool_input: input, tool_result: { exit_code: 0 } },
      incidentRoot,
      iso,
    );
    assert.equal(s2.status, 0);
    assert.equal(readIncidents(incidentRoot).find((x) => x.id === openId).status, 'open', '异工具名成功不误收口');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
    rmSync(ringRoot, { recursive: true, force: true });
  }
});

// ── 内部决策-045/内部任务-96：活动观测点端到端（PostToolUse 心跳顺延/异会话不顺延）──

test('ADR-045 活动观测端到端：同会话 PostToolUse 顺延租约、异会话不顺延', async () => {
  const { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
    const { issueChallenge, activateLease, DEFAULT_TTL_MS } = await import('../../hooks/task-lease-lib.mjs');
    const { projectKey } = await import('../../hooks/routing-lib.mjs');
    const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-adr45-'));
    const proj = mkdtempSync(join(tmpdir(), 'wf-pt-adr45-proj-'));
    const stateDir = join(incidentRoot, 'state');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_ROUTING_STATE_DIR = stateDir; // 种子与子进程同缝（runPostTool 注入同值，双保险）
    try {
      // 种子租约（同 stateDir 隔离缝；expiresAt 压到 TTL/6 过节流阈值）。
      // 种子键须与生产调用方同规取 canonical——issueChallenge 按契约原样落键，而 macOS
      // tmpdir 在 /var→/private/var symlink 后两形态分裂，原始路径与读侧 projectKey 恒不等
      const seedKey = projectKey(proj);
      const ch = issueChallenge(seedKey, { sessionId: 'sess-heart' });
      assert.ok(activateLease(seedKey, { leaseId: ch.leaseId, taskId: 'DEV-30', skill: 'tdd' }).ok);
    const actName = readdirSync(stateDir).find((n) => n.startsWith('wf-lease-active-'));
    const actPath = join(stateDir, actName);
    const act = JSON.parse(readFileSync(actPath, 'utf8'));
    writeFileSync(actPath, JSON.stringify({ ...act, expiresAt: Date.now() + Math.floor(DEFAULT_TTL_MS / 6) }));
    const before = JSON.parse(readFileSync(actPath, 'utf8')).expiresAt;
    // 同会话 PostToolUse（Read 成功负载——只读工具也在观测面）
    const r1 = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'adr45-h1', session_id: 'sess-heart', cwd: proj, tool_result: { is_error: false } },
      incidentRoot,
    );
    assert.equal(r1.status, 0);
    const after = JSON.parse(readFileSync(actPath, 'utf8')).expiresAt;
    assert.ok(after > before, '同会话观测顺延 expiresAt（心跳）');
    // 异会话观测：不顺延
    writeFileSync(actPath, JSON.stringify({ ...JSON.parse(readFileSync(actPath, 'utf8')), expiresAt: Date.now() + Math.floor(DEFAULT_TTL_MS / 6) }));
    const before2 = JSON.parse(readFileSync(actPath, 'utf8')).expiresAt;
    await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'adr45-h2', session_id: 'sess-other', cwd: proj, tool_result: { is_error: false } },
      incidentRoot,
    );
    const after2 = JSON.parse(readFileSync(actPath, 'utf8')).expiresAt;
    assert.equal(after2, before2, '异会话观测不顺延（会话身份匹配门）');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部模块-15 v2（2026-10-24 内部任务-192/内部决策-063）：分类字段、派发事实、归因、热路径处置作用域 ──

/** 造「带 .git 的激活域项目 + 账本根」夹具对（本批新增用例共用）。 */
async function mkProjectFixture(tag) {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), `wf-pt-${tag}-`));
  const proj = mkdtempSync(join(tmpdir(), `wf-pt-${tag}-proj-`));
  mkdirSync(join(proj, '.git'), { recursive: true });
  return { incidentRoot, proj };
}

test('M15 v2：失败记录带 cause/severity/ruleId/rulesVersion/observationSource 与归因字段', async () => {
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const { incidentRoot, proj } = await mkProjectFixture('v2fields');
  try {
    // ①exit-nonzero → 证据类 cause（规则表 r-probe-noise）＋派发事实＋委派归因
    await runPostTool(
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: 'v2-u1',
        session_id: 'sess-v2',
        cwd: proj,
        tool_input: { command: 'exit 1' },
        tool_result: { exit_code: 1 },
        dispatch_fact: 'dispatched',
        delegation_depth: 2,
        parent_session_id: 'parent-7',
      },
      incidentRoot,
    );
    // ②is_error → 真失败 cause（r-real-failure）＋缺省派发事实 unknown
    await runPostTool(
      { hook_event_name: 'PostToolUseFailure', tool_name: 'edit', tool_use_id: 'v2-u2', session_id: 'sess-v2', cwd: proj, tool_result: { is_error: true } },
      incidentRoot,
    );
    const rows = readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure');
    const probe = rows.find((x) => x.id === 'tf-v2-u1');
    const real = rows.find((x) => x.id === 'tf-v2-u2');
    assert.ok(probe && real, '两条失败均落账');
    assert.equal(probe.cause, 'probe-noise', 'exit-nonzero 按规则表归证据类 cause');
    assert.equal(probe.severity, 'info');
    assert.equal(probe.ruleId, 'r-probe-noise');
    assert.equal(probe.rulesVersion, 1, '规则表版本进记录（可追溯）');
    assert.equal(probe.observationSource, 'hook:post-tool', '观测来源恒标注（与适配层 emit 来源可区分）');
    assert.equal(probe.dispatchFact, 'dispatched', '派发事实由负载透传');
    assert.equal(probe.delegationDepth, 2, '委派深度入记录');
    assert.equal(probe.parentSession, 'parent-7', '父会话标识入记录');
    assert.equal(real.cause, 'real-failure', 'is_error 归真失败 cause');
    assert.equal(real.severity, 'action');
    assert.equal(real.ruleId, 'r-real-failure');
    assert.equal(real.dispatchFact, 'unknown', '缺省派发事实为 unknown（三态之一）');
    assert.ok(!Object.hasOwn(real, 'delegationDepth'), '顶层会话不产委派键（缺省不产键）');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('M15 v2：未派发调用（dispatch_fact=not-dispatched）不产生失败事实', async () => {
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const { incidentRoot, proj } = await mkProjectFixture('v2nodisp');
  try {
    const r = await runPostTool(
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: 'v2-nodisp',
        session_id: 'sess-nd',
        cwd: proj,
        tool_input: { command: 'x' },
        tool_result: { exit_code: 1 },
        dispatch_fact: 'not-dispatched',
      },
      incidentRoot,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '纯记录钩零输出');
    assert.equal(readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure').length, 0, '未派发调用不构成失败事实');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('M15 v2：成功路径只触发 retry-heal——lease 族与超龄证据行零写（热路径作用域）', async () => {
  const { readIncidents, appendIncident, digestOf } = await import('../lib/incident-store.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { incidentRoot, proj } = await mkProjectFixture('v2heal');
  const ledger = join(incidentRoot, '.workflow', 'incidents.jsonl');
  try {
    const now = Date.now();
    const input = { command: 'node --version' };
    const inputDigest = digestOf(['input', 'Bash', JSON.stringify(input)]);
    appendIncident(incidentRoot, { id: 'lease-open-1', ts: now, session: 'sess-heal', kind: 'lease-deny', cause: 'mechanism-trace', digest: 'dl00000000000001' });
    appendIncident(incidentRoot, { id: 'aged-probe-1', ts: now - 40 * 86400000, session: 'sess-heal', kind: 'tool-failure', errorClass: 'exit-nonzero', cause: 'probe-noise', digest: 'dp00000000000001' });
    appendIncident(incidentRoot, { id: 'tf-heal-1', ts: now - 1000, session: 'sess-heal', kind: 'tool-failure', tool: 'Bash', inputDigest, cause: 'real-failure', digest: 'dh00000000000001', status: 'open' });
    const beforeLines = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim()).length;
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'v2-ok1', session_id: 'sess-heal', cwd: proj, tool_input: input, tool_result: { exit_code: 0 } },
      incidentRoot,
    );
    assert.equal(r.status, 0);
    const rows = readIncidents(incidentRoot);
    const healed = rows.find((x) => x.id === 'tf-heal-1');
    assert.equal(healed.status, 'resolved', '同参数 open 失败被自愈');
    assert.equal(healed.autoDisposition, 'retry-heal', '迁移行带统一处置审计字段');
    assert.equal(rows.find((x) => x.id === 'lease-open-1').status, 'open', '热路径不得解 lease 族');
    assert.equal(rows.find((x) => x.id === 'aged-probe-1').status, 'open', '热路径不得归档（作用域限 retry-heal）');
    const afterLines = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim()).length;
    assert.equal(afterLines, beforeLines + 1, '只追加自愈迁移一行（零多余写）');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('M15 v2：处置失败经 noteHookIssue 落 hook-errors.jsonl 且仍 exit 0', async (t) => {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 环境 chmod 不产生 EPERM，写失败面无法取证');
  }
  const { appendIncident, digestOf, incidentFile } = await import('../lib/incident-store.mjs');
  const { chmodSync, existsSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { incidentRoot, proj } = await mkProjectFixture('v2disp');
  const stateDir = mkdtempSync(join(tmpdir(), 'wf-pt-v2disp-state-'));
  let locked = false;
  try {
    const input = { command: 'git status' };
    const now = Date.now();
    appendIncident(incidentRoot, {
      id: 'tf-disp-1', ts: now - 1000, session: 'sess-disp', kind: 'tool-failure', tool: 'Bash',
      inputDigest: digestOf(['input', 'Bash', JSON.stringify(input)]), cause: 'real-failure', digest: 'dd00000000000001', status: 'open',
    });
    chmodSync(incidentFile(incidentRoot), 0o444);
    locked = true;
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'v2-disp', session_id: 'sess-disp', cwd: proj, tool_input: input, tool_result: { exit_code: 0 } },
      incidentRoot,
      { WF_ROUTING_STATE_DIR: stateDir },
    );
    assert.equal(r.status, 0, '处置失败不得反噬主职责（fail-open）');
    const errFile = join(stateDir, 'hook-errors.jsonl');
    assert.ok(existsSync(errFile), 'hook-errors.jsonl 落盘（静默失败面可见）');
    const lines = readFileSync(errFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((x) => x.script === 'post-tool' && x.reason === 'disposition-failed'), '按脚本与原因归因');
  } finally {
    if (locked) chmodSync(incidentFile(incidentRoot), 0o666);
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('M15 v2：账本写失败不抛且 exit 0（记录职责不得反噬会话）', async (t) => {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 环境 chmod 不产生 EPERM，写失败面无法取证');
  }
  const { appendIncident, incidentFile } = await import('../lib/incident-store.mjs');
  const { chmodSync } = await import('node:fs');
  const { incidentRoot, proj } = await mkProjectFixture('v2writefail');
  let locked = false;
  try {
    appendIncident(incidentRoot, { id: 'seed-1', ts: Date.now(), session: 's', kind: 'tool-failure', digest: 'dz00000000000001' });
    chmodSync(incidentFile(incidentRoot), 0o444);
    locked = true;
    const r = await runPostTool(
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'v2-wf', session_id: 's', cwd: proj, tool_input: { command: 'x' }, tool_result: { exit_code: 2 } },
      incidentRoot,
    );
    assert.equal(r.status, 0, '写失败仍 exit 0');
    assert.equal(r.stdout.trim(), '', '零输出');
  } finally {
    if (locked) chmodSync(incidentFile(incidentRoot), 0o666);
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('M15 v2：--selftest 项数随批增长（≥38）且全过', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const hook = fileURLToPath(new URL('../../hooks/post-tool.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [hook, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `selftest 须退 0：${r.stdout}${r.stderr}`);
  const m = /OK post-tool\.mjs selftest（(\d+) 项通过）/.exec(r.stdout);
  assert.ok(m, '输出项数');
  assert.ok(Number(m[1]) >= 38, `项数须 ≥38（实际 ${m[1]}）`);
});

// ── 内部模块-15 v2 写者接线（评审修复 N5）：retry-loop 记录带分类字段 ──

test('评审修复 N5：retry-loop 记录带 cause=retry-escalation/ruleId/rulesVersion/observationSource', async () => {
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const { incidentRoot, proj } = await mkProjectFixture('v2retry');
  try {
    const input = { command: 'bash -c "exit 1"' };
    // 同 tool+input 三次失败 → 第三次触发 retry-loop（uid 各异，避开双触发 60s 去重）
    for (const uid of ['rr1', 'rr2', 'rr3']) {
      const r = await runPostTool(
        { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: uid, session_id: 'sess-rr', cwd: proj, tool_input: input, tool_result: { exit_code: 1 } },
        incidentRoot,
      );
      assert.equal(r.status, 0, `纯记录钩恒 exit 0（${uid}）`);
    }
    const loop = readIncidents(incidentRoot).find((x) => x.kind === 'retry-loop');
    assert.ok(loop, '第三次同参失败触发 retry-loop');
    assert.equal(loop.cause, 'retry-escalation', '规则表 r-retry-escalation');
    assert.equal(loop.ruleId, 'r-retry-escalation');
    assert.equal(loop.rulesVersion, 1);
    assert.equal(loop.observationSource, 'hook:post-tool');
    assert.equal(loop.status, 'open');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// 内部模块-15 v2 判据单源（2026-10-24 内部任务-195/内部决策-063 修正案 3 决策 20）：classifyResult 生产实现与
// 分类指纹链（commandFingerprint/actionFingerprint/CODE_RE）下沉 `scripts/lib/tool-result-classify.mjs`，
// post-tool 仅**同名再导出**（既有调用零改动），session-start 就绪面 canary 改从 lib 导入
// （禁止跨钩导入）。lib 不得反向 import 钩子入口（单向依赖）。
// ─────────────────────────────────────────────────────────────────────────────
test('M15 v2 判据单源：classifyResult 与指纹链下沉 lib（钩只再导出）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const libPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'tool-result-classify.mjs');
  const postPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'post-tool.mjs');
  const startPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'session-start.mjs');
  const lib = await import(pathToFileURL(libPath).href);
  assert.equal(typeof lib.classifyResult, 'function', 'lib 导出 classifyResult');
  assert.equal(typeof lib.commandFingerprint, 'function', 'lib 导出 commandFingerprint（指纹链一并下沉）');
  assert.equal(typeof lib.actionFingerprint, 'function', 'lib 导出 actionFingerprint');
  const libText = readFileSync(libPath, 'utf8');
  assert.ok(!/from\s+['"][^'"]*hooks\//.test(libText), 'lib 不得反向 import 钩子入口（单向依赖）');
  const postText = readFileSync(postPath, 'utf8');
  for (const name of ['classifyResult', 'commandFingerprint', 'actionFingerprint']) {
    assert.ok(!new RegExp(`function\\s+${name}\\s*\\(`).test(postText), `post-tool 不得保留 ${name} 第二实现`);
  }
  assert.ok(!/const CODE_RE\s*=/.test(postText), 'code 形态判据随判据链下沉，钩内不得留副本');
  const startText = readFileSync(startPath, 'utf8');
  assert.ok(
    /from\s+['"]\.\.\/scripts\/lib\/tool-result-classify\.mjs['"]/.test(startText),
    'session-start canary 改从 lib 导入 classifyResult（非跨钩导入 post-tool）',
  );
  assert.ok(!/from\s+['"]\.\/post-tool\.mjs['"]/.test(startText), 'session-start 不得再跨钩导入 post-tool');
});

// ── 内部任务-244 P01：重试自愈索引缓存（失败入索引 → 成功 hit 回读复核收口） ──

test('DEV-244 P01：失败入索引、同参数成功命中索引自愈收口（不依赖全量回扫）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'post-tool.mjs');
  const home = mkdtempSync(join(tmpdir(), 'wf-p01-idx-'));
  const state = join(home, 'state');
  const incidentRoot = join(home, 'inc');
  const env = { ...process.env, WF_ROUTING_STATE_DIR: state, WF_INCIDENT_ROOT: incidentRoot };
  const runHook = (payloadObj) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payloadObj), encoding: 'utf8', env });
  try {
    const session = 'sess-p01';
    const toolInput = { command: 'npm run build' };
    const fail = runHook({ session_id: session, cwd: process.cwd(), tool_name: 'pwsh', tool_use_id: 'p01-1', tool_input: toolInput, tool_result: { exit_code: 1 } });
    assert.equal(fail.status, 0);
    const incidentFile = join(incidentRoot, '.workflow', 'incidents.jsonl');
    assert.ok(readFileSync(incidentFile, 'utf8').includes('tf-p01-1'), '失败记录已入账（前置）');
    const ok = runHook({ session_id: session, cwd: process.cwd(), tool_name: 'pwsh', tool_use_id: 'p01-2', tool_input: toolInput, tool_result: { exit_code: 0 } });
    assert.equal(ok.status, 0);
    const lines = readFileSync(incidentFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const folded = new Map();
    for (const l of lines) folded.set(l.id, l);
    assert.equal(folded.get('tf-p01-1').status, 'resolved', '索引命中路径完成自愈收口');
    // 失败入索引（诊断用：索引文件存在或已随收口清理均合法；此处锁定 hook-errors 无 index-degraded）
    const hookErrors = join(state, 'hook-errors.jsonl');
    const text = (() => { try { return readFileSync(hookErrors, 'utf8'); } catch { return ''; } })();
    assert.ok(!text.includes('index-degraded'), '正常路径零降级留痕');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('DEV-244 P01：索引写失败 → hook-errors 落 index-degraded（fallback 仍工作）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'post-tool.mjs');
  const home = mkdtempSync(join(tmpdir(), 'wf-p01-idxfail-'));
  const state = join(home, 'state');
  const env = { ...process.env, WF_ROUTING_STATE_DIR: state, WF_INCIDENT_ROOT: join(home, 'inc'), WF_POSTTOOL_FORCE_INDEX_FAIL: '1' };
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 'sess-p01f', cwd: process.cwd(), tool_name: 'pwsh', tool_use_id: 'p01f-1', tool_result: { exit_code: 1 } }),
      encoding: 'utf8',
      env,
    });
    assert.equal(r.status, 0, '钩恒 fail-open');
    const log = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(log), '索引写失败必须可见');
    assert.ok(readFileSync(log, 'utf8').includes('index-degraded'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('DEV-244 E01：账本写失败经 hook-errors 留痕（ledger-write-failed）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'post-tool.mjs');
  const home = mkdtempSync(join(tmpdir(), 'wf-e01-'));
  const state = join(home, 'state');
  const blocker = join(home, 'ledger-blocker'); // 文件占位：incident 根不可建目录 → appendIncident {ok:false}
  writeFileSync(blocker, 'not-a-dir');
  try {
    const payload = JSON.stringify({
      session_id: 's-e01',
      cwd: process.cwd(),
      tool_name: 'pwsh',
      tool_use_id: 'e01-1',
      tool_result: { exit_code: 1 },
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, WF_ROUTING_STATE_DIR: state, WF_INCIDENT_ROOT: blocker },
    });
    assert.equal(r.status, 0, '钩恒 fail-open exit 0');
    const log = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(log), '账本写失败必须可见（hook-errors 留痕）');
    const reasons = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).reason);
    assert.ok(reasons.includes('ledger-write-failed'), `含 ledger-write-failed（实得 ${JSON.stringify(reasons)}）`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 内部任务-244 D07：重试环推进的原子单写者占位（并发不丢更新 / 崩溃残留可恢复） ──

/** 构造「失败调用」负载（触发环推进的最小面）。 */
function d07Payload(toolUseId, cwd) {
  return {
    hook_event_name: 'PostToolUseFailure',
    session_id: 'd07-sess',
    cwd,
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command: 'false' },
    tool_result: { is_error: true, exit_code: 1 },
  };
}

test('DEV-244 D07：占位被在途持有者占用时本次不写环（防并行双计数）', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { sessionStateFile } = await import('../../hooks/hook-lib.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-d07-busy-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-d07-busy-proj-'));
  const iso = join(incidentRoot, 'posttool-state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(iso, { recursive: true });
  const prevIso = process.env.WF_POSTTOOL_STATE_DIR;
  try {
    process.env.WF_POSTTOOL_STATE_DIR = iso;
    const placeholder = postTool.retryPlaceholderFile('d07-sess', 'uid:d07-busy');
    writeFileSync(placeholder, JSON.stringify({ pid: 1, ts: Date.now() })); // 他者正在推进
    const r = await runPostTool(d07Payload('d07-busy', proj), incidentRoot, { WF_POSTTOOL_STATE_DIR: iso });
    assert.equal(r.status, 0);
    const ringFile = sessionStateFile('wf-posttool', 'd07-sess', iso);
    assert.ok(!existsSync(ringFile), '抢不到占位则不写环（他者会推进）');
    assert.ok(existsSync(placeholder), '他者占位不得被误删');
  } finally {
    if (prevIso === undefined) delete process.env.WF_POSTTOOL_STATE_DIR;
    else process.env.WF_POSTTOOL_STATE_DIR = prevIso;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('DEV-244 D07：崩溃残留（超 TTL 占位）隔离回收后仍可推进并留痕', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } = await import('node:fs');
  const { sessionStateFile } = await import('../../hooks/hook-lib.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-d07-stale-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-d07-stale-proj-'));
  const iso = join(incidentRoot, 'posttool-state');
  const state = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(iso, { recursive: true });
  const prevIso = process.env.WF_POSTTOOL_STATE_DIR;
  try {
    process.env.WF_POSTTOOL_STATE_DIR = iso;
    const placeholder = postTool.retryPlaceholderFile('d07-sess', 'uid:d07-stale');
    writeFileSync(placeholder, JSON.stringify({ pid: 999999, ts: 0 }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(placeholder, old, old); // 模拟崩溃残留（超 60s TTL）
    const r = await runPostTool(d07Payload('d07-stale', proj), incidentRoot, {
      WF_POSTTOOL_STATE_DIR: iso,
      WF_ROUTING_STATE_DIR: state,
    });
    assert.equal(r.status, 0);
    const ringFile = sessionStateFile('wf-posttool', 'd07-sess', iso);
    assert.ok(existsSync(ringFile), '陈旧占位回收后本次推进成功（环状态落盘）');
    assert.equal(JSON.parse(readFileSync(ringFile, 'utf8')).lastKey, 'uid:d07-stale');
    assert.ok(!existsSync(placeholder), '占位由持有者 finally 清理');
    const errLog = join(state, 'hook-errors.jsonl');
    assert.ok(existsSync(errLog) && readFileSync(errLog, 'utf8').includes('retry-placeholder-stale'), '陈旧回收必须留痕（noteHookIssue）');
  } finally {
    if (prevIso === undefined) delete process.env.WF_POSTTOOL_STATE_DIR;
    else process.env.WF_POSTTOOL_STATE_DIR = prevIso;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-244 遗留项②：占位陈旧回收残件（.stale-*）超 TTL 清理 ──

test('DEV-244 遗留：超龄 .stale-* 占位残件在下次推进时清理（1h TTL）', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-residue-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-residue-proj-'));
  const iso = join(incidentRoot, 'posttool-state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(iso, { recursive: true });
  const prevIso = process.env.WF_POSTTOOL_STATE_DIR;
  try {
    process.env.WF_POSTTOOL_STATE_DIR = iso;
    const placeholder = postTool.retryPlaceholderFile('residue-sess', 'uid:residue-1');
    const residue = `${placeholder}.stale-1700000000000`;
    writeFileSync(residue, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h（超 1h TTL）
    utimesSync(residue, old, old);
    const freshResidue = `${placeholder}.stale-1700000000001`;
    writeFileSync(freshResidue, '{}'); // 新鲜残件：保留（供诊断）
    const r = await runPostTool(d07Payload('residue-1', proj), incidentRoot, { WF_POSTTOOL_STATE_DIR: iso });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(residue), '超龄 .stale-* 残件被清理');
    assert.ok(existsSync(freshResidue), '新鲜残件保留（TTL 内不误删）');
  } finally {
    if (prevIso === undefined) delete process.env.WF_POSTTOOL_STATE_DIR;
    else process.env.WF_POSTTOOL_STATE_DIR = prevIso;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-342：post-tool 归因 taskId own-only（null 桶租约不归因） ──

test('DEV-342 归因 taskId：post-tool 记录在 null 桶租约下 taskId=null、本会话具名桶下取任务号', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readIncidents } = await import('../lib/incident-store.mjs');
  const { issueChallenge, activateLease } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-d342-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-d342-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  const state = join(incidentRoot, 'state');
  mkdirSync(state, { recursive: true });
  const prev = process.env.WF_ROUTING_STATE_DIR;
  try {
    // null 桶声明：记录 taskId 不得归因
    process.env.WF_ROUTING_STATE_DIR = state;
    const key = projectKey(proj);
    const chNull = issueChallenge(key);
    assert.ok(activateLease(key, { leaseId: chNull.leaseId, taskId: 'DEV-960', skill: 'plan-execution' }).ok);
    const payload = (sid) => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: `call_pt342_${sid}`,
      session_id: sid,
      cwd: proj,
      tool_input: { command: 'x' },
      tool_result: { exit_code: 1, stderr: 'boom' },
    });
    await runPostTool(payload('pt342-null'), incidentRoot);
    const nullRecs = readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure');
    assert.ok(nullRecs.length >= 1, '失败须落账');
    assert.equal(nullRecs.at(-1).taskId, null, 'null 桶租约不得作为 post-tool 记录 taskId');
    // 本会话具名桶声明：记录 taskId 可取
    const ch = issueChallenge(key, { sessionId: 'pt342-sess' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: 'DEV-961', skill: 'plan-execution' }).ok);
    await runPostTool(payload('pt342-sess'), incidentRoot);
    const recs = readIncidents(incidentRoot).filter((x) => x.kind === 'tool-failure');
    assert.equal(recs.at(-1).taskId, 'DEV-961', '本会话具名桶记录 taskId 须取该任务号');
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-352（2026-11-08）：AskUserQuestion 答复通道只读租约提示（内部模块-8 内部规则-8/内部验收-47）──

/** 在隔离状态根内造「挑战存在、active 缺席」态；返回 key/leaseId（调用方负责 env 与清理）。 */
async function seedDev352Challenge(proj, stateDir, sessionId) {
  const { issueChallenge } = await import('../../hooks/task-lease-lib.mjs');
  const { projectKey } = await import('../../hooks/routing-lib.mjs');
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const key = projectKey(proj);
    const ch = issueChallenge(key, { sessionId });
    return { key, leaseId: ch.leaseId };
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
  }
}

test('AskUserQuestion 答复提示信封（DEV-352）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-proj-'));
  const stateDir = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const seeded = await seedDev352Challenge(proj, stateDir, 'SDEV352');
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'call_ask_dev352', session_id: 'SDEV352', cwd: proj, tool_input: { question: 'probe' } },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(r.status, 0, '信封路径仍 exit 0');
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse', 'R-M8-6：hookEventName 与触发事件一致');
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(text.includes('【workflow 任务租约】'), '含租约行');
    assert.ok(text.includes(seeded.leaseId), '含当前挑战令牌');
    assert.ok(text.includes('--lease'), '含声明命令');
    assert.ok(text.includes('答复通道提示：答复不轮换令牌'), '含唯一尾注（真机判读锚）');
    assert.equal(Object.prototype.hasOwnProperty.call(out.hookSpecificOutput, 'decision'), false, '不得携带决策位');
    assert.equal(Object.prototype.hasOwnProperty.call(out.hookSpecificOutput, 'permissionDecision'), false, '不得携带权限决策位');
    assert.equal(text.split('\n').filter((l) => l.includes('【workflow 任务租约】')).length, 1, '单键单行');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('答复提示只读不签发（DEV-352）', async () => {
  const { mkdtempSync, mkdirSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-ro-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-ro-proj-'));
  const stateDir = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const seeded = await seedDev352Challenge(proj, stateDir, 'SDEV352RO');
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'ask_user_question', tool_use_id: 'call_ask_dev352_ro', session_id: 'SDEV352RO', cwd: proj, tool_input: {} },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('答复通道提示：答复不轮换令牌'));
    const { readActiveLease } = await import('../../hooks/task-lease-lib.mjs');
    assert.equal(readActiveLease(seeded.key, Date.now(), { sessionId: 'SDEV352RO' }).valid, false, '提示不产生 active 租约');
    assert.equal(readdirSync(stateDir).filter((n) => n.startsWith('wf-lease-active-')).length, 0, '状态目录零 active 文件（零激活副作用）');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('答复提示触发门-已声明（DEV-352）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-dec-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-dec-proj-'));
  const stateDir = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const seeded = await seedDev352Challenge(proj, stateDir, 'SDEV352DEC');
    const { activateLease } = await import('../../hooks/task-lease-lib.mjs');
    assert.ok(activateLease(seeded.key, { leaseId: seeded.leaseId, taskId: 'DEV-352', skill: 'plan-execution' }).ok, '夹具：已声明态');
    const r = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'call_ask_dev352_dec', session_id: 'SDEV352DEC', cwd: proj, tool_input: {} },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '已声明态零输出（触发门）');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('答复提示触发门-非 ask/失败（DEV-352）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-gate-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-gate-proj-'));
  const stateDir = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    await seedDev352Challenge(proj, stateDir, 'SDEV352GATE');
    const nonAsk = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'pwsh', tool_use_id: 'call_pwsh_dev352', session_id: 'SDEV352GATE', cwd: proj, tool_input: { command: 'echo ok' }, tool_result: { exit_code: 0 } },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(nonAsk.stdout.trim(), '', '非 ask 工具零输出（纯记录语义保留）');
    const failedAsk = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'ask_user_question', tool_use_id: 'call_ask_dev352_fail', session_id: 'SDEV352GATE', cwd: proj, tool_input: {}, tool_result: { is_error: true } },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(failedAsk.stdout.trim(), '', '失败 ask 零输出');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('答复提示触发门-委派/域外（DEV-352）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-del-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-del-proj-'));
  const outside = mkdtempSync(join(tmpdir(), 'wf-pt-dev352-outside-'));
  const stateDir = join(incidentRoot, 'state');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const prevStateDir = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    await seedDev352Challenge(proj, stateDir, 'SDEV352DEL');
    const delegated = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'call_ask_dev352_del', session_id: 'SDEV352DEL', cwd: proj, tool_input: {}, delegation_depth: 1, parent_session_id: 'parent-dev352' },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(delegated.stdout.trim(), '', '委派会话零输出（ADR-061 D4：禁止自取号提示）');
    const outsideDomain = await runPostTool(
      { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'call_ask_dev352_out', session_id: 'SDEV352OUT', cwd: outside, tool_input: {} },
      incidentRoot,
      { WF_POSTTOOL_STATE_DIR: join(incidentRoot, 'ring') },
    );
    assert.equal(outsideDomain.stdout.trim(), '', '域外（无激活根）零输出');
  } finally {
    if (prevStateDir === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevStateDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});