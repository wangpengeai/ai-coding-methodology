// 文件：post-tool-use-failure.test.mjs
// 描述：内部任务-214 批 2（内部验收-9 系统测试）——spec-gate PostToolUse hook 的校验器异常注入面：
//       校验器不可用（SDD_TEST_VALIDATOR_BROKEN=1）且显式开启 block（ZCODE_USER_CONFIG_SDD_HOOK_BLOCK=true）时，
//       阻断「未生效」必须可见：exit 0＋stderr 恰一行提示（H-7 语义，超出 --selftest 断言面）；
//       默认提醒档（block 未开）维持静默 fail-open（exit 0、stderr 为空）。
// 纪律：仅 node: 内置模块；tmp 项目夹具，零真机触达。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'post-tool-use.mjs');

/** 造 tmp 项目：内部治理状态 + 内部治理状态 声明 内部规格；返回项目根与受检文件。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dev214-hook-'));
  mkdirSync(join(root, '.sdd'), { recursive: true });
  mkdirSync(join(root, 'specs'), { recursive: true });
  const target = join(root, 'specs', 'x.md');
  writeFileSync(target, '# 规格\n\nR-1 示例\n', 'utf8');
  writeFileSync(join(root, '.sdd', 'project.json'), JSON.stringify({ suiteConfig: '内部治理状态' }), 'utf8');
  writeFileSync(join(root, '.sdd', 'suite.json'), JSON.stringify({
    schemaVersion: 1,
    suiteRoot: '..',
    documents: [{ path: '内部规格' }],
  }), 'utf8');
  return { root, target };
}

function runHook(root, target, env) {
  const payload = JSON.stringify({ tool_input: { file_path: target } });
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, ZCODE_PROJECT_DIR: root, ...env },
  });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

test('异常注入：校验器抛错/不可用仍退 0 且 stderr 仅一行提示（内部规则-10）', () => {
  const { root, target } = fixture();
  try {
    // 显式 block 档 + 校验器不可用：阻断未生效必须被看见（恰一行 stderr，仍退 0）
    const blocked = runHook(root, target, {
      SDD_TEST_VALIDATOR_BROKEN: '1',
      ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: 'true',
    });
    assert.equal(blocked.status, 0, '校验器不可用不得阻断编码（exit 0）');
    const lines = blocked.stderr.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `stderr 须恰一行可见化提示，实得 ${lines.length} 行：${blocked.stderr}`);
    assert.ok(lines[0].includes('校验器不可用'), '提示须点名校验器不可用');
    assert.ok(lines[0].includes('SDD_HOOK_BLOCK 阻断本次未生效'), '提示须点名阻断未生效（H-7）');

    // 默认提醒档（block 未开启）：静默 fail-open（无 stderr）；显式清空 block env 防宿主继承泄漏
    const silent = runHook(root, target, { SDD_TEST_VALIDATOR_BROKEN: '1', ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: '' });
    assert.equal(silent.status, 0, '默认档异常一律静默退 0');
    assert.equal(silent.stderr.trim(), '', '默认档不得输出提示（静默 fail-open）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E01（内部任务-241）：有诊断时 stdout 为完整可解析信封且退出码 0（写后 exit 截断回归）', () => {
  const { root, target } = fixture();
  try {
    // 触发文档级诊断（TODO 禁语，RULE-内部未决-001 族）→ hook 须经 additionalContext 注入
    writeFileSync(target, '# 规格\n\nTODO 待办事项\n', 'utf8');
    const r = runHook(root, target, {
      SDD_TEST_VALIDATOR_BROKEN: '',
      ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: '',
    });
    assert.equal(r.status, 0, '提醒档不阻断');
    const out = r.stdout.trim();
    assert.ok(out.length > 0, '有诊断时须输出注入信封');
    const parsed = JSON.parse(out); // 若 stdout 被截断，此处必抛 = 回归红灯
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(String(parsed.hookSpecificOutput.additionalContext).length > 0, '信封含诊断上下文');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
