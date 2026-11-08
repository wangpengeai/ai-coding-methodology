// 文件：algo-write.mjs
// 描述：.algo/ 五件写侧操作（内部接口-22 §2：init/ledger-append/baseline-register/badcase-add/badcase-transition）
//       + 写侧统一门禁（内部任务-269 批）——project 门→资产门→业务门门序；init 同父暂存目录 + rename 前显式 `.algo`
//       守卫（失败零残留、不覆盖既有资产）；校验单源复用 algo-state 导出的 explain*；失败一律返回
//       {ok:false,message}（CLI stderr＋退 1，不吐栈）；成功首行 `ok <操作> <id>`（内部接口-22 §3）。
// 并发假定点名：单写者假设 + O_APPEND 行级原子 + 同 id 写侧拒绝三件套，不加锁（YAGNI）。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：init 原子化（暂存+守卫+rename）、读写校验单源、台账健康门/schema 门、
//           toolchain.command 与 version 同权、错误边界统一 {ok:false,message}、CLI 严格参数（cli-args）、
//           readStdinJson 简化 readFileSync(0)。
// 自检：node algo-loop/scripts/algo-write.mjs --selftest
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  BADCASE_STATUSES,
  LEDGER_DECISIONS,
  explainBadcase,
  explainBaselines,
  explainContract,
  explainLedgerRow,
  explainProject,
  isNonEmptyString,
  isPlainObject,
  parseLedgerText,
  readJsonStrict,
} from './algo-state.mjs';
import { isMainModule, parseProjectRootArg, resolveExistingRoot } from './cli-args.mjs';

/** 测试注入缝（scout mode-lifecycle `_testHooks` 先例）：仅测试置值，生产恒 null。 */
export const _testHooks = { beforeRename: null };

const DECISIONS = LEDGER_DECISIONS;
/** bad case id 路径分隔符守卫（单源；两处调用共享，R21）。 */
const BADCASE_PATH_SEP = /[\\/]/;
/** 新登记 bad case 的初始状态（状态表单源，禁第二份字面量）。 */
const DEFAULT_BADCASE_STATUS = BADCASE_STATUSES[0];

function nowIso() {
  return new Date().toISOString();
}

/**
 * 单文件原子写：同目录唯一临时文件 + wx 独占 + fsync + rename（异常清临时再抛，不留半写）。
 * @param {string} path 目标路径
 * @param {string} text 内容
 */
function atomicWriteText(path, text) {
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, 'wx');
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败上抛原错误 */
    }
    throw err;
  }
}

/** O_APPEND 追加 + 同 fd fsync（单写者 + 行级原子 + 同 id 写侧拒绝，不加锁）。 */
function appendLedgerLine(path, row) {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(row) + '\n', null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fail(message) {
  return { ok: false, message };
}

function failWithId(message, id) {
  return { ok: false, message, id };
}

/** project 门：`.algo/project.json` 存在且 §2a 合法（四写操作统一前门，门序第一）。 */
function projectGate(root) {
  const algo = join(root, '.algo');
  const path = join(algo, 'project.json');
  if (!existsSync(path)) return fail('缺 .algo/project.json（未立项或资产损坏——先处置再操作；写侧不自动修）');
  let project;
  try {
    project = readJsonStrict(path);
  } catch {
    return fail('project.json 不可解析——停下报修，不自动修');
  }
  const errors = explainProject(project);
  if (errors.length > 0) return fail(`project.json 损坏（停下报修，不自动修）：${errors.join('；')}`);
  return { ok: true, project };
}

/** contract 资产门：存在、可解析、§2a 合法（返回 {ok, contract} 或 fail）。 */
function contractGate(algo) {
  const path = join(algo, 'contract.json');
  if (!existsSync(path)) return fail('缺 .algo/contract.json（未立项或资产损坏——先处置再登记）');
  let contract;
  try {
    contract = readJsonStrict(path);
  } catch {
    return fail('contract.json 不可解析——停下报修，不自动修');
  }
  const errors = explainContract(contract);
  if (errors.length > 0) return fail(`contract.json 损坏（停下报修，不自动修）：${errors.join('；')}`);
  return { ok: true, contract };
}

/** 台账资产门：存在、可读、无坏行（缺失 → 拒绝且不重建；返回 {ok, rows, ids} 或 fail）。 */
function ledgerGate(algo) {
  const path = join(algo, 'ledger.jsonl');
  if (!existsSync(path)) return fail('缺 .algo/ledger.jsonl（台账缺失——停下报修，不重建；人工恢复后再登记）');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return fail(`ledger.jsonl 不可读（${err && err.code ? err.code : 'unknown'}）——停下报修，不重建`);
  }
  const parsed = parseLedgerText(text);
  if (parsed.badLines > 0) {
    return fail(`台账含 ${parsed.badLines} 条坏行（停下报修，不自动修）：${parsed.badLineDetails.slice(0, 3).join('；')}`);
  }
  return { ok: true, rows: parsed.rows, ids: parsed.ids };
}

