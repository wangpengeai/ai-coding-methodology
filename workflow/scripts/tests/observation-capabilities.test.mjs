// 文件：observation-capabilities.test.mjs
// 描述：数据资产**生产读取**的行为测试（内部规则-13 / 内部决策-063 修正案 3 决策 21，2026-10-24
//       内部任务-195）——把「镜像两键被 resolver 读取」「规则表被待排查谓词读取（含 env 注入缝）」
//       「loadRules 按路径+mtime+size 缓存、clearRulesCache 唯一刷新」「maxAgeMs 毫秒口径」
//       「单参谓词兼容 rows.filter 回调」这些**生产读取事实**钉死：两条数据资产（能力域镜像
//       observation-capability-contract.json / cause 规则表 incident-classification.json）此前
//       只有测试读取或硬编码副本，是 内部未决-190 ④ 的直接缺陷面。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  CONSERVATIVE_VALUE,
  DECLARATION_GRAMMAR,
  loadContract,
  resolveCapabilities,
} from '../lib/observation-capabilities.mjs';
import { clearRulesCache, loadRules } from '../lib/incident-rules.mjs';
import { isAgedExcludedEvidence, isPendingIncidentV2 } from '../lib/incident-store.mjs';

/** 临时目录 + 自动清理。 */
function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-obs-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一份能力域镜像（只覆盖必要键；hosts 里给一个测试宿主）。 */
function mirrorWith(over = {}) {
  return {
    schemaVersion: 1,
    contractVersion: 7,
    sourceRef: 'test',
    capabilityDomains: ['failureFacts', 'hookFailure', 'injection', 'selfCheck'],
    capabilityValues: ['native', 'adapter', 'degraded', 'unavailable', 'unverified'],
    hosts: {
      testhost: { whenUndeclared: 'degraded', domains: { failureFacts: 'adapter', hookFailure: 'adapter', injection: 'native', selfCheck: 'degraded' } },
    },
    ...over,
  };
}

/** 造一份最小合法规则表（pending/evidence 两键由用例覆盖）。 */
function rulesWith(over = {}) {
  return {
    schemaVersion: 1,
    rulesVersion: 42,
    causes: ['real-failure', 'unclassified', 'probe-noise'],
    severities: ['info', 'warn', 'action'],
    pendingCauses: ['real-failure'],
    evidenceCauses: ['probe-noise', 'unclassified'],
    replayableErrorCodes: [],
    rules: [],
    ...over,
  };
}

/** 写入临时规则表并挂 env 注入缝（after 恢复 env + 清缓存）。 */
function useRulesFile(t, file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  const prev = process.env.WF_INCIDENT_RULES_PATH;
  process.env.WF_INCIDENT_RULES_PATH = file;
  clearRulesCache();
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_RULES_PATH;
    else process.env.WF_INCIDENT_RULES_PATH = prev;
    clearRulesCache();
  });
}

test('镜像 declarationGrammar/conservativeValue 被生产读取（resolver 生效）', (t) => {
  const root = tmpRoot(t);
  const file = join(root, 'contract.json');
  writeFileSync(
    file,
    JSON.stringify(
      mirrorWith({
        declarationGrammar: '^[a-z]{2,8}$',
        conservativeValue: 'unavailable',
      }),
    ),
  );
  const contract = loadContract({ path: file });
  assert.equal(contract.ok, true, '镜像可加载');
  assert.ok(contract.declarationGrammar instanceof RegExp, 'loadContract 返回解析后的镜像 grammar（生产读取）');
  assert.equal(String(contract.declarationGrammar), String(/^[a-z]{2,8}$/), 'grammar 取镜像原文');
  assert.equal(contract.conservativeValue, 'unavailable', 'conservativeValue 取镜像值');
  // env 声明值：'ABC' 不合镜像 grammar ⇒ 判非法并按镜像 conservativeValue 处理
  const bad = resolveCapabilities(JSON.stringify({ failureFacts: 'ABC' }), contract, 'testhost');
  assert.equal(bad.ok, false, '镜像 grammar 生效：不合形态即非法');
  assert.equal(bad.domains.failureFacts, 'unavailable', '非法值回退**镜像** conservativeValue（非模块常量）');
  assert.ok(bad.reasons.some((r) => r.includes('invalid-value:failureFacts')));
  // 未知宿主：四域按镜像 conservativeValue
  const unknown = resolveCapabilities(undefined, contract, 'nohost');
  assert.deepEqual(unknown.domains, { failureFacts: 'unavailable', hookFailure: 'unavailable', injection: 'unavailable', selfCheck: 'unavailable' });
  // 合法声明：'adapter' 满足窄 grammar，零降级
  const ok = resolveCapabilities(JSON.stringify({ failureFacts: 'adapter', hookFailure: 'adapter', injection: 'native', selfCheck: 'native' }), contract, 'testhost');
  assert.equal(ok.ok, true);
  assert.equal(ok.degraded, false);
});

