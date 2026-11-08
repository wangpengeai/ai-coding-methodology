// 文件：task-lease.test.mjs
// 描述：prompt-epoch 任务租约单元测试（内部决策-018 / 内部规则-8）——挑战签发、激活、
//       会话内失效、双会话并存、错误 leaseId、TTL 过期、项目隔离、legacy 共存、
//       Bash bootstrap 严格解析、仓键发现（W3 丙案）、键 canonical 归一
//       （内部任务-MACKEY-1，2026-09-25：macOS symlink 形态分裂修复）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 workflow/LICENSE）
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  issueChallenge,
  activateLease,
  readActiveLease,
  rollbackActivation,
  isBootstrapDeclareCommand,
  bootstrapRejectHint,
  isReadOnlyCommand,
  isPureCdCommand,
  normalizeScopeEntries,
  currentChallengeToken,
  discoverRepoKeys,
  newestActiveLease,
  readDomainRequests,
  findChallengeIssuance,
  normalizeProjectSkills,
  challengeOwnerInfo,
} from '../../hooks/task-lease-lib.mjs';
import { projectKey } from '../../hooks/routing-lib.mjs';
import * as leaseLib from '../../hooks/task-lease-lib.mjs';
import { loadRules } from '../lib/incident-rules.mjs';

const DECLARE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');

/** symlink 可用性一次性探测：Windows 无开发者模式/管理员时 symlinkSync 抛 EPERM——
 * 键归一是平台特定缺陷（macOS），其余平台以基线回归覆盖，此处跳过不构成漏测。 */
const CAN_SYMLINK = (() => {
  try {
    const probe = join(tmpdir(), `wf-key-symlink-probe-${process.pid}`);
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

/** v3 状态文件名推算（与 lib 内部算法一致：sha256 前 16 位）。 */
function digest(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}
const challengePath = (stateDir, token) => join(stateDir, `wf-lease-challenge-${token}.json`);
const activePath = (stateDir, token) => join(stateDir, `wf-lease-active-${token}.json`);

/** 构造隔离状态目录的测试环境（内部任务-27 起同时接管事件账根 WF_INCIDENT_ROOT——absent-at-activate/
 * 读侧损坏取证埋点会在任何激活失败/读侧损坏用例中追加 incident，不接管则泄漏到真实文件系统根，
 * 阶段复审正确性发现 1/简洁性发现 1：泄漏还会点燃同文件既有用例族）。 */
function freshEnv() {
  const home = mkdtempSync(join(tmpdir(), 'wf-lease-test-'));
  const prev = process.env.WF_ROUTING_STATE_DIR;
  const prevIncident = process.env.WF_INCIDENT_ROOT;
  process.env.WF_ROUTING_STATE_DIR = join(home, 'state');
  process.env.WF_INCIDENT_ROOT = join(home, 'ir');
  return {
    home,
    restore() {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
      if (prevIncident === undefined) delete process.env.WF_INCIDENT_ROOT;
      else process.env.WF_INCIDENT_ROOT = prevIncident;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('挑战签发后激活租约，当前 prompt 内有效', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a');
    assert.ok(ch.leaseId);
    assert.ok(ch.promptEpoch >= 1);
    const act = activateLease('/proj/a', {
      leaseId: ch.leaseId,
      taskId: '内部任务-1',
      skill: 'plan-execution',
    });
    assert.equal(act.ok, true);
    const cur = readActiveLease('/proj/a');
    assert.equal(cur.valid, true);
    assert.equal(cur.lease.taskId, '内部任务-1');
    assert.equal(cur.lease.skill, 'plan-execution');
  } finally {
    env.restore();
  }
});

test('下一 prompt 签发新挑战后，旧租约失效（会话桶强形态，内部决策-018 决策 4）', () => {
  const env = freshEnv();
  try {
    const ch1 = issueChallenge('/proj/a', { sessionId: 'sess-r1' });
    activateLease('/proj/a', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-r1' }).valid, true);
    issueChallenge('/proj/a', { sessionId: 'sess-r1' }); // 本会话新 prompt：旧租约必须立刻失效
    const after = readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-r1' });
    assert.equal(after.valid, false);
    assert.equal(after.reason, '挑战未激活（当前令牌尚未声明）', '轮换后新令牌从未激活→报「挑战未激活」而非「状态损坏」（评审处置：正确性发现 1；2026-09-26 内部任务-LEASEATT-1 细分）');
    // 旧 leaseId 不能激活（已随轮换吊销）
    const re = activateLease('/proj/a', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(re.ok, false);
  } finally {
    env.restore();
  }
});

test('null 桶弱形态（内部决策-018 修正案 2026-09-22）：轮换不吊销，旧租约与旧 token 按 TTL 存活（内部任务-LEASEGATE-1 F1/F2）', () => {
  const env = freshEnv();
  try {
    const ch1 = issueChallenge('/proj/a'); // 双侧不可见（宿主负载 session_id 缺位形态）
    activateLease('/proj/a', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(readActiveLease('/proj/a').valid, true, '无观察会话标识走 null 桶');
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-X' }).valid, true, '仅观察侧可见时回退 null 桶');
    issueChallenge('/proj/a'); // null 桶轮换——可能是任一无标识会话的消息，不得跨会话吊销
    assert.equal(readActiveLease('/proj/a').valid, true, 'null 桶轮换后旧租约仍有效（扫描回退命中旧 active）');
    const re = activateLease('/proj/a', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(re.ok, true, 'null 桶旧 token TTL 内可再激活（连带语义变化，内部决策-018 修正案 ③）');
  } finally {
    env.restore();
  }
});

test('错误 leaseId / taskId 非法 / skill 名非法均拒绝激活', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a');
    assert.equal(activateLease('/proj/a', { leaseId: 'bogus', taskId: '内部任务-1', skill: 'tdd' }).ok, false);
    assert.equal(activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '', skill: 'tdd' }).ok, false);
    assert.equal(activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'Bad_Name' }).ok, false);
    assert.equal(readActiveLease('/proj/a').valid, false);
  } finally {
    env.restore();
  }
});

test('挑战/租约 TTL 过期后失效', () => {
  const env = freshEnv();
  const prevTtl = process.env.WF_ROUTING_TTL_MS;
  try {
    process.env.WF_ROUTING_TTL_MS = '1000';
    const ch = issueChallenge('/proj/a');
    activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(readActiveLease('/proj/a', Date.now() + 5000).valid, false);
  } finally {
    if (prevTtl === undefined) delete process.env.WF_ROUTING_TTL_MS;
    else process.env.WF_ROUTING_TTL_MS = prevTtl;
    env.restore();
  }
});

test('项目之间租约互相隔离', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/a');
    issueChallenge('/proj/b');
    const act = activateLease('/proj/a', { leaseId: chA.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(act.ok, true);
    assert.equal(readActiveLease('/proj/b').valid, false);
  } finally {
    env.restore();
  }
});

test('跨会话（sessionId 双边可见且不同）不得复用租约', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a', { sessionId: 'sess-1' });
    activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-1' }).valid, true);
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-2' }).valid, false);
  } finally {
    env.restore();
  }
});

test('状态损坏/未来时间一律无效（fail-safe 拒绝）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a');
    activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    const stateFile = join(process.env.WF_ROUTING_STATE_DIR, 'wf-lease-challenge-x.json');
    // 直接破坏 challenge 文件内容（定位真实文件名由 lib 内部决定，此处删整个状态目录模拟损坏）
    rmSync(process.env.WF_ROUTING_STATE_DIR, { recursive: true, force: true });
    mkdirSync(process.env.WF_ROUTING_STATE_DIR, { recursive: true });
    assert.equal(readActiveLease('/proj/a').valid, false);
  } finally {
    env.restore();
  }
});

// ── W2①（2026-09-16 租约族缺陷批次）：补签自救 ──

test('bootstrap 词法放行 --bootstrap-reissue 子命令形态（含空白引号），元字符拒绝', () => {
  // 子命令形态：单条 node 命令 + 旗标值（含空白目标仓根须双引号——与 cd 两段同款引号词法）
  assert.equal(isBootstrapDeclareCommand('node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue /opt/repos/main'), true);
  assert.equal(
    isBootstrapDeclareCommand('node "/opt/wf with space/hooks/routing-declare.mjs" --bootstrap-reissue "/opt/repos/my repo"'),
    true,
  );
  // cd 两段 + 子命令（嵌套仓键补签的第一出路）
  assert.equal(isBootstrapDeclareCommand('cd "D:/a b/main" && node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue "/D:/a b/nested"'), true);
  // B3（内部任务-2 批）：&& 前后多空白（双空格）同属合法形态——旧正则字面 ` && ` 误拒
  assert.equal(isBootstrapDeclareCommand('cd "D:/a b/main"  && node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue "/D:/a b/nested"'), true, '&& 前双空格应放行');
  assert.equal(isBootstrapDeclareCommand('cd /opt/repos/main  && node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue /opt/repos/nested'), true, '无引号目标双空格同样放行');
  // 负例：元字符注入面照旧全拒
  for (const bad of [
    'node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue /x $(echo hi)',
    'node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue /x; touch y',
    'node /opt/wf/hooks/routing-declare.mjs --bootstrap-reissue "/x`id`"',
  ]) {
    assert.equal(isBootstrapDeclareCommand(bad), false, `应拒绝: ${bad}`);
  }
});

test('activateLease 过期拒因附补签指引（W2①：deny/声明失败文案的可执行出路）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/g');
    const file = challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId);
    const mutated = JSON.parse(readFileSync(file, 'utf8'));
    mutated.expiresAt = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(mutated));
    const r = activateLease('/proj/g', { leaseId: ch.leaseId, taskId: '内部任务-9', skill: 'tdd' });
    assert.equal(r.ok, false);
    assert.ok(String(r.reason).includes('--bootstrap-reissue'), '过期拒因须内嵌补签指引');
  } finally {
    env.restore();
  }
});

test('newestActiveLease：主键最新有效租约（补签前置数据源），过期/他键不命中', () => {
  const env = freshEnv();
  try {
    assert.equal(newestActiveLease('/proj/h'), null, '无租约时 null');
    const ch1 = issueChallenge('/proj/h', { sessionId: 'sess-H' });
    activateLease('/proj/h', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    const best = newestActiveLease('/proj/h');
    assert.ok(best, '有效租约命中');
    assert.equal(best.sessionId, 'sess-H', '返回签发方 sessionId（补签继承用）');
    assert.equal(best.taskId, '内部任务-1');
    const chOther = issueChallenge('/proj/other');
    activateLease('/proj/other', { leaseId: chOther.leaseId, taskId: '内部任务-2', skill: 'tdd' });
    assert.equal(newestActiveLease('/proj/h').taskId, '内部任务-1', '他键租约不串扰');
  } finally {
    env.restore();
  }
});

test('bootstrap 严格解析：仅放行单条 routing-declare 命令', () => {
  const ok = 'node /opt/workflow/hooks/routing-declare.mjs tdd --lease abc --task-id 内部任务-1';
  assert.equal(isBootstrapDeclareCommand(ok), true);
  // 相对路径/引号路径同样是合法单条命令
  assert.equal(isBootstrapDeclareCommand('node "hooks/routing-declare.mjs" tdd'), true);
  // 内部未决-94（内部任务-50）：注入命令自本批起为单引号形态——解析器双引号/单引号双接受
  // （旧双引号命令继续放行，历史注入文本与肌肉记忆不失效）。
  assert.equal(isBootstrapDeclareCommand("node 'hooks/routing-declare.mjs' tdd"), true, '单引号路径成单 token 且剥引号后命中');
  assert.equal(
    isBootstrapDeclareCommand("node '/opt/wf with space/hooks/routing-declare.mjs' tdd"),
    true,
    '含空格单引号路径成单 token（与双引号同权）',
  );
  assert.equal(
    isBootstrapDeclareCommand("node '/x/y$routing-declare.mjs' tdd", '/x/y$routing-declare.mjs'),
    true,
    '单引号内 $ 惰性 + expectedScript resolve 钉死（内部未决-94 的核心收益面）',
  );
  assert.equal(
    isBootstrapDeclareCommand("node '/x/y`routing-declare.mjs' tdd", '/x/y`routing-declare.mjs'),
    false,
    '反引号仍被 SHELL_META_RE 原串拒（保守面不放宽）',
  );
  const bad = [
    'node /opt/workflow/hooks/routing-declare.mjs tdd; touch x',
    'node /opt/workflow/hooks/routing-declare.mjs tdd | cat',
    'node /opt/workflow/hooks/routing-declare.mjs tdd > out.txt',
    'node /opt/workflow/hooks/routing-declare.mjs tdd $(echo hi)',
    'node /opt/workflow/hooks/routing-declare.mjs tdd `id`',
    'node /opt/workflow/hooks/routing-declare.mjs tdd & bg',
    'echo hi && node /opt/workflow/hooks/routing-declare.mjs tdd',
    'bash -c "node routing-declare.mjs tdd"',
    'rm -rf /',
    '',
  ];
  for (const cmd of bad) assert.equal(isBootstrapDeclareCommand(cmd), false, `应拒绝: ${cmd}`);
});

// ── P5（2026-10-10 内部任务-29 / 内部任务-103 P5）：纯声明命令顺序拼接 ──
// 双仓双键工作区每轮需对两键各声明一次；引号外 `;`/`&&`/换行拼接的多条纯声明
// 命令逐段独立严格解析后放行（内部规则-9 扩），混入非声明命令/空段/裸 `&` 整体拒。

test('P5 bootstrap 链式：多条纯声明 `;`/`&&`/换行拼接放行；cd 前缀并存放行；混入非声明/空段/裸 & 拒', () => {
  const A = 'node /opt/wf/hooks/routing-declare.mjs brainstorming --lease t1 --task-id 内部任务-1';
  const B = 'node /opt/wf/hooks/routing-declare.mjs code-review --lease t2 --task-id 内部任务-2';
  assert.equal(isBootstrapDeclareCommand(`${A}; ${B}`), true, '; 拼接放行');
  assert.equal(isBootstrapDeclareCommand(`${A} && ${B}`), true, '&& 拼接放行');
  assert.equal(isBootstrapDeclareCommand(`${A}\n${B}`), true, '换行拼接放行');
  assert.equal(isBootstrapDeclareCommand(`cd /opt/repo && ${A}; ${B}`), true, 'cd 两段 + 链式并存（cd 前缀只作用首段）');
  assert.equal(isBootstrapDeclareCommand(`${A}; cd /opt/repo2 && ${B.replace('内部任务-1', '内部任务-2')}`), true, '链中 cd 段（; 后带空格的段首空白）——三维评审处置：trim 段首后 CD 两段仍命中');
  assert.equal(isBootstrapDeclareCommand(`${A}; ls`), false, '段内混入非声明命令 → 整体拒');
  assert.equal(isBootstrapDeclareCommand(`${A};`), false, '尾随分隔符（空段）→ 拒');
  assert.equal(isBootstrapDeclareCommand(`${A} & ${B}`), false, '裸 &（后台）→ 拒');
  assert.equal(isBootstrapDeclareCommand(`echo x; ${A}`), false, '首段非声明 → 拒');
  assert.equal(isBootstrapDeclareCommand(`${A} | tee log`), false, '管道 → 拒');
  assert.equal(isBootstrapDeclareCommand('node /opt/wf/hooks/routing-declare.mjs tdd --exempt "a;b"'), false, '引号内分号与单命令口径一致（链式不放宽既有禁面）');
});

test('P5 bootstrap 链式：expectedScript 钉死面逐段生效（任一段非本插件脚本即拒）', () => {
  const A = 'node /opt/wf/hooks/routing-declare.mjs brainstorming --lease t1 --task-id 内部任务-1';
  const alien = 'node /other/hooks/routing-declare.mjs code-review --lease t2 --task-id 内部任务-2';
  assert.equal(isBootstrapDeclareCommand(`${A}; ${alien}`, '/opt/wf/hooks/routing-declare.mjs'), false, '段二非预期脚本 → 拒');
  assert.equal(isBootstrapDeclareCommand(`${A}; ${A.replace('brainstorming', 'tdd')}`, '/opt/wf/hooks/routing-declare.mjs'), true, '两段均为预期脚本 → 放行');
});

test('bootstrap cd 两段：双引号包裹的含空白目标放行（内部未决-10），引号内元字符拒绝', () => {
  // 正例：含空白路径须双引号包裹（Windows 常见形态 C:\Program Files\… / D:/a b/c）
  assert.equal(isBootstrapDeclareCommand('cd "C:\\Program Files\\workflow" && node "hooks/routing-declare.mjs" tdd'), true);
  assert.equal(isBootstrapDeclareCommand('cd "D:/a b/c" && node hooks/routing-declare.mjs tdd'), true);
  // 无空白目标裸写仍放行（向后兼容）
  assert.equal(isBootstrapDeclareCommand('cd /opt/repo && node hooks/routing-declare.mjs tdd'), true);
  // 负例：引号内 $ / 反引号（bash 双引号展开面——cd 目标无 resolve 核验，必须禁）
  assert.equal(isBootstrapDeclareCommand('cd "C:\\x$HOME" && node hooks/routing-declare.mjs tdd'), false);
  assert.equal(isBootstrapDeclareCommand('cd "C:\\x`id`" && node hooks/routing-declare.mjs tdd'), false);
  assert.equal(isBootstrapDeclareCommand('cd "C:\\x"y" && node hooks/routing-declare.mjs tdd'), false);
  // 负例：引号内须绝对路径起笔（相对路径+引号形态不放行，内部规则-8「限绝对路径」总述）
  assert.equal(isBootstrapDeclareCommand('cd "relative dir" && node /opt/workflow/hooks/routing-declare.mjs tdd'), false);
  // 负例：含空白裸写（无引号）仍拒
  assert.equal(isBootstrapDeclareCommand('cd C:\\a b && node hooks/routing-declare.mjs tdd'), false);
});

test('bootstrap hint（内部未决-10 收窄）：cd 段合法而第二段带元字符 → 回落纯净单命令文案，不误指引号', () => {
  const h1 = bootstrapRejectHint('cd "C:/Program Files/repo" && node "x/routing-declare.mjs" tdd | cat');
  assert.ok(h1.includes('管道') || h1.includes('纯净'), '真因在第二段元字符——须拿到纯净单命令指引');
  assert.ok(!h1.includes('双引号'), '不得误指引号（用户已用双引号）');
  // cd 目标未匹配（含空白裸写）→ 引号专项指引
  const h2 = bootstrapRejectHint('cd C:/a b && node x/routing-declare.mjs tdd');
  assert.ok(h2.includes('双引号'), '含空白未加引号——引导双引号包裹（内部未决-10）');
});

// ── 内部决策-018：per-session capability 租约 ──

test('内部决策-018 双会话各自声明后同时有效（per-session 核心）', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    const chB = issueChallenge('/proj/a', { sessionId: 'sess-B' });
    assert.equal(activateLease('/proj/a', { leaseId: chA.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok, true);
    assert.equal(activateLease('/proj/a', { leaseId: chB.leaseId, taskId: '内部任务-2', skill: 'tdd' }).ok, true);
    const a = readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' });
    const b = readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-B' });
    assert.equal(a.valid, true, '会话 A 租约有效');
    assert.equal(b.valid, true, '会话 B 租约同时有效');
    assert.equal(a.lease.taskId, '内部任务-1');
    assert.equal(b.lease.taskId, '内部任务-2');
  } finally {
    env.restore();
  }
});

test('内部决策-018 会话 A 新 prompt 只失效 A，不失效 B', () => {
  const env = freshEnv();
  try {
    const chA1 = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    const chB = issueChallenge('/proj/a', { sessionId: 'sess-B' });
    activateLease('/proj/a', { leaseId: chA1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    activateLease('/proj/a', { leaseId: chB.leaseId, taskId: '内部任务-2', skill: 'tdd' });
    issueChallenge('/proj/a', { sessionId: 'sess-A' }); // A 的新 prompt
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' }).valid, false, 'A 的旧租约随本会话轮换失效');
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-B' }).valid, true, 'B 不受影响');
    // 旧 token 随轮换吊销（桶内轮换即吊销，不等 TTL）
    const re = activateLease('/proj/a', { leaseId: chA1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    assert.equal(re.ok, false, '旧 token 已随本会话轮换吊销');
  } finally {
    env.restore();
  }
});

test('内部决策-018 跨会话重放结构性无效：B 激活 A 的 token 后 B 桶无租约', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    // B 拿着 A 的 token 声明：激活写入 A 桶，B 一无所获
    assert.equal(activateLease('/proj/a', { leaseId: chA.leaseId, taskId: '内部任务-9', skill: 'tdd' }).ok, true);
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-B' }).valid, false);
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' }).valid, true);
  } finally {
    env.restore();
  }
});

// ── 加固批次（2026-09-13）：A2 指针悬空 reason 细分（D3 撞号例随 内部未决-76 升级阻断，
//    断言并入文件尾「内部未决-76 撞号阻断」例——评审处置：合并重叠断言面） ──

test('指针悬空 reason 细分：current 指针在而挑战文件缺失 → 专属 reason', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/d', { sessionId: 'sess-D' });
    rmSync(challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), { force: true });
    const cur = readActiveLease('/proj/d', Date.now(), { sessionId: 'sess-D' });
    assert.equal(cur.valid, false);
    assert.ok(String(cur.reason ?? '').includes('指针悬空'), '悬空指针不得报笼统「状态缺失或损坏」');
    assert.ok(String(cur.reason ?? '').includes('重新签发'), 'reason 内嵌可执行指引');
  } finally {
    env.restore();
  }
});

test('过期挑战不得作为 deny 文案「本轮 leaseId」数据源（W1：照指引必败死循环）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/e', { sessionId: 'sess-E' });
    assert.equal(currentChallengeToken('/proj/e', 'sess-E')?.leaseId, ch.leaseId, '未过期时正常给出本轮令牌');
    // 模拟 TTL 过期：挑战文件存在但 expiresAt 已过（current 指针仍在，未被清扫）
    const file = challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId);
    const mutated = JSON.parse(readFileSync(file, 'utf8'));
    mutated.expiresAt = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(mutated));
    assert.equal(
      currentChallengeToken('/proj/e', 'sess-E'),
      null,
      '过期挑战须返回 null——deny 文案落到「等待下一条用户消息重新签发」占位分支',
    );
    // 会话桶为 null（内部决策-018 双侧不可见）时同口径
    const ch2 = issueChallenge('/proj/f');
    const file2 = challengePath(process.env.WF_ROUTING_STATE_DIR, ch2.leaseId);
    const mutated2 = JSON.parse(readFileSync(file2, 'utf8'));
    mutated2.expiresAt = Date.now() - 1000;
    writeFileSync(file2, JSON.stringify(mutated2));
    assert.equal(currentChallengeToken('/proj/f'), null, 'null 桶过期挑战同样不得给出过期令牌');
  } finally {
    env.restore();
  }
});

// ── P2/P8（2026-10-10 内部任务-29 / 内部任务-103 P2/P8 实录）：null 桶撞号覆盖与文案分诊 ──
// bootstrap-reissue 补签激活的 claim 恒挂 null 桶（D1/内部决策-018 修正案）——补签后令牌
// 轮换，真会话同号重声明撞上 null 占位时「同号幂等覆盖」失配即被卡死（release 三
// 作用域均不可达）。修复＝null 持有者不构成撞号（可被具名会话/新补签幂等覆盖接管），
// 具名持有者互斥不变；撞号文案改双路指引（延续同号 vs 顺延取号）。

