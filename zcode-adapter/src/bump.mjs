// 文件：zcode-adapter/src/bump.mjs
// 描述：版本折叠（内部决策-024，S3 步骤 10 自 scripts/release-suite.mjs:303-667 **原样迁移**——
//       前置形态闸/哈希实算/取代链生成/事务写入/失败回滚/后置双自检全部保留；写面纪律不变：
//       六 plugin.manifest.json 的 version 值 + 经物化刷新的六 plugin.json + 内部接口-1 激活登记面 +
//       DSH 版号两文件（package.json 严格闸 + package-lock.json 两处自愈，内部未决-57 路线①，内部任务-44），
//       共十五文件十六处 version，内部决策-036 源切换；六插件面=2026-10-16 内部任务-109/内部决策-047 扩面——research-loop
//       零钩子＝条件十一行表（清单行恒有、hooks 行仅有钩子插件，内部接口-1 形制修订见 内部决策-047 影响节）。
//       适配点两处（均有注记）：①loadManifests 返回 {ok,reason} 形态（S2 迁移面）；
//       ②runBumpCLI 参数面错统一退 2（CLI 契约优先，计划全局约束 2）；执行拒绝/自检失败仍 1。
// 作者：wangp  创建：2026-09-30  版权：MIT（见 workflow/LICENSE）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PLUGINS, HOOKED_PLUGINS, IF_HOST_REL, HOST_TITLE_RE, localDate, hash16, loadManifests, VERSION_RE } from './manifests.mjs';
import { atomicWriteText } from './market.mjs';
// 依赖方向：宿主面（zcode-adapter）→ 核心面（plugin-core）——内部决策-036 期二全部适配层的预定方向，期一由 bump 先行一例
import { renderArtifacts, zcodeColumn } from '../../plugin-core/src/materialize.mjs';
import { validateManifest } from '../../plugin-core/src/validate.mjs';
import { spawnSync } from 'node:child_process';

/** bump 用法串（缺参/非法参时打印）。 */
const BUMP_USAGE =
  '用法：node zcode-adapter/cli.mjs bump [仓库根|--repo-root <路径>] --version <X.Y.Z> --note "<本批内容摘要>" [--dry-run]';

/**
 * bump 参数解析；非法即抛（调用方打 BUMP_USAGE 退 2——CLI 契约，迁自 :310-329）。
 * @param {string[]} rest 子命令后的参数
 * @returns {{repo: string, version: string, note: string, dryRun: boolean}}
 */
export function parseBumpArgs(rest) {
  const opt = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
  const version = opt('--version');
  const note = opt('--note');
  const dryRun = rest.includes('--dry-run');
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`--version 必填且为 X.Y.Z 版本形态（收到「${version ?? ''}」）`);
  }
  if (!note || !String(note).trim()) throw new Error('--note 必填（prose 内容摘要，单行 ≤500 字）');
  const n = String(note).trim();
  if (n.length > 500 || /[\r\n]/.test(n)) throw new Error('--note 须单行且 ≤500 字');
  if (n.includes('；hooks.json ') || n.includes('；取代 ')) {
    throw new Error('--note 不得含结构分隔子串（；hooks.json / ；取代）');
  }
  const l = (n.match(/（/g) || []).length;
  const r = (n.match(/）/g) || []).length;
  if (l !== r) throw new Error('--note 全角括号须平衡（否则破坏取代链解析）');
  const positional = rest.find((a, i) => !a.startsWith('--') && !['--version', '--note'].includes(rest[i - 1]));
  return { repo: resolve(positional ?? '.'), version, note: n, dryRun };
}

/**
 * 内部接口-1 激活登记形态解析；结构不符返回 null（迁自 :336-360）。
 * @param {string} text
 * @returns {object|null}
 */
