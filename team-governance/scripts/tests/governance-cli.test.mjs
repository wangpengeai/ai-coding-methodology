// 文件：governance-cli.test.mjs
// 描述：治理读写闭环端到端 TDD（内部任务-5 C，内部规则-4 扩义/内部规则-9/内部验收-7）——
//       init→改政策→check/begin 裁决随之变；approve 落盘→gate 消费；
//       绑定 v1（subject/sources/inventory/validUntil）漂移→stale 矩阵（Node 侧）；
//       tampered 阻断；run-finalize outcome 诚实封存；坏配置/坏资产点名不吞；
//       agent-eval 默认权威报告落 runtime/evals 且 gate 实际读取；
//       lease 子命令参数面（内部规则-8：资源值归一成功路径；缺参/互斥/空或纯空白元素/元素非法/空 holder/非法 revision → 退 2 且不落台账）。
//       全部用例以子进程真实调用 CLI（process.execPath+数组参数），tmp 夹具零真机触达。
// 作者：wangp  创建：2026-10-06  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
// 内部任务-337：spawnSync import 随 cli/cliEval 收口移除（文件内无残余消费）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changeSetDigest } from '../lib/change-set.mjs';
import { integrityHash } from '../lib/canonical-json.mjs';
import { verifyReport } from '../lib/governance-gate.mjs';
import { DEFAULT_ALLOWED_MODELS } from '../lib/governance-store.mjs';
import { runCli as runCliShared } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'governance-cli.mjs');
const EVAL_CLI = resolve(HERE, '..', 'agent-eval.mjs');
const HASH_OK = 'sha256:' + 'a'.repeat(64);

// 内部任务-337（内部未决-223）：cli/cliEval 收口为 helpers.runCli 一行薄包装（118 调用点零改）。
/** 子进程跑 governance-cli（UTF-8；返回状态/JSON/stderr）。 */
function cli(root, ...args) {
  return runCliShared(CLI, root, args);
}

/** 子进程跑 agent-eval。 */
function cliEval(root, ...args) {
  return runCliShared(EVAL_CLI, root, args);
}

/** 新建 tmp 项目并 init（返回 root；policyRelaxed 可覆盖 enforcement）。 */
function initProj(policyOverride) {
  const root = mkdtempSync(join(tmpdir(), 'tg-govcli-'));
  const r = cli(root, 'init');
  assert.equal(r.status, 0, `init 失败：${r.stderr}`);
  if (policyOverride) patchPolicy(root, policyOverride);
  return root;
}

/** 读取 config.json（对象）。 */
function readConfig(root) {
  return JSON.parse(readFileSync(join(root, '.ai-governance', 'config.json'), 'utf8'));
}