test('镜像缺省/坏镜像回退模块常量（fail-open，不抛）', (t) => {
  const root = tmpRoot(t);
  const missing = join(root, 'missing.json');
  assert.deepEqual(loadContract({ path: missing }), { ok: false }, '缺文件 ⇒ ok:false');
  const badGrammar = join(root, 'bad-grammar.json');
  writeFileSync(badGrammar, JSON.stringify(mirrorWith({ declarationGrammar: '([', conservativeValue: 42 })));
  const c = loadContract({ path: badGrammar });
  assert.equal(c.ok, true, '坏 grammar 键不拖垮整份镜像（单键回退）');
  assert.equal(String(c.declarationGrammar), String(DECLARATION_GRAMMAR), '坏 grammar ⇒ 模块常量');
  assert.equal(c.conservativeValue, CONSERVATIVE_VALUE, '非法 conservativeValue ⇒ 模块常量');
  const resolved = resolveCapabilities(undefined, c, 'nohost');
  assert.equal(resolved.domains.failureFacts, CONSERVATIVE_VALUE, 'resolver 用回退常量');
  // 整份坏镜像：resolver 保守态
  const broken = resolveCapabilities(undefined, { ok: false }, 'dsh');
  assert.equal(broken.source, 'conservative');
  assert.equal(broken.degraded, true);
});

test('规则表 pendingCauses 被谓词生产读取（env 注入缝 WF_INCIDENT_RULES_PATH）', (t) => {
  const root = tmpRoot(t);
  const file = join(root, 'rules.json');
  // 默认表口径：unclassified 属待排查；probe-noise 属证据面
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'unclassified' }), true, '默认表：unclassified 待排查');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'probe-noise' }), false, '默认表：probe-noise 证据面');
  // 注入临时表：pendingCauses 只留 real-failure；证据面包含 unclassified
  useRulesFile(t, file, rulesWith());
  assert.equal(loadRules().rulesVersion, 42, 'env 注入缝生效：读临时表');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'unclassified' }), false, 'pendingCauses 变化后谓词随之变化（生产读取）');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'real-failure' }), true);
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'probe-noise' }), false);
  // 老化谓词同源：unclassified 在临时表属证据面 ⇒ 超龄可归档
  const now = 10_000_000;
  const rec = { status: 'open', cause: 'unclassified', ts: now - 5000 };
  assert.equal(isAgedExcludedEvidence(rec, now, 1000), true, 'evidenceCauses 生产读取（unclassified 证据面）');
  // 显式证据集读取（防「!isPending」补集假覆盖）：临时表证据集为空 ⇒ 内置证据类 probe-noise 也不得归档。
  const tempNoProbe = { schemaVersion: 1, rulesVersion: 43, causes: ['real-failure', 'probe-noise'], severities: ['info'], pendingCauses: ['real-failure'], evidenceCauses: [], replayableErrorCodes: [], rules: [] };
  useRulesFile(t, file, tempNoProbe);
  assert.equal(isAgedExcludedEvidence({ status: 'open', cause: 'probe-noise', ts: now - 5000 }, now, 1000), false, '证据集为空时 probe-noise 不得按内置常量归档（显式读取规则表）');
  assert.equal(isAgedExcludedEvidence({ ...rec, ts: now - 10 }, now, 1000), false, 'maxAgeMs 毫秒口径：未超龄不归档');
  assert.equal(isAgedExcludedEvidence({ ...rec, status: 'resolved' }, now, 1000), false);
});

test('loadRules 缓存：路径+mtime+size 命中，clearRulesCache 唯一刷新', (t) => {
  const root = tmpRoot(t);
  const file = join(root, 'rules.json');
  useRulesFile(t, file, rulesWith());
  assert.equal(loadRules().rulesVersion, 42, '首读落缓存');
  // 删除源文件后第二次调用仍命中缓存（不得读到回退表——否则「缓存」名不符实）
  rmSync(file);
  assert.equal(loadRules().rulesVersion, 42, '删除源文件后仍命中缓存（mtime+size 命中口径 + 文件消失不强制重读）');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'unclassified' }), false, '谓词同样命中缓存视图');
  // clearRulesCache 后重读：文件已删 ⇒ 回退内置常量（unclassified 回待排查面）
  clearRulesCache();
  assert.equal(loadRules().ok, false, '清缓存且文件缺失 ⇒ 回退内置常量 ok:false');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'unclassified' }), true, '回退常量后 unclassified 回待排查');
  // 重新写文件（mtime+size 变化）⇒ 缓存自动失效读到新内容
  writeFileSync(file, JSON.stringify(rulesWith({ rulesVersion: 43 })));
  assert.equal(loadRules().rulesVersion, 43, '内容变化（mtime+size 变）⇒ 缓存键不命中，读到新版本');
});

