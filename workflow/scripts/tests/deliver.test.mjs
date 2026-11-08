// 文件：deliver.test.mjs
// 描述：保密交付（内部决策-062 / 内部任务-186）测试矩阵——双配置 schema、白名单投影与最小对账、
//       用户自选保密规则（含否证：零内置词表）、悬空引用四形态与移除文档直查（恒 blocking）、
//       manifest/许可完整性、全新 git 历史/确定性/失败原子性/源仓只读、CLI 退出码与 --selftest。
//       所有夹具在 tmp 内自建（零真机写面）；用例标题逐字含 内部模块-26 §6 的锚片段（内部验收-1..6）。
// 作者：wangp  创建：2026-10-23  版权：MIT（见 workflow/LICENSE）
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RULES,
  buildManifest,
  gitHistoryFingerprint,
  loadConfigs,
  sourceSnapshot,
  walkFiles,
} from '../lib/delivery-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ROOT = resolve(HERE, '..', '..');
const EXPORT_CLI = join(WORKFLOW_ROOT, 'scripts', 'deliver-export.mjs');
const LINT_CLI = join(WORKFLOW_ROOT, 'scripts', 'deliver-lint.mjs');

/** 建一个临时项目根。 */
function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `deliver-${prefix}-`));
}

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

const BASE_CONTRACT = {
  schemaVersion: 1,
  contract: { id: 'C-186', party: '示例甲方公司', deliveryDate: '2026-10-23' },
  items: [
    { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true, audience: 'external' },
    { id: 'D-2', kind: 'file', source: 'docs/guide.md', target: 'docs/guide.md', required: true, audience: 'external' },
    { id: 'D-3', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false, audience: 'external' },
  ],
  generated: [
    { id: 'G-1', generator: 'delivery-report', required: true },
    { id: 'G-2', generator: 'manifest', required: true },
  ],
  acceptance: [{ contractRequirement: 'CR-1', criterion: '构建命令退出 0', result: 'passed', summary: '示例验收通过，产物哈希见清单' }],
  thirdParty: [{ name: '示例组件', license: 'MIT' }],
  audit: { enabled: false },
  git: { freshHistory: true, author: 'Delivery Bot <delivery@example.invalid>', commitMessage: 'Initial delivery' },
};

const BASE_POLICY = {
  schemaVersion: 1,
  internal: { pathPatterns: ['docs/plans/**', 'specs/**', '.sdd/**'], idPatterns: ['\\bDEV-\\d+\\b'], termPatterns: [] },
  dangling: { allowExternal: true, allowPatterns: [] },
  scan: { extensions: ['.md', '.txt', '.html', '.json'], exclude: [] },
  license: { requireLicenseFile: true, requiredFields: ['name', 'license'] },
  visibility: { overrides: {} },
};

/** 建一个样例内部项目（可覆盖 contract/policy/附加文件）。 */
function makeProject(prefix = 'proj', { contract = {}, policy = {}, files = {}, initGit = false } = {}) {
  const root = makeTmp(prefix);
  const mergedContract = { ...BASE_CONTRACT, ...contract };
  const mergedPolicy = { ...BASE_POLICY, ...policy };
  write(root, '.deliver/contract.json', `${JSON.stringify(mergedContract, null, 2)}\n`);
  write(root, '.deliver/policy.json', `${JSON.stringify(mergedPolicy, null, 2)}\n`);
  write(root, 'README.md', '# 示例交付\n\n参见 [使用指南](docs/guide.md)。\n');
  write(root, 'docs/guide.md', '# 使用指南\n\n返回 [项目说明](../README.md)。\n');
  write(root, 'LICENSE', 'MIT License\n\n示例许可证文本。\n');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  if (initGit) {
    const g = (...args) => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    g('init', '-q');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.invalid');
    write(root, 'README.md', '# 示例交付\n\n参见 [使用指南](docs/guide.md)。\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'internal commit 内部任务-1 should never leak');
  }
  return root;
}

function execNode(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function exportPkg(project, out, extra = []) {
  return execNode([EXPORT_CLI, '--project-root', project, '--out', out, ...extra]);
}

function lintPkg(project, pkg, extra = []) {
  return execNode([LINT_CLI, '--project-root', project, '--package', pkg, ...extra]);
}

/** 包内文件内容快照（排除 .git；确定性比较用）。 */
function packageContentSnapshot(pkg) {
  const out = {};
  for (const rel of walkFiles(pkg)) {
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    out[rel] = readFileSync(join(pkg, rel)).toString('base64');
  }
  return out;
}

function cleanup(...roots) {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

test('cfg-policy-contract-schema：双配置 schema 正负例与未知字段拒绝', () => {
  const root = makeProject('schema');
  try {
    const loaded = loadConfigs(root);
    assert.equal(loaded.contract.contract.id, 'C-186');
    assert.equal(loaded.policy.schemaVersion, 1);

    // 缺 contract → exit 2
    const noContract = makeTmp('schema-missing');
    mkdirSync(join(noContract, '.deliver'), { recursive: true });
    writeFileSync(join(noContract, '.deliver', 'policy.json'), `${JSON.stringify(BASE_POLICY)}\n`);
    const r1 = exportPkg(noContract, join(noContract, 'out'));
    assert.equal(r1.status, 2, `缺 contract 应 exit 2：${r1.stderr}`);
    cleanup(noContract);

    // 坏 JSON → exit 2
    write(root, '.deliver/contract.json', '{ bad json');
    const r2 = exportPkg(root, join(root, 'out'));
    assert.equal(r2.status, 2, `坏 JSON 应 exit 2：${r2.stderr}`);

    // schemaVersion 非 1 → exit 2
    write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, schemaVersion: 2 })}\n`);
    const r3 = exportPkg(root, join(root, 'out'));
    assert.equal(r3.status, 2, `schemaVersion≠1 应 exit 2：${r3.stderr}`);

    // policy 出现被取代字段 dangling.mode → 未知字段拒绝（内部决策-062 修正案 1）
    write(root, '.deliver/contract.json', `${JSON.stringify(BASE_CONTRACT)}\n`);
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, dangling: { ...BASE_POLICY.dangling, mode: 'report' } })}\n`);
    const r4 = exportPkg(root, join(root, 'out'));
    assert.equal(r4.status, 2, `dangling.mode 应作为未知字段拒绝：${r4.stderr}`);

    // 空内部规则且未 ack → exit 2；带 ack → 可载入（否证基础）
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: [], idPatterns: [], termPatterns: [] } })}\n`);
    assert.equal(exportPkg(root, join(root, 'out')).status, 2, '空内部规则未确认应 exit 2');
    write(
      root,
      '.deliver/policy.json',
      `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: [], idPatterns: [], termPatterns: [] }, acknowledgeNoInternalRules: { reason: '本合同交付面无需内部规则（显式确认）' } })}\n`,
    );
    assert.equal(loadConfigs(root).policy.acknowledgeNoInternalRules.reason.length >= 8, true);
  } finally {
    cleanup(root);
  }
});

test('projection-whitelist-minimality：白名单投影与最小交付对账', () => {
  const root = makeProject('whitelist');
  const out = join(makeTmp('whitelist-out'), 'pkg');
  try {
    const r = exportPkg(root, out, ['--no-git']);
    assert.equal(r.status, 0, `导出应成功：${r.stdout}${r.stderr}`);
    const pkgFiles = walkFiles(out).sort();
    assert.deepEqual(pkgFiles, ['DELIVERY-REPORT.md', 'LICENSE', 'MANIFEST.sha256.json', 'README.md', 'docs/guide.md']);
    assert.ok(!existsSync(join(out, 'specs')), '内部目录不得进入交付包');

    // 未声明文件 → unlisted-file
    write(out, 'extra.txt', 'not declared\n');
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const rLint = lintPkg(root, out, ['--json']);
    assert.equal(rLint.status, 1);
    assert.match(rLint.stdout, new RegExp(RULES.UNLISTED));

    // required 条目无产出 → 导出 exit 1 且报 contract-missing-item
    const badRoot = makeProject('missing');
    write(badRoot, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [...BASE_CONTRACT.items, { id: 'D-9', kind: 'file', source: 'not-there.md', required: true }] })}\n`);
    const badOut = join(makeTmp('missing-out'), 'pkg');
    const r2 = exportPkg(badRoot, badOut);
    assert.equal(r2.status, 1, `缺 required 产出应 exit 1：${r2.stderr}`);
    assert.match(`${r2.stdout}${r2.stderr}`, /contract-missing-item/);
    assert.ok(!existsSync(badOut), '失败不得产出 --out');

    // 内部路径作为 CDM 来源 → 导出 exit 1（internal-artifact-present）
    const internalRoot = makeProject('internal');
    write(internalRoot, '内部规格', '# 内部规格\n');
    write(internalRoot, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: '内部规格', required: true }] })}\n`);
    const r3 = exportPkg(internalRoot, join(makeTmp('internal-out'), 'pkg'));
    assert.equal(r3.status, 1);
    assert.match(`${r3.stdout}${r3.stderr}`, /internal-artifact-present/);

    // 符号链接逃逸源仓 → 拒绝（realpath 裁决）。夹具目标用 tmp 内真实文件而非 POSIX
    // 字面路径 /etc/hosts：后者在 win32 下按当前盘符解析为不存在目标，来源匹配在 realpath
    // 判定前即失败（本用例实测退化为 contract-missing-item 而非 realpath 逃逸；包内两处
    // 夹具则是 buildManifest 读取时 ENOENT；win32 平台裸假设，内部任务-232）。
    const linkRoot = makeProject('symlink');
    const externalRoot = makeTmp('symlink-ext');
    try {
      symlinkSync(write(externalRoot, 'external-hosts.txt', '外部宿主机文件夹具\n'), join(linkRoot, 'escape-link'));
      write(linkRoot, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: 'escape-link', required: true }] })}\n`);
      const r4 = exportPkg(linkRoot, join(makeTmp('symlink-out'), 'pkg'));
      assert.equal(r4.status, 1, `符号链接逃逸应拒绝：${r4.stdout}${r4.stderr}`);
      assert.match(`${r4.stdout}${r4.stderr}`, /internal-artifact-present/);
    } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
    } finally {
      cleanup(linkRoot);
      cleanup(externalRoot);
    }
    cleanup(badRoot, internalRoot);
  } finally {
    cleanup(root);
  }
});

