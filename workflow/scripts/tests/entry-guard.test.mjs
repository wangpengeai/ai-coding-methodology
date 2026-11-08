// 文件：entry-guard.test.mjs
// 描述：钩子入口守卫的路径形态归一回归（内部任务-GUARDSYML-1，2026-09-30）——ESM 默认按
//       realpath 解析主模块，argv[1] 为 symlink 别名形态时守卫字符串级比对恒 false，
//       钩子整体静默 no-op（护栏不拦、闸不挡、selftest 空输出假绿）。四断言：
//       ① 行为面：别名形态驱动的 check-freeze 须真跑出 deny；② 行为面：别名形态
//       --selftest 须真输出；③ 字面漂移守卫：凡含 invokedDirectly 的钩子必须带
//       realpathSync 归一（防后续新钩漏带）；④ CLI 面字面漂移守卫（内部未决-52，内部任务-44）：
//       八处 scripts/CLI 直跑入口同须归一。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）；不 mock 被测脚本本体。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
// 公开包守卫（内部任务-365）：仓级 scripts/ 未随公开包发布；源仓资产在位时照常执行。
const HAS_REPO_SCRIPTS = existsSync(join(HOOKS_DIR, '..', '..', 'scripts', 'verify-core-baseline.mjs'));

/** symlink 可用性一次性探测：Windows 无开发者模式/管理员时 symlinkSync 抛 EPERM——
 * 守卫归一是平台特定缺陷（macOS /var symlink 形态分裂），其余平台缺陷面不存在，
 * 行为用例声明式 skip 不构成漏测（对齐 task-lease.test.mjs CAN_SYMLINK 先例，
 * 内部任务-MACKEY-1 同族；收尾评审 2026-09-30 处置：裸 return 会以 pass 面目计入汇总，
 * 与本文件要消灭的假绿形态同构）。 */
const CAN_SYMLINK = (() => {
  try {
    const probe = join(tmpdir(), `entryguard-probe-${process.pid}`);
    mkdirSync(probe);
    const alias = `${probe}-alias`;
    symlinkSync(probe, alias);
    rmSync(alias, { force: true });
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

/**
 * 对目标钩子建 symlink 别名（别名目录在 os.tmpdir 下，测试结束由调用方清理）。
 * 仅在 CAN_SYMLINK 为真时调用（用例以 skip 选项拦截）。
 * @param {string} target 目标钩子绝对路径
 * @param {string} name 别名文件名
 * @returns {string} 别名文件路径
 */
function aliasTo(target, name) {
  const dir = mkdtempSync(join(tmpdir(), 'entryguard-alias-'));
  symlinkSync(target, join(dir, name));
  return join(dir, name);
}

test('守卫归一：symlink 别名形态驱动的 check-freeze 须真跑（deny 而非静默 no-op）', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——守卫形态分裂为平台特定缺陷，该平台缺陷面不存在' }, () => {
  const proj = mkdtempSync(join(tmpdir(), 'entryguard-proj-'));
  const alias = aliasTo(join(HOOKS_DIR, 'check-freeze.mjs'), 'check-freeze.mjs');
  try {
    mkdirSync(join(proj, 'docs'), { recursive: true });
    writeFileSync(join(proj, '.workflow-freeze'), '# 声明\ndocs/*\n');
    writeFileSync(join(proj, 'docs', 'a.md'), '# 占位\n');
    const r = spawnSync(process.execPath, [alias], {
      input: JSON.stringify({ tool_input: { file_path: join(proj, 'docs', 'a.md') }, cwd: proj }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, '别名形态下守卫须判直跑（deny 退出 2）；status 0 零输出即守卫失效');
    assert.match(String(r.stdout), /命中冻结声明/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(dirname(alias), { recursive: true, force: true });
  }
});

test('守卫归一：别名形态 --selftest 须真输出（防静默假绿）', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——守卫形态分裂为平台特定缺陷，该平台缺陷面不存在' }, () => {
  const alias = aliasTo(join(HOOKS_DIR, 'check-careful.mjs'), 'check-careful.mjs');
  try {
    const r = spawnSync(process.execPath, [alias, '--selftest'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'selftest 本体须全过');
    assert.match(String(r.stdout), /PASS|OK/, '别名形态下 selftest 须真跑出结果行（no-op 时 stdout 为空=假绿）');
  } finally {
    rmSync(dirname(alias), { recursive: true, force: true });
  }
});

test('字面漂移守卫：凡含 invokedDirectly 的钩子必须带 realpathSync 归一', () => {
  const hooks = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of hooks) {
    const text = readFileSync(join(HOOKS_DIR, f), 'utf8');
    if (!text.includes('invokedDirectly')) continue;
    if (!/realpathSync\(process\.argv\[1\]\)/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `入口守卫缺 realpath 归一的钩子：${offenders.join(', ')}`);
});

// 内部未决-52（内部任务-44）：CLI 面守卫归一——直跑入口（mcode-adapter/cli.mjs 不在清单：经核证其
// 自 2026-10-01 起已是 realpathSync 归一形态〔:479-489〕，无需改动，终审发现 1 更正原「残余」误记）。
// 内部任务-244 Q01：交付两 CLI（deliver-lint/deliver-export）并入清单（原 resolve 字符串比对在
// symlink 别名形态下静默 no-op）。
test('字面漂移守卫（CLI 面，OPEN-52）：清单内全部直跑入口必须带 realpath 归一（或经 cli-main 单源 isMainModule）', { skip: HAS_REPO_SCRIPTS ? false : '公开包不含仓级 scripts/（源仓照跑）' }, () => {
  const REPO = join(HOOKS_DIR, '..', '..');
  const files = [
    'workflow/scripts/incident-cli.mjs',
    'workflow/scripts/mechanical-edit.mjs',
    'workflow/scripts/evidence-gen.mjs',
    'workflow/scripts/deliver-lint.mjs',
    'workflow/scripts/deliver-export.mjs',
    'zcode-adapter/cli.mjs',
    'scripts/verify-core-baseline.mjs',
    'scripts/repair-session-injection-id.mjs',
    'scripts/lib/public-metadata.mjs',
    'scout/scripts/mode-state.mjs',
    'scout/scripts/check-consistency.mjs',
    'scout/scripts/mode-lifecycle.mjs',
  ];
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    const literalGuard = /realpathSync\(process\.argv\[1\]\)/.test(text);
    // 内部任务-259 步骤 6：scout 三脚本入口守卫收敛到 cli-main.isMainModule（realpath 归一仍在共享原语内）
    const sharedGuard = /isMainModule\(import\.meta\.url\)/.test(text) && /from '\.\/cli-main\.mjs'/.test(text);
    if (!literalGuard && !sharedGuard) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `入口守卫缺 realpath 归一的 CLI：${offenders.join(', ')}`);
});

test('DEV-244 Q01：symlink 别名直跑 deliver-lint --selftest 须真执行', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——该平台缺陷面不存在' }, () => {
  const REPO = join(HOOKS_DIR, '..', '..');
  const alias = aliasTo(join(REPO, 'workflow', 'scripts', 'deliver-lint.mjs'), 'deliver-lint.mjs');
  try {
    const r = spawnSync(process.execPath, [alias, '--selftest'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `别名形态 --selftest 须退 0（实得 ${r.status}：${r.stderr}）`);
    assert.match(String(r.stdout), /selftest|OK|PASS/, '别名形态下 selftest 须真跑（no-op 时 stdout 为空=假绿）');
  } finally {
    rmSync(dirname(alias), { recursive: true, force: true });
  }
});