export function parseHostRegistration(text) {
  const lines = text.split('\n');
  const titleIdx = lines.findIndex((l) => HOST_TITLE_RE.test(l));
  if (titleIdx === -1) return null;
  const title = lines[titleIdx].match(HOST_TITLE_RE);
  const proseIdx = titleIdx + 2; // 标题行后空行 + prose
  const prose = lines[proseIdx] ?? '';
  if (!prose.startsWith('lifecycle 维持 active；契约工件哈希实测登记（') || !prose.endsWith('）：')) return null;
  const tableHeadIdx = lines.findIndex((l, i) => i > proseIdx && l.startsWith('| 工件 | 版本 |'));
  if (tableHeadIdx === -1) return null;
  const rows = [];
  for (let i = tableHeadIdx + 2; i < lines.length; i += 1) {
    const m = lines[i].match(/^\| (.+?) \| (\d+\.\d+\.\d+) \| `([^`]+)` \| sha256:([0-9a-f]{16}) \| `sha256sum ([^`]+)` \|$/);
    if (!m) break;
    if (m[3] !== m[5]) return null;
    rows.push({ idx: i, name: m[1], version: m[2], path: m[3], hash: m[4] });
  }
  if (rows.length !== PLUGINS.length + HOOKED_PLUGINS.length) return null;
  const expected = [
    ...PLUGINS.map((p) => ({ name: p, path: `${p}/.zcode-plugin/plugin.json` })),
    ...HOOKED_PLUGINS.map((p) => ({ name: `${p} hooks 声明`, path: `${p}/hooks/hooks.json` })),
  ];
  if (!expected.every((e, i) => rows[i].name === e.name && rows[i].path === e.path)) return null;
  return { lines, titleIdx, date: title[1], version: title[2], proseIdx, prose, rows };
}

/**
 * 新 prose 生成（确定性取代链，形态对齐 0.3.4 实文件；迁自 :371-388）。
 * @param {string} oldProse
 * @param {{version: string, note: string, prevDate: string, prevVersion: string}} opts
 * @returns {string|null}
 */
export function buildHostProse(oldProse, { version, note, prevDate, prevVersion }) {
  const prefix = 'lifecycle 维持 active；契约工件哈希实测登记（';
  const inner = oldProse.slice(prefix.length, -'）：'.length);
  const head = `${PLUGINS.join('/')} 统一折叠 `;
  if (!inner.startsWith(head)) return null;
  const a = inner.slice(head.length);
  const m = a.match(/^(\d+\.\d+\.\d+)——套件版本即插件版本（ADR-017）；(\d+\.\d+\.\d+) 内容=/);
  if (!m || m[1] !== m[2] || m[1] !== prevVersion) return null;
  const rest = a.slice(m[0].length); // '旧摘要；hooks.json 旧hooks句；取代 <链>'
  if ((rest.match(/；hooks\.json /g) || []).length !== 1 || (rest.match(/；取代 /g) || []).length !== 1) return null;
  const oldNote = rest.split('；hooks.json ')[0];
  const hooksSentence = rest.split('；hooks.json ')[1].split('；取代 ')[0];
  const chain = rest.split('；取代 ')[1];
  if (!/^\d{4}-\d{2}-\d{2} \d+\.\d+\.\d+ 登记（/.test(chain) || !chain.endsWith('）')) return null;
  const embed = `${prevVersion} 内容=${oldNote}；再前取代 ${chain}`;
  return `${prefix}${head}${version}——套件版本即插件版本（ADR-017）；`
    + `${version} 内容=${note}；hooks.json ${hooksSentence}；取代 ${prevDate} ${prevVersion} 登记（${embed}））：`;
}

/**
 * 标题行生成（迁自 :395-397）。
 * @param {{version: string, date: string}} opts
 * @returns {string}
 */
export function buildHostTitle({ version, date }) {
  return `## 激活登记（${date}，六插件统一 ${version} 版本折叠刷新，ADR-017）`;
}

/**
 * 仅替换 version 值字面量（保格式/保 LF；JSON 双校验：name/description/author 逐项相等，version 等于新值；
 * 内部决策-036 源切换后唯一生产调用输入是 plugin.manifest.json 文本——manifest 的额外键 manifestVersion/hooks/surfaces
 * 随原文保留、不在校验枚举内）。迁自 :406-419。
 * @param {string} text
 * @param {string} oldV
 * @param {string} newV
 * @returns {string|null}
 */
