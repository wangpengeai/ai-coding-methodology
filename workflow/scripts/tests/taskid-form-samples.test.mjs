// 文件：taskid-form-samples.test.mjs
// 描述：三套任务号形态正则的冻结样本表哨兵（内部任务-57/内部未决-125）——同一冻结样本集分别过
//       workflow TASK_ID_FORM_RE（直测）、scout TASK_ID_RE（mode-lifecycle 导入面直测）、
//       spec-gate 宽正则（node --input-type=module -e 子进程导入 receipts.mjs 的 TASK_ID_RE——
//       跨插件 import 禁令下走子进程协议，不 import）。
//       形态演进（维护者码扩位/序号上限调整）须三处同步改而无红灯的场景自此有红灯。
// 作者：wangp  创建：2026-10-17  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置（node --input-type=module -e 子进程协议；内部决策-051 阶段3a 起 spec-gate 命令面为 node）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASK_ID_FORM_RE, FLAT_TASK_TOKEN_RE_SRC } from '../../hooks/task-lease-lib.mjs';
import { TASK_ID_RE } from '../../../scout/scripts/mode-lifecycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/**
 * 冻结样本表（单源）：三套正则消费同一数组。expect 三键各为该引擎的期望布尔。
 * 语义口径（内部任务-96 实测锚）：三段形态（维护者段）只在 workflow/scout 受理，spec-gate 宽
 * 正则同样受理（字符级宽）；内部任务-12 重叠变体在 workflow 按域码 TASK 放行（内部未决-76 先例）、
 * scout 并集 TASK_ID_RE 同样放行；前导零/裸 0 在 workflow 拒、宽正则收。
 */
const SAMPLES = [
  { id: 'DEV-36', wf: true, scout: true, sg: true },
  { id: 'TASK-12', wf: true, scout: true, sg: true }, // 内部未决-76 重叠变体：域码 TASK 放行
  { id: 'TASK-RELEASE-54', wf: false, scout: true, sg: true }, // 旧主力形态：wf 拒；scout 并集分支（TASK-[A-Za-z0-9-]+）按设计收旧形态
  { id: 'DEV-WP-96', wf: true, scout: true, sg: true }, // 内部决策-045 三段（维护者段）
  { id: 'DEV-WP-X-1', wf: false, scout: false, sg: true }, // 双维护者段非法
  { id: 'DEV-wp-1', wf: false, scout: false, sg: true }, // 小写维护者码拒
  // 注：值域层（裸 0/前导零拒，内部未决-111）在 taskidRejection 库层不在正则层——正则层
  // \d{1,6} 收 0/前导零，值域拒由既有 taskidRejection 用例承载（内部任务-52/内部未决-111），本表
  // 锚正则层真值：内部任务-0/内部任务-01 三引擎均 true（宽窄一致），不混入值域语义。
  { id: 'DEV-01', wf: true, scout: true, sg: true },
  { id: 'DEV-0', wf: true, scout: true, sg: true },
  { id: 'TASK-999999', wf: true, scout: true, sg: true }, // 序号上限界
  { id: 'IDEA-DSHREFACTOR-1', wf: false, scout: false, sg: true }, // 长域码（12 位）超 [A-Z]{2,4} 段上限：wf/scout 拒、宽收
];

test('OPEN-125 冻结样本表：三套正则对同一集合作出一致裁决（漂移即红）', () => {
  for (const s of SAMPLES) {
    assert.equal(TASK_ID_FORM_RE.test(s.id), s.wf, `workflow TASK_ID_FORM_RE 对 ${s.id} 期望 ${s.wf}`);
    assert.equal(TASK_ID_RE.test(s.id), s.scout, `scout TASK_ID_RE 对 ${s.id} 期望 ${s.scout}`);
  }
});

test('OPEN-125 FLAT 域归属漂移样本（原登记明列项）：DEV-WP-96 经 FLAT_TASK_TOKEN_RE 计 DEV 域带维护者段', () => {
  // 原 内部未决-125 改进方向明文「含上述 FLAT 漂移样本」——三段形态在平铺源扫描的域归属
  // 语义：捕获组 m[2]=域、m[3]=维护者、m[4]=序号（旧版〔无维护者段正则〕计 WP 域 seq96，
  // 新版计 DEV 域 seq96——登记所担心的漂移正是这一捕获结构，冻结之）。
  const re = new RegExp(FLAT_TASK_TOKEN_RE_SRC, 'g');
  const m = [...'DEV-WP-96'.matchAll(re)][0];
  assert.ok(m, 'FLAT token 须命中');
  assert.equal(m[2], 'DEV', '域归属＝DEV（主域段）');
  assert.equal(m[3], 'WP', '维护者段＝WP（捕获组三）');
  assert.equal(m[4], '96', '序号＝96');
});

test('OPEN-125 spec-gate 宽正则（node --input-type=module -e 导入 receipts.mjs 子进程协议）', () => {
  const receiptsUrl = pathToFileURL(join(REPO, 'spec-gate', 'assurance', 'receipts.mjs')).href;
  const prog = [
    `import { TASK_ID_RE } from ${JSON.stringify(receiptsUrl)};`,
    `const payload = ${JSON.stringify(SAMPLES.map((s) => s.id))};`,
    'console.log(JSON.stringify(payload.map((x) => TASK_ID_RE.test(x))));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', prog], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `node 导入面失败：${r.stderr}`);
  const got = JSON.parse(r.stdout.trim());
  SAMPLES.forEach((s, i) => assert.equal(got[i], s.sg, `spec-gate 宽正则对 ${s.id} 期望 ${s.sg}（实得 ${got[i]}）`));
});