function opInit(root, payload) {
  const algo = join(root, '.algo');
  // 既有 .algo 判定：project.json 幂等拒绝；孤儿资产拒绝（不覆盖、不自动修复）；非目录拒绝
  if (existsSync(algo)) {
    let isDir = false;
    try {
      isDir = statSync(algo).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return fail('.algo 已存在但不是目录（停下报修，不覆盖）');
    if (existsSync(join(algo, 'project.json'))) {
      return fail('已存在 .algo/project.json——init 幂等拒绝，不覆盖既有资产（如需重开请先人工处置）');
    }
    const existing = ['badcases', 'contract.json', 'ledger.jsonl', 'baselines.json'].filter((name) => existsSync(join(algo, name)));
    if (existing.length > 0) {
      return fail(`检测到 .algo 既有资产但缺 project.json（${existing.join('、')}）——init 不覆盖既有资产；请人工处置后重试（不自动修复）`);
    }
  }
  if (!payload || !isNonEmptyString(payload.projectId)) return fail('init 缺必填 projectId');
  const templateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  let contract = payload.contract;
  if (contract === undefined) contract = readJsonStrict(join(templateDir, 'contract.template.json'));
  if (!isPlainObject(contract)) return fail('init 契约须为 IF-COLLAB-22 §2a 对象');
  // §2「baselineRef 空/缺省归一 b0」：缺键在结构校验前补空串（§2a 仍要求字符串，存储面不外泄缺键）
  if (contract.baselineRef === undefined) contract = { ...contract, baselineRef: '' };
  const contractErrors = explainContract(contract);
  if (contractErrors.length > 0) return fail(`契约不合 IF-COLLAB-22 §2a：${contractErrors.join('；')}`);
  // baselineRef 归一：立项期允许空串（init 以 B0 回填 "b0"）；非空且非 b0 拒绝
  if (!isNonEmptyString(contract.baselineRef)) contract = { ...contract, baselineRef: 'b0' };
  else if (contract.baselineRef !== 'b0') {
    return fail(`立项期 contract.baselineRef 只能为空或 "b0"（收到 ${JSON.stringify(contract.baselineRef)}；首个实测基线登记后随契约版本递增指向条目 id）`);
  }
  const project = {
    ...readJsonStrict(join(templateDir, 'project.template.json')),
    projectId: payload.projectId,
    contractVersion: contract.version,
  };
  const baselines = {
    schemaVersion: 1,
    entries: [{ id: 'b0', at: nowIso(), metrics: {}, fromIteration: '', reason: 'init' }],
  };
  // 同父暂存目录构造五件 → rename 前显式 `.algo` 守卫 → 单次 rename（失败清理暂存、零残留）
  const staging = mkdtempSync(join(root, '.algo.init-'));
  try {
    // mkdtemp 固定 0700；`.algo/` 应按常规目录权限落位（0777 & ~umask，与直接 mkdir 等价；失败不阻断——权限位非契约面）
    try {
      chmodSync(staging, 0o777 & ~process.umask());
    } catch {
      /* 权限位非契约面：失败保留 0700 默认 */
    }
    mkdirSync(join(staging, 'badcases'));
    writeFileSync(join(staging, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    writeFileSync(join(staging, 'contract.json'), JSON.stringify(contract, null, 2) + '\n');
    writeFileSync(join(staging, 'ledger.jsonl'), '');
    writeFileSync(join(staging, 'baselines.json'), JSON.stringify(baselines, null, 2) + '\n');
    if (typeof _testHooks.beforeRename === 'function') _testHooks.beforeRename({ root, staging, algo });
    // 显式守卫（不依赖 rename errno；POSIX 对已存在空目录的 rename 会成功替换，必须显式拒绝）
    if (existsSync(algo)) return fail('并发 init 竞争，请复核后重试');
    try {
      renameSync(staging, algo);
    } catch (err) {
      return fail(`init 提交失败（${err && err.code ? err.code : 'unknown'}）：若为并发竞争请复核后重试`);
    }
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  return { ok: true, message: '立项完成（B0 已注册）', id: payload.projectId };
}

function opLedgerAppend(root, payload) {
  // 写侧前门（内部接口-22 §2：门序固定）——project 门 → 资产门（contract §2a / 台账健康）→ 业务门
  const project = projectGate(root);
  if (!project.ok) return project;
  const algo = join(root, '.algo');
  const contract = contractGate(algo);
  if (!contract.ok) return contract;
  const ledger = ledgerGate(algo);
  if (!ledger.ok) return ledger;
  // 业务门：载荷六要素/类型 → 契约 toolchain 完备（甲案）→ 同 id 幂等
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('台账行缺六要素之一：payload 须为 JSON 对象');
  const required = ['id', 'hypothesis', 'change', 'singleVariable', 'metricsRef', 'decision'];
  for (const key of required) {
    if (payload[key] === undefined) return fail(`台账行缺六要素之一：${key}`);
  }
  if (!isNonEmptyString(payload.id)) return fail('台账行 id 须为非空字符串');
  if (!isNonEmptyString(payload.metricsRef)) {
    return fail('台账行 metricsRef 须为非空字符串（指标引用——归因纪律根基，R-M18-3 写侧校验）');
  }
  if (!isNonEmptyString(payload.hypothesis) || !isNonEmptyString(payload.change)) {
    return fail('台账行 hypothesis/change 须为非空字符串');
  }
  const sv = payload.singleVariable;
  if (!isPlainObject(sv) || typeof sv.declared !== 'boolean' || typeof sv.note !== 'string') {
    return fail('singleVariable 须为 {declared: boolean, note: string}');
  }
  if (!DECISIONS.includes(payload.decision)) return fail(`decision 须属 ${DECISIONS.join('/')}`);
  // 行 = 原载荷 + 覆盖 at（未知扩展字段原样入账——strict-backward：不静默丢弃消费者附加字段）
  const row = { ...payload, at: nowIso(), singleVariable: { ...sv } };
  const rowErrors = explainLedgerRow(row);
  if (rowErrors.length > 0) return fail(`台账行 schema 校验失败：${rowErrors.join('；')}`);
  for (const m of contract.contract.metrics) {
    const name = m && typeof m.name === 'string' ? m.name : '（未命名指标）';
    const toolchain = m && isPlainObject(m.toolchain) ? m.toolchain : null;
    const cmd = toolchain ? toolchain.command : '';
    const ver = toolchain ? toolchain.version : '';
    if (!isNonEmptyString(cmd) || !isNonEmptyString(ver)) {
      // 甲案校验时点：首轮实测——台账追加前 command 与 version 必须补齐（空串占位与缺键同拒）
      return fail(`测量工具链未声明：指标 ${name} 的 toolchain.command/version 未补齐（立项期允许空占位，首轮台账追加前必须在契约中补齐）`);
    }
  }
  if (ledger.ids.has(payload.id)) return failWithId(`台账已存在同 id 行：${payload.id}（幂等拒绝，追加不改历史）`, payload.id);
  appendLedgerLine(join(algo, 'ledger.jsonl'), row);
  return { ok: true, message: '台账已追加', id: payload.id };
}

function opBaselineRegister(root, payload) {
  // 写侧前门（门序固定）——project 门 → 资产门（baselines §2a / 台账健康）→ 业务门
  const project = projectGate(root);
  if (!project.ok) return project;
  const algo = join(root, '.algo');
  const baselinesPath = join(algo, 'baselines.json');
  if (!existsSync(baselinesPath)) return fail('缺 .algo/baselines.json（未立项或资产损坏）');
  let baselines;
  try {
    baselines = readJsonStrict(baselinesPath);
  } catch {
    return fail('baselines.json 不可解析——停下报修，不自动修');
  }
  const baselineErrors = explainBaselines(baselines);
  if (baselineErrors.length > 0) return fail(`baselines.json 损坏（停下报修，不自动修）：${baselineErrors.join('；')}`);
  const ledger = ledgerGate(algo);
  if (!ledger.ok) return ledger;
  // 业务门：载荷字段/追溯/同 id
  if (!payload || !isNonEmptyString(payload.id)) return fail('基线条目缺 id');
  if (!isPlainObject(payload.metrics)) return fail('基线条目缺 metrics 对象');
  for (const [name, value] of Object.entries(payload.metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`基线条目 metrics 值须为有限数值：${name}`);
  }
  if (!isNonEmptyString(payload.reason)) return fail('基线条目缺 reason（抬高留痕）');
  if (!isNonEmptyString(payload.fromIteration)) {
    return fail('基线条目缺 fromIteration（追溯断链拒绝——IF-COLLAB-22 §4；init 的 B0 由 init 内部注册，不经本操作）');
  }
  if (!ledger.ids.has(payload.fromIteration)) {
    return failWithId(`fromIteration 悬空：台账中不存在 ${payload.fromIteration}（追溯断链拒绝）`, payload.id);
  }
  for (const e of baselines.entries) {
    if (e.id === payload.id) return failWithId(`基线条目同 id 已存在：${payload.id}`, payload.id);
  }
  const entry = { id: payload.id, at: nowIso(), metrics: payload.metrics, fromIteration: payload.fromIteration, reason: payload.reason };
  baselines.entries.push(entry);
  atomicWriteText(baselinesPath, JSON.stringify(baselines, null, 2) + '\n');
  return { ok: true, message: '基线已登记（旧条目永不删改）', id: payload.id };
}

function opBadcaseAdd(root, payload) {
  // 写侧前门（门序固定）——project 门 → 资产门（badcases/ 目录）→ 业务门
  const project = projectGate(root);
  if (!project.ok) return project;
  const algo = join(root, '.algo');
  if (!existsSync(join(algo, 'badcases'))) return fail('缺 .algo/badcases/（未立项或资产损坏——先处置再登记）');
  if (!payload || !isNonEmptyString(payload.id)) return fail('bad case 缺 id');
  if (BADCASE_PATH_SEP.test(payload.id)) return fail('bad case id 不得含路径分隔符（防越出 badcases/ 目录）');
  if (!isNonEmptyString(payload.symptom)) return fail('bad case 缺 symptom');
  if (!isNonEmptyString(payload.env)) return fail('bad case 缺 env（开放枚举，非空即可）');
  if (!Array.isArray(payload.dataRefs)) return fail('bad case 缺 dataRefs 数组');
  for (const ref of payload.dataRefs) {
    if (!isPlainObject(ref) || !isNonEmptyString(ref.kind) || !isNonEmptyString(ref.ref)) {
      return fail('dataRefs 条目须含非空 kind 与 ref（只校验格式，不校验可达性）');
    }
  }
  const casePath = join(algo, 'badcases', `${payload.id}.json`);
  if (existsSync(casePath)) return failWithId(`bad case 同 id 已存在：${payload.id}`, payload.id);
  const body = { id: payload.id, at: nowIso(), symptom: payload.symptom, env: payload.env, dataRefs: payload.dataRefs, status: DEFAULT_BADCASE_STATUS };
  const errors = explainBadcase(body);
  if (errors.length > 0) return fail(`bad case schema 校验失败：${errors.join('；')}`);
  atomicWriteText(casePath, JSON.stringify(body, null, 2) + '\n');
  return { ok: true, message: 'bad case 已登记', id: payload.id };
}

function opBadcaseTransition(root, payload) {
  // 写侧前门（门序固定）——project 门 → 资产门（case 文件）→ 业务门（id/状态机）
  const project = projectGate(root);
  if (!project.ok) return project;
  if (!payload || !isNonEmptyString(payload.id)) return fail('transition 缺 id');
  if (BADCASE_PATH_SEP.test(payload.id)) return fail('bad case id 不得含路径分隔符（防越出 badcases/ 目录）');
  const casePath = join(root, '.algo', 'badcases', `${payload.id}.json`);
  if (!existsSync(casePath)) return failWithId(`bad case 不存在：${payload.id}`, payload.id);
  let body;
  try {
    body = readJsonStrict(casePath);
  } catch {
    return failWithId(`bad case 文件不可解析：${payload.id}——停下报修，不自动修`, payload.id);
  }
  const schemaErrors = explainBadcase(body);
  if (schemaErrors.length > 0) {
    return failWithId(`bad case 文件损坏（停下报修，不自动修）：${schemaErrors.join('；')}`, payload.id);
  }
  if (!BADCASE_STATUSES.includes(payload.status)) return fail(`status 须属 ${BADCASE_STATUSES.join('/')}`);
  // 资产门已保证 body.status 合法（explainBadcase），故状态机只余前向比较
  const from = BADCASE_STATUSES.indexOf(body.status);
  const to = BADCASE_STATUSES.indexOf(payload.status);
  if (to <= from) {
    return failWithId(`状态机仅前向（允许跳级、拒绝回退/原地）：${body.status} → ${payload.status} 被拒绝`, payload.id);
  }
  body.status = payload.status;
  atomicWriteText(casePath, JSON.stringify(body, null, 2) + '\n');
  return { ok: true, message: `状态迁移完成：${body.status}`, id: payload.id };
}

/** 写侧统一入口：applyWrite(root, subcommand, payload) → {ok, message, id}。失败不落任何半写状态。 */
export function applyWrite(root, subcommand, payload) {
  try {
    switch (subcommand) {
      case 'init':
        return opInit(root, payload);
      case 'ledger-append':
        return opLedgerAppend(root, payload);
      case 'baseline-register':
        return opBaselineRegister(root, payload);
      case 'badcase-add':
        return opBadcaseAdd(root, payload);
      case 'badcase-transition':
        return opBadcaseTransition(root, payload);
      default:
        return fail(`未知子命令：${subcommand}（候选：init/ledger-append/baseline-register/badcase-add/badcase-transition）`);
    }
  } catch (err) {
    // 错误边界：I/O 等未预期异常也归一为可见失败（CLI stderr＋退 1），不吐栈、不产半写
    return fail(`写操作失败（${err && err.code ? err.code : (err && err.name) || 'unknown'}）：${err && err.message ? err.message : String(err)}`);
  }
}

/** stdin 一次性读尽后统一解码（readFileSync(0) 等价于原分块循环，但无需手工拼块）。 */
function readStdinJson() {
  const text = readFileSync(0, 'utf8');
  return JSON.parse(text);
}

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'algo-write-selftest-'));
  try {
    const steps = [];
    steps.push(['init', { projectId: 'st', contract: { schemaVersion: 1, version: 1, metrics: [{ name: 'm', definition: 'd', direction: 'higher-better', unit: 'u', toolchain: { command: 'x', version: 'v1' } }], baselineRef: 'b0', targets: {}, guardrails: [] } }]);
    steps.push(['ledger-append', { id: 'i1', hypothesis: 'h', change: 'c', singleVariable: { declared: true, note: '' }, metricsRef: 'r', decision: 'continue' }]);
    steps.push(['badcase-add', { id: 'c1', symptom: 's', env: 'field', dataRefs: [{ kind: 'log', ref: '/l' }] }]);
    steps.push(['badcase-transition', { id: 'c1', status: '已归因' }]);
    steps.push(['baseline-register', { id: 'b1', metrics: { m: 1 }, fromIteration: 'i1', reason: 'st' }]);
    let failures = 0;
    for (const [op, payload] of steps) {
      const r = applyWrite(root, op, payload);
      const okFlag = r.ok === true;
      console.log(`${okFlag ? 'PASS' : 'FAIL'} ${op}：${r.message}`);
      if (!okFlag) failures += 1;
    }
    if (failures > 0) process.exit(1);
    console.log('SELFTEST OK algo-write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SUBCOMMANDS = ['init', 'ledger-append', 'baseline-register', 'badcase-add', 'badcase-transition'];

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--selftest') {
    selftest();
    process.exit(0);
  }
  const sub = process.argv[2];
  if (!SUBCOMMANDS.includes(sub)) {
    console.error(`用法：node algo-write.mjs <${SUBCOMMANDS.join('|')}> [--project-root <目录>]（载荷从 stdin 读 JSON；--selftest 自检）`);
    process.exit(2);
  }
  const parsed = parseProjectRootArg(process.argv.slice(3));
  if (parsed === null || parsed.rest.length > 0) {
    console.error(`用法：node algo-write.mjs <${SUBCOMMANDS.join('|')}> [--project-root <目录>]（未知参数或旗标缺值；--project-root 支持空格与 = 两形态，载荷从 stdin 读 JSON）`);
    process.exit(2);
  }
  const rootRes = resolveExistingRoot(parsed.root);
  if (!rootRes.ok) {
    console.error(`用法错误：${rootRes.reason}（写侧不创建项目根）`);
    process.exit(2);
  }
  let payload;
  try {
    payload = readStdinJson();
  } catch (err) {
    console.error(`stdin 载荷不是合法 JSON：${err && err.message}`);
    process.exit(2);
  }
  const r = applyWrite(rootRes.root, sub, payload);
  if (r.ok) {
    console.log(`ok ${sub} ${r.id ?? ''}`.trimEnd());
  } else {
    console.error(r.message);
    process.exit(1);
  }
}