export function spliceManifestVersion(text, oldV, newV) {
  if (text.includes('\r')) return null;
  const m = text.match(/^(\s*"version":\s*")([^"]*)(")/m);
  if (!m || m[2] !== oldV) return null;
  const out = text.replace(m[0], `${m[1]}${newV}${m[3]}`);
  try {
    const a = JSON.parse(text);
    const b = JSON.parse(out);
    if (b.version !== newV || a.name !== b.name || a.description !== b.description || a.author !== b.author) return null;
  } catch {
    return null;
  }
  return out;
}

/**
 * 全量前置闸 + 计划生成（先读后算，全程零写；迁自 :426-477，loadManifests 调用点适配 {ok,reason}）。
 * @param {{repo: string, version: string, note: string, date?: string}} opts
 * @returns {{ok: false, reason: string}|{ok: true, changes: Array<{path: string, rel: string, oldText: string, newText: string}>}}
 */
export function planBump({ repo, version, note, date = localDate() }) {
  const loaded = loadManifests(repo);
  if (!loaded.ok) return { ok: false, reason: `六清单版本校验失败（${loaded.reason}）` };
  // 内部决策-036（终审处置）：schema 破损的 manifest 在 renderArtifacts 处会崩 TypeError 且被 CLI
  // 误归参数面错退 2——render 前复用核心面校验，schema 错归执行拒绝退 1
  for (const p of PLUGINS) {
    const v = validateManifest(repo, p);
    if (!v.ok) return { ok: false, reason: `manifest 校验失败（${p}）：${v.errors.join('；')}` };
  }
  const manifests = loaded.manifests;
  const cur = manifests[PLUGINS[0]].version;
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
    return 0;
  };
  if (cmp(version, cur) <= 0) return { ok: false, reason: `目标版本未递增（当前 ${cur}，目标 ${version}）` };
  const hostPath = join(repo, IF_HOST_REL);
  if (!existsSync(hostPath)) return { ok: false, reason: `IF-HOST-1 不存在：${IF_HOST_REL}` };
  let hostText;
  try {
    hostText = readFileSync(hostPath, 'utf8');
  } catch (e) {
    // 评审 correctness-3：存在但不可读（EISDIR/EACCES）此前穿透到 CLI 兜底
    return { ok: false, reason: `IF-HOST-1 不可读：${IF_HOST_REL}（${e.message}）` };
  }
  const reg = parseHostRegistration(hostText);
  if (!reg) return { ok: false, reason: 'IF-HOST-1 激活登记形态不匹配（标题/prose/条件十一行表）——人工检查后重试' };
  if (reg.version !== cur) return { ok: false, reason: `登记版本 ${reg.version} 与清单版本 ${cur} 不一致` };
  for (const row of reg.rows) {
    const abs = join(repo, row.path);
    if (!existsSync(abs)) return { ok: false, reason: `登记路径不存在：${row.path}——先 node plugin-core/cli.mjs materialize` }; // 内部任务-276 D7：补出路指引
    let actual;
    try {
      actual = hash16(readFileSync(abs));
    } catch (e) {
      // 评审 correctness-2：存在但不可读（EACCES/EISDIR）此前在此裸读穿透，后面的 D7 守护不可达
      return { ok: false, reason: `登记路径不可读：${row.path}（${e.message}）——先 node plugin-core/cli.mjs materialize` };
    }
    if (actual !== row.hash) return { ok: false, reason: `登记哈希漂移：${row.path}（登记 ${row.hash}，实测 ${actual}）` };
  }
  const changes = [];
  const newHashes = {};
  for (const p of PLUGINS) {
    // 内部决策-036 源切换（2026-10-01）：改写对象 = plugin.manifest.json（唯一手工编辑面）；
    // 生成物 plugin.json 经 renderArtifacts 以内存中新 manifest 计算（纯函数零磁盘依赖，
    // 保住本函数「先读后算全程零写」性质）；hooks.json 不受版本折叠影响，不重算
    const mRel = `${p}/plugin.manifest.json`;
    const mAbs = join(repo, mRel);
    const mOld = readFileSync(mAbs, 'utf8');
    const mNew = spliceManifestVersion(mOld, cur, version);
    if (mNew === null) return { ok: false, reason: `manifest 形态不匹配：${mRel}` };
    const rendered = renderArtifacts(JSON.parse(mNew), zcodeColumn());
    const pj = rendered.find((a) => a.rel === '.zcode-plugin/plugin.json');
    if (!pj) return { ok: false, reason: `物化未产出 plugin.json：${mRel}（内部错误）` };
    newHashes[p] = hash16(pj.bytes);
    changes.push({ path: mAbs, rel: mRel, oldText: mOld, newText: mNew });
    const pjRel = `${p}/.zcode-plugin/plugin.json`;
    const pjAbs = join(repo, pjRel);
    // 评审 correctness-3：登记行环已先行读过同一文件（存在性＋可读性＋哈希），此处不再重复守卫；
    // 保留直接读以维持「字节与登记哈希同源」的单次读取语义（若两次读之间被替换属 TOCTOU，登记校验已尽）。
    changes.push({ path: pjAbs, rel: pjRel, oldText: readFileSync(pjAbs, 'utf8'), newText: pj.bytes.toString('utf8') });
  }
  const rowsText = reg.rows.map((row) => {
    if (row.name.endsWith(' hooks 声明')) {
      // hooks 行：版本列随折叠更新，哈希列原样（hooks.json 属人工变更面，前置漂移即拒）
      return `| ${row.name} | ${version} | \`${row.path}\` | sha256:${row.hash} | \`sha256sum ${row.path}\` |`;
    }
    const p = row.name;
    return `| ${p} | ${version} | \`${row.path}\` | sha256:${newHashes[p]} | \`sha256sum ${row.path}\` |`;
  });
  const newLines = reg.lines.slice();
  newLines[reg.titleIdx] = buildHostTitle({ version, date });
  const newProse = buildHostProse(reg.prose, { version, note, prevDate: reg.date, prevVersion: reg.version });
  if (newProse === null) return { ok: false, reason: 'prose 取代链形态不匹配' };
  newLines[reg.proseIdx] = newProse;
  reg.rows.forEach((row, i) => { newLines[row.idx] = rowsText[i]; });
  const hostNew = newLines.join('\n');
  if (parseHostRegistration(hostNew) === null) return { ok: false, reason: '生成后 round-trip 解析失败（内部错误，未写入）' };
  changes.push({ path: hostPath, rel: IF_HOST_REL, oldText: reg.lines.join('\n'), newText: hostNew });
  // ── DSH 版号写面（内部未决-57 路线①，内部任务-44）：package.json 严格闸 + package-lock.json 自愈双点 ──
  // 设计：package.json 是 pc-dsh-suite-sync 同面（现值必须=cur，滞后/超前即拒——先核对后重试，
  // 不再落入后置自检回滚）；lock 为无条件自愈面（现值不要求=cur，下次 bump 机械带到目标值——
  // 消除「手工先改 DSH 版号再 bump」的次序死结）。缺失/坏 JSON 一律 {ok:false}，不抛异常穿透。
  const dshRel = 'ai-coding-methodology/package.json';
  const dshPath = join(repo, 'ai-coding-methodology', 'package.json');
  if (!existsSync(dshPath)) return { ok: false, reason: `DSH package.json 缺失：${dshRel}（OPEN-57 写面）` };
  let dshOld;
  try {
    dshOld = readFileSync(dshPath, 'utf8');
    const parsed = JSON.parse(dshOld);
    if (parsed.version !== cur) {
      return { ok: false, reason: `DSH 版号（package.json=${parsed.version}）与套件（${cur}）不一致——先核对后重试` };
    }
  } catch {
    return { ok: false, reason: `DSH package.json 不可解析：${dshRel}` };
  }
  const dshNeedle = `"version": "${cur}"`;
  if (dshOld.split(dshNeedle).length !== 2) return { ok: false, reason: `DSH package.json 版本字面量非唯一命中：${dshRel}` };
  const dshNew = dshOld.replace(dshNeedle, `"version": "${version}"`);
  try {
    const round = JSON.parse(dshNew);
    if (round.version !== version) return { ok: false, reason: `DSH package.json round-trip 失败：${dshRel}` };
  } catch {
    return { ok: false, reason: `DSH package.json 替换后不可解析：${dshRel}` };
  }
  changes.push({ path: dshPath, rel: dshRel, oldText: dshOld, newText: dshNew });
  const lockRel = 'ai-coding-methodology/package-lock.json';
  const lockPath = join(repo, 'ai-coding-methodology', 'package-lock.json');
  if (!existsSync(lockPath)) return { ok: false, reason: `DSH package-lock.json 缺失：${lockRel}（OPEN-57 写面）` };
  let lockOld;
  let lockCur;
  try {
    lockOld = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(lockOld);
    lockCur = parsed.version;
    const inner = parsed.packages && parsed.packages[''] ? parsed.packages[''].version : undefined;
    if (typeof lockCur !== 'string' || typeof inner !== 'string') {
      return { ok: false, reason: `DSH package-lock.json 缺 version 键：${lockRel}` };
    }
    if (lockCur !== inner) {
      return { ok: false, reason: `DSH package-lock.json 两处 version 互异（root=${lockCur} / packages""=${inner}）——人工核对 lock` };
    }
  } catch (exc) {
    if (exc instanceof SyntaxError) return { ok: false, reason: `DSH package-lock.json 不可解析（坏 JSON）：${lockRel}` };
    return { ok: false, reason: `DSH package-lock.json 读取失败：${exc.message}` };
  }
  const lockNeedle = `"version": "${lockCur}"`;
  const lockHits = lockOld.split(lockNeedle).length - 1;
  if (lockHits !== 2) {
    return { ok: false, reason: `DSH package-lock.json 版本字面量命中 ${lockHits} 次（期望恰 2）——人工核对 lock（防依赖版本被误写）` };
  }
  const lockNew = lockOld.split(lockNeedle).join(`"version": "${version}"`);
  try {
    const round = JSON.parse(lockNew);
    if (round.version !== version || round.packages[''].version !== version) {
      return { ok: false, reason: `DSH package-lock.json round-trip 失败：${lockRel}` };
    }
  } catch {
    return { ok: false, reason: `DSH package-lock.json 替换后不可解析：${lockRel}` };
  }
  changes.push({ path: lockPath, rel: lockRel, oldText: lockOld, newText: lockNew });
  return { ok: true, changes };
}

