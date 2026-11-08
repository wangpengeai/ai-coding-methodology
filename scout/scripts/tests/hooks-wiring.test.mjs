// 文件：hooks-wiring.test.mjs
// 描述：scout hooks.json 接线 lint——按宿主 schema 的两层嵌套形态（{matcher, hooks:[…]}）
//       校验 SessionStart 注册与脚本存在性（对照 workflow/scripts/tests/hooks-wiring.test.mjs）。
// 作者：wangp  创建：2026-09-12  版权：MIT（见 scout/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const wiring = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'));

// 宿主 schema 的事件条目是 { matcher?, hooks: [...] } 两层：可执行字段只在内层数组
const sessionEntries = wiring?.hooks?.SessionStart ?? [];
const sessionHooks = sessionEntries.flatMap((e) => e.hooks ?? []);

test('接线：SessionStart 注册覆盖 startup/resume/clear/compact 四事件', () => {
  assert.ok(sessionEntries.length >= 1, 'SessionStart 至少注册一个条目');
  const matchers = sessionEntries.map((e) => e.matcher ?? '');
  assert.ok(
    matchers.some((m) => /startup/.test(m) && /resume/.test(m) && /clear/.test(m) && /compact/.test(m)),
    'matcher 须四值齐全（漏 resume 曾致 workflow 侧 resume 会话零注入）'
  );
});

test('接线：SessionStart 条目为宿主 schema 嵌套形态且命令引用走 ${ZCODE_PLUGIN_ROOT}', () => {
  assert.ok(sessionHooks.length >= 1, '内层 hooks 数组至少一条（扁平形态会被宿主丢弃）');
  const cmd = sessionHooks.map((h) => (h.args ?? []).join(' ')).join('\n');
  assert.ok(cmd.includes('${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs'));
  assert.ok(existsSync(join(HOOKS_DIR, 'session-start.mjs')));
});

// ── 步骤 8（T19 fail-open / selftest fail-loud）──

test('fail-open：缺失 scripts 模块时运行态静默 exit 0；--selftest fail-loud exit 1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'scout-hook-failopen-'));
  try {
    cpSync(join(HOOKS_DIR, 'session-start.mjs'), join(tmp, 'session-start.mjs'));
    const env = { ...process.env, ZCODE_PROJECT_DIR: tmp };
    const runtime = spawnSync(process.execPath, [join(tmp, 'session-start.mjs')], { encoding: 'utf8', env, input: '{}' });
    assert.equal(runtime.status, 0, '运行态 fail-open 必须静默退 0');
    assert.equal((runtime.stdout ?? '').trim(), '', '运行态不得输出信封');
    const selftest = spawnSync(process.execPath, [join(tmp, 'session-start.mjs'), '--selftest'], { encoding: 'utf8', env });
    assert.equal(selftest.status, 1, '诊断入口 fail-loud 须非 0');
    assert.match(selftest.stdout, /FAIL session-start selftest/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