test('policy-user-selectable-rules：用户自选规则生效与零内置否证', () => {
  const itemsWithLicense = [
    { id: 'D-1', kind: 'file', source: 'docs/notice.md', target: 'docs/notice.md', required: true },
    { id: 'D-2', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
  ];
  const root = makeProject('selectable', {
    files: { 'docs/notice.md': '# 公告\n\n内部标识 ACME-777 与术语「内部黑话」出现在此。\n' },
    policy: {
      internal: { pathPatterns: ['specs/**'], idPatterns: ['\\bDEV-\\d+\\b'], termPatterns: [] },
    },
    contract: { items: itemsWithLicense },
  });
  const out = join(makeTmp('selectable-out'), 'pkg');
  try {
    // 否证：policy 未配置 ACME-777 / 内部黑话 → 交付包文字原样通过（证明无内置词表）
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0, '未配置规则时不得拦截（零内置否证）');
    const clean = lintPkg(root, out);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    // 用户配置规则后 → internal-pattern
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: ['specs/**'], idPatterns: ['ACME-\\d+'], termPatterns: ['内部黑话'] } })}\n`);
    const red = lintPkg(root, out);
    assert.equal(red.status, 1);
    assert.match(red.stdout, /internal-pattern/);

    // visibilitySource 的 external 豁免：CUSTOM-1 external 放行、CUSTOM-2 internal 拦截
    write(root, 'docs/notice.md', '# 公告\n\n对外标识 CUSTOM-1 放行；CUSTOM-2 仍为内部。\n');
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: ['specs/**'], idPatterns: ['\\bDEV-\\d+\\b'], termPatterns: [] } })}\n`);
    const out2 = join(makeTmp('selectable-out2'), 'pkg');
    assert.equal(exportPkg(root, out2, ['--no-git']).status, 0);
    write(root, '内部规格', `${JSON.stringify({ schemaVersion: 1, visibility: { default: 'internal', overrides: { 'CUSTOM-1': 'external' } } })}\n`);
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: ['specs/**'], idPatterns: ['CUSTOM-\\d+'], termPatterns: [] }, visibilitySource: '内部规格' })}\n`);
    const mixed = lintPkg(root, out2);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stdout, /CUSTOM-2/);
    assert.doesNotMatch(mixed.stdout, /CUSTOM-1/);

    // ── 内部决策-062 修正案 3：internal.textPathPatterns 文本扫描分面 ──
    // 宽 pathPatterns + 窄 textPathPatterns：包内文本的「通用约定 docs/plans/」不拦，具体内部文档路径拦。
    const facetRoot = makeProject('text-facet', {
      contract: {
        items: [
          { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true },
          { id: 'D-2', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
        ],
      },
    });
    write(facetRoot, 'README.md', '# 示例交付\n\n计划约定见 `docs/plans/` 目录（方法论通用约定）。\n');
    write(facetRoot, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: ['docs/**'], textPathPatterns: ['内部计划**'], idPatterns: [], termPatterns: [] } })}\n`);
    const facetOut = join(makeTmp('text-facet-out'), 'pkg');
    const rf = exportPkg(facetRoot, facetOut, ['--no-git']);
    assert.equal(rf.status, 0, `窄 textPathPatterns 下通用约定不应拦：${rf.stdout}${rf.stderr}`);
    // 窄表命中包内文本中的具体内部文档路径 → 复核失败，且命中标签指向实际分面
    write(facetOut, 'README.md', '# 示例交付\n\n见 内部证据 内部证据。\n');
    writeFileSync(join(facetOut, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(facetOut, loadConfigs(facetRoot).contract, { gitMode: 'none' }), null, 2)}\n`);
    const rfLint = lintPkg(facetRoot, facetOut, ['--json']);
    assert.equal(rfLint.status, 1, `窄表应命中具体内部文档路径：${rfLint.stdout}${rfLint.stderr}`);
    assert.match(rfLint.stdout, /policy\.internal\.textPathPatterns/, '命中标签须指向实际生效的文本分面');
    // 包内路径面恒用 pathPatterns（不随文本分面收窄）：包内 docs/ 路径仍 internal-artifact-present
    write(facetOut, '内部证据', '# x\n');
    writeFileSync(join(facetOut, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(facetOut, loadConfigs(facetRoot).contract, { gitMode: 'none' }), null, 2)}\n`);
    const rfPkg = lintPkg(facetRoot, facetOut, ['--json']);
    assert.equal(rfPkg.status, 1, '包内路径面须恒用 pathPatterns');
    assert.match(rfPkg.stdout, /internal-artifact-present/);
    // CDM 源路径面恒用 pathPatterns：源 specs/ 文件即使在窄文本分面下也拒绝
    const srcRoot = makeProject('text-facet-src', {
      policy: { internal: { pathPatterns: ['specs/**'], textPathPatterns: ['内部计划**'], idPatterns: [], termPatterns: [] } },
      contract: {
        items: [
          { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true },
          { id: 'D-2', kind: 'file', source: '内部规格', required: false },
        ],
      },
    });
    write(srcRoot, '内部规格', '# 内部规格\n');
    const rsrc = exportPkg(srcRoot, join(makeTmp('text-facet-src-out'), 'pkg'), ['--no-git']);
    assert.equal(rsrc.status, 1, `CDM 源路径须恒用 pathPatterns：${rsrc.stdout}${rsrc.stderr}`);
    assert.match(`${rsrc.stdout}${rsrc.stderr}`, /internal-artifact-present/);
    cleanup(srcRoot);
    // 显式空数组回落 pathPatterns（不静默关闭）：docs/ 通用约定被 pathPatterns 拦
    write(facetRoot, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { pathPatterns: ['docs/**'], textPathPatterns: [], idPatterns: [], termPatterns: [] } })}\n`);
    const emptyOut = join(makeTmp('text-facet-empty-out'), 'pkg');
    const re = exportPkg(facetRoot, emptyOut, ['--no-git']);
    assert.equal(re.status, 1, '显式空数组 textPathPatterns 必须回落 pathPatterns（不得静默关闭）');
    // schema 负例：textPathPatterns 非字符串数组 → exit 2
    write(facetRoot, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, internal: { ...BASE_POLICY.internal, textPathPatterns: 'docs/**' } })}\n`);
    assert.equal(exportPkg(facetRoot, join(makeTmp('text-facet-bad-out'), 'pkg'), ['--no-git']).status, 2, 'textPathPatterns 非数组应 exit 2');
    // ── 提交信息/作者面恒用 pathPatterns（不随文本分面收窄）──
    const cmRoot = makeProject('commit-facet', {
      policy: { internal: { pathPatterns: ['specs/**'], textPathPatterns: ['内部计划**'], idPatterns: [], termPatterns: [] } },
      contract: { git: { freshHistory: true, author: 'Delivery Bot <delivery@example.invalid>', commitMessage: 'see 内部规格' } },
    });
    const cmOut = join(makeTmp('commit-facet-out'), 'pkg');
    const rc = exportPkg(cmRoot, cmOut);
    assert.equal(rc.status, 1, `提交信息面须恒用 pathPatterns（不被窄文本面放过）：${rc.stdout}${rc.stderr}`);
    assert.match(`${rc.stdout}${rc.stderr}`, /internal-artifact-present/);
    cleanup(facetRoot, cmRoot);
  } finally {
    cleanup(root);
  }
});