/**
 * 逐文件 temp+rename 写入（同目录原子替换；迁自 :506-510，原子写单源在 market.mjs）。
 * @param {Array<{path: string, newText: string}>} changes
 * @returns {void}
 */
export function applyChanges(changes) {
  for (const c of changes) {
    atomicWriteText(c.path, c.newText, '.bump-tmp');
  }
}

/**
 * 内存快照回滚（精确写回原文；回滚自身失败打人工恢复指引；迁自 :517-523）。
 * @param {Array<{path: string, rel: string, oldText: string}>} changes
 * @returns {void}
 */
export function rollbackChanges(changes) {
  try {
    for (const c of changes) writeFileSync(c.path, c.oldText);
  } catch (exc) {
    process.stdout.write(`[bump] 回滚写入失败：${exc.message}\n人工恢复：git checkout -- ${changes.map((c) => c.rel).join(' ')}\n`);
  }
}

/**
 * 行级 diff（等行数场景，bump 恒等行数；长行不截断；迁自 :532-541）。
 * @param {string} rel
 * @param {string} oldText
 * @param {string} newText
 * @returns {string}
 */
export function printLineDiff(rel, oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length !== b.length) return `[bump] ${rel}：行数变化 ${a.length} → ${b.length}（请人工核对）\n`;
  let out = '';
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) out += `[bump] ${rel}:${i + 1}\n- ${a[i]}\n+ ${b[i]}\n`;
  }
  return out || `[bump] ${rel}：无行级变化\n`;
}

