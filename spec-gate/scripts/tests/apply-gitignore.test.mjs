// 文件：spec-gate/scripts/tests/apply-gitignore.test.mjs
// 描述：apply-gitignore.mjs 接入自动应用测试（内部决策-043/内部规则-17②⑤，内部验收-18）。
//       tmp 夹具自含零真机触达；spawnSync argv 驱动（禁 shell 管道，AGENTS GBK 教训）；
//       库级直测断言承载稳定红绿（纯函数面）＋CLI 端到端面（退出码/文件形态/报告）。
// 作者：wangp  创建：2026-10-14  版权：MIT（见 spec-gate/LICENSE）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SECTION_HEADER,
  TEMPLATE_PATH,
  _testInternals,
  dominantEol,
  planMerge,
  subjectOf,
  templateActiveLines,
} from '../apply-gitignore.mjs';

const SCRIPT = fileURLToPath(new URL('../apply-gitignore.mjs', import.meta.url));
const TMP_REAL = realpathSync(tmpdir());
const ROOTS = [];

function mkProject(withGit = false) {
  const dir = realpathSync(mkdtempSync(join(TMP_REAL, 'apply-gitignore-')));
  ROOTS.push(dir);
  if (withGit) mkdirSync(join(dir, '.git'));
  return dir;
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runJson(project, extra = []) {
  const r = run(['--project', project, '--format', 'json', ...extra]);
  return { ...r, report: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

after(() => {
  for (const dir of ROOTS) {
    if (dir.startsWith(TMP_REAL) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('库级纯函数（稳定红绿承载面）', () => {
  test('templateActiveLines：注释/空行过滤＋保序去重＋CRLF 容忍', () => {
    assert.deepEqual(templateActiveLines('# c\n\n.sdd/*\r\n.sdd/*\n!内部治理状态\n'), [
      '.sdd/*',
      '!内部治理状态',
    ]);
  });

  test('subjectOf：剥 ! 前缀与尾部 *与/', () => {
    assert.equal(subjectOf('/.workflow/*'), '/.workflow');
    assert.equal(subjectOf('/.workflow/'), '/.workflow');
    assert.equal(subjectOf('!内部治理状态'), '内部治理状态');
    assert.equal(subjectOf('__pycache__/'), '__pycache__');
  });

  test('dominantEol：CRLF 计数胜出，否则（含平局与无换行）LF', () => {
    assert.equal(dominantEol('a\r\nb\r\nc\n'), '\r\n');
    assert.equal(dominantEol('a\nb\r\nc\n'), '\n');
    assert.equal(dominantEol('no-newline'), '\n');
  });

  test('planMerge 四态：create/append/noop/conflict＋否定行顺序反转', () => {
    const tpl = '# h\n/.workflow/*\n.sdd/*\n';
    assert.equal(planMerge(tpl, null).action, 'create');
    const append = planMerge(tpl, '.sdd/*\nmy-own\n');
    assert.equal(append.action, 'append');
    assert.deepEqual(append.missing, ['/.workflow/*']);
    assert.deepEqual(append.existing, ['.sdd/*']);
    assert.equal(planMerge(tpl, '.sdd/*\n/.workflow/*\n').action, 'noop');
    const conflict = planMerge(tpl, '/.workflow/\n');
    assert.equal(conflict.action, 'conflict');
    assert.deepEqual(conflict.conflicts, [
      { templateLine: '/.workflow/*', targetLine: '/.workflow/' },
    ]);
    // 否定行顺序反转（内部未决-17 同族）：目标只含否定行、缺排除行 → conflict 不追加
    const negation = planMerge(tpl, '!/内部工作流状态\n');
    assert.equal(negation.action, 'conflict');
    assert.deepEqual(negation.conflicts, [
      { templateLine: '/.workflow/*', targetLine: '!/内部工作流状态' },
    ]);
  });

  test('模板文件本体：活行恰 10 条、含 内部未决-76 形态两行与 内部决策-045 维护者注册表否定行', () => {
    const active = templateActiveLines(readFileSync(TEMPLATE_PATH, 'utf8'));
    assert.equal(active.length, 10);
    assert.ok(active.includes('/.workflow/*'));
    assert.ok(active.includes('!/内部工作流状态'));
    assert.ok(active.includes('!/内部工作流状态'));
    // 内部任务-214 批 2（内部验收-4）：忽略面合取直证——`.sdd/*` 排除 + 三配置白名单（tracked 半句不在此断言面，内部未决-195）
    assert.ok(active.includes('.sdd/*'), '模板须含 .sdd/* 排除行');
    for (const whitelisted of ['!内部治理状态', '!内部治理状态', '!内部治理状态']) {
      assert.ok(active.includes(whitelisted), `模板须含 .sdd 配置白名单：${whitelisted}`);
    }
    assert.ok(!active.some((line) => line.includes('delivery-profile.json')), '模板不得自行白名单 delivery-profile（tracked 半句归 内部未决-195 裁决）');
  });

  test('init 命令接线步在位：commands/init.md 含 apply-gitignore 调用（内部规则-17③ 机械背书——三维评审 C3）', () => {
    const initMd = readFileSync(
      fileURLToPath(new URL('../../commands/init.md', import.meta.url)),
      'utf8',
    );
    assert.ok(initMd.includes('apply-gitignore.mjs'), '/spec-gate:init 须含应用脚本调用步（误删接线步本用例即红）');
    assert.ok(initMd.includes('--dry-run'), '接线步须含 dry-run 预览说明');
  });
});

describe('CLI 端到端（tmp 夹具）', () => {
  test('新建：无 .gitignore → 退 0＋创建（全部活行在位、LF）', () => {
    const p = mkProject(true);
    const r = runJson(p);
    assert.equal(r.status, 0);
    assert.equal(r.report.action, 'create');
    assert.equal(r.report.written, true);
    const text = readFileSync(join(p, '.gitignore'), 'utf8');
    assert.ok(!text.includes('\r\n'), '新建文件须 LF');
    for (const line of r.report.appended) assert.ok(text.split('\n').some((l) => l.trim() === line));
  });

  test('幂等：二次运行零改动退 0（noop、文件字节一致）', () => {
    const p = mkProject(true);
    assert.equal(run(['--project', p]).status, 0);
    const before = readFileSync(join(p, '.gitignore'), 'utf8');
    const r2 = runJson(p);
    assert.equal(r2.status, 0);
    assert.equal(r2.report.action, 'noop');
    assert.equal(r2.report.written, false);
    assert.equal(readFileSync(join(p, '.gitignore'), 'utf8'), before);
  });

  test('追加缺失行：已有字节零改动、缺失行在节头下、节头唯一', () => {
    const p = mkProject(true);
    writeFileSync(join(p, '.gitignore'), 'my-own\n.sdd/*\n', 'utf8');
    const r = runJson(p);
    assert.equal(r.status, 0);
    assert.equal(r.report.action, 'append');
    const text = readFileSync(join(p, '.gitignore'), 'utf8');
    assert.ok(text.startsWith('my-own\n.sdd/*\n'), '已有字节零改动（前缀保持）');
    assert.ok(text.includes(SECTION_HEADER), '节头注释在位');
    assert.equal(text.split('\n').filter((l) => l.trim() === SECTION_HEADER).length, 1);
  });

  test('节头判重：目标已含节头时只追加缺行、节头唯一', () => {
    const p = mkProject(true);
    writeFileSync(join(p, '.gitignore'), `${SECTION_HEADER}\n.sdd/*\n`, 'utf8');
    const r = runJson(p);
    assert.equal(r.status, 0);
    assert.equal(r.report.action, 'append');
    const text = readFileSync(join(p, '.gitignore'), 'utf8');
    assert.equal(
      text.split('\n').filter((l) => l.trim() === SECTION_HEADER).length,
      1,
      '节头已在位时不得重复写入（hasHeader 分支）',
    );
    assert.ok(text.includes('/.workflow/*'));
  });

  test('EOL 跟随：CRLF 主导的目标追加行用 CRLF', () => {
    const p = mkProject(true);
    writeFileSync(join(p, '.gitignore'), 'my-own\r\n.sdd/*\r\n', 'utf8');
    assert.equal(run(['--project', p]).status, 0);
    const text = readFileSync(join(p, '.gitignore'), 'utf8');
    const tail = text.slice(text.indexOf(SECTION_HEADER));
    assert.ok(tail.includes('\r\n'), '追加块跟随 CRLF');
    assert.ok(text.startsWith('my-own\r\n.sdd/*\r\n'), '已有字节零改动');
  });

  test('非 git 警示：无 .git → warning 非空且退 0 照常写入；有 .git → warning null', () => {
    const p = mkProject(false);
    const r = runJson(p);
    assert.equal(r.status, 0);
    assert.equal(r.report.gitRepo, false);
    assert.ok(r.report.warning && r.report.warning.includes('git'));
    const p2 = mkProject(true);
    assert.equal(runJson(p2).report.warning, null);
  });

  test('语义冲突：既有 /.workflow/ 目录旧形态 → 退 1＋conflicts 列表＋零写入', () => {
    const p = mkProject(true);
    const before = '/.workflow/\nmy-own\n';
    writeFileSync(join(p, '.gitignore'), before, 'utf8');
    const r = runJson(p);
    assert.equal(r.status, 1);
    assert.equal(r.report.action, 'conflict');
    assert.deepEqual(r.report.conflicts, [
      { templateLine: '/.workflow/*', targetLine: '/.workflow/' },
    ]);
    assert.equal(r.report.written, false);
    assert.equal(readFileSync(join(p, '.gitignore'), 'utf8'), before, '冲突时零写入');
  });

  test('否定行顺序反转：目标已含 !/内部工作流状态 而缺排除行 → 退 1 零写入（防静默吞否定行，内部未决-17 同族）', () => {
    const p = mkProject(true);
    const before = '!/内部工作流状态\nmy-own\n';
    writeFileSync(join(p, '.gitignore'), before, 'utf8');
    const r = runJson(p);
    assert.equal(r.status, 1);
    assert.equal(r.report.action, 'conflict');
    assert.deepEqual(r.report.conflicts, [
      { templateLine: '/.workflow/*', targetLine: '!/内部工作流状态' },
    ]);
    assert.equal(readFileSync(join(p, '.gitignore'), 'utf8'), before, '冲突时零写入');
  });

  test('dry-run：目标缺失不建文件；有缺失行不写字节、报告枚举将写行', () => {
    const p = mkProject(true);
    const r = runJson(p, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.equal(r.report.action, 'create');
    assert.equal(r.report.written, false);
    assert.ok(!existsSync(join(p, '.gitignore')), 'dry-run 不建文件');
    writeFileSync(join(p, '.gitignore'), '.sdd/*\n', 'utf8');
    const r2 = runJson(p, ['--dry-run']);
    assert.equal(r2.report.action, 'append');
    assert.equal(r2.report.written, false);
    assert.ok(r2.report.appended.includes('/.workflow/*'));
    assert.equal(readFileSync(join(p, '.gitignore'), 'utf8'), '.sdd/*\n');
  });

  test('text 格式输出含动作行与可选 docs 段提示', () => {
    const p = mkProject(true);
    const r = run(['--project', p]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('apply-gitignore: create'));
    assert.ok(r.stdout.includes('docs/*'), 'text 报告含可选 docs 段提示（内部未决-17 教训传导面）');
  });

  test('坏参数与坏目标：--format xml／未知旗标／--project 缺值／--format 缺值／不存在目录均退 2', () => {
    const p = mkProject(true);
    assert.equal(run(['--project', p, '--format', 'xml']).status, 2);
    assert.equal(run(['--project', p, '--nope']).status, 2);
    assert.equal(run(['--project']).status, 2, '--project 缺值须退 2');
    assert.equal(run(['--project', p, '--format']).status, 2, '--format 尾部缺值须退 2');
    assert.equal(run(['--project', join(p, 'no-such-dir')]).status, 2);
  });

  test('S06/E09（内部任务-241）：目标 .gitignore 为符号链接 → 退 2 且目标文件零改动', (t) => {    const p = mkProject(true);
    const outside = join(p, 'outside-target.txt');
    writeFileSync(outside, 'do-not-touch\n', 'utf8');
    try {
      symlinkSync(outside, join(p, '.gitignore'));
    } catch {
      t.skip('当前平台不支持创建符号链接（Windows 未提权）');
      return;
    }
    const r = run(['--project', p]);
    assert.equal(r.status, 2, '符号链接目标须退工具错误（拒绝跟随写入）');
    assert.ok(r.stderr.includes('符号链接'), `stderr 须点名符号链接：${r.stderr}`);
    assert.equal(readFileSync(outside, 'utf8'), 'do-not-touch\n', '链接目标不得被写入');
  });

  test('内部缝（内部任务-241 覆盖率）：原子写失败清理临时件＋入口判定异常可见', () => {
    const dir = mkProject(true);
    // 目标父目录不存在 → writeFileSync 抛 ENOENT，catch 清理临时件后原样上抛
    assert.throws(() => _testInternals.atomicWriteFile(join(dir, 'no-such-sub', 'x'), 'y'), /ENOENT|no such file/i);
    // 入口判定 realpath 失败 → false 且 exitCode=EXIT_TOOL（2）
    const oldArgv1 = process.argv[1];
    const oldCode = process.exitCode;
    process.argv[1] = join(dir, 'missing-entry.mjs');
    try {
      assert.equal(_testInternals.isMainEntry(), false);
      assert.equal(process.exitCode, 2, '入口判定异常须置工具错误退出码');
    } finally {
      process.argv[1] = oldArgv1;
      process.exitCode = oldCode;
    }
  });

  test('内部缝（内部任务-242 §四-4）：parseArgs 分支矩阵', () => {
    assert.deepEqual(
      _testInternals.parseArgs(['--project', 'p', '--dry-run', '--format', 'json']),
      { project: 'p', dryRun: true, format: 'json' },
    );
    assert.throws(() => _testInternals.parseArgs(['--nope']), /未知参数/);
    assert.throws(() => _testInternals.parseArgs(['--project']), /--project 缺值/);
    assert.throws(() => _testInternals.parseArgs(['--project', '--dry-run']), /--project 缺值/);
    assert.throws(() => _testInternals.parseArgs(['--format']), /--format 仅支持/);
    assert.throws(() => _testInternals.parseArgs(['--format', 'xml']), /--format 仅支持/);
  });

  test('内部缝（内部任务-242 §四-4）：guardTargetSymlink 拒绝链接＋safeRun 兜底可见', (t) => {
    const dir = mkProject(true);
    const plain = join(dir, '.gitignore');
    writeFileSync(plain, 'x', 'utf8');
    _testInternals.guardTargetSymlink(plain); // 普通文件不抛
    _testInternals.guardTargetSymlink(join(dir, 'missing-file')); // 不存在不抛（main 侧仅 hasTarget 时调用）
    const outside = join(dir, 'outside-guard.txt');
    writeFileSync(outside, 'o', 'utf8');
    const link = join(dir, 'link-target');
    try {
      symlinkSync(outside, link);
    } catch {
      t.skip('当前平台不支持创建符号链接（Windows 未提权）');
      return;
    }
    assert.throws(() => _testInternals.guardTargetSymlink(link), /符号链接/);

    const oldCode = process.exitCode;
    const origWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
      _testInternals.safeRun(() => {
        const e = new Error('注入故障：boom');
        e.code = 'EIO';
        throw e;
      });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(process.exitCode, 2, 'safeRun 未预期异常须置工具错误退出码');
    assert.match(captured, /未预期错误/, '兜底须输出可见文案');
    process.exitCode = oldCode;
  });
});