test('dangling-reference-strict：四形态悬空引用与移除文档直查', () => {
  const root = makeProject('dangling');
  const out = join(makeTmp('dangling-out'), 'pkg');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    // 移除被引用文档：guide.md 被 README 引用 → removed-doc-reference
    rmSync(join(out, 'docs/guide.md'));
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const rRemoved = lintPkg(root, out, ['--json']);
    assert.equal(rRemoved.status, 1);
    assert.match(rRemoved.stdout, new RegExp(RULES.REMOVED_DOC));

    // 四形态逐一：inline 链接 / 图片 / 引用式定义 / HTML href·src
    const caseRoot = makeProject('dangling-cases', {
      contract: { items: [{ id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true }] },
      files: {
        'README.md': [
          '# 示例交付',
          '',
          'inline 悬空：[缺失](missing-inline.md)',
          '图片悬空：![缺失](missing-image.png)',
          '[ref]: missing-ref.md',
          'HTML 悬空：<a href="missing-html.html">x</a> <img src="missing-html.png">',
          '外链忽略：https://example.invalid/x 与 [锚](#top)',
          '',
        ].join('\n'),
      },
    });
    const caseOut = join(makeTmp('dangling-cases-out'), 'pkg');
    const rExport = exportPkg(caseRoot, caseOut, ['--no-git']);
    assert.equal(rExport.status, 1, `四形态悬空引用应在导出时被阻断：${rExport.stdout}${rExport.stderr}`);
    const text = `${rExport.stdout}${rExport.stderr}`;
    for (const target of ['missing-inline.md', 'missing-image.png', 'missing-ref.md', 'missing-html.html', 'missing-html.png']) {
      assert.ok(text.includes(target), `应检出悬空引用 ${target}`);
    }
    assert.ok(!text.includes('https://example.invalid'), '外链应豁免');
    assert.ok(!existsSync(caseOut), '被阻断导出不留包');

    // 逃逸根：../outside.md
    write(caseRoot, 'README.md', '# 示例交付\n\n[逃逸](../outside.md)\n');
    const escapeOut = join(makeTmp('escape-out'), 'pkg');
    const rEscape = exportPkg(caseRoot, escapeOut, ['--no-git']);
    assert.equal(rEscape.status, 1);
    assert.match(`${rEscape.stdout}${rEscape.stderr}`, /reference-escapes-root/);
    cleanup(caseRoot);
  } finally {
    cleanup(root);
  }
});

test('manifest-license-integrity：清单与许可完整性', () => {
  const root = makeProject('manifest');
  const out = join(makeTmp('manifest-out'), 'pkg');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    // 哈希漂移
    write(out, 'README.md', '# 被篡改\n');
    const r1 = lintPkg(root, out, ['--json']);
    assert.equal(r1.status, 1);
    assert.match(r1.stdout, new RegExp(RULES.MANIFEST_HASH));
    // manifest 缺失
    rmSync(join(out, 'MANIFEST.sha256.json'));
    const r2 = lintPkg(root, out);
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, new RegExp(RULES.MANIFEST_MISSING));

    // 许可完整性：thirdParty 缺 license 字段 / requireLicenseFile 而无许可文件
    write(out, 'README.md', readFileSync(join(root, 'README.md')).toString());
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const badContract = { ...BASE_CONTRACT, thirdParty: [{ name: '缺许可字段组件' }] };
    write(root, '.deliver/contract.json', `${JSON.stringify(badContract)}\n`);
    const r3 = lintPkg(root, out);
    assert.equal(r3.status, 1);
    assert.match(r3.stdout, /license-incomplete/);

    write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, thirdParty: [] })}\n`);
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, license: { requireLicenseFile: true, requiredFields: ['name', 'license'] } })}\n`);
    rmSync(join(out, 'LICENSE'));
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const r4 = lintPkg(root, out);
    assert.equal(r4.status, 1, 'requireLicenseFile 且包内缺许可文件应报 license-incomplete');
    assert.match(`${r4.stdout}${r4.stderr}`, /license-incomplete/);
  } finally {
    cleanup(root);
  }
});