/**
 * 后置双自检（check-repo-consistency + validate_specs），cwd=仓库根。内部决策-051 阶段4 起
 * validate_specs 为 Node 实现，直接以当前 node 执行（不再经解释器发现层）。
 * @param {string} root
 * @returns {{ok: boolean, log: string}}
 */
export function runBumpChecks(root) {
  const log = [];
  const consistency = join(root, 'scripts', 'check-repo-consistency.mjs');
  const validator = join(root, 'spec-gate', 'core', 'validator', 'validate_specs.mjs');
  const suite = join(root, '.sdd', 'suite.json');
  if (!existsSync(consistency) || !existsSync(validator) || !existsSync(suite)) {
    return { ok: false, log: '自检要素缺失（check-repo-consistency / validate_specs / .sdd/suite.json）' };
  }
  let r = spawnSync(process.execPath, [consistency, root], { cwd: root, encoding: 'utf8', timeout: 600_000 });
  // 超时口径：release-suite 每步上限 600s 同款（JS 规范「子进程必带超时」；内部任务-276 D15——此前无
  // timeout 挂死即 bump 整体挂死；超时被杀 status=null≠0 与实时错误同走失败分支，原因行可分辨）
  log.push(`check-repo-consistency ${r.error?.code === 'ETIMEDOUT' ? '超时 600s 被杀' : `退 ${r.status}`}`);
  if (r.status !== 0 || r.error) return { ok: false, log: `${log.join('\n')}\n${r.stdout ?? ''}${r.stderr ?? ''}` };
  r = spawnSync(process.execPath, [validator, '--mode', 'draft', '--config', suite], { cwd: root, encoding: 'utf8', timeout: 600_000 });
  log.push(`validate_specs ${r.error?.code === 'ETIMEDOUT' ? '超时 600s 被杀' : `退 ${r.status}`}`);
  if (r.status !== 0 || r.error) return { ok: false, log: `${log.join('\n')}\n${r.stdout ?? ''}${r.stderr ?? ''}` };
  return { ok: true, log: log.join('\n') };
}

