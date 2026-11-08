// 文件：git-fixtures.mjs
// 描述：revision/receipts/delivery 实现（唯一实现；迁移史见 内部决策-051）测试共享 git 夹具（内部决策-051 阶段2 凭据链；永久件）——
//       `git()` 数组参数（禁 shell 拼接）、`initRepo`（pin user.email/user.name/
//       commit.gpgsign=false/core.autocrlf=false/core.fileMode=true，外部签名/行尾/模式位
//       配置不得使夹具假红）、`suiteWith`/`makeGitProject`/`makeGitProjectWithReceipts`/
//       `commitAll`/`currentHead`。形态对齐 spec-gate/assurance/tests/test_revision.py 的
//       `_make_git_project`/`_make_git_project_with_receipts`/`_commit_all`；两侧读同一 tmp 仓。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 夹具 git 命令超时（Python 侧 subprocess.run 无显式超时；夹具只做本地小仓操作，60s 足够）。 */
const GIT_TIMEOUT_MS = 60_000;

/**
 * 在 `cwd` 执行 git（数组参数，禁 shell 拼接）；非零/超时/异常抛错，返回 stdout 文本。
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（status=${r.status}）：${String(r.stderr ?? '')}${r.error ? r.error.message : ''}`);
  }
  return r.stdout;
}

/**
 * 与 `git()` 同语义但接受原始 stdin 字节（raw 路径/plumbing 用；输出保持 Buffer）：
 * 供无效 UTF-8 路径等无法经字符串 argv 承载的夹具形态。非零/异常抛错。
 * @param {string} cwd
 * @param {string[]} args
 * @param {Buffer} input
 * @returns {{status: number|null, stdout: Buffer, stderr: Buffer}}
 */
export function gitRaw(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（status=${r.status}）：${String(r.stderr ?? '')}${r.error ? r.error.message : ''}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * 初始化仓库并 pin 夹具配置（对齐 test_revision.py 的 `_make_git_project` 与 2.0 夹具补丁）。
 * @param {string} proj
 * @returns {void}
 */
export function initRepo(proj) {
  git(proj, 'init', '-q');
  git(proj, 'config', 'user.email', 't@example.com');
  git(proj, 'config', 'user.name', 't');
  git(proj, 'config', 'commit.gpgsign', 'false');
  git(proj, 'config', 'core.autocrlf', 'false');
  git(proj, 'config', 'core.fileMode', 'true');
}

/**
 * 构造仅登记一份规格文档的 suite 配置文本（对齐 test_revision.py `_suite_with`）。
 * @param {string} path
 * @returns {string}
 */
export function suiteWith(path) {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    suiteRoot: '..',
    validationRoots: ['specs'],
    documents: [{ path, documentType: 'requirement-baseline', validationMode: 'draft' }],
  });
}

/**
 * 构造带一次提交的最小 git 项目：src/app.py + 内部规格 + 内部计划 + 内部治理状态。
 * @param {string} base
 * @returns {string} 项目根（base/proj）
 */
export function makeGitProject(base) {
  const proj = join(base, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'specs'), { recursive: true });
  mkdirSync(join(proj, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(proj, '.sdd'), { recursive: true });
  writeFileSync(join(proj, 'src', 'app.py'), "print('v1')\n", 'utf8');
  writeFileSync(join(proj, 'specs', 'x.md'), '---\ndocumentType: requirement-baseline\n---\n# X\n', 'utf8');
  writeFileSync(join(proj, 'docs', 'plans', 'p.md'), '---\nspecRefs: [FR-wf-1]\n---\n# 计划\n', 'utf8');
  writeFileSync(join(proj, '.sdd', 'suite.json'), suiteWith('specs/x.md'), 'utf8');
  initRepo(proj);
  git(proj, 'add', '-A', '--force', '.');
  git(proj, 'commit', '-q', '-m', 'init');
  return proj;
}

/**
 * 构造「运行态产物已被跟踪」的最小 git 项目（消费仓的真实形态）：
 * `_make_git_project` 之后补 `内部治理状态` 并提交。
 * @param {string} base
 * @returns {string}
 */
export function makeGitProjectWithReceipts(base) {
  const proj = makeGitProject(base);
  const receipts = join(proj, '.sdd', 'receipts', 'T1');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, 'verification-T1-1.json'), '{}\n', 'utf8');
  git(proj, 'add', '-A', '--force');
  git(proj, 'commit', '-q', '-m', 'track runtime artifacts');
  return proj;
}

/**
 * 提交当前工作树全部改动（含被忽略路径的 `--force` 纳入），返回新 HEAD。
 * @param {string} proj
 * @param {string} message
 * @returns {string}
 */
export function commitAll(proj, message) {
  git(proj, 'add', '-A', '--force');
  git(proj, 'commit', '-q', '-m', message);
  return currentHead(proj);
}

/**
 * 读当前 HEAD（独立助手，避免测试里重复 subprocess 细节）。
 * @param {string} proj
 * @returns {string}
 */
export function currentHead(proj) {
  return git(proj, 'rev-parse', 'HEAD').trim();
}
