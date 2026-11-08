// 文件：hooks-wiring.test.mjs
// 描述：hooks.json 接线 lint——把宿主事件契约（内部接口-1）固化成可回归的断言，
//       防止接线漂移（P-1 的同类错误：matcher 漏值曾导致 resume 会话零注入，
//       姊妹插件 spec-gate 用四值而本插件用三值，纯靠人眼对照）。
//       覆盖：a) SessionStart matcher 必须匹配宿主四值 startup/resume/clear/compact；
//       b) UserPromptSubmit 提醒 hook 必须接线（内部规则-7）；c) hooks.json 声明的每个
//       钩子脚本文件必须真实存在；d) 既有护栏接线（Stop/PreToolUse）不得回退；
//       e) 自察捕获接线（PostToolUseFailure 主通道 + PostToolUse 兜底，内部模块-15/内部决策-019）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；被测对象是本插件真实的 hooks.json。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'hooks.json');
const MANIFEST_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin.manifest.json');
/** 宿主 SessionStart 的全部合法匹配值（zcode-guide diagnosing-hooks：startup|resume|clear|compact） */
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact'];

/**
 * 读取并解析真实 hooks.json。
 * @returns {{ hooks: Record<string, Array<{ matcher?: string, hooks: Array<{ type: string, command: string, args?: string[] }> }>> }}
 */
function wiring() {
  return JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
}

/**
 * 取某事件下全部条目（无则空数组）。
 * @param {ReturnType<typeof wiring>} w 接线表
 * @param {string} event 事件名
 */
function entries(w, event) {
  return w.hooks[event] ?? [];
}

/**
 * 条目 matcher 缺省 = 匹配一切（宿主语义）；返回该条目实际生效的正则。
 * @param {{ matcher?: string }} entry 事件条目
 * @returns {RegExp}
 */
function matcherOf(entry) {
  return new RegExp(entry.matcher ?? '');
}

test('a) SessionStart matcher 覆盖宿主四值（含 resume）', () => {
  const list = entries(wiring(), 'SessionStart');
  assert.equal(list.length, 1, 'SessionStart 应恰好接线一个条目');
  for (const source of SESSION_START_SOURCES) {
    assert.ok(
      matcherOf(list[0]).test(source),
      `SessionStart matcher「${list[0].matcher}」未匹配宿主匹配值「${source}」`,
    );
  }
});

test('b) UserPromptSubmit 提醒 hook 已接线（内部规则-7）', () => {
  const list = entries(wiring(), 'UserPromptSubmit');
  assert.ok(list.length >= 1, 'UserPromptSubmit 未接线：任务到来时点零机械覆盖');
  const procs = list.flatMap((e) => e.hooks);
  assert.ok(
    procs.some((h) => (h.args ?? []).some((a) => a.includes('user-prompt'))),
    'UserPromptSubmit 条目应指向 user-prompt 提醒脚本',
  );
});

test('c) 声明的每个钩子脚本文件必须存在', () => {
  const root = resolve(dirname(HOOKS_JSON), '..');
  for (const [event, list] of Object.entries(wiring().hooks)) {
    for (const entry of list) {
      for (const h of entry.hooks) {
        const scriptArg = (h.args ?? []).find((a) => a.includes('hooks/'));
        if (!scriptArg) continue; // 非脚本类钩子（预留）不参与存在性检查
        const rel = scriptArg.replace('${ZCODE_PLUGIN_ROOT}/', '').replace('${CLAUDE_PLUGIN_ROOT}/', '');
        assert.ok(existsSync(join(root, rel)), `${event} 声明的脚本缺失：${rel}`);
      }
    }
  }
});

test('e) 自察捕获接线：PostToolUseFailure 与 PostToolUse 双通道（内部模块-15/内部决策-019）', () => {
  const w = wiring();
  const fail = entries(w, 'PostToolUseFailure');
  assert.ok(fail.length >= 1, 'PostToolUseFailure 未接线：工具失败捕获缺主通道');
  for (const e of fail) assert.equal(e.matcher, undefined, 'PostToolUseFailure 组无 matcher 键（全命中先例形态）');
  const post = entries(w, 'PostToolUse');
  assert.ok(post.length >= 1, 'PostToolUse 未接线：防御解析兜底通道缺失');
  assert.ok(
    post.some((e) => (e.hooks ?? []).some((h) => (h.args ?? []).some((a) => a.includes('post-tool')))),
    'PostToolUse 兜底通道应指向 post-tool 脚本',
  );
  for (const e of post) assert.equal(e.matcher, undefined, 'PostToolUse 组不得再带 matcher（内部任务-8 全命中形态）');
});