test('内部任务-244 遗留项④：MANIFEST 重复 path 条目拒绝（last-wins 不得掩盖哈希矛盾）', () => {
  const root = makeProject('manifest-dup');
  const out = join(makeTmp('manifest-dup-out'), 'pkg');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    const manifestPath = join(out, 'MANIFEST.sha256.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const first = manifest.files.find((f) => f.path === 'README.md');
    manifest.files.push({ path: first.path, sha256: '0'.repeat(64) }); // 重复 path + 冲突哈希
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const r = lintPkg(root, out, ['--json']);
    assert.equal(r.status, 1, `重复 path 须 lint 失败：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(RULES.MANIFEST_HASH));
    assert.match(r.stdout, /重复 path 条目/, '违例文案点名重复条目');
  } finally {
    cleanup(root);
  }
});

// ── 内部任务-348 批 D（内部未决-214③ MANIFEST 与合同绑定校验）──

test('内部未决-214③：MANIFEST.contractId/deliveryDate 与合同不符即拒（绑定校验）', () => {
  const root = makeProject('manifest-bind');
  const out = join(makeTmp('manifest-bind-out'), 'pkg');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    const manifestPath = join(out, 'MANIFEST.sha256.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(typeof manifest.contractId, 'string', '前置：manifest 含 contractId');
    // 篡改 contractId
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, contractId: 'CONTRACT-tampered' }, null, 2)}\n`);
    const r1 = lintPkg(root, out, ['--json']);
    assert.equal(r1.status, 1, `contractId 不符须 lint 失败：${r1.stdout}${r1.stderr}`);
    assert.match(r1.stdout, /contractId 与合同不符/, '违例文案点名 contractId');
    // 篡改 deliveryDate
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, deliveryDate: '2099-01-01' }, null, 2)}\n`);
    const r2 = lintPkg(root, out, ['--json']);
    assert.equal(r2.status, 1, `deliveryDate 不符须 lint 失败：${r2.stdout}${r2.stderr}`);
    assert.match(r2.stdout, /deliveryDate 与合同不符/, '违例文案点名 deliveryDate');
    // 未篡改基线（同文件恢复后仍绿）
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const r3 = lintPkg(root, out, ['--json']);
    assert.equal(r3.status, 0, `原样 manifest 须全绿：${r3.stdout}${r3.stderr}`);
  } finally {
    cleanup(root);
  }
});

test('fresh-git-history-deterministic：全新 git 历史、确定性与失败原子性', () => {
  const root = makeProject('git', { initGit: true });
  const outBase = makeTmp('git-out');
  const out1 = join(outBase, 'pkg1');
  const out2 = join(outBase, 'pkg2');
  try {
    const before = sourceSnapshot(root);
    const beforeGit = gitHistoryFingerprint(root);
    const r1 = exportPkg(root, out1);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const r2 = exportPkg(root, out2);
    assert.equal(r2.status, 0, `第二次导出应成功：${r2.stdout}${r2.stderr}`);
    // 确定性：两包内容字节全等（排除 .git）
    assert.deepEqual(packageContentSnapshot(out1), packageContentSnapshot(out2));
    // 全新历史：恰一 commit 且信息不含内部编号
    const log = spawnSync('git', ['-C', out1, 'log', '--format=%s'], { encoding: 'utf8' });
    assert.equal(log.status, 0);
    assert.deepEqual(log.stdout.trim().split('\n'), ['Initial delivery']);
    assert.doesNotMatch(log.stdout, /DEV-/);
    // 源仓只读：前后快照与源 .git 历史不变
    assert.deepEqual(sourceSnapshot(root), before);
    assert.deepEqual(gitHistoryFingerprint(root), beforeGit);
    // 失败原子性：内容违规时 --out 不存在且无 staging 残留
    write(root, 'docs/leak.md', '# 泄漏\n\n内部引用 内部任务-42。\n');
    write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [...BASE_CONTRACT.items, { id: 'D-4', kind: 'file', source: 'docs/leak.md', required: true }] })}\n`);
    const failOut = join(outBase, 'pkg-fail');
    const rFail = exportPkg(root, failOut, ['--no-git']);
    assert.equal(rFail.status, 1);
    assert.ok(!existsSync(failOut), '失败导出不得留下 --out');
    const siblings = readdirSync(outBase).filter((n) => n.includes('staging'));
    assert.deepEqual(siblings, [], '失败导出不得留下 staging 残留');
    // --no-git：无 .git 且 manifest.git.mode=none（先恢复干净 contract）
    write(root, '.deliver/contract.json', `${JSON.stringify(BASE_CONTRACT)}\n`);
    const noGitOut = join(outBase, 'pkg-nogit');
    assert.equal(exportPkg(root, noGitOut, ['--no-git']).status, 0);
    assert.equal(existsSync(join(noGitOut, '.git')), false);
    assert.equal(JSON.parse(readFileSync(join(noGitOut, 'MANIFEST.sha256.json'), 'utf8')).git.mode, 'none');
  } finally {
    cleanup(root, outBase);
  }
});

test('deliver-lint CLI 复核与退出码契约 0/1/2', () => {
  const root = makeProject('cli');
  const out = join(makeTmp('cli-out'), 'pkg');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    assert.equal(lintPkg(root, out).status, 0);
    write(out, 'zzz-extra.md', '# 未声明\n');
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    assert.equal(lintPkg(root, out).status, 1);
    write(root, '.deliver/policy.json', '{ bad json');
    assert.equal(lintPkg(root, out).status, 2, '配置错误应 exit 2');
  } finally {
    cleanup(root);
  }
});

test('deliver-lint --selftest 内嵌规则矩阵', () => {
  const r = execNode([LINT_CLI, '--selftest']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /OK deliver-lint --selftest（15 项通过）/);
  for (const rule of [RULES.CONTRACT_MISSING, RULES.UNLISTED, RULES.INTERNAL_PATTERN, RULES.INTERNAL_ARTIFACT, RULES.DANGLING, RULES.ESCAPES_ROOT, RULES.REMOVED_DOC, RULES.MANIFEST_MISSING, RULES.MANIFEST_HASH, RULES.MANIFEST_EXTRA, RULES.LICENSE_INCOMPLETE, RULES.REWRITE_RESIDUAL]) {
    assert.equal(typeof rule, 'string');
  }
});