/** 覆写 config.json（整体写回）。 */
function writeConfig(root, cfg) {
  writeFileSync(join(root, '.ai-governance', 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 只改内联 policy 的 enforcement。 */
function patchPolicy(root, enforcement) {
  const cfg = readConfig(root);
  cfg.policy.enforcement = enforcement;
  writeConfig(root, cfg);
}

function reportPath(root) {
  return join(root, '.ai-governance', 'runtime', 'reports', 'governance-report.json');
}

function readReport(root) {
  return JSON.parse(readFileSync(reportPath(root), 'utf8'));
}

function runFileCount(root) {
  const dir = join(root, '.ai-governance', 'runtime', 'runs');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** 写一份合法 contexts 清单文件（check 的 --contexts-file 输入）；返回路径。 */
function writeContexts(root, contexts = [{ source: 'repo:仓库维护说明', trust: 'repository' }]) {
  const p = join(root, `contexts-${Math.random().toString(16).slice(2, 8)}.json`);
  writeFileSync(p, JSON.stringify(contexts), 'utf8');
  return p;
}

/** 只改内联 policy 的 riskLevel。 */
function patchRisk(root, riskLevel) {
  const cfg = readConfig(root);
  cfg.policy.riskLevel = riskLevel;
  writeConfig(root, cfg);
}

/** 改 requiredDomains（H4 单源阻断触发面）。 */
function patchRequiredDomains(root, domains) {
  const cfg = readConfig(root);
  cfg.requiredDomains = domains;
  writeConfig(root, cfg);
}

/** approvals.jsonl 绝对路径。 */
function approvalsFile(root) {
  return join(root, '.ai-governance', 'runtime', 'approvals', 'approvals.jsonl');
}

/** 覆写审批台账（JSONL 文本）。 */
function writeApprovals(root, records) {
  writeFileSync(approvalsFile(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ── 1. init 幂等 + 播种内联默认政策（内部规则-9）──

test('init：播种内联默认政策；二次 init 幂等不覆写', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-govcli-'));
  try {
    const first = cli(root, 'init');
    assert.equal(first.status, 0);
    const cfg = readConfig(root);
    assert.ok(cfg.policy && typeof cfg.policy === 'object', '新 init 播种内联 policy（config.policy 为权威源）');
    assert.equal(cfg.policy.enforcement, 'relaxed');
    assert.deepEqual(cfg.policy.allowedModels, DEFAULT_ALLOWED_MODELS, '播种 allowedModels 四宿主（与归一常量同源，内部任务-2）');
    assert.deepEqual(cfg.requiredDomains ?? [], [], 'requiredDomains 有默认空位');
    const bytes = readFileSync(join(root, '.ai-governance', 'config.json'), 'utf8');
    const second = cli(root, 'init');
    assert.equal(second.status, 0);
    assert.ok(String(second.json?.note ?? '').includes('不覆写') || String(second.stdout).includes('不覆写'), '幂等提示');
    assert.equal(readFileSync(join(root, '.ai-governance', 'config.json'), 'utf8'), bytes, '既有配置字节不变');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 2. check/run-begin 裁决随政策改变（真实 preflight；strict deny 零 run 落盘）──

test('check/run-begin：relaxed warning 继续；改 strict 后 deny 且零 run 文件；再回 relaxed 恢复', () => {
  const root = initProj();
  try {
    // relaxed + 模型不可观察 → warning 放行
    const check1 = cli(root, 'check', '--contexts-file', writeContexts(root));
    assert.equal(check1.status, 0, `relaxed check 应退 0：${check1.stderr}`);
    assert.equal(check1.json.preflight.decision, 'warning');
    const begin1 = cli(root, 'run-begin', '--task-id', 'T-1');
    assert.equal(begin1.status, 0, `relaxed run-begin 应退 0：${begin1.stderr}`);
    assert.ok(begin1.json.runId);
    const filesAfterFirst = runFileCount(root);
    assert.equal(filesAfterFirst, 1);

    // 改 strict → 不可观察 deny；check 退 1；run-begin 拒且不落 run 文件
    patchPolicy(root, 'strict');
    const check2 = cli(root, 'check', '--contexts-file', writeContexts(root));
    assert.equal(check2.status, 1, 'strict 不可观察 check 应退 1');
    assert.equal(check2.json.preflight.decision, 'deny');
    const begin2 = cli(root, 'run-begin', '--task-id', 'T-2');
    assert.equal(begin2.status, 1, `strict run-begin 应退 1：${begin2.stderr}`);
    assert.equal(runFileCount(root), filesAfterFirst, 'deny 时零 run 文件落盘');

    // 回 relaxed → 恢复
    patchPolicy(root, 'relaxed');
    const begin3 = cli(root, 'run-begin', '--task-id', 'T-3');
    assert.equal(begin3.status, 0);
    assert.equal(runFileCount(root), filesAfterFirst + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 3. legacy 配置归一 + 内联/旧字段冲突拒绝 ──

test('legacy 配置：旧顶层 enforcement=strict 归一后仍 deny（不固定 relaxed）；内联与旧字段冲突拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-govcli-'));
  try {
    mkdirSync(join(root, '.ai-governance'), { recursive: true });
    writeConfig(root, {
      schemaVersion: '1.0.0', policyId: 'p1', policyVersion: 2, enforcement: 'strict',
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const check = cli(root, 'check', '--contexts-file', writeContexts(root));
    assert.equal(check.status, 1, 'legacy strict 必须仍 deny（不能固定 relaxed）');
    assert.equal(check.json.preflight.decision, 'deny');

    // 内联 policy 与旧顶层 enforcement 冲突 → 工具错退 2
    writeConfig(root, {
      schemaVersion: '1.0.0',
      policy: { id: 'inline', version: 1, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      policyId: 'p1', policyVersion: 2, enforcement: 'strict',
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const conflict = cli(root, 'check', '--contexts-file', writeContexts(root));
    assert.equal(conflict.status, 2, '内联与旧字段冲突应退 2');
    assert.ok(conflict.stderr.includes('enforcement'), 'stderr 点名冲突字段');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 4. change-set 落盘 / approve 落盘 → gate 消费 ──

test('change-set 落盘（digest 重算一致）；approve 落盘→gate 消费（binding/validUntil/sources）', () => {
  const root = initProj();
  try {
    const cs = cli(root, 'change-set', '--repos', 'main', '--resources', 'path:main:src/**');
    assert.equal(cs.status, 0, `change-set 失败：${cs.stderr}`);
    const csPath = join(root, '.ai-governance', 'runtime', 'change-set.json');
    assert.ok(existsSync(csPath), 'change-set 落 runtime/change-set.json');
    const persisted = JSON.parse(readFileSync(csPath, 'utf8'));
    assert.equal(persisted.digest, changeSetDigest(persisted.changeSet), '落盘 digest 与重算一致（仅断言）');

    const ap = cli(root, 'approve', '--role', 'accountable', '--identity', 'alice', '--expires-at', '2099-01-01');
    assert.equal(ap.status, 0, `approve 失败：${ap.stderr}`);
    const approvalsPath = join(root, '.ai-governance', 'runtime', 'approvals', 'approvals.jsonl');
    assert.ok(existsSync(approvalsPath), 'approve 原子落 runtime/approvals/approvals.jsonl');
    const record = JSON.parse(readFileSync(approvalsPath, 'utf8').trim().split('\n')[0]);
    assert.equal(record.identity.verified, false, '本地登记恒 local-attested');
    assert.ok(ap.json.subjectDigest && ap.json.subjectDigest.startsWith('sha256:'), 'approve 输出当前 subject');
    assert.equal(record.subjectDigest, ap.json.subjectDigest, '落盘审批绑定当前 subject');

    const g = cli(root, 'gate');
    assert.equal(g.status, 0, `gate 失败：${g.stderr}\n${g.stdout}`);
    const report = readReport(root);
    assert.equal(report.status, 'passed');
    assert.equal(report.approvals.length, 1, 'gate 消费真实落盘审批');
    assert.equal(report.binding.subject, record.subjectDigest, '报告 binding.subject 与审批绑定一致');
    assert.equal(report.binding.validUntil, '2099-01-01', 'validUntil=采用审批最早 expiresAt');
    assert.equal(report.subjectDigest, report.binding.subject, '兼容字段=绑定 subject');
    const refPaths = report.sources.refs.map((r) => r.path);
    for (const expected of ['.ai-governance/config.json', '.ai-governance/runtime/approvals/approvals.jsonl',
      '.ai-governance/runtime/change-set.json']) {
      assert.ok(refPaths.includes(expected), `sources.refs 须含 ${expected}（收到：${refPaths.join(',')}）`);
    }
    const sorted = [...refPaths].every((p, i) => i === 0 || refPaths[i - 1] <= p);
    assert.ok(sorted, 'sourceRefs 按路径排序');

    // --subject-digest 仅一致性断言：传过期快照须拒
    const staleArg = cli(root, 'approve', '--role', 'accountable', '--identity', 'bob',
      '--subject-digest', 'sha256:' + 'de'.repeat(32), '--expires-at', '2099-01-01');
    assert.equal(staleArg.status, 1, '与当前 subject 不一致的 --subject-digest 应退 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 5. 绑定 v1 漂移矩阵（Node verifyReport 只读重算）──

test('verifyReport 漂移矩阵：新增/修改/删除 subject 文件→stale；审批追加（source 变）→stale；回滚→恢复 passed', () => {
  const root = initProj();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)\n', 'utf8');
    assert.equal(cli(root, 'gate').status, 0);
    const report = readReport(root);

    // 基线：文件不变 → passed（含黄金自证：verify 与 build 同源）
    assert.equal(verifyReport(report, { projectRoot: root }), 'passed');

    // 新增 subject 文件 → stale
    writeFileSync(join(root, 'src', 'new.js'), 'x\n', 'utf8');
    assert.equal(verifyReport(report, { projectRoot: root }), 'stale', '新增文件→stale');
    rmSync(join(root, 'src', 'new.js'));

    // 修改 subject 文件 → stale
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(2)\n', 'utf8');
    assert.equal(verifyReport(report, { projectRoot: root }), 'stale', '内容变化→stale');
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)\n', 'utf8');

    // 删除 subject 文件 → stale
    rmSync(join(root, 'src', 'app.js'));
    assert.equal(verifyReport(report, { projectRoot: root }), 'stale', '删除文件→stale');
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)\n', 'utf8');
    assert.equal(verifyReport(report, { projectRoot: root }), 'passed', '恢复原内容→passed（确定性）');

    // source 变化而 subject 不变：追加审批使旧报告过期（但不是 blocked）
    assert.equal(cli(root, 'approve', '--role', 'accountable', '--identity', 'carol',
      '--expires-at', '2099-06-01').status, 0);
    assert.equal(verifyReport(report, { projectRoot: root }), 'stale', '审批追加（source 变）→旧报告 stale');

    // 重出报告后恢复 passed（新报告消费该审批）
    assert.equal(cli(root, 'gate').status, 0);
    const report2 = readReport(root);
    assert.equal(report2.approvals.length, 1);
    assert.equal(report2.binding.validUntil, '2099-06-01', 'validUntil=采用审批的 expiresAt');
    assert.equal(verifyReport(report2, { projectRoot: root }), 'passed');

    // 删除控制输入（approvals.jsonl——纯 source，不在 subject）→ inventory 缺失标记翻转 → stale
    rmSync(join(root, '.ai-governance', 'runtime', 'approvals', 'approvals.jsonl'));
    assert.equal(verifyReport(report2, { projectRoot: root }), 'stale', '控制输入删除→stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 6. validUntil 时钟缝（文件不变只推进时间）──

test('validUntil 时钟缝：到界前 passed；日期越过 validUntil → stale（文件零变化）', () => {
  const root = initProj();
  try {
    assert.equal(cli(root, 'change-set', '--repos', 'main').status, 0);
    assert.equal(cli(root, 'approve', '--role', 'accountable', '--identity', 'alice', '--expires-at', '2099-01-01').status, 0);
    assert.equal(cli(root, 'gate').status, 0);
    const report = readReport(root);
    assert.equal(report.binding.validUntil, '2099-01-01');
    assert.equal(verifyReport(report, { projectRoot: root, now: '2099-01-01' }), 'passed', '到界当日仍有效（与审批日粒度一致）');
    assert.equal(verifyReport(report, { projectRoot: root, now: '2099-01-02' }), 'stale', '越过 validUntil → stale（零文件变化）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 7. tampered ──

test('tampered：手改报告字段（不重算 integrityHash）→ tampered', () => {
  const root = initProj();
  try {
    assert.equal(cli(root, 'gate').status, 0);
    const report = readReport(root);
    report.status = 'blocked';
    writeFileSync(reportPath(root), JSON.stringify(report, null, 2) + '\n', 'utf8');
    assert.equal(verifyReport(report, { projectRoot: root }), 'tampered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 8. run-finalize outcome（诚实封存）──

test('run-finalize outcome：缺省 completed；cancelled/failed 必填 reason；不可变；取消不冒充成功', () => {
  const root = initProj();
  try {
    const b1 = cli(root, 'run-begin', '--task-id', 'T-1');
    assert.equal(b1.status, 0);
    const f1 = cli(root, 'run-finalize', '--run-id', b1.json.runId, '--repo-head', 'h'.repeat(40), '--diff-digest', HASH_OK);
    assert.equal(f1.status, 0, `缺省 finalize 失败：${f1.stderr}`);
    assert.equal(f1.json.outcome, 'completed', '缺省 outcome=completed');
    assert.equal(f1.json.status, 'finalized');

    const b2 = cli(root, 'run-begin', '--task-id', 'T-2');
    const noReason = cli(root, 'run-finalize', '--run-id', b2.json.runId, '--repo-head', 'h'.repeat(40),
      '--diff-digest', HASH_OK, '--outcome', 'cancelled');
    assert.equal(noReason.status, 2, 'cancelled 缺 reason 应退 2');
    assert.ok(noReason.stderr.includes('reason'), 'stderr 点名 reason 必填');

    const badOutcome = cli(root, 'run-finalize', '--run-id', b2.json.runId, '--repo-head', 'h'.repeat(40),
      '--diff-digest', HASH_OK, '--outcome', 'aborted', '--reason', 'x');
    assert.equal(badOutcome.status, 2, '非法 outcome 枚举应退 2');

    const f2 = cli(root, 'run-finalize', '--run-id', b2.json.runId, '--repo-head', 'h'.repeat(40),
      '--diff-digest', HASH_OK, '--outcome', 'cancelled', '--reason', '需求变更取消');
    assert.equal(f2.status, 0, `cancelled finalize 失败：${f2.stderr}`);
    assert.equal(f2.json.outcome, 'cancelled');
    assert.equal(f2.json.reason, '需求变更取消');
    assert.equal(f2.json.status, 'finalized', 'status 仍 finalized（不可变语义不变）');

    const again = cli(root, 'run-finalize', '--run-id', b2.json.runId, '--repo-head', 'h'.repeat(40),
      '--diff-digest', HASH_OK, '--outcome', 'completed');
    // 内部任务-254（H7 错误码收口）：finalize 异常一律工具错退 2（原 generic catch 退 1 已修）
    assert.equal(again.status, 2, 'finalize 后再 finalize 拒（不可变）且错误码归工具错 2');

    // 取消的 run 在 gate 报告里如实呈现 outcome，不冒充成功
    assert.equal(cli(root, 'gate').status, 0);
    const report = readReport(root);
    const byRun = new Map(report.manifests.map((m) => [m.runId, m]));
    assert.equal(byRun.get(b2.json.runId)?.outcome, 'cancelled', '报告呈现 cancelled');
    assert.equal(byRun.get(b1.json.runId)?.outcome, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 9. 坏配置/坏资产/危险路径点名（不吞）──

test('坏配置点名退 2；required 覆盖缺口阻断；配置引用缺失/越界点名', () => {
  const root = initProj();
  try {
    // 坏 config JSON → check/gate/run-begin 全部工具错退 2 且点名 config
    writeFileSync(join(root, '.ai-governance', 'config.json'), '{ broken', 'utf8');
    for (const cmd of [['check', '--contexts-file', writeContexts(root)], ['gate'], ['run-begin', '--task-id', 'T']]) {
      const r = cli(root, ...cmd);
      assert.equal(r.status, 2, `${cmd[0]} 坏配置应退 2`);
      assert.ok(r.stderr.includes('config.json'), `${cmd[0]} stderr 点名 config.json`);
    }
    // 恢复：requiredDomains 要求 evals 域但无 eval 报告 → blocking
    writeConfig(root, {
      schemaVersion: '1.0.0',
      policy: { id: 'default', version: 1, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      requiredDomains: ['evals'],
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const g1 = cli(root, 'gate');
    assert.equal(g1.status, 1, 'required 域缺输入应阻断');
    assert.ok(g1.stdout.includes('TG-COVERAGE-REQUIRED'), '诊断点名 required 覆盖缺口');

    // 配置引用缺失文件 → blocking 点名路径
    writeConfig(root, {
      schemaVersion: '1.0.0',
      policy: { id: 'default', version: 1, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      evalSuiteFiles: ['evals/suite-missing.json'],
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const g2 = cli(root, 'gate');
    assert.equal(g2.status, 1, '配置引用缺失应阻断');
    assert.ok(g2.stdout.includes('evals/suite-missing.json'), '点名缺失路径');

    // 配置引用越界（../）→ 工具错退 2
    writeConfig(root, {
      schemaVersion: '1.0.0',
      policy: { id: 'default', version: 1, riskLevel: 'medium',
        allowedModels: [{ provider: 'zcode', capabilities: ['code'] }], fallbacks: [], enforcement: 'relaxed' },
      evalSuiteFiles: ['../outside.json'],
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const g3 = cli(root, 'gate');
    assert.equal(g3.status, 2, '越界路径应退 2');
    assert.ok(g3.stderr.includes('outside.json') || g3.stderr.includes('越界'), 'stderr 点名越界');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 10. agent-eval 权威报告落 runtime/evals + gate 实际读取 + --out 不自动权威 ──

test('agent-eval：默认权威报告落 runtime/evals；gate 实际读取；--out 导出不自动权威', () => {
  const root = initProj();
  try {
    const suite = {
      suiteId: 's-e2e', caseSetVersion: 'v1',
      cases: [{ caseId: 'c1', subjectHash: HASH_OK, events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: 'ok' }] }],
    };
    writeFileSync(join(root, 'evals-suite.json'), JSON.stringify(suite), 'utf8');
    const run = cliEval(root, '--suite', 'evals-suite.json', '--subject-hash', HASH_OK);
    assert.equal(run.status, 0, `agent-eval 失败：${run.stderr}`);
    const evalsDir = join(root, '.ai-governance', 'runtime', 'evals');
    const files = existsSync(evalsDir) ? readdirSync(evalsDir).filter((f) => f.endsWith('.json')) : [];
    assert.equal(files.length, 1, '权威报告恰好落一份');
    const persistedEval = JSON.parse(readFileSync(join(evalsDir, files[0]), 'utf8'));
    assert.equal(persistedEval.integrityHash, run.json.integrityHash, '落盘报告与输出一致');

    const g = cli(root, 'gate');
    assert.equal(g.status, 0, `gate 失败：${g.stderr}\n${g.stdout}`);
    const report = readReport(root);
    assert.equal(report.evals.length, 1, 'gate 实际读取 runtime/evals');
    assert.equal(report.evals[0].suiteId, 's-e2e');

    // --out 导出副本：文件存在但不自动进 control sources
    const exportPath = join(root, 'exported-report.json');
    const run2 = cliEval(root, '--suite', 'evals-suite.json', '--subject-hash', HASH_OK, '--out', exportPath);
    assert.equal(run2.status, 0);
    assert.ok(existsSync(exportPath), '--out 导出副本存在');
    assert.equal(cli(root, 'gate').status, 0);
    const report2 = readReport(root);
    assert.ok(!report2.sources.refs.some((r) => r.path === 'exported-report.json'),
      '--out 导出不自动成为权威输入（未登记不进 sources）');

    // 失败 eval → gate 阻断（TG-EVAL-FAILED）
    const badSuite = {
      suiteId: 's-bad', caseSetVersion: 'v1',
      cases: [{ caseId: 'c1', subjectHash: HASH_OK, events: [{ text: 'ok' }], oracles: [{ kind: 'exact', value: '不存在' }] }],
    };
    writeFileSync(join(root, 'evals-suite.json'), JSON.stringify(badSuite), 'utf8');
    const run3 = cliEval(root, '--suite', 'evals-suite.json', '--subject-hash', HASH_OK);
    assert.equal(run3.status, 1, '确定性失败退 1');
    const g3 = cli(root, 'gate');
    assert.equal(g3.status, 1, 'gate 消费失败 eval 应阻断');
    assert.ok(g3.stdout.includes('TG-EVAL-FAILED'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-252 批 1a（C3）：lease 子命令参数面（内部规则-8/内部规则-9 退出码契约）──

test('lease 参数面：缺 --resource 退 2 且不落坏台账', () => {
  const root = initProj();
  try {
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const r = cli(root, 'lease', 'acquire', '--holder', 'manual');
    assert.equal(r.status, 2, '缺 --resource 属参数错退 2');
    assert.equal(existsSync(stateFile), false, '参数错不得落租约台账');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lease 参数面：互斥/空值/旗标当值/缺 lease-id/非法 revision 各退 2（且零台账写）', () => {
  const root = initProj();
  try {
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    const both = cli(root, 'lease', 'acquire', '--resource', 'path:main:src/**', '--resources', 'path:main:docs/**', '--holder', 'h');
    assert.equal(both.status, 2, '--resource 与 --resources 互斥');
    const empty = cli(root, 'lease', 'acquire', '--resource', '', '--holder', 'h');
    assert.equal(empty.status, 2, '空 --resource 退 2');
    const flagAsValue = cli(root, 'lease', 'acquire', '--resource', '--holder', 'run-a');
    assert.equal(flagAsValue.status, 2, '旗标当值退 2');
    const noLeaseId = cli(root, 'lease', 'renew', '--revision', '1');
    assert.equal(noLeaseId.status, 2, '缺 --lease-id 退 2');
    const badRevision = cli(root, 'lease', 'release', '--lease-id', 'lease-x', '--revision', 'abc');
    assert.equal(badRevision.status, 2, '非正整数 --revision 退 2');
    assert.equal(existsSync(stateFile), false, '五支参数错均不得落租约台账');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-254 批 2（H1/H2/H4/H6/H7/H14：内部验收-3/内部验收-2）──

test('check：无 contexts 参数错误退 2', () => {
  const root = initProj();
  try {
    const none = cli(root, 'check');
    assert.equal(none.status, 2, 'check 无 contexts → 参数错退 2（不得空转）');
    assert.ok(none.stderr.includes('--contexts-file'), 'usage 指向 --contexts-file');
    const missing = cli(root, 'check', '--contexts-file', join(root, 'nope.json'));
    assert.equal(missing.status, 2, '文件不存在退 2');
    const bad = join(root, 'bad-contexts.json');
    writeFileSync(bad, '{bad', 'utf8');
    assert.equal(cli(root, 'check', '--contexts-file', bad).status, 2, '坏 JSON 退 2');
    const empty = join(root, 'empty-contexts.json');
    writeFileSync(empty, '[]', 'utf8');
    assert.equal(cli(root, 'check', '--contexts-file', empty).status, 2, '空 contexts 清单退 2（无 contexts 不得空转）');
    const ok = cli(root, 'check', '--contexts-file', writeContexts(root));
    assert.equal(ok.status, 0, `合法 contexts 正常诊断退 0：${ok.stderr}`);
    assert.ok(Array.isArray(ok.json.contexts), '输出含 contexts 诊断数组');
    const web = cli(root, 'check', '--contexts-file', writeContexts(root, [{ source: 'web:evil', trust: 'external-unverified' }]));
    assert.equal(web.status, 0, '诊断不改变退出码（preflight 决定）');
    assert.ok(web.json.contexts.length > 0, '不可作 instruction 的上下文须返回诊断');
    const badTrust = cli(root, 'check', '--contexts-file', writeContexts(root, [{ source: 'x', trust: 'bogus-level' }]));
    assert.equal(badTrust.status, 2, '非法信任级属参数错退 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('审批归属：highRisk 自批阻断（含先 finalize 再审批）/ 缺 --initiator 退 2 / 无归属 warning', () => {
  const root = initProj();
  try {
    patchRisk(root, 'high');
    const noInit = cli(root, 'run-begin', '--task-id', 'T-1');
    assert.equal(noInit.status, 2, 'highRisk 缺 --initiator 退 2（不得静默不可归属）');
    assert.equal(runFileCount(root), 0, '参数错不落 run 文件');
    const begin = cli(root, 'run-begin', '--task-id', 'T-1', '--initiator', 'devA');
    assert.equal(begin.status, 0, begin.stderr);
    assert.equal(begin.json.humanInitiator, 'devA', 'manifest.humanInitiator 落顶层字段');
    assert.match(String(begin.json.openHash), /^sha256:[0-9a-f]{64}$/, 'run-begin stdout 增 openHash');
    // run 须 finalize（否则 open manifest 自身阻断，与本用例关注点无关）
    assert.equal(cli(root, 'run-finalize', '--run-id', begin.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    // 自批：devA 审批 → TG-APPROVAL-SELF blocking
    assert.equal(cli(root, 'approve', '--identity', 'devA', '--expires-at', '2099-01-01').status, 0);
    let gate = cli(root, 'gate');
    assert.equal(gate.status, 1, '自批阻断退 1');
    assert.ok(gate.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-SELF' && d.severity === 'blocking'),
      '自批须 TG-APPROVAL-SELF blocking');
    // 匿名审批不得解除自批（三维评审正确性阻塞 B1）：缺 --identity 退 2；
    // 直接伪造匿名记录（绕过 CLI）也不得被计为有效独立审批
    const anon = cli(root, 'approve', '--expires-at', '2099-01-01');
    assert.equal(anon.status, 2, '缺 --identity 退 2（身份须可归属）');
    assert.equal(cli(root, 'approve', '--identity', 'unknown', '--expires-at', '2099-01-01').status, 2,
      '--identity unknown 退 2（不可归属）');
    const existing = readFileSync(approvalsFile(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const forged = { approvalId: 'apr-forged-anon', subjectDigest: existing[0].subjectDigest,
      role: 'accountable', identity: { source: 'local', verified: false, id: 'unknown' },
      decidedAt: '2026-10-29', expiresAt: '2099-01-01', conditions: [], revocation: null };
    writeApprovals(root, [...existing, forged]);
    gate = cli(root, 'gate');
    assert.equal(gate.status, 1, '匿名审批不得解除自批阻断（仍退 1）');
    assert.ok(gate.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-SELF' && d.severity === 'blocking'),
      '伪造匿名记录后 TG-APPROVAL-SELF 仍 blocking');
    assert.ok(gate.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-INVALID'),
      '不可归属身份记录按 INVALID warning 记档');
    // 独立审批 devB 后 → 退 0（自批记录降为历史失效 warning）
    assert.equal(cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-01-01').status, 0);
    gate = cli(root, 'gate');
    assert.equal(gate.status, 0, `独立审批后应通过：${JSON.stringify(gate.json?.diagnostics)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // 先 finalize 再审批：finalized manifest 同为归属来源，自批仍 blocking
  const root2 = initProj();
  try {
    patchRisk(root2, 'high');
    const b = cli(root2, 'run-begin', '--task-id', 'T-2', '--initiator', 'devA');
    assert.equal(b.status, 0, b.stderr);
    assert.equal(cli(root2, 'run-finalize', '--run-id', b.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    assert.equal(cli(root2, 'approve', '--identity', 'devA', '--expires-at', '2099-01-01').status, 0);
    const g = cli(root2, 'gate');
    assert.equal(g.status, 1, '（先 finalize 再审批）自批仍阻断退 1');
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-SELF'), '不得降为 UNATTRIBUTED warning');
  } finally { rmSync(root2, { recursive: true, force: true }); }
  // 无归属：initiator 显式 unknown → 按无值处理，不判自批，仅 UNATTRIBUTED warning
  const root3 = initProj();
  try {
    patchRisk(root3, 'high');
    const b = cli(root3, 'run-begin', '--task-id', 'T-3', '--initiator', 'unknown');
    assert.equal(b.status, 0, b.stderr);
    assert.equal(cli(root3, 'run-finalize', '--run-id', b.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    assert.equal(cli(root3, 'approve', '--identity', 'devB', '--expires-at', '2099-01-01').status, 0);
    const g = cli(root3, 'gate');
    assert.equal(g.status, 0, `无归属不得判自批：${JSON.stringify(g.json?.diagnostics)}`);
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-UNATTRIBUTED' && d.severity === 'warning'),
      '无归属须 TG-APPROVAL-UNATTRIBUTED warning（可见、不判自批）');
  } finally { rmSync(root3, { recursive: true, force: true }); }
  // 有归属但尚未审批：不得误报无归属（阶段复审阻塞 1：审批数组为空时 requestedBy 仍须现算）
  const root4 = initProj();
  try {
    patchRisk(root4, 'high');
    const b = cli(root4, 'run-begin', '--task-id', 'T-4', '--initiator', 'devA');
    assert.equal(b.status, 0, b.stderr);
    assert.equal(cli(root4, 'run-finalize', '--run-id', b.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    const g = cli(root4, 'gate');
    assert.equal(g.status, 0, `零审批但有归属应退 0：${JSON.stringify(g.json?.diagnostics)}`);
    assert.ok(!g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-UNATTRIBUTED'),
      '有 humanInitiator 时不得误报 UNATTRIBUTED');
    // 旗标当值：--initiator 不得吞下一个旗标
    const bad = cli(root4, 'run-begin', '--task-id', 'T-5', '--initiator', '--policy', 'p1');
    assert.equal(bad.status, 2, '--initiator 旗标当值退 2');
  } finally { rmSync(root4, { recursive: true, force: true }); }
});

test('approval：自批拒/内容绑定失效/过期失效/撤销失效/按 approvalId 折叠（含后者覆盖与 revocation）', () => {
  const root = initProj();
  try {
    // 自批拒（recordApproval 面：--executor 与 --identity 同人 + --high-risk）
    const self = cli(root, 'approve', '--identity', 'devA', '--executor', 'devA', '--high-risk');
    assert.equal(self.status, 1, '自批拒 = 内容阻断退 1');
    // 内容绑定失效（--subject-digest 过期快照）
    const snap = cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-01-01');
    assert.equal(snap.status, 0, snap.stderr);
    const subject = snap.json.subjectDigest;
    const mismatch = cli(root, 'approve', '--identity', 'devB', '--subject-digest', 'sha256:' + 'c'.repeat(64));
    assert.equal(mismatch.status, 1, '过期快照=内容阻断退 1');
    assert.ok(mismatch.stderr.includes('subject'), 'stderr 点名 subject 不一致');

    const rec = (over = {}) => ({ approvalId: 'apr-fold-1', subjectDigest: subject, role: 'accountable',
      identity: { source: 'local', verified: false, id: 'devB' }, decidedAt: '2026-10-29',
      expiresAt: '2099-01-01', conditions: [], revocation: null, ...over });
    const gateWith = (domains) => { patchRequiredDomains(root, domains); return cli(root, 'gate'); };

    // ① 同 approvalId 数组序后者覆盖：后者有效（前项过期被覆盖）→ required 时退 0
    writeApprovals(root, [rec({ expiresAt: '2020-01-01' }), rec()]);
    let g = gateWith(['approvals']);
    assert.equal(g.status, 0, `后者有效覆盖前项应通过：${JSON.stringify(g.json?.diagnostics)}`);
    // ② 同 approvalId 后者失效（过期）→ 后者覆盖前项 → required 时 MISSING blocking
    writeApprovals(root, [rec(), rec({ expiresAt: '2020-01-01' })]);
    g = gateWith(['approvals']);
    assert.equal(g.status, 1, '后者过期覆盖前项 → 无有效审批');
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-MISSING' && d.severity === 'blocking'));
    // ③ revocation 记录覆盖同 ID 前项并视为已撤销 → required 时 MISSING blocking
    writeApprovals(root, [rec(), rec({ revocation: { revokedAt: '2026-10-29', reason: '撤回' } })]);
    g = gateWith(['approvals']);
    assert.equal(g.status, 1, '撤销覆盖前项 → 无有效审批');
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-MISSING'));
    // ④ 折叠后仅剩失效项 + 不含 approvals → warning 退 0（历史失效不永久阻断）
    g = gateWith([]);
    assert.equal(g.status, 0, '不含 approvals 时历史失效仅 warning 退 0');
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-INVALID' && d.severity === 'warning'));
    // ⑤ 历史 invalid + 一条有效 → required 时退 0 且仅 INVALID warning
    writeApprovals(root, [rec({ approvalId: 'apr-old', expiresAt: '2020-01-01' }), rec({ approvalId: 'apr-new' })]);
    g = gateWith(['approvals']);
    assert.equal(g.status, 0, `一条有效即通过：${JSON.stringify(g.json?.diagnostics)}`);
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-INVALID' && d.severity === 'warning'));
    // ⑥ validUntil 只由折叠后的**有效**审批最早 expiresAt 计算（失效项即使更早也不计入）
    writeApprovals(root, [rec({ approvalId: 'apr-a', expiresAt: '2099-06-01' }), rec({ approvalId: 'apr-b', expiresAt: '2099-03-01' }),
      rec({ approvalId: 'apr-expired', expiresAt: '2020-01-01' })]);
    g = gateWith([]);
    assert.equal(g.json.validUntil, '2099-03-01', `validUntil=有效审批最早 expiresAt（失效项不计；实测 ${g.json.validUntil}）`);
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-INVALID'), '失效项仍须 warning 可见');
    // ⑦ 无任何有效审批且 required → MISSING blocking
    writeApprovals(root, [rec({ expiresAt: '2020-01-01' })]);
    g = gateWith(['approvals']);
    assert.equal(g.status, 1);
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-MISSING' && d.severity === 'blocking'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval 参数面：--expires-at 严格 YYYY-MM-DD；既存非补零记录按折叠档位失效', () => {
  const root = initProj();
  try {
    const bad1 = cli(root, 'approve', '--identity', 'devB', '--expires-at', '2026-9-1');
    assert.equal(bad1.status, 2, '非补零日期退 2');
    const bad2 = cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-13-01');
    assert.equal(bad2.status, 2, '非法月份退 2');
    const bad3 = cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-02-30');
    assert.equal(bad3.status, 2, '不存在的日期退 2');
    const good = cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-01-01');
    assert.equal(good.status, 0, good.stderr);
    const subject = good.json.subjectDigest;
    writeApprovals(root, [{ approvalId: 'apr-legacy-fmt', subjectDigest: subject, role: 'accountable',
      identity: { source: 'local', verified: false, id: 'devB' }, decidedAt: '2026-09-13',
      expiresAt: '2026-9-1', conditions: [], revocation: null }]);
    // 不含 approvals：仅 warning 退 0
    patchRequiredDomains(root, []);
    const warn = cli(root, 'gate');
    assert.equal(warn.status, 0, '非法格式既存记录不构成阻断（required 未含 approvals）');
    assert.ok(warn.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-INVALID'));
    // 含 approvals：无有效审批 → MISSING blocking
    patchRequiredDomains(root, ['approvals']);
    const block = cli(root, 'gate');
    assert.equal(block.status, 1);
    assert.ok(block.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-MISSING'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run-finalize：--expect-hash CAS（openHash 匹配退 0 / 外改后不符退 2 / 形态非法退 2）', () => {
  const root = initProj();
  try {
    const begin = cli(root, 'run-begin', '--task-id', 'T-1');
    assert.equal(begin.status, 0, begin.stderr);
    const openHash = begin.json.openHash;
    assert.match(String(openHash), /^sha256:[0-9a-f]{64}$/, 'openHash 形态');
    const runId = begin.json.runId;
    const head = 'a'.repeat(40);
    const wrong = cli(root, 'run-finalize', '--run-id', runId, '--repo-head', head, '--diff-digest', HASH_OK,
      '--expect-hash', 'sha256:' + '0'.repeat(64));
    assert.equal(wrong.status, 2, 'CAS 不符须退 2（工具错，非内容退 1）');
    const malformed = cli(root, 'run-finalize', '--run-id', runId, '--repo-head', head, '--diff-digest', HASH_OK,
      '--expect-hash', 'not-a-hash');
    assert.equal(malformed.status, 2, '--expect-hash 形态非法退 2');
    // manifest 被外部改动后旧 openHash 失效 → CAS 退 2
    const runFile = join(root, '.ai-governance', 'runtime', 'runs', `${runId}.json`);
    const m = JSON.parse(readFileSync(runFile, 'utf8'));
    m.contexts = [{ source: 'external', trust: 'repository' }];
    writeFileSync(runFile, JSON.stringify(m, null, 2), 'utf8');
    const stale = cli(root, 'run-finalize', '--run-id', runId, '--repo-head', head, '--diff-digest', HASH_OK,
      '--expect-hash', openHash);
    assert.equal(stale.status, 2, 'manifest 外改后旧 openHash CAS 失败退 2');
    // 新 run 未改动 + hash 匹配 → 退 0，且 finalized manifest 记 policy/change-set digest
    const begin2 = cli(root, 'run-begin', '--task-id', 'T-2');
    const ok = cli(root, 'run-finalize', '--run-id', begin2.json.runId, '--repo-head', head,
      '--diff-digest', HASH_OK, '--expect-hash', begin2.json.openHash);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(String(ok.json.policyDigest), /^sha256:/, 'finalize 记 policyDigest');
    // finalized 后再 finalize → 退 2 且消息含「不可变」
    const again = cli(root, 'run-finalize', '--run-id', begin2.json.runId, '--repo-head', head, '--diff-digest', HASH_OK);
    assert.equal(again.status, 2, 'finalized 后再 finalize 退 2');
    assert.ok(again.stderr.includes('不可变'), 'stderr 含「不可变」');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run-finalize e2e：finalized manifest 与现算绑定不符 → gate 退 1 含 TG-MANIFEST-STALE', () => {
  const root = initProj();
  try {
    const b = cli(root, 'run-begin', '--task-id', 'T-1', '--initiator', 'devA');
    assert.equal(b.status, 0, b.stderr);
    assert.equal(cli(root, 'run-finalize', '--run-id', b.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    assert.equal(cli(root, 'gate').status, 0, '同锚 gate 退 0（与现算 binding 一致）');
    // 改 policy（policyDigest 变化）→ 最近 completed manifest 失效 → gate 退 1 含 TG-MANIFEST-STALE
    const cfg = readConfig(root);
    cfg.policy.version = 2;
    writeConfig(root, cfg);
    const g = cli(root, 'gate');
    assert.equal(g.status, 1, `policy 变化后 gate 应退 1（实测 ${g.status}：${JSON.stringify(g.json?.diagnostics)}）`);
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-MANIFEST-STALE' && d.severity === 'blocking'),
      'TG-MANIFEST-STALE 须 blocking（H7 门禁经真实 CLI 承载）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate 归属 e2e：候选池含 open＋finalized（最近 startedAt 的 open run 参与判定）', () => {
  const root = initProj();
  try {
    patchRisk(root, 'high');
    const a = cli(root, 'run-begin', '--task-id', 'T-1', '--initiator', 'devA');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(cli(root, 'run-finalize', '--run-id', a.json.runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', HASH_OK).status, 0);
    const b = cli(root, 'run-begin', '--task-id', 'T-2', '--initiator', 'devB'); // open，startedAt 更晚
    assert.equal(b.status, 0, b.stderr);
    assert.equal(cli(root, 'approve', '--identity', 'devB', '--expires-at', '2099-01-01').status, 0);
    const g = cli(root, 'gate');
    assert.equal(g.status, 1, '存在 open run 时 gate 退 1（TG-MANIFEST-OPEN）');
    assert.ok(g.json.diagnostics.some((d) => d.ruleId === 'TG-APPROVAL-SELF'),
      'open run 的 humanInitiator 须参与归属判定（devB 自批 → TG-APPROVAL-SELF）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lease 资源归一：前导空白/逗号空格归一；元素级非法与空 holder 退 2 且零写账', () => {
  const root = initProj();
  try {
    const stateFile = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
    // 归一：--resource 前导空白 → 台账存 trim 后的键（否则互斥判定与钩子前缀护栏失配）
    const padded = cli(root, 'lease', 'acquire', '--resource', ' path:main:src/**', '--holder', 'h1');
    assert.equal(padded.status, 0, '前导空白归一后照常获取');
    const st1 = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(Object.values(st1.leases).some((l) => l.resource === 'path:main:src/**' && l.holder === 'h1'),
      '台账 resource 为归一后的值（不得出现前导空格死键）');
    // 互斥判定基于归一键：再取同一非空白键必须被拒（若落死键则此支会误 ok）
    const dup = cli(root, 'lease', 'acquire', '--resource', 'path:main:src/**', '--holder', 'h2');
    assert.equal(dup.status, 1, '归一后同一 resource 冲突→内容阻断退 1');
    // 逗号空格归一：--resources 'a , b' 两个元素均 trim 后入库
    const list = cli(root, 'lease', 'acquire', '--resources', 'path:main:docs/**, path:main:tests/**', '--holder', 'h3');
    assert.equal(list.status, 0, '逗号后空格归一后照常获取');
    const st2 = JSON.parse(readFileSync(stateFile, 'utf8'));
    const holders = Object.values(st2.leases).filter((l) => l.holder === 'h3').map((l) => l.resource).sort();
    assert.deepEqual(holders, ['path:main:docs/**', 'path:main:tests/**'], '两个资源键均归一入库、无空格残留');
    // 元素级非法（旗标当值）→ 参数错退 2 且零新增写；纯空白元素（逗号尾随）显式拒绝（不静默过滤）
    const before = readFileSync(stateFile, 'utf8');
    const badElement = cli(root, 'lease', 'acquire', '--resources', 'path:main:x/**,--holder', '--holder', 'h4');
    assert.equal(badElement.status, 2, '--resources 含旗标形态元素退 2');
    const emptyHolder = cli(root, 'lease', 'acquire', '--resource', 'path:main:z/**', '--holder', '');
    assert.equal(emptyHolder.status, 2, '空 --holder 属参数错');
    assert.equal(readFileSync(stateFile, 'utf8'), before, '元素级非法与空 holder 均不得改写台账');
    const trailingComma = cli(root, 'lease', 'acquire', '--resources', 'path:main:y/**,   ', '--holder', 'h5');
    assert.equal(trailingComma.status, 2, '逗号尾随的空元素属参数错（不得静默过滤旁路元素级校验）');
    assert.equal(readFileSync(stateFile, 'utf8'), before, '逗号尾随同样零台账写');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-255 批 3（H12：内部验收-21）──

test('gate：报告落盘与 stdout 脱敏（秘密不回显＋integrityHash 可复算）', () => {
  const root = initProj();
  try {
    const ldir = join(root, '.ai-governance', 'runtime', 'learnings');
    mkdirSync(ldir, { recursive: true });
    writeFileSync(join(ldir, 'observed.jsonl'), JSON.stringify({
      learningId: 'L-1', statement: 'token=abcdef123456', owner: 'u', status: 'observed',
      evidenceReferences: ['x'], recordedAt: new Date().toISOString(),
    }) + '\n', 'utf8');
    const r = cli(root, 'gate');
    assert.equal(r.status, 0, `gate 应退 0：${r.stderr}`);
    const text = readFileSync(reportPath(root), 'utf8');
    assert.ok(!text.includes('token=abcdef123456'), '报告落盘不得含明文秘密');
    assert.ok(!r.stdout.includes('token=abcdef123456'), 'stdout 不得含明文秘密');
    const report = JSON.parse(text);
    assert.equal(verifyReport(report, { projectRoot: root }), 'passed', '脱敏后报告须可按当前项目复核为 passed');
    const body = { ...report };
    delete body.integrityHash;
    assert.equal(integrityHash(body), report.integrityHash, 'integrityHash 于脱敏后重算');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate：诊断面脱敏（坏件解析片段不回显＋非 tampered/stale）', () => {
  const root = initProj();
  try {
    const edir = join(root, '.ai-governance', 'runtime', 'evals');
    mkdirSync(edir, { recursive: true });
    // 秘密经 suiteId 进入诊断消息与报告 evals 数组（TG-EVAL-TAMPERED 点名 suiteId）——脱敏须覆盖诊断面
    writeFileSync(join(edir, 's-tamper.json'), JSON.stringify({
      schemaVersion: '1.0.0', suiteId: 'AKIAIOSFODNN7EXAMPLE', caseSetVersion: 'v1',
      subjectHash: 'sha256:' + 'a'.repeat(64), mode: 'replay', cases: [],
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, passRate: null },
    }), 'utf8');
    const r = cli(root, 'gate');
    assert.equal(r.status, 1, `坏件阻断 → gate 退 1（实测 ${r.status}：${r.stderr}）`);
    const text = readFileSync(reportPath(root), 'utf8');
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), '报告不得回显诊断面秘密');
    assert.ok(!r.stdout.includes('AKIAIOSFODNN7EXAMPLE'), 'stdout 不得回显诊断面秘密');
    const report = JSON.parse(text);
    assert.equal(report.status, 'blocked', '坏件 → blocked（非通过）');
    const verdict = verifyReport(report, { projectRoot: root });
    assert.ok(verdict !== 'tampered' && verdict !== 'stale', `不得判 tampered/stale（实得 ${verdict}）`);
    const body = { ...report };
    delete body.integrityHash;
    assert.equal(integrityHash(body), report.integrityHash, 'integrityHash 可复算');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate：结构节含秘密拒绝写报告（fail-closed）', () => {
  const root = initProj();
  try {
    const ldir = join(root, '.ai-governance', 'runtime', 'learnings');
    mkdirSync(ldir, { recursive: true });
    writeFileSync(join(ldir, 'token=abcdef123456.jsonl'), JSON.stringify({
      learningId: 'L-2', statement: '普通记录', owner: 'u', status: 'observed', evidenceReferences: ['x'],
    }) + '\n', 'utf8');
    const r = cli(root, 'gate');
    assert.equal(r.status, 2, `结构节含秘密应工具错退 2（实测 ${r.status}：${r.stderr}）`);
    assert.ok(!existsSync(reportPath(root)), '拒绝写报告（不得落盘）');
    assert.ok(/结构节|拒绝写报告/.test(r.stderr), `stderr 点名结构节 fail-closed（实得：${r.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-256 批 4（H9：run-begin --host）──

test('run-begin --host：合法值透传 client.host；非法值/旗标当值退 2 且不落 run', () => {
  const root = initProj();
  try {
    const ok = cli(root, 'run-begin', '--task-id', '内部任务-HOST-1', '--host', 'mcode');
    assert.equal(ok.status, 0, `run-begin --host mcode 应成功：${ok.stderr}`);
    const runFile = readFileSync(join(root, '.ai-governance', 'runtime', 'runs', `${ok.json.runId}.json`), 'utf8');
    assert.equal(JSON.parse(runFile).client.host, 'mcode', '--host 透传 manifest client.host');
    const bare = cli(root, 'run-begin', '--task-id', '内部任务-HOST-3', '--host');
    assert.equal(bare.status, 2, '裸 --host（无值）应参数错退 2');
    for (const bad of ['bogus', '--task-id', '']) {
      const r = cli(root, 'run-begin', '--task-id', '内部任务-HOST-2', '--host', bad);
      assert.equal(r.status, 2, `--host ${JSON.stringify(bad)} 应参数错退 2（实得 ${r.status}）`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-257（P5-4）：run-finalize incident 源不可读显式警告 ──
test('run-finalize：incident 源不可读显式警告（unavailable）', () => {
  const root = initProj();
  try {
    const begin = cli(root, 'run-begin', '--task-id', '内部任务-INCIDENT-1');
    assert.equal(begin.status, 0, begin.stderr);
    const runId = begin.json.runId;
    const openHash = begin.json.openHash;
    // incidents.jsonl 以目录形态存在 → 不可读，须显式警告且不阻断 finalize
    mkdirSync(join(root, '.workflow', 'incidents.jsonl'), { recursive: true });
    const fin = cli(root, 'run-finalize', '--run-id', runId, '--repo-head', 'a'.repeat(40),
      '--diff-digest', 'sha256:' + 'b'.repeat(64), '--expect-hash', openHash);
    assert.equal(fin.status, 0, '警告不阻断 finalize：' + fin.stderr);
    assert.match(fin.stderr, /不可读|unavailable/, 'stderr 须显式警告');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-257（P5-5）：写侧 IO 错误退 2 ──
test('learning-note：observed 落盘 IO 错误（EISDIR）→ 工具错退 2', () => {
  const root = initProj();
  try {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'incidents.jsonl'),
      JSON.stringify({ id: 'inc-io-1', status: 'open', digest: 'sha256:' + 'a'.repeat(64) }) + String.fromCharCode(10), 'utf8');
    mkdirSync(join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl'), { recursive: true });
    const r = cli(root, 'learning-note', '--statement', 'IO 错误映射验证', '--incident', 'inc-io-1');
    assert.equal(r.status, 2, '落盘 IO 失败应工具错退 2（实得 ' + r.status + '：' + r.stderr + '）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('os-observe：ack/allow 写侧 IO 错误（EISDIR）→ 工具错退 2', () => {
  const root = initProj();
  const home = mkdtempSync(join(tmpdir(), 'tg-osobs-'));
  const saved = process.env.OS_OBSERVE_HOME;
  try {
    // config.json 以目录形态存在 → 读取/写入均 EISDIR（IO 工具错误）
    mkdirSync(join(home, 'config.json'), { recursive: true });
    process.env.OS_OBSERVE_HOME = home;
    const r = cli(root, 'os-observe', 'allow', 'example.com');
    assert.equal(r.status, 2, 'os-observe allow IO 失败应工具错退 2（实得 ' + r.status + '：' + r.stderr + '）');
    // ack 与 allow/deny 共用同一 IO 映射 catch 分支（见 CLI 实现）；此处以 allow 覆盖分支语义，
    // ack 的未知 id 属内容错（退 1）由既有用例覆盖，故不在此强行构造 IO。
  } finally {
    if (saved === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-257（P5-6）：锁错误 code 映射工具错退 2 ──
test('lease：锁错误 code 映射工具错退 2', () => {
  const root = initProj();
  try {
    // leases 目录路径被普通文件占位 → mkdir/锁 IO 失败（非 EEXIST 分支）→ 工具错退 2
    rmSync(join(root, '.ai-governance', 'runtime', 'leases'), { recursive: true, force: true });
    writeFileSync(join(root, '.ai-governance', 'runtime', 'leases'), 'not-a-dir', 'utf8');
    const r = cli(root, 'lease', 'acquire', '--resource', 'repo:lock-io', '--holder', 'h');
    assert.equal(r.status, 2, '锁 IO 错误应工具错退 2（实得 ' + r.status + '：' + r.stderr + '）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-257（P5-1）：init 播种原子写 ──
test('init：播种 config 为原子写（字节与末尾换行不变）', () => {
  const root = initProj();
  try {
    const config = join(root, '.ai-governance', 'config.json');
    const first = readFileSync(config, 'utf8');
    assert.ok(first.endsWith('\n'), 'config 末尾换行');
    assert.deepEqual(readdirSync(join(root, '.ai-governance')).filter((f) => f.endsWith('.tmp')), [], '无 tmp 残留');
    const again = cli(root, 'init');
    assert.equal(again.status, 0);
    assert.equal(readFileSync(config, 'utf8'), first, '二次 init 字节不变（幂等）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