/** 直读 claim 文件（readClaim 未导出——按 lib 内部命名算法 `wf-lease-claim-<keyDigest>-<taskIdDigest>`）。 */
function claimOf(key, taskId) {
  const file = join(process.env.WF_ROUTING_STATE_DIR, `wf-lease-claim-${digest(key)}-${digest(`t:${taskId}`)}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('P2 null 桶占位 × 具名会话同号重声明 → 幂等覆盖放行且 claim 更新为具名会话', () => {
  const env = freshEnv();
  try {
    // 补签形态：挑战挂 null 桶（sessionId 无）→ claim 落 null
    const chNull = issueChallenge('/proj/p2a');
    assert.equal(activateLease('/proj/p2a', { leaseId: chNull.leaseId, taskId: '内部任务-7', skill: 'tdd' }).ok, true);
    assert.equal(claimOf('/proj/p2a', '内部任务-7').sessionId, null, '前置：补签占位 claim 恒挂 null 桶');
    // 令牌轮换后真会话（具名）以同任务号重声明——不得被 null 占位卡死
    const chReal = issueChallenge('/proj/p2a', { sessionId: 'sess-real' });
    const r = activateLease('/proj/p2a', { leaseId: chReal.leaseId, taskId: '内部任务-7', skill: 'tdd' });
    assert.equal(r.ok, true, 'null 桶持有者不构成撞号（可幂等覆盖接管）');
    assert.equal(claimOf('/proj/p2a', '内部任务-7').sessionId, 'sess-real', 'claim 更新为具名会话');
  } finally {
    env.restore();
  }
});

test('P2 null 占位 × 新补签（null 会话）同号重声明 → 放行（既有 null==null 幂等保持）', () => {
  const env = freshEnv();
  try {
    const ch1 = issueChallenge('/proj/p2b');
    assert.equal(activateLease('/proj/p2b', { leaseId: ch1.leaseId, taskId: '内部任务-8', skill: 'tdd' }).ok, true);
    const ch2 = issueChallenge('/proj/p2b');
    const r = activateLease('/proj/p2b', { leaseId: ch2.leaseId, taskId: '内部任务-8', skill: 'tdd' });
    assert.equal(r.ok, true, 'null==null 幂等覆盖既有语义不回归');
  } finally {
    env.restore();
  }
});

test('P2/P8 具名 A 占用 × 具名 B 同号 → 仍阻断，文案含双路指引与 TTL 时刻', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/p2c', { sessionId: 'sess-A' });
    assert.equal(activateLease('/proj/p2c', { leaseId: chA.leaseId, taskId: '内部任务-9', skill: 'tdd' }).ok, true);
    const chB = issueChallenge('/proj/p2c', { sessionId: 'sess-B' });
    const r = activateLease('/proj/p2c', { leaseId: chB.leaseId, taskId: '内部任务-9', skill: 'tdd' });
    assert.equal(r.ok, false, '具名持有者互斥不变');
    const reason = String(r.reason ?? '');
    assert.ok(reason.includes('撞号阻断'), '撞号事实在案');
    assert.ok(reason.includes('延续本任务'), '双路指引：延续同号路径在案');
    assert.ok(reason.includes('取最小未用号'), '双路指引：取号路径在案（内部任务-117 稠密措辞）');
    assert.ok(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/.test(reason), 'TTL 过期时刻可判（等 TTL 的出路可执行）');
    assert.ok(reason.includes('--release'), '原会话释放出路在案');
  } finally {
    env.restore();
  }
});

test('P2 具名 A 占用 × 具名 A 同号 → 幂等覆盖放行（既有行为零回归）', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/p2d', { sessionId: 'sess-A' });
    assert.equal(activateLease('/proj/p2d', { leaseId: chA.leaseId, taskId: '内部任务-10', skill: 'tdd' }).ok, true);
    const chA2 = issueChallenge('/proj/p2d', { sessionId: 'sess-A' });
    const r = activateLease('/proj/p2d', { leaseId: chA2.leaseId, taskId: '内部任务-10', skill: 'tdd' });
    assert.equal(r.ok, true, '同会话同号幂等覆盖不受影响');
  } finally {
    env.restore();
  }
});

test('内部任务-57 suggester 第九源：incidents 账本 taskId 计入占用（内部任务-15 型仅账本面占用不再被荐）', () => {
  const env = freshEnv();
  try {
    const repo = join(env.home, 'hist-inc');
    // 占满 1..14（evidence 严格源）＋ incidents 占 内部任务-15——判别锚：无第九源时建议恰为
    // 内部任务-15（误荐），有第九源时跳到 内部任务-16。
    for (let i = 1; i <= 14; i += 1) mkdirSync(join(repo, 'docs', 'plans', 'evidence', `DEV-${i}`), { recursive: true });
    mkdirSync(join(repo, '.workflow'), { recursive: true });
    writeFileSync(join(repo, '.workflow', 'incidents.jsonl'), `{"id":"tf-x1","taskId":"内部任务-15","session":"s-a","kind":"tool-failure"}\n`);
    const sug = leaseLib.suggestedTaskId(projectKey(repo), { domain: 'DEV' });
    assert.ok(sug.ok);
    assert.equal(sug.suggestions[0]?.taskId, '内部任务-16', 'incidents 账本占号 内部任务-15 须计入占用（第九源闭合）');
    // 账本损坏/缺席回退既有源不阻断（bad json 一行）——回退值如实锚定：第九源失效后果＝
    // 建议退回 内部任务-15（检查点②发现 6 处置：只验 ok 不验值判别力弱于标题）。
    writeFileSync(join(repo, '.workflow', 'incidents.jsonl'), '{broken json\n');
    const sug2 = leaseLib.suggestedTaskId(projectKey(repo), { domain: 'DEV' });
    assert.ok(sug2.ok, '损坏账本 fail-open 回退');
    assert.equal(sug2.suggestions[0]?.taskId, '内部任务-15', '回退值＝第九源缺席时的 内部任务-15（真回退，非静默换值）');
  } finally {
    env.restore();
  }
});

// ── 内部任务-36/内部任务-122（2026-10-17）：撞号守卫「具名持有 × null 声明者」方向＋冷/热分诊文案 ──
// 长轮中挑战过期 → --bootstrap-reissue 得 null 桶令牌 → 同 task 重声明撞自家具名 claim：
// 阻断是设计预期（内部决策-040 决策 2——null 声明者无法自证同会话），本批修文案可达性：
// 自撞注记（内部验收-9）＋热续期真正可达的三条出路＋等 TTL 出路的滑动注记。

test('内部任务-122 具名持有 × null 声明者（补签热续期形态）→ 阻断＋自撞注记＋可达出路＋滑动注记', () => {
  const env = freshEnv();
  try {
    const chReal = issueChallenge('/proj/d122a', { sessionId: 'sess-hot' });
    assert.equal(activateLease('/proj/d122a', { leaseId: chReal.leaseId, taskId: '内部任务-11', skill: 'tdd' }).ok, true);
    const chNull = issueChallenge('/proj/d122a'); // 补签形态：null 桶挑战（D1 恒挂共享桶）
    const r = activateLease('/proj/d122a', { leaseId: chNull.leaseId, taskId: '内部任务-11', skill: 'tdd' });
    assert.equal(r.ok, false, '具名持有者互斥不变（null 声明者无法自证同会话——内部决策-040 决策 2）');
    const reason = String(r.reason ?? '');
    assert.ok(reason.includes('撞号阻断'), '撞号事实在案');
    assert.ok(reason.includes('疑似本会话补签热续期'), '自撞注记在案（内部验收-9：null 声明者 × 具名持有者分诊）');
    assert.ok(reason.includes('--release --session'), '可达出路①：--release --session 在案');
    assert.ok(reason.includes('--release --all-sessions'), '可达出路②：--all-sessions 在案');
    assert.ok(reason.includes('下一条用户消息'), '可达出路③：下一轮具名令牌指引在案');
    assert.ok(reason.includes('顺延') || reason.includes('滑动'), '等 TTL 出路的滑动注记在案（热续期下「等 TTL」近乎不可达）');
  } finally {
    env.restore();
  }
});

test('内部任务-122 具名持有 × 具名他会话 → 阻断但无自撞注记（不误报他会话抢号）', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/d122b', { sessionId: 'sess-A' });
    assert.equal(activateLease('/proj/d122b', { leaseId: chA.leaseId, taskId: '内部任务-12', skill: 'tdd' }).ok, true);
    const chB = issueChallenge('/proj/d122b', { sessionId: 'sess-B' });
    const r = activateLease('/proj/d122b', { leaseId: chB.leaseId, taskId: '内部任务-12', skill: 'tdd' });
    assert.equal(r.ok, false);
    assert.ok(!String(r.reason ?? '').includes('疑似本会话补签热续期'), '自撞注记只在 null 声明者分支触发（具名×具名不误报）');
  } finally {
    env.restore();
  }
});

test('内部任务-122 冷恢复：claim/active 过期后 null 声明者同号 → 放行（补签自救原生场景不受分诊误伤）', () => {
  const env = freshEnv();
  try {
    const key = '/proj/d122c';
    const chReal = issueChallenge(key, { sessionId: 'sess-cold' });
    assert.equal(activateLease(key, { leaseId: chReal.leaseId, taskId: '内部任务-13', skill: 'tdd' }).ok, true);
    // 把 claim 与 active 置为已过期（守卫判据：未过期才算占用——免真实等待，验证冷/热分界）
    for (const f of [
      join(process.env.WF_ROUTING_STATE_DIR, `wf-lease-claim-${digest(key)}-${digest(`t:内部任务-13`)}.json`),
      join(process.env.WF_ROUTING_STATE_DIR, `wf-lease-active-${chReal.leaseId}.json`),
    ]) {
      const body = JSON.parse(readFileSync(f, 'utf8'));
      body.expiresAt = Date.now() - 1000;
      writeFileSync(f, JSON.stringify(body));
    }
    const chNull = issueChallenge(key);
    const r = activateLease(key, { leaseId: chNull.leaseId, taskId: '内部任务-13', skill: 'tdd' });
    assert.equal(r.ok, true, 'claim 过期即清（冷恢复面）——null 令牌可用（补签自救原生场景）');
  } finally {
    env.restore();
  }
});

// suggester 历史占号两源（内部任务-36 阶段 3：git 提交 subject＋traceability 批次行——内部任务-13/15
// 未落 evidence/receipts 被误荐实录）。git 缺席时跳过（该源 per-source fail-open）。
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
test('内部任务-122 suggester 历史占号：git 提交 subject 的任务号计入占用（内部任务-13 不再被荐）', { skip: !gitAvailable && 'git 不可用（该源 fail-open 跳过）' }, () => {
  const env = freshEnv();
  try {
    const repo = join(env.home, 'hist-git');
    // 占满 1..12（evidence 目录严格源）——判别锚：无 git 源修复时建议恰为 内部任务-13（误荐），
    // 有修复时 内部任务-13 被记占用、建议跳到 内部任务-14。
    for (let i = 1; i <= 12; i += 1) mkdirSync(join(repo, 'docs', 'plans', 'evidence', `DEV-${i}`), { recursive: true });
    const g = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    g(['init', '-q']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'fix(内部任务-13): 宿主在位签名更正（历史占号夹具）']);
    const sug = leaseLib.suggestedTaskId(projectKey(repo), { domain: 'DEV' });
    assert.ok(sug.ok);
    assert.equal(sug.suggestions[0]?.taskId, '内部任务-14', 'git subject 中的历史占号 内部任务-13 须计入占用（漏扫缺口闭合——无修复时此处恰为 内部任务-13）');
  } finally {
    env.restore();
  }
});

test('内部任务-122 suggester 历史占号：traceability 批次行的任务号计入占用', () => {
  const env = freshEnv();
  try {
    const repo = join(env.home, 'hist-tm');
    // 同款判别锚：占满 1..14，traceability 提及 内部任务-15——有修复建议 内部任务-16，无修复恰为 内部任务-15。
    for (let i = 1; i <= 14; i += 1) mkdirSync(join(repo, 'docs', 'plans', 'evidence', `DEV-${i}`), { recursive: true });
    mkdirSync(join(repo, 'specs'), { recursive: true });
    writeFileSync(join(repo, 'specs', 'traceability-matrix.md'), '# 矩阵\n\n- 2026-10-17 批（内部任务-15）：夹具占号行（root-cause-debugging）。（是）\n');
    const sug = leaseLib.suggestedTaskId(projectKey(repo), { domain: 'DEV' });
    assert.ok(sug.ok);
    assert.equal(sug.suggestions[0]?.taskId, '内部任务-16', 'traceability 批次行中的历史占号 内部任务-15 须计入占用');
  } finally {
    env.restore();
  }
});

// ── W3 丙案（2026-09-16 租约族缺陷批次）：仓键发现 ──

test('discoverRepoKeys：多仓工作区枚举全部 git 仓、排除 node_modules、根自身为仓时含自身', () => {
  const env = freshEnv();
  try {
    const ws = mkdtempSync(join(tmpdir(), 'wf-repos-ws-')); // 工作区根（无 .git）
    const mainRepo = join(ws, 'main-repo');
    const nestedRepo = join(mainRepo, 'nested-repo');
    const noisy = join(ws, 'node_modules', 'dep-repo');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(join(mainRepo, '.git'));
    mkdirSync(nestedRepo, { recursive: true });
    mkdirSync(join(nestedRepo, '.git'));
    mkdirSync(noisy, { recursive: true });
    mkdirSync(join(noisy, '.git'));
    const keys = discoverRepoKeys(ws);
    // 键形态 canonical（内部任务-MACKEY-1 连带）：期望值 realpathSync 化——macOS tmpdir
    // symlink 下归一前后形态不同（/var→/private/var），无 symlink 平台 realpathSync 幂等零变化
    assert.ok(keys.includes(realpathSync(mainRepo)), '主仓须被枚举');
    assert.ok(keys.includes(realpathSync(nestedRepo)), '嵌套仓须被枚举');
    assert.ok(!keys.includes(realpathSync(noisy)), 'node_modules 内的 .git 不得枚举');
    assert.equal(keys.length, 2, '恰含两仓，无多余条目');
    // 根自身为仓：含自身
    const solo = mkdtempSync(join(tmpdir(), 'wf-repos-solo-'));
    mkdirSync(join(solo, '.git'));
    assert.deepEqual(discoverRepoKeys(solo), [realpathSync(solo)], '根为仓时返回 [根]（canonical 形态）');
    rmSync(ws, { recursive: true, force: true });
    rmSync(solo, { recursive: true, force: true });
  } finally {
    env.restore();
  }
});

test('discoverRepoKeys：缓存 5 分钟内命中（新出现的仓不可见），缓存文件落 stateDir', () => {
  const env = freshEnv();
  try {
    const ws = mkdtempSync(join(tmpdir(), 'wf-repos-cache-'));
    mkdirSync(join(ws, 'a'), { recursive: true });
    mkdirSync(join(ws, 'a', '.git'));
    const first = discoverRepoKeys(ws);
    assert.equal(first.length, 1);
    assert.ok(existsSync(join(process.env.WF_ROUTING_STATE_DIR, 'wf-repos-cache.json')), '缓存文件须落状态目录');
    // 缓存窗口内新建仓：不出现（缓存命中——避免每轮全量 walk）
    mkdirSync(join(ws, 'b'), { recursive: true });
    mkdirSync(join(ws, 'b', '.git'));
    const second = discoverRepoKeys(ws);
    assert.equal(second.length, 1, 'TTL 内命中缓存，新仓不可见（预期语义）');
    rmSync(ws, { recursive: true, force: true });
  } finally {
    env.restore();
  }
});

test('内部决策-018 修正案：null 桶=多活+TTL 弱形态（原项目级单活废止，内部任务-LEASEGATE-1）——弱形态基线断言在上一用例，本用例锁他会话轮换互不吊销', () => {
  const env = freshEnv();
  try {
    const ch1 = issueChallenge('/proj/a'); // 会话 X（双侧不可见）
    activateLease('/proj/a', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    issueChallenge('/proj/a'); // 会话 Y（同样不可见）的消息轮换 null 桶——不得吊销会话 X 的租约
    assert.equal(readActiveLease('/proj/a').valid, true, 'null 桶多活：他会话轮换不吊销本租约（跨会话越权吊销废止）');
  } finally {
    env.restore();
  }
});

test('内部决策-018 旧 v2 状态共存：无 schemaVersion 的 legacy 挑战/租约按 null 桶校验', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    mkdirSync(stateDir, { recursive: true });
    const legacyChallenge = { leaseId: 'legacytoken00001', projectKey: '/proj/a', promptEpoch: 7, issuedAt: Date.now(), expiresAt: Date.now() + 3600000 };
    const legacyActive = { leaseId: 'legacytoken00001', projectKey: '/proj/a', taskId: 'TASK-L', skill: 'tdd', promptEpoch: 7, declaredAt: Date.now(), issuedAt: Date.now(), expiresAt: Date.now() + 3600000 };
    writeFileSync(join(stateDir, `wf-lease-challenge-${digest('/proj/a')}.json`), JSON.stringify(legacyChallenge));
    writeFileSync(join(stateDir, `wf-lease-active-${digest('/proj/a')}.json`), JSON.stringify(legacyActive));
    const cur = readActiveLease('/proj/a');
    assert.equal(cur.valid, true, 'legacy 租约仍有效（新旧并存）');
    assert.equal(cur.lease.taskId, 'TASK-L');
  } finally {
    env.restore();
  }
});

test('内部决策-018 未来时间与可解析半损坏 schema 分别断言', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const ch = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    // 未来时间：challenge issuedAt 在将来（active 的 declaredAt 同步置未来——扫描回退按
    // declaredAt<=now 过滤，只污染挑战文件会被 F2 扫描救回，内部任务-LEASEGATE-1）
    const future = JSON.parse(readFileSync(challengePath(stateDir, ch.leaseId), 'utf8'));
    future.issuedAt = Date.now() + 99999999;
    writeFileSync(challengePath(stateDir, ch.leaseId), JSON.stringify(future));
    const actF = JSON.parse(readFileSync(activePath(stateDir, ch.leaseId), 'utf8'));
    actF.declaredAt = Date.now() + 99999999;
    writeFileSync(activePath(stateDir, ch.leaseId), JSON.stringify(actF));
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' }).valid, false, '未来时间判拒');
    // 半损坏：active 文件缺 expiresAt 但可解析（declaredAt 恢复正常）
    future.issuedAt = Date.now();
    writeFileSync(challengePath(stateDir, ch.leaseId), JSON.stringify(future));
    actF.declaredAt = Date.now();
    writeFileSync(activePath(stateDir, ch.leaseId), JSON.stringify(actF));
    const act = JSON.parse(readFileSync(activePath(stateDir, ch.leaseId), 'utf8'));
    delete act.expiresAt;
    writeFileSync(activePath(stateDir, ch.leaseId), JSON.stringify(act));
    assert.equal(readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' }).valid, false, '半损坏 schema 判拒');
  } finally {
    env.restore();
  }
});

test('内部决策-018 同 token 重复声明幂等覆盖（last-writer-wins）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    assert.equal(activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok, true);
    assert.equal(activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-2', skill: 'code-review' }).ok, true);
    const cur = readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' });
    assert.equal(cur.valid, true);
    assert.equal(cur.lease.taskId, '内部任务-2', '后写覆盖先写');
  } finally {
    env.restore();
  }
});

test('内部决策-018 损坏 challenge 索引回退：仅挑战缺失被扫描救回，全失守才判「指针悬空」（内部任务-LEASEGATE-1 F2 后口径）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a', { sessionId: 'sess-A' });
    activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    rmSync(challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId));
    assert.equal(
      readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' }).valid,
      true,
      '挑战文件缺失而 active 健在：扫描回退救回（F2）',
    );
    rmSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId));
    const cur = readActiveLease('/proj/a', Date.now(), { sessionId: 'sess-A' });
    assert.equal(cur.valid, false);
    assert.ok(['prompt 已轮换', '挑战未激活（当前令牌尚未声明）', '状态缺失或损坏', '指针悬空（挑战文件缺失，等待下一条用户消息重新签发）'].includes(cur.reason ?? ''));
  } finally {
    env.restore();
  }
});

// ── 内部任务-LEASEGATE-1（2026-09-22）：桶漂移四象限与扫描回退（内部决策-018 修正案）──

test('漂移象限①：null 桶签发+声明，会话桶 current 遮蔽下观察侧仍有效（实录死循环形态，F2）', () => {
  const env = freshEnv();
  try {
    // 实录形态：会话 K 的桶已有 current（早前负载带 session_id 的签发），随后负载漂移为
    // 无标识——最新签发与声明落 null 桶；指针路径先解析 K 桶（challenge 健在而未声明）
    // 判「挑战未激活（当前令牌尚未声明）」（内部任务-LEASEATT-1），扫描回退救回 null 桶声明（内部任务-LEASEGATE-1 根因链第 3 跳）
    issueChallenge('/proj/d1', { sessionId: 'sess-K' }); // K 桶 current 就位
    const ch = issueChallenge('/proj/d1'); // 漂移：本条消息负载缺 session_id
    activateLease('/proj/d1', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    const cur = readActiveLease('/proj/d1', Date.now(), { sessionId: 'sess-K' });
    assert.equal(cur.valid, true, '声明落在 null 桶也对会话观察可达（校验扫描回退）');
  } finally {
    env.restore();
  }
});

test('漂移象限②（内部任务-8 语义翻转）：会话桶签发+声明，null 观察侧不可达（内部决策-018 修正案 2026-10-07 第 2 条）', () => {
  // 翻转依据：显式可见性表（内部规则-18）取代 2026-09-22 修正案 5 的隐式「双边可见且不同才排除」——
  // null 观察侧只可见 null 桶租约（原「null 观察不比对」= 不确定即放宽，已废止）。
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/d2', { sessionId: 'sess-M' });
    activateLease('/proj/d2', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    const cur = readActiveLease('/proj/d2');
    assert.equal(cur.valid, false, 'null 观察侧只认 null 桶——不得救回会话桶声明（RC-1 修复面）');
    assert.equal(cur.reason, '状态缺失或损坏', '指针路径原 reason 逐字透传（deny 文案契约）');
    assert.equal(
      readActiveLease('/proj/d2', Date.now(), { sessionId: 'sess-M' }).valid,
      true,
      '同会话具名观察侧仍可达（翻转只作用于 null 观察侧）',
    );
  } finally {
    env.restore();
  }
});

test('漂移象限③：null 桶声明后他会话 null 桶轮换，租约仍有效（死循环根因封堵，F1+F2）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/d3');
    activateLease('/proj/d3', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    issueChallenge('/proj/d3'); // 另一无标识「会话」的用户消息
    const rescued = readActiveLease('/proj/d3');
    assert.equal(rescued.valid, true, 'null 桶轮换不吊销他会话声明');
    assert.equal(rescued.viaScan, true, '回退命中经扫描路径（viaScan 诊断字段，指针路径不置位）');  } finally {
    env.restore();
  }
});

test('漂移象限④（隔离负例）：会话 A 的声明不得被会话 B 扫描救回', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/d4', { sessionId: 'sess-A' });
    activateLease('/proj/d4', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    const cur = readActiveLease('/proj/d4', Date.now(), { sessionId: 'sess-B' });
    assert.equal(cur.valid, false, '扫描回退沿用隔离口径（双边可见且不同才排除）');
    assert.equal(cur.reason, '状态缺失或损坏', '指针路径对空桶观察者的原 reason 逐字透传（deny 文案契约）');
  } finally {
    env.restore();
  }
});

test('扫描回退未命中：reason 逐字节透传 pointer 路径结果（deny 文案契约）', () => {
  const env = freshEnv();
  try {
    const ch1 = issueChallenge('/proj/d5', { sessionId: 'sess-N' });
    activateLease('/proj/d5', { leaseId: ch1.leaseId, taskId: '内部任务-1', skill: 'tdd' });
    issueChallenge('/proj/d5', { sessionId: 'sess-N' }); // 会话桶强形态轮换：旧 active 已删、无可救
    const cur = readActiveLease('/proj/d5', Date.now(), { sessionId: 'sess-N' });
    assert.equal(cur.valid, false);
    assert.equal(cur.reason, '挑战未激活（当前令牌尚未声明）', '未命中不得改写/吞掉 pointer 路径 reason（内部任务-LEASEATT-1 后形态）');
  } finally {
    env.restore();
  }
});

test('挑战未激活 reason 细分：挑战健在而激活从未存在 → 专属 reason（内部任务-LEASEATT-1）', () => {
  const env = freshEnv();
  try {
    issueChallenge('/proj/d6', { sessionId: 'sess-P' }); // 只签发不声明：current 指针+挑战均在、active 从未写入
    const cur = readActiveLease('/proj/d6', Date.now(), { sessionId: 'sess-P' });
    assert.equal(cur.valid, false);
    assert.equal(cur.reason, '挑战未激活（当前令牌尚未声明）', '挑战存活时激活缺失恒等于从未激活（可判性：轮换删旧挑战+激活不留史、租约 TTL 恒晚于挑战 TTL）');
  } finally {
    env.restore();
  }
});

test('激活文件存在但损坏 → 状态缺失或损坏（不误报「挑战未激活」，内部任务-LEASEATT-1 阶段复审发现 4）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/d7', { sessionId: 'sess-Q' });
    assert.ok(activateLease('/proj/d7', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok);
    writeFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), '{corrupted');
    const cur = readActiveLease('/proj/d7', Date.now(), { sessionId: 'sess-Q' });
    assert.equal(cur.valid, false);
    assert.equal(cur.reason, '状态缺失或损坏', 'readJson 对损坏与缺失同返 null——existsSync 区分，损坏态归笼统损坏桶');
  } finally {
    env.restore();
  }
});

test('legacy active 与 v3 状态并存：legacy 租约不被 v3 null 桶轮换驱逐（新旧并存）', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    mkdirSync(stateDir, { recursive: true });
    const legacyChallenge = { leaseId: 'legacytoken00001', projectKey: '/proj/a', promptEpoch: 7, issuedAt: Date.now(), expiresAt: Date.now() + 3600000 };
    const legacyActive = { leaseId: 'legacytoken00001', projectKey: '/proj/a', taskId: 'TASK-L', skill: 'tdd', promptEpoch: 7, declaredAt: Date.now(), issuedAt: Date.now(), expiresAt: Date.now() + 3600000 };
    writeFileSync(join(stateDir, `wf-lease-challenge-${digest('/proj/a')}.json`), JSON.stringify(legacyChallenge));
    writeFileSync(join(stateDir, `wf-lease-active-${digest('/proj/a')}.json`), JSON.stringify(legacyActive));
    issueChallenge('/proj/a'); // v3 null 桶签发（指针被 v3 占位）
    assert.equal(readActiveLease('/proj/a').valid, true, 'legacy 租约按 null 桶语义存活（指针路径失守时扫描回退同判有效）');
  } finally {
    env.restore();
  }
});

// ── 协议扩展（2026-09-14，内部决策-020）：changeScope 写面声明 / exemptSrc 来源枚举 ──

test('normalizeScopeEntries：反斜杠归一为 /、去前导 ./、去重；非法条目 throw', () => {
  assert.deepEqual(
    normalizeScopeEntries(['docs\\plans', './docs/plans', 'docs/plans', './.\\sub\\dir']),
    ['docs/plans', 'sub/dir'],
    '反斜杠归一、./ 前缀剥离、首现顺序去重',
  );
  assert.throws(() => normalizeScopeEntries(['../x']), { message: /绝对路径|\.\./ });
  assert.throws(() => normalizeScopeEntries(['/abs']), { message: /绝对路径/ });
  assert.throws(() => normalizeScopeEntries(['C:/abs']), { message: /绝对路径/ }, 'Windows 盘符形态同样算绝对路径');
  assert.throws(() => normalizeScopeEntries(['docs/../x']), { message: /\.\./ }, '.. 段藏在中间也拒');
  assert.throws(() => normalizeScopeEntries(['']), { message: /空/ });
  assert.throws(() => normalizeScopeEntries(['./']), { message: /空/ }, './ 剥离后为空串同样拒');
  assert.throws(() => normalizeScopeEntries(['docs/..']), { message: /\.\./ }, '末段 .. 同样拒');
  assert.throws(() => normalizeScopeEntries('not-array'), { message: /数组/ });
  assert.throws(() => normalizeScopeEntries([42]), { message: /字符串/ });
});

test('activateLease changeScope 复验：拒绝 ".." 段/绝对路径/空串；反斜杠归一与去重入租约', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a');
    const base = { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' };
    assert.equal(activateLease('/proj/a', { ...base, changeScope: ['../x'] }).ok, false, '.. 段拒');
    assert.equal(activateLease('/proj/a', { ...base, changeScope: ['/abs'] }).ok, false, '绝对路径拒');
    assert.equal(activateLease('/proj/a', { ...base, changeScope: [''] }).ok, false, '空串拒');
    const ok = activateLease('/proj/a', { ...base, changeScope: ['.\\docs\\plans', 'docs/plans'] });
    assert.equal(ok.ok, true, '合法条目（反斜杠/重复）应激活');
    const cur = readActiveLease('/proj/a');
    assert.ok(cur.valid);
    assert.deepEqual(cur.lease.changeScope, ['docs/plans'], '归一去重后写入租约');
  } finally {
    env.restore();
  }
});

test('activateLease exempt 协议复验：scope/引文/plan 成对；库层不信任调用方', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/a');
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd', exempt: '理由' }).ok,
      false,
      'exempt 仅 plan-execution 可用（不信任调用方，库内复验）',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '不用写计划，直接修', exemptSrc: 'bogus', exemptScope: 'plan' }).ok,
      false,
      'exemptSrc 非枚举值拒',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '不用写计划，直接修', exemptSrc: 'user' }).ok,
      false,
      '缺 exemptScope 拒',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'bogus' }).ok,
      false,
      'exemptScope 非枚举拒',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '跳过评审直接做', exemptSrc: 'user', exemptScope: 'review' }).ok,
      false,
      'review scope 缺 planPath/planSha256 拒',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '不用写计划，直接修', exemptSrc: 'user', exemptScope: 'plan', planPath: '内部计划', planSha256: 'a'.repeat(64) }).ok,
      false,
      'plan scope 带 planPath 拒',
    );
    assert.equal(
      activateLease('/proj/a', { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'plan-execution', exempt: '继续', exemptSrc: 'user', exemptScope: 'plan' }).ok,
      false,
      '引文正形失败拒',
    );
    const ok = activateLease('/proj/a', {
      leaseId: ch.leaseId,
      taskId: '内部任务-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'preauthorized',
      exemptScope: 'plan',
    });
    assert.equal(ok.ok, true, '合法 scope/引文应激活');
    assert.ok(['created', 'degraded'].includes(ok.claimMode), '返回 claimMode 供定向回滚');
    const cur = readActiveLease('/proj/a');
    assert.ok(cur.valid);
    assert.equal(cur.lease.exempt, '不用写计划，直接修');
    assert.equal(cur.lease.exemptSrc, 'preauthorized');
    assert.equal(cur.lease.exemptScope, 'plan');
  } finally {
    env.restore();
  }
});

test('rollbackActivation：token 级回滚 active/claim；回滚后可同号重声明', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/rb');
    const ok = activateLease('/proj/rb', {
      leaseId: ch.leaseId,
      taskId: '内部任务-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'user',
      exemptScope: 'plan',
    });
    assert.equal(ok.ok, true);
    assert.equal(readActiveLease('/proj/rb').valid, true);
    const rb = rollbackActivation('/proj/rb', {
      leaseId: ch.leaseId,
      taskId: '内部任务-1',
      claimMode: ok.claimMode,
      markerWritten: ok.claimMarkerWritten,
      sessionId: null,
    });
    const chOther = issueChallenge('/proj/rb', { sessionId: 'sess-other' });
    const okOther = activateLease('/proj/rb', { leaseId: chOther.leaseId, taskId: '内部任务-2', skill: 'tdd' });
    assert.equal(okOther.ok, true);
    assert.equal(rb.removed.length >= 1, true, '至少移除 active');
    assert.equal(readActiveLease('/proj/rb').valid, false, '回滚后租约不可见');
    assert.equal(
      readActiveLease('/proj/rb', Date.now(), { sessionId: 'sess-other' }).valid,
      true,
      '他会话租约不受影响',
    );
    const curChallenge = currentChallengeToken('/proj/rb');
    assert.equal(curChallenge && curChallenge.leaseId, ch.leaseId, 'current 指针不属激活产物，回滚不得删除');
    const ch2 = issueChallenge('/proj/rb');
    const ok2 = activateLease('/proj/rb', {
      leaseId: ch2.leaseId,
      taskId: '内部任务-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'user',
      exemptScope: 'plan',
    });
    assert.equal(ok2.ok, true, '回滚后同号可重声明');
    const ch3 = issueChallenge('/proj/rb');
    const ok3 = activateLease('/proj/rb', {
      leaseId: ch3.leaseId,
      taskId: '内部任务-1',
      skill: 'plan-execution',
      exempt: '不用写计划，直接修',
      exemptSrc: 'user',
      exemptScope: 'plan',
    });
    assert.equal(ok3.ok, true);
    const rb3 = rollbackActivation('/proj/rb', {
      leaseId: ch3.leaseId,
      taskId: '内部任务-1',
      claimMode: 'refreshed',
      markerWritten: ok3.claimMarkerWritten,
      sessionId: null,
    });
    assert.equal(rb3.removed.filter((x) => String(x).includes('wf-lease-claim')).length, 0, 'refreshed 保留既有 claim');
  } finally {
    env.restore();
  }
});

test('projectKey 键归一（内部任务-MACKEY-1）：symlink 双形态访问同一 git 项目恒得同一键（canonical=realpath）', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——平台特定缺陷，其余平台以基线回归覆盖' }, () => {
  const env = freshEnv();
  let real = '';
  let alias = '';
  try {
    real = mkdtempSync(join(tmpdir(), 'wf-key-real-'));
    mkdirSync(join(real, '.git'));
    alias = join(tmpdir(), `wf-key-alias-${digest(real)}`);
    symlinkSync(real, alias, 'dir');
    // 根因形态：签发侧拿原始/别名路径、声明侧拿 process.cwd() 物理路径——两形态须归一同键
    assert.equal(projectKey(alias), projectKey(real), '别名形态与真实形态须归一到同一键');
    assert.equal(projectKey(real), realpathSync(real), '键为 canonical（realpath）形态');
    // 无 git 目录的回退分支同口径归一（projectKey 的 ?? canonicalRoot(cwd) 支路）
    const bareAlias = join(tmpdir(), `wf-key-bare-alias-${digest(real)}`);
    rmSync(join(real, '.git'), { recursive: true, force: true });
    symlinkSync(real, bareAlias, 'dir');
    assert.equal(projectKey(bareAlias), realpathSync(real), '回退分支（无 git/标记）亦为 canonical 形态');
    rmSync(bareAlias, { force: true });
  } finally {
    if (alias) rmSync(alias, { force: true });
    if (real) rmSync(real, { recursive: true, force: true });
    env.restore();
  }
});

test('symlink 端到端（内部任务-MACKEY-1）：别名路径签发 → 声明命令在别名 cwd 下激活成功', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——平台特定缺陷，其余平台以基线回归覆盖' }, () => {
  const env = freshEnv();
  let real = '';
  let alias = '';
  try {
    real = mkdtempSync(join(tmpdir(), 'wf-key-e2e-'));
    mkdirSync(join(real, '.git'));
    alias = join(tmpdir(), `wf-key-e2e-alias-${digest(real)}`);
    symlinkSync(real, alias, 'dir');
    // 签发键用别名形态推导（复现签发侧拿原始形态：宿主负载 cwd / 测试 mkdtemp 同型）
    const ch = issueChallenge(projectKey(alias), {});
    // 声明子进程 cwd 传别名路径——process.cwd() 天然解析为物理（realpath）形态，直接复现生产分裂面
    const r = spawnSync(process.execPath, [DECLARE, 'brainstorming', '--lease', ch.leaseId, '--task-id', '内部任务-1'], {
      cwd: alias,
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(r.status, 0, `声明须激活成功（stderr=${r.stderr}）`);
    const cur = readActiveLease(projectKey(alias));
    assert.ok(cur.valid, '别名形态读侧校验亦须命中激活租约（键链全侧同源）');
  } finally {
    if (alias) rmSync(alias, { force: true });
    if (real) rmSync(real, { recursive: true, force: true });
    env.restore();
  }
});

// ── 内部未决-76（2026-10-05）：域前缀任务号——形态收紧/仓级域声明/撞号阻断/按域取号 ──

test('内部未决-76 形态收紧：TASK_ID_FORM_RE 只认 <域码>-<序号>，旧 TASK- 系主力形态与裸标识均拒', () => {
  assert.ok(leaseLib.TASK_ID_FORM_RE instanceof RegExp, 'TASK_ID_FORM_RE 已导出');
  const RE = leaseLib.TASK_ID_FORM_RE;
  assert.ok(RE.test('内部任务-1') && RE.test('BE-123456') && RE.test('OPS-999999'), '合法域前缀形态');
  // 边界如实登记：TASK 恰为 4 位大写字母，旧形态的纯数字尾变体（内部任务-12）与新形态字符串
  // 重叠、按「域码=TASK」放行——本仓经 domains.json 域成员校验兜住（TASK ∉ 域集即拒）；
  // 旧号主力形态（TASK-<词>-<N>，如 内部任务-RELEASE-54）结构与新形态不重叠、恒拒。
  assert.ok(RE.test('内部任务-12'), 'TASK-<纯数字> 尾变体与新形态字符串重叠（边界如实锚定）');
  assert.ok(
    !RE.test('内部任务-RELEASE-54') && !RE.test('T-1') && !RE.test('abc') && !RE.test('dev-1') && !RE.test('DEV-') && !RE.test('内部任务-1234567') && !RE.test('DEVSX-1'),
    '旧主力形态/小写/裸标识/越界域码（5 位）/7 位序号均拒',
  );
});

test('内部未决-76 仓级域声明三态：配置收严拒跨域 / 无配置 lenient / 损坏配置退 form-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-domain-test-'));
  try {
    const key = projectKey(root);
    assert.equal(leaseLib.repoDomains(key), null, '无 domains.json → null（lenient）');
    assert.equal(leaseLib.taskidRejection('FE-1', key), null, '无配置：任意合法形态域通过');
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV"]}', 'utf8');
    assert.deepEqual(leaseLib.repoDomains(key), ['DEV'], '合法配置 → 域数组');
    assert.equal(leaseLib.taskidRejection('内部任务-1', key), null);
    assert.ok(String(leaseLib.taskidRejection('FE-1', key)).includes('域不在本仓域集'), '域成员拒因文案');
    writeFileSync(join(root, '.workflow', 'domains.json'), '{broken', 'utf8');
    assert.equal(leaseLib.repoDomains(key), null, '损坏 JSON → null');
    assert.equal(leaseLib.taskidRejection('FE-1', key), null, '损坏配置退 form-only（fail-open）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('内部未决-76 activateLease 拒因细分：旧形态拒（形态文案）/ 配置仓跨域拒（域成员文案）', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-domain-act-'));
  try {
    const key = projectKey(root);
    const ch = issueChallenge(key);
    const r1 = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-RELEASE-12', skill: 'tdd' });
    assert.equal(r1.ok, false);
    assert.ok(String(r1.reason).includes('域前缀形态') && String(r1.reason).includes('不再接受'), '形态拒文案');
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV"]}', 'utf8');
    const ch2 = issueChallenge(key);
    const r2 = activateLease(key, { leaseId: ch2.leaseId, taskId: 'FE-1', skill: 'tdd' });
    assert.equal(r2.ok, false);
    assert.ok(String(r2.reason).includes('域不在本仓域集') && String(r2.reason).includes('DEV'), '域成员拒文案');
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('内部未决-76 撞号阻断：异会话同 task-id → 激活失败不落盘 + reason 含证据与建议号；同会话幂等不阻断；异域同号双活', () => {
  const env = freshEnv();
  try {
    const chA = issueChallenge('/proj/o76', { sessionId: 'sess-A' });
    assert.ok(activateLease('/proj/o76', { leaseId: chA.leaseId, taskId: '内部任务-7', skill: 'tdd' }).ok);
    const chB = issueChallenge('/proj/o76', { sessionId: 'sess-B' });
    const r = activateLease('/proj/o76', { leaseId: chB.leaseId, taskId: '内部任务-7', skill: 'tdd' });
    assert.equal(r.ok, false, '撞号即阻断');
    assert.ok(String(r.reason).includes('撞号阻断') && String(r.reason).includes('内部任务-7'), 'reason 点名撞号 task-id');
    assert.ok(String(r.reason).includes('延续本任务') && String(r.reason).includes('取最小未用号'), 'reason 含双路指引（P8：延续同号/取最小未用号分诊——内部任务-117 稠密措辞）');
    assert.ok(/声明于 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(r.reason)), '附对方声明时间');
    assert.ok(String(r.reason).includes('将于'), '附 TTL 过期时刻');
    assert.ok(String(r.reason).includes('内部任务-1'), '附建议号（内部任务-117 稠密：git 源空 → 最小未用 1）');
    assert.ok(String(r.reason).includes('无需等待新令牌'), '同令牌换号重试指引');
    assert.equal(existsSync(activePath(process.env.WF_ROUTING_STATE_DIR, chB.leaseId)), false, '阻断即不落盘（sess-B active 文件不存在）');
    // 同会话幂等覆盖不阻断；无他会话持同号时正常激活（原 D3 例差异断言随合并并入，评审处置）
    const r2 = activateLease('/proj/o76', { leaseId: chA.leaseId, taskId: '内部任务-7', skill: 'tdd' });
    assert.ok(r2.ok, '同会话幂等覆盖不阻断');
    const chB2 = issueChallenge('/proj/o76', { sessionId: 'sess-B' });
    assert.ok(activateLease('/proj/o76', { leaseId: chB2.leaseId, taskId: '内部任务-8', skill: 'tdd' }).ok, 'task-id 无冲突正常激活');
    // 异域同号双活（复合键语义：字符串不等天然不撞）
    const chC = issueChallenge('/proj/o76', { sessionId: 'sess-C' });
    assert.ok(activateLease('/proj/o76', { leaseId: chC.leaseId, taskId: 'FE-7', skill: 'tdd' }).ok, '异域同号双活互不阻断');
  } finally {
    env.restore();
  }
});

test('内部未决-76 suggestedTaskId 五态：空态取 1/活跃租约源/双源稠密/多域逐域/零域默认域兜底/receipts 域推断/坏域码/跨域取号拒', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-domain-sug-'));
  try {
    const key = projectKey(root);
    let sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(sug.ok && sug.suggestions[0].taskId === '内部任务-1', '空态取 1');
    const ch = issueChallenge(key, { sessionId: 'sess-sug' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok);
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(sug.suggestions[0].taskId === '内部任务-2', '活跃租约临时占用填位（稠密：{1}→2——删状态源即红，判别力，内部任务-117）');
    mkdirSync(join(root, '.sdd', 'receipts', '内部任务-30'), { recursive: true });
    mkdirSync(join(root, '.sdd', 'receipts', '内部任务-2'), { recursive: true });
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(sug.suggestions[0].taskId === '内部任务-3', '双源稠密：active{1}∪receipts{2,30} → 3（内部任务-117）');
    // receipts 域推断（无 domains.json 的仓：receipts 目录名里的域即候选域集）
    const sugInf = leaseLib.suggestedTaskId(key);
    assert.ok(sugInf.ok && sugInf.suggestions.some((s) => s.taskId.startsWith('DEV-')), '无配置仓按 receipts 推断域');
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'domains.json'), '{"schemaVersion":1,"domains":["DEV","OPS"]}', 'utf8');
    sug = leaseLib.suggestedTaskId(key);
    assert.equal(sug.suggestions.length, 2, '多域仓逐域各一建议');
    assert.ok(sug.suggestions.some((s) => s.taskId.startsWith('DEV-')) && sug.suggestions.some((s) => s.taskId.startsWith('OPS-')), '建议号带各自域前缀');
    // 跨域取号拒（取号口径与声明一致——给出必被拒的号即失职）
    const cross = leaseLib.suggestedTaskId(key, { domain: 'FE' });
    assert.equal(cross.ok, false, '配置仓显式跨域取号拒');
    assert.ok(String(cross.hint).includes('不在本仓域集'), '跨域取号 hint');
    const bare = mkdtempSync(join(tmpdir(), 'wf-domain-bare-'));
    try {
      const bareSug = leaseLib.suggestedTaskId(projectKey(bare));
      assert.equal(bareSug.ok, true, '零域（无配置无 receipts 无入参）回落默认域（内部任务-75，旧「不 ok」形态废止）');
      assert.equal(bareSug.usedDefaultDomains, true, '默认域兜底标记');
      assert.deepEqual(bareSug.suggestions.map((s) => s.domain), ['DEV'], '恰默认域单建议（序号随本根占用集——他会话 active 已按项目键过滤，本根空态取 1）');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const bad = leaseLib.suggestedTaskId(key, { domain: 'dev' });
    assert.ok(bad.ok && bad.suggestions[0].taskId.startsWith('DEV-'), '小写域码入参归一为大写建议（错误信息可行动：意图明确即给结果）');
    const malformed = leaseLib.suggestedTaskId(key, { domain: 'DEVSX' });
    assert.equal(malformed.ok, false, '5 位域码形态拒');
    assert.ok(String(malformed.hint).includes('域码形态非法'), '坏域码 hint 断言（DOMAIN_RE 拒绝分支）');
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-117：稠密取号（用户 2026-10-16 裁决：按项目发号、从 1 起、绝不跳号）──
test('内部任务-117 稠密取号：最小未用/未过期活跃占用填位', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-dense-'));
  try {
    const key = projectKey(root);
    // git 源占用 {1,2,4}——期望 3（旧 max+1 语义给 5，跳号）
    for (const n of ['内部任务-1', '内部任务-2', '内部任务-4']) mkdirSync(join(root, '.sdd', 'receipts', n), { recursive: true });
    let sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '最小未用（稠密），非 max+1');
    // 未过期活跃租约 内部任务-3（他会话）——临时占用填位：git{1,2,4}∪active{3} → 5
    const ch = issueChallenge(key, { sessionId: 'sess-Y' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-3', skill: 'tdd' }).ok, true);
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-5', '活跃占用填住最小空位，建议越位取下一空位');
  } finally {
    rmSync(root, { recursive: true, force: true });
    env.restore();
  }
});

// ── 内部任务-81（内部决策-042/内部规则-16）：归档号可见性第三严格源（archive-manifest 任务号入占用集——内部任务-117 稠密改写）──
test('suggestedTaskId 归档 manifest 源（内部任务-117 稠密改写）：任务号入占用集/缺席零影响/损坏跳过不抛', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-arch-manifest-'));
  try {
    const key = projectKey(root);
    // git 源占低位 {1}（两域各一）——归档号须填住最小空位才有稠密判别力（无 manifest 时建议 2）
    mkdirSync(join(root, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    mkdirSync(join(root, '.sdd', 'receipts', 'OPS-1'), { recursive: true });
    mkdirSync(join(root, '.sdd', 'archive'), { recursive: true });
    writeFileSync(
      join(root, '.sdd', 'archive', 'archive-manifest.json'),
      '{"schemaVersion":1,"batches":[{"batch":"b1","archivedAt":"2026-10-14T00:00:00Z","taskIds":["内部任务-2","OPS-2"],"files":["receipts-b1.tar.gz"]}]}',
      'utf8',
    );
    let sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(sug.suggestions[0].taskId === '内部任务-3', 'manifest 任务号入占用集（内部任务-2 填位 → 稠密建议 3，内部任务-117）');
    sug = leaseLib.suggestedTaskId(key, { domain: 'OPS' });
    assert.ok(sug.ok && sug.suggestions[0].taskId === 'OPS-3', 'manifest 异域号照常入占用集（OPS-2 填位 → 3）');
    // 缺席＝现状零影响
    rmSync(join(root, '.sdd', 'archive'), { recursive: true, force: true });
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(sug.suggestions[0].taskId === '内部任务-2', 'manifest 缺席回落 git 源（建议 2）');
    // 损坏 JSON → 该源跳过不抛（其余源照常）
    mkdirSync(join(root, '.sdd', 'archive'), { recursive: true });
    writeFileSync(join(root, '.sdd', 'archive', 'archive-manifest.json'), 'not-json {{{', 'utf8');
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, false, 'manifest 损坏按 degraded fail-loud（内部决策-061 D5.2 修订旧 fail-open 语义）');
    assert.ok(Array.isArray(sug.degraded) && sug.degraded.some((d) => String(d.source ?? d).includes('archive-manifest')), 'manifest 损坏须记 degraded 并指名来源');
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 内部任务-8（2026-10-07）：扫描回退可见性显式表（内部规则-18；内部决策-018 修正案 2026-10-07 第 2 条）──
// 显式表取代 2026-09-22 修正案 5 的隐式「双边可见且不同才排除」：
//   观察侧 null → 只可见 null 桶租约；观察侧具名 → 只可见同会话桶租约 + null 桶租约。
// 「不确定即放宽」禁止：null 观察侧不再救回他会话声明（RC-1 越权放行面）；null 桶救回
// 带可审计标注 viaNullBucket（内部规则-18 可审计路径义务）。

/** 直接落一条 active 租约文件（不建指针：本组只测扫描回退的可见性矩阵）。 */
function seedActiveLease(stateDir, { token, sessionId, key, taskId = '内部任务-91', schemaVersion = 3, declaredAt = Date.now(), expiresAt = Date.now() + 3600000 }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    activePath(stateDir, token),
    JSON.stringify({
      schemaVersion,
      leaseId: token,
      projectKey: key,
      sessionId,
      taskId,
      skill: 'tdd',
      promptEpoch: 1,
      issuedAt: declaredAt,
      declaredAt,
      expiresAt,
    }),
  );
}

test('内部任务-8 可见性表六格矩阵：null 观察侧只救 null 桶；具名观察侧只见同会话桶 + null 桶', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const self = 'sess-SELF';
    const other = 'sess-OTHER';
    const cells = [
      { name: 'null 桶 × null 观察侧', key: '/proj/vis-null-null', bucket: null, observer: {}, expect: true, viaNull: true },
      { name: 'null 桶 × 具名观察侧', key: '/proj/vis-null-named', bucket: null, observer: { sessionId: self }, expect: true, viaNull: true },
      { name: '同会话桶 × null 观察侧', key: '/proj/vis-self-null', bucket: self, observer: {}, expect: false },
      { name: '同会话桶 × 同会话观察侧', key: '/proj/vis-self-named', bucket: self, observer: { sessionId: self }, expect: true, viaNull: undefined },
      { name: '他会话桶 × null 观察侧', key: '/proj/vis-other-null', bucket: other, observer: {}, expect: false },
      { name: '他会话桶 × 具名观察侧', key: '/proj/vis-other-named', bucket: other, observer: { sessionId: self }, expect: false },
    ];
    for (const c of cells) {
      seedActiveLease(stateDir, { token: `tok-${c.key.split('/').pop()}`, sessionId: c.bucket, key: c.key });
      const r = readActiveLease(c.key, Date.now(), c.observer);
      assert.equal(r.valid, c.expect, `${c.name}：valid`);
      if (c.expect) {
        assert.equal(r.viaScan, true, `${c.name}：命中经扫描回退（viaScan）`);
        assert.equal(r.viaNullBucket, c.viaNull, `${c.name}：null 桶救回标注（viaNullBucket，内部规则-18 可审计路径）`);
      } else {
        assert.equal(r.reason, '状态缺失或损坏', `${c.name}：指针路径原 reason 逐字透传（deny 文案契约）`);
      }
    }
  } finally {
    env.restore();
  }
});

test('内部任务-8 RC-1 三负载判决：无 session_id → deny；未知 → deny；相同 → allow（routing-gate 端到端）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-dev8-inc-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-dev8-proj-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  try {
    const key = projectKey(proj);
    seedActiveLease(stateDir, { token: 'tok-rc1-lease', sessionId: 'sess-RC1', key });
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const pluginRoot = resolve(testsDir, '..', '..');
    const gate = join(pluginRoot, 'hooks', 'routing-gate.mjs');
    const run = (extra) =>
      spawnSync(process.execPath, [gate], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: proj,
          tool_name: 'Bash',
          tool_input: { command: 'echo probe > out.txt' },
          ...extra,
        }),
        env: { ...process.env, WF_ROUTING_STATE_DIR: stateDir, WF_INCIDENT_ROOT: incidentRoot, ZCODE_PLUGIN_ROOT: pluginRoot },
        encoding: 'utf8',
      });
    const noSess = run({});
    assert.equal(noSess.status, 2, '无 session_id：他会话有效租约不得被救回（RC-1 修复面）');
    assert.ok(String(noSess.stdout).includes('permissionDecision'), 'deny 信封可解析');
    const noSessMsg = JSON.parse(String(noSess.stdout).trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(!noSessMsg.includes('从未签发过任务挑战'), '内部任务-111：他会话桶租约在场时不得误指从未签发（内部任务-103 F2）');
    assert.ok(noSessMsg.includes('未携带会话标识'), '内部任务-111：须给会话标识缺失诊断');
    const unknown = run({ session_id: 'sess-UNKNOWN' });
    assert.equal(unknown.status, 2, '未知 session_id：deny');
    const unknownMsg = JSON.parse(String(unknown.stdout).trim()).hookSpecificOutput?.systemMessage ?? '';
    assert.ok(!unknownMsg.includes('从未签发过任务挑战') && unknownMsg.includes('与租约所在会话桶不一致'), '内部任务-111：会话桶不一致诊断（内部任务-103 F2）');
    const same = run({ session_id: 'sess-RC1' });
    assert.equal(same.status, 0, '相同 session_id：allow');
    assert.equal(String(same.stdout ?? '').trim(), '', '放行零输出（内部规则-6 信封契约不破）');
  } finally {
    env.restore();
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

// ── 内部任务-8 阶段 3（2026-10-07）：RC-5 撞号过滤键精确化（projectKey+taskId）与 schema v4 host ──
// 规格锚：内部决策-040 决策 2/3/4 + 内部规则-19 第①⑦条。

test('内部任务-8 任务 3.1：撞号过滤键=(projectKey, taskId)——异项目同号双活、同项目互斥、同会话幂等、过期不阻断', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    // 异项目同号：夹具落 projectKey=OTHER 的未过期 active 租约 → 本键声明同号必须成功
    seedActiveLease(stateDir, { token: 'tok-other-proj', sessionId: 'sess-OTHER', key: '/proj/OTHER', taskId: '内部任务-77' });
    const chA = issueChallenge('/proj/mine', { sessionId: 'sess-MINE' });
    const rA = activateLease('/proj/mine', { leaseId: chA.leaseId, taskId: '内部任务-77', skill: 'tdd' });
    assert.equal(rA.ok, true, '异项目同号不得阻断（内部决策-040 决策 2：跨项目各项目独立）');
    // 同项目异会话同号 → 阻断（既有语义回归），拒因含撞号文案与建议号
    const chB = issueChallenge('/proj/mine', { sessionId: 'sess-B' });
    const rB = activateLease('/proj/mine', { leaseId: chB.leaseId, taskId: '内部任务-77', skill: 'tdd' });
    assert.equal(rB.ok, false, '同项目异会话同号互斥');
    assert.ok(String(rB.reason).includes('撞号阻断'), '拒因文案');
    assert.ok(String(rB.reason).includes('内部任务-1'), '附建议号');
    assert.equal(existsSync(activePath(stateDir, chB.leaseId)), false, '阻断即不落盘');
    // 同项目同会话同号幂等：不被撞号阻断
    const chC = issueChallenge('/proj/mine', { sessionId: 'sess-MINE' });
    assert.equal(
      activateLease('/proj/mine', { leaseId: chC.leaseId, taskId: '内部任务-77', skill: 'tdd' }).ok,
      true,
      '同会话幂等覆盖不阻断',
    );
    // 过期项不阻断：同项目异会话同号但已过期 → 声明成功
    seedActiveLease(stateDir, {
      token: 'tok-expired-same',
      sessionId: 'sess-OLD',
      key: '/proj/mine',
      taskId: '内部任务-55',
      declaredAt: Date.now() - 7200000,
      expiresAt: Date.now() - 3600000,
    });
    const chD = issueChallenge('/proj/mine', { sessionId: 'sess-D' });
    assert.equal(
      activateLease('/proj/mine', { leaseId: chD.leaseId, taskId: '内部任务-55', skill: 'tdd' }).ok,
      true,
      '过期项不阻断（TTL 自然退出）',
    );
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 3.1：host 三态——meta 显式 > 环境探测（DSH_*→dsh / ZCODE_*→zcode）> unknown', () => {
  const saved = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => /^(DSH_|ZCODE_|KIMI_|MCODE_)/.test(k)) // 内部任务-331：扩四前缀——Kimi/MCode 宿主会话自带 KIMI_*/MCODE_* 同样击红 unknown 断言
      .map((k) => [k, process.env[k]]),
  );
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    assert.equal(leaseLib.hostOf({}), 'unknown', '皆无 → unknown');
    process.env.DSH_PROBE = '1';
    assert.equal(leaseLib.hostOf({}), 'dsh', '任一 DSH_ 前缀变量存在 → dsh');
    delete process.env.DSH_PROBE;
    process.env.ZCODE_PROBE = '1';
    assert.equal(leaseLib.hostOf({}), 'zcode', 'ZCODE_* → zcode');
    delete process.env.ZCODE_PROBE;
    process.env.ZCODE_PROBE = '';
    assert.equal(leaseLib.hostOf({}), 'unknown', '空串值不构成探测命中（内部任务-31：空串视同未设置，防跨进程分叉）');
    delete process.env.ZCODE_PROBE;
    process.env.DSH_PROBE = '';
    assert.equal(leaseLib.hostOf({}), 'unknown', 'DSH_ 空串值同样不构成探测命中（对称）');
    delete process.env.DSH_PROBE;
    assert.equal(leaseLib.hostOf({ host: 'kimi' }), 'kimi', 'meta.host 显式优先于探测');
    assert.equal(leaseLib.hostOf({ host: '' }), 'unknown', '空串不采信（回落探测）');
    assert.equal(leaseLib.hostOf({ host: 42 }), 'unknown', '非字符串不采信');
    assert.equal(leaseLib.hostOf(), 'unknown', '缺 meta 不抛');
  } finally {
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test('内部任务-8 任务 3.1：挑战体 schema v5（委派三可选字段）＋指针/租约 v4 三体同源、v4 存量读侧兼容', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const ch = issueChallenge('/proj/v4', { sessionId: 'sess-V4', host: 'zcode' });
    const chFile = JSON.parse(readFileSync(challengePath(stateDir, ch.leaseId), 'utf8'));
    assert.equal(chFile.schemaVersion, 5, '挑战体 schemaVersion=5（内部决策-061 D3）');
    assert.equal(chFile.host, 'zcode', '挑战体 host=meta.host（第一态）');
    const curFile = JSON.parse(
      readFileSync(join(stateDir, `wf-lease-current-${digest('/proj/v4')}-${digest('s:sess-V4')}.json`), 'utf8'),
    );
    assert.equal(curFile.schemaVersion, 4, 'current 指针 v4');
    assert.equal(curFile.host, 'zcode', '指针与挑战同源同值');
    assert.equal(activateLease('/proj/v4', { leaseId: ch.leaseId, taskId: '内部任务-77', skill: 'tdd' }).ok, true);
    const act = JSON.parse(readFileSync(activePath(stateDir, ch.leaseId), 'utf8'));
    assert.equal(act.schemaVersion, 4, '租约体 v4');
    assert.equal(act.host, 'zcode', '租约继承挑战 host');
    // v3 存量状态：读侧零校验按路径兼容（不按 host/schema 过滤）
    seedActiveLease(stateDir, { token: 'tok-v3-legacy', sessionId: 'sess-V3', key: '/proj/v3b', schemaVersion: 3 });
    const legacy = readActiveLease('/proj/v3b', Date.now(), { sessionId: 'sess-V3' });
    assert.equal(legacy.valid, true, 'v3 存量租约读侧照常有效（无 host 字段不阻断）');
    assert.equal(legacy.lease.host, undefined, 'v3 租约无 host 字段（读侧不补写）');
  } finally {
    env.restore();
  }
});

// ── 内部任务-8 阶段 4（2026-10-07）：claim 占用面 + 心跳 + GC 扩面 + --release + TTL 45min ──
// 规格锚：内部规则-19 全条 + 内部决策-018 修正案 1/3/4 + 内部决策-9/内部决策-10。

/** claim 文件路径推算（与 lib 内部算法一致：keyDigest(key) + keyDigest('t:'+taskId)）。 */
const claimPath = (stateDir, key, taskId) => join(stateDir, `wf-lease-claim-${digest(key)}-${digest(`t:${taskId}`)}.json`);

test('内部任务-8 任务 4.1：声明建立 claim（字段保真）；轮换不删 claim（RC-2 核心）——守卫改读 claim 后同号仍互斥', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/claim';
    const chA = issueChallenge(key, { sessionId: 'sess-A' });
    const actA = activateLease(key, { leaseId: chA.leaseId, taskId: '内部任务-31', skill: 'tdd' });
    assert.equal(actA.ok, true);
    assert.equal(actA.claimWritten, true, '声明返回 claimWritten=true（门禁实例1 F3：写失败须可见）');
    const cf = claimPath(stateDir, key, '内部任务-31');
    assert.ok(existsSync(cf), '声明成功建立 claim 文件');
    const claim = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(claim.projectKey, key, 'projectKey 保真');
    assert.equal(claim.taskId, '内部任务-31', 'taskId 保真');
    assert.equal(claim.sessionId, 'sess-A', 'sessionId 保真');
    assert.ok(typeof claim.host === 'string' && claim.host, 'host 保真（非空字符串）');
    assert.ok(Number.isFinite(Number(claim.claimedAt)), 'claimedAt 合法');
    assert.ok(Number(claim.expiresAt) > Date.now(), 'expiresAt 未过期');
    // 轮换不删 claim：同会话再签发（轮换吊销 active/challenge）——占用事实留存
    issueChallenge(key, { sessionId: 'sess-A' });
    assert.ok(existsSync(cf), '轮换不删 claim（占用与写权限解耦，内部决策-9）');
    assert.equal(existsSync(activePath(stateDir, chA.leaseId)), false, 'active 随轮换吊销（既有语义）');
    // 第二会话声明同号仍被阻断（守卫改读 claim）
    const chB = issueChallenge(key, { sessionId: 'sess-B' });
    const rB = activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-31', skill: 'tdd' });
    assert.equal(rB.ok, false, '轮换后同号仍互斥（撞号守卫读 claim——RC-2 修复面）');
    assert.ok(String(rB.reason).includes('撞号阻断') && String(rB.reason).includes('已被会话'), '拒因沿用撞号文案');
    assert.equal(existsSync(activePath(stateDir, chB.leaseId)), false, '阻断即不落盘');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 4.1：过期 claim 自清且本次声明成功（死会话退出双面断言）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/claim2';
    const chA = issueChallenge(key, { sessionId: 'sess-A' });
    assert.ok(activateLease(key, { leaseId: chA.leaseId, taskId: '内部任务-32', skill: 'tdd' }).ok);
    const cf = claimPath(stateDir, key, '内部任务-32');
    // 死会话形态：claim 与 active 同置过期
    const claim = JSON.parse(readFileSync(cf, 'utf8'));
    claim.expiresAt = Date.now() - 1000;
    writeFileSync(cf, JSON.stringify(claim));
    const act = JSON.parse(readFileSync(activePath(stateDir, chA.leaseId), 'utf8'));
    act.expiresAt = Date.now() - 1000;
    writeFileSync(activePath(stateDir, chA.leaseId), JSON.stringify(act));
    // 他人声明同号：过期占用不得阻塞
    const chB = issueChallenge(key, { sessionId: 'sess-B' });
    const rB = activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-32', skill: 'tdd' });
    assert.equal(rB.ok, true, '过期 claim/active 不再参与撞号（死会话退出）');
    const after = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(after.sessionId, 'sess-B', '过期 claim 被清理后重建为新持有者');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 4.1：坏 claim 半损坏——守卫不阻断（误放非误拒）、sweep 不清、不抛', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/claim3';
    mkdirSync(stateDir, { recursive: true });
    const cf = claimPath(stateDir, key, '内部任务-33');
    // 半损坏：expiresAt 非数值（NaN 语义）+ 缺 claimedAt
    writeFileSync(cf, JSON.stringify({ projectKey: key, taskId: '内部任务-33', sessionId: 'sess-DEAD', expiresAt: 'not-a-number' }));
    const ch = issueChallenge(key, { sessionId: 'sess-B' });
    const r = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-33', skill: 'tdd' });
    assert.equal(r.ok, true, '半损坏 claim 不阻断声明（不可判定 → 安全侧误放）');
    assert.ok(existsSync(cf), 'sweep 不清不可判定的 claim（不静默删证据）');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 4.1/门B-F2：心跳盘上节流（剩余 > 2/3 TTL 不写；临近过期才顺延且 claim/active 同更）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/hb';
    const ch = issueChallenge(key, { sessionId: 'sess-A' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-34', skill: 'tdd' }).ok);
    const lease = readActiveLease(key, Date.now(), { sessionId: 'sess-A' }).lease;
    assert.ok(lease, '读侧取得租约对象');
    // 刚激活：剩余 ≈ 全 TTL > 2/3 → 盘上节流跳过（门 B F2：闸每进程一调用，进程内 Map 恒冷）
    assert.equal(leaseLib.heartbeatLease(lease), false, '剩余充足时跳过写盘');
    // 逼近过期：active 与 claim 同步置为 now + TTL/6（< 2/3 TTL）
    const near = Date.now() + Math.floor(leaseLib.DEFAULT_TTL_MS / 6);
    for (const f of [activePath(stateDir, ch.leaseId), claimPath(stateDir, key, '内部任务-34')]) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      writeFileSync(f, JSON.stringify({ ...raw, expiresAt: near }));
    }
    assert.equal(leaseLib.heartbeatLease(lease), true, '临近过期 → 顺延写盘');
    const activeAfter = JSON.parse(readFileSync(activePath(stateDir, ch.leaseId), 'utf8')).expiresAt;
    const claimAfter = JSON.parse(readFileSync(claimPath(stateDir, key, '内部任务-34'), 'utf8')).expiresAt;
    assert.ok(activeAfter > near, 'active.expiresAt 顺延');
    assert.equal(claimAfter, activeAfter, 'claim 与 active 同更（同一顺延值）');
    assert.equal(leaseLib.heartbeatLease(lease), false, '顺延后立即再调 → 盘上节流跳过（跨进程一致）');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 4.1：GC 全目录扫描——异项目过期三类件被清、本项目存活件不动', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    mkdirSync(stateDir, { recursive: true });
    const past = Date.now() - 10000;
    writeFileSync(
      join(stateDir, 'wf-lease-challenge-deadbeef00000000.json'),
      JSON.stringify({ schemaVersion: 4, leaseId: 'deadbeef00000000', projectKey: '/proj/OTHER', sessionId: 'sX', expiresAt: past }),
    );
    seedActiveLease(stateDir, { token: 'beefdead00000000', sessionId: 'sX', key: '/proj/OTHER', expiresAt: past, declaredAt: past - 1000 });
    writeFileSync(
      claimPath(stateDir, '/proj/OTHER', '内部任务-90'),
      JSON.stringify({ schemaVersion: 4, projectKey: '/proj/OTHER', taskId: '内部任务-90', sessionId: 'sX', claimedAt: past - 1000, expiresAt: past }),
    );
    const mine = issueChallenge('/proj/gc', { sessionId: 'sess-GC' }); // 顺带触发 sweep
    assert.equal(existsSync(join(stateDir, 'wf-lease-challenge-deadbeef00000000.json')), false, '异项目过期挑战被清（全目录扫描）');
    assert.equal(existsSync(activePath(stateDir, 'beefdead00000000')), false, '异项目过期 active 被清');
    assert.equal(existsSync(claimPath(stateDir, '/proj/OTHER', '内部任务-90')), false, '异项目过期 claim 被清');
    assert.ok(existsSync(challengePath(stateDir, mine.leaseId)), '本项目新签发挑战存活（不误清）');
  } finally {
    env.restore();
  }
});

test('内部未决-86（内部任务-46）：GC 损坏件计龄隔离——超 TTL 迁 quarantine、新鲜不动、合法过期仍清、current 指针同路', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    mkdirSync(stateDir, { recursive: true });
    const past = Date.now() - 10000;
    const stale = Date.now() - (leaseLib.DEFAULT_TTL_MS + 60000);
    const fresh = Date.now() - 1000;
    // 超龄损坏三族
    const corrupt = [
      'wf-lease-challenge-cccc000000000001.json',
      'wf-lease-active-cccc000000000002.json',
      'wf-lease-claim-cccc000000000003.json',
    ];
    for (const n of corrupt) {
      writeFileSync(join(stateDir, n), '{ 坏 JSON');
      utimesSync(join(stateDir, n), new Date(stale), new Date(stale)); // utimes 数值参数按秒解释——毫秒须包 Date
    }
    // 真实 current 指针（先建真会话拿真文件名，再原地损坏）
    const key = '/proj/quar';
    const ch = issueChallenge(key, { sessionId: 'sess-Q' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-46', skill: 'tdd' }).ok);
    const ptrName = readdirSync(stateDir).find((n) => n.startsWith('wf-lease-current-'));
    assert.ok(ptrName, '真实 current 指针在位');
    writeFileSync(join(stateDir, ptrName), '{ 坏 JSON');
    utimesSync(join(stateDir, ptrName), new Date(stale), new Date(stale));
    // 新鲜损坏（不动）与合法过期（照旧清）
    writeFileSync(join(stateDir, 'wf-lease-challenge-dddd000000000004.json'), '{ 坏 JSON');
    utimesSync(join(stateDir, 'wf-lease-challenge-dddd000000000004.json'), new Date(fresh), new Date(fresh));
    writeFileSync(join(stateDir, 'wf-lease-challenge-eeee000000000005.json'),
      JSON.stringify({ schemaVersion: 4, leaseId: 'eeee000000000005', projectKey: '/proj/X', sessionId: 'sY', expiresAt: past }));
    const mine = issueChallenge(key, { sessionId: 'sess-R' }); // 触发 sweep——同键触发（current 指针扫描按调用键前缀过滤，异键触发不进隔离分支——视角一发现 1 处置；异会话同键挑战可并存，指针 per-session digest 不冲突）
    const q = join(stateDir, 'quarantine');
    for (const n of [...corrupt, ptrName]) {
      assert.ok(existsSync(join(q, n)), `超龄损坏件迁 quarantine：${n}`);
      assert.equal(existsSync(join(stateDir, n)), false, `原位已移走：${n}`);
    }
    assert.ok(existsSync(join(stateDir, 'wf-lease-challenge-dddd000000000004.json')), '新鲜损坏不动（容忍瞬态写入）');
    assert.equal(existsSync(join(stateDir, 'wf-lease-challenge-eeee000000000005.json')), false, '合法过期照旧清（行为不变）');
    assert.ok(existsSync(challengePath(stateDir, mine.leaseId)), '本项目新签发挑战存活');
  } finally {
    env.restore();
  }
});

test('内部任务-24 D2：--release 三作用域强制择一（--lease 反查会话定向释放 / --all-sessions 显式全量 / 裸用拒 + 互斥拒）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-rel-inc-'));
  const proj = mkdtempSync(join(tmpdir(), 'wf-rel-proj-'));
  const runRel = (args) =>
    spawnSync(process.execPath, [DECLARE, '--release', ...args], {
      cwd: proj,
      encoding: 'utf8',
      env: (() => {
        // 内部未决-87（内部任务-46）：探测链接管裸用后，宿主环境带非空 DSH_SESSION_ID 会使裸用分支
        // 走「缺省本会话」——本用例断言的是「未探测到会话标识」形态，隔离该变量（视角一发现 4 处置）
        const e = { ...process.env, WF_ROUTING_STATE_DIR: stateDir, WF_INCIDENT_ROOT: incidentRoot };
        delete e.DSH_SESSION_ID;
        return e;
      })(),
    });
  try {
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    // 双会话并占：sess-REL（目标）+ sess-OTHER（必须存活）
    const ch = issueChallenge(key, { sessionId: 'sess-REL' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-35', skill: 'tdd' }).ok);
    const chO = issueChallenge(key, { sessionId: 'sess-OTHER' });
    assert.ok(activateLease(key, { leaseId: chO.leaseId, taskId: '内部任务-36', skill: 'tdd' }).ok);
    const cf = claimPath(stateDir, key, '内部任务-35');
    const af = activePath(stateDir, ch.leaseId);
    const afO = activePath(stateDir, chO.leaseId);
    const curFile = join(stateDir, `wf-lease-current-${digest(key)}-${digest('s:sess-REL')}.json`);
    assert.ok(existsSync(cf) && existsSync(af) && existsSync(curFile) && existsSync(afO), '释放前双会话件齐备');
    // ① 裸 --release：拒绝 + 三作用域用法（旧「默认全量」废止——多会话下构成意外吊销，内部任务-99 D2）
    const bare = runRel([]);
    assert.notEqual(bare.status, 0, '裸 --release 必须非 0');
    assert.ok(String(bare.stderr).includes('--lease') && String(bare.stderr).includes('--session') && String(bare.stderr).includes('--all-sessions'), '拒因附三作用域用法');
    assert.ok(existsSync(af) && existsSync(afO), '裸用拒后零删改');
    // ② --lease 反查会话定向释放：sess-REL 三件删净、sess-OTHER 存活
    const rel = runRel(['--lease', ch.leaseId]);
    assert.equal(rel.status, 0, `--lease 定向释放须 exit 0（stderr=${rel.stderr}）`);
    assert.ok(String(rel.stdout).includes('已释放'), 'stdout 含确认文案');
    assert.ok(String(rel.stdout).includes('sess-REL'), 'stdout 点名会话范围');
    assert.equal(existsSync(cf), false, 'claim 已删');
    assert.equal(existsSync(af), false, 'active 已删');
    assert.equal(existsSync(curFile), false, 'current 指针已删');
    assert.ok(existsSync(afO), '他会话 active 存活（定向释放不误伤）');
    assert.equal(readActiveLease(key, Date.now(), { sessionId: 'sess-OTHER' }).valid, true, '他会话租约仍有效');
    const incFile = join(incidentRoot, '.workflow', 'incidents.jsonl');
    assert.equal(existsSync(incFile) ? readFileSync(incFile, 'utf8').trim() : '', '', '正常生命周期事件零 incident 落盘');
    // ③ --all-sessions：显式全量（含他会话）
    const all = runRel(['--all-sessions']);
    assert.equal(all.status, 0, '--all-sessions 须 exit 0');
    assert.equal(existsSync(afO), false, '全量释放删他会话 active');
    // ④ 过期/不存在令牌反查失败拒 + 旗标互斥拒
    const badTok = runRel(['--lease', '0'.repeat(32)]);
    assert.notEqual(badTok.status, 0, '无效令牌必须拒');
    assert.ok(String(badTok.stderr).includes('无法反查'), '拒因指名反查失败');
    const mutex = runRel(['--all-sessions', '--session', 'sess-X']);
    assert.notEqual(mutex.status, 0, '双作用域旗标必须拒（互斥）');
    // ⑤ 阶段复审正确性修复锚：--session 空串拒（防静默退化全量释放——releaseClaim 的
    // sess 归一会把 '' 当 null）；--lease 非法形态拒（路径消毒，不进文件名拼接）；旗标缺值分诊
    const emptySess = runRel(['--session', '']);
    assert.notEqual(emptySess.status, 0, '--session 空串必须拒（阶段复审发现 1）');
    assert.ok(String(emptySess.stderr).includes('不得为空'), '拒因指名空值退化风险');
    const badShape = runRel(['--lease', '../../etc/passwd']);
    assert.notEqual(badShape.status, 0, '--lease 非十六进制形态必须拒（阶段复审发现 2：路径消毒）');
    assert.ok(String(badShape.stderr).includes('形态非法'), '拒因指名形态校验');
    const noVal = runRel(['--lease']);
    assert.notEqual(noVal.status, 0, '旗标缺值必须拒');
    assert.ok(String(noVal.stderr).includes('缺值'), '缺值与缺旗标分诊（阶段复审发现 3）');
    // 零态幂等：--all-sessions 无可释放项仍退 0
    const r2 = runRel(['--all-sessions']);
    assert.equal(r2.status, 0, '零态幂等退 0');
    assert.ok(String(r2.stdout).includes('已释放 0 项') || String(r2.stdout).includes('已释放'), '零态输出可解析');
  } finally {
    env.restore();
    rmSync(proj, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('内部未决-87（内部任务-46）：--release 缺省作用域探测链——DSH_SESSION_ID 命中即本会话／空串视同未设置／未命中裸用拒', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  const proj = mkdtempSync(join(tmpdir(), 'wf-rel-env-'));
  const runBare = (extra) =>
    spawnSync(process.execPath, [DECLARE, '--release'], {
      cwd: proj,
      encoding: 'utf8',
      env: (() => {
        // 先 delete 再覆盖：extra 缺键＝「变量未设置」形态（spread undefined 会写成字符串 "undefined"）
        const e = { ...process.env, WF_ROUTING_STATE_DIR: stateDir };
        delete e.DSH_SESSION_ID;
        return Object.assign(e, extra ?? {});
      })(),
    });
  try {
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    const seed = (sid, task) => {
      const ch = issueChallenge(key, { sessionId: sid });
      assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: task, skill: 'plan-execution' }).ok);
      return ch;
    };
    const owner = seed('sess-owner', '内部任务-46');
    seed('sess-other', '内部任务-47');
    // ① 命中：缺省作用域＝本会话——只释放 sess-owner 条目，他会话存活
    const hit = runBare({ DSH_SESSION_ID: 'sess-owner' });
    assert.equal(hit.status, 0, `命中已证实变量时裸用＝本会话释放（stdout：${hit.stdout}；stderr：${hit.stderr}）`);
    assert.ok(String(hit.stdout).includes('本会话'), '输出注明缺省作用域来源');
    assert.equal(existsSync(activePath(stateDir, owner.leaseId)), false, '本会话 active 已释放');
    assert.ok(readdirSync(stateDir).some((n) => n.startsWith('wf-lease-active-')), '他会话 active 存活（缺省非全量）');
    // ② 空串视同未设置：裸用拒（内部规则-19 ⑦ 空串判据同款）——拒因钉探测链分支专属文案（内部任务-44 learnings：负例断言须可归因到目标分支）
    const empty = runBare({ DSH_SESSION_ID: '' });
    assert.notEqual(empty.status, 0, '空串不构成会话标识');
    assert.ok(String(empty.stderr).includes('未探测到已证实的宿主会话标识变量'), '拒因＝探测链未命中分支（非键解析等其他异因）');
    // ③ 未命中：裸用拒（既有行为不变——未证实宿主不猜）
    const bare = runBare();
    assert.notEqual(bare.status, 0, '未命中已证实变量时维持裸用拒');
    assert.ok(String(bare.stderr).includes('未探测到已证实的宿主会话标识变量'), '拒因＝探测链未命中分支');
  } finally {
    env.restore();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('内部任务-24 D1：会话 A 激活主键 → CLI 补签挂 null 桶 → 会话 B 声明后 B 侧闸读 valid（内部任务-99 死循环骨架）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  const mainRepo = mkdtempSync(join(tmpdir(), 'wf-d1-main-'));
  const nested = mkdtempSync(join(tmpdir(), 'wf-d1-nested-'));
  const incidentRoot = mkdtempSync(join(tmpdir(), 'wf-d1-inc-'));
  try {
    mkdirSync(join(mainRepo, '.git'), { recursive: true });
    mkdirSync(join(nested, '.git'), { recursive: true });
    const mainKey = projectKey(mainRepo);
    const nestedKey = projectKey(nested);
    // ① 会话 A 激活主键租约（补签前置；此时会话 B 在嵌套仓的挑战已过期——补签场景）
    const chA = issueChallenge(mainKey, { sessionId: 'sess-A' });
    assert.ok(activateLease(mainKey, { leaseId: chA.leaseId, taskId: '内部任务-50', skill: 'tdd' }).ok, 'A 声明主键');
    // 并行背景：会话 B 此前在嵌套仓有过一轮（已过期悬空）——模拟多会话长会话现场
    issueChallenge(nestedKey, { sessionId: 'sess-B' });
    // ② CLI 补签（Bash 发起，无宿主会话标识）——修复前继承 newestActiveLease 的 sess-A
    const r = spawnSync(process.execPath, [DECLARE, '--bootstrap-reissue', nested], {
      cwd: mainRepo,
      encoding: 'utf8',
      env: { ...process.env, WF_ROUTING_STATE_DIR: stateDir, WF_INCIDENT_ROOT: incidentRoot },
    });
    assert.equal(r.status, 0, `补签应成功（stderr=${r.stderr}）`);
    const token = String(r.stdout).match(/[0-9a-f]{32}/)?.[0];
    assert.ok(token, 'stdout 须携带新令牌');
    // ③ 断言桶归属：挑战文件 sessionId === null（修复前 = 'sess-A' → B 会话死循环）
    const chFile = JSON.parse(readFileSync(challengePath(stateDir, token), 'utf8'));
    assert.equal(chFile.sessionId, null, 'D1：补签挑战必须挂 null 桶');
    // ④ 会话 B 用新令牌声明（激活继承挑战 sessionId=null → active 落 null 桶）
    assert.ok(activateLease(nestedKey, { leaseId: token, taskId: '内部任务-51', skill: 'tdd' }).ok, 'B 声明补签令牌');
    // ⑤ B 侧闸读 valid（修复前：挑战挂 A 桶 → active 挂 A 具名桶 → B 不可见 → STATE_MISSING 死循环）
    assert.equal(readActiveLease(nestedKey, Date.now(), { sessionId: 'sess-B' }).valid, true, 'B 侧可达');
    // ⑥ 对照组：A 侧亦 valid（null 桶全观察侧可见——可见性表行为锚）
    assert.equal(readActiveLease(nestedKey, Date.now(), { sessionId: 'sess-A' }).valid, true, 'null 桶对具名观察侧全可见');
  } finally {
    env.restore();
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(incidentRoot, { recursive: true, force: true });
  }
});

test('内部任务-24 D3：leaseStatusOfKeys 三键夹具——declared/issued/none 三态 + token 短显 + 观察会话过滤', () => {
  const env = freshEnv();
  try {
    const k1 = '/proj/st-1';
    const k2 = '/proj/st-2';
    const k3 = '/proj/st-3';
    // K1：sess-O 签发+激活（declared）；K2：sess-O 签发未声明（issued）；K3：无签发（none）
    const ch1 = issueChallenge(k1, { sessionId: 'sess-O' });
    assert.ok(activateLease(k1, { leaseId: ch1.leaseId, taskId: '内部任务-80', skill: 'tdd' }).ok);
    const ch2 = issueChallenge(k2, { sessionId: 'sess-O' });
    const rows = leaseLib.leaseStatusOfKeys([k1, k2, k3], Date.now(), { sessionId: 'sess-O' });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.state),
      ['declared', 'issued', 'none'],
      '三键三态',
    );
    assert.ok(rows[1].tokenShort.length === 8, 'issued 行 token 短显 8 位');
    assert.ok(ch2.leaseId.startsWith(rows[1].tokenShort), '短显是令牌前缀');
    assert.ok(!('tokenShort' in rows[0]) && !('tokenShort' in rows[2]), 'declared/none 行不带 token');
    // 观察会话过滤：换 sess-X 观察——K1 的 active 挂 sess-O 具名桶不可见；且 currentChallengeToken
    // 按观察桶取（X 无自己的挑战）→ none。语义选择：状态是观察侧口径——X 不该被告知「已签发
    // 未声明」并去声明 O 的令牌（跨会话重放结构性无效），X 的出路是下一轮 prompt 自己获挑战。
    const rowsX = leaseLib.leaseStatusOfKeys([k1], Date.now(), { sessionId: 'sess-X' });
    assert.equal(rowsX[0].state, 'none', '异会话观察侧：他会话 active 不可见且本会话无挑战（可见性表+观察桶口径）');
  } finally {
    env.restore();
  }
});

test('内部任务-24 B：取号扫描面补 内部计划 子目录名——计数 + 域推断 + 缺席 fail-open + 旧形态不计', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-b-num-'));
  const prev = process.env.WF_ROUTING_STATE_DIR;
  const stateDir = join(home, 'state');
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  try {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const key = projectKey(repo);
    // ① evidence 目录在场即计数（receipts 缺席时该源独立生效——跨机新克隆形态；
    //    git 源占 {1}、evidence 填 2 → 稠密建议 3，无 evidence 时为 2〔判别力〕）
    mkdirSync(join(repo, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'plans', 'evidence', '内部任务-2'), { recursive: true });
    let sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', 'evidence 子目录名入取号扫描面（git 同步面，内部任务-117 稠密填位）');
    // ② 域推断：删 domains.json 与 receipts（缺席），evidence 在场即有域
    const domainsFile = join(repo, '.workflow', 'domains.json');
    try { rmSync(domainsFile, { force: true }); } catch { /* 未配置形态 */ }
    sug = leaseLib.suggestedTaskId(key);
    assert.ok(sug.ok && sug.suggestions.some((s) => s.domain === 'DEV'), 'evidence 目录名参与域推断（跨机新克隆）');
    // ③ 旧形态目录（内部任务-INSTALL-056）不匹配 DOMAIN_TASK_RE，天然不可见（内部未决-76 旧号不回填）
    mkdirSync(join(repo, 'docs', 'plans', 'evidence', '内部任务-INSTALL-056'), { recursive: true });
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '旧形态目录不计入');
    // ④ 消费者仓常态（无 内部计划）缺席 fail-open：行为与现版一致（空态建议 <域>-1）
    const bare = join(home, 'bare');
    mkdirSync(join(bare, '.git'), { recursive: true });
    sug = leaseLib.suggestedTaskId(projectKey(bare), { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-1', '无 evidence 目录的仓维持空态取 1（fail-open）');
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部任务-37：取号扫描面补 docs/plans/ 平铺文件名内嵌任务号——计数/归一/双 token/跨源稠密（内部任务-117）/推断排除平铺源/负例/序号上限', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-b-flat-'));
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = join(home, 'state');
  try {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    const key = projectKey(repo);
    // ① 平铺名入计数：小写无分隔（dev2）/大写嵌名（内部任务-27）/连号双 token（dev29+dev30）/高位 dev31
    //    git 源占 {1}、平铺填 2 → 稠密建议 3（无平铺时为 2〔判别力〕，内部任务-117）
    mkdirSync(join(repo, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-06-dev2-planning-boundary.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-09-内部任务-27-lease-read-diagnose-batch.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-09-dev29-dev30-install-and-fix-handoff.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-09-dev31-host-probe-empty-string-fix.md'), 'x', 'utf8');
    let sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '平铺源填位（dev2）——历史栖身地对稠密取号器可见（内部任务-36 根因机械修复，内部任务-117 语义）');
    // ② 推断面排除平铺源（此时无 domains.json、无严格源目录——①的 receipts 临时移除）：零域态默认域兜底而非推出平铺 slug 幻域
    rmSync(join(repo, '.sdd'), { recursive: true, force: true });
    let sugNoDom = leaseLib.suggestedTaskId(key);
    assert.equal(sugNoDom.ok, true);
    assert.equal(sugNoDom.usedDefaultDomains, true, '零域态走默认域兜底（内部任务-75）');
    assert.deepEqual(sugNoDom.suggestions.map((s) => s.domain), ['DEV'], '推断面排除平铺源——slug 幻域不入建议集，恰默认域单建议');
    // ③ 严格源参与推断 + slug 幻域不入推断 + 跨源稠密：evidence 内部任务-9 推出 DEV；open76 不产 OPEN；低位空位判别恢复（receipts 重建 {1}）
    mkdirSync(join(repo, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'plans', 'evidence', '内部任务-9'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-05-open76-domain-taskid.md'), 'x', 'utf8');
    const sugInf = leaseLib.suggestedTaskId(key);
    assert.ok(sugInf.ok && sugInf.suggestions.some((s) => s.domain === 'DEV'), '严格源（evidence 目录名）参与域推断');
    assert.ok(!sugInf.suggestions.some((s) => s.domain === 'OPEN'), '平铺 slug 幻域不入推断面');
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '跨源稠密（evidence 9 不扰低位空位）');
    // ④ 负例：旧复合形态/杂项/词内子串不匹配——建议号不动；纯数字尾变体 task-12 按域码 TASK 计入（异域不扰 DEV）
    writeFileSync(join(repo, 'docs', 'plans', 'code-review-内部任务-OBSO-DARWIN-1-final.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '.DS_Store'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', 'webdev42-notes.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '2026-09-30-release-054-operation.md'), 'x', 'utf8');
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-11-task-12-notes.md'), 'x', 'utf8');
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '负例零命中（DARWIN/RELEASE 词长越窗、DS 后继非数字、webdev42 词内子串被词首锚挡）；task-12 按 内部规则-8 撞号句口径入 TASK 域计数不扰 DEV');
    mkdirSync(join(repo, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    const sugTask = leaseLib.suggestedTaskId(key, { domain: 'TASK' });
    assert.equal(sugTask.suggestions[0].taskId, '内部任务-2', '纯数字尾变体 内部任务-12 入 TASK 域稠密计数（内部任务-1 填位判别，钉住 JSDoc 口径行为）');
    // ⑤ 序号上限守卫：>999999 跳过（与 DOMAIN_TASK_RE {1,6} 一致）
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-11-dev1234567-overflow.md'), 'x', 'utf8');
    sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-3', '七位序号非任务号形态，跳过');
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('TTL 默认 60min（3600000ms，内部决策-045/内部任务-96 修订——原 45min 随活动滑动锚上调）+ WF_ROUTING_TTL_MS 覆盖不变', () => {
  assert.equal(leaseLib.DEFAULT_TTL_MS, 60 * 60 * 1000, 'DEFAULT_TTL_MS=3600000（死会话阻塞窗口 ≤60min，活动滑动锚下更精确）');
  assert.equal(leaseLib.DEFAULT_TTL_MS, 3600000);
  const prev = process.env.WF_ROUTING_TTL_MS;
  try {
    process.env.WF_ROUTING_TTL_MS = '1234';
    assert.equal(leaseLib.ttlMs(), 1234, '环境覆盖仍生效');
    delete process.env.WF_ROUTING_TTL_MS;
    assert.equal(leaseLib.ttlMs(), 3600000, '缺省回落 60min');
  } finally {
    if (prev === undefined) delete process.env.WF_ROUTING_TTL_MS;
    else process.env.WF_ROUTING_TTL_MS = prev;
  }
});

// ── 内部任务-8 阶段 5（2026-10-07）：RC-4 签发自校验 + 拒因同源 + 签发探针 ──
// 规格锚：内部规则-19 第⑥条 + 内部决策-018 修正案 5。

test('内部任务-8 门B-delta N-1：host 缺失侧视为不可比——同会话遇存量 v3 无 host 旧租约不被自家判撞号', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/n1';
    mkdirSync(stateDir, { recursive: true });
    // 存量 v3 active（无 host、无 claim）+ 同会话同号 → 不得自我阻断
    seedActiveLease(stateDir, { token: 'tok-v3-self', sessionId: 'sess-SELF', key, taskId: '内部任务-71', schemaVersion: 3 });
    const ch = issueChallenge(key, { sessionId: 'sess-SELF', host: 'dsh' });
    assert.equal(
      activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-71', skill: 'tdd' }).ok,
      true,
      'host 缺失不构成「异宿主」证据（否则同会话被自家旧租约撞号阻断）',
    );
    // 对照：host 双侧均有且不同 → 仍互斥（6.3③ 语义保持）
    seedActiveLease(stateDir, { token: 'tok-other-host', sessionId: 'sess-SELF2', key, taskId: '内部任务-72', schemaVersion: 4 });
    const raw = JSON.parse(readFileSync(activePath(stateDir, 'tok-other-host'), 'utf8'));
    writeFileSync(activePath(stateDir, 'tok-other-host'), JSON.stringify({ ...raw, host: 'kimi' }));
    const ch2 = issueChallenge(key, { sessionId: 'sess-SELF2', host: 'dsh' });
    assert.equal(
      activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-72', skill: 'tdd' }).ok,
      false,
      'host 双侧均有且不同 → 仍互斥',
    );
  } finally {
    env.restore();
  }
});

test('内部任务-8 门B-F4：releaseClaim 会话过滤分支——sessionId 非空只释放该会话；null 释放本键全部', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/rel';
    const chA = issueChallenge(key, { sessionId: 'sess-A' });
    assert.ok(activateLease(key, { leaseId: chA.leaseId, taskId: '内部任务-61', skill: 'tdd' }).ok, 'A 声明');
    const chB = issueChallenge(key, { sessionId: 'sess-B' });
    assert.ok(activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-62', skill: 'tdd' }).ok, 'B 声明');
    const n1 = leaseLib.releaseClaim(key, 'sess-A');
    assert.ok(n1 >= 2, `会话过滤释放：claim+active+指针 ≥2 项（实测 ${n1}）`);
    assert.equal(existsSync(claimPath(stateDir, key, '内部任务-61')), false, 'A 的 claim 已删');
    assert.ok(existsSync(claimPath(stateDir, key, '内部任务-62')), 'B 的 claim 保留（会话过滤生效）');
    assert.equal(readActiveLease(key, Date.now(), { sessionId: 'sess-B' }).valid, true, 'B 的租约未受影响');
    const n2 = leaseLib.releaseClaim(key, null);
    assert.ok(n2 >= 1, 'null → 本键全部会话');
    assert.equal(existsSync(claimPath(stateDir, key, '内部任务-62')), false, 'B 的 claim 亦删');
  } finally {
    env.restore();
  }
});

test('内部任务-24 D4：activationReachability——健康态 ok；指针悬空+active 落他会话桶时不可达（warn 判据）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/d4';
    const ch = issueChallenge(key, { sessionId: 'sess-Y' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-70', skill: 'tdd' }).ok, 'Y 声明');
    // 健康态：挑战会话 Y 回读 valid（指针→挑战→active 全链在位）
    assert.equal(leaseLib.activationReachability(key, ch.leaseId).ok, true, '健康态可达');
    // 损坏态（D1 事后现场同构）：指针删除 + active 被改挂他会话桶——Y 观察侧按可见性表
    // （具名观察侧仅见同桶+null 桶）不可见 → 不可达（声明侧应告警「闸侧不可达」）
    rmSync(join(stateDir, `wf-lease-current-${digest(key)}-${digest('s:sess-Y')}.json`), { force: true });
    const raw = JSON.parse(readFileSync(activePath(stateDir, ch.leaseId), 'utf8'));
    writeFileSync(activePath(stateDir, ch.leaseId), JSON.stringify({ ...raw, sessionId: 'sess-STRANGER' }));
    const reach = leaseLib.activationReachability(key, ch.leaseId);
    assert.equal(reach.ok, false, '损坏态不可达');
    assert.ok(typeof reach.reason === 'string' && reach.reason.length > 0, '不可达须携带读侧拒因');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 6.3③（内部规则-19 ⑦）：异宿主同 sessionId 不误判同会话——host 参与具名会话判等', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/xhost';
    mkdirSync(stateDir, { recursive: true });
    // 夹具：同 projectKey + 同 sessionId 字符串，但 host=kimi（异宿主）
    writeFileSync(
      claimPath(stateDir, key, '内部任务-77'),
      JSON.stringify({
        schemaVersion: 4,
        projectKey: key,
        taskId: '内部任务-77',
        sessionId: 'sess-same',
        host: 'kimi',
        claimedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      }),
    );
    const ch = issueChallenge(key, { sessionId: 'sess-same', host: 'dsh' });
    const r = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-77', skill: 'tdd' });
    assert.equal(r.ok, false, '异宿主同 sessionId 不得误判同会话（第二声明被拒）');
    assert.ok(String(r.reason).includes('撞号阻断'), '撞号拒因文案');
    assert.ok(existsSync(claimPath(stateDir, key, '内部任务-77')), '第一持有者 claim 不受影响');
    // 同 host + 同 sessionId → 幂等放行
    const ch2 = issueChallenge(key, { sessionId: 'sess-same', host: 'kimi' });
    assert.equal(
      activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-77', skill: 'tdd' }).ok,
      true,
      '同宿主同会话幂等不阻断',
    );
    // null 会话不比对 host（null 桶多活弱形态保持）
    writeFileSync(
      claimPath(stateDir, key, '内部任务-78'),
      JSON.stringify({ schemaVersion: 4, projectKey: key, taskId: '内部任务-78', sessionId: null, host: 'kimi', claimedAt: Date.now(), expiresAt: Date.now() + 3600000 }),
    );
    const ch3 = issueChallenge(key, { host: 'dsh' }); // 无 sessionId（null 桶）
    assert.equal(
      activateLease(key, { leaseId: ch3.leaseId, taskId: '内部任务-78', skill: 'tdd' }).ok,
      true,
      'null 会话不比对 host（内部决策-018 修正案弱形态保持）',
    );
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 5.1：verifyChallengeOnDisk 三态（ok / missing / expired / mismatch）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const ch = issueChallenge('/proj/verify', { sessionId: 'sess-V' });
    assert.deepEqual(leaseLib.verifyChallengeOnDisk(ch.leaseId), { ok: true }, '真签后回读通过');
    const f = challengePath(stateDir, ch.leaseId);
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...raw, expiresAt: Date.now() - 1000 }));
    assert.deepEqual(leaseLib.verifyChallengeOnDisk(ch.leaseId), { ok: false, reason: 'expired' }, '过期判 expired');
    const noKey = { ...raw };
    delete noKey.projectKey;
    writeFileSync(f, JSON.stringify(noKey));
    assert.deepEqual(leaseLib.verifyChallengeOnDisk(ch.leaseId), { ok: false, reason: 'mismatch' }, '字段非法判 mismatch');
    rmSync(f, { force: true });
    assert.deepEqual(leaseLib.verifyChallengeOnDisk(ch.leaseId), { ok: false, reason: 'missing' }, '缺失判 missing');
    assert.deepEqual(leaseLib.verifyChallengeOnDisk('0'.repeat(32)), { ok: false, reason: 'missing' }, '未知令牌同判 missing');
  } finally {
    env.restore();
  }
});

test('内部任务-8 任务 5.1/5.3：LEASE_REASONS 常量导出且被库内拒因引用（单一来源）', () => {
  const R = leaseLib.LEASE_REASONS;
  assert.ok(R && typeof R === 'object', 'LEASE_REASONS 已导出');
  assert.equal(R.EXPIRED_CHALLENGE, '挑战已过期', '前缀常量（闸侧 startsWith 分流用）');
  assert.equal(R.UNACTIVATED, '挑战未激活（当前令牌尚未声明）');
  assert.equal(R.STATE_MISSING, '状态缺失或损坏');
  assert.equal(R.OTHER_SESSION, '租约属其他会话');
  assert.ok(String(R.NO_CHALLENGE).startsWith('无有效挑战'), '无挑战短语');
  assert.ok(String(R.PROJECT_MISMATCH).startsWith('挑战与本项目不匹配'), '项目不匹配短语');
  assert.ok(String(R.DANGLING_POINTER).startsWith('指针悬空'), '指针悬空短语');
  assert.ok(Object.isFrozen(R), '常量对象冻结（防运行期改写）');
  const env = freshEnv();
  try {
    const r = activateLease('/proj/rs', { leaseId: '0'.repeat(32), taskId: '内部任务-41', skill: 'tdd' });
    assert.ok(String(r.reason).startsWith(R.NO_CHALLENGE), 'activateLease 拒因起始＝常量（库内引用）');
    const r2 = activateLease('/proj/rs', { leaseId: 'bogus', taskId: '内部任务-41', skill: 'tdd' });
    assert.ok(String(r2.reason).includes('leaseId 非法'), '形态拒因不受影响');
  } finally {
    env.restore();
  }
});

// ── 内部任务-8 收尾三维评审（实例 2）处置用例：并集兜底单测判别力 + legacy v2 心跳 ──

test('内部任务-8 门禁实例2：并集守卫的 active 兜底须有单测判别力（删兜底即红）', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/union';
    // 夹具：声明建立 claim+active，然后**只删 claim**——留下「有效 active 无 claim」的持有者
    const chHold = issueChallenge(key, { sessionId: 'sess-HOLD' });
    assert.equal(activateLease(key, { leaseId: chHold.leaseId, taskId: '内部任务-81', skill: 'tdd' }).ok, true);
    rmSync(claimPath(stateDir, key, '内部任务-81'), { force: true });
    assert.ok(existsSync(activePath(stateDir, chHold.leaseId)), '夹具成立：有效 active 在、claim 已删');
    const chNew = issueChallenge(key, { sessionId: 'sess-NEW' });
    const r = activateLease(key, { leaseId: chNew.leaseId, taskId: '内部任务-81', skill: 'tdd' });
    assert.equal(r.ok, false, '异会话同号：无 claim 的有效 active 持有者也须被守卫看见（并集兜底）');
    assert.ok(String(r.reason).includes('撞号阻断'), '撞号拒因');
    assert.equal(existsSync(activePath(stateDir, chNew.leaseId)), false, '阻断即不落盘（无双持）');
    // 负向：异 taskId 不受兜底影响（过滤键仍为 projectKey+taskId）
    const chOther = issueChallenge(key, { sessionId: 'sess-NEW' });
    assert.equal(
      activateLease(key, { leaseId: chOther.leaseId, taskId: '内部任务-82', skill: 'tdd' }).ok,
      true,
      '异 taskId 不受兜底影响',
    );
    // 负向：同会话同号仍幂等放行（兜底不误伤自有占用）
    const chSelf = issueChallenge(key, { sessionId: 'sess-HOLD' });
    assert.equal(
      activateLease(key, { leaseId: chSelf.leaseId, taskId: '内部任务-81', skill: 'tdd' }).ok,
      true,
      '同会话不阻断（兜底与 claim 主源同判等口径）',
    );
  } finally {
    env.restore();
  }
});

test('内部任务-8 门禁实例2：legacy v2 租约（无 schemaVersion、按键索引）心跳须续期', () => {
  const env = freshEnv();
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  try {
    const key = '/proj/legacy-hb';
    mkdirSync(stateDir, { recursive: true });
    // legacy active 形态：文件名按键 digest（无 token 索引）+ 无 schemaVersion
    const legacyId = digest(key);
    const now = Date.now();
    const near = now + 60 * 1000; // 临近过期（剩余 < 2/3 TTL → 满足续期判据）
    const legacyPath = join(stateDir, `wf-lease-active-${legacyId}.json`);
    // legacy 形态须**挑战 + 激活两件同形**（键索引、无 schemaVersion）：读侧 legacy 三级回退的第一跳
    writeFileSync(
      join(stateDir, `wf-lease-challenge-${legacyId}.json`),
      JSON.stringify({ leaseId: legacyId, projectKey: key, promptEpoch: 1, issuedAt: now - 20000, expiresAt: near + 60000 }),
    );
    writeFileSync(
      legacyPath,
      JSON.stringify({ leaseId: legacyId, projectKey: key, sessionId: 'sess-L', taskId: '内部任务-83', skill: 'tdd', issuedAt: now - 11000, declaredAt: now - 10000, expiresAt: near }),
    );
    const read = readActiveLease(key, Date.now(), { sessionId: 'sess-L' });
    assert.equal(read.valid, true, 'legacy 租约读侧有效');
    assert.equal(leaseLib.heartbeatLease(read.lease), true, 'legacy 形态亦须续期（token 索引未命中回落按键索引）');
    const after = JSON.parse(readFileSync(legacyPath, 'utf8')).expiresAt;
    assert.ok(after > near, `legacy expiresAt 须顺延（前 ${near} → 后 ${after}）`);
    assert.equal(leaseLib.heartbeatLease(read.lease), false, '顺延后立即再调被盘上节流跳过');
  } finally {
    env.restore();
  }
});

// ── 内部任务-27（2026-10-09）：FIX-2 异象①——读面三态分层/激活重试/读侧取证（坑1+2+3）──

test('内部任务-27 坑1：挑战文件损坏 → verifyChallengeOnDisk 返 corrupt（与 missing 分态）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/dev27');
    const st = process.env.WF_ROUTING_STATE_DIR;
    writeFileSync(challengePath(st, ch.leaseId), '\x00\x01garbage-not-json{{{');
    assert.equal(leaseLib.verifyChallengeOnDisk(ch.leaseId, Date.now(), '/proj/dev27').reason, 'corrupt');
    // 文件不存在仍是 missing（三态不误伤既有语义）
    assert.equal(leaseLib.verifyChallengeOnDisk('f'.repeat(32), Date.now(), '/proj/dev27').reason, 'missing');
  } finally {
    env.restore();
  }
});

test('内部任务-27 坑1+2：挑战文件损坏 → activateLease 重试后仍拒，拒因按态分化（损坏不可解析）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/dev27');
    writeFileSync(challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'garbage-not-json');
    const act = activateLease('/proj/dev27', { leaseId: ch.leaseId, taskId: '内部任务-7', skill: 'plan-execution' });
    assert.equal(act.ok, false);
    assert.match(act.reason, /挑战文件损坏不可解析/);
    assert.match(act.reason, /再发一条消息重新签发/);
    // absent 态拒因按 内部任务-41 二分改判「不在签发记录」（never-issued 形态，行为显式变更）
    const miss = activateLease('/proj/dev27', { leaseId: 'e'.repeat(32), taskId: '内部任务-7', skill: 'plan-execution' });
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /不在本仓签发记录中/);
    assert.doesNotMatch(miss.reason, /损坏不可解析/);
  } finally {
    env.restore();
  }
});

test('内部任务-27 坑3：损坏挑战激活失败 + 指针健在挑战损坏 → 各落 lease-read-anomaly（digest 脱敏、含 stateRootDigest/envDigest）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/dev27');
    writeFileSync(challengePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'garbage-not-json');
    activateLease('/proj/dev27', { leaseId: ch.leaseId, taskId: '内部任务-7', skill: 'plan-execution' });
    const ch2 = issueChallenge('/proj/dev27', { sessionId: 'sess-d27' });
    writeFileSync(challengePath(process.env.WF_ROUTING_STATE_DIR, ch2.leaseId), 'garbage-not-json');
    const cur = readActiveLease('/proj/dev27', Date.now(), { sessionId: 'sess-d27' });
    assert.equal(cur.valid, false);
    assert.match(cur.reason, /挑战文件损坏/);
    const lines = readFileSync(join(process.env.WF_INCIDENT_ROOT, '.workflow', 'incidents.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recs = lines.filter((d) => d.kind === 'lease-read-anomaly');
    assert.ok(recs.length >= 2, '激活失败与 DANGLING 两现场各至少一条');
    // 内部模块-15 v2（内部决策-063 修正案 3 决策 23.2，内部任务-195）：租约族写者必须带 classifyFact 产出的
    // 分类字段——r-lease-trace 命中（kind=lease-read-anomaly）⇒ mechanism-trace/info。
    const rules = loadRules();
    const traceRule = rules.rules.find((r) => r.id === 'r-lease-trace');
    for (const rec of recs) {
      assert.equal(rec.plugin, 'workflow');
      assert.equal(rec.state, 'corrupt', '本用例两现场均为 corrupt 态');
      assert.equal(typeof rec.stateRootDigest, 'string');
      assert.equal(typeof rec.envDigest, 'string');
      assert.equal(JSON.stringify(rec).includes('/proj/dev27'), false, '脱敏纪律：不得含键明文');
      assert.equal(rec.cause, 'mechanism-trace', '租约族分类 cause 取规则表（r-lease-trace）');
      assert.equal(rec.severity, 'info', 'severity 取规则表');
      assert.equal(rec.ruleId, traceRule.id, 'ruleId 与规则表一致（禁内联常量）');
      assert.equal(rec.rulesVersion, rules.rulesVersion, 'rulesVersion 与规则表一致');
      assert.equal(rec.observationSource, 'hook:task-lease', '写者观测来源可追溯');
    }
  } finally {
    env.restore();
  }
});

test('内部任务-27 坑3：absent-at-activate 落 state=absent 留痕，active 文件损坏落 fileKind=lease 留痕', () => {
  const env = freshEnv();
  try {
    activateLease('/proj/dev27', { leaseId: 'a'.repeat(32), taskId: '内部任务-7', skill: 'plan-execution' });
    const ch = issueChallenge('/proj/dev27', { sessionId: 'sess-d27' });
    assert.equal(activateLease('/proj/dev27', { leaseId: ch.leaseId, taskId: '内部任务-8', skill: 'plan-execution' }).ok, true);
    writeFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'garbage-not-json');
    const cur = readActiveLease('/proj/dev27', Date.now(), { sessionId: 'sess-d27' });
    assert.equal(cur.valid, false);
    assert.match(cur.reason, /状态缺失或损坏/);
    const lines = readFileSync(join(process.env.WF_INCIDENT_ROOT, '.workflow', 'incidents.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const absent = lines.find((d) => d.kind === 'lease-read-anomaly' && d.state === 'absent');
    assert.ok(absent, 'absent-at-activate 应有留痕');
    assert.ok(lines.some((d) => d.kind === 'lease-read-anomaly' && d.fileKind === 'lease'), 'active 损坏应有 lease 族留痕');
  } finally {
    env.restore();
  }
});

test('内部任务-27 坑3：声明成功后 open 的 lease-read-anomaly 批量 resolved（自愈，lease-loop 仍排除）', () => {
  const env = freshEnv();
  let projRoot = '';
  try {
    // 预置一条 open 的读侧异常留痕（同 appendIncident 行格式）
    const ir = join(env.home, 'ir', '.workflow');
    mkdirSync(ir, { recursive: true });
    writeFileSync(join(ir, 'incidents.jsonl'), JSON.stringify({
      schemaVersion: 1, id: 'lra-preset-d27', ts: Date.now(), session: null, taskId: null,
      skill: null, plugin: 'workflow', kind: 'lease-read-anomaly', host: 'unknown',
      tool: null, event: null, fileKind: 'challenge', state: 'corrupt',
      digest: 'd27preset', stateRootDigest: 'x', envDigest: 'y', status: 'open',
    }) + '\n');
    // 真实临时目录作声明键（阶段复审正确性发现 1：字面 /proj 路径依赖测试间泄漏副作用才存在）
    projRoot = mkdtempSync(join(tmpdir(), 'wf-d27-proj-'));
    const ch = issueChallenge(projectKey(projRoot));
    const r = spawnSync(process.execPath, [
      DECLARE, 'brainstorming', '--lease', ch.leaseId, '--task-id', '内部任务-27', '--project-root', projRoot,
    ], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(join(ir, 'incidents.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = lines.filter((d) => d.id === 'lra-preset-d27').at(-1);
    assert.equal(last.status, 'resolved', '声明成功应自愈读侧异常留痕');
    assert.match(last.note, /声明自愈/);
  } finally {
    if (projRoot) rmSync(projRoot, { recursive: true, force: true });
    env.restore();
  }
});

// ── 内部任务-27 批二（2026-10-09）：FIX-2 异象②——取号口径/发号台账/域描述/建议号内联（坑4-7）──

test('内部任务-27 坑5（内部任务-117 稠密改写）：claim 源独钉——active/台账清面后未过期占用仍在集', () => {
  const env = freshEnv();
  const proj = mkdtempSync(join(tmpdir(), 'wf-d27-claim-'));
  try {
    const key = projectKey(proj);
    // git 源占 {1,2,4}：claim 3 必须填住最小空位，建议 5 才能证明 claim 计入（无 claim 则建议 3）
    for (const n of ['内部任务-1', '内部任务-2', '内部任务-4']) mkdirSync(join(proj, '.sdd', 'receipts', n), { recursive: true });
    const ch = issueChallenge(key, { sessionId: 'sess-d5' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-3', skill: 'tdd' }).ok, true);
    // claim+active+台账三写后清 active 与台账（claim 为 内部任务-3 号位唯一供给源——删 claim 前缀
    // 过滤即红，坑5 判别力独钉）
    rmSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), { force: true });
    rmSync(join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${digest(key)}.jsonl`), { force: true });
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.equal(sug.suggestions[0].taskId, '内部任务-5', 'claim 源生效：未过期占用填位，建议越过 3');
    // 异域 claim（含其后台账重建）不影响本域
    const ch2 = issueChallenge(key, { sessionId: 'sess-d5b' });
    assert.equal(activateLease(key, { leaseId: ch2.leaseId, taskId: 'OPS-3', skill: 'tdd' }).ok, true);
    const sug2 = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug2.suggestions[0].taskId, '内部任务-5', '异域 claim/台账不计入本域');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    env.restore();
  }
});