// ── 内部决策-062 修正案 3 / 内部任务-333 同族：CLI 直跑在管道下 stdout 完整（process.exitCode） ──
test('cli-pipe-output-integrity：管道下 stdout 完整（内部任务-333 同族）', () => {
  const root = makeProject('pipe', {
    files: { 'docs/leak.md': `# 泄漏\n\n${Array.from({ length: 1200 }, (_, i) => `内部引用 DEV-${i + 1}`).join('\n')}\n` },
    contract: {
      items: [
        ...BASE_CONTRACT.items,
        { id: 'D-4', kind: 'file', source: 'docs/leak.md', required: true },
      ],
    },
    policy: { internal: { pathPatterns: ['specs/**'], idPatterns: ['\\bDEV-\\d+\\b'], termPatterns: [] } },
  });
  const out = join(makeTmp('pipe-out'), 'pkg');
  const r = spawnSync(process.execPath, [EXPORT_CLI, '--project-root', root, '--out', out, '--no-git', '--json'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 1, `应因内容违例 exit 1：${r.stderr}`);
  assert.ok(r.stdout.length > 64 * 1024, `管道 stdout 应超过 64KiB（实际 ${r.stdout.length}，截断即失效）`);
  const parsed = JSON.parse(r.stdout); // 修复前：process.exit 截断 stdout → SyntaxError
  assert.equal(parsed.ok, false);
  assert.ok(parsed.violations.length >= 1200, `违例清单应完整（实际 ${parsed.violations.length}）`);
  cleanup(root);
});

// ── 内部决策-062 修正案 4：扫描面扩展（scan.include）与 dot 前缀 token ──
test('scan-surface-extension：scan.include 与 dot 前缀 token（内部决策-062 修正案 4）', () => {
  const root = makeProject('scan-surface', {
    files: {
      'README.md': '# 示例\n\n参考 docs/guide.md。\n',
      LICENSE: 'MIT\n\n内部状态见 内部治理状态\n',
    },
    contract: {
      items: [
        { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true },
        { id: 'D-2', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
      ],
    },
    policy: {
      scan: { extensions: ['.md'], include: ['LICENSE'], exclude: [] },
      internal: { pathPatterns: ['.sdd/**', 'nothing/**'], idPatterns: [], termPatterns: [] },
    },
  });
  const r1 = exportPkg(root, join(makeTmp('scan-surface-out'), 'pkg'), ['--no-git']);
  assert.equal(r1.status, 1, 'scan.include 命中的 LICENSE 内内部路径必须阻断');
  assert.match(`${r1.stdout}${r1.stderr}`, /internal-artifact-present/);
  // dot 前缀 token 在 md 文本面生效（旧 token 正则首字符不含 `.` → 漏报）
  const root2 = makeProject('scan-dot', {
    files: {
      'README.md': '# 示例\n\n内部状态见 内部治理状态\n',
      LICENSE: 'MIT\n',
    },
    contract: {
      items: [
        { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true },
        { id: 'D-2', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
      ],
    },
    policy: {
      scan: { extensions: ['.md'], exclude: [] },
      internal: { pathPatterns: ['.sdd/**'], idPatterns: [], termPatterns: [] },
    },
  });
  const r2 = exportPkg(root2, join(makeTmp('scan-dot-out'), 'pkg'), ['--no-git']);
  assert.equal(r2.status, 1, 'dot 前缀 token .sdd/ 须被文本规则命中（修正案 4）');
  assert.match(`${r2.stdout}${r2.stderr}`, /internal-artifact-present/);
  cleanup(root, root2);
});

// ── 内部决策-062 修正案 4：内容改写（文档/测试/夹具全文本面、生产代码仅注释面、零残留与确定性） ──
test('content-rewrite：内容改写与 rewrite-residual 硬检（内部决策-062 修正案 4）', () => {
  const rewritePolicy = {
    scan: { extensions: ['.md', '.json'], include: ['LICENSE'], exclude: [] },
    internal: { pathPatterns: ['nothing/**'], idPatterns: [], termPatterns: [] },
    rewrite: {
      rules: [
        { id: 'path-evidence', pattern: '内部计划[A-Za-z0-9._/-]*', replacement: '内部证据' },
        { id: 'dev-id', pattern: 'DEV-\\d+', replacement: '内部任务-0' },
      ],
    },
  };
  const root = makeProject('rewrite', {
    files: {
      'LICENSE': 'MIT\n\n参考 内部证据\n',
      'src/prod.mjs': '// 文件头：参考 内部任务-2\nconst s = "http://example.invalid/内部任务-2"; // 行尾注释 内部任务-2\nconst t = `模板 内部任务-2`;\nif (x) /内部任务-6[//]/.test(s); // 行尾 内部任务-6\nconst q = (a+b) / c; // 除法 内部任务-8\n',
      'scripts/tool.py': '# 注释 内部任务-7\nTOKEN = "内部任务-7"\n',
      'config/rule_registry.json': '{"ruleId":"RULE-CORE-001","note":"内部任务-9"}\n',
      'tests/t.test.mjs': '// 测试注释 内部任务-3\ntest("内部任务-3 用例", () => {});\n',
      'tests/fixtures/f.json': '{"ref":"内部证据"}\n',
    },
    contract: {
      items: [
        { id: 'D-1', kind: 'file', source: 'README.md', target: 'README.md', required: true },
        { id: 'D-2', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
        { id: 'D-3', kind: 'file', source: 'src/prod.mjs', target: 'src/prod.mjs', required: false },
        { id: 'D-4', kind: 'file', source: 'tests/t.test.mjs', target: 'tests/t.test.mjs', required: false },
        { id: 'D-5', kind: 'file', source: 'tests/fixtures/f.json', target: 'tests/fixtures/f.json', required: false },
        { id: 'D-6', kind: 'file', source: 'scripts/tool.py', target: 'scripts/tool.py', required: false },
        { id: 'D-7', kind: 'file', source: 'config/rule_registry.json', target: 'config/rule_registry.json', required: false },
      ],
    },
    policy: rewritePolicy,
  });
  write(root, 'README.md', '# 示例\n\n参考 内部证据 与 内部任务-1\n');
  const out1 = join(makeTmp('rewrite-out1'), 'pkg');
  const r1 = exportPkg(root, out1, ['--no-git', '--json']);
  assert.equal(r1.status, 0, `内容改写导出应成功：${r1.stdout}${r1.stderr}`);
  const read = (rel) => readFileSync(join(out1, rel), 'utf8');
  assert.doesNotMatch(read('README.md'), /DEV-\d+|docs\/plans\/evidence/);
  assert.doesNotMatch(read('LICENSE'), /DEV-\d+|docs\/plans\/evidence/);
  assert.doesNotMatch(read('tests/t.test.mjs'), /DEV-\d+|docs\/plans\/evidence/); // test 面全文本改写
  assert.doesNotMatch(read('tests/fixtures/f.json'), /DEV-\d+|docs\/plans\/evidence/); // 夹具面全文本改写
  const prod = read('src/prod.mjs');
  assert.doesNotMatch(prod, /\/\/ 文件头[^\n]*DEV-\d+/); // 注释面已改写（按行核对）
  assert.doesNotMatch(prod, /\/\/ 行尾注释 DEV-\d+/);
  assert.match(prod, /http:\/\/example\.invalid\/内部任务-2/); // 字符串面不触碰（生产代码仅注释面）
  assert.match(prod, /模板 内部任务-2/); // 模板字面量面不触碰
  assert.match(prod, /内部任务-6\[\/\/\]/); // 正则字面量面不触碰（')' 后正则入口回归）
  assert.doesNotMatch(prod, /\/\/ 行尾 DEV-\d+/); // 正则同行行尾注释仍被识别改写
  assert.doesNotMatch(prod, /\/\/ 除法 DEV-\d+/); // 除号表达式的行尾注释不得被正则入口吞掉
  // other-code（其他语言/脚本源码 + 语义配置/schema）保守不改写：ID 保留、计入未覆盖面
  assert.match(read('scripts/tool.py'), /内部任务-7/);
  assert.match(read('config/rule_registry.json'), /RULE-CORE-001/); // 公开契约结构值不得被改写
  const payload = JSON.parse(String(r1.stdout));
  assert.ok(payload.rewrite && payload.rewrite.filesChanged >= 4, '改写报告应含文件计数');
  const byRule = Object.fromEntries(payload.rewrite.rules.map((x) => [x.id, x.count]));
  assert.ok(byRule['dev-id'] > 0 && byRule['path-evidence'] > 0, '改写报告应含逐规则计数');
  assert.ok(payload.rewrite.untargetedResidual >= 1, '生产代码字符串/模板内残留应如实报告为未覆盖面');
  // 确定性：同输入两次导出字节全等（改写静态、无随机）
  const out2 = join(makeTmp('rewrite-out2'), 'pkg');
  const r2 = exportPkg(root, out2, ['--no-git', '--json']);
  assert.equal(r2.status, 0);
  assert.equal(readFileSync(join(out1, 'README.md')).toString(), readFileSync(join(out2, 'README.md')).toString());
  // 零残留硬检：规则替换后仍命中自身 → rewrite-residual 阻断
  write(root, '.deliver/policy.json', `${JSON.stringify({ schemaVersion: 1, ...rewritePolicy, rewrite: { rules: [{ id: 'self', pattern: 'DEV-\\d+', replacement: '$&' }] } })}\n`);
  const r3 = exportPkg(root, join(makeTmp('rewrite-bad'), 'pkg'), ['--no-git', '--json']);
  assert.equal(r3.status, 1, `规则替换后仍命中自身必须 rewrite-residual 阻断（status=${r3.status}，stderr=${r3.stderr}，stdout=${String(r3.stdout).slice(0,500)}）`);
  assert.match(`${r3.stdout}${r3.stderr}`, /rewrite-residual/);
  cleanup(root);
});

// ── 阶段复审门 A（内部规则-13）阻塞修复回归（2026-10-23，内部任务-186）────────────────

test('in-tree --out 与空目录复用：事务顺序回归（阶段门 #1/#10）', () => {
  const root = makeProject('intree');
  try {
    const outInTree = join(root, 'dist', 'delivery');
    const r1 = exportPkg(root, outInTree, ['--no-git']);
    assert.equal(r1.status, 0, `--out 位于项目根内应成功：${r1.stdout}${r1.stderr}`);
    assert.ok(existsSync(join(outInTree, 'README.md')), '包应包含 README.md');
    // 非空 --out 拒绝覆盖（exit 2）
    assert.equal(exportPkg(root, outInTree, ['--no-git']).status, 2);
    // 已存在空目录允许复用
    mkdirSync(join(root, 'empty-out'), { recursive: true });
    assert.equal(exportPkg(root, join(root, 'empty-out'), ['--no-git']).status, 0);
  } finally {
    cleanup(root);
  }
});

test('.git 路径与本地协议/盘符引用被拒（阶段门 #2/#3）', () => {
  const root = makeProject('schemes');
  try {
    // .git 作为 CDM 来源 → schema 配置错误 exit 2
    write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: '.git/config', required: true }] })}\n`);
    assert.equal(exportPkg(root, join(root, 'o1'), ['--no-git']).status, 2, '.git 来源应被 schema 拒绝');
    // README 注入 file:// 与盘符引用 → 内容违例 exit 1 且 JSON 输出（阶段门 #11）
    write(root, '.deliver/contract.json', `${JSON.stringify(BASE_CONTRACT)}\n`);
    write(root, 'README.md', '# 示例交付\n\n[本地](file:///etc/passwd)\n[盘符](C:/secret.txt)\n');
    const r = exportPkg(root, join(root, 'o2'), ['--no-git', '--json']);
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.violations.some((v) => v.rule === RULES.ESCAPES_ROOT), 'file:/盘符应报 reference-escapes-root');
    assert.ok(!existsSync(join(root, 'o2')), '被阻断导出不留包');
  } finally {
    cleanup(root);
  }
});

test('包内符号链接指向包外 → reference-escapes-root（阶段门 #4）', () => {
  const root = makeProject('pkgsym');
  const outBase = makeTmp('pkgsym-out');
  const out = join(outBase, 'pkg');
  const externalRoot = makeTmp('pkgsym-ext');
  // 夹具目标文件在 skip 捕获范围外创建：EPERM/EACCES skip 只罩符号链接创建（内部任务-232 评审处置）
  const externalTarget = write(externalRoot, 'external-hosts.txt', '外部宿主机文件夹具\n');
  try {
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    try {
      symlinkSync(externalTarget, join(out, 'leak-link'));
    } catch (e) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') return;
      throw e;
    }
    write(out, 'README.md', '# 示例交付\n\n[链接](leak-link)\n');
    writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const r = lintPkg(root, out, ['--json']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /reference-escapes-root/);
  } finally {
    cleanup(root, outBase, externalRoot);
  }
});

test('源仓只读快照含 mtime：仅改 mtime 亦被检出（阶段门 #5）', () => {
  const root = makeProject('mtime');
  try {
    const before = sourceSnapshot(root);
    utimesSync(join(root, 'README.md'), new Date(), new Date(Date.now() + 5000));
    const after = sourceSnapshot(root);
    assert.notDeepEqual(after, before, '快照须包含 mtime（仅改 mtime 即可检出源仓变化）');
  } finally {
    cleanup(root);
  }
});

test('模板组合集成：contract/policy 模板复制为配置后可导出且 lint 0（阶段门 #6）', () => {
  const root = makeTmp('tpl');
  try {
    mkdirSync(join(root, '.deliver'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.mjs'), 'export const answer = 42;\n');
    cpSync(join(WORKFLOW_ROOT, 'templates', 'delivery', 'contract.template.json'), join(root, '.deliver', 'contract.json'));
    cpSync(join(WORKFLOW_ROOT, 'templates', 'delivery', 'policy.template.json'), join(root, '.deliver', 'policy.json'));
    // 模板为示例：按示例合同关闭「必须有许可文件」（模板合同未列 LICENSE 条目）
    const pol = JSON.parse(readFileSync(join(root, '.deliver', 'policy.json'), 'utf8'));
    pol.license.requireLicenseFile = false;
    writeFileSync(join(root, '.deliver', 'policy.json'), `${JSON.stringify(pol, null, 2)}\n`);
    const out = join(root, 'dist', 'delivery');
    const r = exportPkg(root, out, ['--no-git']);
    assert.equal(r.status, 0, `模板配置应可导出：${r.stdout}${r.stderr}`);
    assert.equal(lintPkg(root, out).status, 0, '模板配置产包应 lint 0（模板不得自带内部词触发自身规则）');
  } finally {
    cleanup(root);
  }
});

test('dir/glob 投影覆盖与显式 visibilitySource 缺失/坏 JSON（阶段门 #16）', () => {
  const root = makeProject('dirglob', {
    contract: {
      items: [
        { id: 'D-0', kind: 'file', source: 'README.md', target: 'README.md', required: true },
        { id: 'D-1', kind: 'dir', source: 'src', required: true },
        { id: 'D-2', kind: 'glob', source: 'docs/**/*.md', required: false },
        { id: 'D-3', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
      ],
    },
  });
  write(root, 'src/a.mjs', 'export const a = 1;\n');
  write(root, 'src/nested/b.mjs', 'export const b = 2;\n');
  try {
    const out = join(makeTmp('dirglob-out'), 'pkg');
    const r = exportPkg(root, out, ['--no-git']);
    assert.equal(r.status, 0, `dir/glob 投影应成功：${r.stdout}${r.stderr}`);
    assert.ok(existsSync(join(out, 'src', 'a.mjs')) && existsSync(join(out, 'src', 'nested', 'b.mjs')), 'dir 应保留目录结构');
    assert.ok(existsSync(join(out, 'docs', 'guide.md')), 'glob 应命中 docs/**/*.md');
    // 显式 visibilitySource 缺失/坏 JSON → exit 2
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, visibilitySource: '内部规格' })}\n`);
    assert.equal(exportPkg(root, join(root, 'o1'), ['--no-git']).status, 2);
    write(root, '内部规格', '{ bad json');
    assert.equal(exportPkg(root, join(root, 'o2'), ['--no-git']).status, 2);
  } finally {
    cleanup(root);
  }
});