test('isPendingIncidentV2 单参公开签名：直调与 rows.filter 回调两态一致（无第二参默认值）', () => {
  const rows = [
    { id: 'a', status: 'open', cause: 'unclassified', kind: 'tool-failure' },
    { id: 'b', status: 'open', cause: 'probe-noise', kind: 'tool-failure' },
    { id: 'c', status: 'open', kind: 'lease-deny' }, // 无 cause ⇒ 旧两层回退（kind 排除面）
    { id: 'd', status: 'resolved', cause: 'real-failure' },
    { id: 'e', status: 'open', kind: 'tool-failure', errorClass: 'error-flag' }, // 无 cause ⇒ 旧两层回退（计入）
  ];
  const direct = rows.map((r) => isPendingIncidentV2(r));
  const viaFilter = rows.filter(isPendingIncidentV2).map((r) => r.id);
  assert.deepEqual(direct, [true, false, false, false, true], '直调面');
  assert.deepEqual(viaFilter, ['a', 'e'], 'filter 回调面（index 被当第二参传入也不得抛错/改变判定）');
  assert.equal(isPendingIncidentV2(null), false);
  assert.equal(isPendingIncidentV2('x'), false);
});

test('规则表坏表回退：谓词不抛且按内置常量（保守）', (t) => {
  const root = tmpRoot(t);
  const file = join(root, 'rules.json');
  writeFileSync(file, '{bad json');
  const prev = process.env.WF_INCIDENT_RULES_PATH;
  process.env.WF_INCIDENT_RULES_PATH = file;
  clearRulesCache();
  t.after(() => {
    if (prev === undefined) delete process.env.WF_INCIDENT_RULES_PATH;
    else process.env.WF_INCIDENT_RULES_PATH = prev;
    clearRulesCache();
  });
  assert.equal(loadRules().ok, false);
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'real-failure' }), true, '坏表 ⇒ 内置 pendingCauses（保守不静默排除）');
  assert.equal(isPendingIncidentV2({ status: 'open', cause: 'probe-noise' }), false);
});

// ── 内部任务-244 Q12：镜像 capabilityDomains/capabilityValues 由生产 resolver 驱动与校验 ──

test('内部任务-244 Q12：resolver 以镜像域集为准且按五态词表校验（非法值回落保守并 degraded）', (t) => {
  const root = tmpRoot(t);
  const file = join(root, 'contract.json');
  // 自定义域集（缺 injection/selfCheck）＋一个非法五态值
  const contract = mirrorWith({
    capabilityDomains: ['failureFacts', 'hookFailure'],
    hosts: {
      testhost: {
        whenUndeclared: 'native',
        domains: { failureFacts: 'native', hookFailure: 'bogus-value' },
      },
    },
  });
  writeFileSync(file, JSON.stringify(contract));
  const loaded = loadContract({ path: file });
  assert.equal(loaded.ok, true);
  const res = resolveCapabilities(undefined, loaded, 'testhost');
  assert.deepEqual(Object.keys(res.domains).sort(), ['failureFacts', 'hookFailure'], '域集由镜像驱动（模块常量不再是唯一事实源）');
  assert.equal(res.domains.failureFacts, 'native', '合法镜像值原样采用');
  assert.equal(res.domains.hookFailure, CONSERVATIVE_VALUE, '非法五态值回落保守值');
  assert.ok(res.reasons.includes('invalid-mirror-value:hookFailure'), '非法镜像值留原因');
  assert.equal(res.degraded, true, '非法镜像值 ⇒ degraded 可见');
});

// ── 内部任务-356：真实镜像的 MCode 钩失败观测面复评（内部任务-354 真机实测驱动） ──
// 为什么钉真实镜像而不是再造夹具：本批改的是**登记值**本身，夹具只能证明 resolver 会读，
// 证明不了登记表已按实测改口（内部任务-354 前该格为 unavailable，实测后降级面存在）。
test('内部任务-356：真实镜像 MCode 钩失败观测面＝degraded 且保守缺省不变', () => {
  const loaded = loadContract();
  assert.equal(loaded.ok, true, '真实镜像可装载');
  const mcode = loaded.hosts.mcode;
  assert.ok(mcode && typeof mcode === 'object', '真实镜像含 mcode 宿主条目');
  assert.equal(mcode.domains.hookFailure, 'degraded', '钩失败观测面降级可用（适配层诊断＋宿主 HOOK_TIMEOUT，仅超时类）');
  assert.equal(mcode.whenUndeclared, 'degraded', '保守缺省不因本次改口而抬升');
  // 边界：失败事实供给仍不可用（roll-up 因「任一域不可用→不可用」而保持不可用）
  assert.equal(mcode.domains.failureFacts, 'unavailable', '① 失败事实供给仍不可用（内部任务-354 四次探针账本零增量）');
});