/**
 * bump 执行核心（CLI 与 selftest 驱动共用）：计划 → diff → [dry-run] → 写入（异常即回滚）→ 双自检（失败即回滚）。
 * 迁自 :573-591。
 * @param {{repo: string, version: string, note: string, date?: string, dryRun?: boolean}} opts
 * @param {(() => {ok: boolean, log: string})|null} [checksImpl] 自检实现（缺省 runBumpChecks；selftest 注入桩）
 * @returns {{exit: number, log: string}}
 */
export function executeBump(opts, checksImpl = null) {
  const plan = planBump(opts);
  if (!plan.ok) return { exit: 1, log: `[bump] 拒绝：${plan.reason}\n` };
  const diffText = plan.changes.map((c) => printLineDiff(c.rel, c.oldText, c.newText)).join('');
  if (opts.dryRun) return { exit: 0, log: `${diffText}[bump] dry-run：未写入任何文件\n` };
  try {
    applyChanges(plan.changes);
  } catch (exc) {
    // 写入中途失败（ENOSPC/EACCES/rename 被占用等）：不得停在半改态
    rollbackChanges(plan.changes);
    return { exit: 1, log: `${diffText}[bump] 写入失败，已回滚（人工核对 git status）：${exc.message}\n` };
  }
  const chk = (checksImpl ?? (() => runBumpChecks(opts.repo)))();
  if (!chk.ok) {
    rollbackChanges(plan.changes);
    return { exit: 1, log: `${diffText}[bump] 后置自检失败，已回滚（15 文件）\n${chk.log}\n` };
  }
  return { exit: 0, log: `${diffText}[bump] 完成：${PLUGINS.join('/')} → ${opts.version}；十五文件（十六处 version）已更新并通过自检\n` };
}

/**
 * bump CLI 入口（生产路径：参数校验走 parseBumpArgs，执行走 executeBump；迁自 :598-612，
 * **参数面错统一退 2**——CLI 契约优先，计划全局约束 2；尾行指路本适配层 publish）。
 * @param {string[]} rest 子命令后的参数
 * @returns {number} 退出码
 */
export function runBumpCLI(rest) {
  let opts;
  try {
    opts = parseBumpArgs(rest);
  } catch (exc) {
    process.stderr.write(`[bump] ${exc.message}\n${BUMP_USAGE}\n`); // 内部任务-276 D18：用法错通道固定 stderr（与 CLI 解析层一致）
    return 2;
  }
  const r = executeBump(opts);
  process.stdout.write(r.log);
  if (r.exit === 0) {
    process.stdout.write(`下一步发布：node zcode-adapter/cli.mjs publish --marketplace <市场源目录>\n`);
  }
  return r.exit;
}