test('项目级模板覆盖与 git 缺失 fail-loud（阶段门 #13/#16）', () => {
  const root = makeProject('override');
  try {
    // 项目级 DELIVERY-REPORT 模板覆盖：同名文件优先
    write(root, '.deliver/templates/DELIVERY-REPORT.template.md', '# CUSTOM-REPORT %%CONTRACT_ID%%\n\n%%ACCEPTANCE_ROWS%%\n');
    const out = join(makeTmp('override-out'), 'pkg');
    assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
    assert.match(readFileSync(join(out, 'DELIVERY-REPORT.md'), 'utf8'), /CUSTOM-REPORT C-186/, '项目级模板应优先于插件资产');
    // git 缺失（PATH 为空）且默认 freshHistory → fail-loud exit 2
    const outMissingGit = join(makeTmp('nogit-out'), 'pkg');
    const r = spawnSync(process.execPath, [EXPORT_CLI, '--project-root', root, '--out', outMissingGit], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(r.status, 2, `git 不可用应 fail-loud：${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /git/);
  } finally {
    cleanup(root);
  }
});

test('.git 经符号链接绕过词法检查亦被拒绝（阶段门 delta #1）', () => {
  const root = makeProject('gitsym', { initGit: true });
  try {
    try {
      symlinkSync(join('.git', 'config'), join(root, 'gitlink'));
    } catch (e) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') return;
      throw e;
    }
    write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: 'gitlink', required: true }] })}\n`);
    const r = exportPkg(root, join(root, 'o1'), ['--no-git']);
    assert.equal(r.status, 1, `经符号链接指向 .git 的 source 应被拒绝：${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /internal-artifact-present/);
  } finally {
    cleanup(root);
  }
});

// ── 收尾三维评审阻塞修复回归（2026-10-23，内部任务-186 C1/C2/C3 + 登记面）──────────

test('代码评审阻塞回归：危险豁免/提交信息注入/源符号链接/清单自列/路径归一', () => {
  // C1：allowPatterns 只允许 scheme 前缀，路径/上跳前缀 → 配置错误 exit 2
  {
    const root = makeProject('danger-exempt');
    try {
      write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, dangling: { allowExternal: true, allowPatterns: ['..'] } })}\n`);
      assert.equal(exportPkg(root, join(root, 'o1'), ['--no-git']).status, 2, '危险 allowPatterns 应 exit 2');
      write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, dangling: { allowExternal: true, allowPatterns: ['file:'] } })}\n`);
      assert.equal(exportPkg(root, join(root, 'o2'), ['--no-git']).status, 2, '路径形态 scheme 前缀应 exit 2');
    } finally {
      cleanup(root);
    }
  }
  // C1 判据面：allowPatterns 不再豁免本地路径引用（file: 引用仍 escapes-root）
  {
    const root = makeProject('danger-local-ref');
    try {
      write(root, 'README.md', '# 示例交付\n\n[本地](file:///etc/passwd)\n');
      const r = exportPkg(root, join(makeTmp('danger-local-out'), 'pkg'), ['--no-git']);
      assert.equal(r.status, 1);
      assert.match(`${r.stdout}${r.stderr}`, /reference-escapes-root/);
    } finally {
      cleanup(root);
    }
  }
  // C2：提交信息命中内部 ID → 导出 exit 1（提交前校验）
  {
    const root = makeProject('commit-inject');
    try {
      write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, git: { ...BASE_CONTRACT.git, commitMessage: '内部任务-42 internal delivery' } })}\n`);
      const r = exportPkg(root, join(makeTmp('commit-inject-out'), 'pkg'));
      assert.equal(r.status, 1, `提交信息内部 ID 应阻断：${r.stdout}${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, /internal-pattern/);
    } finally {
      cleanup(root);
    }
  }
  // C3：源符号链接指向内部文件 → 导出 exit 1
  {
    const root = makeProject('source-symlink');
    try {
      write(root, '内部规格', '# 内部规格\n');
      mkdirSync(join(root, 'public'), { recursive: true });
      try {
        symlinkSync(join('..', 'specs', 'secret.md'), join(root, 'public', 'secret-link.md'));
      } catch (e) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') return;
        throw e;
      }
      write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: 'public/secret-link.md', required: true }] })}\n`);
      const r = exportPkg(root, join(makeTmp('source-symlink-out'), 'pkg'), ['--no-git']);
      assert.equal(r.status, 1, `源符号链接应拒绝：${r.stdout}${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, /internal-artifact-present/);
    } finally {
      cleanup(root);
    }
  }
  // .git 大小写变体（.GIT）→ schema 拒绝
  {
    const root = makeProject('git-case');
    try {
      write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, items: [{ id: 'D-9', kind: 'file', source: '.GIT/config', required: true }] })}\n`);
      assert.equal(exportPkg(root, join(root, 'o1'), ['--no-git']).status, 2, '.GIT 应被词法拒绝');
    } finally {
      cleanup(root);
    }
  }
  // manifest 自列 → manifest-hash-mismatch
  {
    const root = makeProject('manifest-self');
    const out = join(makeTmp('manifest-self-out'), 'pkg');
    try {
      assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
      const mf = JSON.parse(readFileSync(join(out, 'MANIFEST.sha256.json'), 'utf8'));
      mf.files.push({ path: 'MANIFEST.sha256.json', sha256: '0'.repeat(64), bytes: 0 });
      writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(mf, null, 2)}\n`);
      const r = lintPkg(root, out, ['--json']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /manifest-hash-mismatch/);
    } finally {
      cleanup(root);
    }
  }
  // 路径归一：source './README.md' 与 dir 'src/' 可导出（不误报）
  {
    const root = makeProject('normalize', {
      contract: {
        items: [
          { id: 'D-1', kind: 'file', source: './README.md', target: 'README.md', required: true },
          { id: 'D-2', kind: 'dir', source: 'src/', required: false },
          { id: 'D-3', kind: 'file', source: 'docs/guide.md', target: 'docs/guide.md', required: true },
          { id: 'D-4', kind: 'file', source: 'LICENSE', target: 'LICENSE', required: false },
        ],
      },
    });
    write(root, 'src/a.mjs', 'export const a = 1;\n');
    try {
      const out = join(makeTmp('normalize-out'), 'pkg');
      const r = exportPkg(root, out, ['--no-git']);
      assert.equal(r.status, 0, `路径归一后应可导出：${r.stdout}${r.stderr}`);
      assert.ok(existsSync(join(out, 'README.md')) && existsSync(join(out, 'src', 'a.mjs')));
    } finally {
      cleanup(root);
    }
  }
  // 子目录文档内绝对路径引用 → reference-escapes-root；包内未引用符号链接 → reference-escapes-root
  {
    const root = makeProject('absref');
    const out = join(makeTmp('absref-out'), 'pkg');
    const externalRoot = makeTmp('absref-ext');
    // 夹具目标文件在 skip 捕获范围外创建：EPERM/EACCES skip 只罩符号链接创建（内部任务-232 评审处置）
    const externalTarget = write(externalRoot, 'external-hosts.txt', '外部宿主机文件夹具\n');
    try {
      assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
      write(out, 'docs/guide.md', '# 指南\n\n[绝对路径](/etc/passwd)\n');
      writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
      const r = lintPkg(root, out, ['--json']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /reference-escapes-root/);
      write(out, 'docs/guide.md', '# 指南\n\n返回 [README](../README.md)。\n');
      try {
        symlinkSync(externalTarget, join(out, 'unreferenced-link'));
      } catch (e) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') return;
        throw e;
      }
      writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
      const r2 = lintPkg(root, out, ['--json']);
      assert.equal(r2.status, 1);
      assert.match(r2.stdout, /reference-escapes-root/);
    } finally {
      cleanup(root);
      cleanup(externalRoot);
    }
  }
  // C2-b：提交信息含内部路径 → exit 1；C1-b：单字母 scheme（盘符）allowPatterns → exit 2
  {
    const root = makeProject('commit-path');
    try {
      write(root, '.deliver/contract.json', `${JSON.stringify({ ...BASE_CONTRACT, git: { ...BASE_CONTRACT.git, commitMessage: 'see 内部计划' } })}\n`);
      const r = exportPkg(root, join(makeTmp('commit-path-out'), 'pkg'));
      assert.equal(r.status, 1, `提交信息内部路径应阻断：${r.stdout}${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, /internal-artifact-present/);
      write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, dangling: { allowExternal: true, allowPatterns: ['c:'] } })}\n`);
      assert.equal(exportPkg(root, join(makeTmp('drive-scheme-out'), 'pkg'), ['--no-git']).status, 2, '单字母 scheme（盘符）应配置错误');
    } finally {
      cleanup(root);
    }
  }
  // 包内嵌套 .git 段与 %2F 绝对路径 → 均阻断
  {
    const root = makeProject('encoded-abs');
    const out = join(makeTmp('encoded-abs-out'), 'pkg');
    try {
      assert.equal(exportPkg(root, out, ['--no-git']).status, 0);
      mkdirSync(join(out, 'sub', '.git'), { recursive: true });
      writeFileSync(join(out, 'sub', '.git', 'config'), '[core]\n');
      write(out, 'docs/guide.md', '# 指南\n\n[编码绝对](%2Fetc/passwd)\n');
      writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(out, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
      const r = lintPkg(root, out, ['--json']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /internal-artifact-present/);
      assert.match(r.stdout, /reference-escapes-root/);
    } finally {
      cleanup(root);
    }
  }
});

// ── 内部任务-244 E03：data: 引用恒 blocking（不得作为外部链接豁免，也不得经 allowPatterns 豁免） ──

test('内部任务-244 E03：data: 引用恒 blocking（导出与 lint 两侧一致）', () => {
  const dataUri = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
  const root = makeProject('data-uri', { files: { 'README.md': `# 示例交付\n\n[内联](${dataUri})\n` } });
  const outBase = makeTmp('data-uri-out');
  const out = join(outBase, 'pkg');
  try {
    const rExport = exportPkg(root, out, ['--no-git']);
    assert.equal(rExport.status, 1, `data: 引用必须在导出时阻断（allowExternal=true 亦然）：${rExport.stdout}${rExport.stderr}`);
    const text = `${rExport.stdout}${rExport.stderr}`;
    assert.match(text, /reference-escapes-root/, '命中恒 blocking 规则');
    assert.ok(!existsSync(out), '被阻断导出不留包');
    // validatePolicy 面：allowPatterns 不得豁免 data: 协议（配置错误 exit 2）
    write(root, '.deliver/policy.json', `${JSON.stringify({ ...BASE_POLICY, dangling: { allowExternal: true, allowPatterns: ['data:'] } })}\n`);
    const rCfg = exportPkg(root, join(outBase, 'pkg2'), ['--no-git']);
    assert.equal(rCfg.status, 2, `allowPatterns 不得豁免 data:（实得 ${rCfg.status}：${rCfg.stderr}）`);
    // lint 侧一致：手工包内 data: 引用同样 blocking
    write(root, '.deliver/policy.json', `${JSON.stringify(BASE_POLICY)}\n`);
    write(root, 'README.md', '# 示例交付\n\n参见 [使用指南](docs/guide.md)。\n');
    const okOut = join(outBase, 'okpkg');
    assert.equal(exportPkg(root, okOut, ['--no-git']).status, 0, '基线导出成功（前置）');
    write(okOut, 'docs/guide.md', `# 指南\n\n[内联](${dataUri})\n`);
    writeFileSync(join(okOut, 'MANIFEST.sha256.json'), `${JSON.stringify(buildManifest(okOut, BASE_CONTRACT, { gitMode: 'none' }), null, 2)}\n`);
    const rLint = lintPkg(root, okOut, ['--json']);
    assert.equal(rLint.status, 1, 'lint 侧 data: 引用同样 blocking');
    assert.match(rLint.stdout, /reference-escapes-root/);
  } finally {
    cleanup(root, outBase);
  }
});