test('内部任务-27 坑6（内部任务-117 改判）：台账仍写但退占用集——claim/active 全清后号回池，审计轨迹保留', () => {
  const env = freshEnv();
  const proj = mkdtempSync(join(tmpdir(), 'wf-d27-issued-'));
  try {
    const key = projectKey(proj);
    const ch = issueChallenge(key, { sessionId: 'sess-d6' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok, true);
    const ledger = join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${digest(key)}.jsonl`);
    assert.ok(existsSync(ledger), '激活成功即写台账（挂状态根，随注入缝隔离——审计轨迹，内部任务-117 起不入占用集）');
    const first = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(first[0].taskId, '内部任务-1');
    assert.equal(first[0].schemaVersion, 1);
    // 模拟弃任务（claim/active 过期清扫后）：台账独存时号回池（旧「台账兜底占号」语义废止）。
    // 内部决策-050（内部任务-62）：声明同时落了 claims/ 占位——弃任务回收须连占位一并清（未推送
    // 占位随 sweep 回收），只清 claim/active 不足以回池（占位接管占用正是新语义）。
    for (const name of readdirSync(process.env.WF_ROUTING_STATE_DIR)) {
      if (name.startsWith('wf-lease-claim-') || name.startsWith('wf-lease-active-')) {
        rmSync(join(process.env.WF_ROUTING_STATE_DIR, name), { force: true });
      }
    }
    rmSync(join(proj, 'docs', 'plans', 'claims'), { recursive: true, force: true });
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.equal(sug.suggestions[0].taskId, '内部任务-1', '内部任务-117：台账不入占用集——弃号回池（稠密从 1 起）');
    assert.ok(existsSync(ledger), '台账文件保留（审计轨迹不删）');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    env.restore();
  }
});

test('内部任务-27 坑7：repoDomainDescriptions 三态 + suggestions 携带描述', () => {
  const env = freshEnv();
  const proj = mkdtempSync(join(tmpdir(), 'wf-d27-dom-'));
  try {
    const key = projectKey(proj);
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({
      schemaVersion: 1, domains: ['DEV'],
      descriptions: { DEV: '核心开发：插件仓自身功能批次' },
    }));
    assert.deepEqual(leaseLib.repoDomainDescriptions(key), { DEV: '核心开发：插件仓自身功能批次' });
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.suggestions[0].description, '核心开发：插件仓自身功能批次');
    // 超长描述整体忽略（fail-open）
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({
      schemaVersion: 1, domains: ['DEV'], descriptions: { DEV: 'x'.repeat(121) },
    }));
    assert.deepEqual(leaseLib.repoDomainDescriptions(key), {}, '超长描述整体忽略');
    // 无 descriptions 字段 → 空对象；建议号不受影响
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    assert.deepEqual(leaseLib.repoDomainDescriptions(key), {});
    const sug2 = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug2.ok, true);
    assert.equal(sug2.suggestions[0].description, undefined);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    env.restore();
  }
});

test('内部任务-27 坑4：soleTaskIdSuggestion——恰一条建议返回该号，零域/多域返回 null', () => {
  const env = freshEnv();
  const proj = mkdtempSync(join(tmpdir(), 'wf-d27-sole-'));
  try {
    const key = projectKey(proj);
    assert.equal(leaseLib.soleTaskIdSuggestion(key), '内部任务-1', '零域仓默认域兜底后内联 内部任务-1（内部任务-75，旧「返 null」形态废止）');
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV'] }));
    assert.equal(leaseLib.soleTaskIdSuggestion(key), '内部任务-1', '单域仓返回可照抄号（空态取 1）');
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV', 'OPS'] }));
    assert.equal(leaseLib.soleTaskIdSuggestion(key), null, '多域仓取号须人工判域——不内联');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    env.restore();
  }
});

test('内部任务-31：readDomainRequests host 过滤对 unknown/缺失侧宽容，双侧已知且不同仍过滤', () => {
  const env = freshEnv();
  try {
    const key = '/proj/dom';
    const now = Date.now();
    const mk = (id, host) => {
      const rec = { id, targetKey: '/proj/target', targetRoot: '/proj/target', sessionId: 'sess-1', ts: now };
      if (host !== undefined) rec.host = host;
      return rec;
    };
    const file = join(process.env.WF_ROUTING_STATE_DIR, 'wf-domain-requests.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [
      JSON.stringify(mk('r-unk', 'unknown')),
      JSON.stringify(mk('r-miss', undefined)),
      JSON.stringify(mk('r-kimi', 'kimi')),
    ].join('\n') + '\n');
    const ids = (arr) => arr.map((r) => r.id).sort();
    // 读侧已知 zcode：unknown/缺失记录宽容返回（内部任务-30 缺陷的直接锁定），已知 kimi≠zcode 过滤
    assert.deepEqual(
      ids(readDomainRequests(key, { now, host: 'zcode' })),
      ['r-miss', 'r-unk'],
      'unknown/缺失侧不可比不丢弃；双侧已知且不同仍过滤',
    );
    // 读侧 unknown（探测不可判定）：对称宽容，不因自身不可判定筛掉已知记录
    assert.deepEqual(
      ids(readDomainRequests(key, { now, host: 'unknown' })),
      ['r-kimi', 'r-miss', 'r-unk'],
      '读侧 unknown 视为不可比，全宽容',
    );
    // 读侧已知 kimi：r-kimi 匹配返回；unknown/缺失记录仍宽容返回（对齐 sessionMatches 模式）
    assert.deepEqual(
      ids(readDomainRequests(key, { now, host: 'kimi' })),
      ['r-kimi', 'r-miss', 'r-unk'],
      '缺失/unknown 侧在任一读侧形态下均不被 host 过滤丢弃',
    );
    // host=null（不过滤，既有语义）对照；读侧空串视同未设置（评审处置 1：与 rec 侧同式归一）
    assert.deepEqual(
      ids(readDomainRequests(key, { now })),
      ['r-kimi', 'r-miss', 'r-unk'],
      'host=null 全量返回（既有语义不变）',
    );
    assert.deepEqual(
      ids(readDomainRequests(key, { now, host: '' })),
      ['r-kimi', 'r-miss', 'r-unk'],
      '读侧空串视同未设置、不得反转为「滤掉全部已知宿主」（内部任务-31 评审处置）',
    );
  } finally {
    env.restore();
  }
});

// ── 内部任务-41（2026-10-11，FIX-3 承接）：签发台账 + absent 拒因二分（轮内自纠面）──

test('内部任务-41 签发台账逐签发记录 leaseId/sessionId/root（append-only）', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/dev41', { sessionId: 'sess-a' });
    const ledger = join(process.env.WF_ROUTING_STATE_DIR, `wf-challenges-${digest('/proj/dev41')}.jsonl`);
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    assert.equal(last.leaseId, ch.leaseId);
    assert.equal(last.sessionId, 'sess-a');
    assert.equal(last.root, process.env.WF_ROUTING_STATE_DIR);
    assert.ok(Number(last.expiresAt) > Date.now());
  } finally {
    env.restore();
  }
});

test('内部任务-41 旧轮令牌（轮间隔>TTL 被清扫）拒因含「已失效的旧轮令牌」与在位挑战短令牌', async () => {
  const env = freshEnv();
  try {
    process.env.WF_ROUTING_TTL_MS = '80';
    const r1 = issueChallenge('/proj/dev41', { sessionId: 'sess-a' });
    await new Promise((r) => setTimeout(r, 150));
    // TTL 恢复须在 r2 签发前：r1 的过期时刻已按 80ms 钉死（清扫语义不变），
    // r2 取 5s 存活期防断言前过期（阶段复审意见 1 处置）
    process.env.WF_ROUTING_TTL_MS = '5000';
    const r2 = issueChallenge('/proj/dev41', { sessionId: 'sess-a' });
    const act = activateLease('/proj/dev41', { leaseId: r1.leaseId, taskId: '内部任务-41', skill: 'tdd' });
    assert.equal(act.ok, false);
    assert.ok(String(act.reason).startsWith('无有效挑战'), `拒因前缀保持 NO_CHALLENGE：${act.reason}`);
    assert.ok(String(act.reason).includes('已失效的旧轮令牌'));
    assert.ok(String(act.reason).includes(`当前在位挑战 ${r2.leaseId.slice(0, 8)}`));
    assert.ok(String(act.reason).includes('最新一轮【workflow 任务租约】行'));
  } finally {
    delete process.env.WF_ROUTING_TTL_MS;
    env.restore();
  }
});

test('内部任务-41 从未签发令牌（合法 hex）拒因含「不在本仓签发记录中」', () => {
  const env = freshEnv();
  try {
    const act = activateLease('/proj/dev41', { leaseId: 'a'.repeat(32), taskId: '内部任务-41', skill: 'tdd' });
    assert.equal(act.ok, false);
    assert.ok(String(act.reason).includes('不在本仓签发记录中'));
    assert.ok(String(act.reason).includes('誊抄失真'));
  } finally {
    env.restore();
  }
});

test('内部任务-41 findChallengeIssuance 台账命中/未命中两态', () => {
  const env = freshEnv();
  try {
    const ch = issueChallenge('/proj/dev41', { sessionId: 'sess-a' });
    assert.equal(findChallengeIssuance('/proj/dev41', ch.leaseId)?.leaseId, ch.leaseId);
    assert.equal(findChallengeIssuance('/proj/dev41', 'b'.repeat(32)), null);
  } finally {
    env.restore();
  }
});

test('内部未决-111：序号值域——0 与前导零不受理，正常号与 TASK 重叠变体不受影响', () => {
  // 非存在键 ⇒ repoDomains 为 null ⇒ form-only（域成员层不介入，纯值域面）
  const key = '/proj/open111';
  assert.ok(leaseLib.taskidRejection('内部任务-0', key), '0 不受理');
  assert.ok(leaseLib.taskidRejection('内部任务-01', key), '前导零不受理');
  assert.ok(leaseLib.taskidRejection('内部任务-0', key), '旧系重叠变体的 0 同拒');
  assert.equal(leaseLib.taskidRejection('内部任务-1', key), null, '正常号受理');
  assert.equal(leaseLib.taskidRejection('内部任务-10', key), null, '两位号受理');
  assert.equal(leaseLib.taskidRejection('内部任务-12', key), null, '重叠变体合法值受理（selftest 同口径）');
});

test('内部未决-103：建议号排除观察会话自身占用——claim/active/台账三面同排、他会不排', () => {
  const env = freshEnv();
  try {
    // git 源占 {1,2}——A/B 各填一个低位空位，三态断言才有稠密判别力（内部任务-117）
    const open103Root = mkdtempSync(join(tmpdir(), 'wf-open103-'));
    const key = projectKey(open103Root);
    mkdirSync(join(open103Root, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    mkdirSync(join(open103Root, '.sdd', 'receipts', '内部任务-2'), { recursive: true });
    // 会话 A 占 内部任务-3（claim+active+发号台账三面经 activateLease 生产写入口落盘）
    const chA = issueChallenge(key, { sessionId: 'sess-A' });
    assert.equal(activateLease(key, { leaseId: chA.leaseId, taskId: '内部任务-3', skill: 'tdd' }).ok, true);
    // 会话 B 占 内部任务-4（对照：排除 A 时仍须计入）
    const chB = issueChallenge(key, { sessionId: 'sess-B' });
    assert.equal(activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-4', skill: 'tdd' }).ok, true);
    // 机器级口径（直调）：占用集 {1,2,3,4} ⇒ 建议 内部任务-5
    assert.equal(leaseLib.suggestedTaskId(key, { domain: 'DEV' }).suggestions[0].taskId, '内部任务-5');
    // 排除 A：A 三面不计 ⇒ {1,2,4} ⇒ 内部任务-3（A 的 3 回池）
    assert.equal(
      leaseLib.suggestedTaskId(key, { domain: 'DEV', excludeSessionId: 'sess-A' }).suggestions[0].taskId,
      '内部任务-3',
    );
    // 排除 B：{1,2,3} ⇒ 内部任务-4（B 的 4 回池、A 仍占 3）
    assert.equal(
      leaseLib.suggestedTaskId(key, { domain: 'DEV', excludeSessionId: 'sess-B' }).suggestions[0].taskId,
      '内部任务-4',
    );
    rmSync(open103Root, { recursive: true, force: true });
  } finally {
    env.restore();
  }
});

test('内部未决-103：单观察会话自持形态——排除自身后建议回到空态取号（照抄即延续同号）', () => {
  // 机器级扫描跨键计数是设计语义（不判 projectKey）——同状态根下他会占用照计，
  // 故本形态须用独立干净状态根验证「排除自身 ⇒ 自持号不再顶高建议」。
  const env = freshEnv();
  try {
    const key2Root = mkdtempSync(join(tmpdir(), 'wf-open103b-'));
    const key2 = projectKey(key2Root);
    mkdirSync(join(key2Root, '.sdd', 'receipts', '内部任务-1'), { recursive: true });
    const ch2 = issueChallenge(key2, { sessionId: 'sess-A' });
    assert.equal(activateLease(key2, { leaseId: ch2.leaseId, taskId: '内部任务-2', skill: 'tdd' }).ok, true);
    assert.equal(
      leaseLib.suggestedTaskId(key2, { domain: 'DEV', excludeSessionId: 'sess-A' }).suggestions[0].taskId,
      '内部任务-2',
    );
    assert.equal(leaseLib.suggestedTaskId(key2, { domain: 'DEV' }).suggestions[0].taskId, '内部任务-3');
    rmSync(key2Root, { recursive: true, force: true });
  } finally {
    env.restore();
  }
});

// 内部任务-75/IMP-4（内部规则-8 零域默认域兜底）：无域声明且无可推断域的仓回落内置默认域集
// ['DEV']——恰单域保 soleTaskIdSuggestion 内联建议开箱可用（免手工建域文件/显式
// --domain 前置）；显式域与配置仓行为不变。
test('suggestedTaskId 零域态回落默认域 DEV（空态 内部任务-1，usedDefaultDomains 标记）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-default-domain-'));
  try {
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    const sug = leaseLib.suggestedTaskId(key);
    assert.equal(sug.ok, true, '零域态不再拒——默认域兜底（内部任务-75）');
    assert.equal(sug.usedDefaultDomains, true, '默认域生效标记（查询面附注消费）');
    assert.deepEqual(sug.suggestions.map((s) => s.taskId), ['内部任务-1'], '恰单域空态取 1');
    assert.equal(leaseLib.soleTaskIdSuggestion(key), '内部任务-1', '零域仓内联建议开箱可用');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('suggestedTaskId 显式域零配置仓不受默认域影响（FIX-1，无标记）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-default-domain-x-'));
  try {
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const sug = leaseLib.suggestedTaskId(projectKey(proj), { domain: 'fix' });
    assert.equal(sug.ok, true);
    assert.equal(sug.usedDefaultDomains, undefined, '显式域分支不落默认域标记');
    assert.deepEqual(sug.suggestions.map((s) => s.taskId), ['FIX-1'], '小写显式域归一大写建议');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('suggestedTaskId 配置仓不落默认域标记（domains.json 在场维持原语义）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-default-domain-cfg-'));
  try {
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['OPS'] }));
    const sug = leaseLib.suggestedTaskId(projectKey(proj));
    assert.equal(sug.ok, true);
    assert.equal(sug.usedDefaultDomains, undefined, '配置仓不走默认域兜底');
    assert.deepEqual(sug.suggestions.map((s) => s.taskId), ['OPS-1']);
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

// ============ 内部决策-045/内部任务-96：任务号命名空间隔离（三段形态/注册表/按键过滤/建议号） ============

test('内部决策-045 三段形态校验四层：注册表内受理/外拒/无注册表拒/二段存量兼容', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-form-'));
  try {
    const projA = join(home, 'a');
    mkdirSync(join(projA, '.git'), { recursive: true });
    mkdirSync(join(projA, '.workflow'), { recursive: true });
    writeFileSync(join(projA, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP', 'AL'] }));
    const keyA = projectKey(projA);
    assert.equal(leaseLib.taskidRejection('内部任务-WP-1', keyA), null, '注册表内维护者码受理');
    assert.match(String(leaseLib.taskidRejection('内部任务-XX-1', keyA)), /不在本仓注册表/, '注册表外维护者码拒');
    assert.equal(leaseLib.taskidRejection('内部任务-1', keyA), null, '二段默认命名空间存量兼容');
    const projB = join(home, 'b');
    mkdirSync(join(projB, '.git'), { recursive: true });
    const keyB = projectKey(projB);
    assert.match(String(leaseLib.taskidRejection('内部任务-WP-1', keyB)), /维护者命名空间未注册/, '无注册表三段拒');
    assert.equal(leaseLib.taskidRejection('内部任务-1', keyB), null, '无注册表二段受理');
    assert.match(String(leaseLib.taskidRejection('DEV-wp-1', keyA)), /非法/, '维护者码小写形态拒');
    assert.match(String(leaseLib.taskidRejection('内部任务-WP-01', keyA)), /序号非法/, '三段号前导零序号拒（值域层）');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 取号按键过滤：同状态根异项目互不顶号', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-keyfilter-'));
  try {
    const projA = join(home, 'a');
    const projB = join(home, 'b');
    mkdirSync(join(projA, '.git'), { recursive: true });
    mkdirSync(join(projB, '.git'), { recursive: true });
    const keyA = projectKey(projA);
    const keyB = projectKey(projB);
    const ch = issueChallenge(keyA, { sessionId: 'sess-a' });
    assert.ok(activateLease(keyA, { leaseId: ch.leaseId, taskId: '内部任务-1', skill: 'tdd' }).ok);
    const sugB = leaseLib.suggestedTaskId(keyB, { domain: 'DEV' });
    assert.equal(sugB.suggestions[0].taskId, '内部任务-1', '同状态根异项目序号空间隔离（B 键空态稠密取 1，A 键占用不可见）');
    const sugA = leaseLib.suggestedTaskId(keyA, { domain: 'DEV' });
    assert.equal(sugA.suggestions[0].taskId, '内部任务-2', '本键占用照常计入（稠密越过 1）');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 取号按维护者分段：同域异维护者序号独立＋二段默认隔离', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-mseg-'));
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP', 'AL'] }));
    mkdirSync(join(proj, '.sdd', 'receipts', '内部任务-WP-1'), { recursive: true });
    mkdirSync(join(proj, '.sdd', 'receipts', '内部任务-WP-2'), { recursive: true });
    mkdirSync(join(proj, '.sdd', 'receipts', '内部任务-9'), { recursive: true });
    const key = projectKey(proj);
    assert.equal(leaseLib.suggestedTaskId(key, { domain: 'DEV', maintainer: 'WP' }).suggestions[0].taskId, '内部任务-WP-3', 'WP 段稠密（{1,2}→3，段内独立）');
    assert.equal(leaseLib.suggestedTaskId(key, { domain: 'DEV', maintainer: 'AL' }).suggestions[0].taskId, '内部任务-AL-1', 'AL 段空态取 1');
    assert.equal(leaseLib.suggestedTaskId(key, { domain: 'DEV', maintainer: null }).suggestions[0].taskId, '内部任务-1', '二段默认命名空间稠密（三段不入）');
    assert.equal(leaseLib.suggestedTaskId(key, { domain: 'DEV' }).suggestions[0].taskId, '内部任务-1', '指针缺席时直调回落二段默认命名空间（注册表在场⇒指针缺席=null 显式二段——本段 {9}→稠密 1，内部决策-045 解析语义；旧注释「全计不过滤」系误述随批更正）');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 建议号成员校验：显式码不在注册表/注册表缺席带参/指针被除名三态均 ok:false', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-member-'));
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    writeFileSync(join(proj, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'XX' }));
    const key = projectKey(proj);
    const r1 = leaseLib.suggestedTaskId(key, { domain: 'DEV', maintainer: 'QQ' });
    assert.ok(!r1.ok && /不在本仓注册表/.test(r1.hint), '显式码不在注册表拒');
    const proj2 = join(home, 'q');
    mkdirSync(join(proj2, '.git'), { recursive: true });
    const r2 = leaseLib.suggestedTaskId(projectKey(proj2), { domain: 'DEV', maintainer: 'WP' });
    assert.ok(!r2.ok && /无维护者注册表/.test(r2.hint), '注册表缺席显式带参拒');
    const r3 = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(!r3.ok && /XX 不在本仓注册表/.test(r3.hint), '指针码被注册表除名拒＋修正指引');
    writeFileSync(join(proj, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'WP' }));
    const r4 = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(r4.ok && r4.suggestions[0].taskId === '内部任务-WP-1', '本地指针上下文建议三段号');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 soleTaskIdSuggestion 内联条件：建议号 ≤11 字符（超长回退 null 占位符）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-inline-'));
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    mkdirSync(join(proj, '.workflow'), { recursive: true });
    writeFileSync(join(proj, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    writeFileSync(join(proj, '.workflow', 'maintainer.local.json'), JSON.stringify({ code: 'WP' }));
    const key = projectKey(proj);
    assert.equal(leaseLib.soleTaskIdSuggestion(key, { domain: 'DEV' }), '内部任务-WP-1', '三段 7 字符 ≤11 仍内联');
    // 稠密下超长回退用 4+4 段形态构造：域 DEVX × 维护者 WPXY × 占 {1..11} → 建议 DEVX-WPXY-12（12 字符 >11）
    writeFileSync(join(proj, '.workflow', 'domains.json'), JSON.stringify({ schemaVersion: 1, domains: ['DEV', 'DEVX'] }));
    writeFileSync(join(proj, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP', 'WPXY'] }));
    for (let i = 1; i <= 11; i += 1) mkdirSync(join(proj, '.sdd', 'receipts', `DEVX-WPXY-${i}`), { recursive: true });
    assert.equal(leaseLib.soleTaskIdSuggestion(key, { domain: 'DEVX', maintainer: 'WPXY' }), null, '超 11 字符回退 null（内部任务-117 稠密形态：DEVX-WPXY-12 为 12 字符）');
    const proj2 = join(home, 'q');
    mkdirSync(join(proj2, '.git'), { recursive: true });
    assert.equal(leaseLib.soleTaskIdSuggestion(projectKey(proj2), { domain: 'DEV' }), '内部任务-1', '二段 ≤11 内联');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

// ============ 内部决策-045/内部任务-96：TTL 活动观测（reviveOrHeartbeat 四态） ============

test('内部决策-045 活动观测四态：心跳顺延/宽限复活＋留痕/他会话重持有不复/超宽限与异会话不复', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-revive-'));
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    // ① 有效租约心跳（夹具 expiresAt 压到 now+TTL/6——满剩余会被节流跳写盘，先例 :1356）
    const ch1 = issueChallenge(key, { sessionId: 'sess-a' });
    assert.ok(activateLease(key, { leaseId: ch1.leaseId, taskId: '内部任务-20', skill: 'tdd' }).ok);
    const ttl = leaseLib.DEFAULT_TTL_MS;
    const actFile0 = readdirSync(join(env.home, 'state')).find((n) => n.startsWith('wf-lease-active-'));
    const act0 = JSON.parse(readFileSync(join(env.home, 'state', actFile0), 'utf8'));
    writeFileSync(join(env.home, 'state', actFile0), JSON.stringify({ ...act0, expiresAt: Date.now() + Math.floor(ttl / 6) }));
    const before = leaseLib.readActiveLease(key, Date.now(), { sessionId: 'sess-a' }).lease.expiresAt;
    const r1 = leaseLib.reviveOrHeartbeat(key, 'sess-a');
    assert.equal(r1.action, 'heartbeat');
    const after = leaseLib.readActiveLease(key, Date.now(), { sessionId: 'sess-a' }).lease.expiresAt;
    assert.ok(after > before, '心跳顺延（TTL/6 剩余过节流阈值触发写盘）');
    // ② 过期 ≤1TTL 同会话复活＋incident 留痕（直接改写 active/claim 的 expiresAt 到过去不久）
    const staleTs = Date.now() - Math.floor(ttl / 2); // 过期半 TTL（宽限窗内）
    const actFile = readdirSync(join(env.home, 'state')).find((n) => n.startsWith('wf-lease-active-'));
    const act = JSON.parse(readFileSync(join(env.home, 'state', actFile), 'utf8'));
    writeFileSync(join(env.home, 'state', actFile), JSON.stringify({ ...act, expiresAt: staleTs }));
    const r2 = leaseLib.reviveOrHeartbeat(key, 'sess-a');
    assert.equal(r2.action, 'revived', '宽限窗内同会话复活');
    const incidents = readFileSync(join(env.home, 'ir', '.workflow', 'incidents.jsonl'), 'utf8');
    assert.ok(incidents.includes('lease-revive'), 'incident 留痕 kind=lease-revive');
    assert.ok(incidents.includes('宽限复活'), '留痕含处置语义 note');
    // 内部模块-15 v2（内部决策-063 修正案 3 决策 23.2）：宽限复活行同批携带分类字段（r-lease-trace ⇒ info）
    const reviveRow = incidents
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((d) => d.kind === 'lease-revive');
    assert.ok(reviveRow, 'lease-revive 行可解析');
    assert.equal(reviveRow.cause, 'mechanism-trace');
    assert.equal(reviveRow.severity, 'info');
    assert.equal(reviveRow.ruleId, 'r-lease-trace');
    assert.equal(reviveRow.rulesVersion, loadRules().rulesVersion);
    assert.equal(reviveRow.observationSource, 'hook:task-lease');
    // ③ 守卫：A 租约（active＋claim）双双压过期 → B 同号重声明成功（claim 归 B）→ A 观测不复活
    const ch2 = issueChallenge(key, { sessionId: 'sess-b' });
    const dir = join(env.home, 'state');
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('wf-lease-active-') && !name.startsWith('wf-lease-claim-')) continue;
      const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (body.taskId === '内部任务-20') writeFileSync(join(dir, name), JSON.stringify({ ...body, expiresAt: staleTs }));
    }
    assert.ok(activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-20', skill: 'tdd' }).ok, 'B 同号重声明（设计内延续路径——A 占用过期被清）');
    const r3 = leaseLib.reviveOrHeartbeat(key, 'sess-a');
    assert.equal(r3.action, 'none', '他会话重持有同号 → 不复活（双持并存封堵）');
    // ④ 超宽限：过期 >1TTL → 不复
    const act3 = JSON.parse(readFileSync(join(env.home, 'state', actFile), 'utf8'));
    writeFileSync(join(env.home, 'state', actFile), JSON.stringify({ ...act3, sessionId: 'sess-a', expiresAt: Date.now() - ttl - 60000 }));
    const r4 = leaseLib.reviveOrHeartbeat(key, 'sess-a');
    assert.equal(r4.action, 'none', '超宽限不复');
    // ⑤ 异会话观察：不复（sess-c 观察 A 的过期租约）
    writeFileSync(join(env.home, 'state', actFile), JSON.stringify({ ...act3, sessionId: 'sess-a', expiresAt: Date.now() - 1000 }));
    const r5 = leaseLib.reviveOrHeartbeat(key, 'sess-c');
    assert.equal(r5.action, 'none', '异会话观察不复');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 复活留痕生产落点：不经 WF_INCIDENT_ROOT 缝时落项目根 内部工作流状态（阶段复审正确性维发现 1 防再漏）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-root-'));
  const prevRoot = process.env.WF_INCIDENT_ROOT;
  const prevState = process.env.WF_ROUTING_STATE_DIR;
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    delete process.env.WF_INCIDENT_ROOT; // 关键：解除缝，验证生产落点（项目根）
    process.env.WF_ROUTING_STATE_DIR = join(home, 'state');
    const ch = issueChallenge(key, { sessionId: 'sess-r' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-40', skill: 'tdd' }).ok);
    const actName = readdirSync(join(home, 'state')).find((n) => n.startsWith('wf-lease-active-'));
    const act = JSON.parse(readFileSync(join(home, 'state', actName), 'utf8'));
    writeFileSync(join(home, 'state', actName), JSON.stringify({ ...act, expiresAt: Date.now() - 1000 }));
    const r = leaseLib.reviveOrHeartbeat(key, 'sess-r');
    assert.equal(r.action, 'revived');
    const prod = readFileSync(join(proj, '.workflow', 'incidents.jsonl'), 'utf8');
    assert.ok(prod.includes('lease-revive'), '留痕落项目根（incident-cli/readIncidents 可见）');
    assert.ok(!existsSync(join(home, 'state', '.workflow', 'incidents.jsonl')), '状态根不散落 .workflow 垃圾件');
  } finally {
    if (prevRoot === undefined) delete process.env.WF_INCIDENT_ROOT;
    else process.env.WF_INCIDENT_ROOT = prevRoot;
    if (prevState === undefined) delete process.env.WF_ROUTING_STATE_DIR;
    else process.env.WF_ROUTING_STATE_DIR = prevState;
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部决策-045 守卫判等形态：带前缀会话 id（sess_/session-）观察者照常复活（终审发现 1 防再漏——判等统一原串）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-adr45-pfx-'));
  try {
    const proj = join(home, 'p');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const key = projectKey(proj);
    const ch = issueChallenge(key, { sessionId: 'sess_prefix-a' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-50', skill: 'tdd' }).ok);
    const dir = join(env.home, 'state');
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('wf-lease-active-') && !name.startsWith('wf-lease-claim-')) continue;
      const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (body.taskId === '内部任务-50') writeFileSync(join(dir, name), JSON.stringify({ ...body, expiresAt: Date.now() - 1000 }));
    }
    const r = leaseLib.reviveOrHeartbeat(key, 'sess_prefix-a');
    assert.equal(r.action, 'revived', '带前缀观察者：本会话占用不被归一化误判为他会话——照常宽限复活');
  } finally {
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

// ============ 内部任务-62 / 内部决策-050：取号占位登记（claims/）用例族 ============

/** 构造带 claims 占位文件的临时项目根；marker 覆盖字段用 partial 合并默认体。 */
function claimsProject(markers) {
  const root = mkdtempSync(join(tmpdir(), 'wf-claims-'));
  const dir = join(root, 'docs', 'plans', 'claims');
  mkdirSync(dir, { recursive: true });
  for (const [name, partial] of Object.entries(markers)) {
    writeFileSync(join(dir, name), typeof partial === 'string' ? partial : JSON.stringify({
      schemaVersion: 1, taskId: name.replace(/\.json$/, ''), ts: Date.now(),
      status: 'claimed', expiresAt: Date.now() + 3600_000, ...partial,
    }));
  }
  return root;
}
/** 1..8 有效占位＋内部任务-9 待判定态（partial 覆盖）——最小未用语义下 9 是否回填即判定面。 */
function claimsProjectWith9(partial) {
  const markers = {};
  for (let n = 1; n <= 8; n += 1) markers[`DEV-${n}.json`] = {};
  markers['内部任务-9.json'] = partial;
  return claimsProject(markers);
}
const g = (root, args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...opts });

test('内部任务-62 T1 占位即占用：claims 登记计入占用集（状态根为空仍跳过——跨机可见性等价面）', () => {
  const env = freshEnv();
  const root = claimsProjectWith9({});
  try {
    const sug = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV' });
    assert.ok(sug.ok);
    assert.equal(sug.suggestions[0].taskId, '内部任务-10', '1..9 全占位后最小未用必须越过 9——占位计入占用集');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T2 回池仅未跟踪：过期＋未跟踪回池；git 跟踪后永久占用', { skip: !gitAvailable && 'git 不可用（跟踪判定源缺席）' }, () => {
  const env = freshEnv();
  const root = claimsProjectWith9({ expiresAt: Date.now() - 1000 });
  try {
    const before = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV' });
    assert.equal(before.suggestions[0].taskId, '内部任务-9', '未跟踪＋过期＝回池，最小未用回填 9');
    assert.equal(g(root, ['init', '-q']).status, 0);
    g(root, ['config', 'user.email', 't@t']);
    g(root, ['config', 'user.name', 't']);
    assert.equal(g(root, ['add', '内部取号登记']).status, 0);
    assert.equal(g(root, ['commit', '-q', '-m', '内部任务-9 占位']).status, 0);
    const after = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV' });
    assert.equal(after.suggestions[0].taskId, '内部任务-10', '已跟踪＝跨机可见，不可回池（内部决策-050 D2）');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1c 回池保守（原 内部任务-62 T3）：WF_GIT_BIN 失效时过期占位保守不回池且 degraded', () => {
  const env = freshEnv();
  const root = claimsProjectWith9({ expiresAt: Date.now() - 1000 });
  const prevBin = process.env.WF_GIT_BIN;
  try {
    process.env.WF_GIT_BIN = join(tmpdir(), 'wf-git-不存在-探测桩');
    const occ = leaseLib.occupiedSeqsOfDomain(projectKey(root), 'DEV');
    assert.ok(occ.used.has(9), '探测失败保守按已跟踪＝不回池（内部决策-050 D2 修正；旧「按未跟踪回落」废止）');
    assert.ok(Array.isArray(occ.degraded) && occ.degraded.some((d) => String(d.source ?? d).includes('trackedPaths')), '探测失败须置 degraded 并指名 trackedPaths');
  } finally {
    if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
    env.restore(); rmSync(root, { recursive: true, force: true });
  }
});

test('内部任务-62 T4 released 不占用：显式释放即回收，已跟踪亦然', { skip: !gitAvailable && 'git 不可用' }, () => {
  const env = freshEnv();
  const root = claimsProjectWith9({ status: 'released' });
  try {
    g(root, ['init', '-q']); g(root, ['config', 'user.email', 't@t']); g(root, ['config', 'user.name', 't']);
    g(root, ['add', '.']); g(root, ['commit', '-q', '-m', 'released 占位']);
    const sug = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-9', 'released 一律不计入（让号协议语义）');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T5 段隔离：三段占位只占其维护者段命名空间', () => {
  const env = freshEnv();
  const root = claimsProject({ '内部任务-WP-1.json': {}, '内部任务-WP-2.json': {}, '内部任务-WP-3.json': {} });
  try {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'maintainers.json'), JSON.stringify({ schemaVersion: 1, codes: ['WP'] }));
    const def = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV' });
    assert.equal(def.suggestions[0].taskId, '内部任务-1', '默认二段命名空间不受 WP 段占用影响（段隔离）');
    const wp = leaseLib.suggestedTaskId(projectKey(root), { domain: 'DEV', maintainer: 'WP' });
    assert.equal(wp.suggestions[0].taskId, '内部任务-WP-4', 'WP 段 1..3 全占→段内最小未用越 3');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T6 损坏保守：非法 JSON 占位按 claimed＋永久计入（并记 degraded，内部决策-061 D5.2）', () => {
  const env = freshEnv();
  const markers = {};
  for (let n = 1; n <= 8; n += 1) markers[`DEV-${n}.json`] = {};
  markers['内部任务-9.json'] = '{not-json';
  const root = claimsProject(markers);
  try {
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ.used.has(9), '损坏占位按 claimed＋永久保守计入（不可判定不静默放号）');
    assert.ok(Array.isArray(occ.degraded) && occ.degraded.some((d) => String(d.source ?? d).includes('claimsMarkers')), '损坏占位属读失败须记 degraded');
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, false, '损坏占位使占用集降级——建议面 fail-loud 不出号');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T7 幂等：同号重复 writeClaimMarker 文件仍一份且内容为末次', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-claims-w-'));
  try {
    const key = projectKey(root);
    assert.equal(leaseLib.writeClaimMarker(key, { taskId: '内部任务-77', skill: 'tdd', sessionId: 'sess-a', host: 'zcode' }).ok, true);
    assert.equal(leaseLib.writeClaimMarker(key, { taskId: '内部任务-77', skill: 'plan-execution', sessionId: 'sess-a', host: 'zcode' }).ok, true);
    const files = readdirSync(join(root, 'docs', 'plans', 'claims'));
    assert.equal(files.length, 1);
    const body = JSON.parse(readFileSync(join(root, 'docs', 'plans', 'claims', '内部任务-77.json'), 'utf8'));
    assert.equal(body.skill, 'plan-execution');
    assert.equal(body.status, 'claimed');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T8 released 改写：markClaimReleased 只改 status 保其余字段', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-claims-r-'));
  try {
    const key = projectKey(root);
    leaseLib.writeClaimMarker(key, { taskId: '内部任务-78', skill: 'tdd', sessionId: 'sess-a', host: 'zcode' });
    assert.equal(leaseLib.markClaimReleased(key, '内部任务-78').ok, true);
    const body = JSON.parse(readFileSync(join(root, 'docs', 'plans', 'claims', '内部任务-78.json'), 'utf8'));
    assert.equal(body.status, 'released');
    assert.equal(body.taskId, '内部任务-78');
    assert.equal(typeof body.ts, 'number');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-62 T9 会话排除归一对称：带前缀会话 id 的自持占位仍被排除（照抄即延续同号）', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-claims-t9-'));
  try {
    const key = projectKey(root);
    // 写侧经 writeClaimMarker（归一摘要）＋读侧传同前缀原始 id——两侧归一对称才排除
    assert.equal(leaseLib.writeClaimMarker(key, { taskId: '内部任务-1', skill: 'tdd', sessionId: 'sess_prefixA', host: 'zcode' }).ok, true);
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV', excludeSessionId: 'sess_prefixA' });
    assert.equal(sug.suggestions[0].taskId, '内部任务-1', '本会话自持占位按归一摘要排除（终审交叉命中：写侧原始/读侧归一的不对称缺陷已修）');
    const other = leaseLib.suggestedTaskId(key, { domain: 'DEV', excludeSessionId: 'session-other' });
    assert.notEqual(other.suggestions[0].taskId, '内部任务-1', '他会话视图仍计入该占位');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

// ============ 内部任务-227（内部决策-061）：取号 fail-loud／受理侧历史占用校验／续任务与人工通道 ============

/** 写一个最小 fake git（.mjs）：WF_GIT_BIN 指向它、经 process.execPath 执行（lib 注入缝契约：
 * WF_GIT_BIN 以 .mjs 结尾时 lib 以 node 解释器执行之，便于跨平台测试桩）。 */
function fakeGitScript(home) {
  const p = join(home, 'fake-git.mjs');
  writeFileSync(p, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const env = process.env;",
    "if (env.WF_GIT_FAKE_ENV_FILE) { writeFileSync(env.WF_GIT_FAKE_ENV_FILE, JSON.stringify({ LC_ALL: process.env.LC_ALL, LANG: process.env.LANG })); }",
    "const localeSensitive = env.WF_GIT_FAKE_LOCALE_SENSITIVE === '1';",
    "if (localeSensitive && process.env.LC_ALL !== 'C') { process.stderr.write('fatal: 不是 Git 仓库（或者任何父目录）：.git\\n'); process.exit(128); }",
    "if (env.WF_GIT_FAKE_NOT_REPO === '1') { process.stderr.write('fatal: not a git repository (or any of the parent directories): .git\\n'); process.exit(128); }",
    "if (env.WF_GIT_FAKE_EMPTY_REPO === '1' && args.includes('log')) { process.stderr.write(\"fatal: your current branch 'main' does not have any commits yet\\n\"); process.exit(128); }",
    "if (args.includes('log')) {",
    "  if (env.WF_GIT_FAKE_LOG_FAIL === '1') { process.stderr.write('boom-log\\n'); process.exit(1); }",
    "  const f = env.WF_GIT_FAKE_LOG_FILE; if (f && existsSync(f)) process.stdout.write(readFileSync(f, 'utf8'));",
    "  process.exit(0);",
    "}",
    "if (args.includes('ls-files')) {",
    "  if (env.WF_GIT_FAKE_LS_FAIL === '1') { process.stderr.write('boom-ls\\n'); process.exit(1); }",
    "  const f = env.WF_GIT_FAKE_LS_FILE; if (f && existsSync(f)) process.stdout.write(readFileSync(f, 'utf8'));",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
  ].join('\n'));
  return p;
}

/** 安装 fake git 注入（返回 restore；结束后必须调用）。 */
function withFakeGit(home, opts = {}) {
  const script = fakeGitScript(home);
  const keys = ['WF_GIT_BIN', 'WF_GIT_FAKE_LOG_FILE', 'WF_GIT_FAKE_LS_FILE', 'WF_GIT_FAKE_LOG_FAIL', 'WF_GIT_FAKE_LS_FAIL', 'WF_GIT_FAKE_NOT_REPO', 'WF_GIT_FAKE_EMPTY_REPO', 'WF_GIT_FAKE_LOCALE_SENSITIVE', 'WF_GIT_FAKE_ENV_FILE'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.WF_GIT_BIN = script;
  if (opts.log !== undefined) { const f = join(home, 'fake-log.txt'); writeFileSync(f, opts.log); process.env.WF_GIT_FAKE_LOG_FILE = f; }
  if (opts.lsFiles !== undefined) { const f = join(home, 'fake-ls.txt'); writeFileSync(f, opts.lsFiles); process.env.WF_GIT_FAKE_LS_FILE = f; }
  if (opts.logFail) process.env.WF_GIT_FAKE_LOG_FAIL = '1';
  if (opts.lsFail) process.env.WF_GIT_FAKE_LS_FAIL = '1';
  if (opts.notRepo) process.env.WF_GIT_FAKE_NOT_REPO = '1';
  if (opts.emptyRepo) process.env.WF_GIT_FAKE_EMPTY_REPO = '1';
  if (opts.localeSensitive) process.env.WF_GIT_FAKE_LOCALE_SENSITIVE = '1';
  if (opts.envFile) process.env.WF_GIT_FAKE_ENV_FILE = opts.envFile;
  return {
    restore() {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    },
  };
}

/** 空项目根（无 内部证据——占用面主要由 fake git 提供）。 */
function bareProject() {
  return mkdtempSync(join(tmpdir(), 'wf-dev227-'));
}

/** 写 issued 台账行（stateRoot 下按 keyDigest 命名；本任务新增审计源与继承解析源）。 */
function writeIssuedLedger(home, key, rows) {
  const dir = join(home, 'state');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `wf-issued-${digest(projectKey(key))}.jsonl`);
  writeFileSync(file, `${rows.map((r) => JSON.stringify({ schemaVersion: 1, ts: Date.now(), ...r })).join('\n')}\n`);
  return file;
}

test('内部任务-227 P1a 占用集降级：gitHistory 读失败→degraded 且建议面不出号（absent≠读失败区分）', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { logFail: true, lsFail: true });
  try {
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ && typeof occ.used === 'object', '占用集须返回 used 集合（结构化返回）');
    assert.ok(Array.isArray(occ.degraded) && occ.degraded.length >= 1, `读失败须 degraded（实得 ${JSON.stringify(occ.degraded)}）`);
    assert.ok(occ.degraded.some((d) => String(d.source ?? d).includes('gitHistory')), 'degraded 须指名 gitHistory 来源');
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.ok(Array.isArray(sug.degraded) && sug.degraded.length >= 1, 'suggestedTaskId 须透出 degraded');
    // 内部任务-244 遗留项⑥（内部未决-183④）：degraded 分支须带逐源 presence 清单
    assert.ok(sug.presence && typeof sug.presence === 'object', 'degraded 须带 presence');
    const presence = Object.values(sug.presence)[0] ?? {};
    assert.equal(presence.gitHistory, 'degraded', `gitHistory 读失败在 presence 中标 degraded（实得 ${JSON.stringify(presence)}）`);
    assert.ok(presence['内部治理状态'] === 'absent' || presence['内部治理状态'] === 'present', '其余源逐源标 present/absent（无缺失键）');
    assert.equal(Object.keys(presence).length, leaseLib.OCCUPANCY_ALL_SOURCES.length, 'presence 覆盖占用源全集');
    const meta = {};
    assert.equal(leaseLib.soleTaskIdSuggestion(key, { excludeSessionId: 'sess-x', meta }), null, 'degraded 时不得内联具体号');
    assert.ok(Array.isArray(meta.degraded) && meta.degraded.length >= 1, 'soleTaskIdSuggestion 须经 meta 透出 degraded 供租约行渲染');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1a 源缺席不置 degraded：非 git 仓（无 .git）→ absent；有 .git 但 git 称非仓→degraded', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { notRepo: true });
  try {
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.equal(occ.degraded.length, 0, `非 git 仓属源缺席，不置 degraded（实得 ${JSON.stringify(occ.degraded)}）`);
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const occ2 = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ2.degraded.some((d) => String(d.source ?? d).includes('gitHistory')), '存在仓标记（.git/HEAD）却报非仓＝可判定异常，须 degraded（辅证）');
    // worktree 形态：`.git` 为常规文件且内容 `gitdir:`——同样构成仓标记（约定维 #5 补实现）。
    rmSync(join(root, '.git'), { recursive: true, force: true });
    writeFileSync(join(root, '.git'), 'gitdir: C:/repo/.git/worktrees/wt1\n');
    const occ3 = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ3.degraded.some((d) => String(d.source ?? d).includes('gitHistory')), 'worktree `.git` 文件（gitdir:）亦须识别为仓标记');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1a 注入缝：WF_GIT_BIN 指向 .mjs 夹具时 gitHistory 与 trackedPaths 同源生效', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-88 fake history\n' });
  try {
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ.bySource instanceof Map, 'bySource 须为逐源映射');
    assert.ok((occ.bySource.get('gitHistory') ?? new Set()).has(88), `fake git log 的 内部任务-88 须计入 gitHistory（实得 ${[...(occ.bySource.get('gitHistory') ?? [])].join(',')}）`);
    assert.equal(occ.degraded.length, 0);
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1b 受理校验：仅审计源占号拒绝复用并给三路指引', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 旧任务提交\n' });
  try {
    const key = projectKey(root);
    const reason = leaseLib.declarationHistoryRejection('内部任务-49', key, {});
    assert.equal(typeof reason, 'string', '仅审计源占号必须拒绝');
    assert.match(reason, /gitHistory/, '拒因须逐源列出来源');
    assert.match(reason, /--resume-task/, '拒因须含续用通道指引');
    assert.match(reason, /取新号/, '拒因须含取新号指引');
    assert.match(reason, /让号/, '拒因须含让号协议指引');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1b 续任务通道：issued 历史＋resume 放行；无证据拒；交付面占号默认放行', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 旧任务提交\n内部任务-60 另一旧号\n内部任务-88 交付面任务\n' });
  try {
    const key = projectKey(root);
    assert.equal(typeof leaseLib.declarationHistoryRejection('内部任务-49', key, {}), 'string', '无 resume 的审计源独占号须拒');
    writeIssuedLedger(env.home, key, [{ taskId: '内部任务-49', sessionId: 'sess-old' }]);
    assert.equal(leaseLib.declarationHistoryRejection('内部任务-49', key, { resume: true, resumeReason: '用户授权续用既有任务号 内部任务-49' }), null, 'issued 历史＋resume 须放行（过期弃号可续）');
    assert.equal(typeof leaseLib.declarationHistoryRejection('内部任务-60', key, { resume: true, resumeReason: '用户授权续用既有任务号 内部任务-60' }), 'string', '无 issuance 且无交付痕迹的 resume 仍须拒');
    mkdirSync(join(root, 'docs', 'plans', 'evidence', '内部任务-88'), { recursive: true });
    assert.equal(leaseLib.declarationHistoryRejection('内部任务-88', key, {}), null, '交付面占号维持现行（续任务放行）');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1c 回池保守：trackedPaths 探测失败不回池且 degraded（旧 内部任务-62 T3 语义翻转）', () => {
  const env = freshEnv();
  const root = claimsProjectWith9({ expiresAt: Date.now() - 1000 });
  const fake = withFakeGit(env.home, { lsFail: true });
  try {
    const occ = leaseLib.occupiedSeqsOfDomain(projectKey(root), 'DEV');
    assert.ok(occ.used.has(9), '探测失败保守按已跟踪＝不回池（内部决策-050 D2 修正；旧「按未跟踪回落」废止）');
    assert.ok(Array.isArray(occ.degraded) && occ.degraded.some((d) => String(d.source ?? d).includes('trackedPaths')), '探测失败须置 degraded 并指名 trackedPaths');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1d 人工通道：reason 校验、degraded 须「用户授权：」前缀、审计字段 manual=true', () => {
  const env = freshEnv();
  const root = bareProject();
  const key = projectKey(root);
  const fake = withFakeGit(env.home, { log: '' });
  try {
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-m' });
    const bad = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-2', skill: 'tdd', manual: true, manualReason: 'short' });
    assert.equal(bad.ok, false, 'manual reason 过短须拒');
    const ok = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-2', skill: 'tdd', manual: true, manualReason: '用户授权：指定 内部任务-2 作为本批任务号' });
    assert.equal(ok.ok, true, `非 degraded 合法 manual 须受理（${ok.reason ?? ''}）`);
    const active = JSON.parse(readFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'utf8'));
    assert.equal(active.manual, true, '租约须记 manual=true');
    const ch2 = leaseLib.issueChallenge(key, { sessionId: 'sess-m2' });
    fake.restore();
    const fake2 = withFakeGit(env.home, { logFail: true, lsFail: true });
    try {
      const rej = leaseLib.activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-3', skill: 'tdd', manual: true, manualReason: '随便指定一个号' });
      assert.equal(rej.ok, false, 'degraded 时 manual reason 无「用户授权：」前缀须拒');
      const ok2 = leaseLib.activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-3', skill: 'tdd', manual: true, manualReason: '用户授权：用户裁决指定 内部任务-3' });
      assert.equal(ok2.ok, true, `degraded＋用户授权引文须受理（${ok2.reason ?? ''}）`);
    } finally { fake2.restore(); }
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1e degraded 审计与查询摘要：wf-occupancy-degraded 追加行且 readRecentDegraded 可读', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { logFail: true, lsFail: true });
  try {
    const key = projectKey(root);
    leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    const file = join(process.env.WF_ROUTING_STATE_DIR, `wf-occupancy-degraded-${digest(key)}.jsonl`);
    assert.ok(existsSync(file), `degraded 审计行须落盘（期望 ${file}）`);
    const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.ok(Array.isArray(line.sources) && line.sources.length >= 1, '审计行须含 sources');
    assert.equal(typeof line.ts, 'number', '审计行须含 ts');
    assert.ok(line.context && typeof line.context === 'object', '审计行须含 context');
    const recent = leaseLib.readRecentDegraded(key, 3);
    assert.ok(Array.isArray(recent) && recent.length >= 1, 'readRecentDegraded 须可读最近记录');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1f 撞号 deny 文案：degraded 时「取号暂不可得」且不内联建议号', () => {
  const env = freshEnv();
  const root = bareProject();
  const key = projectKey(root);
  const fake = withFakeGit(env.home, { log: '内部任务-9 既有提交\n' });
  try {
    const chA = leaseLib.issueChallenge(key, { sessionId: 'sess-a' });
    assert.equal(leaseLib.activateLease(key, { leaseId: chA.leaseId, taskId: '内部任务-7', skill: 'tdd' }).ok, true, '首个声明须成功');
    const prevBin = process.env.WF_GIT_BIN;
    const prevIncidentRoot = process.env.WF_INCIDENT_ROOT;
    process.env.WF_GIT_BIN = join(env.home, 'wf-git-missing-探针'); // spawn 失败＝可判别读失败（非源缺席）
    try {
      const chB = leaseLib.issueChallenge(key, { sessionId: 'sess-b' });
      const deny = leaseLib.activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-7', skill: 'tdd' });
      assert.equal(deny.ok, false, '撞号须拒');
      assert.match(deny.reason, /取号暂不可得/, 'degraded 时 deny 文案须为「取号暂不可得」');
      assert.doesNotMatch(deny.reason, /请改用 DEV-/, 'degraded 时不得内联具体建议号');
    } finally {
      if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
      if (prevIncidentRoot === undefined) delete process.env.WF_INCIDENT_ROOT; else process.env.WF_INCIDENT_ROOT = prevIncidentRoot;
    }
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1g 声明成功路径 degraded：stderr 含「历史占用校验不完整」且退出码不变', () => {
  const env = freshEnv();
  const root = bareProject();
  const key = projectKey(root);
  const fake = withFakeGit(env.home, { logFail: true, lsFail: true });
  try {
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-cli' });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');
    const r = spawnSync(process.execPath, [cli, 'branch-finishing', '--lease', ch.leaseId, '--task-id', '内部任务-2', '--project-root', root], {
      encoding: 'utf8',
      env: { ...process.env, WF_ROUTING_STATE_DIR: process.env.WF_ROUTING_STATE_DIR, WF_INCIDENT_ROOT: process.env.WF_INCIDENT_ROOT },
      timeout: 30000,
    });
    assert.equal(r.status, 0, `声明成功须退 0（stderr=${r.stderr}）`);
    assert.match(r.stderr, /历史占用校验不完整/, 'degraded 时 stderr 须含规格字面量告警');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1h 查询面 degraded：--suggest-task-id 输出「取号暂不可得」＋来源清单且无建议号', () => {
  const env = freshEnv();
  const root = bareProject();
  const prevBin = process.env.WF_GIT_BIN;
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    process.env.WF_GIT_BIN = join(env.home, 'wf-git-missing-查询面');
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');
    const r = spawnSync(process.execPath, [cli, '--suggest-task-id', '--project-root', root], { encoding: 'utf8', env: process.env, timeout: 30000 });
    assert.equal(r.status, 0, `查询面降级仍退 0（stderr=${r.stderr}）`);
    assert.match(r.stdout, /取号暂不可得/, 'degraded 查询面须输出「取号暂不可得」');
    assert.doesNotMatch(r.stdout, /建议任务号：DEV-/, 'degraded 时不得内联任何具体号');
    assert.match(r.stdout, /占用源降级/, '须输出降级来源清单');
    assert.match(r.stdout, /源集版本=/, 'degraded 分支亦须输出源集版本（D8.2）');
  } finally {
    if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
    env.restore(); rmSync(root, { recursive: true, force: true });
  }
});

test('内部任务-227 P1i 人工通道 CLI：--manual-task-id/--manual-reason 受理并写 manual=true 审计', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '' });
  try {
    const key = projectKey(root);
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-man' });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');
    const r = spawnSync(process.execPath, [cli, 'branch-finishing', '--lease', ch.leaseId, '--manual-task-id', '内部任务-5', '--manual-reason', '用户授权：用户裁决指定 内部任务-5 作为本批任务号', '--project-root', root], { encoding: 'utf8', env: process.env, timeout: 30000 });
    assert.equal(r.status, 0, `manual 声明须成功（stderr=${r.stderr}）`);
    const active = JSON.parse(readFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'utf8'));
    assert.equal(active.taskId, '内部任务-5');
    assert.equal(active.manual, true, '租约须记 manual=true');
    assert.match(String(active.manualReason), /用户授权/, 'manualReason 须保留用户授权引文');
    const ledger = readFileSync(join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${digest(key)}.jsonl`), 'utf8');
    assert.match(ledger, /"manual":true/, 'issued 台账须记 manual=true 审计字段');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1j 段隔离：审计源占号只在自身维护者段判定（内部任务-WP-96 历史不误拒 内部任务-96）', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-WP-96 旧段任务\n' });
  try {
    const key = projectKey(root);
    assert.equal(leaseLib.declarationHistoryRejection('内部任务-96', key, {}), null, '异段审计占号不得误拒二段号（内部决策-045 段隔离）');
    assert.equal(typeof leaseLib.declarationHistoryRejection('内部任务-WP-96', key, {}), 'string', '本段仅审计源占号须拒');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1k 续任务端到端：activateLease 理由校验、放行后 lease/占位/台账记 resumed', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 旧任务提交\n' });
  try {
    const key = projectKey(root);
    writeIssuedLedger(env.home, key, [{ taskId: '内部任务-49', sessionId: 'sess-old' }]);
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-r' });
    const short = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-49', skill: 'tdd', resume: true, resumeReason: '短' });
    assert.equal(short.ok, false, 'resume 理由 <8 字须拒');
    const ok = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-49', skill: 'tdd', resume: true, resumeReason: '用户授权续用既有任务号 内部任务-49' });
    assert.equal(ok.ok, true, `续任务须放行（${ok.reason ?? ''}）`);
    const active = JSON.parse(readFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch.leaseId), 'utf8'));
    assert.equal(active.resumed, true, 'lease 须记 resumed=true');
    assert.match(String(active.resumeReason), /用户授权/, 'lease 须保留 resumeReason');
    const marker = JSON.parse(readFileSync(join(root, 'docs', 'plans', 'claims', '内部任务-49.json'), 'utf8'));
    assert.equal(marker.resumed, true, 'claims 占位须持久化 resumed=true');
    const ledger = readFileSync(join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${digest(key)}.jsonl`), 'utf8');
    assert.match(ledger, /"resumed":true/, 'issued 台账须记 resumed=true');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1l 声明路径 degraded 追加审计行（activateLease，非仅查询面）', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { logFail: true, lsFail: true });
  try {
    const key = projectKey(root);
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-audit' });
    const r = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-2', skill: 'tdd' });
    assert.equal(r.ok, true, `degraded 声明仍成功（${r.reason ?? ''}）`);
    const file = join(process.env.WF_ROUTING_STATE_DIR, `wf-occupancy-degraded-${digest(key)}.jsonl`);
    assert.ok(existsSync(file), '声明路径 degraded 须追加审计行');
    const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.equal(String(line.context?.taskId ?? ''), '内部任务-2', '审计行 context 须含 taskId');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P3 历史回归锁：内部任务-226 R1 复刻（仅审计源含历史号 49）——普通声明拒、resume 受控出路可复算', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 2026-10-21 12:46:58 旧任务提交\n' });
  try {
    const key = projectKey(root);
    // 复刻 内部任务-226 R1：49 只出现在 gitHistory（无交付面痕迹）——旧版会静默把 49 当建议号。
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.ok(occ.bySource.get('gitHistory')?.has(49));
    assert.equal(typeof leaseLib.declarationHistoryRejection('内部任务-49', key, {}), 'string', '历史已用号默认拒绝复用');
    // 判据 7：历史审计源占号不得再被「建议」产出（不产出 49）。
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true);
    assert.notEqual(sug.suggestions[0].taskId, '内部任务-49', '历史已用号不得出现在建议号');
    // 受控出路可复算：issued 历史 issuance＋resume 理由 → 放行（弃号可续场景）。
    writeIssuedLedger(env.home, key, [{ taskId: '内部任务-49', sessionId: 'sess-old' }]);
    assert.equal(leaseLib.declarationHistoryRejection('内部任务-49', key, { resume: true, resumeReason: '用户授权续用历史任务号 内部任务-49（内部任务-226 R1 复刻）' }), null, 'resume 受控出路须可复算');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1m CLI 拒因分流：历史占用拒绝不附「重取 leaseId」误导句（令牌仍有效）', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 旧任务提交\n' });
  try {
    const key = projectKey(root);
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-cli-rej' });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');
    const r = spawnSync(process.execPath, [cli, 'branch-finishing', '--lease', ch.leaseId, '--task-id', '内部任务-49', '--project-root', root], { encoding: 'utf8', env: process.env, timeout: 30000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /历史占用拒绝/, '须给出历史占用拒因');
    assert.match(r.stderr, /本令牌仍有效/, '拒因须表明令牌有效（不得误导重取 leaseId）');
    assert.doesNotMatch(r.stderr, /请从最新一轮用户消息的租约行取 leaseId 重试/, '语义拒不得附重取令牌尾句');
    assert.doesNotMatch(r.stderr, /不得在同一轮内再次声明/, '历史占用类拒绝不禁止同轮改参数重声明');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1n CLI 继承绑定拒因：停报重派且不附「重取 leaseId」误导句', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '' });
  try {
    const key = projectKey(root);
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-child-cli', delegationDepth: 1, parentSessionId: 'parent-x', inheritTaskId: '内部任务-5' });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'routing-declare.mjs');
    const r = spawnSync(process.execPath, [cli, 'branch-finishing', '--lease', ch.leaseId, '--task-id', '内部任务-6', '--project-root', root], { encoding: 'utf8', env: process.env, timeout: 30000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /委派会话不得自取任务号/);
    assert.match(r.stderr, /停止写操作/);
    assert.match(r.stderr, /本令牌仍有效/);
    assert.doesNotMatch(r.stderr, /请从最新一轮用户消息的租约行取 leaseId 重试/, '委派绑定拒不得附重取令牌尾句');
    assert.match(r.stderr, /不得在同一轮内再次声明/, '委派绑定类须明示禁同轮重声明');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P2c 父会话重声明不被子会话继承 active 判撞（无父 claim 时第三方仍拒）', () => {
  const env = freshEnv();
  const root = bareProject();
  try {
    const key = projectKey(root);
    const chChild = leaseLib.issueChallenge(key, { sessionId: 'sess-child-p', delegationDepth: 1, parentSessionId: 'parent-p', inheritTaskId: '内部任务-5' });
    assert.equal(leaseLib.activateLease(key, { leaseId: chChild.leaseId, taskId: '内部任务-5', skill: 'tdd' }).ok, true, '子会话继承声明须成功');
    // 先证第三方在「父会话无 claim、仅子继承 active」时仍被拦（防「忽略 inherited active 也绿」的弱断言）。
    const chThird0 = leaseLib.issueChallenge(key, { sessionId: 'sess-third-0' });
    const rThird0 = leaseLib.activateLease(key, { leaseId: chThird0.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(rThird0.ok, false, '无父 claim 时第三方同号仍须拒');
    const chParent = leaseLib.issueChallenge(key, { sessionId: 'parent-p' });
    const rParent = leaseLib.activateLease(key, { leaseId: chParent.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(rParent.ok, true, `父会话同号重声明须放行（${rParent.reason ?? ''}）`);
    const chThird = leaseLib.issueChallenge(key, { sessionId: 'sess-third' });
    const rThird = leaseLib.activateLease(key, { leaseId: chThird.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(rThird.ok, false, '父会话持 claim 后第三方同号仍须拒');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P2d depth=2 孙会话继承 active 不阻断父会话（根属主链传递）', () => {
  const env = freshEnv();
  const root = bareProject();
  try {
    const key = projectKey(root);
    const chChild = leaseLib.issueChallenge(key, { sessionId: 'sess-c', delegationDepth: 1, parentSessionId: 'parent-root', inheritTaskId: '内部任务-5' });
    assert.equal(leaseLib.activateLease(key, { leaseId: chChild.leaseId, taskId: '内部任务-5', skill: 'tdd' }).ok, true, '子会话继承声明');
    const chGrand = leaseLib.issueChallenge(key, { sessionId: 'sess-g', delegationDepth: 2, parentSessionId: 'sess-c', inheritTaskId: '内部任务-5' });
    assert.equal(leaseLib.activateLease(key, { leaseId: chGrand.leaseId, taskId: '内部任务-5', skill: 'tdd' }).ok, true, '孙会话继承声明');
    // 根父会话（无 claim 状态）重声明：子/孙继承 active 均须按根属主链放行。
    const chRoot = leaseLib.issueChallenge(key, { sessionId: 'parent-root' });
    const rRoot = leaseLib.activateLease(key, { leaseId: chRoot.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(rRoot.ok, true, `depth=2 链下父会话重声明须放行（${rRoot.reason ?? ''}）`);
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P1p 空仓（git init 零提交）归 absent：gitHistory 不置 degraded、建议号可用', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { emptyRepo: true, lsFiles: '' });
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.equal(occ.degraded.length, 0, '空仓读失败属源为空，不置 degraded');
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true, '新仓首任务取号须可用');
    assert.equal(sug.suggestions[0].taskId, '内部任务-1');
  } finally { fake.restore(); env.restore(); rmSync(root, { recursive: true, force: true }); }
});

// 内部任务-345：spawn 固定 LC_ALL=C——宿主 locale 非英文（如 zh_CN）时，fake git 的
// 「locale 敏感」分支会按继承到的宿主动态输出中文；只有 spawn 侧把 LC_ALL 固定为 C
// 才能稳定得到英文文案（NOT_REPO 分支），从而走 absent（内部规则-25：非仓/空仓≠读失败）。
test('内部任务-227 P1q 宿主 locale 非 C 时非仓/空仓仍判 absent（spawn 固定 LC_ALL=C）', () => {
  const env = freshEnv();
  const home = mkdtempSync(join(tmpdir(), 'wf-locale-'));
  const prevLc = process.env.LC_ALL;
  const prevLang = process.env.LANG;
  try {
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.LANG = 'zh_CN.UTF-8';
    const envFile = join(home, 'seen-env.json');
    const fake = withFakeGit(home, { localeSensitive: true, notRepo: true, envFile });
    try {
      const proj = mkdtempSync(join(home, 'proj-'));
      const key = projectKey(proj);
      const sug = leaseLib.suggestedTaskId(key);
      assert.equal(sug.ok, true, '宿主 locale 非 C 时仍应取号成功（absent 而非 degraded）');
      assert.deepEqual(sug.degraded, [], '成功路径的 degraded 面为空数组（内部规则-25 字段恒在）');
      assert.deepEqual(sug.suggestions.map((s) => s.taskId), ['内部任务-1']);
      const seen = JSON.parse(readFileSync(envFile, 'utf8'));
      assert.equal(seen.LC_ALL, 'C', 'spawn 侧固定 LC_ALL=C');
      assert.equal(seen.LANG, 'C', 'spawn 侧固定 LANG=C');
    } finally {
      fake.restore();
    }
  } finally {
    if (prevLc === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLc;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    env.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('内部任务-227 fail-loud 与受理校验：整合断言（内部验收-27 锚）', () => {
  const env = freshEnv();
  const root = bareProject();
  const fake = withFakeGit(env.home, { log: '内部任务-49 旧任务提交\n' });
  try {
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.equal(occ.degraded.length, 0, '非降级基线');
    assert.ok(occ.bySource.get('gitHistory')?.has(49), '审计源 gitHistory 占用事实可见');
    const reason = leaseLib.declarationHistoryRejection('内部任务-49', key, {});
    assert.equal(typeof reason, 'string', '仅审计源占号须拒绝复用');
    assert.match(reason, /gitHistory/, '拒因逐源指认 gitHistory');
    assert.match(reason, /--resume-task/, '拒因含续任务通道');
    assert.match(reason, /人工指定号须由人裁决/, '拒因含人工裁决文案');
    // degraded 面独立覆盖：模拟读失败（spawn 失败切换注入缝，避开同桩 memo 缓存）→ 建议面不出号＋审计可读。
    fake.restore();
    const prevBin = process.env.WF_GIT_BIN;
    process.env.WF_GIT_BIN = join(env.home, 'wf-git-missing-umbrella');
    try {
      const occ2 = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
      assert.ok(occ2.degraded.length >= 1, '读失败须 degraded');
      assert.equal(leaseLib.soleTaskIdSuggestion(key, { excludeSessionId: 'sess-z', meta: {} }), null, 'degraded 时不得内联具体号');
      assert.ok(leaseLib.readRecentDegraded(key, 3).length >= 1, 'degraded 审计可读');
    } finally {
      if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
    }
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

// ============ 内部任务-190（内部决策-061 D2）：项目根不存在＝源缺席（absent），不降级 ============

/** ghost 根：确定不存在于磁盘的项目根（tmpdir 随机名，永不 mkdir；避免激活路径 mkdir 副作用把根建出来）。 */
function ghostRoot() {
  return join(tmpdir(), `wf-dev190-ghost-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test('内部任务-190 根不存在归 absent：占用集不降级、建议面出号（内部验收-27 锚）', () => {
  const env = freshEnv();
  const prevBin = process.env.WF_GIT_BIN;
  try {
    const root = ghostRoot();
    assert.equal(existsSync(root), false, '前置：ghost 根不存在');
    // 缺 bin 桩：若实现仍 spawn git 必落 degraded（全平台确定性 RED）；修复后前置判定零 spawn → absent
    process.env.WF_GIT_BIN = join(tmpdir(), 'wf-git-missing-DEV190');
    const key = projectKey(root);
    const occ = leaseLib.occupiedSeqsOfDomain(key, 'DEV');
    assert.deepEqual(occ.degraded, [], '根不存在＝源缺席，不置 degraded（内部决策-061 决策 2）');
    const sug = leaseLib.suggestedTaskId(key, { domain: 'DEV' });
    assert.equal(sug.ok, true, '建议面不得被降级阻断');
    assert.equal(sug.suggestions[0].taskId, '内部任务-1');
    assert.equal(leaseLib.soleTaskIdSuggestion(key, { domain: 'DEV' }), '内部任务-1', '内联建议号可用');
  } finally {
    if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
    env.restore();
  }
});

test('内部任务-190 根不存在＋撞号：deny 文案不落 degraded 分支（双路指引/建议号在案）', () => {
  const env = freshEnv();
  const prevBin = process.env.WF_GIT_BIN;
  try {
    const root = ghostRoot();
    assert.equal(existsSync(root), false, '前置：ghost 根不存在');
    const key = projectKey(root);
    // 用 seedActiveLease 造「异会话持有」，避开 activateLease 写 claim 时 mkdir 把 ghost 根建出来
    seedActiveLease(process.env.WF_ROUTING_STATE_DIR, { token: 'tok-dev190-a', sessionId: 'sess-dev190-A', key, taskId: '内部任务-7' });
    process.env.WF_GIT_BIN = join(tmpdir(), 'wf-git-missing-DEV190-deny');
    const chB = leaseLib.issueChallenge(key, { sessionId: 'sess-dev190-B' });
    const r = leaseLib.activateLease(key, { leaseId: chB.leaseId, taskId: '内部任务-7', skill: 'tdd' });
    assert.equal(r.ok, false, '具名异会话同号须阻断');
    const reason = String(r.reason ?? '');
    assert.ok(reason.includes('撞号阻断'), '撞号事实在案');
    assert.ok(reason.includes('延续本任务'), '双路指引：延续同号路径在案');
    assert.ok(reason.includes('取最小未用号'), '不得落 degraded 分支');
    assert.ok(reason.includes('内部任务-1'), '建议号内联');
    assert.ok(!reason.includes('取号暂不可得'), '不得出现「取号暂不可得」');
  } finally {
    if (prevBin === undefined) delete process.env.WF_GIT_BIN; else process.env.WF_GIT_BIN = prevBin;
    env.restore();
  }
});

// ============ 内部任务-227（内部决策-061 D3/D4）：挑战体 v5 与委派继承声明 ============

test('内部任务-227 P2a 挑战体v5：schema 恒 5、委派三字段仅 depth>0 且父 id 非空时写入', () => {
  const env = freshEnv();
  const root = bareProject();
  try {
    const key = projectKey(root);
    const chTop = leaseLib.issueChallenge(key, { sessionId: 'sess-top' });
    const top = JSON.parse(readFileSync(challengePath(process.env.WF_ROUTING_STATE_DIR, chTop.leaseId), 'utf8'));
    assert.equal(top.schemaVersion, 5, '挑战体 schemaVersion 恒 5（内部决策-061 D3）');
    assert.equal(top.delegationDepth, undefined, '顶层会话不写 delegationDepth');
    assert.equal(top.parentSessionId, undefined, '顶层会话不写 parentSessionId');
    assert.equal(top.inheritTaskId, undefined, '顶层会话不写 inheritTaskId');
    const chDel = leaseLib.issueChallenge(key, { sessionId: 'sess-del', delegationDepth: 2, parentSessionId: 'parent-1', inheritTaskId: '内部任务-5' });
    const del = JSON.parse(readFileSync(challengePath(process.env.WF_ROUTING_STATE_DIR, chDel.leaseId), 'utf8'));
    assert.equal(del.schemaVersion, 5);
    assert.equal(del.delegationDepth, 2);
    assert.equal(del.parentSessionId, 'parent-1');
    assert.equal(del.inheritTaskId, '内部任务-5');
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 P2b 继承声明：绑定 inheritTaskId、不写 claim/占位、active/台账 inherited、兄弟同号放行', () => {
  const env = freshEnv();
  const root = bareProject();
  try {
    const key = projectKey(root);
    const mkChallenge = (sessionId) => leaseLib.issueChallenge(key, { sessionId, delegationDepth: 1, parentSessionId: 'parent-1', inheritTaskId: '内部任务-5' });
    const ch1 = mkChallenge('sess-child1');
    const r1 = leaseLib.activateLease(key, { leaseId: ch1.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(r1.ok, true, `继承声明须成功（${r1.reason ?? ''}）`);
    assert.equal(r1.inherited, true, '返回须标注继承声明');
    assert.equal(r1.claimWritten, false, '继承声明不写 claim（占用归父）');
    const active = JSON.parse(readFileSync(activePath(process.env.WF_ROUTING_STATE_DIR, ch1.leaseId), 'utf8'));
    assert.equal(active.inherited, true);
    assert.equal(active.parentSessionId, 'parent-1');
    assert.equal(existsSync(join(root, 'docs', 'plans', 'claims', '内部任务-5.json')), false, '继承声明不写 claims 占位');
    const ledger = readFileSync(join(process.env.WF_ROUTING_STATE_DIR, `wf-issued-${digest(key)}.jsonl`), 'utf8');
    assert.match(ledger, /"inherited":true/, 'issued 台账须记 inherited=true');
    assert.match(ledger, /"parentSessionId":"parent-1"/, 'issued 台账须记 parentSessionId');
    const claimFiles = readdirSync(process.env.WF_ROUTING_STATE_DIR).filter((n) => n.startsWith('wf-lease-claim-'));
    assert.deepEqual(claimFiles, [], '继承声明不写 state claim（占用归父；文件级断言防 false-green）');
    // 兄弟委派会话可声明同号（放行）
    const ch2 = mkChallenge('sess-child2');
    assert.equal(leaseLib.activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-5', skill: 'tdd' }).ok, true, '兄弟同号放行');
    // req.taskId 必须等于 inheritTaskId
    const ch3 = mkChallenge('sess-child3');
    const bad = leaseLib.activateLease(key, { leaseId: ch3.leaseId, taskId: '内部任务-6', skill: 'tdd' });
    assert.equal(bad.ok, false, '自取异号须拒');
    assert.match(bad.reason, /委派会话不得自取任务号/);
    assert.match(bad.reason, /停止写操作/, '失败出路须为停报重派（禁止同轮重试）');
    // depth=2 继承声明成功（挑战 delegationDepth=2 → 声明面同一路径，不应因深度数值差异失败）
    const ch4 = leaseLib.issueChallenge(key, { sessionId: 'sess-child4', delegationDepth: 2, parentSessionId: 'parent-2', inheritTaskId: '内部任务-5' });
    const r4 = leaseLib.activateLease(key, { leaseId: ch4.leaseId, taskId: '内部任务-5', skill: 'tdd' });
    assert.equal(r4.ok, true, `depth=2 继承声明须成功（${r4.reason ?? ''}）`);
    assert.equal(r4.inherited, true);
    assert.equal(r4.delegationDepth, 2);
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('内部任务-227 委派继承：整合断言（内部验收-28 锚）', () => {
  const env = freshEnv();
  const root = bareProject();
  try {
    const key = projectKey(root);
    // 解析源：issued 台账 append-only（父会话行带 taskId）——即使 active/挑战已轮换删除仍可解析。
    writeIssuedLedger(env.home, key, [{ taskId: '内部任务-9', sessionId: 'parent-9', inherited: false }]);
    const resolved = leaseLib.resolveInheritedTaskId(key, 'parent-9', 1);
    assert.equal(resolved.ok, true, '父链 issued 行可解析继承号');
    assert.equal(resolved.taskId, '内部任务-9');
    assert.equal(leaseLib.resolveInheritedTaskId(key, 'parent-absent', 1).ok, false, '父链不可解析须 ok:false（不出号）');
    assert.equal(leaseLib.resolveInheritedTaskId(key, 'parent-9', 0).ok, false, '非委派深度不解析');
    // 挑战 v5 → 继承声明 → active/台账审计（D4 声明面）
    const ch = leaseLib.issueChallenge(key, { sessionId: 'sess-anchor', delegationDepth: 1, parentSessionId: 'parent-9', inheritTaskId: '内部任务-9' });
    const act = leaseLib.activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-9', skill: 'tdd' });
    assert.equal(act.ok, true, `继承锚用例声明须成功（${act.reason ?? ''}）`);
    assert.equal(act.inherited, true);
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-244 P06/P07：bySource 随建议号返回 / 仓键缓存多槽 ──

test('内部任务-244 P06/P07：suggestedTaskId 建议号携带 bySource；仓键缓存按 workspaceRoot 多槽共存', () => {
  const env = freshEnv();
  const wsA = mkdtempSync(join(tmpdir(), 'wf-slot-A-'));
  const wsB = mkdtempSync(join(tmpdir(), 'wf-slot-B-'));
  const stateDir = process.env.WF_ROUTING_STATE_DIR;
  const prevGitBin = process.env.WF_GIT_BIN;
  try {
    delete process.env.WF_GIT_BIN; // 隔离链上前序用例可能残留的 fake git 注入（真 git 探测）
    for (const [ws, repo] of [[wsA, 'repoA'], [wsB, 'repoB']]) {
      mkdirSync(join(ws, repo, '.git'), { recursive: true });
    }
    const sug = leaseLib.suggestedTaskId(projectKey(wsA), { domain: 'DEV' });
    assert.equal(sug.ok, true, `建议号查询须成功（${sug.hint ?? ''} ${JSON.stringify(sug.degraded ?? [])}）`);
    assert.ok(sug.suggestions[0].bySource && typeof sug.suggestions[0].bySource === 'object', '建议号携带逐占用源 bySource（查询面免二次全扫）');
    // 两个工作区交替发现：缓存多槽共存（单槽实现会互相顶掉）
    leaseLib.discoverRepoKeys(wsA);
    leaseLib.discoverRepoKeys(wsB);
    const cache = JSON.parse(readFileSync(join(stateDir, 'wf-repos-cache.json'), 'utf8'));
    const keys = Object.keys(cache.slots ?? {});
    assert.equal(keys.length, 2, `缓存须按 workspaceRoot 多槽共存（实得 ${keys.length} 槽）`);
    const again = leaseLib.discoverRepoKeys(wsA);
    assert.ok(again.some((r) => r.includes('repoA')), 'A 的槽命中（无需重扫）');
  } finally {
    if (prevGitBin === undefined) delete process.env.WF_GIT_BIN;
    else process.env.WF_GIT_BIN = prevGitBin;
    env.restore();
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  }
});

// ── 内部任务-244 C04：仓键发现接受 symlink 目录 ──

test('内部任务-244 C04：discoverRepoKeys 接受 symlink 目录（目标为 git 仓）', { skip: CAN_SYMLINK ? false : 'symlink 不可用（Windows 无开发者模式）——该平台缺陷面不存在' }, () => {
  const env = freshEnv();
  const ws = mkdtempSync(join(tmpdir(), 'wf-discover-'));
  const external = mkdtempSync(join(tmpdir(), 'wf-discover-ext-'));
  try {
    mkdirSync(join(external, '.git'), { recursive: true });
    symlinkSync(external, join(ws, 'linkedRepo'), 'dir');
    const keys = discoverRepoKeys(ws);
    const wantReal = realpathSync(external);
    const found = keys.some((k) => {
      try {
        return realpathSync(String(k)) === wantReal;
      } catch {
        return false;
      }
    });
    assert.ok(found, `symlink 目录指向的仓须入仓键集（实得 ${keys.join(', ')}）`);
  } finally {
    env.restore();
    rmSync(ws, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

// ── 内部任务-244 C01：sweep 先删 current 指针导致轮换吊销跳过——旧租约在新 prompt 后仍可授权 ──

test('内部任务-244 C01：上一挑战过期后新 prompt 签发 → 旧 active 必须吊销、promptEpoch 不回退', () => {
  const env = freshEnv();
  try {
    const key = '/proj/c01';
    const sessionId = 'sess-C01';
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const ch1 = issueChallenge(key, { sessionId });
    assert.equal(activateLease(key, { leaseId: ch1.leaseId, taskId: '内部任务-44', skill: 'tdd' }).ok, true);
    // 模拟长会话：上一挑战已过期（>TTL），而 active 已被心跳续期仍有效 → sweep 会删 current 指针
    const cp = challengePath(stateDir, ch1.leaseId);
    const chBody = JSON.parse(readFileSync(cp, 'utf8'));
    chBody.expiresAt = Date.now() - 1000;
    writeFileSync(cp, JSON.stringify(chBody));
    const ap = activePath(stateDir, ch1.leaseId);
    const actBody = JSON.parse(readFileSync(ap, 'utf8'));
    actBody.expiresAt = Date.now() + 3600000;
    writeFileSync(ap, JSON.stringify(actBody));
    // 新 prompt 签发（sweep 先运行；修复必须在 sweep 前捕获 prev / 按 session 扫描吊销）
    const ch2 = issueChallenge(key, { sessionId });
    assert.notEqual(ch2.leaseId, ch1.leaseId, '新 prompt 换新令牌');
    assert.equal(existsSync(ap), false, '旧 active 随轮换吊销（即使上一挑战已过期/sweep 已删指针）');
    assert.equal(existsSync(cp), false, '旧挑战文件随轮换吊销（旧 token 不得再激活）');
    const cur = readActiveLease(key, Date.now(), { sessionId });
    assert.equal(cur.valid, false, '新 prompt 后旧租约不得经扫描回退救回（内部验收-9 会话桶强形态）');
    const ch2Body = JSON.parse(readFileSync(challengePath(stateDir, ch2.leaseId), 'utf8'));
    assert.equal(ch2Body.promptEpoch, 2, 'promptEpoch 基于 sweep 前捕获的指针递增，不回退为 1');
  } finally { env.restore(); }
});

// ── 内部任务-244 D01/D05：claim 原子建立（tmp+link 排他）与释放条件写 ──

test('内部任务-244 D01：claim 原子占用建立——排他冲突/同属主刷新/过期清理/降级形态', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const key = '/proj/d01';
    const body = (over = {}) => ({
      taskId: '内部任务-50', sessionId: 'sess-D01', host: 'dsh',
      declaredAt: Date.now(), expiresAt: Date.now() + 3600000, ...over,
    });
    const a1 = leaseLib.acquireClaim(key, body());
    assert.equal(a1.ok, true, '首次建立成功');
    assert.equal(a1.mode, 'created', '首次走排他创建');
    const cf = claimPath(stateDir, key, '内部任务-50');
    // 同属主未过期 → 刷新（不判冲突）
    const a2 = leaseLib.acquireClaim(key, body({ expiresAt: Date.now() + 7200000 }));
    assert.equal(a2.ok, true);
    assert.equal(a2.mode, 'refreshed', '同属主重声明走刷新而非撞号');
    // 异属主未过期 → 冲突，且他人占位字节保持不变（read→link 窗口新建不覆盖）
    const before = readFileSync(cf, 'utf8');
    const a3 = leaseLib.acquireClaim(key, body({ sessionId: 'sess-OTHER' }));
    assert.equal(a3.ok, false);
    assert.equal(a3.mode, 'conflict');
    assert.equal(readFileSync(cf, 'utf8'), before, '冲突方占位字节不变（不得清理/改写他人新建占位）');
    // 同属主已过期 → 清理后重建
    const stale = { ...JSON.parse(before), expiresAt: Date.now() - 1000 };
    writeFileSync(cf, JSON.stringify(stale));
    const a4 = leaseLib.acquireClaim(key, body());
    assert.equal(a4.ok, true, '过期 claim 清理后重建成功');
    // 降级形态（硬链接不可用注入缝）：wx 直建 + complete:true，读侧接受
    process.env.WF_CLAIM_FORCE_LINKFAIL = '1';
    try {
      const a5 = leaseLib.acquireClaim(key, body({ taskId: '内部任务-51' }));
      assert.equal(a5.ok, true);
      assert.equal(a5.mode, 'degraded');
      const deg = JSON.parse(readFileSync(claimPath(stateDir, key, '内部任务-51'), 'utf8'));
      assert.equal(deg.complete, true, '降级形态带 complete 就绪标记');
      assert.equal(a5.claim?.sessionId, 'sess-D01');
    } finally {
      delete process.env.WF_CLAIM_FORCE_LINKFAIL;
    }
  } finally { env.restore(); }
});

test('内部任务-244 D05：同会话重声明刷新、release 后重声明、释放与并发改写交错不覆盖新占位', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-claims-d05-'));
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const sid = 'sess-D05';
    const ch1 = issueChallenge('/proj/d05', { sessionId: sid });
    assert.equal(activateLease('/proj/d05', { leaseId: ch1.leaseId, taskId: '内部任务-52', skill: 'tdd' }).ok, true);
    const cf = claimPath(stateDir, '/proj/d05', '内部任务-52');
    const first = JSON.parse(readFileSync(cf, 'utf8'));
    // 同会话重声明 → claim 刷新且不判撞号
    const ch2 = issueChallenge('/proj/d05', { sessionId: sid });
    const r2 = activateLease('/proj/d05', { leaseId: ch2.leaseId, taskId: '内部任务-52', skill: 'tdd' });
    assert.equal(r2.ok, true, `同会话同号重声明须成功（${r2.reason ?? ''}）`);
    const refreshed = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(refreshed.sessionId, sid);
    assert.ok(Number(refreshed.expiresAt) >= Number(first.expiresAt), 'claim expiresAt 顺延');
    assert.equal(refreshed.claimedAt, first.claimedAt, 'claimedAt 保持首占时间（刷新不改占用起点）');
    // release 后重声明成功（claim 被 release 路径删除，不残留 EEXIST）
    leaseLib.releaseClaim('/proj/d05', sid);
    assert.equal(existsSync(cf), false, 'release 删除状态根 claim');
    const ch3 = issueChallenge('/proj/d05', { sessionId: sid });
    assert.equal(activateLease('/proj/d05', { leaseId: ch3.leaseId, taskId: '内部任务-52', skill: 'tdd' }).ok, true, 'release 后重声明成功');
    // D05 释放竞态：marker 在「首校验后、写回前」被并发重声明改写——不得把新占位翻 released
    const mkey = projectKey(root);
    assert.equal(leaseLib.writeClaimMarker(mkey, { taskId: '内部任务-79', skill: 'tdd', sessionId: null, host: 'dsh' }).ok, true);
    process.env.WF_CLAIM_RELEASE_RACE_REWRITE = '1';
    try {
      const rel = leaseLib.markClaimReleased(mkey, '内部任务-79');
      assert.equal(rel.ok, false, '并发改写窗口内释放必须放弃翻转');
      const markerFile = join(root, 'docs', 'plans', 'claims', '内部任务-79.json');
      const after = JSON.parse(readFileSync(markerFile, 'utf8'));
      assert.equal(after.sessionDigest, 'newholder00000000', '并发写入的新占位摘要保持不变');
      assert.equal(after.status, 'claimed', '新占位不得被翻成 released');
    } finally {
      delete process.env.WF_CLAIM_RELEASE_RACE_REWRITE;
    }
  } finally { env.restore(); rmSync(root, { recursive: true, force: true }); }
});

// ── 内部任务-244 D02/D03/D04：清理/心跳/复活竞态（读后复核 + 写回前复核） ──

test('内部任务-244 D02：sweep 占位清理读后复核——快照后并发写入的新占位不被删', () => {
  const env = freshEnv();
  const root = mkdtempSync(join(tmpdir(), 'wf-sweep-d02-'));
  const prevGitBin = process.env.WF_GIT_BIN;
  try {
    delete process.env.WF_GIT_BIN; // 隔离链上其他用例可能残留的 fake git 注入（本用例需真 git 探测）
    spawnSync('git', ['init', '-q'], { cwd: root }); // 真 git 仓 → trackedPaths ok（空集）
    mkdirSync(process.env.WF_ROUTING_STATE_DIR, { recursive: true }); // sweep 全目录扫描的前置
    assert.equal(spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status, 0, 'git 夹具就绪');
    const key = projectKey(root);
    assert.equal(leaseLib.writeClaimMarker(key, { taskId: '内部任务-63', skill: 'tdd', sessionId: null, host: 'dsh' }).ok, true);
    const mf = join(root, 'docs', 'plans', 'claims', '内部任务-63.json');
    const body = JSON.parse(readFileSync(mf, 'utf8'));
    body.expiresAt = Date.now() - 1000;
    body.status = 'claimed';
    writeFileSync(mf, JSON.stringify(body));
    // 注入缝：sweep 快照后、删除前，另一会话重写为 fresh 占位
    process.env.WF_SWEEP_CLAIM_RACE_REWRITE = '1';
    try {
      issueChallenge(key, { sessionId: 'sess-SW' });
    } finally {
      delete process.env.WF_SWEEP_CLAIM_RACE_REWRITE;
    }
    assert.ok(existsSync(mf), '快照后并发写入的新占位不得被 sweep 删除');
    const after = JSON.parse(readFileSync(mf, 'utf8'));
    assert.equal(after.status, 'claimed');
    assert.ok(Number(after.expiresAt) > Date.now(), '新占位保持 fresh');
  } finally {
    if (prevGitBin === undefined) delete process.env.WF_GIT_BIN;
    else process.env.WF_GIT_BIN = prevGitBin;
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('内部任务-244 D03：心跳不得复活已吊销租约（读后删除窗口复核）', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const key = '/proj/d03';
    const ch = issueChallenge(key, { sessionId: 'sess-HB' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-64', skill: 'tdd' }).ok);
    const lease = readActiveLease(key, Date.now(), { sessionId: 'sess-HB' }).lease;
    const af = activePath(stateDir, ch.leaseId);
    // 逼近过期（<2/3 TTL）→ 心跳进入写盘路径，随后注入缝模拟「读后、写回前」被轮换删除
    const near = JSON.parse(readFileSync(af, 'utf8'));
    near.expiresAt = Date.now() + 1000;
    writeFileSync(af, JSON.stringify(near));
    process.env.WF_HEARTBEAT_RACE_DELETE = '1';
    try {
      const wrote = leaseLib.heartbeatLease(lease);
      assert.equal(wrote, false, '轮换删除后心跳不得回写成功');
    } finally {
      delete process.env.WF_HEARTBEAT_RACE_DELETE;
    }
    assert.equal(existsSync(af), false, '被吊销的 active 不得被心跳复活重建');
  } finally { env.restore(); }
});

test('内部任务-244 D04：宽限复活与清理交错——active 被删后不得复活重建', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const key = '/proj/d04';
    const sid = 'sess-RV';
    const ch = issueChallenge(key, { sessionId: sid });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-65', skill: 'tdd' }).ok);
    const af = activePath(stateDir, ch.leaseId);
    const body = JSON.parse(readFileSync(af, 'utf8'));
    body.expiresAt = Date.now() - 1000; // 宽限窗内（≤1 TTL）
    writeFileSync(af, JSON.stringify(body));
    process.env.WF_REVIVE_RACE_DELETE = '1';
    let r;
    try {
      r = leaseLib.reviveOrHeartbeat(key, sid);
    } finally {
      delete process.env.WF_REVIVE_RACE_DELETE;
    }
    assert.equal(r.action, 'none', 'active 已被清理删除 → 不得复活');
    assert.equal(existsSync(af), false, '被删的 active 不得被复活重建');
  } finally { env.restore(); }
});

// ── 内部任务-244 E05：active 写失败回滚 / atomicWrite 失败清理 tmp ──

test('内部任务-244 E05：active 写失败 → 声明 {ok:false} 且回滚 claim/占位（不留半激活）', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const key = '/proj/e05';
    const ch = issueChallenge(key, { sessionId: 'sess-E05' });
    process.env.WF_FORCE_ACTIVE_WRITE_FAIL = '1';
    let r;
    try {
      r = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-66', skill: 'tdd' });
    } finally {
      delete process.env.WF_FORCE_ACTIVE_WRITE_FAIL;
    }
    assert.equal(r.ok, false, 'active 落盘失败不得宣称声明成功');
    assert.ok(String(r.reason).includes('写权限保存失败'), `拒因点名 active 落盘面（实得 ${r.reason}）`);
    assert.equal(existsSync(claimPath(stateDir, key, '内部任务-66')), false, 'claim 已回滚');
    assert.equal(readActiveLease(key, Date.now(), { sessionId: 'sess-E05' }).valid, false, '无激活残留');
  } finally { env.restore(); }
});

test('内部任务-244 E05：atomicWrite 失败清理唯一 tmp（不残留 .tmp）', () => {
  const env = freshEnv();
  try {
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    process.env.WF_FORCE_ATOMIC_WRITE_FAIL = '1';
    try {
      assert.throws(() => issueChallenge('/proj/e05b', { sessionId: 'sess-X' }), /forced atomic write failure/);
    } finally {
      delete process.env.WF_FORCE_ATOMIC_WRITE_FAIL;
    }
    const leftovers = existsSync(stateDir) ? readdirSync(stateDir).filter((n) => n.endsWith('.tmp')) : [];
    assert.deepEqual(leftovers, [], '失败路径不得残留唯一临时文件');
  } finally { env.restore(); }
});

// ── 内部任务-244 最终安全评审 B1：只读白名单不得被 shell 展开绕过 ──

test('内部任务-244 最终安全评审 B1：引号外 `${IFS}`/brace expansion/双引号内 $ 一律 fail-closed', () => {
  // brace expansion：{--output,/tmp/pwn} 展开成两个 token 冒充无害参数
  assert.equal(isReadOnlyCommand('sort {--output,/tmp/pwn} README.md'), false, 'brace expansion 拒绝');
  // ${IFS} 分词：--output${IFS}/tmp/pwn 展开为 --output /tmp/pwn
  assert.equal(isReadOnlyCommand('sort --output${IFS}/tmp/pwn README.md'), false, '${IFS} 分词拒绝');
  assert.equal(isReadOnlyCommand('date --set${IFS}12:00'), false, '${IFS} 拼参数拒绝');
  assert.equal(isReadOnlyCommand('sort --compress-prog${IFS}/bin/sh x'), false, '${IFS} 拼执行参数拒绝');
  // 双引号内变量/反引号仍展开
  assert.equal(isReadOnlyCommand('sort "--output=$HOME/pwn" x'), false, '双引号内 $ 展开拒绝');
  assert.equal(isReadOnlyCommand('sort "--output=`id`" x'), false, '双引号内反引号拒绝');
  assert.equal(isReadOnlyCommand("sort '--output=/tmp/pwn' x"), false, '单引号内字面量不构成展开但危险参数仍按 token 拒');
  // 合法只读命令不受影响（单引号内 $ 是字面量）
  assert.equal(isReadOnlyCommand("grep 'foo$' README.md"), true, '单引号内 $ 字面量放行');
  assert.equal(isReadOnlyCommand('git log --format="%h %s"'), true, '双引号无展开的只读 git 放行');
});

// ── 内部任务-247 F1：纯 cd 导航命令白名单（多仓 cwd 漂移逃生通道） ──

test('纯 cd 导航命令白名单（内部任务-247）', () => {
  // 正例：绝对路径单参数（POSIX/盘符正斜杠/引号内空白路径/裸根；反斜杠路径须单引号字面量——
  // 词法状态机把引号外与双引号内的反斜杠按转义归一〔\r 消费为 r〕，裸反斜杠形态 fail-closed 拒）
  assert.equal(isPureCdCommand('cd /root/projects/main'), true, 'POSIX 绝对路径');
  assert.equal(isPureCdCommand('cd /'), true, '裸根');
  assert.equal(isPureCdCommand('cd C:/repo'), true, '盘符正斜杠');
  assert.equal(isPureCdCommand(String.raw`cd 'C:\repo'`), true, '盘符反斜杠（单引号字面量）');
  assert.equal(isPureCdCommand('cd "C:/Program Files/x"'), true, '双引号含空白（正斜杠形态）');
  assert.equal(isPureCdCommand("cd '/root/my dir'"), true, '单引号字面量含空白');
  // 负例：非绝对/旗标/多参数/复合/元字符/展开/路径形态命令名/环境赋值/裸反斜杠（转义归一后非绝对路径）
  const bad = [
    'cd', 'cd ..', 'cd ../..', 'cd ~', 'cd -', 'cd -e', 'cd relative/path',
    String.raw`cd C:\repo`, String.raw`cd "C:\repo"`,
    'cd /a /b', 'cd /a && pwd', 'cd /a; ls', 'cd /a | cat', 'cd /a > f', 'cd /a & ls',
    'cd $(pwd)', 'cd /a$(id)', 'cd `pwd`', 'cd "C:/x$id"', 'cd {/a}',
    'CD /a', 'CD=1 cd /a', './cd /a', 'sub/cd /a', 'cd.exe /a',
    'echo cd /a', 'pwd && cd /a',
  ];
  for (const c of bad) assert.equal(isPureCdCommand(c), false, `负例须拒：${c}`);
});

// ── 内部任务-244 遗留项⑤：claims 目录 continuity——越界 symlink 不得写入/删除仓外文件 ──

test('内部任务-244 遗留：内部计划 为越界 symlink 时拒绝写/读占位（不跟随）', { skip: CAN_SYMLINK ? false : 'symlink 不可用' }, () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-claims-insec-'));
  const outside = mkdtempSync(join(tmpdir(), 'wf-claims-out-'));
  try {
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    symlinkSync(outside, join(repo, 'docs', 'plans', 'claims'), process.platform === 'win32' ? 'junction' : 'dir');
    const key = projectKey(repo);
    const w = leaseLib.writeClaimMarker(key, { taskId: '内部任务-901', skill: 'tdd', sessionId: 's-1', host: 'dsh' });
    assert.equal(w.ok, false, '越界 claims 目录拒绝写占位');
    assert.equal(existsSync(join(outside, '内部任务-901.json')), false, '仓外目录不得被写入');
    const rel = leaseLib.markClaimReleased(key, '内部任务-901');
    assert.equal(rel.ok, false, '越界 claims 目录拒绝改占位');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── 内部任务-261（内部决策-066 D3）：scriptWrites 向后兼容与归一 ──

test('内部任务-261 scriptWrites 向后兼容：旧租约无字段可读；normalize 拒绝坏理由/坏形态', () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-lease-sw-'));
  try {
    mkdirSync(join(repo, '.git'));
    const key = projectKey(repo);
    const ch = issueChallenge(key);
    const act = activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-260', skill: 'tdd' });
    assert.equal(act.ok, true, '旧形态激活须成功');
    const r = readActiveLease(key);
    assert.equal(r.valid, true);
    assert.equal(Object.hasOwn(r.lease, 'scriptWrites'), false, '旧租约（无 scriptWrites）须兼容读取');
    // normalize：字符串/对象皆可，declaredAt 由库补
    const normStr = leaseLib.normalizeScriptWrites(['这是一个合法理由']);
    assert.equal(normStr.length, 1);
    assert.match(String(normStr[0].declaredAt), /^\d{4}-/);
    const normObj = leaseLib.normalizeScriptWrites([{ reason: '这是另一个合法理由' }]);
    assert.equal(normObj[0].reason, '这是另一个合法理由');
    // 坏形态/短理由拒
    assert.throws(() => leaseLib.normalizeScriptWrites(['短']), /≥8/);
    assert.throws(() => leaseLib.normalizeScriptWrites('not-array'), /数组/);
    assert.throws(() => leaseLib.normalizeScriptWrites([42]), /条目/);
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部任务-342 leaseContextOfOwn：null 桶/他会话租约不归因，仅本会话具名桶返回 taskId', () => {
  const env = freshEnv();
  // 内部未决-295：夹具键改 tmpdir 真路径＋projectKey 推导（键面与 cwd 面——leaseContextOfOwn
  // 内部 projectKey——同源，win32 不再按当前盘符分叉）；.git 钉住 gitAncestor 落点（内部任务-261 scriptWrites 测试同款范式）。
  const repo = mkdtempSync(join(tmpdir(), 'wf-lease-own342-'));
  mkdirSync(join(repo, '.git'));
  try {
    const key = projectKey(repo);
    // null 桶声明（补签形态）：对具体会话不可归因
    const chNull = issueChallenge(key);
    assert.equal(activateLease(key, { leaseId: chNull.leaseId, taskId: '内部任务-950', skill: 'plan-execution' }).ok, true);
    assert.deepEqual(leaseLib.leaseContextOfOwn(repo, 'sess-own342'), { taskId: null, skill: null }, 'null 桶租约不得归因');
    // 本会话具名桶声明：仅本会话可归因
    const ch = issueChallenge(key, { sessionId: 'sess-own342' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-951', skill: 'plan-execution' }).ok, true);
    assert.deepEqual(leaseLib.leaseContextOfOwn(repo, 'sess-own342'), { taskId: '内部任务-951', skill: 'plan-execution' });
    assert.deepEqual(leaseLib.leaseContextOfOwn(repo, 'sess-other'), { taskId: null, skill: null }, '他会话租约不得归因');
    assert.deepEqual(leaseLib.leaseContextOfOwn(repo, ''), { taskId: null, skill: null }, '空 sessionId 不归因');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});


test('内部任务-341 projectSkills：租约字段形状/发号台账/挑战委派字段', () => {
  const env = freshEnv();
  try {
    const key = '/proj/dev341';
    assert.throws(() => normalizeProjectSkills('x'), /数组/);
    assert.throws(() => normalizeProjectSkills([{ name: 'Bad Name' }]), /name/);
    assert.throws(() => normalizeProjectSkills([{ name: 'ok', root: '/abs' }]), /root/);
    assert.throws(() => normalizeProjectSkills([{ name: 'ok', root: '../escape' }]), /root/);
    assert.deepEqual(normalizeProjectSkills(['a', 'a', { name: 'b', root: '.dsh/skills' }]), [
      { name: 'a', root: '' },
      { name: 'b', root: '.dsh/skills' },
    ]);
    const chDel = issueChallenge(key, { sessionId: 'sess-341d', delegationDepth: 1, parentSessionId: 'parent-341', inheritTaskId: '内部任务-9' });
    const owner = challengeOwnerInfo(chDel.leaseId, key);
    assert.equal(owner.delegationDepth, 1);
    assert.equal(owner.parentSessionId, 'parent-341');
    assert.equal(owner.inheritTaskId, '内部任务-9');
    const ch = issueChallenge(key);
    const act = activateLease(key, {
      leaseId: ch.leaseId,
      taskId: '内部任务-9',
      skill: 'plan-execution',
      projectSkills: [{ name: 'project-conventions', root: '项目级技能' }],
    });
    assert.equal(act.ok, true, act.reason);
    const cur = readActiveLease(key);
    assert.equal(cur.valid, true);
    assert.deepEqual(cur.lease.projectSkills, [{ name: 'project-conventions', root: '项目级技能' }]);
    // 非法形状拒激活
    const ch2 = issueChallenge(key);
    const bad = activateLease(key, { leaseId: ch2.leaseId, taskId: '内部任务-10', skill: 'plan-execution', projectSkills: [{ name: 'BAD' }] });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /projectSkills 非法/);
    // 旧租约无字段：新生成租约未传 projectSkills 时不写字段（读侧 undefined 兼容）
    const ch3 = issueChallenge(key);
    assert.equal(activateLease(key, { leaseId: ch3.leaseId, taskId: '内部任务-11', skill: 'tdd' }).ok, true);
    assert.equal(readActiveLease(key).lease.projectSkills, undefined);
  } finally {
    env.restore();
  }
});

// ── 内部任务-348 批 D（内部未决-214① CAS／254⑤ normalize 单源）──

test('内部未决-214① heartbeat CAS：写前 claim 被他会话改写 ⇒ 弃写不覆盖（盘态保持他方、返 false）', () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-cas-hb-'));
  try {
    mkdirSync(join(repo, '.git'));
    const key = projectKey(repo);
    const ch = issueChallenge(key, { sessionId: 'sess-own' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-901', skill: 'tdd', sessionId: 'sess-own' }).ok, true);
    const lease = readActiveLease(key, Date.now(), { sessionId: 'sess-own' });
    assert.equal(lease.valid, true, `前置租约有效：${lease.reason}`);
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const cp = claimPath(stateDir, key, '内部任务-901');
    // 逼近过期（同 内部任务-8 心跳测试形态）：active 与 claim 同步置 < 2/3 TTL 进写路径
    const near = Date.now() + Math.floor(leaseLib.DEFAULT_TTL_MS / 6);
    for (const f of [activePath(stateDir, ch.leaseId), cp]) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      writeFileSync(f, JSON.stringify({ ...raw, expiresAt: near }));
    }
    // 注入缝：写前改写 claim 属主（模拟读侧快照之后、写之前的并发改写）
    process.env.WF_CAS_INJECT_CLAIM_SWAP = '1';
    const wrote = leaseLib.heartbeatLease(lease.lease);
    delete process.env.WF_CAS_INJECT_CLAIM_SWAP;
    assert.equal(wrote, false, 'CAS 弃写（返 false）');
    const claimNow = JSON.parse(readFileSync(cp, 'utf8'));
    assert.equal(claimNow.sessionId, 'sess-other', '他会话的 claim 未被旧快照覆盖（CAS 语义）');
    assert.ok(Number(claimNow.expiresAt) <= near + 1000, '他方 claim 的 expiresAt 未被本会话续期');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部未决-214① quarantine 竞态：过期判定后被并发方刷新 ⇒ 不隔离不覆盖（conflict）', () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-cas-q-'));
  try {
    mkdirSync(join(repo, '.git'));
    const key = projectKey(repo);
    const cp = claimPath(process.env.WF_ROUTING_STATE_DIR, key, '内部任务-902');
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(cp, JSON.stringify({ schemaVersion: 4, projectKey: key, taskId: '内部任务-902', sessionId: 'sess-q', host: 'test', claimedAt: Date.now() - 7200000, expiresAt: Date.now() - 3600000 }));
    // 注入缝：读判后被并发方刷新（未过期）
    process.env.WF_CAS_INJECT_QUARANTINE_REFRESH = '1';
    const r = leaseLib.acquireClaim(key, { taskId: '内部任务-902', sessionId: 'sess-q', host: 'test', declaredAt: Date.now(), expiresAt: Date.now() + 3600000 });
    delete process.env.WF_CAS_INJECT_QUARANTINE_REFRESH;
    assert.equal(r.mode, 'conflict', '刷新后的未过期 claim ⇒ 撞号而非隔离重建');
    const now = JSON.parse(readFileSync(cp, 'utf8'));
    assert.equal(Number(now.expiresAt) > Date.now(), true, '并发方刷新的 claim 原样保留');
    assert.equal(existsSync(join(dirname(cp), 'quarantine')), false, '未进 quarantine（不隔离）');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部未决-214① quarantine 回滚不覆盖：隔离后被续期＋第三方原位重建 ⇒ 回滚放弃留隔离位（三维正确性维发现 1）', () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-cas-qr-'));
  try {
    mkdirSync(join(repo, '.git'));
    const key = projectKey(repo);
    const cp = claimPath(process.env.WF_ROUTING_STATE_DIR, key, '内部任务-903');
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(cp, JSON.stringify({ schemaVersion: 4, projectKey: key, taskId: '内部任务-903', sessionId: 'sess-q', host: 'test', claimedAt: Date.now() - 7200000, expiresAt: Date.now() - 3600000 }));
    // 注入缝（值 2）：隔离 rename 后旧属主续期（命中回滚分支）＋第三方原位新建（回滚不得覆盖）
    process.env.WF_CAS_INJECT_QUARANTINE_REFRESH = '2';
    const r = leaseLib.acquireClaim(key, { taskId: '内部任务-903', sessionId: 'sess-q', host: 'test', declaredAt: Date.now(), expiresAt: Date.now() + 3600000 });
    delete process.env.WF_CAS_INJECT_QUARANTINE_REFRESH;
    assert.equal(r.mode, 'conflict', '隔离位未过期 ⇒ 回滚并按撞号返回');
    const onDisk = JSON.parse(readFileSync(cp, 'utf8'));
    assert.equal(onDisk.sessionId, 'sess-rebuilder', '原位新建方的 claim 不得被回滚 rename 静默覆盖（三维正确性维发现 1）');
    const qDir = join(dirname(cp), 'quarantine');
    assert.equal(existsSync(qDir), true, '回滚放弃 ⇒ 隔离件保留（可人工恢复）');
    const qFiles = readdirSync(qDir);
    assert.ok(qFiles.length >= 1, '隔离位含被续期的隔离件');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部未决-214① revive claim 翻转弃写：写前复核间被翻回 null 桶 ⇒ 不回写旧属主（遥测承载，返回值不变——三维约定维发现 2）', () => {
  const env = freshEnv();
  const repo = mkdtempSync(join(tmpdir(), 'wf-cas-rv-'));
  try {
    mkdirSync(join(repo, '.git'));
    const key = projectKey(repo);
    const ch = issueChallenge(key, { sessionId: 'sess-own' });
    assert.equal(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-904', skill: 'tdd', sessionId: 'sess-own' }).ok, true);
    const stateDir = process.env.WF_ROUTING_STATE_DIR;
    const cp = claimPath(stateDir, key, '内部任务-904');
    const actFile = activePath(stateDir, ch.leaseId);
    // 过期 ≤1TTL 进宽限复活窗（active+claim 同步压过期——ADR-45 四态测试 ② 同款形态）
    const staleTs = Date.now() - Math.floor(leaseLib.DEFAULT_TTL_MS / 2);
    for (const f of [actFile, cp]) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      writeFileSync(f, JSON.stringify({ ...raw, expiresAt: staleTs }));
    }
    // 注入缝（复用 WF_CAS_INJECT_CLAIM_SWAP，revive 消费点）：写前复核读之前 claim 被翻回 null 桶
    process.env.WF_CAS_INJECT_CLAIM_SWAP = '1';
    const r = leaseLib.reviveOrHeartbeat(key, 'sess-own');
    delete process.env.WF_CAS_INJECT_CLAIM_SWAP;
    assert.equal(r.action, 'revived', 'revive 弃写不改返回契约（action 仍 revived——内部模块-8 口径：弃写仅遥测承载）');
    const claimNow = JSON.parse(readFileSync(cp, 'utf8'));
    assert.equal(String(claimNow.sessionId ?? ''), '', 'null 桶并发方的 claim 未被旧属主快照回写（CAS 弃写）');
    const incidents = readFileSync(join(env.home, 'ir', '.workflow', 'incidents.jsonl'), 'utf8');
    assert.ok(incidents.includes('cas-stale-window'), '弃写记 recordLeaseReadAnomaly 遥测（生产面唯一实录信号源）');
  } finally {
    env.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('内部未决-254⑤ normalizeScriptEditCode 文案由 label 构造（不再 replaceAll 派生）', () => {
  assert.throws(() => leaseLib.normalizeScriptEditCode('not-array'), /scriptEditCode 必须是数组/);
  assert.throws(() => leaseLib.normalizeScriptEditCode([42]), /scriptEditCode 条目/);
  assert.throws(() => leaseLib.normalizeScriptEditCode(['短']), /scriptEditCode 理由须 ≥8 字（收到 1 字）/);
  const ok = leaseLib.normalizeScriptEditCode(['这是一个合法理由']);
  assert.equal(ok.length, 1);
  assert.match(String(ok[0].declaredAt), /^\d{4}-/);
  try {
    leaseLib.normalizeScriptWrites('not-array');
    assert.fail('须抛');
  } catch (e) {
    assert.match(String(e.message), /^scriptWrites/);
    assert.equal(String(e.message).includes('scriptEditCode'), false, 'scriptWrites 错误文案不得带 scriptEditCode 字样');
  }
});

// ── 内部任务-352（2026-11-08）：答复通道只读租约提示 answerChannelLeaseHint（内部模块-8 内部规则-8/内部验收-47）──

async function mkDev352LeaseFixture(tag) {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), `wf-lease-dev352-${tag}-`));
  const proj = mkdtempSync(join(tmpdir(), `wf-lease-dev352-${tag}-proj-`));
  mkdirSync(join(proj, '.git'), { recursive: true });
  const stateDir = join(root, 'state');
  const prev = process.env.WF_ROUTING_STATE_DIR;
  process.env.WF_ROUTING_STATE_DIR = stateDir;
  // 内部任务-358（内部任务-331 同源）：剥宿主注入的工作区锚——否则 issuanceKeys 并入仓库键，夹具单键拓扑
  // 被宿主会话穿透成多键形态（answerChannelLeaseHint 会加「仓 」标签，断言失真）。
  const prevAnchor = process.env.ZCODE_PROJECT_DIR;
  delete process.env.ZCODE_PROJECT_DIR;
  return {
    root,
    proj,
    stateDir,
    restore: () => {
      if (prev === undefined) delete process.env.WF_ROUTING_STATE_DIR;
      else process.env.WF_ROUTING_STATE_DIR = prev;
      if (prevAnchor === undefined) delete process.env.ZCODE_PROJECT_DIR;
      else process.env.ZCODE_PROJECT_DIR = prevAnchor;
    },
  };
}

test('answerChannelLeaseHint：未声明+挑战在', async () => {
  const { rmSync } = await import('node:fs');
  const fx = await mkDev352LeaseFixture('undeclared');
  try {
    const key = projectKey(fx.proj);
    const ch = issueChallenge(key, { sessionId: 'S352' });
    const lines = leaseLib.answerChannelLeaseHint({
      cwd: fx.proj, sessionId: 'S352', declarePrefix: 'node routing-declare.mjs', suggest: () => '内部任务-352',
    });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('【workflow 任务租约】'));
    assert.ok(lines[0].includes(ch.leaseId));
    assert.ok(lines[0].includes('--lease'));
    assert.ok(lines[0].includes('内部任务-352'));
    assert.ok(lines[0].includes('答复通道提示：答复不轮换令牌'));
    assert.equal(lines[0].includes('仓 '), false, '单键不带多仓标签');
  } finally {
    fx.restore();
    rmSync(fx.proj, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('answerChannelLeaseHint：已声明', async () => {
  const { rmSync } = await import('node:fs');
  const fx = await mkDev352LeaseFixture('declared');
  try {
    const key = projectKey(fx.proj);
    const ch = issueChallenge(key, { sessionId: 'S352D' });
    assert.ok(activateLease(key, { leaseId: ch.leaseId, taskId: '内部任务-352', skill: 'plan-execution' }).ok);
    const lines = leaseLib.answerChannelLeaseHint({ cwd: fx.proj, sessionId: 'S352D', declarePrefix: 'node x', suggest: () => '内部任务-352' });
    assert.equal(lines.length, 0, '已声明态不提示');
  } finally {
    fx.restore();
    rmSync(fx.proj, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('answerChannelLeaseHint：无挑战', async () => {
  const { rmSync } = await import('node:fs');
  const fx = await mkDev352LeaseFixture('nochallenge');
  try {
    const lines = leaseLib.answerChannelLeaseHint({ cwd: fx.proj, sessionId: 'S352N', declarePrefix: 'node x', suggest: () => '内部任务-352' });
    assert.equal(lines.length, 0, '无挑战令牌不提示');
  } finally {
    fx.restore();
    rmSync(fx.proj, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('answerChannelLeaseHint：委派', async () => {
  const { rmSync } = await import('node:fs');
  const fx = await mkDev352LeaseFixture('delegated');
  try {
    const key = projectKey(fx.proj);
    issueChallenge(key, { sessionId: 'S352G' });
    const lines = leaseLib.answerChannelLeaseHint({ cwd: fx.proj, sessionId: 'S352G', declarePrefix: 'node x', suggest: () => '内部任务-352', delegated: true });
    assert.equal(lines.length, 0, '委派会话零输出（内部决策-061 D4）');
  } finally {
    fx.restore();
    rmSync(fx.proj, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('answerChannelLeaseHint：多键', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fx = await mkDev352LeaseFixture('multikey');
  const ws = mkdtempSync(join(tmpdir(), 'wf-lease-dev352-ws-'));
  const childA = join(ws, 'a');
  const childB = join(ws, 'b');
  const prevAnchor = process.env.ZCODE_PROJECT_DIR;
  try {
    mkdirSync(join(childA, '.git'), { recursive: true });
    mkdirSync(join(childB, '.git'), { recursive: true });
    process.env.ZCODE_PROJECT_DIR = ws;
    const keys = leaseLib.issuanceKeys(ws);
    assert.ok(keys.length >= 2, `夹具前提：锚工作区发现 ≥2 键（实际 ${JSON.stringify(keys)}）`);
    const seeded = keys.map((k) => ({ key: k, leaseId: issueChallenge(k, { sessionId: 'S352M' }).leaseId }));
    const lines = leaseLib.answerChannelLeaseHint({ cwd: ws, sessionId: 'S352M', declarePrefix: 'node x', suggest: (k) => `内部任务-352` });
    assert.equal(lines.length, seeded.length, '每键一行');
    assert.ok(lines.every((l) => l.includes('仓 ')), '多键行带仓标签');
    assert.ok(lines.every((l) => l.includes("--project-root '")), '多键行带 --project-root');
    for (const s of seeded) assert.ok(lines.some((l) => l.includes(s.leaseId)), `键 ${s.key} 的令牌在提示中`);
  } finally {
    if (prevAnchor === undefined) delete process.env.ZCODE_PROJECT_DIR;
    else process.env.ZCODE_PROJECT_DIR = prevAnchor;
    fx.restore();
    rmSync(childA, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(fx.proj, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});