test('d) 既有护栏接线不得回退（Stop / PreToolUse×4，含路由闸与写仓闸）', () => {
  const w = wiring();
  const stop = entries(w, 'Stop');
  assert.ok(stop.length >= 2, 'Stop 钩不得回退（task-recap 居首 + learnings-recap 次位 + verify-gate 完成闸）');
  assert.ok(
    (stop[0].hooks ?? []).some((h) => (h.args ?? []).some((a) => a.includes('task-recap'))),
    'task-recap 必须置于 Stop 数组首位（verify-gate exit 2 可能中止后续钩——序无关健壮设计，内部决策-019 内部决策-2）',
  );
  assert.ok(
    (stop[1].hooks ?? []).some((h) => (h.args ?? []).some((a) => a.includes('learnings-recap'))),
    'learnings-recap 必须置于 Stop 第二位（task-recap 之后、verify-gate 之前，内部规则-9）',
  );
  assert.ok(
    stop.some((e) => (e.hooks ?? []).some((h) => (h.args ?? []).some((a) => a.includes('verify-gate')))),
    'Stop（verify-gate 完成闸）接线不得回退',
  );
  const pre = entries(w, 'PreToolUse');
  const scripts = pre.flatMap((e) => e.hooks.flatMap((h) => h.args ?? []));
  assert.ok(scripts.some((a) => a.includes('check-careful')), 'PreToolUse 危险命令护栏接线不得回退');
  assert.ok(scripts.some((a) => a.includes('check-freeze')), 'PreToolUse 编辑冻结护栏接线不得回退');
  assert.ok(scripts.some((a) => a.includes('routing-gate')), 'PreToolUse 路由闸接线不得回退（内部规则-8）');
  assert.ok(scripts.some((a) => a.includes('write-guard')), 'PreToolUse 写仓闸接线不得回退（内部任务-261/内部决策-066）');
  // 内部任务-8（内部规则-17）：三条一律**省略 matcher 键**（全命中形态）——旧词表 Bash/Edit|Write 在
  // DSH 工具名（pwsh/edit/write）上恒不匹配（RC-0 拆护栏），改回词表即红
  for (const e of pre) assert.equal(e.matcher, undefined, `PreToolUse 组不得再带 matcher（收到「${e.matcher}」）`);
});

test('内部任务-8 任务 2.6：中立清单与物化产物同形——工具事件组一律省略 matcher（禁 .* 形态）', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'));
  const toolEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
  const declared = (manifest.hooks ?? []).filter((h) => toolEvents.includes(h.event));
  assert.ok(declared.length >= 4, '工具事件声明在场（PreToolUse×3 + Post 家族×2）');
  for (const h of declared) {
    assert.equal(
      h.matcher,
      undefined,
      `${h.event} 声明不得带 matcher 键（省略键=全命中；「.*」在 DSH 恒不匹配，已证伪形态）`,
    );
  }
  // 物化产物同形对拍（测试面镜像 plugin-core verify）：逐事件组数与 matcher 形态一致
  const w = wiring();
  for (const event of toolEvents) {
    const declaredCount = declared.filter((h) => h.event === event).length;
    assert.equal(entries(w, event).length, declaredCount, `${event} 物化组数与 manifest 声明数一致`);
    for (const e of entries(w, event)) assert.equal(e.matcher, undefined, `${event} 物化组不得带 matcher 键`);
  }
});

// ── 内部任务-244 T01/T02：进程钩逐处理器期望表（manifest 派生 × hooks.json 对拍）＋ Stop 序 ──

test('内部任务-244 T01/T02：type=process/command=node/timeoutMs 期望表逐处理器；Stop 恰 3 项且 verify-gate 末项', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'));
  const w = wiring();
  // 期望表（本批定稿；与 manifest 声明派生集合完全覆盖——新增脚本未登记即红）
  const EXPECT_TIMEOUT = {
    'session-start': 10000,
    'verify-gate': 60000,
    'user-prompt': 5000,
    'task-recap': 5000,
    'learnings-recap': 5000,
    'check-careful': 5000,
    'check-freeze': 5000,
    'routing-gate': 5000,
    'write-guard': 2000,
    'post-tool': 5000,
  };
  const scriptOf = (args) => {
    for (const a of args ?? []) {
      const m = String(a).match(/hooks\/([^/]+)\.mjs$/);
      if (m) return m[1];
    }
    return null;
  };
  const proc = Object.entries(w.hooks).flatMap(([event, list]) =>
    list.flatMap((e) => (e.hooks ?? []).map((h) => ({ event, ...h }))));
  assert.equal(proc.length, (manifest.hooks ?? []).length, 'hooks.json 处理器总数与 manifest 声明一致');
  for (const h of proc) {
    const name = scriptOf(h.args);
    assert.ok(name && Object.hasOwn(EXPECT_TIMEOUT, name), `${h.event} 处理器脚本须在期望表登记（实得 ${name}）`);
    assert.equal(h.type, 'process', `${name}: type 必须 process`);
    assert.equal(h.command, 'node', `${name}: command 必须 node`);
    assert.equal(h.timeoutMs, EXPECT_TIMEOUT[name], `${name}: timeoutMs 期望 ${EXPECT_TIMEOUT[name]}`);
  }
  // manifest 声明的每个脚本都被期望表覆盖（防"声明有、断言漏"）
  for (const h of manifest.hooks ?? []) {
    const name = scriptOf(h.args);
    assert.ok(name && Object.hasOwn(EXPECT_TIMEOUT, name), `manifest 脚本须在期望表登记：${name}`);
    assert.equal(h.timeoutMs, EXPECT_TIMEOUT[name], `manifest ${name} timeoutMs 与期望表一致`);
  }
  // Stop 恰 3 项且 verify-gate 末项（exit 2 中止后续钩——完成闸必须最后）
  const stop = entries(w, 'Stop');
  assert.equal(stop.length, 3, 'Stop 恰 3 项');
  const stopScripts = stop.map((e) => (e.hooks ?? []).map((hh) => scriptOf(hh.args)).filter(Boolean).join(','));
  assert.deepEqual(stopScripts, ['task-recap', 'learnings-recap', 'verify-gate'], 'Stop 顺序固定且 verify-gate 末项');
});
